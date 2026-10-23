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
// NOT HERE: no route, no lane consult (PR-3), no `bumpGenerationWithin` (PR-4), no audit vocabulary (D9),
// no env flag (D-3), no change-plan table (step 5: `changePlans` is answered as a literal empty list by the
// governance reader until migration N+2 exists).
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const { sheetWriteScopeKey } = require('./stock-preparation-project-write-lock.cjs')
const pairing = require('./stock-preparation-continuation-pairing.cjs')

const {
  CONTINUATION_ERROR_CODES,
  CONTINUATION_VERDICTS,
  HOLD_KINDS,
  NOT_CONFIRMABLE_REASONS,
  RECONFIRMABLE_REASONS,
  SHAPE_TOKENS,
} = pairing
const { canonicalJson, subjectDigest } = pairing.__internals

const REFRESH_STORE_TABLES = Object.freeze({
  continuation: 'integration_stock_prep_continuation',
  member: 'integration_stock_prep_continuation_member',
  state: 'integration_stock_prep_refresh_state',
  hold: 'integration_stock_prep_refresh_hold',
  execution: 'integration_stock_prep_refresh_execution',
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
const BUMP_REASONS = Object.freeze({ confirm: 'continuation_confirm', end: 'continuation_end' })
const BASIS_NOTE_MAX_LENGTH = 2000
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
})

// The consult's reads share ONE snapshot (review X-1): a lib/db.cjs whitelisted isolation level, pinned by the
// transaction's first statement.
const CONSULT_SNAPSHOT_ISOLATION = 'repeatable read'

