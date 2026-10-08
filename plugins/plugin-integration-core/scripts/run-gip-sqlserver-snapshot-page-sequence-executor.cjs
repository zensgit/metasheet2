'use strict'

// First-party CI evidence runner for the latent B1c executor. This creates only
// an ephemeral fixture database and never accepts SQL, object, ordering, page,
// transaction, or retry input from the caller.

const fs = require('node:fs')
const path = require('node:path')
const sql = require('mssql')
const {
  SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS,
  SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE,
  executeSqlServerSnapshotPageSequence,
} = require('../lib/gip-sqlserver-snapshot-page-sequence-executor.cjs')

const DATABASE = 'metasheet_gip_b1c_executor_evidence'
const TABLE = SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE
const RUNNER_ERROR_REASONS = Object.freeze([
  'B1C_EXECUTOR_ENVIRONMENT_INVALID',
  'B1C_EXECUTOR_SNAPSHOT_ENABLE_FAILED',
  'B1C_EXECUTOR_EVIDENCE_INVALID',
])
const SAFE_ERROR_REASONS = new Set([
  ...SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS,
  ...RUNNER_ERROR_REASONS,
])

function requiredEnvironment(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('B1C_EXECUTOR_ENVIRONMENT_INVALID')
  }
  return value
}

function positivePort(rawValue) {
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error('B1C_EXECUTOR_ENVIRONMENT_INVALID')
  }
  return value
}

function booleanEnvironment(name) {
  const value = requiredEnvironment(name)
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('B1C_EXECUTOR_ENVIRONMENT_INVALID')
}

