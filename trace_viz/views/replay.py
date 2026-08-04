"""共享的会话回放渲染引擎。

提供统一的事件流可视化：按时间顺序展示 agent 会话中的每一步操作，
用不同背景色区分事件类型，特别标注 subagent / skill / MCP 等特殊事件。

核心设计：
- 使用原生 HTML <details>/<summary> 实现折叠卡片，标题栏在折叠时就有完整的类型颜色
- 不同类型用截然不同的背景色，一眼可辨
- 长内容自动折叠，短内容直接展示
- 特殊事件（subagent/skill/MCP）标题栏带醒目角标
"""

from __future__ import annotations

import html as html_mod
import json
from dataclasses import dataclass, field
from typing import Any

import streamlit as st

from trace_viz.utils import to_str

# ── 回放步骤分类 ─────────────────────────────────────────────
# 每个 category 有 bg（卡片背景色）和 header_bg（标题栏色，更深）

CATEGORY_STYLE: dict[str, dict[str, str]] = {
    "system": {
        "label":      "系统",
        "icon":       "⚙️",
        "bg":         "#faf5ff",   # 卡片底色：极浅紫
        "header_bg":  "#ede9fe",   # 标题栏：浅紫
        "border":     "#a78bfa",   # 左边框
        "text":       "#5b21b6",
    },
    "llm_text": {
        "label":      "LLM",
        "icon":       "💬",
        "bg":         "#eff6ff",
        "header_bg":  "#dbeafe",
        "border":     "#60a5fa",
        "text":       "#1e40af",
    },
    "tool_call": {
        "label":      "工具",
        "icon":       "🔨",
        "bg":         "#fffbeb",
        "header_bg":  "#fef3c7",
        "border":     "#fbbf24",
        "text":       "#92400e",
    },
    "tool_result": {
        "label":      "结果",
        "icon":       "📋",
        "bg":         "#f0fdf4",
        "header_bg":  "#dcfce7",
        "border":     "#4ade80",
        "text":       "#166534",
    },
    "subagent": {
        "label":      "Subagent",
        "icon":       "🤖",
        "bg":         "#fff1f2",
        "header_bg":  "#fecdd3",   # 更醒目的粉色标题栏
        "border":     "#f43f5e",
        "text":       "#9f1239",
    },
    "skill": {
        "label":      "Skill",
        "icon":       "⚡",
        "bg":         "#fff7ed",
        "header_bg":  "#fed7aa",   # 更醒目的橙色标题栏
        "border":     "#f97316",
        "text":       "#9a3412",
    },
    "mcp": {
        "label":      "MCP",
        "icon":       "🔌",
        "bg":         "#f0fdfa",
        "header_bg":  "#ccfbf1",   # 更醒目的青色标题栏
        "border":     "#2dd4bf",
        "text":       "#115e59",
    },
    "result": {
        "label":      "完成",
        "icon":       "✅",
        "bg":         "#f0fdf4",
        "header_bg":  "#bbf7d0",
        "border":     "#22c55e",
        "text":       "#14532d",
    },
    "error": {
        "label":      "错误",
        "icon":       "❌",
        "bg":         "#fef2f2",
        "header_bg":  "#fecaca",
        "border":     "#f87171",
        "text":       "#991b1b",
    },
    "user_input": {
        "label":      "用户",
        "icon":       "👤",
        "bg":         "#f8fafc",
        "header_bg":  "#e2e8f0",
        "border":     "#94a3b8",
        "text":       "#334155",
    },
    "thinking": {
        "label":      "思考",
        "icon":       "🧠",
        "bg":         "#faf5ff",
        "header_bg":  "#e9d5ff",
        "border":     "#a855f7",
        "text":       "#6b21a8",
    },
}

# ── 特殊工具名称匹配 ─────────────────────────────────────────

_SUBAGENT_TOOLS = {"task", "Task", "delegate", "subagent", "agent", "Agent"}
_SKILL_TOOLS = {"skill", "run_skill", "use_skill"}
_MCP_PREFIX = "mcp__"


