import { chromium } from '@playwright/test'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/attendance'
const token = process.env.AUTH_TOKEN || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 30000)
const fromDate = process.env.FROM_DATE || ''
const toDate = process.env.TO_DATE || ''
const userIds = (process.env.USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean)
const debug = process.env.UI_DEBUG === 'true'

function logInfo(message) {
  console.log(`[attendance-import-ui] ${message}`)
}

async function setAuth(page) {
  if (!token) return
  await page.addInitScript((value) => {
    if (value) localStorage.setItem('auth_token', value)
  }, token)
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
  if (await empty.count()) {
    throw new Error('No records found in Records table')
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
  const page = await browser.newPage()
  await setAuth(page)

  logInfo(`Navigating to ${webUrl}`)
  await page.goto(webUrl, { waitUntil: 'networkidle', timeout: timeoutMs })

  for (const userId of userIds) {
    if (debug) logInfo(`Validating user ${userId}`)
    await setDateRange(page, fromDate, toDate)
    await setUserId(page, userId)
    await refreshRecords(page)
    await assertHasRecords(page)
    logInfo(`Records verified for ${userId}`)
  }

  await browser.close()
  logInfo('UI verification complete')
}

run().catch((error) => {
  console.error('[attendance-import-ui] Failed:', error)
  process.exit(1)
})
