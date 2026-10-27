'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 4, PR-4 — THE PULLER'S DECISIONS over a governed project (design §8.2-8.4, §13,
// §14, §23.5 O-17, §23.8 F-15; plan docs/development/takeover-beiliao-20260821/batch-refresh-merge-plan-20261022.md
// §3.3, §4, §9.5 U03 / U04): the six routes' logic, with SERVER-HELD inputs only.
//
//   listHolds           GET  …/refresh/holds                      the PRIVATE hold page (values), paged ≤ 50 holds, a
//                                                                  hold's pairs paged on their own; every page served is
//                                                                  recorded on a READ RECEIPT (U04)
//   readHoldEvidence    GET  …/refresh/holds/:holdId/evidence      the demand facts of the computation that opened the
//                                                                  hold + the history side (relationship snapshot or
//                                                                  history_unknown; the 2c store does not exist)
//   readContinuation    GET  …/refresh/continuations/:id           header + members + evidence snapshot
//   confirm             POST …/refresh/continuations/confirm       a continuation_candidate => confirmContinuation; a
//                                                                  relationship_reconfirm => reconfirmContinuation
//   keepHold            POST …/refresh/holds/:holdId/keep          「暂不处理」: audit only, nothing changes
//   end                 POST …/refresh/continuations/:id/end       endContinuation with an outcome; the release
//                                                                  precondition is decided by the STORE under its
//                                                                  lock, never read from the body; the body may name
//                                                                  the hold it was shown (factsHoldId + fingerprint)
//
// WHAT THE ROUTE HANDS IN (lib/http-routes.cjs builds it once per request, in this order, and only a route
// builds it): the gate (`stock-prep:pull`), the body allow-list, the typed `confirmProjectNo`, the host-vouched
// operator scope (`resolveOperatorValueScope`, never a header), the audit vocabulary probe, the resolved table
// action (+ `assertResolvedProjectTargetTenancy`), ONE governance consult (`refreshGovernanceFor(tenant)`). The
// context is `{ scope: { tenantId, sheetId, projectNo }, actorId, tenantClaimVerified, action, consult, store,
// projectWriteLock, audit, receipts }`. Nothing here reads a request object.
//
// REFUSALS BEFORE THE TRANSACTION (§8.2, O-17), in order: NOT_PILOT (the registry marker, from the consult);
// RECOVERY_PENDING (the SAME rows the preview answers on — partial / failed / aborted, or `running` of a lease
// that is not live; a running row of the LIVE lease is left to the bump's WRITE_LOCKED, which tells the puller
// "retry after it finishes"); S25 — an OPEN runbook-only hold (an escalated relationship under specialist
// repair) refuses a confirm, a re-confirm and `release_to_normal_refresh` (`runbook_only_hold_open`), never an
// escalation or 「暂不处理」; the hold by id (404 for absent AND for another scope's row — the board's rule,
// never an existence oracle); the kind and `confirmable`; the read receipt; the echoed fingerprints. These are
// the consult's picture — a fast, precise refusal that never takes the state row. THEN the store's transaction,
// which decides for itself under the state-row lock (PR-4 execution review B1 / N2 / N3): state row FOR UPDATE,
// hold re-read, the open holds re-read (S25 again: `runbook_only_hold_open`), for a release the facts of THE
// open relationship_reconfirm row (never the caller's) bound to the hold the puller was shown (`facts_moved`),
// `bumpGenerationWithin` on the handle (the lock's WRITE_LOCKED / contention / holder_in_write roll it back),
// the unfinished executions re-read (RECOVERY_PENDING again), rows, hold resolved, decision_version + 1, the
// audit row INSERTED ON THE SAME HANDLE (E09: an audit failure rolls the decision back; a COMMIT failure is 503
// STORE_FAILED `commit`).
//
// THE READ RECEIPT (U04 「只返回字段名/计数时不允许盲确认」). A values-free record in plugin durable storage
// (the dry-run token's store), keyed by a random id: `{ tenantId, sheetId, projectNo, actorId, holds: { [holdId]:
// { fingerprint, comparisonFingerprint, evidenceFingerprint, pairPageCount, pairPagesServed } }, expiresAt }`.
// The hold page extends it with every page it serves; a confirm requires it to belong to the same actor and
// scope, to cover EVERY pair page of the hold, and to carry the hold's CURRENT fingerprints (a hold that changed
// between pages must be read again). A stateless digest would be forgeable from page 1 alone. The readiness
// scan of plugin_kv reads the large-BOM prefix only, so receipts never count against a pilot enable.
//
// VALUES. The hold payloads, the evidence and the continuation detail are VALUE-BEARING by design (the pull
// tier, audited before the response). Every error detail, every audit row and every `refresh` summary stanza
// carries tokens, counts, booleans, record-id handles and digests only — never a key, a path, a component id,
// a quantity or a message from below. The audit `detail` uses page INDEXES (integers), never a cursor.
//
// NOT HERE: no board stanza (PR-5), no export gate (PR-5), no `supersedes` on the HTTP body (a candidate the
// planner emits never overlaps a live relationship's claims — the detector excludes projected keys — so the
// full-takeover supersede (X-4) has no HTTP path in step 4; it stays a store contract), no web (PR-7).
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const { REFRESH_STORE_ERROR_CODES, StockPreparationRefreshStoreError, END_OUTCOMES, EVIDENCE_HISTORY_STATUSES } = require('./stock-preparation-continuation-store.cjs')
const { REFRESH_LANE_ERROR_CODES, previewRecoveryOf, refreshSourceIdentity } = require('./stock-preparation-refresh-lanes.cjs')
const { readProjectRefreshState } = require('./stock-preparation-refresh-state.cjs')
const { PROJECT_WRITE_ERROR_CODES, sheetWriteScopeKey } = require('./stock-preparation-project-write-lock.cjs')
const pairing = require('./stock-preparation-continuation-pairing.cjs')
const { derivePackAwarePlmWritableFields, __internals: plannerInternals } = require('./stock-preparation-conflict-planner.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require('./stock-preparation-templates.cjs')

const REFRESH_DECISION_ERROR_CODES = Object.freeze({
  REQUEST_INVALID: 'STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID',
  NOT_PILOT: 'STOCK_PREP_CONTINUATION_CONFIRM_NOT_PILOT',
  READ_RECEIPT_INCOMPLETE: 'STOCK_PREP_CONTINUATION_CONFIRM_READ_RECEIPT_INCOMPLETE',
  HOLD_NOT_FOUND: 'STOCK_PREP_REFRESH_HOLD_NOT_FOUND',
  CONTINUATION_NOT_FOUND: 'STOCK_PREP_CONTINUATION_NOT_FOUND',
  RECEIPT_STORE_UNAVAILABLE: 'STOCK_PREP_REFRESH_READ_RECEIPT_STORE_UNAVAILABLE',
  // Step 5 PR-8: a change plan of this project by id (404, never an existence oracle across scopes) and the review's
  // own receipt refusal (the review needs every page of the CURRENT diff it binds).
  CHANGE_PLAN_NOT_FOUND: 'STOCK_PREP_CHANGE_PLAN_NOT_FOUND',
  CHANGE_REVIEW_READ_RECEIPT_INCOMPLETE: 'STOCK_PREP_CHANGE_REVIEW_READ_RECEIPT_INCOMPLETE',
  // The store's and the lanes' own codes, re-exported so a caller reads one vocabulary.
  CONFIRM_STALE: REFRESH_STORE_ERROR_CODES.CONFIRM_STALE,
  CONFIRM_NOT_ALLOWED: REFRESH_STORE_ERROR_CODES.CONFIRM_NOT_ALLOWED,
  CONFIRM_CONFLICT: REFRESH_STORE_ERROR_CODES.CONFIRM_CONFLICT,
  END_OUTCOME_NOT_ADMISSIBLE: REFRESH_STORE_ERROR_CODES.END_OUTCOME_NOT_ADMISSIBLE,
  RECOVERY_PENDING: REFRESH_LANE_ERROR_CODES.RECOVERY_PENDING,
  STORE_FAILED: REFRESH_STORE_ERROR_CODES.STORE_FAILED,
  STORE_UNAVAILABLE: REFRESH_STORE_ERROR_CODES.STORE_UNAVAILABLE,
  WRITE_LOCKED: PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED,
  CHANGE_PLAN_STALE: REFRESH_STORE_ERROR_CODES.CHANGE_PLAN_STALE,
  CHANGE_PLAN_NOT_ALLOWED: REFRESH_STORE_ERROR_CODES.CHANGE_PLAN_NOT_ALLOWED,
  CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT: REFRESH_STORE_ERROR_CODES.CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT,
  CHANGE_REVIEW_STALE: REFRESH_STORE_ERROR_CODES.CHANGE_REVIEW_STALE,
  CHANGE_REVIEW_BLOCKED: REFRESH_STORE_ERROR_CODES.CHANGE_REVIEW_BLOCKED,
  REVIEW_PENDING: REFRESH_LANE_ERROR_CODES.REVIEW_PENDING,
})

// Audit (design §4.5, D9: existing actions, closed `mode` subtypes; no vocabulary migration).
const REFRESH_DECISION_AUDIT = Object.freeze({
  readAction: 'project_board_read',
  readMigration: '086',
  decisionAction: 'exception_resolve',
  decisionMigration: '066',
  modes: Object.freeze({
    holdRead: 'refresh_hold_read',
    evidenceRead: 'refresh_evidence_read',
    continuationRead: 'continuation_read',
    confirmed: 'continuation_confirmed',
    reconfirmed: 'continuation_reconfirmed',
    ended: 'continuation_ended',
    kept: 'continuation_hold_kept',
    // Step 5 PR-8 (register R-63 ⑨): the private plan read, the confirm, the review, and the SYSTEM invalidation a
    // computation's reconciliation appends on its own transaction (C08 「每一步的…审计可见」, refutation m2).
    changePlanRead: 'change_plan_read',
    changePlanConfirmed: 'change_plan_confirmed',
    changeReviewCompleted: 'change_review_completed',
    changePlanInvalidated: 'change_plan_invalidated',
  }),
})

const HOLD_PAGE_LIMIT_DEFAULT = 20
const HOLD_PAGE_LIMIT_MAX = 50
const PAIR_PAGE_LIMIT_DEFAULT = 200
const PAIR_PAGE_LIMIT_MAX = 200
const READ_RECEIPT_KEY_PREFIX = 'integration:stock-prep:refresh-read-receipt:'
const READ_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000
const READ_RECEIPT_VERSION = 1

const DEMAND_BASES = Object.freeze(['puller_confirmed_same_demand'])
const CANDIDATE_KIND_PREFIX = 'candidate_'
const RELATIONSHIP_KIND_PREFIX = 'relationship_'

class StockPreparationRefreshDecisionError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationRefreshDecisionError'
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

function trimmed(value) {
  return nonBlankString(value) ? value.trim() : null
}

function requestInvalid(field, message = `${field} is invalid`) {
  return new StockPreparationRefreshDecisionError(400, REFRESH_DECISION_ERROR_CODES.REQUEST_INVALID, message, { field })
}

function countBy(values) {
  const out = {}
  for (const value of values) out[value] = (out[value] || 0) + 1
  return Object.fromEntries(Object.keys(out).sort().map((key) => [key, out[key]]))
}

function boundedInteger(value, { field, fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw requestInvalid(field, `${field} must be an integer between ${min} and ${max}`)
  return n
}

function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sortHolds(holds) {
  return holds.slice().sort((left, right) => {
    const a = left.openedAt || ''
    const b = right.openedAt || ''
    if (a !== b) return compareStrings(a, b)
    return compareStrings(left.id, right.id)
  })
}

function isCandidateKind(kind) {
  return kind === 'continuation_candidate' || (typeof kind === 'string' && kind.startsWith(CANDIDATE_KIND_PREFIX))
}

function isRelationshipKind(kind) {
  return typeof kind === 'string' && kind.startsWith(RELATIONSHIP_KIND_PREFIX)
}

// A store read by id: an absent row and a row of ANOTHER tenant / sheet / project are the same 404 (the
// board's rule — never an existence oracle across scopes). Every other store error passes through (503 …).
function translateByIdRead(error, notFound) {
  if (error instanceof StockPreparationRefreshStoreError) {
    if (error.code === REFRESH_STORE_ERROR_CODES.TENANT_MISMATCH) return notFound()
    if (error.code === REFRESH_STORE_ERROR_CODES.CONFIRM_STALE && error.details && /_scope$/.test(String(error.details.reason || ''))) return notFound()
  }
  return error
}

function holdNotFound() {
  return new StockPreparationRefreshDecisionError(404, REFRESH_DECISION_ERROR_CODES.HOLD_NOT_FOUND, 'no hold of this project answers to that id', { field: 'holdId' })
}

function continuationNotFound() {
  return new StockPreparationRefreshDecisionError(404, REFRESH_DECISION_ERROR_CODES.CONTINUATION_NOT_FOUND, 'no relationship of this project answers to that id', { field: 'continuationId' })
}

function assertContext(ctx) {
  if (!isPlainObject(ctx) || !isPlainObject(ctx.scope) || !nonBlankString(ctx.scope.tenantId) || !nonBlankString(ctx.scope.sheetId) || !nonBlankString(ctx.scope.projectNo)) {
    throw new StockPreparationRefreshDecisionError(500, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'a decision needs the route\'s server-held scope', { reason: 'context_scope' })
  }
  if (!nonBlankString(ctx.actorId)) throw new StockPreparationRefreshDecisionError(500, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'a decision needs the proven actor', { reason: 'context_actor' })
  if (!isPlainObject(ctx.consult) || ctx.consult.ok !== true) throw new StockPreparationRefreshDecisionError(503, REFRESH_DECISION_ERROR_CODES.STORE_FAILED, 'a decision needs a successful governance consult', { store: 'governance', operation: 'consult', partial: false })
  if (!ctx.store || typeof ctx.store.readHold !== 'function' || typeof ctx.store.readContinuation !== 'function') {
    throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the continuation store is not wired for decisions', { reason: 'decision_store' })
  }
  if (!ctx.audit || typeof ctx.audit.append !== 'function') {
    throw new StockPreparationRefreshDecisionError(501, 'AUDIT_STORE_UNAVAILABLE', 'stock-preparation audit store is not available; values are not served without an audit trail')
  }
  return ctx
}

function assertDecisionContext(ctx) {
  assertContext(ctx)
  for (const method of ['confirmContinuation', 'reconfirmContinuation', 'endContinuation']) {
    if (typeof ctx.store[method] !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the continuation store is not wired for decisions', { reason: 'decision_store' })
  }
  if (!ctx.projectWriteLock || typeof ctx.projectWriteLock.bumpGenerationWithin !== 'function') {
    throw new StockPreparationRefreshDecisionError(501, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'the sheet write lock offers no in-transaction bump; nothing is decided without it', { reason: 'bump_within' })
  }
  if (typeof ctx.audit.appendWithin !== 'function') {
    throw new StockPreparationRefreshDecisionError(501, 'AUDIT_STORE_UNAVAILABLE', 'the audit store cannot append inside a transaction; nothing is decided without it', { reason: 'append_within' })
  }
  return ctx
}

// ── the read receipt store (U04) ──────────────────────────────────────────────────────────────────

function receiptKey(id) {
  return `${READ_RECEIPT_KEY_PREFIX}${id}`
}

function createReadReceiptStore({ storage, now, idGenerator } = {}) {
  const clock = typeof now === 'function' ? now : () => new Date()
  const newId = typeof idGenerator === 'function' ? idGenerator : () => crypto.randomBytes(16).toString('hex')

  function requireStorage() {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.RECEIPT_STORE_UNAVAILABLE, 'plugin storage is not available for read receipts; the hold page is not served without it', { reason: 'storage' })
    }
    return storage
  }

  function validId(id) {
    return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? id : null
  }

  function sameScope(record, scope) {
    return isPlainObject(record) && record.v === READ_RECEIPT_VERSION
      && record.tenantId === scope.tenantId && record.sheetId === scope.sheetId && record.projectNo === scope.projectNo
  }

  function expired(record) {
    const at = Date.parse(record.expiresAt)
    return !Number.isFinite(at) || at <= clock().getTime()
  }

  // A COPY of the stored record (step-4 review follow-ups, #6565 delta N-1): `record` mutates what it loaded before
  // `set`, and over a live-reference storage (any memory-backed deployment) a throwing `set` would otherwise leave
  // a page the caller was never served on the stored receipt. The record is JSON-shaped (strings, numbers,
  // arrays), so a JSON round trip is exact.
  async function load(id) {
    const key = validId(id)
    if (!key) return null
    const record = await requireStorage().get(receiptKey(key))
    return isPlainObject(record) ? JSON.parse(JSON.stringify(record)) : null
  }

  function publicView(record) {
    const holds = {}
    for (const [holdId, entry] of Object.entries(record.holds)) {
      holds[holdId] = {
        pageCount: entry.pairPageCount,
        pagesServed: entry.pairPagesServed.slice().sort((a, b) => a - b),
        complete: entry.pairPagesServed.length >= entry.pairPageCount,
      }
    }
    return Object.freeze({ id: record.id, expiresAt: record.expiresAt, holds })
  }

  /**
   * Record the pages served by one read. A receipt id that is unknown, expired, another actor's or another
   * scope's starts a FRESH receipt (a read is harmless; the confirm is where the receipt is strict). A hold whose
   * fingerprints moved since the receipt last saw it starts that hold's page set over.
   */
  async function record({ receiptId, scope, actorId, pages }) {
    const store = requireStorage()
    const at = clock()
    let current = receiptId ? await load(receiptId) : null
    if (!current || !sameScope(current, scope) || current.actorId !== actorId || expired(current)) {
      current = {
        v: READ_RECEIPT_VERSION,
        id: newId(),
        tenantId: scope.tenantId,
        sheetId: scope.sheetId,
        projectNo: scope.projectNo,
        actorId,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + READ_RECEIPT_TTL_MS).toISOString(),
        holds: {},
      }
    }
    for (const page of pages) {
      // A page index outside the hold's page count is never recorded (step 5 PR-8: the change-plan page pages on past a
      // written plan's last page while the proposal is longer): only an in-range page can count toward completeness.
      if (!Number.isInteger(page.pairPageIndex) || page.pairPageIndex < 0 || page.pairPageIndex >= page.pairPageCount) continue
      const existing = current.holds[page.holdId]
      const sameHold = existing && existing.fingerprint === page.fingerprint && existing.comparisonFingerprint === page.comparisonFingerprint && existing.evidenceFingerprint === page.evidenceFingerprint && existing.pairPageCount === page.pairPageCount
      const served = sameHold ? new Set(existing.pairPagesServed) : new Set()
      served.add(page.pairPageIndex)
      current.holds[page.holdId] = {
        fingerprint: page.fingerprint,
        comparisonFingerprint: page.comparisonFingerprint,
        evidenceFingerprint: page.evidenceFingerprint,
        pairPageCount: page.pairPageCount,
        pairPagesServed: Array.from(served).sort((a, b) => a - b),
      }
    }
    await store.set(receiptKey(current.id), current)
    return publicView(current)
  }

  /** The confirm's check: strict on every point. Answers `{ ok: true }` or `{ ok: false, reason, pagesServed, pageCount }`. */
  async function verify({ receiptId, scope, actorId, hold }) {
    const current = await load(receiptId)
    if (!current) return { ok: false, reason: 'receipt_absent', pagesServed: 0, pageCount: null }
    if (!sameScope(current, scope)) return { ok: false, reason: 'receipt_scope', pagesServed: 0, pageCount: null }
    if (current.actorId !== actorId) return { ok: false, reason: 'receipt_actor', pagesServed: 0, pageCount: null }
    if (expired(current)) return { ok: false, reason: 'receipt_expired', pagesServed: 0, pageCount: null }
    const entry = current.holds[hold.id]
    if (!entry) return { ok: false, reason: 'hold_not_in_receipt', pagesServed: 0, pageCount: null }
    if (entry.fingerprint !== hold.fingerprint || entry.comparisonFingerprint !== (hold.comparisonFingerprint || null) || entry.evidenceFingerprint !== (hold.evidenceFingerprint || null)) {
      return { ok: false, reason: 'fingerprint_moved', pagesServed: entry.pairPagesServed.length, pageCount: entry.pairPageCount }
    }
    const served = new Set(entry.pairPagesServed)
    for (let index = 0; index < entry.pairPageCount; index += 1) {
      if (!served.has(index)) return { ok: false, reason: 'pages_missing', pagesServed: served.size, pageCount: entry.pairPageCount }
    }
    return { ok: true, pagesServed: served.size, pageCount: entry.pairPageCount }
  }

  return Object.freeze({ record, verify, load })
}

// ── the hold payload (private) ────────────────────────────────────────────────────────────────────

function pairPageCountOf(pairs, pairLimit) {
  if (!Array.isArray(pairs) || pairs.length === 0) return 1
  return Math.ceil(pairs.length / pairLimit)
}

// Slice a detail's `pairs` (and its comparison items, matched by relative path) to one page.
function pagedPairs(detail, pageIndex, pairLimit) {
  const pairs = Array.isArray(detail.pairs) ? detail.pairs : null
  const count = pairPageCountOf(pairs, pairLimit)
  if (pageIndex >= count) throw requestInvalid('pairCursor', 'pairCursor is past the last page of this hold')
  if (!pairs) return { pairs: null, items: null, page: Object.freeze({ index: 0, count: 1, size: pairLimit, next: null }) }
  const start = pageIndex * pairLimit
  const slice = pairs.slice(start, start + pairLimit)
  const paths = new Set(slice.map((pair) => JSON.stringify(pair.relativePath)))
  const allItems = isPlainObject(detail.comparison) && Array.isArray(detail.comparison.items) ? detail.comparison.items : null
  const items = allItems ? allItems.filter((item) => isPlainObject(item) && paths.has(JSON.stringify(item.relativePath))) : null
  return { pairs: slice, items, page: Object.freeze({ index: pageIndex, count, size: pairLimit, next: pageIndex + 1 < count ? pageIndex + 1 : null }) }
}

function holdHistory(detail) {
  const history = isPlainObject(detail) && isPlainObject(detail.demand) ? detail.demand.history : (isPlainObject(detail) ? detail.history : undefined)
  return EVIDENCE_HISTORY_STATUSES.includes(history) ? history : 'history_unknown'
}

/** One hold as the page shows it (PRIVATE), with its pairs paged. `candidateId` is the pairing fingerprint. */
function holdPayload(hold, { pairPageIndex, pairLimit }) {
  const detail = isPlainObject(hold.detail) ? hold.detail : {}
  const base = {
    id: hold.id,
    kind: hold.kind,
    status: hold.status,
    confirmable: hold.confirmable === true,
    notConfirmableReason: hold.notConfirmableReason || null,
    shapeToken: hold.shapeToken || null,
    runbookOnly: hold.runbookOnly === true,
    continuationId: hold.continuationId || null,
    fingerprint: hold.fingerprint,
    comparisonFingerprint: hold.comparisonFingerprint || null,
    evidenceFingerprint: hold.evidenceFingerprint || null,
    pairingFingerprint: hold.pairingFingerprint || null,
    openedAt: hold.openedAt || null,
    lastSeenAt: hold.lastSeenAt || null,
    history: holdHistory(detail),
    candidates: [],
    verification: null,
    contentChanges: [],
    detail: null,
    pairPage: null,
  }
  if (isCandidateKind(hold.kind) && detail.scope !== 'project') {
    const paged = pagedPairs(detail, pairPageIndex, pairLimit)
    base.pairPage = paged.page
    base.candidates = [{
      candidateId: hold.pairingFingerprint || null,
      componentSourceId: detail.componentSourceId === undefined ? null : detail.componentSourceId,
      newPositionKeys: Array.isArray(detail.newPositionKeys) ? detail.newPositionKeys : [],
      oldRootKeys: Array.isArray(detail.oldRootKeys) ? detail.oldRootKeys : [],
      oldRootRecordIds: Array.isArray(detail.oldRootRecordIds) ? detail.oldRootRecordIds : [],
      pairs: paged.pairs,
      comparison: isPlainObject(detail.comparison) ? { outcome: detail.comparison.outcome, items: paged.items, parentEdgeUsage: detail.comparison.parentEdgeUsage === undefined ? null : detail.comparison.parentEdgeUsage } : null,
      parentEdgeUsage: isPlainObject(detail.comparison) && detail.comparison.parentEdgeUsage !== undefined ? detail.comparison.parentEdgeUsage : null,
      demand: detail.demand === undefined ? null : detail.demand,
      history: base.history,
      shapeSubTokens: Array.isArray(detail.shapeSubTokens) ? detail.shapeSubTokens : [],
      pairingProblems: Array.isArray(detail.pairingProblems) ? detail.pairingProblems : [],
      duplicateResolvedRootKey: detail.duplicateResolvedRootKey === true,
    }]
    return base
  }
  if (isRelationshipKind(hold.kind)) {
    const paged = pagedPairs(detail, pairPageIndex, pairLimit)
    base.pairPage = paged.page
    base.verification = {
      verdict: detail.verdict === undefined ? null : detail.verdict,
      statusReason: detail.statusReason === undefined ? null : detail.statusReason,
      steps: isPlainObject(detail.steps) ? detail.steps : {},
      pairs: paged.pairs,
      pairingProblems: Array.isArray(detail.pairingProblems) ? detail.pairingProblems : [],
      comparison: isPlainObject(detail.comparison) ? { outcome: detail.comparison.outcome, items: paged.items, parentEdgeUsage: detail.comparison.parentEdgeUsage === undefined ? null : detail.comparison.parentEdgeUsage } : null,
      demand: detail.demand === undefined ? null : detail.demand,
      componentNewPositionCount: Number.isInteger(detail.componentNewPositionCount) ? detail.componentNewPositionCount : null,
    }
    return base
  }
  if (hold.kind === 'content_change') {
    base.pairPage = Object.freeze({ index: 0, count: 1, size: pairLimit, next: null })
    base.contentChanges = [{
      recordId: detail.recordId === undefined ? null : detail.recordId,
      recordVersion: detail.recordVersion === undefined ? null : detail.recordVersion,
      key: detail.key === undefined ? null : detail.key,
      reason: detail.reason === undefined ? null : detail.reason,
      fields: isPlainObject(detail.fields) ? detail.fields : {},
      inContinuation: detail.inContinuation === undefined ? null : detail.inContinuation,
      humanColumnsPresent: isPlainObject(detail.humanColumnsPresent) ? detail.humanColumnsPresent : {},
    }]
    return base
  }
  // Every other kind (dropped order heads, project-level incomplete evidence, structure changes): the detail as
  // the computation recorded it, one page.
  base.pairPage = Object.freeze({ index: 0, count: 1, size: pairLimit, next: null })
  base.detail = detail
  return base
}

function refreshSummary(consult) {
  const state = readProjectRefreshState(consult)
  return Object.freeze({
    readable: state.readable === true,
    status: state.status,
    governed: state.governed,
    counts: state.counts || null,
    pilot: Boolean(consult.pilot && consult.pilot.enabled === true),
    holdSetFingerprint: consult.state && consult.state.holdSetFingerprint ? consult.state.holdSetFingerprint : null,
    decisionVersion: consult.decisionVersionObserved,
  })
}

function auditReadRow(ctx, mode, detail) {
  return {
    tenantId: ctx.scope.tenantId,
    action: REFRESH_DECISION_AUDIT.readAction,
    actor: ctx.actorId,
    mode,
    detail: { ...detail, tenantClaimVerified: ctx.tenantClaimVerified === true },
  }
}

// ── GET holds ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The hold page. `query`: `{ cursor?, limit?, holdId?, pairCursor?, pairLimit?, receipt? }` — already allow-listed
 * by the route. `holdId` + `pairCursor` serve ONE hold's pair page; otherwise holds are paged (`cursor` = the id of
 * the last hold served, `limit` ≤ 50). The audit row (project_board_read / refresh_hold_read, page index and counts)
 * is appended BEFORE the body is returned: an audit failure means no values are served.
 */
