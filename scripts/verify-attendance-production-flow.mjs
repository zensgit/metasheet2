import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'node:crypto'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/'
const apiBaseEnv = process.env.API_BASE || ''
let token = process.env.AUTH_TOKEN || ''
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 60000)
const mobile = process.env.UI_MOBILE === 'true'
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/attendance-production-flow'
const allowLegacyImport = process.env.ALLOW_LEGACY_IMPORT === '1'

function logInfo(message) {
  console.log(`[attendance-production-flow] ${message}`)
}

function logWarn(message) {
  console.warn(`[attendance-production-flow] WARN: ${message}`)
}

function normalizeWebAttendanceUrl(raw) {
  const url = new URL(raw)
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/attendance'
    return url.toString()
  }
  if (!url.pathname.startsWith('/attendance')) {
    url.pathname = '/attendance'
  }
  return url.toString()
}

function deriveApiBase(rawWebUrl) {
  if (apiBaseEnv) return apiBaseEnv.replace(/\/+$/, '')
  const url = new URL(rawWebUrl)
  return `${url.origin}/api`
}

async function refreshAuthToken(apiBase) {
  if (!apiBase || !token) return false
  const url = `${apiBase.replace(/\/+$/, '')}/auth/refresh-token`
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
      logWarn(`token refresh failed: HTTP ${res.status}`)
      return false
    }
    const nextToken = body?.data?.token
    if (typeof nextToken === 'string' && nextToken.length > 20) {
      token = nextToken
      return true
    }
    logWarn('token refresh response missing token')
    return false
  } catch (error) {
    logWarn(`token refresh error: ${(error && error.message) || String(error)}`)
    return false
  }
}

