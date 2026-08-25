// 会话列表表格（文件模式）：会话 / 状态 / 最后活跃时间 / 持续时间 /
// Agent 数量 / 目录；点击行加载该会话的详细信息。

import { useState } from 'react'
import type { TraceEntry } from '../api/types'
import type { LiveAgent } from '../hooks'
import { useSessionMeta } from '../hooks'
import { formatDuration } from '../derive'
import { Pagination, Info } from './ui/primitives'
import TraceLabel from './TraceLabel'

const PAGE_SIZE = 20

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function SessionTable({
  agent,
  traces,
  selected,
  onSelect,
}: {
  agent: LiveAgent
  traces: TraceEntry[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  const [page, setPage] = useState(1)
  if (traces.length === 0) {
    return <Info>未找到 trace 文件。</Info>
  }

  const totalPages = Math.max(1, Math.ceil(traces.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * PAGE_SIZE
  const rows = traces.slice(start, start + PAGE_SIZE)

  return (
    <div>
      <div className="table-wrap">
        <table className="session-table">
          <thead>
            <tr>
              <th>会话</th>
              <th>状态</th>
              <th>最后活跃时间</th>
              <th>持续时间</th>
              <th>Agent 数量</th>
              <th>目录</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <SessionRow
                key={t.path}
                agent={agent}
                t={t}
                selected={selected === t.path}
                onClick={() => onSelect(t.path)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={safePage}
        totalPages={totalPages}
        total={traces.length}
        start={start + 1}
        end={Math.min(start + PAGE_SIZE, traces.length)}
        onPage={setPage}
      />
    </div>
  )
}

function SessionRow({
  agent,
  t,
  selected,
  onClick,
}: {
  agent: LiveAgent
  t: TraceEntry
  selected: boolean
  onClick: () => void
}) {
  const meta = useSessionMeta(t.path, agent)
  const active = meta.data?.active
  const durationMs = meta.data?.durationMs
  const directory = meta.data?.directory

  return (
    <tr
      className={`session-row ${selected ? 'session-row-selected' : ''}`}
      onClick={onClick}
      title={t.path}
    >
      <td className="session-name">
        <TraceLabel path={t.path} agent={agent} />
      </td>
      <td>
        {active === undefined ? (
          <span className="muted">—</span>
        ) : active ? (
          <span className="badge session-live-badge">● 进行中</span>
        ) : (
          <span className="muted">已结束</span>
        )}
      </td>
      <td className="session-time">{fmtTime(t.mtimeMs)}</td>
      <td>{durationMs !== null && durationMs !== undefined ? formatDuration(durationMs) : '—'}</td>
      <td>{meta.data?.agentCount ?? '—'}</td>
      <td className="session-dir" title={directory ?? undefined}>
        {directory ?? '—'}
      </td>
    </tr>
  )
}
