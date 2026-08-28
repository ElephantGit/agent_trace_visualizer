# Agent Trace Visualizer —— 插件化架构

## 三方职责

| 角色 | 职责 | 不做什么 |
|---|---|---|
| **agent 插件**（claude-code-agent / opencode-agent） | 保证 trace 文件存在并登记位置：claude 仅清单声明（`~/.claude/projects` 搜索模板）；opencode 部署 trace-logger 到 `~/.config/opencode/plugins/`（幂等、XDG 感知）并登记 `{data_dir}/opencode/trace` 模板 | 不推送、不缓冲任何 trace 内容 |
| **Ora 宿主** | 唯一碰文件系统的角色：`[agent.trace]` 注册表 + `TraceService` 代读（1 MiB 行边界分块、字节偏移续读、子会话父 trace 校验、列表+命名提取）+ 会话绑定（面板 ↔ 会话）| 路径从不离开宿主；只读；审计只记 plugin/session id |
| **dashboard 插件**（本仓库） | workbench 形态：Deno 进程经 `ora/session/trace_*` 拉取（`session.trace` 能力门控），解析/派生全部在 wasm 核心（`plugins/wasm/`）内完成；页面经 `window.ora.invoke` 拉取 | 不触碰文件系统、不发起 fetch/SSE、不携带路径 |

## 数据流

```
agent 运行时 ──写──▶ trace 文件（claude: transcript JSONL / opencode: trace_logger NDJSON）
Ora 宿主 ──[agent.trace] 清单──▶ 注册表 → TraceService（唯一读文件者）
dashboard 插件进程 ──plugin.request("ora/session/trace_stat|read|list")──▶ 宿主（能力+代际+绑定校验）
                  └─ 1 MiB 分块循环读 → wasm.parse/derive → 页面 invoke 拉取
```

## 构建与打包

```bash
# 构建 wasm 核心（需要 rustup target wasm32-unknown-unknown + wasm-bindgen-cli 0.2.127）
./scripts/build_wasm.sh

# 基准门禁（10/30/100MB 合成 fixture；--quick 跳过 100MB）
deno run --allow-read scripts/bench_wasm.ts --quick

# 插件进程侧校验
cd plugins && deno task check && deno task test

# 打包可安装的 workbench 包目录
./scripts/publish_plugin.sh    # → dist/plugin/
```

## 安全边界

| 层 | 拿得到 | 拿不到 |
|---|---|---|
| dashboard 页面 | 绑定会话的聚合视图、按需事件切片、浏览列表 | 文件路径、其他会话（宿主校验列表成员资格）、网络、文件系统 |
| dashboard 进程 | 当前绑定会话 + 列表内会话的 trace 文本、format 标识 | 路径、能力外的宿主方法、文件系统 |
| 宿主 | 一切 | — |

宿主侧方法：`ora/session/trace_stat` / `trace_read`（offset/maxBytes/childSessionId 或显式 {agent, sessionId}，成员资格校验）/ `trace_list`。均需 workbench 清单声明 `host_capabilities = ["session.trace"]`。

## 已知限制

- **分词吞吐**：cl100k 走 fancy-regex，wasm ~1.5MB/s（与 js-tiktoken 同级）。单条工具输出（≤16KB）<10ms，UI 增量路径即时；整会话全量分词（100MB ≈ 50s）建议后续用 regex-crate 等价变换加速（需与 tiktoken-rs 差分验证）。
- **对比模式**：两个 ParseResult 需分别来自列表内会话（宿主成员校验）；上传形态仅在 dev harness 可用。
- **Gemini**：无运行时插件，插件形态下无数据源（dev harness 可上传）。
