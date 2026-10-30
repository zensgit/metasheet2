'use strict'

// 人工补充行 (manual supplementary rows) — the PLUGIN half of ADR adr-stock-prep-manual-rows-20261030 (PR-B series,
// slice B1). Pure and IO-free except `persistManualRowsLastPull`, which writes ONE values-free plugin_kv record
// through the store it is handed. No route, no host write, no external system.
//
// THE NAMESPACE (ADR §2.2 「前缀行」). A stock-prep project sheet's unique key (`idempotencyKey`) is written by the
// pull as `JSON.stringify({ projectNo, componentSourceId, parentSourceId, path })`
// (stock-preparation-bom-expansion.cjs makeIdempotencyKey), so a PLM key always starts with `{`. Every key that starts
// with `manual:` is RESERVED for rows people make: the pull never plans, updates, deactivates or compares them, and the
// writer refuses to ADD one (APPLY_MANUAL_KEY_RESERVED). The comparison is the RAW `startsWith` — no trim — on both
// sides (B2's host module must use the same rule; a key with a leading space is not a prefix row anywhere).
//
// THE PREDICATE M′ (ADR §2.2). A prefix row is a MANUAL ROW only when all three hold:
//   (a′) the bound target's objectId is a registered project sheet's (`plm_stock_preparation_sandbox_p_<24 hex>`, the
//        one rule own-base.cjs holds — the target binding takes it from the registry row);
//   (c′) the record ENVELOPE's `createdBy` is a non-blank string (meta_records.created_by; the plugin SDK's INSERT never
//        writes it, so a plugin-made row never satisfies this);
//   (d′) the key equals `'manual:v1:' + <the envelope's record id>` exactly.
// The envelope is read DIRECTLY (its `id`, its `createdBy`) — never a cell inside `data`, which a person could type,
// and never the main-only EXISTING_ROW_RECORD_REF Symbol (the R-line reader has no such field, ADR §2.2 (d′)).
// Every other prefix row is an UNBOUND PREFIX ROW: counted, never planned, never written by the pull. No predicate
// here looks at the column lock (ADR §2.3 ④).
//
// HOST PARITY. B2 adds the host module (packages/core-backend/src/multitable/stock-preparation-manual-rows.ts) with the
// same two prefix constants, byte for byte, and the same truth table
// (__tests__/support/stock-preparation-manual-rows-truth-table.cjs); B2's contract test pins the two together. Until
// then the plugin suite pins the constants and the table on this side alone.

const { isStockPreparationProjectSheetObjectId } = require('./stock-preparation-own-base.cjs')

const MANUAL_ROW_KEY_PREFIX = 'manual:'
const MANUAL_ROW_KEY_V1_PREFIX = 'manual:v1:'

// The two record-id lists a result / the persisted record carries are capped (ADR §5.1): handles, never values.
const MANUAL_SUPPLEMENT_ID_LIMIT = 50

// ADR §5.3: the last small-lane pull's reminder, one record per target sheet, in the plugin's durable storage.
const MANUAL_ROWS_LAST_PULL_KEY_PREFIX = 'stockPrepManualRows:lastPull:v1:'
const MANUAL_ROWS_LAST_PULL_MODES = Object.freeze(['dry_run', 'apply'])

// The export's 来源 classification (ADR §6). The labels are the export module's; these are the closed tokens.
const ROW_SOURCES = Object.freeze({
  MANUAL_SUPPLEMENT: 'manual_supplement',
  MANUAL_OTHER: 'manual_other',
  PLM: 'plm',
})

// The prefix rows `readExistingStockPreparationRows` took out of a project read ride on the returned ARRAY under this
// key: non-enumerable and never an index, so stableStringify / JSON.stringify / Object.keys / every hash over the array
// skip it, and a copy (`slice`, `map`, cloneJson) simply drops it. Attached ONLY when the read found a prefix row, so a
// sheet without one reads exactly the array it read before B1. Value: frozen
// `{ manualRows: [{ recordId, row }], unboundKeyCount, unboundRecordIds }`.
const EXISTING_ROWS_MANUAL_PREFIX = Symbol.for('metasheet.stock-preparation.existingRows.manualPrefix')

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Does this key sit in the reserved `manual:` namespace? RAW comparison (no trim). */
function isManualPrefixKey(key) {
  return typeof key === 'string' && key.startsWith(MANUAL_ROW_KEY_PREFIX)
}

