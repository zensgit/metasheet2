import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'
import {
  uploadRecoveryArchivePreparedCapture,
  type RecoveryArchivePreparedUploadInput,
  decodeRecoveryArchivePreparedEnvelope,
} from './recovery-archive-prepared-upload'
import type { SealQuery } from './recovery-archive-seals'
import { bindRecoveryArchiveManualSourceRecheck, bindRecoveryArchiveManualNonceReservation, bindRecoveryArchiveManualSectionPlan, takeRecoveryArchiveManualSource,
  type RecoveryArchiveManualSource } from './recovery-archive-manual-admission'
import type { RecoveryArchiveCaptureSource } from './recovery-archive-relational-source'
import { buildRecoveryArchiveSectionRows } from './recovery-archive-section-rows'
import { canonicalizeRecoveryArchiveSectionRows } from './recovery-archive-manifest'
import { readRecoveryArchivePreparedCapture } from './recovery-archive-prepared-capture'
import { compileRecoveryArchiveObjectReceipt } from './recovery-archive-object-receipt-compiler'
import { recordRecoveryArchiveObjectUploaded } from './recovery-archive-object-receipts'
import type { RecoveryArchiveObjectStoreProvider } from './recovery-archive-object-store'

/** PUT/HEAD sealed section bytes only; verification and catalog publication remain a later transaction. */
export function bindRecoveryArchiveManualObjectUpload(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  input: Pick<RecoveryArchiveManualContinuationInput, 'identity' | 'owner' | 'transactionDepth'> & {
    provider: RecoveryArchiveObjectStoreProvider
  },
): RecoveryArchivePreparedUploadInput['upload'] {
  const identity = Object.freeze({ ...input.identity })
  const owner = Object.freeze({ ...input.owner })
  const provider = input.provider
  const transactionDepth = input.transactionDepth
  const authorizedPayload = async (query: SealQuery) => {
    let allowed = false
    try { allowed = await authorize(query, identity) } catch { /* Values-free below. */ }
    if (!allowed) throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
    const payload = await readRecoveryArchivePreparedCapture(query, owner)
    if (!payload) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
    const envelope = decodeRecoveryArchivePreparedEnvelope(payload)
    if (envelope.binding.generationId !== owner.generationId || envelope.binding.sheetId !== identity.sheetId
      || envelope.binding.baseId !== identity.baseId || envelope.binding.workspaceId !== identity.workspaceId) {
      throw new Error('RECOVERY_ARCHIVE_MANUAL_SCOPE_MISMATCH')
    }
    return { payload, envelope }
  }
  return async (_envelope, requestedSection) => {
    const name = requestedSection.sectionName
    const admitted = await transaction(async (query) => {
      const original = await authorizedPayload(query)
      const result = await query('SELECT expires_at FROM meta_recovery_archives WHERE generation_id=$1::uuid', [owner.generationId])
      const expiry = (result.rows[0] as { expires_at?: unknown } | undefined)?.expires_at
      if (!(expiry instanceof Date)) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
      return { ...original, expiresAt: expiry.toISOString() }
    })
    // Always upload the durable original, never bytes supplied by the callback caller.
    const section = admitted.envelope.sections.find((candidate) => candidate.sectionName === name)
    if (!section) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH')
    const sha256 = createHash('sha256').update(section.ciphertext).digest('hex')
    const evidence = await compileRecoveryArchiveObjectReceipt({ provider, transactionDepth,
      object: { generationId: owner.generationId, objectId: sha256, version: sha256,
        sha256, size: String(section.ciphertext.byteLength), bytes: section.ciphertext,
        expiresAt: admitted.expiresAt, pinned: false },
      objectClass: 'section', sectionName: name, attachmentId: null,
      keyId: admitted.envelope.binding.keyId, plaintextSha256: section.plaintextSha256,
      ownerKind: owner.ownerKind, ownerId: owner.ownerId, ownerFence: owner.ownerFence })
    await transaction(async (query) => {
      const current = await authorizedPayload(query)
      if (!current.payload.equals(admitted.payload)) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_CONFLICT')
      await recordRecoveryArchiveObjectUploaded(query, evidence)
    })
  }
}

export type RecoveryArchiveManualContinuationInput =
  Omit<RecoveryArchivePreparedUploadInput, 'transaction' | 'checkAuthority' | 'capture'> & {
    /** Server-owned identity; durable request admission must supply it, never request-body aliases. */
    identity: RecoveryArchiveScopeIdentity
    source?: RecoveryArchiveManualSource | null
    capture: (source: RecoveryArchiveCaptureSource) => ReturnType<RecoveryArchivePreparedUploadInput['capture']>
  }

/** Internal wiring only. Does not admit a request, mint a generation or publish an archive. */
export function bindRecoveryArchiveManualContinuation(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
) {
  const recheckSource = bindRecoveryArchiveManualSourceRecheck(transaction, authorize)
  const prepareSections = bindRecoveryArchiveManualSectionPlan(transaction, authorize)
  return async (input: RecoveryArchiveManualContinuationInput): Promise<void> => {
    const identity = Object.freeze({ ...input.identity })
    const binding = Object.freeze({ ...input.binding })
    const owner = Object.freeze({ ...input.owner })
    const source = input.source
    const capture = input.capture
    if (identity.sheetId !== binding.sheetId || identity.baseId !== binding.baseId
      || identity.workspaceId !== binding.workspaceId) {
      throw new Error('RECOVERY_ARCHIVE_MANUAL_SCOPE_MISMATCH')
    }
    await uploadRecoveryArchivePreparedCapture({
      owner, binding, upload: input.upload,
      capture: async () => {
        if (!source) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
        const snapshot = takeRecoveryArchiveManualSource(source, identity, owner, binding)
        if (snapshot.attachmentCandidates.length) throw new Error('RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE')
        await recheckSource(source)
        const expected = structuredClone(snapshot)
        const proposed = await capture(snapshot)
        const sections = proposed.sections.map((section) => ({ sectionName: section.sectionName,
          plaintext: Buffer.from(section.plaintext), nonce: Buffer.from(section.nonce) }))
        const sectionRows = { ...expected.sections, attachments_index: [], permission_evidence: [] }
        for (const name of Object.keys(sectionRows) as (keyof typeof sectionRows)[]) {
          const matches = sections.filter((section) => section.sectionName === name)
          const canonical = canonicalizeRecoveryArchiveSectionRows(name, buildRecoveryArchiveSectionRows(name, sectionRows[name]))
          if (matches.length !== 1 || !matches[0]!.plaintext.equals(Buffer.from(canonical.canonicalJson))) {
            throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH')
          }
        }
        if (sections.length !== 10 || new Set(sections.map((section) => section.sectionName)).size !== 10) {
          throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH')
        }
        const nonces = Object.fromEntries(sections.map((section) => [section.sectionName, section.nonce]))
        const canonicalSections = await prepareSections(source, nonces)
        return { ...proposed, binding: { ...proposed.binding }, sections: canonicalSections,
          reserveNonces: bindRecoveryArchiveManualNonceReservation(transaction, authorize, source) }
      },
      transactionDepth: input.transactionDepth, transaction,
      checkAuthority: async () => {
        let allowed = false
        try { allowed = await transaction((query) => authorize(query, identity)) } catch {
          throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
        }
        if (!allowed) throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
      },
    })
  }
}
import { createHash } from 'node:crypto'
