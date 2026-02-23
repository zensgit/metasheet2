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
const previewRetryAttempts = Math.max(1, Number(process.env.PREVIEW_RETRIES || 3))
const commitRetryAttempts = Math.max(1, Number(process.env.COMMIT_RETRIES || 3))
const mutationRetryDelayMs = Math.max(100, Number(process.env.MUTATION_RETRY_DELAY_MS || 1000))
const rollbackRetryAttempts = Math.max(1, Number(process.env.ROLLBACK_RETRY_ATTEMPTS || 3))
const rollbackRetryDelayMs = Math.max(100, Number(process.env.ROLLBACK_RETRY_DELAY_MS || 1500))
const apiRetryAttempts = Math.max(1, Number(process.env.API_RETRY_ATTEMPTS || 5))
const apiRetryDelayMs = Math.max(100, Number(process.env.API_RETRY_DELAY_MS || 1000))
const apiTimeoutMs = Math.max(1000, Number(process.env.API_TIMEOUT_MS || 180000))

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
const bulkEngineThresholdRaw = Number(process.env.BULK_ENGINE_THRESHOLD || 50_000)
const bulkEngineThreshold = Number.isFinite(bulkEngineThresholdRaw)
  ? Math.max(1000, Math.floor(bulkEngineThresholdRaw))
  : 50_000

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 504)
}

function isTokenizedImportEndpoint(pathname, method) {
  const upper = String(method || 'GET').toUpperCase()
  if (upper !== 'POST') return false
  return /^\/attendance\/import\/(preview|preview-async|commit|commit-async)(?:\/|$)/.test(String(pathname || ''))
}

function isResponseOk(resp) {
  if (!resp?.res?.ok) return false
  if (resp.body && typeof resp.body === 'object' && (resp.body.success === false || resp.body.ok === false)) return false
  return true
}

function isRetryableMutationFailure(resp) {
  const status = Number(resp?.res?.status || 0)
  if (status === 408 || status === 429 || status >= 500) return true
  const code = String(resp?.body?.error?.code || '')
  if (code === 'COMMIT_TOKEN_INVALID' || code === 'COMMIT_TOKEN_REQUIRED') return true
  return false
}

async function fetchWithRetry(url, init = {}, options = {}) {
  const label = options.label || url
  const allowRefresh = options.allowRefresh !== false
  const attempts = Math.max(1, Number(options.attempts || apiRetryAttempts))

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(apiTimeoutMs)
        : undefined
      const res = await fetch(url, { ...init, signal })
      if (res.status === 401 && allowRefresh && attempt < attempts) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          const delayMs = Math.min(apiRetryDelayMs * attempt, 5000)
          log(`WARN: ${label} got 401; refreshed token and retrying in ${delayMs}ms`)
          await sleep(delayMs)
          continue
        }
      }
      if (isRetriableStatus(res.status) && attempt < attempts) {
        const delayMs = Math.min(apiRetryDelayMs * attempt, 5000)
        log(`WARN: ${label} returned HTTP ${res.status}; retry ${attempt}/${attempts} in ${delayMs}ms`)
        await sleep(delayMs)
        continue
      }
      return res
    } catch (error) {
      if (attempt >= attempts) throw error
      const delayMs = Math.min(apiRetryDelayMs * attempt, 5000)
      log(`WARN: ${label} network error (${(error && error.message) || String(error)}); retry ${attempt}/${attempts} in ${delayMs}ms`)
      await sleep(delayMs)
    }
  }
  throw new Error(`${label}: exhausted retries`)
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
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }, { label: 'POST /auth/refresh-token', allowRefresh: false })
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
  const method = String(init.method || 'GET').toUpperCase()
  const attempts = isTokenizedImportEndpoint(pathname, method) ? 1 : apiRetryAttempts
  const res = await fetchWithRetry(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, { label: `${method} ${pathname}`, attempts })
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
  const method = String(init.method || 'GET').toUpperCase()
  const attempts = isTokenizedImportEndpoint(pathname, method) ? 1 : apiRetryAttempts
  const res = await fetchWithRetry(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  }, { label: `${method} ${pathname}`, attempts })
  const text = await res.text()
  return { url, res, text }
}

function isTransientRollbackError(resp) {
  const status = Number(resp?.res?.status || 0)
  if (status === 429 || (status >= 500 && status <= 504)) return true
  const code = String(resp?.body?.error?.code || '')
  if (code === 'INTERNAL_ERROR' || code === 'DB_CONFLICT' || code === 'LOCK_TIMEOUT') return true
  return false
}

