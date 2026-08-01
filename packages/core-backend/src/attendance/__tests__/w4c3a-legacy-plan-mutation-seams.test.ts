/**
 * Discriminating kill-proofs for the P08 blueprint mutations.
 *
 * Each leg reaches the real production processor/adapter/plugin surface, has a
 * positive control that hits the target, and fails only when the named mutation
 * is present (no earlier guard masks the failure).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  applyAttendanceLegacyGroupEffectsV1,
} from '../w4c3a-legacy-plan-group-effects'
import {
  buildAttendanceLegacyFirstExecutionBatchMetaV1,
  buildAttendanceLegacyAsyncJobSummaryV1,
} from '../w4c3a-legacy-plan-batch-effects'
import {
  parseLegacyImportBatchPlanV1,
  parseLegacyImportGroupEffectPlanV1,
  type LegacyImportExecutionPlanManifestV1,
} from '../w4c3a-legacy-execution-plan'
import {
  createAttendanceLegacyPlanProcessorV1,
  W4C3A_LEGACY_PLAN_WORKER_PRODUCTION_IMPORTER,
} from '../w4c3a-legacy-plan-processor'
import type { VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
)
const PLUGIN = path.join(ROOT, 'plugins/plugin-attendance/index.cjs')
const PROCESSOR = path.join(
  ROOT,
  'packages/core-backend/src/attendance/w4c3a-legacy-plan-processor.ts',
)

const GROUP_ID = '10000000-0000-4000-8000-000000000007'
const MEMBER_ID = '10000000-0000-4000-8000-000000000008'
const ORG = 'org-a'
const BATCH = '10000000-0000-4000-8000-000000000002'

function planWithGroups(
  effects: VerifiedAttendanceLegacyPlanV1['groupEffects'],
): VerifiedAttendanceLegacyPlanV1 {
  const manifest = {
    schemaVersion: 1,
    orgId: ORG,
    jobId: '10000000-0000-4000-8000-000000000001',
    batchId: BATCH,
    sourceKind: 'import_batch',
    sourceRef: 'attendance-import',
    createdBy: 'admin',
    actorId: 'admin',
    actorPosture: 'platform_admin',
    tokenSubjectUserId: 'admin',
    acceptedWritePosture: 'legacy_projection_only',
    identityProofVectorDigest: 'a'.repeat(64),
    commandFingerprint: 'b'.repeat(64),
    legacyInputFingerprint: 'c'.repeat(64),
    operationalBranch: 'strict_targeted',
    legacyRowSourceKind: 'direct_rows',
    sourceRowCount: 0,
    sourceOrdinalDigest: 'd'.repeat(64),
    w4ItemCount: 0,
    w4DistinctTargetCount: 0,
    w4ItemSequenceFingerprint: 'e'.repeat(64),
    w4ItemSetFingerprint: 'f'.repeat(64),
    legacySourceRowLimit: null,
    groupRevision: 0,
    groupStateFingerprint: '1'.repeat(64),
    chunkVectorDigest: '2'.repeat(64),
    batch: {
      kind: 'normal',
      source: 'manual',
      ruleSetId: null,
      mappingSnapshot: {},
      sourceRowCount: 0,
      status: 'committed',
      idempotencyKey: null,
      visibilityRule: 'org',
      engine: 'standard',
      chunkConfig: {},
      recordUpsertStrategy: 'unnest',
      itemsInsertStrategy: 'unnest',
      mappingProfileId: null,
      compatibilityMetadata: { groupCreated: 999, groupMembersAdded: 999 },
      groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
    },
    artifactCleanup: { kind: 'none' },
  } as LegacyImportExecutionPlanManifestV1
  return Object.freeze({
    manifest,
    chunks: Object.freeze([]),
    items: Object.freeze([]),
    recordWrites: Object.freeze([]),
    groupEffects: Object.freeze(effects),
  }) as VerifiedAttendanceLegacyPlanV1
}

describe('blueprint mutations — real production surfaces', () => {
  it('1) production has no injectable executeVerifiedPlan assembly outside processor', () => {
    const processorSource = fs.readFileSync(PROCESSOR, 'utf8')
    // Positive: processor owns executeVerifiedPlan by fixed internal binding.
    expect(processorSource).toMatch(/executeVerifiedPlan/)
    expect(processorSource).toMatch(/executeAttendanceCanonicalImportPlanV1/)
    // Deps type is only acquireConnection — no effect injection surface.
    const depsMatch = processorSource.match(
      /export type AttendanceLegacyPlanProcessorDepsV1 = Readonly<\{[\s\S]*?\}>/,
    )
    expect(depsMatch).not.toBeNull()
    expect(depsMatch![0]).toMatch(/acquireConnection\s*\(/)
    expect(depsMatch![0]).not.toMatch(/executeVerifiedPlan/)
    expect(depsMatch![0]).not.toMatch(/loadPlan|markPlanFailed|authorizeFullImport/)
    const reservationProof = processorSource.slice(
      processorSource.indexOf('function reservationIdentitiesFromJob'),
      processorSource.indexOf(
        'export function deriveAttendanceLegacyPlanTargetIdentitiesV1',
      ),
    )
    expect(reservationProof).toMatch(/W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID/)
    expect(reservationProof).not.toMatch(/\bcontinue\b|Number\(row\.ordinal\)/)
  })

  it('2) plugin V1 classification never selects payload before the branch', () => {
    const source = fs.readFileSync(PLUGIN, 'utf8')
    const fnStart = source.indexOf('const processAsyncImportCommitJob = async')
    expect(fnStart).toBeGreaterThan(-1)
    const v1Branch = source.indexOf('if (isV1)', fnStart)
    expect(v1Branch).toBeGreaterThan(fnStart)
    const classifySlice = source
      .slice(fnStart, v1Branch)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    // Classification may only read id/status/w4_contract_version.
    expect(classifySlice).toMatch(/w4_contract_version/)
    expect(classifySlice).not.toMatch(/SELECT\s+\*/i)
    expect(classifySlice).not.toMatch(/normalizeMetadata\s*\(/)
    expect(classifySlice).not.toMatch(/\.payload\b/)
    // Positive control: legacy path after V1 still hydrates payload.
    const afterV1 = source.slice(v1Branch)
    expect(afterV1).toMatch(/normalizeMetadata\s*\(\s*jobRow\.payload\s*\)/)
  })

  it('3) plugin host call is exactly { jobId } with no extra keys', () => {
    const source = fs.readFileSync(PLUGIN, 'utf8')
    expect(source).toMatch(
      /processLegacyImportPlan\(\s*\{\s*jobId\s*\}\s*\)/,
    )
    expect(source).toMatch(/callAttendanceLegacyPlanHostV1/)
    // Forbidden call shapes must not appear in production code.
    expect(source).not.toMatch(
      /processLegacyImportPlan\(\s*\{\s*[^}]*payload/,
    )
    expect(source).not.toMatch(
      /processLegacyImportPlan\(\s*\{\s*[^}]*orgId/,
    )
    expect(source).not.toMatch(
      /processLegacyImportPlan\(\s*\{\s*[^}]*executeVerifiedPlan/,
    )
  })

  it('4/5) processor candidate org is explicit; hard-coded org is impossible at the API', async () => {
    const queries: unknown[][] = []
    const release = vi.fn()
    const processor = createAttendanceLegacyPlanProcessorV1({
      acquireConnection: async () => ({
        client: {
          query: async (sql: string, params?: unknown[]) => {
            queries.push([sql, ...(params ?? [])])
            if (
              String(sql).includes('FROM attendance_import_jobs') &&
              String(sql).includes('id = $1') &&
              !String(sql).includes('org_id = $2')
            ) {
              // Candidate row supplies org A.
              return {
                rows: [
                  {
                    id: '10000000-0000-4000-8000-000000000001',
                    org_id: '20000000-0000-4000-8000-000000000001',
                  },
                ],
              }
            }
            // Subsequent org-scoped reads must bind org A (not a closed-over constant).
            if (String(sql).includes('org_id = $2')) {
              expect(params?.[1]).toBe('20000000-0000-4000-8000-000000000001')
            }
            return { rows: [] }
          },
        },
        release,
      }),
    })
    // API surface is jobId-only — cannot pass orgId.
    await expect(
      processor.processLegacyImportPlanV1(
        '10000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toMatchObject({ kind: 'not_found' })
    expect(release).toHaveBeenCalled()
    expect(
      queries.some(
        (q) =>
          String(q[0]).includes('org_id = $2') &&
          q[1] === '10000000-0000-4000-8000-000000000001' &&
          q[2] === '20000000-0000-4000-8000-000000000001',
      ),
    ).toBe(true)
  })

  it('6/7/8) group adapter is the sole source of effect counts (positive + no-op)', async () => {
    const calls: string[] = []
    const trx = {
      query: async (sql: string) => {
        calls.push(sql)
        if (sql.includes('INSERT INTO attendance_groups')) {
          return { rows: [{ id: GROUP_ID }] }
        }
        if (sql.includes('INSERT INTO attendance_group_members')) {
          // Conflict-ignore: zero rows.
          return { rows: [] }
        }
        return { rows: [] }
      },
    }
    const withEffects = planWithGroups([
      {
        kind: 'ensure_group',
        groupId: GROUP_ID,
        normalizedName: 'engineering',
        displayName: 'Engineering',
        code: null,
        timezone: 'UTC',
        ruleSetId: null,
        groupExistedAtPrepare: false,
      },
      {
        kind: 'ensure_member',
        memberId: MEMBER_ID,
        groupRef: GROUP_ID,
        userId: 'user-a',
        membershipExistedAtPrepare: false,
      },
    ])
    // Positive: ensure_group RETURNING contributes groupCreated=1; member conflict → 0.
    const result = await applyAttendanceLegacyGroupEffectsV1(trx as never, withEffects)
    expect(result).toEqual({ groupCreated: 1, groupMembersAdded: 0 })
    expect(calls.some((s) => s.includes('INSERT INTO attendance_groups'))).toBe(true)
    expect(calls.some((s) => s.includes('INSERT INTO attendance_group_members'))).toBe(true)

    // No-op (empty effects): zero SQL, zero counts.
    calls.length = 0
    const empty = await applyAttendanceLegacyGroupEffectsV1(
      trx as never,
      planWithGroups([]),
    )
    expect(empty).toEqual({ groupCreated: 0, groupMembersAdded: 0 })
    expect(calls).toEqual([])

    const mismatchedIdTrx = {
      query: async (sql: string) =>
        sql.includes('INSERT INTO attendance_groups')
          ? { rows: [{ id: MEMBER_ID }] }
          : { rows: [] },
    }
    await expect(
      applyAttendanceLegacyGroupEffectsV1(
        mismatchedIdTrx as never,
        planWithGroups([
          {
            kind: 'ensure_group',
            groupId: GROUP_ID,
            normalizedName: 'engineering',
            displayName: 'Engineering',
            code: null,
            timezone: 'UTC',
            ruleSetId: null,
            groupExistedAtPrepare: true,
          },
        ]),
      ),
    ).rejects.toThrowError('W4C3A_GROUP_EFFECT_ROW_MISMATCH')
  })

  it('9) OD-60 result slots and terminal summary refuse opaque/plan overrides', () => {
    // Positive: closed batch resultSlots parse.
    expect(
      parseLegacyImportBatchPlanV1({
        kind: 'normal',
        source: 'manual',
        ruleSetId: null,
        mappingSnapshot: {},
        sourceRowCount: 1,
        status: 'committed',
        idempotencyKey: null,
        visibilityRule: 'org',
        engine: 'standard',
        chunkConfig: {},
        recordUpsertStrategy: 'unnest',
        itemsInsertStrategy: 'unnest',
        mappingProfileId: null,
        compatibilityMetadata: {},
        groupSync: null,
        itemReturnPolicy: { returnItems: false, itemsLimit: null },
        skippedSamplePolicy: { limit: 0 },
        resultSlots: {
          groupCreated: 'ensure_group_returned_row_count',
          groupMembersAdded: 'ensure_member_inserted_row_count',
        },
      }).resultSlots,
    ).toEqual({
      groupCreated: 'ensure_group_returned_row_count',
      groupMembersAdded: 'ensure_member_inserted_row_count',
    })
    // Mutation: wrong result slot literal fails before effect SQL.
    expect(() =>
      parseLegacyImportBatchPlanV1({
        kind: 'normal',
        source: 'manual',
        ruleSetId: null,
        mappingSnapshot: {},
        sourceRowCount: 1,
        status: 'committed',
        idempotencyKey: null,
        visibilityRule: 'org',
        engine: 'standard',
        chunkConfig: {},
        recordUpsertStrategy: 'unnest',
        itemsInsertStrategy: 'unnest',
        mappingProfileId: null,
        compatibilityMetadata: {},
        groupSync: null,
        itemReturnPolicy: { returnItems: false, itemsLimit: null },
        skippedSamplePolicy: { limit: 0 },
        resultSlots: {
          groupCreated: 'plan_value',
          groupMembersAdded: 'ensure_member_inserted_row_count',
        },
      }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')

    // compatibilityMetadata cannot override explicit frozen fields or derived
    // counters, but unrelated compatibility keys survive.
    const basePlan = planWithGroups([
        {
          kind: 'ensure_member',
          memberId: MEMBER_ID,
          groupRef: GROUP_ID,
          userId: 'user-a',
          membershipExistedAtPrepare: false,
        },
      ])
    const metaPlan = {
      ...basePlan,
      manifest: {
        ...basePlan.manifest,
        batch: {
          ...basePlan.manifest.batch,
          idempotencyKey: 'idem-a',
          groupSync: {
            autoCreate: true,
            autoAssignMembers: true,
            ruleSetId: null,
            timezone: 'UTC',
          },
          compatibilityMetadata: {
            customLeaf: 'preserved',
            engine: 'opaque-engine',
            chunkConfig: { opaque: true },
            recordUpsertStrategy: 'opaque-record',
            itemsInsertStrategy: 'opaque-item',
            mappingProfileId: 'opaque-profile',
            groupSync: { opaque: true },
            groupCreated: 999,
            groupMembersAdded: 999,
            skippedCount: 999,
            skippedRows: [{ opaque: true }],
            processedRows: 999,
            failedRows: 999,
            async: false,
            idempotencyKey: 'opaque-idempotency',
          },
        },
      },
    } as VerifiedAttendanceLegacyPlanV1
    const meta = buildAttendanceLegacyFirstExecutionBatchMetaV1(
      metaPlan,
      { groupCreated: 0, groupMembersAdded: 0 },
    )
    expect(meta.customLeaf).toBe('preserved')
    expect(meta.engine).toBe('standard')
    expect(meta.chunkConfig).toEqual({})
    expect(meta.recordUpsertStrategy).toBe('unnest')
    expect(meta.itemsInsertStrategy).toBe('unnest')
    expect(meta.mappingProfileId).toBeNull()
    expect(meta.groupSync).toEqual({
      autoCreate: true,
      autoAssignMembers: true,
      ruleSetId: null,
      timezone: 'UTC',
    })
    expect(meta.groupCreated).toBe(0)
    expect(meta.groupMembersAdded).toBe(0)
    expect(meta.async).toBe(true)
    expect(meta.idempotencyKey).toBe('idem-a')
    expect(meta.processedRows).toBe(999)
    expect(meta.failedRows).toBe(999)
    expect(meta).not.toHaveProperty('skippedCount')
    expect(meta).not.toHaveProperty('skippedRows')
  })

  it('9b) null verified idempotency removes an opaque compatibility leaf', () => {
    const plan = planWithGroups([])
    const meta = buildAttendanceLegacyFirstExecutionBatchMetaV1(
      {
        ...plan,
        manifest: {
          ...plan.manifest,
          batch: {
            ...plan.manifest.batch,
            idempotencyKey: null,
            compatibilityMetadata: {
              ...plan.manifest.batch.compatibilityMetadata,
              idempotencyKey: 'opaque-idempotency',
            },
          },
        },
      } as VerifiedAttendanceLegacyPlanV1,
      { groupCreated: 0, groupMembersAdded: 0 },
    )
    expect(meta).not.toHaveProperty('idempotencyKey')
  })

  it('10) locked_race replay summary uses batch counts not effect results', () => {
    const plan = planWithGroups([])
    const replayPlan = {
      ...plan,
      manifest: {
        ...plan.manifest,
        operationalBranch: 'operational_only_idempotent_replay',
        sourceRowCount: 0,
        w4ItemCount: 0,
        w4DistinctTargetCount: 0,
        batch: {
          kind: 'idempotent_replay' as const,
          replayBatchId: BATCH,
          replaySelector: 'locked_race' as const,
          replayPreconditionDigest: 'a'.repeat(64),
          importedCount: 3,
          skippedCount: 2,
          totalRowCount: 5,
          engine: 'standard' as const,
          recordUpsertStrategy: 'unnest' as const,
          metadata: { chunkConfig: {}, itemsInsertStrategy: 'unnest' },
          idempotencyKey: 'idem',
          requesterVisibility: { kind: 'org' as const },
        },
      },
      items: Object.freeze([]),
      recordWrites: Object.freeze([]),
      groupEffects: Object.freeze([]),
    } as VerifiedAttendanceLegacyPlanV1
    // Positive: replay counts come from locked batch, not inflated effect result.
    const summary = buildAttendanceLegacyAsyncJobSummaryV1({
      plan: replayPlan,
      effectResult: { groupCreated: 50, groupMembersAdded: 50 },
      elapsedMs: 0,
    })
    expect(summary.summary.processedRows).toBe(3)
    expect(summary.summary.failedRows).toBe(2)
    expect(summary.summary.skippedCount).toBe(2)

    const missingItemStrategy = {
      ...replayPlan,
      manifest: {
        ...replayPlan.manifest,
        batch: {
          ...replayPlan.manifest.batch,
          metadata: { chunkConfig: {} },
        },
      },
    } as VerifiedAttendanceLegacyPlanV1
    expect(() =>
      buildAttendanceLegacyAsyncJobSummaryV1({
        plan: missingItemStrategy,
        effectResult: { groupCreated: 0, groupMembersAdded: 0 },
        elapsedMs: 0,
      }),
    ).toThrowError('W4C3A_BATCH_EFFECT_REPLAY_METADATA_INVALID')

    const missingChunkConfig = {
      ...replayPlan,
      manifest: {
        ...replayPlan.manifest,
        batch: {
          ...replayPlan.manifest.batch,
          metadata: { itemsInsertStrategy: 'unnest' },
        },
      },
    } as VerifiedAttendanceLegacyPlanV1
    expect(() =>
      buildAttendanceLegacyAsyncJobSummaryV1({
        plan: missingChunkConfig,
        effectResult: { groupCreated: 0, groupMembersAdded: 0 },
        elapsedMs: 0,
      }),
    ).toThrowError('W4C3A_BATCH_EFFECT_REPLAY_METADATA_INVALID')
  })

  it('11) same-process makeWorker cannot satisfy the production importer allowlist', () => {
    const attendanceDir = path.join(
      ROOT,
      'packages/core-backend/src/attendance',
    )
    const productionImporters: string[] = []
    const patterns = [
      /createAttendanceLegacyPlanWorkerV1/,
      /from\s+['"]\.\/w4c3a-legacy-plan-worker['"]/,
      /from\s+['"]\.\.\/w4c3a-legacy-plan-worker['"]/,
      /require\(\s*['"][^'"]*w4c3a-legacy-plan-worker['"]\s*\)/,
    ]
    for (const entry of fs.readdirSync(attendanceDir)) {
      if (!entry.endsWith('.ts') || entry.includes('__tests__')) continue
      if (entry === 'w4c3a-legacy-plan-worker.ts') continue
      const abs = path.join(attendanceDir, entry)
      const source = fs.readFileSync(abs, 'utf8')
      const importsWorkerFactory = patterns.some((re) => re.test(source)) &&
        source.includes('createAttendanceLegacyPlanWorkerV1')
      if (importsWorkerFactory) {
        productionImporters.push(
          `packages/core-backend/src/attendance/${entry}`,
        )
      }
    }
    // Also scan index.ts host assembly.
    const indexSource = fs.readFileSync(
      path.join(ROOT, 'packages/core-backend/src/index.ts'),
      'utf8',
    )
    expect(indexSource).toMatch(/createAttendanceLegacyPlanProcessorV1/)
    expect(indexSource).not.toMatch(/createAttendanceLegacyPlanWorkerV1/)
    expect(productionImporters).toEqual([
      W4C3A_LEGACY_PLAN_WORKER_PRODUCTION_IMPORTER,
    ])
  })

  it('12) startup recovery and queue converge on processAsyncImportCommitJob → host', () => {
    const source = fs.readFileSync(PLUGIN, 'utf8')
    // Queue processor
    expect(source).toMatch(
      /importQueue\.process\([\s\S]*processAsyncImportCommitJob/,
    )
    // Startup requeue
    expect(source).toMatch(
      /drainAttendanceImportStartupRecoveryPages\(\{[\s\S]{0,300}enqueueJob: enqueueImportJob/,
    )
    expect(source).toMatch(
      /const enqueueImportJob = async \(jobId\)[\s\S]*processAsyncImportCommitJob\(\{\s*jobId\s*\}\)/,
    )
    // V1 branch reaches only the host method
    expect(source).toMatch(
      /isV1[\s\S]*callAttendanceLegacyPlanHostV1\(rowId\)/,
    )
    // Missing port is non-retryable and does not call updateImportJobProgress
    // as a V1 terminal writer after the host call.
    const processJob = source.slice(
      source.indexOf('const processAsyncImportCommitJob'),
      source.indexOf('const commitAttendanceImportPayload'),
    )
    const v1Start = processJob.indexOf('if (isV1)')
    const legacyGuard = processJob.indexOf('if (!isLegacy)', v1Start)
    expect(v1Start).toBeGreaterThan(-1)
    expect(legacyGuard).toBeGreaterThan(v1Start)
    const v1Block = processJob
      .slice(v1Start, legacyGuard)
      .replace(/\/\/[^\n]*/g, '')
    expect(v1Block).not.toMatch(/updateImportJobProgress\s*\(/)
    expect(v1Block).toMatch(/callAttendanceLegacyPlanHostV1/)
  })

  it('existence-bit omission fails exact parse (OD-58)', () => {
    expect(() =>
      parseLegacyImportGroupEffectPlanV1({
        kind: 'ensure_group',
        groupId: GROUP_ID,
        normalizedName: 'engineering',
        displayName: 'Engineering',
        code: null,
        timezone: 'UTC',
        ruleSetId: null,
      }),
    ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
    expect(() =>
      parseLegacyImportGroupEffectPlanV1({
        kind: 'ensure_member',
        memberId: MEMBER_ID,
        groupRef: 'not-a-uuid',
        userId: 'u',
        membershipExistedAtPrepare: false,
      }),
    ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')
  })
})
