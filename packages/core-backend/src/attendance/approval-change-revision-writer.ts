/**
 * P3a-2 / P3c / P4 writers that do not depend on D51.
 *
 * Day recalculation goes through `planApprovedLeaveDayRecalcV1` before any write.
 * A legacy_repair frame and any other fingerprinted companion are reused.
 * An active row without a usable companion throws and writes nothing.
 * This module does not insert a companion, does not rewrite `attendance_records`,
 * and does not call `appendRecomputeCalculationV1` (that path replays a prior
 * calculation; it does not remove one leave). A successful correction records an
 * open recompute obligation so payroll close stays blocked until a later worker
 * finishes the day.
 *
 * Balance reversal uses document + revision + operation. It does not call
 * `reverseLeaveBalanceDeduction`.
 */

import { randomUUID } from 'node:crypto'
import { leaveRevisionReversalSourceIdV1 } from './approval-change-leave-reversal'
import {
  planApprovedLeaveDayRecalcV1,
  type ApprovedLeaveDayRecalcPlanV1,
} from './approval-change-legacy-repair'
import { closePendingApprovalRoundV1 } from './approval-change-round-close'

export interface ApprovalChangeQueryV1 {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface LeaveRevisionCorrectionInputV1 {
  readonly orgId: string
  readonly userId: string
  readonly documentId: string
  readonly revisionId: string
  readonly operationId: string
  readonly workDate: string
  readonly fingerprint: string
}

export class AttendanceRevisionCorrectionBlockedError extends Error {
  readonly code = 'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED'
  readonly httpStatus = 409

  constructor() {
    super('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED')
    this.name = 'AttendanceRevisionCorrectionBlockedError'
  }
}

function frameProbe(snapshot: unknown): { source?: unknown; fingerprint?: unknown } | null {
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot)
    } catch {
      return null
    }
  }
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const record = snapshot as { identity?: { source?: unknown }; fingerprint?: unknown }
  return { source: record.identity?.source, fingerprint: record.fingerprint }
}

