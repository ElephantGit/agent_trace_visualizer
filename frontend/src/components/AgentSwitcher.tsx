// Agent 切换器——固定在各可视化页面左下角，快速在三个 agent 之间切换
// （原入口在 landing 页，现下沉到每个页面）。

import { Link, useLocation } from 'react-router-dom'

const AGENTS = [
  { path: '/claude-code', label: 'Claude Code', icon: '🤖' },
  { path: '/opencode', label: 'Opencode', icon: '⚡' },
  { path: '/gemini', label: 'Gemini', icon: '💎' },
] as const

export default function AgentSwitcher() {
  const { pathname } = useLocation()
  return (
    <nav className="agent-switcher" aria-label="切换 agent 可视化">
      {AGENTS.map((a) => (
        <Link
          key={a.path}
          to={a.path}
          className={`agent-switch-btn ${pathname === a.path ? 'agent-switch-active' : ''}`}
          title={`切换到 ${a.label} 可视化`}
        >
          <span className="agent-switch-icon">{a.icon}</span>
          <span className="agent-switch-label">{a.label}</span>
        </Link>
      ))}
    </nav>
  )
}
