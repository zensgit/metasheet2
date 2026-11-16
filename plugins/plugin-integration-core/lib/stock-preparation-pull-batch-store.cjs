'use strict'

// ---------------------------------------------------------------------------------------------------
// 批次标识 (pull batch) — THE LEDGER STORE over migration 105 (batch-identifier design BI-1a §3.3-§3.6, §3.9, §8.2;
// coordinator rulings C2 / C7 / C8; register R-65). DORMANT: nothing in the plugin requires this file yet (BI-1b
// wires the lanes, BI-2 the install, BI-7 the settings routes — each behind the pull-batch switch BI-1b adds, which
// does not exist yet and will default OFF). The only writer and the only reader of
//   integration_stock_prep_pull_batch_settings    one row per tenant: the tenant DEFAULT of the page settings
//   integration_stock_prep_pull_batch_sheet       one row per (sheet, project): readiness, install, CAPTURED settings
//   integration_stock_prep_pull_batch             one row per batch (open / closed / void)
//   integration_stock_prep_pull_batch_execution   the execution <-> batch link (UNIQUE execution_ref)
// through the scoped db helper (lib/db.cjs): equality WHERE only, SELECT * projections, no raw SQL.
//
// PORTABLE (design §12.2; S6 C-1). Meant to be byte-identical on the R maintenance line: it requires only the pure
// module (`./stock-preparation-pull-batch.cjs`) and node:crypto — no lock, governance, continuation, refresh, audit or
// table-action module (a scan test pins it). What differs per line is INJECTED:
//   * `holderWithin(trx)` — on main the lane passes the sheet write lock's holder assert (LK.assertHolderWithin,
//     S6 C-6), run FIRST in the allocation / finish / abort transaction: a frozen writer that wakes after a takeover
//     can neither void nor supersede the live writer's batch (F-BI-1). The R line passes none (no lease).
//   * `voidReuse` — 'in_lease' on main (the in-lease read proves no row carries an open batch's label), 'off' on the
//     R line.
//   * `auditWithin(trx, entry)` — the settings / abort writes hand their audit entry to the caller INSIDE their own
//     transaction (the audit store's `appendWithin`, bound by BI-7 / BI-2), so the write and its audit row commit or
//     roll back together. A throw rolls the write back.
//
// THE SETTINGS (owner 2026-11-07, ruling C2). Four keys, the pure module's closed vocabulary, built-in defaults = the
// 10-27 design:
//   firstPullBatchRule  material | predecessor_suffix    captured per sheet; locked when the sheet first stamps
//   labelFormat         ordinal_date | ordinal            captured per sheet; locked when the sheet first stamps
//   landing             promote_prep_fill | keep_current  tenant default; applied (and locked) by the install step
//   placement           left | right                      tenant default; applied (and locked) by the install step
// The tenant default is COPIED into the sheet row at birth / install (`createSheetRowWithin`); a later tenant change
// never moves a captured sheet. The per-sheet edit (`setSheetSettings`) accepts the two captured keys only and runs
// the pure module's lock helper over { hasStamped, landingApplied, placementApplied } read from the LOCKED row. The
// tenant default placement never waives …_PLACEMENT_REQUIRED (that check belongs to the install, BI-2).
//
// THE LOCK (rulings C2, C7). `settings_locked_at` is set in the SAME transaction that hands a label out
// (`allocate`, or the install's Txn A in BI-2): from that commit the sheet's rule and format are fixed. `allocate`
// takes `expectedRule` (the rule the lane built its 首次 carry map from) and compares it with the row it holds FOR
// UPDATE, and the per-sheet edit locks the same row first — so an edit and the first allocation serialize, and
// whichever commits second fails cleanly (409 SETTINGS_LOCKED or 409 CONFLICT settings_changed), never both. The lock
// is NEVER cleared, with one exception: `abortInstall` of a FIRST install (installing -> pending) clears it iff no row
// carries a label of the persisted plan and the project has no live batch (design §8.2 permanence rule).
//
// AUDIT (ruling C8). Flat depth-1 details of enum tokens only: `{ <key>Before, <key>After, version }`. The modes are
// closed (`PULL_BATCH_STORE_AUDIT.modes`); the action is the EXISTING `project_fields_update` (migration 088, the B4
// per-sheet switch precedent; tenant-level rows carry no project), install aborts ride `project_target_create`
// (design §15). No audit vocabulary migration (D9 precedent, stock-preparation-refresh-decisions.cjs).
//
// THREE ANSWERS (fail closed). A read answers rows or THROWS 503 STOCK_PREP_PULL_BATCH_STORE_FAILED — never "no batch"
// on a failure; a missing table (a deploy without 105) is a store failure. Typed refusals are 4xx with closed codes.
//
// COUNTS BY VALUE (S6 C-4). No counter on the batch row: a batch's row count is the sum of its links'
// `created_row_count`, computed when read. A link is finished ONCE (`finished_at IS NULL` CAS).
//
// VALUES. Errors carry handles, closed tokens, counts and SQLSTATE codes only. `project_no` is a customer value stored
// exactly as the project registry (087) stores it; it never goes into an error. `listSheetSettings` is an ADMIN read
// (it answers projectNo, the 087 precedent) and is never audit or evidence material.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const {
  DEFAULT_PULL_BATCH_CONFIG,
  PULL_BATCH_CLOSED_REASONS,
  PULL_BATCH_CONFIG_VALUES,
  PULL_BATCH_ERROR_CODES,
  PULL_BATCH_LOCALES,
  PULL_BATCH_SOURCE_DIGEST_PATTERN,
  PULL_BATCH_UNKNOWN_LABELS,
  StockPreparationPullBatchError,
  formatPullBatchLabel,
  normalizePullBatchConfig,
  pullBatchLabelDay,
  refusedPullBatchConfigEdits,
} = require('./stock-preparation-pull-batch.cjs')

const PULL_BATCH_TABLES = Object.freeze({
  settings: 'integration_stock_prep_pull_batch_settings',
  sheet: 'integration_stock_prep_pull_batch_sheet',
  batch: 'integration_stock_prep_pull_batch',
  execution: 'integration_stock_prep_pull_batch_execution',
})

// ── closed vocabularies of the ledger (migration 105 CHECKs; the vocabulary-migration suite pins each) ───────────
const PULL_BATCH_HISTORY_STATUSES = Object.freeze(['pending', 'installing', 'born_empty', 'backfilled'])
const PULL_BATCH_RESOLVED_HISTORY_STATUSES = Object.freeze(['born_empty', 'backfilled'])
const PULL_BATCH_LANES = Object.freeze(['small_apply', 'large_apply'])
const PULL_BATCH_WRITER_STATUSES = Object.freeze(['succeeded', 'partial', 'failed', 'aborted'])
const PULL_BATCH_VOID_REUSE_MODES = Object.freeze(['in_lease', 'off'])
const PULL_BATCH_VERIFIED_OUTCOMES = Object.freeze(['verified_landed', 'verified_mixed', 'verified_nothing_landed', 'verified_unknown'])

// ── the four page settings (ruling C2): key -> SQL column, values from the pure module's vocabulary ───────────────
const PULL_BATCH_SETTING_KEYS = Object.freeze(['firstPullBatchRule', 'labelFormat', 'landing', 'placement'])
const PULL_BATCH_SHEET_SETTING_KEYS = Object.freeze(['firstPullBatchRule', 'labelFormat'])
const PULL_BATCH_SETTING_COLUMNS = Object.freeze({
  firstPullBatchRule: 'first_pull_batch_rule',
  labelFormat: 'label_format',
  landing: 'landing_mode',
  placement: 'band_placement',
})
const PULL_BATCH_SETTING_VALUES = Object.freeze(Object.fromEntries(PULL_BATCH_SETTING_KEYS.map((key) => [key, PULL_BATCH_CONFIG_VALUES[key]])))
const PULL_BATCH_BUILT_IN_SETTINGS = Object.freeze(Object.fromEntries(PULL_BATCH_SETTING_KEYS.map((key) => [key, DEFAULT_PULL_BATCH_CONFIG[key]])))

// Codes the pure module does not (yet) define; spelled here so the store answers them today. The pure module's
// ruling-C2 amendment is expected to export them; the store's literals must then equal its constants.
const SETTINGS_VERSION_CONFLICT_CODE = 'STOCK_PREP_PULL_BATCH_SETTINGS_VERSION_CONFLICT'
const SETTINGS_NOT_CAPTURED_CODE = 'STOCK_PREP_PULL_BATCH_SETTINGS_NOT_CAPTURED'
// The recovery close's refusals (S6 C-2 / C-3) spell the step-4 STATE_MOVED literal: this file imports no step-4
// module (C-1), and the code already has its web copy.
const STATE_MOVED_CODE = 'STOCK_PREP_PULL_STATE_MOVED'

// The audit entries this store hands to `auditWithin` (ruling C8). BI-7 / BI-2 bind the action and the tenant.
const PULL_BATCH_STORE_AUDIT = Object.freeze({
  settingsAction: 'project_fields_update',
  settingsMigration: '088',
  installAction: 'project_target_create',
  modes: Object.freeze({
    tenantSettingsUpdated: 'pull_batch_settings_tenant_updated',
    sheetSettingsUpdated: 'pull_batch_settings_sheet_updated',
    installAborted: 'pull_batch_install_aborted',
    // BI-2 (P2-12): the install's Txn A and Txn B, and a new sheet born ready, all under `project_target_create`.
    installStarted: 'pull_batch_install_started',
    installed: 'pull_batch_installed',
    bornReady: 'pull_batch_born_ready',
  }),
})

