import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/'
const token = process.env.AUTH_TOKEN || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 45000)
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/attendance-locale-zh-smoke'

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function log(message) {
  console.log(`[attendance-locale-zh-smoke] ${message}`)
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function run() {
  if (!token) {
    throw new Error('AUTH_TOKEN is required')
  }

  await ensureDir(outputDir)

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  await page.addInitScript((payload) => {
    localStorage.setItem('auth_token', payload.token)
    localStorage.setItem('metasheet_locale', 'zh-CN')
  }, { token })

  try {
    const target = `${normalizeUrl(webUrl)}/attendance`
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForLoadState('networkidle', { timeout: timeoutMs })

    const localeSelect = page.locator('nav.app-nav .nav-locale__select')
    await localeSelect.waitFor({ timeout: timeoutMs })
    const localeValue = await localeSelect.inputValue()
    if (localeValue !== 'zh-CN') {
      throw new Error(`Expected locale select value zh-CN, got ${localeValue || '<empty>'}`)
    }

    await page.locator('#attendance-from-date').waitFor({ timeout: timeoutMs })
    await page.getByRole('heading', { name: '考勤', exact: true }).waitFor({ timeout: timeoutMs })

    const lunarLabels = page.locator('.attendance__calendar-lunar')
    const lunarCount = await lunarLabels.count()
    if (lunarCount <= 0) {
      throw new Error('Expected lunar labels in calendar cells, found none')
    }

    const screenshotPath = path.join(outputDir, 'attendance-zh-locale-calendar.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })

    log(`PASS: locale=zh-CN, lunarLabels=${lunarCount}, screenshot=${screenshotPath}`)
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  const message = (error && error.message) || String(error)
  console.error(`[attendance-locale-zh-smoke] FAIL: ${message}`)
  process.exitCode = 1
})

