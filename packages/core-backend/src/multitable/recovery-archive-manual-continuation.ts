import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'
import {
  uploadRecoveryArchivePreparedCapture,
  type RecoveryArchivePreparedUploadInput,
  decodeRecoveryArchivePreparedEnvelope,
} from './recovery-archive-prepared-upload'
import type { SealQuery } from './recovery-archive-seals'
import { bindRecoveryArchiveManualSourceRecheck, bindRecoveryArchiveManualNonceReservation, bindRecoveryArchiveManualSectionPlan, takeRecoveryArchiveManualSource,
  bindRecoveryArchiveManualAttachmentRead, readRecoveryArchiveManualAttachmentIndex,
  type RecoveryArchiveManualSource } from './recovery-archive-manual-admission'
import type { RecoveryArchiveCaptureSource } from './recovery-archive-relational-source'
import { buildRecoveryArchiveSectionRows } from './recovery-archive-section-rows'
import { canonicalizeRecoveryArchiveSectionRows } from './recovery-archive-manifest'
import { readRecoveryArchivePreparedCapture } from './recovery-archive-prepared-capture'
import { compileRecoveryArchiveObjectReceipt } from './recovery-archive-object-receipt-compiler'
import { recordRecoveryArchiveObjectUploaded } from './recovery-archive-object-receipts'
import type { RecoveryArchiveObjectStoreProvider } from './recovery-archive-object-store'
import { bindRecoveryArchiveManualManifestBinding } from './recovery-archive-manual-admission'
import { buildRecoveryArchiveSealedSnapshotManifest } from './recovery-archive-sealed-snapshot-manifest'
import { authenticateRecoveryArchiveSealedSnapshotManifest } from './recovery-archive-authenticated-manifest'
import { parseRecoveryArchiveManifestObjectEnvelope } from './recovery-archive-manifest-object-envelope'
import type { RecoveryArchiveSectionName } from './recovery-archive-contract'

type ManualObjectUploadInput = Pick<RecoveryArchiveManualContinuationInput, 'identity' | 'owner' | 'transactionDepth'> & {
  provider: RecoveryArchiveObjectStoreProvider
}

/** PUT/HEAD sealed section bytes only; verification and catalog publication remain a later transaction. */
export function bindRecoveryArchiveManualObjectUpload(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  input: ManualObjectUploadInput,
): RecoveryArchivePreparedUploadInput['upload'] {
  const upload = bindManualObjectUpload(transaction, authorize, input)
  return async (_envelope, section) => upload(section.sectionName)
}

/** Upload only the durable signed envelope. Does not mark any object verified or publish the catalog. */
export function bindRecoveryArchiveManualManifestUpload(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  input: ManualObjectUploadInput,
): () => Promise<void> {
  const upload = bindManualObjectUpload(transaction, authorize, input)
  return () => upload(null)
}

/** Attachment bytes are selected from the immutable prepared batch, never supplied by the callback. */
export function bindRecoveryArchiveManualAttachmentUpload(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  input: ManualObjectUploadInput,
): NonNullable<RecoveryArchivePreparedUploadInput['uploadAttachment']> {
  const upload = bindManualObjectUpload(transaction, authorize, input)
  return async (_envelope, attachment) => upload({ attachmentId: attachment.attachmentId })
}

