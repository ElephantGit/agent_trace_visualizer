//! Axum router for the trace-viz API.

pub mod derive;
pub mod embedded;
pub mod errors;
pub mod parse;
pub mod traces;
pub mod workflow;

use axum::Router;
use axum::routing::{get, post};

/// Session ids are used to build locator paths — reject path separators and
/// traversal sequences (trust boundary identical to legacy: a local dev tool).
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains('\\') && !id.contains("..")
}

pub fn router() -> Router {
    Router::new()
        .route(
            "/api/health",
            get(|| async { axum::Json(serde_json::json!({"ok": true})) }),
        )
        .route("/api/parse/{agent_type}", post(parse::parse_upload))
        .route("/api/parse-from-path", post(parse::parse_from_path))
        .route(
            "/api/embedded/{session_id}",
            get(embedded::embedded_handler),
        )
        .route("/api/traces", get(traces::traces_handler))
        .route("/api/subagent/{session_id}", post(parse::subagent_handler))
        .route("/api/derive/replay", post(derive::replay_handler))
        .route("/api/derive/mermaid", post(derive::mermaid_handler))
        .route("/api/compare", post(derive::compare_handler))
        .route("/api/workflow/tree", post(workflow::tree_handler))
        .route("/api/workflow/reactflow", get(workflow::reactflow_handler))
}
