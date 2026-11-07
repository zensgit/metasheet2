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
import type { PoolClient } from 'pg'
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
})

type W204ShiftRow = { id: string; org_id: string; segment_count: number }
type W204Fixture = {
  client: PoolClient
  orgs: [string, string]
  shiftIds: [string, string]
  userId: string
}

describeIfDatabase('W204 native unfiltered shift lookup organization facets (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl, max: 1 })
  const calendar = attendancePlugin.__attendanceReportFieldCatalogForTests as {
    resolveEffectiveCalendar: (
      db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
      args: Record<string, unknown>,
    ) => Promise<unknown>
  }

  afterAll(async () => { await pool.end() })

  async function withFixture(check: (fixture: W204Fixture) => Promise<void>) {
    const client = await pool.connect()
    let began = false
    const suffix = randomUUID()
    const orgs: [string, string] = ['w204-a-' + suffix, 'w204-b-' + suffix]
    const shiftIds: [string, string] = [randomUUID(), randomUUID()]
    const userId = 'w204-user-' + suffix
    try {
      await client.query('BEGIN')
      began = true
      await client.query('SET LOCAL statement_timeout = 10000')
      await client.query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'W204 Fixture', 'x', 'user', '[]'::jsonb, true, false)`,
        [userId, userId + '@example.test'],
      )
      for (const [index, orgId] of orgs.entries()) {
        await client.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
        await client.query(
          `INSERT INTO attendance_shifts
             (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
           VALUES ($1, $2, 'W204 Scoped', 'UTC', '09:00', '17:00', false, '[0,1,2,3,4,5,6]'::jsonb)`,
          [shiftIds[index], orgId],
        )
        for (let segment = 0; segment <= index; segment += 1) {
          await client.query(
            `INSERT INTO attendance_shift_segments
               (org_id, shift_id, segment_index, start_time, end_time)
             VALUES ($1, $2, $3, $4::time, $5::time)`,
            [orgId, shiftIds[index], segment, segment === 0 ? '09:00' : '13:00', segment === 0 ? '12:00' : '17:00'],
          )
        }
        const rotationId = randomUUID()
        // Existing persisted whitespace reference reaches the native unfiltered
        // branch. No new entry point or fabricated returned rows are used.
        await client.query(
          `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
           VALUES ($1, $2, 'W204 Rotation', 'UTC', '["   "]'::jsonb, true)`,
          [rotationId, orgId],
        )
        await client.query(
          `INSERT INTO attendance_rotation_assignments
             (id, org_id, user_id, rotation_rule_id, start_date, end_date, is_active, publish_status)
           VALUES ($1, $2, $3, $4, '2051-01-03', '2051-01-03', true, 'published')`,
          [randomUUID(), orgId, userId, rotationId],
        )
      }
      await check({ client, orgs, shiftIds, userId })
    } finally {
      try {
        if (began) await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    }
  }

  async function captureLookup(fixture: W204Fixture, orgId: string) {
    const calls: { sql: string; params: unknown[]; rows: W204ShiftRow[] }[] = []
    await calendar.resolveEffectiveCalendar({
      async query(sql, params) {
        const result = await fixture.client.query<W204ShiftRow>(sql, params)
        // Match the carrier independently of either predicate being tested.
        if (/FROM\s+attendance_shifts\s+s/.test(sql) && /AS segment_count/.test(sql)
          && !/s\.(?:id|name)\s*=\s*ANY/.test(sql)) {
          calls.push({ sql, params: params ? [...params] : [], rows: result.rows })
        }
        return result.rows
      },
    }, { orgId, userId: fixture.userId, from: '2051-01-03', to: '2051-01-03', calendarPolicyOverrides: [] })
    expect(calls, 'W204_NATIVE_UNFILTERED_CALL_COUNT').toHaveLength(1)
    return calls[0]
  }

  it('W204_OUTER native unfiltered lookup returns only the requested organization in both directions', async () => {
    await withFixture(async (fixture) => {
      for (const [index, orgId] of fixture.orgs.entries()) {
        const call = await captureLookup(fixture, orgId)
        expect(call.rows.filter(row => row.org_id !== orgId), 'W204_OUTER_ZERO_FOREIGN_ROWS').toHaveLength(0)
        expect(call.rows.map(row => ({ id: row.id, org_id: row.org_id }))).toEqual([
          { id: fixture.shiftIds[index], org_id: orgId },
        ])
        expect(call.params).toEqual([orgId])
      }
    })
  })

  it('W204_SEGMENT executed unfiltered carrier retains the segment organization predicate and own counts', async () => {
    await withFixture(async (fixture) => {
      for (const [index, orgId] of fixture.orgs.entries()) {
        const call = await captureLookup(fixture, orgId)
        // This facet observes the actual executed carrier. The composite FK
        // prevents a legal foreign segment with this shift ID; no leak is claimed.
        expect(call.sql, 'W204_SEGMENT_EXECUTED_ORG_PREDICATE').toMatch(/seg\.org_id\s*=\s*s\.org_id/)
        expect(call.rows.filter(row => row.id === fixture.shiftIds[index]).map(row => row.segment_count)).toEqual([index + 1])
      }
    })
  })

  it('W204_INTEGRITY native composite FK rejects a foreign segment while legal segment counts survive', async () => {
    await withFixture(async ({ client, orgs, shiftIds }) => {
      for (const [index, orgId] of orgs.entries()) {
        await client.query('SAVEPOINT w204_foreign_segment')
        try {
          await expect(client.query(
            `INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, end_time)
             VALUES ($1, $2, 2, '18:00', '19:00')`,
            [orgs[1 - index], shiftIds[index]],
          )).rejects.toMatchObject({ code: '23503', constraint: 'fk_attendance_shift_segments_shift_org' })
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT w204_foreign_segment')
          await client.query('RELEASE SAVEPOINT w204_foreign_segment')
        }
        const rows = await client.query(
          'SELECT segment_index FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2 ORDER BY segment_index',
          [orgId, shiftIds[index]],
        )
        expect(rows.rows).toEqual(index === 0 ? [{ segment_index: 0 }] : [{ segment_index: 0 }, { segment_index: 1 }])
      }
    })
  })
})
