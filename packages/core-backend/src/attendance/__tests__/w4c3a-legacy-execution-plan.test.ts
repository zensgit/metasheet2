import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
  buildLegacyImportExecutionPlanPackageV1,
  computeLegacyImportGroupStateFingerprintV1,
  computeLegacyImportRecordPreconditionFingerprintV1,
  parseLegacyImportAsyncJobSummaryV1,
  parseLegacyImportExecutionPlanManifestV1,
  parseLegacyImportGroupEffectPlanV1,
  parseLegacyImportItemPlanV1,
  parseLegacyImportRecordWritePlanV1,
  type LegacyImportExecutionPlanManifestV1,
  type LegacyImportGroupEffectPlanV1,
  type LegacyImportItemPlanV1,
  type LegacyImportRecordWritePlanV1,
  sha256HexOfCanonicalJsonV1,
} from '../w4c3a-legacy-execution-plan'
import {
  reserveAttendanceLegacyImportPlanJobV1,
} from '../w4c3a-legacy-plan-enqueue'
import {
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
} from '../w4c0-identity'
import { createAuthorizedAttendanceWriteContextV1 } from '../w4c0-authorization'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_C = 'c'.repeat(64)
const HEX_D = 'd'.repeat(64)
const HEX_E = 'e'.repeat(64)
const JOB_ID = '10000000-0000-4000-8000-000000000001'
const BATCH_ID = '10000000-0000-4000-8000-000000000002'
const ITEM_1 = '10000000-0000-4000-8000-000000000003'
const ITEM_2 = '10000000-0000-4000-8000-000000000004'
const RECORD_1 = '10000000-0000-4000-8000-000000000005'
const RECORD_2 = '10000000-0000-4000-8000-000000000006'
const GROUP_ID = '10000000-0000-4000-8000-000000000007'
const ORG_ID = '20000000-0000-4000-8000-000000000001'

function manifestSeed(
  overrides: Partial<
    Omit<
      LegacyImportExecutionPlanManifestV1,
      'sourceOrdinalDigest' | 'chunkVectorDigest'
    >
  > = {},
): Omit<
  LegacyImportExecutionPlanManifestV1,
  'sourceOrdinalDigest' | 'chunkVectorDigest'
> {
  return {
    schemaVersion: 1,
    orgId: 'org-a',
    jobId: JOB_ID,
    batchId: BATCH_ID,
    sourceKind: 'import_batch',
    sourceRef: 'attendance-import',
    createdBy: 'admin-a',
    actorId: 'admin-a',
    actorPosture: 'platform_admin',
    tokenSubjectUserId: 'admin-a',
    acceptedWritePosture: 'legacy_projection_only',
    identityProofVectorDigest: HEX_A,
    commandFingerprint: HEX_B,
    legacyInputFingerprint: HEX_C,
    operationalBranch: 'strict_targeted',
    legacyRowSourceKind: 'direct_rows',
    sourceRowCount: 2,
    w4ItemCount: 1,
    w4DistinctTargetCount: 1,
    w4ItemSequenceFingerprint: HEX_D,
    w4ItemSetFingerprint: HEX_E,
    legacySourceRowLimit: null,
    groupRevision: null,
    groupStateFingerprint: null,
    batch: {
      kind: 'normal',
      source: 'manual',
      ruleSetId: null,
      mappingSnapshot: {},
      sourceRowCount: 2,
      status: 'committed',
      idempotencyKey: 'idem-a',
      visibilityRule: 'org',
      engine: 'standard',
      chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 },
      recordUpsertStrategy: 'unnest',
      itemsInsertStrategy: 'unnest',
      mappingProfileId: null,
      compatibilityMetadata: {},
      groupSync: null,
      itemReturnPolicy: { returnItems: false },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {},
    },
    artifactCleanup: { kind: 'none' },
    ...overrides,
  }
}

function replayManifestSeed(): ReturnType<typeof manifestSeed> {
  return {
    ...manifestSeed(),
    operationalBranch: 'operational_only_idempotent_replay',
    sourceRowCount: 0,
    w4ItemCount: 0,
    w4DistinctTargetCount: 0,
    w4ItemSequenceFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
    w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
    batch: {
      kind: 'idempotent_replay',
      replayBatchId: BATCH_ID,
      replaySelector: 'locked_race',
      replayPreconditionDigest: HEX_A,
      importedCount: 1,
      skippedCount: 0,
      totalRowCount: 1,
      engine: 'standard',
      recordUpsertStrategy: 'unnest',
      metadata: {},
      idempotencyKey: 'idem-a',
      requesterVisibility: { kind: 'org' },
    },
  }
}

