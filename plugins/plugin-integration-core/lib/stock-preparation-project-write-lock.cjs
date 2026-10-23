'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 SHEET WRITE LOCK — one canonical sheet, one writer, one current plan.
//
// Batch-refresh phase 0, step 1 (docs/development/takeover-beiliao-20260821/batch-refresh-merge-plan-20261022.md
// §5.1 / §7 G5 / §9.2 E01–E04, E07, E08). Two conditions that are NOT the same thing:
//
//   * MUTUAL EXCLUSION — of two runs writing the SAME canonical 备料 sheet, only one may write at a
//     time, across processes (an in-process lock is not a guarantee: two PM2 forks, a restart, a second
//     host each hold their own memory). That is the LEASE below.
//   * PLAN GENERATION — a run that was planned BEFORE a newer plan was made must not write afterwards,
//     even when nobody else is writing. Exclusion cannot stop that: the old run simply waits its turn
//     and then writes the stale plan. That is the GENERATION below. Every applicable small preview made
//     by a caller who may apply, and every large approval, BUMPS it; every artifact that can later write
//     (a small dry-run token, a large checkpoint job) is BOUND to the generation it was planned or
//     approved under; a run compares its binding with the generation it observes AFTER it holds the
//     lease, and re-asserts both in the same single-statement CAS before every write.
//     LARGE LANE (Codex review P1-b): the generation is bound at EXPANSION time, because that is when
//     the large lane reads its source. The expansion start records the sheet's generation token and
//     fencing epoch (observeGeneration — refused while a live writer holds the sheet); the plan is made
//     only while the token is unchanged (readGeneration) and records what it checked; the approval
//     bumps only while token AND epoch are still exactly that (bumpGeneration `expect`, pinned in the
//     CAS). A newer preview, approval or ANY lease taken on the sheet since the expansion read its
//     source makes it stale: 409 PLAN_SUPERSEDED `expansion_stale`; a job carrying no observation
//     (expanded or planned before this, or without the lock) is `expansion_unbound`. So "even
//     sequentially" holds for both lanes: an approval can never revive a plan read before a newer write.
//
// Both live in ONE row per scope in integration_stock_prep_project_write_lock (migration 100), so one
// UPDATE checks lease and generation together and a bump conflicts with a holder's CAS on the same
// PostgreSQL row lock.
//
// SCOPE IDENTITY = the target sheetId alone ('spw2:' + SHA-256, values-free; decision register R-52).
// The foreign-project guard (assertTargetSheetHoldsNoForeignActiveRows) runs on every dry-run, apply and
// large route, so a sheet holds at most ONE active project: a per-sheet lease costs no parallelism, and
// it closes the check-then-write race in which two different project numbers applied to one EMPTY sheet
// at the same moment both pass that guard and both write. The project number is still validated by the
// routes; the tenant is recorded for audit only (sheet ids are globally unique).
//
// THE ORDERING CONTRACT (each invariant is a test, see __tests__/stock-preparation-project-write-lock.test.cjs
// and stock-preparation-project-write-guard-apply.test.cjs):
//   I1  every machine write to the canonical sheet S is issued only immediately after a successful holder
//       CAS on row(S) that pins lease_id, fencing_epoch, lease_seq and generation_token;
//   I2  a bump commits only through an UPDATE requiring lease_id IS NULL, or through the abandoned-lease
//       clear pinned to the exact (lease_id, fencing_epoch, lease_seq) observed at least TTL + GRACE after
//       that lease's last renewal — never while a live holder holds the lease;
//   I3  the executor takes generation_token from the statement that GRANTED the lease and compares it
//       with the artifact's binding before any sheet read or write;
//   I4  the single-use token is consumed only after the lease is held, so a busy refusal never burns it.
//   I5  (Codex review P1-a) every machine record write is HOST FENCED: the writer hands the host this
//       guard's lease + generation (`writeFence` on createRecord / patchRecord — guard.hostWriteFence),
//       and the host re-checks them INSIDE the record write transaction with
//       SELECT 1 ... WHERE scope_key, lease_id, fencing_epoch, generation_token ... FOR SHARE
//       (packages/core-backend/src/multitable/plugin-write-fence.ts, hard-coded allow-list keyed by the
//       calling plugin). Zero rows -> the host refuses the write (nothing written) and the run stops
//       LEASE_LOST / PLAN_SUPERSEDED (guard.hostFenceRefused). A takeover or bump UPDATE waits for an
//       in-flight fenced write to commit; a write that starts after it sees the new row and is refused.
//       So a holder suspended across a takeover can no longer land its in-flight write. After the last
//       write the guard re-asserts once more (guard.reassert): a loss there is LEASE_LOST with the
//       partial counts, never "succeeded". A records host that does not declare `supportsWriteFence`
//       is refused (501) before any write.
//
// NOT IN THE LEASE (named, follow-ups): the carry-confirm / confirm writes
// (stock-preparation-confirm-writes.cjs) write the same sheet without this lease or fence; print and
// copy are out of scope (they do not write the canonical sheet through this path).
//
// FAIL CLOSED. No env flag. Any failure to read or write the row is STORE_FAILED (503), never busy and
// never "proceed without a lock"; a missing table (deploy without the migration) is a STORE_FAILED.
//
// Every operation is ONE statement through the scoped db helper (lib/db.cjs) — no transaction is held
// open across host writes (that would pin one of the host pool's connections for a whole apply and a
// killed backend would take the server down, see the design notes).
//
// KNOWN LIMITS (documented, not fixed here):
//   * CLOCKS. Lease times come from each PROCESS's clock (the scoped db helper takes parameter values,
//     not SQL expressions). GRACE (120 s) absorbs ordinary skew; an instance whose clock runs more than
//     TTL + GRACE ahead of the holder's can take over a live lease early. That is still bounded: the
//     holder's next host-fenced write is refused and its next CAS fails LEASE_LOST, so the two runs never
//     both write after the takeover. There is a single host today.
//   * `interrupted` (WRITE_LOCKED details) is STICKY: it reports that last_interrupted_at was ever set
//     for this sheet, not that the CURRENT holder took over from someone. It is an audit hint only.
//   * `retryAfterMs` is the time until the CURRENT lease could be taken over if its holder stopped
//     renewing (expiry + GRACE - now), not a prediction of when the holder will finish: a live holder
//     keeps renewing, so a retry at that moment can be refused again.
//   * NO MAXIMUM HOLD. A holder whose callback hangs while its process keeps running keeps heartbeating
//     and keeps the sheet; only a stopped process (crash, kill, a stalled event loop) lets the lease
//     lapse. The host's own request timeouts bound the ordinary paths.
//   * BUMP CONTENTION. Concurrent bumps retry with a short backoff; after PROJECT_WRITE_BUMP_MAX_ATTEMPTS
//     the refusal is WRITE_LOCKED with details.reason 'contention' and no holder details — it does NOT
//     claim that a writer exists.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const PROJECT_WRITE_LOCK_TABLE = 'integration_stock_prep_project_write_lock'
// v2 (R-52): the scope is the target sheet alone. v1 ('spw1:', sheet + project) was never deployed.
const PROJECT_WRITE_SCOPE_NAMESPACE = 'stock-prep/sheet-write/v2'
const PROJECT_WRITE_SCOPE_PREFIX = 'spw2:'

