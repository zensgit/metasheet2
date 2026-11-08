'use strict'

// ---------------------------------------------------------------------------------------------------
// 批次标识 (pull batch) — THE PER-SHEET INSTALL, HISTORY BACKFILL AND GAP PASS, AND BORN READY (batch-identifier design
// §8.1-§8.6, §9, §10.2-§10.4; coordinator rulings C2 / C4 / C6 / C7 / C8 / C10 / C12; register R-65; BI-2).
//
// PORTABLE (design §12.2; P2-21). This file requires the pure module ONLY: everything host-, lock-, registry-, audit-,
// ledger- and template-specific is INJECTED by the caller (`deps`, built by the routes), so it can be copied
// byte-identical onto the R maintenance line, which passes the same shape without a lease (`withLease`,
// `holderWithinFor`, `bumpAfterRelease` absent). It never reads the environment: the route hands it `enabled`.
//
// DORMANT BY CONSTRUCTION. With the pull-batch switch OFF the route refuses `install` / `abort` (409 DISABLED) before any
// IO; `dry_run` answers from host reads only (built-in defaults, `provisional: true`, ZERO ledger IO — the ledger is
// never touched, whatever `deps` carries); `bornReadyBestEffort` answers null and the create route is byte-identical.
//
// THE INSTALL (design §8.2), one POST per run, re-runnable:
//   I0  read and plan (pure after the reads): classes, coveredUntil, columns, views, layout, PLM lock, ledger, settings,
//       the run kind, the plan (the pure module's envelope), the run set R, the fixed-point check. Refusals up front.
//   I1  the sheet write lease (main), purpose `pull_batch_install`.
//   I2  host IO, additive and idempotent: the band columns (one repair transaction, verified), the lock re-mark, the two
//       plugin views, the landing. A failure writes nothing to the ledger.
//   I3  re-read UNDER THE LEASE (every run, `continue` included — critic C5), recompute, the digest must still equal the
//       confirmed one; then PERSIST THE PLAN (Txn A) before the first cell write. From that commit every lane refuses.
//   I4  write from the PERSISTED plan, fill-blank only, record id ascending, both band ids only, within a write budget.
//   I5  re-scan: rows created after the plan / rows still blank keep the sheet `installing` (never resolve over a blank
//       machine row).
//   I6  resolve (Txn B) as the short callback of the registry lock (never held across host IO, G11).
//   I7  release the lease, then bump the generation (main).
//
// VALUES (P2-6). Answers carry modes, closed tokens, counts, booleans, ISO times, ordinals and labels (an ordinal and a
// server day) — never the project number, a record id, a key, a part id, a path or a field id. Audit details are flat
// (depth 1, plus count maps), never null (critic C4).
// ---------------------------------------------------------------------------------------------------

const {
  DEFAULT_PULL_BATCH_CONFIG,
  EXISTING_ROW_RECORD_REF,
  PULL_BATCH_APPROVAL_REF_PATTERN,
  PULL_BATCH_BAND_FIELD_IDS,
  PULL_BATCH_CONFIG_VALUES,
  PULL_BATCH_ERROR_CODES,
  PULL_BATCH_HISTORY_MODES,
  PULL_BATCH_UNKNOWN_LABELS,
  StockPreparationPullBatchError,
  extendPullBatchHistoryPlan,
  isPullBatchEvidenceRow,
  isPullBatchGapRow,
  parsePullBatchLabel,
  planPullBatchFirstInstall,
  planPullBatchGapPass,
  pullBatchHistoryAssignments,
  pullBatchInstallInferredBatches,
  pullBatchInstallPlanDigest,
  pullBatchInstallPlanLabels,
  pullBatchInstallRunSet,
  resolvePullBatchHistoryCount,
  rowPullBatchFacts,
  __internals: { assertInstallEnvelope, isPersonCreatedRow, timeMsOf },
} = require('./stock-preparation-pull-batch.cjs')

// ── closed vocabularies (pinned by the install suite) ─────────────────────────────────────────────────────────
const PULL_BATCH_INSTALL_MODES = Object.freeze(['dry_run', 'install', 'abort'])
const PULL_BATCH_INSTALL_BODY_KEYS = Object.freeze([
  'mode',
  'confirmProjectNo',
  'approvalRef',
  'planDigest',
  'confirmHistoricalBatchCount',
  'historyMode',
  'placement',
  'landing',
  'gapMinutes',
])
const PULL_BATCH_INSTALL_RUNS = Object.freeze(['first_install', 'resume_aborted', 'continue', 'gap_pass', 'noop'])
const PULL_BATCH_INSTALL_UNRESOLVED_REASONS = Object.freeze(['rows_after_plan', 'rows_unlabelled', 'write_budget'])
const PULL_BATCH_INSTALL_DRY_RUN_REFUSALS = Object.freeze([
  'disabled',
  'band_unavailable',
  'plm_lock_required',
  'placement_required',
  'config_locked',
  'plan_conflict',
  'layout_unavailable',
  'landing_unavailable',
  'extension_degenerate',
  'nothing_to_install',
])
// Why a new sheet was not born ready (design §9; the create never fails for it).
const PULL_BATCH_BIRTH_REASONS = Object.freeze([
  'ledger_unreadable',
  'audit_unavailable',
  'provisioning_unavailable',
  'sheet_has_rows',
  'band_unverified',
  'already_present',
  'race',
  'birth_failed',
])
const PULL_BATCH_INSTALL_WRITE_BUDGET = 2000
const PULL_BATCH_INSTALL_LEASE_PURPOSE = 'pull_batch_install'
const PULL_BATCH_INSTALL_VIEW_LOGICAL_IDS = Object.freeze({ fill: 'prep-fill', todo: 'prep-todo' })
const RULE_F_CAVEAT_TOKEN = 'rule_f_today_active_state'
const EPOCH = '1970-01-01T00:00:00.000Z'
const BAND_KEYS = Object.freeze(['pullBatch', 'firstPullBatch'])
const PLAN_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const ERR = PULL_BATCH_ERROR_CODES

// Codes of other modules this file answers with (spelled, never required — the file stays portable).
const PROVISIONING_UNAVAILABLE_CODE = 'STOCK_PREPARATION_PROJECT_TARGET_PROVISIONING_UNAVAILABLE'
const AUDIT_STORE_UNAVAILABLE_CODE = 'AUDIT_STORE_UNAVAILABLE'
const READER_TOO_LARGE_CODE = 'TABLE_ACTION_EXISTING_ROWS_TOO_LARGE'
const RECORD_VERSION_CONFLICT_CODE = 'VERSION_CONFLICT'
const RECORD_LOCKED_CODE = 'FORBIDDEN'

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function blank(value) {
  return !nonBlankString(value)
}

function typedError(status, code, message, details = {}) {
  const error = new StockPreparationPullBatchError(code, message, details)
  error.status = status
  return error
}

function requestInvalid(field) {
  const safe = typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) ? field : 'body'
  return typedError(400, ERR.INSTALL_REQUEST_INVALID, 'the pull-batch install request is not valid; nothing was done', { field: safe })
}

function disabledError() {
  return typedError(409, ERR.DISABLED, 'the pull-batch switch is off; nothing was installed or aborted', { partial: false })
}

function provisioningUnavailable(requiredMethods) {
  return typedError(503, PROVISIONING_UNAVAILABLE_CODE, 'this host cannot install the pull-batch band here; nothing was written', { requiredMethods })
}

function conflict(reason) {
  return typedError(409, ERR.CONFLICT, 'the batch state of this sheet moved, or the host refused the band; preview again', { reason, partial: false })
}

function planChanged(reason, extra = {}) {
  return typedError(409, ERR.PLAN_CHANGED, 'the pull-batch plan of this sheet differs from the one confirmed; preview again', { reason, ...extra, partial: false })
}

function planConflict(rows) {
  return typedError(409, ERR.PLAN_CONFLICT, 'a row of this sheet already carries a batch label the plan does not; nothing more was written', { rows, partial: false })
}

function auditNotRun(operation) {
  return typedError(500, ERR.STAMP_INVALID, 'the pull-batch audit row was not written; the install wiring is incomplete', { field: 'auditWithin', operation })
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

// Flat audit detail (ruling C8; critic C4): null / undefined / non-finite values are omitted, never written.
function flatDetail(entries) {
  const out = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    if (isPlainObject(value)) {
      const map = {}
      for (const [inner, count] of Object.entries(value)) if (typeof count === 'number' && Number.isFinite(count)) map[inner] = count
      out[key] = map
      continue
    }
    out[key] = value
  }
  return out
}

function countingAudit(auditWithin) {
  if (typeof auditWithin !== 'function') return { fn: null, count: () => 0 }
  let calls = 0
  return {
    fn: async (trx, entry) => {
      const answer = await auditWithin(trx, entry)
      calls += 1
      return answer
    },
    count: () => calls,
  }
}

