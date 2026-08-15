/**
 * W7-2 (#4556) — the W7 expected-differences roster and its fail-closed probe
 * (design-lock §4.2: "A W7 expected-differences roster (same pattern as
 * `ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1`, fail-closed probe)
 * enumerates every anticipated legacy-vs-group divergence before soak;
 * anything off-roster is a real diff.").
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (blob `f7acf1da3be791bb2d77dbe58ca1078055828521`), §4.2 + §4.3.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS ESCAPES THE ENUMERATION TRAP
 * ---------------------------------------------------------------------------
 * A roster is inherently an enumeration. It escapes the trap the same way the
 * P16 DML inventory does: it is the CLAIM side over a DERIVED domain, never
 * the scan domain itself.
 *
 *  1. The domain is `ATTENDANCE_W4_SHADOW_DIFF_CODES_V1`, IMPORTED — never
 *     re-spelled. Four explicitly enumerated buckets partition it, WITHOUT a
 *     default bucket: CRITICAL (the §3.4 export), ROSTER_ELIGIBLE, ALWAYS_REAL
 *     and NON_DIFF. A 13th code added to the domain belongs to none of them
 *     and reds the completeness leg BY CONSTRUCTION — an "everything else"
 *     bucket would swallow it silently, which is the enumeration trap wearing
 *     a completeness leg's clothes.
 *
 *     (The commissioning brief sketched THREE buckets; the imported domain
 *     contains `equal`, which is not a diff at all and belongs to none of the
 *     three, so a fourth explicitly enumerated NON_DIFF bucket is required for
 *     the union to equal the domain without a default. Recorded as a brief
 *     deviation, not a design change: the no-default-bucket property is
 *     preserved.)
 *
 *  2. FAIL-CLOSED BY DEFAULT, which is what makes non-convergence SAFE: an
 *     unenumerated divergence is a REAL diff, so it blocks `group_eligible`
 *     entry (`W7_OFF_ROSTER_DIFF`, w7-compare-window-status.ts) instead of
 *     slipping through. The roster only ever NARROWS what blocks, and each
 *     narrowing is a reviewed change with its own owner authority. A
 *     malformed probe THROWS — never a silent `false`.
 *
 *  3. THE ROSTER DRIVES THE PREDICATE — declaratively. The W4 precedent's
 *     weakness is inherited knowledge: on main the W4 roster array has zero
 *     production readers; the runtime consults only a hand-written 7-way
 *     conjunction, coupled to the array by review alone. Here every entry
 *     carries a COMPLETE declarative `expectedProbe` (every key of the probe
 *     shape, no partials, no matcher functions — an opaque matcher would make
 *     the roster code again), and the predicate is exactly "deep-equals the
 *     `expectedProbe` of some roster entry". The accepted-probe set is DERIVED
 *     from the roster; nothing else is accepted.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROSTER ARRAY IS EMPTY AT THIS HEAD — [OWNER-CONFIRM B-1, OPEN]
 * ---------------------------------------------------------------------------
 * Roster CONTENT requires owner ratification, entry by entry: the W4
 * precedent's single entry carries an owner-authored authority string
 * (`#4556 W4C-1 ratified discretion #6`). No owner-authored artifact
 * ratifies any anticipated legacy-vs-group divergence today:
 *
 *  - rulings 5, 6 and 11 (#4556 comment 5293034619) name FAIL-CLOSE classes
 *    (`scheduled_shift` groups, W1-membership/FSER inconsistency,
 *    `flex_required_duration`), and a fail-close is a RECORDED PER-TARGET
 *    OUTCOME, not a roster entry — softening one into an "expected
 *    difference" is exactly what the ratification's fail-close rulings chose
 *    against;
 *  - every other candidate divergence is an EMPIRICAL output of a compare
 *    window that has not run.
 *
 * So the mechanism ships with ZERO entries, which is the fail-closed reading:
 * every non-`equal` divergence is a real diff until the owner ratifies an
 * entry by its own reviewed change (W8 plan §4 exit 6 — "roster amended by
 * its own reviewed change"). Do not add entries here without an
 * owner-authored `ratifiedBy` artifact; an entry whose `ratifiedBy` names no
 * owner-authored artifact is a self-authorized roster and is itself the
 * defect.
 *
 * Values-free: the roster and predicate operate on closed enum values only —
 * no user, punch, request or org value enters this module.
 */
