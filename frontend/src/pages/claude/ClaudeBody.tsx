// Claude Code view — 7 tabs (+ transcript-only 时间轴). Shared with
// embedded mode.

import { Fragment, useMemo, useRef, useState } from 'react'
import type { ParseResult } from '../../api/types'
import { useMermaid, useReplay, useWorkflowTree } from '../../hooks'
import Plot, { plotColors } from '../../components/Plot'
import MermaidView from '../../components/MermaidView'
import ReplayView from '../../components/ReplayView'
import RawEventsTab from '../../components/RawEventsTab'
import ToolInspector from '../../components/ToolInspector'
import ToolEfficiencyTable from '../../components/ToolEfficiencyTable'
import { Tabs, DataTable, DebugJson, Expander, Info } from '../../components/ui/primitives'
import {
  fmtTok,
  formatDuration,
  shapeTurns,
  mergeConsecutiveTurns,
  buildTimeline,
  grouped,
} from '../../derive'

export default function ClaudeBody({
  result,
  embedded = false,
}: {
  result: ParseResult
  embedded?: boolean
}) {
  const isTranscript = result.parse_debug.format === 'transcript'
  const [tab, setTab] = useState('replay')
  const replay = useReplay('claude_code', result.raw_events)
  const workflowTree = useWorkflowTree(result)
  const mermaid = useMermaid({
    kind: 'sequence-claude',
    rawEvents: result.raw_events,
    isTranscript,
    maxEvents: 60,
    seed: 42,
  })

  const tabs = useMemo(() => {
    const base = [
      { key: 'replay', label: '📜 会话回放' },
      { key: 'overview', label: '总览' },
      { key: 'tokens', label: 'Token 趋势' },
    ]
    if (isTranscript) base.push({ key: 'timeline', label: '时间轴' })
    base.push(
      { key: 'tools', label: '工具执行' },
      { key: 'subagent', label: '🤖 Subagent' },
      { key: 'cost', label: '成本分析' },
      { key: 'raw', label: '原始数据' },
    )
    return base
  }, [isTranscript])

  const overview = useMemo(() => {
    const eventTypes = new Map<string, number>()
    for (const raw of result.raw_events) {
      const t = String((raw as Record<string, unknown>).type ?? '?')
      eventTypes.set(t, (eventTypes.get(t) ?? 0) + 1)
    }
    const toolCounts = new Map<string, number>()
    for (const tc of result.tool_calls) toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1)
    return {
      eventTypes: [...eventTypes.entries()].sort((a, b) => b[1] - a[1]),
      toolCounts: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]),
    }
  }, [result])

  return (
    <div className="page">
      <h2>Claude Code 可视化</h2>
      <div className="muted" style={{ marginBottom: 6 }}>
        {isTranscript ? '交互会话记录（transcript JSONL）' : 'stream-json 流式输出'}
        {result.parse_debug.cwd ? ` · cwd: ${String(result.parse_debug.cwd)}` : ''}
        {result.parse_debug.version ? ` · v${String(result.parse_debug.version)}` : ''}
      </div>
      <Tabs items={tabs} active={tab} onChange={setTab} />

      {tab === 'replay' && replay.data && (
        <ReplayView data={replay.data} workflowRoot={workflowTree.data ?? null} result={result} />
      )}
      {tab === 'replay' && replay.isLoading && <p className="muted">加载中…</p>}

      {tab === 'overview' && (
        <OverviewTab result={result} overview={overview} mermaidSrc={mermaid.data?.src} />
      )}

      {tab === 'tokens' && <TokensTab result={result} />}

      {tab === 'timeline' && isTranscript && <TimelineTab rawEvents={result.raw_events} />}

      {tab === 'tools' && (
        <div>
          <h3>工具执行与效率</h3>
          <ToolEfficiencyTable tools={result.tool_calls} />
          <h3>每次调用 Output Tokens</h3>
          <Plot
            data={[
              {
                type: 'bar',
                x: result.tool_calls.map((_, i) => i + 1),
                y: result.tool_calls.map((t) => t.tiktoken_tokens),
                marker: { color: '#1a73e8' },
                name: 'Tiktoken Tokens',
              },
            ]}
            layout={{ height: 280, margin: { t: 20, b: 40 }, xaxis: { title: '第 N 次调用' }, yaxis: { title: 'Tokens' } }}
          />
        </div>
      )}

      {tab === 'subagent' && <SubagentTab result={result} />}

      {tab === 'cost' && <CostTab result={result} />}

      {tab === 'raw' && <RawEventsTab rawEvents={result.raw_events} keyPrefix="claude" />}

      {!embedded && (
        <>
          <hr />
          <ToolInspector tools={result.tool_calls} />
        </>
      )}
    </div>
  )
}

