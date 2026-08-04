/**
 * W5 (#4556) — flexible single-segment attendance policy (design lock
 * docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md
 * sections 3.3 + 9.6).
 *
 * Flex is a separate shift policy, not a reinterpretation of grace:
 *   mode: strict | flex_required_duration
 *   requiredMinutes, arrivalWindowBeforeMinutes, arrivalWindowAfterMinutes
 *   coreStartTime / coreEndTime (optional pair)
 *
 * v1 rules encoded here:
 *   - flex_required_duration is supported only for a one-segment shift;
 *   - expected start = first valid arrival clamped to the arrival window
 *     anchored at the single segment start wall time;
 *   - expected end = expected start + requiredMinutes;
 *   - optional core hours are guaranteed by **authoring** validation so that
 *     every allowed clamped start covers core (see
 *     `flexCoreHoursCoveredByAllClampedIntervalsV1`); the calculator does not
 *     invent a runtime reasonCode for core coverage;
 *   - late/early grace is applied by the calculator AFTER flex resolution;
 *   - multi-segment flex is rejected (write path and frozen-context validation).
 *
 * Absent flexPolicy on a frozen context means strict (legacy W4 bytes).
 */
import { isAttendanceWallTimeHHMMV1 } from './w4c1-strict-time'

export const ATTENDANCE_FLEX_MODES_V1 = Object.freeze(['strict', 'flex_required_duration'] as const)
export type AttendanceFlexModeV1 = (typeof ATTENDANCE_FLEX_MODES_V1)[number]

export type AttendanceFlexPolicyStrictV1 = {
  mode: 'strict'
}

export type AttendanceFlexPolicyRequiredDurationV1 = {
  mode: 'flex_required_duration'
  requiredMinutes: number
  arrivalWindowBeforeMinutes: number
  arrivalWindowAfterMinutes: number
  coreStartTime: string | null
  coreEndTime: string | null
}

export type AttendanceFlexPolicyV1 =
  | AttendanceFlexPolicyStrictV1
  | AttendanceFlexPolicyRequiredDurationV1

export const ATTENDANCE_FLEX_MAX_REQUIRED_MINUTES_V1 = 1440

export interface AttendanceFlexPolicyValidationOptionsV1 {
  segmentCount: number
  /**
   * Single-segment start wall time (HH:MM). Required when core hours are set so
   * authoring can prove every clamped arrival covers core.
   */
  segmentStartTime?: string | null
}

const FLEX_STRICT_KEYS = ['mode'] as const
const FLEX_REQUIRED_KEYS = [
  'mode',
  'requiredMinutes',
  'arrivalWindowBeforeMinutes',
  'arrivalWindowAfterMinutes',
  'coreStartTime',
  'coreEndTime',
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== keys.length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.get || descriptor.set) return false
  }
  return true
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveIntegerAtMost(
  value: unknown,
  max: number,
): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max
}

function parseHhMmToMinutes(value: string): number | null {
  if (!isAttendanceWallTimeHHMMV1(value)) return null
  const hours = Number(value.slice(0, 2))
  const minutes = Number(value.slice(3, 5))
  return hours * 60 + minutes
}

/**
 * Authoring guarantee for optional core hours (§3.3 "must remain covered"):
 * every allowed clamped expected-start in the arrival window must cover core.
 *
 * Equivalently (minutes may be negative when the window opens before midnight):
 *   latestPermittedStart  <= coreStart
 *   earliestPermittedStart + requiredMinutes >= coreEnd
 *
 * Implementation assumption (recorded in the W5 verification MD): core hours are
 * same-calendar-day wall times relative to the work date; the arrival window is
 * anchored at the single segment start. No new runtime reasonCode is emitted.
 */
export function flexCoreHoursCoveredByAllClampedIntervalsV1(input: {
  segmentStartMinutes: number
  arrivalWindowBeforeMinutes: number
  arrivalWindowAfterMinutes: number
  requiredMinutes: number
  coreStartMinutes: number
  coreEndMinutes: number
}): boolean {
  if (!(input.coreEndMinutes > input.coreStartMinutes)) return false
  if (!(input.requiredMinutes > 0)) return false
  if (input.arrivalWindowBeforeMinutes < 0 || input.arrivalWindowAfterMinutes < 0) return false
  const earliestPermittedStart =
    input.segmentStartMinutes - input.arrivalWindowBeforeMinutes
  const latestPermittedStart =
    input.segmentStartMinutes + input.arrivalWindowAfterMinutes
  return (
    latestPermittedStart <= input.coreStartMinutes
    && earliestPermittedStart + input.requiredMinutes >= input.coreEndMinutes
  )
}

/**
 * Strict discriminated validation for a flex policy payload.
 * Multi-segment flex fails closed. Core hours, when set, are validated against
 * the single segment start so every clamped interval covers core.
 */
