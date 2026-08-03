'use strict'

// #4690 acceptance: hermetic S5 capture core → S3 private ingestion → S4.
// Hermetic only. Reuses S3/S4 services; no runtime wiring, routes, or duplicated
// ingestion/generation implementations.
//
// 1) Capture once via the non-product hermetic core → interrupt after ≥1 receipt →
//    resume from receipts + frozen chunks (no second source read) →
//    stageAndSeal verifies the signed hermetic manifest.
// 2) Independent tamper gates (binding, chunk, totalRows, whole artifact,
//    rowset) each fail at their own reason, with a clean positive control so
//    gates cannot mask each other.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const SEALED_DIR = path.join(__dirname, '..', 'lib', 'sealed-export')
const contracts = require(path.join(SEALED_DIR, 'contracts.cjs'))
const digests = require(path.join(SEALED_DIR, 'digests.cjs'))
const vocabulary = require(path.join(SEALED_DIR, 'failure-vocabulary.cjs'))
const {
  createEd25519SignerMaterial,
} = require(path.join(SEALED_DIR, 'sealed-export-signer-authority.cjs'))
const {
  computeQueryBindingDigest,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
} = require(path.join(SEALED_DIR, 'sqlserver-sealed-snapshot-action.cjs'))
const {
  createHermeticSqlServerSealedSnapshotServiceForTests:
    createSqlServerSealedSnapshotService,
} = require('./support/sealed-export-s5-hermetic-service.cjs')
const {
  AUTHORITY_STATE_TABLE: S5_AUTHORITY_STATE_TABLE,
  createSignerAuthorityStore,
} = require(path.join(
  SEALED_DIR,
  'sealed-export-signer-authority-store.cjs',
))
const {
  createMemorySignerAuthorityDb,
} = require('./support/sealed-export-signer-authority-memory-db.cjs')
const {
  createPrivateIngestionMetadataStore,
  SESSION_TABLE,
  RECEIPT_TABLE,
  TOMBSTONE_TABLE,
} = require(path.join(SEALED_DIR, 'private-ingestion-metadata-store.cjs'))
const {
  createPrivateIngestionBlobStore,
} = require(path.join(SEALED_DIR, 'private-ingestion-blob-store.cjs'))
// UNBRANDED CORES + the inert verifier projection. The publicly-exported
// `…ForTests` verifier grant this suite used to call is DELETED (#4636
// residual); `verify()` behaviour is unchanged.
const {
  createPrivateIngestionManifestVerifier,
} = require(path.join(SEALED_DIR, 'private-ingestion-manifest-verifier.cjs'))
const {
  createPrivateIngestionServiceCore,
} = require(path.join(SEALED_DIR, 'private-ingestion-service.cjs'))
const {
  createGenerationStore,
  GENERATION_TABLE,
  STAGING_ROW_TABLE,
  GENERATION_ROW_TABLE,
  AUTHORITY_STATE_TABLE,
  ACTIVE_POINTER_TABLE,
  AUDIT_TABLE,
} = require(path.join(SEALED_DIR, 'generation-store.cjs'))
const {
  createSealedExportGenerationKernelCore,
} = require(path.join(SEALED_DIR, 'generation-kernel.cjs'))

const OBJECT_KEY = 'orders.lines'
const RELATION_ID = 'sqlserver.relation.rowid_payload.v1'
const TABLE_REF = 'dbo.orders_lines'
const SYSTEM_CONTENT_KEY = 's5-system-content'
const CONFIG_CONTENT_KEY = 's5-config-content'
const CANONICAL_OBJECT_VERSION = 's5-object-v1'
const TENANT_DOMAIN = 's5-tenant-domain'
const ROLE_BINDING = 's5-role-binding'
const TENANT_ID = 'tenant-s5'
const BASE_TIME = Date.parse('2026-07-30T00:00:00.000Z')
const EVIDENCE_KEY = crypto
  .createHash('sha256')
  .update('s5-product-s3-s4-evidence-key')
  .digest()

