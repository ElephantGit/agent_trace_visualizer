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
/// the plotly types demand. Deep-copies nothing else.
function normalizeLayout(layout: LooseLayout): LooseLayout {
  const out: LooseLayout = { ...layout }
  for (const axis of ['xaxis', 'yaxis', 'xaxis2', 'yaxis2'] as const) {
    const a = out[axis]
    if (a && typeof a === 'object' && typeof (a as Record<string, unknown>).title === 'string') {
      const copy = { ...(a as Record<string, unknown>) }
      copy.title = { text: copy.title }
      out[axis] = copy
    }
  }
  return out
}

// Small helpers mirroring the shared Plotly builders in the legacy views.
export function plotColors(i: number): string {
  const SAFE_PALETTE = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  ]
  return SAFE_PALETTE[i % SAFE_PALETTE.length]
}
