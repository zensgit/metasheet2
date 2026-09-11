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
// Config keys the REGISTRY owns and a payload may never assert. `dataSourceOwnerId` is stamped
// server-side after the binder validates config.dataSourceId (P2-A); since the update path now
// MERGES a payload over the stored config, an accepted client value would overwrite the stored
// stamp and re-attribute somebody else's pin. Stripped at the single normalize choke point.
const SERVER_OWNED_CONFIG_KEYS = new Set(['dataSourceOwnerId'])

class ExternalSystemValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ExternalSystemValidationError'
    this.details = details
    if (typeof details.code === 'string' && details.code.trim()) this.code = details.code.trim()
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
    // Same opt-in as ExternalSystemValidationError above: `inferErrorCode` (lib/http-routes.cjs)
    // prefers `error.code` over `error.name`, so a conflict that needs a STABLE wire code can ask
    // for one. Callers that pass no `details.code` keep emitting `ExternalSystemConflictError`
    // verbatim, exactly as before.
    if (typeof details.code === 'string' && details.code.trim()) this.code = details.code.trim()
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

function stripServerOwnedConfigKeys(config) {
  if (!isPlainObject(config)) return config
  let cleaned = null
  for (const key of SERVER_OWNED_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue
    if (!cleaned) cleaned = { ...config }
    delete cleaned[key]
  }
  return cleaned || config
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
    // Preserve omission for PATCH semantics. `null` is distinct: canonical SQL bindings may not
    // be cleared through the API, while a legacy pre-cutover row can remain null when the field is
    // omitted during an unrelated update.
    connectionId: input.connectionId === undefined
      ? undefined
      : optionalString(input.connectionId, 'connectionId'),
    tenantId: requiredString(input.tenantId, 'tenantId'),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    projectId: optionalString(input.projectId, 'projectId'),
    name: requiredString(input.name, 'name'),
    kind: requiredString(input.kind, 'kind'),
    role,
    config: stripServerOwnedConfigKeys(jsonObject(input.config, 'config')),
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

// Mirrors `lib/db.cjs`'s own `select()` defaults/clamp (`limit = 1000`, `Math.min(limit, 10000)`,
// `offset >= 0`). Duplicated here for ONE reason: the non-null-hint list runs TWO scoped queries and
// has to paginate their MERGE in memory, which is only equivalent to the single-query behaviour if
// this layer windows each branch with the same numbers the DB layer would have applied anyway.
const DB_SELECT_DEFAULT_LIMIT = 1000
const DB_SELECT_MAX_LIMIT = 10000

function normalizeListLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, DB_SELECT_MAX_LIMIT) : DB_SELECT_DEFAULT_LIMIT
}

function normalizeListOffset(offset) {
  return Number.isInteger(offset) && offset >= 0 ? offset : 0
}

function toRowArray(result) {
  if (Array.isArray(result)) return result
  return Array.isArray(result?.rows) ? result.rows : []
}

