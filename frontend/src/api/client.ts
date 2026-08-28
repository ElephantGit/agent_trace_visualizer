// 插件模式传输层：window.ora.invoke（页面 → Ora 宿主 → 插件进程）。
//
// trace 内容由宿主代读（session.trace 能力），解析/派生在插件进程的 wasm
// 核心内完成；本层不再发起任何 fetch/SSE，也不携带任何文件路径。

import type {
  AgentType,
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

/** 统一调用入口：input 缺省为 null（与 WorkbenchCall 契约一致）。 */
function invoke<T = unknown>(method: string, input?: unknown): Promise<T> {
  return window.ora.invoke<T>(method, input ?? null)
}

export const api = {
  /** 绑定会话的 trace 元数据。 */
  stat: () => invoke<TraceStat>('session/stat'),

  /** 按字节偏移分块读取；childSessionId 用于子会话下钻。 */
  readChunk: (offset: number, maxBytes?: number, childSessionId?: string) =>
    invoke<TraceChunk>('session/read', {
      offset,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(childSessionId !== undefined ? { childSessionId } : {}),
    }),

  /** 浏览模式：宿主代扫的会话列表（单 agent 过滤）。 */
  list: (agent?: 'claude_code' | 'opencode') =>
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
  }) => invoke<MermaidResponse>('deriveMermaid', req),

  /** 两个 ParseResult → 完整对比负载。 */
  compare: (
    resultA: ParseResult,
    resultB: ParseResult,
    labelA: string,
    labelB: string,
  ) => invoke<ComparePayload>('compare', { resultA, resultB, labelA, labelB }),

  /** ParseResult → 工作流树。 */
  workflowTree: (result: ParseResult) => invoke<WorkflowNode | null>('workflowTree', { result }),

  /** 子会话下钻：按子会话 id 解析（子会话文件同样在宿主代读的列表中）。 */
  subagent: (agent: AgentType, childSessionId: string) =>
    invoke<ParseResult>('parse', { agent, sessionId: childSessionId }),
}
