'use strict'

// Batch-refresh step 6d-1b (S6-5; step-6 design §6.5 as rebaselined 2026-11-09; register R-91) — the PURE half of the
// census routes and the remnant acknowledgement: the closed request bodies, the answers, the audit entries and the one
// remnant re-proof. The route layer (http-routes.cjs) does the IO: the registry, the walled project-scoped read with the
// server-held band, the strict pack read, the governance read and the component ruling store (migration 107).
//
//   GET  project-targets/census                               per registry row: the census counts (publicCensusOf), the
//                                                             governed token and the acknowledgement counts; objectId is
//                                                             in this PRIVATE admin answer, no component handle is
//   GET  projects/:projectNo/target/census                    one project: the counts plus its D2 components by their
//                                                             private handle, each with its active acknowledgement
//   POST projects/:projectNo/target/remnant-acknowledgements  record one (re-proved on a fresh read first)
//   POST …/remnant-acknowledgements/:acknowledgementId/revoke  revoke one
//
// VALUES-FREE AUDIT. The census reads append `project_board_read` (086) mode `sheet_census_read` with counts only; the
// acknowledgement writes append `exception_resolve` (066) modes `remnant_acknowledged` / `remnant_acknowledgement_revoked`
// with the ruling id, closed tokens and the runbook handle — never a component handle (a brute-forceable digest of
// business values, RD G4), never a project number, never a principal in `detail`.
//
// WHO RECORDS. The code enforces stock-prep:admin, the typed project number, the re-proof and a runbookRef; WHEN an
// acknowledgement is recorded on site is the owner's: only on the customer's Q1 answer relayed by the owner (O6-5).

const path = require('node:path')

const { SHEET_CENSUS_SCHEME, SHEET_CENSUS_COUNT_KEYS, censusOfRows, publicCensusOf } = require(path.join(__dirname, 'stock-preparation-sheet-census.cjs'))
const { derivePackAwarePlmWritableFields } = require(path.join(__dirname, 'stock-preparation-conflict-planner.cjs'))
const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require(path.join(__dirname, 'stock-preparation-templates.cjs'))
const {
  COMPONENT_DIGEST_PATTERN,
  REMNANT_ACKNOWLEDGEMENT_BASES,
  RUNBOOK_REF_PATTERN,
  RULING_ID_PATTERN,
} = require(path.join(__dirname, 'stock-preparation-component-ruling-store.cjs'))

const SHEET_CENSUS_AUDIT = Object.freeze({
  readAction: 'project_board_read',
  readMigration: '086',
  decisionAction: 'exception_resolve',
  decisionMigration: '066',
  modes: Object.freeze({
    censusRead: 'sheet_census_read',
    acknowledged: 'remnant_acknowledged',
    revoked: 'remnant_acknowledgement_revoked',
  }),
})

const CENSUS_PAGE_LIMIT_DEFAULT = 10
const CENSUS_PAGE_LIMIT_MAX = 10

const REMNANT_ACKNOWLEDGEMENT_ERROR_CODES = Object.freeze({
  REQUEST_INVALID: 'STOCK_PREP_SHEET_CENSUS_REQUEST_INVALID',
  NOT_PRESENT: 'STOCK_PREP_REMNANT_NOT_PRESENT',
  PACK_UNREADABLE: 'STOCK_PREP_SHEET_CENSUS_PACK_UNREADABLE',
  // S6-5b: the single-project census on a sheet that lost a key column (409), or whose key columns the database could
  // not be asked about (503). The tenant-wide row answers incomplete / field_missing (resp. rows_unreadable) instead.
  FIELD_MISSING: 'STOCK_PREP_SHEET_CENSUS_FIELD_MISSING',
  FIELDS_UNREADABLE: 'STOCK_PREP_SHEET_CENSUS_FIELDS_UNREADABLE',
})

