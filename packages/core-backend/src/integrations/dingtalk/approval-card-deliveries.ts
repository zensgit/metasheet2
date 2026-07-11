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
  /**
   * DT-R2: the directory integration (corp) the card was sent through — the callback path's
   * credential/secret anchor. NULL on legacy rows and env-only sends (verify falls back to the
   * legacy single-integration resolver for those).
   */
  integration_id: string | null
  /**
   * P1-1: the node-entry epoch (approval_assignments.entry_epoch) this card was sent for. NULL on
   * legacy rows and env-only/epoch-less sends. The action wrapper's live-assignment binding uses it
   * to close SAME-NODE re-entry (a loop-back mints a fresh epoch on a new active assignment, so an
   * old-epoch card no longer matches); a NULL delivery epoch skips the epoch clause (dual-read) and
   * relies on the node/assignee match alone, which still closes forward advance.
   */
  entry_epoch: number | null
  card_state: DingTalkApprovalCardState
  acted_action: string | null
  acted_by: string | null
  acted_at: Date | string | null
  /**
   * `outcome_unknown` (PR #4046 Phase B): the send threw with the transport's
   * isDingTalkOutcomeUnknown marker — DingTalk may well have delivered the card even though the
   * client saw no usable response. NEVER auto-resent (owner doctrine); reconciliation is
   * manual/ops, and a valid HMAC callback (the token only exists inside the delivered card's
   * deep link) is itself proof of delivery, so outcome_unknown rows stay claimable.
   */
  send_status: 'pending' | 'sent' | 'failed' | 'outcome_unknown'
  send_error: string | null
  created_at: Date | string
  updated_at: Date | string
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

const RETURNING_COLUMNS =
  'id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, task_id, integration_id, entry_epoch, card_state, acted_action, acted_by, acted_at, send_status, send_error, created_at, updated_at'

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
  /** DT-R2: the assignee's directory integration id (uuid) — null/omitted for env-only sends. */
  integrationId?: string | null
  /**
   * P1-1: the node-entry epoch (from the task_created event's `task.entryEpoch`) this card is sent
   * for. Omit/null for legacy or epoch-less sends — the wrapper then skips the epoch clause and
   * binds on node/assignee alone.
   */
  entryEpoch?: number | null
}

