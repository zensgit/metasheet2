'use strict'

// ---------------------------------------------------------------------------------------------------
// 批次标识 (pull batch) — THE LANES HELPER (batch-identifier design §3.4-§3.8, §4.4, §6.1-§6.4, §7.1; coordinator
// rulings C4 / C12; register R-65). Everything the pull lanes need to stamp 本次拉取 / 首次批次 lives HERE, so the
// existing table-action / large-BOM / route code gains only call lines (the integration line ports those lines
// into its governed entries mechanically).
//
// THE SWITCH. `STOCK_PREP_PULL_BATCH_ENABLED`, default OFF, exact literal 'true' (no trim, no case folding), read PER
// REQUEST by the routes through `stockPrepPullBatchEnabled()` — this file is its one reader (the flag manifest's
// family scan pins that). The libs never read the environment: the route hands them `enabled` inside the server-held
// lane input, so direct lib tests drive it explicitly. OFF => zero ledger IO and no `pullBatch` key in any answer.
//
// THE BAND IS SWITCH-INDEPENDENT. `derivePullBatchBand` computes the two PHYSICAL ids the band install would create
// (the host's pure `getFieldId` derivation) whatever the switch says and whether or not the band exists, and the
// reader strips both cells onto a Symbol (design §4.4), so a token minted before an install and an apply after it
// hash the same rows. The derivation NEVER throws: a host without provisioning, without `getFieldId`, or whose
// derivation answers anything but two distinct strings (or collides with a mapped template column) has no band, and
// every lane runs exactly as before (critic BI-1b M1).
//
// ONE EVALUATION PER EXECUTION (design §6.1): switch -> band probe (db mode, both ids; no ledger IO otherwise) -> ONE
// ledger read -> installing (409 on writes) / pending -> gap rows (C4 evidence only) -> the stamp (carry map, labels
// on the sheet, the captured rule as `expectedRule`). The ledger allocation itself is lazy, inside the writer's create
// leg (design §3.4).
//
// VALUES. Answers carry booleans, closed reason tokens, counts, batch numbers and labels (an ordinal and a day). The
// carry map (keyed by idempotency keys) and the physical band ids stay server-held: they are never answered, logged
// or hashed.
// ---------------------------------------------------------------------------------------------------

const {
  PULL_BATCH_BAND_FIELD_IDS,
  PULL_BATCH_ERROR_CODES,
  StockPreparationPullBatchError,
  buildFirstPullBatchByKey,
  countPullBatchGapRows,
  normalizePullBatchReaderBand,
  pullBatchSourceDigest,
  rowPullBatchFacts,
} = require('./stock-preparation-pull-batch.cjs')
const {
  PULL_BATCH_RESOLVED_HISTORY_STATUSES,
  __internals: { EXECUTION_REF_PATTERN },
} = require('./stock-preparation-pull-batch-store.cjs')
// F-7 (R-65): the writer's own zero-IO stamp checks, pre-run by the large chunk gate (one copy, never a re-derivation).
const { assertWriterAdmitsPullBatchStamp } = require('./stock-preparation-apply-writer.cjs')

// ── the switch (design §7.1; the members-page reader shape) ─────────────────────────────────────────────────────────
const STOCK_PREP_PULL_BATCH_ENABLED_ENV = 'STOCK_PREP_PULL_BATCH_ENABLED'

function stockPrepPullBatchEnabled(env = process.env) {
  return Boolean(env) && env[STOCK_PREP_PULL_BATCH_ENABLED_ENV] === 'true'
}

// Why a PREVIEW (dry-run, large plan) says a coming write would not stamp (closed; the lanes suite pins it).
const PULL_BATCH_PREVIEW_REASONS = Object.freeze([
  'not_installed',
  'columns_unproven',
  'columns_partial',
  'history_pending',
  'installing',
  'history_gap',
  'ledger_unreadable',
])

// The logical band ids folded into the target field probe as OPTIONAL ids (never refusing).
const PULL_BATCH_PROBE_FIELD_IDS = Object.freeze([PULL_BATCH_BAND_FIELD_IDS.pullBatch, PULL_BATCH_BAND_FIELD_IDS.firstPullBatch])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function stampInvalid(field, message) {
  return new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.STAMP_INVALID, message, { field, partial: false })
}

function storeFailed(operation, cause) {
  const error = new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.STORE_FAILED, 'the pull-batch ledger could not be read; nothing was written', { operation, partial: false })
  if (cause) error.cause = cause
  return error
}

