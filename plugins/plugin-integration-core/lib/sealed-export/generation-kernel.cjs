'use strict'

const crypto = require('node:crypto')

const canonicalCodec = require('./canonical-json.cjs')
const contracts = require('./contracts.cjs')
const digests = require('./digests.cjs')
const {
  failSealedExport,
} = require('./failure-vocabulary.cjs')
const {
  isTrustedPrivateIngestionGenerationSource,
} = require('./private-ingestion-service.cjs')
const {
  isTrustedGenerationStore,
} = require('./generation-store.cjs')

const GENERATION_ID_PATTERN = /^[0-9a-f]{64}$/
const LEASE_DURATION_MS = 5 * 60 * 1000
const ROW_BATCH_SIZE = 500
const DIGEST_PAGE_SIZE = 1000
const LEASES = new WeakMap()

function refuseCall(kind) {
  if (kind === 'UPLOAD_SESSION') {
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
  }
  if (kind === 'APPLY') failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
  if (kind === 'VISIBILITY') {
    failSealedExport('SEALED_EXPORT_VISIBILITY_CAS_CONFLICT')
  }
  failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
}

function refuseAuthority(reason) {
  if (reason === 'SEALED_EXPORT_ARTIFACT_EXPIRED') {
    failSealedExport('SEALED_EXPORT_ARTIFACT_EXPIRED')
  }
  if (reason === 'SEALED_EXPORT_BINDING_UNQUALIFIED') {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  if (reason === 'SEALED_EXPORT_SIGNER_UNENROLLED') {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (reason === 'SEALED_EXPORT_SIGNER_EXPIRED') {
    failSealedExport('SEALED_EXPORT_SIGNER_EXPIRED')
  }
  if (reason === 'SEALED_EXPORT_SIGNER_REVOKED') {
    failSealedExport('SEALED_EXPORT_SIGNER_REVOKED')
  }
  if (reason === 'SEALED_EXPORT_GENERATION_VERIFY_FAILED') {
    failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
  }
  failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
}

function readDataField(input, field, refusalKind) {
  const descriptor = Object.getOwnPropertyDescriptor(input, field)
  if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
    refuseCall(refusalKind)
  }
  return descriptor.value
}

function readClosedCall(input, fields, refusalKind = 'INTERNAL') {
  if (!canonicalCodec.__internals.isStrictPlainObject(input)) {
    refuseCall(refusalKind)
  }
  const names = Object.keys(input)
  if (
    names.length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(input, field))
  ) {
    refuseCall(refusalKind)
  }
  const out = {}
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    Object.defineProperty(out, field, {
      value: readDataField(input, field, refusalKind),
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
  const fields = [
    'tenantId',
    'workspaceId',
    'tenantDomainBinding',
    'systemContentKey',
    'roleBindingFingerprint',
  ]
  const authority = readClosedCall(input, fields)
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === 'workspaceId' && authority[field] === null) continue
    if (!isBoundedString(authority[field])) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }
  return authority
}

function sameAuthority(left, right) {
  return (
    left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId
    && left.tenantDomainBinding === right.tenantDomainBinding
    && left.systemContentKey === right.systemContentKey
    && left.roleBindingFingerprint === right.roleBindingFingerprint
  )
}

function scopeFromGeneration(row) {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    tenantDomainBinding: row.tenant_domain_binding,
    systemContentKey: row.system_content_key,
    roleBindingFingerprint: row.role_binding_fingerprint,
  })
}

function childScopeRow(generation) {
  return {
    generation_id: generation.generation_id,
    tenant_id: generation.tenant_id,
    workspace_id: generation.workspace_id,
    tenant_domain_binding: generation.tenant_domain_binding,
    system_content_key: generation.system_content_key,
    role_binding_fingerprint: generation.role_binding_fingerprint,
    manifest_digest: generation.manifest_digest,
  }
}

function normalizeCount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  if (
    typeof value === 'string'
    && /^(0|[1-9][0-9]*)$/.test(value)
  ) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
}

function instantMs(value) {
  const result = new Date(value).getTime()
  if (!Number.isFinite(result)) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return result
}

