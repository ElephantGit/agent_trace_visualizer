//! 会话数据缓存层：唯一的 IO 入口。
//!
//! trace 内容由 Ora 宿主代读（`ora/session/trace_*`，session.trace 能力），
//! 本层按字节偏移分块拉取并缓存派生结果；解析/派生一律交给 wasm 核心。
//! 本模块不触碰文件系统。

import type { JsonValue } from "@ora-space/plugin-sdk";
import { core } from "./core.ts";

/** 宿主请求通道（attach 前未绑定；definition 组装时注入）。 */
export type HostRequest = (
  method: string,
  params: JsonValue,
) => Promise<JsonValue>;

/** 页面调用信封里的 surface（透传给宿主做代际校验）。 */
export type Surface = {
  instanceId: number;
  generation: number;
};

/** 宿主 stat 响应形状（与 backend TraceHost 对齐）。 */
export type TraceStat = {
  format: string;
  exists: boolean;
  sizeBytes: number;
  mtimeMs: number;
};

/** 宿主 read 响应形状：字节偏移续读模型。 */
export type TraceChunk = {
  text: string;
  nextOffset: number;
  done: boolean;
};

/** 单块读取上限：与宿主 TraceService 的 1 MiB 分块对齐。 */
export const READ_CHUNK_BYTES = 1024 * 1024;

/** 绑定会话的读取与派生缓存；进程级单例（definition 组装时创建）。 */
export class SessionCache {
  #request: HostRequest | undefined;

  /** 注入宿主请求通道（插件注册后、任何方法被调用前完成）。 */
  attach(request: HostRequest): void {
    this.#request = request;
  }

  #host<T>(method: string, params: JsonValue): Promise<T> {
    if (this.#request === undefined) {
      return Promise.reject(new Error("SessionCache 未绑定宿主请求通道"));
    }
    return this.#request(method, params) as unknown as Promise<T>;
  }

  /** 绑定会话（或列表内命名会话）的 trace 元数据。 */
  stat(
    surface: Surface,
    named?: { agent: string; sessionId: string },
  ): Promise<TraceStat> {
    const params: Record<string, JsonValue> = { surface };
    if (named !== undefined) {
      params.agent = named.agent;
      params.sessionId = named.sessionId;
    }
    return this.#host<TraceStat>("ora/session/trace_stat", params);
  }

  /** 按字节偏移分块读取（子会话读取需 childSessionId，宿主校验其在父 trace 中出现过）。 */
  read(
    surface: Surface,
    offset = 0,
    maxBytes = READ_CHUNK_BYTES,
    childSessionId?: string,
    named?: { agent: string; sessionId: string },
  ): Promise<TraceChunk> {
    const params: Record<string, JsonValue> = {
      surface,
      offset,
      maxBytes,
    };
    if (childSessionId !== undefined) {
      params.childSessionId = childSessionId;
    }
    if (named !== undefined) {
      params.agent = named.agent;
      params.sessionId = named.sessionId;
    }
    return this.#host<TraceChunk>("ora/session/trace_read", params);
  }

  /** 浏览模式：宿主代扫的会话列表。 */
  list(surface: Surface, agent?: string): Promise<JsonValue> {
    const params: Record<string, JsonValue> = { surface };
    if (agent !== undefined) {
      params.agent = agent;
    }
    return this.#host<JsonValue>("ora/session/trace_list", params);
  }

  /** 分块循环读取会话全文（增长中的文件读到 done 为止；调用方可反复 poll）。 */
  async readAll(
    surface: Surface,
    named?: { agent: string; sessionId: string },
  ): Promise<string> {
    let text = "";
    let offset = 0;
    for (;;) {
      const chunk = await this.read(
        surface,
        offset,
        READ_CHUNK_BYTES,
        undefined,
        named,
      );
      text += chunk.text;
      offset = chunk.nextOffset;
      if (chunk.done) {
        return text;
      }
    }
  }

  /** 绑定会话（或列表内命名会话）的 ParseResult（wasm 核心解析，已剥离 raw_events）。 */
  async parseBound(
    surface: Surface,
    named?: { agent: string; sessionId: string },
  ): Promise<JsonValue> {
    const stat = await this.stat(surface, named);
    if (!stat.exists) {
      // 会话刚建立时 trace 尚未落盘：页面按 500ms 重试窗口展示"等待 trace 生成"。
      return { error: "trace_not_ready" };
    }
    const text = await this.readAll(surface, named);
    return core.parse(stat.format, text) as JsonValue;
  }

  /** 绑定会话的统一回放步骤（事件数组在进程内还原，不经过桥接）。 */
  async replayBound(surface: Surface): Promise<JsonValue> {
    const stat = await this.stat(surface);
    if (!stat.exists) {
      return { error: "trace_not_ready" };
    }
    const text = await this.readAll(surface);
    const events: unknown[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // 半行/畸形行：跳过，不影响整体回放。
      }
    }
    return core.replay(stat.format, events) as JsonValue;
  }
}
