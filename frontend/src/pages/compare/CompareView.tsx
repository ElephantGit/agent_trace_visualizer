// A/B compare page — 5 layers rendered from the precomputed /api/compare
// payload (no client-side math): summary cards, overlay trend, per-turn
// grouped bars, tool efficiency + savings, detail table + CSV export.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompare, useParse } from '../../hooks'
import { api } from '../../api/client'
import Plot from '../../components/Plot'
import { DataTable, ErrorBanner, FileUpload, Info, Pills, TextInput } from '../../components/ui/primitives'
import { download, toCsv } from '../../derive'
import { useQuery } from '@tanstack/react-query'
import type { AgentType, ParseResult, SummaryCard } from '../../api/types'

const COLOR_BASELINE = '#ea4335'
const COLOR_RTK = '#0a9e6a'

type LoadMode = 'upload' | 'path'

export default function CompareView() {
  const [agentType, setAgentType] = useState<AgentType>('claude_code')
  const [loadMode, setLoadMode] = useState<LoadMode>('upload')
  const [bufA, setBufA] = useState<ArrayBuffer | null>(null)
  const [bufB, setBufB] = useState<ArrayBuffer | null>(null)
  const [pathA, setPathA] = useState('')
  const [pathB, setPathB] = useState('')
  const [labelA, setLabelA] = useState('无 RTK')
  const [labelB, setLabelB] = useState('有 RTK')

  const uploadA = useParse(loadMode === 'upload' ? agentType : null, bufA, 'cmpA')
  const uploadB = useParse(loadMode === 'upload' ? agentType : null, bufB, 'cmpB')
  const pathResultA = useQuery({
    queryKey: ['parse-from-path', 'cmpA', pathA, agentType],
    queryFn: () => api.parseFromPath(agentType, pathA),
    enabled: loadMode === 'path' && !!pathA,
  })
  const pathResultB = useQuery({
    queryKey: ['parse-from-path', 'cmpB', pathB, agentType],
    queryFn: () => api.parseFromPath(agentType, pathB),
    enabled: loadMode === 'path' && !!pathB,
  })

  const resultA = (loadMode === 'upload' ? uploadA.data : pathResultA.data) as ParseResult | undefined
  const resultB = (loadMode === 'upload' ? uploadB.data : pathResultB.data) as ParseResult | undefined
  const errA = loadMode === 'upload' ? uploadA.error : pathResultA.error
  const errB = loadMode === 'upload' ? uploadB.error : pathResultB.error

  const compare = useCompare(resultA ?? null, resultB ?? null, labelA || '无 RTK', labelB || '有 RTK')

  return (
    <div className="page shell">
      <aside className="sidebar">
        <Link className="btn" to="/">← 返回选择页</Link>
        <hr />
        <h3>📊 对比模式</h3>
        <p className="muted">加载两个相同任务的 trace 文件进行 A/B 对比</p>

        <label className="text-input">
          <span>Agent 类型</span>
          <select value={agentType} onChange={(e) => setAgentType(e.target.value as AgentType)}>
            <option value="opencode">Opencode (.ndjson)</option>
            <option value="claude_code">Claude Code (.jsonl / stream-json)</option>
          </select>
        </label>
        <hr />

        <Pills
          options={['上传文件', '输入路径']}
          selected={[loadMode === 'upload' ? '上传文件' : '输入路径']}
          onChange={(next) => setLoadMode(next[0] === '输入路径' ? 'path' : 'upload')}
        />

        {loadMode === 'upload' ? (
          <>
            <FileUpload label="🔴 Baseline 文件" onFile={(b) => setBufA(b)} />
            <FileUpload label="🟢 Experiment 文件" onFile={(b) => setBufB(b)} />
          </>
        ) : (
          <>
            <TextInput label="🔴 Baseline 文件路径" value={pathA} onChange={setPathA} />
            <TextInput label="🟢 Experiment 文件路径" value={pathB} onChange={setPathB} />
          </>
        )}

        <hr />
        <h4>标签设置</h4>
        <TextInput label="🔴 标签" value={labelA} onChange={setLabelA} />
        <TextInput label="🟢 标签" value={labelB} onChange={setLabelB} />

        <hr />
        {errA && <ErrorBanner>{String(errA)}</ErrorBanner>}
        {errB && <ErrorBanner>{String(errB)}</ErrorBanner>}
      </aside>

      <div className="main">
        {!resultA || !resultB ? (
          <Placeholder />
        ) : compare.isLoading ? (
          <p className="muted">对比计算中…</p>
        ) : compare.data ? (
          <CompareBody payload={compare.data} agentType={agentType} />
        ) : null}
      </div>
    </div>
  )
}

