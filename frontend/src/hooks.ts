// Frontend cache and live polling. The old EventSource/HTTP transport is deliberately absent:
// polling uses only the workbench bridge's opaque trace handle.

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { AgentType, ParseResult } from './api/types'

export type LiveStatus = 'idle' | 'loading' | 'live' | 'polling' | 'error'
export type LiveAgent = 'claude_code' | 'opencode'

export interface LiveStreamState {
  rawEvents: unknown[]; result: ParseResult | null; status: LiveStatus; paused: boolean
  error: string | null
  path: string | null; autoFollow: boolean; follow: (path: string) => void
  followLatest: () => void; pause: () => void; resume: () => void
}

export function useLiveStream(
  initialPath: string | null,
  agent: LiveAgent = 'claude_code',
  initialAutoFollow = true,
): LiveStreamState {
  const [path, setPath] = useState(initialPath)
  const [autoFollow, setAutoFollow] = useState(initialAutoFollow)
  const [rawEvents, setRawEvents] = useState<unknown[]>([])
  const [result, setResult] = useState<ParseResult | null>(null)
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    setPath(initialPath)
    setAutoFollow(initialAutoFollow)
  }, [initialPath, initialAutoFollow])

  useEffect(() => {
    if (!path) return
    let cancelled = false
    const refresh = async () => {
      if (pausedRef.current) return
      try {
        const next = await api.parseFromPath(agent, path)
        if (cancelled || pausedRef.current) return
        setResult(next); setRawEvents(next.raw_events); setError(null); setStatus('live')
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setStatus('error')
        }
      }
    }
    setStatus('loading'); void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [path, agent])

  useEffect(() => {
    if (!path || !autoFollow) return
    const timer = setInterval(() => {
      void api.liveLatest(agent).then((latest) => {
        if (latest.path !== path && latest.active) setPath(latest.path)
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [path, autoFollow, agent])

  return {
    rawEvents, result, status, paused, error, path, autoFollow,
    follow: (next) => { setAutoFollow(false); setPath(next) },
    followLatest: () => { setAutoFollow(true); void api.liveLatest(agent).then((next) => setPath(next.path)).catch(() => {}) },
    pause: () => setPaused(true), resume: () => setPaused(false),
  }
}

export function useHealth() { return useQuery({ queryKey: ['health'], queryFn: api.health, retry: false }) }
export function useParse(agentType: AgentType | null, content: ArrayBuffer | null, name: string) {
  return useQuery({ queryKey: ['parse', agentType, name, content?.byteLength ?? 0], queryFn: () => api.parse(agentType!, content!), enabled: agentType !== null && content !== null })
}
export function useEmbedded(sessionId: string | null, agentType: string | null) {
  return useQuery({ queryKey: ['embedded', sessionId, agentType], queryFn: () => api.embedded(), enabled: !!sessionId && !!agentType })
}
export function useTraces(_root: string | undefined, agent?: 'claude_code' | 'opencode') {
  return useQuery({ queryKey: ['traces', agent ?? ''], queryFn: () => api.traces(undefined, agent), refetchInterval: 3000 })
}
export function useTraceName(path: string | null, agent?: 'claude_code' | 'opencode') {
  return useQuery({ queryKey: ['trace-name', path ?? '', agent ?? ''], queryFn: () => api.traceName(path!), enabled: !!path, staleTime: 5 * 60_000 })
}
export function useSessionMeta(path: string | null, agent?: 'claude_code' | 'opencode') {
  return useQuery({ queryKey: ['session-meta', path ?? '', agent ?? ''], queryFn: () => api.sessionMeta(path!), enabled: !!path, staleTime: 30_000 })
}
export function useSubagent(sessionId: string | null) { return useQuery({ queryKey: ['subagent', sessionId], queryFn: () => api.subagent(sessionId!), enabled: !!sessionId }) }
export function useReplay(source: LiveAgent, rawEvents: unknown[] | undefined) {
  return useQuery({
    queryKey: ['replay', source, rawEvents?.length ?? 0],
    queryFn: () => api.replay(source, rawEvents!),
    enabled: !!rawEvents && rawEvents.length > 0,
  })
}
export function useMermaid(req: { kind: string; rawEvents?: unknown[]; isTranscript?: boolean; maxEvents?: number; seed?: number; data?: unknown; result?: ParseResult }) {
  return useQuery({ queryKey: ['mermaid', req.kind, req.rawEvents?.length ?? 0, req.maxEvents ?? 60, req.seed ?? 42], queryFn: () => api.mermaid(req), enabled: req.kind === 'workflow-reactflow' ? !!req.data : !!req.rawEvents || !!req.result })
}
export function useCompare(resultA: ParseResult | null, resultB: ParseResult | null, labelA: string, labelB: string) {
  return useQuery({ queryKey: ['compare', resultA?.raw_events.length, resultB?.raw_events.length, labelA, labelB], queryFn: () => api.compare(resultA!, resultB!, labelA, labelB), enabled: !!resultA && !!resultB })
}
export function useWorkflowTree(result: ParseResult | null) { return useQuery({ queryKey: ['workflow-tree', result?.source ?? '', result?.raw_events.length ?? 0], queryFn: () => api.workflowTree(result!), enabled: !!result }) }
export function useReactflow(enabled: boolean) { return useQuery({ queryKey: ['reactflow'], queryFn: api.reactflow, enabled, retry: false }) }
