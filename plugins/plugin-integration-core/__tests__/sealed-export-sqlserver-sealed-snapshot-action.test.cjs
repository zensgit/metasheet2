'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const digests = require('../lib/sealed-export/digests.cjs')
const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  createEd25519SignerMaterial,
} = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
const {
  CAPTURE_METADATA_SQL,
  CERTIFIED_RELATIONS,
  computeQueryBindingDigest,
  resolveCertifiedRelation,
  SEALED_EXPORT_S5_CHUNK_BYTES,
  SEALED_EXPORT_S5_SORT_RUN_BYTES,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
} = require('../lib/sealed-export/sqlserver-sealed-snapshot-action.cjs')
const {
  createHermeticSqlServerSealedSnapshotServiceForTests:
    createSqlServerSealedSnapshotService,
} = require('./support/sealed-export-s5-hermetic-service.cjs')
const {
  AUTHORITY_STATE_TABLE,
  createSignerAuthorityStore,
} = require('../lib/sealed-export/sealed-export-signer-authority-store.cjs')
const {
  createMemorySignerAuthorityDb,
} = require('./support/sealed-export-signer-authority-memory-db.cjs')
const {
  SEALED_EXPORT_S2_ACTION_ID,
} = require('../lib/sealed-export/sqlserver-s2-producer.cjs')
const {
  openMssqlSnapshotCaptureContext,
} = require('../lib/sealed-export/sqlserver-sealed-snapshot-source-session.cjs')

const OBJECT_KEY = 'orders.lines'
const RELATION_ID = 'sqlserver.relation.rowid_payload.v1'
const TABLE_REF = 'dbo.orders_lines'
const SYSTEM_CONTENT_KEY = 's5-system-content'
const CONFIG_CONTENT_KEY = 's5-config-content'
const CANONICAL_OBJECT_VERSION = 's5-object-v1'
const APPROVED_CONFIG_VERSION_ID = 's5-config-v1'
const BINDING_VERSION = 's5-binding-v1'
const ROLE_BINDING_FINGERPRINT = 's5-role-binding'
const TENANT_DOMAIN_BINDING = 's5-tenant-domain'

function certifiedRelationLookupRejectsPrototypeProperties() {
  assert.equal(resolveCertifiedRelation(RELATION_ID), CERTIFIED_RELATIONS[RELATION_ID])
  for (const relationId of ['constructor', 'toString', '__proto__']) {
    expectReason(
      () => resolveCertifiedRelation(relationId),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
  }
}

function sourceRows(count = 12, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    __databaseId: 7,
    __isolationLevel: 5,
    __productMajor: 16,
    __sessionId: 41,
    __snapshotEnabledState: 1,
    __transactionId: '9001',
    payload: `s5-payload-${String(index).padStart(4, '0')}-${'y'.repeat(200)}`,
    payloadVersion: 1,
    rowId: index + 1,
    ...overrides,
  }))
}

