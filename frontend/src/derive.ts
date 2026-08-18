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

// ── Timeline：三种核心信息（用户输入 / 模型文本 / 工具调用+结果）──
// 从原始 transcript jsonl 中只提取三类信息，其余事件（thinking、
// permission-mode、queue-operation 等系统/元事件）不进入时间轴。

export type TimelineKind = 'user' | 'llm' | 'tool'

export interface TimelineEvent {
  ts_ms: number
  ts: string
  /// user = 用户真实输入；llm = 模型输出的文本内容；tool = 工具调用+结果
  kind: TimelineKind
  /// 轮次号：每条用户真实输入开启新轮次（开场前事件归 0）
  turn_no: number
  /// 轮次内层级：用户=0，模型文本=1，工具调用=2
  depth: number
  /// 名称列：文本摘要 / 工具名
  name: string
  /// 状态列：✅/❌、stop_reason 等
  status: string
  in_tokens: number
  out_tokens: number
  /// 瀑布条时长：工具=真实耗时；其余为 null（渲染最小宽标记点）
  duration_ms: number | null
  /// 耗时列展示值（模型文本行显示 LLM 延迟）
  display_duration_ms: number | null
  tool_name: string
  is_error: boolean
  detail: Record<string, unknown>
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

/// 提取 user 消息中的真实输入文本（tool_result 包装消息返回 ''）。
function userInputText(content: unknown, n = 60): string {
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

/// 从原始 jsonl 提取三种核心信息并组织为时间轴事件列表：
///   1. 用户真实输入（type=user 且 message.content 含文本）
///   2. 模型文本输出（type=assistant 的 text 块）
///   3. 工具调用+结果（tool_use ↔ tool_result 配对合并为一行）
export function buildTimeline(rawEvents: unknown[]): TimelineModel {
  // ── Pass 1: 收集工具配对映射（tool_use id → 调用信息；结果 id → 结果）──
  interface ToolUseRec {
    ts_ms: number
    name: string
    input: unknown
  }
  interface ToolResultRec {
    ts_ms: number
    output: unknown
    is_error: boolean
  }
  const toolUses = new Map<string, ToolUseRec>()
  const toolResults = new Map<string, ToolResultRec>()

  for (const raw of rawEvents) {
    const evt = raw as Record<string, unknown>
    const type = (evt.type as string) ?? ''
    const tsMs = tsOf(evt)
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

  // ── Pass 2: 按文件顺序构建三类事件 ──────────────────────────
  const events: TimelineEvent[] = []
  const userTsList: number[] = []
  let minTs = Infinity
  let maxTs = -Infinity
  let currentTurn = 0

  const push = (e: Omit<TimelineEvent, 'in_tokens' | 'out_tokens'>) => {
    const ts = e.ts_ms
    if (Number.isFinite(ts)) {
      minTs = Math.min(minTs, ts)
      maxTs = Math.max(maxTs, ts)
    }
    events.push({ ...e, in_tokens: 0, out_tokens: 0 })
  }

  for (const raw of rawEvents) {
    const evt = raw as Record<string, unknown>
    const type = (evt.type as string) ?? ''
    const tsMs = tsOf(evt)
    if (tsMs === null) continue
    const ts = new Date(tsMs).toISOString()
    const message = (evt.message ?? {}) as Record<string, unknown>
    const usage = (message.usage ?? {}) as Record<string, number>

    // ── 1. 用户真实输入 ──────────────────────────────────────
    if (type === 'user') {
      const preview = userInputText(message.content)
      if (!preview.trim()) continue // tool_result 包装消息不算用户输入
      const origin = (evt.origin ?? {}) as Record<string, unknown>
      userTsList.push(tsMs)
      currentTurn += 1
      push({
        ts_ms: tsMs,
        ts,
        kind: 'user',
        turn_no: currentTurn,
        depth: 0,
        name: preview,
        status: [evt.promptSource, origin.kind].filter(Boolean).join(' / '),
        duration_ms: null,
        display_duration_ms: null,
        tool_name: '',
        is_error: false,
        detail: { evt, promptId: evt.promptId, content: message.content },
      })
      continue
    }

    // ── 2+3. 模型文本输出 + 工具调用 ─────────────────────────
    if (type === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      // 模型文本输出：text 块拼接（非空才成行）
      const textParts: string[] = []
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text') {
          const t = (b as Record<string, unknown>).text
          if (typeof t === 'string' && t.trim()) textParts.push(t)
        }
      }
      const fullText = textParts.join('\n')
      if (fullText.trim()) {
        push({
          ts_ms: tsMs,
          ts,
          kind: 'llm',
          turn_no: currentTurn,
          depth: 1,
          name: fullText.slice(0, 60).replace(/\n/g, ' '),
          status: String(message.stop_reason ?? ''),
          duration_ms: null,
          display_duration_ms: null, // 延迟在 userTsList 齐后回填
          tool_name: '',
          is_error: false,
          detail: { evt, model: message.model, stop_reason: message.stop_reason, usage, text: fullText },
        })
      }
      // 工具调用：与结果配对合并为一行
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_use') {
          const tu = b as Record<string, unknown>
          const id = String(tu.id ?? '')
          const use = toolUses.get(id)
          const res = toolResults.get(id)
          const duration = use && res ? Math.max(0, res.ts_ms - use.ts_ms) : null
          push({
            ts_ms: tsMs,
            ts,
            kind: 'tool',
            turn_no: currentTurn,
            depth: 2,
            name: String(tu.name ?? 'tool'),
            status: !res ? '无结果' : res.is_error ? '❌' : '✅',
            duration_ms: duration,
            display_duration_ms: duration,
            tool_name: String(tu.name ?? 'tool'),
            is_error: res?.is_error ?? false,
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
      continue
    }

    // 顶层 tool_result：已配对的不再单独成行；孤儿结果保留标记行兜底
    if (type === 'tool_result') {
      const tid = String(evt.tool_use_id ?? evt.toolUseId ?? '')
      if (tid && toolUses.has(tid)) continue
      push({
        ts_ms: tsMs,
        ts,
        kind: 'tool',
        turn_no: currentTurn,
        depth: 2,
        name: '工具结果',
        status: '',
        duration_ms: null,
        display_duration_ms: null,
        tool_name: '工具结果',
        is_error: Boolean(evt.is_error ?? evt.isError),
        detail: { evt },
      })
      continue
    }

    // 其余事件类型（thinking / 系统 / 元事件）不进入时间轴
  }

  // ── LLM 延迟回填（bisect：最近前一条真实用户输入）──────────
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
