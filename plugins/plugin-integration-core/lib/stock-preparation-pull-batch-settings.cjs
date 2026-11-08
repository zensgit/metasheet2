'use strict'

// ---------------------------------------------------------------------------------------------------
// 批次标识 (pull batch) BI-7 — THE SETTINGS ROUTES' HELPER (batch-identifier design §5.5, §7.1, §10.3, §11, §15;
// coordinator rulings C2 / C6 / C7 / C8 / C10 / C12 / C13; register R-65). Everything the three settings routes need
// beyond their gate and their scope lives HERE, so http-routes.cjs gains only three self-contained handlers (and the
// R-line backport, ruling C13, copies this file):
//
//   GET  /api/integration/stock-preparation/pull-batch/settings                               the tenant default, the
//        fixed facts, the vocabulary and every registered project sheet's CAPTURED values with their locks
//   POST /api/integration/stock-preparation/pull-batch/settings                               the tenant default (CAS)
//   POST /api/integration/stock-preparation/projects/:projectNo/target/pull-batch/settings    one captured sheet's
//        rule / format (typed confirmation; CAS; refused once the sheet carries a batch label)
//
// THE SWITCHES (ruling C6). The settings exist only while BOTH the pull-batch switch (read by the lanes helper, its one
// reader) and the project-sheets switch are exactly 'true'. Otherwise every route answers 404
// STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED after its gate and BEFORE any IO (no scope lookup, no store, no audit), and
// the web panel renders nothing. This file never reads the environment: the route hands it both booleans.
//
// THE BODIES. Closed allowlists; every value is judged by the pure module's ONE configuration reader (strict
// equality: no trim, no case folding), here, before the scope lookup — so a malformed request costs nothing. A refusal
// names the FIELD only, never the value. `expectedVersion` and `confirmProjectNo` are stripped before the patch is
// handed on (the store's normalizer refuses any non-setting key). The per-sheet body carries the two CAPTURED keys
// only: landing / placement are install-time values (BI-2) that lock once applied, never edited here.
//
// NO-OP. Same version and every patched value already equal => 200 written:false, no write, no audit row (otherwise a
// repeat of the captured value on a LOCKED sheet would pass the lock helper's no-change rule and still bump the
// version and write an audit row whose before equals its after).
//
// AUDIT (ruling C8; #6808's choice, the B4 / migration 088 precedent). The EXISTING action `project_fields_update`
// with the store's two closed modes, written by the audit store's `appendWithin` INSIDE the store's own transaction
// (the setting and its audit row commit or roll back together). The detail is the store's flat depth-1
// `{ <key>Before, <key>After, version }` of enum tokens. `project_id` carries the project number on a sheet row (the
// 088 project handle, ruling C12) and is NULL on a tenant row; the project number is never in the detail, the mode,
// the subject, an error or a log. No new audit action, no CHECK widening, no migration.
//
// VALUES. Answers carry closed tokens, booleans, versions, ISO times, sheet handles and — admin-visible, the 087
// precedent — the project numbers of the caller's own tenant's registered sheets. No material id, key, path, part id
// or quantity exists anywhere here.
// ---------------------------------------------------------------------------------------------------

const {
  DEFAULT_PULL_BATCH_CONFIG,
  PULL_BATCH_CONFIG_LOCKS,
  PULL_BATCH_CONFIG_VALUES,
  PULL_BATCH_ERROR_CODES,
  PULL_BATCH_FIXED_FACTS,
  PULL_BATCH_SETTINGS_HELP,
  StockPreparationPullBatchError,
  normalizePullBatchConfig,
} = require('./stock-preparation-pull-batch.cjs')
const {
  PULL_BATCH_SETTING_KEYS,
  PULL_BATCH_SHEET_SETTING_KEYS,
  PULL_BATCH_STORE_AUDIT,
} = require('./stock-preparation-pull-batch-store.cjs')
const { STOCK_PREP_PULL_BATCH_ENABLED_ENV } = require('./stock-preparation-pull-batch-lanes.cjs')

// Route-level codes (never in the pure module, which stays byte-identical with the R line).
const STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED_CODE = 'STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED'
const STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE_CODE = 'STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE'
// The S4 / B4 typed-confirmation code (http-routes.cjs STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE; the route
// suite pins the two spellings equal).
const STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE = 'STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH'
const AUDIT_STORE_UNAVAILABLE_CODE = 'AUDIT_STORE_UNAVAILABLE'

