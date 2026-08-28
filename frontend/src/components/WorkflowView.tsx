// Workflow DAG view — ReactFlow JSON preferred, trace-extracted tree as
// fallback (mirrors legacy views/workflow.py).

import { useMemo } from 'react'
import type { ParseResult, WorkflowNode } from '../api/types'
import { useMermaid, useWorkflowTree } from '../hooks'
import MermaidView from './MermaidView'
import { Info } from './ui/primitives'
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
  completed: { bg: 'var(--ok-soft)', border: '#0a9e6a', text: '#166534', icon: '✅', label: '已完成' },
  failed: { bg: 'var(--bad-soft)', border: '#ea4335', text: '#991b1b', icon: '❌', label: '失败' },
  error: { bg: 'var(--bad-soft)', border: '#ea4335', text: '#991b1b', icon: '❌', label: '出错' },
  running: { bg: 'var(--warn-soft)', border: '#fbbf24', text: '#92400e', icon: '⏳', label: '进行中' },
  unknown: { bg: '#f8fafc', border: '#94a3b8', text: '#475569', icon: '❓', label: '未知' },
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
  const mermaidReq = useMemo(() => {
    if (result) {
      return { kind: 'workflow-tree', result }
    }
    return null
  }, [result])
  const mermaid = useMermaid(mermaidReq ?? { kind: 'workflow-tree' })
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
