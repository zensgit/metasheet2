import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import * as path from 'path'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(packageRoot, '..', '..')

/**
 * Trust-off process for source-aware legacy permission removal.
 * Does not load tests/setup.integration.ts. envDir avoids a developer .env.
 */
export default defineConfig({
  envDir: path.join(repoRoot, 'artifacts', 'permission-ux'),
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    deps: {
      interopDefault: true,
    },
    include: [
      'tests/integration/permission-ux-legacy.db.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['./tests/utils/permission-ux-legacy-setup.ts'],
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
