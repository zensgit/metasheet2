'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 PROJECT WRITE LOCK — one write scope, one writer, one current plan.
//
// Batch-refresh phase 0, step 1 (docs/development/takeover-beiliao-20260821/batch-refresh-merge-plan-20261022.md
// §5.1 / §7 G5 / §9.2 E01–E04, E07, E08). Two conditions that are NOT the same thing:
//
//   * MUTUAL EXCLUSION — of two runs writing the SAME project on the SAME canonical sheet, only one may
//     write at a time, across processes (an in-process lock is not a guarantee: two PM2 forks, a
//     restart, a second host each hold their own memory). That is the LEASE below.
//   * PLAN GENERATION — a run that was planned BEFORE a newer plan was made must not write afterwards,
//     even sequentially, even when nobody else is writing. Exclusion cannot stop that: the old run
//     simply waits its turn and then writes the stale plan. That is the GENERATION below. Every
//     applicable small preview and every large approval BUMPS it; every artifact that can later write
//     (a small dry-run token, a large checkpoint job) is BOUND to the generation it was planned under;
//     a run compares its binding with the generation it observes AFTER it holds the lease, and
//     re-asserts both in the same single-statement CAS before every write.
//
// Both live in ONE row per scope in integration_stock_prep_project_write_lock (migration 100), so one
// UPDATE checks lease and generation together and a bump conflicts with a holder's CAS on the same
// PostgreSQL row lock.
//
// SCOPE IDENTITY = (target sheetId, normalized projectNo), SHA-256 hashed — values-free. The tenant is
// recorded for audit only and is NOT part of the identity: sheet ids are globally unique and the writer
// selects existing rows by projectNo alone on that sheet, so two tenants naming one sheet+project are
// the same write target and must exclude each other.
//
// THE ORDERING CONTRACT (each invariant is a test, see __tests__/stock-preparation-project-write-lock.test.cjs
// and stock-preparation-project-write-guard-apply.test.cjs):
//   I1  every machine write to the canonical sheet for scope S is issued only immediately after a
//       successful holder CAS on row(S) that pins lease_id, fencing_epoch, lease_seq and generation_token;
//   I2  a bump commits only through an UPDATE requiring lease_id IS NULL, or through the abandoned-lease
//       clear pinned to the exact (lease_id, fencing_epoch, lease_seq) observed at least TTL + GRACE after
//       that lease's last renewal — never while a live holder holds the lease;
//   I3  the executor takes generation_token from the statement that GRANTED the lease and compares it
//       with the artifact's binding before any sheet read or write;
//   I4  the single-use token is consumed only after the lease is held, so a busy refusal never burns it.
//
// ACCEPTED RESIDUAL (R1, phase 1). The multitable records API offers no write that is conditional on a
// plugin-table row, so TRUE storage-side fencing is impossible from here (the same ceiling the 077
// reconcile lease documents). A holder suspended for at least TTL + GRACE (4 minutes) can have ONE host
// write already in flight across the suspension; that write may commit after a takeover. It is bounded
// to one write (the next CAS fails LEASE_LOST) and is recorded (last_interrupted_*) for G6 recovery.
// Closing it needs host fenced writes (a `writeFence` option on plugin createRecord/patchRecord that
// locks this row FOR SHARE inside the write transaction) — a follow-up, not this module.
//
// FAIL CLOSED. No env flag. Any failure to read or write the row is STORE_FAILED (503), never busy and
// never "proceed without a lock"; a missing table (deploy without the migration) is a STORE_FAILED.
//
// Every operation is ONE statement through the scoped db helper (lib/db.cjs) — no transaction is held
// open across host writes (that would pin one of the host pool's connections for a whole apply and a
// killed backend would take the server down, see the design notes). Timestamps are this process's clock;
// GRACE absorbs clock skew between processes.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const PROJECT_WRITE_LOCK_TABLE = 'integration_stock_prep_project_write_lock'
const PROJECT_WRITE_SCOPE_NAMESPACE = 'stock-prep/project-write/v1'
const PROJECT_WRITE_SCOPE_PREFIX = 'spw1:'

