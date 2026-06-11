#!/usr/bin/env node
/**
 * Multitable D2 Large-Table Perf Baseline — Backend Half (Path A)
 *
 * Implements the backend portion of the D2 perf gate harness per
 * docs/development/multitable-perf-gate-d2-design-20260524.md.
 *
 * Path A discipline: NO modification to packages/core-backend/src/**.
 * Seeds via chunked POST /api/multitable/sheets/:id/import-xlsx
 * (server cap XLSX_MAX_ROWS=50_000 → chunked at 50k).
 *
 * Per advisor structural correction: seed produces 1 aggregate timing,
 * NOT a per-record distribution. Real backend insert p50/p95/p99 comes
 * from a separate ~200-call POST /records sample; query p50/p95 from
 * separate ~50-call GET /records sample.
 *
 * Baseline assumes ENABLE_YJS_COLLAB != true on server (Yjs off).
 *
 * NEVER LOG AUTH_TOKEN.
 */

import fs from 'fs/promises'
import path from 'path'
import { performance } from 'perf_hooks'
import { createRequire } from 'module'

import {
  createUploadDispatcher,
  formatErrorWithCause,
  resolveSeedUploadTimeoutMs,
  resolveXlsxChunkSize,
} from './multitable-perf-baseline-upload.mjs'

// --- env config ---
// API_BASE normalized: strip trailing slashes AND trailing /api suffix.
// Both 'http://host:8081' and 'http://host:8081/api' work — we always
// build URLs as '${API_BASE}/api/multitable/...' (helpers convention),
// matching multitable-helpers.ts API_BASE_URL semantics.
const API_BASE = String(process.env.API_BASE || '')
  .replace(/\/+$/, '')
  .replace(/\/api$/, '')
const AUTH_TOKEN = String(process.env.AUTH_TOKEN || '')
const ROWS = Math.max(1, Number(process.env.ROWS || 10_000))
const PERF_PROFILE = String(process.env.PERF_PROFILE || 'multitable-d2-baseline')
const PHASE = String(process.env.PHASE || 'seed_and_backend')
const SCENARIO = String(process.env.SCENARIO || 'primary')
const ROLLBACK = process.env.ROLLBACK !== 'false'
// XLSX_CHUNK_SIZE: default stays 50_000 (= server cap XLSX_MAX_ROWS).
// Chunk guidance (S5a, belt-and-braces with the upload dispatcher below): the
// server processes each chunk SYNCHRONOUSLY (~10 ms/row → 50k ≈ 500s before
// any response headers). The dispatcher's 1800s headersTimeout now survives
// that, but if you want per-chunk server time to stay in verdict-proven safe
// territory (~≤200s — 10k chunks measured ~100s on staging), set
// XLSX_CHUNK_SIZE=20000 (50k→3 chunks, 100k→5 chunks). There is no
// --max-chunk-seconds flag; this env is the knob.
const XLSX_CHUNK_SIZE = resolveXlsxChunkSize(process.env.XLSX_CHUNK_SIZE)
// Seed-upload-only headers/body timeout (≥1800s enforced; see verdict §6 —
// undici's default 300s headersTimeout killed every ≥50k chunk at ~307s).
const SEED_UPLOAD_TIMEOUT_MS = resolveSeedUploadTimeoutMs(process.env.SEED_UPLOAD_TIMEOUT_MS)
const BACKEND_INSERT_SAMPLE_SIZE = Math.max(10, Number(process.env.BACKEND_INSERT_SAMPLE_SIZE || 200))
const BACKEND_QUERY_SAMPLE_SIZE = Math.max(10, Number(process.env.BACKEND_QUERY_SAMPLE_SIZE || 50))
const OUTPUT_DIR = String(process.env.OUTPUT_DIR || 'output/multitable-perf')
const BASELINE_ID = String(
  process.env.BASELINE_ID
    || `${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}-${Math.random().toString(36).slice(2, 9)}`,
)
const CI_RUNNER_TAG = String(process.env.CI_RUNNER_TAG || 'local-dev')
const STATE_FILE = String(process.env.STATE_FILE || path.join(OUTPUT_DIR, `state-${BASELINE_ID}.json`))
const BASE_ID_OVERRIDE = String(process.env.BASE_ID || '')
const SHEET_ID_OVERRIDE = String(process.env.SHEET_ID || '')
// Minimum success ratio per measurement sample — fail-fast prevents silent
// green dispatches where backendInsertMs.p95=null or backendQueryMs.p95=null
// because every sample errored. Default 0.8 (≥80% of requested calls).
const MIN_SAMPLE_SUCCESS_RATIO = Math.max(
  0,
  Math.min(1, Number(process.env.MIN_SAMPLE_SUCCESS_RATIO || 0.8)),
)

