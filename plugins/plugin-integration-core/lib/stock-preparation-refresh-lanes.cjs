'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 4, PR-3a — THE LANE HELPERS: what every stock-prep lane does with the ONE
// governance consult (design §5, §7, §8.4, §9; plan-final §2.4).
//
// Pure helpers and small orchestrators shared by the small lane (stock-preparation-table-actions.cjs), the
// large chunk (stock-preparation-large-bom-jobs.cjs) and the routes (http-routes.cjs). No route, no env flag,
// no SQL of its own: every store call goes through the server-held handle the route built
// (`dryRun.refresh.handle.store.*`), and every refusal is a StockPreparationRefreshLaneError with an integer
// status (a typed route error) and values-free details (tokens, counts, booleans — never a key, a path, a
// component id, a quantity or a message from below).
//
// WHAT A LANE DOES, IN ORDER (governed project; a not-governed project pays one consult and nothing else):
//   consultForPlanning   the consult (503 unreadable / 409 retargeted or tenant mismatch / 501 unwired / 422),
//                        then — governed only — the source-binding unanimity check (R-1, TD-21) and the STRICT
//                        planning inputs (R-2, TD-22: the pack band and the ext mapping the computation plans,
//                        verifies, settles and writes with). All before any source read.
//   continuationInputFor the planner's `continuation` input, exactly the 10 keys (O-16 + persistedHolds + step 5's
//                        changePlan: the consult's CONFIRMED change plan with THIS computation's source digest).
//   change plan (PR-8)   changePlanVerdictOf / previewReviewOf / assertChangePlanCurrent / assertNoReviewPending —
//                        the token and the execution are bound to a confirmed plan only when the planner matches it;
//                        a written change awaiting review refuses every write but that controlled update.
//   isCompleteComputation only a COMPLETE computation reconciles (AMB-2, TD-24).
//   reconcileComputation the ONE hold reconciliation (CAS on decision_version) of a governed, complete
//                        computation; never swallowed.
//   assert*              the apply's refusals, from the consult's ROWS (O-22) — never the derived state.
//   executionFinishStatus / selfSettlementFor / settlementForComputation   the execution ledger (TD-9, O-14).
//
// VALUES. The consult answer, the plan's `holds` and the expansion's `demandEvidence` carry business values;
// they travel in-process only (to the planner, to `reconcileHolds`, to the apply lib). Nothing here builds a
// response, a token record, a log line or an error detail out of them: the hold stanza and the binding are
// tokens, counts, ids and digests.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const pairing = require('./stock-preparation-continuation-pairing.cjs')
const { plannerSlice } = require('./stock-preparation-refresh-governance.cjs')
const { newestExecution } = require('./stock-preparation-refresh-state.cjs')
const { countAttemptedHostWrites } = require('./stock-preparation-apply-writer.cjs')

const { CONTINUATION_ERROR_CODES, machineBandFieldIds, sheetMachineDigest } = pairing
const { canonicalJson } = pairing.__internals

// The table-action module requires THIS module; the one function needed back (the source-content digest) is
// looked up lazily, the conflict planner's pattern for the pairing module.
let lazyTableActions = null
function tableActions() {
  if (!lazyTableActions) lazyTableActions = require('./stock-preparation-table-actions.cjs')
  return lazyTableActions
}

const REFRESH_LANE_ERROR_CODES = Object.freeze({
  PULL_SUSPENDED: 'STOCK_PREP_PULL_SUSPENDED',
  BINDING_STALE: 'STOCK_PREP_REFRESH_BINDING_STALE',
  RECOVERY_PENDING: 'STOCK_PREP_REFRESH_RECOVERY_PENDING',
  GOVERNANCE_UNCONSULTED: 'STOCK_PREP_REFRESH_GOVERNANCE_UNCONSULTED',
  LARGE_LANE_REFUSED: 'STOCK_PREP_REFRESH_LARGE_LANE_REFUSED',
  STATE_MOVED: 'STOCK_PREP_PULL_STATE_MOVED',
  SOURCE_BINDING_SPLIT: 'STOCK_PREP_REFRESH_SOURCE_BINDING_SPLIT',
  // Re-exported tokens of the store / reader family (one vocabulary for a refusal by any layer).
  STORE_FAILED: 'STOCK_PREP_REFRESH_STORE_FAILED',
  STORE_UNAVAILABLE: 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE',
  // Step 5 PR-8: the change plan a token / an execution names is no longer what the recompute authorizes (the store
  // and the writer spell the same literal), and a written change still awaits its review (design §9.3).
  CHANGE_PLAN_STALE: 'STOCK_PREP_CHANGE_PLAN_STALE',
  REVIEW_PENDING: 'STOCK_PREP_REFRESH_REVIEW_PENDING',
})

class StockPreparationRefreshLaneError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationRefreshLaneError'
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

function sqlStateOf(value) {
  return typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) ? value : undefined
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function countBy(values) {
  const out = {}
  for (const value of values) out[value] = (out[value] || 0) + 1
  return Object.fromEntries(Object.keys(out).sort().map((key) => [key, out[key]]))
}

// ── errors ────────────────────────────────────────────────────────────────────────────────────────

function storeUnavailable(reason) {
  return new StockPreparationRefreshLaneError(501, REFRESH_LANE_ERROR_CODES.STORE_UNAVAILABLE, 'the refresh governance is not wired for this lane on this deployment; nothing was read or written', { reason })
}

