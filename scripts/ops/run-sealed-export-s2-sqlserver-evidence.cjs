'use strict'

// First-party, evidence-only runner for sealed-export S2 producer feasibility.
// It creates an ephemeral SQL Server database, mutates only its private fixture,
// emits values-free evidence, and never registers a runtime action or touches a
// customer source.

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

const canonicalCodec = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/canonical-json.cjs',
)
const digests = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/digests.cjs',
)
const {
  SEALED_EXPORT_FAILURE_REASONS,
  SealedExportError,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/failure-vocabulary.cjs',
)
const {
  SEALED_EXPORT_S2_ACTION_ID,
  SEALED_EXPORT_S2_FIXTURE_TABLE,
  SEALED_EXPORT_S2_QUERY_BINDING_DIGEST,
  SEALED_EXPORT_S2_SOURCE_SCHEMA_DIGEST,
  createSqlServerS2FixtureSignerIdentity,
  executeSqlServerS2Producer,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sqlserver-s2-producer.cjs',
)

const DATABASE = 'metasheet_sealed_export_s2_evidence'
const FIXTURE_ROW_COUNT = 600
const PAYLOAD_WIDTH = 200
const SYSTEM_CONTENT_KEY = 's2-real-system-content'
const RUNNER_REASONS = Object.freeze([
  'SEALED_EXPORT_S2_ENVIRONMENT_INVALID',
  'SEALED_EXPORT_S2_FIXTURE_FAILED',
  'SEALED_EXPORT_S2_EVIDENCE_INVALID',
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
    fail('SEALED_EXPORT_S2_ENVIRONMENT_INVALID')
  }
  return value
}

function positivePort(rawValue) {
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    fail('SEALED_EXPORT_S2_ENVIRONMENT_INVALID')
  }
  return value
}

function booleanEnvironment(name) {
  const value = requiredEnvironment(name)
  if (value === 'true') return true
  if (value === 'false') return false
  fail('SEALED_EXPORT_S2_ENVIRONMENT_INVALID')
}

