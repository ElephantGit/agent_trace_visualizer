// Client-side pure row-shaping over already-shipped data (the TS half of the
// compute boundary: cumsums, diffs, groupbys, formatting).

import type { ToolCall, Turn } from './api/types'

// ── Formatting ────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (!ms) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.floor(s) % 60
  return `${m}m ${rem}s`
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function grouped(n: number): string {
  return n.toLocaleString('en-US')
}

// ── Turn row shaping ──────────────────────────────────────────

export interface TurnRow {
  turn_no: number
  /// Raw `input_tokens` from the trace, displayed exactly as recorded.
  /// NOTE: some providers (deepseek-style billing) EXCLUDE cache reads from
  /// this field — see `excludes_cache`.
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_creation: number
  cache_read_cum: number
  cache_creation_cum: number
  reasoning_cum: number
  /// `input_tokens.diff()` — first row is the row's own value (legacy
  /// `token_delta_fig`, opencode) or 0 (legacy claude `fillna(0)`).
  /// NOT clamped: negative values are context compaction releases.
  input_delta: number
  /// Cache hit rate. Denominator is the full prompt: `input_tokens` when the
  /// provider includes cache reads in it, `input_tokens + cache_read` when it
  /// doesn't — so the ratio never exceeds 100%.
  cache_hit_rate: number
  /// Per-session usage convention detected from the data.
  excludes_cache: boolean
}

/// Detect the usage convention of a session:
/// - Anthropic-style: `input_tokens` INCLUDES cache reads (cache_read ≤ input)
/// - deepseek-style: `input_tokens` EXCLUDES cache reads (cache_read can be
///   ≫ input_tokens — every call re-reads the full cached context)
/// Heuristic: any turn with cache_read > input_tokens (both > 0) marks the
/// excludes-cache convention. Under the includes-cache convention the
/// inequality never holds, so this never false-positives there.
export function usageExcludesCache(turns: Turn[]): boolean {
  return turns.some((t) => t.cache_read > 0 && t.input_tokens > 0 && t.cache_read > t.input_tokens)
}

export function shapeTurns(turns: Turn[], opts?: { deltaFillZero?: boolean }): TurnRow[] {
  const excludesCache = usageExcludesCache(turns)
  // Full prompt size — only used as the hit-rate denominator.
  const hitDenominator = (t: Turn) => t.input_tokens + (excludesCache ? t.cache_read : 0)
  let cumCacheRead = 0
  let cumCacheCreation = 0
  let cumReasoning = 0
  return turns.map((t, i) => {
    cumCacheRead += t.cache_read
    cumCacheCreation += t.cache_creation
    cumReasoning += t.reasoning_tokens
    const inputDelta =
      i === 0
        ? opts?.deltaFillZero
          ? 0
          : t.input_tokens
        : t.input_tokens - turns[i - 1].input_tokens
    const denom = hitDenominator(t)
    return {
      turn_no: t.turn_no,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      cache_read: t.cache_read,
      cache_creation: t.cache_creation,
      cache_read_cum: cumCacheRead,
      cache_creation_cum: cumCacheCreation,
      reasoning_cum: cumReasoning,
      input_delta: inputDelta,
      cache_hit_rate: denom > 0 ? t.cache_read / denom : 0,
      excludes_cache: excludesCache,
    }
  })
}

/// Port of claude_code `_merge_consecutive_turns_df`: consecutive turns with
/// the SAME `input_tokens` merge into one data point (chained tool calls
/// share the context window). Merged rows: output/tool_count sum, cache
/// fields take the max, text_content concatenates. This is the legacy
/// criterion — merging by model would collapse a whole single-model session
/// into one row.
export function mergeConsecutiveTurns(turns: Turn[]): Turn[] {
  if (turns.length === 0) return []
  const merged: Turn[] = []
  for (const t of turns) {
    const last = merged[merged.length - 1]
    if (last && last.input_tokens === t.input_tokens) {
      last.output_tokens += t.output_tokens
      last.tool_count += t.tool_count
      last.cache_read = Math.max(last.cache_read, t.cache_read)
      last.cache_creation = Math.max(last.cache_creation, t.cache_creation)
      if (t.text_content) {
        last.text_content = [last.text_content, t.text_content].filter(Boolean).join('\n')
      }
    } else {
      merged.push({ ...t })
    }
  }
  return merged
}

