//! Parser for Opencode trace-logger `.ndjson` files.
//! Port of `legacy/trace_viz/parsers/opencode.py`.
//!
//! Key algorithm: weight-based token allotment. When multiple tools run in the
//! same globalStep, the input-token delta for that step is distributed among
//! them proportionally by their tiktoken output size.

use std::collections::{HashMap, VecDeque};

use regex::Regex;
use serde_json::{Value, json};

use crate::models::{ParseResult, ResultInfo, SessionInfo, ToolCall, Turn};
use crate::tiktoken::count_tokens;
use crate::util::{load_ndjson, py_str, to_str};

pub fn parse(content: &[u8]) -> ParseResult {
    let raw_events = load_ndjson(content);
    if raw_events.is_empty() {
        return ParseResult::empty("opencode");
    }

    let session_info = extract_session_info(&raw_events);
    let turns = extract_turns(&raw_events);
    let tool_calls = extract_tool_calls(&raw_events, &turns);
    let result_info = build_result_info(&raw_events, &turns);
    let subagents = extract_subagents(&raw_events);

    ParseResult {
        source: "opencode".to_string(),
        raw_events,
        session_info,
        result_info,
        turns,
        tool_calls,
        subagents,
        ..Default::default()
    }
}

// ── Private helpers ────────────────────────────────────────────

fn extract_session_info(events: &[Value]) -> SessionInfo {
    for evt in events {
        if evt.get("type").and_then(Value::as_str) == Some("session.start") {
            return SessionInfo {
                model: evt.get("model").map(py_str).unwrap_or_default(),
                session_id: evt.get("sessionID").map(py_str).unwrap_or_default(),
                title: evt.get("title").map(py_str).unwrap_or_default(),
                ..Default::default()
            };
        }
    }
    SessionInfo::default()
}

fn extract_turns(events: &[Value]) -> Vec<Turn> {
    let mut turns = Vec::new();
    for evt in events {
        if evt.get("type").and_then(Value::as_str) != Some("step.finish") {
            continue;
        }
        turns.push(Turn {
            turn_no: evt.get("globalStep").and_then(Value::as_u64).unwrap_or(0),
            input_tokens: evt["cumTokens"]["input"].as_u64().unwrap_or(0),
            output_tokens: evt["cumTokens"]["output"].as_u64().unwrap_or(0),
            reasoning_tokens: evt["tokens"]["reasoning"].as_u64().unwrap_or(0),
            cache_read: evt["tokens"]["cacheRead"].as_u64().unwrap_or(0),
            cache_creation: evt["tokens"]["cacheWrite"].as_u64().unwrap_or(0),
            stop_reason: evt.get("reason").map(py_str).unwrap_or_default(),
            ..Default::default()
        });
    }
    turns
}

