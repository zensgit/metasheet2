import { beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({
  acquireFences: vi.fn(),
  applyChunk: vi.fn(),
  enqueueDerived: vi.fn(),
  loadArchive: vi.fn(),
  loadChunk: vi.fn(),
  loadPlan: vi.fn(),
  materializeLinks: vi.fn(),
  readCompleteState: vi.fn(),
  readWorkerBinding: vi.fn(),
  runChunk: vi.fn(),
}))

vi.mock('../../src/multitable/recovery-archive-derived-effects', () => ({
  enqueueRecoveryArchiveDerivedEffect: dependencies.enqueueDerived,
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

import type {
  MaterializedArchiveAsyncFenceLease,
  MaterializedArchiveAsyncChunkApplyInput,
} from '../../src/multitable/exact-anchor-recovery-execute'
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
      onMutationApplied: vi.fn(async () => {}),
    },
  }
}

function mockIdentityPipeline(
  bindings: RecoveryArchiveRestoreWorkerBinding[],
  mismatch: Partial<Pick<RecoveryArchiveRestoreWorkerBinding, 'jobId' | 'sheetId' | 'actorId'>> = {},
): void {
  dependencies.readWorkerBinding.mockImplementation(async (_query, workerClaim) =>
    bindings.find((entry) => entry.jobId === workerClaim.jobId),
  )
  dependencies.loadPlan.mockImplementation(async (_store, _depth, entry) => ({
    payload: { ...planPayload, ...entry },
  }))
  dependencies.loadChunk.mockResolvedValue(chunkPayload)
  dependencies.loadArchive.mockImplementation(async (_transaction, input) => {
    if (!await input.recheckAuthority(query)) {
      throw new RecoveryArchivePreviewError('RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED')
    }
    const entry = bindings.find((item) => item.sheetId === input.sheetId)!
    return {
      keyId: entry.keyId,
      selectedBinding: {
        ...entry,
        anchorOperationId: planPayload.anchorOperationId,
        anchorSeq: planPayload.anchorSeq,
        checkpointId: planPayload.checkpointId,
        rootHash: entry.archiveRootHash,
      },
    }
  })
  dependencies.readCompleteState.mockResolvedValue({ records: new Map(), links: [] })
  dependencies.materializeLinks.mockReturnValue([])
  dependencies.acquireFences.mockResolvedValue({})
  dependencies.applyChunk.mockResolvedValue({
    ok: true, receipt: { operationId: OPERATION_ID, endpointSeq: '19', eventCount: 1, committedCount: '1' },
  })
  dependencies.runChunk.mockImplementation(async (
    transaction: RecoveryArchiveRestoreJobTransaction,
    workerClaim: RecoveryArchiveRestoreJobWorkerClaim,
    options: RunRecoveryArchiveRestoreChunkInput,
  ) => {
    const materialized = await options.materialize(expectedChunk)
    const entry = bindings.find((item) => item.jobId === workerClaim.jobId)!
    return transaction(async (fresh) => {
      await options.prelock?.(fresh, { jobId: entry.jobId, sheetId: entry.sheetId })
      const context = {
        jobId: entry.jobId, sheetId: entry.sheetId, actorId: entry.actorId,
        recoveryMode: entry.recoveryMode, scopeKind: entry.scopeKind, chunkIndex: 0,
        executionLease: {} as RecoveryArchiveRestoreChunkExecutionLease,
        ...mismatch,
      }
      if (!await options.recheckAuthority(fresh, context)) {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED')
      }
      return options.apply(fresh, { ...context, operationId: OPERATION_ID, payload: materialized.payload })
    })
  })
}