function installInProgress() {
  return new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.INSTALL_IN_PROGRESS, 'the batch history of this sheet is being installed; pull again after it finishes', { partial: false })
}

function replanRequired(reason) {
  return new StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.JOB_REPLAN_REQUIRED, 'this large job was planned without the batch columns of this sheet; expand and plan again', { reason, partial: false })
}

// A typed refusal (the store's, the holder assert's: an HTTP status and a closed code) passes through; anything else
// is the ledger's 503.
function isTypedRefusal(error) {
  return Boolean(error) && Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)
}

// ── the band (design §4.4; critic M1) ────────────────────────────────────────────────────────────────────────────

/**
 * The server-held band of a target: `{ fieldIds: { pullBatch, firstPullBatch } }` (PHYSICAL ids) or `undefined`. Pure
 * and non-throwing (no IO: `getFieldId` is the host's derivation). `undefined` whenever the host offers no
 * `getFieldId`, the target names no object, the derivation answers anything but two distinct non-blank strings, or an
 * id collides with a mapped template column — "no band", never a 5xx (switch off included).
 */
function derivePullBatchBand({ provisioning, projectId, target } = {}) {
  try {
    if (!provisioning || typeof provisioning.getFieldId !== 'function') return undefined
    if (!nonBlankString(projectId) || !isPlainObject(target) || !nonBlankString(target.objectId)) return undefined
    const pullBatch = provisioning.getFieldId(projectId, target.objectId, PULL_BATCH_BAND_FIELD_IDS.pullBatch)
    const firstPullBatch = provisioning.getFieldId(projectId, target.objectId, PULL_BATCH_BAND_FIELD_IDS.firstPullBatch)
    return normalizePullBatchReaderBand({ fieldIds: { pullBatch, firstPullBatch } }, { fieldIdMap: target.fieldIdMap }) || undefined
  } catch {
    return undefined
  }
}

// ── the lane input (server-held; built by the route) ─────────────────────────────────────────────────────────────

/**
 * `input.pullBatch` of a lib entry point: `{ band, enabled, store, tenantId, holderWithin }` (the route's
 * `pullBatchContextFor`). `undefined` / `null` => null (a direct lib caller: no band, switch off). A malformed one is a
 * route defect: 500 STAMP_INVALID before any IO.
 */
function normalizePullBatchLaneInput(value) {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) throw stampInvalid('pullBatch', 'the pull-batch lane input must be an object')
  if (value.enabled !== true && value.enabled !== false) throw stampInvalid('pullBatch.enabled', 'the pull-batch lane input must say whether the switch is on')
  const band = value.band === undefined || value.band === null ? null : normalizePullBatchReaderBand(value.band)
  if (value.holderWithin !== undefined && value.holderWithin !== null && typeof value.holderWithin !== 'function') {
    throw stampInvalid('pullBatch.holderWithin', 'the holder assert must be a function')
  }
  return Object.freeze({
    band,
    enabled: value.enabled,
    store: value.enabled === true ? (value.store || null) : null,
    tenantId: nonBlankString(value.tenantId) ? value.tenantId.trim() : null,
    holderWithin: typeof value.holderWithin === 'function' ? value.holderWithin : null,
  })
}

/**
 * The reconcile / mvp-persist lanes: the band ONLY — they hash rows, so they must strip, but they never fold the probe,
 * read the ledger or answer a stanza. Same validation as the full lane input.
 */
function readerOnlyLaneOf(value) {
  const lane = normalizePullBatchLaneInput(value)
  if (!lane) return null
  return Object.freeze({ band: lane.band, enabled: false, store: null, tenantId: lane.tenantId, holderWithin: null })
}

/** The band the reader strips with (switch-independent), or undefined. */
function readerBandOf(lane) {
  return lane && lane.band ? lane.band : undefined
}

/** The optional-id fold of the target field probe: ON with a band only (OFF => no third argument, byte-identical). */
function pullBatchProbeOptions(lane) {
  return lane && lane.enabled === true && lane.band ? { optionalFieldIds: PULL_BATCH_PROBE_FIELD_IDS } : undefined
}

/**
 * The probe stanza a computation carries on its RESULT (never on `plan`, never hashed or serialized): ON only.
 * `present.x` is true only when the probe resolved the logical id AND it equals the derived physical id.
 */
