// App shell: router + embedded-mode dispatch (mirrors legacy app.py).
// Query params keep the Ora iframe contract:
//   ?session_id=<oraSessionId>&agent_type=<opencode|claude_code>
//   ?app_mode=compare   (camelCase variants also honored)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import Landing from './pages/Landing'
import EmbeddedView from './pages/EmbeddedView'
import CompareView from './pages/compare/CompareView'
import OpencodeView from './pages/opencode/OpencodeView'
import ClaudeCodeView from './pages/claude/ClaudeCodeView'
import GeminiView from './pages/gemini/GeminiView'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
})

function Root() {
  const [params] = useSearchParams()
  const sessionId = params.get('session_id') ?? params.get('sessionId')
  const agentType = params.get('agent_type') ?? params.get('agentType')
  const appMode = params.get('app_mode') ?? params.get('appMode')

  if (sessionId && agentType) {
    return <EmbeddedView sessionId={sessionId} agentType={agentType} />
  }
  if (appMode === 'compare') {
    return <CompareView />
  }
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/opencode" element={<OpencodeView />} />
      <Route path="/claude-code" element={<ClaudeCodeView />} />
      <Route path="/gemini" element={<GeminiView />} />
      <Route path="/compare" element={<CompareView />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  )
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
