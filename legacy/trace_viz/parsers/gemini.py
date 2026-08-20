"""Parser for Gemini CLI telemetry.log files.

The format is concatenated JSON objects (not NDJSON) — `split_json_objects`
handles the brace-depth parsing required to separate them.
"""

from __future__ import annotations

import json
from typing import Any

import streamlit as st

from trace_viz.models import ParseResult, ResultInfo, SessionInfo, ToolCall, Turn
from trace_viz.utils import count_tokens, decode_bytes, to_str


@st.cache_data(show_spinner=False)
def parse(content: bytes) -> ParseResult:
    """Parse Gemini CLI telemetry bytes and return a structured ParseResult."""
    text = decode_bytes(content)
    if text is None:
        return ParseResult.empty("gemini")

    debug: dict[str, Any] = {
        "text_len": len(text),
        "first_200": text[:200],
    }

    chunks = _split_json_objects(text)
    debug["chunks_found"] = len(chunks)

    if chunks:
        debug["chunk0_preview"] = chunks[0][:300]
        debug["chunk0_tail"] = chunks[0][-100:]
        try:
            json.loads(chunks[0])
            debug["chunk0_parse"] = "OK"
        except json.JSONDecodeError as e:
            debug["chunk0_parse"] = f"FAIL: {e}"
            debug["chunk0_error_context"] = chunks[0][max(0, e.pos - 50): e.pos + 50]

    raw_events: list[dict] = []
    errors = 0
    for chunk in chunks:
        evt = _parse_event(chunk)
        if evt:
            raw_events.append(evt)
        else:
            errors += 1

    debug["rows_ok"] = len(raw_events)
    debug["rows_err"] = errors

    if not raw_events:
        return ParseResult(
            source="gemini", raw_events=[], session_info=SessionInfo(),
            result_info=ResultInfo(), turns=[], tool_calls=[],
            parse_errors=errors, parse_debug=debug,
        )

    turns, tool_calls = _extract_turns_and_tools(raw_events)
    result_info = _build_result_info(raw_events)

    models = list({
        str(e.get("model", "")) for e in raw_events if e.get("model")
    })
    session_info = SessionInfo(model=models[0] if models else "")

    return ParseResult(
        source="gemini",
        raw_events=raw_events,
        session_info=session_info,
        result_info=result_info,
        turns=turns,
        tool_calls=tool_calls,
        parse_errors=errors,
        parse_debug=debug,
    )


# ── Event splitting ────────────────────────────────────────────

def _split_json_objects(text: str) -> list[str]:
    """Split a string of concatenated JSON objects by tracking brace depth."""
    chunks: list[str] = []
    buf: list[str] = []
    depth = 0
    in_str = False
    escape = False

    for ch in text:
        buf.append(ch)
        if escape:
            escape = False
            continue
        if ch == "\\" and in_str:
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and buf:
                chunks.append("".join(buf).strip())
                buf = []

    return chunks


# ── Single-event parsing ───────────────────────────────────────

def _parse_event(chunk: str) -> dict[str, Any] | None:
    try:
        obj = json.loads(chunk)
    except Exception:
        return None

    attrs = obj.get("attributes", {})
    name = attrs.get("event.name") or obj.get("name", "billing")
    ts = attrs.get("event.timestamp", "")
    clean_attrs = {k: v for k, v in attrs.items() if k not in ("event.name", "event.timestamp")}

    fn_response_tokens, tool_name = _extract_tool_response(attrs)

    return {
        "timestamp":          ts,
        "event_name":         name,
        "category":           _categorize(name),
        "body":               str(obj.get("_body", "")),
        "model":              str(attrs.get("model", "")),
        "tool_name":          str(attrs.get("tool_name", "") or tool_name or attrs.get("gen_ai.tool.name", "")),
        "function_name":      str(attrs.get("function_name", "") or tool_name or attrs.get("gen_ai.tool.name", "")),
        "file_path":          str(attrs.get("file_path") or attrs.get("path", "")),
        "duration_ms":        attrs.get("duration_ms"),
        "input_tokens":       (attrs.get("input_tokens") or attrs.get("gen_ai.usage.input_tokens") or attrs.get("prompt_tokens")),
        "output_tokens":      (attrs.get("output_tokens") or attrs.get("gen_ai.usage.output_tokens") or attrs.get("completion_tokens")),
        "fn_response_tokens": (
            fn_response_tokens
            or attrs.get("function_response_tokens")
            or attrs.get("response_tokens")
            or attrs.get("gen_ai.tool.response_tokens")
            or attrs.get("tool_response_tokens")
        ),
        "_token_attrs": json.dumps(
            {k: v for k, v in attrs.items() if "token" in k.lower() or "response" in k.lower()},
            ensure_ascii=False,
        ),
        "session_id":   str(attrs.get("session_id", "")),
        "status":       str(attrs.get("status") or attrs.get("success") or ""),
        "attrs_json":   json.dumps(clean_attrs, ensure_ascii=False),
    }


