'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const EXECUTOR_MODULE =
  '../lib/gip-sqlserver-snapshot-page-sequence-executor.cjs'
const EXECUTOR_BASENAME = 'gip-sqlserver-snapshot-page-sequence-executor'
const originalModuleLoad = Module._load
let activeDriver = null

Module._load = function loadWithHermeticMssql(request, parent, isMain) {
  if (request === 'mssql' && activeDriver !== null) {
    return activeDriver
  }
  return originalModuleLoad.call(this, request, parent, isMain)
}

const {
  SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE,
  SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE,
  SQLSERVER_SNAPSHOT_EXECUTOR_MAX_PAGES,
  SQLSERVER_SNAPSHOT_EXECUTOR_MAX_ROWS,
  SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS,
  executeSqlServerSnapshotPageSequence,
} = require(EXECUTOR_MODULE)
const {
  verifyExecutorEvidenceArtifacts,
} = require('../scripts/verify-b1c-sqlserver-snapshot-executor-evidence.cjs')

const DRIVER_SENTINEL = 'DRIVER_SECRET column private_table.password failed'

function cloneRows(rowCount, sessionId) {
  return Array.from({ length: rowCount }, (_, index) => ({
    keyValue: index + 1,
    sessionId,
  }))
}

function createHermeticDriver(options = {}) {
  const rows =
    options.rows ||
    cloneRows(options.rowCount === undefined ? 8 : options.rowCount, 41)
  const state = {
    poolConstructs: 0,
    poolConnects: 0,
    poolCloses: 0,
    transactionConstructs: 0,
    begins: 0,
    commits: 0,
    rollbacks: 0,
    transactionRequests: 0,
    queries: [],
    inputCalls: [],
    connectionConfig: null,
    pageReads: 0,
    observations: 0,
  }

  function sessionForPage(pageIndex) {
    const sessions = options.pageSessionIds || []
    return sessions[pageIndex] || options.sessionId || 41
  }

  class ConnectionPool {
    constructor(connectionConfig) {
      state.poolConstructs += 1
      state.connectionConfig = connectionConfig
      if (options.poolConstructorError) {
        throw options.poolConstructorError
      }
    }

    async connect() {
      state.poolConnects += 1
      if (options.connectError) throw options.connectError
      return this
    }

    async close() {
      state.poolCloses += 1
      if (options.closeError) throw options.closeError
    }
  }

  class Transaction {
    constructor(pool) {
      assert.ok(pool instanceof ConnectionPool)
      state.transactionConstructs += 1
      this.begun = false
    }

    async begin(isolationLevel) {
      state.begins += 1
      state.beginIsolationLevel = isolationLevel
      if (options.beginError) throw options.beginError
      this.begun = true
    }

    request() {
      assert.equal(this.begun, true)
      state.transactionRequests += 1
      const inputs = new Map()
      return {
        input(name, value) {
          state.inputCalls.push([name, value])
          inputs.set(name, value)
          return this
        },
        async query(sqlText) {
          state.queries.push(sqlText)
          if (sqlText.includes(SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE)) {
            const pageIndex = state.pageReads
            state.pageReads += 1
            if (
              options.pageErrorAt !== undefined &&
              options.pageErrorAt === pageIndex
            ) {
              throw options.pageError || new Error(DRIVER_SENTINEL)
            }
            const offset = inputs.get('offset')
            const pageSize = inputs.get('pageSize')
            const pageRows = rows
              .slice(offset, offset + pageSize)
              .map((row) => ({
                ...row,
                sessionId: sessionForPage(pageIndex),
              }))
            if (
              options.hostilePageResultAt !== undefined &&
              options.hostilePageResultAt === pageIndex
            ) {
              return Object.defineProperty({}, 'recordset', {
                enumerable: true,
                get() {
                  throw (
                    options.hostilePageResultError || new Error(DRIVER_SENTINEL)
                  )
                },
              })
            }
            return { recordset: pageRows }
          }

          const observationIndex = state.observations
          state.observations += 1
          if (
            options.observationErrorAt !== undefined &&
            options.observationErrorAt === observationIndex
          ) {
            throw options.observationError || new Error(DRIVER_SENTINEL)
          }
          if (
            options.hostileObservationResultAt !== undefined &&
            options.hostileObservationResultAt === observationIndex
          ) {
            return Object.defineProperty({}, 'recordset', {
              enumerable: true,
              get() {
                throw new Error(DRIVER_SENTINEL)
              },
            })
          }
          return {
            recordset: [
              {
                productMajor:
                  options.productMajor === undefined
                    ? 15
                    : options.productMajor,
                sessionId: sessionForPage(observationIndex),
                snapshotEnabledState:
                  options.snapshotEnabledState === undefined
                    ? 1
                    : options.snapshotEnabledState,
                isolationLevel:
                  options.isolationLevel === undefined
                    ? 5
                    : options.isolationLevel,
                activeSnapshotCount:
                  options.activeSnapshotCount === undefined
                    ? '1'
                    : options.activeSnapshotCount,
              },
            ],
          }
        },
      }
    }

    async commit() {
      state.commits += 1
      if (options.commitError) throw options.commitError
    }

    async rollback() {
      state.rollbacks += 1
      if (options.rollbackError) throw options.rollbackError
    }
  }

  return {
    driver: {
      ConnectionPool,
      Transaction,
      ISOLATION_LEVEL: Object.freeze({ SNAPSHOT: 5 }),
    },
    state,
  }
}

