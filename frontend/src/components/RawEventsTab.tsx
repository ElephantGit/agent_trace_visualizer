// Paginated raw-event viewer with type filter, keyword search, and NDJSON
// export (port of `raw_events_tab` in the legacy shared views).

import { useMemo, useState } from 'react'
import { Expander, NumberInput, Pills, TextInput, DebugJson } from './ui/primitives'
import { download, toNdjson } from '../derive'

const PAGE_SIZE = 50

export default function RawEventsTab({
  rawEvents,
  keyPrefix,
  typeField = 'type',
}: {
  rawEvents: unknown[]
  keyPrefix: string
  typeField?: string
}) {
  const allTypes = useMemo(() => {
    const set = new Set<string>()
    for (const e of rawEvents) {
      const v = (e as Record<string, unknown>)[typeField]
      set.add(v === null || v === undefined ? '' : String(v))
    }
    return [...set].sort()
  }, [rawEvents, typeField])

  const [typeFilter, setTypeFilter] = useState<string[]>(allTypes)
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)

  // keep the filter in sync when the dataset changes
  const activeTypes = typeFilter.filter((t) => allTypes.includes(t))
  const effectiveTypes = activeTypes.length === 0 ? allTypes : activeTypes

  const filtered = useMemo(() => {
    return rawEvents.filter((e) => {
      const rec = e as Record<string, unknown>
      const type = rec[typeField] === null || rec[typeField] === undefined ? '' : String(rec[typeField])
      if (!effectiveTypes.includes(type)) return false
      if (keyword && !JSON.stringify(rec).toLowerCase().includes(keyword.toLowerCase())) return false
      return true
    })
  }, [rawEvents, effectiveTypes, keyword, typeField])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageEvents = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div>
      <Pills
        options={allTypes}
        selected={effectiveTypes}
        onChange={(next) => {
          setTypeFilter(next)
          setPage(1)
        }}
        multi
      />
      <TextInput
        label="关键词搜索"
        value={keyword}
        onChange={(v) => {
          setKeyword(v)
          setPage(1)
        }}
      />
      <p className="muted">匹配 {filtered.length.toLocaleString('en-US')} 条</p>
      <NumberInput label="页码" value={safePage} min={1} max={totalPages} onChange={setPage} />

      {pageEvents.map((evt, i) => {
        const label = String((evt as Record<string, unknown>)[typeField] ?? '?')
        return (
          <Expander key={i} title={label}>
            <DebugJson value={evt} />
          </Expander>
        )
      })}

      <hr />
      <button className="btn" onClick={() => download(`${keyPrefix}_filtered.ndjson`, toNdjson(filtered), 'application/x-ndjson')}>
        📥 下载筛选结果 NDJSON
      </button>
    </div>
  )
}
