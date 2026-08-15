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
 * The posture states that BLOCK issuance entirely.
 *
 * ⚠️ `suspended` is NOT a legacy-arm state. Routing a suspended org's
 * calculation to the legacy producer would be A LEGACY FALLBACK BY ANOTHER NAME,
 * and OD-W7-4(a) is ratified precisely against that: *no legacy fallback from
 * `group_authoritative` — suspend/resume only; one producer per work date.*
 *
 * The W4 precedent the ruling names is explicit: `POSTURE_TABLE.suspended`
 * carries `writePosture: 'blocked'` (`w4c0-identity.ts`), i.e. suspension stops
 * the writer rather than redirecting it. The landed W7 posture resolver already
 * gives `suspended` a never-evadable priority for the same reason.
 *
 * This shipped as the legacy arm in an earlier revision and was unreachable
 * (no writer ⇒ no rows), but W7-3 makes it reachable, so it is corrected here
 * rather than left as a latent fallback.
 *
 * [OWNER-CONFIRM] The counter-reading is recorded rather than suppressed:
 * 「suspended 读态合法且无消费者，legacy 臂即『无变化』」 — i.e. that while nothing
 * consumes the state, the legacy arm is a no-op and therefore harmless. The
 * RATIFIED default implemented here is BLOCKED; the owner may override.
 */
export const ATTENDANCE_W7_BLOCKED_ARM_STATES_V1: readonly AttendanceW7ContextSourcePostureStateV1[] =
  Object.freeze(['suspended'] as const)

/**
 * The posture states that select the GROUP arm.
 *
 * `group_authoritative` ONLY, for W7-1b. `group_shadow`, `group_eligible` and
 * `off` take the legacy arm; `suspended` is BLOCKED (see above).
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

/**
 * Answer "does the W7 posture select the group arm for this org" WITHOUT
 * minting a context.
 *
 * This is the read the ruling-7 mirror gate needs (its W7 disjunct must be a
 * REAL posture read, never an env read — re-deriving the two-part rule from the
 * allowlist alone would reintroduce the exact allowlist-alone hole the ruling's
 * inert negative controls exist to catch), and it is the read OD-W7-10's
 * `currentProducer` needs for the same reason: calling the seam to answer a
 * yes/no question would mint a context as a side effect.
 *
 * It is a plain unlocked `SELECT` (1a's posture resolver takes no locks) and it
 * is deliberately NOT short-circuited on the allowlist env: a short-circuit
 * would skip 1a's three hard throws for every non-allowlisted org, making a
 * corrupt or ambiguous posture row indistinguishable from an unconfigured one —
 * precisely the corruption-blindness 1a's resolver was built to prevent.
 */
export async function resolveAttendanceW7GroupArmSelectionV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
): Promise<{ effectiveState: AttendanceW7ContextSourcePostureStateV1; selectsGroupArm: boolean }> {
  const posture = await resolveAttendanceW7ContextSourcePostureV1(trx, orgId)
  return {
    effectiveState: posture.effectiveState,
    selectsGroupArm: attendanceW7PostureSelectsGroupArmV1(posture.effectiveState),
  }
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
  /** OD-W7-4(a): a SUSPENDED org produces NO calculation. Not a legacy context,
   *  not a null group context — a refusal the caller must surface. */
  | { arm: 'blocked'; context: null; reason: 'suspended' }
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

  // Step 1b — BLOCKED states, before any arm selection. OD-W7-4(a) forbids a
  // legacy fallback out of the group posture; suspension stops the producer, it
  // does not redirect it.
  if (ATTENDANCE_W7_BLOCKED_ARM_STATES_V1.includes(posture.effectiveState)) {
    return { arm: 'blocked', context: null, reason: 'suspended' }
  }

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
