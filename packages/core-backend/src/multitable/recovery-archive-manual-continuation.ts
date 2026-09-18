import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'
import {
  uploadRecoveryArchivePreparedCapture,
  type RecoveryArchivePreparedUploadInput,
} from './recovery-archive-prepared-upload'
import type { SealQuery } from './recovery-archive-seals'
import { bindRecoveryArchiveManualSourceRecheck, bindRecoveryArchiveManualNonceReservation, bindRecoveryArchiveManualSectionPlan, takeRecoveryArchiveManualSource,
  type RecoveryArchiveManualSource } from './recovery-archive-manual-admission'
import type { RecoveryArchiveCaptureSource } from './recovery-archive-relational-source'
import { buildRecoveryArchiveSectionRows } from './recovery-archive-section-rows'
import { canonicalizeRecoveryArchiveSectionRows } from './recovery-archive-manifest'

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
