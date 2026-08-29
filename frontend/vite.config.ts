import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // 插件包由宿主从 assets/ 精确文件服务（无 SPA fallback），
  // 资产引用必须相对、路由用 HashRouter。
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    // Dev: forward API calls to the Rust backend (127.0.0.1:8601 — the same
    // port the legacy Streamlit app used, kept for the Ora iframe contract).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8601',
        changeOrigin: false,
      },
    },
  },
  build: {
    // Keep the heavy chart/diagram libraries out of the initial bundle.
    rolldownOptions: {
      output: {
        manualChunks: (moduleId: string) => {
          if (moduleId.includes('node_modules/plotly.js') || moduleId.includes('react-plotly.js')) {
            return 'plotly'
          }
          if (moduleId.includes('node_modules/mermaid')) {
            return 'mermaid'
          }
          if (moduleId.includes('node_modules/react') || moduleId.includes('node_modules/scheduler')) {
            return 'react'
          }
          return null
        },
      },
    },
  },
})
