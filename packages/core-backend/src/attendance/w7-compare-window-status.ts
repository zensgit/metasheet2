/**
 * W7-2 (#4556) — compare-window exit-criteria counters (design-lock §4.2,
 * `group_eligible` entry: "zero critical diffs (work-date/context/input/review
 * classes), zero unresolved reviews, the 8-cell request-snapshot precondition
 * clean, and the W4C-5 transition-safety predicate style applied to W7's own
 * predicates (counts returned by the command, no caller-supplied
 * `ready=true`)").
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`, §4.2; W4C-5 amendment §3
 * verbatim: "The command returns typed per-predicate counts in its result. It
 * does not accept a caller-supplied aggregate `ready=true` as a substitute for
 * these queries."
 *
 * ---------------------------------------------------------------------------
 * DISCIPLINE (each clause mechanically enforced, see the W7-2 suites)
 * ---------------------------------------------------------------------------
 *  - COUNTS, not booleans, RETURNED BY THE COMMAND. The predicate shape clones
 *    `AttendanceRolloutTransitionPredicateV1` and its `passVerdict`/`blocked`
 *    derivation exactly.
 *  - NO CALLER-SUPPLIED READINESS: the input key set is EXACT
 *    (`{orgId, from, to}`) and contains no boolean the caller can assert; any
 *    extra key fails closed. The W4C-5 tool's flag-free args shape is the
 *    precedent.
 *  - TRANSACTION-SCOPED: this is a function over the CALLER's transaction
 *    client, never a route-only reader — when W7-3 consumes these predicates
 *    as a transition gate they must be evaluated INSIDE the transition
 *    transaction (W8 plan §4 entry 5: no read-only preflight reuse). Note the
 *    reused `countUnresolvedIngressReviews` takes `FOR UPDATE` row locks in
 *    the caller's transaction (deliberately — that is the transition-gate
 *    posture); a point-in-time status caller runs this in its own short-lived
 *    transaction and rolls back.
 *  - `W7_COMPARE_COVERAGE` exists because "zero critical diffs" over an EMPTY
 *    window is a vacuous pass — an empty read is not an absence. An empty
 *    window is `blocked`, never "clean".
 *
 * ---------------------------------------------------------------------------
 * THE DISCRIMINATOR (the single sharpest correctness point of this module)
 * ---------------------------------------------------------------------------
 * `attendance_record_calculations` has NO column distinguishing a W7 group
 * shadow row from a W4 shadow row: both are `mode='shadow'`,
 * `calculation_tier='legacy_shadow'`, same entrypoints. Under `group_shadow`
 * on a W4-shadow-postured org BOTH rows exist for one (record, work_date).
 * The only discriminator is the derivable equivalent
 * `context_snapshot ->> 'selector' = 'group_effective'` — the same one
 * OD-W7-10(a) uses — and it is TOTAL: `selector` is a mandatory member of
 * both context schemas' closed key sets, so every persisted context carries
 * it. NO `??`/COALESCE default is applied anywhere in this module: a
 * non-null context missing `selector` is CORRUPTION and hard-fails
 * (`W7_COMPARE_CONTEXT_SELECTOR_MISSING`) — a default would fail OPEN, by
 * counting a group row as legacy or vice versa.
 *
 * W7 group-resolution FAIL-CLOSE records have `context_snapshot IS NULL` (no
 * group context exists to persist) and are discriminated by the
 * writer-controlled `input_provenance` marker below; they are deliberately
 * OUTSIDE the selector-filtered compare-row domain, so a fail-close is never
 * double-counted as a critical/off-roster diff.
 */
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1 } from './w4c2-shadow-expected-differences'
import {
  countUnresolvedIngressReviews,
  readAttendanceRequestSnapshotDefectReportV1,
} from './w4c3a-rollout-control'
import {
  isExpectedAttendanceW7ShadowDifferenceV1,
  parseAttendanceW7ShadowDifferenceProbeV1,
} from './w7-shadow-expected-differences'

export class AttendanceW7CompareWindowError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW7CompareWindowError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW7CompareWindowError(code)
}

/**
 * The writer-controlled `input_provenance` key every W7-2 group-shadow
 * comparison record carries (both the compare rows and the null-context
 * fail-close records). Written ONLY by the boundary's W7-2 recording helper;
 * also the partition key of the `uq_arc_operation` dedup index split (the W7
 * comparison record shares its producing operation with the served row it
 * compares against, so it lives in its own dedup partition).
 */
export const ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1 = 'w7GroupShadowCompare'

export const ATTENDANCE_W7_COMPARE_PREDICATE_CODES_V1 = Object.freeze([
  'W7_CRITICAL_SHADOW_DIFF',
  'W7_OFF_ROSTER_DIFF',
  'W7_UNRESOLVED_INGRESS_REVIEW',
  'W7_REQUEST_SNAPSHOT_DEFECT',
  'W7_COMPARE_COVERAGE',
  'W7_GROUP_RESOLUTION_FAILCLOSE',
] as const)