describe('Time Machine async archive restore facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dependencies.enqueueDerived.mockReset().mockResolvedValue(undefined)
  })

  it.each(['committed', 'rollback', 'already_committed', 'no_pending_chunk', 'effect_failure', 'enqueue_failure'] as const)(
    'post-commit effects respect %s outcome', async (outcome) => {
      const order: string[] = []
      const input = makeInput(order)
      mockIdentityPipeline([binding])
      const pipeline = dependencies.runChunk.getMockImplementation()!
      const mutation = { kind: 'delete' as const, recordId: 'record-effect', revisionId: 'revision-effect', linkInvalidations: [] }
      dependencies.enqueueDerived.mockImplementation(async () => {
        order.push('enqueue')
        if (outcome === 'enqueue_failure') throw new Error('derived_enqueue_failed')
      })
      dependencies.applyChunk.mockImplementation(async (fresh, apply: MaterializedArchiveAsyncChunkApplyInput) => {
        await apply.onMutationApplied?.(fresh, mutation)
        order.push('mutation')
        return { ok: true, receipt: { operationId: OPERATION_ID, endpointSeq: '19', eventCount: 1, committedCount: '1' } }
      })
      dependencies.runChunk.mockImplementation(async (...args) => {
        if (outcome === 'already_committed') {
          await args[2].materialize(expectedChunk)
          return { kind: outcome }
        }
        if (outcome === 'no_pending_chunk') return { kind: outcome }
        await pipeline(...args)
        if (outcome === 'rollback') throw new Error('synthetic_commit_failure')
        order.push('commit')
        return { kind: 'committed', chunkIndex: 0, completedCount: '1' }
      })
      const afterCommit = vi.fn(async () => {
        order.push('afterCommit')
        if (outcome === 'effect_failure') throw new Error('hostile-secret-value')
      })
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const configured = { ...input, apply: { ...input.apply, afterCommit } }
        if (outcome === 'enqueue_failure') {
          await expect(executeRecoveryArchiveAsyncRestoreChunk(configured)).rejects.toThrow('derived_enqueue_failed')
          expect(order).not.toContain('commit')
          expect(input.apply.onMutationApplied).not.toHaveBeenCalled()
        } else if (outcome === 'rollback') {
          await expect(executeRecoveryArchiveAsyncRestoreChunk(configured)).rejects.toThrow('synthetic_commit_failure')
        } else {
          const result = await executeRecoveryArchiveAsyncRestoreChunk(configured)
          expect(result.kind).toBe(outcome === 'effect_failure' ? 'committed' : outcome)
        }
        if (outcome === 'committed' || outcome === 'effect_failure') {
          expect(afterCommit).toHaveBeenCalledTimes(1)
          expect(afterCommit).toHaveBeenCalledWith(
            { jobId: binding.jobId, workspaceId: binding.workspaceId, baseId: binding.baseId, sheetId: binding.sheetId, actorId: binding.actorId },
            [mutation],
          )
          expect(order.indexOf('afterCommit')).toBeGreaterThan(order.indexOf('commit'))
          expect(order.indexOf('enqueue')).toBeLessThan(order.indexOf('mutation'))
          expect(dependencies.enqueueDerived).toHaveBeenCalledWith(
            expect.any(Function),
            { jobId: binding.jobId, workspaceId: binding.workspaceId, baseId: binding.baseId, sheetId: binding.sheetId, actorId: binding.actorId },
            mutation,
          )
        } else expect(afterCommit).not.toHaveBeenCalled()
        if (outcome === 'effect_failure') expect(warning).toHaveBeenCalledWith('RECOVERY_ARCHIVE_POST_COMMIT_EFFECT_FAILED')
        else expect(warning).not.toHaveBeenCalled()
      } finally {
        warning.mockRestore()
      }
    },
  )

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
    dependencies.loadArchive.mockImplementation(async (_transaction, input) => {
      order.push('archive')
      expect(await input.recheckAuthority(query)).toBe(true)
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
    const lockedScope = {} as Parameters<MaterializedArchiveAsyncChunkApplyInput['finalLockedFullRead']>[1]
    const planContext = {} as Parameters<MaterializedArchiveAsyncChunkApplyInput['evaluatePlanAuthorization']>[1]
    const mutation = { kind: 'delete', recordId: 'record-async-worker', revisionId: 'revision', linkInvalidations: [] } as const
    dependencies.applyChunk.mockImplementation(async (fresh, apply: MaterializedArchiveAsyncChunkApplyInput, options) => {
      order.push('l8')
      expect(options.executionLease).toBe(executionLease)
      expect(await apply.preliminaryFullRead(fresh)).toBe(true)
      expect(await apply.stabilizeAuthorization(fresh, planContext)).toBe('ready')
      expect(await apply.finalLockedFullRead(fresh, lockedScope)).toBe(true)
      expect(await apply.evaluatePlanAuthorization(fresh, planContext)).toBe(true)
      await apply.onMutationApplied?.(fresh, { ...mutation, linkInvalidations: [] })
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

    const input = makeInput(order)
    await expect(executeRecoveryArchiveAsyncRestoreChunk(input)).resolves.toEqual({
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
      'authority',
      'reader',
      'links',
      'transaction',
      'fences',
      'authority',
      'l8',
    ])
    const identity = {
      jobId: binding.jobId, workspaceId: binding.workspaceId, baseId: binding.baseId,
      sheetId: binding.sheetId, actorId: binding.actorId,
    }
    expect(input.recheckAuthority).toHaveBeenNthCalledWith(1, query, identity)
    expect(input.recheckAuthority).toHaveBeenNthCalledWith(2, query, identity)
    expect(input.apply.preliminaryFullRead).toHaveBeenCalledWith(query, identity)
    expect(input.apply.stabilizeAuthorization).toHaveBeenCalledWith(query, planContext, identity)
    expect(input.apply.finalLockedFullRead).toHaveBeenCalledWith(query, lockedScope, identity)
    expect(input.apply.evaluatePlanAuthorization).toHaveBeenCalledWith(query, planContext, identity)
    expect(input.apply.onMutationApplied).toHaveBeenCalledWith(query, mutation, identity)
    const received = vi.mocked(input.recheckAuthority).mock.calls[0][1]
    expect(Object.isFrozen(received)).toBe(true)
    expect(Reflect.set(received, 'actorId', 'wrong-actor')).toBe(false)
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

  it('reuses runtime adapters across concurrent jobs without reusing either job identity', async () => {
    const otherBinding = {
      ...binding,
      jobId: '55555555-5555-4555-8555-555555555555',
      workspaceId: 'other-workspace', baseId: 'other-base', sheetId: 'other-sheet', actorId: 'other-actor',
    }
    mockIdentityPipeline([binding, otherBinding])
    const identities: unknown[] = []
    const input = makeInput([])
    vi.mocked(input.apply.preliminaryFullRead).mockImplementation(async (_query, identity) => {
      identities.push(identity)
      return true
    })
    dependencies.applyChunk.mockImplementation(async (fresh, apply: MaterializedArchiveAsyncChunkApplyInput) => {
      expect(await apply.preliminaryFullRead(fresh)).toBe(true)
      return { ok: true, receipt: { operationId: OPERATION_ID, endpointSeq: '19', eventCount: 1, committedCount: '1' } }
    })
    await Promise.all([binding, otherBinding].map((entry) => executeRecoveryArchiveAsyncRestoreChunk({
      ...input,
      claim: { ...claim, jobId: entry.jobId, sheetId: entry.sheetId },
    })))
    expect(identities).toHaveLength(2)
    expect(identities).toEqual(expect.arrayContaining([binding, otherBinding].map((entry) => ({
      jobId: entry.jobId, workspaceId: entry.workspaceId, baseId: entry.baseId,
      sheetId: entry.sheetId, actorId: entry.actorId,
    }))))
    expect(identities[0]).not.toBe(identities[1])
    expect(identities.every(Object.isFrozen)).toBe(true)
  })

  it.each(['jobId', 'sheetId', 'actorId'] as const)(
    'rejects a changed runner %s before invoking transactional authority or apply callbacks',
    async (key) => {
      mockIdentityPipeline([binding], { [key]: 'wrong-identity' })
      const input = makeInput([])
      await expect(executeRecoveryArchiveAsyncRestoreChunk(input)).rejects.toEqual(
        new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID'),
      )
      expect(input.recheckAuthority).toHaveBeenCalledTimes(1) // archive materialization only
      expect(dependencies.applyChunk).not.toHaveBeenCalled()
      expect(input.apply.onMutationApplied).not.toHaveBeenCalled()
    },
  )

  it.each(['jobId', 'sheetId'] as const)('rejects a worker-binding %s mismatch before archive reads', async (key) => {
    mockIdentityPipeline([binding])
    dependencies.readWorkerBinding.mockResolvedValue({ ...binding, [key]: 'wrong-identity' })
    await expect(executeRecoveryArchiveAsyncRestoreChunk(makeInput([]))).rejects.toEqual(
      new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID'),
    )
    expect(dependencies.loadPlan).not.toHaveBeenCalled()
    expect(dependencies.loadArchive).not.toHaveBeenCalled()
    expect(dependencies.applyChunk).not.toHaveBeenCalled()
  })

  it('honors a task-specific authority revocation before any apply callback', async () => {
    mockIdentityPipeline([binding])
    const input = makeInput([])
    vi.mocked(input.recheckAuthority).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(executeRecoveryArchiveAsyncRestoreChunk(input)).rejects.toEqual(
      new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED'),
    )
    expect(input.recheckAuthority).toHaveBeenCalledTimes(2)
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
