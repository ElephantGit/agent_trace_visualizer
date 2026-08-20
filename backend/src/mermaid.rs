//! Mermaid source builders — ports of the `_build_mermaid*` family in
//! `legacy/trace_viz/views/{opencode,claude_code,gemini,workflow}.py`.
//! All builders are deterministic string functions over raw events.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::models::{ParseResult, WorkflowNode};
use crate::util::{is_truthy, mermaid_quote, py_str, sanitize_mermaid, to_str};

/// HTML-escape for labels embedded in Mermaid node labels (`<br/>`-joined).
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
    out
}

/// `text[:60]` Python slice by code points.
fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ══════════════════════════════════════════════════════════════
// Opencode
// ══════════════════════════════════════════════════════════════

/// Port of `_build_sequence_units`: merge tool.start/tool.finish into atomic
/// units before sampling so +T/-T activation pairs always survive together.
pub fn opencode_sequence_units(raw_events: &[Value]) -> Vec<Value> {
    let mut units: Vec<Value> = Vec::new();
    let mut pending: HashMap<String, Value> = HashMap::new();
    const KEY_TYPES: [&str; 6] = [
        "text.user",
        "text.assistant",
        "step.start",
        "step.finish",
        "session.start",
        "session.end",
    ];
    for evt in raw_events {
        let etype = evt.get("type").and_then(Value::as_str).unwrap_or("");
        if etype == "tool.start" {
            pending.insert(
                evt.get("toolCallId").map(py_str).unwrap_or_default(),
                evt.clone(),
            );
        } else if etype == "tool.finish" {
            let start = pending
                .remove(&evt.get("toolCallId").map(py_str).unwrap_or_default())
                .unwrap_or(Value::Null);
            units.push(json!({"kind": "tool_pair", "start": start, "finish": evt}));
        } else if KEY_TYPES.contains(&etype) {
            units.push(json!({"kind": "single", "event": evt}));
        }
    }
    units
}

/// Port of opencode `_build_mermaid(units)`.
pub fn opencode_build_mermaid(units: &[Value]) -> String {
    let mut lines = vec![
        "sequenceDiagram".to_string(),
        "    autonumber".to_string(),
        "    participant U as User".to_string(),
        "    participant A as Agent".to_string(),
        "    participant T as Tool".to_string(),
    ];
    for unit in units {
        if unit["kind"] == "tool_pair" {
            let start = &unit["start"];
            let finish = &unit["finish"];
            let tool_name = if !start.is_null() {
                start
                    .get("tool")
                    .map(py_str)
                    .unwrap_or_else(|| "tool".into())
            } else {
                finish
                    .get("tool")
                    .map(py_str)
                    .unwrap_or_else(|| "tool".into())
            };
            lines.push(format!("    A->>+T: {}", mermaid_quote(&tool_name)));
            let err = if finish
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                " [ERROR]"
            } else {
                ""
            };
            let size = finish
                .get("outputSize")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            lines.push(format!(
                "    T-->>-A: {}",
                mermaid_quote(&format!("done size={size}{err}"))
            ));
            continue;
        }

        let evt = &unit["event"];
        let etype = evt.get("type").and_then(Value::as_str).unwrap_or("");
        match etype {
            "text.user" => {
                lines.push(format!(
                    "    U->>+U: {}",
                    mermaid_quote(&take_chars(
                        &evt.get("text").map(py_str).unwrap_or_default(),
                        60
                    ))
                ));
                lines.push("    U-->>-U: done".to_string());
            }
            "text.assistant" => {
                lines.push(format!(
                    "    A->>+A: {}",
                    mermaid_quote(&take_chars(
                        &evt.get("text").map(py_str).unwrap_or_default(),
                        60
                    ))
                ));
                lines.push("    A-->>-A: done".to_string());
            }
            "step.start" => {
                lines.push(format!(
                    "    Note over A: Step {} start",
                    evt.get("globalStep")
                        .map(py_str)
                        .unwrap_or_else(|| "?".into())
                ));
            }
            "step.finish" => {
                let reason = evt.get("reason").map(py_str).unwrap_or_default();
                let mut label = format!(
                    "Step {} end",
                    evt.get("globalStep")
                        .map(py_str)
                        .unwrap_or_else(|| "?".into())
                );
                if !reason.is_empty() {
                    label = format!("{label} ({reason})");
                }
                lines.push(format!("    Note over A: {label}"));
            }
            "session.start" => lines.push("    Note over U,T: session start".to_string()),
            "session.end" => lines.push("    Note over U,T: session end".to_string()),
            _ => {}
        }
    }
    lines.join("\n")
}

// ══════════════════════════════════════════════════════════════
// Claude Code
// ══════════════════════════════════════════════════════════════

