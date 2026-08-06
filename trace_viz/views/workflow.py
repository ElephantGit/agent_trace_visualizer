"""工作流视图 — 以抽象的 agent 派发树展示会话结构，替代事件级回放。

提供：
- build_workflow(result) → WorkflowNode | None   从 ParseResult 构建工作流树
- render_workflow(root)                          渲染 Mermaid 流程图 + 摘要卡片
"""

from __future__ import annotations

import html as html_mod
import json
from pathlib import Path
from typing import Any

import streamlit as st

from trace_viz.models import ParseResult, WorkflowNode
from trace_viz.utils import to_str

# ── Trace 文件路径 ──────────────────────────────────────────────

_OC_TRACE_DIR = Path.home() / ".local" / "share" / "opencode" / "trace"

# ── 状态颜色映射 ────────────────────────────────────────────────

_STATE_COLORS: dict[str, dict[str, str]] = {
    "completed": {"bg": "#f0fdf4", "border": "#22c55e", "text": "#166534", "icon": "✅", "label": "已完成"},
    "failed":    {"bg": "#fef2f2", "border": "#f87171", "text": "#991b1b", "icon": "❌", "label": "失败"},
    "error":     {"bg": "#fef2f2", "border": "#f87171", "text": "#991b1b", "icon": "❌", "label": "出错"},
    "running":   {"bg": "#fffbeb", "border": "#fbbf24", "text": "#92400e", "icon": "⏳", "label": "进行中"},
    "unknown":   {"bg": "#f8fafc", "border": "#94a3b8", "text": "#475569", "icon": "❓", "label": "未知"},
}

# Mermaid 节点颜色
_MERMAID_FILL: dict[str, str] = {
    "completed": "#dcfce7",
    "failed":    "#fecaca",
    "error":     "#fecaca",
    "running":   "#fef3c7",
    "unknown":   "#e2e8f0",
}
_MERMAID_STROKE: dict[str, str] = {
    "completed": "#22c55e",
    "failed":    "#f87171",
    "error":     "#f87171",
    "running":   "#fbbf24",
    "unknown":   "#94a3b8",
}
_MERMAID_TEXT: dict[str, str] = {
    "completed": "#166534",
    "failed":    "#991b1b",
    "error":     "#991b1b",
    "running":   "#92400e",
    "unknown":   "#475569",
}

# Agent 名称 → 图标映射
_AGENT_ICONS: dict[str, str] = {
    "explore": "🔍",
    "plan": "📐",
    "general-purpose": "🤖",
    "claude": "🧠",
    "code-reviewer": "🔎",
}


def _agent_icon(name: str) -> str:
    """根据 agent 名称返回合适的图标。"""
    name_lower = name.lower()
    for key, icon in _AGENT_ICONS.items():
        if key in name_lower:
            return icon
    return "🤖"


# ══════════════════════════════════════════════════════════════════
# 工作流构建
# ══════════════════════════════════════════════════════════════════

def build_workflow(result: ParseResult) -> WorkflowNode | None:
    """从 ParseResult 构建工作流树。无 subagent 活动时返回 None。"""
    if not result.raw_events:
        return None

    if result.source == "opencode":
        return _build_opencode(result)
    elif result.source == "claude_code":
        return _build_claude_code(result)
    return None


def _build_opencode(result: ParseResult) -> WorkflowNode:
    """从 Opencode ParseResult 构建工作流树，递归加载子 session trace。"""
    si = result.session_info

    # ── Root 节点 ───────────────────────────────────────────
    root = WorkflowNode(
        id=si.session_id or "root",
        name=si.title or si.model or "主 Agent",
        description="主会话",
        state="completed",
        parent_id=None,
        global_step=0,
        duration_ms=result.result_info.duration_ms,
        tool_count=len(result.tool_calls),
        input_tokens=result.result_info.total_input,
        output_tokens=result.result_info.total_output,
        is_root=True,
    )

    # ── 递归挂载子节点 ──────────────────────────────────────
    for sub in result.subagents:
        child = _build_subagent_node(sub)
        if child is not None:
            root.children.append(child)
            # 递归加载二级子节点（深度限制 3）
            _load_child_worktree(child, depth=1, max_depth=3)

    return root


