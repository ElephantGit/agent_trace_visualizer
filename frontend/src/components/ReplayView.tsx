// Shared session-replay engine — the React version of the legacy HTML
// <details>/<summary> card stream with 11 color-coded categories,
// pagination (50/page), keyword + category filters, and legend chips.

import { useMemo, useState } from 'react'
import type { CategoryStyle, ReplayResponse } from '../api/types'
import { Pagination, Pills, Info } from './ui/primitives'
import ReplayStepCard from './ReplayStepCard'
import WorkflowView from './WorkflowView'

export default function ReplayView({
  data,
  workflowRoot,
  result,
}: {
  data: ReplayResponse
  workflowRoot?: import('../api/types').WorkflowNode | null
  result?: import('../api/types').ParseResult | null
}) {
  const [mode, setMode] = useState<'replay' | 'workflow'>('replay')
  const [selected, setSelected] = useState<string[]>(() =>
    data.categories.map(([key]) => key),
  )
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)

  const styles = useMemo(() => new Map<string, CategoryStyle>(data.categories), [data])
  const present = useMemo(
    () => data.categories.filter(([key]) => data.steps.some((s) => s.category === key)),
    [data],
  )

  const filtered = useMemo(() => {
    const active = new Set(selected)
    return data.steps.filter(
      (s) =>
        active.has(s.category) &&
        (!keyword ||
          JSON.stringify({ ...s, content: s.content }).toLowerCase().includes(keyword.toLowerCase())),
    )
  }, [data.steps, selected, keyword])

  const totalPages = Math.max(1, Math.ceil(filtered.length / data.pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * data.pageSize
  const pageSteps = filtered.slice(start, start + data.pageSize)

  if (data.steps.length === 0) {
    return <Info>暂无会话事件可供回放。</Info>
  }

  const viewSwitch = (
    <div className="pills" style={{ margin: '6px 0' }}>
      <button className={`pill ${mode === 'replay' ? 'pill-active' : ''}`} onClick={() => setMode('replay')}>
        📜 事件回放
      </button>
      <button className={`pill ${mode === 'workflow' ? 'pill-active' : ''}`} onClick={() => setMode('workflow')}>
        🔀 工作流视图
      </button>
    </div>
  )

  if (mode === 'workflow') {
    return (
      <div>
        {viewSwitch}
        <WorkflowView root={workflowRoot ?? null} result={result ?? null} />
      </div>
    )
  }

  return (
    <div>
      {viewSwitch}
      <h3>📜 会话回放</h3>
      <p className="muted">共 {data.steps.length} 个步骤 — 不同颜色代表不同事件类型</p>

      {present.length > 1 && (
        <div className="legend-chips">
          {present.map(([key]) => {
            const s = styles.get(key)!
            const count = data.steps.filter((st) => st.category === key).length
            return (
              <span
                key={key}
                className="legend-chip"
                style={{
                  background: s.header_bg,
                  color: s.text,
                  border: `1px solid ${s.border}`,
                }}
              >
                {s.icon} {s.label} ({count})
              </span>
            )
          })}
        </div>
      )}

      <div className="pills">
        <input
          type="text"
          placeholder="关键词搜索"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setPage(1)
          }}
          className="pill-input"
        />
        <Pills
          options={present.map(([key]) => {
            const s = styles.get(key)!
            const count = data.steps.filter((st) => st.category === key).length
            return `${s.icon} ${s.label} (${count})`
          })}
          selected={selected
            .filter((k) => styles.has(k))
            .map((k) => {
              const s = styles.get(k)!
              const count = data.steps.filter((st) => st.category === k).length
              return `${s.icon} ${s.label} (${count})`
            })}
          onChange={(opts) => {
            setSelected(
              opts
                .map((o) => present.find(([key]) => {
                  const s = styles.get(key)!
                  return o === `${s.icon} ${s.label} (${data.steps.filter((st) => st.category === key).length})`
                })?.[0])
                .filter(Boolean) as string[],
            )
            setPage(1)
          }}
          multi
        />
      </div>

      {selected.length === 0 && <Info>请至少选择一个事件类型以查看回放。</Info>}

      <Pagination
        page={safePage}
        totalPages={totalPages}
        total={filtered.length}
        start={filtered.length === 0 ? 0 : start + 1}
        end={Math.min(start + data.pageSize, filtered.length)}
        onPage={setPage}
      />

      {pageSteps.map((step, i) => (
        <ReplayStepCard key={`${step.seq}-${i}`} step={step} style={styles.get(step.category)} />
      ))}
    </div>
  )
}
