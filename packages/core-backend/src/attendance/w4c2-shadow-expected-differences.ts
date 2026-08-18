/**
 * W4C-2 (#4556) — shadow-comparison EXPECTED-DIFFERENCE roster (lock 10.1 /
 * 12.3; #4607 gate-handover P0 obligation; entries 2-3 per owner ruling
 * issue-4556.comment-5317181927, mechanism per issue-4556.comment-5322708492).
 *
 * The W4 calculator is allowed to disagree with the legacy projection in a
 * small, CLOSED set of already-adjudicated ways. Each entry below names one
 * such known difference so reconciliation can mark it `expected` instead of
 * raising a regression. Anything not on this roster is a real diff and must
 * surface through the ordinary lock-10.1 codes.
 *
 * TWO EVALUATORS — because the two ratified shapes are observable at
 * different times:
 *
 *  - `write_probe_v1` (entry 1): decidable at WRITE time from the boundary's
 *    own probe. Its presented code is derived from the entry (exported as
 *    `ATTENDANCE_W4C2_WRITE_PROBE_PRESENTED_CODE_V1`) and consumed by
 *    `isExpectedAttendanceShadowDifferenceV1` — the boundary's relabel branch.
 *
 *  - `read_convergence_v1` (entries 2-3): decidable ONLY at READ time. The
 *    ratified shape is the two-row lifecycle pinned by
 *    `attendance-soak-diff-families.db.test.ts` (v1 = the minute mismatch on a
 *    one-boundary day, v2 = `equal` once the pair completes) — and the
 *    convergence half cannot be observed by the write boundary, because the
 *    converging row does not exist yet. These entries are evaluated by
 *    `isExpectedAttendanceW4C2ReadSideDifferenceV1` over columns the deployed
 *    image already persists; they are NEVER consulted by the write path, and
 *    the module-load assert below makes that structural: no read-evaluated
 *    entry may carry the write path's presented code.
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
 * Entries 2-3 — `transient_partial_day_in_only_late` /
 * `transient_partial_day_out_only_early_leave` (owner ruling
 * issue-4556.comment-5317181927, executed per the lifecycle pinned by
 * `attendance-soak-diff-families.db.test.ts`): on a SINGLE-SEGMENT day holding
 * exactly ONE boundary punch, legacy `computeMetrics` returns status `partial`
 * with ZEROED anomaly minutes (`plugins/plugin-attendance/index.cjs` ~L11961),
 * while the W4 calculator reports the real late (in-only) or early-leave
 * (out-only) minutes immediately; both projections carry status `partial`, so
 * the ONLY changed field is the minute witness. The moment the completing
 * punch lands, both machines agree and the next calculation row is `equal`.
 * The read predicate requires ALL of: the exact categorical core (code,
 * canonical changedFields, projected status `partial`, exactly the matching
 * one-boundary presence pattern), numeric congruence (`absoluteMinuteDelta`
 * equals the witness minute field, which is > 0, while the other minute field
 * is 0), and OBSERVED convergence (`convergedToEqual`). A genuine minute
 * miscalculation on a completed day fails the boundary-presence conjunct; an
 * un-converged open day fails the convergence conjunct (EXPECTED-BUT-OPEN at a
 * window edge, per the W8 pack's open-day rule — not roster-expected).
 * DELIBERATELY OUT OF SCOPE: multi-segment days (both daily boundary columns
 * populated while a later segment is open — fail-closed off-roster), and the
 * excused-by-leave variant (surfaces as `status_changed`, entry 1's domain,
 * still off-roster: its own adjudication is OPEN).
 *
 * Values-free: the roster and predicates operate on closed enum values,
 * booleans, and minute integers only — no user, punch, request, or org value
 * enters this module.
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

/**
 * W7-2 (#4556, design-lock §4.2): the CRITICAL shadow-diff classes — exactly
 * the "work-date/context/input/review classes" §4.2's `group_eligible` entry
 * criterion names ("zero critical diffs").
 *
 * This is the ONE set. It was previously a module-private duplicate inside
 * `AttendanceW4CalculationDetail.ts` (`CRITICAL_SHADOW_DIFF_CODES`); that
 * consumer now derives its set from THIS export, so the criticality
 * classification cannot fork between the W4 backlog reader and the W7
 * compare-window counters. Every member must be a member of
 * `ATTENDANCE_W4_SHADOW_DIFF_CODES_V1` (asserted by test, and by the
 * `AttendanceW4ShadowDiffCodeV1` element type at compile time).
 */
