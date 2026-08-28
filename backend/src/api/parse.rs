//! Trace parsing endpoints（仅上传形态：本地调试 harness）。

//! 生产形态（dashboard 插件）的路径读取与子会话解析已移除：trace 内容由宿主
//! 按字节偏移分块直读，wasm 核心负责解析。

use axum::Json;
use axum::extract::Path;

use crate::api::errors::ApiError;
use crate::models::ParseResult;
use crate::parsers;

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
