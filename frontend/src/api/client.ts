// Typed fetch wrappers for the Rust backend API.

import type {
  AgentType,
  ComparePayload,
  EmbeddedResponse,
  MermaidResponse,
  ParseResult,
  ReplayResponse,
  TraceEntry,
  WorkflowNode,
} from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.message) message = body.message
    } catch {
      // non-JSON error body
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<{ ok: boolean }>('/api/health'),

  parse: (agentType: AgentType, content: ArrayBuffer | Uint8Array) =>
    request<ParseResult>(`/api/parse/${agentType}`, {
      method: 'POST',
      body: content as BodyInit,
    }),

  parseFromPath: (agentType: AgentType, path: string) =>
    request<ParseResult>('/api/parse-from-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentType, path }),
    }),

  embedded: (sessionId: string, agentType: string) =>
    request<EmbeddedResponse>(
      `/api/embedded/${encodeURIComponent(sessionId)}?agent_type=${encodeURIComponent(agentType)}`,
    ),

  traces: (root?: string) =>
    request<TraceEntry[]>(`/api/traces${root ? `?root=${encodeURIComponent(root)}` : ''}`),

  subagent: (sessionId: string) =>
    request<ParseResult>(`/api/subagent/${encodeURIComponent(sessionId)}`, { method: 'POST' }),

  replay: (source: 'opencode' | 'claude_code', rawEvents: unknown[]) =>
    request<ReplayResponse>('/api/derive/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, rawEvents }),
    }),

  mermaid: (req: {
    kind: string
    rawEvents?: unknown[]
    isTranscript?: boolean
    maxEvents?: number
    seed?: number
    data?: unknown
    result?: ParseResult
  }) =>
    request<MermaidResponse>('/api/derive/mermaid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }),

  compare: (resultA: ParseResult, resultB: ParseResult, labelA: string, labelB: string) =>
    request<ComparePayload>('/api/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resultA, resultB, labelA, labelB }),
    }),

  workflowTree: (result: ParseResult) =>
    request<WorkflowNode | null>('/api/workflow/tree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result }),
    }),

  reactflow: () => request<unknown>('/api/workflow/reactflow'),
}
