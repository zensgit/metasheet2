'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 6a-2 (S6-2; register row R-91) — THE RECOVERY ASSESSMENT of an unfinished execution, and the
// route-side pieces around it (the executions list, the bodies, the audit entries).
//
// Design: step-6 design §3.5 (the recovery operation), §3.5.1 (the classifier), §3.5.2 (the report and the digest), §3.7
// (plan-bound mapping), §3.8 (close-unverified), §5.1 (the executions list), as amended by the 2026-11-09 rebaseline
// (items S6-2 (a)-(j), N-SWITCH, N-INSTALLING).
//
// WHAT IS HERE (pure unless stated):
//   assessExecutionRecovery   the classification of THIS execution's intent journal against the sheet rows the recovery
//                             read under its lease (lib/stock-preparation-execution-intent.cjs classifyExecutionIntent),
//                             plus the facts the classifier cannot see: a missing / corrupt journal, a landed ADD the
//                             in-lease recompute still plans (`recompute_disagrees`, a defect detector), the bound change
//                             plan's write records (each from its UPDATE entry, or from the plan's own record set when it
//                             has none), and 批次标识's link (`verifiedCreatedRows`: the landed ADD rows that carry the
//                             link's 本次拉取 label — counted from the SHEET, never accumulated).
//   verifyDigestOf / inspectDigestOf   what a close echoes: the FULL classification (never one page of it).
//   recoveryReportOf          the values-free report (counts, tokens, booleans, one ordinal); 批次标识's `batch` stanza
//                             exists only while the switch is on (N-SWITCH: absent, not null, when it is off).
//   pendingPageOf             ONE page (200) of the PRIVATE pending list: the entries that did not provably land, joined
//                             by key digest to the recompute's source rows (component code / name) — served only by the
//                             audited verify, after its audit row.
//   listExecutionsRead        the audited executions list (route-side, IO through the context it is handed).
//   normalize*Body            the closed bodies of the two POST routes.
//   recoveryCloseAuditEntryOf the values-free audit entry of a close (depth-1 tokens and numeric count maps only — the
//                             audit store's own gate, stock-preparation-audit-store.cjs assertValuesFreeDetail).
//
// VALUES-FREE everywhere except the pending page: digests, record-id handles, integers, closed tokens.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const {
  REFRESH_STORE_ERROR_CODES,
  StockPreparationRefreshStoreError,
  UNFINISHED_EXECUTION_STATUSES,
  __internals: { writeRecordIdsOf },
} = require('./stock-preparation-continuation-store.cjs')
const { classifyExecutionIntent, intentKeyDigest, bandDigest } = require('./stock-preparation-execution-intent.cjs')
const { DECISIONS, EXISTING_ROW_RECORD_REF } = require('./stock-preparation-conflict-planner.cjs')
const { EXISTING_ROW_PULL_BATCH } = require('./stock-preparation-pull-batch.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, normalizeStockPreparationTemplate } = require('./stock-preparation-templates.cjs')
const pairing = require('./stock-preparation-continuation-pairing.cjs')
const { REFRESH_DECISION_AUDIT, REFRESH_DECISION_ERROR_CODES, StockPreparationRefreshDecisionError } = require('./stock-preparation-refresh-decisions.cjs')
const { __internals: { liveLeaseIdOf } } = require('./stock-preparation-refresh-lanes.cjs')

const { canonicalChangeValue } = pairing
const { canonicalJson } = pairing.__internals

const RECOVERY_SCHEMES = Object.freeze({
  verify: 'stock-preparation/recovery-verify/v2',
  inspect: 'stock-preparation/recovery-inspect/v1',
  rows: 'stock-preparation/recovery-rows/v1',
})
const PENDING_PAGE_SIZE = 200
const RECOVER_MODES = Object.freeze(['verify', 'close'])
const CLOSE_UNVERIFIED_MODES = Object.freeze(['inspect', 'close'])
// Design §3.5.1 + the facts raised outside the classifier; `pull_batch_moved` (rebaseline C-3): the link's batch digest
// is not the execution's own (a defect, never closed by a puller).
const RECOVERY_REFUSAL_REASONS = Object.freeze(['intent_missing', 'intent_corrupt', 'recompute_disagrees', 'duplicate_rows', 'record_vanished', 'record_replaced', 'diverged', 'pull_batch_moved'])
const RUNBOOK_REF_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const DIGEST64_PATTERN = /^[0-9a-f]{64}$/
const KIND_OF = Object.freeze({ a: 'add', u: 'update', x: 'inactive' })
const COUNT_KEYS = Object.freeze(['intended', 'landed', 'notLanded', 'diverged', 'duplicate', 'vanished', 'replaced'])
const UNPROVABLE_REASON_OF_CLASS = Object.freeze({ duplicate: 'duplicate_rows', vanished: 'record_vanished', replaced: 'record_replaced', diverged: 'diverged' })

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function recordIdOf(row) {
  const ref = row && row[EXISTING_ROW_RECORD_REF]
  return ref && typeof ref.id === 'string' ? ref.id : null
}

function zeroCounts() {
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]))
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

