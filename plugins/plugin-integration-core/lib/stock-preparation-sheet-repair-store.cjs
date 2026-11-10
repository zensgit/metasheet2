'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 6d-2a (S6-6; step-6 design §6.6 / §7.3; register row R-91) — THE SHEET-REPAIR LEDGER over
// migration 108. The only writer and the only reader of
//   integration_stock_prep_sheet_repair_run     one row per repair run: recipe, plan digest, approvalRef, the lease
//                                               that ran it, the BACKUP, status and counts
//   integration_stock_prep_sheet_repair_claim   the ONE-SHOT claim of an approved plan (claim_key PRIMARY KEY)
// through the scoped db helper (lib/db.cjs): equality WHERE only, SELECT * projections, no raw SQL.
//
// EVERY WRITE IS LEASED. `beginRun` and `finishRun` each run ONE transaction whose FIRST step is the caller's holder
// assert (`holderWithin(trx)`: the sheet write lock's in-transaction assert — the lock row FOR UPDATE, the caller's
// lease id and fencing epoch still the row's, else 409 LEASE_LOST and a full rollback). So a run row is only ever
// written by the process that holds the sheet's lease right now; a writer frozen across a takeover can neither begin
// nor finish a run. The route runs both inside the guard's host-write bracket (the heartbeat skips while the
// transaction holds the lock row — the N6 rule).
//
// THE BEGIN (one transaction, in this order):
//   1. the holder assert;
//   2. an OPEN run of this sheet is closed `stopped / abandoned`: the caller holds the sheet's lease, the open run
//      was begun under ANOTHER lease (its lease id / epoch are on the row), so that lease is gone and the run can
//      write nothing more (its host writes are fenced out, its own finish would fail step 1). Decided by lease
//      identity, never by a clock. An open run begun under THIS lease is 409 RUN_OPEN (a defect: one lease, one run);
//   3. the run SEQUENCE (the number of runs this sheet's project has) must still be the one the plan was digested
//      with, else 409 PLAN_CHANGED;
//   4. the claim row, BEFORE the run row. The claim key is the table's PRIMARY KEY, so an approved plan is executed at
//      most once: the INSERT of a second claimer dies at the unique index — of two concurrent claimers the second
//      WAITS for the first's commit and then fails there. A failed INSERT aborts the transaction (nothing of steps
//      2-3 survives); the claim is then READ BACK on a fresh handle — a row => 409 ALREADY_CONSUMED, no row =>
//      503 STORE_FAILED. Never a run without its claim (the migration 078 precedent: permanent, no TTL, no steal);
//   5. the run row, status `running`, with its backup (a failure here rolls the claim back with it: nothing is spent);
//   6. the audit row, on the same transaction (a throw rolls everything back).
//
// THREE ANSWERS (fail closed). A read answers rows or THROWS 503 STOCK_PREP_SHEET_REPAIR_STORE_FAILED — never "no
// run" on a failure; a missing table (a deploy without 108) is a store failure. Typed refusals are 4xx with closed codes.
//
// VALUES. Errors and audit details carry handles, closed tokens, counts and SQLSTATE codes only. `project_no` is a
// customer value stored exactly as the project registry (087) stores it; it never goes into an error or a detail.
// ---------------------------------------------------------------------------------------------------

const {
  SHEET_REPAIR_AUDIT,
  SHEET_REPAIR_ERROR_CODES,
  SHEET_REPAIR_RECIPES,
  SHEET_REPAIR_RUN_STATUSES,
  SHEET_REPAIR_STOP_REASONS,
  StockPreparationSheetRepairError,
  claimKeyOf,
  __internals: { APPROVAL_REF_PATTERN, COMPONENT_HANDLE_PATTERN, PLAN_DIGEST_PATTERN, RUN_ID_PATTERN, SHEET_REPAIR_MAX_PLAN_ROWS, alreadyConsumed, backupEntriesOf, planChanged },
} = require('./stock-preparation-sheet-repair.cjs')