function items(
  applyOverrides: Partial<Extract<LegacyImportItemPlanV1, { kind: 'apply' }>> = {},
): readonly LegacyImportItemPlanV1[] {
  return [
    {
      kind: 'apply',
      ordinal: 0,
      semanticOrdinal: 0,
      itemId: ITEM_1,
      targetRef: '["org-a","user-a","2026-07-30"]',
      previewSnapshot: { status: 'normal' },
      recordWriteRef: RECORD_1,
      ...applyOverrides,
    },
    {
      kind: 'skip',
      ordinal: 1,
      semanticOrdinal: null,
      itemId: ITEM_2,
      resolvedUserId: null,
      resolvedWorkDate: null,
      reasonCode: 'validation',
      warnings: ['Missing workDate'],
      previewSnapshot: { reason: 'validation' },
    },
  ]
}

function recordWrite(
  overrides: Partial<LegacyImportRecordWritePlanV1> = {},
): LegacyImportRecordWritePlanV1 {
  return {
    recordWriteId: RECORD_1,
    orgId: 'org-a',
    userId: 'user-a',
    workDate: '2026-07-30',
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: '2026-07-30T01:00:00.000Z',
    lastOutAt: '2026-07-30T09:00:00.000Z',
    workMinutes: 480,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    status: 'normal',
    isWorkday: true,
    targetRevision: 0,
    existingRecordPreconditionFingerprint: HEX_A,
    expectedSourceOwnership: null,
    recordId: RECORD_1,
    compatibilityMetadata: {},
    policySnapshot: {},
    profileSnapshot: {},
    multiPunchSnapshot: {},
    attributionSnapshot: {},
    sourceBatchId: BATCH_ID,
    resultSlots: {},
    ...overrides,
  }
}

function buildValid() {
  return buildLegacyImportExecutionPlanPackageV1({
    manifestSeed: manifestSeed(),
    items: items(),
    recordWrites: [recordWrite()],
    groupEffects: [],
    groupEffectPlacements: [],
  })
}

