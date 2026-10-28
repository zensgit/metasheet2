'use strict'

// R67 ④ — THE BACKGROUND DRY-RUN LANE. 试算 (the small-BOM dry-run) taken off the request/response
// cycle so the UI survives a slow PLM.
//
// WHY. A dry-run for one project issues on the order of 1,400 serial PLM reads. When the customer
// PLM slows down, the synchronous `POST …/table-actions/:actionId/dry-run` outlives nginx's 60 s
// proxy timeout: the browser gets a 504 while the backend keeps reading to completion, the result is
// thrown away, and the operator's retry doubles the PLM load. The scheduled pull is unaffected (it
// has its own timeout) and keeps using the synchronous route, which is unchanged.
//
// WHAT THIS MODULE OWNS — the job RECORD and the in-flight SLOT, nothing else. It never builds a
// plan, never reads a source and never decides who may ask: the enqueue route
// (`tableActionDryRunJobStart` in http-routes.cjs) delegates to the synchronous handler itself, so
// the guard chain, the B2a fence, the adapter load, the plan and the registry/overview stamping are
// the SAME LINES on both lanes. This module only receives the already-guarded `run` closure and
// records what it returned (the exact dry-run payload, dry-run token included) or the exact error
// envelope the synchronous route would have answered.
//
// SAME STORE AS THE LARGE-BOM LANE. The record lives in the plugin's durable KV (`context.storage`,
// Postgres `plugin_kv`) — the store `stock-preparation-large-bom-jobs.cjs` keeps its jobs in, with the
// same `durable === true` precondition (501 otherwise). That lane has no server-side worker (its web
// client advances a job by POSTing `…/run`, synchronously per call), so its run route would hit the
// same 60 s cliff; this lane adds the one thing it does not have — a detached in-process run.
//
// ONE IN-FLIGHT DRY-RUN PER TARGET (tenant × action × project number), across callers,
// answered the way the large-BOM apply lane answers a concurrent chunk: 409 with a status token. The
// slot is in-process (`ecosystem.config.cjs` runs one forked backend); a record that says `running`
// but has no live slot in THIS process is reported `failed` / `STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED`
// (the process restarted under it) and frees the target.
//
// NO WORKSPACE IN EITHER KEY (fix round 1). `workspaceId` is a request query field this plugin has no
// registry to validate against, so keying the slot by it let `?workspaceId=a`, `=b` and none run three
// trials of one project side by side — three PLM reads, the exact load this lane exists to stop. The
// tenant is the proven/derived one the route hands in; the project number is the target.
//
// ONE RECORD PER (caller, target, value-bearing?) — a new enqueue overwrites the previous record, so
// the store is bounded without a sweeper. A finished record is kept for the dry-run token's own TTL
// (`DEFAULT_DRY_RUN_TOKEN_TTL_MS`, 30 min) — past it the token inside is dead anyway — and is deleted
// on the first read after that (404). Keys are digests: neither a principal nor a project number ever
// lands in the KV key column in the clear.

const crypto = require('node:crypto')
const { DEFAULT_DRY_RUN_TOKEN_TTL_MS } = require('./stock-preparation-table-actions.cjs')

const STOCK_PREPARATION_DRY_RUN_JOB_STATUSES = Object.freeze(['running', 'succeeded', 'failed'])
const STOCK_PREPARATION_DRY_RUN_JOB_RESULT_TTL_MS = DEFAULT_DRY_RUN_TOKEN_TTL_MS
const DRY_RUN_JOB_KEY_PREFIX = 'stock-preparation:dry-run-job:'
// Which backend process a `running` record belongs to. A record written by an earlier process (a
// restart, an upgrade) can never finish, and must not hold its target forever.
const DRY_RUN_JOB_INSTANCE_ID = crypto.randomUUID()

// storage -> Map(targetKey -> ticket). Keyed by the storage object so two plugin instances (or two
// test mounts) never share a slot.
const inFlightByStorage = new WeakMap()

class StockPreparationDryRunJobError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationDryRunJobError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function ensureDurableDryRunJobStorage(storage) {
  if (!storage || storage.durable !== true || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new StockPreparationDryRunJobError(
      501,
      'STOCK_PREPARATION_DRY_RUN_JOB_STORE_UNAVAILABLE',
      'the background dry-run requires durable job storage',
      { durable: false },
    )
  }
  return storage
}

function inFlightMap(storage) {
  let map = inFlightByStorage.get(storage)
  if (!map) {
    map = new Map()
    inFlightByStorage.set(storage, map)
  }
  return map
}