function pullBatchProbeStanza(lane, verdict) {
  if (!lane || lane.enabled !== true) return null
  const band = lane.band
  const optional = verdict && isPlainObject(verdict.optional) ? verdict.optional : {}
  const presentOf = (key) => Boolean(band) && typeof optional[PULL_BATCH_BAND_FIELD_IDS[key]] === 'string'
    && optional[PULL_BATCH_BAND_FIELD_IDS[key]] === band.fieldIds[key]
  return Object.freeze({
    fieldIds: band ? band.fieldIds : null,
    mode: verdict && typeof verdict.fieldExistenceMode === 'string' ? verdict.fieldExistenceMode : null,
    present: Object.freeze({ pullBatch: presentOf('pullBatch'), firstPullBatch: presentOf('firstPullBatch') }),
  })
}

/** Design §6.1 step 2: why the band is not usable (no ledger IO follows), or null when both ids are db-proven. */
function bandReasonOf(probe) {
  if (!probe || !probe.fieldIds) return 'not_installed'
  if (probe.mode !== 'db') return 'columns_unproven'
  const count = (probe.present.pullBatch ? 1 : 0) + (probe.present.firstPullBatch ? 1 : 0)
  if (count === 0) return 'not_installed'
  if (count === 1) return 'columns_partial'
  return null
}

/** Design §6.1 step 4 over the ledger's `_sheet` row: 'installing' | 'history_pending' | null (resolved). */
function ledgerReasonOf(sheet) {
  if (!sheet) return 'history_pending'
  if (sheet.historyStatus === 'installing') return 'installing'
  if (!PULL_BATCH_RESOLVED_HISTORY_STATUSES.includes(sheet.historyStatus)) return 'history_pending'
  return null
}

function scopeOf(lane, { sheetId, projectNo }) {
  if (!lane || !nonBlankString(lane.tenantId) || !nonBlankString(sheetId) || !nonBlankString(projectNo)) {
    throw stampInvalid('pullBatch.scope', 'the pull-batch lane needs the proven tenant, the sheet and the project')
  }
  return Object.freeze({ tenantId: lane.tenantId, sheetId: sheetId.trim(), projectNo: projectNo.trim() })
}

/** ONE ledger read (design §6.1 step 3). A failure is the ledger's typed 503 (a typed refusal keeps its code). */
async function readLedger(lane, scope) {
  const store = lane.store
  if (!store || typeof store.readSheetState !== 'function') throw storeFailed('store_unwired')
  try {
    return await store.readSheetState(scope)
  } catch (error) {
    throw isTypedRefusal(error) ? error : storeFailed('read_sheet', error)
  }
}

// The idempotency key the writer will use for an ADD (the writer's `decisionKey`: the decision's key, else the
// record's key field), so the carry map covers exactly the keys the create leg looks up.
function decisionsForCarry(decisions, keyField) {
  const field = nonBlankString(keyField) ? keyField : 'idempotencyKey'
  const out = []
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!isPlainObject(decision)) continue
    if (decision.decision !== 'add') {
      out.push(decision)
      continue
    }
    const record = isPlainObject(decision.record) ? decision.record : {}
    const key = nonBlankString(decision.idempotencyKey)
      ? decision.idempotencyKey.trim()
      : (typeof record[field] === 'string' && record[field].trim() ? record[field].trim() : null)
    out.push(key ? { ...decision, idempotencyKey: key } : decision)
  }
  return out
}

function labelsOnSheetOf(existingRows) {
  const labels = new Set()
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    const label = rowPullBatchFacts(row).pullBatch.trim()
    if (label) labels.add(label)
  }
  return labels
}

function carryOf({ sheet, batches, decisions, existingRows, keyField }) {
  return buildFirstPullBatchByKey({
    decisions: decisionsForCarry(decisions, keyField),
    existingRows,
    ledgerBatches: batches,
    locale: sheet.labelLocale,
    config: { firstPullBatchRule: sheet.firstPullBatchRule, labelFormat: sheet.labelFormat },
  })
}

/**
 * Design §6.1 over one computation. `mode`: 'apply' (a write follows: a ledger failure rethrows its typed 503 and
 * `installing` is 409) or 'preview' (fail-soft: both become reasons). Answers null when the switch is off (no key, no
 * IO), `{ ready: false, reason, gapRows? }`, or `{ ready: true, sheet, batches, carry, labelsOnSheet, expectedRule }`.
 * C4 by construction: only plugin rows with a RUN stamp are evidence and gap rows (pure module).
 */