function storeFailed(store, operation, sqlState) {
  const state = sqlStateOf(sqlState)
  return new StockPreparationRefreshLaneError(503, REFRESH_LANE_ERROR_CODES.STORE_FAILED, 'a refresh planning input could not be read; nothing was planned', {
    store,
    operation,
    ...(state ? { sqlState: state } : {}),
    partial: false,
  })
}

function sourceBindingSplit(reason) {
  return new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.SOURCE_BINDING_SPLIT, 'this project is governed and the source binding of its action is not one agreeing source; unify the bindings, then pull again', { reason, partial: false })
}

// ── source identity (P3-G11; R-1) ─────────────────────────────────────────────────────────────────

// MOVED VERBATIM from http-routes.cjs (#6475): one-way and truncated over three handles (tenant id, frozen
// action id, external-system row id) — no host, no credential, no business value. The ONE helper the route's
// mvp-persist check, the continuation's source identity and PR-4's confirm all use.
function stockPreparationSourceScopeDigest({ tenantId, actionId, externalSystemId }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(['stock-preparation/source-scope/v1', tenantId, actionId, externalSystemId]))
    .digest('hex')
    .slice(0, 32)
}

/** sha256 over the canonical JSON of the action's read plan (the pairing module's canonicalisation — one). */
function stockPreparationReadPlanDigest(readPlan) {
  return sha256(canonicalJson({ scheme: 'stock-preparation/read-plan/v1', readPlan: readPlan === undefined ? null : readPlan }))
}

/** The read plan declares a spec slot (the readiness `spec_read_plan_slot` predicate's first half). */
function specSlotDeclaredFor(action) {
  const readPlan = action && isPlainObject(action.source) ? action.source.readPlan : null
  return isPlainObject(readPlan) && isPlainObject(readPlan.part) && nonBlankString(readPlan.part.specField)
}

function refreshSourceIdentity({ action, tenantId }) {
  const externalSystemId = action && isPlainObject(action.source) ? action.source.externalSystemId : null
  return Object.freeze({
    externalSystemId,
    sourceScopeDigest: stockPreparationSourceScopeDigest({ tenantId, actionId: action.actionId, externalSystemId }),
    readPlanDigest: stockPreparationReadPlanDigest(action.source.readPlan),
  })
}

// ── the consult (P3-G1/G2, R-1, R-2) ──────────────────────────────────────────────────────────────

function isRefreshHandle(handle) {
  return isPlainObject(handle) && Object.isFrozen(handle)
    && typeof handle.consult === 'function'
    && typeof handle.assertSourceBindingUnanimous === 'function'
    && typeof handle.planningInputs === 'function'
    && isPlainObject(handle.store)
    && typeof handle.store.reconcileHolds === 'function'
    && typeof handle.store.beginExecution === 'function'
    && typeof handle.store.finishExecution === 'function'
}

const PACK_UNAVAILABLE_REASONS = Object.freeze(['pack_install_ledger', 'pack_field_read'])
const PACK_READ_OPERATIONS = Object.freeze(['ledger_read', 'field_read'])

// TD-22: a governed computation plans with the STRICT band only. read_failed => 503, unavailable => 501; the
// eager fail-open band a route passes for not-governed projects is never used here.
function planningInputsOrRefuse(answer) {
  const pack = isPlainObject(answer) ? answer.pack : null
  if (!isPlainObject(pack)) throw storeFailed('pack_installed_fields', 'ledger_read')
  if (pack.state === 'read_failed') {
    throw storeFailed('pack_installed_fields', PACK_READ_OPERATIONS.includes(pack.operation) ? pack.operation : 'ledger_read', pack.sqlState)
  }
  if (pack.state === 'unavailable') {
    throw storeUnavailable(PACK_UNAVAILABLE_REASONS.includes(pack.reason) ? pack.reason : 'pack_install_ledger')
  }
  if (pack.state === 'installed') {
    if (!Array.isArray(pack.installedFieldProperties)) throw storeFailed('pack_installed_fields', 'field_read')
    return Object.freeze({ installedFieldProperties: pack.installedFieldProperties, extFieldMapping: answer.extFieldMapping })
  }
  if (pack.state === 'no_pack') return Object.freeze({ installedFieldProperties: undefined, extFieldMapping: answer.extFieldMapping })
  throw storeFailed('pack_installed_fields', 'ledger_read')
}

/**
 * The consult every planning lane makes, BEFORE any source read: (1) the handle must be the route's frozen,
 * server-held handle (else 501 `governance_handle`); (2) the consult — the reader's 503 / 409 / 501 / 422 pass
 * through untouched; (3) governed only: the (tenant, action) source binding must be unanimous (R-1) and the
 * strict planning inputs must read (R-2). A not-governed project pays exactly one consult.
 */
async function consultForPlanning(handle, { action, parameters } = {}) {
  if (!isRefreshHandle(handle)) throw storeUnavailable('governance_handle')
  const consult = await handle.consult({ projectNo: parameters && parameters.projectNo, sheetId: action && action.target ? action.target.sheetId : undefined })
  if (!isPlainObject(consult) || consult.ok !== true) throw storeFailed('governance', 'consult')
  const governed = consult.governed === true
  let planningInputs = null
  if (governed) {
    await handle.assertSourceBindingUnanimous(action)
    planningInputs = planningInputsOrRefuse(await handle.planningInputs(action))
  }
  return Object.freeze({ consult, governed, evidenceOptions: handle.evidenceOptions, planningInputs })
}

// ── the planner input (O-16 + AMB-1) ─────────────────────────────────────────────────────────────

