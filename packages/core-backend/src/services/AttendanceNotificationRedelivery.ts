/**
 * §7.6 Delivery Closure — OPERATOR-INITIATED redelivery of a single failed attendance-notification
 * outbox row (`attendance_notification_deliveries`).
 *
 * Doctrine (owner-ratified, roadmap §7.2/§7.6; PR #4102 owner CHANGES-REQUESTED — every guardrail
 * below is load-bearing and covered by a mutation-replay test in
 * attendance-notification-redelivery.db.test.ts):
 *
 *  - Redelivery is OPERATOR-INITIATED ONLY. This function is invoked from the admin route
 *    (POST /api/attendance-admin/notification-deliveries/:id/redeliver) and NOWHERE else. There is
 *    NO background job, scheduler, or worker path that calls it. The delivery worker
 *    (AttendanceNotificationDeliveryWorker) only ever claims `pending`/`retrying` (and re-claims a
 *    lease-expired `sending`) — it NEVER moves a terminal `failed` row back to `pending`. The only
 *    failed→pending transition in the system is this explicit request.
 *
 *  - Eligibility is a THREE-predicate gate:
 *        status = 'failed'
 *          AND channel = 'dingtalk_work_notification'
 *          AND redelivery_safe = true
 *    RETRACTION (this replaces the earlier, WRONG doctrine that the single `AND status='failed'`
 *    predicate was the sole load-bearing gate): `status='failed'` alone is CONTAMINATED and cannot
 *    prove a row is safe to resend, because attendance_notification_deliveries is a MULTI-CHANNEL
 *    shared outbox:
 *      1. Pre-#4046 DingTalk timeouts/5xx were recorded as `failed` before the `outcome_unknown`
 *         vocabulary existed — those sends may already have been delivered (ambiguous).
 *      2. WeCom / Email transports never emit the `outcome_unknown` marker, so a `failed` row on
 *         those channels can equally be an ambiguous (already-delivered) send.
 *    Redelivering either class risks a DUPLICATE notification — even within a single org. So we
 *    additionally require the row to be a DingTalk row AND carry the worker-set `redelivery_safe`
 *    flag, which markFailed sets true IFF the row is a DEFINITE (non-ambiguous) DingTalk
 *    non-delivery. An ambiguous DingTalk result never reaches markFailed — deliver() routes it to
 *    markOutcomeUnknown, which leaves redelivery_safe=false — so this gate can never resend an
 *    ambiguous row. Requeuing flips the SAME row `failed → pending` (attempt_count reset to 0 for a
 *    fresh operator-requested cycle, next_attempt_at = now). The invariant is per-CYCLE, not
 *    per-send: each operator action creates exactly ONE redelivery cycle; the worker's deliver()
 *    calls channel.send() once per attempt, and the fresh retry budget means a *retryable* failure
 *    may span several worker attempts within that one cycle. An ambiguous result is NEVER retried —
 *    it routes to markOutcomeUnknown (not markFailed), so no ambiguous send can be resent.
 *
 *  - source_key dedup is honored BY CONSTRUCTION: (org_id, source_key) is UNIQUE, so there is at
 *    most one row per logical destination. We flip that existing row's status — we NEVER insert a
 *    new row — so redelivery can never create a duplicate row for a destination. An
 *    already-succeeded destination is a `sent` row; the gate skips it, nothing is sent, and the
 *    caller gets `already_delivered` (the existing success), not a resend.
 *
 *  - `outcome_unknown` is NEVER resent. Its send was attempted and the response was lost — it may
 *    well have been delivered, and a resend on ambiguity is a duplicate-notification hazard. It is a
 *    DISTINCT operator-review category (`refused_outcome_unknown`), not a redelivery target; the gate
 *    excludes it and we surface it as its own outcome, never as a failure to resend.
 *
 *  - A `failed` row that is NOT redelivery-safe (historical/pre-flag DingTalk failure, or any
 *    WeCom/Email failure) classifies as `not_eligible` — the same operator-review outcome as
 *    pending/sending/retrying/skipped. We deliberately do NOT invent a new outcome variant per
 *    contamination reason: the operator's action is identical (do not auto-resend; reconcile
 *    manually), so one `not_eligible` bucket keeps the surface small.
 *
 * Import-side-effect-free (no pool/scheduler): the caller injects the query function, same
 * discipline as the DingTalk approval-card accessor. The DingTalk channel name is inlined as a
 * literal (= DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME in AttendanceNotificationDeliveryWorker) to
 * keep this module free of the heavy worker import graph; the exact predicate text is pinned by a
 * mutation-replay test.
 */

