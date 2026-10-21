import { defineConfig } from 'vitest/config'
import * as path from 'path'

/**
 * Isolated process for the tasks auth gate. Does not use
 * tests/setup.integration.ts.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    deps: { interopDefault: true },
    include: ['tests/tasks-auth/tasks-auth-gate.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 15000,
    setupFiles: ['./tests/tasks-auth/setup.ts'],
    env: {
      RBAC_BYPASS: 'false',
      RBAC_TOKEN_TRUST: 'false',
      PRODUCT_MODE: 'plm-workbench',
      RBAC_OPTIONAL: '',
      TASKS_ENABLED: 'true',
    },
    reporter: ['verbose'],
    fileParallelism: false,
    maxConcurrency: 1,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
