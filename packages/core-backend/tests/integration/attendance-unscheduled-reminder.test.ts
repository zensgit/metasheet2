import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'

import {
  UnscheduledReminderService,
  type UnscheduledReminderQuery,
} from '../../src/services/UnscheduledReminderService'
import { AttendanceNotifier, type AttendanceNotificationMessage } from '../../src/services/AttendanceNotifier'

// The shared predicate the punch path uses (plugins/plugin-attendance/index.cjs, exported). The §f parity
// assertion compares our set-based scan to it so a future change to either side that diverges fails CI.
const requireCjs = createRequire(import.meta.url)
// The predicate is exported on the plugin's test-surface object, not the top level.
const attendancePlugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
  __attendanceReportFieldCatalogForTests: {
    isUserScheduledForDate: (
      db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
      orgId: string,
      userId: string,
      date: string,
    ) => Promise<boolean>
  }
}
const isUserScheduledForDate = attendancePlugin.__attendanceReportFieldCatalogForTests.isUserScheduledForDate

// Mirror the exact CI db-gating idiom of attendance-plugin.test.ts so this runs (not skips) under the
// "Run attendance integration tests" step's DATABASE_URL, and is skipped (not failed) without a DB.
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('⑤ unscheduled-shift reminder (real DB)', () => {
  let pool: Pool
  // service-shaped query ({rows,rowCount}); predicate-shaped query (rows array).
  let serviceQuery: UnscheduledReminderQuery
  let pluginDb: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl })
    serviceQuery = async (sql, params) => {
      const r = await pool.query(sql, params as unknown[])
      return { rows: r.rows, rowCount: r.rowCount }
    }
    pluginDb = { query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows }
  })

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
  })

  it('scan parity with isUserScheduledForDate; claims only unscheduled scheduled_shift members; dedup; no-channel still records', async () => {
    const suffix = `ur${Date.now().toString(36)}`
    const org = `org-${suffix}`
    const at0701 = () => new Date('2026-07-01T00:00:00.000Z')
    const target = '2026-07-02' // = 0701 + lookahead 1
    const targetE = '2026-07-03' // = 0701 + lookahead 2 (case e, distinct claim)

    const gSched = randomUUID(), gFixed = randomUUID(), gFree = randomUUID()
    const shiftId = randomUUID(), schedGroupId = randomUUID()
    const uNoAssign = `u-noassign-${suffix}`
    const uShift = `u-shift-${suffix}`
    const uSchedGrp = `u-schedgrp-${suffix}`
    const uFixed = `u-fixed-${suffix}`
    const uFree = `u-free-${suffix}`
    const uMixed = `u-mixed-${suffix}`
    const allUsers = [uNoAssign, uShift, uSchedGrp, uFixed, uFree, uMixed]

    try {
      // --- seed groups (one of each type), a shift, a schedule group ---
      await pool.query(
        `INSERT INTO attendance_groups (id, org_id, name, attendance_type) VALUES
           ($1,$4,'sched','scheduled_shift'),($2,$4,'fixed','fixed_shift'),($3,$4,'free','free_time')`,
        [gSched, gFixed, gFree, org],
      )
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time, working_days)
         VALUES ($1,$2,'s','UTC','09:00','18:00','[1,2,3,4,5,6,7]'::jsonb)`,
        [shiftId, org],
      )
      await pool.query(
        `INSERT INTO attendance_schedule_groups (id, org_id, name) VALUES ($1,$2,'sg')`,
        [schedGroupId, org],
      )
      // --- memberships ---
      const member = (uid: string, gid: string) =>
        pool.query(`INSERT INTO attendance_group_members (id, org_id, group_id, user_id) VALUES ($1,$2,$3,$4)`,
          [randomUUID(), org, gid, uid])
      await member(uNoAssign, gSched)
      await member(uShift, gSched)
      await member(uSchedGrp, gSched)
      await member(uFixed, gFixed)
      await member(uFree, gFree)
      await member(uMixed, gSched)
      await member(uMixed, gFixed) // mixed → applicability guard excludes (not ALL scheduled_shift)
      // --- coverage for the two that SHOULD be covered on the target date ---
      await pool.query(
        `INSERT INTO attendance_shift_assignments (id, org_id, user_id, shift_id, start_date, end_date, is_active)
         VALUES ($1,$2,$3,$4,'2026-07-01','2026-07-31',true)`,
        [randomUUID(), org, uShift, shiftId],
      )
      await pool.query(
        `INSERT INTO attendance_schedule_group_members (id, org_id, schedule_group_id, user_id, effective_from, effective_to)
         VALUES ($1,$2,$3,$4,'2026-07-01','2026-07-31')`,
        [randomUUID(), org, schedGroupId, uSchedGrp],
      )

      // === (f) PARITY: our pure scan vs the exported predicate, for every seeded user ===
      const svc = new UnscheduledReminderService({ query: serviceQuery, now: at0701, lookaheadDays: 1 })
      const scanned = await svc.scanCandidates(target)
      const scannedMine = new Set(scanned.filter((c) => c.orgId === org).map((c) => c.userId))
      for (const u of allUsers) {
        const scheduled = await isUserScheduledForDate(pluginDb, org, u, target)
        expect(scannedMine.has(u)).toBe(!scheduled) // candidate ⇔ predicate says "unscheduled"
      }
      // (a/b/c) only the no-coverage all-scheduled_shift member is a candidate
      expect(scannedMine).toEqual(new Set([uNoAssign]))

      // === run with a capture channel: claims + dispatches uNoAssign (scope assertions to our org; scan is global) ===
      const captured: AttendanceNotificationMessage[] = []
      const notifier = new AttendanceNotifier({ channels: [{ name: 'cap', async send(m) { captured.push(m); return { ok: true } } }] })
      const svcCap = new UnscheduledReminderService({ query: serviceQuery, notifier, now: at0701, lookaheadDays: 1 })
      await svcCap.run()
      const rowCount = async (uid: string, d: string) =>
        Number((await pool.query(
          `SELECT count(*)::int AS n FROM attendance_unscheduled_reminder_dispatch WHERE org_id=$1 AND user_id=$2 AND target_date=$3`,
          [org, uid, d])).rows[0].n)
      expect(await rowCount(uNoAssign, target)).toBe(1)
      for (const u of [uShift, uSchedGrp, uFixed, uFree, uMixed]) expect(await rowCount(u, target)).toBe(0)
      expect(captured.filter((m) => m.orgId === org).map((m) => m.userId)).toEqual([uNoAssign])

      // === (d) repeat tick → no duplicate row, no second dispatch ===
      await svcCap.run()
      expect(await rowCount(uNoAssign, target)).toBe(1) // unique-constraint claim held
      expect(captured.filter((m) => m.orgId === org).length).toBe(1) // dispatched once total

      // === (e) default notifier (0 channels) → no external send, but the internal row IS recorded ===
      const svcNoCh = new UnscheduledReminderService({ query: serviceQuery, notifier: new AttendanceNotifier(), now: at0701, lookaheadDays: 2 })
      const eResult = await svcNoCh.run()
      expect(eResult.dispatched).toBe(0) // no channel → nothing sent
      expect(await rowCount(uNoAssign, targetE)).toBe(1) // but the reminder is recorded
    } finally {
      await pool.query('DELETE FROM attendance_unscheduled_reminder_dispatch WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_schedule_group_members WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_shift_assignments WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_group_members WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_schedule_groups WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_shifts WHERE org_id = $1', [org]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_groups WHERE org_id = $1', [org]).catch(() => undefined)
    }
  })
})