// Why ONE row of the tenant-wide census has no counts (closed; the R-line pack's `status=incomplete reason=` twin).
const CENSUS_INCOMPLETE_REASONS = Object.freeze([
  'target_unresolved',
  'sheet_mismatch',
  'tenant_wall',
  'rows_unreadable',
  'rows_too_large',
  'pack_unreadable',
  // S6-5b: a census key column (SHEET_CENSUS_KEY_FIELD_IDS) is absent from the sheet — the pack's own token.
  'field_missing',
])
const GOVERNED_TOKENS = Object.freeze(['pilot', 'protected', 'none', 'unreadable'])

class StockPreparationRemnantAcknowledgementError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationRemnantAcknowledgementError'
    this.status = status
    this.code = code
    this.details = { ...details, partial: false }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function requestInvalid(field, message) {
  return new StockPreparationRemnantAcknowledgementError(400, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.REQUEST_INVALID, message, { field })
}

// ── the request shapes (the route allow-lists the keys first; these validate the values) ──────────

/** `?cursor` = the ordinal of the last row of the previous page (a non-negative integer); `?limit` 1..10. */
function normalizeCensusQuery(input = {}) {
  const query = isPlainObject(input) ? input : {}
  let cursor = 0
  if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
    const text = String(query.cursor)
    if (!/^(0|[1-9][0-9]{0,5})$/.test(text)) throw requestInvalid('cursor', 'cursor is the ordinal of the last row of the previous page')
    cursor = Number(text)
  }
  let limit = CENSUS_PAGE_LIMIT_DEFAULT
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
    const text = String(query.limit)
    if (!/^[1-9][0-9]?$/.test(text) || Number(text) > CENSUS_PAGE_LIMIT_MAX) throw requestInvalid('limit', `limit is an integer between 1 and ${CENSUS_PAGE_LIMIT_MAX}`)
    limit = Number(text)
  }
  return Object.freeze({ cursor, limit })
}

/**
 * The acknowledgement body: `{ confirmProjectNo, componentHandle, basis: 'head_not_ordered', runbookRef,
 * acknowledge: { customerAnswered: true } }` (the typed number is checked by the route against the path).
 */
function normalizeAcknowledgementBody(body) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  if (typeof body.componentHandle !== 'string' || !COMPONENT_DIGEST_PATTERN.test(body.componentHandle)) {
    throw requestInvalid('componentHandle', 'componentHandle is the 24-hex component handle the project census lists')
  }
  if (!REMNANT_ACKNOWLEDGEMENT_BASES.includes(body.basis)) throw requestInvalid('basis', 'basis must be head_not_ordered')
  if (typeof body.runbookRef !== 'string' || !RUNBOOK_REF_PATTERN.test(body.runbookRef)) throw requestInvalid('runbookRef', 'runbookRef must be a values-free ticket handle')
  const ack = body.acknowledge
  if (!isPlainObject(ack) || ack.customerAnswered !== true || Object.keys(ack).length !== 1) {
    throw requestInvalid('acknowledge', 'an acknowledgement states that the customer answered (acknowledge.customerAnswered)')
  }
  return Object.freeze({ componentHandle: body.componentHandle, basis: body.basis, runbookRef: body.runbookRef })
}

/** The revoke body: `{ confirmProjectNo, runbookRef }`; the acknowledgement id rides the path. */
function normalizeRevokeBody(body, acknowledgementId) {
  if (!isPlainObject(body)) throw requestInvalid('body', 'request must be an object')
  if (typeof acknowledgementId !== 'string' || !RULING_ID_PATTERN.test(acknowledgementId)) throw requestInvalid('acknowledgementId', 'acknowledgementId is the id the project census lists')
  if (typeof body.runbookRef !== 'string' || !RUNBOOK_REF_PATTERN.test(body.runbookRef)) throw requestInvalid('runbookRef', 'runbookRef must be a values-free ticket handle')
  return Object.freeze({ acknowledgementId, runbookRef: body.runbookRef })
}

// ── the census inputs ──────────────────────────────────────────────────────────────────────────────

