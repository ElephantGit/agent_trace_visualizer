"""A/B 对比视图：加载两份 Agent trace 文件，叠加对比 Token 消耗、工具调用等指标。

用于对比同一任务在有无 RTK（或其他优化手段）下的 Token 消耗差异。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from trace_viz.config import SAFE_PALETTE
from trace_viz.models import ParseResult
from trace_viz.parsers import claude_code as cc_parser
from trace_viz.parsers import opencode as oc_parser
from trace_viz.utils import format_duration
from trace_viz.views.shared import tool_success_rate


def _hex_to_rgba(hex_color: str, alpha: float) -> str:
    """将 hex 颜色转换为 rgba 字符串。"""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r},{g},{b},{alpha})"

# ── 固定颜色方案 ────────────────────────────────────────────────
COLOR_BASELINE = "#ea4335"  # 暖红 — 无 RTK / 优化前
COLOR_RTK = "#0a9e6a"      # 绿色 — 有 RTK / 优化后

PARSER_MAP = {
    "opencode": ("Opencode (.ndjson)", oc_parser.parse),
    "claude_code": ("Claude Code (.jsonl / stream-json)", cc_parser.parse),
}


def render() -> None:
    """对比模式入口：侧边栏加载两个文件 → 解析 → 渲染对比仪表盘。"""
    result_a, result_b, label_a, label_b, agent_type = _sidebar()
    if result_a is None or result_b is None:
        _show_placeholder()
        return

    render_body(result_a, result_b, label_a, label_b, agent_type)


def render_body(
    result_a: ParseResult,
    result_b: ParseResult,
    label_a: str,
    label_b: str,
    agent_type: str = "",
) -> None:
    """渲染完整的 A/B 对比仪表盘（供独立和嵌入式两种模式复用）。"""
    st.title("📊 Token 消耗对比")
    st.caption(f"Agent 类型：{agent_type}")

    df_turns_a = _build_turns_df(result_a)
    df_turns_b = _build_turns_df(result_b)
    df_tools_a = _build_tools_df(result_a)
    df_tools_b = _build_tools_df(result_b)

    # ── 第一层：结论先行 — 总览对比卡 ────────────────────────────
    st.markdown("---")
    _summary_metrics(result_a, result_b, df_tools_a, df_tools_b, label_a, label_b)

    # ── 第二层：Token 消耗叠加曲线 ────────────────────────────────
    st.markdown("---")
    _overlay_token_trend(df_turns_a, df_turns_b, label_a, label_b)

    # ── 第三层：逐轮 Token 增量对比 ────────────────────────────────
    if not df_turns_a.empty or not df_turns_b.empty:
        st.markdown("---")
        _per_turn_comparison(df_turns_a, df_turns_b, label_a, label_b)

    # ── 第四层：工具调用效率对比 ──────────────────────────────────
    if not df_tools_a.empty or not df_tools_b.empty:
        st.markdown("---")
        _tool_comparison(df_tools_a, df_tools_b, label_a, label_b)

    # ── 第五层：逐轮明细表 ────────────────────────────────────────
    if not df_turns_a.empty and not df_turns_b.empty:
        st.markdown("---")
        _detail_table(df_turns_a, df_turns_b, label_a, label_b)


# ══════════════════════════════════════════════════════════════════
# 侧边栏
# ══════════════════════════════════════════════════════════════════

def _sidebar() -> tuple[
    ParseResult | None, ParseResult | None, str, str, str
]:
    with st.sidebar:
        st.markdown("### 📊 对比模式")
        st.markdown("加载两个相同任务的 trace 文件进行 A/B 对比")

        # Agent 类型选择
        agent_keys = list(PARSER_MAP.keys())
        agent_labels = [v[0] for v in PARSER_MAP.values()]
        agent_type = st.selectbox(
            "Agent 类型",
            agent_keys,
            format_func=lambda k: dict(zip(agent_keys, agent_labels))[k],
            key="cmp_agent_type",
        )

        st.divider()

        # 文件加载方式
        load_mode = st.radio(
            "文件加载方式",
            ["上传文件", "输入路径"],
            key="cmp_load_mode",
            horizontal=True,
        )

        if load_mode == "上传文件":
            file_a = st.file_uploader(
                f"🔴 Baseline 文件", type=["ndjson", "jsonl", "txt", "json"],
                key="cmp_file_a",
            )
            file_b = st.file_uploader(
                f"🟢 Experiment 文件", type=["ndjson", "jsonl", "txt", "json"],
                key="cmp_file_b",
            )
            content_a = file_a.getvalue() if file_a else None
            content_b = file_b.getvalue() if file_b else None
        else:
            path_a = st.text_input("🔴 Baseline 文件路径", key="cmp_path_a")
            path_b = st.text_input("🟢 Experiment 文件路径", key="cmp_path_b")
            content_a, content_b = None, None
            if path_a:
                p = Path(path_a)
                if p.is_file():
                    content_a = p.read_bytes()
                else:
                    st.warning(f"文件不存在：{path_a}")
            if path_b:
                p = Path(path_b)
                if p.is_file():
                    content_b = p.read_bytes()
                else:
                    st.warning(f"文件不存在：{path_b}")

        st.divider()

        # 标签自定义
        st.markdown("#### 标签设置")
        col_l, col_r = st.columns(2)
        with col_l:
            label_a = st.text_input("🔴 标签", "无 RTK", key="cmp_label_a")
        with col_r:
            label_b = st.text_input("🟢 标签", "有 RTK", key="cmp_label_b")

        st.divider()

        # 解析按钮
        if st.button("🔍 开始对比分析", type="primary", width='stretch'):
            if content_a is None or content_b is None:
                st.error("请先提供两个文件")
                st.stop()
            with st.spinner(f"解析中…"):
                _, parse_fn = PARSER_MAP[agent_type]
                st.session_state["cmp_result_a"] = parse_fn(content_a)
                st.session_state["cmp_result_b"] = parse_fn(content_b)
            st.rerun()

    # 标签值直接来自 widget，不需要额外写入 session_state
    return (
        st.session_state.get("cmp_result_a"),
        st.session_state.get("cmp_result_b"),
        label_a or "无 RTK",
        label_b or "有 RTK",
        agent_type,
    )


def _show_placeholder() -> None:
    """还没有加载文件时的引导页。"""
    st.title("📊 Token 消耗对比")
    st.markdown("---")
    col_l, col_r = st.columns(2)
    with col_l:
        st.markdown("### 使用方法")
        st.markdown("""
        1. 在左侧选择 **Agent 类型**（Opencode / Claude Code）
        2. 上传或输入两个 **相同任务** 的 trace 文件：
           - 🔴 **Baseline** — 未使用优化的原始 trace
           - 🟢 **Experiment** — 使用了优化（如 RTK）的 trace
        3. 可自定义两个文件的显示标签
        4. 点击 **开始对比分析**
        """)
    with col_r:
        st.markdown("### 对比维度")
        st.markdown("""
        - 💰 **Token 总量对比** — 总 Input / Output / Cost 及节省百分比
        - 📈 **Token 增长曲线** — 两条叠加的累计趋势线
        - 📊 **逐轮增量对比** — 每轮 Input / Output 分组柱状图
        - 🔨 **工具调用效率** — 各工具在两个版本中的调用次数与 Token 消耗
        - 📋 **逐轮明细表** — 每轮的精确 Delta 和节省比例
        """)
    st.info("📂 请在左侧边栏加载两个文件后点击 **开始对比分析**")


# ══════════════════════════════════════════════════════════════════
# 第一层：总览对比指标卡
# ══════════════════════════════════════════════════════════════════

def _summary_metrics(
    result_a: ParseResult,
    result_b: ParseResult,
    df_tools_a: pd.DataFrame,
    df_tools_b: pd.DataFrame,
    label_a: str,
    label_b: str,
) -> None:
    """渲染顶部总结对比指标卡，每个卡片同时显示两个值和变化百分比。"""
    st.subheader("📋 总览对比")

    ri_a = result_a.result_info
    ri_b = result_b.result_info

    # 构建指标列表：(标题, 值A, 值B, 格式, 越小越好?)
    metrics: list[tuple[str, float, float, str, bool]] = []

    # Total Input
    in_a = float(ri_a.total_input or result_a.peak_input_tokens or 0)
    in_b = float(ri_b.total_input or result_b.peak_input_tokens or 0)
    if in_a or in_b:
        metrics.append(("总 Input Tokens", in_a, in_b, "int", True))

    # Total Output
    out_a = float(ri_a.total_output or sum(t.output_tokens for t in result_a.turns))
    out_b = float(ri_b.total_output or sum(t.output_tokens for t in result_b.turns))
    if out_a or out_b:
        metrics.append(("总 Output Tokens", out_a, out_b, "int", True))

    # Total Cost
    cost_a = float(ri_a.total_cost_usd or 0)
    cost_b = float(ri_b.total_cost_usd or 0)
    if cost_a or cost_b:
        metrics.append(("总费用 (USD)", cost_a, cost_b, "cost", True))

    # Duration
    dur_a = float(ri_a.duration_ms or 0)
    dur_b = float(ri_b.duration_ms or 0)
    if dur_a or dur_b:
        metrics.append(("总耗时", dur_a, dur_b, "duration", True))

    # Turns
    turns_a = float(len(result_a.turns))
    turns_b = float(len(result_b.turns))
    if turns_a or turns_b:
        metrics.append(("LLM 推理轮次", turns_a, turns_b, "int", True))

    # Tool calls
    tc_a = float(len(result_a.tool_calls))
    tc_b = float(len(result_b.tool_calls))
    if tc_a or tc_b:
        metrics.append(("工具调用次数", tc_a, tc_b, "int", True))

    # Tool success rate
    sr_a = tool_success_rate(df_tools_a)
    sr_b = tool_success_rate(df_tools_b)
    metrics.append(("工具成功率 (%)", sr_a, sr_b, "pct", False))

    # Subagent count
    sa_a = float(len(getattr(result_a, "subagents", []) or []))
    sa_b = float(len(getattr(result_b, "subagents", []) or []))
    if sa_a or sa_b:
        metrics.append(("Subagent 派发数", sa_a, sa_b, "int", True))

    # Render in rows of 3
    for row_start in range(0, len(metrics), 3):
        row_metrics = metrics[row_start: row_start + 3]
        cols = st.columns(len(row_metrics))
        for col, (title, val_a, val_b, fmt, lower_better) in zip(cols, row_metrics):
            with col:
                _metric_card(title, val_a, val_b, fmt, lower_better, label_a, label_b)


def _metric_card(
    title: str,
    val_a: float,
    val_b: float,
    fmt: str,
    lower_better: bool,
    label_a: str,
    label_b: str,
) -> None:
    """渲染单个对比指标卡（自定义 HTML，同时展示两个值 + 变化率）。"""
    if fmt == "int":
        str_a = f"{int(val_a):,}"
        str_b = f"{int(val_b):,}"
    elif fmt == "cost":
        str_a = f"${val_a:.4f}"
        str_b = f"${val_b:.4f}"
    elif fmt == "duration":
        str_a = _fmt_dur(val_a)
        str_b = _fmt_dur(val_b)
    elif fmt == "pct":
        str_a = f"{val_a:.1f}%"
        str_b = f"{val_b:.1f}%"
    else:
        str_a = f"{val_a:,.0f}"
        str_b = f"{val_b:,.0f}"

    # 计算变化率
    if val_a > 0:
        delta_pct = (val_b - val_a) / val_a * 100
    elif val_b > 0:
        delta_pct = float("inf")  # 从 0 增长
    else:
        delta_pct = 0.0

    # 判断好坏：lower_better=True 时，减少是好事（绿色）；否则增加是好事
    if abs(delta_pct) < 0.01:
        delta_color = "#64748b"  # 无变化
        arrow = "→"
        desc = "持平"
    elif (delta_pct < 0 and lower_better) or (delta_pct > 0 and not lower_better):
        delta_color = COLOR_RTK
        arrow = "↓" if delta_pct < 0 else "↑"
        desc = "改善"
    else:
        delta_color = COLOR_BASELINE
        arrow = "↑" if delta_pct > 0 else "↓"
        desc = "增加" if lower_better else "下降"

    delta_str = f"{arrow} {abs(delta_pct):.1f}% {desc}"

    st.markdown(
        f"""
        <div style="
            background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%);
            border: 1px solid #e0e0e0;
            border-radius: 12px;
            padding: 16px 20px;
            text-align: center;
        ">
            <div style="font-size: 12px; color: #888; margin-bottom: 8px; text-transform: uppercase;
                        letter-spacing: 0.5px;">{title}</div>
            <div style="display: flex; justify-content: center; align-items: center; gap: 20px;
                        margin-bottom: 6px;">
                <div style="text-align: center;">
                    <div style="font-size: 10px; color: {COLOR_BASELINE};">{label_a}</div>
                    <div style="font-size: 20px; font-weight: 700; color: {COLOR_BASELINE};">{str_a}</div>
                </div>
                <div style="font-size: 16px; color: #ccc;">vs</div>
                <div style="text-align: center;">
                    <div style="font-size: 10px; color: {COLOR_RTK};">{label_b}</div>
                    <div style="font-size: 20px; font-weight: 700; color: {COLOR_RTK};">{str_b}</div>
                </div>
            </div>
            <div style="font-size: 13px; font-weight: 600; color: {delta_color};">{delta_str}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


