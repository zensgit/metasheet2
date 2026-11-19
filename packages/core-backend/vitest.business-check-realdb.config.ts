import { defineConfig } from 'vitest/config'

// Only the runner supplies the disposable database, isolated schema, and trust mode.
// No workspace setup file is loaded: it changes environment and removes fixture paths.
export default defineConfig({
  envDir: '../../tmp/permission-check/no-dotenv',
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['tests/integration/business-check-realdb.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    maxConcurrency: 1,
    globalSetup: [],
  },
})
