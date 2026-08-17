// Landing page — the four mode cards (mirrors legacy app.py).

import { Link } from 'react-router-dom'

const CARDS = [
  {
    to: '/opencode',
    title: 'Opencode',
    desc: 'trace-logger 生成的 `.ndjson` 文件',
    button: 'Opencode 可视化',
  },
  {
    to: '/gemini',
    title: 'Gemini CLI',
    desc: '`GEMINI_TELEMETRY_TRACES_ENABLED` 生成的 telemetry.log',
    button: 'Gemini CLI 可视化',
  },
  {
    to: '/claude-code',
    title: 'Claude Code',
    desc: '`--output-format stream-json` 生成的流式 NDJSON',
    button: 'Claude Code 可视化',
  },
  {
    to: '/compare',
    title: '📊 对比模式',
    desc: '加载两份 trace 进行 A/B Token 消耗对比',
    button: 'Token 对比分析',
  },
]

export default function Landing() {
  return (
    <div className="landing">
      <h1>Trace Visualizer</h1>
      <p className="muted">选择要分析的日志格式</p>
      <hr />
      <div className="mode-cards">
        {CARDS.map((c) => (
          <div key={c.to} className="mode-card">
            <h4>{c.title}</h4>
            <p className="muted">{c.desc}</p>
            <Link className="btn btn-primary" to={c.to}>
              {c.button}
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}
