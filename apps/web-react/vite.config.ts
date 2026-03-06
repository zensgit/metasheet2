import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function resolveManualChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) {
    return undefined
  }

  if (
    id.includes('/react/') ||
    id.includes('/react-dom/') ||
    id.includes('/scheduler/')
  ) {
    return 'react-vendor'
  }

  const univerMatch = id.match(/@univerjs\/([^/]+)/)
  if (univerMatch) {
    return `univer-${univerMatch[1]}`
  }

  return 'vendor'
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7778',
        changeOrigin: true
      }
    }
  },
  build: {
    // Univer's render engine currently ships a monolithic ES entry (~6 MB before minification),
    // so the default Vite 500 kB warning is not actionable for this POC after manual chunking.
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks: resolveManualChunk
      }
    }
  }
})