async function evaluatePullBatchStamping({ lane, probe, scope, existingRows, decisions, keyField, mode } = {}) {
  if (!lane || lane.enabled !== true) return null
  if (mode !== 'apply' && mode !== 'preview') throw stampInvalid('mode', 'the evaluation mode must be apply or preview')
  const bandReason = bandReasonOf(probe)
  if (bandReason) return Object.freeze({ ready: false, reason: bandReason })
  let state
  try {
    state = await readLedger(lane, scope)
  } catch (error) {
    if (mode === 'apply') throw error
    return Object.freeze({ ready: false, reason: 'ledger_unreadable' })
  }
  const ledgerReason = ledgerReasonOf(state.sheet)
  if (ledgerReason === 'installing') {
    if (mode === 'apply') throw installInProgress()
    return Object.freeze({ ready: false, reason: 'installing' })
  }
  if (ledgerReason) return Object.freeze({ ready: false, reason: ledgerReason })
  const gapRows = countPullBatchGapRows(existingRows)
  if (gapRows > 0) return Object.freeze({ ready: false, reason: 'history_gap', gapRows })
  return Object.freeze({
    ready: true,
    sheet: state.sheet,
    batches: state.batches,
    carry: decisions === undefined ? null : carryOf({ sheet: state.sheet, batches: state.batches, decisions, existingRows, keyField }),
    labelsOnSheet: labelsOnSheetOf(existingRows),
    expectedRule: state.sheet.firstPullBatchRule,
  })
}

/** The preview stanza (dry-run, large plan): ON only (P-2). */
function previewStanzaOf(evaluation) {
  if (!evaluation) return null
  if (evaluation.ready) return Object.freeze({ preview: true, wouldStamp: true, reason: null })
  return Object.freeze({
    preview: true,
    wouldStamp: false,
    reason: evaluation.reason,
    ...(Number.isSafeInteger(evaluation.gapRows) ? { gapRows: evaluation.gapRows } : {}),
  })
}

// ── execution refs (critic M6: validated before any IO) ──────────────────────────────────────────────────────────

function executionRefOf(prefix, id) {
  if (!nonBlankString(id)) throw stampInvalid('executionRef', 'the pull-batch link needs this run\'s id')
  const ref = `${prefix}:${id.trim()}`
  if (!EXECUTION_REF_PATTERN.test(ref)) throw stampInvalid('executionRef', 'this run\'s id cannot name a pull-batch link')
  return ref
}

// ── allocate / finish inside the host-write bracket (P-5; critic M7) ─────────────────────────────────────────────

// The holder assert in the ledger transaction takes the lease row FOR UPDATE; the guard's heartbeat must not queue
// behind its own holder's transaction (review round 6, N6): run inside the guard's host-write bracket when present.
function withHostWrite(writeFence, fn) {
  return writeFence && typeof writeFence.withHostWrite === 'function' ? writeFence.withHostWrite(fn) : fn()
}

function logWarn(logger, message, fields) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(message, fields)
  } catch {
    // logging never decides an outcome
  }
}

/**
 * finish() best effort (design §3.6): never the answer, never thrown. Values-free log on a refusal or a failure.
 */
async function finishBestEffort({ lane, scope, executionRef, writerStatus, createdRowCount, sourceDigest, writeFence, logger }) {
  try {
    const outcome = await withHostWrite(writeFence, () => lane.store.finish({
      ...scope,
      executionRef,
      writerStatus,
      createdRowCount,
      sourceDigest,
      holderWithin: lane.holderWithin || undefined,
    }))
    if (outcome && ['holder_refused', 'already_finished', 'no_link'].includes(outcome.outcome)) {
      logWarn(logger, 'stock-preparation pull-batch finish was a no-op', { outcome: outcome.outcome })
    }
    return outcome || null
  } catch (error) {
    logWarn(logger, 'stock-preparation pull-batch finish failed', { code: error && typeof error.code === 'string' ? error.code : 'unknown' })
    return null
  }
}

// ── the small lane (design §6.3; P-1 as conditioned by C12) ──────────────────────────────────────────────────────

/**
 * The small apply's pull-batch run, AFTER the in-lease recompute and its refusals and BEFORE `beginExecution` (P-1:
 * a pull-batch refusal never leaves a governed execution behind). Answers null (switch off / direct caller) or a run
 * object: `{ evaluation, stampFor(execution), finish(applyResult), finishFailed(), answer(applyResult) }`.
 * `stampFor` is called AFTER `const execution = …` exists (critic M9), so the allocation records the `exec_` id.
 */