fn iter_content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Object(_) => item.clone(),
                Value::String(s) => json!({"type": "text", "text": s}),
                _ => Value::Null,
            })
            .filter(|v| !v.is_null())
            .collect(),
        _ => Vec::new(),
    }
}

/// Port of claude `_build_mermaid_units`.
pub fn claude_mermaid_units(events: &[Value]) -> Vec<Value> {
    // 第一步：建立 tool_use_id → tool_use block 的索引
    let mut tool_use_map: HashMap<String, (Value, Value)> = HashMap::new();
    for evt in events {
        if evt.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let content = evt
            .get("message")
            .and_then(|m| m.get("content"))
            .cloned()
            .unwrap_or(Value::Null);
        for block in iter_content_blocks(&content) {
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                let tid = block.get("id").map(py_str).unwrap_or_default();
                if !tid.is_empty() {
                    tool_use_map.insert(tid, (evt.clone(), block));
                }
            }
        }
    }

    // 第二步：扫描所有事件，构建 unit 列表
    let mut units: Vec<Value> = Vec::new();
    let mut matched_ids: std::collections::HashSet<String> = Default::default();

    for evt in events {
        let etype = evt.get("type").and_then(Value::as_str).unwrap_or("");

        if etype == "system" {
            units.push(json!({"kind": "system", "event": evt}));
            continue;
        }
        if etype == "result" {
            units.push(json!({"kind": "result", "event": evt}));
            continue;
        }

        if etype == "assistant" {
            // 跳过纯 tool_use 的 assistant（它们会和 tool_result 合并）
            // 只保留有 text 且没有 tool_use 的 assistant
            let content = evt
                .get("message")
                .and_then(|m| m.get("content"))
                .cloned()
                .unwrap_or(Value::Null);
            let blocks = iter_content_blocks(&content);
            let text_blocks: Vec<&Value> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .collect();
            let tool_blocks: Vec<&Value> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .collect();
            if !text_blocks.is_empty() && tool_blocks.is_empty() {
                units.push(json!({"kind": "assistant_text", "event": evt}));
            }
            continue;
        }

        if etype == "user" {
            let content = evt
                .get("message")
                .and_then(|m| m.get("content"))
                .cloned()
                .unwrap_or(Value::Null);
            let blocks = iter_content_blocks(&content);
            let tool_results: Vec<&Value> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                .collect();
            let text_blocks: Vec<&Value> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .collect();

            for tr in &tool_results {
                let tid = tr
                    .get("tool_use_id")
                    .filter(|v| is_truthy(v))
                    .or_else(|| tr.get("toolUseId"))
                    .map(py_str)
                    .unwrap_or_default();
                if let Some((tu_evt, tu_block)) = tool_use_map.get(&tid) {
                    matched_ids.insert(tid);
                    units.push(json!({
                        "kind": "tool_pair",
                        "tool_use": {"evt": tu_evt, "block": tu_block},
                        "tool_result": tr,
                        "user_event": evt,
                    }));
                } else {
                    units.push(json!({
                        "kind": "tool_result_orphan",
                        "tool_result": tr,
                        "user_event": evt,
                    }));
                }
            }

            if !text_blocks.is_empty() && tool_results.is_empty() {
                units.push(json!({"kind": "user_text", "event": evt}));
            }
            continue;
        }

        // 其他事件类型：顶层 tool_result
        if etype == "tool_result" {
            let tid = evt
                .get("tool_use_id")
                .filter(|v| is_truthy(v))
                .or_else(|| evt.get("toolUseId"))
                .map(py_str)
                .unwrap_or_default();
            if let Some((tu_evt, tu_block)) = tool_use_map.get(&tid) {
                matched_ids.insert(tid);
                units.push(json!({
                    "kind": "tool_pair",
                    "tool_use": {"evt": tu_evt, "block": tu_block},
                    "tool_result": evt,
                    "user_event": Value::Null,
                }));
            }
        }
    }

    // 第三步：未匹配的 tool_use（没有 tool_result）作为独立 unit
    for (tid, (tu_evt, tu_block)) in tool_use_map {
        if !matched_ids.contains(&tid) {
            units.push(json!({
                "kind": "tool_use_orphan",
                "tool_use": {"evt": tu_evt, "block": tu_block},
            }));
        }
    }

    units
}

/// Port of `_fmt_ts`: "%H:%M:%S" of the event timestamp for transcripts.
fn fmt_ts(evt: &Value, is_transcript: bool) -> String {
    if !is_transcript {
        return String::new();
    }
    let Some(ts_raw) = evt
        .get("timestamp")
        .filter(|v| is_truthy(v))
        .and_then(Value::as_str)
    else {
        return String::new();
    };
    let normalized = ts_raw.replace('Z', "+00:00");
    let parsed = chrono::DateTime::parse_from_rfc3339(&normalized)
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|n| n.and_utc().fixed_offset())
        })
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S%.f")
                .map(|n| n.and_utc().fixed_offset())
        });
    match parsed {
        Ok(dt) => format!(" {}", dt.format("%H:%M:%S")),
        Err(_) => String::new(),
    }
}

