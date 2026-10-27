'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 4, PR-2 — THE CONTINUATION / REFRESH-STATE STORE over migrations 102 and 103.
//
// Design: the step-4 synthesis (2026-10-23) §4.1-4.2 (tables), §4.4 (scoping and privacy), §8.2-8.4 (the
// confirm / re-confirm / end transactions and the hold lifecycle), §9.2 (settlement), §9.5 (how reads
// distinguish unreadable from none), §17 row PR-2; plan docs/development/takeover-beiliao-20260821/
// batch-refresh-merge-plan-20261022.md §4, §5.2, §5.3, §9.1 A08 / A11.
//
// WHAT IT IS. The only writer and the only reader of the five step-4 tables:
//   integration_stock_prep_continuation / _continuation_member   (migration 102, the 沿用关系 + its members)
//   integration_stock_prep_refresh_state / _refresh_hold / _refresh_execution   (migration 103)
// Every method takes `{ tenantId, sheetId, projectNo }` (design §4.4) and runs through the scoped db helper
// (lib/db.cjs): no raw SQL, equality WHERE only, SELECT * projections.
//
// THREE DISTINCT ANSWERS (plan §8 / §9.1 A11; design D8, §9.5). A read answers `{ ok: true, rows }` or THROWS
// StockPreparationRefreshStoreError(503, STOCK_PREP_REFRESH_STORE_FAILED, { operation, sqlState?, partial:
// false }) — never an empty array on a failure, and a missing table (a deploy without migrations 102/103) is
// a store failure exactly like the lock's (stock-preparation-project-write-lock.cjs header, FAIL CLOSED). A
// page that fills its ceiling is a failure too (`reason: 'row_cap'`): an answer that may be incomplete is not
// an answer.
//
// THE TRANSACTIONS (design §8). Confirm, re-confirm and end run in ONE plugin-db transaction each: the
// refresh-state row FOR UPDATE first (it serialises every decision and every hold reconciliation of the
// project), the hold re-read by id with the page's fingerprints echoed (U04: a confirm is bound to what the
// server last computed, never to field names and counts), then `bumpWithin(trx, scopeKey, { reason })` —
// the LOCK's in-transaction generation bump (design §8.1, PR-4's `bumpGenerationWithin`; this store never
// implements it and refuses to run without it) — then the rows, the hold resolution, `decision_version + 1`
// on the state row, and the caller's optional `auditWithin(trx, event)` (E09: an audit failure rolls the
// decision back). A throw anywhere rolls everything back; a 23505 from the partial unique claims of
// migration 102 is 409 STOCK_PREP_CONTINUATION_CONFIRM_CONFLICT (A08 as a DB fact).
//
// THE HOLD LIFECYCLE (design §8.4). Every computation of a governed project reconciles its holds through
// `reconcileHolds`: state row FOR UPDATE (created by UPSERT on first use, so two first computations
// serialise instead of one dying), a compare-and-set on `decision_version` as OBSERVED AT CONSULT TIME
// (moved => 409 STOCK_PREP_PULL_STATE_MOVED, nothing persisted — never a stale hold set; deliberately NOT keyed
// on the lock's generation token, which every applicable preview moves), then fingerprint-keyed
// insert / keep / supersede, the continuation verdicts, `hold_set_fingerprint`, `last_computation_*` and —
// for a clean computation with zero pending decisions — the settled columns (§9.2). `runbook_only` holds
// (an escalated continuation, §8.4) are never superseded by a computation.
//
// LOCK ORDER (TD-23, PR-3a). ONE rule for every step-4 transaction: a transaction that will touch the
// refresh-state row takes it FOR UPDATE FIRST (reconcileHolds, confirmContinuation, endContinuation and a
// SETTLING finishExecution), so any two of them on one project serialise on that row before either holds
// anything else. A non-settling finishExecution starts at its execution row and never touches the state row;
// it locks only its bound continuations. Continuation rows a computation or a finish touches are taken in
// ascending id order (the planner's verdicts are sorted, the lane's refresh binding is sorted). Execution rows
// and hold rows are never both locked by one transaction. Before PR-3a a settling finish locked execution ->
// continuation -> state and could deadlock a concurrent preview's reconcile (state -> hold -> continuation);
// the real-DB case S3A-17 proves both interleavings.
// Step 5 (PR-8) adds the CHANGE-PLAN rows, always taken AFTER the continuation rows of the same transaction and never
// before a state row it takes: confirmChangePlan (state -> continuations -> plans -> lock row -> inserts / hold
// resolutions), completeChangeReview (state -> plan), reconcileHolds (state -> holds -> continuations -> plan, the
// executions only read), a change-plan-bound beginExecution (state -> plan -> the execution INSERT) and
// finishExecution (execution -> continuations -> plans; a settling one takes the state row first). Holds are written
// only under the state row, so the confirm resolving holds after it locked plan rows opens no cycle.
//
// THE CONSULT READ IS ONE SNAPSHOT (review X-1). The CAS above only holds if the decision_version the consult
// observed and the holds / continuations / members it planned from are ONE point in time. `readGovernanceRows`
// therefore runs every read in ONE transaction pinned to REPEATABLE READ by its first statement (and lets the
// governance reader put its registry reads first in the same snapshot): a decision that commits mid-consult
// is either wholly in the answer or wholly out of it — and then the reconciliation keyed on the old
// decision_version is refused STATE_MOVED.
//
// END AND SUPERSEDE ADMISSIBILITY (design §8.4, §9.3; review X-2 / X-3). `endContinuation` ends only a
// relationship that NEEDS RECONFIRMATION (an ACTIVE one ends only through a confirm's `supersedes`), and
// `escalate_special_repair` only while an OPEN hold names it (that hold stays open, runbook-only, so the
// project can never derive 已完成 while it is open). A confirm `supersedes` only a relationship it FULLY takes
// over: related to it (`claimsOverlap`, else `supersedes_unrelated`) and claiming every old record id and every
// old key digest it claims, root and every member (`takeoverGaps`, else `supersedes_incomplete`) — a supersede
// ends all of the old claims, so anything left uncovered would lose its protection (review round 2). All are
// refused 409 STOCK_PREP_CONTINUATION_END_OUTCOME_NOT_ADMISSIBLE inside the transaction before any row moves.
//
// STATUS CONVENTION FOR BAD INPUT: what a PULLER's request carries (scope / actor / row ids 422, the basis
// and the end note 422 / 400, echoed fingerprints 400, revisions / outcomes / the `supersedes` shape 400) is a
// 4xx; what the PLANNER or the lane hands over (hold shapes, duplicate fingerprints in one computation,
// verdicts, settlements, the source identity, a bump answer, the execution guard) is a server-side defect:
// 500 STOCK_PREP_REFRESH_INPUT_INVALID, refused before any statement.
//
// VALUES. Columns marked PRIVATE in the migrations (keys, paths, component ids, quantities, basis text,
// hold detail) come back from the read projections because the planner and the audited pull-tier routes
// need them; the CONSULT ANSWER IS SERVER-HELD and never a response body. Every error raised here carries
// handles, closed tokens, counts and SQLSTATE class codes only.
//
// THE CHANGE PLAN (batch-refresh step 5 PR-8, migration 104; design §10.3 (1)-(5), plan §3.4). The consult reads the
// PENDING plans (`confirmed` and `written`) in its snapshot, values-free summaries only. `confirmChangePlan` turns the
// WHOLE open content-class hold set into one `confirmed` plan (every admissibility fact decided under the state-row
// lock); `completeChangeReview` turns the `written` plan into `reviewed`; `reconcileHolds` invalidates a confirmed plan
// whose change set a computation no longer finds (`source_changed`) — never one an execution is writing; a bound
// `beginExecution` re-asserts the plan under the lock; `finishExecution` marks it `written` (absorbing the unreviewed
// fields of the previous written plan, so no written change ever escapes review) or `invalidated(execution_failed)`.
//
// NOT HERE: no route, no lane consult (PR-3), no `bumpGenerationWithin` (PR-4), no audit vocabulary (D9),
// no env flag (D-3).
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const { sheetWriteScopeKey } = require('./stock-preparation-project-write-lock.cjs')
const pairing = require('./stock-preparation-continuation-pairing.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require('./stock-preparation-templates.cjs')
const { __internals: plannerInternals } = require('./stock-preparation-conflict-planner.cjs')

const {
  CONTINUATION_ERROR_CODES,
  CONTINUATION_VERDICTS,
  HOLD_KINDS,
  NOT_CONFIRMABLE_REASONS,
  RECONFIRMABLE_REASONS,
  SHAPE_TOKENS,
  VOLATILE_DETAIL_KEYS,
  canonicalChangeValue,
  changePlanFingerprintOf,
  changePlanRecordsFromHolds,
  isContentClassHold,
  isStructureClassHold,
  plannedContentDigestOf,
} = pairing
const { canonicalJson, subjectDigest } = pairing.__internals

const REFRESH_STORE_TABLES = Object.freeze({
  continuation: 'integration_stock_prep_continuation',
  member: 'integration_stock_prep_continuation_member',
  state: 'integration_stock_prep_refresh_state',
  hold: 'integration_stock_prep_refresh_hold',
  execution: 'integration_stock_prep_refresh_execution',
  // Step 5 PR-8 (migration 104).
  changePlan: 'integration_stock_prep_change_plan',
  // PR-8 review fix N3-b (round 2, migration 104): the reviewed-cell register — written only by the review, read only by
  // the consult (after a review), never deleted.
  reviewedCell: 'integration_stock_prep_reviewed_cell',
})

// ── closed vocabularies (migrations 102 / 103 CHECKs; pinned against the pure core by the unit suite) ──

const CONTINUATION_ROW_STATUSES = Object.freeze(['active', 'needs_reconfirmation', 'ended'])
// Design §9.4 status_reason = the verdicts minus `valid` and minus `content_changed` (which raises a
// relationship_content_change hold and never moves the status).
const CONTINUATION_STATUS_REASONS = Object.freeze(CONTINUATION_VERDICTS.filter((token) => token !== 'valid' && token !== 'content_changed'))
const EVIDENCE_HISTORY_STATUSES = Object.freeze(['history_unknown', 'relationship_snapshot', 'demand_evidence_store'])
const DEMAND_BASES = Object.freeze(['puller_confirmed_same_demand'])
const APPLICABILITY_SCOPES = Object.freeze(['this_project_this_position'])
const END_OUTCOMES = Object.freeze(['superseded_by_new_confirmation', 'release_to_normal_refresh', 'escalate_special_repair'])
const HOLD_STATUSES = Object.freeze(['open', 'resolved', 'superseded'])
const HOLD_RESOLUTIONS = Object.freeze(['continuation_confirmed', 'continuation_ended', 'change_plan_confirmed', 'superseded_by_computation', 'runbook_closed'])
const COMPUTATION_LANES = Object.freeze(['small_preview', 'small_apply', 'reconcile', 'mvp_persist'])
const EXECUTION_LANES = Object.freeze(['small_apply'])
const EXECUTION_STATUSES = Object.freeze(['running', 'succeeded', 'partial', 'failed', 'aborted', 'verified_closed'])
const EXECUTION_FINISH_STATUSES = Object.freeze(['succeeded', 'partial', 'failed', 'aborted'])
const UNFINISHED_EXECUTION_STATUSES = Object.freeze(['running', 'partial', 'failed', 'aborted'])
const VERIFIED_RESULTS = Object.freeze(['landed', 'nothing_landed', 'mixed', 'unknown'])
const BUMP_REASONS = Object.freeze({ confirm: 'continuation_confirm', end: 'continuation_end', changePlan: 'change_plan_confirm' })
const BASIS_NOTE_MAX_LENGTH = 2000
// Step 5 PR-8 (migration 104 CHECKs; pinned against the SQL by the change-plan store suite).
const CHANGE_PLAN_STATUSES = Object.freeze(['confirmed', 'written', 'reviewed', 'invalidated', 'superseded'])
const CHANGE_PLAN_PENDING_STATUSES = Object.freeze(['confirmed', 'written'])
const CHANGE_PLAN_INVALIDATED_REASONS = Object.freeze(['source_changed', 'execution_failed'])
const REVIEW_CONCLUSIONS = Object.freeze(['handled', 'handled_with_notes'])
const REVIEW_NOTES_MAX_LENGTH = 2000
// Q-8 (refutation note 6): a change plan binds at most this many records (the hold read ceiling); a larger content
// change is refused `too_many_records` (no confirm control) — stated in the PR body.
const CHANGE_PLAN_RECORD_CEILING = 5000
// Registry-note rule (project-target-store.cjs): C0 / DEL / C1 and the Unicode line separators (U+2028 /
// U+2029, built from char codes so no literal separator byte sits in this source) are refused.
const CONTROL_CHARACTER_PATTERN = new RegExp(`[\\x00-\\x1F\\x7F-\\x9F${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`)

const SCHEMES = Object.freeze({
  holdSet: 'stock-preparation/hold-set/v1',
  memberOldContent: 'stock-preparation/member-old-content/v1',
  evidenceSnapshot: 'stock-preparation/continuation-evidence-snapshot/v1',
})

const REFRESH_STORE_ERROR_CODES = Object.freeze({
  STORE_FAILED: CONTINUATION_ERROR_CODES.STORE_FAILED,
  STORE_UNAVAILABLE: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE',
  INPUT_INVALID: 'STOCK_PREP_REFRESH_INPUT_INVALID',
  TENANT_MISMATCH: 'STOCK_PREP_REFRESH_TENANT_MISMATCH',
  STATE_MOVED: 'STOCK_PREP_PULL_STATE_MOVED',
  CONFIRM_STALE: 'STOCK_PREP_CONTINUATION_CONFIRM_STALE',
  CONFIRM_NOT_ALLOWED: 'STOCK_PREP_CONTINUATION_CONFIRM_NOT_ALLOWED',
  CONFIRM_CONFLICT: 'STOCK_PREP_CONTINUATION_CONFIRM_CONFLICT',
  END_OUTCOME_NOT_ADMISSIBLE: 'STOCK_PREP_CONTINUATION_END_OUTCOME_NOT_ADMISSIBLE',
  HOLD_MALFORMED: 'STOCK_PREP_CONTINUATION_HOLD_MALFORMED',
  // The lanes' token (stock-preparation-refresh-lanes.cjs REFRESH_LANE_ERROR_CODES.RECOVERY_PENDING), spelled here
  // because the decision transactions re-check the unfinished executions under the state-row lock (PR-4 review).
  RECOVERY_PENDING: 'STOCK_PREP_REFRESH_RECOVERY_PENDING',
  // Step 5 PR-8: the change plan and the review (the writer's stop spells CHANGE_PLAN_STALE too,
  // stock-preparation-apply-writer.cjs CHANGE_PLAN_STALE_CODE).
  CHANGE_PLAN_STALE: 'STOCK_PREP_CHANGE_PLAN_STALE',
  CHANGE_PLAN_NOT_ALLOWED: 'STOCK_PREP_CHANGE_PLAN_NOT_ALLOWED',
  CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT: 'STOCK_PREP_CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT',
  CHANGE_REVIEW_STALE: 'STOCK_PREP_CHANGE_REVIEW_STALE',
  CHANGE_REVIEW_BLOCKED: 'STOCK_PREP_CHANGE_REVIEW_BLOCKED',
  // PR-8 review fix N1: the decisions' NOT_PILOT token (stock-preparation-refresh-decisions.cjs REFRESH_DECISION_ERROR_CODES
  // .NOT_PILOT), spelled here because the combined confirm re-decides the pilot marker under the state-row lock.
  NOT_PILOT: 'STOCK_PREP_CONTINUATION_CONFIRM_NOT_PILOT',
})

// The consult's reads share ONE snapshot (review X-1): a lib/db.cjs whitelisted isolation level, pinned by the
// transaction's first statement.
const CONSULT_SNAPSHOT_ISOLATION = 'repeatable read'

// Paging: the scoped helper clamps a page at 10000; the ceilings bound what one consult may hold in memory.
const READ_PAGE_SIZE = 1000
// `reviewedCell` (review fix N3-b): the register holds one row per reviewed (key, field) — at most the project's reviewed
// keys x the content-trigger fields; above the ceiling the consult is unreadable (503 row_cap), never "nothing reviewed".
const READ_CEILINGS = Object.freeze({ continuation: 5000, member: 20000, hold: 5000, state: 100, execution: 5000, changePlan: 100, reviewedCell: 100000 })
// Review fix N3-b: the register's UPSERT key (migration 104's uniq_integration_stock_prep_reviewed_cell) and what a later
// review of the same cell overwrites (never the scope columns, the row id or created_at).
const REVIEWED_CELL_CONFLICT_COLUMNS = Object.freeze(['sheet_id', 'project_no', 'record_key_digest', 'field_id'])
const REVIEWED_CELL_UPDATE_COLUMNS = Object.freeze(['record_id', 'reviewed_cell', 'change_plan_id', 'reviewed_at', 'updated_at'])
const NEWEST_EXECUTIONS = 5

class StockPreparationRefreshStoreError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationRefreshStoreError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function trimmed(value) {
  return nonBlankString(value) ? value.trim() : null
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function rowsOf(result) {
  if (Array.isArray(result)) return result
  return result && Array.isArray(result.rows) ? result.rows : []
}

function firstRow(result) {
  return rowsOf(result)[0] || null
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function intOrNull(value) {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) ? n : null
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

// JSONB comes back parsed from node-postgres; a text binding hands back a string.
function jsonOrNull(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return null }
  }
  return value
}

// Values-free: SQLSTATE only (five characters, a class code — never a message, never a value).
function sqlStateOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

function isUniqueViolation(error) {
  return Boolean(error && error.code === '23505')
}

function storeFailed(operation, error, extra = {}) {
  const sqlState = sqlStateOf(error)
  return new StockPreparationRefreshStoreError(
    503,
    REFRESH_STORE_ERROR_CODES.STORE_FAILED,
    'the stock-prep refresh store could not be read or written; nothing continued',
    { operation, ...(sqlState ? { sqlState } : {}), partial: false, ...extra },
  )
}

function inputInvalid(message, field, status = 500) {
  return new StockPreparationRefreshStoreError(status, REFRESH_STORE_ERROR_CODES.INPUT_INVALID, message, { field })
}

function scopeInvalid(field) {
  return new StockPreparationRefreshStoreError(422, REFRESH_STORE_ERROR_CODES.INPUT_INVALID, `${field} is required`, { field })
}

function tenantMismatch(table) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.TENANT_MISMATCH, 'a refresh-store row does not belong to the proven tenant; refusing', { table })
}

function stateMoved(reason) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.STATE_MOVED, 'the project\'s refresh state moved since it was read; preview again', { reason })
}

function confirmStale(reason) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CONFIRM_STALE, 'the hold being confirmed is no longer what the server computes; read the page again', { reason })
}

function confirmNotAllowed(reason, extra = {}) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CONFIRM_NOT_ALLOWED, 'this hold has no confirm control', { reason, ...extra })
}

function confirmConflict(error) {
  const sqlState = sqlStateOf(error)
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CONFIRM_CONFLICT, 'another confirmation already claims one of these rows or positions; preview again', {
    reason: 'claim_taken',
    ...(sqlState ? { sqlState } : {}),
    ...(error && typeof error.constraint === 'string' ? { constraint: error.constraint } : {}),
  })
}

function holdMalformed(reason) {
  return new StockPreparationRefreshStoreError(500, REFRESH_STORE_ERROR_CODES.HOLD_MALFORMED, 'the hold being confirmed does not carry what a continuation needs', { reason })
}

// An end outcome the relationship's current state does not admit (design §8.4, §9.3; review X-2 / X-3).
// Values-free: a closed reason token, the outcome token and, where it helps, the continuation's status token.
function endNotAdmissible(reason, outcome, extra = {}) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.END_OUTCOME_NOT_ADMISSIBLE, 'this end outcome is not admissible for the relationship as it stands; preview again', { reason, outcome, ...extra })
}

