// #3925 S6 — bulk annual-leave balance adjustment, pure testable orchestration.
//
// The L2c single-user route (`POST /api/attendance/annual-leave-manual-adjustment`) stays
// the sole write path — this slice adds ZERO new backend surface. This module holds ONLY the
// pure pieces the design-lock gates care about — the row cap, the per-row snapshot shape
// (shared {deltaMinutes, reason}, independent per-user idempotencyKey), the sequential
// runner, and the per-row error classification — so they can be unit-tested in isolation
// (inject a fake `submitOne`) without mounting the 29k-line SFC. It performs no network, no
// Vue reactivity, no policy decision: the backend remains the sole authority for every row
// (insufficient balance / non-member / idempotency conflict all resolve server-side).
//
// Design lock: docs/development/attendance-bulk-balance-adjust-s6-design-lock-20260710.md
//
// G1 scope = annual only — comp_time has no single-user manual-adjust primitive to loop
// over (a manual grant there has no honest overtime_source), so it is explicitly OUT.
// G2 selection = user-picker (mirrors scheduleBulkApply's target-selection idiom) — there is
// no "browse all balances" roster read endpoint; adding one to let an operator browse full-org
// balances before picking is a bigger, separate slice (OUT).
// G3 execution = a client-side SEQUENTIAL loop over the existing single-user endpoint. Every
// selected user shares ONE {deltaMinutes, reason} pair but gets an INDEPENDENT
// idempotencyKey — the backend derives `source_key = 'annual_manual_adjust:' + idempotencyKey`
// per adjustment row (see plugins/plugin-attendance/index.cjs
// applyAnnualLeaveManualAdjustment), so a shared key across users would collide as a same-key
// replay for the 2nd..Nth user (409 ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT against the 1st
// user's row, since the replayed key would carry a different userId). Capped at 1..50 — over
// cap is REJECTED, never silently truncated (mirrors scheduleBulkApply.BULK_APPLY_MAX_CELLS /
// batchAnomalyResolution.BATCH_ANOMALY_MAX_ROWS).
// G5 partial failure = any row failing yields `completed_with_errors`, never a false full
// success; retry only re-submits rows that are not yet `ok` (mirrors
// batchAnomalyResolution.runBatchAnomalyResolution / scheduleBulkApply.runBulkApply).
// G6 audit = the existing per-adjustment `attendance_leave_manual_adjustments` registry row
// IS the audit trail (one row per user); this slice deliberately adds no batch_id (G6, OUT).

export const BULK_BALANCE_ADJUST_MAX_USERS = 50

/** 1..50 selected users may be submitted. Over the cap disables submit — the caller must
 *  shrink the selection; the cap is never silently truncated to (design §G3). */
export function canRunBulkBalanceAdjust(selectedCount: number): boolean {
  return selectedCount >= 1 && selectedCount <= BULK_BALANCE_ADJUST_MAX_USERS
}

export interface BulkBalanceAdjustRowSnapshot {
  userId: string
  deltaMinutes: number
  reason: string
  idempotencyKey: string
}

/**
 * Build the per-user snapshot rows for a bulk adjustment (design §G3 — "共享 {deltaMinutes,
 * reason}；每人独立 idempotencyKey"). `userIds` are de-duplicated (order-preserving
 * first-seen, blank/whitespace-only entries dropped); every row shares the same
 * `deltaMinutes`/`reason`, but each gets its OWN idempotency key from the injected
 * `makeIdempotencyKey` generator — called once per row, never reused across rows, so a
 * retried/replayed key can never collide two different users' adjustments together.
 */
export function buildBulkBalanceAdjustRows(
  userIds: string[],
  shared: { deltaMinutes: number; reason: string },
  makeIdempotencyKey: () => string,
): BulkBalanceAdjustRowSnapshot[] {
  const uniqueUserIds = [...new Set(userIds.map(id => id.trim()).filter(Boolean))]
  return uniqueUserIds.map(userId => ({
    userId,
    deltaMinutes: shared.deltaMinutes,
    reason: shared.reason,
    idempotencyKey: makeIdempotencyKey(),
  }))
}

export type BulkBalanceAdjustRowState = 'submitting' | 'ok' | 'error'

export interface BulkBalanceAdjustRowResult {
  userId: string
  state: BulkBalanceAdjustRowState
  adjustmentId?: string
  applied?: boolean
  alreadyApplied?: boolean
  errorCode?: string
  errorKind?: BulkBalanceAdjustErrorKind
}

export type BulkBalanceAdjustOutcome = 'idle' | 'running' | 'completed' | 'completed_with_errors'

/**
 * Aggregate per-row results into the batch outcome. A batch is only `completed` when EVERY
 * row is ok; a single failure yields `completed_with_errors` (design §G5 — never claim full
 * success on any failure).
 */
