// 共享时间轴视图：三泳道时间线（可框选时间段过滤）+ 事件列表
// （轮次分组、层级缩进）+ 右侧详情面板（摘要/Payload/Result/Timing/JSON）。
// 只展示三种核心信息：用户输入 / 模型文本输出 / 工具调用+结果。
// 数据由调用方通过 buildTimeline / buildTimelineOpencode 构建。

import { Fragment, useMemo, useRef, useState } from 'react'
import type { TimelineEvent, TimelineModel, TimelineKind } from '../derive'
import { formatDuration, grouped } from '../derive'
import { plotColors } from './Plot'
import { DataTable, DebugJson, Info } from './ui/primitives'

const KIND_COLORS: Record<string, string> = {
  user: '#64748b',
  llm: '#1a73e8',
  tool: '#34a853',
}

const KIND_LABELS: Record<string, string> = {
  user: '用户输入',
  llm: '模型文本',
  tool: '工具',
}

const LANES: { key: TimelineKind; label: string }[] = [
  { key: 'user', label: '输入' },
  { key: 'llm', label: '模型' },
  { key: 'tool', label: '工具' },
]

/// 标尺刻度选档：1s/5s/10s/30s/1m/5m/10m/30m/1h/3h，使刻度数落在 5~15 之间。
function rulerTicks(min: number, max: number): { pct: number; label: string }[] {
  const range = max - min
  if (range <= 0) return []
  const steps = [1000, 5000, 10000, 30000, 60000, 300000, 600000, 1800000, 3600000, 10800000]
  let step = steps[steps.length - 1]
  for (const s of steps) {
    if (range / s <= 15) {
      step = s
      break
    }
  }
  const ticks: { pct: number; label: string }[] = []
  const start = Math.ceil(min / step) * step
  for (let t = start; t <= max; t += step) {
    ticks.push({ pct: ((t - min) / range) * 100, label: formatClock(t) })
  }
  return ticks
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface Brush {
  start_ms: number
  end_ms: number
}

export default function TimelineView({ model }: { model: TimelineModel }) {
  const [kinds, setKinds] = useState<Set<string>>(new Set(['user', 'llm', 'tool']))
  const [keyword, setKeyword] = useState('')
  const [brush, setBrush] = useState<Brush | null>(null)
  const [selected, setSelected] = useState<number | null>(null)

  const toolColors = useMemo(() => {
    const m = new Map<string, string>()
    model.tool_names.forEach((n, i) => m.set(n, plotColors(i)))
    return m
  }, [model.tool_names])

  const filtered = useMemo(
    () =>
      model.events.filter(
        (e) =>
          kinds.has(e.kind) &&
          (!brush || (e.ts_ms >= brush.start_ms && e.ts_ms <= brush.end_ms)) &&
          (!keyword ||
            e.name.toLowerCase().includes(keyword.toLowerCase()) ||
            e.tool_name.toLowerCase().includes(keyword.toLowerCase())),
      ),
    [model, kinds, brush, keyword],
  )

  const selectedEvent = selected !== null ? filtered[selected] : undefined
  const MAX_ROWS = 3000
  const shown = filtered.slice(0, MAX_ROWS)

  const toggleKind = (k: string) => {
    setKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
    setSelected(null)
  }

  const barColor = (e: TimelineEvent) => {
    if (e.kind === 'tool') return toolColors.get(e.tool_name) ?? '#34a853'
    return KIND_COLORS[e.kind] ?? '#94a3b8'
  }

  const durStr = (e: TimelineEvent) => {
    if (e.display_duration_ms === null) return '—'
    const ms = e.display_duration_ms
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`
  }

  const selectByIdx = (i: number) => setSelected(selected === i ? null : i)

  return (
    <div>
      <h3>消息时间轴（真实时间戳）</h3>

      {/* 统计条 */}
      <div className="muted" style={{ marginBottom: 8 }}>
        总时长 {formatDuration(model.stats.total_ms)} · {model.events.length} 个事件 · 输入{' '}
        {model.stats.user_count} · 模型 {model.stats.llm_count} · 工具 {model.stats.tool_count}
        {model.stats.max_latency_ms > 0 &&
          ` · 平均延迟 ${formatDuration(model.stats.avg_latency_ms)} · 最大延迟 ${formatDuration(model.stats.max_latency_ms)}`}
      </div>

      {/* 三泳道时间线（可框选时间段） */}
      <TimelineStrip model={model} toolColors={toolColors} brush={brush} onBrush={setBrush} />

      {/* 过滤工具条（三种类型） */}
      <div className="wf-toolbar">
        <div className="pills" style={{ margin: 0 }}>
          {(['user', 'llm', 'tool'] as const).map((k) => (
            <button key={k} className={`pill ${kinds.has(k) ? 'pill-active' : ''}`} onClick={() => toggleKind(k)}>
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="过滤（名称 / 工具名）"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setSelected(null)
          }}
          className="pill-input wf-search"
        />
        {brush && (
          <button
            className="btn"
            onClick={() => {
              setBrush(null)
              setSelected(null)
            }}
          >
            ✕ 清除时间选择（{formatClock(brush.start_ms)} – {formatClock(brush.end_ms)}）
          </button>
        )}
      </div>

      {/* 列表 + 右侧详情面板 */}
      <div className="wf-layout">
        <div className="wf-list">
          <div className="wf-scroll">
            <table className="wf-table">
              <colgroup>
                <col style={{ width: '44%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '16%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => {
                  // 轮次分割带
                  const prev = i > 0 ? shown[i - 1] : null
                  const isTurnStart = !prev || prev.turn_no !== e.turn_no
                  return (
                    <Fragment key={i}>
                      {isTurnStart && (
                        <tr className="tl-turn-sep">
                          <td colSpan={5}>
                            ━━━ Turn {e.turn_no} ━━━
                            <span className="muted" style={{ marginLeft: 10, fontWeight: 400 }}>
                              {formatClock(e.ts_ms)}
                              {prev && ` · ${e.ts_ms - prev.ts_ms > 0 ? formatDuration(e.ts_ms - prev.ts_ms) : ''} 后`}
                            </span>
                          </td>
                        </tr>
                      )}
                      <tr
                        className={`wf-row ${selected === i ? 'wf-row-selected' : ''} ${e.kind === 'user' ? 'wf-row-turn' : ''}`}
                        data-kind={e.kind}
                        data-depth={e.depth}
                        onClick={() => selectByIdx(i)}
                      >
                        <td className="wf-name" title={e.name} style={{ paddingLeft: 8 + e.depth * 18 }}>
                          <span className="wf-dot" style={{ background: barColor(e) }} />
                          <span className="wf-name-text">{e.name}</span>
                        </td>
                        <td className={`wf-kind wf-kind-${e.kind}`}>{KIND_LABELS[e.kind]}</td>
                        <td className="wf-status" title={e.status}>
                          {e.is_error ? '❌ ' : ''}
                          {e.status}
                        </td>
                        <td className="wf-dur">{durStr(e)}</td>
                        <td className="wf-time">{formatClock(e.ts_ms)}</td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > MAX_ROWS && (
            <p className="muted">
              已截断显示 {MAX_ROWS}/{filtered.length} 条，请用过滤缩小范围。
            </p>
          )}
          {filtered.length === 0 && <Info>没有匹配的事件。</Info>}
        </div>

        {selectedEvent && (
          <TimelineDetail
            key={selected}
            event={selectedEvent}
            label={KIND_LABELS[selectedEvent.kind]}
            color={barColor(selectedEvent)}
            prevTsMs={selected !== null && selected > 0 ? filtered[selected - 1].ts_ms : null}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}

// ── 顶部三泳道时间线（框选）──────────────────────────────────

function TimelineStrip({
  model,
  toolColors,
  brush,
  onBrush,
}: {
  model: TimelineModel
  toolColors: Map<string, string>
  brush: Brush | null
  onBrush: (b: Brush | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ startX: number; curX: number } | null>(null)

  const range = model.max_ts_ms - model.min_ts_ms || 1
  const ticks = rulerTicks(model.min_ts_ms, model.max_ts_ms)
  const dragRef = useRef(drag)
  dragRef.current = drag

  const xToTs = (clientX: number) => {
    const el = ref.current
    if (!el) return model.min_ts_ms
    const rect = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return model.min_ts_ms + frac * range
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ startX: e.clientX, curX: e.clientX })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    setDrag({ startX: dragRef.current.startX, curX: e.clientX })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    setDrag(null)
    if (!d) return
    if (Math.abs(e.clientX - d.startX) < 5) {
      onBrush(null) // 单击 = 清除框选
      return
    }
    const a = xToTs(Math.min(d.startX, e.clientX))
    const b = xToTs(Math.max(d.startX, e.clientX))
    onBrush({ start_ms: a, end_ms: b })
  }

  const pct = (ms: number) => ((ms - model.min_ts_ms) / range) * 100
  const durPct = (ms: number) => (ms / range) * 100

  const brushRect = (() => {
    const active = brush ?? (drag ? { start_ms: xToTs(Math.min(drag.startX, drag.curX)), end_ms: xToTs(Math.max(drag.startX, drag.curX)) } : null)
    if (!active) return null
    return { left: `${pct(active.start_ms)}%`, width: `${Math.max(0, pct(active.end_ms) - pct(active.start_ms))}%` }
  })()

  return (
    <div className="tl-strip-wrap">
      <div className="tl-ruler">
        {ticks.map((t) => (
          <span key={t.label} className="tl-tick" style={{ left: `${t.pct}%` }}>
            <span className="tl-tick-label">{t.label}</span>
          </span>
        ))}
      </div>
      <div
        ref={ref}
        className="tl-strip"
        style={{ cursor: 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {LANES.map((lane) => (
          <div key={lane.key} className="tl-lane">
            <span className="tl-lane-label">{lane.label}</span>
            <div className="tl-lane-track">
              {model.events
                .filter((e) => e.kind === lane.key)
                .map((e, i) => (
                  <div
                    key={i}
                    className={`tl-block ${e.kind === 'tool' && e.duration_ms ? 'tl-block-dur' : ''}`}
                    style={{
                      left: `${pct(e.ts_ms)}%`,
                      width: e.duration_ms
                        ? `${Math.max(durPct(e.duration_ms), 0.15)}%`
                        : '3px',
                      background: e.kind === 'tool' ? toolColors.get(e.tool_name) ?? '#34a853' : KIND_COLORS[e.kind],
                      border: e.is_error ? '1px solid #ef4444' : undefined,
                    }}
                    title={`${e.name}${e.duration_ms !== null ? ` · ${formatDuration(e.duration_ms)}` : ''}`}
                  />
                ))}
            </div>
          </div>
        ))}
        {brushRect && <div className="tl-brush" style={{ left: brushRect.left, width: brushRect.width }} />}
      </div>
      <p className="muted" style={{ fontSize: '0.78em', marginTop: 4 }}>
        在时间线上拖拽可框选时间段过滤下方事件列表；单击清除。
      </p>
    </div>
  )
}

// ── 右侧详情面板（摘要 / Payload / Result / Timing / JSON）────

function TimelineDetail({
  event,
  label,
  color,
  prevTsMs,
  onClose,
}: {
  event: TimelineEvent
  label: string
  color: string
  prevTsMs: number | null
  onClose: () => void
}) {
  const [tab, setTab] = useState('summary')

  // ── 按事件类型归一化的内容（三种类型各有明确语义）──────────
  // 用户输入：主内容 = 输入文本全文（detail.text）
  const userText = event.kind === 'user' && typeof event.detail.text === 'string' ? event.detail.text : null
  // 模型文本：主内容 = 输出文本全文（detail.text）
  const llmText = event.kind === 'llm' && typeof event.detail.text === 'string' ? event.detail.text : null
  // 工具：主内容 = 执行结果（detail.output 已归一化为字符串；
  //       undefined = 无对应结果（孤儿），'' = 空输出）
  const toolHasResult = event.kind === 'tool' && typeof event.detail.output === 'string'
  const toolOutput = toolHasResult ? (event.detail.output as string) : null

  const usage = (event.detail.usage ?? {}) as Record<string, number>
  const usageRows = [
    ['模型', String(event.detail.model ?? '—')],
    ['停止原因', String(event.detail.stop_reason ?? '—')],
    ['Input Tokens', usage.input_tokens !== undefined ? grouped(Number(usage.input_tokens)) : '—'],
    ['Output Tokens', usage.output_tokens !== undefined ? grouped(Number(usage.output_tokens)) : '—'],
    ['Cache Read', usage.cache_read_input_tokens !== undefined ? grouped(Number(usage.cache_read_input_tokens)) : '—'],
    ['Cache Creation', usage.cache_creation_input_tokens !== undefined ? grouped(Number(usage.cache_creation_input_tokens)) : '—'],
    ['LLM 延迟', event.display_duration_ms !== null ? formatDuration(event.display_duration_ms) : '—'],
  ]

  const toolMetaRows = [
    ['工具', event.tool_name || event.name],
    ['状态', event.status || '—'],
    ['真实耗时', event.duration_ms !== null ? formatDuration(event.duration_ms) : '—'],
    ['开始', event.detail.start !== undefined ? new Date(Number(event.detail.start)).toISOString() : event.ts],
    ['结束', event.detail.end !== undefined ? new Date(Number(event.detail.end)).toISOString() : '—'],
    ['Tool ID', String(event.detail.tool_id ?? '—')],
  ]

  const timingRows = [
    ['开始时间', event.ts],
    ['真实耗时', event.duration_ms !== null ? formatDuration(event.duration_ms) : '—'],
    ['LLM 延迟', event.kind === 'llm' && event.display_duration_ms !== null ? formatDuration(event.display_duration_ms) : '—'],
    ['与上一事件间隔', prevTsMs !== null ? formatDuration(Math.max(0, event.ts_ms - prevTsMs)) : '—'],
  ]

  const truncate = (t: string, n = 8000) => (t.length > n ? `${t.slice(0, n)}\n…（已截断，完整内容见 JSON 标签页）` : t)

  return (
    <div className="wf-panel">
      <div className="wf-drawer-head">
        <span style={{ fontWeight: 600 }}>
          <span className="wf-dot" style={{ background: color }} />
          {event.name}
        </span>
        <button className="btn" onClick={onClose}>
          关闭 ✕
        </button>
      </div>
      <div className="tabs" style={{ margin: '6px 10px' }}>
        {[
          { key: 'summary', label: '摘要' },
          { key: 'payload', label: 'Payload' },
          { key: 'result', label: 'Result' },
          { key: 'timing', label: 'Timing' },
          { key: 'json', label: 'JSON' },
        ].map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'tab-active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="wf-panel-body">
        {/* ── 摘要：元信息行 + 按类型的主内容 ─────────────────── */}
        {tab === 'summary' && (
          <div>
            <div className="wf-drawer-meta">
              <span>{label}</span>
              <span>{event.ts}</span>
              {event.display_duration_ms !== null && <span>耗时 {formatDuration(event.display_duration_ms)}</span>}
              {event.status && <span>状态：{event.is_error ? '❌ ' : ''}{event.status}</span>}
            </div>
            {event.kind === 'user' && (
              <>
                <h4>输入内容</h4>
                <pre className="debug-json">{truncate(userText ?? '') || '（空输入）'}</pre>
              </>
            )}
            {event.kind === 'llm' && (
              <>
                <h4>输出内容</h4>
                <pre className="debug-json">{truncate(llmText ?? '') || '（无文本输出）'}</pre>
                <DataTable rows={usageRows.map(([k, v]) => ({ '项目': k, '值': v }))} compact />
              </>
            )}
            {event.kind === 'tool' && (
              <>
                <DataTable rows={toolMetaRows.map(([k, v]) => ({ '项目': k, '值': v }))} compact />
                <h4>输入参数</h4>
                {event.detail.input !== undefined ? (
                  <DebugJson value={event.detail.input} />
                ) : (
                  <p className="muted">（无入参）</p>
                )}
                <h4>输出摘要</h4>
                {toolHasResult ? (
                  <pre className="debug-json">{truncate(toolOutput ?? '', 2000) || '（空输出）'}</pre>
                ) : (
                  <p className="muted">该工具调用没有对应的执行结果。</p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Payload：请求负载（按类型）─────────────────────── */}
        {tab === 'payload' && (
          <div>
            {event.kind === 'user' && (userText ? <pre className="debug-json">{truncate(userText)}</pre> : <p className="muted">（空输入）</p>)}
            {event.kind === 'llm' && <DebugJson value={{ model: event.detail.model, stop_reason: event.detail.stop_reason, usage }} />}
            {event.kind === 'tool' &&
              (event.detail.input !== undefined ? (
                <DebugJson value={event.detail.input} />
              ) : (
                <p className="muted">（无入参）</p>
              ))}
          </div>
        )}

        {/* ── Result：输出结果（按类型）──────────────────────── */}
        {tab === 'result' && (
          <div>
            {event.kind === 'user' && <p className="muted">用户输入事件没有输出内容（输入全文见 Payload 标签页）。</p>}
            {event.kind === 'llm' &&
              (llmText ? <pre className="debug-json">{truncate(llmText)}</pre> : <p className="muted">该模型消息没有文本输出（仅发起了工具调用）。</p>)}
            {event.kind === 'tool' &&
              (!toolHasResult ? (
                <p className="muted">该工具调用没有对应的执行结果。</p>
              ) : toolOutput ? (
                <pre className="debug-json">{truncate(toolOutput)}</pre>
              ) : (
                <p className="muted">（空输出）</p>
              ))}
          </div>
        )}

        {tab === 'timing' && <DataTable rows={timingRows.map(([k, v]) => ({ '项目': k, '值': v }))} />}
        {tab === 'json' && <DebugJson value={event.detail.evt} />}
      </div>
    </div>
  )
}