// The closed bodies (ruling C2: the four settings; per sheet the two captured keys).
const PULL_BATCH_TENANT_SETTINGS_BODY_KEYS = Object.freeze(['expectedVersion', ...PULL_BATCH_SETTING_KEYS])
const PULL_BATCH_SHEET_SETTINGS_BODY_KEYS = Object.freeze(['confirmProjectNo', 'expectedVersion', ...PULL_BATCH_SHEET_SETTING_KEYS])

// The audit action and modes, ONE spelling (the store's): the routes never respell them.
const PULL_BATCH_SETTINGS_AUDIT = PULL_BATCH_STORE_AUDIT

const REGISTRY_STATUSES = Object.freeze(['active', 'archived'])

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

// One constructor for every refusal here: the pure module's error class with the HTTP status pinned (a typed refusal
// — status + closed code — answers as itself through the values-free route wrapper).
function settingsError(status, code, message, details = {}) {
  const error = new StockPreparationPullBatchError(code, message, details)
  error.status = status
  return error
}

function configInvalid(field, message) {
  return settingsError(400, PULL_BATCH_ERROR_CODES.CONFIG_INVALID, message, { field })
}

// ── the switches (ruling C6) and the store ──────────────────────────────────────────────────────────

/**
 * 404 STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED unless BOTH switches are on. The caller reads them (the lanes helper for
 * the pull-batch switch, the project-targets module for the project-sheets switch), so this file reads no env. Pure:
 * no IO of any kind.
 */
function assertPullBatchSettingsEnabled({ pullBatchEnabled, projectSheetsEnabled } = {}) {
  if (pullBatchEnabled === true && projectSheetsEnabled === true) return
  throw settingsError(
    404,
    STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED_CODE,
    `pull-batch settings are off on this deployment (${STOCK_PREP_PULL_BATCH_ENABLED_ENV} and the project-sheets switch must both be exactly 'true')`,
  )
}

/** The wired ledger store, or 501 STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE (a deployment that never built it). */
function requirePullBatchSettingsStore(store) {
  if (!store
    || typeof store.readTenantSettings !== 'function'
    || typeof store.writeTenantSettings !== 'function'
    || typeof store.setSheetSettings !== 'function'
    || typeof store.listSheetSettings !== 'function'
    || typeof store.readSheetState !== 'function') {
    throw settingsError(501, STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE_CODE, 'the pull-batch ledger store is not available on this deployment; the settings cannot be read or written here')
  }
  return store
}

// ── the request bodies (pure; before any IO) ──────────────────────────────────────────────────────────

function closedBody(body, allowedKeys) {
  if (!isPlainObject(body)) throw configInvalid('body', 'the pull-batch settings request must be an object')
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) throw configInvalid(key, 'unsupported pull-batch settings request field')
  }
  return body
}

function expectedVersionOf(body) {
  const value = body.expectedVersion
  if (!Number.isSafeInteger(value) || value < 0) throw configInvalid('expectedVersion', 'expectedVersion must be the version that was read (an integer >= 0)')
  return value
}

/**
 * The patch: the setting keys the body carries (at least one), each value judged by the pure module's one reader of a
 * configuration (strict equality; a refusal names the field). Answers a frozen object of exactly those keys.
 */
function patchOf(body, settingKeys) {
  const raw = {}
  for (const key of settingKeys) {
    if (hasOwn(body, key)) raw[key] = body[key]
  }
  const keys = Object.keys(raw)
  if (keys.length === 0) throw configInvalid('patch', 'at least one pull-batch setting is required')
  const normalized = normalizePullBatchConfig(raw)
  const patch = {}
  for (const key of keys) patch[key] = normalized[key]
  return Object.freeze(patch)
}

/** POST …/pull-batch/settings: `{ expectedVersion, firstPullBatchRule?, labelFormat?, landing?, placement? }`. */
function parseTenantSettingsRequest(body) {
  const input = closedBody(body, PULL_BATCH_TENANT_SETTINGS_BODY_KEYS)
  const expectedVersion = expectedVersionOf(input)
  return Object.freeze({ expectedVersion, patch: patchOf(input, PULL_BATCH_SETTING_KEYS) })
}

/**
 * POST …/projects/:projectNo/target/pull-batch/settings: `{ confirmProjectNo, expectedVersion, firstPullBatchRule?,
 * labelFormat? }`. `projectNo` is the path's (already validated by the route). The typed confirmation must repeat it
 * EXACTLY (the S4 / B4 rule: both sides trimmed the same way, nothing else folded).
 */
