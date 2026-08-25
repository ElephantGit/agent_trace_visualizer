// Opencode standalone page — 两种模式：
// - 实时监控（默认）：自动定位并跟随 ~/.local/share/opencode/trace 下
//   最新的活跃会话（trace_logger 插件生成的 .ndjson）
// - 文件模式：事后分析，文件选择面板位于主区域

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useParse, useTraces } from '../../hooks'
import { api } from '../../api/client'
import LiveMonitor from '../../components/LiveMonitor'
import TraceLabel from '../../components/TraceLabel'
import { FileUpload, ErrorBanner, Info, Pills } from '../../components/ui/primitives'
import type { AgentType, ParseResult, TraceEntry } from '../../api/types'
import OpencodeBody from './OpencodeBody'
import { useQuery } from '@tanstack/react-query'

type PageMode = 'live' | 'file'
type LoadMode = 'browse' | 'upload'

export default function OpencodeView() {
  const [pageMode, setPageMode] = useState<PageMode>('live')
  const [loadMode, setLoadMode] = useState<LoadMode>('browse')
  const [content, setContent] = useState<ArrayBuffer | null>(null)
  const [name, setName] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [livePath, setLivePath] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)

  const startLive = async () => {
    try {
      const latest = await api.liveLatest('opencode')
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

  const traces = useTraces(undefined, 'opencode')
  const pathResult = useQuery({
    queryKey: ['parse-from-path', selectedPath],
    queryFn: () => api.parseFromPath('opencode' as AgentType, selectedPath!),
    enabled: !!selectedPath,
  })
  const uploadResult = useParse('opencode' as AgentType, content, name)

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
        <h3>Opencode</h3>
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
              监控当前正在进行的会话（自动定位 ~/.local/share/opencode/trace 下最近活跃的
              trace_logger ndjson 文件）。
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
            <LiveMonitor path={livePath} agent="opencode" onExit={enterFile} />
          ) : liveError ? (
            <div>
              <Info>未找到正在进行的会话（opencode trace 目录下没有最近活跃的 ndjson 文件）。</Info>
              <p className="muted">
                可以先切换到「📁 文件模式」查看历史记录；或先启动一个 Opencode 会话后再重试。
              </p>
              <button className="btn" onClick={startLive}>🔄 重新定位</button>
            </div>
          ) : (
            <p className="muted">正在定位当前会话…</p>
          )
        ) : (
          <>
            {/* 文件选择面板（主区域，左侧栏不显示文件列表） */}
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
                  <p className="muted">扫描 ~/.local/share/opencode/trace 下的 ndjson（按修改时间倒序）</p>
                  {traces.isLoading && <p className="muted">扫描中…</p>}
                  {sorted.length === 0 && !traces.isLoading && (
                    <Info>未找到 trace 文件。</Info>
                  )}
                  <div className="trace-grid">
                    {sorted.slice(0, 200).map((t: TraceEntry) => (
                      <button
                        key={t.path}
                        className={`btn trace-btn ${t.path === selectedPath ? 'btn-primary' : ''}`}
                        title={t.path}
                        onClick={() => setSelectedPath(t.path)}
                      >
                        <TraceLabel path={t.path} agent="opencode" />
                      </button>
                    ))}
                  </div>
                  {sorted.length > 200 && <p className="muted">… 仅显示前 200 个</p>}
                </div>
              ) : (
                <div>
                  <FileUpload
                    label="上传 trace-logger 生成的 .ndjson 文件"
                    onFile={(buf, n) => {
                      setContent(buf)
                      setName(n)
                    }}
                  />
                  {name && <p className="muted">已加载：{name}</p>}
                </div>
              )}
            </div>
            {isLoading && <p className="muted">解析中…</p>}
            {result && <OpencodeBody result={result} />}
            {!result && !isLoading && (
              <p className="muted">
                {loadMode === 'browse' ? '请选择一个 trace 文件。' : '请先上传一个 .ndjson trace 文件。'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
