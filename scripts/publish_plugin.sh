#!/usr/bin/env bash
# 打包 dashboard 插件为可安装的 workbench 包目录 `dist/plugin`。
#
# 前置：wasm-bindgen-cli（cargo install wasm-bindgen-cli --version 0.2.127）
# 产物目录包含 host 启动所需的一切：
#   main.js（固定入口）· src/ · wasm/（core 胶水）· assets/（页面）
#   orax.toml · package.json · deno.json（JSR 导入映射）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. 构建 wasm 核心（release 纯计算形态 + Deno 胶水）
./scripts/build_wasm.sh

# 2. 组装包目录
rm -rf dist/plugin
mkdir -p dist/plugin
cp -r \
  plugins/orax.toml \
  plugins/package.json \
  plugins/deno.json \
  plugins/main.js \
  plugins/assets \
  plugins/src \
  plugins/wasm \
  dist/plugin/

echo "plugin package assembled at dist/plugin/"