function withLease(deps, fn) {
  return typeof deps.withLease === 'function' ? deps.withLease(fn) : fn(null)
}

function inHostWrite(guard, fn) {
  return guard && typeof guard.withHostWrite === 'function' ? guard.withHostWrite(fn) : fn()
}

function holderOf(deps, guard) {
  return typeof deps.holderWithinFor === 'function' && guard ? deps.holderWithinFor(guard) : null
}

// ── the request body (closed; P2-1) ─────────────────────────────────────────────────────────────────────

/**
 * The closed install body. `mode` (required) ∈ dry_run | install | abort; `confirmProjectNo` (required) a non-blank
 * string; `approvalRef` required for install / abort, shape PULL_BATCH_APPROVAL_REF_PATTERN; `planDigest` (64 lowercase
 * hex) and `confirmHistoricalBatchCount` (an integer ≥ 0) required for install; `historyMode` inferred (default) |
 * unknown; `placement` left | right; `landing` promote_prep_fill | keep_current; `gapMinutes` 1-1440. Any other key, a
 * wrong type or a value outside a closed set => 400 STOCK_PREP_PULL_BATCH_INSTALL_REQUEST_INVALID { field } (never
 * the value).
 */
function normalizePullBatchInstallBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body')
  for (const key of Object.keys(body)) {
    if (!PULL_BATCH_INSTALL_BODY_KEYS.includes(key)) throw requestInvalid(key)
  }
  const mode = body.mode
  if (!PULL_BATCH_INSTALL_MODES.includes(mode)) throw requestInvalid('mode')
  if (!nonBlankString(body.confirmProjectNo)) throw requestInvalid('confirmProjectNo')
  const optional = (key) => body[key] === undefined || body[key] === null
  let approvalRef = null
  if (!optional('approvalRef')) {
    if (typeof body.approvalRef !== 'string' || !PULL_BATCH_APPROVAL_REF_PATTERN.test(body.approvalRef)) throw requestInvalid('approvalRef')
    approvalRef = body.approvalRef
  } else if (mode !== 'dry_run') throw requestInvalid('approvalRef')
  let planDigest = null
  if (!optional('planDigest')) {
    if (typeof body.planDigest !== 'string' || !PLAN_DIGEST_PATTERN.test(body.planDigest)) throw requestInvalid('planDigest')
    planDigest = body.planDigest
  } else if (mode === 'install') throw requestInvalid('planDigest')
  let confirmHistoricalBatchCount = null
  if (!optional('confirmHistoricalBatchCount')) {
    if (!Number.isSafeInteger(body.confirmHistoricalBatchCount) || body.confirmHistoricalBatchCount < 0) throw requestInvalid('confirmHistoricalBatchCount')
    confirmHistoricalBatchCount = body.confirmHistoricalBatchCount
  } else if (mode === 'install') throw requestInvalid('confirmHistoricalBatchCount')
  let historyMode = 'inferred'
  if (!optional('historyMode')) {
    if (!PULL_BATCH_HISTORY_MODES.includes(body.historyMode)) throw requestInvalid('historyMode')
    historyMode = body.historyMode
  }
  let placement = null
  if (!optional('placement')) {
    if (!PULL_BATCH_CONFIG_VALUES.placement.includes(body.placement)) throw requestInvalid('placement')
    placement = body.placement
  }
  let landing = null
  if (!optional('landing')) {
    if (!PULL_BATCH_CONFIG_VALUES.landing.includes(body.landing)) throw requestInvalid('landing')
    landing = body.landing
  }
  let gapMinutes = null
  if (!optional('gapMinutes')) {
    if (!Number.isSafeInteger(body.gapMinutes) || body.gapMinutes < 1 || body.gapMinutes > 1440) throw requestInvalid('gapMinutes')
    gapMinutes = body.gapMinutes
  }
  return Object.freeze({ mode, confirmProjectNo: body.confirmProjectNo.trim(), approvalRef, planDigest, confirmHistoricalBatchCount, historyMode, placement, landing, gapMinutes })
}

// ── I0: the reads ────────────────────────────────────────────────────────────────────────────────────

async function readRowsOf(deps) {
  let rows
  try {
    rows = await deps.readRows()
  } catch (error) {
    if (errorCodeOf(error) === READER_TOO_LARGE_CODE) {
      throw typedError(422, ERR.INSTALL_ROWS_TOO_LARGE, 'this project sheet has more rows than one install can read; nothing was done', { partial: false })
    }
    throw error
  }
  if (!Array.isArray(rows)) throw typedError(500, ERR.STAMP_INVALID, 'the project read must answer an array', { field: 'readRows' })
  return rows
}

function historyOf(row, facts, recordId) {
  return {
    recordId,
    createdAt: facts.createdAt,
    decision: typeof row.lastPlmRefreshDecision === 'string' ? row.lastPlmRefreshDecision : null,
    plannedAt: row.lastPlmRefreshAt === undefined ? null : row.lastPlmRefreshAt,
    active: row.active,
    partId: row.componentSourceId,
    path: row.path,
    pullBatch: facts.pullBatch,
    firstPullBatch: facts.firstPullBatch,
  }
}

function recordRefOf(row) {
  const ref = row && row[EXISTING_ROW_RECORD_REF]
  if (!isPlainObject(ref) || !nonBlankString(ref.id)) return null
  return { id: ref.id, version: Number.isSafeInteger(ref.version) && ref.version > 0 ? ref.version : null }
}

/**
 * One pass over the project read (design §8.4, amended by C4 / P2-15): every row in exactly one class — locked ·
 * person · nonPlugin (creator absent, not a plugin row with a RUN stamp) · machine (evidence: labelled / half / blank);
 * the parked prefix rows: manual (M′) and unbound prefix. Locked evidence rows are plan input, never written.
 */
function readerModelOf(rows, parked) {
  const classes = { machine: 0, labelled: 0, half: 0, blank: 0, locked: 0, manual: 0, manualBlank: 0, person: 0, nonPlugin: 0, unboundPrefix: 0, unaddressable: 0 }
  const evidence = []
  const manual = []
  const labelsOnSheet = new Set()
  let coveredMs = null
  const see = (facts) => {
    const ms = timeMsOf(facts.createdAt)
    if (ms !== null && (coveredMs === null || ms > coveredMs)) coveredMs = ms
    for (const key of BAND_KEYS) if (nonBlankString(facts[key])) labelsOnSheet.add(facts[key].trim())
  }
  for (const row of rows) {
    const facts = rowPullBatchFacts(row)
    see(facts)
    const isEvidence = isPullBatchEvidenceRow(row)
    if (facts.locked) classes.locked += 1
    else if (isPersonCreatedRow(row)) classes.person += 1
    else if (!isEvidence) classes.nonPlugin += 1
    if (!isEvidence) continue
    const ref = recordRefOf(row)
    if (!ref) {
      classes.unaddressable += 1
      continue
    }
    if (!facts.locked) {
      classes.machine += 1
      const set = BAND_KEYS.filter((key) => nonBlankString(facts[key])).length
      if (set === 2) classes.labelled += 1
      else if (set === 1) classes.half += 1
      else classes.blank += 1
    }
    evidence.push({ recordId: ref.id, version: ref.version, row, facts, locked: facts.locked, createdMs: timeMsOf(facts.createdAt), history: historyOf(row, facts, ref.id) })
  }
  if (parked) {
    for (const entry of Array.isArray(parked.manualRows) ? parked.manualRows : []) {
      const facts = rowPullBatchFacts(entry.row)
      see(facts)
      classes.manual += 1
      const ref = recordRefOf(entry.row) || (nonBlankString(entry.recordId) ? { id: entry.recordId, version: null } : null)
      if (blank(facts.pullBatch) || blank(facts.firstPullBatch)) classes.manualBlank += 1
      manual.push({ recordId: ref ? ref.id : null, version: ref ? ref.version : null, facts, locked: facts.locked })
    }
    classes.unboundPrefix = Number.isSafeInteger(parked.unboundKeyCount) ? parked.unboundKeyCount : 0
  }
  return { classes, evidence, manual, labelsOnSheet, coveredUntil: coveredMs === null ? EPOCH : new Date(coveredMs).toISOString() }
}

async function readRowsModel(deps) {
  const rows = await readRowsOf(deps)
  const parked = typeof deps.parkedManualRowsOf === 'function' ? deps.parkedManualRowsOf(rows) : null
  return readerModelOf(rows, parked)
}

function propertyHides(property) {
  return isPlainObject(property) && (property.hidden === true || property.visible === false)
}

