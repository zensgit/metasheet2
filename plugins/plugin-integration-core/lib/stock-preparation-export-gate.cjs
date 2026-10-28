'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 4, PR-5 — THE FORMAL-EXPORT GATE (design §11; §23.7 O-21 as replaced; plan §5.3).
//
// The project material export (按项目导出物料, http-routes.cjs stockPreparationPrepLineExport) is a FORMAL
// handover surface: a workbook it streams is what purchasing and the warehouse act on. Plan §5.3 therefore
// requires the server to refuse it for every unfinished refresh state of a governed project — 待确认,
// 已确认待执行, 执行中, 失败待恢复, 变更待复核, 已执行待核对, and a state that cannot be read — and to refuse
// delivering MIXED data when the sheet is written while the export reads it (「导出期间执行代次发生变化时，
// 拒绝交付混合数据，不能只在读取前检查一次状态」).
//
// THE FIXED ORDER (O-21 as replaced by the reviewer of record; every step awaited, nothing cached, nothing
// in parallel):
//
//   G0  a FRESH lock generation read (never the consult's own trailing lock read);
//   C1  a FRESH derived state (one whole consult); unreadable => 503, a refusal (409 RETARGETED /
//       TENANT_MISMATCH) propagates, any state other than not_governed / complete+settled => 409 BLOCKED;
//       any lease at G0 (live OR abandoned) => 409 BLOCKED lease_in_flight;
//   R   read the export rows, THEN (governed only) re-read the project through the planner's own reader
//       and digest its machine band with the ONE shared `sheetMachineDigest`; build the workbook IN MEMORY;
//   C2  (governed only) a FRESH derived state again: must still be complete + settled, and its settled
//       machine digest must equal R's => else 409 STATE_CHANGED / SHEET_CHANGED_SINCE_SETTLEMENT;
//   G1  a FRESH lock generation read AFTER C2: same presence, same `generationToken`, same
//       `fencingEpoch`, no lease — else 409 STATE_CHANGED. The epoch is compared on purpose: a zero-write
//       FAILED execution leaves the token and the sheet's digest unchanged but ADVANCES the epoch at its
//       acquire, and such a whole run can land inside C1's or C2's snapshot-to-lock-read gap (reproduced
//       on PostgreSQL by the reviewer of record); the epoch bracket is what catches it.
//
// Only then does the route audit and stream. Every refusal streams NOTHING (the file exists only in memory)
// and is answered with values-free details (tokens, counts, booleans — never a key, a quantity, a name).
//
// WHY R READS THE EXPORT ROWS BEFORE THE DIGEST ROWS: a host-side machine write landing between the two
// reads then moves the digest away from the settlement (409); the reverse order would let the digest match
// while the workbook carried the new value.
//
// WHAT THIS IS NOT. It is an optimistic bracket, not an exclusion: a writer that acquires the lease AFTER
// G1 (while the bytes are already streaming) is outside it, exactly as the reviewer's report states. It is
// also not a gate for the not-governed project's content: such a project keeps today's rows, audit row and
// workbook bytes (C09); only the G0 lease refusal and the G0/G1 bracket apply to it (O-9: the derived state
// of an ungoverned project hides a lease — the gate's own lock reads are what see it).
//
// PURE ORCHESTRATION: every read is injected by the route (`readGeneration`, `readRefreshState`, `readData`,
// `buildFile`), so the hermetic suite pins the exact call order and a mutation of any step is visible.
// ---------------------------------------------------------------------------------------------------

const { formalSurfaceVerdict } = require('./stock-preparation-refresh-state.cjs')

const EXPORT_GATE_ERROR_CODES = Object.freeze({
  STATE_UNREADABLE: 'STOCK_PREP_EXPORT_STATE_UNREADABLE',
  BLOCKED: 'STOCK_PREP_EXPORT_BLOCKED',
  SHEET_CHANGED_SINCE_SETTLEMENT: 'STOCK_PREP_EXPORT_SHEET_CHANGED_SINCE_SETTLEMENT',
  STATE_CHANGED: 'STOCK_PREP_EXPORT_STATE_CHANGED',
  GATE_INVALID: 'STOCK_PREP_EXPORT_GATE_INVALID',
})

