// #3616 bulk-apply schedule assignment — pure, testable orchestration.
//
// D1-A (checkbox-list) + D2-A (draft-then-publish): the operator multi-selects users and
// a date range, this module expands that into (user, date) cells, and every cell is written
// through the EXISTING `POST /api/attendance/schedule-drafts/assignments` route — draft
// state only (`publish_status = 'draft'` is hardcoded server-side; publishing a draft into
// effect still goes through the existing, untouched publish flow). This module holds ONLY
// the pure pieces the design-lock gates care about — cell expansion, the cell-count cap, the
// sequential runner, the per-cell request-body shape, and per-cell error classification — so
// they can be unit-tested in isolation (inject a fake `submitOne`) without mounting the
// 29k-line SFC. It performs no network, no Vue reactivity, no policy decision: every guard
// that already runs inside the reused route (edit-window / scheduler-scope / conflict /
// compliance-cap) still runs there — this module never bypasses them, it only classifies
// their existing responder codes for a coarse per-cell label.
//
// Design lock: docs/development/attendance-schedule-bulk-apply-design-lock-20260705.md

export const BULK_APPLY_MAX_CELLS = 50

export interface BulkApplyCell {
  userId: string
  /** YYYY-MM-DD work date — one cell is always a single-day assignment. */
  date: string
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Stable map key for a cell — used to track per-cell results across retries. */
export function bulkApplyCellKey(cell: { userId: string; date: string }): string {
  return `${cell.userId}::${cell.date}`
}

function addOneDay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const yyyy = next.getUTCFullYear()
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(next.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Expand a user multi-select x inclusive date range into the (user, date) cell candidate set
 * (design-lock D1-A: "user 多选 x 日期范围 -> 展开成 (user,date) 单元集"). `userIds` are
 * de-duplicated (order-preserving first-seen); the produced cells are sorted by date then
 * userId for a stable, predictable checkbox-list render. An empty user list, a missing date,
 * or an inverted range (endDate < startDate) all yield an empty cell list rather than
 * throwing — the caller surfaces that as a validation hint, not a crash. A malformed
 * (non-YYYY-MM-DD) date also yields an empty list for the same reason.
 */
export function expandTargets(userIds: string[], startDate: string, endDate: string): BulkApplyCell[] {
  const uniqueUserIds = [...new Set(userIds.map(id => id.trim()).filter(Boolean))]
  if (uniqueUserIds.length === 0) return []
  if (!DATE_ONLY_PATTERN.test(startDate) || !DATE_ONLY_PATTERN.test(endDate)) return []
  if (endDate < startDate) return []

  const dates: string[] = []
  let cursor = startDate
  // Defensive bound — callers are expected to gate on canRunBulkApply before this ever runs
  // against a huge range, but a corrupt/huge range must not hang the tab.
  const GUARD_LIMIT = 3660 // ~10 years of days
  let guard = 0
  while (cursor <= endDate && guard < GUARD_LIMIT) {
    dates.push(cursor)
    cursor = addOneDay(cursor)
    guard += 1
  }

  const cells: BulkApplyCell[] = []
  for (const date of dates) {
    for (const userId of uniqueUserIds) {
      cells.push({ userId, date })
    }
  }
  return cells.sort((a, b) => (a.date === b.date ? a.userId.localeCompare(b.userId) : a.date.localeCompare(b.date)))
}

/** 1..50 selected cells may be submitted. Over the cap disables submit (design §3/§4 — the
 * caller must shrink the selection; the cap is never silently truncated to). */
export function canRunBulkApply(selectedCount: number): boolean {
  return selectedCount >= 1 && selectedCount <= BULK_APPLY_MAX_CELLS
}

export interface BulkApplyAssignmentPayload {
  userId: string
  shiftId: string
  startDate: string
  endDate: string
  isActive: true
  orgId?: string
  idempotencyKey: string
}

/**
 * Build the exact `schedule-drafts/assignments` POST body for one cell (design §3/§5 — "N 次
 * schedule-drafts POST 的精确 body"). A cell is always a single-day assignment: startDate ===
 * endDate === the cell's date. `orgId` is passed through as-is (undefined is dropped by
 * JSON.stringify, matching the existing single-row save path's shape). `idempotencyKey` is
 * included per design-lock G2, but it is INERT today (review P3, stated honestly): the current
 * `schedule-drafts/assignments` zod schema does not declare it, so the server strips it (no
 * read, no persist, no write-dedup). It is also NOT the client-side retry key — the confirm
 * modal tracks per-cell success by (userId, date) and re-submits only not-yet-ok cells — and it
 * is regenerated per attempt, so it is not even retry-stable. What actually prevents a duplicate
 * draft on retry is the double defense the server already has: this frontend's skip-ok loop plus
 * the route's own `findAttendanceScheduleAssignmentConflict` (a re-submit of an already-created
 * (user,date) draft → 409). Real server-side idempotent write-dedup (a stable key + a bulk/
 * idempotent endpoint) is a separate deferred backend slice (design-lock §6); until then this
 * field is sent only for literal G2 compliance and forward-shape, not for any behavior today.
 */
export function buildBulkApplyAssignmentPayload(
  cell: BulkApplyCell,
  params: { shiftId: string; orgId?: string; idempotencyKey: string },
): BulkApplyAssignmentPayload {
  return {
    userId: cell.userId,
    shiftId: params.shiftId,
    startDate: cell.date,
    endDate: cell.date,
    isActive: true,
    orgId: params.orgId,
    idempotencyKey: params.idempotencyKey,
  }
}

export type BulkApplyCellState = 'submitting' | 'ok' | 'error'

/**
 * Coarse per-cell error classification (design §G3) — reuses the EXISTING route responder
 * codes (index.cjs: respondAttendanceScheduleAssignmentConflict = 409
 * ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT; respondShiftComplianceCapExceeded = 422
 * SHIFT_COMPLIANCE_CAP_EXCEEDED; respondShiftEditWindowExceeded = 422
 * SHIFT_EDIT_WINDOW_EXCEEDED; respondAttendanceSchedulerScopeForbidden = 403
 * SCHEDULER_SCOPE_FORBIDDEN). This module adds no new backend codes; it only buckets known
 * ones for a per-cell coarse label. Enum-strict: any unrecognized (or missing) code — 400s,
 * 404s, 500s, future codes this slice doesn't know about — falls back to 'generic', never a
 * silent default success.
 */
export type BulkApplyErrorKind =
  | 'conflict'
  | 'compliance_cap'
  | 'edit_window'
  | 'scope_forbidden'
  | 'generic'

const BULK_APPLY_ERROR_CODE_MAP: Record<string, BulkApplyErrorKind> = {
  ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT: 'conflict',
  SHIFT_COMPLIANCE_CAP_EXCEEDED: 'compliance_cap',
  SHIFT_EDIT_WINDOW_EXCEEDED: 'edit_window',
  SCHEDULER_SCOPE_FORBIDDEN: 'scope_forbidden',
}

export function classifyBulkApplyErrorCode(code: string | undefined | null): BulkApplyErrorKind {
  if (!code) return 'generic'
  return BULK_APPLY_ERROR_CODE_MAP[code] ?? 'generic'
}

export type Translate = (en: string, zh: string) => string

/** Coarse, bilingual per-cell error text for the classified error kind (design §G3). */
export function bulkApplyCellErrorText(kind: BulkApplyErrorKind, tr: Translate): string {
  switch (kind) {
    case 'conflict':
      return tr('Schedule conflict for this user and date.', '该用户在该日期存在排班冲突。')
    case 'compliance_cap':
      return tr('Exceeds the configured compliance hour cap.', '超出配置的合规工时上限。')
    case 'edit_window':
      return tr('Outside the editable schedule window.', '超出可编辑排班窗口。')
    case 'scope_forbidden':
      return tr('Outside your scheduler scope.', '超出你的排班管理范围。')
    default:
      return tr('Failed to apply this cell.', '该格套用失败。')
  }
}

export interface BulkApplyCellResult {
  userId: string
  date: string
  state: BulkApplyCellState
  assignmentId?: string
  errorCode?: string
  errorKind?: BulkApplyErrorKind
}

export type BulkApplyOutcome = 'idle' | 'running' | 'completed' | 'completed_with_errors'

/**
 * Aggregate per-cell results into the batch outcome. A batch is only `completed` when EVERY
 * cell is ok; a single failure yields `completed_with_errors` (design §G2 — never claim full
 * success on any failure).
 */
export function summarizeBulkApplyOutcome(results: BulkApplyCellResult[]): BulkApplyOutcome {
  if (results.length === 0) return 'idle'
  if (results.some(r => r.state === 'submitting')) return 'running'
  if (results.some(r => r.state === 'error')) return 'completed_with_errors'
  return 'completed'
}

export type BulkApplySubmitOutcome =
  | { ok: true; result?: { assignmentId?: string } }
  | { ok: false; errorCode?: string }

/**
 * Submit each cell sequentially through the injected `submitOne` (design §G2 — sequential,
 * not concurrent, matching batch anomaly resolution; avoids same-user advisory-lock
 * contention / false conflict reads across cells for the same user). Cells already marked
 * `ok` in `current` are NOT re-submitted — a retry from the same modal only re-runs
 * non-succeeded cells (design §G3 — "重试失败项，skip 已 ok 格"). A cell failure does not stop
 * the others; the final map carries every cell's outcome, including any pre-existing entries
 * from `current` that this run's `cells` never touch. `onProgress` fires after each state
 * transition so the UI can render per-cell results live. Returns the accumulated result map
 * (a fresh Map instance — `current` is never mutated).
 */
export async function runBulkApply(
  cells: BulkApplyCell[],
  current: Map<string, BulkApplyCellResult>,
  submitOne: (cell: BulkApplyCell) => Promise<BulkApplySubmitOutcome>,
  onProgress?: (key: string, result: BulkApplyCellResult) => void,
): Promise<Map<string, BulkApplyCellResult>> {
  const results = new Map(current)
  for (const cell of cells) {
    const key = bulkApplyCellKey(cell)
    const existing = results.get(key)
    if (existing && existing.state === 'ok') continue
    const submitting: BulkApplyCellResult = { userId: cell.userId, date: cell.date, state: 'submitting' }
    results.set(key, submitting)
    onProgress?.(key, submitting)
    const outcome = await submitOne(cell)
    const next: BulkApplyCellResult = outcome.ok
      ? { userId: cell.userId, date: cell.date, state: 'ok', ...outcome.result }
      : {
          userId: cell.userId,
          date: cell.date,
          state: 'error',
          errorCode: outcome.errorCode,
          errorKind: classifyBulkApplyErrorCode(outcome.errorCode),
        }
    results.set(key, next)
    onProgress?.(key, next)
  }
  return results
}
