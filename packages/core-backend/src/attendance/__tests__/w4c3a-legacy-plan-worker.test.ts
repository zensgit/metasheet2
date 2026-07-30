import { describe, expect, it, vi } from 'vitest'
import {
  buildLegacyImportExecutionPlanPackageV1,
  computeLegacyImportAsyncJobSummaryDigestV1,
  sha256HexOfCanonicalJsonV1,
  type LegacyImportExecutionPlanManifestV1,
} from '../w4c3a-legacy-execution-plan'
import {
  createAttendanceLegacyPlanWorkerV1,
  type AttendanceLegacyPlanWorkerCallbacksV1,
  type AttendanceLegacyPlanWorkerJobV1,
  type AttendanceLegacyPlanWorkerStoredPlanV1,
} from '../w4c3a-legacy-plan-worker'
import {
  createVerifiedAttendanceCalculationTargetIdentityV1,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type VerifiedAttendanceCalculationTargetIdentityV1,
  type VerifiedAttendanceOperationIdentityV1,
} from '../w4c0-identity'

const JOB_ID = '10000000-0000-4000-8000-000000000001'
const BATCH_ID = '10000000-0000-4000-8000-000000000002'
const ITEM_ID = '10000000-0000-4000-8000-000000000003'
const RECORD_ID = '10000000-0000-4000-8000-000000000004'
const ORG_ID = '20000000-0000-4000-8000-000000000001'
const USER_ID = '30000000-0000-4000-8000-000000000001'
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_C = 'c'.repeat(64)
const HEX_D = 'd'.repeat(64)
const COMPLETED_RESPONSE = Object.freeze({
  __jobType: 'commit' as const,
  idempotencyKey: null,
  __importEngine: 'standard' as const,
  recordUpsertStrategy: 'unnest' as const,
  itemsInsertStrategy: 'unnest' as const,
  summary: Object.freeze({
    processedRows: 1,
    failedRows: 0,
    elapsedMs: 0,
    chunkConfig: Object.freeze({ itemsChunkSize: 100, recordsChunkSize: 100 }),
  }),
})

async function identities(): Promise<{
  batch: VerifiedAttendanceOperationIdentityV1
  target: VerifiedAttendanceCalculationTargetIdentityV1
}> {
  const trx = { query: vi.fn(async () => ({ rows: [] })) }
  const posture = await resolveSegmentCalculationPosture(trx as never, ORG_ID)
  const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_ID, posture })
  return {
    batch: createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'batch',
      entrypoint: 'import_batch',
      source: { sourceKind: 'import_batch', batchCommandId: BATCH_ID },
    }),
    target: createVerifiedAttendanceCalculationTargetIdentityV1({
      org,
      userId: USER_ID,
      workDate: '2026-07-30',
    }),
  }
}

