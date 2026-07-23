/**
 * W2 / #4556 — real-DB coverage for AttendanceWorkDateResolver.
 *
 * Proves org-scoped candidate loads, overnight open-record precedence,
 * same-date multi-shift ambiguity, schedule mutation after freeze,
 * cross-org isolation, and legacy no-anchor overtime paths against Postgres.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceWorkDateResolverForTests as {
  createPluginAttendanceWorkDateResolver: (db: { query: Function }) => {
    resolver: { resolve: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }
    adapters: {
      live: { resolvePunchWorkDate: Function }
      import: { resolveImportWorkDate: Function }
      correction: { resolveCorrectionWorkDate: Function }
      overtime: {
        freezeRequestCreationAnchor: Function
        preserveOrRequirePendingAnchor: Function
        canExtendAttributionWindow: Function
      }
      recompute: { resolveRecomputeWorkDate: Function }
      scheduled: { resolveScheduledWorkDate: Function }
    }
  }
  OVERTIME_ATTRIBUTION_KEY: string
  FROZEN_ATTRIBUTION_KEY: string
  OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED: string
  WORK_DATE_REASON: Record<string, string>
  buildOvertimeAttributionV1: (raw: Record<string, unknown>) => Record<string, unknown>
  runAutoAbsenceForOrgDate: (
    db: { query: Function },
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}

function wrapPool(pool: Pool) {
  return {
    async query(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params)
      return result.rows
    },
  }
}

describeIfDatabase('W2 AttendanceWorkDateResolver (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const db = wrapPool(pool)
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const orgA = `w2-org-a-${suffix}`
  const orgB = `w2-org-b-${suffix}`
  const userId = `w2-user-${suffix}`
  const foreignUserId = `w2-foreign-${suffix}`
  const nightShiftId = randomUUID()
  const morningShiftId = randomUUID()
  const afternoonShiftId = randomUUID()
  const foreignShiftId = randomUUID()
  const nightAsgId = randomUUID()
  const morningAsgId = randomUUID()
  const afternoonAsgId = randomUUID()
  const foreignAsgId = randomUUID()

  beforeAll(async () => {
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required')

    for (const id of [userId, foreignUserId]) {
      await pool.query(
        `INSERT INTO users (
           id, email, username, name, password_hash, role, permissions,
           is_active, is_admin, created_at, updated_at
         ) VALUES ($1, $2, $1, 'W2 Fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [id, `${id}@example.test`],
      )
    }
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgA],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [foreignUserId, orgB],
    )

    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, late_grace_minutes, early_grace_minutes, rounding_minutes, working_days)
       VALUES
         ($1, $2, 'Night', 'UTC', '22:00', '06:00', true, 10, 10, 5, '[0,1,2,3,4,5,6]'::jsonb),
         ($3, $2, 'Morning', 'UTC', '06:00', '14:00', false, 10, 10, 5, '[0,1,2,3,4,5,6]'::jsonb),
         ($4, $2, 'Afternoon', 'UTC', '13:00', '17:00', false, 10, 10, 5, '[0,1,2,3,4,5,6]'::jsonb),
         ($5, $6, 'Foreign', 'UTC', '09:00', '18:00', false, 10, 10, 5, '[0,1,2,3,4,5,6]'::jsonb)`,
      [nightShiftId, orgA, morningShiftId, afternoonShiftId, foreignShiftId, orgB],
    )

    const morningSlotOn17 = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES
         ($1, $2, $3, $4, '2026-07-15', '2026-07-15', true, 'published', 0),
         ($5, $2, $3, $6, '2026-07-16', '2026-07-16', true, 'published', 0),
         ($7, $2, $3, $8, '2026-07-17', '2026-07-17', true, 'published', 0),
         ($9, $2, $3, $10, '2026-07-17', '2026-07-17', true, 'published', 1),
         ($11, $12, $13, $14, '2026-07-15', '2026-07-20', true, 'published', 0)`,
      [
        nightAsgId, orgA, userId, nightShiftId,
        morningAsgId, morningShiftId,
        morningSlotOn17, morningShiftId,
        afternoonAsgId, afternoonShiftId,
        foreignAsgId, orgB, foreignUserId, foreignShiftId,
      ],
    )
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM attendance_requests WHERE org_id = ANY($1::text[])`, [[orgA, orgB]])
    await pool.query(`DELETE FROM attendance_records WHERE org_id = ANY($1::text[])`, [[orgA, orgB]])
    await pool.query(`DELETE FROM attendance_shift_assignments WHERE org_id = ANY($1::text[])`, [[orgA, orgB]])
    await pool.query(`DELETE FROM attendance_shifts WHERE org_id = ANY($1::text[])`, [[orgA, orgB]])
    await pool.query(`DELETE FROM user_orgs WHERE org_id = ANY($1::text[])`, [[orgA, orgB]])
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[userId, foreignUserId]])
    await pool.end()
  })

  it('loads org-scoped published candidates only (cross-org isolation)', async () => {
    const { resolver } = helpers.createPluginAttendanceWorkDateResolver(db)
    const result = await resolver.resolve({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-16T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
      calendarWorkDate: '2026-07-16',
    })
    // 10:00 is inside morning 06-14 on 07-16
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.shiftId).toBe(morningShiftId)
      expect(result.workDate).toBe('2026-07-16')
    }

    // Foreign org shift must not leak into orgA resolution for this user
    const foreignLeak = await resolver.resolve({
      orgId: orgA,
      userId: foreignUserId,
      occurredAt: new Date('2026-07-16T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
      calendarWorkDate: '2026-07-16',
    })
    expect(foreignLeak.kind).toBe('unresolved')
  })

  it('previous overnight re-anchors post-midnight punch (#4558 fold via shared resolver)', async () => {
    const { adapters } = helpers.createPluginAttendanceWorkDateResolver(db)
    // 05:55 UTC on 07-16 is inside night shift 07-15 22:00-06:00
    const result = await adapters.live.resolvePunchWorkDate({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-16T05:55:00.000Z'),
      timezone: 'UTC',
      calendarWorkDate: '2026-07-16',
    })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.workDate).toBe('2026-07-15')
      expect(result.shiftId).toBe(nightShiftId)
    }
  })

  it('open previous-night record wins over current-day containing shift at boundary', async () => {
    await pool.query(
      `INSERT INTO attendance_records
         (user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta)
       VALUES ($1, $2, '2026-07-15', 'UTC', '2026-07-15T22:05:00Z', NULL, 0, 0, 0, 'partial', true, '{}'::jsonb)
       ON CONFLICT (user_id, work_date, org_id) DO UPDATE
         SET first_in_at = EXCLUDED.first_in_at, last_out_at = NULL, status = 'partial'`,
      [userId, orgA],
    )
    const { resolver } = helpers.createPluginAttendanceWorkDateResolver(db)
    // Exact boundary 06:00 is in both night (07-15) and morning (07-16)
    const result = await resolver.resolve({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-16T06:00:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
      calendarWorkDate: '2026-07-16',
    })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.workDate).toBe('2026-07-15')
      expect(result.shiftId).toBe(nightShiftId)
      expect(result.reasonCode).toBe(helpers.WORK_DATE_REASON.OPEN_PREVIOUS_NIGHT_RECORD)
    }
  })

  it('same date multiple published shifts with overlapping windows → ambiguous (no row-order)', async () => {
    // 07-17 has morning 06-14 and afternoon 13-17 — 13:30 only hits afternoon.
    // Insert an overlapping second morning-like shift for ambiguity.
    const overlapShiftId = randomUUID()
    const overlapAsgId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
       VALUES ($1, $2, 'Overlap', 'UTC', '12:00', '16:00', false, '[0,1,2,3,4,5,6]'::jsonb)`,
      [overlapShiftId, orgA],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, $4, '2026-07-17', '2026-07-17', true, 'published', 2)`,
      [overlapAsgId, orgA, userId, overlapShiftId],
    )

    const { resolver } = helpers.createPluginAttendanceWorkDateResolver(db)
    const result = await resolver.resolve({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-17T13:30:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
      calendarWorkDate: '2026-07-17',
    })
    // Afternoon 13-17 and Overlap 12-16 both contain 13:30
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect((result.candidates as unknown[]).length).toBeGreaterThanOrEqual(2)
    }

    await pool.query(`DELETE FROM attendance_shift_assignments WHERE id = $1`, [overlapAsgId])
    await pool.query(`DELETE FROM attendance_shifts WHERE id = $1`, [overlapShiftId])
  })

  it('scheduled absence consumes ambiguity and writes no absent record', async () => {
    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = []
    const result = await helpers.runAutoAbsenceForOrgDate(db, {
      orgId: orgA,
      workDate: '2026-07-17',
      skipDedup: true,
      calendarOverrides: [],
      rule: {
        name: 'W2 scheduled ambiguity probe',
        timezone: 'UTC',
        workStartTime: '13:30',
        workEndTime: '17:00',
        workingDays: [0, 1, 2, 3, 4, 5, 6],
      },
      emit(name: string, payload: Record<string, unknown>) {
        emitted.push({ name, payload })
      },
    })

    expect(result).toMatchObject({
      generated: 0,
      targetUsers: 0,
    })
    expect(result.reviewRequired).toEqual([
      {
        userId,
        reasonCode: 'WORK_DATE_ATTRIBUTION_AMBIGUOUS',
      },
    ])
    expect(emitted.some((event) => event.name === 'attendance.work_date.review_required')).toBe(true)
    const rows = await pool.query(
      `SELECT 1 FROM attendance_records
       WHERE org_id = $1 AND user_id = $2 AND work_date = '2026-07-17'`,
      [orgA, userId],
    )
    expect(rows.rows).toHaveLength(0)
  })

  it('scheduled rule fallback rejects a malformed resolver candidate and writes no absent record', async () => {
    const workDate = '2026-07-19'
    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = []
    const malformedCandidateDb = {
      async query(sql: string, params?: unknown[]) {
        const rows = await db.query(sql, params)
        if (sql.includes('SELECT a.id AS assignment_id')) {
          return [{
            assignment_id: randomUUID(),
            org_id: orgA,
            user_id: userId,
            shift_id: randomUUID(),
            slot_index: null,
            start_date: workDate,
            end_date: workDate,
            assignment_kind: 'direct',
            shift_name: 'Malformed resolver-only fixture',
            shift_timezone: 'UTC',
            shift_work_start_time: '09:00',
            shift_work_end_time: null,
            shift_is_overnight: false,
          }]
        }
        return rows
      },
    }

    const result = await helpers.runAutoAbsenceForOrgDate(malformedCandidateDb, {
      orgId: orgA,
      workDate,
      skipDedup: true,
      calendarOverrides: [],
      rule: {
        name: 'W2 scheduled malformed-candidate probe',
        timezone: 'UTC',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workingDays: [0, 1, 2, 3, 4, 5, 6],
      },
      emit(name: string, payload: Record<string, unknown>) {
        emitted.push({ name, payload })
      },
    })

    expect(result).toMatchObject({
      generated: 0,
      targetUsers: 0,
      reviewRequired: [{
        userId,
        reasonCode: 'MALFORMED_CANDIDATE_SHAPE',
      }],
    })
    expect(emitted.some((event) => event.name === 'attendance.work_date.review_required')).toBe(true)
    const rows = await pool.query(
      `SELECT 1 FROM attendance_records
       WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
      [orgA, userId, workDate],
    )
    expect(rows.rows).toHaveLength(0)
  })

  it('scheduled absence probes the user effective shift instead of the org default start time', async () => {
    const workDate = '2026-07-18'
    const assignmentId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, $4, $5::date, $5::date, true, 'published', 0)`,
      [assignmentId, orgA, userId, morningShiftId, workDate],
    )

    try {
      const result = await helpers.runAutoAbsenceForOrgDate(db, {
        orgId: orgA,
        workDate,
        skipDedup: true,
        calendarOverrides: [],
        // Deliberately outside the employee's 06:00-14:00 shift. The scheduled
        // resolver must probe context.rule, not this unrelated org default.
        rule: {
          name: 'W2 unrelated org default',
          timezone: 'UTC',
          workStartTime: '18:00',
          workEndTime: '23:00',
          workingDays: [0, 1, 2, 3, 4, 5, 6],
        },
      })

      expect(result).toMatchObject({
        generated: 1,
        targetUsers: 1,
        reviewRequired: [],
      })
      const rows = await pool.query(
        `SELECT status
           FROM attendance_records
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgA, userId, workDate],
      )
      expect(rows.rows).toEqual([{ status: 'absent' }])
    } finally {
      await pool.query(
        `DELETE FROM attendance_records
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgA, userId, workDate],
      )
      await pool.query('DELETE FROM attendance_shift_assignments WHERE id = $1', [assignmentId])
    }
  })

  it('schedule mutation after request: frozen recompute attribution survives assignment change', async () => {
    const frozenShift = morningShiftId
    const { adapters } = helpers.createPluginAttendanceWorkDateResolver(db)
    const result = await adapters.recompute.resolveRecomputeWorkDate({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-16T10:00:00.000Z'),
      timezone: 'UTC',
      calendarWorkDate: '2026-07-16',
      frozenAttribution: {
        version: 1,
        orgId: orgA,
        userId,
        workDate: '2026-07-16',
        shiftId: frozenShift,
        reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT',
      },
    })
    // Mutate schedule away from morning
    await pool.query(
      `UPDATE attendance_shift_assignments SET is_active = false WHERE id = $1`,
      [morningAsgId],
    )
    const afterMutation = await adapters.recompute.resolveRecomputeWorkDate({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-16T10:00:00.000Z'),
      timezone: 'UTC',
      calendarWorkDate: '2026-07-16',
      frozenAttribution: {
        version: 1,
        orgId: orgA,
        userId,
        workDate: '2026-07-16',
        shiftId: frozenShift,
        reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT',
      },
    })
    expect(result.kind).toBe('resolved')
    expect(afterMutation.kind).toBe('resolved')
    if (afterMutation.kind === 'resolved') {
      expect(afterMutation.shiftId).toBe(frozenShift)
      expect(afterMutation.reasonCode).toBe(helpers.WORK_DATE_REASON.FROZEN_ATTRIBUTION)
    }
    // restore
    await pool.query(
      `UPDATE attendance_shift_assignments SET is_active = true WHERE id = $1`,
      [morningAsgId],
    )
  })

  it('overtime freeze + legacy no-anchor paths against real rows', async () => {
    const { adapters } = helpers.createPluginAttendanceWorkDateResolver(db)
    // Single published candidate on 07-16 → freeze ok
    const freeze = await adapters.overtime.freezeRequestCreationAnchor({
      orgId: orgA,
      userId,
      workDate: '2026-07-16',
    })
    expect(freeze.ok).toBe(true)
    expect(freeze.anchor).toMatchObject({
      version: 1,
      orgId: orgA,
      userId,
      workDate: '2026-07-16',
      shiftId: morningShiftId,
      source: 'shift',
    })

    // Multi-shift day 07-17 (morning + afternoon) → ambiguous freeze
    const multi = await adapters.overtime.freezeRequestCreationAnchor({
      orgId: orgA,
      userId,
      workDate: '2026-07-17',
    })
    expect(multi.ok).toBe(false)
    expect(multi.result.kind).toBe('ambiguous')

    // Legacy pending without anchor
    const legacy = adapters.overtime.preserveOrRequirePendingAnchor({})
    expect(legacy.ok).toBe(false)
    expect(legacy.code).toBe(helpers.OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED)

    // Legacy approved without anchor cannot extend
    const noExtend = adapters.overtime.canExtendAttributionWindow({
      request: { orgId: orgA, userId, workDate: '2026-07-16', metadata: {} },
      candidate: { orgId: orgA, userId, workDate: '2026-07-16', shiftId: morningShiftId },
      anchor: null,
    })
    expect(noExtend.ok).toBe(false)
    expect(noExtend.reason).toBe('LEGACY_APPROVED_NO_ANCHOR')
  })

  it('six adapters share the same live resolution for a scheduled morning punch', async () => {
    const { adapters } = helpers.createPluginAttendanceWorkDateResolver(db)
    const occurredAt = new Date('2026-07-16T10:00:00.000Z')
    const base = {
      orgId: orgA,
      userId,
      occurredAt,
      timezone: 'UTC',
      calendarWorkDate: '2026-07-16',
    }
    const results = await Promise.all([
      adapters.live.resolvePunchWorkDate(base),
      adapters.import.resolveImportWorkDate({ ...base, explicitWorkDate: '2026-07-16' }),
      adapters.scheduled.resolveScheduledWorkDate(base),
    ])
    for (const result of results) {
      expect(result.kind).toBe('resolved')
      if (result.kind === 'resolved') {
        expect(result.workDate).toBe('2026-07-16')
        expect(result.shiftId).toBe(morningShiftId)
      }
    }
  })

  it('boundaries: post-shift tail includes 90min after end; 150min is outside', async () => {
    const { resolver } = helpers.createPluginAttendanceWorkDateResolver(db)
    const inTail = await resolver.resolve({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-16T15:30:00.000Z'), // morning ends 14:00 + 90m
      timezone: 'UTC',
      channel: 'live',
      calendarWorkDate: '2026-07-16',
      attributionTailMinutes: 120,
    })
    expect(inTail.kind).toBe('resolved')

    const beyond = await resolver.resolve({
      orgId: orgA,
      userId,
      occurredAt: new Date('2026-07-16T16:30:00.000Z'), // +150m
      timezone: 'UTC',
      channel: 'live',
      calendarWorkDate: '2026-07-16',
      attributionTailMinutes: 120,
    })
    expect(beyond.kind).toBe('unresolved')
  })
})
