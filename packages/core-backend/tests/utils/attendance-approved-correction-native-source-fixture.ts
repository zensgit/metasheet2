import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Pool } from 'pg'
import { expect } from 'vitest'

type Subject = { orgId: string; userId: string }

export async function readNativeCorrectionParentPosture(pool: Pool, orgId: string, recordId: string) {
  const result = await pool.query(
    `SELECT current_calculation_id::text, projection_owner, visibility_state, visibility_reason
       FROM attendance_records WHERE org_id = $1 AND id = $2::uuid`,
    [orgId, recordId],
  )
  expect(result.rows).toHaveLength(1)
  return result.rows[0]
}

// Synthetic configuration only. Calculations, event IDs and frozen V1/V2 snapshots
// come from the real activated adapters/public live boundary, not fixture JSON.
// This setup earns no source-mutation acceptance credit.
export async function seedNativeApprovedCorrectionSource(
  pool: Pool,
  subject: Subject,
  options: { mode?: 'shadow' | 'authoritative'; workDate?: string; singleSegment?: boolean; groupV2?: boolean } = {},
) {
  // Load runtime dependencies only after the native harness has installed its DB/RBAC environment.
  const { createLegacyLivePunchBoundaryDriver } = await import('./attendance-legacy-live-punch-boundary-driver')
  const { loadAttendanceCorrectionSourceV1 } = await import('../../src/attendance/approved-correction-target-source')
  const { orgId, userId } = subject
  const mode = options.mode ?? 'shadow'
  const rollout = await pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1', [orgId])
  expect(rollout.rows).toEqual([{ state: mode }])
  const workDate = options.workDate ?? '2049-08-21'
  const instant = (time: string) => workDate + 'T' + time + ':00.000Z'
  const shiftId = randomUUID()
  const groupId = options.groupV2 ? randomUUID() : null
  await pool.query(
    `INSERT INTO attendance_shifts
       (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight,
        working_days, late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
     VALUES ($1, $2, 'correction A native source', 'UTC', '09:00', '18:00', false,
             '[0,1,2,3,4,5,6]'::jsonb, 0, 0, 1, 'strict')`,
    [shiftId, orgId],
  )
  const segments = options.singleSegment ? [['09:00', '18:00']] : [['09:00', '12:00'], ['13:00', '18:00']]
  for (const [index, [start, end]] of segments.entries()) {
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0)`,
      [randomUUID(), orgId, shiftId, index, start, end],
    )
  }
  if (groupId) {
    // Same persisted FSER inputs as the landed W7-1b cutover fixture; the real
    // resolver/seam must admit them and emit group_effective frozenV2 itself.
    const { buildAttendanceGroupFixedScheduleProducerKey } = createRequire(import.meta.url)(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
    ) as { buildAttendanceGroupFixedScheduleProducerKey(input: unknown): string }
    const producerKey = buildAttendanceGroupFixedScheduleProducerKey({
      groupId, shiftId, startDate: workDate, endDate: workDate,
    })
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
       VALUES ($1, $2, 'correction A native group', 'fixed_shift', 'UTC')`, [groupId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, $4, $4, 1, $5)`, [orgId, groupId, shiftId, workDate, userId],
    )
    await pool.query(
      'INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)',
      [orgId, groupId, userId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active,
          producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
       VALUES ($1, $2, $3, $4, $4, true, 'attendance_group_fixed_schedule', $5, $6, $7, 'published')`,
      [orgId, userId, shiftId, workDate, groupId, producerKey, randomUUID()],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships
         (org_id, user_id, group_id, effective_from, effective_to,
          assigned_by, assigned_reason, assigned_correlation_id)
       VALUES ($1, $2, $3, $4, NULL, $2, 'synthetic_fixture', $5)`,
      [orgId, userId, groupId, workDate, randomUUID()],
    )
    const { seedAttendanceW7ContextSourcePostureV1 } = await import('./w7-context-source-posture-fixture')
    await seedAttendanceW7ContextSourcePostureV1(pool, orgId, 'group_authoritative')
    process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = orgId
  } else {
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, $4, $4, true, 'published', 1)`, [orgId, userId, shiftId, workDate],
    )
  }
  const driver = createLegacyLivePunchBoundaryDriver(pool)
  const punches: Array<['check_in' | 'check_out', string]> = options.singleSegment
    ? [['check_in', '09:15']]
    : [['check_in', '09:15'], ['check_out', '12:00'], ['check_in', '13:00']]
  let preparedContext: unknown
  let producedCalculationId: string | null = null
  for (const [eventType, time] of punches) {
    const prepared = await driver.prepare({ orgId, userId, eventType, occurredAt: instant(time), timezone: 'UTC', operationId: randomUUID() })
    const result = await driver.execute(prepared)
    if (result.kind !== 'w4') throw new Error('CORRECTION_A_NATIVE_BOUNDARY_REQUIRED')
    expect({ outcome: result.shadow.outcome, reason: result.shadow.outcomeReasonCode })
      .toEqual({ outcome: 'completed', reason: 'calculated' })
    producedCalculationId = result.shadow.calculationId
    preparedContext = JSON.parse(JSON.stringify(prepared.outerContext))
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await loadAttendanceCorrectionSourceV1(client, { orgId, userId, workDate })
    expect(selected.source.calculationId).toBe(producedCalculationId)
    expect(selected.input.context).toEqual(preparedContext)
    expect({ mode: selected.prior.mode, outcome: selected.prior.outcome, segments: selected.prior.expected_segment_count })
      .toEqual({ mode, outcome: 'completed', segments: segments.length })
    await client.query('COMMIT')
    return { context: selected.input.context!, attribution: selected.input.attribution,
      evidence: selected.input.evidence, instant, recordId: selected.source.recordId,
      calculationId: selected.source.calculationId, calculationVersion: selected.source.calculationVersion,
      preparedContext, groupId, parentPreimage: await readNativeCorrectionParentPosture(pool, orgId, selected.source.recordId) }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
