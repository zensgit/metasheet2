import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/'
const apiBaseEnv = process.env.API_BASE || ''
let token = process.env.AUTH_TOKEN || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 45000)
const fromDate = process.env.FROM_DATE || ''
const toDate = process.env.TO_DATE || ''
const userId = process.env.USER_ID || ''
const productMode = process.env.PRODUCT_MODE || ''
const featuresJson = process.env.FEATURES_JSON || ''
const mobile = process.env.UI_MOBILE === 'true'
const allowEmptyRecords = process.env.ALLOW_EMPTY_RECORDS === 'true'
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/attendance-full-flow'
const expectProductModeRaw = process.env.EXPECT_PRODUCT_MODE || ''
const assertAdminRetry = process.env.ASSERT_ADMIN_RETRY !== 'false'
const adminReadyTimeoutMs = Number(process.env.ADMIN_READY_TIMEOUT || timeoutMs)

function logInfo(message) {
  console.log(`[attendance-full-flow] ${message}`)
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function normalizeProductMode(value) {
  if (value === 'attendance' || value === 'attendance-focused') return 'attendance'
  if (value === 'platform') return 'platform'
  return ''
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

async function setProductFeatures(page) {
  if (!productMode && !featuresJson) return
  await page.addInitScript((payload) => {
    const modeValue = payload?.modeValue
    const jsonValue = payload?.jsonValue
    if (typeof modeValue === 'string' && modeValue) {
      localStorage.setItem('metasheet_product_mode', modeValue)
    }
    if (typeof jsonValue === 'string' && jsonValue) {
      localStorage.setItem('metasheet_features', jsonValue)
    }
  }, { modeValue: productMode, jsonValue: featuresJson })
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

async function fetchAuthMeFeatures(apiBase) {
  if (!apiBase) return null
  if (typeof fetch !== 'function') {
    throw new Error('Node 18+ is required (global fetch missing)')
  }

  const url = `${normalizeUrl(apiBase)}/auth/me`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const raw = await res.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    throw new Error(`GET /auth/me failed: HTTP ${res.status} ${raw.slice(0, 160)}`)
  }
  const payload = body?.data ?? body ?? {}
  return payload?.features && typeof payload.features === 'object' ? payload.features : null
}

async function endpointExists(apiBase, pathname) {
  if (!apiBase) return false
  try {
    const url = `${normalizeUrl(apiBase)}${pathname}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    return res.status !== 404
  } catch {
    return false
  }
}

async function ensureAttendanceLoaded(page) {
  await page.waitForURL(/\/attendance(\?|$)/, { timeout: timeoutMs })
  // Use exact match to avoid strict-mode collisions with headings like "Attendance groups".
  await page.getByRole('heading', { name: 'Attendance', exact: true }).waitFor({ timeout: timeoutMs })
}

async function assertNavForAttendanceMode(page) {
  const nav = page.locator('nav.app-nav')
  await nav.waitFor({ timeout: timeoutMs })
  const gridLink = page.getByRole('link', { name: 'Grid' })
  if (await gridLink.count()) {
    throw new Error('Expected attendance-focused nav (no Grid link), but Grid link is visible')
  }
  const attendanceLink = page.getByRole('link', { name: 'Attendance' })
  if (!(await attendanceLink.count())) {
    throw new Error('Expected Attendance link in nav, but not found')
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

async function refreshRecords(page) {
  await page.getByRole('button', { name: 'Refresh' }).click()
  const recordsSection = page.locator('section.attendance__card').filter({
    has: page.getByRole('heading', { name: 'Records' }),
  })
  await recordsSection.getByRole('button', { name: 'Reload' }).click()
}

async function assertHasRecords(page) {
  await page.waitForTimeout(800)
  const empty = page.locator('text=No records.')
  if (allowEmptyRecords) return
  if (await empty.count()) {
    throw new Error('No records found in Records table')
  }
}

async function captureDebugScreenshot(page, fileName) {
  await fs.mkdir(outputDir, { recursive: true })
  const screenshotPath = path.join(outputDir, fileName)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  logInfo(`Saved debug screenshot: ${screenshotPath}`)
}

async function run() {
  if (!token) {
    logInfo('AUTH_TOKEN is required')
    process.exit(1)
  }

  const apiBase = normalizeUrl(apiBaseEnv) || deriveApiBaseFromWebUrl(webUrl)
  await refreshAuthToken(apiBase)

  // Resolve expected features:
  // 1) Explicit FEATURES_JSON override (local/dev).
  // 2) Live /api/auth/me (production verification).
  const overrideFeatures = parseFeatures(featuresJson)
  let liveFeatures = null
  if (!overrideFeatures) {
    try {
      liveFeatures = await fetchAuthMeFeatures(apiBase)
      if (liveFeatures) {
        logInfo(`Loaded features from ${apiBase}/auth/me`)
      }
    } catch (error) {
      logInfo(`WARN: failed to load /auth/me features (${(error && error.message) || error})`)
    }
  }

  const features = (overrideFeatures || liveFeatures || {}) ?? {}
  const resolvedMode =
    normalizeProductMode(productMode) ||
    normalizeProductMode(features?.mode)
  const expectAttendanceFocused = resolvedMode === 'attendance'

  const expectProductMode = normalizeProductMode(expectProductModeRaw)
  if (expectProductMode) {
    const actualMode = normalizeProductMode(resolvedMode || features?.mode)
    if (!actualMode) {
      throw new Error(`Expected product mode '${expectProductMode}', but features.mode is missing`)
    }
    if (actualMode !== expectProductMode) {
      throw new Error(`Expected product mode '${expectProductMode}', got '${actualMode}'`)
    }
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

  await ensureAttendanceLoaded(page)

  if (expectAttendanceFocused) {
    await assertNavForAttendanceMode(page)
    logInfo('Nav verified (attendance-focused)')
  }

  if (fromDate || toDate) {
    await setDateRange(page, fromDate, toDate)
  }
  if (userId) {
    await page.locator('#attendance-user-id').fill(userId)
  }
  await refreshRecords(page)
  await assertHasRecords(page)

  const today = new Date().toISOString().slice(0, 10)
  const anomaliesSupported = await endpointExists(apiBase, `/attendance/anomalies?from=${today}&to=${today}`)
  if (anomaliesSupported) {
    await page.getByRole('heading', { name: 'Anomalies', exact: true }).waitFor({ timeout: timeoutMs })
    logInfo('Anomalies card verified')
  } else {
    logInfo('WARN: /attendance/anomalies not available (skipping anomalies UI assertion)')
  }

  await fs.mkdir(outputDir, { recursive: true })
  await page.screenshot({ path: path.join(outputDir, '01-overview.png'), fullPage: true })
  logInfo('Saved overview screenshot')

  // Admin Center (if enabled)
  if (features.attendanceAdmin) {
    await page.getByRole('button', { name: 'Admin Center' }).click()
    if (mobile) {
      await page.getByRole('heading', { name: 'Desktop recommended' }).waitFor({ timeout: timeoutMs })
    } else {
      const importSection = page.locator('div.attendance__admin-section').filter({
        has: page.getByRole('heading', { name: 'Import (DingTalk / Manual)', exact: true }),
      })
      const payrollHeading = page.getByRole('heading', { name: 'Payroll Cycles', exact: true })
      const payrollBatchSummary = page.locator('summary.attendance__details-summary', { hasText: 'Batch generate cycles' })

      try {
        await importSection.first().waitFor({ timeout: adminReadyTimeoutMs })
        await payrollHeading.waitFor({ timeout: adminReadyTimeoutMs })
        await payrollBatchSummary.waitFor({ timeout: adminReadyTimeoutMs })
      } catch (error) {
        await captureDebugScreenshot(page, '02-admin-section-missing.png')
        const message = (error && error.message) || String(error)
        if (assertAdminRetry) {
          throw new Error(`Admin section not ready for import assertions: ${message}`)
        }
        logInfo(`WARN: Admin section not ready, skipping retry assertions (${message})`)
      }

      const importSectionCount = await importSection.count()
      const shouldAssertRetry = assertAdminRetry && importSectionCount > 0
      if (shouldAssertRetry) {
        const payloadInput = importSection.locator('#attendance-import-payload').first()
        const previewButton = importSection.getByRole('button', { name: 'Preview', exact: true }).first()
        await payloadInput.waitFor({ timeout: adminReadyTimeoutMs })
        await previewButton.waitFor({ timeout: adminReadyTimeoutMs })
        await payloadInput.fill('{')
        await previewButton.click()
        await page.getByText('Invalid JSON payload for import.', { exact: true }).waitFor({ timeout: timeoutMs })
        await page.getByRole('button', { name: 'Retry preview', exact: true }).first().waitFor({ timeout: timeoutMs })
        logInfo('Admin status + retry action verified')
      } else {
        logInfo('Admin retry assertions skipped (ASSERT_ADMIN_RETRY=false or section unavailable)')
      }
      logInfo('Payroll batch UI verified')
    }
    await page.screenshot({ path: path.join(outputDir, '02-admin.png'), fullPage: true })
    logInfo('Saved admin screenshot')
    if (mobile) {
      await page.getByRole('button', { name: 'Back to Overview' }).click()
    }
  }

  // Workflow Designer (if enabled)
  if (features.workflow) {
    await page.getByRole('button', { name: 'Workflow Designer' }).click()
    if (mobile) {
      await page.getByRole('heading', { name: 'Desktop recommended' }).waitFor({ timeout: timeoutMs })
      await page.getByRole('button', { name: 'Back to Overview', exact: true }).click()
      await page.getByRole('heading', { name: 'Attendance', exact: true }).waitFor({ timeout: timeoutMs })
    } else {
      await page.locator('.workflow-designer').waitFor({ timeout: timeoutMs })
    }
    await page.screenshot({ path: path.join(outputDir, '03-workflow.png'), fullPage: true })
    logInfo('Saved workflow screenshot')
  }

  await context.close()
  await browser.close()
  logInfo('Full flow verification complete')
}

run().catch((error) => {
  console.error('[attendance-full-flow] Failed:', error)
  process.exit(1)
})
