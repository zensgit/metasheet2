/**
 * Lock §3 C-1 (`approval-change-request-design-lock-draft-20260915.md:81-95`) — the PORT through
 * which the approval side reaches 完整业务取消, and nothing else.
 *
 * Direction and precedent. This is the same hexagonal shape as `workday-calendar-port.ts` (T3-2):
 * a single-provider, process-wide registry that lets the approval path call into the attendance
 * domain WITHOUT a compile-time dependency on the plugin and without ever reading `attendance_*`
 * itself. The plugin constructs its request-operation boundary once at activate
 * (`plugins/plugin-attendance/index.cjs`, `w4RequestOperationBoundary = …`) and binds THAT object
 * here.
 *
 * What is bound is deliberately the WHOLE `AttendanceRequestOperationBoundaryV1`, not a bespoke
 * `cancelForApproval(...)`. Lock §3 C-1 「接口形态」 and the v5 review's P1-A both forbid lifting
 * `requestCancelAdapter.execute` out on its own: 「**外部事务入口复用同一套 W4 操作协议** …
 * **仅移交连接与事务生命周期的所有权**——不是把 `requestCancelAdapter.execute` 搬出来单独调」.
 * A narrower port would re-introduce exactly what that clause rejects, so the port type is the
 * boundary interface itself and the approval side calls its `executeInExternalTransaction`.
 *
 * ⚠️ FAIL CLOSED when unbound — the one place this deliberately DIFFERS from the workday-calendar
 * precedent, which fails OPEN to natural elapsed arithmetic. An SLA deadline computed without a
 * calendar is merely less precise; a cancel round redeemed without a provider would write
 * `approval_rounds.outcome = 'applied'` and let its engine instance reach `approved` with **zero
 * business cancellation performed** — a round that claims the leave was cancelled when it was not.
 * `getAttendanceCancellationExecutionPort()` therefore returns `undefined` and the redemption
 * branch throws, which rolls the caller's transaction back and leaves the round `pending` with its
 * seats: lock §3 C-3 row 5 (基础设施异常 ⇒ 事务回滚 ⇒ 保持 `pending` ⇒ 继续占位), the same shape
 * `CANCEL_ROUND_WINDOW_ANCHOR_MISSING` already takes.
 */

import crypto from 'node:crypto'

import type {
  AttendanceRequestOperationBoundaryV1,
  AttendanceRequestOperationExternalTransactionResultV1,
} from '../attendance/w4c3b-request-operation-boundary'

/**
 * Lock §3 C-2 step ④'s replay key, derived — and NOT the round id itself.
 *
 * ⛔ WHY THIS EXISTS (a defect this branch shipped and this commit fixes). The redemption hook
 * passed `approval_rounds.id` straight through as the W4 `operationId`, with a comment asserting
 * 「`operationId` … must be a UUID … The round row's own id is exactly the right identity」. The
 * first half is true; the second is FALSE. `approval_rounds.id` is `text` (migration
 * `approval_rounds_pkey` over `id text NOT NULL`, its only shape constraint being
 * `chk_approval_rounds_id_nonblank`), and `createCancelRoundInstance` mints it as
 * `apr_${crypto.randomUUID()}` — 40 characters with an `apr_` prefix. The boundary's
 * `normalizeExternalTransactionInput` → `normalizeInput` → `uuidOrNull` refuses it
 * (`W4C3B_REQUEST_BOUNDARY_INPUT_INVALID`, 500), so EVERY redemption against the real boundary
 * failed. Four acceptance cases were green over it because a test double never normalizes its
 * input — which is exactly the class of gap the end-to-end case in
 * `approval-cancel-round-redemption.db.test.ts` was written to find, and did, on its first run.
 *
 * WHY v5 AND NOT PREFIX-STRIPPING. `apr_<uuid>` is what the generator produces TODAY; nothing in
 * the schema enforces it, and a round row whose id does not match would silently fall back to
 * something else or throw at redemption time. A UUIDv5 over the round id is total (every non-blank
 * id maps), deterministic (the same round always replays under the same key — which is the ONLY
 * property step ④ needs: a round passes outlet #5 at most once, so a retry after a rolled-back
 * attempt must not mint a second operation) and injective for practical purposes.
 *
 * Same construction as `w4c0-identity.ts:281-291` (sha1 over namespace‖name, version and RFC 4122
 * variant bits stamped) — copied rather than imported because that module's derivations are bound
 * to the source-matrix `idRule` families and their TS/SQL golden-parity gate, and this key is
 * neither: it is minted by the APPROVAL side, has no SQL twin, and adding a namespace to that
 * matrix would put a non-matrix derivation under a gate that does not describe it.
 *
 * ⚠️ FLAGGED FOR OWNER REGISTRATION: the lock fixes 「同一轮次重试必须复用同一 operation」 but does
 * not name the derivation. This namespace UUID is an implementer choice and is FROZEN from here on
 * — changing it would make every already-redeemed round replay under a new key.
 */
