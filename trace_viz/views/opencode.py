"""Opencode trace visualization view."""

from __future__ import annotations

import json

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from trace_viz.config import OC_COLORS, SAFE_PALETTE
from trace_viz.models import ParseResult
from trace_viz.parsers.opencode import parse
from trace_viz.utils import format_duration, mermaid_quote, sanitize_mermaid, to_str
from trace_viz.views.shared import (
    mermaid_controls,
    render_mermaid,
    sample_events,
    token_delta_fig,
    token_trend_fig,
    tool_efficiency_table,
    tool_inspector,
    tool_tiktoken_fig,
)


def render() -> None:
    """Top-level entry point called from app.py."""
    st.header("Opencode 运行过程可视化工具")
    st.caption("支持并发工具检测、真实 Token 趋势与物理权重分摊算法")

    uploaded = st.sidebar.file_uploader("上传 .ndjson 日志文件", type=["ndjson"])
    if uploaded is None:
        st.info("请在左侧边栏上传由 trace-logger 生成的 `.ndjson` 追踪日志文件。")
        return

    result = parse(uploaded.getvalue())
    if not result.raw_events:
        st.error("未解析到任何事件，请确认文件格式。")
        return

    _sidebar_meta(result)
    _metrics_row(result)
    st.markdown("---")

    df_turns = pd.DataFrame([t.__dict__ for t in result.turns]) if result.turns else pd.DataFrame()
    df_tools = _build_tools_df(result)

    tab1, tab2, tab3, tab4, tab5, tab6 = st.tabs(
        ["总览", "Token 趋势", "工具执行", "工具消耗排行", "时序图", "原始数据"]
    )
    with tab1: _tab_overview(result, df_tools)
    with tab2: _tab_tokens(df_turns)
    with tab3: _tab_tools(df_tools)
    with tab4: _tab_allotment(df_tools)
    with tab5: _tab_sequence(result)
    with tab6: _tab_raw(result, df_turns, df_tools)

    # ── 单个工具深度诊断（位于所有 Tab 之外，页面底部）─────────────
    if not df_tools.empty:
        st.markdown("---")
        st.subheader("单个工具深度诊断")
        tool_inspector(df_tools)


# ── Sidebar ────────────────────────────────────────────────────

def _sidebar_meta(result: ParseResult) -> None:
    with st.sidebar:
        st.markdown("### 会话元数据")
        si = result.session_info
        if si.model:  st.text(f"模型: {si.model}")
        if si.title:  st.text(f"标题: {si.title}")
        st.text(f"总事件数: {len(result.raw_events)}")


# ── Metrics row ────────────────────────────────────────────────

def _metrics_row(result: ParseResult) -> None:
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("总 Steps（LLM 轮次）", len(result.turns))
    m2.metric("工具调用总数",         len(result.tool_calls))
    m3.metric("峰值 Input Tokens",    f"{result.peak_input_tokens:,}")
    m4.metric("Session 总持续时间",    format_duration(result.result_info.duration_ms))


# ── DataFrame builder ──────────────────────────────────────────

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


# ── Tab 1: Overview ────────────────────────────────────────────

def _tab_overview(result: ParseResult, df_tools: pd.DataFrame) -> None:
    col_l, col_r = st.columns(2)

    with col_l:
        st.subheader("事件类型分布")
        types = pd.Series([e.get("type", "") for e in result.raw_events])
        cc = types.value_counts().reset_index()
        cc.columns = ["type", "count"]
        fig = px.pie(cc, names="type", values="count",
                     color="type", color_discrete_map=OC_COLORS, hole=0.4)
        fig.update_traces(textinfo="label+percent+value")
        fig.update_layout(showlegend=False, margin=dict(t=0, b=0))
        st.plotly_chart(fig, use_container_width=True)

    with col_r:
        st.subheader("工具调用分布")
        if not df_tools.empty:
            tc = df_tools["name"].value_counts().reset_index()
            tc.columns = ["工具名称", "次数"]
            fig2 = px.bar(tc, x="次数", y="工具名称", orientation="h",
                          color="工具名称", color_discrete_sequence=SAFE_PALETTE)
            fig2.update_layout(yaxis=dict(autorange="reversed"),
                               margin=dict(t=0, b=0), showlegend=False)
            st.plotly_chart(fig2, use_container_width=True)
        else:
            st.info("暂无工具调用")


# ── Tab 2: Token trends ────────────────────────────────────────

