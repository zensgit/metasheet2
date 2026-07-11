'use strict'

// Bridge Agent controlled apply — BA-APPLY-2a: content-keyed checklist persistence + values-free
// audit + approval gate ONLY (design-lock
// docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 B, §4 hard locks).
// Mirrors lib/read-source-config-store.cjs's pattern (S2-c, #1709).
//
// Scope fence: this module persists a validated (lib/bridge-agent-change-checklist-contract.cjs)
// checklist, a content-keyed version number, a status, and a VALUES-FREE audit trail. It runs no
// probe, calls no network, creates no adapter, resolves no external system, exposes no route, and —
// critically — NEVER applies anything to the Bridge Agent. Status lifecycle is fail-closed:
// draft -> approved -> retired, nothing else. `getForApply` is the approval gate: only an APPROVED
// checklist is fetchable by the (human/ops-script) apply consumer; draft/retired fail closed.
//
// Idempotency: a version is content-keyed on the normalized checklist structure — a stable
// sorted-key stringify hashed with sha256. An identical save is a NO-OP returning the existing
// version; a changed save mints the next version in its family (scope = tenant + workspace — a
// deployment's staged checklist is one evolving family, mirroring the Bridge Agent's single-instance,
// 127.0.0.1-bound deployment shape).

const crypto = require('node:crypto')
const { validateBridgeAgentChangeChecklist } = require('./bridge-agent-change-checklist-contract.cjs')
const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')

const CHECKLIST_TABLE = 'integration_bridge_agent_checklists'
const AUDIT_TABLE = 'integration_bridge_agent_checklist_audit'
const VALID_STATUSES = Object.freeze(['draft', 'approved', 'retired'])
// The ONLY legal transitions. Fail-closed: anything not listed here conflicts.
const STATUS_TRANSITIONS = Object.freeze({
  approve: Object.freeze({ from: 'draft', to: 'approved' }),
  retire: Object.freeze({ from: 'approved', to: 'retired' }),
})

class BridgeAgentChecklistValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BridgeAgentChecklistValidationError'
    this.details = details
  }
}

class BridgeAgentChecklistNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BridgeAgentChecklistNotFoundError'
    this.details = details
  }
}

class BridgeAgentChecklistConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BridgeAgentChecklistConflictError'
    this.details = details
  }
}

class BridgeAgentChecklistNotApprovedError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BridgeAgentChecklistNotApprovedError'
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeAgentChecklistValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new BridgeAgentChecklistValidationError(`${field} must be a string`, { field })
  }
  return value.trim() || null
}

function normalizeWorkspaceId(value) {
  return optionalString(value, 'workspaceId')
}

function scopeWhere({ tenantId, workspaceId }) {
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId ?? null,
  }
}

