import { defineConfig, devices } from '@playwright/test'

// F2 approval form-builder browser-verification lane (delta §5 F2 / §7.1
// item 7: an OWNED real-Chromium harness with its own server — never a reused
// disappearing server). Boots Vite, renders the real ApprovalFormPalette +
// ApprovalFormBuilder via verification/approval-form-builder-harness.html, and
// asserts exact-slot DataTransfer drags, cancelled-drag no-ops, strict codec
// rejection, and the stale-anchor no-op.
//
// F4 (delta §5 F4, F2-gate handoff condition 1) extends this SAME lane with
// approval-form-builder-mounted-matrix.spec.ts: the B1-B12 real-browser matrix
// driven by genuine mouse drags (`locator.dragTo`, never synthetic DataTransfer)
// against the MOUNTED production surface (the real TemplateAuthoringView.vue,
// real Vue Router, real Element Plus — verification/
// approval-form-builder-mounted-harness.html/.ts), flag ON.
//
// P5-C adds the real ApprovalDetailView member-action dialog acceptance harness. It exercises the
// production Element Plus dialog/focus trap at 1440/1024/390, including mobile action narrowing,
// accessible names, disabled confirms, focus containment/restoration, and overflow.
//
// P7-B0 adds Canvas sole-surface acceptance through the mounted TemplateAuthoringView harness:
// Canvas ON is the only ordinary flow surface at 1440/1024/390, selection opens the real inspector
// by pointer and keyboard, and flag OFF keeps the explicit structured-list rollback.
//
// Run: `pnpm --filter @metasheet/web exec playwright test
//       --config playwright.approval-verification.config.ts` (cwd = apps/web).
// Port 5175 keeps this lane's server disjoint from the multitable lane (5174).
const PORT = 5175

export default defineConfig({
  testDir: './verification',
  testMatch: ['**/approval-*.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: './verification-output/_pw-approval',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'off', // the spec takes explicit, named screenshots
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/verification/approval-form-builder-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
