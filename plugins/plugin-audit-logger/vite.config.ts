import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'PluginAuditLogger',
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
      formats: ['es']
    },
    rollupOptions: {
      external: ['@metasheet/core-backend'],
      output: {
        globals: {
          '@metasheet/core-backend': 'MetasheetCore'
        }
      }
    }
  }
})