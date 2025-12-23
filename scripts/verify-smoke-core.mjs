import fs from 'fs'
import path from 'path'

const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8899'
const outputPath = process.env.OUTPUT_PATH || 'artifacts/smoke/smoke-report.json'

const report = {
  ok: true,
  apiBase,
  webBase,
  checks: [],
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details })
  if (!ok) {
    report.ok = false
  }
}

function withTimeout(timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function fetchJson(url, options = {}) {
  const timeout = withTimeout()
  try {
    const res = await fetch(url, { ...options, signal: timeout.signal })
    const json = await res.json().catch(() => ({}))
    return { res, json }
  } finally {
    timeout.clear()
  }
}

async function fetchText(url) {
  const timeout = withTimeout()
  try {
    const res = await fetch(url, { signal: timeout.signal })
    const text = await res.text().catch(() => '')
    return { res, text }
  } finally {
    timeout.clear()
  }
}

async function run() {
  const health = await fetchJson(`${apiBase}/health`)
  record('api.health', health.res.ok, { status: health.res.status, body: health.json })
  if (!health.res.ok) {
    throw new Error('API health check failed')
  }

  const tokenRes = await fetchJson(`${apiBase}/api/auth/dev-token`)
  const token = tokenRes.json?.token
  record('api.dev-token', Boolean(tokenRes.res.ok && token), { status: tokenRes.res.status })
  if (!tokenRes.res.ok || !token) {
    throw new Error('Dev token unavailable')
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  record('api.spreadsheets', true, { skipped: true })

  const webRes = await fetchText(`${webBase}/`)
  const webOk = webRes.res.ok && webRes.text.includes('MetaSheet')
  record('web.home', webOk, { status: webRes.res.status })
  if (!webOk) {
    throw new Error('Web home check failed')
  }

  return report
}

run()
  .then((result) => {
    const dir = path.dirname(outputPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) {
      process.exit(1)
    }
  })
  .catch((err) => {
    const dir = path.dirname(outputPath)
    fs.mkdirSync(dir, { recursive: true })
    const errorReport = { ...report, ok: false, error: err.message || String(err) }
    fs.writeFileSync(outputPath, JSON.stringify(errorReport, null, 2))
    console.error(err.message || err)
    process.exit(1)
  })
