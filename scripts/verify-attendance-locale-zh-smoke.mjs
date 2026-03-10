import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/'
const apiBase = resolveApiBase(process.env.API_BASE || '')
let authToken = String(process.env.AUTH_TOKEN || '').trim()
const loginEmail = String(process.env.LOGIN_EMAIL || '').trim()
const loginPassword = String(process.env.LOGIN_PASSWORD || '')
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.UI_TIMEOUT || 45000)
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/attendance-locale-zh-smoke'
const orgId = String(process.env.ORG_ID || 'default').trim()
const verifyHoliday = process.env.VERIFY_HOLIDAY !== 'false'

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function resolveApiBase(value) {
  const trimmed = normalizeUrl(value)
  if (trimmed.length > 0) return trimmed
  try {
    const parsed = new URL(webUrl)
    return `${normalizeUrl(parsed.origin)}/api`
  } catch {
    return ''
  }
}

function log(message) {
  console.log(`[attendance-locale-zh-smoke] ${message}`)
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toDateKey(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildApiPath(pathname, query = {}) {
  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim().length > 0) {
      params.set(key, String(value))
    }
  })
  const suffix = params.toString()
  return suffix.length > 0 ? `${pathname}?${suffix}` : pathname
}

async function apiRequest(pathname, init = {}, tokenValue = authToken) {
  if (!apiBase) throw new Error('API_BASE is required')
  const url = `${apiBase}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
  const headers = { ...(init.headers || {}) }
  if (tokenValue) {
    headers.Authorization = `Bearer ${tokenValue}`
  }
  const response = await fetch(url, {
    ...init,
    headers,
  })
  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }
  return { response, payload }
}

async function apiRequestJson(pathname, init = {}, tokenValue = authToken) {
  const { response, payload } = await apiRequest(pathname, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  }, tokenValue)
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`
    throw new Error(`API ${pathname} failed: ${message}`)
  }
  return payload
}

function extractTokenFromPayload(payload) {
  const value = payload?.data?.token ?? payload?.token ?? ''
  return typeof value === 'string' ? value.trim() : ''
}

async function validateTokenWithAuthMe(tokenValue) {
  if (!tokenValue) return { usable: false, reason: 'missing' }
  try {
    const { response, payload } = await apiRequest('/auth/me', { method: 'GET' }, tokenValue)
    if (response.ok && payload?.ok !== false && payload?.success !== false) {
      return { usable: true, reason: 'ok' }
    }
    if (response.status === 401 || response.status === 403) {
      return { usable: false, reason: `http_${response.status}` }
    }
    if (response.ok && (payload?.ok === false || payload?.success === false)) {
      return { usable: false, reason: 'payload_rejected' }
    }
    return { usable: null, reason: `http_${response.status}` }
  } catch (error) {
    return { usable: null, reason: `network:${error?.message || error}` }
  }
}

async function loginForToken() {
  const payload = await apiRequestJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: loginEmail,
      password: loginPassword,
    }),
  }, '')
  const nextToken = extractTokenFromPayload(payload)
  if (!nextToken) {
    throw new Error('POST /auth/login returned empty token')
  }
  return nextToken
}

async function refreshTokenFromApi(tokenValue) {
  const payload = await apiRequestJson('/auth/refresh-token', {
    method: 'POST',
    body: JSON.stringify({ token: tokenValue }),
  }, '')
  const nextToken = extractTokenFromPayload(payload)
  if (!nextToken) {
    throw new Error('POST /auth/refresh-token returned empty token')
  }
  return nextToken
}

async function resolveAuthToken() {
  if (authToken) {
    const status = await validateTokenWithAuthMe(authToken)
    if (status.usable === true) {
      return 'token'
    }
    if (status.usable === null) {
      log(`AUTH_TOKEN validation inconclusive (${status.reason}), keep using AUTH_TOKEN`)
      return 'token'
    }
    log(`AUTH_TOKEN is not usable (${status.reason}), trying refresh/login fallback`)

    try {
      const refreshedToken = await refreshTokenFromApi(authToken)
      const refreshStatus = await validateTokenWithAuthMe(refreshedToken)
      if (refreshStatus.usable !== false) {
        authToken = refreshedToken
        if (refreshStatus.usable === null) {
          log(`Refresh token validation inconclusive (${refreshStatus.reason}), continue with refreshed token`)
        }
        return 'refresh'
      }
      log(`refresh token is not usable (${refreshStatus.reason}), continue to login fallback`)
    } catch (error) {
      log(`refresh fallback failed: ${error?.message || error}`)
    }
  }

  if (!loginEmail || !loginPassword) {
    if (authToken) {
      throw new Error('AUTH_TOKEN is invalid and LOGIN_EMAIL/LOGIN_PASSWORD are missing')
    }
    throw new Error('AUTH_TOKEN is required (or provide LOGIN_EMAIL/LOGIN_PASSWORD)')
  }

  const loginToken = await loginForToken()
  const loginStatus = await validateTokenWithAuthMe(loginToken)
  if (loginStatus.usable === false) {
    throw new Error('Login succeeded but returned token is unusable')
  }
  if (loginStatus.usable === null) {
    log(`Login token validation inconclusive (${loginStatus.reason}), continue with login token`)
  }
  authToken = loginToken
  return 'login'
}

