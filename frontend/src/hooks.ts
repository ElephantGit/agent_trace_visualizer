// TanStack Query hooks — the frontend cache that replaces st.cache_data.

import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { AgentType, ParseResult } from './api/types'

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.health, retry: false })
}

/// Parse a trace, keyed by agent type + content byte-length + name
/// (content hash would need crypto.subtle; length+name is enough for the
/// cache to behave like st.cache_data on repeated uploads of the same file).
export function useParse(agentType: AgentType | null, content: ArrayBuffer | null, name: string) {
  return useQuery({
    queryKey: ['parse', agentType, name, content?.byteLength ?? 0],
    queryFn: () => api.parse(agentType!, content!),
    enabled: agentType !== null && content !== null,
  })
}

export function useEmbedded(sessionId: string | null, agentType: string | null) {
  return useQuery({
    queryKey: ['embedded', sessionId, agentType],
    queryFn: () => api.embedded(sessionId!, agentType!),
    enabled: !!sessionId && !!agentType,
  })
}

export function useTraces(root: string | undefined) {
  return useQuery({ queryKey: ['traces', root ?? ''], queryFn: () => api.traces(root) })
}

export function useSubagent(sessionId: string | null) {
  return useQuery({
    queryKey: ['subagent', sessionId],
    queryFn: () => api.subagent(sessionId!),
    enabled: !!sessionId,
  })
}

export function useReplay(source: 'opencode' | 'claude_code', rawEvents: unknown[] | undefined) {
  return useQuery({
    queryKey: ['replay', source, rawEvents?.length ?? 0],
    queryFn: () => api.replay(source, rawEvents!),
    enabled: !!rawEvents && rawEvents.length > 0,
  })
}

export function useMermaid(req: {
  kind: string
  rawEvents?: unknown[]
  isTranscript?: boolean
  maxEvents?: number
  seed?: number
  data?: unknown
  result?: ParseResult
}) {
  return useQuery({
    queryKey: ['mermaid', req.kind, req.rawEvents?.length ?? 0, req.maxEvents ?? 60, req.seed ?? 42],
    queryFn: () => api.mermaid(req),
    enabled: req.kind === 'workflow-reactflow' ? !!req.data : !!req.rawEvents || !!req.result,
  })
}

export function useCompare(
  resultA: ParseResult | null,
  resultB: ParseResult | null,
  labelA: string,
  labelB: string,
) {
  return useQuery({
    queryKey: ['compare', resultA, resultB, labelA, labelB].map((x) =>
      typeof x === 'object' && x !== null ? (x as ParseResult).source + (x as ParseResult).raw_events.length : x,
    ),
    queryFn: () => api.compare(resultA!, resultB!, labelA, labelB),
    enabled: !!resultA && !!resultB,
  })
}

export function useWorkflowTree(result: ParseResult | null) {
  return useQuery({
    queryKey: ['workflow-tree', result?.source ?? '', result?.raw_events.length ?? 0],
    queryFn: () => api.workflowTree(result!),
    enabled: !!result,
  })
}

export function useReactflow(enabled: boolean) {
  return useQuery({
    queryKey: ['reactflow'],
    queryFn: api.reactflow,
    enabled,
    retry: false,
  })
}
