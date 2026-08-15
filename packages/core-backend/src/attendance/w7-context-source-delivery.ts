/**
 * W7-3 (#4556) — context-source PRODUCER DELIVERY declaration.
 *
 * A mechanical clone of `w4c2-authoritative-delivery.ts` (the Gate D
 * declaration, `:48-123`), applied to the W7 context-source posture ladder.
 *
 * WHAT PROBLEM IT SOLVES. The W7 transition writer can move an org into
 * `group_shadow` / `group_eligible` / `group_authoritative` long before anything
 * in the tree actually PRODUCES a group-derived calculation for that state. An
 * org promoted into a state whose producer is not wired would sit in a posture
 * the runtime cannot honour — the same defect class the owner's W4 Gate D
 * existed to close, in a second machine. So the promotion is refused BY THE
 * MACHINE, from a closed declaration, rather than by a reviewer's memory of
 * which slice has landed.
 *
 * WHAT IS UNDELIVERED AT THIS HEAD, and why each is honest rather than
 * pessimistic:
 *
 *  - `group_shadow` / `group_eligible`: W7-2 (the shadow-compare slice) has not
 *    landed. Nothing produces a group-derived shadow calculation, and nothing
 *    produces the compare-window artifacts the `group_shadow -> group_eligible`
 *    exit criteria count (see `ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1`
 *    below).
 *  - `group_authoritative`: W7-1b (the frozen-context issuance seam) has not
 *    landed. No seam mints a group context for that state.
 *  - `suspended`: W7-1b again. `suspended`'s runtime behaviour (design-lock §5.3 /
 *    OD-W7-4(a)) is a seam-side fail-close, and the seam does not exist here.
 *    It is declared undelivered for completeness and honesty — but NOTE that it
 *    is NOT what keeps `suspended` unreachable, because the producer gate is
 *    deliberately not applied to de-escalation targets (see
 *    `ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1`). `suspended` is
 *    unreachable at this head for a stronger structural reason: it is reachable
 *    ONLY from `group_authoritative` (OD-W7-4(a) closes every other edge into
 *    it), and `group_authoritative` is itself unreachable because its own
 *    producer is undelivered. The gate makes the whole group arm of the ladder
 *    unreachable, and `suspended` falls out of that.
 *  - `off`: delivered. `off` IS this machine's legacy-sourcing state — it is
 *    what every production org resolves to today, produced by the pre-existing
 *    legacy arm. Declaring it undelivered would be false and would also wedge
 *    every §5.2 rollback pair.
 *
 * NEVER FLIP A KEY TO `true` AS A STANDALONE CHANGE "to unblock rollout" — the
 * correspondence test in `__tests__/w7-context-source-transition.test.ts` exists
 * precisely to fail that change: each `true` must correspond to the actual
 * presence of the producing slice's module in the tree.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not probe, does not import, and has no
 * runtime dependency on any producer. It is a LEAF (its only import is the
 * state enumeration it is keyed by) for the same reason the W4C-2 declaration
 * is one: the separately-gated ops CLI never runs plugin `activate`, so a
 * runtime-injected or dynamically-computed registry here would silently
 * disagree between that process and the server process. A `const` cannot.
 *
 * Values-free discipline: this module exposes only booleans/counts keyed by
 * closed enums — never an org id, never a caller value.
 */
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
  type AttendanceW7ContextSourcePostureStateV1,
} from './w7-context-source-posture-contract'

/**
 * The states whose posture requires a W7 GROUP-derived producer to exist.
 *
 * DERIVED from the state enumeration by excluding the two states that are
 * exits from the group arm rather than positions inside it, never hand-listed:
 * `off` (the legacy-sourcing state) and `suspended` (the parked state). A sixth
 * state added to the enumeration is therefore producer-bearing BY DEFAULT,
 * which is the fail-closed direction — a new ladder rung is assumed to need a
 * producer until someone argues otherwise.
 *
 * WHY THE TWO EXITS ARE EXCLUDED, stated rather than assumed: this mirrors the
 * W4 Gate D keying decision verbatim (`w4c3a-rollout-control.ts:1555-1566`),
 * which is keyed on `targetState === 'authoritative'` and deliberately NOT on
 * the row's `comparisonWritePosture`, because the latter is also
 * `'authoritative'` for the `authoritative -> suspended` de-escalation row and
 * keying on it "would block the only escape hatch out of a stuck org". Applying
 * a producer gate to `-> off` or `-> suspended` would make an org that somehow
 * reached a group state unable to leave it — a delivery declaration turning
 * into a trap.
 */
export const ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1: readonly AttendanceW7ContextSourcePostureStateV1[] =
  Object.freeze(
    ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1.filter(
      (state) => state !== 'off' && state !== 'suspended',
    ),
  )

/**
 * The shipped state-producer declaration. Typed as a total `Record` over the
 * state enumeration deliberately: adding a sixth state to
 * `ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1` makes this object a type
 * error until a reviewer explicitly writes a value for it, and at RUNTIME a
 * missing key reads as `undefined !== true`, i.e. undelivered. Both directions
 * fail closed.
 */
const DECLARED_DELIVERED_STATE_PRODUCERS: Readonly<
  Record<AttendanceW7ContextSourcePostureStateV1, boolean>
