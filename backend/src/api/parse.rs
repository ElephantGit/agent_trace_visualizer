//! Trace parsing endpoints.

use axum::Json;
use axum::extract::Path;
use serde::Deserialize;

use crate::api::errors::ApiError;
use crate::models::ParseResult;
use crate::parsers;

/// `~/.local/share/opencode/trace` — the opencode child-trace directory
/// (resolved per call; no server state needed).
pub fn opencode_trace_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".local/share/opencode/trace")
}

fn parse_bytes(agent_type: &str, content: &[u8]) -> Result<ParseResult, ApiError> {
    match agent_type {
        "opencode" | "claude_code" | "gemini" => {
            Ok(parsers::parse_for_agent_type(content, agent_type).expect("validated agent type"))
        }
        other => Err(ApiError::bad_request(format!("未知的 agent_type：{other}"))),
    }
}

/// POST /api/parse/{agent_type} — raw trace bytes body → ParseResult.
pub async fn parse_upload(
    Path(agent_type): Path<String>,
    body: axum::body::Bytes,
) -> Result<Json<ParseResult>, ApiError> {
    parse_bytes(&agent_type, &body).map(Json)
}

#[derive(Deserialize)]
pub struct ParseFromPath {
    #[serde(rename = "agentType")]
    pub agent_type: String,
    pub path: String,
}

/// POST /api/parse-from-path — `{agentType, path}` → ParseResult.
pub async fn parse_from_path(
    Json(req): Json<ParseFromPath>,
) -> Result<Json<ParseResult>, ApiError> {
    let path = std::path::PathBuf::from(&req.path);
    if !path.is_file() {
        return Err(ApiError::not_found(format!(
            "文件不存在：{req_path}",
            req_path = req.path
        )));
    }
    let content =
        std::fs::read(&path).map_err(|e| ApiError::bad_request(format!("无法读取文件：{e}")))?;
    parse_bytes(&req.agent_type, &content).map(Json)
}

/// POST /api/subagent/{session_id} — load a child opencode trace from
/// `~/.local/share/opencode/trace/{id}.ndjson` (used by subagent drill-down
/// and workflow child loading on the frontend).
pub async fn subagent_handler(
    Path(session_id): Path<String>,
) -> Result<Json<ParseResult>, ApiError> {
    if !crate::api::valid_session_id(&session_id) {
        return Err(ApiError::bad_request("非法的 session_id"));
    }
    let child_path = opencode_trace_dir().join(format!("{session_id}.ndjson"));
    if !child_path.is_file() {
        return Err(ApiError::not_found(format!(
            "子会话 trace 不存在：{session_id}.ndjson"
        )));
    }
    let content = std::fs::read(&child_path)
        .map_err(|e| ApiError::bad_request(format!("无法读取子会话 trace：{e}")))?;
    Ok(Json(parsers::opencode::parse(&content)))
}
