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
const EXACT_PUBLIC_EXPORTS = Object.freeze({
  'sqlserver-sealed-snapshot-profile.cjs': Object.freeze([
    'SQLSERVER_SEALED_SNAPSHOT_ACTION_ID',
    'SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND',
    'SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION',
    'SQLSERVER_SEALED_SNAPSHOT_PROFILE',
    'SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID',
    'SQLSERVER_SEALED_SNAPSHOT_RECOVERY_STRATEGY',
    'assertSealedSnapshotCompletenessEvidence',
    'successfulSealedSnapshotCompletenessEvidence',
  ]),
  'sqlserver-sealed-snapshot-source-session.cjs': Object.freeze([
    'SNAPSHOT_CAPABILITY_SQL',
    'isMssqlSnapshotCaptureContext',
    'openMssqlSnapshotCaptureContext',
  ]),
  'sqlserver-sealed-snapshot-action.cjs': Object.freeze([
    'CAPTURE_METADATA_SQL',
    'CERTIFIED_RELATIONS',
    'SEALED_EXPORT_S5_AGENT_PROTOCOL_VERSION',
    'SEALED_EXPORT_S5_CHUNK_BYTES',
    'SEALED_EXPORT_S5_ENCODING_VERSION',
    'SEALED_EXPORT_S5_SORT_MERGE_FAN_IN',
    'SEALED_EXPORT_S5_SORT_RUN_BYTES',
    'SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST',
    'SOURCE_FIELDS',
    'SQLSERVER_SEALED_SNAPSHOT_ACTION_ID',
    'SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION',
    'SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID',
    'assertSafeSqlServerRelation',
    'buildOrderingKeyUniquenessProbeSql',
    'computeQueryBindingDigest',
    'resolveCertifiedRelation',
  ]),
  'sqlserver-sealed-snapshot-service.cjs': Object.freeze([
    'EXECUTE_INPUT_FIELDS',
    'FORBIDDEN_EXECUTE_KEYS',
    'FORBIDDEN_PUBLIC_EXPORT_NAMES',
    'PRODUCT_CONFIG_FIELDS',
    'createSqlServerSealedSnapshotService',
    'isSqlServerSealedSnapshotService',
  ]),
  'sqlserver-sealed-snapshot-service-core.cjs': Object.freeze([
    'EXECUTE_INPUT_FIELDS',
    'FORBIDDEN_EXECUTE_KEYS',
    'FORBIDDEN_PUBLIC_EXPORT_NAMES',
    'createSqlServerSealedSnapshotServiceCore',
  ]),
  'sealed-export-binding-qualification.cjs': Object.freeze([
    'ENVELOPE_SECRET_MIN_BYTES',
    'computeEnvelopeMac',
    'computeQualificationDigest',
    'probeQualificationWithKey',
    'sealedExportQualificationEvidence',
    'verifyQualificationWithKey',
  ]),
  'sealed-export-signer-authority.cjs': Object.freeze([
    'SIGNATURE_ALGORITHM',
    'createCallerBuiltPublicVerifier',
    'createEd25519SignerMaterial',
    'decodeCanonicalSignature',
    'deriveSignerKeyId',
    'normalizePrivateKey',
    'normalizePublicKey',
  ]),
  'sealed-export-signer-authority-store.cjs': Object.freeze([
    'AUTHORITY_STATE_TABLE',
    'PUBLIC_KEY_TABLE',
    'SIGNATURE_ALGORITHM',
    'TABLE',
    'createSignerAuthorityStore',
    'deriveSignerKeyIdFromDer',
    'workspaceScopeKey',
  ]),
  'sealed-export-package-provenance.cjs': Object.freeze([
    'FROZEN_MANIFEST_RELATIVE',
    'PACKAGE_PROVENANCE_VERSION',
    'PINNED_EVIDENCE_FILES',
    'PINNED_EXTERNAL_MODULES',
    'PINNED_MIGRATIONS',
    'PINNED_PROFILE_IDENTITY',
    'PINNED_RUNTIME_DEPENDENCIES',
    'PINNED_RUNTIME_FILES',
    'PINNED_S1_MODULES',
    'PINNED_S2_MODULES',
    'PINNED_S3_MODULES',
    'PINNED_S4_MODULES',
    'PINNED_S5_MODULES',
    'PINNED_S6_MODULES',
    'computePackageProvenancePinSet',
    'verifySealedExportPackageProvenance',
    'verifySealedExportRuntimePackageProvenance',
  ]),
})