const SHEET_REPAIR_TABLES = Object.freeze({
  run: 'integration_stock_prep_sheet_repair_run',
  claim: 'integration_stock_prep_sheet_repair_claim',
})

const RECIPE_RETIRE = SHEET_REPAIR_RECIPES[0]
// A project sheet with more repair runs than this is not something the tool reasons about: the read refuses (503).
const READ_CEILING_RUNS = 2000
const LIST_LIMIT = 50

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function rowsOf(result) {
  if (Array.isArray(result)) return result
  return result && Array.isArray(result.rows) ? result.rows : []
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function intOrNull(value) {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(n) ? n : null
}

function jsonOf(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Values-free: SQLSTATE only (five characters, a class code — never a message, never a value).
function sqlStateOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

function repairError(status, code, message, details = {}) {
  return new StockPreparationSheetRepairError(status, code, message, details)
}

function storeFailed(operation, error, extra = {}) {
  const sqlState = sqlStateOf(error)
  const failure = repairError(503, SHEET_REPAIR_ERROR_CODES.STORE_FAILED, 'the sheet-repair ledger could not be read or written; nothing was written to the sheet', {
    operation,
    ...(sqlState ? { sqlState } : {}),
    ...extra,
    partial: false,
  })
  if (error) failure.cause = error
  return failure
}

function inputInvalid(field) {
  return repairError(500, SHEET_REPAIR_ERROR_CODES.UNAVAILABLE, 'the sheet-repair ledger was handed an invalid input; nothing was written', { field, partial: false })
}

function runOpen() {
  return repairError(409, SHEET_REPAIR_ERROR_CODES.RUN_OPEN, 'a repair run of this sheet is still open under this lease; nothing was written', { reason: 'run_open', partial: false })
}

// A typed refusal (this store's, the holder assert's: an HTTP status and a closed code) passes through.
function isTypedRefusal(error) {
  return Boolean(error) && Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)
}

function translate(error, operation) {
  return isTypedRefusal(error) ? error : storeFailed(operation, error)
}

function normalizeScope(input = {}) {
  if (!isPlainObject(input) || !nonBlankString(input.tenantId) || !nonBlankString(input.sheetId) || !nonBlankString(input.projectNo)) throw inputInvalid('scope')
  return { tenantId: input.tenantId.trim(), sheetId: input.sheetId.trim(), projectNo: input.projectNo.trim() }
}

function assertRowInScope(row, scope, operation) {
  if (!row) return
  if (row.tenant_id !== scope.tenantId || row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) {
    throw storeFailed(operation, null, { reason: 'scope_mismatch' })
  }
}

/** A run as the library reads it (the backup included — server-held, never answered). */
function rowToRun(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    recipe: row.recipe,
    sequence: intOrNull(row.sequence_no),
    planDigest: row.plan_digest,
    approvalRef: row.approval_ref,
    componentHandle: row.component_handle || null,
    sourceRunId: row.source_run_id || null,
    backup: jsonOf(row.backup),
    plannedCount: intOrNull(row.planned_count),
    writtenCount: intOrNull(row.written_count),
    status: row.status,
    stopReason: row.stop_reason || null,
    leaseId: row.lease_id,
    fencingEpoch: intOrNull(row.fencing_epoch),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  })
}

