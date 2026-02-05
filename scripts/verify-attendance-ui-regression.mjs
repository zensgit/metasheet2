import fs from 'fs'
import path from 'path'
import { chromium } from '@playwright/test'

const webUrl = process.env.WEB_URL || 'http://localhost:8081/p/plugin-attendance/attendance'
const token = process.env.AUTH_TOKEN || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 30000)
const screenshotPath = process.env.UI_SCREENSHOT_PATH || 'artifacts/attendance-ui-regression.png'

function logInfo(message) {
  console.log(`[attendance-ui-regression] ${message}`)
}

async function setAuth(page) {
  if (!token) return
  await page.addInitScript((value) => {
    if (value) localStorage.setItem('auth_token', value)
  }, token)
}

async function ensureDir(filePath) {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
}

async function assertVisible(page, role, name) {
  const locator = page.getByRole(role, { name })
  await locator.waitFor({ timeout: timeoutMs })
}

async function run() {
  const browser = await chromium.launch({ headless })
  const page = await browser.newPage()
  await setAuth(page)

  logInfo(`Navigating to ${webUrl}`)
  await page.goto(webUrl, { waitUntil: 'networkidle', timeout: timeoutMs })

  await assertVisible(page, 'heading', 'Attendance')
  await assertVisible(page, 'heading', 'Summary')
  await assertVisible(page, 'heading', 'Records')

  await ensureDir(screenshotPath)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  logInfo(`Saved screenshot: ${screenshotPath}`)

  await browser.close()
  logInfo('UI regression check complete')
}

run().catch((error) => {
  console.error('[attendance-ui-regression] Failed:', error)
  process.exit(1)
})