# ══════════════════════════════════════════════════════════════════
# 第二层：Token 消耗叠加曲线
# ══════════════════════════════════════════════════════════════════

def _overlay_token_trend(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    label_a: str,
    label_b: str,
) -> None:
    """两条累计 Token 曲线叠加在同一张图上。"""
    st.subheader("📈 Token 消耗趋势对比")

    if df_a.empty and df_b.empty:
        st.info("暂无 Token 数据")
        return

    fig = go.Figure()

    for df, label, color, dash in [
        (df_a, label_a, COLOR_BASELINE, None),
        (df_b, label_b, COLOR_RTK, None),
    ]:
        if df.empty:
            continue
        x = df["turn_no"]

        # Input 实线 + 面积填充
        fig.add_trace(go.Scatter(
            x=x, y=df["input_tokens"],
            mode="lines+markers",
            name=f"{label} — Input（窗口大小）",
            line=dict(color=color, width=2.5, dash=dash),
            marker=dict(size=6),
            fill="tozeroy",
            fillcolor=_hex_to_rgba(color, 0.06),
            legendgroup=label,
        ))

        # Output 虚线
        if df["output_tokens"].sum() > 0:
            fig.add_trace(go.Scatter(
                x=x, y=df["output_tokens"],
                mode="lines+markers",
                name=f"{label} — Output",
                line=dict(color=color, width=2, dash="dot"),
                marker=dict(size=5, symbol="diamond"),
                legendgroup=label,
            ))

    # 在最后一个 turn 处标注差距
    if not df_a.empty and not df_b.empty:
        last_x = max(df_a["turn_no"].max(), df_b["turn_no"].max())
        in_a_last = _value_at_or_near(df_a, "input_tokens", last_x)
        in_b_last = _value_at_or_near(df_b, "input_tokens", last_x)
        if in_a_last is not None and in_b_last is not None:
            saving = in_a_last - in_b_last
            if saving > 0:
                pct = saving / in_a_last * 100 if in_a_last else 0
                mid_y = (in_a_last + in_b_last) / 2
                fig.add_annotation(
                    x=last_x, y=mid_y,
                    text=f"节省 {saving:,.0f} tokens<br>(−{pct:.1f}%)",
                    showarrow=True,
                    arrowhead=2, arrowsize=1,
                    ax=40, ay=0,
                    font=dict(color=COLOR_RTK, size=12, family="sans-serif"),
                    bordercolor=COLOR_RTK,
                    borderwidth=1, borderpad=8,
                    bgcolor="rgba(255,255,255,0.9)",
                )

    fig.update_layout(
        height=420,
        hovermode="x unified",
        xaxis_title="Turn",
        yaxis_title="Tokens",
        margin=dict(t=10, b=0),
        legend=dict(
            orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1,
            font=dict(size=11),
        ),
    )
    st.plotly_chart(fig, width='stretch')


