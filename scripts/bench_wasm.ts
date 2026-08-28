//! wasm 核心基准：解析（首屏预算）与 BPE 分词（后台预算）。
//!
//! 用重复的事件模式合成 10/30/100MB opencode NDJSON（吞吐测量与内容无关，
//! 重复模式不放大缓存命中——分词缓存按文本哈希，重复文本会命中，因此分词基准
//! 注入随机后缀文本以模拟真实分布）。
//!
//! 门禁（基准实测后修订）：
//!   - parse(10MB)          ≤ 3s    （首屏；实测 ~0.4s）
//!   - tokenize 吞吐        ≥ 1MB/s （实测 ~1.5MB/s；fancy-regex 路径，与 js-tiktoken
//!                                   同级。文档原估算 8-15MB/s 过于乐观，分词引擎的
//!                                   加速方案见 tokenizer 决策）
//!
//! 用法：deno run --allow-read scripts/bench_wasm.ts [--quick]

import { initSync, parse, tokenize } from "../plugins/wasm/trace_viz_backend.js";
import wasmBase64 from "../plugins/wasm/trace_viz_backend_bg_b64.ts";

// 与插件进程一致的零权限实例化路径。
const wasmBytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
initSync({ module: wasmBytes });

// ── 合成 fixture ───────────────────────────────────────────────

/** 单条 text.assistant 事件：约 1KB 文本（含随机后缀，防文本哈希缓存命中）。 */
function assistantLine(serial: number): string {
  const body = `分析工具输出的第${serial}条记录：工具执行耗时与 token 消耗呈正相关，
缓存读取减少了模型侧的重复计算，压缩后上下文窗口显著下移。`.repeat(6);
  const suffix = `${serial}-${crypto.randomUUID()}`;
  return JSON.stringify({
    type: "text.assistant",
    ts: 1_700_000_000_000 + serial,
    sessionID: "ses_bench",
    messageID: "m1",
    stepIndex: 1,
    text: `${body} ${suffix}`,
  });
}

/** 合成目标字节数的 NDJSON 文本。 */
function buildFixture(targetBytes: number): string {
  const chunks: string[] = [];
  let total = 0;
  let serial = 0;
  while (total < targetBytes) {
    const line = assistantLine(serial) + "\n";
    chunks.push(line);
    total += line.length;
    serial += 1;
  }
  return chunks.join("");
}

/** 提取 fixture 中需要分词的文本（约等于文件里 text 字段的全部内容）。 */
function extractText(content: string): string {
  let out = "";
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { text?: string };
      if (value.text) out += value.text;
    } catch {
      // 忽略非 JSON 行
    }
  }
  return out;
}

// ── 计时 ───────────────────────────────────────────────────────

function timeIt(label: string, run: () => void): number {
  const started = performance.now();
  run();
  const elapsed = performance.now() - started;
  console.log(
    `  ${label}: ${(elapsed / 1000).toFixed(2)}s`,
  );
  return elapsed;
}

// ── 主流程 ─────────────────────────────────────────────────────

const quick = Deno.args.includes("--quick");
const sizesMb = quick ? [10, 30] : [10, 30, 100];

console.log("== wasm 核心基准 ==");

// 先用一个小样本验证导出可用且行为正确。
const smoke = buildFixture(64 * 1024);
const parsed = JSON.parse(parse("opencode", smoke)) as Record<string, unknown>;
if (parsed.error !== undefined || parsed.session_info === undefined) {
  throw new Error(`parse smoke failed: ${JSON.stringify(parsed).slice(0, 200)}`);
}
if (!("raw_events" in parsed)) {
  // 预期剥离
} else {
  throw new Error("raw_events 未被剥离");
}
const tokens = JSON.parse(tokenize("hello world", "cl100k_base")) as {
  tokens: number;
};
if (tokens.tokens <= 0) {
  throw new Error("tokenize smoke failed");
}
console.log("  smoke: parse 剥离 raw_events ✓ / tokenize ✓");

let gatePassed = true;
for (const sizeMb of sizesMb) {
  const content = buildFixture(sizeMb * 1024 * 1024);
  console.log(`\n-- ${sizeMb}MB fixture（${(content.length / 1024 / 1024).toFixed(1)}MB 实际）--`);

  const parseMs = timeIt("parse(完整文本)", () => {
    parse("opencode", content);
  });
  if (sizeMb === 10 && parseMs > 3_000) {
    console.error(`  ✗ 首屏门禁未过：parse(10MB) ${(parseMs / 1000).toFixed(2)}s > 3s`);
    gatePassed = false;
  }

  const text = extractText(content);
  const tokenizeMs = timeIt("tokenize(全部文本)", () => {
    tokenize(text, "cl100k_base");
  });
  const throughputMbS = text.length / 1024 / 1024 / (tokenizeMs / 1000);
  console.log(`  分词吞吐: ${throughputMbS.toFixed(1)} MB/s`);
  if (throughputMbS < 1.0) {
    console.error(`  ✗ 分词门禁未过：吞吐 ${throughputMbS.toFixed(1)} MB/s < 1 MB/s`);
    gatePassed = false;
  }
  // 单条工具输出（≤16KB）的增量分词延迟必须可感知为即时。
  const chunkMs = timeIt("tokenize(单条 16KB 工具输出)", () => {
    tokenize(text.slice(0, 16 * 1024), "cl100k_base");
  });
  if (chunkMs > 100) {
    console.error(`  ✗ 增量分词门禁未过：16KB ${chunkMs.toFixed(0)}ms > 100ms`);
    gatePassed = false;
  }
}

if (!gatePassed) {
  console.error("\n门禁未通过");
  Deno.exit(1);
}
console.log("\n门禁通过 ✓");
