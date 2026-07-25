/**
 * W4C-2 (#4556) — shadow-comparison EXPECTED-DIFFERENCE roster (lock 10.1 /
 * 12.3; #4607 gate-handover P0 obligation).
 *
 * The W4 calculator is allowed to disagree with the legacy projection in a
 * small, CLOSED set of already-adjudicated ways. Each entry below names one
 * such known difference so the W4C-4 shadow ledger/soak comparator can mark it
 * `expected` instead of raising a regression. Anything not on this roster is a
 * real diff and must surface through the ordinary lock-10.1 codes.
 *
 * Entry 1 — `correction_applied_daily_adjusted` (W4C-1 ratified discretion #6):
 *   the W4 calculator reports daily status `adjusted` whenever an approved
 *   correction was APPLIED to a day that has no remaining anomaly, even when
 *   leave/overtime minutes are both zero. Legacy `computeMetrics`
 *   (`plugins/plugin-attendance/index.cjs` ~L11369) grants `adjusted` only when
 *   `leaveMinutes > 0 || overtimeMinutes > 0`, so the SAME day projects
 *   `normal` on the legacy side. legacy=`normal` + w4=`adjusted` +
 *   correction-applied + no anomaly is therefore an EXPECTED `status_changed`
 *   difference, not a regression.
 *
 * Values-free: the roster and predicate operate on closed enum values and
 * booleans only — no user, punch, request, or org value enters this module.
 */

export class AttendanceW4ShadowExpectedDifferenceError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4ShadowExpectedDifferenceError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4ShadowExpectedDifferenceError(code)
}

/** Closed lock-10.1 shadow-diff code set (mirrors the W4C-0 migration literal). */
export const ATTENDANCE_W4_SHADOW_DIFF_CODES_V1 = Object.freeze([
  'equal',
  'expected_break_exclusion',
  'status_changed',
  'work_minutes_mismatch',
  'late_minutes_mismatch',
  'early_leave_minutes_mismatch',
  'missing_boundary_mismatch',
  'work_date_mismatch',
  'context_mismatch',
  'input_mismatch',
  'review_required',
  'legacy_uncomparable',
] as const)
export type AttendanceW4ShadowDiffCodeV1 = (typeof ATTENDANCE_W4_SHADOW_DIFF_CODES_V1)[number]

const DAILY_STATUSES = Object.freeze([
  'normal',
  'late',
  'early_leave',
  'late_early',
  'absent',
  'partial',
  'adjusted',
  'off',
] as const)
type DailyStatus = (typeof DAILY_STATUSES)[number]

export interface AttendanceW4ExpectedShadowDifferenceEntryV1 {
  readonly id: string
  /** The lock-10.1 code this expected difference presents as. */
  readonly shadowDiffCode: AttendanceW4ShadowDiffCodeV1
  /** Ratifying source for the difference (design-lock discretion record). */
  readonly ratifiedBy: string
}

export const ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1: readonly AttendanceW4ExpectedShadowDifferenceEntryV1[] =
  Object.freeze([
    Object.freeze({
      id: 'correction_applied_daily_adjusted',
      shadowDiffCode: 'status_changed' as const,
      ratifiedBy: '#4556 W4C-1 ratified discretion #6 (correction-applied no-anomaly day => adjusted)',
    }),
  ])

export interface AttendanceW4ShadowStatusDifferenceProbeV1 {
  readonly shadowDiffCode: AttendanceW4ShadowDiffCodeV1
  readonly legacyStatus: DailyStatus
  readonly w4Status: DailyStatus
  /** True when any W4 segment carries reason `approved_correction_applied`. */
  readonly w4CorrectionApplied: boolean
  /** True when the W4 day still has any late/early/missing anomaly. */
  readonly w4AnomalyPresent: boolean
  /** Daily leave minutes the LEGACY projection accounted (drives its adjusted rule). */
  readonly legacyLeaveMinutes: number
  /** Daily overtime minutes the LEGACY projection accounted. */
  readonly legacyOvertimeMinutes: number
}

const PROBE_KEYS = Object.freeze([
  'shadowDiffCode',
  'legacyStatus',
  'w4Status',
  'w4CorrectionApplied',
  'w4AnomalyPresent',
  'legacyLeaveMinutes',
  'legacyOvertimeMinutes',
] as const)

function parseProbe(input: unknown): AttendanceW4ShadowStatusDifferenceProbeV1 {
  const code = 'W4C2_SHADOW_DIFF_PROBE_INVALID'
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const obj = input as Record<string, unknown>
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== PROBE_KEYS.length) fail(code)
  for (const key of PROBE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(code)
  }
  if (!(ATTENDANCE_W4_SHADOW_DIFF_CODES_V1 as readonly string[]).includes(obj.shadowDiffCode as string)) fail(code)
  if (!(DAILY_STATUSES as readonly string[]).includes(obj.legacyStatus as string)) fail(code)
  if (!(DAILY_STATUSES as readonly string[]).includes(obj.w4Status as string)) fail(code)
  if (typeof obj.w4CorrectionApplied !== 'boolean') fail(code)
  if (typeof obj.w4AnomalyPresent !== 'boolean') fail(code)
  if (typeof obj.legacyLeaveMinutes !== 'number' || !Number.isInteger(obj.legacyLeaveMinutes) || obj.legacyLeaveMinutes < 0) fail(code)
  if (typeof obj.legacyOvertimeMinutes !== 'number' || !Number.isInteger(obj.legacyOvertimeMinutes) || obj.legacyOvertimeMinutes < 0) fail(code)
  return obj as unknown as AttendanceW4ShadowStatusDifferenceProbeV1
}

/**
 * True exactly when a status difference matches roster entry
 * `correction_applied_daily_adjusted`: legacy `normal` (its adjusted rule not
 * triggered — zero leave AND zero overtime minutes), W4 `adjusted` through the
 * correction-applied/no-anomaly branch. Everything else is NOT expected.
 * Fail-closed: malformed probes throw rather than returning false-negative
 * "unexpected" or false-positive "expected".
 */
export function isExpectedAttendanceShadowDifferenceV1(input: unknown): boolean {
  const probe = parseProbe(input)
  return (
    probe.shadowDiffCode === 'status_changed' &&
    probe.legacyStatus === 'normal' &&
    probe.w4Status === 'adjusted' &&
    probe.w4CorrectionApplied === true &&
    probe.w4AnomalyPresent === false &&
    probe.legacyLeaveMinutes === 0 &&
    probe.legacyOvertimeMinutes === 0
  )
}
