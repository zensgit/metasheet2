'use strict'

// First-party, evidence-only runner for sealed-export S5 product service
// sqlserver.sealed_snapshot.v1. Distinct from the S2 fixture action.
// Creates an ephemeral SQL Server database, mutates only its private
// certification relation, emits values-free evidence, and never registers a
// runtime consumer or touches a customer source.

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')

const requireFromPlugin = createRequire(
  path.join(
    __dirname,
    '../../plugins/plugin-integration-core/package.json',
  ),
)
const sql = requireFromPlugin('mssql')

const {
  SEALED_EXPORT_FAILURE_REASONS,
  SealedExportError,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/failure-vocabulary.cjs',
)
const {
  createEd25519SignerMaterial,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sealed-export-signer-authority.cjs',
)
const {
  computeQueryBindingDigest,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sqlserver-sealed-snapshot-action.cjs',
)
const {
  createSqlServerSealedSnapshotService,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sqlserver-sealed-snapshot-service.cjs',
)
const {
  AUTHORITY_STATE_TABLE,
  createSignerAuthorityStore,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sealed-export-signer-authority-store.cjs',
)
const {
  createMemorySignerAuthorityDb,
} = require(
  '../../plugins/plugin-integration-core/__tests__/support/sealed-export-signer-authority-memory-db.cjs',
)
const {
  SEALED_EXPORT_S2_ACTION_ID,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sqlserver-s2-producer.cjs',
)
const {
  verifySealedExportPackageProvenance,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs',
)

const DATABASE = 'metasheet_sealed_export_s5_evidence'
const READONLY_USERNAME = 'sealed_export_s5_reader'
const READONLY_PASSWORD = 'Sealed!ReadOnly2026'
// CI relation table is enrolled through the first-party approved-binding
// authority — not hard-coded inside the product execute path.
const CERT_TABLE = 'dbo.sealed_export_s5_evidence_relation'
const OBJECT_KEY = 's5.evidence.relation'
const RELATION_ID = 'sqlserver.relation.rowid_payload.v1'
const FIXTURE_ROW_COUNT = 1000
const PAYLOAD_WIDTH = 3000
const SYSTEM_CONTENT_KEY = 's5-real-system-content'
const CONFIG_CONTENT_KEY = 's5-real-config-content'
const CANONICAL_OBJECT_VERSION = 's5-real-object-v1'
const APPROVED_CONFIG_VERSION_ID = 's5-real-config-v1'
const BINDING_VERSION = 's5-real-binding-v1'
const ROLE_BINDING_FINGERPRINT = 's5-real-role-binding'
const TENANT_DOMAIN_BINDING = 's5-real-tenant-domain'
const TENANT_ID = 's5-real-tenant'
const RUNNER_REASONS = Object.freeze([
  'SEALED_EXPORT_S5_ENVIRONMENT_INVALID',
  'SEALED_EXPORT_S5_FIXTURE_FAILED',
  'SEALED_EXPORT_S5_EVIDENCE_INVALID',
])
const SAFE_REASONS = new Set([
  ...SEALED_EXPORT_FAILURE_REASONS,
  ...RUNNER_REASONS,
])

function fail(reason) {
  throw new Error(reason)
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    fail('SEALED_EXPORT_S5_ENVIRONMENT_INVALID')
  }
  return value
}

function positivePort(rawValue) {
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    fail('SEALED_EXPORT_S5_ENVIRONMENT_INVALID')
  }
  return value
}

function booleanEnvironment(name) {
  const value = requiredEnvironment(name)
  if (value === 'true') return true
  if (value === 'false') return false
  fail('SEALED_EXPORT_S5_ENVIRONMENT_INVALID')
}

function connectionConfig(
  database,
  {
    user = requiredEnvironment('MSSQL_USERNAME'),
    password = requiredEnvironment('MSSQL_PASSWORD'),
  } = {},
) {
  return {
    server: requiredEnvironment('MSSQL_HOST'),
    port: positivePort(requiredEnvironment('MSSQL_PORT')),
    user,
    password,
    database,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    pool: {
      min: 0,
      max: 1,
      idleTimeoutMillis: 5_000,
    },
    options: {
      encrypt: booleanEnvironment('MSSQL_ENCRYPT'),
      trustServerCertificate: booleanEnvironment(
        'MSSQL_TRUST_SERVER_CERTIFICATE',
      ),
      enableArithAbort: true,
    },
  }
}

