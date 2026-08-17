// Type mirrors of the Rust backend's serde structs
// (backend/src/models.rs + derive payloads).

export interface ToolCall {
  name: string
  input: unknown
  output: string
  is_error: boolean
  turn_no: number
  call_idx: number
  tiktoken_tokens: number
  output_chars: number
  duration_ms: number
  file_path: string
  allotted_tokens: number
}

export interface Turn {
  turn_no: number
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_creation: number
  stop_reason: string
  text_content: string
  tool_count: number
  model: string
  reasoning_tokens: number
}

export interface SessionInfo {
  model: string
  session_id: string
  tools_available: string[]
  title: string
  permission_mode: string
}

export interface ResultInfo {
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  total_cost_usd: number
  is_error: boolean
  result_text: string
  total_input: number
  total_output: number
  total_cache_creation: number
  total_cache_read: number
}

export interface WorkflowNode {
  id: string
  name: string
  description: string
  state: string
  parent_id: string | null
  children: WorkflowNode[]
  global_step: number
  duration_ms: number | null
  tool_count: number
  input_tokens: number
  output_tokens: number
  is_root: boolean
}

export interface ParseResult {
  source: string
  raw_events: unknown[]
  session_info: SessionInfo
  result_info: ResultInfo
  turns: Turn[]
  tool_calls: ToolCall[]
  parse_errors: number
  parse_debug: Record<string, unknown>
  subagents: Record<string, unknown>[]
}

// ── API endpoints ─────────────────────────────────────────────

export type AgentType = 'opencode' | 'claude_code' | 'gemini'

export interface EmbeddedResponse {
  status: 'ok' | 'locator_missing' | 'agent_mismatch' | 'trace_missing' | 'parse_empty' | 'unsupported_agent'
  result?: ParseResult
  message?: string
}

export interface TraceEntry {
  path: string
  mtimeMs: number
  sizeBytes: number
}

export interface ReplayStep {
  seq: number
  category: string
  title: string
  content: string
  detail: Record<string, unknown>
  turn_no: number
  is_error: boolean
}

export interface CategoryStyle {
  label: string
  icon: string
  bg: string
  header_bg: string
  border: string
  text: string
}

export interface ReplayResponse {
  steps: ReplayStep[]
  pageSize: number
  contentMaxLength: number
  categories: [string, CategoryStyle][]
}

export interface MermaidResponse {
  src: string
  totalUnits: number
  sampledUnits: number
  notice: string | null
}

export interface SummaryCard {
  title: string
  val_a: number
  val_b: number
  fmt: string
  lower_better: boolean
  str_a: string
  str_b: string
  delta_pct: number
  delta_color: string
  arrow: string
  desc: string
  delta_str: string
}

export interface OverlayTurn {
  turn_no: number
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_creation: number
}

export interface ComparePayload {
  summaryCards: SummaryCard[]
  overlay: {
    turnsA: OverlayTurn[]
    turnsB: OverlayTurn[]
    annotation: { x: number; y: number; text: string } | null
  }
  perTurn: {
    turn: number
    in_a: number | null
    in_b: number | null
    out_a: number | null
    out_b: number | null
    cache_read_a: number | null
    cache_read_b: number | null
    delta_in_a: number | null
    delta_in_b: number | null
  }[]
  tools: {
    name: string
    count_a: number
    count_b: number
    tok_a: number
    tok_b: number
    dur_avg_a: number | null
    dur_avg_b: number | null
    delta_count: string
    delta_token: string
  }[]
  savings: { name: string; savedTokens: number }[]
  labels: { a: string; b: string }
  detail: {
    turn: number
    in_a: string | null
    in_b: string | null
    delta_in: string
    out_a: string | null
    out_b: string | null
    delta_out: string
    cache_read_a: string
    cache_read_b: string
  }[]
}
