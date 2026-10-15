/**
 * Roster org gate (#6045 / #6047): a queued W4 job that fails the write-time
 * active-membership recheck records USER_NOT_IN_ORG with a non-null error
 * (values-free index JSON). Existing plan-failure reasons stay status=failed
 * AND error IS NULL. The historical trigger's plan-reason list is unchanged.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const PLAN_FAILURE_REASONS = [
  'ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_VERSION_UNSUPPORTED',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED',
] as const

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

async function installCheck(db: Kysely<unknown>, includeRosterReason: boolean): Promise<void> {
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_exec_reason`.execute(db)
  const rosterClause = includeRosterReason
    ? `
      OR (
        w4_execution_reason_code = 'USER_NOT_IN_ORG' AND
        status = 'failed' AND
        error IS NOT NULL
      )`
    : ''
  await sql`
    ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_exec_reason CHECK (
      w4_execution_reason_code IS NULL OR
      (w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED' AND status = 'queued') OR
      (w4_execution_reason_code = 'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT' AND status = 'failed') OR
      (
        w4_execution_reason_code IN (${sql.raw(quoted(PLAN_FAILURE_REASONS))}) AND
        status = 'failed' AND
        error IS NULL
      )${sql.raw(rosterClause)}
    )
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await installCheck(db, true)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await installCheck(db, false)
}
