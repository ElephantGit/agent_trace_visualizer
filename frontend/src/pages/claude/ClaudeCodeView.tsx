// Claude Code standalone page — 两种模式：
// - 实时监控（默认）：自动定位并跟随 ~/.claude/projects 下最新的活跃会话
// - 文件模式：事后分析，文件选择面板位于主区域（左侧栏不再显示文件列表）

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useParse, useTraces } from '../../hooks'
import { api } from '../../api/client'
import LiveMonitor from '../../components/LiveMonitor'
import SessionTable from '../../components/SessionTable'
import AgentSwitcher from '../../components/AgentSwitcher'
import { FileUpload, ErrorBanner, Info } from '../../components/ui/primitives'
import type { AgentType, ParseResult, TraceEntry } from '../../api/types'
import ClaudeBody from './ClaudeBody'
import { useQuery } from '@tanstack/react-query'

type PageMode = 'live' | 'file'
type LoadMode = 'browse' | 'upload'

export default function ClaudeCodeView({ initialLivePath }: { initialLivePath?: string } = {}) {
  const [pageMode, setPageMode] = useState<PageMode>('live')
  const [loadMode, setLoadMode] = useState<LoadMode>('browse')
  const [content, setContent] = useState<ArrayBuffer | null>(null)
  const [name, setName] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [livePath, setLivePath] = useState<string | null>(initialLivePath ?? null)
  const [liveError, setLiveError] = useState<string | null>(null)

  const startLive = async () => {
    if (initialLivePath) {
      setLiveError(null)
      setLivePath(initialLivePath)
      return
    }
    try {
      const latest = await api.liveLatest()
      setLiveError(null)
      setLivePath(latest.path)
    } catch (e) {
      setLiveError(String(e))
    }
  }

  // 默认实时监控模式：进入页面（或切回实时模式）时自动定位最新会话
  useEffect(() => {
    if (pageMode === 'live') startLive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageMode])

  const traces = useTraces(undefined)
  const pathResult = useQuery({
    queryKey: ['parse-from-path', selectedPath],
    queryFn: () => api.parseFromPath('claude_code' as AgentType, selectedPath!),
    enabled: !!selectedPath,
  })
  const uploadResult = useParse('claude_code' as AgentType, content, name)

  const result: ParseResult | undefined =
    loadMode === 'browse' ? pathResult.data : uploadResult.data
  const error = loadMode === 'browse' ? pathResult.error : uploadResult.error
  const isLoading = loadMode === 'browse' ? pathResult.isLoading : uploadResult.isLoading

  const sorted = useMemo(
    () => [...(traces.data ?? [])].sort((a: TraceEntry, b: TraceEntry) => b.mtimeMs - a.mtimeMs),
    [traces.data],
  )

  const enterLive = () => {
    setLivePath(null)
    setLiveError(null)
    setPageMode('live')
  }
  const enterFile = () => {
    setLivePath(null)
    setPageMode('file')
  }

  return (
    <div className="page shell">
      <aside className="sidebar">
        {/* 上半部：Live / 会话列表模式切换 + 说明（内容可滚动） */}
        <div className="sidebar-main">
          <Link className="btn" to="/landing">← 返回选择页</Link>
          <hr />
          <h3>Claude Code</h3>
          {/* 模式切换：默认实时监控 */}
          <button
            className={`btn ${pageMode === 'live' ? 'btn-primary' : ''}`}
            style={{ width: '100%' }}
            onClick={enterLive}
          >
            🔴 Live
          </button>
          <button
            className={`btn ${pageMode === 'file' ? 'btn-primary' : ''}`}
            style={{ width: '100%', marginTop: 6 }}
            onClick={enterFile}
          >
            📁 会话列表
          </button>
          <hr />
          {pageMode === 'live' ? (
            <>
              <p className="muted">
                监控当前正在进行的会话（自动定位 ~/.claude/projects 下最近活跃的 transcript）。
              </p>
              {liveError && <p className="muted" style={{ color: '#991b1b' }}>{liveError}</p>}
            </>
          ) : (
            <p className="muted">加载本地 trace 文件进行事后分析，文件选择在主区域。</p>
          )}
          {error && pageMode === 'file' && <ErrorBanner>{String(error)}</ErrorBanner>}
        </div>
        {/* 下半部：agent 切换（常驻底部） */}
        <AgentSwitcher />
      </aside>
      <div className="main" id="main">
        {pageMode === 'live' ? (
          livePath ? (
            <LiveMonitor
              path={livePath}
              agent="claude_code"
              onExit={enterFile}
              initialAutoFollow={!initialLivePath}
            />
          ) : liveError ? (
            <div>
              <Info>未找到正在进行的会话（~/.claude/projects 下没有最近活跃的 transcript）。</Info>
              <p className="muted">
                可以先切换到「📁 会话列表」查看历史记录；或先启动一个 Claude Code 会话后再重试。
              </p>
              <button className="btn" onClick={startLive}>🔄 重新定位</button>
            </div>
          ) : (
            <p className="muted">正在定位当前会话…</p>
          )
        ) : (
          <>
            {selectedPath || content ? (
              // 会话详情模式：只显示详情 + 返回按钮
              <>
                <button
                  className="btn"
                  style={{ marginBottom: 12 }}
                  onClick={() => {
                    setSelectedPath(null)
                    setContent(null)
                    setName('')
                    setLoadMode('browse')
                  }}
                >
                  ← 返回会话列表
                </button>
                {isLoading && <p className="muted">解析中…</p>}
                {error && <ErrorBanner>{String(error)}</ErrorBanner>}
                {result && <ClaudeBody result={result} />}
              </>
            ) : (
              // 会话列表面板（主区域）：点击行加载该会话详情
              <div className="file-panel">
                <p className="muted">扫描 ~/.claude/projects 下的 transcript JSONL（按修改时间倒序）</p>
                {traces.isLoading && <p className="muted">扫描中…</p>}
                {!traces.isLoading && (
                  <SessionTable
                    agent="claude_code"
                    traces={sorted.slice(0, 200)}
                    selected={selectedPath}
                    onSelect={(p) => {
                      setLoadMode('browse')
                      setSelectedPath(p)
                    }}
                  />
                )}
                {sorted.length > 200 && <p className="muted">… 仅显示前 200 个</p>}

                <details className="step-fold" style={{ marginTop: 12 }}>
                  <summary className="step-fold-summary">📤 上传文件分析</summary>
                  <div>
                    <FileUpload
                      label="上传 stream-json 或 transcript JSONL"
                      onFile={(buf, n) => {
                        setLoadMode('upload')
                        setContent(buf)
                        setName(n)
                      }}
                    />
                    {name && <p className="muted">已加载：{name}</p>}
                    <p className="muted" style={{ marginTop: 10 }}>
                      快速生成 stream-json：
                    </p>
                    <pre className="debug-json">{'claude --output-format stream-json \\\n  -p "你的任务描述" \\\n  > claude_trace.ndjson'}</pre>
                  </div>
                </details>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── 实时监控视图（共享组件：components/LiveMonitor.tsx）─────
