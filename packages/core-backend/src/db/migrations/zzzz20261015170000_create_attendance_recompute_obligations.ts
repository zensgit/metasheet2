import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Open day-recalculation obligations. Payroll close refuses while any row in the
 * cycle is still pending, leased, or failed and has not been superseded.
 * Additive. `down` refuses while rows exist, then drops the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_recompute_obligations (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      work_date date NOT NULL,
      source_kind text NOT NULL,
      source_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'leased', 'failed')),
      superseded_by uuid NULL REFERENCES attendance_recompute_obligations (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_recompute_obligations_open
      ON attendance_recompute_obligations (org_id, work_date)
      WHERE superseded_by IS NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.attendance_recompute_obligations') IS NOT NULL
         AND EXISTS (SELECT 1 FROM attendance_recompute_obligations) THEN
        RAISE EXCEPTION 'attendance_recompute_obligations is not empty';
      END IF;
    END $$
  `.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_recompute_obligations`.execute(db)
}