// O-22 inside the decision transaction (PR-4 review N3): the SAME rows the preview answers on and the apply's
// in-lease check refuses — every partial / failed / aborted execution and every `running` one. Decided AFTER the
// bump, so a `running` row of a LIVE lease has already been refused by the bump's WRITE_LOCKED (I2) and every
// `running` row seen here is a dead run. The same shape as the lanes' refusal (values-free: a count).
function recoveryPending(openExecutions) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.RECOVERY_PENDING, 'an earlier execution of this project did not finish cleanly; nothing is decided until it is recovered', {
    state: 'failed_pending_recovery',
    openExecutions,
    partial: false,
  })
}

// ── step 5 PR-8: the change plan's refusals (values-free: a closed reason token, counts) ─────────────────────────

// The change being confirmed / executed is no longer what the server computes: read the page (or preview) again.
function changePlanStale(reason, extra = {}) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CHANGE_PLAN_STALE, 'the change plan is no longer what the server computes; read the page again (or preview again)', { reason, partial: false, ...extra })
}

// Why a plan that is no longer `confirmed` cannot be planned / executed: replaced by a later confirm, already written
// (its controlled update ran), or invalidated.
function planStatusReason(status) {
  if (status === 'superseded') return 'plan_replaced'
  if (status === 'written' || status === 'reviewed') return 'plan_written'
  return 'plan_invalidated'
}

function changePlanNotAllowed(reason, extra = {}) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CHANGE_PLAN_NOT_ALLOWED, 'this change cannot be confirmed as a change plan', { reason, partial: false, ...extra })
}

// C07: a structure change anywhere on the project keeps the whole pull suspended; the content path cannot release it.
function structureChangePresent(holdCount) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT, 'a structure change is open on this project; a content change plan is not confirmed while it is', { holdCount, partial: false })
}

function reviewStale(reason, extra = {}) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CHANGE_REVIEW_STALE, 'the change being reviewed is no longer what the sheet holds; read the page again', { reason, partial: false, ...extra })
}

// C12: the review does not complete while anything else on the project is unfinished.
// PR-8 review fix N1 (the PR-4 rule: every admissibility fact under the lock). The combined confirm (design §10.3 (5))
// creates a relationship, which needs the pilot marker (register R-63 ⑤). The route's NOT_PILOT is the consult's
// picture; this re-decides it ON THE CONFIRM'S OWN HANDLE, after the state-row lock and before the bump: `pilotWithin`
// (the governance reader's `readPilotWithin` — PR B's registry projection run with `{ executor: trx }`, exactly as the
// consult runs it on its snapshot) answers `{ enabled }`. A marker cleared (or a row moved off this sheet) since the
// consult refuses 409 NOT_PILOT and the transaction rolls back with nothing written; an unwired read is 501 by name;
// a failed read throws (never "not pilot"). A plain read, no row lock: a pilot exit committing after it serialises as
// "the confirm happened first", and clearing the marker never releases what rows protect (D3).
async function assertPilotWithin(trx, pilotWithin) {
  if (typeof pilotWithin !== 'function') {
    throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'a combined change-plan confirm re-reads the pilot marker under the lock; the in-transaction pilot read is not wired', { reason: 'pilot_read_within' })
  }
  const pilot = await pilotWithin(trx)
  if (!isPlainObject(pilot) || pilot.enabled !== true) {
    throw new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.NOT_PILOT, 'this project is not a pilot of the batch refresh; a relationship cannot be confirmed for it', { decidedUnderLock: true, partial: false })
  }
}

function reviewBlocked(reason, extra = {}) {
  return new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.CHANGE_REVIEW_BLOCKED, 'something else on this project is still open; the review completes after it', { reason, partial: false, ...extra })
}

// The hold a release decides from (PR-4 review B1): the caller names the OPEN relationship_reconfirm hold it was
// shown (id + fingerprint); the transaction derives admissibility from the open row under the lock and refuses
// STALE `facts_moved` when that row is not the one named.
function normalizeFacts(input) {
  if (!isPlainObject(input)) throw inputInvalid('facts { holdId, holdFingerprint } are required for release_to_normal_refresh', 'facts', 400)
  if (!nonBlankString(input.holdId)) throw inputInvalid('facts.holdId is required', 'facts.holdId', 400)
  if (!nonBlankString(input.holdFingerprint)) throw inputInvalid('facts.holdFingerprint is required', 'facts.holdFingerprint', 400)
  return Object.freeze({ holdId: input.holdId.trim(), holdFingerprint: input.holdFingerprint.trim() })
}

// A typed error of this store passes through untouched; a database error becomes 503 (or the one 23505 mapping
// the caller names).
function translate(error, operation, { onUnique } = {}) {
  if (error instanceof StockPreparationRefreshStoreError) return error
  if (isUniqueViolation(error) && typeof onUnique === 'function') return onUnique(error)
  return storeFailed(operation, error)
}

function keyDigest(key) {
  return subjectDigest(key)
}

/**
 * Review X-3 / design §8.4 — RELATED: the two claim sets share at least one of the A08 claims migration 102's
 * partial unique indexes guard — an old record id (`old_record_id`, the header's `old_root_record_id` being the
 * root member's), an old key (`old_key_digest`) or a new position (`new_key_digest`, the header's
 * `new_root_key_digest` being the root member's). A candidate that shares NOTHING with the relationship it
 * names is refused `supersedes_unrelated`: ending that relationship would release a subtree's protection with
 * nothing put in its place. Relatedness is necessary, not sufficient — see `takeoverGaps`. Digests are
 * compared, never raw keys.
 */
function claimsOverlap(previousRow, previousMembers, candidateMembers) {
  const oldRecordIds = new Set([previousRow.old_root_record_id])
  const oldKeyDigests = new Set()
  const newKeyDigests = new Set([previousRow.new_root_key_digest])
  for (const member of previousMembers) {
    oldRecordIds.add(member.old_record_id)
    oldKeyDigests.add(member.old_key_digest)
    newKeyDigests.add(member.new_key_digest)
  }
  return candidateMembers.some((member) => oldRecordIds.has(member.oldRecordId)
    || oldKeyDigests.has(keyDigest(member.oldKey))
    || newKeyDigests.has(keyDigest(member.newKey)))
}

/**
 * Review round 2 (P1 on X-3) — FULL TAKEOVER, the phase-1 rule. A supersede ends EVERY claim of the old
 * relationship (`endRows`: the header and all its members) and leaves no hold behind, so whatever the replacing
 * continuation does not claim loses its protection on the spot: after a pilot exit the next plan sweeps those
 * old rows (the review's real-host repro — four old rows INACTIVE, the replacement covering two other rows at a
 * part of the old new positions). A supersede is therefore admissible only when the replacing continuation
 * claims the WHOLE old side of the relationship it ends:
 *   - every old record id it claims (`old_root_record_id` and every claim_active member's `old_record_id`) —
 *     the A08 claim, i.e. WHICH rows are protected; and
 *   - every old key digest it claims (every member's `old_key_digest`) — the planner's sweep protection is keyed
 *     on the OLD KEY (stock-preparation-continuation-pairing.cjs buildContinuationProjection
 *     `protectInactiveKeys` / `continuedRefFor`), i.e. HOW they are protected.
 * For rows as confirmed the two are 1:1 (the store writes both from one pair, and each is unique among a sheet's
 * active claims), so a genuine takeover covers both and the key check refuses nothing it needs; it fails closed
 * where the record check alone could drop a key-based protection (a covered record re-keyed since, a key shared
 * by duplicate rows). The NEW side need not be covered: a new position the replacement does not keep is merely no
 * longer suppressed — the planner may ADD a row there, but no old row loses protection. Answers the values-free
 * counts of uncovered old claims (0 / 0 = a full takeover).
 */
function takeoverGaps(previousRow, previousMembers, candidateMembers) {
  const candidateRecordIds = new Set(candidateMembers.map((member) => member.oldRecordId))
  const candidateKeyDigests = new Set(candidateMembers.map((member) => keyDigest(member.oldKey)))
  const previousRecordIds = new Set([previousRow.old_root_record_id])
  const previousKeyDigests = new Set()
  for (const member of previousMembers) {
    previousRecordIds.add(member.old_record_id)
    previousKeyDigests.add(member.old_key_digest)
  }
  let uncoveredOldRecords = 0
  for (const id of previousRecordIds) if (!candidateRecordIds.has(id)) uncoveredOldRecords += 1
  let uncoveredOldKeys = 0
  for (const digest of previousKeyDigests) if (!candidateKeyDigests.has(digest)) uncoveredOldKeys += 1
  return Object.freeze({ uncoveredOldRecords, uncoveredOldKeys })
}

function holdSetFingerprintOf(fingerprints) {
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) return null
  return sha256(`${SCHEMES.holdSet}\0${JSON.stringify(fingerprints.slice().sort())}`)
}

function parseKey(key) {
  if (!nonBlankString(key)) return null
  try {
    const parsed = JSON.parse(key)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.path) || !parsed.path.every(nonBlankString)) return null
    return parsed
  } catch {
    return null
  }
}

// ── projections (camelCase; exactly what the pure core and the state reader accept) ───────────────

function rowToContinuation(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    writeScopeKey: row.write_scope_key,
    status: row.status,
    statusReason: row.status_reason ?? null,
    revision: intOrNull(row.revision),
    oldRootRecordId: row.old_root_record_id,
    oldRootKey: row.old_root_key,
    oldRootComponentSourceId: row.old_root_component_source_id,
    newParentComponentSourceId: row.new_parent_component_source_id,
    newRootPathTokens: jsonOrNull(row.new_root_path_tokens),
    newRootKey: row.new_root_key,
    newRootKeyDigest: row.new_root_key_digest,
    parentEdgeUsage: numberOrNull(row.parent_edge_usage),
    externalSystemId: row.external_system_id,
    sourceScopeDigest: row.source_scope_digest,
    readPlanDigest: row.read_plan_digest,
    pairingFingerprint: row.pairing_fingerprint,
    comparisonFingerprint: row.comparison_fingerprint,
    evidenceFingerprint: row.evidence_fingerprint,
    evidenceHistoryStatus: row.evidence_history_status,
    evidenceSnapshot: jsonOrNull(row.evidence_snapshot),
    demandBasis: row.demand_basis,
    basisNote: row.basis_note ?? null,
    applicabilityScope: row.applicability_scope,
    confirmedBy: row.confirmed_by,
    confirmedAt: isoOrNull(row.confirmed_at),
    confirmedGeneration: intOrNull(row.confirmed_generation),
    confirmedGenerationToken: row.confirmed_generation_token,
    confirmedFencingEpoch: intOrNull(row.confirmed_fencing_epoch),
    executedExecutionId: row.executed_execution_id ?? null,
    lastVerifiedAt: isoOrNull(row.last_verified_at),
    lastVerdict: row.last_verdict ?? null,
    lastVerifiedGenerationToken: row.last_verified_generation_token ?? null,
    endedBy: row.ended_by ?? null,
    endedAt: isoOrNull(row.ended_at),
    endedOutcome: row.ended_outcome ?? null,
    endedNote: row.ended_note ?? null,
    claimActive: row.claim_active === true,
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  }
}

function rowToMember(row) {
  if (!row) return null
  return {
    id: row.id,
    continuationId: row.continuation_id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    position: intOrNull(row.position),
    relativePathTokens: jsonOrNull(row.relative_path_tokens),
    componentSourceId: row.component_source_id,
    oldRecordId: row.old_record_id,
    oldKey: row.old_key,
    oldKeyDigest: row.old_key_digest,
    newKey: row.new_key,
    newKeyDigest: row.new_key_digest,
    oldRowContentDigest: row.old_row_content_digest,
    claimActive: row.claim_active === true,
  }
}

function rowToHold(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    kind: row.kind,
    fingerprint: row.fingerprint,
    status: row.status,
    confirmable: row.confirmable === true,
    notConfirmableReason: row.not_confirmable_reason ?? null,
    shapeToken: row.shape_token ?? null,
    runbookOnly: row.runbook_only === true,
    continuationId: row.continuation_id ?? null,
    subject: jsonOrNull(row.subject),
    detail: jsonOrNull(row.detail),
    evidenceFingerprint: row.evidence_fingerprint ?? null,
    comparisonFingerprint: row.comparison_fingerprint ?? null,
    pairingFingerprint: row.pairing_fingerprint ?? null,
    openedAt: isoOrNull(row.opened_at),
    openedLane: row.opened_lane ?? null,
    openedGenerationToken: row.opened_generation_token ?? null,
    lastSeenAt: isoOrNull(row.last_seen_at),
    resolvedAt: isoOrNull(row.resolved_at),
    resolvedBy: row.resolved_by ?? null,
    resolution: row.resolution ?? null,
  }
}

function rowToState(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    version: intOrNull(row.version),
    decisionVersion: intOrNull(row.decision_version),
    governedSince: isoOrNull(row.governed_since),
    lastComputationAt: isoOrNull(row.last_computation_at),
    lastComputationLane: row.last_computation_lane ?? null,
    lastComputationGenerationToken: row.last_computation_generation_token ?? null,
    lastComputationSourceContentDigest: row.last_computation_source_content_digest ?? null,
    lastComputationSuspended: row.last_computation_suspended === null || row.last_computation_suspended === undefined ? null : row.last_computation_suspended === true,
    holdSetFingerprint: row.hold_set_fingerprint ?? null,
    settledAt: isoOrNull(row.settled_at),
    settledExecutionId: row.settled_execution_id ?? null,
    settledGenerationToken: row.settled_generation_token ?? null,
    settledSheetMachineDigest: row.settled_sheet_machine_digest ?? null,
    settledSourceContentDigest: row.settled_source_content_digest ?? null,
    reviewedContentDigest: row.reviewed_content_digest ?? null,
    reviewedAt: isoOrNull(row.reviewed_at),
    reviewedBy: row.reviewed_by ?? null,
  }
}

function rowToExecution(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    lane: row.lane,
    leaseRunId: row.lease_run_id,
    leaseId: row.lease_id,
    fencingEpoch: intOrNull(row.fencing_epoch),
    generation: intOrNull(row.generation),
    generationToken: row.generation_token,
    tokenRevision: row.token_revision,
    planDigest: row.plan_digest,
    plannedCounts: jsonOrNull(row.planned_counts),
    refreshBinding: jsonOrNull(row.refresh_binding),
    status: row.status,
    startedBy: row.started_by,
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    written: intOrNull(row.written),
    attemptedWrites: intOrNull(row.attempted_writes),
    counts: jsonOrNull(row.counts),
    abortCode: row.abort_code ?? null,
    errorCodes: jsonOrNull(row.error_codes),
    verifiedBy: row.verified_by ?? null,
    verifiedAt: isoOrNull(row.verified_at),
    verifiedResult: row.verified_result ?? null,
  }
}

function jsonArrayOf(value) {
  const parsed = jsonOrNull(value)
  return Array.isArray(parsed) ? parsed : []
}

// Step 5 PR-8: the FULL change-plan row (PRIVATE: `recordSet` and `reviewNotes` carry business values) — for the
// audited pull-tier read and the store's own transactions only.
function rowToChangePlan(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    status: row.status,
    planFingerprint: row.plan_fingerprint,
    sourceContentDigest: row.source_content_digest,
    plannedContentDigest: row.planned_content_digest,
    recordCount: intOrNull(row.record_count),
    writeRecordCount: intOrNull(row.write_record_count),
    recordSet: jsonArrayOf(row.record_set),
    absorbedChangePlanIds: jsonArrayOf(row.absorbed_change_plan_ids),
    holdIds: jsonArrayOf(row.hold_ids),
    holdSetFingerprint: row.hold_set_fingerprint,
    continuationIds: jsonArrayOf(row.continuation_ids),
    reviewBaselineDigest: row.review_baseline_digest,
    confirmedBy: row.confirmed_by,
    confirmedAt: isoOrNull(row.confirmed_at),
    confirmedGeneration: intOrNull(row.confirmed_generation),
    confirmedGenerationToken: row.confirmed_generation_token,
    confirmedFencingEpoch: intOrNull(row.confirmed_fencing_epoch),
    executionId: row.execution_id ?? null,
    writtenAt: isoOrNull(row.written_at),
    writtenContentDigest: row.written_content_digest ?? null,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: isoOrNull(row.reviewed_at),
    reviewConclusion: row.review_conclusion ?? null,
    reviewNotes: row.review_notes ?? null,
    reviewedContentDigest: row.reviewed_content_digest ?? null,
    invalidatedAt: isoOrNull(row.invalidated_at),
    invalidatedReason: row.invalidated_reason ?? null,
    supersededAt: isoOrNull(row.superseded_at),
    supersededBy: row.superseded_by ?? null,
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  }
}

// The record ids a plan WRITES (values-free handles): what the planner forces content detection on after a pilot exit
// (refutation M4) and what a summary may carry. Review-only fields are excluded.
function writeRecordIdsOf(recordSet) {
  const ids = new Set()
  for (const record of Array.isArray(recordSet) ? recordSet : []) {
    if (!isPlainObject(record) || !nonBlankString(record.recordId) || !isPlainObject(record.fields)) continue
    if (Object.values(record.fields).some((cell) => isPlainObject(cell) && cell.reviewOnly !== true)) ids.add(record.recordId)
  }
  return Array.from(ids).sort()
}

// Review fix N3 (plan §3.4 step 5 / C06 「复核前后再发生相关变化，旧复核不再有效，重新挂起」; design §10.3 (4)): the content
// the project's REVIEWS and its pending WRITTEN plan (at most one per sheet + project) left on the sheet —
// `[{ recordId, key, fields: { [fieldId]: { after, afterCanonical } } }]`, one entry per record KEY (round 2, N3-a),
// sorted by key. Round 2 (N3-b): the reviews are the REVIEWED-CELL REGISTER (`reviewedCellRows`, every cell any review
// bound, the latest review of a cell winning — never only the latest plan's cells); the written plan (newer than every
// review) wins per field; an entry's `recordId` is the record the newest of them bound under that key. PRIVATE values
// (the register's cells, the written plan's record set): server-held in the consult for the planner, which holds any
// such cell the sheet no longer carries (`reviewed_content_moved`) — never a response body, never an error detail.
function expectedContentOf(reviewedCellRows, writtenRows) {
  const byKey = new Map()
  const entryFor = (key, recordId) => {
    let entry = byKey.get(key)
    if (!entry) {
      entry = { recordId, key, fields: {} }
      byKey.set(key, entry)
    }
    entry.recordId = recordId
    return entry
  }
  const cellOf = (cell) => Object.freeze({
    after: cell.after === undefined ? null : cell.after,
    afterCanonical: cell.afterCanonical === undefined ? null : cell.afterCanonical,
  })
  // The register, oldest review first (ties by row id), so the newest review names the entry's record.
  const register = (Array.isArray(reviewedCellRows) ? reviewedCellRows : []).slice().sort((left, right) => {
    const at = (row) => (row && row.reviewed_at ? new Date(row.reviewed_at).getTime() : 0)
    return (at(left) - at(right)) || (String(left && left.id) < String(right && right.id) ? -1 : (String(left && left.id) > String(right && right.id) ? 1 : 0))
  })
  for (const row of register) {
    if (!isPlainObject(row) || !nonBlankString(row.record_key) || !nonBlankString(row.field_id) || !nonBlankString(row.record_id)) continue
    const cell = jsonOrNull(row.reviewed_cell)
    if (!isPlainObject(cell)) continue
    entryFor(row.record_key, row.record_id).fields[row.field_id] = cellOf(cell)
  }
  for (const row of writtenRows) {
    for (const record of jsonArrayOf(row && row.record_set)) {
      if (!isPlainObject(record) || !nonBlankString(record.recordId) || !nonBlankString(record.key) || !isPlainObject(record.fields)) continue
      const entry = entryFor(record.key, record.recordId)
      for (const [fieldId, cell] of Object.entries(record.fields)) {
        if (isPlainObject(cell)) entry.fields[fieldId] = cellOf(cell)
      }
    }
  }
  return Object.freeze(Array.from(byKey.values())
    .filter((entry) => Object.keys(entry.fields).length > 0)
    .sort((left, right) => (left.key < right.key ? -1 : (left.key > right.key ? 1 : 0)))
    .map((entry) => Object.freeze({ recordId: entry.recordId, key: entry.key, fields: Object.freeze(entry.fields) })))
}