function storeError(status, code, message, details) {
  return new StockPreparationRefreshStoreError(status, code, message, { ...details, partial: false })
}

function requestInvalid(field, message = `${field} is invalid`) {
  return new StockPreparationRefreshDecisionError(400, REFRESH_DECISION_ERROR_CODES.REQUEST_INVALID, message, { field })
}

function rowsByKeyDigest(rows) {
  const byKey = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = isPlainObject(row) && typeof row.idempotencyKey === 'string' ? row.idempotencyKey.trim() : ''
    if (!key) continue
    const digest = intentKeyDigest(key)
    if (!byKey.has(digest)) byKey.set(digest, [])
    byKey.get(digest).push(row)
  }
  return byKey
}

// The plan-bound mapping (design §3.5 step 4e): one class per WRITE record of the confirmed plan — from its UPDATE /
// INACTIVE entry (`r === recordId`), else from the plan's own record set compared with the row the recompute read
// (`landed`: every write field equals its canonical after; `not_landed`: every one equals its canonical before; a row
// that is gone `vanished`; anything else `diverged`) — the comparison a review makes (currentContentDigestOf).
function changePlanRecordClasses({ changePlan, entryClassByRecordId, rows, templateFields }) {
  const rowsByRecordId = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = recordIdOf(row)
    if (id) rowsByRecordId.set(id, row)
  }
  const classes = new Map()
  for (const record of Array.isArray(changePlan.recordSet) ? changePlan.recordSet : []) {
    if (!isPlainObject(record) || !nonBlankString(record.recordId) || !isPlainObject(record.fields)) continue
    const writeFields = Object.entries(record.fields).filter(([, cell]) => isPlainObject(cell) && cell.reviewOnly !== true)
    if (writeFields.length === 0) continue
    if (entryClassByRecordId.has(record.recordId)) {
      classes.set(record.recordId, entryClassByRecordId.get(record.recordId))
      continue
    }
    const row = rowsByRecordId.get(record.recordId)
    if (!row) {
      classes.set(record.recordId, 'vanished')
      continue
    }
    const now = (fieldId) => canonicalChangeValue(row[fieldId], templateFields.get(fieldId))
    const same = (left, right) => canonicalJson(left === undefined ? null : left) === canonicalJson(right === undefined ? null : right)
    if (writeFields.every(([fieldId, cell]) => same(now(fieldId), cell.afterCanonical))) classes.set(record.recordId, 'landed')
    else if (writeFields.every(([fieldId, cell]) => same(now(fieldId), canonicalChangeValue(cell.before, templateFields.get(fieldId))))) classes.set(record.recordId, 'not_landed')
    else classes.set(record.recordId, 'diverged')
  }
  return classes
}

