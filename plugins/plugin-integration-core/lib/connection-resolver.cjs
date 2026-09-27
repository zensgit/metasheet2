'use strict'

// Connection/binding resolution policy. This module deliberately has no database, adapter, or
// credential dependency: its only capability is the host's values-free connection-registration
// facade. It produces an adapter-only in-memory config and never persists a legacy pointer.

const SQL_READONLY_KIND = 'data-source:sql-readonly'
const DEFAULT_SQL_CONNECTION_TYPES = new Set(['mysql', 'postgres', 'postgresql', 'sqlserver'])
// Keep the migration escape hatch deliberately enumerable. Adding a new binding kind needs an
// explicit review here; a connection_id NULL must never become a generic fallback protocol.
const DEFAULT_LEGACY_KIND_ALLOWLIST = new Set([SQL_READONLY_KIND])

class ConnectionResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ConnectionResolutionError'
    this.code = code
    // Details intentionally contain only structural labels. Do not attach connection ids, tenant
    // ids, principal ids, endpoint data, or a wrapped facade error message here.
    this.details = details
  }
}

// ── Why the host facade refused: a SERVER-LOG-ONLY diagnostic (R1/R7) ───────────────────────────
// The facade refuses "not loaded", "not the owner", "wrong tenant" and "tenantless scope" with one
// uniform not-found so a caller cannot learn a source exists, and this module rewrites every facade
// refusal to one code (`CONNECTION_CANONICAL_UNAVAILABLE` / `CONNECTION_LEGACY_UNAVAILABLE`). Both
// stay exactly as they are: the thrown error, its code, message and details do not change.
// What changes is that the facade's own reason — a non-enumerable `refusalDiagnostic` on the error
// it throws (packages/core-backend/src/data-adapters/data-source-plugin-facade.ts) — is now written
// to the server log here instead of being dropped by a bare `catch {}`.
//
// Only words from these closed lists (and booleans) are ever logged. Anything else — a facade that
// predates the diagnostic, a stub, a value this module does not know — is logged as `unclassified`,
// so no id, tenant, principal or free text can reach the log through this path.
// See docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §2/§5.
const FACADE_REFUSAL_REASONS = Object.freeze([
  'principal_missing',
  'tenant_missing',
  'run_as_invalid',
  'not_loaded',
  'owner_mismatch',
  'scope_missing',
  'tenant_mismatch',
  'tenantless_scope',
  'tenantless_service',
])
const REGISTRY_UNLOADED_REASONS = Object.freeze([
  'soft_deleted',
  'inactive',
  'unsupported_type',
  'decrypt_failed',
  'load_failed',
  'removed',
  'absent_at_load',
  'unknown_at_load',
  'registry_not_loaded',
])
const FACADE_REFUSAL_REASON_SET = new Set(FACADE_REFUSAL_REASONS)
const REGISTRY_UNLOADED_REASON_SET = new Set(REGISTRY_UNLOADED_REASONS)
const REFUSAL_LOG_MESSAGE = '[plugin-integration-core] connection resolution refused'
// R7's table read is the facade's; this is only the longest the log line waits for its answer
// before it is written with `persistedLive: null` ("could not tell").
const PERSISTED_LIVE_PROBE_BUDGET_MS = 3000

function readOwnDiagnostic(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'refusalDiagnostic')
    // A data descriptor only: an accessor could run arbitrary code while we are building a log line.
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Map whatever the facade threw to a values-free, closed-vocabulary record. Never throws.
 * `facade_unavailable` is this module's own S1 (no facade injected), not a facade answer.
 * `persistedLive` (R7) is not part of this record: it is a table read, settled separately
 * (settlePersistedLive) after the refusal has been thrown.
 */
function describeFacadeRefusal(error) {
  try {
    if (error instanceof ConnectionResolutionError && error.code === 'CONNECTION_RESOLUTION_UNAVAILABLE') {
      return { reason: 'facade_unavailable' }
    }
    const raw = readOwnDiagnostic(error)
    if (!raw || typeof raw !== 'object') return { reason: 'unclassified' }
    const rawReason = typeof raw.reason === 'string' ? raw.reason : ''
    const reason = FACADE_REFUSAL_REASON_SET.has(rawReason) ? rawReason : 'unclassified'
    if (reason !== 'not_loaded') return { reason }
    const rawOutcome = typeof raw.loadOutcome === 'string' ? raw.loadOutcome : ''
    return {
      reason,
      loadOutcome: REGISTRY_UNLOADED_REASON_SET.has(rawOutcome) ? rawOutcome : 'unclassified',
    }
  } catch {
    // A hostile getter on the diagnostic costs the classification, never the refusal.
    return { reason: 'unclassified' }
  }
}

