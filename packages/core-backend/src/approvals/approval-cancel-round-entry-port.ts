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
 *   - C2 (owner 2026-09-29 16:5x, 「Attendance-side list (Recommended)」 — option text in the phase A
 *     design MD §10): `listSeatedPendingRounds` answers the attendance-side 「cancellations waiting for
 *     me」 list (`GET /api/attendance/cancel-rounds/pending`, behind `attendance:approve` in the
 *     plugin). The seat verdict is the decision door's OWN predicate — `decisionDoorIsSeatGated` +
 *     `resolveCanDecideCurrentNode` (`services/approval-seat-authorization.ts`, the same pair
 *     `resolveLegacyDecisionSeat` and the todo center's `actionable` call) — over the round's active
 *     assignments, with the SAME role claims `decide` dispatches with
 *     (`CANCEL_ROUND_DISPATCH_ROLE_CLAIMS`). No seat rule is restated here.
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
 * plugin-attendance ONLY; every other plugin sees `undefined`. Without the port (all six methods)
 * plugin-attendance registers none of the five routes (fail-closed: no entry rather than a half-wired
 * one).
 */

import { pool } from '../db/pg'
import { ApprovalProductService } from '../services/ApprovalProductService'
import { ServiceError } from '../services/ApprovalBridgeService'
import { APPROVAL_ERROR_CODES } from '../services/approval-bridge-types'
import { canReadApprovalInstance } from '../services/approval-instance-readability'
import { isSystemSentinelActor } from '../services/ApprovalAssigneeResolver'
import {
  decisionDoorIsSeatGated,
  resolveCanDecideCurrentNode,
  type DecidableInstanceRow,
  type SeatedAssignment,
} from '../services/approval-seat-authorization'
import {
  CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX,
  readCancelRoundDurableProjectionV1,
  type CancelRoundCancellationOutcomeV1,
} from '../core/attendance-cancellation-execution-port'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { Logger } from '../core/logger'
import { isAdmin as isRbacAdmin, listUserPermissions } from '../rbac/service'

const logger = new Logger('ApprovalCancelRoundEntryPort')

/**
 * 增补 P-11 — the todo count refresh after a launch / approve / reject / withdraw on the attendance
 * side. The host binds this to the SAME publisher every approval-side action route calls
 * (`publishApprovalCountsForUsers`: `approval:counts-updated` + `todo:counts-updated`, the latter
 * through the todo center's one shared pending query), so the attendance-side routes refresh the
 * same badges without a second copy of either. Optional: an unbound port simply does not push.
 *
 * `permissions` is the per-user permission context the count is computed on (the shared query's
 * permission-queue arm). The approval-side routes do not pass it; this entry does (see
 * `publishCancelRoundCounts`).
 */
export type CancelRoundCountPublisherV1 = (
  users: Array<{ userId: string; roles?: string[]; permissions?: string[] }>,
  reason: string,
) => Promise<void>

export interface CancelRoundEntryPortDepsV1 {
  readonly publishCounts?: CancelRoundCountPublisherV1
}

/** The round's ACTIVE person seats — whose pending counts a transition on the round can move. */
async function listActiveUserSeatIds(query: Queryable, engineInstanceId: string): Promise<string[]> {
  const result = await query.query(
    `SELECT DISTINCT assignee_id
       FROM approval_assignments
      WHERE instance_id = $1
        AND is_active = TRUE
        AND assignment_type = 'user'`,
    [engineInstanceId],
  )
  return (result.rows as Array<{ assignee_id?: unknown }>)
    .map((row) => row.assignee_id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
}

/**
 * The actor's role claims as the plugin handed them over — it reads them from the authenticated
 * request the way the approval-side routes do (`resolveApprovalActorRoles`). Only non-string /
 * blank entries are dropped and duplicates folded; nothing is rewritten, so the pushed count is
 * computed on the same role set the actor's own `GET /api/todo/count` resolves.
 */
function normalizeActorRoleClaims(roles: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(roles)) return []
  return [...new Set(roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0))]
}

/**
 * The actor's permission claims as the plugin handed them over — read from the authenticated
 * request the way `GET /api/todo/count` reads them (`resolveApprovalActorPermissions`). Trimmed,
 * blanks dropped, duplicates folded, so the actor's pushed count covers the same permission-queue
 * seats their own count read does.
 */