async function listHolds(ctx, query = {}) {
  assertContext(ctx)
  if (!ctx.receipts || typeof ctx.receipts.record !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.RECEIPT_STORE_UNAVAILABLE, 'read receipts are not wired; the hold page is not served without them', { reason: 'receipts' })
  const limit = boundedInteger(query.limit, { field: 'limit', fallback: HOLD_PAGE_LIMIT_DEFAULT, min: 1, max: HOLD_PAGE_LIMIT_MAX })
  const pairLimit = boundedInteger(query.pairLimit, { field: 'pairLimit', fallback: PAIR_PAGE_LIMIT_DEFAULT, min: 1, max: PAIR_PAGE_LIMIT_MAX })
  const pairCursor = boundedInteger(query.pairCursor, { field: 'pairCursor', fallback: 0, min: 0, max: 1000000 })
  const holdId = trimmed(query.holdId)
  const cursor = trimmed(query.cursor)
  const receiptId = trimmed(query.receipt)
  if (pairCursor > 0 && !holdId) throw requestInvalid('pairCursor', 'pairCursor needs holdId')
  if (query.receipt !== undefined && query.receipt !== null && query.receipt !== '' && !/^[0-9a-f]{32}$/.test(String(query.receipt))) throw requestInvalid('receipt')

  const open = sortHolds(ctx.consult.holds.filter((hold) => hold.status === 'open'))
  let pageHolds
  let pageStart = 0
  let next = null
  if (holdId) {
    const one = open.find((hold) => hold.id === holdId)
    if (!one) throw holdNotFound()
    pageHolds = [one]
    pageStart = open.indexOf(one)
  } else {
    if (cursor) {
      const at = open.findIndex((hold) => hold.id === cursor)
      if (at < 0) throw requestInvalid('cursor', 'cursor names no open hold of this project; read the page again')
      pageStart = at + 1
    }
    pageHolds = open.slice(pageStart, pageStart + limit)
    next = pageStart + limit < open.length ? pageHolds[pageHolds.length - 1].id : null
  }
  const entries = pageHolds.map((hold) => holdPayload(hold, { pairPageIndex: holdId ? pairCursor : 0, pairLimit }))
  const refresh = refreshSummary(ctx.consult)
  // Order (PR-4 review note 0): the audit row FIRST, then the receipt, then the body. A page the audit store
  // refused was never served, so the receipt must not vouch for it (a confirm trusts the receipt, not the audit).
  await ctx.audit.append(auditReadRow(ctx, REFRESH_DECISION_AUDIT.modes.holdRead, {
    operation: 'refresh_hold_read',
    page: Math.floor(pageStart / limit),
    pairPage: holdId ? pairCursor : 0,
    count: entries.length,
    openHolds: open.length,
    kinds: countBy(entries.map((entry) => entry.kind)),
  }))
  // A project that is NOT governed (no step-4 row at all) has nothing to confirm: no receipt is issued for it
  // (PR-4 review N4 — a receipt is a plugin_kv row that is never swept; the page is 200 for any pull-tier caller).
  const readReceipt = refresh.status === 'not_governed'
    ? null
    : await ctx.receipts.record({
      receiptId,
      scope: ctx.scope,
      actorId: ctx.actorId,
      pages: entries.map((entry) => ({
        holdId: entry.id,
        fingerprint: entry.fingerprint,
        comparisonFingerprint: entry.comparisonFingerprint,
        evidenceFingerprint: entry.evidenceFingerprint,
        pairPageCount: entry.pairPage ? entry.pairPage.count : 1,
        pairPageIndex: entry.pairPage ? entry.pairPage.index : 0,
      })),
    })
  return Object.freeze({
    refresh,
    holdSetFingerprint: ctx.consult.state && ctx.consult.state.holdSetFingerprint ? ctx.consult.state.holdSetFingerprint : null,
    decisionVersion: ctx.consult.decisionVersionObserved,
    page: { holds: entries, next, limit, pairLimit },
    readReceipt,
  })
}