async function buildService(options = {}) {
  const material = options.material || createEd25519SignerMaterial()
  const authorityDb = options.authorityDb || createMemorySignerAuthorityDb()
  const authorityStore = createSignerAuthorityStore({ db: authorityDb })
  const tenantId = 'tenant-s5'
  const workspaceId =
    options.workspaceId === undefined ? null : options.workspaceId
  const systemContentKey = options.systemContentKey || SYSTEM_CONTENT_KEY
  const roleBindingFingerprint =
    options.roleBindingFingerprint || ROLE_BINDING_FINGERPRINT
  const tenantDomainBinding =
    options.tenantDomainBinding || TENANT_DOMAIN_BINDING
  const authorityScope = {
    roleBindingFingerprint,
    systemContentKey,
    tenantDomainBinding,
    tenantId,
    workspaceId,
  }
  if (options.skipPublicKeyEnrollment !== true) {
    await authorityStore.enrollPublicKey(authorityScope, {
      publicKey: material.publicKey,
      signerKeyId: material.signerKeyId,
    })
  }
  const queryDigest = computeQueryBindingDigest({
    objectKey: options.objectKey || OBJECT_KEY,
    relationId: RELATION_ID,
    tableRef: options.tableRef || TABLE_REF,
  })
  const service = createSqlServerSealedSnapshotService({
    tenantId,
    workspaceId,
    systemContentKey,
    artifactRoot: options.artifactRoot,
    onReaderActive: options.onReaderActive || null,
    stageObserver: options.stageObserver || null,
    hermeticCapture: {
      rows: options.rows || sourceRows(),
      streamRows: options.streamRows || options.rows || sourceRows(),
      snapshotCapable:
        options.snapshotCapable === undefined ? true : options.snapshotCapable,
    },
    qualificationKeyring: {
      keyId: 's5-keyring',
      secret: crypto.randomBytes(32),
    },
    approvedBindings:
      options.approvedBindings ||
      [
        {
          objectKey: options.objectKey || OBJECT_KEY,
          relationId: RELATION_ID,
          tableRef: options.tableRef || TABLE_REF,
          configContentKey: CONFIG_CONTENT_KEY,
          approvedConfigVersionId: APPROVED_CONFIG_VERSION_ID,
          bindingVersion: BINDING_VERSION,
          canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
          roleBindingFingerprint,
          tenantDomainBinding,
        },
      ],
    authorityDb,
    privateSignerMaterials: [
      {
        privateKey: material.privateKey,
        signerKeyId: material.signerKeyId,
      },
    ],
  })
  async function setAuthorityForQualification(qualification, overrides = {}) {
    service.verifyQualificationForBinding(
      qualification.objectKey,
      qualification,
    )
    const where = {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      tenant_domain_binding: tenantDomainBinding,
      system_content_key: systemContentKey,
      role_binding_fingerprint: roleBindingFingerprint,
    }
    const row = {
      ...where,
      signer_key_id: material.signerKeyId,
      signer_status: options.signerStatus || 'ACTIVE',
      signer_expires_at:
        options.signerExpiresAt || '2099-01-01T00:00:00.000Z',
      binding_current: true,
      binding_expires_at: '2099-01-01T00:00:00.000Z',
      qualification_digest: qualification.qualificationDigest,
      qualification_current: true,
      qualification_expires_at: qualification.expiresAt,
      ...overrides,
    }
    const existing = await authorityDb.selectOne(
      AUTHORITY_STATE_TABLE,
      where,
    )
    if (existing) {
      await authorityDb.updateRow(AUTHORITY_STATE_TABLE, where, row)
    } else {
      await authorityDb.insertOne(AUTHORITY_STATE_TABLE, row)
    }
  }
  async function qualify(objectKey = options.objectKey || OBJECT_KEY, overrides) {
    const qualification = await service.probeQualificationForBinding(objectKey)
    await setAuthorityForQualification(qualification, overrides)
    return qualification
  }
  return {
    authorityDb,
    authorityScope,
    material,
    qualify,
    queryDigest,
    service,
    setAuthorityForQualification,
  }
}

function envelopeFor(queryDigest, qualificationDigest) {
  return {
    exportRequestId: 's5-export-request',
    nonce: 's5-nonce',
    expiry: '2099-01-01T00:00:00.000Z',
    scenarioVersion: 's5-scenario-v1',
    bindingVersion: BINDING_VERSION,
    roleId: 's5-source',
    actionProfileVersion: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
    roleBindingFingerprint: ROLE_BINDING_FINGERPRINT,
    systemContentKey: SYSTEM_CONTENT_KEY,
    approvedConfigVersionId: APPROVED_CONFIG_VERSION_ID,
    configContentKey: CONFIG_CONTENT_KEY,
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    qualificationDigest,
    executionMode: 'S5_CERTIFICATION',
    applyProfileVersion: 'NO_APPLY',
    queryObjectFilterBindingDigest: queryDigest,
    expectedSourceSchemaFieldMapDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    tenantDomainBinding: TENANT_DOMAIN_BINDING,
    rowBudget: 1000,
    byteBudget: 4 * 1024 * 1024,
    chunkBudget: 100,
  }
}