# ══════════════════════════════════════════════════════════════════
# 第三层：逐轮 Token 增量分组柱状图
# ══════════════════════════════════════════════════════════════════

def _per_turn_comparison(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    label_a: str,
    label_b: str,
) -> None:
    """每轮 Input 增量 + Output 的分组柱状图对比。"""
    st.subheader("📊 逐轮 Token 增量对比")

    # 计算 Input 增量
    df_a = df_a.copy()
    df_b = df_b.copy()
    df_a["input_delta"] = df_a["input_tokens"].diff().fillna(df_a["input_tokens"].iloc[0]).astype(int)
    df_b["input_delta"] = df_b["input_tokens"].diff().fillna(df_b["input_tokens"].iloc[0]).astype(int)

    max_turns = max(
        df_a["turn_no"].max() if not df_a.empty else 0,
        df_b["turn_no"].max() if not df_b.empty else 0,
    )
    if max_turns == 0:
        st.info("无 turn 数据")
        return

    fig = go.Figure()

    # Baseline bars（靠左）
    if not df_a.empty:
        fig.add_trace(go.Bar(
            x=df_a["turn_no"] - 0.15,
            y=df_a["input_delta"],
            name=f"{label_a} — Input 增量",
            marker_color=COLOR_BASELINE,
            marker=dict(opacity=0.7),
            width=0.25,
        ))
        fig.add_trace(go.Bar(
            x=df_a["turn_no"] - 0.15,
            y=df_a["output_tokens"],
            name=f"{label_a} — Output",
            marker_color=COLOR_BASELINE,
            marker=dict(opacity=0.35, pattern_shape="/"),
            width=0.25,
        ))

    # Experiment bars（靠右）
    if not df_b.empty:
        fig.add_trace(go.Bar(
            x=df_b["turn_no"] + 0.15,
            y=df_b["input_delta"],
            name=f"{label_b} — Input 增量",
            marker_color=COLOR_RTK,
            marker=dict(opacity=0.7),
            width=0.25,
        ))
        fig.add_trace(go.Bar(
            x=df_b["turn_no"] + 0.15,
            y=df_b["output_tokens"],
            name=f"{label_b} — Output",
            marker_color=COLOR_RTK,
            marker=dict(opacity=0.35, pattern_shape="\\"),
            width=0.25,
        ))

    fig.update_layout(
        barmode="group",
        height=380,
        xaxis=dict(title="Turn", tickmode="linear", dtick=1),
        yaxis_title="Tokens",
        margin=dict(t=10, b=0),
        legend=dict(
            orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1,
            font=dict(size=11),
        ),
        bargap=0.15,
        bargroupgap=0.05,
    )
    st.plotly_chart(fig, width='stretch')


