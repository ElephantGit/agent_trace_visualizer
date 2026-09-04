import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Workbench assets are served from the plugin package rather than a web server.
  base: './',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../plugin/assets',
    emptyOutDir: true,
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
