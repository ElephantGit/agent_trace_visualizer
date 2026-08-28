// 会话的可读标签：优先展示宿主提取的会话名（claude = 首个真实
// 用户输入 / opencode = session.start 的 title），附加短 ID 用于区分。

import type { LiveAgent } from '../hooks'

/// 会话 id 的短 ID（claude 是 uuid，opencode 是 ses_xxx）。
export function shortTraceId(sessionId: string): string {
  return sessionId.length > 13 ? `${sessionId.slice(0, 13)}…` : sessionId
}

export default function TraceLabel({
  sessionId,
  agent: _agent,
  name: knownName,
}: {
  sessionId: string
  agent: LiveAgent
  /// 已知会话名（session/list 已返回）
  name?: string | null
}) {
  if (knownName) return <>{`${knownName} · ${shortTraceId(sessionId)}`}</>
  return <>{shortTraceId(sessionId)}</>
}