def _tab_tokens(df_turns: pd.DataFrame) -> None:
    if df_turns.empty:
        st.info("暂无 Token 数据")
        return

    # Opencode stores per-step deltas; cumulate cache fields before plotting
    df_plot = df_turns.copy()
    df_plot["cache_read_cum"]     = df_plot["cache_read"].cumsum()
    df_plot["cache_creation_cum"] = df_plot["cache_creation"].cumsum()

    st.subheader("Token 消耗演进趋势")
    fig = token_trend_fig(
        df_plot,
        x_col="turn_no",
        cache_read_col="cache_read_cum",
        cache_creation_col="cache_creation_cum",
        reasoning_col="reasoning_tokens",   # cumsum'd internally
    )
    st.plotly_chart(fig, use_container_width=True)

    st.divider()
    st.subheader("每轮 Token 增量（Step 差值）")
    st.plotly_chart(token_delta_fig(df_turns), use_container_width=True)


# ── Tab 3: Tool execution ──────────────────────────────────────

def _tab_tools(df_tools: pd.DataFrame) -> None:
    if df_tools.empty:
        st.info("暂无工具执行数据")
        return

    col_a, col_b = st.columns(2)

    with col_a:
        st.subheader("各工具调用次数")
        tc = df_tools["name"].value_counts().reset_index()
        tc.columns = ["工具名称", "次数"]
        fa = px.bar(tc, x="工具名称", y="次数", color="工具名称", text="次数",
                    color_discrete_sequence=SAFE_PALETTE)
        fa.update_traces(textposition="outside")
        fa.update_layout(height=320, margin=dict(t=10, b=0), showlegend=False)
        st.plotly_chart(fa, use_container_width=True)

    with col_b:
        st.subheader("各工具耗时（avg / max）")
        dd = df_tools[df_tools["duration_ms"] > 0]
        if not dd.empty:
            ds = dd.groupby("name")["duration_ms"].agg(avg="mean", max="max").reset_index()
            fb = go.Figure()
            fb.add_trace(go.Bar(x=ds["name"], y=ds["avg"], name="平均", marker_color="#34a853"))
            fb.add_trace(go.Bar(x=ds["name"], y=ds["max"], name="最大", marker_color="#ea4335"))
            fb.update_layout(
                barmode="group", height=320, margin=dict(t=10, b=0),
                xaxis_title="工具名称", yaxis_title="ms",
                legend=dict(orientation="h", y=1.1, x=1, xanchor="right"),
            )
            st.plotly_chart(fb, use_container_width=True)
        else:
            st.info("无耗时数据")

    st.divider()
    st.subheader("每次工具调用的 Tiktoken Token 数")
    st.plotly_chart(tool_tiktoken_fig(df_tools), use_container_width=True)

    st.divider()
    st.subheader("工具效率汇总")
    tool_efficiency_table(df_tools)


# ── Tab 4: Token allotment ─────────────────────────────────────

def _tab_allotment(df_tools: pd.DataFrame) -> None:
    st.subheader("按物理权重分摊的工具 Token 消耗排行")
    if df_tools.empty:
        st.info("暂无工具调用")
        return

    agg = (
        df_tools.groupby("name")["allotted_tokens"]
        .sum().reset_index()
        .sort_values("allotted_tokens", ascending=False)
    )
    st.plotly_chart(
        px.bar(agg, x="name", y="allotted_tokens", color="name", text_auto=True,
               labels={"name": "工具名称", "allotted_tokens": "分摊 Token 消耗"}),
        use_container_width=True,
    )

    st.divider()
    col_c, col_d = st.columns(2)

    with col_c:
        st.subheader("工具单次最大 Token 消耗")
        mx = (
            df_tools.groupby("name")["allotted_tokens"]
            .max().reset_index()
            .sort_values("allotted_tokens", ascending=False)
        )
        st.plotly_chart(
            px.bar(mx, x="name", y="allotted_tokens", color="name", text_auto=True,
                   labels={"name": "工具名称", "allotted_tokens": "最大分摊 Token"}),
            use_container_width=True,
        )

    with col_d:
        st.subheader("Tiktoken Tokens vs 分摊 Token 消耗")
        fig_sc = px.scatter(
            df_tools, x="tiktoken_tokens", y="allotted_tokens",
            color="name", hover_data=["turn_no", "output_chars"],
            labels={
                "tiktoken_tokens":  "Tiktoken 估算 Tokens",
                "allotted_tokens":  "分摊 Token",
                "name":             "工具",
            },
            color_discrete_sequence=SAFE_PALETTE,
        )
        fig_sc.update_layout(height=300, margin=dict(t=10, b=0))
        st.plotly_chart(fig_sc, use_container_width=True)

    st.divider()
    st.subheader("逐 Step Token 分摊明细")
    step_agg = (
        df_tools.groupby("turn_no").agg(
            工具数=("name", "count"),
            总分摊Token=("allotted_tokens", "sum"),
            总TiktokenTokens=("tiktoken_tokens", "sum"),
            总输出大小chars=("output_chars", "sum"),
        ).reset_index().rename(columns={"turn_no": "Global Step"})
    )
    st.dataframe(step_agg, use_container_width=True)


