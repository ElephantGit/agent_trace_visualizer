"""View sub-package — each module exposes a single `render()` function."""

from trace_viz.views import claude_code, gemini, opencode

__all__ = ["opencode", "gemini", "claude_code"]
