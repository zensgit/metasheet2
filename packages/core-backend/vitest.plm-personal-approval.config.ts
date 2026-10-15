import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/integration/plm-personal-approval-realdb.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
})
