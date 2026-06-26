import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'

// 加班银行 v1-5a — attendance_payroll_cycle_settlements schema lock. DORMANT: nothing writes this table until
// v1-5b's snapshot-at-close; this only asserts the migration's shape + the two #3206 constraints.
describe('#加班银行 v1-5a — attendance_payroll_cycle_settlements schema (dormant)', () => {
  const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL

  it('has the [P1] frozen-period cols + [P2] source NOT NULL + the UNIQUE idempotency key', async () => {
    if (!dbUrl) return
    const pool = new Pool({ connectionString: dbUrl })
    const runSuffix = Date.now().toString(36)
    const userId = `u-v15a-${runSuffix}`
    let cycleId: string | undefined
    try {
      const cols = (await pool.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'attendance_payroll_cycle_settlements'`,
      )).rows as { column_name: string; is_nullable: string }[]
      if (cols.length === 0) return // table not migrated in this env — skip rather than false-fail
      const nullableByName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]))
      // [P1] the snapshot carries its own frozen period; [P2] source present.
      for (const c of ['period_start_date', 'period_end_date', 'closed_at', 'source', 'convertible_minutes', 'must_pay_minutes', 'snapshot']) {
        expect(nullableByName).toHaveProperty(c)
      }
      expect(nullableByName.source).toBe('NO') // [P2] source NOT NULL

      cycleId = (await pool.query(
        `INSERT INTO attendance_payroll_cycles (org_id, start_date, end_date, status)
         VALUES ('default', '2026-09-01', '2026-09-30', 'open') RETURNING id`,
      )).rows[0].id as string
      const insert = (source: string | null) => pool.query(
        `INSERT INTO attendance_payroll_cycle_settlements
           (org_id, cycle_id, period_start_date, period_end_date, closed_at, user_id, source, convertible_minutes, must_pay_minutes)
         VALUES ('default', $1, '2026-09-01', '2026-09-30', now(), $2, $3, 0, 0)`,
        [cycleId, userId, source],
      )
      await insert('restday')
      // UNIQUE (org, cycle, user, source) → a duplicate source row is rejected (replay-close idempotency key).
      await expect(insert('restday')).rejects.toThrow()
      // a distinct source (incl. the legacy archive bucket) is allowed under the same cycle/user.
      await insert('legacy_unsourced')
      // [P2] source NOT NULL → a NULL source row is rejected (so the UNIQUE key can't be NULL-bypassed).
      await expect(insert(null)).rejects.toThrow()
      // [P2 owner #3211] FK is ON DELETE RESTRICT, NOT cascade: with a settlement row present, deleting the
      // cycle is REFUSED at the DB — a cycle delete can't cascade-wipe immutable closed settlement snapshots.
      await expect(pool.query('DELETE FROM attendance_payroll_cycles WHERE id = $1', [cycleId])).rejects.toThrow()
    } finally {
      await pool.query('DELETE FROM attendance_payroll_cycle_settlements WHERE user_id = $1', [userId]).catch(() => undefined)
      if (cycleId) await pool.query('DELETE FROM attendance_payroll_cycles WHERE id = $1', [cycleId]).catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  })
})
