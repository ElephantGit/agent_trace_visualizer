//! Golden parity tests: compare the Rust parser output against JSON dumps
//! generated from the legacy Python parsers (`scripts/gen_fixtures.py`).
//!
//! Everything is compared exactly EXCEPT the tiktoken-dependent fields
//! (`tiktoken_tokens`, `allotted_tokens`): the legacy app on this machine
//! falls back to len/4 (no ~/.cache/tiktoken cache file), while Rust uses
//! the real embedded cl100k ranks. Those fields get structural checks only.

use serde_json::Value;
use trace_viz_backend::models::ParseResult;
use trace_viz_backend::parsers;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{}",
        env!("CARGO_MANIFEST_DIR"),
        name
    ))
    .unwrap()
}

fn golden(name: &str) -> Value {
    let path = format!(
        "{}/tests/fixtures/golden/{}.json",
        env!("CARGO_MANIFEST_DIR"),
        name
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn g(result: &ParseResult) -> Value {
    serde_json::to_value(result).unwrap()
}

/// Compare `path`-addressed fields exactly, then strip tiktoken fields from
/// both sides and require full equality of everything else.
fn assert_parity(paths: &[&str], rust: &ParseResult, gold: &Value) {
    let rust_v = g(rust);
    for p in paths {
        let r = get_path(&rust_v, p);
        let py = get_path(gold, p);
        assert_eq!(r, py, "field `{p}` diverges from legacy");
    }
    // Full structural comparison after removing tiktoken-dependent fields and
    // duration_ms (Python dataclasses keep ints as ints; Rust uses f64).
    let mut rust_v = g(rust);
    let mut gold_v = gold.clone();
    for p in [
        "tool_calls/tiktoken_tokens",
        "tool_calls/allotted_tokens",
        "tool_calls/duration_ms",
    ] {
        strip(&mut rust_v, p);
        strip(&mut gold_v, p);
    }
    assert_eq!(rust_v, gold_v, "full-tree parity failed");
}

/// duration_ms numeric comparison (int/float tolerant, mirrors Python).
fn assert_durations(rust: &ParseResult, gold: &Value) {
    let gold_calls = gold["tool_calls"].as_array().unwrap();
    assert_eq!(rust.tool_calls.len(), gold_calls.len());
    for (tc, gt) in rust.tool_calls.iter().zip(gold_calls) {
        let gv = gt["duration_ms"].as_f64().unwrap_or(0.0);
        assert!(
            (tc.duration_ms - gv).abs() < 0.001,
            "duration_ms mismatch for {}: {} vs {}",
            tc.name,
            tc.duration_ms,
            gv
        );
    }
}

/// Address a JSON field via "a/b/c" path (array indices not supported;
/// when a segment is an array, the operation applies to every element).
fn get_path<'v>(mut v: &'v Value, path: &str) -> &'v Value {
    for seg in path.split('/') {
        v = v.get(seg).unwrap_or(&Value::Null);
    }
    v
}

fn strip(v: &mut Value, path: &str) {
    let mut segs: Vec<&str> = path.split('/').collect();
    let last = segs.pop().unwrap();
    strip_inner(v, &segs, last);
}

fn strip_inner(v: &mut Value, segs: &[&str], last: &str) {
    if let Some((head, tail)) = segs.split_first() {
        if let Value::Object(o) = v {
            if let Some(next) = o.get_mut(*head) {
                strip_inner(next, tail, last);
            }
        } else if let Value::Array(items) = v {
            for item in items {
                strip_inner(item, segs, last);
            }
        }
        return;
    }
    match v {
        Value::Object(o) => {
            o.remove(last);
        }
        Value::Array(items) => {
            for item in items {
                if let Value::Object(o) = item {
                    o.remove(last);
                }
            }
        }
        _ => {}
    }
}

// ── Opencode ───────────────────────────────────────────────────

#[test]
fn opencode_parity() {
    let result = parsers::opencode::parse(&fixture("sample_opencode.ndjson"));
    let gold = golden("opencode");

    // session/result/turns/subagents are tiktoken-free → exact
    assert_parity(
        &[
            "source",
            "session_info",
            "result_info",
            "turns",
            "subagents",
        ],
        &result,
        &gold,
    );

    // Structural checks for the tiktoken-dependent fields.
    assert_eq!(
        result.tool_calls.len(),
        gold["tool_calls"].as_array().unwrap().len()
    );
    for (tc, gt) in result
        .tool_calls
        .iter()
        .zip(gold["tool_calls"].as_array().unwrap())
    {
        assert_eq!(tc.name, gt["name"]);
        assert_eq!(tc.turn_no, gt["turn_no"].as_u64().unwrap());
        assert_eq!(tc.call_idx, gt["call_idx"].as_u64().unwrap());
        assert_eq!(tc.output, gt["output"]);
        assert_eq!(tc.is_error, gt["is_error"]);
        // tiktoken_tokens > 0 whenever output is non-empty (both encoders)
        if !tc.output.is_empty() {
            assert!(tc.tiktoken_tokens > 0, "{}", tc.name);
        }
    }
    assert_durations(&result, &gold);
}

