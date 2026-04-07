import fs from 'fs'
import path from 'path'
import { chromium } from '@playwright/test'
import { resolveMultitableAuthToken } from './multitable-auth.mjs'

const apiBase = process.env.API_BASE || 'http://127.0.0.1:7778'
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8899'
const outputDir = process.env.OUTPUT_DIR || 'output/playwright/multitable-grid-profile'
const reportPath = process.env.REPORT_JSON || path.join(outputDir, 'report.json')
const headless = process.env.HEADLESS !== 'false'
const timeoutMs = Number(process.env.TIMEOUT_MS || 30000)
const rowCount = Number(process.env.ROW_COUNT || 500)
const seedConcurrency = Number(process.env.SEED_CONCURRENCY || 8)

const report = {
  ok: true,
  apiBase,
  webBase,
  headless,
  rowCount,
  startedAt: new Date().toISOString(),
  checks: [],
  metrics: {},
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details })
  if (!ok) report.ok = false
}

function metric(name, durationMs, details = {}) {
  report.metrics[name] = {
    durationMs: Number(durationMs.toFixed(2)),
    ...details,
  }
}

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const json = await res.json().catch(() => ({}))
  return { res, json }
}

async function ensureOk(name, result, details = {}) {
  const ok = Boolean(result?.res?.ok && (result?.json?.ok ?? true))
  record(name, ok, {
    status: result?.res?.status ?? 0,
    ...details,
    ...(ok ? {} : { body: result?.json }),
  })
  if (!ok) {
    const permissionDenied = result?.res?.status === 403 && result?.json?.error === 'Insufficient permissions'
    if (permissionDenied) {
      throw new Error(`${name} failed: insufficient permissions. Restart backend with RBAC_TOKEN_TRUST=true or use a real admin token.`)
    }
    throw new Error(`${name} failed`)
  }
  return result.json
}

async function measure(name, fn, details = {}) {
  const started = performance.now()
  const value = await fn()
  const durationMs = performance.now() - started
  metric(name, durationMs, details)
  return value
}

async function getAuthToken() {
  const perms = [
    'multitable:read',
    'multitable:write',
    'comments:read',
    'comments:write',
    'permissions:read',
    'permissions:write',
  ].join(',')
  return resolveMultitableAuthToken({
    apiBase,
    envToken: process.env.AUTH_TOKEN || '',
    fetchJson,
    record,
    perms,
  })
}

async function fetchHealth() {
  const result = await fetchJson(`${apiBase}/health`)
  await ensureOk('api.health', result)
}

async function fetchBases(token) {
  const result = await fetchJson(`${apiBase}/api/multitable/bases`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.bases', result)
  return Array.isArray(json?.data?.bases) ? json.data.bases : []
}

async function fetchContext(token, query) {
  const result = await fetchJson(`${apiBase}/api/multitable/context?${new URLSearchParams(query).toString()}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.context', result, query)
  return json.data
}

async function createSheet(token, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/sheets`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.create-sheet', result, {
    sheetId: input.id,
    baseId: input.baseId,
    description: input.description,
    seed: input.seed,
  })
  return json.data.sheet
}

async function fetchFields(token, sheetId) {
  const result = await fetchJson(`${apiBase}/api/multitable/fields?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.fields', result, { sheetId })
  return Array.isArray(json?.data?.fields) ? json.data.fields : []
}

async function createField(token, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/fields`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.create-field', result, {
    fieldId: input.id,
    sheetId: input.sheetId,
    type: input.type,
  })
  return json.data.field
}

