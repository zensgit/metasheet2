'use strict'

// Sealed-export S5 — internal composition core for
// sqlserver.sealed_snapshot.v1 (issue #4690).
//
// LATENT: no route, scheduler, runtime consumer, flag, or deployment wiring.
//
// Trust model:
//   - The public product wrapper is the only MSSQL-certified composition path.
//   - This core is also used by explicit test-support composition.
//   - Construction binds approved bindings, qualification keyring, capture
//     factory, artifact root, and signer material into the service closure.
//   - execute() accepts ONLY the server-issued envelope.
//   - captureCompletionTimestamp and signer lifecycle use a first-party clock
//     after reader exhaustion and artifact finalization.
//   - No public harness mints objects that isTrusted* would accept: there are
//     no isTrusted* gates on caller-supplied objects at all.
//
// Distinct from S2 fixture action sealed-export.sqlserver.fixture.v1.

const crypto = require('node:crypto')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')

const canonicalCodec = require('./canonical-json.cjs')
const contracts = require('./contracts.cjs')
const digests = require('./digests.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  probeQualificationWithKey,
  verifyQualificationWithKey,
} = require('./sealed-export-binding-qualification.cjs')
const {
  isMssqlSnapshotCaptureContext,
} = require('./sqlserver-sealed-snapshot-source-session.cjs')
const {
  SIGNATURE_ALGORITHM,
  deriveSignerKeyId,
  normalizePrivateKey,
  decodeCanonicalSignature,
} = require('./sealed-export-signer-authority.cjs')
const {
  createSignerAuthorityStore,
} = require('./sealed-export-signer-authority-store.cjs')
const {
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  SEALED_EXPORT_S5_CHUNK_BYTES,
  SEALED_EXPORT_S5_SORT_RUN_BYTES,
  SEALED_EXPORT_S5_SORT_MERGE_FAN_IN,
  SEALED_EXPORT_S5_AGENT_PROTOCOL_VERSION,
  SEALED_EXPORT_S5_ENCODING_VERSION,
  CAPTURE_METADATA_SQL,
  computeQueryBindingDigest,
  resolveCertifiedRelation,
  assertSafeSqlServerRelation,
} = require('./sqlserver-sealed-snapshot-action.cjs')
const {
  successfulSealedSnapshotCompletenessEvidence,
} = require('./sqlserver-sealed-snapshot-profile.cjs')
const {
  SEALED_EXPORT_S2_ACTION_ID,
} = require('./sqlserver-s2-producer.cjs')

const EXECUTE_INPUT_FIELDS = Object.freeze(['envelope'])

const FORBIDDEN_EXECUTE_KEYS = Object.freeze([
  'resolution',
  'sourceSession',
  'signerAuthority',
  'signerKeyId',
  'qualification',
  'qualificationEnvelopeKey',
  'envelopeKey',
  'nowMs',
  'clock',
  'artifactRoot',
  'onReaderActive',
  'stageObserver',
  'sql',
  'query',
  'table',
  'object',
  'column',
  'filter',
  'mapping',
  'credentials',
  'connection',
  'connectionConfig',
  'privateKey',
  'signingKey',
  'publicKey',
])

const APPROVED_BINDING_FIELDS = Object.freeze([
  'approvedConfigVersionId',
  'bindingVersion',
  'canonicalObjectVersion',
  'configContentKey',
  'objectKey',
  'relationId',
  'roleBindingFingerprint',
  'tableRef',
  'tenantDomainBinding',
])