export function validateAttendanceFlexPolicyV1(
  value: unknown,
  options: AttendanceFlexPolicyValidationOptionsV1,
): value is AttendanceFlexPolicyV1 {
  if (!isPlainObject(value)) return false
  const mode = value.mode
  if (mode === 'strict') {
    if (!hasExactKeys(value, FLEX_STRICT_KEYS)) return false
    return true
  }
  if (mode !== 'flex_required_duration') return false
  if (!hasExactKeys(value, FLEX_REQUIRED_KEYS)) return false
  if (!Number.isInteger(options.segmentCount) || options.segmentCount < 1) return false
  // OD-4556-3 / §3.3: flex only for one segment.
  if (options.segmentCount !== 1) return false
  if (
    !isPositiveIntegerAtMost(value.requiredMinutes, ATTENDANCE_FLEX_MAX_REQUIRED_MINUTES_V1)
  ) {
    return false
  }
  if (!isNonNegativeInteger(value.arrivalWindowBeforeMinutes)) return false
  if (!isNonNegativeInteger(value.arrivalWindowAfterMinutes)) return false
  const coreStart = value.coreStartTime
  const coreEnd = value.coreEndTime
  if (coreStart === null && coreEnd === null) return true
  if (typeof coreStart !== 'string' || typeof coreEnd !== 'string') return false
  const coreStartMin = parseHhMmToMinutes(coreStart)
  const coreEndMin = parseHhMmToMinutes(coreEnd)
  if (coreStartMin === null || coreEndMin === null) return false
  // v1 core hours are same-calendar-day and must have positive duration.
  if (coreEndMin <= coreStartMin) return false
  const segmentStartTime = options.segmentStartTime
  if (typeof segmentStartTime !== 'string') return false
  const segmentStartMin = parseHhMmToMinutes(segmentStartTime)
  if (segmentStartMin === null) return false
  return flexCoreHoursCoveredByAllClampedIntervalsV1({
    segmentStartMinutes: segmentStartMin,
    arrivalWindowBeforeMinutes: value.arrivalWindowBeforeMinutes as number,
    arrivalWindowAfterMinutes: value.arrivalWindowAfterMinutes as number,
    requiredMinutes: value.requiredMinutes as number,
    coreStartMinutes: coreStartMin,
    coreEndMinutes: coreEndMin,
  })
}

/** Normalize absent/unknown to strict. Rejects multi-segment flex and invalid core. */
export function normalizeAttendanceFlexPolicyV1(
  value: unknown,
  options: AttendanceFlexPolicyValidationOptionsV1,
): AttendanceFlexPolicyV1 | null {
  if (value === undefined || value === null) {
    return { mode: 'strict' }
  }
  if (!validateAttendanceFlexPolicyV1(value, options)) return null
  return value
}

export interface AttendanceFlexResolvedExpectationV1 {
  /** Arrival window start (epoch ms), inclusive. */
  arrivalWindowStartMs: number
  /** Arrival window end (epoch ms), inclusive for clamping. */
  arrivalWindowEndMs: number
  /** Resolved expected start after clamping the first valid arrival. */
  expectedStartMs: number
  /** expectedStartMs + requiredMinutes. */
  expectedEndMs: number
}

/**
 * Resolve flex expected start/end from the first valid arrival.
 *
 * `nominalStartMs` is the single segment start wall time on the work date.
 * `actualArrivalMs` is the matched check-in instant, or null when missing.
 * When arrival is missing, expected start falls back to the arrival-window open
 * (so missing-check-in reporting still has a stable expectation).
 *
 * Core hours are not re-evaluated here: authoring + frozen-context validation
 * already guarantee every allowed clamped interval covers optional core.
 */
export function resolveAttendanceFlexExpectationV1(input: {
  policy: AttendanceFlexPolicyRequiredDurationV1
  nominalStartMs: number
  actualArrivalMs: number | null
}): AttendanceFlexResolvedExpectationV1 {
  const beforeMs = input.policy.arrivalWindowBeforeMinutes * 60_000
  const afterMs = input.policy.arrivalWindowAfterMinutes * 60_000
  const arrivalWindowStartMs = input.nominalStartMs - beforeMs
  const arrivalWindowEndMs = input.nominalStartMs + afterMs
  const expectedStartMs =
    input.actualArrivalMs === null
      ? arrivalWindowStartMs
      : Math.min(
          arrivalWindowEndMs,
          Math.max(arrivalWindowStartMs, input.actualArrivalMs),
        )
  const expectedEndMs = expectedStartMs + input.policy.requiredMinutes * 60_000

  return {
    arrivalWindowStartMs,
    arrivalWindowEndMs,
    expectedStartMs,
    expectedEndMs,
  }
}
