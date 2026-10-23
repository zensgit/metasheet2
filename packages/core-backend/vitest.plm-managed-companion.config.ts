import { defineConfig } from 'vitest/config'

if (!process.env.PLM_MANAGED_COMPANION_TEST_PG_URL) {
  throw new Error('Explicit disposable managed-companion PostgreSQL URL required')
}

/** Missing or skipped PostgreSQL execution is a failure. */
export default defineConfig({
  test: {
    include: [
      'tests/integration/plm-managed-companion-pg.realdb.ts',
      'tests/integration/plm-managed-continuous-completion-pg.realdb.ts',
      'tests/integration/plm-managed-renewal-recovery-pg.realdb.ts',
      'tests/integration/plm-managed-embed-pg.realdb.ts',
    ],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    retry: 0,
    passWithNoTests: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: [],
    env: {
      PLM_MANAGED_COMPANION_PG_REQUIRED: 'true',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DB_POOL_MIN: '0',
      DB_POOL_MAX: '8',
    },
  },
})
