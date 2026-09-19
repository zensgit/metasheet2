import type { QueryFn } from './permission-service'
import type { RecoveryArchiveRowEnvelope } from './recovery-archive-manifest'
import type { ArchiveAttachmentCellPlan } from './recovery-archive-attachment-plan'
import type { ArchiveAttachmentStageIdentity } from './recovery-archive-attachment-stage'
import type { RecoveryArchiveAttachmentMetadataBinding } from './recovery-archive-sync-plan'
import { applyVerifiedArchiveAttachmentMetadata, hashArchiveAttachmentMetadata } from './recovery-archive-attachment-apply'

/** Internal authenticated-reader preparation; never accepted from an HTTP command body. */
export interface RecoveryArchiveAttachmentBatch {
  readonly index: readonly RecoveryArchiveRowEnvelope[]
  readonly metadata: readonly RecoveryArchiveAttachmentMetadataBinding[]
  readonly staged: readonly (ArchiveAttachmentStageIdentity & { readonly objectId: string })[]
}

/** Canonical apply has already locked the sheet/records and authorized the complete true delta. */
export async function applyArchiveAttachmentBatch(query: QueryFn, input: {
  actorId: string; tokenHash: string; generationId: string; workspaceId: string; baseId: string; sheetId: string
  cells: readonly ArchiveAttachmentCellPlan[]; batch: RecoveryArchiveAttachmentBatch
}): Promise<void> {
  const identities = new Map<string, { recordId: string; fieldId: string }>()
  const targets = new Set<string>()
  for (const cell of input.cells) {
    for (const id of new Set([...cell.beforeIds, ...cell.targetIds])) {
      if (identities.has(id)) refused()
      identities.set(id, { recordId: cell.recordId, fieldId: cell.fieldId })
    }
    for (const id of cell.targetIds) targets.add(id)
  }
  const metadata = new Map(input.batch.metadata.map(row => [row.attachmentId, row]))
  const staged = new Map(input.batch.staged.map(row => [row.attachmentId, row]))
  if (metadata.size !== input.batch.metadata.length || metadata.size !== identities.size
    || staged.size !== input.batch.staged.length || staged.size !== targets.size) refused()
  for (const id of [...identities.keys()].sort()) {
    const original = identities.get(id)!
    const binding = metadata.get(id)
    if (!binding || binding.recordId !== original.recordId || binding.fieldId !== original.fieldId) refused()
    const row = await query(`SELECT to_jsonb(a) AS metadata FROM multitable_attachments a
      WHERE id=$1 AND sheet_id=$2 AND record_id=$3 AND field_id=$4 FOR UPDATE`,
    [id, input.sheetId, original.recordId, original.fieldId])
    if (row.rows.length !== 1
      || hashArchiveAttachmentMetadata((row.rows[0] as { metadata: unknown }).metadata) !== binding.metadataHash) refused()
    if (!targets.has(id)) continue
    const source = staged.get(id)
    if (!source || source.generationId !== input.generationId || source.workspaceId !== input.workspaceId
      || source.baseId !== input.baseId || source.sheetId !== input.sheetId
      || source.recordId !== original.recordId || source.fieldId !== original.fieldId) refused()
    await applyVerifiedArchiveAttachmentMetadata(query, {
      actorId: input.actorId, tokenHash: input.tokenHash, objectId: source.objectId,
      identity: source, expectedMetadataHash: binding.metadataHash,
      // The canonical executor owns the live transaction and has completed locked plan authorization.
      transactionDepth: { currentTransactionDepth: () => 1 }, authorize: async () => true,
    })
  }
}

function refused(): never { throw new Error('ARCHIVE_ATTACHMENT_RESTORE_BATCH_REFUSED') }