function normalizeActorPermissionClaims(permissions: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(permissions)) return []
  return [
    ...new Set(
      permissions
        .filter((permission): permission is string => typeof permission === 'string')
        .map((permission) => permission.trim())
        .filter((permission) => permission.length > 0),
    ),
  ]
}

/**
 * The permission context of a user this entry's action touched but who did not act (a seat holder
 * when the requester launches or withdraws; the requester and the other seats when an approver
 * acts). There is no request of theirs to read, so it is resolved by `listUserPermissions` — the
 * resolver the authentication layer builds `req.user.permissions` from when token claims are not
 * trusted (the production setting), i.e. what their own `GET /api/todo/count` reads. A failed
 * lookup narrows to no permissions (the count the approval side pushes), never fails the push.
 */
async function resolveAffectedUserPermissions(userId: string): Promise<string[]> {
  try {
    return normalizeActorPermissionClaims(await listUserPermissions(userId))
  } catch {
    return []
  }
}

/**
 * The role claim of the same touched-but-not-acting user. Their own `GET /api/todo/count` reads the
 * one role the authentication layer puts on `req.user.role` when token claims are not trusted (the
 * production setting): `AuthService.resolveRbacProfile` takes the `users.role` column and upgrades it
 * to `'admin'` when `user_roles` holds `admin` (`isAdmin`, the same lookup). The same two reads here
 * give the push that role, so a pending item seated on that role arm is counted in the push as it is
 * in the read. A failed admin lookup keeps the column value (as `resolveRbacProfile` does); a failed
 * column read gives no role claims (the count the approval side pushes); neither fails the push.
 */
async function resolveAffectedUserRoles(userId: string): Promise<string[]> {
  let role = ''
  try {
    if (!pool) return []
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [userId])
    const stored = (result.rows[0] as { role?: unknown } | undefined)?.role
    role = typeof stored === 'string' ? stored.trim() : ''
  } catch {
    return []
  }
  try {
    if (await isRbacAdmin(userId)) role = 'admin'
  } catch {
    // keep the column value, as the authentication layer does
  }
  return role ? [role] : []
}

/**
 * Best effort by contract: the action has already committed, so a failed push is logged
 * (values-free: the reason token only) and never turns a done action into an error.
 *
 * The ACTOR's entry carries the actor's role AND permission claims — the viewer the actor's own
 * `GET /api/todo/count` resolves from the same authenticated request — so the actor's pushed count
 * matches that read, permission-queue seats included (the approval-side routes hand the shared
 * publisher the caller's roles only). It goes FIRST and the actor id is not repeated among the
 * others: the publisher keeps the first entry per user id, and the actor is often one of the seats
 * too (an approver acting on their own seat). Everyone else is pushed with the permission context
 * their own count read resolves (`resolveAffectedUserPermissions`) and with the role claim that
 * read resolves (`resolveAffectedUserRoles`); the approval-side routes push the other users an
 * action touches with neither.
 */
async function publishCancelRoundCounts(
  publishCounts: CancelRoundCountPublisherV1 | undefined,
  actor: { readonly userId: string; readonly roles?: readonly string[]; readonly permissions?: readonly string[] },
  otherUserIds: Array<string | null | undefined>,
  reason: string,
): Promise<void> {
  if (!publishCounts) return
  try {
    const actorId = typeof actor.userId === 'string' ? actor.userId.trim() : ''
    const others = [
      ...new Set(otherUserIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
    ].filter((id) => id !== actorId)
    const otherEntries = await Promise.all(
      others.map(async (userId) => ({
        userId,
        roles: await resolveAffectedUserRoles(userId),
        permissions: await resolveAffectedUserPermissions(userId),
      })),
    )
    const users: Array<{ userId: string; roles?: string[]; permissions?: string[] }> = [
      ...(actorId
        ? [{
            userId: actorId,
            roles: normalizeActorRoleClaims(actor.roles),
            permissions: normalizeActorPermissionClaims(actor.permissions),
          }]
        : []),
      ...otherEntries,
    ]
    if (users.length === 0) return
    await publishCounts(users, reason)
  } catch (error) {
    try {
      logger.warn(`cancel-round todo count publish failed (${reason})`, error instanceof Error ? error : undefined)
    } catch {
      // logging is diagnostic only
    }
  }
}

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
  /** P-5 (iii) values-free delivery status of THIS round's own notices — see `CancelRoundDeliveryV1`. */
  readonly deliveries: readonly CancelRoundDeliveryV1[]
}

