//! Derived-data endpoints: replay steps, mermaid sources, compare payload.

use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::errors::ApiError;
use crate::derive::{compare, replay, sample, workflow};
use crate::mermaid;
use crate::models::ParseResult;

pub const MAX_MERMAID_EVENTS: usize = 60;

// ── Replay ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ReplayRequest {
    /// "opencode" | "claude_code"
    pub source: String,
    #[serde(rename = "rawEvents")]
    pub raw_events: Vec<Value>,
}

/// POST /api/derive/replay — raw_events → unified replay steps.
pub async fn replay_handler(Json(req): Json<ReplayRequest>) -> Result<Json<Value>, ApiError> {
    let steps = match req.source.as_str() {
        "opencode" => replay::opencode_to_replay_steps(&req.raw_events),
        "claude_code" => replay::claude_code_to_replay_steps(&req.raw_events),
        other => return Err(ApiError::bad_request(format!("未知的 source：{other}"))),
    };
    Ok(Json(json!({
        "steps": steps,
        "pageSize": replay::PAGE_SIZE,
        "contentMaxLength": replay::CONTENT_MAX_LENGTH,
        "categories": replay::category_styles(),
    })))
}

// ── Mermaid ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct MermaidRequest {
    /// sequence-opencode | sequence-claude | sequence-gemini |
    /// workflow-reactflow | workflow-tree
    pub kind: String,
    #[serde(default, rename = "rawEvents")]
    pub raw_events: Vec<Value>,
    #[serde(default, rename = "isTranscript")]
    pub is_transcript: bool,
    #[serde(default, rename = "maxEvents")]
    pub max_events: usize,
    #[serde(default)]
    pub seed: u64,
    /// workflow-reactflow: the ReactFlow JSON (nodes/edges)
    #[serde(default)]
    pub data: Value,
    /// workflow-tree: a full ParseResult
    #[serde(default)]
    pub result: Option<ParseResult>,
}

fn sample_units(units: &[Value], max_events: usize, seed: u64) -> (Vec<Value>, Option<String>) {
    let s = sample::sample_events(units, max_events, seed);
    (s.events, s.notice)
}

/// POST /api/derive/mermaid — build a mermaid source string for any of the
/// five diagram kinds; sampling happens before unit-pairing so +T/-T
/// activations always stay balanced.
pub async fn mermaid_handler(Json(req): Json<MermaidRequest>) -> Result<Json<Value>, ApiError> {
    let max_events = if req.max_events == 0 {
        MAX_MERMAID_EVENTS
    } else {
        req.max_events
    };

    let (src, total_units, sampled_units, notice) = match req.kind.as_str() {
        "sequence-opencode" => {
            let units = mermaid::opencode_sequence_units(&req.raw_events);
            let total = units.len();
            let (sampled, notice) = sample_units(&units, max_events, req.seed);
            (
                mermaid::opencode_build_mermaid(&sampled),
                total,
                sampled.len(),
                notice,
            )
        }
        "sequence-claude" => {
            let units = mermaid::claude_mermaid_units(&req.raw_events);
            let total = units.len();
            let (sampled, notice) = sample_units(&units, max_events, req.seed);
            (
                mermaid::claude_build_mermaid(&sampled, req.is_transcript),
                total,
                sampled.len(),
                notice,
            )
        }
        "sequence-gemini" => {
            let steps = mermaid::gemini_sequence_steps(&req.raw_events);
            let total = steps.len();
            let (sampled, notice) = sample_units(&steps, max_events, req.seed);
            (
                mermaid::gemini_build_mermaid(&sampled),
                total,
                sampled.len(),
                notice,
            )
        }
        "workflow-reactflow" => {
            let n = req
                .data
                .get("nodes")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            (mermaid::dag_mermaid(&req.data), n, n, None)
        }
        "workflow-tree" => {
            let Some(result) = &req.result else {
                return Err(ApiError::bad_request("workflow-tree 需要 result 字段"));
            };
            let Some(root) = workflow::build_workflow(result) else {
                return Err(ApiError::bad_request("未找到可渲染的工作流数据"));
            };
            let total = count_tree(&root);
            (mermaid::tree_mermaid(&root), total, total, None)
        }
        other => {
            return Err(ApiError::bad_request(format!(
                "未知的 mermaid kind：{other}"
            )));
        }
    };

    Ok(Json(json!({
        "src": src,
        "totalUnits": total_units,
        "sampledUnits": sampled_units,
        "notice": notice,
    })))
}

fn count_tree(node: &crate::models::WorkflowNode) -> usize {
    1 + node.children.iter().map(count_tree).sum::<usize>()
}

// ── Compare ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CompareRequest {
    #[serde(rename = "resultA")]
    pub result_a: ParseResult,
    #[serde(rename = "resultB")]
    pub result_b: ParseResult,
    #[serde(default)]
    pub label_a: Option<String>,
    #[serde(default)]
    pub label_b: Option<String>,
}

/// POST /api/compare — two ParseResults → full precomputed payload.
pub async fn compare_handler(Json(req): Json<CompareRequest>) -> Result<Json<Value>, ApiError> {
    let label_a = req.label_a.unwrap_or_else(|| "无 RTK".into());
    let label_b = req.label_b.unwrap_or_else(|| "有 RTK".into());
    let payload = compare::build_compare(&req.result_a, &req.result_b, &label_a, &label_b);
    Ok(Json(
        serde_json::to_value(payload).map_err(|e| ApiError::internal(e.to_string()))?,
    ))
}
