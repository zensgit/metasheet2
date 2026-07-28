/**
 * W4C-1 (#4556) — pure frozen in/out merge policy (lock section 4.4).
 *
 * "The exact current `applyAttendanceInOutMergePolicy` branch behavior is
 * lifted into a pure frozen policy before calculation. W4 changes no
 * `internalWinsOnIn`/`externalWinsOnOut` meaning; it removes only the second
 * mutable post-upsert pass."
 *
 * This module is that lift, branch for branch, from
 * `plugins/plugin-attendance/index.cjs` (`applyAttendanceInOutMergePolicy`,
 * ~L19315): the DB read is replaced by caller-supplied frozen event rows and
 * the post-decision upsert is replaced by a pure decision value. The legacy
 * asymmetry is preserved deliberately:
 *
 * - `internalWinsOnIn` protects the first-in side with the earliest INTERNAL
 *   check-in when both internal and outdoor check-ins exist;
 * - `externalWinsOnOut` protects the last-out side with the latest OUTDOOR
 *   check-out when both internal and outdoor check-outs exist;
 * - a pre-existing record-only boundary (import/correction value not
 *   represented by any event on that side) is part of that side's candidate
 *   set whenever the side's policy is enabled ("protected record" branch);
 * - if neither flag is set, or the decision lands on the same instants, the
 *   record is unchanged (`changed: false`).
 *
 * Pure module: no DB, no Date.now, values-free closed error codes.
 */

export class AttendanceW4MergePolicyError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4MergePolicyError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4MergePolicyError(code)
}

/** Matches `OUTDOOR_APPROVAL_EVENT_SOURCE` in the legacy plugin. */
export const ATTENDANCE_OUTDOOR_APPROVAL_EVENT_SOURCE_V1 = 'outdoor_approval'

export interface AttendanceFrozenMergeEventV1 {
  readonly eventType: 'check_in' | 'check_out'
  readonly source: string
  readonly occurredAtMs: number
}

export interface AttendanceFrozenMergePolicyInputV1 {
  readonly internalWinsOnIn: boolean
  readonly externalWinsOnOut: boolean
  /** The daily record's current first-in/last-out instants (ms), if any. */
  readonly recordFirstInAtMs: number | null
  readonly recordLastOutAtMs: number | null
  /**
   * The pre-merge protected record values (legacy `protectedRecord` argument):
   * boundaries that may exist only on the record (import/correction) and not
   * as events. Null when the caller has no protected record.
   */
  readonly protectedRecordFirstInAtMs: number | null
  readonly protectedRecordLastOutAtMs: number | null
  /** Every check_in/check_out event for (org,user,workDate), any order. */
  readonly events: readonly AttendanceFrozenMergeEventV1[]
}

export interface AttendanceFrozenMergePolicyDecisionV1 {
  readonly changed: boolean
  readonly nextFirstInAtMs: number | null
  readonly nextLastOutAtMs: number | null
}

function requireNullableFiniteMs(value: unknown, code: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code)
  return value
}

function pickEarliestMs(events: readonly AttendanceFrozenMergeEventV1[]): number | null {
  let selected: number | null = null
  for (const event of events) {
    if (selected === null || event.occurredAtMs < selected) selected = event.occurredAtMs
  }
  return selected
}

function pickLatestMs(events: readonly AttendanceFrozenMergeEventV1[]): number | null {
  let selected: number | null = null
  for (const event of events) {
    if (selected === null || event.occurredAtMs > selected) selected = event.occurredAtMs
  }
  return selected
}

/** Legacy `protectedRecordTime`: a record-only boundary not represented by any event on that side. */
function protectedRecordMs(
  previousValueMs: number | null,
  eventsForSide: readonly AttendanceFrozenMergeEventV1[],
): number | null {
  if (previousValueMs === null) return null
  const representedByEvent = eventsForSide.some((event) => event.occurredAtMs === previousValueMs)
  return representedByEvent ? null : previousValueMs
}