/**
 * One consult hold as the planner's `persistedHolds` entry: EXACTLY the pairing module's 13-key PHK set. The
 * stored fingerprint and body are copied verbatim (never recomputed); `continuationRoots` comes from the
 * consult continuation the hold names, whatever its status (an escalated relationship is ENDED). Never the
 * row id, its scope or its timestamps.
 */
function pickPersistedHold(hold, continuations) {
  const named = nonBlankString(hold.continuationId) && Array.isArray(continuations)
    ? continuations.find((entry) => entry && entry.id === hold.continuationId)
    : null
  return {
    kind: hold.kind,
    fingerprint: hold.fingerprint,
    confirmable: hold.confirmable === true,
    notConfirmableReason: hold.notConfirmableReason === undefined ? null : hold.notConfirmableReason,
    shapeToken: hold.shapeToken === undefined ? null : hold.shapeToken,
    continuationId: hold.continuationId === undefined ? null : hold.continuationId,
    subject: hold.subject,
    detail: hold.detail,
    evidenceFingerprint: hold.evidenceFingerprint === undefined ? null : hold.evidenceFingerprint,
    comparisonFingerprint: hold.comparisonFingerprint === undefined ? null : hold.comparisonFingerprint,
    pairingFingerprint: hold.pairingFingerprint === undefined ? null : hold.pairingFingerprint,
    runbookOnly: hold.runbookOnly === true,
    continuationRoots: named && nonBlankString(named.oldRootKey) && nonBlankString(named.newRootKey)
      ? { oldRootKey: named.oldRootKey, newRootKey: named.newRootKey }
      : null,
  }
}

/**
 * Step 5 PR-8: the consult's CONFIRMED change plan (values-free summary; at most one — migration 104's partial unique
 * index), as the planner's `changePlan` input: `{ id, planFingerprint, currentSourceContentDigest, recordIds }` with
 * THIS computation's source content digest — or null.
 */
function changePlanInputFor(consult, sourceContentDigest) {
  const confirmed = Array.isArray(consult.changePlans) ? consult.changePlans.filter((plan) => plan && plan.status === 'confirmed') : []
  if (confirmed.length === 0) return null
  if (confirmed.length > 1 || !nonBlankString(sourceContentDigest)) throw storeFailed('governance', 'change_plan_input')
  const plan = confirmed[0]
  return {
    id: plan.id,
    planFingerprint: plan.planFingerprint,
    currentSourceContentDigest: sourceContentDigest,
    recordIds: Array.isArray(plan.recordIds) ? plan.recordIds.slice() : [],
  }
}

/**
 * EXACTLY the 10-key planner input (O-16's 8 + `persistedHolds` + step 5's `changePlan`). Never spreads the consult.
 * `sourceContentDigest` is THIS computation's (built before planning; the plan fingerprint binds it).
 */
function continuationInputFor(refresh, { action, expansion, sourceContentDigest }) {
  const consult = refresh.consult
  return {
    storeState: 'ok',
    pilot: Boolean(consult.pilot && consult.pilot.enabled === true),
    projectNo: consult.scope.projectNo,
    ...plannerSlice(consult),
    demandEvidence: expansion && expansion.demandEvidence !== undefined ? expansion.demandEvidence : null,
    sourceIdentity: refreshSourceIdentity({ action, tenantId: consult.scope.tenantId }),
    specSlotDeclared: specSlotDeclaredFor(action),
    persistedHolds: consult.holds.map((hold) => pickPersistedHold(hold, consult.continuations)),
    changePlan: changePlanInputFor(consult, sourceContentDigest),
  }
}

/** The planner's values-free verdict on the confirmed plan (`plan.continuation.changePlan`), or null. */
function changePlanVerdictOf(dryRun) {
  const plan = dryRun && dryRun.plan
  const stanza = plan && isPlainObject(plan.continuation) && isPlainObject(plan.continuation.changePlan) ? plan.continuation.changePlan : null
  return stanza && nonBlankString(stanza.id) && (stanza.verdict === 'matches' || stanza.verdict === 'stale') ? stanza : null
}

/**
 * P3-G9: a consult that straddled a decision can hand the planner a header whose members are missing — a
 * transient, retryable 409, never a 500. ONLY those two shapes map; every other planner error is a defect.
 */
function mapContinuationStraddle(fn) {
  return function straddleMapped(...args) {
    try {
      return fn(...args)
    } catch (error) {
      const straddle = error && (error.code === CONTINUATION_ERROR_CODES.PROJECTION_INCONSISTENT
        || (error.code === CONTINUATION_ERROR_CODES.INPUT_INVALID && error.details && error.details.field === 'continuation.continuations.memberCount'))
      if (straddle) {
        throw new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.STATE_MOVED, 'the refresh state moved while this pull was being planned; preview again', { reason: 'projection_inconsistent', partial: false })
      }
      throw error
    }
  }
}

/** The values-free verdict a computation hands the writer (design §7.2): a key of the RESULT, never of `plan`. */
function governanceVerdictOf(refresh) {
  const generation = refresh.consult.lock && refresh.consult.lock.generation
  return Object.freeze({
    consulted: true,
    verdict: refresh.governed ? 'projected' : 'not_governed',
    generationToken: generation && nonBlankString(generation.generationToken) ? generation.generationToken : null,
  })
}

/**
 * AMB-2 / TD-24: only a COMPLETE computation reconciles — found, no global error (bounded and max_rows reads
 * are global errors), ZERO row errors (hard or soft) and an untruncated row-error summary. A truncated or
 * failed read would supersede every open hold and persist `new_position_removed` (not re-confirmable).
 */
