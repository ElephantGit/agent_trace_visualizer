"""工作流视图 — 以抽象的 agent DAG / 派发树展示会话结构，替代事件级回放。

支持两种数据源：
1. ReactFlow JSON（assets/reactflow.json）— 预设计的工作流 DAG
2. Trace 提取（从 ParseResult） — 运行时 subagent 派发树

优先级：ReactFlow JSON > Trace 提取
"""

from __future__ import annotations

import html as html_mod
import json
from pathlib import Path
from typing import Any

import streamlit as st

from trace_viz.models import ParseResult, WorkflowNode
from trace_viz.utils import to_str

# ── 路径常量 ────────────────────────────────────────────────────

_OC_TRACE_DIR = Path.home() / ".local" / "share" / "opencode" / "trace"
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # trace_viz/views → trace_viz → project root
_DEFAULT_REACTFLOW_PATH = _PROJECT_ROOT / "assets" / "reactflow.json"

# ── 状态颜色映射 ────────────────────────────────────────────────

_STATE_COLORS: dict[str, dict[str, str]] = {
    "completed": {"bg": "#f0fdf4", "border": "#22c55e", "text": "#166534", "icon": "✅", "label": "已完成"},
    "failed":    {"bg": "#fef2f2", "border": "#f87171", "text": "#991b1b", "icon": "❌", "label": "失败"},
    "error":     {"bg": "#fef2f2", "border": "#f87171", "text": "#991b1b", "icon": "❌", "label": "出错"},
    "running":   {"bg": "#fffbeb", "border": "#fbbf24", "text": "#92400e", "icon": "⏳", "label": "进行中"},
    "unknown":   {"bg": "#f8fafc", "border": "#94a3b8", "text": "#475569", "icon": "❓", "label": "未知"},
}

# ── DAG 节点颜色（按节点角色）───────────────────────────────────

_DAG_NODE_STYLES: list[dict[str, str]] = [
    # 用不同色调区分节点，循环使用
    {"fill": "#ede9fe", "stroke": "#a78bfa", "text": "#5b21b6"},  # 紫色系
    {"fill": "#dbeafe", "stroke": "#60a5fa", "text": "#1e40af"},  # 蓝色系
    {"fill": "#dcfce7", "stroke": "#22c55e", "text": "#166534"},  # 绿色系
    {"fill": "#fef3c7", "stroke": "#fbbf24", "text": "#92400e"},  # 黄色系
    {"fill": "#ffe4e6", "stroke": "#f43f5e", "text": "#9f1239"},  # 粉色系
    {"fill": "#e0f2fe", "stroke": "#0284c7", "text": "#0c4a6e"},  # 天蓝系
    {"fill": "#f0fdf4", "stroke": "#4ade80", "text": "#14532d"},  # 翠绿系
    {"fill": "#fff7ed", "stroke": "#f97316", "text": "#9a3412"},  # 橙色系
]

# Agent 名称 → 图标映射
_AGENT_ICONS: dict[str, str] = {
    "开始": "🚀",
    "规划": "📐",
    "需求分解": "📋",
    "spec": "📝",
    "explore": "🔍",
    "tdd": "🧪",
    "构建": "📦",
    "门禁": "🚧",
    "commit": "📤",
    "review": "🔎",
    "test": "✅",
}


def _agent_icon(name: str) -> str:
    """根据 agent 名称返回合适的图标。"""
    name_lower = name.lower()
    for key, icon in _AGENT_ICONS.items():
        if key in name_lower:
            return icon
    return "🤖"


# ══════════════════════════════════════════════════════════════════
# ReactFlow JSON → DAG
# ══════════════════════════════════════════════════════════════════

def load_reactflow_json(path: str | Path | None = None) -> dict | None:
    """加载 ReactFlow JSON 文件。默认读取 assets/reactflow.json。"""
    filepath = Path(path) if path else _DEFAULT_REACTFLOW_PATH
    if not filepath.is_file():
        return None
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        if "nodes" in data and "edges" in data:
            return data
        return None
    except Exception:
        return None


