'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 4, PR-6 — THE GOVERNED-SHEET PROBE for the GENERIC CONFIGURED WRITERS (design §7.1
// rows 17-18, §14, D-21; §23.4 F-6).
//
// The stock-prep lanes consult the governance (PR-3) before they write a project sheet. Three other writers can
// write ANY multitable sheet whose id comes from CONFIGURATION, not from a stock-prep lane:
//   - the pipelines target adapter `upsert` (lib/adapters/metasheet-multitable-target-adapter.cjs), reached by a
//     live pipeline run, a dead-letter replay and the in-process communication door;
//   - the C6 raw write-source `test` / `insertRows` / `updateRows` (same file), reached by the C6 external-write
//     dry-run and apply routes;
//   - the ERP feedback writer `updateRecords` (lib/erp-feedback.cjs), reached after every live pipeline write.
// Before PR-6 they wrote a governed (pilot or persisted-refresh-rows) sheet's machine columns unrefused (review of
// #6550, V50B-12): PR B's readiness check `no_generic_writer_names_sheet` is point-in-time, so a writer configured
// AFTER enablement was never seen (F-6). This module answers, per sheet, whether that sheet is governed, and each
// seam refuses a governed sheet BEFORE any records IO.
//
// GOVERNED (the consult's predicate, read BY SHEET — a generic writer holds a sheet id and nothing else):
//   the registry row registered on this sheet carries the pilot stamp (PR B, migration 101)       -> 'pilot'
//   OR any continuation row on this sheet, of ANY status (an ended relationship still governs)    -> 'continuation'
//   OR any OPEN hold on this sheet                                                                 -> 'hold'
//   OR any refresh-state row on this sheet                                                         -> 'state'
//   OR any execution row on this sheet                                                             -> 'execution'
// First true wins, as the values-free `reason` token. Registered-but-not-pilot with no rows is NOT governed (GV-1).
//
// THREE ANSWERS, NEVER TWO (design §5.1, D-3): a thrown read is 503 STOCK_PREP_REFRESH_STORE_FAILED (never "not
// governed", never cached); a probe built without its stores is 501 STOCK_PREP_REFRESH_STORE_UNAVAILABLE; only a
// probe whose every read answered says "not governed". A refusal is 409
// METASHEET_MULTITABLE_STOCK_PREP_GOVERNED_SHEET (design §14). A seam built WITHOUT a probe refuses an object id in
// the stock-prep namespace with 501 STOCK_PREP_GOVERNED_SHEET_PROBE_UNWIRED (the not-wired backstop; the wiring
// itself is pinned by the source scan suite).
//
// THE TENANT. The registry row's tenant is compared with the writer's tenant when both are known; a mismatch rides
// along as `registry.tenantMatches: false` (and `details.tenantMismatch: true` on a refusal) but does NOT refuse a
// sheet that is not governed: generic writers to non-governed sheets stay byte-identical to main (plan Q-2).
//
// POINT IN TIME. The probe holds no lease and takes no snapshot: a pilot enable or a first hold that lands between
// the probe and the write of the same run is not seen (residual risk R-1; PR B's readiness check and the export
// digest are the other layers).
//
// VALUES-FREE. Errors carry closed tokens (surface, reason, store, operation, a five-character SQLSTATE class), the
// configured OBJECT KEY and booleans — never a sheet id, a project number, a tenant or a hold value.
//
// Hermetic: no env flag, no write, no host records IO — plugin-SQL reads only (one registry SELECT by sheet, four
// COUNTs). It does NOT require the continuation store module (the stores are injected), so the generic writers that
// require this file do not pull the planner into their load graph.
// ---------------------------------------------------------------------------------------------------

const { isStockPreparationNamespaceObjectId } = require('./stock-preparation-own-base.cjs')