function parseSheetSettingsRequest(body, projectNo) {
  const input = closedBody(body, PULL_BATCH_SHEET_SETTINGS_BODY_KEYS)
  const confirmProjectNo = typeof input.confirmProjectNo === 'string' ? input.confirmProjectNo.trim() : ''
  if (typeof projectNo !== 'string' || confirmProjectNo !== projectNo) {
    throw settingsError(400, STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE, 'confirmProjectNo must repeat the project number in the path exactly', { field: 'confirmProjectNo' })
  }
  const expectedVersion = expectedVersionOf(input)
  return Object.freeze({ expectedVersion, patch: patchOf(input, PULL_BATCH_SHEET_SETTING_KEYS) })
}

// ── no-op and change detection ─────────────────────────────────────────────────────────────────────────

/** The tenant edit changes nothing: the version read is the version sent and every patched value already holds. */
function tenantSettingsEditIsNoop(current, expectedVersion, patch) {
  if (!current || current.version !== expectedVersion || !isPlainObject(current.settings)) return false
  return Object.keys(patch).every((key) => current.settings[key] === patch[key])
}

/** The keys of `patch` whose value moves away from `settings` (in the store's key order). */
function changedSettingKeys(settings, patch) {
  return Object.freeze(PULL_BATCH_SETTING_KEYS.filter((key) => hasOwn(patch, key) && (!settings || settings[key] !== patch[key])))
}

/**
 * The per-sheet edit changes nothing (`sheet` = the store's `readSheetState(...).sheet`, read under the registry row
 * lock): the row exists, its version is the one sent and every patched value is the captured one. A null sheet is
 * never a no-op — the store answers 409 SETTINGS_NOT_CAPTURED.
 */
function sheetSettingsEditIsNoop(sheet, expectedVersion, patch) {
  if (!sheet || sheet.version !== expectedVersion) return false
  return Object.keys(patch).every((key) => sheet[key] === patch[key])
}

/** `readSheetState(...).sheet` (the store's rowToSheet projection) as the store's admin settings row shape. */
function ledgerRowOfSheetState(sheet) {
  if (!sheet) return null
  const landing = sheet.landingMode === undefined ? null : sheet.landingMode
  const placement = sheet.bandPlacement === undefined ? null : sheet.bandPlacement
  const stamped = sheet.settingsLockedAt !== null && sheet.settingsLockedAt !== undefined
  return Object.freeze({
    sheetId: sheet.sheetId,
    projectNo: sheet.projectNo,
    historyStatus: sheet.historyStatus,
    labelLocale: sheet.labelLocale,
    captured: Object.freeze({ firstPullBatchRule: sheet.firstPullBatchRule, labelFormat: sheet.labelFormat, landing, placement }),
    locks: Object.freeze({ firstPullBatchRule: stamped, labelFormat: stamped, landing: landing !== null, placement: placement !== null }),
    lockedAt: stamped ? sheet.settingsLockedAt : null,
    version: sheet.version,
  })
}

// ── the audit adapter (ruling C8) ───────────────────────────────────────────────────────────────────────

/**
 * The `auditWithin(trx, entry)` the store calls INSIDE its transaction: one `appendWithin` row on that same handle.
 * `projectNo` is the path's project number for the per-sheet write (null for the tenant write); a mode that does not
 * belong to this write is a wiring defect (500, nothing committed). `adapter.appended` records that the row was handed
 * over, so the route can refuse loudly if a store regression ever skipped it (the pilot's belt, HR markPilotEnabled).
 */
function pullBatchSettingsAuditWithin({ audit, tenantId, actor, projectNo = null } = {}) {
  const modes = PULL_BATCH_SETTINGS_AUDIT.modes
  const expectedMode = projectNo === null ? modes.tenantSettingsUpdated : modes.sheetSettingsUpdated
  const adapter = async (trx, entry) => {
    if (!entry || entry.mode !== expectedMode) {
      throw settingsError(500, AUDIT_STORE_UNAVAILABLE_CODE, 'the pull-batch settings store handed an audit entry of another mode; nothing was written')
    }
    await audit.appendWithin(trx, {
      tenantId,
      // The 088 project handle (B4 / pilot precedent, ruling C12): the project number on a sheet row, NULL on a tenant
      // row. Never in `detail`.
      projectId: projectNo,
      action: PULL_BATCH_SETTINGS_AUDIT.settingsAction,
      subjectId: entry.subjectId === undefined ? null : entry.subjectId,
      mode: entry.mode,
      actor,
      detail: entry.detail,
    })
    adapter.appended = true
  }
  adapter.appended = false
  return adapter
}

/** A write that committed without handing its audit row over is a store defect: said loudly (500). */
function assertSettingsAudited(adapter) {
  if (!adapter || adapter.appended !== true) {
    throw settingsError(500, AUDIT_STORE_UNAVAILABLE_CODE, 'the pull-batch settings write landed without its in-transaction audit row')
  }
}