async function prepareSmallApplyPullBatch({ lane, dryRun, action, parameters, runId, canonicalRows, writeFence, logger } = {}) {
  if (!lane || lane.enabled !== true) return null
  const scope = scopeOf(lane, { sheetId: action.target.sheetId, projectNo: parameters.projectNo })
  // Before any ledger IO (critic M6).
  const executionRef = executionRefOf('small', runId)
  const evaluation = await evaluatePullBatchStamping({
    lane,
    probe: dryRun.pullBatch,
    scope,
    existingRows: dryRun.existingRows,
    decisions: dryRun.plan && dryRun.plan.decisions,
    keyField: action.target.keyField,
    mode: 'apply',
  })
  if (!evaluation.ready) {
    return Object.freeze({
      evaluation,
      stampFor: () => undefined,
      finish: async () => null,
      finishFailed: async () => null,
      answer: () => Object.freeze({ stamped: false, reason: evaluation.reason, ...(Number.isSafeInteger(evaluation.gapRows) ? { gapRows: evaluation.gapRows } : {}) }),
    })
  }
  const sourceDigest = pullBatchSourceDigest({ actionId: action.actionId, rows: dryRun.expansion.rows, canonicalRows })
  const fieldIds = lane.band.fieldIds
  return Object.freeze({
    evaluation,
    stampFor(execution) {
      return {
        fieldIds,
        firstPullBatchByKey: evaluation.carry,
        allocate: () => lane.store.allocate({
          ...scope,
          executionRef,
          lane: 'small_apply',
          sourceDigest,
          labelsOnSheet: evaluation.labelsOnSheet,
          voidReuse: 'in_lease',
          expectedRule: evaluation.expectedRule,
          refreshExecutionId: execution && nonBlankString(execution.id) ? execution.id : null,
          holderWithin: lane.holderWithin || undefined,
        }),
      }
    },
    finish(applyResult) {
      const summary = applyResult && isPlainObject(applyResult.pullBatch) ? applyResult.pullBatch : null
      return finishBestEffort({
        lane,
        scope,
        executionRef,
        writerStatus: writerStatusOf(applyResult),
        createdRowCount: summary && Number.isSafeInteger(summary.stampedRowCount) ? summary.stampedRowCount : 0,
        sourceDigest,
        writeFence,
        logger,
      })
    },
    finishFailed() {
      return finishBestEffort({ lane, scope, executionRef, writerStatus: 'failed', createdRowCount: null, sourceDigest, writeFence, logger })
    },
    answer(applyResult) {
      const summary = applyResult && isPlainObject(applyResult.pullBatch) ? applyResult.pullBatch : null
      if (!summary || summary.allocated !== true) return Object.freeze({ stamped: false, reason: 'no_creates' })
      return Object.freeze({
        stamped: true,
        label: summary.label,
        batchNo: summary.batchNo,
        joined: summary.joined === true,
        createdRowCount: summary.stampedRowCount,
      })
    },
  })
}

// The writer's status in the ledger's closed vocabulary (`held` is a partial run: rows await a person).
function writerStatusOf(applyResult) {
  const status = applyResult && applyResult.status
  if (status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'aborted') return status
  return 'partial'
}

/** The dry-run's preview (P-2): ON only, after `mintable`; never touches the token, revision or `canApply`. */
async function previewSmallPullBatch({ lane, dryRun, action, parameters } = {}) {
  if (!lane || lane.enabled !== true) return null
  // critic M11: a project the source does not have answers no stanza (canApply is false; nothing would be written).
  if (!dryRun || (dryRun.expansion && dryRun.expansion.status === 'not_found')) return null
  const scope = scopeOf(lane, { sheetId: action.target.sheetId, projectNo: parameters.projectNo })
  const evaluation = await evaluatePullBatchStamping({
    lane,
    probe: dryRun.pullBatch,
    scope,
    existingRows: dryRun.existingRows,
    mode: 'preview',
  })
  return previewStanzaOf(evaluation)
}

// ── the large lane (design §6.4; P-3, P-4, P-12; critic M2) ──────────────────────────────────────────────────────

const PULL_BATCH_PLAN_DIGEST_PATTERN = /^[0-9a-f]{32}$/

function pullBatchPlanInvalid(field) {
  return stampInvalid(field, 'the pull-batch plan of this job is malformed')
}

