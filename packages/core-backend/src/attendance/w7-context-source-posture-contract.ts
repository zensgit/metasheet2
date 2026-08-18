/**
 * W7 (#4556) — context-source cutover: CONTRACT DRAFT (W7-0 preparation).
 *
 * Status: RATIFIED contract, runtime HOLD. Corrected by W7-3 (#4556).
 *
 * This header previously read "PROPOSED / runtime HOLD. `OD-W7-0..10` are OPEN
 * owner decisions ... Nothing in the tree imports this module ... Deleting it
 * must leave every existing test green (design-lock red line W7-R9)". Both
 * halves are stale and are corrected here rather than left to mislead:
 *
 *  - The OD-W7-* entries this module depends on are RULED. #4556 comments
 *    5293034619 (owner-directed disclosed relay) + 5293478713 (owner
 *    first-person confirmation), ruling 2, set OD-W7-1..8 to option (a). See
 *    `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 *    §9 for the entries themselves.
 *  - This module HAS importers, and W7-R9's "deleting it leaves every test
 *    green" no longer holds. It was already false at W7-1a (#4905), which wired
 *    `w7-resolver/w7-context-source-posture-resolver.ts` onto it; W7-3 adds
 *    `w7-context-source-transition.ts` (the transition writer) and
 *    `w7-context-source-delivery.ts` (the producer-delivery declaration). The
 *    deletability red line applied to the CONTRACT-DRAFT slice; the ratified
 *    contract is now load-bearing, which is the intended end state, not a
 *    violation.
 *
 * RUNTIME HOLD IS UNCHANGED, and it does not rest on any of the above: no
 * production caller reaches the resolver or the writer, the posture table has
 * no row in production, `ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED` is unset, and
 * every promotion into the group arm is refused by the producer-delivery
 * declaration. Every production org resolves `off`.
 *
 * Basis: the design-lock's OD-W7-3 option (a) shape (§7) — now the RULED
 * option, not merely the recommended one.
 *
 * Governing sections: §4.2 (staging ladder + the two-part posture-read
 * note), §5.2/§5.3 (rollback pairs), §7 OD-W7-3, red line W7-R4.
 */

// ---------------------------------------------------------------------------
// OD-W7-3(a): a SEPARATE org-keyed context-source state machine, its own
// table — NOT the W4 five-state segment-calculation rollout machine
// (`legacy | shadow | eligible | authoritative | suspended`,
// `w4c3a-rollout-control.ts:201`). The W4 machine's meaning ("is segment
// calculation authoritative") stays untouched (design-lock §7 OD-W7-3
// consequence note).
// ---------------------------------------------------------------------------

export const ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1 = Object.freeze([
  'off',
  'group_shadow',
  'group_eligible',
  'group_authoritative',
  'suspended',
] as const)

export type AttendanceW7ContextSourcePostureStateV1 =
  (typeof ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1)[number]

/**
 * Closed legal-transition matrix (design-lock §4.2 "shadow -> compare ->
 * cutover" ladder, §5.2 "group_shadow -> off and group_eligible ->
 * group_shadow follow the legal-matrix pattern", §5.3 "group_authoritative
 * -> suspended ... resume requires ..."). Seven pairs, deliberately mirroring
 * the W4 machine's own seven-pair `LEGAL_TRANSITIONS` shape
 * (`w4c3a-rollout-control.ts:85-93`). Everything not listed is illegal.
 *
 * OD-W7-4 IS RULED (a) — corrected by W7-3 (#4556).
 *
 * This comment previously read "OD-W7-4 (open) asks whether a
 * `group_authoritative` org may fall back directly to a *legacy* source",
 * which was accurate when this module landed and is not accurate now.
 * Ruling 2 of the W7 ratification (#4556 comments 5293034619, owner-directed
 * disclosed relay, + 5293478713, owner first-person confirmation) sets
 * OD-W7-1..8 to option (a), and OD-W7-4(a) is: "No legacy fallback from
 * `group_authoritative`; suspend/resume only", justified as "history stays
 * explainable with one producer per work date".
 *
 * So these seven pairs ARE a closure claim, closed BY RULING rather than by
 * any author's discretion. Leaving the old wording would let a future reader
 * treat a ruled decision as still open and widen the table without an
 * amendment.
 *
 * THE AMENDMENT PATH, stated once, here. `off` is this machine's own
 * legacy-sourcing state (§4.2's ladder starts there), so an OD-W7-4(b) ruling
 * would most plausibly ADD an edge INTO `off` from `group_authoritative` or
 * `suspended`. That is an AMENDMENT to this constant plus the trigger backstop
 * in `zzzz20260816120000_w7_context_source_transition_writer.ts` — a one-place
 * change carrying its own OD — and never a silent edit to a landed test. This
 * is the same discipline ruling 11 applies to `flex_required_duration`: a
 * ratified OD is fixed, and new semantics need a new OD/amendment, not a
 * "supplement".
 *
 * The asymmetry OD-W7-4(a) names is asserted as a GRAPH PROPERTY over this
 * constant, not as a re-spelled list — see
 * `attendanceW7ContextSourceOneStepTargetsV1`
 * (`w7-context-source-transition.ts`): the one-step reachable set from
 * `group_authoritative` is exactly `{suspended}`, and from `suspended` exactly
 * `{group_authoritative}`.
 */
