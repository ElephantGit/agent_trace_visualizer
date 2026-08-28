//! Dashboard 插件的 Deno 进程入口。
//!
//! v1 workbench 契约：页面只能通过 `window.ora.invoke` 拉取本进程的方法
//! （无推送通道）。trace 内容由 Ora 宿主代读、本进程经 `ora/session/trace_*`
//! 拉取，解析/派生全部在 wasm 核心内完成——本进程不触碰任何文件系统。

import { buildDefinition } from "./definition.ts";

const workbench = buildDefinition();
await workbench.run();
