/**
 * W7 (#4556) OD-W7-2(a) — frozen-context v2 evolution: CONTRACT DRAFT
 * (W7-0 preparation).
 *
 * Status: PROPOSED / runtime HOLD. `OD-W7-0..10` are OPEN owner decisions —
 * see
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §7 OD-W7-2, §9. Nothing in the tree imports this module: the LIVE
 * calculator validator (`packages/core-backend/src/attendance/
 * w4c1-segment-calculator.ts`'s `validateFrozenContextShape`) is untouched
 * by this PR and still accepts only v1-legacy. Deleting this file and its
 * test leaves every existing test green (design-lock red line W7-R9); v1's
 * golden/fingerprint bytes do not move (`w4c1-fingerprint-golden.test.ts`,
 * `GOLDEN_STORAGE_FINGERPRINT`, verified unchanged in the PR body).
 *
 * Basis: built on the design-lock's recommended OD-W7-2 option (a) shape.
 * OD-W7-2 is OPEN — ratification pending, not assumed by this file.
 *
 * Scope note: this module previews ONLY the OD-W7-2 discriminant contract
 * (`schemaVersion` / `selector` / `calculationGroupId` correspondence) plus
 * the exact-key closure red line W7-R5 names ("v2 ... validates exact-key
 * fail-closed"). It does not re-implement segment/timezone/threshold
 * business validation — that remains owned by the live
 * `w4c1-segment-calculator.ts` validator and stays out of scope here so this
 * contract cannot silently drift from, or duplicate-and-diverge from, the
 * source of truth. W7-1 wires the real discriminant switch into that live
 * validator; this file is the shape it must implement.
 *
 * Also deliberately out of scope: the optional W5 `flexPolicy` key
 * (`FrozenAttendanceFlexPolicyV1`, `w4c0-write-boundary-types.ts:113-122`).
 * Whether v2 composes with W5 flex is not decided by OD-W7-2 or by this
 * file; `V2_CONTEXT_KEYS` below is an EXACT 14-key set with no optional
 * member, so this draft validator rejects a `flexPolicy`-bearing v2 object
 * today. That is a scope boundary of this contract, not a claim that W7-1
 * must keep it that way.
 */

// ---------------------------------------------------------------------------
// OD-W7-2(a) v2 type. `calculationGroupId` non-null iff
// `selector === 'group_effective'`, null iff `selector === 'legacy'`. v1
// stays a SEPARATE, untouched type (`FrozenAttendanceContextV1`,
// `w4c0-write-boundary-types.ts:124-152`) — v2 is not a widening of v1's
// mandatory key domains (see OD-W7-2's own rejection of option (b) for why
// that distinction matters).
// ---------------------------------------------------------------------------

export type FrozenAttendanceContextSourceSelectorV2 = 'legacy' | 'group_effective'

export interface FrozenAttendanceContextSegmentV2 {
  index: 0 | 1 | 2
  startTime: string
  endTime: string
  startDayOffset: 0
  endDayOffset: 0 | 1
  lateGraceMinutes: number
  earlyLeaveGraceMinutes: number
}

export interface FrozenAttendanceContextV2 {
  schemaVersion: 2
  selector: FrozenAttendanceContextSourceSelectorV2
  orgId: string
  userId: string
  workDate: string
  timezone: string
  shiftId: string
  isWorkday: boolean
  holidayKind: string | null
  /** Non-null iff `selector === 'group_effective'`; null iff `'legacy'`. */
  calculationGroupId: string | null
  roundingMinutes: number
  severeLateThresholdMinutes: number
  absenceLateThresholdMinutes: number
  segments: FrozenAttendanceContextSegmentV2[]
}

