'use strict'

// Connection/binding resolution policy. This module deliberately has no database, adapter, or
// credential dependency: its only capability is the host's values-free connection-registration
// facade. It produces an adapter-only in-memory config and never persists a legacy pointer.
// The one thing it writes anywhere is a values-free line to the injected logger when the facade
// refuses (see "Why a connection was refused" below).

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

// ── Why a connection was refused: ONE values-free line in the server log (#6067 §5 R1) ─────────
// The three catch blocks below turn every refusal of the host facade into one connection error, on
// purpose: a caller who is not the owner must not learn whether an id exists. They used to drop the
// refusal, so an operator could not tell the states apart either. Each of them now writes exactly
// one line through the injected logger before it throws what it always threw.
//
// The line carries three closed words and nothing else: the phase, the connection error code and the
// reason. No id of any kind, no owner, no tenant, no configuration, no error text, no stack.
//
// The host marks a refusal with its reason under this registered symbol, as a non-enumerable
// property (packages/core-backend/src/data-adapters/data-source-plugin-facade.ts). This module
// cannot import that file, so it keeps its OWN copy of the list and admits a reason by exact string
// only — no prefix, no pattern, no trimming. packages/core-backend/tests/unit/
// connection-refusal-reason-log.test.ts compares the two lists and fails when they differ.
const REFUSAL_REASON_KEY = Symbol.for('metasheet.dataSource.refusalReason')
const FACADE_REFUSAL_REASONS = Object.freeze([
  'principal_missing',
  'tenant_missing',
  'run_as_invalid',
  'owner_mismatch',
  'not_loaded_credentials_unreadable',
  'not_loaded_unsupported_type',
  'not_loaded_load_failed',
  'not_loaded_absent',
  'load_state_unknown',
  'scope_missing',
  'tenant_mismatch',
  'tenantless_scope',
  'tenantless_service',
  'sealed_run_as_not_user',
  'sealed_type_unsupported',
  'sealed_adapter_unavailable',
  'sealed_not_read_only',
  'sealed_config_unreadable',
  'sealed_connection_not_representable',
])
const FACADE_REFUSAL_REASON_SET = new Set(FACADE_REFUSAL_REASONS)
// Words only this module writes. They are NOT admitted from a refusal: a refusal that names one of
// them is logged as unclassified, like any other word outside the list above.
const REFUSAL_REASON_FACADE_UNAVAILABLE = 'facade_unavailable'
const REFUSAL_REASON_UNCLASSIFIED = 'unclassified'
const RESOLVER_REFUSAL_REASONS = Object.freeze([
  REFUSAL_REASON_FACADE_UNAVAILABLE,
  REFUSAL_REASON_UNCLASSIFIED,
])
const CONNECTION_REFUSAL_LOG_MESSAGE = '[plugin-integration-core] connection refused'
// The code written for a connection error this module rethrows without having built it.
const CONNECTION_REFUSAL_UNLISTED_CODE = 'UNLISTED'

// Synchronous, no I/O, never throws: a hostile refusal (a throwing getter, a proxy) costs the word,
// never the throw that follows.
//
// `facadeReached` is what tells "no facade injected" from a refusal: each try block sets it once the
// facade has been obtained, so it is false exactly when requireFacade / requireSealedSnapshotFacade
// threw. It is a fact about the resolver, not something read off the error — nothing a facade throws,
// whatever its class, code or message, can pass for it.
function refusalReasonOf(error, facadeReached) {
  if (facadeReached !== true) return REFUSAL_REASON_FACADE_UNAVAILABLE
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
      return REFUSAL_REASON_UNCLASSIFIED
    }
    const reason = error[REFUSAL_REASON_KEY]
    return typeof reason === 'string' && FACADE_REFUSAL_REASON_SET.has(reason)
      ? reason
      : REFUSAL_REASON_UNCLASSIFIED
  } catch {
    return REFUSAL_REASON_UNCLASSIFIED
  }
}