function connectionConfig(database) {
  return {
    server: requiredEnvironment('MSSQL_HOST'),
    port: positivePort(requiredEnvironment('MSSQL_PORT')),
    user: requiredEnvironment('MSSQL_USERNAME'),
    password: requiredEnvironment('MSSQL_PASSWORD'),
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

function D(label) {
  const digest = digests.digestBytes(Buffer.from(label, 'utf8'))
  if (!digest.ok) fail('SEALED_EXPORT_S2_EVIDENCE_INVALID')
  return digest.digest
}

function exportEnvelope(suffix) {
  return {
    exportRequestId: `s2-real-export-${suffix}`,
    nonce: `s2-real-nonce-${suffix}`,
    expiry: '2099-01-01T00:00:00.000Z',
    scenarioVersion: 's2-real-fixture-v1',
    bindingVersion: 's2-real-binding-v1',
    roleId: 's2-real-source',
    actionProfileVersion: 's2-real-action-v1',
    roleBindingFingerprint: 's2-real-role-binding',
    systemContentKey: SYSTEM_CONTENT_KEY,
    approvedConfigVersionId: 's2-real-config-v1',
    configContentKey: 's2-real-config-content',
    canonicalObjectVersion: 's2-real-object-v1',
    qualificationDigest: D(`s2-real-qualification-${suffix}`),
    executionMode: 'S2_FEASIBILITY',
    applyProfileVersion: 'NO_APPLY',
    queryObjectFilterBindingDigest:
      SEALED_EXPORT_S2_QUERY_BINDING_DIGEST,
    expectedSourceSchemaFieldMapDigest:
      SEALED_EXPORT_S2_SOURCE_SCHEMA_DIGEST,
    tenantDomainBinding: 's2-real-tenant-domain',
    rowBudget: 1000,
    byteBudget: 4 * 1024 * 1024,
    chunkBudget: 100,
  }
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
  fail('SEALED_EXPORT_S2_FIXTURE_FAILED')
}

async function prepareFixture(masterPool) {
  await dropDatabase(masterPool)
  await masterPool.request().batch(`CREATE DATABASE [${DATABASE}];`)
  await masterPool
    .request()
    .batch(`ALTER DATABASE [${DATABASE}] SET ALLOW_SNAPSHOT_ISOLATION ON;`)
  await waitForSnapshotState(masterPool, 1)

  const fixturePool = await new sql.ConnectionPool(
    connectionConfig(DATABASE),
  ).connect()
  try {
    await fixturePool.request().batch(`
CREATE TABLE ${SEALED_EXPORT_S2_FIXTURE_TABLE} (
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
INSERT INTO ${SEALED_EXPORT_S2_FIXTURE_TABLE}
  (row_id, payload_version, payload)
SELECT
  row_id,
  1,
  CONCAT(N'fixture-', row_id, N'-', REPLICATE(N'x', ${PAYLOAD_WIDTH}))
FROM fixture_rows
OPTION (MAXRECURSION 0);
`)
  } finally {
    await fixturePool.close()
  }
}

function fixtureRows(version) {
  return Array.from({ length: FIXTURE_ROW_COUNT }, (_, index) => {
    const rowId = index + 1
    const prefix = version === 1 ? 'fixture' : 'updated'
    const fill = version === 1 ? 'x' : 'y'
    return {
      rowId,
      payloadVersion: version,
      payload: `${prefix}-${rowId}-${fill.repeat(PAYLOAD_WIDTH)}`,
    }
  })
}

function rowsetDigest(rows) {
  const digest = digests.computeCanonicalRowsetMultiplicityDigest(
    rows,
    canonicalCodec,
  )
  if (!digest.ok) fail('SEALED_EXPORT_S2_EVIDENCE_INVALID')
  return digest.digest
}

async function runSuccessfulCapture(signerIdentity) {
  const artifactRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s2-real-'),
  )
  const controlPool = await new sql.ConnectionPool(
    connectionConfig(DATABASE),
  ).connect()
  const requestEnvelope = exportEnvelope('success')
  const stages = []
  let mutationCount = 0
  let output = null

  try {
    output = await executeSqlServerS2Producer({
      actionId: SEALED_EXPORT_S2_ACTION_ID,
      artifactRoot,
      connectionConfig: connectionConfig(DATABASE),
      envelope: requestEnvelope,
      onReaderActive: async () => {
        mutationCount += 1
        await controlPool.request().batch(`
UPDATE ${SEALED_EXPORT_S2_FIXTURE_TABLE}
SET
  payload_version = 2,
  payload = CONCAT(N'updated-', row_id, N'-', REPLICATE(N'y', ${PAYLOAD_WIDTH}));
`)
      },
      signerIdentity,
      stageObserver: async (stage) => stages.push(stage),
    })

    const beforeDigest = rowsetDigest(fixtureRows(1))
    const afterDigest = rowsetDigest(fixtureRows(2))
    if (
      mutationCount !== 1 ||
      output.manifest.canonicalRowsetMultiplicityDigest !== beforeDigest ||
      output.manifest.canonicalRowsetMultiplicityDigest === afterDigest ||
      output.evidence.sourceReadCount !== 1 ||
      output.evidence.rowCount !== FIXTURE_ROW_COUNT ||
      output.evidence.chunkCount < 3 ||
      output.evidence.proofClassToken !== 'SOURCE_SNAPSHOT_TXN' ||
      output.evidence.signatureVerified !== true ||
      output.evidence.readerExhausted !== true ||
      output.evidence.artifactFinalized !== true ||
      output.evidence.manifestFrozen !== true ||
      output.evidence.runtimeReachable !== false ||
      output.evidence.customerSourceUsed !== false ||
      output.evidence.externalWrite !== false
    ) {
      fail('SEALED_EXPORT_S2_EVIDENCE_INVALID')
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
      fail('SEALED_EXPORT_S2_EVIDENCE_INVALID')
    }
    return Object.freeze({
      chunkCount: output.evidence.chunkCount,
      engineMajorVersion: output.evidence.engineMajorVersion,
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

async function runDisabledSnapshotControl(signerIdentity) {
  const artifactRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s2-negative-'),
  )
  const requestEnvelope = exportEnvelope('snapshot-disabled')
  let caught = null
  try {
    await executeSqlServerS2Producer({
      actionId: SEALED_EXPORT_S2_ACTION_ID,
      artifactRoot,
      connectionConfig: connectionConfig(DATABASE),
      envelope: requestEnvelope,
      onReaderActive: null,
      signerIdentity,
      stageObserver: null,
    })
  } catch (error) {
    caught = error
  } finally {
    const entries = await fsPromises.readdir(artifactRoot)
    await fsPromises.rm(artifactRoot, { force: true, recursive: true })
    if (entries.length !== 0) {
      fail('SEALED_EXPORT_S2_EVIDENCE_INVALID')
    }
  }
  if (
    !(caught instanceof SealedExportError) ||
    caught.reason !== 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE'
  ) {
    fail('SEALED_EXPORT_S2_EVIDENCE_INVALID')
  }
}

function writeEvidence(success, declaredMajorVersion) {
  if (success.engineMajorVersion !== declaredMajorVersion) {
    fail('SEALED_EXPORT_S2_EVIDENCE_INVALID')
  }
  const evidenceRoot = requiredEnvironment('S2_EVIDENCE_DIR')
  const evidenceDir = path.join(evidenceRoot, 'producer')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const evidence = {
    evidenceSchemaVersion: 1,
    outcome: 'SEALED_EXPORT_S2_PRODUCER_FEASIBILITY_PROVEN',
    engineMajorVersion: declaredMajorVersion,
    namedActionAllowlisted: true,
    sourceReadCount: 1,
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    concurrentFixtureMutationApplied: true,
    completeSnapshotStateObserved: true,
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
    runtimeReachable: false,
    customerSourceUsed: false,
    externalWrite: false,
  }
  const file = path.join(
    evidenceDir,
    `sealed-export-s2-producer-${declaredMajorVersion}.json`,
  )
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
}

async function main() {
  const declaredMajorVersion = requiredEnvironment(
    'S2_MSSQL_DECLARED_MAJOR_VERSION',
  )
  if (declaredMajorVersion !== '2019' && declaredMajorVersion !== '2022') {
    fail('SEALED_EXPORT_S2_ENVIRONMENT_INVALID')
  }

  const masterPool = await new sql.ConnectionPool(
    connectionConfig('master'),
  ).connect()
  const keyPair = crypto.generateKeyPairSync('ed25519')
  const signerIdentity = createSqlServerS2FixtureSignerIdentity({
    signerState: 'ACTIVE',
    signingKey: keyPair.privateKey,
    systemContentKey: SYSTEM_CONTENT_KEY,
  })
  try {
    await prepareFixture(masterPool)
    const success = await runSuccessfulCapture(signerIdentity)
    await disableSnapshot(masterPool)
    await runDisabledSnapshotControl(signerIdentity)
    writeEvidence(success, declaredMajorVersion)
    console.log(
      `SEALED_EXPORT_S2_PRODUCER_FEASIBILITY_PROVEN engine=${declaredMajorVersion}`,
    )
  } finally {
    try {
      await dropDatabase(masterPool)
    } finally {
      await masterPool.close()
    }
  }
}

function safeFailureReason(error) {
  if (
    error === null ||
    (typeof error !== 'object' && typeof error !== 'function')
  ) {
    return 'SEALED_EXPORT_S2_EVIDENCE_INVALID'
  }
  let descriptors
  try {
    descriptors = Object.getOwnPropertyDescriptors(error)
  } catch {
    return 'SEALED_EXPORT_S2_EVIDENCE_INVALID'
  }
  for (const key of ['reason', 'message']) {
    const descriptor = descriptors[key]
    if (
      descriptor &&
      'value' in descriptor &&
      typeof descriptor.value === 'string' &&
      SAFE_REASONS.has(descriptor.value)
    ) {
      return descriptor.value
    }
  }
  return 'SEALED_EXPORT_S2_EVIDENCE_INVALID'
}

main().catch((error) => {
  console.error(
    `SEALED_EXPORT_S2_PRODUCER_FEASIBILITY_REFUSED reason=${safeFailureReason(
      error,
    )}`,
  )
  process.exitCode = 1
})
