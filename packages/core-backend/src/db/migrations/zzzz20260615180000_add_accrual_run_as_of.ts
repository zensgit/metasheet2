import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

const RUNS = 'attendance_leave_accrual_runs'

// 年假/法定假 L2b ([P2-1], design-lock #2622 + dev-verification report 2026-06-15). The accrual-run
// header needs the EVALUATION date (asOf) stored SEPARATELY from occurred_at (execution time): a
// back-dated run — period=2026 evaluated as-of 2026-07-01 but actually executed later — must keep the
// two distinct so the audit is clean (occurred_at = when it ran; as_of = the date eligibility/tenure
// were judged against). L2a's runs table is latent/empty (no writer exists until the L2b engine lands
// in this same slice, and this migration runs before it), so ADD COLUMN ... NOT NULL is safe.
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, RUNS)
  if (!exists) return
  await sql`ALTER TABLE attendance_leave_accrual_runs ADD COLUMN IF NOT EXISTS as_of date NOT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, RUNS)
  if (!exists) return
  await sql`ALTER TABLE attendance_leave_accrual_runs DROP COLUMN IF EXISTS as_of`.execute(db)
}
