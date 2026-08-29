// Paginated raw-event viewer with type filter, keyword search, and NDJSON
// export (port of `raw_events_tab` in the legacy shared views).

import { useEffect, useMemo, useState } from 'react'
import { Expander, NumberInput, Pills, TextInput, DebugJson } from './ui/primitives'
import { download, toNdjson } from '../derive'
import { api } from '../api/client'

const PAGE_SIZE = 50

/// 原始事件视图：实时路径直接消费 liveEvents（useLiveStream 增量维护）；
/// 浏览/嵌入路径按字节偏移顺序加载（加载更多模型，不整读大文件）。
export default function RawEventsTab({
  keyPrefix,
  typeField = 'type',
  liveEvents,
  named,
}: {
  keyPrefix: string
  typeField?: string
  liveEvents?: unknown[] | null
  /// 浏览模式的命名会话（宿主校验成员资格）；缺省走面板绑定会话
  named?: { agent: string; sessionId: string } | null
}) {
  const [loaded, setLoaded] = useState<unknown[]>([])
  const [offset, setOffset] = useState(0)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const rawEvents = liveEvents ?? loaded

  const loadMore = async () => {
    if (loading || done) return
    setLoading(true)
    try {
      const chunk = await api.readChunk(offset, undefined, undefined, named ?? undefined)
      const events: unknown[] = []
      for (const line of chunk.text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          events.push(JSON.parse(trimmed))
        } catch {
          /* 半行/畸形行跳过 */
        }
      }
      setLoaded((prev) => [...prev, ...events])
      setOffset(chunk.nextOffset)
      setDone(chunk.done)
    } catch {
      /* 单次失败：保持按钮可重试 */
    } finally {
      setLoading(false)
    }
  }

  // 非实时路径：首屏自动加载第一批。
  useEffect(() => {
    if (liveEvents == null && loaded.length === 0 && !done) {
      void loadMore()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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

      {liveEvents == null && !done && (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => void loadMore()}>
          {loading ? '加载中…' : `加载更多（已读 ${loaded.length.toLocaleString('en-US')} 条）`}
        </button>
      )}
      <hr />
      <button className="btn" onClick={() => download(`${keyPrefix}_filtered.ndjson`, toNdjson(filtered), 'application/x-ndjson')}>
        📥 下载筛选结果 NDJSON
      </button>
    </div>
  )
}
