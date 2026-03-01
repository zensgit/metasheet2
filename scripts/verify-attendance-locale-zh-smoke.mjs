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

function pickHolidayDate(existingDates) {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  for (let day = 1; day <= 28; day += 1) {
    const date = new Date(year, month, day)
    const key = toDateKey(date)
    if (!existingDates.has(key)) return key
  }
  return null
}

async function run() {
  if (!token) {
    throw new Error('AUTH_TOKEN is required')
  }

  await ensureDir(outputDir)

  const monthStartDate = new Date()
  monthStartDate.setDate(1)
  const monthEndDate = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth() + 1, 0)
  const monthStart = toDateKey(monthStartDate)
  const monthEnd = toDateKey(monthEndDate)

  let createdHolidayId = null
  let createdHolidayName = null
  let createdHolidayDate = null

  if (verifyHoliday) {
    const listQuery = buildApiPath('/attendance/holidays', {
      orgId,
      from: monthStart,
      to: monthEnd,
    })
    const listPayload = await apiRequestJson(listQuery, { method: 'GET' })
    const items = Array.isArray(listPayload?.data?.items) ? listPayload.data.items : []
    const existingDates = new Set(items.map(item => String(item?.date || '')))
    const candidateDate = pickHolidayDate(existingDates)
    if (!candidateDate) {
      throw new Error('Unable to allocate a holiday date in the current month (days 1-28 all occupied)')
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
  }

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

    const lunarLabels = page.locator('.attendance__calendar-lunar')
    const lunarCount = await lunarLabels.count()
    if (lunarCount <= 0) {
      throw new Error('Expected lunar labels in calendar cells, found none')
    }

    if (verifyHoliday && createdHolidayName && createdHolidayDate) {
      await page.locator('#attendance-from-date').fill(monthStart)
      await page.locator('#attendance-to-date').fill(monthEnd)
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await page.waitForLoadState('networkidle', { timeout: timeoutMs })
      await page.locator('.attendance__calendar-holiday', { hasText: createdHolidayName }).first().waitFor({ timeout: timeoutMs })
    }

    const screenshotPath = path.join(outputDir, 'attendance-zh-locale-calendar.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })

    log(`PASS: locale=zh-CN, lunarLabels=${lunarCount}, holidayCheck=${verifyHoliday ? 'on' : 'off'}, screenshot=${screenshotPath}`)
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
