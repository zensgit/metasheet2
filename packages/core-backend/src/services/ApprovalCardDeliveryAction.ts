/**
 * A-4 core (one-tap lock #3594 §4): the card-delivery action wrapper — the ONLY execution path for
 * card-originated approval decisions. Both fronts share it: the Slice-A mobile decision page
 * (session actor) and the Slice-B Stream callback (DingTalk actor, mapped fail-closed).
 *
 * Hard rules it encodes (owner-ratified):
 * - Resolution is LEDGER-ONLY: deliveryId(+HMAC token) → dingtalk_approval_card_deliveries →
 *   instance_id. Payload-supplied instance ids never exist on this surface.
 * - Zero bypass: the decision funnels into ApprovalProductService.dispatchAction — assignee check,
 *   reject-comment-required, nodeEntryEpoch round-scoping and version conflicts apply untouched.
 * - Channel attribution is injected SERVER-SIDE (`channelOrigin` → approval_records.metadata);
 *   HTTP bodies never carry it.
 * - A card is actionable only while card_state='sent' AND the send possibly delivered:
 *   send_status IN ('sent','outcome_unknown') (review P2; PR #4046 Phase B widened the set by
 *   exactly outcome_unknown — a send whose outcome the client could not observe MAY have been
 *   delivered, and a valid HMAC deep-link token is itself proof of delivery, so the ledger's
 *   send-time uncertainty must not make a delivered card inoperable. pending/failed stay stale.)
 * - P1-1 stale-card binding: actionability ADDITIONALLY requires a LIVE active `approval_assignments`
 *   row still matching the delivery's node_key + recipient (+ entry_epoch when the delivery carries
 *   one). A card issued for node-1 must NOT approve node-2 after the instance advances (node-1's
 *   assignment is deactivated → no match), nor re-approve the SAME node after a loop-back (a fresh
 *   epoch on the new active assignment fails the old card's epoch match). The read-time binding is the
 *   authoritative guard and stands alone even if the supersede sweep never runs; a NULL delivery
 *   epoch (legacy) skips only the epoch clause and stays closed on the node/assignee match.
 */
import { createHmac, timingSafeEqual } from 'crypto'

import type { ApprovalProductService } from './ApprovalProductService'
import {
  resolveApprovalCardLinkSecret,
  resolveApprovalCardLinkSecretForIntegration,
} from '../integrations/dingtalk/approval-card-config'
import {
  claimDingTalkApprovalCardDeliveryActed,
  findDingTalkApprovalCardDeliveryById,
  type DingTalkApprovalCardDeliveryRow,
} from '../integrations/dingtalk/approval-card-deliveries'

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

export type ApprovalCardDecision = 'approve' | 'reject'

export interface ApprovalCardDeliverySummary {
  deliveryId: string
  cardState: DingTalkApprovalCardDeliveryRow['card_state']
  sendStatus: DingTalkApprovalCardDeliveryRow['send_status']
  nodeKey: string
  recipientUserId: string
  viewerIsRecipient: boolean
  /**
   * card live + send possibly delivered ('sent'/'outcome_unknown') + instance still pending + the
   * delivery's node/recipient(/epoch) still matches a LIVE active assignment (P1-1 stale-card
   * binding) — the page may offer 同意/拒绝.
   */
  actionable: boolean
  approval: {
    instanceId: string
    title: string | null
    requestNo: string | null
    status: string
    currentNodeKey: string | null
    /** Mirrors the engine's hard gate so the page can make the comment required BEFORE submit. */
    rejectCommentRequired: boolean
  }
  actedAction: string | null
  actedAt: string | null
}

export type ApprovalCardActionOutcome =
  | { status: 'ok'; summary: ApprovalCardDeliverySummary }
  | { status: 'not_found' }
  | { status: 'stale'; summary: ApprovalCardDeliverySummary }
  | { status: 'engine_rejected'; code: string; message: string; httpStatus: number; summary: ApprovalCardDeliverySummary }

/**
 * Deep-link token: HMAC-SHA256(deliveryId, approval-card link secret) truncated to 32 hex chars —
 * matches the executor's link composition exactly. CFG-1: the secret resolves env-first with the
 * stored (encrypted) directory-integration config as fallback — the SAME source the executor signs
 * with. Fail-closed without the secret.
 *
 * DT-R2 per-corp verify: when the delivery row carries an `integration_id`, the token verifies
 * against THAT integration's secret ONLY (env override still wins) — a token signed under corp A
 * must never verify against a delivery pinned to corp B (fail-closed, no LIMIT-1 fallback).
 * Legacy rows (`integration_id` NULL) keep the original single-integration resolver — the same
 * source they were signed with, so in-flight links survive the rollout.
 */