function Placeholder() {
  return (
    <div>
      <h1>📊 Token 消耗对比</h1>
      <hr />
      <div className="two-col">
        <div>
          <h3>使用方法</h3>
          <ol style={{ lineHeight: 1.9 }}>
            <li>在左侧选择 <b>Agent 类型</b>（Opencode / Claude Code）</li>
            <li>上传或输入两个 <b>相同任务</b> 的 trace 文件：
              <ul>
                <li>🔴 <b>Baseline</b> — 未使用优化的原始 trace</li>
                <li>🟢 <b>Experiment</b> — 使用了优化（如 RTK）的 trace</li>
              </ul>
            </li>
            <li>可自定义两个文件的显示标签</li>
          </ol>
        </div>
        <div>
          <h3>对比维度</h3>
          <ul style={{ lineHeight: 1.9 }}>
            <li>💰 <b>Token 总量对比</b> — 总 Input / Output / Cost 及节省百分比</li>
            <li>📈 <b>Token 增长曲线</b> — 两条叠加的累计趋势线</li>
            <li>📊 <b>逐轮增量对比</b> — 每轮 Input / Output 分组柱状图</li>
            <li>🔨 <b>工具调用效率</b> — 各工具在两个版本中的调用次数与 Token 消耗</li>
            <li>📋 <b>逐轮明细表</b> — 每轮的精确 Delta 和节省比例</li>
          </ul>
        </div>
      </div>
      <Info>📂 请在左侧边栏加载两个文件后进行对比</Info>
    </div>
  )
}