/**
 * P-5 = (iii) Full delivery, fields per the owner's 「Full status, no raw ids/errors (Recommended)」:
 * per delivery the status (delivered / pending / failed), the channel TYPE, the attempt count and
 * timestamps — and nothing else. No external message / task id, no provider error text, no recipient
 * (not the local user id, not the DingTalk id), no node key: the client renders a fixed category
 * message per status. The lock invariant that rides with this read is that a failed delivery changes
 * NOTHING about the round (`approval_rounds.outcome`, the engine instance's status, its seats) — no
 * code path here or in either ledger writes those; the integration suite measures it.
 *
 * WHICH NOTICES A CANCEL ROUND PRODUCES. The round is an ordinary platform instance, so its seats emit
 * the ordinary `approval.task_created` events, and exactly two consumers persist a per-recipient
 * delivery row keyed by the instance id: the DingTalk approval-card action of an
 * `approval.task_created` automation rule (`dingtalk_approval_card_deliveries`) and the DingTalk todo
 * mirror (`dingtalk_todo_mirrors`, default OFF). The attendance notification ledger
 * (`attendance_notification_deliveries`) has no cancel-round producer, and the generic person-message
 * ledger is keyed by rule / record, not by an approval instance, so neither can be attributed to a
 * round and neither is read.
 */
export type CancelRoundDeliveryChannelTypeV1 = 'dingtalk_approval_card' | 'dingtalk_todo'
export type CancelRoundDeliveryStatusV1 = 'delivered' | 'pending' | 'failed'

export interface CancelRoundDeliveryV1 {
  readonly channelType: CancelRoundDeliveryChannelTypeV1
  readonly status: CancelRoundDeliveryStatusV1
  readonly attempts: number
  readonly createdAt: string
  readonly lastAttemptAt: string | null
  readonly updatedAt: string
}

/** One ledger row as the delivery query below reads it (ids and error text are never selected). */
export interface CancelRoundDeliveryLedgerRowV1 {
  readonly channel_type: string
  readonly ledger_status: string
  readonly attempt_count: number | string | null
  readonly created_at: Date | string
  readonly last_attempt_at: Date | string | null
  readonly updated_at: Date | string
}

/**
 * Ledger state → the three ratified values. PROVISIONAL implementation choice (the ratified text
 * names the three values, not the mapping); the design MD carries the full table for owner / gate
 * review and a unit test pins every row of it.
 *
 * - Approval card (`send_status`): `sent` ⇒ delivered; `failed` ⇒ failed; `pending` ⇒ pending;
 *   `outcome_unknown` ⇒ pending — the provider may well have delivered it and it is never re-sent,
 *   so it is UNCONFIRMED, not failed. A card row is ONE send by construction (inserted immediately
 *   before its single send call; a re-send is a new row), so `attempts` is 1 and the attempt time is
 *   the row's creation time.
 * - Todo mirror (`status`): `created` / `completing` / `completed` ⇒ delivered (the todo exists or
 *   existed); `pending` / `sending` / `outcome_unknown` ⇒ pending; `failed` ⇒ failed; `superseded` /
 *   `skipped` ⇒ failed when at least one send was attempted, and OMITTED when none was (the seat or
 *   the instance moved on before any attempt: there was no delivery to report). `attempts` is the
 *   ledger's own counter (after a todo is created the ledger reuses that counter for the completion
 *   phase — recorded in the MD).
 * - Anything else ⇒ `null` (not reported): an unknown ledger state is never guessed into a status.
 */
