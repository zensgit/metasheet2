/**
 * W4C-1 (#4556) — pure segment calculator (lock sections 4.4, 5.1-5.3, 6.1-6.3;
 * red lines W4C-R1/R2/R3/R20/R24/R28/R33).
 *
 * One total pure function: frozen attribution + frozen context + closed
 * evidence + closed approved facts -> closed calculation result. Zero DB, zero
 * routes, zero `Date.now` — every instant is derived from the frozen input.
 * The legacy engine (`computeMetrics` and friends) is untouched; this module
 * is the W4 physical-time truth that W4C-2 wires behind the canonical write
 * boundary.
 *
 * Deterministic failure precedence (first failing step wins; each maps to one
 * closed section 6.2 review reason):
 *
 *  1. top-level/enum shape           -> `input_schema_invalid`
 *  2. attribution posture            -> `legacy_attribution_not_upgradeable`
 *                                       | `context_resolution_ambiguous`
 *                                       | `missing_frozen_context`
 *  3. attribution/context identity   -> `context_mismatch`
 *  4. strict IANA zone               -> `invalid_timezone`
 *  5. boundary resolution            -> `dst_gap_local_time`
 *                                       | `dst_fold_shared_boundary_ambiguous`
 *                                       | `invalid_timezone` (>2 matches)
 *  6. anchor ordering/containment    -> `invalid_segment_order`
 *  7. attribution-window containment -> `evidence_outside_attribution_window`
 *  8. duplicate/ambiguous matching   -> `duplicate_check_in`
 *                                       | `duplicate_check_out`
 *                                       | `ambiguous_segment_match`
 *  9. actual-interval invariants     -> `invalid_evidence_order`
 *                                       | `overlapping_actual_intervals`
 * 10. approved-fact application      -> `approved_fact_conflict`
 *
 * A review result carries zero segments and a null daily projection (lock 7.3:
 * review rows have zero children and never become the current pointer).
 *
 * Payable physical time (W4C-R1/R24): per segment it is
 * `intersection([actualIn,actualOut),[S_i,E_i))` extended only by validated
 * bounded approved overtime, clipped to that exact approved interval. There is
 * no first-in/last-out envelope arithmetic and no planned break ever counts.
 */
import type {
  ApprovedAttendanceFactV1,
  AttendanceAttributionSnapshotV1,
  AttendanceEvidenceV1,
  FrozenAttendanceContextV1,
  PreparedDailyProjectionV1,
} from './w4c0-write-boundary-types'
import {
  parseAttendanceInstantMsV1,
  isAttendanceCalendarDateKeyV1,
  isAttendanceWallTimeHHMMV1,
  resolveAttendanceLocalWallTimeV1,
  validateAttendanceIanaTimezoneV1,
} from './w4c1-strict-time'

export const ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 = 'w4c1-segment-calculator@1'

// ---------------------------------------------------------------------------
// Closed status/reason contracts (lock sections 6.1-6.3, verbatim).
// ---------------------------------------------------------------------------

export const ATTENDANCE_SEGMENT_STATUSES_V1 = Object.freeze([
  'normal',
  'late',
  'early_leave',
  'late_early',
  'missing_check_in',
  'missing_check_out',
  'missing_both',
] as const)
export type AttendanceSegmentStatusV1 = (typeof ATTENDANCE_SEGMENT_STATUSES_V1)[number]

export const ATTENDANCE_SEGMENT_REASONS_V1 = Object.freeze([
  'within_window',
  'late_check_in',
  'early_check_out',
  'missing_check_in',
  'missing_check_out',
  'missing_both',
  'approved_correction_applied',
  'approved_leave_overlay',
  'approved_overtime_overlay',
  'dst_fold_start_earlier',
  'dst_fold_end_later',
] as const)
export type AttendanceSegmentReasonV1 = (typeof ATTENDANCE_SEGMENT_REASONS_V1)[number]

export const ATTENDANCE_DAILY_STATUSES_V1 = Object.freeze([
  'normal',
  'late',
  'early_leave',
  'late_early',
  'partial',
  'absent',
  'adjusted',
  'off',
] as const)
export type AttendanceDailyStatusV1 = (typeof ATTENDANCE_DAILY_STATUSES_V1)[number]

/** Exact section 6.2 persisted outcome-reason set. */
export const ATTENDANCE_CALCULATION_OUTCOME_REASONS_V1 = Object.freeze([
  'calculated',
  'shadow_only',
  'legacy_projection_baseline',
  'ambiguous_segment_match',
  'duplicate_check_in',
  'duplicate_check_out',
  'dst_gap_local_time',
  'dst_fold_shared_boundary_ambiguous',
  'invalid_timezone',
  'invalid_segment_order',
  'invalid_evidence_order',
  'overlapping_actual_intervals',
  'evidence_outside_attribution_window',
  'missing_frozen_context',
  'legacy_attribution_not_upgradeable',
  'frozen_evidence_unavailable',
  'context_resolution_ambiguous',
  'context_mismatch',
  'input_schema_invalid',
  'legacy_time_ingress_not_authoritative',
  'approved_fact_conflict',
  'manual_override_invalid',
  'import_metric_conflict',
  'import_rollback_reversal',
  'operator_retirement',
] as const)
export type AttendanceCalculationOutcomeReasonV1 =
  (typeof ATTENDANCE_CALCULATION_OUTCOME_REASONS_V1)[number]

// ---------------------------------------------------------------------------
// Result shapes. Segment rows use a type alias (not an interface) so they are
// structurally assignable to `PreparedAttendanceResultV1.segments`.
// ---------------------------------------------------------------------------

