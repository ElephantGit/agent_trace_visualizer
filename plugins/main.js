// 插件包固定入口（workbench 包的 INSTALLED_ENTRYPOINT 约定为 main.js）。
//
// 真正实现是 src/main.ts：Deno 会按相对导入直接运行 TypeScript 依赖，
// 因此本文件只是转发，包内无需预编译。src/ 与 wasm/ 随包分发。
await import("./src/main.ts");
