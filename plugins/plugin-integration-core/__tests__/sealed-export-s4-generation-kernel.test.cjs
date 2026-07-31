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
  createGenerationStore,
  GENERATION_TABLE,
  STAGING_ROW_TABLE,
  GENERATION_ROW_TABLE,
  AUTHORITY_STATE_TABLE,
  ACTIVE_POINTER_TABLE,
  AUDIT_TABLE,
} = require(path.join(SEALED_DIR, 'generation-store.cjs'))
const {
  createSealedExportGenerationKernel,
  LEASE_DURATION_MS,
  ROW_BATCH_SIZE,
} = require(path.join(SEALED_DIR, 'generation-kernel.cjs'))
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
  createHarnessPrivateIngestionManifestVerifierForTests,
} = require(path.join(SEALED_DIR, 'private-ingestion-manifest-verifier.cjs'))
const {
  createPrivateIngestionService,
} = require(path.join(SEALED_DIR, 'private-ingestion-service.cjs'))

const D = (label) => crypto.createHash('sha256').update(`sealed-export-s4:${label}`).digest('hex')
const BASE_TIME = Date.parse('2026-07-30T00:00:00.000Z')
const SIGNER_KEY_ID = 'sx-s4-signer-key'
const SIGNER = crypto.generateKeyPairSync('ed25519')
const AUTHORITY = Object.freeze({
  tenantId: 'sx-s4-tenant',
  workspaceId: 'sx-s4-workspace',
  tenantDomainBinding: 'sx-s4-tenant-domain',
  systemContentKey: 'sx-s4-system',
  roleBindingFingerprint: 'sx-s4-role-binding',
})
const QUALIFICATION_DIGEST = D('qualification')
const CANONICAL_OBJECT_VERSION = 'sx-s4-canonical-object-v1'
const EVIDENCE_KEY = crypto.createHash('sha256').update('sx-s4-evidence-key').digest()
const MANIFEST_VERIFIER = createHarnessPrivateIngestionManifestVerifierForTests({
  signerKeys: [{
    signerKeyId: SIGNER_KEY_ID,
    publicKey: SIGNER.publicKey,
  }],
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
  const pendingFailures = new Map()
  let transactionTail = Promise.resolve()

  function consumeFailure(operation) {
    const remaining = pendingFailures.get(operation) || 0
    if (remaining === 0) return
    pendingFailures.set(operation, remaining - 1)
    const error = new Error('synthetic database failure')
    error.code = 'SYNTHETIC_DATABASE_FAILURE'
    throw error
  }

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
    consumeFailure(`insert:${table}`)
    const row = clone(rawRow)
    if (table === SESSION_TABLE) {
      row.generation_claim_id = null
      row.generation_claimed_at = null
    }
    const rowIdentities = identities(table, row)
    if (tables.get(table).some((candidate) => {
      const candidateIdentities = identities(table, candidate)
      return rowIdentities.some((identity) => candidateIdentities.includes(identity))
    })) {
      const error = new Error('synthetic unique violation')
      error.code = '23505'
      throw error
    }
    tables.get(table).push(row)
    return [clone(row)]
  }

  async function insertMany(table, rows) {
    consumeFailure(`insertMany:${table}`)
    const inserted = []
    for (let index = 0; index < rows.length; index += 1) {
      inserted.push((await insertOne(table, rows[index]))[0])
    }
    return inserted
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

  async function countRows(table, where) {
    consumeFailure(`count:${table}`)
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
    mutate(table, predicate, update) {
      const row = tables.get(table).find(predicate)
      assert.ok(row, `expected row to mutate in ${table}`)
      update(row)
    },
  })
}

function splitArtifact(artifact) {
  const unicode = artifact.indexOf(Buffer.from('值', 'utf8'))
  const first = unicode >= 0 ? unicode + 1 : Math.floor(artifact.length / 3)
  const second = Math.max(first + 1, Math.floor((artifact.length * 2) / 3))
  return [
    Buffer.from(artifact.subarray(0, first)),
    Buffer.from(artifact.subarray(first, second)),
    Buffer.from(artifact.subarray(second)),
  ]
}

