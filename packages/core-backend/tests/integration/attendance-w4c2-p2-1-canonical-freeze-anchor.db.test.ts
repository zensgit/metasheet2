/**
 * W4C-2 (#4556 lock §8.2 steps 4/5/7, §5.2/§5.3) — #4612 gate3 P2-1
 * remediation: canonical/shadow live-punch freeze-step anchor correctness
 * (real DB, route-level + one real two-connection race).
 *
 * Authority: the scratchpad-only canonical-freeze-semantics judgment MD
 * ((A) "lock is already settled") + the gate3 report's P2-1/P3-1/P3-2/P3-3
 * findings. Fix landed in `w4c2-live-scheduled-boundary.ts`
 * (`executeLivePunch`'s non-legacy-only-time branch):
 *
 *  1. the freeze step's W2 re-resolution now uses `input.requestTimezone`
 *     (the route's PRE-resolution timezone) with the anchor OMITTED so the
 *     shared resolver derives it itself — never `input.timezone`/
 *     `input.workDate` (POST-resolution, potentially a DIFFERENT calendar
 *     day than the punch's own for an overnight shift);
 *  2. the frozen context's timezone comes from THIS freeze step's own
 *     winner (`resolution.fullWinner.timezone`), never the route's
 *     (possibly stale) `input.timezone`;
 *  3. evidence is anchored to the frozen attribution's own `workDate`
 *     (§5.3), not the boundary's `input.workDate`;
 *  4. a new §8.2 step-7 candidate-identity equality gate: if the freeze
 *     step's own resolved `workDate` disagrees with `input.workDate` (the
 *     identity already baked into the operation's `correlationId`), the
 *     calculation is forced to `review_required`/`context_mismatch` with
 *     zero segments — reachable only via a genuine DB-state race between
 *     the route's pre-transaction read and this transaction's snapshot.
 *
 * Leg map (canonical-freeze-semantics judgment §4.3 L1-L7):
 *
 *  - L1 (group A, drift user): client tz != winning shift tz, zero
 *    concurrency. The frozen `attribution_snapshot` on the shadow
 *    calculation row is asserted to byte-match a LEGACY-posture reference
 *    punch run against the IDENTICAL shift/day/instant shape — the
 *    reference leg is itself already mutation-proven (P1 remediation,
 *    `attendance-w4c2-live-scheduled-boundary.db.test.ts`) to reproduce the
 *    route's own PRE-resolution W2 call byte-for-byte, so cross-referencing
 *    against it is equivalent to comparing against "the route's own
 *    resolution" without re-deriving absolute-window ISO instants by hand.
 *    NOTE (scope, disclosed): `FrozenWorkDateAttributionV2` (the V2 shape
 *    this branch persists) has no `evidenceSnapshot.calendarWorkDate`
 *    field at all (that is a V1/legacy-response-only field) — L1's
 *    `workDate`/`shiftId`/`reasonCode`/`absoluteWindow`/`attributionWindow`
 *    comparison is asserted; the `calendarWorkDate` sub-clause does not
 *    apply to this branch's persisted shape and is not asserted.
 *  - L2/L3 (mutation): NOT separate test legs — proven by manually
 *    reverting the two fix lines in `w4c2-live-scheduled-boundary.ts` and
 *    re-running L1 (see the PR body's mutation table); both are
 *    independent knives (neither door covers for the other).
 *  - L4 (group A, plain user): client tz == shift tz — proves L1 is not
 *    fail-closed by construction.
 *  - L5 (group B, race): a real two-connection race using the existing
 *    `__setAttendanceW4LivePunchPreBoundarySeamForTests` seam
 *    (`attendance-w4c2-p2-remediation.db.test.ts`'s own precedent) removes
 *    the route's own single candidate and installs a DIFFERENT single
 *    candidate (a different calendar day) before the canonical transaction
 *    opens. The legacy adapter's OWN in-transaction resolution (step 3)
 *    stays non-ambiguous throughout (so it never throws its own 409),
 *    reaching the NEW step-7 gate: `outcome_reason_code='context_mismatch'`,
 *    zero segments, legacy projection intact.
 *  - L6 (group C, race), RE-SCOPED TWICE — round 1 (mutation self-check
 *    finding, disclosed below and in the PR body): a real two-connection
 *    race that changes ONLY the winning shift row's own `timezone` column
 *    (identity — workDate/shiftId — unchanged) does NOT independently
 *    discriminate the `w4c2-live-scheduled-boundary.ts` freeze-step fix's
 *    `timezone:` argument to `buildShadowFrozenContext` — mutating that
 *    argument (to `input.timezone`, and separately to a nonsense literal)
 *    left this leg green both times, because `buildW4ShadowFrozenContextV1`
 *    (`index.cjs` ~L21519) independently re-reads the shift row in the SAME
 *    transaction and overrides whatever is passed whenever the row's own
 *    `timezone` column is non-blank. That argument is therefore correct per
 *    the lock (Q16/Q17) but observably inert for any fixture where the
 *    winning shift carries a timezone. Round 2 (#4612 gate3 P2-1 closure,
 *    second round — source-definition fingerprint half of step 7 landed):
 *    this leg is NOW the fingerprint-only discriminating leg — identity
 *    stays silent (workDate/shiftId unchanged) but the OUTER-vs-INNER
 *    source-definition fingerprint now differs, so `outcome` correctly
 *    flips from `completed` (pre-fingerprint-fix) to
 *    `review_required`/`context_mismatch` (post-fix) — see the test's own
 *    updated comment for the full account.
 *  - L7 (group B, race + pre-existing evidence): reuses L5's race and adds
 *    a pre-existing `attendance_events` row tagged to the CORRECT anchor
 *    day (the freeze step's own resolved `workDate`) that the OLD
 *    (`input.workDate`) anchor would never see.
 *  - Group D (shiftId-only race, see below) and the 2×2 exclusivity matrix
 *    for the two step-7 conjuncts (identity vs. source-definition
 *    fingerprint) — the structural-subsumption finding (fingerprint domain
 *    contains workDate/shiftId, so an ordinary shiftId swap between two
 *    WELL-FORMED shifts trips BOTH conjuncts, not identity alone) — are
 *    documented in `w4c2-live-scheduled-boundary.ts`'s own `identityDrift`
 *    comment and in the PR body; not repeated here. RETRACTED (gate4 P2,
 *    #4612): the earlier claim that an "identity-only, fingerprint-silent"
 *    leg "cannot be built from a real DB fixture in this schema" was WRONG
 *    as stated — it conflated "not reachable from two well-formed shifts"
 *    (still true) with "not constructible at all" (false: see Group G).
 *  - Group G (shiftId-only race with BOTH candidate shifts frozen-context-
 *    null, see below): gate4's independent audit found the identity
 *    conjunct (`identityMismatch`, `w4c2-live-scheduled-boundary.ts`'s
 *    `const identityMismatch =` — file:line drifts across edits, see NIT-1
 *    #4612 gate4 round 3, use the symbol not a line number)
 *    was an UNTESTED guard — neutering it left all 48 real-DB W4C-2 legs in
 *    this suite family green (zero discriminating signature), because every
 *    OTHER leg that swaps shiftId also swaps the fingerprint domain (which
 *    CONTAINS shiftId) whenever `context` is non-null. Group G closes that
 *    gap: both candidate shifts carry a single, deliberately non-dense
 *    `attendance_shift_segments` row (`segment_index = 1`, no row 0) —
 *    legal per this table's CHECK constraints (range 0-2, per-shift
 *    uniqueness; no density constraint), but a shape only a MALFORMED /
 *    hand-crafted fixture produces (the canonical shift service always
 *    writes dense 0..2; see the migration's own contract header). With
 *    `context === null` on BOTH the outer and inner reads,
 *    `computeAttendanceOuterComparableSourceDefinitionFingerprintV1` returns
 *    `null` both times (`sourceDefinitionInputOrNull`'s
 *    `if (context === null) return null` branch, `w4c1-fingerprints.ts`) —
 *    the fingerprint conjunct is STRUCTURALLY SILENT (`null !== null` is
 *    always `false`), so only the identity conjunct can catch the shiftId
 *    swap. Because the null context is a FIXTURE property (both candidate
 *    shifts are malformed, race or no race), the standard "disarmed
 *    connection B ⇒ outcome flips to `completed`" race-genuineness shape
 *    (used by Group D/D-overnight) is UNREACHABLE here by construction —
 *    Group G's positive control instead proves genuineness through the
 *    `outcome_reason_code` flip (`context_mismatch` raced vs
 *    `missing_frozen_context` disarmed) plus the persisted
 *    `attribution_snapshot.value.shiftId` (race-installed shift vs the
 *    original), which only a real committed write from connection B can
 *    produce. See the test's own comment for the full account, including
 *    why this is a deliberate, disclosed deviation from the literal
 *    `feedback_toctou_needs_constructed_race` shape, not an omission.
 *
 * Shared-DB discipline: fixture ids are file-namespaced random UUIDs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import {
  assertLegacyPunchResponseGoldenShapeResolvedV1,
} from '../utils/attendance-w4c2-golden-response'
import { __computeAttendanceOuterAttributionValueForTestsV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'
import {
  canonicalAttendanceJsonV1,
  computeAttendanceSemanticInputFingerprintV1,
} from '../../src/attendance/w4c0-fingerprints'
import {
  computeAttendanceSourceDefinitionFingerprintV1,
  computeAttendanceOuterComparableSourceDefinitionFingerprintV1,
} from '../../src/attendance/w4c1-fingerprints'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

type HttpResponse = { status: number; body?: any; raw: string }

function requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const requireCjs = createRequire(import.meta.url)
function loadPlugin(): {
  __setAttendanceW4LivePunchPreBoundarySeamForTests?: (seam: ((ctx: unknown) => Promise<void>) | null) => void
} {
  return requireCjs('../../../../plugins/plugin-attendance/index.cjs')
}

describeDb('W4C-2 #4612 gate3 P2-1 remediation — canonical freeze-step anchor (real DB, route-level + race)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let priorAllowlistEnv: string | undefined

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
  async function mintToken(userId: string, perms = 'attendance:write'): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const punch = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 P2-1 remediation fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w4c2-p21.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }
  async function insertLegacyRolloutRow(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w4c2-p21', 'TEST_FIXTURE', 'w4c2-p21-actor', 1, NULL)`,
      [orgId],
    )
  }
  async function insertShadowRolloutRow(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'shadow', 'w4c2-p21', 'TEST_FIXTURE', 'w4c2-p21-actor', 1, NULL)`,
      [orgId],
    )
  }
  async function insertShift(
    shiftId: string, orgId: string, name: string, tz: string, start: string, end: string, overnight: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '[0,1,2,3,4,5,6]'::jsonb)`,
      [shiftId, orgId, name, tz, start, end, overnight],
    )
  }
  async function insertAssignment(
    assignmentId: string, orgId: string, userId: string, shiftId: string, day: string, active = true,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'published', 1)`,
      [assignmentId, orgId, userId, shiftId, day, active],
    )
  }
  const calculationRowsForUser = async (userId: string) =>
    (await pool.query(
      `SELECT c.id::text AS id, c.outcome, c.outcome_reason_code, c.expected_segment_count,
              c.semantic_input_fingerprint, c.source_definition_fingerprint,
              c.attribution_snapshot, c.context_snapshot, c.evidence_snapshot,
              c.approved_facts_snapshot, c.manual_override_snapshot, c.merge_policy,
              c.calculation_tier, c.engine_version, c.snapshot_schema_version
       FROM attendance_record_calculations c
       JOIN attendance_records r ON r.id = c.attendance_record_id
       WHERE r.user_id = $1
       ORDER BY c.version`,
      [userId],
    )).rows
  const segmentCountForCalculation = async (calculationId: string) =>
    Number((await pool.query(
      'SELECT count(*)::int AS n FROM attendance_record_segments WHERE calculation_id = $1::uuid',
      [calculationId],
    )).rows[0].n)
  const recordRow = async (userId: string) =>
    (await pool.query(
      `SELECT id::text AS id, work_date::text AS work_date FROM attendance_records WHERE user_id = $1`,
      [userId],
    )).rows

  // ---------------------------------------------------------------------
  // Group A: L1 (drift) + L4 (positive control) + a legacy-posture
  // reference org for L1's cross-reference.
  // ---------------------------------------------------------------------
  const refOrg = randomUUID()
  const refShift = randomUUID()
  const refDriftUser = randomUUID()
  const shadowOrgA = randomUUID()
  const shadowShiftA = randomUUID()
  const shadowDriftUser = randomUUID()
  const shadowPlainUser = randomUUID()

  // ---------------------------------------------------------------------
  // Group B: L5 (race -> step-7 identity gate) + L7 (race + evidence anchor).
  // ---------------------------------------------------------------------
  const raceOrg = randomUUID()
  const raceShiftA = randomUUID() // daytime, day D (route-visible)
  const raceShiftB = randomUUID() // overnight, day D-1 (race-installed)
  const raceUser = randomUUID()
  const raceEvidenceUser = randomUUID()
  const RACE_DAY = '2026-07-19'
  const RACE_DAY_PREV = '2026-07-18'
  const RACE_OCCURRED_AT = '2026-07-19T02:00:00.000Z'

  // ---------------------------------------------------------------------
  // Group C: L6 (race -> winner-timezone, identity unchanged).
  // ---------------------------------------------------------------------
  const tzRaceOrg = randomUUID()
  const tzRaceShift = randomUUID()
  const tzRaceUser = randomUUID()
  const TZ_RACE_OCCURRED_AT = '2026-07-19T12:00:00.000Z'
  // L6's own race UPDATEs `attendance_shifts.timezone` on `tzRaceShift`
  // ITSELF (not a per-user assignment row, unlike Group D/D-overnight) — a
  // committed, non-transactional, shift-row-global mutation that persists
  // for the rest of the suite once L6 runs. The L6 positive control
  // therefore needs its OWN, never-raced shift row (round 3 finding ③,
  // caught empirically: reusing `tzRaceShift` made the control observe
  // 'Asia/Kolkata' regardless of connection B, because L6 had already
  // mutated the shared row before the control ran).
  const tzRaceControlShift = randomUUID()

  // ---------------------------------------------------------------------
  // Group D (#4612 gate3 P2-1 self-report ⑥ closure): a shiftId-ONLY race —
  // workDate held FIXED across the race, only the winning shift swaps. Both
  // candidate shifts cover the SAME calendar day and BOTH windows contain the
  // fixed punch instant, so this is the narrower race the pre-widening
  // `identityDrift` (workDate-only) provably let through silently.
  // ---------------------------------------------------------------------
  const sidOrg = randomUUID()
  const sidShiftX = randomUUID() // route-visible at read time
  const sidShiftY = randomUUID() // race-installed, same day, different shift
  const sidUser = randomUUID()
  const SID_DAY = '2026-07-21'
  const SID_OCCURRED_AT = '2026-07-21T10:00:00.000Z'

  // ---------------------------------------------------------------------
  // Group D-overnight (W4C2 gate3 P2-1 second closure round — self-report
  // ③ from that round: "Group D only covered a non-overnight shiftId-only
  // race"). Same construction as Group D, but BOTH candidate shifts are
  // OVERNIGHT (22:00-06:00 / 21:00-07:00 UTC), assigned on the SAME
  // `start_date` (OSID_DAY) — an overnight candidate's own `workDate` is
  // the day the shift STARTS (the night before the punch instant), so
  // pinning both shifts to the SAME start_date keeps identity's `workDate`
  // half FIXED across the race, exactly like Group D, while `shiftId`
  // swaps. This is deliberately NOT argued-equivalent to Group D — built as
  // its own real two-connection race, because the overnight resolution path
  // (`workDate` != `toWorkDate(occurredAt, timezone)`) is the exact
  // defect class two EARLIER rounds on this PR (P1-3, gate2 P1) already
  // broke on, non-overnight-shaped reasoning having been proven unsafe to
  // extrapolate from more than once on this PR.
  // ---------------------------------------------------------------------
  const osidOrg = randomUUID()
  const osidShiftX = randomUUID() // overnight, 22:00-06:00 UTC, route-visible at read time
  const osidShiftY = randomUUID() // overnight, 21:00-07:00 UTC, race-installed, SAME start_date
  const osidUser = randomUUID()
  const OSID_DAY = '2026-07-22' // the night BOTH shifts start
  const OSID_OCCURRED_AT = '2026-07-23T02:00:00.000Z' // inside both windows

  // ---------------------------------------------------------------------
  // Group E (#4612 gate3 P2-1 self-report ③' closure — advisor-corrected
  // construction): two zero-concurrency fixtures that each isolate ONE of
  // the two P2-1 fix lines (L2 = freeze-step `timezone` argument, L3 =
  // omitting the explicit `calendarWorkDate` re-derivation argument) so each
  // mutation has an EXCLUSIVE (fires-alone) leg, closing the earlier
  // (WRONG) "structurally indistinguishable" conclusion. Both use the SAME
  // overnight shift shape (UTC 22:00-06:00, belongs to day D) so `winner.
  // workDate` is always D — the shift differs only in occurredAt/client-tz,
  // which changes which of {L2, L3} the mutation is meaningful on:
  //  - eDay1 (`Etc/GMT+7`, occurredAt D+1 02:00Z): correct resolution is
  //    `CURRENT_DAY_CONTAINING_SHIFT` (calendarWorkDate == winner.workDate).
  //    Reverting L2's tz argument moves calendarWorkDate to D+1, flipping
  //    the resolution to `PREVIOUS_NIGHT_CONTAINING_SHIFT` (L2 FIRES here).
  //    Reverting L3 (re-adding the explicit `calendarWorkDate:
  //    input.workDate` argument) re-supplies the SAME value the correct
  //    code already derives on this fixture (D) — provably a no-op (L3 is
  //    SILENT here).
  //  - eDay2 (`Asia/Tokyo`, occurredAt D+1 03:00Z): correct resolution is
  //    `PREVIOUS_NIGHT_CONTAINING_SHIFT`. Reverting L2 leaves
  //    calendarWorkDate at D+1 (Tokyo and the shift's own UTC both derive
  //    D+1 for this instant) — provably a no-op (L2 is SILENT here).
  //    Reverting L3 re-supplies `input.workDate` (=D, the previous-night
  //    winner) instead of D+1, flipping the resolution to
  //    `CURRENT_DAY_CONTAINING_SHIFT` (L3 FIRES here).
  // Both derivations verified with a standalone `node -e` direct call to
  // `selectAmongMatchingCandidates` before wiring these real-DB fixtures
  // (see the PR body's Group E section for the raw output).
  // ---------------------------------------------------------------------
  const eDay1Org = randomUUID()
  const eDay1Shift = randomUUID()
  const eDay1User = randomUUID()
  const EDAY = '2026-07-19'
  const EDAY1_OCCURRED_AT = '2026-07-20T02:00:00.000Z'
  const eDay2Org = randomUUID()
  const eDay2Shift = randomUUID()
  const eDay2User = randomUUID()
  const EDAY2_OCCURRED_AT = '2026-07-20T03:00:00.000Z'

  // ---------------------------------------------------------------------
  // Group F (O-5 decisive probe, #4612 gate3 P2-1 round 3): the SAME
  // zero-concurrency self-observation shape as Group E / eDay2 (identical
  // shift geometry + occurredAt/timezone — reproduces the SAME
  // `OPEN_PREVIOUS_NIGHT_RECORD` (inner) vs `PREVIOUS_NIGHT_CONTAINING_SHIFT`
  // (outer) reasonCode flip), but on its OWN fixture (fresh org/user/shift)
  // so the seam-captured outer resolution and the persisted inner
  // `attribution_snapshot` can both be read back for THIS one operation
  // without colliding with eDay2's own assertions. Not a race — a genuine
  // SAME-operation, SAME-connection, zero-concurrency self-observation:
  // outer = the route's PRE-transaction read (before step 3's legacy write
  // exists); inner = the freeze step's POST-step-3 read (same transaction,
  // same snapshot, step 3 already committed within it). Every field of
  // `attribution.value` is diffed, not just `reasonCode` — this is the
  // decisive experiment the O-5 write-up in the PR body is based on, not an
  // argued claim.
  // ---------------------------------------------------------------------
  const fProbeOrg = randomUUID()
  const fProbeShift = randomUUID()
  const fProbeUser = randomUUID()
  const FPROBE_EDAY = EDAY
  const FPROBE_OCCURRED_AT = EDAY2_OCCURRED_AT

  // ---------------------------------------------------------------------
  // Group G (#4612 gate4 P2 closure — untested identity conjunct):
  // shiftId-only race, SAME construction as Group D, except BOTH candidate
  // shifts (gncShiftX, gncShiftY) are given a single deliberately
  // NON-DENSE `attendance_shift_segments` row (`segment_index = 1`, row 0
  // never inserted) instead of relying on the legacy work_start_time/
  // work_end_time fallback. `buildW4ShadowFrozenContextV1`
  // (`index.cjs` ~L21451) rejects any segment set where `segment_index !==
  // its own array position (`index !== i`, ~L21479) — so BOTH the outer
  // (pre-race, gncShiftX) and inner (post-race, gncShiftY) frozen-context
  // reads return `null`. See the leg-map comment above and the test body
  // for why this makes the fingerprint conjunct structurally silent,
  // leaving identity as the ONLY discriminating conjunct for this leg.
  // ---------------------------------------------------------------------
  const gncOrg = randomUUID()
  const gncShiftX = randomUUID() // route-visible at read time
  const gncShiftY = randomUUID() // race-installed, same day, different shift
  const gncUser = randomUUID()
  const GNC_DAY = '2026-07-24'
  const GNC_OCCURRED_AT = '2026-07-24T10:00:00.000Z'

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W4C-2 P2-1 remediation integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    priorAllowlistEnv = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED =
      [shadowOrgA, raceOrg, tzRaceOrg, sidOrg, osidOrg, eDay1Org, eDay2Org, fProbeOrg, gncOrg].join(',')

    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    // Group A fixtures.
    await insertLegacyRolloutRow(refOrg)
    await insertActiveUser(refDriftUser, refOrg)
    await insertShift(refShift, refOrg, 'W4C2-P21-Ref', 'UTC', '20:00', '23:00', false)
    await insertAssignment(randomUUID(), refOrg, refDriftUser, refShift, '2026-07-19')

    await insertShadowRolloutRow(shadowOrgA)
    await insertActiveUser(shadowDriftUser, shadowOrgA)
    await insertActiveUser(shadowPlainUser, shadowOrgA)
    await insertShift(shadowShiftA, shadowOrgA, 'W4C2-P21-Shadow', 'UTC', '20:00', '23:00', false)
    await insertAssignment(randomUUID(), shadowOrgA, shadowDriftUser, shadowShiftA, '2026-07-19')
    await insertAssignment(randomUUID(), shadowOrgA, shadowPlainUser, shadowShiftA, '2026-07-19')

    // Group B fixtures (race).
    await insertShadowRolloutRow(raceOrg)
    await insertActiveUser(raceUser, raceOrg)
    await insertActiveUser(raceEvidenceUser, raceOrg)
    await insertShift(raceShiftA, raceOrg, 'W4C2-P21-RaceA', 'UTC', '00:00', '04:00', false)
    await insertShift(raceShiftB, raceOrg, 'W4C2-P21-RaceB', 'UTC', '22:00', '06:00', true)
    // raceUser: only shiftA/day D assigned at route-read time.
    await insertAssignment(randomUUID(), raceOrg, raceUser, raceShiftA, RACE_DAY)
    // raceEvidenceUser: same starting shape, PLUS a pre-existing evidence
    // event tagged to the day the race will re-anchor to (D-1) — the OLD
    // (`input.workDate`) anchor would never load it.
    await insertAssignment(randomUUID(), raceOrg, raceEvidenceUser, raceShiftA, RACE_DAY)
    await pool.query(
      `INSERT INTO attendance_events (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
       VALUES ($1, $2, $3, $4, $5, 'check_in', 'manual', 'UTC', '{}'::jsonb, '{}'::jsonb)`,
      [randomUUID(), raceEvidenceUser, raceOrg, RACE_DAY_PREV, '2026-07-18T23:30:00.000Z'],
    )

    // Group C fixtures (tz-only race).
    await insertShadowRolloutRow(tzRaceOrg)
    await insertActiveUser(tzRaceUser, tzRaceOrg)
    await insertShift(tzRaceShift, tzRaceOrg, 'W4C2-P21-TzRace', 'UTC', '06:00', '22:00', false)
    await insertAssignment(randomUUID(), tzRaceOrg, tzRaceUser, tzRaceShift, '2026-07-19')
    await insertShift(tzRaceControlShift, tzRaceOrg, 'W4C2-P21-TzRaceControl', 'UTC', '06:00', '22:00', false)

    // Group D fixtures (shiftId-only race). Both shifts non-overnight, SAME
    // day (SID_DAY), both windows contain SID_OCCURRED_AT — only shiftX is
    // assigned/active at route-read time.
    await insertShadowRolloutRow(sidOrg)
    await insertActiveUser(sidUser, sidOrg)
    await insertShift(sidShiftX, sidOrg, 'W4C2-P21-SidX', 'UTC', '09:00', '17:00', false)
    await insertShift(sidShiftY, sidOrg, 'W4C2-P21-SidY', 'UTC', '08:00', '18:00', false)
    await insertAssignment(randomUUID(), sidOrg, sidUser, sidShiftX, SID_DAY)

    // Group D-overnight fixtures (overnight shiftId-only race). Both shifts
    // OVERNIGHT, SAME start_date (OSID_DAY), both windows contain
    // OSID_OCCURRED_AT — only shiftX is assigned/active at route-read time.
    await insertShadowRolloutRow(osidOrg)
    await insertActiveUser(osidUser, osidOrg)
    await insertShift(osidShiftX, osidOrg, 'W4C2-P21-OsidX', 'UTC', '22:00', '06:00', true)
    await insertShift(osidShiftY, osidOrg, 'W4C2-P21-OsidY', 'UTC', '21:00', '07:00', true)
    await insertAssignment(randomUUID(), osidOrg, osidUser, osidShiftX, OSID_DAY)

    // Group E fixtures (L2/L3 exclusive discriminating legs). Both use the
    // SAME overnight shift shape (belongs to day EDAY); only occurredAt and
    // client tz differ between the two orgs.
    await insertShadowRolloutRow(eDay1Org)
    await insertActiveUser(eDay1User, eDay1Org)
    await insertShift(eDay1Shift, eDay1Org, 'W4C2-P21-EDay1', 'UTC', '22:00', '06:00', true)
    await insertAssignment(randomUUID(), eDay1Org, eDay1User, eDay1Shift, EDAY)

    await insertShadowRolloutRow(eDay2Org)
    await insertActiveUser(eDay2User, eDay2Org)
    await insertShift(eDay2Shift, eDay2Org, 'W4C2-P21-EDay2', 'UTC', '22:00', '06:00', true)
    await insertAssignment(randomUUID(), eDay2Org, eDay2User, eDay2Shift, EDAY)

    // Group F fixtures (O-5 probe). Byte-identical shift geometry to Group E's
    // eDay2, own org/user/shift so the two operations cannot interfere.
    await insertShadowRolloutRow(fProbeOrg)
    await insertActiveUser(fProbeUser, fProbeOrg)
    await insertShift(fProbeShift, fProbeOrg, 'W4C2-P21-FProbe', 'UTC', '22:00', '06:00', true)
    await insertAssignment(randomUUID(), fProbeOrg, fProbeUser, fProbeShift, FPROBE_EDAY)

    // Group G fixtures (gate4 P2 closure — null-frozen-context shiftId-only
    // race). Both shifts non-overnight, SAME day (GNC_DAY), both windows
    // contain GNC_OCCURRED_AT — only gncShiftX is assigned/active at
    // route-read time (identical shape to Group D otherwise). The
    // deliberately non-dense `segment_index = 1` row on EACH shift is what
    // makes `buildW4ShadowFrozenContextV1` return `null` for both —
    // `insertShift` alone (no segment rows) would instead fall through to
    // the legacy work_start_time/work_end_time single-segment fallback and
    // produce a NON-null context, which is exactly the Group D shape this
    // leg needs to differ from.
    await insertShadowRolloutRow(gncOrg)
    await insertActiveUser(gncUser, gncOrg)
    await insertShift(gncShiftX, gncOrg, 'W4C2-P21-GncX', 'UTC', '09:00', '17:00', false)
    await insertShift(gncShiftY, gncOrg, 'W4C2-P21-GncY', 'UTC', '08:00', '18:00', false)
    for (const shiftId of [gncShiftX, gncShiftY]) {
      await pool.query(
        `INSERT INTO attendance_shift_segments
           (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
         VALUES ($1, $2, 1, '09:00', 0, '17:00', 0)`,
        [gncOrg, shiftId],
      )
    }
    await insertAssignment(randomUUID(), gncOrg, gncUser, gncShiftX, GNC_DAY)
  }, 120000)

  afterAll(async () => {
    for (const userId of [refDriftUser, shadowDriftUser, shadowPlainUser, raceUser, raceEvidenceUser, tzRaceUser, sidUser, osidUser, eDay1User, eDay2User, fProbeUser, gncUser]) {
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
    }
    if (priorAllowlistEnv === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlistEnv
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
  }, 60000)

  it('L1 + L4: canonical shadow freeze-step attribution byte-matches the legacy reference resolution (drift), and a non-drift punch resolves identically (positive control)', async () => {
    // Reference: legacy posture, SAME shift/day/instant, client tz drifts
    // from the shift's own tz — already mutation-proven (P1 remediation) to
    // reproduce the route's own PRE-resolution W2 call.
    const refToken = await mintToken(refDriftUser)
    const ref = await punch(refToken, {
      eventType: 'check_in', occurredAt: '2026-07-19T22:00:00.000Z', timezone: 'Asia/Tokyo', orgId: refOrg,
    })
    expect(ref.status, ref.raw).toBe(200)
    assertLegacyPunchResponseGoldenShapeResolvedV1(ref.body.data, {
      userId: refDriftUser,
      status: 'partial',
      workMinutes: 0,
      lateMinutes: 0,
      firstInAt: ref.body.data.event.occurred_at,
      lastOutAt: null,
      calendarWorkDate: '2026-07-20',
      reasonCode: 'SINGLE_MATCHING_CANDIDATE',
      shiftId: refShift,
      resolvedWorkDate: '2026-07-19',
      matchingCount: 1,
    })
    const refWinner = ref.body.data.workDateResolution.evidenceSnapshot.winner

    // L1: shadow posture, drift user, IDENTICAL shift/day/instant shape.
    const driftToken = await mintToken(shadowDriftUser)
    const drift = await punch(driftToken, {
      eventType: 'check_in', occurredAt: '2026-07-19T22:00:00.000Z', timezone: 'Asia/Tokyo', orgId: shadowOrgA, operationId: randomUUID(),
    })
    expect(drift.status, drift.raw).toBe(200)
    const driftCalcs = await calculationRowsForUser(shadowDriftUser)
    expect(driftCalcs.length).toBe(1)
    expect(driftCalcs[0].attribution_snapshot.posture).toBe('resolved_v2')
    const driftValue = driftCalcs[0].attribution_snapshot.value
    expect(driftValue.workDate).toBe('2026-07-19')
    expect(driftValue.shiftId).toBe(shadowShiftA)
    expect(driftValue.reasonCode).toBe('SINGLE_MATCHING_CANDIDATE')
    expect(driftValue.absoluteWindow).toEqual(refWinner.absoluteWindow)
    // #4612 gate3 P2-1 self-report ④ closure (previously-retracted claim):
    // `attributionWindow` precise ISO values were never asserted on this
    // canonical/shadow branch. Pin them exactly, but WITHOUT hardcoding the
    // ops-configurable tail minutes as a magic literal (mutation table item
    // 12's own disclosed-gap note: "attributionWindow 端用『绝对端+冻结
    // tail 自洽』断言，tail 源不锁死具体值") — derive the expected `endAt`
    // from the ALSO-persisted, ALSO-asserted `absoluteWindow.endAt` and
    // `attributionTailMinutes` fields instead of a bare number.
    expect(Number.isInteger(driftValue.attributionTailMinutes) && driftValue.attributionTailMinutes >= 0).toBe(true)
    expect(driftValue.extendedByApprovedOvertime).toBe(false)
    expect(driftValue.attributionWindow.startAt).toBe(driftValue.absoluteWindow.startAt)
    expect(driftValue.attributionWindow.endAt).toBe(
      new Date(
        new Date(driftValue.absoluteWindow.endAt).getTime() + driftValue.attributionTailMinutes * 60_000,
      ).toISOString(),
    )
    // #4612 gate3 P2-1 round 3 finding ②: `.toMatch(/^[0-9a-f]{64}$/)` has
    // ZERO discriminating power — ANY 64-hex value satisfies it, including a
    // completely wrong one. Replaced with VALUE-PROVENANCE assertions:
    // independently recompute each fingerprint (from the SAME persisted
    // inputs, via the real production functions, NOT reusing anything the
    // tested code path itself returned) and require the stored column to
    // equal that recomputation exactly. SCOPE (honest limit): this pins the
    // stored column to "this production function's output on the stored
    // inputs" — it does NOT pin the function's own DEFINITION. If
    // `computeAttendanceSemanticInputFingerprintV1`/`computeAttendance
    // SourceDefinitionFingerprintV1` themselves changed (e.g. a domain
    // separator or a projected field), both sides of this comparison move
    // together and this assertion stays green; it is not a substitute for a
    // dedicated fingerprint-definition regression test (none exists here).
    const recomputedSemanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
      attribution: driftCalcs[0].attribution_snapshot,
      context: driftCalcs[0].context_snapshot,
      evidence: driftCalcs[0].evidence_snapshot,
      approvedFacts: driftCalcs[0].approved_facts_snapshot,
      manualOverride: driftCalcs[0].manual_override_snapshot,
      mergePolicy: driftCalcs[0].merge_policy,
      calculationTier: driftCalcs[0].calculation_tier,
      engineVersion: driftCalcs[0].engine_version,
      snapshotSchemaVersion: driftCalcs[0].snapshot_schema_version,
    })
    expect(driftCalcs[0].semantic_input_fingerprint).toBe(recomputedSemanticFingerprint)
    // #4612 gate3 P2-1 self-report ⑥ closure: `source_definition_fingerprint`
    // must be sealed from the dedicated W4C-1 domain
    // (`computeAttendanceSourceDefinitionFingerprintV1`), never aliased to
    // `semantic_input_fingerprint` (a DIFFERENT, domain-separated hash) —
    // the two must differ even though both are computed from overlapping
    // attribution/context inputs, because they hash under different
    // domain-separation prefixes and (semantic) additionally folds in
    // evidence/approvedFacts/mergePolicy/calculationTier/engineVersion.
    const recomputedSourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({
      attribution: driftCalcs[0].attribution_snapshot,
      context: driftCalcs[0].context_snapshot,
    })
    expect(driftCalcs[0].source_definition_fingerprint).toBe(recomputedSourceDefinitionFingerprint)
    expect(driftCalcs[0].source_definition_fingerprint).not.toBe(driftCalcs[0].semantic_input_fingerprint)

    // "Hex-swap knife" (round 3 finding ②): prove the equality assertions
    // above actually discriminate. `attendance_record_calculations` is
    // append-only (a real `UPDATE` against it was tried while drafting this
    // probe and hit `W4C0_IMMUTABLE: UPDATE is not permitted` — the trigger
    // `attendance_w4_deny_mutation`, itself a real invariant this suite does
    // NOT want to bypass) — so the swap is demonstrated on a value, not by
    // mutating the immutable row: a DIFFERENT, still-legal, 64-hex value is
    // exactly what the old `.toMatch(/^[0-9a-f]{64}$/)` regex would have
    // accepted (proving it had zero discriminating power), and is exactly
    // what the NEW value-provenance assertion (`.toBe(recomputed...)`)
    // rejects — i.e. this is the literal boolean the real assertion would
    // evaluate to `false` on if the column ever held this value instead.
    const wrongButLegalHex = (randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')).slice(0, 64)
    expect(wrongButLegalHex).toMatch(/^[0-9a-f]{64}$/) // old regex: would have passed (zero discrimination)
    expect(wrongButLegalHex).not.toBe(recomputedSourceDefinitionFingerprint) // new assertion: correctly rejects it

    expect(driftCalcs[0].context_snapshot.workDate).toBe('2026-07-19')

    // L4 positive control: client tz == shift tz (no drift) resolves
    // identically to the drift leg — L1 is not fail-closed by construction.
    const plainToken = await mintToken(shadowPlainUser)
    const plain = await punch(plainToken, {
      eventType: 'check_in', occurredAt: '2026-07-19T22:00:00.000Z', timezone: 'UTC', orgId: shadowOrgA, operationId: randomUUID(),
    })
    expect(plain.status, plain.raw).toBe(200)
    const plainCalcs = await calculationRowsForUser(shadowPlainUser)
    expect(plainCalcs.length).toBe(1)
    expect(plainCalcs[0].attribution_snapshot.posture).toBe('resolved_v2')
    expect(plainCalcs[0].attribution_snapshot.value.workDate).toBe('2026-07-19')
    expect(plainCalcs[0].attribution_snapshot.value.shiftId).toBe(shadowShiftA)
    expect(plainCalcs[0].outcome).toBe('completed')
  })

  it('L5 + L7: a genuine DB-state race between the route read and the canonical transaction hits the step-7 candidate-identity gate (review_required/context_mismatch, zero segments, legacy projection intact); evidence is anchored to the re-resolved day', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }

    async function runRace(userId: string): Promise<HttpResponse> {
      let signalReached: () => void
      const reached = new Promise<void>((resolve) => { signalReached = resolve })
      let release: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      setSeam(async () => {
        signalReached()
        await released
      })
      try {
        const token = await mintToken(userId)
        const punchPromise = punch(token, {
          eventType: 'check_in', occurredAt: RACE_OCCURRED_AT, timezone: 'UTC', orgId: raceOrg, operationId: randomUUID(),
        })
        await reached
        // Connection B: remove the route-visible candidate (shiftA/day D)
        // and install a DIFFERENT single candidate (shiftB, overnight,
        // day D-1) whose absolute window ALSO contains the fixed punch
        // instant — a genuine committed write, fully independent of A.
        const asgA = (await pool.query(
          'SELECT id::text AS id FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2 AND shift_id = $3',
          [raceOrg, userId, raceShiftA],
        )).rows[0].id
        await pool.query('UPDATE attendance_shift_assignments SET is_active = false WHERE id = $1', [asgA])
        await pool.query(
          `INSERT INTO attendance_shift_assignments
             (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
           VALUES ($1, $2, $3, $4, $5, $5, true, 'published', 1)`,
          [randomUUID(), raceOrg, userId, raceShiftB, RACE_DAY_PREV],
        )
        release!()
        return await punchPromise
      } finally {
        setSeam(null)
      }
    }

    // L5.
    const res = await runRace(raceUser)
    expect(res.status, res.raw).toBe(200)
    expect(res.body?.ok).toBe(true)
    // Legacy projection intact: event/record written at the route's OWN
    // (pre-race) work date, unaffected by the canonical-side downgrade.
    const rows = await recordRow(raceUser)
    expect(rows.length).toBe(1)
    expect(rows[0].work_date).toBe(RACE_DAY)

    const calcs = await calculationRowsForUser(raceUser)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].outcome_reason_code).toBe('context_mismatch')
    expect(calcs[0].expected_segment_count).toBe(0)
    expect(await segmentCountForCalculation(calcs[0].id)).toBe(0)
    // The freeze step genuinely re-resolved in-transaction (to the NEW,
    // race-installed winner) rather than trusting the route's stale value.
    expect(calcs[0].attribution_snapshot.posture).toBe('resolved_v2')
    expect(calcs[0].attribution_snapshot.value.workDate).toBe(RACE_DAY_PREV)
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(raceShiftB)

    // L7 (same race, separate user with a pre-existing event tagged to the
    // CORRECT anchor day RACE_DAY_PREV — the OLD `input.workDate` anchor
    // would only ever see the just-written RACE_DAY event).
    const evRes = await runRace(raceEvidenceUser)
    expect(evRes.status, evRes.raw).toBe(200)
    const evCalcs = await calculationRowsForUser(raceEvidenceUser)
    expect(evCalcs.length).toBe(1)
    expect(evCalcs[0].outcome).toBe('review_required')
    const evidence = evCalcs[0].evidence_snapshot as Array<{ ref: string; direction: string }>
    expect(evidence.length).toBe(1)
    expect(evidence[0].direction).toBe('check_in')
    // The pre-existing RACE_DAY_PREV-tagged event is present; the
    // just-written RACE_DAY event (legacy's own write, at the route's stale
    // work date) is NOT — proving the evidence anchor is the freeze step's
    // own re-resolved day, not `input.workDate`.
    const preExisting = await pool.query(
      `SELECT id::text AS id FROM attendance_events WHERE user_id = $1 AND work_date = $2`,
      [raceEvidenceUser, RACE_DAY_PREV],
    )
    expect(preExisting.rows.length).toBe(1)
    expect(evidence[0].ref).toBe(preExisting.rows[0].id)
  })

  // L6, RE-SCOPED TWICE:
  //
  // Round 1 (mutation self-check finding, disclosed): the freeze-step fix at
  // `w4c2-live-scheduled-boundary.ts` (`timezone: resolution.fullWinner?.timezone
  // ?? input.requestTimezone` passed into `buildShadowFrozenContext`) is
  // CORRECT per the lock's Q16/Q17 but is OBSERVABLY INERT for this leg:
  // `buildW4ShadowFrozenContextV1` (`index.cjs` ~L21519) independently
  // re-reads the winning shift row FRESH, in the same transaction, and
  // overrides whatever `timezone` parameter the caller passes whenever the
  // row's own `timezone` column is non-blank — which is every constructible
  // fixture here. Mutation-verified twice (reverting the argument to
  // `input.timezone`, and replacing it with a nonsense literal), both left
  // THIS ORIGINAL leg green (`context_snapshot.timezone` stayed
  // `'Asia/Kolkata'` either way) — it does NOT discriminate that line, but
  // proves a real, valuable, DIFFERENT property: the frozen context
  // reflects the TRANSACTION's own in-flight read, not the route's
  // pre-race value.
  //
  // Round 2 (#4612 gate3 P2-1 closure, second round — this leg is now ALSO
  // the fingerprint-only discriminating leg for §8.2 step 7's second
  // clause): `workDate`/`shiftId` (candidate IDENTITY) are UNCHANGED by
  // this race by construction — only the winning shift's OWN `timezone`
  // column changes underneath the SAME shiftId — so before the
  // source-definition fingerprint half was wired, `outcome` stayed
  // `completed` (real DB evidence retained in the PR body: two pre-fix rows
  // both show `outcome='calculated'`/`completed` with
  // `context_snapshot.timezone='Asia/Kolkata'`). With the fingerprint half
  // wired, the OUTER (pre-race) and INNER (post-race) source-definition
  // fingerprints now differ (via `context.timezone` and the strict-rebuild
  // `absoluteWindow`/`attributionWindow`, which both shift with the raced
  // timezone) even though identity does not — `outcome` now correctly
  // flips to `review_required`/`context_mismatch`. This is the leg that
  // demonstrates the identity conjunct alone is NOT sufficient: an
  // in-place shift-definition edit under a stable shiftId is exactly the
  // race class the lock's "source-definition fingerprint" clause exists to
  // catch, and it was previously silent.
  it('L6 (re-scoped twice): identity is UNCHANGED by this race, but the winning shift\'s OWN definition changes underneath it — the fingerprint-only conjunct now catches what the identity conjunct alone cannot', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(tzRaceUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: TZ_RACE_OCCURRED_AT, timezone: 'UTC', orgId: tzRaceOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B: ONLY the shift row's own timezone column changes —
      // same shiftId, same assignment, same day. The shift's wide 06:00-22:00
      // window still contains the fixed punch instant after the tz shift
      // (Asia/Kolkata is UTC+5:30: local 06:00-22:00 -> 00:30-16:30 UTC,
      // which still contains 12:00Z).
      await pool.query(`UPDATE attendance_shifts SET timezone = 'Asia/Kolkata' WHERE id = $1`, [tzRaceShift])
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
    }

    expect(res.status, res.raw).toBe(200)
    const calcs = await calculationRowsForUser(tzRaceUser)
    expect(calcs.length).toBe(1)
    // Identity (workDate/shiftId) is UNCHANGED by this race — kept from
    // round 1, still true and still worth asserting explicitly (the
    // identity conjunct must NOT be the reason this leg goes red).
    expect(calcs[0].attribution_snapshot.value.workDate).toBe('2026-07-19')
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(tzRaceShift)
    // Round 1's property still holds: the frozen context reflects the
    // TRANSACTION's own in-flight read of the winning shift row, not the
    // route's pre-race value.
    expect(calcs[0].context_snapshot.timezone).toBe('Asia/Kolkata')
    // Round 2 (NEW): the fingerprint-only conjunct now catches this —
    // outer (pre-race) and inner (post-race) source-definition fingerprints
    // differ even though identity does not.
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].outcome_reason_code).toBe('context_mismatch')
    expect(calcs[0].expected_segment_count).toBe(0)
    expect(await segmentCountForCalculation(calcs[0].id)).toBe(0)
  })

  // Race-genuineness control for L6 (round 3 finding ③, `feedback_toctou_
  // needs_constructed_race` / `feedback_positive_control_not_failclosed`):
  // Group D, Group D-overnight, and Group E all have a positive control —
  // L6, the ONLY leg that proves the NEW fingerprint-only conjunct on its
  // own, did not. With connection B's timezone-swap UPDATE removed (seam
  // pause kept, identical fixture shape, own user so it cannot collide with
  // L6's own row), the SAME punch must complete normally — otherwise L6's
  // `review_required` could be an artifact of fixture assembly order (e.g.
  // an env/allowlist mismatch, a stale rollout row) rather than the
  // constructed shift-definition race.
  it('L6 positive control: with connection B disarmed (no timezone swap), the SAME punch shape completes normally', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }
    const controlUser = randomUUID()
    await insertActiveUser(controlUser, tzRaceOrg)
    // Uses `tzRaceControlShift` — its OWN, never-raced shift row — NOT
    // `tzRaceShift` (see that const's own comment: L6's race committed a
    // permanent `timezone='Asia/Kolkata'` mutation on `tzRaceShift` itself,
    // which would make this control observe 'Asia/Kolkata' unconditionally
    // regardless of connection B, independent of test declaration order).
    await insertAssignment(randomUUID(), tzRaceOrg, controlUser, tzRaceControlShift, '2026-07-19')

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(controlUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: TZ_RACE_OCCURRED_AT, timezone: 'UTC', orgId: tzRaceOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B intentionally disarmed: no timezone mutation at all.
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [controlUser]).catch(() => undefined)
    }

    expect(res.status, res.raw).toBe(200)
    const calcs = await calculationRowsForUser(controlUser)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('completed')
    expect(calcs[0].outcome_reason_code).not.toBe('context_mismatch')
    expect(calcs[0].context_snapshot.timezone).not.toBe('Asia/Kolkata')
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(tzRaceControlShift)
  })

  // Group D (#4612 gate3 P2-1 self-report ⑥ closure). Before the step-7 gate
  // widening this leg observably slipped through: `identityDrift` compared
  // ONLY `workDate` (unchanged by this race by construction), so the
  // shadow calculation completed against the RACE-INSTALLED shift's context
  // with `outcome='completed'` — a fail-open. Proven via the mutation table
  // in the PR body (neutering the `shiftId` half of the IDENTITY conjunct,
  // AS IT STOOD in that round, flipped this leg's `outcome` assertion back
  // to `completed`, matching pre-fix behavior byte-for-byte).
  //
  // #4612 gate3 P2-1 closure, SECOND round (source-definition fingerprint
  // half landed): this leg is NO LONGER identity-exclusive. `shiftId` is
  // part of BOTH conjuncts now (the fingerprint domain's `attribution.value`
  // and `context` both carry `shiftId`), so neutering the identity conjunct
  // ALONE no longer flips this leg back to `completed` — the fingerprint
  // conjunct independently catches the same race. See the PR body's 2×2
  // exclusivity matrix (neuter identity alone / neuter fingerprint alone /
  // neuter both) for the corrected, empirically re-verified numbers; the
  // single-conjunct claim above is retained as a historical record of what
  // was true in that earlier round, not a claim about current behavior.
  it('Group D: a shiftId-ONLY race (workDate held fixed, only the winning shift swaps) hits the widened step-7 identity+fingerprint gate (BOTH conjuncts fire — this is NOT an identity-only-discriminating leg, see Group G for the leg that is)', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(sidUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: SID_OCCURRED_AT, timezone: 'UTC', orgId: sidOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B: swap the ACTIVE assignment from shiftX to shiftY —
      // SAME user, SAME day (SID_DAY), a genuine committed write fully
      // independent of connection A. Both shifts' windows contain
      // SID_OCCURRED_AT, so the in-transaction re-resolution stays
      // non-ambiguous (single matching candidate) throughout.
      const asgX = (await pool.query(
        'SELECT id::text AS id FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2 AND shift_id = $3',
        [sidOrg, sidUser, sidShiftX],
      )).rows[0].id
      await pool.query('UPDATE attendance_shift_assignments SET is_active = false WHERE id = $1', [asgX])
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
         VALUES ($1, $2, $3, $4, $5, $5, true, 'published', 1)`,
        [randomUUID(), sidOrg, sidUser, sidShiftY, SID_DAY],
      )
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
    }

    expect(res.status, res.raw).toBe(200)
    expect(res.body?.ok).toBe(true)
    // Legacy projection intact: still keyed at SID_DAY (the day never
    // changed in this race), unaffected by the canonical-side downgrade.
    const rows = await recordRow(sidUser)
    expect(rows.length).toBe(1)
    expect(rows[0].work_date).toBe(SID_DAY)

    const calcs = await calculationRowsForUser(sidUser)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].outcome_reason_code).toBe('context_mismatch')
    expect(calcs[0].expected_segment_count).toBe(0)
    expect(await segmentCountForCalculation(calcs[0].id)).toBe(0)
    // The freeze step genuinely re-resolved in-transaction to the
    // race-installed winner (shiftY) — same day, DIFFERENT shift — proving
    // the gate is driven by the transaction's own snapshot, not a stale
    // route value.
    expect(calcs[0].attribution_snapshot.posture).toBe('resolved_v2')
    expect(calcs[0].attribution_snapshot.value.workDate).toBe(SID_DAY)
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(sidShiftY)
  })

  // Race-genuineness control for Group D (`feedback_toctou_needs_constructed_race`):
  // with connection B's two writes (deactivate asgX / install shiftY) removed
  // and the seam pause kept, the SAME punch must complete normally —
  // otherwise Group D's `review_required` would be an artifact of fixture
  // assembly order, not the constructed race.
  it('Group D positive control: with connection B disarmed (no shift swap), the SAME punch shape completes normally', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }
    const controlUser = randomUUID()
    await insertActiveUser(controlUser, sidOrg)
    await insertAssignment(randomUUID(), sidOrg, controlUser, sidShiftX, SID_DAY)

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(controlUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: SID_OCCURRED_AT, timezone: 'UTC', orgId: sidOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B intentionally disarmed: no assignment mutation at all.
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [controlUser]).catch(() => undefined)
    }

    expect(res.status, res.raw).toBe(200)
    const calcs = await calculationRowsForUser(controlUser)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('completed')
    expect(calcs[0].outcome_reason_code).not.toBe('context_mismatch')
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(sidShiftX)
  })

  // Group D-overnight (#4612 gate3 P2-1 second closure round self-report
  // ③: "Group D only covered a non-overnight shiftId-only race"). Same
  // race shape as Group D, but both candidate shifts are OVERNIGHT with the
  // SAME `start_date` (OSID_DAY) — identity's `workDate` half stays fixed
  // at OSID_DAY across the race (the overnight candidate's own `workDate`
  // is the night it starts, not the calendar day the punch instant falls
  // on), only `shiftId` swaps.
  it('Group D-overnight: a shiftId-ONLY race between two OVERNIGHT shifts sharing the same start_date hits the widened step-7 identity+fingerprint gate (BOTH conjuncts fire — this is NOT an identity-only-discriminating leg, see Group G for the leg that is)', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(osidUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: OSID_OCCURRED_AT, timezone: 'UTC', orgId: osidOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B: swap the ACTIVE assignment from shiftX to shiftY —
      // SAME user, SAME start_date (OSID_DAY), a genuine committed write
      // fully independent of connection A. Both overnight shifts' windows
      // contain OSID_OCCURRED_AT, so the in-transaction re-resolution stays
      // non-ambiguous (single matching candidate) throughout.
      const asgX = (await pool.query(
        'SELECT id::text AS id FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2 AND shift_id = $3',
        [osidOrg, osidUser, osidShiftX],
      )).rows[0].id
      await pool.query('UPDATE attendance_shift_assignments SET is_active = false WHERE id = $1', [asgX])
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
         VALUES ($1, $2, $3, $4, $5, $5, true, 'published', 1)`,
        [randomUUID(), osidOrg, osidUser, osidShiftY, OSID_DAY],
      )
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
    }

    expect(res.status, res.raw).toBe(200)
    expect(res.body?.ok).toBe(true)

    const calcs = await calculationRowsForUser(osidUser)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].outcome_reason_code).toBe('context_mismatch')
    expect(calcs[0].expected_segment_count).toBe(0)
    expect(await segmentCountForCalculation(calcs[0].id)).toBe(0)
    // The freeze step genuinely re-resolved in-transaction to the
    // race-installed winner (shiftY) — SAME start_date (identity's
    // `workDate` half unchanged, exactly like Group D), DIFFERENT shift.
    expect(calcs[0].attribution_snapshot.posture).toBe('resolved_v2')
    expect(calcs[0].attribution_snapshot.value.workDate).toBe(OSID_DAY)
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(osidShiftY)
  })

  // Race-genuineness control for Group D-overnight (same discipline as
  // Group D's own positive control, `feedback_toctou_needs_constructed_race`).
  it('Group D-overnight positive control: with connection B disarmed (no shift swap), the SAME punch shape completes normally', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }
    const controlUser = randomUUID()
    await insertActiveUser(controlUser, osidOrg)
    await insertAssignment(randomUUID(), osidOrg, controlUser, osidShiftX, OSID_DAY)

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(controlUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: OSID_OCCURRED_AT, timezone: 'UTC', orgId: osidOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B intentionally disarmed: no assignment mutation at all.
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [controlUser]).catch(() => undefined)
    }

    expect(res.status, res.raw).toBe(200)
    const calcs = await calculationRowsForUser(controlUser)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('completed')
    expect(calcs[0].outcome_reason_code).not.toBe('context_mismatch')
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(osidShiftX)
  })

  // Group G (#4612 gate4 P2 closure — independent-review finding: neutering
  // ONLY the identity conjunct, `identityMismatch` (`const identityMismatch =`
  // in `w4c2-live-scheduled-boundary.ts` — symbol reference, not a line
  // number: see NIT-1 gate4 round 3), left ALL 48 real-DB W4C-2 legs in this
  // suite family green — zero discriminating signature — while neutering
  // ONLY the fingerprint conjunct (`const fingerprintMismatch =`, same file)
  // reds exactly L6.
  // Group D/D-overnight do NOT close this gap: their fingerprint domain is
  // non-null (a well-formed shift's context always resolves), and that
  // domain CONTAINS `shiftId`, so a shiftId swap trips fingerprint too —
  // identity is never the SOLE discriminator on those legs. This leg gives
  // identity a real, if narrow, exclusive leg by making the fingerprint
  // conjunct structurally silent: BOTH candidate shifts (gncShiftX,
  // gncShiftY) carry a single non-dense `attendance_shift_segments` row
  // (`segment_index = 1`, no row 0), which `buildW4ShadowFrozenContextV1`
  // rejects (`index !== i`, `index.cjs` ~L21479) — so `context` is `null`
  // on BOTH the outer (pre-race) and inner (post-race) reads.
  // `computeAttendanceOuterComparableSourceDefinitionFingerprintV1` returns
  // `null` whenever `context === null` (`sourceDefinitionInputOrNull`,
  // `w4c1-fingerprints.ts`), so `fingerprintMismatch` compares `null !==
  // null` — always `false`, regardless of the race. Disclosed deviation
  // from the row-0/well-formed shift shape every other leg in this file
  // uses: the sparse segment_index is a deliberately MALFORMED fixture (see
  // the leg-map comment atop this file and `w4c2-live-scheduled-
  // boundary.ts`'s STRUCTURAL NOTE) — not a production-reachable state (the
  // canonical shift service only ever writes dense 0..2 segment rows).
  it('Group G: a shiftId-ONLY race where BOTH candidate shifts have a null frozen context hits the step-7 gate on the identity conjunct ALONE (fingerprint conjunct is structurally silent, null === null)', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(gncUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: GNC_OCCURRED_AT, timezone: 'UTC', orgId: gncOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B: swap the ACTIVE assignment from gncShiftX to
      // gncShiftY — SAME user, SAME day (GNC_DAY), a genuine committed
      // write fully independent of connection A. Both shifts' windows
      // contain GNC_OCCURRED_AT, so the in-transaction re-resolution stays
      // non-ambiguous (single matching candidate) throughout.
      const asgX = (await pool.query(
        'SELECT id::text AS id FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2 AND shift_id = $3',
        [gncOrg, gncUser, gncShiftX],
      )).rows[0].id
      await pool.query('UPDATE attendance_shift_assignments SET is_active = false WHERE id = $1', [asgX])
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
         VALUES ($1, $2, $3, $4, $5, $5, true, 'published', 1)`,
        [randomUUID(), gncOrg, gncUser, gncShiftY, GNC_DAY],
      )
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
    }

    expect(res.status, res.raw).toBe(200)
    expect(res.body?.ok).toBe(true)
    // Legacy projection intact: still keyed at GNC_DAY (the day never
    // changed in this race), unaffected by the canonical-side downgrade.
    const rows = await recordRow(gncUser)
    expect(rows.length).toBe(1)
    expect(rows[0].work_date).toBe(GNC_DAY)

    const calcs = await calculationRowsForUser(gncUser)
    expect(calcs.length).toBe(1)
    // The identity-conjunct-driven review: `context_mismatch`, NOT
    // `missing_frozen_context` (the reason the null-context calculator
    // would otherwise assign, see the positive control below) — this is
    // the discriminating assertion; neutering `identityMismatch` alone
    // flips this to `missing_frozen_context` (see the PR's mutation table).
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].outcome_reason_code).toBe('context_mismatch')
    expect(calcs[0].expected_segment_count).toBe(0)
    expect(await segmentCountForCalculation(calcs[0].id)).toBe(0)
    // The freeze step genuinely re-resolved in-transaction to the
    // race-installed winner (shiftY) — same day, DIFFERENT shift — proving
    // the gate is driven by the transaction's own snapshot, not a stale
    // route value. `context_snapshot` is null on BOTH candidates by
    // construction (the fixture's whole point), asserted here to nail down
    // that this leg is genuinely in the null-context regime and not
    // accidentally resolving a non-null context.
    expect(calcs[0].attribution_snapshot.posture).toBe('resolved_v2')
    expect(calcs[0].attribution_snapshot.value.workDate).toBe(GNC_DAY)
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(gncShiftY)
    expect(calcs[0].context_snapshot).toBe(null)
  })

  // Race-genuineness control for Group G. Disclosed deviation from
  // `feedback_toctou_needs_constructed_race`'s literal "disarmed connection
  // B ⇒ SAME outcome shape as before the race" bar: for Group D/D-overnight
  // that bar is `outcome` flipping `review_required` -> `completed`, but
  // for Group G `context === null` is a FIXTURE property of BOTH candidate
  // shifts (gncShiftX and gncShiftY are equally malformed), so disarming
  // connection B can NEVER reach `completed` here — the null-context
  // calculator (`w4c1-segment-calculator.ts:797`) always assigns
  // `review_required`/`missing_frozen_context` regardless of the race. The
  // equivalent-strength discriminator this control asserts instead: with
  // NO swap, the identity conjunct sees the SAME shiftId on both the outer
  // and inner reads (`identityMismatch` is false without any mutation), so
  // `outcome_reason_code` falls through to the calculator's own
  // `missing_frozen_context` — DIFFERENT from the raced leg's
  // `context_mismatch` above — and `attribution_snapshot.value.shiftId`
  // stays gncShiftX (never swapped). Only a real committed write from
  // connection B can produce the raced leg's `context_mismatch` +
  // gncShiftY combination; this control proves that combination is not an
  // artifact of fixture assembly order.
  it('Group G positive control: with connection B disarmed (no shift swap), the reason code falls through to the null-context calculator (missing_frozen_context, NOT context_mismatch) and shiftId never leaves gncShiftX', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }
    const controlUser = randomUUID()
    await insertActiveUser(controlUser, gncOrg)
    await insertAssignment(randomUUID(), gncOrg, controlUser, gncShiftX, GNC_DAY)

    let signalReached: () => void
    const reached = new Promise<void>((resolve) => { signalReached = resolve })
    let release: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    setSeam(async () => {
      signalReached()
      await released
    })
    let res: HttpResponse
    try {
      const token = await mintToken(controlUser)
      const punchPromise = punch(token, {
        eventType: 'check_in', occurredAt: GNC_OCCURRED_AT, timezone: 'UTC', orgId: gncOrg, operationId: randomUUID(),
      })
      await reached
      // Connection B intentionally disarmed: no assignment mutation at all.
      release!()
      res = await punchPromise
    } finally {
      setSeam(null)
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [controlUser]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [controlUser]).catch(() => undefined)
    }

    expect(res.status, res.raw).toBe(200)
    const calcs = await calculationRowsForUser(controlUser)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].outcome_reason_code).toBe('missing_frozen_context')
    expect(calcs[0].outcome_reason_code).not.toBe('context_mismatch')
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(gncShiftX)
    expect(calcs[0].context_snapshot).toBe(null)
  })

  // Group E (#4612 gate3 P2-1 self-report ③' closure — advisor-corrected
  // construction, superseding an earlier WRONG "structurally
  // indistinguishable" claim for the case where L2/L3 are BOTH wrong on the
  // SAME fixture). Zero concurrency — these are direct assertions on the
  // resolved `reasonCode`, not races. Split into TWO independent `it`
  // blocks (not one, combined) deliberately: vitest stops at the first
  // failed `expect`, so a combined block would silently mask whichever
  // fixture's assertion comes second during mutation testing — the exact
  // "asserted invariant, never independently reached" failure mode this
  // repo has hit before (see the PR body's earlier ⑥ self-report). Each
  // block's mutation behavior is independently observable.
  it('Group E / eDay1: correct resolution isolates L2 (mutation table in PR body: L2 fires, L3 silent on this fixture)', async () => {
    const token1 = await mintToken(eDay1User)
    const res1 = await punch(token1, {
      eventType: 'check_in', occurredAt: EDAY1_OCCURRED_AT, timezone: 'Etc/GMT+7', orgId: eDay1Org, operationId: randomUUID(),
    })
    expect(res1.status, res1.raw).toBe(200)
    const calcs1 = await calculationRowsForUser(eDay1User)
    expect(calcs1.length).toBe(1)
    expect(calcs1[0].outcome).toBe('completed')
    expect(calcs1[0].attribution_snapshot.value.workDate).toBe(EDAY)
    expect(calcs1[0].attribution_snapshot.value.reasonCode).toBe('CURRENT_DAY_CONTAINING_SHIFT')
  })

  it('Group E / eDay2: correct resolution isolates L3 (mutation table in PR body: L2 silent, L3 fires on this fixture)', async () => {
    const token2 = await mintToken(eDay2User)
    const res2 = await punch(token2, {
      eventType: 'check_in', occurredAt: EDAY2_OCCURRED_AT, timezone: 'Asia/Tokyo', orgId: eDay2Org, operationId: randomUUID(),
    })
    expect(res2.status, res2.raw).toBe(200)
    const calcs2 = await calculationRowsForUser(eDay2User)
    expect(calcs2.length).toBe(1)
    expect(calcs2[0].outcome).toBe('completed')
    expect(calcs2[0].attribution_snapshot.value.workDate).toBe(EDAY)
    // Not `PREVIOUS_NIGHT_CONTAINING_SHIFT` as first hand-derived: the
    // legacy adapter's OWN in-transaction write (executed just before the
    // freeze step's resolution, same punch) already created an open
    // attendance_records row for EDAY (first_in_at set, no last_out_at) —
    // `openPreviousMatches` (checked BEFORE `previousNightContaining` in
    // `selectAmongMatchingCandidates`) matches it first. Corrected against
    // the real DB run (not re-guessed): this branch still returns
    // `workDate: EDAY` and is STILL excluded whenever `calendarWorkDate ==
    // candidate.workDate` (the `candidate.workDate < calendarWorkDate`
    // guard is shared by both the open-record and previous-night checks),
    // so the L2/L3 exclusivity property is unaffected by which of the two
    // "previous night" reason codes fires.
    expect(calcs2[0].attribution_snapshot.value.reasonCode).toBe('OPEN_PREVIOUS_NIGHT_RECORD')
  })

  // Group F (O-5 decisive probe, #4612 gate3 P2-1 round 3): full-field diff of
  // the outer (PRE-step-3) vs inner (POST-step-3, persisted) attribution
  // value on the SAME zero-concurrency self-observation shape as eDay2 —
  // NOT just their `reasonCode`s, NOT just their fingerprints. This is the
  // decisive experiment behind the O-5 write-up's "the drift set is exactly
  // {resolvedAt, reasonCode}" claim: it is asserted here empirically, not
  // argued. The seam fires AFTER the route's own outer resolution/context
  // computation and BEFORE the canonical transaction (and therefore before
  // step 3's legacy write) opens — capturing those raw objects lets the test
  // reconstruct the outer `attribution.value` via the SAME public builder
  // (`__computeAttendanceOuterAttributionValueForTestsV1`, a thin TEST-ONLY
  // wrapper around the exact `attributionFromResolution` call the production
  // outer-fingerprint computation itself makes) and diff it key-by-key
  // against the persisted `attribution_snapshot.value` (the inner, freeze
  // step's own result).
  it('Group F (O-5 probe): outer-vs-inner attribution.value full-field diff on the eDay2 self-observation shape — drift set is EXACTLY {resolvedAt, reasonCode}, asserted per-field, not argued', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }
    let captured: { outerResolution: unknown; outerContext: unknown } | null = null
    setSeam(async (ctx: { outerResolution: unknown; outerContext: unknown }) => {
      captured = { outerResolution: ctx.outerResolution, outerContext: ctx.outerContext }
    })
    let res: HttpResponse
    try {
      const token = await mintToken(fProbeUser)
      res = await punch(token, {
        eventType: 'check_in', occurredAt: FPROBE_OCCURRED_AT, timezone: 'Asia/Tokyo', orgId: fProbeOrg, operationId: randomUUID(),
      })
    } finally {
      setSeam(null)
    }
    expect(res.status, res.raw).toBe(200)
    expect(captured).not.toBeNull()
    const { outerResolution, outerContext } = captured as { outerResolution: unknown; outerContext: unknown }
    expect(outerResolution && (outerResolution as { kind: string }).kind).toBe('resolved')

    const calcs = await calculationRowsForUser(fProbeUser)
    expect(calcs.length).toBe(1)
    const inner = calcs[0].attribution_snapshot.value as Record<string, unknown>
    expect(inner.reasonCode).toBe('OPEN_PREVIOUS_NIGHT_RECORD') // same self-observation flip as eDay2 (inner sees step 3's own write)

    const outer = __computeAttendanceOuterAttributionValueForTestsV1({
      orgId: fProbeOrg,
      userId: fProbeUser,
      source: 'live_resolution',
      nowIso: new Date().toISOString(),
      resolution: outerResolution as Parameters<typeof __computeAttendanceOuterAttributionValueForTestsV1>[0]['resolution'],
      context: outerContext as Parameters<typeof __computeAttendanceOuterAttributionValueForTestsV1>[0]['context'],
    })
    expect(outer).not.toBeNull()
    const outerValue = outer as Record<string, unknown>
    expect(outerValue.reasonCode).toBe('PREVIOUS_NIGHT_CONTAINING_SHIFT') // outer never sees step 3's own write

    // Enumerate the ACTUAL drift set (every key present on either side).
    // Compared via `canonicalAttendanceJsonV1` (the SAME key-order-independent
    // canonicalizer the production fingerprints hash over) — NOT raw
    // `JSON.stringify`, which is key-order-sensitive and produced a false
    // positive on `absoluteWindow`/`attributionWindow` here: `inner` is read
    // back through a JSONB column (Postgres does not preserve JS insertion
    // key order on round-trip) while `outerValue` is a freshly-built JS
    // object literal — same field values, different JS key enumeration
    // order. Confirmed via a raw diff dump before landing this canonicalized
    // comparison (see the PR body's Group F section for the raw dump this
    // caught).
    const allKeys = new Set([...Object.keys(outerValue), ...Object.keys(inner)])
    const driftFields: string[] = []
    for (const key of allKeys) {
      if (canonicalAttendanceJsonV1(outerValue[key] ?? null) !== canonicalAttendanceJsonV1(inner[key] ?? null)) {
        driftFields.push(key)
      }
    }
    driftFields.sort()

    // HARD CONSTRAINT (task instruction): the exclusion set is FROZEN at
    // {resolvedAt, reasonCode} for this round. If the empirical drift set is
    // anything else, that is a finding to escalate, not a set to silently
    // widen — this assertion is deliberately exact-equality, not
    // "at-least"/subset, so a THIRD drifting field fails this test loudly.
    expect(driftFields).toEqual(['reasonCode', 'resolvedAt'])

    // Positive confirmation that the non-excluded fields are BYTE-IDENTICAL
    // (not merely "not in driftFields" by omission) — the fields the
    // narrowed comparison domain actually still relies on for its
    // subsumption argument.
    for (const key of [
      'workDate', 'shiftId', 'absoluteWindow', 'attributionWindow', 'attributionTailMinutes',
      'extendedByApprovedOvertime', 'windowEvidenceFingerprint', 'source', 'schemaVersion', 'resolverVersion',
      'orgId', 'userId',
    ]) {
      expect(outerValue[key], `field '${key}' expected byte-identical outer vs inner`).toEqual(inner[key])
    }

    // Round 3 finding ⑤: "the reasonCode exclusion is only backed by a code
    // comment" — give it a leg. `computeAttendanceSourceDefinitionFingerprintV1`
    // (the STORAGE domain) is, field-projection-for-field-projection, the
    // SAME computation as `computeAttendanceOuterComparableSourceDefinitionFingerprintV1`
    // (the OUTER-VS-INNER comparison domain) with `reasonCode` NOT in its
    // exclusion set — i.e. it IS "the same projection logic with reasonCode
    // deleted from the exclusion set", not an analogous stand-in for it
    // (compare the two functions' bodies in `w4c1-fingerprints.ts`: the
    // `projectAttributionValue(...)` call and everything after it is
    // identical except the `Set([...])` literal; the two functions ALSO use
    // different domain-separator constants — `SOURCE_DEFINITION_DOMAIN` vs
    // `OUTER_COMPARABLE_SOURCE_DEFINITION_DOMAIN` — which is irrelevant to
    // this comparison: the separator is a fixed prefix hashed identically
    // into BOTH the outer and inner call on each side, so it cancels out of
    // an equal/not-equal comparison and cannot itself cause or hide an
    // agree/disagree result). Using it here proves, on THIS operation's real
    // captured outer/inner values (not synthetic ones), that removing the
    // exclusion reproduces the zero-concurrency false positive: the narrow
    // (production) domain must agree outer-vs-inner; the wide (storage)
    // domain, with `reasonCode` reinstated, must NOT — exactly the drift the
    // exclusion exists to suppress. A companion real SOURCE mutation (`Set(
    // ['resolvedAt', 'reasonCode'])` -> `Set(['resolvedAt'])`) was also run
    // by hand against this same test file's Group E `eDay2` leg (which
    // asserts `outcome === 'completed'`) and flipped it to
    // `review_required`/`context_mismatch` — see the PR body's ⑤ section for
    // that run's exact output; not re-run here as a standing test because it
    // requires a source edit, but the assertion below is the SAME claim
    // verified without one, and is what actually runs in CI.
    const outerAttribution = { posture: 'resolved_v2' as const, value: outerValue as unknown }
    const innerAttribution = { posture: 'resolved_v2' as const, value: inner as unknown }
    const outerContextSnapshot = outerContext as unknown
    const innerContextSnapshot = calcs[0].context_snapshot as unknown
    const narrowOuter = computeAttendanceOuterComparableSourceDefinitionFingerprintV1({
      attribution: outerAttribution, context: outerContextSnapshot,
    })
    const narrowInner = computeAttendanceOuterComparableSourceDefinitionFingerprintV1({
      attribution: innerAttribution, context: innerContextSnapshot,
    })
    expect(narrowOuter).not.toBeNull()
    expect(narrowOuter).toBe(narrowInner) // production domain: reasonCode excluded -> agrees (no false positive)
    const wideOuter = computeAttendanceSourceDefinitionFingerprintV1({
      attribution: outerAttribution, context: outerContextSnapshot,
    })
    const wideInner = computeAttendanceSourceDefinitionFingerprintV1({
      attribution: innerAttribution, context: innerContextSnapshot,
    })
    expect(wideOuter).not.toBeNull()
    expect(wideOuter).not.toBe(wideInner) // reasonCode reinstated -> the exact false positive the exclusion suppresses
  })

  // Group F2 (advisor-flagged escalation, #4612 gate3 P2-1 round 3): the ⑤
  // literal source mutation (Set(['resolvedAt','reasonCode']) ->
  // Set(['resolvedAt'])) turned up a SECOND self-observation shape beyond
  // eDay2/Group F — `Group D-overnight positive control` (zero concurrency,
  // connection B disarmed) ALSO flipped `completed` -> `review_required`
  // under that mutation. Group F was built to REPRODUCE eDay2's shape
  // (self-report ④'s own disclosed limitation: it is not an independently
  // discovered shape) — the drift-set claim was therefore verified on ONE
  // geometry. This leg runs the SAME full-field probe on the D-overnight
  // geometry (own user on `osidOrg`/`osidShiftX` — reusing that shift row is
  // safe: D-overnight's race swaps the per-user ASSIGNMENT row, never the
  // shift row itself, unlike L6's `tzRaceShift`, see that const's own
  // comment) to determine whether the drift set is STILL exactly
  // {resolvedAt, reasonCode} on a mechanistically different fixture
  // (overnight `openPreviousMatches` vs. eDay2's `openPreviousMatches` on a
  // different window/instant shape), or whether a wider set needs to be
  // reported (per the task's own hard constraint: a third drifting field is
  // an escalation, not a silent set-widening).
  it('Group F2 (O-5 probe, second geometry): outer-vs-inner attribution.value full-field diff on the D-overnight self-observation shape', async () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }
    const f2User = randomUUID()
    await insertActiveUser(f2User, osidOrg)
    await insertAssignment(randomUUID(), osidOrg, f2User, osidShiftX, OSID_DAY)

    let captured: { outerResolution: unknown; outerContext: unknown } | null = null
    setSeam(async (ctx: { outerResolution: unknown; outerContext: unknown }) => {
      captured = { outerResolution: ctx.outerResolution, outerContext: ctx.outerContext }
    })
    let res: HttpResponse
    try {
      const token = await mintToken(f2User)
      res = await punch(token, {
        eventType: 'check_in', occurredAt: OSID_OCCURRED_AT, timezone: 'UTC', orgId: osidOrg, operationId: randomUUID(),
      })
    } finally {
      setSeam(null)
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [f2User]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [f2User]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [f2User]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [f2User]).catch(() => undefined)
    }
    expect(res.status, res.raw).toBe(200)
    expect(captured).not.toBeNull()
    const { outerResolution, outerContext } = captured as { outerResolution: unknown; outerContext: unknown }
    expect(outerResolution && (outerResolution as { kind: string }).kind).toBe('resolved')

    const calcs = await calculationRowsForUser(f2User)
    expect(calcs.length).toBe(1)
    const inner = calcs[0].attribution_snapshot.value as Record<string, unknown>

    const outer = __computeAttendanceOuterAttributionValueForTestsV1({
      orgId: osidOrg,
      userId: f2User,
      source: 'live_resolution',
      nowIso: new Date().toISOString(),
      resolution: outerResolution as Parameters<typeof __computeAttendanceOuterAttributionValueForTestsV1>[0]['resolution'],
      context: outerContext as Parameters<typeof __computeAttendanceOuterAttributionValueForTestsV1>[0]['context'],
    })
    expect(outer).not.toBeNull()
    const outerValue = outer as Record<string, unknown>

    const allKeys = new Set([...Object.keys(outerValue), ...Object.keys(inner)])
    const driftFields: string[] = []
    for (const key of allKeys) {
      if (canonicalAttendanceJsonV1(outerValue[key] ?? null) !== canonicalAttendanceJsonV1(inner[key] ?? null)) {
        driftFields.push(key)
      }
    }
    driftFields.sort()

    // Same HARD CONSTRAINT as Group F: exact-equality, not subset — a third
    // drifting field on THIS geometry fails loudly and is an escalation, not
    // something to silently absorb into the exclusion set.
    expect(driftFields).toEqual(['reasonCode', 'resolvedAt'])
    // Mechanism confirmation: on this geometry, zero-concurrency
    // self-observation still resolves via `openPreviousMatches` inner-side
    // (matching the mutation-probe finding that this leg flips under ⑤'s
    // mutation) — outer never sees step 3's own write.
    expect(inner.reasonCode).toBe('OPEN_PREVIOUS_NIGHT_RECORD')
    expect(outerValue.reasonCode).not.toBe('OPEN_PREVIOUS_NIGHT_RECORD')

    for (const key of [
      'workDate', 'shiftId', 'absoluteWindow', 'attributionWindow', 'attributionTailMinutes',
      'extendedByApprovedOvertime', 'windowEvidenceFingerprint', 'source', 'schemaVersion', 'resolverVersion',
      'orgId', 'userId',
    ]) {
      expect(outerValue[key], `field '${key}' expected byte-identical outer vs inner`).toEqual(inner[key])
    }
  })
})