/**
 * THE ASSESSMENT (design §3.5 steps 4c-4e). Inputs, all server-held:
 *   read       the store's readExecutionForRecovery answer (execution, intent, intentState, changePlan, writtenPlans)
 *   rows       the sheet rows read under the recovery lease (the recompute's own `existingRows`, or the sheet-only read of
 *              close-unverified) — logical rows with the reader's record refs and 批次标识's Symbol
 *   plan       the in-lease recompute's plan (null for close-unverified: no source read)
 *   link       批次标识's readBatchLink answer, or null while the switch is off
 *   template   the action template (the band's canonical forms)
 * Answers a frozen, values-free object (record-id handles, key digests, integers, tokens).
 */
function assessExecutionRecovery({ read, rows, plan = null, link = null, template } = {}) {
  if (!isPlainObject(read) || !isPlainObject(read.execution)) throw storeError(500, REFRESH_STORE_ERROR_CODES.INPUT_INVALID, 'the recovery assessment needs the execution read', { field: 'read' })
  const normalized = normalizeStockPreparationTemplate(template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const templateFields = new Map(normalized.fields.map((field) => [field.id, field]))
  const reasons = new Set()
  const chunks = read.intentState === 'ok' && read.intent ? read.intent.chunks : []
  if (read.intentState === 'missing') reasons.add('intent_missing')
  else if (read.intentState !== 'ok') reasons.add('intent_corrupt')
  const classification = classifyExecutionIntent({ chunks, rows, template: normalized })
  for (const reason of classification.reasons) reasons.add(reason)
  const entryOf = new Map()
  for (const chunk of chunks) for (const entry of chunk.entries) entryOf.set(entry.i, { entry, fields: chunk.fieldsets[entry.f] })
  const classes = classification.classes.map((item) => Object.freeze({ i: item.i, d: item.d, k: entryOf.get(item.i).entry.k, r: entryOf.get(item.i).entry.r, cls: item.cls }))
  // (d) the recompute must not plan again a key whose ADD landed (key-digest equality) — a defect detector.
  if (plan && Array.isArray(plan.decisions)) {
    const addKeys = new Set()
    for (const decision of plan.decisions) {
      const key = decision && decision.decision === DECISIONS.ADD && typeof decision.idempotencyKey === 'string' ? decision.idempotencyKey.trim() : ''
      if (key) addKeys.add(intentKeyDigest(key))
    }
    if (classes.some((item) => item.d === 'a' && item.cls === 'landed' && addKeys.has(item.k))) reasons.add('recompute_disagrees')
  }
  // (e) the bound change plan's write records.
  let changePlan = null
  let landedRecordIds = []
  let possiblyLandedRecordIds = []
  if (read.changePlanBound === true) {
    if (!read.changePlan) {
      changePlan = { bound: true, planStatusSeen: 'absent', landedRecords: 0, notLandedRecords: 0, possiblyLandedRecords: 0, writtenPlanPending: (read.writtenPlans || []).length > 0 }
    } else {
      const entryClassByRecordId = new Map()
      for (const item of classes) if (item.d !== 'a' && item.r !== null) entryClassByRecordId.set(item.r, item.cls)
      const recordClasses = changePlanRecordClasses({ changePlan: read.changePlan, entryClassByRecordId, rows, templateFields })
      const landed = []
      const notLanded = []
      const possibly = []
      for (const [recordId, cls] of recordClasses) {
        if (cls === 'landed') landed.push(recordId)
        else if (cls === 'not_landed') notLanded.push(recordId)
        else {
          possibly.push(recordId)
          reasons.add(UNPROVABLE_REASON_OF_CLASS[cls] || 'diverged')
        }
      }
      landedRecordIds = landed.sort()
      possiblyLandedRecordIds = possibly.sort()
      changePlan = {
        bound: true,
        planStatusSeen: read.changePlan.status,
        landedRecords: landed.length,
        notLandedRecords: notLanded.length,
        possiblyLandedRecords: possibly.length,
        writtenPlanPending: (read.writtenPlans || []).length > 0,
      }
    }
  }
  // 批次标识 (rebaseline C-3): a linked batch carries the execution's own digest, else the link is not this run's.
  if (link && link.linked === true && (link.sourceDigest || null) !== (read.execution.pullBatchSourceDigest || null)) reasons.add('pull_batch_moved')
  const byKey = rowsByKeyDigest(rows)
  const landedAdds = classes.filter((item) => item.d === 'a' && item.cls === 'landed')
  const label = link && link.linked === true && nonBlankString(link.label) ? link.label : null
  const verifiedCreatedRows = label
    ? landedAdds.filter((item) => {
      const matched = byKey.get(item.k) || []
      const band = matched.length === 1 && isPlainObject(matched[0][EXISTING_ROW_PULL_BATCH]) ? matched[0][EXISTING_ROW_PULL_BATCH] : null
      return Boolean(band) && band.pullBatch === label
    }).length
    : 0
  // The rows the classification was made over: [key digest, record id, band digest] of every intended key's row(s).
  const rowTuples = []
  for (const item of classes) {
    const at = entryOf.get(item.i)
    const matched = byKey.get(item.k) || []
    if (matched.length === 0) rowTuples.push([item.k, null, null])
    for (const row of matched) rowTuples.push([item.k, recordIdOf(row), bandDigest(row, at.fields, templateFields)])
  }
  rowTuples.sort((left, right) => (canonicalJson(left) < canonicalJson(right) ? -1 : (canonicalJson(left) > canonicalJson(right) ? 1 : 0)))
  const rowsDigest = sha256(canonicalJson({ scheme: RECOVERY_SCHEMES.rows, rows: rowTuples }))
  const byKind = {}
  for (const kind of Object.values(KIND_OF)) byKind[kind] = zeroCounts()
  for (const item of classes) {
    const bucket = byKind[KIND_OF[item.d]]
    bucket.intended += 1
    bucket[item.cls === 'not_landed' ? 'notLanded' : item.cls] += 1
  }
  const refusalReasons = RECOVERY_REFUSAL_REASONS.filter((reason) => reasons.has(reason))
  return deepFreeze({
    result: refusalReasons.length > 0 ? 'unprovable' : classification.result,
    classifierResult: classification.result,
    refusalReasons,
    counts: { ...zeroCounts(), ...classification.counts },
    byKind,
    classes,
    landedRecordIds,
    possiblyLandedRecordIds,
    landedAddCount: landedAdds.length,
    verifiedCreatedRows,
    rowsDigest,
    changePlan,
    pendingTotal: classes.filter((item) => item.cls !== 'landed').length,
  })
}

/** The close's echo (design §3.5.2): binds the FULL classification. */
function verifyDigestOf({ executionId, intentDigest, assessment }) {
  return sha256(canonicalJson({
    scheme: RECOVERY_SCHEMES.verify,
    executionId,
    intentDigest: intentDigest || null,
    result: assessment.result,
    counts: assessment.counts,
    landedRecordIds: assessment.landedRecordIds,
    possiblyLandedRecordIds: assessment.possiblyLandedRecordIds,
    landedAddCount: assessment.landedAddCount,
    verifiedCreatedRows: assessment.verifiedCreatedRows,
    rowsDigest: assessment.rowsDigest,
  }))
}

/** close-unverified's echo (design §3.8 step 6): the sheet-only classification, never a source fact. */
function inspectDigestOf({ executionId, intentDigest, assessment }) {
  return sha256(canonicalJson({
    scheme: RECOVERY_SCHEMES.inspect,
    executionId,
    intentDigest: intentDigest || null,
    counts: assessment.counts,
    refusalReasons: assessment.refusalReasons,
    verifiedCreatedRows: assessment.verifiedCreatedRows,
    rowsDigest: assessment.rowsDigest,
  }))
}

function pageCountOf(total) {
  return Math.ceil(total / PENDING_PAGE_SIZE)
}

/**
 * The values-free REPORT (design §3.5.2). `plan` null => `remaining` null (close-unverified reads no source). `bandOn`:
 * the 批次标识 switch for this request — off => no `batch` key at all (N-SWITCH).
 */
function recoveryReportOf({ read, assessment, plan = null, bandOn = false, link = null, settlesIfClosedNow = false, digestKey = 'verifyDigest', digest }) {
  const counts = plan && isPlainObject(plan.counts) ? plan.counts : null
  const remaining = counts
    ? {
      add: Number(counts[DECISIONS.ADD] || 0),
      update: Number(counts[DECISIONS.UPDATE] || 0),
      inactive: Number(counts[DECISIONS.INACTIVE] || 0),
      manualConfirm: Number(counts[DECISIONS.MANUAL_CONFIRM] || 0),
      suspended: plan.suspended === true,
      holdCount: Array.isArray(plan.holds) ? plan.holds.length : 0,
    }
    : null
  return deepFreeze({
    executionId: read.execution.id,
    preStatus: read.execution.status,
    result: assessment.result,
    counts: { ...assessment.counts },
    byKind: JSON.parse(JSON.stringify(assessment.byKind)),
    refusalReasons: assessment.refusalReasons.slice(),
    closeAdmissible: assessment.refusalReasons.length === 0,
    remaining,
    settlesIfClosedNow: settlesIfClosedNow === true,
    changePlan: assessment.changePlan ? { ...assessment.changePlan } : null,
    ...(bandOn ? {
      batch: {
        linked: Boolean(link && link.linked === true),
        batchNo: link && link.linked === true && Number.isSafeInteger(link.batchNo) ? link.batchNo : null,
        statusSeen: link && link.linked === true && nonBlankString(link.status) ? link.status : null,
        verifiedCreatedRows: assessment.verifiedCreatedRows,
      },
    } : {}),
    pending: { total: assessment.pendingTotal, pageCount: pageCountOf(assessment.pendingTotal) },
    [digestKey]: digest,
  })
}

/**
 * ONE page of the PRIVATE pending list (design §3.5, U04): the entries that did not provably land, by decision index,
 * PENDING_PAGE_SIZE per page; `cursor` = the last decision index of the previous page (an integer, values-free). Each entry
 * is joined by key digest to the recompute's source rows (component code / name — PRIVATE values: the caller audits the
 * page before it answers); a key no longer in the source reads `sourceGone: true` with the sheet row's own names.
 */
function pendingPageOf({ assessment, expansionRows = [], existingRows = [], cursor = null }) {
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw requestInvalid('pageCursor', 'pageCursor must be a decision index')
  const pending = assessment.classes.filter((item) => item.cls !== 'landed').slice().sort((left, right) => left.i - right.i)
  const startIndex = cursor === null ? 0 : pending.findIndex((item) => item.i > cursor)
  const start = startIndex < 0 ? pending.length : startIndex
  const slice = pending.slice(start, start + PENDING_PAGE_SIZE)
  const source = rowsByKeyDigest(expansionRows)
  const sheet = rowsByKeyDigest(existingRows)
  const textOf = (value) => (value === undefined || value === null ? null : String(value))
  const entries = slice.map((item) => {
    const fromSource = (source.get(item.k) || [])[0] || null
    const fromSheet = (sheet.get(item.k) || [])[0] || null
    const named = fromSource || fromSheet
    return Object.freeze({
      decisionIndex: item.i,
      kind: KIND_OF[item.d],
      class: item.cls,
      componentCode: named ? textOf(named.componentCode) : null,
      componentName: named ? textOf(named.componentName) : null,
      sourceGone: !fromSource,
    })
  })
  const last = slice.length > 0 ? slice[slice.length - 1].i : null
  return Object.freeze({
    pageIndex: Math.floor(start / PENDING_PAGE_SIZE),
    entries: Object.freeze(entries),
    nextCursor: start + slice.length < pending.length ? last : null,
  })
}

// ── the bodies (allow-listed by the route first) ──────────────────────────────────────────────────

function normalizeRecoverBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  if (!RECOVER_MODES.includes(body.mode)) throw requestInvalid('mode', 'mode must be verify or close')
  const verifyDigest = body.verifyDigest === undefined || body.verifyDigest === null ? null : body.verifyDigest
  if (body.mode === 'close' && (typeof verifyDigest !== 'string' || !DIGEST64_PATTERN.test(verifyDigest))) throw requestInvalid('verifyDigest', 'a close echoes the verifyDigest it was shown')
  if (body.mode === 'verify' && verifyDigest !== null) throw requestInvalid('verifyDigest', 'verifyDigest belongs to a close')
  const pageCursor = body.pageCursor === undefined || body.pageCursor === null ? null : body.pageCursor
  if (pageCursor !== null && (body.mode !== 'verify' || !Number.isSafeInteger(pageCursor) || pageCursor < 0)) throw requestInvalid('pageCursor', 'pageCursor is a decision index of a verify page')
  return Object.freeze({ mode: body.mode, verifyDigest, pageCursor })
}

function normalizeCloseUnverifiedBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  if (!CLOSE_UNVERIFIED_MODES.includes(body.mode)) throw requestInvalid('mode', 'mode must be inspect or close')
  if (body.mode === 'inspect') {
    for (const field of ['inspectDigest', 'runbookRef', 'acknowledge']) {
      if (body[field] !== undefined && body[field] !== null) throw requestInvalid(field, `${field} belongs to a close`)
    }
    return Object.freeze({ mode: 'inspect', inspectDigest: null, runbookRef: null })
  }
  if (typeof body.inspectDigest !== 'string' || !DIGEST64_PATTERN.test(body.inspectDigest)) throw requestInvalid('inspectDigest', 'a close echoes the inspectDigest it was shown')
  if (typeof body.runbookRef !== 'string' || !RUNBOOK_REF_PATTERN.test(body.runbookRef)) throw requestInvalid('runbookRef', 'runbookRef must be a values-free ticket handle')
  const ack = body.acknowledge
  if (!isPlainObject(ack) || ack.resultUnknown !== true || Object.keys(ack).length !== 1) throw requestInvalid('acknowledge', 'a close without verification acknowledges resultUnknown')
  return Object.freeze({ mode: 'close', inspectDigest: body.inspectDigest, runbookRef: body.runbookRef })
}