function isCompleteComputation(expansion, { hasGlobalErrors } = {}) {
  if (!isPlainObject(expansion) || expansion.status === 'not_found') return false
  if (hasGlobalErrors === true) return false
  const rowErrors = Array.isArray(expansion.rowErrors) ? expansion.rowErrors : []
  if (rowErrors.length > 0) return false
  const summary = isPlainObject(expansion.summary) ? expansion.summary : {}
  return summary.rowErrorsTruncated !== true
}

/** sha256 over [idempotencyKey, decision, changedFields] per decision, in plan order (design §4.2 plan_digest). */
function planDigestOf(plan) {
  const decisions = plan && Array.isArray(plan.decisions) ? plan.decisions : []
  return sha256(canonicalJson({
    scheme: 'stock-preparation/plan-digest/v1',
    decisions: decisions.map((decision) => [
      decision && decision.idempotencyKey !== undefined ? decision.idempotencyKey : null,
      decision && decision.decision !== undefined ? decision.decision : null,
      decision && Array.isArray(decision.changedFields) ? decision.changedFields.slice() : null,
    ]),
  }))
}

/**
 * The binding a token records and an execution is begun with: the non-ended continuations, sorted by id, and (step 5
 * PR-8) the confirmed change plan THIS computation authorizes — its id only when the planner's verdict is `matches`.
 */
function refreshBindingOf(consult, holdSetFingerprint, changePlanVerdict = null) {
  const continuations = consult.continuations
    .filter((entry) => entry.status !== 'ended')
    .map((entry) => ({ id: entry.id, revision: entry.revision }))
    .sort((left, right) => (left.id < right.id ? -1 : (left.id > right.id ? 1 : 0)))
  const changePlanId = changePlanVerdict && changePlanVerdict.verdict === 'matches' ? changePlanVerdict.id : null
  return Object.freeze({ continuations, changePlanId, holdSetFingerprint: nonBlankString(holdSetFingerprint) ? holdSetFingerprint : null })
}

/** The values-free `refreshHold` stanza a governed preview answers beside `evidence`. */
function refreshHoldStanza(plan, outcome) {
  const summary = plan && isPlainObject(plan.continuation) && isPlainObject(plan.continuation.holds) ? plan.continuation.holds : { count: 0, confirmable: 0, kinds: {} }
  const open = outcome && outcome.result && outcome.result.holds ? outcome.result.holds.open : 0
  return Object.freeze({
    held: plan.suspended === true || open > 0,
    holdCount: Math.max(Number(summary.count || 0), Number(open || 0)),
    confirmableCount: Number(summary.confirmable || 0),
    kinds: { ...(isPlainObject(summary.kinds) ? summary.kinds : {}) },
    holdSetFingerprint: outcome && outcome.result && nonBlankString(outcome.result.holdSetFingerprint) ? outcome.result.holdSetFingerprint : null,
  })
}

function sourceContentDigestOf(dryRun) {
  return tableActions().stockPreparationSourceContentDigest(dryRun.sourceContentRevision)
}

function machineDigestOf(dryRun, template) {
  return sheetMachineDigest(dryRun.existingRows, {
    machineFieldIds: machineBandFieldIds({ template, installedFieldProperties: dryRun.refresh.installedFieldProperties }),
  })
}

function pendingDecisionCount(plan) {
  const counts = plan && isPlainObject(plan.counts) ? plan.counts : {}
  return Number(counts.add || 0) + Number(counts.update || 0) + Number(counts.inactive || 0) + Number(counts.manual_confirm || 0)
}

/**
 * A SETTLING computation (design §9.2, O-14, AMB-5): clean (no hold, not suspended), zero pending decisions
 * (add + update + inactive + manual_confirm), and the newest execution the consult saw is absent or
 * succeeded / verified_closed — it names that execution. The machine digest is over THIS request's existing
 * rows (O-10) and the STRICT band (TD-22).
 */
function settlementForComputation({ consult, dryRun, template }) {
  const plan = dryRun.plan
  if (plan.suspended === true || (Array.isArray(plan.holds) && plan.holds.length > 0)) return null
  if (pendingDecisionCount(plan) !== 0) return null
  const newest = newestExecution(consult.executions)
  if (newest && newest.status !== 'succeeded' && newest.status !== 'verified_closed') return null
  const generation = consult.lock && consult.lock.generation
  return Object.freeze({
    executionId: newest ? newest.id : null,
    generationToken: generation && nonBlankString(generation.generationToken) ? generation.generationToken : null,
    sourceContentDigest: sourceContentDigestOf(dryRun),
    sheetMachineDigest: machineDigestOf(dryRun, template),
  })
}

/**
 * THE ONE hold reconciliation of a computation (design §8.4, D-13 as amended by TD-24). Null — and no store
 * call at all — unless the computation is governed AND complete (TD-4, AMB-2). The store's CAS on
 * `decision_version` (409 STATE_MOVED), its hold race (409) and its failures (503) propagate: a preview never
 * answers "clean" with an unrecorded state (E09).
 */