// Review fix N3-b (round 2): the register rows ONE review writes — one per (record key, field) of the reviewed plan's
// record set, write AND review-only (absorbed) fields alike (the review bound every one of them). Only the record shapes
// the confirm writes (record id, key, fields) are taken.
function reviewedCellsOf(planRow) {
  const out = []
  for (const record of jsonArrayOf(planRow && planRow.record_set)) {
    if (!isPlainObject(record) || !nonBlankString(record.recordId) || !nonBlankString(record.key) || !isPlainObject(record.fields)) continue
    for (const [fieldId, cell] of Object.entries(record.fields)) {
      if (!isPlainObject(cell)) continue
      out.push({
        key: record.key,
        fieldId,
        recordId: record.recordId,
        cell: { after: cell.after === undefined ? null : cell.after, afterCanonical: cell.afterCanonical === undefined ? null : cell.afterCanonical },
      })
    }
  }
  return out
}

// The VALUES-FREE projection the consult answers (never `record_set`, never the notes): handles, closed tokens,
// digests, counts, server clocks — plus the scope triple the governance reader asserts (refutation m3).
function rowToChangePlanSummary(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    status: row.status,
    planFingerprint: row.plan_fingerprint,
    sourceContentDigest: row.source_content_digest,
    plannedContentDigest: row.planned_content_digest,
    recordCount: intOrNull(row.record_count),
    writeRecordCount: intOrNull(row.write_record_count),
    holdSetFingerprint: row.hold_set_fingerprint,
    continuationIds: Object.freeze(jsonArrayOf(row.continuation_ids).slice()),
    executionId: row.execution_id ?? null,
    writtenContentDigest: row.written_content_digest ?? null,
    reviewBaselineDigest: row.review_baseline_digest,
    confirmedBy: row.confirmed_by,
    confirmedAt: isoOrNull(row.confirmed_at),
    writtenAt: isoOrNull(row.written_at),
    recordIds: Object.freeze(writeRecordIdsOf(jsonArrayOf(row.record_set))),
    absorbedCount: jsonArrayOf(row.absorbed_change_plan_ids).length,
  })
}

// ── input validation ──────────────────────────────────────────────────────────────────────────────

function normalizeScope(input = {}) {
  const tenantId = trimmed(input.tenantId)
  const sheetId = trimmed(input.sheetId)
  const projectNo = trimmed(input.projectNo)
  if (!tenantId) throw scopeInvalid('tenantId')
  if (!sheetId) throw scopeInvalid('sheetId')
  if (!projectNo) throw scopeInvalid('projectNo')
  return Object.freeze({ tenantId, sheetId, projectNo, writeScopeKey: sheetWriteScopeKey(sheetId) })
}

function assertScopedRow(row, scope, table) {
  if (!row) return
  if (row.tenant_id !== scope.tenantId) throw tenantMismatch(table)
  if (row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) throw confirmStale(`${table}_scope`)
}

function normalizeSourceIdentity(input) {
  if (!isPlainObject(input) || !nonBlankString(input.externalSystemId) || !nonBlankString(input.sourceScopeDigest) || !nonBlankString(input.readPlanDigest)) {
    throw inputInvalid('sourceIdentity needs externalSystemId, sourceScopeDigest and readPlanDigest', 'sourceIdentity')
  }
  return Object.freeze({ externalSystemId: input.externalSystemId.trim(), sourceScopeDigest: input.sourceScopeDigest.trim(), readPlanDigest: input.readPlanDigest.trim() })
}

function normalizeBasis(input) {
  if (!isPlainObject(input) || !DEMAND_BASES.includes(input.kind)) throw inputInvalid('basis.kind must be a phase-1 demand basis token', 'basis.kind', 422)
  let note = null
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') throw inputInvalid('basis.note must be a string', 'basis.note', 422)
    if (CONTROL_CHARACTER_PATTERN.test(input.note)) throw inputInvalid('basis.note must not contain control characters', 'basis.note', 400)
    const text = input.note.trim()
    if (text.length > BASIS_NOTE_MAX_LENGTH) throw inputInvalid(`basis.note exceeds ${BASIS_NOTE_MAX_LENGTH} characters`, 'basis.note', 422)
    note = text || null
  }
  return Object.freeze({ kind: input.kind, note })
}

function normalizeEcho(input) {
  if (!isPlainObject(input)) throw inputInvalid('the echoed hold fingerprints are required', 'echo', 400)
  for (const field of ['holdFingerprint', 'comparisonFingerprint', 'evidenceFingerprint']) {
    if (!nonBlankString(input[field])) throw inputInvalid(`echo.${field} is required`, `echo.${field}`, 400)
  }
  return Object.freeze({
    holdFingerprint: input.holdFingerprint.trim(),
    comparisonFingerprint: input.comparisonFingerprint.trim(),
    evidenceFingerprint: input.evidenceFingerprint.trim(),
  })
}

function normalizeBump(bump) {
  if (!isPlainObject(bump) || !Number.isInteger(bump.generation) || bump.generation < 0
    || !nonBlankString(bump.generationToken) || !Number.isInteger(bump.fencingEpoch) || bump.fencingEpoch < 0) {
    throw inputInvalid('bumpWithin must answer { generation, generationToken, fencingEpoch }', 'bumpWithin')
  }
  return Object.freeze({ generation: bump.generation, generationToken: bump.generationToken, fencingEpoch: bump.fencingEpoch })
}

function requireBumpWithin(options) {
  if (!isPlainObject(options) || typeof options.bumpWithin !== 'function') {
    throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'a decision transaction needs the lock\'s in-transaction generation bump (bumpWithin); refusing to decide without it', { reason: 'bump_within_missing' })
  }
  return options.bumpWithin
}

// PR-8 review fix N1-b (round 2; the PR-4 rule — every admissibility fact under the lock): a candidate confirm ALWAYS
// creates a relationship, which needs the pilot marker. It re-reads it on its own transaction handle (`pilotWithin`, the
// governance reader's `readPilotWithin`), so the hook is required up front — unwired is 501 by name, before any statement.
function requirePilotWithin(options) {
  if (!isPlainObject(options) || typeof options.pilotWithin !== 'function') {
    throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'a relationship confirm re-reads the pilot marker under the lock; the in-transaction pilot read is not wired', { reason: 'pilot_read_within' })
  }
  return options.pilotWithin
}

function auditHookOf(options) {
  if (isPlainObject(options) && options.auditWithin !== undefined && options.auditWithin !== null && typeof options.auditWithin !== 'function') {
    throw inputInvalid('auditWithin must be a function when given', 'auditWithin')
  }
  return isPlainObject(options) && typeof options.auditWithin === 'function' ? options.auditWithin : null
}

// A hold as the pure core emits it (stock-preparation-continuation-pairing.cjs makeHold), validated for persistence.
function normalizeIncomingHold(hold, index) {
  const field = `holds[${index}]`
  if (!isPlainObject(hold)) throw inputInvalid('a hold must be an object', field)
  if (!HOLD_KINDS.includes(hold.kind)) throw inputInvalid('hold.kind is not a hold kind', `${field}.kind`)
  if (!nonBlankString(hold.fingerprint)) throw inputInvalid('hold.fingerprint is required', `${field}.fingerprint`)
  if (typeof hold.confirmable !== 'boolean') throw inputInvalid('hold.confirmable must be a boolean', `${field}.confirmable`)
  const reason = hold.notConfirmableReason === undefined ? null : hold.notConfirmableReason
  if (hold.confirmable === true && reason !== null) throw inputInvalid('a confirmable hold carries no notConfirmableReason', `${field}.notConfirmableReason`)
  if (hold.confirmable === false && !NOT_CONFIRMABLE_REASONS.includes(reason)) throw inputInvalid('a non-confirmable hold needs a notConfirmableReason token', `${field}.notConfirmableReason`)
  if (hold.shapeToken !== undefined && hold.shapeToken !== null && !SHAPE_TOKENS.includes(hold.shapeToken)) throw inputInvalid('hold.shapeToken is not a shape token', `${field}.shapeToken`)
  if (!isPlainObject(hold.subject)) throw inputInvalid('hold.subject must be an object', `${field}.subject`)
  // `detail` is NOT NULL in migration 103 and the pure core always emits an object: a null is a planner defect,
  // refused here (500) before any statement instead of reaching the DB as 23502 (which would read as 503).
  if (hold.detail === undefined || hold.detail === null) throw inputInvalid('hold.detail is required', `${field}.detail`)
  for (const name of ['evidenceFingerprint', 'comparisonFingerprint', 'pairingFingerprint', 'continuationId']) {
    if (hold[name] !== undefined && hold[name] !== null && !nonBlankString(hold[name])) throw inputInvalid(`hold.${name} must be a string when given`, `${field}.${name}`)
  }
  return Object.freeze({
    kind: hold.kind,
    fingerprint: hold.fingerprint,
    confirmable: hold.confirmable,
    notConfirmableReason: hold.confirmable ? null : reason,
    shapeToken: hold.shapeToken || null,
    continuationId: hold.continuationId || null,
    subject: hold.subject,
    detail: hold.detail,
    evidenceFingerprint: hold.evidenceFingerprint || null,
    comparisonFingerprint: hold.comparisonFingerprint || null,
    pairingFingerprint: hold.pairingFingerprint || null,
  })
}

function normalizeComputation(input) {
  if (!isPlainObject(input)) throw inputInvalid('computation is required', 'computation')
  if (!COMPUTATION_LANES.includes(input.lane)) throw inputInvalid('computation.lane is not a lane token', 'computation.lane')
  if (typeof input.suspended !== 'boolean') throw inputInvalid('computation.suspended must be a boolean', 'computation.suspended')
  for (const name of ['generationToken', 'sourceContentDigest']) {
    if (input[name] !== undefined && input[name] !== null && !nonBlankString(input[name])) throw inputInvalid(`computation.${name} must be a string when given`, `computation.${name}`)
  }
  return Object.freeze({
    lane: input.lane,
    suspended: input.suspended,
    generationToken: input.generationToken || null,
    sourceContentDigest: input.sourceContentDigest || null,
  })
}

function normalizeSettlement(input, { executionIdRequired = false } = {}) {
  if (input === undefined || input === null) return null
  if (!isPlainObject(input)) throw inputInvalid('settlement must be an object', 'settlement')
  if (!nonBlankString(input.sheetMachineDigest)) throw inputInvalid('settlement.sheetMachineDigest is required', 'settlement.sheetMachineDigest')
  for (const name of ['executionId', 'generationToken', 'sourceContentDigest']) {
    if (input[name] !== undefined && input[name] !== null && !nonBlankString(input[name])) throw inputInvalid(`settlement.${name} must be a string when given`, `settlement.${name}`)
  }
  if (executionIdRequired && !nonBlankString(input.executionId)) throw inputInvalid('settlement.executionId is required', 'settlement.executionId')
  return Object.freeze({
    executionId: input.executionId || null,
    generationToken: input.generationToken || null,
    sourceContentDigest: input.sourceContentDigest || null,
    sheetMachineDigest: input.sheetMachineDigest,
  })
}

function normalizeVerdicts(input) {
  if (input === undefined || input === null) return Object.freeze({})
  if (!isPlainObject(input)) throw inputInvalid('verdicts must be an object keyed by continuation id', 'verdicts')
  const out = {}
  for (const [id, verdict] of Object.entries(input)) {
    if (!nonBlankString(id)) throw inputInvalid('verdict keys are continuation ids', 'verdicts')
    if (!CONTINUATION_VERDICTS.includes(verdict)) throw inputInvalid('a verdict is not a verdict token', `verdicts.${id}`)
    out[id] = verdict
  }
  return Object.freeze(out)
}

// What a confirmable `continuation_candidate` hold must carry (design §6.6, pairing.cjs detectCandidates):
// the root pair at relative path [], the seven-item comparison per pair, the demand facts and the history
// status. Anything else is a server-side defect, never a puller error.
function continuationFactsFromHold(hold, scope) {
  const detail = hold.detail
  if (!isPlainObject(detail)) throw holdMalformed('detail_missing')
  if (!Array.isArray(detail.pairs) || detail.pairs.length === 0) throw holdMalformed('pairs_missing')
  const pairs = detail.pairs.map((pair, index) => {
    if (!isPlainObject(pair) || !Array.isArray(pair.relativePath) || !pair.relativePath.every(nonBlankString)
      || !nonBlankString(pair.componentSourceId) || !nonBlankString(pair.oldKey) || !nonBlankString(pair.newKey) || !nonBlankString(pair.oldRecordId)) {
      throw holdMalformed(`pair_${index}_malformed`)
    }
    return pair
  })
  const roots = pairs.filter((pair) => pair.relativePath.length === 0)
  if (roots.length !== 1) throw holdMalformed('root_pair_not_unique')
  const root = roots[0]
  const parsedNewRoot = parseKey(root.newKey)
  if (!parsedNewRoot) throw holdMalformed('new_root_key_unparsable')
  if (parsedNewRoot.projectNo !== scope.projectNo) throw holdMalformed('new_root_key_project_mismatch')
  if (parsedNewRoot.componentSourceId !== root.componentSourceId) throw holdMalformed('new_root_key_component_mismatch')
  if (!nonBlankString(parsedNewRoot.parentSourceId)) throw holdMalformed('new_root_key_parent_missing')
  if (!nonBlankString(detail.componentSourceId) || detail.componentSourceId !== root.componentSourceId) throw holdMalformed('component_mismatch')
  if (!isPlainObject(detail.comparison) || !Array.isArray(detail.comparison.items)) throw holdMalformed('comparison_missing')
  const itemsByPath = new Map()
  for (const item of detail.comparison.items) {
    if (!isPlainObject(item) || !Array.isArray(item.relativePath)) throw holdMalformed('comparison_item_malformed')
    itemsByPath.set(JSON.stringify(item.relativePath), item)
  }
  const sortedPairs = pairs.slice().sort((left, right) => {
    if (left.relativePath.length === 0) return -1
    if (right.relativePath.length === 0) return 1
    const a = JSON.stringify(left.relativePath)
    const b = JSON.stringify(right.relativePath)
    return a < b ? -1 : (a > b ? 1 : 0)
  })
  const seenPaths = new Set()
  const members = sortedPairs.map((pair, position) => {
    const pathKey = JSON.stringify(pair.relativePath)
    if (seenPaths.has(pathKey)) throw holdMalformed('relative_path_repeats')
    seenPaths.add(pathKey)
    const item = itemsByPath.get(pathKey)
    if (!item || !isPlainObject(item.fields)) throw holdMalformed(`comparison_item_missing_${position}`)
    const oldSide = {}
    for (const [field, cell] of Object.entries(item.fields)) {
      oldSide[field] = isPlainObject(cell) && cell.old !== undefined ? cell.old : null
    }
    return Object.freeze({
      position,
      relativePathTokens: pair.relativePath.slice(),
      componentSourceId: pair.componentSourceId,
      oldRecordId: pair.oldRecordId,
      oldKey: pair.oldKey,
      newKey: pair.newKey,
      oldRowContentDigest: sha256(canonicalJson({ scheme: SCHEMES.memberOldContent, relativePath: pair.relativePath, componentSourceId: pair.componentSourceId, old: oldSide })),
    })
  })
  const history = EVIDENCE_HISTORY_STATUSES.includes(detail.history) ? detail.history : 'history_unknown'
  const parentEdgeUsage = numberOrNull(detail.comparison.parentEdgeUsage)
  return Object.freeze({
    root,
    members,
    oldRootRecordId: root.oldRecordId,
    oldRootKey: root.oldKey,
    oldRootComponentSourceId: root.componentSourceId,
    newParentComponentSourceId: parsedNewRoot.parentSourceId,
    newRootPathTokens: parsedNewRoot.path.slice(),
    newRootKey: root.newKey,
    parentEdgeUsage,
    history,
    comparisonOutcome: typeof detail.comparison.outcome === 'string' ? detail.comparison.outcome : null,
    evidenceSnapshot: {
      scheme: SCHEMES.evidenceSnapshot,
      holdId: hold.id,
      holdFingerprint: hold.fingerprint,
      pairs: detail.pairs,
      comparison: detail.comparison,
      demand: detail.demand === undefined ? null : detail.demand,
      history,
    },
  })
}

// ── step 5 PR-8: change-plan inputs (a PULLER's request: 400; what the planner / lane hands over: 500) ────────

function normalizeNamedHolds(input) {
  if (!Array.isArray(input) || input.length === 0) throw inputInvalid('holds must name every open content hold as { id, fingerprint }', 'holds', 400)
  const out = new Map()
  input.forEach((entry, index) => {
    if (!isPlainObject(entry) || !nonBlankString(entry.id) || !nonBlankString(entry.fingerprint)) throw inputInvalid(`holds[${index}] needs { id, fingerprint }`, `holds[${index}]`, 400)
    const id = entry.id.trim()
    if (out.has(id)) throw inputInvalid('a hold is named twice', `holds[${index}]`, 400)
    out.set(id, entry.fingerprint.trim())
  })
  return out
}

function normalizeChangePlanEcho(input) {
  if (!isPlainObject(input)) throw inputInvalid('the echoed plan fingerprints are required', 'echo', 400)
  const out = {}
  for (const field of ['holdSetFingerprint', 'planFingerprint', 'sourceContentDigest']) {
    if (!nonBlankString(input[field])) throw inputInvalid(`echo.${field} is required`, `echo.${field}`, 400)
    out[field] = input[field].trim()
  }
  return Object.freeze(out)
}

// The combined confirm of a `candidate_content_differs` hold (design §10.3 (5)): the candidate it confirms (its
// pairing fingerprint, as the page showed it) and the demand basis — the continuation confirm's own inputs.
function normalizeCandidateDecisions(input) {
  const out = new Map()
  if (input === undefined || input === null) return out
  if (!Array.isArray(input)) throw inputInvalid('candidates must be an array', 'candidates', 400)
  input.forEach((entry, index) => {
    if (!isPlainObject(entry) || !nonBlankString(entry.holdId) || !nonBlankString(entry.candidateId)) throw inputInvalid(`candidates[${index}] needs { holdId, candidateId, basis }`, `candidates[${index}]`, 400)
    const holdId = entry.holdId.trim()
    if (out.has(holdId)) throw inputInvalid('a candidate is named twice', `candidates[${index}]`, 400)
    out.set(holdId, Object.freeze({ candidateId: entry.candidateId.trim(), basis: normalizeBasis(entry.basis) }))
  })
  return out
}

// What a computation hands the reconciliation about the confirmed plan it planned with (the lane's planner verdict).
function normalizeChangePlanVerdict(input) {
  if (input === undefined || input === null) return null
  if (!isPlainObject(input) || !nonBlankString(input.id) || !['matches', 'stale'].includes(input.verdict)) {
    throw inputInvalid('changePlan needs { id, verdict: matches | stale }', 'changePlan')
  }
  return Object.freeze({ id: input.id.trim(), verdict: input.verdict })
}

function templateFieldsOf(template) {
  return plannerInternals.fieldMapForTemplate(normalizeStockPreparationTemplate(template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE))
}

function normalizeReviewNotes(input) {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string') throw inputInvalid('notes must be a string', 'notes', 422)
  if (CONTROL_CHARACTER_PATTERN.test(input)) throw inputInvalid('notes must not contain control characters', 'notes', 400)
  const text = input.trim()
  if (text.length > REVIEW_NOTES_MAX_LENGTH) throw inputInvalid(`notes exceed ${REVIEW_NOTES_MAX_LENGTH} characters`, 'notes', 422)
  return text || null
}

// The post-change pair the planner recorded on a relationship / candidate content hold (C04 / C11): the comparison
// and evidence fingerprints the relationship verifies with ONCE the after-values are written — the stamp a confirm
// writes, so the re-preview neither re-raises the hold nor, after the write, asks for a reconfirmation.
function postChangeOf(hold) {
  const post = isPlainObject(hold.detail) ? hold.detail.postChange : null
  if (!isPlainObject(post) || !nonBlankString(post.comparisonFingerprint) || !nonBlankString(post.evidenceFingerprint)) throw holdMalformed('postchange_missing')
  return Object.freeze({ comparisonFingerprint: post.comparisonFingerprint, evidenceFingerprint: post.evidenceFingerprint })
}

