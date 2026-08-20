//! trace-viz-backend — Rust port of the legacy Streamlit trace visualizer.
//!
//! Library crate: parsers + derived data + mermaid builders, all testable
//! without the server. `main.rs` (the axum binary) consumes this crate.

pub mod api;
pub mod derive;
pub mod embedded;
pub mod mermaid;
pub mod models;
pub mod parsers;
pub mod tiktoken;
pub mod util;
