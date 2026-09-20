import { fenceWriterEntry, type FenceQuery } from './canonical-sheet-fence'

export type AttachmentPurgeTransaction = <T>(work: (client: { query: FenceQuery }) => Promise<T>) => Promise<T>

export function archiveSourceProtectionEnabled(): boolean {
  return process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED === 'true'
    && process.env.MULTITABLE_ENABLE_WRITER_FENCE === 'true'
}

export async function hasActiveArchiveSourcePin(query: FenceQuery, attachmentId: string): Promise<boolean> {
  const result = await query(`SELECT 1 FROM meta_recovery_archive_attachment_refs r
    JOIN meta_recovery_archives a ON a.generation_id=r.generation_id
    WHERE r.attachment_id=$1 AND r.reference_class='source' AND r.reference_state='building'
      AND a.state='building' AND a.build_status='active' AND a.coverage_status='incomplete' LIMIT 1`, [attachmentId])
  return result.rows.length > 0
}

/** Caller holds the sheet fence and row lock; a committed claim survives provider failure. */
export async function markAttachmentPurgeClaim(query: FenceQuery, attachmentId: string): Promise<void> {
  const result = await query(`UPDATE multitable_attachments
    SET blob_purge_claimed_at=COALESCE(blob_purge_claimed_at,clock_timestamp())
    WHERE id=$1 AND deleted_at IS NOT NULL AND blob_purged_at IS NULL RETURNING id`, [attachmentId])
  if (result.rows.length !== 1) throw new Error('ATTACHMENT_PURGE_CLAIM_REFUSED')
}

export async function claimDirectAttachmentPurge(
  transaction: AttachmentPurgeTransaction, attachmentId: string,
  storageFileId: string, storagePath: string | null | undefined,
): Promise<boolean> {
  return transaction(async ({ query }) => {
    const scope = await query('SELECT sheet_id FROM multitable_attachments WHERE id=$1', [attachmentId])
    const sheetId = (scope.rows[0] as { sheet_id?: unknown } | undefined)?.sheet_id
    if (typeof sheetId !== 'string') return false
    await fenceWriterEntry(query, sheetId)
    const locked = await query(`SELECT sheet_id,storage_file_id,storage_path FROM multitable_attachments
      WHERE id=$1 AND deleted_at IS NOT NULL AND blob_purged_at IS NULL FOR UPDATE`, [attachmentId])
    const row = locked.rows[0] as Record<string, unknown> | undefined
    if (!row || row.sheet_id !== sheetId || row.storage_file_id !== storageFileId
      || (row.storage_path ?? null) !== (storagePath ?? null)
      || await hasActiveArchiveSourcePin(query, attachmentId)) return false
    await markAttachmentPurgeClaim(query, attachmentId)
    return true
  })
}
