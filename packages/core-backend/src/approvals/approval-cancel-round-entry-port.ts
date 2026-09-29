/**
 * Approval change-request design lock v5.9 — product entry v2 (lock header 「RATIFY 追记 —— 产品入口增补 v2」,
 * 2026-09-28), phase A + A2: the host→plugin PORT behind the attendance-side cancel-round endpoints
 * (`GET` / `POST /api/attendance/requests/:id/cancel-round`, and A2's `POST …/cancel-round/actions` /
 * `POST …/cancel-round/withdraw`, `plugins/plugin-attendance/index.cjs`).
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
 *     engine's revoke gate reads, so the FE never derives a second predicate. It answers the ENGINE-level
 *     gate; the employee-reachable HTTP path to that gate is the attendance-side withdraw route
 *     (`withdraw` below, A2). The policy snapshots never leave this module.
 *   - A2 (owner 2026-09-29, 「Attendance-side + OFF flag (Recommended)」 — option text in the phase A
 *     design MD §A2): `decide` (approve / reject, behind `attendance:approve` in the plugin) and
 *     `withdraw` (the requester's revoke, behind `attendance:write`) hand the action to the SAME
 *     service entry `POST /api/approvals/:id/actions` uses for a template-runtime instance,
 *     `ApprovalProductService.dispatchAction`, on the round's own engine instance. Seat ownership,
 *     the §2-G3 seat rules, the §9-9 allowed-action set and the revoke gate are all enforced THERE,
 *     unchanged; this module adds no predicate of its own and never writes a round or an instance.
 *   - §15.2 P-2. `status` is a machine token whose SUBJECT is part of the token (`cancellation_*` vs
 *     `leave_cancelled`), one per word-table row V1–V6; a system closure is distinguishable from an
 *     approver's reject on this surface via `closedBySystem` (derived from the terminal audit row's
 *     actor, lock:131's own criterion) plus the bounded `closeReason` token. V7/V8 are request-time,
 *     non-terminal refusals and never appear on a read: a round that hit one is still `pending`.
 *   - §15.6 P-6. No seat holder is ever named: the summary carries no assignee data at all.
 *   - §15.7 P-7. `blockCode` is the bare `<code>` after `business_blocked:`; the adapter's free-text
 *     detail stays in the column.
 *   - §15.8 P-8. `launch` surfaces the creation path's registered CODES verbatim (status + code) with
 *     the path's message, and nothing else — `details` is dropped. For the two SEAT-class codes
 *     (`CANCEL_ROUND_SEAT_INELIGIBLE`, `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`) the message is replaced by
 *     one neutral, reason-free sentence: the creation path's messages for those codes are written for
 *     an administrator and name the cause (an approver's eligibility, an attribution failure), which
 *     §15.6.1 ② (P-6′) keeps off the employee surface, and the owner's P-6′ choice keeps employee copy
 *     at the weaker, cause-free strength until root cause (c) lands. The CODE is unchanged, so the FE
 *     (phase B) still renders per code.
 *
 * Least-privilege posture (same as `approvalAssigneeResolver`): `src/index.ts` injects this port into
 * plugin-attendance ONLY; every other plugin sees `undefined`. Without the port (all five methods)
 * plugin-attendance registers none of the four routes (fail-closed: no entry rather than a half-wired
 * one).
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
 * the engine's revoke gate cannot disagree about the reason (P-4 理由 2: N≥2 会签 after the first
 * approve is `APPROVAL_REVOKE_WINDOW_CLOSED`; N=1 / any terminal is `INVALID_STATUS_TRANSITION`).
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

/**
 * A2 — the closed result of `decide` / `withdraw`. `noRound` means the document has no cancel round
 * at all (the plugin answers it with the entry's not-found body). A refusal carries ONLY the service
 * entry's own `(status, code, message)` — `ServiceError.details` never crosses this boundary. Any
 * other error is rethrown for the caller's generic 500.
 */
export type CancelRoundActionResultV1 =
  | { readonly ok: true; readonly summary: CancelRoundSummaryV1 }
  | { readonly ok: false; readonly noRound: true }
  | { readonly ok: false; readonly noRound?: false; readonly status: number; readonly code: string; readonly message: string }

/** A2 — who acts. `userName` is the display name for the audit row (falls back to the id there). */
export interface CancelRoundEntryActorV1 {
  readonly userId: string
  readonly userName?: string
  readonly ip?: string | null
  readonly userAgent?: string | null
}