/**
 * The job's stored `pullBatchPlan` (JSON; it lives in the job store beside the private full plan). Three states (P-3):
 *   absent                                     => null
 *   { ready: false, reason: 'history_gap', gapRows }  — chunks run UNSTAMPED (never REPLAN forever)
 *   { ready: true, firstPullBatchByKey: { key: label|null }, sourceDigest, labelsOnSheet: [...], expectedRule }
 * NO physical band id is stored (critic M2): the chunk gate derives the band and proves it with its own probe fold.
 */
function normalizeStoredPullBatchPlan(value) {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) throw pullBatchPlanInvalid('pullBatchPlan')
  if (value.ready === false) {
    if (value.reason !== 'history_gap' || !Number.isSafeInteger(value.gapRows) || value.gapRows < 1) throw pullBatchPlanInvalid('pullBatchPlan.reason')
    return { ready: false, reason: 'history_gap', gapRows: value.gapRows }
  }
  if (value.ready !== true) throw pullBatchPlanInvalid('pullBatchPlan.ready')
  if (typeof value.sourceDigest !== 'string' || !PULL_BATCH_PLAN_DIGEST_PATTERN.test(value.sourceDigest)) throw pullBatchPlanInvalid('pullBatchPlan.sourceDigest')
  if (!isPlainObject(value.firstPullBatchByKey)) throw pullBatchPlanInvalid('pullBatchPlan.firstPullBatchByKey')
  const carry = {}
  for (const [key, label] of Object.entries(value.firstPullBatchByKey)) {
    if (!nonBlankString(key) || !(label === null || nonBlankString(label))) throw pullBatchPlanInvalid('pullBatchPlan.firstPullBatchByKey')
    carry[key] = label
  }
  if (!Array.isArray(value.labelsOnSheet) || !value.labelsOnSheet.every((label) => typeof label === 'string')) throw pullBatchPlanInvalid('pullBatchPlan.labelsOnSheet')
  if (!nonBlankString(value.expectedRule)) throw pullBatchPlanInvalid('pullBatchPlan.expectedRule')
  return {
    ready: true,
    firstPullBatchByKey: carry,
    sourceDigest: value.sourceDigest,
    labelsOnSheet: [...value.labelsOnSheet],
    expectedRule: value.expectedRule,
  }
}

/**
 * The large PLAN route (§6.4): ONE preview evaluation over the Symbol-bearing reader rows of THIS request (LB clones
 * them and loses the Symbol). Answers null (switch off) or `{ preview, pullBatchPlanFor }`: `pullBatchPlanFor` is
 * handed to the large planner, which calls it AFTER the revision (never hashed) and before the job is touched. Fail-soft
 * (a preview): a ledger failure plans without a pull-batch plan; a chunk then decides.
 */
async function prepareLargePlanPullBatch({ lane, probe, sheetId, projectNo, existingRows, keyField, actionId, canonicalRows } = {}) {
  if (!lane || lane.enabled !== true) return null
  const scope = scopeOf(lane, { sheetId, projectNo })
  const evaluation = await evaluatePullBatchStamping({ lane, probe, scope, existingRows, mode: 'preview' })
  const preview = previewStanzaOf(evaluation)
  let pullBatchPlanFor
  if (evaluation.ready) {
    pullBatchPlanFor = ({ plan, artifactRows }) => {
      const carry = carryOf({ sheet: evaluation.sheet, batches: evaluation.batches, decisions: plan && plan.decisions, existingRows, keyField })
      return {
        ready: true,
        firstPullBatchByKey: Object.fromEntries(carry),
        sourceDigest: pullBatchSourceDigest({ actionId, rows: artifactRows, canonicalRows }),
        labelsOnSheet: [...evaluation.labelsOnSheet].sort(),
        expectedRule: evaluation.expectedRule,
      }
    }
  } else if (evaluation.reason === 'history_gap') {
    pullBatchPlanFor = () => ({ ready: false, reason: 'history_gap', gapRows: evaluation.gapRows })
  }
  return Object.freeze({ preview, pullBatchPlanFor })
}

/**
 * The large APPROVE route (P-4): before the binder's bump and before any checkpoint job exists. ON ∧ band db-proven
 * => ONE ledger read (503) => installing 409; resolved ∧ the expansion job has no `pullBatchPlan` key => 409
 * JOB_REPLAN_REQUIRED. Off / band unusable => nothing (the chunk decides).
 */