// One synchronous call, the same on every refusal. A logger that throws changes nothing.
function writeRefusalLine(logger, phase, code, error, facadeReached) {
  if (!logger || typeof logger.warn !== 'function') return
  try {
    logger.warn(CONNECTION_REFUSAL_LOG_MESSAGE, { phase, code, reason: refusalReasonOf(error, facadeReached) })
  } catch {
    // diagnostics only
  }
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
 * @param {{ facade: { resolveConnectionRegistration: Function }, sealedSnapshotFacade?: { resolveSqlServerConnection: Function }, allowedSqlConnectionTypes?: Iterable<string>, legacyKindAllowlist?: Iterable<string>, logger?: { warn: Function } }} deps
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
  // Where the reason of a refused connection is written. Absent logger: no line, same refusal.
  const refusalLogger = logger
  const allowedTypes = new Set(Array.from(allowedSqlConnectionTypes, (type) => String(type).toLowerCase()))
  const legacyKinds = new Set(Array.from(legacyKindAllowlist, (kind) => String(kind)))

  async function resolveCanonical(binding, context, connectionId) {
    const tenantId = assertExecutionTenant(binding, context.tenantId)
    let registration
    let facadeReached = false
    try {
      // Canonical is authoritative. This call intentionally happens before any legacy-pointer
      // consideration, and every error exits this branch rather than falling through.
      const host = requireFacade(connectionFacade)
      facadeReached = true
      registration = await host.resolveConnectionRegistration(connectionId, {
        tenantId,
        workspaceId: normalizeWorkspaceId(context.workspaceId),
        principal: context.principal,
        runAs: context.runAs,
      })
    } catch (error) {
      writeRefusalLine(refusalLogger, 'canonical', 'CONNECTION_CANONICAL_UNAVAILABLE', error, facadeReached)
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
    let facadeReached = false
    try {
      const host = requireFacade(connectionFacade)
      facadeReached = true
      registration = await host.resolveConnectionRegistration(legacyPointer, {
        tenantId,
        // workspace is context, never authority here. The host facade still performs an owner-only
        // check for legacy_private registrations, so a binding that lives in a workspace does not
        // become workspace-shared merely because it carries this identifier.
        workspaceId: normalizeWorkspaceId(context.workspaceId),
        principal: context.principal,
        runAs: context.runAs,
      })
    } catch (error) {
      writeRefusalLine(refusalLogger, 'legacy', 'CONNECTION_LEGACY_UNAVAILABLE', error, facadeReached)
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
    let facadeReached = false
    try {
      const host = requireSealedSnapshotFacade(sealedFacade)
      facadeReached = true
      snapshot = await host.resolveSqlServerConnection(dataSourceId, {
        tenantId,
        workspaceId: normalizeWorkspaceId(context.workspaceId),
        principal: context.principal,
        runAs: context.runAs,
      })
    } catch (error) {
      if (error instanceof ConnectionResolutionError) {
        // Rethrown unchanged, as before. With no sealed facade injected this is the error built by
        // requireSealedSnapshotFacade, whose code is known; any other error of this class was built
        // elsewhere, and its code is free text as far as the log is concerned.
        writeRefusalLine(
          refusalLogger,
          'sealed_snapshot',
          facadeReached ? CONNECTION_REFUSAL_UNLISTED_CODE : 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
          error,
          facadeReached,
        )
        throw error
      }
      writeRefusalLine(refusalLogger, 'sealed_snapshot', 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE', error, facadeReached)
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

module.exports = {
  SQL_READONLY_KIND,
  DEFAULT_SQL_CONNECTION_TYPES,
  DEFAULT_LEGACY_KIND_ALLOWLIST,
  ConnectionResolutionError,
  createConnectionResolver,
  FACADE_REFUSAL_REASONS,
  RESOLVER_REFUSAL_REASONS,
  CONNECTION_REFUSAL_LOG_MESSAGE,
  CONNECTION_REFUSAL_UNLISTED_CODE,
  // For the structure test only: the two functions every refusal line goes through.
  __refusalLogInternals: Object.freeze({ refusalReasonOf, writeRefusalLine }),
}
