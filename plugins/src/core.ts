//! wasm 核心的薄封装：字符串进出，JSON 解析成对象返回。
//!
//! 胶水文件由 `scripts/build_wasm.sh` 生成到 plugins/wasm/（gitignored），
//! 发布流水线（D9）会先构建再打包。

import type { JsonValue } from "@ora-space/plugin-sdk";
import {
  compare,
  derive_mermaid,
  parse,
  replay,
  workflow_tree,
} from "../wasm/trace_viz_backend.js";

/** 统一解析：wasm 返回 JSON 字符串（或错误信封），此处解回对象。 */
function decode(response: string): JsonValue {
  return JSON.parse(response) as JsonValue;
}

export const core = {
  /** 解析一段 trace 文本 → ParseResult（已剥离 raw_events）。 */
  parse(agentType: string, text: string): JsonValue {
    return decode(parse(agentType, text));
  },

  /** 绑定会话的统一回放步骤（事件数组由 main.js 从直读文本还原，不经桥接）。 */
  replay(source: string, events: unknown[]): JsonValue {
    return decode(replay(source, JSON.stringify(events)));
  },

  /** 五种 mermaid 图之一。 */
  deriveMermaid(request: unknown): JsonValue {
    return decode(derive_mermaid(JSON.stringify(request)));
  },

  /** 两个 ParseResult → 完整对比负载。 */
  compare(request: unknown): JsonValue {
    return decode(compare(JSON.stringify(request)));
  },

  /** ParseResult → 工作流树（无数据为 null）。 */
  workflowTree(result: unknown): JsonValue {
    return decode(workflow_tree(JSON.stringify(result ?? null)));
  },
};