// ── Overview ──────────────────────────────────────────────────

function OverviewTab({
  result,
  overview,
  mermaidSrc,
}: {
  result: ParseResult
  overview: { eventTypes: [string, number][]; toolCounts: [string, number][] }
  mermaidSrc?: string
}) {
  const ri = result.result_info
  return (
    <div>
      <div className="metric-row">
        <div className="metric-card"><div className="m-title">模型</div><div className="m-value" style={{ fontSize: 15 }}>{result.session_info.model || '—'}</div></div>
        <div className="metric-card"><div className="m-title">轮次</div><div className="m-value">{result.turns.length}</div></div>
        <div className="metric-card"><div className="m-title">工具调用</div><div className="m-value">{result.tool_calls.length}</div></div>
        <div className="metric-card"><div className="m-title">总 Input</div><div className="m-value">{fmtTok(ri.total_input)}</div></div>
        <div className="metric-card"><div className="m-title">总 Output</div><div className="m-value">{fmtTok(ri.total_output)}</div></div>
        <div className="metric-card"><div className="m-title">耗时</div><div className="m-value">{formatDuration(ri.duration_ms)}</div></div>
      </div>
      <div className="two-col">
        <div>
          <h3>事件类型分布</h3>
          <Plot
            data={[{ type: 'bar', x: overview.eventTypes.map(([k]) => k), y: overview.eventTypes.map(([, v]) => v), marker: { color: overview.eventTypes.map((_, i) => plotColors(i)) } }]}
            layout={{ height: 280, margin: { t: 20, b: 60 } }}
          />
        </div>
        <div>
          <h3>工具调用分布</h3>
          <Plot
            data={[{ type: 'pie', labels: overview.toolCounts.map(([k]) => k), values: overview.toolCounts.map(([, v]) => v), hole: 0.4 }]}
            layout={{ height: 280, margin: { t: 20, b: 0 } }}
          />
        </div>
      </div>
      <h3>时序图</h3>
      {mermaidSrc && <MermaidView src={mermaidSrc} />}
    </div>
  )
}

// ── Token trend ───────────────────────────────────────────────
// Port of legacy claude `_tab_tokens`: merges consecutive turns with the
// same input_tokens (all formats), plots per-call window sizes without
// fill-to-zero, compaction deltas (can be negative), cache-hit bars.

function TokensTab({ result }: { result: ParseResult }) {
  // Legacy merges consecutive same-input turns for EVERY format (stream-json
  // included), so no transcript gating here.
  const rawCount = result.turns.length
  if (rawCount === 0) {
    return <Info>暂无 Token 数据（未找到 assistant 事件）</Info>
  }
  const merged = mergeConsecutiveTurns(result.turns)
  const rows = shapeTurns(merged, { deltaFillZero: true })
  const excludesCache = rows.length > 0 && rows[0].excludes_cache
  const hasCache = merged.some((t) => t.cache_read > 0)
  const hasCacheCreation = merged.some((t) => t.cache_creation > 0)
  // Under the excludes-cache convention the cache-read magnitude ≈ the whole
  // window, so plotting it as a line just duplicates the Input line — the
  // hit-rate chart carries that information instead.
  const showCacheLines = !excludesCache

  const trendData: import('plotly.js-basic-dist-min').Data[] = [
    {
      type: 'scatter',
      mode: 'lines+markers',
      x: rows.map((r) => r.turn_no),
      y: rows.map((r) => r.input_tokens),
      name: 'Input Tokens',
      line: { color: '#1a73e8', width: 2 },
    },
    {
      type: 'scatter',
      mode: 'lines+markers',
      x: rows.map((r) => r.turn_no),
      y: rows.map((r) => r.output_tokens),
      name: 'Output',
      line: { color: '#34a853', width: 2 },
    },
  ]
  if (showCacheLines && hasCache) {
    trendData.push({
      type: 'scatter',
      mode: 'lines+markers',
      x: rows.map((r) => r.turn_no),
      y: rows.map((r) => r.cache_read),
      name: 'Cache Read',
      line: { color: '#14b8a6', width: 2, dash: 'dot' },
    })
  }
  if (showCacheLines && hasCacheCreation) {
    trendData.push({
      type: 'scatter',
      mode: 'lines+markers',
      x: rows.map((r) => r.turn_no),
      y: rows.map((r) => r.cache_creation),
      name: 'Cache Creation',
      line: { color: '#a855f7', width: 2, dash: 'dot' },
    })
  }

  return (
    <div>
      <p className="muted">
        已合并连续相同 input_tokens 的 Turn。原始 {rawCount} 个 → 合并后 {merged.length} 个有效数据点。
      </p>
      {excludesCache && (
        <p className="muted">
          该会话的 input_tokens 不含缓存命中（deepseek 类计费口径），缓存行为请见下方命中率图。
        </p>
      )}

      <h3>Input / Output Tokens 趋势</h3>
      <Plot
        data={trendData}
        layout={{ height: 380, margin: { t: 10, b: 40 }, xaxis: { title: 'Turn' }, yaxis: { title: 'Tokens（单次调用）' } }}
      />

      <hr />
      <h3>Token 增量（上下文变化量）</h3>
      <p className="muted">正值 = 上下文增长，负值 = context compaction 压缩释放</p>
      <Plot
        data={[
          { type: 'bar', x: rows.map((_, i) => i), y: rows.map((r) => r.input_delta), name: 'Input Δ', marker: { color: '#1a73e8' } },
          { type: 'bar', x: rows.map((_, i) => i), y: rows.map((r) => r.output_tokens), name: 'Output', marker: { color: '#34a853' } },
        ]}
        layout={{ barmode: 'group', height: 300, margin: { t: 10, b: 40 }, xaxis: { title: '有效数据点' }, yaxis: { title: 'Tokens' } }}
      />

      {hasCache && (
        <>
          <hr />
          <h3>缓存命中率（Cache Read / 真实上下文窗口）</h3>
          <Plot
            data={[
              {
                type: 'bar',
                x: rows.map((_, i) => i),
                y: rows.map((r) => Math.round(r.cache_hit_rate * 1000) / 10),
                marker: { color: '#14b8a6' },
                text: rows.map((r) => `${(r.cache_hit_rate * 100).toFixed(1)}%`),
                textposition: 'outside',
              },
            ]}
            layout={{ height: 280, margin: { t: 40, b: 40 }, xaxis: { title: '有效数据点' }, yaxis: { title: 'Cache Hit %' }, showlegend: false }}
          />
        </>
      )}
    </div>
  )
}

