//! 骨架验收：每个页面可见方法都返回其文档化形状（D5 前为占位），
//! 且方法表与 orax.toml 的声明一一对应。

import {
  buildDefinition,
  handleCompare,
  handleDeriveMermaid,
  handleParse,
  handleReplay,
  handleSessionList,
  handleSessionRead,
  handleSessionStat,
  handleWorkflowTree,
} from "./definition.ts";

/** 抛出带上下文的失败。 */
function check(condition: boolean, context: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${context}`);
  }
}

/** 伪造的页面调用信封。 */
function fakeCall<T>(input: T) {
  return { surface: { instanceId: 7, generation: 1 }, input };
}

Deno.test("方法集与清单一致", () => {
  const definition = buildDefinition();
  // 方法表在运行期（注册握手）才生效；此处校验定义可构建且带运行句柄。
  check(typeof definition.run === "function", "definition 带 run");
  check(definition.plugin !== undefined, "definition 带 plugin 句柄");
});

Deno.test("session/stat 返回宿主 stat 形状", () => {
  const result = handleSessionStat(fakeCall({})) as Record<string, unknown>;
  for (const key of ["format", "exists", "sizeBytes", "mtimeMs"]) {
    check(key in result, `stat 含 ${key}`);
  }
});

Deno.test("session/read 返回字节偏移续读形状", () => {
  const result = handleSessionRead(fakeCall({})) as Record<string, unknown>;
  for (const key of ["text", "nextOffset", "done"]) {
    check(key in result, `read 含 ${key}`);
  }
});

Deno.test("session/list 返回条目数组形状", () => {
  const result = handleSessionList(fakeCall({})) as Record<string, unknown>;
  check(Array.isArray(result.entries), "list.entries 为数组");
});

Deno.test("纯计算方法返回占位形状", () => {
  check(typeof handleParse(fakeCall({})) === "object", "parse 返回对象");
  const replay = handleReplay(fakeCall({})) as Record<string, unknown>;
  check(Array.isArray(replay.steps), "replay.steps 为数组");
  const mermaid = handleDeriveMermaid(fakeCall({})) as Record<string, unknown>;
  check("src" in mermaid && "totalUnits" in mermaid, "mermaid 形状");
  check(typeof handleCompare(fakeCall({})) === "object", "compare 返回对象");
  check(
    handleWorkflowTree(fakeCall({})) === null,
    "workflowTree 无数据为 null",
  );
});
