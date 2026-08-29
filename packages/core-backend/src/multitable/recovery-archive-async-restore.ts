import {
  acquireMaterializedArchiveAsyncFencesInternal,
  applyMaterializedExactArchiveRecoveryAsyncChunkInternal,
  type MaterializedArchiveAsyncFenceLease,
  type MaterializedArchiveAsyncChunkApplyInput,
} from './exact-anchor-recovery-execute'
import type { QueryFn } from './permission-service'
import {
  loadRecoveryArchiveAsyncChunk,
  loadRecoveryArchiveAsyncPlanByBinding,
  RecoveryArchiveAsyncPlanError,
  type RecoveryArchiveAsyncChunkPayload,
  type RecoveryArchiveAsyncPlanPayload,
} from './recovery-archive-async-plan'
import {
  loadRecoveryArchiveAuthorityInternal,
  RecoveryArchivePreviewError,
  type RecoveryArchivePreviewRuntime,
} from './recovery-archive-preview'
import {
  readRecoveryArchiveCompleteSectionState,
  RecoveryArchiveReaderError,
} from './recovery-archive-reader'
import {
  readRecoveryArchiveRestoreWorkerBinding,
  RecoveryArchiveRestoreJobError,
  runRecoveryArchiveRestoreChunk,
  type RecoveryArchiveRestoreChunkMaterialized,
  type RecoveryArchiveRestoreChunkResult,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobTransaction,
  type RecoveryArchiveRestoreJobWorkerClaim,
  type RecoveryArchiveRestoreWorkerBinding,
} from './recovery-archive-restore-jobs'
import {
  materializeRecoveryArchiveLinksForSync,
  RecoveryArchiveSyncRestoreError,
} from './recovery-archive-sync-restore'

export interface RecoveryArchiveAsyncRestoreChunkInput {
  readonly transaction: RecoveryArchiveRestoreJobTransaction
  /** Autocommit query used for immutable object materialization and D4 reconstruction. */
  readonly query: QueryFn
  readonly runtime: RecoveryArchivePreviewRuntime
  readonly claim: RecoveryArchiveRestoreJobWorkerClaim
  readonly recheckAuthority: (
    query: RecoveryArchiveRestoreJobQuery,
    context: { readonly sheetId: string; readonly actorId: string },
  ) => Promise<boolean>
  readonly apply: Omit<MaterializedArchiveAsyncChunkApplyInput, 'sheetId' | 'actorId'>
}

const facadeLeaseBrand: unique symbol = Symbol('RecoveryArchiveAsyncRestoreFacadeLease')
const facadeLeases = new WeakMap<object, RecoveryArchiveRestoreJobWorkerClaim>()

export interface RecoveryArchiveAsyncRestoreFacadeLease {
  readonly [facadeLeaseBrand]: typeof facadeLeaseBrand
}

/** @internal One-shot production-runner admission. Only this D4 facade can mint the bound lease. */
export function consumeRecoveryArchiveAsyncRestoreFacadeLeaseInternal(
  lease: RecoveryArchiveAsyncRestoreFacadeLease,
  claim: RecoveryArchiveRestoreJobWorkerClaim,
): boolean {
  if (facadeLeases.get(lease) !== claim) return false
  facadeLeases.delete(lease)
  return true
}

function mintRecoveryArchiveAsyncRestoreFacadeLease(
  claim: RecoveryArchiveRestoreJobWorkerClaim,
): RecoveryArchiveAsyncRestoreFacadeLease {
  const lease = Object.freeze({
    [facadeLeaseBrand]: facadeLeaseBrand,
  }) as RecoveryArchiveAsyncRestoreFacadeLease
  facadeLeases.set(lease, claim)
  return lease
}

type MaterializedWorkerChunk = {
  readonly binding: RecoveryArchiveRestoreWorkerBinding
  readonly planPayload: RecoveryArchiveAsyncPlanPayload
  readonly chunkPayload: RecoveryArchiveAsyncChunkPayload
  readonly targetRecords: Awaited<ReturnType<typeof readRecoveryArchiveCompleteSectionState>>['records']
  readonly targetLinks: ReturnType<typeof materializeRecoveryArchiveLinksForSync>
}

