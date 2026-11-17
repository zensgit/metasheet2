import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import * as path from 'path'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(packageRoot, '..', '..')

/**
 * Trust-off process for the Chromium permission-page lifecycle.
 * Does not load tests/setup.integration.ts. envDir points at an empty-of-dotenv
 * artifact directory so a developer .env is not applied.
 */
export default defineConfig({
  envDir: path.join(repoRoot, 'artifacts', 'permission-browser-grok'),
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    deps: {
      interopDefault: true,
    },
    include: [
      'tests/integration/permission-browser-realdb.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 180000,
    hookTimeout: 180000,
    setupFiles: ['./tests/utils/permission-browser-setup.ts'],
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