export function summarizeBulkBalanceAdjustOutcome(results: BulkBalanceAdjustRowResult[]): BulkBalanceAdjustOutcome {
  if (results.length === 0) return 'idle'
  if (results.some(r => r.state === 'submitting')) return 'running'
  if (results.some(r => r.state === 'error')) return 'completed_with_errors'
  return 'completed'
}

/**
 * Coarse per-row error classification (design §G3 — "每行守卫映射 per-row 结果非全局中止
 * （404/422/409 → 行级错误）"), reusing the EXISTING route responder codes from
 * applyAnnualLeaveManualAdjustment (index.cjs): 404 USER_NOT_IN_ORG (target not an active org
 * member), 422 ANNUAL_LEAVE_BALANCE_INSUFFICIENT (FIFO-deduct insufficient — the whole
 * per-user txn including its registry row rolls back), 409
 * ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT (the per-user idempotencyKey already names a
 * different adjustment). This module adds no new backend codes; it only buckets known ones
 * for a per-row coarse label. Enum-strict: any unrecognized (or missing) code — 400s, 403s,
 * 500s, future codes this slice doesn't know about — falls back to 'generic', never a silent
 * default success.
 */
export type BulkBalanceAdjustErrorKind = 'not_member' | 'insufficient' | 'idempotency_conflict' | 'generic'

const BULK_BALANCE_ADJUST_ERROR_CODE_MAP: Record<string, BulkBalanceAdjustErrorKind> = {
  USER_NOT_IN_ORG: 'not_member',
  ANNUAL_LEAVE_BALANCE_INSUFFICIENT: 'insufficient',
  ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
}

export function classifyBulkBalanceAdjustErrorCode(code: string | undefined | null): BulkBalanceAdjustErrorKind {
  if (!code) return 'generic'
  return BULK_BALANCE_ADJUST_ERROR_CODE_MAP[code] ?? 'generic'
}

export type Translate = (en: string, zh: string) => string

/** Coarse, bilingual per-row error text for the classified error kind (design §G3). */
export function bulkBalanceAdjustErrorText(kind: BulkBalanceAdjustErrorKind, tr: Translate): string {
  switch (kind) {
    case 'not_member':
      return tr('Not an active member of this org.', '不是本组织的有效成员。')
    case 'insufficient':
      return tr('Insufficient balance for this deduction.', '余额不足，无法完成该扣减。')
    case 'idempotency_conflict':
      return tr('Idempotency key conflict for this user.', '该用户的幂等键冲突。')
    default:
      return tr('Failed to adjust this user.', '该用户调整失败。')
  }
}

export type BulkBalanceAdjustSubmitOutcome =
  | { ok: true; result: { adjustmentId?: string; applied?: boolean; alreadyApplied?: boolean } }
  | { ok: false; errorCode?: string }

/**
 * Submit each row sequentially through the injected `submitOne` (design §G3 — sequential,
 * not concurrent, matching scheduleBulkApply/batchAnomalyResolution; avoids concurrent writes
 * to the same org's leave-balance lots racing each other). Rows already marked `ok` in
 * `current` are NOT re-submitted — a retry only re-runs non-succeeded rows (design §G5 —
 * "retry 只重跑非 ok 行"). A row failure does not stop the others; the final map carries every
 * row's outcome, including any pre-existing entries from `current` that this run's `rows`
 * never touch. `onProgress` fires after each state transition so the UI can render per-row
 * results live. Returns the accumulated result map (a fresh Map instance — `current` is never
 * mutated).
 */
export async function runBulkBalanceAdjust(
  rows: BulkBalanceAdjustRowSnapshot[],
  current: Map<string, BulkBalanceAdjustRowResult>,
  submitOne: (row: BulkBalanceAdjustRowSnapshot) => Promise<BulkBalanceAdjustSubmitOutcome>,
  onProgress?: (userId: string, result: BulkBalanceAdjustRowResult) => void,
): Promise<Map<string, BulkBalanceAdjustRowResult>> {
  const results = new Map(current)
  for (const row of rows) {
    const existing = results.get(row.userId)
    if (existing && existing.state === 'ok') continue
    const submitting: BulkBalanceAdjustRowResult = { userId: row.userId, state: 'submitting' }
    results.set(row.userId, submitting)
    onProgress?.(row.userId, submitting)
    const outcome = await submitOne(row)
    const next: BulkBalanceAdjustRowResult = outcome.ok
      ? { userId: row.userId, state: 'ok', ...outcome.result }
      : {
          userId: row.userId,
          state: 'error',
          errorCode: outcome.errorCode,
          errorKind: classifyBulkBalanceAdjustErrorCode(outcome.errorCode),
        }
    results.set(row.userId, next)
    onProgress?.(row.userId, next)
  }
  return results
}
