"""Claude Code visualization view.

Supports two data sources:
  1. stream-json file  — `claude -p "task" --output-format stream-json > trace.ndjson`
  2. transcript JSONL  — auto-saved to ~/.claude/projects/<hash>/<session>.jsonl
                         during every interactive terminal session (no setup needed)
"""

from __future__ import annotations

import bisect
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from trace_viz.config import SAFE_PALETTE
from trace_viz.models import ParseResult
from trace_viz.parsers.claude_code import parse
from trace_viz.utils import format_duration, mermaid_quote, sanitize_mermaid, to_str
from trace_viz.views.replay import claude_code_to_replay_steps, render_replay
from trace_viz.views.workflow import build_workflow
from trace_viz.views.shared import (
    mermaid_controls,
    raw_events_tab,
    render_mermaid,
    sample_events,
    token_delta_fig,
    token_trend_fig,
    tool_efficiency_table,
    tool_inspector,
    tool_success_rate,
    tool_tiktoken_fig,
)

# ── Transcript root ────────────────────────────────────────────
_TRANSCRIPT_ROOT = Path.home() / ".claude" / "projects"


def render() -> None:
    """Standalone entry point: picks a data source via the sidebar, then renders it."""
    result = _sidebar()
    if result is None:
        _show_quickstart()
        return
    render_body(result)


def render_body(result: ParseResult) -> None:
    """Renders an already-parsed result, shared by the standalone and embedded flows."""
    # ── 缓存衍生数据（避免每次交互重建所有 DataFrame）──────
    cache_key = result.session_info.session_id or str(id(result))
    if st.session_state.get("cc_cache_key") != cache_key:
        st.session_state["cc_cache_key"] = cache_key
        st.session_state["cc_df_tools"] = _build_tools_df(result)
        df_turns = pd.DataFrame(
            [t.__dict__ for t in result.turns]
        ) if result.turns else pd.DataFrame()
        st.session_state["cc_df_turns"] = df_turns
        st.session_state["cc_df_turns_merged"] = _merge_consecutive_turns_df(df_turns)
        # 清除 per-tab 缓存
        st.session_state.pop("cc_mermaid_units", None)
        st.session_state.pop("cc_mermaid_src", None)
        st.session_state.pop("cc_timeline_df", None)

    df_tools = st.session_state["cc_df_tools"]
    df_turns_merged = st.session_state["cc_df_turns_merged"]
    st.session_state["cc_raw_turn_count"] = len(st.session_state["cc_df_turns"])
    is_transcript = result.parse_debug.get("format") == "transcript"

    _sidebar_meta(result)
    _metrics_row(result, df_tools)
    st.markdown("---")

    tabs = ["📜 会话回放", "总览", "Token 趋势", "工具执行", "🤖 Subagent", "成本分析", "原始数据"]
    if is_transcript:
        tabs.insert(3, "时间轴")   # extra tab only available with real timestamps

    tab_objects = st.tabs(tabs)
    idx = 0

    with tab_objects[idx]: _tab_replay(result);                     idx += 1
    with tab_objects[idx]: _tab_overview(result, df_tools);         idx += 1
    with tab_objects[idx]: _tab_tokens(df_turns_merged);            idx += 1
    if is_transcript:
        with tab_objects[idx]: _tab_timeline(result);               idx += 1
    with tab_objects[idx]: _tab_tools(df_tools);                    idx += 1
    with tab_objects[idx]: _tab_subagents(result);                  idx += 1
    with tab_objects[idx]: _tab_cost(result, df_turns_merged);      idx += 1
    with tab_objects[idx]: _tab_raw(result);                        idx += 1

    # Deep-dive outside tabs
    if not df_tools.empty:
        st.markdown("---")
        st.subheader("单个工具深度诊断")
        tool_inspector(df_tools)


# ── Sidebar ────────────────────────────────────────────────────

def _sidebar() -> ParseResult | None:
    with st.sidebar:
        st.markdown("### 数据来源")
        mode = st.radio(
            "选择方式",
            ["交互会话记录（~/.claude）", "上传文件"],
            key="cc_src_mode",
        )

        if mode == "交互会话记录（~/.claude）":
            return _sidebar_transcript()
        else:
            return _sidebar_upload()