export function projectCancelRoundDeliveryRowV1(row: CancelRoundDeliveryLedgerRowV1): CancelRoundDeliveryV1 | null {
  const attemptCount = Number.parseInt(String(row.attempt_count ?? '0'), 10)
  const createdAt = toIso(row.created_at) ?? ''
  const updatedAt = toIso(row.updated_at) ?? createdAt
  if (row.channel_type === 'dingtalk_approval_card') {
    const status: CancelRoundDeliveryStatusV1 | null =
      row.ledger_status === 'sent'
        ? 'delivered'
        : row.ledger_status === 'failed'
          ? 'failed'
          : row.ledger_status === 'pending' || row.ledger_status === 'outcome_unknown'
            ? 'pending'
            : null
    if (!status) return null
    return { channelType: 'dingtalk_approval_card', status, attempts: 1, createdAt, lastAttemptAt: createdAt, updatedAt }
  }
  if (row.channel_type === 'dingtalk_todo') {
    const attempts = Number.isFinite(attemptCount) && attemptCount > 0 ? attemptCount : 0
    let status: CancelRoundDeliveryStatusV1 | null = null
    switch (row.ledger_status) {
      case 'created':
      case 'completing':
      case 'completed':
        status = 'delivered'
        break
      case 'pending':
      case 'sending':
      case 'outcome_unknown':
        status = 'pending'
        break
      case 'failed':
        status = 'failed'
        break
      case 'superseded':
      case 'skipped':
        status = attempts > 0 ? 'failed' : null
        break
      default:
        status = null
    }
    if (!status) return null
    return {
      channelType: 'dingtalk_todo',
      status,
      attempts,
      createdAt,
      lastAttemptAt: toIso(row.last_attempt_at),
      updatedAt,
    }
  }
  return null
}

/**
 * The round's own delivery rows from the two ledgers, oldest first. The SELECT lists only what the
 * projection needs: no id, task id, recipient, node key or error column is read at all.
 */
