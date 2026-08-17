// Workflow DAG view — ReactFlow JSON preferred, trace-extracted tree as
// fallback (mirrors legacy views/workflow.py).

import { useMemo, useState } from 'react'
import type { ParseResult, WorkflowNode } from '../api/types'
import { useMermaid, useReactflow, useWorkflowTree } from '../hooks'
import MermaidView from './MermaidView'
import { DataTable, Expander, Info, Pills } from './ui/primitives'
import { fmtTok } from '../derive'

// ── Shared tables (ported from workflow.py) ───────────────────

const AGENT_ICONS: [string, string][] = [
  ['开始', '🚀'], ['规划', '📐'], ['需求分解', '📋'], ['spec', '📝'],
  ['explore', '🔍'], ['tdd', '🧪'], ['构建', '📦'], ['门禁', '🚧'],
  ['commit', '📤'], ['review', '🔎'], ['test', '✅'],
]

export function agentIcon(name: string): string {
  const lower = name.toLowerCase()
  return AGENT_ICONS.find(([key]) => lower.includes(key))?.[1] ?? '🤖'
}

const STATE_COLORS: Record<string, { bg: string; border: string; text: string; icon: string; label: string }> = {
  completed: { bg: '#f0fdf4', border: '#22c55e', text: '#166534', icon: '✅', label: '已完成' },
  failed: { bg: '#fef2f2', border: '#f87171', text: '#991b1b', icon: '❌', label: '失败' },
  error: { bg: '#fef2f2', border: '#f87171', text: '#991b1b', icon: '❌', label: '出错' },
  running: { bg: '#fffbeb', border: '#fbbf24', text: '#92400e', icon: '⏳', label: '进行中' },
  unknown: { bg: '#f8fafc', border: '#94a3b8', text: '#475569', icon: '❓', label: '未知' },
}

interface RfNode {
  id: string
  data?: {
    title?: string
    description?: string
    agentConfig?: {
      executor?: { agentCli?: string }
      schemaVersion?: string | number
      roleId?: string
      skills?: { skillId?: string; enabled?: boolean }[]
      mcps?: { mcpId?: string; enabled?: boolean }[]
      prompt?: string
    }
  }
}
interface RfEdge { source: string; target: string }

/// Topo sort + longest-path DP over ReactFlow nodes/edges.
function estimateDagDepth(nodes: RfNode[], edges: RfEdge[]): number {
  if (nodes.length === 0) return 0
  const ids = new Set(nodes.map((n) => n.id))
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of ids) {
    adj.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      adj.get(e.source)!.push(e.target)
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    }
  }
  const depth = new Map<string, number>()
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n)
  for (const n of queue) depth.set(n, 1)
  while (queue.length > 0) {
    const u = queue.shift()!
    for (const v of adj.get(u) ?? []) {
      depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1))
      indeg.set(v, (indeg.get(v) ?? 0) - 1)
      if (indeg.get(v) === 0) queue.push(v)
    }
  }
  return depth.size > 0 ? Math.max(...depth.values()) : Math.max(nodes.length, 1)
}

function topologicalSort(nodes: RfNode[], edges: RfEdge[]): RfNode[] {
  if (nodes.length === 0) return []
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) {
    indeg.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const e of edges) {
    if (adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source)!.push(e.target)
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    }
  }
  const result: RfNode[] = []
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n)
  const visited = new Set<string>()
  while (queue.length > 0) {
    const nid = queue.shift()!
    if (visited.has(nid)) continue
    visited.add(nid)
    const node = nodeMap.get(nid)
    if (node) result.push(node)
    for (const next of adj.get(nid) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1)
      if (indeg.get(next) === 0) queue.push(next)
    }
  }
  for (const n of nodes) {
    if (!visited.has(n.id)) result.push(n)
  }
  return result
}

function flattenTree(node: WorkflowNode): WorkflowNode[] {
  return [node, ...node.children.flatMap(flattenTree)]
}

