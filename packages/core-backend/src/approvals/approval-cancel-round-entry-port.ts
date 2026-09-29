/**
 * Approval change-request design lock v5.9 — product entry v2 (lock header 「RATIFY 追记 —— 产品入口增补 v2」,
 * 2026-09-28), phase A: the host→plugin PORT behind the two attendance-side cancel-round endpoints
 * (`GET` / `POST /api/attendance/requests/:id/cancel-round`, `plugins/plugin-attendance/index.cjs`).
 *
 * Ratified values this module implements (owner-chosen; the lock header records the owner's option text):
 *   - §15.1 P-1, Q1′ = (i) attendance-side mounting. The ROUTES live in plugin-attendance behind
 *     `withPermission('attendance:read' | 'attendance:write')`. Core lends the plugin exactly the two
 *     capabilities it cannot reach on its own: the dedicated creation path
 *     (`ApprovalProductService.createCancelRoundInstance`, lock §14.1) and the ONE per-instance read
 *     predicate (`canReadApprovalInstance`, lock I7). The plugin never imports the core package and
 *     never spells the creation method's name — it calls `launch`.
 *   - §15.3 P-3 = (iii). The round summary carries `{ reversed, lots, unrecoverableExpired,
 *     alreadyReversed }` and its THREE-token classification (`cancelled` /
 *     `cancelled_with_unrecoverable_expired` / `cancelled_reversal_unreported`). It is read back
 *     through `readCancelRoundDurableProjectionV1` — the SAME whitelist projector both
 *     `getApproval` implementations already call — never through SQL of its own. So the three read
 *     surfaces that now show this fact (`/history`, `GET /api/approvals/:id`, this summary) share one
 *     projection rule; only this one is reachable with attendance permissions (P-10).
 *   - §15.4 P-4. The summary is keyed by the ORIGINAL document; visibility is
 *     `canReadApprovalInstance` applied to the original document instance (lock:153 I7 — no second
 *     「已到达」 predicate). `canWithdraw` is resolved here, server-side, by reading the SAME inputs the
 *     engine's revoke branch reads, so the FE never derives a second predicate. The policy snapshots
 *     never leave this module.
 *   - §15.2 P-2. `status` is a machine token whose SUBJECT is part of the token (`cancellation_*` vs
 *     `leave_cancelled`), one per word-table row V1–V6; a system closure is distinguishable from an
 *     approver's reject on this surface via `closedBySystem` (derived from the terminal audit row's
 *     actor, lock:131's own criterion) plus the bounded `closeReason` token. V7/V8 are request-time,
 *     non-terminal refusals and never appear on a read: a round that hit one is still `pending`.
 *   - §15.6 P-6. No seat holder is ever named: the summary carries no assignee data at all.
 *   - §15.7 P-7. `blockCode` is the bare `<code>` after `business_blocked:`; the adapter's free-text
 *     detail stays in the column.
 *   - §15.8 P-8. `launch` surfaces the creation path's registered codes VERBATIM (status + code +
 *     message) and nothing else — `details` is dropped, so no per-seat qualification detail reaches
 *     the employee surface (P-6′ ②).
 *
 * Least-privilege posture (same as `approvalAssigneeResolver`): `src/index.ts` injects this port into
 * plugin-attendance ONLY; every other plugin sees `undefined`. Without the port plugin-attendance
 * does not register the two routes at all (fail-closed: no entry rather than a half-wired one).
 */

import { pool } from '../db/pg'
import { ApprovalProductService } from '../services/ApprovalProductService'
import { ServiceError } from '../services/ApprovalBridgeService'
import { canReadApprovalInstance } from '../services/approval-instance-readability'
import { isSystemSentinelActor } from '../services/ApprovalAssigneeResolver'
import {
  CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX,
  readCancelRoundDurableProjectionV1,
  type CancelRoundCancellationOutcomeV1,
} from '../core/attendance-cancellation-execution-port'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

/** `approval_rounds.outcome` — the six ratified values (lock §4 CHECK). */
export type CancelRoundOutcomeV1 = 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'expired' | 'blocked'

