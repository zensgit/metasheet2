import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'
import {
  uploadRecoveryArchivePreparedCapture,
  type RecoveryArchivePreparedUploadInput,
} from './recovery-archive-prepared-upload'
import type { SealQuery } from './recovery-archive-seals'

export type RecoveryArchiveManualContinuationInput =
  Omit<RecoveryArchivePreparedUploadInput, 'transaction' | 'checkAuthority'> & {
    /** Server-owned identity; durable request admission must supply it, never request-body aliases. */
    identity: RecoveryArchiveScopeIdentity
  }

/** Internal wiring only. Does not admit a request, mint a generation or publish an archive. */
export function bindRecoveryArchiveManualContinuation(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
) {
  return async (input: RecoveryArchiveManualContinuationInput): Promise<void> => {
    const identity = Object.freeze({ ...input.identity })
    const binding = Object.freeze({ ...input.binding })
    if (identity.sheetId !== binding.sheetId || identity.baseId !== binding.baseId
      || identity.workspaceId !== binding.workspaceId) {
      throw new Error('RECOVERY_ARCHIVE_MANUAL_SCOPE_MISMATCH')
    }
    await uploadRecoveryArchivePreparedCapture({
      owner: input.owner, binding, capture: input.capture, upload: input.upload,
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