import {
  ATTENDANCE_W4_SHADOW_DIFF_CODES_V1,
  ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1,
  type AttendanceW4ShadowDiffCodeV1,
} from './w4c2-shadow-expected-differences'
import { ATTENDANCE_DAILY_STATUSES_V1 } from './w4c1-segment-calculator'

export class AttendanceW7ShadowExpectedDifferenceError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW7ShadowExpectedDifferenceError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW7ShadowExpectedDifferenceError(code)
}

// ---------------------------------------------------------------------------
// The four-bucket partition of the IMPORTED diff-code domain (no default
// bucket — see the header).
// ---------------------------------------------------------------------------

/**
 * Codes a ratified expected difference MAY present as. Explicitly enumerated;
 * disjoint from the §3.4 critical set BY TEST, not by construction — the
 * design-lock's "zero critical diffs" `group_eligible` criterion is
 * unconditional, so a roster entry presenting as a critical class would
 * soften a ratified gate and is rejected by `parseRosterEntry` below.
 */
export const ATTENDANCE_W7_ROSTER_ELIGIBLE_SHADOW_DIFF_CODES_V1: readonly AttendanceW4ShadowDiffCodeV1[] =
  Object.freeze([
    'expected_break_exclusion',
    'status_changed',
    'work_minutes_mismatch',
    'late_minutes_mismatch',
    'early_leave_minutes_mismatch',
    'missing_boundary_mismatch',
  ] as const)

/**
 * Codes that are ALWAYS a real diff — never rosterable. `legacy_uncomparable`
 * means the comparison itself could not be made, and "we could not compare"
 * must never be narrowed into "expected".
 */
export const ATTENDANCE_W7_ALWAYS_REAL_SHADOW_DIFF_CODES_V1: readonly AttendanceW4ShadowDiffCodeV1[] =
  Object.freeze(['legacy_uncomparable'] as const)

/**
 * The one non-diff member of the domain. Enumerated explicitly so the
 * partition needs no default bucket.
 */
export const ATTENDANCE_W7_NON_DIFF_SHADOW_CODES_V1: readonly AttendanceW4ShadowDiffCodeV1[] =
  Object.freeze(['equal'] as const)

/**
 * The partition check, exported so the completeness leg can also run it
 * against a MUTATED local domain copy (the 13th-member control). Throws on
 * any violation — pairwise overlap, an unbucketed domain member, or a bucket
 * member outside the domain.
 */
export function assertAttendanceW7ShadowDiffCodePartitionV1(
  domain: readonly string[] = ATTENDANCE_W4_SHADOW_DIFF_CODES_V1,
): void {
  const code = 'W7_SHADOW_DIFF_CODE_PARTITION_INVALID'
  const buckets: readonly (readonly string[])[] = [
    ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1,
    ATTENDANCE_W7_ROSTER_ELIGIBLE_SHADOW_DIFF_CODES_V1,
    ATTENDANCE_W7_ALWAYS_REAL_SHADOW_DIFF_CODES_V1,
    ATTENDANCE_W7_NON_DIFF_SHADOW_CODES_V1,
  ]
  const seen = new Set<string>()
  for (const bucket of buckets) {
    for (const member of bucket) {
      if (seen.has(member)) fail(code) // pairwise-disjointness violated
      if (!domain.includes(member)) fail(code) // bucket member outside the domain
      seen.add(member)
    }
  }
  for (const member of domain) {
    if (!seen.has(member)) fail(code) // a domain member no bucket claims (13th-member red)
  }
}
// Fail-closed at module load: a domain/bucket drift is unrepresentable, not
// merely untested. All inputs are static frozen arrays, so this is
// deterministic and environment-free.
assertAttendanceW7ShadowDiffCodePartitionV1()

// ---------------------------------------------------------------------------
// The probe shape.
// ---------------------------------------------------------------------------

/** The two entrypoints the W7 compare recording writes (the boundary's live
 *  and scheduled producers — the same coverage as the W4 shadow ledger's own
 *  recording surface). */
