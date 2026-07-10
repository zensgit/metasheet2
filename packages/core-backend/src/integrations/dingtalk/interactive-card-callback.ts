/**
 * B-3 (Slice B design lock §B-3): DingTalk interactive-card Stream callback adapter.
 *
 * The ONLY business input accepted from a card callback is the owner-ratified triple
 * `{ outTrackId, action: 'approve', operatorDingTalkUserId }`. Everything else in the DingTalk
 * event is transport metadata — it is never parsed into business identifiers and may surface only
 * as values-free reason/category codes.
 *
 * Non-negotiables encoded here (lock §2/§5):
 * - LEDGER-ONLY: `outTrackId` must be a UUID-shaped `dingtalk_approval_card_deliveries.id`;
 *   payload instance/sheet/form fields are ignored by construction (the parser never reads them).
 * - APPROVE-ONLY: any other action is a recorded no-op (`ignored_unsupported_action`), never
 *   heuristically mapped. Card copy for that case is B-4's job.
 * - IDENTITY FAIL-CLOSED: the operator DingTalk user id resolves to an ACTIVE linked local user
 *   through the SAME directory-link predicates the A-chain send path uses
 *   (`directory_account_links.link_status='linked'` + `directory_accounts.provider='dingtalk'`
 *   + `directory_accounts.is_active` + `users.is_active`; mirrors the automation-executor
 *   recipient lateral and `ApprovalDirectoryOrg.resolveLinkedLocalUserIdByExternal`), pinned to
 *   the DELIVERY row's integration when present (DT-R2 per-corp discipline). Unmapped, inactive,
 *   or ambiguous operators get a typed refusal outcome and NO engine call.
 * - UNIFIED ACTION PATH: execution funnels through `executeApprovalActionFromCardDelivery`
 *   (A-4 wrapper) — assignee check, reject-comment gate, idempotent acted-claim, and server-side
 *   `channel='dingtalk_card'` attribution all apply untouched. No raw approvals route is called
 *   (static tripwire in `dingtalk-interactive-card-callback.test.ts`).
 * - SAME-SOURCE TOKEN THREADING: the A-4 wrapper requires the deep-link HMAC token. A Stream
 *   callback carries no link token — its trust anchor is the platform-verified Stream connection
 *   plus the fail-closed operator mapping above. To keep the wrapper as the single execution path
 *   (instead of adding a bypassing variant), the adapter re-signs the delivery id server-side with
 *   the SAME secret source the sender used (`approval-card-config`, env-first, per-integration
 *   pinned). A missing secret fail-closes BEFORE any engine call.
 *
 * The result is a typed union B-4 will map to in-place card updates. B-3 performs NO card update.
 */
import { createHmac } from 'crypto'

import { findDingTalkApprovalCardDeliveryById } from './approval-card-deliveries'
import {
  resolveApprovalCardLinkSecret,
  resolveApprovalCardLinkSecretForIntegration,
} from './approval-card-config'
import {
  executeApprovalActionFromCardDelivery,
  type ApprovalCardDeliverySummary,
} from '../../services/ApprovalCardDeliveryAction'
import type { ApprovalProductService } from '../../services/ApprovalProductService'

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

/** The ratified business callback shape (lock §B-3). Nothing else crosses this boundary. */
export type DingTalkApprovalCardCallback = {
  outTrackId: string
  action: 'approve'
  operatorDingTalkUserId: string
}

export type DingTalkApprovalCardCallbackRejectReason =
  | 'payload_not_object'
  | 'missing_out_track_id'
  | 'out_track_id_not_uuid'
  | 'missing_operator'
  | 'operator_conflict'
  | 'unsupported_operator_id_type'

export type DingTalkApprovalCardCallbackParseResult =
  | { ok: true; callback: DingTalkApprovalCardCallback }
  | { ok: false; outcome: 'rejected'; reason: DingTalkApprovalCardCallbackRejectReason }
  | { ok: false; outcome: 'ignored_unsupported_action'; outTrackId: string }

/**
 * Typed outcome union for B-4's card-update mapping (lock §B-4 table). `summary` objects are
 * in-memory presentation inputs only — logging surfaces (the Stream worker) print outcome/reason
 * codes and delivery ids, never summaries.
 */
export type DingTalkApprovalCardCallbackResult =
  | { outcome: 'rejected'; reason: DingTalkApprovalCardCallbackRejectReason }
  | { outcome: 'ignored_unsupported_action'; outTrackId: string }
  | { outcome: 'delivery_not_found'; outTrackId: string }
  | { outcome: 'operator_unresolved'; deliveryId: string; reason: 'unlinked' | 'inactive' | 'ambiguous' }
  | { outcome: 'link_secret_unavailable'; deliveryId: string }
  | { outcome: 'executed'; deliveryId: string; summary: ApprovalCardDeliverySummary }
  | { outcome: 'stale'; deliveryId: string; summary: ApprovalCardDeliverySummary }
  | { outcome: 'engine_rejected'; deliveryId: string; code: string; httpStatus: number; summary: ApprovalCardDeliverySummary }
  | { outcome: 'wrapper_not_found'; deliveryId: string }

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Action ids submitted by the card button, read from the documented DingTalk card-callback
 * `content.cardPrivateData.actionIds` shape (string or pre-parsed object). Anything unreadable
 * yields `[]` — which the caller treats as unsupported, never as a guessed approve.
 */