// ── Tool row shaping ──────────────────────────────────────────

export interface ToolAggRow {
  name: string
  count: number
  total_chars: number
  avg_chars: number
  total_tiktoken: number
  avg_tiktoken: number
  errors: number
  success_rate: string
  avg_duration_ms: number | null
  max_duration_ms: number | null
}

export function shapeTools(tools: ToolCall[]): ToolAggRow[] {
  const groups = new Map<string, ToolCall[]>()
  for (const tc of tools) {
    const list = groups.get(tc.name) ?? []
    list.push(tc)
    groups.set(tc.name, list)
  }
  const hasDuration = tools.some((t) => t.duration_ms > 0)
  return [...groups.entries()].map(([name, list]) => {
    const count = list.length
    const totalChars = list.reduce((s, t) => s + t.output_chars, 0)
    const totalTok = list.reduce((s, t) => s + t.tiktoken_tokens, 0)
    const errors = list.filter((t) => t.is_error).length
    const rate = (1 - errors / Math.max(1, count)) * 100
    return {
      name,
      count,
      total_chars: totalChars,
      avg_chars: totalChars / count,
      total_tiktoken: totalTok,
      avg_tiktoken: totalTok / count,
      errors,
      success_rate: `${rate.toFixed(1)}%`,
      avg_duration_ms: hasDuration
        ? list.reduce((s, t) => s + t.duration_ms, 0) / count
        : null,
      max_duration_ms: hasDuration ? Math.max(...list.map((t) => t.duration_ms)) : null,
    }
  })
}

export function toolSuccessRate(tools: ToolCall[]): number {
  if (tools.length === 0) return 100
  const errors = tools.filter((t) => t.is_error).length
  return Math.round((1 - errors / tools.length) * 1000) / 10
}

// ── Timeline (DevTools Network-style waterfall) ───────────────

export type TimelineKind = 'user' | 'llm' | 'tool' | 'system'

export interface TimelineEvent {
  ts_ms: number
  ts: string
  kind: TimelineKind
  /// 回放引擎同款分类（11 类之一）：
  /// system / llm_text / tool_call / tool_result / subagent / skill / mcp /
  /// result / error / user_input / thinking
  category: string
  /// 轮次号：每条用户输入开启新轮次（开场前事件归 0）
  turn_no: number
  /// 轮次内层级：用户=0，LLM/思考=1，工具调用=2，工具结果=3（挂在发起它的
  /// 工具之下），系统/元事件=1
  depth: number
  /// 名称列：文本摘要 / model / 工具名 / 事件描述
  name: string
  /// 状态列：✅/❌、stop_reason、插值标记等
  status: string
  in_tokens: number
  out_tokens: number
  /// 瀑布条时长：工具=真实耗时；其余为 null（渲染最小宽标记点）
  duration_ms: number | null
  /// 耗时列展示值（LLM 行显示延迟）
  display_duration_ms: number | null
  tool_name: string
  is_error: boolean
  /// 无 timestamp 的元事件按文件顺序插值到相邻时间戳
  interpolated: boolean
  detail: Record<string, unknown>
}

/// 回放引擎的 `_classify_tool` 移植（backend/src/derive/replay.rs）。
export function classifyToolCategory(toolName: string): 'subagent' | 'skill' | 'mcp' | 'tool_call' {
  if (toolName.startsWith('mcp__')) return 'mcp'
  const lower = toolName.toLowerCase()
  if (['task', 'delegate', 'subagent', 'agent'].includes(lower)) return 'subagent'
  if (['skill', 'run_skill', 'use_skill'].includes(lower)) return 'skill'
  return 'tool_call'
}

export interface TimelineModel {
  events: TimelineEvent[]
  min_ts_ms: number
  max_ts_ms: number
  tool_names: string[]
  stats: {
    total_ms: number
    user_count: number
    llm_count: number
    tool_count: number
    avg_latency_ms: number
    max_latency_ms: number
  }
}

