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
const apiRetryAttempts = Math.max(1, Number(process.env.API_RETRY_ATTEMPTS || 5))
const apiRetryDelayMs = Math.max(100, Number(process.env.API_RETRY_DELAY_MS || 1000))
const apiTimeoutMs = Math.max(1000, Number(process.env.API_TIMEOUT_MS || 60000))

function logInfo(message) {
  console.log(`[attendance-production-flow] ${message}`)
}

function logWarn(message) {
  console.warn(`[attendance-production-flow] WARN: ${message}`)
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function exactNamePattern(names) {
  const alternatives = names.map(escapeRegExp).join('|')
  return new RegExp(`^(?:${alternatives})$`, 'i')
}

const uiText = {
  attendanceHeadings: ['Attendance', 'Attendance Reports', '考勤', '考勤报表'],
  records: ['Records', '记录'],
  reports: ['Reports', '报表'],
  overview: ['Overview', '总览'],
  checkIn: ['Check In', '上班打卡'],
  adminCenter: ['Admin Center', '管理中心'],
  desktopRecommended: ['Desktop recommended', '建议使用桌面端'],
  userAccess: ['User Access', '用户权限'],
  submitRequest: ['Submit request', '提交申请'],
  refresh: ['Refresh', '刷新'],
  reload: ['Reload', '重载'],
  import: ['Import', '导入'],
  assignRole: ['Assign role', '分配角色'],
  load: ['Load', '加载'],
  loadTemplate: ['Load template', '加载模板'],
  loadCsv: ['Load CSV', '加载 CSV'],
  applyProfile: ['Apply profile', '应用配置'],
  preview: ['Preview', '预览'],
  reloadBatches: ['Reload batches', '重载批次'],
  importHeading: ['Import (DingTalk / Manual)', '导入（钉钉 / 手工）'],
  importBatchesHeading: ['Import batches', '导入批次'],
  policies: ['Policies', '规则', '规则策略'],
  userIdUuid: ['User ID (UUID)', '用户 ID（UUID）'],
}

function buttonByNames(page, names, options = {}) {
  return page.getByRole('button', {
    name: exactNamePattern(names),
    exact: options.exact ?? true,
  })
}

function headingByNames(scope, names) {
  return scope.getByRole('heading', { name: exactNamePattern(names) })
}

const localizedHeadingNames = new Map([
  ['User Access', uiText.userAccess],
  ['Import (DingTalk / Manual)', uiText.importHeading],
  ['Import batches', uiText.importBatchesHeading],
])

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 504)
}

async function fetchWithRetry(url, init = {}, options = {}) {
  const label = options.label || url
  const allowRefresh = options.allowRefresh !== false
  const refreshFn = typeof options.refreshFn === 'function' ? options.refreshFn : null

  for (let attempt = 1; attempt <= apiRetryAttempts; attempt += 1) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(apiTimeoutMs)
        : undefined
      const res = await fetch(url, { ...init, signal })
      if (res.status === 401 && allowRefresh && refreshFn && attempt < apiRetryAttempts) {
        const refreshed = await refreshFn()
        if (refreshed) {
          const delayMs = Math.min(apiRetryDelayMs * attempt, 5000)
          logWarn(`${label} got 401; refreshed token and retrying in ${delayMs}ms`)
          await sleep(delayMs)
          continue
        }
      }
      if (isRetriableStatus(res.status) && attempt < apiRetryAttempts) {
        const delayMs = Math.min(apiRetryDelayMs * attempt, 5000)
        logWarn(`${label} returned HTTP ${res.status}; retry ${attempt}/${apiRetryAttempts} in ${delayMs}ms`)
        await sleep(delayMs)
        continue
      }
      return res
    } catch (error) {
      if (attempt >= apiRetryAttempts) throw error
      const delayMs = Math.min(apiRetryDelayMs * attempt, 5000)
      logWarn(`${label} network error: ${(error && error.message) || String(error)}; retry ${attempt}/${apiRetryAttempts} in ${delayMs}ms`)
      await sleep(delayMs)
    }
  }
  throw new Error(`${label}: exhausted retries`)
}