// Pinned by the unit suite (L11). Constructor overrides exist for tests only.
const PROJECT_WRITE_LEASE_TTL_MS = 120_000
const PROJECT_WRITE_LEASE_HEARTBEAT_MS = 30_000
const PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS = 120_000
const PROJECT_WRITE_BUMP_MAX_ATTEMPTS = 5

// Closed vocabularies. A later increment adds its own tokens WITH its feature (e.g. a content-change
// review confirm), never ahead of it.
const PROJECT_WRITE_PURPOSES = Object.freeze(['small_apply', 'large_apply_chunk'])
const PROJECT_WRITE_GENERATION_REASONS = Object.freeze(['small_preview', 'large_approval'])

const PROJECT_WRITE_ERROR_CODES = Object.freeze({
  WRITE_LOCKED: 'STOCK_PREP_PROJECT_WRITE_LOCKED',
  PLAN_SUPERSEDED: 'STOCK_PREP_PROJECT_PLAN_SUPERSEDED',
  LEASE_LOST: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST',
  STORE_FAILED: 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED',
  UNAVAILABLE: 'STOCK_PREP_PROJECT_WRITE_LOCK_UNAVAILABLE',
  GUARD_SCOPE_MISMATCH: 'STOCK_PREP_PROJECT_WRITE_GUARD_SCOPE_MISMATCH',
})

const PLAN_SUPERSEDED_REASONS = Object.freeze(['newer_plan', 'token_unbound', 'scope_changed', 'job_unbound'])

