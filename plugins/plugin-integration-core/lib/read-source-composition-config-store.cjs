'use strict'

// Read-source resolver composition — C-R1: content-keyed config persistence + audit ONLY (#1709).
//
// Scope fence: persists the validated composition config structure and lifecycle. It only reads
// approved read-source config metadata through getForRuntime at save time. It runs no chain,
// performs no outbound call, creates no adapter, exposes no route, and touches no write path.

const crypto = require('node:crypto')
const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')
const { validateReadSourceCompositionConfig } = require('./read-source-composition-config.cjs')

const CONFIG_TABLE = 'integration_read_source_composition_configs'
const AUDIT_TABLE = 'integration_read_source_composition_config_audit'
const VALID_STATUSES = Object.freeze(['draft', 'approved', 'retired'])
const STATUS_TRANSITIONS = Object.freeze({
  approve: Object.freeze({ from: 'draft', to: 'approved' }),
  retire: Object.freeze({ from: 'approved', to: 'retired' }),
})

class ReadSourceCompositionConfigValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceCompositionConfigValidationError'
    this.details = details
  }
}

class ReadSourceCompositionConfigNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceCompositionConfigNotFoundError'
    this.details = details
  }
}

class ReadSourceCompositionConfigConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceCompositionConfigConflictError'
    this.details = details
  }
}

class ReadSourceCompositionConfigNotApprovedError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceCompositionConfigNotApprovedError'
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReadSourceCompositionConfigValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new ReadSourceCompositionConfigValidationError(`${field} must be a string`, { field })
  }
  return value.trim() || null
}

function normalizeWorkspaceId(value) {
  return optionalString(value, 'workspaceId')
}

function scopeWhere({ tenantId, workspaceId }) {
  return { tenant_id: tenantId, workspace_id: workspaceId ?? null }
}

function stableStringify(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function contentKeyFor(normalizedConfig) {
  const { version, ...content } = normalizedConfig
  return crypto.createHash('sha256').update(stableStringify(content), 'utf8').digest('hex')
}

const CONTENT_KEY_CONSTRAINT = 'uniq_integration_read_source_composition_configs_content'
const FAMILY_VERSION_CONSTRAINT = 'uniq_integration_read_source_composition_configs_family_version'
const MAX_MINT_ATTEMPTS = 3

function isUniqueViolation(error, constraint) {
  return Boolean(error) && error.code === '23505' && error.constraint === constraint
}

function firstRow(result) {
  if (Array.isArray(result)) return result[0] || null
  if (result && Array.isArray(result.rows)) return result.rows[0] || null
  return null
}

function rowToPublicCompositionConfig(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    name: row.name,
    config: sanitizeIntegrationPayload(row.config ?? {}),
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
    configId: row.config_id,
    action: row.action,
    actor: row.actor ?? null,
    detail: sanitizeIntegrationPayload(row.detail ?? {}),
    createdAt: row.created_at ?? null,
  }
}

async function loadApprovedReadConfigs(readSourceConfigStore, { tenantId, workspaceId, steps }) {
  const refs = new Map()
  for (let index = 0; index < steps.length; index += 1) {
    const id = steps[index].readSourceConfigId
    try {
      const row = await readSourceConfigStore.getForRuntime({ tenantId, workspaceId, id })
      refs.set(id, row)
    } catch (_error) {
      throw new ReadSourceCompositionConfigValidationError('composition step must reference an approved read-source config', {
        errors: [{ code: 'READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED', field: `steps.${index}.readSourceConfigId`, reason: 'approved_read_config_required' }],
      })
    }
  }
  return refs
}