// ── Main component ────────────────────────────────────────────

export default function WorkflowView({
  root,
  result,
}: {
  root?: WorkflowNode | null
  result?: ParseResult | null
}) {
  // Trace tree may need building when the replay tab receives a ParseResult.
  const treeQuery = useWorkflowTree(result ?? null)
  const treeRoot = root ?? treeQuery.data ?? null
  const reactflow = useReactflow(true)
  const rfData = reactflow.data as { name?: string; nodes?: RfNode[]; edges?: RfEdge[] } | undefined

  const mermaidReq = useMemo(() => {
    if (rfData) {
      return { kind: 'workflow-reactflow', data: rfData }
    }
    if (result) {
      return { kind: 'workflow-tree', result }
    }
    return null
  }, [rfData, result])
  const mermaid = useMermaid(mermaidReq ?? { kind: 'workflow-reactflow' })

  if (rfData) {
    return <ReactflowView data={rfData} mermaidSrc={mermaid.data?.src} />
  }
  if (treeRoot && treeRoot.children.length > 0) {
    return <TreeView root={treeRoot} mermaidSrc={mermaid.data?.src} />
  }
  return (
    <Info>
      未找到工作流定义。请将 ReactFlow JSON 放置到 `assets/reactflow.json`，
      或加载包含 subagent 派发的 trace 文件。
    </Info>
  )
}

// ── ReactFlow DAG rendering ───────────────────────────────────

function ReactflowView({
  data,
  mermaidSrc,
}: {
  data: { name?: string; nodes?: RfNode[]; edges?: RfEdge[] }
  mermaidSrc?: string
}) {
  const nodes = data.nodes ?? []
  const edges = data.edges ?? []
  const maxDepth = estimateDagDepth(nodes, edges)
  const ordered = topologicalSort(nodes, edges)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const selected = ordered[Math.min(selectedIdx, Math.max(0, ordered.length - 1))]

  const summaryRows = nodes.map((n) => {
    const config = n.data?.agentConfig ?? {}
    const incoming = edges.filter((e) => e.target === n.id).length
    const outgoing = edges.filter((e) => e.source === n.id).length
    return {
      '节点': `${agentIcon(n.data?.title ?? n.id)} ${n.data?.title ?? n.id}`,
      '描述': (n.data?.description ?? '').slice(0, 60),
      '入度': incoming,
      '出度': outgoing,
      'Skills': (config.skills ?? []).length,
      'MCPs': (config.mcps ?? []).length,
    }
  })

  const nodeOptions = ordered.map((n) => `${agentIcon(n.data?.title ?? n.id)} ${n.data?.title ?? n.id}`)

  return (
    <div>
      <div className="metric-row">
        <div className="metric-card">
          <div className="m-title">🔀 {data.name ?? '工作流'}</div>
        </div>
        <div className="metric-card">
          <div className="m-title">Agent 节点</div>
          <div className="m-value">{nodes.length}</div>
        </div>
        <div className="metric-card">
          <div className="m-title">关键路径深度</div>
          <div className="m-value">{maxDepth}</div>
        </div>
      </div>

      {mermaidSrc && <MermaidView src={mermaidSrc} />}

      <hr />
      <Expander title={`📊 所有节点概览（${nodes.length} 节点 / ${edges.length} 边）`}>
        <DataTable rows={summaryRows} />
      </Expander>

      <hr />
      <Pills
        options={nodeOptions}
        selected={nodeOptions.length > 0 ? [nodeOptions[Math.min(selectedIdx, nodeOptions.length - 1)]] : []}
        onChange={(next) => {
          const idx = nodeOptions.indexOf(next[0])
          if (idx >= 0) setSelectedIdx(idx)
        }}
      />

      {selected && <NodeDetail node={selected} allNodes={nodes} edges={edges} />}
    </div>
  )
}