@dataclass
class ReplayStep:
    """统一的回放步骤，由各视图的适配器从 raw_events 转换而来。"""

    seq: int
    category: str
    title: str
    content: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    turn_no: int = 0
    is_error: bool = False

    @property
    def style(self) -> dict[str, str]:
        return CATEGORY_STYLE.get(self.category, CATEGORY_STYLE["user_input"])


# ── 渲染入口 ─────────────────────────────────────────────────

def render_replay(steps: list[ReplayStep], *, title: str = "📜 会话回放") -> None:
    """渲染完整的会话回放视图。"""
    if not steps:
        st.info("暂无会话事件可供回放。")
        return

    st.markdown(f"### {title}")
    st.caption(f"共 {len(steps)} 个步骤 — 不同颜色代表不同事件类型")

    # ── 图例 ──────────────────────────────────────────────
    _render_legend(steps)

    # ── 筛选器 ─────────────────────────────────────────────
    filtered = _render_filters(steps)

    if filtered is None:
        return

    # ── 全部步骤一次性渲染 ────────────────────────────────
    _render_step_list(filtered)


# ── 图例 ─────────────────────────────────────────────────────

def _render_legend(steps: list[ReplayStep]) -> None:
    """在回放列表上方渲染一个紧凑的图例条。"""
    from collections import Counter
    cat_counts = Counter(s.category for s in steps)

    present = [c for c in CATEGORY_STYLE if c in cat_counts]
    if len(present) <= 1:
        return

    chips_html = ""
    for cat in present:
        s = CATEGORY_STYLE[cat]
        chips_html += (
            f'<span style="display:inline-block;background:{s["header_bg"]};'
            f'color:{s["text"]};padding:2px 10px;border-radius:12px;'
            f'margin:2px 4px;font-size:0.82em;white-space:nowrap;'
            f'border:1px solid {s["border"]};">'
            f'{s["icon"]} {s["label"]} ({cat_counts[cat]})'
            f'</span>'
        )

    st.markdown(
        f'<div style="margin:8px 0 12px 0;line-height:2;">{chips_html}</div>',
        unsafe_allow_html=True,
    )


# ── 筛选器 ───────────────────────────────────────────────────

def _render_filters(steps: list[ReplayStep]) -> list[ReplayStep] | None:
    """分类筛选控件。返回过滤后的步骤列表。"""
    from collections import Counter
    cat_counts = Counter(s.category for s in steps)

    available = [c for c in CATEGORY_STYLE if c in cat_counts]
    if not available:
        return steps

    options = [
        f"{CATEGORY_STYLE[c]['icon']} {CATEGORY_STYLE[c]['label']} ({cat_counts[c]})"
        for c in available
    ]

    selected = st.pills(
        "筛选事件类型",
        options=options,
        default=options,
        selection_mode="multi",
        key="replay_filter",
        label_visibility="collapsed",
    )

    if not selected:
        st.info("请至少选择一个事件类型以查看回放。")
        return None

    active = set()
    for opt in selected:
        for c in available:
            if CATEGORY_STYLE[c]['label'] in opt:
                active.add(c)
                break

    return [s for s in steps if s.category in active]


# ── 步骤列表渲染（核心）─────────────────────────────────────

def _render_step_list(steps: list[ReplayStep]) -> None:
    """渲染全部步骤，Turn 切换时插入分隔条。"""
    last_turn = -1
    html_parts: list[str] = []

    for i, step in enumerate(steps):
        # ── Turn 分隔条 ──────────────────────────────────
        if step.turn_no and step.turn_no != last_turn:
            last_turn = step.turn_no
            html_parts.append(
                f'<div style="text-align:center;margin:20px 0 12px 0;'
                f'font-size:0.8em;color:#94a3b8;letter-spacing:0.5px;">'
                f'━━━ Turn {step.turn_no} ━━━'
                f'</div>'
            )

        html_parts.append(_build_step_card(step, i))

    full_html = "\n".join(html_parts)
    st.markdown(full_html, unsafe_allow_html=True)


# ── 单步骤卡片构建 ──────────────────────────────────────────