function noForbiddenExportNamesOnProductionSurface() {
  for (const name of S5_MODULES) {
    const mod = require(path.join(SEALED_DIR, name))
    const keys = Object.keys(mod).sort()
    assert.deepEqual(
      keys,
      [...EXACT_PUBLIC_EXPORTS[name]].sort(),
      `${name} public exports must match the certified roster exactly`,
    )
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
  const authorityDb = createMemorySignerAuthorityDb()
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
    authorityDb,
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

async function productionIngestionVerifierUsesProductLifecycleAuthority() {
  const crypto = require('node:crypto')
  const contracts = require('../lib/sealed-export/contracts.cjs')
  const canonicalCodec = require('../lib/sealed-export/canonical-json.cjs')
  const {
    createEd25519SignerMaterial,
  } = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
  const {
    AUTHORITY_STATE_TABLE,
    createSignerAuthorityStore,
  } = require('../lib/sealed-export/sealed-export-signer-authority-store.cjs')
  const {
    computeQueryBindingDigest,
    SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  } = require('../lib/sealed-export/sqlserver-sealed-snapshot-action.cjs')
  const {
    createSqlServerPrivateIngestionManifestVerifier,
    isTrustedPrivateIngestionManifestVerifier,
  } = require('../lib/sealed-export/private-ingestion-manifest-verifier.cjs')
  const {
    createPrivateIngestionService,
  } = require('../lib/sealed-export/private-ingestion-service.cjs')
  const {
    SealedExportError,
  } = require('../lib/sealed-export/failure-vocabulary.cjs')
  const {
    createMemorySignerAuthorityDb,
  } = require('./support/sealed-export-signer-authority-memory-db.cjs')

  const material = createEd25519SignerMaterial()
  const authorityDb = createMemorySignerAuthorityDb()
  const authority = Object.freeze({
    roleBindingFingerprint: 'rb',
    systemContentKey: 'sys-1',
    tenantDomainBinding: 'domain-1',
    tenantId: 't1',
    workspaceId: null,
  })
  const binding = Object.freeze({
    approvedConfigVersionId: 'cfgv',
    bindingVersion: 'b1',
    canonicalObjectVersion: 'obj-v1',
    configContentKey: 'cfg-1',
    objectKey: 'orders.lines',
    relationId: 'sqlserver.relation.rowid_payload.v1',
    roleBindingFingerprint: authority.roleBindingFingerprint,
    tableRef: 'dbo.orders_lines',
    tenantDomainBinding: authority.tenantDomainBinding,
  })
  const service = createSqlServerSealedSnapshotService({
    approvedBindings: [binding],
    artifactRoot: '/tmp',
    authorityDb,
    connectionConfig: {
      database: 'db',
      options: { encrypt: true },
      password: 'not-used',
      server: 'localhost',
      user: 'user',
    },
    onReaderActive: null,
    privateSignerMaterials: [
      { privateKey: material.privateKey, signerKeyId: material.signerKeyId },
    ],
    qualificationKeyring: {
      keyId: 'k1',
      secret: crypto.randomBytes(32),
    },
    stageObserver: null,
    systemContentKey: authority.systemContentKey,
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
  })
  const qualificationDigest = crypto
    .createHash('sha256')
    .update('s6a-production-verifier-qualification')
    .digest('hex')
  const authorityStore = createSignerAuthorityStore({ db: authorityDb })
  await authorityStore.enrollPublicKey(authority, {
    publicKey: material.publicKey,
    signerKeyId: material.signerKeyId,
  })
  await authorityDb.insertOne(AUTHORITY_STATE_TABLE, {
    binding_current: true,
    binding_expires_at: '2099-01-01T00:00:00.000Z',
    qualification_current: true,
    qualification_digest: qualificationDigest,
    qualification_expires_at: '2099-01-01T00:00:00.000Z',
    role_binding_fingerprint: authority.roleBindingFingerprint,
    signer_expires_at: '2099-01-01T00:00:00.000Z',
    signer_key_id: material.signerKeyId,
    signer_status: 'ACTIVE',
    system_content_key: authority.systemContentKey,
    tenant_domain_binding: authority.tenantDomainBinding,
    tenant_id: authority.tenantId,
    workspace_id: authority.workspaceId,
  })
  const envelope = {
    actionProfileVersion: 'sqlserver.sealed_snapshot.v1',
    applyProfileVersion: 'NO_APPLY',
    approvedConfigVersionId: binding.approvedConfigVersionId,
    bindingVersion: binding.bindingVersion,
    byteBudget: 1024,
    canonicalObjectVersion: binding.canonicalObjectVersion,
    chunkBudget: 1,
    configContentKey: binding.configContentKey,
    executionMode: 'S6A',
    expectedSourceSchemaFieldMapDigest:
      SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    expiry: '2099-01-01T00:00:00.000Z',
    exportRequestId: 's6a-export',
    nonce: 's6a-nonce',
    qualificationDigest,
    queryObjectFilterBindingDigest: computeQueryBindingDigest(binding),
    roleBindingFingerprint: authority.roleBindingFingerprint,
    roleId: 'stock-preparation-source',
    rowBudget: 10,
    scenarioVersion: 'stock-preparation.v1',
    systemContentKey: authority.systemContentKey,
    tenantDomainBinding: authority.tenantDomainBinding,
  }
  const emptyDigest = crypto.createHash('sha256').update('').digest('hex')
  const unsignedManifest = {
    agentImplementationVersion: 's6a-test-agent',
    agentProtocolVersion: 's6a-test-protocol',
    canonicalRowsetMultiplicityDigest: emptyDigest,
    canonicalizationVersion:
      canonicalCodec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    captureCompletionTimestamp: '2026-07-31T00:00:00.000Z',
    chunks: [
      {
        byteCount: 0,
        chunkDigest: emptyDigest,
        chunkIndex: 0,
      },
    ],
    encodingVersion: 's6a-test-encoding',
    exportRequestEnvelopeDigest:
      contracts.computeExportRequestEnvelopeDigest(envelope),
    manifestExpiry: '2099-01-01T00:00:00.000Z',
    signature: 'AA==',
    signatureAlgorithm: 'ED25519',
    signerKeyId: material.signerKeyId,
    sourceCaptureIdentity: 's6a-test-capture',
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    sourceSchemaDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    totalBytes: 0,
    totalRows: 0,
    wholeArtifactByteDigest: emptyDigest,
  }
  const manifest = {
    ...unsignedManifest,
    signature: crypto
      .sign(
        null,
        contracts.computeSignedManifestBytes(unsignedManifest),
        material.privateKey,
      )
      .toString('base64'),
  }
  const verifier = createSqlServerPrivateIngestionManifestVerifier({
    envelope,
    sealedSnapshotService: service,
  })
  assert.equal(isTrustedPrivateIngestionManifestVerifier(verifier), true)
  envelope.nonce = 'caller-mutated-after-construction'
  const verified = await verifier.verify(manifest)
  assert.equal(verified.signatureVerified, true)

  assert.throws(
    () => createSqlServerPrivateIngestionManifestVerifier({
      envelope,
      sealedSnapshotService: {
        verifyManifestWithLifecycle: service.verifyManifestWithLifecycle,
      },
    }),
    (error) => (
      error instanceof SealedExportError
      && error.reason === 'SEALED_EXPORT_INTERNAL_ERROR'
    ),
  )

  let metadataWrites = 0
  const metadataStore = Object.freeze({
    async beginChunkWrite() {},
    async beginCleanup() {},
    async claimCompletedSession() {},
    async createSession() {
      metadataWrites += 1
    },
    async finishChunkWrite() {},
    async listExpiredSessions() { return [] },
    async listReceipts() { return [] },
    async markComplete() {},
    async readState() { return { kind: 'MISSING' } },
    async releaseChunkWrite() {},
    async releaseGenerationClaim() {},
    async tombstoneAndDelete() {},
  })
  const blobStore = Object.freeze({
    async createSessionArea() {},
    async readChunk() {},
    async readChunkIfPresent() {},
    async removeSession() {},
    async writeChunk() {},
  })
  const ingestionService = createPrivateIngestionService({
    authority,
    blobStore,
    clock: () => new Date('2026-07-31T00:00:00.000Z'),
    manifestVerifier: verifier,
    metadataStore,
  })
  const tamperedManifest = {
    ...manifest,
    signature: Buffer.alloc(64).toString('base64'),
  }
  await assert.rejects(
    () => ingestionService.createSession({
      envelope: {
        ...envelope,
        nonce: 's6a-nonce',
      },
      manifest: tamperedManifest,
    }),
    (error) => (
      error instanceof SealedExportError
      && error.reason === 'SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID'
    ),
  )
  assert.equal(metadataWrites, 0)
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
  await productionIngestionVerifierUsesProductLifecycleAuthority()
  sourceTextHasNoReexportedHarnesses()
  console.log('sealed-export-s5-public-export-surface.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
