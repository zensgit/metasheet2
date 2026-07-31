import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_LEGACY_IMPORT_BATCH_SOURCES_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
  LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
  buildLegacyImportExecutionPlanPackageV1,
  computeLegacyImportChunkDigestV1,
  computeLegacyImportGroupStateFingerprintV1,
  computeLegacyImportPlanDigestV1,
  computeLegacyImportRecordPreconditionFingerprintV1,
  computeRawImportEvidenceDigestV1,
  legacyImportRecordWriteExpectsExistingRecordV1,
  parseLegacyImportAsyncJobSummaryV1,
  parseLegacyImportBatchPlanV1,
  parseLegacyImportExecutionPlanChunkBodyV1,
  parseLegacyImportExecutionPlanManifestV1,
  parseLegacyImportGroupEffectPlanV1,
  parseLegacyImportItemPlanV1,
  parseLegacyImportRecordWritePlanV1,
  parseRawImportEvidenceV1,
  reassembleLegacyImportPlanChunksV1,
  type LegacyImportExecutionPlanManifestV1,
  type LegacyImportGroupEffectPlanV1,
  type LegacyImportItemPlanV1,
  type LegacyImportRecordWritePlanV1,
  type RawImportEvidenceV1,
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
      'sourceOrdinalDigest' | 'rawEvidenceDigest' | 'chunkVectorDigest'
    >
  > = {},
): Omit<
  LegacyImportExecutionPlanManifestV1,
  'sourceOrdinalDigest' | 'rawEvidenceDigest' | 'chunkVectorDigest'
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
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
    },
    artifactCleanup: { kind: 'none' },
    ...overrides,
  }
}