// ── GET holds/:holdId/evidence ────────────────────────────────────────────────────────────────────

function observationsOfDemand(demand) {
  if (!isPlainObject(demand)) return []
  const out = []
  if (isPlainObject(demand.oldRoot)) out.push({ role: 'old_root', ...demand.oldRoot })
  if (isPlainObject(demand.newParent)) out.push({ role: 'new_parent', ...demand.newParent })
  return out
}

async function readHoldById(ctx, holdId) {
  let hold
  try {
    hold = await ctx.store.readHold({ ...ctx.scope, holdId })
  } catch (error) {
    throw translateByIdRead(error, holdNotFound)
  }
  if (!hold) throw holdNotFound()
  return hold
}

async function readContinuationById(ctx, continuationId) {
  let found
  try {
    found = await ctx.store.readContinuation({ ...ctx.scope, continuationId })
  } catch (error) {
    throw translateByIdRead(error, continuationNotFound)
  }
  if (!found) throw continuationNotFound()
  return found
}

/**
 * The evidence behind one hold: the CURRENT side from the computation that opened it (the demand facts it
 * recorded) and the HISTORY side — the relationship's own evidence snapshot when one names this component's old
 * root (or the hold names a relationship), else `history_unknown`. There is no 2c store (§3), so
 * `demand_evidence_store` never answers here. One page; `cursor` is accepted and `next` is always null.
 */
