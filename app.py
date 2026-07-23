"""Trace Visualizer — entry point.

Run with:  streamlit run app.py
"""

from __future__ import annotations

import streamlit as st

from trace_viz.views import claude_code as cc_view
from trace_viz.views import gemini as gem_view
from trace_viz.views import opencode as oc_view

st.set_page_config(page_title="Trace Visualizer", layout="wide")

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

    col1, col2, col3 = st.columns(3)

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

    st.stop()

# ── Dispatch ───────────────────────────────────────────────────
mode = st.session_state.app_mode
if mode == "opencode":
    oc_view.render()
elif mode == "gemini":
    gem_view.render()
elif mode == "claude_code":
    cc_view.render()
else:
    st.session_state.app_mode = None
    st.rerun()
