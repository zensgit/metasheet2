'use strict'

const { randomBytes } = require('node:crypto')

const TICK_INTERVAL_MS = 30_000
const DEFAULT_LEASE_MS = 5 * 60 * 1000
const DEFAULT_BATCH_SIZE = 16
const DEFAULT_MAX_ATTEMPTS = 8
const ATTEMPTS_EXHAUSTED = 'ATTEMPTS_EXHAUSTED'
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

const JOB_STATUSES = Object.freeze({
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  dead: 'dead',
})

const CLAIM_SQL = `
WITH due AS (
  SELECT id, status, attempts
    FROM elearning_jobs
   WHERE kind = ANY($1::text[])
     AND status IN ('pending', 'running', 'failed')
     AND due_at <= now()
     AND (lease_until IS NULL OR lease_until < now())
   ORDER BY due_at ASC, id ASC
   LIMIT $2::int
   FOR UPDATE SKIP LOCKED
),
exhausted AS (
  UPDATE elearning_jobs AS job
     SET status = 'dead',
         lease_until = NULL,
         claim_worker_id = NULL,
         last_error = 'ATTEMPTS_EXHAUSTED',
         updated_at = now()
    FROM due
   WHERE job.id = due.id
     AND due.attempts >= $5::int
  RETURNING job.id
),
claimed AS (
  UPDATE elearning_jobs AS job
     SET status = 'running',
         lease_until = now() + ($3::int * interval '1 millisecond'),
         claim_worker_id = btrim($4::text),
         attempts = job.attempts + 1,
         last_error = NULL,
         updated_at = now()
    FROM due
   WHERE job.id = due.id
     AND due.attempts < $5::int
  RETURNING job.id,
            job.org_id,
            job.kind,
            job.occurrence_key,
            job.ref,
            job.payload,
            job.due_at,
            job.status,
            job.lease_until,
            job.claim_worker_id,
            job.attempts,
            job.last_error
)
SELECT *
  FROM claimed
`

const FINALIZE_SUCCESS_SQL = `
UPDATE elearning_jobs
   SET status = 'succeeded',
       lease_until = NULL,
       claim_worker_id = NULL,
       last_error = NULL,
       updated_at = now()
 WHERE id = $1::uuid
   AND claim_worker_id = $2
   AND attempts = $3::int
   AND status = 'running'
   AND lease_until IS NOT NULL
   AND lease_until > now()
 RETURNING id
`

const FINALIZE_FAILURE_SQL = `
UPDATE elearning_jobs
   SET status = CASE
         WHEN attempts >= $4::int THEN 'dead'
         ELSE 'failed'
       END,
       lease_until = NULL,
       claim_worker_id = NULL,
       last_error = $5,
       updated_at = now()
 WHERE id = $1::uuid
   AND claim_worker_id = $2
   AND attempts = $3::int
   AND status = 'running'
   AND lease_until IS NOT NULL
   AND lease_until > now()
 RETURNING id, status, last_error, attempts
`

const handlers = new Map()
let timer = null
let tickOwner = 0
let tickSeq = 0
let workerGeneration = 0
let activeDatabase = null
let activeLogger = null
let activeWorkerId = null
let activeLeaseMs = DEFAULT_LEASE_MS
let activeBatchSize = DEFAULT_BATCH_SIZE
let activeMaxAttempts = DEFAULT_MAX_ATTEMPTS

function asRows(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

function isDatabasePort(database) {
  return Boolean(database && typeof database.query === 'function')
}

function resolveDatabasePort(context) {
  const database = context && context.api && context.api.database
  return isDatabasePort(database) ? database : null
}

function logValuesFree(logger, level, code) {
  if (!logger || typeof logger[level] !== 'function') return
  logger[level]('elearning jobs', { code })
}

function errorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (ERROR_CODE_RE.test(code)) return code
  return 'HANDLER_FAILED'
}

function readPositiveInt(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback
}

function readRequiredPositiveInt(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null
  return value
}

function registerJobHandler(kind, handler, canClaim) {
  if (typeof kind !== 'string' || kind !== kind.trim() || kind === '') {
    throw new Error('elearning jobs handler kind is required')
  }
  if (typeof handler !== 'function') {
    throw new Error('elearning jobs handler is required')
  }
  if (canClaim !== undefined && typeof canClaim !== 'function') {
    throw new Error('elearning jobs canClaim must be a function')
  }
  if (handlers.has(kind)) {
    throw new Error('elearning jobs handler kind already registered')
  }
  handlers.set(kind, { handler, canClaim: canClaim || null })
}