# ── Tab 5: Sequence diagram ────────────────────────────────────

def _tab_sequence(result: ParseResult) -> None:
    st.subheader("主要步骤时序图")
    max_ev, theme, row_h = mermaid_controls(key_prefix="oc_seq")

    key_types = {
        "text.user", "text.assistant", "tool.start", "tool.finish",
        "step.start", "step.finish", "session.start", "session.end",
    }
    key_events = [e for e in result.raw_events if e.get("type") in key_types]
    sampled = sample_events(key_events, max_ev)
    if not sampled:
        st.warning("未找到可渲染的关键事件")
        return

    src = _build_mermaid(sampled)
    render_mermaid(src, theme=theme, row_height=row_h, event_count=len(sampled))
    with st.expander("复制 Mermaid 源码"):
        st.code(src, language="text")


# ── Tab 6: Raw data ────────────────────────────────────────────

def _tab_raw(
    result: ParseResult,
    df_turns: pd.DataFrame,
    df_tools: pd.DataFrame,
) -> None:
    df_all = pd.DataFrame(result.raw_events)
    if df_all.empty:
        st.info("无事件数据")
        return

    st.subheader(f"全部事件（{len(df_all):,} 条）")

    all_types = df_all["type"].unique().tolist() if "type" in df_all.columns else []
    type_sel = st.multiselect("事件类型", all_types, default=all_types, key="oc_raw_type")
    kw = st.text_input("关键词搜索", key="oc_raw_kw")

    df_f = df_all[df_all["type"].isin(type_sel)] if type_sel else df_all
    if kw:
        mask = df_f.apply(
            lambda row: any(kw.lower() in str(v).lower() for v in row.values), axis=1
        )
        df_f = df_f[mask]

    st.caption(f"匹配 {len(df_f):,} 条")

    # Compact columnar view (mirrors original)
    display_cols = ["type", "ts", "globalStep", "tool", "toolCallId"]
    available = [c for c in display_cols if c in df_f.columns]
    st.dataframe(
        df_f[available] if available else df_f,
        use_container_width=True,
        height=400,
    )

    # CSV export
    export = df_f.copy()
    for col in export.select_dtypes(include=["object"]).columns:
        export[col] = export[col].apply(
            lambda x: json.dumps(x, ensure_ascii=False) if isinstance(x, (dict, list)) else str(x)
        )
    st.download_button(
        "导出 CSV",
        export.to_csv(index=False).encode("utf-8"),
        "opencode_trace.csv",
        "text/csv",
    )

    st.divider()

    if not df_turns.empty:
        st.subheader("Step 明细")
        st.dataframe(df_turns, use_container_width=True)

    if not df_tools.empty:
        st.subheader("工具调用明细")
        detail_cols = ["turn_no", "name", "duration_ms", "output_chars",
                       "tiktoken_tokens", "allotted_tokens"]
        st.dataframe(
            df_tools[[c for c in detail_cols if c in df_tools.columns]],
            use_container_width=True,
        )


# ── Mermaid builder ────────────────────────────────────────────

def _build_mermaid(events: list[dict]) -> str:
    lines = [
        "sequenceDiagram", "    autonumber",
        "    participant U as User",
        "    participant A as Agent",
        "    participant T as Tool",
    ]
    for evt in events:
        etype = evt.get("type", "")
        if etype == "text.user":
            lines.append(f"    U->>+U: {mermaid_quote(evt.get('text', '')[:60])}")
            lines.append("    U-->>-U: done")
        elif etype == "text.assistant":
            lines.append(f"    A->>+A: {mermaid_quote(evt.get('text', '')[:60])}")
            lines.append("    A-->>-A: done")
        elif etype == "tool.start":
            lines.append(f"    A->>+T: {mermaid_quote(evt.get('tool', 'tool'))}")
        elif etype == "tool.finish":
            err  = " [ERROR]" if evt.get("isError") else ""
            size = evt.get("outputSize", 0)
            lines.append(f"    T-->>-A: {mermaid_quote(f'done size={size}{err}')}")
        elif etype == "step.start":
            lines.append(f"    Note over A: Step {evt.get('globalStep', '?')} start")
        elif etype == "step.finish":
            reason = evt.get("reason", "")
            label  = f"Step {evt.get('globalStep', '?')} end"
            if reason:
                label += f" ({reason})"
            lines.append(f"    Note over A: {label}")
        elif etype == "session.start":
            lines.append("    Note over U,T: session start")
        elif etype == "session.end":
            lines.append("    Note over U,T: session end")
    return "\n".join(lines)
