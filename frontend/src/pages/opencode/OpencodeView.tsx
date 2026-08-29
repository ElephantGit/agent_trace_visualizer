// Opencode standalone page — 插件模式：
// - 实时监控（默认）：面板绑定的当前会话（宿主代读 + wasm 解析）
// - 会话列表模式：宿主代扫的历史会话，点击行按会话 id 解析（宿主校验成员资格）

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTraces } from '../../hooks'
import { api, errMsg } from '../../api/client'
import { DEFAULT_OPENCODE_REF, OPENCODE_AGENT_REFS } from '../../api/agents'
import LiveMonitor from '../../components/LiveMonitor'
import SessionTable from '../../components/SessionTable'
import AgentSwitcher from '../../components/AgentSwitcher'
import { ErrorBanner, Info } from '../../components/ui/primitives'
import type { ParseResult, TraceEntry } from '../../api/types'
import OpencodeBody from './OpencodeBody'
import { useQuery } from '@tanstack/react-query'

type PageMode = 'live' | 'file'

export default function OpencodeView() {
  const [pageMode, setPageMode] = useState<PageMode>('live')
  const [selected, setSelected] = useState<TraceEntry | null>(null)

  // 全量列表（条目自带宿主 agent 引用），客户端过滤 opencode 系（opencode/nga）。
  const traces = useTraces()
  const pathResult = useQuery({
    queryKey: ['parse-session', selected?.agent ?? '', selected?.sessionId ?? ''],
    queryFn: () =>
      api.parseSession({
        agent: selected!.agent ?? DEFAULT_OPENCODE_REF,
        sessionId: selected!.sessionId,
      }),
    enabled: !!selected,
  })

  const result: ParseResult | undefined = pathResult.data
  const error = pathResult.error
  const isLoading = pathResult.isLoading

  const sorted = useMemo(
    () =>
      [...(traces.data ?? [])]
        .filter((t) => OPENCODE_AGENT_REFS.includes(t.agent ?? ''))
        .sort((a: TraceEntry, b: TraceEntry) => b.mtimeMs - a.mtimeMs),
    [traces.data],
  )

  return (
    <div className="page shell">
      <aside className="sidebar">
        <div className="sidebar-main">
          <Link className="btn" to="/">← 返回选择页</Link>
          <hr />
          <h3>Opencode</h3>
          <button
            className={`btn ${pageMode === 'live' ? 'btn-primary' : ''}`}
            style={{ width: '100%' }}
            onClick={() => setPageMode('live')}
          >
            🔴 Live
          </button>
          <button
            className={`btn ${pageMode === 'file' ? 'btn-primary' : ''}`}
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => {
              setSelected(null)
              setPageMode('file')
            }}
          >
            📁 会话列表
          </button>
          <hr />
          {pageMode === 'live' ? (
            <p className="muted">
              监控面板绑定的当前会话：trace 由部署的 trace-logger 采集、Ora 宿主代读，解析在插件进程的 wasm 核心内完成。
            </p>
          ) : (
            <p className="muted">浏览历史会话进行事后分析；点击行加载该会话详情。</p>
          )}
          {error && pageMode === 'file' && <ErrorBanner>{errMsg(error)}</ErrorBanner>}
          <hr />
          <Link className="btn" style={{ width: '100%', textAlign: 'center' }} to="/trajectory">
            📊 Trajectory
          </Link>
        </div>
        <AgentSwitcher />
      </aside>
      <div className="main" id="main">
        {pageMode === 'live' ? (
          <LiveMonitor agent="opencode" onExit={() => setPageMode('file')} />
        ) : (
          <>
            {selected ? (
              <>
                <button
                  className="btn"
                  style={{ marginBottom: 12 }}
                  onClick={() => setSelected(null)}
                >
                  ← 返回会话列表
                </button>
                {isLoading && <p className="muted">解析中…</p>}
                {error && <ErrorBanner>{errMsg(error)}</ErrorBanner>}
                {result && 'error' in (result as unknown as Record<string, unknown>) && (
                  <Info>该会话的 trace 尚未生成或不可读，请稍后重试。</Info>
                )}
                {result && !('error' in (result as unknown as Record<string, unknown>)) && (
                  <OpencodeBody
                    result={result}
                    agentRef={selected.agent ?? DEFAULT_OPENCODE_REF}
                    named={{
                      agent: selected.agent ?? DEFAULT_OPENCODE_REF,
                      sessionId: selected.sessionId,
                    }}
                  />
                )}
              </>
            ) : (
              <div className="file-panel">
                <p className="muted">
                  会话列表由 Ora 宿主代扫（按最后活跃时间倒序）；路径从不离开宿主。
                </p>
                {traces.isLoading && <p className="muted">扫描中…</p>}
                {!traces.isLoading && (
                  <SessionTable
                    agent="opencode"
                    traces={sorted.slice(0, 200)}
                    selected={null}
                    onSelect={setSelected}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