async function apiGetJson(url, tokenValue) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokenValue}`,
    },
  })
  const raw = await res.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  return { status: res.status, ok: res.ok, body, raw }
}

async function setAuth(page) {
  if (!token) return
  await page.addInitScript((value) => {
    if (value) localStorage.setItem('auth_token', value)
  }, token)
}

async function ensureAttendanceLoaded(page) {
  await page.waitForURL(/\/attendance(\?|$)/, { timeout: timeoutMs })
  await page.getByRole('heading', { name: 'Attendance', exact: true }).waitFor({ timeout: timeoutMs })
}

function getRecordsCard(page) {
  return page.locator('section.attendance__card').filter({
    has: page.getByRole('heading', { name: 'Records' }),
  })
}

async function waitForJsonResponse(page, predicate, { label }) {
  const response = await page.waitForResponse(predicate, { timeout: timeoutMs })
  const raw = await response.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  if (!response.ok()) {
    throw new Error(`${label} failed: HTTP ${response.status()} ${raw.slice(0, 200)}`)
  }
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(`${label} failed: ${JSON.stringify(body).slice(0, 200)}`)
  }
  return { response, body, raw }
}

async function waitForImportCommitSuccess(page) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      page.off('response', onResponse)
      reject(new Error('Import commit did not succeed before timeout'))
    }, timeoutMs)

    async function onResponse(resp) {
      try {
        if (settled) return
        if (resp.request().method() !== 'POST') return
        const pathname = new URL(resp.url()).pathname
        if (pathname !== '/api/attendance/import/commit' && pathname !== '/api/attendance/import') return

        const raw = await resp.text()
        let body = null
        try {
          body = raw ? JSON.parse(raw) : null
        } catch {
          body = null
        }

        if (resp.ok() && body && typeof body === 'object' && body.ok !== false) {
          if (pathname === '/api/attendance/import') {
            if (!allowLegacyImport) {
              settled = true
              clearTimeout(timer)
              page.off('response', onResponse)
              reject(new Error('Legacy /api/attendance/import was used. Expected /api/attendance/import/commit in production.'))
              return
            }
            logWarn('Import succeeded via legacy /api/attendance/import endpoint.')
          }
          settled = true
          clearTimeout(timer)
          page.off('response', onResponse)
          resolve({ response: resp, body, raw })
          return
        }

        const code = body?.error?.code
        if (code === 'COMMIT_TOKEN_INVALID' || code === 'COMMIT_TOKEN_REQUIRED') {
          logWarn(`Import attempt rejected: ${code}`)
          return
        }

        // Non-retryable failures should surface quickly.
        settled = true
        clearTimeout(timer)
        page.off('response', onResponse)
        reject(new Error(`Import failed: HTTP ${resp.status()} ${raw.slice(0, 200)}`))
      } catch (error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        page.off('response', onResponse)
        reject(error)
      }
    }

    page.on('response', onResponse)
  })
}

async function clickAndMaybeContinue(promise, onErrorMessage) {
  try {
    await promise
    return { ok: true }
  } catch (error) {
    logWarn(`${onErrorMessage}: ${(error && error.message) || String(error)}`)
    return { ok: false, error }
  }
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function formatDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  return `${y}-${m}-${d}T${hh}:${mm}`
}

async function run() {
  if (!token) {
    console.error('[attendance-production-flow] AUTH_TOKEN is required')
    process.exit(1)
  }

  const attendanceUrl = normalizeWebAttendanceUrl(webUrl)
  const apiBase = deriveApiBase(attendanceUrl)
  logInfo(`WEB_URL=${attendanceUrl}`)
  logInfo(`API_BASE=${apiBase}`)

  await refreshAuthToken(apiBase)

  const me = await apiGetJson(`${apiBase}/auth/me`, token)
  if (!me.ok) {
    throw new Error(`GET /auth/me failed: ${me.status} ${me.raw.slice(0, 200)}`)
  }
  const meData = me.body?.data ?? {}
  const user = meData?.user ?? meData?.userInfo ?? meData?.me ?? {}
  const features = meData?.features ?? {}
  const userId = user?.userId || user?.id || user?.user_id
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin' || Boolean(features.attendanceAdmin)
  if (!features?.attendance) {
    throw new Error('Feature flag attendance=false (attendance plugin not available for this token)')
  }

  logInfo(`features=${JSON.stringify(features)}`)

  await fs.mkdir(outputDir, { recursive: true })

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
  })
  const page = await context.newPage()
  await setAuth(page)

  // 1) Load attendance overview.
  logInfo('Navigating to attendance page')
  await page.goto(attendanceUrl, { waitUntil: 'networkidle', timeout: timeoutMs })
  await ensureAttendanceLoaded(page)
  await page.screenshot({ path: path.join(outputDir, '01-overview-loaded.png'), fullPage: true })

  // Ensure records can be refreshed before any mutations.
  logInfo('Refreshing records')
  await page.getByRole('button', { name: 'Refresh' }).click()
  const recordsCard = getRecordsCard(page)
  await recordsCard.getByRole('button', { name: 'Reload' }).click()

  // 2) Punch flow (best-effort: constraints can legitimately block).
  logInfo('Attempting punch: check_in')
  await clickAndMaybeContinue(
    (async () => {
      const punchResp = waitForJsonResponse(
        page,
        (resp) => resp.request().method() === 'POST' && resp.url().includes('/api/attendance/punch'),
        { label: 'Punch' }
      )
      await page.getByRole('button', { name: 'Check In' }).click()
      const { body } = await punchResp
      logInfo(`Punch API ok: ${Boolean(body?.ok)} workDate=${body?.data?.record?.workDate || ''}`)
    })(),
    'Punch check_in failed'
  )

  // 3) Create an adjustment request (missed_check_in) (best-effort).
  logInfo('Attempting adjustment request submission')
  const today = new Date()
  const workDate = formatDateOnly(today)
  const start = new Date(today)
  start.setHours(9, 0, 0, 0)
  const end = new Date(today)
  end.setHours(18, 0, 0, 0)
  await clickAndMaybeContinue(
    (async () => {
      await page.locator('#attendance-request-work-date').fill(workDate)
      await page.locator('#attendance-request-type').selectOption('missed_check_in')
      await page.locator('#attendance-request-in').fill(formatDatetimeLocal(start))
      await page.locator('#attendance-request-out').fill(formatDatetimeLocal(end))
      const reqResp = waitForJsonResponse(
        page,
        (resp) => resp.request().method() === 'POST' && resp.url().includes('/api/attendance/requests'),
        { label: 'Submit request' }
      )
      await page.getByRole('button', { name: 'Submit request' }).click()
      const { body } = await reqResp
      logInfo(`Request API ok: ${Boolean(body?.ok)} id=${body?.data?.request?.id || ''}`)
    })(),
    'Adjustment request submission failed'
  )
  await page.screenshot({ path: path.join(outputDir, '02-overview-after-request.png'), fullPage: true })

  // 4) Admin import flow (required for production readiness).
  if (!isAdmin) {
    throw new Error('Admin features are required for production flow verification, but token is not admin')
  }

  logInfo('Entering Admin Center')
  await page.getByRole('button', { name: 'Admin Center' }).click()
  if (mobile) {
    await page.getByRole('heading', { name: 'Desktop recommended' }).waitFor({ timeout: timeoutMs })
    await page.screenshot({ path: path.join(outputDir, '03-admin-mobile-gated.png'), fullPage: true })
    throw new Error('UI_MOBILE=true: admin import flow is desktop-only; rerun without UI_MOBILE')
  }

  await page.locator('text=Import (DingTalk / Manual)').first().waitFor({ timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, '03-admin-loaded.png'), fullPage: true })

  // 4.1) Permission provisioning UI (P1): grant a minimal role to a random UUID and verify it loads.
  logInfo('Validating permission provisioning UI')
  const provisionUserId = randomUUID()
  const userAccessSection = page.locator('div.attendance__admin-section').filter({
    has: page.getByRole('heading', { name: 'User Access' }),
  })
  await userAccessSection.getByLabel('User ID (UUID)').fill(provisionUserId)
  await userAccessSection.locator('#attendance-provision-role').selectOption('employee')

  const grantResp = waitForJsonResponse(
    page,
    (resp) => resp.request().method() === 'POST' && resp.url().includes('/api/permissions/grant'),
    { label: 'Grant permission' }
  )
  await userAccessSection.getByRole('button', { name: 'Grant role' }).click()
  await grantResp
  await userAccessSection.locator('text=attendance:read').waitFor({ timeout: timeoutMs })
  await userAccessSection.locator('text=attendance:write').waitFor({ timeout: timeoutMs })

  const loadResp = waitForJsonResponse(
    page,
    (resp) => resp.request().method() === 'GET' && resp.url().includes(`/api/permissions/user/${provisionUserId}`),
    { label: 'Load permissions' }
  )
  await userAccessSection.getByRole('button', { name: 'Load' }).click()
  await loadResp
  await page.screenshot({ path: path.join(outputDir, '03a-admin-user-access.png'), fullPage: true })

  const importSection = page.locator('div.attendance__admin-section').filter({
    has: page.getByRole('heading', { name: 'Import (DingTalk / Manual)' }),
  })

  logInfo('Loading import template')
  await importSection.getByRole('button', { name: 'Load template' }).click()
  await page.locator('#attendance-import-payload').waitFor({ timeout: timeoutMs })

  // Prepare a tiny CSV with explicit UserId so we don't need user-map.
  const groupName = `E2E Group ${Date.now().toString(36)}`
  const csvText = [
    '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果',
    `${workDate},${userId || 'unknown-user'},${groupName},09:00,18:00,正常`,
  ].join('\n')

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attendance-import-'))
  const csvPath = path.join(tmpDir, 'attendance-sample.csv')
  await fs.writeFile(csvPath, csvText, 'utf-8')

  logInfo('Selecting mapping profile + CSV')
  await page.locator('#attendance-import-profile').selectOption('dingtalk_csv_daily_summary')
  await page.locator('#attendance-import-csv').setInputFiles(csvPath)
  await page.locator('#attendance-import-group-create').check()
  await page.locator('#attendance-import-group-assign').check()

  logInfo('Applying CSV into payload')
  await importSection.getByRole('button', { name: 'Load CSV' }).click()
  await page.waitForFunction(() => {
    const el = document.querySelector('#attendance-import-payload')
    const value = el && 'value' in el ? el.value : ''
    return typeof value === 'string' && value.includes('csvText')
  })

  logInfo('Applying mapping profile into payload')
  await importSection.getByRole('button', { name: 'Apply profile' }).click()

  logInfo('Preview import')
  const previewResp = waitForJsonResponse(
    page,
    (resp) => resp.request().method() === 'POST' && resp.url().includes('/api/attendance/import/preview'),
    { label: 'Import preview' }
  )
  await importSection.getByRole('button', { name: 'Preview' }).click()
  const previewJson = await previewResp
  const previewTable = importSection.locator('table.attendance__table').filter({
    has: page.getByRole('columnheader', { name: 'Policies' }),
  })
  await previewTable.locator('tbody tr').first().waitFor({ timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, '04-import-preview.png'), fullPage: true })
  logInfo(`Preview API ok: items=${previewJson.body?.data?.items?.length ?? 0}`)

  logInfo('Commit import')
  const commitResp = waitForImportCommitSuccess(page)
  await importSection.getByRole('button', { name: 'Import' }).click()
  const commitJson = await commitResp
  logInfo(`Import API ok: imported=${commitJson.body?.data?.imported ?? 0}`)
  if (commitJson.response && new URL(commitJson.response.url()).pathname !== '/api/attendance/import/commit') {
    throw new Error('Import did not use /api/attendance/import/commit. Set ALLOW_LEGACY_IMPORT=1 only for legacy servers.')
  }
  const batchId = commitJson.body?.data?.batchId
  if (!batchId) {
    throw new Error('Expected batchId from import commit response, but it was missing')
  }

  // Ensure batch list has at least one row.
  await page.getByRole('button', { name: 'Reload batches' }).click()
  await page.locator('text=Import batches').waitFor({ timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, '05-import-batches.png'), fullPage: true })

  const batchItems = await apiGetJson(`${apiBase}/attendance/import/batches/${batchId}/items?pageSize=200`, token)
  if (!batchItems.ok) {
    throw new Error(`GET /attendance/import/batches/:id/items failed: ${batchItems.status}`)
  }
  const batchItemRows = batchItems.body?.data?.items || []
  if (!Array.isArray(batchItemRows) || batchItemRows.length === 0) {
    throw new Error('Expected at least 1 batch item row after import commit, but got 0')
  }

  // API-side assertion: group exists and user is a member.
  logInfo('Verifying group + membership via API')
  const groups = await apiGetJson(`${apiBase}/attendance/groups?pageSize=200`, token)
  if (!groups.ok) {
    throw new Error(`GET /attendance/groups failed: ${groups.status}`)
  }
  const groupItems = groups.body?.data?.items || []
  const created = groupItems.find((item) => item && item.name === groupName)
  if (!created?.id) {
    throw new Error('Expected created attendance group not found via API')
  }
  const members = await apiGetJson(`${apiBase}/attendance/groups/${created.id}/members?pageSize=200`, token)
  if (!members.ok) {
    throw new Error(`GET /attendance/groups/:id/members failed: ${members.status}`)
  }
  const memberItems = members.body?.data?.items || []
  if (userId && !memberItems.some((m) => m && m.userId === userId)) {
    throw new Error('Expected importing user to be a member of created group')
  }

  // 5) Back to overview and verify records can be refreshed for that date.
  logInfo('Returning to Overview')
  await page.getByRole('button', { name: 'Overview' }).click()
  await ensureAttendanceLoaded(page)
  await page.locator('#attendance-from-date').fill(workDate)
  await page.locator('#attendance-to-date').fill(workDate)
  if (userId) {
    await page.locator('#attendance-user-id').fill(userId)
  }
  await page.getByRole('button', { name: 'Refresh' }).click()
  const recordsCardAfter = getRecordsCard(page)
  await recordsCardAfter.getByRole('button', { name: 'Reload' }).click()
  await page.screenshot({ path: path.join(outputDir, '06-overview-after-import.png'), fullPage: true })

  await context.close()
  await browser.close()
  logInfo('Production flow verification complete')
}

run().catch((error) => {
  console.error('[attendance-production-flow] Failed:', error)
  process.exit(1)
})
