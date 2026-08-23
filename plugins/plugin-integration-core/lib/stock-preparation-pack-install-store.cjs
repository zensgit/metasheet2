'use strict'

// CUSTOMER-PACK INSTALL LEDGER — the record that makes a pack install enumerable.
//
// The pack-aware refresh planner needs the `ext_` column ids a sheet actually carries and the
// ownership band each one sits in. The multitable provisioning surface has NO list-fields
// primitive (every read is keyed by ids the caller must already hold), so without this ledger the
// refresh path can only fall back to the frozen-template bands. This store is the CANDIDATE +
// PROVENANCE half of the read-back seam; the live half stays with the host (see
// stock-preparation-pack-installed-fields.cjs).
//
// SHAPE + DISCIPLINES REUSED from the after-sales install ledger
// (plugins/plugin-after-sales/lib/installer.cjs, migration zzzz20260407140000):
//   * TERMINAL STATES ONLY — 'installed' | 'partial' | 'failed'. There is no 'pending' row and no
//     way to write one: `recordInstall` is called after the whole additive install flow has
//     finished, so a crash mid-install leaves NO row at all and a retry is safe.
//   * status DERIVED — warnings.length === 0 ? 'installed' : 'partial' (an explicit 'failed' is the
//     only status a caller may name, and only a caller that caught the failure itself).
//   * SINGLE-ROW UPSERT keyed by the natural install identity, so a re-install refreshes one row
//     rather than appending history.
//   * mode records the LAST ATTEMPTED install mode. Audit, not a statement of future intent.
//
// NOT REUSED: the after-sales TABLE. Its key is (tenant_id, app_id), its `created_objects_json` is
// a flat OBJECT-id array a core backfill migration parses with jsonb_array_elements_text, and it is
// owned by another plugin. Writing pack fields into it would be wrong on key, grain and owner.
//
// THE ONE GENUINE SHAPE EXTENSION is `installedFields`: per field, the ownership band that decides
// whether a PLM refresh may overwrite that column. LOGICAL ids only — physical ids are per-project
// derivations, and a ledger written in them stops being readable the moment the project changes.
//
// VALUES-FREE BY CONSTRUCTION, not by caller discipline: every list/map that reaches a jsonb column
// passes a structural guard before the write. `installedFields` accepts schema ids plus the two
// FROZEN ownership tokens and booleans; `summary` accepts finite numbers only; `warnings` accepts
// enum-shaped tokens only. An option value, a label, a drawing number or a free-text message is
// rejected fail-closed with the offending PATH — never the value.

const crypto = require('node:crypto')

const { STOCK_PREPARATION_FIELD_OWNERSHIPS } = require('./stock-preparation-templates.cjs')

const PACK_INSTALL_TABLE = 'integration_stock_prep_pack_installs'

// Terminal vocabulary. 'pending' / 'installing' are deliberately unrepresentable.
const PACK_INSTALL_STATUSES = Object.freeze(['installed', 'partial', 'failed'])
const PACK_INSTALL_MODES = Object.freeze(['install', 'reinstall'])
const STATUS_SET = new Set(PACK_INSTALL_STATUSES)
const MODE_SET = new Set(PACK_INSTALL_MODES)
// The two statuses that mean "columns are on the sheet". A 'failed' row's field list is a record of
// an attempt, never a claim about the live sheet, so the refresh read never sources ids from one.
const LIVE_STATUSES = Object.freeze(['installed', 'partial'])
const LIVE_STATUS_SET = new Set(LIVE_STATUSES)

const OWNERSHIP_SET = new Set(STOCK_PREPARATION_FIELD_OWNERSHIPS)

// Schema-id / handle shape: what a logical field id, a pack id or a project id looks like. Long or
// spaced text (a label, a message, a drawing number) fails this and never reaches the table.
const SAFE_ID_PATTERN = /^[A-Za-z0-9_:.@|-]{1,120}$/
// Warning tokens are enum-shaped, same posture as the audit store's SAFE_STRING_PATTERN.
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/