const V2_CONTEXT_KEYS = [
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

const V2_SEGMENT_KEYS = [
  'index',
  'startTime',
  'endTime',
  'startDayOffset',
  'endDayOffset',
  'lateGraceMinutes',
  'earlyLeaveGraceMinutes',
] as const

function isPlainObjectLikeV1(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeysV1(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObjectLikeV1(value)) return false
  const own = Object.getOwnPropertyNames(value)
  if (own.length !== keys.length) return false
  const allowed = new Set(keys)
  return own.every((key) => allowed.has(key))
}

function isNonEmptyStringV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeIntegerV1(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function validateSegmentV1(segment: unknown, index: number): boolean {
  if (!hasExactKeysV1(segment, V2_SEGMENT_KEYS)) return false
  const seg = segment as Record<string, unknown>
  if (seg.index !== index) return false
  if (!isNonEmptyStringV1(seg.startTime) || !isNonEmptyStringV1(seg.endTime)) return false
  if (seg.startDayOffset !== 0) return false
  if (seg.endDayOffset !== 0 && seg.endDayOffset !== 1) return false
  if (!isNonNegativeIntegerV1(seg.lateGraceMinutes) || !isNonNegativeIntegerV1(seg.earlyLeaveGraceMinutes)) {
    return false
  }
  return true
}

/**
 * Contract-preview validator: `{v1-legacy, v2-legacy, v2-group_effective}`
 * accepted; everything else fail-closed. Guard order below is deliberately
 * ONE early-return per named W7-R5 negative, so each design-lock-named
 * reject category maps to a guard. Mutation-tested individually in the PR
 * body (each guard neutered, tests re-run, restored) — with one named
 * exception: guard 1's "extra key" leg and null/undefined-input crash
 * protection are load-bearing on guard 1 alone, but its "missing key" leg is
 * independently caught by the field-level checks below too (deleting
 * `timezone` still fails `isNonEmptyStringV1(ctx.timezone)` even with guard
 * 1 disabled) — genuine defense-in-depth, not a gap, but not "guard 1 alone"
 * either; recorded honestly rather than as a uniform claim:
 *
 *  1. exact-key closure (own keys === `V2_CONTEXT_KEYS`, no extra/missing);
 *  2. `schemaVersion` unknown (must be `1` or `2`);
 *  3. `selector` unknown (must be `'legacy'` or `'group_effective'`);
 *  4. v2-shape-with-v1-tag (`schemaVersion === 1` but `selector !== 'legacy'`
 *     or `calculationGroupId !== null`);
 *  5. `calculationGroupId` non-null while `selector === 'legacy'`
 *     (schemaVersion-2 branch — schemaVersion-1 is already covered by guard 4);
 *  6. `calculationGroupId` null/non-string while `selector === 'group_effective'`.
 *
 * NOT called from any production path (see file header). W7-1 wires this
 * shape into the live `validateFrozenContextShape`.
 */
export function validateFrozenAttendanceContextV7DraftV1(context: unknown): boolean {
  // Guard 1: exact-key closure.
  if (!hasExactKeysV1(context, V2_CONTEXT_KEYS)) return false

  const ctx = context as Record<string, unknown>

  // Guard 2: schemaVersion unknown.
  if (ctx.schemaVersion !== 1 && ctx.schemaVersion !== 2) return false

  // Guard 3: selector unknown.
  if (ctx.selector !== 'legacy' && ctx.selector !== 'group_effective') return false

  // Guard 4: v2-shape-with-v1-tag.
  if (ctx.schemaVersion === 1 && (ctx.selector !== 'legacy' || ctx.calculationGroupId !== null)) {
    return false
  }

  // Guard 5: calculationGroupId must be null when selector is legacy (schemaVersion 2 branch;
  // schemaVersion 1 + legacy + non-null calculationGroupId is already rejected by guard 4).
  if (ctx.schemaVersion === 2 && ctx.selector === 'legacy' && ctx.calculationGroupId !== null) {
    return false
  }

  // Guard 6: calculationGroupId must be a non-empty string when selector is group_effective.
  if (
    ctx.schemaVersion === 2 &&
    ctx.selector === 'group_effective' &&
    !isNonEmptyStringV1(ctx.calculationGroupId)
  ) {
    return false
  }

  // Remaining field-level sanity (out of OD-W7-2's discriminant scope but needed so a
  // "valid" fixture is a plausible context, not just a discriminant-shaped stub).
  if (!isNonEmptyStringV1(ctx.orgId) || !isNonEmptyStringV1(ctx.userId)) return false
  if (!isNonEmptyStringV1(ctx.workDate)) return false
  if (!isNonEmptyStringV1(ctx.timezone) || !isNonEmptyStringV1(ctx.shiftId)) return false
  if (typeof ctx.isWorkday !== 'boolean') return false
  if (ctx.holidayKind !== null && !isNonEmptyStringV1(ctx.holidayKind)) return false
  if (!isNonNegativeIntegerV1(ctx.roundingMinutes) || (ctx.roundingMinutes as number) < 1) return false
  if (!isNonNegativeIntegerV1(ctx.severeLateThresholdMinutes)) return false
  if (!isNonNegativeIntegerV1(ctx.absenceLateThresholdMinutes)) return false
  if (!Array.isArray(ctx.segments) || ctx.segments.length < 1 || ctx.segments.length > 3) return false
  for (let i = 0; i < ctx.segments.length; i += 1) {
    if (!validateSegmentV1(ctx.segments[i], i)) return false
  }

  return true
}
