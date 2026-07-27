/**
 * W4C-0 (#4556) Stage C — one exported operation contract: bounded-atomicity
 * constants, closed operation-layer error codes, and their values-free HTTP mapping.
 *
 * Authority: lock section 7.1 ("These are one exported contract, not
 * environment-tunable hidden behavior"), section 7.1/8.2 busy-error mapping
 * paragraphs, and section 12.1 gates. Changing any constant requires a contract
 * amendment; nothing here reads process.env.
 *
 * This module deliberately imports nothing from the identity layer so the
 * identity/lock helpers can import the constants without a cycle.
 */

// ---------------------------------------------------------------------------
// Bounded whole-batch atomicity constants (lock section 7.1 — exact literals).
// ---------------------------------------------------------------------------

export const W4_MAX_BATCH_ITEMS = 5000
export const W4_MAX_DISTINCT_TARGETS = 5000
export const W4_TRANSACTION_STATEMENT_TIMEOUT_MS = 180000
export const W4_TRANSACTION_LOCK_TIMEOUT_MS = 5000
export const W4_ADVISORY_HELPER_WAIT_MS = W4_TRANSACTION_LOCK_TIMEOUT_MS
export const W4_TRANSACTION_MAX_RETRIES = 2

// ---------------------------------------------------------------------------
// Closed operation-layer outcome/error codes (lock sections 6.2, 7.1, 8.2).
// These are no-source-write request/transition outcomes — NEVER calculation
// reasons (section 6.2 last paragraph).
// ---------------------------------------------------------------------------

export const ATTENDANCE_W4_OPERATION_ERROR_CODES_V1 = Object.freeze([
  'ATTENDANCE_OPERATION_CONFLICT', // same key, different payload/actor/source/subject (409)
  'ATTENDANCE_OPERATION_BATCH_CONFLICT', // mixed/missing/reordered/rehung batch state (409)
  'ATTENDANCE_OPERATION_IN_PROGRESS', // operation-helper budget/55P03 busy (409)
  'ATTENDANCE_CALCULATION_ROLLOUT_BUSY', // rollout-helper budget/55P03 busy (503)
  'ATTENDANCE_CALCULATION_TARGET_BUSY', // target-helper budget/55P03 busy (503)
  'SEGMENT_CALCULATION_SUSPENDED', // suspended synchronous outcome (503)
  'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT', // P07/P08 frozen-posture mismatch (409)
  'W4_BATCH_LIMIT_EXCEEDED', // above item/target maxima, before source DML (422)
  'ATTENDANCE_WRITE_NOT_AUTHORIZED', // authorization witness/capability failure (403)
  'W4_ATTRIBUTION_UNSUPPORTED', // fresh unsupported attribution (422)
  'ATTENDANCE_SCHEDULED_RUN_BUSY', // scheduled-run (class-01) helper budget/55P03 busy (503) — W4C-2 §1.6
] as const)
export type AttendanceW4OperationErrorCodeV1 = (typeof ATTENDANCE_W4_OPERATION_ERROR_CODES_V1)[number]

/** Values-free HTTP status for each closed code (lock sections 7.1/8.2). */
export const ATTENDANCE_W4_OPERATION_ERROR_HTTP_STATUS_V1: Readonly<
  Record<AttendanceW4OperationErrorCodeV1, number>
> = Object.freeze({
  ATTENDANCE_OPERATION_CONFLICT: 409,
  ATTENDANCE_OPERATION_BATCH_CONFLICT: 409,
  ATTENDANCE_OPERATION_IN_PROGRESS: 409,
  ATTENDANCE_CALCULATION_ROLLOUT_BUSY: 503,
  ATTENDANCE_CALCULATION_TARGET_BUSY: 503,
  SEGMENT_CALCULATION_SUSPENDED: 503,
  ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT: 409,
  W4_BATCH_LIMIT_EXCEEDED: 422,
  ATTENDANCE_WRITE_NOT_AUTHORIZED: 403,
  W4_ATTRIBUTION_UNSUPPORTED: 422,
  ATTENDANCE_SCHEDULED_RUN_BUSY: 503,
})

/**
 * Values-free typed operation-layer error: message IS the closed code; the raw
 * SQLSTATE/driver message is never carried outward. `lockClass` is present only
 * on advisory-helper busy errors so the section 12.1 legs can assert the exact
 * origin without relabeling another query's 55P03.
 */
export class AttendanceW4OperationError extends Error {
  readonly code: AttendanceW4OperationErrorCodeV1
  readonly httpStatus: number
  readonly lockClass: 'rollout' | 'operation' | 'target' | 'scheduled_run' | null

  constructor(
    code: AttendanceW4OperationErrorCodeV1,
    lockClass: 'rollout' | 'operation' | 'target' | 'scheduled_run' | null = null,
  ) {
    super(code)
    this.name = 'AttendanceW4OperationError'
    this.code = code
    this.httpStatus = ATTENDANCE_W4_OPERATION_ERROR_HTTP_STATUS_V1[code]
    this.lockClass = lockClass
  }
}

export function failW4Operation(code: AttendanceW4OperationErrorCodeV1): never {
  throw new AttendanceW4OperationError(code)
}

// ---------------------------------------------------------------------------
// Section 7.1a closed outbox event-kind allowlist.
//
// W4C-2 amendment section 1.5 (docs/development/attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md,
// PR #4617, RATIFIED, owner Bundle A): this list gained the two run-level kinds below.
// Its parity partner is NO LONGER the already-applied W4C-0 migration's own
// `OUTBOX_EVENT_KINDS` constant (`zzzz20260725120000_...:210-217`) — that constant is a
// historical artifact, consumed once at that migration's own `up()`, and is permanently
// excluded from parity now that this list has grown past it. The current parity partner
// is `W4C2_OUTBOX_EVENT_KINDS_V1`, the eight-member LOCAL literal exported by
// `zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts` (section 1.10
// step 6). Gate 9's parity assertion must compare against THAT object, not the W4C-0
// migration's. Reconcile both copies (and W4C-0's generated reachable-event inventory) in
// the same commit as any future change here.
// ---------------------------------------------------------------------------

export const ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1 = Object.freeze([
  'attendance.punched',
  'attendance.requested',
  'attendance.request.updated',
  'attendance.request.cancelled',
  'attendance.resolved',
  'attendance.outdoorPunch.requested',
  'attendance.absence.generated',
  'attendance.work_date.review_required',
] as const)
export type AttendanceW4OutboxEventKindV1 = (typeof ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1)[number]

/**
 * Section 1.5/1.4.1: the two run-level kinds this amendment adds — the exact subset
 * `enqueueAttendanceScheduledRunEventOutboxV1` (w4c2-scheduled-run.ts) accepts and
 * `enqueueAttendanceResultEventOutboxV1` (w4c0-operation-registry.ts) rejects, even
 * though both are members of the eight-member closed set above.
 */
export const ATTENDANCE_W4_SCHEDULED_RUN_OUTBOX_EVENT_KINDS_V1 = Object.freeze([
  'attendance.absence.generated',
  'attendance.work_date.review_required',
] as const)
export type AttendanceW4ScheduledRunOutboxEventKindV1 = (typeof ATTENDANCE_W4_SCHEDULED_RUN_OUTBOX_EVENT_KINDS_V1)[number]
