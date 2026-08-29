// 实时监控视图（Claude Code / Opencode 共用）：
// 顶部横幅（状态 + 暂停/恢复 + 退出）+ 完整 body（各 agent 的全部 tab
// 随节流刷新实时更新）。插件模式下监控对象即面板绑定的会话：
// 500ms stat 轮询 + 字节偏移增量读取，无 SSE、无文件路径。

import { useMemo } from 'react'
import { useLiveStream, type LiveAgent } from '../hooks'
import { buildTimeline, buildTimelineOpencode } from '../derive'
import ClaudeBody from '../pages/claude/ClaudeBody'
import OpencodeBody from '../pages/opencode/OpencodeBody'

const LIVE_STATUS_LABEL: Record<string, string> = {
  loading: '等待 trace 生成…',
  live: '实时',
  error: '加载失败',
}

export default function LiveMonitor({ agent, onExit }: { agent: LiveAgent; onExit: () => void }) {
  const { rawEvents, result, status, paused, offset, errorMessage, pause, resume } =
    useLiveStream(agent)
  const model = useMemo(
    () => (agent === 'opencode' ? buildTimelineOpencode(rawEvents) : buildTimeline(rawEvents)),
    [agent, rawEvents],
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
          {model.events.length} 个事件 · 已读取 {offset} 字节 · {LIVE_STATUS_LABEL[status] ?? status}
        </span>
        <button className="btn" onClick={paused ? resume : pause}>
          {paused ? '▶ 恢复' : '⏸ 暂停'}
        </button>
        <button className="btn" onClick={onExit}>
          退出实时
        </button>
      </div>
      <p className="muted" style={{ margin: '6px 0' }}>
        监控对象为面板绑定的会话：新事件由宿主代读、按字节偏移增量推送，节流全量解析由插件进程 wasm 核心完成。
      </p>
      {status === 'loading' && <p className="muted">会话刚建立，等待 trace 文件生成…</p>}
      {status === 'error' && (
        <div className="muted" style={{ margin: '6px 0' }}>
          <p>会话加载失败：{errorMessage ?? '未知错误'}</p>
          <p>
            提示：Live 监控需要面板绑定会话——请在聊天会话中打开 dashboard（顶栏 dashboard 按钮
            或扩展面板入口，打开时自动绑定当前会话）。若已从会话打开仍提示未绑定，说明 agent
            尚未接管该会话，等 agent 启动后重新打开面板；浏览历史会话请使用 会话列表。
          </p>
        </div>
      )}
      {body}
    </div>
  )
}
