import { createHash } from 'node:crypto'
import { readRecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import { computeRecoveryArchiveSourceVectorHash, computeRecoveryArchiveCheckpointVectorHash } from './recovery-archive-source-vector'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from './recovery-archive-seals'
import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'

export function refuseOwnedCleanup(): never { throw new Error('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED') }
export type OwnedCleanupGeneration = Record<string, unknown> & { generation_id: string; key_id: string; source_vector_hash: string }

/** Immutable admission rows remain under the original builder after a higher cleanup claim. */
export async function readOwnedCleanupAdmission(query: SealQuery, identity: RecoveryArchiveScopeIdentity,
  generation: OwnedCleanupGeneration) {
  const requests = (await query(`SELECT actor_id::text,request_id::text,workspace_id,base_id,sheet_id,request_hash
    FROM public.meta_recovery_archive_manual_requests WHERE generation_id=$1::uuid`, [generation.generation_id])).rows as Record<string, unknown>[]
  const request = requests[0]
  if (requests.length !== 1 || !request || typeof request.actor_id !== 'string' || typeof request.request_id !== 'string'
    || request.workspace_id !== identity.workspaceId || request.base_id !== identity.baseId || request.sheet_id !== identity.sheetId
    || await readRecoveryArchiveManualRequest(query, { ...identity, actorId: request.actor_id, requestId: request.request_id }) !== generation.generation_id) refuseOwnedCleanup()
  const reservations = (await query(`SELECT ordinal,reservation_kind,section_kind,operation_id::text,endpoint_seq::text,
      sheet_id,source_vector_hash,owner_kind,owner_id,owner_fence::text,created_at::text
    FROM public.meta_recovery_archive_snapshot_reservations WHERE generation_id=$1::uuid ORDER BY ordinal`,
  [generation.generation_id])).rows as Record<string, unknown>[]
  const kind = reservations[0]?.reservation_kind
  if (reservations.length !== 10 || !['section_bootstrap', 'section_checkpoint'].includes(String(kind))) refuseOwnedCleanup()
  const sections = reservations.slice(0, 9)
  const parent = reservations[9]!
  if (reservations.some((row, index) => row.ordinal !== index + 1 || row.sheet_id !== identity.sheetId
    || row.source_vector_hash !== generation.source_vector_hash || row.owner_kind !== 'archive_builder'
    || row.owner_id !== generation.generation_id || row.owner_fence !== '1' || row.created_at !== generation.created_at
    || typeof row.operation_id !== 'string' || typeof row.endpoint_seq !== 'string' || !/^[1-9][0-9]*$/.test(row.endpoint_seq))
    || sections.some(row => row.reservation_kind !== kind)
    || new Set(sections.map(row => row.section_kind)).size !== 9
    || SECTION_CAUSALITY_DATA_SECTION_KINDS.some(name => !sections.some(row => row.section_kind === name))
    || parent.reservation_kind !== 'archive_snapshot' || parent.section_kind !== null
    || parent.operation_id !== generation.anchor_operation_id || parent.endpoint_seq !== generation.anchor_seq
    || sections.some(row => BigInt(String(row.endpoint_seq)) >= BigInt(String(parent.endpoint_seq)))
    || new Set(reservations.map(row => row.operation_id)).size !== 10) refuseOwnedCleanup()
  const heads = sections.map(row => ({ sourceHeadKind: kind as 'section_bootstrap' | 'section_checkpoint',
    sectionKind: String(row.section_kind), operationId: String(row.operation_id), headSeq: String(row.endpoint_seq) }))
  const vector = kind === 'section_bootstrap' ? computeRecoveryArchiveSourceVectorHash(heads) : computeRecoveryArchiveCheckpointVectorHash(heads)
  if (vector.hash !== generation.source_vector_hash) refuseOwnedCleanup()
  const unsafe = await query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM public.meta_recovery_archive_objects WHERE generation_id=$1::uuid AND state='verified')
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_attachment_refs WHERE generation_id=$1::uuid AND reference_class='archive_object')
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_legal_holds WHERE generation_id=$1::uuid AND state='active')
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_coverage_items WHERE generation_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations r
      JOIN public.meta_record_history_operations o ON o.sheet_id=r.sheet_id AND o.operation_id=r.operation_id WHERE r.generation_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations r
      JOIN public.meta_sheet_section_revisions v ON v.sheet_id=r.sheet_id AND v.operation_id=r.operation_id WHERE r.generation_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations r
      JOIN public.meta_record_history_snapshot_members m ON m.sheet_id=r.sheet_id AND m.parent_operation_id=r.operation_id WHERE r.generation_id=$1::uuid)`, [generation.generation_id])
  if (unsafe.rows.length) refuseOwnedCleanup()
  return { request, reservations }
}

export async function readOwnedEarlyCleanupProof(query: SealQuery, generation: OwnedCleanupGeneration,
  admission: Awaited<ReturnType<typeof readOwnedCleanupAdmission>>) {
  const unsafe = await query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM public.meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_objects WHERE generation_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.meta_recovery_archive_abandoned_bindings WHERE generation_id=$1::uuid)`, [generation.generation_id])
  if (unsafe.rows.length) refuseOwnedCleanup()
  const intents = (await query(`SELECT staging_object_id::text,object_class,attachment_id,key_id,object_state,
      terminal_receipt_sha256,cleanup_owner_kind,cleanup_owner_id,cleanup_owner_fence
    FROM public.meta_recovery_archive_staging_objects WHERE generation_id=$1::uuid ORDER BY staging_object_id`, [generation.generation_id])).rows as Record<string, unknown>[]
  const pins = (await query(`SELECT attachment_id,reference_class,reference_state,availability,immutable_version,
      content_sha256,content_size_bytes::text,source_owner_kind,source_owner_id,source_owner_fence::text,source_lease_until::text,
      cleanup_owner_kind,cleanup_owner_id,cleanup_owner_fence FROM public.meta_recovery_archive_attachment_refs
    WHERE generation_id=$1::uuid ORDER BY attachment_id`, [generation.generation_id])).rows as Record<string, unknown>[]
  if (intents.length !== pins.length || new Set(intents.map(row => row.attachment_id)).size !== pins.length
    || new Set(pins.map(row => row.attachment_id)).size !== pins.length
    || intents.some(row => row.object_class !== 'attachment' || row.key_id !== generation.key_id || row.object_state !== 'pending'
      || typeof row.staging_object_id !== 'string' || !pins.some(pin => pin.attachment_id === row.attachment_id)
      || row.terminal_receipt_sha256 !== null || row.cleanup_owner_kind !== null || row.cleanup_owner_id !== null || row.cleanup_owner_fence !== null)
    || pins.some(row => row.reference_class !== 'source' || row.reference_state !== 'building'
      || row.source_owner_kind !== 'archive_builder' || row.source_owner_id !== generation.generation_id || row.source_owner_fence !== '1'
      || typeof row.source_lease_until !== 'string' || row.cleanup_owner_kind !== null || row.cleanup_owner_id !== null || row.cleanup_owner_fence !== null
      || (row.availability === 'mutable' ? row.immutable_version !== null || row.content_sha256 !== null || row.content_size_bytes !== null
        : row.availability !== 'available' || typeof row.immutable_version !== 'string' || !row.immutable_version
          || typeof row.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.content_sha256)
          || typeof row.content_size_bytes !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.content_size_bytes)))
    || new Set(pins.map(row => row.source_lease_until)).size > 1
    || (generation.owner_kind === 'archive_builder' && pins.some(row => row.source_lease_until !== generation.lease_expires_at))) refuseOwnedCleanup()
  return intents.map(intent => {
    const pin = pins.find(row => row.attachment_id === intent.attachment_id)!
    const receipt = createHash('sha256').update(JSON.stringify(['metasheet.owned-builder-never-admitted/v1',
      generation.generation_id, generation.key_id, generation.source_vector_hash, generation.created_at,
      admission.request, admission.reservations, intent, pin, 'never_admitted'])).digest('hex')
    return { stagingId: String(intent.staging_object_id), attachmentId: String(intent.attachment_id), receipt }
  })
}
