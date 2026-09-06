'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
  ConnectionResolutionError,
  createConnectionResolver,
} = require('../lib/connection-resolver.cjs')
const {
  deriveStockPreparationSqlServerSourceAnchors,
  resolveStockPreparationSqlServerSource,
} = require('../lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs')

function binding(overrides = {}) {
  return {
    id: 'binding_1',
    kind: 'data-source:sql-readonly',
    tenantId: 'tenant_1',
    workspaceId: null,
    connectionId: 'connection_1',
    createdAt: '2026-09-01T00:00:00.000Z',
    legacyConnectionFallbackEligible: false,
    config: { schema: 'dbo' },
    ...overrides,
  }
}

function registration(overrides = {}) {
  return {
    id: 'connection_1',
    tenantId: 'tenant_1',
    type: 'sqlserver',
    scopeKind: 'private',
    ...overrides,
  }
}

function context(overrides = {}) {
  return {
    tenantId: 'tenant_1',
    workspaceId: null,
    principal: 'owner_1',
    runAs: 'user',
    ...overrides,
  }
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ConnectionResolutionError)
    assert.equal(error.code, code)
    assert.ok(error.details && typeof error.details.phase === 'string')
    assert.doesNotMatch(JSON.stringify(error.details), /connection_1|tenant_1|owner_1|secret/i)
    return true
  })
}

