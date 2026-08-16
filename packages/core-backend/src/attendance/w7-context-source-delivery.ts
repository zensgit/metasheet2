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
 * RE-DERIVED AT THE POST-W7-2 MERGE (catch-up head). Everything below was
 * written pre-1b/pre-W7-2, when nothing in the tree produced a group-derived
 * calculation. That is no longer the head this ships on, and the declaration
 * was RE-DERIVED STATE BY STATE against the merged tree — announced by this
 * module's own correspondence guard rather than discovered in production.
 *
 * The authority for each value is the SEAM's three closed, exported arrays
 * (`w7-resolver/w7-frozen-context-issuance-seam.ts`), which partition the state
 * enumeration exactly (its own T-A4 leg proves the partition; this module does
 * not restate that proof, it consumes it):
 *
 *  - `group_shadow` / `group_eligible` -> DELIVERED. W7-2's dual-run compare
 *    rung produces a group-derived UNSERVED comparison context for both
 *    (`ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1`). The legacy arm stays the
 *    SERVED producer byte for byte (W7-R3) — which is what these two states
 *    mean; a producer exists, so the gate must not pretend otherwise.
 *    CARRIED, NOT SETTLED: whether the comparison keeps running in
 *    `group_eligible` is the seam's own [OWNER-CONFIRM B-3], still OPEN. A
 *    ruling that freezes comparison there shrinks that array by one and this
 *    declaration must be re-derived with it — which the correspondence guard
 *    forces, because it reads the array rather than a copy of it.
 *  - `group_authoritative` -> DELIVERED. The seam SERVES the group arm for it
 *    (`ATTENDANCE_W7_GROUP_ARM_STATES_V1`, and that array is deliberately
 *    `['group_authoritative']` only).
 *  - `suspended` -> DELIVERED, and this is a behaviour, not a producer: the
 *    seam routes it to a distinct BLOCKED arm
 *    (`ATTENDANCE_W7_BLOCKED_ARM_STATES_V1`), which is the ratified
 *    OD-W7-4(a) reading (`writePosture: 'blocked'`, never a legacy fallback).
 *    It is excluded from the group-producer set below, so this value gates
 *    nothing; it is recorded so the enumeration is honest end to end.
 *  - `off` -> DELIVERED. The ladder's own legacy-sourcing state, served by the
 *    pre-existing legacy arm.
 *
 * WHAT THIS MEANS FOR THE GATE, stated plainly because it is the opposite of
 * what this file said before: the producer gate no longer blocks any promotion
 * at this head. It is not thereby decorative — it is the mechanism that will
 * refuse a SIXTH state, or any state whose producer is later withdrawn, and its
 * refusal path is still exercised by the delivery-override legs. What changed is
 * reality, not the mechanism.
 *
 * NEVER FLIP A KEY BY HAND IN EITHER DIRECTION. The correspondence test in
 * `__tests__/w7-context-source-transition.test.ts` fails that change: each value
 * must equal what the SEAM's exported arrays actually say. It used to compare
 * against a text scan for the state literal, which was a weak proxy — it caught
 * the W7-2 merge (correctly), but it also cannot distinguish a module that
 * SERVES a state from one that merely mentions the word, and it is meaningless
 * for common words like `off` and `suspended`. It now reads the seam's arrays.
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
/**
 * `kind` exists because "delivered" is NOT one thing, and flattening it to a
 * boolean is the distinction a tree-presence scan cannot make:
 *
 *   - `served`              the group arm REPLACES the legacy producer
 *                           (`group_authoritative` only);
 *   - `unserved_comparison` the group arm additionally produces an UNSERVED
 *                           comparison context while the legacy arm stays the
 *                           served producer byte for byte (W7-R3) —
 *                           `group_shadow` / `group_eligible`;
 *   - `blocked`             no producer at all, by ruling (`suspended`);
 *   - `legacy`             the ladder's own legacy-sourcing state (`off`).
 *
 * The producer GATE treats all four as "a producer exists" — which is correct,
 * because each is a defined, implemented behaviour — but a reader of this
 * record can still tell a cutover from a dual-run, and a future ruling that
 * turns an unserved comparison into a served arm is a visible `kind` change
 * rather than an invisible one.
 */
type DeliveryKindV1 = 'served' | 'unserved_comparison' | 'blocked' | 'legacy'

type DeliveryDeclarationV1 = Readonly<{
  delivered: boolean
  kind: DeliveryKindV1
  reason: string
}>

/**
 * Total over the state enumeration (TypeScript enforces it) and REASONED: a
 * bare boolean records the verdict but not the evidence, and this record has
 * now been wrong once because reality moved underneath it. Each entry names the
 * artifact that makes it true, so the next merge that changes reality has to
 * argue with a citation rather than with a flipped bit.
 */
const DECLARED_DELIVERED_STATE_PRODUCERS: Readonly<
  Record<AttendanceW7ContextSourcePostureStateV1, DeliveryDeclarationV1>
> = Object.freeze({
  off: Object.freeze({
    delivered: true,
    kind: 'legacy' as const,
    reason: "the ladder's own legacy-sourcing state; the seam's legacy arm serves it",
  }),
  group_shadow: Object.freeze({
    delivered: true,
    kind: 'unserved_comparison' as const,
    reason: 'W7-2 dual-run compare rung — ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1',
  }),
  group_eligible: Object.freeze({
    delivered: true,
    kind: 'unserved_comparison' as const,
    reason:
      'W7-2 dual-run compare rung — ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1 (seam B-3 OPEN: a ruling that freezes comparison here re-derives this)',
  }),
  group_authoritative: Object.freeze({
    delivered: true,
    kind: 'served' as const,
    reason: 'W7-1b seam serves the group arm — ATTENDANCE_W7_GROUP_ARM_STATES_V1',
  }),
  suspended: Object.freeze({
    delivered: true,
    kind: 'blocked' as const,
    reason:
      'W7-1b seam routes it to the distinct BLOCKED arm — ATTENDANCE_W7_BLOCKED_ARM_STATES_V1 (a behaviour, not a producer; excluded from the group-producer set, so it gates nothing)',
  }),
})

/** Exported for the correspondence guard, which asserts these against the seam. */
export const ATTENDANCE_W7_CONTEXT_SOURCE_DELIVERY_DECLARATIONS_V1 =
  DECLARED_DELIVERED_STATE_PRODUCERS

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

/**
 * RE-DERIVED at the post-W7-2 merge: both are DELIVERED. W7-2 shipped
 * `readAttendanceW7CompareWindowStatusV1` (`w7-compare-window-status.ts`),
 * which computes both counters for an org over a work-date window, and the W7-3
 * boundary now calls it for real on the compare pair instead of reporting
 * `count: null`. The null-count state was always declared temporary — "until
 * W7-2 lands" — and W7-2 has landed.
 */
const DECLARED_DELIVERED_COMPARE_EVIDENCE: Readonly<
  Record<AttendanceW7ContextSourceCompareEvidenceProbeV1, boolean>
> = Object.freeze({
  W7_CRITICAL_SHADOW_DIFF: true,
  W7_OFF_ROSTER_DIFF: true,
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
  return DECLARED_DELIVERED_STATE_PRODUCERS[state]?.delivered === true
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