function clearJobHandlers() {
  handlers.clear()
}

function registeredKinds() {
  return [...handlers.keys()]
}

function claimableKinds() {
  const kinds = []
  for (const [kind, registration] of handlers) {
    try {
      if (!registration.canClaim || registration.canClaim()) kinds.push(kind)
    } catch {
      // A broken runtime gate fails closed: do not claim its durable jobs.
    }
  }
  return kinds
}

function makeWorkerId() {
  return `elearning-jobs:${process.pid}:${randomBytes(4).toString('hex')}`
}

function getJobsWorkerState() {
  return {
    running: timer != null,
    intervalMs: TICK_INTERVAL_MS,
    timer,
    workerId: activeWorkerId,
    generation: workerGeneration,
  }
}

function stopJobsWorker() {
  workerGeneration += 1
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
  activeDatabase = null
  activeLogger = null
  activeWorkerId = null
  activeLeaseMs = DEFAULT_LEASE_MS
  activeBatchSize = DEFAULT_BATCH_SIZE
  activeMaxAttempts = DEFAULT_MAX_ATTEMPTS
}

function startJobsWorker(context, options) {
  stopJobsWorker()
  const database = resolveDatabasePort(context)
  if (!database) return false
  const opts = options && typeof options === 'object' ? options : {}
  activeDatabase = database
  activeLogger = context && context.logger ? context.logger : null
  activeWorkerId = typeof opts.workerId === 'string' && opts.workerId.trim()
    ? opts.workerId.trim()
    : makeWorkerId()
  activeLeaseMs = readPositiveInt(opts.leaseMs, DEFAULT_LEASE_MS)
  activeBatchSize = readPositiveInt(opts.batchSize, DEFAULT_BATCH_SIZE)
  activeMaxAttempts = readPositiveInt(opts.maxAttempts, DEFAULT_MAX_ATTEMPTS)
  timer = setInterval(() => {
    void runJobsTick().catch(() => {
      logValuesFree(activeLogger, 'warn', 'TICK_FAILED')
    })
  }, TICK_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return true
}

function normalizeKinds(requested) {
  const registered = claimableKinds()
  const allowed = new Set(registered)
  if (!Array.isArray(requested)) return registered
  const seen = new Set()
  const kinds = []
  for (const kind of requested) {
    if (typeof kind !== 'string' || kind !== kind.trim() || kind === '') continue
    if (!allowed.has(kind) || seen.has(kind)) continue
    seen.add(kind)
    kinds.push(kind)
  }
  return kinds
}

async function claimDueJobs(database, options) {
  if (!isDatabasePort(database)) return []
  const opts = options && typeof options === 'object' ? options : {}
  const kinds = normalizeKinds(opts.kinds)
  if (kinds.length === 0) return []
  const batchSize = readPositiveInt(opts.batchSize, DEFAULT_BATCH_SIZE)
  const leaseMs = readPositiveInt(opts.leaseMs, DEFAULT_LEASE_MS)
  const maxAttempts = readPositiveInt(opts.maxAttempts, activeMaxAttempts || DEFAULT_MAX_ATTEMPTS)
  const workerId = typeof opts.workerId === 'string' && opts.workerId.trim()
    ? opts.workerId.trim()
    : activeWorkerId
  if (!workerId) return []
  return asRows(await database.query(CLAIM_SQL, [kinds, batchSize, leaseMs, workerId, maxAttempts]))
}

function readClaimAttempt(input) {
  if (!input || typeof input !== 'object') return null
  if (Object.prototype.hasOwnProperty.call(input, 'claimAttempt')) {
    return readRequiredPositiveInt(input.claimAttempt)
  }
  return readRequiredPositiveInt(input.attempt)
}

async function finalizeJobSuccess(database, input) {
  const claimAttempt = readClaimAttempt(input)
  if (!isDatabasePort(database) || !input || !input.jobId || !input.workerId || !claimAttempt) {
    return false
  }
  const workerId = String(input.workerId).trim()
  if (!workerId) return false
  const rows = asRows(await database.query(FINALIZE_SUCCESS_SQL, [
    input.jobId,
    workerId,
    claimAttempt,
  ]))
  return rows.length > 0
}

async function finalizeJobFailure(database, input) {
  const claimAttempt = readClaimAttempt(input)
  if (!isDatabasePort(database) || !input || !input.jobId || !input.workerId || !claimAttempt) {
    return false
  }
  const workerId = String(input.workerId).trim()
  if (!workerId) return false
  const code = typeof input.code === 'string' && ERROR_CODE_RE.test(input.code)
    ? input.code
    : 'HANDLER_FAILED'
  const maxAttempts = readPositiveInt(input.maxAttempts, DEFAULT_MAX_ATTEMPTS)
  const rows = asRows(await database.query(FINALIZE_FAILURE_SQL, [
    input.jobId,
    workerId,
    claimAttempt,
    maxAttempts,
    code,
  ]))
  return rows.length > 0
}

async function finalizeClaimedJob(database, logger, job, workerId, maxAttempts) {
  const handler = handlers.get(job.kind)?.handler
  const claimAttempt = readRequiredPositiveInt(job.attempts)
  if (!claimAttempt) {
    logValuesFree(logger, 'warn', 'FINALIZE_FENCE')
    return
  }
  if (typeof handler !== 'function') {
    let ok
    try {
      ok = await finalizeJobFailure(database, {
        jobId: job.id,
        workerId,
        claimAttempt,
        code: 'HANDLER_MISSING',
        maxAttempts,
      })
    } catch {
      logValuesFree(logger, 'warn', 'FINALIZE_FAILED')
      return
    }
    if (!ok) logValuesFree(logger, 'warn', 'FINALIZE_FENCE')
    return
  }
  try {
    await handler(job)
    const ok = await finalizeJobSuccess(database, {
      jobId: job.id,
      workerId,
      claimAttempt,
    })
    if (!ok) logValuesFree(logger, 'warn', 'FINALIZE_FENCE')
  } catch (error) {
    let ok
    try {
      ok = await finalizeJobFailure(database, {
        jobId: job.id,
        workerId,
        claimAttempt,
        code: errorCode(error),
        maxAttempts,
      })
    } catch {
      logValuesFree(logger, 'warn', 'FINALIZE_FAILED')
      return
    }
    if (!ok) logValuesFree(logger, 'warn', 'FINALIZE_FENCE')
  }
}

async function runJobsTick(override) {
  const database = override && override.database ? override.database : activeDatabase
  const logger = override && override.logger ? override.logger : activeLogger
  const workerId = override && override.workerId ? override.workerId : activeWorkerId
  const leaseMs = override && override.leaseMs ? override.leaseMs : activeLeaseMs
  const batchSize = override && override.batchSize ? override.batchSize : activeBatchSize
  const maxAttempts = override && override.maxAttempts ? override.maxAttempts : activeMaxAttempts
  if (!isDatabasePort(database) || !workerId) return { claimed: 0 }
  if (tickOwner !== 0) return { claimed: 0, skipped: true }
  const owner = tickSeq + 1
  tickSeq = owner
  tickOwner = owner
  const generation = workerGeneration
  try {
    const kinds = claimableKinds()
    if (kinds.length === 0) return { claimed: 0 }
    const claimed = await claimDueJobs(database, {
      kinds,
      batchSize,
      leaseMs,
      workerId,
      maxAttempts,
    })
    for (const job of claimed) {
      if (workerGeneration !== generation) break
      await finalizeClaimedJob(database, logger, job, workerId, maxAttempts)
    }
    return { claimed: claimed.length }
  } catch {
    logValuesFree(logger, 'warn', 'TICK_FAILED')
    return { claimed: 0 }
  } finally {
    if (tickOwner === owner) tickOwner = 0
  }
}

module.exports = {
  TICK_INTERVAL_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  ATTEMPTS_EXHAUSTED,
  ERROR_CODE_RE,
  JOB_STATUSES,
  CLAIM_SQL,
  FINALIZE_SUCCESS_SQL,
  FINALIZE_FAILURE_SQL,
  registerJobHandler,
  clearJobHandlers,
  registeredKinds,
  startJobsWorker,
  stopJobsWorker,
  getJobsWorkerState,
  claimDueJobs,
  finalizeJobSuccess,
  finalizeJobFailure,
  runJobsTick,
  resolveDatabasePort,
}