def _build_step_card(step: ReplayStep, idx: int) -> str:
    """构建一个完整的步骤卡片 HTML。

    使用 <details> + <summary> 实现原生折叠：
    - 标题栏（summary）带类型背景色，折叠时就看得到颜色
    - 内容区用更浅的卡片底色
    - 短内容默认展开（open 属性），长内容默认折叠
    """
    s = step.style
    content_len = len(step.content) if step.content else 0
    has_detail = bool(step.detail and any(v for k, v in step.detail.items()
                                          if k not in ("model", "stop_reason") and v))
    needs_fold = content_len > 300

    # ── 特殊角标 ─────────────────────────────────────────
    badge_html = ""
    if step.category in ("subagent", "skill", "mcp"):
        badge_html = (
            f'<span style="display:inline-block;background:{s["border"]};'
            f'color:#fff;padding:1px 8px;border-radius:4px;'
            f'font-size:0.7em;font-weight:700;letter-spacing:0.5px;'
            f'margin-left:8px;vertical-align:middle;">'
            f'{s["icon"]} {s["label"].upper()}'
            f'</span>'
        )

    # ── 耗时/Token 微标签 ────────────────────────────────
    micro_tags = ""
    if step.detail.get("duration_ms"):
        ms = step.detail["duration_ms"]
        dur_str = f"{ms / 1000:.1f}s" if ms >= 1000 else f"{ms:.0f}ms"
        micro_tags += (
            f'<span style="font-size:0.72em;color:#64748b;margin-left:6px;">'
            f'⏱️{dur_str}</span>'
        )
    if step.detail.get("output_tokens"):
        micro_tags += (
            f'<span style="font-size:0.72em;color:#64748b;margin-left:6px;">'
            f'🎯{step.detail["output_tokens"]}tok</span>'
        )

    # ── 错误标记 ─────────────────────────────────────────
    error_flag = " ❌" if step.is_error else ""

    # ── 标题摘要（截断） ─────────────────────────────────
    title_escaped = html_mod.escape(step.title[:100])

    # ── summary 标题行 ───────────────────────────────────
    summary_html = (
        f'<summary style="'
        f'background:{s["header_bg"]};'
        f'color:{s["text"]};'
        f'padding:10px 16px;'
        f'border-left:4px solid {s["border"]};'
        f'border-radius:6px 6px 0 0;'
        f'cursor:pointer;'
        f'font-weight:600;'
        f'font-size:0.92em;'
        f'user-select:none;'
        f'display:flex;'
        f'align-items:center;'
        f'flex-wrap:wrap;'
        f'gap:4px;'
        f'">'
        f'<span style="color:{s["border"]};margin-right:6px;font-size:1.1em;">{s["icon"]}</span>'
        f'<span style="color:#94a3b8;font-weight:400;font-size:0.8em;min-width:28px;">#{step.seq}</span>'
        f'<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
        f'{title_escaped}{error_flag}</span>'
        f'{badge_html}'
        f'{micro_tags}'
        f'<span style="margin-left:auto;color:#94a3b8;font-size:0.7em;font-weight:400;">'
        f'{"展开 ▼" if needs_fold else ""}</span>'
        f'</summary>'
    )

    # ── 内容区 ───────────────────────────────────────────
    content_html = ""

    # 工具名称 + 输入参数
    tool_name = step.detail.get("tool_name", "")
    tool_input = step.detail.get("tool_input")
    if tool_name or (tool_input and isinstance(tool_input, dict) and tool_input):
        content_html += (
            f'<div style="margin-bottom:8px;font-size:0.85em;color:#64748b;">'
        )
        if tool_name:
            content_html += f'<span style="font-weight:600;">🔧 {html_mod.escape(tool_name)}</span>'
        if tool_input and isinstance(tool_input, dict) and tool_input:
            inp_json = json.dumps(tool_input, ensure_ascii=False, indent=2)
            content_html += (
                f'<details style="margin-top:6px;">'
                f'<summary style="cursor:pointer;color:{s["border"]};font-size:0.88em;">📥 输入参数</summary>'
                f'<pre style="background:#f1f5f9;padding:8px;border-radius:4px;'
                f'overflow-x:auto;font-size:0.78em;margin-top:4px;max-height:200px;">'
                f'{html_mod.escape(inp_json)}'
                f'</pre></details>'
            )
        content_html += '</div>'

    # Token 信息行
    in_tok = step.detail.get("input_tokens")
    out_tok = step.detail.get("output_tokens")
    model = step.detail.get("model", "")

    meta_parts = []
    if in_tok or out_tok:
        meta_parts.append(f'🎯 in={in_tok or "—"}  out={out_tok or "—"}')
    if step.detail.get("duration_ms"):
        ms = step.detail["duration_ms"]
        meta_parts.append(f'⏱️ {ms / 1000:.1f}s' if ms >= 1000 else f'⏱️ {ms:.0f}ms')
    if model:
        meta_parts.append(f'🧩 {html_mod.escape(model)}')
    if step.detail.get("file_path"):
        meta_parts.append(f'📁 <code>{html_mod.escape(step.detail["file_path"])}</code>')

    if meta_parts:
        content_html += (
            f'<div style="font-size:0.78em;color:#94a3b8;margin-bottom:8px;">'
            f'{" &nbsp;·&nbsp; ".join(meta_parts)}'
            f'</div>'
        )

    # 主要内容
    if step.content:
        text_escaped = html_mod.escape(step.content)
        if content_len > 300:
            # 长内容：显示前150字 + 嵌套折叠
            preview = html_mod.escape(step.content[:150])
            content_html += (
                f'<span style="color:#334155;font-size:0.88em;line-height:1.6;'
                f'white-space:pre-wrap;word-break:break-word;">{preview}…</span>'
                f'<details style="margin-top:6px;">'
                f'<summary style="cursor:pointer;color:{s["border"]};font-size:0.82em;">'
                f'📝 展开全部内容 ({content_len} 字符)</summary>'
                f'<div style="color:#334155;font-size:0.88em;line-height:1.6;'
                f'white-space:pre-wrap;word-break:break-word;'
                f'margin-top:6px;padding:10px;background:#f8fafc;border-radius:4px;'
                f'max-height:400px;overflow-y:auto;">'
                f'{text_escaped}'
                f'</div>'
                f'</details>'
            )
        else:
            content_html += (
                f'<div style="color:#334155;font-size:0.88em;line-height:1.6;'
                f'white-space:pre-wrap;word-break:break-word;">'
                f'{text_escaped}'
                f'</div>'
            )

    # 错误提示
    if step.is_error:
        content_html += (
            f'<div style="margin-top:8px;padding:6px 10px;background:#fef2f2;'
            f'border-radius:4px;color:#991b1b;font-size:0.82em;">'
            f'⚠️ 此步骤执行出错'
            f'</div>'
        )

    # ── 组装卡片 ─────────────────────────────────────────
    open_attr = "" if needs_fold else " open"
    card_html = (
        f'<details{open_attr} style="'
        f'background:{s["bg"]};'
        f'border:1px solid {s["border"]}20;'
        f'border-radius:8px;'
        f'margin:6px 0;'
        f'overflow:hidden;'
        f'">'
        f'{summary_html}'
        f'<div style="padding:12px 16px;">'
        f'{content_html}'
        f'</div>'
        f'</details>'
    )

    return card_html


