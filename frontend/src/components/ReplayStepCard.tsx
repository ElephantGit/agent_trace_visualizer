// One replay step card — mirrors the legacy `_build_step_card` HTML:
// 11 color-coded categories, subagent/skill/mcp badges, micro tags,
// three truncation tiers (inline / folded / preview-only at 500 chars).

import type { CategoryStyle, ReplayStep } from '../api/types'

const CONTENT_MAX_LENGTH = 500
const FOLD_THRESHOLD = 300

export default function ReplayStepCard({
  step,
  style,
}: {
  step: ReplayStep
  style?: CategoryStyle
}) {
  const s = style ?? {
    label: '用户',
    icon: '👤',
    bg: '#f8fafc',
    header_bg: '#e2e8f0',
    border: '#94a3b8',
    text: '#334155',
  }

  const contentLen = step.content.length
  const needsFold = contentLen > FOLD_THRESHOLD
  const tooLarge = contentLen > CONTENT_MAX_LENGTH

  const badge = ['subagent', 'skill', 'mcp'].includes(step.category) && (
    <span className="badge" style={{ background: s.border }}>
      {s.icon} {s.label.toUpperCase()}
    </span>
  )

  const microTags = (
    <>
      {Number(step.detail.duration_ms) > 0 && (
        <span className="micro-tag">
          ⏱️
          {Number(step.detail.duration_ms) >= 1000
            ? `${(Number(step.detail.duration_ms) / 1000).toFixed(1)}s`
            : `${Number(step.detail.duration_ms).toFixed(0)}ms`}
        </span>
      )}
      {Number(step.detail.output_tokens) > 0 && (
        <span className="micro-tag">🎯{String(step.detail.output_tokens)}tok</span>
      )}
    </>
  )

  const toolName = step.detail.tool_name as string | undefined
  const toolInput = step.detail.tool_input as Record<string, unknown> | undefined
  const metaParts: string[] = []
  const inTok = step.detail.input_tokens as number | undefined
  const outTok = step.detail.output_tokens as number | undefined
  if (inTok || outTok) metaParts.push(`🎯 in=${inTok || '—'}  out=${outTok || '—'}`)
  if (Number(step.detail.duration_ms) > 0) {
    const ms = Number(step.detail.duration_ms)
    metaParts.push(ms >= 1000 ? `⏱️ ${(ms / 1000).toFixed(1)}s` : `⏱️ ${ms.toFixed(0)}ms`)
  }
  if (step.detail.model) metaParts.push(`🧩 ${String(step.detail.model)}`)
  if (step.detail.file_path) metaParts.push(`📁 ${String(step.detail.file_path)}`)

  const content = (() => {
    if (!step.content) return null
    if (tooLarge) {
      return (
        <>
          <span className="content-text">{step.content.slice(0, 200)}…</span>
          <div className="muted" style={{ marginTop: 4, fontSize: '0.78em' }}>
            ⚠️ 内容过长（{contentLen.toLocaleString('en-US')} 字符），请在「原始数据」Tab 查看完整内容
          </div>
        </>
      )
    }
    if (contentLen > FOLD_THRESHOLD) {
      return (
        <>
          <span className="content-text">{step.content.slice(0, 150)}…</span>
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', color: s.border, fontSize: '0.82em' }}>
              📝 展开全部内容 ({contentLen} 字符)
            </summary>
            <div
              className="content-text"
              style={{
                marginTop: 6,
                padding: 10,
                background: '#f8fafc',
                borderRadius: 4,
                maxHeight: 400,
                overflowY: 'auto',
              }}
            >
              {step.content}
            </div>
          </details>
        </>
      )
    }
    return <div className="content-text">{step.content}</div>
  })()

  return (
    <details className="step-card" open={!needsFold} style={{ background: s.bg, border: `1px solid ${s.border}20` }}>
      <summary style={{ background: s.header_bg, color: s.text, borderLeftColor: s.border }}>
        <span style={{ color: s.border, marginRight: 6, fontSize: '1.1em' }}>{s.icon}</span>
        <span className="seq-no" style={{ color: '#94a3b8' }}>#{step.seq}</span>
        <span className="title-text">
          {step.title.slice(0, 100)}
          {step.is_error ? ' ❌' : ''}
        </span>
        {badge}
        {microTags}
        <span className="fold-toggle">{needsFold ? '展开 ▼' : ''}</span>
      </summary>
      <div className="step-body">
        {(toolName || (toolInput && Object.keys(toolInput).length > 0)) && (
          <div style={{ marginBottom: 8, fontSize: '0.85em', color: '#64748b' }}>
            {toolName && <span style={{ fontWeight: 600 }}>🔧 {toolName}</span>}
            {toolInput && Object.keys(toolInput).length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', color: s.border, fontSize: '0.88em' }}>
                  📥 输入参数
                </summary>
                <pre
                  style={{
                    background: '#f1f5f9',
                    padding: 8,
                    borderRadius: 4,
                    overflowX: 'auto',
                    fontSize: '0.78em',
                    marginTop: 4,
                    maxHeight: 200,
                  }}
                >
                  {JSON.stringify(toolInput, null, 2).slice(0, 2000) +
                    (JSON.stringify(toolInput, null, 2).length > 2000 ? '\n… (输入过长，已截断)' : '')}
                </pre>
              </details>
            )}
          </div>
        )}

        {metaParts.length > 0 && (
          <div style={{ fontSize: '0.78em', color: '#94a3b8', marginBottom: 8 }}>
            {metaParts.join(' · ')}
          </div>
        )}

        {content}

        {step.is_error && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              background: '#fef2f2',
              borderRadius: 4,
              color: '#991b1b',
              fontSize: '0.82em',
            }}
          >
            ⚠️ 此步骤执行出错
          </div>
        )}
      </div>
    </details>
  )
}
