/**
 * W7-1b (#4556) — THE SINGLE SHARED CORE ISSUANCE SEAM.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (merge `0287b250b33fe4c7ea98b880360af74fc08a5ebf`, blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * Ruling 3 (OD-W7-9 = REPLACE): the posture branch sits BEFORE the legacy
 * resolver/builder, and the legacy arm is byte-unchanged. This module is that
 * branch, and it is the ONLY place it exists. Every frozen-context producer in
 * the tree routes through here; none of them re-derives the arm selection.
 *
 * Two copies of an arm-selection rule is exactly the drift the lock forbids,
 * and it is why this is a seam rather than a helper each producer calls
 * alongside its own logic. `tests/unit/attendance-w7-1b-issuance-seam-closure.test.ts`
 * pins the closure mechanically (import graph, adapter graph, CJS require
 * graph), because "everyone remembered to call the seam" is not an invariant.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT — a NAMED DEVIATION from the predecessor brief (owner fork O-3)
 * ---------------------------------------------------------------------------
 * The predecessor design placed the branch immediately upstream of
 * `adapters.resolveLiveCandidate`. That is NOT buildable against the as-built
 * W7-1a facts resolver, and the discriminating fact is the direction of
 * `workDate`:
 *
 *   - `AttendanceW7GroupEffectiveResolverInputV1` takes `workDate` as an INPUT,
 *     and its `ok:true` facts carry no attribution material at all — no
 *     absoluteWindow, attributionWindow, attributionTailMinutes,
 *     windowEvidenceFingerprint, reasonCode or resolverVersion;
 *   - every legacy builder call is fed `attribution.value.workDate`, i.e. the
 *     OUTPUT of `resolveLiveCandidate`.
 *
 * So the group resolver CONSUMES the candidate resolver's output. A branch
 * upstream of `resolveLiveCandidate` would leave the group arm with no
 * attribution to freeze against, and nothing in 1a produces one.
 *
 * W7-1b therefore places the branch immediately upstream of the legacy CONTEXT
 * BUILDER, with the candidate resolver still running on BOTH arms with
 * byte-identical arguments. This is recorded as an owner fork (O-3), not
 * silently harmonised: ruling 3's "legacy resolver/builder" most plausibly
 * names the CONTEXT resolution path, which is what this replaces — but the
 * predecessor's sentence says otherwise and the difference is load-bearing.
 *
 * ---------------------------------------------------------------------------
 * WHY `deps.buildLegacyFrozenContext` IS A PRE-BOUND THUNK
 * ---------------------------------------------------------------------------
 * The legacy builder lives in `plugins/plugin-attendance/index.cjs` and takes a
 * PLUGIN-shaped transaction client whose `query()` resolves to a ROW ARRAY. The
 * W7 resolvers take a CORE-shaped client whose `query()` resolves to
 * `{ rows }`. Only the caller knows which shape it is holding, so the caller
 * binds its own client into the thunk and the seam never converts between them.
 *
 * Passing a client the builder cannot read would make every builder call return
 * `undefined` — which, in a golden harness, looks exactly like a passing run.
 * That failure mode is the reason this is a thunk and not a `(trx, args)` pair.
 */
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import type { FrozenAttendanceContextV1 } from '../w4c0-write-boundary-types'
import { resolveAttendanceW7ContextSourcePostureV1 } from './w7-context-source-posture-resolver'
import {
  resolveW7GroupEffectiveFactsInTransactionV1,
  type AttendanceW7GroupEffectiveResolverDepsV1,
  type AttendanceW7GroupResolutionReasonV1,
  type AttendanceW7GroupResolutionV1,
} from './w7-group-effective-facts-resolver'
import {
  coreIssueGroupEffectiveContextV2,
  type FrozenAttendanceContextV2,
} from './w7-group-effective-context-issuance'
import type { AttendanceW7ContextSourcePostureStateV1 } from '../w7-context-source-posture-contract'

// ---------------------------------------------------------------------------
// The arm-selection rule. EXPORTED, because OD-W7-10's `currentProducer` needs
// the RULE without minting a context.
// ---------------------------------------------------------------------------

