'use strict'

// 人工补充行 (manual supplementary rows) — the PLUGIN half of ADR adr-stock-prep-manual-rows-20261030 (PR-B series,
// slices B1 and B4). Pure and IO-free except four helpers, each doing its IO only through the port it is handed:
// `persistManualRowsLastPull` (B1) writes ONE values-free plugin_kv record; `readManualRowsLastPull` (B4) reads it
// back; `readManualRowsKeyColumn` / `setManualRowsPolicy` (B4) read and set the per-sheet switch through the host's
// provisioning port (one field property of the key column, read back after the write). No route lives here, and
// nothing here reaches an external system.
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
 * Persist the last small-lane pull's reminder (ADR §5.3), BEST EFFORT: a failure — the store, or a clock value that is
 * not a valid time — is logged (code only) and never fails the pull it describes. The record's `at` is the explicit
 * `at` string when given, else `now` (epoch ms; the current time when absent), converted INSIDE the try. A pull with
 * something to say writes its record; a pull with nothing to say overwrites a record only when one exists (so an
 * earlier reminder never outlives the pull that cleared it), and a sheet that never had a prefix row never gets a
 * record (a reader treats "no record" as all zeros). Returns true when a record was written.
 */
async function persistManualRowsLastPull({ store, sheetId, mode, at, now, summary, logger } = {}) {
  const key = manualRowsLastPullKey(sheetId)
  if (!key || !store || typeof store.get !== 'function' || typeof store.set !== 'function') return false
  if (!MANUAL_ROWS_LAST_PULL_MODES.includes(mode)) return false
  try {
    const stamp = typeof at === 'string' ? at : new Date(Number.isFinite(now) ? now : Date.now()).toISOString()
    if (!summary) {
      const previous = await store.get(key)
      if (previous === null || previous === undefined) return false
    }
    await store.set(key, manualRowsLastPullRecord({ at: stamp, mode, summary }))
    return true
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[plugin-integration-core] stock-prep manual-rows reminder could not be persisted; the pull result stands', {
        code: error && typeof error.code === 'string' ? error.code : 'PERSIST_FAILED',
        mode,
      })
    }
    return false
  }
}

// ── B4: reading the persisted reminder back (ADR §5.3, §8 「B4」 2) ──────────────────────────────────────────────────
//
// The panel shows the last small-lane pull's reminder from the record above. THREE answers, never a fourth:
//   'recorded'    the record B1 wrote, field for field (the two id lists capped at MANUAL_SUPPLEMENT_ID_LIMIT);
//   'none'        NO record — B1 interpretation 1: a sheet whose pulls never read a prefix row gets no record, so "no
//                 record" means ALL ZEROS (no manual rows, no unbound rows, no reminder) and is never an error;
//   'unavailable' the store could not be read, or what it holds is not the shape B1 writes. Fail closed in the one
//                 direction that matters here: never zeros, because zeros would hide a reminder that may exist. The
//                 counts are null so no reader can mistake this answer for 'none'.
const MANUAL_ROWS_LAST_PULL_STATUSES = Object.freeze(['recorded', 'none', 'unavailable'])

function noManualRowsLastPull() {
  return { status: 'none', at: null, mode: null, rowCount: 0, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [] }
}

function unavailableManualRowsLastPull() {
  return { status: 'unavailable', at: null, mode: null, rowCount: null, unboundKeyCount: null, matchedManualCount: null, matchedManualRecordIds: [], unboundRecordIds: [] }
}

function isNonNegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

// A persisted id list as B1 writes it: an array of non-blank record ids. Anything else is not that record (null).
function persistedRecordIdList(value) {
  if (!Array.isArray(value)) return null
  const ids = []
  for (const id of value) {
    if (!isNonBlankString(id)) return null
    if (ids.length < MANUAL_SUPPLEMENT_ID_LIMIT) ids.push(id)
  }
  return ids
}

