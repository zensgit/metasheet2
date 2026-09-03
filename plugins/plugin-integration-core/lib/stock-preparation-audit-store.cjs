'use strict'

// #3751 stock-prep MVP — W5b (#3890): VALUES-FREE audit trail for the stock-preparation DECISION
// surface — confirms / retires / candidate sync / generation runs / exception resolution plus the
// bounded P4 one-shot repair operation (9 actions), plus the project materials export (10th, added for
// the 按项目导出物料 Excel route — the export leaves the system as a downloadable file, so it gets the
// same audit trail discipline as a write, even though the route itself is a GET).
// Provisioning/ensure/option-sync/plan/persist keep their own run records and are deliberately NOT
// routed through this trail. Stored in plugin SQL (integration_stock_prep_audit, migrations 066/067).
// The structural gate below is a BACKSTOP on top of call-site discipline: enum-shaped short strings
// pass by shape, so call sites still only put counts/enums/booleans in detail (handles go in the
// dedicated subject_id column).
//
// HARD boundary:
//   - values-free BY CONSTRUCTION, not by caller discipline alone: `detail` passes a structural
//     guard — scalars (finite numbers / booleans / enum-shaped strings) and ONE nested level of
//     numeric count maps. A drawing number with spaces, an exception message, a URL, or any long /
//     unshaped string is REJECTED fail-closed before it can reach the table.
//   - closed action vocabulary (9 actions) — an unknown action is refused, never stored.
//   - subject_id / actor are internal handles (content-hash ids / user id) — never business values.
//   - append-only: the store exposes no update or delete surface.
// (Forbidden-value tokens above appear ONLY in this prose header — never as code.)

const crypto = require('node:crypto')

const AUDIT_TABLE = 'integration_stock_prep_audit'
// The constraint the vocabulary migrations (067/080/081/082/085) drop and re-add. Named here so the
// probe below can tell "this action is outside the DB's vocabulary" from any other write failure.
const AUDIT_ACTION_CHECK_CONSTRAINT = 'integration_stock_prep_audit_action_check'

/**
 * Is this a CHECK-constraint violation on the named constraint? PostgreSQL reports 23514 and names
 * the constraint; a driver that reports neither is treated as "not this", which keeps the probe's
 * fail-open posture (see supportsAction).
 */
function isCheckConstraintViolation(error, constraintName) {
  if (!error) return false
  const code = String(error.code || (error.cause && error.cause.code) || '')
  if (code !== '23514') return false
  const named = String(error.constraint || (error.cause && error.cause.constraint) || '')
  if (named) return named === constraintName
  return String(error.message || '').includes(constraintName)
}

