'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  CANONICAL_OBJECT_VERSION,
  SOURCE_CONFIG_KEY,
  deriveStockPreparationSqlServerSourceAnchors,
  resolveStockPreparationSqlServerSource,
} = require(
  '../lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs'
)

const IDENTITY_KEY = crypto
  .createHash('sha256')
  .update('s6a-source-authority-test-key')
  .digest()

function bindingDraft(overrides = {}) {
  return {
    approvedConfigVersionId: 'config-s6a-v1',
    bindingVersion: 'binding-s6a-v1',
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    externalSystemId: 'system-s6a',
    objectKey: 'stock-preparation-bom',
    relationId: 'sqlserver.relation.rowid_payload.v1',
    tableRef: 'dbo.stock_prep_sealed_rows',
    tenantId: 'tenant-s6a',
    workspaceId: null,
    ...overrides,
  }
}

function externalSystem(overrides = {}) {
  return {
    capabilities: {},
    config: {
      [SOURCE_CONFIG_KEY]: {
        database: 'PDM',
        encrypt: true,
        instanceName: null,
        port: 1433,
        server: 'sqlserver.internal',
        trustServerCertificate: false,
      },
    },
    createdAt: '2026-07-31T00:00:00.000Z',
    credentials: {
      [SOURCE_CONFIG_KEY]: {
        password: 'private-password',
        user: 'readonly_user',
      },
    },
    id: 'system-s6a',
    kind: 'data-source:sql-readonly',
    lastError: null,
    lastTestedAt: null,
    name: 'S6A SQL Server',
    projectId: null,
    role: 'source',
    status: 'active',
    tenantId: 'tenant-s6a',
    updatedAt: '2026-07-31T00:00:00.000Z',
    workspaceId: null,
    ...overrides,
  }
}

function enrolledBinding(draft, anchors) {
  return {
    ...draft,
    bindingId: 'binding-row-s6a',
    configContentKey: anchors.configContentKey,
    expiresAt: '2099-01-01T00:00:00.000Z',
    roleBindingFingerprint: anchors.roleBindingFingerprint,
    systemContentKey: anchors.systemContentKey,
    tenantDomainBinding: anchors.tenantDomainBinding,
  }
}

async function refuses(action, reason = 'SEALED_EXPORT_BINDING_UNQUALIFIED') {
  let caught = null
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  assert.equal(JSON.stringify(caught).includes('private-password'), false)
}

async function main() {
  const draft = bindingDraft()
  const system = externalSystem()
  const derived = deriveStockPreparationSqlServerSourceAnchors({
    binding: draft,
    externalSystem: system,
    identityKey: IDENTITY_KEY,
  })
  const binding = enrolledBinding(draft, derived.anchors)
  const resolved = resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: system,
    identityKey: IDENTITY_KEY,
  })
  assert.equal(resolved.connectionConfig.password, 'private-password')
  assert.equal(resolved.connectionConfig.options.readOnlyIntent, true)
  assert.equal(Object.isFrozen(resolved.connectionConfig), true)
  assert.equal(Object.isFrozen(resolved.connectionConfig.options), true)
  assert.deepEqual(resolved.authority, {
    roleBindingFingerprint: binding.roleBindingFingerprint,
    systemContentKey: binding.systemContentKey,
    tenantDomainBinding: binding.tenantDomainBinding,
    tenantId: draft.tenantId,
    workspaceId: null,
  })
  assert.equal(
    JSON.stringify({ anchors: resolved.anchors, binding: resolved.binding })
      .includes('private-password'),
    false,
  )

  const rotatedSystem = externalSystem({
    credentials: {
      [SOURCE_CONFIG_KEY]: {
        password: 'rotated-password',
        user: 'readonly_user',
      },
    },
  })
  const rotated = resolveStockPreparationSqlServerSource({
    binding,
    externalSystem: rotatedSystem,
    identityKey: IDENTITY_KEY,
  })
  assert.deepEqual(rotated.anchors, resolved.anchors)
  assert.equal(rotated.connectionConfig.password, 'rotated-password')

  for (const changedSystem of [
    externalSystem({
      config: {
        [SOURCE_CONFIG_KEY]: {
          ...system.config[SOURCE_CONFIG_KEY],
          server: 'attacker.internal',
        },
      },
    }),
    externalSystem({
      credentials: {
        [SOURCE_CONFIG_KEY]: {
          password: 'private-password',
          user: 'different_user',
        },
      },
    }),
    externalSystem({ status: 'inactive' }),
    externalSystem({ tenantId: 'foreign-tenant' }),
  ]) {
    await refuses(
      () => resolveStockPreparationSqlServerSource({
        binding,
        externalSystem: changedSystem,
        identityKey: IDENTITY_KEY,
      }),
    )
  }

  const changedSelection = deriveStockPreparationSqlServerSourceAnchors({
    binding: bindingDraft({ tableRef: 'dbo.other_rows' }),
    externalSystem: system,
    identityKey: IDENTITY_KEY,
  })
  assert.notEqual(
    changedSelection.anchors.configContentKey,
    derived.anchors.configContentKey,
  )
  await refuses(
    () => resolveStockPreparationSqlServerSource({
      binding: {
        ...binding,
        tableRef: 'dbo.other_rows',
      },
      externalSystem: system,
      identityKey: IDENTITY_KEY,
    }),
  )

  await refuses(
    () => deriveStockPreparationSqlServerSourceAnchors({
      binding: bindingDraft({ tableRef: 'dbo.rows; DROP TABLE x' }),
      externalSystem: system,
      identityKey: IDENTITY_KEY,
    }),
  )
  await refuses(
    () => deriveStockPreparationSqlServerSourceAnchors({
      binding: bindingDraft({ workspaceId: 'workspace-1' }),
      externalSystem: externalSystem({ workspaceId: 'workspace-1' }),
      identityKey: IDENTITY_KEY,
    }),
  )
  await refuses(
    () => deriveStockPreparationSqlServerSourceAnchors({
      binding: draft,
      externalSystem: externalSystem({
        config: {
          [SOURCE_CONFIG_KEY]: {
            ...system.config[SOURCE_CONFIG_KEY],
            query: 'SELECT * FROM secret',
          },
        },
      }),
      identityKey: IDENTITY_KEY,
    }),
  )

  const mutable = externalSystem()
  const owned = deriveStockPreparationSqlServerSourceAnchors({
    binding: draft,
    externalSystem: mutable,
    identityKey: IDENTITY_KEY,
  })
  mutable.config[SOURCE_CONFIG_KEY].server = 'mutated-after-resolution'
  mutable.credentials[SOURCE_CONFIG_KEY].password = 'mutated-after-resolution'
  assert.equal(owned.connectionConfig.server, 'sqlserver.internal')
  assert.equal(owned.connectionConfig.password, 'private-password')

  const hostile = externalSystem()
  Object.defineProperty(hostile.config, SOURCE_CONFIG_KEY, {
    enumerable: true,
    get() {
      throw new Error('foreign getter text')
    },
  })
  await refuses(
    () => deriveStockPreparationSqlServerSourceAnchors({
      binding: draft,
      externalSystem: hostile,
      identityKey: IDENTITY_KEY,
    }),
  )

  console.log('sealed-export-s6a-source-authority.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
