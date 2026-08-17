//! trace-viz-backend server — axum + static SPA serving.
//!
//! Production: serves `frontend/dist` from the same origin (no CORS needed);
//! development: Vite dev server proxies /api to this port.
//!
//! Security note: binds 127.0.0.1 by default — this is a local developer
//! tool with filesystem access; never expose it beyond localhost.

use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use tower_http::trace::TraceLayer;

use trace_viz_backend::api;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8601;

fn dist_dir() -> PathBuf {
    std::env::var("DIST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../frontend/dist"))
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Single catch-all: serve real frontend assets, SPA-fallback to index.html
/// for client routes, JSON 404 for unknown /api paths.
async fn fallback_handler(uri: Uri, req: Request<Body>) -> Response {
    if req.method() != axum::http::Method::GET && req.method() != axum::http::Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = uri.path();
    if path.starts_with("/api") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "not_found", "message": "未知端点"})),
        )
            .into_response();
    }
    // Serve a real asset when it exists.
    let rel = path.trim_start_matches('/');
    let candidate = dist_dir().join(rel);
    if candidate.is_file()
        && let Ok(bytes) = tokio::fs::read(&candidate).await
    {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", mime_for(&candidate.to_string_lossy()))
            .body(Body::from(bytes))
            .unwrap();
    }
    // SPA fallback: client-side routes.
    let index = dist_dir().join("index.html");
    match tokio::fs::read(&index).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html; charset=utf-8")
            .body(Body::from(bytes))
            .unwrap(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            "frontend not built — run `npm run build` in frontend/ or use the Vite dev server",
        )
            .into_response(),
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let dist = dist_dir();

    // Traces can be hundreds of MB (upload mode); keep a generous limit.
    let app = Router::new()
        .merge(api::router())
        .fallback(fallback_handler)
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
    tracing::info!("trace-viz backend listening on http://{addr}");
    if dist.join("index.html").is_file() {
        tracing::info!("serving frontend from {}", dist.display());
    } else {
        tracing::warn!(
            "{} not found — API only; run `npm run build` in frontend/ or use the Vite dev proxy",
            dist.display()
        );
    }
    axum::serve(listener, app).await.unwrap();
}
