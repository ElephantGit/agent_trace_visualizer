#!/usr/bin/env bash
# 验证纯计算核心可编译到 wasm32（dashboard 插件的目标形态）。
#
# server feature 下的 axum/tokio 依赖不允许进入 wasm 构建；--no-default-features
# 关闭它们，[[bin]] required-features 同时排除服务端二进制。
set -euo pipefail

cd "$(dirname "$0")/../backend"

rustup target add wasm32-unknown-unknown

cargo check --target wasm32-unknown-unknown --no-default-features