/**
 * Execute one accepted async restore chunk. Object/KMS/D4 reads finish before the destructive transaction;
 * the job runner then acquires the full canonical-fence set first and commits L8 writes, restore_chunk seal,
 * immutable chunk receipt, and progress in one transaction.
 */
export async function executeRecoveryArchiveAsyncRestoreChunk(
  input: RecoveryArchiveAsyncRestoreChunkInput,
): Promise<RecoveryArchiveRestoreChunkResult> {
  let fenceLease: MaterializedArchiveAsyncFenceLease | undefined
  return runRecoveryArchiveRestoreChunk(input.transaction, input.claim, {
    facadeLease: mintRecoveryArchiveAsyncRestoreFacadeLease(input.claim),
    read: input.query,
    materialize: async (expected) => materializeWorkerChunk(input, expected),
    prelock: async (query, context) => {
      if (context.sheetId !== input.claim.sheetId || context.jobId !== input.claim.jobId) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
      }
      fenceLease = await acquireMaterializedArchiveAsyncFencesInternal(query, context.sheetId)
    },
    recheckAuthority: async (query, context) => input.recheckAuthority(query, {
      sheetId: context.sheetId,
      actorId: context.actorId,
    }),
    apply: async (query, context) => {
      if (!fenceLease) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID')
      }
      const materialized = admitWorkerChunk(context.payload)
      if (
        materialized.binding.jobId !== context.jobId ||
        materialized.binding.sheetId !== context.sheetId ||
        materialized.binding.actorId !== context.actorId ||
        materialized.binding.recoveryMode !== context.recoveryMode ||
        materialized.binding.scopeKind !== context.scopeKind ||
        materialized.chunkPayload.chunkIndex !== context.chunkIndex
      ) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
      }
      const result = await applyMaterializedExactArchiveRecoveryAsyncChunkInternal(
        query,
        {
          ...input.apply,
          sheetId: context.sheetId,
          actorId: context.actorId,
        },
        {
          fenceLease,
          executionLease: context.executionLease,
          workspaceId: materialized.binding.workspaceId,
          baseId: materialized.binding.baseId,
          jobId: materialized.binding.jobId,
          blockFence: input.claim.blockFence,
          workerOwnerId: input.claim.workerOwnerId,
          workerFence: input.claim.workerFence,
          leaseUntil: input.claim.leaseUntil,
          recoveryMode: materialized.binding.recoveryMode,
          scopeKind: materialized.binding.scopeKind,
          planScopeHash: materialized.binding.scopeHash,
          planHash: materialized.binding.planHash,
          archiveGenerationId: materialized.binding.archiveGenerationId,
          archiveRootHash: materialized.binding.archiveRootHash,
          archiveSourceVectorHash: materialized.binding.sourceVectorHash,
          archiveKeyId: materialized.binding.keyId,
          anchorOperationId: materialized.planPayload.anchorOperationId,
          anchorSeq: materialized.planPayload.anchorSeq,
          checkpointId: materialized.planPayload.checkpointId,
          authorizedScopeHash: materialized.planPayload.authorizedScopeHash,
          targetRecords: materialized.targetRecords,
          targetLinks: materialized.targetLinks,
          selectedFieldIds: materialized.planPayload.selectedFieldIds,
          chunk: materialized.chunkPayload,
        },
      )
      if ('reason' in result) {
        if (result.reason === 'forbidden') {
          throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
        }
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID')
      }
      return result.receipt
    },
  })
}

