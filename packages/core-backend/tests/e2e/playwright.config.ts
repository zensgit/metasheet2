import { defineConfig } from '@playwright/test'

/**
 * Minimal Playwright config for federated PLM E2E tests.
 *
 * Prerequisites (external — not auto-started by this config):
 *   1. Yuantus on http://127.0.0.1:7910
 *   2. Metasheet backend on http://localhost:7778
 *   3. Metasheet frontend on http://127.0.0.1:8899
 *
 * Tests skip automatically if servers are not reachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  retries: 0,
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:8899',
  },
})