def _build_dag_mermaid(data: dict) -> str:
    """从 ReactFlow JSON 数据构建 Mermaid flowchart（LR 布局，适合宽 DAG）。"""
    nodes: list[dict] = data.get("nodes", [])
    edges: list[dict] = data.get("edges", [])

    # 构建 node id → index 映射
    node_index: dict[str, int] = {}
    for i, n in enumerate(nodes):
        node_index[n["id"]] = i

    lines = ["flowchart LR"]

    # 声明节点
    for i, n in enumerate(nodes):
        mid = f"N{i}"
        node_data = n.get("data") or {}
        title = node_data.get("title", n["id"])
        desc = (node_data.get("description") or "")[:40]

        icon = _agent_icon(title)
        parts = [f"{icon} {html_mod.escape(title)}"]
        if desc:
            parts.append(f"<i>{html_mod.escape(desc)}</i>")
        node_label = "<br/>".join(parts)

        style = _DAG_NODE_STYLES[i % len(_DAG_NODE_STYLES)]
        lines.append(f'    {mid}["{node_label}"]:::{mid}Style')
        lines.append(
            f"    classDef {mid}Style "
            f"fill:{style['fill']},stroke:{style['stroke']},color:{style['text']},"
            f"stroke-width:2px,rx:8,ry:8"
        )

    # 声明边
    for e in edges:
        src_id = e["source"]
        tgt_id = e["target"]
        if src_id in node_index and tgt_id in node_index:
            si = node_index[src_id]
            ti = node_index[tgt_id]
            lines.append(f"    N{si} --> N{ti}")

    return "\n".join(lines)




def _build_dag_summary_table(nodes: list[dict], edges: list[dict]) -> None:
    """紧凑的 DAG 节点概览表格。"""
    rows = []
    for n in nodes:
        node_data = n.get("data") or {}
        config = node_data.get("agentConfig") or {}
        title = node_data.get("title", n["id"])
        desc = (node_data.get("description") or "")[:60]

        # 找入边/出边
        incoming = [e for e in edges if e["target"] == n["id"]]
        outgoing = [e for e in edges if e["source"] == n["id"]]

        skills_count = len(config.get("skills") or [])
        mcps_count = len(config.get("mcps") or [])

        rows.append({
            "节点": f"{_agent_icon(title)} {title}",
            "描述": desc,
            "入度": len(incoming),
            "出度": len(outgoing),
            "Skills": skills_count,
            "MCPs": mcps_count,
            "ID": n["id"],
        })

    st.dataframe(rows, hide_index=True, width='stretch',
                 column_config={"ID": None})  # 隐藏 ID 列


# ══════════════════════════════════════════════════════════════════
# 工作流渲染（统一入口）
# ══════════════════════════════════════════════════════════════════

def render_workflow(root: WorkflowNode | None = None, *, reactflow_data: dict | None = None) -> None:
    """渲染工作流视图。ReactFlow JSON 优先，trace 提取树作为 fallback。

    Args:
        root: trace 提取的工作流树（可为 None）
        reactflow_data: 预加载的 ReactFlow JSON 数据（避免重复读文件）
    """
    # ── ReactFlow JSON 优先 ──────────────────────────────────
    rf_data = reactflow_data or load_reactflow_json()
    if rf_data is not None:
        _render_reactflow_workflow(rf_data)
        return

    # ── Fallback: trace 提取的树 ─────────────────────────────
    if root is not None:
        _render_tree_workflow(root)
    else:
        st.info("未找到可渲染的工作流数据。")


# ══════════════════════════════════════════════════════════════════
# ReactFlow DAG 渲染
# ══════════════════════════════════════════════════════════════════

