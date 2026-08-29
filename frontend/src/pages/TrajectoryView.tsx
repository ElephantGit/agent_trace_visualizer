// Trajectory 数据搜集页：聚合当前用户所有本地 agent（Claude Code +
// Opencode）的会话，支持按 Agent / 状态 / 目录筛选、关键词搜索与排序；
// 点击行加载该会话的详细信息。

import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, errMsg } from '../api/client'
import { DEFAULT_CLAUDE_REF, DEFAULT_OPENCODE_REF } from '../api/agents'
import { useTrajectory } from '../hooks'
import type { ParseResult, TraceEntry } from '../api/types'
import SessionTable from '../components/SessionTable'
import AgentSwitcher from '../components/AgentSwitcher'
import { ErrorBanner, Info } from '../components/ui/primitives'
import ClaudeBody from './claude/ClaudeBody'
import OpencodeBody from './opencode/OpencodeBody'

export default function TrajectoryView() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<TraceEntry | null>(null)
  // 聚合列表：一次全量宿主列表（条目自带 agent 引用）
  const merged = useTrajectory()
  const entries = merged.data

  // 返回上一页（从侧栏按钮进入时为对应 agent 页；直接打开则回 landing）
  const goBack = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  const selectedResult = useQuery({
    queryKey: ['parse-session', selected?.agent, selected?.sessionId],
    queryFn: () =>
      api.parseSession({
        agent: selected!.agent ?? DEFAULT_CLAUDE_REF,
        sessionId: selected!.sessionId,
      }),
    enabled: !!selected,
  })

  const entriesSorted = useMemo(
    () => [...(entries ?? [])].sort((a: TraceEntry, b: TraceEntry) => b.mtimeMs - a.mtimeMs),
    [entries],
  )

  return (
    <div className="page shell">
      <aside className="sidebar">
        <div className="sidebar-main">
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={goBack}>
            ← 返回
          </button>
          <Link className="btn" to="/" style={{ width: '100%', marginTop: 6 }}>返回选择页</Link>
          <hr />
          <h3>📊 Trajectory </h3>
          <p className="muted">
            聚合当前用户所有本地 agent（Claude Code / Opencode）的会话，支持筛选与搜索。
            Gemini 的 telemetry 为手动上传日志，无本地目录可自动收集。
          </p>
          {merged.isError && <ErrorBanner>{errMsg(merged.error)}</ErrorBanner>}
        </div>
        <AgentSwitcher />
      </aside>
      <div className="main" id="main">
        {selected ? (
          // 会话详情模式：只显示详情 + 返回按钮
          <>
            <button className="btn" style={{ marginBottom: 12 }} onClick={() => setSelected(null)}>
              ← 返回会话列表
            </button>
            {selectedResult.isLoading && <p className="muted">解析中…</p>}
            {selectedResult.error && <ErrorBanner>{errMsg(selectedResult.error)}</ErrorBanner>}
            {selectedResult.data &&
              ((selectedResult.data as ParseResult).source === 'opencode' ? (
                <OpencodeBody
                  result={selectedResult.data as ParseResult}
                  agentRef={selected.agent ?? DEFAULT_OPENCODE_REF}
                  named={{
                    agent: selected.agent ?? DEFAULT_OPENCODE_REF,
                    sessionId: selected.sessionId,
                  }}
                />
              ) : (
                <ClaudeBody
                  result={selectedResult.data as ParseResult}
                  named={{
                    agent: selected.agent ?? DEFAULT_CLAUDE_REF,
                    sessionId: selected.sessionId,
                  }}
                />
              ))}
          </>
        ) : merged.isLoading ? (
          <p className="muted">聚合会话数据中…</p>
        ) : entriesSorted.length === 0 ? (
          <Info>未找到任何会话记录。</Info>
        ) : (
          <SessionTable
            agent="claude_code"
            traces={entriesSorted}
            selected={null}
            showAgentColumn
            onSelect={setSelected}
          />
        )}
      </div>
    </div>
  )
}
