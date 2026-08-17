//! Workflow endpoints: trace tree + ReactFlow JSON.

use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::errors::ApiError;
use crate::derive::workflow;
use crate::models::{ParseResult, WorkflowNode};

#[derive(Deserialize)]
pub struct TreeRequest {
    pub result: ParseResult,
}

/// POST /api/workflow/tree — build the workflow tree from a ParseResult
/// (opencode loads child ses_*.ndjson files up to depth 3).
pub async fn tree_handler(Json(req): Json<TreeRequest>) -> Result<Json<Value>, ApiError> {
    let root: Option<WorkflowNode> = workflow::build_workflow(&req.result);
    Ok(Json(match root {
        Some(r) => serde_json::to_value(r).map_err(|e| ApiError::internal(e.to_string()))?,
        None => Value::Null,
    }))
}

/// GET /api/workflow/reactflow — the optional assets/reactflow.json (404
/// when absent; `REACTFLOW_PATH` env overrides the location).
pub async fn reactflow_handler() -> Result<Json<Value>, ApiError> {
    let data = workflow::load_reactflow_json(None)
        .ok_or_else(|| ApiError::not_found("未找到 assets/reactflow.json"))?;
    Ok(Json(json!(data)))
}