def _render_reactflow_workflow(data: dict) -> None:
    """从 ReactFlow JSON 数据渲染完整的工作流 DAG 视图。"""
    nodes: list[dict] = data.get("nodes", [])
    edges: list[dict] = data.get("edges", [])
    workflow_name = data.get("name", "工作流")
    max_depth = _estimate_dag_depth(nodes, edges)

    # ── 标题 + 指标同行 ──────────────────────────────────────
    c1, c2, c3 = st.columns([2, 1, 1])
    with c1:
        st.markdown(f"### 🔀 {html_mod.escape(workflow_name)}")
    with c2:
        st.metric("Agent 节点", len(nodes))
    with c3:
        st.metric("关键路径深度", max_depth)

    # ── Mermaid 流程图 ──────────────────────────────────────
    _render_dag_flowchart(data)

    # ── 节点选择 + 详情 ─────────────────────────────────────
    st.markdown("---")
    _render_dag_node_details(nodes, edges)


def _estimate_dag_depth(nodes: list[dict], edges: list[dict]) -> int:
    """估算 DAG 的最长路径深度（拓扑排序 + DP）。"""
    if not nodes:
        return 0

    # 构建邻接表和入度
    node_ids = {n["id"] for n in nodes}
    adj: dict[str, list[str]] = {nid: [] for nid in node_ids}
    indeg: dict[str, int] = {nid: 0 for nid in node_ids}

    for e in edges:
        src, tgt = e["source"], e["target"]
        if src in node_ids and tgt in node_ids:
            adj[src].append(tgt)
            indeg[tgt] += 1

    # 拓扑排序 + 最长路径
    depth: dict[str, int] = {}
    queue = [nid for nid in node_ids if indeg[nid] == 0]
    for nid in queue:
        depth[nid] = 1

    while queue:
        u = queue.pop(0)
        for v in adj[u]:
            indeg[v] -= 1
            depth[v] = max(depth.get(v, 0), depth[u] + 1)
            if indeg[v] == 0:
                queue.append(v)

    return max(depth.values()) if depth else max(len(nodes), 1)


def _render_dag_flowchart(data: dict) -> None:
    """渲染 DAG 的 Mermaid 流程图。"""
    from trace_viz.views.shared import render_mermaid

    src = _build_dag_mermaid(data)
    render_mermaid(src, event_count=len(data.get("nodes", [])))


def _topological_sort_nodes(nodes: list[dict], edges: list[dict]) -> list[dict]:
    """按拓扑顺序排列节点（BFS 从入口节点开始，保证流程顺序）。"""
    if not nodes:
        return []

    node_map = {n["id"]: n for n in nodes}
    indeg: dict[str, int] = {n["id"]: 0 for n in nodes}
    adj: dict[str, list[str]] = {n["id"]: [] for n in nodes}

    for e in edges:
        src, tgt = e["source"], e["target"]
        if src in adj and tgt in adj:
            adj[src].append(tgt)
            indeg[tgt] += 1

    # BFS from entry nodes
    result: list[dict] = []
    queue = [nid for nid in indeg if indeg[nid] == 0]
    visited: set[str] = set()

    while queue:
        nid = queue.pop(0)
        if nid in visited:
            continue
        visited.add(nid)
        if nid in node_map:
            result.append(node_map[nid])
        for next_id in adj.get(nid, []):
            indeg[next_id] -= 1
            if indeg[next_id] == 0:
                queue.append(next_id)

    # 补上任何遗漏的节点（环或孤立节点）
    for n in nodes:
        if n["id"] not in visited:
            result.append(n)

    return result


def _render_dag_node_details(nodes: list[dict], edges: list[dict]) -> None:
    """渲染 DAG 节点详情：概览表格 + 选中节点的完整详情。"""
    # ── 概览表格（折叠） ─────────────────────────────────────
    with st.expander(f"📊 所有节点概览（{len(nodes)} 节点 / {len(edges)} 边）", expanded=False):
        _build_dag_summary_table(nodes, edges)

    # ── 拓扑排序 ────────────────────────────────────────────
    ordered = _topological_sort_nodes(nodes, edges)

    # ── 水平 pills 选择节点 ─────────────────────────────────
    node_options = [
        f"{_agent_icon(n.get('data', {}).get('title', n['id']))} {n.get('data', {}).get('title', n['id'])}"
        for n in ordered
    ]

    st.markdown("---")
    selected_label = st.pills(
        "选择节点查看详情",
        options=node_options,
        default=node_options[0] if node_options else None,
        selection_mode="single",
        key="dag_node_selector",
        label_visibility="visible",
    )

    if selected_label is None:
        st.info("请选择一个节点查看详细信息。")
        return

    selected_idx = node_options.index(selected_label)
    selected_node = ordered[selected_idx]
    _render_node_detail_clean(selected_node, ordered, edges)