const RAW_ROW_FIELDS = Object.freeze([
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

const QUALIFICATION_TTL_MS = 5 * 60 * 1000

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
  const expected = [...expectedKeys].sort()
  return !(
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  )
}

function isIdentityToken(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function normalizeNonNegativeInteger(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
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

function engineMajorVersionFromProductMajor(productMajor) {
  if (productMajor === 15) return '2019'
  if (productMajor === 16) return '2022'
  return null
}

function normalizeApprovedBinding(raw, systemContentKey) {
  if (!hasExactKeys(raw, APPROVED_BINDING_FIELDS)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const objectKey = ownDataValue(raw, 'objectKey')
  const relationId = ownDataValue(raw, 'relationId')
  const tableRef = assertSafeSqlServerRelation(ownDataValue(raw, 'tableRef'))
  const canonicalObjectVersion = ownDataValue(raw, 'canonicalObjectVersion')
  const configContentKey = ownDataValue(raw, 'configContentKey')
  const approvedConfigVersionId = ownDataValue(
    raw,
    'approvedConfigVersionId',
  )
  const bindingVersion = ownDataValue(raw, 'bindingVersion')
  const roleBindingFingerprint = ownDataValue(
    raw,
    'roleBindingFingerprint',
  )
  const tenantDomainBinding = ownDataValue(raw, 'tenantDomainBinding')
  if (
    !isIdentityToken(objectKey) ||
    !isIdentityToken(relationId) ||
    !isIdentityToken(canonicalObjectVersion) ||
    !isIdentityToken(configContentKey) ||
    !isIdentityToken(approvedConfigVersionId) ||
    !isIdentityToken(bindingVersion) ||
    !isIdentityToken(roleBindingFingerprint) ||
    !isIdentityToken(tenantDomainBinding)
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const relation = resolveCertifiedRelation(relationId)
  const queryObjectFilterBindingDigest = computeQueryBindingDigest({
    objectKey,
    relationId,
    tableRef,
  })
  return Object.freeze({
    actionProfileVersion: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
    approvedConfigVersionId,
    bindingVersion,
    canonicalObjectVersion,
    configContentKey,
    expectedSourceSchemaFieldMapDigest: relation.sourceSchemaDigest,
    objectKey,
    orderingKeyField: relation.orderingKeyField,
    orderingKeyProbeSql: relation.buildOrderingKeyUniquenessProbeSql(tableRef),
    queryObjectFilterBindingDigest,
    relationId,
    roleBindingFingerprint,
    sourceReadSql: relation.buildSourceReadSql(tableRef),
    systemContentKey,
    tableRef,
    tenantDomainBinding,
  })
}

// Private material is closure-owned. Every sign and verify operation re-reads
// the complete 069 authority row and joins it with 070 public material.
function buildLiveSignerAuthority({ authorityStore, privateSignerMaterials }) {
  if (
    !authorityStore ||
    typeof authorityStore.resolveAuthority !== 'function' ||
    !Array.isArray(privateSignerMaterials) ||
    privateSignerMaterials.length === 0
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const privateKeys = new Map()
  for (let index = 0; index < privateSignerMaterials.length; index += 1) {
    const entry = privateSignerMaterials[index]
    const hasSignerKeyId =
      isStrictObject(entry) &&
      Object.prototype.hasOwnProperty.call(entry, 'signerKeyId')
    if (
      !hasExactKeys(
        entry,
        hasSignerKeyId ? ['privateKey', 'signerKeyId'] : ['privateKey'],
      )
    ) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    const privateKey = normalizePrivateKey(ownDataValue(entry, 'privateKey'))
    let publicKey
    try {
      publicKey = crypto.createPublicKey(privateKey)
    } catch {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    const signerKeyId = deriveSignerKeyId(publicKey)
    if (hasSignerKeyId) {
      const declaredSignerKeyId = ownDataValue(entry, 'signerKeyId')
      if (
        typeof declaredSignerKeyId !== 'string' ||
        declaredSignerKeyId !== signerKeyId
      ) {
        failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
      }
    }
    if (privateKeys.has(signerKeyId)) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    privateKeys.set(signerKeyId, privateKey)
  }

  return Object.freeze({
    async resolve(scope, qualificationDigest) {
      return authorityStore.resolveAuthority(scope, qualificationDigest)
    },
    async signUnsignedManifestBytes(
      scope,
      qualificationDigest,
      unsignedManifestBytes,
    ) {
      const authority = await authorityStore.resolveAuthority(
        scope,
        qualificationDigest,
      )
      const privateKey = privateKeys.get(authority.signerKeyId)
      if (!privateKey) {
        failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
      }
      if (
        !(unsignedManifestBytes instanceof Uint8Array) ||
        unsignedManifestBytes.length === 0
      ) {
        failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
      }
      let signatureBytes
      try {
        signatureBytes = crypto.sign(null, unsignedManifestBytes, privateKey)
      } catch {
        failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
      }
      return Object.freeze({
        signature: signatureBytes.toString('base64'),
        signatureAlgorithm: SIGNATURE_ALGORITHM,
        signerKeyId: authority.signerKeyId,
      })
    },
    async verifyManifest(scope, qualificationDigest, manifest) {
      if (!manifest || manifest.signatureAlgorithm !== SIGNATURE_ALGORITHM) {
        failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
      }
      const authority = await authorityStore.resolveAuthority(
        scope,
        qualificationDigest,
      )
      if (manifest.signerKeyId !== authority.signerKeyId) {
        failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
      }
      const signature = decodeCanonicalSignature(manifest.signature)
      let valid = false
      try {
        valid = crypto.verify(
          null,
          contracts.computeSignedManifestBytes(manifest),
          authority.publicKey,
          signature,
        )
      } catch {
        valid = false
      }
      if (!valid) failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
      return Object.freeze({
        lifecycleChecked: true,
        lifecycleSource: 'integration_sealed_export_authority_state',
        scopeBound: true,
        signatureAlgorithm: SIGNATURE_ALGORITHM,
        signatureVerified: true,
        signerKeyId: authority.signerKeyId,
        status: 'ACTIVE',
        systemContentKey: authority.systemContentKey,
        tenantDomainBinding: authority.tenantDomainBinding,
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
      })
    },
  })
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
  const sessionId = normalizePositiveInteger(ownDataValue(rawRow, '__sessionId'))
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
  const engineMajorVersion = engineMajorVersionFromProductMajor(productMajor)
  if (
    rowId === null ||
    payloadVersion === null ||
    typeof payload !== 'string' ||
    sessionId === null ||
    engineMajorVersion === null ||
    databaseId === null ||
    transactionId === null ||
    snapshotEnabledState === null ||
    isolationLevel === null
  ) {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  if (
    snapshotEnabledState !== 1 ||
    isolationLevel !== 5
  ) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
  return Object.freeze({
    row: Object.freeze({ rowId, payloadVersion, payload }),
    capture: Object.freeze({
      databaseId,
      engineMajorVersion,
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
      result = await handle.write(bytes, offset, bytes.length - offset, null)
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
  let finalized = false

  async function open() {
    artifactHandle = await openPrivateFile(artifactPath)
  }

  async function openChunk() {
    if (chunkDescriptors.length + 1 > envelope.chunkBudget) {
      failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', { budget: 'CHUNK_BUDGET' })
    }
    const chunkPath = path.join(
      directory,
      `chunk-${String(chunkDescriptors.length).padStart(6, '0')}.bin`,
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
      const available = SEALED_EXPORT_S5_CHUNK_BYTES - chunkBytes
      const length = Math.min(available, bytes.length - offset)
      const part = bytes.subarray(offset, offset + length)
      await safeWrite(chunkHandle, part)
      chunkHash.update(part)
      chunkBytes += length
      offset += length
      if (chunkBytes === SEALED_EXPORT_S5_CHUNK_BYTES) await finalizeChunk()
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
      await fsPromises.writeFile(runPath, bytes, { flag: 'wx', mode: 0o600 })
      await fsPromises.chmod(runPath, 0o600)
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    runFiles.push(runPath)
    sortRunBatch = []
    sortRunBatchBytes = 0
  }

  async function writeRow(row) {
    if (finalized) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    if (rowCount + 1 > envelope.rowBudget) {
      failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', { budget: 'ROW_BUDGET' })
    }
    const canonical = canonicalCodec.tryCanonicalJson(row)
    if (!canonical.ok) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    const rowBytes = Buffer.concat([canonical.bytes, Buffer.from('\n')])
    if (totalBytes + rowBytes.length > envelope.byteBudget) {
      failSealedExport('SEALED_EXPORT_BUDGET_EXCEEDED', { budget: 'BYTE_BUDGET' })
    }
    if (
      sortRunBatch.length > 0 &&
      sortRunBatchBytes + canonical.bytes.length > SEALED_EXPORT_S5_SORT_RUN_BYTES
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
    await flushSortRun()
    // S4's persisted generation contract requires positive row/byte counts.
    // Refuse before signing rather than minting an artifact S4 cannot ingest.
    if (rowCount === 0 || totalBytes === 0) {
      failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
    }
    await finalizeChunk()
    await safeSyncAndClose(artifactHandle)
    artifactHandle = null
    finalized = true
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
        // best-effort
      }
    }
    chunkHandle = null
    artifactHandle = null
  }

  return Object.freeze({ closeOpenHandles, finalize, open, writeRow })
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
    reader.buffer += reader.decoder.write(bytes.subarray(0, read.bytesRead))
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
  if (typeof value !== 'string') failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  return value
}

async function closeRunReader(reader) {
  try {
    await reader.handle.close()
  } catch {
    // private
  }
}

async function mergeSortedRunGroup(inputFiles, outputFile) {
  const readers = []
  const current = []
  let outputHandle = null
  try {
    for (const file of inputFiles) readers.push(await createRunReader(file))
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
        // best-effort
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
      offset += SEALED_EXPORT_S5_SORT_MERGE_FAN_IN
    ) {
      const group = runs.slice(offset, offset + SEALED_EXPORT_S5_SORT_MERGE_FAN_IN)
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
  if (!Array.isArray(runFiles)) {
    failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
  }
  if (runFiles.length === 0) {
    // Canonical empty array multiplicity digest.
    return crypto
      .createHash(digests.SEALED_EXPORT_DIGEST_ALGORITHM)
      .update(Buffer.from('[]', 'utf8'))
      .digest('hex')
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
  if (!canonical.ok) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  const digest = digests.digestBytes(canonical.bytes)
  if (!digest.ok) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  return digest.digest
}

function deriveImmutableSnapshotToken(manifestDigest, captureIdentity) {
  const canonical = canonicalCodec.tryCanonicalJson({
    captureIdentity,
    kind: 'IMMUTABLE_SNAPSHOT_TOKEN',
    manifestDigest,
    profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  })
  if (!canonical.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  const digest = digests.digestBytes(canonical.bytes)
  if (!digest.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return digest.digest
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
  if (result === null || typeof result !== 'object' || result.ok !== true) {
    failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
  }
}

function normalizeExecuteInput(rawInput) {
  if (!isStrictObject(rawInput)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  for (const key of Object.keys(rawInput)) {
    if (FORBIDDEN_EXECUTE_KEYS.includes(key)) {
      failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
    }
  }
  let symbols
  try {
    symbols = Object.getOwnPropertySymbols(rawInput)
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (symbols.length > 0) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  if (!hasExactKeys(rawInput, EXECUTE_INPUT_FIELDS)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const envelope = contracts.validateExportRequestEnvelope(
    ownDataValue(rawInput, 'envelope'),
  )
  return Object.freeze({ envelope })
}

function firstPartyClockMs() {
  return Date.now()
}

function toUtcSecondsIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function normalizeProbeCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function normalizeCaptureMetadataRow(row) {
  if (!isStrictObject(row)) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  const sessionId = normalizePositiveInteger(row.__sessionId)
  const productMajor = normalizePositiveInteger(row.__productMajor)
  const databaseId = normalizePositiveInteger(row.__databaseId)
  const transactionId = normalizePositiveDecimal(row.__transactionId)
  const snapshotEnabledState = normalizeNonNegativeInteger(
    row.__snapshotEnabledState,
  )
  const isolationLevel = normalizePositiveInteger(row.__isolationLevel)
  const engineMajorVersion = engineMajorVersionFromProductMajor(productMajor)
  if (
    sessionId === null ||
    engineMajorVersion === null ||
    databaseId === null ||
    transactionId === null ||
    snapshotEnabledState !== 1 ||
    isolationLevel !== 5
  ) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
  return Object.freeze({
    databaseId,
    engineMajorVersion,
    sessionId,
    transactionId,
  })
}

function createSqlServerSealedSnapshotServiceCore(rawConfig) {
  if (!isStrictObject(rawConfig)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const tenantId = rawConfig.tenantId
  const systemContentKey = rawConfig.systemContentKey
  const workspaceId =
    rawConfig.workspaceId === undefined ? null : rawConfig.workspaceId
  if (!isIdentityToken(tenantId) || !isIdentityToken(systemContentKey)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (workspaceId !== null && !isIdentityToken(workspaceId)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const artifactRoot = rawConfig.artifactRoot
  if (
    typeof artifactRoot !== 'string' ||
    artifactRoot.length === 0 ||
    artifactRoot.indexOf('\0') >= 0 ||
    !path.isAbsolute(artifactRoot)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const onReaderActive =
    rawConfig.onReaderActive === undefined ? null : rawConfig.onReaderActive
  const stageObserver =
    rawConfig.stageObserver === undefined ? null : rawConfig.stageObserver
  if (
    (onReaderActive !== null && typeof onReaderActive !== 'function') ||
    (stageObserver !== null && typeof stageObserver !== 'function')
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  // Qualification keyring is construction-owned. Never accepted on execute().
  const qualificationKeyring = rawConfig.qualificationKeyring
  if (!isStrictObject(qualificationKeyring)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const ownedKeyringSecret = (() => {
    const secret = qualificationKeyring.secret
    const bytes = Buffer.isBuffer(secret)
      ? Buffer.from(secret)
      : secret instanceof Uint8Array
        ? Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
        : null
    if (
      typeof qualificationKeyring.keyId !== 'string' ||
      qualificationKeyring.keyId.length === 0 ||
      bytes === null ||
      bytes.length < 32
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    return Object.freeze({
      keyId: qualificationKeyring.keyId,
      secret: bytes,
    })
  })()

  if (!Array.isArray(rawConfig.approvedBindings) || rawConfig.approvedBindings.length === 0) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const bindingsByObjectKey = new Map()
  const bindingObjectKeysByRoleFingerprint = new Map()
  for (let index = 0; index < rawConfig.approvedBindings.length; index += 1) {
    const binding = normalizeApprovedBinding(
      rawConfig.approvedBindings[index],
      systemContentKey,
    )
    if (
      bindingsByObjectKey.has(binding.objectKey) ||
      bindingObjectKeysByRoleFingerprint.has(binding.roleBindingFingerprint)
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    bindingsByObjectKey.set(binding.objectKey, binding)
    bindingObjectKeysByRoleFingerprint.set(
      binding.roleBindingFingerprint,
      binding.objectKey,
    )
  }

  const authorityStore = createSignerAuthorityStore({
    db: rawConfig.authorityDb,
    clock: firstPartyClockMs,
  })
  const signer = buildLiveSignerAuthority({
    authorityStore,
    privateSignerMaterials: rawConfig.privateSignerMaterials,
  })

  const openCaptureContext = rawConfig.openCaptureContext
  if (typeof openCaptureContext !== 'function') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  function resolveBindingForEnvelope(envelope) {
    if (envelope.actionProfileVersion !== SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID) {
      failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
    }
    if (envelope.systemContentKey !== systemContentKey) {
      failSealedExport('SEALED_EXPORT_MANIFEST_BINDING_MISMATCH', {
        field: 'systemContentKey',
      })
    }
    // Locate the unique approved binding matching config + canonical version.
    let matched = null
    for (const binding of bindingsByObjectKey.values()) {
      if (
        binding.approvedConfigVersionId ===
          envelope.approvedConfigVersionId &&
        binding.bindingVersion === envelope.bindingVersion &&
        binding.configContentKey === envelope.configContentKey &&
        binding.canonicalObjectVersion === envelope.canonicalObjectVersion &&
        binding.roleBindingFingerprint ===
          envelope.roleBindingFingerprint &&
        binding.tenantDomainBinding === envelope.tenantDomainBinding &&
        digests.constantTimeEqualDigest(
          binding.queryObjectFilterBindingDigest,
          envelope.queryObjectFilterBindingDigest,
        ) &&
        digests.constantTimeEqualDigest(
          binding.expectedSourceSchemaFieldMapDigest,
          envelope.expectedSourceSchemaFieldMapDigest,
        )
      ) {
        if (matched !== null) {
          failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
        }
        matched = binding
      }
    }
    if (matched === null) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    return matched
  }

  function authorityScopeFor(binding) {
    return Object.freeze({
      roleBindingFingerprint: binding.roleBindingFingerprint,
      systemContentKey,
      tenantDomainBinding: binding.tenantDomainBinding,
      tenantId,
      workspaceId,
    })
  }

  async function proveOrderingKey(captureContext, binding) {
    const probeRow = await captureContext.queryProbe(binding.orderingKeyProbeSql)
    const nullKeyRows = normalizeProbeCount(probeRow.nullKeyRows)
    const duplicateKeyGroups = normalizeProbeCount(probeRow.duplicateKeyGroups)
    const sourceRowCount = normalizeProbeCount(probeRow.sourceRowCount)
    if (
      nullKeyRows === null ||
      duplicateKeyGroups === null ||
      sourceRowCount === null ||
      nullKeyRows !== 0 ||
      duplicateKeyGroups !== 0
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    return Object.freeze({
      orderingKeyProof: Object.freeze({
        duplicateKeyGroups: 0,
        fieldId: binding.orderingKeyField,
        kind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
        nullKeyRows: 0,
        proven: true,
      }),
      sourceRowCount,
    })
  }

  function assertLiveQualificationMatchesBinding({
    authority,
    binding,
    orderingKeyProof,
    qualificationDigest,
  }) {
    const expiresAtMs = Date.parse(authority.qualificationExpiresAt)
    if (!Number.isFinite(expiresAtMs)) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    const expected = probeQualificationWithKey({
      binding: Object.freeze({ ...binding, orderingKeyProof }),
      envelopeKey: ownedKeyringSecret,
      expiresAt: toUtcSecondsIso(expiresAtMs),
      probedAt: toUtcSecondsIso(expiresAtMs - QUALIFICATION_TTL_MS),
    })
    if (
      !digests.constantTimeEqualDigest(
        expected.qualificationDigest,
        qualificationDigest,
      )
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
  }

  async function execute(rawInput) {
    const input = normalizeExecuteInput(rawInput)
    const binding = resolveBindingForEnvelope(input.envelope)

    let directory = null
    let captureContext = null
    let writer = null
    let success = false
    let readerExhausted = false
    let artifactFinalized = false
    let manifestFrozen = false

    try {
      try {
        directory = await fsPromises.mkdtemp(
          path.join(artifactRoot, 'sealed-export-s5-'),
        )
        await fsPromises.chmod(directory, 0o700)
      } catch {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }

      writer = createArtifactWriter(directory, input.envelope)
      await writer.open()

      captureContext = await openCaptureContext(binding)
      const productCaptureContext =
        isMssqlSnapshotCaptureContext(captureContext)

      // Ordering-key qualification against the actual enrolled relation mapping.
      const { orderingKeyProof, sourceRowCount } = await proveOrderingKey(
        captureContext,
        binding,
      )
      // Re-prove total order, then consult the complete live 069 authority row
      // and bind its qualification digest back to this exact approved binding
      // before any source data is read.
      const authorityScope = authorityScopeFor(binding)
      const liveAuthority = await signer.resolve(
        authorityScope,
        input.envelope.qualificationDigest,
      )
      assertLiveQualificationMatchesBinding({
        authority: liveAuthority,
        binding,
        orderingKeyProof,
        qualificationDigest: input.envelope.qualificationDigest,
      })

      // Metadata in the same snapshot transaction (supports empty objects).
      const metadataRow = await captureContext.queryMetadata(CAPTURE_METADATA_SQL)
      let capture = normalizeCaptureMetadataRow(metadataRow)

      // First-party SQL from the approved binding's certified relation — never
      // from execute input.
      const sourceRead = await captureContext.startSourceRead(
        binding.sourceReadSql,
      )
      let readerActiveNotified = false
      let capturedRowCount = 0
      let previousRowId = 0

      for await (const rawRow of guardedSourceRows(sourceRead.stream)) {
        const normalized = normalizeRawRow(rawRow)
        if (!sameCapture(capture, normalized.capture)) {
          failSealedExport('SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH')
        }
        if (normalized.row.rowId <= previousRowId) {
          failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
        }
        previousRowId = normalized.row.rowId
        await writer.writeRow(normalized.row)
        capturedRowCount += 1
        if (!readerActiveNotified) {
          readerActiveNotified = true
          await notify(onReaderActive, 'READER_ACTIVE')
        }
      }
      await awaitSourceCompletion(sourceRead.completion)
      if (captureContext.getSourceReadCount() !== 1) {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
      if (capturedRowCount !== sourceRowCount) {
        failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
      }
      readerExhausted = true
      await notify(stageObserver, 'READER_EXHAUSTED')

      await captureContext.commit()
      await notify(stageObserver, 'SOURCE_COMMITTED')

      const artifact = await writer.finalize()
      artifactFinalized = true
      await notify(stageObserver, 'ARTIFACT_FINALIZED')

      await captureContext.close()
      captureContext = null

      const rowsetDigest = await computeExactRowsetMultiplicityDigest(
        directory,
        artifact.runFiles,
      )

      // First-party clock only after reader exhaustion + artifact finalization.
      const clockMs = firstPartyClockMs()
      const signingAuthority = await signer.resolve(
        authorityScope,
        input.envelope.qualificationDigest,
      )
      const signerKeyId = signingAuthority.signerKeyId

      const draft = {
        exportRequestEnvelopeDigest:
          contracts.computeExportRequestEnvelopeDigest(input.envelope),
        sourceCaptureIdentity: deriveCaptureIdentity(capture),
        sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
        agentImplementationVersion:
          SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
        agentProtocolVersion: SEALED_EXPORT_S5_AGENT_PROTOCOL_VERSION,
        encodingVersion: SEALED_EXPORT_S5_ENCODING_VERSION,
        canonicalizationVersion:
          canonicalCodec.SEALED_EXPORT_CANONICALIZATION_VERSION,
        sourceSchemaDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
        totalRows: artifact.rowCount,
        totalBytes: artifact.totalBytes,
        chunks: artifact.chunkDescriptors,
        wholeArtifactByteDigest: artifact.wholeArtifactByteDigest,
        canonicalRowsetMultiplicityDigest: rowsetDigest,
        captureCompletionTimestamp: new Date(clockMs).toISOString(),
        manifestExpiry: input.envelope.expiry,
        signerKeyId,
        signatureAlgorithm: SIGNATURE_ALGORITHM,
        signature: 'AA==',
      }
      const frozenDraft = canonicalCodec.tryFreezeCanonical(draft)
      if (!frozenDraft.ok) failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
      const unsigned = contracts.unsignedManifestPayload(frozenDraft.value)
      const frozenUnsigned = canonicalCodec.tryFreezeCanonical(unsigned)
      if (!frozenUnsigned.ok) failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
      const canonicalUnsigned = canonicalCodec.tryCanonicalJson(
        frozenUnsigned.value,
      )
      if (!canonicalUnsigned.ok) failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
      manifestFrozen = true
      await notify(stageObserver, 'MANIFEST_FROZEN')

      if (!readerExhausted || !artifactFinalized || !manifestFrozen) {
        failSealedExport('SEALED_EXPORT_CAPTURE_INCOMPLETE')
      }

      const signed = await signer.signUnsignedManifestBytes(
        authorityScope,
        input.envelope.qualificationDigest,
        canonicalUnsigned.bytes,
      )
      await notify(stageObserver, 'MANIFEST_SIGNED')

      const manifest = contracts.validateSignedManifest({
        ...frozenDraft.value,
        signature: signed.signature,
        signatureAlgorithm: signed.signatureAlgorithm,
        signerKeyId: signed.signerKeyId,
      })
      contracts.verifyManifestBinding(input.envelope, manifest)
      contracts.resolveSourceTimeConsistencyProof(true, manifest)
      await signer.verifyManifest(
        authorityScope,
        input.envelope.qualificationDigest,
        manifest,
      )

      const manifestDigest = contracts.computeManifestDigest(manifest)
      const immutableSnapshotToken = deriveImmutableSnapshotToken(
        manifestDigest,
        manifest.sourceCaptureIdentity,
      )
      const completeness = successfulSealedSnapshotCompletenessEvidence()

      const evidence = Object.freeze({
        actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
        actionToken: productCaptureContext
          ? 'SEALED_EXPORT_SQLSERVER_PRODUCT'
          : 'SEALED_EXPORT_SQLSERVER_HERMETIC_TEST_ONLY',
        artifactFinalized: true,
        byteCount: artifact.totalBytes,
        chunkCount: artifact.chunkDescriptors.length,
        customerSourceUsed: false,
        engineMajorVersion: capture.engineMajorVersion,
        evidenceSchemaVersion: 1,
        externalWrite: false,
        implementationVersion: SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
        immutableSnapshotTokenPresent: true,
        manifestFrozen: true,
        objectKey: binding.objectKey,
        outcome: productCaptureContext
          ? 'SEALED_EXPORT_S5_PRODUCT_ACTION_CERTIFIED'
          : 'SEALED_EXPORT_S5_HERMETIC_CAPTURE_ONLY',
        profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
        proofClassToken: productCaptureContext
          ? 'SOURCE_SNAPSHOT_TXN'
          : 'HERMETIC_TEST_CAPTURE_ONLY',
        readerExhausted: true,
        relationId: binding.relationId,
        rowCount: artifact.rowCount,
        runtimeReachable: false,
        signatureVerified: true,
        dataStreamReadCount: 1,
        orderingProbeReadCount: 1,
        usedCompletenessProofs: completeness.usedCompletenessProofs,
      })

      success = true
      return Object.freeze({
        actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
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
        immutableSnapshotToken,
        manifest,
        manifestDigest,
      })
    } finally {
      if (writer !== null) await writer.closeOpenHandles()
      if (captureContext !== null) {
        try {
          await captureContext.rollback()
        } catch {
          // best-effort
        }
        try {
          await captureContext.close()
        } catch {
          // best-effort
        }
      }
      if (!success && directory !== null) {
        try {
          await fsPromises.rm(directory, { force: true, recursive: true })
        } catch {
          // private cleanup
        }
      }
    }
  }

  async function verifyManifestWithLifecycle(raw) {
    if (!hasExactKeys(raw, ['envelope', 'manifest'])) {
      failSealedExport('SEALED_EXPORT_MANIFEST_INVALID')
    }
    const envelope = contracts.validateExportRequestEnvelope(
      ownDataValue(raw, 'envelope'),
    )
    const manifest = contracts.validateSignedManifest(
      ownDataValue(raw, 'manifest'),
    )
    const binding = resolveBindingForEnvelope(envelope)
    contracts.verifyManifestBinding(envelope, manifest)
    return signer.verifyManifest(
      authorityScopeFor(binding),
      envelope.qualificationDigest,
      manifest,
    )
  }

  // First-party runners build envelopes via this path. It proves ordering-key
  // uniqueness/non-null against the enrolled mapping, then MACs the digest.
  async function probeQualificationForBinding(objectKey) {
    const binding = bindingsByObjectKey.get(objectKey)
    if (!binding) failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    let captureContext = null
    try {
      captureContext = await openCaptureContext(binding)
      const { orderingKeyProof } = await proveOrderingKey(
        captureContext,
        binding,
      )
      const bindingWithProof = Object.freeze({
        ...binding,
        orderingKeyProof,
      })
      const clockMs = firstPartyClockMs()
      return probeQualificationWithKey({
        binding: bindingWithProof,
        envelopeKey: ownedKeyringSecret,
        probedAt: toUtcSecondsIso(clockMs),
        expiresAt: toUtcSecondsIso(clockMs + QUALIFICATION_TTL_MS),
      })
    } finally {
      if (captureContext !== null) {
        try {
          await captureContext.rollback()
        } catch {
          // best-effort
        }
        try {
          await captureContext.close()
        } catch {
          // best-effort
        }
      }
    }
  }

  function verifyQualificationForBinding(objectKey, qualification) {
    const binding = bindingsByObjectKey.get(objectKey)
    if (!binding) failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    return verifyQualificationWithKey({
      envelopeKey: ownedKeyringSecret,
      expected: {
        actionProfileVersion: binding.actionProfileVersion,
        approvedConfigVersionId: binding.approvedConfigVersionId,
        bindingVersion: binding.bindingVersion,
        canonicalObjectVersion: binding.canonicalObjectVersion,
        configContentKey: binding.configContentKey,
        objectKey: binding.objectKey,
        roleBindingFingerprint: binding.roleBindingFingerprint,
        systemContentKey: binding.systemContentKey,
        tenantDomainBinding: binding.tenantDomainBinding,
      },
      now: toUtcSecondsIso(firstPartyClockMs()),
      qualification,
    })
  }

  function getApprovedBinding(objectKey) {
    const binding = bindingsByObjectKey.get(objectKey)
    if (!binding) failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    return Object.freeze({
      actionProfileVersion: binding.actionProfileVersion,
      approvedConfigVersionId: binding.approvedConfigVersionId,
      bindingVersion: binding.bindingVersion,
      canonicalObjectVersion: binding.canonicalObjectVersion,
      configContentKey: binding.configContentKey,
      expectedSourceSchemaFieldMapDigest:
        binding.expectedSourceSchemaFieldMapDigest,
      objectKey: binding.objectKey,
      queryObjectFilterBindingDigest:
        binding.queryObjectFilterBindingDigest,
      relationId: binding.relationId,
      roleBindingFingerprint: binding.roleBindingFingerprint,
      systemContentKey: binding.systemContentKey,
      tenantDomainBinding: binding.tenantDomainBinding,
    })
  }

  const service = Object.freeze({
    actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
    profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
    implementationVersion: SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
    distinctFromS2FixtureActionId: SEALED_EXPORT_S2_ACTION_ID,
    execute,
    verifyManifestWithLifecycle,
    probeQualificationForBinding,
    verifyQualificationForBinding,
    getApprovedBinding,
  })
  return service
}

// Mechanical pin: production S5 modules must not export these trust-mint names.
const FORBIDDEN_PUBLIC_EXPORT_NAMES = Object.freeze([
  'createHarnessSealedExportBindingResolutionForTests',
  'createTrustedSqlServerSnapshotSourceSession',
  'createHarnessSqlServerSnapshotSourceSessionForTests',
  'openHermeticSnapshotCaptureContext',
  'createFirstPartySignerAuthority',
  'createFirstPartySignerAuthorityFromStore',
  'createOpaquePrivateSignerHandle',
  'createEnrollmentAndOpaqueHandleFromMaterial',
  'createHarnessSignerAuthorityStoreForTests',
  'executeSqlServerSealedSnapshotAction',
  'isTrustedSealedExportBindingResolution',
  'isTrustedSealedExportQualification',
  'isTrustedSqlServerSnapshotSourceSession',
  'isTrustedSignerAuthority',
  'isTrustedPublicVerifier',
  'isTrustedSignerAuthorityStore',
  'isOpaquePrivateSignerHandle',
])

module.exports = Object.freeze({
  createSqlServerSealedSnapshotServiceCore,
  FORBIDDEN_PUBLIC_EXPORT_NAMES,
  EXECUTE_INPUT_FIELDS,
  FORBIDDEN_EXECUTE_KEYS,
})