function NodeDetail({ node, allNodes, edges }: { node: RfNode; allNodes: RfNode[]; edges: RfEdge[] }) {
  const nodeData = node.data ?? {}
  const config = nodeData.agentConfig ?? {}
  const title = nodeData.title ?? node.id
  const desc = nodeData.description ?? ''
  const executor = config.executor ?? {}
  const cli = executor.agentCli ?? '—'
  const schema = config.schemaVersion ?? '—'
  const roleId = config.roleId ?? ''
  const roleShort = roleId.length > 12 ? `${roleId.slice(0, 12)}…` : roleId || '—'
  const skills = config.skills ?? []
  const mcps = config.mcps ?? []
  const incoming = edges.filter((e) => e.target === node.id)
  const outgoing = edges.filter((e) => e.source === node.id)

  const upstream = incoming
    .map((e) => {
      const src = allNodes.find((n) => n.id === e.source)
      return `${agentIcon(src?.data?.title ?? '')} ${src?.data?.title ?? e.source}`
    })
    .join('  →  ')
  const downstream = outgoing
    .map((e) => {
      const tgt = allNodes.find((n) => n.id === e.target)
      return `${agentIcon(tgt?.data?.title ?? '')} ${tgt?.data?.title ?? e.target}`
    })
    .join('  →  ')

  return (
    <div>
      <h3>{agentIcon(title)} {title}</h3>
      {desc && <p>{desc}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
        <span className="pill">📐 Schema v{schema}</span>
        <span className="pill">🖥️ CLI: {cli}</span>
        <span className="pill">🆔 Role: {roleShort}</span>
      </div>

      {(skills.length > 0 || mcps.length > 0) && (
        <>
          <hr />
          {skills.length > 0 && (
            <>
              <p><b>🔧 Skills</b></p>
              {skills.map((sk, i) => (
                <p key={i} style={{ fontSize: '0.9em' }}>
                  {sk.enabled ? '✅' : '❌'} <code>{(sk.skillId ?? '').slice(0, 24)}{(sk.skillId ?? '').length > 24 ? '…' : ''}</code>
                </p>
              ))}
            </>
          )}
          {mcps.length > 0 && (
            <>
              <p><b>🔌 MCP 服务</b></p>
              {mcps.map((m, i) => (
                <p key={i} style={{ fontSize: '0.9em' }}>
                  {m.enabled ? '✅' : '❌'} <code>{m.mcpId}</code>
                </p>
              ))}
            </>
          )}
        </>
      )}

      {config.prompt && (
        <Expander title="📝 Prompt">
          <pre className="debug-json">{config.prompt}</pre>
        </Expander>
      )}

      <hr />
      <p><b>⬆️ 上游依赖：</b> {upstream || <i>入口节点</i>}</p>
      <p><b>⬇️ 下游节点：</b> {downstream || <i>出口节点</i>}</p>
    </div>
  )
}

// ── Trace-extracted tree rendering ────────────────────────────

function TreeView({ root, mermaidSrc }: { root: WorkflowNode; mermaidSrc?: string }) {
  const allNodes = flattenTree(root)
  const totalSubs = allNodes.filter((n) => !n.is_root).length
  const completed = allNodes.filter((n) => n.state === 'completed').length
  const failed = allNodes.filter((n) => ['failed', 'error'].includes(n.state)).length
  const running = allNodes.filter((n) => n.state === 'running').length

  return (
    <div>
      <div className="metric-row">
        <div className="metric-card"><div className="m-title">Agent 总数</div><div className="m-value">{allNodes.length}</div></div>
        <div className="metric-card"><div className="m-title">Subagent 数</div><div className="m-value">{totalSubs}</div></div>
        <div className="metric-card"><div className="m-title">✅ 已完成</div><div className="m-value">{completed}</div></div>
        <div className="metric-card"><div className="m-title">❌ 失败 / ❓ 未知</div><div className="m-value">{failed + running}</div></div>
      </div>
      <hr />
      {allNodes.length >= 2 && mermaidSrc && (
        <>
          <h3>🔀 Agent 工作流图</h3>
          <MermaidView src={mermaidSrc} />
          <hr />
        </>
      )}
      <h3>📋 Agent 详情</h3>
      {allNodes.map((n, i) => (
        <AgentCard key={i} node={n} depth={depthOf(root, n)} />
      ))}
    </div>
  )
}

function depthOf(root: WorkflowNode, target: WorkflowNode, depth = 0): number {
  if (root.id === target.id) return depth
  for (const child of root.children) {
    const d = depthOf(child, target, depth + 1)
    if (d >= 0) return d
  }
  return -1
}

function AgentCard({ node, depth }: { node: WorkflowNode; depth: number }) {
  const state = STATE_COLORS[node.state] ?? STATE_COLORS.unknown
  const icon = agentIcon(node.name)
  const indentPx = Math.min(depth, 8) * 28

  const metaParts: string[] = []
  if (node.global_step) metaParts.push(`📍 Step ${node.global_step}`)
  if (node.duration_ms !== null && node.duration_ms !== undefined) {
    const ms = node.duration_ms
    metaParts.push(ms >= 1000 ? `⏱️ ${(ms / 1000).toFixed(1)}s` : `⏱️ ${ms.toFixed(0)}ms`)
  }
  if (node.tool_count) metaParts.push(`🔨 ${node.tool_count} 次工具调用`)
  if (node.input_tokens || node.output_tokens) {
    metaParts.push(`🎯 in:${fmtTok(node.input_tokens)} out:${fmtTok(node.output_tokens)}`)
  }
  if (node.children.length) metaParts.push(`👶 ${node.children.length} 个子 agent`)

  const maxTok = Math.max(node.output_tokens, ...node.children.map((c) => c.output_tokens)) || 1
  const pct = Math.min(100, (node.output_tokens / maxTok) * 100)

  return (
    <details
      className="step-card"
      open
      style={{
        background: state.bg,
        border: `1px solid ${state.border}30`,
        borderLeft: `4px solid ${state.border}`,
        margin: `6px 0 6px ${indentPx}px`,
      }}
    >
      <summary style={{ background: state.bg, color: state.text, borderLeft: 'none' }}>
        <span style={{ fontSize: '1.1em', marginRight: 4 }}>{icon}</span>
        <span className="title-text">{node.name || 'unnamed'}</span>
        {node.is_root && (
          <span className="badge" style={{ background: '#1e40af' }}>🏠 ROOT</span>
        )}
        <span className="badge" style={{ background: state.border }}>
          {state.icon} {state.label.toUpperCase()}
        </span>
      </summary>
      <div className="step-body">
        {node.description && (
          <div style={{ color: '#475569', fontSize: '0.85em', marginBottom: 8, lineHeight: 1.5 }}>
            📝 {node.description}
          </div>
        )}
        {metaParts.length > 0 && (
          <div style={{ fontSize: '0.78em', color: '#64748b', marginBottom: 8 }}>
            {metaParts.join(' · ')}
          </div>
        )}
        {node.id && node.id !== 'root' && (
          <div style={{ fontSize: '0.72em', color: '#94a3b8', marginBottom: 4 }}>
            🆔 {node.id.length > 24 ? `${node.id.slice(0, 24)}…` : node.id}
          </div>
        )}
        {!node.is_root && node.output_tokens > 0 && (
          <div style={{ marginTop: 6 }}>
            <span style={{ fontSize: '0.72em', color: '#94a3b8' }}>
              Output Tokens: {fmtTok(node.output_tokens)}
            </span>
            <div style={{ background: '#e2e8f0', borderRadius: 4, height: 6, marginTop: 2 }}>
              <div style={{ background: state.border, width: `${pct}%`, height: '100%', borderRadius: 4 }} />
            </div>
          </div>
        )}
      </div>
    </details>
  )
}