/** The facade's R7 probe, when its diagnostic carries one (a function); otherwise null. Never throws. */
function persistedLiveProbeOf(error) {
  try {
    const raw = readOwnDiagnostic(error)
    if (!raw || typeof raw !== 'object') return null
    const probe = raw.probePersistedLive
    return typeof probe === 'function' ? probe : null
  } catch {
    return null
  }
}

const deferTask = typeof setImmediate === 'function' ? setImmediate : (task) => setTimeout(task, 0)

/**
 * R7: run the facade's table read AFTER the refusal has been thrown and answered, and resolve to
 * exactly true / false / null. Deferred to a macrotask, so it starts only once the rejection has
 * run through the (microtask-only) chain up to the route's response; nothing on the refusal path
 * waits for it. Bounded by PERSISTED_LIVE_PROBE_BUDGET_MS. Never rejects.
 */
function settlePersistedLive(probe) {
  return new Promise((resolve) => {
    if (!probe) {
      resolve(null)
      return
    }
    let settled = false
    let timer
    const done = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value === true ? true : (value === false ? false : null))
    }
    deferTask(() => {
      timer = setTimeout(() => done(null), PERSISTED_LIVE_PROBE_BUDGET_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
      let pending
      try {
        pending = probe()
      } catch {
        done(null)
        return
      }
      Promise.resolve(pending).then(done, () => done(null))
    })
  })
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeWorkspaceId(value) {
  return nonBlankString(value)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasValidCreatedAt(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime())
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value))
}

function cloneBinding(binding) {
  if (!isPlainObject(binding)) {
    throw new ConnectionResolutionError(
      'CONNECTION_RESOLUTION_INVALID_BINDING',
      'connection binding is invalid',
      { phase: 'input' },
    )
  }
  return {
    ...binding,
    ...(isPlainObject(binding.config) ? { config: { ...binding.config } } : {}),
  }
}

function requireFacade(facade) {
  if (!facade || typeof facade.resolveConnectionRegistration !== 'function') {
    throw new ConnectionResolutionError(
      'CONNECTION_RESOLUTION_UNAVAILABLE',
      'connection resolution is unavailable',
      { phase: 'facade' },
    )
  }
  return facade
}

function requireSealedSnapshotFacade(facade) {
  if (!facade || typeof facade.resolveSqlServerConnection !== 'function') {
    throw new ConnectionResolutionError(
      'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
      'sealed snapshot connection resolution is unavailable',
      { phase: 'sealed_snapshot' },
    )
  }
  return facade
}

function assertExecutionTenant(binding, tenantId) {
  const bindingTenantId = nonBlankString(binding.tenantId)
  const executionTenantId = nonBlankString(tenantId)
  if (!bindingTenantId || !executionTenantId || bindingTenantId !== executionTenantId) {
    throw new ConnectionResolutionError(
      'CONNECTION_TENANT_MISMATCH',
      'connection binding tenant does not match the execution context',
      { phase: 'binding' },
    )
  }
  return executionTenantId
}

function assertRegistration(
  registration,
  requestedId,
  tenantId,
  allowedTypes,
  phase,
  { allowUnconfirmedLegacyTenant = false } = {},
) {
  if (!isPlainObject(registration)) {
    throw new ConnectionResolutionError(
      'CONNECTION_REGISTRATION_INVALID',
      'connection registration is invalid',
      { phase },
    )
  }
  const registrationId = nonBlankString(registration.id)
  if (!registrationId || registrationId !== requestedId) {
    throw new ConnectionResolutionError(
      'CONNECTION_ID_MISMATCH',
      'connection registration does not match the binding',
      { phase },
    )
  }
  const registrationTenantId = nonBlankString(registration.tenantId)
  const scopeKind = nonBlankString(registration.scopeKind)
  const allowedUnconfirmedTenant = allowUnconfirmedLegacyTenant
    && registrationTenantId === null
    && scopeKind === 'legacy_private'
  if (!allowedUnconfirmedTenant && registrationTenantId !== tenantId) {
    throw new ConnectionResolutionError(
      'CONNECTION_TENANT_MISMATCH',
      'connection registration tenant does not match the binding',
      { phase },
    )
  }
  const type = nonBlankString(registration.type)
  if (!type || !allowedTypes.has(type.toLowerCase())) {
    throw new ConnectionResolutionError(
      'CONNECTION_TYPE_UNSUPPORTED',
      'connection registration type is not supported by the SQL read-only binding',
      { phase },
    )
  }
  return { registrationId, scopeKind }
}