async function main() {
  const calls = []
  const facade = {
    async resolveConnectionRegistration(id, input) {
      calls.push({ id, input })
      return registration({ id })
    },
  }
  const resolver = createConnectionResolver({ facade })

  // Non-SQL kinds are cloned, unchanged, and do not query the host connection surface.
  const http = binding({ kind: 'http', connectionId: 'ignored', config: { baseUrl: 'https://example.test' } })
  const httpResolved = await resolver.resolve(http, context())
  assert.deepEqual(httpResolved, http)
  assert.notEqual(httpResolved, http)
  assert.notEqual(httpResolved.config, http.config)
  assert.equal(calls.length, 0)

  // Canonical reference is authoritative and only materializes the host registration id in memory.
  const canonical = await resolver.resolve(binding(), context())
  assert.equal(canonical.config.dataSourceId, 'connection_1')
  assert.equal(canonical.config.schema, 'dbo')
  assert.equal(canonical.credentials, undefined)
  assert.deepEqual(calls[0], {
    id: 'connection_1',
    input: { tenantId: 'tenant_1', workspaceId: null, principal: 'owner_1', runAs: 'user' },
  })

  // The sealed projection resolves the ordinary canonical Binding first, then
  // obtains physical SQL Server material only from its dedicated facade.
  const sealedCalls = []
  const sealedResolver = createConnectionResolver({
    facade,
    sealedSnapshotFacade: {
      async resolveSqlServerConnection(id, input) {
        sealedCalls.push({ id, input })
        return {
          connection: { database: 'sealed_db' },
          credentials: { password: 'sealed-secret', user: 'readonly' },
        }
      },
    },
  })
  const sealed = await sealedResolver.resolveSealedSqlServer(binding(), context())
  assert.equal(sealed.config.dataSourceId, 'connection_1')
  assert.deepEqual(sealed.config.sealedSnapshotSqlServer, { database: 'sealed_db' })
  assert.deepEqual(sealed.credentials, {
    sealedSnapshotSqlServer: { password: 'sealed-secret', user: 'readonly' },
  })
  assert.deepEqual(sealedCalls, [{
    id: 'connection_1',
    input: { tenantId: 'tenant_1', workspaceId: null, principal: 'owner_1', runAs: 'user' },
  }])

  await rejectsCode(
    () => sealedResolver.resolveSealedSqlServer(binding(), context({ runAs: 'service' })),
    'CONNECTION_SEALED_SNAPSHOT_USER_REQUIRED',
  )
  assert.equal(sealedCalls.length, 1, 'service runs never reach the secret-bearing facade')

  const uppercaseTypeSealed = await createConnectionResolver({
    facade: { async resolveConnectionRegistration(id) { return registration({ id, type: 'SQLSERVER' }) } },
    sealedSnapshotFacade: {
      async resolveSqlServerConnection() {
        return { connection: { database: 'sealed_db' }, credentials: { user: 'u', password: 'p' } }
      },
    },
  }).resolveSealedSqlServer(binding(), context())
  assert.equal(uppercaseTypeSealed.config.dataSourceId, 'connection_1')

  // Full in-memory handoff: Connection Resolver -> sealed source authority -> driver config.
  // Login/password are opaque connection material, so meaningful edge spaces must survive.
  const edgeSpaceUser = '  readonly login  '
  const edgeSpacePassword = '  sealed password bytes  '
  const endToEndResolver = createConnectionResolver({
    facade,
    sealedSnapshotFacade: {
      async resolveSqlServerConnection() {
        return {
          connection: {
            database: 'sealed_db',
            encrypt: true,
            instanceName: null,
            port: 1433,
            server: 'sql.example.test',
            trustServerCertificate: false,
          },
          credentials: { password: edgeSpacePassword, user: edgeSpaceUser },
        }
      },
    },
  })
  const resolvedSystem = await endToEndResolver.resolveSealedSqlServer(binding({
    capabilities: {},
    role: 'source',
    status: 'active',
  }), context())
  const identityKey = crypto.createHash('sha256').update('resolver-source-authority-e2e').digest()
  const authorityDraft = {
    approvedConfigVersionId: 'config-v1',
    bindingVersion: 'binding-v1',
    canonicalObjectVersion: 'stock-preparation-bom.v1',
    externalSystemId: 'binding_1',
    objectKey: 'stock-preparation-bom',
    relationId: 'sqlserver.relation.rowid_payload.v1',
    tableRef: 'dbo.stock_prep_sealed_rows',
    tenantId: 'tenant_1',
    workspaceId: null,
  }
  const derivedAuthority = deriveStockPreparationSqlServerSourceAnchors({
    binding: authorityDraft,
    externalSystem: resolvedSystem,
    identityKey,
  })
  const resolvedSource = resolveStockPreparationSqlServerSource({
    binding: {
      ...authorityDraft,
      ...derivedAuthority.anchors,
      bindingId: 'sealed-binding-row',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    externalSystem: resolvedSystem,
    identityKey,
  })
  assert.equal(resolvedSource.connectionConfig.user, edgeSpaceUser)
  assert.equal(resolvedSource.connectionConfig.password, edgeSpacePassword)

  // A dedicated-facade refusal remains terminal; it cannot reopen legacy fallback.
  await rejectsCode(
    () => createConnectionResolver({
      facade,
      sealedSnapshotFacade: { async resolveSqlServerConnection() { throw new Error('not exposed') } },
    }).resolveSealedSqlServer(binding({
      legacyConnectionFallbackEligible: true,
      config: { dataSourceId: 'connection_1' },
    }), context()),
    'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE',
  )

  // A retained old pointer is allowed only when it names the same Connection.
  await resolver.resolve(binding({ config: { dataSourceId: 'connection_1' } }), context())
  await rejectsCode(
    () => resolver.resolve(binding({ config: { dataSourceId: 'other_connection' } }), context()),
    'CONNECTION_BINDING_MISMATCH',
  )

  // Canonical failures cannot reach legacy, even if every legacy marker is otherwise true.
  let canonicalCalls = 0
  const failingCanonical = createConnectionResolver({
    facade: {
      async resolveConnectionRegistration() {
        canonicalCalls += 1
        throw new Error('not exposed')
      },
    },
  })
  await rejectsCode(
    () => failingCanonical.resolve(binding({
      legacyConnectionFallbackEligible: true,
      config: { dataSourceId: 'connection_1' },
    }), context()),
    'CONNECTION_CANONICAL_UNAVAILABLE',
  )
  assert.equal(canonicalCalls, 1)

  await rejectsCode(
    () => resolver.resolve(binding({ connectionId: 'connection_1' }), context({ tenantId: 'tenant_2' })),
    'CONNECTION_TENANT_MISMATCH',
  )
  await rejectsCode(
    () => createConnectionResolver({ facade: { async resolveConnectionRegistration() { return registration({ id: 'wrong' }) } } })
      .resolve(binding(), context()),
    'CONNECTION_ID_MISMATCH',
  )
  await rejectsCode(
    () => createConnectionResolver({ facade: { async resolveConnectionRegistration() { return registration({ type: 'http' }) } } })
      .resolve(binding(), context()),
    'CONNECTION_TYPE_UNSUPPORTED',
  )
  await rejectsCode(
    () => createConnectionResolver({
      facade: { async resolveConnectionRegistration() { return registration({ tenantId: 'tenant_2' }) } },
    }).resolve(binding(), context()),
    'CONNECTION_TENANT_MISMATCH',
  )

  // Legacy is explicit, old, owner-user only, tenant-bound, and must use a legacy-private registration.
  const legacyCalls = []
  const legacyResolver = createConnectionResolver({
    facade: {
      async resolveConnectionRegistration(id, input) {
        legacyCalls.push({ id, input })
        return registration({ id, scopeKind: 'legacy_private' })
      },
    },
  })
  const legacy = await legacyResolver.resolve(binding({
    connectionId: null,
    legacyConnectionFallbackEligible: true,
    createdAt: '2026-08-31T23:59:59.000Z',
    config: { dataSourceId: 'connection_1', schema: 'dbo' },
  }), context())
  assert.equal(legacy.config.dataSourceId, 'connection_1')
  assert.deepEqual(legacyCalls, [{
    id: 'connection_1',
    input: { tenantId: 'tenant_1', workspaceId: null, principal: 'owner_1', runAs: 'user' },
  }])

  const legacyBase = {
    connectionId: null,
    legacyConnectionFallbackEligible: true,
    createdAt: '2026-08-31T23:59:59.000Z',
    config: { dataSourceId: 'connection_1' },
  }
  await rejectsCode(() => legacyResolver.resolve(binding({ ...legacyBase, legacyConnectionFallbackEligible: false }), context()), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  await rejectsCode(() => resolver.resolve(binding({ ...legacyBase, createdAt: 'not-a-date' }), context()), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  const workspaceLegacy = await legacyResolver.resolve(
    binding({ ...legacyBase, workspaceId: 'workspace_1' }),
    context({ workspaceId: 'workspace_1' }),
  )
  assert.equal(workspaceLegacy.config.dataSourceId, 'connection_1',
    'workspace context does not widen the owner-only facade decision')
  await rejectsCode(() => legacyResolver.resolve(binding(legacyBase), context({ runAs: 'service' })), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  await rejectsCode(() => resolver.resolve(binding(legacyBase), context({ principal: null })), 'CONNECTION_LEGACY_FALLBACK_DENIED')
  await rejectsCode(() => resolver.resolve(binding({ ...legacyBase, tenantId: null }), context()), 'CONNECTION_TENANT_MISMATCH')
  await rejectsCode(() => resolver.resolve(binding({ ...legacyBase, config: {} }), context()), 'CONNECTION_LEGACY_POINTER_REQUIRED')
  const unconfirmedLegacyTenant = await createConnectionResolver({
    facade: { async resolveConnectionRegistration(id) { return registration({ id, tenantId: null, scopeKind: 'legacy_private' }) } },
  }).resolve(binding(legacyBase), context())
  assert.equal(unconfirmedLegacyTenant.config.dataSourceId, 'connection_1',
    'a pre-cutover tenant-null registration remains owner-user only')
  await rejectsCode(
    () => createConnectionResolver({
      facade: {
        async resolveConnectionRegistration(id) {
          return registration({ id, tenantId: 'tenant_2', scopeKind: 'legacy_private' })
        },
      },
    }).resolve(binding(legacyBase), context()),
    'CONNECTION_TENANT_MISMATCH',
  )
  await rejectsCode(
    () => createConnectionResolver({ facade: { async resolveConnectionRegistration(id) { return registration({ id, scopeKind: 'workspace' }) } } })
      .resolve(binding(legacyBase), context()),
    'CONNECTION_LEGACY_FALLBACK_DENIED',
  )

  // Undefined is a post-cutover/new-shape orphan, never an implicit legacy read.
  await rejectsCode(
    () => resolver.resolve(binding({ connectionId: undefined, legacyConnectionFallbackEligible: true, config: { dataSourceId: 'connection_1' } }), context()),
    'CONNECTION_ID_REQUIRED',
  )

  console.log('✓ connection-resolver policy tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