// Absorb the UNREVIEWED fields of a superseded written plan into the plan being written (B1): every field the new plan
// does not WRITE enters it review-only — before = after = the value the older write left on the sheet, baseline = the
// last REVIEWED value (the older field's own baseline, else its before). Nothing written ever leaves review scope.
function absorbIntoRecordSet(recordSet, olderSet) {
  const byId = new Map(recordSet.map((record) => [record.recordId, { ...record, fields: { ...record.fields } }]))
  let absorbedFields = 0
  for (const older of Array.isArray(olderSet) ? olderSet : []) {
    if (!isPlainObject(older) || !nonBlankString(older.recordId) || !isPlainObject(older.fields)) continue
    for (const [fieldId, cell] of Object.entries(older.fields)) {
      if (!isPlainObject(cell)) continue
      const target = byId.get(older.recordId)
      if (target && isPlainObject(target.fields[fieldId])) continue
      const baseline = cell.baseline !== undefined ? cell.baseline : cell.before
      const absorbed = {
        before: cell.after === undefined ? null : cell.after,
        after: cell.after === undefined ? null : cell.after,
        afterCanonical: cell.afterCanonical === undefined ? null : cell.afterCanonical,
        baseline: baseline === undefined ? null : baseline,
        reviewOnly: true,
      }
      if (target) target.fields[fieldId] = absorbed
      else byId.set(older.recordId, { recordId: older.recordId, key: older.key, root: older.root === true, inContinuation: older.inContinuation || null, fields: { [fieldId]: absorbed } })
      absorbedFields += 1
    }
  }
  const out = Array.from(byId.values()).sort((left, right) => (left.recordId < right.recordId ? -1 : (left.recordId > right.recordId ? 1 : 0)))
  return { recordSet: out, absorbedFields }
}

// ── the store ─────────────────────────────────────────────────────────────────────────────────────

