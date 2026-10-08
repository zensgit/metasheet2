'use strict'

const crypto = require('node:crypto')

const canonicalCodec = require('./canonical-json.cjs')
const contracts = require('./contracts.cjs')
const digests = require('./digests.cjs')
const {
  failSealedExport,
  isTrustedSealedExportError,
} = require('./failure-vocabulary.cjs')
const {
  isTrustedPrivateIngestionManifestVerifier,
} = require('./private-ingestion-manifest-verifier.cjs')

const AUTHORITY_FIELDS = Object.freeze([
  'tenantId',
  'workspaceId',
  'tenantDomainBinding',
  'systemContentKey',
  'roleBindingFingerprint',
])
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/
const GENERATION_ID_PATTERN = /^[0-9a-f]{64}$/
const WRITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const ACTIVE_STATUSES = new Set(['UPLOADING', 'CHUNK_WRITING'])
const SESSION_STATUSES = new Set([
  'UPLOADING',
  'CHUNK_WRITING',
  'UPLOAD_COMPLETE',
  'CLEANING',
])
const TRUSTED_GENERATION_SOURCES = new WeakSet()

function readDataField(input, field) {
  const descriptor = Object.getOwnPropertyDescriptor(input, field)
  if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
  }
  return descriptor.value
}

function validateCall(input, fields) {
  if (!canonicalCodec.__internals.isStrictPlainObject(input)) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
  }
  const names = Object.keys(input)
  if (
    names.length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(input, field))
  ) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
  }
  const out = {}
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    Object.defineProperty(out, field, {
      value: readDataField(input, field),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(out)
}

function isBoundedString(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function validateAuthority(input) {
  if (!canonicalCodec.__internals.isStrictPlainObject(input)) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
  }
  const names = Object.keys(input)
  if (
    names.length !== AUTHORITY_FIELDS.length
    || AUTHORITY_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(input, field))
  ) {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
  }
  const authority = {}
  for (let index = 0; index < AUTHORITY_FIELDS.length; index += 1) {
    const field = AUTHORITY_FIELDS[index]
    const value = readDataField(input, field)
    if (field === 'workspaceId' && value === null) {
      Object.defineProperty(authority, field, {
        value: null,
        enumerable: true,
        writable: false,
        configurable: false,
      })
      continue
    }
    if (!isBoundedString(value)) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    Object.defineProperty(authority, field, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(authority)
}

function assertAuthorityMatchesEnvelope(authority, envelope) {
  if (
    authority.tenantDomainBinding !== envelope.tenantDomainBinding
    || authority.systemContentKey !== envelope.systemContentKey
    || authority.roleBindingFingerprint !== envelope.roleBindingFingerprint
  ) {
    failSealedExport('SEALED_EXPORT_MANIFEST_BINDING_MISMATCH')
  }
}

function sessionIdFor(authority, manifestDigest) {
  const canonical = canonicalCodec.tryCanonicalJson({
    manifestDigest,
    roleBindingFingerprint: authority.roleBindingFingerprint,
    systemContentKey: authority.systemContentKey,
    tenantDomainBinding: authority.tenantDomainBinding,
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
  })
  if (!canonical.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return crypto.createHash('sha256').update(canonical.bytes).digest('hex')
}

function generationIdFor(sessionId) {
  const canonical = canonicalCodec.tryCanonicalJson({
    generationContract: 'sealed-export/generation/v1',
    sessionId,
  })
  if (!canonical.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return crypto.createHash('sha256').update(canonical.bytes).digest('hex')
}

function bindingFor(authority, sessionId) {
  return Object.freeze({
    sessionId,
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    tenantDomainBinding: authority.tenantDomainBinding,
    systemContentKey: authority.systemContentKey,
    roleBindingFingerprint: authority.roleBindingFingerprint,
  })
}

function parseExpiry(manifest) {
  const expiry = Date.parse(manifest.manifestExpiry)
  if (
    !Number.isFinite(expiry)
    || new Date(expiry).toISOString() !== manifest.manifestExpiry
  ) {
    failSealedExport('SEALED_EXPORT_MANIFEST_INVALID', { field: 'manifestExpiry' })
  }
  return expiry
}

function createPrivateIngestionService({
  metadataStore,
  blobStore,
  manifestVerifier,
  authority: rawAuthority,
  clock,
} = {}) {
  if (
    !metadataStore
    || typeof metadataStore.createSession !== 'function'
    || typeof metadataStore.readState !== 'function'
    || typeof metadataStore.listReceipts !== 'function'
    || typeof metadataStore.beginChunkWrite !== 'function'
    || typeof metadataStore.releaseChunkWrite !== 'function'
    || typeof metadataStore.finishChunkWrite !== 'function'
    || typeof metadataStore.markComplete !== 'function'
    || typeof metadataStore.claimCompletedSession !== 'function'
    || typeof metadataStore.releaseGenerationClaim !== 'function'
    || typeof metadataStore.beginCleanup !== 'function'
    || typeof metadataStore.listExpiredSessions !== 'function'
    || typeof metadataStore.tombstoneAndDelete !== 'function'
    || !blobStore
    || typeof blobStore.createSessionArea !== 'function'
    || typeof blobStore.writeChunk !== 'function'
    || typeof blobStore.readChunk !== 'function'
    || typeof blobStore.readChunkIfPresent !== 'function'
    || typeof blobStore.removeSession !== 'function'
    || !isTrustedPrivateIngestionManifestVerifier(manifestVerifier)
    || (clock !== undefined && typeof clock !== 'function')
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  // This is the server authority boundary for the latent S3 seam. Per-call inputs
  // never carry tenant, workspace, system or binding identity.
  const authority = validateAuthority(rawAuthority)
  const now = clock || (() => new Date())

  function nowInstant() {
    let instant
    try {
      instant = now()
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const date = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant)
    if (!Number.isFinite(date.getTime())) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return date
  }

  function normalizeReceipt(row) {
    let acceptedAt
    try {
      acceptedAt = new Date(row.accepted_at).toISOString()
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return contracts.validateChunkReceipt({
      manifestDigest: row.manifest_digest,
      chunkIndex: row.chunk_index,
      chunkDigest: row.chunk_digest,
      byteCount: row.byte_count,
      acceptedAt,
    })
  }

  function validatePendingState(row, manifest) {
    const fields = [
      row.pending_chunk_index,
      row.pending_chunk_digest,
      row.pending_byte_count,
      row.pending_write_token,
    ]
    if (row.status !== 'CHUNK_WRITING') {
      if (fields.some((value) => value !== null)) {
        failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
      }
      return
    }
    if (
      !Number.isSafeInteger(row.pending_chunk_index)
      || row.pending_chunk_index !== row.accepted_chunk_count
      || typeof row.pending_chunk_digest !== 'string'
      || !Number.isSafeInteger(row.pending_byte_count)
      || row.pending_byte_count < 0
      || typeof row.pending_write_token !== 'string'
      || !WRITE_TOKEN_PATTERN.test(row.pending_write_token)
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    const descriptor = manifest.chunks[row.pending_chunk_index]
    if (
      !descriptor
      || descriptor.chunkDigest !== row.pending_chunk_digest
      || descriptor.byteCount !== row.pending_byte_count
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
  }

  async function validatePersistedSession(row) {
    if (!row || typeof row !== 'object') failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    const hasGenerationClaimId = Object.prototype.hasOwnProperty.call(
      row,
      'generation_claim_id',
    )
    const hasGenerationClaimedAt = Object.prototype.hasOwnProperty.call(
      row,
      'generation_claimed_at',
    )
    if (hasGenerationClaimId !== hasGenerationClaimedAt) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    const generationClaimId = hasGenerationClaimId ? row.generation_claim_id : null
    const rawGenerationClaimedAt = hasGenerationClaimedAt
      ? row.generation_claimed_at
      : null
    const envelope = contracts.validateExportRequestEnvelope(row.export_request_envelope)
    const manifest = contracts.validateSignedManifest(row.manifest)
    assertAuthorityMatchesEnvelope(authority, envelope)
    const verifiedBinding = contracts.verifyManifestBinding(envelope, manifest)
    await manifestVerifier.verify(manifest)
    const manifestDigest = contracts.computeManifestDigest(manifest)
    let storedExpiry
    let completedAt = null
    let generationClaimedAt = null
    try {
      storedExpiry = new Date(row.expires_at).toISOString()
      if (row.completed_at !== null) {
        completedAt = new Date(row.completed_at).toISOString()
      }
      if (rawGenerationClaimedAt !== null) {
        generationClaimedAt = new Date(rawGenerationClaimedAt).toISOString()
      }
    } catch {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    if (
      !digests.constantTimeEqualDigest(verifiedBinding.manifestDigest, manifestDigest)
      || !digests.constantTimeEqualDigest(manifestDigest, row.manifest_digest)
      || sessionIdFor(authority, manifestDigest) !== row.session_id
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { field: 'manifestDigest' })
    }
    if (
      row.tenant_id !== authority.tenantId
      || row.workspace_id !== authority.workspaceId
      || row.tenant_domain_binding !== authority.tenantDomainBinding
      || row.system_content_key !== authority.systemContentKey
      || row.role_binding_fingerprint !== authority.roleBindingFingerprint
      || storedExpiry !== manifest.manifestExpiry
      || row.expected_chunk_count !== manifest.chunks.length
      || !Number.isSafeInteger(row.accepted_chunk_count)
      || row.accepted_chunk_count < 0
      || row.accepted_chunk_count > manifest.chunks.length
      || !SESSION_STATUSES.has(row.status)
      || (
        row.status === 'UPLOAD_COMPLETE'
        && (
          completedAt === null
          || row.accepted_chunk_count !== manifest.chunks.length
        )
      )
      || (
        (row.status === 'UPLOADING' || row.status === 'CHUNK_WRITING')
        && completedAt !== null
      )
      || (
        row.status === 'CLEANING'
        && completedAt !== null
        && row.accepted_chunk_count !== manifest.chunks.length
      )
      || (
        generationClaimId === null
        && generationClaimedAt !== null
      )
      || (
        generationClaimId !== null
        && (
          typeof generationClaimId !== 'string'
          || !GENERATION_ID_PATTERN.test(generationClaimId)
          || generationClaimedAt === null
          || row.status !== 'UPLOAD_COMPLETE'
        )
      )
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    validatePendingState(row, manifest)
    return Object.freeze({
      row: Object.freeze(Object.assign({}, row, {
        generation_claim_id: generationClaimId,
        generation_claimed_at: rawGenerationClaimedAt,
      })),
      supportsGenerationClaims: hasGenerationClaimId,
      envelope,
      manifest,
      manifestDigest,
    })
  }

  function validatePersistedReceipts(loaded, rows, mode) {
    const receipts = rows.map(normalizeReceipt)
    if (receipts.length !== loaded.persisted.row.accepted_chunk_count) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    for (let index = 0; index < receipts.length; index += 1) {
      if (!digests.constantTimeEqualDigest(
        receipts[index].manifestDigest,
        loaded.persisted.manifestDigest,
      )) {
        failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID', { field: 'manifestDigest' })
      }
    }
    if (mode === 'COMPLETE' || receipts.length === loaded.persisted.manifest.chunks.length) {
      contracts.assertChunkSetComplete(loaded.persisted.manifest, receipts)
    } else if (mode === 'RESUME') {
      const next = loaded.persisted.manifest.chunks[receipts.length]
      const result = contracts.classifyChunkSubmission(
        loaded.persisted.manifest,
        loaded.persisted.manifestDigest,
        receipts,
        {
          manifestDigest: loaded.persisted.manifestDigest,
          chunkIndex: next.chunkIndex,
          chunkDigest: next.chunkDigest,
          byteCount: next.byteCount,
        },
      )
      if (result.decision !== 'ACCEPT') failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return receipts
  }

  async function readBoundState(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    const binding = bindingFor(authority, sessionId)
    const state = await metadataStore.readState(binding)
    if (state.kind === 'TOMBSTONE') {
      return Object.freeze({ binding, kind: 'TOMBSTONE', tombstone: state.tombstone })
    }
    if (state.kind !== 'SESSION') {
      return Object.freeze({ binding, kind: 'MISSING' })
    }
    return Object.freeze({
      binding,
      kind: 'SESSION',
      persisted: await validatePersistedSession(state.session),
    })
  }

  function assertActiveSession(loaded, allowRecovery) {
    if (loaded.kind === 'TOMBSTONE') failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    if (loaded.kind !== 'SESSION') failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    if (
      loaded.persisted.row.status === 'UPLOAD_COMPLETE'
      || loaded.persisted.row.status === 'CLEANING'
    ) {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    if (!ACTIVE_STATUSES.has(loaded.persisted.row.status)) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    if (loaded.persisted.row.status === 'CHUNK_WRITING' && !allowRecovery) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (nowInstant().getTime() >= parseExpiry(loaded.persisted.manifest)) {
      failSealedExport('SEALED_EXPORT_ARTIFACT_EXPIRED')
    }
    return loaded
  }

  async function loadActive(sessionId, allowRecovery) {
    return assertActiveSession(
      await readBoundState(sessionId),
      allowRecovery,
    )
  }

  function receiptRow(loaded, chunkIndex, chunkDigest, byteCount, acceptedAt) {
    return {
      session_id: loaded.binding.sessionId,
      tenant_id: authority.tenantId,
      workspace_id: authority.workspaceId,
      tenant_domain_binding: authority.tenantDomainBinding,
      system_content_key: authority.systemContentKey,
      role_binding_fingerprint: authority.roleBindingFingerprint,
      manifest_digest: loaded.persisted.manifestDigest,
      chunk_index: chunkIndex,
      chunk_digest: chunkDigest,
      byte_count: byteCount,
      accepted_at: acceptedAt,
    }
  }

  async function recoverPendingWrite(loaded) {
    const row = loaded.persisted.row
    const bytes = await blobStore.readChunkIfPresent(
      loaded.binding.sessionId,
      row.pending_chunk_index,
    )
    if (bytes === null) {
      await metadataStore.releaseChunkWrite(loaded.binding, row.pending_write_token)
      return
    }
    const digestProbe = digests.computeChunkDigest(bytes)
    if (
      !digestProbe.ok
      || bytes.length !== row.pending_byte_count
      || !digests.constantTimeEqualDigest(digestProbe.digest, row.pending_chunk_digest)
    ) {
      failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', {
        chunkIndex: row.pending_chunk_index,
      })
    }
    await metadataStore.finishChunkWrite(
      loaded.binding,
      receiptRow(
        loaded,
        row.pending_chunk_index,
        digestProbe.digest,
        bytes.length,
        nowInstant().toISOString(),
      ),
      row.pending_write_token,
    )
  }

  async function createSession(input) {
    const call = validateCall(input, ['envelope', 'manifest'])
    const envelope = contracts.validateExportRequestEnvelope(call.envelope)
    const manifest = contracts.validateSignedManifest(call.manifest)
    assertAuthorityMatchesEnvelope(authority, envelope)
    const verified = contracts.verifyManifestBinding(envelope, manifest)
    await manifestVerifier.verify(manifest)
    const expiry = parseExpiry(manifest)
    const instant = nowInstant()
    if (instant.getTime() >= expiry) failSealedExport('SEALED_EXPORT_ARTIFACT_EXPIRED')
    const sessionId = sessionIdFor(authority, verified.manifestDigest)
    const row = await metadataStore.createSession({
      session_id: sessionId,
      tenant_id: authority.tenantId,
      workspace_id: authority.workspaceId,
      tenant_domain_binding: authority.tenantDomainBinding,
      system_content_key: authority.systemContentKey,
      role_binding_fingerprint: authority.roleBindingFingerprint,
      manifest_digest: verified.manifestDigest,
      export_request_envelope: envelope,
      manifest,
      status: 'UPLOADING',
      expected_chunk_count: manifest.chunks.length,
      accepted_chunk_count: 0,
      pending_chunk_index: null,
      pending_chunk_digest: null,
      pending_byte_count: null,
      pending_write_token: null,
      expires_at: new Date(expiry).toISOString(),
      completed_at: null,
      created_at: instant.toISOString(),
      updated_at: instant.toISOString(),
    })
    const persisted = await validatePersistedSession(row)
    if (
      persisted.row.status === 'UPLOAD_COMPLETE'
      || persisted.row.status === 'CLEANING'
    ) {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    await blobStore.createSessionArea(sessionId)
    const confirmed = await readBoundState(sessionId)
    if (confirmed.kind === 'TOMBSTONE') {
      await blobStore.removeSession(sessionId)
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    if (confirmed.kind === 'MISSING') {
      await blobStore.removeSession(sessionId)
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (confirmed.persisted.row.status === 'CLEANING') {
      await blobStore.removeSession(sessionId)
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    if (confirmed.persisted.row.status === 'UPLOAD_COMPLETE') {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    return Object.freeze({
      sessionId,
      status: 'UPLOADING',
      acceptedChunkCount: confirmed.persisted.row.accepted_chunk_count,
    })
  }

  async function resumeSession(input) {
    const call = validateCall(input, ['sessionId'])
    let loaded = await readBoundState(call.sessionId)
    if (
      loaded.kind === 'SESSION'
      && loaded.persisted.row.status === 'UPLOAD_COMPLETE'
    ) {
      if (nowInstant().getTime() >= parseExpiry(loaded.persisted.manifest)) {
        failSealedExport('SEALED_EXPORT_ARTIFACT_EXPIRED')
      }
      const rows = await metadataStore.listReceipts(loaded.binding)
      const receipts = validatePersistedReceipts(loaded, rows, 'COMPLETE')
      const orderedBytes = []
      for (
        let index = 0;
        index < loaded.persisted.manifest.chunks.length;
        index += 1
      ) {
        orderedBytes.push(await blobStore.readChunk(call.sessionId, index))
      }
      contracts.verifyArtifactAgainstManifest(
        loaded.persisted.manifest,
        orderedBytes,
      )
      return Object.freeze({
        sessionId: call.sessionId,
        status: 'UPLOAD_COMPLETE',
        acceptedChunkCount: receipts.length,
        acceptedChunkIndexes: Object.freeze(
          receipts.map((receipt) => receipt.chunkIndex),
        ),
        artifactDigestVerified: true,
      })
    }
    loaded = assertActiveSession(loaded, true)
    if (loaded.persisted.row.status === 'CHUNK_WRITING') {
      await recoverPendingWrite(loaded)
      loaded = await loadActive(call.sessionId, false)
    }
    const rows = await metadataStore.listReceipts(loaded.binding)
    const receipts = validatePersistedReceipts(loaded, rows, 'RESUME')
    const indexes = receipts.map((receipt) => receipt.chunkIndex)
    return Object.freeze({
      sessionId: call.sessionId,
      status: 'UPLOADING',
      acceptedChunkCount: indexes.length,
      acceptedChunkIndexes: Object.freeze(indexes),
    })
  }

  async function submitChunk(input) {
    const call = validateCall(input, ['sessionId', 'chunkIndex', 'bytes'])
    const sessionId = call.sessionId
    const chunkIndex = call.chunkIndex
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      failSealedExport('SEALED_EXPORT_CHUNK_UNDECLARED')
    }
    if (!(call.bytes instanceof Uint8Array)) {
      failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', { chunkIndex })
    }
    const owned = Buffer.from(call.bytes)
    const loaded = await loadActive(sessionId, false)
    const rows = await metadataStore.listReceipts(loaded.binding)
    const receipts = validatePersistedReceipts(loaded, rows, 'SUBMIT')
    const digestProbe = digests.computeChunkDigest(owned)
    if (!digestProbe.ok) {
      failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', { chunkIndex })
    }
    const submission = {
      manifestDigest: loaded.persisted.manifestDigest,
      chunkIndex,
      chunkDigest: digestProbe.digest,
      byteCount: owned.length,
    }
    const classification = contracts.classifyChunkSubmission(
      loaded.persisted.manifest,
      loaded.persisted.manifestDigest,
      receipts,
      submission,
    )
    if (classification.decision === 'IDEMPOTENT_REPLAY') {
      return Object.freeze({
        decision: 'IDEMPOTENT_REPLAY',
        acceptedChunkCount: classification.acceptedChunkCount,
      })
    }
    let writeToken
    try {
      writeToken = crypto.randomBytes(32).toString('hex')
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    await metadataStore.beginChunkWrite(loaded.binding, {
      chunkIndex,
      chunkDigest: digestProbe.digest,
      byteCount: owned.length,
      writeToken,
    })
    try {
      await blobStore.writeChunk(sessionId, chunkIndex, owned)
    } catch (error) {
      await metadataStore.releaseChunkWrite(loaded.binding, writeToken)
      if (
        isTrustedSealedExportError(error)
        && error.reason === 'SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT'
      ) {
        failSealedExport('SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT', { chunkIndex })
      }
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED', { chunkIndex })
    }
    await metadataStore.finishChunkWrite(
      loaded.binding,
      receiptRow(
        loaded,
        chunkIndex,
        digestProbe.digest,
        owned.length,
        nowInstant().toISOString(),
      ),
      writeToken,
    )
    return Object.freeze({
      decision: 'ACCEPT',
      acceptedChunkCount: classification.acceptedChunkCount,
    })
  }

  async function completeSession(input) {
    const call = validateCall(input, ['sessionId'])
    const loaded = await loadActive(call.sessionId, false)
    const receiptRows = await metadataStore.listReceipts(loaded.binding)
    validatePersistedReceipts(loaded, receiptRows, 'COMPLETE')
    const orderedBytes = []
    for (let index = 0; index < loaded.persisted.manifest.chunks.length; index += 1) {
      orderedBytes.push(await blobStore.readChunk(call.sessionId, index))
    }
    const verified = contracts.verifyArtifactAgainstManifest(
      loaded.persisted.manifest,
      orderedBytes,
    )
    await metadataStore.markComplete(
      loaded.binding,
      nowInstant().toISOString(),
      loaded.persisted.manifest.chunks.length,
    )
    return Object.freeze({
      sessionId: call.sessionId,
      status: 'UPLOAD_COMPLETE',
      chunkCount: verified.chunkCount,
      byteCount: verified.byteCount,
      artifactDigestVerified: true,
    })
  }

  async function claimCompletedSessionForGeneration(input) {
    const call = validateCall(input, ['sessionId'])
    const loaded = await readBoundState(call.sessionId)
    if (
      loaded.kind !== 'SESSION'
      || loaded.persisted.row.status !== 'UPLOAD_COMPLETE'
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    if (nowInstant().getTime() >= parseExpiry(loaded.persisted.manifest)) {
      failSealedExport('SEALED_EXPORT_ARTIFACT_EXPIRED')
    }
    const generationId = generationIdFor(call.sessionId)
    const claimed = await validatePersistedSession(
      await metadataStore.claimCompletedSession(
        loaded.binding,
        generationId,
        nowInstant().toISOString(),
      ),
    )
    if (claimed.row.generation_claim_id !== generationId) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const receiptRows = await metadataStore.listReceipts(loaded.binding)
    const receipts = Object.freeze(receiptRows.map(normalizeReceipt))
    return Object.freeze({
      generationId,
      sessionId: call.sessionId,
      authority: Object.freeze({
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
        tenantDomainBinding: authority.tenantDomainBinding,
        systemContentKey: authority.systemContentKey,
        roleBindingFingerprint: authority.roleBindingFingerprint,
      }),
      envelope: claimed.envelope,
      manifest: claimed.manifest,
      manifestDigest: claimed.manifestDigest,
      receipts,
    })
  }

  async function readClaimedGenerationChunk(input) {
    const call = validateCall(input, ['sessionId', 'generationId', 'chunkIndex'])
    if (
      typeof call.sessionId !== 'string'
      || !SESSION_ID_PATTERN.test(call.sessionId)
      || typeof call.generationId !== 'string'
      || !GENERATION_ID_PATTERN.test(call.generationId)
      || generationIdFor(call.sessionId) !== call.generationId
      || !Number.isSafeInteger(call.chunkIndex)
      || call.chunkIndex < 0
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    const loaded = await readBoundState(call.sessionId)
    if (
      loaded.kind !== 'SESSION'
      || loaded.persisted.row.status !== 'UPLOAD_COMPLETE'
      || loaded.persisted.row.generation_claim_id !== call.generationId
      || call.chunkIndex >= loaded.persisted.manifest.chunks.length
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    return Buffer.from(await blobStore.readChunk(call.sessionId, call.chunkIndex))
  }

  async function releaseCompletedSessionGenerationClaim(input) {
    const call = validateCall(input, ['sessionId', 'generationId'])
    if (
      typeof call.sessionId !== 'string'
      || !SESSION_ID_PATTERN.test(call.sessionId)
      || typeof call.generationId !== 'string'
      || !GENERATION_ID_PATTERN.test(call.generationId)
      || generationIdFor(call.sessionId) !== call.generationId
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    const binding = bindingFor(authority, call.sessionId)
    await metadataStore.releaseGenerationClaim(binding, call.generationId)
    return Object.freeze({ released: true })
  }

  async function cleanupBySessionId(sessionId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await readBoundState(sessionId)
      if (loaded.kind === 'MISSING') {
        failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
      }
      if (loaded.kind === 'TOMBSTONE') {
        await blobStore.removeSession(sessionId)
        return Object.freeze({ sessionId, outcome: 'CLEANED' })
      }
      if (loaded.persisted.row.generation_claim_id !== null) {
        return Object.freeze({ sessionId, outcome: 'RETAINED_ACTIVE' })
      }
      const expired = nowInstant().getTime() >= parseExpiry(loaded.persisted.manifest)
      if (ACTIVE_STATUSES.has(loaded.persisted.row.status) && !expired) {
        return Object.freeze({ sessionId, outcome: 'RETAINED_ACTIVE' })
      }
      if (loaded.persisted.row.status !== 'CLEANING') {
        await metadataStore.beginCleanup(
          loaded.binding,
          loaded.persisted.row.status,
          loaded.persisted.supportsGenerationClaims,
        )
        continue
      }
      const cleanupReason = loaded.persisted.row.completed_at === null
        ? 'EXPIRED'
        : 'COMPLETED'
      await blobStore.removeSession(sessionId)
      await metadataStore.tombstoneAndDelete(
        loaded.binding,
        cleanupReason,
        nowInstant().toISOString(),
      )
      return Object.freeze({ sessionId, outcome: 'CLEANED' })
    }
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  function validateExpiredCleanupCandidate(row, cutoffMs) {
    const hasGenerationClaimId = row && Object.prototype.hasOwnProperty.call(
      row,
      'generation_claim_id',
    )
    const hasGenerationClaimedAt = row && Object.prototype.hasOwnProperty.call(
      row,
      'generation_claimed_at',
    )
    if (
      !row
      || typeof row !== 'object'
      || hasGenerationClaimId !== hasGenerationClaimedAt
      || typeof row.session_id !== 'string'
      || !SESSION_ID_PATTERN.test(row.session_id)
      || row.tenant_id !== authority.tenantId
      || row.workspace_id !== authority.workspaceId
      || row.tenant_domain_binding !== authority.tenantDomainBinding
      || row.system_content_key !== authority.systemContentKey
      || row.role_binding_fingerprint !== authority.roleBindingFingerprint
      || typeof row.manifest_digest !== 'string'
      || !SESSION_ID_PATTERN.test(row.manifest_digest)
      || !SESSION_STATUSES.has(row.status)
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const generationClaimId = hasGenerationClaimId ? row.generation_claim_id : null
    const generationClaimedAt = hasGenerationClaimedAt ? row.generation_claimed_at : null
    if (
      (generationClaimId === null) !== (generationClaimedAt === null)
      || (
        generationClaimId !== null
        && (
          typeof generationClaimId !== 'string'
          || !GENERATION_ID_PATTERN.test(generationClaimId)
          || row.status !== 'UPLOAD_COMPLETE'
        )
      )
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    let expiresAt
    try {
      expiresAt = new Date(row.expires_at).getTime()
      if (generationClaimedAt !== null) {
        new Date(generationClaimedAt).toISOString()
      }
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (!Number.isFinite(expiresAt)) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return Object.freeze({
      binding: bindingFor(authority, row.session_id),
      eligible: expiresAt <= cutoffMs,
      row: Object.freeze(Object.assign({}, row, {
        generation_claim_id: generationClaimId,
        generation_claimed_at: generationClaimedAt,
      })),
      supportsGenerationClaims: Boolean(hasGenerationClaimId),
    })
  }

  async function cleanupExpiredCandidate(candidateRow, cutoffMs) {
    let candidate = validateExpiredCleanupCandidate(candidateRow, cutoffMs)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!candidate.eligible) {
        return Object.freeze({
          sessionId: candidate.binding.sessionId,
          outcome: 'RETAINED_ACTIVE',
        })
      }
      const state = await metadataStore.readState(candidate.binding)
      if (state.kind === 'TOMBSTONE' || state.kind === 'MISSING') {
        await blobStore.removeSession(candidate.binding.sessionId)
        return Object.freeze({
          sessionId: candidate.binding.sessionId,
          outcome: 'CLEANED',
        })
      }
      candidate = validateExpiredCleanupCandidate(state.session, cutoffMs)
      if (candidate.row.generation_claim_id !== null) {
        return Object.freeze({
          sessionId: candidate.binding.sessionId,
          outcome: 'RETAINED_ACTIVE',
        })
      }
      if (candidate.row.status !== 'CLEANING') {
        const transitioned = await metadataStore.beginCleanup(
          candidate.binding,
          candidate.row.status,
          candidate.supportsGenerationClaims,
        )
        if (transitioned === null) continue
        candidate = validateExpiredCleanupCandidate(transitioned, cutoffMs)
      }
      if (candidate.row.status !== 'CLEANING') continue
      const cleanupReason = candidate.row.completed_at === null
        ? 'EXPIRED'
        : 'COMPLETED'
      await blobStore.removeSession(candidate.binding.sessionId)
      await metadataStore.tombstoneAndDelete(
        candidate.binding,
        cleanupReason,
        nowInstant().toISOString(),
      )
      return Object.freeze({
        sessionId: candidate.binding.sessionId,
        outcome: 'CLEANED',
      })
    }
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  async function cleanupSession(input) {
    const call = validateCall(input, ['sessionId'])
    return cleanupBySessionId(call.sessionId)
  }

  async function cleanupExpiredSessions(input) {
    const call = validateCall(input, ['limit'])
    if (!Number.isSafeInteger(call.limit) || call.limit < 1 || call.limit > 1000) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    const instant = nowInstant()
    const rows = await metadataStore.listExpiredSessions(
      authority,
      instant.toISOString(),
      call.limit,
    )
    let cleanedCount = 0
    let retainedCount = 0
    let failedCount = 0
    for (let index = 0; index < rows.length; index += 1) {
      try {
        const outcome = await cleanupExpiredCandidate(
          rows[index],
          instant.getTime(),
        )
        if (outcome.outcome === 'CLEANED') cleanedCount += 1
        else retainedCount += 1
      } catch {
        failedCount += 1
      }
    }
    return Object.freeze({
      scannedCount: rows.length,
      cleanedCount,
      retainedCount,
      failedCount,
    })
  }

  const service = Object.freeze({
    createSession,
    resumeSession,
    submitChunk,
    completeSession,
    claimCompletedSessionForGeneration,
    readClaimedGenerationChunk,
    releaseCompletedSessionGenerationClaim,
    cleanupSession,
    cleanupExpiredSessions,
  })
  TRUSTED_GENERATION_SOURCES.add(service)
  return service
}

function isTrustedPrivateIngestionGenerationSource(value) {
  return value !== null && typeof value === 'object' && TRUSTED_GENERATION_SOURCES.has(value)
}

module.exports = Object.freeze({
  createPrivateIngestionService,
  isTrustedPrivateIngestionGenerationSource,
})