function pickHolidayDate(existingDates, year, monthIndex) {
  const preferredDays = [15, 16, 17, 18, 19, 20, 10, 11, 12, 13, 14, 21, 22, 23, 24, 25, 26, 27, 28, 9, 8, 7, 6, 5, 4, 3, 2, 1]
  for (const day of preferredDays) {
    const date = new Date(year, monthIndex - 1, day)
    const key = toDateKey(date)
    if (!existingDates.has(key)) return key
  }
  return null
}

function parseCalendarYearMonth(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim()
  const zhMatch = text.match(/(\d{4})\D+(\d{1,2})/)
  if (zhMatch) {
    return {
      year: Number(zhMatch[1]),
      month: Number(zhMatch[2]),
    }
  }
  const enMatch = text.match(/^([A-Za-z]+)\s+(\d{4})$/)
  if (enMatch) {
    const monthMap = {
      january: 1,
      february: 2,
      march: 3,
      april: 4,
      may: 5,
      june: 6,
      july: 7,
      august: 8,
      september: 9,
      october: 10,
      november: 11,
      december: 12,
    }
    const month = monthMap[String(enMatch[1]).toLowerCase()]
    if (month) {
      return {
        year: Number(enMatch[2]),
        month,
      }
    }
  }
  return null
}

function monthRange(year, monthIndex) {
  const start = new Date(year, monthIndex - 1, 1)
  const end = new Date(year, monthIndex, 0)
  return {
    monthStart: toDateKey(start),
    monthEnd: toDateKey(end),
  }
}

async function ensureHolidayExistsForMonth(from, to, expectedId) {
  const listQuery = buildApiPath('/attendance/holidays', { orgId, from, to })
  const listPayload = await apiRequestJson(listQuery, { method: 'GET' })
  const items = Array.isArray(listPayload?.data?.items) ? listPayload.data.items : []
  if (!items.some(item => String(item?.id || '') === String(expectedId || ''))) {
    throw new Error(`Created holiday id not found via API list (${from}..${to})`)
  }
}

async function findHolidayBadgeAcrossMonths(page, holidayName) {
  const target = page.locator('.attendance__calendar-holiday', { hasText: holidayName }).first()
  const navPlan = [
    null,
    'next',
    'next',
    'prev',
    'prev',
    'prev',
  ]
  const navButtonByStep = {
    next: page.getByRole('button', { name: /^(Next|下月)$/ }),
    prev: page.getByRole('button', { name: /^(Prev|上月)$/ }),
  }

  for (const step of navPlan) {
    if (step) {
      await navButtonByStep[step].first().click()
      await page.waitForLoadState('networkidle', { timeout: timeoutMs })
    }
    const count = await target.count()
    if (count > 0) {
      await target.waitFor({ timeout: 5000 })
      return true
    }
  }
  const calendarLabel = await page.locator('.attendance__calendar-label').first().textContent().catch(() => '')
  const badgeTexts = await page.locator('.attendance__calendar-holiday').allTextContents().catch(() => [])
  throw new Error(
    `Holiday badge not visible for "${holidayName}". calendarLabel="${(calendarLabel || '').trim()}", badges=${JSON.stringify(badgeTexts.slice(0, 12))}`,
  )
}

