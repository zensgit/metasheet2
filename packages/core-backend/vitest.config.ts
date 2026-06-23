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
      'tests/integration/approval-directory-endpoints.api.test.ts',
      'tests/integration/approval-p1c-field-permissions.api.test.ts',
      'tests/integration/approval-wp-add-reduce-sign.api.test.ts',
      'tests/integration/approval-direct-manager.api.test.ts',
      'tests/integration/approval-postgate-acceptance.api.test.ts',
      'tests/integration/dept-head-sync-plumbing.test.ts',
      'tests/integration/approval-manager-chain.db.test.ts',
      'tests/integration/approval-delegation-seam.db.test.ts',
      'tests/integration/approval-delegation-api.db.test.ts',
      'tests/integration/approval-pack1a-lifecycle.api.test.ts',
      'tests/integration/attendance-comp-time-expiry-reminder.test.ts',
      'tests/integration/attendance-expiry-service.test.ts',
      'tests/integration/attendance-notification-deliveries.test.ts',
      'tests/integration/attendance-outdoor-punch.test.ts',
      'tests/integration/attendance-plugin.test.ts',
      'tests/integration/attendance-schedule-dispatch.test.ts',
      'tests/integration/attendance-shift-swap.test.ts',
      'tests/integration/attendance-unscheduled-reminder.test.ts',
      // comment-reactions.api.test.ts needs setup.integration.ts + a live DB (real
      // MetaSheetServer on an ephemeral port + rbacGuard). It is excluded from the
      // default unit run HERE but wired as a WHOLE FILE into the dedicated
      // `Run comment-reaction keystone` step in plugin-tests.yml, where it runs
      // against real Postgres every PR — the B6 keystone (add/aggregate/idempotent
      // re-add/self-scoped DELETE/reader-deny 403/cascade) is no longer invisible debt.
      'tests/integration/comment-reactions.api.test.ts',
      'tests/integration/multitable-oapi1-comments-read-realdb.test.ts',
      // W6 full-HTTP-path approve->resume seam: mounts authRouter + approvalsRouter on an
      // ephemeral port against real Postgres, so it is excluded from the default run and wired
      // into the dedicated `Run multitable real-DB integration` job in plugin-tests.yml.
      'tests/integration/multitable-automation-start-approval-http.test.ts',
      // comments.api.test.ts needs setup.integration.ts + a live DB. It stays
      // CI-excluded (NOT wired) because 8 of its tests have a pre-existing real-wire
      // failure (CommentService.mapRowToComment drops containerId/targetId/
      // targetFieldId), tracked separately under its own opt-in fix. The reaction
      // keystone that used to live here moved to comment-reactions.api.test.ts.
      'tests/integration/comments.api.test.ts',
      'tests/integration/events-api.test.ts',
      'tests/integration/multitable-attachments.api.test.ts',
      // multitable-context.api.test.ts needs setup.integration.ts + a live DB (its template
      // catalog/install routes go through rbacGuard, which 403s under the default setup). It
      // stays excluded HERE but is now wired INTO the `Run multitable real-DB integration`
      // job (plugin-tests.yml), where it is green — so it is CI-covered, not invisible debt.
      'tests/integration/multitable-context.api.test.ts',
      'tests/integration/multitable-record-form.api.test.ts',
      'tests/integration/multitable-sheet-permissions.api.test.ts',
      'tests/integration/multitable-sheet-realtime.api.test.ts',
      // multitable-view-config.api.test.ts uses an in-file MOCK pool (no live DB) and
      // self-contains its RBAC mocking — it runs under the default config + setup.ts, so
      // it stays IN the standard `test` job (runs on every PR, Node 18 + 20). Excluding it
      // here hid a #2052/#2068 redaction-wiring regression (4/7 RED) that no CI job caught.
      'tests/integration/plugin-failures.test.ts',
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