async function withDriver(driver, callback) {
  assert.equal(activeDriver, null)
  activeDriver = driver
  try {
    return await callback()
  } finally {
    activeDriver = null
  }
}

function connectionInput(extra = {}) {
  return {
    connectionConfig: {
      server: 'first-party-ci',
      database: 'gip_executor_fixture',
      user: 'ci-user',
      password: 'not-a-real-secret',
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
    },
    ...extra,
  }
}

function serializedOwnError(error) {
  const projection = {}
  for (const key of Object.getOwnPropertyNames(error)) {
    let value
    try {
      value = error[key]
    } catch {
      value = 'ACCESS_FAILED'
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      projection[key] = value
    }
  }
  return JSON.stringify(projection)
}

async function expectRefusal(driverState, expectedReason, callback) {
  let caught = null
  try {
    await withDriver(driverState.driver, callback)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.name, 'SqlServerSnapshotPageSequenceExecutorError')
  assert.equal(caught.reason, expectedReason)
  assert.equal(Object.isFrozen(caught), true)
  assert.equal(Object.prototype.hasOwnProperty.call(caught, 'cause'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(caught, 'details'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(caught, 'sql'), false)
  assert.equal(serializedOwnError(caught).includes(DRIVER_SENTINEL), false)
  return caught
}

async function successUsesOneSnapshotContext() {
  for (const productMajor of [15, 16]) {
    const harness = createHermeticDriver({
      rowCount: 8,
      productMajor,
    })
    const output = await withDriver(harness.driver, () =>
      executeSqlServerSnapshotPageSequence(connectionInput()),
    )

    assert.equal(output.rows.length, 8)
    assert.deepEqual(
      output.rows.map((row) => row.keyValue),
      [1, 2, 3, 4, 5, 6, 7, 8],
    )
    assert.deepEqual(output.evidence, {
      profileId: 'sqlserver.snapshot_paged_read.v1',
      engineMajorVersion: productMajor === 15 ? '2019' : '2022',
      contextState: 'COMPLETED',
      pageSize: 3,
      pageCount: 3,
      totalRowCount: 8,
      sameSessionAcrossPages: true,
      snapshotTransactionObserved: true,
      completeness: {
        runOutcome: 'successful',
        usedCompletenessProofs: ['SHORT_PAGE'],
      },
    })
    assert.equal(Object.isFrozen(output), true)
    assert.equal(Object.isFrozen(output.rows), true)
    assert.equal(Object.isFrozen(output.rows[0]), true)
    assert.equal(Object.isFrozen(output.evidence), true)
    assert.equal(harness.state.poolConstructs, 1)
    assert.equal(harness.state.poolConnects, 1)
    assert.equal(harness.state.transactionConstructs, 1)
    assert.equal(harness.state.begins, 1)
    assert.equal(harness.state.beginIsolationLevel, 5)
    assert.equal(harness.state.commits, 1)
    assert.equal(harness.state.rollbacks, 0)
    assert.equal(harness.state.poolCloses, 1)
    assert.equal(harness.state.pageReads, 3)
    assert.equal(harness.state.observations, 3)
    assert.deepEqual(harness.state.inputCalls, [
      ['offset', 0],
      ['pageSize', 3],
      ['offset', 3],
      ['pageSize', 3],
      ['offset', 6],
      ['pageSize', 3],
    ])
  }
}

async function boundaryMatrixFailsClosed() {
  const cases = [
    [0, 'SQLSERVER_SNAPSHOT_EXECUTOR_EMPTY_SOURCE_UNCERTIFIED', 1],
    [6, 'SQLSERVER_SNAPSHOT_EXECUTOR_COMPLETENESS_UNPROVABLE', 3],
    [9, 'SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED', 3],
    [12, 'SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED', 3],
  ]
  for (const [rowCount, reason, expectedPageReads] of cases) {
    const harness = createHermeticDriver({ rowCount })
    await expectRefusal(harness, reason, () =>
      executeSqlServerSnapshotPageSequence(connectionInput()),
    )
    assert.equal(harness.state.transactionConstructs, 1)
    assert.equal(harness.state.begins, 1)
    assert.equal(harness.state.commits, 0)
    assert.equal(harness.state.rollbacks, 1)
    assert.equal(harness.state.poolCloses, 1)
    assert.equal(harness.state.pageReads, expectedPageReads)
  }
}

async function sessionAndSnapshotObservationsFailClosed() {
  const drift = createHermeticDriver({
    rowCount: 8,
    pageSessionIds: [41, 42, 42],
  })
  await expectRefusal(drift, 'SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_DRIFT', () =>
    executeSqlServerSnapshotPageSequence(connectionInput()),
  )
  assert.equal(drift.state.transactionConstructs, 1)
  assert.equal(drift.state.rollbacks, 1)

  for (const options of [
    { snapshotEnabledState: 0 },
    { isolationLevel: 2 },
    { activeSnapshotCount: 0 },
  ]) {
    const unproven = createHermeticDriver({
      rowCount: 8,
      ...options,
    })
    await expectRefusal(
      unproven,
      'SQLSERVER_SNAPSHOT_EXECUTOR_SNAPSHOT_UNPROVEN',
      () => executeSqlServerSnapshotPageSequence(connectionInput()),
    )
    assert.equal(unproven.state.transactionConstructs, 1)
    assert.equal(unproven.state.rollbacks, 1)
    assert.equal(unproven.state.poolCloses, 1)
  }

  const uncertifiedEngine = createHermeticDriver({
    rowCount: 8,
    productMajor: 17,
  })
  await expectRefusal(
    uncertifiedEngine,
    'SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED',
    () => executeSqlServerSnapshotPageSequence(connectionInput()),
  )
}

async function connectionLossNeverResnapshots() {
  const harness = createHermeticDriver({
    rowCount: 8,
    pageErrorAt: 1,
    pageError: Object.assign(new Error(DRIVER_SENTINEL), {
      code: 'ECONNCLOSED',
      cause: { table: 'private_table' },
      details: { column: 'password' },
    }),
  })
  await expectRefusal(
    harness,
    'SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED',
    () => executeSqlServerSnapshotPageSequence(connectionInput()),
  )
  assert.equal(harness.state.transactionConstructs, 1)
  assert.equal(harness.state.begins, 1)
  assert.equal(harness.state.pageReads, 2)
  assert.equal(harness.state.commits, 0)
  assert.equal(harness.state.rollbacks, 1)
  assert.equal(harness.state.poolCloses, 1)
}

async function hostileDriverShapesAreReminted() {
  const hostileCases = [
    createHermeticDriver({
      connectError: Object.assign(new Error(DRIVER_SENTINEL), {
        code: 'ELOGIN',
        cause: { password: DRIVER_SENTINEL },
      }),
    }),
    createHermeticDriver({
      rowCount: 8,
      hostilePageResultAt: 0,
      hostilePageResultError: Object.assign(new Error(DRIVER_SENTINEL), {
        reason: 'SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED',
      }),
    }),
    createHermeticDriver({
      rowCount: 8,
      observationErrorAt: 0,
      observationError: Object.assign(new Error(DRIVER_SENTINEL), {
        sql: `SELECT * FROM ${DRIVER_SENTINEL}`,
      }),
    }),
    createHermeticDriver({
      rowCount: 8,
      pageErrorAt: 0,
      pageError: Object.assign(new Error(DRIVER_SENTINEL), {
        reason: 'SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED',
      }),
    }),
    createHermeticDriver({
      rowCount: 8,
      hostileObservationResultAt: 0,
    }),
  ]
  const expectedReasons = [
    'SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_OPEN_FAILED',
    'SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED',
    'SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED',
    'SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED',
    'SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED',
  ]
  for (let index = 0; index < hostileCases.length; index += 1) {
    await expectRefusal(hostileCases[index], expectedReasons[index], () =>
      executeSqlServerSnapshotPageSequence(connectionInput()),
    )
  }
}

async function commitAndCleanupFailuresRemainClosed() {
  const commitFailure = createHermeticDriver({
    rowCount: 8,
    commitError: new Error(DRIVER_SENTINEL),
  })
  await expectRefusal(
    commitFailure,
    'SQLSERVER_SNAPSHOT_EXECUTOR_COMMIT_FAILED',
    () => executeSqlServerSnapshotPageSequence(connectionInput()),
  )
  assert.equal(commitFailure.state.commits, 1)
  assert.equal(commitFailure.state.rollbacks, 1)
  assert.equal(commitFailure.state.poolCloses, 1)

  const cleanupFailure = createHermeticDriver({
    rowCount: 8,
    closeError: new Error(DRIVER_SENTINEL),
  })
  await expectRefusal(
    cleanupFailure,
    'SQLSERVER_SNAPSHOT_EXECUTOR_CLEANUP_FAILED',
    () => executeSqlServerSnapshotPageSequence(connectionInput()),
  )
  assert.equal(cleanupFailure.state.commits, 1)
  assert.equal(cleanupFailure.state.rollbacks, 0)
  assert.equal(cleanupFailure.state.poolCloses, 1)
}

async function callerCannotSteerReadPlan() {
  const forbiddenFields = [
    'sql',
    'object',
    'table',
    'projection',
    'orderBy',
    'offset',
    'pageSize',
    'transaction',
    'connectionFactory',
    'retry',
  ]
  for (const field of forbiddenFields) {
    const harness = createHermeticDriver()
    await expectRefusal(
      harness,
      'SQLSERVER_SNAPSHOT_EXECUTOR_INPUT_INVALID',
      () =>
        executeSqlServerSnapshotPageSequence(
          connectionInput({ [field]: 'caller-controlled' }),
        ),
    )
    assert.equal(harness.state.poolConstructs, 0)
    assert.equal(harness.state.transactionConstructs, 0)
  }
}

function sourcePinsTransactionBoundReadPlan() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', `${EXECUTOR_BASENAME}.cjs`),
    'utf8',
  )
  assert.match(source, /new sql\.Transaction\(pool\)/)
  assert.match(source, /transaction\.request\(\)/)
  assert.match(source, /ISOLATION_LEVEL\.SNAPSHOT/)
  assert.match(source, /OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY/)
  assert.doesNotMatch(source, /MSSQLAdapter/)
  assert.doesNotMatch(source, /\.select\(/)
  assert.doesNotMatch(source, /\.stream\(/)
  assert.doesNotMatch(source, /createHarness.*Factory/)
}

function walkSourceFiles(rootPath, output) {
  if (!fs.existsSync(rootPath)) return
  const stat = fs.lstatSync(rootPath)
  if (stat.isSymbolicLink()) return
  if (stat.isFile()) {
    if (/\.(?:c?js|mjs|ts|tsx)$/.test(rootPath)) output.push(rootPath)
    return
  }
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === 'coverage'
    ) {
      continue
    }
    walkSourceFiles(path.join(rootPath, entry.name), output)
  }
}