// The closed `details.reason` vocabulary of the gate's refusals (values-free by construction).
const EXPORT_GATE_REASONS = Object.freeze([
  'unreadable',
  'state',
  'not_settled',
  'lease_in_flight',
  'machine_columns_changed',
  'generation_moved',
])

class StockPreparationExportGateError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationExportGateError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function gateInvalid(reason) {
  return new StockPreparationExportGateError(500, EXPORT_GATE_ERROR_CODES.GATE_INVALID, 'the formal export gate was handed an invalid input; refusing to export', { reason })
}

/** The values-free counters of a derived state (null when the state carries none). */
function countsOf(state) {
  return state && isPlainObject(state.counts) ? { ...state.counts } : null
}

/** The lock's generation answer, reduced to the four facts the bracket compares — shape-checked, fail closed. */
function generationStamp(generation, step) {
  if (!isPlainObject(generation)
    || typeof generation.present !== 'boolean'
    || !(generation.generationToken === null || nonBlankString(generation.generationToken))
    || !Number.isInteger(generation.fencingEpoch) || generation.fencingEpoch < 0
    || !(generation.leaseId === null || generation.leaseId === undefined || nonBlankString(generation.leaseId))) {
    throw gateInvalid(`${step}_generation_shape`)
  }
  return Object.freeze({
    present: generation.present,
    generationToken: generation.generationToken,
    fencingEpoch: generation.fencingEpoch,
    leaseId: generation.leaseId === undefined ? null : generation.leaseId,
  })
}

/** A `readRefreshState` answer reduced to its derived state — anything else is unreadable (fail closed). */
function stateOf(read, step) {
  const state = isPlainObject(read) && isPlainObject(read.state) ? read.state : null
  if (!state) throw gateInvalid(`${step}_state_shape`)
  return state
}

function unreadableRefusal(state) {
  const failure = isPlainObject(state.unreadable) ? state.unreadable : {}
  return new StockPreparationExportGateError(503, EXPORT_GATE_ERROR_CODES.STATE_UNREADABLE, 'the project\'s refresh state could not be read; the formal export is refused', {
    reason: 'unreadable',
    ...(nonBlankString(failure.store) ? { store: failure.store } : {}),
    ...(nonBlankString(failure.operation) ? { operation: failure.operation } : {}),
    partial: false,
  })
}

// The BLOCKED message by reason (fixed literals, values-free). A lease at G0 is a WRITER, not a refresh state —
// a not-governed project has none — so it names the cause and the remedy: wait, or a preview with the pull tier
// (which clears an abandoned lease; a floor-tier preview cannot). Step-4 review follow-ups (#6566 pg N1).
const BLOCKED_MESSAGE_LEASE_IN_FLIGHT = 'a pull is writing this sheet or a crashed pull left its lease; retry after it finishes or run a preview with the pull tier'
const BLOCKED_MESSAGE_STATE = 'this project has an unfinished refresh state; the formal export is refused until it is complete and checked'

function blockedRefusal(state, reason) {
  return new StockPreparationExportGateError(409, EXPORT_GATE_ERROR_CODES.BLOCKED, reason === 'lease_in_flight' ? BLOCKED_MESSAGE_LEASE_IN_FLIGHT : BLOCKED_MESSAGE_STATE, {
    reason,
    status: state.status,
    governed: state.governed,
    counts: countsOf(state),
    partial: false,
  })
}

function stateChangedRefusal(reason, details = {}) {
  return new StockPreparationExportGateError(409, EXPORT_GATE_ERROR_CODES.STATE_CHANGED, 'the project\'s refresh state or write generation moved while the export was being prepared; nothing was delivered — export again', {
    reason,
    ...details,
    partial: false,
  })
}