export const CANCEL_ROUND_W4_OPERATION_NAMESPACE_V1 = '9d3bd35e-6a0f-5c2e-9a1c-0a0bd6f3a7c4'

export function deriveCancelRoundW4OperationIdV1(roundId: string): string {
  // Fail closed rather than derive a stable key for an empty identity: two different rounds must
  // never share one, and `''` would give them one.
  if (typeof roundId !== 'string' || roundId.length === 0) {
    throw new Error('deriveCancelRoundW4OperationIdV1: roundId must be a non-empty string')
  }
  const namespaceBytes = Buffer.from(CANCEL_ROUND_W4_OPERATION_NAMESPACE_V1.replace(/-/g, ''), 'hex')
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([namespaceBytes, Buffer.from(roundId, 'utf8')]))
    .digest()
    .subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50 // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = digest.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

/**
 * The port. Structurally the request-operation boundary; the approval side uses only
 * `executeInExternalTransaction`, but the type is not narrowed (see the module note — narrowing is
 * what lock §3 C-1 forbids, and a `Pick<>` here would invite a second, smaller contract later).
 */
export type AttendanceCancellationExecutionPort = AttendanceRequestOperationBoundaryV1

/**
 * Single-provider registry, mirroring `WorkdayCalendarRegistryImpl`. Exactly one attendance
 * request-operation boundary exists process-wide (the plugin builds one at activate), so binding a
 * second replaces the first and is logged.
 */
class AttendanceCancellationExecutionRegistryImpl {
  private provider: AttendanceCancellationExecutionPort | undefined
  private static instance: AttendanceCancellationExecutionRegistryImpl

  private constructor() {}

  static getInstance(): AttendanceCancellationExecutionRegistryImpl {
    if (!AttendanceCancellationExecutionRegistryImpl.instance) {
      AttendanceCancellationExecutionRegistryImpl.instance = new AttendanceCancellationExecutionRegistryImpl()
    }
    return AttendanceCancellationExecutionRegistryImpl.instance
  }

  register(provider: AttendanceCancellationExecutionPort): void {
    if (this.provider) {
      console.warn('AttendanceCancellationExecutionPort provider is being replaced')
    }
    this.provider = provider
  }

  unregister(): void {
    this.provider = undefined
  }

  get(): AttendanceCancellationExecutionPort | undefined {
    return this.provider
  }

  has(): boolean {
    return this.provider !== undefined
  }

  /** Clear the bound provider (test isolation). */
  clear(): void {
    this.provider = undefined
  }
}

export function getAttendanceCancellationExecutionRegistry(): AttendanceCancellationExecutionRegistryImpl {
  return AttendanceCancellationExecutionRegistryImpl.getInstance()
}

