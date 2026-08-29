// 插件模式传输层：window.ora.invoke（页面 → Ora 宿主 → 插件进程）。
//
// trace 内容由宿主代读（session.trace 能力），解析/派生在插件进程的 wasm
// 核心内完成；本层不再发起任何 fetch/SSE，也不携带任何文件路径。

import type {
  ComparePayload,
  MermaidResponse,
  ParseResult,
  TraceChunk,
  TraceEntry,
  TraceStat,
  WorkflowNode,
} from './types'

/** host 注入的 workbench 桥（workbench_api.js 定义）。 */
declare global {
  interface Window {
    ora: {
      invoke<T = unknown>(method: string, input?: unknown): Promise<T>
    }
  }
}

/** 宿主/桥接 rejection 通常是 JSON-RPC 错误信封（普通对象），统一提取可读信息。 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err !== null && typeof err === 'object') {
    const rec = err as Record<string, unknown>
    const message = rec.message ?? rec.error
    if (typeof message === 'string' && message.length > 0) return message
    if (typeof rec.kind === 'string') return `宿主拒绝：${rec.kind}`
    try {
      return JSON.stringify(err)
    } catch {
      /* 循环引用等：退化为 String(err) */
    }
  }
  return String(err)
}

/** 统一调用入口：input 缺省为 null（与 WorkbenchCall 契约一致）；rejection 归一为 Error。 */
function invoke<T = unknown>(method: string, input?: unknown): Promise<T> {
  return window.ora.invoke<T>(method, input ?? null).catch((err: unknown) => {
    throw new Error(errMsg(err))
  })
}

export const api = {
  /** 绑定会话的 trace 元数据。 */
  stat: () => invoke<TraceStat>('session/stat'),

  /** 按字节偏移分块读取；childSessionId 用于子会话下钻；named 用于浏览模式的命名会话。 */
  readChunk: (
    offset: number,
    maxBytes?: number,
    childSessionId?: string,
    named?: { agent: string; sessionId: string },
  ) =>
    invoke<TraceChunk>('session/read', {
      offset,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(childSessionId !== undefined ? { childSessionId } : {}),
      ...(named !== undefined ? { agent: named.agent, sessionId: named.sessionId } : {}),
    }),

  /** 浏览模式：宿主代扫的会话列表（单 agent 过滤，需传宿主注册表中的 agent 引用）。 */
  list: (agent?: string) =>
    invoke<{ entries: TraceEntry[] }>('session/list', agent ? { agent } : undefined),

  /** 解析绑定会话（无参数）或列表内命名的会话（宿主校验成员资格）。 */
  parseSession: (named?: { agent: string; sessionId: string }) =>
    invoke<ParseResult>('parse', named),

  /** 绑定会话的统一回放步骤。 */
  replay: () => invoke<{ steps: unknown[]; pageSize: number; contentMaxLength: number; categories: unknown[] }>('replay'),

  /** 五种 mermaid 图之一。 */
  mermaid: (req: {
    kind: string
    rawEvents?: unknown[]
    isTranscript?: boolean
    maxEvents?: number
    seed?: number
    data?: unknown
    result?: ParseResult
  }) => invoke<MermaidResponse>('derive_mermaid', req),

  /** 两个 ParseResult → 完整对比负载。 */
  compare: (
    resultA: ParseResult,
    resultB: ParseResult,
    labelA: string,
    labelB: string,
  ) => invoke<ComparePayload>('compare', { resultA, resultB, labelA, labelB }),

  /** ParseResult → 工作流树。 */
  workflowTree: (result: ParseResult) => invoke<WorkflowNode | null>('workflow_tree', { result }),

  /** 子会话下钻：按子会话 id 解析（子会话文件同样在宿主代读的列表中；agent 为宿主引用）。 */
  subagent: (agent: string, childSessionId: string) =>
    invoke<ParseResult>('parse', { agent, sessionId: childSessionId }),
}