> = Object.freeze({
  off: true,
  group_shadow: false,
  group_eligible: false,
  group_authoritative: false,
  suspended: false,
})

/**
 * The two compare-window exit criteria that gate `group_shadow -> group_eligible`
 * (design-lock §4.2's "shadow -> compare -> cutover" ladder). Both are fed by
 * W7-2's shadow-compare artifacts:
 *
 *  - `W7_CRITICAL_SHADOW_DIFF`: the count of W7 shadow rows whose diff code is
 *    in the critical class (`work_date_mismatch`, `context_mismatch`,
 *    `input_mismatch`, `review_required`);
 *  - `W7_OFF_ROSTER_DIFF`: the count of W7 shadow differences not matched by the
 *    W7 expected-differences probe.
 *
 * They ship DECLARED-UNDELIVERED rather than silently absent. A predicate that
 * simply were not in the code would let a future reader believe the compare
 * window was evaluated; a predicate that is present, enumerated, and declared
 * undelivered makes the promotion it gates REFUSE with a product code until
 * W7-2 delivers it.
 */
export const ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1 = Object.freeze([
  'W7_CRITICAL_SHADOW_DIFF',
  'W7_OFF_ROSTER_DIFF',
] as const)

export type AttendanceW7ContextSourceCompareEvidenceProbeV1 =
  (typeof ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1)[number]

const DECLARED_DELIVERED_COMPARE_EVIDENCE: Readonly<
  Record<AttendanceW7ContextSourceCompareEvidenceProbeV1, boolean>
> = Object.freeze({
  W7_CRITICAL_SHADOW_DIFF: false,
  W7_OFF_ROSTER_DIFF: false,
})

// ---------------------------------------------------------------------------
// Test seam. Not imported by production wiring — the same idiom as
// `__setAttendanceW4C2AuthoritativeDeliveryOverrideForTests`
// (`w4c2-authoritative-delivery.ts:93-100`): a module-level override, `null` by
// default, whose setter production code paths never call. Partial: a test may
// override one key and let the rest fall through to the shipped declaration.
//
// This seam is what makes the ladder's forward pairs testable at a head where
// their producers are undelivered. Without it the only provable legs would be
// the refusals, and "the writer can perform a legal promotion at all" would go
// unproven — a battery that only ever asserts refusals cannot tell a correct
// gate from a writer that refuses everything.
// ---------------------------------------------------------------------------
let stateProducerOverrideForTests: Partial<
  Record<AttendanceW7ContextSourcePostureStateV1, boolean>
> | null = null

let compareEvidenceOverrideForTests: Partial<
  Record<AttendanceW7ContextSourceCompareEvidenceProbeV1, boolean>
> | null = null

/** Test-only. Not imported by production wiring. Pass `null` to restore the shipped declaration. */
export function __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests(
  override: Partial<Record<AttendanceW7ContextSourcePostureStateV1, boolean>> | null,
): void {
  stateProducerOverrideForTests = override
}

/** Test-only. Not imported by production wiring. Pass `null` to restore the shipped declaration. */
export function __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests(
  override: Partial<Record<AttendanceW7ContextSourceCompareEvidenceProbeV1, boolean>> | null,
): void {
  compareEvidenceOverrideForTests = override
}

function resolvedStateProducerDelivered(state: AttendanceW7ContextSourcePostureStateV1): boolean {
  if (
    stateProducerOverrideForTests !== null &&
    Object.prototype.hasOwnProperty.call(stateProducerOverrideForTests, state)
  ) {
    return stateProducerOverrideForTests[state] === true
  }
  return DECLARED_DELIVERED_STATE_PRODUCERS[state] === true
}

function resolvedCompareEvidenceDelivered(
  probe: AttendanceW7ContextSourceCompareEvidenceProbeV1,
): boolean {
  if (
    compareEvidenceOverrideForTests !== null &&
    Object.prototype.hasOwnProperty.call(compareEvidenceOverrideForTests, probe)
  ) {
    return compareEvidenceOverrideForTests[probe] === true
  }
  return DECLARED_DELIVERED_COMPARE_EVIDENCE[probe] === true
}

export function isAttendanceW7ContextSourceStateProducerDeliveredV1(
  state: AttendanceW7ContextSourcePostureStateV1,
): boolean {
  return resolvedStateProducerDelivered(state)
}

/**
 * Mechanical over the state enumeration, never a hand-maintained count. Counts
 * only the GROUP-PRODUCER-BEARING states: `off` and `suspended` are exits, not
 * rungs, and including them would report a permanent non-zero debt that no
 * slice will ever clear.
 */
export function attendanceW7ContextSourceUndeliveredStateProducerCountV1(): number {
  return ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1.filter(
    (state) => !resolvedStateProducerDelivered(state),
  ).length
}

export function isAttendanceW7ContextSourceCompareEvidenceDeliveredV1(
  probe: AttendanceW7ContextSourceCompareEvidenceProbeV1,
): boolean {
  return resolvedCompareEvidenceDelivered(probe)
}

/** Mechanical over the probe enumeration, never a hand-maintained count. */
export function attendanceW7ContextSourceUndeliveredCompareEvidenceCountV1(): number {
  return ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1.filter(
    (probe) => !resolvedCompareEvidenceDelivered(probe),
  ).length
}
