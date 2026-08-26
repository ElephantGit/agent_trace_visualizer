// 会话列表表格（文件模式）：会话 / 状态 / 最后活跃时间 / 持续时间 /
// Agent 数量 / 目录；支持搜索、按项目目录过滤、点击状态过滤、
// 按最后活跃时间 / 运行时长排序；点击行加载该会话的详细信息。

import { useMemo, useState } from 'react'
import type { TraceEntry } from '../api/types'
import type { LiveAgent } from '../hooks'
import { useSessionMeta } from '../hooks'
import { formatDuration } from '../derive'
import { Pagination, Info } from './ui/primitives'
import TraceLabel from './TraceLabel'

const PAGE_SIZE = 20
const ACTIVE_WINDOW_MS = 5 * 60 * 1000

type SortKey = 'mtime' | 'duration'
type StatusFilter = 'all' | 'active' | 'ended'

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const isActive = (t: TraceEntry) => Date.now() - t.mtimeMs <= ACTIVE_WINDOW_MS

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
  const [keyword, setKeyword] = useState('')
  const [dirFilter, setDirFilter] = useState<string>('__all__')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('mtime')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')

  const directories = useMemo(
    () =>
      [...new Set(traces.map((t) => t.directory).filter((d): d is string => !!d && d.length > 0))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [traces],
  )

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const out = traces.filter((t) => {
      if (status !== 'all' && isActive(t) !== (status === 'active')) return false
      if (dirFilter !== '__all__' && t.directory !== dirFilter) return false
      if (kw) {
        const hay = `${t.name ?? ''} ${t.path} ${t.directory ?? ''}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
    out.sort((a, b) => {
      if (sortKey === 'mtime') {
        return sortDir === 'desc' ? b.mtimeMs - a.mtimeMs : a.mtimeMs - b.mtimeMs
      }
      const da = a.durationMs ?? -1
      const db = b.durationMs ?? -1
      return sortDir === 'desc' ? db - da : da - db
    })
    return out
  }, [traces, keyword, dirFilter, status, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * PAGE_SIZE
  const rows = filtered.slice(start, start + PAGE_SIZE)

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ' ⇅')
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(1)
  }

  if (traces.length === 0) {
    return <Info>未找到 trace 文件。</Info>
  }

  return (
    <div>
      {/* 工具栏：搜索 + 目录过滤 + 状态过滤（表头上方） */}
      <div className="session-toolbar">
        <input
          type="text"
          placeholder="🔍 搜索会话名 / 路径 / 目录"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setPage(1)
          }}
          className="pill-input session-search"
        />
        <select
          className="pill-input"
          value={dirFilter}
          onChange={(e) => {
            setDirFilter(e.target.value)
            setPage(1)
          }}
        >
          <option value="__all__">📁 全部目录</option>
          {directories.map((d) => (
            <option key={d} value={d}>
              {d.length > 60 ? `…${d.slice(-59)}` : d}
            </option>
          ))}
        </select>
        <div className="pills" style={{ margin: 0 }}>
          <button
            className={`pill ${status === 'all' ? 'pill-active' : ''}`}
            onClick={() => {
              setStatus('all')
              setPage(1)
            }}
          >
            全部
          </button>
          <button
            className={`pill ${status === 'active' ? 'pill-active' : ''}`}
            onClick={() => {
              setStatus('active')
              setPage(1)
            }}
          >
            ● 进行中
          </button>
          <button
            className={`pill ${status === 'ended' ? 'pill-active' : ''}`}
            onClick={() => {
              setStatus('ended')
              setPage(1)
            }}
          >
            已结束
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Info>没有匹配的会话，请调整搜索或过滤条件。</Info>
      ) : (
        <>
          <div className="table-wrap">
            <table className="session-table">
              <thead>
                <tr>
                  <th>会话</th>
                  <th>状态</th>
                  <th className="session-sortable" onClick={() => toggleSort('mtime')}>
                    最后活跃时间{sortIndicator('mtime')}
                  </th>
                  <th className="session-sortable" onClick={() => toggleSort('duration')}>
                    持续时间{sortIndicator('duration')}
                  </th>
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
            total={filtered.length}
            start={start + 1}
            end={Math.min(start + PAGE_SIZE, filtered.length)}
            onPage={setPage}
          />
        </>
      )}
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
  const active = isActive(t)
  const durationMs = t.durationMs

  return (
    <tr
      className={`session-row ${selected ? 'session-row-selected' : ''}`}
      onClick={onClick}
      title={t.path}
    >
      <td className="session-name">
        <TraceLabel path={t.path} agent={agent} name={t.name} />
      </td>
      <td>
        {active ? (
          <span className="badge session-live-badge">● 进行中</span>
        ) : (
          <span className="muted">已结束</span>
        )}
      </td>
      <td className="session-time">{fmtTime(t.mtimeMs)}</td>
      <td>{durationMs !== null && durationMs !== undefined ? formatDuration(durationMs) : '—'}</td>
      <td>{meta.data?.agentCount ?? '—'}</td>
      <td className="session-dir" title={t.directory ?? undefined}>
        {t.directory ?? '—'}
      </td>
    </tr>
  )
}