export const ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1: readonly AttendanceW4ShadowDiffCodeV1[] =
  Object.freeze([
    'work_date_mismatch',
    'context_mismatch',
    'input_mismatch',
    'review_required',
  ] as const)

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

/** Canonical order mirrors `SHADOW_DIFF_CHANGED_FIELDS` in AttendanceW4CalculationDetail. */
const CHANGED_FIELDS_DOMAIN = Object.freeze([
  'workDate',
  'status',
  'firstInAt',
  'lastOutAt',
  'workMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
  'context',
  'input',
] as const)
type ChangedField = (typeof CHANGED_FIELDS_DOMAIN)[number]

/** The categorical READ-side core a `read_convergence_v1` entry matches on. */
export interface AttendanceW4C2ReadProbeCoreV1 {
  readonly changedFields: readonly ChangedField[]
  readonly projectedStatus: DailyStatus
  readonly projectedFirstInPresent: boolean
  readonly projectedLastOutPresent: boolean
}

export interface AttendanceW4ExpectedShadowDifferenceEntryV1 {
  readonly id: string
  /** The lock-10.1 code this expected difference presents as. */
  readonly shadowDiffCode: AttendanceW4ShadowDiffCodeV1
  /** Ratifying source for the difference (design-lock discretion record). */
  readonly ratifiedBy: string
  /** Which evaluator decides this entry — see the module header. */
  readonly evaluator: 'write_probe_v1' | 'read_convergence_v1'
  /** REQUIRED iff evaluator === 'read_convergence_v1'; forbidden otherwise. */
  readonly readProbeCore?: AttendanceW4C2ReadProbeCoreV1
  /** REQUIRED iff evaluator === 'read_convergence_v1'; forbidden otherwise. */
  readonly minuteWitness?: 'late' | 'early_leave'
}

const ENTRY_2_3_RATIFIED_BY =
  '#4556 owner ruling issue-4556.comment-5317181927 (transient partial-day late/early => roster entry 2; '
  + 'read-side evaluator per issue-4556.comment-5322708492; lifecycle pinned by attendance-soak-diff-families.db.test.ts)'

export const ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1: readonly AttendanceW4ExpectedShadowDifferenceEntryV1[] =
  Object.freeze([
    Object.freeze({
      id: 'correction_applied_daily_adjusted',
      shadowDiffCode: 'status_changed' as const,
      ratifiedBy: '#4556 W4C-1 ratified discretion #6 (correction-applied no-anomaly day => adjusted)',
      evaluator: 'write_probe_v1' as const,
    }),
    Object.freeze({
      id: 'transient_partial_day_in_only_late',
      shadowDiffCode: 'late_minutes_mismatch' as const,
      ratifiedBy: ENTRY_2_3_RATIFIED_BY,
      evaluator: 'read_convergence_v1' as const,
      readProbeCore: Object.freeze({
        changedFields: Object.freeze(['lateMinutes' as const]),
        projectedStatus: 'partial' as const,
        projectedFirstInPresent: true,
        projectedLastOutPresent: false,
      }),
      minuteWitness: 'late' as const,
    }),
    Object.freeze({
      id: 'transient_partial_day_out_only_early_leave',
      shadowDiffCode: 'early_leave_minutes_mismatch' as const,
      ratifiedBy: ENTRY_2_3_RATIFIED_BY,
      evaluator: 'read_convergence_v1' as const,
      readProbeCore: Object.freeze({
        changedFields: Object.freeze(['earlyLeaveMinutes' as const]),
        projectedStatus: 'partial' as const,
        projectedFirstInPresent: false,
        projectedLastOutPresent: true,
      }),
      minuteWitness: 'early_leave' as const,
    }),
  ])

/**
 * The ONE code the write path may relabel to — derived from the roster's
 * single `write_probe_v1` entry, never a floating literal, so the write
 * predicate cannot drift from the entry it executes.
 */
