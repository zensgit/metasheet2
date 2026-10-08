import { sql, type Kysely } from 'kysely'

/**
 * W4C-3a: align the immutable calculation daily-status check with the
 * already-ratified calculator and attendance_records union. Non-workdays
 * calculate to `off`; omitting it made an otherwise valid authoritative row
 * impossible to persist.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_record_calculations
      DROP CONSTRAINT IF EXISTS chk_arc_projected_status
  `.execute(db)
  await sql`
    ALTER TABLE attendance_record_calculations
      ADD CONSTRAINT chk_arc_projected_status CHECK (
        projected_status IS NULL OR projected_status IN (
          'normal', 'late', 'early_leave', 'late_early',
          'partial', 'absent', 'adjusted', 'off'
        )
      )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_record_calculations
      DROP CONSTRAINT IF EXISTS chk_arc_projected_status
  `.execute(db)
  await sql`
    ALTER TABLE attendance_record_calculations
      ADD CONSTRAINT chk_arc_projected_status CHECK (
        projected_status IS NULL OR projected_status IN (
          'normal', 'late', 'early_leave', 'late_early',
          'partial', 'absent', 'adjusted'
        )
      )
  `.execute(db)
}
