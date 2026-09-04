#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen \
  --target web \
  --out-dir ../../frontend/src/generated/wasm \
  --out-name agent_dashboard_wasm \
  target/wasm32-unknown-unknown/release/agent_dashboard_wasm.wasm
mkdir -p ../../frontend/public/wasm
cp ../../frontend/src/generated/wasm/agent_dashboard_wasm_bg.wasm \
  ../../frontend/public/wasm/agent_dashboard_wasm_bg.wasm
deno run --allow-read --allow-write ../scripts/embed-wasm.ts \
  ../../frontend/src/generated/wasm/agent_dashboard_wasm_bg.wasm \
  ../../frontend/src/generated/wasm/agent_dashboard_wasm_bytes.ts