if (!API_BASE) {
  console.error('[d2-perf] API_BASE required')
  process.exit(1)
}
if (!AUTH_TOKEN) {
  console.error('[d2-perf] AUTH_TOKEN required')
  process.exit(1)
}
if (PHASE === 'seed_and_backend' && !BASE_ID_OVERRIDE) {
  console.error(
    '[d2-perf] BASE_ID required for seed_and_backend phase.\n' +
      'No DELETE /bases endpoint exists; per-run base creation would leave\n' +
      'many orphan bases across repeated dispatches. Create ONE reusable base\n' +
      'before the first dispatch (e.g., POST /api/multitable/bases) and reuse\n' +
      'its id across all dispatches via the BASE_ID env (or workflow base_id\n' +
      'input / MULTITABLE_PERF_BASE_ID repo var). Sheets are still per-dispatch and\n' +
      'cleanly cascade-deleted via rollback.',
  )
  process.exit(1)
}

// --- request helpers ---
async function apiFetch(method, pathSuffix, body, opts = {}) {
  const url = `${API_BASE}${pathSuffix}`
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}` }
  if (body && !opts.isMultipart) headers['Content-Type'] = 'application/json'
  const init = { method, headers }
  if (body) init.body = opts.isMultipart ? body : JSON.stringify(body)
  // Seed-upload calls pass a custom undici dispatcher (raised headers/body
  // timeouts); every other call keeps Node's default global dispatcher.
  if (opts.dispatcher) init.dispatcher = opts.dispatcher
  const res = await fetch(url, init)
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { _raw: text }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${pathSuffix} -> ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}

// --- statistics ---
function summarizeLatencies(samples) {
  if (samples.length === 0) {
    return { p50: null, p95: null, p99: null, count: 0, mean: null, min: null, max: null }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  const pick = (q) => sorted[Math.min(n - 1, Math.floor(n * q))]
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    p50: Math.round(pick(0.5)),
    p95: Math.round(pick(0.95)),
    p99: Math.round(pick(0.99)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[n - 1]),
    mean: Math.round(sum / n),
    count: n,
  }
}

// --- field set: 16 string + 2 number + 2 date (locked per user decision 2026-05-24) ---
const FIELDS = (() => {
  const out = []
  for (let i = 1; i <= 16; i++) out.push({ name: `text_${i}`, type: 'string' })
  for (let i = 1; i <= 2; i++) out.push({ name: `number_${i}`, type: 'number' })
  for (let i = 1; i <= 2; i++) out.push({ name: `date_${i}`, type: 'date' })
  return out
})()

// --- workflow steps ---
// Note: BASE_ID is required at startup for seed_and_backend phase (see env
// validation above). No auto-create — no DELETE /bases endpoint exists, so
// per-run base creation would leave orphans.
async function ensureBase() {
  return BASE_ID_OVERRIDE
}

async function ensureSheet(baseId) {
  if (SHEET_ID_OVERRIDE) return SHEET_ID_OVERRIDE
  const env = await apiFetch('POST', '/api/multitable/sheets', {
    baseId,
    name: `d2-perf-sheet-${BASELINE_ID}`,
  })
  const id = env.data?.sheet?.id ?? env.sheet?.id ?? env.data?.id
  if (!id) throw new Error('Failed to create sheet — no id in response')
  return id
}

async function ensureFields(sheetId) {
  const out = []
  for (const f of FIELDS) {
    const env = await apiFetch('POST', '/api/multitable/fields', {
      sheetId,
      name: f.name,
      type: f.type,
    })
    const id = env.data?.field?.id ?? env.field?.id
    if (!id) throw new Error(`Failed to create field ${f.name}`)
    out.push({ id, name: f.name, type: f.type })
  }
  return out
}

async function ensureView(sheetId) {
  const env = await apiFetch('POST', '/api/multitable/views', {
    sheetId,
    name: `d2-perf-view-${BASELINE_ID}`,
    type: 'grid',
  })
  const id = env.data?.view?.id ?? env.view?.id
  if (!id) throw new Error('Failed to create view — no id in response')
  return id
}

// --- XLSX in-memory generation ---
// xlsx is not hoisted to workspace root; resolve from packages/core-backend where
// it is a direct dep. Falls back to direct import if hoisted in some environments.
async function loadXlsx() {
  try {
    const mod = await import('xlsx')
    return mod.default ?? mod
  } catch (err1) {
    try {
      const corePkgPath = path.resolve(process.cwd(), 'packages/core-backend/package.json')
      const requireFromCore = createRequire(corePkgPath)
      return requireFromCore('xlsx')
    } catch (err2) {
      throw new Error(
        `Cannot resolve xlsx package. Run from worktree root, or ensure xlsx is installed in packages/core-backend. Errors:\n  direct: ${err1.message}\n  fallback: ${err2.message}`,
      )
    }
  }
}

async function buildXlsxBuffer(xlsx, rowCount) {
  const headers = FIELDS.map((f) => f.name)
  const aoa = [headers]
  const epochDate = new Date('2026-01-01T00:00:00Z')
  for (let r = 0; r < rowCount; r++) {
    const row = []
    for (let i = 0; i < 16; i++) row.push(`text-${r}-${i}`)
    row.push(r * 7)
    row.push(r * 11)
    const d1 = new Date(epochDate)
    d1.setUTCDate(epochDate.getUTCDate() + (r % 365))
    row.push(d1.toISOString().slice(0, 10))
    const d2 = new Date(epochDate)
    d2.setUTCDate(epochDate.getUTCDate() + ((r * 3) % 365))
    row.push(d2.toISOString().slice(0, 10))
    aoa.push(row)
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1')
  const out = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return Buffer.isBuffer(out) ? out : Buffer.from(out)
}

// undici is a root devDependency (added with the S5a fix); lazy-loaded so the
// rollback phase never depends on it. Node's GLOBAL fetch ships a bundled
// undici whose Agent is not importable — the supported way to override
// headersTimeout/bodyTimeout per call is `import { Agent } from 'undici'` and
// pass the instance via the (undici-specific) `dispatcher` fetch init option.
async function loadUndiciAgent() {
  try {
    const mod = await import('undici')
    return mod.Agent
  } catch (err) {
    throw new Error(
      `Cannot resolve undici package (needed for the seed-upload dispatcher; root devDependency since S5a). Run pnpm install at the repo root. Error: ${err.message}`,
    )
  }
}

async function uploadXlsxChunk(xlsx, sheetId, rowsInChunk, dispatcher) {
  const buf = await buildXlsxBuffer(xlsx, rowsInChunk)
  const fd = new FormData()
  fd.append(
    'file',
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'chunk.xlsx',
  )
  // Header names match field names → server auto-maps via mapXlsxColumnsToFields()
  const start = performance.now()
  const env = await apiFetch(
    'POST',
    `/api/multitable/sheets/${encodeURIComponent(sheetId)}/import-xlsx`,
    fd,
    { isMultipart: true, dispatcher },
  )
  const elapsed = performance.now() - start
  const data = env.data || env
  return {
    elapsedMs: Math.round(elapsed),
    attempted: data.attempted ?? null,
    imported: data.imported ?? null,
    failed: data.failed ?? null,
    truncated: data.truncated ?? null,
  }
}

async function seedRows(sheetId) {
  const xlsx = await loadXlsx()
  const Agent = await loadUndiciAgent()
  // Upload-only dispatcher (verdict §6 fix #2): raised headersTimeout/
  // bodyTimeout so a chunk whose synchronous server-side import takes >300s
  // no longer dies on the client's default undici headersTimeout.
  const dispatcher = createUploadDispatcher(Agent, SEED_UPLOAD_TIMEOUT_MS)
  console.log(
    `[seed] upload dispatcher: headersTimeout=bodyTimeout=${SEED_UPLOAD_TIMEOUT_MS}ms (seed uploads only; other calls use defaults)`,
  )
  try {
    const chunks = []
    let remaining = ROWS
    while (remaining > 0) {
      const chunkSize = Math.min(XLSX_CHUNK_SIZE, remaining)
      console.log(
        `[seed] chunk ${chunks.length + 1}: ${chunkSize} rows (after this, remaining=${remaining - chunkSize})`,
      )
      const result = await uploadXlsxChunk(xlsx, sheetId, chunkSize, dispatcher)
      chunks.push(result)
      if ((result.imported ?? 0) === 0 && remaining > 0) {
        throw new Error(
          `Chunk upload produced 0 imports while ${remaining} rows still remaining (attempted=${result.attempted}, failed=${result.failed})`,
        )
      }
      remaining -= (result.imported ?? chunkSize)
    }
    return chunks
  } finally {
    await dispatcher.close().catch(() => {})
  }
}

function assertSampleSuccessRate(label, successCount, requested) {
  const ratio = requested > 0 ? successCount / requested : 0
  if (ratio < MIN_SAMPLE_SUCCESS_RATIO) {
    throw new Error(
      `[${label}] success ratio ${(ratio * 100).toFixed(1)}% (${successCount}/${requested}) ` +
        `below MIN_SAMPLE_SUCCESS_RATIO=${(MIN_SAMPLE_SUCCESS_RATIO * 100).toFixed(0)}%. ` +
        `Failing fast to avoid silent green dispatch with null p95. ` +
        `Check earlier WARN logs for endpoint error messages.`,
    )
  }
}

async function measureBackendInsertDistribution(sheetId, fields) {
  const samples = []
  console.log(`[measure] backend insert: ${BACKEND_INSERT_SAMPLE_SIZE} × POST /records`)
  for (let i = 0; i < BACKEND_INSERT_SAMPLE_SIZE; i++) {
    const data = {}
    fields.forEach((f, idx) => {
      if (f.type === 'string') data[f.id] = `m-${i}-${idx}`
      else if (f.type === 'number') data[f.id] = i
      else if (f.type === 'date') data[f.id] = '2026-06-01'
    })
    const start = performance.now()
    try {
      await apiFetch('POST', '/api/multitable/records', { sheetId, data })
      samples.push(performance.now() - start)
    } catch (err) {
      console.warn(`[measure-insert] sample ${i} failed: ${formatErrorWithCause(err)}`)
    }
  }
  assertSampleSuccessRate('backend-insert', samples.length, BACKEND_INSERT_SAMPLE_SIZE)
  return summarizeLatencies(samples)
}

async function measureBackendQueryDistribution(sheetId, fields) {
  // Cache-bust strategy: pick a real string field and filter on a random value
  // that won't match any record. The query SQL goes through the full
  // normalizeQueryFilters path (which would throw on unknown field IDs — see
  // packages/core-backend/src/multitable/query-service.ts:128) and produces a
  // unique cache key per request (buildRecordsCacheKey hashes the filter).
  // Returns 0 rows but exercises the same query path as a hit-zero filter
  // would in production.
  const bustField = fields.find((f) => f.type === 'string')
  if (!bustField) {
    throw new Error('measureBackendQueryDistribution: need at least one string field for cache-bust strategy')
  }
  const samples = []
  console.log(
    `[measure] backend query: ${BACKEND_QUERY_SAMPLE_SIZE} × GET /records (cache-bust via filter.${bustField.id}=<random>)`,
  )
  for (let i = 0; i < BACKEND_QUERY_SAMPLE_SIZE; i++) {
    const bust = `z-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const url =
      `/api/multitable/records?sheetId=${encodeURIComponent(sheetId)}&limit=100` +
      `&filter.${encodeURIComponent(bustField.id)}=${encodeURIComponent(bust)}`
    const start = performance.now()
    try {
      await apiFetch('GET', url)
      samples.push(performance.now() - start)
    } catch (err) {
      console.warn(`[measure-query] sample ${i} failed: ${formatErrorWithCause(err)}`)
    }
  }
  assertSampleSuccessRate('backend-query', samples.length, BACKEND_QUERY_SAMPLE_SIZE)
  return summarizeLatencies(samples)
}