const GOVERNED_SHEET_WRITE_CODES = Object.freeze({
  REFUSED: 'METASHEET_MULTITABLE_STOCK_PREP_GOVERNED_SHEET',
  PROBE_UNWIRED: 'STOCK_PREP_GOVERNED_SHEET_PROBE_UNWIRED',
  STORE_FAILED: 'STOCK_PREP_REFRESH_STORE_FAILED',
  STORE_UNAVAILABLE: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE',
  INPUT_INVALID: 'STOCK_PREP_REFRESH_INPUT_INVALID',
})

// The seams that call the probe (closed list; the source scan pins each one to its call site).
const GOVERNED_SHEET_WRITE_SURFACES = Object.freeze(['pipeline_upsert', 'c6_target_test', 'c6_insert_rows', 'c6_update_rows', 'erp_feedback'])

// The verdict order: the first governing fact found is the reason token.
const GOVERNED_SHEET_REASONS = Object.freeze(['pilot', 'continuation', 'hold', 'state', 'execution'])

class StockPreparationGovernedSheetWriteError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationGovernedSheetWriteError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Values-free: a five-character SQLSTATE only — from the driver error itself, or from a typed store error's details.
function sqlStateOf(error) {
  const direct = error && typeof error.code === 'string' ? error.code : ''
  if (/^[0-9A-Z]{5}$/.test(direct)) return direct
  const nested = error && isPlainObject(error.details) && typeof error.details.sqlState === 'string' ? error.details.sqlState : ''
  return /^[0-9A-Z]{5}$/.test(nested) ? nested : undefined
}

// A closed snake_case token may name itself in a message; anything else is left out of it.
function tokenForMessage(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null
}

// Step-4 review follow-ups (#6567 N1): the 501 and 503 messages START with the code and the closed tokens, as the
// 409 does — the pipeline runner keeps only `error.message` as a run's cause, so `/pipelines/:id/run` must be able
// to tell a missing table (42P01) from a dropped connection (08006). Tokens come from code constants and
// `sqlStateOf` only, never from the driver's message.
function unavailable(reason) {
  const named = tokenForMessage(reason)
  return new StockPreparationGovernedSheetWriteError(501, GOVERNED_SHEET_WRITE_CODES.STORE_UNAVAILABLE, `${GOVERNED_SHEET_WRITE_CODES.STORE_UNAVAILABLE}${named ? ` (reason ${named})` : ''}: the governed-sheet probe is not wired on this deployment; refusing to answer whether the sheet is governed`, { reason, partial: false })
}

function storeFailed(store, operation, error) {
  const sqlState = sqlStateOf(error)
  const tokens = [`store ${tokenForMessage(store) || 'unknown'}`, `operation ${tokenForMessage(operation) || 'unknown'}`, ...(sqlState ? [`SQLSTATE ${sqlState}`] : [])]
  return new StockPreparationGovernedSheetWriteError(503, GOVERNED_SHEET_WRITE_CODES.STORE_FAILED, `${GOVERNED_SHEET_WRITE_CODES.STORE_FAILED} (${tokens.join(', ')}): whether this sheet is governed by the stock-preparation batch refresh could not be read; nothing was written`, {
    store,
    operation,
    ...(sqlState ? { sqlState } : {}),
    partial: false,
  })
}

function inputInvalid(field, status = 422) {
  return new StockPreparationGovernedSheetWriteError(status, GOVERNED_SHEET_WRITE_CODES.INPUT_INVALID, `${field} is required`, { field })
}

function assertSurface(surface) {
  if (!GOVERNED_SHEET_WRITE_SURFACES.includes(surface)) throw inputInvalid('surface', 500)
}

// The object key a refusal names: the configured key (adapter) or the provisioning object id (ERP feedback). A
// non-string is dropped rather than echoed.
function objectKeyOf(objectId) {
  return nonBlankString(objectId) ? objectId : undefined
}

/**
 * THE refusal (409). `message` names the code and the object key so the pipeline runner's `PipelineRunnerError`
 * (which keeps only the message) and the run log still say what refused; nothing else.
 */
