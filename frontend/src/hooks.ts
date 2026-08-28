// TanStack Query hooks — 插件模式的查询缓存层。
//
// 无 fetch/SSE：实时监控走 500ms stat 轮询 + 字节偏移增量 readChunk，
// 节流全量解析交给插件进程的 wasm 核心（parse 剥离 raw_events，
// 原始事件由 readChunk 直读行还原）。

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { AgentType, ParseResult } from './api/types'


// ── 实时监控（轮询 + 字节偏移增量）────────────────────────────

export type LiveStatus = 'idle' | 'loading' | 'live' | 'error'

/// 支持实时监控的 agent 类型（claude_code transcript / opencode ndjson）。
export type LiveAgent = 'claude_code' | 'opencode'

export interface LiveStreamState {
  rawEvents: unknown[]
  /// 节流刷新的完整解析结果（会话回放/总览/Token/工具/Subagent/成本等
  /// 所有 tab 共享；每 ~2s 跟随新事件刷新一次，wasm 核心计算）
  result: ParseResult | null
  status: LiveStatus
  paused: boolean
  /// 已消费的字节偏移（readChunk 续读游标）
  offset: number
  pause: () => void
  resume: () => void
}

/// 订阅绑定会话的实时事件流：
/// - 每 500ms 调 stat（元数据轮询，O(1) 宿主路径）
/// - 有增长时按字节偏移 readChunk 增量拉取，逐行还原事件（uuid 去重）
/// - 节流全量刷新：新事件到达后最多每 2s 重取一次完整 ParseResult
/// - 暂停：冻结事件追加与刷新（通道保留，恢复时补齐）
export function useLiveStream(agent: LiveAgent = 'claude_code'): LiveStreamState {
  const [rawEvents, setRawEvents] = useState<unknown[]>([])
  const [result, setResult] = useState<ParseResult | null>(null)
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [paused, setPaused] = useState(false)
  const [offset, setOffset] = useState(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const offsetRef = useRef(0)
  offsetRef.current = offset
  const agentRef = useRef(agent)
  agentRef.current = agent
  const seenUuids = useRef<Set<string>>(new Set())
  const lastAppendAt = useRef<number>(Date.now())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRefreshAt = useRef<number>(0)
  const refreshInFlight = useRef(false)
  const initialLoaded = useRef(false)

  /// 按 uuid 去重合并：result 事件在前、prev 中不在 result 里的在后。
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

  /// 把增量 chunk 文本还原成事件并追加（uuid 去重）。
  const appendChunk = (text: string) => {
    const events: unknown[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        /* 半行/畸形行跳过 */
      }
    }
    if (events.length === 0) return
    lastAppendAt.current = Date.now()
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
    scheduleRefresh()
  }

  // 节流全量刷新：新事件到达后以 2s 间隔重取完整 ParseResult（尾沿调度）。
  const doRefresh = () => {
    if (!initialLoaded.current || pausedRef.current || refreshInFlight.current) return
    refreshInFlight.current = true
    const startedAt = Date.now()
    api
      .parseSession()
      .then((r) => {
        if (pausedRef.current) return
        setResult(r)
        setStatus('live')
        for (const e of r.raw_events ?? []) {
          const u = (e as Record<string, unknown>).uuid
          if (u !== undefined) seenUuids.current.add(String(u))
        }
        setRawEvents((prev) => mergeRaw(prev, r.raw_events ?? []))
      })
      .catch(() => {
        /* 单次刷新失败忽略，下轮重试 */
      })
      .finally(() => {
        refreshInFlight.current = false
        lastRefreshAt.current = Date.now()
        if (lastAppendAt.current > startedAt) {
          scheduleRefresh()
        }
      })
  }
  const scheduleRefresh = () => {
    if (refreshTimer.current) return
    const wait = Math.max(0, 2000 - (Date.now() - lastRefreshAt.current))
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      doRefresh()
    }, wait)
  }

  // 初始全量加载：先解析（wasm），再把期间到达的增量事件合并进来。
  useEffect(() => {
    setStatus('loading')
    seenUuids.current.clear()
    setRawEvents([])
    setResult(null)
    setOffset(0)
    initialLoaded.current = false
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
    api
      .parseSession()
      .then((r) => {
        if ('error' in (r as unknown as Record<string, unknown>)) {
          // trace 尚未落盘：保持 loading，轮询会继续推进（stat exists=false 时
          // readChunk 返回空且 parse 持续返回 trace_not_ready）。
          setStatus('loading')
          return
        }
        for (const e of r.raw_events ?? []) {
          const u = (e as Record<string, unknown>).uuid
          if (u !== undefined) seenUuids.current.add(String(u))
        }
        setResult(r)
        setRawEvents((prev) => mergeRaw(prev, r.raw_events ?? []))
        lastAppendAt.current = Date.now()
        lastRefreshAt.current = Date.now()
        initialLoaded.current = true
        setStatus('live')
      })
      .catch(() => setStatus('error'))
  }, [agent])

  // 主轮询循环：stat 探测增长 → 增量 readChunk；暂停时只冻结消费不冻结心跳。
  useEffect(() => {
    let closed = false
    let offsetLocal = 0
    const poll = async () => {
      if (closed) return
      try {
        const stat = await api.stat()
        if (!stat.exists) {
          if (!initialLoaded.current) {
            // 每轮重试初始加载（trace 可能刚落盘）。
            initialLoaded.current = false
            api
              .parseSession()
              .then((r) => {
                if (closed || 'error' in (r as unknown as Record<string, unknown>)) return
                for (const e of r.raw_events ?? []) {
                  const u = (e as Record<string, unknown>).uuid
                  if (u !== undefined) seenUuids.current.add(String(u))
                }
                setResult(r)
                setRawEvents((prev) => mergeRaw(prev, r.raw_events ?? []))
                initialLoaded.current = true
                setStatus('live')
              })
              .catch(() => {})
          }
          return
        }
        if (stat.sizeBytes < offsetLocal) {
          // 文件被截断/轮转（宿主侧不常见但保留语义）：从头重读。
          offsetLocal = 0
          setOffset(0)
        }
        if (stat.sizeBytes > offsetLocal && !pausedRef.current) {
          const chunk = await api.readChunk(offsetLocal)
          offsetLocal = chunk.nextOffset
          setOffset(chunk.nextOffset)
          appendChunk(chunk.text)
          setStatus('live')
        }
      } catch {
        /* 单次失败忽略，下轮重试 */
      }
    }
    const timer = setInterval(poll, 500)
    poll()
    return () => {
      closed = true
      clearInterval(timer)
    }
  }, [agent])

  return {
    rawEvents,
    result,
    status,
    paused,
    offset,
    pause: () => setPaused(true),
    resume: () => {
      setPaused(false)
      // 暂停期间丢弃的事件经全量重载补齐。
      api
        .parseSession()
        .then((r) => {
          if ('error' in (r as unknown as Record<string, unknown>)) return
          for (const e of r.raw_events ?? []) {
            const u = (e as Record<string, unknown>).uuid
            if (u !== undefined) seenUuids.current.add(String(u))
          }
          setResult(r)
          setRawEvents((prev) => mergeRaw(prev, r.raw_events ?? []))
        })
        .catch(() => {})
    },
  }
}

