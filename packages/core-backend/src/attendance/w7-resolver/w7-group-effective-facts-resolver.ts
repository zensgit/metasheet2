/**
 * W7-1a (#4556) STEP 2 — in-transaction group-effective FACTS resolver
 * (OD-W7-1(a)).
 *
 * Authority: design-lock §4.1 (resolution input), §2 red lines W7-R1/W7-R2/
 * W7-R10; ratified per #4556 comments 5293034619 (owner-directed disclosed
 * relay) + 5293478713 (owner first-person confirmation) — rulings
 * 5 (`fixed_shift` only),
 * 6 (W1-vs-FSER mismatch fail-closes), 8 (composite lock order), 9
 * (`w7-resolver/` layout), 11 (`flex_required_duration` fail-closes).
 *
 * RETURNS FACTS, NEVER A CONTEXT (W7-R1). Minting the
 * `FrozenAttendanceContextV2` is the exclusive job of core operation (i) in
 * `./w7-group-effective-context-issuance.ts`. A resolver that returned the V2
 * object directly would put a second issuance origin in the production-root
 * inventory, which is precisely what W7-R1 forbids.
 *
 * READS PERSISTED FACTS UNDER LOCKS — NEVER THE W6 HTTP AGGREGATE (W7-R10).
 * This module imports no W6 module of any kind (not the aggregate service,
 * not its route, and not its types-only contract module — whether a compile-
 * erased `import type` of the W6 contract counts as a live dependency is an
 * OPEN question the ratification comment did NOT rule on, so this file keeps
 * it moot by importing nothing from W6 at all), and issues no HTTP call.
 *
 * STRUCTURALLY INERT (W7-1a): zero production import sites, zero call sites.
 *
 * ON THE FSER COMPOSITION. `loadEffectivenessFacts` is a private closure
 * inside the FSER factory and is NOT exported
 * (`plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs:291-296`),
 * and the exported `getEffectiveness`/`getSelfEffectiveness` wrappers do
 * UNLOCKED pooled reads (`:218`, `:251`) — unusable for a resolver that must
 * read under its own locks. So this module reissues those three SELECTs
 * verbatim INSIDE the lock and feeds them to the EXPORTED PURE derivation
 * `deriveAttendanceGroupFixedScheduleEffectiveness` (`:71`), which is
 * INJECTED rather than imported — the same shape the landed W6-1 aggregate
 * module uses for its own `deps.fser`. (That module is named here only by
 * description, not by filename: the landed W6-R5 import-graph guard
 * `tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts`
 * is a TEXT-marker scan over calculation-path files, and this file is
 * correctly classified as one. Spelling the basename in a comment that exists
 * to say "we do NOT import it" would trip that guard, and the right response
 * to a tripwire firing on prose is to reword the prose, never to add an
 * exemption that weakens the guard for every future file.) Consequence
 * that must not be glossed: this introduces a second *fact loader*, but NOT a
 * second effectiveness *predicate* — the predicate stays singular, which is
 * what W6-R4 and `tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts`
 * actually guard.
 *
 * CALC14 retained rows use the common typed assembler; SQL-token parity alone
 * is not a proof of historical loader equivalence. The real current-row
 * loader retains the three queries pinned against the FSER originals by
 * `tests/unit/attendance-w7-1a-fser-query-parity.test.ts`, so a one-sided edit
 * reds. Stated precisely, because an earlier version of this sentence claimed
 * a pin that did not exist: what is enforced is equality of the SQL token
 * stream after whitespace normalisation, NOT byte equality. Byte equality is
 * unachievable here — the two literals are nested at different depths (the
 * FSER original inside a `.cjs` factory closure, this copy inside a TS
 * function), so they differ in leading indentation and in nothing else. The
 * normalised pin catches every divergence with behavioural content — a
 * dropped `ORDER BY`, a changed predicate, a renamed column, an added or
 * removed clause, or FSER moving underneath this module — and deliberately
 * tolerates reindentation, which cannot change what the database does.
 */