const AUTHORITY = Object.freeze({
  tenantId: TENANT_ID,
  workspaceId: null,
  tenantDomainBinding: TENANT_DOMAIN,
  systemContentKey: SYSTEM_CONTENT_KEY,
  roleBindingFingerprint: ROLE_BINDING,
})

function clone(value) {
  return structuredClone(value)
}

function makeMemoryDb() {
  const tables = new Map([
    [SESSION_TABLE, []],
    [RECEIPT_TABLE, []],
    [TOMBSTONE_TABLE, []],
    [GENERATION_TABLE, []],
    [STAGING_ROW_TABLE, []],
    [GENERATION_ROW_TABLE, []],
    [AUTHORITY_STATE_TABLE, []],
    [ACTIVE_POINTER_TABLE, []],
    [AUDIT_TABLE, []],
  ])
  let transactionTail = Promise.resolve()

  function matches(row, where) {
    if (!where) return true
    return Object.keys(where).every((key) => row[key] === where[key])
  }

  function scopeIdentity(row) {
    return [
      row.tenant_id,
      row.workspace_id,
      row.tenant_domain_binding,
      row.system_content_key,
      row.role_binding_fingerprint,
    ].join('\n')
  }

  function identities(table, row) {
    if (table === SESSION_TABLE || table === TOMBSTONE_TABLE) {
      return [
        `id:${row.session_id}`,
        `manifest:${scopeIdentity(row)}\n${row.manifest_digest}`,
      ]
    }
    if (table === RECEIPT_TABLE) {
      return [`receipt:${row.session_id}\n${row.chunk_index}`]
    }
    if (table === GENERATION_TABLE) {
      return [
        `id:${row.generation_id}`,
        `session:${row.session_id}`,
        `manifest:${scopeIdentity(row)}\n${row.manifest_digest}`,
      ]
    }
    if (table === STAGING_ROW_TABLE || table === GENERATION_ROW_TABLE) {
      return [`row:${row.generation_id}\n${row.row_index}`]
    }
    if (table === AUTHORITY_STATE_TABLE) {
      return [`authority:${scopeIdentity(row)}`]
    }
    if (table === ACTIVE_POINTER_TABLE) {
      return [
        `id:${row.pointer_id}`,
        `scope:${scopeIdentity(row)}\n${row.canonical_object_version}`,
      ]
    }
    if (table === AUDIT_TABLE) {
      return [
        `id:${row.audit_id}`,
        `event:${row.generation_id}\n${row.event_type}`,
      ]
    }
    return []
  }

  function compareValues(left, right) {
    if (left instanceof Uint8Array && right instanceof Uint8Array) {
      return Buffer.compare(Buffer.from(left), Buffer.from(right))
    }
    if (left < right) return -1
    if (left > right) return 1
    return 0
  }

  async function select(table, options) {
    const settings = options || {}
    let rows = tables.get(table).filter((row) => matches(row, settings.where))
    if (settings.range) {
      rows = rows.filter((row) =>
        Object.keys(settings.range).every((column) => {
          const bounds = settings.range[column]
          if (bounds.gte !== undefined && row[column] < bounds.gte) return false
          if (bounds.lte !== undefined && row[column] > bounds.lte) return false
          return true
        }),
      )
    }
    if (settings.orderBy) {
      const [column, direction] = settings.orderBy
      rows = rows.slice().sort((left, right) => {
        const order = compareValues(left[column], right[column])
        return direction === 'DESC' ? -order : order
      })
    }
    const offset = Number.isSafeInteger(settings.offset) ? settings.offset : 0
    rows = Number.isSafeInteger(settings.limit)
      ? rows.slice(offset, offset + settings.limit)
      : rows.slice(offset)
    return clone(rows)
  }

  async function selectOne(table, where) {
    const rows = await select(table, { where, limit: 1 })
    return rows[0] || null
  }

  async function insertOne(table, rawRow) {
    const row = clone(rawRow)
    if (table === SESSION_TABLE) {
      row.generation_claim_id = null
      row.generation_claimed_at = null
    }
    const rowIdentities = identities(table, row)
    if (
      tables.get(table).some((candidate) => {
        const candidateIdentities = identities(table, candidate)
        return rowIdentities.some((identity) =>
          candidateIdentities.includes(identity),
        )
      })
    ) {
      const error = new Error('synthetic unique violation')
      error.code = '23505'
      throw error
    }
    tables.get(table).push(row)
    return [clone(row)]
  }

  async function insertMany(table, rows) {
    const inserted = []
    for (let index = 0; index < rows.length; index += 1) {
      inserted.push((await insertOne(table, rows[index]))[0])
    }
    return inserted
  }

  async function updateRow(table, set, where) {
    const updated = []
    for (const row of tables.get(table)) {
      if (!matches(row, where)) continue
      Object.assign(row, clone(set))
      updated.push(clone(row))
    }
    return updated
  }

  async function deleteRows(table, where) {
    const rows = tables.get(table)
    const deleted = rows.filter((row) => matches(row, where))
    tables.set(
      table,
      rows.filter((row) => !matches(row, where)),
    )
    return clone(deleted)
  }

  async function countRows(table, where) {
    return tables.get(table).filter((row) => matches(row, where)).length
  }

  const api = {
    select,
    selectOne,
    selectOneForUpdate: selectOne,
    insertOne,
    insertMany,
    updateRow,
    deleteRows,
    countRows,
    async transaction(callback) {
      const previous = transactionTail
      let release
      transactionTail = new Promise((resolve) => {
        release = resolve
      })
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
    rows(table) {
      return clone(tables.get(table))
    },
  })
}