async function dropReadonlyLogin(masterPool) {
  await masterPool.request().batch(`
IF SUSER_ID(N'${READONLY_USERNAME}') IS NOT NULL
BEGIN
  DROP LOGIN [${READONLY_USERNAME}];
END
`)
}

async function dropDatabase(masterPool) {
  await masterPool.request().batch(`
IF DB_ID(N'${DATABASE}') IS NOT NULL
BEGIN
  ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE [${DATABASE}];
END
`)
}

async function waitForSnapshotState(masterPool, expectedState) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await masterPool.request().query(`
SELECT snapshot_isolation_state AS snapshotIsolationState
FROM sys.databases
WHERE name = N'${DATABASE}'
`)
    const state = Number(result.recordset?.[0]?.snapshotIsolationState)
    if (state === expectedState) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  fail('SEALED_EXPORT_S5_FIXTURE_FAILED')
}

async function prepareRelation(masterPool) {
  await dropDatabase(masterPool)
  await dropReadonlyLogin(masterPool)
  await masterPool.request().batch(`CREATE DATABASE [${DATABASE}];`)
  await masterPool
    .request()
    .batch(`ALTER DATABASE [${DATABASE}] SET ALLOW_SNAPSHOT_ISOLATION ON;`)
  await waitForSnapshotState(masterPool, 1)

  const fixturePool = await new sql.ConnectionPool(
    connectionConfig(DATABASE),
  ).connect()
  try {
    await masterPool.request().batch(`
CREATE LOGIN [${READONLY_USERNAME}]
WITH PASSWORD = N'${READONLY_PASSWORD}', CHECK_POLICY = OFF;
`)
    await fixturePool.request().batch(`
CREATE TABLE ${CERT_TABLE} (
  row_id int NOT NULL PRIMARY KEY,
  payload_version int NOT NULL,
  payload nvarchar(4000) NOT NULL
);
WITH fixture_rows AS (
  SELECT 1 AS row_id
  UNION ALL
  SELECT row_id + 1
  FROM fixture_rows
  WHERE row_id < ${FIXTURE_ROW_COUNT}
)
INSERT INTO ${CERT_TABLE}
  (row_id, payload_version, payload)
SELECT
  row_id,
  1,
  CONCAT(N's5-evidence-', row_id, N'-', REPLICATE(N'x', ${PAYLOAD_WIDTH}))
FROM fixture_rows
OPTION (MAXRECURSION 0);

CREATE USER [${READONLY_USERNAME}] FOR LOGIN [${READONLY_USERNAME}];
GRANT SELECT ON OBJECT::${CERT_TABLE} TO [${READONLY_USERNAME}];
`)
  } finally {
    await fixturePool.close()
  }
}

async function assertReadonlyPrincipal() {
  const pool = await new sql.ConnectionPool(
    connectionConfig(DATABASE, {
      user: READONLY_USERNAME,
      password: READONLY_PASSWORD,
    }),
  ).connect()
  try {
    const result = await pool.request().query(`
SELECT
  CAST(IS_SRVROLEMEMBER('sysadmin') AS int) AS isSysadmin,
  CAST(HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS int)
    AS hasViewServerState,
  CAST(HAS_PERMS_BY_NAME(N'${CERT_TABLE}', 'OBJECT', 'SELECT') AS int)
    AS canSelect,
  CAST(HAS_PERMS_BY_NAME(N'${CERT_TABLE}', 'OBJECT', 'INSERT') AS int)
    AS canInsert,
  CAST(HAS_PERMS_BY_NAME(N'${CERT_TABLE}', 'OBJECT', 'UPDATE') AS int)
    AS canUpdate,
  CAST(HAS_PERMS_BY_NAME(N'${CERT_TABLE}', 'OBJECT', 'DELETE') AS int)
    AS canDelete;
`)
    const row = result.recordset?.[0]
    if (
      Number(row?.isSysadmin) !== 0 ||
      Number(row?.hasViewServerState) !== 0 ||
      Number(row?.canSelect) !== 1 ||
      Number(row?.canInsert) !== 0 ||
      Number(row?.canUpdate) !== 0 ||
      Number(row?.canDelete) !== 0
    ) {
      fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
    }
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      SAFE_REASONS.has(error.message)
    ) {
      throw error
    }
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  } finally {
    await pool.close()
  }
}

