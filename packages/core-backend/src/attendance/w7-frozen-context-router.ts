/**
 * W7-1b (#4556) — V2 DISCRIMINANT ROUTING for the frozen attendance context.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (merge `0287b250b33fe4c7ea98b880360af74fc08a5ebf`, blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A ROUTER AND NOT A WIDENING OF `validateFrozenContextShape`
 * ---------------------------------------------------------------------------
 * `validateFrozenContextShape` is a TYPE PREDICATE:
 * `context is FrozenAttendanceContextV1`. Making it return `true` for a V2
 * object makes every consumer believe it holds a V1 — a lie the compiler then
 * helps propagate, and `core-backend` compiles with `strict: false`, so the
 * propagation is quiet. So that function stays BYTE-UNCHANGED (which also buys
 * the v1 arm's byte-neutrality for free), and this module adds:
 *
 *   - `validateFrozenAttendanceContextV2ShapeV1` — the exact-14-key v2 rule;
 *   - `routeFrozenAttendanceContextV1` — a discriminated result, so every
 *     consumer makes its own accept/reject decision DELIBERATELY.
 *
 * The per-site verdict is the thing worth pinning, and a blanket widening is
 * exactly what would erase it.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ GUARD ORDER IS LOAD-BEARING — W7-0 P3-1, the carry-forward
 * ---------------------------------------------------------------------------
 * The W7-0 draft (`w7-frozen-context-v2-contract.ts`) runs its guard 1,
 * `hasExactKeysV1(context, V2_CONTEXT_KEYS)`, BEFORE the `schemaVersion`
 * discriminant. **Copying that order into production would strip W5 flex from
 * every existing v1 context.**
 *
 * The live v1 rule is a WINDOW, not an exact set:
 * `allowed = new Set([...CONTEXT_KEYS, 'flexPolicy'])` with
 * `own.length ∈ [14, 15]`, and `flexPolicy` is read downstream by the
 * calculator. The 14 KEY NAMES are identical between v1 and v2; the
 * discriminants are `schemaVersion` (1 vs 2), `selector` and
 * `calculationGroupId`. So an exact-14 test applied first rejects every
 * flex-carrying v1 context — silently turning every flex org's calculation
 * into `input_schema_invalid`.
 *
 *   READ `schemaVersion` FIRST, THEN ROUTE.
 *   The 14-exact-key rule applies to the V2 BRANCH ONLY.
 *   The v1 branch keeps its [N, N+1] window verbatim, by DELEGATING to
 *   `validateFrozenContextShape` rather than re-implementing it.
 *
 * `T-V1` pins this: a `flexPolicy`-carrying v1 context must still validate AND
 * still behave identically end-to-end. Porting the draft's order reds it.
 *
 * ---------------------------------------------------------------------------
 * `v2-legacy` IS ACCEPT-ONLY
 * ---------------------------------------------------------------------------
 * `{schemaVersion: 2, selector: 'legacy', calculationGroupId: null}` is a valid
 * member of the routing domain, but NOTHING IN W7-1b MINTS IT: op(i) hard-codes
 * `selector: 'group_effective'` and the legacy builder hard-codes
 * `schemaVersion: 1`. It must be ADMITTED by the validator and asserted INERT by
 * a no-emitter sweep (`T-V3`). Admitting a shape with no producer is deliberate
 * forward-compatibility, and saying so is what stops it from later being read as
 * evidence that something emits it.
 */
import type { FrozenAttendanceContextV1 } from './w4c0-write-boundary-types'
import type { FrozenAttendanceContextV2 } from './w7-resolver/w7-group-effective-context-issuance'

/** The v2 key set. EXACT — no `flexPolicy` member, deliberately: a v2 context
 *  carrying a flex policy is rejected (`T-V2`). Group-effective policy has no
 *  flex arm in W7-1b, and admitting the key "just in case" would create a shape
 *  with no producer, no consumer and no rejection test. */
const V2_CONTEXT_KEYS: readonly string[] = Object.freeze([
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
])

const V2_SEGMENT_KEYS: readonly string[] = Object.freeze([
  'index',
  'startTime',
  'endTime',
  'startDayOffset',
  'endDayOffset',
  'lateGraceMinutes',
  'earlyLeaveGraceMinutes',
])