function noProductionConsumerExists() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const files = []
  for (const root of [
    'apps',
    'packages',
    'plugins',
    'scripts',
    'tools',
    'ops',
  ]) {
    walkSourceFiles(path.join(repoRoot, root), files)
  }
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:c?js|mjs|ts|tsx)$/.test(entry.name)) {
      files.push(path.join(repoRoot, entry.name))
    }
  }

  const allowed = new Set([
    path.join(
      repoRoot,
      'plugins/plugin-integration-core/lib',
      `${EXECUTOR_BASENAME}.cjs`,
    ),
    path.join(
      repoRoot,
      'plugins/plugin-integration-core/__tests__',
      'gip-sqlserver-snapshot-paged-read-profile.test.cjs',
    ),
    path.join(
      repoRoot,
      'plugins/plugin-integration-core/__tests__',
      'gip-server-bound-source-executor.test.cjs',
    ),
    path.join(
      repoRoot,
      'plugins/plugin-integration-core/scripts',
      'run-gip-sqlserver-snapshot-page-sequence-executor.cjs',
    ),
    __filename,
  ])
  const consumers = files.filter((file) => {
    if (allowed.has(file)) return false
    return fs.readFileSync(file, 'utf8').includes(EXECUTOR_BASENAME)
  })
  assert.deepEqual(consumers, [])
}

