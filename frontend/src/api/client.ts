// Workbench bridge client. The standalone dashboard's HTTP API is intentionally replaced by
// opaque trace handles: this code cannot see a filesystem path or an Ora session id.

import type {
  AgentType, ComparePayload, EmbeddedResponse, MermaidResponse, ParseResult, ReplayResponse, TraceEntry,
  WorkflowNode,
} from './types'
import {
  compare as compareWasm,
  initSync as initDashboardWasm,
  mermaid_source as mermaidSourceWasm,
  parse_trace as parseTraceWasm,
  replay as replayWasm,
  workflow_tree as workflowTreeWasm,
} from '../generated/wasm/agent_dashboard_wasm.js'
import { dashboardWasmBase64 } from '../generated/wasm/agent_dashboard_wasm_bytes'

interface BridgeTrace {
  traceId: string
  providerId: string
  format: string
  sizeBytes: number
  modifiedAtMs: number
  cursor: string
  label: string
  isCurrent: boolean
}

export interface CurrentDashboardTrace {
  path: string
  agent: 'claude_code' | 'opencode'
  mtimeMs: number
}

interface OraBridge {
  invoke(method: string, input?: unknown): Promise<unknown>
}

declare global {
  interface Window { ora?: OraBridge }
}

interface DashboardWasm {
  parse_trace(agentType: string, content: string): string
  compare(resultA: string, resultB: string, labelA: string, labelB: string): string
  mermaid_source(kind: string, payload: string): string
  workflow_tree(result: string): string
  replay(agentType: string, rawEvents: string): string
}

let wasmPromise: Promise<DashboardWasm> | null = null
const dashboardWasm: DashboardWasm = {
  parse_trace: parseTraceWasm,
  compare: compareWasm,
  mermaid_source: mermaidSourceWasm,
  workflow_tree: workflowTreeWasm,
  replay: replayWasm,
}
const traceCache = new Map<string, BridgeTrace>()

function bridge(): OraBridge {
  if (!window.ora?.invoke) throw new Error('Dashboard 必须在 Ora 插件窗口中打开')
  return window.ora
}

