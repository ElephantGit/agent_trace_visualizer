//! 插件进程的 workbench 定义：页面可见方法与页面契约在此定稿。
//!
//! D4 为骨架形态：每个方法返回文档化的占位形状，D5 将实现体替换为
//! SessionCache（宿主 `ora/session/trace_*` 分块直读）与 wasm 核心（解析/派生）。
//! 骨架自身即可安装：host-driver 下方法往返成功即通过验收。

import { defineWorkbenchPlugin } from "@ora-space/plugin-sdk";
import type { WorkbenchCall, WorkbenchPlugin } from "@ora-space/plugin-sdk";

/** 页面调用信封的统一解包（surface 透传给宿主请求时用于代际校验）。 */
export interface SessionCall<Input = unknown> extends WorkbenchCall<Input> {
  surface: {
    instanceId: number;
    generation: number;
  };
}

// ── 方法实现（D4 占位；形状即页面契约） ─────────────────────────

/** session/stat：绑定会话的 trace 元数据（宿主代读）。 */
export function handleSessionStat(_call: SessionCall) {
  // D5：plugin.request("ora/session/trace_stat", { surface, ... })
  return { format: "", exists: false, sizeBytes: 0, mtimeMs: 0 };
}

/** session/read：按字节偏移分块读取（含子会话）；offset 续读模型。 */
export function handleSessionRead(_call: SessionCall) {
  // D5：plugin.request("ora/session/trace_read", { surface, offset, maxBytes, childSessionId })
  return { text: "", nextOffset: 0, done: true };
}

/** session/list：浏览模式的会话列表（宿主代扫）。 */
export function handleSessionList(_call: SessionCall) {
  // D5：plugin.request("ora/session/trace_list", { surface, agent })
  return { entries: [] };
}

/** parse：把绑定会话的完整文本喂给 wasm 核心，返回剥离 raw_events 的 ParseResult。 */
export function handleParse(_call: SessionCall) {
  // D5：分块循环 read → wasm.parse(format, text)
  return {};
}

/** replay：绑定会话的统一回放步骤（wasm 核心计算）。 */
export function handleReplay(_call: SessionCall) {
  // D5：wasm 内联计算（rawEvents 不经过桥接）
  return { steps: [], pageSize: 10, contentMaxLength: 500, categories: [] };
}

/** deriveMermaid：五种 mermaid 图之一（wasm 核心计算）。 */
export function handleDeriveMermaid(_call: SessionCall) {
  // D5：wasm.derive_mermaid(req)
  return { src: "", totalUnits: 0, sampledUnits: 0, notice: null };
}

/** compare：两个 ParseResult → 完整对比负载（wasm 核心计算）。 */
export function handleCompare(_call: SessionCall) {
  // D5：wasm.compare(req)
  return {};
}

/** workflowTree：ParseResult → 工作流树（wasm 核心计算）。 */
export function handleWorkflowTree(_call: SessionCall) {
  // D5：wasm.workflow_tree(result)
  return null;
}

/** 组装 workbench 定义；main.ts 与测试共用同一份方法表。 */
export function buildDefinition(): WorkbenchPlugin {
  return defineWorkbenchPlugin({
    methods: {
      "session/stat": handleSessionStat,
      "session/read": handleSessionRead,
      "session/list": handleSessionList,
      parse: handleParse,
      replay: handleReplay,
      deriveMermaid: handleDeriveMermaid,
      compare: handleCompare,
      workflowTree: handleWorkflowTree,
    },
  });
}
