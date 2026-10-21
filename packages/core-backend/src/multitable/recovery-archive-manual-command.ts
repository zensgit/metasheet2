import { randomBytes } from 'node:crypto'
import { acquireCanonicalSheetFence } from './canonical-sheet-fence'
import { bindRecoveryArchiveManualAdmission, snapshotRecoveryArchiveManualPolicy,
  type RecoveryArchiveManualAdmissionPolicy } from './recovery-archive-manual-admission'
import { bindRecoveryArchiveManualContinuation, bindRecoveryArchiveManualObjectUpload,
  bindRecoveryArchiveManualManifestUpload, bindRecoveryArchiveManualAttachmentUpload } from './recovery-archive-manual-continuation'
import { bindRecoveryArchiveManualFinalization } from './recovery-archive-manual-finalization'
import { readRecoveryArchiveManualRequest, type RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import type { RecoveryArchivePreparedUploadInput } from './recovery-archive-prepared-upload'
import type { RecoveryArchivePreviewRuntime } from './recovery-archive-preview'
import type { SealQuery } from './recovery-archive-seals'
import { isRecoveryArchiveRestoreWorkerEnabled } from './recovery-archive-restore-worker'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from './recovery-archive-contract'
import { buildRecoveryArchiveSectionRows } from './recovery-archive-section-rows'
import { canonicalizeRecoveryArchiveSectionRows } from './recovery-archive-manifest'

export interface RecoveryArchiveManualStatus {
  readonly requestId: string
  readonly generationId: string
  readonly state: 'pending' | 'incomplete' | 'recoverable'
}

/** Request-owned status and explicit synchronous command. No scheduler, lease renewal or source recapture. */
export function bindRecoveryArchiveManualCommand(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  runtime: RecoveryArchivePreviewRuntime,
  policyInput?: RecoveryArchiveManualAdmissionPolicy,
  readContentAddressed?: Parameters<typeof bindRecoveryArchiveManualContinuation>[2],
) {
  const policy = policyInput === undefined ? undefined : snapshotRecoveryArchiveManualPolicy(policyInput)
  const admit = policy ? bindRecoveryArchiveManualAdmission(transaction, authorize, policy) : undefined
  const continueCapture = bindRecoveryArchiveManualContinuation(transaction, authorize, readContentAddressed)
  const finalize = bindRecoveryArchiveManualFinalization(transaction, authorize)
  const assertEnabled = () => {
    if (!isRecoveryArchiveRestoreWorkerEnabled()) throw new Error('RECOVERY_ARCHIVE_MANUAL_UNAVAILABLE')
  }
  const read = async (input: RecoveryArchiveManualRequest) => {
    assertEnabled()
    const identity = Object.freeze({ ...input })
    return transaction(async (query) => {
      await acquireCanonicalSheetFence(query, identity.sheetId)
      if (!await authorize(query, identity)) throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
      const generationId = await readRecoveryArchiveManualRequest(query, identity)
      if (!generationId) throw new Error('RECOVERY_ARCHIVE_MANUAL_NOT_FOUND')
      const result = await query(`SELECT state,build_status,coverage_status,
        expires_at>clock_timestamp() AS unexpired,lease_expires_at>clock_timestamp() AS leased,
        anchor_operation_id::text,anchor_seq::text,checkpoint_id,key_id,owner_kind,owner_id,
        owner_fence::text,source_vector_hash,
        EXISTS(SELECT 1 FROM meta_recovery_archive_prepared_captures p WHERE p.generation_id=a.generation_id) AS prepared
        FROM meta_recovery_archives a WHERE generation_id=$1::uuid AND workspace_id=$2 AND base_id=$3 AND sheet_id=$4`,
      [generationId, identity.workspaceId, identity.baseId, identity.sheetId])
      const row = result.rows[0] as Record<string, unknown> | undefined
      if (result.rows.length !== 1 || !row) throw new Error('RECOVERY_ARCHIVE_MANUAL_UNAVAILABLE')
      const state: RecoveryArchiveManualStatus['state'] = row.unexpired === true
        && row.state === 'verified' && row.build_status === 'finalized' && row.coverage_status === 'complete'
        ? 'recoverable' : row.unexpired === true && row.leased === true && row.state === 'building'
          && row.build_status === 'active' && row.coverage_status === 'incomplete' ? 'pending' : 'incomplete'
      return { status: Object.freeze({ requestId: identity.requestId, generationId, state }), row }
    })
  }
  return Object.freeze({
    async read(input: RecoveryArchiveManualRequest): Promise<RecoveryArchiveManualStatus> {
      return (await read(input)).status
    },
    async capture(input: RecoveryArchiveManualRequest): Promise<RecoveryArchiveManualStatus> {
      assertEnabled()
      if (!admit || !policy) throw new Error('RECOVERY_ARCHIVE_MANUAL_POLICY_UNAVAILABLE')
      const identity = Object.freeze({ ...input })
      const admission = await admit(identity)
      const { status, row } = await read(identity)
      if (status.state !== 'pending') return status
      // Another process may still own the first plaintext attempt. Never reconstruct it from the live table.
      if (!admission.source && row.prepared !== true) return status
      if (row.key_id !== policy.keyId) throw new Error('RECOVERY_ARCHIVE_MANUAL_POLICY_UNAVAILABLE')
      const owner = { generationId: admission.generationId, ownerKind: String(row.owner_kind),
        ownerId: String(row.owner_id), ownerFence: String(row.owner_fence), sourceVectorHash: String(row.source_vector_hash) }
      const binding = { formatVersion: 1 as const, generationId: admission.generationId,
        workspaceId: identity.workspaceId, baseId: identity.baseId, sheetId: identity.sheetId,
        anchorOperationId: String(row.anchor_operation_id), anchorSeq: String(row.anchor_seq),
        checkpointId: String(row.checkpoint_id), keyId: policy.keyId, aeadAlgorithm: 'aes-256-gcm' as const }
      const shared = { identity, owner, transactionDepth: runtime.transactionDepth, provider: runtime.objectStore }
      try {
        await continueCapture({ ...shared, binding, source: admission.source,
          capture: async (source) => ({ binding, keyCustody: runtime.keyCustody, transactionDepth: runtime.transactionDepth,
            dekSource: { kind: 'produce' },
            sections: RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => {
              const rows = source.sections[sectionName as keyof typeof source.sections]
              // Coverage and nonce authority are replaced by canonical sealed-history helpers in continuation.
              const canonical = rows === undefined ? '[]' : canonicalizeRecoveryArchiveSectionRows(sectionName,
                buildRecoveryArchiveSectionRows(sectionName, rows)).canonicalJson
              return { sectionName, plaintext: Buffer.from(canonical), nonce: randomBytes(12) }
            }),
            reserveNonces: async () => { throw new Error('RECOVERY_ARCHIVE_MANUAL_NONCE_BINDING_MISMATCH') },
          }),
          upload: bindRecoveryArchiveManualObjectUpload(transaction, authorize, shared),
          uploadAttachment: bindRecoveryArchiveManualAttachmentUpload(transaction, authorize, shared) })
        await bindRecoveryArchiveManualManifestUpload(transaction, authorize, shared)()
        await finalize({ ...shared, key: { keyId: policy.keyId, expectedRowVersion: policy.keyRowVersion },
          keyCustody: runtime.keyCustody })
      } catch (error) {
        // A concurrent exact retry may have finalized first. Only durable completion converts the race to success.
        const current = await read(identity)
        if (current.status.state === 'recoverable') return current.status
        throw error
      }
      return (await read(identity)).status
    },
  })
}
