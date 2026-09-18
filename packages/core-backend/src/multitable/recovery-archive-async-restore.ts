import { enqueueRecoveryArchiveDerivedEffect } from './recovery-archive-derived-effects'
import {
  acquireMaterializedArchiveAsyncFencesInternal,
  applyMaterializedExactArchiveRecoveryAsyncChunkInternal,
  type MaterializedArchiveAsyncFenceLease,
  type MaterializedArchiveAsyncChunkApplyInput,
  type ExactAnchorAppliedMutation,
  type ExactAnchorPlanAuthContext,
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

/** Durable job identity, not an HTTP request or a process-wide actor captured at worker startup. */
export type RecoveryArchiveWorkerIdentity = Readonly<Pick<
  RecoveryArchiveRestoreWorkerBinding,
  'jobId' | 'workspaceId' | 'baseId' | 'sheetId' | 'actorId'
>>

export interface RecoveryArchiveWorkerApplyCallbacks {
  readonly preliminaryFullRead: (query: QueryFn, identity: RecoveryArchiveWorkerIdentity) => Promise<boolean>
  readonly stabilizeAuthorization: (
    query: QueryFn,
    context: ExactAnchorPlanAuthContext,
    identity: RecoveryArchiveWorkerIdentity,
  ) => Promise<'ready' | 'busy' | 'unavailable'>
  readonly finalLockedFullRead: (
    query: QueryFn,
    lockedScope: Parameters<MaterializedArchiveAsyncChunkApplyInput['finalLockedFullRead']>[1],
    identity: RecoveryArchiveWorkerIdentity,
  ) => Promise<boolean>
  readonly evaluatePlanAuthorization: (
    query: QueryFn,
    context: ExactAnchorPlanAuthContext,
    identity: RecoveryArchiveWorkerIdentity,
  ) => Promise<boolean>
  readonly onMutationApplied?: (
    query: QueryFn,
    mutation: ExactAnchorAppliedMutation,
    identity: RecoveryArchiveWorkerIdentity,
  ) => Promise<void>
  /** Best-effort effects only. Durable events belong in onMutationApplied's transaction. */
  readonly afterCommit?: (
    identity: RecoveryArchiveWorkerIdentity,
    mutations: readonly ExactAnchorAppliedMutation[],
  ) => Promise<void>
}

export interface RecoveryArchiveAsyncRestoreChunkInput {
  readonly transaction: RecoveryArchiveRestoreJobTransaction
  /** Autocommit query used for immutable object materialization and D4 reconstruction. */
  readonly query: QueryFn
  readonly runtime: RecoveryArchivePreviewRuntime
  readonly claim: RecoveryArchiveRestoreJobWorkerClaim
  readonly recheckAuthority: (
    query: RecoveryArchiveRestoreJobQuery,
    context: RecoveryArchiveWorkerIdentity,
  ) => Promise<boolean>
  readonly apply: RecoveryArchiveWorkerApplyCallbacks
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
  readonly identity: RecoveryArchiveWorkerIdentity
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
  let identity: RecoveryArchiveWorkerIdentity | undefined
  const committedMutations: ExactAnchorAppliedMutation[] = []
  const result = await runRecoveryArchiveRestoreChunk(input.transaction, input.claim, {
    facadeLease: mintRecoveryArchiveAsyncRestoreFacadeLease(input.claim),
    read: input.query,
    materialize: async (expected) => {
      const materialized = await materializeWorkerChunk(input, expected)
      identity = admitWorkerChunk(materialized.payload).identity
      return materialized
    },
    prelock: async (query, context) => {
      if (context.sheetId !== input.claim.sheetId || context.jobId !== input.claim.jobId) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID')
      }
      fenceLease = await acquireMaterializedArchiveAsyncFencesInternal(query, context.sheetId)
    },
    recheckAuthority: async (query, context) => {
      if (!identity || identity.jobId !== context.jobId ||
        identity.sheetId !== context.sheetId || identity.actorId !== context.actorId) invalidChunk()
      return input.recheckAuthority(query, identity)
    },
    apply: async (query, context) => {
      // A transaction provider may retry its callback; retain facts only from its final attempt.
      committedMutations.length = 0
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
        bindWorkerApply(input.apply, materialized.identity, committedMutations),
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
  if (result.kind === 'committed' && identity && input.apply.afterCommit) {
    try {
      await input.apply.afterCommit(identity, committedMutations)
    } catch {
      console.warn('RECOVERY_ARCHIVE_POST_COMMIT_EFFECT_FAILED')
    }
  }
  return result
}

function bindWorkerApply(
  apply: RecoveryArchiveWorkerApplyCallbacks,
  identity: RecoveryArchiveWorkerIdentity,
  committedMutations: ExactAnchorAppliedMutation[],
): MaterializedArchiveAsyncChunkApplyInput {
  const onMutationApplied = apply.onMutationApplied
  return {
    sheetId: identity.sheetId,
    actorId: identity.actorId,
    preliminaryFullRead: (query) => apply.preliminaryFullRead(query, identity),
    stabilizeAuthorization: (query, context) => apply.stabilizeAuthorization(query, context, identity),
    finalLockedFullRead: (query, scope) => apply.finalLockedFullRead(query, scope, identity),
    evaluatePlanAuthorization: (query, context) => apply.evaluatePlanAuthorization(query, context, identity),
    onMutationApplied: async (query, mutation) => {
      await enqueueRecoveryArchiveDerivedEffect(query, identity, mutation)
      await onMutationApplied?.(query, mutation, identity)
      committedMutations.push(mutation)
    },
  }
}

async function materializeWorkerChunk(
  input: RecoveryArchiveAsyncRestoreChunkInput,
  expected: Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'>,
): Promise<RecoveryArchiveRestoreChunkMaterialized> {
  try {
    const binding = await readRecoveryArchiveRestoreWorkerBinding(input.query, input.claim)
    if (binding.jobId !== input.claim.jobId || binding.sheetId !== input.claim.sheetId) invalidChunk()
    const identity: RecoveryArchiveWorkerIdentity = Object.freeze({
      jobId: binding.jobId,
      workspaceId: binding.workspaceId,
      baseId: binding.baseId,
      sheetId: binding.sheetId,
      actorId: binding.actorId,
    })
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
      recheckAuthority: async (query) => input.recheckAuthority(query, identity),
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
      identity,
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
