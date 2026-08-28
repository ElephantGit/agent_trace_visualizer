//! trace-viz-backend server — 本地开发 harness（API only）。
//!
//! 生产形态是 dashboard 插件：解析/派生在 wasm 核心内完成，trace 内容由
//! Ora 宿主按偏移分块直读，页面由宿主服务——本二进制只保留纯函数端点
//! （上传解析 + derive/workflow）供本地调试与脚本联调。
//!
//! Security note: binds 127.0.0.1 by default — never expose it beyond localhost.

use axum::Router;
use tower_http::trace::TraceLayer;

use trace_viz_backend::api;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8601;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    // Uploaded traces can be hundreds of MB; keep a generous limit.
    let app = Router::new()
        .merge(api::router())
        .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(TraceLayer::new_for_http());

    let host = std::env::var("DASHBOARD_HOST").unwrap_or_else(|_| DEFAULT_HOST.into());
    let port: u16 = std::env::var("DASHBOARD_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("无法绑定 {addr}: {e}"));
    tracing::info!("trace-viz backend (dev harness) listening on http://{addr}");
    axum::serve(listener, app).await.unwrap();
}
