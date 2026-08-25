// TanStack Query hooks — the frontend cache that replaces st.cache_data.

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { AgentType, ParseResult } from './api/types'


// ── 实时监控（SSE 为主，轮询降级）────────────────────────────

export type LiveStatus = 'idle' | 'loading' | 'live' | 'polling' | 'error'

/// 支持实时监控的 agent 类型（claude_code transcript / opencode ndjson）。
export type LiveAgent = 'claude_code' | 'opencode'

export interface LiveStreamState {
  rawEvents: unknown[]
  /// 节流刷新的完整解析结果（会话回放/总览/Token/工具/Subagent/成本等
  /// 所有 tab 共享；每 ~2s 跟随新事件刷新一次，含 tiktoken 缓存加速）
  result: ParseResult | null
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
/// - 节流全量刷新：新事件到达后最多每 2s 重取一次完整 ParseResult，
///   供时间轴之外的所有 tab 实时更新（时间轴本身走 SSE 即时路径）
/// - 暂停：冻结事件追加（连接保持）
/// - 自动跟随：每 3s 查询 /api/live/latest，当另一个文件在最近 15s 内
///   有写入、且当前文件已 10s 无新事件时，切换到那个更新的会话
///   （用户先点监控再开新会话、或多会话并行的场景）；
///   手动选择文件后关闭自动跟随，可随时切回。
export function useLiveStream(
  initialPath: string | null,
  agent: LiveAgent = 'claude_code',
): LiveStreamState {
  const [path, setPath] = useState(initialPath)
  const [autoFollow, setAutoFollow] = useState(true)
  const [rawEvents, setRawEvents] = useState<unknown[]>([])
  const [result, setResult] = useState<ParseResult | null>(null)
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [paused, setPaused] = useState(false)
  // 恢复时 +1 触发全量重载（暂停期间被丢弃的事件由此补齐）
  const [reloadTick, setReloadTick] = useState(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const pathRef = useRef(path)
  pathRef.current = path
  const agentRef = useRef(agent)
  agentRef.current = agent
  const seenUuids = useRef<Set<string>>(new Set())
  // 最近一次追加事件的时间——用于判断"当前文件是否安静"
  const lastAppendAt = useRef<number>(Date.now())
  // 节流刷新的调度状态
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRefreshAt = useRef<number>(0)
  const refreshInFlight = useRef(false)
  const initialLoaded = useRef(false)

  /// 按 uuid 去重合并：result 事件在前、prev 中不在 result 里的在后
  /// （保证顺序 + 解析期间 SSE 已追加的事件不丢）。
  const mergeRaw = (prev: unknown[], incoming: unknown[]) => {
    const inResult = new Set(
      incoming
        .map((e) => (e as Record<string, unknown>).uuid)
        .filter((u): u is string | number | boolean => u !== undefined)
        .map(String),
    )
    const extra = prev.filter((e) => {
      const u = (e as Record<string, unknown>).uuid
      return u === undefined || !inResult.has(String(u))
    })
    return [...incoming, ...extra]
  }

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
      if (fresh.length) {
        lastAppendAt.current = Date.now()
        scheduleRefresh()
      }
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }

  // 节流全量刷新：新事件到达后以 2s 间隔重取完整 ParseResult
  // （尾沿调度：持续有事件时每 ~2s 一次；事件停止后再补一次收尾）。
  // 大文件单次解析可能 >2s：in-flight 期间的新事件在完成后补一轮。
  const doRefresh = () => {
    if (!initialLoaded.current || pausedRef.current || refreshInFlight.current) return
    const p = pathRef.current
    if (!p) return
    refreshInFlight.current = true
    const startedAt = Date.now()
    api
      .parseFromPath(agentRef.current, p)
      .then((r) => {
        if (pausedRef.current) return
        setResult(r)
        for (const e of r.raw_events) {
          const u = (e as Record<string, unknown>).uuid
          if (u !== undefined) seenUuids.current.add(String(u))
        }
        setRawEvents((prev) => mergeRaw(prev, r.raw_events))
        setStatus('live')
      })
      .catch(() => {
        /* 单次刷新失败忽略，下轮重试 */
      })
      .finally(() => {
        refreshInFlight.current = false
        lastRefreshAt.current = Date.now()
        // 解析期间到达的新事件需要补一轮收尾刷新
        if (lastAppendAt.current > startedAt) {
          scheduleRefresh()
        }
      })
  }
  const scheduleRefresh = () => {
    if (refreshTimer.current) return // 已有尾沿调度
    const wait = Math.max(0, 2000 - (Date.now() - lastRefreshAt.current))
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      doRefresh()
    }, wait)
  }

  // 初始全量加载。注意与 SSE 增量的竞态：解析期间 SSE 已追加的新事件
  // 不能被子集替换丢失——按 uuid 合并（全量在前、解析期增量在后）。
  useEffect(() => {
    if (!path) return
    setStatus('loading')
    seenUuids.current.clear()
    setRawEvents([])
    setResult(null)
    initialLoaded.current = false
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
    api
      .parseFromPath(agent, path)
      .then((r) => {
        for (const e of r.raw_events) {
          const u = (e as Record<string, unknown>).uuid
          if (u !== undefined) seenUuids.current.add(String(u))
        }
        setResult(r)
        setRawEvents((prev) => mergeRaw(prev, r.raw_events))
        lastAppendAt.current = Date.now()
        lastRefreshAt.current = Date.now()
        initialLoaded.current = true
        setStatus('live')
      })
      .catch(() => setStatus('error'))
  }, [path, reloadTick, agent])

  // 自动跟随最新活跃会话：当前文件安静 10s+ 且另有文件 15s 内有写入 → 切换
  useEffect(() => {
    if (!path || !autoFollow) return
    const timer = setInterval(async () => {
      try {
        const latest = await api.liveLatest(agent)
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
  }, [path, autoFollow, agent])

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
        if (closed || pausedRef.current) return
        // 轮询降级 = 节流全量刷新通道（同时更新 rawEvents 与完整 result）
        doRefresh()
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
    result,
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
        .liveLatest(agent)
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

export function useTraces(root: string | undefined, agent?: 'claude_code' | 'opencode') {
  return useQuery({
    queryKey: ['traces', root ?? '', agent ?? ''],
    queryFn: () => api.traces(root, agent),
  })
}

/// 单个 trace 文件的可读会话名（文件列表/会话下拉框展示用）。
export function useTraceName(path: string | null, agent?: 'claude_code' | 'opencode') {
  return useQuery({
    queryKey: ['trace-name', path ?? '', agent ?? ''],
    queryFn: () => api.traceName(path!, agent),
    enabled: !!path,
    staleTime: 5 * 60_000,
  })
}

/// 单个 trace 文件的会话列表元数据（状态/时长/agent 数/目录）。
export function useSessionMeta(path: string | null, agent?: 'claude_code' | 'opencode') {
  return useQuery({
    queryKey: ['session-meta', path ?? '', agent ?? ''],
    queryFn: () => api.sessionMeta(path!, agent),
    enabled: !!path,
    staleTime: 30_000, // 状态（进行中/已结束）需要较新鲜的数据
  })
}

export function useSubagent(sessionId: string | null) {
  return useQuery({
    queryKey: ['subagent', sessionId],
    queryFn: () => api.subagent(sessionId!),
    enabled: !!sessionId,
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
