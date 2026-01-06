import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { chromium } from '@playwright/test'

const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8899'
const outputDir = process.env.OUTPUT_DIR || 'artifacts/univer-poc'
const reportJson =
  process.env.REPORT_JSON || path.join(outputDir, 'verify-univer-ui-smoke.json')
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.TIMEOUT_MS || 15000)
const autoStart = process.env.AUTO_START !== 'false'

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

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const json = await res.json().catch(() => ({}))
  return { res, json }
}

async function fetchText(url) {
  const res = await fetch(url)
  const text = await res.text().catch(() => '')
  return { res, text }
}

async function isApiUp() {
  try {
    const { res } = await fetchJson(`${apiBase}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function isWebUp() {
  try {
    const { res } = await fetchText(`${webBase}/`)
    return res.ok
  } catch {
    return false
  }
}

function normalizeStatus(text) {
  return (text || '').trim()
}

function isLoadedStatus(text) {
  const status = normalizeStatus(text)
  if (status === 'Loaded') return true
  return /^Loaded \+\d+/.test(status)
}

let started = false

async function ensureServices() {
  const apiUp = await isApiUp()
  const webUp = await isWebUp()
  const allowStart = autoStart
  record('preflight.api', apiUp || allowStart, {
    url: `${apiBase}/health`,
    running: apiUp,
  })
  record('preflight.web', webUp || allowStart, {
    url: `${webBase}/`,
    running: webUp,
  })

  if (apiUp && webUp) return

  if (!autoStart) {
    throw new Error('Services not running and AUTO_START=false')
  }

  execSync('bash scripts/start-univer-poc.sh', {
    stdio: 'inherit',
    env: { ...process.env, API_BASE: apiBase, WEB_BASE: webBase },
  })
  started = true

  const apiReady = await isApiUp()
  const webReady = await isWebUp()
  record('preflight.api.after_start', apiReady, { url: `${apiBase}/health` })
  record('preflight.web.after_start', webReady, { url: `${webBase}/` })

  if (!apiReady || !webReady) {
    throw new Error('Services failed to start')
  }
}

async function getToken() {
  const { res, json } = await fetchJson(`${apiBase}/api/auth/dev-token`)
  const token = json?.token || ''
  record('api.dev-token', Boolean(res.ok && token), { status: res.status })
  if (!res.ok || !token) {
    throw new Error('Dev token unavailable')
  }
  return token
}

async function verifyPage(page, pathName, statusSelector) {
  await page.goto(`${webBase}${pathName}`, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  })

  await page.waitForSelector(statusSelector, { timeout: timeoutMs })
  const statusText = await page.locator(statusSelector).innerText()
  const ok = isLoadedStatus(statusText)
  record(`ui${pathName}.status`, ok, { statusText })
}

async function run() {
  await ensureServices()
  const token = await getToken()

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext()
  await context.addInitScript((authToken) => {
    localStorage.setItem('auth_token', authToken)
  }, token)

  const page = await context.newPage()

  try {
    await verifyPage(page, '/univer', '.univer-poc__status')
    await verifyPage(page, '/univer-kanban', '.univer-kanban__status')
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
  .finally(() => {
    if (started) {
      try {
        execSync('bash scripts/stop-univer-poc.sh', { stdio: 'inherit' })
      } catch {
        // best-effort cleanup
      }
    }
  })