async function wasm() {
  wasmPromise ??= Promise.resolve().then(() => {
    const binary = atob(dashboardWasmBase64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    initDashboardWasm({ module: bytes })
    return dashboardWasm
  })
  return wasmPromise
}

function agentFor(trace: BridgeTrace): AgentType | null {
  if (trace.format === 'ora/trace.opencode-ndjson.v1') return 'opencode'
  if (trace.format === 'ora/trace.claude-code-jsonl.v1') return 'claude_code'
  if (trace.format === 'ora/trace.gemini-jsonl.v1') return 'gemini'
  return null
}

function entry(trace: BridgeTrace): TraceEntry {
  return {
    // Components historically call this field `path`. It is now an opaque trace handle.
    path: trace.traceId,
    mtimeMs: trace.modifiedAtMs,
    sizeBytes: trace.sizeBytes,
    name: trace.label,
    agent: agentFor(trace) === 'opencode' ? 'opencode' : 'claude_code',
  }
}

async function traces(): Promise<BridgeTrace[]> {
  const response = await bridge().invoke('dashboard/list') as { traces?: BridgeTrace[] }
  if (!Array.isArray(response?.traces)) throw new Error('Dashboard trace 目录响应无效')
  response.traces.forEach((trace) => traceCache.set(trace.traceId, trace))
  return response.traces
}

async function traceFor(id: string): Promise<BridgeTrace> {
  const cached = traceCache.get(id)
  if (cached) return cached
  const listed = await traces()
  const trace = listed.find((item) => item.traceId === id)
  if (!trace) throw new Error('所选 trace 已不可用')
  return trace
}

async function content(id: string): Promise<ArrayBuffer> {
  let offset = 0
  let cursor: string | undefined
  const parts: Uint8Array[] = []
  while (true) {
    const chunk = await bridge().invoke('dashboard/read', { traceId: id, offset, cursor }) as {
      bytesBase64: string; nextOffset: number; eof: boolean; cursor: string
    }
    const binary = atob(chunk.bytesBase64)
    parts.push(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
    offset = chunk.nextOffset
    cursor = chunk.cursor
    if (chunk.eof) break
  }
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let start = 0
  for (const part of parts) { bytes.set(part, start); start += part.byteLength }
  return bytes.buffer
}

async function parse(agentType: AgentType, bytes: ArrayBuffer | Uint8Array): Promise<ParseResult> {
  const text = new TextDecoder().decode(bytes)
  const module = await wasm()
  return JSON.parse(module.parse_trace(agentType, text)) as ParseResult
}

export const api = {
  health: async () => ({ ok: true }),
  parse,
  parseFromPath: async (agentType: AgentType, traceId: string) => parse(agentType, await content(traceId)),
  // Embedded mode has no privileged session identity in a plugin page. The default route opens
  // the current authorized trace directly, and the full browse/compare UI uses opaque handles.
  embedded: async (): Promise<EmbeddedResponse> => ({ status: 'unsupported_agent', message: '插件模式使用当前会话入口' }),
  traces: async (_root?: string, agent?: 'claude_code' | 'opencode') =>
    (await traces())
      .filter((trace) => !agent || agentFor(trace) === agent)
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.modifiedAtMs - a.modifiedAtMs)
      .map(entry),
  currentTrace: async (): Promise<CurrentDashboardTrace> => {
    const current = (await traces())
      .filter((trace) => trace.isCurrent)
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    if (current.length === 0) {
      throw new Error('当前 Ora 会话尚未注册可读取的 trace')
    }
    const selected = current.find((trace) => {
      const agent = agentFor(trace)
      return agent === 'claude_code' || agent === 'opencode'
    })
    if (!selected) {
      throw new Error(`当前 Ora 会话的 trace 格式暂不支持：${current[0].format}`)
    }
    return {
      path: selected.traceId,
      agent: agentFor(selected) as 'claude_code' | 'opencode',
      mtimeMs: selected.modifiedAtMs,
    }
  },
  subagent: async (sessionId: string) => {
    for (const trace of await traces()) {
      const type = agentFor(trace)
      if (!type) continue
      const result = await parse(type, await content(trace.traceId))
      if (result.session_info.session_id === sessionId) return result
    }
    throw new Error('未找到子 agent trace')
  },
  replay: async (source: 'opencode' | 'claude_code', rawEvents: unknown[]) => {
    const module = await wasm()
    return JSON.parse(module.replay(source, JSON.stringify(rawEvents))) as ReplayResponse
  },
  mermaid: async (req: { kind: string; rawEvents?: unknown[]; data?: unknown; result?: ParseResult }) => {
    const module = await wasm()
    const payload = req.data ?? req.result ?? req.rawEvents ?? []
    const value = JSON.parse(module.mermaid_source(req.kind, JSON.stringify(payload))) as { src: string }
    return { src: value.src, totalUnits: 0, sampledUnits: 0, notice: null } satisfies MermaidResponse
  },
  compare: async (resultA: ParseResult, resultB: ParseResult, labelA: string, labelB: string) => {
    const module = await wasm()
    return JSON.parse(module.compare(JSON.stringify(resultA), JSON.stringify(resultB), labelA, labelB)) as ComparePayload
  },
  workflowTree: async (result: ParseResult) => {
    const module = await wasm()
    return JSON.parse(module.workflow_tree(JSON.stringify(result))) as WorkflowNode | null
  },
  reactflow: async () => { throw new Error('插件模式不读取本地 ReactFlow 文件') },
  traceName: async (traceId: string) => ({ name: (await traceFor(traceId)).label }),
  trajectory: async () => (await traces()).map(entry),
  sessionMeta: async (traceId: string) => {
    const trace = await traceFor(traceId)
    return { name: trace.label, active: trace.isCurrent, lastActiveMs: trace.modifiedAtMs, durationMs: null, agentCount: 1, directory: null }
  },
  liveLatest: async (agent?: 'claude_code' | 'opencode') => {
    const candidates = (await traces()).filter((trace) => !agent || agentFor(trace) === agent)
    const selected = candidates.find((trace) => trace.isCurrent) ?? candidates.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)[0]
    if (!selected) throw new Error('当前工作区没有可读取的 trace')
    return { path: selected.traceId, mtimeMs: selected.modifiedAtMs, active: selected.isCurrent }
  },
}
