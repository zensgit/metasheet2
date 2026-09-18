import { randomUUID } from 'node:crypto'
import { acquireCanonicalSheetFence, assertNoActiveWriterBlock } from './canonical-sheet-fence'
import { lockActiveRecoveryArchiveKeyForReference } from './recovery-archive-key-registry'
import { bindRecoveryArchiveManualRequest, readRecoveryArchiveManualRequest,
  type RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import { allocateRecoveryArchiveSnapshotIdentities, persistRecoveryArchiveSnapshotReservations } from './recovery-archive-section-bootstrap'
import { allocateRecoveryArchiveCheckpointIdentities, persistRecoveryArchiveCheckpointReservations } from './recovery-archive-section-checkpoint'
import { computeRecoveryArchiveSourceVectorHash, computeRecoveryArchiveCheckpointVectorHash } from './recovery-archive-source-vector'
import type { RecoveryArchivePreparedUploadInput } from './recovery-archive-prepared-upload'
import type { SealQuery } from './recovery-archive-seals'

export interface RecoveryArchiveManualAdmissionPolicy {
  keyId: string
  keyRowVersion: string
  leaseSeconds: number
  expiresAfterSeconds: number
}

/** Internal reservation admission only. Policy and identity are server-owned, never HTTP-body aliases.
 * No plaintext is captured, nonce reserved, object uploaded or catalog entry published here.
 */
export function bindRecoveryArchiveManualAdmission(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  policyInput: RecoveryArchiveManualAdmissionPolicy,
) {
  const policy = Object.freeze({ ...policyInput })
  if (!Number.isSafeInteger(policy.leaseSeconds) || policy.leaseSeconds <= 0
    || !Number.isSafeInteger(policy.expiresAfterSeconds) || policy.expiresAfterSeconds < policy.leaseSeconds
    || policy.expiresAfterSeconds > 2147483647) throw new Error('RECOVERY_ARCHIVE_MANUAL_POLICY_INVALID')
  return async (input: RecoveryArchiveManualRequest): Promise<{ generationId: string; replayed: boolean }> => {
    const identity = Object.freeze({ ...input })
    return transaction(async (query) => {
      await acquireCanonicalSheetFence(query, identity.sheetId)
      // Different-scope requests with the same actor/request key also serialize.
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['recovery-archive-manual', identity.actorId, identity.requestId])])
      let allowed = false
      try { allowed = await authorize(query, identity) } catch {
        throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
      }
      if (!allowed) throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
      const existing = await readRecoveryArchiveManualRequest(query, identity)
      if (existing !== null) return { generationId: existing, replayed: true }
      await lockActiveRecoveryArchiveKeyForReference(query, {
        keyId: policy.keyId, expectedRowVersion: policy.keyRowVersion,
      })
      await assertNoActiveWriterBlock(query, identity.sheetId)
      const trust = await query(`SELECT id FROM public.meta_history_trust_checkpoints
        WHERE sheet_id=$1 AND state='active' AND pruned_at IS NULL ORDER BY id FOR SHARE`, [identity.sheetId])
      const checkpointId = (trust.rows[0] as { id?: unknown } | undefined)?.id
      if (trust.rows.length !== 1 || typeof checkpointId !== 'string') {
        throw new Error('RECOVERY_ARCHIVE_MANUAL_TRUST_UNAVAILABLE')
      }
      const marker = await query(`SELECT sheet_id FROM public.meta_recovery_archive_section_bootstrap_markers
        WHERE sheet_id=$1`, [identity.sheetId])
      const repeat = marker.rows.length > 0
      const allocated = repeat ? await allocateRecoveryArchiveCheckpointIdentities(query)
        : await allocateRecoveryArchiveSnapshotIdentities(query)
      const heads = allocated.sections.map((section) => ({
        sourceHeadKind: repeat ? 'section_checkpoint' as const : 'section_bootstrap' as const,
        sectionKind: section.sectionKind, operationId: section.operationId, headSeq: section.endpointSeq,
      }))
      const sourceVectorHash = (repeat ? computeRecoveryArchiveCheckpointVectorHash(heads)
        : computeRecoveryArchiveSourceVectorHash(heads)).hash
      const generationId = randomUUID()
      const plan = { ...allocated, generationId, sheetId: identity.sheetId, sourceVectorHash,
        ownerKind: 'archive_builder', ownerId: generationId, ownerFence: '1' }
      await query(`INSERT INTO public.meta_recovery_archives (
        generation_id,workspace_id,base_id,sheet_id,anchor_operation_id,anchor_seq,
        checkpoint_id,source_vector_hash,key_id,owner_kind,owner_id,owner_fence,lease_expires_at,expires_at
      ) VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6::bigint,$7,$8,$9,'archive_builder',$1::text,1,
        clock_timestamp()+$10::int*interval '1 second',clock_timestamp()+$11::int*interval '1 second')`,
      [generationId, identity.workspaceId, identity.baseId, identity.sheetId,
        allocated.snapshotOperationId, allocated.snapshotSeq, checkpointId, sourceVectorHash,
        policy.keyId, policy.leaseSeconds, policy.expiresAfterSeconds])
      if (repeat) await persistRecoveryArchiveCheckpointReservations(query, plan, allocated)
      else await persistRecoveryArchiveSnapshotReservations(query, plan, allocated)
      await bindRecoveryArchiveManualRequest(query, identity, generationId)
      return { generationId, replayed: false }
    })
  }
}