// Paging: the scoped helper clamps a page at 10000; the ceilings bound what one consult may hold in memory.
const READ_PAGE_SIZE = 1000
const READ_CEILINGS = Object.freeze({ continuation: 5000, member: 20000, hold: 5000, state: 100, execution: 5000 })
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
      return Object.freeze({
        ok: true,
        scope,
        continuations: continuations.map(rowToContinuation),
        members: members.map(rowToMember),
        holds: holds.map(rowToHold),
        states: states.map(rowToState),
        executions: executions.map(rowToExecution),
      })
    })
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
   * transaction: state FOR UPDATE -> hold re-read -> [the named continuation FOR UPDATE, its claim_active
   * members read, refused 409 END_OUTCOME_NOT_ADMISSIBLE `supersedes_unrelated` when the claims share nothing
   * (claimsOverlap, review X-3) and `supersedes_incomplete` when the new claims do not cover every old record id
   * and old key digest of it (takeoverGaps, review round 2), then ended as superseded_by_new_confirmation] ->
   * bumpWithin ->
   * INSERT header + members (23505 -> 409 CONFIRM_CONFLICT) -> hold resolved -> decision_version + 1 ->
   * auditWithin. Returns a values-free summary.
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
    const auditWithin = auditHookOf(options)
    const at = clock()

    return db.transaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw confirmStale('state_row_absent')
      const holdRow = await lockedHold(trx, scope, holdId)
      if (holdRow.kind !== 'continuation_candidate') throw confirmNotAllowed('kind', { kind: holdRow.kind })
      if (holdRow.confirmable !== true) throw confirmNotAllowed('not_confirmable', { kind: holdRow.kind, notConfirmableReason: holdRow.not_confirmable_reason || null })
      assertEcho(holdRow, echo)
      const hold = rowToHold(holdRow)
      const facts = continuationFactsFromHold(hold, scope)

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

      const bump = await runBump(trx, scope, BUMP_REASONS.confirm, bumpWithin)

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
   * about this continuation) is confirmable.
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

    return db.transaction(async (rawTrx) => {
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

      const bump = await runBump(trx, scope, BUMP_REASONS.confirm, bumpWithin)
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
   * here; `release_to_normal_refresh` is admissible only when the continuation's last verdict is
   * `new_position_removed` AND the caller asserts, from the latest computation's recorded facts, that the
   * current expansion holds NO new position of the component (`currentExpansionHoldsNoNewPosition: true`) — so
   * an end can never produce "copies ADDed + old rows swept"; `escalate_special_repair` is admissible only
   * while at least one OPEN hold names this continuation (reason `no_open_hold` otherwise), and keeps every
   * such hold OPEN as runbook-only (not confirmable): an open hold derives 待确认 and is never superseded by a
   * computation nor settled over, so nothing derives 已完成 / export-allowed until an owner-approved runbook
   * closes it. Every refusal is decided inside the transaction BEFORE the bump and before any row moves.
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
    const bumpWithin = requireBumpWithin(options)
    const auditWithin = auditHookOf(options)
    const at = clock()

    return db.transaction(async (rawTrx) => {
      const trx = requireTrx(rawTrx)
      const stateRow = await lockStateRow(trx, scope, { at })
      if (!stateRow) throw confirmStale('state_row_absent')
      const continuationRow = await lockedContinuation(trx, scope, continuationId, { revision: input.revision })
      // Review X-2 / §9.3: only a relationship that needs reconfirmation is ended here.
      if (continuationRow.status !== 'needs_reconfirmation') {
        throw endNotAdmissible('status', input.outcome, { status: continuationRow.status })
      }
      if (input.outcome === 'release_to_normal_refresh') {
        if (continuationRow.last_verdict !== 'new_position_removed' || input.currentExpansionHoldsNoNewPosition !== true) {
          throw new StockPreparationRefreshStoreError(409, REFRESH_STORE_ERROR_CODES.END_OUTCOME_NOT_ADMISSIBLE, 'release_to_normal_refresh is admissible only after the new position was removed from the source and the current expansion holds no new position of the component', {
            reason: continuationRow.last_verdict !== 'new_position_removed' ? 'last_verdict' : 'new_position_present',
            outcome: input.outcome,
            lastVerdict: continuationRow.last_verdict || null,
          })
        }
      }
      // The continuation's own open holds: released -> resolved as continuation_ended; escalated -> kept open,
      // runbook-only, never confirmable; a computation never supersedes a runbook-only hold. Read BEFORE the
      // bump: an escalation with no open hold to keep would leave nothing suspending the project (review X-2).
      const holdsAbout = await selectAll(trx, REFRESH_STORE_TABLES.hold, { sheet_id: scope.sheetId, project_no: scope.projectNo, continuation_id: continuationId, status: 'open' }, { ceiling: READ_CEILINGS.hold, operation: 'read_holds' })
      if (input.outcome === 'escalate_special_repair' && holdsAbout.length === 0) {
        throw endNotAdmissible('no_open_hold', input.outcome)
      }
      const bump = await runBump(trx, scope, BUMP_REASONS.end, bumpWithin)
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

  // ── hold reconciliation (design §8.4) ─────────────────────────────────────────────────────────

  /**
   * Persist what ONE computation of a governed project found. `decisionVersionObserved` is the state row's
   * decision_version the consult answered (0 when it answered no row): a different value now means a
   * decision landed in between -> 409 STATE_MOVED and NOTHING is persisted. `holds` are the computation's
   * holds (pure-core shape; [] for a clean computation); `verdicts` the continuation verification results;
   * `settlement` only for a clean computation with zero pending decisions (§9.2). Never bumps
   * decision_version. A store failure is 503: a computation never answers "clean" with an unrecorded state.
   */
  async function reconcileHolds(input = {}) {
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
            await trx.updateRow(REFRESH_STORE_TABLES.hold, { last_seen_at: at, updated_at: at }, { id: existing.id, status: 'open' })
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
    const at = clock()
    const id = newId('execution')
    let row
    try {
      row = firstRow(await db.insertOne(REFRESH_STORE_TABLES.execution, {
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
          changePlanId: nonBlankString(binding.changePlanId) ? binding.changePlanId : null,
          holdSetFingerprint: nonBlankString(binding.holdSetFingerprint) ? binding.holdSetFingerprint : null,
        },
        status: 'running',
        started_by: startedBy,
        started_at: at,
        created_at: at,
        updated_at: at,
      }))
    } catch (error) {
      throw translate(error, 'execution_begin')
    }
    return rowToExecution(row || { id })
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
          const stateRow = await lockStateRow(trx, scope, { at })
          if (!stateRow) throw stateMoved('state_row_absent')
          let stateRows
          try {
            stateRows = rowsOf(await trx.updateRow(REFRESH_STORE_TABLES.state, {
              version: (intOrNull(stateRow.version) || 0) + 1,
              settled_at: at,
              settled_execution_id: executionId,
              settled_generation_token: settlement.generationToken,
              settled_sheet_machine_digest: settlement.sheetMachineDigest,
              settled_source_content_digest: settlement.sourceContentDigest,
              updated_at: at,
            }, { id: stateRow.id, version: intOrNull(stateRow.version) || 0 }))
          } catch (error) {
            throw translate(error, 'state_settle')
          }
          if (stateRows.length !== 1) throw stateMoved('version')
        }
      }
      return Object.freeze({ ...rowToExecution(finished), continuationsConsumed: consumed, settled: Boolean(settlement) })
    })
  }

  return Object.freeze({
    readGovernanceRows,
    readContinuation,
    readHold,
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
    continuationFactsFromHold,
    claimsOverlap,
    takeoverGaps,
    normalizeIncomingHold,
    normalizeScope,
    SCHEMES,
  },
}