async function reconcileComputation(dryRun, { lane, settle } = {}) {
  const refresh = dryRun && dryRun.refresh
  if (!refresh || refresh.governed !== true || refresh.complete !== true) return null
  const { consult, handle } = refresh
  const plan = dryRun.plan
  const suspended = plan.suspended === true
  const settlement = settle ? settlementForComputation({ consult, dryRun, template: settle.template }) : null
  const generation = consult.lock && consult.lock.generation
  // Step 5 PR-8: the planner's verdict on the confirmed plan travels to the reconciliation, which decides under the
  // state-row lock (a `matches` re-asserts the plan is still confirmed; a `stale` invalidates it — with its audit row,
  // the handle's `auditWithin` — unless an execution bound to it is running).
  const changePlanVerdict = changePlanVerdictOf(dryRun)
  const result = await handle.store.reconcileHolds({
    tenantId: consult.scope.tenantId,
    sheetId: consult.scope.sheetId,
    projectNo: consult.scope.projectNo,
    decisionVersionObserved: consult.decisionVersionObserved,
    holds: Array.isArray(plan.holds) ? plan.holds : [],
    computation: {
      lane,
      suspended,
      generationToken: generation && nonBlankString(generation.generationToken) ? generation.generationToken : null,
      sourceContentDigest: sourceContentDigestOf(dryRun),
    },
    verdicts: isPlainObject(plan.continuation) && isPlainObject(plan.continuation.verdicts) ? plan.continuation.verdicts : {},
    ...(settlement ? { settlement } : {}),
    ...(changePlanVerdict ? { changePlan: { id: changePlanVerdict.id, verdict: changePlanVerdict.verdict } } : {}),
  }, typeof handle.auditWithin === 'function' ? { auditWithin: handle.auditWithin } : {})
  const outcome = { result }
  return Object.freeze({
    result,
    suspended: suspended || Number(result.holds && result.holds.open) > 0,
    binding: refreshBindingOf(consult, result.holdSetFingerprint, changePlanVerdict),
    stanza: refreshHoldStanza(plan, outcome),
    changePlan: changePlanVerdict,
  })
}

// ── the apply's refusals (design §7.1 row 1; O-15, O-22; TD-11 replaced by R-4) ───────────────────

const UNVERIFIED_FAILURE_STATUSES = Object.freeze(['partial', 'failed', 'aborted'])

/**
 * THE rows a lane must not write over (O-22), read from the consult's ROWS, never the derived state: every
 * partial / failed / aborted execution, and every `running` one that is not `exemptLeaseId`'s in-flight run. The
 * apply exempts its OWN lease (its own lease would derive `executing` and mask an earlier failure); a preview
 * exempts the LIVE lease the consult saw (an apply in flight is not a failure — that preview meets the bump's
 * WRITE_LOCKED exactly as before). `exemptLeaseId === null` counts every running row.
 */
function unfinishedExecutionsOf(consult, exemptLeaseId) {
  return consult.executions.filter((entry) => UNVERIFIED_FAILURE_STATUSES.includes(entry.status)
    || (entry.status === 'running' && (exemptLeaseId === null || entry.leaseId !== exemptLeaseId)))
}

/** The lease the consult saw LIVE (the refresh-state derivation's own read), else null. */
function liveLeaseIdOf(consult) {
  const lock = consult && consult.lock
  return lock && isPlainObject(lock.state) && lock.state.leaseLive === true && isPlainObject(lock.generation) && nonBlankString(lock.generation.leaseId)
    ? lock.generation.leaseId
    : null
}

/**
 * Review round 1 (lens A note 2): what a PREVIEW of a governed project answers when an earlier execution did not
 * finish cleanly — the SAME rows the apply refuses RECOVERY_PENDING on, so the preview never promises an apply
 * that will be refused. Values-free (a count). Null when there is none.
 */
function previewRecoveryOf(consult) {
  const open = unfinishedExecutionsOf(consult, liveLeaseIdOf(consult))
  return open.length > 0 ? Object.freeze({ pending: true, openExecutions: open.length }) : null
}

/**
 * PR-3a follow-up (delta verification, 2026-10-26): true when EVERY row `previewRecoveryOf` answers on is a `running`
 * row with no live lease (none partial / failed / aborted). That is the picture of a dead run — and ALSO of a run that
 * was `running` at the consult's snapshot and finished before the consult's lock read, which the reader takes after
 * the snapshot (refresh-governance.cjs header).
 */
function recoveryRestsOnLeaselessRunning(consult) {
  const open = unfinishedExecutionsOf(consult, liveLeaseIdOf(consult))
  return open.length > 0 && open.every((entry) => entry.status === 'running')
}

function executionFinishedDuringPreview() {
  return new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.STATE_MOVED, 'an execution of this project finished while this pull was being planned; preview again', {
    reason: 'execution_finished_during_preview',
    partial: false,
  })
}

/**
 * Design §23.8 F-18 (step-4 review follow-ups): true for exactly the straddle refusal above. It describes ANOTHER
 * run — the one that just finished and stamped its own outcome — so the route does not stamp it `refused` over
 * that outcome (as for WRITE_LOCKED). Narrow on purpose: every other STATE_MOVED reason keeps its stamp.
 */
function isExecutionFinishedDuringPreview(error) {
  return Boolean(error) && error.code === REFRESH_LANE_ERROR_CODES.STATE_MOVED
    && isPlainObject(error.details) && error.details.reason === 'execution_finished_during_preview'
}

/**
 * THE PREVIEW's recovery answer: `previewRecoveryOf`, with ONE re-consult when it rests only on lease-less `running`
 * rows. Rows still open => the fresh count (a dead run, or the run ended partial / failed / aborted). None left =>
 * that run finished while this preview read; the plan was computed against the earlier picture, so 409 STATE_MOVED
 * `execution_finished_during_preview` (preview again) — before the reconciliation, so nothing is reconciled, no token
 * is minted and nothing is bumped. A failing re-consult propagates (fail closed). Advisory either way: the apply's
 * in-lease check of the rows (`assertNoUnfinishedExecution`) is the guarantee.
 */
