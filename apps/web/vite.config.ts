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
    test: {
      environment: 'jsdom'
    }
  }
})
