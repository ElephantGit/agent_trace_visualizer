"""Embedded rendering entry point for the Trace Visualizer.

When the dashboard is iframed by Ora, the URL carries `?session_id=<oraSessionId>`
and `?agent_type=<opencode|claude_code>`. Ora has already resolved the Ora session
id to a concrete trace file path and written a small **locator** JSON to the
conventional Ora app-data directory:

    <appDataDir>/dashboard/<oraSessionId>.json   ->  {"traceFilePath": "...", "agentType": "..."}

This module owns the embedded side of that contract: it computes the locator
root by OS convention (mirroring Ora's `app_data_dir`), reads the locator, reads
the trace file bytes, dispatches the matching parser, and hands the
`ParseResult` to the view's body renderer. It is deliberately free of Streamlit
side effects so the locator/parse path is unit-testable without a running app.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from trace_viz.models import ParseResult
from trace_viz.parsers import claude_code as cc_parser
from trace_viz.parsers import opencode as oc_parser

# Mirrors the Ora desktop Tauri identifier so both sides resolve the same
# app-data directory without per-request coordination (decision: the locator
# root is a conventional path, not a URL/env parameter).
ORA_APP_IDENTIFIER = "space.ora.desktop"
LOCATOR_SUBDIR = "dashboard"


# ── Locator root ───────────────────────────────────────────────


def locator_root() -> Path:
    """Returns the conventional directory where Ora writes dashboard locators.

    Mirrors Ora's Tauri `app_data_dir` for the `space.ora.desktop` identifier so
    the dashboard and Ora agree on a path without any URL or env-var handoff.
    Only consulted when embedded (a `session_id` query param is present); the
    standalone/gemini flow never calls this.
    """
    home = Path.home()
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / ORA_APP_IDENTIFIER / LOCATOR_SUBDIR
        # Defensive: APPDATA is effectively always set on Windows; fall back to
        # the Roaming profile under the user home if an exotic environment omits it.
        return home / "AppData" / "Roaming" / ORA_APP_IDENTIFIER / LOCATOR_SUBDIR
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / ORA_APP_IDENTIFIER / LOCATOR_SUBDIR
    # Linux / other POSIX: XDG data home, defaulting to ~/.local/share.
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg and Path(xdg).is_absolute() else home / ".local" / "share"
    return base / ORA_APP_IDENTIFIER / LOCATOR_SUBDIR


# ── Locator + trace loading ───────────────────────────────────


@dataclass(frozen=True)
class Locator:
    """The Ora-written handoff that points the dashboard at a concrete trace file."""

    trace_file_path: str
    agent_type: str


def load_locator(session_id: str, root: Optional[Path] = None) -> Optional[Locator]:
    """Reads and decodes the locator Ora wrote for one Ora session id.

    Returns None when the locator is absent so the caller can surface a friendly
    "trace not ready" state instead of crashing the embedded iframe.
    """
    root = root if root is not None else locator_root()
    locator_path = root / f"{session_id}.json"
    if not locator_path.is_file():
        return None
    try:
        payload = json.loads(locator_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    trace_file_path = payload.get("traceFilePath")
    agent_type = payload.get("agentType")
    if not isinstance(trace_file_path, str) or not isinstance(agent_type, str):
        return None
    return Locator(trace_file_path=trace_file_path, agent_type=agent_type)


def read_trace_bytes(locator: Locator) -> Optional[bytes]:
    """Reads the resolved trace file, returning None when it is not yet on disk."""
    path = Path(locator.trace_file_path)
    if not path.is_file():
        return None
    try:
        return path.read_bytes()
    except OSError:
        return None


# ── Parse dispatch ─────────────────────────────────────────────

# Canonical agent_type -> (parser, view module). agent_type values are the same
# strings Ora normalizes its AgentCli enum into before writing the locator, and
# match the dashboard's existing app_mode dispatch, so no extra mapping is needed.
def _parse_opencode(content: bytes) -> ParseResult:
    return oc_parser.parse(content)


def _parse_claude_code(content: bytes) -> ParseResult:
    return cc_parser.parse(content)


PARSE_DISPATCH: dict[str, Callable[[bytes], ParseResult]] = {
    "opencode": _parse_opencode,
    "claude_code": _parse_claude_code,
}


def parse_for_agent_type(content: bytes, agent_type: str) -> Optional[ParseResult]:
    """Dispatches bytes to the parser for the given canonical agent_type."""
    parser = PARSE_DISPATCH.get(agent_type)
    if parser is None:
        return None
    return parser(content)
