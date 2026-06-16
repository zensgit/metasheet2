import { defineConfig, devices } from '@playwright/test'

// Browser-verification lane (B6/A5 UI). Boots the Vite dev server, renders the
// real components via the verification harness, and asserts the visual/interaction
// render that jsdom can't. Run: `pnpm --filter @metasheet/web exec playwright test
// --config playwright.verification.config.ts` (cwd = apps/web).
const PORT = 5174

export default defineConfig({
  testDir: './verification',
  testMatch: '**/*.spec.ts',
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
