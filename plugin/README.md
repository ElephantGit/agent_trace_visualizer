# Agent Dashboard workbench plugin

The plugin process has no filesystem, process, network, or HTTP permission. Ora injects an
opaque invocation context into each page call; `dashboard/list`, `dashboard/stat`, and
`dashboard/read` use it to request a bounded trace slice from the Host. The page is responsible
for parsing slices through the packaged WebAssembly trace engine.

## Build

Run `deno task build`. It compiles the browser-only Rust parser to `assets/wasm/` and bundles the
zero-permission workbench entry into `main.js`. Package both files and the complete `assets/`
directory in the `.orax` artifact; the page must never use the standalone Dashboard HTTP service.

Run `deno task package` to generate `dist/ora-space.agent-dashboard-0.2.10.orax` for import into
Ora.
