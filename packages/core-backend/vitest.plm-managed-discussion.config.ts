import { defineConfig } from 'vitest/config'
export default defineConfig({ test: {
  include: ['tests/integration/plm-managed-discussion-pg.realdb.ts'], environment: 'node',
  pool: 'forks', fileParallelism: false, testTimeout: 20000, hookTimeout: 30000,
} })
