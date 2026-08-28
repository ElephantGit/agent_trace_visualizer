// Embedded mode — 面板绑定会话入口（无数据源选择器）。
// 插件模式下 Ora 已把面板绑定到会话：直接解析绑定会话（宿主代读 + wasm 核心）。

import { useParseSession } from '../hooks'
import { ErrorBanner, Info } from '../components/ui/primitives'
import OpencodeBody from './opencode/OpencodeBody'
import ClaudeBody from './claude/ClaudeBody'

export default function EmbeddedView({
  agentType,
}: {
  sessionId?: string
  agentType: string
}) {
  const { data, error, isLoading } = useParseSession()

  if (isLoading) {
    return <div className="muted">加载中…</div>
  }
  if (error) {
    return <ErrorBanner>{String(error)}</ErrorBanner>
  }
  if (!data) return null

  if ('error' in (data as unknown as Record<string, unknown>)) {
    return <Info>trace 文件尚未生成或为空——会话进行中或尚未产生事件，稍后再试。</Info>
  }
  if (agentType === 'opencode') return <OpencodeBody result={data} embedded />
  if (agentType === 'claude_code') return <ClaudeBody result={data} embedded />
  return <ErrorBanner>{`无嵌入渲染器对应 agent_type：${agentType}`}</ErrorBanner>
}