# ══════════════════════════════════════════════════════════════
# 适配器：Claude Code raw_events → ReplayStep
# ══════════════════════════════════════════════════════════════

def claude_code_to_replay_steps(
    raw_events: list[dict],
    turns: list[Any] = None,
    tool_calls: list[Any] = None,
) -> list[ReplayStep]:
    """将 Claude Code 的 raw_events 转换为统一的回放步骤列表。

    适配两种格式：stream-json 和 transcript JSONL。
    自动检测并标注 subagent / skill / MCP 等特殊工具调用。
    """
    steps: list[ReplayStep] = []
    seq = 0
    current_turn = 0

    for evt in raw_events:
        etype = evt.get("type", "")

        if etype == "system":
            seq += 1
            model = evt.get("model", "")
            tools = evt.get("tools", [])
            tool_names = [
                (t.get("name", str(t)) if isinstance(t, dict) else str(t))
                for t in tools
            ]
            steps.append(ReplayStep(
                seq=seq,
                category="system",
                title="会话初始化",
                content=f"模型: {model}\n\n可用工具: {', '.join(tool_names)}",
                detail={
                    "model": model,
                    "tools_available": tool_names,
                },
            ))
            continue

        if etype == "assistant":
            msg = evt.get("message") or {}
            if not isinstance(msg, dict):
                continue
            current_turn += 1
            usage = msg.get("usage") or {}
            in_t  = usage.get("input_tokens", 0) or 0
            out_t = usage.get("output_tokens", 0) or 0
            stop  = msg.get("stop_reason", "")
            model = msg.get("model", "")

            raw_content = msg.get("content", [])
            if isinstance(raw_content, str):
                raw_content = [{"type": "text", "text": raw_content}]

            for block in raw_content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type", "")

                if btype == "text":
                    text = block.get("text", "")
                    if text.strip():
                        seq += 1
                        steps.append(ReplayStep(
                            seq=seq,
                            category="llm_text",
                            title=text[:100].replace("\n", " "),
                            content=text,
                            turn_no=current_turn,
                            detail={
                                "input_tokens": in_t,
                                "output_tokens": out_t,
                                "stop_reason": stop,
                                "model": model,
                            },
                        ))

                elif btype == "tool_use":
                    tool_name = block.get("name", "unknown")
                    tool_input = block.get("input") or {}
                    tid = block.get("id", "")

                    # 分类：subagent / skill / MCP / 普通工具
                    category, tool_label = _classify_tool(tool_name, tool_input)

                    seq += 1

                    # 提取描述性标题
                    title = tool_name
                    if category == "subagent":
                        desc = tool_input.get("description", "") or tool_input.get("prompt", "")[:80]
                        title = f"Subagent: {desc}" if desc else f"Subagent: {tool_name}"
                    elif category == "skill":
                        skill_name = tool_input.get("skill", "") or tool_input.get("name", "") or tool_name
                        title = f"Skill: {skill_name}"
                    elif category == "mcp":
                        mcp_name = tool_name.replace("mcp__", "", 1)
                        title = f"MCP: {mcp_name}"
                    else:
                        # 普通工具，从输入中提取关键信息作为标题
                        first_val = _first_input_value(tool_input)
                        if first_val:
                            title = f"{tool_name}({first_val[:60]})"

                    steps.append(ReplayStep(
                        seq=seq,
                        category=category,
                        title=title,
                        turn_no=current_turn,
                        detail={
                            "tool_name": tool_name,
                            "tool_input": tool_input,
                            "tool_id": tid,
                            "input_tokens": in_t,
                            "output_tokens": out_t,
                        },
                    ))

                elif btype == "thinking":
                    text = block.get("thinking", "") or block.get("text", "")
                    if text.strip():
                        seq += 1
                        steps.append(ReplayStep(
                            seq=seq,
                            category="thinking",
                            title="思考过程",
                            content=text,
                            turn_no=current_turn,
                        ))

            continue

        if etype == "user":
            msg = evt.get("message") or {}
            if not isinstance(msg, dict):
                continue

            raw_content = msg.get("content", [])
            if isinstance(raw_content, str):
                raw_content = [{"type": "text", "text": raw_content}]

            for block in raw_content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type", "")

                if btype == "tool_result":
                    tid = block.get("tool_use_id") or block.get("toolUseId") or ""
                    is_err = bool(block.get("is_error", False))
                    raw_output = block.get("content", "")

                    if isinstance(raw_output, list):
                        output_text = "\n".join(
                            (c.get("text", str(c)) if isinstance(c, dict) else str(c))
                            for c in raw_output
                        )
                    else:
                        output_text = to_str(raw_output)

                    # 截取输出作为标题
                    short_output = output_text[:100].replace("\n", " ")

                    seq += 1
                    cat = "error" if is_err else "tool_result"
                    steps.append(ReplayStep(
                        seq=seq,
                        category=cat,
                        title=short_output or "(空输出)",
                        content=output_text,
                        turn_no=current_turn,
                        is_error=is_err,
                        detail={
                            "tool_id": tid,
                            "output_length": len(output_text),
                        },
                    ))

                elif btype == "text":
                    text = block.get("text", "")
                    if text.strip():
                        seq += 1
                        steps.append(ReplayStep(
                            seq=seq,
                            category="user_input",
                            title=text[:100].replace("\n", " "),
                            content=text,
                            turn_no=current_turn,
                        ))
            continue

        if etype == "result":
            seq += 1
            dur_ms = evt.get("duration_ms", 0)
            n_turns = evt.get("num_turns", "")
            cost = evt.get("total_cost_usd", 0)
            is_err = bool(evt.get("is_error", False))
            result_text = evt.get("result", "")

            parts = []
            if n_turns:
                parts.append(f"共 {n_turns} 轮推理")
            if dur_ms:
                parts.append(f"耗时 {int(dur_ms) // 1000}s")
            if cost:
                parts.append(f"费用 ${float(cost):.4f}")

            content_lines = [" | ".join(parts)]
            if result_text:
                content_lines.append(f"\n\n结果: {result_text}")

            steps.append(ReplayStep(
                seq=seq,
                category="error" if is_err else "result",
                title="会话完成" if not is_err else "会话出错",
                content="\n".join(content_lines),
                is_error=is_err,
                detail={
                    "duration_ms": dur_ms,
                    "num_turns": n_turns,
                    "total_cost_usd": cost,
                },
            ))
            continue

        # 顶层 tool_result（transcript 中可能出现）
        if etype == "tool_result":
            is_err = bool(evt.get("isError", False))
            raw = evt.get("content", "")
            if isinstance(raw, list):
                output_text = "\n".join(
                    (c.get("text", str(c)) if isinstance(c, dict) else str(c))
                    for c in raw
                )
            else:
                output_text = to_str(raw)

            seq += 1
            cat = "error" if is_err else "tool_result"
            steps.append(ReplayStep(
                seq=seq,
                category=cat,
                title=output_text[:100].replace("\n", " "),
                content=output_text,
                turn_no=current_turn,
                is_error=is_err,
            ))

    return steps


