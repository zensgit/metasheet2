import { defineConfig } from 'vitest/config'
import * as path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Fix vite SSR transformation issues - use forks pool to avoid __vite_ssr_exportName__ errors
    pool: 'forks',
    deps: {
      interopDefault: true
    },
    // Excluded tests - All unit tests enabled as of Session 9
    // Most integration tests require database/external services and custom PluginLoader API.
    // Mock-DB integration tests (comment-flow, collab-ux-flow) can run without a live DB.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Integration tests requiring a live DB or pluginDirs PluginLoader API:
      'tests/integration/admin-users.api.test.ts',
      'tests/integration/after-sales-plugin.install.test.ts',
      'tests/integration/after-sales-registry-backfill.test.ts',
      'tests/integration/approval-pack1a-lifecycle.api.test.ts',
      'tests/integration/attendance-plugin.test.ts',
      'tests/integration/comments.api.test.ts',
      'tests/integration/events-api.test.ts',
      'tests/integration/kanban-plugin.test.ts',
      'tests/integration/kanban.mvp.api.test.ts',
      'tests/integration/multitable-attachments.api.test.ts',
      'tests/integration/multitable-context.api.test.ts',
      'tests/integration/multitable-record-form.api.test.ts',
      'tests/integration/multitable-sheet-permissions.api.test.ts',
      'tests/integration/multitable-sheet-realtime.api.test.ts',
      'tests/integration/multitable-view-config.api.test.ts',
      'tests/integration/plugin-failures.test.ts',
      'tests/integration/plugins-api.contract.test.ts',
      'tests/integration/rooms.basic.test.ts',
      'tests/integration/snapshot-protection.test.ts',
      'tests/integration/spreadsheet-integration.test.ts',
      // Playwright E2E suites run through their own harness, not Vitest.
      'tests/e2e/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: {
        lines: 50,
        statements: 50,
        branches: 40,
        functions: 50
      },
      exclude: [
        'node_modules/**',
        'tests/**',
        '*.config.ts',
        'src/server.js' // Mock server
      ]
    },
    testTimeout: 30000, // Increased timeout for better stability
    hookTimeout: 15000,
    setupFiles: ['./tests/setup.ts'],
    // Better error handling and debugging
    reporter: ['verbose'],
    maxConcurrency: 1, // Reduce concurrency for stability
    globalTeardown: './tests/globalTeardown.ts'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests')
    }
  }
})