/**
 * The human columns the census counts over (design §6.4: the main-build route covers pack `ext_` columns, which the
 * R-line pack cannot): the template's human band, plus every installed pack column the planner would treat as human
 * (declared human or pinned) OR could not classify (fail safe: a human-cell count can only over-count). Each pack column
 * is listed under its logical id AND its physical id, because the reader keys a cell by the logical id only when the
 * target's field map names it.
 *   installedFields: [{ fieldId, physicalId?, property }] — the strict pack read (ledger ∩ live host fields).
 */
function censusHumanFieldIdsOf(installedFields = []) {
  const template = normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const installed = Array.isArray(installedFields) ? installedFields.filter((entry) => isPlainObject(entry) && nonBlankString(entry.fieldId)) : []
  const derived = derivePackAwarePlmWritableFields({
    templateFields: template.fields,
    installedFieldProperties: installed.map((entry) => ({ fieldId: entry.fieldId, property: isPlainObject(entry.property) ? entry.property : {} })),
  })
  const human = new Set([...HUMAN_PRESERVED_FIELD_IDS, ...derived.humanPreservedFieldIds])
  const packHuman = new Set([...derived.packHumanPreservedFieldIds, ...derived.unclassifiedPackFieldIds])
  for (const entry of installed) {
    if (!packHuman.has(entry.fieldId)) continue
    human.add(entry.fieldId)
    if (nonBlankString(entry.physicalId)) human.add(entry.physicalId)
  }
  return [...human].sort()
}

/** The refresh-state derivation's governed token as the census answers it: an unreadable state is `unreadable`. */
function governedTokenOf(state) {
  if (!isPlainObject(state) || state.readable !== true) return 'unreadable'
  return GOVERNED_TOKENS.includes(state.governed) && state.governed !== 'unreadable' ? state.governed : 'unreadable'
}

/** Counts of the ACTIVE rulings by kind (null when the ledger could not be read). */
function rulingCountsOf(rulings) {
  if (!Array.isArray(rulings)) return { acknowledged: null, dropped: null }
  let acknowledged = 0
  let dropped = 0
  for (const ruling of rulings) {
    if (!isPlainObject(ruling) || ruling.status !== 'active') continue
    if (ruling.kind === 'remnant_acknowledged') acknowledged += 1
    else if (ruling.kind === 'dropped_head_included') dropped += 1
  }
  return { acknowledged, dropped }
}

/**
 * THE ONE EXEMPTION RULE (readiness v5 and the census share it): the project's D2 handles that no ACTIVE
 * `remnant_acknowledged` row names. `dropped_head_included` never exempts here (S6-7 widens it, register R-91).
 */
function unacknowledgedRemnantHandles(handles, rulings) {
  const acknowledged = new Set()
  for (const ruling of Array.isArray(rulings) ? rulings : []) {
    if (isPlainObject(ruling) && ruling.status === 'active' && ruling.kind === 'remnant_acknowledged' && typeof ruling.componentDigest === 'string') {
      acknowledged.add(ruling.componentDigest)
    }
  }
  return (Array.isArray(handles) ? handles : []).filter((handle) => !acknowledged.has(handle))
}

/** The census of one project's rows with its private handles (tenant and project bound the handle). */
function projectCensusOf(rows, { tenantId, projectNo, humanFieldIds } = {}) {
  if (!nonBlankString(tenantId) || !nonBlankString(projectNo)) throw new Error('projectCensusOf: tenantId and projectNo are required')
  const census = censusOfRows(rows, { tenantId, projectNo, humanFieldIds })
  if (!Array.isArray(census.private.inactiveRootRemnantComponentHandles)) throw new Error('projectCensusOf: the census computed no handles')
  return census
}

/** The acknowledgement's re-proof: the handle must be a D2 remnant of THIS read, else 409 NOT_PRESENT (nothing written). */
function assertRemnantPresent(census, componentHandle) {
  const handles = census && census.private ? census.private.inactiveRootRemnantComponentHandles : null
  if (!Array.isArray(handles) || !handles.includes(componentHandle)) {
    throw new StockPreparationRemnantAcknowledgementError(409, REMNANT_ACKNOWLEDGEMENT_ERROR_CODES.NOT_PRESENT, 'this component is not an inactive-root remnant of the project on a fresh read; nothing was recorded', { reason: 'not_a_remnant' })
  }
}

