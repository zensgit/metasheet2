/**
 * Narrow day recalculation for an approved leave that is being removed.
 *
 * A finished legacy row with a frozen frame, no punches, and no other coverage
 * becomes `absent` in the caller's transaction. An open shift, a missing
 * schedule, or a day that still has punches is not rewritten into absence.
 * W4-owned rows, manual edits, and retired rows are refused before any write.
 *
 * The obligation worker is a function. Nothing here registers a timer.
 */

import { randomUUID } from 'node:crypto'

interface DayRecalcQueryV1 {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

export const RECOMPUTE_OBLIGATION_LEASE_MS_V1 = 60_000

export type LeaveDayRecalcDecisionV1 =
  | { readonly action: 'defer'; readonly reason: 'shift_open' | 'schedule_unknown' }
  | { readonly action: 'refuse'; readonly reason: 'manual_edit' | 'w4_owned' | 'retired' }
  | { readonly action: 'retain_punches' }
  | {
      readonly action: 'apply'
      readonly status: 'absent' | 'adjusted' | 'partial' | 'off'
      readonly workMinutes: 0
      readonly lateMinutes: 0
      readonly earlyLeaveMinutes: 0
    }

export interface LeaveDayRecalcFactsV1 {
  readonly now: Date
  readonly shiftEndAt: Date | null
  readonly isWorkday: boolean | null
  readonly hasFrozenFrame: boolean
  readonly hasRecord: boolean
  readonly projectionOwner: string | null
  readonly visibilityState: string | null
  readonly manualEdit: boolean
  readonly hasFirstIn: boolean
  readonly hasLastOut: boolean
  readonly otherCoverage: boolean
}

export class AttendanceDayRecalcRefusedError extends Error {
  readonly code: 'ATTENDANCE_DAY_RECALC_W4_OWNED' | 'ATTENDANCE_DAY_RECALC_MANUAL_EDIT' | 'ATTENDANCE_DAY_RECALC_RETIRED'
  readonly httpStatus = 409

  constructor(code: AttendanceDayRecalcRefusedError['code']) {
    super(code)
    this.name = 'AttendanceDayRecalcRefusedError'
    this.code = code
  }
}

const APPLIED = {
  workMinutes: 0 as const,
  lateMinutes: 0 as const,
  earlyLeaveMinutes: 0 as const,
}

export function decideLeaveDayRecalcV1(facts: LeaveDayRecalcFactsV1): LeaveDayRecalcDecisionV1 {
  if (facts.hasRecord && facts.visibilityState === 'retired') return { action: 'refuse', reason: 'retired' }
  if (facts.hasRecord && facts.projectionOwner === 'w4') return { action: 'refuse', reason: 'w4_owned' }
  if (facts.manualEdit) return { action: 'refuse', reason: 'manual_edit' }
  if (!facts.hasRecord || !facts.hasFrozenFrame || facts.isWorkday === null) {
    return { action: 'defer', reason: 'schedule_unknown' }
  }
  if (facts.shiftEndAt === null || facts.now.getTime() < facts.shiftEndAt.getTime()) {
    return { action: 'defer', reason: 'shift_open' }
  }
  if (facts.hasFirstIn && facts.hasLastOut) return { action: 'retain_punches' }
  if (!facts.isWorkday) return { action: 'apply', status: 'off', ...APPLIED }
  if (facts.hasFirstIn !== facts.hasLastOut) return { action: 'apply', status: 'partial', ...APPLIED }
  if (facts.otherCoverage) return { action: 'apply', status: 'adjusted', ...APPLIED }
  return { action: 'apply', status: 'absent', ...APPLIED }
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

function hasManualEdit(meta: unknown): boolean {
  let value = meta
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return false
    }
  }
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'manual_result_edit')
}

export async function loadLeaveDayRecalcFactsV1(
  db: DayRecalcQueryV1,
  input: { readonly orgId: string; readonly userId: string; readonly workDate: string; readonly documentId: string; readonly now: Date },
): Promise<LeaveDayRecalcFactsV1> {
  const rows = await db.query(
    `SELECT r.projection_owner, r.visibility_state, r.is_workday, r.first_in_at, r.last_out_at, r.meta,
            c.attribution_end_at, c.context_fingerprint
       FROM attendance_current_records r
       LEFT JOIN attendance_timezone_context_companions c
         ON c.record_id = r.id AND c.org_id = r.org_id
      WHERE r.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date`,
    [input.orgId, input.userId, input.workDate],
  )
  const other = await db.query(
    `SELECT 1
       FROM attendance_requests
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
        AND status = 'approved' AND id::text <> $4
        AND request_type IN ('leave', 'business_trip')
      LIMIT 1`,
    [input.orgId, input.userId, input.workDate, input.documentId],
  )
  const row = rows.rows[0]
  if (!row) {
    return {
      now: input.now,
      shiftEndAt: null,
      isWorkday: null,
      hasFrozenFrame: false,
      hasRecord: false,
      projectionOwner: null,
      visibilityState: null,
      manualEdit: false,
      hasFirstIn: false,
      hasLastOut: false,
      otherCoverage: other.rows.length > 0,
    }
  }
  return {
    now: input.now,
    shiftEndAt: asDate(row.attribution_end_at),
    isWorkday: typeof row.is_workday === 'boolean' ? row.is_workday : null,
    hasFrozenFrame: typeof row.context_fingerprint === 'string' && row.context_fingerprint.length > 0,
    hasRecord: true,
    projectionOwner: typeof row.projection_owner === 'string' ? row.projection_owner : null,
    visibilityState: typeof row.visibility_state === 'string' ? row.visibility_state : null,
    manualEdit: hasManualEdit(row.meta),
    hasFirstIn: row.first_in_at != null,
    hasLastOut: row.last_out_at != null,
    otherCoverage: other.rows.length > 0,
  }
}