export type AttendanceW7ComparePredicateCodeV1 =
  (typeof ATTENDANCE_W7_COMPARE_PREDICATE_CODES_V1)[number]

/** Clones `AttendanceRolloutTransitionPredicateV1` exactly. */
export type AttendanceW7ComparePredicateV1 = Readonly<{
  code: AttendanceW7ComparePredicateCodeV1
  applicable: boolean
  pass: boolean
  count: number | null
}>

export type AttendanceW7CompareWindowStatusV1 = Readonly<{
  orgId: string
  from: string
  to: string
  predicates: readonly AttendanceW7ComparePredicateV1[]
  blocked: boolean
}>

export interface AttendanceW7CompareWindowInputV1 {
  readonly orgId: string
  readonly from: string
  readonly to: string
}

const INPUT_KEYS = Object.freeze(['orgId', 'from', 'to'] as const)
const INPUT_INVALID = 'W7_COMPARE_WINDOW_INPUT_INVALID'

const CALENDAR_DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Exact-key fail-closed input parse. Mechanically, "no caller-supplied
 * `ready=true`" is enforced HERE: the key set is exact, so a probe adding
 * `ready: true` (or any other caller-assertable boolean) is rejected rather
 * than ignored — an ignored key would let a caller BELIEVE it asserted
 * readiness.
 */
function parseInput(input: unknown): AttendanceW7CompareWindowInputV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(INPUT_INVALID)
  const obj = input as Record<string, unknown>
  const own = Object.getOwnPropertyNames(obj)
  if (own.length !== INPUT_KEYS.length) fail(INPUT_INVALID)
  for (const key of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(INPUT_INVALID)
  }
  if (typeof obj.orgId !== 'string' || obj.orgId.trim().length === 0) fail(INPUT_INVALID)
  if (typeof obj.from !== 'string' || !CALENDAR_DATE_KEY.test(obj.from)) fail(INPUT_INVALID)
  if (typeof obj.to !== 'string' || !CALENDAR_DATE_KEY.test(obj.to)) fail(INPUT_INVALID)
  if (obj.from > obj.to) fail(INPUT_INVALID)
  return { orgId: obj.orgId, from: obj.from, to: obj.to }
}

/** `passVerdict`, cloned from `w4c3a-rollout-control.ts`. */
function passVerdict(
  code: AttendanceW7ComparePredicateCodeV1,
  applicable: boolean,
  pass: boolean,
  count: number | null,
): AttendanceW7ComparePredicateV1 {
  return Object.freeze({ code, applicable, pass, count })
}

function asCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) fail('W7_COMPARE_WINDOW_COUNT_INVALID')
  return n
}

/** The shared in-window W7 compare-row filter fragment. `selector` is read
 *  with NO default (see the header); the totality of `selector` over non-null
 *  contexts is asserted separately and FIRST, so this fragment never silently
 *  partitions a selector-less corrupt row out of the group domain. */
const W7_COMPARE_ROW_FILTER = `
      c.org_id = $1
      AND c.mode = 'shadow'
      AND r.work_date >= $2::date
      AND r.work_date <= $3::date
      AND c.context_snapshot IS NOT NULL
      AND (c.context_snapshot ->> 'selector') = 'group_effective'`

/**
 * Read the compare-window exit-criteria counters for one org over a work-date
 * window. READ-ONLY: performs zero DML (the reused ingress-review predicate
 * takes `FOR UPDATE` row locks — a lock, not a write). Every count is computed
 * by this command inside the caller's transaction; nothing here accepts or
 * honours a caller-computed verdict.
 */