function constantsAndTestChainArePinned() {
  assert.equal(
    SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE,
    'dbo.gip_b1c_snapshot_executor_fixture',
  )
  assert.equal(SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE, 3)
  assert.equal(SQLSERVER_SNAPSHOT_EXECUTOR_MAX_PAGES, 3)
  assert.equal(SQLSERVER_SNAPSHOT_EXECUTOR_MAX_ROWS, 8)
  assert.equal(
    new Set(SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS).size,
    SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS.length,
  )

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  )
  const command =
    'node __tests__/gip-sqlserver-snapshot-page-sequence-executor.test.cjs'
  assert.equal(
    packageJson.scripts['test:gip-sqlserver-snapshot-page-sequence-executor'],
    command,
  )
  assert.equal(
    require(path.join(__dirname, '..', 'scripts', 'test-chain.cjs'))
      .loadChain(path.join(__dirname, '..'))
      .filter((entry) => entry === command).length,
    1,
    'the executor suite must occur exactly once in the explicit test chain',
  )
  assert.equal(
    packageJson.scripts[
      'evidence:gip-sqlserver-snapshot-page-sequence-executor'
    ],
    'node scripts/run-gip-sqlserver-snapshot-page-sequence-executor.cjs',
  )
  assert.equal(
    packageJson.scripts[
      'verify:gip-sqlserver-snapshot-page-sequence-executor-evidence'
    ],
    'node scripts/verify-b1c-sqlserver-snapshot-executor-evidence.cjs',
  )
}

