import { defineConfig } from 'vitest/config'
import * as path from 'path'

process.env.SKIP_PLUGINS = process.env.SKIP_PLUGINS ?? 'true'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Align with unit config while allowing integration tests to run.
    pool: 'forks',
    deps: {
      interopDefault: true
    },
    include: ['tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
    hookTimeout: 30000,
    setupFiles: ['./tests/setup.integration.ts'],
    reporter: ['verbose'],
    maxConcurrency: 1,
    globalTeardown: './tests/globalTeardown.ts'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests')
    }
  }
})
