import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  appendApprovedLeaveCancellationCalculationV1,
} from '../../src/attendance/w4c3b-approved-leave-cancellation'
import { calculateAttendanceSegmentsV1 } from '../../src/attendance/w4c1-segment-calculator'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

function uuid(): string {
  return crypto.randomUUID()
}

function frozenContext(orgId: string, userId: string) {
  return {
    schemaVersion: 1,
    selector: 'legacy',
    orgId,
    userId,
    workDate: '2026-08-01',
    timezone: 'Asia/Shanghai',
    shiftId: 'w4c3b-p14-shift',
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: null,
    roundingMinutes: 15,
    severeLateThresholdMinutes: 45,
    absenceLateThresholdMinutes: 90,
    segments: [
      {
        index: 0,
        startTime: '09:00',
        endTime: '12:00',
        startDayOffset: 0,
        endDayOffset: 0,
        lateGraceMinutes: 5,
        earlyLeaveGraceMinutes: 5,
      },
      {
        index: 1,
        startTime: '13:00',
        endTime: '18:00',
        startDayOffset: 0,
        endDayOffset: 0,
        lateGraceMinutes: 5,
        earlyLeaveGraceMinutes: 5,
      },
    ],
  } as const
}

function frozenAttribution(orgId: string, userId: string) {
  return {
    posture: 'resolved_v2' as const,
    value: {
      schemaVersion: 2,
      resolverVersion: 'w4c3b-p14-test',
      orgId,
      userId,
      workDate: '2026-08-01',
      shiftId: 'w4c3b-p14-shift',
      reasonCode: 'assignment_match',
      resolvedAt: '2026-08-01T00:00:00.000Z',
      absoluteWindow: { startAt: '2026-07-31T16:00:00.000Z', endAt: '2026-08-02T16:00:00.000Z' },
      attributionWindow: { startAt: '2026-07-31T20:00:00.000Z', endAt: '2026-08-01T20:00:00.000Z' },
      attributionTailMinutes: 240,
      extendedByApprovedOvertime: false,
      windowEvidenceFingerprint: 'a'.repeat(64),
      source: 'request_creation',
    },
  } as const
}

async function rollbackTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function insertFrozenLeaveFixture(client: PoolClient, omitSnapshot = false) {
  const orgId = uuid()
  const userId = `w4c3b-p14-user-${uuid()}`
  const recordId = uuid()
  const requestId = uuid()
  const priorCalculationId = uuid()
  const requestSnapshotFingerprint = 'f'.repeat(64)
  const context = frozenContext(orgId, userId)
  const attribution = frozenAttribution(orgId, userId)
  const leaveFact = {
    kind: 'leave',
    requestId,
    requestSnapshotVersion: 1,
    requestSnapshotFingerprint,
    approvalVersion: 3,
    approvalRecordId: '101',
    leaveType: 'annual',
    coverage: {
      kind: 'bounded_interval',
      startAt: '2026-08-01T01:00:00.000Z',
      endAt: '2026-08-01T10:00:00.000Z',
      minutes: 480,
    },
  }
  const prior = calculateAttendanceSegmentsV1({
    attribution,
    context,
    evidence: [],
    approvedFacts: [leaveFact],
  })
  if (prior.outcome !== 'completed' || prior.dailyProjection === null) throw new Error('fixture must calculate')

  await client.query(
    `INSERT INTO attendance_requests (id, org_id, user_id, work_date, request_type, status, reason)
     VALUES ($1::uuid, $2, $3, '2026-08-01', 'leave', 'approved', 'fixture')`,
    [requestId, orgId, userId],
  )
  if (!omitSnapshot) {
    await client.query(
      `INSERT INTO attendance_request_calculation_snapshots
        (org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
         attribution_snapshot, context_snapshot, created_by)
       VALUES ($1, $2::uuid, 1, 'leave', $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8)`,
      [
        orgId,
        requestId,
        userId,
        JSON.stringify({
          schemaVersion: 1,
          workDate: '2026-08-01',
          requestedInAt: null,
          requestedOutAt: null,
          reason: 'fixture',
          minutes: null,
          leaveTypeCode: 'annual',
          outdoorPunch: null,
        }),
        requestSnapshotFingerprint,
        JSON.stringify(attribution),
        JSON.stringify(context),
        userId,
      ],
    )
  }
  await client.query(
    `INSERT INTO attendance_records
      (id, org_id, user_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
       status, is_workday, meta, projection_owner, visibility_state, visibility_reason)
     VALUES ($1::uuid, $2, $3, '2026-08-01', 'Asia/Shanghai', 0, 0, 0,
             'adjusted', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active')`,
    [recordId, orgId, userId],
  )
  await client.query(
    `INSERT INTO attendance_record_calculations (
       id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
       engine_version, snapshot_schema_version, operation_id,
       semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
       attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
       approved_facts_snapshot, manual_override_snapshot, input_provenance,
       merge_policy, calculation_tier, outcome, outcome_reason_code, projection_effect,
       expected_segment_count, projected_status, projected_first_in_at, projected_last_out_at,
       projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
       projected_daily_fingerprint, actor_id, correlation_id
     ) VALUES (
       $1::uuid, $2, $3::uuid, 1, 'calculation', 'authoritative', 'approved_leave',
       'w4c3b-p14-fixture', 1, $4::uuid,
       $5, $6, $7,
       $8::jsonb, $9::jsonb, $10::jsonb, '[]'::jsonb,
       $11::jsonb, NULL, '{}'::jsonb,
       'append', 'segment_authoritative', 'completed', 'calculated', 'set_active',
       2, $12, NULL, NULL, $13, $14, $15, $16, $17, 'fixture')`,
    [
      priorCalculationId,
      orgId,
      recordId,
      uuid(),
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
      JSON.stringify(attribution),
      JSON.stringify(context),
      JSON.stringify(context.segments),
      JSON.stringify([leaveFact]),
      prior.dailyProjection.status,
      prior.dailyProjection.workedMinutes,
      prior.dailyProjection.lateMinutes,
      prior.dailyProjection.earlyLeaveMinutes,
      '4'.repeat(64),
      userId,
    ],
  )
  for (const segment of prior.segments) {
    await client.query(
      `INSERT INTO attendance_record_segments
        (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
         actual_in_at, actual_out_at, work_minutes, late_minutes, early_leave_minutes,
         status, status_reasons, matched_evidence_refs, unmatched_evidence_refs)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, $15::jsonb)`,
      [
        orgId,
        recordId,
        priorCalculationId,
        segment.segmentIndex,
        segment.expectedStartAt,
        segment.expectedEndAt,
        segment.actualInAt,
        segment.actualOutAt,
        segment.workedMinutes,
        segment.lateMinutes,
        segment.earlyLeaveMinutes,
        segment.status,
        JSON.stringify(segment.reasons),
        JSON.stringify(segment.matchedEvidenceRefs),
        JSON.stringify(segment.unmatchedEvidenceRefs),
      ],
    )
  }
  await client.query(
    `UPDATE attendance_records
        SET projection_owner = 'w4', current_calculation_id = $3::uuid
      WHERE id = $1::uuid AND org_id = $2`,
    [recordId, orgId, priorCalculationId],
  )
  return { orgId, userId, recordId, requestId, priorCalculationId }
}