function readWireActionIds(content: unknown): string[] {
  let record = asRecord(content)
  if (typeof content === 'string') {
    try {
      record = asRecord(JSON.parse(content))
    } catch {
      return []
    }
  }
  const cardPrivateData = asRecord(record?.cardPrivateData)
  const actionIds = cardPrivateData?.actionIds
  if (!Array.isArray(actionIds)) return []
  return actionIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

/**
 * Parses/normalizes an incoming callback payload into the ratified triple. Accepts either the
 * pre-normalized business shape (`action`/`operatorDingTalkUserId`) or the documented DingTalk
 * wire frame (`userId` + `content.cardPrivateData.actionIds`); when both spellings are present
 * they must agree — disagreement fail-closes instead of picking a side.
 *
 * Validation order per lock §B-3: outTrackId UUID gate → action approve-only → operator present.
 * The transport frame's remaining fields are NEVER read.
 */
export function parseDingTalkApprovalCardCallback(payload: unknown): DingTalkApprovalCardCallbackParseResult {
  const record = asRecord(payload)
  if (!record) return { ok: false, outcome: 'rejected', reason: 'payload_not_object' }

  // 1. outTrackId — a UUID-shaped ledger delivery id, normalized to the canonical lowercase form.
  if (typeof record.outTrackId !== 'string' && record.outTrackId !== undefined && record.outTrackId !== null) {
    return { ok: false, outcome: 'rejected', reason: 'out_track_id_not_uuid' }
  }
  const rawOutTrackId = readTrimmedString(record.outTrackId)
  if (!rawOutTrackId) return { ok: false, outcome: 'rejected', reason: 'missing_out_track_id' }
  if (!UUID_SHAPE.test(rawOutTrackId)) return { ok: false, outcome: 'rejected', reason: 'out_track_id_not_uuid' }
  const outTrackId = rawOutTrackId.toLowerCase()

  // 2. action — exactly 'approve'; anything else (including ambiguity or unreadable content) is a
  //    recorded no-op, never mapped heuristically.
  const explicitAction = readTrimmedString(record.action)
  const wireActionIds = 'content' in record && record.content !== undefined ? readWireActionIds(record.content) : []
  let action = ''
  if (explicitAction && wireActionIds.length === 0) action = explicitAction
  else if (!explicitAction && wireActionIds.length === 1) action = wireActionIds[0]
  else if (explicitAction && wireActionIds.length === 1 && wireActionIds[0] === explicitAction) action = explicitAction
  if (action !== 'approve') return { ok: false, outcome: 'ignored_unsupported_action', outTrackId }

  // 3. operator — staff-userid namespace only, fail-closed on absence or conflicting spellings.
  if (record.userIdType !== undefined && record.userIdType !== null
    && record.userIdType !== 1 && record.userIdType !== '1') {
    return { ok: false, outcome: 'rejected', reason: 'unsupported_operator_id_type' }
  }
  const explicitOperator = readTrimmedString(record.operatorDingTalkUserId)
  const wireOperator = readTrimmedString(record.userId)
  if (explicitOperator && wireOperator && explicitOperator !== wireOperator) {
    return { ok: false, outcome: 'rejected', reason: 'operator_conflict' }
  }
  const operatorDingTalkUserId = explicitOperator || wireOperator
  if (!operatorDingTalkUserId) return { ok: false, outcome: 'rejected', reason: 'missing_operator' }

  return { ok: true, callback: { outTrackId, action: 'approve', operatorDingTalkUserId } }
}

export type DingTalkApprovalCardCallbackDeps = {
  query: QueryFn
  approvals: Pick<ApprovalProductService, 'dispatchAction'>
}

type ResolvedOperator =
  | { ok: true; userId: string; userName: string }
  | { ok: false; reason: 'unlinked' | 'inactive' | 'ambiguous' }

/**
 * DingTalk operator → ACTIVE linked local user, fail-closed. Same predicate set as the A-chain
 * send lateral (automation-executor recipient mapping), inverted, and pinned to the delivery's
 * integration when the row carries one (DT-R2). One external id resolving to MORE than one local
 * user (possible only on legacy unpinned rows) is refused as ambiguous — identity is never a
 * freshest-wins pick on this surface.
 */
async function resolveOperatorLocalUser(
  query: QueryFn,
  operatorDingTalkUserId: string,
  integrationId: string | null,
): Promise<ResolvedOperator> {
  const result = await query(
    `SELECT DISTINCT u.id AS local_user_id,
            COALESCE(u.name, u.id) AS local_user_name,
            u.is_active AS local_user_active
       FROM directory_accounts a
       JOIN directory_account_links l
         ON l.directory_account_id = a.id
        AND l.link_status = 'linked'
        AND l.local_user_id IS NOT NULL
       JOIN users u ON u.id = l.local_user_id
      WHERE a.provider = 'dingtalk'
        AND a.external_user_id = $1
        AND a.is_active = TRUE
        AND ($2::uuid IS NULL OR a.integration_id = $2::uuid)`,
    [operatorDingTalkUserId, integrationId],
  )
  const rows = result.rows as Array<{ local_user_id: string; local_user_name: string | null; local_user_active: boolean }>
  const byUser = new Map<string, { name: string; active: boolean }>()
  for (const row of rows) {
    if (typeof row.local_user_id !== 'string' || !row.local_user_id) continue
    byUser.set(row.local_user_id, {
      name: typeof row.local_user_name === 'string' && row.local_user_name ? row.local_user_name : row.local_user_id,
      active: row.local_user_active === true,
    })
  }
  if (byUser.size === 0) return { ok: false, reason: 'unlinked' }
  if (byUser.size > 1) return { ok: false, reason: 'ambiguous' }
  const [userId, info] = [...byUser.entries()][0]
  if (!info.active) return { ok: false, reason: 'inactive' }
  return { ok: true, userId, userName: info.name }
}

/**
 * Full B-3 execution: parse → ledger-only delivery resolve → fail-closed operator mapping →
 * same-source token threading → A-4 wrapper. Returns the typed outcome for B-4; never updates
 * the card, never logs (callers own values-free logging).
 */
export async function executeDingTalkApprovalCardCallback(
  deps: DingTalkApprovalCardCallbackDeps,
  payload: unknown,
): Promise<DingTalkApprovalCardCallbackResult> {
  const parsed = parseDingTalkApprovalCardCallback(payload)
  if (parsed.ok === false) {
    return parsed.outcome === 'rejected'
      ? { outcome: 'rejected', reason: parsed.reason }
      : { outcome: 'ignored_unsupported_action', outTrackId: parsed.outTrackId }
  }
  const { outTrackId, operatorDingTalkUserId } = parsed.callback

  // LEDGER-ONLY resolution (§2): the delivery row is the sole delivery → instance anchor.
  const delivery = await findDingTalkApprovalCardDeliveryById(deps.query, outTrackId)
  if (!delivery) return { outcome: 'delivery_not_found', outTrackId }

  const operator = await resolveOperatorLocalUser(deps.query, operatorDingTalkUserId, delivery.integration_id)
  if (operator.ok === false) {
    return { outcome: 'operator_unresolved', deliveryId: delivery.id, reason: operator.reason }
  }

  // Same-source signing (see module doc): resolve the secret exactly as the sender did — pinned
  // integration first (env override wins inside the resolver), legacy resolver for NULL rows.
  const linkSecret = delivery.integration_id
    ? await resolveApprovalCardLinkSecretForIntegration(delivery.integration_id, deps.query)
    : await resolveApprovalCardLinkSecret(deps.query)
  if (!linkSecret) return { outcome: 'link_secret_unavailable', deliveryId: delivery.id }
  const token = createHmac('sha256', linkSecret).update(delivery.id).digest('hex').slice(0, 32)

  const outcome = await executeApprovalActionFromCardDelivery(
    { query: deps.query, approvals: deps.approvals },
    {
      deliveryId: delivery.id,
      token,
      decision: 'approve',
      actor: {
        userId: operator.userId,
        userName: operator.userName,
        // Card callbacks never carry role elevation: the engine's assignee gate decides, and an
        // operator who is not the assignee is rejected there (zero bypass, lock §2).
        roles: [],
        ip: null,
        userAgent: null,
      },
    },
  )

  switch (outcome.status) {
    case 'ok':
      return { outcome: 'executed', deliveryId: delivery.id, summary: outcome.summary }
    case 'stale':
      return { outcome: 'stale', deliveryId: delivery.id, summary: outcome.summary }
    case 'engine_rejected':
      // Values-free: the engine's human-readable message may carry titles/names — only the stable
      // code and HTTP class cross this boundary. B-4 maps codes to reason-coded card copy.
      return {
        outcome: 'engine_rejected',
        deliveryId: delivery.id,
        code: outcome.code,
        httpStatus: outcome.httpStatus,
        summary: outcome.summary,
      }
    case 'not_found':
    default:
      return { outcome: 'wrapper_not_found', deliveryId: delivery.id }
  }
}
