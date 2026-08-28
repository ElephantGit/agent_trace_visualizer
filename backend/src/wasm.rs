//! WASM 导出层：dashboard 插件的 main.js 唯一入口，全部"字符串进、JSON 字符串出"。
//!
//! 只存在于 `wasm32` 目标（其余目标不编译本模块）。IO 与文件系统在此被结构性
//! 排除：输入是调用方已读到的文本，输出是纯计算结果，任何错误以
//! `{"error": "..."}` 字符串返回而非 panic（wasm panic 即 trap，会带走整个插件进程）。

#![cfg(target_arch = "wasm32")]

use serde::Deserialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::derive;
use crate::mermaid;
use crate::models::{ParseResult, WorkflowNode};
use crate::parsers;
use crate::tiktoken;

/// 序列化 ParseResult 时剥离的字段：原始事件体积可达数百 MB，不经过桥接，
/// 由宿主按字节偏移分块直读（RawEventsTab 走 trace_read 切片渲染）。
fn strip_raw_events(result: &ParseResult) -> serde_json::Map<String, Value> {
    let mut value = serde_json::to_value(result).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.remove("raw_events");
    }
    value.as_object().cloned().unwrap_or_default()
}

/// 把任意可序列化结果渲染为 JSON 字符串；失败时返回错误信封。
fn render(value: serde_json::Map<String, Value>) -> String {
    serde_json::to_string(&Value::Object(value)).unwrap_or_else(|error| {
        serde_json::to_string(&serde_json::json!({ "error": error.to_string() }))
            .unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_owned())
    })
}

/// 解析一段 trace 原始文本（`claude_code` / `opencode` / `gemini`）。
///
/// 返回 ParseResult 的 JSON（不含 raw_events）；未知 agent_type 返回错误信封。
#[wasm_bindgen]
pub fn parse(agent_type: &str, json: &str) -> String {
    match parsers::parse_for_agent_type(json.as_bytes(), agent_type) {
        Some(result) => render(strip_raw_events(&result)),
        None => serde_json::to_string(&serde_json::json!({
            "error": format!("未知的 agent_type：{agent_type}")
        }))
        .unwrap_or_else(|_| "{\"error\":\"unknown agent_type\"}".to_owned()),
    }
}

/// 估算一段文本的 token 数（cl100k_base；`model` 预留未来多词表，当前忽略）。
#[wasm_bindgen]
pub fn tokenize(text: &str, model: &str) -> String {
    let _ = model;
    serde_json::to_string(&serde_json::json!({ "tokens": tiktoken::count_tokens(text) }))
        .unwrap_or_else(|_| "{\"tokens\":0}".to_owned())
}

/// 与 `MermaidRequest` 同形的请求体（本模块不能依赖 server feature 的 axum 类型）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MermaidRequest {
    kind: String,
    #[serde(default)]
    raw_events: Vec<Value>,
    #[serde(default)]
    is_transcript: bool,
    #[serde(default)]
    max_events: usize,
    #[serde(default)]
    seed: u64,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    result: Option<ParseResult>,
}

/// 与 `derive::MAX_MERMAID_EVENTS` 对齐的默认采样上限。
const MAX_MERMAID_EVENTS: usize = 60;

/// 五种 mermaid 图之一：`sequence-opencode | sequence-claude | sequence-gemini |
/// workflow-reactflow | workflow-tree`。采样发生在 unit 配对之前，±T 激活保持配对。
#[wasm_bindgen]
pub fn derive_mermaid(req: &str) -> String {
    let Ok(req) = serde_json::from_str::<MermaidRequest>(req) else {
        return serde_json::to_string(&serde_json::json!({ "error": "无法解析 mermaid 请求" }))
            .unwrap_or_else(|_| "{\"error\":\"bad request\"}".to_owned());
    };
    let max_events = if req.max_events == 0 {
        MAX_MERMAID_EVENTS
    } else {
        req.max_events
    };

    let outcome = match req.kind.as_str() {
        "sequence-opencode" => {
            let units = mermaid::opencode_sequence_units(&req.raw_events);
            let total = units.len();
            let (sampled, notice) = {
                let s = crate::derive::sample::sample_events(&units, max_events, req.seed);
                (s.events, s.notice)
            };
            Some((
                mermaid::opencode_build_mermaid(&sampled),
                total,
                sampled.len(),
                notice,
            ))
        }
        "sequence-claude" => {
            let units = mermaid::claude_mermaid_units(&req.raw_events);
            let total = units.len();
            let (sampled, notice) = {
                let s = crate::derive::sample::sample_events(&units, max_events, req.seed);
                (s.events, s.notice)
            };
            Some((
                mermaid::claude_build_mermaid(&sampled, req.is_transcript),
                total,
                sampled.len(),
                notice,
            ))
        }
        "sequence-gemini" => {
            let steps = mermaid::gemini_sequence_steps(&req.raw_events);
            let total = steps.len();
            let (sampled, notice) = {
                let s = crate::derive::sample::sample_events(&steps, max_events, req.seed);
                (s.events, s.notice)
            };
            Some((
                mermaid::gemini_build_mermaid(&sampled),
                total,
                sampled.len(),
                notice,
            ))
        }
        "workflow-reactflow" => {
            let count = req
                .data
                .get("nodes")
                .and_then(Value::as_array)
                .map(|nodes| nodes.len())
                .unwrap_or(0);
            Some((mermaid::dag_mermaid(&req.data), count, count, None))
        }
        "workflow-tree" => {
            let Some(result) = &req.result else {
                return serde_json::to_string(&serde_json::json!({
                    "error": "workflow-tree 需要 result 字段"
                }))
                .unwrap_or_else(|_| "{\"error\":\"missing result\"}".to_owned());
            };
            let Some(root) = derive::workflow::build_workflow(result) else {
                return serde_json::to_string(&serde_json::json!({
                    "error": "未找到可渲染的工作流数据"
                }))
                .unwrap_or_else(|_| "{\"error\":\"no workflow\"}".to_owned());
            };
            let total = count_tree(&root);
            Some((mermaid::tree_mermaid(&root), total, total, None))
        }
        other => {
            return serde_json::to_string(&serde_json::json!({
                "error": format!("未知的 mermaid kind：{other}")
            }))
            .unwrap_or_else(|_| "{\"error\":\"unknown kind\"}".to_owned());
        }
    };

    match outcome {
        Some((src, total_units, sampled_units, notice)) => {
            serde_json::to_string(&serde_json::json!({
                "src": src,
                "totalUnits": total_units,
                "sampledUnits": sampled_units,
                "notice": notice,
            }))
            .unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_owned())
        }
        None => unreachable!("every arm above returns Some or errors"),
    }
}