export const ATTENDANCE_W4C2_WRITE_PROBE_PRESENTED_CODE_V1: AttendanceW4ShadowDiffCodeV1 = (() => {
  // #4969 gate P2-2: the roster assert runs INSIDE this derivation — the presented code
  // cannot exist without the module-load invariants having held, so deleting a floating
  // assert call can never silently disarm them.
  assertAttendanceW4C2RosterV1(ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1)
  const writeEntries = ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1.filter(
    (entry) => entry.evaluator === 'write_probe_v1',
  )
  if (writeEntries.length !== 1) fail('W4C2_ROSTER_INVALID')
  return writeEntries[0].shadowDiffCode
})()

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
 * WRITE-side evaluator. True exactly when a status difference matches roster
 * entry `correction_applied_daily_adjusted`: legacy `normal` (its adjusted
 * rule not triggered — zero leave AND zero overtime minutes), W4 `adjusted`
 * through the correction-applied/no-anomaly branch. Everything else is NOT
 * expected. Fail-closed: malformed probes throw rather than returning
 * false-negative "unexpected" or false-positive "expected". The presented-code
 * conjunct is DERIVED from the roster's write entry (behaviour-identical to
 * the previous literal; pinned by mutation).
 */
export function isExpectedAttendanceShadowDifferenceV1(input: unknown): boolean {
  const probe = parseProbe(input)
  return (
    probe.shadowDiffCode === ATTENDANCE_W4C2_WRITE_PROBE_PRESENTED_CODE_V1 &&
    probe.legacyStatus === 'normal' &&
    probe.w4Status === 'adjusted' &&
    probe.w4CorrectionApplied === true &&
    probe.w4AnomalyPresent === false &&
    probe.legacyLeaveMinutes === 0 &&
    probe.legacyOvertimeMinutes === 0
  )
}

/**
 * READ-side probe over one persisted shadow calculation row. Every field is
 * derivable from columns the deployed image already writes
 * (`shadow_diff_code`, the `shadow_diff` jsonb, `projected_status`,
 * `projected_first_in_at` / `projected_last_out_at` presence,
 * `projected_late_minutes` / `projected_early_leave_minutes`), plus
 * `convergedToEqual` — whether the NEXT calculation row (smallest version
 * greater than this row's, same record, mode `shadow`) carries code `equal`,
 * the v2 half of the pinned lifecycle.
 */
export interface AttendanceW4C2ReadSideShadowRowProbeV1 {
  readonly shadowDiffCode: AttendanceW4ShadowDiffCodeV1
  readonly changedFields: readonly ChangedField[]
  readonly projectedStatus: DailyStatus | null
  readonly projectedFirstInPresent: boolean
  readonly projectedLastOutPresent: boolean
  readonly absoluteMinuteDelta: number
  readonly projectedLateMinutes: number | null
  readonly projectedEarlyLeaveMinutes: number | null
  readonly convergedToEqual: boolean
}

const READ_PROBE_KEYS = Object.freeze([
  'shadowDiffCode',
  'changedFields',
  'projectedStatus',
  'projectedFirstInPresent',
  'projectedLastOutPresent',
  'absoluteMinuteDelta',
  'projectedLateMinutes',
  'projectedEarlyLeaveMinutes',
  'convergedToEqual',
] as const)

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function parseAttendanceW4C2ReadSideProbeV1(input: unknown): AttendanceW4C2ReadSideShadowRowProbeV1 {
  const code = 'W4C2_READ_PROBE_INVALID'
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(code)
  const obj = input as Record<string, unknown>
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== READ_PROBE_KEYS.length) fail(code)
  for (const key of READ_PROBE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(code)
  }
  if (!(ATTENDANCE_W4_SHADOW_DIFF_CODES_V1 as readonly string[]).includes(obj.shadowDiffCode as string)) fail(code)
  if (!Array.isArray(obj.changedFields)) fail(code)
  const changedFields = obj.changedFields as unknown[]
  if (!changedFields.every((field) => (CHANGED_FIELDS_DOMAIN as readonly string[]).includes(field as string))) fail(code)
  if (new Set(changedFields).size !== changedFields.length) fail(code)
  const canonical = [...(changedFields as ChangedField[])].sort(
    (left, right) => CHANGED_FIELDS_DOMAIN.indexOf(left) - CHANGED_FIELDS_DOMAIN.indexOf(right),
  )
  if (canonical.some((field, index) => field !== changedFields[index])) fail(code)
  if (obj.projectedStatus !== null && !(DAILY_STATUSES as readonly string[]).includes(obj.projectedStatus as string)) fail(code)
  if (typeof obj.projectedFirstInPresent !== 'boolean') fail(code)
  if (typeof obj.projectedLastOutPresent !== 'boolean') fail(code)
  if (!isNonNegativeInt(obj.absoluteMinuteDelta)) fail(code)
  if (obj.projectedLateMinutes !== null && !isNonNegativeInt(obj.projectedLateMinutes)) fail(code)
  if (obj.projectedEarlyLeaveMinutes !== null && !isNonNegativeInt(obj.projectedEarlyLeaveMinutes)) fail(code)
  if (typeof obj.convergedToEqual !== 'boolean') fail(code)
  return obj as unknown as AttendanceW4C2ReadSideShadowRowProbeV1
}