const STOCK_PREP_AUDIT_ACTIONS = Object.freeze([
  'mapping_candidates_sync',
  'mapping_confirm',
  'mapping_retire',
  'unit_confirm',
  'unit_retire',
  'generation_run',
  'exception_resolve',
  'exception_bulk_resolve',
  'persist_repair_once',
  // 工作台里选源 (migration 080): an admin repointed the stock-preparation pull action at a different
  // source external system. The only action here that records a decision about WHERE data comes
  // from rather than about the data itself — and the one that was previously unauditable by
  // construction, because the source lived in a server env file.
  'source_binding_set',
  // 按项目导出物料 Excel: the workbook leaves the system as a file, so the export itself is audited —
  // counts only (rowCount/activeRowCount), never a material name/quantity (see stock-preparation-
  // prep-line-export.cjs, which computes them, and the route, which is the only caller).
  'prep_line_export',
  // 一线看得见自己工厂的项目 (migration 082): an operator listed THEIR OWN tenant's project directory,
  // which is the first READ on this trail that carries customer values (project numbers and names) to
  // the caller. The audited ROW stays values-free regardless — project_id is NULL, mode is the
  // operator_directory|operator_directory_idle enum, and detail is counts + booleans only. Audited
  // because the reopened OD-E3 gate requires an audit vocabulary for the value plane, not merely a
  // permission for it.
  'project_directory_read',
  // 通知下一步 (migration 085): a person finished their step of the 备料 handoff chain and handed it
  // to the next one — or, on the last step, finished the project and had 仓库/采购 told. The only
  // action here that records a decision about the WORK rather than about the data. Values-free:
  // `subject_id` is a step key from the closed handoff vocabulary, `detail` carries cursor integers
  // and booleans only (see stock-preparation-handoff.cjs and the route, its only caller).
  'handoff_advance',
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

  /**
   * IS THE DATABASE'S CHECK CONSTRAINT ACTUALLY WIDE ENOUGH FOR `action` YET? (RC1)
   *
   * `STOCK_PREP_AUDIT_ACTIONS` above is what this PROCESS believes the vocabulary is. The DATABASE
   * believes whatever the last vocabulary migration installed, and the two are different facts:
   * `db:migrate` is a separate CLI (packages/core-backend/src/db/migrate.ts), not a boot step, so a
   * deployment can legitimately be running code that knows about `handoff_advance` against a schema
   * whose CHECK constraint stops at 082. Every write of the new action then failed at the database —
   * with a raw constraint-violation message, at a point in the caller's flow where the damage was
   * already done.
   *
   * So a caller that is ABOUT to write a new action can ask first, and refuse by name instead.
   *
   * HOW: a real INSERT inside a transaction that is then ROLLED BACK. Reading `pg_constraint` would
   * mean raw SQL, which the plugin's db helper deliberately does not offer (lib/db.cjs exposes a
   * structured API precisely so a plugin cannot hand-write SQL). The dry insert asks the question the
   * only way this layer can: it makes the database answer it.
   *
   * The row can never survive — the callback always throws, so the transaction always rolls back —
   * and it is written with `tenant_id` of the caller's own probe scope so that a database which
   * somehow DID commit it would leave something recognisable rather than a foreign-tenant row.
   *
   * FAIL-OPEN ON AN UNKNOWN ERROR, deliberately: this is a diagnostic, and a probe that cannot tell
   * "constraint too narrow" from "connection blipped" must not turn a transient blip into a refusal
   * of a route that would have worked. `{ supported: true, reason: 'probe_unavailable' }` means "ask
   * the real write", which then behaves exactly as it did before this method existed.
   */
  async function supportsAction(action, { tenantId } = {}) {
    const normalizedAction = optionalString(action)
    if (!normalizedAction || !ACTION_SET.has(normalizedAction)) {
      return { supported: false, reason: 'action_not_in_store_vocabulary' }
    }
    if (typeof db.transaction !== 'function') {
      return { supported: true, reason: 'probe_unavailable' }
    }
    const sentinel = new Error('stock-prep audit vocabulary probe: rolling back on purpose')
    sentinel.__stockPrepAuditProbe = true
    try {
      await db.transaction(async (trx) => {
        await trx.insertOne(AUDIT_TABLE, {
          id: idGenerator(),
          tenant_id: optionalString(tenantId) || '__probe__',
          workspace_id: null,
          project_id: null,
          action: normalizedAction,
          subject_id: null,
          mode: 'vocabulary_probe',
          actor: null,
          detail: { operation: 'vocabulary_probe' },
        })
        throw sentinel
      })
      // A transaction that swallowed our throw is not a transaction we can reason about.
      return { supported: true, reason: 'probe_unavailable' }
    } catch (error) {
      if (error === sentinel || (error && error.__stockPrepAuditProbe === true)) {
        return { supported: true, reason: 'check_constraint_accepts' }
      }
      if (isCheckConstraintViolation(error, AUDIT_ACTION_CHECK_CONSTRAINT)) {
        return { supported: false, reason: 'action_not_in_check_constraint' }
      }
      return { supported: true, reason: 'probe_unavailable' }
    }
  }

  return { append, list, supportsAction }
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