# ══════════════════════════════════════════════════════════════
# 适配器：Opencode raw_events → ReplayStep
# ══════════════════════════════════════════════════════════════

def opencode_to_replay_steps(
    raw_events: list[dict],
    turns: list[Any] = None,
    tool_calls: list[Any] = None,
) -> list[ReplayStep]:
    """将 Opencode 的 raw_events 转换为统一的回放步骤列表。"""
    steps: list[ReplayStep] = []
    seq = 0
    current_step = 0
    pending_tools: dict[str, dict] = {}

    for evt in raw_events:
        etype = evt.get("type", "")

        if etype == "session.start":
            seq += 1
            model = evt.get("model", "")
            steps.append(ReplayStep(
                seq=seq,
                category="system",
                title="会话开始",
                content=f"模型: {model}" if model else "",
                detail={"model": model},
            ))
            continue

        if etype == "session.end":
            seq += 1
            steps.append(ReplayStep(
                seq=seq,
                category="result",
                title="会话结束",
                content="",
                detail=evt,
            ))
            continue

        if etype == "text.user":
            text = evt.get("text", "")
            if text.strip():
                seq += 1
                steps.append(ReplayStep(
                    seq=seq,
                    category="user_input",
                    title=text[:100].replace("\n", " "),
                    content=text,
                ))
            continue

        if etype == "step.start":
            current_step = evt.get("globalStep", current_step + 1)
            continue

        if etype == "step.finish":
            continue

        if etype == "text.assistant":
            text = evt.get("text", "")
            if text.strip():
                seq += 1
                steps.append(ReplayStep(
                    seq=seq,
                    category="llm_text",
                    title=text[:100].replace("\n", " "),
                    content=text,
                    turn_no=current_step,
                ))
            continue

        if etype == "tool.start":
            tid = evt.get("toolCallId", "")
            if not tid:
                continue  # 跳过无 ID 的异常事件
            tool_name = evt.get("tool", "unknown")
            # opencode 用 "args" 存储参数，stream-json 用 "input"
            tool_input = evt.get("args") or evt.get("input") or {}
            pending_tools[tid] = {
                "name": tool_name,
                "input": tool_input,
                "step": current_step,
                "ts": evt.get("ts", 0),
            }
            continue

        if etype == "tool.finish":
            tid = evt.get("toolCallId", "")
            start_info = pending_tools.pop(tid, {})
            tool_name = start_info.get("name", evt.get("tool", "unknown"))
            # opencode 用 "args" 存储参数
            tool_input = start_info.get("input") or evt.get("args") or evt.get("input") or {}
            is_err = bool(evt.get("isError", False))
            output_text = to_str(evt.get("output", ""))
            dur_ms = evt.get("duration", 0) or evt.get("durationMs", 0) or 0

            category, tool_label = _classify_tool(tool_name, tool_input)

            seq += 1
            title = tool_name
            if category == "subagent":
                desc = tool_input.get("description", "") or tool_input.get("prompt", "")[:80]
                title = f"Subagent: {desc}" if desc else f"Subagent: {tool_name}"
            elif category == "skill":
                skill_name = tool_input.get("skill", "") or tool_input.get("name", "") or tool_name
                title = f"Skill: {skill_name}"
            elif category == "mcp":
                mcp_name = tool_name.replace("mcp__", "", 1)
                title = f"MCP: {mcp_name}"
            else:
                first_val = _first_input_value(tool_input)
                if first_val:
                    title = f"{tool_name}({first_val[:60]})"

            output_brief = output_text[:100].replace("\n", " ")
            cat = "error" if is_err else category

            steps.append(ReplayStep(
                seq=seq,
                category=cat,
                title=title,
                content=output_text,
                turn_no=current_step,
                is_error=is_err,
                detail={
                    "tool_name": tool_name,
                    "tool_input": tool_input,
                    "tool_id": tid,
                    "duration_ms": dur_ms,
                    "output_length": len(output_text),
                },
            ))
            continue

        # fallback: other event types
        if etype not in {
            "step.start", "step.finish", "tool.start", "tool.finish",
            "text.user", "text.assistant", "session.start", "session.end",
        }:
            seq += 1
            content = json.dumps(evt, ensure_ascii=False, indent=2)
            steps.append(ReplayStep(
                seq=seq,
                category="system",
                title=f"事件: {etype}",
                content=content,
            ))

    return steps


