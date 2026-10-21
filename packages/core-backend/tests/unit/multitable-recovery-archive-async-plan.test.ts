import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildRecoveryArchiveAsyncPlan,
  loadRecoveryArchiveAsyncChunk,
  loadRecoveryArchiveAsyncPlan,
  persistRecoveryArchiveAsyncPlan,
  RecoveryArchiveAsyncPlanError,
} from '../../src/multitable/recovery-archive-async-plan'
import {
  createLocalRecoveryArchiveObjectStoreProvider,
  createTransactionGuardedRecoveryArchiveObjectStore,
} from '../../src/multitable/recovery-archive-object-store'
import type { ExactArchiveRecoveryIdentityClaims } from '../../src/multitable/restore-preview-identity'

const GENERATION_ID = '11111111-1111-4111-8111-111111111111'
const ANCHOR_OPERATION_ID = '22222222-2222-4222-8222-222222222222'
const EXPIRES_AT = '2030-09-28T10:00:00.000Z'
const SCHEMA_HASH = 'c'.repeat(64)

let root = ''

beforeEach(async () => {
  vi.stubEnv('JWT_SECRET', 'unit-test-recovery-archive-async-plan-secret')
  root = await mkdtemp(join(tmpdir(), 'recovery-archive-async-plan-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { force: true, recursive: true })
})

function input() {
  const liveRecords = new Map<string, { version: number }>()
  const targetRecords = new Map<string, { recordId: string; exists: boolean; version: number | null }>()
  const revertWrites = []
  for (let index = 0; index < 5000; index++) {
    const recordId = `record-${String(index).padStart(5, '0')}`
    liveRecords.set(recordId, { version: 7 })
    targetRecords.set(recordId, { recordId, exists: true, version: 3 })
    revertWrites.push({
      recordId,
      liveVersion: 7,
      changedFieldIds: ['field-text'],
      patch: { 'field-text': 'target-value-must-not-enter-plan-object' },
      projectedData: { 'field-text': 'target-value-must-not-enter-plan-object' },
      linkUpdates: index === 0
        ? [{ fieldId: 'field-link', targetIds: ['foreign-new'] }]
        : [],
    })
  }
  liveRecords.set('record-05000', { version: 4 })
  return {
    workspaceId: 'workspace-async',
    baseId: 'base-async',
    sheetId: 'sheet-async',
    actorId: 'actor-async',
    recoveryMode: 'reset' as const,
    scopeKind: 'whole_sheet' as const,
    scopeHash: 'a'.repeat(64),
    archiveGenerationId: GENERATION_ID,
    archiveRootHash: 'b'.repeat(64),
    sourceVectorHash: 'd'.repeat(64),
    keyId: 'key-async',
    anchorOperationId: ANCHOR_OPERATION_ID,
    anchorSeq: '9007199254740993',
    checkpointId: 'checkpoint-async',
    schemaHash: SCHEMA_HASH,
    authorizedScopeHash: 'e'.repeat(64),
    selectedRecordIds: [],
    selectedFieldIds: [],
    liveRecords,
    targetRecords,
    liveLinks: [
      { fieldId: 'field-link', recordId: 'record-00000', foreignRecordId: 'foreign-old' },
      { fieldId: 'field-link', recordId: 'record-00001', foreignRecordId: 'record-05000' },
    ],
    revertWrites,
    deleteRecordIds: ['record-05000'],
    expiresAt: EXPIRES_AT,
  }
}

function claimsFor(bundle: ReturnType<typeof buildRecoveryArchiveAsyncPlan>): ExactArchiveRecoveryIdentityClaims {
  const payload = bundle.planObject.payload
  const descriptor = bundle.planObject.descriptor
  return {
    sheetId: payload.sheetId,
    anchorOperationId: payload.anchorOperationId,
    anchorSeq: payload.anchorSeq,
    checkpointId: payload.checkpointId,
    scopeHash: payload.scopeHash,
    liveSetHash: payload.initialLiveSetHash,
    schemaHash: payload.schemaHash,
    actorId: payload.actorId,
    mode: payload.recoveryMode,
    authorizedScopeHash: 'e'.repeat(64),
    archiveGenerationId: payload.archiveGenerationId,
    archiveRootHash: payload.archiveRootHash,
    archiveSourceVectorHash: payload.sourceVectorHash,
    archiveKeyId: payload.keyId,
    archivePlanHash: bundle.plan.planHash,
    archivePlanObject: {
      objectId: descriptor.objectId,
      version: descriptor.version,
      sha256: descriptor.sha256,
      size: descriptor.size,
      expiresAt: descriptor.expiresAt,
    },
    scopeKind: payload.scopeKind,
  }
}

describe('Time Machine async archive restore frozen plan', () => {
  it('partitions the actual write set and derives a distinct full-live precondition for every chunk', () => {
    const bundle = buildRecoveryArchiveAsyncPlan(input())

    expect(bundle.plan.totalCount).toBe('5001')
    expect(bundle.chunkObjects).toHaveLength(2)
    expect(bundle.chunkObjects.map((object) => object.payload.operations.length)).toEqual([5000, 1])
    expect(bundle.chunkObjects[0].payload.expectedLiveSetHash)
      .not.toBe(bundle.chunkObjects[1].payload.expectedLiveSetHash)
    expect(bundle.chunkObjects[0].payload.expectedFinalLiveSetHash)
      .toBe(bundle.chunkObjects[1].payload.expectedLiveSetHash)
    expect(bundle.chunkObjects[0].payload.expectedAnchorScopeHash)
      .not.toBe(bundle.chunkObjects[1].payload.expectedAnchorScopeHash)
    expect(bundle.planObject.payload.initialLiveSetHash)
      .toBe(bundle.chunkObjects[0].payload.expectedLiveSetHash)
    expect(bundle.planObject.payload.authorizedScopeHash).toBe('e'.repeat(64))
    expect(bundle.planObject.payload.finalLiveSetHash)
      .toBe(bundle.chunkObjects[1].payload.expectedFinalLiveSetHash)
    expect(bundle.planObject.descriptor.objectId).toBe(bundle.planObject.descriptor.sha256)
    expect(bundle.chunkObjects.every((object) => object.descriptor.objectId === object.descriptor.sha256))
      .toBe(true)

    const objectText = [bundle.planObject, ...bundle.chunkObjects]
      .map((object) => new TextDecoder().decode(object.bytes))
      .join('\n')
    expect(objectText).not.toContain('target-value-must-not-enter-plan-object')
    expect(bundle.chunkObjects[0].payload.operations[0]).toEqual({
      kind: 'revert',
      recordId: 'record-00000',
      expectedVersion: 7,
      changedFieldIds: ['field-text'],
    })
    expect(bundle.chunkObjects[1].payload.operations[0]).toEqual({
      kind: 'delete',
      recordId: 'record-05000',
      expectedVersion: 4,
    })
  })

  it('round-trips exact immutable plan/chunk objects and rejects a token-plan hash mismatch', async () => {
    const provider = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root })
    const depth = { currentTransactionDepth: () => 0 }
    const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, depth)
    const bundle = buildRecoveryArchiveAsyncPlan(input())
    await persistRecoveryArchiveAsyncPlan(store, bundle)

    const loaded = await loadRecoveryArchiveAsyncPlan(provider, depth, claimsFor(bundle))
    expect(loaded.plan).toEqual(bundle.plan)
    expect(loaded.payload).toEqual(bundle.planObject.payload)
    await expect(loadRecoveryArchiveAsyncChunk(
      provider,
      depth,
      GENERATION_ID,
      bundle.planObject.payload.chunks[1],
    )).resolves.toEqual(bundle.chunkObjects[1].payload)

    await expect(loadRecoveryArchiveAsyncPlan(provider, depth, {
      ...claimsFor(bundle),
      archivePlanHash: 'f'.repeat(64),
    })).rejects.toEqual(
      new RecoveryArchiveAsyncPlanError('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH'),
    )
  })

  it('refuses a false async plan whose effective write set is still within the sync ceiling', () => {
    const candidate = input()
    candidate.revertWrites.splice(1)
    candidate.deleteRecordIds.splice(0)
    expect(() => buildRecoveryArchiveAsyncPlan(candidate)).toThrowError(
      new RecoveryArchiveAsyncPlanError('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID'),
    )
  })

  it('only synthesizes an absent target for reset deletes missing from the archive', () => {
    const candidate = input()
    candidate.recoveryMode = 'revert'
    expect(() => buildRecoveryArchiveAsyncPlan(candidate)).toThrowError(
      new RecoveryArchiveAsyncPlanError('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID'),
    )
  })
})
