import { defineConfig } from 'vitest/config'
import * as path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    deps: {
      interopDefault: true,
    },
    include: [
      'tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // The enablement walk: its own trust-off step in tasks-realdb.yml (vitest.tasks-enablement.config.ts).
      // Its module guard throws under any other config, so a bare run here would only report it as failed.
      'tests/integration/task-enablement-http.db.test.ts',
      // Permission lifecycle real-DB gate. Trust-off config; this harness enables RBAC bypass.
      'tests/integration/permission-lifecycle-realdb.test.ts',
      'tests/integration/permission-role-delete-realdb.test.ts',
      'tests/integration/permission-browser-realdb.test.ts',
      // Permission-management UX uses dedicated configs with token trust disabled
      // before imports, and a separate CI PostgreSQL instance per slice.
      'tests/integration/permission-ux-*.db.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 15000,
    setupFiles: ['./tests/setup.integration.ts'],
    reporter: ['verbose'],
    // Integration specs share one real Postgres and several org-global settings rows.
    // Run files serially so route-level tests that temporarily change settings cannot
    // bleed into another file's server process while it is asserting default behavior.
    fileParallelism: false,
    maxConcurrency: 1,
    globalTeardown: './tests/globalTeardown.ts',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
})
