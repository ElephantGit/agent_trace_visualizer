//! 插件进程的 workbench 定义：页面可见方法与页面契约。
//!
//! trace 内容经 `SessionCache` 由 Ora 宿主代读（session.trace 能力），
//! 解析/派生全部在 wasm 核心内完成——本进程不触碰任何文件系统。
//! 宿主错误（能力拒绝/未绑定/不可读）以 invoke rejection 形式透传给页面。

import { defineWorkbenchPlugin } from "@ora-space/plugin-sdk";
import type { WorkbenchCall, WorkbenchPlugin } from "@ora-space/plugin-sdk";
import { core } from "./core.ts";
import { SessionCache, type Surface } from "./session_cache.ts";

/** 从页面调用信封中提取 surface（宿主代际校验的凭据）。 */
function surfaceOf(call: WorkbenchCall): Surface {
  const surface = (call.surface ?? {}) as {
    instanceId?: number;
    generation?: number;
  };
  return {
    instanceId: surface.instanceId ?? 0,
    generation: surface.generation ?? 0,
  };
}

/** 方法实现（可注入 cache 供测试）。 */
export function buildHandlers(cache: SessionCache) {
  return {
    /** 绑定会话的 trace 元数据（宿主代读）。 */
    "session/stat": (call: WorkbenchCall) => cache.stat(surfaceOf(call)),

    /** 按字节偏移分块读取（含子会话；offset 续读模型）。 */
    "session/read": (call: WorkbenchCall) => {
      const input = (call.input ?? {}) as {
        offset?: number;
        maxBytes?: number;
        childSessionId?: string;
      };
      return cache.read(
        surfaceOf(call),
        input.offset ?? 0,
        input.maxBytes ?? 1024 * 1024,
        input.childSessionId,
      );
    },

    /** 浏览模式：宿主代扫的会话列表。 */
    "session/list": (call: WorkbenchCall) => {
      const input = (call.input ?? {}) as { agent?: string };
      return cache.list(surfaceOf(call), input.agent);
    },

    /** 绑定会话（无参）或列表内命名会话（{agent, sessionId}）全文 → wasm 核心解析。 */
    parse: (call: WorkbenchCall) => {
      const input = (call.input ?? {}) as {
        agent?: string;
        sessionId?: string;
      };
      const named = input.agent !== undefined && input.sessionId !== undefined
        ? { agent: input.agent, sessionId: input.sessionId }
        : undefined;
      return cache.parseBound(surfaceOf(call), named);
    },

    /** 绑定会话的统一回放步骤（事件在进程内还原，不经过桥接）。 */
    replay: (call: WorkbenchCall) => cache.replayBound(surfaceOf(call)),

    /** 五种 mermaid 图之一（wasm 核心计算）。 */
    derive_mermaid: (call: WorkbenchCall) =>
      core.deriveMermaid(call.input ?? {}),

    /** 两个 ParseResult → 完整对比负载（wasm 核心计算）。 */
    compare: (call: WorkbenchCall) => core.compare(call.input ?? {}),

    /** ParseResult → 工作流树（wasm 核心计算）。 */
    workflow_tree: (call: WorkbenchCall) => {
      const input = (call.input ?? {}) as { result?: unknown };
      return core.workflowTree(input.result);
    },
  };
}

/** 组装 workbench 定义；main.ts 与测试共用同一份方法表。 */
export function buildDefinition(): WorkbenchPlugin {
  const cache = new SessionCache();
  const workbench = defineWorkbenchPlugin({
    methods: buildHandlers(cache),
  });
  // 注册完成后注入宿主请求通道；任何方法调用都发生在 run() 之后。
  cache.attach((method, params) => workbench.plugin.request(method, params));
  return workbench;
}
