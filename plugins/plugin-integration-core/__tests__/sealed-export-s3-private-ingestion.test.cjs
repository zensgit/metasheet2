'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const codec = require(path.join(SEALED_DIR, 'canonical-json.cjs'))
const contracts = require(path.join(SEALED_DIR, 'contracts.cjs'))
const digests = require(path.join(SEALED_DIR, 'digests.cjs'))
const vocabulary = require(path.join(SEALED_DIR, 'failure-vocabulary.cjs'))
const {
  createPrivateIngestionMetadataStore,
  SESSION_TABLE,
  RECEIPT_TABLE,
  TOMBSTONE_TABLE,
} = require(path.join(SEALED_DIR, 'private-ingestion-metadata-store.cjs'))
const {
  createPrivateIngestionBlobStore,
} = require(path.join(SEALED_DIR, 'private-ingestion-blob-store.cjs'))
const {
  createPrivateIngestionService,
  createPrivateIngestionServiceCore,
} = require(path.join(SEALED_DIR, 'private-ingestion-service.cjs'))
const manifestVerifierModule = require(
  path.join(SEALED_DIR, 'private-ingestion-manifest-verifier.cjs'),
)
const {
  createPrivateIngestionManifestVerifier,
} = manifestVerifierModule

const D = (label) => crypto.createHash('sha256').update(`sealed-export-s3:${label}`).digest('hex')
const BASE_TIME = Date.parse('2026-07-30T00:00:00.000Z')
const SIGNER_KEY_ID = 'sx-signer-key'
const SIGNER = crypto.generateKeyPairSync('ed25519')
const DEFAULT_AUTHORITY = Object.freeze({
  tenantId: 'sx-pilot-tenant',
  workspaceId: 'sx-pilot-workspace',
  tenantDomainBinding: 'sx-pilot-tenant-domain',
  systemContentKey: 'sx-pilot-system',
  roleBindingFingerprint: 'sx-pilot-role-binding',
})
// The INERT verifier projection: identical `verify()` behaviour, NO brand. The
// publicly-exported `…ForTests` grant that used to build this is DELETED.
const MANIFEST_VERIFIER = createPrivateIngestionManifestVerifier({
  signerKeys: [{
    signerKeyId: SIGNER_KEY_ID,
    publicKey: SIGNER.publicKey,
  }],
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeMemoryDb() {
  const tables = new Map([
    [SESSION_TABLE, []],
    [RECEIPT_TABLE, []],
    [TOMBSTONE_TABLE, []],
  ])
  const pendingFailures = new Map()
  let transactionTail = Promise.resolve()

  function consumeFailure(operation) {
    const count = pendingFailures.get(operation) || 0
    if (count === 0) return
    pendingFailures.set(operation, count - 1)
    const error = new Error('synthetic storage failure')
    error.code = 'SYNTHETIC_STORAGE_FAILURE'
    throw error
  }

  function matches(row, where) {
    if (!where) return true
    return Object.keys(where).every((key) => row[key] === where[key])
  }

  function identityOf(table, row) {
    if (table === SESSION_TABLE || table === TOMBSTONE_TABLE) {
      return [
        row.tenant_id,
        row.workspace_id,
        row.tenant_domain_binding,
        row.system_content_key,
        row.role_binding_fingerprint,
        row.manifest_digest,
      ].join('\n')
    }
    return `${row.session_id}\n${row.chunk_index}`
  }

  async function select(table, options) {
    consumeFailure(`select:${table}`)
    const settings = options || {}
    let rows = tables.get(table).filter((row) => matches(row, settings.where))
    if (settings.range) {
      rows = rows.filter((row) => Object.keys(settings.range).every((column) => {
        const bounds = settings.range[column]
        if (bounds.gte !== undefined && row[column] < bounds.gte) return false
        if (bounds.lte !== undefined && row[column] > bounds.lte) return false
        return true
      }))
    }
    if (settings.orderBy) {
      const [column, direction] = settings.orderBy
      rows = rows.slice().sort((left, right) => {
        const order = left[column] < right[column] ? -1 : (left[column] > right[column] ? 1 : 0)
        return direction === 'DESC' ? -order : order
      })
    }
    const offset = Number.isSafeInteger(settings.offset) ? settings.offset : 0
    if (Number.isSafeInteger(settings.limit)) {
      rows = rows.slice(offset, offset + settings.limit)
    } else if (offset > 0) {
      rows = rows.slice(offset)
    }
    return clone(rows)
  }

  async function selectOne(table, where) {
    const rows = await select(table, { where, limit: 1 })
    return rows[0] || null
  }

  async function insertOne(table, rawRow) {
    consumeFailure(`insert:${table}`)
    const row = clone(rawRow)
    const rows = tables.get(table)
    const duplicate = rows.some((candidate) => {
      if (table === SESSION_TABLE || table === TOMBSTONE_TABLE) {
        return candidate.session_id === row.session_id
          || identityOf(table, candidate) === identityOf(table, row)
      }
      return identityOf(table, candidate) === identityOf(table, row)
    })
    if (duplicate) {
      const error = new Error('synthetic unique violation')
      error.code = '23505'
      throw error
    }
    rows.push(row)
    return [clone(row)]
  }

  async function updateRow(table, set, where) {
    consumeFailure(`update:${table}`)
    const updated = []
    for (const row of tables.get(table)) {
      if (!matches(row, where)) continue
      Object.assign(row, clone(set))
      updated.push(clone(row))
    }
    return updated
  }

  async function deleteRows(table, where) {
    consumeFailure(`delete:${table}`)
    const rows = tables.get(table)
    const deleted = rows.filter((row) => matches(row, where))
    tables.set(table, rows.filter((row) => !matches(row, where)))
    return clone(deleted)
  }

  const api = {
    select,
    selectOne,
    insertOne,
    updateRow,
    deleteRows,
    async transaction(callback) {
      const previous = transactionTail
      let release
      transactionTail = new Promise((resolve) => { release = resolve })
      await previous
      const snapshot = new Map(
        Array.from(tables.entries()).map(([name, rows]) => [name, clone(rows)]),
      )
      try {
        return await callback(api)
      } catch (error) {
        tables.clear()
        for (const [name, rows] of snapshot.entries()) tables.set(name, rows)
        throw error
      } finally {
        release()
      }
    },
  }

  return Object.freeze({
    api,
    failNext(operation) {
      pendingFailures.set(operation, (pendingFailures.get(operation) || 0) + 1)
    },
    rows(table) {
      return clone(tables.get(table))
    },
    mutate(table, predicate, mutateRow) {
      const row = tables.get(table).find(predicate)
      assert.ok(row, `expected row to mutate in ${table}`)
      mutateRow(row)
    },
  })
}

function fixture(label, expiresAt, chunkTexts) {
  const chunks = (chunkTexts || [
    `sx-${label}-chunk-0`,
    `sx-${label}-chunk-1`,
    `sx-${label}-chunk-2`,
  ]).map((text) => Buffer.from(text, 'utf8'))
  const rows = [
    { k: `sx-${label}-row-a` },
    { k: `sx-${label}-row-b` },
    { k: `sx-${label}-row-a` },
  ]
  const envelope = {
    exportRequestId: `sx-${label}-request`,
    nonce: `sx-${label}-nonce`,
    expiry: expiresAt,
    scenarioVersion: 'sx-scenario-v1',
    bindingVersion: 'sx-binding-v1',
    roleId: 'sx-role',
    actionProfileVersion: 'sx-action-profile-v1',
    roleBindingFingerprint: DEFAULT_AUTHORITY.roleBindingFingerprint,
    systemContentKey: DEFAULT_AUTHORITY.systemContentKey,
    approvedConfigVersionId: 'sx-approved-config-v1',
    configContentKey: `sx-${label}-config`,
    canonicalObjectVersion: 'sx-canonical-object-v1',
    qualificationDigest: D(`${label}-qualification`),
    executionMode: 'sx-execution-mode',
    applyProfileVersion: 'sx-apply-profile-v1',
    queryObjectFilterBindingDigest: D(`${label}-query-binding`),
    expectedSourceSchemaFieldMapDigest: D(`${label}-schema`),
    tenantDomainBinding: DEFAULT_AUTHORITY.tenantDomainBinding,
    rowBudget: 100,
    byteBudget: 10000,
    chunkBudget: 10,
  }
  const descriptors = chunks.map((bytes, chunkIndex) => ({
    chunkIndex,
    chunkDigest: digests.computeChunkDigest(bytes).digest,
    byteCount: bytes.length,
  }))
  const manifestDraft = {
    exportRequestEnvelopeDigest: contracts.computeExportRequestEnvelopeDigest(envelope),
    sourceCaptureIdentity: `sx-${label}-capture`,
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    agentImplementationVersion: 'sx-agent-impl-v1',
    agentProtocolVersion: 'sx-agent-protocol-v1',
    encodingVersion: 'sx-encoding-v1',
    canonicalizationVersion: codec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    sourceSchemaDigest: envelope.expectedSourceSchemaFieldMapDigest,
    totalRows: rows.length,
    totalBytes: chunks.reduce((total, bytes) => total + bytes.length, 0),
    chunks: descriptors,
    wholeArtifactByteDigest: digests.computeWholeArtifactByteDigest(chunks).digest,
    canonicalRowsetMultiplicityDigest:
      digests.computeCanonicalRowsetMultiplicityDigest(rows, codec).digest,
    captureCompletionTimestamp: new Date(BASE_TIME).toISOString(),
    manifestExpiry: expiresAt,
    signerKeyId: SIGNER_KEY_ID,
    signatureAlgorithm: 'ED25519',
    signature: 'AA==',
  }
  const signature = crypto.sign(
    null,
    contracts.computeSignedManifestBytes(manifestDraft),
    SIGNER.privateKey,
  ).toString('base64')
  const manifest = {
    ...manifestDraft,
    signature,
  }
  return Object.freeze({ chunks, envelope, manifest, scope: DEFAULT_AUTHORITY })
}

async function refuses(action, expectedReason, label) {
  let caught = null
  try {
    assert.deepEqual(Object.keys(manifestVerifierModule).sort(), [
      'SIGNATURE_ALGORITHM',
      'createPrivateIngestionManifestVerifier',
      'createSqlServerPrivateIngestionManifestVerifier',
      'isTrustedPrivateIngestionManifestVerifier',
    ])

    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof vocabulary.SealedExportError, `expected sealed refusal: ${label}`)
  assert.equal(caught.reason, expectedReason, `reason for ${label}`)
  assert.doesNotMatch(
    JSON.stringify(caught),
    /sx-.*(?:chunk|system|binding|workspace|tenant)/,
    `refusal must stay values-free: ${label}`,
  )
  return caught
}

function buildHarness(rootDir, memory, clock, blobOverride, authority = DEFAULT_AUTHORITY) {
  const metadataStore = createPrivateIngestionMetadataStore({ db: memory.api })
  const blobStore = blobOverride || createPrivateIngestionBlobStore({ rootDir })
  return {
    blobStore,
    metadataStore,
    // The UNBRANDED DI core. The two assert.throws below stay pointed at the
    // BRANDING wrapper `createPrivateIngestionService`, so the admission check
    // this suite used to satisfy with a `…ForTests` grant is still proven.
    service: createPrivateIngestionServiceCore({
      metadataStore,
      blobStore,
      manifestVerifier: MANIFEST_VERIFIER,
      authority,
      clock,
    }),
  }
}

async function submitAll(service, data, sessionId) {
  for (let index = 0; index < data.chunks.length; index += 1) {
    await service.submitChunk({
      sessionId,
      chunkIndex: index,
      bytes: data.chunks[index],
    })
  }
}

async function assertDuplicateCreateCleanupRace({
  tempRoot,
  label,
  expiresAt,
  clock,
  pauseInCleaning,
}) {
  const memory = makeMemoryDb()
  const rootDir = path.join(tempRoot, label)
  const realBlob = createPrivateIngestionBlobStore({ rootDir })
  let createAreaCalls = 0
  let announceDuplicateCreate
  let releaseDuplicateCreate
  let announceCleanup
  let releaseCleanup
  let shouldPauseCleanup = false
  const duplicateCreateEntered = new Promise((resolve) => {
    announceDuplicateCreate = resolve
  })
  const duplicateCreateRelease = new Promise((resolve) => {
    releaseDuplicateCreate = resolve
  })
  const cleanupEntered = new Promise((resolve) => {
    announceCleanup = resolve
  })
  const cleanupRelease = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const pausedBlob = Object.freeze({
    async createSessionArea(...args) {
      createAreaCalls += 1
      if (createAreaCalls === 2) {
        announceDuplicateCreate()
        await duplicateCreateRelease
      }
      return realBlob.createSessionArea(...args)
    },
    writeChunk: realBlob.writeChunk,
    readChunk: realBlob.readChunk,
    readChunkIfPresent: realBlob.readChunkIfPresent,
    async removeSession(...args) {
      if (shouldPauseCleanup) {
        shouldPauseCleanup = false
        announceCleanup()
        await cleanupRelease
      }
      return realBlob.removeSession(...args)
    },
  })
  const data = fixture(label, expiresAt)
  const harness = buildHarness(rootDir, memory, clock, pausedBlob)
  const session = await harness.service.createSession({
    envelope: data.envelope,
    manifest: data.manifest,
  })
  await submitAll(harness.service, data, session.sessionId)
  const duplicateCreate = harness.service.createSession({
    envelope: data.envelope,
    manifest: data.manifest,
  })
  await duplicateCreateEntered
  await harness.service.completeSession({ sessionId: session.sessionId })

  if (pauseInCleaning) {
    shouldPauseCleanup = true
    const cleanup = harness.service.cleanupSession({ sessionId: session.sessionId })
    await cleanupEntered
    assert.equal(memory.rows(SESSION_TABLE)[0].status, 'CLEANING')
    releaseDuplicateCreate()
    await refuses(
      () => duplicateCreate,
      'SEALED_EXPORT_MANIFEST_REPLAYED',
      'duplicate create observes the CLEANING fence',
    )
    releaseCleanup()
    assert.equal((await cleanup).outcome, 'CLEANED')
  } else {
    await harness.service.cleanupSession({ sessionId: session.sessionId })
    releaseDuplicateCreate()
    await refuses(
      () => duplicateCreate,
      'SEALED_EXPORT_MANIFEST_REPLAYED',
      'duplicate create observes the cleanup tombstone',
    )
  }

  await assert.rejects(
    fs.stat(path.join(rootDir, session.sessionId)),
    { code: 'ENOENT' },
  )
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-export-s3-'))
  let nowMs = BASE_TIME
  const clock = () => new Date(nowMs)
  const expiresAt = new Date(BASE_TIME + 60 * 60 * 1000).toISOString()

  try {
    // Blob publication has its own discriminating duplicate and permission
    // checks; the service classifier is not allowed to mask this boundary.
    const blobOnlyRoot = path.join(tempRoot, 'blob-only')
    const blobOnlySession = D('blob-only-session')
    const blobOnlyDirectory = path.join(blobOnlyRoot, blobOnlySession)
    await fs.mkdir(blobOnlyDirectory, { recursive: true, mode: 0o777 })
    await fs.chmod(blobOnlyRoot, 0o777)
    await fs.chmod(blobOnlyDirectory, 0o777)
    const blobOnly = createPrivateIngestionBlobStore({ rootDir: blobOnlyRoot })
    const blobFirst = Buffer.from('sx-blob-original', 'utf8')
    const blobSecond = Buffer.from('sx-blob-conflict', 'utf8')
    await blobOnly.createSessionArea(blobOnlySession)
    assert.equal(
      (await blobOnly.writeChunk(blobOnlySession, 0, blobFirst)).outcome,
      'CREATED',
    )
    assert.equal((await fs.stat(blobOnlyRoot)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(blobOnlyDirectory)).mode & 0o777, 0o700)
    assert.equal(
      (await fs.stat(path.join(blobOnlyDirectory, 'chunk-0.bin'))).mode & 0o777,
      0o600,
    )
    assert.equal(
      (await blobOnly.writeChunk(blobOnlySession, 0, blobFirst)).outcome,
      'EXISTING_IDENTICAL',
    )
    await refuses(
      () => blobOnly.writeChunk(blobOnlySession, 0, blobSecond),
      'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT',
      'blob store refuses overwrite independently',
    )
    assert.deepEqual(await blobOnly.readChunk(blobOnlySession, 0), blobFirst)

    // Canonical flow, concurrent create, strict ordering, resume and replay.
    const memory = makeMemoryDb()
    const rootDir = path.join(tempRoot, 'canonical')
    const data = fixture('canonical', expiresAt)
    const first = buildHarness(rootDir, memory, clock)
    assert.throws(
      () => createPrivateIngestionService({
        metadataStore: first.metadataStore,
        blobStore: first.blobStore,
        manifestVerifier: createPrivateIngestionManifestVerifier({
          signerKeys: [{
            signerKeyId: SIGNER_KEY_ID,
            publicKey: SIGNER.publicKey,
          }],
        }),
        authority: DEFAULT_AUTHORITY,
        clock,
      }),
      (error) => error instanceof vocabulary.SealedExportError
        && error.reason === 'SEALED_EXPORT_INTERNAL_ERROR',
      'a caller-built signer registry cannot grant verifier trust',
    )
    assert.throws(
      () => createPrivateIngestionService({
        metadataStore: first.metadataStore,
        blobStore: first.blobStore,
        manifestVerifier: Object.freeze({ verify: () => true }),
        authority: DEFAULT_AUTHORITY,
        clock,
      }),
      (error) => error instanceof vocabulary.SealedExportError
        && error.reason === 'SEALED_EXPORT_INTERNAL_ERROR',
      'a duck-typed signature verifier is not admitted',
    )
    const badSignature = clone(data.manifest)
    badSignature.signature = `${badSignature.signature.charAt(0) === 'A' ? 'B' : 'A'}${badSignature.signature.slice(1)}`
    await refuses(
      () => first.service.createSession({
        envelope: data.envelope,
        manifest: badSignature,
      }),
      'SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID',
      'manifest signature tamper',
    )
    const unknownSigner = clone(data.manifest)
    unknownSigner.signerKeyId = 'sx-unenrolled-signer'
    await refuses(
      () => first.service.createSession({
        envelope: data.envelope,
        manifest: unknownSigner,
      }),
      'SEALED_EXPORT_SIGNER_UNENROLLED',
      'manifest signer is not enrolled',
    )
    const creates = await Promise.all([
      first.service.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      }),
      first.service.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      }),
    ])
    assert.equal(creates[0].sessionId, creates[1].sessionId)
    assert.equal(memory.rows(SESSION_TABLE).length, 1, 'one authoritative session')
    const sessionId = creates[0].sessionId

    await first.service.submitChunk({
      sessionId,
      chunkIndex: 0,
      bytes: data.chunks[0],
    })
    const replay = await first.service.submitChunk({
      sessionId,
      chunkIndex: 0,
      bytes: data.chunks[0],
    })
    assert.equal(replay.decision, 'IDEMPOTENT_REPLAY')
    assert.equal(memory.rows(RECEIPT_TABLE).length, 1)

    const conflicting = Buffer.from(data.chunks[0])
    conflicting[0] ^= 1
    await refuses(
      () => first.service.submitChunk({
        sessionId,
        chunkIndex: 0,
        bytes: conflicting,
      }),
      'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT',
      'conflicting duplicate',
    )
    await refuses(
      () => first.service.submitChunk({
        sessionId,
        chunkIndex: 2,
        bytes: data.chunks[2],
      }),
      'SEALED_EXPORT_CHUNK_ORDER_INVALID',
      'in-range out-of-order chunk',
    )
    await refuses(
      () => first.service.submitChunk({
        sessionId,
        chunkIndex: 3,
        bytes: Buffer.from('sx-extra', 'utf8'),
      }),
      'SEALED_EXPORT_CHUNK_UNDECLARED',
      'undeclared extra chunk',
    )
    assert.equal(memory.rows(RECEIPT_TABLE).length, 1)
    await refuses(
      () => first.service.completeSession({ sessionId }),
      'SEALED_EXPORT_CHUNK_SET_INCOMPLETE',
      'missing chunk set',
    )

    const tamperedSubmission = Buffer.from(data.chunks[1])
    tamperedSubmission[0] ^= 1
    await refuses(
      () => first.service.submitChunk({
        sessionId,
        chunkIndex: 1,
        bytes: tamperedSubmission,
      }),
      'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
      'one-byte submitted tamper',
    )
    await first.service.submitChunk({
      sessionId,
      chunkIndex: 1,
      bytes: data.chunks[1],
    })

    const rootMode = (await fs.stat(rootDir)).mode & 0o777
    const sessionMode = (await fs.stat(path.join(rootDir, sessionId))).mode & 0o777
    const chunkMode = (await fs.stat(path.join(rootDir, sessionId, 'chunk-0.bin'))).mode & 0o777
    assert.equal(rootMode, 0o700)
    assert.equal(sessionMode, 0o700)
    assert.equal(chunkMode, 0o600)

    const resumedHarness = buildHarness(rootDir, memory, clock)
    const resumed = await resumedHarness.service.resumeSession({ sessionId })
    assert.deepEqual(resumed.acceptedChunkIndexes, [0, 1])
    await resumedHarness.service.submitChunk({
      sessionId,
      chunkIndex: 2,
      bytes: data.chunks[2],
    })
    const completed = await resumedHarness.service.completeSession({ sessionId })
    assert.deepEqual(
      {
        status: completed.status,
        chunkCount: completed.chunkCount,
        byteCount: completed.byteCount,
        artifactDigestVerified: completed.artifactDigestVerified,
      },
      {
        status: 'UPLOAD_COMPLETE',
        chunkCount: 3,
        byteCount: data.manifest.totalBytes,
        artifactDigestVerified: true,
      },
    )
    assert.equal(memory.rows(SESSION_TABLE)[0].status, 'UPLOAD_COMPLETE')
    assert.deepEqual(
      await resumedHarness.service.resumeSession({ sessionId }),
      {
        sessionId,
        status: 'UPLOAD_COMPLETE',
        acceptedChunkCount: data.manifest.chunks.length,
        acceptedChunkIndexes: data.manifest.chunks.map(
          (chunk) => chunk.chunkIndex,
        ),
        artifactDigestVerified: true,
      },
      'an exact bound retry can observe durable upload completion',
    )
    const outputText = JSON.stringify({ creates, replay, resumed, completed })
    for (const forbidden of [
      data.scope.systemContentKey,
      data.scope.roleBindingFingerprint,
      data.chunks[0].toString('utf8'),
      data.manifest.wholeArtifactByteDigest,
    ]) {
      assert.ok(!outputText.includes(forbidden), 'public result stays values-free')
    }
    await fs.writeFile(
      path.join(rootDir, sessionId, 'chunk-1.bin'),
      Buffer.from('tampered-after-completion', 'utf8'),
    )
    await refuses(
      () => resumedHarness.service.resumeSession({ sessionId }),
      'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
      'completed resume re-verifies durable chunk bytes',
    )

    await refuses(
      () => resumedHarness.service.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      }),
      'SEALED_EXPORT_MANIFEST_REPLAYED',
      'completed replay before cleanup',
    )
    const cleaned = await resumedHarness.service.cleanupSession({ sessionId })
    assert.equal(cleaned.outcome, 'CLEANED')
    assert.equal(memory.rows(SESSION_TABLE).length, 0)
    assert.equal(memory.rows(RECEIPT_TABLE).length, 0)
    assert.equal(memory.rows(TOMBSTONE_TABLE).length, 1)
    await assert.rejects(fs.stat(path.join(rootDir, sessionId)), { code: 'ENOENT' })
    await refuses(
      () => resumedHarness.service.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      }),
      'SEALED_EXPORT_MANIFEST_REPLAYED',
      'completed replay after cleanup',
    )

    // Manifest overrides are structurally impossible after session creation.
    const closedData = fixture('closed-call', expiresAt)
    const closed = await first.service.createSession({
      envelope: closedData.envelope,
      manifest: closedData.manifest,
    })
    await refuses(
      () => first.service.submitChunk({
        sessionId: closed.sessionId,
        chunkIndex: 0,
        bytes: closedData.chunks[0],
        manifest: data.manifest,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'caller manifest override',
    )
    await refuses(
      () => first.service.resumeSession({
        sessionId: closed.sessionId,
        scope: closedData.scope,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'caller authority override',
    )

    // Tenant and binding isolation.
    const isolationData = fixture('isolation', expiresAt)
    const isolation = await first.service.createSession({
      envelope: isolationData.envelope,
      manifest: isolationData.manifest,
    })
    const otherTenant = Object.assign({}, isolationData.scope, { tenantId: 'sx-other-tenant' })
    const otherTenantHarness = buildHarness(rootDir, memory, clock, undefined, otherTenant)
    await refuses(
      () => otherTenantHarness.service.resumeSession({
        sessionId: isolation.sessionId,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'cross-tenant resume',
    )
    await refuses(
      () => otherTenantHarness.service.cleanupSession({
        sessionId: isolation.sessionId,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'cross-tenant cleanup',
    )
    const wrongTenantDomain = Object.assign(
      {},
      isolationData.scope,
      { tenantDomainBinding: 'sx-wrong-tenant-domain' },
    )
    const wrongDomainHarness = buildHarness(rootDir, memory, clock, undefined, wrongTenantDomain)
    await refuses(
      () => wrongDomainHarness.service.resumeSession({
        sessionId: isolation.sessionId,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'cross-domain resume',
    )
    const wrongSystem = Object.assign({}, isolationData.scope, { systemContentKey: 'sx-wrong-system' })
    const wrongSystemHarness = buildHarness(rootDir, memory, clock, undefined, wrongSystem)
    await refuses(
      () => wrongSystemHarness.service.createSession({
        envelope: isolationData.envelope,
        manifest: isolationData.manifest,
      }),
      'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
      'system binding mismatch',
    )

    // Persisted artifact tamper cannot emit a completed session.
    const artifactData = fixture('artifact-tamper', expiresAt)
    const artifactSession = await first.service.createSession({
      envelope: artifactData.envelope,
      manifest: artifactData.manifest,
    })
    await submitAll(first.service, artifactData, artifactSession.sessionId)
    const artifactChunkPath = path.join(rootDir, artifactSession.sessionId, 'chunk-1.bin')
    const artifactTamper = await fs.readFile(artifactChunkPath)
    artifactTamper[0] ^= 1
    await fs.writeFile(artifactChunkPath, artifactTamper, { mode: 0o600 })
    await refuses(
      () => first.service.completeSession({
        sessionId: artifactSession.sessionId,
      }),
      'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
      'persisted one-byte tamper',
    )
    const artifactRow = memory.rows(SESSION_TABLE)
      .find((row) => row.session_id === artifactSession.sessionId)
    assert.equal(artifactRow.status, 'UPLOADING')

    // Durable receipt metadata is re-bound to the manifest on every resume.
    const receiptTamperData = fixture('receipt-tamper', expiresAt)
    const receiptTamperSession = await first.service.createSession({
      envelope: receiptTamperData.envelope,
      manifest: receiptTamperData.manifest,
    })
    await first.service.submitChunk({
      sessionId: receiptTamperSession.sessionId,
      chunkIndex: 0,
      bytes: receiptTamperData.chunks[0],
    })
    memory.mutate(
      RECEIPT_TABLE,
      (row) => row.session_id === receiptTamperSession.sessionId,
      (row) => { row.manifest_digest = D('receipt-wrong-manifest') },
    )
    await refuses(
      () => first.service.resumeSession({
        sessionId: receiptTamperSession.sessionId,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'persisted receipt manifest mismatch',
    )
    memory.mutate(
      RECEIPT_TABLE,
      (row) => row.session_id === receiptTamperSession.sessionId,
      (row) => {
        row.manifest_digest = contracts.computeManifestDigest(
          contracts.validateSignedManifest(receiptTamperData.manifest),
        )
        row.chunk_digest = D('receipt-wrong-chunk')
      },
    )
    await refuses(
      () => first.service.resumeSession({
        sessionId: receiptTamperSession.sessionId,
      }),
      'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
      'persisted receipt descriptor mismatch',
    )
    memory.mutate(
      RECEIPT_TABLE,
      (row) => row.session_id === receiptTamperSession.sessionId,
      (row) => {
        row.chunk_digest = receiptTamperData.manifest.chunks[0].chunkDigest
      },
    )
    memory.mutate(
      SESSION_TABLE,
      (row) => row.session_id === receiptTamperSession.sessionId,
      (row) => { row.accepted_chunk_count = 0 },
    )
    await refuses(
      () => first.service.resumeSession({
        sessionId: receiptTamperSession.sessionId,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'persisted accepted-count mismatch',
    )

    const completeReceiptData = fixture('complete-receipt-tamper', expiresAt)
    const completeReceiptSession = await first.service.createSession({
      envelope: completeReceiptData.envelope,
      manifest: completeReceiptData.manifest,
    })
    await submitAll(first.service, completeReceiptData, completeReceiptSession.sessionId)
    memory.mutate(
      RECEIPT_TABLE,
      (row) => (
        row.session_id === completeReceiptSession.sessionId
        && row.chunk_index === 1
      ),
      (row) => { row.manifest_digest = D('complete-receipt-wrong-manifest') },
    )
    await refuses(
      () => first.service.completeSession({
        sessionId: completeReceiptSession.sessionId,
      }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'completion rebinds every persisted receipt to the manifest',
    )
    assert.equal(
      memory.rows(SESSION_TABLE)
        .find((row) => row.session_id === completeReceiptSession.sessionId)
        .status,
      'UPLOADING',
    )

    const receiptScopeData = fixture('receipt-scope-tamper', expiresAt)
    const receiptScopeSession = await first.service.createSession({
      envelope: receiptScopeData.envelope,
      manifest: receiptScopeData.manifest,
    })
    await first.service.submitChunk({
      sessionId: receiptScopeSession.sessionId,
      chunkIndex: 0,
      bytes: receiptScopeData.chunks[0],
    })
    memory.mutate(
      RECEIPT_TABLE,
      (row) => row.session_id === receiptScopeSession.sessionId,
      (row) => { row.tenant_domain_binding = 'sx-other-domain' },
    )
    await refuses(
      () => first.service.resumeSession({ sessionId: receiptScopeSession.sessionId }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'receipt scope cannot drift from its session',
    )

    // Replacing the persisted envelope and signed manifest with another valid S2
    // pair cannot move an existing session to a new identity.
    const manifestSwapData = fixture('manifest-swap', expiresAt)
    const manifestSwapSession = await first.service.createSession({
      envelope: manifestSwapData.envelope,
      manifest: manifestSwapData.manifest,
    })
    const replacementExpiry = new Date(Date.parse(expiresAt) + 30 * 60 * 1000).toISOString()
    const replacement = fixture(
      'manifest-replacement',
      replacementExpiry,
      ['replacement-0', 'replacement-1', 'replacement-2', 'replacement-3'],
    )
    memory.mutate(
      SESSION_TABLE,
      (row) => row.session_id === manifestSwapSession.sessionId,
      (row) => {
        row.export_request_envelope = clone(replacement.envelope)
        row.manifest = clone(replacement.manifest)
        row.manifest_digest = contracts.computeManifestDigest(replacement.manifest)
        row.expected_chunk_count = replacement.manifest.chunks.length
        row.expires_at = replacement.manifest.manifestExpiry
      },
    )
    await refuses(
      () => first.service.resumeSession({ sessionId: manifestSwapSession.sessionId }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'persisted signed manifest replacement',
    )

    const expiryAnchorData = fixture('expiry-anchor', expiresAt)
    const expiryAnchorSession = await first.service.createSession({
      envelope: expiryAnchorData.envelope,
      manifest: expiryAnchorData.manifest,
    })
    memory.mutate(
      SESSION_TABLE,
      (row) => row.session_id === expiryAnchorSession.sessionId,
      (row) => {
        row.expires_at = new Date(Date.parse(expiresAt) + 1000).toISOString()
      },
    )
    await refuses(
      () => first.service.resumeSession({ sessionId: expiryAnchorSession.sessionId }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'persisted expiry must equal the signed manifest',
    )

    const countAnchorData = fixture('count-anchor', expiresAt)
    const countAnchorSession = await first.service.createSession({
      envelope: countAnchorData.envelope,
      manifest: countAnchorData.manifest,
    })
    memory.mutate(
      SESSION_TABLE,
      (row) => row.session_id === countAnchorSession.sessionId,
      (row) => { row.expected_chunk_count += 1 },
    )
    await refuses(
      () => first.service.resumeSession({ sessionId: countAnchorSession.sessionId }),
      'SEALED_EXPORT_UPLOAD_SESSION_INVALID',
      'persisted chunk count must equal the signed manifest',
    )

    // Incomplete sessions are retained until their manifest bound, then removed.
    const retentionMemory = makeMemoryDb()
    const retentionRoot = path.join(tempRoot, 'retention')
    const retentionData = fixture('retention', expiresAt)
    const retentionHarness = buildHarness(retentionRoot, retentionMemory, clock)
    const retentionSession = await retentionHarness.service.createSession({
      envelope: retentionData.envelope,
      manifest: retentionData.manifest,
    })
    await retentionHarness.service.submitChunk({
      sessionId: retentionSession.sessionId,
      chunkIndex: 0,
      bytes: retentionData.chunks[0],
    })
    const retained = await retentionHarness.service.cleanupSession({
      sessionId: retentionSession.sessionId,
    })
    assert.equal(retained.outcome, 'RETAINED_ACTIVE')
    assert.equal(retentionMemory.rows(SESSION_TABLE).length, 1)
    await fs.stat(path.join(retentionRoot, retentionSession.sessionId, 'chunk-0.bin'))
    nowMs = Date.parse(expiresAt)
    const expiredCleanup = await retentionHarness.service.cleanupExpiredSessions({ limit: 10 })
    assert.deepEqual(expiredCleanup, {
      scannedCount: 1,
      cleanedCount: 1,
      retainedCount: 0,
      failedCount: 0,
    })
    assert.equal(retentionMemory.rows(TOMBSTONE_TABLE)[0].cleanup_reason, 'EXPIRED')
    await assert.rejects(
      fs.stat(path.join(retentionRoot, retentionSession.sessionId)),
      { code: 'ENOENT' },
    )
    await refuses(
      () => retentionHarness.service.createSession({
        envelope: retentionData.envelope,
        manifest: retentionData.manifest,
      }),
      'SEALED_EXPORT_ARTIFACT_EXPIRED',
      'expired manifest is refused before replay lookup',
    )
    nowMs = BASE_TIME

    // One corrupted expired row cannot block a later valid row in the same
    // retention batch. Cleanup uses immutable server anchors, not row-bearing
    // manifest data, after the expiry index has selected the candidate.
    const queueMemory = makeMemoryDb()
    const queueRoot = path.join(tempRoot, 'retention-queue')
    const queueHarness = buildHarness(queueRoot, queueMemory, clock)
    const corruptQueueData = fixture('retention-queue-corrupt', expiresAt)
    const validQueueData = fixture('retention-queue-valid', expiresAt)
    const corruptQueueSession = await queueHarness.service.createSession({
      envelope: corruptQueueData.envelope,
      manifest: corruptQueueData.manifest,
    })
    const validQueueSession = await queueHarness.service.createSession({
      envelope: validQueueData.envelope,
      manifest: validQueueData.manifest,
    })
    queueMemory.mutate(
      SESSION_TABLE,
      (row) => row.session_id === corruptQueueSession.sessionId,
      (row) => { row.manifest = { corrupted: true } },
    )
    nowMs = Date.parse(expiresAt)
    assert.deepEqual(
      await queueHarness.service.cleanupExpiredSessions({ limit: 10 }),
      {
        scannedCount: 2,
        cleanedCount: 2,
        retainedCount: 0,
        failedCount: 0,
      },
    )
    assert.equal(queueMemory.rows(SESSION_TABLE).length, 0)
    assert.equal(queueMemory.rows(TOMBSTONE_TABLE).length, 2)
    await assert.rejects(
      fs.stat(path.join(queueRoot, validQueueSession.sessionId)),
      { code: 'ENOENT' },
    )
    nowMs = BASE_TIME

    // A writer that has acquired the durable fence cannot recreate the private
    // session directory after expiry cleanup has fenced and removed it.
    const raceMemory = makeMemoryDb()
    const raceRoot = path.join(tempRoot, 'cleanup-write-race')
    const raceBlob = createPrivateIngestionBlobStore({ rootDir: raceRoot })
    let announceWrite
    let releaseWrite
    const writeEntered = new Promise((resolve) => { announceWrite = resolve })
    const writeRelease = new Promise((resolve) => { releaseWrite = resolve })
    const pausedRaceBlob = Object.freeze({
      createSessionArea: raceBlob.createSessionArea,
      readChunk: raceBlob.readChunk,
      readChunkIfPresent: raceBlob.readChunkIfPresent,
      removeSession: raceBlob.removeSession,
      async writeChunk(...args) {
        announceWrite()
        await writeRelease
        return raceBlob.writeChunk(...args)
      },
    })
    const raceData = fixture('cleanup-write-race', expiresAt)
    const raceHarness = buildHarness(raceRoot, raceMemory, clock, pausedRaceBlob)
    const raceSession = await raceHarness.service.createSession({
      envelope: raceData.envelope,
      manifest: raceData.manifest,
    })
    const pendingWrite = raceHarness.service.submitChunk({
      sessionId: raceSession.sessionId,
      chunkIndex: 0,
      bytes: raceData.chunks[0],
    })
    await writeEntered
    assert.equal(raceMemory.rows(SESSION_TABLE)[0].status, 'CHUNK_WRITING')
    nowMs = Date.parse(expiresAt)
    assert.equal(
      (await raceHarness.service.cleanupSession({ sessionId: raceSession.sessionId })).outcome,
      'CLEANED',
    )
    releaseWrite()
    await refuses(
      () => pendingWrite,
      'SEALED_EXPORT_INTERNAL_ERROR',
      'cleanup fences a writer before private-byte publication',
    )
    assert.equal(raceMemory.rows(SESSION_TABLE).length, 0)
    assert.equal(raceMemory.rows(TOMBSTONE_TABLE).length, 1)
    await assert.rejects(
      fs.stat(path.join(raceRoot, raceSession.sessionId)),
      { code: 'ENOENT' },
    )
    nowMs = BASE_TIME

    // A duplicate create that read an active row before completion must not
    // recreate the private directory across either cleanup-visible state.
    await assertDuplicateCreateCleanupRace({
      tempRoot,
      label: 'create-cleanup-tombstone-race',
      expiresAt,
      clock,
      pauseInCleaning: false,
    })
    await assertDuplicateCreateCleanupRace({
      tempRoot,
      label: 'create-cleanup-cleaning-race',
      expiresAt,
      clock,
      pauseInCleaning: true,
    })

    // Failure injection: session creation.
    const createFailureMemory = makeMemoryDb()
    createFailureMemory.failNext(`insert:${SESSION_TABLE}`)
    const createFailureData = fixture('create-failure', expiresAt)
    const createFailureHarness = buildHarness(
      path.join(tempRoot, 'create-failure'),
      createFailureMemory,
      clock,
    )
    await refuses(
      () => createFailureHarness.service.createSession({
        envelope: createFailureData.envelope,
        manifest: createFailureData.manifest,
      }),
      'SEALED_EXPORT_INTERNAL_ERROR',
      'session persistence failure',
    )
    assert.equal(createFailureMemory.rows(SESSION_TABLE).length, 0)

    // Failure injection: chunk write.
    const writeFailureMemory = makeMemoryDb()
    const writeFailureRoot = path.join(tempRoot, 'write-failure')
    const realWriteBlob = createPrivateIngestionBlobStore({ rootDir: writeFailureRoot })
    let failWrite = true
    const writeFailureBlob = Object.freeze({
      createSessionArea: realWriteBlob.createSessionArea,
      readChunk: realWriteBlob.readChunk,
      readChunkIfPresent: realWriteBlob.readChunkIfPresent,
      removeSession: realWriteBlob.removeSession,
      async writeChunk(...args) {
        if (failWrite) {
          failWrite = false
          vocabulary.failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
        }
        return realWriteBlob.writeChunk(...args)
      },
    })
    const writeFailureData = fixture('write-failure', expiresAt)
    const writeFailureHarness = buildHarness(
      writeFailureRoot,
      writeFailureMemory,
      clock,
      writeFailureBlob,
    )
    const writeFailureSession = await writeFailureHarness.service.createSession({
      envelope: writeFailureData.envelope,
      manifest: writeFailureData.manifest,
    })
    await refuses(
      () => writeFailureHarness.service.submitChunk({
        sessionId: writeFailureSession.sessionId,
        chunkIndex: 0,
        bytes: writeFailureData.chunks[0],
      }),
      'SEALED_EXPORT_STAGING_WRITE_FAILED',
      'chunk write failure',
    )
    assert.equal(writeFailureMemory.rows(RECEIPT_TABLE).length, 0)
    assert.equal(writeFailureMemory.rows(SESSION_TABLE)[0].status, 'UPLOADING')

    // Failure injection: receipt persistence after the atomically published blob.
    const receiptFailureMemory = makeMemoryDb()
    const receiptFailureRoot = path.join(tempRoot, 'receipt-failure')
    const receiptFailureData = fixture('receipt-failure', expiresAt)
    const receiptFailureHarness = buildHarness(receiptFailureRoot, receiptFailureMemory, clock)
    const receiptFailureSession = await receiptFailureHarness.service.createSession({
      envelope: receiptFailureData.envelope,
      manifest: receiptFailureData.manifest,
    })
    receiptFailureMemory.failNext(`insert:${RECEIPT_TABLE}`)
    await refuses(
      () => receiptFailureHarness.service.submitChunk({
        sessionId: receiptFailureSession.sessionId,
        chunkIndex: 0,
        bytes: receiptFailureData.chunks[0],
      }),
      'SEALED_EXPORT_INTERNAL_ERROR',
      'receipt persistence failure',
    )
    assert.equal(receiptFailureMemory.rows(RECEIPT_TABLE).length, 0)
    assert.equal(receiptFailureMemory.rows(SESSION_TABLE)[0].status, 'CHUNK_WRITING')
    await fs.stat(path.join(receiptFailureRoot, receiptFailureSession.sessionId, 'chunk-0.bin'))
    const receiptRetry = await receiptFailureHarness.service.resumeSession({
      sessionId: receiptFailureSession.sessionId,
    })
    assert.deepEqual(receiptRetry.acceptedChunkIndexes, [0])
    assert.equal(receiptFailureMemory.rows(RECEIPT_TABLE).length, 1)

    const emptyReservationMemory = makeMemoryDb()
    const emptyReservationRoot = path.join(tempRoot, 'empty-reservation')
    const emptyReservationData = fixture('empty-reservation', expiresAt)
    const emptyReservationHarness = buildHarness(
      emptyReservationRoot,
      emptyReservationMemory,
      clock,
    )
    const emptyReservationSession = await emptyReservationHarness.service.createSession({
      envelope: emptyReservationData.envelope,
      manifest: emptyReservationData.manifest,
    })
    await emptyReservationHarness.metadataStore.beginChunkWrite(
      Object.freeze({
        sessionId: emptyReservationSession.sessionId,
        ...DEFAULT_AUTHORITY,
      }),
      {
        chunkIndex: 0,
        chunkDigest: emptyReservationData.manifest.chunks[0].chunkDigest,
        byteCount: emptyReservationData.manifest.chunks[0].byteCount,
        writeToken: D('empty-reservation-token'),
      },
    )
    assert.deepEqual(
      (await emptyReservationHarness.service.resumeSession({
        sessionId: emptyReservationSession.sessionId,
      })).acceptedChunkIndexes,
      [],
    )
    assert.equal(emptyReservationMemory.rows(SESSION_TABLE)[0].status, 'UPLOADING')

    // Failure injection: completion persistence cannot create a false complete.
    const completionFailureMemory = makeMemoryDb()
    const completionFailureRoot = path.join(tempRoot, 'completion-failure')
    const completionFailureData = fixture('completion-failure', expiresAt)
    const completionFailureHarness = buildHarness(
      completionFailureRoot,
      completionFailureMemory,
      clock,
    )
    const completionFailureSession = await completionFailureHarness.service.createSession({
      envelope: completionFailureData.envelope,
      manifest: completionFailureData.manifest,
    })
    await submitAll(
      completionFailureHarness.service,
      completionFailureData,
      completionFailureSession.sessionId,
    )
    completionFailureMemory.failNext(`update:${SESSION_TABLE}`)
    await refuses(
      () => completionFailureHarness.service.completeSession({
        sessionId: completionFailureSession.sessionId,
      }),
      'SEALED_EXPORT_INTERNAL_ERROR',
      'completion persistence failure',
    )
    assert.equal(completionFailureMemory.rows(SESSION_TABLE)[0].status, 'UPLOADING')
    const completionRetry = await completionFailureHarness.service.completeSession({
      sessionId: completionFailureSession.sessionId,
    })
    assert.equal(completionRetry.status, 'UPLOAD_COMPLETE')

    // Failure injection: bytes are removed only after the durable CLEANING fence;
    // a metadata failure leaves that state retryable without orphaning bytes.
    const cleanupMetadataMemory = makeMemoryDb()
    const cleanupMetadataRoot = path.join(tempRoot, 'cleanup-metadata-failure')
    const cleanupMetadataData = fixture('cleanup-metadata-failure', expiresAt)
    const cleanupMetadataHarness = buildHarness(
      cleanupMetadataRoot,
      cleanupMetadataMemory,
      clock,
    )
    const cleanupMetadataSession = await cleanupMetadataHarness.service.createSession({
      envelope: cleanupMetadataData.envelope,
      manifest: cleanupMetadataData.manifest,
    })
    await submitAll(
      cleanupMetadataHarness.service,
      cleanupMetadataData,
      cleanupMetadataSession.sessionId,
    )
    await cleanupMetadataHarness.service.completeSession({
      sessionId: cleanupMetadataSession.sessionId,
    })
    cleanupMetadataMemory.failNext(`insert:${TOMBSTONE_TABLE}`)
    await refuses(
      () => cleanupMetadataHarness.service.cleanupSession({
        sessionId: cleanupMetadataSession.sessionId,
      }),
      'SEALED_EXPORT_INTERNAL_ERROR',
      'cleanup metadata failure',
    )
    assert.equal(cleanupMetadataMemory.rows(SESSION_TABLE)[0].status, 'CLEANING')
    assert.equal(cleanupMetadataMemory.rows(TOMBSTONE_TABLE).length, 0)
    await assert.rejects(
      fs.stat(path.join(cleanupMetadataRoot, cleanupMetadataSession.sessionId)),
      { code: 'ENOENT' },
    )
    const cleanupMetadataRetry = await cleanupMetadataHarness.service.cleanupSession({
      sessionId: cleanupMetadataSession.sessionId,
    })
    assert.equal(cleanupMetadataRetry.outcome, 'CLEANED')

    // Failure injection: the CLEANING session itself preserves replay protection
    // while a failed private-byte removal remains retryable.
    const cleanupFailureMemory = makeMemoryDb()
    const cleanupFailureRoot = path.join(tempRoot, 'cleanup-failure')
    const realCleanupBlob = createPrivateIngestionBlobStore({ rootDir: cleanupFailureRoot })
    let failRemove = true
    const cleanupFailureBlob = Object.freeze({
      createSessionArea: realCleanupBlob.createSessionArea,
      readChunk: realCleanupBlob.readChunk,
      readChunkIfPresent: realCleanupBlob.readChunkIfPresent,
      writeChunk: realCleanupBlob.writeChunk,
      async removeSession(...args) {
        if (failRemove) {
          failRemove = false
          vocabulary.failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
        }
        return realCleanupBlob.removeSession(...args)
      },
    })
    const cleanupFailureData = fixture('cleanup-failure', expiresAt)
    const cleanupFailureHarness = buildHarness(
      cleanupFailureRoot,
      cleanupFailureMemory,
      clock,
      cleanupFailureBlob,
    )
    const cleanupFailureSession = await cleanupFailureHarness.service.createSession({
      envelope: cleanupFailureData.envelope,
      manifest: cleanupFailureData.manifest,
    })
    await submitAll(
      cleanupFailureHarness.service,
      cleanupFailureData,
      cleanupFailureSession.sessionId,
    )
    await cleanupFailureHarness.service.completeSession({
      sessionId: cleanupFailureSession.sessionId,
    })
    await refuses(
      () => cleanupFailureHarness.service.cleanupSession({
        sessionId: cleanupFailureSession.sessionId,
      }),
      'SEALED_EXPORT_STAGING_WRITE_FAILED',
      'private cleanup failure',
    )
    assert.equal(cleanupFailureMemory.rows(SESSION_TABLE)[0].status, 'CLEANING')
    assert.equal(cleanupFailureMemory.rows(TOMBSTONE_TABLE).length, 0)
    await refuses(
      () => cleanupFailureHarness.service.createSession({
        envelope: cleanupFailureData.envelope,
        manifest: cleanupFailureData.manifest,
      }),
      'SEALED_EXPORT_MANIFEST_REPLAYED',
      'cleanup failure still blocks replay',
    )
    const cleanupRetry = await cleanupFailureHarness.service.cleanupSession({
      sessionId: cleanupFailureSession.sessionId,
    })
    assert.equal(cleanupRetry.outcome, 'CLEANED')
    await assert.rejects(
      fs.stat(path.join(cleanupFailureRoot, cleanupFailureSession.sessionId)),
      { code: 'ENOENT' },
    )

    console.log('sealed-export-s3-private-ingestion.test.cjs OK')
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
