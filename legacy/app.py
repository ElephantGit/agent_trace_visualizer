"""Trace Visualizer — entry point.

Run with:  streamlit run app.py

When iframed by Ora the URL carries ?session_id=<oraSessionId> and
?agent_type=<opencode|claude_code>; Ora has already resolved the trace file
and written a locator. That embedded path bypasses the landing page and the
sidebar data-source pickers, rendering the trace directly.
"""

from __future__ import annotations

import streamlit as st

from trace_viz import embedded
from trace_viz.views import claude_code as cc_view
from trace_viz.views import compare as cmp_view
from trace_viz.views import gemini as gem_view
from trace_viz.views import opencode as oc_view

# Maps the canonical agent_type Ora hands the dashboard to the view whose
# render_body should draw the parsed trace. agent_type values mirror app_mode.
EMBEDDED_VIEWS = {
    "opencode": oc_view.render_body,
    "claude_code": cc_view.render_body,
}


def render_embedded(session_id: str, agent_type: str) -> None:
    """Renders one Ora-resolved trace inside the iframe, hiding the standalone sidebar."""
    # Collapse Streamlit's own sidebar so the embedded view has the full width;
    # the standalone file pickers are not used in embedded mode.
    st.markdown(
        "<style>[data-testid='stSidebarCollapsedControl'],"
        "[data-testid='stSidebar'][aria-expanded='false']{display:none !important;}</style>",
        unsafe_allow_html=True,
    )

    locator = embedded.load_locator(session_id)
    if locator is None:
        st.warning(
            "定位器尚未生成。请先在 Ora 中打开该会话的 dashboard，让 Ora 解析并写入 trace 文件路径。"
        )
        return
    if locator.agent_type != agent_type:
        st.error(
            f"agent_type 不一致：URL 为 {agent_type}，定位器为 {locator.agent_type}。"
        )
        return
    content = embedded.read_trace_bytes(locator)
    if content is None:
        st.info("trace 文件尚未生成或为空——会话进行中或尚未产生事件，稍后再试。")
        return
    result = embedded.parse_for_agent_type(content, agent_type)
    if result is None:
        st.error(f"不支持的 agent_type：{agent_type}")
        return
    if not result.raw_events:
        st.warning("已读取 trace 文件，但未解析到任何事件。")
        return
    render_body = EMBEDDED_VIEWS.get(agent_type)
    if render_body is None:
        st.error(f"无嵌入渲染器对应 agent_type：{agent_type}")
        return
    render_body(result)


st.set_page_config(page_title="Trace Visualizer", layout="wide")

# ── Embedded dispatch (Ora iframe) ──────────────────────────────
_query = st.query_params
_embedded_session_id = _query.get("session_id") or (_query.get("sessionId") if isinstance(_query, dict) else None)
_embedded_agent_type = _query.get("agent_type") or (_query.get("agentType") if isinstance(_query, dict) else None)
if _embedded_session_id and _embedded_agent_type:
    render_embedded(_embedded_session_id, _embedded_agent_type)
    st.stop()

_direct_app_mode = _query.get("app_mode") or (
    _query.get("appMode") if isinstance(_query, dict) else None
)
if _direct_app_mode == "compare":
    cmp_view.render()
    st.stop()

# ── Session state defaults ─────────────────────────────────────
if "app_mode" not in st.session_state:
    st.session_state.app_mode = None

# ── Global sidebar: back navigation ───────────────────────────
if st.session_state.app_mode is not None:
    with st.sidebar:
        if st.button("← 返回选择页", use_container_width=True):
            st.session_state.clear()
            st.rerun()
        st.divider()

# ── Landing page ───────────────────────────────────────────────
if st.session_state.app_mode is None:
    st.title("Trace Visualizer")
    st.caption("选择要分析的日志格式")
    st.markdown("---")

    col1, col2, col3, col4 = st.columns(4)

    with col1:
        st.markdown("#### Opencode")
        st.markdown("trace-logger 生成的 `.ndjson` 文件")
        if st.button("Opencode 可视化", key="btn_oc", use_container_width=True):
            st.session_state.app_mode = "opencode"
            st.rerun()

    with col2:
        st.markdown("#### Gemini CLI")
        st.markdown("`GEMINI_TELEMETRY_TRACES_ENABLED` 生成的 telemetry.log")
        if st.button("Gemini CLI 可视化", key="btn_gem", use_container_width=True):
            st.session_state.app_mode = "gemini"
            st.rerun()

    with col3:
        st.markdown("#### Claude Code")
        st.markdown("`--output-format stream-json` 生成的流式 NDJSON")
        if st.button("Claude Code 可视化", key="btn_cc", use_container_width=True):
            st.session_state.app_mode = "claude_code"
            st.rerun()

    with col4:
        st.markdown("#### 📊 对比模式")
        st.markdown("加载两份 trace 进行 A/B Token 消耗对比")
        if st.button("Token 对比分析", key="btn_cmp", use_container_width=True):
            st.session_state.app_mode = "compare"
            st.rerun()

    st.stop()

# ── Dispatch ───────────────────────────────────────────────────
mode = st.session_state.app_mode
if mode == "opencode":
    oc_view.render()
elif mode == "gemini":
    gem_view.render()
elif mode == "claude_code":
    cc_view.render()
elif mode == "compare":
    cmp_view.render()
else:
    st.session_state.app_mode = None
    st.rerun()
