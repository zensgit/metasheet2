'use strict'

// #3751 stock-prep MVP — W5b (#3890): VALUES-FREE audit trail for the stock-preparation DECISION
// surface — confirms / retires / candidate sync / generation runs / exception resolution (8 actions).
// Provisioning/ensure/option-sync/plan/persist keep their own run records and are deliberately NOT
// routed through this trail. Stored in plugin SQL (integration_stock_prep_audit, migration 066).
// The structural gate below is a BACKSTOP on top of call-site discipline: enum-shaped short strings
// pass by shape, so call sites still only put counts/enums/booleans in detail (handles go in the
// dedicated subject_id column).
//
// HARD boundary:
//   - values-free BY CONSTRUCTION, not by caller discipline alone: `detail` passes a structural
//     guard — scalars (finite numbers / booleans / enum-shaped strings) and ONE nested level of
//     numeric count maps. A drawing number with spaces, an exception message, a URL, or any long /
//     unshaped string is REJECTED fail-closed before it can reach the table.
//   - closed action vocabulary (8 actions) — an unknown action is refused, never stored.
//   - subject_id / actor are internal handles (content-hash ids / user id) — never business values.
//   - append-only: the store exposes no update or delete surface.
// (Forbidden-value tokens above appear ONLY in this prose header — never as code.)

const crypto = require('node:crypto')

const AUDIT_TABLE = 'integration_stock_prep_audit'

const STOCK_PREP_AUDIT_ACTIONS = Object.freeze([
  'mapping_candidates_sync',
  'mapping_confirm',
  'mapping_retire',
  'unit_confirm',
  'unit_retire',
  'generation_run',
  'exception_resolve',
  'exception_bulk_resolve',
])
const ACTION_SET = new Set(STOCK_PREP_AUDIT_ACTIONS)

const MAX_LIST_LIMIT = 500
const DEFAULT_LIST_LIMIT = 100
// enum-shaped / handle-shaped strings only (mode names, status enums, sha16 handles, user ids).
const SAFE_STRING_PATTERN = /^[A-Za-z0-9@._:|-]{1,80}$/

class StockPreparationAuditError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationAuditError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isSafeScalar(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (typeof value === 'string') return SAFE_STRING_PATTERN.test(value)
  return false
}

// Structural values-free gate: scalars at depth 1; depth-2 objects must be pure numeric count maps
// whose KEYS are enum-shaped. Anything else (long strings, arrays of strings, deep nesting) fails
// closed with the offending PATH only — never the value.
function assertValuesFreeDetail(detail) {
  if (detail === undefined || detail === null) return {}
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    throw new StockPreparationAuditError(422, 'AUDIT_DETAIL_INVALID', 'detail must be a plain object', { field: 'detail' })
  }
  for (const [key, value] of Object.entries(detail)) {
    if (!SAFE_STRING_PATTERN.test(key)) {
      // The offending KEY is itself the potential leak vector — never echo it, not even truncated.
      throw new StockPreparationAuditError(422, 'AUDIT_DETAIL_INVALID', 'detail key is not enum-shaped', { field: 'detail.<invalid-key>' })
    }
    if (isSafeScalar(value)) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (!SAFE_STRING_PATTERN.test(innerKey) || typeof innerValue !== 'number' || !Number.isFinite(innerValue)) {
          throw new StockPreparationAuditError(422, 'AUDIT_DETAIL_INVALID', 'nested detail must be a numeric count map with enum-shaped keys', { field: `detail.${key}` })
        }
      }
      continue
    }
    throw new StockPreparationAuditError(422, 'AUDIT_DETAIL_INVALID', 'detail value is not a values-free scalar or count map', { field: `detail.${key}` })
  }
  return detail
}

function rowToPublicEntry(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id ?? null,
    action: row.action,
    subjectId: row.subject_id ?? null,
    mode: row.mode ?? null,
    actor: row.actor ?? null,
    detail: row.detail ?? {},
    createdAt: row.created_at ?? null,
  }
}

function createStockPreparationAuditStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (!db || typeof db.insertOne !== 'function' || typeof db.select !== 'function') {
    throw new Error('createStockPreparationAuditStore: scoped db helper (insertOne + select) is required')
  }

  async function append({ tenantId, workspaceId, projectId, action, subjectId, mode, actor, detail } = {}) {
    const tenant = optionalString(tenantId)
    if (!tenant) {
      throw new StockPreparationAuditError(422, 'AUDIT_CONFIG_INVALID', 'tenantId is required', { field: 'tenantId' })
    }
    const normalizedAction = optionalString(action)
    if (!normalizedAction || !ACTION_SET.has(normalizedAction)) {
      throw new StockPreparationAuditError(422, 'AUDIT_ACTION_INVALID', 'action must be one of the stock-prep audit vocabulary', { field: 'action' })
    }
    const safeDetail = assertValuesFreeDetail(detail)
    const row = {
      id: idGenerator(),
      tenant_id: tenant,
      workspace_id: optionalString(workspaceId),
      project_id: optionalString(projectId),
      action: normalizedAction,
      subject_id: optionalString(subjectId),
      mode: optionalString(mode),
      actor: optionalString(actor),
      detail: safeDetail,
    }
    await db.insertOne(AUDIT_TABLE, row)
    return { id: row.id, action: normalizedAction }
  }

  async function list({ tenantId, workspaceId, projectId, action, limit } = {}) {
    const tenant = optionalString(tenantId)
    if (!tenant) {
      throw new StockPreparationAuditError(422, 'AUDIT_CONFIG_INVALID', 'tenantId is required', { field: 'tenantId' })
    }
    const normalizedAction = optionalString(action)
    if (normalizedAction && !ACTION_SET.has(normalizedAction)) {
      throw new StockPreparationAuditError(422, 'AUDIT_ACTION_INVALID', 'action must be one of the stock-prep audit vocabulary', { field: 'action' })
    }
    const bounded = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)
    const where = { tenant_id: tenant }
    if (normalizedAction) where.action = normalizedAction
    const project = optionalString(projectId)
    if (project) where.project_id = project
    const workspace = optionalString(workspaceId)
    if (workspace) where.workspace_id = workspace
    const rows = await db.select(AUDIT_TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: bounded,
    })
    const list = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.rows) ? rows.rows : [])
    return { rowCount: list.length, entries: list.map(rowToPublicEntry) }
  }

  return { append, list }
}

module.exports = {
  AUDIT_TABLE,
  STOCK_PREP_AUDIT_ACTIONS,
  StockPreparationAuditError,
  createStockPreparationAuditStore,
  __internals: {
    assertValuesFreeDetail,
    isSafeScalar,
    rowToPublicEntry,
    SAFE_STRING_PATTERN,
    MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT,
  },
}