export const ATTENDANCE_W7_COMPARE_ENTRYPOINTS_V1 = Object.freeze(['live', 'scheduled'] as const)
export type AttendanceW7CompareEntrypointV1 = (typeof ATTENDANCE_W7_COMPARE_ENTRYPOINTS_V1)[number]

/** The persisted `projected_status` column's domain: `chk_arc_projected_status`
 *  admits seven statuses — `'off'` is a projection-layer status that never
 *  persists — derived from the imported daily-status domain rather than
 *  re-spelled. */
export const ATTENDANCE_W7_GROUP_PROJECTED_STATUSES_V1: readonly string[] = Object.freeze(
  ATTENDANCE_DAILY_STATUSES_V1.filter((status) => status !== 'off'),
)

const GROUP_OUTCOMES = Object.freeze(['completed', 'review_required'] as const)

/**
 * Every field is derivable from a persisted W7 group shadow row alone
 * (`shadow_diff_code`, `entrypoint`, `outcome`, `projected_status`) — the W4
 * probe's write-time-only fields (legacy minutes, correction flags) are NOT
 * reproducible at read time and are deliberately absent. Closed enums and
 * null only; deep-equality over this shape is exact flat equality.
 */
export interface AttendanceW7ShadowDifferenceProbeV1 {
  readonly shadowDiffCode: AttendanceW4ShadowDiffCodeV1
  readonly entrypoint: AttendanceW7CompareEntrypointV1
  readonly groupOutcome: (typeof GROUP_OUTCOMES)[number]
  /** The group-side persisted daily status; null exactly for review rows. */
  readonly groupProjectedStatus: string | null
}

const PROBE_KEYS = Object.freeze([
  'shadowDiffCode',
  'entrypoint',
  'groupOutcome',
  'groupProjectedStatus',
] as const)

const PROBE_INVALID = 'W7_SHADOW_DIFF_PROBE_INVALID'

function parseProbe(input: unknown): AttendanceW7ShadowDifferenceProbeV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(PROBE_INVALID)
  const obj = input as Record<string, unknown>
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== PROBE_KEYS.length) fail(PROBE_INVALID)
  for (const key of PROBE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(PROBE_INVALID)
  }
  if (!(ATTENDANCE_W4_SHADOW_DIFF_CODES_V1 as readonly string[]).includes(obj.shadowDiffCode as string)) {
    fail(PROBE_INVALID)
  }
  if (!(ATTENDANCE_W7_COMPARE_ENTRYPOINTS_V1 as readonly string[]).includes(obj.entrypoint as string)) {
    fail(PROBE_INVALID)
  }
  if (!(GROUP_OUTCOMES as readonly string[]).includes(obj.groupOutcome as string)) fail(PROBE_INVALID)
  if (
    obj.groupProjectedStatus !== null &&
    !ATTENDANCE_W7_GROUP_PROJECTED_STATUSES_V1.includes(obj.groupProjectedStatus as string)
  ) {
    fail(PROBE_INVALID)
  }
  // The persisted review shape: projected_status is null iff review_required
  // (`chk_arc_review_shape` / `chk_arc_completed_shape`); a probe violating
  // that pairing describes no persistable row and fails closed.
  if ((obj.groupOutcome === 'review_required') !== (obj.groupProjectedStatus === null)) {
    fail(PROBE_INVALID)
  }
  return obj as unknown as AttendanceW7ShadowDifferenceProbeV1
}

/** Exported for the read-side counter, which must build row-derived probes
 *  through the SAME fail-closed parse the predicate uses. */
export function parseAttendanceW7ShadowDifferenceProbeV1(
  input: unknown,
): AttendanceW7ShadowDifferenceProbeV1 {
  return parseProbe(input)
}

// ---------------------------------------------------------------------------
// The roster.
// ---------------------------------------------------------------------------

export interface AttendanceW7ExpectedShadowDifferenceEntryV1 {
  readonly id: string
  /** The diff code this expected difference presents as. Must be
   *  roster-eligible and must equal `expectedProbe.shadowDiffCode`. */
  readonly shadowDiffCode: AttendanceW4ShadowDiffCodeV1
  /** Owner-authored ratifying artifact (issue comment / lock / amendment). */
  readonly ratifiedBy: string
  /** COMPLETE declarative probe — every key, no partials. The predicate is
   *  deep-equality against this object; a single-field departure fails. */
  readonly expectedProbe: AttendanceW7ShadowDifferenceProbeV1
}