function packagePlan(): { job: AttendanceLegacyPlanWorkerJobV1; stored: AttendanceLegacyPlanWorkerStoredPlanV1 } {
  const identityProofVector = []
  const manifestSeed: Omit<LegacyImportExecutionPlanManifestV1, 'sourceOrdinalDigest' | 'chunkVectorDigest'> = {
    schemaVersion: 1,
    orgId: ORG_ID,
    jobId: JOB_ID,
    batchId: BATCH_ID,
    sourceKind: 'import_batch',
    sourceRef: 'attendance-import',
    createdBy: 'admin-a',
    actorId: 'admin-a',
    actorPosture: 'platform_admin',
    tokenSubjectUserId: 'admin-a',
    acceptedWritePosture: 'legacy_projection_only',
    identityProofVectorDigest: sha256HexOfCanonicalJsonV1(identityProofVector),
    commandFingerprint: HEX_A,
    legacyInputFingerprint: HEX_B,
    operationalBranch: 'strict_targeted',
    legacyRowSourceKind: 'direct_rows',
    sourceRowCount: 1,
    w4ItemCount: 1,
    w4DistinctTargetCount: 1,
    w4ItemSequenceFingerprint: HEX_C,
    w4ItemSetFingerprint: HEX_D,
    legacySourceRowLimit: null,
    groupRevision: null,
    groupStateFingerprint: null,
    batch: {
      kind: 'normal', source: 'manual', ruleSetId: null, mappingSnapshot: {}, sourceRowCount: 1,
      status: 'committed', idempotencyKey: null, visibilityRule: 'org', engine: 'standard',
      chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 }, recordUpsertStrategy: 'unnest',
      itemsInsertStrategy: 'unnest', mappingProfileId: null, compatibilityMetadata: {}, groupSync: null,
      itemReturnPolicy: { returnItems: false }, skippedSamplePolicy: { limit: 50 }, resultSlots: {},
    },
    artifactCleanup: { kind: 'none' },
  }
  const plan = buildLegacyImportExecutionPlanPackageV1({
    manifestSeed,
    items: [{
      kind: 'apply', ordinal: 0, semanticOrdinal: 0, itemId: ITEM_ID,
      targetRef: JSON.stringify([ORG_ID, USER_ID, '2026-07-30']),
      previewSnapshot: {},
      recordWriteRef: RECORD_ID,
    }],
    recordWrites: [{
      recordWriteId: RECORD_ID, recordId: RECORD_ID, orgId: ORG_ID, userId: USER_ID, workDate: '2026-07-30',
      sourceBatchId: BATCH_ID, sourceOrdinals: [0], targetRevision: 0, existingRecordPreconditionFingerprint: HEX_A,
      expectedSourceOwnership: null, mergeMode: 'merge', firstInAt: null, lastOutAt: null, workMinutes: null,
      lateMinutes: null, earlyLeaveMinutes: null, status: null, isWorkday: null, compatibilityMetadata: {},
      policySnapshot: {}, profileSnapshot: {}, multiPunchSnapshot: {}, attributionSnapshot: {}, resultSlots: {},
    }],
    groupEffects: [],
    groupEffectPlacements: [],
  })
  const job: AttendanceLegacyPlanWorkerJobV1 = {
    jobId: JOB_ID, orgId: ORG_ID, status: 'queued', w4ContractVersion: 1, batchId: BATCH_ID,
    sourceKind: 'import_batch', sourceRef: 'attendance-import', createdBy: 'admin-a', actorId: 'admin-a',
    actorPosture: 'platform_admin', tokenSubjectUserId: 'admin-a', acceptedWritePosture: 'legacy_projection_only',
    commandFingerprint: HEX_A, legacyInputFingerprint: HEX_B, operationalBranch: 'strict_targeted',
    identityProofVector,
    identityProofVectorDigest: plan.manifest.identityProofVectorDigest,
    itemCount: 1, distinctTargetCount: 1,
    itemSequenceFingerprint: HEX_C, itemSetFingerprint: HEX_D, planDigest: plan.planDigest,
  }
  return {
    job,
    stored: {
      planDigest: plan.planDigest,
      chunkVectorDigest: plan.manifest.chunkVectorDigest,
      chunkCount: plan.chunks.length,
      manifest: plan.manifest,
      chunks: plan.chunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex, firstSourceOrdinal: chunk.firstSourceOrdinal,
        sourceRowCount: chunk.sourceRowCount, chunkDigest: chunk.chunkDigest, chunk: chunk.body,
      })),
    },
  }
}

async function callbacks(
  overrides: Partial<AttendanceLegacyPlanWorkerCallbacksV1<object>> = {},
): Promise<{ hooks: AttendanceLegacyPlanWorkerCallbacksV1<object>; calls: string[]; job: AttendanceLegacyPlanWorkerJobV1 }> {
  const { job, stored } = packagePlan()
  const ids = await identities()
  const calls: string[] = []
  const hooks: AttendanceLegacyPlanWorkerCallbacksV1<object> = {
    readCandidateJob: vi.fn(async () => job),
    runSerializable: vi.fn(async (work) => work({})),
    acquireClass00: vi.fn(async () => { calls.push('00') }),
    resolveWritePosture: vi.fn(async () => { calls.push('posture'); return 'legacy_projection_only' }),
    lockJob: vi.fn(async () => { calls.push('job'); return job }),
    authorizeFullImport: vi.fn(async () => { calls.push('auth'); return true }),
    reservationIdentities: vi.fn(() => [ids.batch]),
    acquireClass10: vi.fn(async () => { calls.push('10') }),
    loadPlan: vi.fn(async () => { calls.push('plan'); return stored }),
    targetIdentities: vi.fn(() => [ids.target]),
    acquireClass11: vi.fn(async () => { calls.push('11') }),
    recheckPreconditions: vi.fn(async () => { calls.push('preconditions'); return true }),
    executeVerifiedPlan: vi.fn(async () => { calls.push('effect'); return COMPLETED_RESPONSE }),
    storeCompletedResponseAndTerminalize: vi.fn(async () => { calls.push('terminal') }),
    loadCompletedResponse: vi.fn(async () => {
      calls.push('replay')
      return {
        response: COMPLETED_RESPONSE,
        responseDigest: computeLegacyImportAsyncJobSummaryDigestV1(COMPLETED_RESPONSE),
      }
    }),
    markSuspendedQueued: vi.fn(async () => { calls.push('suspend') }),
    markPlanFailed: vi.fn(async (_trx, _jobId, reason) => { calls.push(`failed:${reason}`) }),
    ...overrides,
  }
  return { hooks, calls, job }
}