function sourceRows(count = 600) {
  // Large enough to force multiple production-sized 1 MiB chunks; interrupt
  // and resume must not depend on a test-only reduced chunk size.
  return Array.from({ length: count }, (_, index) => ({
    __databaseId: 7,
    __isolationLevel: 5,
    __productMajor: 16,
    __sessionId: 41,
    __snapshotEnabledState: 1,
    __transactionId: '9001',
    payload: `s5-payload-${String(index).padStart(4, '0')}-${'y'.repeat(3000)}`,
    payloadVersion: 1,
    rowId: index + 1,
  }))
}

async function captureProductPackageOnce() {
  const material = createEd25519SignerMaterial()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 's5-product-capture-'))
  const authorityDb = createMemorySignerAuthorityDb()
  const authorityStore = createSignerAuthorityStore({ db: authorityDb })
  await authorityStore.enrollPublicKey(AUTHORITY, {
    publicKey: material.publicKey,
    signerKeyId: material.signerKeyId,
  })
  const queryDigest = computeQueryBindingDigest({
    objectKey: OBJECT_KEY,
    relationId: RELATION_ID,
    tableRef: TABLE_REF,
  })
  const service = createSqlServerSealedSnapshotService({
    tenantId: TENANT_ID,
    workspaceId: null,
    systemContentKey: SYSTEM_CONTENT_KEY,
    artifactRoot: root,
    hermeticCapture: { rows: sourceRows(), snapshotCapable: true },
    qualificationKeyring: {
      keyId: 's5-product-s3-s4-keyring',
      secret: crypto.randomBytes(32),
    },
    approvedBindings: [
      {
        objectKey: OBJECT_KEY,
        relationId: RELATION_ID,
        tableRef: TABLE_REF,
        approvedConfigVersionId: 's5-config-v1',
        bindingVersion: 's5-binding-v1',
        configContentKey: CONFIG_CONTENT_KEY,
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        roleBindingFingerprint: ROLE_BINDING,
        tenantDomainBinding: TENANT_DOMAIN,
      },
    ],
    authorityDb,
    privateSignerMaterials: [
      { privateKey: material.privateKey, signerKeyId: material.signerKeyId },
    ],
  })
  try {
    const qualification = await service.probeQualificationForBinding(OBJECT_KEY)
    service.verifyQualificationForBinding(OBJECT_KEY, qualification)
    await authorityDb.insertOne(S5_AUTHORITY_STATE_TABLE, {
      tenant_id: TENANT_ID,
      workspace_id: null,
      tenant_domain_binding: TENANT_DOMAIN,
      system_content_key: SYSTEM_CONTENT_KEY,
      role_binding_fingerprint: ROLE_BINDING,
      signer_key_id: material.signerKeyId,
      signer_status: 'ACTIVE',
      signer_expires_at: '2099-01-01T00:00:00.000Z',
      binding_current: true,
      binding_expires_at: '2099-01-01T00:00:00.000Z',
      qualification_digest: qualification.qualificationDigest,
      qualification_current: true,
      qualification_expires_at: qualification.expiresAt,
    })
    const envelope = {
      exportRequestId: 's5-export-request',
      nonce: 's5-nonce',
      expiry: '2099-01-01T00:00:00.000Z',
      scenarioVersion: 's5-scenario-v1',
      bindingVersion: 's5-binding-v1',
      roleId: 's5-source',
      actionProfileVersion: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
      roleBindingFingerprint: ROLE_BINDING,
      systemContentKey: SYSTEM_CONTENT_KEY,
      approvedConfigVersionId: 's5-config-v1',
      configContentKey: CONFIG_CONTENT_KEY,
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      qualificationDigest: qualification.qualificationDigest,
      executionMode: 'S5_CERTIFICATION',
      applyProfileVersion: 'NO_APPLY',
      queryObjectFilterBindingDigest: queryDigest,
      expectedSourceSchemaFieldMapDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
      tenantDomainBinding: TENANT_DOMAIN,
      rowBudget: 1000,
      byteBudget: 4 * 1024 * 1024,
      chunkBudget: 100,
    }
    const result = await service.execute({ envelope })
    assert.equal(result.evidence.dataStreamReadCount, 1)
    assert.ok(
      result.manifest.chunks.length >= 2,
      'hermetic capture must yield ≥2 chunks for interrupt/resume',
    )
    const chunks = []
    for (const chunkPath of result.artifact.chunkPaths) {
      chunks.push(await fs.readFile(chunkPath))
    }
    // Freeze the hermetic capture surface away from its private directory.
    return Object.freeze({
      chunks: Object.freeze(chunks.map((bytes) => Buffer.from(bytes))),
      envelope: Object.freeze(structuredClone(envelope)),
      evidence: result.evidence,
      manifest: Object.freeze(structuredClone(result.manifest)),
      material,
      dataStreamReadCount: result.evidence.dataStreamReadCount,
    })
  } finally {
    await fs.rm(root, { force: true, recursive: true })
  }
}

