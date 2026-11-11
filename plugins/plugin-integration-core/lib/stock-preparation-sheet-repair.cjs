'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 6d-2a (S6-6; step-6 design §6.6, T6-18; register row R-91) — THE DOUBLED-SHEET REPAIR TOOLING.
//
// A project sheet that holds a component twice — once as its own ROOT subtree (S) and once as a copy NESTED under
// another parent (P → S) — is design §6.1's shape D1. Two recipes, both owner gate ② per sheet for a real run:
//   retire_superseded_root_subtree   D1 → D2: the old root subtree's ACTIVE rows get `active: false` (a BOOLEAN,
//                                    F-11) and three RUN stamps naming this repair run;
//   restore_retired_rows             its inverse, over one earlier retire run's backup: the rows that are still
//                                    inactive and still carry that run's stamp get their four cells back, each at its
//                                    CURRENT version.
// one CONTINUATION that writes no row:
//   verify_and_close_run             closes a run left `running` after its rows were written (its finish was refused or
//                                    failed): every planned row is VERIFIED in its target state against the run's own
//                                    backup, then the run row is finished `completed` under its own owner approval.
//                                    Any row not in its target state refuses with counts; restoring the run stays the
//                                    other way out.
// and one read: the FILLS REPORT (which old row ↔ copy pairs carry human fills, and what the K2 carry could do with
// each), values-free.
//
// THIS FILE DECIDES; THE ROUTES WIRE. Everything host-, lock-, ledger-, source- and audit-specific is INJECTED (`deps`,
// built per request by lib/http-routes.cjs): the pure analysis below never reads the environment except through the one
// switch reader, and never requires the lock, a store or the batch-identifier modules.
//
// THE SWITCH. `MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED`, default OFF, exact literal 'true' (no trim, no case
// folding), read PER REQUEST by the routes through `stockPrepSheetRepairWriteEnabled()` — this file is its one reader
// (the flag manifest's family scan pins that). OFF => every repair route answers 404 before any IO: the whole surface
// is invisible, preview and reads included.
//
// THE ORDER OF A REAL RUN (`mode: execute`), every refusal before the first sheet write:
//   prelude   the closed body; the one-shot claim of the echoed digest already taken => 409 ALREADY_CONSUMED (no lease)
//   lease     the sheet write lease, purpose `sheet_repair` — a pull, a recovery, an install and a pilot enable all
//             take the same lease, so none of them interleaves with a repair
//   gates     the batch-identifier INSTALL STATE of the sheet, read from its ledger row on EVERY analysis whatever the
//             batch switch says (rebaseline B-9; coordinator ruling C-2): `installing`, or an aborted first install
//             whose settings lock is still held, => 409 -> the IN-LEASE recompute of the preview (a fresh source read
//             for a retire) -> preconditions -> the plan digest must equal the echoed one
//   holder    ONE holder CAS of the guard BEFORE the begin (ruling C-4): a guard already lost (a failed heartbeat, a
//             lapsed lease) refuses here, so the one-shot claim is never spent by a run that cannot write
//   begin     ONE ledger transaction, holder assert first: an abandoned open run of this sheet is closed, the one-shot
//             claim is inserted, the run row with its BACKUP is inserted, the audit row is appended
//   writes    one fenced, version-conditional patch per planned row, deepest row first and the root last; the four
//             repair cells only (never a human cell, never a batch band cell — ruling C7); a row that moved, is locked
//             or is gone STOPS the run (never a blind retry)
//   finish    the run row and its audit row, holder assert first; then, after the lease is released, the generation
//             bump (reason `sheet_repair`, best effort) whenever a host write was ATTEMPTED (ruling C-5: a write that
//             raised may have landed)
// The begin, the finish and the continuation's close each run INSIDE the guard's host-write bracket (the N6 rule: the
// lease's own heartbeat skips while the transaction holds the lock row); a guard without that bracket is refused.
//
// VALUES. Answers, errors, audit details and the ledger carry handles (record ids, run ids, the census's private
// component handle), closed tokens, digests, integers and booleans — never a project number, a key, a part id, a
// path or a cell a person typed. The fills report says WHETHER a human cell is filled and whether two cells are
// equal, never what they hold.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const {
  pairSubtrees,
  pathTokensOf,
  recordRefOf,
  relativePath,
  __internals: { canonicalJson, isActiveRow, isRootRow },
} = require('./stock-preparation-continuation-pairing.cjs')
const { DECISIONS, derivePackAwarePlmWritableFields } = require('./stock-preparation-conflict-planner.cjs')
const { HUMAN_PRESERVED_FIELD_IDS } = require('./stock-preparation-templates.cjs')
const { __internals: { componentHandle: censusComponentHandle, isBlankCell } } = require('./stock-preparation-sheet-census.cjs')

// ── the switch (design §6.6; the members-page / pull-batch reader shape) ─────────────────────────────────────
const STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV = 'MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED'

function stockPrepSheetRepairWriteEnabled(env = process.env) {
  return Boolean(env) && env[STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV] === 'true'
}

// ── closed vocabularies (pinned by the suites; the run / stop lists are migration 108's CHECKs) ───────────────
const SHEET_REPAIR_RECIPES = Object.freeze(['retire_superseded_root_subtree', 'restore_retired_rows'])
const RECIPE_RETIRE = SHEET_REPAIR_RECIPES[0]
const RECIPE_RESTORE = SHEET_REPAIR_RECIPES[1]
// The continuation is a REQUEST recipe only: it begins no run and claims nothing, so it is NOT in the two lists
// migration 108's CHECKs pin (SHEET_REPAIR_RECIPES).
const SHEET_REPAIR_CONTINUATIONS = Object.freeze(['verify_and_close_run'])
const RECIPE_CLOSE = SHEET_REPAIR_CONTINUATIONS[0]
const SHEET_REPAIR_REQUEST_RECIPES = Object.freeze(SHEET_REPAIR_RECIPES.concat(SHEET_REPAIR_CONTINUATIONS))
const SHEET_REPAIR_MODES = Object.freeze(['preview', 'execute'])
const SHEET_REPAIR_RUN_STATUSES = Object.freeze(['running', 'completed', 'stopped'])
const SHEET_REPAIR_STOP_REASONS = Object.freeze(['version_conflict', 'record_locked', 'record_missing', 'host_version_unexpected', 'host_write_failed', 'abandoned'])
const SHEET_REPAIR_BODY_KEYS = Object.freeze(['mode', 'recipe', 'confirmProjectNo', 'componentHandle', 'runId', 'planDigest', 'approvalRef'])
const SHEET_REPAIR_FILLS_QUERY_KEYS = Object.freeze(['componentHandle', 'cursor', 'limit'])
// Why a plan cannot run (preview answers them; execute refuses 409 NOT_APPLICABLE with the same tokens).
const SHEET_REPAIR_REFUSALS = Object.freeze([
  'install_in_progress',
  'install_aborted_unresolved',
  'project_governed',
  'source_incomplete',
  'component_not_found',
  'not_two_copy',
  'old_root_ambiguous',
  'old_root_path_unreadable',
  'keyless_rows_present',
  'duplicate_keys',
  'copy_not_paired',
  'copy_ambiguous',
  'old_root_still_expanded',
  'old_subtree_still_expanded',
  'row_unaddressable',
  'row_not_machine_shaped',
  'nothing_to_retire',
  'plan_too_large',
  'run_not_found',
  'run_not_retire',
  'backup_unreadable',
  'nothing_to_restore',
  'run_not_open',
  'rows_not_in_target_state',
])
// The batch identifier's INSTALL STATE of the sheet as a repair reads it (ruling C-2), from the sheet's ledger row alone:
//   installing          an install (a first install or a gap pass) is between its runs;
//   aborted_unresolved  a FIRST install was aborted and its settings lock is still held — the abort could not prove that
//                       no label of its persisted plan is on the sheet, so its next run may RESUME that plan;
//   none                no ledger row, a resolved sheet, or a pending sheet whose lock is not held (never installed, or an
//                       aborted install whose abort released the lock: its next run plans afresh from the rows as they
//                       are then).
// The two that are not `none` refuse a retire and a restore: the persisted plan of a continued / resumed install is
// never recomputed, so a write to 有效 between its runs changes that plan's inputs behind it.
const SHEET_REPAIR_INSTALL_STATES = Object.freeze(['none', 'installing', 'aborted_unresolved'])
const INSTALL_REFUSAL_BY_STATE = Object.freeze({ installing: 'install_in_progress', aborted_unresolved: 'install_aborted_unresolved' })
// The history statuses of the batch ledger's sheet row (migration 105's CHECK), SPELLED here: this file never requires
// the batch-identifier modules. A status outside this list is not understood and refuses (never "not installing").
const INSTALL_HISTORY_STATUS_INSTALLING = 'installing'
const INSTALL_HISTORY_STATUS_PENDING = 'pending'
const INSTALL_HISTORY_STATUSES_RESOLVED = Object.freeze(['born_empty', 'backfilled'])
// What the continuation counts over the planned rows of the run it is asked to close. `inTargetState` rows carry
// exactly the four cells the run set out to write (`versionMoved` of them at another version than the run left: a
// person's edit of a human cell or a batch band write — still in the target state); `notWritten` rows are exactly as
// the backup read them; `moved` rows are neither (revived, restamped); `missing` rows are gone.
const SHEET_REPAIR_CLOSE_COUNT_KEYS = Object.freeze(['planned', 'inTargetState', 'versionMoved', 'notWritten', 'moved', 'missing'])
// What a restore counts over a retire run's backed-up rows. Named by what is OBSERVED: `versionMovedStampIntact` is a
// row whose version moved while the retire stamp stayed intact — a person's edit of a human cell OR a batch band write
// look the same from here; such a row IS restored, at its current version. `notRetired` (the run never wrote it, or it
// was restored already), `revived` (active again under another stamp), `restamped` (inactive under another stamp) and
// `missing` rows are never written.
const SHEET_REPAIR_RESTORE_COUNT_KEYS = Object.freeze(['backupRows', 'toRestore', 'versionMovedStampIntact', 'notRetired', 'revived', 'restamped', 'missing', 'unaddressable'])
const SHEET_REPAIR_FILL_CLASSES = Object.freeze(['k2_carryable', 'reenter_ext_human', 'reenter_conflict', 'nothing_to_carry'])
const SHEET_REPAIR_FILL_STATES = Object.freeze(['carry', 'equal', 'conflict', 'copy_only'])
const SHEET_REPAIR_COMPONENT_SHAPES = Object.freeze(['two_copy', 'inactive_root_remnant'])

