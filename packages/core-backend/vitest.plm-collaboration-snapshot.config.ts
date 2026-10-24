import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: [
      'tests/integration/plm-collaboration-snapshot-db-guards.realdb.test.ts',
      'tests/integration/plm-collaboration-snapshot-service.realdb.test.ts',
      'tests/integration/plm-collaboration-readiness-snapshot.realdb.test.ts',
    ],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120000,
    hookTimeout: 120000,
  },
})