def _render_node_detail_clean(node: dict, all_nodes: list[dict], edges: list[dict]) -> None:
    """用干净的 Streamlit 原生组件渲染节点详情，避免嵌套 columns 和 HTML 混乱。"""
    node_data = node.get("data") or {}
    config = node_data.get("agentConfig") or {}
    title = node_data.get("title", node["id"])
    desc = node_data.get("description", "")

    # ── 标题 + 描述 ────────────────────────────────────────────
    st.markdown(f"### {_agent_icon(title)} {title}")
    if desc:
        st.write(desc)

    # ── 配置信息（一行三个 badges，纯 HTML，不用嵌套 columns）──
    executor = config.get("executor") or {}
    cli = executor.get("agentCli", "—")
    schema = config.get("schemaVersion", "—")
    role_id = config.get("roleId", "")
    role_short = role_id[:12] + "…" if len(role_id) > 12 else (role_id or "—")

    badges_html = (
        f'<div style="margin:8px 0;display:flex;flex-wrap:wrap;gap:6px;">'
        f'<span style="background:#f1f5f9;padding:4px 12px;border-radius:4px;'
        f'font-size:0.9em;">📐 Schema v{schema}</span>'
        f'<span style="background:#f1f5f9;padding:4px 12px;border-radius:4px;'
        f'font-size:0.9em;">🖥️ CLI: {html_mod.escape(cli)}</span>'
        f'<span style="background:#f1f5f9;padding:4px 12px;border-radius:4px;'
        f'font-size:0.9em;">🆔 Role: {html_mod.escape(role_short)}</span>'
        f'</div>'
    )
    st.markdown(badges_html, unsafe_allow_html=True)

    # ── Skills + MCPs ────────────────────────────────────────────
    skills = config.get("skills") or []
    mcps = config.get("mcps") or []

    if skills or mcps:
        st.markdown("---")
        if skills:
            st.markdown("**🔧 Skills**")
            skill_lines = []
            for sk in skills:
                sid = sk.get("skillId", "")
                sid_short = sid[:24] + "…" if len(sid) > 24 else sid
                enabled = "✅" if sk.get("enabled") else "❌"
                skill_lines.append(f"{enabled} `{sid_short}`")
            st.markdown("\n\n".join(skill_lines))

        if mcps:
            st.markdown("**🔌 MCP 服务**")
            mcp_lines = []
            for m in mcps:
                mid = m.get("mcpId", "")
                enabled = "✅" if m.get("enabled") else "❌"
                mcp_lines.append(f"{enabled} `{mid}`")
            st.markdown("\n\n".join(mcp_lines))

    # ── Prompt ───────────────────────────────────────────────────
    prompt = config.get("prompt", "")
    if prompt:
        with st.expander("📝 Prompt"):
            st.text(prompt)

    # ── 上下游依赖关系 ──────────────────────────────────────────
    node_id = node["id"]
    incoming = [e for e in edges if e["target"] == node_id]
    outgoing = [e for e in edges if e["source"] == node_id]

    st.markdown("---")
    if incoming:
        up_names = []
        for e in incoming:
            src = next((n for n in all_nodes if n["id"] == e["source"]), None)
            if src:
                sd = src.get("data") or {}
                up_names.append(f"{_agent_icon(sd.get('title',''))} {sd.get('title', e['source'])}")
        st.markdown("**⬆️ 上游依赖：** " + "  →  ".join(up_names))
    else:
        st.markdown("**⬆️ 上游依赖：** *入口节点*")

    if outgoing:
        down_names = []
        for e in outgoing:
            tgt = next((n for n in all_nodes if n["id"] == e["target"]), None)
            if tgt:
                td = tgt.get("data") or {}
                down_names.append(f"{_agent_icon(td.get('title',''))} {td.get('title', e['target'])}")
        st.markdown("**⬇️ 下游节点：** " + "  →  ".join(down_names))
    else:
        st.markdown("**⬇️ 下游节点：** *出口节点*")