// ── the audit entries (D9: existing actions, closed `mode` subtypes) ──────────────────────────────

const RECOVERY_CLOSE_AUDIT_MODES = Object.freeze({
  execution_verified_closed: REFRESH_DECISION_AUDIT.modes.executionVerifiedClosed,
  execution_closed_unverified: REFRESH_DECISION_AUDIT.modes.executionClosedUnverified,
})

/** The close's audit entry: subject = the execution id; detail = depth-1 tokens, booleans, integers and numeric maps. */
function recoveryCloseAuditEntryOf(event) {
  const mode = event && Object.prototype.hasOwnProperty.call(RECOVERY_CLOSE_AUDIT_MODES, event.operation) ? RECOVERY_CLOSE_AUDIT_MODES[event.operation] : null
  if (!mode) throw storeError(500, REFRESH_STORE_ERROR_CODES.INPUT_INVALID, 'the recovery close handed an audit event outside its closed map', { reason: 'audit_event_unknown' })
  const counts = {}
  for (const key of COUNT_KEYS) counts[key] = Number.isSafeInteger(event.counts && event.counts[key]) ? event.counts[key] : 0
  return {
    action: REFRESH_DECISION_AUDIT.decisionAction,
    subjectId: event.executionId,
    mode,
    detail: {
      operation: event.operation,
      result: event.result,
      preStatus: event.preStatus,
      counts,
      changePlanOutcome: event.changePlanOutcome,
      recoveredRecordCount: Number.isSafeInteger(event.recoveredRecordCount) ? event.recoveredRecordCount : 0,
      ...(typeof event.batchOutcome === 'string' ? { batchOutcome: event.batchOutcome } : {}),
      transparent: event.transparent === true,
      settled: event.settled === true,
      continuationsConsumed: Number.isSafeInteger(event.continuationsConsumed) ? event.continuationsConsumed : 0,
    },
  }
}