function digest(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function requiredScope(input = {}) {
  const tenantId = optionalString(input.tenantId)
  const actionId = optionalString(input.actionId)
  const projectNo = optionalString(input.projectNo)
  if (!tenantId || !actionId || !projectNo) {
    throw new StockPreparationDryRunJobError(
      422,
      'STOCK_PREPARATION_DRY_RUN_JOB_SCOPE_REQUIRED',
      'the background dry-run needs a tenant, action and project number',
      {
        tenantIdPresent: Boolean(tenantId),
        actionIdPresent: Boolean(actionId),
        projectNoPresent: Boolean(projectNo),
      },
    )
  }
  return { tenantId, actionId, projectNo }
}

function requiredPrincipal(value) {
  const principal = optionalString(value)
  if (!principal) {
    throw new StockPreparationDryRunJobError(
      422,
      'STOCK_PREPARATION_DRY_RUN_JOB_PRINCIPAL_REQUIRED',
      'the background dry-run requires an authenticated principal',
      {},
    )
  }
  return principal
}

/** The in-flight slot key: one per target, across callers. In-process only, never persisted. */
function dryRunJobTargetKey(input = {}) {
  const scope = requiredScope(input)
  return digest(['target', scope.tenantId, scope.actionId, scope.projectNo])
}

/** The durable record key: one per caller × target × value-bearing. A digest, never a clear value. */
function dryRunJobRecordKey(input = {}) {
  const scope = requiredScope(input)
  const principal = requiredPrincipal(input.principal)
  return `${DRY_RUN_JOB_KEY_PREFIX}${digest(['record', scope.tenantId, scope.actionId, scope.projectNo, principal, input.valueBearing === true])}`
}

function isoAt(ms) {
  return new Date(ms).toISOString()
}

function nowMs(input = {}) {
  return typeof input.now === 'function' ? input.now() : Date.now()
}

/** What either route answers about a job. `result` only once succeeded, `error` only once failed. */
function publicDryRunJob(record, atMs) {
  const startedMs = Date.parse(record.startedAt)
  const finishedMs = record.finishedAt ? Date.parse(record.finishedAt) : NaN
  const endMs = Number.isNaN(finishedMs) ? atMs : finishedMs
  const out = {
    jobId: record.jobId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt || null,
    elapsedMs: Number.isNaN(startedMs) ? 0 : Math.max(0, endMs - startedMs),
  }
  if (record.status === 'succeeded') out.result = record.result
  if (record.status === 'failed') out.error = record.error
  return out
}

/**
 * Claim the target's one in-flight slot for a new job. Pure in-memory and synchronous between the
 * check and the set, so two concurrent enqueues cannot both pass. 409 while the slot is held — by
 * this caller (`ownJob: true`, the web then attaches to it) or by anyone else.
 */
function reserveDryRunJob(input = {}) {
  const storage = ensureDurableDryRunJobStorage(input.storage)
  const targetKey = dryRunJobTargetKey(input)
  const recordKey = dryRunJobRecordKey(input)
  // WHO started it, apart from which record it writes: the same caller pressing with the other
  // `includeMissingComponents` value is still looking at their OWN trial (fix round 1).
  const ownerKey = digest(['owner', requiredPrincipal(input.principal)])
  const inFlight = inFlightMap(storage)
  const held = inFlight.get(targetKey)
  if (held) {
    throw new StockPreparationDryRunJobError(
      409,
      'STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS',
      'a dry-run for this project is already running',
      { status: 'running', ownJob: held.ownerKey === ownerKey },
    )
  }
  const jobId = optionalString(typeof input.createJobId === 'function' ? input.createJobId() : '') || `dry-run-${crypto.randomUUID()}`
  const ticket = {
    jobId,
    targetKey,
    recordKey,
    ownerKey,
    reservedAt: isoAt(nowMs(input)),
    storage,
    detached: false,
    released: false,
    settled: null,
    release() {
      if (ticket.released) return
      ticket.released = true
      if (inFlight.get(targetKey) === ticket) inFlight.delete(targetKey)
    },
  }
  inFlight.set(targetKey, ticket)
  return ticket
}

/**
 * Write the `running` record (BEFORE the caller answers 202, so an immediate poll finds it), then run
 * `run()` detached. Whatever `run` returns is stored verbatim as `result`; whatever it throws is
 * stored as `describeFailure(error)` — the exact envelope the synchronous route would have sent. The
 * slot is released after the terminal record is written, whatever happens.
 */
async function launchDryRunJob(input = {}) {
  const ticket = input.ticket
  if (!ticket || ticket.detached || ticket.released) {
    throw new StockPreparationDryRunJobError(500, 'STOCK_PREPARATION_DRY_RUN_JOB_TICKET_INVALID', 'the background dry-run slot is not held', {})
  }
  const run = input.run
  const describeFailure = typeof input.describeFailure === 'function' ? input.describeFailure : () => ({ code: 'STOCK_PREPARATION_ROUTE_FAILED' })
  const onFailure = typeof input.onFailure === 'function' ? input.onFailure : () => {}
  const onRecordWriteFailure = typeof input.onRecordWriteFailure === 'function' ? input.onRecordWriteFailure : () => {}
  const startedMs = nowMs(input)
  const running = {
    jobId: ticket.jobId,
    status: 'running',
    startedAt: isoAt(startedMs),
    finishedAt: null,
    instanceId: DRY_RUN_JOB_INSTANCE_ID,
  }
  await ticket.storage.set(ticket.recordKey, running)
  ticket.detached = true
  ticket.settled = (async () => {
    let terminal
    try {
      const result = await run()
      terminal = { ...running, status: 'succeeded', finishedAt: isoAt(nowMs(input)), result }
    } catch (error) {
      let envelope
      try { envelope = describeFailure(error) } catch { envelope = { code: 'STOCK_PREPARATION_ROUTE_FAILED' } }
      terminal = { ...running, status: 'failed', finishedAt: isoAt(nowMs(input)), error: envelope }
      try { onFailure(error) } catch { /* a log line never sinks the record */ }
    }
    try {
      await ticket.storage.set(ticket.recordKey, terminal)
    } catch (error) {
      // The next read sees `running` with no live slot and reports INTERRUPTED — never a silent hang.
      try { onRecordWriteFailure(error) } catch { /* idem */ }
    } finally {
      ticket.release()
    }
  })()
  return publicDryRunJob(running, startedMs)
}

/**
 * The caller's job for one target. 404 when there is none, or when a finished one has outlived the
 * dry-run token it carries (deleted on this read). A `running` record with no live slot in THIS
 * process is turned into `failed` / INTERRUPTED here, persisted, and answered as such.
 */
async function readDryRunJob(input = {}) {
  const storage = ensureDurableDryRunJobStorage(input.storage)
  const targetKey = dryRunJobTargetKey(input)
  const recordKey = dryRunJobRecordKey(input)
  const atMs = nowMs(input)
  // THE WINDOW BETWEEN CLAIM AND LAUNCH (fix round 1). The slot is claimed before the B2a fence and the
  // credential load, the `running` record is written only after them — so a second press by the same
  // caller in between is told 409 `ownJob` and attaches, and its first poll must find the job, not 404.
  const pending = inFlightMap(storage).get(targetKey)
  if (pending && !pending.detached && pending.recordKey === recordKey) {
    return publicDryRunJob({ jobId: pending.jobId, status: 'running', startedAt: pending.reservedAt, finishedAt: null }, atMs)
  }
  const record = await storage.get(recordKey)
  if (!record || typeof record !== 'object' || !STOCK_PREPARATION_DRY_RUN_JOB_STATUSES.includes(record.status)) {
    throw new StockPreparationDryRunJobError(404, 'STOCK_PREPARATION_DRY_RUN_JOB_NOT_FOUND', 'no dry-run job for this project', {})
  }
  if (record.status === 'running') {
    const held = inFlightMap(storage).get(targetKey)
    const alive = Boolean(held) && held.jobId === record.jobId && record.instanceId === DRY_RUN_JOB_INSTANCE_ID
    if (alive) return publicDryRunJob(record, atMs)
    const interrupted = {
      ...record,
      status: 'failed',
      finishedAt: isoAt(atMs),
      error: {
        httpStatus: 503,
        code: 'STOCK_PREPARATION_DRY_RUN_JOB_INTERRUPTED',
        message: 'the dry-run was interrupted before it finished; run it again',
      },
    }
    await storage.set(recordKey, interrupted)
    return publicDryRunJob(interrupted, atMs)
  }
  const finishedMs = Date.parse(record.finishedAt)
  if (!Number.isNaN(finishedMs) && atMs - finishedMs > STOCK_PREPARATION_DRY_RUN_JOB_RESULT_TTL_MS) {
    if (typeof storage.delete === 'function') await storage.delete(recordKey)
    throw new StockPreparationDryRunJobError(404, 'STOCK_PREPARATION_DRY_RUN_JOB_NOT_FOUND', 'no dry-run job for this project', { expired: true })
  }
  return publicDryRunJob(record, atMs)
}

/** Test seam: resolves once every detached job on this storage has written its terminal record. */
async function settleDryRunJobsForTest(storage) {
  const map = inFlightByStorage.get(storage)
  if (!map) return
  await Promise.all([...map.values()].map((ticket) => ticket.settled).filter(Boolean))
}

module.exports = {
  STOCK_PREPARATION_DRY_RUN_JOB_STATUSES,
  STOCK_PREPARATION_DRY_RUN_JOB_RESULT_TTL_MS,
  StockPreparationDryRunJobError,
  reserveDryRunJob,
  launchDryRunJob,
  readDryRunJob,
  settleDryRunJobsForTest,
  __internals: {
    DRY_RUN_JOB_INSTANCE_ID,
    DRY_RUN_JOB_KEY_PREFIX,
    dryRunJobRecordKey,
    dryRunJobTargetKey,
    publicDryRunJob,
  },
}
