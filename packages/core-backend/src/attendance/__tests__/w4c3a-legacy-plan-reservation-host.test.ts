import { afterEach, describe, expect, it } from 'vitest'

import {
  createAttendanceLegacyPlanReservationHostV1,
  resolveAttendanceLegacyPlanOperationalBranchV1,
  type ReserveAttendanceLegacyImportPlanFromHostInputV1,
} from '../w4c3a-legacy-plan-reservation-host'
import { rawImportEvidenceV1 } from '../../../tests/utils/attendance-w4c3a-raw-evidence'

const BATCH_ID = '10000000-0000-4000-8000-000000000001'
const ORG_ID = '20000000-0000-4000-8000-000000000001'
const ORIGINAL_ALLOWLIST =
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED

afterEach(() => {
  if (ORIGINAL_ALLOWLIST === undefined) {
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  } else {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED =
      ORIGINAL_ALLOWLIST
  }
})

describe('W4C-3a P07 production reservation host', () => {
  it('accepts exactly 5000 and rejects authoritative 5001', () => {
    expect(
      resolveAttendanceLegacyPlanOperationalBranchV1({
        itemCount: 5000,
        distinctTargetCount: 5000,
        acceptedWritePosture: 'authoritative',
      }),
    ).toBe('strict_targeted')
    expect(() =>
      resolveAttendanceLegacyPlanOperationalBranchV1({
        itemCount: 5001,
        distinctTargetCount: 5000,
        acceptedWritePosture: 'authoritative',
      }),
    ).toThrow('ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED')
    expect(() =>
      resolveAttendanceLegacyPlanOperationalBranchV1({
        itemCount: 5000,
        distinctTargetCount: 5001,
        acceptedWritePosture: 'authoritative',
      }),
    ).toThrow('ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED')
    expect(
      resolveAttendanceLegacyPlanOperationalBranchV1({
        itemCount: 5001,
        distinctTargetCount: 5001,
        acceptedWritePosture: 'legacy_projection_only',
      }),
    ).toBe('operational_only_batch_limit')
  })

  it('retries 40001, then rejects authoritative 5001 before reservation or business DML', async () => {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const sql: string[] = []
    let released = 0
    let rolloutAttempts = 0
    const host = createAttendanceLegacyPlanReservationHostV1({
      acquireConnection: async () => ({
        client: {
          query: async (text: string) => {
            sql.push(text)
            // This is a freshly-acquired (idle) connection — the SAME affirmative-proof
            // contract the real driver gives `assertConnectionIsIdleV1`'s own
            // `SAVEPOINT w4c5_idle_probe` (SQLSTATE 25P01, no active transaction).
            if (text === 'SAVEPOINT w4c5_idle_probe') {
              throw Object.assign(new Error('no_active_sql_transaction'), { code: '25P01' })
            }
            if (text.includes('attendance_calculation_rollout_state')) {
              rolloutAttempts += 1
              if (rolloutAttempts === 1) {
                throw Object.assign(new Error('serialization failure'), {
                  code: '40001',
                })
              }
              return {
                rows: [{ state: 'authoritative', scope: 'synthetic_staging' }],
              }
            }
            return { rows: [] }
          },
        },
        release: () => {
          released += 1
        },
      }),
    })
    const items = Array.from({ length: 5001 }, (_, ordinal) => ({
      kind: 'apply' as const,
      ordinal,
      semanticOrdinal: ordinal,
      targetRef: JSON.stringify([
        ORG_ID,
        `user-${ordinal}`,
        '2026-07-31',
      ]),
      previewSnapshot: {},
      rawEvidence: rawImportEvidenceV1(ordinal),
    }))
    const recordWrites = items.map((_item, ordinal) => ({
      orgId: ORG_ID,
      userId: `user-${ordinal}`,
      workDate: '2026-07-31',
      sourceOrdinals: [ordinal],
      mergeMode: 'override' as const,
      firstInAt: null,
      lastOutAt: null,
      workMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: 'normal',
      isWorkday: true,
      timezone: 'UTC',
      compatibilityMetadata: {},
      policySnapshot: {},
      profileSnapshot: {},
      multiPunchSnapshot: {},
      attributionSnapshot: {},
      sourceBatchId: BATCH_ID,
      resultSlots: {},
    }))
    const input: ReserveAttendanceLegacyImportPlanFromHostInputV1 = {
      orgId: ORG_ID,
      actorId: 'admin-host-limit',
      actorPosture: 'platform_admin',
      tokenSubjectUserId: 'admin-host-limit',
      batchId: BATCH_ID,
      idempotencyKey: null,
      legacyInputFingerprint: 'a'.repeat(64),
      payload: {
        __jobType: 'commit',
        idempotencyKey: null,
        __importEngine: 'bulk',
        recordUpsertStrategy: 'staging',
        itemsInsertStrategy: 'staging',
        __w4ContractVersion: 1,
      },
      legacyRowSourceKind: 'direct_rows',
      legacySourceRowLimit: null,
      batch: {
        kind: 'normal',
        source: 'manual',
        ruleSetId: null,
        mappingSnapshot: {},
        sourceRowCount: 5001,
        status: 'committed',
        idempotencyKey: null,
        visibilityRule: 'org',
        engine: 'bulk',
        chunkConfig: {},
        recordUpsertStrategy: 'staging',
        itemsInsertStrategy: 'staging',
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
      items,
      recordWrites,
      groupEffects: [],
    }

    await expect(host.reserveLegacyImportPlanV1(input)).rejects.toThrow(
      'ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED',
    )
    expect(released).toBe(1)
    expect(rolloutAttempts).toBe(2)
    expect(sql).toEqual([
      // Gate E (#4844): the idle-precondition probe runs exactly ONCE, before the retry loop —
      // never re-issued per attempt (the loop's own ROLLBACK already restores idle between
      // attempts).
      'SAVEPOINT w4c5_idle_probe',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT state, scope FROM attendance_calculation_rollout_state WHERE org_id = $1',
      'ROLLBACK',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT state, scope FROM attendance_calculation_rollout_state WHERE org_id = $1',
      'ROLLBACK',
    ])
    expect(sql.join('\n')).not.toMatch(
      /INSERT|UPDATE|DELETE|COPY|attendance_import_legacy_execution_plan|attendance_result_operations/i,
    )
  })
})
