//! Typed data models shared across all parsers and views — mirror of
//! `legacy/trace_viz/models.py`. Field names keep the Python snake_case so
//! serialized JSON is a drop-in replacement for the legacy app's output.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ToolCall {
    pub name: String,
    pub input: Value,
    pub output: String,
    pub is_error: bool,
    pub turn_no: u64,
    /// 0-based sequential index across the session
    pub call_idx: u64,

    // Computed fields (populated by parsers)
    pub tiktoken_tokens: u64,
    pub output_chars: u64,
    pub duration_ms: f64,
    pub file_path: String,

    // Opencode-specific: weight-distributed token cost
    pub allotted_tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Turn {
    pub turn_no: u64,
    /// total context window sent (cumulative)
    pub input_tokens: u64,
    pub output_tokens: u64,

    pub cache_read: u64,
    pub cache_creation: u64,
    pub stop_reason: String,
    pub text_content: String,
    pub tool_count: u64,
    pub model: String,

    // Opencode-specific
    pub reasoning_tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SessionInfo {
    pub model: String,
    pub session_id: String,
    pub tools_available: Vec<String>,
    pub title: String,
    pub permission_mode: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ResultInfo {
    pub duration_ms: i64,
    pub duration_api_ms: i64,
    pub num_turns: u64,
    pub total_cost_usd: f64,
    pub is_error: bool,
    pub result_text: String,

    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_creation: u64,
    pub total_cache_read: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct WorkflowNode {
    pub id: String,
    pub name: String,
    pub description: String,
    /// completed | failed | running | unknown
    pub state: String,
    pub parent_id: Option<String>,
    pub children: Vec<WorkflowNode>,
    pub global_step: u64,
    pub duration_ms: Option<i64>,
    pub tool_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub is_root: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ParseResult {
    /// "opencode" | "gemini" | "claude_code"
    pub source: String,
    pub raw_events: Vec<Value>,
    pub session_info: SessionInfo,
    pub result_info: ResultInfo,
    pub turns: Vec<Turn>,
    pub tool_calls: Vec<ToolCall>,

    pub parse_errors: u64,
    pub parse_debug: serde_json::Map<String, Value>,
    pub subagents: Vec<Value>,
}

impl ParseResult {
    pub fn empty(source: &str) -> Self {
        ParseResult {
            source: source.to_string(),
            ..Default::default()
        }
    }

    /// Mirrors the Python `peak_input_tokens` convenience property.
    pub fn peak_input_tokens(&self) -> u64 {
        if self.result_info.total_input > 0 {
            return self.result_info.total_input;
        }
        self.turns.iter().map(|t| t.input_tokens).max().unwrap_or(0)
    }
}
