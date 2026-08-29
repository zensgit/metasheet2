'use strict'

// ---------------------------------------------------------------------------
// External system registry — plugin-integration-core
//
// Stores PLM/ERP/DB connection metadata in integration_external_systems.
// Credentials are write-only for public reads: callers receive a stable
// fingerprint and a hasCredentials flag, never plaintext.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto')

// Per-process key for the K3 instance-identity digest (see getExternalSystemInstanceDigest).
// Deliberately NOT derived from any persisted secret: the digest is only ever compared between two
// records within one request, so a fresh random key per process gives unlinkability across
// restarts and removes the account set from anything that might leak.
const INSTANCE_DIGEST_KEY = crypto.randomBytes(32)
const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')

const TABLE = 'integration_external_systems'
const SQL_READONLY_SOURCE_KIND = 'data-source:sql-readonly'
const K3_WISE_WEBAPI_KIND = 'erp:k3-wise-webapi'
const PRIVATE_CONFIG_KEYS_BY_KIND = new Map([
  [SQL_READONLY_SOURCE_KIND, new Set(['lookupProjection'])],
  [K3_WISE_WEBAPI_KIND, new Set(['c6AcceptancePolicy'])],
])
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

class ExternalSystemConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ExternalSystemConflictError'
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
  const sanitizedConfig = sanitizeIntegrationPayload(row.config ?? {})
  const publicConfig = sanitizedConfig && typeof sanitizedConfig === 'object' && !Array.isArray(sanitizedConfig)
    ? { ...sanitizedConfig }
    : {}
  for (const key of PRIVATE_CONFIG_KEYS_BY_KIND.get(row.kind) || []) delete publicConfig[key]
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id ?? null,
    name: row.name,
    kind: row.kind,
    role: row.role,
    // Trusted-admin adapter configuration (SQL lookup identifiers and the K3 C6 acceptance policy)
    // stays available only through getExternalSystemForAdapter(); public create/get/list responses
    // omit each private subtree rather than redacting individual values or exposing its shape.
    config: publicConfig,
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

function hasPrivateConfigMutation(kind, config) {
  if (!isPlainObject(config)) return false
  const normalizedKind = typeof kind === 'string' ? kind.trim() : kind
  const privateKeys = PRIVATE_CONFIG_KEYS_BY_KIND.get(normalizedKind)
  if (!privateKeys) return false
  return Array.from(privateKeys).some((key) => Object.prototype.hasOwnProperty.call(config, key))
}