async function materializeWorkerChunk(
  input: RecoveryArchiveAsyncRestoreChunkInput,
  expected: Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'>,
): Promise<RecoveryArchiveRestoreChunkMaterialized> {
  try {
    const binding = await readRecoveryArchiveRestoreWorkerBinding(input.query, input.claim)
    const loaded = await loadRecoveryArchiveAsyncPlanByBinding(
      input.runtime.objectStore,
      input.runtime.transactionDepth,
      binding,
    )
    const descriptor = loaded.payload.chunks[expected.chunkIndex]
    if (!descriptor || !chunkDescriptorMatches(expected, descriptor)) invalidChunk()
    const chunkPayload = await loadRecoveryArchiveAsyncChunk(
      input.runtime.objectStore,
      input.runtime.transactionDepth,
      binding.archiveGenerationId,
      descriptor,
    )
    const archive = await loadRecoveryArchiveAuthorityInternal(input.transaction, {
      workspaceId: binding.workspaceId,
      baseId: binding.baseId,
      sheetId: binding.sheetId,
      generationId: binding.archiveGenerationId,
      recheckAuthority: async (query) => input.recheckAuthority(query, {
        sheetId: binding.sheetId,
        actorId: binding.actorId,
      }),
    })
    if (
      archive.keyId !== binding.keyId ||
      archive.selectedBinding.anchorOperationId !== loaded.payload.anchorOperationId ||
      archive.selectedBinding.anchorSeq !== loaded.payload.anchorSeq ||
      archive.selectedBinding.checkpointId !== loaded.payload.checkpointId ||
      archive.selectedBinding.rootHash !== binding.archiveRootHash ||
      archive.selectedBinding.sourceVectorHash !== binding.sourceVectorHash
    ) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT')
    }
    const state = await readRecoveryArchiveCompleteSectionState({
      query: input.query,
      selectedBinding: archive.selectedBinding,
      keyCustody: input.runtime.keyCustody,
      transactionDepth: input.runtime.transactionDepth,
      objectStore: input.runtime.objectStore,
      manifestObject: archive.manifestObject,
      sectionObjects: archive.sectionObjects,
    })
    const targetRecords = materializeWorkerTargetRecords(
      binding.recoveryMode,
      chunkPayload,
      state.records,
    )
    const payload: MaterializedWorkerChunk = Object.freeze({
      binding,
      planPayload: loaded.payload,
      chunkPayload,
      targetRecords,
      targetLinks: materializeRecoveryArchiveLinksForSync(state.links),
    })
    materializedWorkerChunks.add(payload)
    return Object.freeze({ ...expected, payload })
  } catch (error) {
    if (error instanceof RecoveryArchiveRestoreJobError) throw error
    if (error instanceof RecoveryArchivePreviewError) {
      if (error.code === 'RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED') {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
      }
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT')
    }
    if (
      error instanceof RecoveryArchiveAsyncPlanError ||
      error instanceof RecoveryArchiveReaderError ||
      error instanceof RecoveryArchiveSyncRestoreError
    ) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT')
    }
    throw error
  }
}

function materializeWorkerTargetRecords(
  recoveryMode: RecoveryArchiveRestoreWorkerBinding['recoveryMode'],
  chunk: RecoveryArchiveAsyncChunkPayload,
  records: Awaited<ReturnType<typeof readRecoveryArchiveCompleteSectionState>>['records'],
): Awaited<ReturnType<typeof readRecoveryArchiveCompleteSectionState>>['records'] {
  const target = new Map(records)
  for (const operation of chunk.operations) {
    if (operation.kind !== 'delete' || target.has(operation.recordId)) continue
    if (recoveryMode !== 'reset') invalidChunk()
    target.set(operation.recordId, {
      recordId: operation.recordId,
      exists: false,
      data: null,
      version: null,
    })
  }
  return target
}

const materializedWorkerChunks = new WeakSet<object>()

function admitWorkerChunk(value: unknown): MaterializedWorkerChunk {
  if (!value || typeof value !== 'object' || !materializedWorkerChunks.has(value)) invalidChunk()
  return value as MaterializedWorkerChunk
}

function chunkDescriptorMatches(
  expected: Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'>,
  descriptor: RecoveryArchiveAsyncPlanPayload['chunks'][number],
): boolean {
  return descriptor.chunkIndex === expected.chunkIndex &&
    descriptor.chunkHash === expected.chunkHash &&
    descriptor.objectId === expected.chunkObjectId &&
    descriptor.version === expected.chunkObjectVersion &&
    descriptor.sha256 === expected.chunkObjectSha256 &&
    descriptor.size === expected.chunkObjectSize &&
    descriptor.expiresAt === expected.chunkObjectExpiresAt &&
    descriptor.recordCount === expected.recordCount
}

function invalidChunk(): never {
  throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
}
