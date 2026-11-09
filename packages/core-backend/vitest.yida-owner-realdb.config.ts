import { defineConfig } from 'vitest/config'

// A fresh native Node graph is essential: AuthService captures its scoped pool
// on import. Never combine this with the older synthetic authority fixtures or
// the general integration setup's permissive RBAC environment.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: false, isolate: true, execArgv: ['--import', 'tsx'] } },
    fileParallelism: false,
    maxConcurrency: 1,
    include: [
      'tests/integration/yida-initialization-runtime-realdb.test.ts',
      'tests/integration/stock-preparation-yida-initialization-http-realdb.test.ts',
      'tests/integration/stock-preparation-yida-owner-http-realdb.test.ts',
      'tests/integration/stock-preparation-yida-owner-browser-realdb.test.ts',
      'tests/integration/stock-preparation-yida-initialization-browser-realdb.test.ts',
    ],
    setupFiles: [],
    globalSetup: [],
    retry: 0,
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ['verbose'],
  },
})
