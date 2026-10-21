import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * A completed obligation is the receipt that the day projection and the
 * barrier update landed together. `completed` is outside the payroll barrier.
 * `due_at` is when a pending row may be leased. Additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_recompute_obligations
      ADD COLUMN IF NOT EXISTS due_at timestamptz,
      ADD COLUMN IF NOT EXISTS leased_at timestamptz,
      ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS decision text
  `.execute(db)
  await sql`ALTER TABLE attendance_recompute_obligations DROP CONSTRAINT IF EXISTS attendance_recompute_obligations_status_check`.execute(db)
  await sql`
    ALTER TABLE attendance_recompute_obligations
      ADD CONSTRAINT attendance_recompute_obligations_status_check
      CHECK (status IN ('pending', 'leased', 'failed', 'completed'))
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
  await sql`ALTER TABLE attendance_recompute_obligations DROP CONSTRAINT IF EXISTS attendance_recompute_obligations_status_check`.execute(db)
  await sql`
    ALTER TABLE attendance_recompute_obligations
      ADD CONSTRAINT attendance_recompute_obligations_status_check
      CHECK (status IN ('pending', 'leased', 'failed'))
  `.execute(db)
  await sql`
    ALTER TABLE attendance_recompute_obligations
      DROP COLUMN IF EXISTS decision,
      DROP COLUMN IF EXISTS attempt_count,
      DROP COLUMN IF EXISTS leased_at,
      DROP COLUMN IF EXISTS due_at
  `.execute(db)
}
