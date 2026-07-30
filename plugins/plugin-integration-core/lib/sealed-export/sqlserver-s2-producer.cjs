'use strict'

// Sealed-export S2 producer feasibility.
//
// LATENT: this module has no route, scheduler, profile registration, runtime
// consumer, upload session, staging writer, or deployment wiring. It owns one
// first-party SQL Server fixture action used only by hermetic and real-engine
// capability tests.

const crypto = require('node:crypto')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')

const canonicalCodec = require('./canonical-json.cjs')
const contracts = require('./contracts.cjs')
const digests = require('./digests.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')

const SEALED_EXPORT_S2_ACTION_ID = 'sealed-export.sqlserver.fixture.v1'
const SEALED_EXPORT_S2_FIXTURE_TABLE = 'dbo.sealed_export_s2_fixture'
const SEALED_EXPORT_S2_CHUNK_BYTES = 16 * 1024
const SEALED_EXPORT_S2_SORT_RUN_BYTES = 64 * 1024
const SEALED_EXPORT_S2_SORT_MERGE_FAN_IN = 16
const SEALED_EXPORT_S2_AGENT_IMPLEMENTATION_VERSION =
  'sealed-export-s2-sqlserver-v1'
const SEALED_EXPORT_S2_AGENT_PROTOCOL_VERSION = 'sealed-export-s2-v1'
const SEALED_EXPORT_S2_ENCODING_VERSION = 'canonical-jsonl-v1'
const SEALED_EXPORT_S2_SIGNATURE_ALGORITHM = 'ED25519'
const FIXTURE_SIGNER_IDENTITIES = new WeakMap()

const SOURCE_FIELDS = Object.freeze([
  Object.freeze({
    fieldId: 'rowId',
    sourceType: 'SAFE_POSITIVE_INTEGER',
    nullable: false,
  }),
  Object.freeze({
    fieldId: 'payloadVersion',
    sourceType: 'SAFE_POSITIVE_INTEGER',
    nullable: false,
  }),
  Object.freeze({
    fieldId: 'payload',
    sourceType: 'STRING',
    nullable: false,
  }),
])

const ACTION_BINDING = Object.freeze({
  actionId: SEALED_EXPORT_S2_ACTION_ID,
  filterPolicy: 'NONE',
  objectToken: 'SEALED_EXPORT_S2_FIXTURE',
})

function digestCanonicalConstant(value) {
  const canonical = canonicalCodec.tryCanonicalJson(value)
  if (!canonical.ok) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const digest = digests.digestBytes(canonical.bytes)
  if (!digest.ok) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return digest.digest
}

const SEALED_EXPORT_S2_SOURCE_SCHEMA_DIGEST =
  digestCanonicalConstant(SOURCE_FIELDS)
const SEALED_EXPORT_S2_QUERY_BINDING_DIGEST =
  digestCanonicalConstant(ACTION_BINDING)

// No caller-controlled SQL, object, field, filter, ordering, or limit enters
// this statement. Internal capture fields are removed before row
// canonicalization and never enter the private artifact.
const SOURCE_READ_SQL = `
SELECT
  CAST(source.row_id AS bigint) AS rowId,
  CAST(source.payload_version AS bigint) AS payloadVersion,
  CAST(source.payload AS nvarchar(4000)) AS payload,
  CAST(@@SPID AS int) AS __sessionId,
  CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS __productMajor,
  CAST(DB_ID() AS int) AS __databaseId,
  CAST(CURRENT_TRANSACTION_ID() AS bigint) AS __transactionId,
  CAST((
    SELECT snapshot_isolation_state
    FROM sys.databases
    WHERE database_id = DB_ID()
  ) AS int) AS __snapshotEnabledState,
  CAST((
    SELECT transaction_isolation_level
    FROM sys.dm_exec_sessions
    WHERE session_id = @@SPID
  ) AS int) AS __isolationLevel,
  CAST((
    SELECT COUNT_BIG(*)
    FROM sys.dm_tran_active_snapshot_database_transactions
    WHERE
      session_id = @@SPID
      AND transaction_id = CURRENT_TRANSACTION_ID()
      AND is_snapshot = 1
  ) AS bigint) AS __activeSnapshotCount
FROM ${SEALED_EXPORT_S2_FIXTURE_TABLE} AS source
ORDER BY source.row_id ASC
`