describeIfDatabase('W4C-3b P14 approved leave cancellation (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    await pool.end()
  })

  it('appends an authoritative calculation from frozen inputs and removes only the cancelled leave fact', async () => {
    await rollbackTransaction(pool, async (client) => {
      const fixture = await insertFrozenLeaveFixture(client)
      const result = await appendApprovedLeaveCancellationCalculationV1({
        client,
        ...fixture,
        operationId: uuid(),
        actorId: 'w4c3b-p14-admin',
        correlationId: 'w4c3b-p14-cancel',
        mode: 'authoritative',
      })
      expect(result.kind).toBe('appended')
      if (result.kind !== 'appended') throw new Error('expected appended cancellation calculation')

      const calculation = await client.query(
        `SELECT supersedes_calculation_id::text AS supersedes_calculation_id,
                entrypoint, merge_policy, outcome, projection_effect,
                approved_facts_snapshot, projected_status
           FROM attendance_record_calculations WHERE id = $1::uuid`,
        [result.calculationId],
      )
      expect(calculation.rows).toHaveLength(1)
      expect(calculation.rows[0]).toMatchObject({
        supersedes_calculation_id: fixture.priorCalculationId,
        entrypoint: 'approval_reversal',
        merge_policy: 'reversal',
        outcome: 'completed',
        projection_effect: 'set_active',
        approved_facts_snapshot: [],
        projected_status: 'absent',
      })
      const record = await client.query(
        `SELECT current_calculation_id::text AS current_calculation_id, status
           FROM attendance_records WHERE id = $1::uuid`,
        [fixture.recordId],
      )
      expect(record.rows[0]).toEqual({ current_calculation_id: result.calculationId, status: 'absent' })
      const children = await client.query(
        'SELECT count(*)::int AS n FROM attendance_record_segments WHERE calculation_id = $1::uuid',
        [result.calculationId],
      )
      expect(children.rows[0].n).toBe(2)
    })
  })

  it('fails closed with review/no-parent when the frozen request snapshot is absent and leaves no new calculation', async () => {
    await rollbackTransaction(pool, async (client) => {
      const fixture = await insertFrozenLeaveFixture(client, true)
      const before = await client.query(
        'SELECT count(*)::int AS n FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid',
        [fixture.recordId],
      )
      await expect(appendApprovedLeaveCancellationCalculationV1({
        client,
        ...fixture,
        operationId: uuid(),
        actorId: 'w4c3b-p14-admin',
        correlationId: 'w4c3b-p14-missing',
        mode: 'authoritative',
      })).resolves.toEqual({ kind: 'review_required', reason: 'frozen_request_snapshot_missing' })
      const after = await client.query(
        'SELECT count(*)::int AS n FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid',
        [fixture.recordId],
      )
      expect(after.rows[0].n).toBe(before.rows[0].n)
    })
  })
})