def _sidebar_transcript() -> ParseResult | None:
    """Browse ~/.claude/projects/ and let the user pick a session."""
    with st.sidebar:
        custom_root = st.text_input(
            "transcript 目录",
            str(_TRANSCRIPT_ROOT),
            key="cc_root",
        )
        root = Path(custom_root)

        if not root.exists():
            st.warning(f"目录不存在：`{root}`")
            return None

        # ── 缓存文件列表（避免每次 rerun 都 rglob + stat）─────
        root_key = str(root.resolve())
        cache_tag = st.session_state.get("cc_file_cache_tag", "")

        if st.button("🔄 刷新文件列表", key="cc_refresh_files"):
            st.session_state.pop("cc_file_cache", None)

        if st.session_state.get("cc_file_cache_tag") != root_key:
            # Rebuild cache
            all_files = sorted(
                root.rglob("*.jsonl"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )

            def _label(p: Path) -> str:
                try:
                    rel = p.relative_to(root)
                    mtime = datetime.fromtimestamp(p.stat().st_mtime)
                    size = p.stat().st_size
                    return f"{rel.parent.name[:20]}/{p.stem[:18]}  {mtime:%m-%d %H:%M}  {size//1024}KB"
                except Exception:
                    return str(p)

            st.session_state["cc_file_cache"] = {
                "files": all_files,
                "labels": [_label(p) for p in all_files],
            }
            st.session_state["cc_file_cache_tag"] = root_key

        cache = st.session_state["cc_file_cache"]
        all_files: list[Path] = cache["files"]
        labels: list[str] = cache["labels"]

        if not all_files:
            st.info("未找到 `.jsonl` 文件，请确认路径。")
            return None

        chosen_label = st.selectbox(
            f"选择会话（共 {len(all_files)} 个）",
            labels,
            key="cc_session_sel",
        )
        chosen_path = all_files[labels.index(chosen_label)]
        st.caption(str(chosen_path))

        if st.button("加载此会话", type="primary", width='stretch'):
            st.session_state["cc_content"] = chosen_path.read_bytes()
            st.session_state.pop("cc_result", None)
            st.rerun()

        content = st.session_state.get("cc_content")
        if content is None:
            return None

        if "cc_result" not in st.session_state:
            with st.spinner("解析中…"):
                st.session_state["cc_result"] = parse(content)

        return st.session_state.get("cc_result")


def _sidebar_upload() -> ParseResult | None:
    """Accept a manually uploaded JSONL / NDJSON file."""
    with st.sidebar:
        uploaded = st.file_uploader(
            "上传日志文件",
            type=["ndjson", "jsonl", "txt", "json"],
            key="cc_upload",
        )
        st.divider()
        st.markdown("**stream-json 模式生成方法**")
        st.code(
            "claude --output-format stream-json \\\n"
            "  -p \"你的任务\" > trace.ndjson",
            language="bash",
        )

    if uploaded is None:
        return None
    return parse(uploaded.getvalue())


def _sidebar_meta(result: ParseResult) -> None:
    with st.sidebar:
        st.divider()
        st.markdown("### 会话信息")
        si  = result.session_info
        dbg = result.parse_debug
        st.text(f"格式: {dbg.get('format', '?')}")
        if si.model:      st.text(f"模型: {si.model}")
        if si.session_id: st.text(f"Session: {si.session_id[:20]}…")
        if si.title:      st.text(f"目录: …{si.title[-30:]}")
        st.text(f"LLM 轮次: {len(result.turns)}")
        st.text(f"工具调用: {len(result.tool_calls)}")
        if result.total_cost_usd:
            st.text(f"总费用: ${result.total_cost_usd:.4f}")
        if dbg.get("version"):
            st.caption(f"claude v{dbg['version']}")


# ── Metrics row ────────────────────────────────────────────────

def _metrics_row(result: ParseResult, df_tools: pd.DataFrame) -> None:
    ri = result.result_info
    m1, m2, m3, m4, m5, m6 = st.columns(6)
    m1.metric("LLM 推理轮次",     len(result.turns))
    m2.metric("工具调用总数",      len(result.tool_calls))
    m3.metric("峰值 Input Tokens", f"{result.peak_input_tokens:,}" if result.peak_input_tokens else "—")
    m4.metric("总耗时",            format_duration(ri.duration_ms))
    m5.metric("总费用",            f"${result.total_cost_usd:.4f}" if result.total_cost_usd else "—")
    m6.metric("工具调用成功率",     f"{tool_success_rate(df_tools):.1f}%")


# ── DataFrame builders ─────────────────────────────────────────

def _build_tools_df(result: ParseResult) -> pd.DataFrame:
    if not result.tool_calls:
        return pd.DataFrame()
    rows = []
    for tc in result.tool_calls:
        d = tc.__dict__.copy()
        d["_input_dict"] = tc.input
        d["input"]       = json.dumps(tc.input, ensure_ascii=False, indent=2)
        rows.append(d)
    return pd.DataFrame(rows)


def _build_timeline_df(result: ParseResult) -> pd.DataFrame:
    """Extract timestamp-bearing events into a flat DataFrame for the timeline tab.

    Tool results are nested inside user messages (same as stream-json), so we
    emit a separate synthetic "tool_result" row for each one found.
    """
    rows = []
    for evt in result.raw_events:
        ts_raw = evt.get("timestamp")
        if not ts_raw:
            continue
        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
        except Exception:
            continue
        etype = evt.get("type", "")

        if etype == "assistant":
            usage = (evt.get("message") or {}).get("usage") or {}
            in_t  = usage.get("input_tokens", "")
            out_t = usage.get("output_tokens", "")
            rows.append({
                "timestamp": ts,
                "type":      "assistant",
                "label":     f"assistant  in={in_t} out={out_t}",
            })

        elif etype == "user":
            msg         = (evt.get("message") or {})
            raw_content = msg.get("content", [])
            if isinstance(raw_content, str):
                # Plain-text user turn
                rows.append({
                    "timestamp": ts,
                    "type":      "user",
                    "label":     f"user  {raw_content[:40]}",
                })
            elif isinstance(raw_content, list):
                has_tool_result = False
                has_text        = False
                for block in raw_content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type", "")
                    if btype == "tool_result":
                        has_tool_result = True
                        tid = block.get("tool_use_id") or block.get("toolUseId") or ""
                        err = " [ERROR]" if block.get("is_error") else ""
                        rows.append({
                            "timestamp": ts,
                            "type":      "tool_result",
                            "label":     f"tool_result{err}  id={tid[:14]}",
                        })
                    elif btype == "text":
                        has_text = True
                        txt      = block.get("text", "")[:40]
                if has_text and not has_tool_result:
                    rows.append({
                        "timestamp": ts,
                        "type":      "user",
                        "label":     f"user  {txt}",
                    })

    return pd.DataFrame(rows)


# ── Turn 合并工具 ────────────────────────────────────────────

def _merge_consecutive_turns_df(df_turns: pd.DataFrame) -> pd.DataFrame:
    """合并连续 input_tokens 相同的 Turn，消除链式工具调用带来的重复数据点。

    Claude Code transcript 中，多个连续的 assistant event 可能共享相同的
    input_tokens（模型进行链式工具调用时上下文窗口不变）。合并后每个唯一
    input_tokens 只保留一个数据点，output/cache 求和或取最大值。
    """
    if df_turns.empty:
        return df_turns

    rows: list[dict] = []
    for _, row in df_turns.iterrows():
        in_t = row.get("input_tokens", 0)
        if rows and rows[-1]["input_tokens"] == in_t:
            # 合并到上一个：output/tool_count 求和，cache 取最大值
            prev = rows[-1]
            prev["output_tokens"] = (prev.get("output_tokens", 0)
                                     + row.get("output_tokens", 0))
            prev["tool_count"] = (prev.get("tool_count", 0)
                                  + row.get("tool_count", 0))
            prev["cache_read"] = max(prev.get("cache_read", 0),
                                     row.get("cache_read", 0))
            prev["cache_creation"] = max(prev.get("cache_creation", 0),
                                         row.get("cache_creation", 0))
            # 保留有意义的 text_content
            if row.get("text_content"):
                prev["text_content"] = (prev.get("text_content", "")
                                        + "\n" + str(row["text_content"]))
        else:
            rows.append(dict(row))
    return pd.DataFrame(rows)


# ── Tab 1: Session replay ────────────────────────────────────

def _tab_replay(result: ParseResult) -> None:
    """以时间线形式回放整个会话的完整过程。"""
    steps = claude_code_to_replay_steps(result.raw_events)
    workflow_root = build_workflow(result)
    render_replay(steps, title="📜 Claude Code 会话回放", workflow_root=workflow_root)


# ── Tab 2: Overview ──────────────────────────────────────────

def _tab_overview(result: ParseResult, df_tools: pd.DataFrame) -> None:
    """会话总览：事件分布 + 时序图。"""
    col_l, col_r = st.columns(2)

    with col_l:
        st.subheader("事件类型分布")
        type_counts: dict[str, int] = {}
        for evt in result.raw_events:
            t = evt.get("type", "other")
            type_counts[t] = type_counts.get(t, 0) + 1

        import plotly.express as px
        df_types = pd.DataFrame({
            "type": list(type_counts.keys()),
            "count": list(type_counts.values()),
        }).sort_values("count", ascending=False)
        fig = px.pie(df_types, names="type", values="count", hole=0.4)
        fig.update_traces(textinfo="label+percent+value")
        fig.update_layout(showlegend=False, margin=dict(t=0, b=0))
        st.plotly_chart(fig, width='stretch')

    with col_r:
        st.subheader("工具调用分布")
        if not df_tools.empty:
            tc = df_tools["name"].value_counts().reset_index()
            tc.columns = ["工具名称", "次数"]
            fig2 = px.bar(tc, x="次数", y="工具名称", orientation="h",
                          color="工具名称",
                          color_discrete_sequence=SAFE_PALETTE)
            fig2.update_layout(yaxis=dict(autorange="reversed"),
                               margin=dict(t=0, b=0), showlegend=False)
            st.plotly_chart(fig2, width='stretch')
        else:
            st.info("暂无工具调用")

    st.divider()
    st.subheader("会话时序图")
    is_transcript = result.parse_debug.get("format") == "transcript"
    max_ev, theme, row_h = mermaid_controls(key_prefix="cc_seq")
    # 先合并为原子 unit（保证 tool_use/tool_result 激活配对不被采样打断）
    units = _build_mermaid_units(result.raw_events, is_transcript=is_transcript)
    sampled_units = sample_events(units, max_ev)
    if not sampled_units:
        st.warning("未找到可渲染的关键事件")
    else:
        src = _build_mermaid_from_units(sampled_units, is_transcript=is_transcript)
        render_mermaid(src, theme=theme, row_height=row_h, event_count=len(sampled_units))
        with st.expander("复制 Mermaid 源码"):
            st.code(src, language="text")


# ── Tab 5: Subagents ──────────────────────────────────────────

def _tab_subagents(result: ParseResult) -> None:
    """展示 Claude Code 中通过 task 工具派发的所有 subagent。"""
    # 从 tool_calls 中筛选 task/delegate/subagent/agent 调用（精确匹配）
    _SUBAGENT_NAMES = {"task", "Task", "delegate", "subagent", "agent", "Agent"}
    subagent_calls = [
        tc for tc in result.tool_calls
        if tc.name in _SUBAGENT_NAMES or tc.name.lower() in _SUBAGENT_NAMES
    ]

    if not subagent_calls:
        st.info("本次会话未派发任何 subagent。（Claude Code 中通过 `task` 工具派发子代理）")
        st.caption("提示：如果使用了 `claude -p` 模式（stream-json），subagent 调用信息可能不完整。建议使用交互会话记录（transcript）模式获取完整数据。")
        return

    st.subheader(f"🤖 Subagent 派发概览（共 {len(subagent_calls)} 个）")

    overview_rows = []
    for i, tc in enumerate(subagent_calls):
        inp = tc.input if isinstance(tc.input, dict) else {}
        desc = inp.get("description", "") or inp.get("prompt", "") or "—"
        subagent_type = inp.get("subagent_type", "") or inp.get("type", "") or "task"

        overview_rows.append({
            "序号": i + 1,
            "类型": subagent_type,
            "任务描述": desc[:120] if isinstance(desc, str) else str(desc)[:120],
            "Turn": tc.turn_no,
            "是否出错": "❌ 是" if tc.is_error else "✅ 否",
            "输出大小": f"{tc.output_chars:,} chars",
            "Tiktoken Tokens": f"{tc.tiktoken_tokens:,}",
            "耗时": f"{tc.duration_ms:.0f}ms" if tc.duration_ms else "—",
        })

    df_ov = pd.DataFrame(overview_rows)
    st.dataframe(df_ov, hide_index=True, width='stretch')

    # 逐个展示详情
    st.divider()
    st.subheader("逐个 Subagent 详情")

    for i, tc in enumerate(subagent_calls):
        inp = tc.input if isinstance(tc.input, dict) else {}
        desc = inp.get("description", "") or inp.get("prompt", "") or "(无描述)"
        subagent_type = inp.get("subagent_type", "") or inp.get("type", "") or "task"

        with st.expander(
            f"🤖 Subagent #{i + 1}: {str(desc)[:80]}  "
            f"{'❌' if tc.is_error else '✅'}  "
            f"Turn {tc.turn_no}"
        ):
            col_a, col_b = st.columns(2)
            with col_a:
                st.markdown("**基本信息**")
                st.text(f"类型: {subagent_type}")
                st.text(f"Turn: {tc.turn_no}")
                st.text(f"调用序号: #{tc.call_idx + 1}")
                st.text(f"输出大小: {tc.output_chars:,} chars")
                st.text(f"Tiktoken Tokens: {tc.tiktoken_tokens:,}")
                if tc.duration_ms:
                    st.text(f"耗时: {tc.duration_ms:.0f}ms")
                if tc.file_path:
                    st.text(f"关联文件: {tc.file_path}")
                st.text(f"状态: {'❌ 出错' if tc.is_error else '✅ 成功'}")

            with col_b:
                st.markdown("**任务描述**")
                st.info(desc if desc else "(无)")

            # 输入参数
            with st.expander("📥 输入参数（完整 JSON）", expanded=False):
                st.json(inp)

            # 输出内容
            with st.expander("📤 输出内容", expanded=False):
                if tc.output:
                    st.text_area(
                        "Subagent 输出",
                        value=tc.output,
                        height=400,
                        label_visibility="collapsed",
                    )
                else:
                    st.caption("(无输出)")


# ── Tab 2: Token trends ────────────────────────────────────────

def _tab_tokens(df_turns: pd.DataFrame) -> None:
    if df_turns.empty:
        st.info("暂无 Token 数据（未找到 assistant 事件）")
        return

    raw_count = len(df_turns)
    st.caption(
        f"已合并连续相同 input_tokens 的 Turn。"
        f"原始 {st.session_state.get('cc_raw_turn_count', raw_count)} 个 → "
        f"合并后 {raw_count} 个有效数据点。"
    )

    st.subheader("Input / Output Tokens 趋势")
    fig = token_trend_fig(df_turns)
    # 去掉 fill-to-zero —— Claude Code 的 input_tokens 不是累积增长
    fig.data[0].update(fill=None, name="Input Tokens")
    fig.update_layout(yaxis_title="Tokens（单次调用）")
    st.plotly_chart(fig, width='stretch')

    st.divider()
    st.subheader("Token 增量（上下文变化量）")
    st.caption("正值 = 上下文增长，负值 = context compaction 压缩释放")
    df_delta = df_turns.copy()
    df_delta["_input_delta"] = df_delta["input_tokens"].diff().fillna(0).astype(int)
    fig2 = go.Figure()
    fig2.add_trace(go.Bar(
        x=df_delta.index, y=df_delta["_input_delta"],
        name="Input Δ", marker_color="#1a73e8",
    ))
    fig2.add_trace(go.Bar(
        x=df_delta.index, y=df_delta["output_tokens"],
        name="Output", marker_color="#34a853",
    ))
    fig2.update_layout(
        barmode="group", height=300,
        xaxis_title="有效数据点", yaxis_title="Tokens",
        margin=dict(t=10, b=0),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    )
    st.plotly_chart(fig2, width='stretch')

    if "cache_read" in df_turns.columns and df_turns["cache_read"].sum() > 0:
        st.divider()
        st.subheader("缓存命中率（Cache Read / Input）")
        df_c = df_turns.copy()
        df_c["cache_ratio"] = (
            df_c["cache_read"] / df_c["input_tokens"].replace(0, 1) * 100
        ).round(1)
        fig_cache = go.Figure(go.Bar(
            x=df_c.index, y=df_c["cache_ratio"],
            marker_color="#14b8a6",
            text=df_c["cache_ratio"].apply(lambda v: f"{v:.1f}%"),
            textposition="outside",
        ))
        fig_cache.update_layout(height=280, xaxis_title="有效数据点",
                                yaxis_title="Cache Hit %",
                                margin=dict(t=20, b=0), showlegend=False)
        st.plotly_chart(fig_cache, width='stretch')


# ── Tab 3: Timeline (transcript only) ─────────────────────────

def _tab_timeline(result: ParseResult) -> None:
    st.subheader("消息时间轴（真实时间戳）")
    df_tl = _build_timeline_df(result)
    if df_tl.empty:
        st.info("未找到带时间戳的事件")
        return

    # ── Scatter: all messages on a timeline ───────────────────
    type_color = {
        "user":        "#64748b",
        "assistant":   "#1a73e8",
        "tool_result": "#34a853",
    }
    fig_scatter = px.scatter(
        df_tl, x="timestamp", y="type",
        color="type", color_discrete_map=type_color,
        hover_data={"label": True, "timestamp": False},
        labels={"type": "事件类型", "timestamp": "时间"},
    )
    fig_scatter.update_traces(marker=dict(size=10, opacity=0.8))
    fig_scatter.update_layout(height=240, showlegend=False, margin=dict(t=10, b=0))
    st.plotly_chart(fig_scatter, width='stretch')

    st.divider()

    # ── Per-turn response latency ──────────────────────────────
    st.subheader("LLM 响应延迟（用户发送 → 收到回复）")
    user_ts = df_tl[df_tl["type"] == "user"]["timestamp"].sort_values().tolist()
    asst_ts = df_tl[df_tl["type"] == "assistant"]["timestamp"].sort_values().tolist()

    latency_rows = []
    for i, at in enumerate(asst_ts):
        # 用 bisect 在已排序 user_ts 中找最近的前一条用户消息（O(log U) vs O(U)）
        idx = bisect.bisect_left(user_ts, at)
        if idx > 0:
            delta_s = (at - user_ts[idx - 1]).total_seconds()
            latency_rows.append({"turn": i + 1, "延迟(s)": round(delta_s, 2)})

    if latency_rows:
        df_lat = pd.DataFrame(latency_rows)
        fig_lat = go.Figure(go.Bar(
            x=df_lat["turn"], y=df_lat["延迟(s)"],
            marker_color="#1a73e8",
            text=df_lat["延迟(s)"].apply(lambda v: f"{v:.1f}s"),
            textposition="outside",
        ))
        fig_lat.update_layout(
            height=280, xaxis_title="LLM 推理轮次", yaxis_title="秒",
            margin=dict(t=20, b=0), showlegend=False,
        )
        st.plotly_chart(fig_lat, width='stretch')
    else:
        st.info("轮次过少，无法计算延迟")

    st.divider()

    # ── Full event log ─────────────────────────────────────────
    st.subheader("事件时间明细")
    st.dataframe(
        df_tl.assign(timestamp=df_tl["timestamp"].dt.strftime("%H:%M:%S.%f").str[:-3]),
        width='stretch', height=300,
    )


# ── Tab 4: Tool execution ──────────────────────────────────────

def _tab_tools(df_tools: pd.DataFrame) -> None:
    if df_tools.empty:
        st.info("暂无工具调用记录")
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
        st.plotly_chart(fa, width='stretch')

    with col_b:
        st.subheader("工具输出Token数")
        st.plotly_chart(tool_tiktoken_fig(df_tools), width='stretch')

    st.divider()
    st.subheader("工具效率汇总")
    tool_efficiency_table(df_tools)

# ── Tab 6: Cost analysis ───────────────────────────────────────

def _tab_cost(result: ParseResult, df_turns: pd.DataFrame) -> None:
    st.subheader("Token 构成与费用拆解")
    ri = result.result_info

    if not any([ri.total_input, ri.total_output, ri.total_cost_usd]):
        st.info("当前格式无总费用信息（transcript 模式不含 cost，需通过 Anthropic 控制台查看）")
    else:
        col_a, col_b = st.columns(2)
        with col_a:
            st.subheader("Token 构成")
            labels, vals, colors = [], [], []
            for lbl, v, color in [
                ("Input（非缓存）", ri.total_input - ri.total_cache_read, "#1a73e8"),
                ("Cache Read",      ri.total_cache_read,                  "#14b8a6"),
                ("Cache Creation",  ri.total_cache_creation,              "#a855f7"),
                ("Output",          ri.total_output,                      "#34a853"),
            ]:
                if v and v > 0:
                    labels.append(lbl); vals.append(v); colors.append(color)
            if vals:
                fig_pie = px.pie(
                    pd.DataFrame({"类型": labels, "数量": vals}),
                    names="类型", values="数量", hole=0.4,
                    color_discrete_sequence=colors,
                )
                fig_pie.update_traces(textinfo="label+percent+value")
                fig_pie.update_layout(showlegend=False, margin=dict(t=0, b=0))
                st.plotly_chart(fig_pie, width='stretch')

        with col_b:
            st.subheader("数据明细")
            st.metric("总 Input Tokens",  f"{ri.total_input:,}")
            st.metric("总 Output Tokens", f"{ri.total_output:,}")
            if ri.total_cache_read:     st.metric("Cache Read",     f"{ri.total_cache_read:,}")
            if ri.total_cache_creation: st.metric("Cache Creation", f"{ri.total_cache_creation:,}")
            if ri.total_cost_usd:       st.metric("总费用 (USD)",   f"${ri.total_cost_usd:.6f}")
            if ri.duration_ms:          st.metric("总耗时",          format_duration(ri.duration_ms))
            if ri.duration_api_ms:
                st.metric("API 等待时间", format_duration(ri.duration_api_ms))
                local_ms = ri.duration_ms - ri.duration_api_ms
                if local_ms > 0:
                    st.metric("本地处理时间", format_duration(local_ms))

    if not df_turns.empty:
        st.divider()
        st.subheader("逐轮 Token 明细")
        disp_cols = {
            "turn_no": "Turn", "input_tokens": "Input", "output_tokens": "Output",
            "cache_read": "CacheRead", "cache_creation": "CacheCreation",
            "tool_count": "工具调用数", "stop_reason": "StopReason",
        }
        disp = df_turns[[c for c in disp_cols if c in df_turns.columns]].rename(columns=disp_cols)
        st.dataframe(disp, width='stretch')


# ── Tab 7: Raw data ────────────────────────────────────────────

def _tab_raw(result: ParseResult) -> None:
    st.subheader(f"全部事件（{len(result.raw_events):,} 条）")
    raw_events_tab(result.raw_events, key_prefix="cc_raw", type_field="type")


# ── Mermaid builder ────────────────────────────────────────────

def _iter_content(raw_content: object) -> list[dict]:
    """Normalise a content field into a list of dicts."""
    if isinstance(raw_content, str):
        return [{"type": "text", "text": raw_content}]
    if not isinstance(raw_content, list):
        return []
    out = []
    for item in raw_content:
        if isinstance(item, dict):
            out.append(item)
        elif isinstance(item, str):
            out.append({"type": "text", "text": item})
    return out


def _build_mermaid_units(
    events: list[dict], *, is_transcript: bool
) -> list[dict]:
    """将 raw_events 合并为不可分割的 Mermaid 渲染单元。

    tool_use (+T 激活) 和 tool_result (-T 停用) 必须成对出现在 Mermaid 中，
    否则会报 "Trying to inactivate an inactive participant (T)"。
    这里把每个 tool_use 的触发事件和对应的 tool_result 响应事件合并为一个
    unit，确保采样不会把它们拆开。

    返回 list of dict，每个 unit 包含：
      - kind: "system" | "assistant_text" | "tool_pair" | "user_text" | "result"
      - 相关的事件数据
    """
    # 第一步：建立 tool_use_id → tool_use block 的索引
    tool_use_map: dict[str, dict] = {}  # tool_use_id → {"evt": assistant_event, "block": tool_use_block}
    for evt in events:
        if evt.get("type") != "assistant":
            continue
        for block in _iter_content(evt.get("message", {}).get("content", [])):
            if block.get("type") == "tool_use":
                tid = block.get("id", "")
                if tid:
                    tool_use_map[tid] = {"evt": evt, "block": block}

    # 第二步：扫描所有事件，构建 unit 列表
    units: list[dict] = []
    matched_ids: set[str] = set()

    for evt in events:
        etype = evt.get("type", "")

        if etype == "system":
            units.append({"kind": "system", "event": evt})
            continue

        if etype == "result":
            units.append({"kind": "result", "event": evt})
            continue

        if etype == "assistant":
            # 跳过纯 tool_use 的 assistant（它们会和 tool_result 合并）
            # 只保留有 text 且没有 tool_use 的 assistant
            blocks = _iter_content(evt.get("message", {}).get("content", []))
            text_blocks = [b for b in blocks if b.get("type") == "text"]
            tool_blocks = [b for b in blocks if b.get("type") == "tool_use"]
            has_only_text = text_blocks and not tool_blocks
            if has_only_text:
                units.append({"kind": "assistant_text", "event": evt})
            # 纯 tool_use 的 assistant 被合并到 tool_pair 中处理
            continue

        if etype == "user":
            blocks = _iter_content(evt.get("message", {}).get("content", []))
            tool_results = [b for b in blocks if b.get("type") == "tool_result"]
            text_blocks   = [b for b in blocks if b.get("type") == "text"]

            # 处理 tool_result —— 找到对应的 tool_use
            for tr in tool_results:
                tid = tr.get("tool_use_id") or tr.get("toolUseId") or ""
                if tid in tool_use_map:
                    matched_ids.add(tid)
                    units.append({
                        "kind": "tool_pair",
                        "tool_use": tool_use_map[tid],
                        "tool_result": tr,
                        "user_event": evt,
                    })
                else:
                    # 孤儿 tool_result（没有对应的 tool_use）
                    units.append({
                        "kind": "tool_result_orphan",
                        "tool_result": tr,
                        "user_event": evt,
                    })

            # 孤立的 user text（没有 tool_result 的 user 文本）
            if text_blocks and not tool_results:
                units.append({"kind": "user_text", "event": evt})
            continue

        # 其他事件类型
        if etype == "tool_result":
            # 顶层 tool_result（某些格式可能有）
            tid = evt.get("tool_use_id") or evt.get("toolUseId") or ""
            if tid in tool_use_map:
                matched_ids.add(tid)
                units.append({
                    "kind": "tool_pair",
                    "tool_use": tool_use_map[tid],
                    "tool_result": evt,
                    "user_event": None,
                })

    # 第三步：未匹配的 tool_use（没有 tool_result）作为独立 unit
    for tid, tu in tool_use_map.items():
        if tid not in matched_ids:
            units.append({
                "kind": "tool_use_orphan",
                "tool_use": tu,
            })

    return units


def _build_mermaid_from_units(
    units: list[dict], *, is_transcript: bool
) -> str:
    """从已合并的 unit 列表构建 Mermaid 时序图。"""
    lines = [
        "sequenceDiagram", "    autonumber",
        "    participant U as User",
        "    participant A as Claude",
        "    participant T as Tool",
    ]

    for unit in units:
        kind = unit.get("kind", "")

        if kind == "system":
            evt = unit["event"]
            model = evt.get("model", "Claude")
            lines.append(
                f"    Note over U,T: 会话初始化"
                f" model={sanitize_mermaid(model, 28)}"
            )

        elif kind == "assistant_text":
            evt = unit["event"]
            msg = evt.get("message", {})
            usage = msg.get("usage") or {}
            in_t = usage.get("input_tokens", "")
            out_t = usage.get("output_tokens", "")
            tok_s = f"in={in_t} out={out_t}" if in_t else ""
            ts = _fmt_ts(evt, is_transcript)
            lines.append(
                f"    Note over A: {mermaid_quote('LLM推理 ' + tok_s + ts)}"
            )
            for block in _iter_content(msg.get("content", [])):
                if block.get("type") == "text":
                    txt = sanitize_mermaid(block.get("text", ""), 60)
                    if txt:
                        lines.append(f"    A->>U: {mermaid_quote(txt)}")

        elif kind == "tool_pair":
            tu = unit["tool_use"]
            tr = unit["tool_result"]
            user_evt = unit.get("user_event")
            block = tu["block"]
            name = sanitize_mermaid(block.get("name", "tool"), 25)
            inp = block.get("input") or {}
            hint = sanitize_mermaid(
                to_str(next(iter(inp.values()), "")) if inp else "", 32
            )
            label = name + (f"({hint})" if hint else "")
            lines.append(f"    A->>+T: {mermaid_quote(label)}")

            raw = tr.get("content", "")
            if isinstance(raw, list):
                content_str = "\n".join(
                    (c.get("text", str(c)) if isinstance(c, dict) else str(c))
                    for c in raw
                )
            else:
                content_str = to_str(raw)
            err = " [ERROR]" if tr.get("is_error") else ""
            ts = _fmt_ts(user_evt or {}, is_transcript)
            lines.append(
                f"    T-->>-A: {mermaid_quote(sanitize_mermaid(content_str or 'done', 50) + err + ts)}"
            )

        elif kind == "tool_use_orphan":
            tu = unit["tool_use"]
            block = tu["block"]
            name = sanitize_mermaid(block.get("name", "tool"), 25)
            lines.append(
                f"    Note over A: {mermaid_quote('调用 ' + name + '（无结果）')}"
            )

        elif kind == "tool_result_orphan":
            tr = unit["tool_result"]
            raw = tr.get("content", "")
            if isinstance(raw, list):
                raw = " ".join(
                    (c.get("text", str(c)) if isinstance(c, dict) else str(c))
                    for c in raw
                )
            label = sanitize_mermaid(to_str(raw or "done"), 50)
            lines.append(f"    Note over T: {mermaid_quote(label)}")

        elif kind == "user_text":
            evt = unit["event"]
            ts = _fmt_ts(evt, is_transcript)
            for block in _iter_content(
                evt.get("message", {}).get("content", [])
            ):
                if block.get("type") == "text":
                    txt = sanitize_mermaid(block.get("text", ""), 60)
                    if txt:
                        lines.append(f"    U->>A: {mermaid_quote(txt + ts)}")

        elif kind == "result":
            evt = unit["event"]
            parts = ["任务完成"]
            n_t = evt.get("num_turns", "")
            dur = evt.get("duration_ms", 0)
            cost = evt.get("total_cost_usd", 0)
            if n_t:
                parts.append(f"共{n_t}轮")
            if dur:
                try:
                    parts.append(f"耗时{int(dur) // 1000}s")
                except (TypeError, ValueError):
                    pass
            if cost:
                try:
                    parts.append(f"${float(cost):.4f}")
                except (TypeError, ValueError):
                    pass
            lines.append(f"    A->>U: {mermaid_quote(' '.join(parts))}")

    return "\n".join(lines)


def _fmt_ts(evt: dict, is_transcript: bool) -> str:
    """Format timestamp for Mermaid label, if available."""
    if not is_transcript:
        return ""
    ts_raw = evt.get("timestamp", "")
    if not ts_raw:
        return ""
    try:
        return " " + datetime.fromisoformat(
            ts_raw.replace("Z", "+00:00")
        ).strftime("%H:%M:%S")
    except Exception:
        return ""


# ── Quickstart hint ────────────────────────────────────────────

def _show_quickstart() -> None:
    st.markdown("---")
    col_l, col_r = st.columns(2)

    with col_l:
        st.markdown("#### 交互会话模式（推荐）")
        st.markdown(
            "Claude Code 在每次交互会话中会**自动**把完整对话保存为 JSONL 文件，"
            "无需任何额外配置。"
        )
        st.code(
            "~/.claude/projects/<项目hash>/<session-id>.jsonl",
            language="text",
        )
        st.markdown(
            "在左侧切换到 **交互会话记录** 模式，工具会自动扫描该目录，"
            "选择一个会话即可加载。"
        )
        st.info(
            "每行一条消息，包含 `type`、`timestamp`、`uuid`、"
            "`message`（含 usage）等字段。\n\n"
            "transcript 格式额外提供：\n"
            "- 每条消息的真实时间戳\n"
            "- 工具调用的实际耗时（从时间差计算）\n"
            "- LLM 响应延迟分析"
        )

    with col_r:
        st.markdown("#### `-p` 模式（stream-json）")
        st.markdown("适合非交互式单次任务：")
        st.code(
            "claude --output-format stream-json \\\n"
            "  -p \"你的任务描述\" \\\n"
            "  > claude_trace.ndjson",
            language="bash",
        )
        st.markdown("生成后切换左侧到 **上传文件** 模式加载。")
        st.caption("需要 Claude Code ≥ 1.x。运行 `claude --version` 确认。")