// ── the answers ───────────────────────────────────────────────────────────────────────────────────────────

function publicTenantSettings(tenant) {
  const settings = {}
  for (const key of PULL_BATCH_SETTING_KEYS) settings[key] = tenant.settings[key]
  return Object.freeze({ settings: Object.freeze(settings), source: tenant.source, version: tenant.version })
}

/**
 * One per-sheet row: the registry row (always) joined with its ledger row (null = not captured yet: 「安装时采用」).
 * `may.set`: an ACTIVE registry row whose ledger row exists and whose rule / format are not locked yet.
 */
function pullBatchSheetAnswer(ledgerRow, registryRow) {
  const registryStatus = REGISTRY_STATUSES.includes(registryRow && registryRow.status) ? registryRow.status : 'archived'
  const captured = ledgerRow ? Object.freeze({
    firstPullBatchRule: ledgerRow.captured.firstPullBatchRule,
    labelFormat: ledgerRow.captured.labelFormat,
    landing: ledgerRow.captured.landing === undefined ? null : ledgerRow.captured.landing,
    placement: ledgerRow.captured.placement === undefined ? null : ledgerRow.captured.placement,
  }) : null
  const locks = ledgerRow ? Object.freeze({
    firstPullBatchRule: ledgerRow.locks.firstPullBatchRule === true,
    labelFormat: ledgerRow.locks.labelFormat === true,
    landing: ledgerRow.locks.landing === true,
    placement: ledgerRow.locks.placement === true,
  }) : null
  return Object.freeze({
    projectNo: registryRow.projectNo,
    sheetId: registryRow.sheetId,
    registryStatus,
    captured,
    labelLocale: ledgerRow ? ledgerRow.labelLocale : null,
    historyStatus: ledgerRow ? ledgerRow.historyStatus : null,
    locks,
    lockedAt: ledgerRow ? ledgerRow.lockedAt : null,
    version: ledgerRow ? ledgerRow.version : null,
    may: Object.freeze({ set: registryStatus === 'active' && captured !== null && locks.firstPullBatchRule === false }),
  })
}

/**
 * The GET answer: the vocabulary, the built-in defaults (the 10-27 design), the tenant default, the fixed facts, the
 * lock map, the per-sheet keys, the module's help copy (C10's rule-F caveat comes from there) and one row per
 * REGISTERED sheet (registry order, oldest first), joined on (sheetId, projectNo). Ledger rows with no registry row
 * are COUNTED, never listed.
 */
function pullBatchSettingsAnswer({ tenant, ledgerRows, registryRows }) {
  const ledgerByKey = new Map()
  for (const row of ledgerRows) ledgerByKey.set(`${row.sheetId}\u0000${row.projectNo}`, row)
  const matched = new Set()
  const sheets = []
  for (const registryRow of registryRows) {
    const key = `${registryRow.sheetId}\u0000${registryRow.projectNo}`
    const ledgerRow = ledgerByKey.get(key) || null
    if (ledgerRow) matched.add(key)
    sheets.push(pullBatchSheetAnswer(ledgerRow, registryRow))
  }
  return Object.freeze({
    vocabulary: PULL_BATCH_CONFIG_VALUES,
    builtIn: DEFAULT_PULL_BATCH_CONFIG,
    tenant: publicTenantSettings(tenant),
    fixedFacts: PULL_BATCH_FIXED_FACTS,
    locks: PULL_BATCH_CONFIG_LOCKS,
    sheetKeys: PULL_BATCH_SHEET_SETTING_KEYS,
    help: PULL_BATCH_SETTINGS_HELP,
    sheets: Object.freeze(sheets),
    unregisteredLedgerRowCount: ledgerByKey.size - matched.size,
    may: Object.freeze({ setTenant: true }),
  })
}

module.exports = {
  AUDIT_STORE_UNAVAILABLE_CODE,
  PULL_BATCH_SETTINGS_AUDIT,
  PULL_BATCH_SHEET_SETTINGS_BODY_KEYS,
  PULL_BATCH_TENANT_SETTINGS_BODY_KEYS,
  STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE,
  STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED_CODE,
  STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE_CODE,
  assertPullBatchSettingsEnabled,
  assertSettingsAudited,
  changedSettingKeys,
  ledgerRowOfSheetState,
  parseSheetSettingsRequest,
  parseTenantSettingsRequest,
  publicTenantSettings,
  pullBatchSettingsAnswer,
  pullBatchSettingsAuditWithin,
  pullBatchSheetAnswer,
  requirePullBatchSettingsStore,
  sheetSettingsEditIsNoop,
  tenantSettingsEditIsNoop,
}
