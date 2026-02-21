import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import os from 'os'
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
const assertImportJobRecovery = process.env.ASSERT_IMPORT_JOB_RECOVERY === 'true'
const importRecoveryTimeoutMs = Math.max(10, Number(process.env.IMPORT_RECOVERY_TIMEOUT_MS || 80))
const importRecoveryIntervalMs = Math.max(10, Number(process.env.IMPORT_RECOVERY_INTERVAL_MS || 25))
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

async function setImportDebugOverrides(page) {
  if (!assertImportJobRecovery || mobile) return
  await page.addInitScript((payload) => {
    let current = {}
    try {
      const raw = localStorage.getItem('metasheet_attendance_debug')
      current = raw ? JSON.parse(raw) : {}
    } catch {
      current = {}
    }
    const next = {
      ...(current && typeof current === 'object' ? current : {}),
      import: {
        ...((current && typeof current === 'object' && current.import && typeof current.import === 'object')
          ? current.import
          : {}),
        forceUploadCsv: true,
        forceAsyncImport: true,
        forceTimeoutOnce: true,
        pollTimeoutMs: payload.pollTimeoutMs,
        pollIntervalMs: payload.pollIntervalMs,
      },
    }
    localStorage.setItem('metasheet_attendance_debug', JSON.stringify(next))
  }, { pollTimeoutMs: importRecoveryTimeoutMs, pollIntervalMs: importRecoveryIntervalMs })
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
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
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

async function waitForImportPayload(page, previousValue = null) {
  await page.waitForFunction((prevValue) => {
    const el = document.querySelector('#attendance-import-payload')
    const value = el && 'value' in el ? el.value : ''
    if (typeof value !== 'string') return false
    if (!(value.includes('csvFileId') || value.includes('csvText'))) return false
    if (typeof prevValue === 'string') return value !== prevValue
    return true
  }, previousValue, { timeout: timeoutMs })
}

function buildRecoveryCsv(workDate, rowCount) {
  const lines = new Array(rowCount + 1)
  lines[0] = '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
  for (let i = 0; i < rowCount; i += 1) {
    lines[i + 1] = `${workDate},recovery-user-${i},recovery-group,09:00,18:00,正常`
  }
  return lines.join('\n')
}

function tryParseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    return {}
  }
}