import {
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceUserIdV1,
  parseCanonicalAttendanceWorkDateV1,
  type AttendanceW4TransactionClientV1,
} from '../w4c0-identity'
import { acquireAttendanceW7CompositeFactsLocksV1 } from './w7-composite-lock-order'
import { buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../attendance-timezone-runtime-locks'
import { assembleAttendanceW7GroupEffectiveFactsV1, type AttendanceW7LoadedSourceRowsV1 } from './w7-group-effective-facts-from-rows'

export { AttendanceW7GroupResolverError, ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP } from './w7-group-effective-facts-from-rows'

/**
 * CLOSED reason set — exactly two members, both reachable.
 *
 * `membership-ambiguous` is deliberately ABSENT. Every ambiguity path THROWS
 * `ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP` per W7-R2, so a
 * `membership-ambiguous` reason would be an unreachable member of a closed
 * set — a shape that reads like coverage while proving nothing.
 */
export const ATTENDANCE_W7_GROUP_RESOLUTION_REASONS_V1 = Object.freeze([
  'membership-absent',
  'incomplete-policy',
] as const)

export type AttendanceW7GroupResolutionReasonV1 =
  (typeof ATTENDANCE_W7_GROUP_RESOLUTION_REASONS_V1)[number]

export interface AttendanceW7GroupEffectiveSegmentFactsV1 {
  index: 0 | 1 | 2
  startTime: string
  endTime: string
  startDayOffset: 0
  endDayOffset: 0 | 1
  lateGraceMinutes: number
  earlyLeaveGraceMinutes: number
}

/** Normalized facts. Operation (i) turns exactly this into a V2 context; it
 *  performs no further reads of its own (W7-R1). */
export interface AttendanceW7GroupEffectiveFactsV1 {
  orgId: string
  userId: string
  workDate: string
  timezone: string
  calculationGroupId: string
  shiftId: string
  isWorkday: boolean
  holidayKind: string | null
  roundingMinutes: number
  severeLateThresholdMinutes: number
  absenceLateThresholdMinutes: number
  segments: AttendanceW7GroupEffectiveSegmentFactsV1[]
}

export type AttendanceW7GroupResolutionV1 =
  | { ok: true; facts: AttendanceW7GroupEffectiveFactsV1 }
  | { ok: false; reason: AttendanceW7GroupResolutionReasonV1 }

/** Structural type of the INJECTED pure FSER derivation
 *  (`deriveAttendanceGroupFixedScheduleEffectiveness`). Only the fields this
 *  resolver reads are declared. */
export interface AttendanceW7FixedScheduleDeriveLikeV1 {
  (input: {
    desired: { shiftId: string; startDate: string; endDate: string | null; revision: number } | null
    producerKey: string | null
    targetMemberIds: readonly string[]
    managedRows: readonly Record<string, unknown>[]
    evaluatedAt: string
  }): {
    state: 'not_configured' | 'pending_apply' | 'effective' | 'configuration_changed'
    reasonCodes: readonly string[]
    desired: { shiftId: string; startDate: string; endDate: string | null; revision: number } | null
  }
}

/** Structural type of the INJECTED canonical producer-key builder
 *  (`plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs`).
 *  Injected, not re-implemented: the producer key is the FSER join key, and a
 *  second implementation of it would silently mismatch every managed row. */
export interface AttendanceW7ProducerKeyBuilderLikeV1 {
  (input: { groupId: string; shiftId: string; startDate: string; endDate: string | null }): string
}

/** Org-level calculation rule scalars. Injected because they are NOT group
 *  policy: the legacy builder reads them from the org default rule
 *  (`plugins/plugin-attendance/index.cjs:22775-22782`), and W7 must not fork a
 *  second definition of them while the group arm is the only thing changing. */
export interface AttendanceW7OrgRuleFactsLoaderV1 {
  (
    trx: AttendanceW4TransactionClientV1,
    orgKey: string,
  ): Promise<{ severeLateThresholdMinutes: number; absenceLateThresholdMinutes: number }>
}

export interface AttendanceW7GroupEffectiveResolverDepsV1 {
  deriveFixedScheduleEffectiveness: AttendanceW7FixedScheduleDeriveLikeV1
  buildFixedScheduleProducerKey: AttendanceW7ProducerKeyBuilderLikeV1
  loadOrgRuleFacts: AttendanceW7OrgRuleFactsLoaderV1
  now?: () => string
  loadSourceRows?: (
    trx: AttendanceW4TransactionClientV1,
    deps: AttendanceW7GroupEffectiveResolverDepsV1,
    input: AttendanceW7GroupEffectiveResolverInputV1,
  ) => Promise<AttendanceW7LoadedSourceRowsV1 | null>
}

export interface AttendanceW7GroupEffectiveResolverInputV1 {
  /** Trusted live authority; absent preserves existing producer semantics. */
  effectiveTimezone?: string
  orgId: string
  userId: string
  workDate: string
  timezone: string
  isWorkday: boolean
  holidayKind: string | null
}

/** Current-row loader retained for existing current-source callers. These are
 * real parameterized PG reads under the caller's locks, not an in-memory SQL facade. */
export async function loadAttendanceW7CurrentSourceRowsInTransactionV1(
  trx: AttendanceW4TransactionClientV1,
  deps: AttendanceW7GroupEffectiveResolverDepsV1,
  input: AttendanceW7GroupEffectiveResolverInputV1,
): Promise<AttendanceW7LoadedSourceRowsV1> {
  const orgKey=parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
  const userId=parseCanonicalAttendanceUserIdV1(input.userId)
  const workDate=parseCanonicalAttendanceWorkDateV1(input.workDate)
  const membershipResult = await trx.query(
    `SELECT id, group_id
       FROM attendance_calculation_group_memberships
      WHERE org_id = $1
        AND user_id = $2
        AND effective_from <= $3
        AND (effective_to IS NULL OR effective_to >= $3)
      ORDER BY effective_from ASC, id ASC
      FOR SHARE`,
    [orgKey, userId, workDate],
  )
  const loaded:AttendanceW7LoadedSourceRowsV1={orgId:orgKey,userId,workDate,membershipRows:membershipResult.rows,
    groupRow:null,configRow:null,memberRows:[],managedRows:[],shiftRow:null,segmentRows:[]}
  if (membershipResult.rows.length!==1) return loaded
  const calculationGroupId=String(membershipResult.rows[0].group_id ?? '')
  const groupResult = await trx.query(
    'SELECT id, attendance_type, timezone FROM attendance_groups WHERE id = $1 AND org_id = $2 LIMIT 1',
    [calculationGroupId, orgKey],
  )
  if (groupResult.rows.length!==1) return loaded
  loaded.groupRow=groupResult.rows[0]
  if (loaded.groupRow.attendance_type!=='fixed_shift') return loaded
  const configResult = await trx.query(
    `SELECT shift_id, start_date, end_date, revision
       FROM attendance_group_fixed_schedule_configs
      WHERE org_id = $1 AND group_id = $2
      LIMIT 1`,
    [orgKey, calculationGroupId],
  )
  const memberResult = await trx.query(
    `SELECT DISTINCT user_id
       FROM attendance_group_members
      WHERE org_id = $1 AND group_id = $2
      ORDER BY user_id ASC`,
    [orgKey, calculationGroupId],
  )
  // The `ORDER BY` below mirrors FSER's and is pinned by the query-parity
  // test, but its role is DETERMINISM, not correctness: an independent review
  // probed the exported pure derivation directly across all 24 permutations of
  // `managedRows` over 6 adversarial scenarios (duplicate matching rows,
  // matching + value-mismatch for one user, foreign `producer_key`,
  // unpublished + published, non-member target + missing member, plain
  // effective) with a live negative control, and found it order-INSENSITIVE in
  // every case — it is built from `Set`s, counts, boolean flags, a
  // `REASON_ORDER.filter`, and a `buildManagedSets` that re-sorts explicitly.
  // Recorded so a future reader does not mistake the clause for a load-bearing
  // invariant, and does not delete it either: keeping it identical to FSER's
  // is what makes the two readers reproducible against each other.
  const managedResult = await trx.query(
    `SELECT user_id, shift_id, start_date, end_date, publish_status, producer_key
       FROM attendance_shift_assignments
      WHERE org_id = $1
        AND producer_type = 'attendance_group_fixed_schedule'
        AND producer_ref_id = $2
        AND COALESCE(is_active, true) = true
      ORDER BY producer_key ASC, user_id ASC, start_date ASC, created_at ASC, id ASC`,
    [orgKey, calculationGroupId],
  )
  loaded.configRow=configResult.rows[0] ?? null
  loaded.memberRows=memberResult.rows
  loaded.managedRows=managedResult.rows
  if (!loaded.configRow) return loaded
  const shiftId=String(loaded.configRow.shift_id)
  const shiftResult = await trx.query(
    `SELECT id, timezone, rounding_minutes, late_grace_minutes, early_grace_minutes,
            work_start_time, work_end_time, is_overnight, flex_mode
       FROM attendance_shifts
      WHERE id = $1 AND org_id = $2
      LIMIT 1`,
    [shiftId, orgKey],
  )
  if (shiftResult.rows.length!==1) return loaded
  loaded.shiftRow=shiftResult.rows[0]
  const segmentResult = await trx.query(
    `SELECT segment_index, start_time, end_time, start_day_offset, end_day_offset
       FROM attendance_shift_segments
      WHERE org_id = $1 AND shift_id = $2
      ORDER BY segment_index ASC`,
    [orgKey, shiftId],
  )
  loaded.segmentRows=segmentResult.rows
  loaded.orgRuleFacts=await deps.loadOrgRuleFacts(trx,orgKey)
  return loaded
}

export async function resolveW7GroupEffectiveFactsInTransactionV1(
  trx: AttendanceW4TransactionClientV1,
  deps: AttendanceW7GroupEffectiveResolverDepsV1,
  input: AttendanceW7GroupEffectiveResolverInputV1,
): Promise<AttendanceW7GroupResolutionV1> {
  const orgKey=parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
  const userId=parseCanonicalAttendanceUserIdV1(input.userId)
  await trx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',[
    buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgKey),
  ])
  await acquireAttendanceW7CompositeFactsLocksV1(trx,{orgKey,userId})
  const sourceInput={...input,orgId:orgKey,userId,workDate:parseCanonicalAttendanceWorkDateV1(input.workDate)}
  const loaded=await (deps.loadSourceRows ?? loadAttendanceW7CurrentSourceRowsInTransactionV1)(trx,deps,sourceInput)
  return loaded ? assembleAttendanceW7GroupEffectiveFactsV1(deps,input,loaded) : {ok:false,reason:'incomplete-policy'}
}
