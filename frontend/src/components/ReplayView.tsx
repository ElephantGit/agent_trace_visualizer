// Session replay backed by the original Rust replay adapter. It preserves tool start/result
// pairing, subagent/skill/MCP classification and the parser's own turn state machine.

import { useMemo, useState } from 'react'
import type { CategoryStyle } from '../api/types'
import { useReplay, type LiveAgent } from '../hooks'
import { ErrorBanner, Info, Pagination, Pills } from './ui/primitives'
import ReplayStepCard from './ReplayStepCard'
import WorkflowView from './WorkflowView'

type ReplayPhase = 'user' | 'thinking' | 'output' | 'tools' | 'final'

const PHASE_META: Record<ReplayPhase, { label: string; icon: string; hint: string }> = {
  user: { label: '用户输入', icon: '↳', hint: '本轮任务' },
  thinking: { label: '思考过程', icon: '◎', hint: '模型内部推理' },
  output: { label: '模型输出', icon: '◌', hint: '模型生成的文本' },
  tools: { label: '工具调用', icon: '⌘', hint: '调用与返回' },
  final: { label: '最终结果', icon: '✓', hint: '会话收束' },
}

function phaseFor(category: string): ReplayPhase {
  if (category === 'user_input') return 'user'
  if (category === 'thinking') return 'thinking'
  if (category === 'llm_text') return 'output'
  if (['tool_call', 'tool_result', 'subagent', 'skill', 'mcp', 'error'].includes(category)) return 'tools'
  if (['result'].includes(category)) return 'final'
  return 'output'
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): { key: string; items: T[] }[] {
  const groups: { key: string; items: T[] }[] = []
  for (const item of items) {
    const key = keyOf(item)
    const current = groups[groups.length - 1]
    if (current?.key === key) current.items.push(item)
    else groups.push({ key, items: [item] })
  }
  return groups
}