/**
 * Exact pure lift of the legacy merge-policy decision. Returns the next
 * first-in/last-out instants plus whether they differ from the record's
 * current values. Callers apply the decision; this function never writes.
 */
export function applyAttendanceInOutMergePolicyPureV1(
  input: AttendanceFrozenMergePolicyInputV1,
): AttendanceFrozenMergePolicyDecisionV1 {
  const code = 'W4C1_MERGE_POLICY_INPUT_INVALID'
  if (typeof input !== 'object' || input === null) fail(code)
  if (typeof input.internalWinsOnIn !== 'boolean' || typeof input.externalWinsOnOut !== 'boolean') {
    fail(code)
  }
  const recordFirstInAtMs = requireNullableFiniteMs(input.recordFirstInAtMs, code)
  const recordLastOutAtMs = requireNullableFiniteMs(input.recordLastOutAtMs, code)
  const protectedFirstSource = requireNullableFiniteMs(input.protectedRecordFirstInAtMs, code)
  const protectedLastSource = requireNullableFiniteMs(input.protectedRecordLastOutAtMs, code)
  if (!Array.isArray(input.events)) fail(code)
  for (const event of input.events) {
    if (typeof event !== 'object' || event === null) fail(code)
    if (event.eventType !== 'check_in' && event.eventType !== 'check_out') fail(code)
    if (typeof event.source !== 'string' || event.source.length === 0) fail(code)
    if (typeof event.occurredAtMs !== 'number' || !Number.isFinite(event.occurredAtMs)) fail(code)
  }

  const unchanged: AttendanceFrozenMergePolicyDecisionV1 = {
    changed: false,
    nextFirstInAtMs: recordFirstInAtMs,
    nextLastOutAtMs: recordLastOutAtMs,
  }

  const internalWinsOnIn = input.internalWinsOnIn === true
  const externalWinsOnOut = input.externalWinsOnOut === true
  if (!internalWinsOnIn && !externalWinsOnOut) return unchanged

  const checkIns = input.events.filter((event) => event.eventType === 'check_in')
  const checkOuts = input.events.filter((event) => event.eventType === 'check_out')
  const internalIns = checkIns.filter(
    (event) => event.source !== ATTENDANCE_OUTDOOR_APPROVAL_EVENT_SOURCE_V1,
  )
  const outdoorIns = checkIns.filter(
    (event) => event.source === ATTENDANCE_OUTDOOR_APPROVAL_EVENT_SOURCE_V1,
  )
  const internalOuts = checkOuts.filter(
    (event) => event.source !== ATTENDANCE_OUTDOOR_APPROVAL_EVENT_SOURCE_V1,
  )
  const outdoorOuts = checkOuts.filter(
    (event) => event.source === ATTENDANCE_OUTDOOR_APPROVAL_EVENT_SOURCE_V1,
  )

  let nextFirstInAtMs = recordFirstInAtMs
  let nextLastOutAtMs = recordLastOutAtMs

  const protectedFirstInAtMs = internalWinsOnIn
    ? protectedRecordMs(protectedFirstSource, checkIns)
    : null
  const protectedLastOutAtMs = externalWinsOnOut
    ? protectedRecordMs(protectedLastSource, checkOuts)
    : null

  if (
    protectedFirstInAtMs !== null ||
    (internalWinsOnIn && internalIns.length > 0 && outdoorIns.length > 0)
  ) {
    nextFirstInAtMs = protectedFirstInAtMs ?? pickEarliestMs(internalIns) ?? nextFirstInAtMs
  }
  if (
    protectedLastOutAtMs !== null ||
    (externalWinsOnOut && internalOuts.length > 0 && outdoorOuts.length > 0)
  ) {
    nextLastOutAtMs = protectedLastOutAtMs ?? pickLatestMs(outdoorOuts) ?? nextLastOutAtMs
  }

  if (nextFirstInAtMs === recordFirstInAtMs && nextLastOutAtMs === recordLastOutAtMs) {
    return unchanged
  }
  return { changed: true, nextFirstInAtMs, nextLastOutAtMs }
}