function bindManualObjectUpload(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  input: ManualObjectUploadInput,
): (name: RecoveryArchiveSectionName | null | { attachmentId: string }) => Promise<void> {
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
  return async (name) => {
    const admitted = await transaction(async (query) => {
      const original = await authorizedPayload(query)
      const result = await query('SELECT expires_at FROM meta_recovery_archives WHERE generation_id=$1::uuid', [owner.generationId])
      const expiry = (result.rows[0] as { expires_at?: unknown } | undefined)?.expires_at
      if (!(expiry instanceof Date)) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
      return { ...original, expiresAt: expiry.toISOString() }
    })
    // Always upload the durable original, never bytes supplied by the callback caller.
    const attachmentId = name !== null && typeof name === 'object' ? name.attachmentId : null
    const attachment = attachmentId === null ? undefined
      : admitted.envelope.attachments?.find((candidate) => candidate.attachmentId === attachmentId)
    const section = typeof name !== 'string' ? null : admitted.envelope.sections.find((candidate) => candidate.sectionName === name)
    // Sections take their nonce from the manifest. Attachment objects prefix the 12-byte nonce;
    // both formats end with the 16-byte GCM tag, and the receipt hashes the complete framing.
    const bytes = name === null ? admitted.envelope.manifestEnvelope
      : attachment ? Buffer.concat([attachment.nonce, attachment.ciphertext, attachment.authTag])
        : section ? Buffer.concat([section.ciphertext, section.authTag]) : undefined
    if (!bytes) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH')
    if (name === null) {
      const signed = parseRecoveryArchiveManifestObjectEnvelope(bytes)
      if (signed.manifest.expires_at !== admitted.expiresAt || signed.manifest.source_vector_hash !== owner.sourceVectorHash) {
        throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH')
      }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const evidence = await compileRecoveryArchiveObjectReceipt({ provider, transactionDepth,
      object: { generationId: owner.generationId, objectId: sha256, version: sha256,
        sha256, size: String(bytes.byteLength), bytes,
        expiresAt: admitted.expiresAt, pinned: false },
      objectClass: name === null ? 'manifest' : attachment ? 'attachment' : 'section',
      sectionName: typeof name === 'string' ? name : null, attachmentId,
      keyId: admitted.envelope.binding.keyId, plaintextSha256: attachment?.plaintextSha256 ?? section?.plaintextSha256 ?? sha256,
      ownerKind: owner.ownerKind, ownerId: owner.ownerId, ownerFence: owner.ownerFence })
    await transaction(async (query) => {
      const current = await authorizedPayload(query)
      if (!current.payload.equals(admitted.payload)) throw new Error('RECOVERY_ARCHIVE_PREPARED_CAPTURE_CONFLICT')
      await recordRecoveryArchiveObjectUploaded(query, evidence)
    })
  }
}

export type RecoveryArchiveManualContinuationInput =
  Omit<RecoveryArchivePreparedUploadInput, 'transaction' | 'checkAuthority' | 'capture' | 'authenticateCapture'> & {
    /** Server-owned identity; durable request admission must supply it, never request-body aliases. */
    identity: RecoveryArchiveScopeIdentity
    source?: RecoveryArchiveManualSource | null
    capture: (source: RecoveryArchiveCaptureSource) => ReturnType<RecoveryArchivePreparedUploadInput['capture']>
  }

/** Internal wiring only. Does not admit a request, mint a generation or publish an archive. */
export function bindRecoveryArchiveManualContinuation(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  readContentAddressed?: Parameters<typeof bindRecoveryArchiveManualAttachmentRead>[2],
) {
  const recheckSource = bindRecoveryArchiveManualSourceRecheck(transaction, authorize)
  const prepareSections = bindRecoveryArchiveManualSectionPlan(transaction, authorize)
  const manifestBinding = bindRecoveryArchiveManualManifestBinding(transaction, authorize)
  const readAttachments = readContentAddressed ? bindRecoveryArchiveManualAttachmentRead(transaction, authorize, readContentAddressed) : undefined
  return async (input: RecoveryArchiveManualContinuationInput): Promise<void> => {
    const identity = Object.freeze({ ...input.identity })
    const binding = Object.freeze({ ...input.binding })
    const owner = Object.freeze({ ...input.owner })
    const source = input.source
    const capture = input.capture
    let prepared: { plan: Awaited<ReturnType<typeof prepareSections>>;
      keyCustody: Awaited<ReturnType<typeof capture>>['keyCustody'] } | undefined
    if (identity.sheetId !== binding.sheetId || identity.baseId !== binding.baseId
      || identity.workspaceId !== binding.workspaceId) {
      throw new Error('RECOVERY_ARCHIVE_MANUAL_SCOPE_MISMATCH')
    }
    let attachmentSources: Awaited<ReturnType<NonNullable<typeof readAttachments>>> = []
    try { await uploadRecoveryArchivePreparedCapture({
      owner, binding, upload: input.upload, uploadAttachment: input.uploadAttachment,
      capture: async () => {
        if (!source) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
        const snapshot = takeRecoveryArchiveManualSource(source, identity, owner, binding)
        if (snapshot.attachmentCandidates.length) {
          if (!readAttachments) throw new Error('RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE')
          attachmentSources = await readAttachments(source)
        }
        await recheckSource(source)
        const expected = structuredClone(snapshot)
        const proposed = await capture(snapshot)
        const sections = proposed.sections.map((section) => ({ sectionName: section.sectionName,
          plaintext: Buffer.from(section.plaintext), nonce: Buffer.from(section.nonce) }))
        const attachmentIndex = readRecoveryArchiveManualAttachmentIndex(source)
        const sectionRows = { ...expected.sections, attachments_index: attachmentIndex, permission_evidence: [] }
        for (const section of sections) if (attachmentIndex.length && section.sectionName === 'attachments_index') {
          section.plaintext = Buffer.from(canonicalizeRecoveryArchiveSectionRows('attachments_index',
            buildRecoveryArchiveSectionRows('attachments_index', attachmentIndex)).canonicalJson)
        }
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
        prepared = { plan: canonicalSections, keyCustody: proposed.keyCustody }
        return { ...proposed, binding: { ...proposed.binding }, sections: canonicalSections,
          attachments: attachmentSources.map((attachment) => ({ attachmentId: attachment.attachmentId,
            sourceVersion: attachment.sourceVersion, plaintext: attachment.plaintext, nonce: randomBytes(12) })),
          reserveNonces: bindRecoveryArchiveManualNonceReservation(transaction, authorize, source) }
      },
      authenticateCapture: async (sealed) => {
        if (!source || !prepared) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
        const canonicalBinding = await manifestBinding(source)
        const unsigned = buildRecoveryArchiveSealedSnapshotManifest({ binding: canonicalBinding,
          keyId: binding.keyId, plan: prepared.plan, sealResult: sealed })
        const signed = await authenticateRecoveryArchiveSealedSnapshotManifest({ sealedManifest: unsigned,
          keyCustody: prepared.keyCustody, transactionDepth: input.transactionDepth })
        await recheckSource(source)
        return signed.envelopeBytes
      },
      transactionDepth: input.transactionDepth, transaction,
      checkAuthority: async () => {
        let allowed = false
        try { allowed = await transaction((query) => authorize(query, identity)) } catch {
          throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
        }
        if (!allowed) throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
      },
    }) } finally { for (const attachment of attachmentSources) attachment.plaintext.fill(0) }
  }
}
import { createHash, randomBytes } from 'node:crypto'
