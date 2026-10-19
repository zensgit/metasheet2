import { defineConfig } from 'vitest/config'
export default defineConfig({ test: {
  include: ['tests/integration/plm-snapshot-share-pg.realdb.ts'], environment: 'node',
  pool: 'forks', fileParallelism: false, testTimeout: 15000, hookTimeout: 30000,
} })