type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type AttendanceRedeliveryOutcome =
  /** failed + dingtalk + redelivery_safe → pending: requeued for exactly one operator-requested send. */
  | 'requeued'
  /** already `sent`: no-op, nothing sent — the destination already received it (dedup no-op). */
  | 'already_delivered'
  /** `outcome_unknown`: refused — may already have been delivered; never resent (manual review). */
  | 'refused_outcome_unknown'
  /** failed-but-not-safe / non-dingtalk / pending / sending / retrying / skipped: not a redelivery target. */
  | 'not_eligible'
  /** no such delivery row. */
  | 'not_found'

export interface AttendanceRedeliveryResult {
  outcome: AttendanceRedeliveryOutcome
  id: string
  /** The current (post-op) status of the row, or null when not found. */
  status: string | null
  /** The row's status BEFORE this operation (for the values-free audit trail). Null when not found. */
  previousStatus: string | null
  /** The row's org_id (values-free audit metadata). Null when not found. */
  orgId: string | null
  /** The row's channel (values-free audit metadata). Null when not found. */
  channel: string | null
}

/**
 * Requeue a single FAILED, redelivery-safe DingTalk attendance-notification delivery for exactly one
 * operator-requested resend. See the file header for the full doctrine. Pure state-machine
 * transition on the outbox row; the actual send is performed by AttendanceNotificationDeliveryWorker
 * when it next claims the now-`pending` row.
 */
export async function redeliverFailedAttendanceNotification(
  query: QueryFn,
  id: string,
): Promise<AttendanceRedeliveryResult> {
  const trimmed = id.trim()
  if (trimmed.length === 0) {
    return { outcome: 'not_found', id, status: null, previousStatus: null, orgId: null, channel: null }
  }

  // THREE load-bearing eligibility predicates (each pinned by a mutation-replay test):
  //   status = 'failed'                          — only a terminal failure is a redelivery candidate.
  //   channel = 'dingtalk_work_notification'     — WeCom/Email `failed` rows may be ambiguous sends.
  //   redelivery_safe = true                     — set by markFailed ONLY for a DEFINITE (non-
  //                                                ambiguous) DingTalk non-delivery; historical/
  //                                                pre-#4046 rows are false and stay ineligible.
  // A row failing ANY predicate matches nothing here, so this writes NOTHING for it — no resend, no
  // duplicate row. attempt_count resets to 0 so the operator's explicit redelivery gets a fresh
  // retry budget rather than an instant re-fail.
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
        AND channel = 'dingtalk_work_notification'
        AND redelivery_safe = true
      RETURNING org_id, channel`,
    [trimmed],
  )
  if (Number(updated.rowCount ?? 0) === 1) {
    const row = updated.rows[0] as { org_id: string; channel: string }
    return {
      outcome: 'requeued',
      id: trimmed,
      status: 'pending',
      previousStatus: 'failed',
      orgId: row.org_id ?? null,
      channel: row.channel ?? null,
    }
  }

  // Not requeued — read the row to classify the outcome for the operator (why it was ineligible) and
  // to carry values-free audit metadata (org_id, channel, prior status).
  const read = await query(
    `SELECT status, org_id, channel, redelivery_safe
       FROM attendance_notification_deliveries WHERE id = $1::uuid`,
    [trimmed],
  )
  if (read.rows.length === 0) {
    return { outcome: 'not_found', id: trimmed, status: null, previousStatus: null, orgId: null, channel: null }
  }
  const row = read.rows[0] as { status: string; org_id: string; channel: string; redelivery_safe: boolean }
  const status = String(row.status)
  const base = {
    id: trimmed,
    status,
    previousStatus: status,
    orgId: row.org_id ?? null,
    channel: row.channel ?? null,
  }
  if (status === 'sent') return { outcome: 'already_delivered', ...base }
  if (status === 'outcome_unknown') return { outcome: 'refused_outcome_unknown', ...base }
  // Everything else — including a `failed` row that is not redelivery-safe or on a non-DingTalk
  // channel — is a single `not_eligible` operator-review bucket (see header).
  return { outcome: 'not_eligible', ...base }
}