# ══════════════════════════════════════════════════════════════════
# Trace 提取树渲染（fallback）
# ══════════════════════════════════════════════════════════════════

def _render_tree_workflow(root: WorkflowNode) -> None:
    """渲染 trace 提取的树状工作流（原有逻辑）。"""
    all_nodes = _flatten_tree(root)

    total_subs = len([n for n in all_nodes if not n.is_root])
    completed = len([n for n in all_nodes if n.state == "completed"])
    failed = len([n for n in all_nodes if n.state in ("failed", "error")])
    running = len([n for n in all_nodes if n.state == "running"])

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Agent 总数", len(all_nodes))
    c2.metric("Subagent 数", total_subs)
    c3.metric("✅ 已完成", completed)
    c4.metric("❌ 失败 / ❓ 未知", failed + running)

    st.markdown("---")

    if len(all_nodes) >= 2:
        _render_flowchart(root, all_nodes)
        st.markdown("---")

    _render_agent_cards(root, all_nodes)


def _render_flowchart(root: WorkflowNode, all_nodes: list[WorkflowNode]) -> None:
    """渲染 Mermaid flowchart 展示 agent 派发树。"""
    from trace_viz.views.shared import render_mermaid

    st.subheader("🔀 Agent 工作流图")

    lines = ["flowchart TD"]
    node_ids: dict[str, str] = {}

    for i, node in enumerate(all_nodes):
        mid = f"N{i}"
        node_ids[node.id] = mid

        icon = _agent_icon(node.name)
        state_info = _STATE_COLORS.get(node.state, _STATE_COLORS["unknown"])
        label = node.name or "unnamed"
        desc = node.description[:60] if node.description else ""

        parts = [f"{icon} {html_mod.escape(label)}"]
        if desc:
            parts.append(f"{html_mod.escape(desc)}")
        dur_str = f"{node.duration_ms / 1000:.1f}s" if node.duration_ms else ""
        status_line = f"{state_info['icon']} {state_info['label']}"
        if dur_str:
            status_line += f" · {dur_str}"
        parts.append(status_line)

        node_label = "<br/>".join(parts)
        fill_c = _MERMAID_FILL.get(node.state, _MERMAID_FILL["unknown"])
        stroke_c = _MERMAID_STROKE.get(node.state, _MERMAID_STROKE["unknown"])
        text_c = _MERMAID_TEXT.get(node.state, _MERMAID_TEXT["unknown"])

        lines.append(f'    {mid}["{node_label}"]:::{mid}Style')
        lines.append(
            f"    classDef {mid}Style "
            f"fill:{fill_c},stroke:{stroke_c},color:{text_c},"
            f"stroke-width:2px,rx:8,ry:8"
        )

    for node in all_nodes:
        if node.parent_id and node.parent_id in node_ids:
            mid = node_ids[node.id]
            pid = node_ids[node.parent_id]
            step_label = f"Step {node.global_step}" if node.global_step else ""
            lines.append(f'    {pid} -->|"{step_label}"| {mid}' if step_label else f"    {pid} --> {mid}")

    src = "\n".join(lines)
    render_mermaid(src, event_count=len(all_nodes))

    with st.expander("复制 Mermaid 源码"):
        st.code(src, language="text")