/** The persisted value (or its absence) → the reader's answer. Pure. */
function normalizeManualRowsLastPull(value) {
  if (value === null || value === undefined) return noManualRowsLastPull()
  if (!isPlainObject(value)) return unavailableManualRowsLastPull()
  const { rowCount, unboundKeyCount, matchedManualCount } = value
  if (![rowCount, unboundKeyCount, matchedManualCount].every(isNonNegativeCount)) return unavailableManualRowsLastPull()
  const matchedManualRecordIds = persistedRecordIdList(value.matchedManualRecordIds)
  const unboundRecordIds = persistedRecordIdList(value.unboundRecordIds)
  if (!matchedManualRecordIds || !unboundRecordIds) return unavailableManualRowsLastPull()
  if (!MANUAL_ROWS_LAST_PULL_MODES.includes(value.mode)) return unavailableManualRowsLastPull()
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return unavailableManualRowsLastPull()
  return {
    status: 'recorded',
    at: value.at,
    mode: value.mode,
    rowCount,
    unboundKeyCount,
    matchedManualCount,
    matchedManualRecordIds,
    unboundRecordIds,
  }
}

/** Read the last-pull record of one sheet from the plugin's durable storage. Never throws. */
async function readManualRowsLastPull({ store, sheetId } = {}) {
  const key = manualRowsLastPullKey(sheetId)
  if (!key || !store || typeof store.get !== 'function') return unavailableManualRowsLastPull()
  let value
  try {
    value = await store.get(key)
  } catch {
    return unavailableManualRowsLastPull()
  }
  return normalizeManualRowsLastPull(value)
}

// ── B4: THE PER-SHEET SWITCH (ADR §4, OQ6) ─────────────────────────────────────────────────────────────────────────
//
// STORED as the key column's field property `stockPreparationManualRows`: ABSENT or exactly 'allowed' = manual rows
// allowed; ANY OTHER present value = disabled. This is the host's rule (packages/core-backend/src/multitable/
// stock-preparation-manual-rows.ts `manualRowsPolicyValueOf`), answer for answer — the host↔plugin contract test
// (core-backend tests/unit/stock-preparation-manual-rows-contract.test.ts) runs both readers over one truth table, so
// a junk value can never read as allowed on one side and disabled on the other.
//
// WRITTEN only through the host's provisioning port (`patchObjectFieldProperty`: object-scope checked to this plugin,
// the canonical sheet fence, the host's own sanitizer, a per-key merge), with a patch of exactly ONE key — never a raw
// SQL write, never the human write lock, never the key stanza. The port's merge keeps every other key, and the switch
// is READ BACK after the write: it must hold the value asked for, and the column must still be locked (or unlocked)
// exactly as before and still carry (or lack) the key stanza — else the write is UNCONFIRMED: the route audits it as
// unconfirmed (the patch has landed; a switch change is never left unaudited) and answers a typed 500.
const MANUAL_ROWS_POLICY_PROPERTY_KEY = 'stockPreparationManualRows'
const MANUAL_ROWS_POLICY_ALLOWED = 'allowed'
const MANUAL_ROWS_POLICY_DISABLED = 'disabled'
const MANUAL_ROWS_POLICIES = Object.freeze([MANUAL_ROWS_POLICY_ALLOWED, MANUAL_ROWS_POLICY_DISABLED])
// The logical key column every stock-prep target keys on (the template's `keyFields`); the host derives its physical id.
const MANUAL_ROWS_KEY_FIELD_ID = 'idempotencyKey'
const HUMAN_WRITE_LOCK_PROPERTY_KEY = 'humanWriteLock'
const HUMAN_WRITE_LOCK_PLM_SYSTEM = 'plm_system'
const KEY_COLUMN_STANZA_PROPERTY_KEY = 'stockPreparation'