function resignManifest(draft, privateKey) {
  const unsigned = { ...draft, signature: 'AA==' }
  const signature = crypto
    .sign(null, contracts.computeSignedManifestBytes(unsigned), privateKey)
    .toString('base64')
  return Object.freeze({
    ...unsigned,
    signature,
    signatureAlgorithm: 'ED25519',
  })
}

// Unique session identity without a second source read: rebind envelope
// coordinates and re-sign over the same frozen chunks/digests.
function rebindPackage(pkg, label, manifestOverrides = {}) {
  const envelope = Object.freeze({
    ...pkg.envelope,
    exportRequestId: `s5-export-${label}`,
    nonce: `s5-nonce-${label}`,
  })
  const draft = {
    ...pkg.manifest,
    ...manifestOverrides,
    exportRequestEnvelopeDigest:
      contracts.computeExportRequestEnvelopeDigest(envelope),
    signature: 'AA==',
  }
  return Object.freeze({
    chunks: pkg.chunks,
    envelope,
    material: pkg.material,
    manifest: resignManifest(draft, pkg.material.privateKey),
  })
}

async function refuses(action, expectedReason, label) {
  let caught = null
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(
    caught instanceof vocabulary.SealedExportError,
    `expected sealed refusal: ${label}`,
  )
  assert.equal(caught.reason, expectedReason, `reason for ${label}`)
  if (expectedReason === 'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH') {
    return caught
  }
  return caught
}

