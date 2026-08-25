// Landing page — hero + four mode cards (mirrors legacy app.py).
// Card CTA texts are load-bearing: e2e.mjs clicks them by text.

import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'

const GLYPH_PROPS = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const CARDS: {
  to: string
  title: string
  desc: string
  cta: string
  glyph: ReactNode
}[] = [
  {
    to: '/opencode',
    title: 'Opencode',
    desc: 'trace-logger 生成的 `.ndjson` 文件',
    cta: 'Opencode 可视化',
    glyph: (
      <svg {...GLYPH_PROPS}>
        <rect x="3" y="4.5" width="7" height="3.5" rx="1.6" />
        <rect x="13.5" y="10.25" width="7.5" height="3.5" rx="1.6" />
        <rect x="6.5" y="16" width="5.5" height="3.5" rx="1.6" />
      </svg>
    ),
  },
  {
    to: '/gemini',
    title: 'Gemini CLI',
    desc: '`GEMINI_TELEMETRY_TRACES_ENABLED` 生成的 telemetry.log',
    cta: 'Gemini CLI 可视化',
    glyph: (
      <svg {...GLYPH_PROPS}>
        <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5z" />
      </svg>
    ),
  },
  {
    to: '/claude-code',
    title: 'Claude Code',
    desc: '`--output-format stream-json` 生成的流式 NDJSON',
    cta: 'Claude Code 可视化',
    glyph: (
      <svg {...GLYPH_PROPS}>
        <path d="M12 4.5v15M4.7 7.3l14.6 9.4M19.3 7.3L4.7 16.7" />
      </svg>
    ),
  },
  {
    to: '/compare',
    title: '对比模式',
    desc: '加载两份 trace 进行 A/B Token 消耗对比',
    cta: 'Token 对比分析',
    glyph: (
      <svg {...GLYPH_PROPS}>
        <path d="M8 17V9.5M16 17V6.5M13.2 9.5l2.8-3 2.8 3" />
      </svg>
    ),
  },
]

export default function Landing() {
  return (
    <div className="landing" id="main">
      <header className="landing-hero">
        <p className="landing-eyebrow">Ora Space · Agent Telemetry</p>
        <h1>Trace Visualizer</h1>
        <p className="landing-sub">
          选择要分析的日志格式。上传一份 agent 会话 trace，浏览每个事件、Token 消耗与工具调用。
        </p>
      </header>
      <div className="mode-cards">
        {CARDS.map((c) => (
          <Link key={c.to} className="mode-card" to={c.to}>
            <span className="mode-glyph">{c.glyph}</span>
            <h2 className="mode-title">{c.title}</h2>
            <p className="mode-desc">{c.desc}</p>
            <span className="mode-cta">{c.cta}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