export const ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1: ReadonlyArray<
  readonly [AttendanceW7ContextSourcePostureStateV1, AttendanceW7ContextSourcePostureStateV1]
> = Object.freeze([
  ['off', 'group_shadow'],
  ['group_shadow', 'off'],
  ['group_shadow', 'group_eligible'],
  ['group_eligible', 'group_shadow'],
  ['group_eligible', 'group_authoritative'],
  ['group_authoritative', 'suspended'],
  ['suspended', 'group_authoritative'],
] as const)

export function isAttendanceW7ContextSourcePostureLegalTransitionV1(
  from: AttendanceW7ContextSourcePostureStateV1,
  to: AttendanceW7ContextSourcePostureStateV1,
): boolean {
  return ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1.some(
    ([legalFrom, legalTo]) => legalFrom === from && legalTo === to,
  )
}

// ---------------------------------------------------------------------------
// Two-part posture-READ contract (§4.2).
//
// "The rollout-control boundary alone does not resolve posture — this is a
// two-part condition, not a single source of truth." Cloned from the SHAPE
// of `resolveSegmentCalculationPosture`
// (`packages/core-backend/src/attendance/w4c0-identity.ts:454`; the
// allowlist check is at `:478-482` of that function) — NOT the write-side
// transition-boundary discipline alone (W7-R4). A carrier that treats "a
// legal transition landed" as sufficient to advertise a new posture, without
// an equivalent read-side allowlist/scope gate, reproduces the exact bug
// class the W4C-0 persisted-row-plus-allowlist design exists to prevent.
// ---------------------------------------------------------------------------

/**
 * The three already-resolved inputs a W7-1 read-side resolver combines. This
 * module does not read a database — fetching `persistedRow` (the
 * `attendance_calculation_context_source_state`-shaped row, or whatever
 * OD-W7-3's table is finally named) and evaluating `orgExactlyAllowlisted`
 * against a real exact-org/`scope='synthetic_staging'` allowlist are W7-1's
 * job, mirroring `isOrgExactlyAllowlisted` (`w4c0-identity.ts`, same file).
 */
export interface AttendanceW7ContextSourcePostureReadInputV1 {
  readonly persistedRow: {
    readonly state: AttendanceW7ContextSourcePostureStateV1
    readonly scope: 'synthetic_staging'
  } | null
  readonly implementationCapability: boolean
  readonly orgExactlyAllowlisted: boolean
}

/**
 * Pure decision function over already-resolved parts — the contract shape
 * only. Fail-closed rule, matching `w4c0-identity.ts:475-487` exactly:
 *
 *  - no persisted row -> `'off'`;
 *  - persisted `'suspended'` -> ALWAYS `'suspended'`, regardless of
 *    capability or allowlist (suspension can never be evaded through the
 *    environment — same asymmetry as the W4 machine's `suspended` handling);
 *  - any OTHER persisted state -> that state ONLY IF `implementationCapability`
 *    AND `orgExactlyAllowlisted` are BOTH true (row alone, or allowlist
 *    alone, each still resolve to `'off'` — this is the two-part condition);
 *  - otherwise -> `'off'`.
 *
 * The async DB-reading counterpart (fetch the row, evaluate the real
 * allowlist) is W7-1's job; this function is the fail-closed shape that
 * counterpart must implement.
 */
export function resolveAttendanceW7ContextSourcePostureFromPartsV1(
  input: AttendanceW7ContextSourcePostureReadInputV1,
): AttendanceW7ContextSourcePostureStateV1 {
  const { persistedRow, implementationCapability, orgExactlyAllowlisted } = input
  if (persistedRow === null) return 'off'
  if (persistedRow.state === 'suspended') return 'suspended'
  if (implementationCapability && orgExactlyAllowlisted) return persistedRow.state
  return 'off'
}
