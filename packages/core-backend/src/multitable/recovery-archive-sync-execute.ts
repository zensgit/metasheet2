import {
  type ExactAnchorApplyInput,
  type ExactAnchorApplyResult,
} from './exact-anchor-recovery-execute'
import { isMultitableRecoveryArchiveEnabled } from './recovery-archive-contract'
import {
  loadRecoveryArchiveAuthorityInternal,
  normalizeRecoveryArchiveScopeInternal,
  RecoveryArchivePreviewError,
  type RecoveryArchivePreviewQuery,
  type RecoveryArchivePreviewRuntime,
  type RecoveryArchivePreviewScope,
  type RecoveryArchivePreviewTransaction,
} from './recovery-archive-preview'
import { RecoveryArchiveReaderError } from './recovery-archive-reader'
import { applyRecoveryArchiveSyncRestore } from './recovery-archive-sync-restore'
import {
  assertRecoveryArchiveSyncPlanMatchesClaims,
  compileRecoveryArchiveSyncPlan,
} from './recovery-archive-sync-plan'
import { verifyExactArchiveRecoveryIdentity } from './restore-preview-identity'

export interface RecoveryArchiveSyncExecuteInput extends Pick<
  ExactAnchorApplyInput,
  | 'preliminaryFullRead'
  | 'stabilizeAuthorization'
  | 'finalLockedFullRead'
  | 'evaluatePlanAuthorization'
  | 'onMutationApplied'
  | 'leaseBackoff'
> {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly previewIdentity: string
  readonly scope: RecoveryArchivePreviewScope
  readonly recheckAuthority: (query: RecoveryArchivePreviewQuery) => Promise<boolean>
  /** Owner-policy value supplied by the server runtime, never by the HTTP request. */
  readonly auditedReplayHorizonMs: number
  readonly env?: NodeJS.ProcessEnv
}

/**
 * D5 synchronous owner execution. The request supplies only the signed preview identity and the
 * selected id surface. Generation/root/source/key/mode/anchor all come from the verified token and
 * the server-owned catalog; the D4 reader runs before the destructive L8 transaction.
 */
export async function executeRecoveryArchiveSync(
  transaction: RecoveryArchivePreviewTransaction,
  query: RecoveryArchivePreviewQuery,
  runtime: RecoveryArchivePreviewRuntime | undefined,
  input: RecoveryArchiveSyncExecuteInput,
): Promise<ExactAnchorApplyResult> {
  const token = opaque(input.previewIdentity)
  const scope = normalizeRecoveryArchiveScopeInternal(input.scope)
  if (!isMultitableRecoveryArchiveEnabled(input.env ?? process.env)) {
    throw new RecoveryArchivePreviewError('RECOVERY_ARCHIVE_PREVIEW_DISABLED')
  }
  if (!runtime) {
    throw new RecoveryArchivePreviewError('RECOVERY_ARCHIVE_PREVIEW_RUNTIME_UNAVAILABLE')
  }

  const verified = verifyExactArchiveRecoveryIdentity(token, {
    sheetId: input.sheetId,
    actorId: input.actorId,
  })
  if (!verified.valid || !verified.claims || verified.claims.scopeKind !== scope.kind) {
    return { ok: false, reason: 'identity-invalid' }
  }

  const selectedRecordIds = scope.kind === 'whole_sheet' ? [] : scope.recordIds
  const selectedFieldIds = scope.kind === 'selected_fields' ? scope.fieldIds : []
  try {
    const plan = compileRecoveryArchiveSyncPlan({
      workspaceId: input.workspaceId,
      baseId: input.baseId,
      sheetId: input.sheetId,
      actorId: input.actorId,
      recoveryMode: verified.claims.mode,
      scopeKind: verified.claims.scopeKind,
      scopeHash: verified.claims.scopeHash,
      archiveGenerationId: verified.claims.archiveGenerationId,
      archiveRootHash: verified.claims.archiveRootHash,
      sourceVectorHash: verified.claims.archiveSourceVectorHash,
      keyId: verified.claims.archiveKeyId,
      selectedRecordIds,
      selectedFieldIds,
    })
    assertRecoveryArchiveSyncPlanMatchesClaims(plan, verified.claims)
  } catch {
    return { ok: false, reason: 'identity-invalid' }
  }

  const archive = await loadRecoveryArchiveAuthorityInternal(transaction, {
    workspaceId: input.workspaceId,
    baseId: input.baseId,
    sheetId: input.sheetId,
    generationId: verified.claims.archiveGenerationId,
    recheckAuthority: input.recheckAuthority,
  })
  if (
    archive.selectedBinding.anchorOperationId !== verified.claims.anchorOperationId ||
    archive.selectedBinding.anchorSeq !== verified.claims.anchorSeq ||
    archive.selectedBinding.checkpointId !== verified.claims.checkpointId ||
    archive.selectedBinding.rootHash !== verified.claims.archiveRootHash ||
    archive.selectedBinding.sourceVectorHash !== verified.claims.archiveSourceVectorHash ||
    archive.keyId !== verified.claims.archiveKeyId
  ) {
    return { ok: false, reason: 'recovery-trust-required' }
  }

  try {
    return await applyRecoveryArchiveSyncRestore({
      transaction,
      query,
      apply: {
        token,
        sheetId: input.sheetId,
        actorId: input.actorId,
        preliminaryFullRead: input.preliminaryFullRead,
        stabilizeAuthorization: input.stabilizeAuthorization,
        finalLockedFullRead: input.finalLockedFullRead,
        evaluatePlanAuthorization: input.evaluatePlanAuthorization,
        ...(input.onMutationApplied ? { onMutationApplied: input.onMutationApplied } : {}),
        ...(input.leaseBackoff ? { leaseBackoff: input.leaseBackoff } : {}),
      },
      archive: {
        selectedBinding: archive.selectedBinding,
        keyCustody: runtime.keyCustody,
        objectStore: runtime.objectStore,
        transactionDepth: runtime.transactionDepth,
        manifestObject: archive.manifestObject,
        sectionObjects: archive.sectionObjects,
      },
      selectedRecordIds,
      selectedFieldIds,
      auditedReplayHorizonMs: input.auditedReplayHorizonMs,
    })
  } catch (error) {
    if (error instanceof RecoveryArchiveReaderError) {
      throw new RecoveryArchivePreviewError('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    }
    throw error
  }
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new RecoveryArchivePreviewError('RECOVERY_ARCHIVE_PREVIEW_INVALID_INPUT')
  }
  return value
}
