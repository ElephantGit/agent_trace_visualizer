// Claude Code standalone page: browse ~/.claude/projects transcripts or
// upload a file (port of the legacy sidebar).

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveStream, useParse, useTraces } from '../../hooks'
import { buildTimeline } from '../../derive'
import TimelineView from '../../components/TimelineView'
import { api } from '../../api/client'
import { FileUpload, ErrorBanner, Info, Pills } from '../../components/ui/primitives'
import type { AgentType, ParseResult, TraceEntry } from '../../api/types'
import ClaudeBody from './ClaudeBody'
import { useQuery } from '@tanstack/react-query'

type LoadMode = 'browse' | 'upload'

export default function ClaudeCodeView() {
  const [mode, setMode] = useState<LoadMode>('browse')
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

  const traces = useTraces(undefined)
  const pathResult = useQuery({
    queryKey: ['parse-from-path', selectedPath],
    queryFn: () => api.parseFromPath('claude_code' as AgentType, selectedPath!),
    enabled: !!selectedPath,
  })
  const uploadResult = useParse('claude_code' as AgentType, content, name)

  const result: ParseResult | undefined =
    mode === 'browse' ? pathResult.data : uploadResult.data
  const error = mode === 'browse' ? pathResult.error : uploadResult.error
  const isLoading = mode === 'browse' ? pathResult.isLoading : uploadResult.isLoading

  const sorted = useMemo(
    () => [...(traces.data ?? [])].sort((a: TraceEntry, b: TraceEntry) => b.mtimeMs - a.mtimeMs),
    [traces.data],
  )

  return (
    <div className="page shell">
      <aside className="sidebar">
        <Link className="btn" to="/">← 返回选择页</Link>
        <hr />
        <h3>Claude Code</h3>
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={startLive}>
          🔴 实时监控
        </button>
        {liveError && <p className="muted" style={{ color: '#991b1b' }}>{liveError}</p>}
        <p className="muted">
          监控当前正在进行的会话（自动定位 ~/.claude/projects 下最近活跃的 transcript）
        </p>
        <Pills
          options={['交互会话记录', '上传文件']}
          selected={[mode === 'browse' ? '交互会话记录' : '上传文件']}
          onChange={(next) => {
            setMode(next[0] === '上传文件' ? 'upload' : 'browse')
          }}
        />

        {mode === 'browse' ? (
          <div>
            <p className="muted">扫描 ~/.claude/projects 下的 transcript JSONL（按修改时间倒序）</p>
            {traces.isLoading && <p className="muted">扫描中…</p>}
            {sorted.length === 0 && !traces.isLoading && (
              <Info>未找到 transcript 文件。</Info>
            )}
            <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              {sorted.slice(0, 200).map((t: TraceEntry) => (
                <button
                  key={t.path}
                  className={`btn ${t.path === selectedPath ? 'btn-primary' : ''}`}
                  style={{ display: 'block', width: '100%', textAlign: 'left', margin: '3px 0', fontSize: '0.78em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={t.path}
                  onClick={() => setSelectedPath(t.path)}
                >
                  {t.path.replace(/^.*\/projects\//, '')}
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
        {error && <ErrorBanner>{String(error)}</ErrorBanner>}
      </aside>
      <div className="main">
        {livePath ? (
          <LiveMonitor path={livePath} onExit={() => setLivePath(null)} />
        ) : (
          <>
            {isLoading && <p className="muted">解析中…</p>}
            {result && <ClaudeBody result={result} />}
            {!result && !isLoading && (
              <p className="muted">
                {mode === 'browse' ? '请选择一个 transcript 文件。' : '请先上传一个 trace 文件。'}
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

function LiveMonitor({ path, onExit }: { path: string; onExit: () => void }) {
  const { rawEvents, status, paused, pause, resume } = useLiveStream(path)
  const model = useMemo(() => buildTimeline(rawEvents), [rawEvents])

  return (
    <div>
      <div className="live-banner">
        <span className="live-dot" />
        <span className="live-title">
          LIVE · {path.split('/').pop()} · {model.events.length} 个事件 ·{' '}
          {LIVE_STATUS_LABEL[status] ?? status}
          {paused ? ' · 已暂停' : ''}
        </span>
        <button className="btn" onClick={paused ? resume : pause}>
          {paused ? '▶ 恢复' : '⏸ 暂停'}
        </button>
        <button className="btn" onClick={onExit}>
          退出实时
        </button>
      </div>
      {status === 'loading' && <p className="muted">正在加载会话内容…</p>}
      {status === 'error' && <p className="muted">会话加载失败，请检查文件是否存在。</p>}
      {rawEvents.length > 0 && <TimelineView model={model} live={!paused} />}
    </div>
  )
}
