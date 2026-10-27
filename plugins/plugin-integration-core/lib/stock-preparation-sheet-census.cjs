'use strict'

// Batch-refresh step 6d-1a (design-final §6.4, T6-16) — the doubled-sheet census, PURE.
//
// What it is: one function over the rows the project-scoped reader returns
// (stock-preparation-table-actions.cjs `readExistingStockPreparationRows`: logical field ids, the
// creator on the planner's EXISTING_ROW_CREATED_BY Symbol) that counts the doubled-sheet shapes of
// design §6.1. It reads nothing, writes nothing, holds no step-4 state, takes no source read. No
// route calls it in this PR; the census route is 6d-1b (S6-5).
//
// Its twin is the R-line psql pack `scripts/ops/stock-prep-sheet-census-20261027/01-sheet-census.sql`,
// which computes the SAME counts with the SAME predicates directly over `meta_records` on a
// machine that runs a package without this module (R74/R75). Parity between the two is the real-DB
// case S9D-02 (packages/core-backend/tests/integration/stock-preparation-sheet-census-realdb.cases.ts).
// Change a definition below and the pack's matching predicate in the SAME PR, or S9D-02 turns red.
//
// THE DEFINITIONS (copied into the pack's header; each line is the one definition):
//   active(row)        row.active !== false — only the boolean false is inactive; the string 'false',
//                      0, null and a missing cell are ACTIVE (the pairing module's isActiveRow, F6-17).
//   root(row)          parentSourceId is blank (the pairing module's isRootRow).
//   blank(v)           undefined, null, or a string whose JS trim() is empty. Any other value —
//                      boolean false, 0, [] included — is a filled cell (K2's isBlankCell; a cleared
//                      checkbox reads as a fill, so the human-cell counts can only over-count).
//   component(row)     componentSourceId when it is a string with non-empty trim(), UNTRIMMED; else
//                      none (the readiness O-6 grouping, countTwoCopyComponents).
//   key(row)           idempotencyKey when it is a string with non-empty trim(), UNTRIMMED; else none
//                      (the pairing module's keyOf).
//   creator(row)       row[EXISTING_ROW_CREATED_BY] is a string with non-empty trim() (GOV-05; the
//                      reader sets it only for a non-blank meta_records.created_by).
//
//   rowCount                     every row.
//   activeRowCount               active rows.
//   twoCopyComponents            D1 / O-6: components with an ACTIVE root row AND an ACTIVE nested row.
//   inactiveRootRemnantComponents D2 / item-10: components with an INACTIVE root row, NO active root
//                                row, and at least one ACTIVE nested row.
//   duplicateKeyGroups           D3: keys carried by two or more rows (active or not — an inactive row
//                                still occupies its key).
//   keylessRowsWithoutCreator    D4: ACTIVE rows with no key and no creator (plugin-written; a defect).
//   keylessRowsWithCreator       D4: ACTIVE rows with no key and a creator (hand-added; owner 10-27
//                                manual-row rule, F6-30 — never a defect).
//   nonBooleanActiveCells        D5: rows whose `active` cell is present, not null and not a boolean.
//   inactiveRowsWithHumanCells   INACTIVE rows with at least one non-blank human cell.
//   nestedCopiesWithHumanCells   ACTIVE nested rows of a D1 or D2 component (the occurrence HEAD row,
//                                not its subtree — subtree pairs are the fills report's, 6d-2a) with at
//                                least one non-blank human cell.
//
// VALUES-FREE (RD G4). The public projection (`publicCensusOf`) is integers only. The D2 component
// handles are PRIVATE: `sha256(tenantId ':' projectNo ':' componentSourceId)` first 24 hex (§6.5's
// handle), computed only when both tenantId and projectNo are passed, and returned under `private`
// so a caller that posts evidence strips them by construction. A handle is a digest of business
// values and can be brute-forced; it never goes to #6079 or a PR body.

const crypto = require('node:crypto')
const path = require('node:path')

const {
  __internals: { isActiveRow, isRootRow },
} = require(path.join(__dirname, 'stock-preparation-continuation-pairing.cjs'))
const { EXISTING_ROW_CREATED_BY } = require(path.join(__dirname, 'stock-preparation-conflict-planner.cjs'))
const { HUMAN_PRESERVED_FIELD_IDS } = require(path.join(__dirname, 'stock-preparation-templates.cjs'))

const SHEET_CENSUS_SCHEME = 'stock-preparation/sheet-census/v1'
const COMPONENT_HANDLE_LENGTH = 24

// The public count keys, in output order. The pack prints exactly these (snake_case) per sheet.
const SHEET_CENSUS_COUNT_KEYS = Object.freeze([
  'rowCount',
  'activeRowCount',
  'twoCopyComponents',
  'inactiveRootRemnantComponents',
  'duplicateKeyGroups',
  'keylessRowsWithoutCreator',
  'keylessRowsWithCreator',
  'nonBooleanActiveCells',
  'inactiveRowsWithHumanCells',
  'nestedCopiesWithHumanCells',
])

