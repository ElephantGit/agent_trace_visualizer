//! Shared session-replay step adapters — port of
//! `legacy/trace_viz/views/replay.py` (rendering lives on the frontend;
//! this module owns the raw_events → ReplayStep transformation).

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::util::{is_truthy, py_str, to_str};

pub const PAGE_SIZE: usize = 50;
pub const CONTENT_MAX_LENGTH: usize = 500;

/// Unified replay step produced by the adapters.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ReplayStep {
    pub seq: u64,
    pub category: String,
    pub title: String,
    pub content: String,
    pub detail: Map<String, Value>,
    pub turn_no: u64,
    pub is_error: bool,
}

/// Category → style table (colors are presentation-owned by the frontend via
/// this single source of truth).
#[derive(Serialize)]
pub struct CategoryStyle {
    pub label: &'static str,
    pub icon: &'static str,
    pub bg: &'static str,
    pub header_bg: &'static str,
    pub border: &'static str,
    pub text: &'static str,
}

pub fn category_styles() -> Vec<(&'static str, CategoryStyle)> {
    use CategoryStyle as C;
    vec![
        (
            "system",
            C {
                label: "系统",
                icon: "⚙️",
                bg: "#faf5ff",
                header_bg: "#ede9fe",
                border: "#a78bfa",
                text: "#5b21b6",
            },
        ),
        (
            "llm_text",
            C {
                label: "LLM",
                icon: "💬",
                bg: "#eff6ff",
                header_bg: "#dbeafe",
                border: "#60a5fa",
                text: "#1e40af",
            },
        ),
        (
            "tool_call",
            C {
                label: "工具",
                icon: "🔨",
                bg: "#fffbeb",
                header_bg: "#fef3c7",
                border: "#fbbf24",
                text: "#92400e",
            },
        ),
        (
            "tool_result",
            C {
                label: "结果",
                icon: "📋",
                bg: "#f0fdf4",
                header_bg: "#dcfce7",
                border: "#4ade80",
                text: "#166534",
            },
        ),
        (
            "subagent",
            C {
                label: "Subagent",
                icon: "🤖",
                bg: "#fff1f2",
                header_bg: "#fecdd3",
                border: "#f43f5e",
                text: "#9f1239",
            },
        ),
        (
            "skill",
            C {
                label: "Skill",
                icon: "⚡",
                bg: "#fff7ed",
                header_bg: "#fed7aa",
                border: "#f97316",
                text: "#9a3412",
            },
        ),
        (
            "mcp",
            C {
                label: "MCP",
                icon: "🔌",
                bg: "#f0fdfa",
                header_bg: "#ccfbf1",
                border: "#2dd4bf",
                text: "#115e59",
            },
        ),
        (
            "result",
            C {
                label: "完成",
                icon: "✅",
                bg: "#f0fdf4",
                header_bg: "#bbf7d0",
                border: "#22c55e",
                text: "#14532d",
            },
        ),
        (
            "error",
            C {
                label: "错误",
                icon: "❌",
                bg: "#fef2f2",
                header_bg: "#fecaca",
                border: "#f87171",
                text: "#991b1b",
            },
        ),
        (
            "user_input",
            C {
                label: "用户",
                icon: "👤",
                bg: "#f8fafc",
                header_bg: "#e2e8f0",
                border: "#94a3b8",
                text: "#334155",
            },
        ),
        (
            "thinking",
            C {
                label: "思考",
                icon: "🧠",
                bg: "#faf5ff",
                header_bg: "#e9d5ff",
                border: "#a855f7",
                text: "#6b21a8",
            },
        ),
    ]
}

// ── Special tool-name matching ─────────────────────────────────

const SUBAGENT_TOOLS: [&str; 6] = ["task", "Task", "delegate", "subagent", "agent", "Agent"];
const SKILL_TOOLS: [&str; 3] = ["skill", "run_skill", "use_skill"];
const MCP_PREFIX: &str = "mcp__";

/// Port of `_classify_tool` (the label half is unused by both adapters).
fn classify_tool(tool_name: &str, tool_input: &Value) -> &'static str {
    if tool_name.starts_with(MCP_PREFIX) {
        return "mcp";
    }
    let name_lower = tool_name.to_lowercase();
    if SUBAGENT_TOOLS.contains(&name_lower.as_str()) {
        return "subagent";
    }
    if SKILL_TOOLS.contains(&name_lower.as_str()) {
        return "skill";
    }
    if let Value::Object(inp) = tool_input {
        if inp.get("subagent_type").filter(|v| is_truthy(v)).is_some()
            || inp.get("subagent_name").filter(|v| is_truthy(v)).is_some()
        {
            return "subagent";
        }
        if inp.get("skill").filter(|v| is_truthy(v)).is_some()
            || inp.get("skill_name").filter(|v| is_truthy(v)).is_some()
        {
            return "skill";
        }
    }
    "tool_call"
}

