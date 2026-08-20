//! Parser for Gemini CLI telemetry.log files — port of
//! `legacy/trace_viz/parsers/gemini.py`.
//!
//! The format is concatenated JSON objects (not NDJSON) — `split_json_objects`
//! handles the brace-depth parsing required to separate them.

use serde_json::{Map, Value, json};

use crate::models::{ParseResult, ResultInfo, SessionInfo, ToolCall, Turn};
use crate::tiktoken::count_tokens;
use crate::util::{decode_bytes, is_truthy, py_str};

pub fn parse(content: &[u8]) -> ParseResult {
    let Some(text) = decode_bytes(content) else {
        return ParseResult::empty("gemini");
    };

    let mut debug = Map::new();
    debug.insert("text_len".into(), json!(text.chars().count()));
    debug.insert(
        "first_200".into(),
        json!(text.chars().take(200).collect::<String>()),
    );

    let chunks = split_json_objects(&text);
    debug.insert("chunks_found".into(), json!(chunks.len()));

    if let Some(chunk0) = chunks.first() {
        debug.insert(
            "chunk0_preview".into(),
            json!(chunk0.chars().take(300).collect::<String>()),
        );
        debug.insert(
            "chunk0_tail".into(),
            json!(
                chunk0
                    .chars()
                    .rev()
                    .take(100)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            ),
        );
        match serde_json::from_str::<Value>(chunk0) {
            Ok(_) => {
                debug.insert("chunk0_parse".into(), json!("OK"));
            }
            Err(e) => {
                debug.insert("chunk0_parse".into(), json!(format!("FAIL: {e}")));
                // e.column() is 1-based byte-ish position; slice ±50 bytes around it.
                let pos = e.column().saturating_sub(1);
                let start = pos.saturating_sub(50);
                let end = (pos + 50).min(chunk0.len());
                debug.insert("chunk0_error_context".into(), json!(&chunk0[start..end]));
            }
        };
    }

    let mut raw_events: Vec<Value> = Vec::new();
    let mut errors = 0u64;
    for chunk in &chunks {
        match parse_event(chunk) {
            Some(evt) => raw_events.push(evt),
            None => errors += 1,
        }
    }

    debug.insert("rows_ok".into(), json!(raw_events.len()));
    debug.insert("rows_err".into(), json!(errors));

    if raw_events.is_empty() {
        return ParseResult {
            source: "gemini".to_string(),
            parse_errors: errors,
            parse_debug: debug,
            ..Default::default()
        };
    }

    let (turns, tool_calls) = extract_turns_and_tools(&raw_events);
    let result_info = build_result_info(&raw_events);

    let models: Vec<String> = raw_events
        .iter()
        .filter_map(|e| e.get("model").filter(|v| is_truthy(v)).map(py_str))
        .collect();
    let session_info = SessionInfo {
        model: models.first().cloned().unwrap_or_default(),
        ..Default::default()
    };

    ParseResult {
        source: "gemini".to_string(),
        raw_events,
        session_info,
        result_info,
        turns,
        tool_calls,
        parse_errors: errors,
        parse_debug: debug,
        ..Default::default()
    }
}

// ── Event splitting ────────────────────────────────────────────

/// Split a string of concatenated JSON objects by tracking brace depth.
/// Ported 1:1; iterating `chars()` avoids splitting multibyte characters
/// (Python iterates code points too).
fn split_json_objects(text: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut depth: i64 = 0;
    let mut in_str = false;
    let mut escape = false;

    for ch in text.chars() {
        buf.push(ch);
        if escape {
            escape = false;
            continue;
        }
        if ch == '\\' && in_str {
            escape = true;
            continue;
        }
        if ch == '"' {
            in_str = !in_str;
            continue;
        }
        if in_str {
            continue;
        }
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 && !buf.is_empty() {
                chunks.push(buf.trim().to_string());
                buf.clear();
            }
        }
    }

    chunks
}

// ── Single-event parsing ───────────────────────────────────────