// ── Subagent tab ──────────────────────────────────────────────
// Port of legacy claude `_tab_subagents`: dispatch overview + per-call
// detail expanders (基本信息 / 任务描述 / 输入参数 / 输出内容).

const SUBAGENT_NAMES = new Set(['task', 'Task', 'delegate', 'subagent', 'agent', 'Agent'])

function SubagentTab({ result }: { result: ParseResult }) {
  const subagentCalls = result.tool_calls.filter((tc) => SUBAGENT_NAMES.has(tc.name))

  if (subagentCalls.length === 0) {
    return (
      <div>
        <Info>本次会话未派发任何 subagent。（Claude Code 中通过 `task` 工具派发子代理）</Info>
        <p className="muted">
          提示：如果使用了 `claude -p` 模式（stream-json），subagent 调用信息可能不完整。
          建议使用交互会话记录（transcript）模式获取完整数据。
        </p>
      </div>
    )
  }

  const overviewRows = subagentCalls.map((tc, i) => {
    const inp = isRecord(tc.input) ? tc.input : {}
    const desc = String(inp.description ?? inp.prompt ?? '—')
    return {
      '序号': i + 1,
      '类型': String(inp.subagent_type ?? inp.type ?? 'task'),
      '任务描述': desc.slice(0, 120),
      'Turn': tc.turn_no,
      '是否出错': tc.is_error ? '❌ 是' : '✅ 否',
      '输出大小': `${grouped(tc.output_chars)} chars`,
      'Tiktoken Tokens': grouped(tc.tiktoken_tokens),
      '耗时': tc.duration_ms > 0 ? `${tc.duration_ms.toFixed(0)}ms` : '—',
    }
  })

  return (
    <div>
      <h3>🤖 Subagent 派发概览（共 {subagentCalls.length} 个）</h3>
      <DataTable rows={overviewRows} />

      <hr />
      <h3>逐个 Subagent 详情</h3>
      {subagentCalls.map((tc, i) => {
        const inp = isRecord(tc.input) ? tc.input : {}
        const desc = String(inp.description ?? inp.prompt ?? '(无描述)')
        const subagentType = String(inp.subagent_type ?? inp.type ?? 'task')
        return (
          <Expander
            key={i}
            title={`🤖 Subagent #${i + 1}: ${desc.slice(0, 80)}  ${tc.is_error ? '❌' : '✅'}  Turn ${tc.turn_no}`}
          >
            <div className="two-col">
              <div>
                <p><b>基本信息</b></p>
                <p className="muted" style={{ whiteSpace: 'pre-line' }}>
                  {`类型: ${subagentType}\nTurn: ${tc.turn_no}\n调用序号: #${tc.call_idx + 1}\n输出大小: ${grouped(tc.output_chars)} chars\nTiktoken Tokens: ${grouped(tc.tiktoken_tokens)}${tc.duration_ms > 0 ? `\n耗时: ${tc.duration_ms.toFixed(0)}ms` : ''}${tc.file_path ? `\n关联文件: ${tc.file_path}` : ''}\n状态: ${tc.is_error ? '❌ 出错' : '✅ 成功'}`}
                </p>
              </div>
              <div>
                <p><b>任务描述</b></p>
                <div className="banner banner-info">{desc}</div>
              </div>
            </div>

            <Expander title="📥 输入参数（完整 JSON）">
              <DebugJson value={inp} />
            </Expander>

            <Expander title="📤 输出内容">
              {tc.output ? (
                <textarea className="tool-output" readOnly value={tc.output} rows={16} />
              ) : (
                <p className="muted">(无输出)</p>
              )}
            </Expander>
          </Expander>
        )
      })}
    </div>
  )
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── Timeline (transcript only) — 三泳道时间线 + 框选过滤 + 右侧详情 ──
// 顶部：输入/模型/工具 三条泳道色块时间线，拖拽框选时间段过滤下方列表；
// 中间：事件列表（类型 + 内容摘要）；点击行 → 右侧详情面板
// （摘要 / Payload / Result / Timing / JSON）。

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

const LANES: { key: string; label: string; kinds: string[] }[] = [
  { key: 'user', label: '输入', kinds: ['user'] },
  { key: 'llm', label: '模型', kinds: ['llm'] },
  { key: 'tool', label: '工具', kinds: ['tool'] },
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

function TimelineTab({ rawEvents }: { rawEvents: unknown[] }) {
  const model = useMemo(() => buildTimeline(rawEvents), [rawEvents])
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

  const barColor = (e: (typeof model.events)[number]) => {
    if (e.kind === 'tool') return toolColors.get(e.tool_name) ?? '#34a853'
    return KIND_COLORS[e.kind] ?? '#94a3b8'
  }

  const durStr = (e: (typeof model.events)[number]) => {
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
      <TimelineStrip
        model={model}
        toolColors={toolColors}
        brush={brush}
        onBrush={setBrush}
      />

      {/* 过滤工具条（回放引擎同款分类） */}
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
                  // 轮次分割带（每条用户输入开启新轮次）
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
  model: import('../../derive').TimelineModel
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
  const brushRef = useRef(brush)
  brushRef.current = brush

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
                .filter((e) => lane.kinds.includes(e.kind))
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
  event: import('../../derive').TimelineEvent
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

// ── Cost analysis ─────────────────────────────────────────────

function CostTab({ result }: { result: ParseResult }) {
  const ri = result.result_info
  const totalCache = ri.total_cache_read + ri.total_cache_creation
  const apiMs = ri.duration_api_ms
  const localMs = Math.max(0, ri.duration_ms - ri.duration_api_ms)

  return (
    <div>
      <div className="metric-row">
        <div className="metric-card"><div className="m-title">总费用</div><div className="m-value">${ri.total_cost_usd.toFixed(4)}</div></div>
        <div className="metric-card"><div className="m-title">Cache Read</div><div className="m-value">{fmtTok(ri.total_cache_read)}</div></div>
        <div className="metric-card"><div className="m-title">Cache Creation</div><div className="m-value">{fmtTok(ri.total_cache_creation)}</div></div>
        <div className="metric-card"><div className="m-title">API 等待</div><div className="m-value">{apiMs > 0 ? formatDuration(apiMs) : '—'}</div></div>
        <div className="metric-card"><div className="m-title">本地处理</div><div className="m-value">{localMs > 0 ? formatDuration(localMs) : '—'}</div></div>
      </div>

      <h3>Token 构成</h3>
      <Plot
        data={[
          {
            type: 'pie',
            labels: ['Input', 'Output', 'Cache Read', 'Cache Creation'],
            values: [ri.total_input, ri.total_output, ri.total_cache_read, ri.total_cache_creation],
            hole: 0.4,
          },
        ]}
        layout={{ height: 320, margin: { t: 20, b: 0 } }}
      />

      <h3>API 等待 vs 本地处理</h3>
      <Plot
        data={[
          { type: 'bar', x: ['API 等待', '本地处理'], y: [apiMs, localMs], marker: { color: ['#ea4335', '#34a853'] } },
        ]}
        layout={{ height: 260, margin: { t: 20, b: 40 }, yaxis: { title: 'ms' } }}
      />

      <h3>每轮 Token 明细</h3>
      <DataTable
        rows={result.turns.map((t) => ({
          'Turn': t.turn_no,
          'Input': grouped(t.input_tokens),
          'Output': grouped(t.output_tokens),
          'Cache Read': grouped(t.cache_read),
          'Cache Creation': grouped(t.cache_creation),
          '模型': t.model || '—',
        }))}
      />
      {totalCache === 0 && <Info>此会话无 cache 活动。</Info>}
    </div>
  )
}