# ── 辅助函数 ─────────────────────────────────────────────────

def _classify_tool(tool_name: str, tool_input: dict) -> tuple[str, str]:
    """根据工具名称和输入判断事件分类。

    Returns:
        (category, display_label)
    """
    name_lower = tool_name.lower()

    # MCP 工具：名称以 mcp__ 开头
    if tool_name.startswith(_MCP_PREFIX):
        return "mcp", f"MCP: {tool_name}"

    # Subagent 工具（精确匹配，避免 "task" 子串误匹配如 create_multitask）
    if name_lower in _SUBAGENT_TOOLS:
        return "subagent", f"Subagent: {tool_name}"

    # Skill 工具（精确匹配）
    if name_lower in _SKILL_TOOLS:
        return "skill", f"Skill: {tool_name}"

    # 检查输入中是否有 subagent/skill 相关字段
    if isinstance(tool_input, dict):
        if tool_input.get("subagent_type") or tool_input.get("subagent_name"):
            return "subagent", f"Subagent: {tool_name}"
        if tool_input.get("skill") or tool_input.get("skill_name"):
            return "skill", f"Skill: {tool_name}"

    return "tool_call", tool_name


def _first_input_value(tool_input: dict) -> str:
    """从工具输入字典中提取第一个有意义的值用于简短描述。"""
    if not isinstance(tool_input, dict) or not tool_input:
        return ""
    # 优先选择常见的描述字段
    for key in ("file_path", "path", "query", "pattern", "command", "url", "message"):
        if key in tool_input:
            val = tool_input[key]
            if isinstance(val, str) and val:
                return val[:80]
    # fallback: 第一个字符串值
    for v in tool_input.values():
        if isinstance(v, str) and v:
            return v[:80]
    return ""
