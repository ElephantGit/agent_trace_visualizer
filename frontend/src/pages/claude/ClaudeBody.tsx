// Claude Code view — 7 tabs (+ transcript-only 时间轴). Shared with
// embedded mode.

import { useMemo, useState } from 'react'
import type { ParseResult } from '../../api/types'
import { useMermaid, useWorkflowTree } from '../../hooks'
import Plot from '../../components/Plot'
import OverviewCharts from '../../components/OverviewCharts'
import ReplayView from '../../components/ReplayView'
import RawEventsTab from '../../components/RawEventsTab'
import ToolInspector from '../../components/ToolInspector'
import ToolEfficiencyTable from '../../components/ToolEfficiencyTable'
import TimelineView from '../../components/TimelineView'
import { Tabs, DataTable, DebugJson, Expander, Info } from '../../components/ui/primitives'
import {
  fmtTok,
  formatDuration,
  shapeTurns,
  mergeConsecutiveTurns,
  buildTimeline,
  grouped,
  toolSuccessRate,
} from '../../derive'

export default function ClaudeBody({
  result,
  embedded = false,
  live = false,
  liveEvents,
  initialTab,
}: {
  result: ParseResult
  embedded?: boolean
  /// 实时监控模式：时间轴自动滚动 + 新行高亮；各 tab 随节流刷新更新
  live?: boolean
  /// 实时模式下的即时事件流（SSE 毫秒级）；未提供时用 result.raw_events
  liveEvents?: unknown[]
  /// 初始选中的 tab（实时模式默认落在时间轴）
  initialTab?: string
}) {
  const isTranscript = result.parse_debug.format === 'transcript'
  const [tab, setTab] = useState(initialTab ?? 'replay')
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
        {result.session_info.model ? ` · ${result.session_info.model}` : ''}
        {result.parse_debug.cwd ? ` · cwd: ${String(result.parse_debug.cwd)}` : ''}
        {result.parse_debug.version ? ` · v${String(result.parse_debug.version)}` : ''}
      </div>
      <Tabs items={tabs} active={tab} onChange={setTab} />

      {tab === 'replay' && (
        <ReplayView
          agent="claude_code"
          rawEvents={result.raw_events}
          workflowRoot={workflowTree.data ?? null}
          result={result}
        />
      )}

      {tab === 'overview' && (
        <OverviewTab
          result={result}
          overview={overview}
          mermaidSrc={mermaid.data?.src}
          mermaidLoading={mermaid.isLoading}
        />
      )}

      {tab === 'tokens' && <TokensTab result={result} />}

      {tab === 'timeline' && isTranscript && (
        <TimelineTab rawEvents={liveEvents ?? result.raw_events} live={live} />
      )}

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
  mermaidLoading,
}: {
  result: ParseResult
  overview: { eventTypes: [string, number][]; toolCounts: [string, number][] }
  mermaidSrc?: string
  mermaidLoading: boolean
}) {
  const ri = result.result_info
  const successRate = toolSuccessRate(result.tool_calls)
  const peakInput = result.turns.length > 0
    ? result.turns.reduce((peak, turn) => Math.max(peak, turn.input_tokens), 0)
    : ri.total_input
  return (
    <div className="overview-page">
      <div className="metric-row overview-metrics overview-metrics-six">
        <div className="metric-card"><div className="m-title">LLM 推理轮次</div><div className="m-value">{result.turns.length}</div></div>
        <div className="metric-card"><div className="m-title">工具调用总数</div><div className="m-value">{result.tool_calls.length}</div></div>
        <div className="metric-card"><div className="m-title">峰值 Input Tokens</div><div className="m-value">{peakInput > 0 ? fmtTok(peakInput) : '—'}</div></div>
        <div className="metric-card"><div className="m-title">总耗时</div><div className="m-value">{formatDuration(ri.duration_ms)}</div></div>
        <div className="metric-card"><div className="m-title">总费用</div><div className="m-value">{ri.total_cost_usd > 0 ? `$${ri.total_cost_usd.toFixed(4)}` : '—'}</div></div>
        <div className="metric-card"><div className="m-title">工具调用成功率</div><div className={`m-value ${result.tool_calls.length === 0 ? '' : successRate < 100 ? 'metric-warn' : 'metric-ok'}`}>{result.tool_calls.length > 0 ? `${successRate.toFixed(1)}%` : '—'}</div></div>
      </div>
      <OverviewCharts
        eventTypes={overview.eventTypes}
        toolCounts={overview.toolCounts}
        mermaidSrc={mermaidSrc}
        mermaidLoading={mermaidLoading}
        sequenceTitle="会话时序图"
      />
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
      line: { color: '#0a9e6a', width: 2 },
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
      line: { color: '#8b6fbf', width: 2, dash: 'dot' },
    })
  }

  return (
    <div className="token-chart-stack">
      <div className="token-chart-note muted">
        已合并连续相同 input_tokens 的 Turn：{rawCount} → {merged.length} 个有效数据点。
        {excludesCache ? ' input_tokens 不含缓存命中；缓存行为见下方命中率图。' : ''}
      </div>

      <section className="token-chart-panel">
        <div className="token-chart-heading"><h3>Input / Output Tokens 趋势</h3></div>
        <Plot
          className="token-plot"
          data={trendData}
          layout={compactTokenLayout('Turn', { height: 310, legend: true })}
        />
      </section>

      <section className="token-chart-panel">
        <div className="token-chart-heading">
          <h3>Token 增量（上下文变化量）</h3>
          <p className="muted">正值为上下文增长，负值为 context compaction。</p>
        </div>
        <Plot
          className="token-plot"
          data={[
            { type: 'bar', x: rows.map((_, i) => i), y: rows.map((r) => r.input_delta), name: 'Input Δ', marker: { color: '#1a73e8' } },
            { type: 'bar', x: rows.map((_, i) => i), y: rows.map((r) => r.output_tokens), name: 'Output', marker: { color: '#0a9e6a' } },
          ]}
          layout={{ ...compactTokenLayout('有效数据点', { height: 255, legend: true }), barmode: 'group' }}
        />
      </section>

      {hasCache && (
        <section className="token-chart-panel">
          <div className="token-chart-heading">
            <h3>缓存命中率</h3>
            <p className="muted">Cache Read / 真实上下文窗口</p>
          </div>
          <Plot
            className="token-plot"
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
            layout={compactTokenLayout('有效数据点', { height: 235, legend: false, yTitle: 'Cache Hit %', top: 24 })}
          />
        </section>
      )}
    </div>
  )
}

function compactTokenLayout(
  xTitle: string,
  options: { height: number; legend: boolean; yTitle?: string; top?: number },
): Record<string, unknown> {
  return {
    height: options.height,
    margin: { t: options.top ?? (options.legend ? 34 : 12), r: 16, b: 42, l: 62, pad: 0 },
    showlegend: options.legend,
    legend: options.legend
      ? { orientation: 'h', x: 0, xanchor: 'left', y: 1.03, yanchor: 'bottom', font: { size: 11 } }
      : undefined,
    xaxis: { title: { text: xTitle, standoff: 5 }, automargin: true, ticklabelstandoff: 2 },
    yaxis: { title: { text: options.yTitle ?? 'Tokens', standoff: 5 }, automargin: true, ticklabelstandoff: 2 },
  }
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

// ── Timeline (transcript only)：共享 TimelineView ─────────────

function TimelineTab({ rawEvents, live = false }: { rawEvents: unknown[]; live?: boolean }) {
  const model = useMemo(() => buildTimeline(rawEvents), [rawEvents])
  return <TimelineView model={model} live={live} />
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
          { type: 'bar', x: ['API 等待', '本地处理'], y: [apiMs, localMs], marker: { color: ['#ea4335', '#0a9e6a'] } },
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