async function previewRecoveryRechecked(refresh) {
  const recovery = previewRecoveryOf(refresh.consult)
  if (!recovery || !recoveryRestsOnLeaselessRunning(refresh.consult)) return recovery
  const scope = refresh.consult.scope
  const fresh = await refresh.handle.consult({ projectNo: scope.projectNo, sheetId: scope.sheetId })
  if (!isPlainObject(fresh) || fresh.ok !== true) throw storeFailed('governance', 'consult')
  const recheck = previewRecoveryOf(fresh)
  if (!recheck) throw executionFinishedDuringPreview()
  return recheck
}

/**
 * O-22: any partial / failed / aborted execution, or a `running` one of ANOTHER lease, refuses — 409
 * RECOVERY_PENDING, before anything is begun or written (`unfinishedExecutionsOf`, the caller's own lease exempt).
 */
function assertNoUnfinishedExecution(consult, guard) {
  const fence = guard && typeof guard.hostWriteFence === 'function' ? guard.hostWriteFence() : null
  const ownLeaseId = fence && nonBlankString(fence.leaseId) ? fence.leaseId : null
  const open = unfinishedExecutionsOf(consult, ownLeaseId)
  if (open.length > 0) {
    throw new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.RECOVERY_PENDING, 'an earlier execution of this project did not finish cleanly; nothing is written until it is recovered', {
      state: 'failed_pending_recovery',
      openExecutions: open.length,
      partial: false,
    })
  }
}

/** O-15 for the carry lane (R-7): an open runbook-only hold (an escalated relationship) refuses the write. */
function assertNoRunbookOnlyHold(consult) {
  const runbook = consult.holds.filter((hold) => hold && hold.runbookOnly === true)
  if (runbook.length > 0) {
    throw new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.PULL_SUSPENDED, 'this project has a relationship escalated to specialist repair; nothing is written until it is closed', {
      reason: 'runbook_only_hold',
      holdCount: runbook.length,
      partial: false,
    })
  }
}

/** E-1 layer (a): a suspended plan (or one whose reconcile left a hold open) is refused by the lib itself. */
function assertPullNotSuspended(dryRun, outcome) {
  const plan = dryRun.plan
  const open = outcome && outcome.result && outcome.result.holds ? Number(outcome.result.holds.open || 0) : 0
  if (plan.suspended === true || (outcome && outcome.suspended === true)) {
    const holds = Array.isArray(plan.holds) ? plan.holds : []
    throw new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.PULL_SUSPENDED, 'this pull is suspended until its holds are decided; nothing was written', {
      partial: false,
      holdCount: Math.max(holds.length, open),
      kinds: countBy(holds.map((hold) => hold.kind)),
    })
  }
}

function bindingStale(reason) {
  return new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.BINDING_STALE, 'the relationships this preview was planned against changed; preview again', { reason, partial: false })
}

/** Governed only, with a non-null outcome (R-4): the token's binding must equal the recomputed one. */
function assertRefreshBindingCurrent(tokenRecord, outcome) {
  const bound = tokenRecord ? tokenRecord.refreshBinding : undefined
  if (!isPlainObject(bound)) throw bindingStale('binding_absent')
  if (canonicalJson(bound) !== canonicalJson(outcome.binding)) throw bindingStale('binding_moved')
}

/** Not governed: a token that carries a refresh binding was minted for a governed project — refuse. */
function assertTokenCarriesNoRefreshBinding(tokenRecord) {
  if (tokenRecord && tokenRecord.refreshBinding !== undefined) throw bindingStale('unexpected_binding')
}

// ── step 5 PR-8: the change plan and the review on the lanes (design §9.3, §10.3 (2)-(4)) ─────────────

/**
 * The project's WRITTEN plan awaiting review (at most one), from the consult's rows: `{ pending: true,
 * pendingReviews }` — values-free — or null. While one exists the formal export is refused (the derived state is
 * 变更待复核) and the small lane writes ONLY a confirmed change plan's controlled update (design §9.3
 * "change_pending_review-without-bound-plan" refuses; with a bound plan the update proceeds and absorbs the written
 * plan's unreviewed fields).
 */
function pendingReviewOf(consult) {
  const written = Array.isArray(consult.changePlans) ? consult.changePlans.filter((plan) => plan && plan.status === 'written') : []
  return written.length > 0 ? Object.freeze({ pending: true, pendingReviews: written.length }) : null
}

/**
 * What a PREVIEW answers about the review: the pending review, unless THIS computation is bound to a confirmed plan it
 * matches (then the preview mints a token for the controlled update; the review stanza still says a review is pending).
 * `blocksMint` is the preview's half of the apply's REVIEW_PENDING refusal (never promise an apply that is refused).
 */
function previewReviewOf(consult, changePlanVerdict) {
  const pending = pendingReviewOf(consult)
  if (!pending) return null
  const bound = Boolean(changePlanVerdict && changePlanVerdict.verdict === 'matches')
  return Object.freeze({ ...pending, blocksMint: !bound })
}

function changePlanStale(reason, extra = {}) {
  return new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.CHANGE_PLAN_STALE, 'the confirmed change this preview was planned with is no longer what the server computes; preview again (and confirm again if the change moved)', { reason, partial: false, ...extra })
}

/**
 * The apply's change-plan check (before SUSPENDED / BINDING_STALE / TOKEN_MISMATCH, so it answers with its own code): a
 * token minted for a confirmed plan (`refreshBinding.changePlanId`) is applied only when THIS in-lease recompute still
 * authorizes that very plan (`matches`); a plan the recompute calls stale (its reconciliation has just invalidated it),
 * or a confirmed plan that is another one, is 409 STOCK_PREP_CHANGE_PLAN_STALE (`plan_invalidated` / `plan_replaced`).
 */