async function buildService({
  artifactRoot,
  onReaderActive = null,
  stageObserver = null,
}) {
  const material = createEd25519SignerMaterial()
  const authorityDb = createMemorySignerAuthorityDb()
  const authorityStore = createSignerAuthorityStore({ db: authorityDb })
  const authorityScope = {
    roleBindingFingerprint: ROLE_BINDING_FINGERPRINT,
    systemContentKey: SYSTEM_CONTENT_KEY,
    tenantDomainBinding: TENANT_DOMAIN_BINDING,
    tenantId: TENANT_ID,
    workspaceId: null,
  }
  await authorityStore.enrollPublicKey(authorityScope, {
    publicKey: material.publicKey,
    signerKeyId: material.signerKeyId,
  })
  const queryDigest = computeQueryBindingDigest({
    objectKey: OBJECT_KEY,
    relationId: RELATION_ID,
    tableRef: CERT_TABLE,
  })
  const service = createSqlServerSealedSnapshotService({
    tenantId: TENANT_ID,
    workspaceId: null,
    systemContentKey: SYSTEM_CONTENT_KEY,
    artifactRoot,
    connectionConfig: connectionConfig(DATABASE, {
      user: READONLY_USERNAME,
      password: READONLY_PASSWORD,
    }),
    onReaderActive,
    stageObserver,
    qualificationKeyring: {
      keyId: 's5-real-envelope-key',
      secret: crypto.randomBytes(32),
    },
    approvedBindings: [
      {
        objectKey: OBJECT_KEY,
        relationId: RELATION_ID,
        tableRef: CERT_TABLE,
        approvedConfigVersionId: APPROVED_CONFIG_VERSION_ID,
        bindingVersion: BINDING_VERSION,
        configContentKey: CONFIG_CONTENT_KEY,
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        roleBindingFingerprint: ROLE_BINDING_FINGERPRINT,
        tenantDomainBinding: TENANT_DOMAIN_BINDING,
      },
    ],
    authorityDb,
    privateSignerMaterials: [
      { privateKey: material.privateKey, signerKeyId: material.signerKeyId },
    ],
  })
  async function activateQualification(qualification) {
    service.verifyQualificationForBinding(
      qualification.objectKey,
      qualification,
    )
    await authorityDb.insertOne(AUTHORITY_STATE_TABLE, {
      tenant_id: TENANT_ID,
      workspace_id: null,
      tenant_domain_binding: TENANT_DOMAIN_BINDING,
      system_content_key: SYSTEM_CONTENT_KEY,
      role_binding_fingerprint: ROLE_BINDING_FINGERPRINT,
      signer_key_id: material.signerKeyId,
      signer_status: 'ACTIVE',
      signer_expires_at: '2099-01-01T00:00:00.000Z',
      binding_current: true,
      binding_expires_at: '2099-01-01T00:00:00.000Z',
      qualification_digest: qualification.qualificationDigest,
      qualification_current: true,
      qualification_expires_at: qualification.expiresAt,
    })
  }
  return { activateQualification, queryDigest, service }
}

