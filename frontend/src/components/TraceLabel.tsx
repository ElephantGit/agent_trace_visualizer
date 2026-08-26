// trace 文件的可读标签：优先展示后端提取的会话名（claude = 首个真实
// 用户输入 / opencode = session.start 的 title），附加短 ID 用于区分；
// 提取不到时回退为截断后的相对路径。

import { useTraceName, type LiveAgent } from '../hooks'

/// 相对路径的短标签：太长会撑破布局，截断显示尾部。
export function shortTraceLabel(path: string): string {
  const rel = path.replace(/^.*\/projects\//, '')
  return rel.length > 52 ? `…${rel.slice(-51)}` : rel
}

/// 文件名去掉扩展名后的短 ID（claude 是 uuid，opencode 是 ses_xxx）。
export function shortTraceId(path: string): string {
  const base = path.split('/').pop() ?? path
  const stem = base.replace(/\.(jsonl|ndjson)$/, '')
  return stem.length > 13 ? `${stem.slice(0, 13)}…` : stem
}

export default function TraceLabel({
  path,
  agent,
  name: knownName,
}: {
  path: string
  agent: LiveAgent
  /// 已知会话名（如 /api/traces 已返回）——命中时不再发起查询
  name?: string | null
}) {
  const { data } = useTraceName(knownName != null ? null : path, agent)
  const name = knownName ?? data?.name
  if (name) return <>{`${name} · ${shortTraceId(path)}`}</>
  return <>{shortTraceLabel(path)}</>
}
