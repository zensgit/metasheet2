import { defineConfig } from 'vitest/config'
import * as path from 'path'

/**
 * Isolated process for the tasks auth/RBAC gate (lock §5.2.1 ② / §12 gate 16).
 * Does not use tests/setup.integration.ts (that file sets RBAC_BYPASS /
 * RBAC_TOKEN_TRUST true and must not be weakened). setup.ts below sets both
 * flags false before the test file imports auth/RBAC. rbac.ts caches
 * RBAC_TOKEN_TRUST at module load (`src/rbac/rbac.ts:12`); AuthService.ts:171
 * is a call-time read — the two sites are not the same.
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
      'tests/tasks-auth/tasks-auth-gate.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 30000,
    hookTimeout: 15000,
    setupFiles: ['./tests/tasks-auth/setup.ts'],
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