function fixture(label, rowCount) {
  const expiresAt = new Date(BASE_TIME + 60 * 60 * 1000).toISOString()
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: index,
    marker: index === Math.floor(rowCount / 2)
      ? `sx-${label}-值`
      : `sx-${label}-${index % 7}`,
  }))
  const artifact = Buffer.from(
    `${rows.map((row) => codec.tryCanonicalJson(row).text).join('\n')}\n`,
    'utf8',
  )
  const chunks = splitArtifact(artifact)
  const envelope = {
    exportRequestId: `sx-${label}-request`,
    nonce: `sx-${label}-nonce`,
    expiry: expiresAt,
    scenarioVersion: 'sx-s4-scenario-v1',
    bindingVersion: 'sx-s4-binding-v1',
    roleId: 'sx-s4-role',
    actionProfileVersion: 'sx-s4-action-profile-v1',
    roleBindingFingerprint: AUTHORITY.roleBindingFingerprint,
    systemContentKey: AUTHORITY.systemContentKey,
    approvedConfigVersionId: 'sx-s4-approved-config-v1',
    configContentKey: D(`${label}-config`),
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    qualificationDigest: QUALIFICATION_DIGEST,
    executionMode: 'sx-s4-execution-mode',
    applyProfileVersion: 'sx-s4-apply-profile-v1',
    queryObjectFilterBindingDigest: D(`${label}-query-binding`),
    expectedSourceSchemaFieldMapDigest: D(`${label}-schema`),
    tenantDomainBinding: AUTHORITY.tenantDomainBinding,
    rowBudget: rowCount + 10,
    byteBudget: artifact.length + 100,
    chunkBudget: chunks.length,
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
    agentImplementationVersion: 'sx-s4-agent-v1',
    agentProtocolVersion: 'sx-s4-protocol-v1',
    encodingVersion: 'sx-s4-jsonl-v1',
    canonicalizationVersion: codec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    sourceSchemaDigest: envelope.expectedSourceSchemaFieldMapDigest,
    totalRows: rows.length,
    totalBytes: artifact.length,
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
  const manifest = {
    ...manifestDraft,
    signature: crypto.sign(
      null,
      contracts.computeSignedManifestBytes(manifestDraft),
      SIGNER.privateKey,
    ).toString('base64'),
  }
  return Object.freeze({ artifact, chunks, envelope, manifest, rows })
}

function withManifestOverrides(data, overrides) {
  const draft = {
    ...data.manifest,
    ...overrides,
    signature: 'AA==',
  }
  return Object.freeze({
    ...data,
    manifest: {
      ...draft,
      signature: crypto.sign(
        null,
        contracts.computeSignedManifestBytes(draft),
        SIGNER.privateKey,
      ).toString('base64'),
    },
  })
}

async function refuses(action, expectedReason, label) {
  let caught = null
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof vocabulary.SealedExportError, `sealed refusal: ${label}`)
  assert.equal(caught.reason, expectedReason, `reason: ${label}`)
  assert.equal(vocabulary.isTrustedSealedExportError(caught), true, `trusted error: ${label}`)
  return caught
}

async function submitComplete(service, data) {
  const created = await service.createSession({
    envelope: data.envelope,
    manifest: data.manifest,
  })
  for (let index = 0; index < data.chunks.length; index += 1) {
    await service.submitChunk({
      sessionId: created.sessionId,
      chunkIndex: index,
      bytes: data.chunks[index],
    })
  }
  await service.completeSession({ sessionId: created.sessionId })
  return created.sessionId
}

function authorityRow(nowMs) {
  const expiresAt = new Date(nowMs + 60 * 60 * 1000).toISOString()
  return {
    tenant_id: AUTHORITY.tenantId,
    workspace_id: AUTHORITY.workspaceId,
    tenant_domain_binding: AUTHORITY.tenantDomainBinding,
    system_content_key: AUTHORITY.systemContentKey,
    role_binding_fingerprint: AUTHORITY.roleBindingFingerprint,
    signer_key_id: SIGNER_KEY_ID,
    signer_status: 'ACTIVE',
    signer_expires_at: expiresAt,
    binding_current: true,
    binding_expires_at: expiresAt,
    qualification_digest: QUALIFICATION_DIGEST,
    qualification_current: true,
    qualification_expires_at: expiresAt,
    updated_at: new Date(nowMs).toISOString(),
  }
}

async function prepareGeneration(harness, label, rowCount) {
  const data = fixture(label, rowCount)
  const sessionId = await submitComplete(harness.ingestionService, data)
  const sealed = await harness.kernel.stageAndSeal({ sessionId })
  assert.equal(sealed.status, 'SEALED')
  assert.equal(sealed.rowCount, rowCount)
  assert.equal(sealed.externalWrite, false)
  return Object.freeze({ data, generationId: sealed.generationId, sessionId })
}

async function verifyGeneration(harness, generationId) {
  const lease = await harness.kernel.beginApply({ generationId })
  let result = await harness.kernel.applyNextChunk({ lease })
  while (result.status === 'APPLYING') {
    result = await harness.kernel.applyNextChunk({ lease })
  }
  assert.equal(result.status, 'VERIFIED')
  assert.equal(result.externalWrite, false)
  return result
}

