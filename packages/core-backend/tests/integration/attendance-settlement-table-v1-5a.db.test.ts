import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

// 加班银行 v1-5a — attendance_payroll_cycle_settlements schema lock. DORMANT: nothing writes this table until
// v1-5b's snapshot-at-close; this only asserts the migration's shape + the two #3206 constraints.
//
// OBS-1 follow-up (2026-08-08, owner P1): this file was `attendance-settlement-table-v1-5a.test.ts` — outside the
// `*.db.test.ts` convention, wired into NO real-DB run-list, and NOT excluded from the no-DB job, so the only job
// that ever collected it had no database. Worse, its single test body opened with `if (!dbUrl) return` AND
// `if (cols.length === 0) return // table not migrated in this env`, i.e. a MISSING TABLE reported PASS. Required
// CI therefore went green over a schema lock that asserted nothing. It is now renamed to the `.db.test.ts`
// convention, two-point wired (attendance real-DB step in plugin-tests.yml + vitest.config.ts test.exclude), and
// the table-missing soft-pass is DELETED: if the migration has not been applied, this suite FAILS.
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

/** Postgres SQLSTATEs the constraints under test must raise — a bare "it rejected" cannot tell them apart. */
const UNIQUE_VIOLATION = '23505'
const NOT_NULL_VIOLATION = '23502'
const FOREIGN_KEY_VIOLATION = '23503'

async function rejectionCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined // resolved — the constraint did not fire
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describeIfDatabase('#加班银行 v1-5a — attendance_payroll_cycle_settlements schema (dormant)', () => {
  it('has the [P1] frozen-period cols + [P2] source NOT NULL + the UNIQUE idempotency key', async () => {
    const pool = new Pool({ connectionString: dbUrl })
    // Shared-DB house rule: every fixture key is run-unique. org_id has no FK (plain text), and the cycle's
    // UNIQUE (org_id, start_date, end_date) is what a fixed ('default', 2026-09-01, 2026-09-30) tuple would
    // collide on — against a leftover row from a previous run of THIS suite, or against any other suite that
    // creates a September-2026 cycle in org 'default'. A run-unique org makes both impossible.
    const runSuffix = randomUUID().slice(0, 12)
    const orgId = `org-v15a-${runSuffix}`
    const userId = `u-v15a-${runSuffix}`
    let cycleId: string | undefined
    try {
      const cols = (await pool.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'attendance_payroll_cycle_settlements'`,
      )).rows as { column_name: string; is_nullable: string }[]
      // NO table-missing soft-pass (deleted 2026-08-08): an unmigrated table is a FAILURE, not a skip. This
      // suite exists to prove zzzz20260625120000_create_attendance_payroll_cycle_settlements landed; "the
      // thing I verify is absent" is the one result that must never be reported as success.
      expect(
        cols.length,
        'attendance_payroll_cycle_settlements does not exist — run '
          + 'zzzz20260625120000_create_attendance_payroll_cycle_settlements (db:migrate). A missing table is a '
          + 'failed schema lock, never a skip',
      ).toBeGreaterThan(0)
      const nullableByName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]))
      // [P1] the snapshot carries its own frozen period; [P2] source present.
      for (const c of ['period_start_date', 'period_end_date', 'closed_at', 'source', 'convertible_minutes', 'must_pay_minutes', 'snapshot']) {
        expect(nullableByName).toHaveProperty(c)
      }
      expect(nullableByName.source).toBe('NO') // [P2] source NOT NULL

      cycleId = (await pool.query(
        `INSERT INTO attendance_payroll_cycles (org_id, start_date, end_date, status)
         VALUES ($1, '2026-09-01', '2026-09-30', 'open') RETURNING id`,
        [orgId],
      )).rows[0].id as string
      const insert = (source: string | null) => pool.query(
        `INSERT INTO attendance_payroll_cycle_settlements
           (org_id, cycle_id, period_start_date, period_end_date, closed_at, user_id, source, convertible_minutes, must_pay_minutes)
         VALUES ($1, $2, '2026-09-01', '2026-09-30', now(), $3, $4, 0, 0)`,
        [orgId, cycleId, userId, source],
      )
      await insert('restday')
      // UNIQUE (org, cycle, user, source) → a duplicate source row is rejected (replay-close idempotency key).
      // The SQLSTATE is pinned: "it threw" alone would also be satisfied by an unrelated failure.
      expect(await rejectionCode(insert('restday'))).toBe(UNIQUE_VIOLATION)
      // a distinct source (incl. the legacy archive bucket) is allowed under the same cycle/user.
      await insert('legacy_unsourced')
      // [P2] source NOT NULL → a NULL source row is rejected (so the UNIQUE key can't be NULL-bypassed).
      expect(await rejectionCode(insert(null))).toBe(NOT_NULL_VIOLATION)
      // [P2 owner #3211] FK is ON DELETE RESTRICT, NOT cascade: with a settlement row present, deleting the
      // cycle is REFUSED at the DB — a cycle delete can't cascade-wipe immutable closed settlement snapshots.
      expect(
        await rejectionCode(pool.query('DELETE FROM attendance_payroll_cycles WHERE id = $1', [cycleId])),
      ).toBe(FOREIGN_KEY_VIOLATION)
    } finally {
      await pool.query('DELETE FROM attendance_payroll_cycle_settlements WHERE user_id = $1', [userId]).catch(() => undefined)
      if (cycleId) await pool.query('DELETE FROM attendance_payroll_cycles WHERE id = $1', [cycleId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })
})