// SQL Server accepts SET TRANSACTION ISOLATION LEVEL SNAPSHOT before the first
// data statement even when snapshot isolation is disabled for the database.
// This metadata-only precheck gives that disabled state the required closed
// refusal; the source statement still proves the active transaction per row.
const SNAPSHOT_CAPABILITY_SQL = `
SELECT CAST(snapshot_isolation_state AS int) AS snapshotEnabledState
FROM sys.databases
WHERE database_id = DB_ID()
`

const INPUT_FIELDS = Object.freeze([
  'actionId',
  'artifactRoot',
  'connectionConfig',
  'envelope',
  'onReaderActive',
  'signerIdentity',
  'stageObserver',
])

const SIGNER_IDENTITY_FIELDS = Object.freeze([
  'signerState',
  'signingKey',
  'systemContentKey',
])

const RAW_ROW_FIELDS = Object.freeze([
  '__activeSnapshotCount',
  '__databaseId',
  '__isolationLevel',
  '__productMajor',
  '__sessionId',
  '__snapshotEnabledState',
  '__transactionId',
  'payload',
  'payloadVersion',
  'rowId',
])

function isStrictObject(value) {
  return canonicalCodec.__internals.isStrictPlainObject(value)
}

function ownDataValue(object, field) {
  const descriptor = Object.getOwnPropertyDescriptor(object, field)
  if (
    !descriptor ||
    descriptor.get ||
    descriptor.set ||
    !descriptor.enumerable
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return descriptor.value
}

function hasExactKeys(object, expectedKeys) {
  if (!isStrictObject(object)) return false
  const actual = Object.keys(object).sort()
  return !(
    actual.length !== expectedKeys.length ||
    actual.some((field, index) => field !== expectedKeys[index])
  )
}

function normalizeConnectionConfig(value) {
  const frozen = canonicalCodec.tryFreezeCanonical(value)
  if (!frozen.ok || !isStrictObject(frozen.value)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return frozen.value
}

function normalizeInput(rawInput) {
  if (!hasExactKeys(rawInput, INPUT_FIELDS)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  const actionId = ownDataValue(rawInput, 'actionId')
  if (actionId !== SEALED_EXPORT_S2_ACTION_ID) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }

  const artifactRoot = ownDataValue(rawInput, 'artifactRoot')
  if (
    typeof artifactRoot !== 'string' ||
    artifactRoot.length === 0 ||
    artifactRoot.indexOf('\0') >= 0 ||
    !path.isAbsolute(artifactRoot)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  const envelope = contracts.validateExportRequestEnvelope(
    ownDataValue(rawInput, 'envelope'),
  )
  if (
    !digests.constantTimeEqualDigest(
      envelope.queryObjectFilterBindingDigest,
      SEALED_EXPORT_S2_QUERY_BINDING_DIGEST,
    )
  ) {
    failSealedExport('SEALED_EXPORT_MANIFEST_BINDING_MISMATCH')
  }
  if (
    !digests.constantTimeEqualDigest(
      envelope.expectedSourceSchemaFieldMapDigest,
      SEALED_EXPORT_S2_SOURCE_SCHEMA_DIGEST,
    )
  ) {
    failSealedExport('SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH')
  }

  const signer = resolveFixtureSignerIdentity(
    ownDataValue(rawInput, 'signerIdentity'),
    envelope.systemContentKey,
  )

  const onReaderActive = ownDataValue(rawInput, 'onReaderActive')
  const stageObserver = ownDataValue(rawInput, 'stageObserver')
  if (
    (onReaderActive !== null && typeof onReaderActive !== 'function') ||
    (stageObserver !== null && typeof stageObserver !== 'function')
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  return Object.freeze({
    actionId,
    artifactRoot,
    connectionConfig: normalizeConnectionConfig(
      ownDataValue(rawInput, 'connectionConfig'),
    ),
    envelope,
    onReaderActive,
    signer,
    stageObserver,
  })
}

function normalizeNonNegativeInteger(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function normalizePositiveInteger(value) {
  const normalized = normalizeNonNegativeInteger(value)
  return normalized !== null && normalized > 0 ? normalized : null
}

function normalizePositiveDecimal(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value)
  if (
    typeof value === 'string' &&
    /^[1-9][0-9]*$/.test(value) &&
    value.length <= 32
  ) {
    return value
  }
  return null
}

function normalizeRawRow(rawRow) {
  if (!hasExactKeys(rawRow, RAW_ROW_FIELDS)) {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }

  const rowId = normalizePositiveInteger(ownDataValue(rawRow, 'rowId'))
  const payloadVersion = normalizePositiveInteger(
    ownDataValue(rawRow, 'payloadVersion'),
  )
  const payload = ownDataValue(rawRow, 'payload')
  const sessionId = normalizePositiveInteger(
    ownDataValue(rawRow, '__sessionId'),
  )
  const productMajor = normalizePositiveInteger(
    ownDataValue(rawRow, '__productMajor'),
  )
  const databaseId = normalizePositiveInteger(
    ownDataValue(rawRow, '__databaseId'),
  )
  const transactionId = normalizePositiveDecimal(
    ownDataValue(rawRow, '__transactionId'),
  )
  const snapshotEnabledState = normalizeNonNegativeInteger(
    ownDataValue(rawRow, '__snapshotEnabledState'),
  )
  const isolationLevel = normalizePositiveInteger(
    ownDataValue(rawRow, '__isolationLevel'),
  )
  const activeSnapshotCount = normalizeNonNegativeInteger(
    ownDataValue(rawRow, '__activeSnapshotCount'),
  )

  if (
    rowId === null ||
    payloadVersion === null ||
    typeof payload !== 'string' ||
    sessionId === null ||
    (productMajor !== 15 && productMajor !== 16) ||
    databaseId === null ||
    transactionId === null ||
    snapshotEnabledState === null ||
    isolationLevel === null ||
    activeSnapshotCount === null
  ) {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  if (
    snapshotEnabledState !== 1 ||
    isolationLevel !== 5 ||
    activeSnapshotCount !== 1
  ) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }

  return Object.freeze({
    row: Object.freeze({ rowId, payloadVersion, payload }),
    capture: Object.freeze({
      databaseId,
      engineMajorVersion: productMajor === 15 ? '2019' : '2022',
      sessionId,
      transactionId,
    }),
  })
}

function sameCapture(left, right) {
  return (
    left.databaseId === right.databaseId &&
    left.engineMajorVersion === right.engineMajorVersion &&
    left.sessionId === right.sessionId &&
    left.transactionId === right.transactionId
  )
}

async function notify(observer, stage) {
  if (observer === null) return
  try {
    await observer(stage)
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
}

async function safeWrite(handle, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    let result
    try {
      result = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        null,
      )
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    if (
      result === null ||
      typeof result !== 'object' ||
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten < 1 ||
      result.bytesWritten > bytes.length - offset
    ) {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    offset += result.bytesWritten
  }
}

async function safeSyncAndClose(handle) {
  try {
    await handle.sync()
    await handle.close()
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
}

async function openPrivateFile(file) {
  let handle
  try {
    handle = await fsPromises.open(file, 'wx', 0o600)
    await handle.chmod(0o600)
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  return handle
}

function compareUtf16(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function createArtifactWriter(directory, envelope) {
  const artifactPath = path.join(directory, 'artifact.jsonl')
  const runFiles = []
  const chunkPaths = []
  const chunkDescriptors = []
  const wholeHash = crypto.createHash(digests.SEALED_EXPORT_DIGEST_ALGORITHM)
  let artifactHandle = null
  let chunkHandle = null
  let chunkHash = null
  let chunkBytes = 0
  let totalBytes = 0
  let rowCount = 0
  let sortRunIndex = 0
  let sortRunBatch = []
  let sortRunBatchBytes = 0
  let maxSortBufferBytes = 0

  async function open() {
    artifactHandle = await openPrivateFile(artifactPath)
  }

  async function openChunk() {
    if (chunkDescriptors.length + 1 > envelope.chunkBudget) {
      failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', {
        budget: 'CHUNK_BUDGET',
      })
    }
    const chunkIndex = chunkDescriptors.length
    const chunkPath = path.join(
      directory,
      `chunk-${String(chunkIndex).padStart(6, '0')}.bin`,
    )
    chunkHandle = await openPrivateFile(chunkPath)
    chunkHash = crypto.createHash(digests.SEALED_EXPORT_DIGEST_ALGORITHM)
    chunkBytes = 0
    chunkPaths.push(chunkPath)
  }

  async function finalizeChunk() {
    if (chunkHandle === null) return
    const descriptor = Object.freeze({
      chunkIndex: chunkDescriptors.length,
      chunkDigest: chunkHash.digest('hex'),
      byteCount: chunkBytes,
    })
    await safeSyncAndClose(chunkHandle)
    chunkHandle = null
    chunkHash = null
    chunkBytes = 0
    chunkDescriptors.push(contracts.validateChunkDescriptor(descriptor))
  }

  async function writeChunkBytes(bytes) {
    let offset = 0
    while (offset < bytes.length) {
      if (chunkHandle === null) await openChunk()
      const available = SEALED_EXPORT_S2_CHUNK_BYTES - chunkBytes
      const length = Math.min(available, bytes.length - offset)
      const part = bytes.subarray(offset, offset + length)
      await safeWrite(chunkHandle, part)
      chunkHash.update(part)
      chunkBytes += length
      offset += length
      if (chunkBytes === SEALED_EXPORT_S2_CHUNK_BYTES) {
        await finalizeChunk()
      }
    }
  }

  async function flushSortRun() {
    if (sortRunBatch.length === 0) return
    sortRunBatch.sort(compareUtf16)
    const runPath = path.join(
      directory,
      `.sort-run-${String(sortRunIndex).padStart(6, '0')}.jsonl`,
    )
    sortRunIndex += 1
    const bytes = Buffer.from(
      `${sortRunBatch.map((text) => JSON.stringify(text)).join('\n')}\n`,
      'utf8',
    )
    try {
      await fsPromises.writeFile(runPath, bytes, {
        flag: 'wx',
        mode: 0o600,
      })
      await fsPromises.chmod(runPath, 0o600)
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    runFiles.push(runPath)
    sortRunBatch = []
    sortRunBatchBytes = 0
  }

  async function writeRow(row) {
    if (rowCount + 1 > envelope.rowBudget) {
      failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', {
        budget: 'ROW_BUDGET',
      })
    }
    const canonical = canonicalCodec.tryCanonicalJson(row)
    if (!canonical.ok) {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    const rowBytes = Buffer.concat([canonical.bytes, Buffer.from('\n')])
    if (totalBytes + rowBytes.length > envelope.byteBudget) {
      failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', {
        budget: 'BYTE_BUDGET',
      })
    }

    if (
      sortRunBatch.length > 0 &&
      sortRunBatchBytes + canonical.bytes.length >
        SEALED_EXPORT_S2_SORT_RUN_BYTES
    ) {
      await flushSortRun()
    }

    await safeWrite(artifactHandle, rowBytes)
    await writeChunkBytes(rowBytes)
    wholeHash.update(rowBytes)
    totalBytes += rowBytes.length
    rowCount += 1
    sortRunBatch.push(canonical.text)
    sortRunBatchBytes += canonical.bytes.length
    maxSortBufferBytes = Math.max(maxSortBufferBytes, sortRunBatchBytes)
  }

  async function finalize() {
    if (rowCount === 0) {
      failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
    }
    await flushSortRun()
    await finalizeChunk()
    await safeSyncAndClose(artifactHandle)
    artifactHandle = null
    return Object.freeze({
      artifactPath,
      chunkDescriptors: Object.freeze([...chunkDescriptors]),
      chunkPaths: Object.freeze([...chunkPaths]),
      maxSortBufferBytes,
      rowCount,
      runFiles,
      sortRunCount: runFiles.length,
      totalBytes,
      wholeArtifactByteDigest: wholeHash.digest('hex'),
    })
  }

  async function closeOpenHandles() {
    for (const handle of [chunkHandle, artifactHandle]) {
      if (handle === null) continue
      try {
        await handle.close()
      } catch {
        // Best-effort cleanup after a primary refusal.
      }
    }
    chunkHandle = null
    artifactHandle = null
  }

  return Object.freeze({
    closeOpenHandles,
    finalize,
    open,
    writeRow,
  })
}

async function createRunReader(file) {
  let handle
  try {
    handle = await fsPromises.open(file, 'r')
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  return {
    buffer: '',
    decoder: new StringDecoder('utf8'),
    done: false,
    handle,
  }
}

async function readNextRunValue(reader) {
  while (reader.buffer.indexOf('\n') < 0 && !reader.done) {
    const bytes = Buffer.allocUnsafe(64 * 1024)
    let read
    try {
      read = await reader.handle.read(bytes, 0, bytes.length, null)
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    if (read.bytesRead === 0) {
      reader.done = true
      reader.buffer += reader.decoder.end()
      break
    }
    reader.buffer += reader.decoder.write(
      bytes.subarray(0, read.bytesRead),
    )
  }
  const newline = reader.buffer.indexOf('\n')
  if (newline < 0) {
    if (reader.buffer.length === 0) return null
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  const line = reader.buffer.slice(0, newline)
  reader.buffer = reader.buffer.slice(newline + 1)
  let value
  try {
    value = JSON.parse(line)
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  if (typeof value !== 'string') {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  return value
}

async function closeRunReader(reader) {
  try {
    await reader.handle.close()
  } catch {
    // The private run is deleted below; no error value is exposed.
  }
}

async function mergeSortedRunGroup(inputFiles, outputFile) {
  const readers = []
  const current = []
  let outputHandle = null
  try {
    for (const file of inputFiles) {
      readers.push(await createRunReader(file))
    }
    outputHandle = await openPrivateFile(outputFile)
    for (let index = 0; index < readers.length; index += 1) {
      current.push(await readNextRunValue(readers[index]))
    }
    while (true) {
      let selected = -1
      for (let index = 0; index < current.length; index += 1) {
        if (current[index] === null) continue
        if (
          selected === -1 ||
          compareUtf16(current[index], current[selected]) < 0
        ) {
          selected = index
        }
      }
      if (selected === -1) break
      await safeWrite(
        outputHandle,
        Buffer.from(`${JSON.stringify(current[selected])}\n`, 'utf8'),
      )
      current[selected] = await readNextRunValue(readers[selected])
    }
    await safeSyncAndClose(outputHandle)
    outputHandle = null
  } finally {
    if (outputHandle !== null) {
      try {
        await outputHandle.close()
      } catch {
        // Best-effort cleanup after a primary refusal.
      }
    }
    for (const reader of readers) await closeRunReader(reader)
  }
}

async function unlinkPrivateFiles(files) {
  for (const file of files) {
    try {
      await fsPromises.unlink(file)
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
  }
}

async function reduceSortedRuns(directory, initialRuns) {
  let generation = 0
  let runs = [...initialRuns]
  while (runs.length > 1) {
    const next = []
    for (
      let offset = 0;
      offset < runs.length;
      offset += SEALED_EXPORT_S2_SORT_MERGE_FAN_IN
    ) {
      const group = runs.slice(
        offset,
        offset + SEALED_EXPORT_S2_SORT_MERGE_FAN_IN,
      )
      const output = path.join(
        directory,
        `.sort-merge-${String(generation).padStart(4, '0')}-${String(
          next.length,
        ).padStart(6, '0')}.jsonl`,
      )
      await mergeSortedRunGroup(group, output)
      await unlinkPrivateFiles(group)
      next.push(output)
    }
    generation += 1
    runs = next
  }
  return runs[0]
}

async function computeExactRowsetMultiplicityDigest(directory, runFiles) {
  if (!Array.isArray(runFiles) || runFiles.length === 0) {
    failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
  }
  const finalRun = await reduceSortedRuns(directory, runFiles)
  const reader = await createRunReader(finalRun)
  const hash = crypto.createHash(digests.SEALED_EXPORT_DIGEST_ALGORITHM)
  let first = true
  hash.update(Buffer.from('[', 'utf8'))
  try {
    while (true) {
      const value = await readNextRunValue(reader)
      if (value === null) break
      if (!first) hash.update(Buffer.from(',', 'utf8'))
      first = false
      hash.update(Buffer.from(JSON.stringify(value), 'utf8'))
    }
    hash.update(Buffer.from(']', 'utf8'))
  } finally {
    await closeRunReader(reader)
    await unlinkPrivateFiles([finalRun])
  }
  return hash.digest('hex')
}

function deriveCaptureIdentity(capture) {
  const canonical = canonicalCodec.tryCanonicalJson({
    databaseId: capture.databaseId,
    engineMajorVersion: capture.engineMajorVersion,
    sessionId: capture.sessionId,
    transactionId: capture.transactionId,
  })
  if (!canonical.ok) {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  const digest = digests.digestBytes(canonical.bytes)
  if (!digest.ok) {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  return digest.digest
}

function deriveSignerKeyId(signingKey) {
  let publicKey
  let der
  try {
    publicKey = crypto.createPublicKey(signingKey)
    der = publicKey.export({ format: 'der', type: 'spki' })
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const digest = digests.digestBytes(der)
  if (!digest.ok) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return Object.freeze({ keyId: digest.digest, publicKey })
}

function createSqlServerS2FixtureSignerIdentity(rawIdentity) {
  if (!hasExactKeys(rawIdentity, SIGNER_IDENTITY_FIELDS)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const signerState = ownDataValue(rawIdentity, 'signerState')
  if (
    signerState !== 'ACTIVE' &&
    signerState !== 'EXPIRED' &&
    signerState !== 'REVOKED'
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const systemContentKey = ownDataValue(
    rawIdentity,
    'systemContentKey',
  )
  if (
    typeof systemContentKey !== 'string' ||
    systemContentKey.length === 0
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const signingKey = ownDataValue(rawIdentity, 'signingKey')
  if (
    !(signingKey instanceof crypto.KeyObject) ||
    signingKey.type !== 'private' ||
    signingKey.asymmetricKeyType !== 'ed25519'
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const signer = deriveSignerKeyId(signingKey)
  const handle = Object.freeze({})
  FIXTURE_SIGNER_IDENTITIES.set(
    handle,
    Object.freeze({
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      signerState,
      signingKey,
      systemContentKey,
    }),
  )
  return handle
}

function resolveFixtureSignerIdentity(handle, systemContentKey) {
  const signer = FIXTURE_SIGNER_IDENTITIES.get(handle)
  if (!signer || signer.systemContentKey !== systemContentKey) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (signer.signerState === 'EXPIRED') {
    failSealedExport('SEALED_EXPORT_SIGNER_EXPIRED')
  }
  if (signer.signerState === 'REVOKED') {
    failSealedExport('SEALED_EXPORT_SIGNER_REVOKED')
  }
  if (signer.signerState !== 'ACTIVE') {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return signer
}

function buildManifestDraft(input, artifact, capture, rowsetDigest, signerKeyId) {
  const draft = {
    exportRequestEnvelopeDigest:
      contracts.computeExportRequestEnvelopeDigest(input.envelope),
    sourceCaptureIdentity: deriveCaptureIdentity(capture),
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    agentImplementationVersion:
      SEALED_EXPORT_S2_AGENT_IMPLEMENTATION_VERSION,
    agentProtocolVersion: SEALED_EXPORT_S2_AGENT_PROTOCOL_VERSION,
    encodingVersion: SEALED_EXPORT_S2_ENCODING_VERSION,
    canonicalizationVersion:
      canonicalCodec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    sourceSchemaDigest: SEALED_EXPORT_S2_SOURCE_SCHEMA_DIGEST,
    totalRows: artifact.rowCount,
    totalBytes: artifact.totalBytes,
    chunks: artifact.chunkDescriptors,
    wholeArtifactByteDigest: artifact.wholeArtifactByteDigest,
    canonicalRowsetMultiplicityDigest: rowsetDigest,
    captureCompletionTimestamp: new Date().toISOString(),
    manifestExpiry: input.envelope.expiry,
    signerKeyId,
    signatureAlgorithm: SEALED_EXPORT_S2_SIGNATURE_ALGORITHM,
    signature: 'AA==',
  }
  const frozen = canonicalCodec.tryFreezeCanonical(draft)
  if (!frozen.ok) {
    failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
  }
  return frozen.value
}

async function startSourceRead(transaction, recordSourceRead) {
  let request
  let stream
  let completion
  try {
    request = transaction.request()
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.toReadableStream !== 'function' ||
      typeof request.query !== 'function'
    ) {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    stream = request.toReadableStream({ highWaterMark: 1 })
    recordSourceRead()
    const queryResult = request.query(SOURCE_READ_SQL)
    completion = Promise.resolve(queryResult).then(
      () => Object.freeze({ ok: true }),
      () => Object.freeze({ ok: false }),
    )
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  if (
    stream === null ||
    typeof stream !== 'object' ||
    typeof stream[Symbol.asyncIterator] !== 'function' ||
    completion === null ||
    typeof completion !== 'object' ||
    typeof completion.then !== 'function'
  ) {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  return Object.freeze({ completion, stream })
}

async function* guardedSourceRows(stream) {
  try {
    for await (const row of stream) yield row
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
  }
}

async function awaitSourceCompletion(completion) {
  let result
  try {
    result = await completion
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
  }
  if (
    result === null ||
    typeof result !== 'object' ||
    result.ok !== true
  ) {
    failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
  }
}

async function assertSnapshotCapability(pool) {
  let result
  try {
    const request = pool.request()
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.query !== 'function'
    ) {
      failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
    }
    result = await request.query(SNAPSHOT_CAPABILITY_SQL)
  } catch {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }

  const recordset =
    result !== null && typeof result === 'object' ? result.recordset : null
  if (!Array.isArray(recordset) || recordset.length !== 1) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
  const row = recordset[0]
  if (
    !hasExactKeys(row, ['snapshotEnabledState']) ||
    normalizeNonNegativeInteger(
      ownDataValue(row, 'snapshotEnabledState'),
    ) !== 1
  ) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
}

async function executeSqlServerS2Producer(rawInput) {
  const input = normalizeInput(rawInput)

  let directory = null
  let pool = null
  let transaction = null
  let transactionBegun = false
  let committed = false
  let writer = null
  let success = false

  try {
    try {
      directory = await fsPromises.mkdtemp(
        path.join(input.artifactRoot, 'sealed-export-s2-'),
      )
      await fsPromises.chmod(directory, 0o700)
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }

    writer = createArtifactWriter(directory, input.envelope)
    await writer.open()

    let sql
    try {
      sql = require('mssql')
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    if (
      typeof sql.ConnectionPool !== 'function' ||
      typeof sql.Transaction !== 'function' ||
      !isStrictObject(sql.ISOLATION_LEVEL) ||
      !Number.isSafeInteger(sql.ISOLATION_LEVEL.SNAPSHOT)
    ) {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }

    try {
      pool = new sql.ConnectionPool(input.connectionConfig)
      await pool.connect()
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }

    await assertSnapshotCapability(pool)

    try {
      transaction = new sql.Transaction(pool)
      await transaction.begin(sql.ISOLATION_LEVEL.SNAPSHOT)
      transactionBegun = true
    } catch {
      failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
    }

    let sourceReadCount = 0
    const sourceRead = await startSourceRead(transaction, () => {
      sourceReadCount += 1
    })
    let capture = null
    let readerActiveNotified = false

    for await (const rawRow of guardedSourceRows(sourceRead.stream)) {
      const normalized = normalizeRawRow(rawRow)
      if (capture === null) {
        capture = normalized.capture
      } else if (!sameCapture(capture, normalized.capture)) {
        failSealedExport('SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH')
      }
      await writer.writeRow(normalized.row)
      if (!readerActiveNotified) {
        readerActiveNotified = true
        await notify(input.onReaderActive, 'READER_ACTIVE')
      }
    }
    await awaitSourceCompletion(sourceRead.completion)
    if (sourceReadCount !== 1) {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    await notify(input.stageObserver, 'READER_EXHAUSTED')

    if (capture === null) {
      failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
    }

    try {
      await transaction.commit()
      committed = true
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    await notify(input.stageObserver, 'SOURCE_COMMITTED')

    const artifact = await writer.finalize()
    await notify(input.stageObserver, 'ARTIFACT_FINALIZED')

    try {
      await pool.close()
      pool = null
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }

    const rowsetDigest = await computeExactRowsetMultiplicityDigest(
      directory,
      artifact.runFiles,
    )
    const draft = buildManifestDraft(
      input,
      artifact,
      capture,
      rowsetDigest,
      input.signer.keyId,
    )
    const unsigned = contracts.unsignedManifestPayload(draft)
    const frozenUnsigned = canonicalCodec.tryFreezeCanonical(unsigned)
    if (!frozenUnsigned.ok) {
      failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
    }
    const canonicalUnsigned = canonicalCodec.tryCanonicalJson(
      frozenUnsigned.value,
    )
    if (!canonicalUnsigned.ok) {
      failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
    }
    await notify(input.stageObserver, 'MANIFEST_FROZEN')

    let signatureBytes
    try {
      signatureBytes = crypto.sign(
        null,
        canonicalUnsigned.bytes,
        input.signer.signingKey,
      )
    } catch {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    await notify(input.stageObserver, 'MANIFEST_SIGNED')

    const manifest = contracts.validateSignedManifest({
      ...draft,
      signature: signatureBytes.toString('base64'),
    })
    contracts.verifyManifestBinding(input.envelope, manifest)
    contracts.resolveSourceTimeConsistencyProof(true, manifest)

    let signatureVerified
    try {
      signatureVerified = crypto.verify(
        null,
        contracts.computeSignedManifestBytes(manifest),
        input.signer.publicKey,
        signatureBytes,
      )
    } catch {
      signatureVerified = false
    }
    if (!signatureVerified) {
      failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
    }

    const manifestDigest = contracts.computeManifestDigest(manifest)
    const evidence = Object.freeze({
      actionToken: 'SEALED_EXPORT_SQLSERVER_FIXTURE',
      artifactFinalized: true,
      byteCount: artifact.totalBytes,
      chunkCount: artifact.chunkDescriptors.length,
      customerSourceUsed: false,
      engineMajorVersion: capture.engineMajorVersion,
      evidenceSchemaVersion: 1,
      externalWrite: false,
      manifestFrozen: true,
      outcome: 'SEALED_EXPORT_S2_PRODUCER_FEASIBILITY_PROVEN',
      proofClassToken: 'SOURCE_SNAPSHOT_TXN',
      readerExhausted: true,
      rowCount: artifact.rowCount,
      runtimeReachable: false,
      signatureVerified: true,
      sourceReadCount,
    })

    success = true
    return Object.freeze({
      actionId: SEALED_EXPORT_S2_ACTION_ID,
      artifact: Object.freeze({
        artifactPath: artifact.artifactPath,
        chunkPaths: artifact.chunkPaths,
        directory,
      }),
      diagnostics: Object.freeze({
        maxSortBufferBytes: artifact.maxSortBufferBytes,
        sortRunCount: artifact.sortRunCount,
      }),
      evidence,
      manifest,
      manifestDigest,
    })
  } finally {
    if (writer !== null) await writer.closeOpenHandles()
    if (transaction !== null && transactionBegun && !committed) {
      try {
        await transaction.rollback()
      } catch {
        // Cleanup is best-effort after a primary refusal.
      }
    }
    if (pool !== null) {
      try {
        await pool.close()
      } catch {
        // Cleanup is best-effort after a primary refusal.
      }
    }
    if (!success && directory !== null) {
      try {
        await fsPromises.rm(directory, { force: true, recursive: true })
      } catch {
        // Private cleanup failure cannot expose source values.
      }
    }
  }
}

module.exports = Object.freeze({
  SEALED_EXPORT_S2_ACTION_ID,
  SEALED_EXPORT_S2_AGENT_IMPLEMENTATION_VERSION,
  SEALED_EXPORT_S2_AGENT_PROTOCOL_VERSION,
  SEALED_EXPORT_S2_CHUNK_BYTES,
  SEALED_EXPORT_S2_ENCODING_VERSION,
  SEALED_EXPORT_S2_FIXTURE_TABLE,
  SEALED_EXPORT_S2_QUERY_BINDING_DIGEST,
  SEALED_EXPORT_S2_SIGNATURE_ALGORITHM,
  SEALED_EXPORT_S2_SORT_RUN_BYTES,
  SEALED_EXPORT_S2_SOURCE_SCHEMA_DIGEST,
  createSqlServerS2FixtureSignerIdentity,
  executeSqlServerS2Producer,
})