/** Bind the process-wide provider (the attendance plugin, once, at activate). */
export function registerAttendanceCancellationExecutionProvider(
  provider: AttendanceCancellationExecutionPort,
): void {
  getAttendanceCancellationExecutionRegistry().register(provider)
}

/** Unbind (plugin deactivate / test teardown). */
export function unregisterAttendanceCancellationExecutionProvider(): void {
  getAttendanceCancellationExecutionRegistry().unregister()
}

/**
 * Read the bound provider. `undefined` when no attendance plugin has registered one — the
 * redemption branch MUST treat that as 基础设施异常 and throw, never as 「nothing to cancel」.
 */
export function getAttendanceCancellationExecutionPort(): AttendanceCancellationExecutionPort | undefined {
  return getAttendanceCancellationExecutionRegistry().get()
}

export { AttendanceCancellationExecutionRegistryImpl }

// ---------------------------------------------------------------------------
// lock:86 「`reverseLeaveBalanceDeduction`(返回 `unrecoverableExpired`,必须呈现)」
// ---------------------------------------------------------------------------

/**
 * The reversal counters `reverseLeaveBalanceDeduction` returns
 * (`plugins/plugin-attendance/index.cjs:19398/:19445`), carried verbatim.
 */
export interface CancelRoundReversalSummaryV1 {
  readonly reversed: number
  readonly lots: number
  readonly unrecoverableExpired: number
  readonly alreadyReversed: boolean
}

/**
 * ⚠️ DEFAULT VALUE — OWNER 待裁, 按默认值 (see the design/verification MD's 呈现 section).
 *
 * lock:86 requires `unrecoverableExpired` to be 呈现 but names NO surface; §3.16 measured that the
 * payload IS persisted (the W4 seal writes `response_snapshot` in the approval side's own
 * transaction) while the approval side exposed no field carrying it. This type is the default
 * presentation contract that closes the 呈现 half; an owner who wants a different shape replaces it.
 *
 * THREE STATUSES, NOT TWO, and the third is the §3.16.1 lesson applied to the wire shape: if the
 * summary were simply ABSENT when nothing was reversed, 「nothing to reverse」 and 「the channel is
 * not wired」 would be byte-identical — exactly the `0 === 0` that could not tell 「computed」 from
 * 「never computed」. So a status token is carried on EVERY redemption:
 *
 *  - `cancelled`                          — reversal reported, every deducted minute returned.
 *  - `cancelled_with_unrecoverable_expired` — reversal reported, and `unrecoverableExpired > 0`:
 *      the cancellation SUCCEEDED, but some deducted minutes could not be returned because their
 *      grant lots had expired (`index.cjs:19417-19425`, its own §3a). This is the status lock:86
 *      demands be 呈现, and it is deliberately NOT 同形 with either neighbour: it is not
 *      `cancelled` (a caller that only checks 「did it cancel」 still learns the balance is short)
 *      and it is not a failure (nothing was rolled back; a generic-failure shape would be a LIE
 *      about a committed cancellation).
 *  - `cancelled_reversal_unreported`       — the W4 response carried no parseable reversal summary.
 *      Distinct from both so an unwired/changed payload can never be read as 「zero expired」.
 */
export type CancelRoundCancellationOutcomeV1 =
  | { readonly status: 'cancelled'; readonly reversal: CancelRoundReversalSummaryV1 }
  | {
    readonly status: 'cancelled_with_unrecoverable_expired'
    readonly reversal: CancelRoundReversalSummaryV1
  }
  | { readonly status: 'cancelled_reversal_unreported'; readonly reversal: null }

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Classify a successful W4 cancellation response into the outcome above.
 *
 * The shape read is the request-cancel adapter's own response envelope
 * (`index.cjs:35275-35285`): `{ ok, data: { requestId, status, orgId, userId, reversal, … } }`,
 * where `data.reversal` is `reverseLeaveBalanceDeduction`'s return value. Every success kind of
 * `AttendanceRequestOperationBoundaryResultV1` (`legacy` / `legacy_compat` / `executed` / `replay`)
 * carries `response`, so this is total over them; `business_refused` carries none and must never
 * reach here (it is a `blocked` closure, not a cancellation).
 *
 * TOTAL AND NON-THROWING on purpose: this runs inside the caller's SERIALIZABLE transaction after
 * the business cancellation has already been performed and sealed. A presentation classifier must
 * not be able to roll back a committed cancellation, so a payload it cannot read degrades to
 * `cancelled_reversal_unreported` rather than throwing.
 */
