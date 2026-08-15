/**
 * W7-1a-M (#4556) — the LIVE provenance value domains, widened.
 *
 * Ratified per #4556 comments 5293034619 + 5293478713 (执行序: `1a-M = 惰性
 * schema 扩宽切片`). W7-0 (`w7-read-side-provenance-amendment.ts`) RECORDED the
 * two new spellings without touching any live domain; this module is where
 * those recorded spellings enter the live closed sets, so that every exhaustive
 * consumer has a single symbol to widen against instead of ten inlined literal
 * pairs.
 *
 * Spelling provenance: the two new values are IMPORTED from the W7-0 record
 * rather than re-typed here, so the recorded value and the live value can never
 * drift apart.
 *
 * INERT: nothing in this slice EMITS `w4_group`. The domains ACCEPT it; the
 * producer seam is W7-1b. Every pre-existing value keeps its pre-existing
 * meaning, and no pre-existing input changes its outcome at any widened point.
 *
 * Semantic ruling (5293034619 §执行序): `w4_group` INHERITS `w4`'s non-NULL
 * calculation-pointer semantics. `legacy_untracked` remains the ONLY member
 * with a NULL calculation pointer — which is why the DB's coupled pointer
 * invariant `chk_ar_owner_pointer_pair`
 * (`(projection_owner = 'legacy_untracked') = (current_calculation_id IS NULL)`)
 * is CORRECT AS WRITTEN for the widened domain and is deliberately NOT edited
 * by this slice: it keeps forcing a non-NULL pointer for `w4_group` exactly as
 * it does for `w4`.
 */
import {
  ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,
  ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,
} from './w7-read-side-provenance-amendment'

// ---------------------------------------------------------------------------
// Family 1: `projectionOwner` / `attendance_records.projection_owner`.
// ---------------------------------------------------------------------------

/**
 * The widened closed set. Order is the DB CHECK's order (legacy first, then the
 * pointer-owning members) so the generated `IN (...)` list and this array stay
 * comparable by eye.
 */
export const ATTENDANCE_PROJECTION_OWNERS_V1 = [
  'legacy_untracked',
  'w4',
  ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,
] as const

export type AttendanceProjectionOwnerV1 = (typeof ATTENDANCE_PROJECTION_OWNERS_V1)[number]

/**
 * The members that own a calculation pointer, i.e. the members for which
 * `current_calculation_id` is NON-NULL. This is the single symbol every
 * `=== 'w4'`-shaped branch widens to; inlining the pair at each call site is
 * what the completeness test exists to prevent.
 */
export const ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1 = [
  'w4',
  ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,
] as const

export type AttendanceProjectionOwnerWithCalculationPointerV1 =
  (typeof ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1)[number]

/**
 * `'a', 'b'` — a ready-to-interpolate SQL literal list. Every member is a
 * compile-time constant from the array above (never user input), so this is a
 * single-source spelling aid, not a query builder.
 */
export const ATTENDANCE_PROJECTION_OWNERS_SQL_LIST_V1 = ATTENDANCE_PROJECTION_OWNERS_V1.map(
  (owner) => `'${owner}'`,
).join(', ')

/** Same, for the pointer-owning members only. */
export const ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1 =
  ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1.map((owner) => `'${owner}'`).join(', ')

export function isAttendanceProjectionOwnerV1(value: unknown): value is AttendanceProjectionOwnerV1 {
  return (ATTENDANCE_PROJECTION_OWNERS_V1 as readonly unknown[]).includes(value)
}

/**
 * `true` for exactly the members that carry a non-NULL calculation pointer.
 * Deliberately NOT `!== 'legacy_untracked'`: an unknown/novel value must answer
 * `false` here, so the widening does not open the domain generally.
 */
export function isAttendanceProjectionOwnerWithCalculationPointerV1(
  value: unknown,
): value is AttendanceProjectionOwnerWithCalculationPointerV1 {
  return (ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1 as readonly unknown[]).includes(value)
}

// ---------------------------------------------------------------------------
// Family 2: trace `source.kind`.
// ---------------------------------------------------------------------------

/**
 * The widened trace source-kind closed set. The live union in
 * `../services/AttendanceDecisionTrace.ts` is expressed against this array, and
 * `apps/web`'s independent copy (`ATTENDANCE_TRACE_SOURCE_KINDS`) is held to the
 * same membership by the W7-1a-M completeness test — the web bundle cannot
 * import backend source, so the two lists are kept equal by test, not by build.
 */
export const ATTENDANCE_TRACE_SOURCE_KINDS_V1 = [
  'record',
  'snapshot',
  'rule_live',
  'ledger',
  'audit',
  'policy_gate',
  ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,
] as const

export type AttendanceTraceSourceKindV1 = (typeof ATTENDANCE_TRACE_SOURCE_KINDS_V1)[number]

export function isAttendanceTraceSourceKindV1(value: unknown): value is AttendanceTraceSourceKindV1 {
  return (ATTENDANCE_TRACE_SOURCE_KINDS_V1 as readonly unknown[]).includes(value)
}
