//! Parser for Claude Code output files — port of
//! `legacy/trace_viz/parsers/claude_code.py`.
//!
//! Supports two formats automatically:
//!
//! 1. **stream-json** — produced by `claude -p "task" --output-format stream-json`
//!    Events: system | assistant | user (wraps tool_result) | result
//!
//! 2. **transcript JSONL** — saved automatically to
//!    ~/.claude/projects/<hash>/<session>.jsonl during every interactive
//!    session. Each line carries: uuid, parentUuid, timestamp, sessionId,
//!    cwd, version
//!
//! Auto-detection: if ≥ 3 of the first 10 lines contain both "uuid" and
//! "timestamp" keys → transcript format; otherwise → stream-json.

use std::collections::HashMap;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::models::{ParseResult, ResultInfo, SessionInfo, ToolCall, Turn};
use crate::tiktoken::count_tokens;
use crate::util::{is_truthy, load_ndjson, py_str, to_str, ts_delta_ms};

pub fn parse(content: &[u8]) -> ParseResult {
    let raw_events = load_ndjson(content);
    if raw_events.is_empty() {
        return ParseResult::empty("claude_code");
    }

    // ── Format detection ───────────────────────────────────────
    let transcript_hits = raw_events
        .iter()
        .take(10)
        .filter(|e| e.get("uuid").is_some() && e.get("timestamp").is_some())
        .count();
    if transcript_hits >= 3 {
        parse_transcript(&raw_events)
    } else {
        parse_stream_json(&raw_events)
    }
}

/// Tool-map record; a `records` Vec + `index` HashMap preserves Python's
/// dict insertion order for deterministic `tool_calls` output.
#[derive(Debug, Clone, Default)]
struct ToolRecord {
    /// Kept for parity with the Python tool_map record shape.
    #[allow(dead_code)]
    id: String,
    name: String,
    input: Value,
    turn_no: u64,
    call_idx: u64,
    output: Option<String>,
    is_error: bool,
    ts_start: Option<String>,
    ts_end: Option<String>,
}

#[derive(Default)]
struct ToolMap {
    records: Vec<ToolRecord>,
    index: HashMap<String, usize>,
}

impl ToolMap {
    fn len(&self) -> usize {
        self.records.len()
    }

    /// Mirrors Python `tool_map[tid] = {...}`: overwrite in place (keeping
    /// original insertion position) or append.
    fn insert(&mut self, tid: &str, rec: ToolRecord) {
        if let Some(&idx) = self.index.get(tid) {
            self.records[idx] = rec;
        } else {
            self.index.insert(tid.to_string(), self.records.len());
            self.records.push(rec);
        }
    }

    fn get_mut(&mut self, tid: &str) -> Option<&mut ToolRecord> {
        let &idx = self.index.get(tid)?;
        Some(&mut self.records[idx])
    }
}

// ══════════════════════════════════════════════════════════════
// FORMAT 1 — stream-json  (produced by -p / --print)
// ══════════════════════════════════════════════════════════════

fn parse_stream_json(raw_events: &[Value]) -> ParseResult {
    let session_info = sj_session_info(raw_events);
    let result_info = sj_result_info(raw_events);

    let mut tool_map = ToolMap::default();
    let mut turns: Vec<Turn> = Vec::new();
    sj_collect_assistant(raw_events, &mut turns, &mut tool_map);
    sj_match_tool_results(raw_events, &mut tool_map);
    let tool_calls = sj_flatten_tool_calls(raw_events, &tool_map);

    ParseResult {
        source: "claude_code".to_string(),
        raw_events: raw_events.to_vec(),
        session_info,
        result_info,
        turns,
        tool_calls,
        subagents: extract_subagents_cc(raw_events),
        parse_debug: Map::from_iter([("format".to_string(), json!("stream-json"))]),
        ..Default::default()
    }
}

fn sj_session_info(events: &[Value]) -> SessionInfo {
    for evt in events {
        if evt.get("type").and_then(Value::as_str) == Some("system") {
            let tools: Vec<String> = evt
                .get("tools")
                .and_then(Value::as_array)
                .map(|ts| {
                    ts.iter()
                        .map(|t| match t {
                            Value::Object(o) => o
                                .get("name")
                                .map(py_str)
                                .unwrap_or_else(|| serde_json::to_string(t).unwrap_or_default()),
                            other => py_str(other),
                        })
                        .collect()
                })
                .unwrap_or_default();
            return SessionInfo {
                model: evt.get("model").map(py_str).unwrap_or_default(),
                session_id: evt.get("session_id").map(py_str).unwrap_or_default(),
                permission_mode: evt.get("permissionMode").map(py_str).unwrap_or_default(),
                tools_available: tools,
                ..Default::default()
            };
        }
    }
    SessionInfo::default()
}

