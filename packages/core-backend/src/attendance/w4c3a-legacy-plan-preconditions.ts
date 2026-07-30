import {
  AttendanceLegacyExecutionPlanError,
  computeLegacyImportRecordPreconditionFingerprintV1,
  legacyImportRecordWriteExpectsExistingRecordV1,
  type LegacyImportRecordPreconditionV1,
  type LegacyImportRecordWritePlanV1,
} from './w4c3a-legacy-execution-plan'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'

type QueryRow = Record<string, unknown>

class AttendanceLegacyRecordPreconditionRowError extends Error {}

function canonicalDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10)
  }
  throw new AttendanceLegacyRecordPreconditionRowError()
}

function canonicalInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return parsed.toISOString()
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return value
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return Number(value)
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null) return null
  if (typeof value !== 'boolean') {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return value
}

function recordPrecondition(row: QueryRow): LegacyImportRecordPreconditionV1 {
  return {
    exists: true,
    id: requiredString(row.id),
    orgId: requiredString(row.org_id),
    userId: requiredString(row.user_id),
    workDate: canonicalDate(row.work_date),
    firstInAt: canonicalInstant(row.first_in_at),
    lastOutAt: canonicalInstant(row.last_out_at),
    workMinutes: nullableNonNegativeInteger(row.work_minutes),
    lateMinutes: nullableNonNegativeInteger(row.late_minutes),
    earlyLeaveMinutes: nullableNonNegativeInteger(row.early_leave_minutes),
    status: nullableString(row.status),
    isWorkday: nullableBoolean(row.is_workday),
    meta: row.meta ?? null,
    sourceBatchId: nullableString(row.source_batch_id),
  }
}

function revisionMatches(
  rows: readonly QueryRow[],
  expectedRevision: number,
): boolean {
  if (rows.length !== 1) return false
  const revision = Number(rows[0]?.revision)
  return (
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    revision === expectedRevision
  )
}

const LOCK_RECORD_SQL = `
  SELECT id::text AS id, org_id, user_id, work_date::text AS work_date,
         first_in_at, last_out_at, work_minutes, late_minutes,
         early_leave_minutes, status, is_workday, meta,
         source_batch_id::text AS source_batch_id
  FROM attendance_records
  WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
  FOR UPDATE
`

const LOCK_REVISION_SQL = `
  SELECT revision::text AS revision
  FROM attendance_record_target_revisions
  WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
  FOR UPDATE
`

const READ_RECORD_EXISTENCE_SQL = `
  SELECT 1 AS present
  FROM attendance_records
  WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
  LIMIT 1
`

async function recheckExistingRecord(
  trx: AttendanceW4TransactionClientV1,
  write: LegacyImportRecordWritePlanV1,
): Promise<boolean> {
  const values = [write.orgId, write.userId, write.workDate]
  const recordRows = (await trx.query(LOCK_RECORD_SQL, values))
    .rows as QueryRow[]
  if (recordRows.length !== 1 || recordRows[0]?.id !== write.recordId) {
    return false
  }
  const revisionRows = (await trx.query(LOCK_REVISION_SQL, values))
    .rows as QueryRow[]
  if (!revisionMatches(revisionRows, write.targetRevision)) return false

  try {
    const precondition = recordPrecondition(recordRows[0])
    if (precondition.sourceBatchId !== write.expectedSourceOwnership) {
      return false
    }
    return (
      computeLegacyImportRecordPreconditionFingerprintV1(precondition) ===
      write.existingRecordPreconditionFingerprint
    )
  } catch (error) {
    if (
      error instanceof AttendanceLegacyRecordPreconditionRowError ||
      error instanceof AttendanceLegacyExecutionPlanError
    ) {
      return false
    }
    throw error
  }
}

async function recheckMissingRecord(
  trx: AttendanceW4TransactionClientV1,
  write: LegacyImportRecordWritePlanV1,
): Promise<boolean> {
  if (write.expectedSourceOwnership !== null) return false
  const values = [write.orgId, write.userId, write.workDate]
  const revisionRows = (await trx.query(LOCK_REVISION_SQL, values))
    .rows as QueryRow[]
  if (!revisionMatches(revisionRows, write.targetRevision)) return false
  const recordRows = (await trx.query(READ_RECORD_EXISTENCE_SQL, values)).rows
  return recordRows.length === 0
}

/**
 * Locks and rechecks every frozen record target in verified plan order.
 * SQL errors intentionally escape to the governing whole-transaction retry.
 */
export async function lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<boolean> {
  for (const write of plan.recordWrites) {
    const matches = legacyImportRecordWriteExpectsExistingRecordV1(write)
      ? await recheckExistingRecord(trx, write)
      : await recheckMissingRecord(trx, write)
    if (!matches) return false
  }
  return true
}