// The install's persisted-plan digest (sha256 hex) and the history modes the install records (migration 105 CHECKs).
const INSTALL_PLAN_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const INSTALL_HISTORY_MODES = Object.freeze(['inferred', 'unknown'])
const INSTALL_EXPECTABLE_STATUSES = Object.freeze(['pending', 'born_empty', 'backfilled'])

const RECOVERY_RESULTS = Object.freeze(['landed', 'mixed', 'nothing_landed', 'unknown'])
const RECOVERY_OUTCOME_BY_RESULT = Object.freeze({
  landed: 'verified_landed',
  mixed: 'verified_mixed',
  nothing_landed: 'verified_nothing_landed',
  unknown: 'verified_unknown',
})

const READ_CEILING_BATCHES = 5000
const READ_CEILING_LINKS = 20000
const READ_CEILING_SHEETS = 5000
const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 200
const EXECUTION_REF_PATTERN = /^(small|large):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const ID_PREFIX = Object.freeze({ sheet: 'pbs_', batch: 'pbat_', execution: 'pbx_' })

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function rowsOf(result) {
  if (Array.isArray(result)) return result
  return result && Array.isArray(result.rows) ? result.rows : []
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

// A DATE column as its calendar day (node-postgres parses DATE as LOCAL midnight; read local components).
function dayOrNull(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return pullBatchLabelDay(value)
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null
}

function intOrNull(value) {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) ? n : null
}

function jsonOrNull(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return null }
  }
  return value
}

function isSet(value) {
  return value !== null && value !== undefined
}

// Values-free: SQLSTATE only (five characters, a class code).
function sqlStateOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

// One constructor for every refusal: the pure module's error class, with the HTTP status pinned (a code the pure
// module's status map does not know yet would otherwise answer 500).
function pullBatchError(status, code, message, details = {}) {
  const error = new StockPreparationPullBatchError(code, message, details)
  error.status = status
  return error
}

function storeFailed(operation, error, extra = {}) {
  const sqlState = sqlStateOf(error)
  return pullBatchError(503, PULL_BATCH_ERROR_CODES.STORE_FAILED, 'the pull-batch ledger could not be read or written; nothing was created', {
    operation,
    ...(sqlState ? { sqlState } : {}),
    partial: false,
    ...extra,
  })
}

function conflict(reason, error) {
  const sqlState = sqlStateOf(error)
  return pullBatchError(409, PULL_BATCH_ERROR_CODES.CONFLICT, 'another pull or edit changed this project\'s batch state at the same moment; preview again', {
    reason,
    ...(sqlState ? { sqlState } : {}),
    partial: false,
  })
}

function inputInvalid(field) {
  return pullBatchError(500, PULL_BATCH_ERROR_CODES.STAMP_INVALID, 'the pull-batch ledger was handed a malformed input; nothing was written', { field, partial: false })
}

function settingsInvalid(field) {
  return pullBatchError(400, PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 'the pull-batch settings request is not valid; nothing was written', { field })
}

function versionConflict() {
  return pullBatchError(409, SETTINGS_VERSION_CONFLICT_CODE, 'the pull-batch settings changed since they were read; reload and try again', {})
}

function stateMoved(reason) {
  return pullBatchError(409, STATE_MOVED_CODE, 'the project\'s pull batch moved since it was read; preview again', { reason })
}

function notReady(reason) {
  return pullBatchError(409, PULL_BATCH_ERROR_CODES.NOT_READY, 'this sheet\'s batch history is not resolved; nothing was created', { reason, partial: false })
}

function installInProgress() {
  return pullBatchError(409, PULL_BATCH_ERROR_CODES.INSTALL_IN_PROGRESS, 'the batch history of this sheet is being installed; pull again after it finishes', { partial: false })
}

function planChanged(reason) {
  return pullBatchError(409, PULL_BATCH_ERROR_CODES.PLAN_CHANGED, 'the persisted pull-batch plan moved since it was previewed; preview again', { reason, partial: false })
}

// A typed refusal (this module's, the pure module's, or the holder assert's: anything carrying an HTTP status and a
// closed code) passes through; a unique violation is the arbitration of last resort (409); anything else is 503.
function isTypedRefusal(error) {
  return Boolean(error) && Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)
}

function translate(error, operation) {
  if (isTypedRefusal(error)) return error
  if (error && error.code === '23505') return conflict('unique_violation', error)
  return storeFailed(operation, error)
}

function normalizeScope(input = {}) {
  if (!isPlainObject(input)) throw inputInvalid('scope')
  for (const field of ['tenantId', 'sheetId', 'projectNo']) {
    if (!nonBlankString(input[field])) throw inputInvalid(field)
  }
  return Object.freeze({ tenantId: input.tenantId.trim(), sheetId: input.sheetId.trim(), projectNo: input.projectNo.trim() })
}

function normalizeTenant(input = {}) {
  if (!isPlainObject(input) || !nonBlankString(input.tenantId)) throw inputInvalid('tenantId')
  return input.tenantId.trim()
}

// An applied placement / landing: null / undefined => NULL; otherwise a value of the closed vocabulary (else 500).
function appliedSettingOf(value, key) {
  if (value === undefined || value === null) return null
  if (!PULL_BATCH_SETTING_VALUES[key].includes(value)) throw inputInvalid(key === 'placement' ? 'bandPlacement' : 'landingMode')
  return value
}

function sheetWhere(scope) {
  return { sheet_id: scope.sheetId, project_no: scope.projectNo }
}

function assertRowInScope(row, scope) {
  if (!row) return row
  if (row.tenant_id !== scope.tenantId || row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) {
    throw conflict('scope_mismatch')
  }
  return row
}

function assertExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw settingsInvalid('expectedVersion')
  return value
}

/**
 * The settings patch (ruling C2): a plain object, at least one key, every key in `allowedKeys`, every value accepted
 * by the pure module's normalizer (strict equality: no trim, no case folding). The refusal names the field only,
 * never the value. Answers a frozen object of exactly the patched keys.
 */
function normalizeSettingsPatch(patch, allowedKeys) {
  if (!isPlainObject(patch)) throw settingsInvalid('patch')
  const keys = Object.keys(patch)
  if (keys.length === 0) throw settingsInvalid('patch')
  for (const key of keys) {
    if (!allowedKeys.includes(key)) throw settingsInvalid(key)
  }
  // The pure module's ONE reader of a configuration validates every value against its closed vocabulary.
  const normalized = normalizePullBatchConfig(patch)
  const out = {}
  for (const key of keys) {
    if (!PULL_BATCH_SETTING_VALUES[key].includes(normalized[key])) throw settingsInvalid(key)
    out[key] = normalized[key]
  }
  return Object.freeze(out)
}

function settingsOfRow(row, keys = PULL_BATCH_SETTING_KEYS) {
  const out = {}
  for (const key of keys) out[key] = row[PULL_BATCH_SETTING_COLUMNS[key]] === undefined ? null : row[PULL_BATCH_SETTING_COLUMNS[key]]
  return out
}

// Flat depth-1 audit detail of enum tokens (ruling C8): { <key>Before, <key>After, version }.
function settingsAuditDetail(before, after, keys, version) {
  const detail = {}
  for (const key of keys) {
    detail[`${key}Before`] = before[key] === null || before[key] === undefined ? 'unset' : before[key]
    detail[`${key}After`] = after[key]
  }
  detail.version = version
  return detail
}

// ── projections ───────────────────────────────────────────────────────────────────────────────────

function rowToSheet(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    historyStatus: row.history_status,
    labelLocale: row.label_locale,
    firstPullBatchRule: row.first_pull_batch_rule,
    labelFormat: row.label_format,
    bandPlacement: row.band_placement || null,
    landingMode: row.landing_mode || null,
    settingsLockedAt: isoOrNull(row.settings_locked_at),
    historyMode: row.history_mode || null,
    historyBatchCount: intOrNull(row.history_batch_count),
    historyPlan: jsonOrNull(row.history_plan),
    historyPlanDigest: row.history_plan_digest || null,
    approvalRef: row.approval_ref || null,
    installedAt: isoOrNull(row.installed_at),
    resolvedAt: isoOrNull(row.resolved_at),
    version: intOrNull(row.version),
  })
}

function rowToBatch(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    batchNo: intOrNull(row.batch_no),
    origin: row.origin,
    status: row.status,
    label: row.label,
    displayDay: dayOrNull(row.display_day),
    sourceDigest: row.source_digest || null,
    evidence: row.evidence || null,
    openedAt: isoOrNull(row.opened_at),
    closedAt: isoOrNull(row.closed_at),
    closedReason: row.closed_reason || null,
  })
}

function rowToLink(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    batchId: row.batch_id,
    executionRef: row.execution_ref,
    lane: row.lane,
    refreshExecutionId: row.refresh_execution_id || null,
    joinedAt: isoOrNull(row.joined_at),
    finishedAt: isoOrNull(row.finished_at),
    writerStatus: row.writer_status || null,
    verifiedOutcome: row.verified_outcome || null,
    createdRowCount: intOrNull(row.created_row_count),
  })
}

