import { chromium } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

const webUrl = process.env.WEB_URL || 'http://localhost:8899/'
const apiBase = resolveApiBase(process.env.API_BASE || '')
const token = process.env.AUTH_TOKEN || ''
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

async function apiRequest(pathname, init = {}) {
  if (!apiBase) throw new Error('API_BASE is required')
  const url = `${apiBase}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(init.headers || {}),
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

async function apiRequestJson(pathname, init = {}) {
  const { response, payload } = await apiRequest(pathname, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`
    throw new Error(`API ${pathname} failed: ${message}`)
  }
  return payload
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

async function run() {
  if (!token) {
    throw new Error('AUTH_TOKEN is required')
  }

  await ensureDir(outputDir)

  let createdHolidayId = null
  let createdHolidayName = null
  let createdHolidayDate = null

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

    const lunarSamples = await verifyLunarLabelsMeaningful(page)
    const lunarCount = lunarSamples.length

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
      if (!createdHolidayId) {
        throw new Error('Create holiday returned empty id')
      }
      log(`created holiday: ${createdHolidayDate} ${createdHolidayName} (${createdHolidayId})`)

      await ensureHolidayExistsForMonth(monthStart, monthEnd, createdHolidayId)
      await findHolidayBadgeAcrossMonths(page, createdHolidayName)
      const badgeProbe = await findAnyHolidayBadgeAcrossMonths(page)
      log(
        `holiday badges visible: target="${createdHolidayName}", count=${badgeProbe.count}, month=${badgeProbe.calendarLabel}, samples=${JSON.stringify(badgeProbe.badgeTexts)}`,
      )
    }

    const screenshotPath = path.join(outputDir, 'attendance-zh-locale-calendar.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })

    log(`PASS: locale=zh-CN, lunarLabels=${lunarCount}, holidayCheck=${verifyHoliday ? 'on' : 'off'}, screenshot=${screenshotPath}`)
  } catch (error) {
    const failShot = path.join(outputDir, 'attendance-zh-locale-calendar-fail.png')
    try {
      await page.screenshot({ path: failShot, fullPage: true })
      log(`captured failure screenshot: ${failShot}`)
    } catch {
      // ignore screenshot failure
    }
    throw error
  } finally {
    await browser.close()
    if (createdHolidayId) {
      try {
        await apiRequestJson(`/attendance/holidays/${createdHolidayId}`, {
          method: 'DELETE',
        })
        log(`deleted holiday: ${createdHolidayId}`)
      } catch (error) {
        log(`WARN cleanup failed for holiday ${createdHolidayId}: ${error?.message || error}`)
      }
    }
  }
}

run().catch((error) => {
  const message = (error && error.message) || String(error)
  console.error(`[attendance-locale-zh-smoke] FAIL: ${message}`)
  process.exitCode = 1
})
