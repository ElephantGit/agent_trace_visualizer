//! trace-viz-backend — Rust port of the legacy Streamlit trace visualizer.
//!
//! 纯计算库（默认形态）：parsers + derived data + mermaid builders，全部可脱离
//! 服务器测试；编译到 `wasm32-unknown-unknown` 时（`--no-default-features`）
//! 不含任何 axum/tokio 依赖。`api` 模块与 `main.rs`（axum 二进制）仅在
//! `server` feature 下存在，是本地开发与调试的 harness。

#[cfg(feature = "server")]
pub mod api;
pub mod derive;
pub mod mermaid;
pub mod models;
pub mod parsers;
pub mod tiktoken;
pub mod util;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