async function main() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-export-s4-'))
  let nowMs = BASE_TIME
  const clock = () => new Date(nowMs)
  const memory = makeMemoryDb()
  const metadataStore = createPrivateIngestionMetadataStore({ db: memory.api })
  const ingestionService = createPrivateIngestionService({
    metadataStore,
    blobStore: createPrivateIngestionBlobStore({ rootDir }),
    manifestVerifier: MANIFEST_VERIFIER,
    authority: AUTHORITY,
    clock,
  })
  const generationStore = createGenerationStore({ db: memory.api })
  const kernel = createSealedExportGenerationKernel({
    generationStore,
    ingestionSource: ingestionService,
    authority: AUTHORITY,
    evidenceKey: EVIDENCE_KEY,
    clock,
  })
  const harness = { ingestionService, generationStore, kernel }

  try {
    await memory.api.insertOne(AUTHORITY_STATE_TABLE, authorityRow(nowMs))

    const concurrentData = fixture('concurrent-create', 2)
    const concurrentSessionId = await submitComplete(ingestionService, concurrentData)
    const concurrentCreators = await Promise.allSettled([
      kernel.stageAndSeal({ sessionId: concurrentSessionId }),
      kernel.stageAndSeal({ sessionId: concurrentSessionId }),
    ])
    assert.ok(
      concurrentCreators.some((entry) => entry.status === 'fulfilled'),
      'at least one concurrent generation creator completes',
    )
    assert.equal(
      memory.rows(GENERATION_TABLE)
        .filter((row) => row.session_id === concurrentSessionId).length,
      1,
      'concurrent generation creators persist one durable identity',
    )
    const durableGenerationId = memory.rows(GENERATION_TABLE)
      .find((row) => row.session_id === concurrentSessionId).generation_id
    assert.ok(
      concurrentCreators
        .filter((entry) => entry.status === 'fulfilled')
        .every((entry) => entry.value.generationId === durableGenerationId),
      'every successful concurrent creator observes the durable generation',
    )

    const first = await prepareGeneration(harness, 'first', ROW_BATCH_SIZE + 1)
    assert.deepEqual(
      await kernel.readActiveRows({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        offset: 0,
        limit: 10,
      }),
      [],
      'SEALED generation is invisible',
    )
    const firstLease = await kernel.beginApply({ generationId: first.generationId })
    const firstChunk = await kernel.applyNextChunk({ lease: firstLease })
    assert.deepEqual(firstChunk, {
      status: 'APPLYING',
      appliedRowCount: ROW_BATCH_SIZE,
      externalWrite: false,
    })
    assert.deepEqual(
      await kernel.readActiveRows({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        offset: 0,
        limit: 10,
      }),
      [],
      'partially applied generation is invisible',
    )
    const verifiedFirst = await kernel.applyNextChunk({ lease: firstLease })
    assert.equal(verifiedFirst.status, 'VERIFIED')
    assert.deepEqual(
      await kernel.readActiveRows({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        offset: 0,
        limit: 10,
      }),
      [],
      'VERIFIED generation is invisible before CAS',
    )
    const activeFirst = await kernel.activate({
      generationId: first.generationId,
      expectedActiveGenerationId: null,
    })
    assert.deepEqual(
      {
        status: activeFirst.status,
        rowCount: activeFirst.rowCount,
        pointerVersion: activeFirst.pointerVersion,
        activePointerOutcome: activeFirst.activePointerOutcome,
        externalWrite: activeFirst.externalWrite,
      },
      {
        status: 'ACTIVE',
        rowCount: ROW_BATCH_SIZE + 1,
        pointerVersion: 1,
        activePointerOutcome: 'FLIPPED',
        externalWrite: false,
      },
    )
    assert.deepEqual(
      await kernel.readActiveRows({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        offset: 0,
        limit: 2,
      }),
      first.data.rows.slice(0, 2),
      'readers follow only the active pointer',
    )

    const malformedReceipt = fixture('malformed-receipt', 2)
    const malformedReceiptSessionId = await submitComplete(
      ingestionService,
      malformedReceipt,
    )
    memory.mutate(
      RECEIPT_TABLE,
      (row) => row.session_id === malformedReceiptSessionId && row.chunk_index === 0,
      (row) => { row.byte_count += 1 },
    )
    await refuses(
      () => kernel.stageAndSeal({ sessionId: malformedReceiptSessionId }),
      'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
      'S4 independently verifies each persisted receipt against the manifest',
    )
    assert.equal(
      memory.rows(ACTIVE_POINTER_TABLE)[0].active_generation_id,
      first.generationId,
      'receipt mismatch leaves the previous generation active',
    )

    const tamperedArtifact = fixture('tampered-artifact', 2)
    const tamperedArtifactSessionId = await submitComplete(
      ingestionService,
      tamperedArtifact,
    )
    const tamperedChunk = Buffer.from(tamperedArtifact.chunks[0])
    tamperedChunk[0] ^= 1
    await fs.writeFile(
      path.join(rootDir, tamperedArtifactSessionId, 'chunk-0.bin'),
      tamperedChunk,
    )
    await refuses(
      () => kernel.stageAndSeal({ sessionId: tamperedArtifactSessionId }),
      'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
      'S4 recomputes chunk bytes instead of trusting the S3 receipt',
    )
    assert.equal(
      memory.rows(ACTIVE_POINTER_TABLE)[0].active_generation_id,
      first.generationId,
      'artifact tamper leaves the previous generation active',
    )

    const wrongCount = withManifestOverrides(
      fixture('wrong-row-count', 2),
      { totalRows: 3 },
    )
    const wrongCountSessionId = await submitComplete(ingestionService, wrongCount)
    await refuses(
      () => kernel.stageAndSeal({ sessionId: wrongCountSessionId }),
      'SEALED_EXPORT_ROW_COUNT_MISMATCH',
      'S4 independently counts canonical rows',
    )
    assert.equal(
      memory.rows(ACTIVE_POINTER_TABLE)[0].active_generation_id,
      first.generationId,
      'row-count mismatch leaves the previous generation active',
    )

    const replay = await kernel.stageAndSeal({ sessionId: first.sessionId })
    assert.equal(replay.generationId, first.generationId)
    assert.equal(
      memory.rows(GENERATION_TABLE)
        .filter((row) => row.session_id === first.sessionId).length,
      1,
      'one manifest creates one generation',
    )

    const revoked = await prepareGeneration(harness, 'revoked', 3)
    await verifyGeneration(harness, revoked.generationId)
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'REVOKED' },
    )
    await refuses(
      () => kernel.activate({
        generationId: revoked.generationId,
        expectedActiveGenerationId: first.generationId,
      }),
      'SEALED_EXPORT_SIGNER_REVOKED',
      'revocation immediately before activation',
    )
    assert.equal(
      memory.rows(ACTIVE_POINTER_TABLE)[0].active_generation_id,
      first.generationId,
      'pre-ACTIVE revocation leaves the previous generation active',
    )
    assert.equal(
      memory.rows(GENERATION_TABLE)
        .find((row) => row.generation_id === revoked.generationId).status,
      'QUARANTINED',
    )
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'ACTIVE' },
    )

    const stale = await prepareGeneration(harness, 'stale-lease', 4)
    const staleLease = await kernel.beginApply({ generationId: stale.generationId })
    const staleGeneration = memory.rows(GENERATION_TABLE)
      .find((row) => row.generation_id === stale.generationId)
    const staleLeaseIdentity = Object.freeze({
      token: staleGeneration.lease_token,
      fence: staleGeneration.lease_fence,
    })
    nowMs += LEASE_DURATION_MS + 1
    const currentLease = await kernel.beginApply({ generationId: stale.generationId })
    const staleUnleasedQuarantine = await generationStore.quarantineGeneration(
      staleGeneration,
      new Date(nowMs).toISOString(),
      Object.assign({
        audit_id: D('stale-unleased-quarantine'),
        event_type: 'QUARANTINED',
        reason: 'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
        row_count: 0,
        external_write: false,
        occurred_at: new Date(nowMs).toISOString(),
      }, {
        generation_id: staleGeneration.generation_id,
        tenant_id: staleGeneration.tenant_id,
        workspace_id: staleGeneration.workspace_id,
        tenant_domain_binding: staleGeneration.tenant_domain_binding,
        system_content_key: staleGeneration.system_content_key,
        role_binding_fingerprint: staleGeneration.role_binding_fingerprint,
        manifest_digest: staleGeneration.manifest_digest,
      }),
    )
    assert.equal(
      staleUnleasedQuarantine,
      null,
      'an unleased stale snapshot cannot quarantine a newer lease',
    )
    const staleQuarantine = await generationStore.quarantineGeneration(
      staleGeneration,
      new Date(nowMs).toISOString(),
      Object.assign({
        audit_id: D('stale-lease-quarantine'),
        event_type: 'QUARANTINED',
        reason: 'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
        row_count: 0,
        external_write: false,
        occurred_at: new Date(nowMs).toISOString(),
      }, {
        generation_id: staleGeneration.generation_id,
        tenant_id: staleGeneration.tenant_id,
        workspace_id: staleGeneration.workspace_id,
        tenant_domain_binding: staleGeneration.tenant_domain_binding,
        system_content_key: staleGeneration.system_content_key,
        role_binding_fingerprint: staleGeneration.role_binding_fingerprint,
        manifest_digest: staleGeneration.manifest_digest,
      }),
      staleLeaseIdentity,
    )
    assert.equal(
      staleQuarantine,
      null,
      'an expired owner cannot quarantine a generation held by a newer lease',
    )
    assert.equal(
      memory.rows(GENERATION_TABLE)
        .find((row) => row.generation_id === stale.generationId).status,
      'APPLYING',
      'the current lease remains usable after a stale quarantine attempt',
    )
    await refuses(
      () => kernel.applyNextChunk({ lease: staleLease }),
      'SEALED_EXPORT_APPLY_INCOMPLETE',
      'stale persisted lease fence',
    )
    assert.equal((await kernel.applyNextChunk({ lease: currentLease })).status, 'VERIFIED')

    const leasedRevoked = await prepareGeneration(
      harness,
      'leased-revoked',
      3,
    )
    const leasedRevokedHandle = await kernel.beginApply({
      generationId: leasedRevoked.generationId,
    })
    const leasedRevokedBefore = memory.rows(GENERATION_TABLE)
      .find((row) => row.generation_id === leasedRevoked.generationId)
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'REVOKED' },
    )
    await refuses(
      () => kernel.applyNextChunk({ lease: leasedRevokedHandle }),
      'SEALED_EXPORT_SIGNER_REVOKED',
      'leased authority quarantine invalidates the persisted fence',
    )
    const leasedRevokedAfter = memory.rows(GENERATION_TABLE)
      .find((row) => row.generation_id === leasedRevoked.generationId)
    assert.equal(leasedRevokedAfter.status, 'QUARANTINED')
    assert.equal(leasedRevokedAfter.lease_token, null)
    assert.equal(
      leasedRevokedAfter.lease_fence,
      leasedRevokedBefore.lease_fence + 1,
    )
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'ACTIVE' },
    )

    const expiredRevoked = await prepareGeneration(
      harness,
      'expired-lease-revoked',
      3,
    )
    await kernel.beginApply({ generationId: expiredRevoked.generationId })
    const expiredRevokedBefore = memory.rows(GENERATION_TABLE)
      .find((row) => row.generation_id === expiredRevoked.generationId)
    const activeBeforeExpiredRevocation = memory.rows(ACTIVE_POINTER_TABLE)[0]
      .active_generation_id
    nowMs += LEASE_DURATION_MS + 1
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'REVOKED' },
    )
    await refuses(
      () => kernel.beginApply({ generationId: expiredRevoked.generationId }),
      'SEALED_EXPORT_SIGNER_REVOKED',
      'expired lease cannot deadlock authority quarantine',
    )
    const expiredRevokedAfter = memory.rows(GENERATION_TABLE)
      .find((row) => row.generation_id === expiredRevoked.generationId)
    assert.equal(expiredRevokedAfter.status, 'QUARANTINED')
    assert.equal(expiredRevokedAfter.lease_token, null)
    assert.equal(
      expiredRevokedAfter.lease_fence,
      expiredRevokedBefore.lease_fence + 1,
      'unleased quarantine advances the persisted fence exactly once',
    )
    assert.equal(
      memory.rows(ACTIVE_POINTER_TABLE)[0].active_generation_id,
      activeBeforeExpiredRevocation,
      'expired-lease quarantine leaves the active pointer unchanged',
    )
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'ACTIVE' },
    )

    const concurrentLeaseGeneration = await prepareGeneration(
      harness,
      'concurrent-lease',
      3,
    )
    const concurrentLeases = await Promise.allSettled([
      kernel.beginApply({ generationId: concurrentLeaseGeneration.generationId }),
      kernel.beginApply({ generationId: concurrentLeaseGeneration.generationId }),
    ])
    assert.equal(
      concurrentLeases.filter((entry) => entry.status === 'fulfilled').length,
      1,
      'two concurrent lease claimants have exactly one winner',
    )
    assert.equal(
      concurrentLeases.filter((entry) => entry.status === 'rejected').length,
      1,
      'the losing lease claimant fails closed',
    )
    assert.equal(
      (await kernel.applyNextChunk({
        lease: concurrentLeases.find((entry) => entry.status === 'fulfilled').value,
      })).status,
      'VERIFIED',
    )

    const rollback = await prepareGeneration(harness, 'rollback', 5)
    const rollbackLease = await kernel.beginApply({ generationId: rollback.generationId })
    memory.failNext(`insertMany:${GENERATION_ROW_TABLE}`)
    await refuses(
      () => kernel.applyNextChunk({ lease: rollbackLease }),
      'SEALED_EXPORT_APPLY_INCOMPLETE',
      'row write and checkpoint rollback together',
    )
    assert.equal(
      memory.rows(GENERATION_TABLE)
        .find((row) => row.generation_id === rollback.generationId).applied_row_count,
      0,
    )
    assert.equal(
      memory.rows(GENERATION_ROW_TABLE)
        .filter((row) => row.generation_id === rollback.generationId).length,
      0,
    )
    assert.equal((await kernel.applyNextChunk({ lease: rollbackLease })).status, 'VERIFIED')

    for (const tamper of [
      ['sealed_receipt_set_digest', D('tampered-receipt-set')],
      ['sealed_artifact_digest', D('tampered-artifact-anchor')],
      ['sealed_row_count', 4],
    ]) {
      const candidate = await prepareGeneration(
        harness,
        `activation-anchor-${tamper[0]}`,
        3,
      )
      await verifyGeneration(harness, candidate.generationId)
      memory.mutate(
        GENERATION_TABLE,
        (row) => row.generation_id === candidate.generationId,
        (row) => { row[tamper[0]] = tamper[1] },
      )
      await refuses(
        () => kernel.activate({
          generationId: candidate.generationId,
          expectedActiveGenerationId: first.generationId,
        }),
        'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
        `activation rechecks ${tamper[0]}`,
      )
      assert.equal(
        memory.rows(ACTIVE_POINTER_TABLE)[0].active_generation_id,
        first.generationId,
        `${tamper[0]} mismatch leaves the previous generation active`,
      )
    }

    const left = await prepareGeneration(harness, 'cas-left', 2)
    const right = await prepareGeneration(harness, 'cas-right', 2)
    await verifyGeneration(harness, left.generationId)
    await verifyGeneration(harness, right.generationId)
    const contenders = await Promise.allSettled([
      kernel.activate({
        generationId: left.generationId,
        expectedActiveGenerationId: first.generationId,
      }),
      kernel.activate({
        generationId: right.generationId,
        expectedActiveGenerationId: first.generationId,
      }),
    ])
    assert.equal(contenders.filter((entry) => entry.status === 'fulfilled').length, 1)
    assert.equal(contenders.filter((entry) => entry.status === 'rejected').length, 1)
    assert.equal(
      contenders.find((entry) => entry.status === 'rejected').reason.reason,
      'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
    )
    const activeAfterCas = memory.rows(ACTIVE_POINTER_TABLE)[0].active_generation_id
    assert.ok(
      activeAfterCas === left.generationId || activeAfterCas === right.generationId,
      'exactly one contender owns the pointer',
    )
    const activeRow = memory.rows(GENERATION_ROW_TABLE)
      .find((row) => (
        row.generation_id === activeAfterCas
        && row.row_index === 0
      ))
    assert.ok(activeRow, 'active generation has its first row')
    memory.mutate(
      GENERATION_ROW_TABLE,
      (row) => row.generation_id === activeAfterCas && row.row_index === 0,
      (row) => { row.canonical_row_text = '{"tampered":true}' },
    )
    await refuses(
      () => kernel.readActiveRows({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        offset: 0,
        limit: 2,
      }),
      'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
      'active read recomputes each row digest',
    )
    memory.mutate(
      GENERATION_ROW_TABLE,
      (row) => row.generation_id === activeAfterCas && row.row_index === 0,
      (row) => { Object.assign(row, activeRow) },
    )
    await memory.api.deleteRows(GENERATION_ROW_TABLE, {
      generation_id: activeAfterCas,
      row_index: 0,
    })
    await refuses(
      () => kernel.readActiveRows({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        offset: 0,
        limit: 2,
      }),
      'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
      'active read refuses a missing row instead of returning a short page',
    )
    await memory.api.insertOne(GENERATION_ROW_TABLE, activeRow)

    const claimOnly = fixture('claim-cleanup-fence', 1)
    const claimSessionId = await submitComplete(ingestionService, claimOnly)
    const claim = await ingestionService.claimCompletedSessionForGeneration({
      sessionId: claimSessionId,
    })
    assert.equal(
      (await ingestionService.cleanupSession({ sessionId: claimSessionId })).outcome,
      'RETAINED_ACTIVE',
      'cleanup cannot remove bytes claimed by S4',
    )
    await ingestionService.releaseCompletedSessionGenerationClaim({
      sessionId: claimSessionId,
      generationId: claim.generationId,
    })
    assert.equal(
      (await ingestionService.cleanupSession({ sessionId: claimSessionId })).outcome,
      'CLEANED',
    )

    const quarantinedUpload = fixture('quarantine-cleanup', 2)
    const quarantinedSessionId = await submitComplete(
      ingestionService,
      quarantinedUpload,
    )
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'REVOKED' },
    )
    await refuses(
      () => kernel.stageAndSeal({ sessionId: quarantinedSessionId }),
      'SEALED_EXPORT_SIGNER_REVOKED',
      'authority loss during staging quarantines the generation',
    )
    const quarantinedGeneration = memory.rows(GENERATION_TABLE)
      .find((row) => row.session_id === quarantinedSessionId)
    assert.equal(quarantinedGeneration.status, 'QUARANTINED')
    assert.equal(
      memory.rows(SESSION_TABLE)
        .find((row) => row.session_id === quarantinedSessionId)
        .generation_claim_id,
      null,
      'a quarantined staging generation releases its private-ingestion claim',
    )
    assert.equal(
      (await ingestionService.cleanupSession({
        sessionId: quarantinedSessionId,
      })).outcome,
      'CLEANED',
      'released quarantined input can follow the private retention cleanup path',
    )
    memory.mutate(
      AUTHORITY_STATE_TABLE,
      () => true,
      (row) => { row.signer_status = 'ACTIVE' },
    )

    const pinnedRows = memory.rows(GENERATION_ROW_TABLE)
      .filter((row) => row.generation_id === activeAfterCas)
      .sort((leftRow, rightRow) => leftRow.row_index - rightRow.row_index)
      .map((row) => JSON.parse(row.canonical_row_text))
    assert.equal(pinnedRows.length, 2, 'pinned-read fixture spans two pages')
    const originalSelectOne = memory.api.selectOne
    let pointerReads = 0
    memory.api.selectOne = async (table, where) => {
      if (table === ACTIVE_POINTER_TABLE) pointerReads += 1
      return originalSelectOne(table, where)
    }
    const readDescriptor = await kernel.createActiveReadDescriptor({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    })
    assert.equal(pointerReads, 1, 'descriptor resolves the active pointer once')
    assert.deepEqual(
      Object.keys(readDescriptor).sort(),
      [
        'appliedRowCount',
        'canonicalObjectVersion',
        'domainIsolatedArtifactDigest',
        'domainIsolatedGenerationDigest',
        'domainIsolatedManifestDigest',
        'domainIsolatedRowsetDigest',
        'externalWrite',
        'manifestRowCount',
        'sealedRowCount',
      ],
      'descriptor exposes only the closed values-free surface',
    )
    assert.equal(Object.isFrozen(readDescriptor), true)
    assert.equal(readDescriptor.appliedRowCount, pinnedRows.length)
    assert.deepEqual(
      await kernel.readPinnedRows({
        descriptor: readDescriptor,
        offset: 0,
        limit: 1,
      }),
      pinnedRows.slice(0, 1),
    )
    const activationExpectation = await kernel.createActivationExpectation({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    })
    assert.deepEqual(
      Object.keys(activationExpectation).sort(),
      [
        'activeGenerationPresent',
        'canonicalObjectVersion',
        'externalWrite',
        'pointerVersion',
      ],
      'activation expectation does not expose the active generation id',
    )
    assert.equal(activationExpectation.activeGenerationPresent, true)
    assert.equal(Object.isFrozen(activationExpectation), true)
    await refuses(
      () => kernel.activateWithExpectation({
        generationId: activeAfterCas,
        expectation: Object.freeze({ ...activationExpectation }),
      }),
      'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
      'copying an activation expectation cannot forge its private binding',
    )

    const successor = await prepareGeneration(harness, 'pinned-successor', 3)
    await verifyGeneration(harness, successor.generationId)
    const successorActivation = await kernel.activateWithExpectation({
      generationId: successor.generationId,
      expectation: activationExpectation,
    })
    const successorReadDescriptor =
      await kernel.createReadDescriptorForActivation({
        activation: successorActivation,
      })
    assert.equal(successorReadDescriptor.appliedRowCount, 3)
    await refuses(
      () => kernel.createReadDescriptorForActivation({
        activation: Object.freeze({ ...successorActivation }),
      }),
      'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
      'copying activation evidence cannot mint a read descriptor',
    )
    await refuses(
      () => kernel.activateWithExpectation({
        generationId: successor.generationId,
        expectation: activationExpectation,
      }),
      'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
      'activation expectations are one-shot',
    )
    const replayExpectation = await kernel.createActivationExpectation({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    })
    const replayOutcome = await kernel.activateWithExpectation({
      generationId: successor.generationId,
      expectation: replayExpectation,
    })
    assert.equal(replayOutcome.activePointerOutcome, 'UNCHANGED')
    assert.equal(replayOutcome.externalWrite, false)
    assert.equal(replayOutcome.pointerVersion, replayExpectation.pointerVersion)
    assert.equal(replayOutcome.rowCount, 3)
    assert.equal(replayOutcome.status, 'ACTIVE')
    assert.match(replayOutcome.domainIsolatedGenerationDigest, /^[0-9a-f]{64}$/)
    const staleReplayExpectation = await kernel.createActivationExpectation({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    })
    memory.mutate(
      ACTIVE_POINTER_TABLE,
      (row) => row.canonical_object_version === CANONICAL_OBJECT_VERSION,
      (row) => { row.pointer_version += 1 },
    )
    await refuses(
      () => kernel.activateWithExpectation({
        generationId: successor.generationId,
        expectation: staleReplayExpectation,
      }),
      'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
      'unchanged activation still rejects a stale pointer version',
    )
    const staleExpectation = await kernel.createActivationExpectation({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    })
    const staleCandidate = await prepareGeneration(
      harness,
      'stale-activation-expectation',
      1,
    )
    await verifyGeneration(harness, staleCandidate.generationId)
    memory.mutate(
      ACTIVE_POINTER_TABLE,
      (row) => row.canonical_object_version === CANONICAL_OBJECT_VERSION,
      (row) => { row.pointer_version += 1 },
    )
    await refuses(
      () => kernel.activateWithExpectation({
        generationId: staleCandidate.generationId,
        expectation: staleExpectation,
      }),
      'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
      'pointer-version changes invalidate an otherwise matching expectation',
    )
    pointerReads = 0
    assert.deepEqual(
      await kernel.readPinnedRows({
        descriptor: readDescriptor,
        offset: 1,
        limit: 1,
      }),
      pinnedRows.slice(1, 2),
      'pointer flip cannot mix a successor row into a pinned read',
    )
    assert.equal(pointerReads, 0, 'pinned pages never re-read the active pointer')

    const peerKernel = createSealedExportGenerationKernel({
      generationStore,
      ingestionSource: ingestionService,
      authority: AUTHORITY,
      evidenceKey: EVIDENCE_KEY,
      clock,
    })
    await refuses(
      () => peerKernel.readPinnedRows({
        descriptor: readDescriptor,
        offset: 0,
        limit: 1,
      }),
      'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
      'a descriptor is bound to the kernel that minted it',
    )
    await refuses(
      () => kernel.readPinnedRows({
        descriptor: Object.freeze({ ...readDescriptor }),
        offset: 0,
        limit: 1,
      }),
      'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
      'copying the public descriptor cannot forge a trusted handle',
    )

    memory.mutate(
      GENERATION_TABLE,
      (row) => row.generation_id === activeAfterCas,
      (row) => { row.status = 'QUARANTINED' },
    )
    await refuses(
      () => kernel.readPinnedRows({
        descriptor: readDescriptor,
        offset: 0,
        limit: 1,
      }),
      'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
      'a quarantined pinned generation is no longer readable',
    )
    memory.mutate(
      GENERATION_TABLE,
      (row) => row.generation_id === activeAfterCas,
      (row) => { row.status = 'ACTIVE' },
    )
    const pinnedGeneration = memory.rows(GENERATION_TABLE)
      .find((row) => row.generation_id === activeAfterCas)
    memory.mutate(
      GENERATION_TABLE,
      (row) => row.generation_id === activeAfterCas,
      (row) => { row.sealed_rowset_digest = D('pinned-tamper') },
    )
    await refuses(
      () => kernel.readPinnedRows({
        descriptor: readDescriptor,
        offset: 0,
        limit: 1,
      }),
      'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
      'generation digest tampering invalidates the pinned handle',
    )
    memory.mutate(
      GENERATION_TABLE,
      (row) => row.generation_id === activeAfterCas,
      (row) => {
        row.sealed_rowset_digest = pinnedGeneration.sealed_rowset_digest
      },
    )
    assert.deepEqual(
      await kernel.readPinnedRows({
        descriptor: readDescriptor,
        offset: 0,
        limit: 2,
      }),
      pinnedRows,
      'restoring the exact anchors restores the pinned read',
    )
    memory.api.selectOne = originalSelectOne

    const publicText = JSON.stringify({
      activeFirst,
      verifiedFirst,
      firstChunk,
      readDescriptor,
      audits: memory.rows(AUDIT_TABLE).map((row) => ({
        eventType: row.event_type,
        reason: row.reason,
        rowCount: row.row_count,
        externalWrite: row.external_write,
      })),
    })
    for (const forbidden of [
      AUTHORITY.tenantId,
      AUTHORITY.systemContentKey,
      first.data.rows[0].marker,
      first.data.manifest.wholeArtifactByteDigest,
    ]) {
      assert.ok(!publicText.includes(forbidden), 'public summaries stay values-free')
    }
    assert.ok(
      memory.rows(AUDIT_TABLE).every((row) => row.external_write === false),
      'S4 audit proves no external write',
    )

    console.log('sealed-export-s4-generation-kernel.test.cjs OK')
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
