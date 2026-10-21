import { defineConfig, devices } from '@playwright/test'

const port = 5197
export default defineConfig({
  testDir: './verification',
  testMatch: 'attendance-makeup-request.spec.ts',
  timeout: 45_000,
  workers: 1,
  retries: 0,
  outputDir: './artifacts/attendance-makeup',
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/verification/attendance-makeup-request-harness.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