function createStockPreparationContinuationStore({ db, idGenerator, now } = {}) {
  if (!db || typeof db.select !== 'function' || typeof db.selectOne !== 'function' || typeof db.insertOne !== 'function'
    || typeof db.updateRow !== 'function' || typeof db.transaction !== 'function') {
    throw new Error('createStockPreparationContinuationStore: scoped db helper (select/selectOne/insertOne/updateRow/transaction) is required')
  }
  const clock = typeof now === 'function' ? now : () => new Date()
  const newId = typeof idGenerator === 'function'
    ? idGenerator
    : (kind) => (kind === 'execution' ? `exec_${crypto.randomUUID()}` : `${kind}_${crypto.randomBytes(16).toString('hex')}`)

  function requireTrx(trx) {
    if (!trx || typeof trx.selectOneForUpdate !== 'function' || typeof trx.insertOne !== 'function' || typeof trx.updateRow !== 'function'
      || typeof trx.select !== 'function' || typeof trx.selectOne !== 'function') {
      throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'the transaction handle must expose selectOneForUpdate, select, selectOne, insertOne and updateRow', { reason: 'transaction_handle' })
    }
    return trx
  }

  // Every page of a bounded read, in a stable order; a read that would exceed its ceiling is a failure.
  async function selectAll(handle, table, where, { orderBy = ['id', 'ASC'], ceiling, operation }) {
    const out = []
    let offset = 0
    for (;;) {
      let page
      try {
        page = rowsOf(await handle.select(table, { where, orderBy, limit: READ_PAGE_SIZE, offset }))
      } catch (error) {
        throw translate(error, operation)
      }
      out.push(...page)
      if (out.length > ceiling) throw storeFailed(operation, null, { reason: 'row_cap', ceiling })
      if (page.length < READ_PAGE_SIZE) return out
      offset += READ_PAGE_SIZE
    }
  }

  async function selectLimited(handle, table, options, operation) {
    try {
      return rowsOf(await handle.select(table, options))
    } catch (error) {
      throw translate(error, operation)
    }
  }

  function unionById(...lists) {
    const seen = new Map()
    for (const list of lists) {
      for (const row of list) if (row && !seen.has(row.id)) seen.set(row.id, row)
    }
    return Array.from(seen.values())
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────

  // The ONE consult snapshot (review X-1): a transaction handle that can pin its isolation level, pinned to
  // REPEATABLE READ by its FIRST statement. A handle that cannot pin is refused before it reads anything (501,
  // the pinLockProtocolIsolation posture of external-system-pointer-lock.cjs); a failed SET is 503.
  async function pinConsultSnapshot(rawTrx) {
    if (!rawTrx || typeof rawTrx.setTransactionIsolationLevel !== 'function' || typeof rawTrx.select !== 'function') {
      throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'the consult snapshot needs a transaction handle that can pin REPEATABLE READ; refusing to read the governance rows without it', { reason: 'snapshot_handle' })
    }
    try {
      await rawTrx.setTransactionIsolationLevel(CONSULT_SNAPSHOT_ISOLATION)
    } catch (error) {
      throw translate(error, 'read_snapshot')
    }
    return rawTrx
  }

  /**
   * Everything the governance consult needs, read by (tenant, project) AND by sheet (design §5.1 step 2-3):
   * rows that name THIS project on another sheet, or this sheet under another project / tenant, come back
   * too, so the reader can refuse (RETARGETED / TENANT_MISMATCH) instead of matching old rows to the
   * wrong target. Continuations: every status (ended rows still govern, D3). Members: claim_active only
   * (the projection's input). Holds: open only. Executions: the newest five plus every unfinished one.
   * Throws 503 on any failure — never an empty list.
   *
   * ONE CONSISTENT SNAPSHOT (review X-1). Every read runs in ONE db.transaction whose FIRST statement is
   * `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`, so the open holds, the continuations, their members and
   * the state row's `decision_version` (the CAS key `reconcileHolds` is handed back) are one point in time: a
   * decision that commits while the consult reads is either wholly visible (its new decision_version with its
   * rows) or wholly invisible (the old decision_version — and the reconciliation keyed on it is refused 409
   * STATE_MOVED). Without it the reads were independent autocommit statements and a confirm landing between the
   * hold reads and the state read re-opened the hold it had just resolved. Read-only: PostgreSQL never answers
   * a serialization failure to a REPEATABLE READ transaction that only reads.
   *
   * `options.readFirst(snapshot)` (optional) runs on the SAME handle right after the SET and before any step-4
   * read: the governance reader's registry reads (PR B's getPilotState / getPilotStateBySheetId with
   * `{ executor: snapshot }`). PostgreSQL takes a REPEATABLE READ snapshot at the transaction's first query, so
   * the registry row and every step-4 row come from one snapshot. Whatever it throws (the reader's typed
   * refusals) passes through unchanged and the transaction rolls back; its result is not part of this answer.
   */
  async function readGovernanceRows(input = {}, options = {}) {
    const scope = normalizeScope(input)
    const opts = options === undefined || options === null ? {} : options
    if (!isPlainObject(opts)) throw inputInvalid('options must be an object', 'options')
    if (opts.readFirst !== undefined && opts.readFirst !== null && typeof opts.readFirst !== 'function') {
      throw inputInvalid('readFirst must be a function when given', 'readFirst')
    }
    const readFirst = typeof opts.readFirst === 'function' ? opts.readFirst : null
    const T = REFRESH_STORE_TABLES
    const byProject = { tenant_id: scope.tenantId, project_no: scope.projectNo }
    const bySheetProject = { sheet_id: scope.sheetId, project_no: scope.projectNo }

    return db.transaction(async (rawTrx) => {
      const snapshot = await pinConsultSnapshot(rawTrx)
      if (readFirst) await readFirst(snapshot)

      const continuations = unionById(
        await selectAll(snapshot, T.continuation, byProject, { ceiling: READ_CEILINGS.continuation, operation: 'read_continuations' }),
        await selectAll(snapshot, T.continuation, { sheet_id: scope.sheetId }, { ceiling: READ_CEILINGS.continuation, operation: 'read_continuations' }),
      )
      const members = unionById(
        await selectAll(snapshot, T.member, { ...byProject, claim_active: true }, { ceiling: READ_CEILINGS.member, operation: 'read_members' }),
        await selectAll(snapshot, T.member, { sheet_id: scope.sheetId, claim_active: true }, { ceiling: READ_CEILINGS.member, operation: 'read_members' }),
      )
      const holds = unionById(
        await selectAll(snapshot, T.hold, { ...byProject, status: 'open' }, { ceiling: READ_CEILINGS.hold, operation: 'read_holds' }),
        await selectAll(snapshot, T.hold, { ...bySheetProject, status: 'open' }, { ceiling: READ_CEILINGS.hold, operation: 'read_holds' }),
      )
      const states = unionById(
        await selectAll(snapshot, T.state, byProject, { ceiling: READ_CEILINGS.state, operation: 'read_state' }),
        await selectAll(snapshot, T.state, bySheetProject, { ceiling: READ_CEILINGS.state, operation: 'read_state' }),
      )
      const executionLists = [
        await selectLimited(snapshot, T.execution, { where: bySheetProject, orderBy: ['started_at', 'DESC'], limit: NEWEST_EXECUTIONS }, 'read_executions'),
        await selectLimited(snapshot, T.execution, { where: byProject, orderBy: ['started_at', 'DESC'], limit: NEWEST_EXECUTIONS }, 'read_executions'),
      ]
      for (const status of UNFINISHED_EXECUTION_STATUSES) {
        executionLists.push(await selectAll(snapshot, T.execution, { ...bySheetProject, status }, { ceiling: READ_CEILINGS.execution, operation: 'read_executions' }))
        executionLists.push(await selectAll(snapshot, T.execution, { ...byProject, status }, { ceiling: READ_CEILINGS.execution, operation: 'read_executions' }))
      }
      const executions = unionById(...executionLists)
      // Step 5 PR-8 (O-19): the PENDING change plans — `confirmed` (awaiting its controlled update) and `written`
      // (awaiting review) — by (sheet, project) AND by (tenant, project), one read per status (equality WHERE only),
      // in the SAME snapshot. Values-free summaries: `record_set` / `review_notes` never leave the store in them (the
      // review fix N3 expected content below is the one private projection, for the planner).
      const changePlanLists = []
      for (const status of CHANGE_PLAN_PENDING_STATUSES) {
        changePlanLists.push(await selectAll(snapshot, T.changePlan, { ...bySheetProject, status }, { ceiling: READ_CEILINGS.changePlan, operation: 'read_change_plans' }))
        changePlanLists.push(await selectAll(snapshot, T.changePlan, { ...byProject, status }, { ceiling: READ_CEILINGS.changePlan, operation: 'read_change_plans' }))
      }
      const changePlans = unionById(...changePlanLists)
      // Review fix N3 (C06): the REVIEWED-CELL REGISTER of this sheet + project and the pending WRITTEN plan give the content
      // the sheet must still hold (`expectedContentOf`). Round 2 (N3-b, delta probe V8D-05): the register holds EVERY cell
      // any review bound (a later review of a cell overwrites it; superseded / invalidated plans never remove one) — not
      // only the latest reviewed plan's cells, so a cell an EARLIER plan reviewed stays protected after an unrelated later
      // review. Read in this snapshot ONLY once the state row says a review happened (only a review writes
      // `reviewed_content_digest`, in the same transaction as its register rows): a project never reviewed — and every
      // not-governed project — reads nothing new. Private values, server-held for the planner; the `changePlans`
      // summaries stay values-free.
      const reviewState = states.find((row) => row && row.sheet_id === scope.sheetId && row.project_no === scope.projectNo) || null
      const reviewed = Boolean(reviewState && nonBlankString(reviewState.reviewed_content_digest))
      const reviewedCells = reviewed
        ? await selectAll(snapshot, T.reviewedCell, bySheetProject, { ceiling: READ_CEILINGS.reviewedCell, operation: 'read_reviewed_cells' })
        : []
      if (reviewedCells.some((row) => row.tenant_id !== scope.tenantId)) throw tenantMismatch('reviewed_cell')
      const writtenPlans = changePlans.filter((row) => row.status === 'written' && row.sheet_id === scope.sheetId && row.project_no === scope.projectNo)
      return Object.freeze({
        ok: true,
        scope,
        continuations: continuations.map(rowToContinuation),
        members: members.map(rowToMember),
        holds: holds.map(rowToHold),
        states: states.map(rowToState),
        executions: executions.map(rowToExecution),
        changePlans: changePlans.map(rowToChangePlanSummary),
        expectedContent: expectedContentOf(reviewedCells, writtenPlans),
      })
    })
  }

  /**
   * Batch-refresh step 4 PR-6: does ANY step-4 row name this SHEET — the generic configured writers' half of the
   * governed predicate (lib/stock-preparation-governed-sheet-probe.cjs). A generic writer (the pipelines target
   * adapter, the C6 write-source, the ERP feedback writer) holds a sheet id and nothing else: no project number, no
   * proven project scope, no lease. So this reads BY SHEET only, four counts on the store's own db (autocommit; a
   * point-in-time existence check needs no snapshot), with the same row predicate the consult's `governed` uses
   * (design §5.1, governance `anyRows`):
   *   continuation  every status — an ENDED relationship still governs (D3);
   *   openHold      status 'open' only — a resolved / superseded hold does not;
   *   state         any refresh-state row;
   *   execution     any execution row (the consult always reads the newest five, so one row is enough to govern).
   * Members are not read: a member is inserted with its header in the confirm transaction and `claim_active` mirrors
   * the header's status (migration 102 CHECK), so a governing member implies a governing header on the same sheet.
   * Values-free answer: integers only. Throws 503 STORE_FAILED on any failure (never zero), 422 on a blank sheet
   * id, 501 when the binding cannot count.
   */
  async function readSheetGovernanceMarks(input = {}) {
    const sheetId = isPlainObject(input) ? trimmed(input.sheetId) : null
    if (!sheetId) throw scopeInvalid('sheetId')
    if (typeof db.countRows !== 'function') {
      throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'the refresh store binding cannot count rows; refusing to answer whether a sheet is governed', { reason: 'count_rows' })
    }
    const T = REFRESH_STORE_TABLES
    async function count(table, token, where) {
      let value
      try {
        value = await db.countRows(table, where)
      } catch (error) {
        throw storeFailed('read_sheet_governance_marks', error, { table: token })
      }
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isInteger(n) || n < 0) throw storeFailed('read_sheet_governance_marks', null, { table: token, reason: 'count_malformed' })
      return n
    }
    const continuation = await count(T.continuation, 'continuation', { sheet_id: sheetId })
    const openHold = await count(T.hold, 'refresh_hold', { sheet_id: sheetId, status: 'open' })
    const state = await count(T.state, 'refresh_state', { sheet_id: sheetId })
    const execution = await count(T.execution, 'refresh_execution', { sheet_id: sheetId })
    return Object.freeze({ ok: true, sheetId, continuation, openHold, state, execution })
  }

  /** One continuation with its members (every status; members claim_active or not), scoped. */
  async function readContinuation(input = {}) {
    const scope = normalizeScope(input)
    const continuationId = trimmed(input.continuationId)
    if (!continuationId) throw scopeInvalid('continuationId')
    let row
    try {
      row = await db.selectOne(REFRESH_STORE_TABLES.continuation, { id: continuationId })
    } catch (error) {
      throw translate(error, 'read_continuation')
    }
    if (!row) return null
    assertScopedRow(row, scope, 'continuation')
    const members = await selectAll(db, REFRESH_STORE_TABLES.member, { continuation_id: continuationId }, { orderBy: ['position', 'ASC'], ceiling: READ_CEILINGS.member, operation: 'read_members' })
    return Object.freeze({ continuation: rowToContinuation(row), members: members.map(rowToMember) })
  }

  /**
   * PR-5 (design §11, the directory's union count): the OPEN holds of one tenant, counted by project number.
   * One paged read of the open rows (ceiling READ_CEILINGS.hold), grouped in process; throws 503 on any
   * failure — never an empty map (the directory then answers `ledgerReady: false`, never zero).
   */
  async function countOpenHoldsByProjectNo(input = {}) {
    const tenantId = trimmed(input.tenantId)
    if (!tenantId) throw scopeInvalid('tenantId')
    const rows = await selectAll(db, REFRESH_STORE_TABLES.hold, { tenant_id: tenantId, status: 'open' }, { ceiling: READ_CEILINGS.hold, operation: 'count_open_holds' })
    const byProjectNo = new Map()
    for (const row of rows) {
      const projectNo = trimmed(row.project_no)
      if (!projectNo) continue
      byProjectNo.set(projectNo, (byProjectNo.get(projectNo) || 0) + 1)
    }
    return Object.freeze({ ok: true, byProjectNo })
  }

  /** One hold by id, scoped (any status). */
  async function readHold(input = {}) {
    const scope = normalizeScope(input)
    const holdId = trimmed(input.holdId)
    if (!holdId) throw scopeInvalid('holdId')
    let row
    try {
      row = await db.selectOne(REFRESH_STORE_TABLES.hold, { id: holdId })
    } catch (error) {
      throw translate(error, 'read_hold')
    }
    if (!row) return null
    assertScopedRow(row, scope, 'hold')
    return rowToHold(row)
  }

  /**
   * Step 5 PR-8: one change plan by id, scoped (any status), the FULL row (PRIVATE record set and notes) — for the
   * audited pull-tier read only. Another tenant's row is TENANT_MISMATCH and another sheet / project's row is
   * `change_plan_scope` (the decisions lib answers both as its 404, never an existence oracle).
   */
  async function readChangePlan(input = {}) {
    const scope = normalizeScope(input)
    const changePlanId = trimmed(input.changePlanId)
    if (!changePlanId) throw scopeInvalid('changePlanId')
    let row
    try {
      row = await db.selectOne(REFRESH_STORE_TABLES.changePlan, { id: changePlanId })
    } catch (error) {
      throw translate(error, 'read_change_plan')
    }
    if (!row) return null
    assertScopedRow(row, scope, 'change_plan')
    return rowToChangePlan(row)
  }

  // ── transaction building blocks ───────────────────────────────────────────────────────────────

  async function lockStateRow(trx, scope, { createIfAbsent = false, at }) {
    if (createIfAbsent) {
      if (typeof trx.upsertOne !== 'function') {
        throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'the transaction handle must expose upsertOne', { reason: 'transaction_handle' })
      }
      try {
        await trx.upsertOne(REFRESH_STORE_TABLES.state, {
          id: newId('rst'),
          tenant_id: scope.tenantId,
          sheet_id: scope.sheetId,
          project_no: scope.projectNo,
          write_scope_key: scope.writeScopeKey,
          governed_since: at,
          updated_at: at,
        }, { conflictColumns: ['sheet_id', 'project_no'], updateColumns: ['updated_at'] })
      } catch (error) {
        throw translate(error, 'state_upsert')
      }
    }
    let row
    try {
      row = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.state, { sheet_id: scope.sheetId, project_no: scope.projectNo })
    } catch (error) {
      throw translate(error, 'state_lock')
    }
    if (row && row.tenant_id !== scope.tenantId) throw tenantMismatch('state')
    return row
  }

  async function openHoldsOf(trx, scope) {
    return selectAll(trx, REFRESH_STORE_TABLES.hold, { sheet_id: scope.sheetId, project_no: scope.projectNo, status: 'open' }, { ceiling: READ_CEILINGS.hold, operation: 'read_holds' })
  }

  async function lockedHold(trx, scope, holdId) {
    let row
    try {
      row = await trx.selectOne(REFRESH_STORE_TABLES.hold, { id: holdId })
    } catch (error) {
      throw translate(error, 'hold_read')
    }
    if (!row) throw confirmStale('hold_absent')
    if (row.tenant_id !== scope.tenantId) throw tenantMismatch('hold')
    if (row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) throw confirmStale('hold_scope')
    if (row.status !== 'open') throw confirmStale('hold_not_open')
    return row
  }

  function assertEcho(row, echo) {
    if (row.fingerprint !== echo.holdFingerprint) throw confirmStale('hold_fingerprint')
    if (row.comparison_fingerprint !== echo.comparisonFingerprint) throw confirmStale('comparison_fingerprint')
    if (row.evidence_fingerprint !== echo.evidenceFingerprint) throw confirmStale('evidence_fingerprint')
  }

  async function resolveHold(trx, holdRow, { resolution, resolvedBy, at }) {
    let rows
    try {
      rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.hold, {
        status: 'resolved',
        resolution,
        resolved_at: at,
        resolved_by: resolvedBy,
        updated_at: at,
      }, { id: holdRow.id, status: 'open' }))
    } catch (error) {
      throw translate(error, 'hold_resolve')
    }
    if (rows.length !== 1) throw confirmStale('hold_moved')
    return rows[0]
  }

  // The state row after a DECISION: version + 1 AND decision_version + 1, hold_set_fingerprint recomputed
  // over the open holds that remain; CAS on the decision_version the transaction locked (defence in depth
  // under FOR UPDATE).
  async function advanceDecision(trx, scope, stateRow, at) {
    const open = await openHoldsOf(trx, scope)
    const decisionVersion = intOrNull(stateRow.decision_version) || 0
    let rows
    try {
      rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.state, {
        version: (intOrNull(stateRow.version) || 0) + 1,
        decision_version: decisionVersion + 1,
        hold_set_fingerprint: holdSetFingerprintOf(open.map((row) => row.fingerprint)),
        updated_at: at,
      }, { id: stateRow.id, decision_version: decisionVersion }))
    } catch (error) {
      throw translate(error, 'state_advance')
    }
    if (rows.length !== 1) throw stateMoved('decision_version')
    return rows[0]
  }

  async function runBump(trx, scope, reason, bumpWithin) {
    let bump
    try {
      bump = await bumpWithin(trx, scope.writeScopeKey, { reason, tenantId: scope.tenantId })
    } catch (error) {
      if (error instanceof StockPreparationRefreshStoreError) throw error
      // The lock's own typed refusals (WRITE_LOCKED, contention, STORE_FAILED) pass through unchanged.
      if (error && typeof error.code === 'string' && Number.isInteger(error.status)) throw error
      throw translate(error, 'bump')
    }
    return normalizeBump(bump)
  }

  async function runAudit(trx, auditWithin, event) {
    if (!auditWithin) return
    try {
      await auditWithin(trx, Object.freeze(event))
    } catch (error) {
      if (error instanceof StockPreparationRefreshStoreError) throw error
      if (error && typeof error.code === 'string' && Number.isInteger(error.status)) throw error
      throw translate(error, 'audit')
    }
  }

  // THE decision transaction (confirm / re-confirm / end). Every statement inside names its own operation; the
  // one untyped error that can still escape is the wrapper's own COMMIT (a deferred constraint, a connection
  // dropped at commit — PR-4 review P7): the rows are rolled back, and the caller answers 503 STORE_FAILED
  // `commit` instead of a generic 500. An error raised before the callback completed is not re-attributed.
  async function decisionTransaction(callback) {
    let callbackDone = false
    try {
      return await db.transaction(async (rawTrx) => {
        const result = await callback(rawTrx)
        callbackDone = true
        return result
      })
    } catch (error) {
      if (!callbackDone) throw error
      if (error instanceof StockPreparationRefreshStoreError) throw error
      if (error && typeof error.code === 'string' && Number.isInteger(error.status)) throw error
      throw translate(error, 'commit')
    }
  }

  // S25 under the state-row lock (PR-4 review N2): the project's OPEN runbook-only holds, re-read on the
  // transaction handle. An escalation that landed after the caller's consult is seen here.
  function runbookOnlyOf(openHolds) {
    return openHolds.filter((row) => row.runbook_only === true)
  }

  // O-22 under the lock (PR-4 review N3): the unfinished executions, read on the transaction handle AFTER the
  // bump (the consult's picture is the caller's pre-check; this is the one that counts). Mirrors
  // readGovernanceRows' per-status reads (the scoped helper's `where` is equality only).
  async function assertNoUnfinishedExecutionWithin(trx, scope) {
    let open = 0
    for (const status of UNFINISHED_EXECUTION_STATUSES) {
      const rows = await selectAll(trx, REFRESH_STORE_TABLES.execution, { sheet_id: scope.sheetId, project_no: scope.projectNo, status }, { ceiling: READ_CEILINGS.execution, operation: 'read_executions' })
      open += rows.length
    }
    if (open > 0) throw recoveryPending(open)
  }

  async function lockedContinuation(trx, scope, continuationId, { revision } = {}) {
    let row
    try {
      row = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.continuation, { id: continuationId })
    } catch (error) {
      throw translate(error, 'continuation_lock')
    }
    if (!row) throw confirmStale('continuation_absent')
    if (row.tenant_id !== scope.tenantId) throw tenantMismatch('continuation')
    if (row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) throw confirmStale('continuation_scope')
    if (row.claim_active !== true || row.status === 'ended') throw confirmStale('continuation_ended')
    if (revision !== undefined && intOrNull(row.revision) !== revision) throw confirmStale('continuation_revision')
    return row
  }

  async function endRows(trx, continuationRow, { outcome, endedBy, note, at }) {
    let rows
    try {
      rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.continuation, {
        status: 'ended',
        claim_active: false,
        ended_by: endedBy,
        ended_at: at,
        ended_outcome: outcome,
        ended_note: note,
        updated_at: at,
      }, { id: continuationRow.id, revision: intOrNull(continuationRow.revision), claim_active: true }))
    } catch (error) {
      throw translate(error, 'continuation_end')
    }
    if (rows.length !== 1) throw confirmStale('continuation_moved')
    try {
      await trx.updateRow(REFRESH_STORE_TABLES.member, { claim_active: false, updated_at: at }, { continuation_id: continuationRow.id, claim_active: true })
    } catch (error) {
      throw translate(error, 'member_end')
    }
    return rows[0]
  }

  // ── confirm (design §8.2) ─────────────────────────────────────────────────────────────────────

  /**
   * Confirm a `continuation_candidate` hold into an ACTIVE continuation (revision 1) with its members.
   * Refusals before any row moves: the hold must be open, of that kind, confirmable, and carry exactly the
   * echoed fingerprints (409 CONFIRM_STALE / CONFIRM_NOT_ALLOWED); a store failure is 503. In the
   * transaction: state FOR UPDATE -> hold re-read -> the registry's pilot marker re-read on this handle (PR-8 review fix
   * N1-b: `options.pilotWithin`, REQUIRED — unwired is 501 `pilot_read_within` before any statement; cleared => 409
   * NOT_PILOT, nothing written) -> [the named continuation FOR UPDATE, its claim_active
   * members read, refused 409 END_OUTCOME_NOT_ADMISSIBLE `supersedes_unrelated` when the claims share nothing
   * (claimsOverlap, review X-3) and `supersedes_incomplete` when the new claims do not cover every old record id
   * and old key digest of it (takeoverGaps, review round 2), then ended as superseded_by_new_confirmation] ->
   * the project's open holds re-read (S25: an OPEN runbook-only hold refuses 409 CONFIRM_NOT_ALLOWED
   * `runbook_only_hold_open` — the caller's consult-time check again, under the lock) -> bumpWithin -> the
   * unfinished executions re-read (O-22: any refuses 409 RECOVERY_PENDING; a running row of a live lease was the
   * bump's WRITE_LOCKED) -> INSERT header + members (23505 -> 409 CONFIRM_CONFLICT) -> hold resolved ->
   * decision_version + 1 -> auditWithin. A COMMIT that fails is 503 STORE_FAILED `commit`. Returns a values-free
   * summary.
   */
  async function confirmContinuation(input = {}, options = {}) {
    const scope = normalizeScope(input)
    const holdId = trimmed(input.holdId)
    if (!holdId) throw scopeInvalid('holdId')
    const confirmedBy = trimmed(input.confirmedBy)
    if (!confirmedBy) throw scopeInvalid('confirmedBy')
    const echo = normalizeEcho(input.echo)
    const basis = normalizeBasis(input.basis)
    const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity)
    const supersedes = input.supersedes === undefined || input.supersedes === null ? null : input.supersedes
    if (supersedes !== null && (!isPlainObject(supersedes) || !nonBlankString(supersedes.continuationId) || !Number.isInteger(supersedes.revision) || supersedes.revision < 1)) {
      throw inputInvalid('supersedes needs { continuationId, revision }', 'supersedes', 400)
    }
    const bumpWithin = requireBumpWithin(options)
    const pilotWithin = requirePilotWithin(options)
    const auditWithin = auditHookOf(options)
    const at = clock()

    return decisionTransaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw confirmStale('state_row_absent')
      const holdRow = await lockedHold(trx, scope, holdId)
      if (holdRow.kind !== 'continuation_candidate') throw confirmNotAllowed('kind', { kind: holdRow.kind })
      if (holdRow.confirmable !== true) throw confirmNotAllowed('not_confirmable', { kind: holdRow.kind, notConfirmableReason: holdRow.not_confirmable_reason || null })
      assertEcho(holdRow, echo)
      const hold = rowToHold(holdRow)
      const facts = continuationFactsFromHold(hold, scope)
      // PR-8 review fix N1-b (round 2): the pilot fact re-decided HERE — after the state-row lock, before any row moves and
      // before the bump. A marker cleared since the route's consult refuses 409 NOT_PILOT and rolls back with nothing
      // written (the route's consult-time NOT_PILOT is the fast, earlier picture). A plain read, no row lock: a pilot exit
      // committing after it serialises as "the confirm came first", and clearing the marker never releases what rows
      // protect (D3).
      await assertPilotWithin(trx, pilotWithin)

      let supersededId = null
      if (supersedes) {
        const previous = await lockedContinuation(trx, scope, supersedes.continuationId.trim(), { revision: supersedes.revision })
        // Review X-3 (§8.4) + round 2: a relationship may be superseded only by a confirmation that is related to it
        // (claimsOverlap) AND takes over its whole old side (takeoverGaps) — decided here, inside the transaction,
        // before the bump and before any row moves.
        const previousMembers = await selectAll(trx, REFRESH_STORE_TABLES.member, { continuation_id: previous.id, claim_active: true }, { orderBy: ['position', 'ASC'], ceiling: READ_CEILINGS.member, operation: 'read_members' })
        if (!claimsOverlap(previous, previousMembers, facts.members)) {
          throw endNotAdmissible('supersedes_unrelated', 'superseded_by_new_confirmation')
        }
        const gaps = takeoverGaps(previous, previousMembers, facts.members)
        if (gaps.uncoveredOldRecords > 0 || gaps.uncoveredOldKeys > 0) {
          throw endNotAdmissible('supersedes_incomplete', 'superseded_by_new_confirmation', { uncoveredOldRecords: gaps.uncoveredOldRecords, uncoveredOldKeys: gaps.uncoveredOldKeys })
        }
        await endRows(trx, previous, { outcome: 'superseded_by_new_confirmation', endedBy: confirmedBy, note: null, at })
        supersededId = previous.id
      }

      // S25 under the lock: the last read before the bump (PR-4 review N2).
      const runbookOpen = runbookOnlyOf(await openHoldsOf(trx, scope))
      if (runbookOpen.length > 0) throw confirmNotAllowed('runbook_only_hold_open', { holdCount: runbookOpen.length, partial: false })

      const bump = await runBump(trx, scope, BUMP_REASONS.confirm, bumpWithin)
      await assertNoUnfinishedExecutionWithin(trx, scope)

      const continuationId = newId('cont')
      const header = {
        id: continuationId,
        tenant_id: scope.tenantId,
        sheet_id: scope.sheetId,
        project_no: scope.projectNo,
        write_scope_key: scope.writeScopeKey,
        status: 'active',
        status_reason: null,
        revision: 1,
        old_root_record_id: facts.oldRootRecordId,
        old_root_key: facts.oldRootKey,
        old_root_component_source_id: facts.oldRootComponentSourceId,
        new_parent_component_source_id: facts.newParentComponentSourceId,
        new_root_path_tokens: facts.newRootPathTokens,
        new_root_key: facts.newRootKey,
        new_root_key_digest: keyDigest(facts.newRootKey),
        parent_edge_usage: facts.parentEdgeUsage,
        external_system_id: sourceIdentity.externalSystemId,
        source_scope_digest: sourceIdentity.sourceScopeDigest,
        read_plan_digest: sourceIdentity.readPlanDigest,
        pairing_fingerprint: hold.pairingFingerprint,
        comparison_fingerprint: hold.comparisonFingerprint,
        evidence_fingerprint: hold.evidenceFingerprint,
        evidence_history_status: facts.history,
        evidence_snapshot: facts.evidenceSnapshot,
        demand_basis: basis.kind,
        basis_note: basis.note,
        applicability_scope: 'this_project_this_position',
        confirmed_by: confirmedBy,
        confirmed_at: at,
        confirmed_generation: bump.generation,
        confirmed_generation_token: bump.generationToken,
        confirmed_fencing_epoch: bump.fencingEpoch,
        executed_execution_id: null,
        claim_active: true,
        created_at: at,
        updated_at: at,
      }
      if (!nonBlankString(header.pairing_fingerprint) || !nonBlankString(header.comparison_fingerprint) || !nonBlankString(header.evidence_fingerprint)) {
        throw holdMalformed('fingerprints_missing')
      }
      try {
        await trx.insertOne(REFRESH_STORE_TABLES.continuation, header)
      } catch (error) {
        throw translate(error, 'continuation_insert', { onUnique: confirmConflict })
      }
      const memberRows = facts.members.map((member) => ({
        id: newId('contm'),
        continuation_id: continuationId,
        tenant_id: scope.tenantId,
        sheet_id: scope.sheetId,
        project_no: scope.projectNo,
        write_scope_key: scope.writeScopeKey,
        position: member.position,
        relative_path_tokens: member.relativePathTokens,
        component_source_id: member.componentSourceId,
        old_record_id: member.oldRecordId,
        old_key: member.oldKey,
        old_key_digest: keyDigest(member.oldKey),
        new_key: member.newKey,
        new_key_digest: keyDigest(member.newKey),
        old_row_content_digest: member.oldRowContentDigest,
        claim_active: true,
        created_at: at,
        updated_at: at,
      }))
      try {
        if (typeof trx.insertMany === 'function') await trx.insertMany(REFRESH_STORE_TABLES.member, memberRows)
        else for (const row of memberRows) await trx.insertOne(REFRESH_STORE_TABLES.member, row)
      } catch (error) {
        throw translate(error, 'member_insert', { onUnique: confirmConflict })
      }

      await resolveHold(trx, holdRow, { resolution: 'continuation_confirmed', resolvedBy: confirmedBy, at })
      const state = await advanceDecision(trx, scope, stateRow, at)
      const event = {
        operation: 'continuation_confirmed',
        continuationId,
        holdId,
        revision: 1,
        memberCount: memberRows.length,
        comparisonOutcome: facts.comparisonOutcome,
        historyStatus: facts.history,
        supersededContinuationId: supersededId,
        generationToken: bump.generationToken,
      }
      await runAudit(trx, auditWithin, event)
      return Object.freeze({
        continuationId,
        revision: 1,
        memberCount: memberRows.length,
        holdId,
        supersededContinuationId: supersededId,
        generation: bump,
        decisionVersion: intOrNull(state.decision_version),
        state: 'confirmed_pending_execution',
        nextStep: 'preview_again',
      })
    })
  }

  // ── re-confirm (design §8.3) ──────────────────────────────────────────────────────────────────

  /**
   * `needs_reconfirmation -> active` by UPDATE in place (never a new INSERT: the partial unique claims of the
   * stale row still hold, A-M4): revision + 1, the hold's fingerprints and the current source identity,
   * `executed_execution_id` cleared (the new revision has not been consumed). Admissible only when the
   * continuation's status_reason is one of RECONFIRMABLE_REASONS AND the hold (`relationship_reconfirm`
   * about this continuation) is confirmable. S25 and O-22 are re-checked under the lock exactly as in
   * `confirmContinuation` (the open holds before the bump, the unfinished executions after it).
   */
  async function reconfirmContinuation(input = {}, options = {}) {
    const scope = normalizeScope(input)
    const continuationId = trimmed(input.continuationId)
    if (!continuationId) throw scopeInvalid('continuationId')
    if (!Number.isInteger(input.revision) || input.revision < 1) throw inputInvalid('revision must be a positive integer', 'revision', 400)
    const holdId = trimmed(input.holdId)
    if (!holdId) throw scopeInvalid('holdId')
    const confirmedBy = trimmed(input.confirmedBy)
    if (!confirmedBy) throw scopeInvalid('confirmedBy')
    const echo = normalizeEcho(input.echo)
    const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity)
    const bumpWithin = requireBumpWithin(options)
    const auditWithin = auditHookOf(options)
    const at = clock()

    return decisionTransaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw confirmStale('state_row_absent')
      const continuationRow = await lockedContinuation(trx, scope, continuationId, { revision: input.revision })
      if (continuationRow.status !== 'needs_reconfirmation') throw confirmNotAllowed('status', { status: continuationRow.status })
      if (!RECONFIRMABLE_REASONS.includes(continuationRow.status_reason)) throw confirmNotAllowed('reason', { statusReason: continuationRow.status_reason || null })
      const holdRow = await lockedHold(trx, scope, holdId)
      if (holdRow.kind !== 'relationship_reconfirm' || holdRow.continuation_id !== continuationId) throw confirmNotAllowed('kind', { kind: holdRow.kind })
      if (holdRow.confirmable !== true) throw confirmNotAllowed('not_confirmable', { kind: holdRow.kind, notConfirmableReason: holdRow.not_confirmable_reason || null })
      assertEcho(holdRow, echo)
      const hold = rowToHold(holdRow)
      if (!nonBlankString(hold.pairingFingerprint) || !nonBlankString(hold.comparisonFingerprint) || !nonBlankString(hold.evidenceFingerprint)) throw holdMalformed('fingerprints_missing')
      const detail = isPlainObject(hold.detail) ? hold.detail : {}
      const history = EVIDENCE_HISTORY_STATUSES.includes(detail.history) ? detail.history : 'history_unknown'

      // S25 under the lock: the last read before the bump (PR-4 review N2).
      const runbookOpen = runbookOnlyOf(await openHoldsOf(trx, scope))
      if (runbookOpen.length > 0) throw confirmNotAllowed('runbook_only_hold_open', { holdCount: runbookOpen.length, partial: false })

      const bump = await runBump(trx, scope, BUMP_REASONS.confirm, bumpWithin)
      await assertNoUnfinishedExecutionWithin(trx, scope)
      const nextRevision = intOrNull(continuationRow.revision) + 1
      let rows
      try {
        rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.continuation, {
          status: 'active',
          status_reason: null,
          revision: nextRevision,
          external_system_id: sourceIdentity.externalSystemId,
          source_scope_digest: sourceIdentity.sourceScopeDigest,
          read_plan_digest: sourceIdentity.readPlanDigest,
          pairing_fingerprint: hold.pairingFingerprint,
          comparison_fingerprint: hold.comparisonFingerprint,
          evidence_fingerprint: hold.evidenceFingerprint,
          evidence_history_status: history,
          evidence_snapshot: {
            scheme: SCHEMES.evidenceSnapshot,
            holdId,
            holdFingerprint: hold.fingerprint,
            pairs: detail.pairs === undefined ? null : detail.pairs,
            comparison: detail.comparison === undefined ? null : detail.comparison,
            demand: detail.demand === undefined ? null : detail.demand,
            history,
          },
          confirmed_by: confirmedBy,
          confirmed_at: at,
          confirmed_generation: bump.generation,
          confirmed_generation_token: bump.generationToken,
          confirmed_fencing_epoch: bump.fencingEpoch,
          executed_execution_id: null,
          updated_at: at,
        }, { id: continuationId, revision: intOrNull(continuationRow.revision), status: 'needs_reconfirmation', claim_active: true }))
      } catch (error) {
        throw translate(error, 'continuation_reconfirm')
      }
      if (rows.length !== 1) throw confirmStale('continuation_moved')
      await resolveHold(trx, holdRow, { resolution: 'continuation_confirmed', resolvedBy: confirmedBy, at })
      const state = await advanceDecision(trx, scope, stateRow, at)
      await runAudit(trx, auditWithin, {
        operation: 'continuation_reconfirmed',
        continuationId,
        holdId,
        revision: nextRevision,
        previousStatusReason: continuationRow.status_reason || null,
        generationToken: bump.generationToken,
      })
      return Object.freeze({
        continuationId,
        revision: nextRevision,
        holdId,
        generation: bump,
        decisionVersion: intOrNull(state.decision_version),
        state: 'confirmed_pending_execution',
        nextStep: 'preview_again',
      })
    })
  }

  // ── end (design §8.4) ─────────────────────────────────────────────────────────────────────────

  /**
   * End a continuation that NEEDS RECONFIRMATION with an explicit outcome (design §9.3: `needs_reconfirmation
   * -> ended` is the end transition; `active -> ended` exists only through a confirm's `supersedes`). An
   * ACTIVE continuation is refused 409 END_OUTCOME_NOT_ADMISSIBLE (reason `status`) whatever the outcome
   * (review X-2). `superseded_by_new_confirmation` is only ever written INSIDE a confirm (`supersedes`), never
   * here; `release_to_normal_refresh` is decided INSIDE the transaction from THE open `relationship_reconfirm`
   * hold naming this continuation, read under the state-row lock (PR-4 review B1 — the caller's consult is
   * never trusted for it): no such hold => `no_open_hold`; more than one => `facts_ambiguous` (a computation
   * emits one verification hold per relationship and supersedes the rest; only a seeded or corrupted store
   * has two); its recorded `detail.verdict` must be `new_position_removed` and the continuation's own
   * `last_verdict` too (`last_verdict`); `detail.componentNewPositionCount` must be an integer
   * (`facts_missing`) equal to 0 (`new_position_present`) — so an end can never produce "copies ADDed + old
   * rows swept". The caller names the hold it was shown (`facts: { holdId, holdFingerprint }`, required for a
   * release): a different open row — admissible or not — is 409 CONFIRM_STALE `facts_moved` (the confirm's echo
   * pattern). S25 is re-checked under the lock for a release (`runbook_only_hold_open`). `escalate_special_repair`
   * is admissible only while at least one OPEN hold names this continuation (reason `no_open_hold` otherwise),
   * and keeps every such hold OPEN as runbook-only (not confirmable): an open hold derives 待确认 and is never
   * superseded by a computation nor settled over, so nothing derives 已完成 / export-allowed until an
   * owner-approved runbook closes it. Every refusal is decided inside the transaction BEFORE the bump and before
   * any row moves; after the bump the unfinished executions are re-read (O-22, RECOVERY_PENDING).
   */
  async function endContinuation(input = {}, options = {}) {
    const scope = normalizeScope(input)
    const continuationId = trimmed(input.continuationId)
    if (!continuationId) throw scopeInvalid('continuationId')
    if (!Number.isInteger(input.revision) || input.revision < 1) throw inputInvalid('revision must be a positive integer', 'revision', 400)
    const endedBy = trimmed(input.endedBy)
    if (!endedBy) throw scopeInvalid('endedBy')
    if (!END_OUTCOMES.includes(input.outcome)) throw inputInvalid('outcome is not an end outcome', 'outcome', 400)
    if (input.outcome === 'superseded_by_new_confirmation') {
      throw new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.END_OUTCOME_NOT_ADMISSIBLE, 'superseded_by_new_confirmation is written only by the confirmation that replaces the relationship', { reason: 'outcome_confirm_only', outcome: input.outcome })
    }
    let note = null
    if (input.note !== undefined && input.note !== null) {
      if (typeof input.note !== 'string') throw inputInvalid('note must be a string', 'note', 422)
      if (CONTROL_CHARACTER_PATTERN.test(input.note)) throw inputInvalid('note must not contain control characters', 'note', 400)
      const text = input.note.trim()
      if (text.length > BASIS_NOTE_MAX_LENGTH) throw inputInvalid(`note exceeds ${BASIS_NOTE_MAX_LENGTH} characters`, 'note', 422)
      note = text || null
    }
    const release = input.outcome === 'release_to_normal_refresh'
    const facts = release ? normalizeFacts(input.facts) : null
    if (!release && input.facts !== undefined && input.facts !== null) throw inputInvalid('facts name the hold a release decides from; this outcome carries none', 'facts', 400)
    const bumpWithin = requireBumpWithin(options)
    const auditWithin = auditHookOf(options)
    const at = clock()

    return decisionTransaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw confirmStale('state_row_absent')
      const continuationRow = await lockedContinuation(trx, scope, continuationId, { revision: input.revision })
      // Review X-2 / §9.3: only a relationship that needs reconfirmation is ended here.
      if (continuationRow.status !== 'needs_reconfirmation') {
        throw endNotAdmissible('status', input.outcome, { status: continuationRow.status })
      }
      // The project's OPEN holds under the lock (one read): S25 for a release, and the continuation's own holds —
      // released -> resolved as continuation_ended; escalated -> kept open, runbook-only, never confirmable; a
      // computation never supersedes a runbook-only hold. Read BEFORE the bump: an escalation with no open hold
      // to keep would leave nothing suspending the project (review X-2).
      const openHolds = await openHoldsOf(trx, scope)
      const holdsAbout = openHolds.filter((row) => row.continuation_id === continuationId)
      if (release) {
        const runbookOpen = runbookOnlyOf(openHolds)
        if (runbookOpen.length > 0) throw endNotAdmissible('runbook_only_hold_open', input.outcome, { holdCount: runbookOpen.length, partial: false })
        // B1: the facts are THE open relationship_reconfirm row's, read here — never the caller's.
        const reconfirm = holdsAbout.filter((row) => row.kind === 'relationship_reconfirm')
        if (reconfirm.length === 0) throw endNotAdmissible('no_open_hold', input.outcome)
        if (reconfirm.length > 1) throw endNotAdmissible('facts_ambiguous', input.outcome, { holdCount: reconfirm.length })
        const factsRow = reconfirm[0]
        const detail = isPlainObject(factsRow.detail) ? factsRow.detail : {}
        if (detail.verdict !== 'new_position_removed' || continuationRow.last_verdict !== 'new_position_removed') {
          throw endNotAdmissible('last_verdict', input.outcome, { lastVerdict: continuationRow.last_verdict || null, recordedVerdict: nonBlankString(detail.verdict) ? detail.verdict : null })
        }
        if (!Number.isInteger(detail.componentNewPositionCount)) throw endNotAdmissible('facts_missing', input.outcome)
        if (detail.componentNewPositionCount !== 0) throw endNotAdmissible('new_position_present', input.outcome, { componentNewPositionCount: detail.componentNewPositionCount })
        // Admissible from the row as it is; now it must be the row the caller was shown.
        if (factsRow.id !== facts.holdId || factsRow.fingerprint !== facts.holdFingerprint) throw confirmStale('facts_moved')
      } else if (holdsAbout.length === 0) {
        throw endNotAdmissible('no_open_hold', input.outcome)
      }
      const bump = await runBump(trx, scope, BUMP_REASONS.end, bumpWithin)
      await assertNoUnfinishedExecutionWithin(trx, scope)
      await endRows(trx, continuationRow, { outcome: input.outcome, endedBy, note, at })

      let holdsResolved = 0
      let holdsEscalated = 0
      for (const holdRow of holdsAbout) {
        if (input.outcome === 'escalate_special_repair') {
          try {
            await trx.updateRow(REFRESH_STORE_TABLES.hold, {
              confirmable: false,
              not_confirmable_reason: 'specialist_repair',
              runbook_only: true,
              last_seen_at: at,
              updated_at: at,
            }, { id: holdRow.id, status: 'open' })
          } catch (error) {
            throw translate(error, 'hold_escalate')
          }
          holdsEscalated += 1
        } else {
          await resolveHold(trx, holdRow, { resolution: 'continuation_ended', resolvedBy: endedBy, at })
          holdsResolved += 1
        }
      }
      const state = await advanceDecision(trx, scope, stateRow, at)
      await runAudit(trx, auditWithin, {
        operation: 'continuation_ended',
        continuationId,
        revision: input.revision,
        endedOutcome: input.outcome,
        holdsResolved,
        holdsEscalated,
        generationToken: bump.generationToken,
      })
      return Object.freeze({
        continuationId,
        status: 'ended',
        endedOutcome: input.outcome,
        holdsResolved,
        holdsEscalated,
        generation: bump,
        decisionVersion: intOrNull(state.decision_version),
        nextStep: 'preview_again',
      })
    })
  }

  // ── step 5 PR-8: the change plan (design §10.3 (1), (4), (5); plan §3.4 steps 2 and 5) ─────────────────────

  // The project's plan rows of one status, read and then locked FOR UPDATE one by one in ascending id order. Callers
  // take `confirmed` rows before `written` rows (the finish does the same), so no two plan-locking transactions wait
  // on each other in a cycle.
  async function lockedPlansOf(trx, scope, status) {
    const rows = await selectAll(trx, REFRESH_STORE_TABLES.changePlan, { sheet_id: scope.sheetId, project_no: scope.projectNo, status }, { ceiling: READ_CEILINGS.changePlan, operation: 'read_change_plans' })
    const locked = []
    for (const row of rows.slice().sort((left, right) => (left.id < right.id ? -1 : (left.id > right.id ? 1 : 0)))) {
      let current
      try {
        current = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.changePlan, { id: row.id })
      } catch (error) {
        throw translate(error, 'change_plan_lock')
      }
      if (!current) continue
      if (current.tenant_id !== scope.tenantId) throw tenantMismatch('change_plan')
      if (current.status !== status) throw changePlanStale('plan_moved')
      locked.push(current)
    }
    return locked
  }

  // A relationship a change plan re-stamps, locked; the continuation store's own STALE reasons re-raised as the
  // change plan's (one vocabulary per route).
  async function lockedPlanContinuation(trx, scope, continuationId) {
    try {
      return await lockedContinuation(trx, scope, continuationId)
    } catch (error) {
      if (error instanceof StockPreparationRefreshStoreError && error.code === REFRESH_STORE_ERROR_CODES.CONFIRM_STALE) {
        throw changePlanStale('continuation_moved', { continuationReason: error.details && error.details.reason ? error.details.reason : null })
      }
      throw error
    }
  }

  // The combined confirm's relationship (design §10.3 (5), C11): exactly the continuation confirm's header + members,
  // stamped with the hold's POST-CHANGE fingerprints instead of its current ones — otherwise the relationship would
  // verify `evidence_changed` right after the controlled update writes the after-values.
  async function insertCombinedContinuation(trx, scope, { hold, facts, post, basis, sourceIdentity, confirmedBy, at, bump }) {
    const continuationId = newId('cont')
    if (!nonBlankString(hold.pairingFingerprint)) throw holdMalformed('fingerprints_missing')
    try {
      await trx.insertOne(REFRESH_STORE_TABLES.continuation, {
        id: continuationId,
        tenant_id: scope.tenantId,
        sheet_id: scope.sheetId,
        project_no: scope.projectNo,
        write_scope_key: scope.writeScopeKey,
        status: 'active',
        status_reason: null,
        revision: 1,
        old_root_record_id: facts.oldRootRecordId,
        old_root_key: facts.oldRootKey,
        old_root_component_source_id: facts.oldRootComponentSourceId,
        new_parent_component_source_id: facts.newParentComponentSourceId,
        new_root_path_tokens: facts.newRootPathTokens,
        new_root_key: facts.newRootKey,
        new_root_key_digest: keyDigest(facts.newRootKey),
        parent_edge_usage: facts.parentEdgeUsage,
        external_system_id: sourceIdentity.externalSystemId,
        source_scope_digest: sourceIdentity.sourceScopeDigest,
        read_plan_digest: sourceIdentity.readPlanDigest,
        pairing_fingerprint: hold.pairingFingerprint,
        comparison_fingerprint: post.comparisonFingerprint,
        evidence_fingerprint: post.evidenceFingerprint,
        evidence_history_status: facts.history,
        evidence_snapshot: facts.evidenceSnapshot,
        demand_basis: basis.kind,
        basis_note: basis.note,
        applicability_scope: 'this_project_this_position',
        confirmed_by: confirmedBy,
        confirmed_at: at,
        confirmed_generation: bump.generation,
        confirmed_generation_token: bump.generationToken,
        confirmed_fencing_epoch: bump.fencingEpoch,
        executed_execution_id: null,
        claim_active: true,
        created_at: at,
        updated_at: at,
      })
    } catch (error) {
      throw translate(error, 'continuation_insert', { onUnique: confirmConflict })
    }
    const memberRows = facts.members.map((member) => ({
      id: newId('contm'),
      continuation_id: continuationId,
      tenant_id: scope.tenantId,
      sheet_id: scope.sheetId,
      project_no: scope.projectNo,
      write_scope_key: scope.writeScopeKey,
      position: member.position,
      relative_path_tokens: member.relativePathTokens,
      component_source_id: member.componentSourceId,
      old_record_id: member.oldRecordId,
      old_key: member.oldKey,
      old_key_digest: keyDigest(member.oldKey),
      new_key: member.newKey,
      new_key_digest: keyDigest(member.newKey),
      old_row_content_digest: member.oldRowContentDigest,
      claim_active: true,
      created_at: at,
      updated_at: at,
    }))
    try {
      if (typeof trx.insertMany === 'function') await trx.insertMany(REFRESH_STORE_TABLES.member, memberRows)
      else for (const row of memberRows) await trx.insertOne(REFRESH_STORE_TABLES.member, row)
    } catch (error) {
      throw translate(error, 'member_insert', { onUnique: confirmConflict })
    }
    return { continuationId, memberCount: memberRows.length, oldRecordIds: facts.members.map((member) => member.oldRecordId) }
  }

  // C04 / plan §3.4 实施细则 3 「沿用行的内容变更在同一次变更计划确认中续接关系指纹」: the relationship keeps its pairing
  // and its demand; its comparison / evidence fingerprints become the POST-CHANGE pair, revision + 1, and its current
  // revision is unconsumed again (the controlled update's execution consumes it). A `needs_reconfirmation` relationship
  // whose only failing step is content (refutation M3; re-confirmable status reason checked by the caller) is
  // re-activated in the same statement, with the current source identity — exactly what a re-confirm writes.
  async function restampContinuation(trx, { row, post, reactivate, hold, sourceIdentity, confirmedBy, at, bump }) {
    const set = {
      comparison_fingerprint: post.comparisonFingerprint,
      evidence_fingerprint: post.evidenceFingerprint,
      revision: intOrNull(row.revision) + 1,
      confirmed_by: confirmedBy,
      confirmed_at: at,
      confirmed_generation: bump.generation,
      confirmed_generation_token: bump.generationToken,
      confirmed_fencing_epoch: bump.fencingEpoch,
      executed_execution_id: null,
      updated_at: at,
    }
    if (reactivate) {
      const detail = isPlainObject(hold.detail) ? hold.detail : {}
      const history = EVIDENCE_HISTORY_STATUSES.includes(detail.history) ? detail.history : 'history_unknown'
      Object.assign(set, {
        status: 'active',
        status_reason: null,
        external_system_id: sourceIdentity.externalSystemId,
        source_scope_digest: sourceIdentity.sourceScopeDigest,
        read_plan_digest: sourceIdentity.readPlanDigest,
        ...(nonBlankString(hold.pairingFingerprint) ? { pairing_fingerprint: hold.pairingFingerprint } : {}),
        evidence_history_status: history,
        evidence_snapshot: {
          scheme: SCHEMES.evidenceSnapshot,
          holdId: hold.id,
          holdFingerprint: hold.fingerprint,
          pairs: detail.pairs === undefined ? null : detail.pairs,
          comparison: detail.comparison === undefined ? null : detail.comparison,
          demand: detail.demand === undefined ? null : detail.demand,
          history,
        },
      })
    }
    let rows
    try {
      rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.continuation, set, { id: row.id, revision: intOrNull(row.revision), status: row.status, claim_active: true }))
    } catch (error) {
      throw translate(error, 'continuation_restamp')
    }
    if (rows.length !== 1) throw changePlanStale('continuation_moved')
    return rows[0]
  }

  /**
   * THE CHANGE-PLAN CONFIRM (design §10.3 (1) and (5); plan §3.4 step 2; register R-63 ②-⑤). The puller confirms the
   * WHOLE open content-class hold set as ONE plan, bound to the state row's hold-set fingerprint, the source content
   * digest of the computation that opened the holds and the plan fingerprint (the record set's before / after + that
   * digest). Every admissibility fact is decided HERE, under the state-row lock, from the rows (the PR-4 lesson —
   * the consult is a snapshot): state FOR UPDATE -> the echoed hold-set fingerprint / source digest -> the open holds
   * re-read (S25: any runbook-only hold refuses `runbook_only_hold_open`; C07: any structure-class hold refuses
   * STRUCTURE_CHANGE_PRESENT; the named set must be EXACTLY the open content-class set, each with its fingerprint) ->
   * the record set DERIVED from those rows and its fingerprint recomputed -> the combined candidates (pairing
   * fingerprint echoed, post-change pair present) and, when there is one, the registry's pilot marker re-read on this
   * handle (review fix N1: NOT_PILOT) -> every relationship a content hold names FOR UPDATE (active; or
   * needs_reconfirmation with a re-confirmable reason, M3) -> the pending plans FOR UPDATE (confirmed, then written) ->
   * `bumpWithin(change_plan_confirm)` -> the unfinished executions re-read (RECOVERY_PENDING) -> the combined
   * relationships INSERTED with the post-change stamps -> the named relationships re-stamped (revision + 1) -> the
   * confirmed plan superseded -> the plan INSERTED (review baselines carried from the written plan) -> the holds
   * resolved (`change_plan_confirmed`) -> decision_version + 1 -> `auditWithin`. A COMMIT failure is 503 `commit`.
   */
  async function confirmChangePlan(input = {}, options = {}) {
    const scope = normalizeScope(input)
    const confirmedBy = trimmed(input.confirmedBy)
    if (!confirmedBy) throw scopeInvalid('confirmedBy')
    const named = normalizeNamedHolds(input.holds)
    const echo = normalizeChangePlanEcho(input.echo)
    const candidates = normalizeCandidateDecisions(input.candidates)
    const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity)
    const templateFields = templateFieldsOf(input.template)
    const bumpWithin = requireBumpWithin(options)
    const auditWithin = auditHookOf(options)
    const at = clock()

    return decisionTransaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw changePlanStale('state_row_absent')
      if ((stateRow.hold_set_fingerprint ?? null) !== echo.holdSetFingerprint) throw changePlanStale('hold_set_moved')
      if ((stateRow.last_computation_source_content_digest ?? null) !== echo.sourceContentDigest) throw changePlanStale('source_moved')

      const openRows = await openHoldsOf(trx, scope)
      const runbookOpen = runbookOnlyOf(openRows)
      if (runbookOpen.length > 0) throw changePlanNotAllowed('runbook_only_hold_open', { holdCount: runbookOpen.length })
      const open = openRows.map(rowToHold)
      const structureOpen = open.filter(isStructureClassHold)
      if (structureOpen.length > 0) throw structureChangePresent(structureOpen.length)
      const content = open.filter(isContentClassHold)
      if (content.length === 0) throw changePlanStale('no_content_hold')
      if (content.length !== named.size || content.some((hold) => !named.has(hold.id))) {
        throw changePlanStale('hold_set_incomplete', { openContentHolds: content.length, named: named.size })
      }
      for (const hold of content) {
        if (hold.fingerprint !== named.get(hold.id)) throw changePlanStale('hold_fingerprint')
      }

      let records
      try {
        records = changePlanRecordsFromHolds(content)
      } catch (error) {
        const reason = error && error.details && typeof error.details.reason === 'string' ? error.details.reason : 'records_malformed'
        if (reason === 'record_unbound') throw changePlanNotAllowed('record_unbound')
        throw holdMalformed(reason)
      }
      if (records.length === 0) throw holdMalformed('no_change')
      if (records.length > CHANGE_PLAN_RECORD_CEILING) throw changePlanNotAllowed('too_many_records', { recordCount: records.length, ceiling: CHANGE_PLAN_RECORD_CEILING })
      if (changePlanFingerprintOf({ projectNo: scope.projectNo, records, sourceContentDigest: echo.sourceContentDigest }) !== echo.planFingerprint) {
        throw changePlanStale('plan_fingerprint')
      }

      // The combined confirm (§10.3 (5)): every open candidate content hold names its candidate decision.
      const candidateHolds = content.filter((hold) => hold.kind === 'candidate_content_differs')
      if (candidateHolds.length !== candidates.size || candidateHolds.some((hold) => !candidates.has(hold.id))) {
        throw changePlanStale('candidate_set', { openCandidates: candidateHolds.length, named: candidates.size })
      }
      const combined = candidateHolds.map((hold) => {
        const decision = candidates.get(hold.id)
        if ((hold.pairingFingerprint || null) !== decision.candidateId) throw changePlanStale('candidate')
        return { hold, decision, facts: continuationFactsFromHold(hold, scope), post: postChangeOf(hold) }
      })
      // PR-8 review fix N1: the combined confirm's pilot fact, re-decided HERE (after the state-row lock, before the bump).
      if (combined.length > 0) await assertPilotWithin(trx, options && options.pilotWithin)

      // The relationships a content hold names, locked in ascending id order (one verification hold per relationship).
      const relationshipHolds = content.filter((hold) => hold.kind === 'relationship_content_change' || hold.kind === 'relationship_reconfirm')
      const byContinuation = new Map()
      for (const hold of relationshipHolds) {
        if (!nonBlankString(hold.continuationId)) throw holdMalformed('continuation_missing')
        if (byContinuation.has(hold.continuationId)) throw holdMalformed('continuation_repeats')
        byContinuation.set(hold.continuationId, hold)
      }
      const restamps = []
      for (const continuationId of Array.from(byContinuation.keys()).sort()) {
        const hold = byContinuation.get(continuationId)
        const post = postChangeOf(hold)
        const row = await lockedPlanContinuation(trx, scope, continuationId)
        const reactivate = hold.kind === 'relationship_reconfirm'
        if (!reactivate && row.status !== 'active') throw changePlanStale('continuation_moved')
        if (reactivate) {
          if (row.status !== 'needs_reconfirmation') throw changePlanStale('continuation_moved')
          if (!RECONFIRMABLE_REASONS.includes(row.status_reason)) throw changePlanNotAllowed('reconfirm_not_admissible', { statusReason: row.status_reason || null })
        }
        restamps.push({ hold, row, post, reactivate })
      }

      // The pending plans, confirmed rows first, then written rows (the finish's order).
      const confirmedPlans = await lockedPlansOf(trx, scope, 'confirmed')
      const writtenPlans = await lockedPlansOf(trx, scope, 'written')

      const bump = await runBump(trx, scope, BUMP_REASONS.changePlan, bumpWithin)
      await assertNoUnfinishedExecutionWithin(trx, scope)

      const createdContinuations = []
      for (const entry of combined) {
        createdContinuations.push(await insertCombinedContinuation(trx, scope, { hold: entry.hold, facts: entry.facts, post: entry.post, basis: entry.decision.basis, sourceIdentity, confirmedBy, at, bump }))
      }
      for (const entry of restamps) {
        await restampContinuation(trx, { ...entry, sourceIdentity, confirmedBy, at, bump })
      }

      // The record set as stored: canonical after values (the review digest) and, for every field an earlier write
      // left unreviewed, the review baseline it carries (C06: the last REVIEWED value, never the intermediate).
      const changePlanId = newId('chp')
      const earlierById = new Map()
      for (const plan of writtenPlans) {
        for (const record of jsonArrayOf(plan.record_set)) if (isPlainObject(record) && nonBlankString(record.recordId)) earlierById.set(record.recordId, record)
      }
      const continuationOfOldRecord = new Map()
      for (const created of createdContinuations) for (const oldRecordId of created.oldRecordIds) continuationOfOldRecord.set(oldRecordId, created.continuationId)
      const recordSet = records.map((record) => {
        const earlier = earlierById.get(record.recordId)
        const fields = {}
        for (const [fieldId, cell] of Object.entries(record.fields)) {
          const earlierCell = earlier && isPlainObject(earlier.fields) && isPlainObject(earlier.fields[fieldId]) ? earlier.fields[fieldId] : null
          fields[fieldId] = {
            before: cell.before,
            after: cell.after,
            afterCanonical: canonicalChangeValue(cell.after, templateFields.get(fieldId)),
            ...(earlierCell ? { baseline: earlierCell.baseline !== undefined ? earlierCell.baseline : earlierCell.before } : {}),
          }
        }
        return {
          recordId: record.recordId,
          key: record.key,
          root: record.root === true,
          inContinuation: record.inContinuation || continuationOfOldRecord.get(record.recordId) || null,
          fields,
        }
      })

      let supersededCount = 0
      for (const plan of confirmedPlans) {
        let rows
        try {
          rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.changePlan, { status: 'superseded', superseded_at: at, superseded_by: changePlanId, updated_at: at }, { id: plan.id, status: 'confirmed' }))
        } catch (error) {
          throw translate(error, 'change_plan_supersede')
        }
        if (rows.length !== 1) throw changePlanStale('plan_moved')
        supersededCount += 1
      }

      const continuationIds = Array.from(new Set([...restamps.map((entry) => entry.row.id), ...createdContinuations.map((entry) => entry.continuationId)])).sort()
      const holdIds = content.map((hold) => hold.id).sort()
      try {
        await trx.insertOne(REFRESH_STORE_TABLES.changePlan, {
          id: changePlanId,
          tenant_id: scope.tenantId,
          sheet_id: scope.sheetId,
          project_no: scope.projectNo,
          write_scope_key: scope.writeScopeKey,
          status: 'confirmed',
          plan_fingerprint: echo.planFingerprint,
          source_content_digest: echo.sourceContentDigest,
          planned_content_digest: plannedContentDigestOf(recordSet),
          record_count: recordSet.length,
          write_record_count: recordSet.length,
          record_set: recordSet,
          absorbed_change_plan_ids: [],
          hold_ids: holdIds,
          hold_set_fingerprint: echo.holdSetFingerprint,
          continuation_ids: continuationIds,
          review_baseline_digest: nonBlankString(stateRow.reviewed_content_digest) ? stateRow.reviewed_content_digest : 'none',
          confirmed_by: confirmedBy,
          confirmed_at: at,
          confirmed_generation: bump.generation,
          confirmed_generation_token: bump.generationToken,
          confirmed_fencing_epoch: bump.fencingEpoch,
          created_at: at,
          updated_at: at,
        })
      } catch (error) {
        throw translate(error, 'change_plan_insert', { onUnique: confirmConflict })
      }

      const openById = new Map(openRows.map((row) => [row.id, row]))
      for (const hold of content) await resolveHold(trx, openById.get(hold.id), { resolution: 'change_plan_confirmed', resolvedBy: confirmedBy, at })
      const state = await advanceDecision(trx, scope, stateRow, at)
      await runAudit(trx, auditWithin, {
        operation: 'change_plan_confirmed',
        changePlanId,
        recordCount: recordSet.length,
        holdCount: holdIds.length,
        continuationCount: continuationIds.length,
        createdContinuationCount: createdContinuations.length,
        supersededCount,
        generationToken: bump.generationToken,
      })
      return Object.freeze({
        changePlanId,
        recordCount: recordSet.length,
        holdCount: holdIds.length,
        continuationIds: Object.freeze(continuationIds),
        createdContinuationIds: Object.freeze(createdContinuations.map((entry) => entry.continuationId)),
        supersededCount,
        generation: bump,
        decisionVersion: intOrNull(state.decision_version),
        state: 'confirmed_pending_execution',
        nextStep: 'preview_again',
      })
    })
  }

  /**
   * THE REVIEW (design §10.3 (4); plan §3.4 step 5; C05 / C06 / C11 / C12; register R-63 ⑦). Binds the `written` plan to
   * the content the sheet holds NOW: `currentContentDigest` is what the caller computed from its audited sheet read
   * (under `assertNoLiveWriter`), `echoDigest` what the reviewer's page showed — both must equal the plan's
   * `written_content_digest`. Under the state-row lock: the plan FOR UPDATE (still `written`), the digests, no OTHER open
   * hold (C12: `hold_open`), no confirmed plan awaiting its update (`change_plan_pending` — its baselines were carried
   * from this plan), no unfinished execution (RECOVERY_PENDING) -> the plan `reviewed` -> the state's
   * reviewed_content_digest / reviewed_at / reviewed_by, decision_version + 1 (NO generation bump: nothing written
   * changes) -> `auditWithin`. The same principal may review what they confirmed — a separate operation (C11).
   */
  async function completeChangeReview(input = {}, options = {}) {
    const scope = normalizeScope(input)
    const changePlanId = trimmed(input.changePlanId)
    if (!changePlanId) throw scopeInvalid('changePlanId')
    const reviewedBy = trimmed(input.reviewedBy)
    if (!reviewedBy) throw scopeInvalid('reviewedBy')
    if (!nonBlankString(input.echoDigest)) throw inputInvalid('the reviewed content digest is required', 'contentDigest', 400)
    if (!nonBlankString(input.currentContentDigest)) throw inputInvalid('the current content digest is required', 'currentContentDigest')
    if (!REVIEW_CONCLUSIONS.includes(input.conclusion)) throw inputInvalid('conclusion is not a review conclusion', 'conclusion', 400)
    const notes = normalizeReviewNotes(input.notes)
    if (input.conclusion === 'handled_with_notes' && !notes) throw inputInvalid('a review with notes needs the notes', 'notes', 400)
    const echoDigest = input.echoDigest.trim()
    const currentContentDigest = input.currentContentDigest.trim()
    const auditWithin = auditHookOf(options)
    const at = clock()

    return decisionTransaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw reviewStale('state_row_absent')
      let plan
      try {
        plan = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.changePlan, { id: changePlanId })
      } catch (error) {
        throw translate(error, 'change_plan_lock')
      }
      if (!plan) throw reviewStale('plan_absent')
      if (plan.tenant_id !== scope.tenantId) throw tenantMismatch('change_plan')
      if (plan.sheet_id !== scope.sheetId || plan.project_no !== scope.projectNo) throw reviewStale('plan_scope')
      if (plan.status !== 'written') {
        throw reviewStale(plan.status === 'superseded' ? 'plan_replaced' : (plan.status === 'reviewed' ? 'already_reviewed' : 'not_written'), { status: plan.status })
      }
      if (plan.written_content_digest !== echoDigest) throw reviewStale('echo_moved')
      if (echoDigest !== currentContentDigest) throw reviewStale('content_moved')
      const open = await openHoldsOf(trx, scope)
      if (open.length > 0) throw reviewBlocked('hold_open', { holdCount: open.length })
      const confirmed = await selectAll(trx, REFRESH_STORE_TABLES.changePlan, { sheet_id: scope.sheetId, project_no: scope.projectNo, status: 'confirmed' }, { ceiling: READ_CEILINGS.changePlan, operation: 'read_change_plans' })
      if (confirmed.length > 0) throw reviewBlocked('change_plan_pending', { pendingPlans: confirmed.length })
      await assertNoUnfinishedExecutionWithin(trx, scope)

      let rows
      try {
        rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.changePlan, {
          status: 'reviewed',
          reviewed_by: reviewedBy,
          reviewed_at: at,
          review_conclusion: input.conclusion,
          review_notes: notes,
          reviewed_content_digest: echoDigest,
          updated_at: at,
        }, { id: plan.id, status: 'written' }))
      } catch (error) {
        throw translate(error, 'change_plan_review')
      }
      if (rows.length !== 1) throw reviewStale('plan_moved')
      // Review fix N3-b (round 2): every cell this review binds enters the REVIEWED-CELL REGISTER (one UPSERT per record key
      // + field; a later review of the cell overwrites it, nothing removes it) — on this handle, under the state-row lock,
      // so the register and `reviewed_content_digest` (the consult's read gate) commit together or not at all.
      for (const entry of reviewedCellsOf(plan)) {
        try {
          await trx.upsertOne(REFRESH_STORE_TABLES.reviewedCell, {
            id: newId('rcell'),
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            write_scope_key: scope.writeScopeKey,
            record_key: entry.key,
            record_key_digest: keyDigest(entry.key),
            field_id: entry.fieldId,
            record_id: entry.recordId,
            reviewed_cell: entry.cell,
            change_plan_id: plan.id,
            reviewed_at: at,
            created_at: at,
            updated_at: at,
          }, { conflictColumns: REVIEWED_CELL_CONFLICT_COLUMNS, updateColumns: REVIEWED_CELL_UPDATE_COLUMNS })
        } catch (error) {
          throw translate(error, 'reviewed_cell_upsert')
        }
      }
      const decisionVersion = intOrNull(stateRow.decision_version) || 0
      let stateRows
      try {
        stateRows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.state, {
          version: (intOrNull(stateRow.version) || 0) + 1,
          decision_version: decisionVersion + 1,
          reviewed_content_digest: echoDigest,
          reviewed_at: at,
          reviewed_by: reviewedBy,
          updated_at: at,
        }, { id: stateRow.id, decision_version: decisionVersion }))
      } catch (error) {
        throw translate(error, 'state_review')
      }
      if (stateRows.length !== 1) throw stateMoved('decision_version')
      await runAudit(trx, auditWithin, {
        operation: 'change_review_completed',
        changePlanId: plan.id,
        recordCount: intOrNull(plan.record_count),
        conclusion: input.conclusion,
        notesPresent: notes !== null,
        sameActorAsConfirm: plan.confirmed_by === reviewedBy,
      })
      return Object.freeze({
        changePlanId: plan.id,
        status: 'reviewed',
        recordCount: intOrNull(plan.record_count),
        reviewedContentDigest: echoDigest,
        decisionVersion: intOrNull(stateRows[0].decision_version),
        nextStep: 'preview_again',
      })
    })
  }

  // ── hold reconciliation (design §8.4) ─────────────────────────────────────────────────────────

  /**
   * Persist what ONE computation of a governed project found. `decisionVersionObserved` is the state row's
   * decision_version the consult answered (0 when it answered no row): a different value now means a
   * decision landed in between -> 409 STATE_MOVED and NOTHING is persisted. `holds` are the computation's
   * holds (pure-core shape; [] for a clean computation); `verdicts` the continuation verification results;
   * `settlement` only for a clean computation with zero pending decisions (§9.2). Never bumps
   * decision_version. A store failure is 503: a computation never answers "clean" with an unrecorded state.
   */
  async function reconcileHolds(input = {}, options = {}) {
    const scope = normalizeScope(input)
    const observed = input.decisionVersionObserved === undefined || input.decisionVersionObserved === null ? 0 : input.decisionVersionObserved
    if (!Number.isInteger(observed) || observed < 0) throw inputInvalid('decisionVersionObserved must be a non-negative integer', 'decisionVersionObserved')
    if (!Array.isArray(input.holds)) throw inputInvalid('holds must be an array', 'holds')
    const incoming = input.holds.map(normalizeIncomingHold)
    const fingerprints = new Set()
    for (const hold of incoming) {
      if (fingerprints.has(hold.fingerprint)) throw inputInvalid('two holds of one computation share a fingerprint', 'holds')
      fingerprints.add(hold.fingerprint)
    }
    const computation = normalizeComputation(input.computation)
    const verdicts = normalizeVerdicts(input.verdicts)
    const settlement = normalizeSettlement(input.settlement)
    if (settlement && (incoming.length > 0 || computation.suspended)) throw inputInvalid('a settlement needs a clean computation (no holds, not suspended)', 'settlement')
    // Step 5 PR-8: the computation's verdict on the CONFIRMED change plan it planned with (null when none).
    const changePlan = normalizeChangePlanVerdict(input.changePlan)
    const auditWithin = auditHookOf(options)
    const at = clock()

    return db.transaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { createIfAbsent: true, at })
      if (!stateRow) throw storeFailed('state_lock', null, { reason: 'state_row_absent_after_upsert' })
      if (intOrNull(stateRow.decision_version) !== observed) throw stateMoved('decision_version')

      const open = await openHoldsOf(trx, scope)
      const openByFingerprint = new Map(open.map((row) => [row.fingerprint, row]))
      let kept = 0
      let opened = 0
      let superseded = 0
      for (const hold of incoming) {
        const existing = openByFingerprint.get(hold.fingerprint)
        if (existing) {
          try {
            // PR-8 (M2): a kind whose body carries per-computation observations outside its fingerprint (the record
            // version, the human-column presence of a content change) gets them refreshed; every other body is
            // byte-identical by fingerprint and is left as stored.
            await trx.updateRow(REFRESH_STORE_TABLES.hold, {
              last_seen_at: at,
              updated_at: at,
              ...(VOLATILE_DETAIL_KEYS[hold.kind] ? { detail: hold.detail } : {}),
            }, { id: existing.id, status: 'open' })
          } catch (error) {
            throw translate(error, 'hold_keep')
          }
          kept += 1
          continue
        }
        try {
          await trx.insertOne(REFRESH_STORE_TABLES.hold, {
            id: newId('hold'),
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            write_scope_key: scope.writeScopeKey,
            kind: hold.kind,
            fingerprint: hold.fingerprint,
            status: 'open',
            confirmable: hold.confirmable,
            not_confirmable_reason: hold.notConfirmableReason,
            shape_token: hold.shapeToken,
            runbook_only: false,
            continuation_id: hold.continuationId,
            subject: hold.subject,
            detail: hold.detail,
            evidence_fingerprint: hold.evidenceFingerprint,
            comparison_fingerprint: hold.comparisonFingerprint,
            pairing_fingerprint: hold.pairingFingerprint,
            opened_at: at,
            opened_lane: computation.lane,
            opened_generation_token: computation.generationToken,
            last_seen_at: at,
            created_at: at,
            updated_at: at,
          })
        } catch (error) {
          // The open-hold unique index: a reconciliation that did not hold the state row raced us.
          throw translate(error, 'hold_open', { onUnique: () => stateMoved('hold_race') })
        }
        opened += 1
      }
      for (const row of open) {
        if (fingerprints.has(row.fingerprint)) continue
        if (row.runbook_only === true) continue
        let rows
        try {
          rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.hold, {
            status: 'superseded',
            resolution: 'superseded_by_computation',
            resolved_at: at,
            updated_at: at,
          }, { id: row.id, status: 'open' }))
        } catch (error) {
          throw translate(error, 'hold_supersede')
        }
        if (rows.length !== 1) throw stateMoved('hold_moved')
        superseded += 1
      }

      let reconfirmations = 0
      for (const [continuationId, verdict] of Object.entries(verdicts)) {
        let row
        try {
          row = await trx.selectOne(REFRESH_STORE_TABLES.continuation, { id: continuationId })
        } catch (error) {
          throw translate(error, 'continuation_read')
        }
        if (!row) throw inputInvalid('a verdict names an unknown continuation', `verdicts.${continuationId}`)
        if (row.tenant_id !== scope.tenantId) throw tenantMismatch('continuation')
        if (row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) throw inputInvalid('a verdict names a continuation of another scope', `verdicts.${continuationId}`)
        if (row.claim_active !== true) continue
        const set = { last_verified_at: at, last_verdict: verdict, last_verified_generation_token: computation.generationToken, updated_at: at }
        const moves = row.status === 'active' && CONTINUATION_STATUS_REASONS.includes(verdict)
        if (moves) {
          set.status = 'needs_reconfirmation'
          set.status_reason = verdict
          reconfirmations += 1
        }
        let rows
        try {
          rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.continuation, set, { id: continuationId, status: row.status, claim_active: true }))
        } catch (error) {
          throw translate(error, 'continuation_verdict')
        }
        if (rows.length !== 1) throw stateMoved('continuation_moved')
      }

      // Step 5 PR-8 — THE CONFIRMED CHANGE PLAN, decided under the state-row lock (refutation B2):
      //   `matches`  the plan must STILL be `confirmed`: a concurrent computation may have invalidated it after this
      //              one's consult (the CAS above is on decision_version, which a reconcile never moves) — refused 409
      //              CHANGE_PLAN_STALE, so an apply never writes a voided plan and a preview never mints for one;
      //   `stale`    the computation no longer finds the plan's change set (C02, D-13: read-tier previews included):
      //              `invalidated(source_changed)` + an audit row on this handle — EXCEPT while an execution bound to
      //              the plan is `running` (read here, on this handle, never from the consult): a computation that
      //              read the sheet mid-write must not void the plan whose write is landing; the execution's finish
      //              decides (written / execution_failed). A plan already invalidated is left as is; one written or
      //              superseded since the consult means this computation planned against a past state (STATE_MOVED).
      let changePlanOutcome = null
      if (changePlan) {
        let planRow
        try {
          planRow = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.changePlan, { id: changePlan.id })
        } catch (error) {
          throw translate(error, 'change_plan_lock')
        }
        if (!planRow) throw stateMoved('change_plan_moved')
        if (planRow.tenant_id !== scope.tenantId) throw tenantMismatch('change_plan')
        if (planRow.sheet_id !== scope.sheetId || planRow.project_no !== scope.projectNo) throw inputInvalid('the change plan belongs to another scope', 'changePlan.id')
        if (changePlan.verdict === 'matches') {
          if (planRow.status !== 'confirmed') throw changePlanStale(planStatusReason(planRow.status), { status: planRow.status })
          changePlanOutcome = Object.freeze({ id: planRow.id, verdict: 'matches', status: 'confirmed', invalidated: false, deferred: false })
        } else if (planRow.status === 'confirmed') {
          const running = await selectAll(trx, REFRESH_STORE_TABLES.execution, { sheet_id: scope.sheetId, project_no: scope.projectNo, status: 'running' }, { ceiling: READ_CEILINGS.execution, operation: 'read_executions' })
          const bound = running.filter((row) => {
            const binding = jsonOrNull(row.refresh_binding)
            return isPlainObject(binding) && binding.changePlanId === planRow.id
          })
          if (bound.length > 0) {
            changePlanOutcome = Object.freeze({ id: planRow.id, verdict: 'stale', status: 'confirmed', invalidated: false, deferred: true })
          } else {
            if (!auditWithin) {
              throw new StockPreparationRefreshStoreError(501, REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE, 'a change plan is invalidated only with its audit row; the invalidation audit hook is not wired', { reason: 'invalidation_audit_missing' })
            }
            let rows
            try {
              rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.changePlan, { status: 'invalidated', invalidated_reason: 'source_changed', invalidated_at: at, updated_at: at }, { id: planRow.id, status: 'confirmed' }))
            } catch (error) {
              throw translate(error, 'change_plan_invalidate')
            }
            if (rows.length !== 1) throw stateMoved('change_plan_moved')
            await runAudit(trx, auditWithin, {
              operation: 'change_plan_invalidated',
              changePlanId: planRow.id,
              reason: 'source_changed',
              lane: computation.lane,
              recordCount: intOrNull(planRow.record_count),
              generationToken: computation.generationToken,
            })
            changePlanOutcome = Object.freeze({ id: planRow.id, verdict: 'stale', status: 'invalidated', invalidated: true, deferred: false })
          }
        } else if (planRow.status === 'invalidated') {
          changePlanOutcome = Object.freeze({ id: planRow.id, verdict: 'stale', status: 'invalidated', invalidated: false, deferred: false })
        } else {
          throw stateMoved('change_plan_moved')
        }
      }

      const remainingOpen = await openHoldsOf(trx, scope)
      const set = {
        version: (intOrNull(stateRow.version) || 0) + 1,
        last_computation_at: at,
        last_computation_lane: computation.lane,
        last_computation_generation_token: computation.generationToken,
        last_computation_source_content_digest: computation.sourceContentDigest,
        last_computation_suspended: computation.suspended,
        hold_set_fingerprint: holdSetFingerprintOf(remainingOpen.map((row) => row.fingerprint)),
        updated_at: at,
      }
      if (settlement && remainingOpen.length === 0) {
        set.settled_at = at
        set.settled_execution_id = settlement.executionId
        set.settled_generation_token = settlement.generationToken
        set.settled_sheet_machine_digest = settlement.sheetMachineDigest
        set.settled_source_content_digest = settlement.sourceContentDigest
      }
      let rows
      try {
        rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.state, set, { id: stateRow.id, decision_version: observed }))
      } catch (error) {
        throw translate(error, 'state_write')
      }
      if (rows.length !== 1) throw stateMoved('decision_version')
      const state = rows[0]
      return Object.freeze({
        stateId: state.id,
        version: intOrNull(state.version),
        decisionVersion: intOrNull(state.decision_version),
        holdSetFingerprint: state.hold_set_fingerprint ?? null,
        holds: Object.freeze({ opened, kept, superseded, open: remainingOpen.length }),
        reconfirmations,
        settled: Boolean(settlement && remainingOpen.length === 0),
        changePlan: changePlanOutcome,
      })
    })
  }

  // ── the execution ledger (design §4.2, §9.3) ──────────────────────────────────────────────────

  /** Mint the logical execution id BEFORE the first main-sheet write: one `running` row bound to the grant. */
  async function beginExecution(input = {}) {
    const scope = normalizeScope(input)
    if (!EXECUTION_LANES.includes(input.lane)) throw inputInvalid('lane is not an execution lane', 'lane')
    const guard = input.guard
    if (!isPlainObject(guard) || !nonBlankString(guard.leaseRunId) || !nonBlankString(guard.leaseId) || !nonBlankString(guard.generationToken)
      || !Number.isInteger(guard.fencingEpoch) || guard.fencingEpoch < 0 || !Number.isInteger(guard.generation) || guard.generation < 0) {
      throw inputInvalid('guard needs leaseRunId, leaseId, fencingEpoch, generation and generationToken', 'guard')
    }
    if (!nonBlankString(input.tokenRevision)) throw inputInvalid('tokenRevision is required', 'tokenRevision')
    if (!nonBlankString(input.planDigest)) throw inputInvalid('planDigest is required', 'planDigest')
    if (!isPlainObject(input.plannedCounts)) throw inputInvalid('plannedCounts must be an object', 'plannedCounts')
    const binding = input.refreshBinding
    if (!isPlainObject(binding) || !Array.isArray(binding.continuations)
      || !binding.continuations.every((entry) => isPlainObject(entry) && nonBlankString(entry.id) && Number.isInteger(entry.revision) && entry.revision >= 1)) {
      throw inputInvalid('refreshBinding needs continuations: [{ id, revision }]', 'refreshBinding')
    }
    const startedBy = trimmed(input.startedBy)
    if (!startedBy) throw scopeInvalid('startedBy')
    if (binding.changePlanId !== undefined && binding.changePlanId !== null && !nonBlankString(binding.changePlanId)) {
      throw inputInvalid('refreshBinding.changePlanId must be a string when given', 'refreshBinding.changePlanId')
    }
    const changePlanId = nonBlankString(binding.changePlanId) ? binding.changePlanId.trim() : null
    const at = clock()
    const id = newId('execution')
    const executionRow = {
      id,
      tenant_id: scope.tenantId,
      sheet_id: scope.sheetId,
      project_no: scope.projectNo,
      write_scope_key: scope.writeScopeKey,
      lane: input.lane,
      lease_run_id: guard.leaseRunId,
      lease_id: guard.leaseId,
      fencing_epoch: guard.fencingEpoch,
      generation: guard.generation,
      generation_token: guard.generationToken,
      token_revision: input.tokenRevision,
      plan_digest: input.planDigest,
      planned_counts: input.plannedCounts,
      refresh_binding: {
        continuations: binding.continuations.map((entry) => ({ id: entry.id, revision: entry.revision })),
        changePlanId,
        holdSetFingerprint: nonBlankString(binding.holdSetFingerprint) ? binding.holdSetFingerprint : null,
      },
      status: 'running',
      started_by: startedBy,
      started_at: at,
      created_at: at,
      updated_at: at,
    }
    if (!changePlanId) {
      let row
      try {
        row = firstRow(await db.insertOne(REFRESH_STORE_TABLES.execution, executionRow))
      } catch (error) {
        throw translate(error, 'execution_begin')
      }
      return rowToExecution(row || { id })
    }
    // Step 5 PR-8 (refutation B2): an execution bound to a change plan is begun UNDER THE STATE-ROW LOCK with the plan
    // asserted `confirmed` — the lock every reconciliation takes first, so a concurrent computation either invalidated
    // the plan before this begin (refused here, nothing written) or sees this `running` row and leaves the plan alone.
    return db.transaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw changePlanStale('state_row_absent')
      let plan
      try {
        plan = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.changePlan, { id: changePlanId })
      } catch (error) {
        throw translate(error, 'change_plan_lock')
      }
      if (!plan) throw changePlanStale('plan_absent')
      if (plan.tenant_id !== scope.tenantId) throw tenantMismatch('change_plan')
      if (plan.sheet_id !== scope.sheetId || plan.project_no !== scope.projectNo) throw changePlanStale('plan_scope')
      if (plan.status !== 'confirmed') throw changePlanStale(planStatusReason(plan.status), { status: plan.status })
      let row
      try {
        row = firstRow(await trx.insertOne(REFRESH_STORE_TABLES.execution, executionRow))
      } catch (error) {
        throw translate(error, 'execution_begin')
      }
      return rowToExecution(row || { id })
    })
  }

  /**
   * Close a `running` execution with its result. `succeeded` stamps `executed_execution_id` on every
   * continuation of its refresh binding (at the bound revision) and, when a `settlement` is given (the
   * self-settling zero-write run, §9.2), the state row's settled_* columns in the same transaction.
   */
  async function finishExecution(input = {}) {
    const scope = normalizeScope(input)
    const executionId = trimmed(input.executionId)
    if (!executionId) throw scopeInvalid('executionId')
    if (!EXECUTION_FINISH_STATUSES.includes(input.status)) throw inputInvalid('status is not a finish status', 'status')
    for (const name of ['written', 'attemptedWrites']) {
      if (input[name] !== undefined && input[name] !== null && (!Number.isInteger(input[name]) || input[name] < 0)) throw inputInvalid(`${name} must be a non-negative integer`, name)
    }
    if (input.abortCode !== undefined && input.abortCode !== null && !nonBlankString(input.abortCode)) throw inputInvalid('abortCode must be a string when given', 'abortCode')
    if (input.errorCodes !== undefined && input.errorCodes !== null && !Array.isArray(input.errorCodes)) throw inputInvalid('errorCodes must be an array when given', 'errorCodes')
    const settlement = normalizeSettlement(input.settlement)
    if (settlement && input.status !== 'succeeded') throw inputInvalid('only a succeeded execution settles', 'settlement')
    const at = clock()

    return db.transaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      // LOCK ORDER (TD-23, PR-3a ST-1): a SETTLING finish takes the refresh-state row FOR UPDATE FIRST — the
      // order every reconciliation and decision uses (state -> hold / execution -> continuation) — so a
      // concurrent preview's reconcile (state -> hold -> continuation) and this finish can never wait on each
      // other in a cycle. Exactly one state lock per finish; a non-settling finish never touches the state row.
      const settleState = settlement ? await lockStateRow(trx, scope, { at }) : null
      if (settlement && !settleState) throw stateMoved('state_row_absent')
      let row
      try {
        row = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.execution, { id: executionId })
      } catch (error) {
        throw translate(error, 'execution_lock')
      }
      if (!row) throw stateMoved('execution_absent')
      if (row.tenant_id !== scope.tenantId) throw tenantMismatch('execution')
      if (row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) throw stateMoved('execution_scope')
      if (row.status !== 'running') throw stateMoved('execution_not_running')
      let rows
      try {
        rows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.execution, {
          status: input.status,
          finished_at: at,
          written: input.written === undefined ? null : input.written,
          attempted_writes: input.attemptedWrites === undefined ? null : input.attemptedWrites,
          counts: isPlainObject(input.counts) ? input.counts : null,
          abort_code: input.abortCode || null,
          error_codes: Array.isArray(input.errorCodes) ? input.errorCodes : null,
          updated_at: at,
        }, { id: executionId, status: 'running' }))
      } catch (error) {
        throw translate(error, 'execution_finish')
      }
      if (rows.length !== 1) throw stateMoved('execution_moved')
      const finished = rows[0]

      let consumed = 0
      if (input.status === 'succeeded') {
        const binding = jsonOrNull(row.refresh_binding)
        const bound = binding && Array.isArray(binding.continuations) ? binding.continuations : []
        for (const entry of bound) {
          if (!isPlainObject(entry) || !nonBlankString(entry.id)) continue
          let updated
          try {
            updated = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.continuation, { executed_execution_id: executionId, updated_at: at }, {
              id: entry.id,
              revision: entry.revision,
              claim_active: true,
              tenant_id: scope.tenantId,
              sheet_id: scope.sheetId,
              project_no: scope.projectNo,
            }))
          } catch (error) {
            throw translate(error, 'continuation_consume')
          }
          // Under the lease no decision can have moved the bound revision; a miss is a defect, never silent.
          if (updated.length !== 1) throw stateMoved('bound_continuation_moved')
          consumed += 1
        }
        if (settlement) {
          let stateRows
          try {
            stateRows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.state, {
              version: (intOrNull(settleState.version) || 0) + 1,
              settled_at: at,
              settled_execution_id: executionId,
              settled_generation_token: settlement.generationToken,
              settled_sheet_machine_digest: settlement.sheetMachineDigest,
              settled_source_content_digest: settlement.sourceContentDigest,
              updated_at: at,
            }, { id: settleState.id, version: intOrNull(settleState.version) || 0 }))
          } catch (error) {
            throw translate(error, 'state_settle')
          }
          if (stateRows.length !== 1) throw stateMoved('version')
        }
      }

      // Step 5 PR-8 — the change plan this execution was bound to (begun under the state lock with the plan asserted
      // `confirmed`; no computation invalidates a plan while its bound execution runs, so it is still `confirmed`
      // here — a miss is a defect, never silent):
      //   succeeded            -> `written` (+ execution id, written_at, written_content_digest). The previous
      //                           `written` plan (at most one) is SUPERSEDED FIRST and every field of it this plan
      //                           does not write enters this plan's record set review-only (B1: a written change
      //                           leaves `written` only by a review or by this absorption — never escapes review);
      //   partial / failed /   -> `invalidated(execution_failed)` + execution id. The previous written plan stays
      //   aborted                 `written` (its review still pending); what this run may have landed is step 6's
      //                           verify-and-close to account for (F-16 — the project derives 失败待恢复 until then).
      let changePlanOutcome = null
      const bindingRecord = jsonOrNull(row.refresh_binding)
      const changePlanId = isPlainObject(bindingRecord) && nonBlankString(bindingRecord.changePlanId) ? bindingRecord.changePlanId : null
      if (changePlanId) {
        let planRow
        try {
          planRow = await trx.selectOneForUpdate(REFRESH_STORE_TABLES.changePlan, { id: changePlanId })
        } catch (error) {
          throw translate(error, 'change_plan_lock')
        }
        if (!planRow || planRow.tenant_id !== scope.tenantId || planRow.sheet_id !== scope.sheetId || planRow.project_no !== scope.projectNo) throw stateMoved('change_plan_scope')
        if (planRow.status !== 'confirmed') throw stateMoved('change_plan_moved')
        if (input.status === 'succeeded') {
          const older = await lockedPlansOf(trx, scope, 'written')
          let recordSet = jsonArrayOf(planRow.record_set)
          const absorbedIds = jsonArrayOf(planRow.absorbed_change_plan_ids).slice()
          let absorbedFields = 0
          for (const previous of older) {
            const absorbed = absorbIntoRecordSet(recordSet, jsonArrayOf(previous.record_set))
            recordSet = absorbed.recordSet
            absorbedFields += absorbed.absorbedFields
            for (const id of [previous.id, ...jsonArrayOf(previous.absorbed_change_plan_ids)]) if (!absorbedIds.includes(id)) absorbedIds.push(id)
            let superseded
            try {
              superseded = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.changePlan, { status: 'superseded', superseded_at: at, superseded_by: planRow.id, updated_at: at }, { id: previous.id, status: 'written' }))
            } catch (error) {
              throw translate(error, 'change_plan_supersede')
            }
            if (superseded.length !== 1) throw stateMoved('change_plan_moved')
          }
          let written
          try {
            written = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.changePlan, {
              status: 'written',
              execution_id: executionId,
              written_at: at,
              written_content_digest: plannedContentDigestOf(recordSet),
              record_set: recordSet,
              record_count: recordSet.length,
              absorbed_change_plan_ids: absorbedIds,
              updated_at: at,
            }, { id: planRow.id, status: 'confirmed' }))
          } catch (error) {
            throw translate(error, 'change_plan_written')
          }
          if (written.length !== 1) throw stateMoved('change_plan_moved')
          changePlanOutcome = Object.freeze({ id: planRow.id, status: 'written', absorbedPlans: older.length, absorbedFields })
        } else {
          let invalidated
          try {
            invalidated = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.changePlan, {
              status: 'invalidated',
              invalidated_reason: 'execution_failed',
              invalidated_at: at,
              execution_id: executionId,
              updated_at: at,
            }, { id: planRow.id, status: 'confirmed' }))
          } catch (error) {
            throw translate(error, 'change_plan_invalidate')
          }
          if (invalidated.length !== 1) throw stateMoved('change_plan_moved')
          changePlanOutcome = Object.freeze({ id: planRow.id, status: 'invalidated', reason: 'execution_failed' })
        }
      }
      return Object.freeze({ ...rowToExecution(finished), continuationsConsumed: consumed, settled: Boolean(settlement), changePlan: changePlanOutcome })
    })
  }

  return Object.freeze({
    readGovernanceRows,
    readSheetGovernanceMarks,
    readContinuation,
    readHold,
    // Step 5 PR-8.
    readChangePlan,
    confirmChangePlan,
    completeChangeReview,
    countOpenHoldsByProjectNo,
    confirmContinuation,
    reconfirmContinuation,
    endContinuation,
    reconcileHolds,
    beginExecution,
    finishExecution,
  })
}

