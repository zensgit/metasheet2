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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function fetchJsonWithRetry(url, options = {}, { attempts = 5, delayMs = 1000 } = {}) {
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fetchJson(url, options)
      last = result
      if (result.res.ok && result.json?.ok) return result
      const isDbNotReady = result.res.status === 503 && result.json?.error?.code === 'DB_NOT_READY'
      if (!isDbNotReady) return result
    } catch (err) {
      last = {
        res: { ok: false, status: 0 },
        json: { error: { code: 'FETCH_ERROR', message: err?.message || String(err) } },
      }
    }
    if (attempt < attempts) {
      await sleep(delayMs)
    }
  }
  return last ?? { res: { ok: false, status: 0 }, json: {} }
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

  const metaSheets = await fetchJsonWithRetry(`${apiBase}/api/univer-meta/sheets`, { headers })
  const sheetsOk = Boolean(metaSheets.res.ok && metaSheets.json?.ok)
  record('api.univer-meta.sheets', sheetsOk, { status: metaSheets.res.status })
  if (!sheetsOk) {
    throw new Error('Meta sheets check failed')
  }
  const sheets = Array.isArray(metaSheets.json?.data?.sheets) ? metaSheets.json.data.sheets : []

  const metaFields = await fetchJsonWithRetry(`${apiBase}/api/univer-meta/fields`, { headers })
  const fieldsOk = Boolean(metaFields.res.ok && metaFields.json?.ok)
  record('api.univer-meta.fields', fieldsOk, { status: metaFields.res.status })
  if (!fieldsOk) {
    throw new Error('Meta fields check failed')
  }

  const metaViews = await fetchJsonWithRetry(`${apiBase}/api/univer-meta/views`, { headers })
  const viewsOk = Boolean(metaViews.res.ok && metaViews.json?.ok)
  record('api.univer-meta.views', viewsOk, { status: metaViews.res.status })
  if (!viewsOk) {
    throw new Error('Meta views check failed')
  }

  const sheetId = sheets[0]?.id
  if (sheetId) {
    const metaRecords = await fetchJsonWithRetry(
      `${apiBase}/api/univer-meta/records-summary?sheetId=${encodeURIComponent(sheetId)}`,
      { headers },
    )
    const recordsOk = Boolean(metaRecords.res.ok && metaRecords.json?.ok)
    record('api.univer-meta.records-summary', recordsOk, { status: metaRecords.res.status })
    if (!recordsOk) {
      throw new Error('Meta records summary check failed')
    }
  } else {
    record('api.univer-meta.records-summary', true, { skipped: true })
  }

  record('api.spreadsheets', true, { skipped: true })

  if (process.env.SMOKE_SKIP_WEB === 'true') {
    record('web.home', true, { skipped: true })
  } else {
    const webRes = await fetchText(`${webBase}/`)
    const hasMetaSheet = /metasheet/i.test(webRes.text)
    const hasAppRoot = /id=["']app["']/.test(webRes.text)
    const webOk = webRes.res.ok && (hasMetaSheet || hasAppRoot)
    record('web.home', webOk, { status: webRes.res.status })
    if (!webOk) {
      throw new Error('Web home check failed')
    }
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
