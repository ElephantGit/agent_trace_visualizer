//! Ora embedded handoff endpoint.

use axum::Json;
use axum::extract::Path;

use crate::api::errors::ApiError;
use crate::embedded::{EmbeddedResponse, resolve_embedded};

/// GET /api/embedded/{session_id}?agent_type=... — one round trip mirroring
/// the legacy `render_embedded` flow (locator → bytes → parse → status).
pub async fn embedded_handler(
    Path(session_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<EmbeddedResponse>, ApiError> {
    if !crate::api::valid_session_id(&session_id) {
        return Err(ApiError::bad_request("非法的 session_id"));
    }
    let agent_type = q.get("agent_type").cloned().unwrap_or_default();
    if agent_type.is_empty() {
        return Err(ApiError::bad_request("缺少 agent_type 参数"));
    }
    Ok(Json(resolve_embedded(&session_id, &agent_type)))
}