function isPlainObjectV1(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyStringV1(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeIntegerV1(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Exact own-key closure, accessor-free. Getters are rejected because a
 *  validated context is later serialized and hashed, and a getter can return a
 *  different value on the second read than the one the validator saw. */
function hasExactOwnKeysV1(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObjectV1(value)) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== keys.length) return false
  for (const key of own) {
    if (!keys.includes(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.get || descriptor.set) return false
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false
  }
  return true
}

function isValidV2SegmentV1(segment: unknown): boolean {
  if (!hasExactOwnKeysV1(segment, V2_SEGMENT_KEYS)) return false
  const seg = segment as Record<string, unknown>
  if (!isNonNegativeIntegerV1(seg.index)) return false
  if (typeof seg.startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(seg.startTime)) return false
  if (typeof seg.endTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(seg.endTime)) return false
  if (seg.startDayOffset !== 0) return false
  if (seg.endDayOffset !== 0 && seg.endDayOffset !== 1) return false
  if (!isNonNegativeIntegerV1(seg.lateGraceMinutes)) return false
  if (!isNonNegativeIntegerV1(seg.earlyLeaveGraceMinutes)) return false
  return true
}

/**
 * The V2 shape rule. Ported from the W7-0 draft's guards 1/2/3/5/6 PLUS the
 * field-level checks the draft deliberately left to the live validator (the
 * draft's own header says it does not re-implement them) — segments, timezone,
 * thresholds. A draft-faithful port WITHOUT those would admit a
 * discriminant-shaped stub with no segments into the calculator.
 *
 * Every named W7-R5 negative maps to exactly one early return, so each can be
 * neutered individually (`T-V4`).
 */
export function validateFrozenAttendanceContextV2ShapeV1(
  context: unknown,
): context is FrozenAttendanceContextV2 {
  // v2 is EXACT-14. This is safe here, and only here, because the router has
  // already read `schemaVersion` — applying it before the discriminant is the
  // W7-0 P3-1 defect this module exists to avoid.
  if (!hasExactOwnKeysV1(context, V2_CONTEXT_KEYS)) return false
  const ctx = context as Record<string, unknown>

  if (ctx.schemaVersion !== 2) return false
  if (ctx.selector !== 'legacy' && ctx.selector !== 'group_effective') return false
  // W7-R5: `calculationGroupId` must be null for the legacy selector...
  if (ctx.selector === 'legacy' && ctx.calculationGroupId !== null) return false
  // ...and a non-empty string for the group selector.
  if (ctx.selector === 'group_effective' && !isNonEmptyStringV1(ctx.calculationGroupId)) return false

  if (!isNonEmptyStringV1(ctx.orgId) || !isNonEmptyStringV1(ctx.userId)) return false
  if (typeof ctx.workDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.workDate)) return false
  if (!isNonEmptyStringV1(ctx.timezone) || !isNonEmptyStringV1(ctx.shiftId)) return false
  if (typeof ctx.isWorkday !== 'boolean') return false
  if (ctx.holidayKind !== null && !isNonEmptyStringV1(ctx.holidayKind)) return false
  // Matches v1's own `>= 1` rule byte-for-byte. W7-1a's facts resolver
  // fail-closes below 1 precisely so this can be an equality of rules rather
  // than a second, subtly different one.
  if (!isNonNegativeIntegerV1(ctx.roundingMinutes) || (ctx.roundingMinutes as number) < 1) return false
  if (!isNonNegativeIntegerV1(ctx.severeLateThresholdMinutes)) return false
  if (!isNonNegativeIntegerV1(ctx.absenceLateThresholdMinutes)) return false
  if (!Array.isArray(ctx.segments) || ctx.segments.length < 1 || ctx.segments.length > 3) return false
  for (let i = 0; i < ctx.segments.length; i += 1) {
    if (!isValidV2SegmentV1(ctx.segments[i])) return false
    if ((ctx.segments[i] as Record<string, unknown>).index !== i) return false
  }
  return true
}

/**
 * PRODUCTION CONSUMERS, recorded rather than implied (this note originally
 * read "no production consumer yet"; W7-4 changed that).
 *
 * Five of the six widened X-sites use the BOOLEAN
 * `isSupportedFrozenAttendanceContextV1`, because their per-site verdicts are
 * "accept either" — there is nothing for them to discriminate on. X6
 * (`parseTraceProjection`, `AttendanceW4CalculationDetail.ts`) consumes the
 * DISCRIMINATED router since W7-4 (#4556 read-side labeling): its acceptance
 * verdict is unchanged (the boolean IS the router's `!== 'invalid'`), but it
 * additionally threads the validated context's `selector` out to the
 * decision-trace basis builder, which needs the typed discriminated branches
 * rather than a cast.
 *
 * The `v2-legacy` note above still applies to itself: saying which form each
 * consumer uses is what stops a later reader from assuming the wrong one is
 * load-bearing.
 */
export type RoutedFrozenAttendanceContextV1 =
  | { kind: 'v1'; context: FrozenAttendanceContextV1 }
  | { kind: 'v2'; context: FrozenAttendanceContextV2 }
  | { kind: 'invalid'; context: null }

/**
 * The discriminant read, isolated. `1` / `2` / `null` for anything else.
 *
 * Split out so THIS module never imports `w4c1-segment-calculator`: the v1
 * window rule lives there, so importing it here and being imported by it would
 * be a cycle. The composed router therefore lives in the calculator
 * (`routeFrozenAttendanceContextV1`) and delegates the v2 half here — one
 * direction only, calculator -> router.
 */
export function readFrozenAttendanceContextSchemaVersionV1(context: unknown): 1 | 2 | null {
  if (!isPlainObjectV1(context)) return null
  const schemaVersion = (context as Record<string, unknown>).schemaVersion
  if (schemaVersion === 1) return 1
  if (schemaVersion === 2) return 2
  return null
}
