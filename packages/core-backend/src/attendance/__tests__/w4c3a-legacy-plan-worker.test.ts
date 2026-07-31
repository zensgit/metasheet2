import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
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
  type VerifiedAttendanceLegacyPlanV1,
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

function rawEvidence(sourceOrdinal: number) {
  return {
    schemaVersion: 1 as const,
    sourceOrdinal,
    punches: [],
    fields: {
      userId: { present: true as const, value: USER_ID },
      workDate: { present: true as const, value: '2026-07-30' },
      timezone: { present: true as const, value: 'Asia/Shanghai' },
      firstInAt: { present: false as const, value: null },
      lastOutAt: { present: false as const, value: null },
      status: { present: false as const, value: null },
      isWorkday: { present: false as const, value: null },
    },
    metrics: {
      workMinutes: { present: false as const, value: null },
      lateMinutes: { present: false as const, value: null },
      earlyLeaveMinutes: { present: false as const, value: null },
      leaveMinutes: { present: false as const, value: null },
      overtimeMinutes: { present: false as const, value: null },
    },
    provenance: {
      transport: 'rows' as const,
      sourceRef: `attendance-import:${BATCH_ID}:${sourceOrdinal}`,
      artifactSha256: null,
      normalizedCsvSha256: null,
      convertedSheetName: null,
    },
  }
}

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

function packagePlan(
  idempotencyKey: string | null = null,
  acceptedWritePosture: AttendanceLegacyPlanWorkerJobV1['acceptedWritePosture'] = 'legacy_projection_only',
): { job: AttendanceLegacyPlanWorkerJobV1; stored: AttendanceLegacyPlanWorkerStoredPlanV1 } {
  const identityProofVector = []
  const manifestSeed: Omit<
    LegacyImportExecutionPlanManifestV1,
    'sourceOrdinalDigest' | 'rawEvidenceDigest' | 'chunkVectorDigest'
  > = {
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
    acceptedWritePosture,
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
      status: 'committed', idempotencyKey, visibilityRule: 'org', engine: 'standard',
      chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 }, recordUpsertStrategy: 'unnest',
      itemsInsertStrategy: 'unnest', mappingProfileId: null, compatibilityMetadata: {}, groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
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
      rawEvidence: rawEvidence(0),
    }],
    recordWrites: [{
      recordWriteId: RECORD_ID, recordId: RECORD_ID, orgId: ORG_ID, userId: USER_ID, workDate: '2026-07-30',
      sourceBatchId: BATCH_ID, sourceOrdinals: [0], targetRevision: 0, existingRecordPreconditionFingerprint: HEX_A,
      expectedSourceOwnership: null, mergeMode: 'merge', firstInAt: null, lastOutAt: null, workMinutes: null,
      lateMinutes: null, earlyLeaveMinutes: null, status: null, isWorkday: null, timezone: 'Asia/Shanghai',
      compatibilityMetadata: {},
      policySnapshot: {}, profileSnapshot: {}, multiPunchSnapshot: {}, attributionSnapshot: {},
      resultSlots: {},
    }],
    groupEffects: [],
    groupEffectPlacements: [],
  })
  const job: AttendanceLegacyPlanWorkerJobV1 = {
    jobId: JOB_ID, orgId: ORG_ID, status: 'queued', w4ContractVersion: 1, batchId: BATCH_ID,
    idempotencyKey,
    sourceKind: 'import_batch', sourceRef: 'attendance-import', createdBy: 'admin-a', actorId: 'admin-a',
    actorPosture: 'platform_admin', tokenSubjectUserId: 'admin-a', acceptedWritePosture,
    commandFingerprint: HEX_A, legacyInputFingerprint: HEX_B, operationalBranch: 'strict_targeted',
    identityProofVector,
    identityProofVectorDigest: plan.manifest.identityProofVectorDigest,
    itemCount: 1, distinctTargetCount: 1,
    itemSequenceFingerprint: HEX_C, itemSetFingerprint: HEX_D, planDigest: plan.planDigest,
    executionReasonCode: null,
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

function packageReplayPlan(): {
  job: AttendanceLegacyPlanWorkerJobV1
  stored: AttendanceLegacyPlanWorkerStoredPlanV1
} {
  const identityProofVector: unknown[] = []
  const manifestSeed: Omit<
    LegacyImportExecutionPlanManifestV1,
    'sourceOrdinalDigest' | 'rawEvidenceDigest' | 'chunkVectorDigest'
  > = {
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
    operationalBranch: 'operational_only_idempotent_replay',
    legacyRowSourceKind: null,
    sourceRowCount: 0,
    w4ItemCount: 0,
    w4DistinctTargetCount: 0,
    w4ItemSequenceFingerprint:
      ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
    w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
    legacySourceRowLimit: null,
    groupRevision: null,
    groupStateFingerprint: null,
    batch: {
      kind: 'idempotent_replay',
      replayBatchId: RECORD_ID,
      replaySelector: 'precheck_hit',
      replayPreconditionDigest: HEX_A,
      importedCount: 1,
      skippedCount: 0,
      totalRowCount: 1,
      engine: 'standard',
      recordUpsertStrategy: 'unnest',
      metadata: {
        chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 },
        itemsInsertStrategy: 'unnest',
      },
      idempotencyKey: 'idem-a',
      requesterVisibility: { kind: 'org' },
    },
    artifactCleanup: { kind: 'none' },
  }
  const plan = buildLegacyImportExecutionPlanPackageV1({
    manifestSeed,
    items: [],
    recordWrites: [],
    groupEffects: [],
    groupEffectPlacements: [],
  })
  return {
    job: {
      jobId: JOB_ID,
      orgId: ORG_ID,
      status: 'queued',
      w4ContractVersion: 1,
      batchId: BATCH_ID,
      idempotencyKey: 'idem-a',
      sourceKind: 'import_batch',
      sourceRef: 'attendance-import',
      createdBy: 'admin-a',
      actorId: 'admin-a',
      actorPosture: 'platform_admin',
      tokenSubjectUserId: 'admin-a',
      acceptedWritePosture: 'legacy_projection_only',
      commandFingerprint: HEX_A,
      legacyInputFingerprint: HEX_B,
      operationalBranch: 'operational_only_idempotent_replay',
      identityProofVector,
      identityProofVectorDigest: plan.manifest.identityProofVectorDigest,
      itemCount: 0,
      distinctTargetCount: 0,
      itemSequenceFingerprint:
        ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
      itemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
      planDigest: plan.planDigest,
      executionReasonCode: null,
    },
    stored: {
      planDigest: plan.planDigest,
      chunkVectorDigest: plan.manifest.chunkVectorDigest,
      chunkCount: 0,
      manifest: plan.manifest,
      chunks: [],
    },
  }
}

