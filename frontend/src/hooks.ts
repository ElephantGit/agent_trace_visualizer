// TanStack Query hooks — the frontend cache that replaces st.cache_data.

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { AgentType, ParseResult } from './api/types'


// ── 实时监控（SSE 为主，轮询降级）────────────────────────────

export type LiveStatus = 'idle' | 'loading' | 'live' | 'polling' | 'error'

export interface LiveStreamState {
  rawEvents: unknown[]
  status: LiveStatus
  paused: boolean
  pause: () => void
  resume: () => void
}

/// 订阅一个 transcript 文件的实时事件流：
/// - 初始经 parse-from-path 全量加载
/// - EventSource 连接 /api/live 接收增量行；连续 3 次失败降级为 2s 轮询
/// - 按 uuid 去重（重连后同事件可能重发）
/// - 暂停：冻结事件追加（连接保持）
export function useLiveStream(path: string | null): LiveStreamState {
  const [rawEvents, setRawEvents] = useState<unknown[]>([])
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [paused, setPaused] = useState(false)
  // 恢复时 +1 触发全量重载（暂停期间被丢弃的事件由此补齐）
  const [reloadTick, setReloadTick] = useState(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const seenUuids = useRef<Set<string>>(new Set())

  const appendEvents = (events: unknown[]) => {
    if (pausedRef.current) return
    setRawEvents((prev) => {
      const fresh = events.filter((e) => {
        const u = (e as Record<string, unknown>).uuid
        if (u === undefined) return true
        if (seenUuids.current.has(String(u))) return false
        seenUuids.current.add(String(u))
        return true
      })
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }

  // 初始全量加载
  useEffect(() => {
    if (!path) return
    setStatus('loading')
    seenUuids.current.clear()
    setRawEvents([])
    api
      .parseFromPath('claude_code' as AgentType, path)
      .then((r) => {
        for (const e of r.raw_events) {
          const u = (e as Record<string, unknown>).uuid
          if (u !== undefined) seenUuids.current.add(String(u))
        }
        setRawEvents(r.raw_events)
        setStatus('live')
      })
      .catch(() => setStatus('error'))
  }, [path, reloadTick])

  // SSE 订阅 + 轮询降级
  useEffect(() => {
    if (!path) return
    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let closed = false
    let failures = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const startPolling = () => {
      if (closed || pollTimer) return
      setStatus('polling')
      const poll = async () => {
        try {
          const r = await api.parseFromPath('claude_code' as AgentType, path)
          if (!closed) {
            appendEvents(r.raw_events.filter((e) => {
              const u = (e as Record<string, unknown>).uuid
              return u === undefined || !seenUuids.current.has(String(u))
            }))
          }
        } catch {
          /* 单次失败忽略 */
        }
      }
      poll()
      pollTimer = setInterval(poll, 2000)
    }

    const connect = () => {
      if (closed) return
      es = new EventSource(`/api/live?path=${encodeURIComponent(path)}`)
      es.addEventListener('event', (e) => {
        failures = 0
        setStatus('live')
        try {
          appendEvents([JSON.parse((e as MessageEvent).data)])
        } catch {
          /* 非 JSON 帧忽略 */
        }
      })
      es.onerror = () => {
        es?.close()
        es = null
        if (closed) return
        failures += 1
        if (failures >= 3) {
          startPolling()
        } else {
          reconnectTimer = setTimeout(connect, 1000 * failures)
        }
      }
    }

    connect()

    return () => {
      closed = true
      es?.close()
      if (pollTimer) clearInterval(pollTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return {
    rawEvents,
    status,
    paused,
    pause: () => setPaused(true),
    resume: () => {
      setPaused(false)
      setReloadTick((t) => t + 1) // 暂停期间丢弃的事件经全量重载补齐
    },
  }
}

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
