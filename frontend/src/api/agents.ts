// 宿主 trace 注册表以 agent 插件的 namespaced 包标识为键（AgentRef），
// 前端列表过滤与命名会话解析必须使用这些引用。
// `claude_code` / `opencode` 是 trace 格式标识（决定 wasm 解析器），不是 agent 引用。

export const CLAUDE_AGENT_REFS: readonly string[] = [
  'ora-space.claude',
  'ora-space.codex',
  'ora-space.codeagentcli',
]

export const OPENCODE_AGENT_REFS: readonly string[] = ['ora-space.opencode', 'ora-space.nga']

/// 命名解析缺省引用（列表条目缺 agent 字段时的兜底）。
export const DEFAULT_CLAUDE_REF = 'ora-space.claude'
export const DEFAULT_OPENCODE_REF = 'ora-space.opencode'