async function readColumns(deps) {
  const out = { mode: 'unavailable', pullBatch: false, firstPullBatch: false, locked: 0, unmarked: [], orders: {}, hiddenByProperty: false, manualLabel: null }
  const { provisioning, projectId, target, band } = deps
  if (!band || !provisioning || typeof provisioning.resolveExistingObjectFieldIds !== 'function') return out
  let resolved
  try {
    resolved = await provisioning.resolveExistingObjectFieldIds({ projectId, objectId: target.objectId, fieldIds: BAND_KEYS.map((key) => PULL_BATCH_BAND_FIELD_IDS[key]) })
  } catch {
    return { ...out, mode: 'unreadable' }
  }
  out.mode = 'db'
  for (const key of BAND_KEYS) {
    const logical = PULL_BATCH_BAND_FIELD_IDS[key]
    out[key] = isPlainObject(resolved) && resolved[logical] === band.fieldIds[key]
    if (!out[key] || typeof provisioning.getObjectField !== 'function') continue
    let field = null
    try {
      field = await provisioning.getObjectField({ projectId, objectId: target.objectId, fieldId: logical })
    } catch {
      field = null
    }
    const property = field && isPlainObject(field.property) ? field.property : null
    if (field && Number.isFinite(field.order)) out.orders[key] = field.order
    if (property && typeof deps.isBandProperty === 'function' && deps.isBandProperty(property)) {
      out.locked += 1
      const marker = property.stockPreparationPullBatch
      if (isPlainObject(marker) && nonBlankString(marker.manualLabel)) out.manualLabel = marker.manualLabel
    } else out.unmarked.push(key)
    if (propertyHides(property)) out.hiddenByProperty = true
  }
  return out
}

// The placement an EXISTING band has (P2-22): left iff every present band column sits before every known template
// column, else right. The known columns' orders are read through the host's field read; unreadable => by sign.
async function derivedPlacementOf(deps, columns) {
  const present = BAND_KEYS.filter((key) => columns[key] && Number.isFinite(columns.orders[key]))
  if (present.length === 0) return null
  const bandMax = Math.max(...present.map((key) => columns.orders[key]))
  const { provisioning, projectId, target } = deps
  let minKnown = null
  if (provisioning && typeof provisioning.getObjectField === 'function') {
    for (const fieldId of Array.isArray(deps.knownFieldIds) ? deps.knownFieldIds : []) {
      try {
        const field = await provisioning.getObjectField({ projectId, objectId: target.objectId, fieldId })
        if (field && Number.isFinite(field.order) && (minKnown === null || field.order < minKnown)) minKnown = field.order
      } catch {
        // an unreadable column decides nothing
      }
    }
  }
  if (minKnown === null) return bandMax < 0 ? 'left' : 'right'
  return bandMax < minKnown ? 'left' : 'right'
}

async function readViews(deps) {
  const out = { readable: false, fill: false, todo: false, rewrite: [] }
  const { provisioning, projectId, target, band } = deps
  if (!provisioning || typeof provisioning.findObjectView !== 'function') return out
  const hiddenIds = new Set(BAND_KEYS.map((key) => PULL_BATCH_BAND_FIELD_IDS[key]))
  if (band) for (const key of BAND_KEYS) hiddenIds.add(band.fieldIds[key])
  try {
    for (const [name, viewId] of Object.entries(PULL_BATCH_INSTALL_VIEW_LOGICAL_IDS)) {
      const view = await provisioning.findObjectView({ projectId, objectId: target.objectId, viewId })
      if (!view) continue
      out[name] = true
      const hidden = Array.isArray(view.hiddenFieldIds) ? view.hiddenFieldIds : []
      if (hidden.some((id) => hiddenIds.has(typeof id === 'string' ? id.trim() : String(id)))) out.rewrite.push(name)
    }
  } catch {
    return { readable: false, fill: false, todo: false, rewrite: [] }
  }
  out.readable = true
  return out
}

async function readLayout(deps) {
  const { provisioning, projectId, target } = deps
  if (!provisioning || typeof provisioning.describeObjectSheetLayout !== 'function') return null
  let layout
  try {
    layout = await provisioning.describeObjectSheetLayout({
      projectId,
      objectId: target.objectId,
      candidateViewLogicalIds: Object.values(PULL_BATCH_INSTALL_VIEW_LOGICAL_IDS),
      leftInsertCount: 2,
    })
  } catch {
    return null
  }
  if (!isPlainObject(layout)) return null
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
  const first = typeof layout.firstView === 'string' ? layout.firstView : null
  return {
    firstView: first === null ? null : first === 'prep-fill' ? 'fill' : first === 'prep-todo' ? 'todo' : first === 'default' ? 'default' : 'other',
    viewsWithFrozenColumns: count(layout.viewsWithFrozenColumns),
    viewsLosingFrozen: count(layout.viewsLosingFrozen),
    personalOrderOverrides: count(layout.personalOrderOverrides),
    trashedRecordCount: count(layout.trashedRecordCount),
  }
}

async function readPlmLock(deps) {
  const unreadable = { fieldCount: 0, marked: 0, unmarked: 0, missing: 0, readBeforeWrite: false }
  if (typeof deps.readPlmLock !== 'function') return unreadable
  try {
    const lock = await deps.readPlmLock()
    if (!isPlainObject(lock)) return unreadable
    const n = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
    return { fieldCount: n(lock.fieldCount), marked: n(lock.marked), unmarked: n(lock.unmarked), missing: n(lock.missing), readBeforeWrite: lock.readBeforeWrite === true }
  } catch {
    return unreadable
  }
}

// P2-14: every template plm_system column present and carrying the PLM lock, proven by a read.
function plmLockComplete(lock) {
  return lock.readBeforeWrite === true && lock.unmarked === 0 && lock.missing === 0 && lock.fieldCount > 0
}

function persistedPlanOf(sheet) {
  if (!sheet || !isPlainObject(sheet.historyPlan)) return null
  const plan = sheet.historyPlan
  try {
    assertInstallEnvelope(plan)
  } catch {
    return null
  }
  return plan
}

// The persisted envelope of an `installing` (or resumable) row, its stored digest checked against its content: a
// mismatch is a corrupt row (500), never a silent continue.
function verifiedPersistedPlan(sheet) {
  const plan = persistedPlanOf(sheet)
  if (!plan || pullBatchInstallPlanDigest(plan) !== sheet.historyPlanDigest || plan.digest !== sheet.historyPlanDigest) {
    throw typedError(500, ERR.STAMP_INVALID, 'the persisted pull-batch plan of this sheet is unreadable; nothing was written', { field: 'historyPlan' })
  }
  return plan
}

/**
 * The run's labelling over the plan's run set R (critic C1): R, the rows written (unlocked R rows), the prior rows (the
 * evidence rows not in R and not after the plan), the uncovered rows, the assignments (from the plan only) and the
 * per-row targets under the history mode (unknown => 历史批次未知 in both cells; rule F keeps a set 首次, C12 (b)).
 */
function labellingOf({ plan, model, historyMode, ledgerBatches }) {
  const histories = model.evidence.map((entry) => entry.history)
  const runSet = pullBatchInstallRunSet({ plan, rows: histories })
  const finalMs = timeMsOf(plan.coveredUntil)
  const runRows = model.evidence.filter((entry) => runSet.has(entry.recordId))
  const uncovered = model.evidence.filter((entry) => !runSet.has(entry.recordId) && entry.createdMs !== null && entry.createdMs > finalMs)
  const uncoveredSet = new Set(uncovered)
  const prior = model.evidence.filter((entry) => !runSet.has(entry.recordId) && !uncoveredSet.has(entry))
  const ruleF = plan.firstPullBatchRule === 'predecessor_suffix'
  const keepFirst = new Map()
  if (ruleF) for (const entry of runRows) if (nonBlankString(entry.facts.firstPullBatch)) keepFirst.set(entry.recordId, entry.facts.firstPullBatch.trim())
  const assignments = pullBatchHistoryAssignments({ plan, rows: runRows.map((entry) => entry.history), priorRows: prior.map((entry) => entry.history), ledgerBatches, keepFirst })
  const unknown = PULL_BATCH_UNKNOWN_LABELS[plan.locale]
  const targetOf = (entry) => {
    const assigned = assignments.get(entry.recordId)
    if (!assigned) return null
    const pullBatch = historyMode === 'unknown' ? unknown : assigned.pullBatch
    const firstPullBatch = keepFirst.has(entry.recordId) ? keepFirst.get(entry.recordId) : (historyMode === 'unknown' ? unknown : assigned.firstPullBatch)
    return { pullBatch, firstPullBatch }
  }
  let conflicts = 0
  let fixedPoints = 0
  const writes = []
  for (const entry of runRows.slice().sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))) {
    if (entry.locked) continue
    const target = targetOf(entry)
    if (!target) continue
    let differs = false
    let needs = false
    for (const key of BAND_KEYS) {
      const cell = entry.facts[key]
      if (blank(cell)) needs = true
      else if (cell.trim() !== target[key]) differs = true
    }
    if (differs) conflicts += 1
    else if (needs) writes.push({ entry, target })
    else fixedPoints += 1
  }
  return { plan, runSet, runRows, prior, uncovered, keepFirst, assignments, targetOf, conflicts, fixedPoints, writes, keepFirstApplied: ruleF }
}