async function readHoldEvidence(ctx, holdId, query = {}) {
  assertContext(ctx)
  const id = trimmed(holdId)
  if (!id) throw requestInvalid('holdId')
  if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '' && String(query.cursor) !== '0') throw requestInvalid('cursor', 'the evidence has one page')
  const hold = await readHoldById(ctx, id)
  const detail = isPlainObject(hold.detail) ? hold.detail : {}
  const demand = isPlainObject(detail.demand) ? detail.demand : null
  const current = demand
    ? {
      completeness: { status: demand.completenessStatus === undefined ? null : demand.completenessStatus, relevantComplete: demand.relevantComplete === true, unusableReason: demand.unusableReason === undefined ? null : demand.unusableReason },
      classification: demand.classification === undefined ? null : demand.classification,
      observations: observationsOfDemand(demand),
      relevantObservationDigests: Array.isArray(demand.relevantObservationDigests) ? demand.relevantObservationDigests : [],
      subTokens: Array.isArray(demand.subTokens) ? demand.subTokens : [],
    }
    : {
      completeness: { status: null, relevantComplete: false, unusableReason: detail.unusableReason === undefined ? null : detail.unusableReason },
      classification: null,
      observations: [],
      relevantObservationDigests: Array.isArray(detail.observationDigests) ? detail.observationDigests : [],
      subTokens: [],
      rules: Array.isArray(detail.rules) ? detail.rules : [],
      expandedOccurrences: Array.isArray(detail.expandedOccurrences) ? detail.expandedOccurrences : [],
    }
  // The history side: the relationship this hold names, or the one that claims this candidate's old root.
  let history = { status: 'history_unknown' }
  const oldRootRecordId = isPlainObject(hold.subject) && nonBlankString(hold.subject.oldRootRecordId) ? hold.subject.oldRootRecordId : null
  const named = ctx.consult.continuations.find((entry) => (hold.continuationId && entry.id === hold.continuationId) || (oldRootRecordId && entry.oldRootRecordId === oldRootRecordId))
  if (named) {
    const snapshot = isPlainObject(named.evidenceSnapshot) ? named.evidenceSnapshot : null
    history = {
      status: 'relationship_snapshot',
      continuationId: named.id,
      continuationStatus: named.status,
      confirmedAt: named.confirmedAt || null,
      evidenceHistoryStatus: named.evidenceHistoryStatus || 'history_unknown',
      observations: snapshot ? observationsOfDemand(snapshot.demand) : [],
      comparison: snapshot && isPlainObject(snapshot.comparison) ? snapshot.comparison : null,
    }
  }
  await ctx.audit.append(auditReadRow(ctx, REFRESH_DECISION_AUDIT.modes.evidenceRead, {
    operation: 'refresh_evidence_read',
    kind: hold.kind,
    holdStatus: hold.status,
    historyStatus: history.status,
    observationCount: current.observations.length,
  }))
  return Object.freeze({ holdId: hold.id, kind: hold.kind, status: hold.status, current, history, next: null })
}

// ── GET continuations/:id ─────────────────────────────────────────────────────────────────────────

async function readContinuation(ctx, continuationId) {
  assertContext(ctx)
  const id = trimmed(continuationId)
  if (!id) throw requestInvalid('continuationId')
  const found = await readContinuationById(ctx, id)
  const holds = ctx.consult.holds.filter((hold) => hold.continuationId === id).map((hold) => ({ id: hold.id, kind: hold.kind, status: hold.status, confirmable: hold.confirmable === true, runbookOnly: hold.runbookOnly === true, fingerprint: hold.fingerprint }))
  await ctx.audit.append(auditReadRow(ctx, REFRESH_DECISION_AUDIT.modes.continuationRead, {
    operation: 'continuation_read',
    status: found.continuation.status,
    revision: found.continuation.revision,
    memberCount: found.members.length,
    openHoldCount: holds.filter((hold) => hold.status === 'open').length,
  }))
  return Object.freeze({ continuation: found.continuation, members: found.members, holds })
}

// ── the pre-transaction refusals shared by confirm and end ────────────────────────────────────────

function assertPilot(consult) {
  if (!(consult.pilot && consult.pilot.enabled === true)) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.NOT_PILOT, 'this project is not a pilot of the batch refresh; a relationship cannot be confirmed for it', { governed: consult.governed === true, partial: false })
  }
}

function assertNoRecoveryPending(consult) {
  const recovery = previewRecoveryOf(consult)
  if (recovery) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.RECOVERY_PENDING, 'an earlier execution of this project did not finish cleanly; nothing is decided until it is recovered', {
      state: 'failed_pending_recovery',
      openExecutions: recovery.openExecutions,
      partial: false,
    })
  }
}

function runbookOnlyHolds(consult) {
  return consult.holds.filter((hold) => hold.status === 'open' && hold.runbookOnly === true)
}

function assertNoRunbookOnlyHoldForConfirm(consult) {
  const runbook = runbookOnlyHolds(consult)
  if (runbook.length > 0) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_NOT_ALLOWED, 'this project has a relationship escalated to specialist repair; no relationship is confirmed until the runbook closes it', {
      reason: 'runbook_only_hold_open',
      holdCount: runbook.length,
      partial: false,
    })
  }
}

function decisionHooks(ctx, { mode, subjectIdOf, detailOf }) {
  return {
    bumpWithin: (trx, scopeKey, options) => ctx.projectWriteLock.bumpGenerationWithin(trx, scopeKey, options),
    // E09: the audit row rides the decision's own transaction handle; its failure rolls the decision back.
    auditWithin: (trx, event) => ctx.audit.appendWithin(trx, {
      tenantId: ctx.scope.tenantId,
      action: REFRESH_DECISION_AUDIT.decisionAction,
      actor: ctx.actorId,
      subjectId: subjectIdOf(event),
      mode,
      detail: { ...detailOf(event), tenantClaimVerified: ctx.tenantClaimVerified === true },
    }),
  }
}

// ── POST continuations/confirm ────────────────────────────────────────────────────────────────────

function normalizeConfirmBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  const holdId = trimmed(body.holdId)
  if (!holdId) throw requestInvalid('holdId')
  const echo = {}
  for (const field of ['holdFingerprint', 'comparisonFingerprint', 'evidenceFingerprint']) {
    const value = trimmed(body[field])
    if (!value) throw requestInvalid(field, `${field} is required: a confirm binds to what the server last computed`)
    echo[field] = value
  }
  const readReceipt = trimmed(body.readReceipt)
  if (!readReceipt) throw requestInvalid('readReceipt', 'readReceipt is required: a confirm needs the pages it read')
  const candidateId = body.candidateId === undefined || body.candidateId === null ? null : trimmed(body.candidateId)
  if (body.candidateId !== undefined && body.candidateId !== null && !candidateId) throw requestInvalid('candidateId')
  let continuation = null
  if (body.continuation !== undefined && body.continuation !== null) {
    if (!isPlainObject(body.continuation) || !trimmed(body.continuation.id) || !Number.isInteger(body.continuation.revision) || body.continuation.revision < 1) {
      throw requestInvalid('continuation', 'continuation needs { id, revision }')
    }
    continuation = { id: body.continuation.id.trim(), revision: body.continuation.revision }
  }
  let basis = null
  if (body.basis !== undefined && body.basis !== null) {
    if (!isPlainObject(body.basis) || !DEMAND_BASES.includes(body.basis.kind)) throw requestInvalid('basis.kind', 'basis.kind must be a phase-1 demand basis token')
    if (body.basis.note !== undefined && body.basis.note !== null && typeof body.basis.note !== 'string') throw requestInvalid('basis.note')
    basis = { kind: body.basis.kind, ...(typeof body.basis.note === 'string' ? { note: body.basis.note } : {}) }
  }
  let acknowledge = null
  if (body.acknowledge !== undefined && body.acknowledge !== null) {
    if (!isPlainObject(body.acknowledge) || (body.acknowledge.historyUnknown !== undefined && typeof body.acknowledge.historyUnknown !== 'boolean')) throw requestInvalid('acknowledge')
    acknowledge = { historyUnknown: body.acknowledge.historyUnknown === true }
  }
  return Object.freeze({ holdId, echo, readReceipt, candidateId, continuation, basis, acknowledge })
}

/**
 * The confirm (§8.2 + §8.3): refusals before the transaction in the module header's order, then the store's
 * transaction with the lock's in-transaction bump and the audit row on the same handle. Answers 201's body.
 */
async function confirm(ctx, body) {
  assertDecisionContext(ctx)
  if (!ctx.receipts || typeof ctx.receipts.verify !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.RECEIPT_STORE_UNAVAILABLE, 'read receipts are not wired; nothing is confirmed without them', { reason: 'receipts' })
  const input = normalizeConfirmBody(body)
  const { consult } = ctx
  assertPilot(consult)
  assertNoRecoveryPending(consult)
  assertNoRunbookOnlyHoldForConfirm(consult)
  const hold = await readHoldById(ctx, input.holdId)
  if (hold.status !== 'open') throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_STALE, 'the hold being confirmed is no longer open; read the page again', { reason: 'hold_not_open', status: hold.status })
  let mode
  if (hold.kind === 'continuation_candidate') {
    if (input.continuation) throw requestInvalid('continuation', 'a candidate confirm names no continuation')
    if (!input.candidateId) throw requestInvalid('candidateId', 'candidateId is required for a candidate')
    if (!input.basis) throw requestInvalid('basis', 'basis is required for a candidate')
    mode = 'confirm'
  } else if (hold.kind === 'relationship_reconfirm') {
    if (!input.continuation) throw requestInvalid('continuation', 'a re-confirm names the relationship { id, revision }')
    if (input.candidateId) throw requestInvalid('candidateId', 'a re-confirm carries no candidateId')
    if (input.continuation.id !== hold.continuationId) throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_STALE, 'the hold names another relationship; read the page again', { reason: 'continuation' })
    mode = 'reconfirm'
  } else {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_NOT_ALLOWED, 'this hold has no confirm control', { reason: 'kind', kind: hold.kind })
  }
  if (hold.confirmable !== true) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_NOT_ALLOWED, 'this hold has no confirm control', { reason: 'not_confirmable', kind: hold.kind, notConfirmableReason: hold.notConfirmableReason || null })
  }
  if (mode === 'confirm' && input.candidateId !== (hold.pairingFingerprint || null)) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_STALE, 'the candidate being confirmed is not the one the server computes; read the page again', { reason: 'candidate' })
  }
  if (holdHistory(hold.detail) === 'history_unknown' && !(input.acknowledge && input.acknowledge.historyUnknown === true)) {
    throw requestInvalid('acknowledge.historyUnknown', 'the history of this demand is unknown; the confirm must acknowledge it')
  }
  const receipt = await ctx.receipts.verify({ receiptId: input.readReceipt, scope: ctx.scope, actorId: ctx.actorId, hold })
  if (!receipt.ok) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.READ_RECEIPT_INCOMPLETE, 'the read receipt does not cover every page of this hold; read the whole hold, then confirm', {
      reason: receipt.reason,
      pagesServed: receipt.pagesServed,
      pageCount: receipt.pageCount,
      partial: false,
    })
  }
  if (hold.fingerprint !== input.echo.holdFingerprint || (hold.comparisonFingerprint || null) !== input.echo.comparisonFingerprint || (hold.evidenceFingerprint || null) !== input.echo.evidenceFingerprint) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_STALE, 'the hold being confirmed is no longer what the server computes; read the page again', { reason: 'fingerprint' })
  }
  const sourceIdentity = refreshSourceIdentity({ action: ctx.action, tenantId: ctx.scope.tenantId })
  const hooks = decisionHooks(ctx, {
    mode: mode === 'confirm' ? REFRESH_DECISION_AUDIT.modes.confirmed : REFRESH_DECISION_AUDIT.modes.reconfirmed,
    subjectIdOf: (event) => event.continuationId,
    detailOf: (event) => ({
      operation: event.operation,
      revision: event.revision,
      memberCount: Number.isInteger(event.memberCount) ? event.memberCount : 0,
      comparisonOutcome: nonBlankString(event.comparisonOutcome) ? event.comparisonOutcome : 'unknown',
      historyStatus: nonBlankString(event.historyStatus) ? event.historyStatus : 'history_unknown',
      ...(nonBlankString(event.previousStatusReason) ? { previousStatusReason: event.previousStatusReason } : {}),
      holdCount: 1,
    }),
  })
  const decided = mode === 'confirm'
    ? await ctx.store.confirmContinuation({ ...ctx.scope, holdId: hold.id, confirmedBy: ctx.actorId, echo: input.echo, basis: input.basis, sourceIdentity }, hooks)
    : await ctx.store.reconfirmContinuation({ ...ctx.scope, continuationId: input.continuation.id, revision: input.continuation.revision, holdId: hold.id, confirmedBy: ctx.actorId, echo: input.echo, sourceIdentity }, hooks)
  return Object.freeze({
    continuationId: decided.continuationId,
    revision: decided.revision,
    holdId: decided.holdId,
    memberCount: Number.isInteger(decided.memberCount) ? decided.memberCount : null,
    decisionVersion: decided.decisionVersion,
    generation: decided.generation ? decided.generation.generation : null,
    state: 'confirmed_pending_execution',
    nextStep: 'preview_again',
  })
}

// ── POST holds/:holdId/keep ───────────────────────────────────────────────────────────────────────

/** 「暂不处理」: the hold stays open, nothing changes; ONE audit row says the puller looked and kept it. */
async function keepHold(ctx, holdId, body = {}) {
  assertContext(ctx)
  const id = trimmed(holdId)
  if (!id) throw requestInvalid('holdId')
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  const echo = body.holdFingerprint === undefined || body.holdFingerprint === null ? null : trimmed(body.holdFingerprint)
  if (body.holdFingerprint !== undefined && body.holdFingerprint !== null && !echo) throw requestInvalid('holdFingerprint')
  const hold = await readHoldById(ctx, id)
  if (hold.status !== 'open') throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_STALE, 'the hold is no longer open; read the page again', { reason: 'hold_not_open', status: hold.status })
  if (echo && echo !== hold.fingerprint) throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CONFIRM_STALE, 'the hold is no longer what the server computes; read the page again', { reason: 'hold_fingerprint' })
  await ctx.audit.append({
    tenantId: ctx.scope.tenantId,
    action: REFRESH_DECISION_AUDIT.decisionAction,
    actor: ctx.actorId,
    subjectId: hold.id,
    mode: REFRESH_DECISION_AUDIT.modes.kept,
    detail: { operation: 'continuation_hold_kept', kind: hold.kind, confirmable: hold.confirmable === true, runbookOnly: hold.runbookOnly === true, tenantClaimVerified: ctx.tenantClaimVerified === true },
  })
  return Object.freeze({ kept: true, holdId: hold.id })
}

// ── POST continuations/:id/end ────────────────────────────────────────────────────────────────────

function normalizeEndBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  if (!Number.isInteger(body.revision) || body.revision < 1) throw requestInvalid('revision', 'revision must be a positive integer')
  if (!END_OUTCOMES.includes(body.outcome)) throw requestInvalid('outcome', 'outcome is not an end outcome')
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw requestInvalid('note')
  // The hold a release decides from, as the page showed it (PR-4 review B1): both keys or neither; a release
  // without them binds to the request's own consult (below); any other outcome carries none.
  const factsGiven = ['factsHoldId', 'factsHoldFingerprint'].filter((field) => body[field] !== undefined && body[field] !== null)
  let facts = null
  if (factsGiven.length > 0) {
    if (body.outcome !== 'release_to_normal_refresh') throw requestInvalid(factsGiven[0], `${factsGiven[0]} names the hold a release decides from; this outcome carries none`)
    const holdId = trimmed(body.factsHoldId)
    const holdFingerprint = trimmed(body.factsHoldFingerprint)
    if (!holdId) throw requestInvalid('factsHoldId', 'factsHoldId must name the open relationship_reconfirm hold the release decides from')
    if (!holdFingerprint) throw requestInvalid('factsHoldFingerprint', 'factsHoldFingerprint must repeat that hold\'s fingerprint')
    facts = Object.freeze({ holdId, holdFingerprint })
  }
  return Object.freeze({ revision: body.revision, outcome: body.outcome, note: typeof body.note === 'string' ? body.note : null, facts })
}

/**
 * The end (§8.4). `release_to_normal_refresh` is decided by the STORE, inside its transaction, from THE open
 * relationship_reconfirm hold naming the continuation as it is under the state-row lock (`new_position_removed`
 * with `componentNewPositionCount === 0`; PR-4 review B1 — the consult is a snapshot, a computation may land
 * after it). This module only BINDS the release to the hold the puller was shown: the body's `factsHoldId` +
 * `factsHoldFingerprint` (PR-7 sends them), else the request's own consult's open relationship_reconfirm hold —
 * the store refuses STALE `facts_moved` when the row under the lock is another one. The body cannot carry the
 * precondition itself (the route's allow-list refuses the key). `superseded_by_new_confirmation` is
 * confirm-only (the store refuses it before any statement).
 */