/** The values-free projection the runs route answers: no backup, no principal, no project number, no lease. */
function publicRunOf(run) {
  return {
    runId: run.id,
    recipe: run.recipe,
    sequence: run.sequence,
    status: SHEET_REPAIR_RUN_STATUSES.includes(run.status) ? run.status : null,
    stopReason: SHEET_REPAIR_STOP_REASONS.includes(run.stopReason) ? run.stopReason : null,
    planned: run.plannedCount,
    written: run.writtenCount,
    planDigest: run.planDigest,
    approvalRef: run.approvalRef,
    componentHandle: run.componentHandle,
    sourceRunId: run.sourceRunId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
}

function createStockPreparationSheetRepairStore({ db, now } = {}) {
  if (!db || typeof db.select !== 'function' || typeof db.selectOne !== 'function' || typeof db.insertOne !== 'function'
    || typeof db.updateRow !== 'function' || typeof db.countRows !== 'function' || typeof db.transaction !== 'function') {
    throw new Error('createStockPreparationSheetRepairStore: scoped db helper (select/selectOne/insertOne/updateRow/countRows/transaction) is required')
  }
  const clock = typeof now === 'function' ? now : () => new Date()
  const nowIso = () => {
    const value = clock()
    const date = value instanceof Date ? value : new Date(value)
    return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString()
  }

  function requireTrx(trx) {
    if (!trx || typeof trx.select !== 'function' || typeof trx.selectOne !== 'function' || typeof trx.insertOne !== 'function'
      || typeof trx.updateRow !== 'function' || typeof trx.countRows !== 'function') {
      throw repairError(500, SHEET_REPAIR_ERROR_CODES.UNAVAILABLE, 'the sheet-repair ledger needs the scoped db transaction handle', { field: 'transaction_handle', partial: false })
    }
    return trx
  }

  async function runHolder(holderWithin, trx) {
    try {
      await holderWithin(trx)
    } catch (error) {
      throw translate(error, 'holder')
    }
  }

  async function runAudit(auditWithin, trx, entry) {
    await auditWithin(trx, Object.freeze({ ...entry, detail: Object.freeze({ ...entry.detail }) }))
  }

  async function selectRuns(handle, where, { orderBy = ['sequence_no', 'ASC'], ceiling = READ_CEILING_RUNS, operation }) {
    let rows
    try {
      rows = rowsOf(await handle.select(SHEET_REPAIR_TABLES.run, { where, orderBy, limit: ceiling + 1 }))
    } catch (error) {
      throw storeFailed(operation, error)
    }
    if (rows.length > ceiling) throw storeFailed(operation, null, { reason: 'row_cap', ceiling })
    return rows
  }

  /** The readability probe: one bounded SELECT per table. A missing table (a deploy without 108) is 503 STORE_FAILED. */
  async function probeReadable() {
    for (const [name, table] of Object.entries(SHEET_REPAIR_TABLES)) {
      try {
        await db.select(table, { limit: 1 })
      } catch (error) {
        throw storeFailed('probe', error, { table: name })
      }
    }
    return Object.freeze({ readable: true })
  }

  /**
   * What a plan is built from: the run SEQUENCE of this sheet's project (how many runs it has — the digest's nonce), the
   * ids of its retire runs (a row carrying one of them was retired by this tool), and whether a run of the SHEET is open.
   */
  async function listRunsOf(input = {}) {
    const scope = normalizeScope(input)
    const rows = await selectRuns(db, { sheet_id: scope.sheetId, project_no: scope.projectNo }, { operation: 'list_runs' })
    for (const row of rows) assertRowInScope(row, scope, 'list_runs')
    const open = await selectRuns(db, { sheet_id: scope.sheetId, status: 'running' }, { ceiling: 5, operation: 'list_open_runs' })
    return Object.freeze({
      sequence: rows.length,
      retireRunIds: Object.freeze(rows.filter((row) => row.recipe === RECIPE_RETIRE).map((row) => row.id)),
      openRun: open.length > 0,
    })
  }

  /** The newest runs of this sheet's project, values-free (no backup, no principal). */
  async function listRuns(input = {}) {
    const scope = normalizeScope(input)
    let rows
    try {
      rows = rowsOf(await db.select(SHEET_REPAIR_TABLES.run, { where: { sheet_id: scope.sheetId, project_no: scope.projectNo }, orderBy: ['sequence_no', 'DESC'], limit: LIST_LIMIT + 1 }))
    } catch (error) {
      throw storeFailed('list_runs', error)
    }
    for (const row of rows) assertRowInScope(row, scope, 'list_runs')
    return Object.freeze({ runs: rows.slice(0, LIST_LIMIT).map((row) => publicRunOf(rowToRun(row))), truncated: rows.length > LIST_LIMIT })
  }

  /** One run of this scope with its backup, or null (absent, or of another sheet / project / tenant — the same answer). */
  async function readRun(input = {}) {
    const scope = normalizeScope(input)
    if (typeof input.runId !== 'string' || !RUN_ID_PATTERN.test(input.runId)) return null
    let row
    try {
      row = await db.selectOne(SHEET_REPAIR_TABLES.run, { id: input.runId })
    } catch (error) {
      throw storeFailed('read_run', error)
    }
    if (!row || row.tenant_id !== scope.tenantId || row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) return null
    return rowToRun(row)
  }

  /** The claim of an approved plan, or null. A failure THROWS (never "not consumed"). */
  async function readClaim(input = {}) {
    const scope = normalizeScope(input)
    if (!SHEET_REPAIR_RECIPES.includes(input.recipe)) throw inputInvalid('recipe')
    if (typeof input.planDigest !== 'string' || !PLAN_DIGEST_PATTERN.test(input.planDigest)) throw inputInvalid('planDigest')
    let row
    try {
      row = await db.selectOne(SHEET_REPAIR_TABLES.claim, { claim_key: claimKeyOf({ ...scope, recipe: input.recipe, planDigest: input.planDigest }) })
    } catch (error) {
      throw storeFailed('read_claim', error)
    }
    return row ? Object.freeze({ runId: row.run_id, claimedAt: isoOrNull(row.claimed_at) }) : null
  }

  function normalizeLease(lease) {
    if (!isPlainObject(lease) || !nonBlankString(lease.leaseId) || !Number.isSafeInteger(lease.fencingEpoch) || lease.fencingEpoch < 0) throw inputInvalid('lease')
    return { leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch }
  }

  /** THE BEGIN (module header): holder assert -> abandoned open run -> sequence -> claim -> run row + backup -> audit. */
  async function beginRun(input = {}) {
    const scope = normalizeScope(input)
    if (typeof input.runId !== 'string' || !RUN_ID_PATTERN.test(input.runId)) throw inputInvalid('runId')
    if (!nonBlankString(input.writeScopeKey)) throw inputInvalid('writeScopeKey')
    if (!SHEET_REPAIR_RECIPES.includes(input.recipe)) throw inputInvalid('recipe')
    if (typeof input.planDigest !== 'string' || !PLAN_DIGEST_PATTERN.test(input.planDigest)) throw inputInvalid('planDigest')
    if (typeof input.approvalRef !== 'string' || !APPROVAL_REF_PATTERN.test(input.approvalRef)) throw inputInvalid('approvalRef')
    const retire = input.recipe === RECIPE_RETIRE
    const componentHandle = retire ? input.componentHandle : null
    const sourceRunId = retire ? null : input.sourceRunId
    if (retire && (typeof componentHandle !== 'string' || !COMPONENT_HANDLE_PATTERN.test(componentHandle))) throw inputInvalid('componentHandle')
    if (!retire && (typeof sourceRunId !== 'string' || !RUN_ID_PATTERN.test(sourceRunId))) throw inputInvalid('sourceRunId')
    const entries = backupEntriesOf(input.backup)
    if (!entries || entries.length > SHEET_REPAIR_MAX_PLAN_ROWS) throw inputInvalid('backup')
    if (!Number.isSafeInteger(input.plannedCount) || input.plannedCount !== entries.length) throw inputInvalid('plannedCount')
    if (!Number.isSafeInteger(input.expectSequence) || input.expectSequence < 0) throw inputInvalid('expectSequence')
    const lease = normalizeLease(input.lease)
    if (!nonBlankString(input.startedBy)) throw inputInvalid('startedBy')
    // Both hooks are REQUIRED: a run without its holder assert or its audit row is never begun.
    if (typeof input.holderWithin !== 'function') throw inputInvalid('holderWithin')
    if (typeof input.auditWithin !== 'function') throw inputInvalid('auditWithin')
    const claimKey = claimKeyOf({ ...scope, recipe: input.recipe, planDigest: input.planDigest })
    const at = nowIso()
    let claimFailure = null
    try {
      return await db.transaction(async (handle) => {
        const trx = requireTrx(handle)
        await runHolder(input.holderWithin, trx)
        const open = await selectRuns(trx, { sheet_id: scope.sheetId, status: 'running' }, { ceiling: 5, operation: 'begin_open_runs' })
        for (const row of open) {
          if (row.lease_id === lease.leaseId && intOrNull(row.fencing_epoch) === lease.fencingEpoch) throw runOpen()
          let closed
          try {
            closed = rowsOf(await trx.updateRow(SHEET_REPAIR_TABLES.run, { status: 'stopped', stop_reason: 'abandoned', finished_at: at }, { id: row.id, status: 'running' }))
          } catch (error) {
            throw storeFailed('abandon_run', error)
          }
          if (closed.length !== 1) throw storeFailed('abandon_run', null, { reason: 'run_moved' })
          await runAudit(input.auditWithin, trx, {
            mode: SHEET_REPAIR_AUDIT.modes.abandoned,
            subjectId: row.id,
            detail: { operation: 'sheet_repair_abandon', recipe: row.recipe, planned: intOrNull(row.planned_count) || 0, closedByRun: input.runId, sameProject: row.project_no === scope.projectNo },
          })
        }
        let sequence
        try {
          sequence = await trx.countRows(SHEET_REPAIR_TABLES.run, { sheet_id: scope.sheetId, project_no: scope.projectNo })
        } catch (error) {
          throw storeFailed('begin_sequence', error)
        }
        if (sequence !== input.expectSequence) throw planChanged('sequence_moved')
        try {
          await trx.insertOne(SHEET_REPAIR_TABLES.claim, {
            claim_key: claimKey,
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            recipe: input.recipe,
            plan_digest: input.planDigest,
            run_id: input.runId,
            approval_ref: input.approvalRef,
            claimed_by: input.startedBy.trim(),
            claimed_at: at,
          })
        } catch (error) {
          claimFailure = error
          throw error
        }
        try {
          await trx.insertOne(SHEET_REPAIR_TABLES.run, {
            id: input.runId,
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            write_scope_key: input.writeScopeKey.trim(),
            recipe: input.recipe,
            sequence_no: sequence,
            plan_digest: input.planDigest,
            approval_ref: input.approvalRef,
            component_handle: componentHandle,
            source_run_id: sourceRunId,
            backup: input.backup,
            planned_count: entries.length,
            written_count: null,
            status: 'running',
            stop_reason: null,
            lease_id: lease.leaseId,
            fencing_epoch: lease.fencingEpoch,
            started_by: input.startedBy.trim(),
            started_at: at,
            finished_at: null,
          })
        } catch (error) {
          throw storeFailed('begin_run', error)
        }
        await runAudit(input.auditWithin, trx, {
          mode: SHEET_REPAIR_AUDIT.modes.started,
          subjectId: input.runId,
          detail: {
            operation: 'sheet_repair_begin',
            recipe: input.recipe,
            planned: entries.length,
            sequence,
            planDigest: input.planDigest,
            approvalRef: input.approvalRef,
            ...(retire ? { componentHandle } : { sourceRunId }),
            abandonedRuns: open.length,
          },
        })
        return Object.freeze({ runId: input.runId, sequence, abandonedRuns: open.length })
      })
    } catch (error) {
      if (claimFailure !== null) {
        // The failed INSERT aborted the transaction (run row and audit gone). Decide from the row that is actually
        // there, on a FRESH handle: a claim => this approved plan was already executed; none => fail closed.
        let current
        try {
          current = await db.selectOne(SHEET_REPAIR_TABLES.claim, { claim_key: claimKey })
        } catch (readError) {
          throw storeFailed('claim_read_back', readError)
        }
        if (current) throw alreadyConsumed()
        throw storeFailed('claim', error)
      }
      throw translate(error, 'begin')
    }
  }

  /**
   * THE FINISH: holder assert -> the run row (still `running`, begun under THIS lease) -> `completed` / `stopped` with
   * its counts -> the audit row. A run that is no longer `running` (closed as abandoned by a later run) or belongs to
   * another lease is 409 STOCK_PREP_SHEET_REPAIR_RUN_NOT_OPEN; nothing is written.
   */
  async function finishRun(input = {}) {
    const scope = normalizeScope(input)
    if (typeof input.runId !== 'string' || !RUN_ID_PATTERN.test(input.runId)) throw inputInvalid('runId')
    if (input.status !== 'completed' && input.status !== 'stopped') throw inputInvalid('status')
    const stopReason = input.status === 'stopped' ? input.stopReason : null
    if (input.status === 'stopped' && (!SHEET_REPAIR_STOP_REASONS.includes(stopReason) || stopReason === 'abandoned')) throw inputInvalid('stopReason')
    if (input.status === 'completed' && input.stopReason !== null && input.stopReason !== undefined) throw inputInvalid('stopReason')
    if (!Number.isSafeInteger(input.writtenCount) || input.writtenCount < 0) throw inputInvalid('writtenCount')
    const lease = normalizeLease(input.lease)
    if (typeof input.holderWithin !== 'function') throw inputInvalid('holderWithin')
    if (typeof input.auditWithin !== 'function') throw inputInvalid('auditWithin')
    const at = nowIso()
    try {
      return await db.transaction(async (handle) => {
        const trx = requireTrx(handle)
        await runHolder(input.holderWithin, trx)
        let row
        try {
          row = await trx.selectOne(SHEET_REPAIR_TABLES.run, { id: input.runId })
        } catch (error) {
          throw storeFailed('finish_read', error)
        }
        if (!row || row.tenant_id !== scope.tenantId || row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo
          || row.status !== 'running' || row.lease_id !== lease.leaseId || intOrNull(row.fencing_epoch) !== lease.fencingEpoch) {
          throw repairError(409, SHEET_REPAIR_ERROR_CODES.RUN_NOT_OPEN, 'this repair run is no longer open under this lease; its outcome was not recorded', { reason: 'run_not_open', partial: false })
        }
        const planned = intOrNull(row.planned_count)
        if (input.writtenCount > planned || (input.status === 'completed' && input.writtenCount !== planned)) throw inputInvalid('writtenCount')
        let updated
        try {
          updated = rowsOf(await trx.updateRow(SHEET_REPAIR_TABLES.run, { status: input.status, stop_reason: stopReason, written_count: input.writtenCount, finished_at: at }, { id: input.runId, status: 'running' }))
        } catch (error) {
          throw storeFailed('finish_run', error)
        }
        if (updated.length !== 1) throw storeFailed('finish_run', null, { reason: 'run_moved' })
        await runAudit(input.auditWithin, trx, {
          mode: input.status === 'completed' ? SHEET_REPAIR_AUDIT.modes.completed : SHEET_REPAIR_AUDIT.modes.stopped,
          subjectId: input.runId,
          detail: {
            operation: 'sheet_repair_finish',
            recipe: row.recipe,
            planned,
            written: input.writtenCount,
            ...(stopReason ? { stopReason } : {}),
          },
        })
        return Object.freeze({ runId: input.runId, status: input.status, stopReason, planned, written: input.writtenCount })
      })
    } catch (error) {
      throw translate(error, 'finish')
    }
  }

  return Object.freeze({
    probeReadable,
    listRunsOf,
    listRuns,
    readRun,
    readClaim,
    beginRun,
    finishRun,
  })
}

module.exports = {
  SHEET_REPAIR_TABLES,
  createStockPreparationSheetRepairStore,
  __internals: {
    LIST_LIMIT,
    READ_CEILING_RUNS,
    publicRunOf,
    rowToRun,
    translate,
  },
}