// Pinned by the unit suite (L11). Constructor overrides exist for tests only.
const PROJECT_WRITE_LEASE_TTL_MS = 120_000
const PROJECT_WRITE_LEASE_HEARTBEAT_MS = 30_000
const PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS = 120_000
const PROJECT_WRITE_BUMP_MAX_ATTEMPTS = 5
// Backoff between bump attempts: attempt n (1-based) waits n * this before retrying (10+20+30+40 ms max).
const PROJECT_WRITE_BUMP_BACKOFF_MS = 10

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

const PLAN_SUPERSEDED_REASONS = Object.freeze(['newer_plan', 'token_unbound', 'scope_changed', 'job_unbound', 'expansion_stale', 'expansion_unbound'])

// What the host answers a fenced write with (packages/core-backend/src/multitable/plugin-write-fence.ts).
const HOST_WRITE_FENCE_CODES = Object.freeze({
  NOT_ALLOWED: 'PLUGIN_WRITE_FENCE_NOT_ALLOWED',
  REJECTED: 'PLUGIN_WRITE_FENCE_REJECTED',
  UNAVAILABLE: 'PLUGIN_WRITE_FENCE_UNAVAILABLE',
})

function isHostWriteFenceError(error) {
  const code = error && error.code
  return code === HOST_WRITE_FENCE_CODES.NOT_ALLOWED || code === HOST_WRITE_FENCE_CODES.REJECTED || code === HOST_WRITE_FENCE_CODES.UNAVAILABLE
}

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

