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
  /// 当前实际监控的文件路径（自动跟随时可能切换到更新的会话）
  path: string | null
  /// 是否处于自动跟随模式（手动选择具体文件后关闭）
  autoFollow: boolean
  /// 手动指定要监控的文件（关闭自动跟随）
  follow: (path: string) => void
  /// 回到自动跟随最新会话模式并立即跳转到当前最新文件
  followLatest: () => void
  pause: () => void
  resume: () => void
}

/// 订阅一个 transcript 文件的实时事件流：
/// - 初始经 parse-from-path 全量加载
/// - EventSource 连接 /api/live 接收增量行；连续 3 次失败降级为 2s 轮询
/// - 按 uuid 去重（重连后同事件可能重发）
/// - 暂停：冻结事件追加（连接保持）
/// - 自动跟随：每 3s 查询 /api/live/latest，当另一个文件在最近 15s 内
///   有写入、且当前文件已 10s 无新事件时，切换到那个更新的会话
///   （用户先点监控再开新会话、或多会话并行的场景）；
///   手动选择文件后关闭自动跟随，可随时切回。
export function useLiveStream(initialPath: string | null): LiveStreamState {
  const [path, setPath] = useState(initialPath)
  const [autoFollow, setAutoFollow] = useState(true)
  const [rawEvents, setRawEvents] = useState<unknown[]>([])
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [paused, setPaused] = useState(false)
  // 恢复时 +1 触发全量重载（暂停期间被丢弃的事件由此补齐）
  const [reloadTick, setReloadTick] = useState(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const seenUuids = useRef<Set<string>>(new Set())
  // 最近一次追加事件的时间——用于判断"当前文件是否安静"
  const lastAppendAt = useRef<number>(Date.now())

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
      if (fresh.length) lastAppendAt.current = Date.now()
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }

  // 初始全量加载。注意与 SSE 增量的竞态：解析期间 SSE 已追加的新事件
  // 不能被子集替换丢失——按 uuid 合并（全量在前、解析期增量在后）。
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
        setRawEvents((prev) => {
          const inResult = new Set(
            r.raw_events
              .map((e) => (e as Record<string, unknown>).uuid)
              .filter((u): u is string | number | boolean => u !== undefined)
              .map(String),
          )
          const extra = prev.filter((e) => {
            const u = (e as Record<string, unknown>).uuid
            return u === undefined || !inResult.has(String(u))
          })
          return [...r.raw_events, ...extra]
        })
        lastAppendAt.current = Date.now()
        setStatus('live')
      })
      .catch(() => setStatus('error'))
  }, [path, reloadTick])

  // 自动跟随最新活跃会话：当前文件安静 10s+ 且另有文件 15s 内有写入 → 切换
  useEffect(() => {
    if (!path || !autoFollow) return
    const timer = setInterval(async () => {
      try {
        const latest = await api.liveLatest()
        if (
          latest.path !== path &&
          Date.now() - lastAppendAt.current > 10_000 &&
          Date.now() - latest.mtimeMs < 15_000
        ) {
          setPath(latest.path)
        }
      } catch {
        // 单次失败忽略，下轮重试
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [path, autoFollow])

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
    path,
    autoFollow,
    follow: (p: string) => {
      setAutoFollow(false)
      setPath(p)
    },
    followLatest: () => {
      setAutoFollow(true)
      api
        .liveLatest()
        .then((latest) => setPath(latest.path))
        .catch(() => {})
    },
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