// The lock state the pure module's lock helper judges (ruling C2), read from the LOCKED `_sheet` row.
function lockStateOfRow(row) {
  return Object.freeze({
    hasStamped: isSet(row.settings_locked_at),
    landingApplied: isSet(row.landing_mode),
    placementApplied: isSet(row.band_placement),
  })
}

function sheetSettingsRowOf(row) {
  const locks = lockStateOfRow(row)
  return Object.freeze({
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    historyStatus: row.history_status,
    labelLocale: row.label_locale,
    captured: Object.freeze(settingsOfRow(row)),
    locks: Object.freeze({
      firstPullBatchRule: locks.hasStamped,
      labelFormat: locks.hasStamped,
      landing: locks.landingApplied,
      placement: locks.placementApplied,
    }),
    lockedAt: isoOrNull(row.settings_locked_at),
    version: intOrNull(row.version),
  })
}

// The labels a persisted history plan writes (ruling C7): every cluster label, plus 历史批次未知 in both locales
// (unplaced rows and unknown-mode installs write it). Null when the plan is unreadable — the caller then keeps the lock.
function labelsOfPersistedPlan(plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.clusters)) return null
  const labels = new Set(Object.values(PULL_BATCH_UNKNOWN_LABELS))
  for (const cluster of plan.clusters) {
    if (!isPlainObject(cluster) || !nonBlankString(cluster.label)) return null
    labels.add(cluster.label)
  }
  return labels
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────────

