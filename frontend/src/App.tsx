// App shell: router + embedded-mode dispatch (mirrors legacy app.py).
// Query params keep the Ora iframe contract:
//   ?session_id=<oraSessionId>&agent_type=<opencode|claude_code>
//   ?app_mode=compare   (camelCase variants also honored)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Landing from './pages/Landing'
import CompareView from './pages/compare/CompareView'
import OpencodeView from './pages/opencode/OpencodeView'
import ClaudeCodeView from './pages/claude/ClaudeCodeView'
import TrajectoryView from './pages/TrajectoryView'
import { api } from './api/client'
import { ErrorBanner } from './components/ui/primitives'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
})

function Root() {
  const [params] = useSearchParams()
  const appMode = params.get('app_mode') ?? params.get('appMode')

  if (appMode === 'compare') {
    return <CompareView />
  }
  return (
    <Routes>
      {/* Opening from Ora always starts with the host-selected session's live monitor. */}
      <Route path="/" element={<CurrentSessionView />} />
      <Route path="/landing" element={<Landing />} />
      <Route path="/opencode" element={<OpencodeView />} />
      <Route path="/claude-code" element={<ClaudeCodeView />} />
      <Route path="/trajectory" element={<TrajectoryView />} />
      <Route path="/compare" element={<CompareView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function CurrentSessionView() {
  const currentTrace = useQuery({
    queryKey: ['current-session-trace'],
    queryFn: () => api.currentTrace(),
    retry: false,
  })
  if (currentTrace.isLoading) return <p className="muted">正在加载当前会话的 Dashboard…</p>
  if (currentTrace.error || !currentTrace.data) {
    return (
      <div className="page" style={{ padding: 24 }}>
        <ErrorBanner>
          无法打开当前会话的实时监控：
          {currentTrace.error instanceof Error ? currentTrace.error.message : String(currentTrace.error)}
        </ErrorBanner>
      </div>
    )
  }
  const current = currentTrace.data
  if (current.agent === 'opencode') return <OpencodeView initialLivePath={current.path} />
  return <ClaudeCodeView initialLivePath={current.path} />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