function executorEvidenceRecord(engineMajorVersion) {
  return {
    evidenceSchemaVersion: 1,
    outcome: 'SQLSERVER_SNAPSHOT_EXECUTOR_PATH_PROVEN',
    engineMajorVersion,
    profileId: 'sqlserver.snapshot_paged_read.v1',
    consistencyProof: 'SOURCE_SNAPSHOT_TXN',
    continuationLifetime: 'CONNECTION_BOUND',
    completenessProof: 'SHORT_PAGE',
    pageSize: 3,
    pageCount: 3,
    totalRowCount: 8,
    sameSessionAcrossPages: true,
    snapshotTransactionObserved: true,
    runtimeReachable: false,
    customerSourceUsed: false,
  }
}

function persistedExecutorEvidenceIsClosed() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gip-b1c-executor-evidence-'),
  )
  const evidenceDir = path.join(root, 'executor')
  fs.mkdirSync(evidenceDir)
  const fileFor = (version) =>
    path.join(evidenceDir, `sqlserver-snapshot-executor-${version}.json`)
  try {
    for (const version of ['2019', '2022']) {
      fs.writeFileSync(
        fileFor(version),
        `${JSON.stringify(executorEvidenceRecord(version))}\n`,
      )
    }
    assert.deepEqual(verifyExecutorEvidenceArtifacts(root), ['2019', '2022'])

    fs.writeFileSync(
      fileFor('2022'),
      `${JSON.stringify({
        ...executorEvidenceRecord('2022'),
        runtimeReachable: true,
      })}\n`,
    )
    assert.throws(
      () => verifyExecutorEvidenceArtifacts(root),
      /B1C_EXECUTOR_EVIDENCE_ARTIFACT_INVALID/,
    )

    fs.writeFileSync(
      fileFor('2022'),
      `${JSON.stringify(executorEvidenceRecord('2022'))}\n`,
    )
    fs.writeFileSync(path.join(evidenceDir, 'undeclared.json'), '{}\n')
    assert.throws(
      () => verifyExecutorEvidenceArtifacts(root),
      /B1C_EXECUTOR_EVIDENCE_ARTIFACT_INVALID/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  await successUsesOneSnapshotContext()
  await boundaryMatrixFailsClosed()
  await sessionAndSnapshotObservationsFailClosed()
  await connectionLossNeverResnapshots()
  await hostileDriverShapesAreReminted()
  await commitAndCleanupFailuresRemainClosed()
  await callerCannotSteerReadPlan()
  sourcePinsTransactionBoundReadPlan()
  noProductionConsumerExists()
  constantsAndTestChainArePinned()
  persistedExecutorEvidenceIsClosed()
  console.log('gip-sqlserver-snapshot-page-sequence-executor.test.cjs: PASS')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    Module._load = originalModuleLoad
  })
