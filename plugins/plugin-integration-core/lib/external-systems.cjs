'use strict'

// ---------------------------------------------------------------------------
// External system registry — plugin-integration-core
//
// Stores PLM/ERP/DB connection metadata in integration_external_systems.
// Credentials are write-only for public reads: callers receive a stable
// fingerprint and a hasCredentials flag, never plaintext.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto')

const TABLE = 'integration_external_systems'
const VALID_ROLES = new Set(['source', 'target', 'bidirectional'])
const VALID_STATUSES = new Set(['active', 'inactive', 'error'])

class ExternalSystemValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ExternalSystemValidationError'
    this.details = details
  }
}

class ExternalSystemNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ExternalSystemNotFoundError'
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExternalSystemValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new ExternalSystemValidationError(`${field} must be a string`, { field })
  }
  return value.trim() || null
}

function jsonObject(value, field, fallback = {}) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalSystemValidationError(`${field} must be an object`, { field })
  }
  return { ...value }
}

function normalizeWorkspaceId(value) {
  const normalized = optionalString(value, 'workspaceId')
  return normalized === '' ? null : normalized
}

function normalizeExternalSystemInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExternalSystemValidationError('input must be an object')
  }

  const role = input.role === undefined ? 'source' : requiredString(input.role, 'role')
  if (!VALID_ROLES.has(role)) {
    throw new ExternalSystemValidationError(`role must be one of ${Array.from(VALID_ROLES).join(', ')}`, { field: 'role' })
  }

  const status = input.status === undefined ? 'inactive' : requiredString(input.status, 'status')
  if (!VALID_STATUSES.has(status)) {
    throw new ExternalSystemValidationError(`status must be one of ${Array.from(VALID_STATUSES).join(', ')}`, { field: 'status' })
  }

  return {
    id: optionalString(input.id, 'id'),
    tenantId: requiredString(input.tenantId, 'tenantId'),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    projectId: optionalString(input.projectId, 'projectId'),
    name: requiredString(input.name, 'name'),
    kind: requiredString(input.kind, 'kind'),
    role,
    config: jsonObject(input.config, 'config'),
    credentials: input.credentials,
    capabilities: jsonObject(input.capabilities, 'capabilities'),
    status,
    lastTestedAt: input.lastTestedAt ?? null,
    lastError: optionalString(input.lastError, 'lastError'),
  }
}

function scopeWhere({ tenantId, workspaceId }) {
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId ?? null,
  }
}