function assertChangePlanCurrent(tokenRecord, changePlanVerdict) {
  const bound = tokenRecord && isPlainObject(tokenRecord.refreshBinding) && nonBlankString(tokenRecord.refreshBinding.changePlanId)
    ? tokenRecord.refreshBinding.changePlanId
    : null
  if (!bound) return
  if (!changePlanVerdict || changePlanVerdict.id !== bound) throw changePlanStale('plan_replaced')
  if (changePlanVerdict.verdict !== 'matches') throw changePlanStale('plan_invalidated', changePlanVerdict.reason ? { planReason: changePlanVerdict.reason } : {})
}

/**
 * 变更待复核 (C04 / C12; design §9.3): a written change awaits a person's review, and THIS apply is not the controlled
 * update of a confirmed plan the recompute matches => 409 STOCK_PREP_REFRESH_REVIEW_PENDING, before any write.
 */
function assertNoReviewPending(consult, changePlanVerdict) {
  const review = previewReviewOf(consult, changePlanVerdict)
  if (review && review.blocksMint) {
    throw new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.REVIEW_PENDING, 'a written change of this project awaits its review; nothing else is written until it is reviewed', {
      state: 'change_pending_review',
      pendingReviews: review.pendingReviews,
      partial: false,
    })
  }
}

// ── the execution ledger (TD-9, design §9.2-9.3) ─────────────────────────────────────────────────

/**
 * TD-9 (AMB-4): writer `held` => `succeeded` (counts.held is recorded; held rows keep the project
 * `executed_pending_settlement` until a clean computation settles it); `partial` with no failed row (held only)
 * => `succeeded`; `partial` with failures => `partial`; `failed` / `aborted` as is; anything else => `failed`.
 */
function executionFinishStatus(applyResult) {
  const status = applyResult ? applyResult.status : undefined
  if (status === 'succeeded' || status === 'held') return 'succeeded'
  if (status === 'partial') return Number(applyResult.counts && applyResult.counts.failed ? applyResult.counts.failed : 0) === 0 ? 'succeeded' : 'partial'
  if (status === 'failed') return 'failed'
  if (status === 'aborted') return 'aborted'
  return 'failed'
}

/**
 * The self-settling zero-write execution (design §9.2): its in-lease recompute IS a clean computation made
 * after every earlier execution. Non-null only when the run wrote and attempted nothing, the plan had zero
 * pending decisions, it was not suspended and the reconcile left no open hold.
 */
function selfSettlementFor({ dryRun, outcome, applyResult, guard, template }) {
  if (executionFinishStatus(applyResult) !== 'succeeded' || applyResult.status !== 'succeeded') return null
  if (Number(applyResult.written || 0) !== 0) return null
  if (countAttemptedHostWrites(applyResult) !== 0) return null
  const plan = dryRun.plan
  if (pendingDecisionCount(plan) !== 0 || plan.suspended === true) return null
  if (!outcome || !outcome.result || Number(outcome.result.holds && outcome.result.holds.open) !== 0) return null
  return Object.freeze({
    generationToken: guard && nonBlankString(guard.generationToken) ? guard.generationToken : null,
    sourceContentDigest: sourceContentDigestOf(dryRun),
    sheetMachineDigest: machineDigestOf(dryRun, template),
  })
}

// ── the large lane (TD-17) ───────────────────────────────────────────────────────────────────────

/** First match: pilot | continuation | hold | execution | review | refresh_state. */
function largeLaneRefusalReason(consult) {
  if (consult.pilot && consult.pilot.enabled === true) return 'pilot'
  if (consult.continuations.length > 0) return 'continuation'
  if (consult.holds.length > 0) return 'hold'
  if (consult.executions.length > 0) return 'execution'
  if (Array.isArray(consult.changePlans) && consult.changePlans.length > 0) return 'review'
  return 'refresh_state'
}

/**
 * The large lane never plans a governed project (design §7.1 rows 7-11): governed => 409 LARGE_LANE_REFUSED
 * with the first-match reason; otherwise the not-governed verdict the chunk hands its writer.
 */
function largeLaneVerdictOf(consult, lane) {
  if (consult.governed === true) {
    throw new StockPreparationRefreshLaneError(409, REFRESH_LANE_ERROR_CODES.LARGE_LANE_REFUSED, 'this project is governed by refresh relationships or holds; the large lane is refused for it', {
      reason: largeLaneRefusalReason(consult),
      lane,
      partial: false,
    })
  }
  return governanceVerdictOf({ consult, governed: false })
}

// ── the route-side handle (HR-2) and the source-binding check (R-1, TD-21) ───────────────────────
// Built HERE, not inside http-routes.cjs, so a direct lib test drives the very code the routes use; the route
// module only resolves its own services and calls `createRefreshGovernanceHandle`.

/**
 * #6475's no-digest leg, shared: `null` when no binding of this (tenant, action) disagrees with
 * `externalSystemId` (no store wired = no binding anywhere = every lane resolves the deploy default), else
 * `'bindings_unverifiable'` (a store that cannot list, an incomplete listing) or `'bindings_disagree'`. A
 * listing that THROWS propagates unchanged (the mvp-persist guard's behaviour, byte for byte).
 */
