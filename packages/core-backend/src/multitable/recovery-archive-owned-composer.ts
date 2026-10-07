import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Pool } from 'pg'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim,
  type RecoveryArchiveCommittedClaimSnapshot } from './recovery-archive-owned-claim'
import { bindRecoveryArchiveOwnedCapture } from './recovery-archive-owned-capture'
import { admitRecoveryArchiveOwnedAttempt, recoveryArchiveOwnedAttempt, recheckRecoveryArchiveOwnedAttempt,
  runRecoveryArchiveOwnedTransaction, abandonRecoveryArchiveOwnedClaim, refuseOwned } from './recovery-archive-owned-authority'
import { planRecoveryArchiveOwnedHistory } from './recovery-archive-owned-history'
import { finalizeRecoveryArchiveOwnedAttempt } from './recovery-archive-owned-finalization'
import { snapshotRecoveryArchiveCaptureLimits, type RecoveryArchiveCaptureLimits } from './recovery-archive-bounded-source'
import { snapshotRecoveryArchiveManualPolicy, type RecoveryArchiveManualAdmissionPolicy } from './recovery-archive-manual-admission'
import { verifyRecoveryArchiveSourcePin } from './recovery-archive-source-pin'
import { persistRecoveryArchivePreparedCapture, readRecoveryArchivePreparedCapture } from './recovery-archive-prepared-capture'
import { encodeRecoveryArchivePreparedEnvelope, decodeRecoveryArchivePreparedEnvelope } from './recovery-archive-prepared-upload'
import { buildRecoveryArchiveSealedSnapshotManifest } from './recovery-archive-sealed-snapshot-manifest'
import { authenticateRecoveryArchiveSealedSnapshotManifest } from './recovery-archive-authenticated-manifest'
import { compileRecoveryArchiveObjectReceipt } from './recovery-archive-object-receipt-compiler'
import { recordRecoveryArchiveObjectUploaded } from './recovery-archive-object-receipts'
import { reserveThenSealRecoveryArchiveSections, createTransactionGuardedKeyCustody,
  assertKeyCustodyCallOutsideTransaction } from './recovery-archive-crypto'
