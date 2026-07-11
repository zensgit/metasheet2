/**
 * §7.6 Delivery Closure — OPERATOR-INITIATED redelivery of a single failed attendance-notification
 * outbox row (`attendance_notification_deliveries`).
 *
 * Doctrine (owner-ratified, roadmap §7.2/§7.6 — every guardrail below is load-bearing and covered
 * by a mutation-replay test in attendance-notification-redelivery.db.test.ts):
 *
 *  - Redelivery is OPERATOR-INITIATED ONLY. This function is invoked from the admin route
 *    (POST /api/attendance-admin/notification-deliveries/:id/redeliver) and NOWHERE else. There is
 *    NO background job, scheduler, or worker path that calls it. The delivery worker
 *    (AttendanceNotificationDeliveryWorker) only ever claims `pending`/`retrying` (and re-claims a
 *    lease-expired `sending`) — it NEVER moves a terminal `failed` row back to `pending`. The only
 *    failed→pending transition in the system is this explicit request.
 *
 *  - Eligibility is STRICTLY `status = 'failed'`. That is the single load-bearing gate: the
 *    UPDATE's `AND status = 'failed'` predicate. Requeuing flips the SAME row `failed → pending`
 *    (attempt_count reset to 0 for a fresh operator-requested cycle, next_attempt_at = now); the
 *    worker's deliver() calls channel.send() before any attempt-count classification, so exactly
 *    ONE genuine new send follows.
 *
 *  - source_key dedup is honored BY CONSTRUCTION: (org_id, source_key) is UNIQUE, so there is at
 *    most one row per logical destination. We flip that existing row's status — we NEVER insert a
 *    new row — so redelivery can never create a duplicate send to a destination. An
 *    already-succeeded destination is a `sent` row; the `status='failed'` gate skips it, nothing is
 *    sent, and the caller gets `already_delivered` (the existing success), not a resend.
 *
 *  - `outcome_unknown` is NEVER resent. Its send was attempted and the response was lost — it may
 *    well have been delivered, and a resend on ambiguity is a duplicate-notification hazard. It is
 *    a DISTINCT operator-review category (`refused_outcome_unknown`), not a redelivery target; the
 *    `status='failed'` gate excludes it and we surface it as its own outcome, never as a failure to
 *    resend.
 *
 * Import-side-effect-free (no pool/scheduler): the caller injects the query function, same
 * discipline as the DingTalk approval-card accessor.
 */

type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type AttendanceRedeliveryOutcome =
  /** failed → pending: requeued for exactly one operator-requested worker send. */
  | 'requeued'
  /** already `sent`: no-op, nothing sent — the destination already received it (dedup no-op). */
  | 'already_delivered'
  /** `outcome_unknown`: refused — may already have been delivered; never resent (manual review). */
  | 'refused_outcome_unknown'
  /** pending / sending / retrying / skipped: not a redelivery target. */
  | 'not_eligible'
  /** no such delivery row. */
  | 'not_found'

export interface AttendanceRedeliveryResult {
  outcome: AttendanceRedeliveryOutcome
  id: string
  /** The current (post-op) status of the row, or null when not found. */
  status: string | null
}

/**
 * Requeue a single FAILED attendance-notification delivery for exactly one operator-requested
 * resend. See the file header for the full doctrine. Pure state-machine transition on the outbox
 * row; the actual send is performed by AttendanceNotificationDeliveryWorker when it next claims the
 * now-`pending` row.
 */
export async function redeliverFailedAttendanceNotification(
  query: QueryFn,
  id: string,
): Promise<AttendanceRedeliveryResult> {
  const trimmed = id.trim()
  if (trimmed.length === 0) return { outcome: 'not_found', id, status: null }

  // Single load-bearing eligibility gate: `AND status = 'failed'`. A `sent` (already-delivered),
  // `outcome_unknown` (never-resend), `skipped`, `pending`, `sending`, or `retrying` row does not
  // match, so this writes NOTHING for them — no resend, no duplicate row. attempt_count resets to 0
  // so the operator's explicit redelivery gets a fresh retry budget rather than an instant re-fail.
  const updated = await query(
    `UPDATE attendance_notification_deliveries
        SET status = 'pending',
            attempt_count = 0,
            next_attempt_at = NOW(),
            last_error = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            claim_worker_id = NULL,
            updated_at = NOW()
      WHERE id = $1::uuid
        AND status = 'failed'
      RETURNING status`,
    [trimmed],
  )
  if (Number(updated.rowCount ?? 0) === 1) {
    return { outcome: 'requeued', id: trimmed, status: 'pending' }
  }

  // Not requeued — read the row to classify the outcome for the operator (why it was ineligible).
  const read = await query(
    `SELECT status FROM attendance_notification_deliveries WHERE id = $1::uuid`,
    [trimmed],
  )
  if (read.rows.length === 0) return { outcome: 'not_found', id: trimmed, status: null }
  const status = String((read.rows[0] as { status: string }).status)
  if (status === 'sent') return { outcome: 'already_delivered', id: trimmed, status }
  if (status === 'outcome_unknown') return { outcome: 'refused_outcome_unknown', id: trimmed, status }
  return { outcome: 'not_eligible', id: trimmed, status }
}