// The four cells a recipe writes — the WHOLE write surface (ruling C7: a batch band cell or a human cell is never here).
const SHEET_REPAIR_WRITE_FIELD_IDS = Object.freeze(['active', 'lastPlmRefreshRunId', 'lastPlmRefreshDecision', 'lastPlmConflictSummary'])
const SHEET_REPAIR_STAMP_FIELD_IDS = Object.freeze(['lastPlmRefreshRunId', 'lastPlmRefreshDecision', 'lastPlmConflictSummary'])
const SHEET_REPAIR_RETIRE_SUMMARY = JSON.stringify({ type: 'sheet_repair_retire' })
const SHEET_REPAIR_RETIRE_DECISION = DECISIONS.INACTIVE
const SHEET_REPAIR_LEASE_PURPOSE = 'sheet_repair'
const SHEET_REPAIR_GENERATION_REASON = 'sheet_repair'
const SHEET_REPAIR_RUN_ID_PREFIX = 'sheet-repair:'
const SHEET_REPAIR_PLAN_SCHEME = 'stock-preparation/sheet-repair-plan/v1'
const SHEET_REPAIR_CLAIM_SCHEME = 'stock-preparation/sheet-repair-claim/v1'
const SHEET_REPAIR_CLOSE_SCHEME = 'stock-preparation/sheet-repair-close/v1'
const SHEET_REPAIR_MAX_PLAN_ROWS = 5000
const SHEET_REPAIR_MAX_LISTED_COMPONENTS = 200
const SHEET_REPAIR_FILLS_DEFAULT_LIMIT = 100
const SHEET_REPAIR_FILLS_MAX_LIMIT = 200

const SHEET_REPAIR_ERROR_CODES = Object.freeze({
  DISABLED: 'STOCK_PREP_SHEET_REPAIR_DISABLED',
  REQUEST_INVALID: 'STOCK_PREP_SHEET_REPAIR_REQUEST_INVALID',
  CONFIRM_MISMATCH: 'STOCK_PREP_SHEET_REPAIR_CONFIRM_MISMATCH',
  OBJECT_REFUSED: 'STOCK_PREP_SHEET_REPAIR_OBJECT_REFUSED',
  INSTALL_IN_PROGRESS: 'STOCK_PREP_SHEET_REPAIR_INSTALL_IN_PROGRESS',
  NOT_APPLICABLE: 'STOCK_PREP_SHEET_REPAIR_NOT_APPLICABLE',
  PLAN_CHANGED: 'STOCK_PREP_SHEET_REPAIR_PLAN_CHANGED',
  ALREADY_CONSUMED: 'STOCK_PREP_SHEET_REPAIR_ALREADY_CONSUMED',
  RUN_OPEN: 'STOCK_PREP_SHEET_REPAIR_RUN_OPEN',
  RUN_NOT_OPEN: 'STOCK_PREP_SHEET_REPAIR_RUN_NOT_OPEN',
  STOPPED: 'STOCK_PREP_SHEET_REPAIR_STOPPED',
  STORE_FAILED: 'STOCK_PREP_SHEET_REPAIR_STORE_FAILED',
  UNAVAILABLE: 'STOCK_PREP_SHEET_REPAIR_UNAVAILABLE',
})

// Audit (design T6-12, the D9 precedent): existing actions, closed modes — no vocabulary migration.
const SHEET_REPAIR_AUDIT = Object.freeze({
  writeAction: 'exception_resolve',
  writeMigration: '066',
  readAction: 'project_board_read',
  readMigration: '086',
  modes: Object.freeze({
    started: 'sheet_repair_started',
    completed: 'sheet_repair_completed',
    stopped: 'sheet_repair_stopped',
    abandoned: 'sheet_repair_abandoned',
    verifiedClosed: 'sheet_repair_verified_closed',
    previewRead: 'sheet_repair_preview_read',
    fillsReportRead: 'sheet_fills_report_read',
    runsRead: 'sheet_repair_runs_read',
  }),
})

const APPROVAL_REF_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const PLAN_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const COMPONENT_HANDLE_PATTERN = /^[0-9a-f]{24}$/
const RUN_ID_PATTERN = /^sheet-repair:[0-9a-f-]{36}$/
const RECORD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
// The machine shape of a RUN stamp cell (what the planner and this file write): handle-like strings only.
const STAMP_HANDLE_PATTERN = /^[A-Za-z0-9._:|@-]{0,200}$/
const STAMP_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const STAMP_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const STAMP_SUMMARY_MAX_LENGTH = 4000
const STAMP_SUMMARY_MAX_ITEMS = 500
const DECISION_VALUES = Object.freeze(Object.values(DECISIONS))

// Codes of other modules this file recognises on a failed host write (spelled, never required).
const RECORD_VERSION_CONFLICT_CODE = 'VERSION_CONFLICT'
const RECORD_LOCKED_CODE = 'FORBIDDEN'
const RECORD_NOT_FOUND_CODE = 'NOT_FOUND'

class StockPreparationSheetRepairError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationSheetRepairError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function repairError(status, code, message, details = {}) {
  return new StockPreparationSheetRepairError(status, code, message, details)
}

function requestInvalid(field) {
  const safe = typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) ? field : 'body'
  return repairError(400, SHEET_REPAIR_ERROR_CODES.REQUEST_INVALID, 'the sheet-repair request is not valid; nothing was done', { field: safe })
}

function unavailable(field) {
  return repairError(500, SHEET_REPAIR_ERROR_CODES.UNAVAILABLE, 'the sheet-repair wiring is incomplete on this server; nothing was done', { field, partial: false })
}

function notApplicable(reasons, counts) {
  return repairError(409, SHEET_REPAIR_ERROR_CODES.NOT_APPLICABLE, 'this repair cannot run on the sheet as it is now; nothing was written — preview again', {
    reasons: reasons.slice(),
    ...(counts ? { counts: { ...counts } } : {}),
    partial: false,
  })
}

function installInProgress(installState) {
  const reason = INSTALL_REFUSAL_BY_STATE[installState] || INSTALL_REFUSAL_BY_STATE.installing
  const message = reason === INSTALL_REFUSAL_BY_STATE.aborted_unresolved
    ? 'an aborted install of the batch columns of this sheet still holds its plan and its settings lock; repair and install windows never interleave — finish that install first'
    : 'the batch columns of this sheet are being installed; repair and install windows never interleave — finish or abort the install first'
  return repairError(409, SHEET_REPAIR_ERROR_CODES.INSTALL_IN_PROGRESS, message, { reason, partial: false })
}

/** The refusal token of an install state, or null for `none`. Anything outside the closed list is a wiring defect. */
function installRefusalOf(installState) {
  if (!SHEET_REPAIR_INSTALL_STATES.includes(installState)) throw unavailable('installState')
  return INSTALL_REFUSAL_BY_STATE[installState] || null
}

/**
 * The install state from the VALUES-FREE facts the route reads off the batch ledger's sheet row:
 * `{ present: false }` (no row: the batch identifier never touched this sheet) or
 * `{ present: true, historyStatus, settingsLocked }`. Anything else — a missing fact, a status this build does not
 * know — refuses (500 naming the reader), never "not installing".
 */
function installStateOfFacts(facts) {
  if (!isPlainObject(facts) || typeof facts.present !== 'boolean') throw unavailable('installStateOf')
  if (facts.present === false) return 'none'
  if (typeof facts.settingsLocked !== 'boolean') throw unavailable('installStateOf')
  if (facts.historyStatus === INSTALL_HISTORY_STATUS_INSTALLING) return 'installing'
  if (facts.historyStatus === INSTALL_HISTORY_STATUS_PENDING) return facts.settingsLocked ? 'aborted_unresolved' : 'none'
  if (INSTALL_HISTORY_STATUSES_RESOLVED.includes(facts.historyStatus)) return 'none'
  throw unavailable('installStateOf')
}

function planChanged(reason) {
  return repairError(409, SHEET_REPAIR_ERROR_CODES.PLAN_CHANGED, 'the sheet differs from the plan that was approved; nothing was written — preview again and have the new digest approved', { reason, partial: false })
}

function alreadyConsumed() {
  return repairError(409, SHEET_REPAIR_ERROR_CODES.ALREADY_CONSUMED, 'this approved plan was already executed once; a new run needs a new preview and its own approval', { reason: 'claim_consumed', partial: false })
}

function logWarn(logger, message, fields) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(message, fields)
  } catch {
    // logging never decides an outcome
  }
}

function errorCodeOf(error) {
  return error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code) ? error.code : null
}

function componentOf(row) {
  return nonBlankString(row.componentSourceId) ? row.componentSourceId : null
}

function keyOf(row) {
  return nonBlankString(row.idempotencyKey) ? row.idempotencyKey : null
}

function underTokens(row, rootTokens) {
  const tokens = pathTokensOf(row)
  return Boolean(tokens) && relativePath(tokens, rootTokens) !== null
}

function addressOf(row) {
  const ref = recordRefOf(row)
  if (!ref || typeof ref.id !== 'string' || !RECORD_ID_PATTERN.test(ref.id)) return null
  if (!Number.isSafeInteger(ref.version) || ref.version < 1) return null
  return { recordId: ref.id, version: ref.version }
}

// ── the request bodies (closed) ─────────────────────────────────────────────────────────────────────

/**
 * The closed repair body. `mode` preview | execute; `recipe` one of SHEET_REPAIR_REQUEST_RECIPES; `confirmProjectNo` the
 * typed project number (compared with the path by the route). A retire names its component by `componentHandle` (24
 * hex, the census's private handle; a preview without one LISTS the sheet's doubled components); a restore names the
 * retire run by `runId`; the continuation names the OPEN run it closes by `runId`. An execute echoes the preview's
 * `planDigest` (64 lowercase hex) and names the `approvalRef` that approved THAT digest (`^[A-Za-z0-9._:-]{1,64}$`). Any
 * other key, a wrong type or a value outside a closed set => 400 STOCK_PREP_SHEET_REPAIR_REQUEST_INVALID { field }
 * (never the value).
 */
function normalizeSheetRepairBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body')
  for (const key of Object.keys(body)) {
    if (!SHEET_REPAIR_BODY_KEYS.includes(key)) throw requestInvalid(key)
  }
  if (!SHEET_REPAIR_MODES.includes(body.mode)) throw requestInvalid('mode')
  if (!SHEET_REPAIR_REQUEST_RECIPES.includes(body.recipe)) throw requestInvalid('recipe')
  if (!nonBlankString(body.confirmProjectNo)) throw requestInvalid('confirmProjectNo')
  const mode = body.mode
  const recipe = body.recipe
  const absent = (key) => body[key] === undefined || body[key] === null
  let componentHandle = null
  let runId = null
  if (recipe === RECIPE_RETIRE) {
    if (!absent('runId')) throw requestInvalid('runId')
    if (!absent('componentHandle')) {
      if (typeof body.componentHandle !== 'string' || !COMPONENT_HANDLE_PATTERN.test(body.componentHandle)) throw requestInvalid('componentHandle')
      componentHandle = body.componentHandle
    } else if (mode === 'execute') throw requestInvalid('componentHandle')
  } else {
    if (!absent('componentHandle')) throw requestInvalid('componentHandle')
    if (absent('runId') || typeof body.runId !== 'string' || !RUN_ID_PATTERN.test(body.runId)) throw requestInvalid('runId')
    runId = body.runId
  }
  let planDigest = null
  let approvalRef = null
  if (mode === 'execute') {
    if (typeof body.planDigest !== 'string' || !PLAN_DIGEST_PATTERN.test(body.planDigest)) throw requestInvalid('planDigest')
    if (typeof body.approvalRef !== 'string' || !APPROVAL_REF_PATTERN.test(body.approvalRef)) throw requestInvalid('approvalRef')
    planDigest = body.planDigest
    approvalRef = body.approvalRef
  } else {
    // A preview takes no digest and no approval: echoing one would suggest it was checked.
    if (!absent('planDigest')) throw requestInvalid('planDigest')
    if (!absent('approvalRef')) throw requestInvalid('approvalRef')
  }
  return Object.freeze({ mode, recipe, confirmProjectNo: body.confirmProjectNo.trim(), componentHandle, runId, planDigest, approvalRef })
}

/** The fills report's closed query: `componentHandle` (24 hex, optional), `cursor` (a non-negative integer offset), `limit` (1..200). */
function normalizeFillsReportQuery(query) {
  const input = query === undefined || query === null ? {} : query
  if (!isPlainObject(input)) throw requestInvalid('query')
  for (const key of Object.keys(input)) {
    if (!SHEET_REPAIR_FILLS_QUERY_KEYS.includes(key)) throw requestInvalid(key)
  }
  const first = (value) => (Array.isArray(value) ? value[0] : value)
  const absent = (key) => first(input[key]) === undefined || first(input[key]) === null || first(input[key]) === ''
  let componentHandle = null
  if (!absent('componentHandle')) {
    const value = first(input.componentHandle)
    if (typeof value !== 'string' || !COMPONENT_HANDLE_PATTERN.test(value)) throw requestInvalid('componentHandle')
    componentHandle = value
  }
  const integerOf = (key, { min, max, fallback }) => {
    if (absent(key)) return fallback
    const raw = first(input[key])
    const text = typeof raw === 'number' ? String(raw) : raw
    if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(text)) throw requestInvalid(key)
    const value = Number(text)
    if (value < min || value > max) throw requestInvalid(key)
    return value
  }
  const cursor = integerOf('cursor', { min: 0, max: 999999999, fallback: 0 })
  const limit = integerOf('limit', { min: 1, max: SHEET_REPAIR_FILLS_MAX_LIMIT, fallback: SHEET_REPAIR_FILLS_DEFAULT_LIMIT })
  // Pairs are listed for ONE component: paging without naming it has nothing to page.
  if (componentHandle === null && cursor !== 0) throw requestInvalid('cursor')
  return Object.freeze({ componentHandle, cursor, limit })
}

/** The run list takes no query at all: any key is 400 naming it (never its value). */
function normalizeRunsQuery(query) {
  const input = query === undefined || query === null ? {} : query
  if (!isPlainObject(input)) throw requestInvalid('query')
  for (const key of Object.keys(input)) throw requestInvalid(key)
  return Object.freeze({})
}

// ── the machine shape of the cells a recipe writes (the backup stays values-free by construction) ─────────────

function isMachineSummaryValue(value) {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return STAMP_HANDLE_PATTERN.test(value)
  if (Array.isArray(value)) {
    return value.length <= STAMP_SUMMARY_MAX_ITEMS
      && value.every((item) => (typeof item === 'string' && STAMP_HANDLE_PATTERN.test(item)) || (typeof item === 'number' && Number.isFinite(item)))
  }
  return false
}

/** `''`, or the planner's conflict-summary JSON: an object with a token `type` whose other values are handles, numbers, booleans or flat lists of them. */
function isMachineSummary(text) {
  if (text === '') return true
  if (text.length > STAMP_SUMMARY_MAX_LENGTH) return false
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (!isPlainObject(parsed) || typeof parsed.type !== 'string' || !STAMP_TOKEN_PATTERN.test(parsed.type)) return false
  return Object.entries(parsed).every(([key, value]) => STAMP_KEY_PATTERN.test(key) && isMachineSummaryValue(value))
}

/**
 * The three RUN stamp cells of a row as a backup may hold them, or null when the row is not machine-shaped: each cell
 * must be PRESENT (a patch cannot put an absent cell back) and a string of the plugin's own shape, or an explicit null.
 */
function stampCellsOf(row) {
  for (const fieldId of SHEET_REPAIR_STAMP_FIELD_IDS) {
    // An ABSENT cell reads `undefined`: neither null nor a string, so it is refused here with every other foreign type.
    if (row[fieldId] !== null && typeof row[fieldId] !== 'string') return null
  }
  const runId = row.lastPlmRefreshRunId
  const decision = row.lastPlmRefreshDecision
  const summary = row.lastPlmConflictSummary
  if (runId !== null && !STAMP_HANDLE_PATTERN.test(runId)) return null
  if (decision !== null && decision !== '' && !DECISION_VALUES.includes(decision)) return null
  if (summary !== null && !isMachineSummary(summary)) return null
  return { runId, decision, summary }
}

function carriesRetireStamp(row, runId) {
  return row.active === false
    && row.lastPlmRefreshRunId === runId
    && row.lastPlmRefreshDecision === SHEET_REPAIR_RETIRE_DECISION
    && row.lastPlmConflictSummary === SHEET_REPAIR_RETIRE_SUMMARY
}

/** A row an EARLIER retire run of this sheet's project wrote and nothing has touched since (rebaseline: by run id, never by the summary alone). */
function retiredByKnownRun(row, retireRunIds) {
  return typeof row.lastPlmRefreshRunId === 'string' && retireRunIds.has(row.lastPlmRefreshRunId) && carriesRetireStamp(row, row.lastPlmRefreshRunId)
}

function retireChangesOf(runId) {
  return { active: false, lastPlmRefreshRunId: runId, lastPlmRefreshDecision: SHEET_REPAIR_RETIRE_DECISION, lastPlmConflictSummary: SHEET_REPAIR_RETIRE_SUMMARY }
}

function restoreChangesOf(before) {
  return { active: true, lastPlmRefreshRunId: before.runId, lastPlmRefreshDecision: before.decision, lastPlmConflictSummary: before.summary }
}

// ── the doubled components of a sheet (the census's definitions, design §6.1) ─────────────────────────────────

/**
 * Every doubled component of the project's rows: `two_copy` (D1: an ACTIVE root row and an ACTIVE nested row) and
 * `inactive_root_remnant` (D2: an INACTIVE root row, no active root row, an active nested row). Sorted by component;
 * `roots` are the root rows that define the shape (active for D1, inactive for D2), `occurrences` the active nested
 * head rows.
 */
function doubledComponentsOf(rows) {
  const activeRoots = new Map()
  const inactiveRoots = new Map()
  const activeNested = new Map()
  const push = (map, component, row) => {
    if (!map.has(component)) map.set(component, [])
    map.get(component).push(row)
  }
  for (const candidate of rows) {
    const row = isPlainObject(candidate) ? candidate : {}
    const component = componentOf(row)
    if (component === null) continue
    const active = isActiveRow(row)
    const root = isRootRow(row)
    if (active && root) push(activeRoots, component, row)
    else if (!active && root) push(inactiveRoots, component, row)
    else if (active && !root) push(activeNested, component, row)
  }
  const out = []
  for (const component of Array.from(activeNested.keys()).sort(compareStrings)) {
    if (activeRoots.has(component)) out.push({ component, shape: 'two_copy', roots: activeRoots.get(component), occurrences: activeNested.get(component) })
    else if (inactiveRoots.has(component)) out.push({ component, shape: 'inactive_root_remnant', roots: inactiveRoots.get(component), occurrences: activeNested.get(component) })
  }
  return out
}