fn parse_event(chunk: &str) -> Option<Value> {
    let obj: Value = serde_json::from_str(chunk).ok()?;

    let attrs: Map<String, Value> = obj
        .get("attributes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let name = attrs
        .get("event.name")
        .filter(|v| is_truthy(v))
        .cloned()
        .or_else(|| obj.get("name").filter(|v| is_truthy(v)).cloned())
        .unwrap_or_else(|| json!("billing"));
    let ts = attrs.get("event.timestamp").cloned().unwrap_or(Value::Null);
    // Dict-comprehension style (preserves order — Map::remove is swap-based).
    let clean_attrs: Map<String, Value> = attrs
        .iter()
        .filter(|(k, _)| k != &"event.name" && k != &"event.timestamp")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let (fn_response_tokens, tool_name) = extract_tool_response(&attrs);

    // `or` chains ported with Python truthiness.
    let input_tokens = or_chain(
        &attrs,
        &["input_tokens", "gen_ai.usage.input_tokens", "prompt_tokens"],
    );
    let output_tokens = or_chain(
        &attrs,
        &[
            "output_tokens",
            "gen_ai.usage.output_tokens",
            "completion_tokens",
        ],
    );
    // Python: fn_response_tokens or attrs.get("function_response_tokens") or ...
    let fn_resp_tokens = if is_truthy(fn_response_tokens.as_ref().unwrap_or(&Value::Null)) {
        fn_response_tokens.clone().unwrap_or(Value::Null)
    } else {
        or_chain(
            &attrs,
            &[
                "function_response_tokens",
                "response_tokens",
                "gen_ai.tool.response_tokens",
                "tool_response_tokens",
            ],
        )
    };

    // Build the token-attr dump: all attrs whose key mentions token/response.
    let token_attrs: Map<String, Value> = attrs
        .iter()
        .filter(|(k, _)| {
            let k = k.to_lowercase();
            k.contains("token") || k.contains("response")
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let session_id = attrs.get("session_id").map(py_str).unwrap_or_default();
    let status = attrs
        .get("status")
        .filter(|v| is_truthy(v))
        .cloned()
        .or_else(|| attrs.get("success").filter(|v| is_truthy(v)).cloned())
        .map(|v| py_str(&v))
        .unwrap_or_default();
    // Python: str(attrs.get("file_path") or attrs.get("path", ""))
    let file_path = {
        let fp = attrs.get("file_path").unwrap_or(&Value::Null);
        let p = attrs.get("path").unwrap_or(&Value::Null);
        if is_truthy(fp) { py_str(fp) } else { py_str(p) }
    };

    Some(json!({
        "timestamp": ts,
        "event_name": name,
        "category": categorize(&py_str(&name)),
        "body": py_str(obj.get("_body").unwrap_or(&Value::Null)),
        "model": py_str(attrs.get("model").unwrap_or(&Value::Null)),
        "tool_name": or3(
            py_str(attrs.get("tool_name").unwrap_or(&Value::Null)),
            tool_name.as_deref().filter(|s| !s.is_empty()).map(String::from),
            py_str(attrs.get("gen_ai.tool.name").unwrap_or(&Value::Null)),
        ),
        "function_name": or3(
            py_str(attrs.get("function_name").unwrap_or(&Value::Null)),
            tool_name.as_deref().filter(|s| !s.is_empty()).map(String::from),
            py_str(attrs.get("gen_ai.tool.name").unwrap_or(&Value::Null)),
        ),
        "file_path": file_path,
        "duration_ms": attrs.get("duration_ms").cloned().unwrap_or(Value::Null),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "fn_response_tokens": fn_resp_tokens,
        "_token_attrs": crate::util::py_dumps(&Value::Object(token_attrs)),
        "session_id": session_id,
        "status": status,
        "attrs_json": crate::util::py_dumps(&Value::Object(clean_attrs)),
    }))
}

/// `attrs[k] or fallback` for the token field chains.
fn or_chain(attrs: &Map<String, Value>, keys: &[&str]) -> Value {
    for k in keys {
        let v = attrs.get(*k).cloned().unwrap_or(Value::Null);
        if is_truthy(&v) {
            return v;
        }
    }
    Value::Null
}

/// Python `a or b or c` over strings.
fn or3(a: String, b: Option<String>, c: String) -> String {
    if !a.is_empty() {
        a
    } else if let Some(b) = b {
        if !b.is_empty() { b } else { c }
    } else {
        c
    }
}

/// Python `attrs.get(x) or attrs.get(y)`.
fn or_value_py(a: &Value, b: &Value) -> Value {
    if is_truthy(a) { a.clone() } else { b.clone() }
}

/// Extract fn_response_tokens and tool_name from gen_ai.output.messages if
/// present — port of `_extract_tool_response`.
fn extract_tool_response(attrs: &Map<String, Value>) -> (Option<Value>, Option<String>) {
    let Some(raw) = attrs.get("gen_ai.output.messages").and_then(Value::as_str) else {
        return (None, None);
    };
    let Ok(messages) = serde_json::from_str::<Value>(raw) else {
        return (None, None);
    };

    match &messages {
        Value::Object(m) => {
            let tool_name = m.get("tool").and_then(|t| t.get("name")).map(py_str);
            let response_obj = m
                .get("response")
                .filter(|v| is_truthy(v))
                .cloned()
                .unwrap_or(Value::Null);
            let tokens = match (&response_obj, response_obj.get("contentLength")) {
                (_, Some(cl)) if is_truthy(cl) => Some(cl.clone()),
                (Value::Object(ro), _) => ro
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|s| json!(s.chars().count())),
                _ => None,
            };
            (tokens, tool_name)
        }
        Value::Array(items) if !items.is_empty() => {
            let first = &items[0];
            let resp = first
                .get("response")
                .filter(|v| is_truthy(v))
                .cloned()
                .unwrap_or(Value::Null);
            let fn_resp = resp
                .get("functionResponse")
                .filter(|v| is_truthy(v))
                .cloned()
                .unwrap_or(Value::Null);
            let tokens = fn_resp
                .get("response")
                .and_then(|r| r.get("contentLength"))
                .filter(|v| is_truthy(v))
                .cloned()
                .or_else(|| resp.get("contentLength").filter(|v| is_truthy(v)).cloned());
            let name = fn_resp.get("name").map(py_str);
            (tokens, name)
        }
        _ => (None, None),
    }
}

/// Port of `_categorize` — the exact branch order matters.
fn categorize(name: &str) -> String {
    if name.is_empty() {
        return "其他".to_string();
    }
    if name == "gemini_cli.tool_call" || name == "gemini_cli.tool_use" {
        return "工具调用".to_string();
    }
    if name == "tool_call" || name.contains("tool_call") || name.contains("tool_use") {
        return "工具响应".to_string();
    }
    if name.contains("file_operation") {
        return "文件操作".to_string();
    }
    if name.contains("agent_run") {
        return "Agent".to_string();
    }
    if name.starts_with("gen_ai") {
        return "API 调用".to_string();
    }
    if name.contains("config") {
        return "会话-配置".to_string();
    }
    if name.contains("prompt") {
        return "会话-Prompt".to_string();
    }
    if name.contains("session") {
        return "会话-Session".to_string();
    }
    if name.contains("turn") {
        return "对话轮次".to_string();
    }
    if name.contains("message") {
        return "消息".to_string();
    }
    if name.contains("response") {
        return "响应".to_string();
    }
    if name.contains("error") || name.contains("exception") {
        return "错误".to_string();
    }
    if name.contains("metric") || name.contains("billing") || name == "billing" {
        return "计量".to_string();
    }
    if name.contains("model") {
        return "模型".to_string();
    }
    if name.contains("memory") || name.contains("cache") {
        return "缓存".to_string();
    }
    "其他".to_string()
}

// ── Turn & tool extraction ─────────────────────────────────────

fn extract_turns_and_tools(raw_events: &[Value]) -> (Vec<Turn>, Vec<ToolCall>) {
    let df_calls: Vec<&Value> = raw_events
        .iter()
        .filter(|e| e.get("category").and_then(Value::as_str) == Some("工具调用"))
        .collect();
    let df_resps: Vec<&Value> = raw_events
        .iter()
        .filter(|e| e.get("category").and_then(Value::as_str) == Some("工具响应"))
        .collect();

    // Pair tool calls with responses by position.
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for (idx, tc) in df_calls.iter().enumerate() {
        let resp = df_resps.get(idx).copied();
        // Python: `tc.get("fn_response_tokens") or resp.get("fn_response_tokens")`
        let tc_resp_tokens = tc.get("fn_response_tokens").unwrap_or(&Value::Null);
        let resp_tokens_raw = match resp {
            Some(r) => or_value_py(
                tc_resp_tokens,
                r.get("fn_response_tokens").unwrap_or(&Value::Null),
            ),
            None => tc_resp_tokens.clone(),
        };
        let resp_tokens = safe_int(&resp_tokens_raw);

        // Python: `resp.get("body") or resp.get("attrs_json") or ""`
        let output = match resp {
            Some(r) => {
                let body = r.get("body").unwrap_or(&Value::Null);
                let attrs_json = r.get("attrs_json").unwrap_or(&Value::Null);
                if is_truthy(body) {
                    py_str(body)
                } else {
                    py_str(attrs_json)
                }
            }
            None => String::new(),
        };

        // Python: `str(tc.get("function_name") or tc.get("tool_name") or "")`
        let name = or_value_py(
            tc.get("function_name").unwrap_or(&Value::Null),
            tc.get("tool_name").unwrap_or(&Value::Null),
        );

        // Python: `str(tc.get("status", "")).lower() in ("false", "error")`
        let status = py_str(tc.get("status").unwrap_or(&Value::Null)).to_lowercase();
        let is_error = status == "false" || status == "error";

        let tokens = if resp_tokens > 0 {
            resp_tokens
        } else {
            count_tokens(&output) as u64
        };

        tool_calls.push(ToolCall {
            name: py_str(&name),
            input: json!({}),
            output: output.clone(),
            is_error,
            turn_no: idx as u64,
            call_idx: idx as u64,
            tiktoken_tokens: tokens,
            output_chars: output.chars().count() as u64,
            duration_ms: safe_float(tc.get("duration_ms").unwrap_or(&Value::Null)),
            file_path: py_str(&or_value_py(
                tc.get("file_path").unwrap_or(&Value::Null),
                &Value::Null,
            )),
            allotted_tokens: resp_tokens,
        });
    }

    // API calls → turns
    let api_events: Vec<&Value> = raw_events
        .iter()
        .filter(|e| e.get("category").and_then(Value::as_str) == Some("API 调用"))
        .collect();
    let turns: Vec<Turn> = api_events
        .iter()
        .enumerate()
        .map(|(idx, e)| Turn {
            turn_no: (idx + 1) as u64,
            input_tokens: safe_int(e.get("input_tokens").unwrap_or(&Value::Null)),
            output_tokens: safe_int(e.get("output_tokens").unwrap_or(&Value::Null)),
            ..Default::default()
        })
        .collect();

    (turns, tool_calls)
}

fn build_result_info(raw_events: &[Value]) -> ResultInfo {
    let mut info = ResultInfo::default();
    let api: Vec<&Value> = raw_events
        .iter()
        .filter(|e| e.get("category").and_then(Value::as_str) == Some("API 调用"))
        .collect();
    if !api.is_empty() {
        info.total_input = api
            .iter()
            .map(|e| safe_int(e.get("input_tokens").unwrap_or(&Value::Null)))
            .sum();
        info.total_output = api
            .iter()
            .map(|e| safe_int(e.get("output_tokens").unwrap_or(&Value::Null)))
            .sum();
    }

    // pandas to_datetime(utc=True, errors="coerce") ≈ rfc3339/naive parsing
    // treated as UTC; keep min/max epoch-ms.
    let mut epoch_ms: Vec<f64> = Vec::new();
    for e in raw_events {
        if let Some(ts) = e.get("timestamp").and_then(Value::as_str)
            && let Some(ms) = crate::util::parse_iso_epoch_ms(ts)
        {
            epoch_ms.push(ms);
        }
    }

    if epoch_ms.len() >= 2 {
        let min = epoch_ms.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = epoch_ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        info.duration_ms = (max - min) as i64;
    }

    info
}

/// Port of `_safe_int` — int(float(v)), 0 on failure.
fn safe_int(v: &Value) -> u64 {
    match v {
        Value::Number(n) => n.as_f64().map(|f| f as i64).unwrap_or(0).max(0) as u64,
        Value::String(s) => s.parse::<f64>().map(|f| f as i64).unwrap_or(0).max(0) as u64,
        Value::Bool(b) => u64::from(*b),
        _ => 0,
    }
}

/// Port of `_safe_float` — float(v), 0.0 on failure.
fn safe_float(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        Value::Bool(b) if *b => 1.0,
        _ => 0.0,
    }
}
