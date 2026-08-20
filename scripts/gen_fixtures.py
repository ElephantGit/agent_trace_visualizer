#!/usr/bin/env python3
"""Generate synthetic trace fixtures + golden parser outputs.

Run from the repo root (before the Python code moves to legacy/):

    python3 scripts/gen_fixtures.py

Writes:
  backend/tests/fixtures/sample_opencode.ndjson
  backend/tests/fixtures/sample_claude_code_transcript.jsonl
  backend/tests/fixtures/sample_claude_code_stream.json
  backend/tests/fixtures/sample_gemini.log
  backend/tests/fixtures/golden/<name>.json   (legacy parser output, dataclasses.asdict)

The golden files let the Rust port prove field-level parity with the legacy
Python parsers while both implementations still exist side by side.
"""

from __future__ import annotations

import dataclasses
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "backend", "tests", "fixtures")
GOLDEN = os.path.join(FIXTURES, "golden")

sys.path.insert(0, ROOT)  # make `trace_viz` importable from repo root

from trace_viz.parsers import claude_code, gemini, opencode  # noqa: E402


def write(name: str, content: str) -> str:
    path = os.path.join(FIXTURES, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


# ── Opencode NDJSON ─────────────────────────────────────────────

def _oc_event(etype: str, ts: int, **kw) -> dict:
    return {"type": etype, "ts": ts, **kw}


def build_opencode() -> str:
    t = 1_700_000_000_000
    evs: list[dict] = []

    def push(e: dict):
        evs.append(e)

    push(_oc_event("session.start", t, model="anthropic/claude-sonnet-4-20250514",
                   sessionID="ses_main", title="refactor dashboard"))
    # ── Step 1: dispatch a task subagent ──
    push(_oc_event("step.start", t + 10, globalStep=1))
    push(_oc_event("text.user", t + 20, globalStep=1, text="refactor this"))
    push(_oc_event("tool.start", t + 30, globalStep=1, tool="task", toolCallId="tc_start_a",
                   args={"subagent_type": "general-purpose",
                         "description": "Explore the codebase"}))
    push(_oc_event("tool.finish", t + 530, globalStep=1, tool="task", toolCallId="tc_end_mismatch",
                   output='<task id="ses_child123" state="completed">done</task>',
                   outputSize=20, isError=False, duration=500))
    push(_oc_event("step.finish", t + 540, globalStep=1,
                   cumTokens={"input": 1000, "output": 100},
                   tokens={"input": 1000, "output": 100, "reasoning": 50,
                           "cacheRead": 300, "cacheWrite": 20},
                   reason="end_turn"))
    # ── Step 2: parallel tools with different output sizes ──
    push(_oc_event("step.start", t + 550, globalStep=2))
    push(_oc_event("tool.start", t + 560, globalStep=2, tool="read", toolCallId="tc_r1",
                   args={"file_path": "src/lib.rs"}))
    push(_oc_event("tool.start", t + 561, globalStep=2, tool="write", toolCallId="tc_w1",
                   args={"file_path": "src/out.rs"}))
    push(_oc_event("tool.finish", t + 660, globalStep=2, tool="read", toolCallId="tc_r1",
                   output="fn main() {} pub fn add(a: i32, b: i32) -> i32 { a + b }",
                   outputSize=57, isError=False, duration=100))
    push(_oc_event("tool.finish", t + 700, globalStep=2, tool="write", toolCallId="tc_w1",
                   output="wrote file", outputSize=10, isError=False, duration=139))
    push(_oc_event("step.finish", t + 710, globalStep=2,
                   cumTokens={"input": 1600, "output": 250},
                   tokens={"input": 600, "output": 150, "reasoning": 80,
                           "cacheRead": 500, "cacheWrite": 10},
                   reason="end_turn"))
    # ── Step 3: pending task (running subagent) + a grep ──
    push(_oc_event("step.start", t + 720, globalStep=3))
    push(_oc_event("tool.start", t + 730, globalStep=3, tool="task", toolCallId="tc_start_b",
                   args={"subagent_type": "Explore", "description": "find call sites"}))
    push(_oc_event("tool.start", t + 740, globalStep=3, tool="grep", toolCallId="tc_g1",
                   args={"pattern": "TODO"}))
    push(_oc_event("tool.finish", t + 790, globalStep=3, tool="grep", toolCallId="tc_g1",
                   output="src/main.rs:12: TODO fix", outputSize=25, isError=False,
                   duration=50))
    push(_oc_event("step.finish", t + 800, globalStep=3,
                   cumTokens={"input": 1800, "output": 300},
                   tokens={"input": 200, "output": 50, "reasoning": 20,
                           "cacheRead": 150, "cacheWrite": 0},
                   reason="end_turn"))
    push(_oc_event("session.end", t + 810,
                   totalTokens={"input": 1800, "output": 300}))
    return "\n".join(json.dumps(e, ensure_ascii=False) for e in evs) + "\n"


# ── Claude Code transcript JSONL ────────────────────────────────

_CC_UUID = "123e4567-e89b-12d3-a456-426614174000"


def build_claude_transcript() -> str:
    lines = [
        {"type": "user", "uuid": "u1", "parentUuid": None,
         "timestamp": "2025-06-01T10:00:00.000Z", "sessionId": "sess-1",
         "cwd": "/home/dev/proj", "version": "2.0.0",
         "message": {"role": "user", "content": "fix the bug in parser"}},
        {"type": "assistant", "uuid": "a1", "parentUuid": "u1",
         "timestamp": "2025-06-01T10:00:05.000Z", "sessionId": "sess-1",
         "cwd": "/home/dev/proj", "version": "2.0.0",
         "message": {"role": "assistant",
                     "model": "claude-sonnet-4-5",
                     "content": [
                         {"type": "text", "text": "I'll look into it."},
                         {"type": "tool_use", "id": "toolu_1", "name": "Task",
                          "input": {"subagent_type": "Explore",
                                    "description": "find the parser bug"}}],
                     "usage": {"input_tokens": 500, "output_tokens": 120,
                               "cache_read_input_tokens": 400,
                               "cache_creation_input_tokens": 10},
                     "stop_reason": "tool_use"}},
        {"type": "user", "uuid": "u2", "parentUuid": "a1",
         "timestamp": "2025-06-01T10:01:00.000Z", "sessionId": "sess-1",
         "cwd": "/home/dev/proj", "version": "2.0.0",
         "message": {"role": "user",
                     "content": [{"type": "tool_result", "tool_use_id": "toolu_1",
                                 "is_error": False,
                                 "content": [{"type": "text",
                                              "text": f"subagent session id: {_CC_UUID} found 2 suspects"}]}]}},
        {"type": "assistant", "uuid": "a2", "parentUuid": "u2",
         "timestamp": "2025-06-01T10:01:30.000Z", "sessionId": "sess-1",
         "cwd": "/home/dev/proj", "version": "2.0.0",
         "message": {"role": "assistant", "model": "claude-sonnet-4-5",
                     "content": [{"type": "text", "text": "Reading the file…"},
                                 {"type": "tool_use", "id": "toolu_2", "name": "Read",
                                  "input": {"file_path": "src/parsers/opencode.py"}}],
                     "usage": {"input_tokens": 900, "output_tokens": 60,
                               "cache_read_input_tokens": 800,
                               "cache_creation_input_tokens": 0},
                     "stop_reason": "tool_use"}},
        # top-level tool_result (legacy transcript variant)
        {"type": "tool_result", "uuid": "r1", "parentUuid": "a2",
         "timestamp": "2025-06-01T10:01:35.000Z", "sessionId": "sess-1",
         "cwd": "/home/dev/proj", "version": "2.0.0",
         "tool_use_id": "toolu_2", "is_error": False,
         "content": "def parse(content: bytes) -> ParseResult: ..."},
        {"type": "assistant", "uuid": "a3", "parentUuid": "r1",
         "timestamp": "2025-06-01T10:02:00.000Z", "sessionId": "sess-1",
         "cwd": "/home/dev/proj", "version": "2.0.0",
         "message": {"role": "assistant", "model": "claude-sonnet-4-5",
                     "content": [{"type": "text", "text": "Fixed and verified."}],
                     "usage": {"input_tokens": 1500, "output_tokens": 40,
                               "cache_read_input_tokens": 1400,
                               "cache_creation_input_tokens": 0},
                     "stop_reason": "end_turn"}},
    ]
    return "\n".join(json.dumps(l, ensure_ascii=False) for l in lines) + "\n"


# ── Claude Code stream-json ─────────────────────────────────────

def build_claude_stream() -> str:
    lines = [
        {"type": "system", "subtype": "init",
         "model": "claude-sonnet-4-5", "session_id": "sj-1",
         "permissionMode": "default",
         "tools": [{"name": "Bash"}, {"name": "Task"}, "Grep"]},
        {"type": "assistant",
         "message": {"role": "assistant",
                     "content": [{"type": "text", "text": "Running a build"},
                                 {"type": "tool_use", "id": "st_1", "name": "Bash",
                                  "input": {"command": "cargo build"}}],
                     "usage": {"input_tokens": 300, "output_tokens": 45,
                               "cache_read_input_tokens": 200,
                               "cache_creation_input_tokens": 5},
                     "stop_reason": "tool_use"}},
        {"type": "user",
         "message": {"role": "user",
                     "content": [{"type": "tool_result", "tool_use_id": "st_1",
                                  "is_error": False,
                                  "content": "Compiling 12 crates… Finished dev profile"}]}},
        {"type": "assistant",
         "message": {"role": "assistant",
                     "content": [{"type": "text", "text": "Dispatch explorer"},
                                 {"type": "tool_use", "id": "st_2", "name": "task",
                                  "input": {"subagent_type": "Explore",
                                            "description": "map modules"}}],
                     "usage": {"input_tokens": 600, "output_tokens": 70,
                               "cache_read_input_tokens": 500,
                               "cache_creation_input_tokens": 0},
                     "stop_reason": "tool_use"}},
        {"type": "user",
         "message": {"role": "user",
                     "content": [{"type": "tool_result", "tool_use_id": "st_2",
                                  "is_error": False,
                                  "content": f"task id: {_CC_UUID} modules: util, tiktoken, parsers"}]}},
        {"type": "assistant",
         "message": {"role": "assistant",
                     "content": [{"type": "text", "text": "All done."}],
                     "usage": {"input_tokens": 1100, "output_tokens": 30,
                               "cache_read_input_tokens": 1000,
                               "cache_creation_input_tokens": 0},
                     "stop_reason": "end_turn"}},
        {"type": "result", "subtype": "success", "is_error": False,
         "result": "All done.",
         "duration_ms": 120000, "duration_api_ms": 80000, "num_turns": 3,
         "total_cost_usd": 0.042,
         "usage": {"input_tokens": 2000, "output_tokens": 145,
                   "cache_creation_input_tokens": 5,
                   "cache_read_input_tokens": 1700}},
    ]
    return "\n".join(json.dumps(l, ensure_ascii=False) for l in lines) + "\n"


# ── Gemini telemetry.log ────────────────────────────────────────

def build_gemini() -> str:
    parts = [
        # API request (compact, single line)
        json.dumps({
            "attributes": {
                "event.name": "gen_ai.client.request",
                "event.timestamp": "2025-06-02T09:00:00.000Z",
                "model": "gemini-2.5-pro",
                "gen_ai.usage.input_tokens": 400,
                "gen_ai.usage.output_tokens": 50,
                "session_id": "g1",
                "status": True,
            },
            "_body": "request body",
        }, ensure_ascii=False),
        # tool call
        json.dumps({
            "attributes": {
                "event.name": "gemini_cli.tool_call",
                "event.timestamp": "2025-06-02T09:00:01.000Z",
                "function_name": "read_file",
                "tool_name": "read_file",
                "file_path": "/tmp/a.rs",
                "duration_ms": 12.5,
                "status": "success",
            },
            "_body": "call body",
        }, ensure_ascii=False),
        # tool response (pretty-printed multi-line object, via indentation).
        # NOTE: the name must contain "tool_call" — legacy _categorize maps
        # plain "tool_response" to 响应, not 工具响应.
        json.dumps({
            "attributes": {
                "event.name": "tool_call_response",
                "event.timestamp": "2025-06-02T09:00:02.000Z",
                "function_response_tokens": 80,
                "response_tokens": 80,
            },
            "_body": "response body",
        }, ensure_ascii=False, indent=2),
        # config + metric events
        json.dumps({
            "attributes": {
                "event.name": "gemini_cli.config.loaded",
                "event.timestamp": "2025-06-02T09:00:03.000Z",
                "key": "value",
            },
        }, ensure_ascii=False),
        json.dumps({
            "attributes": {
                "event.name": "billing",
                "event.timestamp": "2025-06-02T09:00:04.000Z",
                "input_tokens": 10,
            },
        }, ensure_ascii=False),
        # another API request with gen_ai.output.messages (dict form)
        json.dumps({
            "attributes": {
                "event.name": "gen_ai.client.request",
                "event.timestamp": "2025-06-02T09:00:05.000Z",
                "model": "gemini-2.5-pro",
                "gen_ai.usage.input_tokens": 200,
                "gen_ai.usage.output_tokens": 25,
                "gen_ai.output.messages": json.dumps({
                    "tool": {"name": "write_file"},
                    "response": {"contentLength": 42},
                }),
            },
        }, ensure_ascii=False),
        # a malformed chunk to exercise parse_errors + debug panel.
        # Braces MUST balance (else split_json_objects silently drops the
        # never-closed chunk); the JSON is invalid because of the dangling
        # value after "broken".
        '{"attributes": {"event.name": "gen_ai.client.request", "broken": }}',
    ]
    return "\n".join(parts) + "\n"


def golden(name: str, result) -> None:
    path = os.path.join(GOLDEN, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dataclasses.asdict(result), f, ensure_ascii=False, indent=2)


def main() -> None:
    os.makedirs(FIXTURES, exist_ok=True)
    os.makedirs(GOLDEN, exist_ok=True)

    write("sample_opencode.ndjson", build_opencode())
    write("sample_claude_code_transcript.jsonl", build_claude_transcript())
    write("sample_claude_code_stream.json", build_claude_stream())
    write("sample_gemini.log", build_gemini())

    golden("opencode", opencode.parse(open(FIXTURES + "/sample_opencode.ndjson", "rb").read()))
    golden("claude_transcript", claude_code.parse(
        open(FIXTURES + "/sample_claude_code_transcript.jsonl", "rb").read()))
    golden("claude_stream", claude_code.parse(
        open(FIXTURES + "/sample_claude_code_stream.json", "rb").read()))
    golden("gemini", gemini.parse(open(FIXTURES + "/sample_gemini.log", "rb").read()))

    print(f"fixtures + golden written to {FIXTURES}")


if __name__ == "__main__":
    main()