/** P-2 word table V1–V6 as machine tokens whose SUBJECT is part of the token. */
export type CancelRoundSummaryStatusV1 =
  | 'cancellation_pending_approval' // V1: round pending
  | 'leave_cancelled' // V2: round applied ⇒ the leave itself is cancelled
  | 'cancellation_rejected' // V3: an approver rejected the cancellation (leave still valid)
  | 'cancellation_withdrawn' // V4: the requester withdrew the cancellation (leave still valid)
  | 'cancellation_window_closed' // V5: system close, `round_expired` (leave still valid)
  | 'cancellation_blocked' // V6: system close, `business_blocked:<code>` (leave still valid)

/**
 * Why `canWithdraw` is false — the ENGINE's own revoke-gate codes, reused verbatim so the summary and
 * the action endpoint cannot disagree about the reason (P-4 理由 2: N≥2 会签 after the first approve
 * is `APPROVAL_REVOKE_WINDOW_CLOSED`; N=1 / any terminal is `INVALID_STATUS_TRANSITION`).
 */
export type CancelRoundWithdrawBlockedReasonV1 =
  | 'APPROVAL_REVOKE_FORBIDDEN'
  | 'APPROVAL_REVOKE_DISABLED'
  | 'APPROVAL_REVOKE_WINDOW_CLOSED'
  | 'INVALID_STATUS_TRANSITION'

export interface CancelRoundSummaryRoundV1 {
  readonly roundId: string
  readonly engineInstanceId: string | null
  readonly outcome: CancelRoundOutcomeV1
  readonly status: CancelRoundSummaryStatusV1
  readonly startedAt: string
  readonly endedAt: string | null
  /** Bounded token: `round_expired` | `business_blocked:<code>` | null. Never free text. */
  readonly closeReason: string | null
  /** The `<code>` after `business_blocked:` (P-7: code only, never the detail), else null. */
  readonly blockCode: string | null
  /** Derived from the terminal audit row's actor sentinel (lock:131) — not a new stored fact. */
  readonly closedBySystem: boolean
  readonly canWithdraw: boolean
  readonly withdrawBlockedReason: CancelRoundWithdrawBlockedReasonV1 | null
  /** P-3 (iii): present once the round redeemed; `reversal: null` is EMITTED for the third token. */
  readonly cancellationOutcome: CancelRoundCancellationOutcomeV1 | null
}

export interface CancelRoundSummaryV1 {
  readonly documentInstanceId: string
  /** `null` is how this endpoint realizes P-4's 「无轮次时返回空集(200)」. */
  readonly round: CancelRoundSummaryRoundV1 | null
}

/**
 * The closed launch result. A refusal carries ONLY the creation path's own registered
 * `(status, code, message)`; `ServiceError.details` never crosses this boundary. Any other error is
 * rethrown for the caller's generic 500.
 */
export type CancelRoundLaunchResultV1 =
  | { readonly ok: true; readonly summary: CancelRoundSummaryV1 }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

export interface ApprovalCancelRoundEntryPort {
  /** Lock I7 — the ONE read predicate, applied to the ORIGINAL document instance. */
  canReadDocument(viewerId: string, documentInstanceId: string): Promise<boolean>
  /** P-4 summary of the document's latest cancel round (the pending one when one exists). */
  readRoundSummary(documentInstanceId: string, viewerId: string): Promise<CancelRoundSummaryV1>
  /**
   * P-1 launch — delegates to the dedicated creation path (lock §14.1). Every creation-time
   * precondition (approved document, original requester only, suite gate, one pending round, seat
   * eligibility) is enforced THERE and surfaces as its registered P-8 code; this port adds none of
   * its own and never routes through the public `createApproval`.
   */
  launch(
    documentInstanceId: string,
    actor: { userId: string; userName?: string },
    options?: { reason?: string | null },
  ): Promise<CancelRoundLaunchResultV1>
}

type RoundRow = {
  round_id: string
  engine_instance_id: string | null
  outcome: string
  started_at: Date | string
  ended_at: Date | string | null
  engine_status: string | null
  engine_current_node_key: string | null
  engine_requester_id: string | null
  allow_revoke: unknown
  revoke_before_node_keys: unknown
}

