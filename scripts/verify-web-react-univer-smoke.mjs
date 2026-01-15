import fs from 'fs'
import path from 'path'
import { chromium } from '@playwright/test'

const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:5180'
const outputDir = process.env.OUTPUT_DIR || 'artifacts/univer-poc'
const reportJson =
  process.env.REPORT_JSON || path.join(outputDir, 'verify-web-react-univer-smoke.json')
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.TIMEOUT_MS || 30000)

const report = {
  ok: true,
  apiBase,
  webBase,
  headless,
  checks: [],
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details })
  if (!ok) {
    report.ok = false
  }
}

async function fetchText(url) {
  const res = await fetch(url)
  const text = await res.text().catch(() => '')
  return { res, text }
}

async function fetchJson(url) {
  const res = await fetch(url)
  const json = await res.json().catch(() => ({}))
  return { res, json }
}

async function preflight() {
  const api = await fetchJson(`${apiBase}/health`).catch(() => ({ res: { ok: false } }))
  record('preflight.api', Boolean(api.res?.ok), { url: `${apiBase}/health` })

  const web = await fetchText(`${webBase}/`).catch(() => ({ res: { ok: false } }))
  record('preflight.web', Boolean(web.res?.ok), { url: `${webBase}/` })

  if (!api.res?.ok || !web.res?.ok) {
    throw new Error('Preflight failed: API or Web not reachable')
  }
}

async function ensureBackendOn(page) {
  const backendBtn = page.getByRole('button', { name: /Backend/ })
  await backendBtn.waitFor({ timeout: timeoutMs })
  const text = (await backendBtn.textContent()) || ''
  if (text.includes('OFF')) {
    await backendBtn.click()
  }
  await page.getByText('ready').first().waitFor({ timeout: timeoutMs })
  record('ui.backend.on', true)
}

async function setAutoRefresh(page) {
  const autoBtn = page.getByRole('button', { name: /Auto Refresh/ })
  await autoBtn.waitFor({ timeout: timeoutMs })
  const text = (await autoBtn.textContent()) || ''
  if (text.includes('OFF')) {
    await autoBtn.click()
  }
  const intervalSelect = page.getByLabel('Interval')
  await intervalSelect.selectOption('30')
  record('ui.auto_refresh.on', true, { interval: '30' })
}

async function verifyPersisted(page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  const backendBtn = page.getByRole('button', { name: /Backend/ })
  const autoBtn = page.getByRole('button', { name: /Auto Refresh/ })
  await backendBtn.waitFor({ timeout: timeoutMs })
  await autoBtn.waitFor({ timeout: timeoutMs })
  const backendText = (await backendBtn.textContent()) || ''
  const autoText = (await autoBtn.textContent()) || ''
  const intervalSelect = page.getByLabel('Interval')
  const intervalValue = await intervalSelect.inputValue()
  const searchInput = page.getByLabel('Search')
  const searchValue = await searchInput.inputValue()
  const activeFilter = page.locator('.view-filters .filter.active')
  const activeText = (await activeFilter.textContent())?.trim() || ''
  record('ui.persist.backend', backendText.includes('ON'), { backendText })
  record('ui.persist.auto', autoText.includes('ON'), { autoText })
  record('ui.persist.interval', intervalValue === '30', { intervalValue })
  record('ui.persist.search', searchValue === 'nope', { searchValue })
  record('ui.persist.filter', activeText === 'Kanban', { activeText })
}

async function verifyFilters(page) {
  await page.getByRole('button', { name: 'Kanban' }).click()
  const activeFilter = page.locator('.view-filters .filter.active')
  const activeText = (await activeFilter.textContent())?.trim() || ''
  record('ui.filter.kanban', activeText === 'Kanban', { activeText })
}

async function verifySearch(page) {
  const searchInput = page.getByLabel('Search')
  await searchInput.fill('nope')
  const options = page.locator('#viewSelect option')
  const optionCount = await options.count()
  record('ui.search.filtered', optionCount === 1, { optionCount })
}

async function verifyClearState(page) {
  const clearBtn = page.getByRole('button', { name: 'Clear State' })
  await clearBtn.click()
  const searchInput = page.getByLabel('Search')
  const searchValue = await searchInput.inputValue()
  const activeFilter = page.locator('.view-filters .filter.active')
  const activeText = (await activeFilter.textContent())?.trim() || ''
  record('ui.clear.search', searchValue === '', { searchValue })
  record('ui.clear.filter', activeText === 'All', { activeText })
}

async function verifyErrorFlow(page) {
  const sheetInput = page.getByLabel('Sheet')
  await sheetInput.fill('missing_sheet')
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.getByText('last error:').waitFor({ timeout: timeoutMs })
  record('ui.error.last_error', true)

  const copyBtn = page.getByRole('button', { name: 'Copy error' })
  await copyBtn.click()
  const copied = page.getByText('copied')
  const copyFailed = page.getByText('copy failed')
  await Promise.race([
    copied.waitFor({ timeout: timeoutMs }),
    copyFailed.waitFor({ timeout: timeoutMs }),
  ])
  const copyStatus = (await copied.count()) ? 'copied' : 'copy failed'
  record('ui.error.copy', true, { copyStatus })

  await page.getByRole('button', { name: 'Reset' }).click()
  await page.getByText('ready').first().waitFor({ timeout: timeoutMs })
  const lastErrorVisible = (await page.locator('text=last error:').count()) > 0
  record('ui.error.cleared', !lastErrorVisible, { lastErrorVisible })
}

async function run() {
  await preflight()

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext()
  let errorFlowTriggered = false

  const consoleErrors = []
  context.on('page', (page) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })
  })

  await context.addInitScript(() => {
    localStorage.setItem('metasheet.devBackendConfig', 'true')
    localStorage.setItem('metasheet.devRefreshConfig', JSON.stringify({ autoRefresh: true, intervalSec: 30 }))
  })

  const page = await context.newPage()

  try {
    await page.goto(webBase, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.getByRole('heading', { name: 'MetaSheet Univer POC' }).waitFor({ timeout: timeoutMs })

    await ensureBackendOn(page)
    await setAutoRefresh(page)
    await verifyFilters(page)
    await verifySearch(page)
    await verifyPersisted(page)
    await verifyErrorFlow(page)
    await verifyClearState(page)
    errorFlowTriggered = true

    const allowedMessages = new Set([
      'Failed to load resource: the server responded with a status of 404 (Not Found)',
    ])
    const filteredErrors = consoleErrors.filter((entry) => {
      if (entry.includes('missing_sheet')) return false
      if (errorFlowTriggered && allowedMessages.has(entry)) return false
      return true
    })
    record('ui.console.errors', filteredErrors.length === 0, {
      count: filteredErrors.length,
      errors: filteredErrors.slice(0, 5),
      rawCount: consoleErrors.length,
    })
  } finally {
    await browser.close()
  }
}

run()
  .then(async () => {
    fs.mkdirSync(path.dirname(reportJson), { recursive: true })
    fs.writeFileSync(reportJson, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exit(1)
  })
  .catch((err) => {
    report.ok = false
    report.error = err?.message || String(err)
    fs.mkdirSync(path.dirname(reportJson), { recursive: true })
    fs.writeFileSync(reportJson, JSON.stringify(report, null, 2))
    console.error(report.error)
    process.exit(1)
  })