async function findAnyHolidayBadgeAcrossMonths(page) {
  const target = page.locator('.attendance__calendar-holiday')
  const navPlan = [
    null,
    'next',
    'next',
    'prev',
    'prev',
    'prev',
  ]
  const navButtonByStep = {
    next: page.getByRole('button', { name: /^(Next|下月)$/ }),
    prev: page.getByRole('button', { name: /^(Prev|上月)$/ }),
  }

  for (const step of navPlan) {
    if (step) {
      await navButtonByStep[step].first().click()
      await page.waitForLoadState('networkidle', { timeout: timeoutMs })
    }
    const count = await target.count()
    if (count > 0) {
      const calendarLabel = await page.locator('.attendance__calendar-label').first().textContent().catch(() => '')
      const badgeTexts = await target.allTextContents().catch(() => [])
      return {
        count,
        calendarLabel: String(calendarLabel || '').trim(),
        badgeTexts: badgeTexts.slice(0, 12),
      }
    }
  }

  const calendarLabel = await page.locator('.attendance__calendar-label').first().textContent().catch(() => '')
  throw new Error(`Holiday badges are not visible across probed months. calendarLabel="${String(calendarLabel || '').trim()}"`)
}

async function verifyLunarLabelsMeaningful(page) {
  const sampleTexts = await page
    .locator('.attendance__calendar-lunar')
    .allTextContents()
    .catch(() => [])
  const normalized = sampleTexts.map(text => String(text || '').trim()).filter(Boolean)
  if (normalized.length === 0) {
    throw new Error('Expected lunar labels in calendar cells, found none')
  }
  const meaningful = normalized.some(text => /[初十廿卅正冬腊闰月]/.test(text))
  if (!meaningful) {
    throw new Error(`Lunar labels are present but not meaningful: ${JSON.stringify(normalized.slice(0, 12))}`)
  }
  return normalized
}

async function waitForLocatorCount(locator, predicate, label, timeout = 5000, interval = 120) {
  const startedAt = Date.now()
  let lastCount = -1
  while (Date.now() - startedAt <= timeout) {
    lastCount = await locator.count().catch(() => 0)
    if (predicate(lastCount)) return lastCount
    await sleep(interval)
  }
  throw new Error(`${label} (timeout=${timeout}ms, lastCount=${lastCount})`)
}

async function getCalendarFlagCheckbox(page, textPattern, labelName) {
  const flags = page.locator('.attendance__calendar-flags').first()
  await flags.waitFor({ timeout: timeoutMs })
  const row = flags.locator('.attendance__calendar-flag', { hasText: textPattern }).first()
  await row.waitFor({ timeout: timeoutMs })
  const checkbox = row.locator('input[type="checkbox"]').first()
  await checkbox.waitFor({ timeout: timeoutMs })
  const count = await checkbox.count()
  if (count === 0) {
    throw new Error(`Calendar toggle checkbox not found: ${labelName}`)
  }
  return checkbox
}

async function setCalendarFlag(checkbox, checked, labelName) {
  await checkbox.setChecked(checked, { timeout: timeoutMs })
  const actual = await checkbox.isChecked()
  if (actual !== checked) {
    throw new Error(`Failed to set ${labelName} to ${checked ? 'on' : 'off'}`)
  }
}

async function verifyCalendarToggleChecks(page, options = {}) {
  const requireHolidayVisible = options.requireHolidayVisible !== false
  const toggleCheck = {
    lunarOffNoBadge: false,
    lunarOnRecovered: false,
    holidayOffNoBadge: false,
    holidayOnRecovered: false,
  }

  const lunarCheckbox = await getCalendarFlagCheckbox(page, /(Lunar|农历)/i, 'Lunar/农历')
  const holidayCheckbox = await getCalendarFlagCheckbox(page, /(Holiday|节假日)/i, 'Holiday/节假日')

  await setCalendarFlag(lunarCheckbox, true, 'Lunar/农历')
  await setCalendarFlag(holidayCheckbox, true, 'Holiday/节假日')

  const lunarBadgeLocator = page.locator('.attendance__calendar-lunar')
  const holidayBadgeLocator = page.locator('.attendance__calendar-holiday')

  await waitForLocatorCount(lunarBadgeLocator, count => count > 0, 'Expected lunar labels before toggling')
  const holidayBaseline = requireHolidayVisible
    ? await waitForLocatorCount(holidayBadgeLocator, count => count > 0, 'Expected holiday badges before toggling')
    : await holidayBadgeLocator.count().catch(() => 0)

  await setCalendarFlag(holidayCheckbox, false, 'Holiday/节假日')
  await waitForLocatorCount(holidayBadgeLocator, count => count === 0, 'Expected no holiday badges when Holiday is off')
  toggleCheck.holidayOffNoBadge = true

  await setCalendarFlag(holidayCheckbox, true, 'Holiday/节假日')
  const holidayRecoveredPredicate = requireHolidayVisible
    ? (count) => count > 0
    : (count) => count >= holidayBaseline
  await waitForLocatorCount(holidayBadgeLocator, holidayRecoveredPredicate, 'Expected holiday badges to recover when Holiday is on')
  toggleCheck.holidayOnRecovered = true

  await setCalendarFlag(lunarCheckbox, false, 'Lunar/农历')
  await waitForLocatorCount(lunarBadgeLocator, count => count === 0, 'Expected no lunar labels when Lunar is off')
  toggleCheck.lunarOffNoBadge = true

  await setCalendarFlag(lunarCheckbox, true, 'Lunar/农历')
  await waitForLocatorCount(lunarBadgeLocator, count => count > 0, 'Expected lunar labels to recover when Lunar is on')
  toggleCheck.lunarOnRecovered = true

  return toggleCheck
}