async function openHarness(pkg) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 's5-s3-s4-'))
  let nowMs = BASE_TIME
  const clock = () => new Date(nowMs)
  const memory = makeMemoryDb()
  const metadataStore = createPrivateIngestionMetadataStore({ db: memory.api })
  const blobStore = createPrivateIngestionBlobStore({ rootDir })
  const manifestVerifier = createPrivateIngestionManifestVerifier(
    {
      signerKeys: [
        {
          signerKeyId: pkg.material.signerKeyId,
          publicKey: pkg.material.publicKey,
        },
      ],
    },
  )
  const ingestionService = createPrivateIngestionServiceCore({
    metadataStore,
    blobStore,
    manifestVerifier,
    authority: AUTHORITY,
    clock,
  })
  const generationStore = createGenerationStore({ db: memory.api })
  const kernel = createSealedExportGenerationKernelCore({
    generationStore,
    ingestionSource: ingestionService,
    authority: AUTHORITY,
    evidenceKey: EVIDENCE_KEY,
    clock,
  })
  const expiresAt = new Date(nowMs + 60 * 60 * 1000).toISOString()
  await memory.api.insertOne(AUTHORITY_STATE_TABLE, {
    tenant_id: AUTHORITY.tenantId,
    workspace_id: AUTHORITY.workspaceId,
    tenant_domain_binding: AUTHORITY.tenantDomainBinding,
    system_content_key: AUTHORITY.systemContentKey,
    role_binding_fingerprint: AUTHORITY.roleBindingFingerprint,
    signer_key_id: pkg.material.signerKeyId,
    signer_status: 'ACTIVE',
    signer_expires_at: expiresAt,
    binding_current: true,
    binding_expires_at: expiresAt,
    qualification_digest: pkg.envelope.qualificationDigest,
    qualification_current: true,
    qualification_expires_at: expiresAt,
    updated_at: new Date(nowMs).toISOString(),
  })
  return Object.freeze({
    blobStore,
    clock,
    ingestionService,
    kernel,
    memory,
    rootDir,
    async close() {
      await fs.rm(rootDir, { force: true, recursive: true })
    },
  })
}

async function submitAllChunks(service, data, sessionId) {
  for (let index = 0; index < data.chunks.length; index += 1) {
    await service.submitChunk({
      sessionId,
      chunkIndex: index,
      bytes: data.chunks[index],
    })
  }
}

async function submitCompleteAndSeal(harness, data) {
  const created = await harness.ingestionService.createSession({
    envelope: data.envelope,
    manifest: data.manifest,
  })
  await submitAllChunks(harness.ingestionService, data, created.sessionId)
  const completed = await harness.ingestionService.completeSession({
    sessionId: created.sessionId,
  })
  assert.equal(completed.status, 'UPLOAD_COMPLETE')
  assert.equal(completed.artifactDigestVerified, true)
  const sealed = await harness.kernel.stageAndSeal({
    sessionId: created.sessionId,
  })
  assert.equal(sealed.status, 'SEALED')
  assert.equal(sealed.rowCount, data.manifest.totalRows)
  assert.equal(sealed.externalWrite, false)
  return Object.freeze({
    generationId: sealed.generationId,
    sessionId: created.sessionId,
  })
}

