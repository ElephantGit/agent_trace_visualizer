//! 适配层测试：用假宿主请求通道驱动 SessionCache 与 wasm 核心，
//! 验证分块循环读、offset 续读、trace 未就绪语义与纯计算透传。

import { buildDefinition, buildHandlers } from "./definition.ts";
import { SessionCache } from "./session_cache.ts";
import type { HostRequest } from "./session_cache.ts";

/** 抛出带上下文的失败。 */
function check(condition: boolean, context: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${context}`);
  }
}

/** 伪造的页面调用信封（input 缺省为 null，与 WorkbenchCall 契约一致）。 */
function fakeCall<T = null>(input: T = null as T) {
  return { surface: { instanceId: 7, generation: 1 }, input };
}

/** 记录调用的假宿主。 */
function fakeHost(
  responses: Record<string, (params: Record<string, unknown>) => unknown>,
): {
  request: HostRequest;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request: HostRequest = (method, params) => {
    const record = { method, params: params as Record<string, unknown> };
    calls.push(record);
    const respond = responses[method];
    if (respond === undefined) {
      return Promise.reject(new Error(`unexpected host method ${method}`));
    }
    return Promise.resolve(respond(record.params) as never);
  };
  return { request, calls };
}

Deno.test("session/read 透传 offset 续读参数与子会话", async () => {
  const host = fakeHost({
    "ora/session/trace_read": (params) => {
      const child = params.childSessionId === "ses_child" ? "-child" : "";
      return { text: `line${child}\n`, nextOffset: 100, done: true };
    },
  });
  const cache = new SessionCache();
  cache.attach(host.request);
  const handlers = buildHandlers(cache);

  const result = await handlers["session/read"](
    fakeCall({ offset: 40, maxBytes: 4096 }),
  );
  check((result as { text: string }).text === "line\n", "读取透传");

  const child = await handlers["session/read"](
    fakeCall({ offset: 0, childSessionId: "ses_child" }),
  );
  check((child as { text: string }).text === "line-child\n", "子会话读取");

  const last = host.calls[host.calls.length - 1];
  check(last.params.childSessionId === "ses_child", "childSessionId 进参");
  check(
    (last.params.surface as { instanceId: number }).instanceId === 7,
    "surface 透传",
  );
});

Deno.test("parseBound 分块循环读完全文后交给 wasm 核心", async () => {
  const host = fakeHost({
    "ora/session/trace_stat": () => ({
      format: "opencode",
      exists: true,
      sizeBytes: 0,
      mtimeMs: 0,
    }),
    "ora/session/trace_read": (params) => {
      const offset = params.offset as number;
      if (offset === 0) {
        return {
          text: '{"type":"session.start","title":"t"}\n',
          nextOffset: 44,
          done: false,
        };
      }
      return { text: "", nextOffset: 44, done: true };
    },
  });
  const cache = new SessionCache();
  cache.attach(host.request);
  const handlers = buildHandlers(cache);

  const result = await handlers.parse(fakeCall()) as Record<string, unknown>;
  check(result.error === undefined, "解析成功无错误信封");
  check(result.session_info !== undefined, "ParseResult 有 session_info");
  check(!("raw_events" in result), "raw_events 已剥离");

  const readCalls = host.calls.filter((call) =>
    call.method === "ora/session/trace_read"
  );
  check(readCalls.length === 2, `循环读到 done，共 ${readCalls.length} 次`);
  check(readCalls[1].params.offset === 44, "第二次读取带正确 offset");
});

Deno.test("trace 未落盘时 parse 返回 trace_not_ready", async () => {
  const host = fakeHost({
    "ora/session/trace_stat": () => ({
      format: "opencode",
      exists: false,
      sizeBytes: 0,
      mtimeMs: 0,
    }),
  });
  const cache = new SessionCache();
  cache.attach(host.request);
  const handlers = buildHandlers(cache);

  const result = await handlers.parse(fakeCall()) as Record<string, unknown>;
  check(result.error === "trace_not_ready", "未就绪信封");
});

Deno.test("宿主错误以 rejection 透传（能力拒绝等）", async () => {
  const host = fakeHost({});
  const cache = new SessionCache();
  cache.attach(host.request);
  const handlers = buildHandlers(cache);

  let rejected = false;
  try {
    await handlers["session/stat"](fakeCall());
  } catch {
    rejected = true;
  }
  check(rejected, "未知宿主方法/错误 → invoke rejection");
});

Deno.test("纯计算方法透传给 wasm 核心", async () => {
  const cache = new SessionCache();
  const handlers = buildHandlers(cache);

  const mermaid = await handlers.derive_mermaid(fakeCall({
    kind: "sequence-opencode",
    rawEvents: [{ type: "step.start", ts: 1 }],
    seed: 1,
  })) as Record<string, unknown>;
  check("src" in mermaid && typeof mermaid.src === "string", "mermaid 图产出");

  const tree = await handlers.workflow_tree(fakeCall({ result: null }));
  check(tree === null, "无工作流为 null");
});

Deno.test("方法集与清单一致", () => {
  const definition = buildDefinition();
  check(typeof definition.run === "function", "definition 带 run");
  check(definition.plugin !== undefined, "definition 带 plugin 句柄");
});
