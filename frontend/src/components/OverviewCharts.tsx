import MermaidView from './MermaidView'
import Plot, { plotColors } from './Plot'
import { Info } from './ui/primitives'

export type CountEntry = [string, number]

export default function OverviewCharts({
  eventTypes,
  toolCounts,
  mermaidSrc,
  mermaidLoading = false,
  sequenceTitle,
}: {
  eventTypes: CountEntry[]
  toolCounts: CountEntry[]
  mermaidSrc?: string
  mermaidLoading?: boolean
  sequenceTitle: string
}) {
  return (
    <>
      <div className="overview-grid">
        <section className="overview-panel">
          <div className="overview-panel-heading">
            <div>
              <h3>事件类型分布</h3>
              <p className="muted">共 {eventTypes.reduce((sum, [, count]) => sum + count, 0)} 个原始事件</p>
            </div>
          </div>
          {eventTypes.length > 0 ? (
            <Plot
              data={[
                {
                  type: 'pie',
                  labels: eventTypes.map(([name]) => name),
                  values: eventTypes.map(([, count]) => count),
                  hole: 0.48,
                  sort: false,
                  textinfo: 'percent',
                  textposition: 'inside',
                  marker: { colors: eventTypes.map((_, index) => plotColors(index)) },
                  hovertemplate: '%{label}<br>%{value} 次 · %{percent}<extra></extra>',
                },
              ]}
              layout={{
                height: 320,
                margin: { t: 8, r: 8, b: 42, l: 8 },
                showlegend: true,
                legend: { orientation: 'h', x: 0, y: -0.08 },
              }}
            />
          ) : (
            <Info>暂无事件数据。</Info>
          )}
        </section>

        <section className="overview-panel">
          <div className="overview-panel-heading">
            <div>
              <h3>工具调用分布</h3>
              <p className="muted">共 {toolCounts.reduce((sum, [, count]) => sum + count, 0)} 次调用</p>
            </div>
          </div>
          {toolCounts.length > 0 ? (
            <Plot
              data={[
                {
                  type: 'bar',
                  orientation: 'h',
                  x: toolCounts.map(([, count]) => count),
                  y: toolCounts.map(([name]) => name),
                  text: toolCounts.map(([, count]) => String(count)),
                  textposition: 'auto',
                  cliponaxis: false,
                  marker: { color: toolCounts.map((_, index) => plotColors(index)) },
                  hovertemplate: '%{y}<br>%{x} 次<extra></extra>',
                },
              ]}
              layout={{
                height: Math.max(260, Math.min(420, 92 + toolCounts.length * 34)),
                margin: { t: 8, r: 32, b: 42, l: 112 },
                showlegend: false,
                xaxis: { title: '调用次数', rangemode: 'tozero', dtick: 1 },
                yaxis: { autorange: 'reversed', automargin: true },
              }}
            />
          ) : (
            <Info>本次会话暂无工具调用。</Info>
          )}
        </section>
      </div>

      <section className="overview-panel overview-sequence-panel">
        <div className="overview-panel-heading">
          <div>
            <h3>{sequenceTitle}</h3>
            <p className="muted">展示用户、模型与工具之间的主要交互；长会话会抽样显示。</p>
          </div>
        </div>
        {mermaidSrc ? (
          <MermaidView src={mermaidSrc} notice={null} />
        ) : mermaidLoading ? (
          <div className="overview-loading">正在生成时序图…</div>
        ) : (
          <Info>未找到可渲染的关键事件。</Info>
        )}
      </section>
    </>
  )
}
