/**
 * W7-1a (#4556) STEP 2 prerequisite — the ONE composite lock helper.
 *
 * Ruling 8 of #4556 comment 5293034619 (owner-directed disclosed relay;
 * first-person confirmation pending) fixes the order for the first code path
 * that ever combines these two lock families:
 *
 *     membership timeline  →  schedule facts
 *
 * and requires that EVERY double-lock path go through ONE shared helper
 * ("禁止各处内联" — no inlining anywhere), load-bearing on a real
 * two-connection reverse-contention test. This file is that helper. It is the
 * only place in the tree that takes both families, and it takes them in that
 * order unconditionally — there is no parameter that reorders them.
 *
 * WHY AN ORDER HAD TO BE RULED AT ALL. The two families have never run
 * together on `main`. Census at `origin/main@ae26753b1e` (recorded here
 * because a future reader cannot re-derive "was this safe when it landed"):
 *
 *   - membership timeline — exactly ONE production site,
 *     `../../services/AttendanceCalculationGroupMembership.ts:374-377`, which
 *     takes it EXCLUSIVE inside `transitionAttendanceCalculationGroupMembership`
 *     (reached only from `../../routes/attendance-admin.ts:772`);
 *   - schedule facts — production sites only in
 *     `plugins/plugin-attendance/index.cjs` (`acquireAttendanceScheduleAssignmentLock`
 *     :10534 exclusive, `acquireAttendanceScheduleAssignmentReadLock` :10546
 *     shared, plus the `FOR SHARE OF a` rows in
 *     `loadPublishedCandidatesForWorkDateResolver` :15274).
 *
 * ZERO production site takes both. So no pre-existing caller establishes a
 * reverse order that this helper would deadlock against — which is what makes
 * the ruled order adoptable rather than a change to an existing invariant. If
 * a future slice adds a site that reaches the timeline lock while already
 * holding a schedule lock, that site is the defect and this helper is the
 * fixed point; the reverse-contention test below is the standing proof that
 * such a site deadlocks deterministically rather than failing rarely.
 *
 * KEYSPACES ARE NOT INTERCHANGEABLE. PostgreSQL treats the one-argument and
 * two-argument advisory-lock forms as DISJOINT lock spaces. Each lock below
 * therefore reproduces its family's existing convention exactly — the
 * one-argument `hashtextextended` / `\u001f`-delimited form for the timeline
 * family, the two-argument `hashtext` / `:`-delimited form for the schedule
 * family. Using the "tidier" single convention for both would silently buy no
 * mutual exclusion against either existing family.
 *
 * BOTH LOCKS ARE SHARED. W7's resolver is a READER of both families. Shared
 * advisory locks still conflict with the exclusive locks the existing writers
 * take, so a concurrent membership transition or schedule-assignment write is
 * genuinely serialized against this helper; two concurrent W7 readers are not
 * serialized against each other, which is the intent.
 */
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'

/** ASCII Unit Separator — the delimiter the membership timeline family already
 *  uses (`AttendanceCalculationGroupMembership.ts:376`). Reproduced, not
 *  reinvented: a different delimiter is a different key is a different lock. */
const UNIT_SEPARATOR = '\u001f'

/** Mirrors `attendance-calc-timeline` in
 *  `../../services/AttendanceCalculationGroupMembership.ts:376`. */
export function buildAttendanceW7MembershipTimelineLockKeyV1(orgKey: string, userId: string): string {
  return `attendance-calc-timeline${UNIT_SEPARATOR}${orgKey}${UNIT_SEPARATOR}${userId}`
}

/** Mirrors `attendance-schedule:${orgId}` in
 *  `plugins/plugin-attendance/index.cjs:10546-10551`. */
export function buildAttendanceW7ScheduleFactsLockKeyV1(orgKey: string): string {
  return `attendance-schedule:${orgKey}`
}

/**
 * The composite acquisition. Ruled order, no reordering parameter, no
 * short-circuit: a caller that wants only one of the two families must not use
 * this helper at all, and a caller that wants both must use nothing else.
 *
 * Neither acquisition is best-effort. The plugin's exclusive schedule helper
 * swallows advisory-lock errors unless `options.required === true`
 * (`index.cjs:10534-10544`); that leniency is deliberately NOT copied here,
 * because a calculation resolver that silently proceeds without its locks
 * would produce a frozen context from an unserialized read — the exact
 * silent-winner class W7-R2 fail-closes on.
 */
export async function acquireAttendanceW7CompositeFactsLocksV1(
  trx: AttendanceW4TransactionClientV1,
  input: { orgKey: string; userId: string },
): Promise<void> {
  // 1. Membership timeline FIRST (ruling 8).
  await trx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    buildAttendanceW7MembershipTimelineLockKeyV1(input.orgKey, input.userId),
  ])
  // 2. Schedule facts SECOND (ruling 8).
  await trx.query('SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))', [
    buildAttendanceW7ScheduleFactsLockKeyV1(input.orgKey),
    input.userId,
  ])
}