def _build_subagent_node(sub: dict) -> WorkflowNode | None:
    """从 subagent dict 构建单个 WorkflowNode。"""
    child_id = sub.get("childSessionID", "")
    name = sub.get("agentName", "") or "unnamed"
    state = sub.get("state", "unknown")
    description = sub.get("description", "") or ""
    step = sub.get("globalStep", 0)
    dur = sub.get("dispatchDurationMs")

    return WorkflowNode(
        id=child_id or f"sub_{step}_{name}",
        name=name,
        description=description,
        state=state,
        parent_id=None,  # 由调用方设置
        global_step=step,
        duration_ms=int(dur) if dur is not None else None,
    )


def _load_child_worktree(node: WorkflowNode, depth: int, max_depth: int) -> None:
    """递归加载子 agent 的 trace 文件并填充其 children。"""
    if depth >= max_depth or not node.id or not node.id.startswith("ses_"):
        return

    child_path = _OC_TRACE_DIR / f"{node.id}.ndjson"
    if not child_path.is_file():
        return

    try:
        from trace_viz.parsers.opencode import parse
        child_result = parse(child_path.read_bytes())
    except Exception:
        return

    # 用子 session 的数据补充当前节点
    if not node.tool_count:
        node.tool_count = len(child_result.tool_calls)
    if not node.input_tokens:
        node.input_tokens = child_result.result_info.total_input
    if not node.output_tokens:
        node.output_tokens = child_result.result_info.total_output
    if node.duration_ms is None:
        node.duration_ms = child_result.result_info.duration_ms

    # 递归填充子节点的子节点
    for sub in child_result.subagents:
        child = _build_subagent_node(sub)
        if child is not None:
            child.parent_id = node.id
            node.children.append(child)
            _load_child_worktree(child, depth=depth + 1, max_depth=max_depth)


def _build_claude_code(result: ParseResult) -> WorkflowNode:
    """从 Claude Code ParseResult 构建工作流树。"""
    si = result.session_info
    cwd = result.parse_debug.get("cwd", "") if result.parse_debug else ""

    root = WorkflowNode(
        id=si.session_id or "root",
        name=cwd or si.model or "Claude Code",
        description="主会话",
        state="completed" if not result.result_info.is_error else "error",
        parent_id=None,
        global_step=0,
        duration_ms=result.result_info.duration_ms,
        tool_count=len(result.tool_calls),
        input_tokens=result.result_info.total_input,
        output_tokens=result.result_info.total_output,
        is_root=True,
    )

    # Claude Code 的 subagent 信息由 parser 提取并存放在 result.subagents
    for sub in result.subagents:
        child = _build_subagent_node(sub)
        if child is not None:
            child.parent_id = root.id
            root.children.append(child)

    return root


# ══════════════════════════════════════════════════════════════════
# 工作流渲染
# ══════════════════════════════════════════════════════════════════

def render_workflow(root: WorkflowNode) -> None:
    """渲染完整的工作流视图。"""
    all_nodes = _flatten_tree(root)

    # 统计
    total_subs = len([n for n in all_nodes if not n.is_root])
    completed = len([n for n in all_nodes if n.state == "completed"])
    failed = len([n for n in all_nodes if n.state in ("failed", "error")])
    running = len([n for n in all_nodes if n.state == "running"])

    # ── 概览指标 ────────────────────────────────────────────
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Agent 总数", len(all_nodes))
    c2.metric("Subagent 数", total_subs)
    c3.metric("✅ 已完成", completed)
    c4.metric("❌ 失败 / ❓ 未知", failed + running)

    st.markdown("---")

    # ── Mermaid 流程图 ──────────────────────────────────────
    if len(all_nodes) >= 2:
        _render_flowchart(root, all_nodes)
        st.markdown("---")

    # ── Agent 摘要卡片 ──────────────────────────────────────
    _render_agent_cards(root, all_nodes)


# ── Mermaid 流程图 ──────────────────────────────────────────────