/**
 * I0 / I3: the whole analysis of the sheet (reads, then pure). `phase` 'preview' | 'lease'. The ledger is read ONLY when
 * the switch is on (OFF => zero ledger IO, whatever deps.store is).
 */
async function analyze(deps, request) {
  const model = await readRowsModel(deps)
  const columns = await readColumns(deps)
  const views = await readViews(deps)
  const layout = await readLayout(deps)
  const plmLock = await readPlmLock(deps)
  const enabled = deps.enabled === true
  if (enabled && (!deps.store || typeof deps.store.readSheetState !== 'function' || typeof deps.store.readTenantSettings !== 'function')) {
    throw typedError(503, ERR.STORE_FAILED, 'the pull-batch ledger is not wired on this server; nothing was read', { operation: 'store_unwired', partial: false })
  }
  const ledger = enabled ? await deps.store.readSheetState(deps.scope) : null
  const sheet = ledger ? ledger.sheet : null
  const batches = ledger ? ledger.batches : []
  const tenant = enabled && !sheet ? await deps.store.readTenantSettings({ tenantId: deps.scope.tenantId }) : null
  const tenantSettings = tenant && isPlainObject(tenant.settings) ? tenant.settings : DEFAULT_PULL_BATCH_CONFIG
  const settingsSource = sheet ? 'captured' : (tenant ? tenant.source : 'built_in')
  const capture = sheet
    ? { firstPullBatchRule: sheet.firstPullBatchRule, labelFormat: sheet.labelFormat }
    : { firstPullBatchRule: tenantSettings.firstPullBatchRule, labelFormat: tenantSettings.labelFormat }
  const labelLocale = sheet ? sheet.labelLocale : deps.labelLocale()
  const refusals = []
  const refuse = (token) => {
    if (!refusals.includes(token)) refusals.push(token)
  }
  if (!enabled) refuse('disabled')
  const configLocked = []

  // Landing (C2: locked once applied).
  const appliedLanding = sheet && sheet.landingMode ? sheet.landingMode : null
  const landing = appliedLanding || request.landing || tenantSettings.landing
  if (appliedLanding && request.landing && request.landing !== appliedLanding) configLocked.push('landing')
  if (landing === 'promote_prep_fill' && !(deps.provisioning && typeof deps.provisioning.promoteObjectViewToFirst === 'function')) refuse('landing_unavailable')

  // Placement (C2, C6, P2-22): an existing band's placement is a fact; the tenant default never waives PLACEMENT_REQUIRED.
  const bandFact = await derivedPlacementOf(deps, columns)
  const appliedPlacement = bandFact || (sheet && sheet.bandPlacement) || null
  let placement
  let placementRequirement
  if (appliedPlacement) {
    placement = appliedPlacement
    placementRequirement = 'fixed'
    if (request.placement && request.placement !== appliedPlacement) configLocked.push('placement')
  } else if (layout && layout.viewsLosingFrozen > 0) {
    placementRequirement = 'required'
    placement = request.placement || null
    if (!placement) refuse('placement_required')
  } else {
    placementRequirement = 'optional'
    placement = request.placement || tenantSettings.placement
  }
  if (configLocked.length > 0) refuse('config_locked')
  if (!deps.band) refuse('band_unavailable')
  if (!layout) refuse('layout_unavailable')
  if (!plmLockComplete(plmLock)) refuse('plm_lock_required')

  // The run kind and the plan (design §8.2, §8.6; P2-3 / P2-10).
  const gapRows = model.evidence.filter((entry) => isPullBatchGapRow(entry.row))
  const manualBlank = model.manual.filter((entry) => !entry.locked && (blank(entry.facts.pullBatch) || blank(entry.facts.firstPullBatch)))
  let run
  let envelope = null
  const persisted = sheet && (sheet.historyStatus === 'installing' || sheet.historyStatus === 'pending') ? persistedPlanOf(sheet) : null
  if (!sheet) run = 'first_install'
  else if (sheet.historyStatus === 'installing') run = 'continue'
  else if (sheet.historyStatus === 'pending') {
    const labels = persisted ? pullBatchInstallPlanLabels(persisted) : null
    run = labels && Array.from(labels).some((label) => model.labelsOnSheet.has(label)) ? 'resume_aborted' : 'first_install'
  } else run = gapRows.length > 0 || manualBlank.length > 0 ? 'gap_pass' : 'noop'

  const gapMinutes = request.gapMinutes === null ? undefined : request.gapMinutes
  if (run === 'first_install') {
    envelope = planPullBatchFirstInstall({ rows: model.evidence.map((entry) => entry.history), gapMinutes, coveredUntil: model.coveredUntil, locale: labelLocale, config: capture })
  } else if (run === 'gap_pass') {
    const gapSet = new Set(gapRows)
    envelope = planPullBatchGapPass({
      gapRows: gapRows.map((entry) => entry.history),
      priorRows: model.evidence.filter((entry) => !gapSet.has(entry)).map((entry) => entry.history),
      ledgerBatches: batches,
      historyBatchCount: sheet.historyBatchCount,
      gapMinutes,
      coveredUntil: model.coveredUntil,
      locale: labelLocale,
      config: capture,
    })
  } else if (run === 'continue' || run === 'resume_aborted') {
    envelope = verifiedPersistedPlan(sheet)
  }
  if (run === 'noop') refuse('nothing_to_install')

  // The labelling of the plan, and of its extension when rows arrived after it (re-runs only).
  const historyMode = request.historyMode
  let labelling = envelope ? labellingOf({ plan: envelope, model, historyMode, ledgerBatches: batches }) : null
  let extension = null
  if (labelling && (run === 'continue' || run === 'resume_aborted') && labelling.uncovered.length > 0) {
    try {
      const extended = extendPullBatchHistoryPlan({
        persisted: envelope,
        runRows: labelling.runRows.map((entry) => entry.history),
        newRows: labelling.uncovered.map((entry) => entry.history),
        priorRows: labelling.prior.map((entry) => entry.history),
        coveredUntil: model.coveredUntil,
        ledgerBatches: batches,
        keepFirst: labelling.keepFirst,
      })
      extension = { envelope: extended, labelling: labellingOf({ plan: extended, model, historyMode, ledgerBatches: batches }) }
    } catch (error) {
      if (errorCodeOf(error) !== ERR.PLAN_CHANGED) throw error
      refuse('extension_degenerate')
    }
  }
  const effective = extension ? extension.labelling : labelling
  if (effective && effective.conflicts > 0) refuse('plan_conflict')
  return {
    model, columns, views, layout, plmLock, sheet, batches, tenant, settingsSource, capture, labelLocale,
    landing, appliedLanding, placement, placementRequirement, bandFact, configLocked, refusals,
    run, envelope, labelling, extension, manualBlank, enabled,
  }
}

// ── the answers (values-free projections, P2-6) ──────────────────────────────────────────────────────────────

function planProjectionOf(envelope) {
  if (!envelope) return null
  const gap = envelope.gapPass || null
  return {
    scheme: envelope.scheme,
    run: envelope.run,
    degenerate: envelope.degenerate === true,
    base: envelope.base,
    gapMinutes: envelope.gapMinutes,
    K: envelope.K,
    segments: envelope.segments.length,
    clusters: envelope.clusters.map((cluster) => ({
      k: cluster.k,
      evidence: cluster.evidence,
      label: cluster.label,
      rows: cluster.rows,
      timeRows: cluster.timeRows,
      active: cluster.active,
      inactive: cluster.inactive,
      startAt: cluster.startAt,
      endAt: cluster.endAt,
    })),
    unplacedRows: envelope.unplacedRows,
    interleavedRows: envelope.interleavedRows,
    exceptionCount: Array.isArray(envelope.exceptions) ? envelope.exceptions.length : 0,
    placementCount: Array.isArray(envelope.placements) ? envelope.placements.length : 0,
    joins: gap && Array.isArray(gap.joins) ? gap.joins.length : 0,
    interleavedGapRows: gap && Array.isArray(gap.interleaved) ? gap.interleaved.length : 0,
  }
}

