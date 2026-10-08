import { persistRecoveryArchivePreparedCapture, type RecoveryArchivePreparedCaptureOwner } from './recovery-archive-prepared-capture'
import { recoveryArchivePreparedStagingPlan, registerRecoveryArchiveStagingObject } from './recovery-archive-abandoned-object-cleanup'
import { snapshotRecoveryArchiveObjectStoreId } from './recovery-archive-object-store'
import type { SealQuery } from './recovery-archive-seals'

/** Caller holds the genuine owned recheck. Payload and ALL bindings share its commit before PUT. */
export async function persistRecoveryArchiveOwnedPreparedInventory(query: SealQuery,
  owner: RecoveryArchivePreparedCaptureOwner, payload: Buffer, expiresAt: string, storeId: string | undefined): Promise<void> {
  if (!storeId || snapshotRecoveryArchiveObjectStoreId({ storeId }) !== storeId) throw new Error('RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED')
  const plan = recoveryArchivePreparedStagingPlan(payload, expiresAt)
  const intents = (await query(`SELECT s.object_class,s.attachment_id,s.key_id,s.object_state,b.object_id
    FROM public.meta_recovery_archive_staging_objects s
    LEFT JOIN public.meta_recovery_archive_abandoned_bindings b USING(generation_id,staging_object_id)
    WHERE s.generation_id=$1::uuid`, [owner.generationId])).rows as Record<string, unknown>[]
  const attachments = plan.filter(row => row.objectClass === 'attachment')
  // First publication must start from the complete claim intents, never repair a partial roster.
  if (intents.length !== attachments.length || intents.some(row => row.object_class !== 'attachment' || row.object_state !== 'pending' || row.object_id !== null
    || !attachments.some(item => item.attachmentId === row.attachment_id && item.keyId === row.key_id))
    || new Set(intents.map(row => row.attachment_id)).size !== attachments.length) throw new Error('RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED')
  await persistRecoveryArchivePreparedCapture(query, owner, payload)
  for (const entry of plan) await registerRecoveryArchiveStagingObject(query, owner, entry, storeId)
}