/** The manual-row key a record with this id carries (`manual:v1:<id>`); null for a blank id. */
function manualRowKeyFor(recordId) {
  return isNonBlankString(recordId) ? `${MANUAL_ROW_KEY_V1_PREFIX}${recordId}` : null
}

/**
 * M′ over primitive inputs: `objectId` of the bound target, and the record ENVELOPE's `createdBy` and `id`, and the
 * row's key-column value.
 */
function isManualSupplementRow({ objectId, createdBy, recordId, key } = {}) {
  return isStockPreparationProjectSheetObjectId(objectId)
    && isNonBlankString(createdBy)
    && isNonBlankString(recordId)
    && typeof key === 'string'
    && key === `${MANUAL_ROW_KEY_V1_PREFIX}${recordId}`
}

/** 'manual' (a prefix row satisfying M′), 'unbound_prefix' (any other prefix row), or null (not a prefix row). */
function classifyManualPrefixRow(input = {}) {
  if (!isManualPrefixKey(input.key)) return null
  return isManualSupplementRow(input) ? 'manual' : 'unbound_prefix'
}

/**
 * The export's 来源 (ADR §6): M′ => 人工补充; any other prefix row (with or without a creator) and any other row with a
 * creator => 人工（非补充）; everything else => PLM.
 */
function exportRowSourceOf(input = {}) {
  if (isManualSupplementRow(input)) return ROW_SOURCES.MANUAL_SUPPLEMENT
  if (isManualPrefixKey(input.key) || isNonBlankString(input.createdBy)) return ROW_SOURCES.MANUAL_OTHER
  return ROW_SOURCES.PLM
}

/** A collector the project read fills page by page (manual rows kept whole; unbound rows counted, ids capped). */
function createManualPrefixCollector() {
  const manualRows = []
  const unboundRecordIds = []
  let unboundKeyCount = 0
  return {
    add(kind, row, recordId) {
      if (kind === 'manual') {
        manualRows.push(Object.freeze({ recordId, row }))
        return
      }
      unboundKeyCount += 1
      if (isNonBlankString(recordId) && unboundRecordIds.length < MANUAL_SUPPLEMENT_ID_LIMIT) unboundRecordIds.push(recordId)
    },
    // Attaches the collected rows to `rows` (non-enumerable, see EXISTING_ROWS_MANUAL_PREFIX) and returns `rows`.
    // Nothing is attached when nothing was collected.
    attachTo(rows) {
      if (manualRows.length === 0 && unboundKeyCount === 0) return rows
      Object.defineProperty(rows, EXISTING_ROWS_MANUAL_PREFIX, {
        value: Object.freeze({
          manualRows: Object.freeze(manualRows.slice()),
          unboundKeyCount,
          unboundRecordIds: Object.freeze(unboundRecordIds.slice()),
        }),
        enumerable: false,
        writable: false,
        configurable: false,
      })
      return rows
    },
  }
}

/** The prefix rows a project read took out, or null when it took none (or the array is not the read's own). */
function manualPrefixRowsOf(existingRows) {
  if (!Array.isArray(existingRows)) return null
  const value = existingRows[EXISTING_ROWS_MANUAL_PREFIX]
  return isPlainObject(value) ? value : null
}

// One cell as the reminder compares it: a string trimmed, a finite number as its decimal text, anything else blank.
function matchText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function nameSpecMaterialOf(row) {
  return JSON.stringify([matchText(row.componentName), matchText(row.componentSpec), matchText(row.material)])
}

function sortedCapped(ids) {
  return ids.slice().sort((left, right) => (left < right ? -1 : (left > right ? 1 : 0))).slice(0, MANUAL_SUPPLEMENT_ID_LIMIT)
}

/**
 * THE REMINDER (ADR §5.3, OQ4) and the result stanza (§5.1): `null` when the read took no prefix row; otherwise
 * `{ rowCount, unboundKeyCount, matchedManualCount, matchedManualRecordIds, unboundRecordIds }` — counts and record
 * handles only. `addRecords` are the `record`s of THIS plan's ADD decisions and nothing else: a manual row matches when
 * an ADD row carries its 图号 (both trimmed, the manual one non-blank), or — the manual row having no 图号 — when an
 * ADD row agrees on 名称, 规格 and 材料 (each trimmed). A row that already exists (UPDATE / SKIP — e.g. the PLM row a
 * manual copy was made from) is never an ADD, so it never reminds. `matchedManualRecordIds` are MANUAL rows' ids.
 * Never merges anything; never in a plan, a revision or a token.
 */
