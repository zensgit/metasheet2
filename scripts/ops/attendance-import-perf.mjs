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
const scenario = String(process.env.SCENARIO || `${rows}-${mode}`)
const doRollback = process.env.ROLLBACK !== 'false' // default true
const commitAsync = process.env.COMMIT_ASYNC === 'true' || process.env.ASYNC === 'true'

const outputRoot = String(process.env.OUTPUT_DIR || 'output/playwright/attendance-import-perf')
const exportCsv = process.env.EXPORT_CSV === 'true'
const uploadCsv = process.env.UPLOAD_CSV === 'true'
const exportType = String(process.env.EXPORT_TYPE || 'anomalies')
const maxPreviewMs = parseOptionalPositiveInt('MAX_PREVIEW_MS')
const maxCommitMs = parseOptionalPositiveInt('MAX_COMMIT_MS')
const maxExportMs = parseOptionalPositiveInt('MAX_EXPORT_MS')
const maxRollbackMs = parseOptionalPositiveInt('MAX_ROLLBACK_MS')

// Disabled by default: group creation/membership is persistent (not rolled back with import rollback).
const groupSyncEnabled = process.env.GROUP_SYNC === 'true'
const groupAutoCreate = process.env.GROUP_AUTO_CREATE === 'true'
const groupAutoAssignMembers = process.env.GROUP_AUTO_ASSIGN !== 'false' // default true

// Large imports should not return huge payloads. Defaults are safe for large ROWS.
const previewLimitRaw = process.env.PREVIEW_LIMIT
const previewLimit = previewLimitRaw ? Number(previewLimitRaw) : (rows > 2000 ? 200 : null)
const returnItems = process.env.RETURN_ITEMS ? process.env.RETURN_ITEMS === 'true' : rows <= 2000
const itemsLimitRaw = process.env.ITEMS_LIMIT
const itemsLimit = itemsLimitRaw ? Number(itemsLimitRaw) : 200

function die(message) {
  console.error(`[attendance-import-perf] ERROR: ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[attendance-import-perf] ${message}`)
}

function parseOptionalPositiveInt(envName) {
  const raw = process.env[envName]
  if (!raw || String(raw).trim().length === 0) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    die(`${envName} must be a positive number when set`)
  }
  return Math.floor(value)
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  const raw = parts[1]
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
  const pad = '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const json = Buffer.from(`${normalized}${pad}`, 'base64').toString('utf8')
    return json ? JSON.parse(json) : null
  } catch {
    return null
  }
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
      // Some deployments return a "refreshed" token that lacks user identity claims.
      // Keep the old token in that case, otherwise downstream /attendance APIs may 401.
      const claims = decodeJwtPayload(next)
      const hasUserId = Boolean(claims?.userId || claims?.id || claims?.sub || claims?.user_id)
      if (!hasUserId) {
        log('WARN: refreshed token missing user id claim; keeping existing token')
        return false
      }
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