async function refreshAuthToken(apiBase) {
  if (!apiBase || !token) return false
  const url = `${apiBase.replace(/\/+$/, '')}/auth/refresh-token`
  try {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }, { label: 'POST /auth/refresh-token', allowRefresh: false })
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
  const refreshBase = apiBaseEnv ? apiBaseEnv.replace(/\/+$/, '') : deriveApiBase(webUrl)
  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${tokenValue}`,
    },
  }, {
    label: `GET ${(() => {
      try {
        return new URL(url).pathname
      } catch {
        return url
      }
    })()}`,
    refreshFn: async () => refreshAuthToken(refreshBase),
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
  await page.waitForFunction(
    () => {
      const pathname = String(window.location?.pathname || '')
      return pathname === '/attendance' || pathname.startsWith('/attendance/')
    },
    { timeout: timeoutMs },
  )

  const heading = headingByNames(page, uiText.attendanceHeadings).first()
  try {
    await heading.waitFor({ timeout: timeoutMs })
    return
  } catch (error) {
    const shell = page.locator('.attendance, .attendance-shell').first()
    if (await shell.isVisible().catch(() => false)) {
      logWarn('Attendance route shell is visible, but localized attendance heading was not found; continuing with route-level fallback')
      return
    }
    throw error
  }
}

function getRecordsCard(page) {
  return page.locator('section.attendance__card').filter({
    has: headingByNames(page, uiText.records),
  })
}

const adminSectionIds = {
  userAccess: 'attendance-admin-user-access',
  import: 'attendance-admin-import',
  importBatches: 'attendance-admin-import-batches',
}

async function getVisibleRecordsCard(page) {
  const recordsCard = getRecordsCard(page)
  if (await recordsCard.count() && await recordsCard.first().isVisible().catch(() => false)) return recordsCard

  const reportsTab = buttonByNames(page, uiText.reports)
  if (await reportsTab.count()) {
    logInfo('Records card not visible on overview; switching to Reports tab')
    await reportsTab.first().click()
    await recordsCard.first().waitFor({ timeout: timeoutMs })
    return recordsCard
  }

  throw new Error('Records card is not visible and Reports tab is unavailable')
}

async function switchToOverview(page) {
  const overviewTab = buttonByNames(page, uiText.overview)
  if (await overviewTab.count()) {
    await overviewTab.first().click()
    await buttonByNames(page, uiText.checkIn).waitFor({ timeout: timeoutMs })
  }
}

async function selectAdminSection(page, sectionId, headingName, waitMs = timeoutMs) {
  const quickJump = page.locator('[data-admin-quick-jump="true"]').first()
  if (await quickJump.count()) {
    await quickJump.selectOption(sectionId)
  }

  const section = page.locator(`[data-admin-section="${sectionId}"]`).first()
  await section.waitFor({ state: 'visible', timeout: waitMs })
  if (headingName) {
    await headingByNames(section, localizedHeadingNames.get(headingName) || [headingName]).waitFor({ timeout: waitMs })
  }
  return section
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

function isImportCommitUrl(url) {
  try {
    const pathname = new URL(url).pathname
    return pathname === '/api/attendance/import/commit' || pathname === '/api/attendance/import'
  } catch {
    return false
  }
}

async function clickImportAndWaitForCommitResponse(page, importSection) {
  const responsePromise = page.waitForResponse((resp) => {
    if (resp.request().method() !== 'POST') return false
    return isImportCommitUrl(resp.url())
  }, { timeout: timeoutMs })
  await importSection.getByRole('button', { name: exactNamePattern(uiText.import) }).click()
  const response = await responsePromise
  const raw = await response.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  return { response, body, raw }
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

async function normalizeImportPayloadTextarea(importSection) {
  const payloadInput = importSection.locator('#attendance-import-payload').first()
  const raw = await payloadInput.inputValue()
  let payload = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    return
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return

  let changed = false
  if (Array.isArray(payload.columns) && payload.columns.some((column) => typeof column !== 'object' || column === null || !('id' in column))) {
    delete payload.columns
    changed = true
  }

  if (changed) {
    await payloadInput.fill(JSON.stringify(payload, null, 2))
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
  const refreshButton = buttonByNames(page, uiText.refresh)
  if (await refreshButton.count()) {
    await refreshButton.first().click()
  }
  const recordsCard = await getVisibleRecordsCard(page)
  await recordsCard.getByRole('button', { name: exactNamePattern(uiText.reload) }).click()
  await switchToOverview(page)

  // 2) Punch flow (best-effort: constraints can legitimately block).
  logInfo('Attempting punch: check_in')
  await clickAndMaybeContinue(
    (async () => {
      const punchResp = waitForJsonResponse(
        page,
        (resp) => resp.request().method() === 'POST' && resp.url().includes('/api/attendance/punch'),
        { label: 'Punch' }
      )
      await buttonByNames(page, uiText.checkIn).click()
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
      await buttonByNames(page, uiText.submitRequest).click()
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
  await buttonByNames(page, uiText.adminCenter).click()
  if (mobile) {
    await headingByNames(page, uiText.desktopRecommended).waitFor({ timeout: timeoutMs })
    await page.screenshot({ path: path.join(outputDir, '03-admin-mobile-gated.png'), fullPage: true })
    throw new Error('UI_MOBILE=true: admin import flow is desktop-only; rerun without UI_MOBILE')
  }

  const userAccessSection = await selectAdminSection(page, adminSectionIds.userAccess, 'User Access')
  await page.screenshot({ path: path.join(outputDir, '03-admin-loaded.png'), fullPage: true })

  // 4.1) Permission provisioning UI (P1): grant a minimal role to a random UUID and verify it loads.
  logInfo('Validating permission provisioning UI')
  // Modern attendance-admin APIs require the target user to exist. Use the current user for a stable smoke check.
  const provisionUserId = userId || randomUUID()
  await userAccessSection.getByLabel(exactNamePattern(uiText.userIdUuid)).fill(provisionUserId)
  await userAccessSection.locator('#attendance-provision-role').selectOption('employee')

  const grantResp = waitForJsonResponse(
    page,
    (resp) => {
      if (resp.request().method() !== 'POST') return false
      const url = resp.url()
      return (
        url.includes(`/api/attendance-admin/users/${provisionUserId}/roles/assign`) ||
        url.includes('/api/permissions/grant')
      )
    },
    { label: 'Assign role' }
  )
  // Modern deployments use attendance-scoped role templates ("Assign role").
  // Older deployments fall back to /api/permissions/grant with the same button.
  await userAccessSection.getByRole('button', { name: exactNamePattern(uiText.assignRole) }).click()
  await grantResp
  await userAccessSection.locator('text=attendance:read').waitFor({ timeout: timeoutMs })
  await userAccessSection.locator('text=attendance:write').waitFor({ timeout: timeoutMs })

  const loadResp = waitForJsonResponse(
    page,
    (resp) => {
      if (resp.request().method() !== 'GET') return false
      const url = resp.url()
      return (
        url.includes(`/api/attendance-admin/users/${provisionUserId}/access`) ||
        url.includes(`/api/permissions/user/${provisionUserId}`)
      )
    },
    { label: 'Load user access' }
  )
  await userAccessSection.getByRole('button', { name: exactNamePattern(uiText.load) }).click()
  await loadResp
  await page.screenshot({ path: path.join(outputDir, '03a-admin-user-access.png'), fullPage: true })

  const importSection = await selectAdminSection(page, adminSectionIds.import, 'Import (DingTalk / Manual)')

  logInfo('Loading import template')
  await importSection.getByRole('button', { name: exactNamePattern(uiText.loadTemplate) }).click()
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
  await importSection.getByRole('button', { name: exactNamePattern(uiText.loadCsv) }).click()
  await page.waitForFunction(() => {
    const el = document.querySelector('#attendance-import-payload')
    const value = el && 'value' in el ? el.value : ''
    return typeof value === 'string' && value.includes('csvText')
  })

  logInfo('Applying mapping profile into payload')
  await importSection.getByRole('button', { name: exactNamePattern(uiText.applyProfile) }).click()
  await normalizeImportPayloadTextarea(importSection)

  logInfo('Preview import')
  const previewResp = waitForJsonResponse(
    page,
    (resp) => resp.request().method() === 'POST' && resp.url().includes('/api/attendance/import/preview'),
    { label: 'Import preview' }
  )
  await importSection.getByRole('button', { name: exactNamePattern(uiText.preview) }).click()
  const previewJson = await previewResp
  const previewTable = importSection.locator('table.attendance__table').filter({
    has: page.getByRole('columnheader', { name: exactNamePattern(uiText.policies) }),
  })
  await previewTable.locator('tbody tr').first().waitFor({ timeout: timeoutMs })
  await page.screenshot({ path: path.join(outputDir, '04-import-preview.png'), fullPage: true })
  logInfo(`Preview API ok: items=${previewJson.body?.data?.items?.length ?? 0}`)

  logInfo('Commit import')
  const maxCommitAttempts = Math.max(1, Number(process.env.IMPORT_COMMIT_ATTEMPTS || 5))
  let commitJson = null
  for (let attempt = 1; attempt <= maxCommitAttempts; attempt++) {
    const { response, body, raw } = await clickImportAndWaitForCommitResponse(page, importSection)
    const pathname = new URL(response.url()).pathname
    const ok = response.ok() && body && typeof body === 'object' && body.ok !== false && body.success !== false
    if (ok) {
      if (pathname === '/api/attendance/import') {
        if (!allowLegacyImport) {
          throw new Error('Legacy /api/attendance/import was used. Expected /api/attendance/import/commit in production.')
        }
        logWarn('Import succeeded via legacy /api/attendance/import endpoint.')
      }
      commitJson = { response, body, raw }
      break
    }

    const code = body?.error?.code
    const retryAfterMs = Math.max(0, Number(body?.error?.retryAfterMs ?? 0))
    if (code === 'RATE_LIMITED' || response.status() === 429) {
      const jitterMs = Math.floor(Math.random() * 120)
      const waitMs = Math.min((retryAfterMs || 500) + jitterMs, 5000)
      logWarn(`Import commit rate-limited (attempt ${attempt}/${maxCommitAttempts}); waiting ${waitMs}ms then retrying...`)
      await page.waitForTimeout(waitMs)
      continue
    }
    if (code === 'COMMIT_TOKEN_INVALID' || code === 'COMMIT_TOKEN_REQUIRED') {
      logWarn(`Import commit rejected: ${code} (attempt ${attempt}/${maxCommitAttempts}); re-running preview to refresh commitToken...`)
      const previewRetryResp = waitForJsonResponse(
        page,
        (resp) => resp.request().method() === 'POST' && resp.url().includes('/api/attendance/import/preview'),
        { label: 'Import preview (retry)' }
      )
      await importSection.getByRole('button', { name: exactNamePattern(uiText.preview) }).click()
      await previewRetryResp
      await page.waitForTimeout(250)
      continue
    }

    throw new Error(`Import failed: HTTP ${response.status()} ${raw.slice(0, 200)}`)
  }

  if (!commitJson) {
    throw new Error(`Import commit did not succeed after ${maxCommitAttempts} attempts`)
  }

  logInfo(`Import API ok: imported=${commitJson.body?.data?.imported ?? 0}`)
  if (commitJson.response && new URL(commitJson.response.url()).pathname !== '/api/attendance/import/commit') {
    throw new Error('Import did not use /api/attendance/import/commit. Set ALLOW_LEGACY_IMPORT=1 only for legacy servers.')
  }
  const batchId = commitJson.body?.data?.batchId
  if (!batchId) {
    throw new Error('Expected batchId from import commit response, but it was missing')
  }

  // Ensure batch list has at least one row.
  try {
    const importBatchesSection = await selectAdminSection(page, adminSectionIds.importBatches, 'Import batches', 5000)
    await importBatchesSection.getByRole('button', { name: exactNamePattern(uiText.reloadBatches) }).click()
  } catch (error) {
    logWarn(`Import batches UI was not reachable; continuing with API batch-item assertion: ${(error && error.message) || String(error)}`)
  }
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
  await buttonByNames(page, uiText.overview).click()
  await ensureAttendanceLoaded(page)
  await page.locator('#attendance-from-date').fill(workDate)
  await page.locator('#attendance-to-date').fill(workDate)
  if (userId) {
    await page.locator('#attendance-user-id').fill(userId)
  }
  await buttonByNames(page, uiText.refresh).click()
  const recordsCardAfter = await getVisibleRecordsCard(page)
  await recordsCardAfter.getByRole('button', { name: exactNamePattern(uiText.reload) }).click()
  await page.screenshot({ path: path.join(outputDir, '06-overview-after-import.png'), fullPage: true })

  await context.close()
  await browser.close()
  logInfo('Production flow verification complete')
}

run().catch((error) => {
  console.error('[attendance-production-flow] Failed:', error)
  process.exit(1)
})
