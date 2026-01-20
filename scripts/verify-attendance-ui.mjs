import { chromium } from '@playwright/test'

const webUrl = process.env.WEB_URL || 'http://localhost:8901/attendance'
const token = process.env.AUTH_TOKEN || ''
const timeoutMs = Number(process.env.UI_TIMEOUT || 30000)
const headless = process.env.HEADLESS !== 'false'
const slowMo = Number(process.env.SLOW_MO || 0)
const retryDelayMs = Number(process.env.PUNCH_RETRY_WAIT_MS || 65000)

function logInfo(message) {
  console.log(`[attendance-ui] ${message}`)
}

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatLocalDateTime(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

async function getStatusText(page) {
  const status = page.locator('.attendance__status')
  if (await status.count() === 0) return ''
  const text = await status.first().innerText()
  return text.trim()
}

async function isStatusError(page) {
  const status = page.locator('.attendance__status')
  if (await status.count() === 0) return false
  const className = await status.first().getAttribute('class')
  return Boolean(className && className.includes('attendance__status--error'))
}

async function waitForStatusChange(page, previousText) {
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector('.attendance__status')
      if (!el) return false
      const text = el.textContent ? el.textContent.trim() : ''
      return text.length > 0 && text !== prev
    },
    previousText,
    { timeout: timeoutMs }
  )
  return getStatusText(page)
}

async function clickAndWaitForStatus(page, buttonName) {
  const before = await getStatusText(page)
  await page.getByRole('button', { name: buttonName }).click()
  return waitForStatusChange(page, before)
}

async function updateMinPunchInterval(page, targetValue) {
  const adminNotice = page.locator('text=Admin permissions required to manage attendance settings.')
  if (await adminNotice.count()) {
    logInfo('Admin settings unavailable; skipping min punch interval update')
    return null
  }

  const intervalInput = page.locator('#attendance-min-punch-interval')
  if ((await intervalInput.count()) === 0) {
    logInfo('Min punch interval input not found; skipping update')
    return null
  }

  await intervalInput.waitFor({ timeout: timeoutMs })
  const currentValue = (await intervalInput.inputValue()).trim()
  if (currentValue === targetValue) {
    logInfo(`Min punch interval already ${targetValue}`)
    return currentValue
  }

  await intervalInput.fill(targetValue)

  const statusText = await clickAndWaitForStatus(page, 'Save settings')
  if (await isStatusError(page)) {
    throw new Error(`Save settings failed: ${statusText || 'Unknown error'}`)
  }
  if (!statusText.includes('Settings updated.')) {
    throw new Error(`Unexpected settings status: ${statusText || 'Missing status'}`)
  }
  logInfo(`Min punch interval set to ${targetValue}`)
  return currentValue
}

async function performPunch(page, buttonName, successText) {
  logInfo(`Triggering ${buttonName}`)
  let statusText = await clickAndWaitForStatus(page, buttonName)
  let isError = await isStatusError(page)

  if (isError && statusText.includes('Punch interval too short')) {
    logInfo(`Punch interval too short; waiting ${retryDelayMs}ms before retry`)
    await page.waitForTimeout(retryDelayMs)
    statusText = await clickAndWaitForStatus(page, buttonName)
    isError = await isStatusError(page)
  }

  if (isError) {
    throw new Error(`${buttonName} failed: ${statusText || 'Unknown error'}`)
  }
  if (!statusText.includes(successText)) {
    throw new Error(`Unexpected ${buttonName} status: ${statusText || 'Missing status'}`)
  }
  logInfo(`${buttonName} confirmed`)
}