function governedSheetRefusal({ surface, reason, objectId, tenantMismatch = false }) {
  assertSurface(surface)
  const object = objectKeyOf(objectId)
  return new StockPreparationGovernedSheetWriteError(
    409,
    GOVERNED_SHEET_WRITE_CODES.REFUSED,
    `${GOVERNED_SHEET_WRITE_CODES.REFUSED}: ${object ? `object "${object}" targets` : 'the target is'} a sheet governed by the stock-preparation batch refresh (pilot marker or persisted refresh rows); generic configured writers may not write it; nothing was written`,
    {
      surface,
      reason,
      ...(object ? { object } : {}),
      ...(tenantMismatch ? { tenantMismatch: true } : {}),
      partial: false,
    },
  )
}

/**
 * THE not-wired refusal (501): a seam constructed WITHOUT the probe meets an object id in the stock-prep namespace.
 * A wiring defect by name — never a silent write.
 */
function probeUnwiredRefusal({ surface, objectId }) {
  assertSurface(surface)
  const object = objectKeyOf(objectId)
  return new StockPreparationGovernedSheetWriteError(
    501,
    GOVERNED_SHEET_WRITE_CODES.PROBE_UNWIRED,
    `${GOVERNED_SHEET_WRITE_CODES.PROBE_UNWIRED}: ${object ? `object "${object}"` : 'this object'} is in the stock-preparation namespace and this writer was built without the governed-sheet probe; nothing was written`,
    { surface, reason: 'probe_absent', ...(object ? { object } : {}), partial: false },
  )
}

function countOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Pure: the reason token of a (registry, marks) pair, or null when nothing governs. */
function verdictOf(registry, marks) {
  if (registry && registry.pilot === true) return 'pilot'
  if (marks.continuation > 0) return 'continuation'
  if (marks.openHold > 0) return 'hold'
  if (marks.state > 0) return 'state'
  if (marks.execution > 0) return 'execution'
  return null
}

function createStockPreparationGovernedSheetProbe({ continuationStore = null, projectTargetStore = null } = {}) {
  function requireWired() {
    if (!continuationStore || typeof continuationStore.readSheetGovernanceMarks !== 'function') throw unavailable('continuation_store')
    if (!projectTargetStore || typeof projectTargetStore.getPilotStateBySheetId !== 'function') throw unavailable('registry_pilot_reads')
  }

  /**
   * `probe({ sheetId, tenantId? })` -> the frozen, values-free answer
   *   `{ ok: true, governed, reason, registry: { present, pilot?, tenantMatches? }, marks }`.
   * Throws 422 (blank sheet id), 501 (not wired), 503 (any read failed — never "not governed").
   */
  async function probe(input = {}) {
    const sheetId = isPlainObject(input) && nonBlankString(input.sheetId) ? input.sheetId.trim() : null
    if (!sheetId) throw inputInvalid('sheetId')
    const tenantId = isPlainObject(input) && nonBlankString(input.tenantId) ? input.tenantId.trim() : null
    requireWired()

    let registry
    try {
      registry = await projectTargetStore.getPilotStateBySheetId({ sheetId })
    } catch (error) {
      throw storeFailed('registry', 'pilot_state_by_sheet', error)
    }
    if (registry !== null && registry !== undefined && !isPlainObject(registry)) throw storeFailed('registry', 'pilot_state_by_sheet', null)

    let read
    try {
      read = await continuationStore.readSheetGovernanceMarks({ sheetId })
    } catch (error) {
      // The store's own "not wired" (a binding that cannot count) stays a wiring defect by name (501); every other
      // throw is unreadable (503).
      if (error && error.status === 501 && error.code === GOVERNED_SHEET_WRITE_CODES.STORE_UNAVAILABLE) {
        throw unavailable(isPlainObject(error.details) && nonBlankString(error.details.reason) ? error.details.reason : 'continuation_store')
      }
      throw storeFailed('continuation', 'read_sheet_governance_marks', error)
    }
    const marks = isPlainObject(read) && read.ok === true
      ? { continuation: countOf(read.continuation), openHold: countOf(read.openHold), state: countOf(read.state), execution: countOf(read.execution) }
      : null
    // A store that answered without four counts never answered: unreadable by name, never "not governed".
    if (!marks || Object.values(marks).some((value) => value === null)) throw storeFailed('continuation', 'read_sheet_governance_marks', null)

    const reason = verdictOf(registry, marks)
    const registryAnswer = registry
      ? Object.freeze({
        present: true,
        pilot: registry.pilot === true,
        tenantMatches: tenantId ? registry.tenantId === tenantId : null,
      })
      : Object.freeze({ present: false })
    return Object.freeze({
      ok: true,
      governed: reason !== null,
      reason,
      registry: registryAnswer,
      marks: Object.freeze(marks),
    })
  }

  /**
   * Probe, then refuse a governed sheet: 409 METASHEET_MULTITABLE_STOCK_PREP_GOVERNED_SHEET with
   * `{ surface, reason, object?, tenantMismatch?, partial: false }`. Probe failures (422 / 501 / 503) propagate
   * unchanged. Returns the probe answer for a sheet that is not governed.
   */
  async function assertSheetWritable(input = {}) {
    const surface = isPlainObject(input) ? input.surface : undefined
    assertSurface(surface)
    const answer = await probe(input)
    if (answer.governed) {
      throw governedSheetRefusal({ surface, reason: answer.reason, objectId: input.objectId, tenantMismatch: answer.registry.tenantMatches === false })
    }
    return answer
  }

  return Object.freeze({ probe, assertSheetWritable })
}