function baseConnectionConfig(database) {
  return {
    server: requiredEnvironment('MSSQL_HOST'),
    port: positivePort(requiredEnvironment('MSSQL_PORT')),
    user: requiredEnvironment('MSSQL_USERNAME'),
    password: requiredEnvironment('MSSQL_PASSWORD'),
    database,
    connectionTimeout: 10_000,
    requestTimeout: 20_000,
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

async function dropDatabase(masterPool) {
  await masterPool.request().batch(`
IF DB_ID(N'${DATABASE}') IS NOT NULL
BEGIN
  ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE [${DATABASE}];
END
`)
}

async function waitForSnapshotEnabled(masterPool) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await masterPool.request().query(`
SELECT snapshot_isolation_state AS snapshotIsolationState
FROM sys.databases
WHERE name = N'${DATABASE}'
`)
    if (
      Array.isArray(result.recordset) &&
      Number(result.recordset[0]?.snapshotIsolationState) === 1
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('B1C_EXECUTOR_SNAPSHOT_ENABLE_FAILED')
}

async function prepareFixture(masterPool) {
  await dropDatabase(masterPool)
  await masterPool.request().batch(`CREATE DATABASE [${DATABASE}];`)
  await masterPool
    .request()
    .batch(`ALTER DATABASE [${DATABASE}] SET ALLOW_SNAPSHOT_ISOLATION ON;`)
  await waitForSnapshotEnabled(masterPool)

  const fixturePool = await new sql.ConnectionPool(
    baseConnectionConfig(DATABASE),
  ).connect()
  try {
    await fixturePool.request().batch(`
CREATE TABLE ${TABLE} (
  row_id int NOT NULL PRIMARY KEY,
  sort_key int NOT NULL UNIQUE,
  payload nvarchar(40) NOT NULL
);
INSERT INTO ${TABLE} (row_id, sort_key, payload)
VALUES
  (1, 10, N'fixture-1'),
  (2, 20, N'fixture-2'),
  (3, 30, N'fixture-3'),
  (4, 40, N'fixture-4'),
  (5, 50, N'fixture-5'),
  (6, 60, N'fixture-6'),
  (7, 70, N'fixture-7'),
  (8, 80, N'fixture-8');
`)
  } finally {
    await fixturePool.close()
  }
}

function assertExecutorEvidence(output, declaredMajorVersion) {
  if (
    typeof output !== 'object' ||
    output === null ||
    !Array.isArray(output.rows) ||
    output.rows.length !== 8 ||
    output.evidence?.profileId !== 'sqlserver.snapshot_paged_read.v1' ||
    output.evidence?.engineMajorVersion !== declaredMajorVersion ||
    output.evidence?.contextState !== 'COMPLETED' ||
    output.evidence?.pageSize !== 3 ||
    output.evidence?.pageCount !== 3 ||
    output.evidence?.totalRowCount !== 8 ||
    output.evidence?.sameSessionAcrossPages !== true ||
    output.evidence?.snapshotTransactionObserved !== true ||
    output.evidence?.completeness?.runOutcome !== 'successful' ||
    output.evidence?.completeness?.usedCompletenessProofs?.length !== 1 ||
    output.evidence.completeness.usedCompletenessProofs[0] !== 'SHORT_PAGE'
  ) {
    throw new Error('B1C_EXECUTOR_EVIDENCE_INVALID')
  }
}

function writeEvidence(output, declaredMajorVersion) {
  const evidenceRoot = requiredEnvironment('B1C_EVIDENCE_DIR')
  const evidenceDir = path.join(evidenceRoot, 'executor')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const evidence = {
    evidenceSchemaVersion: 1,
    outcome: 'SQLSERVER_SNAPSHOT_EXECUTOR_PATH_PROVEN',
    engineMajorVersion: declaredMajorVersion,
    profileId: output.evidence.profileId,
    consistencyProof: 'SOURCE_SNAPSHOT_TXN',
    continuationLifetime: 'CONNECTION_BOUND',
    completenessProof: 'SHORT_PAGE',
    pageSize: output.evidence.pageSize,
    pageCount: output.evidence.pageCount,
    totalRowCount: output.evidence.totalRowCount,
    sameSessionAcrossPages: output.evidence.sameSessionAcrossPages,
    snapshotTransactionObserved: output.evidence.snapshotTransactionObserved,
    runtimeReachable: false,
    customerSourceUsed: false,
  }
  const file = path.join(
    evidenceDir,
    `sqlserver-snapshot-executor-${declaredMajorVersion}.json`,
  )
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
}

async function main() {
  const declaredMajorVersion = requiredEnvironment(
    'B1C_MSSQL_DECLARED_MAJOR_VERSION',
  )
  if (declaredMajorVersion !== '2019' && declaredMajorVersion !== '2022') {
    throw new Error('B1C_EXECUTOR_ENVIRONMENT_INVALID')
  }

  const masterPool = await new sql.ConnectionPool(
    baseConnectionConfig('master'),
  ).connect()
  try {
    await prepareFixture(masterPool)
    const output = await executeSqlServerSnapshotPageSequence({
      connectionConfig: baseConnectionConfig(DATABASE),
    })
    assertExecutorEvidence(output, declaredMajorVersion)
    writeEvidence(output, declaredMajorVersion)
    console.log(`B1C_EXECUTOR_PATH_PROVEN engine=${declaredMajorVersion}`)
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
    return 'B1C_EXECUTOR_PATH_REFUSED'
  }
  let descriptors
  try {
    descriptors = Object.getOwnPropertyDescriptors(error)
  } catch {
    return 'B1C_EXECUTOR_PATH_REFUSED'
  }
  for (const key of ['reason', 'message']) {
    const descriptor = descriptors[key]
    if (
      descriptor &&
      'value' in descriptor &&
      typeof descriptor.value === 'string' &&
      SAFE_ERROR_REASONS.has(descriptor.value)
    ) {
      return descriptor.value
    }
  }
  return 'B1C_EXECUTOR_PATH_REFUSED'
}

main().catch((error) => {
  console.error(`B1C_EXECUTOR_PATH_REFUSED reason=${safeFailureReason(error)}`)
  process.exitCode = 1
})
