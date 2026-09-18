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

import type { AttendanceRequestOperationBoundaryV1 } from '../attendance/w4c3b-request-operation-boundary'

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