function progressOf(state) {
  const labelling = state.extension ? state.extension.labelling : state.labelling
  if (!labelling || (state.run !== 'continue' && state.run !== 'resume_aborted')) return null
  return {
    covered: labelling.runRows.length,
    labelled: labelling.fixedPoints,
    remaining: labelling.writes.length,
    uncovered: state.labelling ? state.labelling.uncovered.length : 0,
  }
}

function dryRunAnswerOf(state, request) {
  const labelling = state.labelling
  const K = state.envelope ? state.envelope.K : 0
  return {
    mode: 'dry_run',
    switchOn: state.enabled,
    provisional: !state.enabled,
    run: state.run,
    plan: planProjectionOf(state.envelope),
    classes: { ...state.model.classes, unplaced: state.envelope ? state.envelope.unplacedRows : 0 },
    progress: progressOf(state),
    layout: state.layout ? { firstView: state.layout.firstView, viewsWithFrozenColumns: state.layout.viewsWithFrozenColumns, viewsLosingFrozen: state.layout.viewsLosingFrozen, personalOrderOverrides: state.layout.personalOrderOverrides, trashedRecordCount: state.layout.trashedRecordCount } : null,
    columns: { mode: state.columns.mode, pullBatch: state.columns.pullBatch, firstPullBatch: state.columns.firstPullBatch, locked: state.columns.locked, placementApplied: state.bandFact !== null },
    views: { fill: state.views.fill, todo: state.views.todo, rewrite: state.views.rewrite.slice(), resetsConfig: state.views.rewrite.length > 0 },
    plmLock: { ...state.plmLock },
    settings: {
      firstPullBatchRule: state.capture.firstPullBatchRule,
      labelFormat: state.capture.labelFormat,
      labelLocale: state.labelLocale,
      landing: state.landing,
      placement: state.placement,
      source: state.settingsSource,
      notes: state.capture.firstPullBatchRule === 'predecessor_suffix' ? [RULE_F_CAVEAT_TOKEN] : [],
    },
    requires: {
      approvalRef: true,
      planDigest: state.envelope ? state.envelope.digest : null,
      confirmHistoricalBatchCount: { inferred: K, unknownMin: 0 },
      // A continue names the PERSISTED run's mode (P2-18): another mode is refused on every re-run path.
      historyMode: state.run === 'continue' && state.envelope && state.envelope.historyMode ? state.envelope.historyMode : request.historyMode,
      placement: state.placementRequirement,
      landing: state.appliedLanding ? 'fixed' : 'optional',
    },
    fixedPoints: labelling ? { matching: labelling.fixedPoints, conflicting: labelling.conflicts, toWrite: labelling.writes.length, manualToWrite: state.manualBlank.length } : null,
    refusals: state.refusals.slice(),
    planDigest: state.envelope ? state.envelope.digest : null,
    extension: state.extension ? { K: state.extension.envelope.K, planDigest: state.extension.envelope.digest } : null,
  }
}

// ── the up-front refusals of an install (design §8.2 I0; P2-23) ─────────────────────────────────────────────

function assertInstallable(state, request) {
  if (state.refusals.includes('band_unavailable')) throw provisioningUnavailable(['getFieldId'])
  if (state.refusals.includes('layout_unavailable')) throw provisioningUnavailable(['describeObjectSheetLayout'])
  if (state.refusals.includes('landing_unavailable')) throw provisioningUnavailable(['promoteObjectViewToFirst'])
  if (state.refusals.includes('plm_lock_required')) {
    const lock = state.plmLock
    throw typedError(409, ERR.PLM_LOCK_REQUIRED, 'every PLM column of this sheet must be locked for people before the batch columns are installed', { fieldCount: lock.fieldCount, marked: lock.marked, unmarked: lock.unmarked, missing: lock.missing })
  }
  if (state.refusals.includes('placement_required')) {
    throw typedError(409, ERR.PLACEMENT_REQUIRED, 'a left-hand batch band would unfreeze columns of a view on this sheet; choose a placement', { viewsLosingFrozen: state.layout ? state.layout.viewsLosingFrozen : 0 })
  }
  if (state.refusals.includes('config_locked')) {
    throw typedError(409, ERR.CONFIG_LOCKED, 'the placement or landing of this sheet was already applied; it cannot change', { locked: state.configLocked.slice() })
  }
  if (state.refusals.includes('extension_degenerate')) throw planChanged('extension_degenerate')
  if (!state.placement || !state.landing) throw requestInvalid('placement')
  void request
}

// Which persisted plan this request confirms: the plan, or (a re-run) its extension.
function selectedOf(state, request) {
  if (state.extension && request.planDigest === state.extension.envelope.digest) return { envelope: state.extension.envelope, labelling: state.extension.labelling, extending: true }
  if (state.envelope && request.planDigest === state.envelope.digest) return { envelope: state.envelope, labelling: state.labelling, extending: false }
  throw planChanged('plan_digest_differs', { planDigest: state.envelope ? state.envelope.digest : null, K: state.envelope ? state.envelope.K : null, base: state.envelope ? state.envelope.base : null })
}

function assertPlanChecks(selected, request) {
  const count = resolvePullBatchHistoryCount({ plan: selected.envelope, historyMode: request.historyMode, confirmHistoricalBatchCount: request.confirmHistoricalBatchCount })
  if (selected.labelling.conflicts > 0) throw planConflict(selected.labelling.conflicts)
  return count
}

function evidenceCountsOf(envelope) {
  const counts = { plan_time: 0, created_at: 0 }
  for (const cluster of envelope.clusters) if (Object.prototype.hasOwnProperty.call(counts, cluster.evidence)) counts[cluster.evidence] += 1
  return counts
}

function installAuditDetailOf(state, selected, request, extra = {}) {
  const classes = state.model.classes
  return flatDetail({
    run: state.run,
    K: selected.envelope.K,
    base: selected.envelope.base,
    confirmedCount: request.confirmHistoricalBatchCount,
    historyMode: request.historyMode,
    placement: state.placement,
    landing: state.landing,
    viewsLosingFrozen: state.layout ? state.layout.viewsLosingFrozen : null,
    personalOrderOverrides: state.layout ? state.layout.personalOrderOverrides : null,
    trashedRecordCount: state.layout ? state.layout.trashedRecordCount : null,
    approvalRef: request.approvalRef,
    planDigest: selected.envelope.digest,
    machine: classes.machine,
    labelled: classes.labelled,
    half: classes.half,
    blankRows: classes.blank,
    locked: classes.locked,
    person: classes.person,
    nonPlugin: classes.nonPlugin,
    manual: classes.manual,
    unboundPrefix: classes.unboundPrefix,
    evidenceCounts: evidenceCountsOf(selected.envelope),
    ...extra,
  })
}

// ── I2: host IO (additive, idempotent) ───────────────────────────────────────────────────────────────────

function sameContent(before, after) {
  for (const fieldId of Object.keys(before || {})) {
    if (!after || JSON.stringify(before[fieldId]) !== JSON.stringify(after[fieldId])) return false
  }
  return true
}

/**
 * The band columns, in ONE host repair transaction (design §8.2 I2, §9 step 2): the sheet must exist; the known columns'
 * content is read before; the missing band ids are created at the placement's order (`right` = after the last KNOWN
 * column: template ∪ declared ext ∪ band, P2-19 / critic C7); a concurrently created id is 409; both ids must then
 * resolve to the derived physical ids; no existing column may change (else the transaction rolls back).
 */
async function ensureBandColumns({ deps, keys, placement, locale }) {
  const { provisioning, projectId, target, band } = deps
  if (!provisioning || typeof provisioning.runObjectFieldsRepairTransaction !== 'function') throw provisioningUnavailable(['runObjectFieldsRepairTransaction'])
  const bandLogical = BAND_KEYS.map((key) => PULL_BATCH_BAND_FIELD_IDS[key])
  const known = Array.from(new Set([...(Array.isArray(deps.knownFieldIds) ? deps.knownFieldIds : []), ...bandLogical]))
  return provisioning.runObjectFieldsRepairTransaction(async (tx) => {
    const sheet = await tx.findObjectSheet({ projectId, objectId: target.objectId })
    if (!sheet) throw conflict('sheet_absent')
    const resolved = await tx.resolveExistingObjectFieldIds({ projectId, objectId: target.objectId, fieldIds: known })
    const existing = Object.keys(isPlainObject(resolved) ? resolved : {}).filter((id) => known.includes(id))
    const before = existing.length > 0 ? await tx.readObjectFieldsContent({ projectId, objectId: target.objectId, fieldIds: existing }) : {}
    let maxOrder = -1
    for (const content of Object.values(before || {})) if (content && Number.isFinite(content.order) && content.order > maxOrder) maxOrder = content.order
    const descriptors = deps.bandDescriptors({ locale, placement, maxExistingOrder: Math.trunc(maxOrder) })
      .filter((descriptor) => keys.some((key) => PULL_BATCH_BAND_FIELD_IDS[key] === descriptor.id))
    const write = await tx.ensureMissingObjectFields({ projectId, objectId: target.objectId, fields: descriptors })
    if (write && Array.isArray(write.skippedExistingFieldIds) && write.skippedExistingFieldIds.length > 0) throw conflict('band_appeared_concurrently')
    const after = await tx.resolveExistingObjectFieldIds({ projectId, objectId: target.objectId, fieldIds: bandLogical })
    for (const key of BAND_KEYS) {
      if (!isPlainObject(after) || after[PULL_BATCH_BAND_FIELD_IDS[key]] !== band.fieldIds[key]) throw conflict('band_unverified')
    }
    const afterContent = existing.length > 0 ? await tx.readObjectFieldsContent({ projectId, objectId: target.objectId, fieldIds: existing }) : {}
    if (!sameContent(before, afterContent)) throw conflict('band_mutated_existing')
    return { added: write && Array.isArray(write.addedFieldIds) ? write.addedFieldIds.length : descriptors.length }
  })
}