/// Port of claude `_build_mermaid_from_units`.
pub fn claude_build_mermaid(units: &[Value], is_transcript: bool) -> String {
    let mut lines = vec![
        "sequenceDiagram".to_string(),
        "    autonumber".to_string(),
        "    participant U as User".to_string(),
        "    participant A as Claude".to_string(),
        "    participant T as Tool".to_string(),
    ];

    for unit in units {
        let kind = unit.get("kind").and_then(Value::as_str).unwrap_or("");
        match kind {
            "system" => {
                let evt = &unit["event"];
                let model = evt
                    .get("model")
                    .map(py_str)
                    .unwrap_or_else(|| "Claude".into());
                lines.push(format!(
                    "    Note over U,T: 会话初始化 model={}",
                    sanitize_mermaid(&model, 28)
                ));
            }
            "assistant_text" => {
                let evt = &unit["event"];
                let msg = evt.get("message").cloned().unwrap_or(Value::Null);
                let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
                let in_t = usage.get("input_tokens").map(py_str).unwrap_or_default();
                let out_t = usage.get("output_tokens").map(py_str).unwrap_or_default();
                let tok_s = if !in_t.is_empty() {
                    format!("in={in_t} out={out_t}")
                } else {
                    String::new()
                };
                let ts = fmt_ts(evt, is_transcript);
                lines.push(format!(
                    "    Note over A: {}",
                    mermaid_quote(&format!("LLM推理 {tok_s}{ts}"))
                ));
                let content = msg.get("content").cloned().unwrap_or(Value::Null);
                for block in iter_content_blocks(&content) {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        let txt = sanitize_mermaid(
                            &block.get("text").map(py_str).unwrap_or_default(),
                            60,
                        );
                        if !txt.is_empty() {
                            lines.push(format!("    A->>U: {}", mermaid_quote(&txt)));
                        }
                    }
                }
            }
            "tool_pair" => {
                let tu = &unit["tool_use"];
                let tr = &unit["tool_result"];
                let user_evt = &unit["user_event"];
                let block = &tu["block"];
                let name = sanitize_mermaid(
                    &block
                        .get("name")
                        .map(py_str)
                        .unwrap_or_else(|| "tool".into()),
                    25,
                );
                let inp = block.get("input").cloned().unwrap_or(Value::Null);
                let hint = match &inp {
                    Value::Object(o) => {
                        let first = o.values().next().cloned().unwrap_or(Value::Null);
                        sanitize_mermaid(&to_str(&first), 32)
                    }
                    _ => String::new(),
                };
                let label = if hint.is_empty() {
                    name
                } else {
                    format!("{name}({hint})")
                };
                lines.push(format!("    A->>+T: {}", mermaid_quote(&label)));

                let content_str =
                    join_result_content(&tr.get("content").cloned().unwrap_or(Value::Null));
                let err = if tr.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                    " [ERROR]"
                } else {
                    ""
                };
                let ts = fmt_ts(user_evt, is_transcript);
                let text = if content_str.is_empty() {
                    "done".to_string()
                } else {
                    content_str
                };
                lines.push(format!(
                    "    T-->>-A: {}",
                    mermaid_quote(&format!("{}{err}{ts}", sanitize_mermaid(&text, 50)))
                ));
            }
            "tool_use_orphan" => {
                let tu = &unit["tool_use"];
                let block = &tu["block"];
                let name = sanitize_mermaid(
                    &block
                        .get("name")
                        .map(py_str)
                        .unwrap_or_else(|| "tool".into()),
                    25,
                );
                lines.push(format!(
                    "    Note over A: {}",
                    mermaid_quote(&format!("调用 {name}（无结果）"))
                ));
            }
            "tool_result_orphan" => {
                let tr = &unit["tool_result"];
                let raw = tr.get("content").cloned().unwrap_or(Value::Null);
                let raw_str = match &raw {
                    Value::Array(items) => items
                        .iter()
                        .map(|c| match c {
                            Value::Object(o) => o
                                .get("text")
                                .map(py_str)
                                .unwrap_or_else(|| serde_json::to_string(c).unwrap_or_default()),
                            other => py_str(other),
                        })
                        .collect::<Vec<_>>()
                        .join(" "),
                    _ => to_str(&raw),
                };
                let label = sanitize_mermaid(
                    &(if raw_str.is_empty() {
                        "done".to_string()
                    } else {
                        raw_str
                    }),
                    50,
                );
                lines.push(format!("    Note over T: {}", mermaid_quote(&label)));
            }
            "user_text" => {
                let evt = &unit["event"];
                let ts = fmt_ts(evt, is_transcript);
                let content = evt
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .cloned()
                    .unwrap_or(Value::Null);
                for block in iter_content_blocks(&content) {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        let txt = sanitize_mermaid(
                            &block.get("text").map(py_str).unwrap_or_default(),
                            60,
                        );
                        if !txt.is_empty() {
                            lines.push(format!(
                                "    U->>A: {}",
                                mermaid_quote(&format!("{txt}{ts}"))
                            ));
                        }
                    }
                }
            }
            "result" => {
                let evt = &unit["event"];
                let mut parts = vec!["任务完成".to_string()];
                let n_t = evt.get("num_turns").map(py_str).unwrap_or_default();
                let dur = evt.get("duration_ms").and_then(Value::as_u64).unwrap_or(0);
                let cost = evt
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                if !n_t.is_empty() {
                    parts.push(format!("共{n_t}轮"));
                }
                if dur > 0 {
                    parts.push(format!("耗时{}s", dur / 1000));
                }
                if cost > 0.0 {
                    parts.push(format!("${cost:.4}"));
                }
                lines.push(format!("    A->>U: {}", mermaid_quote(&parts.join(" "))));
            }
            _ => {}
        }
    }

    lines.join("\n")
}