// `created_at DESC`, the order the single-scope query already asks the DB for, re-applied to the
// merge of two scoped queries. Rows arrive as `Date` (pg) or ISO strings (tests/other drivers), so
// both are reduced to a number; anything unparseable sorts oldest rather than throwing.
function createdAtSortKey(row) {
  const raw = row ? row.created_at : null
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
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
    connectionId: row.connection_id ?? null,
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
    connectionId: row.connection_id ?? null,
    // Server-owned cutover evidence. It is adapter-policy input only and is intentionally omitted
    // from public create/get/list responses.
    legacyConnectionFallbackEligible: row.legacy_connection_fallback_eligible === true,
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

// PATCH semantics for `config` on update — the fix for the bridge lossy save.
//
// This used to be `preservePrivateConfigOnPublicUpdate`, which re-attached only the per-kind
// PRIVATE keys (lookupProjection / c6AcceptancePolicy) and let every other absent key be dropped
// by a wholesale replace. That was silently destructive for the data-source bridge kinds, whose
// edit form rebuilds `config` from the two picker fields it owns: saving a rename erased
// `config.schema` (the connection's default SQL schema — the readonly source adapter reads it for
// listObjects and to qualify a bare object name), and an API caller that did not re-send the
// pointer erased `config.dataSourceId` together with its server stamp.
//
// The rule is now uniform for every key and every kind: an ABSENT key is inherited from the stored
// config, a PRESENT key replaces it. The private-key convention is unchanged, it is just no longer
// special — an explicit `{ key: null }` still clears one, and that stays the ONLY way any config
// key gets cleared through this path. Omission can no longer destroy anything.
//
// Top level only, deliberately. A nested value is replaced whole, so an admin narrowing
// `lookupProjection` or `objects.material.schema` gets exactly the object they sent instead of a
// union with stale sub-keys that no editor could ever remove.
function patchConfig(existingConfig, nextConfig) {
  if (!isPlainObject(existingConfig) || !isPlainObject(nextConfig)) return nextConfig
  return { ...existingConfig, ...nextConfig }
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

// `dataSourceBinder` (P2-A referential-integrity fix): the host's data-source facade
// (context.api.dataSources), whose assertReferenceable(dataSourceId, principal) validates that the
// AUTHENTICATED principal owns the referenced core data source. Every upsert that asserts a
// config.dataSourceId binding must pass it; on success the registry stamps
// config.dataSourceOwnerId = principal SERVER-SIDE (client-sent values are discarded), which is what
// the core delete guard counts (DataSourceManager.countExternalSystemReferences — owner-attributed).
// Fail-closed: a dataSourceId-bearing config with no wired binder, no principal, or a refusing
// binder is rejected — a binding nobody could ever read through (the facade authorizes every read
// with the owner principal; a pipeline's runtime principal is its creator) must not be persisted,
// and an unvalidated pin must never be able to deny the source owner their delete.
function createExternalSystemRegistry({
  db,
  credentialStore,
  idGenerator = crypto.randomUUID,
  dataSourceBinder,
  connectionResolver,
} = {}) {
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

  // P2-A bind-time validation + server-side attribution stamp. `config` is the EFFECTIVE new
  // config about to persist (create payload, or the private-key-merged update payload); `rawInput`
  // carries the authenticated principal the route/host attached. Only runs when the caller is
  // ASSERTING a config (an update that preserves the stored config verbatim — e.g. the
  // test-result persist — neither re-validates nor needs a principal).
  async function withValidatedDataSourceBinding(config, rawInput) {
    if (!isPlainObject(config)) return config
    const dataSourceId = typeof config.dataSourceId === 'string' ? config.dataSourceId.trim() : ''
    if (!dataSourceId) {
      // No binding asserted: discard any client-sent attribution stamp — it is
      // server-owned metadata and must never be forgeable.
      if (Object.prototype.hasOwnProperty.call(config, 'dataSourceOwnerId')) {
        const cleaned = { ...config }
        delete cleaned.dataSourceOwnerId
        return cleaned
      }
      return config
    }
    const principal = typeof rawInput.principal === 'string' ? rawInput.principal.trim() : ''
    if (!principal) {
      throw new ExternalSystemValidationError(
        'config.dataSourceId binding requires an authenticated principal',
        { field: 'config.dataSourceId' },
      )
    }
    if (!dataSourceBinder || typeof dataSourceBinder.assertReferenceable !== 'function') {
      // Fail CLOSED: an unvalidated pin could deny the core source's owner their delete.
      throw new ExternalSystemValidationError(
        'config.dataSourceId binding requires the host data-source binder (context.api.dataSources); it is not wired',
        { field: 'config.dataSourceId' },
      )
    }
    try {
      await dataSourceBinder.assertReferenceable(dataSourceId, principal)
    } catch (err) {
      // Re-raise the facade's uniform wording verbatim (deleted vs not-yours
      // indistinguishable — no existence leak), as a validation error the
      // routes map to a clean 4xx.
      throw new ExternalSystemValidationError(
        err && err.message ? String(err.message) : 'config.dataSourceId is not referenceable by this principal',
        { field: 'config.dataSourceId' },
      )
    }
    // Server-side stamp: the principal was just validated as the source's owner.
    // The core delete guard counts ONLY rows carrying this stamp
    // (DataSourceManager.countExternalSystemReferences — owner-attributed).
    return { ...config, dataSourceOwnerId: principal }
  }

  // The effective config for an update that DID supply one: the payload patched over the stored
  // config (see patchConfig), then the P2-A binding rules applied to the result.
  //
  // Binding re-validation keys off the PAYLOAD, not the merged result. A payload that asserts
  // `dataSourceId` is claiming the binding, so it is validated against the authenticated principal
  // and re-stamped exactly as before. A payload that is silent about it inherits the stored pointer
  // and the stored stamp verbatim — the same trust level as an update that omits `config`
  // altogether (which has always preserved the stored binding without re-validating). Anything else
  // would mean a co-worker renaming a colleague's bridge either gets refused or silently steals the
  // attribution the core delete guard counts.
  async function resolveUpdatedConfig(existing, nextConfig, rawInput) {
    const merged = patchConfig(existing.config, nextConfig)
    if (!isPlainObject(merged)) return merged
    // `nextConfig` is normalized input, so a client-sent dataSourceOwnerId is already gone; what
    // remains here is the stored stamp.
    if (isPlainObject(nextConfig) && Object.prototype.hasOwnProperty.call(nextConfig, 'dataSourceId')) {
      return withValidatedDataSourceBinding(merged, rawInput)
    }
    const inheritedPointer = typeof merged.dataSourceId === 'string' ? merged.dataSourceId.trim() : ''
    if (inheritedPointer) return merged
    // A stored stamp with no pointer left to attribute is not inheritable.
    if (Object.prototype.hasOwnProperty.call(merged, 'dataSourceOwnerId')) {
      const cleaned = { ...merged }
      delete cleaned.dataSourceOwnerId
      return cleaned
    }
    return merged
  }

  // Drops the LEGACY POINTER only. It used to drop the attribution stamp with it, and that was the
  // first of the two reasons the stock-prep pull's read-identity delegation never fired on a
  // canonical binding: every canonical insert/update ran through here, so a row bound by
  // `connection_id` could not carry a `dataSourceOwnerId` even in principle. The stamp is NOT a
  // property of the legacy pointer — it is the answer to "who did the host authorize as this
  // connection's owner at bind time", which a canonical binding proves exactly as strongly (see
  // `resolveCanonicalBindingOwner`). Attribution is re-decided by that function immediately after
  // every call here, so nothing survives from a payload merely because this stopped deleting it.
  function withoutLegacyDataSourcePointer(config) {
    if (!isPlainObject(config)) return config
    const cleaned = { ...config }
    delete cleaned.dataSourceId
    return cleaned
  }

  /**
   * THE SERVER-HELD OWNER OF A CANONICAL (`connection_id`) BINDING.
   *
   * WHY THIS IS AS TRUSTWORTHY AS THE LEGACY STAMP. `withValidatedDataSourceBinding` stamps the
   * legacy pointer's owner only after `dataSourceBinder.assertReferenceable(id, principal)` returns
   * — i.e. after `DataSourceManager.assertAccess` accepted that principal as the source's owner by
   * STRICT EQUALITY. A canonical bind proves the identical fact through the identical choke point:
   * `validateCanonicalConnectionBinding` -> `connectionResolver.resolve` -> the host facade's
   * `resolveConnectionRegistration` -> the same `assertAccess`. So `proven === true` here means the
   * principal WAS the connection's owner a few lines ago, on the host's own authority.
   *
   * WHAT IT WILL NOT DO:
   *   * it never reads an owner out of the payload — `SERVER_OWNED_CONFIG_KEYS` already stripped
   *     `dataSourceOwnerId` at the normalize choke point, and this function only ever writes either
   *     the just-proven principal or the value already in STORAGE;
   *   * an update that does NOT re-assert the connection inherits the stored stamp verbatim, so a
   *     colleague renaming a bridge neither steals nor destroys the attribution;
   *   * with nothing proven and nothing stored it writes NOTHING, leaving the row exactly as it was.
   */
  function resolveCanonicalBindingOwner({ config, storedConfig, principal, proven }) {
    if (!isPlainObject(config)) return config
    const provenOwner = proven && typeof principal === 'string' ? principal.trim() : ''
    if (provenOwner) return { ...config, dataSourceOwnerId: provenOwner }
    const stored = isPlainObject(storedConfig) && typeof storedConfig.dataSourceOwnerId === 'string'
      ? storedConfig.dataSourceOwnerId.trim()
      : ''
    if (stored) return { ...config, dataSourceOwnerId: stored }
    if (Object.prototype.hasOwnProperty.call(config, 'dataSourceOwnerId')) {
      const cleaned = { ...config }
      delete cleaned.dataSourceOwnerId
      return cleaned
    }
    return config
  }

  function requestedConnectionId(normalized, existing) {
    if (normalized.kind !== SQL_READONLY_SOURCE_KIND) {
      if (normalized.connectionId !== undefined && normalized.connectionId !== null) {
        throw new ExternalSystemValidationError(
          'connectionId is only supported for data-source:sql-readonly bindings in this phase',
          { field: 'connectionId' },
        )
      }
      return null
    }

    if (existing) {
      if (normalized.connectionId === undefined) return existing.connection_id ?? null
      if (normalized.connectionId === null) {
        throw new ExternalSystemValidationError(
          'SQL read-only bindings cannot clear their canonical connectionId',
          { field: 'connectionId' },
        )
      }
      return normalized.connectionId
    }

    // Compatibility at the request boundary only: the current picker still names the selected
    // Connection as config.dataSourceId. New storage is canonical regardless — only connection_id
    // is written and the legacy pointer is removed from config before INSERT.
    const legacyPointer = isPlainObject(normalized.config)
      ? optionalString(normalized.config.dataSourceId, 'config.dataSourceId')
      : null
    const connectionId = normalized.connectionId ?? legacyPointer
    if (!connectionId) {
      throw new ExternalSystemValidationError(
        'connectionId is required for a new data-source:sql-readonly binding',
        { field: 'connectionId' },
      )
    }
    return connectionId
  }

  async function validateCanonicalConnectionBinding(binding, rawInput) {
    if (!connectionResolver || typeof connectionResolver.resolve !== 'function') {
      throw new ExternalSystemValidationError(
        'canonical connection resolution is unavailable',
        { field: 'connectionId', code: 'CONNECTION_RESOLUTION_UNAVAILABLE' },
      )
    }
    try {
      await connectionResolver.resolve(binding, {
        tenantId: binding.tenantId,
        workspaceId: binding.workspaceId,
        principal: rawInput.principal,
        // Default to service. Only an authenticated HTTP surface explicitly
        // stamps user delegation; registry/communication callers cannot gain
        // tenantless legacy access by omission.
        runAs: rawInput.runAs === 'user' ? 'user' : 'service',
      })
    } catch (error) {
      throw new ExternalSystemValidationError(
        error instanceof Error ? error.message : 'canonical connection validation failed',
        {
          field: 'connectionId',
          code: error && typeof error.code === 'string' ? error.code : 'CONNECTION_RESOLUTION_FAILED',
        },
      )
    }
  }

  // SERVER-SIDE REFUSAL for the one write shape the LIST's read fallback newly puts in front of a
  // caller: an id-carrying upsert (the 工作台's 编辑 / 停用 / 启用 all send `{ ...scope, id, name,
  // kind, role, status }`) whose hint misses, against a row this caller CAN read — the SAME tenant's
  // tenant-wide (`workspace_id IS NULL`) row with that id.
  //
  // WHAT USED TO HAPPEN, verified in memory against this module with a db that enforces migration
  // 057's two constraints: `findExisting` misses, the INSERT branch below re-uses the SAME id
  // (`id: normalized.id || idGenerator()`), and `id TEXT PRIMARY KEY` (057:20) raises 23505 — an
  // UNTYPED 500 carrying raw driver text, with the boundary living in the database rather than
  // here. On any db handle that does not enforce that key (every hand-written fake in __tests__,
  // and any future non-PG driver) the same call SILENTLY writes a second row with a DUPLICATE id.
  // So the rule was real but unstated, and untestable at this layer.
  //
  // NOW: a stable 409 (`/Conflict/` -> 409 in `inferHttpStatus`) with a fixed code. This only ever
  // TIGHTENS — the same call previously errored too, just untypeably, or corrupted the table. No
  // scope is widened: the write still lands on, and only on, its own exact scope.
  //
  // SCOPE OF THE LOOKUP, exactly one step. It asks only about `workspace_id IS NULL` in the
  // CALLER'S OWN tenant — precisely the row `selectScopedRow`/`listExternalSystems` already hand
  // this caller — so it discloses nothing new. It deliberately does NOT ask "does this id exist
  // anywhere", which would answer for other tenants and other workspaces that this caller cannot
  // read; those keep the pre-existing primary-key behaviour.
  //
  // NOT IN SCOPE, on purpose: `POST /external-systems/:id/test`. `persistExternalSystemTestResult`
  // (lib/http-routes.cjs, #5534) re-addresses its write to the row's OWN scope BEFORE calling this
  // function, so `findExisting` hits and this guard never sees it. That write is intended to reach
  // a fallback-read row and does; see L-11 in
  // __tests__/external-systems-list-workspace-fallback.test.cjs.
  async function assertHintedIdDoesNotTargetTenantWideRow(normalized) {
    if (!normalized.id) return
    // A null hint already searched `workspace_id IS NULL`, so a miss there means the row is absent,
    // not out of scope — nothing to refuse.
    if (normalized.workspaceId === null) return
    const tenantWide = await db.selectOne(TABLE, {
      tenant_id: normalized.tenantId,
      workspace_id: null,
      id: normalized.id,
    })
    if (!tenantWide) return
    throw new ExternalSystemConflictError('external system belongs to the tenant-wide scope', {
      code: 'EXTERNAL_SYSTEM_SCOPE_MISMATCH',
      id: normalized.id,
      // Both are the caller's own request values, echoed back so an operator can see WHICH two
      // scopes disagreed. Nothing from the stored row is disclosed.
      requestedWorkspaceId: normalized.workspaceId,
      rowWorkspaceId: null,
    })
  }

  async function upsertExternalSystem(input) {
    const normalized = normalizeExternalSystemInput(input)
    const existing = await findExisting(normalized)
    if (!existing) await assertHintedIdDoesNotTargetTenantWideRow(normalized)
    const connectionId = requestedConnectionId(normalized, existing)
    // A SQL read-only Binding references the platform Connection that owns all
    // physical credentials. Accepting a second credential document here would
    // recreate the split secret store PR-1 is removing. Explicit null remains
    // allowed solely to scrub a pre-cutover duplicate on update.
    if (
      normalized.kind === SQL_READONLY_SOURCE_KIND
      && normalized.credentials !== undefined
      && normalized.credentials !== null
    ) {
      throw new ExternalSystemValidationError(
        'data-source:sql-readonly credentials belong to the canonical Connection',
        { field: 'credentials', code: 'CONNECTION_BINDING_CREDENTIALS_FORBIDDEN' },
      )
    }
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
      connection_id: connectionId,
      legacy_connection_fallback_eligible: existing?.legacy_connection_fallback_eligible === true,
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
      // A supplied `config` is a PATCH over the stored one, not a replacement (see patchConfig):
      // absent keys are inherited, so no edit form can silently drop a key it does not render,
      // and `{ key: null }` remains the one explicit way to clear one.
      if (input.config === undefined) updateRow.config = existing.config
      else updateRow.config = await resolveUpdatedConfig(existing, updateRow.config, input)
      if (input.capabilities === undefined) updateRow.capabilities = existing.capabilities
      if (normalized.kind === SQL_READONLY_SOURCE_KIND && connectionId !== null) {
        const reassertsConnection = normalized.connectionId !== undefined
          || (isPlainObject(input.config) && Object.prototype.hasOwnProperty.call(input.config, 'dataSourceId'))
        if (reassertsConnection) {
          await validateCanonicalConnectionBinding({
            ...rowToAdapterExternalSystem({ ...existing, ...updateRow }),
            connectionId,
          }, input)
        }
        // Rows created after cutover are canonical-only. An old picker may still submit the
        // compatibility alias, but it must not re-introduce the legacy storage shape. Migrated
        // rows keep their pointer because the explicit fallback marker is their rollback proof.
        if (existing.legacy_connection_fallback_eligible !== true) {
          updateRow.config = withoutLegacyDataSourcePointer(updateRow.config)
        }
        // ATTRIBUTION LAST, on the whole canonical branch (migrated rows included — they resolve
        // through the same facade). Re-asserting the connection re-proves the owner; not
        // re-asserting inherits what storage already holds.
        updateRow.config = resolveCanonicalBindingOwner({
          config: updateRow.config,
          storedConfig: existing.config,
          principal: input && typeof input.principal === 'string' ? input.principal : '',
          proven: reassertsConnection,
        })
      }
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

    let insertConfig = normalized.config
    if (normalized.kind === SQL_READONLY_SOURCE_KIND) {
      await validateCanonicalConnectionBinding({
        id: normalized.id || null,
        tenantId: normalized.tenantId,
        workspaceId: normalized.workspaceId,
        kind: normalized.kind,
        connectionId,
        config: insertConfig,
      }, input)
      insertConfig = withoutLegacyDataSourcePointer(insertConfig)
      // The insert branch ALWAYS validated the binding a line above, so the principal is proven.
      insertConfig = resolveCanonicalBindingOwner({
        config: insertConfig,
        storedConfig: null,
        principal: input && typeof input.principal === 'string' ? input.principal : '',
        proven: true,
      })
    } else {
      insertConfig = await withValidatedDataSourceBinding(insertConfig, input)
    }
    const insertRow = {
      id: normalized.id || idGenerator(),
      ...baseRow,
      config: insertConfig,
      credentials_encrypted: credentialsEncrypted === undefined ? null : credentialsEncrypted,
    }
    const rows = await db.insertOne(TABLE, insertRow)
    const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0]
    return publicRow(credentialStore, row || insertRow)
  }

  // Scoped BY-ID read shared by the four read accessors below (public get, adapter-config, adapter
  // load, sealed snapshot). Exact (tenant, workspace, id) first. When the caller carries a workspace
  // hint and misses, fall back ONCE to the SAME tenant's tenant-wide row (workspace_id IS NULL).
  //
  // WHY: single-tenant on-prem deployments provision sources tenant-wide, while the web workbench
  // carries a workspace hint (URL/localStorage, in practice often the tenant id) and the sealed
  // mvp-persist step derives workspace=null from the principal (tokens carry no workspace claim).
  // Without this the two halves of ONE pull disagree on scope and dry-run/apply 404 with
  // ExternalSystemNotFoundError. What does NOT change, INSIDE THIS FUNCTION: tenant_id must still
  // match (the fallback query carries the caller's tenant), a workspace-scoped row is never reached
  // from another workspace or from a null `workspaceId` ARGUMENT, and writes/delete keep their
  // exact scope. LIST NO LONGER DOES: since the 选源面板 fix it widens the SAME one step as this
  // function, and marks each row it reached that way — see `listExternalSystems`'s head comment
  // below. This sentence used to say "writes/list/delete"; it was the only contract text #5471 left
  // for later callers, so it is corrected here rather than left to contradict the code.
  //
  // REVERSE POINTER (stock-preparation, F3): "a null hint never widens" is an invariant of what THIS
  // FUNCTION does with the `workspaceId` it is handed — it says nothing about what that argument
  // IS on any given call. `loadTableActionSourceAdapter` (plugin-integration-core/lib/http-routes.cjs)
  // can substitute a server-derived NON-null hint (the stock-prep source binding's own
  // `matchedWorkspaceId`, from that store's null-workspace scope fallback) in place of a caller whose
  // OWN request carried none — so a request that looks hint-less end to end may still arrive here
  // with a real `workspaceId`, and this function then does its own ordinary non-null-hint-miss
  // widening for it, exactly as for any other caller. That is a decision made ABOVE this function, on
  // its own inputs; nothing here changes to accommodate it.
  //
  // Returns the workspace the row was actually matched under, so downstream policy (the
  // connection resolver) sees the row's own scope rather than the caller's hint.
  async function selectScopedRow({ tenantId, workspaceId, id }) {
    const exact = await db.selectOne(TABLE, { tenant_id: tenantId, workspace_id: workspaceId, id })
    if (exact) return { row: exact, matchedWorkspaceId: workspaceId }
    if (workspaceId === null) return { row: null, matchedWorkspaceId: workspaceId }
    const tenantWide = await db.selectOne(TABLE, { tenant_id: tenantId, workspace_id: null, id })
    return { row: tenantWide, matchedWorkspaceId: tenantWide ? null : workspaceId }
  }

  async function getExternalSystem(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const { row } = await selectScopedRow({ tenantId, workspaceId, id })
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
   * So: the same row, the full config, and no `parseAdapterCredentials` call. It returns the kind,
   * the canonical `connectionId` and the config ONLY — never the credentials, never the ciphertext,
   * never a fingerprint — because its two callers (the B2a object-scope resolver, and the
   * stock-prep pull's read-identity resolution) need exactly that and nothing else. Both are
   * GUARDS that must run BEFORE the credential/connection resolution they gate, which is precisely
   * why neither may use `getExternalSystemForAdapter`.
   */
  async function getExternalSystemAdapterConfig(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const { row } = await selectScopedRow({ tenantId, workspaceId, id })
    if (!row) {
      throw new ExternalSystemNotFoundError('external system not found', { id, tenantId, workspaceId })
    }
    return {
      id: row.id,
      kind: row.kind,
      // The canonical Connection reference, so a guard can tell a canonical binding from a legacy
      // one WITHOUT resolving either. `publicRow` already returns this field, so it discloses
      // nothing new; what it buys is that the stock-prep pull's read-identity resolution can read
      // the binding SHAPE before the connection resolution that the shape decides the outcome of.
      connectionId: row.connection_id ?? null,
      config: row.config ?? {},
    }
  }

  async function getExternalSystemForAdapter(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const { row, matchedWorkspaceId } = await selectScopedRow({ tenantId, workspaceId, id })
    if (!row) {
      throw new ExternalSystemNotFoundError('external system not found', { id, tenantId, workspaceId })
    }
    const unresolved = rowToAdapterExternalSystem(row)
    let resolved = unresolved
    if (unresolved.kind === SQL_READONLY_SOURCE_KIND) {
      if (!connectionResolver || typeof connectionResolver.resolve !== 'function') {
        throw new ExternalSystemValidationError(
          'canonical connection resolution is unavailable',
          { field: 'connectionId', code: 'CONNECTION_RESOLUTION_UNAVAILABLE' },
        )
      }
      try {
        resolved = await connectionResolver.resolve(unresolved, {
          tenantId,
          workspaceId: matchedWorkspaceId,
          principal: input?.principal,
          runAs: input?.runAs,
        })
      } catch (error) {
        throw new ExternalSystemValidationError(
          error instanceof Error ? error.message : 'connection resolution failed',
          {
            field: 'connectionId',
            code: error && typeof error.code === 'string' ? error.code : 'CONNECTION_RESOLUTION_FAILED',
          },
        )
      }
      // Never consult the Binding credential column for a canonical/legacy SQL
      // Connection. A migrated row may retain dormant ciphertext for rollback,
      // but only /data-sources is an executable credential authority.
      return resolved
    }
    const credentials = await parseAdapterCredentials(credentialStore, row.credentials_encrypted)
    return credentials === undefined ? resolved : { ...resolved, credentials }
  }

  // This is intentionally a separate, internal-only credential boundary. Ordinary
  // adapters never receive physical SQL credentials from a Binding row or from the
  // Connection facade; the sealed snapshot runtime is the sole consumer of this
  // ephemeral projection.
  async function getExternalSystemForSealedSnapshot(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const { row, matchedWorkspaceId } = await selectScopedRow({ tenantId, workspaceId, id })
    if (!row) {
      throw new ExternalSystemNotFoundError('external system not found', { id, tenantId, workspaceId })
    }
    const unresolved = rowToAdapterExternalSystem(row)
    if (unresolved.kind !== SQL_READONLY_SOURCE_KIND) {
      throw new ExternalSystemValidationError(
        'sealed snapshot source must be a SQL read-only binding',
        { code: 'CONNECTION_SEALED_SNAPSHOT_KIND_UNSUPPORTED' },
      )
    }
    if (!connectionResolver || typeof connectionResolver.resolveSealedSqlServer !== 'function') {
      throw new ExternalSystemValidationError(
        'sealed snapshot connection resolution is unavailable',
        { field: 'connectionId', code: 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE' },
      )
    }
    try {
      return await connectionResolver.resolveSealedSqlServer(unresolved, {
        tenantId,
        workspaceId: matchedWorkspaceId,
        principal: input?.principal,
        runAs: input?.runAs,
      })
    } catch (error) {
      throw new ExternalSystemValidationError(
        error instanceof Error ? error.message : 'sealed snapshot connection resolution failed',
        {
          field: 'connectionId',
          code: error && typeof error.code === 'string' ? error.code : 'CONNECTION_SEALED_SNAPSHOT_FAILED',
        },
      )
    }
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

  // LIST, with the SAME non-null-hint widening `selectScopedRow` already does for a by-id read.
  //
  // THE GAP (#5471 fixed the by-id read only). The web workbench carries a workspace hint on every
  // request (`localStorage.workspaceId`, in practice the tenant id — useAuth.ts writes it), while
  // on-prem sources are provisioned TENANT-WIDE (`workspace_id IS NULL`; the delivery guide's bare
  // `x-tenant-id` POST lands there). A by-id read of such a source already succeeds from a hinted
  // caller — that is exactly what `selectScopedRow` widens — but the LIST was still an exact match,
  // so 工作台里选源 rendered zero candidates and reported the SAME source as `not_found` /
  // "源不可用" while a dry-run through the very same registry read it fine. The two halves of one
  // screen disagreed about which rows exist.
  //
  // WHAT WIDENS, AND WHAT DOES NOT. A non-null hint returns "this workspace's rows ∪ the SAME
  // tenant's tenant-wide (`workspace_id IS NULL`) rows", deduped by id, still `created_at DESC`,
  // with the workspace-scoped row winning ties (the merge puts the exact branch first and the sort
  // is stable). What does NOT change: BOTH queries carry the caller's own `tenant_id`, so no
  // cross-tenant row is ever reachable; a hint is NEVER widened to ANOTHER non-null workspace; a
  // `null` hint keeps its exact `workspace_id IS NULL` scope and issues exactly ONE query, as
  // before; and the WRITE paths (`findExisting` for upsert, `deleteExternalSystem`,
  // `countPipelineReferences`) keep their exact `scopeWhere` so a hint-carrying write still lands
  // on — and only on — its own row.
  //
  // DISCLOSURE. Every row this adds to a hinted caller's list is one that caller can ALREADY fetch
  // by id through `getExternalSystem` / `getExternalSystemAdapterConfig` (same tenant, same
  // fallback, since #5471), at the same permission tier; the projection is otherwise unchanged
  // (`publicRow` — private per-kind config subtrees are still deleted). So this widens WHICH rows
  // are listed, never WHAT is told about a row nor WHO may ask.
  //
  // THE PRICE OF THE ASYMMETRY, AND WHERE IT IS PAID. The list widens; `findExisting` (upsert) and
  // `deleteExternalSystem` do not. At least one caller renders this list as a WRITABLE inventory
  // (apps/web 工作台 连接管理: 编辑 / 停用 / 启用 / 删除 per row), so a fallback-reached row now
  // appears under buttons that cannot address it. WHAT THOSE BUTTONS ACTUALLY DO — measured, not
  // assumed (L-07/L-10 of __tests__/external-systems-list-workspace-fallback.test.cjs pin all three):
  //   * 编辑 / 停用 / 启用 send the ROW'S OWN id, so `findExisting` takes its id branch, misses in
  //     the caller's exact scope, and `assertHintedIdDoesNotTargetTenantWideRow` (above) REFUSES:
  //     409 `EXTERNAL_SYSTEM_SCOPE_MISMATCH`. Before that guard the INSERT branch re-used the id and
  //     died on 057's `id TEXT PRIMARY KEY` (23505 -> untyped 500). Either way the tenant-wide row
  //     is untouched — it is an ERROR, never a silent success.
  //   * 删除 raises ExternalSystemNotFoundError -> 404, unchanged.
  //   * Only a NAME-ONLY upsert (no id — a direct API/script call, NOT these buttons) forks a
  //     second, same-named workspace row, which 057's (tenant_id, coalesce(workspace_id,''), name)
  //     unique index permits. Earlier revisions of this comment attributed that fork to 停用; the
  //     probe says otherwise, and the sentence is corrected here rather than left to mislead.
  // NOT A CLAIM OF IMMUNITY: `persistExternalSystemTestResult` (lib/http-routes.cjs, #5534)
  // deliberately re-addresses its write to the ROW'S own scope, so POST /external-systems/:id/test
  // from a hinted caller DOES update this row's status / last_tested_at / last_error (a failed test
  // flips active -> error). Any UI wording derived from this asymmetry must say that too — calling
  // such a row 「只读」 flat out is false.
  //
  // NO NEW WIRE FIELD. An earlier revision tagged every fallback-branch row `scopeFallback: true`.
  // It is dropped, for three reasons: (1) its stated justification was the silent-fork story above,
  // which is false; (2) it is fully derivable by the consumer from `workspaceId` — already in this
  // projection — plus the hint its own write will carry, and the derivation is STRICTLY more
  // accurate, because the tag is pinned to the fetch while the write's hint is live (in the
  // workbench, editing the workspace box does not reload the list, so a stale tag would keep
  // refusing the very tenant-level write the UI just told the operator to go and make); (3) this
  // plugin already uses the name `scopeFallback` for a DIFFERENT, string-valued, internal-only
  // annotation (lib/stock-preparation-source-binding-store.cjs; its routes test asserts
  // "scopeFallback never reaches the wire").
  //
  // Widening the WRITES instead would have been the other repair; it is deliberately NOT taken
  // here, because a hinted write silently retargeting a tenant-wide row is a scope decision for the
  // owner, not a display bug.
  async function listExternalSystems(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const filters = {}
    if (input.kind) filters.kind = requiredString(input.kind, 'kind')
    if (input.status) {
      const status = requiredString(input.status, 'status')
      if (!VALID_STATUSES.has(status)) {
        throw new ExternalSystemValidationError(`status must be one of ${Array.from(VALID_STATUSES).join(', ')}`, { field: 'status' })
      }
      filters.status = status
    }
    const selectScope = (scopeWorkspaceId, limit, offset) => db.select(TABLE, {
      // `tenantId` is the caller's, on BOTH branches. Removing it from either one is the
      // cross-tenant hole the mutation probe in external-systems-list-workspace-fallback.test.cjs
      // asserts against.
      where: { ...scopeWhere({ tenantId, workspaceId: scopeWorkspaceId }), ...filters },
      orderBy: ['created_at', 'DESC'],
      limit,
      offset,
    })

    const publicRows = (rows) => Promise.all(rows.map(row => publicRow(credentialStore, row)))

    if (workspaceId === null) {
      // Unchanged path: a null hint never widens (it would otherwise reach every workspace's rows).
      return publicRows(toRowArray(await selectScope(null, input.limit, input.offset)))
    }

    const limit = normalizeListLimit(input.limit)
    const offset = normalizeListOffset(input.offset)
    // Each branch is fetched to the END of the requested page (offset+limit) and the page is cut
    // from the MERGE, because neither branch alone knows where the page boundary falls.
    const windowSize = Math.min(offset + limit, DB_SELECT_MAX_LIMIT)
    const [exactRows, tenantWideRows] = await Promise.all([
      selectScope(workspaceId, windowSize, 0),
      selectScope(null, windowSize, 0),
    ])

    const merged = []
    const seenIds = new Set()
    // Exact branch first, so a row present in BOTH is kept in the scope the caller writes in.
    for (const rows of [exactRows, tenantWideRows]) {
      for (const row of toRowArray(rows)) {
        if (!row) continue
        const id = row.id
        if (id !== undefined && id !== null) {
          if (seenIds.has(id)) continue
          seenIds.add(id)
        }
        merged.push(row)
      }
    }
    // Array.prototype.sort is stable, so equal `created_at` keeps the exact-scope row ahead of the
    // tenant-wide one.
    merged.sort((left, right) => createdAtSortKey(right) - createdAtSortKey(left))
    // The projection is byte-for-byte the single-query one: same `publicRow`, no added field. What
    // a consumer needs in order to tell "my own writes cannot reach this row" is `workspaceId`,
    // which `publicRow` has always carried.
    return publicRows(merged.slice(offset, offset + limit))
  }

  return {
    upsertExternalSystem,
    getExternalSystem,
    getExternalSystemAdapterConfig,
    getExternalSystemForAdapter,
    getExternalSystemForSealedSnapshot,
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