/** Same four values as `APPROVAL_TERMINAL_STATUSES` (`types/approval-product.ts`). */
const TERMINAL_ENGINE_STATUSES: ReadonlySet<string> = new Set(['approved', 'rejected', 'revoked', 'cancelled'])

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString()
}

function statusTokenFor(outcome: CancelRoundOutcomeV1): CancelRoundSummaryStatusV1 {
  switch (outcome) {
    case 'pending':
      return 'cancellation_pending_approval'
    case 'applied':
      return 'leave_cancelled'
    case 'rejected':
      return 'cancellation_rejected'
    case 'withdrawn':
      return 'cancellation_withdrawn'
    case 'expired':
      return 'cancellation_window_closed'
    case 'blocked':
      return 'cancellation_blocked'
  }
}

function isRoundOutcome(value: unknown): value is CancelRoundOutcomeV1 {
  return (
    value === 'pending'
    || value === 'applied'
    || value === 'rejected'
    || value === 'withdrawn'
    || value === 'expired'
    || value === 'blocked'
  )
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Mirror of the engine's revoke gates (`dispatchAction`, the `request.action === 'revoke'` branch),
 * in the SAME order and over the SAME inputs: the published definition's `runtime_graph.policy`
 * (`allowRevoke`, `revokeBeforeNodeKeys`), the engine instance's `requester_snapshot.id`, `status`
 * and `current_node_key`, and the handled-record count at that node. A `true` here means the action
 * endpoint would accept this viewer's revoke right now; a `false` names the code it would answer.
 * The integration suite pins both directions against the real action endpoint.
 */
async function resolveCanWithdraw(
  query: Queryable,
  row: RoundRow,
  viewerId: string,
): Promise<{ canWithdraw: boolean; reason: CancelRoundWithdrawBlockedReasonV1 | null }> {
  if (row.outcome !== 'pending' || !row.engine_instance_id) {
    return { canWithdraw: false, reason: 'INVALID_STATUS_TRANSITION' }
  }
  if (row.allow_revoke !== true) {
    return { canWithdraw: false, reason: 'APPROVAL_REVOKE_DISABLED' }
  }
  if (row.engine_requester_id !== viewerId) {
    return { canWithdraw: false, reason: 'APPROVAL_REVOKE_FORBIDDEN' }
  }
  if (typeof row.engine_status !== 'string' || TERMINAL_ENGINE_STATUSES.has(row.engine_status)) {
    return { canWithdraw: false, reason: 'INVALID_STATUS_TRANSITION' }
  }
  const currentNodeKey = row.engine_current_node_key
  if (!currentNodeKey) {
    return { canWithdraw: false, reason: 'INVALID_STATUS_TRANSITION' }
  }
  const revokeBefore = parseJsonish(row.revoke_before_node_keys)
  if (Array.isArray(revokeBefore) && revokeBefore.length > 0 && !revokeBefore.includes(currentNodeKey)) {
    return { canWithdraw: false, reason: 'APPROVAL_REVOKE_WINDOW_CLOSED' }
  }
  const handled = await query.query(
    `SELECT COUNT(*)::text AS count
       FROM approval_records
      WHERE instance_id = $1
        AND action IN ('approve', 'reject', 'transfer', 'handle')
        AND metadata->>'nodeKey' = $2`,
    [row.engine_instance_id, currentNodeKey],
  )
  const count = Number.parseInt(String(handled.rows[0]?.count ?? '0'), 10)
  if (count > 0) {
    return { canWithdraw: false, reason: 'APPROVAL_REVOKE_WINDOW_CLOSED' }
  }
  return { canWithdraw: true, reason: null }
}

/**
 * `closedBySystem` — lock:131: 「系统终结身份(非真人 actor)与专用 reason 是区分『审批人驳回』的唯一依据」.
 * Read off the LATEST terminal audit row of the round's engine instance: an approver's reject and
 * the C-3 system closure both write `to_status = 'rejected'`, and only the actor tells them apart.
 */
async function resolveClosedBySystem(query: Queryable, engineInstanceId: string | null): Promise<boolean> {
  if (!engineInstanceId) return false
  const result = await query.query(
    `SELECT actor_id
       FROM approval_records
      WHERE instance_id = $1
        AND to_status IN ('approved', 'rejected', 'revoked')
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
    [engineInstanceId],
  )
  const actorId = result.rows[0]?.actor_id
  return typeof actorId === 'string' && isSystemSentinelActor(actorId)
}

/**
 * P-4 — the latest cancel round of `documentInstanceId`, or `round: null`. 「Latest」 = the pending
 * round when one exists (at most one, I3), otherwise the most recently started one.
 */
export async function readCancelRoundSummaryForDocumentV1(
  query: Queryable,
  documentInstanceId: string,
  viewerId: string,
): Promise<CancelRoundSummaryV1> {
  const result = await query.query(
    `SELECT r.id AS round_id,
            r.engine_instance_id,
            r.outcome,
            r.started_at,
            r.ended_at,
            e.status AS engine_status,
            e.current_node_key AS engine_current_node_key,
            e.requester_snapshot->>'id' AS engine_requester_id,
            d.runtime_graph->'policy'->'allowRevoke' AS allow_revoke,
            d.runtime_graph->'policy'->'revokeBeforeNodeKeys' AS revoke_before_node_keys
       FROM approval_rounds r
       LEFT JOIN approval_instances e ON e.id = r.engine_instance_id
       LEFT JOIN approval_published_definitions d ON d.id = e.published_definition_id
      WHERE r.document_id = $1
        AND r.kind = 'cancel'
      ORDER BY (r.outcome = 'pending') DESC, r.started_at DESC, r.id DESC
      LIMIT 1`,
    [documentInstanceId],
  )
  const row = result.rows[0] as RoundRow | undefined
  if (!row) return { documentInstanceId, round: null }
  if (!isRoundOutcome(row.outcome)) {
    // The CHECK constraint makes this unreachable; fail closed rather than invent a token.
    return { documentInstanceId, round: null }
  }

  const projection = row.engine_instance_id
    ? await readCancelRoundDurableProjectionV1(
        (text, values) => query.query(text, values) as Promise<{ rows: Record<string, unknown>[] }>,
        row.engine_instance_id,
      )
    : {}
  const closeReason = projection.cancelRoundCloseReason ?? null
  const blockCode =
    closeReason && closeReason.startsWith(CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX)
      ? closeReason.slice(CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX.length)
      : null
  const closedBySystem = await resolveClosedBySystem(query, row.engine_instance_id)
  const withdraw = await resolveCanWithdraw(query, row, viewerId)

  return {
    documentInstanceId,
    round: {
      roundId: row.round_id,
      engineInstanceId: row.engine_instance_id,
      outcome: row.outcome,
      status: statusTokenFor(row.outcome),
      startedAt: toIso(row.started_at) ?? '',
      endedAt: toIso(row.ended_at),
      closeReason,
      blockCode,
      closedBySystem,
      canWithdraw: withdraw.canWithdraw,
      withdrawBlockedReason: withdraw.reason,
      cancellationOutcome: projection.cancellationOutcome ?? null,
    },
  }
}

export function buildApprovalCancelRoundEntryPort(): ApprovalCancelRoundEntryPort {
  const db = (): Queryable => {
    if (!pool) throw new Error('Database not available')
    return pool as unknown as Queryable
  }
  return {
    canReadDocument: (viewerId, documentInstanceId) => canReadApprovalInstance(db(), viewerId, documentInstanceId),
    readRoundSummary: (documentInstanceId, viewerId) =>
      readCancelRoundSummaryForDocumentV1(db(), documentInstanceId, viewerId),
    launch: async (documentInstanceId, actor, options = {}) => {
      try {
        const service = new ApprovalProductService()
        await service.createCancelRoundInstance(documentInstanceId, actor, { reason: options.reason ?? null })
      } catch (error) {
        if (error instanceof ServiceError) {
          return { ok: false, status: error.statusCode, code: error.code, message: error.message }
        }
        throw error
      }
      return { ok: true, summary: await readCancelRoundSummaryForDocumentV1(db(), documentInstanceId, actor.userId) }
    },
  }
}