async function end(ctx, continuationId, body) {
  assertDecisionContext(ctx)
  const id = trimmed(continuationId)
  if (!id) throw requestInvalid('continuationId')
  const input = normalizeEndBody(body)
  const { consult } = ctx
  assertNoRecoveryPending(consult)
  if (input.outcome === 'release_to_normal_refresh' && runbookOnlyHolds(consult).length > 0) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.END_OUTCOME_NOT_ADMISSIBLE, 'this project has a relationship escalated to specialist repair; nothing is released until the runbook closes it', {
      reason: 'runbook_only_hold_open',
      outcome: input.outcome,
      holdCount: runbookOnlyHolds(consult).length,
      partial: false,
    })
  }
  const found = await readContinuationById(ctx, id)
  let facts = input.facts
  if (input.outcome === 'release_to_normal_refresh' && !facts) {
    const about = consult.holds.filter((hold) => hold.status === 'open' && hold.kind === 'relationship_reconfirm' && hold.continuationId === id)
    if (about.length === 0) throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.END_OUTCOME_NOT_ADMISSIBLE, 'no open computation names this relationship; preview again, then end it', { reason: 'no_open_hold', outcome: input.outcome })
    const latest = sortHolds(about)[about.length - 1]
    facts = Object.freeze({ holdId: latest.id, holdFingerprint: latest.fingerprint })
  }
  const hooks = decisionHooks(ctx, {
    mode: REFRESH_DECISION_AUDIT.modes.ended,
    subjectIdOf: (event) => event.continuationId,
    detailOf: (event) => ({
      operation: event.operation,
      revision: event.revision,
      endedOutcome: event.endedOutcome,
      holdsResolved: Number.isInteger(event.holdsResolved) ? event.holdsResolved : 0,
      holdsEscalated: Number.isInteger(event.holdsEscalated) ? event.holdsEscalated : 0,
    }),
  })
  const ended = await ctx.store.endContinuation({
    ...ctx.scope,
    continuationId: found.continuation.id,
    revision: input.revision,
    outcome: input.outcome,
    note: input.note,
    endedBy: ctx.actorId,
    ...(facts ? { facts } : {}),
  }, hooks)
  return Object.freeze({
    continuationId: ended.continuationId,
    status: 'ended',
    endedOutcome: ended.endedOutcome,
    holdsResolved: ended.holdsResolved,
    holdsEscalated: ended.holdsEscalated,
    decisionVersion: ended.decisionVersion,
    nextStep: 'preview_again',
  })
}

// ── step 5 PR-8: the change plan (design §10.3 (1)-(5), §13; plan §3.4 steps 2 and 5; register R-63) ────────────────
//
//   readChangePlanCurrent  GET  …/refresh/change-plans/current      the PROPOSAL the open content holds make (what a
//                                                                   confirm binds: hold ids, hold-set fingerprint, plan
//                                                                   fingerprint, source digest, the records paged) and
//                                                                   the CURRENT pending plan (its records with
//                                                                   baseline / before / after; for a written plan the
//                                                                   values the sheet holds NOW and their digest) —
//                                                                   audited before the receipt and the body
//   confirmChangePlan      POST …/refresh/change-plans/confirm      the whole open content-class hold set as ONE plan
//   completeChangeReview   POST …/refresh/change-reviews/complete   the review of the written plan, bound to the
//                                                                   content the sheet holds (the receipt over the
//                                                                   current diff + the digest echo)
// Same server-held context, receipts and hooks as the continuation decisions. Pull tier (D-14): the reviewer is the
// puller (plan §10); the same person may confirm and review — two operations, two audit rows (C11).

const RECORD_PAGE_LIMIT_DEFAULT = 100
const RECORD_PAGE_LIMIT_MAX = 200

function changePlanNotFound() {
  return new StockPreparationRefreshDecisionError(404, REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_NOT_FOUND, 'no change plan of this project answers to that id', { field: 'changePlanId' })
}

function changePlanDecisionError(code, reason, extra = {}) {
  const messages = {
    [REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE]: 'the change plan is no longer what the server computes; read the page again',
    [REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_NOT_ALLOWED]: 'this change cannot be confirmed as a change plan',
    [REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT]: 'a structure change is open on this project; a content change plan is not confirmed while it is',
    [REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_STALE]: 'the change being reviewed is no longer what the sheet holds; read the page again',
    [REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_BLOCKED]: 'something else on this project is still open; the review completes after it',
  }
  return new StockPreparationRefreshDecisionError(409, code, messages[code] || 'refused', { ...(reason ? { reason } : {}), partial: false, ...extra })
}

