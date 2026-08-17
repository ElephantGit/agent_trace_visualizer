# agent_trace_vis

An **agent trace visualizer** with a Rust backend and a TypeScript (React) frontend.
It parses the internal event streams that AI coding agents (opencode, Claude Code,
Gemini CLI) produce during a session and renders per-turn token usage, tool-call
timing, a sequence diagram, a session replay, workflow DAGs, and raw event tables —
the analysis an agent author needs to understand where tokens/time actually go.

This is a full rewrite of the original Python/Streamlit app (kept under
`legacy/` for reference).

## Architecture

```
frontend/  React + Vite + TypeScript  (plotly.js-basic-dist-min, mermaid, TanStack Query)
backend/   Rust (axum) — parsers, derived data, mermaid builders, static serving
legacy/    the original Python/Streamlit app (runs with `cd legacy && streamlit run app.py`)
plugins/   trace_logger.ts — the opencode plugin that produces the .ndjson traces
```

The backend is the single source of truth for everything that walks
`raw_events` or touches the filesystem (parsing, tiktoken counts, replay-step
adapters, mermaid sources, workflow trees, the compare payload). The frontend
does only pure row-shaping (cumsums, groupbys, pagination, formatting).

## Supported agent types

| `agent_type`  | Source of the trace data                                     |
| ------------- | ------------------------------------------------------------ |
| `opencode`    | `~/.local/share/opencode/trace/<session-id>.ndjson`          |
| `claude_code` | `~/.claude/projects/<project-hash>/<session-id>.jsonl` or `-p --output-format stream-json` (auto-detected) |
| `gemini`      | Gemini CLI telemetry log (standalone only)                   |

## Running

### Production (backend serves the built frontend)

```bash
cd frontend && npm install && npm run build
cd ../backend && cargo run --release
```

Open <http://127.0.0.1:8601/>.

### Development (Vite dev server + backend)

```bash
cd backend && cargo run          # API on 127.0.0.1:8601
cd frontend && npm run dev       # Vite on :5173, proxies /api → 8601
```

## API

All endpoints are same-origin JSON; see `backend/src/api/` for details.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | liveness |
| `POST /api/parse/{opencode\|claude_code\|gemini}` | raw trace bytes → `ParseResult` |
| `POST /api/parse-from-path` | `{agentType, path}` → `ParseResult` |
| `GET /api/embedded/{session_id}?agent_type=` | Ora embedded handoff (locator → parse → status) |
| `GET /api/traces?root=` | list transcript JSONL files (default `~/.claude/projects`) |
| `POST /api/subagent/{session_id}` | child opencode trace (subagent drill-down) |
| `POST /api/derive/replay` | `raw_events` → unified replay steps |
| `POST /api/derive/mermaid` | build any of the 5 mermaid diagram sources |
| `POST /api/compare` | two `ParseResult`s → precomputed A/B payload |
| `POST /api/workflow/tree` | `ParseResult` → agent workflow tree |
| `GET /api/workflow/reactflow` | optional `assets/reactflow.json` (env `REACTFLOW_PATH`) |

## Embedded usage (Ora integration)

When Ora's desktop app iframes this dashboard it opens:

```
http://127.0.0.1:8601/?session_id=<oraSessionId>&agent_type=<opencode|claude_code>
```

Ora resolves the trace file path and writes a locator to its app data directory:

```
<appDataDir>/dashboard/<oraSessionId>.json   →   {"traceFilePath": "...", "agentType": "..."}
```

The backend computes that locator root by OS convention (the Ora Tauri
identifier `space.ora.desktop`), reads the locator, reads the trace file, and
parses by `agent_type`. The private session id never leaves Ora's backend.

Environment overrides: `DASHBOARD_HOST` (default `127.0.0.1`),
`DASHBOARD_PORT` (default `8601`), `DIST_DIR`, `REACTFLOW_PATH`.

> ⚠️ **Trust boundary**: this is a local developer tool with filesystem
> access (arbitrary trace paths, `~/.claude/projects` browsing). The server
> binds loopback only — never expose it beyond localhost.

## Opencode trace-logger plugin (how the `.ndjson` is produced)

opencode does **not** write the trace-logger NDJSON natively; the file is
produced by `plugins/trace_logger.ts`, which subscribes to the opencode event
bus and writes one NDJSON line per event to
`~/.local/share/opencode/trace/<agent-session-id>.ndjson`.

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/trace_logger.ts ~/.config/opencode/plugins/trace_logger.ts
```

The plugin records per-step token deltas + cumulative totals, tool
start/finish with args/output/duration, context pressure, compaction timing,
permission wait time, sub-agent spawns and more.

## Legacy (Python/Streamlit) version

The original app lives in `legacy/` and still runs:

```bash
cd legacy
pip install -r requirements.txt
streamlit run app.py    # .streamlit/config.toml is picked up from this cwd
```

Note: `legacy/trace_viz/views/workflow.py` resolves `assets/reactflow.json`
relative to its own file (i.e. `legacy/assets/`).

## Tests

```bash
cd backend && cargo test          # parsers, derive, mermaid, embedded
cd frontend && npm run build      # tsc strict + vite
```

The Rust parser tests compare against golden JSON generated from the legacy
Python parsers (`scripts/gen_fixtures.py`) — field-level parity, except the
tiktoken-dependent fields where Rust uses real embedded cl100k ranks while
legacy fell back to `len/4` on machines without the tiktoken cache file.

## Project layout

```
backend/
  src/
    parsers/        # opencode / claude_code / gemini → ParseResult
    derive/         # replay steps, compare payload, workflow tree, sampling
    mermaid.rs      # all five mermaid source builders + sanitize
    embedded.rs     # Ora locator contract
    api/            # axum routes
    tiktoken.rs     # cl100k_base counting (offline, embedded ranks)
  tests/            # fixtures + golden parity tests
frontend/
  src/
    pages/          # landing / opencode / claude / gemini / compare / embedded
    components/     # replay engine, mermaid view, workflow view, raw events, …
    api/            # typed client + types
    derive.ts       # client-side row shaping
legacy/             # original Python/Streamlit app
plugins/            # trace_logger.ts (opencode plugin)
scripts/            # gen_fixtures.py
```

## License

MIT.
