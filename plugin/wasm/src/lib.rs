//! WebAssembly façade for the original dashboard's pure parse and derive modules.
//!
//! Trace bytes are obtained exclusively through Ora's opaque trace bridge. This crate receives
//! JSON/text already in browser memory and returns JSON, so it has no filesystem or HTTP access.

#[path = "../../../backend/src/models.rs"]
mod models;
#[path = "../../../backend/src/util.rs"]
mod util;
#[path = "../../../backend/src/tiktoken.rs"]
mod tiktoken;
#[path = "../../../backend/src/parsers/mod.rs"]
mod parsers;
#[path = "../../../backend/src/derive/mod.rs"]
mod derive;
#[path = "../../../backend/src/mermaid.rs"]
mod mermaid;

use serde::Serialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

fn as_json<T: Serialize>(value: T) -> Result<String, JsValue> {
    serde_json::to_string(&value)
        .map_err(|error| JsValue::from_str(&format!("dashboard serialization failed: {error}")))
}

fn parse_json(value: &str) -> Result<Value, JsValue> {
    serde_json::from_str(value)
        .map_err(|error| JsValue::from_str(&format!("dashboard input is not JSON: {error}")))
}

/// Parses a complete trace using the same parser as the previous Rust backend.
#[wasm_bindgen]
pub fn parse_trace(agent_type: &str, content: &str) -> Result<String, JsValue> {
    let result = parsers::parse_for_agent_type(content.as_bytes(), agent_type)
        .ok_or_else(|| JsValue::from_str("unsupported trace format"))?;
    as_json(result)
}

/// Builds the original comparison payload from two previously parsed sessions.
#[wasm_bindgen]
pub fn compare(
    result_a: &str,
    result_b: &str,
    label_a: &str,
    label_b: &str,
) -> Result<String, JsValue> {
    let result_a = serde_json::from_str(result_a)
        .map_err(|error| JsValue::from_str(&format!("invalid first parse result: {error}")))?;
    let result_b = serde_json::from_str(result_b)
        .map_err(|error| JsValue::from_str(&format!("invalid second parse result: {error}")))?;
    as_json(derive::compare::build_compare(
        &result_a, &result_b, label_a, label_b,
    ))
}

/// Runs the original replay transformation over raw events.
#[wasm_bindgen]
pub fn replay(agent_type: &str, raw_events: &str) -> Result<String, JsValue> {
    let raw_events: Vec<Value> = serde_json::from_str(raw_events)
        .map_err(|error| JsValue::from_str(&format!("invalid raw events: {error}")))?;
    let steps = match agent_type {
        "opencode" => derive::replay::opencode_to_replay_steps(&raw_events),
        "claude_code" => derive::replay::claude_code_to_replay_steps(&raw_events),
        _ => return Err(JsValue::from_str("replay is unsupported for this trace format")),
    };
    as_json(json!({
        "steps": steps,
        "pageSize": derive::replay::PAGE_SIZE,
        "contentMaxLength": derive::replay::CONTENT_MAX_LENGTH,
        "categories": derive::replay::category_styles(),
    }))
}

/// Produces the Mermaid source used by the sequence and workflow panels.
#[wasm_bindgen]
pub fn mermaid_source(kind: &str, payload: &str) -> Result<String, JsValue> {
    let payload = parse_json(payload)?;
    let source = match kind {
        "opencode" | "sequence-opencode" => mermaid::opencode_build_mermaid(&mermaid::opencode_sequence_units(
            payload
                .as_array()
                .ok_or_else(|| JsValue::from_str("events must be an array"))?,
        )),
        "claude_code" | "sequence-claude" => mermaid::claude_build_mermaid(
            &mermaid::claude_mermaid_units(
                payload
                    .as_array()
                    .ok_or_else(|| JsValue::from_str("events must be an array"))?,
            ),
            false,
        ),
        "gemini" | "sequence-gemini" => mermaid::gemini_build_mermaid(&mermaid::gemini_sequence_steps(
            payload
                .as_array()
                .ok_or_else(|| JsValue::from_str("events must be an array"))?,
        )),
        "workflow-reactflow" => mermaid::dag_mermaid(&payload),
        "workflow-tree" => {
            let result = serde_json::from_value(payload)
                .map_err(|error| JsValue::from_str(&format!("invalid workflow result: {error}")))?;
            mermaid::workflow_tree_mermaid(&result).unwrap_or_default()
        }
        _ => return Err(JsValue::from_str("unsupported Mermaid source")),
    };
    as_json(json!({ "src": source }))
}

/// Builds the existing workflow tree from a parsed result.
#[wasm_bindgen]
pub fn workflow_tree(result: &str) -> Result<String, JsValue> {
    let result = serde_json::from_str(result)
        .map_err(|error| JsValue::from_str(&format!("invalid parse result: {error}")))?;
    as_json(derive::workflow::build_workflow(&result))
}
