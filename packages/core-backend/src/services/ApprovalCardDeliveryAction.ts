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
 * - A card is actionable only while card_state='sent' AND send_status='sent' (review P2).
 */
import { createHmac, timingSafeEqual } from 'crypto'

import type { ApprovalProductService } from './ApprovalProductService'
import { resolveApprovalCardLinkSecret } from '../integrations/dingtalk/approval-card-config'
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
  /** card live + send delivered + instance still pending — the page may offer 同意/拒绝. */
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
 */
export async function verifyApprovalCardLinkToken(
  deliveryId: string,
  token: string,
  queryFn?: QueryFn,
): Promise<boolean> {
  if (!deliveryId || !token || token.length !== 32) return false
  const secret = await resolveApprovalCardLinkSecret(queryFn)
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
  const result = await query(
    `SELECT id, title, request_no, status, current_node_key, policy_snapshot
       FROM approval_instances WHERE id = $1`,
    [delivery.instance_id],
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
      && delivery.send_status === 'sent'
      && instance.status === 'pending',
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
  if (!(await verifyApprovalCardLinkToken(input.deliveryId, input.token, deps.query))) return { status: 'not_found' }
  const delivery = await findDingTalkApprovalCardDeliveryById(deps.query, input.deliveryId)
  if (!delivery) return { status: 'not_found' }
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
  if (!(await verifyApprovalCardLinkToken(input.deliveryId, input.token, deps.query))) return { status: 'not_found' }
  const delivery = await findDingTalkApprovalCardDeliveryById(deps.query, input.deliveryId)
  if (!delivery) return { status: 'not_found' }

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