function createStockPreparationPullBatchStore({ db, idGenerator, now } = {}) {
  if (!db || typeof db.select !== 'function' || typeof db.selectOne !== 'function' || typeof db.insertOne !== 'function'
    || typeof db.updateRow !== 'function' || typeof db.transaction !== 'function') {
    throw new Error('createStockPreparationPullBatchStore: scoped db helper (select/selectOne/insertOne/updateRow/transaction) is required')
  }
  const clock = typeof now === 'function' ? now : () => new Date()
  const newId = typeof idGenerator === 'function'
    ? idGenerator
    : (kind) => `${ID_PREFIX[kind]}${crypto.randomBytes(16).toString('hex')}`
  const nowDate = () => {
    const value = clock()
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? new Date() : date
  }

  function requireTrx(trx) {
    if (!trx || typeof trx.selectOneForUpdate !== 'function' || typeof trx.select !== 'function' || typeof trx.selectOne !== 'function'
      || typeof trx.insertOne !== 'function' || typeof trx.updateRow !== 'function') {
      throw pullBatchError(500, PULL_BATCH_ERROR_CODES.STORE_FAILED, 'the pull-batch ledger needs the scoped db transaction handle', { operation: 'transaction_handle', partial: false })
    }
    return trx
  }

  async function selectAll(handle, table, where, { orderBy = ['id', 'ASC'], ceiling, operation }) {
    let rows
    try {
      rows = rowsOf(await handle.select(table, { where, orderBy, limit: ceiling + 1 }))
    } catch (error) {
      throw translate(error, operation)
    }
    if (rows.length > ceiling) throw storeFailed(operation, null, { reason: 'row_cap', ceiling })
    return rows
  }

  // A holder refusal inside a transaction must roll it back AND be told apart from a ledger failure by `finish`
  // (which turns it into a logged no-op). The hook's own typed error is kept and marked.
  async function runHolder(holderWithin, trx) {
    if (holderWithin === undefined || holderWithin === null) return
    if (typeof holderWithin !== 'function') throw inputInvalid('holderWithin')
    try {
      await holderWithin(trx)
    } catch (error) {
      const refusal = isTypedRefusal(error) ? error : storeFailed('holder', error)
      refusal.pullBatchHolderRefused = true
      throw refusal
    }
  }

  async function runAudit(auditWithin, trx, entry) {
    if (auditWithin === undefined || auditWithin === null) return
    if (typeof auditWithin !== 'function') throw inputInvalid('auditWithin')
    await auditWithin(trx, Object.freeze({ ...entry, detail: Object.freeze({ ...entry.detail }) }))
  }

  /**
   * The readability probe (design §8.1 step 10, §9 step 1): one bounded SELECT per table. A missing table (a deploy
   * without migration 105) or a refused grant is 503 STORE_FAILED { operation: 'probe', table }.
   */
  async function probeReadable() {
    for (const [name, table] of Object.entries(PULL_BATCH_TABLES)) {
      try {
        await db.select(table, { limit: 1 })
      } catch (error) {
        throw storeFailed('probe', error, { table: name })
      }
    }
    return Object.freeze({ readable: true })
  }

  /**
   * The ONE ledger read a lane makes (design §6.1 step 3): the `_sheet` row (with its captured settings, lock and
   * version) and the project's batches (every status, ascending batch_no). Throws 503 on any failure; a row of another
   * tenant is a 409 (never "absent").
   */
  async function readSheetState(input = {}) {
    const scope = normalizeScope(input)
    let sheet
    try {
      sheet = await db.selectOne(PULL_BATCH_TABLES.sheet, sheetWhere(scope))
    } catch (error) {
      throw translate(error, 'read_sheet')
    }
    assertRowInScope(sheet, scope)
    const batches = await selectAll(db, PULL_BATCH_TABLES.batch, sheetWhere(scope), { orderBy: ['batch_no', 'ASC'], ceiling: READ_CEILING_BATCHES, operation: 'read_batches' })
    for (const row of batches) assertRowInScope(row, scope)
    return Object.freeze({ sheet: rowToSheet(sheet), batches: Object.freeze(batches.map(rowToBatch)) })
  }

  function normalizeAllocation(input) {
    const scope = normalizeScope(input)
    if (!nonBlankString(input.executionRef) || !EXECUTION_REF_PATTERN.test(input.executionRef)) throw inputInvalid('executionRef')
    if (!PULL_BATCH_LANES.includes(input.lane)) throw inputInvalid('lane')
    if (typeof input.sourceDigest !== 'string' || !PULL_BATCH_SOURCE_DIGEST_PATTERN.test(input.sourceDigest)) throw inputInvalid('sourceDigest')
    if (!(input.labelsOnSheet instanceof Set)) throw inputInvalid('labelsOnSheet')
    if (!PULL_BATCH_VOID_REUSE_MODES.includes(input.voidReuse)) throw inputInvalid('voidReuse')
    if (!PULL_BATCH_SETTING_VALUES.firstPullBatchRule.includes(input.expectedRule)) throw inputInvalid('expectedRule')
    const refreshExecutionId = input.refreshExecutionId === undefined || input.refreshExecutionId === null ? null : input.refreshExecutionId
    if (refreshExecutionId !== null && !nonBlankString(refreshExecutionId)) throw inputInvalid('refreshExecutionId')
    return {
      scope,
      executionRef: input.executionRef,
      lane: input.lane,
      sourceDigest: input.sourceDigest,
      labelsOnSheet: input.labelsOnSheet,
      voidReuse: input.voidReuse,
      expectedRule: input.expectedRule,
      refreshExecutionId,
      holderWithin: input.holderWithin,
    }
  }

  function answer(batchRow, { joined, linkReused = false }) {
    return Object.freeze({
      batchId: batchRow.id,
      batchNo: intOrNull(batchRow.batch_no),
      label: batchRow.label,
      joined: joined === true,
      linkReused: linkReused === true,
    })
  }

  /**
   * allocate() — ONE plugin-db transaction (design §3.5), called by the writer's create leg before the first create
   * that carries the label (lazy: a run that creates nothing never calls it, A03):
   *   0. main: the injected holder assert FIRST (lease row FOR UPDATE, lease id + epoch compared); a refusal writes
   *      nothing and keeps its own typed code (LEASE_LOST / WRITE_LOCKED).
   *   1. the `_sheet` row FOR UPDATE: absent / unresolved => 409 NOT_READY; installing => 409 INSTALL_IN_PROGRESS;
   *      `expectedRule` differs from the row's captured rule => 409 CONFLICT `settings_changed` (the lane's carry map
   *      was built under another rule).
   *   2. a link for this execution => its batch, if still open (large chunks, resume, takeover); else 409
   *      EXECUTION_CLOSED.
   *   3. the project's open batch: same digest => JOIN; different digest => void it (number kept for reuse) when
   *      voidReuse is 'in_lease' and no row of the in-lease read carries its label, else close it
   *      `superseded_by_new_source`.
   *   4. a new batch: n = the voided number ?? max(max non-void batch_no, history_batch_count) + 1; the label is
   *      formatted HERE from the locked row's `label_format` and `label_locale` and the process-local day.
   *   5. whenever 2-4 hand a batch out: `settings_locked_at = now()` if still NULL (version + 1), same transaction.
   * A unique violation rolls everything back: 409 CONFLICT, nothing written.
   */
  async function allocate(input = {}) {
    const request = normalizeAllocation(input)
    const { scope } = request
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        await runHolder(request.holderWithin, trx)
        const at = nowDate()
        const atIso = at.toISOString()
        const sheet = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.sheet, sheetWhere(scope)), scope)
        if (!sheet) throw notReady('sheet_absent')
        if (sheet.history_status === 'installing') throw installInProgress()
        if (!PULL_BATCH_RESOLVED_HISTORY_STATUSES.includes(sheet.history_status)) throw notReady('history_pending')
        if (sheet.first_pull_batch_rule !== request.expectedRule) throw conflict('settings_changed')

        // Step 5: the caller is about to stamp with the label it gets back — from this commit the sheet's rule and
        // format are fixed. Conditional on NULL, so a re-entry never moves the first lock time.
        const lockSettings = async () => {
          if (isSet(sheet.settings_locked_at)) return
          const locked = rowsOf(await trx.updateRow(
            PULL_BATCH_TABLES.sheet,
            { settings_locked_at: atIso, version: (intOrNull(sheet.version) || 0) + 1, updated_at: atIso },
            { id: sheet.id, settings_locked_at: null },
          ))
          if (locked.length !== 1) throw conflict('settings_lock_moved')
        }

        const existingLink = await trx.selectOne(PULL_BATCH_TABLES.execution, { execution_ref: request.executionRef })
        if (existingLink) {
          assertRowInScope(existingLink, scope)
          const linked = await trx.selectOne(PULL_BATCH_TABLES.batch, { id: existingLink.batch_id })
          if (linked && linked.status === 'open') {
            assertRowInScope(linked, scope)
            await lockSettings()
            return answer(linked, { joined: true, linkReused: true })
          }
          throw pullBatchError(409, PULL_BATCH_ERROR_CODES.EXECUTION_CLOSED, 'the batch this execution opened is no longer open; plan again', { partial: false })
        }

        const insertLink = async (batchRow) => {
          await trx.insertOne(PULL_BATCH_TABLES.execution, {
            id: newId('execution'),
            batch_id: batchRow.id,
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            execution_ref: request.executionRef,
            lane: request.lane,
            refresh_execution_id: request.refreshExecutionId,
            joined_at: atIso,
            finished_at: null,
            writer_status: null,
            verified_outcome: null,
            created_row_count: null,
          })
        }

        const openRows = rowsOf(await trx.select(PULL_BATCH_TABLES.batch, { where: { ...sheetWhere(scope), status: 'open' }, orderBy: ['batch_no', 'ASC'], limit: 2 }))
        if (openRows.length > 1) throw conflict('open_batches_ambiguous')
        let reusedNo = null
        if (openRows.length === 1) {
          const open = assertRowInScope(openRows[0], scope)
          if (open.source_digest === request.sourceDigest) {
            await insertLink(open)
            await lockSettings()
            return answer(open, { joined: true })
          }
          const voidable = request.voidReuse === 'in_lease' && !request.labelsOnSheet.has(open.label)
          const moved = rowsOf(await trx.updateRow(
            PULL_BATCH_TABLES.batch,
            voidable
              ? { status: 'void', closed_at: atIso, closed_reason: 'void_no_rows', updated_at: atIso }
              : { status: 'closed', closed_at: atIso, closed_reason: 'superseded_by_new_source', updated_at: atIso },
            { id: open.id, status: 'open' },
          ))
          if (moved.length !== 1) throw conflict('open_batch_moved')
          if (voidable) reusedNo = intOrNull(open.batch_no)
        }

        let batchNo = reusedNo
        if (batchNo === null) {
          const all = await selectAll(trx, PULL_BATCH_TABLES.batch, sheetWhere(scope), { orderBy: ['batch_no', 'ASC'], ceiling: READ_CEILING_BATCHES, operation: 'allocate' })
          let maxNo = 0
          for (const row of all) {
            if (row.status === 'void') continue
            const n = intOrNull(row.batch_no)
            if (n !== null && n > maxNo) maxNo = n
          }
          const floor = intOrNull(sheet.history_batch_count) || 0
          batchNo = Math.max(maxNo, floor) + 1
        }
        const day = pullBatchLabelDay(at)
        const batchRow = {
          id: newId('batch'),
          tenant_id: scope.tenantId,
          sheet_id: scope.sheetId,
          project_no: scope.projectNo,
          batch_no: batchNo,
          origin: 'live',
          status: 'open',
          label: formatPullBatchLabel({ kind: 'live', n: batchNo, day, locale: sheet.label_locale, labelFormat: sheet.label_format }),
          display_day: day,
          source_digest: request.sourceDigest,
          evidence: null,
          opened_at: atIso,
          closed_at: null,
          closed_reason: null,
          created_at: atIso,
          updated_at: atIso,
        }
        await trx.insertOne(PULL_BATCH_TABLES.batch, batchRow)
        await insertLink(batchRow)
        await lockSettings()
        return answer(batchRow, { joined: false })
      })
    } catch (error) {
      throw translate(error, 'allocate')
    }
  }

  /**
   * finish() — one finisher per link, counts set BY VALUE (design §3.6, S6 C-4). Best effort at the caller.
   *   * a link of this execution, still unfinished => finished (writer status + its own created count); a `succeeded`
   *     writer closes the batch `execution_succeeded` (CAS on status = 'open');
   *   * a link already finished (the step-6 recovery close got there first) => no-op `already_finished`;
   *   * no link (the run allocated nothing) and `succeeded` => an open batch with the SAME digest closes
   *     `completed_by_later_execution`.
   * Main: the holder assert runs first; a refusal makes finish a no-op (`holder_refused`).
   */
  async function finish(input = {}) {
    const scope = normalizeScope(input)
    if (!nonBlankString(input.executionRef) || !EXECUTION_REF_PATTERN.test(input.executionRef)) throw inputInvalid('executionRef')
    if (!PULL_BATCH_WRITER_STATUSES.includes(input.writerStatus)) throw inputInvalid('writerStatus')
    const count = input.createdRowCount === undefined || input.createdRowCount === null ? null : input.createdRowCount
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw inputInvalid('createdRowCount')
    const sourceDigest = input.sourceDigest === undefined || input.sourceDigest === null ? null : input.sourceDigest
    if (sourceDigest !== null && (typeof sourceDigest !== 'string' || !PULL_BATCH_SOURCE_DIGEST_PATTERN.test(sourceDigest))) throw inputInvalid('sourceDigest')
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        await runHolder(input.holderWithin, trx)
        const atIso = nowDate().toISOString()
        const link = await trx.selectOneForUpdate(PULL_BATCH_TABLES.execution, { execution_ref: input.executionRef })
        if (!link) {
          if (input.writerStatus !== 'succeeded' || sourceDigest === null) return Object.freeze({ outcome: 'no_link' })
          const open = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.batch, { ...sheetWhere(scope), status: 'open' }), scope)
          if (!open || open.source_digest !== sourceDigest) return Object.freeze({ outcome: 'no_link' })
          const closed = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.batch, { status: 'closed', closed_at: atIso, closed_reason: 'completed_by_later_execution', updated_at: atIso }, { id: open.id, status: 'open' }))
          return Object.freeze({ outcome: closed.length === 1 ? 'closed_completed_by_later_execution' : 'no_link' })
        }
        assertRowInScope(link, scope)
        if (isSet(link.finished_at)) return Object.freeze({ outcome: 'already_finished' })
        const finished = rowsOf(await trx.updateRow(
          PULL_BATCH_TABLES.execution,
          { finished_at: atIso, writer_status: input.writerStatus, created_row_count: count },
          { execution_ref: input.executionRef, finished_at: null },
        ))
        if (finished.length !== 1) return Object.freeze({ outcome: 'already_finished' })
        if (input.writerStatus !== 'succeeded') return Object.freeze({ outcome: 'finished' })
        const closed = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.batch, { status: 'closed', closed_at: atIso, closed_reason: 'execution_succeeded', updated_at: atIso }, { id: link.batch_id, status: 'open' }))
        return Object.freeze({ outcome: closed.length === 1 ? 'closed' : 'finished' })
      })
    } catch (error) {
      if (error && error.pullBatchHolderRefused === true) return Object.freeze({ outcome: 'holder_refused', code: typeof error.code === 'string' ? error.code : null })
      throw translate(error, 'finish')
    }
  }

  /**
   * S6 C-2 — the link of a governed execution, by its step-4 `exec_` id (values-free). More than one link for one
   * execution is a defect: 409 STATE_MOVED `pull_batch_link_ambiguous`.
   */
  async function readBatchLink(input = {}) {
    const scope = normalizeScope(input)
    if (!nonBlankString(input.refreshExecutionId)) throw inputInvalid('refreshExecutionId')
    let links
    try {
      links = rowsOf(await db.select(PULL_BATCH_TABLES.execution, { where: { refresh_execution_id: input.refreshExecutionId }, orderBy: ['id', 'ASC'], limit: 2 }))
    } catch (error) {
      throw translate(error, 'read_link')
    }
    if (links.length === 0) return Object.freeze({ linked: false })
    if (links.length > 1) throw stateMoved('pull_batch_link_ambiguous')
    const link = assertRowInScope(links[0], scope)
    let batch
    try {
      batch = await db.selectOne(PULL_BATCH_TABLES.batch, { id: link.batch_id })
    } catch (error) {
      throw translate(error, 'read_link')
    }
    assertRowInScope(batch, scope)
    return Object.freeze({
      linked: true,
      batchId: link.batch_id,
      batchNo: batch ? intOrNull(batch.batch_no) : null,
      label: batch ? batch.label : null,
      status: batch ? batch.status : null,
      linkFinished: isSet(link.finished_at),
      linkCreatedRowCount: intOrNull(link.created_row_count),
      sourceDigest: batch ? batch.source_digest || null : null,
    })
  }

  /**
   * S6 C-3 — the recovery close hook, run INSIDE the close transaction (the caller holds the lease and asserted it).
   * Locks the link, then its batch (BI's own link -> batch order), records the outcome token and the link count BY
   * VALUE, and:
   *   landed + linked batch open                 => closed / recovery_verified          ('closed')
   *   landed + closed by this link's own success => no-op                               ('already_closed')
   *   landed + void, or closed by another link   => 409 STATE_MOVED pull_batch_moved (the caller rolls back)
   *   landed + no link                           => a same-digest open batch closes completed_by_later_execution
   *   any other result                           => never closes, never voids           ('kept_open' / 'none')
   */
  async function batchWithin(trx, input = {}) {
    requireTrx(trx)
    const scope = normalizeScope(input.scope || {})
    if (!nonBlankString(input.refreshExecutionId)) throw inputInvalid('refreshExecutionId')
    if (!RECOVERY_RESULTS.includes(input.result)) throw inputInvalid('result')
    if (!Number.isSafeInteger(input.verifiedCreatedRows) || input.verifiedCreatedRows < 0) throw inputInvalid('verifiedCreatedRows')
    const sourceDigest = input.sourceDigest === undefined || input.sourceDigest === null ? null : input.sourceDigest
    if (sourceDigest !== null && (typeof sourceDigest !== 'string' || !PULL_BATCH_SOURCE_DIGEST_PATTERN.test(sourceDigest))) throw inputInvalid('sourceDigest')
    const outcomeToken = RECOVERY_OUTCOME_BY_RESULT[input.result]
    try {
      const atIso = nowDate().toISOString()
      const links = rowsOf(await trx.select(PULL_BATCH_TABLES.execution, { where: { refresh_execution_id: input.refreshExecutionId }, limit: 2 }))
      if (links.length > 1) throw stateMoved('pull_batch_link_ambiguous')
      if (links.length === 0) {
        if (input.result !== 'landed' || sourceDigest === null) return 'none'
        const open = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.batch, { ...sheetWhere(scope), status: 'open' }), scope)
        if (!open || open.source_digest !== sourceDigest) return 'none'
        const closed = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.batch, { status: 'closed', closed_at: atIso, closed_reason: 'completed_by_later_execution', updated_at: atIso }, { id: open.id, status: 'open' }))
        if (closed.length !== 1) throw stateMoved('pull_batch_moved')
        return 'closed'
      }
      const link = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.execution, { id: links[0].id }), scope)
      const batch = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.batch, { id: link.batch_id }), scope)
      const updated = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.execution, {
        finished_at: isSet(link.finished_at) ? link.finished_at : atIso,
        verified_outcome: outcomeToken,
        created_row_count: input.verifiedCreatedRows,
      }, { id: link.id }))
      if (updated.length !== 1) throw stateMoved('pull_batch_moved')
      if (input.result !== 'landed') return 'kept_open'
      if (batch && batch.status === 'open') {
        const closed = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.batch, { status: 'closed', closed_at: atIso, closed_reason: 'recovery_verified', updated_at: atIso }, { id: batch.id, status: 'open' }))
        if (closed.length !== 1) throw stateMoved('pull_batch_moved')
        return 'closed'
      }
      if (batch && batch.status === 'closed' && batch.closed_reason === 'execution_succeeded' && link.writer_status === 'succeeded') return 'already_closed'
      throw stateMoved('pull_batch_moved')
    } catch (error) {
      throw translate(error, 'batch_within')
    }
  }

  /**
   * S6 C-10 — the project's batches, values-free: number, label, status, origin, evidence, opened / closed and the
   * COMPUTED row count (sum of the links' counts) and link count. Paged by batch number (`cursor` = the last number
   * of the previous page).
   */
  async function listBatches(input = {}) {
    const scope = normalizeScope(input.scope || input)
    const limit = input.limit === undefined || input.limit === null ? LIST_DEFAULT_LIMIT : input.limit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) throw inputInvalid('limit')
    const cursor = input.cursor === undefined || input.cursor === null ? 0 : input.cursor
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw inputInvalid('cursor')
    const batches = await selectAll(db, PULL_BATCH_TABLES.batch, sheetWhere(scope), { orderBy: ['batch_no', 'ASC'], ceiling: READ_CEILING_BATCHES, operation: 'list_batches' })
    for (const row of batches) assertRowInScope(row, scope)
    const links = await selectAll(db, PULL_BATCH_TABLES.execution, sheetWhere(scope), { orderBy: ['id', 'ASC'], ceiling: READ_CEILING_LINKS, operation: 'list_batches' })
    const byBatch = new Map()
    for (const link of links) {
      assertRowInScope(link, scope)
      const entry = byBatch.get(link.batch_id) || { createdRowCount: 0, linkCount: 0 }
      entry.linkCount += 1
      entry.createdRowCount += intOrNull(link.created_row_count) || 0
      byBatch.set(link.batch_id, entry)
    }
    // A voided batch keeps its number and the batch that reuses it carries the same one, so the page never splits one
    // batch_no across two pages (the cursor is a number): it extends to the end of the tie. Ties are ordered by id.
    const after = batches
      .filter((row) => (intOrNull(row.batch_no) || 0) > cursor)
      .sort((a, b) => ((intOrNull(a.batch_no) || 0) - (intOrNull(b.batch_no) || 0)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    let take = Math.min(limit, after.length)
    while (take > 0 && take < after.length && intOrNull(after[take].batch_no) === intOrNull(after[take - 1].batch_no)) take += 1
    const page = after
      .slice(0, take)
      .map((row) => {
        const counts = byBatch.get(row.id) || { createdRowCount: 0, linkCount: 0 }
        return Object.freeze({
          batchNo: intOrNull(row.batch_no),
          label: row.label,
          status: row.status,
          origin: row.origin,
          evidence: row.evidence || null,
          openedAt: isoOrNull(row.opened_at),
          closedAt: isoOrNull(row.closed_at),
          createdRowCount: counts.createdRowCount,
          linkCount: counts.linkCount,
        })
      })
    const last = page.length > 0 ? page[page.length - 1].batchNo : null
    const more = last !== null && batches.some((row) => (intOrNull(row.batch_no) || 0) > last)
    return Object.freeze({ batches: Object.freeze(page), nextCursor: more ? last : null })
  }

  // ── settings (owner 2026-11-07; rulings C2, C6, C8) ───────────────────────────────────────────────

  function tenantAnswer(row) {
    if (!row) return Object.freeze({ settings: PULL_BATCH_BUILT_IN_SETTINGS, source: 'built_in', version: 0 })
    return Object.freeze({ settings: Object.freeze(settingsOfRow(row)), source: 'tenant', version: intOrNull(row.version) })
  }

  /** The tenant default: `{ settings, source: 'built_in' | 'tenant', version }` (version 0 when no row). */
  async function readTenantSettings(input = {}) {
    const tenantId = normalizeTenant(input)
    let row
    try {
      row = await db.selectOne(PULL_BATCH_TABLES.settings, { tenant_id: tenantId })
    } catch (error) {
      throw translate(error, 'read_tenant_settings')
    }
    return tenantAnswer(row)
  }

  /** The same read on the caller's transaction (the birth / install capture reads the default it copies). */
  async function readTenantSettingsWithin(trx, input = {}) {
    requireTrx(trx)
    const tenantId = normalizeTenant(input)
    try {
      return tenantAnswer(await trx.selectOne(PULL_BATCH_TABLES.settings, { tenant_id: tenantId }))
    } catch (error) {
      throw translate(error, 'read_tenant_settings')
    }
  }

  /**
   * The tenant default, compare-and-set on `version` (one transaction): the row FOR UPDATE; absent => only
   * `expectedVersion === 0` inserts (a concurrent insert's 23505 => 409 SETTINGS_VERSION_CONFLICT); present => the
   * version must equal `expectedVersion`. Writes the merged values with version + 1, then `auditWithin` on the same
   * transaction; any throw rolls the write back. Answers the new `{ settings, source: 'tenant', version }`.
   */
  async function writeTenantSettings(input = {}) {
    const tenantId = normalizeTenant(input)
    const expectedVersion = assertExpectedVersion(input.expectedVersion)
    const patch = normalizeSettingsPatch(input.patch, PULL_BATCH_SETTING_KEYS)
    const patchedKeys = Object.keys(patch)
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        const atIso = nowDate().toISOString()
        const current = await trx.selectOneForUpdate(PULL_BATCH_TABLES.settings, { tenant_id: tenantId })
        const before = current ? settingsOfRow(current) : { ...PULL_BATCH_BUILT_IN_SETTINGS }
        const currentVersion = current ? intOrNull(current.version) : 0
        if (currentVersion !== expectedVersion) throw versionConflict()
        const after = { ...before, ...patch }
        const columns = {}
        for (const key of PULL_BATCH_SETTING_KEYS) columns[PULL_BATCH_SETTING_COLUMNS[key]] = after[key]
        const nextVersion = expectedVersion + 1
        let written
        if (!current) {
          try {
            written = rowsOf(await trx.insertOne(PULL_BATCH_TABLES.settings, { tenant_id: tenantId, ...columns, version: nextVersion, created_at: atIso, updated_at: atIso }))
          } catch (error) {
            if (error && error.code === '23505') throw versionConflict()
            throw error
          }
        } else {
          written = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.settings, { ...columns, version: nextVersion, updated_at: atIso }, { tenant_id: tenantId, version: expectedVersion }))
          if (written.length !== 1) throw versionConflict()
        }
        await runAudit(input.auditWithin, trx, {
          mode: PULL_BATCH_STORE_AUDIT.modes.tenantSettingsUpdated,
          subjectId: null,
          detail: settingsAuditDetail(before, after, patchedKeys, nextVersion),
        })
        return tenantAnswer(written[0] || { ...columns, version: nextVersion })
      })
    } catch (error) {
      throw translate(error, 'write_tenant_settings')
    }
  }

  /**
   * The per-sheet edit of a CAPTURED setting (rule / format only), one transaction: the `_sheet` row FOR UPDATE (the
   * same row lock `allocate` takes first, so the two serialize); no row => 409 SETTINGS_NOT_CAPTURED; the pure
   * module's lock helper over { hasStamped, landingApplied, placementApplied } => 409 CONFIG_LOCKED { locked }; the
   * version CAS => 409 SETTINGS_VERSION_CONFLICT; write (version + 1); `auditWithin` on the same transaction.
   */
  async function setSheetSettings(input = {}) {
    const scope = normalizeScope(input)
    const expectedVersion = assertExpectedVersion(input.expectedVersion)
    const patch = normalizeSettingsPatch(input.patch, PULL_BATCH_SHEET_SETTING_KEYS)
    const patchedKeys = Object.keys(patch)
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        const atIso = nowDate().toISOString()
        const sheet = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.sheet, sheetWhere(scope)), scope)
        if (!sheet) throw pullBatchError(409, SETTINGS_NOT_CAPTURED_CODE, 'this sheet has not captured its pull-batch settings yet; set the tenant default instead', {})
        const before = settingsOfRow(sheet)
        const state = lockStateOfRow(sheet)
        // The helper judges the captured values it is handed; landing / placement are NULL until applied, so only the
        // keys the row actually carries are passed (a NULL is "not captured", never a value).
        const captured = Object.fromEntries(Object.entries(before).filter(([, value]) => isSet(value)))
        const refused = refusedPullBatchConfigEdits({ captured, edit: { ...patch }, state })
        if (refused.length > 0) {
          throw pullBatchError(409, PULL_BATCH_ERROR_CODES.CONFIG_LOCKED, 'these settings are locked because the sheet already carries batch labels', { locked: Array.from(refused) })
        }
        if (intOrNull(sheet.version) !== expectedVersion) throw versionConflict()
        const after = { ...before, ...patch }
        const set = { updated_at: atIso, version: expectedVersion + 1 }
        for (const key of patchedKeys) set[PULL_BATCH_SETTING_COLUMNS[key]] = patch[key]
        const written = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.sheet, set, { id: sheet.id, version: expectedVersion }))
        if (written.length !== 1) throw versionConflict()
        await runAudit(input.auditWithin, trx, {
          mode: PULL_BATCH_STORE_AUDIT.modes.sheetSettingsUpdated,
          subjectId: scope.sheetId,
          projectNo: scope.projectNo,
          detail: settingsAuditDetail(before, after, patchedKeys, expectedVersion + 1),
        })
        return sheetSettingsRowOf(written[0])
      })
    } catch (error) {
      throw translate(error, 'set_sheet_settings')
    }
  }

  /** The tenant's sheet rows as ADMIN rows (projectNo is a customer value, the 087 precedent; never audit / evidence). */
  async function listSheetSettings(input = {}) {
    const tenantId = normalizeTenant(input)
    const rows = await selectAll(db, PULL_BATCH_TABLES.sheet, { tenant_id: tenantId }, { orderBy: ['id', 'ASC'], ceiling: READ_CEILING_SHEETS, operation: 'list_sheet_settings' })
    return Object.freeze(rows.map(sheetSettingsRowOf))
  }

  /**
   * THE CAPTURE PRIMITIVE (BI-2 calls it at birth / install; the suites build fixtures with it): inserts the `_sheet`
   * row on the caller's transaction with the CAPTURED rule and format (validated against the closed sets) and the
   * label locale. `band_placement` / `landing_mode` stay NULL (the steps that apply them set them); the lock stays NULL.
   *   historyStatus 'pending'    — an existing sheet awaiting its owner-gated install
   *   historyStatus 'born_empty' — a sheet born with the switch on: resolved now, count 0, mode 'inferred'
   */
  async function createSheetRowWithin(trx, input = {}) {
    requireTrx(trx)
    const scope = normalizeScope(input)
    if (!['pending', 'born_empty'].includes(input.historyStatus)) throw inputInvalid('historyStatus')
    if (!PULL_BATCH_LOCALES.includes(input.labelLocale)) throw inputInvalid('labelLocale')
    const settings = isPlainObject(input.settings) ? input.settings : null
    if (!settings) throw inputInvalid('settings')
    for (const key of PULL_BATCH_SHEET_SETTING_KEYS) {
      if (!PULL_BATCH_SETTING_VALUES[key].includes(settings[key])) throw inputInvalid(`settings.${key}`)
    }
    // BI-2: a sheet born ready records the placement / landing its birth APPLIED (optional; absent => NULL, every
    // existing caller byte-identical).
    const bandPlacement = appliedSettingOf(input.bandPlacement, 'placement')
    const landingMode = appliedSettingOf(input.landingMode, 'landing')
    const atIso = nowDate().toISOString()
    const born = input.historyStatus === 'born_empty'
    const row = {
      id: newId('sheet'),
      tenant_id: scope.tenantId,
      sheet_id: scope.sheetId,
      project_no: scope.projectNo,
      history_status: input.historyStatus,
      label_locale: input.labelLocale,
      first_pull_batch_rule: settings.firstPullBatchRule,
      label_format: settings.labelFormat,
      band_placement: bandPlacement,
      landing_mode: landingMode,
      settings_locked_at: null,
      history_mode: born ? 'inferred' : null,
      history_batch_count: born ? 0 : null,
      history_plan: null,
      history_plan_digest: null,
      approval_ref: null,
      installed_at: null,
      installed_by: null,
      resolved_at: born ? atIso : null,
      resolved_by: born && nonBlankString(input.resolvedBy) ? input.resolvedBy.trim() : null,
      version: 0,
      created_at: atIso,
      updated_at: atIso,
    }
    try {
      return rowToSheet(rowsOf(await trx.insertOne(PULL_BATCH_TABLES.sheet, row))[0] || row)
    } catch (error) {
      throw translate(error, 'create_sheet_row')
    }
  }

  /**
   * abort of an install (design §8.2 `abort`; ruling C7), one transaction: holder first (main); the `_sheet` row FOR
   * UPDATE must be `installing`.
   *   FIRST install (never resolved: resolved_at IS NULL) => `pending`. `settings_locked_at` is CLEARED iff the
   *     persisted plan is readable, no label of it is in `labelsOnSheet` (the caller's full read of both band columns)
   *     and the project has NO live batch row (any status) — the permanence rule: a plan with no label on the sheet
   *     may be replaced, so its settings may be re-chosen. Otherwise the lock stays.
   *   gap pass (resolved before) => back to the previous resolved status the plan recorded
   *     (`history_plan.previousHistoryStatus`); the lock always stays.
   * The plan is kept (flagged `aborted: true`). `auditWithin` gets mode `pull_batch_install_aborted`.
   */
  async function abortInstall(input = {}) {
    const scope = normalizeScope(input)
    if (!(input.labelsOnSheet instanceof Set)) throw inputInvalid('labelsOnSheet')
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        await runHolder(input.holderWithin, trx)
        const atIso = nowDate().toISOString()
        const sheet = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.sheet, sheetWhere(scope)), scope)
        if (!sheet) throw notReady('sheet_absent')
        if (sheet.history_status !== 'installing') throw conflict('not_installing')
        const plan = jsonOrNull(sheet.history_plan)
        const firstInstall = !isSet(sheet.resolved_at)
        let nextStatus = 'pending'
        let release = false
        if (firstInstall) {
          const planLabels = labelsOfPersistedPlan(plan)
          let labelled = planLabels === null
          if (!labelled) {
            for (const label of planLabels) {
              if (input.labelsOnSheet.has(label)) { labelled = true; break }
            }
          }
          const live = rowsOf(await trx.select(PULL_BATCH_TABLES.batch, { where: { ...sheetWhere(scope), origin: 'live' }, limit: 1 }))
          release = !labelled && live.length === 0
        } else {
          const previous = isPlainObject(plan) ? plan.previousHistoryStatus : undefined
          if (!PULL_BATCH_RESOLVED_HISTORY_STATUSES.includes(previous)) throw conflict('previous_status_unknown')
          nextStatus = previous
        }
        const nextVersion = (intOrNull(sheet.version) || 0) + 1
        const set = {
          history_status: nextStatus,
          history_plan: isPlainObject(plan) ? { ...plan, aborted: true } : plan,
          version: nextVersion,
          updated_at: atIso,
        }
        if (release) set.settings_locked_at = null
        const written = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.sheet, set, { id: sheet.id, history_status: 'installing' }))
        if (written.length !== 1) throw conflict('install_moved')
        await runAudit(input.auditWithin, trx, {
          mode: PULL_BATCH_STORE_AUDIT.modes.installAborted,
          subjectId: scope.sheetId,
          projectNo: scope.projectNo,
          detail: { firstInstall, settingsReleased: release, historyStatus: nextStatus, version: nextVersion },
        })
        return Object.freeze({ historyStatus: nextStatus, firstInstall, settingsReleased: release, version: nextVersion })
      })
    } catch (error) {
      throw translate(error, 'abort_install')
    }
  }

  // ── the per-sheet install (BI-2; design §8.2, §9) ─────────────────────────────────────────────────────────
  // Five transactions, each with the holder assert FIRST (main) and its audit row inside (ruling C8, P2-12). The plan
  // they persist is the pure module's install envelope; the store never re-plans, it only CASes digests.

  function normalizeCapture(capture) {
    if (!isPlainObject(capture)) throw inputInvalid('capture')
    for (const key of PULL_BATCH_SHEET_SETTING_KEYS) {
      if (!PULL_BATCH_SETTING_VALUES[key].includes(capture[key])) throw inputInvalid(`capture.${key}`)
    }
    return Object.freeze({ firstPullBatchRule: capture.firstPullBatchRule, labelFormat: capture.labelFormat })
  }

  function assertPlanDigest(value, field = 'planDigest') {
    if (typeof value !== 'string' || !INSTALL_PLAN_DIGEST_PATTERN.test(value)) throw inputInvalid(field)
    return value
  }

  function assertHistoryMode(value) {
    if (!INSTALL_HISTORY_MODES.includes(value)) throw inputInvalid('historyMode')
    return value
  }

  function auditDetailOf(detail, version) {
    return { ...(isPlainObject(detail) ? detail : {}), version }
  }

  /**
   * A NEW project sheet born ready (design §9; P2-7), one transaction: the `_sheet` row FOR UPDATE; present => no
   * write, no audit (`{ created: false, historyStatus }`); absent => the capture primitive as `born_empty` with the
   * placement / landing the birth applied, and the audit row `pull_batch_born_ready`. A concurrent insert (23505) =>
   * `{ created: false, reason: 'race' }`.
   */
  async function bornReady(input = {}) {
    const scope = normalizeScope(input)
    const capture = normalizeCapture(input.capture)
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        const present = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.sheet, sheetWhere(scope)), scope)
        if (present) return Object.freeze({ created: false, historyStatus: present.history_status, reason: 'present' })
        const sheet = await createSheetRowWithin(trx, {
          ...scope,
          historyStatus: 'born_empty',
          labelLocale: input.labelLocale,
          settings: capture,
          bandPlacement: input.bandPlacement,
          landingMode: input.landingMode,
          resolvedBy: input.resolvedBy,
        })
        await runAudit(input.auditWithin, trx, {
          mode: PULL_BATCH_STORE_AUDIT.modes.bornReady,
          subjectId: scope.sheetId,
          projectNo: scope.projectNo,
          detail: auditDetailOf(input.auditDetail, sheet.version),
        })
        return Object.freeze({ created: true, historyStatus: 'born_empty', reason: null })
      })
    } catch (error) {
      if (error && (error.code === '23505' || (error.details && error.details.sqlState === '23505'))) {
        return Object.freeze({ created: false, historyStatus: null, reason: 'race' })
      }
      throw translate(error, 'born_ready')
    }
  }

  /**
   * Txn A of an install (design §8.2 I3): PERSIST THE PLAN before the first cell write. One transaction: holder FIRST;
   * the `_sheet` row FOR UPDATE must match `expect` ({ historyStatus: null (absent) | pending | born_empty |
   * backfilled, version }) else 409 CONFLICT `install_moved`.
   *   absent  => the tenant default read WITHIN must still be the captured rule / format (else 409 PLAN_CHANGED
   *              `settings_changed`); the row is inserted directly as `installing`.
   *   present => its captured rule / format / locale must equal the plan's (PLAN_CHANGED `settings_changed`); an
   *              applied placement / landing that differs is 409 CONFIG_LOCKED { locked } (the pure lock helper); CAS
   *              on { id, version }.
   * Writes `installing`, the envelope (+ historyMode; a resolved row's status as `previousHistoryStatus`, for abort), its
   * digest, the applied placement / landing, `settings_locked_at = COALESCE(lock, now)`, approval / installed. The
   * `history_mode` COLUMN is untouched (P2-18). Audit `pull_batch_install_started`.
   */
  async function beginInstall(input = {}) {
    const scope = normalizeScope(input)
    const expect = isPlainObject(input.expect) ? input.expect : null
    if (!expect || !(expect.historyStatus === null || INSTALL_EXPECTABLE_STATUSES.includes(expect.historyStatus))) throw inputInvalid('expect')
    if (expect.historyStatus !== null && !(Number.isSafeInteger(expect.version) && expect.version >= 0)) throw inputInvalid('expect')
    if (!isPlainObject(input.plan)) throw inputInvalid('plan')
    const planDigest = assertPlanDigest(input.planDigest)
    if (input.plan.digest !== planDigest) throw inputInvalid('planDigest')
    if (!PULL_BATCH_LOCALES.includes(input.labelLocale)) throw inputInvalid('labelLocale')
    const capture = normalizeCapture(input.capture)
    const bandPlacement = appliedSettingOf(input.bandPlacement, 'placement')
    const landingMode = appliedSettingOf(input.landingMode, 'landing')
    if (bandPlacement === null || landingMode === null) throw inputInvalid(bandPlacement === null ? 'bandPlacement' : 'landingMode')
    const historyMode = assertHistoryMode(input.historyMode)
    if (!nonBlankString(input.approvalRef)) throw inputInvalid('approvalRef')
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        await runHolder(input.holderWithin, trx)
        const atIso = nowDate().toISOString()
        const sheet = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.sheet, sheetWhere(scope)), scope)
        if (expect.historyStatus === null ? Boolean(sheet) : (!sheet || sheet.history_status !== expect.historyStatus || intOrNull(sheet.version) !== expect.version)) {
          throw conflict('install_moved')
        }
        // A resumed aborted plan is installing again: its `aborted` flag never survives into the new run.
        const plan = { ...input.plan, historyMode }
        delete plan.aborted
        const common = {
          history_status: 'installing',
          history_plan: plan,
          history_plan_digest: planDigest,
          band_placement: bandPlacement,
          landing_mode: landingMode,
          approval_ref: input.approvalRef.trim(),
          installed_at: atIso,
          installed_by: nonBlankString(input.installedBy) ? input.installedBy.trim() : null,
          updated_at: atIso,
        }
        let written
        if (!sheet) {
          const tenant = await readTenantSettingsWithin(trx, { tenantId: scope.tenantId })
          if (tenant.settings.firstPullBatchRule !== capture.firstPullBatchRule || tenant.settings.labelFormat !== capture.labelFormat) throw planChanged('settings_changed')
          delete plan.previousHistoryStatus
          written = rowsOf(await trx.insertOne(PULL_BATCH_TABLES.sheet, {
            id: newId('sheet'),
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            label_locale: input.labelLocale,
            first_pull_batch_rule: capture.firstPullBatchRule,
            label_format: capture.labelFormat,
            settings_locked_at: atIso,
            history_mode: null,
            history_batch_count: null,
            resolved_at: null,
            resolved_by: null,
            version: 1,
            created_at: atIso,
            ...common,
          }))
        } else {
          if (sheet.first_pull_batch_rule !== capture.firstPullBatchRule || sheet.label_format !== capture.labelFormat || sheet.label_locale !== input.labelLocale) {
            throw planChanged('settings_changed')
          }
          const applied = {}
          if (isSet(sheet.band_placement)) applied.placement = sheet.band_placement
          if (isSet(sheet.landing_mode)) applied.landing = sheet.landing_mode
          const refused = refusedPullBatchConfigEdits({ captured: applied, edit: { placement: bandPlacement, landing: landingMode }, state: lockStateOfRow(sheet) })
          if (refused.length > 0) {
            throw pullBatchError(409, PULL_BATCH_ERROR_CODES.CONFIG_LOCKED, 'the placement or landing of this sheet was already applied; it cannot change', { locked: Array.from(refused) })
          }
          if (isSet(sheet.resolved_at)) plan.previousHistoryStatus = sheet.history_status
          else delete plan.previousHistoryStatus
          const version = intOrNull(sheet.version) || 0
          written = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.sheet, {
            ...common,
            settings_locked_at: isSet(sheet.settings_locked_at) ? sheet.settings_locked_at : atIso,
            version: version + 1,
          }, { id: sheet.id, version }))
          if (written.length !== 1) throw conflict('install_moved')
        }
        const row = written[0]
        await runAudit(input.auditWithin, trx, {
          mode: PULL_BATCH_STORE_AUDIT.modes.installStarted,
          subjectId: scope.sheetId,
          projectNo: scope.projectNo,
          detail: auditDetailOf(input.auditDetail, intOrNull(row.version)),
        })
        return rowToSheet(row)
      })
    } catch (error) {
      throw translate(error, 'begin_install')
    }
  }

  // The `installing` row of a re-run, FOR UPDATE, with its persisted digest checked.
  async function lockInstallingRow(trx, scope, digest) {
    const sheet = assertRowInScope(await trx.selectOneForUpdate(PULL_BATCH_TABLES.sheet, sheetWhere(scope)), scope)
    if (!sheet) throw notReady('sheet_absent')
    if (sheet.history_status !== 'installing') throw conflict('not_installing')
    if (sheet.history_plan_digest !== digest) throw planChanged('persisted_plan_differs')
    return sheet
  }

  /**
   * A re-run of an `installing` sheet (design §8.2 I3, last bullet): nothing is recomputed. Holder FIRST; the row must
   * be `installing` with the persisted digest (409 PLAN_CHANGED `persisted_plan_differs`) and the run's history mode
   * (`history_mode_changed`: another mode would write other labels over the fixed points). Records the approvalRef.
   */
  async function continueInstall(input = {}) {
    const scope = normalizeScope(input)
    const planDigest = assertPlanDigest(input.planDigest)
    const historyMode = assertHistoryMode(input.historyMode)
    if (!nonBlankString(input.approvalRef)) throw inputInvalid('approvalRef')
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        await runHolder(input.holderWithin, trx)
        const sheet = await lockInstallingRow(trx, scope, planDigest)
        const plan = jsonOrNull(sheet.history_plan)
        if (!isPlainObject(plan) || plan.historyMode !== historyMode) throw planChanged('history_mode_changed')
        const version = intOrNull(sheet.version) || 0
        const written = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.sheet, { approval_ref: input.approvalRef.trim(), version: version + 1, updated_at: nowDate().toISOString() }, { id: sheet.id, version }))
        if (written.length !== 1) throw conflict('install_moved')
        return rowToSheet(written[0])
      })
    } catch (error) {
      throw translate(error, 'continue_install')
    }
  }

  /**
   * The extension of an `installing` sheet's plan (design §8.2 I5; P2-10): CAS `fromDigest` against the persisted digest,
   * then replace the plan and its digest (the run facts — historyMode, previousHistoryStatus — are carried over). The run's
   * history mode must be the persisted one (P2-18, as continueInstall: `history_mode_changed`), checked before the write.
   */
  async function extendInstall(input = {}) {
    const scope = normalizeScope(input)
    const fromDigest = assertPlanDigest(input.fromDigest, 'fromDigest')
    const planDigest = assertPlanDigest(input.planDigest)
    const historyMode = assertHistoryMode(input.historyMode)
    if (!isPlainObject(input.plan) || input.plan.digest !== planDigest) throw inputInvalid('plan')
    if (!nonBlankString(input.approvalRef)) throw inputInvalid('approvalRef')
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        await runHolder(input.holderWithin, trx)
        const sheet = await lockInstallingRow(trx, scope, fromDigest)
        const persisted = jsonOrNull(sheet.history_plan)
        if (!isPlainObject(persisted)) throw planChanged('persisted_plan_differs')
        if (persisted.historyMode !== historyMode) throw planChanged('history_mode_changed')
        const plan = { ...input.plan, historyMode: persisted.historyMode }
        delete plan.aborted
        if (persisted.previousHistoryStatus !== undefined) plan.previousHistoryStatus = persisted.previousHistoryStatus
        else delete plan.previousHistoryStatus
        const version = intOrNull(sheet.version) || 0
        const written = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.sheet, {
          history_plan: plan,
          history_plan_digest: planDigest,
          approval_ref: input.approvalRef.trim(),
          version: version + 1,
          updated_at: nowDate().toISOString(),
        }, { id: sheet.id, version }))
        if (written.length !== 1) throw conflict('install_moved')
        return rowToSheet(written[0])
      })
    } catch (error) {
      throw translate(error, 'extend_install')
    }
  }

  /**
   * Txn B (design §8.2 I6): RESOLVE. Holder FIRST; the row `installing` with the persisted digest and the run's mode;
   * per inferred batch: a non-void row with that number and the same label + origin => kept (an idempotent re-run), a
   * different one => 409 CONFLICT `inferred_batch_mismatch`, none => inserted closed / backfill_inferred. The row moves
   * to `nextStatus` with history_mode (a gap pass resolves `unknown` when the sheet's column or the run is unknown),
   * history_batch_count and resolved_*. Audit `pull_batch_installed`.
   */
  async function resolveInstall(input = {}) {
    const scope = normalizeScope(input)
    const planDigest = assertPlanDigest(input.planDigest)
    const historyMode = assertHistoryMode(input.historyMode)
    if (!PULL_BATCH_RESOLVED_HISTORY_STATUSES.includes(input.nextStatus)) throw inputInvalid('nextStatus')
    if (!Number.isSafeInteger(input.historyBatchCount) || input.historyBatchCount < 0) throw inputInvalid('historyBatchCount')
    const inferred = Array.isArray(input.inferredBatches) ? input.inferredBatches : null
    if (!inferred) throw inputInvalid('inferredBatches')
    for (const batch of inferred) {
      if (!isPlainObject(batch) || !Number.isSafeInteger(batch.batchNo) || batch.batchNo < 1 || !nonBlankString(batch.label)
        || !['plan_time', 'created_at'].includes(batch.evidence) || isoOrNull(batch.openedAt) === null || isoOrNull(batch.closedAt) === null
        || typeof batch.displayDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(batch.displayDay)) {
        throw inputInvalid('inferredBatches')
      }
    }
    try {
      return await db.transaction(async (rawTrx) => {
        const trx = requireTrx(rawTrx)
        await runHolder(input.holderWithin, trx)
        const atIso = nowDate().toISOString()
        const sheet = await lockInstallingRow(trx, scope, planDigest)
        const plan = jsonOrNull(sheet.history_plan)
        if (!isPlainObject(plan) || plan.historyMode !== historyMode) throw planChanged('history_mode_changed')
        let insertedBatches = 0
        let keptBatches = 0
        for (const batch of inferred) {
          const existing = rowsOf(await trx.select(PULL_BATCH_TABLES.batch, { where: { ...sheetWhere(scope), batch_no: batch.batchNo }, orderBy: ['id', 'ASC'], limit: 10 }))
            .filter((row) => row.status !== 'void')
          for (const row of existing) assertRowInScope(row, scope)
          if (existing.length > 0) {
            if (existing.length === 1 && existing[0].origin === 'backfill_inferred' && existing[0].label === batch.label) {
              keptBatches += 1
              continue
            }
            throw conflict('inferred_batch_mismatch')
          }
          await trx.insertOne(PULL_BATCH_TABLES.batch, {
            id: newId('batch'),
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            batch_no: batch.batchNo,
            origin: 'backfill_inferred',
            status: 'closed',
            label: batch.label,
            display_day: batch.displayDay,
            source_digest: null,
            evidence: batch.evidence,
            opened_at: isoOrNull(batch.openedAt),
            closed_at: isoOrNull(batch.closedAt),
            closed_reason: 'backfill',
            created_at: atIso,
            updated_at: atIso,
          })
          insertedBatches += 1
        }
        const gapPass = isSet(sheet.resolved_at)
        const columnMode = gapPass && (sheet.history_mode === 'unknown' || historyMode === 'unknown') ? 'unknown' : historyMode
        const version = intOrNull(sheet.version) || 0
        const written = rowsOf(await trx.updateRow(PULL_BATCH_TABLES.sheet, {
          history_status: input.nextStatus,
          history_mode: columnMode,
          history_batch_count: input.historyBatchCount,
          resolved_at: atIso,
          resolved_by: nonBlankString(input.resolvedBy) ? input.resolvedBy.trim() : null,
          version: version + 1,
          updated_at: atIso,
        }, { id: sheet.id, version }))
        if (written.length !== 1) throw conflict('install_moved')
        await runAudit(input.auditWithin, trx, {
          mode: PULL_BATCH_STORE_AUDIT.modes.installed,
          subjectId: scope.sheetId,
          projectNo: scope.projectNo,
          detail: auditDetailOf(input.auditDetail, version + 1),
        })
        return Object.freeze({ sheet: rowToSheet(written[0]), insertedBatches, keptBatches })
      })
    } catch (error) {
      throw translate(error, 'resolve_install')
    }
  }

  return Object.freeze({
    probeReadable,
    readSheetState,
    allocate,
    finish,
    readBatchLink,
    batchWithin,
    listBatches,
    readTenantSettings,
    readTenantSettingsWithin,
    writeTenantSettings,
    setSheetSettings,
    listSheetSettings,
    createSheetRowWithin,
    abortInstall,
    bornReady,
    beginInstall,
    continueInstall,
    extendInstall,
    resolveInstall,
  })
}