function CompareBody({
  payload,
  agentType,
}: {
  payload: import('../../api/types').ComparePayload
  agentType: string
}) {
  const { labels } = payload

  return (
    <div>
      <h1>📊 Token 消耗对比</h1>
      <p className="muted">Agent 类型：{agentType}</p>

      <hr />
      <h3>📋 总览对比</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {payload.summaryCards.map((card) => (
          <MetricCard key={card.title} card={card} labelA={labels.a} labelB={labels.b} />
        ))}
      </div>

      <hr />
      <h3>📈 Token 消耗趋势对比</h3>
      {payload.overlay.turnsA.length === 0 && payload.overlay.turnsB.length === 0 ? (
        <Info>暂无 Token 数据</Info>
      ) : (
        <OverlayChart payload={payload} />
      )}

      {payload.perTurn.length > 0 && (
        <>
          <hr />
          <h3>📊 逐轮 Token 增量对比</h3>
          <Plot
            data={[
              {
                type: 'bar',
                x: payload.perTurn.map((r) => r.turn - 0.15),
                y: payload.perTurn.map((r) => r.delta_in_a ?? 0),
                name: `${labels.a} — Input 增量`,
                marker: { color: COLOR_BASELINE, opacity: 0.7 },
                width: 0.25,
              },
              {
                type: 'bar',
                x: payload.perTurn.map((r) => r.turn - 0.15),
                y: payload.perTurn.map((r) => r.out_a ?? 0),
                name: `${labels.a} — Output`,
                marker: { color: COLOR_BASELINE, opacity: 0.35 },
                width: 0.25,
              },
              {
                type: 'bar',
                x: payload.perTurn.map((r) => r.turn + 0.15),
                y: payload.perTurn.map((r) => r.delta_in_b ?? 0),
                name: `${labels.b} — Input 增量`,
                marker: { color: COLOR_RTK, opacity: 0.7 },
                width: 0.25,
              },
              {
                type: 'bar',
                x: payload.perTurn.map((r) => r.turn + 0.15),
                y: payload.perTurn.map((r) => r.out_b ?? 0),
                name: `${labels.b} — Output`,
                marker: { color: COLOR_RTK, opacity: 0.35 },
                width: 0.25,
              },
            ]}
            layout={{
              barmode: 'group',
              height: 380,
              xaxis: { title: 'Turn', tickmode: 'linear', dtick: 1 },
              yaxis: { title: 'Tokens' },
              margin: { t: 10, b: 40 },
              bargap: 0.15,
              bargroupgap: 0.05,
            }}
          />
        </>
      )}

      {payload.tools.length > 0 && (
        <>
          <hr />
          <h3>🔨 工具调用效率对比</h3>
          <DataTable
            rows={payload.tools.map((t) => ({
              '工具': t.name,
              [`${labels.a} 次数`]: t.count_a,
              [`${labels.b} 次数`]: t.count_b,
              'Δ 次数': t.delta_count,
              [`${labels.a} 总Token`]: t.tok_a.toLocaleString('en-US'),
              [`${labels.b} 总Token`]: t.tok_b.toLocaleString('en-US'),
              'Δ Token': t.delta_token,
            }))}
          />
          <div className="two-col">
            <div>
              <h4>各工具调用次数</h4>
              <Plot
                data={[
                  { type: 'bar', y: payload.tools.map((t) => t.name), x: payload.tools.map((t) => t.count_a), orientation: 'h', name: labels.a, marker: { color: COLOR_BASELINE, opacity: 0.75 } },
                  { type: 'bar', y: payload.tools.map((t) => t.name), x: payload.tools.map((t) => t.count_b), orientation: 'h', name: labels.b, marker: { color: COLOR_RTK, opacity: 0.75 } },
                ]}
                layout={{
                  barmode: 'group',
                  height: Math.max(220, payload.tools.length * 32),
                  margin: { t: 10, b: 0, l: 120 },
                  yaxis: { autorange: 'reversed' },
                }}
              />
            </div>
            <div>
              <h4>各工具 Token 节省贡献</h4>
              {payload.savings.length === 0 ? (
                <Info>无正向节省</Info>
              ) : (
                <Plot
                  data={[{
                    type: 'pie',
                    labels: payload.savings.map((s) => s.name),
                    values: payload.savings.map((s) => s.savedTokens),
                    hole: 0.4,
                    textinfo: 'label+percent',
                    textposition: 'outside',
                  }]}
                  layout={{ height: 320, margin: { t: 10, b: 0 }, showlegend: false }}
                />
              )}
            </div>
          </div>
        </>
      )}

      {payload.detail.length > 0 && (
        <>
          <hr />
          <h3>📋 逐轮 Token 明细对比</h3>
          <DataTable
            rows={payload.detail.map((r) => ({
              'Turn': r.turn,
              [`${labels.a} Input`]: r.in_a ?? '—',
              [`${labels.b} Input`]: r.in_b ?? '—',
              'Δ Input': r.delta_in,
              [`${labels.a} Output`]: r.out_a ?? '—',
              [`${labels.b} Output`]: r.out_b ?? '—',
              'Δ Output': r.delta_out,
              [`${labels.a} CacheRead`]: r.cache_read_a,
              [`${labels.b} CacheRead`]: r.cache_read_b,
            }))}
          />
          <button
            className="btn"
            onClick={() =>
              download(
                'token_comparison.csv',
                toCsv(
                  payload.detail.map((r) => ({
                    Turn: r.turn,
                    [`${labels.a} Input`]: r.in_a ?? '',
                    [`${labels.b} Input`]: r.in_b ?? '',
                    [`${labels.a} Output`]: r.out_a ?? '',
                    [`${labels.b} Output`]: r.out_b ?? '',
                    [`${labels.a} CacheRead`]: r.cache_read_a,
                    [`${labels.b} CacheRead`]: r.cache_read_b,
                  })),
                ),
                'text/csv',
              )
            }
          >
            📥 导出对比明细 CSV
          </button>
        </>
      )}
    </div>
  )
}

