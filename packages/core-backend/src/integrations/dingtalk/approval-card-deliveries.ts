/**
 * A-1 (one-tap design-lock §3/§4): typed accessor for the `dingtalk_approval_card_deliveries`
 * ledger — the ONLY legitimate path from a card interaction back to an approval instance.
 *
 * Import-side-effect-free (no pool/eventBus/scheduler): callers inject the query function, same
 * discipline as the multitable permission path. Consumers per lock §8: A-2 (send path) uses
 * `insert…`; A-4 (card-delivery action endpoint + wrapper) uses `find…` + `claim…Acted` +
 * `supersede…ForInstance`; Slice B's Stream callback reuses the same primitives.
 *
 * The state machine's write side is deliberately narrow:
 *   - `claim…Acted` is an ATOMIC claim (`WHERE card_state='sent'`) — the idempotency anchor for
 *     duplicate callbacks / double taps; exactly one claimant wins, everyone else sees `null`
 *     and re-reads the row for the real terminal state.
 *   - `supersede…ForInstance` sweeps still-`sent` cards when the instance moves past them.
 * `expired` / `revoked` transitions get their own primitives when a slice consumes them (no dead
 * helpers ahead of need).
 */
import { randomUUID } from 'crypto'

export const DINGTALK_APPROVAL_CARD_DELIVERY_KINDS = ['work_notice_action_card', 'interactive_card'] as const
export type DingTalkApprovalCardDeliveryKind = (typeof DINGTALK_APPROVAL_CARD_DELIVERY_KINDS)[number]

export const DINGTALK_APPROVAL_CARD_STATES = ['sent', 'acted', 'superseded', 'expired', 'revoked'] as const
export type DingTalkApprovalCardState = (typeof DINGTALK_APPROVAL_CARD_STATES)[number]

export interface DingTalkApprovalCardDeliveryRow {
  id: string
  instance_id: string
  node_key: string
  recipient_user_id: string
  recipient_dingtalk_user_id: string
  delivery_kind: DingTalkApprovalCardDeliveryKind
  task_id: string | null
  card_state: DingTalkApprovalCardState
  acted_action: string | null
  acted_by: string | null
  acted_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

const RETURNING_COLUMNS =
  'id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, task_id, card_state, acted_action, acted_by, acted_at, created_at, updated_at'

export interface InsertDingTalkApprovalCardDeliveryInput {
  /** Optional caller-supplied id; defaults to a fresh UUID. Doubles as the interactive-card outTrackId (Slice B). */
  id?: string
  instanceId: string
  nodeKey: string
  recipientUserId: string
  recipientDingTalkUserId: string
  deliveryKind: DingTalkApprovalCardDeliveryKind
  /** asyncsend_v2 task id — recorded after the send call returns (Slice A). */
  taskId?: string | null
}

export async function insertDingTalkApprovalCardDelivery(
  query: QueryFn,
  input: InsertDingTalkApprovalCardDeliveryInput,
): Promise<DingTalkApprovalCardDeliveryRow> {
  const id = input.id && input.id.trim().length > 0 ? input.id.trim() : randomUUID()
  const result = await query(
    `INSERT INTO dingtalk_approval_card_deliveries
       (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${RETURNING_COLUMNS}`,
    [
      id,
      input.instanceId,
      input.nodeKey,
      input.recipientUserId,
      input.recipientDingTalkUserId,
      input.deliveryKind,
      input.taskId ?? null,
    ],
  )
  return result.rows[0] as DingTalkApprovalCardDeliveryRow
}

export async function findDingTalkApprovalCardDeliveryById(
  query: QueryFn,
  id: string,
): Promise<DingTalkApprovalCardDeliveryRow | null> {
  const result = await query(
    `SELECT ${RETURNING_COLUMNS} FROM dingtalk_approval_card_deliveries WHERE id = $1`,
    [id],
  )
  return (result.rows[0] as DingTalkApprovalCardDeliveryRow | undefined) ?? null
}

/**
 * Atomic acted-claim: succeeds for exactly one caller while the card is still `sent`.
 * Returns the updated row for the winner, `null` for everyone else (duplicate callback, double
 * tap, or a card already superseded/expired) — losers re-read via `find…ById` to render the
 * real terminal state.
 */
export async function claimDingTalkApprovalCardDeliveryActed(
  query: QueryFn,
  id: string,
  input: { action: string; actedBy: string },
): Promise<DingTalkApprovalCardDeliveryRow | null> {
  const result = await query(
    `UPDATE dingtalk_approval_card_deliveries
     SET card_state = 'acted', acted_action = $2, acted_by = $3, acted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND card_state = 'sent'
     RETURNING ${RETURNING_COLUMNS}`,
    [id, input.action, input.actedBy],
  )
  return (result.rows[0] as DingTalkApprovalCardDeliveryRow | undefined) ?? null
}

/**
 * Marks every still-`sent` card of an instance `superseded` (node advanced past them, or the
 * instance reached a terminal state). `excludeId` spares the delivery that triggered the
 * transition (it is claimed `acted` separately). Returns the swept ids.
 */
export async function supersedeDingTalkApprovalCardDeliveriesForInstance(
  query: QueryFn,
  instanceId: string,
  options: { excludeId?: string } = {},
): Promise<string[]> {
  const params: unknown[] = [instanceId]
  let excludeClause = ''
  if (options.excludeId) {
    params.push(options.excludeId)
    excludeClause = ' AND id <> $2'
  }
  const result = await query(
    `UPDATE dingtalk_approval_card_deliveries
     SET card_state = 'superseded', updated_at = NOW()
     WHERE instance_id = $1 AND card_state = 'sent'${excludeClause}
     RETURNING id`,
    params,
  )
  return (result.rows as Array<{ id: string }>).map((row) => row.id)
}