function keyCountsOf(rows) {
  const counts = new Map()
  for (const row of rows) {
    const key = isPlainObject(row) ? keyOf(row) : null
    if (key !== null) counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function planDigestOf(body) {
  return sha256(canonicalJson({ scheme: SHEET_REPAIR_PLAN_SCHEME, body }))
}

function claimKeyOf({ tenantId, sheetId, projectNo, recipe, planDigest }) {
  return sha256(canonicalJson({ scheme: SHEET_REPAIR_CLAIM_SCHEME, tenantId, sheetId, projectNo, recipe, planDigest }))
}

function normalizeScope(scope) {
  if (!isPlainObject(scope) || !nonBlankString(scope.tenantId) || !nonBlankString(scope.sheetId) || !nonBlankString(scope.projectNo)) {
    throw unavailable('scope')
  }
  return { tenantId: scope.tenantId.trim(), sheetId: scope.sheetId.trim(), projectNo: scope.projectNo.trim() }
}

// ── retire (design §6.6 「Recipes」) ──────────────────────────────────────────────────────────────────────────

/**
 * One doubled component against the retire preconditions, re-proved from ONE read (the preview's, or the in-lease
 * recompute of an execute): the project is not governed; the source read is complete; the component is D1 with exactly
 * one old root; exactly ONE active nested occurrence subtree pairs with the old subtree (`pairSubtrees` ok); no key of
 * the old subtree is in the current expansion; every row to write is addressable (record id + version), active as the
 * boolean true, and carries machine-shaped stamp cells. The OLD SUBTREE is the root's keyed rows that are active OR
 * were retired by an earlier repair run of this sheet's project (so a run stopped half-way can be re-run for the rest).
 * Answers `{ componentHandle, shape, eligible, refusals, counts, planDigest, writes, backup }` — `writes` / `backup`
 * (private, server-held) only when eligible.
 */
function analyzeRetireComponent(context, entry) {
  const { scope, rows, keyCounts, expansionKeys, retireRunIds, sequence } = context
  const refusals = []
  const refuse = (token) => {
    if (!refusals.includes(token)) refusals.push(token)
  }
  const handle = censusComponentHandle(scope.tenantId, scope.projectNo, entry.component)
  const counts = { nestedCopies: entry.occurrences.length, oldRows: 0, toRetire: 0, alreadyRetired: 0, pairedCopies: 0, pairs: 0, stillExpanded: 0, unaddressable: 0, notMachineShaped: 0 }
  const installRefusal = installRefusalOf(context.installState)
  if (installRefusal) refuse(installRefusal)
  if (context.governed !== false) refuse('project_governed')
  if (context.complete !== true) refuse('source_incomplete')
  if (entry.shape !== 'two_copy') refuse('not_two_copy')
  const root = entry.roots.length === 1 ? entry.roots[0] : null
  if (entry.shape === 'two_copy' && !root) refuse('old_root_ambiguous')
  const rootTokens = root ? pathTokensOf(root) : null
  if (root && !rootTokens) refuse('old_root_path_unreadable')
  const done = (extra = {}) => ({ componentHandle: handle, shape: entry.shape, eligible: false, refusals, counts, planDigest: null, ...extra })
  if (!root || !rootTokens || entry.shape !== 'two_copy') return done()

  const inOldSubtree = (row) => isPlainObject(row) && underTokens(row, rootTokens)
  const oldRows = rows.filter((row) => inOldSubtree(row) && keyOf(row) !== null && (isActiveRow(row) || retiredByKnownRun(row, retireRunIds)))
  counts.oldRows = oldRows.length
  if (rows.some((row) => isPlainObject(row) && isActiveRow(row) && keyOf(row) === null && (componentOf(row) === entry.component || inOldSubtree(row)))) refuse('keyless_rows_present')

  const paired = []
  for (const occurrence of entry.occurrences) {
    const tokens = pathTokensOf(occurrence)
    if (!tokens) continue
    const copyRows = rows.filter((row) => isPlainObject(row) && isActiveRow(row) && keyOf(row) !== null && underTokens(row, tokens))
    const pairing = pairSubtrees({ projectNo: scope.projectNo, oldRootTokens: rootTokens, newRootTokens: tokens, oldRows, newRows: copyRows })
    if (pairing.ok) paired.push({ pairing, copyRows })
  }
  counts.pairedCopies = paired.length
  if (paired.length === 0) refuse('copy_not_paired')
  if (paired.length > 1) refuse('copy_ambiguous')
  const pairing = paired.length === 1 ? paired[0].pairing : null
  if (pairing) counts.pairs = pairing.pairs.length

  const subtreeKeys = new Set(oldRows.map(keyOf))
  if (pairing) for (const row of paired[0].copyRows) subtreeKeys.add(keyOf(row))
  if (Array.from(subtreeKeys).some((key) => keyCounts.get(key) > 1)) refuse('duplicate_keys')

  const expanded = oldRows.filter((row) => expansionKeys.has(keyOf(row)))
  counts.stillExpanded = expanded.length
  if (expansionKeys.has(keyOf(root))) refuse('old_root_still_expanded')
  else if (expanded.length > 0) refuse('old_subtree_still_expanded')

  const active = oldRows.filter(isActiveRow)
  counts.alreadyRetired = oldRows.length - active.length
  counts.toRetire = active.length
  if (active.length === 0) refuse('nothing_to_retire')
  if (active.length > SHEET_REPAIR_MAX_PLAN_ROWS) refuse('plan_too_large')
  const planned = []
  for (const row of active) {
    const address = addressOf(row)
    if (!address) {
      counts.unaddressable += 1
      continue
    }
    const stamps = row.active === true ? stampCellsOf(row) : null
    if (!stamps) {
      counts.notMachineShaped += 1
      continue
    }
    planned.push({ ...address, depth: pathTokensOf(row).length, before: stamps })
  }
  const pairIds = []
  if (pairing) {
    for (const pair of pairing.pairs) {
      const oldAddress = addressOf(pair.oldRow)
      const copyAddress = addressOf(pair.newRow)
      if (!copyAddress) counts.unaddressable += 1
      // An old row an earlier run retired is paired but not written (an ACTIVE one was counted above): its record id
      // alone binds the structure.
      if (!oldAddress && !isActiveRow(pair.oldRow)) counts.unaddressable += 1
      if (oldAddress && copyAddress) pairIds.push([oldAddress.recordId, copyAddress.recordId])
    }
  }
  if (counts.unaddressable > 0) refuse('row_unaddressable')
  if (counts.notMachineShaped > 0) refuse('row_not_machine_shaped')
  if (refusals.length > 0) return done()

  // Deepest row first, the root last: a run stopped half-way leaves the component D1 (its root still active), so the
  // next preview finds it again.
  planned.sort((left, right) => (right.depth - left.depth) || compareStrings(left.recordId, right.recordId))
  const planDigest = planDigestOf({
    recipe: RECIPE_RETIRE,
    tenantId: scope.tenantId,
    sheetId: scope.sheetId,
    projectNo: scope.projectNo,
    componentHandle: handle,
    sequence,
    rows: planned.map((item) => [item.recordId, item.version]),
    pairs: pairIds.sort((left, right) => compareStrings(left[0], right[0]) || compareStrings(left[1], right[1])),
  })
  return {
    componentHandle: handle,
    shape: entry.shape,
    eligible: true,
    refusals,
    counts,
    planDigest,
    writes: planned.map((item) => ({ recordId: item.recordId, version: item.version })),
    backup: planned.map((item) => [item.recordId, item.version, true, item.before.runId, item.before.decision, item.before.summary]),
  }
}

/**
 * The retire analysis of a read. `componentHandle` null => the list of the sheet's doubled components (each with its
 * eligibility); otherwise the ONE component named, or a `component_not_found` refusal.
 */
function analyzeRetire({ scope, rows, expansionKeys, retireRunIds, sequence, governed, complete, installState, componentHandle = null } = {}) {
  const normalized = normalizeScope(scope)
  if (!Array.isArray(rows)) throw unavailable('rows')
  if (!(expansionKeys instanceof Set)) throw unavailable('expansionKeys')
  if (!(retireRunIds instanceof Set)) throw unavailable('retireRunIds')
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw unavailable('sequence')
  const installRefusal = installRefusalOf(installState)
  const context = { scope: normalized, rows, keyCounts: keyCountsOf(rows), expansionKeys, retireRunIds, sequence, governed, complete, installState }
  const components = doubledComponentsOf(rows)
  if (componentHandle === null) {
    return { listing: true, total: components.length, components: components.slice(0, SHEET_REPAIR_MAX_LISTED_COMPONENTS).map((entry) => analyzeRetireComponent(context, entry)) }
  }
  const entry = components.find((candidate) => censusComponentHandle(normalized.tenantId, normalized.projectNo, candidate.component) === componentHandle)
  if (!entry) {
    const refusals = ['component_not_found']
    if (installRefusal) refusals.unshift(installRefusal)
    return { listing: false, component: { componentHandle, shape: null, eligible: false, refusals, counts: null, planDigest: null } }
  }
  return { listing: false, component: analyzeRetireComponent(context, entry) }
}

// ── restore (design §6.6 「Restore against CURRENT versions」, RD G6) ──────────────────────────────────────────

function backupEntriesOf(backup) {
  if (!Array.isArray(backup) || backup.length === 0 || backup.length > SHEET_REPAIR_MAX_PLAN_ROWS) return null
  const out = []
  const seen = new Set()
  for (const entry of backup) {
    if (!Array.isArray(entry) || entry.length !== 6) return null
    const [recordId, version, active, runId, decision, summary] = entry
    if (typeof recordId !== 'string' || !RECORD_ID_PATTERN.test(recordId) || seen.has(recordId)) return null
    if (!Number.isSafeInteger(version) || version < 1 || typeof active !== 'boolean') return null
    for (const cell of [runId, decision, summary]) if (cell !== null && typeof cell !== 'string') return null
    seen.add(recordId)
    out.push({ recordId, version, active, before: { runId, decision, summary } })
  }
  return out
}

/**
 * The restore of ONE retire run, from the sheet as it is NOW (never from the backup's versions): a backed-up row is
 * planned iff it is still `active === false` and still carries THAT run's retire stamp, at its CURRENT version — also
 * when its version moved since the retire (a person filled a human cell, a batch band cell was written: the four
 * cells a restore writes are none of those), which is then counted as `versionMovedStampIntact`. A row that is
 * active again, was restamped by a later machine write or is gone is counted by cause and NOT written.
 */
function analyzeRestore({ scope, run, rows, sequence, governed, installState } = {}) {
  const normalized = normalizeScope(scope)
  if (!Array.isArray(rows)) throw unavailable('rows')
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw unavailable('sequence')
  const refusals = []
  const refuse = (token) => {
    if (!refusals.includes(token)) refusals.push(token)
  }
  const counts = Object.fromEntries(SHEET_REPAIR_RESTORE_COUNT_KEYS.map((key) => [key, 0]))
  const done = (extra = {}) => ({ sourceRunId: run && typeof run.id === 'string' ? run.id : null, eligible: false, refusals, counts, planDigest: null, ...extra })
  const installRefusal = installRefusalOf(installState)
  if (installRefusal) refuse(installRefusal)
  if (governed !== false) refuse('project_governed')
  if (!isPlainObject(run) || run.tenantId !== normalized.tenantId || run.sheetId !== normalized.sheetId || run.projectNo !== normalized.projectNo) {
    refuse('run_not_found')
    return done({ sourceRunId: null })
  }
  if (run.recipe !== RECIPE_RETIRE) {
    refuse('run_not_retire')
    return done()
  }
  const entries = backupEntriesOf(run.backup)
  if (!entries || entries.some((entry) => entry.active !== true)) {
    refuse('backup_unreadable')
    return done()
  }
  counts.backupRows = entries.length
  const byRecordId = new Map()
  for (const row of rows) {
    const ref = isPlainObject(row) ? recordRefOf(row) : null
    if (ref) byRecordId.set(ref.id, row)
  }
  const planned = []
  // Root first: the reverse of the retire's order.
  for (const entry of entries.slice().reverse()) {
    const row = byRecordId.get(entry.recordId)
    if (!row) {
      counts.missing += 1
      continue
    }
    if (!carriesRetireStamp(row, run.id)) {
      if (row.active === false) counts.restamped += 1
      else if (row.lastPlmRefreshRunId === entry.before.runId && row.lastPlmRefreshDecision === entry.before.decision && row.lastPlmConflictSummary === entry.before.summary) counts.notRetired += 1
      else counts.revived += 1
      continue
    }
    const address = addressOf(row)
    if (!address) {
      counts.unaddressable += 1
      continue
    }
    if (address.version !== entry.version + 1) counts.versionMovedStampIntact += 1
    planned.push({ ...address, before: entry.before })
  }
  counts.toRestore = planned.length
  if (counts.unaddressable > 0) refuse('row_unaddressable')
  if (planned.length === 0) refuse('nothing_to_restore')
  if (refusals.length > 0) return done()
  const planDigest = planDigestOf({
    recipe: RECIPE_RESTORE,
    tenantId: normalized.tenantId,
    sheetId: normalized.sheetId,
    projectNo: normalized.projectNo,
    sourceRunId: run.id,
    sequence,
    rows: planned.map((item) => [item.recordId, item.version]),
  })
  return {
    sourceRunId: run.id,
    eligible: true,
    refusals,
    counts,
    planDigest,
    writes: planned.map((item) => ({ recordId: item.recordId, version: item.version, before: item.before })),
    backup: planned.map((item) => [item.recordId, item.version, false, run.id, SHEET_REPAIR_RETIRE_DECISION, SHEET_REPAIR_RETIRE_SUMMARY]),
  }
}

// ── the continuation: verify and close an open run (coordinator ruling C-3) ──────────────────────────────────────

function runInScope(run, scope) {
  return isPlainObject(run) && run.tenantId === scope.tenantId && run.sheetId === scope.sheetId && run.projectNo === scope.projectNo
}

function carriesCells(row, cells) {
  return row.active === cells.active
    && row.lastPlmRefreshRunId === cells.lastPlmRefreshRunId
    && row.lastPlmRefreshDecision === cells.lastPlmRefreshDecision
    && row.lastPlmConflictSummary === cells.lastPlmConflictSummary
}

function closeDigestOf({ scope, run }) {
  return sha256(canonicalJson({
    scheme: SHEET_REPAIR_CLOSE_SCHEME,
    body: { tenantId: scope.tenantId, sheetId: scope.sheetId, projectNo: scope.projectNo, runId: run.id, runRecipe: run.recipe, runPlanDigest: run.planDigest, planned: run.plannedCount },
  }))
}

/**
 * The verification of ONE open run against its OWN row (its backup and what its recipe set out to write) and the sheet
 * as it is NOW — no row is written, by this or by the close that follows it:
 *   a retire run   every backed-up row must be `active === false` carrying THAT run's retire stamp;
 *   a restore run  every backed-up row must carry the four cells the SOURCE retire run backed up for it (`sourceRun`).
 * A row whose four cells are in the target state at another version than the run left it (a person's edit of a human
 * cell, a batch band write) IS in its target state and is counted (`versionMoved`). ANY row that is not refuses with the
 * counts: `notWritten` (exactly as the backup read it), `moved` (neither: revived, restamped), `missing`. Never refused
 * for a governed project or an installing sheet: nothing on the sheet changes, so neither is affected. Answers
 * `{ runId, runRecipe, eligible, refusals, counts, governed, planDigest }`; the digest names the run, its recipe, its
 * approved plan digest and its planned count — not a row version (a later human edit does not move it).
 */
function analyzeClose({ scope, run, sourceRun = null, rows, governed } = {}) {
  const normalized = normalizeScope(scope)
  if (!Array.isArray(rows)) throw unavailable('rows')
  if (typeof governed !== 'boolean') throw unavailable('governed')
  const refusals = []
  const refuse = (token) => {
    if (!refusals.includes(token)) refusals.push(token)
  }
  const counts = Object.fromEntries(SHEET_REPAIR_CLOSE_COUNT_KEYS.map((key) => [key, 0]))
  const known = runInScope(run, normalized)
  const done = (extra = {}) => ({
    runId: known ? run.id : null,
    runRecipe: known && SHEET_REPAIR_RECIPES.includes(run.recipe) ? run.recipe : null,
    eligible: false,
    refusals,
    counts,
    governed,
    planDigest: null,
    ...extra,
  })
  if (!known) {
    refuse('run_not_found')
    return done()
  }
  if (run.status !== 'running') {
    refuse('run_not_open')
    return done()
  }
  const entries = backupEntriesOf(run.backup)
  const retire = run.recipe === RECIPE_RETIRE
  if (!entries || !SHEET_REPAIR_RECIPES.includes(run.recipe) || entries.length !== run.plannedCount
    || typeof run.planDigest !== 'string' || !PLAN_DIGEST_PATTERN.test(run.planDigest)
    || entries.some((entry) => entry.active !== retire)) {
    refuse('backup_unreadable')
    return done()
  }
  // What the run set out to write on each planned row — from the run's own row, never from the request.
  let targetOf
  if (retire) {
    const target = retireChangesOf(run.id)
    targetOf = () => target
  } else {
    const sourceEntries = runInScope(sourceRun, normalized) && sourceRun.recipe === RECIPE_RETIRE && sourceRun.id === run.sourceRunId ? backupEntriesOf(sourceRun.backup) : null
    const beforeById = new Map((sourceEntries || []).map((entry) => [entry.recordId, entry.before]))
    if (!sourceEntries || entries.some((entry) => !beforeById.has(entry.recordId) || entry.before.runId !== sourceRun.id)) {
      refuse('backup_unreadable')
      return done()
    }
    targetOf = (entry) => restoreChangesOf(beforeById.get(entry.recordId))
  }
  const byRecordId = new Map()
  for (const row of rows) {
    const ref = isPlainObject(row) ? recordRefOf(row) : null
    if (ref) byRecordId.set(ref.id, row)
  }
  counts.planned = entries.length
  for (const entry of entries) {
    const row = byRecordId.get(entry.recordId)
    if (!row) {
      counts.missing += 1
      continue
    }
    if (carriesCells(row, targetOf(entry))) {
      counts.inTargetState += 1
      const ref = recordRefOf(row)
      if (ref && Number.isSafeInteger(ref.version) && ref.version !== entry.version + 1) counts.versionMoved += 1
    } else if (carriesCells(row, { active: entry.active, lastPlmRefreshRunId: entry.before.runId, lastPlmRefreshDecision: entry.before.decision, lastPlmConflictSummary: entry.before.summary })) {
      counts.notWritten += 1
    } else {
      counts.moved += 1
    }
  }
  if (counts.inTargetState !== counts.planned) refuse('rows_not_in_target_state')
  if (refusals.length > 0) return done()
  return done({ eligible: true, planDigest: closeDigestOf({ scope: normalized, run }) })
}

// ── the fills report (design §6.6 「The fills report」, RD G7; values-free) ────────────────────────────────────

function fillClassOf({ oldRow, copyRow, humanFieldIds, extHumanFieldIds }) {
  const fields = {}
  let conflict = false
  let carry = false
  let extReenter = false
  let oldFilled = false
  for (const fieldId of humanFieldIds) {
    const oldSet = !isBlankCell(oldRow[fieldId])
    const copySet = !isBlankCell(copyRow[fieldId])
    if (!oldSet && !copySet) continue
    let state
    if (!oldSet) state = 'copy_only'
    else if (!copySet) state = 'carry'
    // K2's own comparison (stock-preparation-confirm-writes.cjs applyCarryViaConfirm): String(target) === String(source).
    else state = String(copyRow[fieldId]) === String(oldRow[fieldId]) ? 'equal' : 'conflict'
    if (oldSet) oldFilled = true
    if (state === 'carry') carry = true
    if (state === 'conflict') conflict = true
    fields[fieldId] = { old: oldSet, copy: copySet, state }
  }
  for (const fieldId of extHumanFieldIds) {
    const oldSet = !isBlankCell(oldRow[fieldId])
    const copySet = !isBlankCell(copyRow[fieldId])
    if (!oldSet && !copySet) continue
    let state
    if (!oldSet) state = 'copy_only'
    else if (!copySet) state = 'carry'
    else state = String(copyRow[fieldId]) === String(oldRow[fieldId]) ? 'equal' : 'conflict'
    if (oldSet) oldFilled = true
    // K2 carries the template's human columns only: a pack column the copy does not already equal must be re-entered.
    if (state === 'carry' || state === 'conflict') extReenter = true
    fields[fieldId] = { old: oldSet, copy: copySet, state, ext: true }
  }
  let fillClass = 'nothing_to_carry'
  if (conflict) fillClass = 'reenter_conflict'
  else if (extReenter) fillClass = 'reenter_ext_human'
  else if (carry) fillClass = 'k2_carryable'
  return { fillClass, fields, oldFilled, touched: Object.keys(fields).length > 0 }
}

function fillsOfComponent(context, entry) {
  const { scope, rows, humanFieldIds, extHumanFieldIds } = context
  const handle = censusComponentHandle(scope.tenantId, scope.projectNo, entry.component)
  const counts = { nestedCopies: entry.occurrences.length, pairs: 0, pairsWithFills: 0, k2Carryable: 0, reenterExtHuman: 0, reenterConflict: 0, nothingToCarry: 0, unpairedOldRows: 0, unpairedOldRowsWithFills: 0 }
  const problems = new Set()
  const pairs = []
  const root = entry.roots.length === 1 ? entry.roots[0] : null
  const rootTokens = root ? pathTokensOf(root) : null
  if (!root) problems.add('old_root_ambiguous')
  else if (!rootTokens) problems.add('old_root_path_unreadable')
  if (rootTokens) {
    const allFieldIds = humanFieldIds.concat(extHumanFieldIds)
    const oldRows = rows.filter((row) => isPlainObject(row) && keyOf(row) !== null && underTokens(row, rootTokens))
    const pairedOld = new Set()
    entry.occurrences.forEach((occurrence, copyOrdinal) => {
      const tokens = pathTokensOf(occurrence)
      if (!tokens) {
        problems.add('copy_path_unreadable')
        return
      }
      const copyRows = rows.filter((row) => isPlainObject(row) && isActiveRow(row) && keyOf(row) !== null && underTokens(row, tokens))
      const pairing = pairSubtrees({ projectNo: scope.projectNo, oldRootTokens: rootTokens, newRootTokens: tokens, oldRows, newRows: copyRows })
      for (const problem of pairing.problems) problems.add(problem.reason)
      for (const pair of pairing.pairs) {
        pairedOld.add(pair.oldRow)
        const verdict = fillClassOf({ oldRow: pair.oldRow, copyRow: pair.newRow, humanFieldIds, extHumanFieldIds })
        counts.pairs += 1
        if (verdict.fillClass === 'k2_carryable') counts.k2Carryable += 1
        else if (verdict.fillClass === 'reenter_ext_human') counts.reenterExtHuman += 1
        else if (verdict.fillClass === 'reenter_conflict') counts.reenterConflict += 1
        else counts.nothingToCarry += 1
        if (!verdict.touched) continue
        counts.pairsWithFills += 1
        const oldRef = recordRefOf(pair.oldRow)
        const copyRef = recordRefOf(pair.newRow)
        pairs.push({
          copy: copyOrdinal + 1,
          depth: pair.relativePath.length,
          oldRecordId: oldRef ? oldRef.id : null,
          copyRecordId: copyRef ? copyRef.id : null,
          oldActive: isActiveRow(pair.oldRow),
          class: verdict.fillClass,
          fields: verdict.fields,
        })
      }
    })
    for (const row of oldRows) {
      if (pairedOld.has(row)) continue
      counts.unpairedOldRows += 1
      if (allFieldIds.some((fieldId) => !isBlankCell(row[fieldId]))) counts.unpairedOldRowsWithFills += 1
    }
  }
  return { componentHandle: handle, shape: entry.shape, counts, problems: Array.from(problems).sort(compareStrings), pairs }
}

/**
 * The fills report of a project's rows. Without `componentHandle`: one summary per doubled component (counts by K2
 * class, the pairing problems as closed tokens). With it: that component's pairs that carry a human fill on either
 * side, paged (`cursor` an offset, `limit` ≤ 200) — per pair the two record-id handles, the K2 class and, per filled
 * human column, whether each side is filled and how the two compare. Never a cell value.
 */
function buildFillsReport({ scope, rows, humanFieldIds, extHumanFieldIds = [], componentHandle = null, cursor = 0, limit = SHEET_REPAIR_FILLS_DEFAULT_LIMIT } = {}) {
  const normalized = normalizeScope(scope)
  if (!Array.isArray(rows)) throw unavailable('rows')
  const human = Array.isArray(humanFieldIds) && humanFieldIds.every(nonBlankString) ? Array.from(new Set(humanFieldIds)) : HUMAN_PRESERVED_FIELD_IDS.slice()
  const ext = Array.isArray(extHumanFieldIds) ? Array.from(new Set(extHumanFieldIds.filter((fieldId) => nonBlankString(fieldId) && !human.includes(fieldId)))) : []
  const context = { scope: normalized, rows, humanFieldIds: human, extHumanFieldIds: ext }
  const components = doubledComponentsOf(rows)
  const humanColumns = { template: human.length, pack: ext.length }
  if (componentHandle === null) {
    const listed = components.slice(0, SHEET_REPAIR_MAX_LISTED_COMPONENTS).map((entry) => {
      const fills = fillsOfComponent(context, entry)
      return { componentHandle: fills.componentHandle, shape: fills.shape, counts: fills.counts, problems: fills.problems }
    })
    return { componentHandle: null, total: components.length, humanColumns, components: listed }
  }
  const entry = components.find((candidate) => censusComponentHandle(normalized.tenantId, normalized.projectNo, candidate.component) === componentHandle)
  if (!entry) return { componentHandle, found: false, humanColumns }
  const fills = fillsOfComponent(context, entry)
  const page = fills.pairs.slice(cursor, cursor + limit).map((pair, index) => ({ ordinal: cursor + index + 1, ...pair }))
  const next = cursor + page.length
  return {
    componentHandle,
    found: true,
    shape: fills.shape,
    humanColumns,
    counts: fills.counts,
    problems: fills.problems,
    pairs: page,
    nextCursor: next < fills.pairs.length ? String(next) : null,
  }
}

// ── the answers (values-free projections) ───────────────────────────────────────────────────────────────

function publicComponentOf(component) {
  return {
    componentHandle: component.componentHandle,
    shape: component.shape,
    eligible: component.eligible === true,
    refusals: component.refusals.slice(),
    counts: component.counts ? { ...component.counts } : null,
    planDigest: component.planDigest,
  }
}

function previewAnswerOf({ recipe, analysis, sequence, openRun }) {
  if (recipe === RECIPE_RETIRE && analysis.listing) {
    return { mode: 'preview', recipe, sequence, openRun, total: analysis.total, components: analysis.components.map(publicComponentOf) }
  }
  const subject = recipe === RECIPE_RETIRE ? publicComponentOf(analysis.component) : {
    sourceRunId: analysis.sourceRunId,
    eligible: analysis.eligible === true,
    refusals: analysis.refusals.slice(),
    counts: { ...analysis.counts },
    planDigest: analysis.planDigest,
  }
  return {
    mode: 'preview',
    recipe,
    sequence,
    openRun,
    ...subject,
    requires: { approvalRef: true, planDigest: subject.planDigest },
  }
}

// ── the run (design §6.6 「The write」 / 「Owner-bound one-shot execution」) ──────────────────────────────────

function requireDeps(deps) {
  if (!isPlainObject(deps)) throw unavailable('deps')
  normalizeScope(deps.scope)
  const store = deps.store
  for (const method of ['listRunsOf', 'readRun', 'readClaim', 'beginRun', 'finishRun', 'closeVerifiedRun']) {
    if (!store || typeof store[method] !== 'function') throw repairError(501, SHEET_REPAIR_ERROR_CODES.UNAVAILABLE, 'the sheet-repair ledger is not wired on this server; nothing was done', { field: 'store', partial: false })
  }
  // `installStateOf` and `assertHolder` are REQUIRED like every other dep: a request that cannot read the install state
  // or cannot check its own guard is refused by name, never run as "not installing" / "still the holder".
  for (const method of ['installStateOf', 'readForRetire', 'readForRestore', 'assertNoLiveWriter', 'withLease', 'assertHolder', 'holderWithinFor', 'leaseOf', 'patchFor', 'auditWithin', 'auditRead', 'newRunId']) {
    if (typeof deps[method] !== 'function') throw unavailable(method)
  }
  if (!isPlainObject(deps.physicalFieldIds) || SHEET_REPAIR_WRITE_FIELD_IDS.some((fieldId) => !nonBlankString(deps.physicalFieldIds[fieldId]))) throw unavailable('physicalFieldIds')
  if (new Set(SHEET_REPAIR_WRITE_FIELD_IDS.map((fieldId) => deps.physicalFieldIds[fieldId])).size !== SHEET_REPAIR_WRITE_FIELD_IDS.length) throw unavailable('physicalFieldIds')
  if (!nonBlankString(deps.actor)) throw unavailable('actor')
  return deps
}

// THE HOST-WRITE BRACKET (the N6 rule; rebaseline B-5; ruling C-1). A ledger transaction of the repair takes the sheet
// lock row FOR UPDATE in its first statement (the holder assert) and holds it to its COMMIT. Outside the guard's
// bracket the lease's own heartbeat would queue behind that row lock and, past the statement timeout, mark the guard
// lost with the lease intact. The repair has no lease-less caller, so a guard WITHOUT the bracket is refused — never
// run unbracketed.
async function inHostWrite(guard, fn) {
  if (!guard || typeof guard.withHostWrite !== 'function') throw unavailable('withHostWrite')
  return guard.withHostWrite(fn)
}

// Read on EVERY analysis, whatever the batch switch says (ruling C-2): a production-write tool never assumes "not
// installing". An unreadable or unwired ledger is the reader's own refusal (the route's 503); an answer this file
// does not understand is 500 naming the reader.
async function installStateOf(deps) {
  return installStateOfFacts(await deps.installStateOf())
}

// ONE holder CAS before the begin (ruling C-4): a guard already lost — a heartbeat that failed while the source was
// read, a lease that lapsed — refuses HERE, before the one-shot claim is spent or a run row is begun. Its refusal keeps
// its own status and code; nothing was written.
async function assertHolderBeforeBegin(deps, guard, { planned }) {
  try {
    await deps.assertHolder(guard)
  } catch (error) {
    if (!error || !Number.isInteger(error.status) || typeof error.code !== 'string') throw error
    throw repairError(error.status, error.code, error.message || 'the repair no longer holds the sheet write lease; nothing was begun', {
      ...(isPlainObject(error.details) ? error.details : {}),
      planned,
      written: 0,
      partial: false,
    })
  }
}

async function ledgerOf(deps) {
  const ledger = await deps.store.listRunsOf(deps.scope)
  if (!isPlainObject(ledger) || !Number.isSafeInteger(ledger.sequence) || ledger.sequence < 0 || !Array.isArray(ledger.retireRunIds) || typeof ledger.openRun !== 'boolean') {
    throw repairError(503, SHEET_REPAIR_ERROR_CODES.STORE_FAILED, 'the sheet-repair ledger could not be read; nothing was done', { operation: 'list_runs', partial: false })
  }
  return { sequence: ledger.sequence, retireRunIds: new Set(ledger.retireRunIds), openRun: ledger.openRun }
}

/** ONE analysis of the sheet for a request — the preview's, and (inside the lease) the execute's recompute of it. */
async function analyze(deps, request, { guard = null } = {}) {
  const installState = await installStateOf(deps)
  const ledger = await ledgerOf(deps)
  if (request.recipe === RECIPE_RETIRE) {
    const read = await deps.readForRetire({ guard })
    if (!isPlainObject(read) || !Array.isArray(read.rows) || !(read.expansionKeys instanceof Set) || typeof read.governed !== 'boolean' || typeof read.complete !== 'boolean') throw unavailable('readForRetire')
    const analysis = analyzeRetire({ scope: deps.scope, rows: read.rows, expansionKeys: read.expansionKeys, retireRunIds: ledger.retireRunIds, sequence: ledger.sequence, governed: read.governed, complete: read.complete, installState, componentHandle: request.componentHandle })
    return { installState, ledger, analysis, plan: analysis.listing ? null : analysis.component }
  }
  const run = await deps.store.readRun({ ...deps.scope, runId: request.runId })
  const read = await deps.readForRestore({ guard })
  if (!isPlainObject(read) || !Array.isArray(read.rows) || typeof read.governed !== 'boolean') throw unavailable('readForRestore')
  const analysis = analyzeRestore({ scope: deps.scope, run, rows: read.rows, sequence: ledger.sequence, governed: read.governed, installState })
  return { installState, ledger, analysis, plan: analysis }
}

/** The continuation's ONE analysis (the preview's, and the execute's recompute inside the lease): the run, its source run, the sheet. */
async function analyzeForClose(deps, request, { guard = null } = {}) {
  const run = await deps.store.readRun({ ...deps.scope, runId: request.runId })
  const sourceRun = run && run.recipe === RECIPE_RESTORE && typeof run.sourceRunId === 'string'
    ? await deps.store.readRun({ ...deps.scope, runId: run.sourceRunId })
    : null
  const read = await deps.readForRestore({ guard })
  if (!isPlainObject(read) || !Array.isArray(read.rows) || typeof read.governed !== 'boolean') throw unavailable('readForRestore')
  return analyzeClose({ scope: deps.scope, run, sourceRun, rows: read.rows, governed: read.governed })
}

function closeAnswerOf(plan) {
  return {
    runId: plan.runId,
    runRecipe: plan.runRecipe,
    eligible: plan.eligible === true,
    refusals: plan.refusals.slice(),
    counts: { ...plan.counts },
    governed: plan.governed === true,
    planDigest: plan.planDigest,
  }
}

async function runClosePreview(deps, request) {
  await deps.assertNoLiveWriter()
  const plan = await analyzeForClose(deps, request)
  await deps.auditRead({
    mode: SHEET_REPAIR_AUDIT.modes.previewRead,
    detail: { operation: 'sheet_repair_close_preview', recipe: request.recipe, eligible: plan.eligible === true, refusalCount: plan.refusals.length, planned: plan.counts.planned, inTargetState: plan.counts.inTargetState, governed: plan.governed === true },
  })
  return { mode: 'preview', recipe: request.recipe, ...closeAnswerOf(plan), requires: { approvalRef: true, planDigest: plan.planDigest } }
}

/**
 * THE CONTINUATION'S EXECUTE (ruling C-3): the sheet lease -> the SAME verification recomputed in the lease -> the
 * echoed digest -> ONE ledger transaction in the host-write bracket (holder assert first; the run still `running` and
 * begun under ANOTHER lease; `completed`, its close approval, its audit row) -> after the release, the generation bump
 * the run itself never got to. No sheet row is written and no claim is spent: a closed run cannot be closed again (409
 * `run_not_open`).
 */
async function runCloseExecute(deps, request) {
  let closed = false
  let answer
  try {
    answer = await deps.withLease(request.runId, async (guard) => {
      if (!guard) throw unavailable('withLease')
      const plan = await analyzeForClose(deps, request, { guard })
      if (!plan.eligible) throw notApplicable(plan.refusals, plan.counts)
      if (plan.planDigest !== request.planDigest) throw planChanged('plan_digest_differs')
      const holderWithin = deps.holderWithinFor(guard)
      if (typeof holderWithin !== 'function') throw unavailable('holderWithinFor')
      const lease = deps.leaseOf(guard)
      const planned = plan.counts.planned
      // No holder CAS beforehand (unlike the begin): the close spends nothing, and its transaction's own holder assert
      // decides from the lock row — a guard marked lost by a transient heartbeat failure closes under an intact lease.
      await inHostWrite(guard, () => deps.store.closeVerifiedRun({
        ...deps.scope,
        runId: plan.runId,
        verifiedCount: plan.counts.inTargetState,
        versionMoved: plan.counts.versionMoved,
        governed: plan.governed === true,
        closeDigest: plan.planDigest,
        approvalRef: request.approvalRef,
        lease,
        holderWithin,
        auditWithin: deps.auditWithin,
      }))
      closed = true
      return { mode: 'execute', recipe: request.recipe, runId: plan.runId, runRecipe: plan.runRecipe, status: 'completed', planned, verified: plan.counts.inTargetState, versionMoved: plan.counts.versionMoved, governed: plan.governed === true, planDigest: plan.planDigest }
    })
  } finally {
    // The run's own bump never ran (its lease was gone): every token planned before the repair is superseded now.
    if (closed && typeof deps.bumpAfterRelease === 'function') {
      try {
        await deps.bumpAfterRelease()
        if (answer) answer = { ...answer, generationBumped: true }
      } catch (error) {
        logWarn(deps.logger, '[plugin-integration-core] stock-prep sheet repair: the generation bump after a verified close failed', { code: errorCodeOf(error) })
      }
    }
  }
  return { ...answer, generationBumped: answer.generationBumped === true }
}

function previewAuditDetailOf(request, state) {
  const plan = state.plan
  return {
    operation: 'sheet_repair_preview',
    recipe: request.recipe,
    listing: plan === null,
    eligible: plan ? plan.eligible === true : false,
    refusalCount: plan ? plan.refusals.length : 0,
    components: plan === null ? state.analysis.total : 1,
    planned: plan && plan.eligible ? plan.writes.length : 0,
    sequence: state.ledger.sequence,
  }
}

async function runPreview(deps, request) {
  // A preview of a sheet a writer holds would read rows that are moving: refused like every other preview.
  await deps.assertNoLiveWriter()
  const state = await analyze(deps, request)
  // Audited BEFORE the answer (it carries the census's private component handles): a refusing audit => no answer.
  await deps.auditRead({ mode: SHEET_REPAIR_AUDIT.modes.previewRead, detail: previewAuditDetailOf(request, state) })
  return previewAnswerOf({ recipe: request.recipe, analysis: state.analysis, sequence: state.ledger.sequence, openRun: state.ledger.openRun })
}

function stopReasonOf(error) {
  if (error && (error.code === RECORD_VERSION_CONFLICT_CODE || error.name === 'MultitableRecordVersionConflictError')) return 'version_conflict'
  if (error && (error.code === RECORD_LOCKED_CODE || error.name === 'MultitableRecordLockedError')) return 'record_locked'
  if (error && (error.code === RECORD_NOT_FOUND_CODE || error.name === 'MultitableRecordNotFoundError')) return 'record_missing'
  return 'host_write_failed'
}

// A lost lease, a superseded plan or a lock-store failure raised by the write fence (or a typed refusal of the run's
// own finish): the same status and code with the partial counts attached (values-free) — the apply's
// `projectWriteAbortError` shape.
function fenceStopError(error, { runId, planned, written }) {
  const status = Number.isInteger(error.status) ? error.status : 409
  const code = typeof error.code === 'string' ? error.code : SHEET_REPAIR_ERROR_CODES.STOPPED
  return repairError(status, code, error.message || 'the repair lost the sheet write lease; it stopped before the next write', {
    ...(isPlainObject(error.details) ? error.details : {}),
    runId,
    planned,
    written,
    partial: written > 0,
  })
}

/**
 * The fenced write of a plan: one version-conditional patch per row, in plan order, the four repair cells only. The
 * FIRST row that cannot be written exactly as planned stops the run — a version conflict is never re-read and retried
 * (design §6.6: 「a version conflict stops the run (never a blind retry)」). Answers `{ written, attempted, stop }`; a
 * fence error is thrown (the run row is then closed by whoever takes the sheet next). `attempted` counts every patch
 * HANDED to the fenced write, confirmed or not (ruling C-5; the apply writer's `countAttemptedHostWrites`): a write that
 * raised may have landed. A refusal of the pre-write holder CAS is counted too — this loop cannot tell it from a
 * refusal inside the host, and a bump that was not needed only supersedes tokens.
 */
async function writePlan({ deps, patch, items, changesOf, onAttempt }) {
  const allowed = new Set(SHEET_REPAIR_WRITE_FIELD_IDS.map((fieldId) => deps.physicalFieldIds[fieldId]))
  let written = 0
  let attempted = 0
  for (const item of items) {
    const logical = changesOf(item)
    const changes = {}
    for (const fieldId of SHEET_REPAIR_WRITE_FIELD_IDS) changes[deps.physicalFieldIds[fieldId]] = logical[fieldId]
    // The whole write surface, asserted at the send (ruling C7): exactly the four repair cells, nothing else.
    const keys = Object.keys(changes)
    if (keys.length !== allowed.size || Object.keys(logical).length !== SHEET_REPAIR_WRITE_FIELD_IDS.length || keys.some((key) => !allowed.has(key))) throw unavailable('changes')
    if (typeof logical.active !== 'boolean') throw unavailable('changes')
    let updated
    attempted += 1
    if (typeof onAttempt === 'function') onAttempt(attempted)
    try {
      updated = await patch({ recordId: item.recordId, changes, expectedVersion: item.version })
    } catch (error) {
      if (error && error.fence === true) throw Object.assign(error, { sheetRepairWritten: written })
      return { written, attempted, stop: stopReasonOf(error), hostCode: errorCodeOf(error) }
    }
    written += 1
    const version = updated && Number.isSafeInteger(updated.version) ? updated.version : null
    if (version !== null && version !== item.version + 1) return { written, attempted, stop: 'host_version_unexpected', hostCode: null }
  }
  return { written, attempted, stop: null, hostCode: null }
}

async function runExecute(deps, request) {
  const store = deps.store
  // PRELUDE (no lease): an approved plan that already ran answers as consumed before the sheet is locked for anyone.
  if (await store.readClaim({ ...deps.scope, recipe: request.recipe, planDigest: request.planDigest })) throw alreadyConsumed()
  const runId = deps.newRunId()
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw unavailable('newRunId')
  let written = 0
  let attempted = 0
  let answer
  try {
    answer = await deps.withLease(runId, async (guard) => {
      if (!guard) throw unavailable('withLease')
      // GATES, in the lease: nothing of a pull, a recovery, an install or a pilot enable can move the sheet from here.
      const state = await analyze(deps, request, { guard })
      if (state.installState !== 'none') throw installInProgress(state.installState)
      const plan = state.plan
      if (!plan || !plan.eligible) throw notApplicable(plan ? plan.refusals : ['component_not_found'], plan ? plan.counts : null)
      if (plan.planDigest !== request.planDigest) {
        // The echoed digest was consumed by a run that finished between the prelude and this lease.
        if (await store.readClaim({ ...deps.scope, recipe: request.recipe, planDigest: request.planDigest })) throw alreadyConsumed()
        throw planChanged('plan_digest_differs')
      }
      const holderWithin = deps.holderWithinFor(guard)
      if (typeof holderWithin !== 'function') throw unavailable('holderWithinFor')
      const lease = deps.leaseOf(guard)
      // The fenced patch is built BEFORE the run row: a host that cannot honour the write fence refuses here (501),
      // with no claim spent.
      const patch = deps.patchFor(guard)
      if (typeof patch !== 'function') throw unavailable('patchFor')
      const planned = plan.writes.length
      const subject = request.recipe === RECIPE_RETIRE ? { componentHandle: plan.componentHandle } : { sourceRunId: plan.sourceRunId }
      // HOLDER — one holder CAS before the claim is spent (ruling C-4). Nothing is awaited between it and the begin's
      // bracket, so no heartbeat tick runs in between.
      await assertHolderBeforeBegin(deps, guard, { planned })
      // BEGIN — the backup, the run row and the one-shot claim, before the first sheet write.
      await inHostWrite(guard, () => store.beginRun({
        ...deps.scope,
        runId,
        writeScopeKey: guard.scopeKey,
        recipe: request.recipe,
        planDigest: plan.planDigest,
        approvalRef: request.approvalRef,
        ...subject,
        backup: plan.backup,
        plannedCount: planned,
        expectSequence: state.ledger.sequence,
        lease,
        startedBy: deps.actor,
        holderWithin,
        auditWithin: deps.auditWithin,
      }))
      // WRITES.
      let run
      try {
        run = await writePlan({
          deps,
          patch,
          items: plan.writes,
          changesOf: request.recipe === RECIPE_RETIRE ? () => retireChangesOf(runId) : (item) => restoreChangesOf(item.before),
          onAttempt: (count) => { attempted = count },
        })
      } catch (error) {
        written = Number.isSafeInteger(error && error.sheetRepairWritten) ? error.sheetRepairWritten : 0
        if (error && error.fence === true) throw fenceStopError(error, { runId, planned, written })
        throw error
      }
      written = run.written
      // FINISH — the run row and its audit row, holder assert first. A refusal here (the lease was taken over after
      // the last write) leaves the run open; the next repair request on this sheet closes it as abandoned.
      try {
        await inHostWrite(guard, () => store.finishRun({
          ...deps.scope,
          runId,
          status: run.stop ? 'stopped' : 'completed',
          stopReason: run.stop,
          writtenCount: written,
          lease,
          holderWithin,
          auditWithin: deps.auditWithin,
        }))
      } catch (error) {
        if (error && Number.isInteger(error.status) && typeof error.code === 'string') throw fenceStopError(error, { runId, planned, written })
        throw error
      }
      if (run.stop) {
        throw repairError(409, SHEET_REPAIR_ERROR_CODES.STOPPED, 'a row of this plan could not be written as planned, so the run stopped; preview again — the rest needs a new digest and its own approval', {
          reason: run.stop,
          ...(run.hostCode ? { hostCode: run.hostCode } : {}),
          runId,
          planned,
          written,
          partial: written > 0,
        })
      }
      return { mode: 'execute', recipe: request.recipe, runId, status: 'completed', planned, written, planDigest: plan.planDigest, ...subject }
    })
  } finally {
    // After the lease is released: every token planned before a repair that ATTEMPTED a host write is superseded (best
    // effort — the rows' own hash refuses such a token as well). Attempted, not confirmed (ruling C-5): a patch that
    // raised may have landed. Zero attempts (every refusal before the first patch) moves nothing.
    if (attempted > 0 && typeof deps.bumpAfterRelease === 'function') {
      try {
        await deps.bumpAfterRelease()
        if (answer) answer = { ...answer, generationBumped: true }
      } catch (error) {
        logWarn(deps.logger, '[plugin-integration-core] stock-prep sheet repair: the generation bump after release failed', { code: errorCodeOf(error) })
      }
    }
  }
  return { ...answer, generationBumped: answer.generationBumped === true }
}

/**
 * The repair route's one entry point (the route has run the guard chain: ADMIN, the project-sheets switch, the repair
 * switch, the closed body, the typed project number, services, the scope, the audit vocabulary, the registry row, the
 * write target walled to the tenant and the registry's own sheet, the ledger probe).
 */
async function runSheetRepairRequest(deps, body) {
  const request = normalizeSheetRepairBody(body)
  requireDeps(deps)
  if (request.recipe === RECIPE_CLOSE) return request.mode === 'execute' ? runCloseExecute(deps, request) : runClosePreview(deps, request)
  return request.mode === 'execute' ? runExecute(deps, request) : runPreview(deps, request)
}

/** The fills report read: the rows through the route's reader, the report, its audit row BEFORE the answer. */
async function readFillsReport(deps, query) {
  const request = normalizeFillsReportQuery(query)
  if (!isPlainObject(deps) || typeof deps.readRows !== 'function' || typeof deps.auditRead !== 'function') throw unavailable('deps')
  const rows = await deps.readRows()
  if (!Array.isArray(rows)) throw unavailable('readRows')
  // The human band as the planner derives it: the template's whitelist, plus the pack columns the sheet's own
  // installed properties declare human (absent => the template's alone).
  const band = derivePackAwarePlmWritableFields({ templateFields: deps.template, installedFieldProperties: deps.installedFieldProperties })
  const report = buildFillsReport({ scope: deps.scope, rows, humanFieldIds: HUMAN_PRESERVED_FIELD_IDS, extHumanFieldIds: band.packHumanPreservedFieldIds, componentHandle: request.componentHandle, cursor: request.cursor, limit: request.limit })
  const summary = report.componentHandle === null
    ? { components: report.total, pairs: report.components.reduce((sum, entry) => sum + entry.counts.pairs, 0), pairsWithFills: report.components.reduce((sum, entry) => sum + entry.counts.pairsWithFills, 0) }
    : { components: report.found ? 1 : 0, pairs: report.found ? report.counts.pairs : 0, pairsWithFills: report.found ? report.counts.pairsWithFills : 0 }
  await deps.auditRead({
    mode: SHEET_REPAIR_AUDIT.modes.fillsReportRead,
    detail: { operation: 'sheet_fills_report', listing: report.componentHandle === null, pageSize: Array.isArray(report.pairs) ? report.pairs.length : 0, rowCount: rows.length, ...summary },
  })
  return report
}

/** The runs read: the values-free run list of the project's sheet, its audit row BEFORE the answer. */
async function readRepairRuns(deps) {
  if (!isPlainObject(deps) || !deps.store || typeof deps.store.listRuns !== 'function' || typeof deps.auditRead !== 'function') throw unavailable('deps')
  const listed = await deps.store.listRuns(normalizeScope(deps.scope))
  if (!isPlainObject(listed) || !Array.isArray(listed.runs)) throw repairError(503, SHEET_REPAIR_ERROR_CODES.STORE_FAILED, 'the sheet-repair ledger could not be read; nothing was done', { operation: 'list_runs', partial: false })
  await deps.auditRead({ mode: SHEET_REPAIR_AUDIT.modes.runsRead, detail: { operation: 'sheet_repair_runs', runCount: listed.runs.length, truncated: listed.truncated === true } })
  return { runs: listed.runs, truncated: listed.truncated === true }
}

module.exports = {
  STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV,
  SHEET_REPAIR_AUDIT,
  SHEET_REPAIR_BODY_KEYS,
  SHEET_REPAIR_CLAIM_SCHEME,
  SHEET_REPAIR_CLOSE_COUNT_KEYS,
  SHEET_REPAIR_CLOSE_SCHEME,
  SHEET_REPAIR_COMPONENT_SHAPES,
  SHEET_REPAIR_CONTINUATIONS,
  SHEET_REPAIR_ERROR_CODES,
  SHEET_REPAIR_FILLS_QUERY_KEYS,
  SHEET_REPAIR_FILL_CLASSES,
  SHEET_REPAIR_FILL_STATES,
  SHEET_REPAIR_GENERATION_REASON,
  SHEET_REPAIR_INSTALL_STATES,
  SHEET_REPAIR_LEASE_PURPOSE,
  SHEET_REPAIR_MODES,
  SHEET_REPAIR_PLAN_SCHEME,
  SHEET_REPAIR_RECIPES,
  SHEET_REPAIR_REFUSALS,
  SHEET_REPAIR_REQUEST_RECIPES,
  SHEET_REPAIR_RETIRE_DECISION,
  SHEET_REPAIR_RETIRE_SUMMARY,
  SHEET_REPAIR_RESTORE_COUNT_KEYS,
  SHEET_REPAIR_RUN_ID_PREFIX,
  SHEET_REPAIR_RUN_STATUSES,
  SHEET_REPAIR_STAMP_FIELD_IDS,
  SHEET_REPAIR_STOP_REASONS,
  SHEET_REPAIR_WRITE_FIELD_IDS,
  StockPreparationSheetRepairError,
  analyzeClose,
  analyzeRestore,
  analyzeRetire,
  buildFillsReport,
  claimKeyOf,
  installStateOfFacts,
  normalizeFillsReportQuery,
  normalizeRunsQuery,
  normalizeSheetRepairBody,
  readFillsReport,
  readRepairRuns,
  runSheetRepairRequest,
  stockPrepSheetRepairWriteEnabled,
  __internals: {
    APPROVAL_REF_PATTERN,
    COMPONENT_HANDLE_PATTERN,
    PLAN_DIGEST_PATTERN,
    RECORD_ID_PATTERN,
    RUN_ID_PATTERN,
    SHEET_REPAIR_MAX_PLAN_ROWS,
    alreadyConsumed,
    analyzeRetireComponent,
    backupEntriesOf,
    carriesRetireStamp,
    closeDigestOf,
    doubledComponentsOf,
    fillClassOf,
    inHostWrite,
    isMachineSummary,
    planChanged,
    planDigestOf,
    repairError,
    restoreChangesOf,
    retireChangesOf,
    stampCellsOf,
    stopReasonOf,
    writePlan,
  },
}