describe('createAttendanceLegacyPlanWorkerV1', () => {
  it('fails a missing chunk before class-11 or effects', async () => {
    const base = await callbacks({ loadPlan: vi.fn(async () => ({ ...packagePlan().stored, chunkCount: 2 })) })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'failed', reason: 'ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING',
    })
    expect(base.calls).not.toContain('11')
    expect(base.calls).not.toContain('effect')
  })

  it('fails a digest mutation before business effects', async () => {
    const altered = packagePlan().stored
    const base = await callbacks({ loadPlan: vi.fn(async () => ({ ...altered, planDigest: 'f'.repeat(64) })) })
    await createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)
    expect(base.calls).toContain('failed:ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
    expect(base.calls).not.toContain('effect')
  })

  it('rejects authorization before loading the manifest', async () => {
    const base = await callbacks({ authorizeFullImport: vi.fn(async () => false) })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'failed', reason: 'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED',
    })
    expect(base.calls).not.toContain('plan')
    expect(base.calls).not.toContain('11')
  })

  it('keeps a suspended queued job ahead of authorization and plan access', async () => {
    const base = await callbacks({
      resolveWritePosture: vi.fn(async () => { base.calls.push('posture'); return 'suspended' }),
      authorizeFullImport: vi.fn(async () => { throw new Error('must not authorize') }),
    })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({ kind: 'suspended' })
    expect(base.calls).toEqual(['00', 'posture', 'job', 'suspend'])
  })

  it('replays a completed immutable response with zero effects', async () => {
    const completed = { ...packagePlan().job, status: 'completed' as const }
    const base = await callbacks({ lockJob: vi.fn(async () => completed) })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'completed', response: COMPLETED_RESPONSE,
    })
    expect(base.calls).toContain('replay')
    expect(base.calls).not.toContain('plan')
    expect(base.calls).not.toContain('effect')
    expect(base.calls).not.toContain('terminal')
  })

  it('does not expose or rewrite a completed response after authorization loss', async () => {
    const completed = { ...packagePlan().job, status: 'completed' as const }
    const base = await callbacks({
      lockJob: vi.fn(async () => completed),
      authorizeFullImport: vi.fn(async () => false),
    })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'not_found',
    })
    expect(base.calls).not.toContain('replay')
    expect(base.calls).not.toContain('plan')
    expect(base.calls).not.toContain('effect')
    expect(base.calls).not.toContain('terminal')
  })

  it('does not expose a completed response whose stored digest is inconsistent', async () => {
    const completed = { ...packagePlan().job, status: 'completed' as const }
    const base = await callbacks({
      lockJob: vi.fn(async () => completed),
      loadCompletedResponse: vi.fn(async () => ({
        response: COMPLETED_RESPONSE,
        responseDigest: 'f'.repeat(64),
      })),
    })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'not_found',
    })
    expect(base.calls).not.toContain('plan')
    expect(base.calls).not.toContain('effect')
    expect(base.calls).not.toContain('terminal')
  })

  it('rolls back an executor response outside the closed compact-summary schema', async () => {
    const base = await callbacks({
      executeVerifiedPlan: vi.fn(async () => ({ __jobType: 'commit', imported: 1 })),
    })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).rejects.toThrow(
      'W4C3A_ASYNC_JOB_SUMMARY_INVALID',
    )
    expect(base.calls).not.toContain('terminal')
  })

  it('orders verified work through class-00, class-10, class-11, effect, terminal', async () => {
    const base = await callbacks()
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toMatchObject({ kind: 'completed' })
    expect(base.calls).toEqual(['00', 'posture', 'auth', '10', 'job', 'auth', 'plan', '11', 'preconditions', 'effect', 'terminal'])
    expect(base.hooks.storeCompletedResponseAndTerminalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: JOB_ID }),
      COMPLETED_RESPONSE,
      computeLegacyImportAsyncJobSummaryDigestV1(COMPLETED_RESPONSE),
    )
  })
})
