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
 *  - L6 (group C, race), RE-SCOPED (mutation self-check finding, disclosed
 *    below and in the PR body): a real two-connection race that changes
 *    ONLY the winning shift row's own `timezone` column (identity —
 *    workDate/shiftId — unchanged, so the step-7 gate stays silent) proves
 *    the frozen context's timezone reflects the TRANSACTION's own in-flight
 *    read of the winning shift row. It does NOT independently discriminate
 *    the `w4c2-live-scheduled-boundary.ts` freeze-step fix's `timezone:`
 *    argument to `buildShadowFrozenContext` — mutating that argument (to
 *    `input.timezone`, and separately to a nonsense literal) left this leg
 *    green both times, because `buildW4ShadowFrozenContextV1` (`index.cjs`
 *    ~L21519) independently re-reads the shift row in the SAME transaction
 *    and overrides whatever is passed whenever the row's own `timezone`
 *    column is non-blank. That argument is therefore correct per the lock
 *    (Q16/Q17) but observably inert for any fixture where the winning shift
 *    carries a timezone — disclosed rather than claimed as discriminated.
 *  - L7 (group B, race + pre-existing evidence): reuses L5's race and adds
 *    a pre-existing `attendance_events` row tagged to the CORRECT anchor
 *    day (the freeze step's own resolved `workDate`) that the OLD
 *    (`input.workDate`) anchor would never see.
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
              c.semantic_input_fingerprint, c.attribution_snapshot, c.context_snapshot, c.evidence_snapshot
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
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = [shadowOrgA, raceOrg, tzRaceOrg, sidOrg].join(',')

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

    // Group D fixtures (shiftId-only race). Both shifts non-overnight, SAME
    // day (SID_DAY), both windows contain SID_OCCURRED_AT — only shiftX is
    // assigned/active at route-read time.
    await insertShadowRolloutRow(sidOrg)
    await insertActiveUser(sidUser, sidOrg)
    await insertShift(sidShiftX, sidOrg, 'W4C2-P21-SidX', 'UTC', '09:00', '17:00', false)
    await insertShift(sidShiftY, sidOrg, 'W4C2-P21-SidY', 'UTC', '08:00', '18:00', false)
    await insertAssignment(randomUUID(), sidOrg, sidUser, sidShiftX, SID_DAY)
  }, 120000)

  afterAll(async () => {
    for (const userId of [refDriftUser, shadowDriftUser, shadowPlainUser, raceUser, raceEvidenceUser, tzRaceUser, sidUser]) {
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
    expect(driftCalcs[0].semantic_input_fingerprint).toMatch(/^[0-9a-f]{64}$/)
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

  // L6, RE-SCOPED (mutation self-check finding, disclosed): the freeze-step
  // fix at `w4c2-live-scheduled-boundary.ts` (`timezone:
  // resolution.fullWinner?.timezone ?? input.requestTimezone` passed into
  // `buildShadowFrozenContext`) is CORRECT per the lock's Q16/Q17 but is
  // OBSERVABLY INERT for this leg: `buildW4ShadowFrozenContextV1`
  // (`index.cjs` ~L21519) independently re-reads the winning shift row
  // FRESH, in the same transaction, and overrides whatever `timezone`
  // parameter the caller passes whenever the row's own `timezone` column is
  // non-blank (`shift.timezone || <passed timezone>`) — which is every
  // constructible fixture here. Mutation-verified twice: reverting the
  // boundary.ts argument to `input.timezone`, AND replacing it with a
  // nonsense literal (`'Pacific/Kiritimati'`), both left this leg green
  // (`context_snapshot.timezone` stayed `'Asia/Kolkata'` either way). This
  // leg therefore does NOT discriminate that boundary.ts line — it proves a
  // real, valuable, but DIFFERENT property: the freeze step's frozen
  // context correctly reflects the TRANSACTION's own in-flight read of the
  // winning shift row (via `buildW4ShadowFrozenContextV1`'s own re-read),
  // not the route's pre-race value — end-to-end proof the race is actually
  // observed. See the PR body's mutation table for the "no independently
  // provable leg" disclosure on the boundary.ts line itself.
  it('L6 (re-scoped): the frozen context reflects the TRANSACTION\'s own in-flight read of the winning shift row\'s timezone after a race, not the route\'s pre-race value (does not discriminate the boundary.ts parameter — see comment above)', async () => {
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
    // Identity unchanged -> step-7 gate stays silent (not a context_mismatch
    // review) -- the race is contained to timezone only.
    expect(calcs[0].attribution_snapshot.value.workDate).toBe('2026-07-19')
    expect(calcs[0].attribution_snapshot.value.shiftId).toBe(tzRaceShift)
    expect(calcs[0].context_snapshot.timezone).toBe('Asia/Kolkata')
  })

  // Group D (#4612 gate3 P2-1 self-report ⑥ closure). Before the step-7 gate
  // widening this leg observably slipped through: `identityDrift` compared
  // ONLY `workDate` (unchanged by this race by construction), so the
  // shadow calculation completed against the RACE-INSTALLED shift's context
  // with `outcome='completed'` — a fail-open. Proven via the mutation table
  // in the PR body (neutering the `shiftId` half of `identityDrift` flips
  // this leg's `outcome` assertion back to `completed`, matching pre-fix
  // behavior byte-for-byte).
  it('Group D: a shiftId-ONLY race (workDate held fixed, only the winning shift swaps) hits the widened step-7 candidate-identity gate', async () => {
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
})