function templateOf(ctx) {
  return normalizeStockPreparationTemplate(ctx.action && ctx.action.template ? ctx.action.template : STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
}

// The human columns a record's presence booleans name (the template's human band; values never leave as values).
function humanFieldIdsOf(template) {
  return derivePackAwarePlmWritableFields({ templateFields: template.fields }).humanPreservedFieldIds
}

function isBlankCell(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

// The consult's OPEN holds by class (the confirm's set is EXACTLY the content-class ones).
function holdClassesOf(consult) {
  const open = consult.holds.filter((hold) => hold.status === 'open')
  return {
    open,
    content: open.filter(pairing.isContentClassHold),
    structure: open.filter(pairing.isStructureClassHold),
    runbook: open.filter((hold) => hold.runbookOnly === true),
  }
}

// THE PROPOSAL: the record set the open content holds describe and the fingerprint a confirm must echo (the same pure
// derivation the store repeats under the lock). `blocked` names why no confirm can succeed right now (a values-free
// token), so the page shows it instead of offering a control that is refused.
function proposalOf(ctx) {
  const { consult } = ctx
  const classes = holdClassesOf(consult)
  const state = consult.state || {}
  const sourceContentDigest = state.lastComputationSourceContentDigest || null
  let records = []
  let recordsBlocked = null
  try {
    records = pairing.changePlanRecordsFromHolds(classes.content)
  } catch (error) {
    recordsBlocked = error && error.details && error.details.reason === 'record_unbound' ? 'record_unbound' : 'records_malformed'
  }
  // The token names what the confirm would refuse FIRST (confirmChangePlan's own order: recovery, S25, C07, the empty
  // set, the record binding, then the echoes), so the page never offers a control the server refuses for another reason.
  let blocked = null
  if (previewRecoveryOf(consult)) blocked = 'recovery_pending'
  else if (classes.runbook.length > 0) blocked = 'runbook_only_hold_open'
  else if (classes.structure.length > 0) blocked = 'structure_change_present'
  else if (classes.content.length === 0) blocked = 'no_content_hold'
  else if (recordsBlocked) blocked = recordsBlocked
  else if (!sourceContentDigest) blocked = 'source_unknown'
  return {
    classes,
    records,
    blocked,
    holdSetFingerprint: state.holdSetFingerprint || null,
    sourceContentDigest,
    planFingerprint: records.length > 0 && sourceContentDigest
      ? pairing.changePlanFingerprintOf({ projectNo: ctx.scope.projectNo, records, sourceContentDigest })
      : null,
  }
}

// One page of a record list (the proposal and each plan page on the SAME cursor; a list shorter than the cursor answers
// an empty page — the caller refuses a cursor past EVERY list).
function recordPage(records, { cursor, limit }) {
  const pageCount = Math.max(1, Math.ceil(records.length / limit))
  const start = cursor * limit
  return { slice: cursor < pageCount ? records.slice(start, start + limit) : [], page: Object.freeze({ index: cursor, count: pageCount, size: limit, next: cursor + 1 < pageCount ? cursor + 1 : null }) }
}

/**
 * GET …/refresh/change-plans/current (PRIVATE, pull tier). `query`: `{ recordCursor?, recordLimit?, receipt? }`, already
 * allow-listed. One audited read of the sheet (the table-action ownership wall runs first, in the context's
 * `readSheetRows`) whenever there is a record to show: per record which human columns hold a value (C01 「既有人工填写可
 * 见」, never the value) and, for a WRITTEN plan, the value the sheet holds now and the digest the review binds. Order
 * (PR-4 note 0): the audit row, then the receipt (a written plan's current diff, recorded as a pseudo-hold page:
 * id = plan id, fingerprint = plan fingerprint, comparison = written digest, evidence = current digest), then the body.
 * No receipt for a not-governed project (N4).
 */
async function readChangePlanCurrent(ctx, query = {}) {
  assertContext(ctx)
  if (!ctx.receipts || typeof ctx.receipts.record !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.RECEIPT_STORE_UNAVAILABLE, 'read receipts are not wired; the change-plan page is not served without them', { reason: 'receipts' })
  if (typeof ctx.store.readChangePlan !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the continuation store cannot read change plans', { reason: 'decision_store' })
  const limit = boundedInteger(query.recordLimit, { field: 'recordLimit', fallback: RECORD_PAGE_LIMIT_DEFAULT, min: 1, max: RECORD_PAGE_LIMIT_MAX })
  const cursor = boundedInteger(query.recordCursor, { field: 'recordCursor', fallback: 0, min: 0, max: 1000000 })
  const receiptId = trimmed(query.receipt)
  if (query.receipt !== undefined && query.receipt !== null && query.receipt !== '' && !/^[0-9a-f]{32}$/.test(String(query.receipt))) throw requestInvalid('receipt')
  const template = templateOf(ctx)
  const templateFields = plannerInternals.fieldMapForTemplate(template)
  const humanFieldIds = humanFieldIdsOf(template)
  const refresh = refreshSummary(ctx.consult)
  const proposal = proposalOf(ctx)
  const pending = Array.isArray(ctx.consult.changePlans) ? ctx.consult.changePlans : []
  const plans = []
  for (const summary of pending.slice().sort((left, right) => compareStrings(left.status, right.status))) {
    let plan
    try {
      plan = await ctx.store.readChangePlan({ ...ctx.scope, changePlanId: summary.id })
    } catch (error) {
      throw translateByIdRead(error, changePlanNotFound)
    }
    if (plan) plans.push(plan)
  }
  const written = plans.find((plan) => plan.status === 'written') || null
  const confirmed = plans.find((plan) => plan.status === 'confirmed') || null
  const longest = Math.max(1, Math.ceil(proposal.records.length / limit), ...plans.map((plan) => Math.ceil(plan.recordSet.length / limit)))
  if (cursor >= longest) throw requestInvalid('recordCursor', 'recordCursor is past the last page')
  // ONE sheet read for everything this page shows (the wall first, inside the context's reader).
  const needsSheet = proposal.records.length > 0 || plans.length > 0
  let rowsById = new Map()
  if (needsSheet) {
    if (typeof ctx.readSheetRows !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the sheet reader is not wired for the change-plan page', { reason: 'sheet_reader' })
    const rows = await ctx.readSheetRows()
    rowsById = new Map(rows.map((row) => [pairing.recordRefOf(row) ? pairing.recordRefOf(row).id : null, row]).filter(([id]) => id))
  }
  const presenceOf = (recordId) => {
    const row = rowsById.get(recordId)
    return row ? Object.fromEntries(humanFieldIds.map((fieldId) => [fieldId, !isBlankCell(row[fieldId])])) : null
  }
  const currentContentDigest = written ? pairing.currentContentDigestOf({ records: written.recordSet, rowsByRecordId: rowsById, templateFields }) : null
  const proposalPage = recordPage(proposal.records, { cursor, limit })
  const planView = (plan) => {
    const paged = recordPage(plan.recordSet, { cursor, limit })
    return {
      id: plan.id,
      status: plan.status,
      recordCount: plan.recordCount,
      writeRecordCount: plan.writeRecordCount,
      planFingerprint: plan.planFingerprint,
      reviewBaselineDigest: plan.reviewBaselineDigest,
      absorbedChangePlanIds: plan.absorbedChangePlanIds,
      confirmedAt: plan.confirmedAt,
      confirmedBySelf: plan.confirmedBy === ctx.actorId,
      writtenAt: plan.writtenAt,
      writtenContentDigest: plan.writtenContentDigest,
      ...(plan.status === 'written' ? { currentContentDigest, contentMatchesWrite: currentContentDigest === plan.writtenContentDigest } : {}),
      recordPage: paged.page,
      records: paged.slice.map((record) => {
        const row = rowsById.get(record.recordId)
        return {
          recordId: record.recordId,
          key: record.key,
          root: record.root === true,
          inContinuation: record.inContinuation || null,
          present: Boolean(row),
          humanColumnsPresent: presenceOf(record.recordId),
          fields: Object.fromEntries(Object.entries(record.fields || {}).map(([fieldId, cell]) => [fieldId, {
            baseline: cell.baseline !== undefined ? cell.baseline : cell.before,
            before: cell.before,
            after: cell.after,
            reviewOnly: cell.reviewOnly === true,
            ...(plan.status === 'written' ? { current: row ? (row[fieldId] === undefined ? null : row[fieldId]) : null } : {}),
          }])),
        }
      }),
    }
  }
  const body = {
    refresh,
    proposal: {
      blocked: proposal.blocked,
      holdIds: proposal.classes.content.map((hold) => hold.id).sort(),
      holdSetFingerprint: proposal.holdSetFingerprint,
      planFingerprint: proposal.planFingerprint,
      sourceContentDigest: proposal.sourceContentDigest,
      recordCount: proposal.records.length,
      structureHoldOpen: proposal.classes.structure.length > 0,
      runbookHoldOpen: proposal.classes.runbook.length > 0,
      candidates: proposal.classes.content.filter((hold) => hold.kind === 'candidate_content_differs').map((hold) => ({ holdId: hold.id, candidateId: hold.pairingFingerprint || null, history: holdHistory(hold.detail) })),
      recordPage: proposalPage.page,
      records: proposalPage.slice.map((record) => ({ ...record, present: rowsById.has(record.recordId), humanColumnsPresent: presenceOf(record.recordId) })),
    },
    current: {
      confirmed: confirmed ? planView(confirmed) : null,
      written: written ? planView(written) : null,
    },
  }
  // The audit row FIRST (PR-4 note 0), then the receipt, then the body.
  await ctx.audit.append(auditReadRow(ctx, REFRESH_DECISION_AUDIT.modes.changePlanRead, {
    operation: 'change_plan_read',
    page: cursor,
    proposalRecords: proposal.records.length,
    proposalHolds: proposal.classes.content.length,
    pendingPlans: plans.length,
    writtenPlan: Boolean(written),
  }))
  const readReceipt = refresh.status === 'not_governed' || !written
    ? null
    : await ctx.receipts.record({
      receiptId,
      scope: ctx.scope,
      actorId: ctx.actorId,
      pages: [{
        holdId: written.id,
        fingerprint: written.planFingerprint,
        comparisonFingerprint: written.writtenContentDigest,
        evidenceFingerprint: currentContentDigest,
        pairPageCount: Math.max(1, Math.ceil(written.recordSet.length / limit)),
        pairPageIndex: cursor,
      }],
    })
  return Object.freeze({ ...body, readReceipt })
}

function normalizeChangePlanConfirmBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  if (!Array.isArray(body.holdIds) || body.holdIds.length === 0 || !body.holdIds.every(nonBlankString)) throw requestInvalid('holdIds', 'holdIds must name every open content hold of the proposal')
  const holdIds = body.holdIds.map((id) => id.trim())
  if (new Set(holdIds).size !== holdIds.length) throw requestInvalid('holdIds', 'a hold is named twice')
  const echo = {}
  for (const field of ['holdSetFingerprint', 'planFingerprint', 'sourceContentDigest']) {
    const value = trimmed(body[field])
    if (!value) throw requestInvalid(field, `${field} is required: a change plan binds to what the server last computed`)
    echo[field] = value
  }
  const readReceipt = trimmed(body.readReceipt)
  if (!readReceipt) throw requestInvalid('readReceipt', 'readReceipt is required: a confirm needs the pages it read')
  let candidates = []
  if (body.candidates !== undefined && body.candidates !== null) {
    if (!Array.isArray(body.candidates)) throw requestInvalid('candidates')
    candidates = body.candidates.map((entry, index) => {
      if (!isPlainObject(entry) || !trimmed(entry.holdId) || !trimmed(entry.candidateId)) throw requestInvalid(`candidates[${index}]`, 'a candidate decision needs { holdId, candidateId, basis }')
      if (!isPlainObject(entry.basis) || !DEMAND_BASES.includes(entry.basis.kind)) throw requestInvalid(`candidates[${index}].basis.kind`, 'basis.kind must be a phase-1 demand basis token')
      if (entry.basis.note !== undefined && entry.basis.note !== null && typeof entry.basis.note !== 'string') throw requestInvalid(`candidates[${index}].basis.note`)
      if (entry.acknowledge !== undefined && entry.acknowledge !== null && (!isPlainObject(entry.acknowledge) || (entry.acknowledge.historyUnknown !== undefined && typeof entry.acknowledge.historyUnknown !== 'boolean'))) {
        throw requestInvalid(`candidates[${index}].acknowledge`)
      }
      return Object.freeze({
        holdId: entry.holdId.trim(),
        candidateId: entry.candidateId.trim(),
        basis: { kind: entry.basis.kind, ...(typeof entry.basis.note === 'string' ? { note: entry.basis.note } : {}) },
        historyUnknownAcknowledged: Boolean(entry.acknowledge && entry.acknowledge.historyUnknown === true),
      })
    })
  }
  return Object.freeze({ holdIds, echo, readReceipt, candidates })
}

/**
 * POST …/refresh/change-plans/confirm (pull tier; register R-63 ②-⑤). The FAST PATH (the consult's picture — it
 * never takes the state row): RECOVERY_PENDING, S25, C07, the named set equal to the open content-class set, the
 * echoes (hold-set fingerprint, source digest, plan fingerprint recomputed from the consult's holds), the combined
 * candidates (pilot only, the pairing fingerprint, the history acknowledgement), the read receipt over EVERY page of
 * EVERY named hold. Then the store's transaction decides it all again under the lock, with the lock's in-transaction
 * bump (`change_plan_confirm`) and the audit row on the same handle. Answers 201's body.
 */
async function confirmChangePlan(ctx, body) {
  assertDecisionContext(ctx)
  if (typeof ctx.store.confirmChangePlan !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the continuation store cannot confirm change plans', { reason: 'decision_store' })
  if (!ctx.receipts || typeof ctx.receipts.verify !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.RECEIPT_STORE_UNAVAILABLE, 'read receipts are not wired; nothing is confirmed without them', { reason: 'receipts' })
  const input = normalizeChangePlanConfirmBody(body)
  const { consult } = ctx
  assertNoRecoveryPending(consult)
  const proposal = proposalOf(ctx)
  const { classes } = proposal
  if (classes.runbook.length > 0) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_NOT_ALLOWED, 'runbook_only_hold_open', { holdCount: classes.runbook.length })
  if (classes.structure.length > 0) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STRUCTURE_CHANGE_PRESENT, null, { holdCount: classes.structure.length })
  if (classes.content.length === 0) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE, 'no_content_hold')
  const contentIds = new Set(classes.content.map((hold) => hold.id))
  if (input.holdIds.length !== contentIds.size || input.holdIds.some((id) => !contentIds.has(id))) {
    throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE, 'hold_set_incomplete', { openContentHolds: contentIds.size, named: input.holdIds.length })
  }
  if (proposal.blocked === 'record_unbound') throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_NOT_ALLOWED, 'record_unbound')
  if (input.echo.holdSetFingerprint !== proposal.holdSetFingerprint) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE, 'hold_set_moved')
  if (input.echo.sourceContentDigest !== proposal.sourceContentDigest) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE, 'source_moved')
  if (input.echo.planFingerprint !== proposal.planFingerprint) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE, 'plan_fingerprint')
  // The combined confirm (§10.3 (5)): it creates a relationship, so it needs the pilot marker (register ⑤).
  const candidateHolds = classes.content.filter((hold) => hold.kind === 'candidate_content_differs')
  const decisions = new Map(input.candidates.map((entry) => [entry.holdId, entry]))
  if (candidateHolds.length > 0) assertPilot(consult)
  if (decisions.size !== candidateHolds.length || candidateHolds.some((hold) => !decisions.has(hold.id))) {
    throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE, 'candidate_set', { openCandidates: candidateHolds.length, named: decisions.size })
  }
  for (const hold of candidateHolds) {
    const decision = decisions.get(hold.id)
    if (decision.candidateId !== (hold.pairingFingerprint || null)) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_PLAN_STALE, 'candidate')
    if (holdHistory(hold.detail) === 'history_unknown' && !decision.historyUnknownAcknowledged) {
      throw requestInvalid('candidates.acknowledge.historyUnknown', 'the history of this demand is unknown; the confirm must acknowledge it')
    }
  }
  // U04: the receipt covers every page of every named hold (served by GET holds), with each hold's CURRENT fingerprints.
  for (const hold of classes.content.slice().sort((left, right) => compareStrings(left.id, right.id))) {
    const receipt = await ctx.receipts.verify({ receiptId: input.readReceipt, scope: ctx.scope, actorId: ctx.actorId, hold })
    if (!receipt.ok) {
      throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.READ_RECEIPT_INCOMPLETE, 'the read receipt does not cover every page of every hold this plan resolves; read them all, then confirm', {
        reason: receipt.reason,
        holdId: hold.id,
        pagesServed: receipt.pagesServed,
        pageCount: receipt.pageCount,
        partial: false,
      })
    }
  }
  const hooks = decisionHooks(ctx, {
    mode: REFRESH_DECISION_AUDIT.modes.changePlanConfirmed,
    subjectIdOf: (event) => event.changePlanId,
    detailOf: (event) => ({
      operation: event.operation,
      recordCount: Number.isInteger(event.recordCount) ? event.recordCount : 0,
      holdCount: Number.isInteger(event.holdCount) ? event.holdCount : 0,
      continuationCount: Number.isInteger(event.continuationCount) ? event.continuationCount : 0,
      createdContinuationCount: Number.isInteger(event.createdContinuationCount) ? event.createdContinuationCount : 0,
      supersededCount: Number.isInteger(event.supersededCount) ? event.supersededCount : 0,
    }),
  })
  const decided = await ctx.store.confirmChangePlan({
    ...ctx.scope,
    confirmedBy: ctx.actorId,
    holds: classes.content.map((hold) => ({ id: hold.id, fingerprint: hold.fingerprint })),
    echo: input.echo,
    candidates: input.candidates.map((entry) => ({ holdId: entry.holdId, candidateId: entry.candidateId, basis: entry.basis })),
    sourceIdentity: refreshSourceIdentity({ action: ctx.action, tenantId: ctx.scope.tenantId }),
    template: templateOf(ctx),
  }, hooks)
  return Object.freeze({
    changePlanId: decided.changePlanId,
    recordCount: decided.recordCount,
    holdCount: decided.holdCount,
    continuationIds: decided.continuationIds,
    decisionVersion: decided.decisionVersion,
    generation: decided.generation ? decided.generation.generation : null,
    state: 'confirmed_pending_execution',
    nextStep: 'preview_again',
  })
}

function normalizeReviewBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  const changePlanId = trimmed(body.changePlanId)
  if (!changePlanId) throw requestInvalid('changePlanId')
  const contentDigest = trimmed(body.contentDigest)
  if (!contentDigest) throw requestInvalid('contentDigest', 'contentDigest is required: the review binds the content the page showed')
  if (!['handled', 'handled_with_notes'].includes(body.conclusion)) throw requestInvalid('conclusion', 'conclusion must be handled or handled_with_notes')
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') throw requestInvalid('notes')
  const readReceipt = trimmed(body.readReceipt)
  if (!readReceipt) throw requestInvalid('readReceipt', 'readReceipt is required: a review needs every page of the current diff')
  return Object.freeze({ changePlanId, contentDigest, conclusion: body.conclusion, notes: typeof body.notes === 'string' ? body.notes : null, readReceipt })
}

/**
 * POST …/refresh/change-reviews/complete (pull tier; C05 / C06 / C11 / C12; register R-63 ⑦). The fast path: the
 * WRITTEN plan by id (another scope's = an unknown id's 404), nothing else open (C12: any hold / a confirmed plan /
 * recovery). Then the CURRENT diff: no live writer (`assertNoLiveWriter`), ONE audited read of the sheet through the
 * table-action wall, the current content digest — and the read receipt must cover every page of THAT diff (the
 * pseudo-hold GET current recorded, its evidence = this digest: a sheet that moved since the page refuses here). Then
 * the store's transaction re-decides everything under the state-row lock (no bump) with the audit row on its handle.
 */
async function completeChangeReview(ctx, body) {
  assertContext(ctx)
  if (typeof ctx.store.completeChangeReview !== 'function' || typeof ctx.store.readChangePlan !== 'function') {
    throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the continuation store cannot complete reviews', { reason: 'decision_store' })
  }
  if (typeof ctx.audit.appendWithin !== 'function') throw new StockPreparationRefreshDecisionError(501, 'AUDIT_STORE_UNAVAILABLE', 'the audit store cannot append inside a transaction; nothing is reviewed without it', { reason: 'append_within' })
  if (!ctx.receipts || typeof ctx.receipts.verify !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.RECEIPT_STORE_UNAVAILABLE, 'read receipts are not wired; nothing is reviewed without them', { reason: 'receipts' })
  if (!ctx.projectWriteLock || typeof ctx.projectWriteLock.assertNoLiveWriter !== 'function') throw new StockPreparationRefreshDecisionError(501, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 'the sheet write lock is not wired for the review', { reason: 'assert_no_live_writer' })
  if (typeof ctx.readSheetRows !== 'function') throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the sheet reader is not wired for the review', { reason: 'sheet_reader' })
  const input = normalizeReviewBody(body)
  const { consult } = ctx
  let plan
  try {
    plan = await ctx.store.readChangePlan({ ...ctx.scope, changePlanId: input.changePlanId })
  } catch (error) {
    throw translateByIdRead(error, changePlanNotFound)
  }
  if (!plan) throw changePlanNotFound()
  if (plan.status !== 'written') {
    throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_STALE, plan.status === 'superseded' ? 'plan_replaced' : (plan.status === 'reviewed' ? 'already_reviewed' : 'not_written'), { status: plan.status })
  }
  assertNoRecoveryPending(consult)
  const openHolds = consult.holds.filter((hold) => hold.status === 'open')
  if (openHolds.length > 0) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_BLOCKED, 'hold_open', { holdCount: openHolds.length })
  if ((consult.changePlans || []).some((summary) => summary.status === 'confirmed')) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_BLOCKED, 'change_plan_pending')
  await ctx.projectWriteLock.assertNoLiveWriter(sheetWriteScopeKey(ctx.scope.sheetId))
  const template = templateOf(ctx)
  const rows = await ctx.readSheetRows()
  const rowsById = new Map(rows.map((row) => [pairing.recordRefOf(row) ? pairing.recordRefOf(row).id : null, row]).filter(([id]) => id))
  const currentContentDigest = pairing.currentContentDigestOf({ records: plan.recordSet, rowsByRecordId: rowsById, templateFields: plannerInternals.fieldMapForTemplate(template) })
  const receipt = await ctx.receipts.verify({
    receiptId: input.readReceipt,
    scope: ctx.scope,
    actorId: ctx.actorId,
    hold: { id: plan.id, fingerprint: plan.planFingerprint, comparisonFingerprint: plan.writtenContentDigest, evidenceFingerprint: currentContentDigest },
  })
  if (!receipt.ok) {
    throw new StockPreparationRefreshDecisionError(409, REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_READ_RECEIPT_INCOMPLETE, 'the read receipt does not cover every page of the current change; read the page again, then review', {
      reason: receipt.reason,
      pagesServed: receipt.pagesServed,
      pageCount: receipt.pageCount,
      partial: false,
    })
  }
  if (input.contentDigest !== plan.writtenContentDigest) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_STALE, 'echo_moved')
  if (currentContentDigest !== plan.writtenContentDigest) throw changePlanDecisionError(REFRESH_DECISION_ERROR_CODES.CHANGE_REVIEW_STALE, 'content_moved')
  const hooks = decisionHooks(ctx, {
    mode: REFRESH_DECISION_AUDIT.modes.changeReviewCompleted,
    subjectIdOf: (event) => event.changePlanId,
    detailOf: (event) => ({
      operation: event.operation,
      recordCount: Number.isInteger(event.recordCount) ? event.recordCount : 0,
      conclusion: nonBlankString(event.conclusion) ? event.conclusion : 'handled',
      notesPresent: event.notesPresent === true,
      sameActorAsConfirm: event.sameActorAsConfirm === true,
    }),
  })
  const reviewed = await ctx.store.completeChangeReview({
    ...ctx.scope,
    changePlanId: plan.id,
    reviewedBy: ctx.actorId,
    echoDigest: input.contentDigest,
    currentContentDigest,
    conclusion: input.conclusion,
    notes: input.notes,
  }, { auditWithin: hooks.auditWithin })
  return Object.freeze({
    changePlanId: reviewed.changePlanId,
    status: reviewed.status,
    recordCount: reviewed.recordCount,
    reviewedContentDigest: reviewed.reviewedContentDigest,
    decisionVersion: reviewed.decisionVersion,
    nextStep: 'preview_again',
  })
}

module.exports = {
  HOLD_PAGE_LIMIT_DEFAULT,
  HOLD_PAGE_LIMIT_MAX,
  RECORD_PAGE_LIMIT_DEFAULT,
  RECORD_PAGE_LIMIT_MAX,
  PAIR_PAGE_LIMIT_DEFAULT,
  PAIR_PAGE_LIMIT_MAX,
  READ_RECEIPT_KEY_PREFIX,
  READ_RECEIPT_TTL_MS,
  REFRESH_DECISION_AUDIT,
  REFRESH_DECISION_ERROR_CODES,
  StockPreparationRefreshDecisionError,
  confirm,
  // Step 5 PR-8.
  completeChangeReview,
  confirmChangePlan,
  readChangePlanCurrent,
  createReadReceiptStore,
  end,
  keepHold,
  listHolds,
  readContinuation,
  readHoldEvidence,
  __internals: {
    normalizeChangePlanConfirmBody,
    normalizeReviewBody,
    proposalOf,
    holdPayload,
    normalizeConfirmBody,
    normalizeEndBody,
    pagedPairs,
    refreshSummary,
    sortHolds,
    translateByIdRead,
  },
}