class StockPreparationProjectWriteLockError extends Error {
  // `fence` marks an error raised by a pre-write CAS: the apply writer stops its loop on it instead of
  // recording one failed row and carrying on with the next.
  constructor(status, code, message, details = {}, { fence = false } = {}) {
    super(message)
    this.name = 'StockPreparationProjectWriteLockError'
    this.status = status
    this.code = code
    this.details = details
    this.fence = fence === true
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// The ONE scope identity. Inputs are the target sheet id and the NORMALIZED project number (the caller
// normalizes with normalizeActionParameters, the same function the writer's row selection uses).
function projectWriteScopeKey(sheetId, projectNo) {
  const sheet = nonEmptyString(sheetId)
  const project = nonEmptyString(projectNo)
  if (!sheet || !project) {
    throw new StockPreparationProjectWriteLockError(500, PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 'project write scope needs a target sheet and a project number', { reason: 'scope_incomplete' })
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify([PROJECT_WRITE_SCOPE_NAMESPACE, sheet, project])).digest('hex')
  return `${PROJECT_WRITE_SCOPE_PREFIX}${digest}`
}

function rowsOf(result) {
  if (Array.isArray(result)) return result
  return result && Array.isArray(result.rows) ? result.rows : []
}

function isUniqueViolation(error) {
  return Boolean(error && error.code === '23505')
}

function timeMs(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function isoOrNull(value) {
  const ms = timeMs(value)
  return ms === null ? null : new Date(ms).toISOString()
}

function integerOf(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) ? n : null
}

// Values-free: SQLSTATE only (five characters, a class code — never a message, never a value).
function sqlStateOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

function storeFailed(operation, error, { fence = false, extra = {} } = {}) {
  const sqlState = sqlStateOf(error)
  return new StockPreparationProjectWriteLockError(
    503,
    PROJECT_WRITE_ERROR_CODES.STORE_FAILED,
    'the project write lock store could not be read or written; nothing was written under it',
    { operation, ...(sqlState ? { sqlState } : {}), ...extra },
    { fence },
  )
}

function assertPurpose(purpose) {
  if (!PROJECT_WRITE_PURPOSES.includes(purpose)) {
    throw new StockPreparationProjectWriteLockError(500, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'unknown project write purpose', { reason: 'purpose_unknown' })
  }
  return purpose
}

function assertReason(reason) {
  if (!PROJECT_WRITE_GENERATION_REASONS.includes(reason)) {
    throw new StockPreparationProjectWriteLockError(500, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'unknown project write generation reason', { reason: 'generation_reason_unknown' })
  }
  return reason
}

// The binding an artifact stores ALONGSIDE its existing fields (never hashed into a revision).
function writeBindingFromGeneration(generation) {
  return {
    writeScope: generation.scopeKey,
    writeGeneration: generation.generation,
    writeGenerationToken: generation.generationToken,
  }
}

function planSuperseded(reason, details = {}, { fence = false } = {}) {
  return new StockPreparationProjectWriteLockError(
    409,
    PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED,
    'a newer preview of this project exists; preview again before writing',
    { reason, ...details },
    { fence },
  )
}

// I3: compare the artifact's binding with the generation the lease GRANT observed. The token (a UUID
// replaced on every bump) is what decides — never the integer, so a reset row cannot revive an old
// binding. `unboundReason` names an artifact minted before bindings existed (or without the service).
function assertWriteBindingMatchesGuard(binding, guard, { unboundReason = 'token_unbound' } = {}) {
  const writeScope = binding && nonEmptyString(binding.writeScope)
  const writeGenerationToken = binding && nonEmptyString(binding.writeGenerationToken)
  if (!writeScope || !writeGenerationToken) {
    throw planSuperseded(unboundReason, { currentGeneration: guard.generation })
  }
  if (writeScope !== guard.scopeKey) {
    throw planSuperseded('scope_changed', { currentGeneration: guard.generation })
  }
  if (writeGenerationToken !== guard.generationToken) {
    const tokenGeneration = integerOf(binding.writeGeneration)
    throw planSuperseded('newer_plan', {
      ...(tokenGeneration === null ? {} : { tokenGeneration }),
      currentGeneration: guard.generation,
      ...(guard.generationReason ? { currentReason: guard.generationReason } : {}),
    })
  }
}

function createStockPreparationProjectWriteLock({
  db,
  now,
  ttlMs,
  heartbeatMs,
  takeoverGraceMs,
  bumpMaxAttempts,
  idGenerator,
  timers,
  logger,
} = {}) {
  if (!db || typeof db.selectOne !== 'function' || typeof db.insertOne !== 'function' || typeof db.updateRow !== 'function') {
    throw new Error('createStockPreparationProjectWriteLock: scoped db helper (selectOne/insertOne/updateRow) is required')
  }
  const ttl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : PROJECT_WRITE_LEASE_TTL_MS
  const heartbeatEvery = Number.isInteger(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : PROJECT_WRITE_LEASE_HEARTBEAT_MS
  const grace = Number.isInteger(takeoverGraceMs) && takeoverGraceMs >= 0 ? takeoverGraceMs : PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS
  const maxBumpAttempts = Number.isInteger(bumpMaxAttempts) && bumpMaxAttempts > 0 ? bumpMaxAttempts : PROJECT_WRITE_BUMP_MAX_ATTEMPTS
  const clock = typeof now === 'function' ? now : () => new Date()
  const newId = typeof idGenerator === 'function' ? idGenerator : () => crypto.randomUUID()
  const timerApi = timers && typeof timers.setInterval === 'function' ? timers : { setInterval, clearInterval }
  const log = logger && typeof logger.warn === 'function' ? logger : null

  function nowMs() {
    const value = clock()
    const ms = timeMs(value)
    return ms === null ? Date.now() : ms
  }

  async function readRow(scopeKey, operation, { fence = false } = {}) {
    try {
      return await db.selectOne(PROJECT_WRITE_LOCK_TABLE, { scope_key: scopeKey })
    } catch (error) {
      throw storeFailed(operation, error, { fence })
    }
  }

  async function update(set, where, operation, { fence = false } = {}) {
    try {
      return rowsOf(await db.updateRow(PROJECT_WRITE_LOCK_TABLE, set, where))
    } catch (error) {
      throw storeFailed(operation, error, { fence })
    }
  }

  // A lease is LIVE until its expiry plus the takeover grace. Within that window it is busy to
  // everyone else (acquire, bump and the dry-run precheck alike).
  function leaseIsLive(row, atMs) {
    if (!row || !row.lease_id) return false
    const expires = timeMs(row.lease_expires_at)
    if (expires === null) return true // an unreadable expiry is never treated as abandoned
    return atMs < expires + grace
  }

  function writeLocked(row, atMs, extra = {}) {
    const expires = row ? timeMs(row.lease_expires_at) : null
    const details = {
      ...(row && row.lease_purpose && PROJECT_WRITE_PURPOSES.includes(row.lease_purpose) ? { holderPurpose: row.lease_purpose } : {}),
      ...(row && row.lease_acquired_at ? { heldSince: isoOrNull(row.lease_acquired_at) } : {}),
      ...(expires !== null ? { leaseExpiresAt: new Date(expires).toISOString(), retryAfterMs: Math.max(0, expires + grace - atMs) } : {}),
      interrupted: Boolean(row && row.last_interrupted_at),
      ...extra,
    }
    return new StockPreparationProjectWriteLockError(
      409,
      PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED,
      'another run is writing this project; retry after it finishes',
      details,
    )
  }

  function leaseColumns({ leaseId, purpose, runId, atMs }) {
    const at = new Date(atMs).toISOString()
    return {
      lease_id: leaseId,
      lease_seq: 0,
      lease_purpose: purpose,
      lease_run_id: nonEmptyString(runId),
      lease_acquired_at: at,
      lease_expires_at: new Date(atMs + ttl).toISOString(),
      lease_heartbeat_at: at,
    }
  }

  function grantFrom(row, { leaseId, priorFencingEpoch, takeover }) {
    return Object.freeze({
      scopeKey: row.scope_key,
      leaseId,
      fencingEpoch: integerOf(row.fencing_epoch),
      priorFencingEpoch,
      leaseSeq: integerOf(row.lease_seq),
      // I3: FROM THE ROW THE GRANTING STATEMENT RETURNED — not from the read before it.
      generation: integerOf(row.generation),
      generationToken: row.generation_token,
      generationReason: PROJECT_WRITE_GENERATION_REASONS.includes(row.generation_reason) ? row.generation_reason : null,
      takeover: takeover === true,
    })
  }

  async function acquire(scopeKey, { purpose, runId, tenantId } = {}) {
    assertPurpose(purpose)
    let row = await readRow(scopeKey, 'acquire')
    let insertConflicted = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const atMs = nowMs()
      const at = new Date(atMs).toISOString()
      const leaseId = newId()
      if (!row) {
        if (insertConflicted) {
          // A PRIMARY KEY conflict says the row exists; a read that then finds none is a store fault.
          throw storeFailed('acquire', null, { extra: { reason: 'row_vanished' } })
        }
        try {
          const inserted = rowsOf(await db.insertOne(PROJECT_WRITE_LOCK_TABLE, {
            scope_key: scopeKey,
            tenant_id: nonEmptyString(tenantId),
            generation: 0,
            generation_token: newId(),
            generation_reason: null,
            generation_bumped_at: null,
            fencing_epoch: 1,
            ...leaseColumns({ leaseId, purpose, runId, atMs }),
            created_at: at,
            updated_at: at,
          }))
          if (inserted.length !== 1) throw storeFailed('acquire', null, { extra: { reason: 'insert_returned_nothing' } })
          return grantFrom(inserted[0], { leaseId, priorFencingEpoch: 0, takeover: false })
        } catch (error) {
          if (error instanceof StockPreparationProjectWriteLockError) throw error
          if (!isUniqueViolation(error)) throw storeFailed('acquire', error)
          insertConflicted = true
          row = await readRow(scopeKey, 'acquire')
          continue
        }
      }
      const epoch = integerOf(row.fencing_epoch) || 0
      if (row.lease_id) {
        if (leaseIsLive(row, atMs)) throw writeLocked(row, atMs)
        // TAKEOVER of a lapsed lease: pinned to the exact holder, epoch AND seq observed, so a holder
        // that renewed in between (seq moved) keeps its lease and this CAS matches nothing.
        const updated = await update({
          ...leaseColumns({ leaseId, purpose, runId, atMs }),
          fencing_epoch: epoch + 1,
          last_interrupted_run_id: row.lease_run_id || null,
          last_interrupted_purpose: row.lease_purpose || null,
          last_interrupted_at: at,
          tenant_id: nonEmptyString(tenantId),
          updated_at: at,
        }, {
          scope_key: scopeKey,
          lease_id: row.lease_id,
          fencing_epoch: epoch,
          lease_seq: integerOf(row.lease_seq) || 0,
        }, 'acquire')
        if (updated.length === 1) return grantFrom(updated[0], { leaseId, priorFencingEpoch: epoch, takeover: true })
      } else {
        const updated = await update({
          ...leaseColumns({ leaseId, purpose, runId, atMs }),
          fencing_epoch: epoch + 1,
          tenant_id: nonEmptyString(tenantId),
          updated_at: at,
        }, {
          scope_key: scopeKey,
          lease_id: null,
          fencing_epoch: epoch,
        }, 'acquire')
        if (updated.length === 1) return grantFrom(updated[0], { leaseId, priorFencingEpoch: epoch, takeover: false })
      }
      // Lost a race on the row: read it once more and decide again.
      row = await readRow(scopeKey, 'acquire')
    }
    throw writeLocked(row, nowMs(), { reason: 'contention' })
  }

  async function bumpGeneration(scopeKey, { reason, tenantId } = {}) {
    assertReason(reason)
    for (let attempt = 0; attempt < maxBumpAttempts; attempt += 1) {
      const row = await readRow(scopeKey, 'bump')
      const atMs = nowMs()
      const at = new Date(atMs).toISOString()
      const token = newId()
      if (!row) {
        try {
          const inserted = rowsOf(await db.insertOne(PROJECT_WRITE_LOCK_TABLE, {
            scope_key: scopeKey,
            tenant_id: nonEmptyString(tenantId),
            generation: 1,
            generation_token: token,
            generation_reason: reason,
            generation_bumped_at: at,
            fencing_epoch: 0,
            lease_id: null,
            lease_seq: 0,
            lease_purpose: null,
            lease_run_id: null,
            lease_acquired_at: null,
            lease_expires_at: null,
            lease_heartbeat_at: null,
            created_at: at,
            updated_at: at,
          }))
          if (inserted.length !== 1) throw storeFailed('bump', null, { extra: { reason: 'insert_returned_nothing' } })
          return Object.freeze({ scopeKey, generation: 1, generationToken: token })
        } catch (error) {
          if (error instanceof StockPreparationProjectWriteLockError) throw error
          if (!isUniqueViolation(error)) throw storeFailed('bump', error)
          continue
        }
      }
      const generation = integerOf(row.generation) || 0
      const bumped = {
        generation: generation + 1,
        generation_token: token,
        generation_reason: reason,
        generation_bumped_at: at,
        tenant_id: nonEmptyString(tenantId),
        updated_at: at,
      }
      let updated
      if (row.lease_id) {
        // I2: never while a live holder holds the lease (grace included).
        if (leaseIsLive(row, atMs)) throw writeLocked(row, atMs)
        // An ABANDONED lease (lapsed beyond grace): clear it, record the interruption, advance the
        // epoch and bump — one CAS pinned to everything observed.
        const epoch = integerOf(row.fencing_epoch) || 0
        updated = await update({
          ...bumped,
          lease_id: null,
          lease_purpose: null,
          lease_run_id: null,
          lease_acquired_at: null,
          lease_expires_at: null,
          lease_heartbeat_at: null,
          fencing_epoch: epoch + 1,
          last_interrupted_run_id: row.lease_run_id || null,
          last_interrupted_purpose: row.lease_purpose || null,
          last_interrupted_at: at,
        }, {
          scope_key: scopeKey,
          lease_id: row.lease_id,
          fencing_epoch: epoch,
          lease_seq: integerOf(row.lease_seq) || 0,
          generation_token: row.generation_token,
        }, 'bump')
      } else {
        updated = await update(bumped, {
          scope_key: scopeKey,
          lease_id: null,
          generation_token: row.generation_token,
        }, 'bump')
      }
      if (updated.length === 1) {
        return Object.freeze({ scopeKey, generation: integerOf(updated[0].generation), generationToken: updated[0].generation_token })
      }
      // Zero rows: someone moved the row between the read and the CAS. Read again and decide again.
    }
    throw writeLocked(null, nowMs(), { reason: 'contention' })
  }

  async function readState(scopeKey) {
    const row = await readRow(scopeKey, 'read')
    if (!row) return Object.freeze({ present: false, generation: 0, fencingEpoch: 0, leaseHeld: false })
    const atMs = nowMs()
    return Object.freeze({
      present: true,
      generation: integerOf(row.generation),
      generationReason: PROJECT_WRITE_GENERATION_REASONS.includes(row.generation_reason) ? row.generation_reason : null,
      generationBumpedAt: isoOrNull(row.generation_bumped_at),
      fencingEpoch: integerOf(row.fencing_epoch),
      leaseHeld: Boolean(row.lease_id),
      leaseLive: leaseIsLive(row, atMs),
      leasePurpose: PROJECT_WRITE_PURPOSES.includes(row.lease_purpose) ? row.lease_purpose : null,
      leaseExpiresAt: isoOrNull(row.lease_expires_at),
      lastInterruptedPurpose: PROJECT_WRITE_PURPOSES.includes(row.last_interrupted_purpose) ? row.last_interrupted_purpose : null,
      lastInterruptedAt: isoOrNull(row.last_interrupted_at),
    })
  }

  // The dry-run PRECHECK: refuse a preview while a live writer holds this project, before any source
  // read. Read-only; an absent row is the legitimate initial state.
  async function assertNoLiveWriter(scopeKey) {
    const row = await readRow(scopeKey, 'precheck')
    const atMs = nowMs()
    if (leaseIsLive(row, atMs)) throw writeLocked(row, atMs)
  }

  function createGuard(grant) {
    let seq = grant.leaseSeq || 0
    let chain = Promise.resolve()
    let inFlight = 0
    let lost = null
    let released = false
    let timer = null

    // The holder CAS — I1. One statement pinning lease_id, fencing_epoch, lease_seq and
    // generation_token, extending the lease. Serialized per guard (heartbeat and pre-write CAS never
    // overlap, so seq is never raced by our own two callers).
    async function holderCas(operation) {
      const atMs = nowMs()
      const at = new Date(atMs).toISOString()
      const updated = await update({
        lease_seq: seq + 1,
        lease_expires_at: new Date(atMs + ttl).toISOString(),
        lease_heartbeat_at: at,
        updated_at: at,
      }, {
        scope_key: grant.scopeKey,
        lease_id: grant.leaseId,
        fencing_epoch: grant.fencingEpoch,
        lease_seq: seq,
        generation_token: grant.generationToken,
      }, operation, { fence: true })
      if (updated.length === 1) {
        seq += 1
        return
      }
      const row = await readRow(grant.scopeKey, operation, { fence: true })
      if (row && row.lease_id === grant.leaseId && integerOf(row.fencing_epoch) === grant.fencingEpoch && row.generation_token !== grant.generationToken) {
        throw planSuperseded('newer_plan', { currentGeneration: integerOf(row.generation) }, { fence: true })
      }
      throw new StockPreparationProjectWriteLockError(
        409,
        PROJECT_WRITE_ERROR_CODES.LEASE_LOST,
        'this run lost its write lease on the project (it lapsed and was taken over); it stopped before the next write',
        {},
        { fence: true },
      )
    }

    function serialized(fn) {
      inFlight += 1
      const run = chain.then(fn)
      chain = run.then(() => { inFlight -= 1 }, () => { inFlight -= 1 })
      return run
    }

    async function beforeWrite() {
      if (released) {
        throw new StockPreparationProjectWriteLockError(409, PROJECT_WRITE_ERROR_CODES.LEASE_LOST, 'the write lease was already released', {}, { fence: true })
      }
      if (lost) throw lost
      try {
        await serialized(() => holderCas('before_write'))
      } catch (error) {
        lost = error
        throw error
      }
    }

    function heartbeat() {
      if (released || lost || inFlight > 0) return Promise.resolve()
      return serialized(() => holderCas('heartbeat')).catch((error) => {
        lost = error
        if (log) log.warn('[plugin-integration-core] stock-prep project write lease heartbeat failed', { code: error && error.code })
      })
    }

    function startHeartbeat() {
      if (timer || released) return
      // `heartbeat` never rejects (failures set `lost`); the promise is returned only so an injected
      // test timer can await the tick.
      timer = timerApi.setInterval(() => heartbeat(), heartbeatEvery)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }

    async function release() {
      if (released) return
      released = true
      if (timer) {
        timerApi.clearInterval(timer)
        timer = null
      }
      try {
        await chain
      } catch {
        // chain never rejects (see serialized); kept for safety
      }
      try {
        await db.updateRow(PROJECT_WRITE_LOCK_TABLE, {
          lease_id: null,
          lease_purpose: null,
          lease_run_id: null,
          lease_acquired_at: null,
          lease_expires_at: null,
          lease_heartbeat_at: null,
          updated_at: new Date(nowMs()).toISOString(),
        }, {
          scope_key: grant.scopeKey,
          lease_id: grant.leaseId,
          fencing_epoch: grant.fencingEpoch,
        })
      } catch (error) {
        // Best-effort: an unreleased lease expires (TTL + GRACE) and is taken over.
        if (log) log.warn('[plugin-integration-core] stock-prep project write lease release failed; it will expire', { sqlState: sqlStateOf(error) })
      }
    }

    return Object.freeze({
      scopeKey: grant.scopeKey,
      fencingEpoch: grant.fencingEpoch,
      priorFencingEpoch: grant.priorFencingEpoch,
      generation: grant.generation,
      generationToken: grant.generationToken,
      generationReason: grant.generationReason,
      takeover: grant.takeover,
      beforeWrite,
      heartbeat,
      startHeartbeat,
      release,
      isLost: () => Boolean(lost),
    })
  }

  // acquire -> guard -> heartbeat -> fn(guard) -> release (always).
  async function withProjectWriteLease(scopeKey, options, fn) {
    const grant = await acquire(scopeKey, options)
    const guard = createGuard(grant)
    guard.startHeartbeat()
    try {
      return await fn(guard)
    } finally {
      await guard.release()
    }
  }

  return Object.freeze({
    scopeKeyFor: projectWriteScopeKey,
    readState,
    assertNoLiveWriter,
    bumpGeneration,
    acquire,
    createGuard,
    withProjectWriteLease,
  })
}

module.exports = {
  PLAN_SUPERSEDED_REASONS,
  PROJECT_WRITE_BUMP_MAX_ATTEMPTS,
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_GENERATION_REASONS,
  PROJECT_WRITE_LEASE_HEARTBEAT_MS,
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS,
  PROJECT_WRITE_LEASE_TTL_MS,
  PROJECT_WRITE_LOCK_TABLE,
  PROJECT_WRITE_PURPOSES,
  PROJECT_WRITE_SCOPE_NAMESPACE,
  StockPreparationProjectWriteLockError,
  assertWriteBindingMatchesGuard,
  createStockPreparationProjectWriteLock,
  projectWriteScopeKey,
  writeBindingFromGeneration,
}
