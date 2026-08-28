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
wasm-bindgen "target/wasm32-unknown-unknown/release/trace_viz_backend.wasm" \
    --out-dir "$ROOT/plugins/wasm" \
    --target deno

echo "wasm core built into plugins/wasm/"
