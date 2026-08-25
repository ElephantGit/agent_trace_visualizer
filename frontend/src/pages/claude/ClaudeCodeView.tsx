// Claude Code standalone page — 两种模式：
// - 实时监控（默认）：自动定位并跟随 ~/.claude/projects 下最新的活跃会话
// - 文件模式：事后分析，文件选择面板位于主区域（左侧栏不再显示文件列表）

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveStream, useParse, useTraces } from '../../hooks'
import { buildTimeline } from '../../derive'
import { api } from '../../api/client'
import { FileUpload, ErrorBanner, Info, Pills } from '../../components/ui/primitives'
import type { AgentType, ParseResult, TraceEntry } from '../../api/types'
import ClaudeBody from './ClaudeBody'
import { useQuery } from '@tanstack/react-query'

type PageMode = 'live' | 'file'
type LoadMode = 'browse' | 'upload'

export default function ClaudeCodeView() {
  const [pageMode, setPageMode] = useState<PageMode>('live')
  const [loadMode, setLoadMode] = useState<LoadMode>('browse')
  const [content, setContent] = useState<ArrayBuffer | null>(null)
  const [name, setName] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [livePath, setLivePath] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)

  const startLive = async () => {
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
        <Link className="btn" to="/">← 返回选择页</Link>
        <hr />
        <h3>Claude Code</h3>
        {/* 模式切换：默认实时监控 */}
        <button
          className={`btn ${pageMode === 'live' ? 'btn-primary' : ''}`}
          style={{ width: '100%' }}
          onClick={enterLive}
        >
          🔴 实时监控模式
        </button>
        <button
          className={`btn ${pageMode === 'file' ? 'btn-primary' : ''}`}
          style={{ width: '100%', marginTop: 6 }}
          onClick={enterFile}
        >
          📁 文件模式
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
      </aside>
      <div className="main" id="main">
        {pageMode === 'live' ? (
          livePath ? (
            <LiveMonitor path={livePath} onExit={enterFile} />
          ) : liveError ? (
            <div>
              <Info>未找到正在进行的会话（~/.claude/projects 下没有最近活跃的 transcript）。</Info>
              <p className="muted">
                可以先切换到「📁 文件模式」查看历史记录；或先启动一个 Claude Code 会话后再重试。
              </p>
              <button className="btn" onClick={startLive}>🔄 重新定位</button>
            </div>
          ) : (
            <p className="muted">正在定位当前会话…</p>
          )
        ) : (
          <>
            {/* 文件选择面板（主区域，不再占用左侧栏） */}
            <div className="file-panel">
              <Pills
                options={['交互会话记录', '上传文件']}
                selected={[loadMode === 'browse' ? '交互会话记录' : '上传文件']}
                onChange={(next) => {
                  setLoadMode(next[0] === '上传文件' ? 'upload' : 'browse')
                }}
              />
              {loadMode === 'browse' ? (
                <div>
                  <p className="muted">扫描 ~/.claude/projects 下的 transcript JSONL（按修改时间倒序）</p>
                  {traces.isLoading && <p className="muted">扫描中…</p>}
                  {sorted.length === 0 && !traces.isLoading && (
                    <Info>未找到 transcript 文件。</Info>
                  )}
                  <div className="trace-grid">
                    {sorted.slice(0, 200).map((t: TraceEntry) => (
                      <button
                        key={t.path}
                        className={`btn trace-btn ${t.path === selectedPath ? 'btn-primary' : ''}`}
                        title={t.path}
                        onClick={() => setSelectedPath(t.path)}
                      >
                        {shortTraceLabel(t.path)}
                      </button>
                    ))}
                  </div>
                  {sorted.length > 200 && <p className="muted">… 仅显示前 200 个</p>}
                </div>
              ) : (
                <div>
                  <FileUpload
                    label="上传 stream-json 或 transcript JSONL"
                    onFile={(buf, n) => {
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
              )}
            </div>
            {isLoading && <p className="muted">解析中…</p>}
            {result && <ClaudeBody result={result} />}
            {!result && !isLoading && (
              <p className="muted">
                {loadMode === 'browse' ? '请选择一个 transcript 文件。' : '请先上传一个 trace 文件。'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── 实时监控视图 ─────────────────────────────────────────────

const LIVE_STATUS_LABEL: Record<string, string> = {
  loading: '加载中…',
  live: 'SSE 实时',
  polling: '轮询降级',
  error: '加载失败',
}

/// 会话下拉框的短标签：太长会撑破下拉框固有宽度，截断显示尾部
/// （完整文件名已在横幅标题中展示）。
function shortTraceLabel(path: string): string {
  const rel = path.replace(/^.*\/projects\//, '')
  return rel.length > 52 ? `…${rel.slice(-51)}` : rel
}

function LiveMonitor({ path: initialPath, onExit }: { path: string; onExit: () => void }) {
  const { rawEvents, result, status, paused, path, autoFollow, follow, followLatest, pause, resume } =
    useLiveStream(initialPath)
  const model = useMemo(() => buildTimeline(rawEvents), [rawEvents])
  const traces = useTraces(undefined)
  const recent = useMemo(
    () => [...(traces.data ?? [])].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10),
    [traces.data],
  )

  return (
    <div>
      <div className="live-banner">
        <span className="live-dot" />
        <span className="live-title">
          LIVE · {path?.split('/').pop()} · {model.events.length} 个事件 ·{' '}
          {LIVE_STATUS_LABEL[status] ?? status}
          {paused ? ' · 已暂停' : ''}
        </span>
        <select
          className="pill-input"
          value={autoFollow ? '__auto__' : (path ?? '__auto__')}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__auto__') followLatest()
            else follow(v)
          }}
        >
          <option value="__auto__">🔄 自动跟随最新会话</option>
          {recent.map((t) => (
            <option key={t.path} value={t.path}>
              {shortTraceLabel(t.path)}
            </option>
          ))}
        </select>
        <button className="btn" onClick={paused ? resume : pause}>
          {paused ? '▶ 恢复' : '⏸ 暂停'}
        </button>
        <button className="btn" onClick={onExit}>
          退出实时
        </button>
      </div>
      <p className="muted" style={{ margin: '6px 0' }}>
        {autoFollow
          ? '自动跟随中：监控最新的活跃会话；当其他会话更活跃时自动切换（当前会话 10s 无新事件时触发）。也可在上方手动固定某个会话。'
          : '已固定监控上方选中的会话；可切回「🔄 自动跟随最新会话」。'}
      </p>
      {status === 'loading' && <p className="muted">正在加载会话内容…</p>}
      {status === 'error' && <p className="muted">会话加载失败，请检查文件是否存在。</p>}
      {result && (
        <ClaudeBody result={result} live={!paused} liveEvents={rawEvents} initialTab="timeline" />
      )}
    </div>
  )
}