function createReadSourceCompositionConfigStore({ db, readSourceConfigStore, idGenerator = crypto.randomUUID } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.updateRow !== 'function' ||
    typeof db.select !== 'function' ||
    typeof db.transaction !== 'function'
  ) {
    throw new Error('createReadSourceCompositionConfigStore: scoped db helper (incl. transaction) is required')
  }
  if (!readSourceConfigStore || typeof readSourceConfigStore.getForRuntime !== 'function') {
    throw new Error('createReadSourceCompositionConfigStore: readSourceConfigStore.getForRuntime is required')
  }

  async function appendAudit(executor, { tenantId, workspaceId, configId, action, actor, detail }) {
    await executor.insertOne(AUDIT_TABLE, {
      id: idGenerator(),
      tenant_id: tenantId,
      workspace_id: workspaceId ?? null,
      config_id: configId,
      action,
      actor: actor ?? null,
      detail: detail ?? {},
    })
  }

  async function reuseExisting(existing, { tenantId, workspaceId, actor }) {
    if (existing.status === 'retired') {
      throw new ReadSourceCompositionConfigConflictError('composition config content is retired', {
        reason: 'content_retired',
      })
    }
    await appendAudit(db, {
      tenantId,
      workspaceId,
      configId: existing.id,
      action: 'reuse_version',
      actor,
      detail: { version: existing.version },
    })
    return { ...rowToPublicCompositionConfig(existing), reused: true }
  }

  async function normalizeAndValidate(input, { tenantId, workspaceId }) {
    const firstPass = validateReadSourceCompositionConfig(input.config)
    if (!firstPass.valid) {
      throw new ReadSourceCompositionConfigValidationError('composition config is invalid', { errors: firstPass.errors })
    }
    const refs = await loadApprovedReadConfigs(readSourceConfigStore, { tenantId, workspaceId, steps: firstPass.normalized.steps })
    const secondPass = validateReadSourceCompositionConfig(input.config, { readConfigsById: refs })
    if (!secondPass.valid) {
      throw new ReadSourceCompositionConfigValidationError('composition config is invalid', { errors: secondPass.errors })
    }
    return secondPass.normalized
  }

  async function saveVersion(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const actor = optionalString(input.actor, 'actor')
    const normalized = await normalizeAndValidate(input, { tenantId, workspaceId })
    const contentKey = contentKeyFor(normalized)
    const family = { ...scopeWhere({ tenantId, workspaceId }), name: normalized.name }

    for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS; attempt += 1) {
      const existing = await db.selectOne(CONFIG_TABLE, { ...family, content_key: contentKey })
      if (existing) return reuseExisting(existing, { tenantId, workspaceId, actor })
      try {
        return await db.transaction(async (trx) => {
          const familyRows = await trx.select(CONFIG_TABLE, { where: family, limit: 10000 })
          const nextVersion = familyRows.reduce((max, row) => {
            const version = Number.isInteger(row.version) ? row.version : Number(row.version) || 0
            return version > max ? version : max
          }, 0) + 1
          const storedConfig = JSON.parse(JSON.stringify(normalized))
          storedConfig.version = nextVersion
          const inserted = firstRow(await trx.insertOne(CONFIG_TABLE, {
            id: idGenerator(),
            tenant_id: tenantId,
            workspace_id: workspaceId,
            name: normalized.name,
            config: storedConfig,
            content_key: contentKey,
            version: nextVersion,
            status: 'draft',
            created_by: actor,
            updated_by: actor,
          }))
          await appendAudit(trx, {
            tenantId,
            workspaceId,
            configId: inserted.id,
            action: 'save_version',
            actor,
            detail: { version: nextVersion },
          })
          return { ...rowToPublicCompositionConfig(inserted), reused: false }
        })
      } catch (error) {
        if (isUniqueViolation(error, CONTENT_KEY_CONSTRAINT)) {
          const winner = await db.selectOne(CONFIG_TABLE, { ...family, content_key: contentKey })
          if (winner) return reuseExisting(winner, { tenantId, workspaceId, actor })
          continue
        }
        if (isUniqueViolation(error, FAMILY_VERSION_CONSTRAINT)) continue
        throw error
      }
    }
    throw new ReadSourceCompositionConfigConflictError('composition config version minting conflicted', {
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
        throw new ReadSourceCompositionConfigValidationError(`status must be one of ${VALID_STATUSES.join(', ')}`, { field: 'status' })
      }
      where.status = status
    }
    const rows = await db.select(CONFIG_TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 100,
      offset: Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0,
    })
    return rows.map(rowToPublicCompositionConfig)
  }

  async function loadRow(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const id = requiredString(input.id, 'id')
    const row = await db.selectOne(CONFIG_TABLE, { ...scopeWhere({ tenantId, workspaceId }), id })
    if (!row) throw new ReadSourceCompositionConfigNotFoundError('composition config not found', { id })
    return { row, tenantId, workspaceId }
  }

  async function get(input = {}) {
    const { row } = await loadRow(input)
    return rowToPublicCompositionConfig(row)
  }

  async function getForRuntime(input = {}) {
    const { row } = await loadRow(input)
    if (row.status !== 'approved') {
      throw new ReadSourceCompositionConfigNotApprovedError('composition config version is not approved', {
        id: row.id,
        status: row.status,
      })
    }
    return rowToPublicCompositionConfig(row)
  }

  async function transition(kind, input = {}) {
    const spec = STATUS_TRANSITIONS[kind]
    const actor = optionalString(input.actor, 'actor')
    const { row, tenantId, workspaceId } = await loadRow(input)
    if (row.status !== spec.from) {
      throw new ReadSourceCompositionConfigConflictError(`composition config must be ${spec.from} to ${kind}`, {
        status: row.status,
        requested: spec.to,
      })
    }
    return db.transaction(async (trx) => {
      const updated = firstRow(await trx.updateRow(
        CONFIG_TABLE,
        { status: spec.to, updated_by: actor },
        { ...scopeWhere({ tenantId, workspaceId }), id: row.id, status: spec.from },
      ))
      if (!updated) {
        throw new ReadSourceCompositionConfigConflictError(`composition config must be ${spec.from} to ${kind}`, {
          requested: spec.to,
        })
      }
      await appendAudit(trx, {
        tenantId,
        workspaceId,
        configId: row.id,
        action: 'status_change',
        actor,
        detail: { from: spec.from, to: spec.to },
      })
      return rowToPublicCompositionConfig(updated)
    })
  }

  async function listAudit(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const configId = requiredString(input.configId, 'configId')
    const rows = await db.select(AUDIT_TABLE, {
      where: { ...scopeWhere({ tenantId, workspaceId }), config_id: configId },
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
    getForRuntime,
    approve: (input) => transition('approve', input),
    retire: (input) => transition('retire', input),
    listAudit,
  }
}

module.exports = {
  ReadSourceCompositionConfigValidationError,
  ReadSourceCompositionConfigNotFoundError,
  ReadSourceCompositionConfigConflictError,
  ReadSourceCompositionConfigNotApprovedError,
  createReadSourceCompositionConfigStore,
  __internals: {
    contentKeyFor,
    stableStringify,
  },
}