async function hostIo(deps, state) {
  const { provisioning, projectId, target } = deps
  const host = { bandCreated: false, bandRepaired: false, lockRemarked: false, viewsEnsured: 0, viewsRewritten: 0, landingPromoted: false, placement: state.placement, landing: state.landing }
  const missing = BAND_KEYS.filter((key) => !state.columns[key])
  if (missing.length > 0) {
    await ensureBandColumns({ deps, keys: missing, placement: state.placement, locale: state.labelLocale })
    host.bandCreated = missing.length === 2
    host.bandRepaired = missing.length === 1
  }
  for (const key of state.columns.unmarked) {
    if (typeof provisioning.patchObjectFieldProperty !== 'function') throw provisioningUnavailable(['patchObjectFieldProperty'])
    await provisioning.patchObjectFieldProperty({ projectId, objectId: target.objectId, fieldId: PULL_BATCH_BAND_FIELD_IDS[key], propertyPatch: deps.bandPropertyOf(state.labelLocale) })
    host.lockRemarked = true
  }
  for (const [name, ensure] of [['fill', deps.ensureFillView], ['todo', deps.ensureTodoView]]) {
    const rewrite = state.views.rewrite.includes(name)
    if (state.views[name] && !rewrite) continue
    if (typeof ensure !== 'function') throw provisioningUnavailable(['ensureView'])
    await ensure({ locale: state.labelLocale })
    host.viewsEnsured += 1
    if (rewrite) host.viewsRewritten += 1
  }
  if (state.landing === 'promote_prep_fill') {
    if (typeof provisioning.promoteObjectViewToFirst !== 'function') throw provisioningUnavailable(['promoteObjectViewToFirst'])
    const promoted = await provisioning.promoteObjectViewToFirst({ projectId, objectId: target.objectId, viewLogicalId: PULL_BATCH_INSTALL_VIEW_LOGICAL_IDS.fill })
    if (!isPlainObject(promoted) || promoted.missing === true) throw conflict('fill_view_missing')
    host.landingPromoted = promoted.promoted === true || promoted.alreadyFirst === true
  }
  return host
}

// ── I4: the writes (fill-blank only, both band ids only) ─────────────────────────────────────────────────

function isVersionConflict(error) {
  return Boolean(error) && (error.code === RECORD_VERSION_CONFLICT_CODE || error.name === 'MultitableRecordVersionConflictError')
}

function isRecordLocked(error) {
  return Boolean(error) && error.code === RECORD_LOCKED_CODE
}

