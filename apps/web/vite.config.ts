import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_URL || env.VITE_API_BASE || 'http://127.0.0.1:7778'
  const portValue = Number(env.VITE_PORT)
  const serverPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 8899

  return {
    plugins: [vue()],
    server: {
      port: serverPort,
      host: true,
      cors: true,
      proxy: {
        '/api': {
          target: apiBase,
          changeOrigin: true,
          ws: true
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (
              id.includes('bpmn-js')
            ) {
              return 'workflow-bpmn-js'
            }
            if (
              id.includes('diagram-js') ||
              id.includes('@bpmn-io+diagram-js-ui')
            ) {
              return 'workflow-diagram-js'
            }
            if (
              id.includes('bpmn-moddle') ||
              id.includes('moddle-xml') ||
              id.includes('/moddle@')
            ) {
              return 'workflow-moddle'
            }
            if (
              id.includes('min-dash') ||
              id.includes('min-dom') ||
              id.includes('tiny-svg') ||
              id.includes('ids') ||
              id.includes('path-intersection') ||
              id.includes('tiny-emitter')
            ) {
              return 'workflow-bpmn-vendor'
            }
            if (id.includes('xlsx') || id.includes('file-saver')) {
              return 'vendor-export'
            }
            if (id.includes('element-plus') || id.includes('@element-plus')) {
              return 'vendor-element-plus'
            }
            if (id.includes('vue') || id.includes('pinia') || id.includes('vue-router')) {
              return 'vendor-vue'
            }
          },
        },
      },
    },
    test: {
      environment: 'jsdom'
    }
  }
})