fn count_tree(node: &WorkflowNode) -> usize {
    1 + node.children.iter().map(count_tree).sum::<usize>()
}

/// 与 `CompareRequest` 同形的请求体。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompareRequest {
    result_a: ParseResult,
    result_b: ParseResult,
    #[serde(default)]
    label_a: Option<String>,
    #[serde(default)]
    label_b: Option<String>,
}

/// 两个 ParseResult → 完整预计算对比负载（与本地 /api/compare 同形）。
#[wasm_bindgen]
pub fn compare(req: &str) -> String {
    let Ok(req) = serde_json::from_str::<CompareRequest>(req) else {
        return serde_json::to_string(&serde_json::json!({ "error": "无法解析 compare 请求" }))
            .unwrap_or_else(|_| "{\"error\":\"bad request\"}".to_owned());
    };
    let label_a = req.label_a.unwrap_or_else(|| "无 RTK".into());
    let label_b = req.label_b.unwrap_or_else(|| "有 RTK".into());
    let payload = derive::compare::build_compare(&req.result_a, &req.result_b, &label_a, &label_b);
    serde_json::to_string(&payload)
        .unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_owned())
}

/// 绑定会话的统一回放步骤：`source` 为 `claude_code` | `opencode`，
/// `raw_events_json` 是事件 JSON 数组字符串（main.js 持有原始行，不经过桥接）。
#[wasm_bindgen]
pub fn replay(source: &str, raw_events_json: &str) -> String {
    let Ok(events) = serde_json::from_str::<Vec<Value>>(raw_events_json) else {
        return serde_json::to_string(&serde_json::json!({ "error": "无法解析事件数组" }))
            .unwrap_or_else(|_| "{\"error\":\"bad request\"}".to_owned());
    };
    let steps = match source {
        "opencode" => derive::replay::opencode_to_replay_steps(&events),
        "claude_code" => derive::replay::claude_code_to_replay_steps(&events),
        other => {
            return serde_json::to_string(&serde_json::json!({
                "error": format!("未知的 source：{other}")
            }))
            .unwrap_or_else(|_| "{\"error\":\"unknown source\"}".to_owned());
        }
    };
    serde_json::to_string(&serde_json::json!({
        "steps": steps,
        "pageSize": derive::replay::PAGE_SIZE,
        "contentMaxLength": derive::replay::CONTENT_MAX_LENGTH,
        "categories": derive::replay::category_styles(),
    }))
    .unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_owned())
}

/// 一个 ParseResult JSON → 工作流树 JSON（输入为 null 或无渲染结构时为 `null`）。
#[wasm_bindgen]
pub fn workflow_tree(result: &str) -> String {
    // 页面无数据时传 null：与"无渲染结构"同样返回 null 而非错误。
    let Ok(result) = serde_json::from_str::<Option<ParseResult>>(result) else {
        return serde_json::to_string(&serde_json::json!({ "error": "无法解析 ParseResult" }))
            .unwrap_or_else(|_| "{\"error\":\"bad request\"}".to_owned());
    };
    let Some(result) = result else {
        return "null".to_owned();
    };
    match derive::workflow::build_workflow(&result) {
        Some(root) => serde_json::to_string(&root)
            .unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_owned()),
        None => "null".to_owned(),
    }
}