/// Port of `_extract_tool_calls` including the weight-based token allotment.
/// NOTE: the legacy Python built a `tool_start_map` here that was never read —
/// dead code, deliberately not ported.
fn extract_tool_calls(events: &[Value], turns: &[Turn]) -> Vec<ToolCall> {
    let step_map: HashMap<u64, &Turn> = turns.iter().map(|t| (t.turn_no, t)).collect();
    let finishes: Vec<&Value> = events
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("tool.finish"))
        .collect();

    // Pre-compute tiktoken tokens per finish event (needed for weight calc).
    let finish_tokens: Vec<usize> = finishes
        .iter()
        .map(|e| count_tokens(&to_str(e.get("output").unwrap_or(&Value::Null))))
        .collect();

    // Group finish indices by globalStep for parallel-tool weighting.
    let mut step_to_indices: HashMap<u64, Vec<usize>> = HashMap::new();
    for (idx, evt) in finishes.iter().enumerate() {
        let gs = evt.get("globalStep").and_then(Value::as_u64).unwrap_or(0);
        step_to_indices.entry(gs).or_default().push(idx);
    }

    let mut tool_calls = Vec::new();
    for (idx, tf) in finishes.iter().enumerate() {
        let gs = tf.get("globalStep").and_then(Value::as_u64).unwrap_or(0);

        // Token delta: how much the context window grew after this step.
        // 对于最后一个 globalStep，没有 gs+1 可供差分，此时从 session 总
        // input 中减去当前 step 的 input 作为下界近似（至少兜底不为 0）。
        let curr = step_map.get(&gs);
        let nxt = step_map.get(&(gs + 1));
        let token_delta: i64 = if let (Some(c), Some(n)) = (curr, nxt) {
            (n.input_tokens as i64 - c.input_tokens as i64).max(0)
        } else if let (Some(c), Some(last)) = (curr, turns.last()) {
            (last.input_tokens as i64 - c.input_tokens as i64).max(0)
        } else {
            0
        };

        let tok = finish_tokens[idx] as f64;
        let parallel_indices = step_to_indices
            .get(&gs)
            .cloned()
            .unwrap_or_else(|| vec![idx]);
        let total_parallel_tok: f64 = parallel_indices
            .iter()
            .map(|&i| finish_tokens[i] as f64)
            .sum();
        let weight = if total_parallel_tok > 0.0 {
            tok / total_parallel_tok
        } else {
            1.0 / parallel_indices.len() as f64
        };

        let output_text = to_str(tf.get("output").unwrap_or(&Value::Null));
        tool_calls.push(ToolCall {
            name: tf.get("tool").map(py_str).unwrap_or_default(),
            // Python: `tf.get("args", {})` — missing key defaults to {}.
            input: tf.get("args").cloned().unwrap_or_else(|| json!({})),
            output: output_text.clone(),
            is_error: tf.get("isError").and_then(Value::as_bool).unwrap_or(false),
            turn_no: gs,
            call_idx: idx as u64,
            tiktoken_tokens: tok as u64,
            output_chars: {
                // Python: `tf.get("outputSize", 0) or len(output_text)`
                let size = tf.get("outputSize").and_then(Value::as_u64).unwrap_or(0);
                if size > 0 {
                    size
                } else {
                    output_text.chars().count() as u64
                }
            },
            duration_ms: tf.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
            allotted_tokens: (token_delta as f64 * weight).round() as u64,
            ..Default::default()
        });
    }

    tool_calls
}

// 真实 opencode 并不会发出独立的 subagent.spawn 事件（插件里监听
// message.part.updated 的 agent/subtask part 分支在实际运行中从未触发过）。
// 子代理的派发在真实 trace 里只是一次普通的 task 工具调用：
//   tool.start / tool.finish，tool == "task"
// 子会话 ID 只出现在 tool.finish.output 的自由文本里，形如：
//   <task id="ses_xxx" state="completed">...
// 需要正则提取。
const TASK_RESULT_RE: &str = r#"<task\s+id="([^"]+)"\s+state="([^"]*)""#;

