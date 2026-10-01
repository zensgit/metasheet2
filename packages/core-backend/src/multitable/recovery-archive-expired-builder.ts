import { lockRecoveryArchiveObjectScope } from './recovery-archive-abandoned-object-cleanup'
import type { RecoveryArchivePreparedCaptureOwner } from './recovery-archive-prepared-capture'
import type { RecoveryArchivePreparedUploadInput } from './recovery-archive-prepared-upload'
import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'
import type { SealQuery } from './recovery-archive-seals'

function refuse(): never { throw new Error('RECOVERY_ARCHIVE_EXPIRED_BUILDER_REFUSED') }

async function admitExpiredBuilder(
  query: SealQuery, authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  identity: RecoveryArchiveScopeIdentity, owner: RecoveryArchivePreparedCaptureOwner,
): Promise<void> {
  // Existing D-L prefix admits a retiring key because this acquires no new key references.
  await lockRecoveryArchiveObjectScope(query, identity, owner.generationId, false)
  if (!await authorize(query, identity)) refuse()
}

/** Explicit expired-owner CAS only. Cleanup claims ownership separately; no pins or receipts change here. */
export async function abandonExpiredRecoveryArchiveBuilder(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>,
  input: { identity: RecoveryArchiveScopeIdentity; owner: RecoveryArchivePreparedCaptureOwner },
): Promise<void> {
  try {
    const identity = Object.freeze({ ...input.identity })
    const owner = Object.freeze({ ...input.owner })
    if ([...Object.values(identity), ...Object.values(owner)].some(value => typeof value !== 'string')
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(owner.generationId)
      || !/^[1-9][0-9]*$/.test(owner.ownerFence) || !/^[0-9a-f]{64}$/.test(owner.sourceVectorHash)
      || [owner.ownerKind, owner.ownerId, identity.workspaceId, identity.baseId, identity.sheetId, identity.actorId]
        .some(value => typeof value !== 'string' || value.trim().length === 0)) refuse()
    await transaction(async query => {
      await admitExpiredBuilder(query, authorize, identity, owner)
      const predicate = `generation_id=$1::uuid AND owner_kind=$2 AND owner_id=$3 AND owner_fence=$4::bigint
        AND source_vector_hash=$5 AND workspace_id=$6 AND base_id=$7 AND sheet_id=$8
        AND state='building' AND build_status='active' AND coverage_status='incomplete'
        AND lease_expires_at<=clock_timestamp()`
      const values = [owner.generationId, owner.ownerKind, owner.ownerId, owner.ownerFence, owner.sourceVectorHash,
        identity.workspaceId, identity.baseId, identity.sheetId]
      const locked = await query(`SELECT generation_id FROM public.meta_recovery_archives WHERE ${predicate} FOR UPDATE`, values)
      if (locked.rows.length !== 1) refuse()
      const updated = await query(`UPDATE public.meta_recovery_archives SET build_status='abandoned'
        WHERE ${predicate} RETURNING generation_id`, values)
      if (updated.rows.length !== 1) refuse()
    })
  } catch { refuse() }
}
