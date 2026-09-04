declare module '*agent_dashboard_wasm.js' {
  const init: () => Promise<void>
  export default init
  export function parse_trace(agentType: string, content: string): string
  export function compare(resultA: string, resultB: string, labelA: string, labelB: string): string
  export function replay(agentType: string, rawEvents: string): string
  export function mermaid_source(kind: string, payload: string): string
  export function workflow_tree(result: string): string
}