async function pollImportJob(jobId, { timeoutMs = 30 * 60 * 1000, intervalMs = 2000 } = {}) {
  const started = Date.now()
  let transientErrors = 0
  while (true) {
    const job = await apiFetch(`/attendance/import/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' })
    if (!job.res.ok) {
      const status = Number(job.res.status || 0)
      const transient = status === 429 || (status >= 500 && status <= 504)
      if (transient) {
        transientErrors += 1
        log(`WARN: transient job poll error (attempt=${transientErrors} status=${status}); retrying`)
        if (Date.now() - started > timeoutMs) {
          throw new Error(`async commit job poll timed out after transient errors (last status=${status})`)
        }
        await new Promise((r) => setTimeout(r, intervalMs))
        continue
      }
      throw new Error(`GET /attendance/import/jobs/:id failed: HTTP ${status} ${job.raw.slice(0, 200)}`)
    }
    if (job.body && typeof job.body === 'object' && (job.body.success === false || job.body.ok === false)) {
      const message = JSON.stringify(job.body).slice(0, 200)
      throw new Error(`GET /attendance/import/jobs/:id failed: ${message}`)
    }
    const data = job.body?.data ?? job.body
    const status = String(data?.status || '')
    if (status === 'completed') return data
    if (status === 'failed') {
      const msg = data?.error ? String(data.error) : 'job failed'
      throw new Error(`async commit job failed: ${msg}`)
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('async commit job timed out')
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function run() {
  if (!apiBase) die('API_BASE is required (example: http://142.171.239.56:8081/api)')
  if (!token) die('AUTH_TOKEN is required')

  log(`API_BASE=${apiBase}`)
  log(`scenario=${scenario}`)
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
  let userId = user?.userId || user?.id || user?.user_id
  if (!userId) {
    // Some dev token setups return user identity only in JWT payload.
    const claims = decodeJwtPayload(token)
    userId = claims?.userId || claims?.id || claims?.sub || claims?.user_id
  }
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

  let csvFileId = ''
  if (uploadCsv) {
    const query = new URLSearchParams()
    if (orgId) query.set('orgId', orgId)
    query.set('filename', `attendance-perf-${rows}.csv`)
    const up = await apiFetchText(`/attendance/import/upload?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: csvText,
    })
    if (!up.res.ok) {
      throw new Error(`POST /attendance/import/upload failed: HTTP ${up.res.status} ${up.text.slice(0, 200)}`)
    }
    let upBody = null
    try {
      upBody = up.text ? JSON.parse(up.text) : null
    } catch {
      upBody = null
    }
    if (!upBody || upBody.ok === false) {
      throw new Error(`POST /attendance/import/upload failed: ${JSON.stringify(upBody).slice(0, 200)}`)
    }
    csvFileId = String(upBody?.data?.fileId || upBody?.data?.id || '')
    if (!csvFileId) die('POST /attendance/import/upload did not return fileId')
  }

  const basePayload = {
    ...payloadExample,
    orgId,
    userId,
    timezone: payloadExample.timezone || timezone,
    mappingProfileId: resolvedMappingProfileId,
    ...(uploadCsv ? { csvFileId } : { csvText }),
    idempotencyKey: runId,
    previewLimit: Number.isFinite(previewLimit) && previewLimit > 0 ? Math.floor(previewLimit) : undefined,
    returnItems,
    itemsLimit: Number.isFinite(itemsLimit) && itemsLimit > 0 ? Math.floor(itemsLimit) : undefined,
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
      scenario,
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
  const commitEndpoint = commitAsync ? '/attendance/import/commit-async' : '/attendance/import/commit'
  const commit = await apiFetch(commitEndpoint, {
    method: 'POST',
    body: JSON.stringify({ ...basePayload, commitToken: commitTokenCommit }),
  })
  assertOk(commit, `POST ${commitEndpoint}`)

  let batchId = null
  let jobId = null
  if (commitAsync) {
    const job = commit.body?.data?.job
    jobId = job?.id
    if (!jobId) die('commit-async did not return job.id')
    const finalJob = await pollImportJob(jobId)
    batchId = finalJob?.batchId
    if (!batchId) die('commit-async job did not return batchId')
  } else {
    batchId = commit.body?.data?.batchId
    if (!batchId) die('commit did not return batchId')
  }
  const tCommit1 = nowMs()

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
    scenario,
    mode,
    apiBase,
    orgId,
    rows,
    commitAsync,
    jobId,
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
    thresholds: {
      maxPreviewMs,
      maxCommitMs,
      maxExportMs,
      maxRollbackMs,
    },
    regressions: [],
  }

  if (maxPreviewMs !== null && summary.previewMs > maxPreviewMs) {
    summary.regressions.push(`previewMs=${summary.previewMs} exceeds maxPreviewMs=${maxPreviewMs}`)
  }
  if (maxCommitMs !== null && summary.commitMs > maxCommitMs) {
    summary.regressions.push(`commitMs=${summary.commitMs} exceeds maxCommitMs=${maxCommitMs}`)
  }
  if (maxExportMs !== null && summary.exportMs !== null && summary.exportMs > maxExportMs) {
    summary.regressions.push(`exportMs=${summary.exportMs} exceeds maxExportMs=${maxExportMs}`)
  }
  if (maxRollbackMs !== null && summary.rollbackMs !== null && summary.rollbackMs > maxRollbackMs) {
    summary.regressions.push(`rollbackMs=${summary.rollbackMs} exceeds maxRollbackMs=${maxRollbackMs}`)
  }

  await writeJson(path.join(outDir, 'perf-summary.json'), summary)
  log(`preview ok: rows=${rows} ms=${summary.previewMs}`)
  log(`commit ok: batchId=${batchId} ms=${summary.commitMs}`)
  if (exportMs !== null) log(`export ok: type=${exportType} ms=${exportMs}`)
  if (rolledBack) log(`rollback ok: ms=${rollbackMs}`)
  log(`Wrote: ${path.join(outDir, 'perf-summary.json')}`)
  if (summary.regressions.length > 0) {
    throw new Error(`performance threshold regression: ${summary.regressions.join('; ')}`)
  }
}

run().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`[attendance-import-perf] Failed: ${msg}`)
  process.exit(1)
})