module.exports = {
  REFRESH_STORE_TABLES,
  REFRESH_STORE_ERROR_CODES,
  CONTINUATION_ROW_STATUSES,
  CONTINUATION_STATUS_REASONS,
  EVIDENCE_HISTORY_STATUSES,
  DEMAND_BASES,
  APPLICABILITY_SCOPES,
  END_OUTCOMES,
  HOLD_STATUSES,
  HOLD_RESOLUTIONS,
  COMPUTATION_LANES,
  EXECUTION_LANES,
  EXECUTION_STATUSES,
  EXECUTION_FINISH_STATUSES,
  UNFINISHED_EXECUTION_STATUSES,
  VERIFIED_RESULTS,
  BUMP_REASONS,
  BASIS_NOTE_MAX_LENGTH,
  // Step 5 PR-8 (migration 104).
  CHANGE_PLAN_STATUSES,
  CHANGE_PLAN_PENDING_STATUSES,
  CHANGE_PLAN_INVALIDATED_REASONS,
  CHANGE_PLAN_RECORD_CEILING,
  REVIEW_CONCLUSIONS,
  REVIEW_NOTES_MAX_LENGTH,
  READ_CEILINGS,
  NEWEST_EXECUTIONS,
  CONSULT_SNAPSHOT_ISOLATION,
  StockPreparationRefreshStoreError,
  createStockPreparationContinuationStore,
  holdSetFingerprintOf,
  keyDigest,
  __internals: {
    rowToContinuation,
    rowToMember,
    rowToHold,
    rowToState,
    rowToExecution,
    rowToChangePlan,
    rowToChangePlanSummary,
    absorbIntoRecordSet,
    writeRecordIdsOf,
    // Review fix N3 (round 2: N3-a / N3-b).
    expectedContentOf,
    reviewedCellsOf,
    continuationFactsFromHold,
    claimsOverlap,
    takeoverGaps,
    normalizeIncomingHold,
    normalizeScope,
    SCHEMES,
  },
}
