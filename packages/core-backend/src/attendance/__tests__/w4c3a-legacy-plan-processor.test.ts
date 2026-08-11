import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  acquireAttendanceLegacyPlanClass11V1,
  createAttendanceLegacyPlanProcessorV1,
  deriveAttendanceLegacyPlanTargetIdentitiesV1,
  W4C3A_LEGACY_PLAN_WORKER_PRODUCTION_IMPORTER,
} from '../w4c3a-legacy-plan-processor'
import {
  parseLegacyImportBatchPlanV1,
  parseLegacyImportGroupEffectPlanV1,
  parseLegacyImportItemReturnPolicyV1,
  parseLegacyImportRecordResultSlotsV1,
  parseLegacyImportSkippedSamplePolicyV1,
} from '../w4c3a-legacy-execution-plan'
import {
  buildAttendanceOperationalBulkTargetAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
} from '../w4c0-identity'
import type { VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
)

describe('W4C-3a OD-W4C-58/60 closed leaves', () => {
  it('requires frozen group/member existence branches and UUID groupRef', () => {
    expect(() =>
      parseLegacyImportGroupEffectPlanV1({
        kind: 'ensure_group',
        groupId: '10000000-0000-4000-8000-000000000001',
        normalizedName: 'engineering',
        displayName: 'Engineering',
        code: null,
        timezone: 'UTC',
        ruleSetId: null,
      }),
    ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')

    expect(
      parseLegacyImportGroupEffectPlanV1({
        kind: 'ensure_group',
        groupId: '10000000-0000-4000-8000-000000000001',
        normalizedName: 'engineering',
        displayName: 'Engineering',
        code: null,
        timezone: 'UTC',
        ruleSetId: null,
        groupExistedAtPrepare: false,
      }),
    ).toMatchObject({ groupExistedAtPrepare: false })

    expect(() =>
      parseLegacyImportGroupEffectPlanV1({
        kind: 'ensure_member',
        memberId: '10000000-0000-4000-8000-000000000002',
        groupRef: 'engineering',
        userId: 'user-a',
        membershipExistedAtPrepare: false,
      }),
    ).toThrowError('W4C3A_GROUP_EFFECT_PLAN_INVALID')

    expect(
      parseLegacyImportGroupEffectPlanV1({
        kind: 'ensure_member',
        memberId: '10000000-0000-4000-8000-000000000002',
        groupRef: '10000000-0000-4000-8000-000000000001',
        userId: 'user-a',
        membershipExistedAtPrepare: true,
      }),
    ).toMatchObject({ membershipExistedAtPrepare: true })
  })

  it('closes item-return, skipped-sample, and result-slot shapes', () => {
    expect(parseLegacyImportItemReturnPolicyV1({ returnItems: false, itemsLimit: null }))
      .toEqual({ returnItems: false, itemsLimit: null })
    expect(() =>
      parseLegacyImportItemReturnPolicyV1({ returnItems: false }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
    expect(() =>
      parseLegacyImportItemReturnPolicyV1({ returnItems: true, itemsLimit: null }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')

    expect(parseLegacyImportSkippedSamplePolicyV1({ limit: 0 })).toEqual({ limit: 0 })
    expect(parseLegacyImportSkippedSamplePolicyV1({ limit: 500 })).toEqual({ limit: 500 })
    expect(() =>
      parseLegacyImportSkippedSamplePolicyV1({ limit: 501 }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')
    expect(() =>
      parseLegacyImportSkippedSamplePolicyV1({ limit: -1 }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')

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
        skippedSamplePolicy: { limit: 50 },
        resultSlots: {
          groupCreated: 'ensure_group_returned_row_count',
          groupMembersAdded: 'ensure_member_inserted_row_count',
        },
      }).resultSlots,
    ).toEqual({
      groupCreated: 'ensure_group_returned_row_count',
      groupMembersAdded: 'ensure_member_inserted_row_count',
    })

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
        skippedSamplePolicy: { limit: 50 },
        resultSlots: {},
      }),
    ).toThrowError('W4C3A_BATCH_PLAN_INVALID')

    expect(parseLegacyImportRecordResultSlotsV1({})).toEqual({})
    expect(() =>
      parseLegacyImportRecordResultSlotsV1({ groupCreated: 1 }),
    ).toThrowError('W4C3A_RECORD_WRITE_PLAN_INVALID')
  })
})

describe('createAttendanceLegacyPlanProcessorV1 production boundary', () => {
  it('uses one org bulk class-11 sentinel for batch-limit and no target lock otherwise', async () => {
    const orgId = '20000000-0000-4000-8000-000000000001'
    const plan = {
      manifest: {
        orgId,
        acceptedWritePosture: 'legacy_projection_only',
        operationalBranch: 'operational_only_batch_limit',
      },
      recordWrites: [
        { userId: 'user-a', workDate: '2026-07-30' },
        { userId: 'user-b', workDate: '2026-07-31' },
      ],
    } as unknown as VerifiedAttendanceLegacyPlanV1
    const identities = deriveAttendanceLegacyPlanTargetIdentitiesV1(plan)
    expect(identities).toEqual([])

    const query = vi.fn(async () => ({ rows: [] }))
    await acquireAttendanceLegacyPlanClass11V1(
      { query },
      plan,
      identities,
    )
    const lockCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes('pg_advisory_xact_lock($1::bigint)'),
    )
    expect(lockCalls).toHaveLength(1)
    expect(lockCalls[0]?.[1]).toEqual([
      buildAttendanceOperationalBulkTargetAdvisoryKey(
        parseCanonicalAttendanceRolloutOrgKeyV1(orgId),
      ).toString(),
    ])

    const noTargetPlan = {
      ...plan,
      manifest: {
        ...plan.manifest,
        operationalBranch: 'operational_only_no_target',
      },
      recordWrites: [],
    } as unknown as VerifiedAttendanceLegacyPlanV1
    const noTargetQuery = vi.fn(async () => ({ rows: [] }))
    await acquireAttendanceLegacyPlanClass11V1(
      { query: noTargetQuery },
      noTargetPlan,
      deriveAttendanceLegacyPlanTargetIdentitiesV1(noTargetPlan),
    )
    expect(noTargetQuery).not.toHaveBeenCalled()
  })

  it('accepts only jobId and stable connection infrastructure', async () => {
    const release = vi.fn()
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM attendance_import_jobs') && sql.includes('id = $1') && !sql.includes('org_id')) {
        return { rows: [] }
      }
      return { rows: [] }
    })
    const processor = createAttendanceLegacyPlanProcessorV1({
      acquireConnection: async () => ({
        client: { query },
        release,
      }),
    })
    await expect(processor.processLegacyImportPlanV1('10000000-0000-4000-8000-000000000099'))
      .resolves.toEqual({ kind: 'not_found' })
    expect(release).toHaveBeenCalled()
    // Candidate read binds only jobId (no org injection from caller).
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes('FROM attendance_import_jobs') &&
      Array.isArray(call[1]) &&
      call[1].length === 1,
    )).toBe(true)
  })

  it('rejects invalid deps and empty jobId without connection work', async () => {
    expect(() =>
      createAttendanceLegacyPlanProcessorV1({} as never),
    ).toThrowError('W4C3A_PROCESSOR_DEPS_INVALID')

    const acquireConnection = vi.fn()
    const processor = createAttendanceLegacyPlanProcessorV1({ acquireConnection })
    await expect(processor.processLegacyImportPlanV1('')).resolves.toEqual({
      kind: 'not_found',
    })
    expect(acquireConnection).not.toHaveBeenCalled()
  })

  it('allows only the processor as production importer of the generic worker', () => {
    const attendanceDir = path.join(
      ROOT,
      'packages/core-backend/src/attendance',
    )
    const productionImporters: string[] = []
    for (const entry of fs.readdirSync(attendanceDir)) {
      if (!entry.endsWith('.ts') || entry.includes('__tests__')) continue
      const abs = path.join(attendanceDir, entry)
      const source = fs.readFileSync(abs, 'utf8')
      if (
        source.includes("from './w4c3a-legacy-plan-worker'") ||
        source.includes('from "./w4c3a-legacy-plan-worker"')
      ) {
        if (
          source.includes('createAttendanceLegacyPlanWorkerV1') &&
          !entry.includes('w4c3a-legacy-plan-worker')
        ) {
          productionImporters.push(
            `packages/core-backend/src/attendance/${entry}`,
          )
        }
      }
    }
    expect(productionImporters).toEqual([
      W4C3A_LEGACY_PLAN_WORKER_PRODUCTION_IMPORTER,
    ])
  })
})
