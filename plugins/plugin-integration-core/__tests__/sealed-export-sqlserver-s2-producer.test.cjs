'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const originalModuleLoad = Module._load
let activeDriver = null

Module._load = function loadWithHermeticMssql(request, parent, isMain) {
  if (request === 'mssql' && activeDriver !== null) return activeDriver
  return originalModuleLoad.call(this, request, parent, isMain)
}

const canonicalCodec = require('../lib/sealed-export/canonical-json.cjs')
const contracts = require('../lib/sealed-export/contracts.cjs')
const digests = require('../lib/sealed-export/digests.cjs')
const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const producer = require(
  '../lib/sealed-export/sqlserver-s2-producer.cjs',
)

const DRIVER_SENTINEL = 'DRIVER_SECRET private_table.password'
const SOURCE_VALUE_SENTINEL = 'SOURCE-VALUE-SEALED-EXPORT-S2'

function D(label) {
  const result = digests.digestBytes(Buffer.from(label, 'utf8'))
  assert.equal(result.ok, true)
  return result.digest
}

function envelope(overrides = {}) {
  return {
    exportRequestId: 's2-export-request',
    nonce: 's2-nonce',
    expiry: '2099-01-01T00:00:00.000Z',
    scenarioVersion: 'fixture-scenario-v1',
    bindingVersion: 'fixture-binding-v1',
    roleId: 'fixture-source',
    actionProfileVersion: 'fixture-s2-action-v1',
    roleBindingFingerprint: 'fixture-role-binding',
    systemContentKey: 'fixture-system-content',
    approvedConfigVersionId: 'fixture-config-v1',
    configContentKey: 'fixture-config-content',
    canonicalObjectVersion: 'fixture-object-v1',
    qualificationDigest: D('qualification'),
    executionMode: 'S2_FEASIBILITY',
    applyProfileVersion: 'NO_APPLY',
    queryObjectFilterBindingDigest:
      producer.SEALED_EXPORT_S2_QUERY_BINDING_DIGEST,
    expectedSourceSchemaFieldMapDigest:
      producer.SEALED_EXPORT_S2_SOURCE_SCHEMA_DIGEST,
    tenantDomainBinding: 'fixture-tenant-domain',
    rowBudget: 1000,
    byteBudget: 4 * 1024 * 1024,
    chunkBudget: 100,
    ...overrides,
  }
}

function sourceRows(count = 20, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    __activeSnapshotCount: '1',
    __databaseId: 7,
    __isolationLevel: 5,
    __productMajor: 16,
    __sessionId: 41,
    __snapshotEnabledState: 1,
    __transactionId: '9001',
    payload: `${SOURCE_VALUE_SENTINEL}-${String(index).padStart(4, '0')}-${'x'.repeat(5000)}`,
    payloadVersion: 1,
    rowId: index + 1,
    ...overrides,
  }))
}

