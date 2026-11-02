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
import { listActiveCurrentOpenRecordsForWorkDateResolverV1 } from '../../src/attendance/w4c3c-active-current'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceWorkDateResolverForTests as {
  createPluginAttendanceWorkDateResolver: (
    db: { query: Function },
    options?: {
      activeCurrent?: {
        listOpenForWorkDateResolver: typeof listActiveCurrentOpenRecordsForWorkDateResolverV1
      }
    },
  ) => {
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
  const createResolver = () =>
    helpers.createPluginAttendanceWorkDateResolver(db, {
      activeCurrent: {
        listOpenForWorkDateResolver: listActiveCurrentOpenRecordsForWorkDateResolverV1,
      },
    })
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
    const { resolver } = createResolver()
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
    const { adapters } = createResolver()
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
    const { resolver } = createResolver()
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

    const { resolver } = createResolver()
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
    const { adapters } = createResolver()
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
    const { adapters } = createResolver()
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
    const { adapters } = createResolver()
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
    const { resolver } = createResolver()
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
  describe('MUT06_W2_NATIVE SQL organization-scope evidence', () => {
    type Row = Record<string, unknown>
    type Call = { kind: string; sql: string; params: unknown[]; rows: Row[] }
    type ReadArgs = { orgId: string; userId: string; workDates: string[]; strictSources?: boolean }
    const raw = attendancePlugin.__attendanceWorkDateResolverForTests as {
      loadPublishedCandidatesForWorkDateResolver: (
        db: { query: (sql: string, params?: unknown[]) => Promise<Row[]> }, args: ReadArgs,
      ) => Promise<Row[]>
      loadApprovedOvertimeWindowsForWorkDateResolver: (
        db: { query: (sql: string, params?: unknown[]) => Promise<Row[]> }, args: ReadArgs,
      ) => Promise<Row[]>
    }
    const dates = ['2049-10-04', '2049-10-05', '2049-10-06']
    const shiftName = 'MUT06 Scoped Shift'
    const scopes = [
      { role: 'A', orgId: orgA, shift: randomUUID(), direct: randomUUID(), rule: randomUUID(),
        rotation: randomUUID(), record: randomUUID(), request: randomUUID(), start: '09:00', end: '17:00' },
      { role: 'B', orgId: orgB, shift: randomUUID(), direct: randomUUID(), rule: randomUUID(),
        rotation: randomUUID(), record: randomUUID(), request: randomUUID(), start: '10:00', end: '18:00' },
    ]

    function kindOf(sql: string) {
      if (sql.includes('FROM attendance_shift_assignments a')) return 'DIRECT'
      if (sql.includes('FROM attendance_rotation_assignments a')) return 'ROTATION'
      if (sql.includes('FROM attendance_shifts s') && sql.includes('WHERE s.id = $1')) return 'SHIFT_ID'
      if (sql.includes('FROM attendance_shifts s') && sql.includes('s.name = ANY(')) return 'SHIFT_NAME'
      if (sql.startsWith('SELECT user_id, org_id, work_date, first_in_at')) return 'OPEN'
      if (sql.includes('FROM attendance_requests') && sql.includes("request_type = 'overtime'")) return 'OVERTIME'
      return 'OTHER'
    }

    function probe(orgId: string, requestedUser = userId) {
      const calls: Call[] = []
      const errors: string[] = []
      return {
        orgId, requestedUser, calls, errors,
        async query(sql: string, params: unknown[] = []): Promise<Row[]> {
          try {
            const result = await pool.query(sql, params)
            calls.push({ kind: kindOf(sql.replace(/\s+/g, ' ').trim()), sql: sql.replace(/\s+/g, ' ').trim(),
              params: [...params], rows: result.rows })
            return result.rows
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
            errors.push(/^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN')
            throw error
          }
        },
      }
    }

    function receipt(arm: string, probes: ReturnType<typeof probe>[], extra: Row = {}) {
      console.log('MUT06_W2_SQL_RECEIPT ' + JSON.stringify({
        arm, databaseErrors: probes.flatMap(p => p.errors),
        observations: probes.map((p, index) => ({
          role: ['A', 'B', 'EMPTY'][index],
          calls: p.calls.map(c => ({ kind: c.kind, rows: c.rows.length,
            foreignRows: c.rows.filter(r => r.org_id !== undefined && r.org_id !== p.orgId).length })),
        })),
        ...extra,
      }))
    }

    function assertExecutedGuards(p: ReturnType<typeof probe>) {
      expect(p.errors, 'MUT06_DATABASE_ERRORS').toEqual([])
      for (const c of p.calls) {
        expect(c.kind, 'MUT06_UNCLASSIFIED_QUERY').not.toBe('OTHER')
        if (c.kind === 'DIRECT' || c.kind === 'ROTATION') {
          expect(c.sql, 'MUT06_' + c.kind + '_WHERE').toContain('WHERE a.org_id = $1 AND a.user_id = $2')
          expect(c.params, 'MUT06_' + c.kind + '_BINDS').toEqual([p.orgId, p.requestedUser, dates[2], dates[0]])
          expect(c.sql, 'MUT06_' + c.kind + '_JOIN').toContain(
            c.kind === 'DIRECT' ? 's.org_id = a.org_id' : 'r.org_id = a.org_id',
          )
        } else if (c.kind === 'SHIFT_ID' || c.kind === 'SHIFT_NAME') {
          expect(c.sql, 'MUT06_' + c.kind + '_SEGMENT_ORG').toContain('seg.org_id = s.org_id')
          if (c.kind === 'SHIFT_ID') {
            expect(c.sql, 'MUT06_SHIFT_ID_WHERE').toContain('WHERE s.id = $1 AND s.org_id = $2')
            expect(c.params[1], 'MUT06_SHIFT_ID_BIND').toBe(p.orgId)
          } else {
            expect(c.sql, 'MUT06_SHIFT_NAME_WHERE').toContain('WHERE s.org_id = $1 AND')
            expect(c.params, 'MUT06_SHIFT_NAME_BINDS').toEqual([p.orgId, [shiftName]])
          }
        } else {
          expect(c.sql, 'MUT06_' + c.kind + '_WHERE').toContain('WHERE org_id = $1 AND user_id = $2')
          expect(c.params, 'MUT06_' + c.kind + '_BINDS').toEqual([p.orgId, p.requestedUser, [dates[0]]])
        }
      }
    }

    beforeAll(async () => {
      await pool.query(
        'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING',
        [userId, orgB],
      )
      for (const s of scopes) {
        await pool.query(
          `INSERT INTO attendance_shifts
             (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight,
              late_grace_minutes, early_grace_minutes, rounding_minutes, working_days)
           VALUES ($1,$2,$3,'UTC',$4,$5,false,0,0,1,'[0,1,2,3,4,5,6]'::jsonb)`,
          [s.shift, s.orgId, shiftName, s.start, s.end],
        )
        await pool.query(
          `INSERT INTO attendance_shift_assignments
             (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
           VALUES ($1,$2,$3,$4,$5,$5,true,'published',0)`,
          [s.direct, s.orgId, userId, s.shift, dates[0]],
        )
        await pool.query(
          `INSERT INTO attendance_rotation_rules (id,org_id,name,timezone,shift_sequence,is_active)
           VALUES ($1,$2,'MUT06 scoped rotation','UTC',$3::jsonb,true)`,
          [s.rule, s.orgId, JSON.stringify([s.shift, shiftName])],
        )
        await pool.query(
          `INSERT INTO attendance_rotation_assignments
             (id,org_id,user_id,rotation_rule_id,start_date,end_date,is_active,publish_status)
           VALUES ($1,$2,$3,$4,$5,$6,true,'published')`,
          [s.rotation, s.orgId, userId, s.rule, dates[1], dates[2]],
        )
        await pool.query(
          `INSERT INTO attendance_records
             (id,user_id,org_id,work_date,timezone,first_in_at,last_out_at,
              work_minutes,late_minutes,early_leave_minutes,status,is_workday,meta)
           VALUES ($1,$2,$3,$4,'UTC',$5,NULL,0,0,0,'partial',true,'{}'::jsonb)`,
          [s.record, userId, s.orgId, dates[0], dates[0] + 'T' + s.start + ':00Z'],
        )
        await pool.query(
          `INSERT INTO attendance_requests
             (id,org_id,user_id,work_date,request_type,requested_in_at,requested_out_at,status,metadata)
           VALUES ($1,$2,$3,$4,'overtime',$5,$6,'approved','{}'::jsonb)`,
          [s.request, s.orgId, userId, dates[0], dates[0] + 'T17:00:00Z', dates[0] + 'T18:00:00Z'],
        )
      }
      const memberships = await pool.query(
        'SELECT org_id FROM user_orgs WHERE user_id=$1 AND org_id=ANY($2::text[]) AND is_active=true ORDER BY org_id',
        [userId, [orgA, orgB]],
      )
      expect(memberships.rows.map(r => r.org_id).sort()).toEqual([orgA, orgB].sort())
    })

    afterAll(async () => {
      await pool.query('DELETE FROM attendance_requests WHERE id=ANY($1::uuid[])', [scopes.map(s => s.request)])
      await pool.query('DELETE FROM attendance_records WHERE id=ANY($1::uuid[])', [scopes.map(s => s.record)])
      await pool.query('DELETE FROM attendance_rotation_assignments WHERE id=ANY($1::uuid[])', [scopes.map(s => s.rotation)])
      await pool.query('DELETE FROM attendance_rotation_rules WHERE id=ANY($1::uuid[])', [scopes.map(s => s.rule)])
      await pool.query('DELETE FROM attendance_shift_assignments WHERE id=ANY($1::uuid[])', [scopes.map(s => s.direct)])
      await pool.query('DELETE FROM attendance_shifts WHERE id=ANY($1::uuid[])', [scopes.map(s => s.shift)])
    })

    it('MUT06_W2_NATIVE published direct/rotation loaders expose scoped SQL rows before downstream rejection', async () => {
      const ps = [probe(orgA), probe(orgB), probe(orgA, foreignUserId)]
      const outcomes: Array<{ rows: Row[] | null; error: string | null }> = []
      for (const p of ps) {
        try {
          outcomes.push({ rows: await raw.loadPublishedCandidatesForWorkDateResolver(p, {
            orgId: p.orgId, userId: p.requestedUser, workDates: dates, strictSources: true,
          }), error: null })
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          outcomes.push({ rows: null, error: /^[A-Z0-9_]{1,80}$/.test(message) ? message : 'UNKNOWN' })
        }
      }
      receipt('PUBLISHED', ps, { returnedCandidates: outcomes.map(x => x.rows?.length ?? 0),
        loaderErrors: outcomes.map(x => x.error) })
      expect(outcomes[2]).toEqual({ rows: [], error: null })
      for (const [index, s] of scopes.entries()) {
        const p = ps[index]
        const direct = p.calls.find(c => c.kind === 'DIRECT')
        const rotation = p.calls.find(c => c.kind === 'ROTATION')
        expect(direct?.rows.map(r => [r.org_id, r.user_id, r.assignment_id, r.shift_id]),
          'MUT06_DIRECT_RAW_SCOPE').toEqual([[s.orgId, userId, s.direct, s.shift]])
        expect(rotation?.rows.map(r => [r.org_id, r.user_id, r.assignment_id, r.rotation_rule_id]),
          'MUT06_ROTATION_RAW_SCOPE').toEqual([[s.orgId, userId, s.rotation, s.rule]])
        for (const kind of ['SHIFT_ID', 'SHIFT_NAME']) {
          const call = p.calls.find(c => c.kind === kind)
          expect(call?.rows.map(r => [r.org_id, r.id]), 'MUT06_' + kind + '_RAW_SCOPE').toEqual([[s.orgId, s.shift]])
        }
        expect(outcomes[index].error, 'MUT06_LOADER_ERROR').toBeNull()
        const canonical = (outcomes[index].rows ?? []).map(r => ({ ...r,
          workStartTime: String(r.workStartTime).slice(0, 5), workEndTime: String(r.workEndTime).slice(0, 5) }))
          .sort((a, b) => String(a.workDate).localeCompare(String(b.workDate)))
        const common = { orgId: s.orgId, userId, shiftId: s.shift, segmentIndex: null,
          timezone: 'UTC', workStartTime: s.start, workEndTime: s.end, isOvernight: false }
        expect(canonical, 'MUT06_PUBLISHED_ARRAY').toEqual([
          { ...common, workDate: dates[0], assignmentId: s.direct, source: 'shift' },
          { ...common, workDate: dates[1], assignmentId: s.rotation, source: 'rotation', rotationRuleId: s.rule },
          { ...common, workDate: dates[2], assignmentId: s.rotation, source: 'rotation', rotationRuleId: s.rule },
        ])
        expect(p.calls.map(c => c.kind).sort()).toEqual(['DIRECT', 'ROTATION', 'SHIFT_ID', 'SHIFT_NAME'].sort())
        assertExecutedGuards(p)
      }
      expect(ps[2].calls.map(c => c.kind).sort()).toEqual(['DIRECT', 'ROTATION'].sort())
      assertExecutedGuards(ps[2])
    }, 120000)

    it('MUT06_W2_NATIVE active-current open records stay org scoped for the same global user', async () => {
      const ps = [probe(orgA), probe(orgB), probe(orgA, foreignUserId)]
      const results: Row[][] = []
      for (const p of ps) results.push(await listActiveCurrentOpenRecordsForWorkDateResolverV1(
        p.query, { orgId: p.orgId, userId: p.requestedUser, workDates: [dates[0]] },
      ))
      receipt('OPEN', ps, { returnedRows: results.map(x => x.length) })
      expect(results[2]).toEqual([])
      for (const [index, s] of scopes.entries()) {
        const normalized = results[index].map(r => ({ ...r,
          work_date: r.work_date instanceof Date ? [
            String(r.work_date.getFullYear()).padStart(4, '0'),
            String(r.work_date.getMonth() + 1).padStart(2, '0'),
            String(r.work_date.getDate()).padStart(2, '0'),
          ].join('-') : String(r.work_date).slice(0, 10),
          first_in_at: new Date(String(r.first_in_at)).toISOString(),
        }))
        expect(normalized, 'MUT06_OPEN_RAW_SCOPE').toEqual([{
          user_id: userId, org_id: s.orgId, work_date: dates[0],
          first_in_at: dates[0] + 'T' + s.start + ':00.000Z', last_out_at: null, status: 'partial',
        }])
        expect(ps[index].calls.map(c => c.kind)).toEqual(['OPEN'])
        assertExecutedGuards(ps[index])
      }
      assertExecutedGuards(ps[2])
    }, 120000)

    it('MUT06_W2_NATIVE approved legacy overtime windows stay org scoped before anchor decisions', async () => {
      const ps = [probe(orgA), probe(orgB), probe(orgA, foreignUserId)]
      const results: Row[][] = []
      for (const p of ps) results.push(await raw.loadApprovedOvertimeWindowsForWorkDateResolver(p, {
        orgId: p.orgId, userId: p.requestedUser, workDates: [dates[0]],
      }))
      receipt('OVERTIME', ps, { returnedRows: results.map(x => x.length) })
      expect(results[2]).toEqual([])
      for (const [index, s] of scopes.entries()) {
        expect(results[index], 'MUT06_OVERTIME_RAW_SCOPE').toEqual([{
          requestId: s.request, orgId: s.orgId, userId, workDate: dates[0], shiftId: null,
          approvedStartAt: new Date(dates[0] + 'T17:00:00Z'),
          approvedEndAt: new Date(dates[0] + 'T18:00:00Z'), anchor: null,
        }])
        expect(ps[index].calls.map(c => c.kind)).toEqual(['OVERTIME'])
        assertExecutedGuards(ps[index])
      }
      assertExecutedGuards(ps[2])
    }, 120000)
  })

})