# ══════════════════════════════════════════════════════════════════
# 第四层：工具调用效率对比
# ══════════════════════════════════════════════════════════════════

def _tool_comparison(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    label_a: str,
    label_b: str,
) -> None:
    """工具调用效率双栏对比。"""
    st.subheader("🔨 工具调用效率对比")

    # 构建合并的工具对比表
    agg_a = _tool_agg(df_a) if not df_a.empty else pd.DataFrame()
    agg_b = _tool_agg(df_b) if not df_b.empty else pd.DataFrame()

    all_tools = sorted(set(
        (list(agg_a["工具"]) if not agg_a.empty else []) +
        (list(agg_b["工具"]) if not agg_b.empty else [])
    ))

    if not all_tools:
        st.info("无工具调用数据")
        return

    # ── 合并表 ──────────────────────────────────────────────────
    rows = []
    for tool in all_tools:
        ra = agg_a[agg_a["工具"] == tool].iloc[0] if not agg_a.empty and tool in agg_a["工具"].values else None
        rb = agg_b[agg_b["工具"] == tool].iloc[0] if not agg_b.empty and tool in agg_b["工具"].values else None
        count_a = int(ra["调用次数"]) if ra is not None else 0
        count_b = int(rb["调用次数"]) if rb is not None else 0
        tok_a = int(ra["总TiktokenTokens"]) if ra is not None else 0
        tok_b = int(rb["总TiktokenTokens"]) if rb is not None else 0
        dur_a = ra["平均耗时ms"] if ra is not None and "平均耗时ms" in (ra.index if hasattr(ra, "index") else []) else None
        dur_b = rb["平均耗时ms"] if rb is not None and "平均耗时ms" in (rb.index if hasattr(rb, "index") else []) else None

        rows.append({
            "工具": tool,
            f"{label_a} 次数": count_a,
            f"{label_b} 次数": count_b,
            "Δ 次数": _delta_str(count_a, count_b, True),
            f"{label_a} 总Token": f"{tok_a:,}",
            f"{label_b} 总Token": f"{tok_b:,}",
            "Δ Token": _delta_pct(tok_a, tok_b) if tok_a else "",
        })

    st.dataframe(
        pd.DataFrame(rows),
        hide_index=True,
        width='stretch',
        column_config={
            "Δ 次数": st.column_config.Column(width="small"),
            "Δ Token": st.column_config.Column(width="small"),
        },
    )

    # ── 图表：水平分组柱状图 ────────────────────────────────────
    col_chart, col_pie = st.columns(2)

    with col_chart:
        _tool_count_chart(all_tools, rows, label_a, label_b)

    with col_pie:
        _token_saving_breakdown(df_a, df_b, label_a, label_b)


