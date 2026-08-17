// Gemini CLI view — 6 tabs incl. parse debug panel (port of
// legacy views/gemini.py).

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ParseResult } from '../../api/types'
import { useMermaid, useParse } from '../../hooks'
import Plot from '../../components/Plot'
import MermaidView from '../../components/MermaidView'
import { Tabs, DataTable, DebugJson, Expander, ErrorBanner, FileUpload, Info } from '../../components/ui/primitives'
import { download, fmtTok, grouped, toCsv } from '../../derive'
import type { AgentType } from '../../api/types'

const PLOT_LIMIT = 5000

const TABS = [
  { key: 'overview', label: '总览' },
  { key: 'timeline', label: '时间线' },
  { key: 'sequence', label: '时序图' },
  { key: 'tools', label: '工具调用' },
  { key: 'apitokens', label: 'API & Tokens' },
  { key: 'raw', label: '原始数据' },
]

// Gemini events are normalized to {timestamp, event_name, category, ...} —
// unlike opencode/claude they use event_name/category instead of `type`.
type GemEvent = Record<string, unknown>

const CATEGORY_COLORS: Record<string, string> = {
  'API 调用': '#1a73e8',
  '工具调用': '#f59e0b',
  '工具响应': '#0a9e6a',
  '文件操作': '#8b5cf6',
  'Agent': '#ec4899',
  '会话-配置': '#94a3b8',
  '会话-Prompt': '#14b8a6',
  '会话-Session': '#64748b',
  '对话轮次': '#d97706',
  '消息': '#3b82f6',
  '响应': '#22c55e',
  '错误': '#ef4444',
  '计量': '#f97316',
  '模型': '#6366f1',
  '缓存': '#0ea5e9',
  '其他': '#9ca3af',
}

function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? '#9ca3af'
}

export default function GeminiView() {
  const [content, setContent] = useState<ArrayBuffer | null>(null)
  const [name, setName] = useState('')
  const { data, error, isLoading } = useParse('gemini' as AgentType, content, name)

  return (
    <div className="page shell">
      <aside className="sidebar">
        <Link className="btn" to="/">← 返回选择页</Link>
        <hr />
        <h3>Gemini CLI</h3>
        <FileUpload
          label="上传 telemetry.log"
          onFile={(buf, n) => {
            setContent(buf)
            setName(n)
          }}
        />
        {name && <p className="muted">已加载：{name}</p>}
        {error && <ErrorBanner>{String(error)}</ErrorBanner>}
        <p className="muted">
          GEMINI_TELEMETRY_TRACES_ENABLED 生成的 telemetry.log（拼接 JSON 对象格式）
        </p>
      </aside>
      <div className="main">
        {isLoading && <p className="muted">解析中…</p>}
        {data && <GeminiBody result={data as ParseResult} />}
        {!content && <p className="muted">请先上传 telemetry.log。</p>}
      </div>
    </div>
  )
}

