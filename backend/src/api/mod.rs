//! Axum router for the trace-viz API（本地开发 harness）。

//! 生产形态（dashboard 插件）不经过本 router：解析/派生全部内嵌 wasm 核心，
//! trace 内容由宿主按偏移分块直读。这里仅保留纯函数端点供本地调试与上传解析。

pub mod derive;
pub mod errors;
pub mod parse;
pub mod workflow;

use axum::Router;
use axum::routing::{get, post};

pub fn router() -> Router {
    Router::new()
        .route(
            "/api/health",
            get(|| async { axum::Json(serde_json::json!({"ok": true})) }),
        )
        .route("/api/parse/{agent_type}", post(parse::parse_upload))
        .route("/api/derive/replay", post(derive::replay_handler))
        .route("/api/derive/mermaid", post(derive::mermaid_handler))
        .route("/api/compare", post(derive::compare_handler))
        .route("/api/workflow/tree", post(workflow::tree_handler))
        .route("/api/workflow/reactflow", get(workflow::reactflow_handler))
}
