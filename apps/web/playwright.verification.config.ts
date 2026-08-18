import { defineConfig, devices } from '@playwright/test'

// Browser-verification lane (B6/A5 UI). Boots the Vite dev server, renders the
// real components via the verification harness, and asserts the visual/interaction
// render that jsdom can't. Run: `pnpm --filter @metasheet/web exec playwright test
// --config playwright.verification.config.ts` (cwd = apps/web).
const PORT = 5174

export default defineConfig({
  testDir: './verification',
  testMatch: '**/*.spec.ts',
  // The approval form-builder specs run in their OWN lane
  // (playwright.approval-verification.config.ts / approval-browser-verify.yml)
  // so an approval-harness failure cannot red the multitable lane. F4 added
  // approval-form-builder-mounted-matrix.spec.ts to that same disjoint lane —
  // ignored here for the same reason.
  testIgnore: [
    '**/approval-form-builder-parity.spec.ts',
    '**/approval-form-builder-mounted-matrix.spec.ts',
  ],
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: './verification-output/_pw',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'off', // the spec takes explicit, named screenshots
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/verification/cf-reactions-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