async function assertLargeApprovePullBatch({ lane, probe, sheetId, projectNo, expansionJob } = {}) {
  if (!lane || lane.enabled !== true) return
  if (bandReasonOf(probe)) return
  const scope = scopeOf(lane, { sheetId, projectNo })
  const state = await readLedger(lane, scope)
  const reason = ledgerReasonOf(state.sheet)
  if (reason === 'installing') throw installInProgress()
  if (reason === null && !(expansionJob && isPlainObject(expansionJob.pullBatchPlan))) throw replanRequired('planned_without_pull_batch')
}

/**
 * The large CHUNK gate (§6.4), INSIDE the lease and BEFORE the job turns `running` (LB calls it; a refusal leaves the
 * job untouched). Answers null (switch off), `{ stamp: null, reason }` (an unstamped chunk) or
 * `{ stamp, finish({ writerStatus, createdRowCount }) }`:
 *   switch off                                       => null
 *   band unusable (probe fold) and the job has a ready plan => 409 REPLAN (the band changed since the plan)
 *   band unusable otherwise                          => null
 *   ready plan whose stamp the writer would refuse   => 500 STAMP_INVALID before any IO (F-7: admittedChunkStamp)
 *   ONE ledger read (503) ; installing               => 409 INSTALL_IN_PROGRESS
 *   ready plan ∧ resolved                            => the stamp, keyed `large:<apply job id>` (every chunk, resume
 *                                                       and takeover reuses the one link)
 *   ready plan ∧ not resolved                        => 409 REPLAN (defensive)
 *   gap plan                                         => null (chunks run unstamped; the gap pass joins them)
 *   no plan ∧ resolved                               => 409 REPLAN (planned before the install)
 *   no plan otherwise                                => null
 * P-12: labels on the sheet and the gap check come from the PLAN read — safe because any lease taken after the
 * expansion moves the fencing epoch the approval pins, and every later preview bumps the generation the chunk compares.
 */
async function largeChunkPullBatchGate({ lane, probe, job, projectNo, writeFence, logger } = {}) {
  if (!lane || lane.enabled !== true) return null
  const stored = normalizeStoredPullBatchPlan(job && job.pullBatchPlan)
  const bandReason = bandReasonOf(probe)
  if (bandReason) {
    if (stored && stored.ready) throw replanRequired('band_unproven')
    return unstampedChunk(bandReason)
  }
  const sheetId = job && isPlainObject(job.target) ? job.target.sheetId : null
  const scope = scopeOf(lane, { sheetId, projectNo })
  const executionRef = executionRefOf('large', job && job.jobId)
  // F-7 (R-65): a ready plan's stamp is built — and checked with the WRITER'S OWN zero-IO checks — before the ledger
  // read and so before the job turns `running`. On main the writer refused a malformed stored plan only inside the
  // chunk, after `running` was stored: the job then answered 409 RUN_IN_PROGRESS forever.
  const stamp = stored && stored.ready ? admittedChunkStamp({ lane, job, stored, scope, executionRef }) : null
  const state = await readLedger(lane, scope)
  const reason = ledgerReasonOf(state.sheet)
  if (reason === 'installing') throw installInProgress()
  if (!stored) {
    if (reason === null) throw replanRequired('planned_before_install')
    return unstampedChunk(reason)
  }
  if (!stored.ready) return unstampedChunk(stored.reason, stored.gapRows)
  if (reason !== null) throw replanRequired('history_unresolved')
  return Object.freeze({
    stamp,
    finish({ writerStatus, createdRowCount } = {}) {
      return finishBestEffort({ lane, scope, executionRef, writerStatus, createdRowCount, sourceDigest: stored.sourceDigest, writeFence, logger })
    },
  })
}

/**
 * F-7 (R-65): the chunk's writer stamp, checked by the writer's own assertWriterAdmitsPullBatchStamp against the
 * job's STORED target (what the writer is handed: its fieldIdMap, its keyField) over every decision the job has
 * still to run — from the checkpoint on, a superset of this chunk's slice, so a stamp that would be refused by this
 * chunk or by any later one is refused NOW, with nothing written and the job untouched. Throws the writer's own
 * refusal, 500 STAMP_INVALID — the same code as a malformed stored plan above (the ADD-coverage refusal carries
 * `partial: false`; a stamp-shape refusal such as `fieldIds` carries its `field` only). Zero IO. A valid
 * plan's carry covers every ADD of the plan it was built from, so a valid stamp is admitted and returned unchanged.
 */
