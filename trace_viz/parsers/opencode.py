"""Parser for Opencode trace-logger `.ndjson` files.

Key algorithm: weight-based token allotment.
  When multiple tools run in the same globalStep, the input-token delta
  for that step is distributed among them proportionally by their
  tiktoken output size.
"""

from __future__ import annotations

import json
from typing import Any

import streamlit as st

from trace_viz.models import ParseResult, ResultInfo, SessionInfo, ToolCall, Turn
from trace_viz.utils import count_tokens, to_str


@st.cache_data(show_spinner=False)
def parse(content: bytes) -> ParseResult:
    """Parse Opencode NDJSON content and return a structured ParseResult."""
    raw_events = _load_ndjson(content)
    if not raw_events:
        return ParseResult.empty("opencode")

    session_info = _extract_session_info(raw_events)
    turns = _extract_turns(raw_events)
    tool_calls = _extract_tool_calls(raw_events, turns)
    result_info = _build_result_info(raw_events, turns)

    return ParseResult(
        source="opencode",
        raw_events=raw_events,
        session_info=session_info,
        result_info=result_info,
        turns=turns,
        tool_calls=tool_calls,
    )


# ── Private helpers ────────────────────────────────────────────

def _load_ndjson(content: bytes) -> list[dict[str, Any]]:
    events: list[dict] = []
    for line in content.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return events


def _extract_session_info(events: list[dict]) -> SessionInfo:
    for evt in events:
        if evt.get("type") == "session.start":
            return SessionInfo(
                model=evt.get("model", ""),
                session_id=evt.get("sessionID", ""),
                title=evt.get("title", ""),
            )
    return SessionInfo()


def _extract_turns(events: list[dict]) -> list[Turn]:
    turns: list[Turn] = []
    for evt in events:
        if evt.get("type") != "step.finish":
            continue
        turns.append(Turn(
            turn_no=evt["globalStep"],
            input_tokens=evt["cumTokens"]["input"],
            output_tokens=evt["cumTokens"]["output"],
            reasoning_tokens=evt["tokens"].get("reasoning", 0),
            cache_read=evt["tokens"].get("cacheRead", 0),
            cache_creation=evt["tokens"].get("cacheWrite", 0),
            stop_reason=evt.get("reason", ""),
        ))
    return turns


def _extract_tool_calls(
    events: list[dict], turns: list[Turn]
) -> list[ToolCall]:
    # Build lookup maps
    step_map: dict[int, Turn] = {t.turn_no: t for t in turns}
    tool_start_map: dict[str, dict] = {
        e["toolCallId"]: e for e in events if e.get("type") == "tool.start"
    }
    finishes = [e for e in events if e.get("type") == "tool.finish"]

    # Pre-compute tiktoken tokens per finish event (needed for weight calculation)
    finish_tokens: list[int] = [
        count_tokens(to_str(e.get("output", ""))) for e in finishes
    ]

    # Group finish indices by globalStep for parallel-tool weighting
    step_to_indices: dict[int, list[int]] = {}
    for idx, evt in enumerate(finishes):
        gs = evt.get("globalStep", 0)
        step_to_indices.setdefault(gs, []).append(idx)

    tool_calls: list[ToolCall] = []
    for idx, tf in enumerate(finishes):
        gs = tf.get("globalStep", 0)
        cid = tf.get("toolCallId", "")

        # Token delta: how much the context window grew after this step
        curr = step_map.get(gs)
        nxt = step_map.get(gs + 1)
        token_delta = max(0, nxt.input_tokens - curr.input_tokens) if curr and nxt else 0

        tok = finish_tokens[idx]
        parallel_indices = step_to_indices.get(gs, [idx])
        total_parallel_tok = sum(finish_tokens[i] for i in parallel_indices)
        weight = (tok / total_parallel_tok) if total_parallel_tok > 0 else (
            1.0 / len(parallel_indices)
        )

        output_text = to_str(tf.get("output", ""))
        tool_calls.append(ToolCall(
            name=tf.get("tool", ""),
            input=tf.get("args", {}),
            output=output_text,
            is_error=bool(tf.get("isError", False)),
            turn_no=gs,
            call_idx=idx,
            tiktoken_tokens=tok,
            output_chars=tf.get("outputSize", 0) or len(output_text),
            duration_ms=tf.get("duration", 0) or 0,
            allotted_tokens=round(token_delta * weight),
        ))

    return tool_calls


def _build_result_info(events: list[dict], turns: list[Turn]) -> ResultInfo:
    info = ResultInfo(num_turns=len(turns))

    for evt in events:
        if evt.get("type") == "session.end":
            ti = evt.get("totalTokens", {})
            info.total_input = ti.get("input", 0)
            info.total_output = ti.get("output", 0)
            break

    if not info.total_input and turns:
        info.total_input = turns[-1].input_tokens
        info.total_output = turns[-1].output_tokens

    if len(events) >= 2:
        info.duration_ms = events[-1]["ts"] - events[0]["ts"]

    return info