/// Port of `_first_input_value`: first meaningful string from tool input
/// (prefers descriptive keys), truncated to 80 chars.
fn first_input_value(tool_input: &Value) -> String {
    let Value::Object(inp) = tool_input else {
        return String::new();
    };
    if inp.is_empty() {
        return String::new();
    }
    for key in [
        "file_path",
        "path",
        "query",
        "pattern",
        "command",
        "url",
        "message",
    ] {
        if let Some(v) = inp.get(key).and_then(Value::as_str)
            && !v.is_empty()
        {
            return v.chars().take(80).collect();
        }
    }
    for v in inp.values() {
        if let Some(s) = v.as_str()
            && !s.is_empty()
        {
            return s.chars().take(80).collect();
        }
    }
    String::new()
}

fn truncate(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max_len).collect::<String>())
    }
}

/// `text[:100].replace("\n", " ")` — Python char-slice + newline collapse.
fn title_100(text: &str) -> String {
    text.chars()
        .take(100)
        .collect::<String>()
        .replace('\n', " ")
}

fn new_step(
    seq: u64,
    category: &str,
    title: String,
    content: String,
    detail: Map<String, Value>,
    turn_no: u64,
    is_error: bool,
) -> ReplayStep {
    ReplayStep {
        seq,
        category: category.into(),
        title,
        content,
        detail,
        turn_no,
        is_error,
    }
}

/// Iterate assistant/user `content` blocks the way `_iter_content` does.
fn iter_content(content: &Value) -> Vec<Value> {
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
        Value::String(s) => vec![json!({"type": "text", "text": s})],
        _ => Vec::new(),
    }
}

/// Join tool_result content (string or list of blocks) the way the adapters do.
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
// Adapter 1 — Claude Code
// ══════════════════════════════════════════════════════════════

