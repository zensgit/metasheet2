/**
 * Attendance Import Performance Baseline
 *
 * Runs preview + commit with N rows, then rolls back the import batch to avoid
 * polluting the environment. Intended for staging/pre-prod.
 *
 * NOTE: never log AUTH_TOKEN.
 */

import fs from 'fs/promises'
import path from 'path'

const apiBase = String(process.env.API_BASE || '').replace(/\/+$/, '')
let token = String(process.env.AUTH_TOKEN || '')

const orgId = String(process.env.ORG_ID || 'default')
const timezone = String(process.env.TIMEZONE || 'Asia/Shanghai')
const mappingProfileIdOverride = String(process.env.MAPPING_PROFILE_ID || '')

const rows = Math.max(1, Number(process.env.ROWS || 10_000))
const mode = String(process.env.MODE || 'commit') // preview|commit
const doRollback = process.env.ROLLBACK !== 'false' // default true

const outputRoot = String(process.env.OUTPUT_DIR || 'output/playwright/attendance-import-perf')
const exportCsv = process.env.EXPORT_CSV === 'true'
const exportType = String(process.env.EXPORT_TYPE || 'anomalies')

// Disabled by default: group creation/membership is persistent (not rolled back with import rollback).
const groupSyncEnabled = process.env.GROUP_SYNC === 'true'
const groupAutoCreate = process.env.GROUP_AUTO_CREATE === 'true'
const groupAutoAssignMembers = process.env.GROUP_AUTO_ASSIGN !== 'false' // default true

function die(message) {
  console.error(`[attendance-import-perf] ERROR: ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[attendance-import-perf] ${message}`)
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function refreshAuthToken() {
  const url = `${apiBase}/auth/refresh-token`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const raw = await res.text()
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    if (!res.ok || body?.success === false) {
      log(`WARN: token refresh failed: HTTP ${res.status}`)
      return false
    }
    const next = body?.data?.token
    if (typeof next === 'string' && next.length > 20) {
      token = next
      return true
    }
    log('WARN: token refresh response missing token')
    return false
  } catch (error) {
    log(`WARN: token refresh error: ${(error && error.message) || String(error)}`)
    return false
  }
}

async function apiFetch(pathname, init = {}) {
  const url = `${apiBase}${pathname}`
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const raw = await res.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  return { url, res, raw, body }
}

async function apiFetchText(pathname, init = {}) {
  const url = `${apiBase}${pathname}`
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  })
  const text = await res.text()
  return { url, res, text }
}