/** A2 — the two approver verbs the attendance side offers (a subset of lock §9-9's allowed set). */
export type CancelRoundDecisionActionV1 = 'approve' | 'reject'

export interface ApprovalCancelRoundEntryPort {
  /** Lock I7 — the ONE read predicate, applied to the ORIGINAL document instance. */
  canReadDocument(viewerId: string, documentInstanceId: string): Promise<boolean>
  /** P-4 summary of the document's latest cancel round (the pending one when one exists). */
  readRoundSummary(documentInstanceId: string, viewerId: string): Promise<CancelRoundSummaryV1>
  /**
   * P-1 launch — delegates to the dedicated creation path (lock §14.1). Every creation-time
   * precondition (approved document, original requester only, suite gate, one pending round, seat
   * eligibility) is enforced THERE and surfaces as its registered P-8 code; this port adds none of
   * its own and never routes through the public `createApproval`. Seat-class refusals carry
   * `CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE` instead of the creation path's admin-facing message.
   */
  launch(
    documentInstanceId: string,
    actor: { userId: string; userName?: string },
    options?: { reason?: string | null },
  ): Promise<CancelRoundLaunchResultV1>
  /**
   * A2 — an approver's `approve` / `reject` on the document's latest cancel round, dispatched AS the
   * caller through `ApprovalProductService.dispatchAction` (the service entry of
   * `POST /api/approvals/:id/actions`). The seat check, the §2-G3 seat rules and the §9-9 action set
   * are that entry's; a caller with no seat gets its existing refusal.
   */
  decide(
    documentInstanceId: string,
    actor: CancelRoundEntryActorV1,
    request: { action: CancelRoundDecisionActionV1; comment?: string | null },
  ): Promise<CancelRoundActionResultV1>
  /**
   * A2 — the requester's withdraw: the engine's `revoke` on the document's latest cancel round, through
   * the same service entry, whose revoke gate (allowRevoke → requester → status → window) decides.
   */
  withdraw(
    documentInstanceId: string,
    actor: CancelRoundEntryActorV1,
    request?: { comment?: string | null },
  ): Promise<CancelRoundActionResultV1>
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
 * Mirror of the ENGINE-level revoke gate (`ApprovalProductService.dispatchAction`, the
 * `request.action === 'revoke'` branch), in the SAME order and over the SAME inputs: the published
 * definition's `runtime_graph.policy` (`allowRevoke`, `revokeBeforeNodeKeys`), the engine instance's
 * `requester_snapshot.id`, `status` and `current_node_key`, and the handled-record count at that
 * node. A `true` here means the engine would accept this viewer's revoke right now; a `false` names
 * the code the engine would answer. The employee-reachable HTTP path to this gate is the
 * attendance-side withdraw route (A2); the approval-side action route keeps its own permission guard
 * in front of the same engine. The suite pins both engine directions in-process and over HTTP.
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
 *
 * Consistency: the round row, the durable projection, `closedBySystem` and `canWithdraw` are four
 * separate statements, not one snapshot, so a transition landing between them can yield a torn view
 * (e.g. `outcome: 'pending'` beside a just-written terminal audit row). Accepted deliberately: the
 * summary is advisory — every decision it could inform is re-checked under the row lock by the path
 * that acts on it (creation path for a launch, engine for a withdraw) — and the next read converges.
 */
export async function readCancelRoundSummaryForDocumentV1(
  query: Queryable,
  documentInstanceId: string,
  viewerId: string,
): Promise<CancelRoundSummaryV1> {
  const row = await selectLatestCancelRoundRow(query, documentInstanceId)
  if (!row) return { documentInstanceId, round: null }
  if (!isRoundOutcome(row.outcome)) {
    // Unreachable while the `approval_rounds` outcome CHECK holds. If that enum is ever widened
    // without this reader, fail loudly: `round: null` would read as "no round" (P-8 ③ — an unknown
    // state must not collapse into the empty result), and inventing a status token is not ours to do.
    // The routes turn this into their generic 500 INTERNAL_ERROR; no new code.
    throw new Error(`cancel-round summary: unrecognised round outcome ${JSON.stringify(row.outcome)} on round ${row.round_id}`)
  }
  return summarizeRoundRow(query, documentInstanceId, { ...row, outcome: row.outcome }, viewerId)
}

/**
 * 「Latest」 = the pending round when one exists (at most one, I3), otherwise the most recently
 * started one. ONE definition, shared by the summary and by A2's `decide` / `withdraw`, so the round
 * a caller acts on is the round the summary shows them.
 */
async function selectLatestCancelRoundRow(query: Queryable, documentInstanceId: string): Promise<RoundRow | undefined> {
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
  return result.rows[0] as RoundRow | undefined
}

async function summarizeRoundRow(
  query: Queryable,
  documentInstanceId: string,
  row: RoundRow & { outcome: CancelRoundOutcomeV1 },
  viewerId: string,
): Promise<CancelRoundSummaryV1> {
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

/** The two SEAT-class creation-time codes (P-8 ①; P-6′ ② governs their employee-facing copy). */
const CANCEL_ROUND_SEAT_CLASS_CODES: ReadonlySet<string> = new Set([
  'CANCEL_ROUND_SEAT_INELIGIBLE',
  'CANCEL_ROUND_NO_ELIGIBLE_APPROVER',
])

/** P-6′ ② cause-free employee copy (owner's P-6′ pick 「(ii) Reuse approval notices (Recommended)」, whose description reads "weaker employee-facing copy until RC (c) lands"). */
export const CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE =
  'A cancellation cannot be started for this document right now — please contact an administrator'

/**
 * A2 — `decide` and `withdraw` share this one path: the document's latest cancel round (the same
 * 「latest」 the summary shows), then `ApprovalProductService.dispatchAction` on that round's OWN engine
 * instance, AS the caller. `dispatchAction` is the service entry `POST /api/approvals/:id/actions`
 * calls for a template-runtime instance; everything that decides whether the action is allowed —
 * the §9-9 action gate (`assertCancelRoundActionAllowed`), the seat check (`actorCanAct` over the
 * instance's active assignments), the revoke gate, the C-2 redemption and C-3 closure — runs there,
 * unchanged. Nothing here re-derives or pre-empts any of it.
 *
 * `roles: []`: the actor carries no role claims. A cancel round's seats are PERSON seats — the
 * creation path seats the original approvers by user id (lock §14.1), and §9-9 / §14.3 #12–#13
 * refuse every verb or job that could change a seat — so a role claim can never be what seats an
 * actor on it; passing none can only narrow, never widen (the integration suite asserts every
 * assignment on a launched round is a `user` assignment).
 *
 * Not done here, on purpose: the approval-side route's post-dispatch pending-count publish (a todo
 * badge refresh) — the todo presentation is phase C (P-11), recorded in the design MD.
 */
const CANCEL_ROUND_DISPATCH_ACTIONS: ReadonlySet<string> = new Set(['approve', 'reject', 'revoke'])

async function dispatchOnLatestCancelRound(
  query: Queryable,
  documentInstanceId: string,
  actor: CancelRoundEntryActorV1,
  action: 'approve' | 'reject' | 'revoke',
  comment: string | null | undefined,
): Promise<CancelRoundActionResultV1> {
  if (!CANCEL_ROUND_DISPATCH_ACTIONS.has(action)) {
    // The plugin validates the verb before calling; a caller that bypasses that is a programming
    // error, answered with the generic 500 rather than a code of its own.
    throw new Error(`cancel-round entry: action ${JSON.stringify(action)} is not dispatched through this port`)
  }
  const row = await selectLatestCancelRoundRow(query, documentInstanceId)
  if (!row || !row.engine_instance_id) return { ok: false, noRound: true }
  try {
    const service = new ApprovalProductService()
    await service.dispatchAction(
      row.engine_instance_id,
      { action, ...(typeof comment === 'string' ? { comment } : {}) },
      {
        userId: actor.userId,
        userName: actor.userName || actor.userId,
        roles: [],
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
    )
  } catch (error) {
    if (error instanceof ServiceError) {
      return { ok: false, status: error.statusCode, code: error.code, message: error.message }
    }
    throw error
  }
  return { ok: true, summary: await readCancelRoundSummaryForDocumentV1(query, documentInstanceId, actor.userId) }
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
          const message = CANCEL_ROUND_SEAT_CLASS_CODES.has(error.code)
            ? CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE
            : error.message
          return { ok: false, status: error.statusCode, code: error.code, message }
        }
        throw error
      }
      return { ok: true, summary: await readCancelRoundSummaryForDocumentV1(db(), documentInstanceId, actor.userId) }
    },
    decide: (documentInstanceId, actor, request) =>
      dispatchOnLatestCancelRound(db(), documentInstanceId, actor, request.action, request.comment),
    withdraw: (documentInstanceId, actor, request = {}) =>
      dispatchOnLatestCancelRound(db(), documentInstanceId, actor, 'revoke', request.comment),
  }
}
