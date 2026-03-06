import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { resolve } from 'path'

function resolveManualChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) {
    return undefined
  }

  if (
    id.includes('/vue/') ||
    id.includes('/vue-router/') ||
    id.includes('/pinia/')
  ) {
    return 'vue-vendor'
  }

  if (
    id.includes('/element-plus/') ||
    id.includes('/@element-plus/')
  ) {
    return 'element-plus'
  }

  if (
    id.includes('/bpmn-js/') ||
    id.includes('/diagram-js/') ||
    id.includes('/bpmn-moddle/') ||
    id.includes('/moddle/') ||
    id.includes('/min-dash/') ||
    id.includes('/tiny-svg/') ||
    id.includes('/ids/')
  ) {
    return 'bpmn'
  }

  if (
    id.includes('/xlsx/') ||
    id.includes('/file-saver/') ||
    id.includes('/x-data-spreadsheet/')
  ) {
    return 'office'
  }

  if (id.includes('/axios/')) {
    return 'http'
  }

  return 'vendor'
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_URL || env.VITE_API_BASE || 'http://127.0.0.1:7778'
  const portValue = Number(env.VITE_PORT)
  const serverPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 8899
  const isTest = mode === 'test'

  const devServerConfig = isTest
    ? undefined
    : {
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
      }

  return {
    plugins: [
      vue(),
      AutoImport({
        dts: resolve(__dirname, 'src/auto-imports.d.ts'),
        resolvers: [
          ElementPlusResolver({
            importStyle: 'css',
          }),
        ],
      }),
      Components({
        dts: resolve(__dirname, 'src/components.d.ts'),
        resolvers: [
          ElementPlusResolver({
            importStyle: 'css',
          }),
        ],
      }),
    ],
    server: devServerConfig,
    build: {
      rollupOptions: {
        output: {
          manualChunks: resolveManualChunk
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    test: {
      environment: 'jsdom'
    }
  }
})
