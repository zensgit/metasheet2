import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { defineConfig } from 'vitest/config'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))

// These suites exercise database authority. The general integration setup enables
// token trust before RBAC is imported, so changing the flag in beforeAll is too late.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    deps: { interopDefault: true },
    include: [
      'tests/integration/admin-user-batch-review.db.test.ts',
      'tests/integration/admin-user-recycle-review.db.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['./tests/utils/permission-lifecycle-setup.ts'],
    env: {
      EXPECT_DB: '1',
      RBAC_BYPASS: 'false',
      RBAC_TOKEN_TRUST: 'false',
      PRODUCT_MODE: 'plm-workbench',
    },
    reporters: ['verbose'],
    fileParallelism: false,
    maxConcurrency: 1,
    globalSetup: [],
  },
  resolve: {
    alias: {
      '@': path.resolve(packageRoot, './src'),
      '@tests': path.resolve(packageRoot, './tests'),
    },
  },
})
