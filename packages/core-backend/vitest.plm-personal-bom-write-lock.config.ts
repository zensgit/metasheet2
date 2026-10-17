import { defineConfig } from 'vitest/config'

if (process.env.EXPECT_PLM_PERSONAL_BOM_WRITE_DB !== '1' || !process.env.PLM_PERSONAL_BOM_WRITE_TEST_PG_URL)
  throw new Error('Explicit disposable personal BOM PostgreSQL URL and execution gate required')

/** Whole-file lock/restart gate. Missing or skipped PostgreSQL execution is a failure. */
export default defineConfig({
  test: {
    include: ['tests/integration/plm-personal-bom-write-lock-pg.realdb.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 20000,
    hookTimeout: 20000,
    env: { PLM_BOM_LOCK_PG_REQUIRED: 'true' },
  },
})
