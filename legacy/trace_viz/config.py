"""Application-wide constants, color palettes, and UI settings."""

from __future__ import annotations

# ── UI constants ───────────────────────────────────────────────
PAGE_SIZE: int = 50
MAX_MERMAID_EVENTS: int = 60
MERMAID_CDN: str = "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"

# ── Shared qualitative palette ─────────────────────────────────
SAFE_PALETTE: list[str] = [
    "#0a9e6a", "#e67e00", "#1a73e8", "#ea4335", "#7c3aed",
    "#14b8a6", "#f97316", "#64748b", "#a855f7", "#34a853",
]

# ── Opencode ───────────────────────────────────────────────────
OC_COLORS: dict[str, str] = {
    "step.start":     "#1a73e8",
    "step.finish":    "#34a853",
    "tool.start":     "#fbbc04",
    "tool.finish":    "#ea4335",
    "text.assistant": "#a855f7",
    "session.start":  "#7c3aed",
    "session.end":    "#14b8a6",
    "text.user":      "#64748b",
}

# ── Gemini CLI ─────────────────────────────────────────────────
GEM_COLORS: dict[str, str] = {
    "工具调用":     "#0a9e6a",
    "工具响应":     "#7dd3b0",
    "API 调用":     "#1a73e8",
    "会话-配置":    "#7c3aed",
    "会话-Prompt":  "#a855f7",
    "会话-Session": "#c084fc",
    "文件操作":     "#e67e00",
    "Agent":        "#d93025",
    "对话轮次":     "#f97316",
    "消息":         "#64748b",
    "响应":         "#0ea5e9",
    "错误":         "#dc2626",
    "计量":         "#a3a3a3",
    "模型":         "#8b5cf6",
    "缓存":         "#14b8a6",
    "其他":         "#888888",
}

GEM_BG: dict[str, str] = {
    "工具调用":     "rgba(10,158,106,0.10)",
    "工具响应":     "rgba(125,211,176,0.15)",
    "API 调用":     "rgba(26,115,232,0.10)",
    "会话-配置":    "rgba(124,58,237,0.10)",
    "会话-Prompt":  "rgba(168,85,247,0.10)",
    "会话-Session": "rgba(192,132,252,0.10)",
    "文件操作":     "rgba(230,126,0,0.10)",
    "Agent":        "rgba(217,48,37,0.10)",
    "对话轮次":     "rgba(249,115,22,0.10)",
    "消息":         "rgba(100,116,139,0.10)",
    "响应":         "rgba(14,165,233,0.10)",
    "错误":         "rgba(220,38,38,0.12)",
    "计量":         "rgba(163,163,163,0.08)",
    "模型":         "rgba(139,92,246,0.10)",
    "缓存":         "rgba(20,184,166,0.10)",
    "其他":         "rgba(136,136,136,0.08)",
}

GEM_BORDER: dict[str, str] = dict(GEM_COLORS)  # same as fill color

# ── Claude Code ────────────────────────────────────────────────
CC_COLORS: dict[str, str] = {
    "text":        "#1a73e8",
    "tool_use":    "#fbbc04",
    "tool_result": "#34a853",
    "system":      "#7c3aed",
    "result":      "#14b8a6",
    "error":       "#ea4335",
}
