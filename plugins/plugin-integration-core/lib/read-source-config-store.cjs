'use strict'

// External-API read self-service — S2-c: config persistence (save version + audit) ONLY (#1709).
//
// Scope fence (S2 design-lock locks 5/6): this module persists the S1 NORMALIZED config structure,
// a content-keyed version number, a status, and a VALUES-FREE audit trail. It stores the systemId
// REFERENCE only — never a resolved base URL, never credential material, never a probe response, and
// never a value-carrying error message. It runs no probe, calls no network, creates no adapter,
// exposes no route, and touches no write path. Status lifecycle is fail-closed:
// draft → approved → retired, nothing else.
//
// Idempotency (lock 6): a version is content-keyed on the normalized-config structure — a stable
// sorted-key stringify hashed with sha256 (systemId included; credential material cannot appear, the
// S1 validator rejects it). An identical save is a NO-OP returning the existing version; a changed
// save mints the next version in its family (scope + systemId + object + mode).

const crypto = require('node:crypto')
const { validateReadSourceConfig } = require('./read-source-config.cjs')
const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')

const CONFIG_TABLE = 'integration_read_source_configs'
const AUDIT_TABLE = 'integration_read_source_config_audit'
const VALID_STATUSES = Object.freeze(['draft', 'approved', 'retired'])
// The ONLY legal transitions. Fail-closed: anything not listed here conflicts.
const STATUS_TRANSITIONS = Object.freeze({
  approve: Object.freeze({ from: 'draft', to: 'approved' }),
  retire: Object.freeze({ from: 'approved', to: 'retired' }),
})

class ReadSourceConfigValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceConfigValidationError'
    this.details = details
  }
}

class ReadSourceConfigNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceConfigNotFoundError'
    this.details = details
  }
}

class ReadSourceConfigConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceConfigConflictError'
    this.details = details
  }
}

class ReadSourceConfigNotApprovedError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReadSourceConfigNotApprovedError'
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReadSourceConfigValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new ReadSourceConfigValidationError(`${field} must be a string`, { field })
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