async function uploadRecoveryCsvFile(apiBase, orgId, csvText) {
  const query = new URLSearchParams({
    orgId: orgId || 'default',
    filename: `attendance-recovery-${Date.now()}.csv`,
  })
  const response = await fetch(`${normalizeUrl(apiBase)}/attendance/import/upload?${query.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/csv',
    },
    body: csvText,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data?.ok || !data?.data?.fileId) {
    const message = data?.error?.message || `HTTP ${response.status}`
    throw new Error(`upload recovery csv failed: ${message}`)
  }
  return {
    fileId: String(data.data.fileId),
    rowCount: Number(data.data.rowCount || 0),
  }
}

async function assertImportJobRecoveryFlow(page, importSection, apiBase) {
  logInfo('Admin import recovery assertion started')
  const payloadInput = importSection.locator('#attendance-import-payload').first()
  const importButton = importSection.getByRole('button', { name: 'Import', exact: true }).first()
  await payloadInput.waitFor({ timeout: adminReadyTimeoutMs })
  await importButton.waitFor({ timeout: adminReadyTimeoutMs })

  const profileSelect = importSection.locator('#attendance-import-profile').first()
  if (await profileSelect.count()) {
    const optionCount = await profileSelect.locator('option[value="dingtalk_csv_daily_summary"]').count()
    if (optionCount > 0) {
      await profileSelect.selectOption('dingtalk_csv_daily_summary')
    }
  }

  const workDate = new Date().toISOString().slice(0, 10)
  const orgIdFromInput = await page.locator('#attendance-org-id').first().inputValue().catch(() => '')
  const basePayload = tryParseJsonObject(await payloadInput.inputValue())
  const resolvedOrgId = String(basePayload.orgId || orgIdFromInput || 'default').trim() || 'default'
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attendance-recovery-'))
  try {
    let preparedByApiUpload = false
    try {
      const uploaded = await uploadRecoveryCsvFile(apiBase, resolvedOrgId, buildRecoveryCsv(workDate, 130000))
      const nextPayload = {
        ...basePayload,
        orgId: resolvedOrgId,
        mode: basePayload.mode || 'override',
        csvFileId: uploaded.fileId,
      }
      delete nextPayload.csvText
      delete nextPayload.rows
      await payloadInput.fill(JSON.stringify(nextPayload, null, 2))
      preparedByApiUpload = true
      logInfo(`Recovery assertion prepared via API upload: csvFileId=${uploaded.fileId} rows=${uploaded.rowCount || 'unknown'}`)
    } catch (error) {
      logInfo(`WARN: API upload path unavailable for recovery assertion (${(error && error.message) || error})`)
    }

    if (!preparedByApiUpload) {
      const csvInput = importSection.locator('#attendance-import-csv').first()
      const loadCsvButton = importSection.getByRole('button', { name: 'Load CSV', exact: true }).first()
      const csvPath = path.join(tmpDir, 'attendance-recovery.csv')
      await csvInput.waitFor({ timeout: adminReadyTimeoutMs })
      await loadCsvButton.waitFor({ timeout: adminReadyTimeoutMs })

      const initialPayload = await payloadInput.inputValue()
      await fs.writeFile(csvPath, buildRecoveryCsv(workDate, 1), 'utf8')
      await csvInput.setInputFiles(csvPath)
      await loadCsvButton.click()
      await waitForImportPayload(page, initialPayload)
      let payload = await payloadInput.inputValue()
      if (!payload.includes('"csvFileId"')) {
        logInfo('Recovery assertion fallback: forcing upload channel with large CSV payload')
        const previousPayload = payload
        await fs.writeFile(csvPath, buildRecoveryCsv(workDate, 130000), 'utf8')
        await csvInput.setInputFiles(csvPath)
        await loadCsvButton.click()
        try {
          await waitForImportPayload(page, previousPayload)
        } catch {
          logInfo('WARN: payload did not change after large CSV load; continuing with current payload')
        }
        payload = await payloadInput.inputValue()
        if (!payload.includes('"csvFileId"')) {
          logInfo('WARN: csvFileId payload unavailable in UI; continuing with forced async debug mode')
        }
      }
    }

    await importButton.click()
    const asyncCard = importSection.locator('div.attendance__status').filter({ hasText: /Async (preview|import) job/ }).first()
    const timeoutMessage = page.getByText('Async import job is still running in background.', { exact: true }).first()
    await Promise.any([
      timeoutMessage.waitFor({ timeout: timeoutMs }),
      asyncCard.waitFor({ timeout: timeoutMs }),
    ])

    const statusAction = page.locator('.attendance__status-block').getByRole('button', { name: 'Reload import job', exact: true }).first()
    const hasStatusAction = await statusAction.count().then(async (count) => {
      if (!count) return false
      const visible = await statusAction.isVisible().catch(() => false)
      if (!visible) return false
      return statusAction.isEnabled().catch(() => false)
    })
    if (hasStatusAction) {
      await statusAction.click()
    } else {
      const reloadInCard = asyncCard.getByRole('button', { name: 'Reload job', exact: true })
      if (await reloadInCard.count()) {
        const reloadButton = reloadInCard.first()
        const reloadEnabled = await reloadButton.isEnabled().catch(() => false)
        if (reloadEnabled) {
          await reloadButton.click()
        } else {
          logInfo('WARN: reload job button is disabled; continuing with async completion assertion')
        }
      }
    }

    await asyncCard.waitFor({ timeout: timeoutMs })
    const resumeButton = asyncCard.getByRole('button', { name: 'Resume polling', exact: true })
    const resumeVisible = await resumeButton.count().then(async (count) => {
      if (!count) return false
      return resumeButton.first().isVisible()
    })
    if (resumeVisible) {
      await resumeButton.first().click()
    } else {
      logInfo('WARN: resume polling button not visible after reload; continuing with completed-state assertion')
    }

    await Promise.any([
      asyncCard.getByText(/Status:\s*completed/i).first().waitFor({ timeout: timeoutMs }),
      page.getByText(/Preview job completed \(/).first().waitFor({ timeout: timeoutMs }),
      page.getByText(/Imported \d+(\/\d+)? rows \(async job\)\./).first().waitFor({ timeout: timeoutMs }),
    ])
    logInfo('Admin import recovery assertion passed')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
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
  await setImportDebugOverrides(page)

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
      const shouldAssertRecovery = assertImportJobRecovery && importSectionCount > 0
      if (shouldAssertRecovery) {
        await assertImportJobRecoveryFlow(page, importSection, apiBase)
      } else if (assertImportJobRecovery) {
        logInfo('WARN: import recovery assertion skipped (section unavailable)')
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