const MAX_LIST_LIMIT = 200
const DEFAULT_LIST_LIMIT = 50

class StockPreparationPackInstallError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationPackInstallError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredId(value, field) {
  const normalized = optionalString(value)
  if (!normalized || !SAFE_ID_PATTERN.test(normalized)) {
    throw new StockPreparationPackInstallError(
      422,
      'PACK_INSTALL_CONFIG_INVALID',
      `${field} is required and must be an id-shaped handle`,
      { field },
    )
  }
  return normalized
}

// A pack declares `packVersion` as a NUMBER (see lib/customer-packs/*.cjs), while the ledger column
// is TEXT so a future pack can version itself however it likes. Coerce here rather than at each call
// site: a finite number has exactly one textual form, so nothing is lost and callers cannot drift.
function requiredVersion(value) {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  return requiredId(candidate, 'packVersion')
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * The values-free gate for `installedFields`. Every entry must be exactly the four keys the ledger
 * is specified to carry, each drawn from a closed vocabulary:
 *   fieldId          — id-shaped schema handle (LOGICAL)
 *   ownership        — one of the FROZEN template ownership tokens
 *   preserveOnRefresh— boolean
 *   extension        — boolean (true for a pack column; the shape stays explicit rather than implied)
 * An unknown key is refused rather than dropped: silently discarding it would let a future caller
 * believe it persisted something the refresh path will never see.
 */
function assertValuesFreeInstalledFields(installedFields) {
  if (installedFields === undefined || installedFields === null) return []
  if (!Array.isArray(installedFields)) {
    throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'installedFields must be an array', { field: 'installedFields' })
  }
  const seen = new Set()
  return installedFields.map((entry, index) => {
    const path = `installedFields[${index}]`
    if (!isPlainObject(entry)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'installed field entry must be a plain object', { field: path })
    }
    for (const key of Object.keys(entry)) {
      if (!['fieldId', 'ownership', 'preserveOnRefresh', 'extension'].includes(key)) {
        throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'unsupported installed field key', { field: `${path}.<unsupported-key>` })
      }
    }
    const fieldId = optionalString(entry.fieldId)
    if (!fieldId || !SAFE_ID_PATTERN.test(fieldId)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'installed field fieldId must be an id-shaped logical field id', { field: `${path}.fieldId` })
    }
    if (seen.has(fieldId)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'installed field ids must be unique', { field: `${path}.fieldId` })
    }
    seen.add(fieldId)
    if (!OWNERSHIP_SET.has(entry.ownership)) {
      // The declared value is NOT echoed: an unrecognized ownership could be arbitrary text.
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'installed field ownership is not a frozen ownership token', { field: `${path}.ownership` })
    }
    if (typeof entry.preserveOnRefresh !== 'boolean') {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'installed field preserveOnRefresh must be a boolean', { field: `${path}.preserveOnRefresh` })
    }
    if (typeof entry.extension !== 'boolean') {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_FIELDS_INVALID', 'installed field extension must be a boolean', { field: `${path}.extension` })
    }
    return {
      fieldId,
      ownership: entry.ownership,
      preserveOnRefresh: entry.preserveOnRefresh,
      extension: entry.extension,
    }
  })
}

/** Counts only. A string of ANY shape is refused here — a summary is arithmetic, never prose. */
function assertValuesFreeSummary(summary) {
  if (summary === undefined || summary === null) return {}
  if (!isPlainObject(summary)) {
    throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_SUMMARY_INVALID', 'summary must be a plain object', { field: 'summary' })
  }
  const out = {}
  for (const [key, value] of Object.entries(summary)) {
    if (!SAFE_TOKEN_PATTERN.test(key)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_SUMMARY_INVALID', 'summary key is not enum-shaped', { field: 'summary.<invalid-key>' })
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_SUMMARY_INVALID', 'summary values must be finite numbers', { field: `summary.${key}` })
    }
    out[key] = value
  }
  return out
}