def _render_flowchart(root: WorkflowNode, all_nodes: list[WorkflowNode]) -> None:
    """渲染 Mermaid flowchart 展示 agent 派发树。"""
    from trace_viz.config import MERMAID_CDN
    from trace_viz.views.shared import mermaid_controls, render_mermaid

    st.subheader("🔀 Agent 工作流图")

    max_ev, theme, row_h = mermaid_controls(key_prefix="wf_seq")

    # 构建 Mermaid flowchart
    lines = ["flowchart TD"]
    node_ids: dict[str, str] = {}  # node.id → mermaid_id

    for i, node in enumerate(all_nodes):
        mid = f"N{i}"
        node_ids[node.id] = mid

        icon = _agent_icon(node.name)
        state_info = _STATE_COLORS.get(node.state, _STATE_COLORS["unknown"])
        label = node.name or "unnamed"
        desc = node.description[:60] if node.description else ""
        dur_str = f"{node.duration_ms / 1000:.1f}s" if node.duration_ms else ""
        tok_str = ""
        if node.input_tokens or node.output_tokens:
            tok_str = f"in:{_fmt_tok(node.input_tokens)} out:{_fmt_tok(node.output_tokens)}"

        # 构建节点标签（多行）
        parts = [f"{icon} {html_mod.escape(label)}"]
        if desc:
            parts.append(f"{html_mod.escape(desc)}")
        status_line = f"{state_info['icon']} {state_info['label']}"
        if dur_str:
            status_line += f" · {dur_str}"
        parts.append(status_line)
        if tok_str:
            parts.append(tok_str)

        node_label = "<br/>".join(parts)

        fill = _MERMAID_FILL.get(node.state, _MERMAID_FILL["unknown"])
        stroke = _MERMAID_STROKE.get(node.state, _MERMAID_STROKE["unknown"])
        text_color = _MERMAID_TEXT.get(node.state, _MERMAID_TEXT["unknown"])

        if node.is_root:
            lines.append(
                f'    {mid}["{node_label}"]'
                f':::{mid}Style'
            )
        else:
            lines.append(
                f'    {mid}["{node_label}"]'
                f':::{mid}Style'
            )

        # Style definition
        lines.append(
            f"    classDef {mid}Style "
            f"fill:{fill},stroke:{stroke},color:{text_color},"
            f"stroke-width:2px,rx:8,ry:8"
        )

    # 边：parent → child
    for node in all_nodes:
        if node.parent_id and node.parent_id in node_ids:
            mid = node_ids[node.id]
            pid = node_ids[node.parent_id]
            step_label = f"Step {node.global_step}" if node.global_step else ""
            if step_label:
                lines.append(f'    {pid} -->|"{step_label}"| {mid}')
            else:
                lines.append(f"    {pid} --> {mid}")

    src = "\n".join(lines)
    render_mermaid(src, theme=theme, row_height=row_h, event_count=len(all_nodes))

    with st.expander("复制 Mermaid 源码"):
        st.code(src, language="text")


# ── Agent 摘要卡片 ──────────────────────────────────────────────

def _render_agent_cards(root: WorkflowNode, all_nodes: list[WorkflowNode]) -> None:
    """渲染每个 agent 的摘要卡片，嵌套缩进表达层级。"""
    st.subheader("📋 Agent 详情")

    # 计算每层的缩进
    html_parts: list[str] = []
    _render_node_card(root, depth=0, html_parts=html_parts)

    if html_parts:
        full_html = "\n".join(html_parts)
        st.markdown(full_html, unsafe_allow_html=True)