async function interruptedResumeWithoutSecondSourceRead(pkg) {
  const data = rebindPackage(pkg, 'resume-path')
  const harness = await openHarness(pkg)
  try {
    const created = await harness.ingestionService.createSession({
      envelope: data.envelope,
      manifest: data.manifest,
    })
    // Interrupt after the first accepted chunk (receipt durable; source not re-read).
    const first = await harness.ingestionService.submitChunk({
      sessionId: created.sessionId,
      chunkIndex: 0,
      bytes: data.chunks[0],
    })
    assert.equal(first.decision, 'ACCEPT')
    assert.equal(first.acceptedChunkCount, 1)

    const resumed = await harness.ingestionService.resumeSession({
      sessionId: created.sessionId,
    })
    assert.deepEqual(resumed.acceptedChunkIndexes, [0])
    assert.equal(resumed.acceptedChunkCount, 1)

    // Remaining chunks come only from the frozen hermetic artifact.
    for (let index = 1; index < data.chunks.length; index += 1) {
      const outcome = await harness.ingestionService.submitChunk({
        sessionId: created.sessionId,
        chunkIndex: index,
        bytes: data.chunks[index],
      })
      assert.equal(outcome.decision, 'ACCEPT')
    }
    // Idempotent replay of the first receipt does not re-touch source.
    const replay = await harness.ingestionService.submitChunk({
      sessionId: created.sessionId,
      chunkIndex: 0,
      bytes: data.chunks[0],
    })
    assert.equal(replay.decision, 'IDEMPOTENT_REPLAY')

    const completed = await harness.ingestionService.completeSession({
      sessionId: created.sessionId,
    })
    assert.equal(completed.status, 'UPLOAD_COMPLETE')
    assert.equal(completed.chunkCount, data.manifest.chunks.length)

    const sealed = await harness.kernel.stageAndSeal({
      sessionId: created.sessionId,
    })
    assert.equal(sealed.status, 'SEALED')
    assert.equal(sealed.rowCount, data.manifest.totalRows)
    assert.equal(pkg.dataStreamReadCount, 1)
    assert.equal(pkg.evidence.dataStreamReadCount, 1)
  } finally {
    await harness.close()
  }
}