import { recoveryArchiveAttachmentNonceIdentity } from './recovery-archive-attachment-crypto'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from './recovery-archive-contract'
import type { RecoveryArchivePreviewRuntime } from './recovery-archive-preview'
import type { RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import type { SealQuery } from './recovery-archive-seals'
import type { ContentAddressedAttachmentSource } from '../services/StorageService'

export interface RecoveryArchiveOwnedComposerOptions {
  pool: Pick<Pool, 'connect' | 'options'>
  limits: RecoveryArchiveCaptureLimits
  readContentAddressedBounded?: (storageKey: string, maxBytes: number) => Promise<ContentAddressedAttachmentSource>
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const CLOSED_FAILURE_CODES = new Set([
  'RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID', 'RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED',
  'RECOVERY_ARCHIVE_CAPTURE_BYTE_LIMIT_EXCEEDED', 'RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE',
  'RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED', 'RECOVERY_ARCHIVE_CAPTURE_FENCE_HELD',
  'RECOVERY_ARCHIVE_CAPTURE_CAPABILITY_UNAVAILABLE', 'RECOVERY_ARCHIVE_OWNED_AUTHORITY_UNAVAILABLE',
  'RECOVERY_ARCHIVE_CLAIM_INVALID_INPUT', 'RECOVERY_ARCHIVE_CLAIM_POLICY_INVALID',
  'RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE', 'RECOVERY_ARCHIVE_CLAIM_AUTHORITY_UNAVAILABLE',
  'RECOVERY_ARCHIVE_CLAIM_ATTACHMENT_UNAVAILABLE', 'RECOVERY_ARCHIVE_CLAIM_BYTE_LIMIT_EXCEEDED',
  'RECOVERY_ARCHIVE_CLAIM_TIME_EXCEEDED', 'RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE',
  'RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE', 'RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_CHANGED',
  'RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED',
])
/** Unknown adapter/SQL exceptions never cross the owned command boundary with their cause or values. */
export function normalizeRecoveryArchiveOwnedFailure(error: unknown): Error {
  const code = error instanceof Error && CLOSED_FAILURE_CODES.has(error.message)
    ? error.message : 'RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED'
  return new Error(code)
}


/** One private plaintext attempt. Replay returns its generation id without restarting downstream phases. */
export function bindRecoveryArchiveOwnedComposer(options: RecoveryArchiveOwnedComposerOptions,
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  runtime: RecoveryArchivePreviewRuntime, policyInput: RecoveryArchiveManualAdmissionPolicy) {
  const limits = snapshotRecoveryArchiveCaptureLimits(options?.limits)
  const policy = snapshotRecoveryArchiveManualPolicy(policyInput)
  const pool = options?.pool
  const acquisition = pool?.options?.connectionTimeoutMillis
  if (typeof pool?.connect !== 'function' || !Number.isSafeInteger(acquisition) || !acquisition
    || acquisition < 1 || acquisition > limits.timeoutMs) throw new Error('RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID')
  const readContent = options.readContentAddressedBounded
  return async (identity: RecoveryArchiveManualRequest): Promise<string> => {
    const deadline = performance.now() + limits.timeoutMs
    let poisoned = false
    const depth = { value: 0 }
    let bytes = 0
    let claim: RecoveryArchiveCommittedClaimSnapshot | undefined
    const attachments: Array<{ attachmentId: string; sourceVersion: string; plaintext: Buffer; nonce: Buffer }> = []
    const live = () => { if (poisoned || performance.now() >= deadline) throw new Error('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED') }
    const remaining = () => { live(); return Math.max(1, Math.ceil(deadline - performance.now())) }
    const charge = (length: number) => {
      live()
      if (!Number.isSafeInteger(length) || length < 0 || bytes + length > limits.maxBytes) throw new Error('RECOVERY_ARCHIVE_CAPTURE_BYTE_LIMIT_EXCEEDED')
      bytes += length
    }
    const probe = Object.freeze({ currentTransactionDepth: () => { live(); return depth.value + runtime.transactionDepth.currentTransactionDepth() } })
    const outside = () => {
      live()
      if (process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED !== 'true' || process.env.MULTITABLE_ENABLE_WRITER_FENCE !== 'true') refuseOwned()
      assertKeyCustodyCallOutsideTransaction(probe)
    }
    const transaction = <T>(work: (query: SealQuery) => Promise<T>) => {
      outside()
      return runRecoveryArchiveOwnedTransaction(pool, remaining(), depth, work)
    }
    const provider = {
      put: async (...args: Parameters<typeof runtime.objectStore.put>) => { outside(); const result = await runtime.objectStore.put(...args); outside(); return result },
      head: async (...args: Parameters<typeof runtime.objectStore.head>) => { outside(); const result = await runtime.objectStore.head(...args); outside(); return result },
      get: async (...args: Parameters<typeof runtime.objectStore.get>) => { outside(); const result = await runtime.objectStore.get(...args); outside(); return result },
      pin: async (...args: Parameters<typeof runtime.objectStore.pin>) => { outside(); const result = await runtime.objectStore.pin(...args); outside(); return result },
      deleteExpired: async (...args: Parameters<typeof runtime.objectStore.deleteExpired>) => { outside(); const result = await runtime.objectStore.deleteExpired(...args); outside(); return result },
    }
    let cleanup: Promise<void> | undefined
    const cleanupOnce = (): Promise<void> => {
      // No issued claim means no cleanup authority, including an uncertain claim COMMIT.
      if (!claim) return Promise.resolve()
      if (!cleanup) cleanup = runRecoveryArchiveOwnedTransaction(pool, limits.timeoutMs, depth,
        (query) => abandonRecoveryArchiveOwnedClaim(query, claim!)).catch(() => {
          // Retained exact owner/lease remains the separate expiry/cleanup protocol's responsibility.
        })
      return cleanup
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        poisoned = true
        // Cleanup does not wait for an unresponsive reader, custody adapter or provider.
        void cleanupOnce().finally(() => reject(new Error('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')))
      }, limits.timeoutMs)
    })
    const execution = (async () => {
      try {
        outside()
        const admitted = await bindRecoveryArchiveOwnedClaim(pool, authorize, policy,
          { maxBytes: limits.maxBytes, timeoutMs: remaining() })(identity)
        if (!admitted.claim) { live(); return admitted.generationId }
        claim = readRecoveryArchiveCommittedClaim(admitted.claim)
        live()
        const captured = await bindRecoveryArchiveOwnedCapture(pool, authorize,
          { maxBytes: limits.maxBytes, timeoutMs: remaining() })(admitted.claim)
        live()
        const attempt = admitRecoveryArchiveOwnedAttempt(captured)
        const state = recoveryArchiveOwnedAttempt(attempt)
        charge(Buffer.byteLength(JSON.stringify(state.captured)))
        const recheck = (query: SealQuery) => recheckRecoveryArchiveOwnedAttempt(query, attempt, authorize)
        if (state.captured.attachmentDescriptors.length && !readContent) throw new Error('RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE')
        for (const descriptor of state.captured.attachmentDescriptors) {
          await transaction(recheck)
          outside()
          const source = await readContent!(descriptor.storageKey, limits.maxBytes - bytes)
          try { outside() } catch (error) { source.bytes.fill(0); throw error }
          if (!Buffer.isBuffer(source.bytes) || String(source.sizeBytes) !== descriptor.contentSizeBytes
            || source.bytes.length !== source.sizeBytes || source.immutableVersion !== descriptor.immutableVersion
            || source.contentSha256 !== descriptor.contentSha256 || digest(source.bytes) !== descriptor.contentSha256) {
            source.bytes.fill(0)
            throw new Error('RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_CHANGED')
          }
          attachments.push({ attachmentId: descriptor.attachmentId, sourceVersion: source.immutableVersion,
            plaintext: source.bytes, nonce: randomBytes(12) })
          charge(source.bytes.length)
        }
        await transaction(async (query) => {
          await recheck(query)
          for (const descriptor of state.captured.attachmentDescriptors) await verifyRecoveryArchiveSourcePin(query, {
            ...claim!.generationOwner, keyId: claim!.key.keyId, leaseUntil: claim!.leaseUntil,
            attachmentId: descriptor.attachmentId, immutableVersion: descriptor.immutableVersion,
            contentSha256: descriptor.contentSha256, contentSizeBytes: descriptor.contentSizeBytes,
          })
        })
        state.available = true
        const attachmentIndex = state.captured.source.attachmentCandidates.map((candidate) => {
          const descriptor = state.captured.attachmentDescriptors.find((item) => item.attachmentId === candidate.attachmentId)!
          return { attachment_id: candidate.attachmentId, record_id: candidate.recordId, field_id: candidate.fieldId,
            immutable_object_version: descriptor.immutableVersion, plaintext_sha256: descriptor.contentSha256,
            size_bytes: descriptor.contentSizeBytes, media_type: candidate.mediaType, deleted: candidate.deleted }
        })
        const nonces = Object.fromEntries(RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name) => [name, randomBytes(12)]))
        const planned = planRecoveryArchiveOwnedHistory(attempt, attachmentIndex, nonces)
        charge(planned.sections.reduce((size, section) => size + section.plaintext.length, 0))
        const binding = { formatVersion: 1 as const, generationId: claim.generationOwner.generationId,
          workspaceId: identity.workspaceId, baseId: identity.baseId, sheetId: identity.sheetId,
          anchorOperationId: claim.reservationPlan.snapshotOperationId, anchorSeq: claim.reservationPlan.snapshotSeq,
          checkpointId: claim.checkpointId, keyId: claim.key.keyId, aeadAlgorithm: 'aes-256-gcm' as const }
        outside()
        const sealed = await reserveThenSealRecoveryArchiveSections({ binding, keyCustody: runtime.keyCustody,
          transactionDepth: probe, dekSource: { kind: 'produce' }, sections: planned.sections, attachments,
          reserveNonces: async (input) => {
            const expected = [...planned.sections.map((section) => ({ name: section.sectionName, nonce: Buffer.from(section.nonce).toString('hex') })),
              ...attachments.map((attachment) => ({ name: recoveryArchiveAttachmentNonceIdentity(attachment.attachmentId), nonce: attachment.nonce.toString('hex') }))]
            const rows = input.map((row) => ({ ...row }))
            if (rows.length !== expected.length || rows.some((row, index) => row.sectionName !== expected[index]!.name
              || row.nonceHex !== expected[index]!.nonce || row.generationId !== binding.generationId
              || row.dekFingerprint !== rows[0]!.dekFingerprint || row.formatVersion !== 1 || row.aeadAlgorithm !== binding.aeadAlgorithm)) refuseOwned()
            await transaction(async (query) => {
              await recheck(query)
              for (const row of rows) await query('SELECT public.meta_recovery_archive_reserve_nonce($1,$2,$3::uuid,$4,$5,$6)',
                [row.dekFingerprint, row.nonceHex, row.generationId, row.sectionName, row.aeadAlgorithm, row.formatVersion])
            })
            state.nonces = Object.freeze(rows)
            outside()
          },
        })
        outside()
        const manifestBinding = { archive_generation_id: binding.generationId, workspace_id: binding.workspaceId,
          base_id: binding.baseId, sheet_id: binding.sheetId, anchor_operation_id: binding.anchorOperationId,
          anchor_seq: binding.anchorSeq, checkpoint_id: binding.checkpointId, created_at: claim.generationCreatedAt,
          expires_at: new Date(claim.expiresAt).toISOString(), source_vector_hash: claim.generationOwner.sourceVectorHash }
        const unsigned = buildRecoveryArchiveSealedSnapshotManifest({ binding: manifestBinding,
          keyId: binding.keyId, plan: planned.sections, sealResult: sealed })
        const signed = await authenticateRecoveryArchiveSealedSnapshotManifest({ sealedManifest: unsigned,
          keyCustody: runtime.keyCustody, transactionDepth: probe })
        outside()
        const custody = createTransactionGuardedKeyCustody(runtime.keyCustody, probe)
        if (await custody.verifyManifestRootMac({ keyId: binding.keyId, preimage: signed.macPreimage,
          mac: signed.manifestMacBytes }) !== true) refuseOwned()
        outside()
        const payload = encodeRecoveryArchivePreparedEnvelope(sealed, signed.envelopeBytes)
        charge(payload.length)
        await transaction(async (query) => {
          await recheck(query)
          await persistRecoveryArchivePreparedCapture(query, claim!.generationOwner, payload)
        })
        state.payload = Buffer.from(payload)
        const envelope = decodeRecoveryArchivePreparedEnvelope(payload)
        const objects = [...envelope.sections.map((section) => ({ objectClass: 'section' as const, sectionName: section.sectionName,
          attachmentId: null, bytes: Buffer.concat([section.ciphertext, section.authTag]), plaintextHash: section.plaintextSha256 })),
          ...(envelope.attachments ?? []).map((attachment) => ({ objectClass: 'attachment' as const, sectionName: null,
            attachmentId: attachment.attachmentId, bytes: Buffer.concat([attachment.nonce, attachment.ciphertext, attachment.authTag]),
            plaintextHash: attachment.plaintextSha256 })),
          { objectClass: 'manifest' as const, sectionName: null, attachmentId: null, bytes: envelope.manifestEnvelope!, plaintextHash: digest(envelope.manifestEnvelope!) }]
        for (const object of objects) {
          await transaction(async (query) => {
            await recheck(query)
            if (!(await readRecoveryArchivePreparedCapture(query, claim!.generationOwner))?.equals(payload)) refuseOwned()
          })
          outside()
          const hash = digest(object.bytes)
          const receipt = await compileRecoveryArchiveObjectReceipt({ provider, transactionDepth: probe,
            object: { generationId: binding.generationId, objectId: hash, version: hash, sha256: hash,
              size: String(object.bytes.length), bytes: object.bytes, expiresAt: manifestBinding.expires_at, pinned: false },
            objectClass: object.objectClass, sectionName: object.sectionName, attachmentId: object.attachmentId,
            keyId: binding.keyId, plaintextSha256: object.plaintextHash,
            ownerKind: claim.generationOwner.ownerKind, ownerId: claim.generationOwner.ownerId, ownerFence: claim.generationOwner.ownerFence })
          outside()
          await transaction(async (query) => {
            await recheck(query)
            if (!(await readRecoveryArchivePreparedCapture(query, claim!.generationOwner))?.equals(payload)) refuseOwned()
            await recordRecoveryArchiveObjectUploaded(query, receipt)
          })
          state.receipts.push(receipt)
        }
        await transaction((query) => finalizeRecoveryArchiveOwnedAttempt(query, attempt, authorize, planned, attachmentIndex))
        live()
        return binding.generationId
      } catch (error) {
        await cleanupOnce()
        throw normalizeRecoveryArchiveOwnedFailure(error)
      } finally { for (const attachment of attachments) attachment.plaintext.fill(0) }
    })()
    try { return await Promise.race([execution, expiry]) }
    finally {
      if (timer) clearTimeout(timer)
      for (const attachment of attachments) attachment.plaintext.fill(0)
      void execution.catch(() => {})
    }
  }
}