#[test]
fn opencode_allotment_structure() {
    let result = parsers::opencode::parse(&fixture("sample_opencode.ndjson"));

    // Legacy semantics: tools of step gs are allotted the input growth
    // BETWEEN step gs and gs+1 (nxt.input - curr.input).
    // Step 1 → 2 grows 600 tokens; the single task tool gets all of it.
    let step1: Vec<_> = result
        .tool_calls
        .iter()
        .filter(|tc| tc.turn_no == 1)
        .collect();
    assert_eq!(step1.len(), 1);
    assert_eq!(step1[0].allotted_tokens, 600);

    // Step 2 → 3 grows 200 tokens; two parallel tools share it by weight.
    let step2: Vec<_> = result
        .tool_calls
        .iter()
        .filter(|tc| tc.turn_no == 2)
        .collect();
    assert_eq!(step2.len(), 2);
    let sum: u64 = step2.iter().map(|tc| tc.allotted_tokens).sum();
    assert_eq!(sum, 200, "parallel allotment must sum to the step delta");
    // Larger output gets the larger share.
    assert!(step2[0].allotted_tokens > step2[1].allotted_tokens);

    // Last step (3): no gs+1 → fallback delta = 0 (its own turn is the last).
    let step3: Vec<_> = result
        .tool_calls
        .iter()
        .filter(|tc| tc.turn_no == 3)
        .collect();
    assert_eq!(step3.len(), 1);
    assert_eq!(step3[0].allotted_tokens, 0);
}

#[test]
fn opencode_subagent_fifo() {
    let result = parsers::opencode::parse(&fixture("sample_opencode.ndjson"));
    let subs = result.subagents;
    // task finish (step 1, matched) + pending task start (step 3, running)
    assert_eq!(subs.len(), 2);
    assert_eq!(subs[0]["childSessionID"], "ses_child123");
    assert_eq!(subs[0]["state"], "completed");
    // FIFO pairing: mismatched toolCallIds must not break the pairing.
    assert_eq!(subs[0]["dispatchDurationMs"], 500);
    assert_eq!(subs[1]["state"], "running");
    assert_eq!(subs[1]["childSessionID"], "");
}

// ── Claude Code ────────────────────────────────────────────────

#[test]
fn claude_transcript_parity() {
    let result = parsers::claude_code::parse(&fixture("sample_claude_code_transcript.jsonl"));
    let gold = golden("claude_transcript");
    assert_eq!(result.parse_debug["format"], "transcript");
    assert_parity(
        &[
            "source",
            "session_info",
            "result_info",
            "turns",
            "subagents",
            "parse_debug",
        ],
        &result,
        &gold,
    );
    assert_eq!(
        result.tool_calls.len(),
        gold["tool_calls"].as_array().unwrap().len()
    );
    // transcript tool_calls have ts-based durations — numeric equality
    assert_durations(&result, &gold);
}

#[test]
fn claude_transcript_detects_format() {
    let result = parsers::claude_code::parse(&fixture("sample_claude_code_transcript.jsonl"));
    assert_eq!(result.parse_debug["format"], "transcript");
    assert_eq!(result.turns.len(), 3);
    // subagent via inline Task detection + UUID extraction from result
    let subs = result.subagents;
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0]["agentName"], "Explore");
    assert_eq!(subs[0]["state"], "completed");
    assert_eq!(
        subs[0]["childSessionID"],
        "123e4567-e89b-12d3-a456-426614174000"
    );
}

#[test]
fn claude_stream_parity() {
    let result = parsers::claude_code::parse(&fixture("sample_claude_code_stream.json"));
    let gold = golden("claude_stream");
    assert_eq!(result.parse_debug["format"], "stream-json");
    assert_parity(
        &[
            "source",
            "session_info",
            "result_info",
            "turns",
            "subagents",
            "parse_debug",
        ],
        &result,
        &gold,
    );
    // stream-json subagent extraction (task tool_use)
    assert_eq!(result.subagents.len(), 1);
    assert_eq!(result.subagents[0]["agentName"], "Explore");
    assert_eq!(result.subagents[0]["state"], "completed");
    assert_eq!(result.result_info.total_cost_usd, 0.042);
    assert_eq!(result.session_info.tools_available.len(), 3);
}

// ── Gemini ─────────────────────────────────────────────────────

#[test]
fn gemini_parity() {
    let result = parsers::gemini::parse(&fixture("sample_gemini.log"));
    let gold = golden("gemini");

    // gemini has no tiktoken-counted tool outputs in this fixture
    // (fn_response_tokens=80 wins over count_tokens), so full equality holds
    // including tool_calls.
    assert_eq!(g(&result), gold, "gemini full-tree parity failed");

    // Spot checks on the tricky bits.
    assert_eq!(result.parse_errors, 1);
    assert_eq!(result.turns.len(), 2);
    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].tiktoken_tokens, 80);
    assert_eq!(result.tool_calls[0].allotted_tokens, 80);
    assert_eq!(result.result_info.total_input, 600);
    assert_eq!(result.result_info.duration_ms, 5000);
    assert_eq!(result.parse_debug["chunks_found"].as_u64().unwrap(), 7);
    assert_eq!(result.parse_debug["rows_err"].as_u64().unwrap(), 1);
    // categories
    let cats: Vec<_> = result
        .raw_events
        .iter()
        .map(|e| e["category"].as_str().unwrap())
        .collect();
    assert_eq!(
        cats,
        vec![
            "API 调用",
            "工具调用",
            "工具响应",
            "会话-配置",
            "计量",
            "API 调用"
        ]
    );
}

#[test]
fn gemini_split_json_objects() {
    // Multi-line pretty-printed objects must split correctly (brace depth):
    // 7 chunks total = 6 valid JSON objects + 1 malformed.
    let result = parsers::gemini::parse(&fixture("sample_gemini.log"));
    assert_eq!(result.raw_events.len(), 6);
    assert_eq!(result.parse_errors, 1);
    assert_eq!(result.parse_debug["chunks_found"].as_u64().unwrap(), 7);
    assert_eq!(result.parse_debug["rows_ok"].as_u64().unwrap(), 6);
    assert_eq!(result.parse_debug["rows_err"].as_u64().unwrap(), 1);
}
