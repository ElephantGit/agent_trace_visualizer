// 实时监控视图（Claude Code / Opencode 共用）：
// 顶部横幅（状态 + 会话选择下拉框 + 暂停/恢复 + 退出）+ 完整 body
// （各 agent 的全部 tab 随节流刷新实时更新，时间轴走 SSE 即时路径）。

import { useMemo } from 'react'
import { useLiveStream, useTraces, type LiveAgent } from '../hooks'
import { buildTimeline, buildTimelineOpencode } from '../derive'
import ClaudeBody from '../pages/claude/ClaudeBody'
import OpencodeBody from '../pages/opencode/OpencodeBody'
import TraceLabel from './TraceLabel'

const LIVE_STATUS_LABEL: Record<string, string> = {
  loading: '加载中…',
  live: 'SSE 实时',
  polling: '轮询降级',
  error: '加载失败',
}

export default function LiveMonitor({
  path: initialPath,
  agent,
  onExit,
}: {
  path: string
  agent: LiveAgent
  onExit: () => void
}) {
  const { rawEvents, result, status, paused, path, autoFollow, follow, followLatest, pause, resume } =
    useLiveStream(initialPath, agent)
  const model = useMemo(
    () => (agent === 'opencode' ? buildTimelineOpencode(rawEvents) : buildTimeline(rawEvents)),
    [agent, rawEvents],
  )
  const traces = useTraces(undefined, agent)
  const recent = useMemo(
    () => [...(traces.data ?? [])].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10),
    [traces.data],
  )

  const body = result && (
    agent === 'opencode' ? (
      <OpencodeBody result={result} live={!paused} liveEvents={rawEvents} initialTab="timeline" />
    ) : (
      <ClaudeBody result={result} live={!paused} liveEvents={rawEvents} initialTab="timeline" />
    )
  )

  return (
    <div>
      <div className="live-banner">
        <span className={`live-chip ${paused ? 'live-chip-paused' : ''}`}>
          <span className="live-dot" />
          {paused ? '已暂停' : 'LIVE'}
        </span>
        <span className="live-title">
          {path?.split('/').pop()} · {model.events.length} 个事件 ·{' '}
          {LIVE_STATUS_LABEL[status] ?? status}
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
              <TraceLabel path={t.path} agent={agent} name={t.name} />
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
      {body}
    </div>
  )
}