async function rollbackImportBatch(batchId) {
  const startedAtMs = nowMs()
  let lastError = null
  for (let attempt = 1; attempt <= rollbackRetryAttempts; attempt += 1) {
    const rb = await apiFetch(`/attendance/import/rollback/${batchId}`, { method: 'POST', body: '{}' })
    const ok = rb.res.ok && !(rb.body && typeof rb.body === 'object' && (rb.body.success === false || rb.body.ok === false))
    if (ok) {
      return {
        attempts: attempt,
        rollbackMs: Math.max(0, nowMs() - startedAtMs),
      }
    }

    const transient = isTransientRollbackError(rb)
    lastError = new Error(`POST /attendance/import/rollback/:id: HTTP ${rb.res.status} ${rb.raw.slice(0, 200)}`)
    if (!transient || attempt >= rollbackRetryAttempts) {
      throw lastError
    }
    log(`WARN: rollback transient failure (attempt=${attempt}/${rollbackRetryAttempts}); retrying in ${rollbackRetryDelayMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, rollbackRetryDelayMs))
  }
  throw lastError || new Error('rollback failed')
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

function resolveEngineByRows(rowCount) {
  return Number(rowCount) >= bulkEngineThreshold ? 'bulk' : 'standard'
}

function coerceNonNegativeNumber(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  return Math.floor(numeric)
}

function coerceNonNegativeFloat(value, digits = 2) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const factor = 10 ** Math.max(0, Math.floor(digits))
  return Math.round(numeric * factor) / factor
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
    let job = null
    try {
      job = await apiFetch(`/attendance/import/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' })
    } catch (error) {
      transientErrors += 1
      const message = (error && error.message) || String(error)
      log(`WARN: transient job poll network error (attempt=${transientErrors}); retrying (${message})`)
      if (Date.now() - started > timeoutMs) {
        throw new Error(`async commit job poll timed out after network errors: ${message}`)
      }
      await sleep(intervalMs)
      continue
    }
    if (!job.res.ok) {
      const status = Number(job.res.status || 0)
      const transient = status === 429 || (status >= 500 && status <= 504)
      if (transient) {
        transientErrors += 1
        log(`WARN: transient job poll error (attempt=${transientErrors} status=${status}); retrying`)
        if (Date.now() - started > timeoutMs) {
          throw new Error(`async commit job poll timed out after transient errors (last status=${status})`)
        }
        await sleep(intervalMs)
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
    await sleep(intervalMs)
  }
}

async function run() {
  if (!apiBase) die('API_BASE is required (example: http://142.171.239.56:8081/api)')
  if (!token) die('AUTH_TOKEN is required')

  log(`API_BASE=${apiBase}`)
  log(`scenario=${scenario}`)
  await refreshAuthToken()
  const requestedImportEngine = resolveEngineByRows(rows)
  log(`rows=${rows} bulk_engine_threshold=${bulkEngineThreshold} requested_engine=${requestedImportEngine}`)

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
    __importEngine: requestedImportEngine,
    batchMeta: {
      perfScenario: scenario,
      perfRows: rows,
      requestedImportEngine,
    },
    previewLimit: Number.isFinite(previewLimit) && previewLimit > 0 ? Math.floor(previewLimit) : undefined,
    returnItems,
    itemsLimit: Number.isFinite(itemsLimit) && itemsLimit > 0 ? Math.floor(itemsLimit) : undefined,
    groupSync: groupSyncEnabled
      ? { autoCreate: groupAutoCreate, autoAssignMembers: groupAutoAssignMembers }
      : undefined,
  }

  // Preview (token can expire/be consumed when upstream returns transient failures).
  let preview = null
  let tPreview0 = nowMs()
  let tPreview1 = tPreview0
  for (let attempt = 1; attempt <= previewRetryAttempts; attempt += 1) {
    const prepPreview = await apiFetch('/attendance/import/prepare', { method: 'POST', body: '{}' })
    assertOk(prepPreview, `POST /attendance/import/prepare (preview attempt ${attempt})`)
    const commitTokenPreview = prepPreview.body?.data?.commitToken
    if (!commitTokenPreview) die(`prepare (preview attempt ${attempt}) did not return commitToken`)

    try {
      tPreview0 = nowMs()
      preview = await apiFetch('/attendance/import/preview', {
        method: 'POST',
        body: JSON.stringify({ ...basePayload, commitToken: commitTokenPreview }),
      })
      tPreview1 = nowMs()
    } catch (error) {
      if (attempt >= previewRetryAttempts) throw error
      const delayMs = Math.min(mutationRetryDelayMs * attempt, 5000)
      log(`WARN: preview attempt ${attempt}/${previewRetryAttempts} network error (${(error && error.message) || String(error)}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
      continue
    }

    if (!isResponseOk(preview) && isRetryableMutationFailure(preview) && attempt < previewRetryAttempts) {
      const code = String(preview.body?.error?.code || '')
      const delayMs = Math.min(mutationRetryDelayMs * attempt, 5000)
      log(`WARN: preview attempt ${attempt}/${previewRetryAttempts} failed (HTTP ${preview.res.status} code=${code || 'n/a'}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
      continue
    }
    break
  }
  if (!preview) die('preview response missing after retries')
  assertOk(preview, 'POST /attendance/import/preview')
  const previewItems = preview.body?.data?.items
  if (!Array.isArray(previewItems) || previewItems.length === 0) die('preview returned 0 items')

  if (mode === 'preview') {
    const summary = {
      schemaVersion: 2,
      startedAt,
      scenario,
      mode,
      apiBase,
      orgId,
      rows,
      engine: requestedImportEngine,
      requestedImportEngine,
      resolvedImportEngine: requestedImportEngine,
      processedRows: null,
      failedRows: null,
      elapsedMs: null,
      progressPercent: null,
      throughputRowsPerSec: null,
      perfMetrics: {
        previewMs: tPreview1 - tPreview0,
        commitMs: null,
        exportMs: null,
        rollbackMs: null,
        processedRows: null,
        failedRows: null,
        elapsedMs: null,
        progressPercent: null,
        throughputRowsPerSec: null,
      },
      uploadCsv,
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

  // Commit (retry with fresh commitToken when transient/token errors happen).
  const tCommit0 = nowMs()
  const commitEndpoint = commitAsync ? '/attendance/import/commit-async' : '/attendance/import/commit'
  let commit = null
  for (let attempt = 1; attempt <= commitRetryAttempts; attempt += 1) {
    const prepCommit = await apiFetch('/attendance/import/prepare', { method: 'POST', body: '{}' })
    assertOk(prepCommit, `POST /attendance/import/prepare (commit attempt ${attempt})`)
    const commitTokenCommit = prepCommit.body?.data?.commitToken
    if (!commitTokenCommit) die(`prepare (commit attempt ${attempt}) did not return commitToken`)

    try {
      commit = await apiFetch(commitEndpoint, {
        method: 'POST',
        body: JSON.stringify({ ...basePayload, commitToken: commitTokenCommit }),
      })
    } catch (error) {
      if (attempt >= commitRetryAttempts) throw error
      const delayMs = Math.min(mutationRetryDelayMs * attempt, 5000)
      log(`WARN: commit attempt ${attempt}/${commitRetryAttempts} network error (${(error && error.message) || String(error)}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
      continue
    }

    if (!isResponseOk(commit) && isRetryableMutationFailure(commit) && attempt < commitRetryAttempts) {
      const code = String(commit.body?.error?.code || '')
      const delayMs = Math.min(mutationRetryDelayMs * attempt, 5000)
      log(`WARN: commit attempt ${attempt}/${commitRetryAttempts} failed (HTTP ${commit.res.status} code=${code || 'n/a'}); retrying in ${delayMs}ms`)
      await sleep(delayMs)
      continue
    }
    break
  }
  if (!commit) die('commit response missing after retries')
  assertOk(commit, `POST ${commitEndpoint}`)

  let batchId = null
  let jobId = null
  let engine = requestedImportEngine
  let processedRows = null
  let failedRows = null
  let jobElapsedMs = null
  let progressPercent = null
  let throughputRowsPerSec = null
  let chunkItemsSize = null
  let chunkRecordsSize = null
  let recordUpsertStrategy = null
  if (commitAsync) {
    const job = commit.body?.data?.job
    jobId = job?.id
    if (!jobId) die('commit-async did not return job.id')
    const finalJob = await pollImportJob(jobId)
    batchId = finalJob?.batchId
    if (typeof finalJob?.engine === 'string' && finalJob.engine) engine = finalJob.engine
    processedRows = coerceNonNegativeNumber(finalJob?.processedRows)
    failedRows = coerceNonNegativeNumber(finalJob?.failedRows)
    jobElapsedMs = coerceNonNegativeNumber(finalJob?.elapsedMs)
    progressPercent = coerceNonNegativeFloat(finalJob?.progressPercent)
    throughputRowsPerSec = coerceNonNegativeFloat(finalJob?.throughputRowsPerSec)
    chunkItemsSize = coerceNonNegativeNumber(finalJob?.summary?.chunkConfig?.itemsChunkSize)
    chunkRecordsSize = coerceNonNegativeNumber(finalJob?.summary?.chunkConfig?.recordsChunkSize)
    if (typeof finalJob?.recordUpsertStrategy === 'string' && finalJob.recordUpsertStrategy) {
      recordUpsertStrategy = finalJob.recordUpsertStrategy
    }
    if (progressPercent === null) {
      const progress = coerceNonNegativeNumber(finalJob?.progress)
      const total = coerceNonNegativeNumber(finalJob?.total)
      if (progress !== null && total && total > 0) {
        progressPercent = coerceNonNegativeFloat((progress / total) * 100)
      }
    }
    if (!batchId) die('commit-async job did not return batchId')
  } else {
    batchId = commit.body?.data?.batchId
    if (typeof commit.body?.data?.engine === 'string' && commit.body.data.engine) engine = commit.body.data.engine
    processedRows = coerceNonNegativeNumber(commit.body?.data?.processedRows ?? commit.body?.data?.rowCount ?? commit.body?.data?.imported)
    failedRows = coerceNonNegativeNumber(commit.body?.data?.failedRows ?? commit.body?.data?.skippedCount)
    jobElapsedMs = coerceNonNegativeNumber(commit.body?.data?.elapsedMs ?? commit.body?.data?.jobElapsedMs)
    progressPercent = coerceNonNegativeFloat(commit.body?.data?.progressPercent)
    throughputRowsPerSec = coerceNonNegativeFloat(commit.body?.data?.throughputRowsPerSec)
    chunkItemsSize = coerceNonNegativeNumber(commit.body?.data?.meta?.chunkConfig?.itemsChunkSize)
    chunkRecordsSize = coerceNonNegativeNumber(commit.body?.data?.meta?.chunkConfig?.recordsChunkSize)
    if (typeof commit.body?.data?.recordUpsertStrategy === 'string' && commit.body.data.recordUpsertStrategy) {
      recordUpsertStrategy = commit.body.data.recordUpsertStrategy
    } else if (typeof commit.body?.data?.meta?.recordUpsertStrategy === 'string' && commit.body.data.meta.recordUpsertStrategy) {
      recordUpsertStrategy = commit.body.data.meta.recordUpsertStrategy
    }
    if (!batchId) die('commit did not return batchId')
  }
  // Resolve chunk metadata from batch detail endpoint (covers async jobs and older responses).
  try {
    const batchDetail = await apiFetch(`/attendance/import/batches/${encodeURIComponent(batchId)}`, { method: 'GET' })
    if (batchDetail.res.ok && batchDetail.body?.ok) {
      if (typeof batchDetail.body?.data?.meta?.engine === 'string' && batchDetail.body.data.meta.engine) {
        engine = batchDetail.body.data.meta.engine
      }
      if (chunkItemsSize === null) {
        chunkItemsSize = coerceNonNegativeNumber(batchDetail.body?.data?.meta?.chunkConfig?.itemsChunkSize)
      }
      if (chunkRecordsSize === null) {
        chunkRecordsSize = coerceNonNegativeNumber(batchDetail.body?.data?.meta?.chunkConfig?.recordsChunkSize)
      }
      if (!recordUpsertStrategy && typeof batchDetail.body?.data?.meta?.recordUpsertStrategy === 'string') {
        recordUpsertStrategy = batchDetail.body.data.meta.recordUpsertStrategy
      }
    }
  } catch (error) {
    log(`WARN: batch metadata fetch failed: ${(error && error.message) || String(error)}`)
  }
  const tCommit1 = nowMs()
  const elapsedMs = jobElapsedMs ?? Math.max(0, tCommit1 - tCommit0)
  if (processedRows === null) {
    processedRows = coerceNonNegativeNumber(rows)
  }
  if (failedRows === null) {
    failedRows = 0
  }

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
    const rollback = await rollbackImportBatch(batchId)
    rolledBack = true
    rollbackMs = rollback.rollbackMs
    if (rollback.attempts > 1) {
      log(`rollback recovered after retry attempts=${rollback.attempts}`)
    }
  }

  const summary = {
    schemaVersion: 2,
    startedAt,
    scenario,
    mode,
    apiBase,
    orgId,
    rows,
    commitAsync,
    engine,
    requestedImportEngine,
    resolvedImportEngine: engine,
    processedRows,
    failedRows,
    elapsedMs,
    progressPercent,
    throughputRowsPerSec,
    recordUpsertStrategy,
    chunkConfig: {
      itemsChunkSize: chunkItemsSize,
      recordsChunkSize: chunkRecordsSize,
    },
    jobElapsedMs,
    perfMetrics: {
      previewMs: tPreview1 - tPreview0,
      commitMs: tCommit1 - tCommit0,
      exportMs,
      rollbackMs,
      processedRows,
      failedRows,
      elapsedMs,
      progressPercent,
      throughputRowsPerSec,
      recordUpsertStrategy,
      chunkConfig: {
        itemsChunkSize: chunkItemsSize,
        recordsChunkSize: chunkRecordsSize,
      },
    },
    uploadCsv,
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
  if (progressPercent !== null || throughputRowsPerSec !== null) {
    log(`job telemetry: progressPercent=${progressPercent ?? '--'} throughputRowsPerSec=${throughputRowsPerSec ?? '--'}`)
  }
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