function createHermeticDriver(options = {}) {
  const rows = options.rows || sourceRows()
  const state = {
    beginIsolationLevel: null,
    begins: 0,
    capabilityQueries: [],
    commits: 0,
    connectionConfig: null,
    poolCloses: 0,
    poolConnects: 0,
    poolConstructs: 0,
    queries: [],
    rollbacks: 0,
    sourceReads: 0,
    streamExhausted: false,
    streamCreates: 0,
    transactionConstructs: 0,
    transactionRequests: 0,
  }

  class ConnectionPool {
    constructor(connectionConfig) {
      state.poolConstructs += 1
      state.connectionConfig = connectionConfig
      if (options.poolConstructorError) throw new Error(DRIVER_SENTINEL)
    }

    async connect() {
      state.poolConnects += 1
      if (options.connectError) throw new Error(DRIVER_SENTINEL)
      return this
    }

    async close() {
      state.poolCloses += 1
      if (options.closeError) throw new Error(DRIVER_SENTINEL)
    }

    request() {
      return {
        async query(sqlText) {
          state.capabilityQueries.push(sqlText)
          if (options.capabilityQueryError) {
            throw new Error(DRIVER_SENTINEL)
          }
          return {
            recordset: [
              {
                snapshotEnabledState:
                  options.snapshotCapabilityState === undefined
                    ? 1
                    : options.snapshotCapabilityState,
              },
            ],
          }
        },
      }
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
      if (options.beginError) throw new Error(DRIVER_SENTINEL)
      this.begun = true
    }

    request() {
      assert.equal(this.begun, true)
      state.transactionRequests += 1
      let streamCreated = false
      return {
        toReadableStream(streamOptions) {
          state.streamCreates += 1
          streamCreated = true
          assert.deepEqual(streamOptions, { highWaterMark: 1 })
          let index = 0
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  if (
                    options.streamErrorAt !== undefined &&
                    index === options.streamErrorAt
                  ) {
                    throw new Error(DRIVER_SENTINEL)
                  }
                  if (index >= rows.length) {
                    state.streamExhausted = true
                    return { done: true }
                  }
                  const value =
                    typeof options.rowAt === 'function'
                      ? options.rowAt(rows[index], index)
                      : rows[index]
                  index += 1
                  return { done: false, value }
                },
              }
            },
          }
        },
        query(sqlText) {
          assert.equal(streamCreated, true)
          state.queries.push(sqlText)
          state.sourceReads += 1
          if (options.queryThrows) throw new Error(DRIVER_SENTINEL)
          if (options.queryRejects) {
            return Promise.reject(new Error(DRIVER_SENTINEL))
          }
          return Promise.resolve({ rowsAffected: [rows.length] })
        },
      }
    }

    async commit() {
      state.commits += 1
      if (options.commitError) throw new Error(DRIVER_SENTINEL)
    }

    async rollback() {
      state.rollbacks += 1
      if (options.rollbackError) throw new Error(DRIVER_SENTINEL)
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

function signingKey() {
  return crypto.generateKeyPairSync('ed25519').privateKey
}

function signerIdentity(overrides = {}) {
  return producer.createSqlServerS2FixtureSignerIdentity({
    signerState: 'ACTIVE',
    signingKey: signingKey(),
    systemContentKey: 'fixture-system-content',
    ...overrides,
  })
}

function input(root, overrides = {}) {
  return {
    actionId: producer.SEALED_EXPORT_S2_ACTION_ID,
    artifactRoot: root,
    connectionConfig: {
      database: 'fixture',
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
      password: 'not-a-real-secret',
      server: 'first-party-ci',
      user: 'ci-user',
    },
    envelope: envelope(),
    onReaderActive: null,
    signerIdentity: signerIdentity(),
    stageObserver: null,
    ...overrides,
  }
}

async function refuses(callback, reason) {
  let caught = null
  try {
    await callback()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  const serialized = JSON.stringify({
    details: caught.details,
    message: caught.message,
    reason: caught.reason,
    stack: caught.stack,
  })
  assert.equal(serialized.includes(DRIVER_SENTINEL), false)
  assert.equal(serialized.includes(SOURCE_VALUE_SENTINEL), false)
  return caught
}

async function makeRoot() {
  return fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s2-producer-test-'),
  )
}

async function assertRootEmpty(root) {
  assert.deepEqual(await fsPromises.readdir(root), [])
}

async function positiveStreamingCaptureAndSigning() {
  const root = await makeRoot()
  const hermetic = createHermeticDriver()
  const stages = []
  const key = signingKey()
  const originalSign = crypto.sign
  const originalOpen = fsPromises.open
  let openWriteHandles = 0
  let signCalls = 0
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (args[1] !== 'wx') return handle
    openWriteHandles += 1
    let closed = false
    return {
      chmod: (...callArgs) => handle.chmod(...callArgs),
      async close(...callArgs) {
        const result = await handle.close(...callArgs)
        if (!closed) {
          closed = true
          openWriteHandles -= 1
        }
        return result
      },
      sync: (...callArgs) => handle.sync(...callArgs),
      write: (...callArgs) => handle.write(...callArgs),
    }
  }
  crypto.sign = function observedSign(...args) {
    signCalls += 1
    assert.equal(hermetic.state.streamExhausted, true)
    assert.equal(openWriteHandles, 0)
    assert.deepEqual(stages, [
      'READER_EXHAUSTED',
      'SOURCE_COMMITTED',
      'ARTIFACT_FINALIZED',
      'MANIFEST_FROZEN',
    ])
    return originalSign(...args)
  }

  try {
    const output = await withDriver(hermetic.driver, () =>
      producer.executeSqlServerS2Producer(
        input(root, {
          signerIdentity: signerIdentity({ signingKey: key }),
          stageObserver: async (stage) => stages.push(stage),
        }),
      ),
    )

    assert.equal(signCalls, 1)
    assert.deepEqual(stages, [
      'READER_EXHAUSTED',
      'SOURCE_COMMITTED',
      'ARTIFACT_FINALIZED',
      'MANIFEST_FROZEN',
      'MANIFEST_SIGNED',
    ])
    assert.equal(hermetic.state.sourceReads, 1)
    assert.equal(hermetic.state.capabilityQueries.length, 1)
    assert.equal(
      hermetic.state.capabilityQueries[0].includes(
        producer.SEALED_EXPORT_S2_FIXTURE_TABLE,
      ),
      false,
    )
    assert.equal(hermetic.state.transactionRequests, 1)
    assert.equal(hermetic.state.streamCreates, 1)
    assert.equal(hermetic.state.beginIsolationLevel, 5)
    assert.equal(hermetic.state.commits, 1)
    assert.equal(hermetic.state.rollbacks, 0)
    assert.equal(hermetic.state.poolCloses, 1)
    assert.equal(hermetic.state.queries.length, 1)
    assert.equal(
      hermetic.state.queries[0].includes(
        producer.SEALED_EXPORT_S2_FIXTURE_TABLE,
      ),
      true,
    )
    assert.equal(hermetic.state.queries[0].includes('not-a-real-secret'), false)

    assert.equal(output.actionId, producer.SEALED_EXPORT_S2_ACTION_ID)
    assert.equal(output.evidence.sourceReadCount, 1)
    assert.equal(output.evidence.readerExhausted, true)
    assert.equal(output.evidence.artifactFinalized, true)
    assert.equal(output.evidence.manifestFrozen, true)
    assert.equal(output.evidence.signatureVerified, true)
    assert.equal(output.evidence.externalWrite, false)
    assert.equal(output.evidence.runtimeReachable, false)
    assert.ok(output.evidence.chunkCount >= 3)
    assert.ok(output.diagnostics.sortRunCount >= 2)
    assert.ok(
      output.diagnostics.maxSortBufferBytes <=
        producer.SEALED_EXPORT_S2_SORT_RUN_BYTES + 6000,
    )

    const evidenceText = JSON.stringify(output.evidence)
    assert.equal(evidenceText.includes(SOURCE_VALUE_SENTINEL), false)
    assert.equal(evidenceText.includes(output.artifact.directory), false)
    assert.equal(evidenceText.includes(output.manifest.signature), false)
    assert.equal(evidenceText.includes(output.manifestDigest), false)
    assert.equal(
      evidenceText.includes(output.manifest.wholeArtifactByteDigest),
      false,
    )

    const chunkBytes = await Promise.all(
      output.artifact.chunkPaths.map((file) => fsPromises.readFile(file)),
    )
    const artifactBytes = await fsPromises.readFile(
      output.artifact.artifactPath,
    )
    assert.deepEqual(Buffer.concat(chunkBytes), artifactBytes)
    assert.deepEqual(
      contracts.verifyArtifactAgainstManifest(output.manifest, chunkBytes),
      {
        byteCount: artifactBytes.length,
        chunkCount: chunkBytes.length,
      },
    )

    const rows = artifactBytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(rows.length, 20)
    assert.deepEqual(
      contracts.verifyRowsetAgainstManifest(output.manifest, rows),
      { rowCount: 20 },
    )

    const expected = digests.computeCanonicalRowsetMultiplicityDigest(
      sourceRows().map((row) => ({
        payload: row.payload,
        payloadVersion: row.payloadVersion,
        rowId: row.rowId,
      })),
      canonicalCodec,
    )
    assert.equal(expected.ok, true)
    assert.equal(
      output.manifest.canonicalRowsetMultiplicityDigest,
      expected.digest,
    )

    const publicKey = crypto.createPublicKey(key)
    assert.equal(
      crypto.verify(
        null,
        contracts.computeSignedManifestBytes(output.manifest),
        publicKey,
        Buffer.from(output.manifest.signature, 'base64'),
      ),
      true,
    )

    assert.equal(
      fs.statSync(output.artifact.directory).mode & 0o777,
      0o700,
    )
    for (const file of [
      output.artifact.artifactPath,
      ...output.artifact.chunkPaths,
    ]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }
    assert.deepEqual(
      (await fsPromises.readdir(output.artifact.directory))
        .filter((name) => name.startsWith('.sort-')),
      [],
    )

    await fsPromises.rm(output.artifact.directory, {
      force: true,
      recursive: true,
    })
    await assertRootEmpty(root)
  } finally {
    crypto.sign = originalSign
    fsPromises.open = originalOpen
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function namedActionAndBindingAreClosed() {
  const root = await makeRoot()
  const hermetic = createHermeticDriver()
  try {
    await refuses(
      () =>
        withDriver(hermetic.driver, () =>
          producer.executeSqlServerS2Producer(
            input(root, { actionId: 'sealed-export.other' }),
          ),
        ),
      'SEALED_EXPORT_PROFILE_UNCERTIFIED',
    )

    const withRawSql = {
      ...input(root),
      sql: `SELECT ${SOURCE_VALUE_SENTINEL}`,
    }
    await refuses(
      () =>
        withDriver(hermetic.driver, () =>
          producer.executeSqlServerS2Producer(withRawSql),
        ),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )

    await refuses(
      () =>
        withDriver(hermetic.driver, () =>
          producer.executeSqlServerS2Producer(
            input(root, {
              envelope: envelope({
                queryObjectFilterBindingDigest: D('other-binding'),
              }),
            }),
          ),
        ),
      'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
    )
    await refuses(
      () =>
        withDriver(hermetic.driver, () =>
          producer.executeSqlServerS2Producer(
            input(root, {
              envelope: envelope({
                expectedSourceSchemaFieldMapDigest: D('other-schema'),
              }),
            }),
          ),
        ),
      'SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH',
    )
    assert.equal(hermetic.state.poolConstructs, 0)
    await assertRootEmpty(root)
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function signerLifecycleIsClosed() {
  for (const [identity, reason] of [
    [
      Object.freeze({
        signerState: 'ACTIVE',
        signingKey: signingKey(),
        systemContentKey: 'fixture-system-content',
      }),
      'SEALED_EXPORT_SIGNER_UNENROLLED',
    ],
    [
      signerIdentity({ signerState: 'EXPIRED' }),
      'SEALED_EXPORT_SIGNER_EXPIRED',
    ],
    [
      signerIdentity({ signerState: 'REVOKED' }),
      'SEALED_EXPORT_SIGNER_REVOKED',
    ],
    [
      signerIdentity({ systemContentKey: 'other-system' }),
      'SEALED_EXPORT_SIGNER_UNENROLLED',
    ],
  ]) {
    const root = await makeRoot()
    const hermetic = createHermeticDriver()
    try {
      await refuses(
        () =>
          withDriver(hermetic.driver, () =>
            producer.executeSqlServerS2Producer(
              input(root, { signerIdentity: identity }),
            ),
          ),
        reason,
      )
      assert.equal(hermetic.state.poolConstructs, 0)
      await assertRootEmpty(root)
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true })
    }
  }

  assert.throws(
    () =>
      producer.createSqlServerS2FixtureSignerIdentity({
        signerState: 'UNKNOWN',
        signingKey: signingKey(),
        systemContentKey: 'fixture-system-content',
      }),
    (error) =>
      error instanceof SealedExportError &&
      error.reason === 'SEALED_EXPORT_SIGNER_UNENROLLED',
  )
}

async function snapshotDowngradeAndDriftRefuseSigning() {
  const cases = [
    {
      options: { snapshotCapabilityState: 0 },
      reason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    },
    {
      options: { capabilityQueryError: true },
      reason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    },
    {
      options: { beginError: true },
      reason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    },
    {
      options: { rows: sourceRows(3, { __snapshotEnabledState: 0 }) },
      reason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    },
    {
      options: { rows: sourceRows(3, { __isolationLevel: 2 }) },
      reason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    },
    {
      options: { rows: sourceRows(3, { __activeSnapshotCount: '0' }) },
      reason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    },
    {
      options: { rows: sourceRows(3, { __activeSnapshotCount: '2' }) },
      reason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    },
    {
      options: {
        rowAt(row, index) {
          return index === 1 ? { ...row, __transactionId: '9002' } : row
        },
      },
      reason: 'SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH',
    },
  ]

  for (const candidate of cases) {
    const root = await makeRoot()
    const hermetic = createHermeticDriver(candidate.options)
    const originalSign = crypto.sign
    let signCalls = 0
    crypto.sign = (...args) => {
      signCalls += 1
      return originalSign(...args)
    }
    try {
      await refuses(
        () =>
          withDriver(hermetic.driver, () =>
            producer.executeSqlServerS2Producer(input(root)),
          ),
        candidate.reason,
      )
      assert.equal(signCalls, 0)
      assert.equal(hermetic.state.commits, 0)
      if (
        !candidate.options.beginError &&
        candidate.options.snapshotCapabilityState === undefined &&
        !candidate.options.capabilityQueryError
      ) {
        assert.equal(hermetic.state.rollbacks, 1)
      } else {
        assert.equal(hermetic.state.rollbacks, 0)
      }
      await assertRootEmpty(root)
    } finally {
      crypto.sign = originalSign
      await fsPromises.rm(root, { force: true, recursive: true })
    }
  }
}

async function incompleteCaptureAndCallbackFailureCleanUp() {
  const cases = [
    {
      options: { streamErrorAt: 2 },
      reason: 'SEALED_EXPORT_CAPTURE_INCOMPLETE',
      overrides: {},
    },
    {
      options: { queryRejects: true },
      reason: 'SEALED_EXPORT_CAPTURE_INCOMPLETE',
      overrides: {},
    },
    {
      options: { rows: [] },
      reason: 'SEALED_EXPORT_CAPTURE_INCOMPLETE',
      overrides: {},
    },
    {
      options: {},
      reason: 'SEALED_EXPORT_CAPTURE_FAILED',
      overrides: {
        onReaderActive: async () => {
          throw new Error(DRIVER_SENTINEL)
        },
      },
    },
    {
      options: { commitError: true },
      reason: 'SEALED_EXPORT_CAPTURE_FAILED',
      overrides: {},
    },
  ]

  for (const candidate of cases) {
    const root = await makeRoot()
    const hermetic = createHermeticDriver(candidate.options)
    const originalSign = crypto.sign
    let signCalls = 0
    crypto.sign = (...args) => {
      signCalls += 1
      return originalSign(...args)
    }
    try {
      await refuses(
        () =>
          withDriver(hermetic.driver, () =>
            producer.executeSqlServerS2Producer(
              input(root, candidate.overrides),
            ),
          ),
        candidate.reason,
      )
      assert.equal(signCalls, 0)
      assert.equal(hermetic.state.commits, candidate.options.commitError ? 1 : 0)
      assert.equal(hermetic.state.rollbacks, 1)
      await assertRootEmpty(root)
    } finally {
      crypto.sign = originalSign
      await fsPromises.rm(root, { force: true, recursive: true })
    }
  }
}

async function eachBudgetCarriesItsOwnRefusal() {
  const cases = [
    {
      budget: 'ROW_BUDGET',
      envelope: envelope({ rowBudget: 1 }),
      rows: sourceRows(2),
    },
    {
      budget: 'BYTE_BUDGET',
      envelope: envelope({ byteBudget: 1 }),
      rows: sourceRows(1),
    },
    {
      budget: 'CHUNK_BUDGET',
      envelope: envelope({ chunkBudget: 1 }),
      rows: sourceRows(5),
    },
  ]
  for (const candidate of cases) {
    const root = await makeRoot()
    const hermetic = createHermeticDriver({ rows: candidate.rows })
    try {
      const error = await refuses(
        () =>
          withDriver(hermetic.driver, () =>
            producer.executeSqlServerS2Producer(
              input(root, { envelope: candidate.envelope }),
            ),
          ),
        'SEALED_EXPORT_BUDGET_EXCEEDED',
      )
      assert.deepEqual(error.details, { budget: candidate.budget })
      assert.equal(hermetic.state.commits, 0)
      assert.equal(hermetic.state.rollbacks, 1)
      await assertRootEmpty(root)
    } finally {
      await fsPromises.rm(root, { force: true, recursive: true })
    }
  }
}

async function malformedSourceRowAndBadSignatureFailClosed() {
  const malformedRoot = await makeRoot()
  const malformed = createHermeticDriver({
    rowAt(row, index) {
      return index === 0 ? { ...row, unexpected: SOURCE_VALUE_SENTINEL } : row
    },
  })
  try {
    await refuses(
      () =>
        withDriver(malformed.driver, () =>
          producer.executeSqlServerS2Producer(input(malformedRoot)),
        ),
      'SEALED_EXPORT_CAPTURE_FAILED',
    )
    await assertRootEmpty(malformedRoot)
  } finally {
    await fsPromises.rm(malformedRoot, { force: true, recursive: true })
  }

  const signatureRoot = await makeRoot()
  const valid = createHermeticDriver({ rows: sourceRows(2) })
  const originalVerify = crypto.verify
  crypto.verify = () => false
  try {
    await refuses(
      () =>
        withDriver(valid.driver, () =>
          producer.executeSqlServerS2Producer(input(signatureRoot)),
        ),
      'SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID',
    )
    await assertRootEmpty(signatureRoot)
  } finally {
    crypto.verify = originalVerify
    await fsPromises.rm(signatureRoot, {
      force: true,
      recursive: true,
    })
  }
}

async function shortWritesAreCompletedAndScratchDeleteFailureRefuses() {
  const shortWriteRoot = await makeRoot()
  const shortWriteDriver = createHermeticDriver({
    rows: sourceRows(4),
  })
  const originalOpen = fsPromises.open
  let shortWriteCalls = 0
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (args[1] !== 'wx') return handle
    return {
      chmod: (...callArgs) => handle.chmod(...callArgs),
      close: (...callArgs) => handle.close(...callArgs),
      sync: (...callArgs) => handle.sync(...callArgs),
      async write(buffer, offset, length, position) {
        shortWriteCalls += 1
        return handle.write(
          buffer,
          offset,
          Math.max(1, Math.floor(length / 2)),
          position,
        )
      },
    }
  }
  try {
    const output = await withDriver(shortWriteDriver.driver, () =>
      producer.executeSqlServerS2Producer(input(shortWriteRoot)),
    )
    assert.ok(shortWriteCalls > output.evidence.rowCount)
    const chunkBytes = await Promise.all(
      output.artifact.chunkPaths.map((file) => fsPromises.readFile(file)),
    )
    assert.deepEqual(
      contracts.verifyArtifactAgainstManifest(output.manifest, chunkBytes),
      {
        byteCount: output.manifest.totalBytes,
        chunkCount: output.manifest.chunks.length,
      },
    )
    await fsPromises.rm(output.artifact.directory, {
      force: true,
      recursive: true,
    })
    await assertRootEmpty(shortWriteRoot)
  } finally {
    fsPromises.open = originalOpen
    await fsPromises.rm(shortWriteRoot, {
      force: true,
      recursive: true,
    })
  }

  const unlinkRoot = await makeRoot()
  const unlinkDriver = createHermeticDriver({
    rows: sourceRows(20),
  })
  const originalUnlink = fsPromises.unlink
  let injected = false
  fsPromises.unlink = async (file) => {
    if (!injected && path.basename(file).startsWith('.sort-')) {
      injected = true
      throw new Error(DRIVER_SENTINEL)
    }
    return originalUnlink(file)
  }
  try {
    await refuses(
      () =>
        withDriver(unlinkDriver.driver, () =>
          producer.executeSqlServerS2Producer(input(unlinkRoot)),
        ),
      'SEALED_EXPORT_CAPTURE_FAILED',
    )
    assert.equal(injected, true)
    await assertRootEmpty(unlinkRoot)
  } finally {
    fsPromises.unlink = originalUnlink
    await fsPromises.rm(unlinkRoot, {
      force: true,
      recursive: true,
    })
  }
}

async function main() {
  try {
    await positiveStreamingCaptureAndSigning()
    await namedActionAndBindingAreClosed()
    await signerLifecycleIsClosed()
    await snapshotDowngradeAndDriftRefuseSigning()
    await incompleteCaptureAndCallbackFailureCleanUp()
    await eachBudgetCarriesItsOwnRefusal()
    await malformedSourceRowAndBadSignatureFailClosed()
    await shortWritesAreCompletedAndScratchDeleteFailureRefuses()
    console.log('sealed-export SQL Server S2 producer tests passed')
  } finally {
    Module._load = originalModuleLoad
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