function GeminiBody({ result }: { result: ParseResult }) {
  const [tab, setTab] = useState('overview')
  const events = result.raw_events as GemEvent[]
  const mermaid = useMermaid({ kind: 'sequence-gemini', rawEvents: result.raw_events, maxEvents: 60, seed: 42 })

  const stats = useMemo(() => {
    const cats = new Map<string, number>()
    const names = new Map<string, number>()
    for (const e of events) {
      const cat = String(e.category ?? '其他')
      cats.set(cat, (cats.get(cat) ?? 0) + 1)
      const n = String(e.event_name ?? '?')
      names.set(n, (names.get(n) ?? 0) + 1)
    }
    // events per minute
    const minutes = new Map<string, number>()
    for (const e of events) {
      const ts = String(e.timestamp ?? '')
      const min = ts.slice(0, 16)
      if (min) minutes.set(min, (minutes.get(min) ?? 0) + 1)
    }
    return {
      categories: [...cats.entries()].sort((a, b) => b[1] - a[1]),
      topNames: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
      minutes: [...minutes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    }
  }, [events])

  const tools = useMemo(() => {
    const calls = events.filter((e) => e.category === '工具调用')
    const resps = events.filter((e) => e.category === '工具响应')
    return { calls, resps }
  }, [events])

  return (
    <div className="page" style={{ padding: 0 }}>
      <h2>Gemini CLI 可视化</h2>

      <Expander title={`🔧 解析调试面板（chunks=${String(result.parse_debug.chunks_found ?? 0)} rows_ok=${String(result.parse_debug.rows_ok ?? 0)} rows_err=${String(result.parse_debug.rows_err ?? 0)}）`}>
        <DebugJson value={result.parse_debug} />
      </Expander>

      <Tabs items={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && <OverviewTab stats={stats} events={events} />}

      {tab === 'timeline' && <TimelineTab events={events} />}

      {tab === 'sequence' && (
        <div>
          <h3>时序图</h3>
          {mermaid.data && (
            <MermaidView src={mermaid.data.src} notice={mermaid.data.notice} />
          )}
        </div>
      )}

      {tab === 'tools' && <ToolsTab calls={tools.calls} resps={tools.resps} />}

      {tab === 'apitokens' && <ApiTokensTab events={events} />}

      {tab === 'raw' && <RawTab events={events} />}
    </div>
  )
}

// ── Overview ──────────────────────────────────────────────────

function OverviewTab({
  stats,
  events,
}: {
  stats: { categories: [string, number][]; topNames: [string, number][]; minutes: [string, number][] }
  events: GemEvent[]
}) {
  return (
    <div>
      <div className="two-col">
        <div>
          <h3>事件类别分布</h3>
          <Plot
            data={[{
              type: 'pie',
              labels: stats.categories.map(([k]) => k),
              values: stats.categories.map(([, v]) => v),
              hole: 0.4,
              marker: { colors: stats.categories.map(([k]) => categoryColor(k)) },
            }]}
            layout={{ height: 320, margin: { t: 20, b: 0 } }}
          />
        </div>
        <div>
          <h3>Top 15 事件名</h3>
          <Plot
            data={[{
              type: 'bar',
              x: stats.topNames.map(([, v]) => v),
              y: stats.topNames.map(([k]) => k),
              orientation: 'h',
              marker: { color: '#6366f1' },
            }]}
            layout={{ height: 320, margin: { t: 20, b: 0, l: 200 } }}
          />
        </div>
      </div>

      <h3>事件时间分布（按分钟聚合）</h3>
      <Plot
        data={[
          {
            type: 'bar',
            x: stats.minutes.map(([k]) => k),
            y: stats.minutes.map(([, v]) => v),
            name: '事件数/分钟',
            marker: { color: '#1a73e8' },
          },
        ]}
        layout={{ height: 240, margin: { t: 20, b: 60 } }}
      />

      <h3>模型</h3>
      <p>{String(events.find((e) => e.model)?.model ?? '—')}</p>
    </div>
  )
}

// ── Timeline ──────────────────────────────────────────────────

function TimelineTab({ events }: { events: GemEvent[] }) {
  const [selected, setSelected] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const cats = useMemo(
    () => [...new Set(events.map((e) => String(e.category ?? '其他')))].sort(),
    [events],
  )

  const filtered = useMemo(() => {
    const active = selected.length === 0 ? cats : selected
    return events.filter((e) => active.includes(String(e.category ?? '其他')))
  }, [events, selected, cats])

  const sampled = useMemo(() => {
    if (filtered.length <= PLOT_LIMIT) return filtered
    return filtered.filter((_, i) => i % Math.ceil(filtered.length / PLOT_LIMIT) === 0)
  }, [filtered])

  const PAGE = 30
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const safePage = Math.min(page, totalPages)
  const pageEvents = filtered.slice((safePage - 1) * PAGE, safePage * PAGE)

  return (
    <div>
      <h3>事件时间线</h3>
      <p className="muted">按类别筛选（点击标签切换）</p>
      <div className="pills">
        {cats.map((c) => (
          <button
            key={c}
            className={`pill ${selected.includes(c) || selected.length === 0 ? 'pill-active' : ''}`}
            style={selected.length > 0 && selected.includes(c) ? { background: categoryColor(c), borderColor: categoryColor(c) } : selected.length > 0 ? {} : { background: categoryColor(c), borderColor: categoryColor(c), color: '#fff' }}
            onClick={() => {
              setSelected((prev) =>
                prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
              )
              setPage(1)
            }}
          >
            {c}
          </button>
        ))}
      </div>

      {filtered.length > PLOT_LIMIT && (
        <Info>共 {filtered.length.toLocaleString('en-US')} 条，图表已采样显示 {sampled.length.toLocaleString('en-US')} 条</Info>
      )}

      <Plot
        data={[
          {
            type: 'scatter',
            mode: 'markers',
            x: sampled.map((e) => String(e.timestamp ?? '')),
            y: sampled.map(() => 0),
            text: sampled.map((e) => String(e.event_name ?? '')),
            marker: { size: 7, color: sampled.map((e) => categoryColor(String(e.category ?? ''))) },
          },
        ]}
        layout={{ height: 220, margin: { t: 20, b: 60 }, yaxis: { visible: false } }}
      />

      <div className="pagination">
        <button className="btn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>◀ 上一页</button>
        <span className="pagination-info">第 {safePage} / {totalPages} 页</span>
        <button className="btn" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>下一页 ▶</button>
      </div>

      {pageEvents.map((e, i) => (
        <Expander
          key={i}
          title={
            <span>
              <span className="badge" style={{ background: categoryColor(String(e.category ?? '')) }}>
                {String(e.category ?? '')}
              </span>{' '}
              {String(e.event_name ?? '?')}{' '}
              <span className="muted">{String(e.timestamp ?? '')}</span>
            </span>
          }
        >
          <DataTable
            compact
            rows={[{
              '模型': String(e.model ?? ''),
              '工具': String(e.tool_name ?? ''),
              '文件': String(e.file_path ?? ''),
              '耗时': e.duration_ms != null ? `${Number(e.duration_ms).toFixed(1)}ms` : '—',
              'Input': e.input_tokens ?? '—',
              'Output': e.output_tokens ?? '—',
              '状态': String(e.status ?? ''),
              'Body': String(e.body ?? '').slice(0, 300),
            }]}
          />
          <Expander title="完整属性">
            <DebugJson value={safeJson(String(e.attrs_json ?? '{}'))} />
          </Expander>
        </Expander>
      ))}
    </div>
  )
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// ── Tools ─────────────────────────────────────────────────────

function ToolsTab({ calls, resps }: { calls: GemEvent[]; resps: GemEvent[] }) {
  const durations = calls
    .map((c) => Number(c.duration_ms ?? 0))
    .filter((d) => d > 0)
    .sort((a, b) => a - b)
  const avg = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0
  const p90 = durations.length ? durations[Math.floor(durations.length * 0.9)] : 0
  const max = durations.length ? durations[durations.length - 1] : 0

  const paired = calls.map((c, i) => ({
    call: c,
    resp: resps[i] ?? null,
    respTokens: Number((c.fn_response_tokens as number) ?? (resps[i]?.fn_response_tokens as number) ?? 0),
  }))

  const slowest = [...paired]
    .filter((p) => Number(p.call.duration_ms ?? 0) > 0)
    .sort((a, b) => Number(b.call.duration_ms) - Number(a.call.duration_ms))
    .slice(0, 10)

  return (
    <div>
      <div className="metric-row">
        <div className="metric-card"><div className="m-title">工具调用次数</div><div className="m-value">{calls.length}</div></div>
        <div className="metric-card"><div className="m-title">平均耗时</div><div className="m-value">{avg > 0 ? `${avg.toFixed(1)}ms` : '—'}</div></div>
        <div className="metric-card"><div className="m-title">P90 耗时</div><div className="m-value">{p90 > 0 ? `${p90.toFixed(1)}ms` : '—'}</div></div>
        <div className="metric-card"><div className="m-title">最大耗时</div><div className="m-value">{max > 0 ? `${max.toFixed(1)}ms` : '—'}</div></div>
      </div>

      <h3>调用耗时分布</h3>
      <Plot
        data={[{
          type: 'bar',
          x: paired.map((_, i) => i + 1),
          y: paired.map((p) => Number(p.call.duration_ms ?? 0)),
          marker: { color: '#f59e0b' },
          name: '耗时 ms',
        }]}
        layout={{ height: 260, margin: { t: 20, b: 40 }, xaxis: { title: '第 N 次调用' }, yaxis: { title: 'ms' } }}
      />

      <h3>每次调用 Response Tokens</h3>
      <Plot
        data={[{
          type: 'bar',
          x: paired.map((_, i) => i + 1),
          y: paired.map((p) => p.respTokens),
          marker: { color: '#0a9e6a' },
          name: 'Response Tokens',
        }]}
        layout={{ height: 260, margin: { t: 20, b: 40 }, xaxis: { title: '第 N 次调用' }, yaxis: { title: 'Tokens' } }}
      />

      <h3>最慢的 10 次调用</h3>
      <DataTable
        compact
        rows={slowest.map((p) => ({
          '工具': String(p.call.tool_name ?? ''),
          '耗时': `${Number(p.call.duration_ms).toFixed(1)}ms`,
          '文件': String(p.call.file_path ?? ''),
          'Response Tokens': p.respTokens > 0 ? grouped(p.respTokens) : '—',
        }))}
      />

      <h3>工具调用明细</h3>
      <DataTable
        compact
        rows={paired.map((p) => ({
          '#': paired.indexOf(p) + 1,
          '工具': String(p.call.tool_name ?? ''),
          '耗时': p.call.duration_ms != null ? `${Number(p.call.duration_ms).toFixed(1)}ms` : '—',
          '文件': String(p.call.file_path ?? ''),
          'Response Tokens': p.respTokens > 0 ? grouped(p.respTokens) : '—',
          '状态': String(p.call.status ?? ''),
        }))}
      />
    </div>
  )
}

// ── API & Tokens ──────────────────────────────────────────────

function ApiTokensTab({ events }: { events: GemEvent[] }) {
  const api = events.filter((e) => e.category === 'API 调用')
  const totalIn = api.reduce((s, e) => s + Number(e.input_tokens ?? 0), 0)
  const totalOut = api.reduce((s, e) => s + Number(e.output_tokens ?? 0), 0)

  let cumIn = 0
  let cumOut = 0
  const cumulative = api.map((e, i) => {
    cumIn += Number(e.input_tokens ?? 0)
    cumOut += Number(e.output_tokens ?? 0)
    return { callNo: i + 1, in: cumIn, out: cumOut, ts: String(e.timestamp ?? '') }
  })

  return (
    <div>
      <div className="metric-row">
        <div className="metric-card"><div className="m-title">API 调用次数</div><div className="m-value">{api.length}</div></div>
        <div className="metric-card"><div className="m-title">总 Input</div><div className="m-value">{fmtTok(totalIn)}</div></div>
        <div className="metric-card"><div className="m-title">总 Output</div><div className="m-value">{fmtTok(totalOut)}</div></div>
      </div>

      <h3>累计 Token 消耗曲线（按调用序）</h3>
      <Plot
        data={[
          {
            type: 'scatter',
            mode: 'lines+markers',
            x: cumulative.map((c) => c.callNo),
            y: cumulative.map((c) => c.in),
            name: '累计输入',
            line: { color: '#1a73e8', width: 2 },
            fill: 'tozeroy',
            fillcolor: 'rgba(26,115,232,0.08)',
          },
          {
            type: 'scatter',
            mode: 'lines+markers',
            x: cumulative.map((c) => c.callNo),
            y: cumulative.map((c) => c.out),
            name: '累计输出',
            line: { color: '#34a853', width: 2 },
            fill: 'tozeroy',
            fillcolor: 'rgba(52,168,83,0.08)',
          },
        ]}
        layout={{ height: 320, margin: { t: 10, b: 40 }, xaxis: { title: '第 N 次 API 调用' }, yaxis: { title: 'Tokens' } }}
      />

      <h3>每次调用 Input vs Output 对比</h3>
      <Plot
        data={[
          { type: 'bar', x: cumulative.map((c) => c.callNo), y: api.map((e) => Number(e.input_tokens ?? 0)), name: 'Input', marker: { color: '#1a73e8' } },
          { type: 'bar', x: cumulative.map((c) => c.callNo), y: api.map((e) => Number(e.output_tokens ?? 0)), name: 'Output', marker: { color: '#34a853' } },
        ]}
        layout={{ barmode: 'group', height: 320, margin: { t: 10, b: 40 }, xaxis: { title: '第 N 次 API 调用' }, yaxis: { title: 'Tokens' } }}
      />
    </div>
  )
}

// ── Raw data ──────────────────────────────────────────────────

function RawTab({ events }: { events: GemEvent[] }) {
  const [category, setCategory] = useState<string[]>([])
  const [kw, setKw] = useState('')
  const cats = useMemo(() => [...new Set(events.map((e) => String(e.category ?? '其他')))].sort(), [events])

  const filtered = useMemo(() => {
    const active = category.length === 0 ? cats : category
    return events.filter((e) => {
      if (!active.includes(String(e.category ?? '其他'))) return false
      if (!kw) return true
      const hay = `${String(e.event_name ?? '')} ${String(e.body ?? '')} ${String(e.attrs_json ?? '')}`.toLowerCase()
      return hay.includes(kw.toLowerCase())
    })
  }, [events, cats, category, kw])

  const displayCols = ['timestamp', 'category', 'event_name', 'body', 'tool_name', 'file_path', 'input_tokens', 'output_tokens', 'duration_ms', 'status']

  const rows = filtered.map((e) =>
    Object.fromEntries(displayCols.map((c) => [c, e[c] ?? ''])),
  )

  return (
    <div>
      <h3>全部事件（{events.length.toLocaleString('en-US')} 条）</h3>
      <div className="pills">
        {cats.map((c) => (
          <button
            key={c}
            className={`pill ${category.includes(c) || category.length === 0 ? 'pill-active' : ''}`}
            onClick={() => setCategory((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))}
          >
            {c}
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder="搜索"
        value={kw}
        onChange={(e) => setKw(e.target.value)}
        className="pill-input"
        style={{ width: '100%', padding: 6, marginBottom: 8 }}
      />
      <DataTable compact rows={rows.slice(0, 2000)} />
      {filtered.length > 2000 && <p className="muted">仅显示前 2000 行，导出获取全部。</p>}
      <button
        className="btn"
        onClick={() => download('gemini_telemetry.csv', toCsv(rows), 'text/csv')}
      >
        导出 CSV
      </button>
    </div>
  )
}