async function expectReason(fn, reason) {
  let caught
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError, `expected ${reason}`)
  assert.equal(caught.reason, reason)
  return caught
}

async function positiveHermeticCoreEngine() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-action-'),
  )
  const stages = []
  try {
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
      onReaderActive: async () => {},
      stageObserver: async (stage) => {
        stages.push(stage)
      },
    })
    const qualification = await qualify()
    const result = await service.execute({
      envelope: envelopeFor(queryDigest, qualification.qualificationDigest),
    })
    assert.equal(result.actionId, SQLSERVER_SEALED_SNAPSHOT_ACTION_ID)
    assert.notEqual(result.actionId, SEALED_EXPORT_S2_ACTION_ID)
    assert.equal(result.evidence.runtimeReachable, false)
    assert.equal(result.evidence.customerSourceUsed, false)
    assert.equal(result.evidence.externalWrite, false)
    assert.equal(result.evidence.dataStreamReadCount, 1)
    assert.equal(result.evidence.orderingProbeReadCount, 1)
    assert.equal(result.evidence.objectKey, OBJECT_KEY)
    assert.equal(result.evidence.relationId, RELATION_ID)
    assert.equal(
      result.evidence.actionToken,
      'SEALED_EXPORT_SQLSERVER_HERMETIC_TEST_ONLY',
    )
    assert.ok(
      stages.indexOf('READER_EXHAUSTED') < stages.indexOf('ARTIFACT_FINALIZED'),
    )
    assert.ok(
      stages.indexOf('ARTIFACT_FINALIZED') < stages.indexOf('MANIFEST_FROZEN'),
    )
    assert.ok(
      stages.indexOf('MANIFEST_FROZEN') < stages.indexOf('MANIFEST_SIGNED'),
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function hermeticCoreIsNotHardcodedCertFixtureOnly() {
  // Same engine, different first-party approved binding object/table.
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-bind-'),
  )
  try {
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
      objectKey: 'inventory.skus',
      tableRef: 'dbo.inventory_skus',
    })
    const qualification = await qualify('inventory.skus')
    const result = await service.execute({
      envelope: envelopeFor(queryDigest, qualification.qualificationDigest),
    })
    assert.equal(result.evidence.objectKey, 'inventory.skus')
    assert.notEqual(result.evidence.objectKey, 'sealed_export.s5.cert_object')
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function callerInjectionStructurallyUnavailable() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-inject-'),
  )
  try {
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
    })
    const qualification = await qualify()
    const base = {
      envelope: envelopeFor(queryDigest, qualification.qualificationDigest),
    }
    for (const injection of [
      { sql: 'SELECT 1' },
      { table: 'dbo.evil' },
      { resolution: {} },
      { sourceSession: {} },
      { signerAuthority: {} },
      { signerKeyId: 'x' },
      { artifactRoot: root },
      { onReaderActive: null },
      { stageObserver: null },
      { qualificationEnvelopeKey: { keyId: 'x', secret: crypto.randomBytes(32) } },
      { connectionConfig: { server: 'evil' } },
      { privateKey: 'x' },
    ]) {
      await expectReason(
        () => service.execute({ ...base, ...injection }),
        'SEALED_EXPORT_PROFILE_UNCERTIFIED',
      )
    }
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function duplicateRoleBindingFingerprintRefusesAtConstruction() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-duplicate-role-'),
  )
  const shared = {
    approvedConfigVersionId: APPROVED_CONFIG_VERSION_ID,
    bindingVersion: BINDING_VERSION,
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    configContentKey: CONFIG_CONTENT_KEY,
    relationId: RELATION_ID,
    roleBindingFingerprint: ROLE_BINDING_FINGERPRINT,
    tenantDomainBinding: TENANT_DOMAIN_BINDING,
  }
  try {
    await expectReason(
      () =>
        buildService({
          approvedBindings: [
            {
              ...shared,
              objectKey: OBJECT_KEY,
              tableRef: TABLE_REF,
            },
            {
              ...shared,
              objectKey: 'inventory.skus',
              tableRef: 'dbo.inventory_skus',
            },
          ],
          artifactRoot: root,
        }),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function crossObjectQualificationReuseAcrossServicesRefuses() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-cross-object-'),
  )
  const authorityDb = createMemorySignerAuthorityDb()
  const material = createEd25519SignerMaterial()
  try {
    const first = await buildService({
      artifactRoot: root,
      authorityDb,
      material,
    })
    const second = await buildService({
      artifactRoot: root,
      authorityDb,
      material,
      objectKey: 'inventory.skus',
      tableRef: 'dbo.inventory_skus',
      skipPublicKeyEnrollment: true,
    })
    const firstQualification = await first.qualify()
    await expectReason(
      () =>
        second.service.execute({
          envelope: envelopeFor(
            second.queryDigest,
            firstQualification.qualificationDigest,
          ),
        }),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function missingSnapshotCapabilityRefuses() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-snap-'),
  )
  try {
    const { service } = await buildService({
      artifactRoot: root,
      snapshotCapable: false,
    })
    // Ordering qualification and capture both require a snapshot-capable session.
    await expectReason(
      () => service.probeQualificationForBinding(OBJECT_KEY),
      'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    )
    assert.equal(fs.readdirSync(root).length, 0)
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

function snapshotProofSqlAvoidsServerWideDmvPermission() {
  assert.equal(SEALED_EXPORT_S5_CHUNK_BYTES, 1024 * 1024)
  assert.equal(SEALED_EXPORT_S5_SORT_RUN_BYTES, 1024 * 1024)
  const sourceSql =
    CERTIFIED_RELATIONS[RELATION_ID].buildSourceReadSql(TABLE_REF)
  for (const sqlText of [CAPTURE_METADATA_SQL, sourceSql]) {
    assert.doesNotMatch(
      sqlText,
      /sys\.dm_tran_active_snapshot_database_transactions/i,
    )
    assert.match(sqlText, /sys\.dm_exec_sessions/i)
    assert.match(sqlText, /CURRENT_TRANSACTION_ID\(\)/i)
    assert.match(sqlText, /snapshot_isolation_state/i)
  }
}

async function snapshotIdentityAndIsolationMismatchRefuse() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-snapshot-shape-'),
  )
  try {
    for (const [rows, reason] of [
      [
        sourceRows(3, { __isolationLevel: 2 }),
        'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
      ],
      [
        sourceRows(3, { __transactionId: '9002' }),
        'SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH',
      ],
    ]) {
      const { service, queryDigest, qualify } = await buildService({
        artifactRoot: root,
        rows,
      })
      const qualification = await qualify()
      await expectReason(
        () =>
          service.execute({
            envelope: envelopeFor(
              queryDigest,
              qualification.qualificationDigest,
            ),
          }),
        reason,
      )
      assert.deepEqual(fs.readdirSync(root), [])
    }
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function sourceSessionClosesPoolOnConnectionAndCapabilityFailure() {
  const mssqlPath = require.resolve('mssql')
  const cachedMssql = require.cache[mssqlPath]

  async function runCase({ connectFails, snapshotEnabledState }, reason) {
    let closeCount = 0
    class FakeConnectionPool {
      async connect() {
        if (connectFails) throw new Error('synthetic-connect-failure')
        return this
      }

      request() {
        return {
          async query() {
            return { recordset: [{ snapshotEnabledState }] }
          },
        }
      }

      async close() {
        closeCount += 1
      }
    }
    class FakeTransaction {}
    require.cache[mssqlPath] = {
      id: mssqlPath,
      filename: mssqlPath,
      loaded: true,
      exports: {
        ConnectionPool: FakeConnectionPool,
        Transaction: FakeTransaction,
        ISOLATION_LEVEL: { SNAPSHOT: 5 },
      },
    }
    await expectReason(
      () => openMssqlSnapshotCaptureContext({}),
      reason,
    )
    assert.equal(closeCount, 1)
  }

  try {
    await runCase(
      { connectFails: true, snapshotEnabledState: 1 },
      'SEALED_EXPORT_CAPTURE_FAILED',
    )
    await runCase(
      { connectFails: false, snapshotEnabledState: 0 },
      'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    )
  } finally {
    if (cachedMssql) require.cache[mssqlPath] = cachedMssql
    else delete require.cache[mssqlPath]
  }
}

async function revokedSignerRefuses() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-signer-'),
  )
  try {
    // 069 lifecycle REVOKED is the single truth — S5 sign fails the same way
    // S4 activation would (SEALED_EXPORT_SIGNER_REVOKED), not a soft UNENROLLED.
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
      signerStatus: 'REVOKED',
    })
    const qualification = await qualify()
    await expectReason(
      () =>
        service.execute({
          envelope: envelopeFor(queryDigest, qualification.qualificationDigest),
        }),
      'SEALED_EXPORT_SIGNER_REVOKED',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function lifecycleAwareVerifyRefusesExpiredAndRevoked() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-life-'),
  )
  try {
    const {
      service,
      queryDigest,
      qualify,
      setAuthorityForQualification,
    } = await buildService({
      artifactRoot: root,
    })
    const qualification = await qualify()
    const envelope = envelopeFor(
      queryDigest,
      qualification.qualificationDigest,
    )
    const result = await service.execute({ envelope })
    const ok = await service.verifyManifestWithLifecycle({
      envelope,
      manifest: result.manifest,
    })
    assert.equal(ok.lifecycleChecked, true)
    assert.equal(ok.scopeBound, true)

    await setAuthorityForQualification(qualification, {
      signer_status: 'EXPIRED',
    })
    await expectReason(
      () =>
        service.verifyManifestWithLifecycle({
          envelope,
          manifest: result.manifest,
        }),
      'SEALED_EXPORT_SIGNER_EXPIRED',
    )

    await setAuthorityForQualification(qualification, {
      signer_status: 'ACTIVE',
      signer_expires_at: '2000-01-01T00:00:00.000Z',
    })
    await expectReason(
      () =>
        service.verifyManifestWithLifecycle({
          envelope,
          manifest: result.manifest,
        }),
      'SEALED_EXPORT_SIGNER_EXPIRED',
    )

    await setAuthorityForQualification(qualification, {
      signer_status: 'REVOKED',
      signer_expires_at: '2099-01-01T00:00:00.000Z',
    })
    await expectReason(
      () =>
        service.verifyManifestWithLifecycle({
          envelope,
          manifest: result.manifest,
        }),
      'SEALED_EXPORT_SIGNER_REVOKED',
    )

    await setAuthorityForQualification(qualification, {
      signer_status: 'ACTIVE',
    })
    await expectReason(
      () =>
        service.verifyManifestWithLifecycle({
          envelope: { ...envelope, systemContentKey: 'other-system' },
          manifest: result.manifest,
        }),
      'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function callerSuppliedKeyringCannotReplaceClosureKeyring() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-key-'),
  )
  try {
    const { service, queryDigest } = await buildService({
      artifactRoot: root,
    })
    const attackerKey = {
      keyId: 'attacker',
      secret: crypto.randomBytes(32),
    }
    // Even if caller tries to inject key material into execute, it is refused.
    await expectReason(
      () =>
        service.execute({
          envelope: envelopeFor(
            queryDigest,
            digests.digestBytes(Buffer.from('x')).digest,
          ),
          qualificationEnvelopeKey: attackerKey,
        }),
      'SEALED_EXPORT_PROFILE_UNCERTIFIED',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function duplicateRowIdFailsOrderingQualification() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-dup-'),
  )
  try {
    const rows = sourceRows(3)
    rows[2].rowId = rows[0].rowId // isolated duplicate-key mutation
    const { service } = await buildService({
      artifactRoot: root,
      rows,
    })
    await expectReason(
      () => service.probeQualificationForBinding(OBJECT_KEY),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
    // Unique positive control: unique rows succeed.
    const ok = await buildService({
      artifactRoot: root,
      rows: sourceRows(3),
    })
    const qualification = await ok.qualify()
    const result = await ok.service.execute({
      envelope: envelopeFor(ok.queryDigest, qualification.qualificationDigest),
    })
    assert.equal(result.evidence.rowCount, 3)
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function uniqueButOutOfOrderSourceReadRefuses() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-order-'),
  )
  try {
    const rows = sourceRows(3)
    ;[rows[1], rows[2]] = [rows[2], rows[1]]
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
      rows,
    })
    const qualification = await qualify()
    await expectReason(
      () =>
        service.execute({
          envelope: envelopeFor(
            queryDigest,
            qualification.qualificationDigest,
          ),
        }),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function truncatedSuccessfulSourceStreamRefusesBeforeCommitAndSigning() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-truncated-'),
  )
  try {
    const rows = sourceRows(3)
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
      rows,
      streamRows: rows.slice(0, 2),
    })
    const qualification = await qualify()
    await expectReason(
      () =>
        service.execute({
          envelope: envelopeFor(
            queryDigest,
            qualification.qualificationDigest,
          ),
        }),
      'SEALED_EXPORT_CAPTURE_INCOMPLETE',
    )
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function longPayloadIsLossless() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-long-'),
  )
  try {
    const longPayload = 'Z'.repeat(5000)
    const rows = sourceRows(1, { payload: longPayload })
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
      rows,
    })
    const qualification = await qualify()
    const result = await service.execute({
      envelope: envelopeFor(queryDigest, qualification.qualificationDigest),
    })
    assert.equal(result.evidence.rowCount, 1)
    // Artifact must contain the full payload, not a 4000-char truncation.
    const artifactText = fs.readFileSync(result.artifact.artifactPath, 'utf8')
    assert.ok(artifactText.includes(longPayload))
    assert.ok(!artifactText.includes(longPayload.slice(0, 4000) + '"') || artifactText.includes(longPayload))
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function emptyApprovedObjectRefusesBeforeSigning() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-empty-'),
  )
  try {
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
      rows: [],
    })
    const qualification = await qualify()
    await expectReason(
      () =>
        service.execute({
          envelope: envelopeFor(queryDigest, qualification.qualificationDigest),
        }),
      'SEALED_EXPORT_CAPTURE_INCOMPLETE',
    )
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function callerNowMsRefused() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-clock-'),
  )
  try {
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
    })
    const qualification = await qualify()
    await expectReason(
      () =>
        service.execute({
          envelope: envelopeFor(queryDigest, qualification.qualificationDigest),
          nowMs: 1,
        }),
      'SEALED_EXPORT_PROFILE_UNCERTIFIED',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function bindingCoordinatesAreExactAndProjectionIsValuesFree() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-binding-coordinates-'),
  )
  try {
    const { service, queryDigest, qualify } = await buildService({
      artifactRoot: root,
    })
    const qualification = await qualify()
    const envelope = envelopeFor(
      queryDigest,
      qualification.qualificationDigest,
    )
    for (const mutation of [
      { approvedConfigVersionId: 'other-config-version' },
      { bindingVersion: 'other-binding-version' },
      { roleBindingFingerprint: 'other-role-binding' },
      { tenantDomainBinding: 'other-tenant-domain' },
    ]) {
      await expectReason(
        () => service.execute({ envelope: { ...envelope, ...mutation } }),
        'SEALED_EXPORT_BINDING_UNQUALIFIED',
      )
    }
    const projection = service.getApprovedBinding(OBJECT_KEY)
    assert.equal(Object.prototype.hasOwnProperty.call(projection, 'tableRef'), false)
    assert.equal(
      Object.prototype.hasOwnProperty.call(projection, 'sourceReadSql'),
      false,
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(projection, 'orderingKeyProbeSql'),
      false,
    )
    assert.equal(projection.roleBindingFingerprint, ROLE_BINDING_FINGERPRINT)
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function liveBindingAndQualificationStateRefuseAfterConstruction() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-live-authority-'),
  )
  try {
    const fixture = await buildService({ artifactRoot: root })
    const qualification = await fixture.qualify()
    const envelope = envelopeFor(
      fixture.queryDigest,
      qualification.qualificationDigest,
    )
    for (const patch of [
      { binding_current: false },
      { qualification_current: false },
      { qualification_digest: 'b'.repeat(64) },
      {
        qualification_expires_at: new Date(
          Date.parse(qualification.expiresAt) + 60_000,
        ).toISOString(),
      },
    ]) {
      await fixture.setAuthorityForQualification(qualification, patch)
      await expectReason(
        () => fixture.service.execute({ envelope }),
        'SEALED_EXPORT_BINDING_UNQUALIFIED',
      )
      await fixture.setAuthorityForQualification(qualification)
    }
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function signerRevocationAfterArtifactFinalizeRefusesSigning() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-sign-race-'),
  )
  let fixture
  try {
    fixture = await buildService({
      artifactRoot: root,
      stageObserver: async (stage) => {
        if (stage === 'ARTIFACT_FINALIZED') {
          await fixture.authorityDb.updateRow(
            AUTHORITY_STATE_TABLE,
            {
              tenant_id: 'tenant-s5',
              workspace_id: null,
              tenant_domain_binding: TENANT_DOMAIN_BINDING,
              system_content_key: SYSTEM_CONTENT_KEY,
              role_binding_fingerprint: ROLE_BINDING_FINGERPRINT,
            },
            { signer_status: 'REVOKED' },
          )
        }
      },
    })
    const qualification = await fixture.qualify()
    await expectReason(
      () =>
        fixture.service.execute({
          envelope: envelopeFor(
            fixture.queryDigest,
            qualification.qualificationDigest,
          ),
        }),
      'SEALED_EXPORT_SIGNER_REVOKED',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function main() {
  certifiedRelationLookupRejectsPrototypeProperties()
  await positiveHermeticCoreEngine()
  await hermeticCoreIsNotHardcodedCertFixtureOnly()
  await callerInjectionStructurallyUnavailable()
  await duplicateRoleBindingFingerprintRefusesAtConstruction()
  await crossObjectQualificationReuseAcrossServicesRefuses()
  await missingSnapshotCapabilityRefuses()
  snapshotProofSqlAvoidsServerWideDmvPermission()
  await snapshotIdentityAndIsolationMismatchRefuse()
  await sourceSessionClosesPoolOnConnectionAndCapabilityFailure()
  await revokedSignerRefuses()
  await lifecycleAwareVerifyRefusesExpiredAndRevoked()
  await callerSuppliedKeyringCannotReplaceClosureKeyring()
  await duplicateRowIdFailsOrderingQualification()
  await uniqueButOutOfOrderSourceReadRefuses()
  await truncatedSuccessfulSourceStreamRefusesBeforeCommitAndSigning()
  await longPayloadIsLossless()
  await emptyApprovedObjectRefusesBeforeSigning()
  await callerNowMsRefused()
  await bindingCoordinatesAreExactAndProjectionIsValuesFree()
  await liveBindingAndQualificationStateRefuseAfterConstruction()
  await signerRevocationAfterArtifactFinalizeRefusesSigning()
  console.log('sealed-export-sqlserver-sealed-snapshot-action.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