fn sj_result_info(events: &[Value]) -> ResultInfo {
    for evt in events {
        if evt.get("type").and_then(Value::as_str) == Some("result") {
            let usage = evt.get("usage").cloned().unwrap_or(Value::Null);
            return ResultInfo {
                duration_ms: evt.get("duration_ms").and_then(Value::as_i64).unwrap_or(0),
                duration_api_ms: evt
                    .get("duration_api_ms")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                num_turns: evt.get("num_turns").and_then(Value::as_u64).unwrap_or(0),
                total_cost_usd: evt
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                is_error: evt
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                result_text: evt.get("result").map(py_str).unwrap_or_default(),
                total_input: usage["input_tokens"].as_u64().unwrap_or(0),
                total_output: usage["output_tokens"].as_u64().unwrap_or(0),
                total_cache_creation: usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
                total_cache_read: usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
            };
        }
    }
    ResultInfo::default()
}

/// Build turn + tool-use records from assistant events.
fn sj_collect_assistant(events: &[Value], turns: &mut Vec<Turn>, tool_map: &mut ToolMap) {
    for evt in events {
        if evt.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let msg = evt.get("message").cloned().unwrap_or(Value::Null);
        let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
        let turn_no = (turns.len() + 1) as u64;
        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_count = 0u64;

        let raw_content = msg.get("content").cloned().unwrap_or(Value::Null);
        let blocks: Vec<Value> = match raw_content {
            Value::String(s) => vec![json!({"type": "text", "text": s})],
            Value::Array(a) => a,
            _ => Vec::new(),
        };
        for block in &blocks {
            let Value::Object(b) = block else { continue };
            match b.get("type").and_then(Value::as_str) {
                Some("text") => {
                    text_parts.push(b.get("text").map(py_str).unwrap_or_default());
                }
                Some("tool_use") => {
                    tool_count += 1;
                    let tid = b.get("id").map(py_str).unwrap_or_default();
                    let rec = ToolRecord {
                        id: tid.clone(),
                        name: b.get("name").map(py_str).unwrap_or_default(),
                        input: b.get("input").cloned().unwrap_or(Value::Null),
                        turn_no,
                        call_idx: tool_map.len() as u64,
                        output: None,
                        is_error: false,
                        ts_start: None,
                        ts_end: None,
                    };
                    tool_map.insert(&tid, rec);
                }
                _ => {}
            }
        }

        turns.push(Turn {
            turn_no,
            input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
            cache_read: usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
            cache_creation: usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
            stop_reason: msg.get("stop_reason").map(py_str).unwrap_or_default(),
            text_content: text_parts.join("\n"),
            tool_count,
            model: msg.get("model").map(py_str).unwrap_or_default(),
            ..Default::default()
        });
    }
}

fn sj_match_tool_results(events: &[Value], tool_map: &mut ToolMap) {
    for evt in events {
        if evt.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(blocks) = evt
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let tid = block.get("tool_use_id").map(py_str).unwrap_or_default();
            let Some(rec) = tool_map.get_mut(&tid) else {
                continue;
            };
            let content = block.get("content").cloned().unwrap_or(Value::Null);
            rec.output = Some(join_content(&content));
            rec.is_error = block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
    }
}

/// Join tool_result content (string or list of blocks) the way Python does.
fn join_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
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
        _ => to_str(content),
    }
}

fn sj_flatten_tool_calls(events: &[Value], tool_map: &ToolMap) -> Vec<ToolCall> {
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut seen: std::collections::HashSet<String> = Default::default();
    for evt in events {
        if evt.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = evt
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let tid = block.get("id").map(py_str).unwrap_or_default();
            if seen.contains(&tid) || !tool_map.index.contains_key(&tid) {
                continue;
            }
            seen.insert(tid.clone());
            let tc = &tool_map.records[*tool_map.index.get(&tid).unwrap()];
            let text = to_str(&Value::String(tc.output.clone().unwrap_or_default()));
            calls.push(ToolCall {
                name: tc.name.clone(),
                input: tc.input.clone(),
                output: text.clone(),
                is_error: tc.is_error,
                turn_no: tc.turn_no,
                call_idx: tc.call_idx,
                tiktoken_tokens: count_tokens(&text) as u64,
                output_chars: text.chars().count() as u64,
                ..Default::default()
            });
        }
    }
    calls
}

