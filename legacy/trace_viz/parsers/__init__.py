"""Parser sub-package — each module exposes a single `parse(content: bytes)` function."""

from trace_viz.parsers.claude_code import parse as parse_claude_code
from trace_viz.parsers.gemini import parse as parse_gemini
from trace_viz.parsers.opencode import parse as parse_opencode

__all__ = ["parse_opencode", "parse_gemini", "parse_claude_code"]