/**
 * The posture states that select the GROUP arm.
 *
 * `group_authoritative` ONLY, for W7-1b. `group_shadow`, `group_eligible`,
 * `suspended` and `off` all take the legacy arm.
 *
 * This is a NAMED NON-DELIVERY, not an omission: 1b's enumerated scope is the
 * REPLACE cutover, and a shadow-COMPARE arm is a different behaviour with a
 * different acceptance story that the ratification's 1b list does not name.
 * Widening this set is a behaviour change requiring its own ruling — it is a
 * frozen array rather than a predicate so that widening it is a visible diff.
 */
export const ATTENDANCE_W7_GROUP_ARM_STATES_V1: readonly AttendanceW7ContextSourcePostureStateV1[] =
  Object.freeze(['group_authoritative'] as const)

/**
 * The arm-selection rule, isolated from issuance.
 *
 * OD-W7-10's `currentProducer` MUST use this and must NOT call the seam:
 * calling the seam to answer a yes/no question would MINT A CONTEXT as a side
 * effect — and at the recompute producer it would mint it BEFORE the refusal
 * whose entire purpose is to precede production.
 */
export function attendanceW7PostureSelectsGroupArmV1(
  effectiveState: AttendanceW7ContextSourcePostureStateV1,
): boolean {
  return ATTENDANCE_W7_GROUP_ARM_STATES_V1.includes(effectiveState)
}

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** `'persist'` = a producer that will write what it gets back.
 *  `'mirror'`  = the pre-transaction outer-fingerprint observer, which persists
 *                nothing.
 *
 *  This distinguishes producer from observer for the CALLER-APPLIED coherence
 *  precondition only. It carries NO locking difference: W7-1a's facts resolver
 *  takes the composite advisory locks unconditionally as its step 1, and 1b may
 *  not edit that file, so an "unlocked mirror path" does not exist. */
export type AttendanceW7IssuancePurposeV1 = 'persist' | 'mirror'

export interface AttendanceW7IssuanceInputV1 {
  orgId: string
  userId: string
  workDate: string
  timezone: string
  isWorkday: boolean
  holidayKind: string | null
  shiftId: string
  purpose: AttendanceW7IssuancePurposeV1
}

/** The legacy builder, PRE-BOUND to the caller's own transaction client. */
export type AttendanceW7LegacyContextBuilderV1 = (args: {
  orgId: string
  userId: string
  workDate: string
  timezone: string
  isWorkday: boolean
  holidayKind: string | null
  shiftId: string
}) => Promise<FrozenAttendanceContextV1 | null>

export interface AttendanceW7IssuanceDepsV1 extends AttendanceW7GroupEffectiveResolverDepsV1 {
  buildLegacyFrozenContext: AttendanceW7LegacyContextBuilderV1
}

/**
 * The GROUP arm's `context` is nullable, and that is the O-9 fail-closed shape,
 * not a soft degrade — see `issueAttendanceFrozenContextV1`'s step 4.
 */
export type AttendanceW7IssuanceResultV1 =
  | { arm: 'legacy'; context: FrozenAttendanceContextV1 | null; reason: null }
  | {
      arm: 'group'
      context: FrozenAttendanceContextV2 | null
      reason: AttendanceW7GroupResolutionReasonV1 | null
    }

/**
 * `core-backend` compiles with `strict: false`, so TypeScript does NOT narrow
 * `AttendanceW7GroupResolutionV1` on its boolean `ok` discriminant through a
 * plain truthiness test. This predicate restores the narrowing WITHOUT a cast:
 * the runtime check is the real discriminant (`ok === false`), not an assertion
 * that a value has a shape it may not have. Under `strict: false` a bare
 * `as`-cast here would silently compile even if the union changed shape.
 */
function isFailedGroupResolutionV1(
  resolution: AttendanceW7GroupResolutionV1,
): resolution is { ok: false; reason: AttendanceW7GroupResolutionReasonV1 } {
  return resolution.ok === false
}

// ---------------------------------------------------------------------------
// The seam.
// ---------------------------------------------------------------------------

