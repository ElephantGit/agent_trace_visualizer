// Original replay card presentation: category styling, tool metadata and bounded content previews.

import type { CategoryStyle, ReplayStep } from '../api/types'

const CONTENT_MAX_LENGTH = 500
const FOLD_THRESHOLD = 300

export default function ReplayStepCard({ step, style, phase }: { step: ReplayStep; style?: CategoryStyle; phase?: string }) {
  const palette = style ?? {
    label: '用户', icon: '👤', bg: '#f8fafc', header_bg: '#e2e8f0', border: '#94a3b8', text: '#334155',
  }
  const contentLength = step.content.length
  const needsFold = contentLength > FOLD_THRESHOLD
  const defaultOpen = !needsFold && phase !== 'thinking' && phase !== 'tools'
  const tooLarge = contentLength > CONTENT_MAX_LENGTH
  const toolName = step.detail.tool_name as string | undefined
  const toolInput = step.detail.tool_input as Record<string, unknown> | undefined
  const meta: string[] = []
  const inputTokens = step.detail.input_tokens as number | undefined
  const outputTokens = step.detail.output_tokens as number | undefined
  if (inputTokens || outputTokens) meta.push(`🎯 in=${inputTokens || '—'} out=${outputTokens || '—'}`)
  if (Number(step.detail.duration_ms) > 0) {
    const duration = Number(step.detail.duration_ms)
    meta.push(duration >= 1000 ? `⏱️ ${(duration / 1000).toFixed(1)}s` : `⏱️ ${duration.toFixed(0)}ms`)
  }
  if (step.detail.model) meta.push(`🧩 ${String(step.detail.model)}`)
  if (step.detail.file_path) meta.push(`📁 ${String(step.detail.file_path)}`)

  const content = !step.content ? null : tooLarge ? (
    <>
      <span className="content-text">{step.content.slice(0, 200)}…</span>
      <div className="muted" style={{ marginTop: 4, fontSize: '0.78em' }}>
        ⚠️ 内容过长（{contentLength.toLocaleString('en-US')} 字符），请在「原始数据」查看完整内容
      </div>
    </>
  ) : needsFold ? (
    <>
      <span className="content-text">{step.content.slice(0, 150)}…</span>
      <details className="step-fold">
        <summary className="step-fold-summary" style={{ color: palette.border }}>
          📝 展开全部内容 ({contentLength} 字符)
        </summary>
        <div className="content-text step-fold-content">{step.content}</div>
      </details>
    </>
  ) : <div className="content-text">{step.content}</div>

  return (
    <details className={`step-card ${phase ? `step-phase-${phase}` : ''}`} open={defaultOpen} style={{ background: palette.bg, border: `1px solid ${palette.border}20` }}>
      <summary style={{ background: palette.header_bg, color: palette.text, borderLeftColor: palette.border }}>
        <span style={{ color: palette.border, marginRight: 6, fontSize: '1.1em' }}>{palette.icon}</span>
        <span className="seq-no" style={{ color: '#94a3b8' }}>#{step.seq}</span>
        <span className="title-text">{step.title.slice(0, 100)}{step.is_error ? ' ❌' : ''}</span>
        {['subagent', 'skill', 'mcp'].includes(step.category) && (
          <span className="badge" style={{ background: palette.border }}>{palette.icon} {palette.label.toUpperCase()}</span>
        )}
        {Number(step.detail.duration_ms) > 0 && <span className="micro-tag">⏱️{Number(step.detail.duration_ms).toFixed(0)}ms</span>}
        {Number(step.detail.output_tokens) > 0 && <span className="micro-tag">🎯{String(step.detail.output_tokens)}tok</span>}
        <span className="fold-toggle">{needsFold ? '展开 ▼' : ''}</span>
      </summary>
      <div className="step-body">
        {(toolName || (toolInput && Object.keys(toolInput).length > 0)) && (
          <div className="step-tool-row">
            {toolName && <span className="step-tool-name">🔧 {toolName}</span>}
            {toolInput && Object.keys(toolInput).length > 0 && (
              <details className="step-fold">
                <summary className="step-fold-summary" style={{ color: palette.border }}>📥 输入参数</summary>
                <pre className="step-tool-pre">{JSON.stringify(toolInput, null, 2).slice(0, 2000)}</pre>
              </details>
            )}
          </div>
        )}
        {meta.length > 0 && <div className="step-meta">{meta.join(' · ')}</div>}
        {content}
        {step.is_error && <div className="step-error-box">⚠️ 此步骤执行出错</div>}
      </div>
    </details>
  )
}