async function readCancelRoundDeliveries(
  query: Queryable,
  engineInstanceId: string | null,
): Promise<CancelRoundDeliveryV1[]> {
  if (!engineInstanceId) return []
  const result = await query.query(
    `SELECT channel_type, ledger_status, attempt_count, created_at, last_attempt_at, updated_at
       FROM (
         SELECT 'dingtalk_approval_card'::text AS channel_type,
                c.send_status AS ledger_status,
                NULL::int AS attempt_count,
                c.created_at,
                NULL::timestamptz AS last_attempt_at,
                c.updated_at,
                c.id::text AS row_key
           FROM dingtalk_approval_card_deliveries c
          WHERE c.instance_id = $1
         UNION ALL
         SELECT 'dingtalk_todo'::text,
                t.status,
                t.attempt_count,
                t.created_at,
                t.last_attempt_at,
                t.updated_at,
                t.id::text
           FROM dingtalk_todo_mirrors t
          WHERE t.instance_id = $1
       ) d
      ORDER BY created_at ASC, channel_type ASC, row_key ASC`,
    [engineInstanceId],
  )
  const deliveries: CancelRoundDeliveryV1[] = []
  for (const row of result.rows as unknown as CancelRoundDeliveryLedgerRowV1[]) {
    const projected = projectCancelRoundDeliveryRowV1(row)
    if (projected) deliveries.push(projected)
  }
  return deliveries
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
 * The MINIMAL success shape of `decide` / `withdraw` (owner 2026-09-29 14:3x, 「Minimal action
 * response (Recommended)」): which round was acted on, and where it now stands — nothing else. The
 * round summary is NOT built on this path: it is a read model the summary route serves behind lock
 * I7 alone, and the approver route deliberately has no I7 in front of its seat check (a seat holder
 * need not be a reader of the original document), so handing the summary back here would put the
 * same read model behind a second predicate.
 */
export interface CancelRoundActionOutcomeV1 {
  readonly roundId: string
  readonly outcome: CancelRoundOutcomeV1
  readonly status: CancelRoundSummaryStatusV1
}

/**
 * A2 — the closed result of `decide` / `withdraw`. `noRound` means the document has no cancel round
 * at all (the plugin answers it with the entry's not-found body). A refusal carries ONLY the service
 * entry's own `(status, code, message)` — `ServiceError.details` never crosses this boundary. Any
 * other error is rethrown for the caller's generic 500.
 */
export type CancelRoundActionResultV1 =
  | { readonly ok: true; readonly round: CancelRoundActionOutcomeV1 }
  | { readonly ok: false; readonly noRound: true }
  | { readonly ok: false; readonly noRound?: false; readonly status: number; readonly code: string; readonly message: string }

/**
 * A2 — who acts. `userName` is the display name for the audit row (falls back to the id there).
 * `roles` are the actor's role claims from the authenticated request (the plugin reads them the way
 * `resolveApprovalActorRoles` does). They are used for ONE thing: the actor's own todo / approval
 * count push after the action (增补 P-11). They never reach the creation path or the dispatched
 * action — see `dispatchOnLatestCancelRound` for why the action itself carries no role claims.
 */
export interface CancelRoundEntryActorV1 {
  readonly userId: string
  readonly userName?: string
  readonly roles?: readonly string[]
  /** The caller's permission claims — for the post-action count push only (see `publishCancelRoundCounts`). */
  readonly permissions?: readonly string[]
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
    actor: { userId: string; userName?: string; roles?: readonly string[] },
    options?: { reason?: string | null },
  ): Promise<CancelRoundLaunchResultV1>
  /**
   * A2 — an approver's `approve` / `reject` on the document's latest cancel round, dispatched AS the
   * caller through `ApprovalProductService.dispatchAction` (the service entry of
   * `POST /api/approvals/:id/actions`). The seat check, the §2-G3 seat rules and the §9-9 action set
   * are that entry's; a caller with no seat gets its existing refusal. Success carries only
   * `CancelRoundActionOutcomeV1` — never the round summary. `expectedRoundId` (optional, phase D
   * D2): the round the caller has on screen; when it is not the document's latest round the call is
   * refused before anything is dispatched (see `dispatchOnLatestCancelRound`).
   */
  decide(
    documentInstanceId: string,
    actor: CancelRoundEntryActorV1,
    request: { action: CancelRoundDecisionActionV1; comment?: string | null; expectedRoundId?: string | null },
  ): Promise<CancelRoundActionResultV1>
  /**
   * A2 — the requester's withdraw: the engine's `revoke` on the document's latest cancel round, through
   * the same service entry, whose revoke gate (allowRevoke → requester → status → window) decides.
   */
  withdraw(
    documentInstanceId: string,
    actor: CancelRoundEntryActorV1,
    request?: { comment?: string | null; expectedRoundId?: string | null },
  ): Promise<CancelRoundActionResultV1>
  /**
   * C2 — the pending cancel rounds `viewerId` could decide RIGHT NOW through `decide`: the door's own
   * seat predicate over each round's active assignments, with the role claims `decide` dispatches
   * with. Keyed by round; the plugin applies the entry's document gate (org, leave, approval instance)
   * and pagination. See `listSeatedPendingCancelRoundsV1`.
   */
  listSeatedPendingRounds(viewerId: string): Promise<CancelRoundSeatedPendingRoundV1[]>
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
 * definition's `runtime_graph.policy.allowRevoke`, then the engine instance's `requester_snapshot.id`,
 * then the terminal check (the round's own `outcome` and the engine instance's `status`), then
 * `current_node_key`, `revokeBeforeNodeKeys` and the handled-record count at that node. A `true` here
 * means the engine would accept this viewer's revoke right now; a `false` names the code the engine
 * would answer — for every viewer, the requester and anyone else alike (the terminal check sits AFTER
 * the requester check, exactly as in the engine, so a non-requester on a finished round reads
 * `APPROVAL_REVOKE_FORBIDDEN`, the code the engine answers them). The only earlier exit is a round
 * row with no engine instance at all, which the engine could not be asked about. The
 * employee-reachable HTTP path to this gate is the attendance-side withdraw route (A2); the
 * approval-side action route keeps its own permission guard in front of the same engine. The suite
 * pins both engine directions in-process and over HTTP.
 */
async function resolveCanWithdraw(
  query: Queryable,
  row: RoundRow,
  viewerId: string,
): Promise<{ canWithdraw: boolean; reason: CancelRoundWithdrawBlockedReasonV1 | null }> {
  if (!row.engine_instance_id) {
    return { canWithdraw: false, reason: 'INVALID_STATUS_TRANSITION' }
  }
  if (row.allow_revoke !== true) {
    return { canWithdraw: false, reason: 'APPROVAL_REVOKE_DISABLED' }
  }
  if (row.engine_requester_id !== viewerId) {
    return { canWithdraw: false, reason: 'APPROVAL_REVOKE_FORBIDDEN' }
  }
  if (
    row.outcome !== 'pending'
    || typeof row.engine_status !== 'string'
    || TERMINAL_ENGINE_STATUSES.has(row.engine_status)
  ) {
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
  const deliveries = await readCancelRoundDeliveries(query, row.engine_instance_id)

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
      deliveries,
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
 * `roles: []` on the DISPATCHED action: the action carries no role claims. A cancel round's seats
 * are PERSON seats — the creation path seats the original approvers by user id (lock §14.1), and
 * §9-9 / §14.3 #12–#13 refuse every verb or job that could change a seat — so a role claim can never
 * be what seats an actor on it; passing none can only narrow, never widen (the integration suite
 * asserts every assignment on a launched round is a `user` assignment). `actor.roles` is NOT handed
 * to the action.
 *
 * The pending-count refresh (增补 P-11) runs after the action when the host bound a publisher: the
 * caller plus the round's person seats as they were BEFORE and AFTER the action, through the same
 * publisher the approval-side action routes use. The caller's entry carries `actor.roles` and
 * `actor.permissions` (their count covers every pending item they see, not only this round's seat —
 * role-seated and permission-queue ones included); the other users' entries carry their resolved
 * permission context. Neither is handed to the action. Best effort — the action has already committed.
 */
const CANCEL_ROUND_DISPATCH_ACTIONS: ReadonlySet<string> = new Set(['approve', 'reject', 'revoke'])

/**
 * The role claims a cancel-round action is DISPATCHED with — none (see the `roles: []` paragraph
 * above). ONE constant, read by both the dispatch below and the C2 list
 * (`listSeatedPendingCancelRoundsV1`), so the list's seat verdict is computed on exactly the role set
 * the door will see when the listed viewer acts: if this ever changes, both change together.
 */
export const CANCEL_ROUND_DISPATCH_ROLE_CLAIMS: readonly string[] = Object.freeze([])

/**
 * Phase D D2 — the refusal when the caller names the round they have on screen
 * (`expectedRoundId`) and it is not the document's latest round. No new code: it is the engine's
 * existing `INVALID_STATUS_TRANSITION` with the engine's own message for a terminal instance. By
 * lock I3 a document has at most one pending round and the latest pick puts it first, so a round
 * other than the latest is a finished one (or not this document's at all). Checked before anything
 * is dispatched or pushed, so the refusal writes nothing.
 */
export const CANCEL_ROUND_EXPECTED_ROUND_STALE = Object.freeze({
  status: 409,
  code: APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION,
  message: 'Approval is already in a terminal status',
})

/**
 * Exported with its `Queryable` injected so the verb allow-list above can be pinned on its own by a
 * unit test (a verb outside it must throw BEFORE any query); the port below is its only production
 * caller.
 */
export async function dispatchOnLatestCancelRound(
  query: Queryable,
  documentInstanceId: string,
  actor: CancelRoundEntryActorV1,
  action: 'approve' | 'reject' | 'revoke',
  comment: string | null | undefined,
  publishCounts?: CancelRoundCountPublisherV1,
  expectedRoundId?: string | null,
): Promise<CancelRoundActionResultV1> {
  if (!CANCEL_ROUND_DISPATCH_ACTIONS.has(action)) {
    // The plugin validates the verb before calling; a caller that bypasses that is a programming
    // error, answered with the generic 500 rather than a code of its own.
    throw new Error(`cancel-round entry: action ${JSON.stringify(action)} is not dispatched through this port`)
  }
  const row = await selectLatestCancelRoundRow(query, documentInstanceId)
  if (!row || !row.engine_instance_id) return { ok: false, noRound: true }
  // Phase D D2: the caller names the round on screen ⇒ it must be the round this call would act on.
  // The action below is dispatched on THAT round's own engine instance, so a round that finishes after
  // this check is refused by the engine itself.
  if (typeof expectedRoundId === 'string' && row.round_id !== expectedRoundId) {
    return { ok: false, ...CANCEL_ROUND_EXPECTED_ROUND_STALE }
  }
  // The seats BEFORE the action: an approve / reject / withdraw deactivates them, and those are the
  // people whose pending count drops (the approval-side route only re-reads the seats left active).
  const seatsBefore = publishCounts
    ? await listActiveUserSeatIds(query, row.engine_instance_id).catch(() => [] as string[])
    : []
  try {
    const service = new ApprovalProductService()
    await service.dispatchAction(
      row.engine_instance_id,
      { action, ...(typeof comment === 'string' ? { comment } : {}) },
      {
        userId: actor.userId,
        userName: actor.userName || actor.userId,
        roles: [...CANCEL_ROUND_DISPATCH_ROLE_CLAIMS],
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
  const round = await readActedRoundOutcome(query, row.round_id)
  if (publishCounts) {
    const seatsAfter = await listActiveUserSeatIds(query, row.engine_instance_id).catch(() => [] as string[])
    await publishCancelRoundCounts(publishCounts, actor, [...seatsBefore, ...seatsAfter], `cancel-round:${action}`)
  }
  return { ok: true, round }
}

/**
 * The minimal post-action read: the SAME round the action was dispatched on (by id — not a fresh
 * 「latest」 pick, which a relaunch racing in could move), its outcome and the P-2 status token. An
 * outcome outside the ratified six fails loudly, exactly as the summary reader does.
 */
async function readActedRoundOutcome(query: Queryable, roundId: string): Promise<CancelRoundActionOutcomeV1> {
  const result = await query.query('SELECT outcome FROM approval_rounds WHERE id = $1', [roundId])
  const outcome = result.rows[0]?.outcome
  if (!isRoundOutcome(outcome)) {
    throw new Error(`cancel-round entry: unrecognised round outcome ${JSON.stringify(outcome)} on round ${roundId}`)
  }
  return { roundId, outcome, status: statusTokenFor(outcome) }
}

/** C2 — one round the viewer could decide now, keyed back to its ORIGINAL document. */
export interface CancelRoundSeatedPendingRoundV1 {
  readonly roundId: string
  readonly engineInstanceId: string
  /** The ORIGINAL document (`approval_rounds.document_id`) — what the plugin keys its request row on. */
  readonly documentInstanceId: string
  /** `approval_rounds.started_at`, ISO. */
  readonly launchedAt: string
}

type SeatedPendingCandidateRow = {
  round_id: string
  document_id: string
  started_at: Date | string
  engine_instance_id: string
  status: string
  source_system: string | null
  published_definition_id: string | null
  current_node_key: string | null
  metadata: Record<string, unknown> | null
}

type SeatedPendingAssignmentRow = SeatedAssignment & { instance_id: string }

/**
 * C2 (owner 2026-09-29 16:5x 「Attendance-side list (Recommended)」) — the pending cancel rounds the
 * viewer could approve / reject RIGHT NOW through `decide`, newest launch first.
 *
 * THE SEAT VERDICT IS THE DOOR'S OWN. `decide` dispatches, AS the caller and with
 * `CANCEL_ROUND_DISPATCH_ROLE_CLAIMS`, into `ApprovalProductService.dispatchAction`, whose 403
 * `APPROVAL_ASSIGNMENT_REQUIRED` gate is built from `assignmentMatchesActor` over the active
 * assignments at the decidable node keys. `resolveCanDecideCurrentNode` is that gate restated as a
 * verdict (the same function the todo center's `actionable`, the detail DTO's `canDecideCurrentNode`
 * and `resolveLegacyDecisionSeat` call; pinned against the door by
 * `approval-can-decide-current-node.db.test.ts`); `decisionDoorIsSeatGated` excludes a row the door
 * would not seat-gate at all (no published definition / not platform — `dispatchAction` refuses
 * those outright, so `resolveCanDecideCurrentNode`'s status-quo `true` for them must not list them).
 * Both are CALLED here, never restated. The inputs are the ones the door reads: the engine instance
 * row (status, source system, published definition, current node, parallel metadata) and its ACTIVE
 * assignments (`is_active = TRUE`, the door's own filter), with the dispatch role claims.
 *
 * WHICH ROUNDS. `approval_rounds.kind = 'cancel' AND outcome = 'pending'` — at most one per document
 * (I3, `uq_approval_rounds_pending_document`), and the pending round is what `decide`'s 「latest」
 * pick selects first, so every listed round is the round `decide` would act on for its document.
 *
 * CANDIDATE NARROWING, NOT A PREDICATE. The first read keeps only rounds whose engine instance has
 * SOME assignment row (active or not, any type) whose `assignee_id` is the viewer or one of the
 * dispatch role claims. `assignmentMatchesActor` can only ever match a row whose `assignee_id` is
 * one of those values (user arm: the actor id; role arm: a role claim), so no round the predicate
 * would admit is dropped; the narrowing only keeps the read proportional to the viewer's own seats
 * instead of every pending round. The verdict is the predicate's alone — removing the narrowing
 * leaves every listed item unchanged (design MD §10 records that mutation).
 */
export async function listSeatedPendingCancelRoundsV1(
  query: Queryable,
  viewerId: string,
): Promise<CancelRoundSeatedPendingRoundV1[]> {
  const viewer = typeof viewerId === 'string' ? viewerId.trim() : ''
  if (!viewer) return []
  const candidates = await query.query(
    `SELECT r.id AS round_id,
            r.document_id,
            r.started_at,
            e.id AS engine_instance_id,
            e.status,
            e.source_system,
            e.published_definition_id,
            e.current_node_key,
            e.metadata
       FROM approval_rounds r
       JOIN approval_instances e ON e.id = r.engine_instance_id
      WHERE r.kind = 'cancel'
        AND r.outcome = 'pending'
        AND EXISTS (
              SELECT 1
                FROM approval_assignments a
               WHERE a.instance_id = r.engine_instance_id
                 AND a.assignee_id = ANY($1::text[])
            )
      ORDER BY r.started_at DESC, r.id DESC`,
    [[viewer, ...CANCEL_ROUND_DISPATCH_ROLE_CLAIMS]],
  )
  const rows = candidates.rows as unknown as SeatedPendingCandidateRow[]
  if (rows.length === 0) return []
  const assignmentResult = await query.query(
    `SELECT instance_id, node_key, is_active, assignment_type, assignee_id
       FROM approval_assignments
      WHERE instance_id = ANY($1::text[])
        AND is_active = TRUE`,
    [[...new Set(rows.map((row) => row.engine_instance_id))]],
  )
  const assignmentsByInstance = new Map<string, SeatedAssignment[]>()
  for (const assignment of assignmentResult.rows as unknown as SeatedPendingAssignmentRow[]) {
    const list = assignmentsByInstance.get(assignment.instance_id) ?? []
    list.push(assignment)
    assignmentsByInstance.set(assignment.instance_id, list)
  }
  const seated: CancelRoundSeatedPendingRoundV1[] = []
  for (const row of rows) {
    const instance: DecidableInstanceRow = {
      id: row.engine_instance_id,
      status: row.status,
      source_system: row.source_system,
      published_definition_id: row.published_definition_id,
      current_node_key: row.current_node_key,
      metadata: row.metadata,
    }
    const canDecide =
      decisionDoorIsSeatGated(instance)
      && resolveCanDecideCurrentNode({
        instance,
        assignments: assignmentsByInstance.get(row.engine_instance_id) ?? [],
        viewerUserId: viewer,
        viewerRoles: CANCEL_ROUND_DISPATCH_ROLE_CLAIMS,
      })
    if (!canDecide) continue
    seated.push({
      roundId: row.round_id,
      engineInstanceId: row.engine_instance_id,
      documentInstanceId: row.document_id,
      launchedAt: toIso(row.started_at) ?? '',
    })
  }
  return seated
}

export function buildApprovalCancelRoundEntryPort(deps: CancelRoundEntryPortDepsV1 = {}): ApprovalCancelRoundEntryPort {
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
        // Only the identity and the display name reach the creation path; the role claims are for
        // the count push below.
        await service.createCancelRoundInstance(
          documentInstanceId,
          { userId: actor.userId, ...(actor.userName !== undefined ? { userName: actor.userName } : {}) },
          { reason: options.reason ?? null },
        )
      } catch (error) {
        if (error instanceof ServiceError) {
          const message = CANCEL_ROUND_SEAT_CLASS_CODES.has(error.code)
            ? CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE
            : error.message
          return { ok: false, status: error.statusCode, code: error.code, message }
        }
        throw error
      }
      const summary = await readCancelRoundSummaryForDocumentV1(db(), documentInstanceId, actor.userId)
      if (deps.publishCounts && summary.round?.engineInstanceId) {
        const seats = await listActiveUserSeatIds(db(), summary.round.engineInstanceId).catch(() => [] as string[])
        await publishCancelRoundCounts(deps.publishCounts, actor, seats, 'cancel-round:launch')
      }
      return { ok: true, summary }
    },
    decide: (documentInstanceId, actor, request) =>
      dispatchOnLatestCancelRound(
        db(), documentInstanceId, actor, request.action, request.comment, deps.publishCounts, request.expectedRoundId,
      ),
    withdraw: (documentInstanceId, actor, request = {}) =>
      dispatchOnLatestCancelRound(
        db(), documentInstanceId, actor, 'revoke', request.comment, deps.publishCounts, request.expectedRoundId,
      ),
    listSeatedPendingRounds: (viewerId) => listSeatedPendingCancelRoundsV1(db(), viewerId),
  }
}