/**
 * EMPTY at this head — [OWNER-CONFIRM B-1, OPEN]; see the module header. The
 * mechanism (partition, probe, derivation, predicate) is W7-2's; the
 * MEMBERSHIP is the owner's, entry by entry.
 */
export const ATTENDANCE_W7_EXPECTED_SHADOW_DIFFERENCES_V1: readonly AttendanceW7ExpectedShadowDifferenceEntryV1[] =
  Object.freeze([])

const ENTRY_INVALID = 'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID'

/** Matches an owner-authored artifact reference: an issue/PR/comment number
 *  (`#4556 …`) or a docs artifact filename (`….md`). A `ratifiedBy` naming
 *  this module itself is self-authorization and is rejected. */
function isPlausibleAuthorityArtifact(ratifiedBy: unknown): boolean {
  if (typeof ratifiedBy !== 'string' || ratifiedBy.trim().length === 0) return false
  if (ratifiedBy.includes('w7-shadow-expected-differences')) return false
  return /#\d+/.test(ratifiedBy) || /\.md\b/.test(ratifiedBy)
}

function parseRosterEntry(entry: AttendanceW7ExpectedShadowDifferenceEntryV1): AttendanceW7ShadowDifferenceProbeV1 {
  if (typeof entry.id !== 'string' || entry.id.trim().length === 0) fail(ENTRY_INVALID)
  if (!isPlausibleAuthorityArtifact(entry.ratifiedBy)) fail(ENTRY_INVALID)
  const probe = parseProbe(entry.expectedProbe)
  if (entry.shadowDiffCode !== probe.shadowDiffCode) fail(ENTRY_INVALID)
  // Rosterable codes only: critical, always-real and non-diff codes can never
  // be narrowed into "expected" (design-lock §4.2's unconditional criteria).
  if (!(ATTENDANCE_W7_ROSTER_ELIGIBLE_SHADOW_DIFF_CODES_V1 as readonly string[]).includes(probe.shadowDiffCode)) {
    fail(ENTRY_INVALID)
  }
  return probe
}

/**
 * The accepted-probe set, DERIVED from the roster. Exported so the coupling
 * leg can assert BOTH directions (every roster entry accepted; nothing
 * accepted that is not a roster entry) against the same derivation the
 * predicate uses — and so the derivation itself can be exercised against a
 * synthetic roster while the production array is empty.
 */
export function deriveAcceptedAttendanceW7ShadowProbesV1(
  roster: readonly AttendanceW7ExpectedShadowDifferenceEntryV1[] = ATTENDANCE_W7_EXPECTED_SHADOW_DIFFERENCES_V1,
): readonly AttendanceW7ShadowDifferenceProbeV1[] {
  const ids = new Set<string>()
  const probes: AttendanceW7ShadowDifferenceProbeV1[] = []
  for (const entry of roster) {
    const probe = parseRosterEntry(entry)
    if (ids.has(entry.id)) fail(ENTRY_INVALID)
    ids.add(entry.id)
    probes.push(Object.freeze({ ...probe }))
  }
  return Object.freeze(probes)
}

function probesDeepEqual(
  a: AttendanceW7ShadowDifferenceProbeV1,
  b: AttendanceW7ShadowDifferenceProbeV1,
): boolean {
  return PROBE_KEYS.every((key) => a[key] === b[key])
}

/**
 * True exactly when the (fail-closed-parsed) probe deep-equals the
 * `expectedProbe` of some roster entry. With the roster empty, EVERY
 * well-formed divergence probe returns false — off-roster, i.e. a REAL diff.
 * Malformed input throws; it never returns false-negative "unexpected" or
 * false-positive "expected".
 */
export function isExpectedAttendanceW7ShadowDifferenceV1(
  input: unknown,
  roster: readonly AttendanceW7ExpectedShadowDifferenceEntryV1[] = ATTENDANCE_W7_EXPECTED_SHADOW_DIFFERENCES_V1,
): boolean {
  const probe = parseProbe(input)
  const accepted = deriveAcceptedAttendanceW7ShadowProbesV1(roster)
  return accepted.some((candidate) => probesDeepEqual(candidate, probe))
}