// Stable stringify — sorted keys, same idiom as read-source-config-store.cjs / read-source-probe-contract.cjs.
function stableStringify(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function contentKeyFor(normalizedChecklist) {
  return crypto.createHash('sha256').update(stableStringify(normalizedChecklist), 'utf8').digest('hex')
}

// Postgres unique-violation routing (constraint names from migration 065).
const CONTENT_KEY_CONSTRAINT = 'uniq_integration_bridge_agent_checklists_content'
const FAMILY_VERSION_CONSTRAINT = 'uniq_integration_bridge_agent_checklists_family_version'
const MAX_MINT_ATTEMPTS = 3

function isUniqueViolation(error, constraint) {
  return Boolean(error) && error.code === '23505' && error.constraint === constraint
}

function rowToPublicChecklist(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    // The stored checklist is values-free by construction (the contract gate rejects anything else
    // before it ever reaches this store) — sanitize anyway as defense-in-depth.
    checklist: sanitizeIntegrationPayload(row.checklist ?? {}),
    contentKey: row.content_key,
    version: row.version,
    status: row.status,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function rowToPublicAuditEntry(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    checklistId: row.checklist_id,
    action: row.action,
    actor: row.actor ?? null,
    // Values-free by construction: callers only pass { version } or { from, to } enums/counts —
    // never checklist content (operations/objectName/fieldKeys).
    detail: sanitizeIntegrationPayload(row.detail ?? {}),
    createdAt: row.created_at ?? null,
  }
}

function firstRow(result) {
  if (Array.isArray(result)) return result[0] || null
  if (result && Array.isArray(result.rows)) return result.rows[0] || null
  return null
}

function createBridgeAgentChecklistStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.updateRow !== 'function' ||
    typeof db.select !== 'function' ||
    typeof db.transaction !== 'function'
  ) {
    // transaction is REQUIRED: version minting and status transitions must be atomic with their
    // audit rows.
    throw new Error('createBridgeAgentChecklistStore: scoped db helper (incl. transaction) is required')
  }

  async function appendAudit(executor, { tenantId, workspaceId, checklistId, action, actor, detail }) {
    await executor.insertOne(AUDIT_TABLE, {
      id: idGenerator(),
      tenant_id: tenantId,
      workspace_id: workspaceId ?? null,
      checklist_id: checklistId,
      action,
      actor: actor ?? null,
      detail: detail ?? {},
    })
  }

  // Idempotent-save reuse path. RETIRED content is fail-closed: identical content may not be
  // silently revived through save — that is a status decision, not a save.
  async function reuseExisting(existing, { tenantId, workspaceId, actor }) {
    if (existing.status === 'retired') {
      throw new BridgeAgentChecklistConflictError('bridge-agent checklist content is retired', {
        id: existing.id,
        reason: 'content_retired',
      })
    }
    await appendAudit(db, {
      tenantId,
      workspaceId,
      checklistId: existing.id,
      action: 'reuse_version',
      actor,
      detail: { version: existing.version },
    })
    return { ...rowToPublicChecklist(existing), reused: true }
  }

  async function saveVersion(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const actor = optionalString(input.actor, 'actor')

    // The contract validator is THE gate — a non-conforming checklist (write/delete/make-writable op,
    // unsafe identifier, wrong schemaVersion, …) never reaches either table. Its errors are already
    // values-free { code, field, reason } tuples (field is a structural path, never a value).
    const result = validateBridgeAgentChangeChecklist(input.checklist)
    if (!result.valid) {
      throw new BridgeAgentChecklistValidationError('bridge-agent checklist is invalid', { errors: result.errors })
    }
    const normalized = result.normalized
    const contentKey = contentKeyFor(normalized)
    const family = scopeWhere({ tenantId, workspaceId })

    for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS; attempt += 1) {
      const existing = await db.selectOne(CHECKLIST_TABLE, { ...family, content_key: contentKey })
      if (existing) {
        return reuseExisting(existing, { tenantId, workspaceId, actor })
      }
      try {
        return await db.transaction(async (trx) => {
          const familyRows = await trx.select(CHECKLIST_TABLE, { where: family, limit: 10000 })
          const nextVersion = familyRows.reduce((max, row) => {
            const version = Number.isInteger(row.version) ? row.version : Number(row.version) || 0
            return version > max ? version : max
          }, 0) + 1

          const inserted = firstRow(await trx.insertOne(CHECKLIST_TABLE, {
            id: idGenerator(),
            tenant_id: tenantId,
            workspace_id: workspaceId,
            checklist: JSON.parse(JSON.stringify(normalized)),
            content_key: contentKey,
            version: nextVersion,
            status: 'draft',
            created_by: actor,
            updated_by: actor,
          }))
          await appendAudit(trx, {
            tenantId,
            workspaceId,
            checklistId: inserted.id,
            action: 'save_version',
            actor,
            detail: { version: nextVersion },
          })
          return { ...rowToPublicChecklist(inserted), reused: false }
        })
      } catch (error) {
        if (isUniqueViolation(error, CONTENT_KEY_CONSTRAINT)) {
          const winner = await db.selectOne(CHECKLIST_TABLE, { ...family, content_key: contentKey })
          if (winner) {
            return reuseExisting(winner, { tenantId, workspaceId, actor })
          }
          continue
        }
        if (isUniqueViolation(error, FAMILY_VERSION_CONSTRAINT)) {
          continue
        }
        throw error
      }
    }
    throw new BridgeAgentChecklistConflictError('bridge-agent checklist version minting conflicted', {
      reason: 'mint_conflict',
    })
  }

  async function list(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const where = scopeWhere({ tenantId, workspaceId })
    const status = optionalString(input.status, 'status')
    if (status !== null) {
      if (!VALID_STATUSES.includes(status)) {
        throw new BridgeAgentChecklistValidationError(`status must be one of ${VALID_STATUSES.join(', ')}`, { field: 'status' })
      }
      where.status = status
    }
    const rows = await db.select(CHECKLIST_TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 100,
      offset: Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0,
    })
    return rows.map(rowToPublicChecklist)
  }

  async function loadRow(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const id = requiredString(input.id, 'id')
    const row = await db.selectOne(CHECKLIST_TABLE, { ...scopeWhere({ tenantId, workspaceId }), id })
    if (!row) {
      throw new BridgeAgentChecklistNotFoundError('bridge-agent checklist not found', { id })
    }
    return { row, tenantId, workspaceId }
  }

  async function get(input = {}) {
    const { row } = await loadRow(input)
    return rowToPublicChecklist(row)
  }

  // Approval gate (design-lock §2 形态 B "审批门", hard lock): only an APPROVED checklist is
  // consumable by the apply side (a human/ops-script fetching it to hand-apply per the runbook —
  // this store/module never applies anything itself). A draft or retired checklist fails closed.
  async function getForApply(input = {}) {
    const { row } = await loadRow(input)
    if (row.status !== 'approved') {
      throw new BridgeAgentChecklistNotApprovedError('bridge-agent checklist is not approved', {
        id: row.id,
        status: row.status,
      })
    }
    return rowToPublicChecklist(row)
  }

  async function transition(kind, input = {}) {
    const spec = STATUS_TRANSITIONS[kind]
    const actor = optionalString(input.actor, 'actor')
    const { row, tenantId, workspaceId } = await loadRow(input)
    if (row.status !== spec.from) {
      throw new BridgeAgentChecklistConflictError(`bridge-agent checklist must be ${spec.from} to ${kind}`, {
        id: row.id,
        status: row.status,
        requested: spec.to,
      })
    }
    // Status flip + its audit row are one atomic unit — a transition may never be observable
    // without its audit entry.
    return db.transaction(async (trx) => {
      const updated = firstRow(await trx.updateRow(
        CHECKLIST_TABLE,
        { status: spec.to, updated_by: actor },
        { ...scopeWhere({ tenantId, workspaceId }), id: row.id, status: spec.from },
      ))
      if (!updated) {
        throw new BridgeAgentChecklistConflictError(`bridge-agent checklist must be ${spec.from} to ${kind}`, {
          id: row.id,
          requested: spec.to,
        })
      }
      await appendAudit(trx, {
        tenantId,
        workspaceId,
        checklistId: row.id,
        action: 'status_change',
        actor,
        detail: { from: spec.from, to: spec.to },
      })
      return rowToPublicChecklist(updated)
    })
  }

  async function approve(input = {}) {
    return transition('approve', input)
  }

  async function retire(input = {}) {
    return transition('retire', input)
  }

  async function listAudit(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const checklistId = requiredString(input.checklistId, 'checklistId')
    const rows = await db.select(AUDIT_TABLE, {
      where: { ...scopeWhere({ tenantId, workspaceId }), checklist_id: checklistId },
      orderBy: ['created_at', 'DESC'],
      limit: Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 100,
      offset: Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0,
    })
    return rows.map(rowToPublicAuditEntry)
  }

  return {
    saveVersion,
    list,
    get,
    getForApply,
    approve,
    retire,
    listAudit,
  }
}

module.exports = {
  BridgeAgentChecklistValidationError,
  BridgeAgentChecklistNotFoundError,
  BridgeAgentChecklistConflictError,
  BridgeAgentChecklistNotApprovedError,
  createBridgeAgentChecklistStore,
  __internals: {
    contentKeyFor,
    stableStringify,
  },
}