describe('LegacyImportExecutionPlanV1', () => {
  it('builds a frozen null-prototype plan with dense source and semantic ordinals', () => {
    const built = buildValid()
    expect(Object.getPrototypeOf(built.manifest)).toBeNull()
    expect(Object.isFrozen(built.manifest)).toBe(true)
    expect(built.chunks).toHaveLength(1)
    expect(built.chunks[0].body.items.map((item) => item.ordinal)).toEqual([0, 1])
  })

  it('rejects extra manifest keys and an opaque array above the encoded-byte limit', () => {
    const built = buildValid()
    expect(() =>
      parseLegacyImportExecutionPlanManifestV1({
        ...built.manifest,
        extra: true,
      }),
    ).toThrowError('W4C3A_MANIFEST_INVALID')

    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          batch: {
            ...manifestSeed().batch,
            kind: 'normal',
            mappingSnapshot: Array.from({ length: 5 }, () => 'x'.repeat(16 * 1024)),
          },
        }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
  })

  it('closes merge mode and bounds the complete warnings array', () => {
    expect(() =>
      parseLegacyImportRecordWritePlanV1({
        ...recordWrite(),
        mergeMode: 'append',
      }),
    ).toThrowError('W4C3A_RECORD_WRITE_PLAN_INVALID')

    expect(() =>
      parseLegacyImportItemPlanV1({
        ...items()[1],
        warnings: Array.from({ length: 1025 }, () => null),
      }),
    ).toThrowError('W4C3A_ITEM_PLAN_INVALID')
  })

  it('accepts independently optional positive skipped count and non-empty skipped sample', () => {
    const base = {
      __jobType: 'commit',
      idempotencyKey: 'idem-a',
      __importEngine: 'standard',
      recordUpsertStrategy: 'unnest',
      itemsInsertStrategy: 'unnest',
      summary: {
        processedRows: 2,
        failedRows: 0,
        elapsedMs: 10,
        chunkConfig: {},
      },
    } as const

    expect(
      parseLegacyImportAsyncJobSummaryV1({
        ...base,
        summary: { ...base.summary, skippedCount: 1 },
      }).summary,
    ).toMatchObject({ skippedCount: 1 })
    expect(
      parseLegacyImportAsyncJobSummaryV1({
        ...base,
        summary: { ...base.summary, skippedRows: [{ row: 2 }] },
      }).summary,
    ).toMatchObject({ skippedRows: [{ row: 2 }] })
  })

  it('binds the exact record precondition read set and rejects partial missing rows', () => {
    const missing = {
      exists: false,
      id: null,
      orgId: null,
      userId: null,
      workDate: null,
      firstInAt: null,
      lastOutAt: null,
      workMinutes: null,
      lateMinutes: null,
      earlyLeaveMinutes: null,
      status: null,
      isWorkday: null,
      meta: null,
      sourceBatchId: null,
    }
    expect(computeLegacyImportRecordPreconditionFingerprintV1(missing)).toMatch(
      /^[0-9a-f]{64}$/,
    )
    expect(() =>
      computeLegacyImportRecordPreconditionFingerprintV1({
        ...missing,
        userId: 'user-a',
      }),
    ).toThrowError('W4C3A_RECORD_PRECONDITION_INVALID')
    expect(() =>
      computeLegacyImportRecordPreconditionFingerprintV1({
        ...missing,
        extra: true,
      }),
    ).toThrowError('W4C3A_RECORD_PRECONDITION_INVALID')
  })

  it('normalizes group intent keys and makes group-state fingerprints order independent', () => {
    expect(() =>
      parseLegacyImportGroupEffectPlanV1({
        kind: 'ensure_group',
        groupId: GROUP_ID,
        normalizedName: ' Group A ',
        code: null,
        timezone: 'UTC',
        ruleSetId: null,
      }),
    ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')

    const group = {
      id: GROUP_ID,
      orgId: 'org-a',
      name: 'Group A',
      code: null,
      timezone: 'UTC',
      ruleSetId: null,
    }
    const memberA = {
      orgId: 'org-a',
      groupId: GROUP_ID,
      userId: 'user-a',
      exists: false,
    }
    const memberB = {
      orgId: 'org-a',
      groupId: GROUP_ID,
      userId: 'user-b',
      exists: true,
    }
    expect(
      computeLegacyImportGroupStateFingerprintV1({
        groups: [group],
        memberships: [memberA, memberB],
      }),
    ).toBe(
      computeLegacyImportGroupStateFingerprintV1({
        groups: [group],
        memberships: [memberB, memberA],
      }),
    )
  })

  it('rejects duplicate semantic group definitions even when effect IDs differ', () => {
    const seed = manifestSeed({
      groupRevision: 1,
      groupStateFingerprint: HEX_A,
    })
    const first: LegacyImportGroupEffectPlanV1 = {
      kind: 'ensure_group',
      groupId: GROUP_ID,
      normalizedName: 'engineering',
      code: null,
      timezone: 'Asia/Taipei',
      ruleSetId: null,
    }
    const second: LegacyImportGroupEffectPlanV1 = {
      ...first,
      groupId: '10000000-0000-4000-8000-000000000099',
    }
    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: seed,
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [first, second],
        groupEffectPlacements: [
          { effectId: first.groupId, firstSourceOrdinal: 0 },
          { effectId: second.groupId, firstSourceOrdinal: 1 },
        ],
      }),
    ).toThrowError('W4C3A_PLAN_PACKAGE_INVALID')
  })

  it('rejects a semantic ordinal gap independently of source ordinal density', () => {
    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed(),
        items: items({ semanticOrdinal: 1 }),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_PLAN_PACKAGE_INVALID')
  })

  it('permits a frozen source-row limit only for a selected CSV source', () => {
    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({ legacySourceRowLimit: 5000 }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_MANIFEST_INVALID')

    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          legacyRowSourceKind: 'inline_csv',
          legacySourceRowLimit: 5000,
        }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).not.toThrow()
  })

  it('canonicalizes record writes and group effects without guessing placement', () => {
    const secondRecord = recordWrite({
      recordWriteId: RECORD_2,
      recordId: RECORD_2,
      userId: 'user-b',
      sourceOrdinals: [1],
    })
    const twoApplyItems: readonly LegacyImportItemPlanV1[] = [
      items()[0],
      {
        kind: 'apply',
        ordinal: 1,
        semanticOrdinal: 1,
        itemId: ITEM_2,
        targetRef: '["org-a","user-b","2026-07-30"]',
        previewSnapshot: {},
        recordWriteRef: RECORD_2,
      },
    ]
    const seed = manifestSeed({
      w4ItemCount: 2,
      w4DistinctTargetCount: 2,
      groupRevision: 1,
      groupStateFingerprint: HEX_A,
    })
    const groupEffect: LegacyImportGroupEffectPlanV1 = {
      kind: 'ensure_group',
      groupId: GROUP_ID,
      normalizedName: 'engineering',
      code: null,
      timezone: 'Asia/Taipei',
      ruleSetId: null,
    }
    const forward = buildLegacyImportExecutionPlanPackageV1({
      manifestSeed: seed,
      items: twoApplyItems,
      recordWrites: [recordWrite(), secondRecord],
      groupEffects: [groupEffect],
      groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 1 }],
    })
    const reverse = buildLegacyImportExecutionPlanPackageV1({
      manifestSeed: seed,
      items: twoApplyItems,
      recordWrites: [secondRecord, recordWrite()],
      groupEffects: [groupEffect],
      groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 1 }],
    })
    expect(reverse.planDigest).toBe(forward.planDigest)

    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: seed,
        items: twoApplyItems,
        recordWrites: [recordWrite(), secondRecord],
        groupEffects: [groupEffect],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_CHUNKER_INVALID')
  })

  it('binds each apply item bidirectionally to the exact record target and batch', () => {
    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed(),
        items: items({ targetRef: '["org-a","other","2026-07-30"]' }),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_PLAN_PACKAGE_INVALID')

    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed(),
        items: items(),
        recordWrites: [
          recordWrite({
            sourceBatchId: '10000000-0000-4000-8000-000000000099',
          }),
        ],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_PLAN_PACKAGE_INVALID')

    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({ w4DistinctTargetCount: 0 }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_PLAN_PACKAGE_INVALID')
  })

  it('rejects locked-race replay without a selected source or with upload cleanup on a non-upload source', () => {
    const replayBase = replayManifestSeed()
    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: { ...replayBase, legacyRowSourceKind: null },
        items: [],
        recordWrites: [],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_MANIFEST_INVALID')

    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: {
          ...replayBase,
          legacyRowSourceKind: 'direct_rows',
          artifactCleanup: {
            kind: 'uploaded_import_file',
            fileId: GROUP_ID,
            expectedOwnerOrgId: 'org-a',
          },
        },
        items: [],
        recordWrites: [],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_MANIFEST_INVALID')
  })

  it('keeps P07 idempotent replay visibility fixed to full-import org scope', () => {
    const replay = replayManifestSeed()
    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: {
          ...replay,
          batch: {
            ...replay.batch,
            requesterVisibility: { kind: 'requester', userId: 'admin-a' },
          },
        } as never,
        items: [],
        recordWrites: [],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrow('W4C3A_BATCH_PLAN_INVALID')
  })

  it('rejects a malformed draft before the first SQL statement', async () => {
    let queries = 0
    const trx = {
      query: async () => {
        queries += 1
        return { rows: [] }
      },
    } as unknown as AttendanceW4TransactionClientV1
    await expect(
      reserveAttendanceLegacyImportPlanJobV1(trx, null, {
        batchIdentity: null,
        itemIdentities: [],
        job: {} as never,
        manifestSeed: {} as never,
        items: [
          {
            kind: 'skip',
            ordinal: 1,
            semanticOrdinal: null,
            resolvedUserId: null,
            resolvedWorkDate: null,
            reasonCode: 'validation',
            warnings: [],
            previewSnapshot: {},
          },
        ],
        recordWrites: [],
        groupEffects: [],
      }),
    ).rejects.toThrow()
    expect(queries).toBe(0)
  })

  it('requires SERIALIZABLE before authorization or persistence', async () => {
    const calls: string[] = []
    const trx = {
      async query(sqlText: string) {
        calls.push(sqlText)
        return { rows: [{ isolation: 'read committed' }] }
      },
    } as unknown as AttendanceW4TransactionClientV1
    const { jobId: _jobId, ...manifestWithoutJob } = manifestSeed({
      orgId: ORG_ID,
      operationalBranch: 'operational_only_no_target',
      sourceRowCount: 1,
      w4ItemCount: 0,
      w4DistinctTargetCount: 0,
      w4ItemSequenceFingerprint:
        ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
      w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
      identityProofVectorDigest: HEX_A,
      groupRevision: null,
      groupStateFingerprint: null,
      batch: {
        ...manifestSeed().batch,
        kind: 'normal',
        sourceRowCount: 1,
        idempotencyKey: null,
      },
    })
    const {
      identityProofVectorDigest: _proof,
      groupRevision: _groupRevision,
      groupStateFingerprint: _groupFingerprint,
      sourceOrdinalDigest: _sourceDigest,
      chunkVectorDigest: _chunkDigest,
      ...enqueueManifestSeed
    } = {
      ...manifestWithoutJob,
      sourceOrdinalDigest: HEX_A,
      chunkVectorDigest: HEX_B,
    }
    await expect(
      reserveAttendanceLegacyImportPlanJobV1(trx, null, {
        batchIdentity: null,
        itemIdentities: [],
        job: {
          orgId: ORG_ID,
          batchId: BATCH_ID,
          createdBy: 'admin-a',
          idempotencyKey: null,
          total: 1,
          payload: {
            __jobType: 'commit',
            idempotencyKey: null,
            __importEngine: 'standard',
            recordUpsertStrategy: 'unnest',
            itemsInsertStrategy: 'unnest',
            __w4ContractVersion: 1,
          },
          w4Entrypoint: 'import_batch',
          w4BatchCommandId: BATCH_ID,
          w4SourceKind: 'import_batch',
          w4SourceRef: 'attendance-import',
          w4ActorId: 'admin-a',
          w4ActorPosture: 'platform_admin',
          w4TokenSubjectUserId: 'admin-a',
          w4CommandFingerprint: HEX_B,
          w4AcceptedWritePosture: 'legacy_projection_only',
          w4ItemCount: 0,
          w4ItemSequenceFingerprint:
            ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
          w4ItemSetFingerprint:
            ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
          w4IdentityProofVector: [],
          w4DistinctTargetCount: 0,
          w4OperationalBranch: 'operational_only_no_target',
          w4LegacyInputFingerprint: HEX_C,
        },
        manifestSeed: enqueueManifestSeed,
        items: [
          {
            kind: 'skip',
            ordinal: 0,
            semanticOrdinal: null,
            resolvedUserId: null,
            resolvedWorkDate: null,
            reasonCode: 'validation',
            warnings: [],
            previewSnapshot: {},
          },
        ],
        recordWrites: [],
        groupEffects: [],
      }),
    ).rejects.toThrowError('W4C3A_ENQUEUE_SERIALIZABLE_REQUIRED')
    expect(calls).toHaveLength(1)
  })

  it('reserves a no-target plan only after current full-import and rollout rechecks', async () => {
    const calls: string[] = []
    const proofDigest = sha256HexOfCanonicalJsonV1([])
    const trx = {
      async query(sqlText: string) {
        calls.push(sqlText)
        if (sqlText.includes("current_setting('transaction_isolation')")) {
          return { rows: [{ isolation: 'serializable' }] }
        }
        if (sqlText.includes('FROM users WHERE id = $1')) return { rows: [{}] }
        if (sqlText.includes("WHERE EXISTS (\n         SELECT 1\n           FROM user_roles")) {
          return { rows: [{}] }
        }
        if (sqlText.includes('FROM attendance_calculation_rollout_state')) {
          return { rows: [] }
        }
        if (sqlText.includes('SELECT encode(')) {
          return { rows: [{ d: proofDigest }] }
        }
        return { rows: [] }
      },
    } as unknown as AttendanceW4TransactionClientV1
    const posture = await resolveSegmentCalculationPosture(
      {
        query: async () => ({ rows: [] }),
      },
      ORG_ID,
    )
    const org = createVerifiedAttendanceOrgIdentityV1({
      orgKey: ORG_ID,
      posture,
    })
    const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'batch',
      entrypoint: 'import_batch',
      source: { sourceKind: 'import_batch', batchCommandId: BATCH_ID },
    })
    const auth = createAuthorizedAttendanceWriteContextV1({
      actorId: 'admin-a',
      actorPosture: 'platform_admin',
      tokenSubjectUserId: 'admin-a',
      orgId: ORG_ID,
      subjectScope: { kind: 'self', userId: 'admin-a' },
      capability: 'import',
      sourceRef: 'attendance-import',
    })
    const skipItems: readonly LegacyImportItemPlanV1[] = [
      {
        kind: 'skip',
        ordinal: 0,
        semanticOrdinal: null,
        itemId: ITEM_1,
        resolvedUserId: null,
        resolvedWorkDate: null,
        reasonCode: 'validation',
        warnings: [],
        previewSnapshot: {},
      },
      {
        kind: 'skip',
        ordinal: 1,
        semanticOrdinal: null,
        itemId: ITEM_2,
        resolvedUserId: null,
        resolvedWorkDate: null,
        reasonCode: 'duplicate',
        warnings: [],
        previewSnapshot: {},
      },
    ]
    const seed = manifestSeed({
      orgId: ORG_ID,
      operationalBranch: 'operational_only_no_target',
      w4ItemCount: 0,
      w4DistinctTargetCount: 0,
      w4ItemSequenceFingerprint:
        ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
      w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
      identityProofVectorDigest: proofDigest,
      batch: {
        ...manifestSeed().batch,
        kind: 'normal',
        idempotencyKey: null,
      },
    })
    const {
      jobId: _jobId,
      identityProofVectorDigest: _proofDigest,
      groupRevision: _groupRevision,
      groupStateFingerprint: _groupStateFingerprint,
      ...seedWithoutRuntimeFields
    } = seed
    const { sourceOrdinalDigest: _source, chunkVectorDigest: _chunk, ...enqueueSeed } =
      {
        ...seedWithoutRuntimeFields,
        sourceOrdinalDigest: HEX_A,
        chunkVectorDigest: HEX_B,
      }

    const reserveInput = {
      batchIdentity,
      itemIdentities: [],
      job: {
        orgId: ORG_ID,
        batchId: BATCH_ID,
        createdBy: 'admin-a',
        idempotencyKey: null,
        total: 2,
        payload: {
          __jobType: 'commit',
          idempotencyKey: null,
          __importEngine: 'standard',
          recordUpsertStrategy: 'unnest',
          itemsInsertStrategy: 'unnest',
          __w4ContractVersion: 1,
        },
        w4Entrypoint: 'import_batch',
        w4BatchCommandId: BATCH_ID,
        w4SourceKind: 'import_batch',
        w4SourceRef: 'attendance-import',
        w4ActorId: 'admin-a',
        w4ActorPosture: 'platform_admin',
        w4TokenSubjectUserId: 'admin-a',
        w4CommandFingerprint: HEX_B,
        w4AcceptedWritePosture: 'legacy_projection_only',
        w4ItemCount: 0,
        w4ItemSequenceFingerprint:
          ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
        w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
        w4IdentityProofVector: [],
        w4DistinctTargetCount: 0,
        w4OperationalBranch: 'operational_only_no_target',
        w4LegacyInputFingerprint: HEX_C,
      },
      manifestSeed: enqueueSeed,
      items: skipItems.map(({ itemId: _itemId, ...item }) => item),
      recordWrites: [],
      groupEffects: [],
    } as const
    const realRandomUuid = crypto.randomUUID.bind(crypto)
    const mintSpy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      calls.push('MINT_EFFECT_ID')
      return realRandomUuid()
    })
    const result = await reserveAttendanceLegacyImportPlanJobV1(
      trx,
      auth,
      reserveInput,
    )
    mintSpy.mockRestore()
    expect(result).toMatchObject({ kind: 'created' })
    expect(result.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const firstInsert = calls.findIndex((sqlText) => sqlText.includes('INSERT INTO'))
    expect(firstInsert).toBeGreaterThan(-1)
    expect(
      calls.findIndex((sqlText) =>
        sqlText.includes("permission_code IN ('attendance:import', 'attendance:admin')"),
      ),
    ).toBeLessThan(firstInsert)
    expect(
      calls.findIndex((sqlText) =>
        sqlText.includes('FROM attendance_calculation_rollout_state'),
      ),
    ).toBeLessThan(firstInsert)
    expect(
      calls.filter((sqlText) => sqlText.includes('INSERT INTO attendance_import_')),
    ).toHaveLength(3)
    expect(calls.indexOf('MINT_EFFECT_ID')).toBeGreaterThan(
      calls.findIndex((sqlText) =>
        sqlText.includes('FROM attendance_import_jobs'),
      ),
    )

    const deniedCalls: string[] = []
    const deniedTrx = {
      async query(sqlText: string) {
        deniedCalls.push(sqlText)
        if (sqlText.includes("current_setting('transaction_isolation')")) {
          return { rows: [{ isolation: 'serializable' }] }
        }
        if (sqlText.includes('FROM users WHERE id = $1')) return { rows: [{}] }
        return { rows: [] }
      },
    } as unknown as AttendanceW4TransactionClientV1
    await expect(
      reserveAttendanceLegacyImportPlanJobV1(deniedTrx, auth, reserveInput),
    ).rejects.toThrowError('W4C3A_ENQUEUE_FULL_IMPORT_AUTHORIZATION_REJECTED')
    expect(deniedCalls.some((sqlText) => sqlText.includes('INSERT INTO'))).toBe(
      false,
    )
  })
})