def _tool_agg(df: pd.DataFrame) -> pd.DataFrame:
    """按工具名聚合统计。"""
    agg_spec: dict = {
        "调用次数": ("name", "count"),
        "总TiktokenTokens": ("tiktoken_tokens", "sum"),
    }
    if "duration_ms" in df.columns and df["duration_ms"].sum() > 0:
        agg_spec["平均耗时ms"] = ("duration_ms", "mean")
    return (
        df.groupby("name")
        .agg(**agg_spec)
        .reset_index()
        .rename(columns={"name": "工具"})
    )


def _tool_count_chart(
    all_tools: list[str],
    rows: list[dict],
    label_a: str,
    label_b: str,
) -> None:
    """水平分组柱状图：各工具在两个版本中的调用次数对比。"""
    st.subheader("各工具调用次数")
    fig = go.Figure()

    counts_a = []
    counts_b = []
    for r in rows:
        # parse from formatted strings
        ca = r[f"{label_a} 次数"]
        cb = r[f"{label_b} 次数"]
        counts_a.append(int(ca) if isinstance(ca, (int, float)) else int(str(ca).replace(",", "")))
        counts_b.append(int(cb) if isinstance(cb, (int, float)) else int(str(cb).replace(",", "")))

    fig.add_trace(go.Bar(
        y=all_tools, x=counts_a,
        name=label_a, marker_color=COLOR_BASELINE, marker=dict(opacity=0.75),
        orientation="h",
    ))
    fig.add_trace(go.Bar(
        y=all_tools, x=counts_b,
        name=label_b, marker_color=COLOR_RTK, marker=dict(opacity=0.75),
        orientation="h",
    ))
    fig.update_layout(
        barmode="group", height=max(220, len(all_tools) * 32),
        margin=dict(t=10, b=0, l=0),
        yaxis=dict(autorange="reversed"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    )
    st.plotly_chart(fig, width='stretch')


def _token_saving_breakdown(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    label_a: str,
    label_b: str,
) -> None:
    """各工具贡献的 Token 节省占比饼图。"""
    st.subheader("各工具 Token 节省贡献")
    if df_a.empty and df_b.empty:
        st.info("无数据")
        return

    tools_a = df_a.groupby("name")["tiktoken_tokens"].sum() if not df_a.empty else pd.Series(dtype=float)
    tools_b = df_b.groupby("name")["tiktoken_tokens"].sum() if not df_b.empty else pd.Series(dtype=float)

    all_names = sorted(set(list(tools_a.index) + list(tools_b.index)))
    savings = {}
    for name in all_names:
        diff = tools_a.get(name, 0) - tools_b.get(name, 0)
        if diff > 0:
            savings[name] = diff

    if not savings:
        st.info("无正向节省")
        return

    labels = list(savings.keys())
    values = list(savings.values())
    colors = SAFE_PALETTE[:len(labels)]

    fig = go.Figure(go.Pie(
        labels=labels, values=values,
        hole=0.4,
        marker=dict(colors=colors),
        textinfo="label+percent",
        textposition="outside",
    ))
    fig.update_layout(
        height=320,
        margin=dict(t=10, b=0),
        showlegend=False,
    )
    st.plotly_chart(fig, width='stretch')


# ══════════════════════════════════════════════════════════════════
# 第五层：逐轮明细表
# ══════════════════════════════════════════════════════════════════

def _detail_table(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    label_a: str,
    label_b: str,
) -> None:
    """Token 消耗逐轮对比明细表。"""
    st.subheader("📋 逐轮 Token 明细对比")

    # 合并两个 DataFrame，以较长的为准
    max_turns = max(df_a["turn_no"].max(), df_b["turn_no"].max())
    rows = []

    for t in range(1, int(max_turns) + 1):
        ra = df_a[df_a["turn_no"] == t].iloc[0] if t in df_a["turn_no"].values else None
        rb = df_b[df_b["turn_no"] == t].iloc[0] if t in df_b["turn_no"].values else None

        in_a = int(ra["input_tokens"]) if ra is not None else None
        in_b = int(rb["input_tokens"]) if rb is not None else None
        out_a = int(ra["output_tokens"]) if ra is not None else None
        out_b = int(rb["output_tokens"]) if rb is not None else None

        rows.append({
            "Turn": t,
            f"{label_a} Input": f"{in_a:,}" if in_a is not None else "—",
            f"{label_b} Input": f"{in_b:,}" if in_b is not None else "—",
            "Δ Input": _delta_str(in_a, in_b, True) if in_a is not None and in_b is not None else "—",
            f"{label_a} Output": f"{out_a:,}" if out_a is not None else "—",
            f"{label_b} Output": f"{out_b:,}" if out_b is not None else "—",
            "Δ Output": _delta_str(out_a, out_b, True) if out_a is not None and out_b is not None else "—",
            f"{label_a} CacheRead": f"{int(ra['cache_read']):,}" if ra is not None and ra.get("cache_read") else "0",
            f"{label_b} CacheRead": f"{int(rb['cache_read']):,}" if rb is not None and rb.get("cache_read") else "0",
        })

    st.dataframe(
        pd.DataFrame(rows),
        hide_index=True,
        width='stretch',
        height=min(600, len(rows) * 35 + 38),
    )

    # 导出
    st.download_button(
        "📥 导出对比明细 CSV",
        pd.DataFrame(rows).to_csv(index=False).encode("utf-8"),
        "token_comparison.csv",
        "text/csv",
    )


# ══════════════════════════════════════════════════════════════════
# 辅助函数
# ══════════════════════════════════════════════════════════════════

def _build_turns_df(result: ParseResult) -> pd.DataFrame:
    if not result.turns:
        return pd.DataFrame()
    return pd.DataFrame([t.__dict__ for t in result.turns])


def _build_tools_df(result: ParseResult) -> pd.DataFrame:
    if not result.tool_calls:
        return pd.DataFrame()
    rows = []
    for tc in result.tool_calls:
        d = tc.__dict__.copy()
        d["_input_dict"] = tc.input
        d["input"] = json.dumps(tc.input, ensure_ascii=False, indent=2)
        rows.append(d)
    return pd.DataFrame(rows)


def _delta_str(val_a: int | float | None, val_b: int | float | None, lower_better: bool) -> str:
    """生成带箭头的 Delta 字符串。"""
    if val_a is None or val_b is None or val_a == 0:
        return "—"
    delta = val_b - val_a
    pct = delta / val_a * 100
    if abs(pct) < 0.1:
        return "→ 持平"
    arrow = "↓" if delta < 0 else "↑"
    improved = (delta < 0 and lower_better) or (delta > 0 and not lower_better)
    return f"{arrow} {abs(pct):.1f}% {'✅' if improved else '⚠️'}"


def _delta_pct(val_a: int | float, val_b: int | float) -> str:
    """简洁的百分比变化。"""
    if not val_a:
        return "—"
    delta = (val_b - val_a) / val_a * 100
    if abs(delta) < 0.1:
        return "持平"
    arrow = "↓" if delta < 0 else "↑"
    return f"{arrow} {abs(delta):.1f}%"


def _fmt_dur(ms: float) -> str:
    if not ms:
        return "—"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    m, rem = divmod(int(s), 60)
    return f"{m}m {rem}s"


def _value_at_or_near(df: pd.DataFrame, col: str, target_x: int) -> float | None:
    """获取指定 turn 的值，如果不存在则取最接近的值。"""
    if df.empty or col not in df.columns:
        return None
    row = df[df["turn_no"] == target_x]
    if not row.empty:
        return float(row.iloc[0][col])
    # 取最后一个
    return float(df.iloc[-1][col])
