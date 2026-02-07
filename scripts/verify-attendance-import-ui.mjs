import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/attendance'
const token = process.env.AUTH_TOKEN || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 30000)
const fromDate = process.env.FROM_DATE || ''
const toDate = process.env.TO_DATE || ''
const userIds = (process.env.USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean)
const debug = process.env.UI_DEBUG === 'true'
const screenshotPath = process.env.UI_SCREENSHOT_PATH || ''
const productMode = process.env.PRODUCT_MODE || ''
const featuresJson = process.env.FEATURES_JSON || ''
const mobile = process.env.UI_MOBILE === 'true'
const allowEmptyRecords = process.env.ALLOW_EMPTY_RECORDS === 'true'

function logInfo(message) {
  console.log(`[attendance-import-ui] ${message}`)
}

async function setAuth(page) {
  if (!token) return
  await page.addInitScript((value) => {
    if (value) localStorage.setItem('auth_token', value)
  }, token)
}

async function setProductFeatures(page) {
  if (!productMode && !featuresJson) return
  await page.addInitScript((modeValue, jsonValue) => {
    if (typeof modeValue === 'string' && modeValue) {
      localStorage.setItem('metasheet_product_mode', modeValue)
    }
    if (typeof jsonValue === 'string' && jsonValue) {
      localStorage.setItem('metasheet_features', jsonValue)
    }
  }, productMode, featuresJson)
}

function parseFeatures(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function setDateRange(page, from, to) {
  if (from) {
    await page.locator('#attendance-from-date').fill(from)
  }
  if (to) {
    await page.locator('#attendance-to-date').fill(to)
  }
}

async function setUserId(page, userId) {
  await page.locator('#attendance-user-id').fill(userId)
}

async function refreshRecords(page) {
  await page.getByRole('button', { name: 'Refresh' }).click()
  const recordsSection = page.locator('section.attendance__card').filter({
    has: page.getByRole('heading', { name: 'Records' }),
  })
  await recordsSection.getByRole('button', { name: 'Reload' }).click()
}

async function assertHasRecords(page) {
  await page.waitForTimeout(1000)
  const empty = page.locator('text=No records.')
  if (allowEmptyRecords) return
  if (await empty.count()) {
    throw new Error('No records found in Records table')
  }
}

async function assertTabPresence(page, features) {
  if (!features) return

  await page.locator('nav.attendance-shell__tabs').waitFor({ timeout: timeoutMs })

  const shouldHaveAdmin = Boolean(features.attendanceAdmin)
  const shouldHaveWorkflow = Boolean(features.workflow)

  const adminTab = page.getByRole('button', { name: 'Admin Center' })
  const workflowTab = page.getByRole('button', { name: 'Workflow Designer' })

  if (shouldHaveAdmin) {
    if (!(await adminTab.count())) throw new Error('Expected Admin Center tab, but not found')
  } else if (await adminTab.count()) {
    throw new Error('Admin Center tab should not be visible')
  }

  if (shouldHaveWorkflow) {
    if (!(await workflowTab.count())) throw new Error('Expected Workflow Designer tab, but not found')
  } else if (await workflowTab.count()) {
    throw new Error('Workflow Designer tab should not be visible')
  }

  if (mobile && shouldHaveWorkflow) {
    await workflowTab.click()
    await page.getByRole('heading', { name: 'Desktop recommended' }).waitFor({ timeout: timeoutMs })
    await page.getByRole('button', { name: 'Back to Overview' }).click()
  }
}

async function run() {
  if (!token) {
    logInfo('AUTH_TOKEN is required for UI verification')
    process.exit(1)
  }
  if (userIds.length === 0) {
    logInfo('USER_IDS is required (comma separated)')
    process.exit(1)
  }

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
  })
  const page = await context.newPage()
  await setAuth(page)
  await setProductFeatures(page)

  logInfo(`Navigating to ${webUrl}`)
  await page.goto(webUrl, { waitUntil: 'networkidle', timeout: timeoutMs })

  const features = parseFeatures(featuresJson)
  await assertTabPresence(page, features)

  for (const userId of userIds) {
    if (debug) logInfo(`Validating user ${userId}`)
    await setDateRange(page, fromDate, toDate)
    await setUserId(page, userId)
    await refreshRecords(page)
    await assertHasRecords(page)
    logInfo(`Records verified for ${userId}`)
  }

  if (screenshotPath) {
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: true })
    logInfo(`Saved screenshot: ${screenshotPath}`)
  }

  await context.close()
  await browser.close()
  logInfo('UI verification complete')
}

run().catch((error) => {
  console.error('[attendance-import-ui] Failed:', error)
  process.exit(1)
})
