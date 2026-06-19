'use strict'

// ---------------------------------------------------------------------------
// Integration template registry - plugin-integration-core (S3-1)
//
// First-class, DECLARATIVE integration-template object: stores a reusable
// composition of source + target (by adapter KIND) + key fields + field
// mappings + orchestration config. Definition state ONLY:
//   - NO instantiation (template -> pipeline + mappings + system.config) — that
//     is S3-2 and lives elsewhere.
//   - NO external adapter calls, NO run execution, NO credential reads.
//   - The template references a target KIND/object/keyFields/mappings; it does
//     NOT redefine C6 write-safety (that is the target's write profile).
// ---------------------------------------------------------------------------

const crypto = require('node:crypto')

const TEMPLATES_TABLE = 'integration_templates'
const VALID_STATUSES = new Set(['active', 'inactive'])

class TemplateValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TemplateValidationError'
    this.status = 422
    this.code = 'INTEGRATION_TEMPLATE_VALIDATION_FAILED'
    this.details = details
  }
}

class TemplateNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TemplateNotFoundError'
    this.status = 404
    this.code = 'INTEGRATION_TEMPLATE_NOT_FOUND'
    this.details = details
  }
}

// S3-1b: optimistic-concurrency conflict on update — a caller-supplied `version` that no longer
// matches the stored version (a concurrent edit happened). 409 so the route surfaces it as such.
class TemplateVersionConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TemplateVersionConflictError'
    this.status = 409
    this.code = 'INTEGRATION_TEMPLATE_VERSION_CONFLICT'
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TemplateValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new TemplateValidationError(`${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function normalizeWorkspaceId(value) {
  const normalized = optionalString(value, 'workspaceId')
  return normalized === null ? null : normalized
}

function jsonArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new TemplateValidationError(`${field} must be an array`, { field })
  }
  return value
}

function jsonObject(value, field) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TemplateValidationError(`${field} must be an object`, { field })
  }
  return value
}

// S3-1b: version is SYSTEM-MANAGED, not a plain settable field. The normalizer no longer
// defaults to 1 — it returns undefined when absent (meaning "no caller-supplied version"), and
// validates a supplied value. upsertTemplate/resolveTemplateVersion decides the stored version:
// create -> 1; edit without version -> existing+1 (auto-bump); edit WITH version -> optimistic
// lock (must match current, else 409), then bump.
function normalizeVersion(value) {
  if (value === undefined || value === null || value === '') return undefined
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new TemplateValidationError('version must be a positive integer', { field: 'version' })
  }
  return numeric
}

function resolveTemplateVersion(existing, requestedVersion) {
  if (!existing) {
    // create: version is system-managed and starts at 1 (a caller-supplied version is ignored
    // on create — there is nothing to optimistic-lock against).
    return 1
  }
  const currentVersion = Number(existing.version)
  if (requestedVersion === undefined) {
    // normal edit: auto-bump so every change advances the version (snapshot provenance).
    return currentVersion + 1
  }
  // caller supplied a version => optimistic-concurrency lock: it must equal the current version;
  // never a silent overwrite. On match, still bump.
  if (requestedVersion !== currentVersion) {
    throw new TemplateVersionConflictError(
      `template version conflict: expected current version ${currentVersion}, caller sent ${requestedVersion} — reload and retry`,
      { field: 'version', expected: currentVersion, actual: requestedVersion },
    )
  }
  return currentVersion + 1
}

function normalizeStatus(value) {
  if (value === undefined || value === null || value === '') return 'active'
  const status = requiredString(value, 'status')
  if (!VALID_STATUSES.has(status)) {
    throw new TemplateValidationError(`status must be one of ${Array.from(VALID_STATUSES).join(', ')}`, { field: 'status' })
  }
  return status
}

// key fields are a list of logical field names; mappings are declarative entries.
function normalizeKeyFields(value) {
  return jsonArray(value, 'keyFields').map((entry, index) => requiredString(entry, `keyFields[${index}]`))
}

function normalizeMappingDef(value) {
  return jsonArray(value, 'mappingDef').map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TemplateValidationError(`mappingDef[${index}] must be an object`, { field: 'mappingDef', index })
    }
    return entry
  })
}

function scopeWhere({ tenantId, workspaceId }) {
  return { tenant_id: tenantId, workspace_id: workspaceId }
}

function unwrapRows(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  if (result && result.rows === undefined && result.id) return [result]
  return result ? [result] : []
}

function jsonbParam(value) {
  return value
}

function parseJsonbValue(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return value
}

function normalizeTemplateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TemplateValidationError('template input must be an object')
  }
  return {
    id: optionalString(input.id, 'id'),
    tenantId: requiredString(input.tenantId, 'tenantId'),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    projectId: optionalString(input.projectId, 'projectId'),
    name: requiredString(input.name, 'name'),
    version: normalizeVersion(input.version),
    description: optionalString(input.description, 'description'),
    sourceKind: optionalString(input.sourceKind, 'sourceKind'),
    sourceObject: optionalString(input.sourceObject, 'sourceObject'),
    targetKind: requiredString(input.targetKind, 'targetKind'),
    targetObject: optionalString(input.targetObject, 'targetObject'),
    keyFields: normalizeKeyFields(input.keyFields),
    mappingDef: normalizeMappingDef(input.mappingDef),
    orchestrationConfig: jsonObject(input.orchestrationConfig, 'orchestrationConfig'),
    status: normalizeStatus(input.status),
    createdBy: optionalString(input.createdBy, 'createdBy'),
  }
}

function rowToTemplate(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id ?? null,
    name: row.name,
    version: typeof row.version === 'number' ? row.version : Number(row.version),
    description: row.description ?? null,
    sourceKind: row.source_kind ?? null,
    sourceObject: row.source_object ?? null,
    targetKind: row.target_kind,
    targetObject: row.target_object ?? null,
    keyFields: parseJsonbValue(row.key_fields, []),
    mappingDef: parseJsonbValue(row.mapping_def, []),
    orchestrationConfig: parseJsonbValue(row.orchestration_config, {}),
    status: row.status,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function createIntegrationTemplateRegistry({ db, idGenerator = crypto.randomUUID, now = () => new Date().toISOString() } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.updateRow !== 'function' ||
    typeof db.select !== 'function' ||
    typeof db.deleteRows !== 'function'
  ) {
    throw new Error('createIntegrationTemplateRegistry: scoped db helper is required')
  }

  async function selectExisting(normalized) {
    if (normalized.id) {
      return db.selectOne(TEMPLATES_TABLE, { ...scopeWhere(normalized), id: normalized.id })
    }
    return db.selectOne(TEMPLATES_TABLE, { ...scopeWhere(normalized), name: normalized.name })
  }

  async function upsertTemplate(input) {
    const normalized = normalizeTemplateInput(input)
    const existing = await selectExisting(normalized)
    const version = resolveTemplateVersion(existing, normalized.version)
    const baseRow = {
      tenant_id: normalized.tenantId,
      workspace_id: normalized.workspaceId,
      project_id: normalized.projectId,
      name: normalized.name,
      version,
      description: normalized.description,
      source_kind: normalized.sourceKind,
      source_object: normalized.sourceObject,
      target_kind: normalized.targetKind,
      target_object: normalized.targetObject,
      key_fields: jsonbParam(normalized.keyFields),
      mapping_def: jsonbParam(normalized.mappingDef),
      orchestration_config: jsonbParam(normalized.orchestrationConfig),
      status: normalized.status,
    }

    let row
    if (existing) {
      // updated_at is set by the 061 BEFORE UPDATE trigger in real Postgres; we also set it
      // here so the in-memory test db (which has no trigger) bumps it. The trigger wins in PG.
      const updateRow = { ...baseRow, updated_at: now() }
      const rows = unwrapRows(await db.updateRow(TEMPLATES_TABLE, updateRow, {
        ...scopeWhere(normalized),
        id: existing.id,
      }))
      row = rows[0] || { ...existing, ...updateRow }
    } else {
      const insertRow = {
        id: normalized.id || idGenerator(),
        ...baseRow,
        created_by: normalized.createdBy,
      }
      const rows = unwrapRows(await db.insertOne(TEMPLATES_TABLE, insertRow))
      row = rows[0] || insertRow
    }
    return rowToTemplate(row)
  }

  async function getTemplate(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const row = await db.selectOne(TEMPLATES_TABLE, { tenant_id: tenantId, workspace_id: workspaceId, id })
    if (!row) {
      throw new TemplateNotFoundError('integration template not found', { id, tenantId, workspaceId })
    }
    return rowToTemplate(row)
  }

  async function listTemplates(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const where = scopeWhere({ tenantId, workspaceId })
    if (input.status) where.status = normalizeStatus(input.status)
    if (input.targetKind) where.target_kind = requiredString(input.targetKind, 'targetKind')
    const rows = unwrapRows(await db.select(TEMPLATES_TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: input.limit,
      offset: input.offset,
    }))
    return rows.map(rowToTemplate)
  }

  async function deleteTemplate(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const result = await db.deleteRows(TEMPLATES_TABLE, { tenant_id: tenantId, workspace_id: workspaceId, id })
    const deleted = typeof result === 'number'
      ? result
      : (result && typeof result.rowCount === 'number' ? result.rowCount : unwrapRows(result).length)
    if (!deleted) {
      throw new TemplateNotFoundError('integration template not found', { id, tenantId, workspaceId })
    }
    return { deleted }
  }

  return { upsertTemplate, getTemplate, listTemplates, deleteTemplate }
}

module.exports = {
  createIntegrationTemplateRegistry,
  TemplateValidationError,
  TemplateNotFoundError,
  TemplateVersionConflictError,
  __internals: {
    TEMPLATES_TABLE,
    VALID_STATUSES,
    normalizeTemplateInput,
    rowToTemplate,
    resolveTemplateVersion,
  },
}