/**
 * Issue the frozen context for `(org, user, workDate)`.
 *
 * THE ORDER OF THE BODY IS THE CONTRACT:
 *
 * 1. Resolve the W7 posture with 1a's resolver, UNCHANGED. Its three hard
 *    throws (`W7_CONTEXT_SOURCE_STATE_AMBIGUOUS` / `_STATE_INVALID` /
 *    `_SCOPE_INVALID`) propagate; they are never collapsed to `off` here
 *    either. Corruption must not be indistinguishable from "unconfigured".
 *
 * 2. Not a group-arm state -> the injected legacy builder, byte-identical
 *    bytes, returned as `arm: 'legacy'`. THIS IS THE ONLY EXIT THAT TOUCHES
 *    THE LEGACY BUILDER.
 *
 * 3. Group-arm states: `group_authoritative` only (see the frozen array above).
 *
 * 4. Resolve the group facts with 1a's resolver, UNCHANGED. `{ ok: false }` for
 *    ANY reason FAILS CLOSED, and fail-closed here means FALLING BACK TO THE
 *    LEGACY ARM IS FORBIDDEN: a silent legacy fallback would make a
 *    mis-provisioned group org indistinguishable from an unprovisioned one and
 *    would defeat rulings 5/6/11, all three of which chose fail-close over soft
 *    degrade.
 *
 *    HOW it fails closed is owner fork O-9, and the brief's recommendation —
 *    implemented here — is REVIEW-OUT rather than throw: the group arm returns
 *    `context: null`, which the calculator already turns into
 *    `review('missing_frozen_context')`. A throw would roll the punch
 *    transaction back and 5xx EVERY punch for a group org with a routine
 *    membership gap (a new hire not yet in the group). Throws stay reserved for
 *    CORRUPTION — the posture resolver's three hard throws, which propagate
 *    through step 1 untouched.
 *
 *    The `reason` is carried out so the caller can map it to a distinct
 *    outcome reason code rather than losing it.
 *
 * 5. `coreIssueGroupEffectiveContextV2(facts)` — 1a's op(i), UNCHANGED.
 *
 * W7-1b WIRES W7-1a; it does not redesign it. No edit to
 * `w7-context-source-posture-resolver.ts`, `w7-group-effective-facts-resolver.ts`,
 * `w7-group-effective-context-issuance.ts` or `w7-composite-lock-order.ts` is
 * in this slice's scope.
 */
export async function issueAttendanceFrozenContextV1(
  trx: AttendanceW4TransactionClientV1,
  deps: AttendanceW7IssuanceDepsV1,
  input: AttendanceW7IssuanceInputV1,
): Promise<AttendanceW7IssuanceResultV1> {
  // Step 1 — posture. Hard throws propagate by design.
  const posture = await resolveAttendanceW7ContextSourcePostureV1(trx, input.orgId)

  // Steps 2/3 — the branch.
  if (!attendanceW7PostureSelectsGroupArmV1(posture.effectiveState)) {
    const context = await deps.buildLegacyFrozenContext({
      orgId: input.orgId,
      userId: input.userId,
      workDate: input.workDate,
      timezone: input.timezone,
      isWorkday: input.isWorkday,
      holidayKind: input.holidayKind,
      shiftId: input.shiftId,
    })
    return { arm: 'legacy', context: context ?? null, reason: null }
  }

  // Step 4 — group facts, fail-closed, NEVER a legacy fallback.
  const resolution = await resolveW7GroupEffectiveFactsInTransactionV1(trx, deps, {
    orgId: input.orgId,
    userId: input.userId,
    workDate: input.workDate,
    timezone: input.timezone,
    isWorkday: input.isWorkday,
    holidayKind: input.holidayKind,
  })
  if (isFailedGroupResolutionV1(resolution)) {
    return { arm: 'group', context: null, reason: resolution.reason }
  }

  // Step 5 — op(i). The ONLY way a group-effective V2 context comes to exist.
  return { arm: 'group', context: coreIssueGroupEffectiveContextV2(resolution.facts), reason: null }
}
