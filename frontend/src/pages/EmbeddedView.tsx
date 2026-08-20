// Embedded mode — Ora iframe entry with NO data-source pickers.
// Error copy kept verbatim from legacy app.py render_embedded.

import { useEmbedded } from '../hooks'
import { ErrorBanner, Info, Warning } from '../components/ui/primitives'
import OpencodeBody from './opencode/OpencodeBody'
import ClaudeBody from './claude/ClaudeBody'

export default function EmbeddedView({
  sessionId,
  agentType,
}: {
  sessionId: string
  agentType: string
}) {
  const { data, error, isLoading } = useEmbedded(sessionId, agentType)

  if (isLoading) {
    return <div className="muted">加载中…</div>
  }
  if (error) {
    return <ErrorBanner>{String(error)}</ErrorBanner>
  }
  if (!data) return null

  switch (data.status) {
    case 'ok':
      if (agentType === 'opencode') return <OpencodeBody result={data.result!} embedded />
      if (agentType === 'claude_code') return <ClaudeBody result={data.result!} embedded />
      return <ErrorBanner>{data.message ?? `无嵌入渲染器对应 agent_type：${agentType}`}</ErrorBanner>
    case 'locator_missing':
      return (
        <Warning>
          定位器尚未生成。请先在 Ora 中打开该会话的 dashboard，让 Ora 解析并写入 trace 文件路径。
        </Warning>
      )
    case 'agent_mismatch':
      return <ErrorBanner>{data.message}</ErrorBanner>
    case 'trace_missing':
      return <Info>trace 文件尚未生成或为空——会话进行中或尚未产生事件，稍后再试。</Info>
    case 'parse_empty':
      return <Warning>已读取 trace 文件，但未解析到任何事件。</Warning>
    default:
      return <ErrorBanner>{data.message ?? '不支持的 agent_type'}</ErrorBanner>
  }
}
