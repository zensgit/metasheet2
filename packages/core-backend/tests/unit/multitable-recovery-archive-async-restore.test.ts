import { beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({
  acquireFences: vi.fn(),
  applyChunk: vi.fn(),
  loadArchive: vi.fn(),
  loadChunk: vi.fn(),
  loadPlan: vi.fn(),
  materializeLinks: vi.fn(),
  readCompleteState: vi.fn(),
  readWorkerBinding: vi.fn(),
  runChunk: vi.fn(),
}))

vi.mock('../../src/multitable/exact-anchor-recovery-execute', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/multitable/exact-anchor-recovery-execute')
  >('../../src/multitable/exact-anchor-recovery-execute')
  return {
    ...actual,
    acquireMaterializedArchiveAsyncFencesInternal: dependencies.acquireFences,
    applyMaterializedExactArchiveRecoveryAsyncChunkInternal: dependencies.applyChunk,
  }
})

vi.mock('../../src/multitable/recovery-archive-async-plan', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-async-plan')>(
    '../../src/multitable/recovery-archive-async-plan',
  )
  return {
    ...actual,
    loadRecoveryArchiveAsyncChunk: dependencies.loadChunk,
    loadRecoveryArchiveAsyncPlanByBinding: dependencies.loadPlan,
  }
})

vi.mock('../../src/multitable/recovery-archive-preview', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-preview')>(
    '../../src/multitable/recovery-archive-preview',
  )
  return {
    ...actual,
    loadRecoveryArchiveAuthorityInternal: dependencies.loadArchive,
  }
})

vi.mock('../../src/multitable/recovery-archive-reader', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-reader')>(
    '../../src/multitable/recovery-archive-reader',
  )
  return {
    ...actual,
    readRecoveryArchiveCompleteSectionState: dependencies.readCompleteState,
  }
})

vi.mock('../../src/multitable/recovery-archive-restore-jobs', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-restore-jobs')>(
    '../../src/multitable/recovery-archive-restore-jobs',
  )
  return {
    ...actual,
    readRecoveryArchiveRestoreWorkerBinding: dependencies.readWorkerBinding,
    runRecoveryArchiveRestoreChunk: dependencies.runChunk,
  }
})

vi.mock('../../src/multitable/recovery-archive-sync-restore', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/recovery-archive-sync-restore')>(
    '../../src/multitable/recovery-archive-sync-restore',
  )
  return {
    ...actual,
    materializeRecoveryArchiveLinksForSync: dependencies.materializeLinks,
  }
})

import type { MaterializedArchiveAsyncFenceLease } from '../../src/multitable/exact-anchor-recovery-execute'
import {
  executeRecoveryArchiveAsyncRestoreChunk,
  type RecoveryArchiveAsyncRestoreChunkInput,
} from '../../src/multitable/recovery-archive-async-restore'
import type {
  RecoveryArchiveAsyncChunkPayload,
  RecoveryArchiveAsyncPlanPayload,
} from '../../src/multitable/recovery-archive-async-plan'
import {
  RecoveryArchivePreviewError,
  type RecoveryArchivePreviewRuntime,
} from '../../src/multitable/recovery-archive-preview'
import {
  RecoveryArchiveRestoreJobError,
  type RecoveryArchiveRestoreChunkMaterialized,
  type RecoveryArchiveRestoreChunkExecutionLease,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobTransaction,
  type RecoveryArchiveRestoreJobWorkerClaim,
  type RecoveryArchiveRestoreWorkerBinding,
  type RunRecoveryArchiveRestoreChunkInput,
} from '../../src/multitable/recovery-archive-restore-jobs'

const SHA = (value: string) => value.repeat(64)
const JOB_ID = '11111111-1111-4111-8111-111111111111'
const GENERATION_ID = '22222222-2222-4222-8222-222222222222'
const ANCHOR_OPERATION_ID = '33333333-3333-4333-8333-333333333333'
const OPERATION_ID = '44444444-4444-4444-8444-444444444444'
const EXPIRES_AT = '2030-09-29T10:00:00.000Z'
const LEASE_UNTIL = '2030-09-29T09:00:00.000Z'

