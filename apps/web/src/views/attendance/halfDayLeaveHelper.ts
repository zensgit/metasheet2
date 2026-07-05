// Half-day leave helper (frontend-only, display-only design-lock, 2026-07-05): pure helpers for
// the employee leave-request quick-fill affordance. AttendanceView.vue's inline request form
// wires these into three buttons above the duration triplet (`requestedInAt` / `requestedOutAt` /
// `minutes`) -- "Full day" / "Morning half-day" / "Afternoon half-day" -- plus the minutes ->
// day-equivalent conversion hint under the minutes input.
//
// See docs/development/attendance-halfday-leave-helper-design-lock-20260705.md (PR #3605).
//
// Hard boundaries carried over from the lock (§3):
//   - Zero wire/backend change. Inputs are exactly what the employee overview already has: the
//     effective shift window (`GET /api/attendance/rules/me` -> `runtimeRule.workStartTime` /
//     `workEndTime`) and the selected leave type's `defaultMinutesPerDay` (`GET
//     /api/attendance/leave-types`). Nothing here reads or fabricates an org-level
//     `standardDayMinutes` -- that field isn't on the employee wire (deferred, §5).
//   - One-time seed, not a binding: callers apply a result once (on button click) into the free
//     `requestForm` fields; nothing here re-applies on every render, so a user's subsequent manual
//     edit is never clobbered.
//   - Half-day split = the shift window's time midpoint. This does NOT subtract a lunch break --
//     break structure is not on the `rules/me` wire (deferred, §5) -- and it does NOT model
//     overnight shifts (`workEndTime <= workStartTime`): both are treated as "no valid window",
//     which hides the quick-fill affordance rather than guessing a policy that isn't backed by
//     wire data or the §1 audit.
//   - Non-integer roundings (an odd-minute shift window's midpoint, or an odd `defaultMinutesPerDay`
//     halved) round to the nearest whole minute (`Math.round`, i.e. round-half-up for the
//     non-negative values in play here) so they can populate a `datetime-local` input / a whole-
//     minute `minutes` field.

/** The three quick-fill affordances named in the design-lock §2 (G1). */
export type AttendanceLeaveQuickFillKind = 'full_day' | 'morning_half' | 'afternoon_half'

/** Shape of the piece of `/api/attendance/rules/me`'s `runtimeRule` this helper needs. */
export interface AttendanceLeaveQuickFillShiftWindow {
  workStartTime?: string | null
  workEndTime?: string | null
}

/** Shape of the piece of an `/api/attendance/leave-types` item this helper needs. */
export interface AttendanceLeaveQuickFillLeaveType {
  defaultMinutesPerDay?: number | null
}

export interface AttendanceLeaveQuickFillResult {
  /** `datetime-local`-formatted (`YYYY-MM-DDTHH:mm`), ready to assign to `requestForm.requestedInAt`. */
  requestedInAt: string
  /** `datetime-local`-formatted (`YYYY-MM-DDTHH:mm`), ready to assign to `requestForm.requestedOutAt`. */
  requestedOutAt: string
  /** Whole-minute value, ready to assign (as a string) to `requestForm.minutes`. */
  minutes: number
  /** The pre-rounding value `minutes` was derived from. Equal to `minutes` when no rounding
   * occurred; a caller can compare the two to decide whether to disclose a rounding note. */
  exactMinutes: number
}

const WORK_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_TEXT_PATTERN = /^(\d{1,2}):(\d{2})$/

function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(TIME_TEXT_PATTERN)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** `minutesFromMidnight` is trusted to already be within [0, 1439] -- guaranteed by every caller
 * in this module, since it is always derived from `resolveShiftWindowMinutes`'s validated
 * start/end (each already clamped to a real 00:00-23:59 time) or their rounded midpoint. */
function minutesToDateTimeLocal(workDate: string, minutesFromMidnight: number): string {
  const hour = Math.floor(minutesFromMidnight / 60)
  const minute = minutesFromMidnight % 60
  return `${workDate}T${pad2(hour)}:${pad2(minute)}`
}

function resolveShiftWindowMinutes(
  shiftWindow: AttendanceLeaveQuickFillShiftWindow | null | undefined,
): { startMinutes: number; endMinutes: number } | null {
  const startMinutes = parseTimeToMinutes(shiftWindow?.workStartTime)
  const endMinutes = parseTimeToMinutes(shiftWindow?.workEndTime)
  if (startMinutes === null || endMinutes === null) return null
  // A same-instant or reversed window (e.g. an overnight shift) has no single-day midpoint under
  // this display-only helper's model -- deferred (design-lock §5), never guessed.
  if (endMinutes <= startMinutes) return null
  return { startMinutes, endMinutes }
}