async function fetchViews(token, sheetId) {
  const result = await fetchJson(`${apiBase}/api/multitable/views?sheetId=${encodeURIComponent(sheetId)}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.views', result, { sheetId })
  return Array.isArray(json?.data?.views) ? json.data.views : []
}

async function createView(token, input) {
  const result = await fetchJson(`${apiBase}/api/multitable/views`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const json = await ensureOk('api.multitable.create-view', result, {
    viewId: input.id,
    sheetId: input.sheetId,
    type: input.type,
  })
  return json.data.view
}

async function fetchViewData(token, params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const result = await fetchJson(`${apiBase}/api/multitable/view?${query.toString()}`, {
    headers: headers(token),
  })
  const json = await ensureOk('api.multitable.view', result, params)
  return json.data
}

async function createRecord(token, input, options = {}) {
  const result = await fetchJson(`${apiBase}/api/multitable/records`, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  })
  const ok = Boolean(result?.res?.ok && (result?.json?.ok ?? true))
  if (!ok) {
    await ensureOk('api.multitable.create-record', result, {
      sheetId: input.sheetId,
    })
  }
  if (!options.quiet) {
    record('api.multitable.create-record', true, { sheetId: input.sheetId })
  }
  const json = result.json
  return json.data.record
}

async function ensureProfileSheet(token, baseId) {
  const context = await fetchContext(token, { baseId })
  const existing = Array.isArray(context?.sheets)
    ? context.sheets.find((sheet) => sheet.id === 'sheet_multitable_grid_profile' || sheet.name === 'Multitable Grid Profile')
    : null
  if (existing) return existing
  return createSheet(token, {
    id: 'sheet_multitable_grid_profile',
    baseId,
    name: 'Multitable Grid Profile',
    description: 'Persistent profiling sheet for multitable grid performance checks',
    seed: false,
  })
}

async function ensureProfileField(token, sheetId) {
  const fields = await fetchFields(token, sheetId)
  const existing = fields.find((field) => field.id === 'fld_profile_title' || (field.name === 'Title' && field.type === 'string'))
  if (existing) return existing
  return createField(token, {
    id: 'fld_profile_title',
    sheetId,
    name: 'Title',
    type: 'string',
  })
}

async function ensureProfileView(token, sheetId) {
  const views = await fetchViews(token, sheetId)
  const existing = views.find((view) => view.id === 'view_profile_grid' || (view.type === 'grid' && view.name === 'Profile Grid'))
  if (existing) return existing
  return createView(token, {
    id: 'view_profile_grid',
    sheetId,
    type: 'grid',
    name: 'Profile Grid',
  })
}

function buildProfileTitle(index) {
  return `GridProfile-${String(index).padStart(4, '0')}`
}

async function seedProfileRows(token, sheetId, fieldId, currentTotal) {
  if (currentTotal >= rowCount) return { created: 0, total: currentTotal }
  let nextIndex = currentTotal + 1
  let created = 0

  async function worker() {
    while (nextIndex <= rowCount) {
      const index = nextIndex++
      await createRecord(token, {
        sheetId,
        data: {
          [fieldId]: buildProfileTitle(index),
        },
      }, { quiet: true })
      created += 1
    }
  }

  const workers = Array.from({ length: Math.max(1, seedConcurrency) }, () => worker())
  await Promise.all(workers)
  record('api.grid.seed.rows', true, { created, total: currentTotal + created })
  return { created, total: currentTotal + created }
}

function multitableUrl(baseId, sheetId, viewId) {
  const query = new URLSearchParams({ baseId })
  return `${webBase}/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}?${query.toString()}`
}

async function profileBrowserGrid({ token, baseId, sheetId, viewId, targetTitle }) {
  const browser = await chromium.launch({ headless })
  const context = await browser.newContext()
  await context.addInitScript((authToken) => {
    localStorage.setItem('auth_token', authToken)
    localStorage.setItem('jwt', authToken)
  }, token)
  const page = await context.newPage()

  try {
    const gridUrl = multitableUrl(baseId, sheetId, viewId)
    const openStarted = performance.now()
    await page.goto(gridUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.getByRole('searchbox', { name: 'Search records' }).waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('.meta-grid__row').first().waitFor({ state: 'visible', timeout: timeoutMs })
    metric('ui.grid.open', performance.now() - openStarted, { url: gridUrl })

    const search = page.getByRole('searchbox', { name: 'Search records' })
    const searchStarted = performance.now()
    await search.fill(targetTitle)
    await page.getByText('1 rows').waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('.meta-grid__row').filter({ hasText: targetTitle }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    metric('ui.grid.search-hit', performance.now() - searchStarted, { targetTitle })

    await page.screenshot({ path: path.join(outputDir, 'grid-profile.png'), fullPage: true })
    record('ui.grid.profile', true, { targetTitle })
  } finally {
    await browser.close()
  }
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true })

  await fetchHealth()
  const token = await getAuthToken()
  const bases = await fetchBases(token)
  let base = bases.find((item) => item.id === 'base_legacy') || bases[0]
  if (!base) {
    const createdSheet = await createSheet(token, {
      id: 'sheet_multitable_grid_profile_bootstrap',
      name: 'Grid Profile Bootstrap',
      description: 'Bootstrap sheet for multitable grid profiling',
      seed: false,
    })
    base = { id: createdSheet.baseId, name: 'Migrated Base' }
  }

  const sheet = await ensureProfileSheet(token, base.id)
  const titleField = await ensureProfileField(token, sheet.id)
  const gridView = await ensureProfileView(token, sheet.id)

  const initialData = await measure('api.grid.initial-load', () =>
    fetchViewData(token, {
      sheetId: sheet.id,
      viewId: gridView.id,
      limit: 50,
      offset: 0,
    }),
  )

  const initialTotal = initialData?.page?.total ?? 0
  const seeded = await measure('api.grid.seed', () =>
    seedProfileRows(token, sheet.id, titleField.id, initialTotal),
    { initialTotal, targetRowCount: rowCount },
  )

  const targetTitle = buildProfileTitle(Math.max(1, Math.min(rowCount, seeded.total)))

  const searchHit = await measure('api.grid.search-hit', () =>
    fetchViewData(token, {
      sheetId: sheet.id,
      viewId: gridView.id,
      limit: 10,
      offset: 0,
      search: targetTitle,
    }),
    { targetTitle },
  )
  const searchHitRows = Array.isArray(searchHit?.rows) ? searchHit.rows.length : 0
  record('api.grid.search-hit', searchHitRows >= 1, { targetTitle, rows: searchHitRows })

  const missTerm = `GridProfile-MISS-${Date.now()}`
  const searchMiss = await measure('api.grid.search-miss', () =>
    fetchViewData(token, {
      sheetId: sheet.id,
      viewId: gridView.id,
      limit: 10,
      offset: 0,
      search: missTerm,
    }),
    { missTerm },
  )
  const missRows = Array.isArray(searchMiss?.rows) ? searchMiss.rows.length : 0
  record('api.grid.search-miss', missRows === 0, { missTerm, rows: missRows })

  await profileBrowserGrid({
    token,
    baseId: base.id,
    sheetId: sheet.id,
    viewId: gridView.id,
    targetTitle,
  })

  report.metadata = {
    baseId: base.id,
    sheetId: sheet.id,
    viewId: gridView.id,
    titleFieldId: titleField.id,
    seededRows: seeded.total,
    createdRows: seeded.created,
    targetTitle,
  }
}

run()
  .then(() => {
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exit(1)
  })
  .catch((err) => {
    report.ok = false
    report.finishedAt = new Date().toISOString()
    report.error = err?.message || String(err)
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.error(report.error)
    process.exit(1)
  })