function rawEvidence(
  sourceOrdinal: number,
  overrides: Partial<RawImportEvidenceV1> = {},
): RawImportEvidenceV1 {
  const firstInAt = sourceOrdinal === 0 ? '2026-07-30T01:00:00.000Z' : null
  return {
    schemaVersion: 1,
    sourceOrdinal,
    punches: firstInAt === null
      ? []
      : [{ direction: 'check_in', occurredAt: firstInAt }],
    fields: {
      userId: { present: true, value: 'user-a' },
      workDate: { present: true, value: '2026-07-30' },
      timezone: { present: true, value: 'Asia/Shanghai' },
      firstInAt: firstInAt === null
        ? { present: false, value: null }
        : { present: true, value: firstInAt },
      lastOutAt: { present: false, value: null },
      status: { present: false, value: null },
      isWorkday: { present: false, value: null },
    },
    metrics: {
      workMinutes: { present: false, value: null },
      lateMinutes: { present: false, value: null },
      earlyLeaveMinutes: { present: false, value: null },
    },
    provenance: {
      transport: 'rows',
      sourceRef: `attendance-import:${BATCH_ID}:${sourceOrdinal}`,
      artifactSha256: null,
      normalizedCsvSha256: null,
      convertedSheetName: null,
    },
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
      metadata: { chunkConfig: {}, itemsInsertStrategy: 'unnest' },
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
      rawEvidence: rawEvidence(0),
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
      rawEvidence: rawEvidence(1),
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
    timezone: 'Asia/Shanghai',
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

function ensureGroup(
  overrides: Partial<Extract<LegacyImportGroupEffectPlanV1, { kind: 'ensure_group' }>> = {},
): Extract<LegacyImportGroupEffectPlanV1, { kind: 'ensure_group' }> {
  return {
    kind: 'ensure_group',
    groupId: GROUP_ID,
    normalizedName: 'engineering',
    displayName: 'Engineering',
    code: null,
    timezone: 'Asia/Taipei',
    ruleSetId: null,
    groupExistedAtPrepare: false,
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
    expect(built.manifest.rawEvidenceDigest).toBe(
      computeRawImportEvidenceDigestV1(built.chunks[0].body.items),
    )
    const parsedBody = parseLegacyImportExecutionPlanChunkBodyV1(
      JSON.parse(JSON.stringify(built.chunks[0].body)),
    )
    expect(parsedBody.items[0]?.rawEvidence).toEqual(rawEvidence(0))
  })

  it('enforces exact raw-evidence keys, presence values, punch correspondence, and provenance', () => {
    const baseline = rawEvidence(0)
    expect(parseRawImportEvidenceV1(baseline)).toEqual(baseline)

    expect(() => parseRawImportEvidenceV1({ ...baseline, extra: true })).toThrowError(
      'W4C3A_RAW_IMPORT_EVIDENCE_INVALID',
    )
    expect(() =>
      parseRawImportEvidenceV1({
        ...baseline,
        fields: {
          ...baseline.fields,
          status: { present: false, value: 'normal' },
        },
      }),
    ).toThrowError('W4C3A_RAW_IMPORT_EVIDENCE_INVALID')
    expect(() =>
      parseRawImportEvidenceV1({
        ...baseline,
        punches: [{ direction: 'check_out', occurredAt: '2026-07-30T01:00:00.000Z' }],
      }),
    ).toThrowError('W4C3A_RAW_IMPORT_EVIDENCE_INVALID')
    expect(() =>
      parseRawImportEvidenceV1({
        ...baseline,
        provenance: {
          ...baseline.provenance,
          transport: 'csv_text',
        },
      }),
    ).toThrowError('W4C3A_RAW_IMPORT_EVIDENCE_INVALID')
  })

  it('binds raw evidence ordinal, exact-presence metrics, and transport into digests', () => {
    const baseline = buildValid()
    const changedMetricItems = items({
      rawEvidence: rawEvidence(0, {
        metrics: {
          workMinutes: { present: true, value: 0 },
          lateMinutes: { present: false, value: null },
          earlyLeaveMinutes: { present: false, value: null },
        },
      }),
    })
    const changedMetric = buildLegacyImportExecutionPlanPackageV1({
      manifestSeed: manifestSeed(),
      items: changedMetricItems,
      recordWrites: [recordWrite()],
      groupEffects: [],
      groupEffectPlacements: [],
    })
    const changedTransportItems = items({
      rawEvidence: rawEvidence(0, {
        provenance: {
          transport: 'integration_sync',
          sourceRef: 'integration:batch-a:item-0',
          artifactSha256: null,
          normalizedCsvSha256: null,
          convertedSheetName: null,
        },
      }),
    })
    const changedTransport = buildLegacyImportExecutionPlanPackageV1({
      manifestSeed: manifestSeed(),
      items: changedTransportItems,
      recordWrites: [recordWrite()],
      groupEffects: [],
      groupEffectPlacements: [],
    })

    expect(changedMetric.manifest.rawEvidenceDigest).not.toBe(
      baseline.manifest.rawEvidenceDigest,
    )
    expect(changedMetric.chunks[0].chunkDigest).not.toBe(
      baseline.chunks[0].chunkDigest,
    )
    expect(changedMetric.planDigest).not.toBe(baseline.planDigest)
    expect(changedTransport.manifest.rawEvidenceDigest).not.toBe(
      baseline.manifest.rawEvidenceDigest,
    )
    expect(changedTransport.planDigest).not.toBe(baseline.planDigest)

    expect(() =>
      buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed(),
        items: items({ rawEvidence: rawEvidence(1) }),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      }),
    ).toThrowError('W4C3A_PLAN_PACKAGE_INVALID')

    const mutatedBody = parseLegacyImportExecutionPlanChunkBodyV1({
      ...baseline.chunks[0].body,
      items: baseline.chunks[0].body.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              rawEvidence: { ...item.rawEvidence, sourceOrdinal: 1 },
            }
          : item,
      ),
    })
    expect(() =>
      reassembleLegacyImportPlanChunksV1(
        [{
          ...baseline.chunks[0],
          body: mutatedBody,
          chunkDigest: computeLegacyImportChunkDigestV1(mutatedBody),
        }],
        baseline.manifest.sourceRowCount,
      ),
    ).toThrowError('W4C3A_CHUNK_REASSEMBLY_INVALID')
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
    expect(computeLegacyImportRecordPreconditionFingerprintV1(missing)).toBe(
      LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
    )
    expect(
      legacyImportRecordWriteExpectsExistingRecordV1(
        recordWrite({
          existingRecordPreconditionFingerprint:
            LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
        }),
      ),
    ).toBe(false)
    expect(
      legacyImportRecordWriteExpectsExistingRecordV1(
        recordWrite({
          existingRecordPreconditionFingerprint:
            computeLegacyImportRecordPreconditionFingerprintV1({
              exists: true,
              id: RECORD_1,
              orgId: 'org-a',
              userId: 'user-a',
              workDate: '2026-07-30',
              firstInAt: '2026-07-30T01:00:00.000Z',
              lastOutAt: '2026-07-30T09:00:00.000Z',
              workMinutes: 480,
              lateMinutes: 0,
              earlyLeaveMinutes: 0,
              status: 'normal',
              isWorkday: true,
              meta: {},
              sourceBatchId: BATCH_ID,
            }),
        }),
      ),
    ).toBe(true)
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
        displayName: 'Group A',
        code: null,
        timezone: 'UTC',
        ruleSetId: null,
        groupExistedAtPrepare: false,
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
    const first: LegacyImportGroupEffectPlanV1 = ensureGroup()
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

  it('builds and validates two ordered apply items folded into one record write', () => {
    const targetRef = '["org-a","user-a","2026-07-30"]'
    const foldedItems: readonly LegacyImportItemPlanV1[] = [
      {
        kind: 'apply',
        ordinal: 0,
        semanticOrdinal: 0,
        itemId: ITEM_1,
        targetRef,
        previewSnapshot: { source: 'first' },
        recordWriteRef: RECORD_1,
        rawEvidence: rawEvidence(0),
      },
      {
        kind: 'apply',
        ordinal: 1,
        semanticOrdinal: 1,
        itemId: ITEM_2,
        targetRef,
        previewSnapshot: { source: 'second' },
        recordWriteRef: RECORD_1,
        rawEvidence: rawEvidence(1, {
          punches: [{ direction: 'check_out', occurredAt: '2026-07-30T09:00:00.000Z' }],
          fields: {
            ...rawEvidence(1).fields,
            lastOutAt: { present: true, value: '2026-07-30T09:00:00.000Z' },
          },
        }),
      },
    ]
    const built = buildLegacyImportExecutionPlanPackageV1({
      manifestSeed: manifestSeed({
        w4ItemCount: 2,
        w4DistinctTargetCount: 1,
      }),
      items: foldedItems,
      recordWrites: [recordWrite({ sourceOrdinals: [0, 1] })],
      groupEffects: [],
      groupEffectPlacements: [],
    })
    const reassembled = reassembleLegacyImportPlanChunksV1(
      built.chunks,
      built.manifest.sourceRowCount,
    )

    expect(reassembled.items.map((item) => item.semanticOrdinal)).toEqual([0, 1])
    expect(reassembled.recordWrites).toHaveLength(1)
    expect(reassembled.recordWrites[0]?.sourceOrdinals).toEqual([0, 1])
    expect(
      reassembled.items.every(
        (item) => item.kind === 'apply' && item.recordWriteRef === RECORD_1,
      ),
    ).toBe(true)
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
        rawEvidence: rawEvidence(1),
      },
    ]
    const seed = manifestSeed({
      w4ItemCount: 2,
      w4DistinctTargetCount: 2,
      groupRevision: 1,
      groupStateFingerprint: HEX_A,
    })
    const groupEffect: LegacyImportGroupEffectPlanV1 = ensureGroup()
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

  it('rejects replay plans without frozen summary strategy inputs', () => {
    const replay = replayManifestSeed().batch
    expect(() =>
      parseLegacyImportBatchPlanV1({
        ...replay,
        metadata: { itemsInsertStrategy: 'unnest' },
      }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
    expect(() =>
      parseLegacyImportBatchPlanV1({
        ...replay,
        metadata: { chunkConfig: {} },
      }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
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
            rawEvidence: rawEvidence(1),
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
      rawEvidenceDigest: _rawEvidenceDigest,
      chunkVectorDigest: _chunkDigest,
      ...enqueueManifestSeed
    } = {
      ...manifestWithoutJob,
      sourceOrdinalDigest: HEX_A,
      rawEvidenceDigest: HEX_C,
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
            rawEvidence: rawEvidence(0),
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
        rawEvidence: rawEvidence(0),
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
        rawEvidence: rawEvidence(1),
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
    const {
      sourceOrdinalDigest: _source,
      rawEvidenceDigest: _rawEvidence,
      chunkVectorDigest: _chunk,
      ...enqueueSeed
    } =
      {
        ...seedWithoutRuntimeFields,
        sourceOrdinalDigest: HEX_A,
        rawEvidenceDigest: HEX_C,
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
    const authorizationSql = calls.find((sqlText) =>
      sqlText.includes('FROM user_namespace_admissions'),
    )
    expect(authorizationSql).toContain("namespace = 'attendance'")
    expect(authorizationSql).toContain("ur.role_id LIKE 'attendance\\_%' ESCAPE '\\'")
    expect(authorizationSql).toContain("'attendance:import'")
    expect(authorizationSql).toContain("'attendance:admin'")
    expect(authorizationSql).toContain("'attendance:*'")
    expect(authorizationSql).toContain("'*:*'")
    expect(authorizationSql).toContain("COALESCE(permissions, '[]'::jsonb)")
    expect(calls.indexOf(authorizationSql as string)).toBeLessThan(firstInsert)
    expect(
      calls.findIndex((sqlText) =>
        sqlText.includes('FROM attendance_calculation_rollout_state'),
      ),
    ).toBeLessThan(firstInsert)
    expect(
      calls.findIndex((sqlText) =>
        sqlText.includes("'attendance.w4c3a_enqueue_job_id'"),
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

  describe('OD-W4C-57=(a) byte-parity field correction', () => {
    const normalBatchBase = {
      kind: 'normal' as const,
      ruleSetId: null,
      mappingSnapshot: {},
      sourceRowCount: 2,
      status: 'committed',
      idempotencyKey: 'idem-a',
      visibilityRule: 'org',
      engine: 'standard' as const,
      chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 },
      recordUpsertStrategy: 'unnest' as const,
      itemsInsertStrategy: 'unnest' as const,
      mappingProfileId: null,
      compatibilityMetadata: {},
      groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
    }

    it('accepts null and every closed non-null batch source as distinct digest inputs', () => {
      const sources = [null, ...ATTENDANCE_LEGACY_IMPORT_BATCH_SOURCES_V1] as const
      const digests = new Set<string>()
      for (const source of sources) {
        const batch = parseLegacyImportBatchPlanV1({ ...normalBatchBase, source })
        expect(batch).toMatchObject({ kind: 'normal', source })
        digests.add(sha256HexOfCanonicalJsonV1(batch))
      }
      expect(digests.size).toBe(sources.length)
    })

    it('rejects empty-string null surrogates and out-of-union batch sources', () => {
      expect(() =>
        parseLegacyImportBatchPlanV1({ ...normalBatchBase, source: '' }),
      ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
      expect(() =>
        parseLegacyImportBatchPlanV1({ ...normalBatchBase, source: 'other' }),
      ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
      expect(() =>
        parseLegacyImportBatchPlanV1({ ...normalBatchBase, source: 'Dingtalk' }),
      ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
    })

    it('binds batch source substitution into the logical plan digest', () => {
      const nullSource = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          batch: { ...manifestSeed().batch, kind: 'normal', source: null },
        }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      })
      const manualSource = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          batch: { ...manifestSeed().batch, kind: 'normal', source: 'manual' },
        }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      })
      const csvSource = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          batch: { ...manifestSeed().batch, kind: 'normal', source: 'csv' },
        }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [],
        groupEffectPlacements: [],
      })
      expect(nullSource.planDigest).not.toBe(manualSource.planDigest)
      expect(manualSource.planDigest).not.toBe(csvSource.planDigest)
      expect(nullSource.manifest.batch).toMatchObject({ kind: 'normal', source: null })
    })

    it('requires non-empty record timezone for both values and unnest strategies', () => {
      for (const strategy of ['values', 'unnest'] as const) {
        const built = buildLegacyImportExecutionPlanPackageV1({
          manifestSeed: manifestSeed({
            batch: {
              ...manifestSeed().batch,
              kind: 'normal',
              recordUpsertStrategy: strategy,
            },
          }),
          items: items(),
          recordWrites: [recordWrite({ timezone: 'Asia/Shanghai' })],
          groupEffects: [],
          groupEffectPlacements: [],
        })
        expect(built.chunks[0].body.recordWrites[0].timezone).toBe('Asia/Shanghai')
        expect(built.planDigest).toMatch(/^[0-9a-f]{64}$/)
      }
    })

    it('rejects timezone omission, empty, null, extra keys, and opaque-leaf substitution', () => {
      const base = recordWrite()
      const { timezone: _timezone, ...withoutTimezone } = base
      expect(() => parseLegacyImportRecordWritePlanV1(withoutTimezone)).toThrowError(
        'W4C3A_RECORD_WRITE_PLAN_INVALID',
      )
      expect(() =>
        parseLegacyImportRecordWritePlanV1({ ...base, timezone: '' }),
      ).toThrowError('W4C3A_RECORD_WRITE_PLAN_INVALID')
      expect(() =>
        parseLegacyImportRecordWritePlanV1({ ...base, timezone: null }),
      ).toThrowError('W4C3A_RECORD_WRITE_PLAN_INVALID')
      expect(() =>
        parseLegacyImportRecordWritePlanV1({ ...base, extra: true }),
      ).toThrowError('W4C3A_RECORD_WRITE_PLAN_INVALID')
      // Neighboring opaque leaf cannot host timezone as a control input.
      expect(() =>
        parseLegacyImportRecordWritePlanV1({
          ...withoutTimezone,
          compatibilityMetadata: { timezone: 'Asia/Shanghai' },
        }),
      ).toThrowError('W4C3A_RECORD_WRITE_PLAN_INVALID')
    })

    it('changes chunk and plan digests when the frozen record timezone is substituted', () => {
      const shanghai = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed(),
        items: items(),
        recordWrites: [recordWrite({ timezone: 'Asia/Shanghai' })],
        groupEffects: [],
        groupEffectPlacements: [],
      })
      const tokyo = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed(),
        items: items(),
        recordWrites: [recordWrite({ timezone: 'Asia/Tokyo' })],
        groupEffects: [],
        groupEffectPlacements: [],
      })
      expect(shanghai.planDigest).not.toBe(tokyo.planDigest)
      expect(shanghai.chunks[0].chunkDigest).not.toBe(tokyo.chunks[0].chunkDigest)
      expect(
        computeLegacyImportChunkDigestV1(shanghai.chunks[0].body),
      ).not.toBe(computeLegacyImportChunkDigestV1(tokyo.chunks[0].body))
    })

    it('freezes mixed-case displayName separately from normalizedName', () => {
      const group = parseLegacyImportGroupEffectPlanV1(
        ensureGroup({
          normalizedName: 'engineering',
          displayName: 'Engineering',
        }),
      )
      expect(group).toMatchObject({
        kind: 'ensure_group',
        normalizedName: 'engineering',
        displayName: 'Engineering',
      })
      expect(group.kind === 'ensure_group' && group.displayName).not.toBe(
        group.kind === 'ensure_group' && group.normalizedName,
      )
    })

    it('rejects displayName faults, numeric-only names, and normalizedName substitution digests', () => {
      // Case mismatch: displayName.toLowerCase() must equal normalizedName.
      expect(() =>
        parseLegacyImportGroupEffectPlanV1(
          ensureGroup({
            normalizedName: 'engineering',
            displayName: 'Sales',
          }),
        ),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')

      // Leading/trailing whitespace is rejected (trim equality).
      expect(() =>
        parseLegacyImportGroupEffectPlanV1(
          ensureGroup({
            normalizedName: 'engineering',
            displayName: ' Engineering',
          }),
        ),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')

      // Numeric-only display names are rejected exactly as the retained collector.
      expect(() =>
        parseLegacyImportGroupEffectPlanV1(
          ensureGroup({
            normalizedName: '1',
            displayName: '1',
          }),
        ),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
      expect(() =>
        parseLegacyImportGroupEffectPlanV1(
          ensureGroup({
            normalizedName: '42',
            displayName: '42',
          }),
        ),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')

      // Lowercase displayName is legal when it already equals normalizedName,
      // but substituting a mixed-case frozen displayName with normalizedName
      // changes the plan digest (distinct digest inputs; not a silent rewrite).
      const mixed = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          groupRevision: 1,
          groupStateFingerprint: HEX_A,
        }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [
          ensureGroup({
            normalizedName: 'engineering',
            displayName: 'Engineering',
          }),
        ],
        groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 0 }],
      })
      const replacedWithNormalized = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          groupRevision: 1,
          groupStateFingerprint: HEX_A,
        }),
        items: items(),
        recordWrites: [recordWrite()],
        groupEffects: [
          ensureGroup({
            normalizedName: 'engineering',
            displayName: 'engineering',
          }),
        ],
        groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 0 }],
      })
      expect(replacedWithNormalized.planDigest).not.toBe(mixed.planDigest)
      expect(replacedWithNormalized.chunks[0].chunkDigest).not.toBe(
        mixed.chunks[0].chunkDigest,
      )

      const base = ensureGroup()
      const { displayName: _displayName, ...withoutDisplayName } = base
      expect(() =>
        parseLegacyImportGroupEffectPlanV1(withoutDisplayName),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
      expect(() =>
        parseLegacyImportGroupEffectPlanV1({ ...base, displayName: null }),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
      expect(() =>
        parseLegacyImportGroupEffectPlanV1({ ...base, displayName: '' }),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
      expect(() =>
        parseLegacyImportGroupEffectPlanV1({ ...base, extra: true }),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
      // Opaque-leaf substitution cannot stand in for the required field.
      expect(() =>
        parseLegacyImportGroupEffectPlanV1({
          ...withoutDisplayName,
          compatibilityMetadata: { displayName: 'Engineering' },
        }),
      ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
    })

    it('keeps the three fields as digest inputs across serialize/parse/replay', () => {
      const seed = manifestSeed({
        batch: { ...manifestSeed().batch, kind: 'normal', source: null },
        groupRevision: 1,
        groupStateFingerprint: HEX_A,
      })
      const built = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: seed,
        items: items(),
        recordWrites: [recordWrite({ timezone: 'Asia/Shanghai' })],
        groupEffects: [
          ensureGroup({
            normalizedName: 'engineering',
            displayName: 'Engineering',
          }),
        ],
        groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 0 }],
      })

      const serializedManifest = JSON.parse(JSON.stringify(built.manifest))
      const serializedChunk = JSON.parse(
        JSON.stringify({
          items: built.chunks[0].body.items,
          recordWrites: built.chunks[0].body.recordWrites,
          groupEffects: built.chunks[0].body.groupEffects,
        }),
      )
      const replayedManifest = parseLegacyImportExecutionPlanManifestV1(serializedManifest)
      const replayedBody = parseLegacyImportExecutionPlanChunkBodyV1(serializedChunk)
      const reassembled = reassembleLegacyImportPlanChunksV1(
        [
          {
            chunkIndex: 0,
            firstSourceOrdinal: 0,
            sourceRowCount: built.chunks[0].sourceRowCount,
            chunkDigest: built.chunks[0].chunkDigest,
            body: replayedBody,
          },
        ],
        replayedManifest.sourceRowCount,
      )
      const replayDigest = computeLegacyImportPlanDigestV1({
        manifest: replayedManifest,
        items: reassembled.items,
        recordWrites: reassembled.recordWrites,
        groupEffects: reassembled.groupEffects,
      })

      expect(replayedManifest.batch).toMatchObject({ kind: 'normal', source: null })
      expect(reassembled.recordWrites[0].timezone).toBe('Asia/Shanghai')
      expect(reassembled.groupEffects[0]).toMatchObject({
        kind: 'ensure_group',
        normalizedName: 'engineering',
        displayName: 'Engineering',
      })
      expect(replayDigest).toBe(built.planDigest)
      expect(computeLegacyImportChunkDigestV1(replayedBody)).toBe(
        built.chunks[0].chunkDigest,
      )

      // Independent substitutions of each field diverge the digest (neighboring
      // guards neutralized: full valid plan shape is held constant).
      const sourceMutated = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: manifestSeed({
          batch: { ...seed.batch, kind: 'normal', source: 'manual' },
          groupRevision: 1,
          groupStateFingerprint: HEX_A,
        }),
        items: items(),
        recordWrites: [recordWrite({ timezone: 'Asia/Shanghai' })],
        groupEffects: [
          ensureGroup({
            normalizedName: 'engineering',
            displayName: 'Engineering',
          }),
        ],
        groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 0 }],
      })
      const timezoneMutated = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: seed,
        items: items(),
        recordWrites: [recordWrite({ timezone: 'UTC' })],
        groupEffects: [
          ensureGroup({
            normalizedName: 'engineering',
            displayName: 'Engineering',
          }),
        ],
        groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 0 }],
      })
      const displayMutated = buildLegacyImportExecutionPlanPackageV1({
        manifestSeed: seed,
        items: items(),
        recordWrites: [recordWrite({ timezone: 'Asia/Shanghai' })],
        groupEffects: [
          ensureGroup({
            normalizedName: 'engineering',
            displayName: 'ENGINEERING',
          }),
        ],
        groupEffectPlacements: [{ effectId: GROUP_ID, firstSourceOrdinal: 0 }],
      })
      expect(sourceMutated.planDigest).not.toBe(built.planDigest)
      expect(timezoneMutated.planDigest).not.toBe(built.planDigest)
      expect(displayMutated.planDigest).not.toBe(built.planDigest)
    })
  })
})