function summarizeManualSupplement({ existingRows, addRecords } = {}) {
  const prefix = manualPrefixRowsOf(existingRows)
  if (!prefix) return null
  const rowCount = prefix.manualRows.length
  const unboundKeyCount = prefix.unboundKeyCount
  if (rowCount === 0 && unboundKeyCount === 0) return null
  const codes = new Set()
  const nameSpecMaterial = new Set()
  for (const record of Array.isArray(addRecords) ? addRecords : []) {
    if (!isPlainObject(record)) continue
    const code = matchText(record.componentCode)
    if (code !== '') codes.add(code)
    nameSpecMaterial.add(nameSpecMaterialOf(record))
  }
  const matched = []
  for (const entry of prefix.manualRows) {
    const code = matchText(entry.row.componentCode)
    const hit = code !== '' ? codes.has(code) : nameSpecMaterial.has(nameSpecMaterialOf(entry.row))
    if (hit) matched.push(entry.recordId)
  }
  return {
    rowCount,
    unboundKeyCount,
    matchedManualCount: matched.length,
    matchedManualRecordIds: sortedCapped(matched),
    unboundRecordIds: sortedCapped(prefix.unboundRecordIds),
  }
}

function manualRowsLastPullKey(sheetId) {
  return isNonBlankString(sheetId) ? `${MANUAL_ROWS_LAST_PULL_KEY_PREFIX}${sheetId}` : null
}

/** The persisted value (ADR §5.3): time, mode, counts and record handles — no business value. */
function manualRowsLastPullRecord({ at, mode, summary }) {
  return {
    at,
    mode,
    rowCount: summary ? summary.rowCount : 0,
    unboundKeyCount: summary ? summary.unboundKeyCount : 0,
    matchedManualCount: summary ? summary.matchedManualCount : 0,
    matchedManualRecordIds: summary ? summary.matchedManualRecordIds.slice() : [],
    unboundRecordIds: summary ? summary.unboundRecordIds.slice() : [],
  }
}

/**
 * Persist the last small-lane pull's reminder (ADR §5.3), BEST EFFORT: a storage failure is logged (code only) and
 * never fails the pull it describes. A pull with something to say writes its record; a pull with nothing to say
 * overwrites a record only when one exists (so an earlier reminder never outlives the pull that cleared it), and a
 * sheet that never had a prefix row never gets a record. Returns true when a record was written.
 */
async function persistManualRowsLastPull({ store, sheetId, mode, at, summary, logger } = {}) {
  const key = manualRowsLastPullKey(sheetId)
  if (!key || !store || typeof store.get !== 'function' || typeof store.set !== 'function') return false
  if (!MANUAL_ROWS_LAST_PULL_MODES.includes(mode)) return false
  try {
    if (!summary) {
      const previous = await store.get(key)
      if (previous === null || previous === undefined) return false
    }
    await store.set(key, manualRowsLastPullRecord({ at, mode, summary }))
    return true
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[plugin-integration-core] stock-prep manual-rows reminder could not be persisted; the pull result stands', {
        code: error && typeof error.code === 'string' ? error.code : 'STORAGE_FAILED',
        mode,
      })
    }
    return false
  }
}

module.exports = {
  EXISTING_ROWS_MANUAL_PREFIX,
  MANUAL_ROW_KEY_PREFIX,
  MANUAL_ROW_KEY_V1_PREFIX,
  MANUAL_ROWS_LAST_PULL_KEY_PREFIX,
  MANUAL_ROWS_LAST_PULL_MODES,
  MANUAL_SUPPLEMENT_ID_LIMIT,
  ROW_SOURCES,
  classifyManualPrefixRow,
  createManualPrefixCollector,
  exportRowSourceOf,
  isManualPrefixKey,
  isManualSupplementRow,
  manualPrefixRowsOf,
  manualRowKeyFor,
  manualRowsLastPullKey,
  manualRowsLastPullRecord,
  persistManualRowsLastPull,
  summarizeManualSupplement,
}