function ReplayTurn({ turnNo, steps, styles }: { turnNo: number; steps: import('../api/types').ReplayStep[]; styles: Map<string, CategoryStyle> }) {
  const phaseGroups = groupBy(steps, (step) => phaseFor(step.category))
  return (
    <section className="replay-turn" aria-label={`第 ${turnNo} 轮交互`}>
      <div className="replay-turn-heading">
        <span className="replay-turn-index">{String(turnNo).padStart(2, '0')}</span>
        <div>
          <div className="replay-turn-title">{`第 ${turnNo} 轮交互`}</div>
          <div className="replay-turn-subtitle">{steps.length} 个事件 · 按发生顺序展示</div>
        </div>
      </div>
      <div className="replay-turn-body">
        {phaseGroups.map(({ key, items }) => {
          const phase = key as ReplayPhase
          const meta = PHASE_META[phase]
          return (
            <div className={`replay-phase replay-phase-${phase}`} key={`${turnNo}-${key}`}>
              <div className="replay-phase-label">
                <span className="replay-phase-icon">{meta.icon}</span>
                <span>{meta.label}</span>
                <span className="replay-phase-hint">{meta.hint}</span>
                <span className="replay-phase-count">{items.length}</span>
              </div>
              <div className="replay-phase-items">
                {items.map((step, index) => (
                  <ReplayStepCard key={`${step.seq}-${index}`} step={step} style={styles.get(step.category)} phase={phase} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function ReplayView({ agent, rawEvents, workflowRoot, result }: {
  agent: LiveAgent
  rawEvents: unknown[]
  workflowRoot?: import('../api/types').WorkflowNode | null
  result?: import('../api/types').ParseResult | null
}) {
  const replay = useReplay(agent, rawEvents)
  const data = replay.data
  const [mode, setMode] = useState<'replay' | 'workflow'>('replay')
  const [selected, setSelected] = useState<string[] | null>(null)
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)

  const styles = useMemo(() => new Map<string, CategoryStyle>(data?.categories ?? []), [data?.categories])
  // System initialization/session bookkeeping is useful for diagnostics, but does not belong
  // in the user-facing task narrative. Normalize zero-valued turns so the first user message
  // appears at the start of the first interaction and the final result closes the last one.
  const replaySteps = useMemo(() => {
    if (!data) return []
    const meaningful = data.steps.filter((step) => step.category !== 'system')
    const numberedTurns = meaningful.map((step) => step.turn_no).filter((turn) => turn > 0)
    const firstTurn = numberedTurns.length > 0 ? Math.min(...numberedTurns) : 1
    const lastTurn = numberedTurns.length > 0 ? Math.max(...numberedTurns) : firstTurn
    return meaningful.map((step) => ({
      ...step,
      turn_no: step.turn_no > 0 ? step.turn_no : step.category === 'result' || step.category === 'error' ? lastTurn : firstTurn,
    }))
  }, [data])
  const present = useMemo(
    () => (data?.categories ?? []).filter(([key]) => replaySteps.some((step) => step.category === key)),
    [data?.categories, replaySteps],
  )
  const activeCategories = useMemo(
    () => selected ?? present.map(([key]) => key),
    [selected, present],
  )
  const filtered = useMemo(() => {
    const active = new Set(activeCategories)
    const query = keyword.toLowerCase()
    return replaySteps.filter(
      (step) => active.has(step.category) && (!query || JSON.stringify(step).toLowerCase().includes(query)),
    )
  }, [replaySteps, activeCategories, keyword])

  const viewSwitch = (
    <div className="pills" style={{ margin: '6px 0' }}>
      <button className={`pill ${mode === 'replay' ? 'pill-active' : ''}`} onClick={() => setMode('replay')}>
        📜 事件回放
      </button>
      <button className={`pill ${mode === 'workflow' ? 'pill-active' : ''}`} onClick={() => setMode('workflow')}>
        🔀 工作流视图
      </button>
    </div>
  )

  if (mode === 'workflow') {
    return <div>{viewSwitch}<WorkflowView root={workflowRoot ?? null} result={result ?? null} /></div>
  }
  if (replay.isLoading) return <div>{viewSwitch}<p className="muted">正在生成会话回放…</p></div>
  if (replay.error) return <div>{viewSwitch}<ErrorBanner>{String(replay.error)}</ErrorBanner></div>
  if (!data || replaySteps.length === 0) return <div>{viewSwitch}<Info>暂无可展示的任务过程。</Info></div>

  const totalPages = Math.max(1, Math.ceil(filtered.length / data.pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * data.pageSize
  const pageSteps = filtered.slice(start, start + data.pageSize)
  const optionFor = (key: string) => {
    const style = styles.get(key)!
    const count = replaySteps.filter((step) => step.category === key).length
    return `${style.icon} ${style.label} (${count})`
  }

  return (
    <div>
      {viewSwitch}
      <h3>📜 任务过程回放</h3>
      <p className="muted">共 {replaySteps.length} 个步骤 · 展示从用户指令到最终结果的完整过程</p>

      {present.length > 1 && (
        <div className="legend-chips">
          {present.map(([key, style]) => (
            <span key={key} className="legend-chip" style={{ background: style.header_bg, color: style.text, border: `1px solid ${style.border}` }}>
              {style.icon} {style.label} ({replaySteps.filter((step) => step.category === key).length})
            </span>
          ))}
        </div>
      )}

      <div className="pills">
        <input type="text" placeholder="关键词搜索" value={keyword} className="pill-input"
          onChange={(event) => { setKeyword(event.target.value); setPage(1) }} />
        <Pills
          options={present.map(([key]) => optionFor(key))}
          selected={activeCategories.map(optionFor)}
          onChange={(options) => {
            setSelected(options.flatMap((option) => {
              const match = present.find(([key]) => optionFor(key) === option)
              return match ? [match[0]] : []
            }))
            setPage(1)
          }}
          multi
        />
      </div>

      {activeCategories.length === 0 && <Info>请至少选择一个事件类型以查看回放。</Info>}

      <Pagination page={safePage} totalPages={totalPages} total={filtered.length}
        start={filtered.length === 0 ? 0 : start + 1} end={Math.min(start + data.pageSize, filtered.length)}
        onPage={setPage} />

      <div className="replay-stream">
        {groupBy(pageSteps, (step) => String(step.turn_no)).map(({ key, items }) => (
          <ReplayTurn key={key} turnNo={Number(key)} steps={items} styles={styles} />
        ))}
      </div>
    </div>
  )
}