// ══════════════════════════════════════════════════════════════
// FORMAT 2 — transcript JSONL  (~/.claude/projects/*/*.jsonl)
// ══════════════════════════════════════════════════════════════

/// Subagent tool names shared between transcript and stream-json parsers.
const SUBAGENT_TOOL_NAMES: [&str; 5] = ["task", "Task", "agent", "Agent", "delegate"];

fn is_subagent_tool(name: &str) -> bool {
    SUBAGENT_TOOL_NAMES.contains(&name)
}

/// Parse the persistent JSONL transcripts saved by interactive sessions.
///
/// Merged-pass version: single traversal of raw_events builds turns, tool_map,
/// tool_calls, subagents, timestamps, and session metadata in one go.
fn parse_transcript(raw_events: &[Value]) -> ParseResult {
    let mut tool_map = ToolMap::default();
    let mut turns: Vec<Turn> = Vec::new();
    let mut model = String::new();
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut version = String::new();
    #[allow(unused_mut)] // kept for readability parity with the Python port
    let mut timestamps: Vec<String> = Vec::new();

    // Subagent extraction state (inline, avoids separate passes)
    let mut subagents: Vec<Value> = Vec::new();

    for evt in raw_events {
        let etype = evt.get("type").and_then(Value::as_str).unwrap_or("");

        // Session metadata (first wins)
        if session_id.is_empty() {
            session_id = evt.get("sessionId").map(py_str).unwrap_or_default();
        }
        if cwd.is_empty() {
            cwd = evt.get("cwd").map(py_str).unwrap_or_default();
        }
        if version.is_empty() {
            version = evt.get("version").map(py_str).unwrap_or_default();
        }

        // Timestamps for duration calculation
        let ts = evt.get("timestamp").filter(|v| is_truthy(v)).map(py_str);
        if let Some(t) = &ts {
            timestamps.push(t.clone());
        }

        // ── Assistant messages → turns + tool_use entries ──────
        if etype == "assistant" {
            let Some(msg) = evt.get("message").and_then(Value::as_object) else {
                continue;
            };
            let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
            let turn_no = (turns.len() + 1) as u64;
            if model.is_empty() {
                model = msg.get("model").map(py_str).unwrap_or_default();
            }

            let mut text_parts: Vec<String> = Vec::new();
            let mut tool_count = 0u64;
            let raw_content = msg.get("content").cloned().unwrap_or(Value::Null);
            let blocks: Vec<Value> = match raw_content {
                Value::String(s) => vec![json!({"type": "text", "text": s})],
                Value::Array(a) => a,
                _ => Vec::new(),
            };
            for block in &blocks {
                match block {
                    Value::String(s) => text_parts.push(s.clone()),
                    Value::Object(b) => match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            text_parts.push(b.get("text").map(py_str).unwrap_or_default())
                        }
                        Some("tool_use") => {
                            tool_count += 1;
                            let tid = b.get("id").map(py_str).unwrap_or_default();
                            let name = b.get("name").map(py_str).unwrap_or_default();
                            let inp = b.get("input").cloned().unwrap_or(Value::Null);

                            tool_map.insert(
                                &tid,
                                ToolRecord {
                                    id: tid.clone(),
                                    name: name.clone(),
                                    input: inp.clone(),
                                    turn_no,
                                    call_idx: tool_map.len() as u64,
                                    output: None,
                                    is_error: false,
                                    ts_start: ts.clone(),
                                    ts_end: None,
                                },
                            );

                            // Inline subagent detection
                            if is_subagent_tool(&name)
                                && let Value::Object(args) = &inp
                            {
                                let agent_name = first_nonempty([
                                    args.get("subagent_type"),
                                    args.get("agent_type"),
                                ])
                                .unwrap_or(&name)
                                .to_string();
                                let description = first_nonempty([
                                    args.get("description"),
                                    args.get("prompt"),
                                    args.get("task"),
                                ])
                                .unwrap_or("")
                                .to_string();
                                subagents.push(json!({
                                    "childSessionID": "",
                                    "agentName": agent_name,
                                    "description": description,
                                    "state": "running",  // will update when result found
                                    "globalStep": turn_no,
                                    "ts": 0,
                                    "dispatchDurationMs": Value::Null,
                                }));
                                // `_tid` is internal-only in Python and
                                // popped before returning; kept here the
                                // same way so result matching works.
                                let last = subagents.last_mut().unwrap();
                                last.as_object_mut()
                                    .unwrap()
                                    .insert("_tid".into(), Value::String(tid.clone()));
                            }
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }

            turns.push(Turn {
                turn_no,
                input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
                output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
                cache_read: usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
                cache_creation: usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
                stop_reason: msg.get("stop_reason").map(py_str).unwrap_or_default(),
                text_content: text_parts.join("\n"),
                tool_count,
                model: msg.get("model").map(py_str).unwrap_or_default(),
                ..Default::default()
            });
            continue;
        }

        // ── User messages → tool_result matching + subagent state update ──
        if etype == "user" {
            let Some(msg) = evt.get("message").and_then(Value::as_object) else {
                continue;
            };
            let Some(blocks) = msg.get("content").and_then(Value::as_array) else {
                continue;
            };
            for block in blocks {
                let Value::Object(b) = block else { continue };
                if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let tid = b
                    .get("tool_use_id")
                    .filter(|v| is_truthy(v))
                    .or_else(|| b.get("toolUseId"))
                    .map(py_str)
                    .unwrap_or_default();
                let raw = b.get("content").cloned().unwrap_or(Value::Null);
                let output_text = join_content(&raw);
                let is_err = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);

                // Match to tool_map
                if let Some(rec) = tool_map.get_mut(&tid) {
                    rec.output = Some(output_text.clone());
                    rec.is_error = is_err;
                    rec.ts_end = ts.clone();
                }

                // Update matching subagent state (first match wins, then break
                // — mirrors Python's inner loop).
                for sub in &mut subagents {
                    let obj = sub.as_object_mut().unwrap();
                    if obj.get("_tid").and_then(Value::as_str) == Some(tid.as_str()) {
                        obj.insert(
                            "state".into(),
                            Value::String(if is_err {
                                "error".into()
                            } else {
                                "completed".into()
                            }),
                        );
                        // Try to extract child session ID from output
                        if let Some(child) = extract_child_session_id(&output_text) {
                            obj.insert("childSessionID".into(), Value::String(child));
                        }
                        break;
                    }
                }
            }
            continue;
        }

        // ── Top-level tool_result events ─────────────────────────
        if etype == "tool_result" {
            let tid = evt
                .get("tool_use_id")
                .filter(|v| is_truthy(v))
                .or_else(|| evt.get("toolUseId"))
                .map(py_str)
                .unwrap_or_default();
            let raw_output = evt.get("content").cloned().unwrap_or(Value::Null);
            let output_text = join_content(&raw_output);
            let is_err = evt
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    evt.get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                });

            if let Some(rec) = tool_map.get_mut(&tid) {
                rec.output = Some(output_text);
                rec.is_error = is_err;
                rec.ts_end = ts.clone();
            }
        }
    }

    // ── Clean up subagent internal fields ─────────────────────────
    for sub in &mut subagents {
        sub.as_object_mut().unwrap().remove("_tid");
    }

    // ── Flatten tool calls from tool_map (insertion order) ─────────
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for tc in &tool_map.records {
        let text = to_str(&Value::String(tc.output.clone().unwrap_or_default()));
        tool_calls.push(ToolCall {
            name: tc.name.clone(),
            input: tc.input.clone(),
            output: text.clone(),
            is_error: tc.is_error,
            turn_no: tc.turn_no,
            call_idx: tc.call_idx,
            tiktoken_tokens: count_tokens(&text) as u64,
            output_chars: text.chars().count() as u64,
            duration_ms: ts_delta_ms(tc.ts_start.as_deref(), tc.ts_end.as_deref()),
            ..Default::default()
        });
    }

    // ── Result info ──────────────────────────────────────────────
    let mut result_info = ResultInfo {
        num_turns: turns.len() as u64,
        ..Default::default()
    };
    if !turns.is_empty() {
        result_info.total_input = turns.iter().map(|t| t.input_tokens).sum();
        result_info.total_output = turns.iter().map(|t| t.output_tokens).sum();
        result_info.total_cache_read = turns.iter().map(|t| t.cache_read).sum();
        result_info.total_cache_creation = turns.iter().map(|t| t.cache_creation).sum();
    }

    if timestamps.len() >= 2 {
        result_info.duration_ms = ts_delta_ms(
            timestamps.first().map(String::as_str),
            timestamps.last().map(String::as_str),
        ) as i64;
    }

    let mut debug = Map::new();
    debug.insert("format".into(), json!("transcript"));
    debug.insert("cwd".into(), json!(cwd.clone()));
    debug.insert("version".into(), json!(version));

    ParseResult {
        source: "claude_code".to_string(),
        raw_events: raw_events.to_vec(),
        session_info: SessionInfo {
            model,
            session_id,
            title: cwd,
            ..Default::default()
        },
        result_info,
        turns,
        tool_calls,
        subagents,
        parse_debug: debug,
        ..Default::default()
    }
}

