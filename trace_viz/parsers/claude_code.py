"""Parser for Claude Code output files.

Supports two formats automatically:

1. **stream-json** — produced by `claude -p "task" --output-format stream-json`
   Events: system | assistant | user (wraps tool_result) | result

2. **transcript JSONL** — saved automatically to ~/.claude/projects/<hash>/<session>.jsonl
   during every interactive session.
   Events: user | assistant | tool_result (top-level, NOT nested inside user)
   Each line also carries: uuid, parentUuid, timestamp, sessionId, cwd, version

Auto-detection: if ≥ 3 of the first 10 lines contain both "uuid" and "timestamp"
keys → transcript format; otherwise → stream-json format.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import streamlit as st

from trace_viz.models import ParseResult, ResultInfo, SessionInfo, ToolCall, Turn
from trace_viz.utils import count_tokens, load_ndjson, to_str


@st.cache_data(show_spinner=False)
def parse(content: bytes) -> ParseResult:
    """Parse Claude Code NDJSON bytes, auto-detecting format."""
    raw_events = load_ndjson(content)
    if not raw_events:
        return ParseResult.empty("claude_code")

    # ── Format detection ───────────────────────────────────────
    transcript_hits = sum(
        1 for e in raw_events[:10]
        if "uuid" in e and "timestamp" in e
    )
    if transcript_hits >= 3:
        return _parse_transcript(raw_events)
    return _parse_stream_json(raw_events)


# ── Shared NDJSON loader ───────────────────────────────────────

# ══════════════════════════════════════════════════════════════
# FORMAT 1 — stream-json  (produced by -p / --print)
# ══════════════════════════════════════════════════════════════

def _parse_stream_json(raw_events: list[dict]) -> ParseResult:
    session_info = _sj_session_info(raw_events)
    result_info  = _sj_result_info(raw_events)

    tool_map: dict[str, dict] = {}
    turns: list[Turn] = []
    _sj_collect_assistant(raw_events, turns, tool_map)
    _sj_match_tool_results(raw_events, tool_map)
    tool_calls = _sj_flatten_tool_calls(raw_events, tool_map)

    return ParseResult(
        source="claude_code",
        raw_events=raw_events,
        session_info=session_info,
        result_info=result_info,
        turns=turns,
        tool_calls=tool_calls,
        parse_debug={"format": "stream-json"},
    )


def _sj_session_info(events: list[dict]) -> SessionInfo:
    for evt in events:
        if evt.get("type") == "system":
            return SessionInfo(
                model=evt.get("model", ""),
                session_id=evt.get("session_id", ""),
                permission_mode=evt.get("permissionMode", ""),
                tools_available=[
                    (t.get("name", str(t)) if isinstance(t, dict) else str(t))
                    for t in evt.get("tools", [])
                ],
            )
    return SessionInfo()


def _sj_result_info(events: list[dict]) -> ResultInfo:
    for evt in events:
        if evt.get("type") == "result":
            usage = evt.get("usage", {})
            return ResultInfo(
                duration_ms=evt.get("duration_ms", 0) or 0,
                duration_api_ms=evt.get("duration_api_ms", 0) or 0,
                num_turns=evt.get("num_turns", 0) or 0,
                total_cost_usd=evt.get("total_cost_usd") or 0.0,
                is_error=bool(evt.get("is_error", False)),
                result_text=evt.get("result", ""),
                total_input=usage.get("input_tokens", 0) or 0,
                total_output=usage.get("output_tokens", 0) or 0,
                total_cache_creation=usage.get("cache_creation_input_tokens", 0) or 0,
                total_cache_read=usage.get("cache_read_input_tokens", 0) or 0,
            )
    return ResultInfo()


def _sj_collect_assistant(
    events: list[dict],
    turns: list[Turn],
    tool_map: dict[str, dict],
) -> None:
    for evt in events:
        if evt.get("type") != "assistant":
            continue
        msg   = evt.get("message", {})
        usage = msg.get("usage", {})
        turn_no = len(turns) + 1
        text_parts, tool_count = [], 0

        raw_content = msg.get("content", [])
        if isinstance(raw_content, str):
            raw_content = [{"type": "text", "text": raw_content}]
        for block in raw_content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                tool_count += 1
                tid = block.get("id", "")
                tool_map[tid] = {
                    "id": tid, "name": block.get("name", ""),
                    "input": block.get("input") or {}, "turn_no": turn_no,
                    "call_idx": len(tool_map), "output": None, "is_error": False,
                    "ts_start": None, "ts_end": None,
                }

        turns.append(Turn(
            turn_no=turn_no,
            input_tokens=usage.get("input_tokens", 0) or 0,
            output_tokens=usage.get("output_tokens", 0) or 0,
            cache_read=usage.get("cache_read_input_tokens", 0) or 0,
            cache_creation=usage.get("cache_creation_input_tokens", 0) or 0,
            stop_reason=msg.get("stop_reason", ""),
            text_content="\n".join(text_parts),
            tool_count=tool_count,
            model=msg.get("model", ""),
        ))


def _sj_match_tool_results(
    events: list[dict], tool_map: dict[str, dict]
) -> None:
    for evt in events:
        if evt.get("type") != "user":
            continue
        for block in evt.get("message", {}).get("content", []):
            if block.get("type") != "tool_result":
                continue
            tid = block.get("tool_use_id", "")
            if tid not in tool_map:
                continue
            content = block.get("content", "")
            if isinstance(content, list):
                content = "\n".join(
                    (c.get("text", str(c)) if isinstance(c, dict) else str(c))
                    for c in content
                )
            tool_map[tid]["output"]   = content
            tool_map[tid]["is_error"] = bool(block.get("is_error", False))


def _sj_flatten_tool_calls(
    events: list[dict], tool_map: dict[str, dict]
) -> list[ToolCall]:
    calls, seen = [], set()
    for evt in events:
        if evt.get("type") != "assistant":
            continue
        for block in evt.get("message", {}).get("content", []):
            if block.get("type") != "tool_use":
                continue
            tid = block.get("id", "")
            if tid in seen or tid not in tool_map:
                continue
            seen.add(tid)
            tc   = tool_map[tid]
            text = to_str(tc.get("output") or "")
            calls.append(ToolCall(
                name=tc["name"], input=tc["input"], output=text,
                is_error=tc["is_error"], turn_no=tc["turn_no"],
                call_idx=tc["call_idx"],
                tiktoken_tokens=count_tokens(text),
                output_chars=len(text),
            ))
    return calls


# ══════════════════════════════════════════════════════════════
# FORMAT 2 — transcript JSONL  (~/.claude/projects/*/*.jsonl)
# ══════════════════════════════════════════════════════════════

def _parse_transcript(raw_events: list[dict]) -> ParseResult:
    """Parse the persistent JSONL transcripts saved by interactive sessions."""

    # ── Session metadata from any event ───────────────────────
    session_id = next((e.get("sessionId", "") for e in raw_events if e.get("sessionId")), "")
    cwd        = next((e.get("cwd",       "") for e in raw_events if e.get("cwd")),       "")
    version    = next((e.get("version",   "") for e in raw_events if e.get("version")),   "")

    tool_map: dict[str, dict] = {}   # tool_use id → record
    turns:      list[Turn]     = []
    model = ""

    # ── Pass 1: assistant messages → turns + tool_use entries ─
    for evt in raw_events:
        if evt.get("type") != "assistant":
            continue
        msg = evt.get("message", {})
        if not isinstance(msg, dict):
            continue

        usage    = msg.get("usage", {})
        turn_no  = len(turns) + 1
        if not model:
            model = msg.get("model", "")

        text_parts, tool_count = [], 0
        raw_content = msg.get("content", [])
        # content may be a plain string, a list of dicts, or a list of strings
        if isinstance(raw_content, str):
            raw_content = [{"type": "text", "text": raw_content}]
        for block in raw_content:
            if isinstance(block, str):
                text_parts.append(block)
                continue
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype == "text":
                text_parts.append(block.get("text", ""))
            elif btype == "tool_use":
                tool_count += 1
                tid = block.get("id", "")
                tool_map[tid] = {
                    "id":        tid,
                    "name":      block.get("name", ""),
                    "input":     block.get("input") or {},
                    "turn_no":   turn_no,
                    "call_idx":  len(tool_map),
                    "output":    None,
                    "is_error":  False,
                    # timestamps from the wrapping event
                    "ts_start":  evt.get("timestamp"),
                    "ts_end":    None,
                }

        turns.append(Turn(
            turn_no=turn_no,
            input_tokens=usage.get("input_tokens", 0) or 0,
            output_tokens=usage.get("output_tokens", 0) or 0,
            cache_read=usage.get("cache_read_input_tokens", 0) or 0,
            cache_creation=usage.get("cache_creation_input_tokens", 0) or 0,
            stop_reason=msg.get("stop_reason", ""),
            text_content="\n".join(text_parts),
            tool_count=tool_count,
            model=msg.get("model", ""),
        ))

    # ── Pass 2: tool_result blocks nested inside user messages ──
    # Transcript JSONL uses the same structure as stream-json:
    # tool results are wrapped inside type:"user" message.content blocks.
    # The "tool_use_id" key may be snake_case or camelCase depending on version.
    for evt in raw_events:
        if evt.get("type") != "user":
            continue
        evt_ts = evt.get("timestamp")  # timestamp for this tool result delivery
        msg    = evt.get("message") or {}
        if not isinstance(msg, dict):
            continue
        raw_content = msg.get("content", [])
        if isinstance(raw_content, str):
            continue
        for block in raw_content:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_result":
                continue
            # Support both naming conventions
            tid = (block.get("tool_use_id")
                   or block.get("toolUseId")
                   or "")
            if tid not in tool_map:
                continue
            raw = block.get("content", "")
            if isinstance(raw, list):
                raw = "\n".join(
                    (c.get("text", str(c)) if isinstance(c, dict) else str(c))
                    for c in raw
                )
            tool_map[tid]["output"]   = to_str(raw)
            tool_map[tid]["is_error"] = bool(block.get("is_error", False))
            tool_map[tid]["ts_end"]   = evt_ts

    # ── Flatten tool calls in stream order ─────────────────────
    tool_calls, seen = [], set()
    for evt in raw_events:
        if evt.get("type") != "assistant":
            continue
        for block in evt.get("message", {}).get("content", []):
            if block.get("type") != "tool_use":
                continue
            tid = block.get("id", "")
            if tid in seen or tid not in tool_map:
                continue
            seen.add(tid)
            tc   = tool_map[tid]
            text = to_str(tc.get("output") or "")
            tool_calls.append(ToolCall(
                name=tc["name"], input=tc["input"], output=text,
                is_error=tc["is_error"], turn_no=tc["turn_no"],
                call_idx=tc["call_idx"],
                tiktoken_tokens=count_tokens(text),
                output_chars=len(text),
                duration_ms=_ts_delta_ms(tc.get("ts_start"), tc.get("ts_end")),
            ))

    # ── Result info ────────────────────────────────────────────
    result_info = ResultInfo(num_turns=len(turns))
    if turns:
        # transcript 模式下每次 assistant event 的 usage 字段是当次调用的实际值，
        # 并非累积量；这里对所有 turn 求和以反映 session 总用量
        result_info.total_input  = sum(t.input_tokens for t in turns)
        result_info.total_output = sum(t.output_tokens for t in turns)
        result_info.total_cache_read     = sum(t.cache_read for t in turns)
        result_info.total_cache_creation = sum(t.cache_creation for t in turns)

    timestamps = [e.get("timestamp") for e in raw_events if e.get("timestamp")]
    if len(timestamps) >= 2:
        result_info.duration_ms = int(
            _ts_delta_ms(timestamps[0], timestamps[-1])
        )

    session_info = SessionInfo(
        model=model,
        session_id=session_id,
        title=cwd,          # repurpose title to show the working directory
        tools_available=[],
    )

    return ParseResult(
        source="claude_code",
        raw_events=raw_events,
        session_info=session_info,
        result_info=result_info,
        turns=turns,
        tool_calls=tool_calls,
        parse_debug={"format": "transcript", "cwd": cwd, "version": version},
    )


# ── Helper ─────────────────────────────────────────────────────

def _ts_delta_ms(ts_start: str | None, ts_end: str | None) -> float:
    """Return millisecond delta between two ISO-8601 timestamp strings."""
    if not ts_start or not ts_end:
        return 0.0
    try:
        t1 = datetime.fromisoformat(ts_start.replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(ts_end.replace("Z", "+00:00"))
        return max(0.0, (t2 - t1).total_seconds() * 1000)
    except Exception:
        return 0.0