function sheetChangedRefusal() {
  return new StockPreparationExportGateError(409, EXPORT_GATE_ERROR_CODES.SHEET_CHANGED_SINCE_SETTLEMENT, 'a machine column of this project changed since the last settled computation; preview the project again before exporting', {
    reason: 'machine_columns_changed',
    partial: false,
  })
}

/** The settled machine digest a `readRefreshState` answer carries (the consult's state row; in-process only). */
function settledDigestOf(read) {
  const row = isPlainObject(read) && isPlainObject(read.consult) && isPlainObject(read.consult.state) ? read.consult.state : null
  return row && nonBlankString(row.settledSheetMachineDigest) ? row.settledSheetMachineDigest : null
}

function sameGeneration(before, after) {
  return before.present === after.present
    && before.generationToken === after.generationToken
    && before.fencingEpoch === after.fencingEpoch
}

/**
 * Run the gate. `deps`:
 *   readGeneration()                       a FRESH lock `readGeneration(scope)` answer (G0 and G1);
 *   readRefreshState()                     a FRESH governance `readRefreshState(scope)` answer (C1 and C2);
 *                                          a refusal it throws (409 / 422) propagates untouched;
 *   readData(read, { governed })           R: `{ exportResult, sheetMachineDigest }` — the export rows
 *                                          (first) and, for a governed project, the machine digest of a
 *                                          second read through the planner's reader (required, non-blank);
 *   buildFile(data)                        the workbook, in memory.
 * Answers `{ governed, state, generation, data, file }` or throws a StockPreparationExportGateError.
 */
async function runFormalExportGate(deps = {}) {
  for (const name of ['readGeneration', 'readRefreshState', 'readData', 'buildFile']) {
    if (!isPlainObject(deps) || typeof deps[name] !== 'function') throw gateInvalid(`missing_${name}`)
  }
  // G0 — the bracket opens BEFORE anything else is read.
  const g0 = generationStamp(await deps.readGeneration(), 'g0')
  // C1 — a whole, fresh consult begun after G0.
  const c1Read = await deps.readRefreshState()
  const c1 = stateOf(c1Read, 'c1')
  if (c1.status === 'unreadable' || c1.readable !== true) throw unreadableRefusal(c1)
  const verdict = formalSurfaceVerdict(c1)
  if (!verdict.allowed) {
    if (verdict.reason === 'unreadable') throw unreadableRefusal(c1)
    throw blockedRefusal(c1, verdict.reason)
  }
  // Any lease at G0 — live or abandoned — is a writer whose effect on the rows is not settled.
  if (g0.leaseId !== null) throw blockedRefusal(c1, 'lease_in_flight')
  const governed = c1.status !== 'not_governed'

  // R — the rows, then (governed) the digest; the file in memory.
  const data = await deps.readData(c1Read, { governed })
  if (!isPlainObject(data) || !isPlainObject(data.exportResult)) throw gateInvalid('read_data_shape')
  if (governed && !nonBlankString(data.sheetMachineDigest)) throw gateInvalid('sheet_machine_digest_missing')
  const file = await deps.buildFile(data)

  // C2 — a whole, fresh consult after the data read and the build (governed only).
  let finalState = c1
  if (governed) {
    const c2Read = await deps.readRefreshState()
    const c2 = stateOf(c2Read, 'c2')
    if (c2.status === 'unreadable' || c2.readable !== true) throw unreadableRefusal(c2)
    const again = formalSurfaceVerdict(c2)
    if (!again.allowed) {
      if (again.reason === 'unreadable') throw unreadableRefusal(c2)
      throw stateChangedRefusal('state', { status: c2.status, previousStatus: c1.status, governed: c2.governed, counts: countsOf(c2) })
    }
    if (c2.status === 'not_governed') throw stateChangedRefusal('state', { status: c2.status, previousStatus: c1.status, governed: c2.governed, counts: countsOf(c2) })
    const settledDigest = settledDigestOf(c2Read)
    if (settledDigest === null || settledDigest !== data.sheetMachineDigest) throw sheetChangedRefusal()
    finalState = c2
  }

  // G1 — AFTER C2 and after every authorization-related read.
  const g1 = generationStamp(await deps.readGeneration(), 'g1')
  if (g1.leaseId !== null) throw stateChangedRefusal('lease_in_flight', { generationMoved: g1.generationToken !== g0.generationToken, epochMoved: g1.fencingEpoch !== g0.fencingEpoch })
  if (!sameGeneration(g0, g1)) {
    throw stateChangedRefusal('generation_moved', {
      generationMoved: g1.generationToken !== g0.generationToken || g1.present !== g0.present,
      epochMoved: g1.fencingEpoch !== g0.fencingEpoch,
    })
  }

  return Object.freeze({
    governed,
    state: finalState,
    generation: Object.freeze({ present: g1.present, generationToken: g1.generationToken, fencingEpoch: g1.fencingEpoch }),
    data,
    file,
  })
}