def _extract_tool_response(attrs: dict) -> tuple[Any, str | None]:
    """Extract fn_response_tokens and tool_name from gen_ai.output.messages if present."""
    raw = attrs.get("gen_ai.output.messages")
    if not raw or not isinstance(raw, str):
        return None, None

    try:
        messages = json.loads(raw)
    except Exception:
        return None, None

    if isinstance(messages, dict):
        tool_name = messages.get("tool", {}).get("name")
        response_obj = messages.get("response", {}) or {}
        tokens = response_obj.get("contentLength") or (
            len(response_obj["content"]) if isinstance(response_obj.get("content"), str) else None
        )
        return tokens, tool_name

    if isinstance(messages, list) and messages:
        first = messages[0]
        resp = first.get("response", {}) or {}
        fn_resp = resp.get("functionResponse", {}) or {}
        tokens = fn_resp.get("response", {}).get("contentLength") or resp.get("contentLength")
        name = fn_resp.get("name")
        return tokens, name

    return None, None


def _categorize(name: str) -> str:
    if not name:
        return "其他"
    if name in ("gemini_cli.tool_call", "gemini_cli.tool_use"):
        return "工具调用"
    if name == "tool_call" or "tool_call" in name or "tool_use" in name:
        return "工具响应"
    if "file_operation" in name:
        return "文件操作"
    if "agent_run"   in name: return "Agent"
    if name.startswith("gen_ai"): return "API 调用"
    if "config"   in name: return "会话-配置"
    if "prompt"   in name: return "会话-Prompt"
    if "session"  in name: return "会话-Session"
    if "turn"     in name: return "对话轮次"
    if "message"  in name: return "消息"
    if "response" in name: return "响应"
    if "error"    in name or "exception" in name: return "错误"
    if "metric"   in name or "billing"   in name or name == "billing": return "计量"
    if "model"    in name: return "模型"
    if "memory"   in name or "cache"     in name: return "缓存"
    return "其他"


# ── Turn & tool extraction ─────────────────────────────────────

def _extract_turns_and_tools(
    raw_events: list[dict],
) -> tuple[list[Turn], list[ToolCall]]:
    import pandas as pd

    df_calls = [e for e in raw_events if e.get("category") == "工具调用"]
    df_resps = [e for e in raw_events if e.get("category") == "工具响应"]

    # Pair tool calls with responses by position
    has_resp_tokens = any(
        e.get("fn_response_tokens") is not None for e in df_calls + df_resps
    )

    tool_calls: list[ToolCall] = []
    for idx, tc in enumerate(df_calls):
        resp = df_resps[idx] if idx < len(df_resps) else {}
        resp_tokens = _safe_int(tc.get("fn_response_tokens") or resp.get("fn_response_tokens"))
        output = to_str(resp.get("body") or resp.get("attrs_json") or "")

        tool_calls.append(ToolCall(
            name=str(tc.get("function_name") or tc.get("tool_name") or ""),
            input={},
            output=output,
            is_error=str(tc.get("status", "")).lower() in ("false", "error"),
            turn_no=idx,
            call_idx=idx,
            tiktoken_tokens=resp_tokens or count_tokens(output),
            output_chars=len(output),
            duration_ms=_safe_float(tc.get("duration_ms")),
            file_path=str(tc.get("file_path") or ""),
            allotted_tokens=resp_tokens or 0,
        ))

    # API calls → turns
    api_events = [e for e in raw_events if e.get("category") == "API 调用"]
    turns: list[Turn] = []
    for idx, e in enumerate(api_events):
        turns.append(Turn(
            turn_no=idx + 1,
            input_tokens=_safe_int(e.get("input_tokens")) or 0,
            output_tokens=_safe_int(e.get("output_tokens")) or 0,
        ))

    return turns, tool_calls


def _build_result_info(raw_events: list[dict]) -> ResultInfo:
    import pandas as pd

    info = ResultInfo()
    api = [e for e in raw_events if e.get("category") == "API 调用"]
    if api:
        info.total_input  = sum(_safe_int(e.get("input_tokens"))  or 0 for e in api)
        info.total_output = sum(_safe_int(e.get("output_tokens")) or 0 for e in api)

    timestamps = []
    for e in raw_events:
        try:
            import pandas as pd
            ts = pd.to_datetime(e["timestamp"], utc=True, errors="coerce")
            if ts is not None and not pd.isna(ts):
                timestamps.append(ts)
        except Exception:
            pass

    if len(timestamps) >= 2:
        info.duration_ms = int((max(timestamps) - min(timestamps)).total_seconds() * 1000)

    return info


def _safe_int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _safe_float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0
