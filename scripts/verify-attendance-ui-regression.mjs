import fs from 'fs'
import path from 'path'
import { chromium } from '@playwright/test'

const webUrl = process.env.WEB_URL || 'http://localhost:8081/p/plugin-attendance/attendance'
let token = process.env.AUTH_TOKEN || ''
const apiBaseEnv = process.env.API_BASE || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 30000)
const screenshotPath = process.env.UI_SCREENSHOT_PATH || 'artifacts/attendance-ui-regression.png'

function logInfo(message) {
  console.log(`[attendance-ui-regression] ${message}`)
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function deriveApiBaseFromWebUrl(url) {
  try {
    const u = new URL(url)
    return `${u.origin}/api`
  } catch {
    return ''
  }
}

async function refreshAuthToken(apiBase) {
  if (!apiBase || !token) return false
  const url = `${normalizeUrl(apiBase)}/auth/refresh-token`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const raw = await res.text()
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    if (!res.ok || body?.success === false) {
      logInfo(`WARN: token refresh failed: HTTP ${res.status}`)
      return false
    }
    const nextToken = body?.data?.token
    if (typeof nextToken === 'string' && nextToken.length > 20) {
      token = nextToken
      return true
    }
    logInfo('WARN: token refresh response missing token')
    return false
  } catch (error) {
    logInfo(`WARN: token refresh error (${(error && error.message) || error})`)
    return false
  }
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
  const apiBase = normalizeUrl(apiBaseEnv) || deriveApiBaseFromWebUrl(webUrl)
  await refreshAuthToken(apiBase)

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