/**
 * The 沿用说明 input of the export lib, projected from a consult (in process; the consult itself is private,
 * O-18): the live (non-ended) relationship headers and their claim_active members. `undefined` when the
 * project has no live relationship — the lib then emits no column (byte-identical headers).
 */
function continuationExportInputOf(consult) {
  if (!isPlainObject(consult) || !Array.isArray(consult.continuations) || !Array.isArray(consult.members)) return undefined
  const live = consult.continuations.filter((entry) => isPlainObject(entry) && nonBlankString(entry.id) && entry.status !== 'ended')
  if (live.length === 0) return undefined
  return Object.freeze({
    continuations: live.map((entry) => Object.freeze({
      id: entry.id,
      status: entry.status,
      newParentComponentSourceId: entry.newParentComponentSourceId === undefined ? null : entry.newParentComponentSourceId,
      newRootPathTokens: Array.isArray(entry.newRootPathTokens) ? entry.newRootPathTokens.slice() : null,
      parentEdgeUsage: typeof entry.parentEdgeUsage === 'number' ? entry.parentEdgeUsage : null,
    })),
    members: consult.members
      .filter((member) => isPlainObject(member) && member.claimActive !== false)
      .map((member) => Object.freeze({ continuationId: member.continuationId, oldRecordId: member.oldRecordId, claimActive: true })),
  })
}

/**
 * The values-free slice of a gate refusal's details an audit row may carry (tokens and booleans only).
 * It NEVER emits `operation`: the audit row's own `operation` is the route's (`prep_line_export`) and a caller
 * spreads this slice after it, so a store's operation token (`read_holds`, `ledger_read`, …) rides along as
 * `storeOperation` instead (step-4 review follow-ups, #6566 N1). A five-character SQLSTATE is carried too.
 */
function auditableRefusalDetail(details) {
  const out = {}
  if (!isPlainObject(details)) return out
  for (const key of ['reason', 'status', 'governed', 'store', 'previousStatus']) {
    if (nonBlankString(details[key])) out[key] = details[key]
  }
  if (nonBlankString(details.operation)) out.storeOperation = details.operation
  if (typeof details.sqlState === 'string' && /^[0-9A-Z]{5}$/.test(details.sqlState)) out.sqlState = details.sqlState
  for (const key of ['generationMoved', 'epochMoved']) {
    if (typeof details[key] === 'boolean') out[key] = details[key]
  }
  return out
}

module.exports = {
  EXPORT_GATE_ERROR_CODES,
  EXPORT_GATE_REASONS,
  StockPreparationExportGateError,
  auditableRefusalDetail,
  continuationExportInputOf,
  runFormalExportGate,
  __internals: {
    generationStamp,
    sameGeneration,
    settledDigestOf,
  },
}
