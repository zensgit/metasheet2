/**
 * #4556 combined-soak shadow-diff FAMILY pins (real host, real DB) — the mechanical
 * statement of what staging soak-status 31962440160 counted, built while dispositioning it:
 *
 *  Family A — now ALSO the end-to-end pin for W4C-2 roster entries 2-3
 *  (`transient_partial_day_in_only_late` / `transient_partial_day_out_only_early_leave`,
 *  owner ruling issue-4556.comment-5317181927; read-side evaluator
 *  `isExpectedAttendanceW4C2ReadSideDifferenceV1` per issue-4556.comment-5322708492):
 *  probes are built FROM THE REAL PERSISTED ROWS, never hand-assembled, and the classifier
 *  must flip false -> true exactly when the completing punch lands (temporal control pair).
 *
 *  Family A — `late_minutes_mismatch` is a TRANSIENT PARTIAL-DAY difference, not a
 *  calculation divergence: legacy `computeMetrics` returns {status:'partial', lateMinutes:0}
 *  while a day has only a check_in (plugins/plugin-attendance/index.cjs ~L11961), whereas
 *  the W4 calculator reports the late minutes immediately; the moment the check_out lands,
 *  BOTH machines compute the same values and the next calc row is `equal`. Leg A pins the
 *  full lifecycle: v1 = late_minutes_mismatch (delta = the real late minutes), v2 = equal.
 *
 *  Family B — the SINGLE-DAILY-PAIR contract (the soak generator's 2/user/day cadence):
 *  exactly one check_in + one check_out on a work date — here at the segment boundaries
 *  (00:00:00 / 23:59:00 wall), the zero-anomaly ideal — produces `equal` on every calc row
 *  and a legacy `normal` day. One pair per (user, work date) is the load shape whose
 *  healthy diff surface is all-equal; extra same-day sessions are what flooded
 *  §4.2-critical review_required diffs (soak-status 31962440160; see the generator header).
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { createRequire } from 'module'
import type { MetaSheetServer } from '../../src/index'
import {
  isExpectedAttendanceW4C2ReadSideDifferenceV1,
} from '../../src/attendance/w4c2-shadow-expected-differences'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip
const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const requireCjs = createRequire(import.meta.url)
const { buildAttendanceGroupFixedScheduleProducerKey } = requireCjs(
  '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
)

type HttpResponse = { status: number; body?: any; raw: string }
function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describeDb('#4556 soak shadow-diff families — transient partial-day mismatch + single-daily-pair all-equal (org2 shape)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let priorW4: string | undefined
  let priorW7: string | undefined

  const org = randomUUID()
  const userA = randomUUID() // Family A — transient partial-day lifecycle
  const userB = randomUUID() // Family B — single-daily-pair all-equal contract
  const userC = randomUUID() // roster entry 3 — out-only early-leave lifecycle
  const userD = randomUUID() // never-converging in-only day (classifier stays false)
  const shift = randomUUID()
  const group = randomUUID()
  const TZ = 'Asia/Shanghai'

  const mintToken = async (userId: string): Promise<string> => {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  async function insertActiveUser(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'soak diff-family fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@soak-diff-families.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, org],
    )
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('suite needs loopback + DATABASE_URL')
    priorW4 = process.env[W4_ENV]
    priorW7 = process.env[W7_ENV]
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    process.env[W4_ENV] = org.toLowerCase()
    delete process.env[W7_ENV]

    const repoRoot = path.join(HERE, '../../../../')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    await insertActiveUser(userA)
    await insertActiveUser(userB)
    await insertActiveUser(userC)
    await insertActiveUser(userD)
    // W4 rollout: legacy -> shadow (the soak's org2 shape; NOT authoritative).
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'soak-diff-families', 'TEST_FIXTURE', 'soak-diff-actor', 1, NULL)`,
      [org],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1`,
      [org],
    )
    // The soak seeder's exact shapes: full-day 00:00-23:59 Asia/Shanghai, grace 5/5,
    // rounding 15, strict; group-produced published assignments for both users.
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, $3, $4, '00:00', '23:59', false, '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 15, 'strict')`,
      [shift, org, `soak-diff-families ${shift}`, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), org, shift],
    )
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
       VALUES ($1, $2, $3, 'fixed_shift', $4)`,
      [group, org, `soak-diff-families group ${group}`, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', 1, 'soak-diff-families')`,
      [org, group, shift],
    )
    const producerKey = buildAttendanceGroupFixedScheduleProducerKey({
      groupId: group, shiftId: shift, startDate: '2026-01-01', endDate: '2027-12-31',
    })
    for (const userId of [userA, userB, userC, userD]) {
      await pool.query(
        `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
        [org, group, userId],
      )
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (org_id, user_id, shift_id, start_date, end_date, is_active,
            producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
         VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true,
                 'attendance_group_fixed_schedule', $4, $5, $6, 'published')`,
        [org, userId, shift, group, producerKey, randomUUID()],
      )
      await pool.query(
        `INSERT INTO attendance_calculation_group_memberships
           (org_id, user_id, group_id, effective_from, effective_to,
            assigned_by, assigned_reason, assigned_correlation_id)
         VALUES ($1, $2, $3, '2026-01-01', NULL, 'soak-diff-families', 'seed', $4)`,
        [org, userId, group, `soak-diff-families-${group}-${userId.slice(0, 8)}`],
      )
    }
  }, 180_000)

  afterAll(async () => {
    for (const table of [
      'attendance_record_segments',
      'attendance_record_calculations',
      'attendance_records',
      'attendance_events',
      'attendance_calculation_group_memberships',
      'attendance_shift_assignments',
      'attendance_group_fixed_schedule_configs',
      'attendance_group_members',
      'attendance_groups',
      'attendance_shift_segments',
      'attendance_shifts',
      'user_orgs',
    ]) {
      await pool?.query(`DELETE FROM ${table} WHERE org_id = $1`, [org]).catch(() => undefined)
    }
    await pool?.query(`DELETE FROM attendance_calculation_rollout_state WHERE org_id = $1`, [org]).catch(() => undefined)
    await pool?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[userA, userB, userC, userD]]).catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]
    else process.env[W7_ENV] = priorW7
  }, 60_000)

  const punch = async (userId: string, eventType: 'check_in' | 'check_out', occurredAt: string) =>
    requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(userId)}`,
        'Content-Type': 'application/json',
      },
      // timezone deliberately OMITTED from the body — mirrors the soak generator (sent only
      // when config-explicit); the org rule's own timezone governs work-date attribution.
      body: JSON.stringify({ orgId: org, eventType, operationId: randomUUID(), occurredAt }),
    })

  const calcsFor = async (userId: string) =>
    (
      await pool.query(
        `SELECT c.version, c.outcome, c.shadow_diff_code, c.shadow_diff,
                c.projected_status, c.projected_first_in_at, c.projected_last_out_at,
                c.projected_late_minutes, c.projected_early_leave_minutes,
                c.attendance_record_id::text AS attendance_record_id
           FROM attendance_record_calculations c
           JOIN attendance_records r ON r.id = c.attendance_record_id
          WHERE r.org_id = $1 AND r.user_id = $2
          ORDER BY c.version`,
        [org, userId],
      )
    ).rows

  /**
   * Build the read-side probe for rows[index] FROM THE REAL PERSISTED ROW — never
   * hand-assembled. Convergence = the next row (same record, next version) carries `equal`;
   * before the completing punch lands that row does not exist, so convergedToEqual=false.
   */
  const readProbeFromRows = (rows: any[], index: number) => {
    const row = rows[index]
    const next = rows
      .filter((candidate) => candidate.attendance_record_id === row.attendance_record_id
        && Number(candidate.version) > Number(row.version))
      .sort((a, b) => Number(a.version) - Number(b.version))[0]
    return {
      shadowDiffCode: row.shadow_diff_code,
      changedFields: row.shadow_diff.changedFields,
      projectedStatus: row.projected_status,
      projectedFirstInPresent: row.projected_first_in_at !== null,
      projectedLastOutPresent: row.projected_last_out_at !== null,
      absoluteMinuteDelta: row.shadow_diff.absoluteMinuteDelta,
      projectedLateMinutes: row.projected_late_minutes === null ? null : Number(row.projected_late_minutes),
      projectedEarlyLeaveMinutes: row.projected_early_leave_minutes === null ? null : Number(row.projected_early_leave_minutes),
      convergedToEqual: next !== undefined && next.shadow_diff_code === 'equal',
    }
  }

  it('Family A: an in-only day diffs ONLY as transient late_minutes_mismatch, and converges to equal when the pair completes', async () => {
    // 2026-08-11T17:35:30Z == 01:35:30 +08 on 2026-08-12 — 95.5 wall minutes after the
    // 00:00 segment start; grace 5 => both machines' converged late value is 90.
    const rIn = await punch(userA, 'check_in', '2026-08-11T17:35:30.000Z')
    expect(rIn.status).toBe(200)
    const afterIn = await calcsFor(userA)
    expect(afterIn.length).toBe(1)
    expect(afterIn[0].shadow_diff_code).toBe('late_minutes_mismatch')
    expect(afterIn[0].shadow_diff.changedFields).toEqual(['lateMinutes'])
    expect(afterIn[0].shadow_diff.absoluteMinuteDelta).toBe(90)
    // Roster entry 2's read-side core, from the REAL persisted row: one-boundary in-only,
    // both projections partial, witness minutes = the delta.
    expect(afterIn[0].projected_status).toBe('partial')
    expect(afterIn[0].projected_first_in_at).not.toBeNull()
    expect(afterIn[0].projected_last_out_at).toBeNull()
    expect(Number(afterIn[0].projected_late_minutes)).toBe(90)
    expect(Number(afterIn[0].projected_early_leave_minutes)).toBe(0)
    // TEMPORAL NEGATIVE CONTROL: before the completing punch, convergence is unobservable
    // (the next row does not exist) — the classifier must say NOT expected.
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(readProbeFromRows(afterIn, 0))).toBe(false)

    const rOut = await punch(userA, 'check_out', '2026-08-11T17:36:30.000Z')
    expect(rOut.status).toBe(200)
    const afterOut = await calcsFor(userA)
    expect(afterOut.length).toBe(2)
    expect(afterOut[1].shadow_diff_code).toBe('equal')
    expect(afterOut[1].projected_first_in_at).not.toBeNull()
    expect(afterOut[1].projected_last_out_at).not.toBeNull()
    // TEMPORAL POSITIVE CONTROL: the SAME v1 row, re-probed now that the converging row
    // exists, is roster-expected — the classifier flips exactly on convergence.
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(readProbeFromRows(afterOut, 0))).toBe(true)

    const rec = await pool.query(
      `SELECT status, late_minutes FROM attendance_records WHERE org_id = $1 AND user_id = $2`,
      [org, userA],
    )
    expect(rec.rows[0].late_minutes).toBe(90)
  })

  it('Family B: a single daily pair (00:00:00 in, 23:59:00 out) is equal on every calc row and a normal legacy day', async () => {
    // 2026-08-11T16:00:00Z == 2026-08-12 00:00:00 +08; 2026-08-12T15:59:00Z == 23:59:00 +08.
    const rIn = await punch(userB, 'check_in', '2026-08-11T16:00:00.000Z')
    const rOut = await punch(userB, 'check_out', '2026-08-12T15:59:00.000Z')
    expect(rIn.status).toBe(200)
    expect(rOut.status).toBe(200)
    const calcs = await calcsFor(userB)
    expect(calcs.length).toBe(2)
    for (const calc of calcs) {
      expect(calc.outcome).toBe('completed')
      expect(calc.shadow_diff_code).toBe('equal')
    }
    const rec = await pool.query(
      `SELECT status, late_minutes, early_leave_minutes, work_date::text AS work_date
         FROM attendance_records WHERE org_id = $1 AND user_id = $2`,
      [org, userB],
    )
    expect(rec.rows[0].status).toBe('normal')
    expect(rec.rows[0].late_minutes).toBe(0)
    expect(rec.rows[0].early_leave_minutes).toBe(0)
    expect(rec.rows[0].work_date).toBe('2026-08-12')
  })

  it('roster entry 3 lifecycle: an out-only day diffs as early_leave_minutes_mismatch and the classifier flips on convergence', async () => {
    // 2026-08-13 +08: check_out FIRST at 23:00 (+08) == 2026-08-13T15:00:00Z. Early-leave
    // threshold is 23:59 - 5 grace = 23:54 => 54 minutes. Legacy zeroes minutes on the
    // out-only 'partial' day; W4 reports 54 immediately.
    const rOut = await punch(userC, 'check_out', '2026-08-13T15:00:00.000Z')
    expect(rOut.status).toBe(200)
    const afterOut = await calcsFor(userC)
    expect(afterOut.length).toBe(1)
    expect(afterOut[0].shadow_diff_code).toBe('early_leave_minutes_mismatch')
    expect(afterOut[0].shadow_diff.changedFields).toEqual(['earlyLeaveMinutes'])
    expect(afterOut[0].shadow_diff.absoluteMinuteDelta).toBe(54)
    expect(afterOut[0].projected_status).toBe('partial')
    expect(afterOut[0].projected_first_in_at).toBeNull()
    expect(afterOut[0].projected_last_out_at).not.toBeNull()
    expect(Number(afterOut[0].projected_early_leave_minutes)).toBe(54)
    expect(Number(afterOut[0].projected_late_minutes)).toBe(0)
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(readProbeFromRows(afterOut, 0))).toBe(false)

    // Completing check_in at the segment start (00:00 +08 == 2026-08-12T16:00:00Z): both
    // machines agree (late 0, early 54) and the next row is equal.
    const rIn = await punch(userC, 'check_in', '2026-08-12T16:00:00.000Z')
    expect(rIn.status).toBe(200)
    const afterIn = await calcsFor(userC)
    expect(afterIn.length).toBe(2)
    expect(afterIn[1].shadow_diff_code).toBe('equal')
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(readProbeFromRows(afterIn, 0))).toBe(true)
  })

  it('a NEVER-completed in-only day stays NOT roster-expected (open day: expected-but-open, never silently explained)', async () => {
    // 2026-08-14 +08, in-only at 02:00 (+08) == 2026-08-13T18:00:00Z; late = 120 - 5 = 115.
    const rIn = await punch(userD, 'check_in', '2026-08-13T18:00:00.000Z')
    expect(rIn.status).toBe(200)
    const rows = await calcsFor(userD)
    expect(rows.length).toBe(1)
    expect(rows[0].shadow_diff_code).toBe('late_minutes_mismatch')
    expect(isExpectedAttendanceW4C2ReadSideDifferenceV1(readProbeFromRows(rows, 0))).toBe(false)
  })
})