function tsOf(evt: Record<string, unknown>): number | null {
  const ts = evt.timestamp as string | undefined
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? null : ms
}

function textPreview(content: unknown, n = 60): string {
  if (typeof content === 'string') return content.slice(0, n)
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text') {
        const t = (b as Record<string, unknown>).text
        if (typeof t === 'string') parts.push(t)
      }
    }
    return parts.join(' ').slice(0, n)
  }
  return ''
}

function bisectLeft(arr: number[], x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/// DevTools Network-style timeline rows: every session event becomes a list
/// entry with a waterfall start time and (for tools) a real duration.
export function buildTimeline(rawEvents: unknown[]): TimelineModel {
  // ── Pass 1: collect items + tool pairing maps ────────────────
  interface Item {
    evt: Record<string, unknown>
    ts_ms: number | null
  }
  const items: Item[] = []
  const toolUses = new Map<
    string,
    { ts_ms: number; name: string; input: unknown }
  >()
  const toolResults = new Map<
    string,
    { ts_ms: number; output: unknown; is_error: boolean }
  >()

  for (const raw of rawEvents) {
    const evt = raw as Record<string, unknown>
    const type = (evt.type as string) ?? ''
    const tsMs = tsOf(evt)
    items.push({ evt, ts_ms: tsMs })

    const message = (evt.message ?? {}) as Record<string, unknown>
    if (type === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_use') {
          const tu = b as Record<string, unknown>
          const id = String(tu.id ?? '')
          if (id && tsMs !== null) {
            toolUses.set(id, { ts_ms: tsMs, name: String(tu.name ?? 'tool'), input: tu.input })
          }
        }
      }
    } else if (type === 'user') {
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result') {
          const tr = b as Record<string, unknown>
          const id = String(tr.tool_use_id ?? tr.toolUseId ?? '')
          if (id && tsMs !== null) {
            toolResults.set(id, {
              ts_ms: tsMs,
              output: tr.content,
              is_error: Boolean(tr.is_error),
            })
          }
        }
      }
    } else if (type === 'tool_result') {
      const id = String(evt.tool_use_id ?? evt.toolUseId ?? '')
      if (id && tsMs !== null) {
        toolResults.set(id, {
          ts_ms: tsMs,
          output: evt.content,
          is_error: Boolean(evt.is_error ?? evt.isError),
        })
      }
    }
  }

  // ── Pass 2: interpolate timestamps for meta events ──────────
  for (let i = 0; i < items.length; i++) {
    if (items[i].ts_ms !== null) continue
    let resolved: number | null = null
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].ts_ms !== null) {
        resolved = items[j].ts_ms
        break
      }
    }
    if (resolved === null) {
      for (let k = i - 1; k >= 0; k--) {
        if (items[k].ts_ms !== null) {
          resolved = items[k].ts_ms
          break
        }
      }
    }
    items[i].ts_ms = resolved
  }

  // ── Pass 3: build events in file order ──────────────────────
  const events: TimelineEvent[] = []
  const userTsList: number[] = []
  let minTs = Infinity
  let maxTs = -Infinity
  let currentTurn = 0
  const turnToolIds = new Set<string>()

  const push = (e: Omit<TimelineEvent, 'in_tokens' | 'out_tokens'>) => {
    const ts = e.ts_ms
    if (Number.isFinite(ts)) {
      minTs = Math.min(minTs, ts)
      maxTs = Math.max(maxTs, ts)
    }
    events.push({ ...e, in_tokens: 0, out_tokens: 0 })
  }

  for (const item of items) {
    const evt = item.evt
    const type = (evt.type as string) ?? ''
    const tsMs = item.ts_ms
    if (tsMs === null) continue
    const ts = new Date(tsMs).toISOString()
    const message = (evt.message ?? {}) as Record<string, unknown>
    const usage = (message.usage ?? {}) as Record<string, number>

    if (type === 'user') {
      const preview = textPreview(message.content)
      const origin = (evt.origin ?? {}) as Record<string, unknown>
      userTsList.push(tsMs)
      currentTurn += 1
      turnToolIds.clear()
      push({
        ts_ms: tsMs,
        ts,
        kind: 'user',
        category: 'user_input',
        turn_no: currentTurn,
        depth: 0,
        name: preview || '用户输入',
        status: [evt.promptSource, origin.kind].filter(Boolean).join(' / '),
        duration_ms: null,
        display_duration_ms: null,
        tool_name: '',
        is_error: false,
        interpolated: false,
        detail: { evt, promptId: evt.promptId, content: message.content },
      })
      continue
    }

    if (type === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      // 思考块 → 独立 thinking 行（与回放引擎一致）
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'thinking') {
          const th = b as Record<string, unknown>
          const text = String(th.thinking ?? th.text ?? '')
          if (text.trim()) {
            push({
              ts_ms: tsMs,
              ts,
              kind: 'llm',
              category: 'thinking',
              turn_no: currentTurn,
              depth: 1,
              name: '思考过程',
              status: '',
              duration_ms: null,
              display_duration_ms: null,
              tool_name: '',
              is_error: false,
              interpolated: false,
              detail: { evt, thinking: text },
            })
          }
        }
      }
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_use') {
          const tu = b as Record<string, unknown>
          const id = String(tu.id ?? '')
          const use = toolUses.get(id)
          const res = toolResults.get(id)
          const duration = use && res ? Math.max(0, res.ts_ms - use.ts_ms) : null
          const toolName = String(tu.name ?? 'tool')
          if (id) turnToolIds.add(id)
          push({
            ts_ms: tsMs,
            ts,
            kind: 'tool',
            category: classifyToolCategory(toolName),
            turn_no: currentTurn,
            depth: 2,
            name: toolName,
            status: !res ? '无结果' : res.is_error ? '❌' : '✅',
            duration_ms: duration,
            display_duration_ms: duration,
            tool_name: toolName,
            is_error: res?.is_error ?? false,
            interpolated: false,
            detail: {
              evt,
              tool_id: id,
              input: tu.input,
              output: res?.output,
              is_error: res?.is_error ?? false,
              start: use?.ts_ms,
              end: res?.ts_ms,
            },
          })
        }
      }
      push({
        ts_ms: tsMs,
        ts,
        kind: 'llm',
        category: 'llm_text',
        turn_no: currentTurn,
        depth: 1,
        name: String(message.model ?? 'assistant'),
        status: String(message.stop_reason ?? ''),
        duration_ms: null,
        display_duration_ms: null, // latency filled after userTsList is complete
        tool_name: '',
        is_error: false,
        interpolated: false,
        detail: { evt, model: message.model, stop_reason: message.stop_reason, usage },
      })
      continue
    }

    // ── system / meta events ─────────────────────────────────
    const subtype = (evt.subtype as string) ?? ''
    let name = ''
    let status = ''
    let duration: number | null = null
    let displayDuration: number | null = null
    if (type === 'system' && subtype === 'local_command') {
      const m = /<command-name>([^<]*)<\/command-name>/.exec(String(evt.content ?? ''))
      name = m ? `命令 ${m[1]}` : '命令'
    } else if (type === 'system' && subtype === 'turn_duration') {
      name = '轮次完成'
      status = `${Math.round(Number(evt.durationMs ?? 0) / 1000)}s · ${evt.messageCount ?? 0} 条消息`
      duration = Number(evt.durationMs ?? 0)
      displayDuration = duration
    } else if (type === 'system' && subtype === 'away_summary') {
      name = '离开总结'
      status = textPreview(evt.content, 40)
    } else if (type === 'system') {
      name = subtype ? `系统 ${subtype}` : '系统'
      status = textPreview(evt.content, 40)
    } else if (type === 'queue-operation') {
      const m = /<task-id>([^<]*)<\/task-id>/.exec(String(evt.content ?? ''))
      name = `队列 ${evt.operation ?? ''}`
      status = m ? m[1] : ''
    } else if (type === 'permission-mode') {
      name = '权限模式'
      status = String(evt.permissionMode ?? '')
    } else if (type === 'mode') {
      name = '模式'
      status = String(evt.mode ?? '')
    } else if (type === 'agent-name') {
      name = 'Agent'
      status = String(evt.agentName ?? '')
    } else if (type === 'ai-title') {
      name = '会话标题'
      status = String(evt.aiTitle ?? '')
    } else if (type === 'last-prompt') {
      name = '最后提示词'
      status = textPreview(evt.lastPrompt, 40)
    } else if (type === 'file-history-snapshot') {
      name = '文件快照'
    } else if (type === 'attachment') {
      name = '附件更新'
      const att = (evt.attachment ?? {}) as Record<string, unknown>
      status = String(att.type ?? '')
    } else {
      // top-level tool_result (already used for pairing; show a marker row
      // for the result itself so its arrival time is visible)
      if (type === 'tool_result') {
        name = '工具结果'
        status = ''
      } else {
        continue
      }
    }
    const interpolated = tsOf(evt) === null
    const isToolResultRow = type === 'tool_result'
    const isToolResultError =
      isToolResultRow && Boolean(evt.is_error ?? evt.isError)
    if (isToolResultRow) {
      // 工具结果：挂在发起它的工具调用之下（同轮次内则缩进一级）
      const tid = String(evt.tool_use_id ?? evt.toolUseId ?? '')
      push({
        ts_ms: tsMs,
        ts,
        kind: 'tool',
        category: isToolResultError ? 'error' : 'tool_result',
        turn_no: currentTurn,
        depth: tid && turnToolIds.has(tid) ? 3 : 2,
        name,
        status,
        duration_ms: duration,
        display_duration_ms: displayDuration,
        tool_name: isToolResultRow ? name : '',
        is_error: isToolResultError,
        interpolated,
        detail: { evt },
      })
    } else {
      push({
        ts_ms: tsMs,
        ts,
        kind: 'system',
        category: 'system',
        turn_no: currentTurn,
        depth: 1,
        name,
        status,
        duration_ms: duration,
        display_duration_ms: displayDuration,
        tool_name: '',
        is_error: false,
        interpolated,
        detail: { evt },
      })
    }
  }

  // ── LLM latency (legacy bisect semantics) + tokens ──────────
  userTsList.sort((a, b) => a - b)
  const latencies: number[] = []
  for (const e of events) {
    if (e.kind !== 'llm') continue
    const idx = bisectLeft(userTsList, e.ts_ms)
    if (idx > 0) {
      const latency = Math.max(0, e.ts_ms - userTsList[idx - 1])
      e.display_duration_ms = latency
      latencies.push(latency)
    }
    const usage = (e.detail.usage ?? {}) as Record<string, number>
    e.in_tokens = Number(usage.input_tokens ?? 0)
    e.out_tokens = Number(usage.output_tokens ?? 0)
  }
  // (tool rows keep token columns at 0 → the UI renders '—')

  // stable sort by time (file order is preserved for ties)
  events.sort((a, b) => a.ts_ms - b.ts_ms)

  const toolNames = [...new Set(events.filter((e) => e.kind === 'tool').map((e) => e.tool_name))]
  const toolCount = events.filter((e) => e.kind === 'tool').length
  const llmCount = events.filter((e) => e.kind === 'llm').length
  const userCount = events.filter((e) => e.kind === 'user').length

  return {
    events,
    min_ts_ms: Number.isFinite(minTs) ? minTs : 0,
    max_ts_ms: Number.isFinite(maxTs) ? maxTs : 0,
    tool_names: toolNames,
    stats: {
      total_ms: maxTs - minTs,
      user_count: userCount,
      llm_count: llmCount,
      tool_count: toolCount,
      avg_latency_ms: latencies.length
        ? latencies.reduce((s, l) => s + l, 0) / latencies.length
        : 0,
      max_latency_ms: latencies.length ? Math.max(...latencies) : 0,
    },
  }
}

// ── CSV / NDJSON builders ─────────────────────────────────────

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const keys = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))]
  return lines.join('\n')
}

export function toNdjson(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n')
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