/** Enum-shaped tokens only — a warning is a reason code, never a message carrying a business value. */
function assertValuesFreeWarnings(warnings) {
  if (warnings === undefined || warnings === null) return []
  if (!Array.isArray(warnings)) {
    throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_WARNINGS_INVALID', 'warnings must be an array', { field: 'warnings' })
  }
  return warnings.map((value, index) => {
    if (typeof value !== 'string' || !SAFE_TOKEN_PATTERN.test(value)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_WARNINGS_INVALID', 'warning must be an enum-shaped token', { field: `warnings[${index}]` })
    }
    return value
  })
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      // A malformed column is treated as absent rather than thrown: the refresh read must degrade
      // to the (strictly narrower) legacy bands, never break the refresh outright.
      return fallback
    }
  }
  return value
}

function rowToPublicEntry(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id,
    objectId: row.object_id,
    packId: row.pack_id,
    packVersion: row.pack_version,
    mode: row.mode,
    status: row.status,
    installedFields: parseJsonColumn(row.installed_fields_json, []),
    summary: parseJsonColumn(row.summary_json, {}),
    warnings: parseJsonColumn(row.warnings_json, []),
    lastInstallAt: row.last_install_at ?? null,
    createdAt: row.created_at ?? null,
  }
}

function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

/**
 * Injected-db store, same shape as createStockPreparationAuditStore({ db }).
 * `db` is the scoped CRUD helper from lib/db.cjs (identifier-whitelisted, parameterized, no raw SQL).
 */
function createStockPreparationPackInstallStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (!db || typeof db.upsertOne !== 'function' || typeof db.select !== 'function') {
    throw new Error('createStockPreparationPackInstallStore: scoped db helper (upsertOne + select) is required')
  }

  /**
   * UPSERT one TERMINAL row. Called only after an install has fully completed, which is what makes
   * "no row means nothing landed" true and retry safe.
   *
   * `created_at` is deliberately absent from the write: the column default stamps it on insert and
   * the UPSERT's update list (derived from the row keys) therefore cannot move it on a re-install.
   */
  async function recordInstall({
    tenantId,
    workspaceId,
    projectId,
    objectId,
    packId,
    packVersion,
    mode = 'install',
    status,
    installedFields,
    summary,
    warnings,
  } = {}) {
    const tenant = requiredId(tenantId, 'tenantId')
    const project = requiredId(projectId, 'projectId')
    const object = requiredId(objectId, 'objectId')
    const pack = requiredId(packId, 'packId')
    const version = requiredVersion(packVersion)
    const normalizedMode = optionalString(mode) || 'install'
    if (!MODE_SET.has(normalizedMode)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_MODE_INVALID', 'mode must be install or reinstall', { field: 'mode' })
    }
    const safeWarnings = assertValuesFreeWarnings(warnings)
    // DERIVED, exactly as the after-sales orchestrator derives it. An explicit status is honoured
    // only when it is terminal — there is no path that writes a non-terminal one.
    const resolvedStatus = status === undefined || status === null
      ? (safeWarnings.length === 0 ? 'installed' : 'partial')
      : optionalString(status)
    if (!resolvedStatus || !STATUS_SET.has(resolvedStatus)) {
      throw new StockPreparationPackInstallError(422, 'PACK_INSTALL_STATUS_INVALID', 'status must be a terminal install status', { field: 'status' })
    }
    const safeFields = assertValuesFreeInstalledFields(installedFields)
    const safeSummary = assertValuesFreeSummary(summary)

    const row = {
      id: idGenerator(),
      tenant_id: tenant,
      workspace_id: optionalString(workspaceId),
      project_id: project,
      object_id: object,
      pack_id: pack,
      pack_version: version,
      mode: normalizedMode,
      status: resolvedStatus,
      installed_fields_json: safeFields,
      summary_json: safeSummary,
      warnings_json: safeWarnings,
    }
    const result = await db.upsertOne(PACK_INSTALL_TABLE, row, {
      conflictColumns: ['tenant_id', 'project_id', 'object_id', 'pack_id'],
      // `id` stays out of the update list: the row keeps the identity it was first inserted with,
      // so an external reference to a ledger row id survives a re-install.
      updateColumns: [
        'workspace_id',
        'pack_version',
        'mode',
        'status',
        'installed_fields_json',
        'summary_json',
        'warnings_json',
        'last_install_at',
      ],
    })
    const persisted = rowsOf(result)[0]
    return rowToPublicEntry(persisted) || rowToPublicEntry(row)
  }

  async function getInstall({ tenantId, projectId, objectId, packId } = {}) {
    const where = {
      tenant_id: requiredId(tenantId, 'tenantId'),
      project_id: requiredId(projectId, 'projectId'),
      object_id: requiredId(objectId, 'objectId'),
      pack_id: requiredId(packId, 'packId'),
    }
    const rows = rowsOf(await db.select(PACK_INSTALL_TABLE, { where, limit: 1 }))
    return rows.length === 0 ? null : rowToPublicEntry(rows[0])
  }

  async function listInstalls({ tenantId, projectId, objectId, limit } = {}) {
    const where = { tenant_id: requiredId(tenantId, 'tenantId') }
    const project = optionalString(projectId)
    if (project) where.project_id = requiredId(project, 'projectId')
    const object = optionalString(objectId)
    if (object) where.object_id = requiredId(object, 'objectId')
    const bounded = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)
    const rows = rowsOf(await db.select(PACK_INSTALL_TABLE, {
      where,
      orderBy: ['last_install_at', 'DESC'],
      limit: bounded,
    }))
    const entries = rows.map(rowToPublicEntry)
    return { rowCount: entries.length, entries }
  }

  /**
   * The refresh read: the CANDIDATE logical ids for one sheet, across every pack installed on it.
   *
   * Only 'installed' / 'partial' rows contribute — a 'failed' row records an attempt, not a live
   * column. The order is deterministic (sorted) so a caller's evidence does not depend on row order,
   * and duplicates across packs collapse to one id.
   *
   * This returns CANDIDATES, never truth: the caller must re-read them through the host before
   * feeding anything to the planner.
   */
  async function listInstalledFieldIds({ tenantId, projectId, objectId } = {}) {
    const where = {
      tenant_id: requiredId(tenantId, 'tenantId'),
      project_id: requiredId(projectId, 'projectId'),
      object_id: requiredId(objectId, 'objectId'),
    }
    const rows = rowsOf(await db.select(PACK_INSTALL_TABLE, { where, limit: MAX_LIST_LIMIT }))
    const ids = new Set()
    const packIds = new Set()
    for (const row of rows) {
      if (!LIVE_STATUS_SET.has(row && row.status)) continue
      packIds.add(row.pack_id)
      const fields = parseJsonColumn(row.installed_fields_json, [])
      if (!Array.isArray(fields)) continue
      for (const entry of fields) {
        const fieldId = isPlainObject(entry) ? optionalString(entry.fieldId) : null
        if (fieldId) ids.add(fieldId)
      }
    }
    return { fieldIds: [...ids].sort(), packIds: [...packIds].sort() }
  }

  return { recordInstall, getInstall, listInstalls, listInstalledFieldIds }
}

module.exports = {
  PACK_INSTALL_TABLE,
  PACK_INSTALL_STATUSES,
  PACK_INSTALL_MODES,
  LIVE_STATUSES,
  StockPreparationPackInstallError,
  createStockPreparationPackInstallStore,
  __internals: {
    assertValuesFreeInstalledFields,
    assertValuesFreeSummary,
    assertValuesFreeWarnings,
    rowToPublicEntry,
    SAFE_ID_PATTERN,
    SAFE_TOKEN_PATTERN,
    MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT,
  },
}