function sameChangedFields(left: readonly ChangedField[], right: readonly ChangedField[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index])
}

/**
 * READ-side evaluator (entries with `evaluator === 'read_convergence_v1'`).
 * Roster-DRIVEN: the categorical core is deep-equality against the matched
 * entry's `readProbeCore`, then the entry's `minuteWitness` selects the
 * numeric congruence — the witness minute field must be present, positive,
 * and exactly equal to `absoluteMinuteDelta`, while the OTHER minute field is
 * exactly 0 — and finally the row must have OBSERVED convergence
 * (`convergedToEqual === true`). Nothing entry-specific is hardcoded in this
 * body. Fail-closed on malformed probes; false (not expected) when no read
 * entry matches.
 */
export function isExpectedAttendanceW4C2ReadSideDifferenceV1(
  input: unknown,
  roster: readonly AttendanceW4ExpectedShadowDifferenceEntryV1[] = ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1,
): boolean {
  const probe = parseAttendanceW4C2ReadSideProbeV1(input)
  for (const entry of roster) {
    if (entry.evaluator !== 'read_convergence_v1') continue
    const core = entry.readProbeCore
    const witness = entry.minuteWitness
    if (core === undefined || witness === undefined) fail('W4C2_ROSTER_INVALID')
    if (probe.shadowDiffCode !== entry.shadowDiffCode) continue
    if (!sameChangedFields(core.changedFields, probe.changedFields)) continue
    if (probe.projectedStatus !== core.projectedStatus) continue
    if (probe.projectedFirstInPresent !== core.projectedFirstInPresent) continue
    if (probe.projectedLastOutPresent !== core.projectedLastOutPresent) continue
    const witnessValue = witness === 'late' ? probe.projectedLateMinutes : probe.projectedEarlyLeaveMinutes
    const otherValue = witness === 'late' ? probe.projectedEarlyLeaveMinutes : probe.projectedLateMinutes
    if (witnessValue === null || witnessValue <= 0) continue
    if (probe.absoluteMinuteDelta !== witnessValue) continue
    if (otherValue !== 0) continue
    if (probe.convergedToEqual !== true) continue
    return true
  }
  return false
}

/**
 * Module-load roster invariants — fail-closed at import time so a malformed
 * roster can never be consulted. Exported so tests can drive it against
 * synthetic rosters without source mutation.
 */
export function assertAttendanceW4C2RosterV1(
  roster: readonly AttendanceW4ExpectedShadowDifferenceEntryV1[],
): void {
  const code = 'W4C2_ROSTER_INVALID'
  const ids = new Set<string>()
  let writeEntries = 0
  for (const entry of roster) {
    if (ids.has(entry.id)) fail(code)
    ids.add(entry.id)
    if (!(ATTENDANCE_W4_SHADOW_DIFF_CODES_V1 as readonly string[]).includes(entry.shadowDiffCode)) fail(code)
    if ((ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1 as readonly string[]).includes(entry.shadowDiffCode)) fail(code)
    if (entry.shadowDiffCode === 'equal') fail(code)
    if (typeof entry.ratifiedBy !== 'string' || !/#\d{3,}/.test(entry.ratifiedBy)) fail(code)
    if (entry.evaluator === 'write_probe_v1') {
      writeEntries += 1
      if (entry.readProbeCore !== undefined || entry.minuteWitness !== undefined) fail(code)
    } else if (entry.evaluator === 'read_convergence_v1') {
      if (entry.readProbeCore === undefined || entry.minuteWitness === undefined) fail(code)
      // SAFETY: a read-evaluated code must never equal the write path's
      // presented code — this is the mechanical guarantee that entries 2-3 can
      // neither be relabelled by the boundary's relabel branch nor admitted by
      // the write predicate.
      const writeCode = roster.find((candidate) => candidate.evaluator === 'write_probe_v1')?.shadowDiffCode
      if (writeCode !== undefined && entry.shadowDiffCode === writeCode) fail(code)
    } else {
      fail(code)
    }
  }
  if (writeEntries !== 1) fail(code)
}

