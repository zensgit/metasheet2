import { APPROVAL_TERMINAL_STATUSES } from '../types/approval-product'

/**
 * 我发起的 — "a new outcome on a request of mine I have not seen yet" (test report 2026-10-08, T6).
 *
 * An `approval_instances` condition correlated on `${instanceRef}.id`, used verbatim by the
 * new-outcome count (`ApprovalBridgeService.countMineOutcomesUnseenForViewer`: the 我发起的 feed with
 * this one conjunct appended) and by the per-row `outcomeUnseen` flag of that feed, so the badge
 * equals the number of rows the tab marks and never exceeds its total.
 *
 * RULE. All of:
 *   1. the viewer is the requester (`requester_snapshot->>'id'`, the 我发起的 tab's own test);
 *   2. the instance's CURRENT status is terminal (`APPROVAL_TERMINAL_STATUSES`);
 *   3. its OUTCOME RECORD exists — the newest `approval_records` row (by `occurred_at`, then `id`)
 *      that moved the instance INTO that current status: `to_status = status`,
 *      `from_status IS DISTINCT FROM to_status`, and not one of the bookkeeping actions written
 *      alongside a decision (`sign` — the aggregate / parallel cancellation rows written by
 *      `system` in the same transaction as the decisive approve, AFTER it, with the same
 *      timestamp; `cc` / `comment` / `remind` repeat the current status and never qualify anyway).
 *      Without the `sign` exclusion a request the requester approved themselves would read as
 *      decided by `system`;
 *   4. the outcome record's actor is NOT the viewer — withdrawing, rejecting or approving your own
 *      request is not news to you (the tester of this report rejected their own requests, which
 *      this rule deliberately does not badge);
 *   5. the viewer has no `approval_reads` row at or after the outcome record's `occurred_at` —
 *      a requester who opened the request while it was still pending must still see the outcome.
 *
 * The rule reads the audit rows, not the completion event, so it also covers terminal paths that
 * emit no completion event (a return that ends the flow), the scheduler's timeout jump and the
 * admin jump, without any new event. A terminal instance with no qualifying outcome record
 * (imported or externally mirrored data with no audit trail) is never badged.
 *
 * CANCEL ROUNDS. A cancel round badges once — the round itself, when someone else approves it —
 * only because the original request's `approved → cancelled` `revoke` row carries the round's
 * requester (= the original requester) as its actor, a choice ApprovalProductService's cancel-round
 * redemption still flags for owner registration. If the owner registers the approver or a system
 * sentinel there instead, the original request badges as well (two badges for one revocation):
 * revisit this rule together with that registration.
 *
 * Shares `approval_reads` with the 待我处理 / 抄送 unread states (no new table, by decision), and the
 * same documented transaction-start timestamp race as `approvalCcUnreadConditionSql`: a mark-read
 * that commits while the deciding transaction is still open can mark that outcome seen.
 */
const TERMINAL_STATUS_SQL = APPROVAL_TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')
const OUTCOME_BOOKKEEPING_ACTIONS_SQL = ['sign', 'cc', 'comment', 'remind'].map((action) => `'${action}'`).join(', ')

export function approvalMineOutcomeUnseenConditionSql(placeholders: {
  instanceRef: string
  /** Placeholder number bound to the viewer's id. */
  actorParam: number
}): string {
  const { instanceRef, actorParam } = placeholders
  return `(
              ${instanceRef}.requester_snapshot->>'id' = $${actorParam}
              AND ${instanceRef}.status IN (${TERMINAL_STATUS_SQL})
              AND EXISTS (
                SELECT 1
                FROM (
                  SELECT outcome_rec.actor_id, outcome_rec.occurred_at
                  FROM approval_records outcome_rec
                  WHERE outcome_rec.instance_id = ${instanceRef}.id
                    AND outcome_rec.to_status = ${instanceRef}.status
                    AND outcome_rec.from_status IS DISTINCT FROM outcome_rec.to_status
                    AND outcome_rec.action NOT IN (${OUTCOME_BOOKKEEPING_ACTIONS_SQL})
                  ORDER BY outcome_rec.occurred_at DESC, outcome_rec.id DESC
                  LIMIT 1
                ) latest_outcome
                WHERE latest_outcome.actor_id IS DISTINCT FROM $${actorParam}
                  AND NOT EXISTS (
                    SELECT 1
                    FROM approval_reads outcome_read
                    WHERE outcome_read.instance_id = ${instanceRef}.id
                      AND outcome_read.user_id = $${actorParam}
                      AND outcome_read.read_at >= latest_outcome.occurred_at
                  )
              )
            )`
}
