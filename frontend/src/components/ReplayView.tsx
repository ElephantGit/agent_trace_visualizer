// 会话回放——与时间轴同源的三类信息视图（buildTimeline / buildTimelineOpencode）：
// 只展示 用户真实输入 / 模型文本输出 / 工具调用+结果（合并为一条），
// 按轮次分组：用户输入 → 模型响应（含工具调用）→ 工具结果返回 = 一轮。
// 工作流视图作为子页保留。

import { Fragment, useMemo, useState } from 'react'
import type { TimelineEvent } from '../derive'
import { buildTimeline, buildTimelineOpencode, formatDuration, grouped } from '../derive'
import { Pagination, Info, DebugJson } from './ui/primitives'
import WorkflowView from './WorkflowView'

const KIND_META: Record<string, { icon: string; label: string; cls: string }> = {
  user: { icon: '👤', label: '用户输入', cls: 'rp-user' },
  llm: { icon: '🤖', label: '模型文本', cls: 'rp-llm' },
  tool: { icon: '🔧', label: '工具', cls: 'rp-tool' },
}

const PAGE_SIZE = 50

function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export default function ReplayView({
  agent,
  rawEvents,
  workflowRoot,
  result,
}: {
  agent: 'claude_code' | 'opencode'
  rawEvents: unknown[]
  workflowRoot?: import('../api/types').WorkflowNode | null
  result?: import('../api/types').ParseResult | null
}) {
  const [mode, setMode] = useState<'replay' | 'workflow'>('replay')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)

  const model = useMemo(
    () => (agent === 'opencode' ? buildTimelineOpencode(rawEvents) : buildTimeline(rawEvents)),
    [agent, rawEvents],
  )

  const viewSwitch = (
    <div className="pills" style={{ margin: '6px 0' }}>
      <button className={`pill ${mode === 'replay' ? 'pill-active' : ''}`} onClick={() => setMode('replay')}>
        📜 会话回放
      </button>
      <button className={`pill ${mode === 'workflow' ? 'pill-active' : ''}`} onClick={() => setMode('workflow')}>
        🔀 工作流视图
      </button>
    </div>
  )

  if (mode === 'workflow') {
    return (
      <div>
        {viewSwitch}
        <WorkflowView root={workflowRoot ?? null} result={result ?? null} />
      </div>
    )
  }

  const filtered = useMemo(
    () =>
      model.events.filter(
        (e) =>
          !keyword ||
          e.name.toLowerCase().includes(keyword.toLowerCase()) ||
          e.tool_name.toLowerCase().includes(keyword.toLowerCase()),
      ),
    [model.events, keyword],
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * PAGE_SIZE
  const pageEvents = filtered.slice(start, start + PAGE_SIZE)

  if (model.events.length === 0) {
    return (
      <div>
        {viewSwitch}
        <Info>暂无会话事件可供回放。</Info>
      </div>
    )
  }

  return (
    <div>
      {viewSwitch}
      <p className="muted">
        共 {model.events.length} 个事件 · {new Set(model.events.map((e) => e.turn_no)).size} 轮对话 —
        每轮 = 用户输入 → 模型响应（含工具调用）→ 工具结果返回
      </p>

      <div className="pills" style={{ margin: '6px 0' }}>
        <input
          type="text"
          placeholder="关键词搜索"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setPage(1)
          }}
          className="pill-input"
        />
      </div>

      <Pagination
        page={safePage}
        totalPages={totalPages}
        total={filtered.length}
        start={filtered.length === 0 ? 0 : start + 1}
        end={Math.min(start + PAGE_SIZE, filtered.length)}
        onPage={setPage}
      />

      {pageEvents.map((e, i) => {
        const globalIdx = start + i
        const prev = globalIdx > 0 ? filtered[globalIdx - 1] : null
        const isTurnStart = !prev || prev.turn_no !== e.turn_no
        return (
          <Fragment key={`${e.turn_no}-${e.ts_ms}-${globalIdx}`}>
            {isTurnStart && (
              <div className="rp-turn-sep">
                ━━━ 第 {e.turn_no} 轮 · {formatClock(e.ts_ms)} ━━━
              </div>
            )}
            <RoundEventCard event={e} />
          </Fragment>
        )
      })}
    </div>
  )
}

function RoundEventCard({ event }: { event: TimelineEvent }) {
  const meta = KIND_META[event.kind] ?? KIND_META.user
  const usage = (event.detail.usage ?? {}) as Record<string, number>
  const detail = event.detail as Record<string, unknown>

  const dur =
    event.duration_ms !== null
      ? event.duration_ms >= 1000
        ? `${(event.duration_ms / 1000).toFixed(1)}s`
        : `${event.duration_ms.toFixed(0)}ms`
      : null

  return (
    <details
      className={`step-card ${meta.cls}`}
      open
      style={{ marginLeft: Math.min(event.depth, 8) * 18 }}
    >
      <summary>
        <span className="rp-kind-icon">{meta.icon}</span>
        <span className="title-text">{event.name.slice(0, 120)}{event.is_error ? ' ❌' : ''}</span>
        <span className="rp-kind-label">{meta.label}</span>
        {event.tool_name && <span className="badge">🔧 {event.tool_name}</span>}
        {dur && <span className="micro-tag">⏱️ {dur}</span>}
        <span className="fold-toggle">展开 ▼</span>
      </summary>
      <div className="step-body">
        {event.kind === 'user' && (
          <pre className="debug-json">{typeof detail.text === 'string' ? detail.text : '（空输入）'}</pre>
        )}

        {event.kind === 'llm' && (
          <>
            <pre className="debug-json">
              {typeof detail.text === 'string' && detail.text ? detail.text : '（无文本输出，仅发起工具调用）'}
            </pre>
            <div className="step-meta">
              {event.detail.model ? `🧩 ${String(event.detail.model)}` : ''}
              {event.detail.stop_reason ? ` · 停止原因: ${String(event.detail.stop_reason)}` : ''}
              {usage.input_tokens !== undefined ? ` · 🎯 in=${grouped(Number(usage.input_tokens))}` : ''}
              {usage.output_tokens !== undefined ? ` out=${grouped(Number(usage.output_tokens))}` : ''}
            </div>
          </>
        )}

        {event.kind === 'tool' && (
          <>
            <div className="step-tool-row">
              <span className="step-tool-name">📥 输入参数</span>
              {detail.input !== undefined ? (
                <DebugJson value={detail.input} />
              ) : (
                <p className="muted">（无入参）</p>
              )}
            </div>
            <h4>📤 执行结果</h4>
            {typeof detail.output === 'string' ? (
              <pre className="debug-json">{detail.output || '（空输出）'}</pre>
            ) : (
              <p className="muted">该工具调用没有对应的执行结果。</p>
            )}
            {event.status && (
              <div className="step-meta">
                {event.is_error ? '❌ ' : '✅ '}状态：{event.status}
                {event.duration_ms !== null ? ` · 耗时 ${formatDuration(event.duration_ms)}` : ''}
              </div>
            )}
          </>
        )}
      </div>
    </details>
  )
}
