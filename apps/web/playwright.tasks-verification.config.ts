import { defineConfig, devices } from '@playwright/test'

// Tasks real-browser acceptance walk (task usability package 1, "Acceptance walk (before merge)",
// items 1 and 2). An OWNED lane with its own server, like the approval and stock-prep lanes, so a
// reused dev server cannot make the walk flaky.
//
// What it walks, on harness pages that mount the real components (verification/
// tasks-acceptance-walk-harness.html/.ts) with every /api answer given by the spec:
//   1. the record drawer's 派发任务 dialog at 390 and 360 wide (its box inside the viewport with
//      16px gutters, due date and time stacked), with a 1280 desktop control;
//   2. the 422 ASSIGNEE_TASK_ACCESS_REQUIRED message, once from the dialog's create and once from
//      the task detail page's assignee add.
// It is not a full stack: no backend, no database. The third walk item (following the enablement
// page on a test database) is not covered here.
//
// `retries: 0` on purpose: the walk counts only if it passes on its first try. That, the testMatch
// ownership and tasks-web-guard.yml's walk steps are pinned by
// scripts/ops/tasks-browser-ci-wiring.test.mjs. The locale and the time zone are pinned on the
// browser context (not in the page), so the product picks zh-CN from the browser language the way it
// does for a user without a stored choice, and the dialog's browser-zone due keys are deterministic
// on any runner.
//
// Run: `pnpm --filter @metasheet/web exec playwright test
//       --config playwright.tasks-verification.config.ts` (cwd = apps/web).
// Port 5177 keeps this lane's server disjoint from the multitable (5174), approval (5175),
// stock-prep (5176) and attendance makeup (5197) lanes.
const PORT = 5177

export default defineConfig({
  testDir: './verification',
  testMatch: ['**/tasks-*.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './verification-output/_pw-tasks',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'off', // the spec takes explicit, named screenshots
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/verification/tasks-acceptance-walk-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