async function submitAndCancelRequest(page) {
  logInfo('Submitting adjustment request')
  const now = new Date()
  const workDateInput = page.locator('#attendance-request-work-date')
  const requestTypeSelect = page.locator('#attendance-request-type')
  const requestedInInput = page.locator('#attendance-request-in')
  const reasonInput = page.locator('#attendance-request-reason')

  if (await workDateInput.count()) {
    await workDateInput.fill(formatLocalDate(now))
  }
  if (await requestTypeSelect.count()) {
    await requestTypeSelect.selectOption('missed_check_in')
  }
  if (await requestedInInput.count()) {
    const requestedInAt = new Date(now.getTime() - 5 * 60000)
    await requestedInInput.fill(formatLocalDateTime(requestedInAt))
  }
  if (await reasonInput.count()) {
    await reasonInput.fill('UI smoke cancel')
  }

  const submitStatus = await clickAndWaitForStatus(page, 'Submit request')
  if (await isStatusError(page)) {
    throw new Error(`Request submit failed: ${submitStatus || 'Unknown error'}`)
  }
  if (!submitStatus.includes('Request submitted.')) {
    throw new Error(`Unexpected request status: ${submitStatus || 'Missing status'}`)
  }

  const pendingChip = page.locator('.attendance__status-chip--pending')
  await pendingChip.first().waitFor({ timeout: timeoutMs })

  logInfo('Cancelling adjustment request')
  const cancelStatus = await clickAndWaitForStatus(page, 'Cancel')
  if (await isStatusError(page)) {
    throw new Error(`Request cancel failed: ${cancelStatus || 'Unknown error'}`)
  }
  if (!cancelStatus.includes('Request cancelled.')) {
    throw new Error(`Unexpected cancel status: ${cancelStatus || 'Missing status'}`)
  }
  logInfo('Request cancellation confirmed')
}

async function exportCsv(page) {
  logInfo('Exporting CSV')
  const statusText = await clickAndWaitForStatus(page, 'Export CSV')
  if (await isStatusError(page)) {
    throw new Error(`Export CSV failed: ${statusText || 'Unknown error'}`)
  }
  if (!statusText.includes('Export ready.')) {
    throw new Error(`Unexpected export status: ${statusText || 'Missing status'}`)
  }
  logInfo('Export CSV confirmed')
}

async function run() {
  const browser = await chromium.launch({ headless, slowMo })
  const context = await browser.newContext()

  try {
    if (token) {
      await context.addInitScript((value) => {
        localStorage.setItem('auth_token', value)
      }, token)
    }

    const page = await context.newPage()
    const consoleErrors = []

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    logInfo(`Opening ${webUrl}`)
    await page.goto(webUrl, { waitUntil: 'networkidle' })

    const readyHeading = page.getByRole('heading', { name: 'Attendance' })
    const missingHeading = page.getByRole('heading', { name: 'Attendance module not enabled' })
    await Promise.race([
      readyHeading.waitFor({ timeout: timeoutMs }),
      missingHeading.waitFor({ timeout: timeoutMs })
    ])

    if (await missingHeading.count()) {
      throw new Error('Attendance module not enabled')
    }

    await page.getByRole('heading', { name: 'Summary' }).waitFor({ timeout: timeoutMs })
    await page.getByRole('heading', { name: 'Records' }).waitFor({ timeout: timeoutMs })
    await page.getByRole('heading', { name: 'Admin Console' }).waitFor({ timeout: timeoutMs })

    if (token) {
      const missingToken = await page.locator('text=Missing Bearer token').count()
      if (missingToken > 0) {
        throw new Error('Attendance view still reports Missing Bearer token')
      }
    }

    const refreshButton = page.getByRole('button', { name: 'Refresh' })
    if (await refreshButton.count()) {
      await refreshButton.first().click()
      await page.waitForTimeout(500)
    }

    const previousInterval = await updateMinPunchInterval(page, '0')
    await performPunch(page, 'Check In', 'Check in recorded.')
    await performPunch(page, 'Check Out', 'Check out recorded.')
    await submitAndCancelRequest(page)
    await exportCsv(page)
    if (previousInterval && previousInterval !== '0') {
      await updateMinPunchInterval(page, previousInterval)
    }

    if (consoleErrors.length) {
      throw new Error(`Console errors found: ${consoleErrors.join('; ')}`)
    }

    logInfo('Attendance UI smoke check passed')
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error('[attendance-ui] Failed:', error?.message || error)
  process.exit(1)
})