def _render_agent_cards(root: WorkflowNode, all_nodes: list[WorkflowNode]) -> None:
    """渲染每个 agent 的摘要卡片，嵌套缩进表达层级。"""
    st.subheader("📋 Agent 详情")
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

    role_badge = ""
    if node.is_root:
        role_badge = (
            '<span style="display:inline-block;background:#1e40af;color:#fff;'
            'padding:1px 8px;border-radius:4px;font-size:0.7em;font-weight:700;'
            'letter-spacing:0.5px;margin-left:8px;vertical-align:middle;">🏠 ROOT</span>'
        )

    state_badge = (
        f'<span style="display:inline-block;background:{state_info["border"]};'
        f'color:#fff;padding:1px 8px;border-radius:4px;'
        f'font-size:0.7em;font-weight:700;letter-spacing:0.5px;'
        f'margin-left:6px;vertical-align:middle;">'
        f'{state_info["icon"]} {state_info["label"].upper()}'
        f'</span>'
    )

    name_escaped = html_mod.escape(node.name or "unnamed")

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

    if node.description:
        card += (
            f'<div style="color:#475569;font-size:0.85em;margin-bottom:8px;'
            f'line-height:1.5;">📝 {html_mod.escape(node.description)}</div>'
        )

    if meta_str:
        card += (
            f'<div style="font-size:0.78em;color:#64748b;margin-bottom:8px;">'
            f'{meta_str}</div>'
        )

    if node.id and node.id != "root":
        id_short = node.id[:24] + "…" if len(node.id) > 24 else node.id
        card += (
            f'<div style="font-size:0.72em;color:#94a3b8;margin-bottom:4px;">'
            f'🆔 {html_mod.escape(id_short)}</div>'
        )

    if not node.is_root and node.output_tokens > 0:
        max_tok = max(n.output_tokens for n in [node] + node.children) or 1
        pct = min(100, node.output_tokens / max_tok * 100) if max_tok else 0
        card += (
            f'<div style="margin-top:6px;">'
            f'<span style="font-size:0.72em;color:#94a3b8;">Output Tokens: {_fmt_tok(node.output_tokens)}</span>'
            f'<div style="background:#e2e8f0;border-radius:4px;height:6px;margin-top:2px;">'
            f'<div style="background:{state_info["border"]};width:{pct}%;height:100%;border-radius:4px;"></div>'
            f'</div></div>'
        )

    card += '</div></details>'
    html_parts.append(card)

    for child in node.children:
        _render_node_card(child, depth=depth + 1, html_parts=html_parts)


# ── Mermaid 颜色（trace 树）─────────────────────────────────────

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


# ══════════════════════════════════════════════════════════════════
# Trace 工作流构建（原有逻辑，保持不变）
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
    si = result.session_info
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
    for sub in result.subagents:
        child = _build_subagent_node(sub)
        if child is not None:
            root.children.append(child)
            _load_child_worktree(child, depth=1, max_depth=3)
    return root


def _build_subagent_node(sub: dict) -> WorkflowNode | None:
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
        parent_id=None,
        global_step=step,
        duration_ms=int(dur) if dur is not None else None,
    )


def _load_child_worktree(node: WorkflowNode, depth: int, max_depth: int) -> None:
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
    if not node.tool_count:
        node.tool_count = len(child_result.tool_calls)
    if not node.input_tokens:
        node.input_tokens = child_result.result_info.total_input
    if not node.output_tokens:
        node.output_tokens = child_result.result_info.total_output
    if node.duration_ms is None:
        node.duration_ms = child_result.result_info.duration_ms
    for sub in child_result.subagents:
        child = _build_subagent_node(sub)
        if child is not None:
            child.parent_id = node.id
            node.children.append(child)
            _load_child_worktree(child, depth=depth + 1, max_depth=max_depth)


def _build_claude_code(result: ParseResult) -> WorkflowNode:
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
    for sub in result.subagents:
        child = _build_subagent_node(sub)
        if child is not None:
            child.parent_id = root.id
            root.children.append(child)
    return root


# ── 辅助函数 ────────────────────────────────────────────────────

def _flatten_tree(node: WorkflowNode) -> list[WorkflowNode]:
    nodes = [node]
    for child in node.children:
        nodes.extend(_flatten_tree(child))
    return nodes


def _fmt_tok(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)