async function independentTamperGatesWithPositiveControls(pkg) {
  // Positive control first: the hermetic package seals cleanly through S3+S4.
  {
    const data = rebindPackage(pkg, 'positive-control')
    const harness = await openHarness(pkg)
    try {
      await submitCompleteAndSeal(harness, data)
    } finally {
      await harness.close()
    }
  }

  // 1) Manifest binding mismatch (envelope digest vs signed binding).
  {
    const data = rebindPackage(pkg, 'binding-tamper')
    const harness = await openHarness(pkg)
    try {
      const badEnvelope = Object.freeze({
        ...data.envelope,
        configContentKey: 'tampered-config-content-key',
      })
      await refuses(
        () =>
          harness.ingestionService.createSession({
            envelope: badEnvelope,
            manifest: data.manifest,
          }),
        'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
        'manifest binding gate',
      )
      // Positive: correct binding on same frozen artifact still works.
      await submitCompleteAndSeal(
        harness,
        rebindPackage(pkg, 'binding-positive'),
      )
    } finally {
      await harness.close()
    }
  }

  // 2) Chunk bytes / digest (S4 recomputes; does not trust receipts alone).
  {
    const data = rebindPackage(pkg, 'chunk-tamper')
    const harness = await openHarness(pkg)
    try {
      const created = await harness.ingestionService.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      })
      await submitAllChunks(harness.ingestionService, data, created.sessionId)
      await harness.ingestionService.completeSession({
        sessionId: created.sessionId,
      })
      const chunkPath = path.join(harness.rootDir, created.sessionId, 'chunk-0.bin')
      const original = await fs.readFile(chunkPath)
      const tampered = Buffer.from(original)
      tampered[0] ^= 0xff
      await fs.writeFile(chunkPath, tampered)
      await refuses(
        () => harness.kernel.stageAndSeal({ sessionId: created.sessionId }),
        'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
        'chunk byte/digest gate',
      )
      await submitCompleteAndSeal(harness, rebindPackage(pkg, 'chunk-positive'))
    } finally {
      await harness.close()
    }
  }

  // 3) totalRows (S4 counts canonical rows independently).
  {
    const data = rebindPackage(pkg, 'row-count-tamper', {
      totalRows: pkg.manifest.totalRows + 1,
    })
    const harness = await openHarness(pkg)
    try {
      const created = await harness.ingestionService.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      })
      await submitAllChunks(harness.ingestionService, data, created.sessionId)
      await harness.ingestionService.completeSession({
        sessionId: created.sessionId,
      })
      await refuses(
        () => harness.kernel.stageAndSeal({ sessionId: created.sessionId }),
        'SEALED_EXPORT_ROW_COUNT_MISMATCH',
        'totalRows gate',
      )
      await submitCompleteAndSeal(
        harness,
        rebindPackage(pkg, 'row-count-positive'),
      )
    } finally {
      await harness.close()
    }
  }

  // 4) wholeArtifactByteDigest (must not be masked by chunk descriptors alone).
  {
    const bogusWhole = digests.digestBytes(
      Buffer.from('s5-tampered-whole-artifact'),
    ).digest
    const data = rebindPackage(pkg, 'artifact-digest-tamper', {
      wholeArtifactByteDigest: bogusWhole,
    })
    const harness = await openHarness(pkg)
    try {
      const created = await harness.ingestionService.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      })
      await submitAllChunks(harness.ingestionService, data, created.sessionId)
      // S3 complete rechecks whole-artifact against chunk bytes.
      await refuses(
        () =>
          harness.ingestionService.completeSession({
            sessionId: created.sessionId,
          }),
        'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH',
        'whole artifact digest gate (S3 complete)',
      )
      await submitCompleteAndSeal(
        harness,
        rebindPackage(pkg, 'artifact-digest-positive'),
      )
    } finally {
      await harness.close()
    }
  }

  // 5) rowset multiplicity digest (S4 recomputes multiset; not checked at S3 complete).
  {
    const bogusRowset = digests.digestBytes(
      Buffer.from('s5-tampered-rowset-multiplicity'),
    ).digest
    const data = rebindPackage(pkg, 'rowset-digest-tamper', {
      canonicalRowsetMultiplicityDigest: bogusRowset,
    })
    const harness = await openHarness(pkg)
    try {
      const created = await harness.ingestionService.createSession({
        envelope: data.envelope,
        manifest: data.manifest,
      })
      await submitAllChunks(harness.ingestionService, data, created.sessionId)
      await harness.ingestionService.completeSession({
        sessionId: created.sessionId,
      })
      const caught = await refuses(
        () => harness.kernel.stageAndSeal({ sessionId: created.sessionId }),
        'SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH',
        'rowset digest gate',
      )
      assert.equal(
        caught.details && caught.details.field,
        'canonicalRowsetMultiplicityDigest',
        'rowset gate names its own field (not wholeArtifact)',
      )
      await submitCompleteAndSeal(
        harness,
        rebindPackage(pkg, 'rowset-digest-positive'),
      )
    } finally {
      await harness.close()
    }
  }
}

async function main() {
  const pkg = await captureProductPackageOnce()
  assert.equal(
    pkg.dataStreamReadCount,
    1,
    'hermetic capture is exactly one data-stream read',
  )
  assert.ok(pkg.manifest.chunks.length >= 2)
  assert.equal(pkg.chunks.length, pkg.manifest.chunks.length)

  await interruptedResumeWithoutSecondSourceRead(pkg)
  // Still exactly one hermetic source read after resume (no re-execute).
  assert.equal(pkg.dataStreamReadCount, 1)

  await independentTamperGatesWithPositiveControls(pkg)
  assert.equal(pkg.dataStreamReadCount, 1)

  console.log('sealed-export-s5-product-to-s3-s4-integration.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
