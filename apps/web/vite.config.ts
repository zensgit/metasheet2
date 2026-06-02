import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

/**
 * Resolve the Vite `base` (public path) from VITE_BASE_PATH so the app can be deployed under a
 * sub-path (e.g. behind nginx at `/metasheet/`) without the built index.html referencing
 * `/assets/...` at the domain root. Defaults to `/` (root deploy — unchanged). Normalized to a
 * leading + trailing slash, which is what Vite expects.
 */
function resolveBasePath(raw?: string): string {
  const value = (raw || '').trim()
  if (!value || value === '/') return '/'
  // Preserve Vite-compatible full-URL (CDN) and relative bases; only ensure a trailing slash.
  if (/^https?:\/\//i.test(value) || value.startsWith('./') || value.startsWith('../')) {
    return value.endsWith('/') ? value : `${value}/`
  }
  // Path-only base (the common sub-path case): normalize to a leading + trailing slash.
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = process.env.METASHEET_ENV_DIR?.trim() || process.cwd()
  const env = loadEnv(mode, envDir, '')
  const apiBase = env.VITE_API_URL || env.VITE_API_BASE || 'http://127.0.0.1:7778'
  const portValue = Number(env.VITE_PORT)
  const serverPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 8899
  const basePath = resolveBasePath(env.VITE_BASE_PATH)

  return {
    envDir,
    base: basePath,
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
      environment: 'jsdom',
      // jsdom's default about:blank origin yields a non-functional
      // localStorage ({} without methods). This setup file installs an
      // in-memory Storage polyfill (at load + per test). See
      // docs/development/web-test-jsdom-localstorage-baseline-fix-20260519.md
      setupFiles: ['./tests/setup/localstorage.ts']
    }
  }
})