function cellOfRecord(record, physicalId) {
  const data = record && isPlainObject(record.data) ? record.data : {}
  const value = data[physicalId]
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function createWriter(deps, guard) {
  const patch = deps.patchBandCellsFor(guard)
  const allowed = new Set(BAND_KEYS.map((key) => deps.band.fieldIds[key]))
  const stats = { rows: 0, cells: 0, manualRows: 0, locked: 0, raced: 0, unaddressable: 0, manualOther: 0 }
  const racedIds = new Set()

  async function versionOf(recordId, version) {
    if (Number.isSafeInteger(version) && version > 0) return version
    const record = await deps.readRecord(recordId)
    return record && Number.isSafeInteger(record.version) && record.version > 0 ? record.version : null
  }

  async function send(recordId, changes, expectedVersion) {
    const keys = Object.keys(changes)
    if (keys.length === 0 || keys.some((key) => !allowed.has(key))) throw typedError(500, ERR.STAMP_INVALID, 'a pull-batch install patch may name the two band columns only', { field: 'changes' })
    await patch({ recordId, changes, expectedVersion })
    return keys.length
  }

  // One row: blank cells only. Answers 'written' | 'locked' | 'raced' | 'unaddressable' | 'skipped'.
  async function writeOne({ recordId, version, cells, target }) {
    const changes = {}
    for (const key of BAND_KEYS) if (blank(cells[key])) changes[deps.band.fieldIds[key]] = target[key]
    if (Object.keys(changes).length === 0) return { outcome: 'skipped', cells: 0 }
    const expectedVersion = await versionOf(recordId, version)
    if (expectedVersion === null) return { outcome: 'unaddressable', cells: 0 }
    try {
      return { outcome: 'written', cells: await send(recordId, changes, expectedVersion) }
    } catch (error) {
      if (isRecordLocked(error)) return { outcome: 'locked', cells: 0 }
      if (!isVersionConflict(error)) throw error
    }
    // VERSION_CONFLICT (a person edited a human column of the record): one fresh read, one retry while still blank.
    const fresh = await deps.readRecord(recordId)
    if (!fresh) return { outcome: 'raced', cells: 0 }
    if (fresh.locked === true) return { outcome: 'locked', cells: 0 }
    const retry = {}
    for (const key of BAND_KEYS) {
      const physical = deps.band.fieldIds[key]
      if (Object.prototype.hasOwnProperty.call(changes, physical) && blank(cellOfRecord(fresh, physical))) retry[physical] = changes[physical]
    }
    const freshVersion = Number.isSafeInteger(fresh.version) && fresh.version > 0 ? fresh.version : null
    if (Object.keys(retry).length !== Object.keys(changes).length || freshVersion === null) return { outcome: 'raced', cells: 0 }
    try {
      return { outcome: 'written', cells: await send(recordId, retry, freshVersion) }
    } catch (error) {
      if (isRecordLocked(error)) return { outcome: 'locked', cells: 0 }
      if (isVersionConflict(error)) return { outcome: 'raced', cells: 0 }
      throw error
    }
  }

  function count(result, { manual, recordId }) {
    if (result.outcome === 'written') {
      if (manual) stats.manualRows += 1
      else stats.rows += 1
      stats.cells += result.cells
    } else if (result.outcome === 'locked') stats.locked += 1
    else if (result.outcome === 'unaddressable') stats.unaddressable += 1
    else if (result.outcome === 'raced') {
      stats.raced += 1
      racedIds.add(recordId)
    }
  }

  return { writeOne, count, stats, racedIds }
}

/**
 * I4 over the in-lease read: the machine rows of R that need a write (record id ascending), then the M′ manual rows
 * (人工补充, fill-blank), within `budget` patched rows per request (P2-16). A cell that changed to another label since the
 * up-front check stops the run (409 PLAN_CONFLICT; the sheet stays `installing`). Answers the stats and `remaining`.
 */
async function writeRun({ deps, guard, labelling, manualRows, manualLabel, budget }) {
  const writer = createWriter(deps, guard)
  const manualQueue = manualRows
    .filter((entry) => !entry.locked && entry.recordId && (blank(entry.facts.pullBatch) || blank(entry.facts.firstPullBatch)))
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
  const queue = [
    ...labelling.writes.map(({ entry, target }) => ({ recordId: entry.recordId, version: entry.version, cells: entry.facts, target, manual: false })),
    ...manualQueue.map((entry) => ({ recordId: entry.recordId, version: entry.version, cells: entry.facts, target: { pullBatch: manualLabel, firstPullBatch: manualLabel }, manual: true })),
  ]
  for (const entry of manualRows) {
    if (entry.locked) continue
    for (const key of BAND_KEYS) {
      const parsed = parsePullBatchLabel(entry.facts[key])
      if (parsed.kind !== 'blank' && parsed.kind !== 'manual') {
        writer.stats.manualOther += 1
        break
      }
    }
  }
  let patched = 0
  for (let index = 0; index < queue.length; index += 1) {
    if (patched >= budget) return { stats: writer.stats, racedIds: writer.racedIds, remaining: queue.length - index, budgetHit: true }
    const item = queue[index]
    if (!item.manual) {
      for (const key of BAND_KEYS) {
        if (!blank(item.cells[key]) && item.cells[key].trim() !== item.target[key]) throw planConflict(1)
      }
    }
    const result = await writer.writeOne(item)
    writer.count(result, item)
    if (result.outcome === 'written') patched += 1
  }
  return { stats: writer.stats, racedIds: writer.racedIds, remaining: 0, budgetHit: false, writer }
}

// ── the install (design §8.2) ──────────────────────────────────────────────────────────────────────────

function requireLedgerDeps(deps) {
  if (!deps.store || typeof deps.store.beginInstall !== 'function' || typeof deps.store.readSheetState !== 'function' || typeof deps.store.abortInstall !== 'function') {
    throw typedError(503, ERR.STORE_FAILED, 'the pull-batch ledger is not wired on this server; nothing was written', { operation: 'store_unwired', partial: false })
  }
  if (typeof deps.auditWithin !== 'function') {
    throw typedError(501, AUDIT_STORE_UNAVAILABLE_CODE, 'the audit store cannot write inside the install transaction here; nothing was written', {})
  }
}

function nextStatusOf({ envelope, model, labelling, sheet }) {
  if (envelope.run === 'first_install') return envelope.K === 0 && model.evidence.length === 0 ? 'born_empty' : 'backfilled'
  // A re-run reads the status its Txn A recorded; a fresh gap pass reads the in-lease row's own resolved status.
  const previous = envelope.previousHistoryStatus || (sheet && (sheet.historyStatus === 'born_empty' || sheet.historyStatus === 'backfilled') ? sheet.historyStatus : null)
  const touched = labelling.runRows.length > 0 || envelope.K > 0
  return !touched && (previous === 'born_empty' || previous === 'backfilled') ? previous : 'backfilled'
}

async function runInstall(deps, request) {
  requireLedgerDeps(deps)
  const preview = await analyze(deps, request)
  assertInstallable(preview, request)
  if (preview.run === 'noop') {
    return { mode: 'install', run: 'noop', resolved: true, reason: null, historyStatus: preview.sheet ? preview.sheet.historyStatus : null, planDigest: null, K: 0, written: { rows: 0, cells: 0, manualRows: 0 }, skipped: { fixedPoint: 0, locked: preview.model.classes.locked, person: preview.model.classes.person, nonPlugin: preview.model.classes.nonPlugin, unboundPrefix: preview.model.classes.unboundPrefix }, raced: 0, host: null, generationBumped: false }
  }
  assertPlanChecks(selectedOf(preview, request), request)
  // P2-18 (review fix): a re-run keeps the persisted run's history mode on EVERY continue path — the plain continue and
  // the extension alike — refused here, before the lease and any IO (the store re-checks both under the holder).
  if (preview.run === 'continue' && preview.envelope && preview.envelope.historyMode !== request.historyMode) throw planChanged('history_mode_changed')
  const audit = countingAudit(deps.auditWithin)
  const budget = Number.isSafeInteger(deps.writeBudget) && deps.writeBudget > 0 ? deps.writeBudget : PULL_BATCH_INSTALL_WRITE_BUDGET
  let persistedAny = false
  const answer = await withLease(deps, async (guard) => {
    // I2 — host IO, outside every ledger transaction and the registry lock.
    const host = await hostIo(deps, preview)
    // I3 — re-read and recompute UNDER THE LEASE (every run, continue included: critic C5).
    const state = await analyze(deps, request)
    if (state.refusals.includes('band_unavailable') || state.refusals.includes('plm_lock_required')) assertInstallable(state, request)
    if (state.configLocked.length > 0) assertInstallable(state, request)
    if (state.run !== preview.run) throw planChanged('run_changed')
    const selected = selectedOf(state, request)
    const count = assertPlanChecks(selected, request)
    const holderWithin = holderOf(deps, guard)
    const sheet = state.sheet
    const capture = state.capture
    if (state.run === 'continue') {
      if (selected.extending) {
        await inHostWrite(guard, () => deps.store.extendInstall({ ...deps.scope, fromDigest: state.envelope.digest, plan: selected.envelope, planDigest: selected.envelope.digest, historyMode: request.historyMode, approvalRef: request.approvalRef, holderWithin }))
      } else {
        await inHostWrite(guard, () => deps.store.continueInstall({ ...deps.scope, planDigest: selected.envelope.digest, historyMode: request.historyMode, approvalRef: request.approvalRef, holderWithin }))
      }
    } else {
      const before = audit.count()
      await inHostWrite(guard, () => deps.store.beginInstall({
        ...deps.scope,
        expect: sheet ? { historyStatus: sheet.historyStatus, version: sheet.version } : { historyStatus: null, version: null },
        plan: selected.envelope,
        planDigest: selected.envelope.digest,
        labelLocale: state.labelLocale,
        capture,
        bandPlacement: state.placement,
        landingMode: state.landing,
        historyMode: request.historyMode,
        approvalRef: request.approvalRef,
        installedBy: deps.actor,
        holderWithin,
        auditWithin: audit.fn,
        auditDetail: installAuditDetailOf(state, selected, request, { landingPromoted: host.landingPromoted }),
      }))
      if (audit.count() === before) throw auditNotRun('begin_install')
    }
    persistedAny = true
    // I4 — from the PERSISTED plan (re-labelled from it, never re-planned).
    const manualLabel = state.columns.manualLabel || deps.bandPropertyOf(state.labelLocale).stockPreparationPullBatch.manualLabel
    const run = await writeRun({ deps, guard, labelling: selected.labelling, manualRows: state.model.manual, manualLabel, budget })
    const base = {
      mode: 'install',
      run: state.run,
      planDigest: selected.envelope.digest,
      K: selected.envelope.K,
      written: { rows: run.stats.rows, cells: run.stats.cells, manualRows: run.stats.manualRows },
      skipped: { fixedPoint: selected.labelling.fixedPoints, locked: state.model.classes.locked + run.stats.locked, person: state.model.classes.person, nonPlugin: state.model.classes.nonPlugin, unboundPrefix: state.model.classes.unboundPrefix, manualOther: run.stats.manualOther },
      raced: run.stats.raced,
      host,
    }
    if (run.budgetHit) return { ...base, resolved: false, reason: 'write_budget', remaining: run.remaining, historyStatus: 'installing' }
    // I5 — re-scan (fresh versions); raced rows once more.
    let after = await readRowsModel(deps)
    let labellingAfter = labellingOf({ plan: selected.envelope, model: after, historyMode: request.historyMode, ledgerBatches: state.batches })
    if (labellingAfter.uncovered.length > 0) return { ...base, resolved: false, reason: 'rows_after_plan', count: labellingAfter.uncovered.length, historyStatus: 'installing' }
    if (run.racedIds.size > 0) {
      const retry = await writeRun({ deps, guard, labelling: { writes: labellingAfter.writes.filter(({ entry }) => run.racedIds.has(entry.recordId)) }, manualRows: [], manualLabel, budget })
      base.written.rows += retry.stats.rows
      base.written.cells += retry.stats.cells
      base.raced = retry.stats.raced
      after = await readRowsModel(deps)
      labellingAfter = labellingOf({ plan: selected.envelope, model: after, historyMode: request.historyMode, ledgerBatches: state.batches })
    }
    if (labellingAfter.conflicts > 0) throw planConflict(labellingAfter.conflicts)
    const unlabelled = labellingAfter.writes.length + after.classes.unaddressable
    if (unlabelled > 0) return { ...base, resolved: false, reason: 'rows_unlabelled', count: unlabelled, historyStatus: 'installing' }
    // I6 — resolve (Txn B) as the short callback of the registry lock.
    const inferredBatches = count.writesInferredBatches ? pullBatchInstallInferredBatches(selected.envelope) : []
    const nextStatus = nextStatusOf({ envelope: selected.envelope, model: after, labelling: labellingAfter, sheet })
    const before = audit.count()
    const resolved = await deps.withRegistryLock(async (locked) => {
      if (!locked || locked.sheetId !== deps.scope.sheetId || locked.objectId !== deps.target.objectId) throw conflict('registry_moved')
      return inHostWrite(guard, () => deps.store.resolveInstall({
        ...deps.scope,
        planDigest: selected.envelope.digest,
        inferredBatches,
        historyMode: request.historyMode,
        historyBatchCount: count.historyBatchCount,
        nextStatus,
        resolvedBy: deps.actor,
        holderWithin,
        auditWithin: audit.fn,
        auditDetail: installAuditDetailOf(state, selected, request, {
          rowsWritten: base.written.rows,
          cellsWritten: base.written.cells,
          manualRowsWritten: base.written.manualRows,
          raced: base.raced,
          landingPromoted: host.landingPromoted,
          historyBatchCount: count.historyBatchCount,
        }),
      }))
    })
    if (audit.count() === before) throw auditNotRun('resolve_install')
    return {
      ...base,
      resolved: true,
      reason: null,
      historyStatus: resolved.sheet.historyStatus,
      historyBatchCount: count.historyBatchCount,
      firstLiveBatchNo: count.firstLiveBatchNo,
    }
  })
  // I7 — after the lease is released: the generation bump (main), best effort (P2-13).
  let generationBumped = false
  if (persistedAny && typeof deps.bumpAfterRelease === 'function') {
    try {
      await deps.bumpAfterRelease()
      generationBumped = true
    } catch (error) {
      logWarn(deps.logger, '[plugin-integration-core] stock-prep pull-batch install: the generation bump after release failed', { code: errorCodeOf(error) })
    }
  }
  return { ...answer, generationBumped }
}

// ── abort (design §8.2; ruling C7; P2-9 / P2-24) ───────────────────────────────────────────────────────────

async function runAbort(deps, request) {
  requireLedgerDeps(deps)
  const audit = countingAudit(deps.auditWithin)
  return withLease(deps, async (guard) => {
    const ledger = await deps.store.readSheetState(deps.scope)
    const sheet = ledger.sheet
    const model = await readRowsModel(deps)
    const labelsOnSheet = new Set(model.labelsOnSheet)
    const plan = sheet && sheet.historyStatus === 'installing' ? persistedPlanOf(sheet) : null
    if (plan) {
      // Unbound prefix rows are counted, not read: their cells may carry a plan label — keep the lock (fail safe).
      if (model.classes.unboundPrefix > 0) for (const label of pullBatchInstallPlanLabels(plan)) labelsOnSheet.add(label)
      if (plan.run === 'gap_pass') {
        // P2-24: a run row of the gap pass that now carries both cells was written by it (gap rows had a blank cell
        // and nothing else writes them while installing) — finishing it is the only way out.
        const runSet = pullBatchInstallRunSet({ plan, rows: model.evidence.map((entry) => entry.history) })
        const written = model.evidence.some((entry) => runSet.has(entry.recordId) && !entry.locked && BAND_KEYS.every((key) => nonBlankString(entry.facts[key])))
        if (written) throw conflict('plan_labels_on_sheet')
      }
    }
    const before = audit.count()
    const answer = await inHostWrite(guard, () => deps.store.abortInstall({ ...deps.scope, labelsOnSheet, holderWithin: holderOf(deps, guard), auditWithin: audit.fn }))
    if (audit.count() === before) throw auditNotRun('abort_install')
    void request
    return { mode: 'abort', historyStatus: answer.historyStatus, firstInstall: answer.firstInstall, settingsReleased: answer.settingsReleased }
  })
}

/**
 * The install route's one entry point (the route has run the guard chain: ADMIN, the project-sheets switch, the closed
 * body, the pull-batch switch for install / abort, the typed project number, the scope, the registry row, the target,
 * the audit vocabulary and the ledger probe).
 */
async function runPullBatchInstallRequest(deps, body) {
  const request = normalizePullBatchInstallBody(body)
  if (request.mode !== 'dry_run' && deps.enabled !== true) throw disabledError()
  if (request.mode === 'abort') return runAbort(deps, request)
  if (request.mode === 'install') return runInstall(deps, request)
  if (!deps.band) {
    return {
      mode: 'dry_run', switchOn: deps.enabled === true, provisional: deps.enabled !== true, run: null, plan: null, classes: null, progress: null, layout: null,
      columns: null, views: null, plmLock: null, settings: null, requires: null, fixedPoints: null,
      refusals: deps.enabled === true ? ['band_unavailable'] : ['disabled', 'band_unavailable'], planDigest: null, extension: null,
    }
  }
  return dryRunAnswerOf(await analyze(deps, request), request)
}

// ── born ready (design §9; P2-7) ──────────────────────────────────────────────────────────────────────

function emptyRead(model) {
  return model.evidence.length === 0 && model.classes.locked === 0 && model.classes.person === 0 && model.classes.nonPlugin === 0
    && model.classes.manual === 0 && model.classes.unboundPrefix === 0 && model.classes.unaddressable === 0
}

/**
 * A NEW project sheet born ready, best effort (the create never fails for it). `deps` null (the switch off: the route's
 * deps builder answers null before any IO) => null. Otherwise: ledger probe -> zero-row read -> the tenant settings ->
 * the band at the tenant placement (one repair transaction, verified) -> the landing per the tenant setting -> zero-row
 * RE-read -> the `born_empty` row (with the applied placement / landing) and its audit. Answers
 * `{ installed, landingPromoted, reason }` (reason ∈ PULL_BATCH_BIRTH_REASONS or null).
 */
async function bornReadyBestEffort(deps) {
  if (!deps || deps.enabled !== true) return null
  let landingPromoted = false
  try {
    if (!deps.band || !deps.provisioning || typeof deps.provisioning.runObjectFieldsRepairTransaction !== 'function') return { installed: false, landingPromoted, reason: 'provisioning_unavailable' }
    if (!deps.store || typeof deps.store.bornReady !== 'function' || typeof deps.store.probeReadable !== 'function') return { installed: false, landingPromoted, reason: 'ledger_unreadable' }
    if (typeof deps.auditWithin !== 'function') return { installed: false, landingPromoted, reason: 'audit_unavailable' }
    try {
      await deps.store.probeReadable()
    } catch {
      return { installed: false, landingPromoted, reason: 'ledger_unreadable' }
    }
    if (!emptyRead(await readRowsModel(deps))) return { installed: false, landingPromoted, reason: 'sheet_has_rows' }
    const tenant = await deps.store.readTenantSettings({ tenantId: deps.scope.tenantId })
    const settings = tenant && isPlainObject(tenant.settings) ? tenant.settings : DEFAULT_PULL_BATCH_CONFIG
    const locale = deps.labelLocale()
    try {
      await ensureBandColumns({ deps, keys: BAND_KEYS.slice(), placement: settings.placement, locale })
    } catch (error) {
      if (errorCodeOf(error) === ERR.CONFLICT) return { installed: false, landingPromoted, reason: 'band_unverified' }
      throw error
    }
    let landingMode = null
    if (settings.landing === 'keep_current') landingMode = 'keep_current'
    else if (typeof deps.provisioning.promoteObjectViewToFirst === 'function') {
      const promoted = await deps.provisioning.promoteObjectViewToFirst({ projectId: deps.projectId, objectId: deps.target.objectId, viewLogicalId: PULL_BATCH_INSTALL_VIEW_LOGICAL_IDS.fill })
      landingPromoted = isPlainObject(promoted) && (promoted.promoted === true || promoted.alreadyFirst === true)
      if (landingPromoted) landingMode = 'promote_prep_fill'
    }
    if (!emptyRead(await readRowsModel(deps))) return { installed: false, landingPromoted, reason: 'sheet_has_rows' }
    const audit = countingAudit(deps.auditWithin)
    const born = await deps.store.bornReady({
      ...deps.scope,
      labelLocale: locale,
      capture: { firstPullBatchRule: settings.firstPullBatchRule, labelFormat: settings.labelFormat },
      bandPlacement: settings.placement,
      landingMode,
      resolvedBy: deps.actor,
      auditWithin: audit.fn,
      auditDetail: flatDetail({ placement: settings.placement, landing: landingMode || 'unset', landingPromoted, source: tenant ? tenant.source : 'built_in' }),
    })
    if (!born.created) return { installed: false, landingPromoted, reason: born.reason === 'race' ? 'race' : 'already_present' }
    if (audit.count() === 0) throw auditNotRun('born_ready')
    return { installed: true, landingPromoted, reason: null }
  } catch (error) {
    logWarn(deps.logger, '[plugin-integration-core] stock-prep pull-batch birth degraded; the sheet was created in the legacy shape', { code: errorCodeOf(error) })
    return { installed: false, landingPromoted, reason: 'birth_failed' }
  }
}

module.exports = {
  PULL_BATCH_BIRTH_REASONS,
  PULL_BATCH_INSTALL_BODY_KEYS,
  PULL_BATCH_INSTALL_DRY_RUN_REFUSALS,
  PULL_BATCH_INSTALL_LEASE_PURPOSE,
  PULL_BATCH_INSTALL_MODES,
  PULL_BATCH_INSTALL_RUNS,
  PULL_BATCH_INSTALL_UNRESOLVED_REASONS,
  PULL_BATCH_INSTALL_VIEW_LOGICAL_IDS,
  PULL_BATCH_INSTALL_WRITE_BUDGET,
  bornReadyBestEffort,
  normalizePullBatchInstallBody,
  runPullBatchInstallRequest,
  __internals: {
    RULE_F_CAVEAT_TOKEN,
    analyze,
    ensureBandColumns,
    flatDetail,
    labellingOf,
    readerModelOf,
    writeRun,
  },
}