export async function insertDingTalkApprovalCardDelivery(
  query: QueryFn,
  input: InsertDingTalkApprovalCardDeliveryInput,
): Promise<DingTalkApprovalCardDeliveryRow> {
  const id = input.id && input.id.trim().length > 0 ? input.id.trim() : randomUUID()
  const integrationId =
    typeof input.integrationId === 'string' && input.integrationId.trim().length > 0
      ? input.integrationId.trim()
      : null
  const entryEpoch = typeof input.entryEpoch === 'number' && Number.isInteger(input.entryEpoch) ? input.entryEpoch : null
  const result = await query(
    `INSERT INTO dingtalk_approval_card_deliveries
       (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, task_id, integration_id, entry_epoch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${RETURNING_COLUMNS}`,
    [
      id,
      input.instanceId,
      input.nodeKey,
      input.recipientUserId,
      input.recipientDingTalkUserId,
      input.deliveryKind,
      input.taskId ?? null,
      integrationId,
      entryEpoch,
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
 * §7.6 Delivery Closure — task_id trace accessor. An operator holding a DingTalk asyncsend_v2
 * `task_id` (the receipt of an accepted async message) resolves it back to the delivery row(s) —
 * instance, recipient, send_status — so "was this async approval-card message accepted, and under
 * what task_id" is answerable without reading logs. Backed by the partial index idx_dacd_task_id.
 *
 * Returns an array (newest first): task_id is NOT enforced UNIQUE — each send records its own, so
 * in practice one row per task_id, but a lost-then-reconciled or re-sent card could share one, and
 * the trace surface must surface all matches rather than silently pick one. A blank task_id never
 * matches (the partial index excludes NULLs; an empty string is short-circuited here).
 */
export async function findDingTalkApprovalCardDeliveriesByTaskId(
  query: QueryFn,
  taskId: string,
): Promise<DingTalkApprovalCardDeliveryRow[]> {
  const trimmed = taskId.trim()
  if (trimmed.length === 0) return []
  const result = await query(
    `SELECT ${RETURNING_COLUMNS}
       FROM dingtalk_approval_card_deliveries
      WHERE task_id = $1
      ORDER BY created_at DESC`,
    [trimmed],
  )
  return result.rows as DingTalkApprovalCardDeliveryRow[]
}

/**
 * Atomic acted-claim: succeeds for exactly one caller while the card is still `sent` AND was
 * possibly delivered (`send_status IN ('sent','outcome_unknown')` — review P2: a pending/failed
 * send never produced a live button, so nothing may claim it; PR #4046 Phase B widened the set by
 * exactly `outcome_unknown`, whose card MAY in fact have been delivered — a valid HMAC callback
 * proves it was, so the ledger's send-time uncertainty must not make a delivered card inoperable).
 * Returns the updated row for the winner, `null` for everyone else (duplicate callback, double
 * tap, undelivered card, or a card already superseded/expired) — losers re-read via `find…ById`
 * to render the real terminal state.
 */
export async function claimDingTalkApprovalCardDeliveryActed(
  query: QueryFn,
  id: string,
  input: { action: string; actedBy: string },
): Promise<DingTalkApprovalCardDeliveryRow | null> {
  const result = await query(
    `UPDATE dingtalk_approval_card_deliveries
     SET card_state = 'acted', acted_action = $2, acted_by = $3, acted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND card_state = 'sent' AND send_status IN ('sent', 'outcome_unknown')
     RETURNING ${RETURNING_COLUMNS}`,
    [id, input.action, input.actedBy],
  )
  return (result.rows[0] as DingTalkApprovalCardDeliveryRow | undefined) ?? null
}

/** A-2b: records a successful send — task_id from asyncsend_v2, send_status pending→sent. */
export async function markDingTalkApprovalCardDeliverySent(
  query: QueryFn,
  id: string,
  taskId: string | null,
): Promise<DingTalkApprovalCardDeliveryRow | null> {
  const result = await query(
    `UPDATE dingtalk_approval_card_deliveries
     SET send_status = 'sent', task_id = $2, send_error = NULL, updated_at = NOW()
     WHERE id = $1 AND send_status = 'pending'
     RETURNING ${RETURNING_COLUMNS}`,
    [id, taskId],
  )
  return (result.rows[0] as DingTalkApprovalCardDeliveryRow | undefined) ?? null
}

/** A-2b: records a failed send — traceable per the owner-ratified spec (send_status + send_error). */
export async function markDingTalkApprovalCardDeliverySendFailed(
  query: QueryFn,
  id: string,
  error: string,
): Promise<DingTalkApprovalCardDeliveryRow | null> {
  const result = await query(
    `UPDATE dingtalk_approval_card_deliveries
     SET send_status = 'failed', send_error = $2, updated_at = NOW()
     WHERE id = $1 AND send_status = 'pending'
     RETURNING ${RETURNING_COLUMNS}`,
    [id, error],
  )
  return (result.rows[0] as DingTalkApprovalCardDeliveryRow | undefined) ?? null
}

/**
 * PR #4046 Phase B: records a send whose outcome is UNKNOWN (network error / timeout / 5xx /
 * malformed 2xx — the transport's isDingTalkOutcomeUnknown marker). Distinct from `failed`
 * (definite rejection): the card may well have reached the recipient, so this state is never
 * auto-resent AND stays claimable by a valid HMAC callback. Same pending-only guard as the
 * other A-2b transitions.
 */
export async function markDingTalkApprovalCardDeliverySendOutcomeUnknown(
  query: QueryFn,
  id: string,
  error: string,
): Promise<DingTalkApprovalCardDeliveryRow | null> {
  const result = await query(
    `UPDATE dingtalk_approval_card_deliveries
     SET send_status = 'outcome_unknown', send_error = $2, updated_at = NOW()
     WHERE id = $1 AND send_status = 'pending'
     RETURNING ${RETURNING_COLUMNS}`,
    [id, error],
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