export function classifyCancelRoundCancellationOutcomeV1(
  response: unknown,
): CancelRoundCancellationOutcomeV1 {
  const data = (response as { data?: unknown } | null | undefined)?.data
  const reversal = (data as { reversal?: unknown } | null | undefined)?.reversal
  if (typeof reversal !== 'object' || reversal === null) {
    return { status: 'cancelled_reversal_unreported', reversal: null }
  }
  const raw = reversal as Record<string, unknown>
  const unrecoverableExpired = finiteNumberOrNull(raw.unrecoverableExpired)
  const reversed = finiteNumberOrNull(raw.reversed)
  const lots = finiteNumberOrNull(raw.lots)
  // `unrecoverableExpired` is THE field lock:86 names, so an unreadable one is unreported rather
  // than defaulted to 0 — defaulting would manufacture the reassuring answer from missing data.
  if (unrecoverableExpired === null || reversed === null || lots === null) {
    return { status: 'cancelled_reversal_unreported', reversal: null }
  }
  const summary: CancelRoundReversalSummaryV1 = {
    reversed,
    lots,
    unrecoverableExpired,
    alreadyReversed: raw.alreadyReversed === true,
  }
  return unrecoverableExpired > 0
    ? { status: 'cancelled_with_unrecoverable_expired', reversal: summary }
    : { status: 'cancelled', reversal: summary }
}

// ---------------------------------------------------------------------------
// Owner ruling 2026-09-20 — the DURABLE read half of lock:86's 呈现, as a PER-KEY-PATH WHITELIST.
// ---------------------------------------------------------------------------

/**
 * ⛔ THE CONSTRAINT THIS ENCODES, in the owner's own terms (2026-09-20):
 * 「呈现默认值不能替代持久读取能力;修复应白名单投影业务字段,不能直接暴露整个 metadata。」
 *
 * `approval_records.metadata` is a free-form jsonb blob that also carries INTERNAL keys —
 * `w4ActorPosture` (lock:94), `parallelCancelledAssignees`, `cancelRoundBlockDetail` (free text
 * straight from the attendance adapter), `approvalThreshold`, `channel`/`cardDeliveryId`. The
 * read surfaces' explicit SELECT lists are a deliberate confidentiality boundary; projecting the
 * bare column would hand every one of those keys to any participant. So the two functions below
 * are the ONLY way a metadata value reaches a read response, and each REBUILDS its result field
 * by field from a fixed key set rather than passing the stored object through. A key the writer
 * adds tomorrow — or a hostile/corrupt blob — cannot ride out on an object these return.
 *
 * Both are TOTAL and NON-THROWING: they run on a read path, and an unreadable value degrades to
 * `null` (the key is then simply absent from the response) rather than failing the read. They do
 * NOT fabricate: a value they cannot fully validate is dropped, never defaulted.
 *
 * Defensive against the jsonb arriving already-parsed (`pg`'s default type parser, the common
 * case) or as a raw JSON string — the same two shapes `extractRiderAttachmentIds` handles in
 * `routes/approval-history.ts`.
 */
function parseMaybeJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Whitelist-projects `metadata.cancellationOutcome` to exactly
 * `{ status, reversal: { reversed, lots, unrecoverableExpired, alreadyReversed } | null }`.
 *
 * `reversal: null` is EMITTED, not omitted, for `cancelled_reversal_unreported` — the three-token
 * design exists precisely so 「nothing to reverse」 and 「the channel is not wired」 are not
 * byte-identical on the wire (see `CancelRoundCancellationOutcomeV1`'s docblock), and collapsing
 * an explicit `null` into an absent key would destroy that distinction at the last hop.
 */
export function projectCancelRoundCancellationOutcomeForReadV1(
  raw: unknown,
): CancelRoundCancellationOutcomeV1 | null {
  const value = parseMaybeJsonValue(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const status = source.status
  if (status === 'cancelled_reversal_unreported') {
    return { status, reversal: null }
  }
  if (status !== 'cancelled' && status !== 'cancelled_with_unrecoverable_expired') return null
  const reversalValue = source.reversal
  if (typeof reversalValue !== 'object' || reversalValue === null || Array.isArray(reversalValue)) return null
  const reversalSource = reversalValue as Record<string, unknown>
  const reversed = finiteNumberOrNull(reversalSource.reversed)
  const lots = finiteNumberOrNull(reversalSource.lots)
  const unrecoverableExpired = finiteNumberOrNull(reversalSource.unrecoverableExpired)
  const alreadyReversed = reversalSource.alreadyReversed
  if (reversed === null || lots === null || unrecoverableExpired === null) return null
  if (typeof alreadyReversed !== 'boolean') return null
  return {
    status,
    reversal: { reversed, lots, unrecoverableExpired, alreadyReversed },
  }
}

/** The bounded close-reason token C-3's system closure writes (`cancelRoundCloseReason`). */
export const CANCEL_ROUND_CLOSE_REASON_EXPIRED = 'round_expired'
/** Its `blocked` sibling's prefix; the `<code>` after it comes from C-1's `business_refused.code`. */
export const CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX = 'business_blocked:'
/**
 * A sanity ceiling, NOT a charset rule. `AttendanceRequestOperationBusinessRefusalV1.code` is
 * typed `string` and validated only for `typeof === 'string' && length > 0` at the boundary
 * (`w4c3b-request-operation-boundary.ts`'s `takeBusinessRefusal`) — nothing constrains its
 * charset, so a charset regex here would silently DROP a legitimate code and re-open the very
 * read gap this projection closes. Structure (exact token / known prefix) plus a generous length
 * ceiling is what can be checked without inventing a contract the writer does not honour.
 */
export const CANCEL_ROUND_CLOSE_REASON_MAX_LENGTH = 256

/**
 * Whitelist-projects `metadata.cancelRoundCloseReason` — `round_expired` (窗口/策略已关) or
 * `business_blocked:<code>` (业务不可逆). This is what makes those two closures DISTINGUISHABLE on
 * the wire; before it they were byte-identical (`verify-c2-history-dto-cancellation-outcome-
 * 20260920.md` §4.2 — same `action`, same `to_status`, same version fields).
 *
 * `cancelRoundBlockDetail` (the adapter's free-text cause, written BESIDE this token) is
 * deliberately NOT whitelisted: its value is uncontrolled text, and the bounded token already
 * answers the user-facing question 「为什么没成」.
 */
export function projectCancelRoundCloseReasonForReadV1(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length > CANCEL_ROUND_CLOSE_REASON_MAX_LENGTH) return null
  if (raw === CANCEL_ROUND_CLOSE_REASON_EXPIRED) return raw
  if (
    raw.startsWith(CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX)
    && raw.length > CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX.length
  ) {
    return raw
  }
  return null
}

/** Minimal query surface the reader below needs — deliberately not `pg`'s `Pool`, so this core
 *  module keeps taking no database dependency and either service can hand it their own client. */
export type CancelRoundReadProjectionQueryV1 = (
  text: string,
  values: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>

/** What the two detail read surfaces attach to their DTO. Absent keys mean 「this instance has no
 *  such durable value」 — never a fabricated default. */
export interface CancelRoundReadProjectionV1 {
  cancellationOutcome?: CancelRoundCancellationOutcomeV1
  cancelRoundCloseReason?: string
}

/**
 * THE ONE durable-read query, shared by BOTH `getApproval` implementations
 * (`ApprovalBridgeService`'s — the one `GET /api/approvals/:id` actually calls — and
 * `ApprovalProductService`'s, which builds every ACTION response). Two copies of this SQL is
 * exactly how the two surfaces would drift into disagreeing about what a refresh shows, and the FE
 * store publishes an action response into the slot the detail read fills, so a field present on one
 * and absent on the other flips to `undefined` the moment someone acts.
 *
 * ⚠️ NOT a bare `metadata` projection: two key paths are asked of the DB, and each value is then
 * REBUILT field by field by the projectors above. `cancelRoundBlockDetail` (free text) and every
 * internal key (`w4ActorPosture`, `parallelCancelledAssignees`, `nodeEntryEpoch`, …) stay in the
 * column.
 *
 * UNCONDITIONAL, deliberately — no second 「is this a cancel round」 predicate. Such a predicate
 * would not be the writer's, and its failure mode is SILENT ABSENCE, which is the exact defect
 * shape this closes. The predicate is the KEY's presence, answered by the DB over
 * `idx_approval_records_instance`; a non-cancel-round instance simply matches no row.
 *
 * ONE row: a round produces at most one carrier — the approve row on the redeemed path, or the
 * system-closure row on the expired/blocked path — and those are mutually exclusive outcomes of
 * the same round.
 */
export async function readCancelRoundDurableProjectionV1(
  query: CancelRoundReadProjectionQueryV1,
  instanceId: string,
): Promise<CancelRoundReadProjectionV1> {
  const result = await query(
    `SELECT metadata->'cancellationOutcome' AS cancel_round_outcome_raw,
            metadata->>'cancelRoundCloseReason' AS cancel_round_close_reason_raw
       FROM approval_records
      WHERE instance_id = $1
        AND (metadata->'cancellationOutcome' IS NOT NULL
             OR metadata->>'cancelRoundCloseReason' IS NOT NULL)
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
    [instanceId],
  )
  const row = result.rows[0]
  if (!row) return {}
  const projection: CancelRoundReadProjectionV1 = {}
  const cancellationOutcome = projectCancelRoundCancellationOutcomeForReadV1(row.cancel_round_outcome_raw)
  if (cancellationOutcome) projection.cancellationOutcome = cancellationOutcome
  const cancelRoundCloseReason = projectCancelRoundCloseReasonForReadV1(row.cancel_round_close_reason_raw)
  if (cancelRoundCloseReason !== null) projection.cancelRoundCloseReason = cancelRoundCloseReason
  return projection
}

// ---------------------------------------------------------------------------
// Codex 审阅第 3 条修复 (2026-09-19) — the POST-COMMIT `attendance.request.cancelled` delivery.
// ---------------------------------------------------------------------------

/**
 * ⛔ THE DEFECT THIS CLOSES (verified independently, `verify-codex-cancel-finding3-20260919.md`,
 * VERDICT CONFIRMED / P3).
 *
 * Under the `legacy` and `legacy_compat` postures — the ONLY postures any org runs today, since
 * the three attendance switches are OFF and `attendance_calculation_rollout_state` is empty — the
 * boundary deliberately does NOT enqueue the result-event outbox row
 * (`w4c3b-request-operation-boundary.ts:903-916`, `if (!isLegacyCompat)`; the pure-`legacy` kind
 * returns at `:826/:851/:898`, before the enqueue). The HTTP cancel route compensates for that by
 * emitting `attendance.request.cancelled` IN PROCESS, right after the boundary returns
 * (`plugins/plugin-attendance/index.cjs`, `cancelRequest`). The redemption path never passes
 * through `cancelRequest` — by construction, since that function's only two callers are the two
 * HTTP routes — so it emitted the event ZERO times where the HTTP path emits it once. Measured, not
 * reasoned: a bus probe over the twin fixture read `{sendsAfterA: 0, sendsAfterB: 1}` on the same
 * org, same process, same bus singleton.
 *
 * That is a divergence from lock §8 期 1 「完整取消结果逐字节等价于现有 W4 路径」. It is P3 rather
 * than P2 only because the event has ZERO subscribers at this head (§4 of the report: a closed-world
 * census of `eventBus.subscribe` in `src`, of the three `events.subscribe: ["*"]` plugins, of
 * `apps/`, and of the separate `EventBusService` bus the webhook route uses) — a latent gap for the
 * first consumer, not a live regression.
 *
 * ⚠️ WHY A SECOND REGISTRY AND NOT A METHOD ON THE PORT ABOVE. The port's type IS
 * `AttendanceRequestOperationBoundaryV1` — deliberately un-narrowed, because lock §3 C-1 forbids
 * lifting a bespoke cancel-only entry out of the W4 protocol. Adding a delivery method to THAT
 * interface would change the boundary contract every W4 route shares for the sake of one caller.
 * This is a sibling capability, not part of the transaction protocol: it runs AFTER the caller's
 * COMMIT, touches no database, and owns no transaction. It gets its own single-provider registry,
 * bound by the same plugin at the same `activate`.
 *
 * ⚠️ WHY IT CARRIES THE WHOLE W4 RESULT AND DECIDES NOTHING ITSELF. 「不另造第二份事件构造」: the
 * gate (`kind === 'legacy' || kind === 'legacy_compat'`) and the payload shaping live in ONE place,
 * the plugin's `emitRequestCancelledEventForOutcomeV1`, which the HTTP route calls too. The approval
 * side hands over the result it got and the request id it asked about, and learns nothing about
 * which kinds emit — so the two paths cannot drift into two gates.
 *
 * ⚠️ NOT A PERSISTENCE HOOK. Per `feedback_persistent_transition_must_not_depend_on_network_call`:
 * nothing durable hangs off this. The evidence rows (the request row, the revoke audit row, the
 * round's `applied`, the W4 seal) are all written and committed by the transaction BEFORE this runs,
 * and a delivery failure is a warning, never a rollback — a committed business cancellation must not
 * be undone because this delivery hop threw.
 */
export type CancelRoundCancelledEventDeliveryV1 = (
  result: AttendanceRequestOperationExternalTransactionResultV1,
  fallbackRequestId: string,
) => void

let cancelRoundCancelledEventDelivery: CancelRoundCancelledEventDeliveryV1 | undefined

/** Bind the process-wide delivery (the attendance plugin, once, at activate). */
export function registerCancelRoundCancelledEventDelivery(
  deliver: CancelRoundCancelledEventDeliveryV1,
): void {
  if (cancelRoundCancelledEventDelivery) {
    console.warn('CancelRoundCancelledEventDelivery provider is being replaced')
  }
  cancelRoundCancelledEventDelivery = deliver
}

/** Unbind (plugin deactivate / test teardown). */
export function unregisterCancelRoundCancelledEventDelivery(): void {
  cancelRoundCancelledEventDelivery = undefined
}

/**
 * Read the bound delivery. `undefined` ⇒ the approval side logs and moves on. This one FAILS OPEN,
 * the opposite of `getAttendanceCancellationExecutionPort`, and the asymmetry is the point: an
 * unbound EXECUTION port means the business cancellation would not happen at all, so it must abort
 * the transaction; an unbound DELIVERY is discovered only after that cancellation is already
 * committed and durable, where throwing could not undo anything and would merely turn a successful
 * cancellation into a 500.
 */
export function getCancelRoundCancelledEventDelivery(): CancelRoundCancelledEventDeliveryV1 | undefined {
  return cancelRoundCancelledEventDelivery
}