// Stable stringify — sorted keys, same idiom as read-source-probe-contract.cjs. The content key must
// not depend on the caller's key order.
function stableStringify(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

// Content key EXCLUDES the caller-supplied `version` field: the row version is minted by this
// store, so two configs identical in every effective field must collapse to one version no matter
// what version number the caller typed into the form.
function contentKeyFor(normalizedConfig) {
  const { version, ...content } = normalizedConfig
  return crypto.createHash('sha256').update(stableStringify(content), 'utf8').digest('hex')
}

// Postgres unique-violation routing (constraint names from migration 062).
const CONTENT_KEY_CONSTRAINT = 'uniq_integration_read_source_configs_content'
const FAMILY_VERSION_CONSTRAINT = 'uniq_integration_read_source_configs_family_version'
const MAX_MINT_ATTEMPTS = 3

function isUniqueViolation(error, constraint) {
  return Boolean(error) && error.code === '23505' && error.constraint === constraint
}

function rowToPublicReadSourceConfig(row) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    systemId: row.system_id,
    object: row.object,
    mode: row.mode,
    // The stored config is structure-only by construction (S1 normalized); sanitize anyway as
    // defense-in-depth so a manually-inserted row can never leak a secret-shaped value.
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

function firstRow(result) {
  if (Array.isArray(result)) return result[0] || null
  if (result && Array.isArray(result.rows)) return result.rows[0] || null
  return null
}

function createReadSourceConfigStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.updateRow !== 'function' ||
    typeof db.select !== 'function' ||
    typeof db.transaction !== 'function'
  ) {
    // transaction is REQUIRED: version minting and status transitions must be atomic with their
    // audit rows (same discipline as integration-templates.cjs).
    throw new Error('createReadSourceConfigStore: scoped db helper (incl. transaction) is required')
  }

  // Audit runs against a caller-supplied executor so it can join the surrounding transaction.
  async function appendAudit(executor, { tenantId, workspaceId, configId, action, actor, detail }) {
    await executor.insertOne(AUDIT_TABLE, {
      id: idGenerator(),
      tenant_id: tenantId,
      workspace_id: workspaceId ?? null,
      config_id: configId,
      action,
      actor: actor ?? null,
      // Values-free by construction: callers only pass { version } or { from, to } enums/counts.
      detail: detail ?? {},
    })
  }

  // Idempotent-save reuse path. RETIRED content is fail-closed: identical content may not be
  // silently revived through save — that is a status decision, not a save.
  async function reuseExisting(existing, { tenantId, workspaceId, actor }) {
    if (existing.status === 'retired') {
      throw new ReadSourceConfigConflictError('read-source config content is retired', {
        id: existing.id,
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
    return { ...rowToPublicReadSourceConfig(existing), reused: true }
  }

  async function saveVersion(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const actor = optionalString(input.actor, 'actor')

    // S1 validation is THE gate — invalid configs never reach the table, and its errors are already
    // values-free { code, field, reason } tuples.
    const result = validateReadSourceConfig(input.config)
    if (!result.valid) {
      throw new ReadSourceConfigValidationError('read-source config is invalid', { errors: result.errors })
    }
    const normalized = result.normalized
    const contentKey = contentKeyFor(normalized)
    const family = {
      ...scopeWhere({ tenantId, workspaceId }),
      system_id: normalized.systemId,
      object: normalized.object,
      mode: normalized.mode,
    }

    // Mint loop: each attempt is ONE transaction (a 23505 aborts the PG transaction, so a retry
    // must restart, never continue inside the aborted one). The two unique indexes turn races into
    // routable 23505s: content-key violation → someone else saved identical content → loop back to
    // the reuse path; family-version violation → concurrent mint took our number → bounded retry.
    for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS; attempt += 1) {
      // Idempotent save (lock 6): identical content in the same family is a no-op.
      const existing = await db.selectOne(CONFIG_TABLE, { ...family, content_key: contentKey })
      if (existing) {
        return reuseExisting(existing, { tenantId, workspaceId, actor })
      }
      try {
        return await db.transaction(async (trx) => {
          const familyRows = await trx.select(CONFIG_TABLE, { where: family, limit: 10000 })
          const nextVersion = familyRows.reduce((max, row) => {
            const version = Number.isInteger(row.version) ? row.version : Number(row.version) || 0
            return version > max ? version : max
          }, 0) + 1

          // The stored structure is the S1 normalized config with `version` overwritten to the
          // MINTED row version — the caller-typed version field never survives into storage
          // (it is also excluded from the content key). Clone first: normalized is frozen.
          const storedConfig = JSON.parse(JSON.stringify(normalized))
          storedConfig.version = nextVersion

          const inserted = firstRow(await trx.insertOne(CONFIG_TABLE, {
            id: idGenerator(),
            tenant_id: tenantId,
            workspace_id: workspaceId,
            system_id: normalized.systemId,
            object: normalized.object,
            mode: normalized.mode,
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
          return { ...rowToPublicReadSourceConfig(inserted), reused: false }
        })
      } catch (error) {
        if (isUniqueViolation(error, CONTENT_KEY_CONSTRAINT)) {
          // Concurrent identical save won the insert — its row exists now; route to the reuse path.
          const winner = await db.selectOne(CONFIG_TABLE, { ...family, content_key: contentKey })
          if (winner) {
            return reuseExisting(winner, { tenantId, workspaceId, actor })
          }
          continue
        }
        if (isUniqueViolation(error, FAMILY_VERSION_CONSTRAINT)) {
          // Concurrent mint took our version number — bounded retry with a fresh transaction.
          continue
        }
        throw error
      }
    }
    throw new ReadSourceConfigConflictError('read-source config version minting conflicted', {
      reason: 'mint_conflict',
    })
  }

  async function list(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const where = scopeWhere({ tenantId, workspaceId })
    const systemId = optionalString(input.systemId, 'systemId')
    if (systemId) where.system_id = systemId
    const status = optionalString(input.status, 'status')
    if (status !== null) {
      if (!VALID_STATUSES.includes(status)) {
        throw new ReadSourceConfigValidationError(`status must be one of ${VALID_STATUSES.join(', ')}`, { field: 'status' })
      }
      where.status = status
    }
    const rows = await db.select(CONFIG_TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 100,
      offset: Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0,
    })
    return rows.map(rowToPublicReadSourceConfig)
  }

  async function loadRow(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const id = requiredString(input.id, 'id')
    const row = await db.selectOne(CONFIG_TABLE, { ...scopeWhere({ tenantId, workspaceId }), id })
    if (!row) {
      throw new ReadSourceConfigNotFoundError('read-source config not found', { id })
    }
    return { row, tenantId, workspaceId }
  }

  async function get(input = {}) {
    const { row } = await loadRow(input)
    return rowToPublicReadSourceConfig(row)
  }

  // Fail-closed runtime lookup (for the S3 read runtime): only an APPROVED version is consumable.
  async function getForRuntime(input = {}) {
    const { row } = await loadRow(input)
    if (row.status !== 'approved') {
      throw new ReadSourceConfigNotApprovedError('read-source config version is not approved', {
        id: row.id,
        status: row.status,
      })
    }
    return rowToPublicReadSourceConfig(row)
  }

  async function transition(kind, input = {}) {
    const spec = STATUS_TRANSITIONS[kind]
    const actor = optionalString(input.actor, 'actor')
    const { row, tenantId, workspaceId } = await loadRow(input)
    if (row.status !== spec.from) {
      throw new ReadSourceConfigConflictError(`read-source config must be ${spec.from} to ${kind}`, {
        id: row.id,
        status: row.status,
        requested: spec.to,
      })
    }
    // Status flip + its audit row are one atomic unit — a transition may never be observable
    // without its audit entry.
    return db.transaction(async (trx) => {
      const updated = firstRow(await trx.updateRow(
        CONFIG_TABLE,
        { status: spec.to, updated_by: actor },
        { ...scopeWhere({ tenantId, workspaceId }), id: row.id, status: spec.from },
      ))
      if (!updated) {
        // Row changed between load and update (fail-closed on the optimistic status guard).
        throw new ReadSourceConfigConflictError(`read-source config must be ${spec.from} to ${kind}`, {
          id: row.id,
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
      return rowToPublicReadSourceConfig(updated)
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
    approve,
    retire,
    listAudit,
  }
}

module.exports = {
  ReadSourceConfigValidationError,
  ReadSourceConfigNotFoundError,
  ReadSourceConfigConflictError,
  ReadSourceConfigNotApprovedError,
  createReadSourceConfigStore,
  __internals: {
    contentKeyFor,
    stableStringify,
  },
}
