#!/usr/bin/env bash
# 构建 dashboard 插件的 wasm 核心：release 纯计算形态 + wasm-bindgen Deno 胶水。
#
# 产物：
#   plugins/wasm/trace_viz_backend.js   （Deno 入口，导出 parse/tokenize/…）
#   plugins/wasm/trace_viz_backend_bg.wasm
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"

rustup target add wasm32-unknown-unknown

cargo build --release --target wasm32-unknown-unknown --no-default-features

mkdir -p "$ROOT/plugins/wasm"
# web 目标：胶水导出 initSync(bytes)，可完全在内存实例化——
# 插件进程零权限（无 --allow-read），不能 fetch 任何文件。
wasm-bindgen "target/wasm32-unknown-unknown/release/trace_viz_backend.wasm" \
    --out-dir "$ROOT/plugins/wasm" \
    --target web

# 把 .wasm 内嵌为 base64 TS 模块（模块加载不受读权限限制）。
{
  printf '// 由 scripts/build_wasm.sh 生成：wasm 二进制的 base64 内嵌（零权限实例化）。\n'
  printf 'export default "'
  # 注意：必须用 CLI 后处理过的 *_bg.wasm（CLI 会剥离 __wbindgen_placeholder__ 等导入）。
  base64 -w0 "$ROOT/plugins/wasm/trace_viz_backend_bg.wasm"
  printf '";\n'
} > "$ROOT/plugins/wasm/trace_viz_backend_bg_b64.ts"

echo "wasm core built into plugins/wasm/ (base64-embedded)"
