/**
 * W4C-3a fixed record-effect adapter for verified durable plans.
 *
 * Preconditions are locked/rechecked elsewhere. This module only applies the
 * frozen recordWrites on a VerifiedAttendanceLegacyPlanV1: UPDATE for the
 * existing branch and INSERT (no ON CONFLICT) for the missing branch. It never
 * rereads rules/settings/profile/source, recomputes metrics, handles groups, or
 * wires worker/routes.
 */
import {
  legacyImportRecordWriteExpectsExistingRecordV1,
  type LegacyImportRecordWritePlanV1,
} from './w4c3a-legacy-execution-plan'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'

export class AttendanceLegacyRecordEffectError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceLegacyRecordEffectError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceLegacyRecordEffectError(code)
}

const UPDATE_EXISTING_RECORD_SQL = `
  UPDATE attendance_records
  SET timezone = $5,
      first_in_at = $6::timestamptz,
      last_out_at = $7::timestamptz,
      work_minutes = $8,
      late_minutes = $9,
      early_leave_minutes = $10,
      status = $11,
      is_workday = $12,
      meta = $13::jsonb,
      source_batch_id = $14::uuid,
      updated_at = now()
  WHERE id = $1::uuid
    AND org_id = $2
    AND user_id = $3
    AND work_date = $4::date
  RETURNING id::text AS id
`

const INSERT_MISSING_RECORD_SQL = `
  INSERT INTO attendance_records
    (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
     work_minutes, late_minutes, early_leave_minutes, status, is_workday,
     meta, source_batch_id, updated_at)
  VALUES
    ($1::uuid, $2, $3, $4::date, $5, $6::timestamptz, $7::timestamptz,
     $8, $9, $10, $11, $12, $13::jsonb, $14::uuid, now())
  RETURNING id::text AS id
`

function effectParams(write: LegacyImportRecordWritePlanV1): unknown[] {
  return [
    write.recordId,
    write.userId,
    write.orgId,
    write.workDate,
    write.timezone,
    write.firstInAt,
    write.lastOutAt,
    write.workMinutes,
    write.lateMinutes,
    write.earlyLeaveMinutes,
    write.status,
    write.isWorkday,
    JSON.stringify(write.compatibilityMetadata),
    write.sourceBatchId,
  ]
}

function existingUpdateParams(write: LegacyImportRecordWritePlanV1): unknown[] {
  // Identity first so the WHERE clause binds id+org+user+workDate exactly.
  return [
    write.recordId,
    write.orgId,
    write.userId,
    write.workDate,
    write.timezone,
    write.firstInAt,
    write.lastOutAt,
    write.workMinutes,
    write.lateMinutes,
    write.earlyLeaveMinutes,
    write.status,
    write.isWorkday,
    JSON.stringify(write.compatibilityMetadata),
    write.sourceBatchId,
  ]
}

function requireReturnedRecordId(
  rows: ReadonlyArray<Record<string, unknown>>,
  expectedRecordId: string,
): void {
  if (rows.length !== 1 || rows[0]?.id !== expectedRecordId) {
    fail('W4C3A_RECORD_EFFECT_ROW_MISMATCH')
  }
}

/**
 * Applies frozen recordWrites from a verified plan only.
 * Empty plan.recordWrites performs zero SQL.
 */
export async function applyAttendanceLegacyRecordEffectsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<void> {
  if (plan.recordWrites.length === 0) return

  for (const write of plan.recordWrites) {
    if (legacyImportRecordWriteExpectsExistingRecordV1(write)) {
      const result = await trx.query(
        UPDATE_EXISTING_RECORD_SQL,
        existingUpdateParams(write),
      )
      requireReturnedRecordId(result.rows, write.recordId)
      continue
    }

    const result = await trx.query(INSERT_MISSING_RECORD_SQL, effectParams(write))
    requireReturnedRecordId(result.rows, write.recordId)
  }
}