export async function verifyApprovalCardLinkToken(
  deliveryId: string,
  token: string,
  queryFn?: QueryFn,
  integrationId?: string | null,
): Promise<boolean> {
  if (!deliveryId || !token || token.length !== 32) return false
  const secret = integrationId
    ? await resolveApprovalCardLinkSecretForIntegration(integrationId, queryFn)
    : await resolveApprovalCardLinkSecret(queryFn)
  if (!secret) return false
  const expected = createHmac('sha256', secret).update(deliveryId).digest('hex').slice(0, 32)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(token, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface InstanceSummaryRow {
  id: string
  title: string | null
  request_no: string | null
  status: string
  current_node_key: string | null
  policy_snapshot: unknown
  /**
   * P1-1: TRUE iff an ACTIVE `approval_assignments` row still matches the delivery's node +
   * recipient (+ epoch when the delivery carries one). This is the authoritative stale-card guard —
   * see `buildSummary`. Computed in the same round-trip as the instance read so `actionable`
   * reflects live assignment state, never just the instance status.
   */
  has_active_assignment: boolean
}

function rejectCommentRequiredFromPolicy(policySnapshot: unknown): boolean {
  if (policySnapshot && typeof policySnapshot === 'object' && !Array.isArray(policySnapshot)) {
    const value = (policySnapshot as Record<string, unknown>).rejectCommentRequired
    // The engine treats anything but an explicit false as required — mirror that default.
    return value !== false
  }
  return true
}

async function buildSummary(
  query: QueryFn,
  delivery: DingTalkApprovalCardDeliveryRow,
  viewerUserId: string,
): Promise<ApprovalCardDeliverySummary | null> {
  // P1-1: bind actionability to a LIVE active assignment matching the delivery's node + recipient +
  // STRICT epoch — computed in the SAME round-trip as the instance read.
  //   - The node/assignee match closes FORWARD advance using live state: once node-1 is approved and
  //     the instance advances to node-2 (where the recipient is ALSO an assignee), node-1's assignment
  //     row is is_active=FALSE, so a stale node-1 card no longer matches → NOT actionable.
  //   - The STRICT epoch clause closes SAME-NODE re-entry: a loop-back to the same node_key mints a
  //     FRESH entry_epoch on a new active assignment, so the old-epoch card fails the equality. There
  //     is NO null-pass arm (the P1-1 re-review dropped the `$4 IS NULL` / `aa.entry_epoch IS NULL`
  //     dual-read that let a legacy card re-enter the same node): the delivery MUST carry a NON-NULL
  //     epoch equal to a NON-NULL live-seat epoch. A NULL delivery epoch (a card the migration failed
  //     to backfill) → NOT actionable (fail-closed). Legacy in-flight cards are handled at migrate
  //     time (backfilled from their unique live seat, else superseded), never by a permissive read.
  const result = await query(
    `SELECT i.id, i.title, i.request_no, i.status, i.current_node_key, i.policy_snapshot,
            EXISTS (
              SELECT 1 FROM approval_assignments aa
               WHERE aa.instance_id = $1
                 AND aa.node_key = $2
                 AND aa.assignee_id = $3
                 AND aa.is_active = TRUE
                 AND aa.entry_epoch IS NOT NULL
                 AND aa.entry_epoch = $4::int
            ) AS has_active_assignment
       FROM approval_instances i WHERE i.id = $1`,
    [delivery.instance_id, delivery.node_key, delivery.recipient_user_id, delivery.entry_epoch],
  )
  const instance = (result.rows[0] ?? null) as InstanceSummaryRow | null
  if (!instance) return null
  return {
    deliveryId: delivery.id,
    cardState: delivery.card_state,
    sendStatus: delivery.send_status,
    nodeKey: delivery.node_key,
    recipientUserId: delivery.recipient_user_id,
    viewerIsRecipient: delivery.recipient_user_id === viewerUserId,
    actionable:
      delivery.card_state === 'sent'
      && (delivery.send_status === 'sent' || delivery.send_status === 'outcome_unknown')
      && instance.status === 'pending'
      && instance.has_active_assignment === true,
    approval: {
      instanceId: instance.id,
      title: instance.title,
      requestNo: instance.request_no,
      status: instance.status,
      currentNodeKey: instance.current_node_key,
      rejectCommentRequired: rejectCommentRequiredFromPolicy(instance.policy_snapshot),
    },
    actedAction: delivery.acted_action,
    actedAt: delivery.acted_at ? new Date(delivery.acted_at as string | Date).toISOString() : null,
  }
}

export async function getApprovalCardDeliverySummary(
  deps: { query: QueryFn },
  input: { deliveryId: string; token: string; viewerUserId: string },
): Promise<{ status: 'ok'; summary: ApprovalCardDeliverySummary } | { status: 'not_found' }> {
  // DT-R2: the row is loaded before verify so the token checks against the DELIVERY's own
  // integration secret. Both failure orders collapse to the same not_found — no existence oracle.
  const delivery = await findDingTalkApprovalCardDeliveryById(deps.query, input.deliveryId)
  if (!delivery) return { status: 'not_found' }
  if (!(await verifyApprovalCardLinkToken(input.deliveryId, input.token, deps.query, delivery.integration_id))) return { status: 'not_found' }
  const summary = await buildSummary(deps.query, delivery, input.viewerUserId)
  if (!summary) return { status: 'not_found' }
  return { status: 'ok', summary }
}

export async function executeApprovalActionFromCardDelivery(
  deps: { query: QueryFn; approvals: Pick<ApprovalProductService, 'dispatchAction'> },
  input: {
    deliveryId: string
    token: string
    decision: ApprovalCardDecision
    comment?: string
    actor: { userId: string; userName: string; roles?: string[]; ip?: string | null; userAgent?: string | null }
  },
): Promise<ApprovalCardActionOutcome> {
  // DT-R2: row first, then verify against the row's own integration secret (see summary path).
  const delivery = await findDingTalkApprovalCardDeliveryById(deps.query, input.deliveryId)
  if (!delivery) return { status: 'not_found' }
  if (!(await verifyApprovalCardLinkToken(input.deliveryId, input.token, deps.query, delivery.integration_id))) return { status: 'not_found' }

  const preSummary = await buildSummary(deps.query, delivery, input.actor.userId)
  if (!preSummary) return { status: 'not_found' }
  if (!preSummary.actionable) return { status: 'stale', summary: preSummary }

  try {
    await deps.approvals.dispatchAction(
      delivery.instance_id,
      {
        action: input.decision,
        comment: input.comment,
        // A-4: server-side attribution — HTTP bodies never carry this (see ApprovalActionRequest).
        channelOrigin: { channel: 'dingtalk_card', cardDeliveryId: delivery.id },
      },
      {
        userId: input.actor.userId,
        userName: input.actor.userName,
        roles: input.actor.roles ?? [],
        ip: input.actor.ip ?? null,
        userAgent: input.actor.userAgent ?? null,
      },
    )
  } catch (error) {
    const err = error as { statusCode?: number; status?: number; code?: string; message?: string }
    const summary = (await (async () => {
      const fresh = await findDingTalkApprovalCardDeliveryById(deps.query, input.deliveryId)
      return fresh ? buildSummary(deps.query, fresh, input.actor.userId) : null
    })()) ?? preSummary
    // P1-1 TOCTOU close: the engine's authoritative in-txn card→round binding threw because a
    // concurrent advance (or same-node re-entry) raced the wrapper's pre-read — the card is stale,
    // not "rejected". Report it as `stale` (matching the pre-read early-stale outcome) so a raced
    // card renders the real terminal state, never a dead engine-error form.
    if (err.code === 'APPROVAL_CARD_DELIVERY_STALE') {
      return { status: 'stale', summary }
    }
    return {
      status: 'engine_rejected',
      code: typeof err.code === 'string' ? err.code : 'APPROVAL_ACTION_FAILED',
      message: typeof err.message === 'string' ? err.message : 'Approval action failed',
      httpStatus: typeof err.statusCode === 'number' ? err.statusCode : typeof err.status === 'number' ? err.status : 400,
      summary,
    }
  }

  // Engine success — claim the card's terminal state. A lost race (concurrent duplicate) is fine:
  // the ledger already reflects the real terminal state; re-read and return it.
  await claimDingTalkApprovalCardDeliveryActed(deps.query, delivery.id, {
    action: input.decision,
    actedBy: input.actor.userId,
  })
  const fresh = await findDingTalkApprovalCardDeliveryById(deps.query, input.deliveryId)
  const summary = fresh ? await buildSummary(deps.query, fresh, input.actor.userId) : null
  return { status: 'ok', summary: summary ?? preSummary }
}