// ── GET …/refresh/executions (design §5.1) ────────────────────────────────────────────────────────

const LIST_QUERY_LIMIT_MAX = 20

function boundedListLimit(value) {
  if (value === undefined || value === null || value === '') return LIST_QUERY_LIMIT_MAX
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > LIST_QUERY_LIMIT_MAX) throw requestInvalid('limit', `limit must be an integer 1..${LIST_QUERY_LIMIT_MAX}`)
  return n
}

/**
 * The audited executions list. `ctx` is the route's decision context (scope, actor, consult, store, audit); `batchLinkOf`
 * is 批次标识's readBatchLink, handed ONLY while the switch is on (off => no `batch` key on any item, zero ledger IO).
 * `recoverable` = unfinished and not `running` under the LIVE lease the consult saw. No principal ids (the 10-21 lesson).
 * The audit row (project_board_read / execution_list_read, counts only) is appended BEFORE the answer.
 */
async function listExecutionsRead(ctx, query = {}, { batchLinkOf = null } = {}) {
  if (!ctx || !ctx.store || typeof ctx.store.listExecutions !== 'function') {
    throw new StockPreparationRefreshDecisionError(501, REFRESH_DECISION_ERROR_CODES.STORE_UNAVAILABLE, 'the continuation store cannot list executions here', { reason: 'recovery_store' })
  }
  if (!ctx.audit || typeof ctx.audit.append !== 'function') {
    throw new StockPreparationRefreshDecisionError(501, 'AUDIT_STORE_UNAVAILABLE', 'stock-preparation audit store is not available; nothing is listed without an audit trail')
  }
  const limit = boundedListLimit(query.limit)
  const cursor = query.cursor === undefined || query.cursor === null || query.cursor === '' ? null : String(query.cursor)
  const listed = await ctx.store.listExecutions({ ...ctx.scope, limit, cursor })
  const liveLeaseId = liveLeaseIdOf(ctx.consult)
  const items = []
  for (const execution of listed.items) {
    const binding = isPlainObject(execution.refreshBinding) ? execution.refreshBinding : {}
    const unfinished = UNFINISHED_EXECUTION_STATUSES.includes(execution.status)
    const item = {
      id: execution.id,
      status: execution.status,
      verifiedResult: execution.verifiedResult,
      closedMode: execution.closedMode,
      preCloseStatus: execution.preCloseStatus,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      verifiedAt: execution.verifiedAt,
      plannedCounts: execution.plannedCounts,
      counts: execution.counts,
      written: execution.written,
      attemptedWrites: execution.attemptedWrites,
      abortCode: execution.abortCode,
      errorCodes: execution.errorCodes,
      binding: { continuationCount: Array.isArray(binding.continuations) ? binding.continuations.length : 0, changePlanBound: execution.changePlanBound === true },
      settlementSubject: execution.settlementSubject !== false,
      recoverable: unfinished && !(execution.status === 'running' && liveLeaseId !== null && execution.leaseId === liveLeaseId),
    }
    if (typeof batchLinkOf === 'function') {
      const link = await batchLinkOf(execution.id)
      item.batch = link && link.linked === true ? { batchNo: link.batchNo, label: link.label, status: link.status } : null
    }
    items.push(Object.freeze(item))
  }
  await ctx.audit.append({
    tenantId: ctx.scope.tenantId,
    action: REFRESH_DECISION_AUDIT.readAction,
    actor: ctx.actorId,
    mode: REFRESH_DECISION_AUDIT.modes.executionListRead,
    detail: {
      operation: 'execution_list_read',
      itemCount: items.length,
      total: listed.total,
      recoverableCount: items.filter((item) => item.recoverable).length,
      tenantClaimVerified: ctx.tenantClaimVerified === true,
    },
  })
  return Object.freeze({ items: Object.freeze(items), nextCursor: listed.nextCursor, total: listed.total })
}

module.exports = {
  PENDING_PAGE_SIZE,
  RECOVERY_SCHEMES,
  RECOVERY_REFUSAL_REASONS,
  RECOVER_MODES,
  CLOSE_UNVERIFIED_MODES,
  assessExecutionRecovery,
  inspectDigestOf,
  listExecutionsRead,
  normalizeCloseUnverifiedBody,
  normalizeRecoverBody,
  pendingPageOf,
  recoveryCloseAuditEntryOf,
  recoveryReportOf,
  verifyDigestOf,
  __internals: {
    changePlanRecordClasses,
    rowsByKeyDigest,
    writeRecordIdsOf,
  },
}