pub fn claude_code_to_replay_steps(raw_events: &[Value]) -> Vec<ReplayStep> {
    let mut steps: Vec<ReplayStep> = Vec::new();
    let mut seq = 0u64;
    let mut current_turn = 0u64;

    for evt in raw_events {
        let etype = evt.get("type").and_then(Value::as_str).unwrap_or("");

        if etype == "system" {
            seq += 1;
            let model = evt.get("model").map(py_str).unwrap_or_default();
            let tool_names: Vec<String> = evt
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
            let mut detail = Map::new();
            detail.insert("model".into(), json!(model.clone()));
            detail.insert("tools_available".into(), json!(tool_names.clone()));
            steps.push(new_step(
                seq,
                "system",
                "会话初始化".into(),
                format!("模型: {model}\n\n可用工具: {}", tool_names.join(", ")),
                detail,
                0,
                false,
            ));
            continue;
        }

        if etype == "assistant" {
            let Some(msg) = evt.get("message").and_then(Value::as_object) else {
                continue;
            };
            current_turn += 1;
            let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
            let in_t = usage["input_tokens"].as_u64().unwrap_or(0);
            let out_t = usage["output_tokens"].as_u64().unwrap_or(0);
            let stop = msg.get("stop_reason").map(py_str).unwrap_or_default();
            let model = msg.get("model").map(py_str).unwrap_or_default();

            let blocks = iter_content(&msg.get("content").cloned().unwrap_or(Value::Null));
            for block in &blocks {
                let Value::Object(b) = block else { continue };
                match b.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        let text = b.get("text").map(py_str).unwrap_or_default();
                        if !text.trim().is_empty() {
                            seq += 1;
                            let mut detail = Map::new();
                            detail.insert("input_tokens".into(), json!(in_t));
                            detail.insert("output_tokens".into(), json!(out_t));
                            detail.insert("stop_reason".into(), json!(stop.clone()));
                            detail.insert("model".into(), json!(model.clone()));
                            steps.push(new_step(
                                seq,
                                "llm_text",
                                title_100(&text),
                                text,
                                detail,
                                current_turn,
                                false,
                            ));
                        }
                    }
                    "tool_use" => {
                        let tool_name = b
                            .get("name")
                            .map(py_str)
                            .unwrap_or_else(|| "unknown".into());
                        let tool_input = b.get("input").cloned().unwrap_or(Value::Null);
                        let tid = b.get("id").map(py_str).unwrap_or_default();
                        let category = classify_tool(&tool_name, &tool_input);

                        seq += 1;
                        let title = match category {
                            "subagent" => {
                                let desc = match tool_input.get("description") {
                                    Some(d) if is_truthy(d) => py_str(d),
                                    _ => match tool_input.get("prompt") {
                                        Some(p) if is_truthy(p) => {
                                            py_str(p).chars().take(80).collect()
                                        }
                                        _ => String::new(),
                                    },
                                };
                                if !desc.is_empty() {
                                    format!("Subagent: {desc}")
                                } else {
                                    format!("Subagent: {tool_name}")
                                }
                            }
                            "skill" => {
                                let skill_name = tool_input
                                    .get("skill")
                                    .filter(|v| is_truthy(v))
                                    .map(py_str)
                                    .or_else(|| {
                                        tool_input.get("name").filter(|v| is_truthy(v)).map(py_str)
                                    })
                                    .unwrap_or_else(|| tool_name.clone());
                                format!("Skill: {skill_name}")
                            }
                            "mcp" => {
                                format!("MCP: {}", tool_name.trim_start_matches(MCP_PREFIX))
                            }
                            _ => {
                                let first = first_input_value(&tool_input);
                                if !first.is_empty() {
                                    let first_60: String = first.chars().take(60).collect();
                                    format!("{tool_name}({first_60})")
                                } else {
                                    tool_name.clone()
                                }
                            }
                        };

                        let mut detail = Map::new();
                        detail.insert("tool_name".into(), json!(tool_name));
                        detail.insert("tool_input".into(), tool_input);
                        detail.insert("tool_id".into(), json!(tid));
                        detail.insert("input_tokens".into(), json!(in_t));
                        detail.insert("output_tokens".into(), json!(out_t));
                        steps.push(new_step(
                            seq,
                            category,
                            title,
                            String::new(),
                            detail,
                            current_turn,
                            false,
                        ));
                    }
                    "thinking" => {
                        let text = b
                            .get("thinking")
                            .filter(|v| is_truthy(v))
                            .map(py_str)
                            .or_else(|| b.get("text").filter(|v| is_truthy(v)).map(py_str))
                            .unwrap_or_default();
                        if !text.trim().is_empty() {
                            seq += 1;
                            steps.push(new_step(
                                seq,
                                "thinking",
                                "思考过程".into(),
                                text,
                                Map::new(),
                                current_turn,
                                false,
                            ));
                        }
                    }
                    _ => {}
                }
            }
            continue;
        }

        if etype == "user" {
            let Some(msg) = evt.get("message").and_then(Value::as_object) else {
                continue;
            };
            let blocks = iter_content(&msg.get("content").cloned().unwrap_or(Value::Null));
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
                let is_err = tr.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                let output_text =
                    join_result_content(&tr.get("content").cloned().unwrap_or(Value::Null));
                let short_output = title_100(&output_text);
                seq += 1;
                let cat = if is_err { "error" } else { "tool_result" };
                let mut detail = Map::new();
                detail.insert("tool_id".into(), json!(tid));
                detail.insert("output_length".into(), json!(output_text.chars().count()));
                steps.push(new_step(
                    seq,
                    cat,
                    if short_output.is_empty() {
                        "(空输出)".into()
                    } else {
                        short_output
                    },
                    truncate(&output_text, CONTENT_MAX_LENGTH),
                    detail,
                    current_turn,
                    is_err,
                ));
            }

            // 孤立的 user text（没有 tool_result 的 user 文本）
            if !text_blocks.is_empty() && tool_results.is_empty() {
                for b in text_blocks {
                    let text = b.get("text").map(py_str).unwrap_or_default();
                    if !text.trim().is_empty() {
                        seq += 1;
                        steps.push(new_step(
                            seq,
                            "user_input",
                            title_100(&text),
                            text,
                            Map::new(),
                            current_turn,
                            false,
                        ));
                    }
                }
            }
            continue;
        }

        if etype == "result" {
            seq += 1;
            let dur_ms = evt.get("duration_ms").and_then(Value::as_u64).unwrap_or(0);
            let n_turns = evt.get("num_turns").and_then(Value::as_u64).unwrap_or(0);
            let cost = evt
                .get("total_cost_usd")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let is_err = evt
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let result_text = evt.get("result").map(py_str).unwrap_or_default();

            let mut parts: Vec<String> = Vec::new();
            if n_turns > 0 {
                parts.push(format!("共 {n_turns} 轮推理"));
            }
            if dur_ms > 0 {
                parts.push(format!("耗时 {}s", dur_ms / 1000));
            }
            if cost > 0.0 {
                parts.push(format!("费用 ${cost:.4}"));
            }
            let mut content_lines = vec![parts.join(" | ")];
            if !result_text.is_empty() {
                content_lines.push(format!("\n\n结果: {result_text}"));
            }

            let mut detail = Map::new();
            detail.insert("duration_ms".into(), json!(dur_ms));
            detail.insert("num_turns".into(), json!(n_turns));
            detail.insert("total_cost_usd".into(), json!(cost));
            steps.push(new_step(
                seq,
                if is_err { "error" } else { "result" },
                if is_err {
                    "会话出错".into()
                } else {
                    "会话完成".into()
                },
                content_lines.join("\n"),
                detail,
                0,
                is_err,
            ));
            continue;
        }

        // 顶层 tool_result（transcript 中可能出现）
        if etype == "tool_result" {
            let is_err = evt.get("isError").and_then(Value::as_bool).unwrap_or(false);
            let output_text =
                join_result_content(&evt.get("content").cloned().unwrap_or(Value::Null));
            seq += 1;
            let cat = if is_err { "error" } else { "tool_result" };
            steps.push(new_step(
                seq,
                cat,
                title_100(&output_text),
                truncate(&output_text, CONTENT_MAX_LENGTH),
                Map::new(),
                current_turn,
                is_err,
            ));
        }
    }

    steps
}