export type AttendanceCalculatedSegmentV1 = {
  segmentIndex: 0 | 1 | 2
  /** Frozen expected boundaries (lock 5.1 step 7: instant + offset + fold choice). */
  expectedStartAt: string
  expectedEndAt: string
  expectedStartOffsetMinutes: number
  expectedEndOffsetMinutes: number
  expectedStartFold: 'unique' | 'fold_earlier' | 'fold_later'
  expectedEndFold: 'unique' | 'fold_earlier' | 'fold_later'
  actualInAt: string | null
  actualOutAt: string | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  /** Bounded approved-overtime extension actually worked (already inside workedMinutes). */
  overtimeExtensionMinutes: number
  excusedByLeave: boolean
  status: AttendanceSegmentStatusV1
  reasons: AttendanceSegmentReasonV1[]
  matchedEvidenceRefs: string[]
  unmatchedEvidenceRefs: string[]
}

export interface AttendanceSegmentCalculationInputV1 {
  attribution: AttendanceAttributionSnapshotV1
  context: FrozenAttendanceContextV1 | null
  evidence: readonly AttendanceEvidenceV1[]
  approvedFacts: readonly ApprovedAttendanceFactV1[]
}

export interface AttendanceSegmentCalculationResultV1 {
  outcome: 'completed' | 'review_required'
  outcomeReasonCode: AttendanceCalculationOutcomeReasonV1
  segments: AttendanceCalculatedSegmentV1[]
  dailyProjection: PreparedDailyProjectionV1 | null
}

function review(
  outcomeReasonCode: AttendanceCalculationOutcomeReasonV1,
): AttendanceSegmentCalculationResultV1 {
  return { outcome: 'review_required', outcomeReasonCode, segments: [], dailyProjection: null }
}