function preservePrivateConfigOnPublicUpdate(kind, existingConfig, nextConfig) {
  const privateKeys = PRIVATE_CONFIG_KEYS_BY_KIND.get(kind)
  if (!privateKeys || !isPlainObject(existingConfig) || !isPlainObject(nextConfig)) {
    return nextConfig
  }
  const merged = { ...nextConfig }
  for (const key of privateKeys) {
    if (!Object.prototype.hasOwnProperty.call(nextConfig, key) && Object.prototype.hasOwnProperty.call(existingConfig, key)) {
      merged[key] = existingConfig[key]
    }
  }
  return merged
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
    typeof db.select !== 'function' ||
    typeof db.deleteRows !== 'function' ||
    typeof db.countRows !== 'function'
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
      // Explicit null/empty-object still replaces public config. Per-kind private config keys are
      // the exception: public reads omit them, so their absence on update means preserve; a
      // trusted-admin caller clears one explicitly with a matching `{ privateKey: null }`.
      if (input.config === undefined) updateRow.config = existing.config
      else updateRow.config = preservePrivateConfigOnPublicUpdate(existing.kind, existing.config, updateRow.config)
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

  /**
   * The ADAPTER-VISIBLE CONFIG of one external system, WITHOUT decrypting anything.
   *
   * WHY THIS EXISTS AS A THIRD ACCESSOR. The two that already exist are the wrong shape for a guard:
   *   * `getExternalSystem` returns the PUBLIC projection, which deliberately deletes each kind's
   *     private config subtree (`PRIVATE_CONFIG_KEYS_BY_KIND` — `lookupProjection` for
   *     `data-source:sql-readonly`). A guard reading it cannot see a config-bound second read at all.
   *   * `getExternalSystemForAdapter` sees everything, and DECRYPTS the credentials to do it. Every
   *     B2a read fence is contracted to land before any credential reload, and its tests assert that
   *     accessor was called exactly zero times on a refusal, so a guard may not use it.
   *
   * So: the same row, the full config, and no `parseAdapterCredentials` call. It returns the config
   * and the kind ONLY — never the credentials, never the ciphertext, never a fingerprint — because
   * the one caller (the B2a object-scope resolver) needs exactly that and nothing else.
   */
  async function getExternalSystemAdapterConfig(input) {
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
    return {
      id: row.id,
      kind: row.kind,
      config: row.config ?? {},
    }
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

  // OWNER RULING 20260806 [P1] — K3 instance identity is (kind, origin, acctId), NOT origin alone.
  //
  // `sameK3Instance` compared only `new URL(baseUrl).origin`, but K3 WISE login REQUIRES acctId:
  // k3-wise-webapi-adapter.cjs throws without it and sends it in the login body. Two records on
  // ONE server pointing at DIFFERENT account sets therefore compared EQUAL — a read binding on
  // account set A could certify a write target on account set B, i.e. writing into the wrong
  // 账套. Origin equality is necessary, not sufficient.
  //
  // Computed HERE, inside the credential boundary: this module is the only one holding decrypted
  // credentials, and ONLY the digest leaves it. Callers compare digests and never see acctId, so
  // the raw account set never reaches an evidence surface.
  //
  // FAIL-CLOSED: any missing part (unknown system, unparseable baseUrl, absent acctId) yields
  // null, and null must never compare equal to null at the call site.
  async function getExternalSystemInstanceDigest(input) {
    let system
    try {
      system = await getExternalSystemForAdapter(input)
    } catch {
      return null
    }
    if (!system || typeof system.kind !== 'string' || !system.kind) return null

    const cfg = system.config && typeof system.config === 'object' ? system.config : {}
    const baseUrl = cfg.baseUrl || cfg.url
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return null
    let origin
    try {
      origin = new URL(baseUrl).origin
    } catch {
      return null
    }

    const credentials = system.credentials && typeof system.credentials === 'object' ? system.credentials : {}
    const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '')

    // REVIEW P1-2 — MIRROR the adapter's own auth-mode resolution, do not assume one mode.
    //
    // k3-wise-webapi-adapter.cjs resolves:
    //   authorityCode = firstDefined(credentials.authorityCode, credentials.authCode, config.authorityCode)
    //   authMode      = firstDefined(config.authMode, authorityCode ? 'authority-code' : null, 'login')
    // and in authority-code / token mode it authenticates with authorityCode and NEVER sends
    // acctId. Digesting acctId unconditionally therefore had two failures: a clean authority-code
    // record has no acctId at all, so the digest was null and the C6 write gate became
    // UNSATISFIABLE (a block main did not have); and two records with different authority codes but
    // the same stale acctId digested EQUAL — the owner's defect, still open, in that mode.
    //
    // The identity is whatever the record would AUTHENTICATE with.
    //
    // REVIEW P2-1 (third round) — the previous version claimed "Same resolution, same answer" and
    // was WRONG A THIRD TIME: it started at the adapter's SECOND branch. `login()` checks
    // `credentials.sessionId` FIRST (adapter :1902-1906) and short-circuits with a session header,
    // never reaching the authorityCode/acctId resolution below. Proven against this very function:
    // two records with different sessionId but the same stale acctId digested EQUAL — the owner's
    // wrong-账套 defect, alive one mode over — and a clean session-only record digested null,
    // making the write gate unsatisfiable. Both of P1-2's failure directions, one branch earlier.
    //
    // Reachable, not hypothetical: credentials are free-form JSON, and the on-prem preflight
    // treats K3_SESSION_ID as a first-class auth mode.
    //
    // I have now mis-stated this mirror three times. The lesson is not "read more carefully" — it
    // is that a claim of equivalence to another function's control flow must be checked branch by
    // branch against that function, from its FIRST statement.
    // The adapter's guard is a bare truthiness test (`if (credentials.sessionId)`), and mirroring it
    // means mirroring it EXACTLY — my "safer-looking" !==undefined/null/'' form was a strict
    // SUPERSET, so for `0`, `false`, `NaN`, `-0` the digest short-circuited on session identity
    // while login() fell through to acctId. That was a REGRESSION: at the previous head those
    // inputs digested correctly, and this delta broke them.
    if (credentials.sessionId) {
      const sessionMaterial = [system.kind, origin, `sessionId=${String(credentials.sessionId)}`]
        .map((part) => `${part.length}:${part}`).join('|')
      return crypto.createHmac('sha256', INSTANCE_DIGEST_KEY).update(sessionMaterial).digest('hex')
    }

    const authorityCode = firstDefined(credentials.authorityCode, credentials.authCode, cfg.authorityCode)
    const authMode = firstDefined(cfg.authMode, authorityCode ? 'authority-code' : null, 'login')
    let authIdentity
    if (authMode === 'authority-code' || authMode === 'authorityCode' || authMode === 'token') {
      if (authorityCode === undefined) return null
      authIdentity = `authorityCode=${String(authorityCode)}`
    } else {
      // REVIEW P2-1: this once took the first STRING while the adapter takes the first DEFINED,
      // so `{acctId: 1001, accountSet: '002'}` digested as '002' while login authenticated against
      // 账套 1001 — the digest named a different account set than the one actually used.
      const acctIdRaw = firstDefined(credentials.acctId, credentials.accountSet, credentials.accountSetId)
      if (acctIdRaw === undefined) return null
      authIdentity = `acctId=${String(acctIdRaw)}`
    }
    if (!authIdentity) return null

    // Length-prefixed parts: without this, ('ab','c') and ('a','bc') digest identically and a
    // collision could be constructed across the origin/acctId boundary.
    const material = [system.kind, origin, authIdentity].map((part) => `${part.length}:${part}`).join('|')
    // REVIEW P2-3 — RETRACTION. The first version routed this through
    // `credentialStore.fingerprint`, with a comment claiming "deployment-scoped HMAC, not
    // reversible outside it". That is FALSE on the production path: there are TWO fingerprint
    // implementations, and the host-security one calls `hashWithSecurity`, whose only primitive
    // is unkeyed `security.hash` (falling back to bare sha256). The reviewer recovered the raw
    // account set "001" from a digest in milliseconds — the search space is tiny.
    //
    // Keyed with a PER-PROCESS random key instead. Both digests in any comparison are computed in
    // the same request, in this process, and are never persisted, logged, or compared across
    // processes — so a per-process key is not a limitation, it is strictly stronger: the digest is
    // unlinkable across restarts and carries no recoverable account set even if it did leak.
    return crypto.createHmac('sha256', INSTANCE_DIGEST_KEY).update(material).digest('hex')
  }

  async function countPipelineReferences({ tenantId, workspaceId, id }) {
    const where = scopeWhere({ tenantId, workspaceId })
    const [sourcePipelineCount, targetPipelineCount] = await Promise.all([
      db.countRows('integration_pipelines', {
        ...where,
        source_system_id: id,
      }),
      db.countRows('integration_pipelines', {
        ...where,
        target_system_id: id,
      }),
    ])
    return {
      sourcePipelineCount: Number(sourcePipelineCount) || 0,
      targetPipelineCount: Number(targetPipelineCount) || 0,
    }
  }

  async function deleteExternalSystem(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const where = {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      id,
    }
    const row = await db.selectOne(TABLE, where)
    if (!row) {
      throw new ExternalSystemNotFoundError('external system not found', { id, tenantId, workspaceId })
    }

    const references = await countPipelineReferences({ tenantId, workspaceId, id })
    const referencedPipelineCount = references.sourcePipelineCount + references.targetPipelineCount
    if (referencedPipelineCount > 0) {
      throw new ExternalSystemConflictError('external system is used by pipelines', {
        id,
        tenantId,
        workspaceId,
        referencedPipelineCount,
        ...references,
      })
    }

    const deleted = await publicRow(credentialStore, row)
    const deleteResult = await db.deleteRows(TABLE, where)
    const deletedCount = Array.isArray(deleteResult)
      ? deleteResult.length
      : Array.isArray(deleteResult?.rows)
        ? deleteResult.rows.length
        : Number(deleteResult) || 0
    if (deletedCount < 1) {
      throw new ExternalSystemNotFoundError('external system not found during delete', { id, tenantId, workspaceId })
    }
    return {
      deleted: true,
      system: deleted,
    }
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
    getExternalSystemAdapterConfig,
    getExternalSystemForAdapter,
    getExternalSystemInstanceDigest,
    deleteExternalSystem,
    listExternalSystems,
  }
}

module.exports = {
  createExternalSystemRegistry,
  ExternalSystemValidationError,
  ExternalSystemNotFoundError,
  ExternalSystemConflictError,
  hasPrivateConfigMutation,
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
