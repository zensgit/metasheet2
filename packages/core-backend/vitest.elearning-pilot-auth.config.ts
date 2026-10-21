import { defineConfig } from 'vitest/config'
import * as path from 'path'

/**
 * Isolated process for the e-learning V0.1 auth/tenant/RBAC gate.
 * Does not use tests/setup.integration.ts (that file sets RBAC_BYPASS /
 * RBAC_TOKEN_TRUST true and must not be weakened). setup.ts below sets both
 * flags false before the test file imports auth/RBAC/runtime.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    deps: {
      interopDefault: true,
    },
    include: [
      'tests/elearning-pilot-auth/elearning-pilot-auth-gate.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 30000,
    hookTimeout: 15000,
    setupFiles: ['./tests/elearning-pilot-auth/setup.ts'],
    env: {
      RBAC_BYPASS: 'false',
      RBAC_TOKEN_TRUST: 'false',
      PRODUCT_MODE: 'plm-workbench',
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