async function callbacks(
  overrides: Partial<AttendanceLegacyPlanWorkerCallbacksV1<object>> = {},
  planPackage = packagePlan(),
): Promise<{ hooks: AttendanceLegacyPlanWorkerCallbacksV1<object>; calls: string[]; job: AttendanceLegacyPlanWorkerJobV1 }> {
  const { job, stored } = planPackage
  const ids = await identities()
  const calls: string[] = []
  const hooks: AttendanceLegacyPlanWorkerCallbacksV1<object> = {
    readCandidateJob: vi.fn(async () => ({ jobId: job.jobId, orgId: job.orgId })),
    runSerializable: vi.fn(async (work) => work({})),
    acquireClass00: vi.fn(async () => { calls.push('00') }),
    resolveWritePosture: vi.fn(async () => { calls.push('posture'); return 'legacy_projection_only' }),
    readAuthorizationJob: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('job-read'); return job }),
    lockJob: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('job'); return job }),
    authorizeFullImport: vi.fn(async () => { calls.push('auth'); return true }),
    reservationIdentities: vi.fn(() => [ids.batch]),
    acquireClass10: vi.fn(async () => { calls.push('10') }),
    inspectOperationRows: vi.fn(async () => { calls.push('registry-read'); return 'all_new' }),
    loadPlan: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('plan'); return stored }),
    claimOperationRows: vi.fn(async () => { calls.push('registry'); return null }),
    recheckReplayPrecondition: vi.fn(async () => {
      calls.push('replay-precondition')
      return true
    }),
    targetIdentities: vi.fn(() => [ids.target]),
    acquireClass11: vi.fn(async () => { calls.push('11') }),
    recheckPreconditions: vi.fn(async () => { calls.push('preconditions'); return true }),
    executeVerifiedPlan: vi.fn(async () => { calls.push('effect'); return COMPLETED_RESPONSE }),
    storeCompletedResponseAndTerminalize: vi.fn(async () => { calls.push('terminal') }),
    loadCompletedResponse: vi.fn(async (_trx, _jobId, _orgId) => {
      calls.push('replay')
      return {
        response: COMPLETED_RESPONSE,
        responseDigest: computeLegacyImportAsyncJobSummaryDigestV1(COMPLETED_RESPONSE),
      }
    }),
    markSuspendedQueued: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('suspend') }),
    clearResumedSuspendedReason: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('resume') }),
    markPlanFailed: vi.fn(async (_trx, _jobId, _orgId, reason) => { calls.push(`failed:${reason}`) }),
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

  it('rechecks the locked replay batch before response construction', async () => {
    const replay = packageReplayPlan()
    const base = await callbacks({}, replay)
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toMatchObject({ kind: 'completed' })
    expect(base.calls).toContain('replay-precondition')
    expect(base.calls).not.toContain('11')
    expect(base.calls).not.toContain('preconditions')
    expect(
      vi.mocked(base.hooks.executeVerifiedPlan).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      vi.mocked(base.hooks.recheckReplayPrecondition).mock.invocationCallOrder[0] ??
        0,
    )
  })

  it('terminal-fails a changed replay batch before effects or response storage', async () => {
    const replay = packageReplayPlan()
    const base = await callbacks(
      {
        recheckReplayPrecondition: vi.fn(async () => false),
      },
      replay,
    )
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED',
    })
    expect(base.hooks.recheckReplayPrecondition).toHaveBeenCalled()
    expect(base.calls).not.toContain('effect')
    expect(base.calls).not.toContain('terminal')
    expect(base.calls).not.toContain('11')
  })

  it('fails closed when a frozen record timezone is substituted in the persisted chunk', async () => {
    const { stored } = packagePlan()
    const mutated = {
      ...stored,
      chunks: stored.chunks.map((chunk) => ({
        ...chunk,
        chunk: {
          ...chunk.chunk,
          recordWrites: chunk.chunk.recordWrites.map((write) => ({
            ...write,
            timezone: write.timezone === 'UTC' ? 'Asia/Tokyo' : 'UTC',
          })),
        },
      })),
    }
    const base = await callbacks({ loadPlan: vi.fn(async () => mutated) })
    await createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)
    expect(base.calls).toContain('failed:ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH')
    expect(base.calls).not.toContain('effect')
  })

  it('replays source=null and frozen timezone from persisted manifest/chunk only', async () => {
    const identityProofVector: unknown[] = []
    const GROUP_ID = '10000000-0000-4000-8000-000000000008'
    const manifestSeed: Omit<
      LegacyImportExecutionPlanManifestV1,
      'sourceOrdinalDigest' | 'rawEvidenceDigest' | 'chunkVectorDigest'
    > = {
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
      groupRevision: 1,
      groupStateFingerprint: HEX_A,
      batch: {
        kind: 'normal',
        source: null,
        ruleSetId: null,
        mappingSnapshot: {},
        sourceRowCount: 1,
        status: 'committed',
        idempotencyKey: null,
        visibilityRule: 'org',
        engine: 'standard',
        chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 },
        recordUpsertStrategy: 'values',
        itemsInsertStrategy: 'unnest',
        mappingProfileId: null,
        compatibilityMetadata: {},
        groupSync: null,
        itemReturnPolicy: { returnItems: false, itemsLimit: null },
        skippedSamplePolicy: { limit: 50 },
        resultSlots: {
          groupCreated: 'ensure_group_returned_row_count',
          groupMembersAdded: 'ensure_member_inserted_row_count',
        },
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
        rawEvidence: rawEvidence(0),
      }],
      recordWrites: [{
        recordWriteId: RECORD_ID, recordId: RECORD_ID, orgId: ORG_ID, userId: USER_ID,
        workDate: '2026-07-30', sourceBatchId: BATCH_ID, sourceOrdinals: [0],
        targetRevision: 0, existingRecordPreconditionFingerprint: HEX_A,
        expectedSourceOwnership: null, mergeMode: 'merge', firstInAt: null, lastOutAt: null,
        workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null, status: null,
        isWorkday: null, timezone: 'Asia/Shanghai', compatibilityMetadata: {},
        policySnapshot: {}, profileSnapshot: {}, multiPunchSnapshot: {},
        attributionSnapshot: {}, resultSlots: {},
      }],
      groupEffects: [{
        kind: 'ensure_group', groupId: GROUP_ID, normalizedName: 'engineering', groupExistedAtPrepare: false,
        displayName: 'Engineering', code: null, timezone: 'Asia/Taipei', ruleSetId: null,
      }],
      groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 0 }],
    })
    const job: AttendanceLegacyPlanWorkerJobV1 = {
      jobId: JOB_ID, orgId: ORG_ID, status: 'queued', w4ContractVersion: 1, batchId: BATCH_ID,
      idempotencyKey: null,
      sourceKind: 'import_batch', sourceRef: 'attendance-import', createdBy: 'admin-a',
      actorId: 'admin-a', actorPosture: 'platform_admin', tokenSubjectUserId: 'admin-a',
      acceptedWritePosture: 'legacy_projection_only', commandFingerprint: HEX_A,
      legacyInputFingerprint: HEX_B, operationalBranch: 'strict_targeted',
      identityProofVector, identityProofVectorDigest: plan.manifest.identityProofVectorDigest,
      itemCount: 1, distinctTargetCount: 1, itemSequenceFingerprint: HEX_C,
      itemSetFingerprint: HEX_D, planDigest: plan.planDigest,
      executionReasonCode: null,
    }
    const stored: AttendanceLegacyPlanWorkerStoredPlanV1 = {
      planDigest: plan.planDigest,
      chunkVectorDigest: plan.manifest.chunkVectorDigest,
      chunkCount: plan.chunks.length,
      manifest: JSON.parse(JSON.stringify(plan.manifest)),
      chunks: plan.chunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        firstSourceOrdinal: chunk.firstSourceOrdinal,
        sourceRowCount: chunk.sourceRowCount,
        chunkDigest: chunk.chunkDigest,
        chunk: JSON.parse(JSON.stringify(chunk.body)),
      })),
    }
    let seenPlan: VerifiedAttendanceLegacyPlanV1 | null = null
    const ids = await identities()
    const calls: string[] = []
    const hooks: AttendanceLegacyPlanWorkerCallbacksV1<object> = {
      readCandidateJob: vi.fn(async () => ({ jobId: job.jobId, orgId: job.orgId })),
      runSerializable: vi.fn(async (work) => work({})),
      acquireClass00: vi.fn(async () => { calls.push('00') }),
      resolveWritePosture: vi.fn(async () => { calls.push('posture'); return 'legacy_projection_only' }),
      readAuthorizationJob: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('job-read'); return job }),
      lockJob: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('job'); return job }),
      authorizeFullImport: vi.fn(async () => { calls.push('auth'); return true }),
      reservationIdentities: vi.fn(() => [ids.batch]),
      acquireClass10: vi.fn(async () => { calls.push('10') }),
      inspectOperationRows: vi.fn(async () => { calls.push('registry-read'); return 'all_new' }),
      loadPlan: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('plan'); return stored }),
      claimOperationRows: vi.fn(async () => { calls.push('registry'); return null }),
      recheckReplayPrecondition: vi.fn(async () => {
        calls.push('replay-precondition')
        return true
      }),
      targetIdentities: vi.fn(() => [ids.target]),
      acquireClass11: vi.fn(async () => { calls.push('11') }),
      recheckPreconditions: vi.fn(async () => { calls.push('preconditions'); return true }),
      executeVerifiedPlan: vi.fn(async (_trx, _job, verified) => {
        calls.push('effect')
        seenPlan = verified
        return COMPLETED_RESPONSE
      }),
      storeCompletedResponseAndTerminalize: vi.fn(async () => { calls.push('terminal') }),
      loadCompletedResponse: vi.fn(async (_trx, _jobId, _orgId) => {
        return {
          response: COMPLETED_RESPONSE,
          responseDigest: computeLegacyImportAsyncJobSummaryDigestV1(COMPLETED_RESPONSE),
        }
      }),
      markSuspendedQueued: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('suspend') }),
      clearResumedSuspendedReason: vi.fn(async (_trx, _jobId, _orgId) => { calls.push('resume') }),
      markPlanFailed: vi.fn(async (_trx, _jobId, _orgId, reason) => { calls.push(`failed:${reason}`) }),
    }
    await expect(createAttendanceLegacyPlanWorkerV1(hooks).process(JOB_ID)).resolves.toMatchObject({
      kind: 'completed',
    })
    expect(calls).toContain('effect')
    expect(seenPlan).toMatchObject({
      manifest: { batch: { kind: 'normal', source: null } },
      recordWrites: [{ timezone: 'Asia/Shanghai' }],
      groupEffects: [{
        kind: 'ensure_group',
        normalizedName: 'engineering',
        displayName: 'Engineering',
      }],
    })
  })

  it('rejects authorization before loading the manifest', async () => {
    const base = await callbacks({ authorizeFullImport: vi.fn(async () => false) })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'failed', reason: 'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED',
    })
    expect(base.calls).not.toContain('plan')
    expect(base.calls).not.toContain('11')
  })

  it('reads only candidate identity before the serializable transaction', async () => {
    let transactionStarted = false
    const base = await callbacks({
      runSerializable: vi.fn(async (work) => {
        transactionStarted = true
        return work({})
      }),
      readCandidateJob: vi.fn(async () => {
        expect(transactionStarted).toBe(false)
        return { jobId: JOB_ID, orgId: ORG_ID }
      }),
      readAuthorizationJob: vi.fn(async () => {
        expect(transactionStarted).toBe(true)
        return packagePlan().job
      }),
    })

    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toMatchObject({ kind: 'completed' })
    expect(base.hooks.readCandidateJob).toHaveBeenCalledWith(JOB_ID)
    expect(base.hooks.readAuthorizationJob).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      ORG_ID,
    )
  })

  it('rejects an ambiguous authorization candidate identity without DML', async () => {
    const base = await callbacks({
      readAuthorizationJob: vi.fn(async () => ({
        ...packagePlan().job,
        orgId: '20000000-0000-4000-8000-000000000002',
      })),
    })
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toEqual({ kind: 'not_found' })
    expect(base.calls).toEqual(['00', 'posture'])
    expect(base.hooks.readAuthorizationJob).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      ORG_ID,
    )
    expect(base.hooks.acquireClass10).not.toHaveBeenCalled()
    expect(base.hooks.lockJob).not.toHaveBeenCalled()
    expect(base.hooks.loadPlan).not.toHaveBeenCalled()
    expect(base.hooks.acquireClass11).not.toHaveBeenCalled()
    expect(base.hooks.recheckPreconditions).not.toHaveBeenCalled()
    expect(base.hooks.executeVerifiedPlan).not.toHaveBeenCalled()
    expect(base.hooks.storeCompletedResponseAndTerminalize).not.toHaveBeenCalled()
    expect(base.hooks.loadCompletedResponse).not.toHaveBeenCalled()
    expect(base.hooks.markSuspendedQueued).not.toHaveBeenCalled()
    expect(base.hooks.markPlanFailed).not.toHaveBeenCalled()
  })

  it('rejects an ambiguous post-class-10 candidate identity without DML', async () => {
    const base = await callbacks({
      lockJob: vi.fn(async () => ({
        ...packagePlan().job,
        orgId: '20000000-0000-4000-8000-000000000002',
      })),
    })
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toEqual({ kind: 'not_found' })
    expect(base.calls).toEqual(['00', 'posture', 'job-read', 'auth', '10', 'registry-read'])
    expect(base.hooks.lockJob).toHaveBeenCalledWith(expect.anything(), JOB_ID, ORG_ID)
    expect(
      vi.mocked(base.hooks.lockJob).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      vi.mocked(base.hooks.acquireClass10).mock.invocationCallOrder[0] ?? 0,
    )
    expect(base.hooks.loadPlan).not.toHaveBeenCalled()
    expect(base.hooks.acquireClass11).not.toHaveBeenCalled()
    expect(base.hooks.recheckPreconditions).not.toHaveBeenCalled()
    expect(base.hooks.executeVerifiedPlan).not.toHaveBeenCalled()
    expect(base.hooks.storeCompletedResponseAndTerminalize).not.toHaveBeenCalled()
    expect(base.hooks.loadCompletedResponse).not.toHaveBeenCalled()
    expect(base.hooks.markSuspendedQueued).not.toHaveBeenCalled()
    expect(base.hooks.markPlanFailed).not.toHaveBeenCalled()
  })

  it('passes the frozen legacy idempotency key into the class-10 acquisition', async () => {
    const base = await callbacks({}, packagePlan('legacy-idempotency-a'))
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toMatchObject({ kind: 'completed' })
    expect(base.hooks.acquireClass10).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'legacy-idempotency-a' }),
      expect.any(Array),
    )
  })

  it('terminal-fails when the locked plan idempotency key differs from the job', async () => {
    const accepted = packagePlan('legacy-idempotency-a')
    const changed = packagePlan('legacy-idempotency-b')
    const base = await callbacks({}, {
      job: { ...accepted.job, planDigest: changed.stored.planDigest },
      stored: changed.stored,
    })
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH',
    })
    expect(base.hooks.acquireClass11).not.toHaveBeenCalled()
    expect(base.hooks.executeVerifiedPlan).not.toHaveBeenCalled()
    expect(base.hooks.storeCompletedResponseAndTerminalize).not.toHaveBeenCalled()
  })

  it('returns not-found with zero DML when the class-10 idempotency lock domain drifts before the job lock', async () => {
    const beforeLock = packagePlan('legacy-idempotency-a')
    const afterLock = packagePlan('legacy-idempotency-b')
    const base = await callbacks({
      readAuthorizationJob: vi.fn(async () => beforeLock.job),
      lockJob: vi.fn(async () => afterLock.job),
    }, beforeLock)
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toEqual({ kind: 'not_found' })
    expect(base.hooks.acquireClass10).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'legacy-idempotency-a' }),
      expect.any(Array),
    )
    expect(base.hooks.loadPlan).not.toHaveBeenCalled()
    expect(base.hooks.acquireClass11).not.toHaveBeenCalled()
    expect(base.hooks.executeVerifiedPlan).not.toHaveBeenCalled()
    expect(base.hooks.storeCompletedResponseAndTerminalize).not.toHaveBeenCalled()
    expect(base.hooks.markPlanFailed).not.toHaveBeenCalled()
  })

  it('keeps a suspended queued job ahead of authorization and plan access', async () => {
    const base = await callbacks({
      resolveWritePosture: vi.fn(async () => { base.calls.push('posture'); return 'suspended' }),
      authorizeFullImport: vi.fn(async () => { throw new Error('must not authorize') }),
    })
    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({ kind: 'suspended' })
    expect(base.calls).toEqual(['00', 'posture', 'job', 'suspend'])
  })

  it('clears a prior suspended reason only after the job lock when posture resumes', async () => {
    const resumed = {
      ...packagePlan().job,
      executionReasonCode: 'SEGMENT_CALCULATION_SUSPENDED',
    }
    const base = await callbacks({
      readAuthorizationJob: vi.fn(async () => resumed),
      lockJob: vi.fn(async () => {
        base.calls.push('job')
        return resumed
      }),
    })

    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toMatchObject({ kind: 'completed' })
    expect(base.calls).toEqual([
      '00',
      'posture',
      'auth',
      '10',
      'registry-read',
      'job',
      'resume',
      'auth',
      'plan',
      '11',
      'preconditions',
      'registry',
      'effect',
      'terminal',
    ])
    expect(
      vi.mocked(base.hooks.clearResumedSuspendedReason).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      vi.mocked(base.hooks.lockJob).mock.invocationCallOrder[0] ?? 0,
    )
    expect(
      vi.mocked(base.hooks.authorizeFullImport).mock.invocationCallOrder[1],
    ).toBeGreaterThan(
      vi.mocked(base.hooks.clearResumedSuspendedReason).mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('rejects an ambiguous suspended candidate identity without DML', async () => {
    const base = await callbacks({
      resolveWritePosture: vi.fn(async () => {
        base.calls.push('posture')
        return 'suspended'
      }),
      lockJob: vi.fn(async () => {
        base.calls.push('job')
        return {
          ...packagePlan().job,
          orgId: '20000000-0000-4000-8000-000000000002',
        }
      }),
    })
    await expect(
      createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID),
    ).resolves.toEqual({ kind: 'not_found' })
    expect(base.calls).toEqual(['00', 'posture', 'job'])
    expect(base.hooks.markSuspendedQueued).not.toHaveBeenCalled()
    expect(base.hooks.markPlanFailed).not.toHaveBeenCalled()
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

  it('replays a strict completed job only with an all-completed-congruent registry', async () => {
    const strict = packagePlan(null, 'shadow')
    const completed = { ...strict.job, status: 'completed' as const }
    const base = await callbacks(
      {
        resolveWritePosture: vi.fn(async () => 'shadow'),
        inspectOperationRows: vi.fn(async () => 'all_completed_congruent'),
        lockJob: vi.fn(async () => completed),
      },
      strict,
    )

    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'completed', response: COMPLETED_RESPONSE,
    })
    expect(base.hooks.loadCompletedResponse).toHaveBeenCalledOnce()
    expect(base.hooks.loadPlan).not.toHaveBeenCalled()
    expect(base.hooks.claimOperationRows).not.toHaveBeenCalled()
    expect(base.hooks.executeVerifiedPlan).not.toHaveBeenCalled()
  })

  it('rejects a strict completed job paired with all-new rows before replay or plan access', async () => {
    const strict = packagePlan(null, 'shadow')
    const completed = { ...strict.job, status: 'completed' as const }
    const base = await callbacks(
      {
        resolveWritePosture: vi.fn(async () => 'shadow'),
        inspectOperationRows: vi.fn(async () => 'all_new'),
        lockJob: vi.fn(async () => completed),
      },
      strict,
    )

    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'not_found',
    })
    expect(base.hooks.loadCompletedResponse).not.toHaveBeenCalled()
    expect(base.hooks.loadPlan).not.toHaveBeenCalled()
    expect(base.hooks.claimOperationRows).not.toHaveBeenCalled()
    expect(base.hooks.executeVerifiedPlan).not.toHaveBeenCalled()
  })

  it('terminal-fails a queued strict registry conflict before plan access or claim', async () => {
    const strict = packagePlan(null, 'shadow')
    const base = await callbacks(
      {
        resolveWritePosture: vi.fn(async () => 'shadow'),
        inspectOperationRows: vi.fn(async () => 'conflict'),
      },
      strict,
    )

    await expect(createAttendanceLegacyPlanWorkerV1(base.hooks).process(JOB_ID)).resolves.toEqual({
      kind: 'failed', reason: 'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED',
    })
    expect(base.hooks.markPlanFailed).toHaveBeenCalledOnce()
    expect(base.hooks.loadPlan).not.toHaveBeenCalled()
    expect(base.hooks.claimOperationRows).not.toHaveBeenCalled()
    expect(base.hooks.executeVerifiedPlan).not.toHaveBeenCalled()
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
    expect(base.calls).toEqual([
      '00',
      'posture',
      'job-read',
      'auth',
      '10',
      'registry-read',
      'job',
      'auth',
      'plan',
      '11',
      'preconditions',
      'registry',
      'effect',
      'terminal',
    ])
    expect(base.hooks.storeCompletedResponseAndTerminalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: JOB_ID }),
      expect.objectContaining({ manifest: expect.any(Object) }),
      COMPLETED_RESPONSE,
      computeLegacyImportAsyncJobSummaryDigestV1(COMPLETED_RESPONSE),
    )
  })
})
