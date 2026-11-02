import { defineConfig } from 'vitest/config'
import * as path from 'path'

/**
 * Isolated process for the tasks enablement walk, with token-claim trust off. Does not use
 * tests/setup.integration.ts, which turns that trust on before any import.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    deps: { interopDefault: true },
    include: ['tests/integration/task-enablement-http.db.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 120000,
    setupFiles: ['./tests/tasks-enablement/setup.ts'],
    env: {
      RBAC_BYPASS: 'false',
      RBAC_TOKEN_TRUST: 'false',
      RBAC_OPTIONAL: '',
      TASKS_ENABLED: 'true',
    },
    reporter: ['verbose'],
    fileParallelism: false,
    maxConcurrency: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
})