async function writeSummaryJson(filePath, summary) {
  await fs.writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

async function run() {
  await ensureDir(outputDir)
  const summaryPath = path.join(outputDir, 'attendance-zh-locale-summary.json')
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    webUrl: normalizeUrl(webUrl),
    apiBase,
    orgId,
    verifyHoliday,
    status: 'fail',
    locale: 'zh-CN',
    lunarCount: 0,
    lunarSamples: [],
    holidayCheck: verifyHoliday ? 'enabled' : 'disabled',
    holidayBadgeCount: 0,
    holidayCalendarLabel: '',
    holidayBadgeSamples: [],
    createdHolidayId: null,
    createdHolidayDate: null,
    createdHolidayName: null,
    screenshot: null,
    failScreenshot: null,
    cleanup: {
      holidayDeleted: false,
      error: null,
    },
    error: null,
    authSource: 'unknown',
    toggleCheck: {
      lunarOffNoBadge: false,
      lunarOnRecovered: false,
      holidayOffNoBadge: false,
      holidayOnRecovered: false,
    },
    // backward-compatible aliases used by some local tooling
    ok: false,
    holidayCheckEnabled: verifyHoliday,
    lunarLabelCount: 0,
  }

  let createdHolidayId = null
  let createdHolidayName = null
  let createdHolidayDate = null

  let browser = null
  let page = null

  try {
    const authSource = await resolveAuthToken()
    summary.authSource = authSource
    log(`auth resolved via ${authSource}`)

    browser = await chromium.launch({ headless })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    })
    page = await context.newPage()

    await page.addInitScript((payload) => {
      if (payload?.token) {
        localStorage.setItem('auth_token', payload.token)
      }
      localStorage.setItem('metasheet_locale', 'zh-CN')
    }, { token: authToken })

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

    const lunarSamples = await verifyLunarLabelsMeaningful(page)
    const lunarCount = lunarSamples.length
    summary.lunarCount = lunarCount
    summary.lunarLabelCount = lunarCount
    summary.lunarSamples = lunarSamples.slice(0, 20)

    if (verifyHoliday) {
      const calendarLabelNode = page.locator('.attendance__calendar-label').first()
      await calendarLabelNode.waitFor({ timeout: timeoutMs })
      const calendarLabelText = await calendarLabelNode.textContent().catch(() => '')
      let ym = parseCalendarYearMonth(calendarLabelText)
      if (!ym) {
        const toDateValue = await page.locator('#attendance-to-date').inputValue().catch(() => '')
        const toDateMatch = String(toDateValue).match(/^(\d{4})-(\d{2})-/)
        if (toDateMatch) {
          ym = {
            year: Number(toDateMatch[1]),
            month: Number(toDateMatch[2]),
          }
        } else {
          ym = await page.evaluate(() => {
            const d = new Date()
            return { year: d.getFullYear(), month: d.getMonth() + 1 }
          })
        }
      }
      const { monthStart, monthEnd } = monthRange(ym.year, ym.month)
      const listQuery = buildApiPath('/attendance/holidays', {
        orgId,
        from: monthStart,
        to: monthEnd,
      })
      const listPayload = await apiRequestJson(listQuery, { method: 'GET' })
      const items = Array.isArray(listPayload?.data?.items) ? listPayload.data.items : []
      const existingDates = new Set(items.map(item => String(item?.date || '')))
      const candidateDate = pickHolidayDate(existingDates, ym.year, ym.month)
      if (!candidateDate) {
        throw new Error(`Unable to allocate a holiday date for ${ym.year}-${String(ym.month).padStart(2, '0')} (days 1-28 all occupied)`)
      }
      createdHolidayName = `回归节-${Date.now().toString().slice(-6)}`
      const createPayload = await apiRequestJson('/attendance/holidays', {
        method: 'POST',
        body: JSON.stringify({
          orgId,
          date: candidateDate,
          name: createdHolidayName,
          isWorkingDay: false,
        }),
      })
      createdHolidayId = String(createPayload?.data?.id || '')
      createdHolidayDate = candidateDate
      summary.createdHolidayId = createdHolidayId
      summary.createdHolidayDate = createdHolidayDate
      summary.createdHolidayName = createdHolidayName
      if (!createdHolidayId) {
        throw new Error('Create holiday returned empty id')
      }
      log(`created holiday: ${createdHolidayDate} ${createdHolidayName} (${createdHolidayId})`)

      await ensureHolidayExistsForMonth(monthStart, monthEnd, createdHolidayId)
      // Align the UI query window with the target month so the just-created holiday is fetched.
      const fromInput = page.locator('#attendance-from-date')
      const toInput = page.locator('#attendance-to-date')
      await fromInput.fill(monthStart)
      await toInput.fill(monthEnd)
      await page.getByRole('button', { name: /^(Refresh|刷新)$/ }).first().click()
      await page.waitForLoadState('networkidle', { timeout: timeoutMs })
      await page.waitForTimeout(300)

      await findHolidayBadgeAcrossMonths(page, createdHolidayName)
      const badgeProbe = await findAnyHolidayBadgeAcrossMonths(page)
      summary.holidayBadgeCount = Number(badgeProbe.count || 0)
      summary.holidayCalendarLabel = String(badgeProbe.calendarLabel || '')
      summary.holidayBadgeSamples = Array.isArray(badgeProbe.badgeTexts) ? badgeProbe.badgeTexts.slice(0, 12) : []
      log(
        `holiday badges visible: target="${createdHolidayName}", count=${badgeProbe.count}, month=${badgeProbe.calendarLabel}, samples=${JSON.stringify(badgeProbe.badgeTexts)}`,
      )
    }

    summary.toggleCheck = await verifyCalendarToggleChecks(page, {
      requireHolidayVisible: verifyHoliday,
    })

    const screenshotPath = path.join(outputDir, 'attendance-zh-locale-calendar.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })
    summary.screenshot = screenshotPath
    summary.failScreenshot = null
    summary.error = null
    summary.status = 'pass'
    summary.ok = true

    const togglePass = Object.values(summary.toggleCheck).every(Boolean)
    log(`PASS: locale=zh-CN, lunarLabels=${lunarCount}, holidayCheck=${verifyHoliday ? 'on' : 'off'}, toggleCheck=${togglePass ? 'pass' : 'fail'}, authSource=${summary.authSource}, screenshot=${screenshotPath}`)
  } catch (error) {
    summary.status = 'fail'
    summary.error = (error && error.message) || String(error)
    const failShot = path.join(outputDir, 'attendance-zh-locale-calendar-fail.png')
    try {
      if (page) {
        await page.screenshot({ path: failShot, fullPage: true })
      }
      summary.failScreenshot = failShot
      if (!summary.screenshot) {
        summary.screenshot = failShot
      }
      log(`captured failure screenshot: ${failShot}`)
    } catch {
      // ignore screenshot failure
    }
    throw error
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
    if (createdHolidayId) {
      try {
        await apiRequestJson(`/attendance/holidays/${createdHolidayId}`, {
          method: 'DELETE',
        })
        summary.cleanup.holidayDeleted = true
        summary.cleanup.error = null
        log(`deleted holiday: ${createdHolidayId}`)
      } catch (error) {
        summary.cleanup.holidayDeleted = false
        summary.cleanup.error = (error && error.message) || String(error)
        log(`WARN cleanup failed for holiday ${createdHolidayId}: ${error?.message || error}`)
      }
    }
    try {
      await writeSummaryJson(summaryPath, summary)
      log(`summary json: ${summaryPath}`)
    } catch (error) {
      log(`WARN write summary failed: ${error?.message || error}`)
    }
  }
}

run().catch((error) => {
  const message = (error && error.message) || String(error)
  console.error(`[attendance-locale-zh-smoke] FAIL: ${message}`)
  process.exitCode = 1
})