fn join_result_content(raw: &Value) -> String {
    match raw {
        Value::Array(items) => items
            .iter()
            .map(|c| match c {
                Value::Object(o) => o
                    .get("text")
                    .map(py_str)
                    .unwrap_or_else(|| serde_json::to_string(c).unwrap_or_default()),
                other => py_str(other),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => to_str(raw),
    }
}

// ══════════════════════════════════════════════════════════════
// Gemini
// ══════════════════════════════════════════════════════════════

fn gemini_etype(name: &str) -> Option<&'static str> {
    if name.contains("prompt") {
        return Some("prompt");
    }
    if name.contains("agent_run_start") {
        return Some("agent_start");
    }
    if name.contains("agent_run_end") {
        return Some("agent_end");
    }
    if name.contains("tool_call") {
        return Some("tool_call");
    }
    if name.contains("file_operation") {
        return Some("file_op");
    }
    if name.starts_with("gen_ai") {
        return Some("api_call");
    }
    None
}

/// Port of gemini `_extract_sequence_steps`: rows are the normalized
/// gemini raw_events (with attrs_json strings).
pub fn gemini_sequence_steps(raw_events: &[Value]) -> Vec<Value> {
    let mut steps = Vec::new();
    for row in raw_events {
        let name = row.get("event_name").map(py_str).unwrap_or_default();
        let Some(et) = gemini_etype(&name) else {
            continue;
        };
        let attrs: Map<String, Value> = row
            .get("attrs_json")
            .and_then(Value::as_str)
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let ts = row
            .get("timestamp")
            .and_then(Value::as_str)
            .map(|t| {
                let normalized = t.replace('Z', "+00:00");
                chrono::DateTime::parse_from_rfc3339(&normalized)
                    .map(|dt| dt.format("%H:%M:%S").to_string())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        steps.push(json!({"etype": et, "ts": ts, "attrs": attrs, "row": row}));
    }
    steps
}

/// Port of gemini `_build_mermaid(steps)` + `_short_path`.
pub fn gemini_build_mermaid(steps: &[Value]) -> String {
    fn short_path(p: &str, n: usize) -> String {
        let p = sanitize_mermaid(p, 255);
        if p.chars().count() > n {
            format!(
                "…{}",
                p.chars()
                    .rev()
                    .take(n)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            )
        } else {
            p
        }
    }

    let mut lines = vec![
        "sequenceDiagram".to_string(),
        "    autonumber".to_string(),
        "    participant U as User".to_string(),
        "    participant A as Agent".to_string(),
        "    participant L as LLM API".to_string(),
        "    participant T as Tool".to_string(),
        "    participant F as FileSystem".to_string(),
    ];

    for step in steps {
        let et = step.get("etype").and_then(Value::as_str).unwrap_or("");
        let attrs = &step["attrs"];
        let row = &step["row"];

        match et {
            "prompt" => {
                let pl = attrs.get("prompt_length").map(py_str).unwrap_or_default();
                let label = if !pl.is_empty() {
                    format!("提交任务 长度={pl}chars")
                } else {
                    "提交任务".to_string()
                };
                lines.push(format!("    U->>A: {}", mermaid_quote(&label)));
            }
            "agent_start" => {
                let turn = attrs
                    .get("turn")
                    .filter(|v| is_truthy(v))
                    .map(py_str)
                    .or_else(|| {
                        attrs
                            .get("turn_number")
                            .filter(|v| is_truthy(v))
                            .map(py_str)
                    })
                    .unwrap_or_default();
                let label = if !turn.is_empty() {
                    format!("Agent开始 turn={turn}")
                } else {
                    "Agent开始运行".to_string()
                };
                lines.push(format!("    Note over A: {}", mermaid_quote(&label)));
            }
            "api_call" => {
                let in_t = attrs
                    .get("input_tokens")
                    .filter(|v| is_truthy(v))
                    .cloned()
                    .or_else(|| {
                        attrs
                            .get("gen_ai.usage.input_tokens")
                            .filter(|v| is_truthy(v))
                            .cloned()
                    })
                    .map(|v| py_str(&v))
                    .unwrap_or_default();
                let out_t = attrs
                    .get("output_tokens")
                    .filter(|v| is_truthy(v))
                    .cloned()
                    .or_else(|| {
                        attrs
                            .get("gen_ai.usage.output_tokens")
                            .filter(|v| is_truthy(v))
                            .cloned()
                    })
                    .map(|v| py_str(&v))
                    .unwrap_or_default();
                let finish = sanitize_mermaid(
                    &to_str(
                        &attrs
                            .get("finish_reason")
                            .filter(|v| is_truthy(v))
                            .cloned()
                            .or_else(|| {
                                attrs
                                    .get("gen_ai.response.finish_reasons")
                                    .filter(|v| is_truthy(v))
                                    .cloned()
                            })
                            .unwrap_or(Value::Null),
                    ),
                    15,
                );
                let mut parts: Vec<String> = Vec::new();
                if !in_t.is_empty() {
                    parts.push(format!("in={in_t}tok"));
                }
                if !out_t.is_empty() {
                    parts.push(format!("out={out_t}tok"));
                }
                if !finish.is_empty() {
                    parts.push(format!("finish={finish}"));
                }
                let resp = if parts.is_empty() {
                    "返回结果".to_string()
                } else {
                    format!("返回结果 {}", parts.join(" "))
                };
                lines.push("    A->>+L: \"LLM推理\"".to_string());
                lines.push(format!("    L-->>-A: {}", mermaid_quote(&resp)));
            }
            "tool_call" => {
                let fname = attrs
                    .get("function_name")
                    .filter(|v| is_truthy(v))
                    .map(py_str)
                    .or_else(|| {
                        row.get("function_name")
                            .filter(|v| is_truthy(v))
                            .map(py_str)
                    })
                    .or_else(|| row.get("tool_name").filter(|v| is_truthy(v)).map(py_str))
                    .unwrap_or_else(|| "tool".into());
                let fn_s = sanitize_mermaid(&fname, 22);
                let dur = attrs.get("duration_ms").map(py_str).unwrap_or_default();
                let success = to_str(
                    &attrs
                        .get("success")
                        .filter(|v| is_truthy(v))
                        .cloned()
                        .or_else(|| attrs.get("status").filter(|v| is_truthy(v)).cloned())
                        .unwrap_or(Value::Null),
                );
                let fpath_raw = to_str(
                    &attrs
                        .get("file_path")
                        .filter(|v| is_truthy(v))
                        .cloned()
                        .or_else(|| row.get("file_path").filter(|v| is_truthy(v)).cloned())
                        .unwrap_or(Value::Null),
                );
                let fpath = short_path(&fpath_raw, 32);
                let req = if fpath.is_empty() {
                    fn_s.clone()
                } else {
                    format!("{fn_s} path={fpath}")
                };
                let mut resp_parts: Vec<String> = Vec::new();
                if !dur.is_empty() {
                    resp_parts.push(format!("{dur}ms"));
                }
                if success == "True" || success == "true" || success == "success" {
                    resp_parts.push("成功".into());
                } else if !success.is_empty() && success != "None" && success != "False" {
                    resp_parts.push(sanitize_mermaid(&success, 15));
                }
                let resp = if resp_parts.is_empty() {
                    "完成".to_string()
                } else {
                    format!("完成 {}", resp_parts.join(" "))
                };
                lines.push(format!("    A->>+T: {}", mermaid_quote(&req)));
                lines.push(format!("    T-->>-A: {}", mermaid_quote(&resp)));
            }
            "file_op" => {
                let op = attrs
                    .get("operation")
                    .map(py_str)
                    .unwrap_or_default()
                    .to_lowercase();
                let fpath_raw = to_str(
                    &attrs
                        .get("path")
                        .filter(|v| is_truthy(v))
                        .cloned()
                        .or_else(|| attrs.get("file_path").filter(|v| is_truthy(v)).cloned())
                        .unwrap_or(Value::Null),
                );
                let fpath = short_path(&fpath_raw, 32);
                let op_zh = match op.as_str() {
                    "read" => "读取".to_string(),
                    "write" => "写入".to_string(),
                    "delete" => "删除".to_string(),
                    _ => {
                        if op.is_empty() {
                            "操作".to_string()
                        } else {
                            op.clone()
                        }
                    }
                };
                let size = attrs.get("size_bytes").map(py_str).unwrap_or_default();
                let mut size_str = String::new();
                if !size.is_empty()
                    && let Ok(f) = size.parse::<f64>()
                {
                    let kb = (f as i64) / 1024;
                    size_str = if kb > 0 {
                        format!(" {kb}KB")
                    } else {
                        format!(" {}B", f as i64)
                    };
                }
                let label = if !fpath.is_empty() {
                    format!("{op_zh} {fpath}{size_str}")
                } else {
                    op_zh
                };
                lines.push(format!("    T->>F: {}", mermaid_quote(&label)));
            }
            "agent_end" => {
                let status = to_str(&attrs.get("status").cloned().unwrap_or(Value::Null));
                let turns = attrs
                    .get("total_turns")
                    .filter(|v| is_truthy(v))
                    .cloned()
                    .or_else(|| attrs.get("turn_count").filter(|v| is_truthy(v)).cloned())
                    .map(|v| py_str(&v))
                    .unwrap_or_default();
                let dur = attrs.get("duration_ms").map(py_str).unwrap_or_default();
                let mut parts = vec!["任务结束".to_string()];
                if !status.is_empty() {
                    parts.push(format!("状态={}", sanitize_mermaid(&status, 12)));
                }
                if !turns.is_empty() {
                    parts.push(format!("共{turns}轮"));
                }
                if !dur.is_empty()
                    && let Ok(f) = dur.parse::<f64>()
                {
                    parts.push(format!("耗时{}s", (f as i64) / 1000));
                }
                lines.push(format!("    A->>U: {}", mermaid_quote(&parts.join(" "))));
            }
            _ => {}
        }
    }

    lines.join("\n")
}

// ══════════════════════════════════════════════════════════════
// Workflow DAG (ReactFlow JSON) + trace tree
// ══════════════════════════════════════════════════════════════

const DAG_NODE_STYLES: [(&str, &str, &str); 8] = [
    ("#ede9fe", "#a78bfa", "#5b21b6"), // 紫色系
    ("#dbeafe", "#60a5fa", "#1e40af"), // 蓝色系
    ("#dcfce7", "#22c55e", "#166534"), // 绿色系
    ("#fef3c7", "#fbbf24", "#92400e"), // 黄色系
    ("#ffe4e6", "#f43f5e", "#9f1239"), // 粉色系
    ("#e0f2fe", "#0284c7", "#0c4a6e"), // 天蓝系
    ("#f0fdf4", "#4ade80", "#14532d"), // 翠绿系
    ("#fff7ed", "#f97316", "#9a3412"), // 橙色系
];

const AGENT_ICONS: [(&str, &str); 11] = [
    ("开始", "🚀"),
    ("规划", "📐"),
    ("需求分解", "📋"),
    ("spec", "📝"),
    ("explore", "🔍"),
    ("tdd", "🧪"),
    ("构建", "📦"),
    ("门禁", "🚧"),
    ("commit", "📤"),
    ("review", "🔎"),
    ("test", "✅"),
];

pub fn agent_icon(name: &str) -> String {
    let name_lower = name.to_lowercase();
    for (key, icon) in AGENT_ICONS {
        if name_lower.contains(key) {
            return icon.to_string();
        }
    }
    "🤖".to_string()
}

/// Port of `_build_dag_mermaid` — ReactFlow JSON → flowchart LR.
pub fn dag_mermaid(data: &Value) -> String {
    let nodes = data
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let edges = data
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut node_index: HashMap<String, usize> = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        if let Some(id) = n.get("id").and_then(Value::as_str) {
            node_index.insert(id.to_string(), i);
        }
    }

    let mut lines = vec!["flowchart LR".to_string()];

    for (i, n) in nodes.iter().enumerate() {
        let mid = format!("N{i}");
        let node_data = n.get("data").cloned().unwrap_or(Value::Null);
        let title = node_data
            .get("title")
            .map(py_str)
            .unwrap_or_else(|| n.get("id").map(py_str).unwrap_or_default());
        let desc = node_data
            .get("description")
            .map(py_str)
            .unwrap_or_default()
            .chars()
            .take(40)
            .collect::<String>();

        let icon = agent_icon(&title);
        let mut parts = vec![format!("{icon} {}", html_escape(&title))];
        if !desc.is_empty() {
            parts.push(format!("<i>{}</i>", html_escape(&desc)));
        }
        let node_label = parts.join("<br/>");

        let (fill, stroke, text) = DAG_NODE_STYLES[i % DAG_NODE_STYLES.len()];
        lines.push(format!("    {mid}[\"{node_label}\"]:::{mid}Style"));
        lines.push(format!(
            "    classDef {mid}Style fill:{fill},stroke:{stroke},color:{text},stroke-width:2px,rx:8,ry:8"
        ));
    }

    for e in &edges {
        let (Some(src), Some(tgt)) = (
            e.get("source").and_then(Value::as_str),
            e.get("target").and_then(Value::as_str),
        ) else {
            continue;
        };
        if let (Some(&si), Some(&ti)) = (node_index.get(src), node_index.get(tgt)) {
            lines.push(format!("    N{si} --> N{ti}"));
        }
    }

    lines.join("\n")
}

// ── Trace tree flowchart (TD) ─────────────────────────────────

const MERMAID_FILL: [(&str, &str); 5] = [
    ("completed", "#dcfce7"),
    ("failed", "#fecaca"),
    ("error", "#fecaca"),
    ("running", "#fef3c7"),
    ("unknown", "#e2e8f0"),
];
const MERMAID_STROKE: [(&str, &str); 5] = [
    ("completed", "#22c55e"),
    ("failed", "#f87171"),
    ("error", "#f87171"),
    ("running", "#fbbf24"),
    ("unknown", "#94a3b8"),
];
const MERMAID_TEXT: [(&str, &str); 5] = [
    ("completed", "#166534"),
    ("failed", "#991b1b"),
    ("error", "#991b1b"),
    ("running", "#92400e"),
    ("unknown", "#475569"),
];

const STATE_COLORS: [(&str, &str); 5] = [
    ("completed", "✅ 已完成"),
    ("failed", "❌ 失败"),
    ("error", "❌ 出错"),
    ("running", "⏳ 进行中"),
    ("unknown", "❓ 未知"),
];

fn lookup<'a>(table: &'a [(&str, &str)], key: &str, default: &'a str) -> &'a str {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
        .unwrap_or(default)
}

fn flatten_tree(node: &WorkflowNode) -> Vec<&WorkflowNode> {
    let mut nodes = vec![node];
    for child in &node.children {
        nodes.extend(flatten_tree(child));
    }
    nodes
}

/// Port of the tree `_render_flowchart` builder (TD layout).
pub fn tree_mermaid(root: &WorkflowNode) -> String {
    let all_nodes = flatten_tree(root);

    let mut lines = vec!["flowchart TD".to_string()];
    let mut node_ids: HashMap<String, String> = HashMap::new();

    for (i, node) in all_nodes.iter().enumerate() {
        let mid = format!("N{i}");
        node_ids.insert(node.id.clone(), mid.clone());

        let icon = agent_icon(&node.name);
        let label = if node.name.is_empty() {
            "unnamed".to_string()
        } else {
            node.name.clone()
        };
        let desc = node.description.chars().take(60).collect::<String>();

        let mut parts = vec![format!("{icon} {}", html_escape(&label))];
        if !desc.is_empty() {
            parts.push(html_escape(&desc));
        }
        let dur_str = match node.duration_ms {
            Some(ms) => format!("{:.1}s", ms as f64 / 1000.0),
            None => String::new(),
        };
        let state_label = lookup(&STATE_COLORS, &node.state, "❓ 未知");
        let mut status_line = state_label.to_string();
        if !dur_str.is_empty() {
            status_line = format!("{status_line} · {dur_str}");
        }
        parts.push(status_line);

        let node_label = parts.join("<br/>");
        let fill = lookup(&MERMAID_FILL, &node.state, "#e2e8f0");
        let stroke = lookup(&MERMAID_STROKE, &node.state, "#94a3b8");
        let text = lookup(&MERMAID_TEXT, &node.state, "#475569");

        lines.push(format!("    {mid}[\"{node_label}\"]:::{mid}Style"));
        lines.push(format!(
            "    classDef {mid}Style fill:{fill},stroke:{stroke},color:{text},stroke-width:2px,rx:8,ry:8"
        ));
    }

    for node in all_nodes.iter() {
        if let Some(pid) = &node.parent_id
            && let (Some(mid), Some(pmid)) = (node_ids.get(&node.id), node_ids.get(pid))
        {
            let step_label = if node.global_step > 0 {
                format!("Step {}", node.global_step)
            } else {
                String::new()
            };
            if step_label.is_empty() {
                lines.push(format!("    {pmid} --> {mid}"));
            } else {
                lines.push(format!("    {pmid} -->|\"{step_label}\"| {mid}"));
            }
        }
    }

    lines.join("\n")
}

/// Convenience: build the tree mermaid from a ParseResult directly.
pub fn workflow_tree_mermaid(result: &ParseResult) -> Option<String> {
    crate::derive::workflow::build_workflow(result).map(|root| tree_mermaid(&root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> Vec<Value> {
        let bytes = std::fs::read(format!(
            "{}/tests/fixtures/{}",
            env!("CARGO_MANIFEST_DIR"),
            name
        ))
        .unwrap();
        crate::util::load_ndjson(&bytes)
    }

    #[test]
    fn opencode_units_pair_tools_atomically() {
        let events = fixture("sample_opencode.ndjson");
        let units = opencode_sequence_units(&events);
        // 5 tool.start + 4 tool.finish → 4 pairs; remaining start dropped
        let pairs = units.iter().filter(|u| u["kind"] == "tool_pair").count();
        assert_eq!(pairs, 4);
        // single units for text/step/session events
        let singles = units.iter().filter(|u| u["kind"] == "single").count();
        assert!(singles >= 8, "singles: {singles}");
    }

    #[test]
    fn opencode_mermaid_has_balanced_activations() {
        let events = fixture("sample_opencode.ndjson");
        let units = opencode_sequence_units(&events);
        let sampled = crate::derive::sample::sample_events(&units, 60, 42).events;
        let src = opencode_build_mermaid(&sampled);
        let plus = src.matches("->>+").count();
        let minus = src.matches("-->>-").count();
        // every tool_pair emits one +T and one -T; singles add self-activations
        let pairs = sampled.iter().filter(|u| u["kind"] == "tool_pair").count();
        assert_eq!(
            plus - pairs,
            minus - pairs,
            "activation pairs unbalanced:\n{src}"
        );
        assert!(src.starts_with("sequenceDiagram"));
        assert!(src.contains("participant T as Tool"));
    }

    #[test]
    fn claude_units_merge_tool_pairs() {
        let events = fixture("sample_claude_code_transcript.jsonl");
        let units = claude_mermaid_units(&events);
        // Task + Read = 2 tool pairs (both have results)
        let pairs = units.iter().filter(|u| u["kind"] == "tool_pair").count();
        assert_eq!(pairs, 2);
        // assistant a3 has only text → assistant_text unit
        assert!(units.iter().any(|u| u["kind"] == "assistant_text"));
    }

    #[test]
    fn claude_mermaid_renders() {
        let events = fixture("sample_claude_code_transcript.jsonl");
        let units = claude_mermaid_units(&events);
        let src = claude_build_mermaid(&units, true);
        assert!(src.starts_with("sequenceDiagram"));
        // transcript ts formatting — note the colon survives mermaid_quote as
        // the fullwidth ：
        assert!(src.contains("10：02：00"), "missing formatted ts:\n{src}");
        // tool label sanitized (no raw quotes breaking labels)
        assert!(!src.contains("\"[\""), "unsanitized label:\n{src}");
    }

    #[test]
    fn gemini_mermaid_steps_and_render() {
        let bytes = std::fs::read(format!(
            "{}/tests/fixtures/sample_gemini.log",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let result = crate::parsers::gemini::parse(&bytes);
        let steps = gemini_sequence_steps(&result.raw_events);
        // api_call x2 (gen_ai.client.request) + tool_call x2 (gemini_cli.tool_call
        // AND tool_call_response — both contain "tool_call")
        assert_eq!(steps.len(), 4);
        let src = gemini_build_mermaid(&steps);
        assert!(src.starts_with("sequenceDiagram"));
        assert!(src.contains("participant L as LLM API"));
        assert!(src.contains("A->>+T"), "missing tool activation:\n{src}");
    }

    #[test]
    fn dag_mermaid_builds_lr_flowchart() {
        let data = json!({
            "nodes": [
                {"id": "n1", "data": {"title": "探索", "description": "explore codebase"}},
                {"id": "n2", "data": {"title": "构建"}}
            ],
            "edges": [{"source": "n1", "target": "n2"}]
        });
        let src = dag_mermaid(&data);
        assert!(src.starts_with("flowchart LR"));
        // "探索" is not in the legacy icon table → 🤖 fallback
        assert!(src.contains("N0[\"🤖 探索<br/><i>explore codebase</i>\"]"));
        assert!(src.contains("classDef N0Style"));
        assert!(src.contains("N0 --> N1"));
        assert!(src.contains("N1[\"📦 构建\"]"), "构建 icon missing:\n{src}");
    }

    #[test]
    fn tree_mermaid_uses_state_colors() {
        let result = crate::parsers::claude_code::parse(
            &std::fs::read(format!(
                "{}/tests/fixtures/sample_claude_code_transcript.jsonl",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        );
        let src = workflow_tree_mermaid(&result).expect("tree");
        assert!(src.starts_with("flowchart TD"));
        assert!(
            src.contains("fill:#dcfce7"),
            "completed state fill missing:\n{src}"
        );
        // root → child edge with step label
        assert!(
            src.contains("-->|\"Step 1\"|"),
            "step edge label missing:\n{src}"
        );
    }
}