export async function readAttendanceW7CompareWindowStatusV1(
  trx: AttendanceW4TransactionClientV1,
  rawInput: unknown,
): Promise<AttendanceW7CompareWindowStatusV1> {
  const input = parseInput(rawInput)
  const { orgId, from, to } = input
  const params = [orgId, from, to]

  // -------------------------------------------------------------------------
  // T-D2 totality gate FIRST: a non-null context with no `selector` member is
  // corruption, and every counter below would misclassify it. Hard error —
  // never "treat as legacy" (that default fails open).
  // -------------------------------------------------------------------------
  const selectorless = await trx.query(
    `SELECT count(*) AS n
       FROM attendance_record_calculations c
       JOIN attendance_records r
         ON r.id = c.attendance_record_id AND r.org_id = c.org_id
      WHERE c.org_id = $1
        AND c.mode = 'shadow'
        AND r.work_date >= $2::date
        AND r.work_date <= $3::date
        AND c.context_snapshot IS NOT NULL
        AND (c.context_snapshot ->> 'selector') IS NULL`,
    params,
  )
  if (asCount(selectorless.rows[0]?.n) !== 0) fail('W7_COMPARE_CONTEXT_SELECTOR_MISSING')

  // 1. W7_CRITICAL_SHADOW_DIFF — group compare rows whose code is in the ONE
  //    exported critical set (§3.4). The set is passed as a parameter from the
  //    TS constant: single source, never re-spelled in SQL.
  const critical = await trx.query(
    `SELECT count(*) AS n
       FROM attendance_record_calculations c
       JOIN attendance_records r
         ON r.id = c.attendance_record_id AND r.org_id = c.org_id
      WHERE ${W7_COMPARE_ROW_FILTER}
        AND c.shadow_diff_code = ANY($4::text[])`,
    [...params, [...ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1]],
  )
  const criticalCount = asCount(critical.rows[0]?.n)

  // 2. W7_OFF_ROSTER_DIFF — non-`equal` group compare rows NOT matched by the
  //    §3.3 roster probe. Row-derived probes go through the SAME fail-closed
  //    parse the predicate uses; a row that cannot even form a probe is
  //    corruption and hard-fails rather than being silently skipped.
  const divergent = await trx.query(
    `SELECT c.shadow_diff_code, c.entrypoint, c.outcome, c.projected_status
       FROM attendance_record_calculations c
       JOIN attendance_records r
         ON r.id = c.attendance_record_id AND r.org_id = c.org_id
      WHERE ${W7_COMPARE_ROW_FILTER}
        AND c.shadow_diff_code IS NOT NULL
        AND c.shadow_diff_code <> 'equal'`,
    params,
  )
  let offRosterCount = 0
  for (const row of divergent.rows as Array<Record<string, unknown>>) {
    const probe = parseAttendanceW7ShadowDifferenceProbeV1({
      shadowDiffCode: row.shadow_diff_code,
      entrypoint: row.entrypoint,
      groupOutcome: row.outcome,
      groupProjectedStatus: row.projected_status ?? null,
    })
    if (!isExpectedAttendanceW7ShadowDifferenceV1(probe)) offRosterCount += 1
  }

  // 3. W7_UNRESOLVED_INGRESS_REVIEW — REUSED, never re-derived.
  const unresolvedReviews = await countUnresolvedIngressReviews(trx, orgId)

  // 4. W7_REQUEST_SNAPSHOT_DEFECT — the 8-cell report REUSED AS-IS.
  const defectReport = await readAttendanceRequestSnapshotDefectReportV1(trx, orgId)
  const defectiveRequests = asCount(defectReport.totalDefectiveRequests)

  // 5. W7_COMPARE_COVERAGE — distinct (user, work_date) pairs with a W7
  //    compare row in the window. Zero coverage BLOCKS: "zero diffs" must not
  //    be satisfiable by "zero comparisons".
  const coverage = await trx.query(
    `SELECT count(DISTINCT (r.user_id, r.work_date)) AS n
       FROM attendance_record_calculations c
       JOIN attendance_records r
         ON r.id = c.attendance_record_id AND r.org_id = c.org_id
      WHERE ${W7_COMPARE_ROW_FILTER}`,
    params,
  )
  const coverageCount = asCount(coverage.rows[0]?.n)

  // 6. W7_GROUP_RESOLUTION_FAILCLOSE — recorded per-target fail-close records
  //    over the window: the writer-controlled marker carries a non-null
  //    `shadowReason` exactly when the group resolution failed closed (§3.1).
  const failclose = await trx.query(
    `SELECT count(*) AS n
       FROM attendance_record_calculations c
       JOIN attendance_records r
         ON r.id = c.attendance_record_id AND r.org_id = c.org_id
      WHERE c.org_id = $1
        AND c.mode = 'shadow'
        AND r.work_date >= $2::date
        AND r.work_date <= $3::date
        AND (c.input_provenance -> '${ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1}' ->> 'shadowReason') IS NOT NULL`,
    params,
  )
  const failcloseCount = asCount(failclose.rows[0]?.n)

  const predicates: readonly AttendanceW7ComparePredicateV1[] = Object.freeze([
    passVerdict('W7_CRITICAL_SHADOW_DIFF', true, criticalCount === 0, criticalCount),
    passVerdict('W7_OFF_ROSTER_DIFF', true, offRosterCount === 0, offRosterCount),
    passVerdict('W7_UNRESOLVED_INGRESS_REVIEW', true, unresolvedReviews === 0, unresolvedReviews),
    passVerdict('W7_REQUEST_SNAPSHOT_DEFECT', true, defectiveRequests === 0, defectiveRequests),
    passVerdict('W7_COMPARE_COVERAGE', true, coverageCount >= 1, coverageCount),
    passVerdict('W7_GROUP_RESOLUTION_FAILCLOSE', true, failcloseCount === 0, failcloseCount),
  ])

  // `blocked`, cloned from the W4C-5 shape: any applicable failing predicate.
  const blocked = predicates.some((predicate) => predicate.applicable && !predicate.pass)

  return Object.freeze({ orgId, from, to, predicates, blocked })
}