// ── the answers ────────────────────────────────────────────────────────────────────────────────────

/**
 * One row of the tenant-wide census. `census` null => `status: 'incomplete'` with a closed reason and NO counts (fail
 * closed — never a zero that reads as "clean"). `rulings` null => the acknowledgement counts read null.
 */
function censusRowAnswer({ ordinal, registryRow, census = null, incompleteReason = null, governed, rulings = null }) {
  const base = {
    ordinal,
    objectId: registryRow.objectId,
    registryStatus: registryRow.status,
    governed: GOVERNED_TOKENS.includes(governed) ? governed : 'unreadable',
  }
  if (!census) {
    return Object.freeze({ ...base, status: 'incomplete', reason: CENSUS_INCOMPLETE_REASONS.includes(incompleteReason) ? incompleteReason : 'rows_unreadable' })
  }
  const counts = publicCensusOf(census)
  const { acknowledged, dropped } = rulingCountsOf(rulings)
  const handles = census.private.inactiveRootRemnantComponentHandles
  return Object.freeze({
    ...base,
    status: 'complete',
    ...counts,
    acknowledgedComponents: acknowledged,
    rulingComponents: dropped,
    unacknowledgedRemnantComponents: Array.isArray(rulings) && Array.isArray(handles) ? unacknowledgedRemnantHandles(handles, rulings).length : null,
  })
}

/** The tenant-wide page. `nextCursor` is the last ordinal answered while more rows follow, else null. */
function censusPageAnswer({ items, total, cursor, limit }) {
  const last = items.length > 0 ? items[items.length - 1].ordinal : cursor
  return Object.freeze({
    scheme: SHEET_CENSUS_SCHEME,
    total,
    limit,
    items: Object.freeze(items.slice()),
    nextCursor: last < total ? String(last) : null,
  })
}

/** One project's census with its D2 components (private handles) and their active acknowledgements. */
function projectCensusAnswer({ projectNo, registryStatus, census, governed, rulings = null }) {
  const counts = publicCensusOf(census)
  const handles = census.private.inactiveRootRemnantComponentHandles
  const rulingsReadable = Array.isArray(rulings)
  const activeAcknowledgements = rulingsReadable
    ? rulings.filter((ruling) => isPlainObject(ruling) && ruling.status === 'active' && ruling.kind === 'remnant_acknowledged')
    : []
  const byDigest = new Map(activeAcknowledgements.map((ruling) => [ruling.componentDigest, ruling]))
  const acknowledgementOf = (ruling) => (ruling
    ? Object.freeze({ acknowledgementId: ruling.id, basis: ruling.basis, runbookRef: ruling.runbookRef, recordedAt: ruling.recordedAt })
    : null)
  const components = handles.map((handle) => Object.freeze({
    componentHandle: handle,
    acknowledgement: rulingsReadable ? acknowledgementOf(byDigest.get(handle)) : null,
  }))
  const present = new Set(handles)
  // An active acknowledgement whose component is no longer a remnant (repaired, or re-ordered): listed so it can be
  // revoked; it exempts nothing that is not a remnant, so it is harmless to readiness.
  const notCurrentlyRemnant = activeAcknowledgements
    .filter((ruling) => !present.has(ruling.componentDigest))
    .map((ruling) => Object.freeze({ componentHandle: ruling.componentDigest, ...acknowledgementOf(ruling) }))
  const { acknowledged, dropped } = rulingCountsOf(rulings)
  return Object.freeze({
    projectNo,
    registryStatus,
    status: 'complete',
    governed: GOVERNED_TOKENS.includes(governed) ? governed : 'unreadable',
    ...counts,
    acknowledgedComponents: acknowledged,
    rulingComponents: dropped,
    unacknowledgedRemnantComponents: rulingsReadable ? unacknowledgedRemnantHandles(handles, rulings).length : null,
    rulingsReadable,
    components: Object.freeze(components),
    acknowledgementsNotCurrentlyRemnant: Object.freeze(notCurrentlyRemnant),
  })
}