function rowToPublicExternalSystem(row, credentialFingerprint = null) {
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id ?? null,
    name: row.name,
    kind: row.kind,
    role: row.role,
    config: row.config ?? {},
    capabilities: row.capabilities ?? {},
    status: row.status,
    lastTestedAt: row.last_tested_at ?? null,
    lastError: row.last_error ?? null,
    hasCredentials: typeof row.credentials_encrypted === 'string' && row.credentials_encrypted.length > 0,
    credentialFormat: detectCredentialFormat(row.credentials_encrypted),
    credentialFingerprint,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function rowToAdapterExternalSystem(row, credentials = undefined) {
  if (!row) return null
  const system = {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id ?? null,
    name: row.name,
    kind: row.kind,
    role: row.role,
    config: row.config ?? {},
    capabilities: row.capabilities ?? {},
    status: row.status,
    lastTestedAt: row.last_tested_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
  if (credentials !== undefined) {
    system.credentials = credentials
  }
  return system
}

function detectCredentialFormat(ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null
  if (ciphertext.startsWith('enc:')) return 'enc'
  if (ciphertext.startsWith('v1:')) return 'v1'
  return null
}

async function fingerprintCredential(credentialStore, ciphertext) {
  if (!ciphertext) return null
  return credentialStore.fingerprint(ciphertext)
}

async function publicRow(credentialStore, row) {
  if (!row) return null
  return rowToPublicExternalSystem(row, await fingerprintCredential(credentialStore, row.credentials_encrypted))
}

async function parseAdapterCredentials(credentialStore, ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return undefined
  const plaintext = await credentialStore.decrypt(ciphertext)
  if (typeof plaintext !== 'string') return plaintext
  try {
    const parsed = JSON.parse(plaintext)
    return isPlainObject(parsed) ? parsed : plaintext
  } catch {
    return plaintext
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function maybeEncryptCredentials(credentialStore, credentials) {
  if (credentials === undefined) return undefined
  if (credentials === null || credentials === '') return null
  if (typeof credentials === 'string') {
    return credentialStore.encrypt(credentials)
  }
  if (isPlainObject(credentials)) {
    return credentialStore.encrypt(JSON.stringify(credentials))
  }
  throw new ExternalSystemValidationError('credentials must be a string, a plain object, or null', { field: 'credentials' })
}

function createExternalSystemRegistry({ db, credentialStore, idGenerator = crypto.randomUUID } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.updateRow !== 'function' ||
    typeof db.select !== 'function'
  ) {
    throw new Error('createExternalSystemRegistry: scoped db helper is required')
  }
  if (!credentialStore || typeof credentialStore.encrypt !== 'function' || typeof credentialStore.fingerprint !== 'function') {
    throw new Error('createExternalSystemRegistry: credentialStore is required')
  }

  async function findExisting(input) {
    if (input.id) {
      return db.selectOne(TABLE, {
        ...scopeWhere(input),
        id: input.id,
      })
    }
    return db.selectOne(TABLE, {
      ...scopeWhere(input),
      name: input.name,
    })
  }

  async function upsertExternalSystem(input) {
    const normalized = normalizeExternalSystemInput(input)
    const existing = await findExisting(normalized)
    const credentialsEncrypted = await maybeEncryptCredentials(credentialStore, normalized.credentials)

    const baseRow = {
      tenant_id: normalized.tenantId,
      workspace_id: normalized.workspaceId,
      project_id: normalized.projectId,
      name: normalized.name,
      kind: normalized.kind,
      role: normalized.role,
      config: normalized.config,
      capabilities: normalized.capabilities,
      status: normalized.status,
      last_tested_at: normalized.lastTestedAt,
      last_error: normalized.lastError,
    }

    if (existing) {
      const role = input.role === undefined ? existing.role : normalized.role
      const status = input.status === undefined ? existing.status : normalized.status
      if (existing.kind !== normalized.kind || existing.role !== role) {
        throw new ExternalSystemValidationError('kind and role cannot be changed after creation', {
          id: existing.id,
          existingKind: existing.kind,
          existingRole: existing.role,
          requestedKind: normalized.kind,
          requestedRole: role,
        })
      }
      const updateRow = { ...baseRow, role, status }
      // Preserve stored config/capabilities when the caller did not explicitly
      // provide them. A status-only or name-only update must not wipe stored
      // connection config (baseUrl, orgId, etc.) or capability flags.
      // Explicit null/empty-object still replaces (caller opted in).
      if (input.config === undefined) updateRow.config = existing.config
      if (input.capabilities === undefined) updateRow.capabilities = existing.capabilities
      if (credentialsEncrypted !== undefined) {
        updateRow.credentials_encrypted = credentialsEncrypted
      }
      const rows = await db.updateRow(TABLE, updateRow, {
        ...scopeWhere(normalized),
        id: existing.id,
      })
      const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0]
      if (!row) {
        throw new ExternalSystemNotFoundError('external system not found during update', {
          id: existing.id,
          tenantId: normalized.tenantId,
          workspaceId: normalized.workspaceId,
        })
      }
      return publicRow(credentialStore, row)
    }

    const insertRow = {
      id: normalized.id || idGenerator(),
      ...baseRow,
      credentials_encrypted: credentialsEncrypted === undefined ? null : credentialsEncrypted,
    }
    const rows = await db.insertOne(TABLE, insertRow)
    const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0]
    return publicRow(credentialStore, row || insertRow)
  }

  async function getExternalSystem(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const row = await db.selectOne(TABLE, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      id,
    })
    if (!row) {
      throw new ExternalSystemNotFoundError('external system not found', { id, tenantId, workspaceId })
    }
    return publicRow(credentialStore, row)
  }

  async function getExternalSystemForAdapter(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const row = await db.selectOne(TABLE, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      id,
    })
    if (!row) {
      throw new ExternalSystemNotFoundError('external system not found', { id, tenantId, workspaceId })
    }
    const credentials = await parseAdapterCredentials(credentialStore, row.credentials_encrypted)
    return rowToAdapterExternalSystem(row, credentials)
  }

  async function listExternalSystems(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const where = scopeWhere({ tenantId, workspaceId })
    if (input.kind) where.kind = requiredString(input.kind, 'kind')
    if (input.status) {
      const status = requiredString(input.status, 'status')
      if (!VALID_STATUSES.has(status)) {
        throw new ExternalSystemValidationError(`status must be one of ${Array.from(VALID_STATUSES).join(', ')}`, { field: 'status' })
      }
      where.status = status
    }
    const rows = await db.select(TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: input.limit,
      offset: input.offset,
    })
    const list = Array.isArray(rows) ? rows : rows?.rows ?? []
    return Promise.all(list.map(row => publicRow(credentialStore, row)))
  }

  return {
    upsertExternalSystem,
    getExternalSystem,
    getExternalSystemForAdapter,
    listExternalSystems,
  }
}

module.exports = {
  createExternalSystemRegistry,
  ExternalSystemValidationError,
  ExternalSystemNotFoundError,
  __internals: {
    TABLE,
    VALID_ROLES,
    VALID_STATUSES,
    detectCredentialFormat,
    normalizeExternalSystemInput,
    parseAdapterCredentials,
    rowToAdapterExternalSystem,
    rowToPublicExternalSystem,
  },
}