/// Python `inp.get(k1) or inp.get(k2) or ...` helper: first non-empty string
/// among the given values.
fn first_nonempty<'v>(values: impl IntoIterator<Item = Option<&'v Value>>) -> Option<&'v str> {
    values
        .into_iter()
        .flatten()
        .find(|v| is_truthy(v))
        .and_then(|v| v.as_str())
}

// ── Subagent extraction (shared) ────────────────────────────────

// Claude Code 目前不发出独立 subagent 事件。子代理派发体现为普通的
// tool_use (name = "task" / "Task")，描述和类型编码在 input 字段里。

/// UUID regex for child session extraction (case-insensitive).
fn extract_child_session_id(text: &str) -> Option<String> {
    let re = Regex::new(
        r"(?i)(?:session[_\s]?id[:\s]+|task[_\s]?id[:\s]+)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})",
    )
    .expect("valid uuid regex");
    re.captures(text).map(|c| c[1].to_string())
}

/// 从 Claude Code raw_events 中提取 task 工具派发的 subagent 信息。
fn extract_subagents_cc(raw_events: &[Value]) -> Vec<Value> {
    // 收集所有 tool_result（可能嵌套在 user 消息下，也可能是顶层）
    let mut tool_results: HashMap<String, (String, bool)> = HashMap::new();
    for evt in raw_events {
        // 顶层 tool_result（transcript 格式可能出现）
        if evt.get("type").and_then(Value::as_str) == Some("tool_result") {
            let tid = evt
                .get("tool_use_id")
                .filter(|v| is_truthy(v))
                .or_else(|| evt.get("toolUseId"))
                .map(py_str)
                .unwrap_or_default();
            let output = join_content(&evt.get("content").cloned().unwrap_or(Value::Null));
            let is_error = evt
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    evt.get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                });
            tool_results.insert(tid, (output, is_error));
        }
        // user 消息下的 tool_result block
        if evt.get("type").and_then(Value::as_str) == Some("user") {
            let Some(msg) = evt.get("message").and_then(Value::as_object) else {
                continue;
            };
            let Some(blocks) = msg.get("content").and_then(Value::as_array) else {
                continue;
            };
            for block in blocks {
                let Value::Object(b) = block else { continue };
                if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let tid = b
                    .get("tool_use_id")
                    .filter(|v| is_truthy(v))
                    .or_else(|| b.get("toolUseId"))
                    .map(py_str)
                    .unwrap_or_default();
                let output = join_content(&b.get("content").cloned().unwrap_or(Value::Null));
                let is_error = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                tool_results.insert(tid, (output, is_error));
            }
        }
    }

    // 遍历 assistant 消息找 subagent 工具调用
    let mut subagents: Vec<Value> = Vec::new();
    for evt in raw_events {
        if evt.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(msg) = evt.get("message").and_then(Value::as_object) else {
            continue;
        };
        let Some(blocks) = msg.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            let Value::Object(b) = block else { continue };
            if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = b.get("name").map(py_str).unwrap_or_default();
            if !is_subagent_tool(&name) {
                continue;
            }
            let tid = b.get("id").map(py_str).unwrap_or_default();
            let (result_output, result_err) = tool_results.get(&tid).cloned().unwrap_or_default();
            let inp = b.get("input").cloned().unwrap_or(Value::Null);
            let args = match &inp {
                Value::Object(o) => o.clone(),
                _ => Map::new(),
            };

            // 尝试从 result output 中提取子 session ID
            // Claude Code 的 task 输出中可能包含子会话 UUID
            let child_id = extract_child_session_id(&result_output).unwrap_or_default();

            let state = if result_err { "error" } else { "completed" };
            let agent_name = ["subagent_type", "agent_type", "type"]
                .iter()
                .find_map(|k| {
                    args.get(*k)
                        .filter(|v| is_truthy(v))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or(&name)
                .to_string();
            let description = ["description", "prompt", "task"]
                .iter()
                .find_map(|k| {
                    args.get(*k)
                        .filter(|v| is_truthy(v))
                        .and_then(|v| v.as_str())
                })
                .unwrap_or("")
                .to_string();

            subagents.push(json!({
                "childSessionID": child_id,
                "agentName": agent_name,
                "description": description,
                "state": state,
                "globalStep": 0,
                "ts": 0,
                "dispatchDurationMs": Value::Null,
            }));
        }
    }

    subagents
}
