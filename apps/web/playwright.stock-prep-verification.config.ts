import { defineConfig, devices } from '@playwright/test'

// 备料工作台 real-browser acceptance lane (设计稿 §6.1 P0 十一条 / §6.2 P1 七条).
//
// This lane OWNS ITS SERVER, on its own port, exactly like the approval lane does and for the same
// reason: a reused, disappearing dev server is how a browser contract becomes a flake. 5176 keeps it
// disjoint from the shared multitable lane (5174) and the approval lane (5175).
//
// WHAT IS ONLY PROVABLE HERE. Three of the acceptance items are structurally invisible to jsdom,
// which runs no cascade and computes no styles:
//   * 深度工具 「默认收起」 — the fold's entire effect is one `[hidden] { display: none }` rule that
//     has to out-specify the panel's own `display: flex`; jsdom reports the attribute either way.
//   * G1 「每屏一个主操作位」 — counted from `getComputedStyle().backgroundColor`, i.e. from the
//     resolved `--ms-color-primary`, which only a real cascade produces.
//   * 「未检查」既非绿也非红 — same, on the ops panel's badge colours.
// The remaining items are asserted here against the real network timing and the real clipboard, with
// the jsdom suites keeping their own (faster, finer) hold on the pure logic.
//
// Run: `pnpm --filter @metasheet/web exec playwright test
//       --config playwright.stock-prep-verification.config.ts` (cwd = apps/web).
const PORT = 5176

export default defineConfig({
  testDir: './verification',
  testMatch: ['**/stock-prep-*.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: './verification-output/_pw-stock-prep',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'off',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    // 剪贴板断言用的是 navigator.clipboard.writeText 的真实路径(plmClipboard.ts 先试它,失败才回退
    // execCommand)。Chromium 在非安全上下文/无授权时会拒绝写,授权后这条路径才是被测的那条。
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/verification/stock-prep-workbench-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