class StockPreparationSheetCensusError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationSheetCensusError'
    this.code = 'STOCK_PREP_SHEET_CENSUS_INPUT_INVALID'
    this.details = details
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isBlankCell(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function componentOf(row) {
  return nonBlankString(row.componentSourceId) ? row.componentSourceId : null
}

function keyOf(row) {
  return nonBlankString(row.idempotencyKey) ? row.idempotencyKey : null
}

function hasCreator(row) {
  return nonBlankString(row[EXISTING_ROW_CREATED_BY])
}

function hasHumanCell(row, humanFieldIds) {
  return humanFieldIds.some((fieldId) => !isBlankCell(row[fieldId]))
}

function normalizeHumanFieldIds(value) {
  if (value === undefined) return HUMAN_PRESERVED_FIELD_IDS.slice()
  if (!Array.isArray(value) || !value.every(nonBlankString)) {
    throw new StockPreparationSheetCensusError('humanFieldIds must be a list of non-blank strings', { field: 'humanFieldIds' })
  }
  return Array.from(new Set(value))
}

function componentHandle(tenantId, projectNo, componentSourceId) {
  return crypto.createHash('sha256').update(`${tenantId}:${projectNo}:${componentSourceId}`, 'utf8').digest('hex').slice(0, COMPONENT_HANDLE_LENGTH)
}

/**
 * Census of ONE project sheet's rows (the reader's logical rows). Returns
 *   { scheme, ...the SHEET_CENSUS_COUNT_KEYS integers, private: { inactiveRootRemnantComponentHandles } }
 * `private.inactiveRootRemnantComponentHandles` is a sorted list when tenantId and projectNo are both
 * non-blank strings, else null. Never throws on a row's content; throws only on a malformed argument.
 */
function censusOfRows(rows, options = {}) {
  if (!Array.isArray(rows)) throw new StockPreparationSheetCensusError('rows must be an array', { field: 'rows' })
  if (!isPlainObject(options)) throw new StockPreparationSheetCensusError('options must be an object', { field: 'options' })
  const humanFieldIds = normalizeHumanFieldIds(options.humanFieldIds)

  const counts = Object.fromEntries(SHEET_CENSUS_COUNT_KEYS.map((key) => [key, 0]))
  const activeRoots = new Set()
  const inactiveRoots = new Set()
  const activeNested = new Set()
  const keyCounts = new Map()

  for (const candidate of rows) {
    const row = isPlainObject(candidate) ? candidate : {}
    const active = isActiveRow(row)
    const root = isRootRow(row)
    const component = componentOf(row)
    const key = keyOf(row)
    counts.rowCount += 1
    if (active) counts.activeRowCount += 1
    if (component !== null) {
      if (active && root) activeRoots.add(component)
      else if (!active && root) inactiveRoots.add(component)
      else if (active && !root) activeNested.add(component)
    }
    if (key !== null) keyCounts.set(key, (keyCounts.get(key) || 0) + 1)
    if (active && key === null) {
      if (hasCreator(row)) counts.keylessRowsWithCreator += 1
      else counts.keylessRowsWithoutCreator += 1
    }
    if (Object.prototype.hasOwnProperty.call(row, 'active') && row.active !== undefined && row.active !== null
      && typeof row.active !== 'boolean') counts.nonBooleanActiveCells += 1
    if (!active && hasHumanCell(row, humanFieldIds)) counts.inactiveRowsWithHumanCells += 1
  }

  const twoCopy = new Set([...activeRoots].filter((component) => activeNested.has(component)))
  const remnants = [...inactiveRoots].filter((component) => !activeRoots.has(component) && activeNested.has(component))
  counts.twoCopyComponents = twoCopy.size
  counts.inactiveRootRemnantComponents = remnants.length
  for (const occurrences of keyCounts.values()) if (occurrences >= 2) counts.duplicateKeyGroups += 1

  const doubled = new Set([...twoCopy, ...remnants])
  for (const candidate of rows) {
    const row = isPlainObject(candidate) ? candidate : {}
    if (!isActiveRow(row) || isRootRow(row)) continue
    const component = componentOf(row)
    if (component !== null && doubled.has(component) && hasHumanCell(row, humanFieldIds)) counts.nestedCopiesWithHumanCells += 1
  }

  const tenantId = nonBlankString(options.tenantId) ? options.tenantId.trim() : null
  const projectNo = nonBlankString(options.projectNo) ? options.projectNo.trim() : null
  const handles = tenantId && projectNo
    ? remnants.map((component) => componentHandle(tenantId, projectNo, component)).sort()
    : null
  return { scheme: SHEET_CENSUS_SCHEME, ...counts, private: { inactiveRootRemnantComponentHandles: handles } }
}

/** The values-free projection: the scheme and the integers, nothing under `private`. */
function publicCensusOf(census) {
  if (!isPlainObject(census)) throw new StockPreparationSheetCensusError('census must be an object', { field: 'census' })
  const out = { scheme: SHEET_CENSUS_SCHEME }
  for (const key of SHEET_CENSUS_COUNT_KEYS) {
    if (!Number.isInteger(census[key]) || census[key] < 0) {
      throw new StockPreparationSheetCensusError('census count must be a non-negative integer', { field: key })
    }
    out[key] = census[key]
  }
  return out
}

module.exports = {
  SHEET_CENSUS_SCHEME,
  SHEET_CENSUS_COUNT_KEYS,
  StockPreparationSheetCensusError,
  censusOfRows,
  publicCensusOf,
  __internals: {
    componentHandle,
    isBlankCell,
  },
}