/**
 * The seams' shared rule for a governed-sheet check, given a probe ANSWER (or no probe at all):
 *   - no probe and the object id is in the stock-prep namespace -> the 501 not-wired refusal;
 *   - no probe and any other object id                          -> pass (byte-identical legacy behaviour);
 *   - a governed answer                                         -> the 409 refusal.
 * Used by the adapter's per-object cache, which stores answers (a failure is never an answer, so never cached).
 */
function refuseIfGoverned({ answer, surface, objectId }) {
  if (answer && answer.governed === true) {
    throw governedSheetRefusal({ surface, reason: answer.reason, objectId, tenantMismatch: Boolean(answer.registry && answer.registry.tenantMatches === false) })
  }
}

/**
 * Is a probe wired at this seam? `true` when one was injected (it must expose `probe` and `assertSheetWritable`;
 * a malformed one is 501 by name, never a TypeError and never a silent pass); `false` when none was and the object
 * is outside the stock-prep namespace (legacy behaviour); the 501 not-wired refusal when none was and it is inside.
 */
function assertProbeWiredFor({ governedSheetProbe, surface, objectId }) {
  assertSurface(surface)
  if (governedSheetProbe !== undefined && governedSheetProbe !== null) {
    if (typeof governedSheetProbe.probe !== 'function' || typeof governedSheetProbe.assertSheetWritable !== 'function') throw unavailable('probe_surface')
    return true
  }
  if (isStockPreparationNamespaceObjectId(objectId)) throw probeUnwiredRefusal({ surface, objectId })
  return false
}

module.exports = {
  GOVERNED_SHEET_WRITE_CODES,
  GOVERNED_SHEET_WRITE_SURFACES,
  GOVERNED_SHEET_REASONS,
  StockPreparationGovernedSheetWriteError,
  createStockPreparationGovernedSheetProbe,
  governedSheetRefusal,
  probeUnwiredRefusal,
  refuseIfGoverned,
  assertProbeWiredFor,
  isStockPreparationNamespaceObjectId,
  __internals: { verdictOf, sqlStateOf },
}