function adapterBinding(binding, dataSourceId) {
  // The host facade owns the physical connection and all secrets. The only adapter input this
  // existing read-only adapter needs is its registered id plus the binding's semantic config.
  return {
    ...binding,
    config: {
      ...(isPlainObject(binding.config) ? binding.config : {}),
      dataSourceId,
    },
  }
}

/**
 * Creates a resolver for the integration binding -> host Connection boundary.
 *
 * `logger` is optional and receives ONLY the values-free refusal record (see describeFacadeRefusal);
 * without it the resolver behaves exactly as it always has.
 *
 * @param {{ facade: { resolveConnectionRegistration: Function }, sealedSnapshotFacade?: { resolveSqlServerConnection: Function }, allowedSqlConnectionTypes?: Iterable<string>, legacyKindAllowlist?: Iterable<string>, logger?: { warn?: Function } }} deps
 */
function createConnectionResolver({
  facade,
  sealedSnapshotFacade,
  allowedSqlConnectionTypes = DEFAULT_SQL_CONNECTION_TYPES,
  legacyKindAllowlist = DEFAULT_LEGACY_KIND_ALLOWLIST,
  logger,
} = {}) {
  // Keep activation compatible for deployments that do not expose the host facade. Only a SQL
  // binding needs this capability, and that path still fails closed at the first resolution call.
  const connectionFacade = facade
  const sealedFacade = sealedSnapshotFacade
  const allowedTypes = new Set(Array.from(allowedSqlConnectionTypes, (type) => String(type).toLowerCase()))
  const legacyKinds = new Set(Array.from(legacyKindAllowlist, (kind) => String(kind)))

  // The refusal is decided before this runs and is thrown after it whatever happens here: a missing
  // logger, a throwing logger or an unreadable diagnostic costs the log line, never the refusal.
  // Exactly one line per refusal. A `not_loaded` line is written once the R7 table read settles
  // (after the refusal was answered, see settlePersistedLive); every other line is written here.
  function emitFacadeRefusal(record) {
    try {
      logger.warn(REFUSAL_LOG_MESSAGE, record)
    } catch {
      // intentionally empty — see above
    }
  }

  function logFacadeRefusal(phase, code, error) {
    if (!logger || typeof logger.warn !== 'function') return
    const record = { phase, code, ...describeFacadeRefusal(error) }
    if (record.reason !== 'not_loaded') {
      emitFacadeRefusal(record)
      return
    }
    settlePersistedLive(persistedLiveProbeOf(error))
      .then((persistedLive) => emitFacadeRefusal({ ...record, persistedLive }))
  }

  async function resolveCanonical(binding, context, connectionId) {
    const tenantId = assertExecutionTenant(binding, context.tenantId)
    let registration
    try {
      // Canonical is authoritative. This call intentionally happens before any legacy-pointer
      // consideration, and every error exits this branch rather than falling through.
      registration = await requireFacade(connectionFacade).resolveConnectionRegistration(connectionId, {
        tenantId,
        workspaceId: normalizeWorkspaceId(context.workspaceId),
        principal: context.principal,
        runAs: context.runAs,
      })
    } catch (error) {
      logFacadeRefusal('canonical', 'CONNECTION_CANONICAL_UNAVAILABLE', error)
      throw new ConnectionResolutionError(
        'CONNECTION_CANONICAL_UNAVAILABLE',
        'canonical connection is unavailable',
        { phase: 'canonical' },
      )
    }
    const ownerUserCompatibility = context.runAs === 'user' && nonBlankString(context.principal) !== null
    const { registrationId } = assertRegistration(
      registration,
      connectionId,
      tenantId,
      allowedTypes,
      'canonical',
      { allowUnconfirmedLegacyTenant: ownerUserCompatibility },
    )
    const legacyPointer = nonBlankString(isPlainObject(binding.config) ? binding.config.dataSourceId : undefined)
    if (legacyPointer && legacyPointer !== registrationId) {
      throw new ConnectionResolutionError(
        'CONNECTION_BINDING_MISMATCH',
        'canonical and legacy connection references do not match',
        { phase: 'canonical' },
      )
    }
    return { binding: adapterBinding(binding, registrationId), registration }
  }

  async function resolveLegacy(binding, context) {
    if (
      !legacyKinds.has(binding.kind) ||
      binding.legacyConnectionFallbackEligible !== true ||
      !hasValidCreatedAt(binding.createdAt)
    ) {
      throw new ConnectionResolutionError(
        'CONNECTION_LEGACY_FALLBACK_DENIED',
        'legacy connection fallback is not permitted for this binding',
        { phase: 'legacy' },
      )
    }
    if (context.runAs !== 'user' || !nonBlankString(context.principal)) {
      throw new ConnectionResolutionError(
        'CONNECTION_LEGACY_FALLBACK_DENIED',
        'legacy connection fallback requires an owner user principal',
        { phase: 'legacy' },
      )
    }
    const tenantId = assertExecutionTenant(binding, context.tenantId)
    const legacyPointer = nonBlankString(isPlainObject(binding.config) ? binding.config.dataSourceId : undefined)
    if (!legacyPointer) {
      throw new ConnectionResolutionError(
        'CONNECTION_LEGACY_POINTER_REQUIRED',
        'legacy connection fallback requires a legacy data source reference',
        { phase: 'legacy' },
      )
    }
    let registration
    try {
      registration = await requireFacade(connectionFacade).resolveConnectionRegistration(legacyPointer, {
        tenantId,
        // workspace is context, never authority here. The host facade still performs an owner-only
        // check for legacy_private registrations, so a binding that lives in a workspace does not
        // become workspace-shared merely because it carries this identifier.
        workspaceId: normalizeWorkspaceId(context.workspaceId),
        principal: context.principal,
        runAs: context.runAs,
      })
    } catch (error) {
      logFacadeRefusal('legacy', 'CONNECTION_LEGACY_UNAVAILABLE', error)
      throw new ConnectionResolutionError(
        'CONNECTION_LEGACY_UNAVAILABLE',
        'legacy connection is unavailable',
        { phase: 'legacy' },
      )
    }
    if (registration && registration.scopeKind !== 'legacy_private') {
      throw new ConnectionResolutionError(
        'CONNECTION_LEGACY_FALLBACK_DENIED',
        'legacy connection fallback requires an owner-only connection',
        { phase: 'legacy' },
      )
    }
    const { registrationId } = assertRegistration(
      registration,
      legacyPointer,
      tenantId,
      allowedTypes,
      'legacy',
      { allowUnconfirmedLegacyTenant: true },
    )
    return { binding: adapterBinding(binding, registrationId), registration }
  }

  async function resolveSqlBinding(binding, context) {
    if (binding.connectionId !== null && binding.connectionId !== undefined) {
      const connectionId = nonBlankString(binding.connectionId)
      if (!connectionId) {
        throw new ConnectionResolutionError(
          'CONNECTION_ID_REQUIRED',
          'SQL read-only bindings require a canonical connection id',
          { phase: 'canonical' },
        )
      }
      return resolveCanonical(binding, context, connectionId)
    }
    if (binding.connectionId !== null) {
      throw new ConnectionResolutionError(
        'CONNECTION_ID_REQUIRED',
        'SQL read-only bindings require a canonical connection id',
        { phase: 'canonical' },
      )
    }
    return resolveLegacy(binding, context)
  }

  async function resolveSealedSqlServer(bindingInput, contextInput = {}) {
    const binding = cloneBinding(bindingInput)
    const context = isPlainObject(contextInput) ? contextInput : {}
    if (binding.kind !== SQL_READONLY_KIND) {
      throw new ConnectionResolutionError(
        'CONNECTION_SEALED_SNAPSHOT_KIND_UNSUPPORTED',
        'sealed snapshot connection must be a SQL read-only binding',
        { phase: 'sealed_snapshot' },
      )
    }
    if (context.runAs !== 'user' || !nonBlankString(context.principal)) {
      throw new ConnectionResolutionError(
        'CONNECTION_SEALED_SNAPSHOT_USER_REQUIRED',
        'sealed snapshot connection resolution requires a user principal',
        { phase: 'sealed_snapshot' },
      )
    }
    // Resolve the ordinary binding first. This preserves all canonical-authority,
    // mismatch and marked-legacy policy before the sealed-only facade can return
    // any physical connection material.
    const resolved = await resolveSqlBinding(binding, context)
    const tenantId = assertExecutionTenant(binding, context.tenantId)
    const dataSourceId = nonBlankString(resolved.binding.config && resolved.binding.config.dataSourceId)
    if (!dataSourceId) {
      throw new ConnectionResolutionError(
        'CONNECTION_SEALED_SNAPSHOT_INVALID',
        'sealed snapshot connection registration is invalid',
        { phase: 'sealed_snapshot' },
      )
    }
    let snapshot
    try {
      snapshot = await requireSealedSnapshotFacade(sealedFacade).resolveSqlServerConnection(dataSourceId, {
        tenantId,
        workspaceId: normalizeWorkspaceId(context.workspaceId),
        principal: context.principal,
        runAs: context.runAs,
      })
    } catch (error) {
      if (error instanceof ConnectionResolutionError) throw error
      logFacadeRefusal('sealed_snapshot', 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE', error)
      throw new ConnectionResolutionError(
        'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
        'sealed snapshot connection is unavailable',
        { phase: 'sealed_snapshot' },
      )
    }
    // Registration identity/tenant/type was already verified by resolveSqlBinding,
    // and the dedicated host capability repeats that authorization before exposing
    // its much narrower {connection, credentials} projection. Do not require the
    // secret-bearing result to duplicate registration metadata or invent a second
    // source of truth for it.
    const primaryId = nonBlankString(resolved.registration && resolved.registration.id)
    const primaryType = nonBlankString(resolved.registration && resolved.registration.type)
    if (
      primaryId !== dataSourceId
      || primaryType?.toLowerCase() !== 'sqlserver'
      || !isPlainObject(snapshot.connection)
      || !isPlainObject(snapshot.credentials)
    ) {
      throw new ConnectionResolutionError(
        'CONNECTION_SEALED_SNAPSHOT_INVALID',
        'sealed snapshot connection registration is invalid',
        { phase: 'sealed_snapshot' },
      )
    }
    return {
      ...resolved.binding,
      config: {
        ...resolved.binding.config,
        sealedSnapshotSqlServer: snapshot.connection,
      },
      credentials: {
        sealedSnapshotSqlServer: snapshot.credentials,
      },
    }
  }

  return {
    async resolve(bindingInput, contextInput = {}) {
      const binding = cloneBinding(bindingInput)
      const context = isPlainObject(contextInput) ? contextInput : {}

      // Resolver ownership is deliberately narrow. HTTP/K3/PLM (and every other current kind) pass
      // through untouched; this PR must not turn their adapter paths into connection fallbacks.
      if (binding.kind !== SQL_READONLY_KIND) return binding

      return (await resolveSqlBinding(binding, context)).binding
    },
    resolveSealedSqlServer,
  }
}

// Every code a ConnectionResolutionError can carry, so a consumer (the route-failure log) can admit
// exactly these words and nothing else. Kept in step with the throws above by
// __tests__/connection-refusal-diagnostics.test.cjs, which scans this file for them.
const CONNECTION_RESOLUTION_ERROR_CODES = Object.freeze([
  'CONNECTION_RESOLUTION_INVALID_BINDING',
  'CONNECTION_RESOLUTION_UNAVAILABLE',
  'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
  'CONNECTION_TENANT_MISMATCH',
  'CONNECTION_REGISTRATION_INVALID',
  'CONNECTION_ID_MISMATCH',
  'CONNECTION_TYPE_UNSUPPORTED',
  'CONNECTION_CANONICAL_UNAVAILABLE',
  'CONNECTION_BINDING_MISMATCH',
  'CONNECTION_LEGACY_FALLBACK_DENIED',
  'CONNECTION_LEGACY_POINTER_REQUIRED',
  'CONNECTION_LEGACY_UNAVAILABLE',
  'CONNECTION_ID_REQUIRED',
  'CONNECTION_SEALED_SNAPSHOT_KIND_UNSUPPORTED',
  'CONNECTION_SEALED_SNAPSHOT_USER_REQUIRED',
  'CONNECTION_SEALED_SNAPSHOT_INVALID',
])

module.exports = {
  SQL_READONLY_KIND,
  DEFAULT_SQL_CONNECTION_TYPES,
  DEFAULT_LEGACY_KIND_ALLOWLIST,
  CONNECTION_RESOLUTION_ERROR_CODES,
  FACADE_REFUSAL_REASONS,
  REGISTRY_UNLOADED_REASONS,
  REFUSAL_LOG_MESSAGE,
  ConnectionResolutionError,
  createConnectionResolver,
  __internals: {
    describeFacadeRefusal,
    persistedLiveProbeOf,
    settlePersistedLive,
    PERSISTED_LIVE_PROBE_BUDGET_MS,
  },
}