function identifierDigest(value) {
  const canonical = canonicalCodec.tryCanonicalJson(value)
  if (!canonical.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return crypto.createHash('sha256').update(canonical.bytes).digest('hex')
}

function pointerIdFor(scope, canonicalObjectVersion) {
  return identifierDigest({
    canonicalObjectVersion,
    roleBindingFingerprint: scope.roleBindingFingerprint,
    systemContentKey: scope.systemContentKey,
    tenantDomainBinding: scope.tenantDomainBinding,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
}

function auditIdFor(generationId, eventType) {
  return identifierDigest({ eventType, generationId })
}

function chunkSetDigest(manifestDigest, chunks) {
  const normalized = chunks.map((chunk) => ({
    byteCount: chunk.byteCount,
    chunkDigest: chunk.chunkDigest,
    chunkIndex: chunk.chunkIndex,
  }))
  normalized.sort((left, right) => left.chunkIndex - right.chunkIndex)
  return identifierDigest({
    chunks: normalized,
    manifestDigest,
  })
}

function verifyReceiptSet(manifestDigest, manifest, rawReceipts) {
  if (
    !Array.isArray(rawReceipts)
    || rawReceipts.length !== manifest.chunks.length
  ) {
    failSealedExport('SEALED_EXPORT_CHUNK_SET_INCOMPLETE', {
      declaredCount: manifest.chunks.length,
      observedCount: Array.isArray(rawReceipts) ? rawReceipts.length : 0,
    })
  }
  const receipts = []
  for (let index = 0; index < rawReceipts.length; index += 1) {
    const receipt = contracts.validateChunkReceipt(rawReceipts[index])
    const descriptor = manifest.chunks[index]
    if (
      receipt.chunkIndex !== index
      || !digests.constantTimeEqualDigest(receipt.manifestDigest, manifestDigest)
    ) {
      failSealedExport('SEALED_EXPORT_CHUNK_SET_INCOMPLETE', {
        declaredCount: manifest.chunks.length,
        observedCount: rawReceipts.length,
      })
    }
    if (
      receipt.byteCount !== descriptor.byteCount
      || !digests.constantTimeEqualDigest(
        receipt.chunkDigest,
        descriptor.chunkDigest,
      )
    ) {
      failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', {
        chunkIndex: index,
      })
    }
    receipts.push(receipt)
  }
  return chunkSetDigest(manifestDigest, receipts)
}

function utf16BeSortKey(text) {
  const bytes = Buffer.allocUnsafe(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    bytes.writeUInt16BE(text.charCodeAt(index), index * 2)
  }
  return bytes
}

function sameBytes(left, right) {
  return (
    left instanceof Uint8Array
    && right instanceof Uint8Array
    && left.length === right.length
    && Buffer.from(left).equals(Buffer.from(right))
  )
}

function authorityReason(state, generation, nowMs) {
  if (nowMs >= instantMs(generation.manifest_expires_at)) {
    return 'SEALED_EXPORT_ARTIFACT_EXPIRED'
  }
  if (state === null) return 'SEALED_EXPORT_BINDING_UNQUALIFIED'
  if (state.signer_key_id !== generation.signer_key_id) {
    return 'SEALED_EXPORT_SIGNER_UNENROLLED'
  }
  if (state.signer_status === 'REVOKED') return 'SEALED_EXPORT_SIGNER_REVOKED'
  if (
    state.signer_status === 'EXPIRED'
    || state.signer_status !== 'ACTIVE'
    || nowMs >= instantMs(state.signer_expires_at)
  ) {
    return 'SEALED_EXPORT_SIGNER_EXPIRED'
  }
  if (
    state.binding_current !== true
    || nowMs >= instantMs(state.binding_expires_at)
    || state.qualification_current !== true
    || state.qualification_digest !== generation.qualification_digest
    || nowMs >= instantMs(state.qualification_expires_at)
  ) {
    return 'SEALED_EXPORT_BINDING_UNQUALIFIED'
  }
  return null
}

function auditRow(generation, eventType, reason, occurredAt, rowCount) {
  return Object.assign(childScopeRow(generation), {
    audit_id: auditIdFor(generation.generation_id, eventType),
    event_type: eventType,
    reason,
    row_count: rowCount,
    external_write: false,
    occurred_at: occurredAt,
  })
}

function generationAnchorsMatch(generation, claim) {
  const envelope = claim.envelope
  const manifest = claim.manifest
  return (
    generation.generation_id === claim.generationId
    && generation.session_id === claim.sessionId
    && generation.tenant_id === claim.authority.tenantId
    && generation.workspace_id === claim.authority.workspaceId
    && generation.tenant_domain_binding === claim.authority.tenantDomainBinding
    && generation.system_content_key === claim.authority.systemContentKey
    && generation.role_binding_fingerprint === claim.authority.roleBindingFingerprint
    && generation.manifest_digest === claim.manifestDigest
    && generation.signer_key_id === manifest.signerKeyId
    && generation.qualification_digest === envelope.qualificationDigest
    && generation.canonical_object_version === envelope.canonicalObjectVersion
    && generation.approved_config_version_id === envelope.approvedConfigVersionId
    && generation.config_content_key === envelope.configContentKey
    && normalizeCount(generation.manifest_row_count) === manifest.totalRows
    && normalizeCount(generation.manifest_byte_count) === manifest.totalBytes
    && normalizeCount(generation.manifest_chunk_count) === manifest.chunks.length
    && generation.manifest_artifact_digest === manifest.wholeArtifactByteDigest
    && generation.manifest_rowset_digest === manifest.canonicalRowsetMultiplicityDigest
    && generation.manifest_chunk_set_digest === chunkSetDigest(
      claim.manifestDigest,
      manifest.chunks,
    )
    && instantMs(generation.manifest_expires_at) === instantMs(manifest.manifestExpiry)
  )
}

async function computeStoredRowsetDigest(store, generationId, rowKind, expectedCount) {
  const listRows = rowKind === 'STAGING'
    ? store.listStagingRows
    : store.listGenerationRows
  const countRows = rowKind === 'STAGING'
    ? store.countStagingRows
    : store.countGenerationRows
  const observedCount = normalizeCount(await countRows(generationId))
  if (observedCount !== expectedCount) {
    return Object.freeze({ ok: false, observedCount })
  }
  const hash = crypto.createHash(digests.SEALED_EXPORT_DIGEST_ALGORITHM)
  hash.update(Buffer.from('[', 'utf8'))
  let offset = 0
  let previousSortKey = null
  while (offset < observedCount) {
    const page = await listRows(
      generationId,
      ['row_sort_key', 'ASC'],
      DIGEST_PAGE_SIZE,
      offset,
    )
    if (page.length === 0) {
      return Object.freeze({ ok: false, observedCount: offset })
    }
    for (let index = 0; index < page.length; index += 1) {
      const row = page[index]
      if (
        typeof row.canonical_row_text !== 'string'
        || !canonicalCodec.isCanonicalJsonText(row.canonical_row_text)
        || !(row.row_sort_key instanceof Uint8Array)
        || typeof row.row_digest !== 'string'
      ) {
        return Object.freeze({ ok: false, observedCount: offset + index })
      }
      const expectedSortKey = utf16BeSortKey(row.canonical_row_text)
      const rowDigest = digests.digestBytes(
        Buffer.from(row.canonical_row_text, 'utf8'),
      )
      if (
        !sameBytes(row.row_sort_key, expectedSortKey)
        || !rowDigest.ok
        || !digests.constantTimeEqualDigest(row.row_digest, rowDigest.digest)
        || (
          previousSortKey !== null
          && Buffer.compare(previousSortKey, Buffer.from(row.row_sort_key)) > 0
        )
      ) {
        return Object.freeze({ ok: false, observedCount: offset + index })
      }
      if (offset + index > 0) hash.update(Buffer.from(',', 'utf8'))
      hash.update(Buffer.from(JSON.stringify(row.canonical_row_text), 'utf8'))
      previousSortKey = Buffer.from(row.row_sort_key)
    }
    offset += page.length
  }
  hash.update(Buffer.from(']', 'utf8'))
  return Object.freeze({
    ok: true,
    observedCount,
    digest: hash.digest('hex'),
  })
}

function createSealedExportGenerationKernel({
  generationStore,
  ingestionSource,
  authority: rawAuthority,
  evidenceKey,
  clock,
} = {}) {
  if (
    !isTrustedGenerationStore(generationStore)
    || !isTrustedPrivateIngestionGenerationSource(ingestionSource)
    || !(evidenceKey instanceof Uint8Array)
    || evidenceKey.length < 32
    || (clock !== undefined && typeof clock !== 'function')
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const authority = validateAuthority(rawAuthority)
  const ownedEvidenceKey = Buffer.from(evidenceKey)
  const now = clock || (() => new Date())

  function nowInstant() {
    let value
    try {
      value = now()
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return date
  }

  function generationProjection(generationId) {
    const projected = digests.computeDomainIsolatedDigestProjection(
      ownedEvidenceKey,
      generationId,
    )
    if (!projected.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return projected.digest
  }

  async function quarantineAndRefuse(generation, reason, instant, lease = null) {
    const quarantined = await generationStore.quarantineGeneration(
      generation,
      instant.toISOString(),
      auditRow(
        generation,
        'QUARANTINED',
        reason,
        instant.toISOString(),
        normalizeCount(generation.applied_row_count),
      ),
      lease,
    )
    if (quarantined === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    if (generation.status === 'STAGING') {
      await ingestionSource.releaseCompletedSessionGenerationClaim({
        sessionId: generation.session_id,
        generationId: generation.generation_id,
      })
    }
    refuseAuthority(reason)
  }

  async function assertCurrentAuthorityOrQuarantine(generation, lease = null) {
    const instant = nowInstant()
    const state = await generationStore.readAuthorityState(authority)
    const reason = authorityReason(state, generation, instant.getTime())
    if (reason !== null) {
      await quarantineAndRefuse(generation, reason, instant, lease)
    }
  }

  async function appendStagingBatch(generation, lease, batch) {
    if (batch.length === 0) return generation
    const updated = await generationStore.appendStagingRows(
      generation,
      lease,
      normalizeCount(generation.staged_row_count),
      batch,
    )
    if (updated === null) failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    return updated
  }

  async function stageAndSeal(input) {
    const call = readClosedCall(
      input,
      ['sessionId'],
      'UPLOAD_SESSION',
    )
    if (
      typeof call.sessionId !== 'string'
      || !GENERATION_ID_PATTERN.test(call.sessionId)
    ) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    const claim = await ingestionSource.claimCompletedSessionForGeneration({
      sessionId: call.sessionId,
    })
    if (!sameAuthority(authority, claim.authority)) {
      failSealedExport('SEALED_EXPORT_MANIFEST_BINDING_MISMATCH')
    }
    const envelope = contracts.validateExportRequestEnvelope(claim.envelope)
    const manifest = contracts.validateSignedManifest(claim.manifest)
    contracts.verifyManifestBinding(envelope, manifest)
    const expectedChunkSetDigest = chunkSetDigest(
      claim.manifestDigest,
      manifest.chunks,
    )
    const observedReceiptSetDigest = verifyReceiptSet(
      claim.manifestDigest,
      manifest,
      claim.receipts,
    )

    const createdAt = nowInstant().toISOString()
    const pointerId = pointerIdFor(authority, envelope.canonicalObjectVersion)
    let generation = await generationStore.createGeneration(
      {
        generation_id: claim.generationId,
        session_id: claim.sessionId,
        tenant_id: authority.tenantId,
        workspace_id: authority.workspaceId,
        tenant_domain_binding: authority.tenantDomainBinding,
        system_content_key: authority.systemContentKey,
        role_binding_fingerprint: authority.roleBindingFingerprint,
        manifest_digest: claim.manifestDigest,
        signer_key_id: manifest.signerKeyId,
        qualification_digest: envelope.qualificationDigest,
        canonical_object_version: envelope.canonicalObjectVersion,
        approved_config_version_id: envelope.approvedConfigVersionId,
        config_content_key: envelope.configContentKey,
        status: 'STAGING',
        manifest_row_count: manifest.totalRows,
        manifest_byte_count: manifest.totalBytes,
        manifest_chunk_count: manifest.chunks.length,
        manifest_artifact_digest: manifest.wholeArtifactByteDigest,
        manifest_rowset_digest: manifest.canonicalRowsetMultiplicityDigest,
        manifest_chunk_set_digest: expectedChunkSetDigest,
        manifest_expires_at: manifest.manifestExpiry,
        staged_row_count: 0,
        sealed_row_count: null,
        sealed_byte_count: null,
        sealed_chunk_count: null,
        sealed_artifact_digest: null,
        sealed_rowset_digest: null,
        sealed_receipt_set_digest: null,
        applied_row_count: 0,
        applied_rowset_digest: null,
        lease_token: null,
        lease_fence: 0,
        lease_expires_at: null,
        created_at: createdAt,
        sealed_at: null,
        verified_at: null,
        activated_at: null,
        quarantined_at: null,
        updated_at: createdAt,
      },
      {
        pointer_id: pointerId,
        tenant_id: authority.tenantId,
        workspace_id: authority.workspaceId,
        tenant_domain_binding: authority.tenantDomainBinding,
        system_content_key: authority.systemContentKey,
        role_binding_fingerprint: authority.roleBindingFingerprint,
        canonical_object_version: envelope.canonicalObjectVersion,
        active_generation_id: null,
        active_manifest_digest: null,
        pointer_version: 0,
        created_at: createdAt,
        updated_at: createdAt,
      },
      authority,
    )
    if (generation === null || !generationAnchorsMatch(generation, claim)) {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    if (generation.status === 'QUARANTINED') {
      failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
    }
    if (generation.status !== 'STAGING') {
      await ingestionSource.releaseCompletedSessionGenerationClaim({
        sessionId: claim.sessionId,
        generationId: claim.generationId,
      })
      return Object.freeze({
        generationId: generation.generation_id,
        status: generation.status,
        rowCount: normalizeCount(generation.sealed_row_count),
        domainIsolatedGenerationDigest: generationProjection(generation.generation_id),
        externalWrite: false,
      })
    }

    const initialState = await generationStore.readAuthorityState(authority)
    const initialReason = authorityReason(
      initialState,
      generation,
      nowInstant().getTime(),
    )
    if (initialReason !== null) {
      await quarantineAndRefuse(generation, initialReason, nowInstant())
    }

    const leaseToken = crypto.randomBytes(32).toString('hex')
    const leaseExpiry = new Date(nowInstant().getTime() + LEASE_DURATION_MS)
    generation = await generationStore.acquireLease(
      authority,
      generation.generation_id,
      ['STAGING'],
      'STAGING',
      leaseToken,
      leaseExpiry.toISOString(),
      nowInstant().getTime(),
    )
    if (generation === null) failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    const lease = Object.freeze({
      token: leaseToken,
      fence: normalizeCount(generation.lease_fence),
    })
    if (normalizeCount(generation.staged_row_count) > 0) {
      generation = await generationStore.resetStaging(generation, lease)
      if (generation === null) failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }

    const wholeHash = crypto.createHash(digests.SEALED_EXPORT_DIGEST_ALGORITHM)
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let pendingText = ''
    let totalBytes = 0
    let rowIndex = 0
    let batch = []
    for (let chunkIndex = 0; chunkIndex < manifest.chunks.length; chunkIndex += 1) {
      const descriptor = manifest.chunks[chunkIndex]
      const bytes = await ingestionSource.readClaimedGenerationChunk({
        sessionId: claim.sessionId,
        generationId: claim.generationId,
        chunkIndex,
      })
      const observed = digests.computeChunkDigest(bytes)
      if (
        !observed.ok
        || bytes.length !== descriptor.byteCount
        || !digests.constantTimeEqualDigest(observed.digest, descriptor.chunkDigest)
      ) {
        failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH', { chunkIndex })
      }
      wholeHash.update(bytes)
      totalBytes += bytes.length
      try {
        pendingText += decoder.decode(bytes, { stream: true })
      } catch {
        failSealedExport('SEALED_EXPORT_SEAL_INCOMPLETE')
      }
      while (pendingText.indexOf('\n') >= 0) {
        const newline = pendingText.indexOf('\n')
        const line = pendingText.slice(0, newline)
        pendingText = pendingText.slice(newline + 1)
        if (
          line.length === 0
          || !canonicalCodec.isCanonicalJsonText(line)
          || rowIndex >= manifest.totalRows
        ) {
          failSealedExport('SEALED_EXPORT_SEAL_INCOMPLETE')
        }
        const rowDigest = digests.digestBytes(Buffer.from(line, 'utf8'))
        if (!rowDigest.ok) failSealedExport('SEALED_EXPORT_SEAL_INCOMPLETE')
        batch.push(Object.assign(childScopeRow(generation), {
          row_index: rowIndex,
          canonical_row_text: line,
          row_sort_key: utf16BeSortKey(line),
          row_digest: rowDigest.digest,
          created_at: nowInstant().toISOString(),
        }))
        rowIndex += 1
        if (batch.length === ROW_BATCH_SIZE) {
          generation = await appendStagingBatch(generation, lease, batch)
          batch = []
        }
      }
    }
    try {
      pendingText += decoder.decode()
    } catch {
      failSealedExport('SEALED_EXPORT_SEAL_INCOMPLETE')
    }
    if (pendingText.length !== 0) failSealedExport('SEALED_EXPORT_SEAL_INCOMPLETE')
    generation = await appendStagingBatch(generation, lease, batch)

    const artifactDigest = wholeHash.digest('hex')
    if (
      totalBytes !== manifest.totalBytes
      || !digests.constantTimeEqualDigest(
        artifactDigest,
        manifest.wholeArtifactByteDigest,
      )
    ) {
      failSealedExport('SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH', {
        field: 'wholeArtifactByteDigest',
      })
    }
    if (rowIndex !== manifest.totalRows) {
      failSealedExport('SEALED_EXPORT_ROW_COUNT_MISMATCH', {
        declaredCount: manifest.totalRows,
        observedCount: rowIndex,
      })
    }
    const rowset = await computeStoredRowsetDigest(
      generationStore,
      generation.generation_id,
      'STAGING',
      rowIndex,
    )
    if (
      !rowset.ok
      || !digests.constantTimeEqualDigest(
        rowset.digest,
        manifest.canonicalRowsetMultiplicityDigest,
      )
    ) {
      failSealedExport('SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH', {
        field: 'canonicalRowsetMultiplicityDigest',
      })
    }
    await assertCurrentAuthorityOrQuarantine(generation, lease)
    const sealedAt = nowInstant().toISOString()
    const sealed = await generationStore.sealGeneration(
      generation,
      lease,
      {
        rowCount: rowIndex,
        byteCount: totalBytes,
        chunkCount: manifest.chunks.length,
        artifactDigest,
        rowsetDigest: rowset.digest,
        receiptSetDigest: observedReceiptSetDigest,
        sealedAt,
      },
      auditRow(generation, 'SEALED', null, sealedAt, rowIndex),
    )
    if (sealed === null) failSealedExport('SEALED_EXPORT_SEAL_INCOMPLETE')
    await ingestionSource.releaseCompletedSessionGenerationClaim({
      sessionId: claim.sessionId,
      generationId: claim.generationId,
    })
    return Object.freeze({
      generationId: sealed.generation_id,
      status: 'SEALED',
      rowCount: rowIndex,
      domainIsolatedGenerationDigest: generationProjection(sealed.generation_id),
      externalWrite: false,
    })
  }

  async function beginApply(input) {
    const call = readClosedCall(input, ['generationId'], 'APPLY')
    if (
      typeof call.generationId !== 'string'
      || !GENERATION_ID_PATTERN.test(call.generationId)
    ) {
      failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    }
    let generation = await generationStore.readGeneration(authority, call.generationId)
    if (
      generation === null
      || (generation.status !== 'SEALED' && generation.status !== 'APPLYING')
    ) {
      failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    }
    await assertCurrentAuthorityOrQuarantine(generation)
    const instant = nowInstant()
    const token = crypto.randomBytes(32).toString('hex')
    generation = await generationStore.acquireLease(
      authority,
      generation.generation_id,
      ['SEALED', 'APPLYING'],
      'APPLYING',
      token,
      new Date(instant.getTime() + LEASE_DURATION_MS).toISOString(),
      instant.getTime(),
    )
    if (generation === null) failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    const handle = Object.freeze({})
    LEASES.set(handle, Object.freeze({
      generationId: generation.generation_id,
      token,
      fence: normalizeCount(generation.lease_fence),
    }))
    return handle
  }

  async function applyNextChunk(input) {
    const call = readClosedCall(input, ['lease'])
    const lease = LEASES.get(call.lease)
    if (!lease) failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    let generation = await generationStore.readGeneration(
      authority,
      lease.generationId,
    )
    if (
      generation === null
      || generation.status !== 'APPLYING'
      || generation.lease_token !== lease.token
      || normalizeCount(generation.lease_fence) !== lease.fence
      || nowInstant().getTime() >= instantMs(generation.lease_expires_at)
    ) {
      failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    }
    await assertCurrentAuthorityOrQuarantine(generation, lease)
    const startIndex = normalizeCount(generation.applied_row_count)
    const sealedCount = normalizeCount(generation.sealed_row_count)
    const remaining = sealedCount - startIndex
    const page = remaining === 0
      ? []
      : await generationStore.listStagingRows(
        generation.generation_id,
        ['row_index', 'ASC'],
        Math.min(ROW_BATCH_SIZE, remaining),
        startIndex,
      )
    if (remaining > 0 && page.length === 0) {
      failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    }
    const rows = page.map((row, index) => {
      if (
        normalizeCount(row.row_index) !== startIndex + index
        || typeof row.canonical_row_text !== 'string'
        || !(row.row_sort_key instanceof Uint8Array)
        || typeof row.row_digest !== 'string'
      ) {
        failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
      }
      return Object.assign(childScopeRow(generation), {
        row_index: startIndex + index,
        canonical_row_text: row.canonical_row_text,
        row_sort_key: Buffer.from(row.row_sort_key),
        row_digest: row.row_digest,
        apply_fence: lease.fence,
        created_at: nowInstant().toISOString(),
      })
    })
    if (rows.length > 0) {
      generation = await generationStore.appendGenerationRows(
        generation,
        lease,
        startIndex,
        rows,
      )
      if (generation === null) failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    }
    if (normalizeCount(generation.applied_row_count) < sealedCount) {
      return Object.freeze({
        status: 'APPLYING',
        appliedRowCount: normalizeCount(generation.applied_row_count),
        externalWrite: false,
      })
    }
    const applied = await computeStoredRowsetDigest(
      generationStore,
      generation.generation_id,
      'APPLIED',
      sealedCount,
    )
    if (
      !applied.ok
      || !digests.constantTimeEqualDigest(
        applied.digest,
        generation.sealed_rowset_digest,
      )
    ) {
      await quarantineAndRefuse(
        generation,
        'SEALED_EXPORT_GENERATION_VERIFY_FAILED',
        nowInstant(),
        lease,
      )
    }
    await assertCurrentAuthorityOrQuarantine(generation, lease)
    const verifiedAt = nowInstant().toISOString()
    const verified = await generationStore.markVerified(
      generation,
      lease,
      applied.digest,
      verifiedAt,
      auditRow(generation, 'VERIFIED', null, verifiedAt, sealedCount),
    )
    if (verified === null) failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
    return Object.freeze({
      status: 'VERIFIED',
      appliedRowCount: sealedCount,
      externalWrite: false,
    })
  }

  async function activate(input) {
    const call = readClosedCall(
      input,
      ['generationId', 'expectedActiveGenerationId'],
      'VISIBILITY',
    )
    if (
      typeof call.generationId !== 'string'
      || !GENERATION_ID_PATTERN.test(call.generationId)
      || (
        call.expectedActiveGenerationId !== null
        && (
          typeof call.expectedActiveGenerationId !== 'string'
          || !GENERATION_ID_PATTERN.test(call.expectedActiveGenerationId)
        )
      )
    ) {
      failSealedExport('SEALED_EXPORT_VISIBILITY_CAS_CONFLICT')
    }
    const candidate = await generationStore.readGeneration(
      authority,
      call.generationId,
    )
    if (candidate === null || candidate.status !== 'VERIFIED') {
      failSealedExport('SEALED_EXPORT_VISIBILITY_CAS_CONFLICT')
    }
    const candidateRowCount = normalizeCount(candidate.applied_row_count)
    const applied = await computeStoredRowsetDigest(
      generationStore,
      candidate.generation_id,
      'APPLIED',
      candidateRowCount,
    )
    const outcome = await generationStore.transaction(async (trx) => {
      const generation = await trx.readGeneration(authority, call.generationId)
      if (generation === null || generation.status !== 'VERIFIED') {
        failSealedExport('SEALED_EXPORT_VISIBILITY_CAS_CONFLICT')
      }
      const state = await trx.readAuthorityStateForUpdate(authority)
      const instant = nowInstant()
      const invalidReason = authorityReason(state, generation, instant.getTime())
      if (invalidReason !== null) {
        const quarantined = await trx.transitionToQuarantined(
          generation,
          instant.toISOString(),
          auditRow(
            generation,
            'QUARANTINED',
            invalidReason,
            instant.toISOString(),
            normalizeCount(generation.applied_row_count),
          ),
        )
        if (quarantined === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
        return Object.freeze({ kind: 'REFUSED', reason: invalidReason })
      }
      const rowCount = normalizeCount(generation.applied_row_count)
      if (
        !applied.ok
        || rowCount !== candidateRowCount
        || rowCount !== normalizeCount(generation.sealed_row_count)
        || rowCount !== normalizeCount(generation.manifest_row_count)
        || normalizeCount(generation.sealed_byte_count)
          !== normalizeCount(generation.manifest_byte_count)
        || normalizeCount(generation.sealed_chunk_count)
          !== normalizeCount(generation.manifest_chunk_count)
        || !digests.constantTimeEqualDigest(
          generation.sealed_artifact_digest,
          generation.manifest_artifact_digest,
        )
        || !digests.constantTimeEqualDigest(
          generation.sealed_rowset_digest,
          generation.manifest_rowset_digest,
        )
        || !digests.constantTimeEqualDigest(
          generation.sealed_receipt_set_digest,
          generation.manifest_chunk_set_digest,
        )
        || !digests.constantTimeEqualDigest(
          applied.digest,
          generation.applied_rowset_digest,
        )
        || !digests.constantTimeEqualDigest(
          applied.digest,
          generation.sealed_rowset_digest,
        )
      ) {
        const reason = 'SEALED_EXPORT_GENERATION_VERIFY_FAILED'
        const quarantined = await trx.transitionToQuarantined(
          generation,
          instant.toISOString(),
          auditRow(
            generation,
            'QUARANTINED',
            reason,
            instant.toISOString(),
            rowCount,
          ),
        )
        if (quarantined === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
        return Object.freeze({ kind: 'REFUSED', reason })
      }
      const pointerId = pointerIdFor(
        authority,
        generation.canonical_object_version,
      )
      const pointer = await trx.readPointer(pointerId)
      if (
        pointer === null
        || pointer.active_generation_id !== call.expectedActiveGenerationId
      ) {
        failSealedExport('SEALED_EXPORT_VISIBILITY_CAS_CONFLICT')
      }
      const updatedPointer = await trx.updatePointer(
        pointerId,
        call.expectedActiveGenerationId,
        normalizeCount(pointer.pointer_version),
        {
          active_generation_id: generation.generation_id,
          active_manifest_digest: generation.manifest_digest,
          pointer_version: normalizeCount(pointer.pointer_version) + 1,
        },
      )
      if (updatedPointer === null) {
        failSealedExport('SEALED_EXPORT_VISIBILITY_CAS_CONFLICT')
      }
      const active = await trx.activateGeneration(
        generation,
        instant.toISOString(),
        auditRow(generation, 'ACTIVE', null, instant.toISOString(), rowCount),
      )
      if (active === null) {
        failSealedExport('SEALED_EXPORT_VISIBILITY_CAS_CONFLICT')
      }
      return Object.freeze({
        kind: 'ACTIVE',
        generationId: active.generation_id,
        rowCount,
        pointerVersion: normalizeCount(updatedPointer.pointer_version),
      })
    })
    if (outcome.kind === 'REFUSED') refuseAuthority(outcome.reason)
    return Object.freeze({
      status: 'ACTIVE',
      rowCount: outcome.rowCount,
      pointerVersion: outcome.pointerVersion,
      domainIsolatedGenerationDigest: generationProjection(outcome.generationId),
      activePointerOutcome: 'FLIPPED',
      externalWrite: false,
    })
  }

  async function readActiveRows(input) {
    const call = readClosedCall(
      input,
      ['canonicalObjectVersion', 'offset', 'limit'],
    )
    if (
      !isBoundedString(call.canonicalObjectVersion)
      || !Number.isSafeInteger(call.offset)
      || call.offset < 0
      || !Number.isSafeInteger(call.limit)
      || call.limit < 1
      || call.limit > 1000
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const pointer = await generationStore.readPointer(
      pointerIdFor(authority, call.canonicalObjectVersion),
    )
    if (pointer === null || pointer.active_generation_id === null) {
      return Object.freeze([])
    }
    const generation = await generationStore.readGeneration(
      authority,
      pointer.active_generation_id,
    )
    if (
      generation === null
      || generation.status !== 'ACTIVE'
      || generation.manifest_digest !== pointer.active_manifest_digest
      || generation.canonical_object_version !== call.canonicalObjectVersion
    ) {
      failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
    }
    const rowCount = normalizeCount(generation.applied_row_count)
    const expectedPageLength = Math.min(
      call.limit,
      Math.max(0, rowCount - call.offset),
    )
    const rows = await generationStore.listGenerationRows(
      generation.generation_id,
      ['row_index', 'ASC'],
      call.limit,
      call.offset,
    )
    if (rows.length !== expectedPageLength) {
      failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
    }
    const values = []
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const expectedDigest = typeof row.canonical_row_text === 'string'
        ? digests.digestBytes(Buffer.from(row.canonical_row_text, 'utf8'))
        : Object.freeze({ ok: false })
      if (
        !Number.isSafeInteger(row.row_index)
        || row.row_index !== call.offset + index
        || typeof row.canonical_row_text !== 'string'
        || !canonicalCodec.isCanonicalJsonText(row.canonical_row_text)
        || !(row.row_sort_key instanceof Uint8Array)
        || !sameBytes(row.row_sort_key, utf16BeSortKey(row.canonical_row_text))
        || typeof row.row_digest !== 'string'
        || !expectedDigest.ok
        || !digests.constantTimeEqualDigest(
          row.row_digest,
          expectedDigest.digest,
        )
      ) {
        failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
      }
      let value
      try {
        value = JSON.parse(row.canonical_row_text)
      } catch {
        failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
      }
      const frozen = canonicalCodec.tryFreezeCanonical(value)
      if (!frozen.ok) failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
      values.push(frozen.value)
    }
    return Object.freeze(values)
  }

  return Object.freeze({
    stageAndSeal,
    beginApply,
    applyNextChunk,
    activate,
    readActiveRows,
  })
}

module.exports = Object.freeze({
  createSealedExportGenerationKernel,
  LEASE_DURATION_MS,
  ROW_BATCH_SIZE,
})