module.exports = {
  PULL_BATCH_BUILT_IN_SETTINGS,
  PULL_BATCH_HISTORY_STATUSES,
  PULL_BATCH_LANES,
  PULL_BATCH_RESOLVED_HISTORY_STATUSES,
  PULL_BATCH_SETTING_COLUMNS,
  PULL_BATCH_SETTING_KEYS,
  PULL_BATCH_SETTING_VALUES,
  PULL_BATCH_SHEET_SETTING_KEYS,
  PULL_BATCH_STORE_AUDIT,
  PULL_BATCH_TABLES,
  PULL_BATCH_VERIFIED_OUTCOMES,
  PULL_BATCH_VOID_REUSE_MODES,
  PULL_BATCH_WRITER_STATUSES,
  SETTINGS_NOT_CAPTURED_CODE,
  SETTINGS_VERSION_CONFLICT_CODE,
  createStockPreparationPullBatchStore,
  __internals: {
    EXECUTION_REF_PATTERN,
    PULL_BATCH_CLOSED_REASONS,
    RECOVERY_OUTCOME_BY_RESULT,
    labelsOfPersistedPlan,
    lockStateOfRow,
    normalizeSettingsPatch,
    rowToBatch,
    rowToLink,
    rowToSheet,
    settingsAuditDetail,
    translate,
  },
}