export function refusalFromDecisionV1(decision: LeaveDayRecalcDecisionV1): AttendanceDayRecalcRefusedError | null {
  if (decision.action !== 'refuse') return null
  if (decision.reason === 'w4_owned') return new AttendanceDayRecalcRefusedError('ATTENDANCE_DAY_RECALC_W4_OWNED')
  if (decision.reason === 'manual_edit') return new AttendanceDayRecalcRefusedError('ATTENDANCE_DAY_RECALC_MANUAL_EDIT')
  return new AttendanceDayRecalcRefusedError('ATTENDANCE_DAY_RECALC_RETIRED')
}

/** One legacy parent update. Zero rows means the row was not a safe legacy target. */
export async function applyLegacyLeaveDayProjectionV1(
  db: DayRecalcQueryV1,
  input: {
    readonly orgId: string
    readonly userId: string
    readonly workDate: string
    readonly status: 'absent' | 'adjusted' | 'partial' | 'off'
  },
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE attendance_records
        SET status = $1,
            work_minutes = 0,
            late_minutes = 0,
            early_leave_minutes = 0,
            updated_at = now()
      WHERE org_id = $2 AND user_id = $3 AND work_date = $4::date
        AND visibility_state = 'active'
        AND projection_owner = 'legacy_untracked'
        AND current_calculation_id IS NULL
        AND NOT (COALESCE(meta, '{}'::jsonb) ? 'manual_result_edit')
      RETURNING id`,
    [input.status, input.orgId, input.userId, input.workDate],
  )
  return updated.rows.length === 1
}

export async function recordLeaveRevisionObligationV1(
  db: DayRecalcQueryV1,
  input: {
    readonly orgId: string
    readonly userId: string
    readonly workDate: string
    readonly sourceId: string
    readonly status: 'pending' | 'completed'
    readonly dueAt: Date | null
    readonly decision: string
  },
): Promise<void> {
  await db.query(
    `INSERT INTO attendance_recompute_obligations
       (id, org_id, user_id, work_date, source_kind, source_id, status, due_at, decision)
     SELECT $1, $2, $3, $4::date, 'leave_revision', $5, $6, $7, $8
      WHERE NOT EXISTS (
        SELECT 1 FROM attendance_recompute_obligations
         WHERE org_id = $2 AND user_id = $3 AND work_date = $4::date AND source_id = $5
           AND status IN ('pending', 'leased', 'failed') AND superseded_by IS NULL
      )`,
    [
      randomUUID(),
      input.orgId,
      input.userId,
      input.workDate,
      input.sourceId,
      input.status,
      input.dueAt ? input.dueAt.toISOString() : null,
      input.decision,
    ],
  )
}

export async function consumeOneDueRecomputeObligationV1(
  db: DayRecalcQueryV1,
  input: { readonly now: Date; readonly orgId: string },
): Promise<{ id: string; decision: string } | null> {
  const staleBefore = new Date(input.now.getTime() - RECOMPUTE_OBLIGATION_LEASE_MS_V1).toISOString()
  await db.query(
    `UPDATE attendance_recompute_obligations
        SET status = 'pending', leased_at = NULL, updated_at = now()
      WHERE org_id = $2 AND status = 'leased' AND leased_at IS NOT NULL AND leased_at <= $1::timestamptz`,
    [staleBefore, input.orgId],
  )
  const leased = await db.query(
    `UPDATE attendance_recompute_obligations
        SET status = 'leased', leased_at = $1::timestamptz, attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM attendance_recompute_obligations
         WHERE org_id = $2 AND status = 'pending' AND superseded_by IS NULL
           AND due_at IS NOT NULL AND due_at <= $1::timestamptz
         ORDER BY due_at, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id, org_id, user_id, work_date::text AS work_date, source_id`,
    [input.now.toISOString(), input.orgId],
  )
  const job = leased.rows[0]
  if (!job || typeof job.id !== 'string') return null
  const orgId = String(job.org_id)
  const userId = String(job.user_id)
  const workDate = String(job.work_date).slice(0, 10)
  const sourceId = String(job.source_id)
  const facts = await loadLeaveDayRecalcFactsV1(db, { orgId, userId, workDate, documentId: sourceId, now: input.now })
  const decision = decideLeaveDayRecalcV1(facts)
  if (decision.action === 'apply') {
    const wrote = await applyLegacyLeaveDayProjectionV1(db, { orgId, userId, workDate, status: decision.status })
    await db.query(
      `UPDATE attendance_recompute_obligations
          SET status = $2, decision = $3, leased_at = NULL, updated_at = now()
        WHERE id = $1::uuid AND status = 'leased'`,
      [job.id, wrote ? 'completed' : 'failed', wrote ? decision.status : 'projection_not_applied'],
    )
    return { id: job.id, decision: wrote ? decision.status : 'projection_not_applied' }
  }
  const nextStatus = decision.action === 'refuse' ? 'failed' : 'pending'
  const label = decision.action === 'defer' ? decision.reason : decision.action === 'refuse' ? decision.reason : 'retain_punches'
  await db.query(
    `UPDATE attendance_recompute_obligations
        SET status = $2, decision = $3, leased_at = NULL, updated_at = now()
      WHERE id = $1::uuid AND status = 'leased'`,
    [job.id, nextStatus, label],
  )
  return { id: job.id, decision: label }
}
