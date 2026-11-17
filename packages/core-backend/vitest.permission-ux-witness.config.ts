import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import * as path from 'path'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))

/**
 * Trust-off process for the include_children privilege-witness real-PG spec.
 * Does not load tests/setup.integration.ts (that file sets RBAC_TOKEN_TRUST true).
 * The setup file applies the false flags before the spec imports the privilege reader.
 * Codex runs this against its isolated PG16. It does not reset a database.
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
      'tests/integration/permission-ux-scope-witness.db.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['./tests/utils/permission-ux-scope-witness-setup.ts'],
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