// ══════════════════════════════════════════════════════════════
// Adapter 2 — Opencode
// ══════════════════════════════════════════════════════════════

pub fn opencode_to_replay_steps(raw_events: &[Value]) -> Vec<ReplayStep> {
    let mut steps: Vec<ReplayStep> = Vec::new();
    let mut seq = 0u64;
    let mut current_step = 0u64;
    let mut pending_tools: Map<String, Value> = Map::new();

    for evt in raw_events {
        let etype = evt.get("type").and_then(Value::as_str).unwrap_or("");

        match etype {
            "session.start" => {
                seq += 1;
                let model = evt.get("model").map(py_str).unwrap_or_default();
                let mut detail = Map::new();
                detail.insert("model".into(), json!(model.clone()));
                steps.push(new_step(
                    seq,
                    "system",
                    "会话开始".into(),
                    if model.is_empty() {
                        String::new()
                    } else {
                        format!("模型: {model}")
                    },
                    detail,
                    0,
                    false,
                ));
                continue;
            }
            "session.end" => {
                seq += 1;
                let detail: Map<String, Value> = evt.as_object().cloned().unwrap_or_default();
                steps.push(new_step(
                    seq,
                    "result",
                    "会话结束".into(),
                    String::new(),
                    detail,
                    0,
                    false,
                ));
                continue;
            }
            "text.user" => {
                let text = evt.get("text").map(py_str).unwrap_or_default();
                if !text.trim().is_empty() {
                    seq += 1;
                    steps.push(new_step(
                        seq,
                        "user_input",
                        title_100(&text),
                        text,
                        Map::new(),
                        0,
                        false,
                    ));
                }
                continue;
            }
            "step.start" => {
                current_step = evt
                    .get("globalStep")
                    .and_then(Value::as_u64)
                    .unwrap_or(current_step + 1);
                continue;
            }
            "step.finish" => continue,
            "text.assistant" => {
                let text = evt.get("text").map(py_str).unwrap_or_default();
                if !text.trim().is_empty() {
                    seq += 1;
                    steps.push(new_step(
                        seq,
                        "llm_text",
                        title_100(&text),
                        text,
                        Map::new(),
                        current_step,
                        false,
                    ));
                }
                continue;
            }
            "tool.start" => {
                let tid = evt.get("toolCallId").map(py_str).unwrap_or_default();
                if tid.is_empty() {
                    continue; // 跳过无 ID 的异常事件
                }
                let tool_name = evt
                    .get("tool")
                    .map(py_str)
                    .unwrap_or_else(|| "unknown".into());
                // opencode 用 "args" 存储参数，stream-json 用 "input"
                let tool_input = evt
                    .get("args")
                    .filter(|v| is_truthy(v))
                    .cloned()
                    .or_else(|| evt.get("input").filter(|v| is_truthy(v)).cloned())
                    .unwrap_or_else(|| json!({}));
                pending_tools.insert(
                    tid,
                    json!({
                        "name": tool_name,
                        "input": tool_input,
                        "step": current_step,
                        "ts": evt.get("ts").cloned().unwrap_or(json!(0)),
                    }),
                );
                continue;
            }
            "tool.finish" => {
                let tid = evt.get("toolCallId").map(py_str).unwrap_or_default();
                let start_info = pending_tools.remove(&tid).unwrap_or(Value::Null);
                let tool_name = start_info
                    .get("name")
                    .filter(|v| is_truthy(v))
                    .map(py_str)
                    .unwrap_or_else(|| {
                        evt.get("tool")
                            .map(py_str)
                            .unwrap_or_else(|| "unknown".into())
                    });
                let tool_input = start_info
                    .get("input")
                    .filter(|v| is_truthy(v))
                    .cloned()
                    .or_else(|| evt.get("args").filter(|v| is_truthy(v)).cloned())
                    .or_else(|| evt.get("input").filter(|v| is_truthy(v)).cloned())
                    .unwrap_or_else(|| json!({}));
                let is_err = evt.get("isError").and_then(Value::as_bool).unwrap_or(false);
                let output_text = to_str(&evt.get("output").cloned().unwrap_or(Value::Null));
                let dur_ms = evt
                    .get("duration")
                    .filter(|v| is_truthy(v))
                    .cloned()
                    .or_else(|| evt.get("durationMs").filter(|v| is_truthy(v)).cloned())
                    .map(|v| v.as_f64().unwrap_or(0.0))
                    .unwrap_or(0.0);

                let category = classify_tool(&tool_name, &tool_input);
                seq += 1;
                let title = match category {
                    "subagent" => {
                        let desc = match tool_input.get("description") {
                            Some(d) if is_truthy(d) => py_str(d),
                            _ => match tool_input.get("prompt") {
                                Some(p) if is_truthy(p) => py_str(p).chars().take(80).collect(),
                                _ => String::new(),
                            },
                        };
                        if !desc.is_empty() {
                            format!("Subagent: {desc}")
                        } else {
                            format!("Subagent: {tool_name}")
                        }
                    }
                    "skill" => {
                        let skill_name = tool_input
                            .get("skill")
                            .filter(|v| is_truthy(v))
                            .map(py_str)
                            .or_else(|| tool_input.get("name").filter(|v| is_truthy(v)).map(py_str))
                            .unwrap_or_else(|| tool_name.clone());
                        format!("Skill: {skill_name}")
                    }
                    "mcp" => format!("MCP: {}", tool_name.trim_start_matches(MCP_PREFIX)),
                    _ => {
                        let first = first_input_value(&tool_input);
                        if !first.is_empty() {
                            let first_60: String = first.chars().take(60).collect();
                            format!("{tool_name}({first_60})")
                        } else {
                            tool_name.clone()
                        }
                    }
                };

                let cat = if is_err { "error" } else { category };
                let mut detail = Map::new();
                detail.insert("tool_name".into(), json!(tool_name));
                detail.insert("tool_input".into(), tool_input);
                detail.insert("tool_id".into(), json!(tid));
                detail.insert("duration_ms".into(), json!(dur_ms));
                detail.insert("output_length".into(), json!(output_text.chars().count()));
                steps.push(new_step(
                    seq,
                    cat,
                    title,
                    truncate(&output_text, CONTENT_MAX_LENGTH),
                    detail,
                    current_step,
                    is_err,
                ));
                continue;
            }
            _ => {
                // fallback: other event types
                seq += 1;
                let content = serde_json::to_string_pretty(evt).unwrap_or_default();
                steps.push(new_step(
                    seq,
                    "system",
                    format!("事件: {etype}"),
                    content,
                    Map::new(),
                    0,
                    false,
                ));
            }
        }
    }

    steps
}

/// Truncation tiers for the frontend card rendering, mirroring the legacy
/// card layout logic (used by tests and the frontend).
pub fn content_tier(content_len: usize) -> &'static str {
    if content_len > CONTENT_MAX_LENGTH {
        "preview_only"
    } else if content_len > 300 {
        "folded"
    } else {
        "inline"
    }
}