function admittedChunkStamp({ lane, job, stored, scope, executionRef }) {
  const labelsOnSheet = new Set(stored.labelsOnSheet)
  const stamp = {
    fieldIds: lane.band ? lane.band.fieldIds : null,
    firstPullBatchByKey: new Map(Object.entries(stored.firstPullBatchByKey)),
    allocate: () => lane.store.allocate({
      ...scope,
      executionRef,
      lane: 'large_apply',
      sourceDigest: stored.sourceDigest,
      labelsOnSheet,
      voidReuse: 'in_lease',
      expectedRule: stored.expectedRule,
      refreshExecutionId: null,
      holderWithin: lane.holderWithin || undefined,
    }),
  }
  const plan = job && isPlainObject(job.plan) && Array.isArray(job.plan.decisions) ? job.plan : null
  const next = plan && isPlainObject(job.checkpoint) ? job.checkpoint.nextDecisionIndex : 0
  const start = Number.isSafeInteger(next) && next >= 0 ? next : 0
  assertWriterAdmitsPullBatchStamp({
    pullBatchStamp: stamp,
    plan: plan ? { ...plan, decisions: plan.decisions.slice(start) } : plan,
    target: job ? job.target : undefined,
  })
  return stamp
}

function unstampedChunk(reason, gapRows) {
  return Object.freeze({ stamp: null, reason, ...(Number.isSafeInteger(gapRows) ? { gapRows } : {}) })
}

/**
 * The job's values-free `pullBatchRun` after one chunk (a conditional job key, ON only; never in a public projection):
 * `{ allocated: true, batchNo, label, joined }` once a chunk of the job allocated, else `{ allocated: false, reason,
 * gapRows? }` of the latest gate. An allocation is never forgotten by a later chunk.
 */
function mergeLargePullBatchRun(previous, gateRun, applyResult) {
  if (!gateRun) return previous
  const before = isPlainObject(previous) ? previous : null
  const summary = applyResult && isPlainObject(applyResult.pullBatch) ? applyResult.pullBatch : null
  if (gateRun.stamp && summary && summary.allocated === true) {
    return { allocated: true, batchNo: summary.batchNo, label: summary.label, joined: summary.joined === true }
  }
  if (before && before.allocated === true) return before
  if (gateRun.stamp) return { allocated: false, reason: 'no_creates' }
  return { allocated: false, reason: gateRun.reason, ...(Number.isSafeInteger(gateRun.gapRows) ? { gapRows: gateRun.gapRows } : {}) }
}

/** A route answer with the ON-only stanza added (absent stanza => the payload itself, byte-identical). */
function withPullBatchStanza(payload, stanza) {
  return stanza ? { ...payload, pullBatch: stanza } : payload
}

/** The chunk answer's stanza (ON only): the job's running total, values-free. */
function largeChunkAnswerOf(lane, job) {
  if (!lane || lane.enabled !== true) return null
  const summary = job && isPlainObject(job.pullBatchRun) ? job.pullBatchRun : null
  if (!summary) return null
  if (summary.allocated !== true) return Object.freeze({ stamped: false, reason: summary.reason, ...(Number.isSafeInteger(summary.gapRows) ? { gapRows: summary.gapRows } : {}) })
  return Object.freeze({
    stamped: true,
    label: summary.label,
    batchNo: summary.batchNo,
    joined: summary.joined === true,
    createdRowCount: Number.isSafeInteger(job.pullBatchStampedRowCount) ? job.pullBatchStampedRowCount : 0,
  })
}

module.exports = {
  PULL_BATCH_PREVIEW_REASONS,
  PULL_BATCH_PROBE_FIELD_IDS,
  STOCK_PREP_PULL_BATCH_ENABLED_ENV,
  assertLargeApprovePullBatch,
  derivePullBatchBand,
  evaluatePullBatchStamping,
  largeChunkAnswerOf,
  largeChunkPullBatchGate,
  mergeLargePullBatchRun,
  normalizePullBatchLaneInput,
  normalizeStoredPullBatchPlan,
  prepareLargePlanPullBatch,
  prepareSmallApplyPullBatch,
  previewSmallPullBatch,
  pullBatchProbeOptions,
  pullBatchProbeStanza,
  readerBandOf,
  readerOnlyLaneOf,
  stockPrepPullBatchEnabled,
  withPullBatchStanza,
  __internals: {
    bandReasonOf,
    decisionsForCarry,
    executionRefOf,
    labelsOnSheetOf,
    ledgerReasonOf,
    previewStanzaOf,
    writerStatusOf,
  },
}