function exportEnvelope(queryDigest, qualificationDigest) {
  return {
    exportRequestId: 's5-real-export-request',
    nonce: 's5-real-nonce',
    expiry: '2099-01-01T00:00:00.000Z',
    scenarioVersion: 's5-real-scenario-v1',
    bindingVersion: BINDING_VERSION,
    roleId: 's5-real-source',
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

async function assertCompleteSnapshotState(output, controlPool) {
  let rows
  try {
    const text = await fsPromises.readFile(output.artifact.artifactPath, 'utf8')
    const lines = text.endsWith('\n')
      ? text.slice(0, -1).split('\n')
      : text.split('\n')
    rows = lines.map((line) => JSON.parse(line))
  } catch {
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  }
  if (rows.length !== FIXTURE_ROW_COUNT) {
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  }
  for (let index = 0; index < rows.length; index += 1) {
    const expectedRowId = index + 1
    const row = rows[index]
    if (
      row === null ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !== 'payload,payloadVersion,rowId' ||
      row.rowId !== expectedRowId ||
      row.payloadVersion !== 1 ||
      row.payload !==
        `s5-evidence-${expectedRowId}-${'x'.repeat(PAYLOAD_WIDTH)}`
    ) {
      fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
    }
  }

  let current
  try {
    current = await controlPool.request().query(`
SELECT
  CAST(SUM(CASE
    WHEN payload_version = 2
      AND payload = CONCAT(N's5-updated-', row_id, N'-', REPLICATE(N'y', ${PAYLOAD_WIDTH}))
    THEN 1 ELSE 0 END) AS int) AS updatedRows,
  CAST(COUNT_BIG(*) AS int) AS totalRows
FROM ${CERT_TABLE};
`)
  } catch {
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  }
  const currentRow = current.recordset?.[0]
  if (
    Number(currentRow?.updatedRows) !== FIXTURE_ROW_COUNT ||
    Number(currentRow?.totalRows) !== FIXTURE_ROW_COUNT
  ) {
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  }
  return true
}

async function runSuccessfulCapture() {
  const artifactRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-real-'),
  )
  const controlPool = await new sql.ConnectionPool(
    connectionConfig(DATABASE),
  ).connect()
  const stages = []
  let mutationCount = 0
  let output = null

  try {
    const leastPrivilegeReadPrincipal = await assertReadonlyPrincipal()
    const stack = await buildService({
      artifactRoot,
      onReaderActive: async () => {
        mutationCount += 1
        await controlPool.request().batch(`
UPDATE ${CERT_TABLE}
SET
  payload_version = 2,
  payload = CONCAT(N's5-updated-', row_id, N'-', REPLICATE(N'y', ${PAYLOAD_WIDTH}));
`)
      },
      stageObserver: async (stage) => stages.push(stage),
    })
    const qualification = await stack.service.probeQualificationForBinding(
      OBJECT_KEY,
    )
    await stack.activateQualification(qualification)
    output = await stack.service.execute({
      envelope: exportEnvelope(
        stack.queryDigest,
        qualification.qualificationDigest,
      ),
    })
    const completeSnapshotStateObserved = await assertCompleteSnapshotState(
      output,
      controlPool,
    )

    if (
      mutationCount !== 1 ||
      output.actionId !== SQLSERVER_SEALED_SNAPSHOT_ACTION_ID ||
      output.actionId === SEALED_EXPORT_S2_ACTION_ID ||
      output.evidence.dataStreamReadCount !== 1 ||
      output.evidence.orderingProbeReadCount !== 1 ||
      output.evidence.rowCount !== FIXTURE_ROW_COUNT ||
      output.evidence.chunkCount < 3 ||
      output.evidence.proofClassToken !== 'SOURCE_SNAPSHOT_TXN' ||
      output.evidence.signatureVerified !== true ||
      output.evidence.readerExhausted !== true ||
      output.evidence.artifactFinalized !== true ||
      output.evidence.manifestFrozen !== true ||
      output.evidence.runtimeReachable !== false ||
      output.evidence.customerSourceUsed !== false ||
      output.evidence.externalWrite !== false ||
      output.evidence.actionToken !== 'SEALED_EXPORT_SQLSERVER_PRODUCT' ||
      output.evidence.profileId !== SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID ||
      output.evidence.implementationVersion !==
        SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION ||
      output.evidence.objectKey !== OBJECT_KEY ||
      output.evidence.relationId !== RELATION_ID ||
      output.evidence.immutableSnapshotTokenPresent !== true
    ) {
      fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
    }
    if (
      JSON.stringify(stages) !==
      JSON.stringify([
        'READER_EXHAUSTED',
        'SOURCE_COMMITTED',
        'ARTIFACT_FINALIZED',
        'MANIFEST_FROZEN',
        'MANIFEST_SIGNED',
      ])
    ) {
      fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
    }
    return Object.freeze({
      chunkCount: output.evidence.chunkCount,
      completeSnapshotStateObserved,
      concurrentMutationAffectedAllRows: true,
      engineMajorVersion: output.evidence.engineMajorVersion,
      leastPrivilegeReadPrincipal,
      rowCount: output.evidence.rowCount,
    })
  } finally {
    await controlPool.close()
    if (output !== null) {
      await fsPromises.rm(output.artifact.directory, {
        force: true,
        recursive: true,
      })
    }
    await fsPromises.rm(artifactRoot, { force: true, recursive: true })
  }
}

async function disableSnapshot(masterPool) {
  await masterPool
    .request()
    .batch(`ALTER DATABASE [${DATABASE}] SET ALLOW_SNAPSHOT_ISOLATION OFF;`)
  await waitForSnapshotState(masterPool, 0)
}

async function runDisabledSnapshotControl() {
  const artifactRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-negative-'),
  )
  let caught = null
  try {
    const stack = await buildService({ artifactRoot })
    const qualification = await stack.service.probeQualificationForBinding(
      OBJECT_KEY,
    )
    await stack.activateQualification(qualification)
    await stack.service.execute({
      envelope: exportEnvelope(
        stack.queryDigest,
        qualification.qualificationDigest,
      ),
    })
  } catch (error) {
    caught = error
  } finally {
    const entries = await fsPromises.readdir(artifactRoot)
    await fsPromises.rm(artifactRoot, { force: true, recursive: true })
    if (entries.length !== 0) {
      fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
    }
  }
  if (
    !(caught instanceof SealedExportError) ||
    caught.reason !== 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE'
  ) {
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  }
}