/// 从 task 工具调用中还原子代理派发信息，兼容旧的 subagent.spawn 事件。
///
/// 注意：真实数据里 tool.start / tool.finish 的 toolCallId 经常对不上——插件在
/// 缺少显式 ID 时用 `Date.now()` 兜底生成，start 和 finish 取到的是两个不同
/// 时刻，因此不能按 ID 配对 task 的起止。这里改用 FIFO 顺序配对：task 调用
/// 绝大多数场景下是"派发-阻塞等待完成"的顺序模式，不会大量并发交错，顺序
/// 配对足够可靠；配对结果仅用于估算父侧观测到的派发耗时，不影响子会话 ID
/// 的提取（那部分始终来自 finish.output 的正则匹配）。
fn extract_subagents(events: &[Value]) -> Vec<Value> {
    let re = Regex::new(TASK_RESULT_RE).expect("valid task-result regex");

    let mut pending_starts: VecDeque<&Value> = VecDeque::new();
    let mut subagents: Vec<Value> = Vec::new();
    let mut seen_child_ids: std::collections::HashSet<String> = Default::default();

    for evt in events {
        let etype = evt.get("type").and_then(Value::as_str).unwrap_or("");
        if etype == "tool.start" && evt.get("tool").and_then(Value::as_str) == Some("task") {
            pending_starts.push_back(evt);
            continue;
        }
        if etype != "tool.finish" || evt.get("tool").and_then(Value::as_str) != Some("task") {
            continue;
        }

        let start_evt = pending_starts.pop_front();
        let args = evt.get("args").cloned().unwrap_or(Value::Null);
        let output = to_str(evt.get("output").unwrap_or(&Value::Null));
        let m = re.captures(&output);
        let (child_id, state) = match &m {
            Some(caps) => (caps[1].to_string(), caps[2].to_string()),
            None => {
                let state = if evt.get("isError").and_then(Value::as_bool).unwrap_or(false) {
                    "error".to_string()
                } else {
                    "unknown".to_string()
                };
                (String::new(), state)
            }
        };

        // Python subtracts the raw JSON numbers; keep integer results as
        // integers (serde_json Number equality is not int/float tolerant).
        let duration_ms: Option<Value> = start_evt.map(|s| {
            let a = evt.get("ts").cloned().unwrap_or_else(|| json!(0));
            let b = s.get("ts").cloned().unwrap_or_else(|| json!(0));
            match (a.as_i64(), b.as_i64()) {
                (Some(x), Some(y)) => json!((x - y).max(0)),
                _ => json!((a.as_f64().unwrap_or(0.0) - b.as_f64().unwrap_or(0.0)).max(0.0)),
            }
        });

        if !child_id.is_empty() {
            seen_child_ids.insert(child_id.clone());
        }
        subagents.push(json!({
            "childSessionID": child_id,
            "agentName": py_str(args.get("subagent_type").unwrap_or(&Value::Null)),
            "description": py_str(args.get("description").unwrap_or(&Value::Null)),
            "state": state,
            "globalStep": evt.get("globalStep").cloned().unwrap_or(json!(0)),
            "ts": evt.get("ts").cloned().unwrap_or(json!(0)),
            "dispatchDurationMs": duration_ms,
        }));
    }

    // 还在进行中的 task 调用（只有 start，没有 finish）：拿不到子会话 ID
    // （ID 只出现在 finish 的输出里），但仍应让用户知道"有一次派发还未完成"。
    for start_evt in pending_starts {
        let args = start_evt.get("args").cloned().unwrap_or(Value::Null);
        subagents.push(json!({
            "childSessionID": "",
            "agentName": py_str(args.get("subagent_type").unwrap_or(&Value::Null)),
            "description": py_str(args.get("description").unwrap_or(&Value::Null)),
            "state": "running",
            "globalStep": start_evt.get("globalStep").cloned().unwrap_or(json!(0)),
            "ts": start_evt.get("ts").cloned().unwrap_or(json!(0)),
            "dispatchDurationMs": Value::Null,
        }));
    }

    // 向后兼容：如果某个环境的插件确实发出了 subagent.spawn，也一并纳入，
    // 按 childSessionID 去重，避免同一个子会话被展示两次。
    for evt in events {
        if evt.get("type").and_then(Value::as_str) != Some("subagent.spawn") {
            continue;
        }
        let cid = evt.get("childSessionID").map(py_str).unwrap_or_default();
        if !cid.is_empty() && seen_child_ids.contains(&cid) {
            continue;
        }
        if !cid.is_empty() {
            seen_child_ids.insert(cid.clone());
        }
        subagents.push(json!({
            "childSessionID": cid,
            "agentName": evt.get("agentName").map(py_str).unwrap_or_default(),
            "description": "",
            "state": "unknown",
            "globalStep": evt.get("globalStep").cloned().unwrap_or(json!(0)),
            "ts": evt.get("ts").cloned().unwrap_or(json!(0)),
            "dispatchDurationMs": Value::Null,
        }));
    }

    subagents
}

fn build_result_info(events: &[Value], turns: &[Turn]) -> ResultInfo {
    let mut info = ResultInfo {
        num_turns: turns.len() as u64,
        ..Default::default()
    };

    for evt in events {
        if evt.get("type").and_then(Value::as_str) == Some("session.end") {
            let ti = &evt["totalTokens"];
            info.total_input = ti["input"].as_u64().unwrap_or(0);
            info.total_output = ti["output"].as_u64().unwrap_or(0);
            break;
        }
    }

    if info.total_input == 0 && !turns.is_empty() {
        info.total_input = turns.last().unwrap().input_tokens;
        info.total_output = turns.last().unwrap().output_tokens;
    }

    if events.len() >= 2 {
        let last_ts = events
            .last()
            .unwrap()
            .get("ts")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let first_ts = events
            .first()
            .unwrap()
            .get("ts")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        info.duration_ms = (last_ts - first_ts) as i64;
    }

    info
}