class StockPreparationManualRowsError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationManualRowsError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// A property as the host stores it may arrive as an object or as JSON text (the host's own reader accepts both).
function propertyObjectOf(property) {
  if (isPlainObject(property)) return property
  if (typeof property === 'string' && property.trim()) {
    try {
      const parsed = JSON.parse(property)
      return isPlainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * The switch value a property CARRIES: null when the key is absent (or `undefined`, which JSON cannot store);
 * 'allowed' only for the exact literal; 'disabled' for every other present value.
 */
function manualRowsPolicyValueOf(property) {
  const obj = propertyObjectOf(property)
  if (!obj || !Object.prototype.hasOwnProperty.call(obj, MANUAL_ROWS_POLICY_PROPERTY_KEY)) return null
  const value = obj[MANUAL_ROWS_POLICY_PROPERTY_KEY]
  if (value === undefined) return null
  return value === MANUAL_ROWS_POLICY_ALLOWED ? MANUAL_ROWS_POLICY_ALLOWED : MANUAL_ROWS_POLICY_DISABLED
}

/** The switch's EFFECT: absent = allowed; 'allowed' = allowed; anything else present = disabled. */
function manualRowsPolicyOfProperty(property) {
  return manualRowsPolicyValueOf(property) || MANUAL_ROWS_POLICY_ALLOWED
}

/**
 * Does the host offer manual rows on a registered sheet with this object id at all? The host's predicate (a) requires
 * the registered project-sheet shape `plm_stock_preparation_sandbox_p_<24 hex>` (the same rule as M′ (a′) above). An
 * ADOPTED older sandbox sheet (the runbook's adopt path) carries another object id, so the host answers every
 * manual-row route `not_project_sheet` there and the switch would have no effect: the switch route says so instead of
 * offering it (B4 fix round 1). Its pulls still set prefix rows aside — every one of them counts as unbound there.
 */
function manualRowsSupportedOnObject(objectId) {
  return isStockPreparationProjectSheetObjectId(objectId)
}

/**
 * What the switch route reads off the key column. `locked` is the host's own lock rule (`humanWriteLock` exactly
 * 'plm_system'; anything else is no lock, and the host's sanitizer drops it); `keyStanza` is predicate (b)'s marker
 * (`stockPreparation.key === true`). Both are compared before and after a write; neither is ever a value.
 */
function manualRowsKeyColumnState(field) {
  if (!field) {
    return { present: false, policy: null, source: null, stored: null, locked: null, keyStanza: null }
  }
  const property = propertyObjectOf(field.property) || {}
  const stored = manualRowsPolicyValueOf(property)
  const stanza = propertyObjectOf(property[KEY_COLUMN_STANZA_PROPERTY_KEY])
  return {
    present: true,
    policy: stored || MANUAL_ROWS_POLICY_ALLOWED,
    source: stored === null ? 'default' : 'set',
    stored,
    locked: property[HUMAN_WRITE_LOCK_PROPERTY_KEY] === HUMAN_WRITE_LOCK_PLM_SYSTEM,
    keyStanza: Boolean(stanza) && stanza.key === true,
  }
}

function requireSwitchProvisioning(provisioning, { write }) {
  if (!provisioning || typeof provisioning.getObjectField !== 'function' || (write && typeof provisioning.patchObjectFieldProperty !== 'function')) {
    throw new StockPreparationManualRowsError(
      501,
      'STOCK_PREP_MANUAL_ROWS_HOST_UNSUPPORTED',
      'this host cannot read or write a project sheet column setting (multitable.provisioning getObjectField + patchObjectFieldProperty); the manual-rows switch is not available here',
      { requiredMethods: write ? ['getObjectField', 'patchObjectFieldProperty'] : ['getObjectField'] },
    )
  }
  return provisioning
}

/** Read the key column of ONE registered project sheet (the registry row's objectId). No write. */
async function readManualRowsKeyColumn({ provisioning, projectId, objectId } = {}) {
  const port = requireSwitchProvisioning(provisioning, { write: false })
  return manualRowsKeyColumnState(await port.getObjectField({ projectId, objectId, fieldId: MANUAL_ROWS_KEY_FIELD_ID }))
}

/** The read-back's closed failure names, in the order they are checked. */
const MANUAL_ROWS_SWITCH_READBACK_CHECKS = Object.freeze(['readback', 'policy', 'lock', 'key_stanza'])

/** The typed 500 a route answers when the read-back did not confirm the write (after it audited the write). */
function manualRowsSwitchUnconfirmedError(check) {
  return new StockPreparationManualRowsError(
    500,
    'STOCK_PREP_MANUAL_ROWS_SWITCH_UNCONFIRMED',
    'the manual-rows switch was written but reading it back did not confirm the change; check this project sheet',
    { check: MANUAL_ROWS_SWITCH_READBACK_CHECKS.includes(check) ? check : 'readback' },
  )
}

/**
 * SET the switch of ONE registered project sheet to `policy` ('allowed' | 'disabled'), then READ IT BACK. Returns
 * `{ before, after, written, unconfirmed }`:
 *   - a column already carrying exactly `policy` is not written again (`written: false`, `unconfirmed: null`);
 *   - after a write, `unconfirmed` is null when the read-back shows the switch holding `policy` with the column's
 *     lock and key stanza exactly as before — else the closed name of the first failed check: 'readback' (the
 *     column could not be read back at all; `after` is then null), 'policy', 'lock', 'key_stanza'.
 * It does NOT throw for an unconfirmed write: the patch has landed by then, so the CALLER audits it first (a switch
 * change is never left unaudited, OQ6) and then answers `manualRowsSwitchUnconfirmedError`.
 * Refusals (nothing written): 400 POLICY_INVALID; 501 HOST_UNSUPPORTED; 409 KEY_COLUMN_MISSING (the sheet has no key
 * column to carry the switch). A patch the host refuses propagates as the host's error.
 */
async function setManualRowsPolicy({ provisioning, projectId, objectId, policy } = {}) {
  if (!MANUAL_ROWS_POLICIES.includes(policy)) {
    throw new StockPreparationManualRowsError(400, 'STOCK_PREP_MANUAL_ROWS_POLICY_INVALID', "policy must be 'allowed' or 'disabled'", { field: 'policy' })
  }
  const port = requireSwitchProvisioning(provisioning, { write: true })
  const read = async () => manualRowsKeyColumnState(await port.getObjectField({ projectId, objectId, fieldId: MANUAL_ROWS_KEY_FIELD_ID }))
  const before = await read()
  if (!before.present) {
    throw new StockPreparationManualRowsError(409, 'STOCK_PREP_MANUAL_ROWS_KEY_COLUMN_MISSING', 'this project sheet has no unique-key column to carry the manual-rows switch; nothing was written', {})
  }
  if (before.stored === policy) return { before, after: before, written: false, unconfirmed: null }
  await port.patchObjectFieldProperty({
    projectId,
    objectId,
    fieldId: MANUAL_ROWS_KEY_FIELD_ID,
    propertyPatch: { [MANUAL_ROWS_POLICY_PROPERTY_KEY]: policy },
  })
  let after
  try {
    after = await read()
  } catch {
    return { before, after: null, written: true, unconfirmed: 'readback' }
  }
  let unconfirmed = null
  if (!after.present || after.stored !== policy) unconfirmed = 'policy'
  else if (after.locked !== before.locked) unconfirmed = 'lock'
  else if (after.keyStanza !== before.keyStanza) unconfirmed = 'key_stanza'
  return { before, after, written: true, unconfirmed }
}

module.exports = {
  EXISTING_ROWS_MANUAL_PREFIX,
  MANUAL_ROW_KEY_PREFIX,
  MANUAL_ROW_KEY_V1_PREFIX,
  MANUAL_ROWS_KEY_FIELD_ID,
  MANUAL_ROWS_LAST_PULL_KEY_PREFIX,
  MANUAL_ROWS_LAST_PULL_MODES,
  MANUAL_ROWS_LAST_PULL_STATUSES,
  MANUAL_ROWS_POLICIES,
  MANUAL_ROWS_POLICY_ALLOWED,
  MANUAL_ROWS_POLICY_DISABLED,
  MANUAL_ROWS_POLICY_PROPERTY_KEY,
  MANUAL_ROWS_SWITCH_READBACK_CHECKS,
  MANUAL_SUPPLEMENT_ID_LIMIT,
  ROW_SOURCES,
  StockPreparationManualRowsError,
  classifyManualPrefixRow,
  createManualPrefixCollector,
  exportRowSourceOf,
  isManualPrefixKey,
  isManualSupplementRow,
  manualPrefixRowsOf,
  manualRowKeyFor,
  manualRowsKeyColumnState,
  manualRowsLastPullKey,
  manualRowsLastPullRecord,
  manualRowsPolicyOfProperty,
  manualRowsPolicyValueOf,
  manualRowsSupportedOnObject,
  manualRowsSwitchUnconfirmedError,
  normalizeManualRowsLastPull,
  persistManualRowsLastPull,
  readManualRowsKeyColumn,
  readManualRowsLastPull,
  setManualRowsPolicy,
  summarizeManualSupplement,
}
