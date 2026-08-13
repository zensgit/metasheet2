/**
 * W7 (#4556) — context-source cutover: CONTRACT DRAFT (W7-0 preparation).
 *
 * Status: PROPOSED / runtime HOLD. `OD-W7-0..10` are OPEN owner decisions —
 * see
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §9. Nothing in the tree imports this module. Deleting it must leave every
 * existing test green (design-lock red line W7-R9). The runtime resolver,
 * the transition writer, and the route land at W7-1, not here.
 *
 * Basis: built on the design-lock's recommended OD-W7-3 option (a) shape
 * (§7). OD-W7-3, like every OD-W7-* entry, is OPEN — ratification pending,
 * not assumed by this file.
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
 * OD-W7-4 (open) asks whether a `group_authoritative` org may fall back
 * directly to a *legacy* source. `off` is this machine's own
 * legacy-sourcing state (§4.2's ladder starts there), so a (b) ruling on
 * OD-W7-4 would most plausibly ADD an edge INTO `off` from
 * `group_authoritative` or `suspended` — this table is not a closure claim
 * over that still-open decision. It records only the seven pairs §4.2/§5.2/
 * §5.3 fix as stated today; an OD-W7-4 (b) ruling is an amendment to this
 * table, not something this table already anticipates.
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
