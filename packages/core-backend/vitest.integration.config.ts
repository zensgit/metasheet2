import { defineConfig } from 'vitest/config'
import * as path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    deps: {
      interopDefault: true,
    },
    include: [
      'tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 30000,
    hookTimeout: 15000,
    setupFiles: ['./tests/setup.integration.ts'],
    reporter: ['verbose'],
    // Integration specs share one real Postgres and several org-global settings rows.
    // Run files serially so route-level tests that temporarily change settings cannot
    // bleed into another file's server process while it is asserting default behavior.
    fileParallelism: false,
    maxConcurrency: 1,
    globalTeardown: './tests/globalTeardown.ts',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
})