function assertOk(resp, label) {
  if (!resp.res.ok) {
    throw new Error(`${label}: HTTP ${resp.res.status} ${resp.raw.slice(0, 200)}`)
  }
  if (resp.body && typeof resp.body === 'object' && resp.body.success === false) {
    throw new Error(`${label}: ${JSON.stringify(resp.body).slice(0, 200)}`)
  }
  if (resp.body && typeof resp.body === 'object' && resp.body.ok === false) {
    throw new Error(`${label}: ${JSON.stringify(resp.body).slice(0, 200)}`)
  }
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function makeId() {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `attendance-perf-${suffix}`
}

function makeCsv({ startDate, userId, groupName }) {
  const lines = new Array(rows + 1)
  lines[0] = '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果'
  for (let i = 0; i < rows; i++) {
    const d = new Date(startDate)
    d.setUTCDate(d.getUTCDate() - i)
    const workDate = toDateOnly(d)
    lines[i + 1] = `${workDate},${userId},${groupName},09:00,18:00,正常`
  }
  return lines.join('\n')
}

async function run() {
  if (!apiBase) die('API_BASE is required (example: http://142.171.239.56:8081/api)')
  if (!token) die('AUTH_TOKEN is required')

  log(`API_BASE=${apiBase}`)
  await refreshAuthToken()

  const startedAt = new Date().toISOString()
  const runId = makeId()
  const outDir = path.join(outputRoot, runId)
  await fs.mkdir(outDir, { recursive: true })

  const memBefore = process.memoryUsage()

  // Resolve userId via auth/me.
  const me = await apiFetch('/auth/me', { method: 'GET' })
  assertOk(me, 'GET /auth/me')
  const user = me.body?.data?.user ?? {}
  const userId = user?.userId || user?.id || user?.user_id
  if (!userId) die('GET /auth/me did not return user id')

  // Template provides a legal baseline payload.
  const template = await apiFetch('/attendance/import/template', { method: 'GET' })
  assertOk(template, 'GET /attendance/import/template')
  const payloadExample = template.body?.data?.payloadExample
  if (!payloadExample || typeof payloadExample !== 'object') die('payloadExample missing')
  const resolvedMappingProfileId =
    mappingProfileIdOverride ||
    String(payloadExample.mappingProfileId || '') ||
    'dingtalk_csv_daily_summary'

  // Prepare preview token.
  const prepPreview = await apiFetch('/attendance/import/prepare', { method: 'POST', body: '{}' })
  assertOk(prepPreview, 'POST /attendance/import/prepare (preview)')
  const commitTokenPreview = prepPreview.body?.data?.commitToken
  if (!commitTokenPreview) die('prepare (preview) did not return commitToken')

  const groupName = `Perf Group ${Date.now().toString(36)}`
  const csvText = makeCsv({ startDate: new Date(), userId, groupName })

  const memAfterCsv = process.memoryUsage()

  const basePayload = {
    ...payloadExample,
    orgId,
    userId,
    timezone: payloadExample.timezone || timezone,
    mappingProfileId: resolvedMappingProfileId,
    csvText,
    idempotencyKey: runId,
    groupSync: groupSyncEnabled
      ? { autoCreate: groupAutoCreate, autoAssignMembers: groupAutoAssignMembers }
      : undefined,
  }

  // Preview.
  const tPreview0 = nowMs()
  const preview = await apiFetch('/attendance/import/preview', {
    method: 'POST',
    body: JSON.stringify({ ...basePayload, commitToken: commitTokenPreview }),
  })
  const tPreview1 = nowMs()
  assertOk(preview, 'POST /attendance/import/preview')
  const previewItems = preview.body?.data?.items
  if (!Array.isArray(previewItems) || previewItems.length === 0) die('preview returned 0 items')

  if (mode === 'preview') {
    const summary = {
      startedAt,
      mode,
      apiBase,
      orgId,
      rows,
      previewMs: tPreview1 - tPreview0,
      commitMs: null,
      exportMs: null,
      batchId: null,
      rolledBack: false,
      memory: {
        before: memBefore,
        afterCsv: memAfterCsv,
      },
      outputDir: outDir,
    }
    await writeJson(path.join(outDir, 'perf-summary.json'), summary)
    log(`preview ok: rows=${rows} ms=${summary.previewMs}`)
    log(`Wrote: ${path.join(outDir, 'perf-summary.json')}`)
    return
  }

  // Prepare commit token (preview consumes tokens by design).
  const prepCommit = await apiFetch('/attendance/import/prepare', { method: 'POST', body: '{}' })
  assertOk(prepCommit, 'POST /attendance/import/prepare (commit)')
  const commitTokenCommit = prepCommit.body?.data?.commitToken
  if (!commitTokenCommit) die('prepare (commit) did not return commitToken')

  // Commit.
  const tCommit0 = nowMs()
  const commit = await apiFetch('/attendance/import/commit', {
    method: 'POST',
    body: JSON.stringify({ ...basePayload, commitToken: commitTokenCommit }),
  })
  const tCommit1 = nowMs()
  assertOk(commit, 'POST /attendance/import/commit')
  const batchId = commit.body?.data?.batchId
  if (!batchId) die('commit did not return batchId')

  // Optional: verify export still works and capture its latency.
  let exportMs = null
  if (exportCsv) {
    const tEx0 = nowMs()
    const ex = await apiFetchText(`/attendance/import/batches/${batchId}/export.csv?type=${encodeURIComponent(exportType)}`, { method: 'GET' })
    const tEx1 = nowMs()
    exportMs = tEx1 - tEx0
    if (!ex.res.ok) {
      throw new Error(`GET /attendance/import/batches/:id/export.csv failed: HTTP ${ex.res.status} ${ex.text.slice(0, 200)}`)
    }
    if (!ex.text.includes('batchId') || !ex.text.includes('workDate') || !ex.text.includes('userId')) {
      throw new Error('export CSV missing expected headers')
    }
  }

  // Rollback to keep the environment clean.
  let rolledBack = false
  let rollbackMs = null
  if (doRollback) {
    const tRb0 = nowMs()
    const rb = await apiFetch(`/attendance/import/rollback/${batchId}`, { method: 'POST', body: '{}' })
    const tRb1 = nowMs()
    assertOk(rb, 'POST /attendance/import/rollback/:id')
    rolledBack = true
    rollbackMs = tRb1 - tRb0
  }

  const summary = {
    startedAt,
    mode,
    apiBase,
    orgId,
    rows,
    previewMs: tPreview1 - tPreview0,
    commitMs: tCommit1 - tCommit0,
    exportMs,
    rollbackMs,
    batchId,
    rolledBack,
    memory: {
      before: memBefore,
      afterCsv: memAfterCsv,
    },
    outputDir: outDir,
  }

  await writeJson(path.join(outDir, 'perf-summary.json'), summary)
  log(`preview ok: rows=${rows} ms=${summary.previewMs}`)
  log(`commit ok: batchId=${batchId} ms=${summary.commitMs}`)
  if (exportMs !== null) log(`export ok: type=${exportType} ms=${exportMs}`)
  if (rolledBack) log(`rollback ok: ms=${rollbackMs}`)
  log(`Wrote: ${path.join(outDir, 'perf-summary.json')}`)
}

run().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`[attendance-import-perf] Failed: ${msg}`)
  process.exit(1)
})