export async function loadApprovedLeaveDayRecalcPlanV1(
  db: ApprovalChangeQueryV1,
  input: { readonly orgId: string; readonly userId: string; readonly workDate: string },
): Promise<ApprovedLeaveDayRecalcPlanV1> {
  const companions = await db.query(
    `SELECT c.frame_snapshot
       FROM attendance_timezone_context_companions c
       JOIN attendance_current_records r ON r.id = c.record_id AND r.org_id = c.org_id
      WHERE c.org_id = $1 AND c.user_id = $2 AND c.work_date = $3::date`,
    [input.orgId, input.userId, input.workDate],
  )
  if (companions.rows.length > 1) throw new Error('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
  const companion = companions.rows.length === 1 ? frameProbe(companions.rows[0]?.frame_snapshot) : null
  let activeRecord = companions.rows.length === 1
  if (!activeRecord) {
    const records = await db.query(
      `SELECT 1 FROM attendance_current_records
        WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
        LIMIT 1`,
      [input.orgId, input.userId, input.workDate],
    )
    activeRecord = records.rows.length > 0
  }
  return planApprovedLeaveDayRecalcV1({ activeRecord, companion })
}

async function ensureRecomputeObligationV1(
  db: ApprovalChangeQueryV1,
  input: { readonly orgId: string; readonly userId: string; readonly workDate: string; readonly sourceId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO attendance_recompute_obligations
       (id, org_id, user_id, work_date, source_kind, source_id, status)
     SELECT $1, $2, $3, $4::date, 'leave_revision', $5, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM attendance_recompute_obligations
         WHERE org_id = $2 AND user_id = $3 AND work_date = $4::date AND source_id = $5
           AND status IN ('pending', 'leased', 'failed') AND superseded_by IS NULL
      )`,
    [randomUUID(), input.orgId, input.userId, input.workDate, input.sourceId],
  )
}

/**
 * Restore minutes deducted for `documentId` under a new source id.
 * A previous reverse stored under the request id does not count.
 */
export async function reverseLeaveBalanceForRevisionV1(
  db: ApprovalChangeQueryV1,
  input: {
    readonly orgId: string
    readonly userId: string
    readonly documentId: string
    readonly revisionId: string
    readonly operationId: string
  },
): Promise<{ reversed: number; alreadyReversed: boolean }> {
  const sourceId = leaveRevisionReversalSourceIdV1(input)
  const already = await db.query(
    `SELECT 1 FROM attendance_leave_balance_events
      WHERE org_id = $1 AND user_id = $2 AND source_id = $3 AND event_type = 'reverse'
      LIMIT 1`,
    [input.orgId, input.userId, sourceId],
  )
  if (already.rows.length > 0) return { reversed: 0, alreadyReversed: true }

  const deductRows = await db.query(
    `SELECT e.balance_id, e.delta_minutes, e.source_type,
            b.remaining_minutes, b.amount_minutes, b.status,
            (b.expires_at IS NOT NULL AND b.expires_at <= now()) AS expired
       FROM attendance_leave_balance_events e
       JOIN attendance_leave_balances b
         ON b.id = e.balance_id AND b.org_id = e.org_id AND b.user_id = e.user_id
      WHERE e.org_id = $1 AND e.user_id = $2 AND e.source_id = $3 AND e.event_type = 'deduct'
      FOR UPDATE OF b`,
    [input.orgId, input.userId, input.documentId],
  )

  let reversed = 0
  for (const row of deductRows.rows) {
    const deducted = -Number(row.delta_minutes)
    if (!Number.isFinite(deducted) || deducted <= 0) continue
    if (row.expired === true || row.status === 'expired') continue
    const headroom = Number(row.amount_minutes) - Number(row.remaining_minutes)
    const restore = Math.min(deducted, headroom)
    if (!Number.isFinite(restore) || restore <= 0) continue
    const newRemaining = Number(row.remaining_minutes) + restore
    await db.query(
      `UPDATE attendance_leave_balances
          SET remaining_minutes = $1, status = 'active', updated_at = now()
        WHERE id = $2`,
      [newRemaining, row.balance_id],
    )
    await db.query(
      `INSERT INTO attendance_leave_balance_events
         (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
       VALUES ($1, $2, $3, 'reverse', $4, $5, $6)`,
      [input.orgId, input.userId, row.balance_id, restore, row.source_type, sourceId],
    )
    reversed += restore
  }
  return { reversed, alreadyReversed: false }
}

export async function applyLeaveRevisionCorrectionV1(
  db: ApprovalChangeQueryV1,
  input: LeaveRevisionCorrectionInputV1,
): Promise<{
  plan: ApprovedLeaveDayRecalcPlanV1
  reversal: { reversed: number; alreadyReversed: boolean }
  revisionInserted: boolean
}> {
  const plan = await loadApprovedLeaveDayRecalcPlanV1(db, input)
  if (plan.action === 'migration_required') throw new AttendanceRevisionCorrectionBlockedError()
  const inserted = await db.query(
    `INSERT INTO attendance_document_revisions
       (id, org_id, document_id, revision_id, operation_id, status, fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'applied', $6)
     ON CONFLICT (document_id, revision_id, operation_id) DO NOTHING
     RETURNING id`,
    [randomUUID(), input.orgId, input.documentId, input.revisionId, input.operationId, input.fingerprint],
  )
  const reversal = await reverseLeaveBalanceForRevisionV1(db, input)
  await ensureRecomputeObligationV1(db, {
    orgId: input.orgId,
    userId: input.userId,
    workDate: input.workDate,
    sourceId: input.documentId,
  })
  return { plan, reversal, revisionInserted: inserted.rows.length === 1 }
}

export async function closeApprovalRoundAsAdminV1(
  db: ApprovalChangeQueryV1,
  engineInstanceId: string,
): Promise<{ id: string } | null> {
  return closePendingApprovalRoundV1({
    query: async (sql, params) => {
      const result = await db.query(sql, params)
      return {
        rows: result.rows.map((row) => ({ id: typeof row.id === 'string' ? row.id : undefined })),
      }
    },
  }, {
    engineInstanceId,
    outcome: 'blocked',
    blockReason: 'admin_closed',
    policySnapshotAtDecision: null,
  })
}
