import { createHash } from 'node:crypto'
import type { StorageProvider } from '../services/StorageService'
import type { QueryFn } from './permission-service'
import type { RecoveryArchiveCompleteSectionState } from './recovery-archive-reconstructor'
import type { RecoveryArchiveReaderInput } from './recovery-archive-reader'
import type { ExactAnchorApplyInput, MaterializedArchiveLink } from './exact-anchor-recovery-execute'
import { lockArchiveSyncBinding, prepareMaterializedArchiveRecoveryPreviewScopeInternal } from './exact-anchor-recovery-execute'
import { buildPreviewPlanDetails, loadFieldSurfaceForPreview, loadLiveByIdForPreview } from './exact-anchor-recovery-route'
import { hydrateLiveLinkProjection } from './live-link-projection-integrity'
import { planArchiveAttachmentCells, projectArchiveAttachmentCells } from './recovery-archive-attachment-plan'
import { hashArchiveAttachmentMetadata } from './recovery-archive-attachment-apply'
import type { RecoveryArchiveAttachmentBatch } from './recovery-archive-attachment-batch'
import { createArchiveAttachmentStageLedger } from './recovery-archive-attachment-stage-ledger'
import { stageRecoveryArchiveAttachment } from './recovery-archive-attachment-stage'
import { assertRecoveryArchiveSyncPlanMatchesClaims, compileRecoveryArchiveSyncPlan,
  type RecoveryArchiveAttachmentMetadataBinding } from './recovery-archive-sync-plan'
import type { ExactArchiveRecoveryIdentityClaims } from './restore-preview-identity'

/** Server-only preparation. No caller-supplied path, metadata hash or staged descriptor is trusted. */
export async function prepareArchiveAttachmentBatch(input: {
  transaction: <T>(work: (query: QueryFn) => Promise<T>) => Promise<T>
  apply: ExactAnchorApplyInput
  archive: RecoveryArchiveReaderInput
  state: RecoveryArchiveCompleteSectionState
  targetLinks: readonly MaterializedArchiveLink[]
  selectedRecordIds: readonly string[]
  selectedFieldIds: readonly string[]
  claims: ExactArchiveRecoveryIdentityClaims
  storage: Pick<StorageProvider, 'uploadByKey' | 'readRecoveryAttachment' | 'reserveRecoveryAttachment'>
}): Promise<RecoveryArchiveAttachmentBatch | undefined> {
  const { transaction, apply, archive, state, claims, storage } = input
  const tokenHash = createHash('sha256').update(apply.token).digest('hex')
  const sourceBinding = { claims, workspaceId: archive.selectedBinding.workspaceId, baseId: archive.selectedBinding.baseId }
  const prepared = await transaction(async query => {
    if (!(await apply.preliminaryFullRead(query))) refused()
    await lockArchiveSyncBinding(query, apply, sourceBinding)
    const loaded = await loadLiveByIdForPreview(query, apply.sheetId)
    if (!loaded.ok) refused()
    const surface = await loadFieldSurfaceForPreview(query, apply.sheetId)
    const live = await hydrateLiveLinkProjection(query, loaded.liveById, surface.writableLinkFieldIds)
    const scope = prepareMaterializedArchiveRecoveryPreviewScopeInternal({
      scopeKind: claims.scopeKind, targetRecords: state.records, targetLinks: input.targetLinks,
      liveById: live, selectedRecordIds: input.selectedRecordIds, selectedFieldIds: input.selectedFieldIds,
      writableLinkFieldIds: surface.writableLinkFieldIds, restorableFieldIds: new Set(surface.fieldById.keys()),
    })
    if (!scope.ok) refused()
    const cells = planArchiveAttachmentCells({ targets: state.records, live,
      fieldTypes: surface.rawTypeById, index: state.attachments_index,
      ...(input.selectedRecordIds.length ? { selectedRecordIds: input.selectedRecordIds } : {}),
      ...(input.selectedFieldIds.length ? { selectedFieldIds: input.selectedFieldIds } : {}) })
    const details = buildPreviewPlanDetails(scope.targetRecords, scope.liveById, surface.fieldIds,
      claims.mode, { fieldById: surface.fieldById, rawTypeById: surface.rawTypeById })
    if (details.summary.driftCount || details.summary.resurrectIds.length) refused()
    const context = { mode: claims.mode, sheetId: apply.sheetId, actorId: apply.actorId, plan: details.plan,
      revertWrites: projectArchiveAttachmentCells(details.revertWrites, live, cells),
      deleteRecordIds: details.deleteRecordIds }
    if (!(await apply.evaluatePlanAuthorization(query, context))) refused()
    const metadata: RecoveryArchiveAttachmentMetadataBinding[] = []
    const seen = new Set<string>()
    for (const cell of cells) {
      for (const attachmentId of new Set([...cell.beforeIds, ...cell.targetIds])) {
        if (seen.has(attachmentId)) refused()
        seen.add(attachmentId)
        const found = await query(`SELECT to_jsonb(a) AS metadata FROM multitable_attachments a
          WHERE id=$1 AND sheet_id=$2 AND record_id=$3 AND field_id=$4`,
        [attachmentId, apply.sheetId, cell.recordId, cell.fieldId])
        if (found.rows.length !== 1) refused()
        metadata.push({ attachmentId, recordId: cell.recordId, fieldId: cell.fieldId,
          metadataHash: hashArchiveAttachmentMetadata((found.rows[0] as { metadata: unknown }).metadata) })
      }
    }
    const binding = archive.selectedBinding
    assertRecoveryArchiveSyncPlanMatchesClaims(compileRecoveryArchiveSyncPlan({
      workspaceId: binding.workspaceId, baseId: binding.baseId, sheetId: apply.sheetId, actorId: apply.actorId,
      recoveryMode: claims.mode, scopeKind: claims.scopeKind, scopeHash: claims.scopeHash,
      archiveGenerationId: binding.generationId, archiveRootHash: binding.rootHash,
      sourceVectorHash: binding.sourceVectorHash, keyId: claims.archiveKeyId,
      selectedRecordIds: input.selectedRecordIds, selectedFieldIds: input.selectedFieldIds,
      ...(cells.length ? { attachmentMetadata: metadata } : {}),
    }), claims)
    return { cells, metadata, context }
  })
  if (!prepared.cells.length) return undefined
  const authorize = async (query: QueryFn) => {
    if (!(await apply.preliminaryFullRead(query)) || !(await apply.evaluatePlanAuthorization(query, prepared.context))) return false
    await lockArchiveSyncBinding(query, apply, sourceBinding)
    return true
  }
  const ledger = createArchiveAttachmentStageLedger({ actorId: apply.actorId, tokenHash, transaction, authorize })
  const staged: RecoveryArchiveAttachmentBatch['staged'][number][] = []
  for (const cell of prepared.cells) {
    for (const attachmentId of cell.targetIds) {
      const binding = archive.selectedBinding
      staged.push(await stageRecoveryArchiveAttachment({ state, attachmentId,
        original: { generationId: binding.generationId, workspaceId: binding.workspaceId,
          baseId: binding.baseId, sheetId: apply.sheetId, recordId: cell.recordId, fieldId: cell.fieldId },
        transactionDepth: archive.transactionDepth, storage, ledger,
        authorize: () => transaction(authorize) }))
    }
  }
  return { index: state.attachments_index, metadata: prepared.metadata, staged }
}

function refused(): never { throw new Error('ARCHIVE_ATTACHMENT_RESTORE_PREPARATION_REFUSED') }