const expectedChunk: Omit<RecoveryArchiveRestoreChunkMaterialized, 'payload'> = {
  chunkIndex: 0,
  chunkHash: SHA('a'),
  chunkObjectId: 'chunk-object',
  chunkObjectVersion: 'chunk-v1',
  chunkObjectSha256: SHA('b'),
  chunkObjectSize: '128',
  chunkObjectExpiresAt: EXPIRES_AT,
  recordCount: '1',
}

const binding: RecoveryArchiveRestoreWorkerBinding = {
  jobId: JOB_ID,
  workspaceId: 'workspace-async-worker',
  baseId: 'base-async-worker',
  sheetId: 'sheet-async-worker',
  actorId: 'actor-async-worker',
  recoveryMode: 'reset',
  scopeKind: 'selected_records',
  scopeHash: SHA('c'),
  archiveGenerationId: GENERATION_ID,
  archiveRootHash: SHA('d'),
  sourceVectorHash: SHA('e'),
  keyId: 'archive-key',
  planHash: SHA('f'),
  planObjectId: 'plan-object',
  planObjectVersion: 'plan-v1',
  planObjectSha256: SHA('1'),
  planObjectSize: '512',
  planObjectExpiresAt: EXPIRES_AT,
}

const chunkPayload: RecoveryArchiveAsyncChunkPayload = {
  format: 'metasheet.recovery-archive.restore-chunk.v1',
  chunkIndex: 0,
  expectedAnchorScopeHash: SHA('2'),
  expectedLiveSetHash: SHA('3'),
  expectedFinalLiveSetHash: SHA('4'),
  schemaHash: SHA('5'),
  operations: [{
    kind: 'revert',
    recordId: 'record-async-worker',
    expectedVersion: 7,
    changedFieldIds: ['field-text'],
  }],
}

const planPayload: RecoveryArchiveAsyncPlanPayload = {
  format: 'metasheet.recovery-archive.restore-plan.v1',
  workspaceId: binding.workspaceId,
  baseId: binding.baseId,
  sheetId: binding.sheetId,
  actorId: binding.actorId,
  recoveryMode: binding.recoveryMode,
  scopeKind: binding.scopeKind,
  scopeHash: binding.scopeHash,
  archiveGenerationId: binding.archiveGenerationId,
  archiveRootHash: binding.archiveRootHash,
  sourceVectorHash: binding.sourceVectorHash,
  keyId: binding.keyId,
  anchorOperationId: ANCHOR_OPERATION_ID,
  anchorSeq: '9007199254740993',
  checkpointId: 'checkpoint-async-worker',
  schemaHash: chunkPayload.schemaHash,
  authorizedScopeHash: SHA('6'),
  initialLiveSetHash: chunkPayload.expectedLiveSetHash,
  finalLiveSetHash: chunkPayload.expectedFinalLiveSetHash,
  selectedRecordIds: ['record-async-worker'],
  selectedFieldIds: [],
  chunks: [{
    chunkIndex: expectedChunk.chunkIndex,
    chunkHash: expectedChunk.chunkHash,
    objectId: expectedChunk.chunkObjectId,
    version: expectedChunk.chunkObjectVersion,
    sha256: expectedChunk.chunkObjectSha256,
    size: expectedChunk.chunkObjectSize,
    expiresAt: expectedChunk.chunkObjectExpiresAt,
    recordCount: expectedChunk.recordCount,
  }],
}

const claim = {
  jobId: JOB_ID,
  sheetId: binding.sheetId,
  keyId: binding.keyId,
  blockFence: '5',
  workerOwnerId: 'worker-async-restore',
  workerFence: '9',
  leaseUntil: LEASE_UNTIL,
} as unknown as RecoveryArchiveRestoreJobWorkerClaim