def _render_node_card(node: WorkflowNode, depth: int, html_parts: list[str]) -> None:
    """递归渲染一个 WorkflowNode 的摘要卡片。"""
    state_info = _STATE_COLORS.get(node.state, _STATE_COLORS["unknown"])
    icon = _agent_icon(node.name)
    indent_px = depth * 28

    # ── 指标行文字 ──────────────────────────────────────────
    meta_parts = []
    if node.global_step:
        meta_parts.append(f"📍 Step {node.global_step}")
    if node.duration_ms is not None:
        ms = node.duration_ms
        meta_parts.append(f'⏱️ {ms / 1000:.1f}s' if ms >= 1000 else f'⏱️ {ms:.0f}ms')
    if node.tool_count:
        meta_parts.append(f"🔨 {node.tool_count} 次工具调用")
    if node.input_tokens or node.output_tokens:
        meta_parts.append(f"🎯 in:{_fmt_tok(node.input_tokens)} out:{_fmt_tok(node.output_tokens)}")
    if node.children:
        meta_parts.append(f"👶 {len(node.children)} 个子 agent")

    meta_str = " &nbsp;·&nbsp; ".join(meta_parts) if meta_parts else ""

    # ── 角色标签 ────────────────────────────────────────────
    role_badge = ""
    if node.is_root:
        role_badge = (
            '<span style="display:inline-block;background:#1e40af;color:#fff;'
            'padding:1px 8px;border-radius:4px;font-size:0.7em;font-weight:700;'
            'letter-spacing:0.5px;margin-left:8px;vertical-align:middle;">🏠 ROOT</span>'
        )

    # ── 状态徽章 ────────────────────────────────────────────
    state_badge = (
        f'<span style="display:inline-block;background:{state_info["border"]};'
        f'color:#fff;padding:1px 8px;border-radius:4px;'
        f'font-size:0.7em;font-weight:700;letter-spacing:0.5px;'
        f'margin-left:6px;vertical-align:middle;">'
        f'{state_info["icon"]} {state_info["label"].upper()}'
        f'</span>'
    )

    name_escaped = html_mod.escape(node.name or "unnamed")

    # ── 构建卡片 ────────────────────────────────────────────
    card = (
        f'<details open style="'
        f'background:{state_info["bg"]};'
        f'border:1px solid {state_info["border"]}30;'
        f'border-left:4px solid {state_info["border"]};'
        f'border-radius:8px;'
        f'margin:6px 0 6px {indent_px}px;'
        f'overflow:hidden;'
        f'">'
        f'<summary style="'
        f'background:{state_info["bg"]};'
        f'color:{state_info["text"]};'
        f'padding:10px 16px;'
        f'cursor:pointer;'
        f'font-weight:600;'
        f'font-size:0.92em;'
        f'user-select:none;'
        f'display:flex;'
        f'align-items:center;'
        f'flex-wrap:wrap;'
        f'gap:4px;'
        f'">'
        f'<span style="font-size:1.1em;margin-right:4px;">{icon}</span>'
        f'<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
        f'{name_escaped}</span>'
        f'{role_badge}'
        f'{state_badge}'
        f'</summary>'
        f'<div style="padding:12px 16px;">'
    )

    # 描述
    if node.description:
        desc_escaped = html_mod.escape(node.description)
        card += (
            f'<div style="color:#475569;font-size:0.85em;margin-bottom:8px;'
            f'line-height:1.5;">📝 {desc_escaped}</div>'
        )

    # 指标行
    if meta_str:
        card += (
            f'<div style="font-size:0.78em;color:#64748b;margin-bottom:8px;">'
            f'{meta_str}'
            f'</div>'
        )

    # Session ID
    if node.id and node.id != "root":
        id_short = node.id[:24] + "…" if len(node.id) > 24 else node.id
        card += (
            f'<div style="font-size:0.72em;color:#94a3b8;margin-bottom:4px;">'
            f'🆔 {html_mod.escape(id_short)}'
            f'</div>'
        )

    # Token 占比条（仅对非 root 节点有意义）
    if not node.is_root and node.output_tokens > 0:
        # 用 output_tokens 画一个小型条形图（纯 CSS）
        max_tok = max(n.output_tokens for n in [node] + node.children) or 1
        pct = min(100, node.output_tokens / max_tok * 100) if max_tok else 0
        card += (
            f'<div style="margin-top:6px;">'
            f'<span style="font-size:0.72em;color:#94a3b8;">Output Tokens: {_fmt_tok(node.output_tokens)}</span>'
            f'<div style="background:#e2e8f0;border-radius:4px;height:6px;margin-top:2px;">'
            f'<div style="background:{state_info["border"]};width:{pct}%;height:100%;border-radius:4px;"></div>'
            f'</div>'
            f'</div>'
        )

    card += '</div></details>'

    html_parts.append(card)

    # 递归渲染子节点
    for child in node.children:
        _render_node_card(child, depth=depth + 1, html_parts=html_parts)


# ── 辅助函数 ────────────────────────────────────────────────────

def _flatten_tree(node: WorkflowNode) -> list[WorkflowNode]:
    """深度优先遍历，返回所有节点的平铺列表（root 在前）。"""
    nodes = [node]
    for child in node.children:
        nodes.extend(_flatten_tree(child))
    return nodes


def _fmt_tok(n: int) -> str:
    """格式化 token 数：10123 → 10.1K。"""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)