async function deleteSheet(sheetId) {
  console.log(`[rollback] DELETE /sheets/${sheetId} (records cascade via FK)`)
  await apiFetch('DELETE', `/api/multitable/sheets/${encodeURIComponent(sheetId)}`)
}

// --- output JSON per design §6 schema (backend half; frontend fields null) ---
function buildOutputJson({ sheetId, viewId, chunks, insertStats, queryStats }) {
  const totalSeedMs = chunks.reduce((acc, c) => acc + c.elapsedMs, 0)
  const totalImported = chunks.reduce((acc, c) => acc + (c.imported ?? 0), 0)
  return {
    baselineId: BASELINE_ID,
    perfProfile: PERF_PROFILE,
    metricProfile: 'backend',
    rows: ROWS,
    scenario: SCENARIO,
    hardware: {
      runner: CI_RUNNER_TAG,
      cpuCount: null,
      memMb: null,
      kernel: null,
      playwrightChromium: null,
    },
    viewport: null,
    metrics: {
      ttiMs: null,
      scrollFps: { p50: null, p95: null, min: null },
      longTask: { count: null, totalMs: null },
      domNodes: { afterMount: null, afterScrollBottom: null, delta: null, per10kSlope: null },
      jsHeapMb: { afterMount: null, afterScrollBottom: null, delta: null, per10kSlope: null },
      editCellRoundtripMs: { p50: null, p95: null },
      sortApplyMs: null,
      filterApplyMs: null,
      groupApplyMs: null,
      backendInsertMs: insertStats,
      backendQueryMs: queryStats,
      backendSeedAggregateMs: totalSeedMs,
      backendSeedChunks: chunks,
    },
    thresholds: null,
    verdict: 'TBD',
    notes: [
      `targetSheetId=${sheetId}`,
      `targetViewId=${viewId}`,
      `totalSeededRows=${totalImported}/${ROWS}`,
      'baseline assumes ENABLE_YJS_COLLAB!=true on server (Yjs invalidation off)',
      'frontend metrics filled by multitable-perf-baseline.spec.ts; this output is backend half',
      'seed timing = aggregate per chunk, not per-record distribution; per-record p50/p95/p99 from separate /records sample',
    ],
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function writeState(sheetId, viewId) {
  await ensureDir(path.dirname(STATE_FILE))
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify(
      {
        sheetId,
        viewId,
        baselineId: BASELINE_ID,
        perfProfile: PERF_PROFILE,
        rows: ROWS,
        scenario: SCENARIO,
      },
      null,
      2,
    ),
  )
  console.log(`[state] wrote ${STATE_FILE}`)
}

async function readState() {
  const raw = await fs.readFile(STATE_FILE, 'utf-8')
  return JSON.parse(raw)
}

// --- phases ---
async function runSeedAndBackend() {
  console.log(`[d2-perf] PHASE=seed_and_backend rows=${ROWS} profile=${PERF_PROFILE} scenario=${SCENARIO}`)
  const baseId = await ensureBase()
  const sheetId = await ensureSheet(baseId)
  const fields = await ensureFields(sheetId)
  const viewId = await ensureView(sheetId)
  await writeState(sheetId, viewId)

  const chunks = await seedRows(sheetId)
  const insertStats = await measureBackendInsertDistribution(sheetId, fields)
  const queryStats = await measureBackendQueryDistribution(sheetId, fields)

  const output = buildOutputJson({ sheetId, viewId, chunks, insertStats, queryStats })
  await ensureDir(OUTPUT_DIR)
  const outputPath = path.join(
    OUTPUT_DIR,
    `baseline-${ROWS}-backend-${SCENARIO}-${BASELINE_ID}.json`,
  )
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2))
  console.log(`[output] wrote ${outputPath}`)
  console.log(
    `[summary] seedAggregate=${output.metrics.backendSeedAggregateMs}ms insert.p95=${output.metrics.backendInsertMs.p95}ms query.p95=${output.metrics.backendQueryMs.p95}ms`,
  )
}

async function runRollback() {
  let state
  try {
    state = await readState()
  } catch (err) {
    console.warn(`[rollback] state file unavailable (${formatErrorWithCause(err)}); ROLLBACK skipped`)
    return
  }
  console.log(`[d2-perf] PHASE=rollback sheetId=${state.sheetId}`)
  await deleteSheet(state.sheetId)
}

async function main() {
  if (PHASE === 'rollback') {
    if (!ROLLBACK) {
      console.log('[d2-perf] PHASE=rollback but ROLLBACK=false; no-op')
      return
    }
    await runRollback()
    return
  }
  if (PHASE === 'seed_and_backend') {
    await runSeedAndBackend()
    return
  }
  throw new Error(`Unknown PHASE=${PHASE} (expected seed_and_backend | rollback)`)
}

main().catch((err) => {
  // S5a: include err.cause — the 2026-05-25 verdict's UND_ERR_HEADERS_TIMEOUT
  // diagnosis was masked because only err.message ("fetch failed") was logged.
  console.error('[d2-perf] FAILED:', formatErrorWithCause(err))
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
