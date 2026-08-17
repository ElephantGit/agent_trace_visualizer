//! Trace-file parsers: bytes → ParseResult. Ports of `legacy/trace_viz/parsers/`.
//!
//! Each parser exposes `parse(content: &[u8]) -> ParseResult` and is pure —
//! no server or cache concerns (the legacy `@st.cache_data` role is taken
//! over by TanStack Query on the frontend).

pub mod claude_code;
pub mod gemini;
pub mod opencode;

use crate::models::ParseResult;

/// Dispatch bytes to the parser for the given canonical agent_type.
/// Returns None for unknown agent types (mirrors `embedded.py`).
pub fn parse_for_agent_type(content: &[u8], agent_type: &str) -> Option<ParseResult> {
    match agent_type {
        "opencode" => Some(opencode::parse(content)),
        "claude_code" => Some(claude_code::parse(content)),
        "gemini" => Some(gemini::parse(content)),
        _ => None,
    }
}
