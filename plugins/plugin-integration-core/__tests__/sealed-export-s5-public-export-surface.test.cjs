'use strict'

// Mechanical public-export negative control for S5 (issue #4690 review).
// Re-adding any trust-granting harness/factory name to a production export
// surface must RED this suite.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  FORBIDDEN_PUBLIC_EXPORT_NAMES,
  PRODUCT_CONFIG_FIELDS,
  createSqlServerSealedSnapshotService,
} = require('../lib/sealed-export/sqlserver-sealed-snapshot-service.cjs')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const S5_MODULES = [
  'sqlserver-sealed-snapshot-profile.cjs',
  'sqlserver-sealed-snapshot-source-session.cjs',
  'sqlserver-sealed-snapshot-action.cjs',
  'sqlserver-sealed-snapshot-service.cjs',
  'sqlserver-sealed-snapshot-service-core.cjs',
  'sealed-export-binding-qualification.cjs',
  'sealed-export-signer-authority.cjs',
  'sealed-export-signer-authority-store.cjs',
  'sealed-export-package-provenance.cjs',
]

function noForbiddenExportNamesOnProductionSurface() {
  for (const name of S5_MODULES) {
    const mod = require(path.join(SEALED_DIR, name))
    const keys = Object.keys(mod)
    for (const forbidden of FORBIDDEN_PUBLIC_EXPORT_NAMES) {
      assert.equal(
        keys.includes(forbidden),
        false,
        `${name} must not export ${forbidden}`,
      )
    }
    assert.equal(
      keys.includes('__internals'),
      false,
      `${name} must not export __internals trust seams`,
    )
    assert.equal(
      keys.includes('__serviceOnly'),
      false,
      `${name} must not export __serviceOnly trust seams`,
    )
  }
  const store = require('../lib/sealed-export/sealed-export-signer-authority-store.cjs')
  const sourceSession = require('../lib/sealed-export/sqlserver-sealed-snapshot-source-session.cjs')
  assert.equal(store.createMemorySignerAuthorityDb, undefined)
  assert.equal(sourceSession.openHermeticSnapshotCaptureContext, undefined)
  assert.deepEqual(PRODUCT_CONFIG_FIELDS, [
    'approvedBindings',
    'artifactRoot',
    'authorityDb',
    'connectionConfig',
    'onReaderActive',
    'privateSignerMaterials',
    'qualificationKeyring',
    'stageObserver',
    'systemContentKey',
    'tenantId',
    'workspaceId',
  ])
}

function duckTypedServicesCannotForgeProductBrand() {
  // Caller-built plain objects are never product services. The named product
  // factory remains the declared first-party trust-minting path.
  const fake = {
    execute: async () => ({}),
    actionId: 'sealed_snapshot',
  }
  const {
    isSqlServerSealedSnapshotService,
  } = require('../lib/sealed-export/sqlserver-sealed-snapshot-service.cjs')
  assert.equal(isSqlServerSealedSnapshotService(fake), false)
  assert.equal(isSqlServerSealedSnapshotService(null), false)
  assert.equal(isSqlServerSealedSnapshotService({}), false)
}