// ---------------------------------------------------------------------------
// Shared validation helpers (fail-closed; unknown keys rejected).
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== keys.length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false
  }
  return true
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseStrictInstantOrNull(value: unknown): number | null {
  try {
    return parseAttendanceInstantMsV1(value)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Legacy-compatible rounding (lock 4.1: exact `roundMinutes` port, applied
// ONCE to the daily worked total; late/early get no rounding pass).
// ---------------------------------------------------------------------------

export function roundAttendanceMinutesV1(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (!Number.isFinite(step) || step <= 1) return Math.floor(value)
  return Math.floor(value / step) * step
}

/** Exact `computeLateTierCounts` port (lock 4.1/6.3: tiers from the final daily late total). */
export function deriveAttendanceLateTierFieldsV1(
  dailyLateMinutes: number,
  severeLateThresholdMinutes: number,
  absenceLateThresholdMinutes: number,
): { severe_late_count: number; severe_late_minutes: number; absence_late_count: number } {
  const lm = Math.max(0, Math.floor(dailyLateMinutes))
  const severe = Math.max(0, severeLateThresholdMinutes)
  const absenceConfigured = Math.max(0, absenceLateThresholdMinutes)
  const effectiveAbsence = absenceConfigured > 0 ? Math.max(absenceConfigured, severe) : 0
  const severeLateCount = severe > 0 && lm >= severe ? 1 : 0
  const absenceLateCount = effectiveAbsence > 0 && lm >= effectiveAbsence ? 1 : 0
  return {
    severe_late_count: severeLateCount,
    severe_late_minutes: severeLateCount ? lm : 0,
    absence_late_count: absenceLateCount,
  }
}

// ---------------------------------------------------------------------------
// Interval arithmetic ([start,end) in epoch ms).
// ---------------------------------------------------------------------------

interface IntervalMs {
  readonly s: number
  readonly e: number
}

function mergeIntervals(intervals: readonly IntervalMs[]): IntervalMs[] {
  const sorted = [...intervals]
    .filter((iv) => iv.e > iv.s)
    .sort((a, b) => a.s - b.s || a.e - b.e)
  const merged: Array<{ s: number; e: number }> = []
  for (const iv of sorted) {
    const last = merged[merged.length - 1]
    if (last && iv.s <= last.e) {
      if (iv.e > last.e) last.e = iv.e
    } else {
      merged.push({ s: iv.s, e: iv.e })
    }
  }
  return merged
}

function overlapWithSetMs(interval: IntervalMs, set: readonly IntervalMs[]): number {
  let total = 0
  for (const iv of set) {
    const s = Math.max(interval.s, iv.s)
    const e = Math.min(interval.e, iv.e)
    if (e > s) total += e - s
  }
  return total
}

// ---------------------------------------------------------------------------
// Context validation (lock 4.1: closed policy shape; W4C-R28 uniform grace).
// ---------------------------------------------------------------------------

const CONTEXT_KEYS = [
  'schemaVersion',
  'selector',
  'orgId',
  'userId',
  'workDate',
  'timezone',
  'shiftId',
  'isWorkday',
  'holidayKind',
  'calculationGroupId',
  'roundingMinutes',
  'severeLateThresholdMinutes',
  'absenceLateThresholdMinutes',
  'segments',
] as const

const SEGMENT_KEYS = [
  'index',
  'startTime',
  'endTime',
  'startDayOffset',
  'endDayOffset',
  'lateGraceMinutes',
  'earlyLeaveGraceMinutes',
] as const

function validateFrozenContextShape(context: unknown): context is FrozenAttendanceContextV1 {
  if (!hasExactKeys(context, CONTEXT_KEYS)) return false
  const ctx = context as Record<string, unknown>
  if (ctx.schemaVersion !== 1) return false
  if (ctx.selector !== 'legacy') return false
  if (!isNonEmptyString(ctx.orgId) || !isNonEmptyString(ctx.userId)) return false
  if (!isAttendanceCalendarDateKeyV1(ctx.workDate)) return false
  if (!isNonEmptyString(ctx.timezone)) return false
  if (!isNonEmptyString(ctx.shiftId)) return false
  if (typeof ctx.isWorkday !== 'boolean') return false
  if (ctx.holidayKind !== null && !isNonEmptyString(ctx.holidayKind)) return false
  if (ctx.calculationGroupId !== null) return false
  if (!isNonNegativeInteger(ctx.roundingMinutes) || (ctx.roundingMinutes as number) < 1) return false
  if (!isNonNegativeInteger(ctx.severeLateThresholdMinutes)) return false
  if (!isNonNegativeInteger(ctx.absenceLateThresholdMinutes)) return false
  const segments = ctx.segments
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 3) return false
  let maxLateGrace = 0
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    if (!hasExactKeys(segment, SEGMENT_KEYS)) return false
    const seg = segment as Record<string, unknown>
    if (seg.index !== i) return false
    if (!isAttendanceWallTimeHHMMV1(seg.startTime) || !isAttendanceWallTimeHHMMV1(seg.endTime)) {
      return false
    }
    if (seg.startDayOffset !== 0) return false
    if (seg.endDayOffset !== 0 && seg.endDayOffset !== 1) return false
    if (!isNonNegativeInteger(seg.lateGraceMinutes)) return false
    if (!isNonNegativeInteger(seg.earlyLeaveGraceMinutes)) return false
    maxLateGrace = Math.max(maxLateGrace, seg.lateGraceMinutes as number)
  }
  // W4C-R28: the profile grace values are copied identically into every frozen
  // segment. A segment-specific injection fails closed here.
  const firstSeg = segments[0] as Record<string, unknown>
  for (const segment of segments) {
    const seg = segment as Record<string, unknown>
    if (
      seg.lateGraceMinutes !== firstSeg.lateGraceMinutes ||
      seg.earlyLeaveGraceMinutes !== firstSeg.earlyLeaveGraceMinutes
    ) {
      return false
    }
  }
  // Lock 4.1 frozen nesting rule: a zero threshold disables that tier;
  // otherwise absence >= severe >= max(segment.lateGraceMinutes).
  const severe = ctx.severeLateThresholdMinutes as number
  const absence = ctx.absenceLateThresholdMinutes as number
  if (severe > 0 && severe < maxLateGrace) return false
  if (absence > 0 && absence < Math.max(severe, maxLateGrace)) return false
  return true
}

// ---------------------------------------------------------------------------
// Attribution validation (lock 4.1 tagged union).
// ---------------------------------------------------------------------------

const ATTRIBUTION_V2_KEYS = [
  'schemaVersion',
  'resolverVersion',
  'orgId',
  'userId',
  'workDate',
  'shiftId',
  'reasonCode',
  'resolvedAt',
  'absoluteWindow',
  'attributionWindow',
  'attributionTailMinutes',
  'extendedByApprovedOvertime',
  'windowEvidenceFingerprint',
  'source',
] as const

const ATTRIBUTION_SOURCES = Object.freeze([
  'live_resolution',
  'request_creation',
  'import_resolution',
  'scheduled_resolution',
] as const)

const UNSUPPORTED_REASONS = Object.freeze(['legacy_v1', 'missing', 'ambiguous', 'unresolved'] as const)

interface ResolvedWindowsMs {
  absolute: IntervalMs
  attribution: IntervalMs
}

type AttributionCheck =
  | { kind: 'resolved'; windows: ResolvedWindowsMs }
  | { kind: 'review'; reason: AttendanceCalculationOutcomeReasonV1 }
  | { kind: 'invalid' }

function parseWindow(value: unknown): IntervalMs | null {
  if (!hasExactKeys(value, ['startAt', 'endAt'])) return null
  const win = value as Record<string, unknown>
  const s = parseStrictInstantOrNull(win.startAt)
  const e = parseStrictInstantOrNull(win.endAt)
  if (s === null || e === null || s >= e) return null
  return { s, e }
}

function checkAttribution(attribution: unknown): AttributionCheck {
  if (!isPlainObject(attribution)) return { kind: 'invalid' }
  const posture = (attribution as { posture?: unknown }).posture
  if (posture === 'unsupported') {
    if (!hasExactKeys(attribution, ['posture', 'sourceSchemaVersion', 'reason', 'sourceFingerprint'])) {
      return { kind: 'invalid' }
    }
    const value = attribution as Record<string, unknown>
    if (value.sourceSchemaVersion !== 0 && value.sourceSchemaVersion !== 1 && value.sourceSchemaVersion !== null) {
      return { kind: 'invalid' }
    }
    if (!(UNSUPPORTED_REASONS as readonly unknown[]).includes(value.reason)) return { kind: 'invalid' }
    if (value.sourceFingerprint !== null && !isNonEmptyString(value.sourceFingerprint)) {
      return { kind: 'invalid' }
    }
    // Discretionary mapping WITHIN the closed section 6.2 set (documented in
    // the slice PR): legacy V1 attribution is the named non-upgradeable case,
    // ambiguity keeps its named ambiguity code, missing/unresolved collapse to
    // the missing-frozen-context review.
    if (value.reason === 'legacy_v1') return { kind: 'review', reason: 'legacy_attribution_not_upgradeable' }
    if (value.reason === 'ambiguous') return { kind: 'review', reason: 'context_resolution_ambiguous' }
    return { kind: 'review', reason: 'missing_frozen_context' }
  }
  if (posture !== 'resolved_v2') return { kind: 'invalid' }
  if (!hasExactKeys(attribution, ['posture', 'value'])) return { kind: 'invalid' }
  const value = (attribution as Record<string, unknown>).value
  if (!hasExactKeys(value, ATTRIBUTION_V2_KEYS)) return { kind: 'invalid' }
  const v2 = value as Record<string, unknown>
  if (v2.schemaVersion !== 2) return { kind: 'invalid' }
  if (!isNonEmptyString(v2.resolverVersion) || !isNonEmptyString(v2.orgId) || !isNonEmptyString(v2.userId)) {
    return { kind: 'invalid' }
  }
  if (!isAttendanceCalendarDateKeyV1(v2.workDate)) return { kind: 'invalid' }
  if (!isNonEmptyString(v2.shiftId) || !isNonEmptyString(v2.reasonCode)) return { kind: 'invalid' }
  if (parseStrictInstantOrNull(v2.resolvedAt) === null) return { kind: 'invalid' }
  if (!isNonNegativeInteger(v2.attributionTailMinutes)) return { kind: 'invalid' }
  if (typeof v2.extendedByApprovedOvertime !== 'boolean') return { kind: 'invalid' }
  if (!isNonEmptyString(v2.windowEvidenceFingerprint)) return { kind: 'invalid' }
  if (!(ATTRIBUTION_SOURCES as readonly unknown[]).includes(v2.source)) return { kind: 'invalid' }
  const absolute = parseWindow(v2.absoluteWindow)
  const attributionWindow = parseWindow(v2.attributionWindow)
  if (!absolute || !attributionWindow) return { kind: 'invalid' }
  return { kind: 'resolved', windows: { absolute, attribution: attributionWindow } }
}

// ---------------------------------------------------------------------------
// Evidence and approved-fact validation (lock 4.2 closed unions).
// ---------------------------------------------------------------------------

const PUNCH_SOURCES = Object.freeze(['attendance_event', 'outdoor_approval', 'import'] as const)
const DIRECTIONS = Object.freeze(['check_in', 'check_out'] as const)
const FACT_KINDS = Object.freeze(['leave', 'overtime', 'correction', 'outdoor_punch', 'reversal'] as const)

interface TimedEvidenceMs {
  readonly ref: string
  readonly kind: 'punch' | 'approved_adjustment'
  readonly direction: 'check_in' | 'check_out'
  readonly occurredAtMs: number
}

interface ValidatedEvidence {
  timed: TimedEvidenceMs[]
  scheduledAbsenceRefs: string[]
}

function validateEvidence(evidence: unknown): ValidatedEvidence | null {
  if (!Array.isArray(evidence)) return null
  const timed: TimedEvidenceMs[] = []
  const scheduledAbsenceRefs: string[] = []
  const seenRefs = new Set<string>()
  for (const item of evidence) {
    if (!isPlainObject(item)) return null
    const kind = item.kind
    if (kind === 'punch' || kind === 'approved_adjustment') {
      if (!hasExactKeys(item, ['kind', 'ref', 'direction', 'occurredAt', 'source'])) return null
      if (!isNonEmptyString(item.ref)) return null
      if (!(DIRECTIONS as readonly unknown[]).includes(item.direction)) return null
      if (kind === 'punch' && !(PUNCH_SOURCES as readonly unknown[]).includes(item.source)) return null
      if (kind === 'approved_adjustment' && item.source !== 'correction') return null
      const occurredAtMs = parseStrictInstantOrNull(item.occurredAt)
      if (occurredAtMs === null) return null
      if (seenRefs.has(item.ref as string)) return null
      seenRefs.add(item.ref as string)
      timed.push({
        ref: item.ref as string,
        kind,
        direction: item.direction as 'check_in' | 'check_out',
        occurredAtMs,
      })
    } else if (kind === 'scheduled_absence') {
      if (!hasExactKeys(item, ['kind', 'ref'])) return null
      if (!isNonEmptyString(item.ref)) return null
      if (seenRefs.has(item.ref as string)) return null
      seenRefs.add(item.ref as string)
      scheduledAbsenceRefs.push(item.ref as string)
    } else {
      return null
    }
  }
  return { timed, scheduledAbsenceRefs }
}

interface ValidatedFacts {
  boundedLeaveIntervals: IntervalMs[]
  boundedOvertimeIntervals: IntervalMs[]
  supersededEvidenceRefs: Set<string>
  hasUnboundedMinutesFact: boolean
}

type FactsCheck =
  | { kind: 'ok'; facts: ValidatedFacts }
  | { kind: 'invalid' }

const FACT_BASE_KEYS = [
  'kind',
  'requestId',
  'requestSnapshotVersion',
  'requestSnapshotFingerprint',
  'approvalVersion',
  'approvalRecordId',
] as const

function validateFactBase(item: Record<string, unknown>): boolean {
  if (!isNonEmptyString(item.requestId)) return false
  if (!isNonNegativeInteger(item.requestSnapshotVersion)) return false
  if (!isNonEmptyString(item.requestSnapshotFingerprint)) return false
  if (!isNonNegativeInteger(item.approvalVersion)) return false
  if (!isNonEmptyString(item.approvalRecordId)) return false
  return true
}

function parseCoverage(value: unknown): { bounded: IntervalMs | null; unbounded: boolean } | null {
  if (!isPlainObject(value)) return null
  if (value.kind === 'bounded_interval') {
    if (!hasExactKeys(value, ['kind', 'startAt', 'endAt', 'minutes'])) return null
    const s = parseStrictInstantOrNull(value.startAt)
    const e = parseStrictInstantOrNull(value.endAt)
    if (s === null || e === null || s >= e) return null
    if (!isNonNegativeInteger(value.minutes)) return null
    return { bounded: { s, e }, unbounded: false }
  }
  if (value.kind === 'minutes_only_unbounded') {
    if (!hasExactKeys(value, ['kind', 'minutes', 'source'])) return null
    if (!isNonNegativeInteger(value.minutes)) return null
    if (value.source !== 'explicit_minutes' && value.source !== 'policy_default') return null
    return { bounded: null, unbounded: true }
  }
  return null
}

function validateApprovedFacts(facts: unknown): FactsCheck {
  if (!Array.isArray(facts)) return { kind: 'invalid' }
  const boundedLeaveIntervals: IntervalMs[] = []
  const boundedOvertimeIntervals: IntervalMs[] = []
  const supersededEvidenceRefs = new Set<string>()
  let hasUnboundedMinutesFact = false
  const seen = new Set<string>()
  for (const item of facts) {
    if (!isPlainObject(item)) return { kind: 'invalid' }
    const kind = item.kind
    if (!(FACT_KINDS as readonly unknown[]).includes(kind)) return { kind: 'invalid' }
    if (!validateFactBase(item)) return { kind: 'invalid' }
    const dedupeKey = `${String(kind)}${String(item.requestId)}`
    if (seen.has(dedupeKey)) return { kind: 'invalid' }
    seen.add(dedupeKey)
    if (kind === 'leave') {
      if (!hasExactKeys(item, [...FACT_BASE_KEYS, 'coverage', 'leaveType'])) return { kind: 'invalid' }
      if (!isNonEmptyString(item.leaveType)) return { kind: 'invalid' }
      const coverage = parseCoverage(item.coverage)
      if (!coverage) return { kind: 'invalid' }
      if (coverage.unbounded) hasUnboundedMinutesFact = true
      else if (coverage.bounded) boundedLeaveIntervals.push(coverage.bounded)
    } else if (kind === 'overtime') {
      if (!hasExactKeys(item, [...FACT_BASE_KEYS, 'coverage'])) return { kind: 'invalid' }
      const coverage = parseCoverage(item.coverage)
      if (!coverage) return { kind: 'invalid' }
      if (coverage.unbounded) hasUnboundedMinutesFact = true
      else if (coverage.bounded) boundedOvertimeIntervals.push(coverage.bounded)
    } else if (kind === 'correction') {
      if (
        !hasExactKeys(item, [...FACT_BASE_KEYS, 'direction', 'occurredAt', 'supersededEvidenceRef'])
      ) {
        return { kind: 'invalid' }
      }
      if (!(DIRECTIONS as readonly unknown[]).includes(item.direction)) return { kind: 'invalid' }
      if (parseStrictInstantOrNull(item.occurredAt) === null) return { kind: 'invalid' }
      if (!isNonEmptyString(item.supersededEvidenceRef)) return { kind: 'invalid' }
      supersededEvidenceRefs.add(item.supersededEvidenceRef as string)
    } else if (kind === 'outdoor_punch') {
      if (!hasExactKeys(item, [...FACT_BASE_KEYS, 'direction', 'occurredAt'])) return { kind: 'invalid' }
      if (!(DIRECTIONS as readonly unknown[]).includes(item.direction)) return { kind: 'invalid' }
      if (parseStrictInstantOrNull(item.occurredAt) === null) return { kind: 'invalid' }
      // Outdoor facts are boundary evidence provenance; their punch rows are
      // already in the evidence array (lock 4.4). No overlay minutes here.
    } else {
      // 'reversal' facts belong to the reversal entrypoint (section 7), which
      // never runs this calculator. Fail closed rather than silently ignore.
      return { kind: 'invalid' }
    }
  }
  return {
    kind: 'ok',
    facts: {
      boundedLeaveIntervals,
      boundedOvertimeIntervals,
      supersededEvidenceRefs,
      hasUnboundedMinutesFact,
    },
  }
}

// ---------------------------------------------------------------------------
// Anchors and direction-partition capture cells (lock 5.1/5.2).
// ---------------------------------------------------------------------------

interface FrozenBoundary {
  epochMs: number
  offsetMinutes: number
  fold: 'unique' | 'fold_earlier' | 'fold_later'
  wallKey: string
}

type AnchorsCheck =
  | { kind: 'ok'; starts: FrozenBoundary[]; ends: FrozenBoundary[] }
  | { kind: 'review'; reason: AttendanceCalculationOutcomeReasonV1 }

function resolveAnchors(
  context: FrozenAttendanceContextV1,
  windows: ResolvedWindowsMs,
): AnchorsCheck {
  const segments = context.segments
  interface RawBoundary {
    role: 'start' | 'end'
    segmentIndex: number
    wallKey: string
    resolution: ReturnType<typeof resolveAttendanceLocalWallTimeV1>
  }
  const raw: RawBoundary[] = []
  for (const segment of segments) {
    const startResolution = resolveAttendanceLocalWallTimeV1(
      context.workDate,
      segment.startTime,
      segment.startDayOffset,
      context.timezone,
    )
    const endResolution = resolveAttendanceLocalWallTimeV1(
      context.workDate,
      segment.endTime,
      segment.endDayOffset,
      context.timezone,
    )
    raw.push({
      role: 'start',
      segmentIndex: segment.index,
      wallKey: `${segment.startDayOffset}${segment.startTime}`,
      resolution: startResolution,
    })
    raw.push({
      role: 'end',
      segmentIndex: segment.index,
      wallKey: `${segment.endDayOffset}${segment.endTime}`,
      resolution: endResolution,
    })
  }
  for (const boundary of raw) {
    if (boundary.resolution.posture === 'gap') return { kind: 'review', reason: 'dst_gap_local_time' }
    if (boundary.resolution.posture === 'invalid') return { kind: 'review', reason: 'invalid_timezone' }
  }
  // Lock 5.1 step 5: a two-match (fold) local boundary SHARED by E_i and
  // S_(i+1) is review-required — W3 stores no offset able to assign the
  // repeated hour to either segment.
  for (let i = 0; i + 1 < segments.length; i += 1) {
    const end = raw.find((b) => b.role === 'end' && b.segmentIndex === i)
    const nextStart = raw.find((b) => b.role === 'start' && b.segmentIndex === i + 1)
    if (
      end &&
      nextStart &&
      end.wallKey === nextStart.wallKey &&
      (end.resolution.posture === 'fold' || nextStart.resolution.posture === 'fold')
    ) {
      return { kind: 'review', reason: 'dst_fold_shared_boundary_ambiguous' }
    }
  }
  const starts: FrozenBoundary[] = []
  const ends: FrozenBoundary[] = []
  for (const boundary of raw) {
    const res = boundary.resolution
    let frozen: FrozenBoundary
    if (res.posture === 'unique') {
      frozen = {
        epochMs: res.epochMs,
        offsetMinutes: res.offsetMinutes,
        fold: 'unique',
        wallKey: boundary.wallKey,
      }
    } else if (res.posture === 'fold') {
      // Lock 5.1 step 4: an unshared fold start chooses the earlier instant,
      // an unshared fold end chooses the later instant.
      const choice = boundary.role === 'start' ? res.earlier : res.later
      frozen = {
        epochMs: choice.epochMs,
        offsetMinutes: choice.offsetMinutes,
        fold: boundary.role === 'start' ? 'fold_earlier' : 'fold_later',
        wallKey: boundary.wallKey,
      }
    } else {
      return { kind: 'review', reason: 'invalid_timezone' }
    }
    if (boundary.role === 'start') starts[boundary.segmentIndex] = frozen
    else ends[boundary.segmentIndex] = frozen
  }
  // Lock 5.2 invariants: S_i < E_i, E_i <= S_(i+1), and every planned boundary
  // stays inside the frozen W2 absoluteWindow.
  for (let i = 0; i < segments.length; i += 1) {
    if (!(starts[i].epochMs < ends[i].epochMs)) return { kind: 'review', reason: 'invalid_segment_order' }
    if (i + 1 < segments.length && !(ends[i].epochMs <= starts[i + 1].epochMs)) {
      return { kind: 'review', reason: 'invalid_segment_order' }
    }
    for (const boundary of [starts[i], ends[i]]) {
      if (boundary.epochMs < windows.absolute.s || boundary.epochMs > windows.absolute.e) {
        return { kind: 'review', reason: 'invalid_segment_order' }
      }
    }
  }
  return { kind: 'ok', starts, ends }
}

interface DirectionCell {
  segmentIndex: number
  startMs: number
  endMs: number
  finalCell: boolean
}

/**
 * Lock 5.2 capture cells: one independent partition per direction (check-in
 * anchors are segment starts, check-out anchors are segment ends); midpoints
 * only between adjacent anchors of the SAME partition; cells left-closed /
 * right-open with the final right endpoint included; a midpoint tie belongs to
 * the later segment (an instant exactly on a midpoint is outside the earlier
 * right-open cell); both partitions clipped to the frozen attributionWindow.
 */
function buildDirectionCells(anchors: readonly FrozenBoundary[], window: IntervalMs): DirectionCell[] {
  const cells: DirectionCell[] = []
  for (let i = 0; i < anchors.length; i += 1) {
    const left =
      i === 0 ? window.s : (anchors[i - 1].epochMs + anchors[i].epochMs) / 2
    const right =
      i === anchors.length - 1 ? window.e : (anchors[i].epochMs + anchors[i + 1].epochMs) / 2
    cells.push({
      segmentIndex: i,
      startMs: Math.max(left, window.s),
      endMs: Math.min(right, window.e),
      finalCell: i === anchors.length - 1,
    })
  }
  return cells
}

function cellIndexFor(cells: readonly DirectionCell[], epochMs: number): number | null {
  for (const cell of cells) {
    if (epochMs >= cell.startMs && (epochMs < cell.endMs || (cell.finalCell && epochMs === cell.endMs))) {
      return cell.segmentIndex
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The calculator.
// ---------------------------------------------------------------------------

export function calculateAttendanceSegmentsV1(
  input: AttendanceSegmentCalculationInputV1,
): AttendanceSegmentCalculationResultV1 {
  // 1. Top-level shape.
  if (!hasExactKeys(input, ['attribution', 'context', 'evidence', 'approvedFacts'])) {
    return review('input_schema_invalid')
  }

  // 2. Attribution posture.
  const attributionCheck = checkAttribution(input.attribution)
  if (attributionCheck.kind === 'invalid') return review('input_schema_invalid')
  if (attributionCheck.kind === 'review') return review(attributionCheck.reason)
  if (input.context === null) return review('missing_frozen_context')
  if (!validateFrozenContextShape(input.context)) return review('input_schema_invalid')
  const context = input.context
  const windows = attributionCheck.windows

  // 3. Attribution/context identity must agree (same frozen selection).
  const v2 = (input.attribution as unknown as { value: Record<string, unknown> }).value
  if (
    v2.orgId !== context.orgId ||
    v2.userId !== context.userId ||
    v2.workDate !== context.workDate ||
    v2.shiftId !== context.shiftId
  ) {
    return review('context_mismatch')
  }

  // 4. Strict IANA timezone (lock 5.1; no UTC fallback exists below).
  try {
    validateAttendanceIanaTimezoneV1(context.timezone)
  } catch {
    return review('invalid_timezone')
  }

  // Closed evidence/fact shapes (unknown enum members fail closed).
  const validatedEvidence = validateEvidence(input.evidence)
  if (!validatedEvidence) return review('input_schema_invalid')
  const factsCheck = validateApprovedFacts(input.approvedFacts)
  if (factsCheck.kind === 'invalid') return review('input_schema_invalid')
  const facts = factsCheck.facts

  // 5./6. Anchors: DST gap/shared-fold/invalid zone, ordering, containment.
  const anchorsCheck = resolveAnchors(context, windows)
  if (anchorsCheck.kind === 'review') return review(anchorsCheck.reason)
  const { starts, ends } = anchorsCheck

  // Effective evidence: approved corrections supersede their named evidence
  // ref BEFORE window/matching checks (correcting an out-of-window punch must
  // not strand the day in review).
  const effective = validatedEvidence.timed.filter((item) => !facts.supersededEvidenceRefs.has(item.ref))
  const supersededPresent = validatedEvidence.timed.filter((item) =>
    facts.supersededEvidenceRefs.has(item.ref),
  )

  // 7. Every effective timed evidence item must lie inside the frozen
  // attribution window (lock 5.3; OD-W4C-18). It is retained in the immutable
  // snapshot by the caller; here the whole calculation becomes review.
  for (const item of effective) {
    if (item.occurredAtMs < windows.attribution.s || item.occurredAtMs > windows.attribution.e) {
      return review('evidence_outside_attribution_window')
    }
  }

  // 8. Directional matching. The calculator NEVER collapses duplicates to
  // earliest/latest (W4C-R2): a second candidate in one directional cell is
  // review; duplicates in both directions escalate to ambiguous.
  const inCells = buildDirectionCells(starts, windows.attribution)
  const outCells = buildDirectionCells(ends, windows.attribution)
  const inMatches = new Map<number, TimedEvidenceMs[]>()
  const outMatches = new Map<number, TimedEvidenceMs[]>()
  for (const item of effective) {
    const cells = item.direction === 'check_in' ? inCells : outCells
    const target = item.direction === 'check_in' ? inMatches : outMatches
    const segmentIndex = cellIndexFor(cells, item.occurredAtMs)
    if (segmentIndex === null) return review('evidence_outside_attribution_window')
    const existing = target.get(segmentIndex)
    if (existing) existing.push(item)
    else target.set(segmentIndex, [item])
  }
  let duplicateIn = false
  let duplicateOut = false
  for (const matches of inMatches.values()) if (matches.length > 1) duplicateIn = true
  for (const matches of outMatches.values()) if (matches.length > 1) duplicateOut = true
  if (duplicateIn && duplicateOut) return review('ambiguous_segment_match')
  if (duplicateIn) return review('duplicate_check_in')
  if (duplicateOut) return review('duplicate_check_out')

  // 9. Actual-interval invariants (lock 5.3; W4C-R20).
  interface SegmentActual {
    inEvidence: TimedEvidenceMs | null
    outEvidence: TimedEvidenceMs | null
  }
  const actuals: SegmentActual[] = context.segments.map((segment) => ({
    inEvidence: inMatches.get(segment.index)?.[0] ?? null,
    outEvidence: outMatches.get(segment.index)?.[0] ?? null,
  }))
  for (const actual of actuals) {
    if (actual.inEvidence && actual.outEvidence) {
      if (!(actual.inEvidence.occurredAtMs < actual.outEvidence.occurredAtMs)) {
        return review('invalid_evidence_order')
      }
    }
  }
  let previousCompletedOutMs: number | null = null
  for (const actual of actuals) {
    if (actual.inEvidence && actual.outEvidence) {
      if (previousCompletedOutMs !== null && actual.inEvidence.occurredAtMs < previousCompletedOutMs) {
        return review('overlapping_actual_intervals')
      }
      previousCompletedOutMs = actual.outEvidence.occurredAtMs
    }
  }

  // 10. Approved-fact application (lock 4.4). `minutes_only_unbounded`
  // leave/overtime and PARTIAL bounded leave coverage are faithfully
  // snapshotted by the caller but review-required here: they can neither
  // excuse a segment nor extend attribution. (Discretionary code assignment
  // within the closed set: `approved_fact_conflict`.)
  if (facts.hasUnboundedMinutesFact) return review('approved_fact_conflict')
  const leaveSet = mergeIntervals(facts.boundedLeaveIntervals)
  const overtimeSet = mergeIntervals(facts.boundedOvertimeIntervals)
  const excused: boolean[] = []
  for (const segment of context.segments) {
    const planned: IntervalMs = { s: starts[segment.index].epochMs, e: ends[segment.index].epochMs }
    const covered = overlapWithSetMs(planned, leaveSet)
    const duration = planned.e - planned.s
    if (covered > 0 && covered < duration) return review('approved_fact_conflict')
    excused[segment.index] = covered === duration && duration > 0
  }

  // 11. Per-segment metrics/status (lock 6.1) and daily aggregate (lock 6.3).
  const graceLateMs = context.segments[0].lateGraceMinutes * 60_000
  const graceEarlyMs = context.segments[0].earlyLeaveGraceMinutes * 60_000
  const segmentsOut: AttendanceCalculatedSegmentV1[] = []
  let rawWorkedTotal = 0
  let lateTotal = 0
  let earlyTotal = 0
  let overtimeExtensionTotal = 0
  let anyCorrectionApplied = false
  let firstInMs: number | null = null
  let lastOutMs: number | null = null

  for (const segment of context.segments) {
    const index = segment.index
    const start = starts[index]
    const end = ends[index]
    const planned: IntervalMs = { s: start.epochMs, e: end.epochMs }
    const actual = actuals[index]
    const inMs = actual.inEvidence?.occurredAtMs ?? null
    const outMs = actual.outEvidence?.occurredAtMs ?? null

    // Late/early come from the RAW actual boundaries versus the frozen grace
    // thresholds (legacy-parity: minutes are measured beyond start+grace /
    // before end-grace and floored to whole minutes).
    const lateMinutes =
      inMs === null ? 0 : Math.max(0, Math.floor((inMs - (planned.s + graceLateMs)) / 60_000))
    const earlyLeaveMinutes =
      outMs === null ? 0 : Math.max(0, Math.floor((planned.e - graceEarlyMs - outMs) / 60_000))

    // Payable physical time (W4C-R1/R24): intersection of the actual interval
    // with the planned segment, extended ONLY through validated bounded
    // approved overtime and clipped to those exact approved intervals. A
    // planned break can never be counted; missing boundaries synthesize no
    // work.
    let workedMinutes = 0
    let overtimeExtensionMinutes = 0
    if (inMs !== null && outMs !== null) {
      const actualInterval: IntervalMs = { s: inMs, e: outMs }
      const payableSet = mergeIntervals([planned, ...overtimeSet.map((iv) => ({ ...iv }))])
      const payableMs = overlapWithSetMs(actualInterval, payableSet)
      const baseMs = overlapWithSetMs(actualInterval, [planned])
      workedMinutes = Math.floor(payableMs / 60_000)
      overtimeExtensionMinutes = Math.floor((payableMs - baseMs) / 60_000)
    }

    const inMissing = inMs === null
    const outMissing = outMs === null
    let status: AttendanceSegmentStatusV1
    if (inMissing && outMissing) status = 'missing_both'
    else if (inMissing) status = 'missing_check_in'
    else if (outMissing) status = 'missing_check_out'
    else if (lateMinutes > 0 && earlyLeaveMinutes > 0) status = 'late_early'
    else if (lateMinutes > 0) status = 'late'
    else if (earlyLeaveMinutes > 0) status = 'early_leave'
    else status = 'normal'

    const reasons = new Set<AttendanceSegmentReasonV1>()
    if (status === 'missing_both') reasons.add('missing_both')
    if (status === 'missing_check_in') reasons.add('missing_check_in')
    if (status === 'missing_check_out') reasons.add('missing_check_out')
    if (lateMinutes > 0) reasons.add('late_check_in')
    if (earlyLeaveMinutes > 0) reasons.add('early_check_out')
    if (reasons.size === 0) reasons.add('within_window')
    if (excused[index]) reasons.add('approved_leave_overlay')
    if (overtimeExtensionMinutes > 0) reasons.add('approved_overtime_overlay')
    const correctionApplied =
      actual.inEvidence?.kind === 'approved_adjustment' ||
      actual.outEvidence?.kind === 'approved_adjustment'
    if (correctionApplied) reasons.add('approved_correction_applied')
    if (start.fold === 'fold_earlier') reasons.add('dst_fold_start_earlier')
    if (end.fold === 'fold_later') reasons.add('dst_fold_end_later')

    const matchedEvidenceRefs: string[] = []
    if (actual.inEvidence) matchedEvidenceRefs.push(actual.inEvidence.ref)
    if (actual.outEvidence) matchedEvidenceRefs.push(actual.outEvidence.ref)
    // Superseded evidence surfaces on the segment whose directional cell would
    // have captured it (explanation only; it never contributes boundaries).
    const unmatchedEvidenceRefs = supersededPresent
      .filter((item) => {
        const cells = item.direction === 'check_in' ? inCells : outCells
        return cellIndexFor(cells, item.occurredAtMs) === index
      })
      .map((item) => item.ref)
      .sort()

    rawWorkedTotal += workedMinutes
    lateTotal += lateMinutes
    earlyTotal += earlyLeaveMinutes
    overtimeExtensionTotal += overtimeExtensionMinutes
    anyCorrectionApplied = anyCorrectionApplied || correctionApplied
    if (inMs !== null) firstInMs = firstInMs === null ? inMs : Math.min(firstInMs, inMs)
    if (outMs !== null) lastOutMs = lastOutMs === null ? outMs : Math.max(lastOutMs, outMs)

    segmentsOut.push({
      segmentIndex: index,
      expectedStartAt: new Date(start.epochMs).toISOString(),
      expectedEndAt: new Date(end.epochMs).toISOString(),
      expectedStartOffsetMinutes: start.offsetMinutes,
      expectedEndOffsetMinutes: end.offsetMinutes,
      expectedStartFold: start.fold,
      expectedEndFold: end.fold,
      actualInAt: inMs === null ? null : new Date(inMs).toISOString(),
      actualOutAt: outMs === null ? null : new Date(outMs).toISOString(),
      workedMinutes,
      lateMinutes,
      earlyLeaveMinutes,
      overtimeExtensionMinutes,
      excusedByLeave: excused[index],
      status,
      reasons: [...reasons].sort(),
      matchedEvidenceRefs,
      unmatchedEvidenceRefs,
    })
  }

  // Daily aggregation (lock 6.3). "Missing" means not fully excused by
  // validated leave. One daily rounding pass over the raw segment sum;
  // late/early are plain segment sums with NO further rounding.
  const unexcusedMissing = segmentsOut.map(
    (segment) =>
      (segment.status === 'missing_both' ||
        segment.status === 'missing_check_in' ||
        segment.status === 'missing_check_out') &&
      !segment.excusedByLeave,
  )
  const everySegmentUnexcusedMissingBoth = segmentsOut.every(
    (segment) => segment.status === 'missing_both' && !segment.excusedByLeave,
  )
  const anyUnexcusedMissing = unexcusedMissing.some(Boolean)
  const anyLate = segmentsOut.some((segment) => segment.lateMinutes > 0)
  const anyEarly = segmentsOut.some((segment) => segment.earlyLeaveMinutes > 0)
  const anyLateEarlySameSegment = segmentsOut.some(
    (segment) => segment.lateMinutes > 0 && segment.earlyLeaveMinutes > 0,
  )
  const anyExcused = segmentsOut.some((segment) => segment.excusedByLeave)
  const factsChangedResult =
    anyExcused || overtimeExtensionTotal > 0 || anyCorrectionApplied

  let dailyStatus: AttendanceDailyStatusV1
  if (!context.isWorkday) dailyStatus = 'off'
  else if (everySegmentUnexcusedMissingBoth) dailyStatus = 'absent'
  else if (anyUnexcusedMissing) dailyStatus = 'partial'
  else if (anyLateEarlySameSegment || (anyLate && anyEarly)) dailyStatus = 'late_early'
  else if (anyLate) dailyStatus = 'late'
  else if (anyEarly) dailyStatus = 'early_leave'
  else if (factsChangedResult) dailyStatus = 'adjusted'
  else dailyStatus = 'normal'

  const workedMinutesDaily = roundAttendanceMinutesV1(rawWorkedTotal, context.roundingMinutes)
  // Legacy parity: a non-workday reports no late/early anomaly minutes.
  const lateMinutesDaily = context.isWorkday ? lateTotal : 0
  const earlyMinutesDaily = context.isWorkday ? earlyTotal : 0
  const tierFields = deriveAttendanceLateTierFieldsV1(
    lateMinutesDaily,
    context.severeLateThresholdMinutes,
    context.absenceLateThresholdMinutes,
  )

  const dailyProjection: PreparedDailyProjectionV1 = {
    firstInAt: firstInMs === null ? null : new Date(firstInMs).toISOString(),
    lastOutAt: lastOutMs === null ? null : new Date(lastOutMs).toISOString(),
    workedMinutes: workedMinutesDaily,
    lateMinutes: lateMinutesDaily,
    earlyLeaveMinutes: earlyMinutesDaily,
    status: dailyStatus,
    timezone: context.timezone,
    workDate: context.workDate,
    meta: tierFields,
  }

  return {
    outcome: 'completed',
    outcomeReasonCode: 'calculated',
    segments: segmentsOut,
    dailyProjection,
  }
}