// The ONE scope identity: the target sheet id (R-52). Values-free (a hash), deterministic, tenant-free.
function sheetWriteScopeKey(sheetId) {
  const sheet = nonEmptyString(sheetId)
  if (!sheet) {
    throw new StockPreparationProjectWriteLockError(500, PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 'sheet write scope needs a target sheet', { reason: 'scope_incomplete' })
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify([PROJECT_WRITE_SCOPE_NAMESPACE, sheet])).digest('hex')
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

// Operations that only ever run BEFORE a write (no lease is held yet, or none is involved). A store
// failure in one of them positively means nothing was written: `partial: false`. A failure of the
// holder CAS (before_write / heartbeat) happens mid-run; the writer's stop then reports `partial` from
// what it actually attempted (review round 2).
const PRE_WRITE_STORE_OPERATIONS = Object.freeze(['acquire', 'precheck', 'bump', 'read', 'observe'])

function storeFailed(operation, error, { fence = false, extra = {} } = {}) {
  const sqlState = sqlStateOf(error)
  return new StockPreparationProjectWriteLockError(
    503,
    PROJECT_WRITE_ERROR_CODES.STORE_FAILED,
    'the sheet write lock store could not be read or written; the write did not continue',
    {
      operation,
      ...(sqlState ? { sqlState } : {}),
      ...(PRE_WRITE_STORE_OPERATIONS.includes(operation) ? { partial: false } : {}),
      ...extra,
    },
    { fence },
  )
}

function assertPurpose(purpose) {
  if (!PROJECT_WRITE_PURPOSES.includes(purpose)) {
    throw new StockPreparationProjectWriteLockError(500, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'unknown sheet write purpose', { reason: 'purpose_unknown' })
  }
  return purpose
}

function assertReason(reason) {
  if (!PROJECT_WRITE_GENERATION_REASONS.includes(reason)) {
    throw new StockPreparationProjectWriteLockError(500, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'unknown sheet write generation reason', { reason: 'generation_reason_unknown' })
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

// EXPANSION-TIME GENERATION (Codex review P1-b). What a large-BOM expansion observed of its write scope
// when it started: the generation token and the fencing epoch, or that no row existed yet (token null,
// epoch 0). The large lane plans and approves ONLY while both are still exactly that — a newer preview /
// approval (token) or ANY lease taken on the sheet (epoch: every write run acquires) since the expansion
// read its source makes that expansion stale.
//
// AN EXPIRED LEASE AT OBSERVATION (review round 4). observeGeneration refuses only a LIVE lease; a lease
// that lapsed (expiry + GRACE) but that nobody took over or cleared is observed, and its holder may still
// resume: its CAS pins lease_id / epoch / seq / token, all unchanged, so it would renew and write under the
// same token and epoch. So the observation also records that lease's { leaseId, leaseSeq }, and a match
// then requires the SAME lease_id AND lease_seq. Every holder CAS (heartbeat, pre-write, final re-assert)
// advances lease_seq, so a resumed holder makes the expansion stale before or right after its first write.
// A lease that is no longer there does NOT match either: release() clears lease_id WITHOUT moving the
// epoch (it pins lease_id + epoch and sets neither epoch nor seq), so "lease_id NULL with the same epoch"
// can mean "the holder came back, wrote and released" — refused, conservatively. The ONE path that may
// move the row past a recorded lease is the approval's own bump: its abandoned-lease clear is the same
// CAS, pinned to exactly that lease_id / epoch / seq / token, so an approval after a crash (the holder
// never came back) still succeeds.
function writeObservationFromGeneration(observed) {
  return {
    writeScope: observed.scopeKey,
    generationToken: observed.generationToken,
    fencingEpoch: observed.fencingEpoch,
    ...(observed.leaseId ? { leaseId: observed.leaseId, leaseSeq: observed.leaseSeq } : {}),
  }
}

function malformedExpectation() {
  return new StockPreparationProjectWriteLockError(500, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'the expected sheet write generation is malformed', { reason: 'expectation_malformed' })
}

function normalizeGenerationExpectation(expect) {
  const tokenOk = expect && (expect.generationToken === null || (typeof expect.generationToken === 'string' && expect.generationToken.length > 0))
  const epochOk = expect && Number.isInteger(expect.fencingEpoch) && expect.fencingEpoch >= 0
  if (!tokenOk || !epochOk || (expect.generationToken === null && expect.fencingEpoch !== 0)) throw malformedExpectation()
  const hasLeaseId = expect.leaseId !== undefined && expect.leaseId !== null
  const hasLeaseSeq = expect.leaseSeq !== undefined && expect.leaseSeq !== null
  if (hasLeaseId !== hasLeaseSeq) throw malformedExpectation()
  if (!hasLeaseId) return { generationToken: expect.generationToken, fencingEpoch: expect.fencingEpoch }
  if (expect.generationToken === null || typeof expect.leaseId !== 'string' || !expect.leaseId
    || !Number.isInteger(expect.leaseSeq) || expect.leaseSeq < 0) throw malformedExpectation()
  return { generationToken: expect.generationToken, fencingEpoch: expect.fencingEpoch, leaseId: expect.leaseId, leaseSeq: expect.leaseSeq }
}

// Does the row (or its absence) still show exactly what the expansion observed?
function rowMatchesExpectation(row, expectation) {
  if (expectation.generationToken === null) return !row
  if (!row || row.generation_token !== expectation.generationToken || integerOf(row.fencing_epoch) !== expectation.fencingEpoch) return false
  // A lease recorded at observation must still be exactly that lease at exactly that seq (see above).
  if (expectation.leaseId) return row.lease_id === expectation.leaseId && integerOf(row.lease_seq) === expectation.leaseSeq
  return true
}

// The same comparison over two readGeneration / observeGeneration answers (the plan-time check).
function generationMatchesObservation(current, observation) {
  if (!current || !observation) return false
  const expectation = normalizeGenerationExpectation(observation)
  if (expectation.generationToken === null) return current.present === false
  return rowMatchesExpectation(current.present ? {
    generation_token: current.generationToken,
    fencing_epoch: current.fencingEpoch,
    lease_id: current.leaseId,
    lease_seq: current.leaseSeq,
  } : null, expectation)
}

function planSuperseded(reason, details = {}, { fence = false } = {}) {
  return new StockPreparationProjectWriteLockError(
    409,
    PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED,
    'a newer preview or approval for this stock-prep sheet exists; preview again before writing',
    { reason, ...details },
    { fence },
  )
}

// I3: compare the artifact's binding with the generation the lease GRANT observed. Called BEFORE any
// write by both lanes, so every refusal here positively reports `partial: false` (review round 2). The token (a UUID
// replaced on every bump) is what decides — never the integer, so a reset row cannot revive an old
// binding. `unboundReason` names an artifact minted before bindings existed (or without the service).
function assertWriteBindingMatchesGuard(binding, guard, { unboundReason = 'token_unbound' } = {}) {
  const writeScope = binding && nonEmptyString(binding.writeScope)
  const writeGenerationToken = binding && nonEmptyString(binding.writeGenerationToken)
  if (!writeScope || !writeGenerationToken) {
    throw planSuperseded(unboundReason, { currentGeneration: guard.generation, partial: false })
  }
  if (writeScope !== guard.scopeKey) {
    throw planSuperseded('scope_changed', { currentGeneration: guard.generation, partial: false })
  }
  if (writeGenerationToken !== guard.generationToken) {
    const tokenGeneration = integerOf(binding.writeGeneration)
    throw planSuperseded('newer_plan', {
      ...(tokenGeneration === null ? {} : { tokenGeneration }),
      currentGeneration: guard.generation,
      ...(guard.generationReason ? { currentReason: guard.generationReason } : {}),
      partial: false,
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
  bumpBackoffMs,
  sleep,
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
  const backoffMs = Number.isInteger(bumpBackoffMs) && bumpBackoffMs >= 0 ? bumpBackoffMs : PROJECT_WRITE_BUMP_BACKOFF_MS
  const pause = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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

  // Lost every CAS race on a row that NO live holder owns (concurrent bumps / acquires): busy, not
  // "another run is writing". Same code (a retryable 409), its own reason and message, no holder details.
  function contentionRefusal() {
    return new StockPreparationProjectWriteLockError(
      409,
      PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED,
      'the sheet write lock is contended right now; retry shortly',
      { reason: 'contention', retryAfterMs: backoffMs * maxBumpAttempts },
    )
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
      'another run is writing this stock-prep sheet; retry after it finishes',
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
    // Two lost CAS races. A live holder is a writer; anything else is contention, not a writer.
    const finalAtMs = nowMs()
    if (leaseIsLive(row, finalAtMs)) throw writeLocked(row, finalAtMs)
    throw contentionRefusal()
  }

  // `expect` (P1-b, large approval): bump ONLY while the row still shows exactly what the expansion
  // observed (generation token AND fencing epoch, or still no row). Checked on every read of the retry loop
  // and PINNED in the CAS itself (token + epoch in the WHERE; the absent case rides the PRIMARY KEY), so a
  // preview, approval or lease that lands between the read and the CAS makes the CAS match nothing and the
  // next read refuses: 409 PLAN_SUPERSEDED `expansion_stale`, nothing bumped.
  async function bumpGeneration(scopeKey, { reason, tenantId, expect } = {}) {
    assertReason(reason)
    const expectation = expect === undefined ? null : normalizeGenerationExpectation(expect)
    let insertConflicted = false
    for (let attempt = 0; attempt < maxBumpAttempts; attempt += 1) {
      if (attempt > 0 && backoffMs > 0) await pause(attempt * backoffMs)
      const row = await readRow(scopeKey, 'bump')
      if (expectation && !rowMatchesExpectation(row, expectation)) {
        throw planSuperseded('expansion_stale', { currentGeneration: row ? integerOf(row.generation) : 0, partial: false })
      }
      if (!row && insertConflicted) {
        // A PRIMARY KEY conflict says the row exists; a read that then finds none is a store fault —
        // the same answer acquire gives, never a busy refusal.
        throw storeFailed('bump', null, { extra: { reason: 'row_vanished' } })
      }
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
          insertConflicted = true
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
          // P1-b: an acquire + release in between leaves the token but moves the epoch.
          ...(expectation ? { fencing_epoch: expectation.fencingEpoch } : {}),
        }, 'bump')
      }
      if (updated.length === 1) {
        return Object.freeze({ scopeKey, generation: integerOf(updated[0].generation), generationToken: updated[0].generation_token })
      }
      // Zero rows: someone moved the row between the read and the CAS. Read again and decide again.
    }
    // Every attempt lost its race. Read once more (as acquire does): a live holder now is a writer,
    // anything else is contention — never "another run is writing" without one (review round 2).
    const lastRow = await readRow(scopeKey, 'bump')
    const lastAtMs = nowMs()
    if (leaseIsLive(lastRow, lastAtMs)) throw writeLocked(lastRow, lastAtMs)
    throw contentionRefusal()
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

  // P1-b: the generation a large-BOM expansion starts under (read-only; an absent row is observed as
  // such). Refused 409 WRITE_LOCKED while a live writer holds the sheet — an expansion must not read its
  // source against a sheet a write is changing.
  async function observeGeneration(scopeKey) {
    const row = await readRow(scopeKey, 'observe')
    const atMs = nowMs()
    if (leaseIsLive(row, atMs)) throw writeLocked(row, atMs)
    return currentGeneration(scopeKey, row)
  }

  // P1-b: the current generation (plan-time check; read-only, no lease refusal).
  async function readGeneration(scopeKey) {
    return currentGeneration(scopeKey, await readRow(scopeKey, 'read'))
  }

  function currentGeneration(scopeKey, row) {
    return Object.freeze({
      scopeKey,
      present: Boolean(row),
      generation: row ? integerOf(row.generation) : 0,
      generationToken: row ? row.generation_token : null,
      fencingEpoch: row ? integerOf(row.fencing_epoch) : 0,
      leaseId: row && row.lease_id ? row.lease_id : null,
      leaseSeq: row && row.lease_id ? (integerOf(row.lease_seq) || 0) : null,
    })
  }

  // The dry-run PRECHECK: refuse a preview while a live writer holds this sheet, before any source
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
      throw await explainLoss(operation)
    }

    // Why this guard may no longer write, read from the row (one statement): the lease is still ours but
    // the plan moved -> PLAN_SUPERSEDED; anything else -> LEASE_LOST; the read fails -> STORE_FAILED.
    async function explainLoss(operation) {
      const row = await readRow(grant.scopeKey, operation, { fence: true })
      if (row && row.lease_id === grant.leaseId && integerOf(row.fencing_epoch) === grant.fencingEpoch && row.generation_token !== grant.generationToken) {
        return planSuperseded('newer_plan', { currentGeneration: integerOf(row.generation) }, { fence: true })
      }
      return new StockPreparationProjectWriteLockError(
        409,
        PROJECT_WRITE_ERROR_CODES.LEASE_LOST,
        'this run lost its write lease on the sheet (it lapsed and was taken over); it stopped before the next write',
        {},
        { fence: true },
      )
    }

    // HOST FENCED WRITE (Codex review P1-a): what the host checks INSIDE each record write transaction
    // (multitable/plugin-write-fence.ts): this lease (scope, lease id, epoch) and this plan (generation
    // token), share-locked until COMMIT. No seq, no expiry — see the host module for why.
    function hostWriteFence() {
      return {
        lock: PROJECT_WRITE_LOCK_TABLE,
        scopeKey: grant.scopeKey,
        leaseId: grant.leaseId,
        fencingEpoch: grant.fencingEpoch,
        generationToken: grant.generationToken,
      }
    }

    // The host refused a fenced write (nothing was written). Translate its answer into this module's
    // vocabulary and mark the guard lost: REJECTED -> LEASE_LOST / PLAN_SUPERSEDED from the row; the
    // fence could not be checked -> STORE_FAILED; the fence was not allowed -> UNAVAILABLE (501).
    async function hostFenceRefused(hostError) {
      const code = hostError && hostError.code
      let error
      if (code === HOST_WRITE_FENCE_CODES.REJECTED) {
        error = await explainLoss('host_fence').catch((readError) => readError)
      } else if (code === HOST_WRITE_FENCE_CODES.UNAVAILABLE) {
        error = storeFailed('host_fence', hostError, { fence: true })
      } else {
        error = new StockPreparationProjectWriteLockError(501, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'the host refused the write fence; nothing is written without it', { reason: 'host_fence_not_allowed' }, { fence: true })
      }
      lost = error
      return error
    }

    // After the last write: one more holder CAS, so a run whose lease was lost after its last write
    // reports that (LEASE_LOST / PLAN_SUPERSEDED with the partial counts) instead of "succeeded".
    async function reassert() {
      if (lost) throw lost
      try {
        await serialized(() => holderCas('final'))
      } catch (error) {
        lost = error
        throw error
      }
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
        if (log) log.warn('[plugin-integration-core] stock-prep sheet write lease heartbeat failed', { code: error && error.code })
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
        if (log) log.warn('[plugin-integration-core] stock-prep sheet write lease release failed; it will expire', { sqlState: sqlStateOf(error) })
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
      hostWriteFence,
      hostFenceRefused,
      reassert,
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
    scopeKeyFor: sheetWriteScopeKey,
    readState,
    assertNoLiveWriter,
    bumpGeneration,
    observeGeneration,
    readGeneration,
    acquire,
    createGuard,
    withProjectWriteLease,
  })
}

module.exports = {
  HOST_WRITE_FENCE_CODES,
  isHostWriteFenceError,
  PLAN_SUPERSEDED_REASONS,
  PROJECT_WRITE_BUMP_BACKOFF_MS,
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
  generationMatchesObservation,
  normalizeGenerationExpectation,
  sheetWriteScopeKey,
  writeBindingFromGeneration,
  writeObservationFromGeneration,
}
