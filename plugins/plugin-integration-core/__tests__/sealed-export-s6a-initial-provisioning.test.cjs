'use strict'

const assert = require('node:assert/strict')

const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  createSealedExportLifecycleProvisioning,
} = require(
  '../lib/sealed-export/sealed-export-lifecycle-provisioning.cjs'
)
const {
  createEd25519SignerMaterial,
} = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
const {
  AUTHORITY_STATE_TABLE,
  PUBLIC_KEY_TABLE,
} = require(
  '../lib/sealed-export/sealed-export-signer-authority-store.cjs'
)
const {
  BINDING_TABLE,
} = require('../lib/sealed-export/stock-preparation-runtime-store.cjs')

const NOW = Date.parse('2026-07-31T00:00:00Z')

function matches(row, where) {
  return Object.entries(where).every(([field, expected]) =>
    expected === null
      ? row[field] === null || row[field] === undefined
      : row[field] === expected,
  )
}

function cloneTables(tables) {
  return new Map([...tables].map(([table, rows]) => [
    table,
    rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([field, value]) => [
        field,
        Buffer.isBuffer(value) ? Buffer.from(value) : value,
      ]),
    )),
  ]))
}

function createMemoryDb() {
  let tables = new Map([
    [BINDING_TABLE, []],
    [AUTHORITY_STATE_TABLE, []],
    [PUBLIC_KEY_TABLE, []],
  ])
  let failAuthorityInsert = false

  function api(target) {
    return {
      async insertOne(table, row) {
        if (!target.has(table)) throw new Error('unexpected table')
        if (table === AUTHORITY_STATE_TABLE && failAuthorityInsert) {
          failAuthorityInsert = false
          throw new Error('driver leaked authority table')
        }
        target.get(table).push({ ...row })
        return [{ ...row }]
      },
      async selectOneForUpdate(table, where) {
        return target.get(table).find((row) => matches(row, where)) || null
      },
      async updateRow(table, patch, where) {
        const row = target.get(table).find(
          (candidate) => matches(candidate, where),
        )
        if (!row) return []
        Object.assign(row, patch)
        return [{ ...row }]
      },
    }
  }

  return {
    failNextAuthorityInsert() {
      failAuthorityInsert = true
    },
    rows(table) {
      return cloneTables(tables).get(table)
    },
    async insertOne(...args) {
      return api(tables).insertOne(...args)
    },
    async selectOneForUpdate(...args) {
      return api(tables).selectOneForUpdate(...args)
    },
    async transaction(callback) {
      const candidate = cloneTables(tables)
      const result = await callback(api(candidate))
      tables = candidate
      return result
    },
    async updateRow(...args) {
      return api(tables).updateRow(...args)
    },
  }
}

function fixture(publicKey, overrides = {}) {
  const scope = {
    roleBindingFingerprint: '4'.repeat(64),
    systemContentKey: '3'.repeat(64),
    tenantDomainBinding: '2'.repeat(64),
    tenantId: 'tenant-s6a',
    workspaceId: null,
  }
  return {
    authority: {
      bindingExpiresAt: '2026-08-01T00:00:00Z',
      publicKey,
      qualificationDigest: '5'.repeat(64),
      qualificationExpiresAt: '2026-08-01T00:00:00Z',
      scope,
      signerExpiresAt: '2026-08-02T00:00:00Z',
    },
    binding: {
      approvedConfigVersionId: 'config-s6a-v1',
      bindingId: 'binding-s6a-v1',
      bindingVersion: 'binding-s6a-v1',
      canonicalObjectVersion: 'stock-preparation-bom.v1',
      configContentKey: '1'.repeat(64),
      expiresAt: '2026-08-01T00:00:00Z',
      externalSystemId: 'external-system-s6a',
      objectKey: 'stock-preparation-bom',
      relationId: 'sqlserver.relation.rowid_payload.v1',
      roleBindingFingerprint: scope.roleBindingFingerprint,
      systemContentKey: scope.systemContentKey,
      tableRef: 'dbo.stock_prep_sealed_rows',
      tenantDomainBinding: scope.tenantDomainBinding,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
    },
    ...overrides,
  }
}

async function refusal(action, reason) {
  let caught
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  assert.equal(caught.message.includes('authority table'), false)
}

async function main() {
  const material = createEd25519SignerMaterial()
  const db = createMemoryDb()
  const service = createSealedExportLifecycleProvisioning({
    clock: () => NOW,
    db,
  })
  const created = await service.provisionInitialStockPreparationBinding(
    fixture(material.publicKey),
  )
  assert.deepEqual(created, {
    changed: true,
    externalWrite: false,
    operation: 'INITIAL_PROVISIONED',
    valuesFree: true,
  })
  assert.equal(db.rows(BINDING_TABLE).length, 1)
  assert.equal(db.rows(AUTHORITY_STATE_TABLE).length, 1)
  assert.equal(db.rows(PUBLIC_KEY_TABLE).length, 1)

  const replay = await service.provisionInitialStockPreparationBinding(
    fixture(material.publicKey),
  )
  assert.equal(replay.changed, false)

  const refreshedInput = fixture(material.publicKey)
  refreshedInput.authority = {
    ...refreshedInput.authority,
    qualificationDigest: '6'.repeat(64),
    qualificationExpiresAt: '2026-08-01T00:01:00Z',
  }
  const refreshed = await service.provisionInitialStockPreparationBinding(
    refreshedInput,
  )
  assert.deepEqual(refreshed, {
    changed: true,
    externalWrite: false,
    operation: 'QUALIFICATION_REFRESHED',
    valuesFree: true,
  })
  assert.equal(
    db.rows(AUTHORITY_STATE_TABLE)[0].qualification_digest,
    '6'.repeat(64),
  )
  assert.equal(db.rows(BINDING_TABLE).length, 1)
  assert.equal(db.rows(PUBLIC_KEY_TABLE).length, 1)

  const mismatched = fixture(material.publicKey)
  mismatched.binding = {
    ...mismatched.binding,
    externalSystemId: 'other-system',
  }
  await refusal(
    () => service.provisionInitialStockPreparationBinding(mismatched),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
  assert.equal(db.rows(BINDING_TABLE).length, 1)

  const rollbackDb = createMemoryDb()
  rollbackDb.failNextAuthorityInsert()
  const rollbackService = createSealedExportLifecycleProvisioning({
    clock: () => NOW,
    db: rollbackDb,
  })
  await refusal(
    () => rollbackService.provisionInitialStockPreparationBinding(
      fixture(material.publicKey),
    ),
    'SEALED_EXPORT_INTERNAL_ERROR',
  )
  assert.equal(rollbackDb.rows(BINDING_TABLE).length, 0)
  assert.equal(rollbackDb.rows(PUBLIC_KEY_TABLE).length, 0)

  const rawSql = fixture(material.publicKey)
  rawSql.binding = {
    ...rawSql.binding,
    tableRef: 'dbo.rows; DROP TABLE users',
  }
  await refusal(
    () => rollbackService.provisionInitialStockPreparationBinding(rawSql),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )

  console.log('sealed-export-s6a-initial-provisioning.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