async function sourceBindingDisagreementOf({ sourceBindingStore, tenantId, actionId, externalSystemId }) {
  if (!sourceBindingStore) return null
  if (typeof sourceBindingStore.listForAction !== 'function') return 'bindings_unverifiable'
  const listed = await sourceBindingStore.listForAction({ tenantId, actionId })
  const bindings = listed && Array.isArray(listed.bindings) ? listed.bindings : null
  if (!bindings || listed.complete !== true) return 'bindings_unverifiable'
  if (bindings.some((binding) => !binding || binding.externalSystemId !== externalSystemId)) return 'bindings_disagree'
  return null
}

/**
 * R-1 / TD-21: a GOVERNED planning lane proves the (tenant, action) source binding is UNANIMOUS before any
 * source read — then every lane, whatever workspace hint it carries, resolves the same source, so its
 * continuation verifies on the same identity. A disagreement / an unverifiable listing is 409
 * SOURCE_BINDING_SPLIT; a listing that throws is 503 `source_binding`.
 */
async function assertRefreshSourceBindingUnanimous({ sourceBindingStore, tenantId, action }) {
  let disagreement
  try {
    disagreement = await sourceBindingDisagreementOf({
      sourceBindingStore,
      tenantId,
      actionId: action.actionId,
      externalSystemId: action.source.externalSystemId,
    })
  } catch (error) {
    throw storeFailed('source_binding', 'list_for_action', error && error.code)
  }
  if (disagreement) throw sourceBindingSplit(disagreement)
}

/**
 * THE handle a route hands `computeDryRun` (and only a route: it is frozen and server-held, built from the
 * lane's OWN tenant, never from the request body). Lazy: `resolveServices()` is called at consult / store time,
 * so an unwired service refuses 501 there — inside computeDryRun, after the field probe and before any source
 * read (P3-G2) — instead of silently planning the pre-step-4 way. `planningInputs(action)` reads the strict
 * pack band under THIS tenant (TD-22) plus the server-held ext mapping.
 */
function createRefreshGovernanceHandle({
  tenantId,
  resolveServices,
  sourceBindingStore = null,
  packInstallStore = null,
  resolveProvisioning = () => null,
  projectId,
  defaultObjectId,
  extFieldMapping = null,
  auditWithin = null,
} = {}) {
  const services = () => resolveServices()
  const store = Object.freeze({
    reconcileHolds: (input, options) => services().store.reconcileHolds(input, options),
    beginExecution: (input) => services().store.beginExecution(input),
    finishExecution: (input) => services().store.finishExecution(input),
  })
  return Object.freeze({
    // Step 5 PR-8 (refutation m2, C08 「每一步的状态、导出结果与审计可见」): the audit row a reconciliation appends ON ITS
    // OWN TRANSACTION when it invalidates a confirmed change plan. Null when the route wired none — the store then
    // refuses that invalidation 501 by name (a plan never disappears unaudited).
    auditWithin: typeof auditWithin === 'function' ? auditWithin : null,
    consult: async ({ projectNo, sheetId } = {}) => services().governance.consult({ tenantId, projectNo, sheetId }),
    assertSourceBindingUnanimous: (action) => assertRefreshSourceBindingUnanimous({ sourceBindingStore, tenantId, action }),
    planningInputs: async (action) => ({
      pack: await packInstalledFields().readPackInstalledFieldPropertiesStrict({
        packInstallStore,
        provisioning: resolveProvisioning(),
        tenantId,
        projectId,
        objectId: (action && action.target && action.target.objectId) || defaultObjectId,
      }),
      extFieldMapping,
    }),
    store,
    // The #6502 recorder's defaults (no server config key exists for its options on main).
    evidenceOptions: true,
  })
}

let lazyPackInstalledFields = null
function packInstalledFields() {
  if (!lazyPackInstalledFields) lazyPackInstalledFields = require('./stock-preparation-pack-installed-fields.cjs')
  return lazyPackInstalledFields
}

module.exports = {
  REFRESH_LANE_ERROR_CODES,
  StockPreparationRefreshLaneError,
  // Step 5 PR-8.
  assertChangePlanCurrent,
  assertNoReviewPending,
  changePlanInputFor,
  changePlanVerdictOf,
  pendingReviewOf,
  previewReviewOf,
  assertNoRunbookOnlyHold,
  assertNoUnfinishedExecution,
  assertPullNotSuspended,
  assertRefreshBindingCurrent,
  assertRefreshSourceBindingUnanimous,
  assertTokenCarriesNoRefreshBinding,
  consultForPlanning,
  continuationInputFor,
  createRefreshGovernanceHandle,
  executionFinishStatus,
  governanceVerdictOf,
  isCompleteComputation,
  isExecutionFinishedDuringPreview,
  largeLaneRefusalReason,
  largeLaneVerdictOf,
  mapContinuationStraddle,
  pickPersistedHold,
  planDigestOf,
  // PR-5: the export gate digests with the SAME strict band a governed computation settles with (TD-22).
  planningInputsOrRefuse,
  previewRecoveryOf,
  previewRecoveryRechecked,
  reconcileComputation,
  refreshBindingOf,
  refreshHoldStanza,
  refreshSourceIdentity,
  selfSettlementFor,
  settlementForComputation,
  sourceBindingDisagreementOf,
  sourceBindingSplit,
  specSlotDeclaredFor,
  stockPreparationReadPlanDigest,
  stockPreparationSourceScopeDigest,
  __internals: {
    executionFinishedDuringPreview,
    isRefreshHandle,
    liveLeaseIdOf,
    recoveryRestsOnLeaselessRunning,
    unfinishedExecutionsOf,
    planningInputsOrRefuse,
    storeFailed,
    storeUnavailable,
  },
}