function writeEvidence(success, declaredMajorVersion, packageResult) {
  if (success.engineMajorVersion !== declaredMajorVersion) {
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  }
  const evidenceRoot = requiredEnvironment('S5_EVIDENCE_DIR')
  const evidenceDir = path.join(evidenceRoot, 'product-action')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const evidence = {
    evidenceSchemaVersion: 1,
    outcome: 'SEALED_EXPORT_S5_PRODUCT_ACTION_CERTIFIED',
    engineMajorVersion: declaredMajorVersion,
    profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
    actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
    implementationVersion: SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
    distinctFromS2FixtureAction: true,
    s2FixtureActionId: SEALED_EXPORT_S2_ACTION_ID,
    namedProductActionAllowlisted: true,
    approvedBindingResolved: true,
    dataStreamReadCount: 1,
    orderingProbeReadCount: 1,
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    immutableSnapshotTokenPresent: true,
    concurrentFixtureMutationApplied:
      success.concurrentMutationAffectedAllRows === true,
    concurrentMutationAffectedAllRows:
      success.concurrentMutationAffectedAllRows === true,
    completeSnapshotStateObserved:
      success.completeSnapshotStateObserved === true,
    leastPrivilegeReadPrincipal:
      success.leastPrivilegeReadPrincipal === true,
    snapshotDisabledRefused: true,
    snapshotDisabledReason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    rowCount: success.rowCount,
    chunkCount: success.chunkCount,
    atLeastThreeChunks: success.chunkCount >= 3,
    productionDerivedManifest: true,
    readerExhaustedBeforeSigning: true,
    artifactFinalizedBeforeSigning: true,
    manifestFrozenBeforeSigning: true,
    signatureVerified: true,
    privateArtifactCleaned: true,
    candidatePackageProvenanceVerified:
      packageResult.candidateTreeVerified === true,
    externalPackagePinRequired:
      packageResult.externalPackagePinRequired === true,
    provenanceManifestDigest: packageResult.frozenManifestDigest,
    runtimeReachable: false,
    customerSourceUsed: false,
    externalWrite: false,
  }
  const file = path.join(
    evidenceDir,
    `sealed-export-s5-product-${declaredMajorVersion}.json`,
  )
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
}

async function main() {
  const declaredMajorVersion = requiredEnvironment(
    'S5_MSSQL_DECLARED_MAJOR_VERSION',
  )
  if (declaredMajorVersion !== '2019' && declaredMajorVersion !== '2022') {
    fail('SEALED_EXPORT_S5_ENVIRONMENT_INVALID')
  }

  const repoRoot = path.resolve(__dirname, '../..')
  const packageResult = verifySealedExportPackageProvenance({ repoRoot })
  if (packageResult.verified !== true) {
    fail('SEALED_EXPORT_S5_EVIDENCE_INVALID')
  }

  const masterPool = await new sql.ConnectionPool(
    connectionConfig('master'),
  ).connect()
  try {
    await prepareRelation(masterPool)
    const success = await runSuccessfulCapture()
    await disableSnapshot(masterPool)
    await runDisabledSnapshotControl()
    writeEvidence(success, declaredMajorVersion, packageResult)
    console.log(
      JSON.stringify({
        ok: true,
        engineMajorVersion: declaredMajorVersion,
        actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
        profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
        runtimeReachable: false,
        customerSourceUsed: false,
        externalWrite: false,
      }),
    )
  } finally {
    try {
      await dropDatabase(masterPool)
    } catch {
      // best-effort
    }
    try {
      await dropReadonlyLogin(masterPool)
    } catch {
      // best-effort
    }
    await masterPool.close()
  }
}

main().catch((error) => {
  const reason =
    error instanceof SealedExportError
      ? error.reason
      : typeof error?.message === 'string' && SAFE_REASONS.has(error.message)
        ? error.message
        : 'SEALED_EXPORT_S5_EVIDENCE_INVALID'
  console.error(reason)
  process.exitCode = 1
})