const query = vi.fn(async () => ({ rows: [] })) as unknown as RecoveryArchiveRestoreJobQuery
const runtime = {
  keyCustody: {},
  objectStore: {},
  transactionDepth: {},
} as RecoveryArchivePreviewRuntime

function makeInput(order: string[]): RecoveryArchiveAsyncRestoreChunkInput {
  const transaction = vi.fn(async <T>(work: (fresh: RecoveryArchiveRestoreJobQuery) => Promise<T>) => {
    order.push('transaction')
    return work(query)
  }) as RecoveryArchiveRestoreJobTransaction
  return {
    transaction,
    query,
    runtime,
    claim,
    recheckAuthority: vi.fn(async (fresh) => {
      order.push(fresh === query ? 'authority' : 'authority-unknown-query')
      return true
    }),
    apply: {
      preliminaryFullRead: vi.fn(async () => true),
      stabilizeAuthorization: vi.fn(async () => 'ready'),
      finalLockedFullRead: vi.fn(async () => true),
      evaluatePlanAuthorization: vi.fn(async () => true),
    },
  }
}

describe('Time Machine async archive restore facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('materializes outside the destructive transaction, prelocks first, and forwards the L8 receipt', async () => {
    const order: string[] = []
    const targetRecords = new Map([[
      'record-async-worker',
      { recordId: 'record-async-worker', exists: true, data: { 'field-text': 'archived' }, version: 3 },
    ]])
    const targetLinks = [{ fieldId: 'field-link', recordId: 'record-async-worker', foreignRecordId: 'foreign' }]
    const fenceLease = {} as MaterializedArchiveAsyncFenceLease

    dependencies.readWorkerBinding.mockImplementation(async () => {
      order.push('binding')
      return binding
    })
    dependencies.loadPlan.mockImplementation(async () => {
      order.push('plan')
      return { payload: planPayload }
    })
    dependencies.loadChunk.mockImplementation(async () => {
      order.push('chunk')
      return chunkPayload
    })
    dependencies.loadArchive.mockImplementation(async () => {
      order.push('archive')
      return {
        keyId: binding.keyId,
        selectedBinding: {
          generationId: binding.archiveGenerationId,
          workspaceId: binding.workspaceId,
          baseId: binding.baseId,
          sheetId: binding.sheetId,
          anchorOperationId: planPayload.anchorOperationId,
          anchorSeq: planPayload.anchorSeq,
          checkpointId: planPayload.checkpointId,
          rootHash: binding.archiveRootHash,
          sourceVectorHash: binding.sourceVectorHash,
        },
        manifestObject: {},
        sectionObjects: [],
      }
    })
    dependencies.readCompleteState.mockImplementation(async () => {
      order.push('reader')
      return { records: targetRecords, links: [] }
    })
    dependencies.materializeLinks.mockImplementation(() => {
      order.push('links')
      return targetLinks
    })
    dependencies.acquireFences.mockImplementation(async () => {
      order.push('fences')
      return fenceLease
    })
    const executionLease = {} as RecoveryArchiveRestoreChunkExecutionLease
    dependencies.applyChunk.mockImplementation(async (_query, _input, options) => {
      order.push('l8')
      expect(options.executionLease).toBe(executionLease)
      return {
        ok: true,
        receipt: { operationId: OPERATION_ID, endpointSeq: '19', eventCount: 1, committedCount: '1' },
        applied: { reverted: 1, deleted: 0 },
      }
    })
    dependencies.runChunk.mockImplementation(async (
      transaction: RecoveryArchiveRestoreJobTransaction,
      workerClaim: RecoveryArchiveRestoreJobWorkerClaim,
      options: RunRecoveryArchiveRestoreChunkInput,
    ) => {
      order.push('runner')
      expect(workerClaim).toBe(claim)
      const materialized = await options.materialize(expectedChunk)
      return transaction(async (fresh) => {
        await options.prelock?.(fresh, { jobId: JOB_ID, sheetId: binding.sheetId })
        const context = {
          jobId: JOB_ID,
          sheetId: binding.sheetId,
          actorId: binding.actorId,
          recoveryMode: binding.recoveryMode,
          scopeKind: binding.scopeKind,
          chunkIndex: 0,
          executionLease,
        }
        expect(await options.recheckAuthority(fresh, context)).toBe(true)
        const receipt = await options.apply(fresh, {
          ...context,
          operationId: 'provisional-operation',
          payload: materialized.payload,
        })
        expect(receipt.operationId).toBe(OPERATION_ID)
        return { kind: 'committed', chunkIndex: 0, completedCount: receipt.committedCount }
      })
    })

    await expect(executeRecoveryArchiveAsyncRestoreChunk(makeInput(order))).resolves.toEqual({
      kind: 'committed',
      chunkIndex: 0,
      completedCount: '1',
    })

    expect(order).toEqual([
      'runner',
      'binding',
      'plan',
      'chunk',
      'archive',
      'reader',
      'links',
      'transaction',
      'fences',
      'authority',
      'l8',
    ])
    expect(dependencies.applyChunk).toHaveBeenCalledWith(
      query,
      expect.objectContaining({ sheetId: binding.sheetId, actorId: binding.actorId }),
      expect.objectContaining({
        fenceLease,
        jobId: JOB_ID,
        planHash: binding.planHash,
        targetRecords,
        targetLinks,
        chunk: chunkPayload,
      }),
    )
  })

  it('rejects a frozen chunk descriptor mismatch before opening the destructive transaction', async () => {
    const order: string[] = []
    dependencies.readWorkerBinding.mockResolvedValue(binding)
    dependencies.loadPlan.mockResolvedValue({
      payload: {
        ...planPayload,
        chunks: [{ ...planPayload.chunks[0], sha256: SHA('9') }],
      },
    })
    dependencies.runChunk.mockImplementation(async (
      transaction: RecoveryArchiveRestoreJobTransaction,
      _workerClaim: RecoveryArchiveRestoreJobWorkerClaim,
      options: RunRecoveryArchiveRestoreChunkInput,
    ) => {
      await options.materialize(expectedChunk)
      return transaction(async () => ({ kind: 'committed' }))
    })

    await expect(executeRecoveryArchiveAsyncRestoreChunk(makeInput(order))).rejects.toEqual(
      new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID'),
    )
    expect(order).toEqual([])
    expect(dependencies.loadChunk).not.toHaveBeenCalled()
    expect(dependencies.acquireFences).not.toHaveBeenCalled()
    expect(dependencies.applyChunk).not.toHaveBeenCalled()
  })

  it('maps the materialization authority refusal before opening the destructive transaction', async () => {
    const order: string[] = []
    dependencies.readWorkerBinding.mockResolvedValue(binding)
    dependencies.loadPlan.mockResolvedValue({ payload: planPayload })
    dependencies.loadChunk.mockResolvedValue(chunkPayload)
    dependencies.loadArchive.mockRejectedValue(
      new RecoveryArchivePreviewError('RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED'),
    )
    dependencies.runChunk.mockImplementation(async (
      transaction: RecoveryArchiveRestoreJobTransaction,
      _workerClaim: RecoveryArchiveRestoreJobWorkerClaim,
      options: RunRecoveryArchiveRestoreChunkInput,
    ) => {
      await options.materialize(expectedChunk)
      return transaction(async () => ({ kind: 'committed' }))
    })

    await expect(executeRecoveryArchiveAsyncRestoreChunk(makeInput(order))).rejects.toEqual(
      new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED'),
    )
    expect(order).toEqual([])
    expect(dependencies.readCompleteState).not.toHaveBeenCalled()
    expect(dependencies.acquireFences).not.toHaveBeenCalled()
  })
})