function acknowledgementAnswer(row, { created }) {
  return Object.freeze({
    acknowledgementId: row.id,
    componentHandle: row.componentDigest,
    kind: row.kind,
    basis: row.basis,
    status: row.status,
    runbookRef: row.runbookRef,
    recordedAt: row.recordedAt,
    ...(created ? {} : { revokedAt: row.revokedAt, revokedRunbookRef: row.revokedRunbookRef }),
    nextStep: 'readiness_again',
  })
}

// ── the audit entries (D9: existing actions, closed `mode` subtypes) ──────────────────────────────

function countOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** The tenant-wide read's detail: integers only. */
function censusListAuditDetail(page) {
  let complete = 0
  let incomplete = 0
  let remnants = 0
  let unacknowledged = 0
  let unacknowledgedUnknown = 0
  for (const item of page.items) {
    if (item.status !== 'complete') { incomplete += 1; continue }
    complete += 1
    remnants += countOf(item.inactiveRootRemnantComponents)
    if (item.unacknowledgedRemnantComponents === null) unacknowledgedUnknown += 1
    else unacknowledged += countOf(item.unacknowledgedRemnantComponents)
  }
  return {
    operation: 'sheet_census_list',
    total: countOf(page.total),
    itemCount: page.items.length,
    completeCount: complete,
    incompleteCount: incomplete,
    remnantComponents: remnants,
    unacknowledgedRemnantComponents: unacknowledged,
    rulingsUnreadableCount: unacknowledgedUnknown,
  }
}

/** The single-project read's detail: integers and booleans only (no project number, no handle). */
function projectCensusAuditDetail(answer) {
  const counts = {}
  for (const key of SHEET_CENSUS_COUNT_KEYS) counts[key] = countOf(answer[key])
  return {
    operation: 'sheet_census_project',
    counts,
    acknowledgedComponents: countOf(answer.acknowledgedComponents),
    rulingsReadable: answer.rulingsReadable === true,
  }
}

const ACKNOWLEDGEMENT_AUDIT_MODES = Object.freeze({
  remnant_acknowledged: SHEET_CENSUS_AUDIT.modes.acknowledged,
  remnant_acknowledgement_revoked: SHEET_CENSUS_AUDIT.modes.revoked,
})

/** The store's event as its audit entry: subject = the ruling id; detail = closed tokens and the runbook handle. */
function acknowledgementAuditEntryOf(event) {
  const mode = isPlainObject(event) && Object.prototype.hasOwnProperty.call(ACKNOWLEDGEMENT_AUDIT_MODES, event.operation) ? ACKNOWLEDGEMENT_AUDIT_MODES[event.operation] : null
  if (!mode) throw new StockPreparationRemnantAcknowledgementError(500, 'STOCK_PREP_COMPONENT_RULING_INPUT_INVALID', 'the ruling store handed an audit event outside its closed map', { reason: 'audit_event_unknown' })
  return {
    action: SHEET_CENSUS_AUDIT.decisionAction,
    subjectId: event.rulingId,
    mode,
    detail: {
      operation: event.operation,
      kind: event.kind,
      basis: event.basis,
      runbookRef: event.runbookRef,
    },
  }
}

module.exports = {
  SHEET_CENSUS_AUDIT,
  CENSUS_PAGE_LIMIT_DEFAULT,
  CENSUS_PAGE_LIMIT_MAX,
  CENSUS_INCOMPLETE_REASONS,
  GOVERNED_TOKENS,
  REMNANT_ACKNOWLEDGEMENT_ERROR_CODES,
  StockPreparationRemnantAcknowledgementError,
  normalizeCensusQuery,
  normalizeAcknowledgementBody,
  normalizeRevokeBody,
  censusHumanFieldIdsOf,
  governedTokenOf,
  unacknowledgedRemnantHandles,
  projectCensusOf,
  assertRemnantPresent,
  censusRowAnswer,
  censusPageAnswer,
  projectCensusAnswer,
  acknowledgementAnswer,
  censusListAuditDetail,
  projectCensusAuditDetail,
  acknowledgementAuditEntryOf,
}