/// 浏览模式：宿主代扫的会话列表（单 agent 过滤）。
export function useTraces(agent?: 'claude_code' | 'opencode') {
  return useQuery({
    queryKey: ['traces', agent ?? ''],
    queryFn: async () => {
      const response = await api.list(agent)
      return response.entries
    },
  })
}

/// 跨 agent 聚合的会话列表（trajectory 页）。
export function useTrajectory() {
  return useQuery({
    queryKey: ['trajectory'],
    queryFn: async () => {
      const [claude, opencode] = await Promise.all([api.list('claude_code'), api.list('opencode')])
      return [
        ...claude.entries.map((entry) => ({ ...entry, agent: 'claude_code' })),
        ...opencode.entries.map((entry) => ({ ...entry, agent: 'opencode' })),
      ].sort((a, b) => b.mtimeMs - a.mtimeMs)
    },
  })
}

/// 解析一个会话：绑定会话（无参）或列表内命名会话。
export function useParseSession(named?: { agent: string; sessionId: string } | null) {
  return useQuery({
    queryKey: ['parse-session', named?.agent ?? '', named?.sessionId ?? ''],
    queryFn: () => api.parseSession(named ?? undefined),
    enabled: named === undefined || named === null || (!!named.agent && !!named.sessionId),
  })
}

/// 子会话下钻：按子会话 id 解析（子会话文件同样在宿主代读的列表中）。
export function useSubagent(agent: AgentType, childSessionId: string | null) {
  return useQuery({
    queryKey: ['subagent', agent, childSessionId ?? ''],
    queryFn: () => api.subagent(agent, childSessionId!),
    enabled: !!childSessionId,
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
      typeof x === 'object' && x !== null ? (x as ParseResult).source : x,
    ),
    queryFn: () => api.compare(resultA!, resultB!, labelA, labelB),
    enabled: !!resultA && !!resultB,
  })
}

export function useWorkflowTree(result: ParseResult | null) {
  return useQuery({
    queryKey: ['workflow-tree', result?.source ?? ''],
    queryFn: () => api.workflowTree(result!),
    enabled: !!result,
  })
}