function MetricCard({ card, labelA, labelB }: { card: SummaryCard; labelA: string; labelB: string }) {
  return (
    <div className="metric-card">
      <div className="m-title">{card.title}</div>
      <div className="m-vs">
        <div>
          <div className="m-label" style={{ color: COLOR_BASELINE }}>{labelA}</div>
          <div className="m-value" style={{ color: COLOR_BASELINE }}>{card.str_a}</div>
        </div>
        <div style={{ fontSize: 16, color: '#ccc' }}>vs</div>
        <div>
          <div className="m-label" style={{ color: COLOR_RTK }}>{labelB}</div>
          <div className="m-value" style={{ color: COLOR_RTK }}>{card.str_b}</div>
        </div>
      </div>
      <div className="m-delta" style={{ color: card.delta_color }}>{card.delta_str}</div>
    </div>
  )
}

function OverlayChart({ payload }: { payload: import('../../api/types').ComparePayload }) {
  const { overlay, labels } = payload
  const ann = overlay.annotation
  const data: import('plotly.js-basic-dist-min').Data[] = [
    {
      type: 'scatter',
      mode: 'lines+markers',
      x: overlay.turnsA.map((t) => t.turn_no),
      y: overlay.turnsA.map((t) => t.input_tokens),
      name: `${labels.a} — Input（窗口大小）`,
      line: { color: COLOR_BASELINE, width: 2.5 },
      fill: 'tozeroy',
      fillcolor: 'rgba(234,67,53,0.06)',
      legendgroup: labels.a,
    },
    ...(overlay.turnsA.reduce((s, t) => s + t.output_tokens, 0) > 0
      ? [{
          type: 'scatter' as const,
          mode: 'lines+markers' as const,
          x: overlay.turnsA.map((t) => t.turn_no),
          y: overlay.turnsA.map((t) => t.output_tokens),
          name: `${labels.a} — Output`,
          line: { color: COLOR_BASELINE, width: 2, dash: 'dot' as const },
          legendgroup: labels.a,
        }]
      : []),
    {
      type: 'scatter',
      mode: 'lines+markers',
      x: overlay.turnsB.map((t) => t.turn_no),
      y: overlay.turnsB.map((t) => t.input_tokens),
      name: `${labels.b} — Input（窗口大小）`,
      line: { color: COLOR_RTK, width: 2.5 },
      fill: 'tozeroy',
      fillcolor: 'rgba(10,158,106,0.06)',
      legendgroup: labels.b,
    },
    ...(overlay.turnsB.reduce((s, t) => s + t.output_tokens, 0) > 0
      ? [{
          type: 'scatter' as const,
          mode: 'lines+markers' as const,
          x: overlay.turnsB.map((t) => t.turn_no),
          y: overlay.turnsB.map((t) => t.output_tokens),
          name: `${labels.b} — Output`,
          line: { color: COLOR_RTK, width: 2, dash: 'dot' as const },
          legendgroup: labels.b,
        }]
      : []),
  ]
  const layout: Record<string, unknown> = {
    height: 420,
    hovermode: 'x unified',
    xaxis: { title: 'Turn' },
    yaxis: { title: 'Tokens' },
    margin: { t: 10, b: 40 },
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1, font: { size: 11 } },
  }
  if (ann) {
    layout.annotations = [
      {
        x: ann.x,
        y: ann.y,
        text: ann.text,
        showarrow: true,
        arrowhead: 2,
        arrowsize: 1,
        ax: 40,
        ay: 0,
        font: { color: COLOR_RTK, size: 12 },
        bordercolor: COLOR_RTK,
        borderwidth: 1,
        borderpad: 8,
        bgcolor: 'rgba(255,255,255,0.9)',
      },
    ]
  }
  return <Plot data={data} layout={layout} />
}