/** The single source of truth for the G1 button-visibility gate: "shift window missing -> hide
 * the buttons, don't guess a default" (design-lock §2). Callers should gate the whole quick-fill
 * affordance on this rather than re-deriving their own window validity check. */
export function hasValidLeaveQuickFillShiftWindow(
  shiftWindow: AttendanceLeaveQuickFillShiftWindow | null | undefined,
): boolean {
  return resolveShiftWindowMinutes(shiftWindow) !== null
}

/**
 * Build the prefill values for one of the three leave quick-fill buttons.
 *
 * - `full_day`: the whole shift window; `minutes` = the leave type's `defaultMinutesPerDay`.
 * - `morning_half` / `afternoon_half`: the shift window split at its time midpoint (rounded to the
 *   nearest minute); `minutes` = half of `defaultMinutesPerDay` (also rounded to the nearest
 *   minute -- see `exactMinutes` for the pre-rounding value).
 *
 * Returns `null` when `workDate` isn't a plain `YYYY-MM-DD` date, the shift window is missing or
 * degenerate (see `hasValidLeaveQuickFillShiftWindow`), or the leave type's `defaultMinutesPerDay`
 * isn't a finite non-negative number -- i.e. whenever there isn't enough real data to prefill
 * from, this returns nothing rather than guessing.
 */
export function buildLeaveQuickFill(
  kind: AttendanceLeaveQuickFillKind,
  workDate: string,
  shiftWindow: AttendanceLeaveQuickFillShiftWindow | null | undefined,
  leaveType: AttendanceLeaveQuickFillLeaveType | null | undefined,
): AttendanceLeaveQuickFillResult | null {
  if (typeof workDate !== 'string' || !WORK_DATE_PATTERN.test(workDate)) return null

  const window = resolveShiftWindowMinutes(shiftWindow)
  if (!window) return null

  const defaultMinutesPerDay = Number(leaveType?.defaultMinutesPerDay)
  if (!Number.isFinite(defaultMinutesPerDay) || defaultMinutesPerDay < 0) return null

  const { startMinutes, endMinutes } = window

  if (kind === 'full_day') {
    return {
      requestedInAt: minutesToDateTimeLocal(workDate, startMinutes),
      requestedOutAt: minutesToDateTimeLocal(workDate, endMinutes),
      minutes: Math.round(defaultMinutesPerDay),
      exactMinutes: defaultMinutesPerDay,
    }
  }

  // morning_half / afternoon_half share the same halved-minutes arithmetic; only which side of
  // the midpoint each occupies differs.
  const midpointMinutes = Math.round((startMinutes + endMinutes) / 2)
  const exactHalfMinutes = defaultMinutesPerDay / 2
  const halfMinutes = Math.round(exactHalfMinutes)

  if (kind === 'morning_half') {
    return {
      requestedInAt: minutesToDateTimeLocal(workDate, startMinutes),
      requestedOutAt: minutesToDateTimeLocal(workDate, midpointMinutes),
      minutes: halfMinutes,
      exactMinutes: exactHalfMinutes,
    }
  }

  return {
    requestedInAt: minutesToDateTimeLocal(workDate, midpointMinutes),
    requestedOutAt: minutesToDateTimeLocal(workDate, endMinutes),
    minutes: halfMinutes,
    exactMinutes: exactHalfMinutes,
  }
}

/**
 * G2's "≈ N day(s)" conversion: `minutes / defaultMinutesPerDay`, rounded to one decimal place.
 * Returns `null` (hint hidden) when `minutesInput` is empty/non-numeric/negative, or when
 * `defaultMinutesPerDay` isn't a finite positive number (avoids a divide-by-zero / NaN hint).
 */
export function computeLeaveMinutesDaysEquivalent(
  minutesInput: string | number | null | undefined,
  defaultMinutesPerDay: number | null | undefined,
): number | null {
  const perDay = Number(defaultMinutesPerDay)
  if (!Number.isFinite(perDay) || perDay <= 0) return null

  const minutesText = typeof minutesInput === 'number' ? String(minutesInput) : String(minutesInput ?? '').trim()
  if (minutesText.length === 0) return null

  const minutes = Number(minutesText)
  if (!Number.isFinite(minutes) || minutes < 0) return null

  return Math.round((minutes / perDay) * 10) / 10
}