async function executeRefusesCallerTrustAndSecretKeys() {
  const crypto = require('node:crypto')
  const {
    createEd25519SignerMaterial,
  } = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
  const {
    computeQueryBindingDigest,
    SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  } = require('../lib/sealed-export/sqlserver-sealed-snapshot-action.cjs')
  const digests = require('../lib/sealed-export/digests.cjs')
  const {
    SealedExportError,
  } = require('../lib/sealed-export/failure-vocabulary.cjs')
  const {
    isSqlServerSealedSnapshotService,
  } = require('../lib/sealed-export/sqlserver-sealed-snapshot-service.cjs')
  const {
    createHermeticSqlServerSealedSnapshotServiceForTests,
  } = require('./support/sealed-export-s5-hermetic-service.cjs')
  const {
    createMemorySignerAuthorityDb,
  } = require('./support/sealed-export-signer-authority-memory-db.cjs')

  const material = createEd25519SignerMaterial()
  const objectKey = 'orders.lines'
  const relationId = 'sqlserver.relation.rowid_payload.v1'
  const tableRef = 'dbo.orders_lines'
  const queryDigest = computeQueryBindingDigest({
    objectKey,
    relationId,
    tableRef,
  })
  const productConfig = {
    tenantId: 't1',
    workspaceId: null,
    systemContentKey: 'sys-1',
    artifactRoot: '/tmp',
    connectionConfig: {
      database: 'db',
      options: { encrypt: true },
      password: 'not-used',
      server: 'localhost',
      user: 'user',
    },
    onReaderActive: null,
    stageObserver: null,
    qualificationKeyring: {
      keyId: 'k1',
      secret: crypto.randomBytes(32),
    },
    approvedBindings: [
      {
        objectKey,
        relationId,
        tableRef,
        approvedConfigVersionId: 'cfgv',
        bindingVersion: 'b1',
        configContentKey: 'cfg-1',
        canonicalObjectVersion: 'obj-v1',
        roleBindingFingerprint: 'rb',
        tenantDomainBinding: 'domain-1',
      },
    ],
    authorityDb: createMemorySignerAuthorityDb(),
    privateSignerMaterials: [
      { privateKey: material.privateKey, signerKeyId: material.signerKeyId },
    ],
  }
  const service = createSqlServerSealedSnapshotService(productConfig)
  assert.equal(isSqlServerSealedSnapshotService(service), true)
  const {
    connectionConfig: _connectionConfig,
    ...sharedConfig
  } = productConfig
  const hermetic = createHermeticSqlServerSealedSnapshotServiceForTests({
    ...sharedConfig,
    hermeticCapture: { rows: [], snapshotCapable: true },
  })
  assert.equal(isSqlServerSealedSnapshotService(hermetic), false)
  let hermeticCaught
  try {
    createSqlServerSealedSnapshotService({
      ...productConfig,
      mode: 'hermetic',
      hermeticCapture: { rows: [] },
    })
  } catch (error) {
    hermeticCaught = error
  }
  assert.ok(hermeticCaught instanceof SealedExportError)
  assert.equal(hermeticCaught.reason, 'SEALED_EXPORT_PROFILE_UNCERTIFIED')

  const envelopeBase = {
    exportRequestId: 'e1',
    nonce: 'n1',
    expiry: '2099-01-01T00:00:00.000Z',
    scenarioVersion: 's1',
    bindingVersion: 'b1',
    roleId: 'r1',
    actionProfileVersion: 'sqlserver.sealed_snapshot.v1',
    roleBindingFingerprint: 'rb',
    systemContentKey: 'sys-1',
    approvedConfigVersionId: 'cfgv',
    configContentKey: 'cfg-1',
    canonicalObjectVersion: 'obj-v1',
    qualificationDigest: digests.digestBytes(Buffer.from('x')).digest,
    executionMode: 'S5',
    applyProfileVersion: 'NO_APPLY',
    queryObjectFilterBindingDigest: queryDigest,
    expectedSourceSchemaFieldMapDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    tenantDomainBinding: 'domain-1',
    rowBudget: 10,
    byteBudget: 1024,
    chunkBudget: 10,
  }

  const forbiddenPayloads = [
    { resolution: {} },
    { sourceSession: {} },
    { signerAuthority: {} },
    { signerKeyId: material.signerKeyId },
    { qualificationEnvelopeKey: { keyId: 'x', secret: crypto.randomBytes(32) } },
    { qualification: {} },
    { sql: 'SELECT 1' },
    { connectionConfig: {} },
    { privateKey: material.privateKey },
    { nowMs: 123 },
    { artifactRoot: '/tmp' },
    { onReaderActive: null },
    { stageObserver: null },
  ]

  for (const extra of forbiddenPayloads) {
    let caught
    try {
      await service.execute({
        envelope: envelopeBase,
        ...extra,
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof SealedExportError)
    assert.ok(
      caught.reason === 'SEALED_EXPORT_PROFILE_UNCERTIFIED' ||
        caught.reason === 'SEALED_EXPORT_INTERNAL_ERROR',
      `unexpected reason ${caught.reason}`,
    )
  }
}

function sourceTextHasNoReexportedHarnesses() {
  for (const name of S5_MODULES) {
    const text = fs.readFileSync(path.join(SEALED_DIR, name), 'utf8')
    // module.exports must not re-export createHarness* or createTrusted*
    // as a public grant surface.
    assert.doesNotMatch(
      text,
      /module\.exports[\s\S]{0,2000}createHarness/,
      `${name} must not export harness factories`,
    )
    assert.doesNotMatch(
      text,
      /module\.exports[\s\S]{0,2000}createTrustedSqlServer/,
      `${name} must not export createTrustedSqlServer*`,
    )
    assert.doesNotMatch(
      text,
      /module\.exports[\s\S]{0,2000}createFirstPartySignerAuthority/,
      `${name} must not export createFirstPartySignerAuthority`,
    )
  }
}

async function main() {
  noForbiddenExportNamesOnProductionSurface()
  duckTypedServicesCannotForgeProductBrand()
  await executeRefusesCallerTrustAndSecretKeys()
  sourceTextHasNoReexportedHarnesses()
  console.log('sealed-export-s5-public-export-surface.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
