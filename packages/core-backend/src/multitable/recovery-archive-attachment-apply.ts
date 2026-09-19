import { createHash } from 'node:crypto'
import type { QueryFn } from './permission-service'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import type { ArchiveAttachmentStageIdentity } from './recovery-archive-attachment-stage'
import { lockVerifiedArchiveAttachmentStage } from './recovery-archive-attachment-stage-ledger'
import { canonicalizeRecoveryArchiveJson } from './recovery-archive-manifest'

/** Fingerprint only database JSON metadata; no pathname/filename is placed in a preview response. */
export function hashArchiveAttachmentMetadata(metadata: unknown): string {
  return createHash('sha256').update(canonicalizeRecoveryArchiveJson(metadata)).digest('hex')
}

/**
 * Transaction participant, not a restore entry point. Canonical apply still owns writer fencing,
 * preview identity, record CAS, reference/history writes and receipt/token consumption.
 * No storage I/O or transaction commits are permitted here.
 */
export async function applyVerifiedArchiveAttachmentMetadata(query: QueryFn, input: {
  actorId: string
  tokenHash: string
  objectId: string
  identity: ArchiveAttachmentStageIdentity
  expectedMetadataHash: string
  adoptionOperationId?: string
  transactionDepth: RecoveryArchiveTransactionDepthProbe
  authorize: (query: QueryFn) => Promise<boolean>
}): Promise<void> {
  const { actorId, tokenHash, objectId, expectedMetadataHash, transactionDepth, authorize } = input
  const identity = { ...input.identity }
  try {
    const depth = transactionDepth.currentTransactionDepth()
    if (!Number.isSafeInteger(depth) || depth < 1 || !/^[0-9a-f]{64}$/.test(expectedMetadataHash)) refused()
    if (!(await authorize(query))) refused()
    if (transactionDepth.currentTransactionDepth() !== depth) refused()
    await lockVerifiedArchiveAttachmentStage(query, { actorId, tokenHash, objectId, identity })
    const found = await query(`SELECT to_jsonb(a) AS metadata FROM multitable_attachments a
      JOIN meta_records r ON r.id=a.record_id AND r.sheet_id=a.sheet_id
      JOIN meta_fields f ON f.id=a.field_id AND f.sheet_id=a.sheet_id
      WHERE a.id=$1 AND a.sheet_id=$2 AND a.record_id=$3 AND a.field_id=$4
        AND f.type='attachment' FOR UPDATE OF a`,
    [identity.attachmentId, identity.sheetId, identity.recordId, identity.fieldId])
    if (found.rows.length !== 1) refused()
    const row = (found.rows[0] as { metadata?: Record<string, unknown> }).metadata
    // The signed archive has no display filename. Preserve retained original metadata, never invent it.
    if (!row || typeof row.filename !== 'string' || row.filename.length === 0
      || typeof row.storage_file_id !== 'string' || row.storage_file_id.length === 0
      || typeof row.storage_path !== 'string' || row.storage_path.length === 0
      || typeof row.mime_type !== 'string' || row.mime_type.length === 0
      || row.storage_provider !== 'local' || String(row.size) !== identity.sizeBytes
      || hashArchiveAttachmentMetadata(row) !== expectedMetadataHash) refused()
    if (input.adoptionOperationId !== undefined) {
      const adopted = await query(`UPDATE public.meta_recovery_archive_attachment_stages
        SET state='applied',applied_operation_id=$4::uuid,applied_at=clock_timestamp(),
          displaced_storage_file_id=$5,displaced_storage_path=$6
        WHERE actor_id=$1::uuid AND token_hash=$2 AND attachment_id=$3 AND object_id=$7::uuid
          AND state='verified' RETURNING object_id`,
      [actorId, tokenHash, identity.attachmentId, input.adoptionOperationId, row.storage_file_id, row.storage_path, objectId])
      if (adopted.rows.length !== 1) refused()
    }
    const updated = await query(`UPDATE multitable_attachments
      SET storage_file_id=$5,storage_path=$6,deleted_at=NULL,blob_purged_at=NULL,
        blob_purge_claimed_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND sheet_id=$2 AND record_id=$3 AND field_id=$4
      RETURNING id`,
    [identity.attachmentId, identity.sheetId, identity.recordId, identity.fieldId,
      objectId, `${objectId}/sha256-${identity.plaintextSha256}`])
    if (updated.rows.length !== 1) refused()
  } catch { refused() }
}

function refused(): never {
  throw new Error('ARCHIVE_ATTACHMENT_RESTORE_APPLY_REFUSED')
}
