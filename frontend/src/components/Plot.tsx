// Lazy Plotly wrapper — keeps the ~1MB plotly bundle out of the initial
// page load (code-split per page).

import { Suspense, lazy } from 'react'
import type { Config, Data, Layout } from 'plotly.js-basic-dist-min'

const PlotlyPlot = lazy(() =>
  import('react-plotly.js').then((m) => ({ default: m.default })),
)

// Layout is typed loosely: the @types/plotly.js axis title is an object
// (Partial<DataTitle>) while the legacy Python code passed plain strings;
// we normalize at render time instead of fighting the types at call sites.
type LooseLayout = Record<string, unknown>

export default function Plot({
  data,
  layout,
  className,
}: {
  data: Data[]
  layout: LooseLayout
  className?: string
}) {
  const config: Partial<Config> = { displaylogo: false, responsive: true }
  const normalized = normalizeLayout(layout) as Partial<Layout>
  return (
    <div className={`plot-wrap ${className ?? ''}`}>
      <Suspense fallback={<div className="plot-loading">图表加载中…</div>}>
        <PlotlyPlot data={data} layout={{ ...normalized, autosize: true }} config={config} useResizeHandler />
      </Suspense>
    </div>
  )
}

/// Accept `xaxis: { title: 'Turn' }` (string) and rewrite to the object form
/// the plotly types demand. Also inject the slate design-token theme
/// (defaults only — explicit layout values win).
function normalizeLayout(layout: LooseLayout): LooseLayout {
  const out: LooseLayout = { ...layout }
  // Theme defaults (explicit layout props take precedence)
  if (out.paper_bgcolor === undefined) out.paper_bgcolor = '#ffffff'
  if (out.plot_bgcolor === undefined) out.plot_bgcolor = '#ffffff'
  if (out.font === undefined) out.font = { color: '#334155', size: 12 }
  const axisTheme = {
    gridcolor: '#e2e8f0',
    zerolinecolor: '#e2e8f0',
    linecolor: '#cbd5e1',
    title: { font: { color: '#475569' } },
    tickfont: { color: '#64748b' },
  }
  for (const axis of ['xaxis', 'yaxis', 'xaxis2', 'yaxis2'] as const) {
    const a = out[axis]
    const obj = a && typeof a === 'object' ? { ...(a as Record<string, unknown>) } : {}
    if (typeof obj.title === 'string') obj.title = { text: obj.title }
    for (const [k, v] of Object.entries(axisTheme)) {
      if (obj[k] === undefined) obj[k] = v
    }
    if (Object.keys(obj).length > 0) out[axis] = obj
  }
  return out
}

// Small helpers mirroring the shared Plotly builders in the legacy views.
// Categorical palette desaturated to match the slate/blue design language
// (was matplotlib tab10 — fully saturated, clashed with the page).
export function plotColors(i: number): string {
  const SAFE_PALETTE = [
    '#1a73e8', '#4e9e8a', '#c98a2d', '#c25b6b', '#8b6fbf',
    '#4f9fa8', '#8a8f98', '#d68a3d', '#7a9e5c', '#b56a86',
  ]
  return SAFE_PALETTE[i % SAFE_PALETTE.length]
}
