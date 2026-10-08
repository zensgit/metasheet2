/**
 * W7-1b (#4556) — OD-W7-10(a): the superseded-source refusal at `current_policy`
 * recompute. RATIFIED by ruling 4; scoped to this slice by fork O-5.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (merge `0287b250b33fe4c7ea98b880360af74fc08a5ebf`, blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MATRIX AND NOT A CASE
 * ---------------------------------------------------------------------------
 * The ruled predicate is a COMPARISON of two things — the prior calculation's
 * producer versus the org's CURRENT W7 state — so it is BIDIRECTIONAL, and a
 * single-case leg cannot tell a correct implementation from either of the two
 * broken ones:
 *
 *   | prior producer | org now | ruled verdict | a "refuse whenever the org is group" fence |
 *   |---|---|---|---|
 *   | group  | group      | ALLOW  | refuses — bricks every correctly-configured group org |
 *   | group  | legacy/off | REFUSE | allows — SILENT ON THE ONE CASE THE DECISION EXISTS FOR |
 *   | legacy | group      | REFUSE | refuses, for the wrong reason |
 *   | legacy | legacy     | ALLOW  | allows |
 *
 * Every leg here is a POSITIVE-FIXTURE leg. The mechanism is unreachable while
 * the posture table is empty, so an "it did not fire against the default
 * fixture" assertion would be vacuous, not a negative control, and is not
 * written.
 *
 * ---------------------------------------------------------------------------
 * THREE DOORS STACK AT THIS PRODUCER — T-R10h EXISTS TO TELL THEM APART
 * ---------------------------------------------------------------------------
 * `recomputeAdapter.execute()` refuses in three different ways:
 *   1. `W4C3C_RECOMPUTE_REQUIRES_W4_POSTURE`   — the W4 write posture is legacy;
 *   2. §2.4 `W7_GROUP_CONTEXT_POSTURE_INCOHERENT` — the two state machines disagree NOW;
 *   3. `W4C3C_RECOMPUTE_SOURCE_SUPERSEDED`     — this decision, ACROSS TIME.
 *
 * Door 1 sits UPSTREAM, so every fixture below pins the W4 posture to
 * `authoritative` EXPLICITLY and asserts it — a fixture that left the org
 * W4-legacy would produce a 409 that LOOKS like a pass and is the wrong refusal.
 * Every refusal leg therefore asserts the EXACT closed code; a leg asserting
 * only "409" or using `notEqual` is void, and T-R10h proves the fixtures can
 * actually distinguish the doors rather than all reporting "a 409".
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'crypto'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import { seedAttendanceW7ContextSourcePostureV1 } from '../utils/w7-context-source-posture-fixture'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'
const POSTURE_TABLE = 'attendance_calculation_context_source_state'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK_DATE = '2026-06-01'

type HttpResponse = { status: number; body?: any; raw: string }
function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const t = new URL(url)
    const req = http.request(
      { method: options.method || 'GET', hostname: t.hostname, port: t.port, path: `${t.pathname}${t.search}`, headers: options.headers },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
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

/** One fixture = one org, one user, one record, one prior COMPLETED calculation
 *  whose `context_snapshot.selector` is exactly what the case names. */
type Case = {
  id: string
  orgId: string
  userId: string
  shiftId: string
  recordId: string
  calculationId: string
  /** what the PRIOR calculation was built from */
  priorSelector: 'legacy' | 'group_effective'
  /** the org's CURRENT W7 state */
  w7: 'group' | 'off'
  /** the org's W4 write posture */
  w4: 'authoritative' | 'shadow' | 'legacy'
  /** parent pointer owner — `legacy_untracked` is the shadow shape (T-R10c) */
  owner: 'w4' | 'w4_group' | 'legacy_untracked'
}

describeDb('W7-1b — OD-W7-10(a): superseded-source refusal at current_policy recompute (real host, real DB)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let priorW4: string | undefined
  let priorW7: string | undefined

  const cases: Record<string, Case> = {}
  const mk = (id: string, priorSelector: Case['priorSelector'], w7: Case['w7'], w4: Case['w4'], owner: Case['owner']): Case => {
    const c: Case = {
      id, priorSelector, w7, w4, owner,
      orgId: randomUUID(), userId: randomUUID(), shiftId: randomUUID(),
      recordId: randomUUID(), calculationId: randomUUID(),
    }
    cases[id] = c
    return c
  }

  const mintToken = async (userId: string): Promise<string> => {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  const contextFor = (c: Case) => ({
    schemaVersion: c.priorSelector === 'group_effective' ? 2 : 1,
    selector: c.priorSelector,
    orgId: c.orgId,
    userId: c.userId,
    workDate: WORK_DATE,
    timezone: 'UTC',
    shiftId: c.shiftId,
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: c.priorSelector === 'group_effective' ? randomUUID() : null,
    roundingMinutes: 15,
    severeLateThresholdMinutes: 30,
    absenceLateThresholdMinutes: 60,
    segments: [
      { index: 0, startTime: '00:00', endTime: '23:59', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 5, earlyLeaveGraceMinutes: 5 },
    ],
  })

  async function seedCase(c: Case): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W7-1b OD-W7-10 fixture', 'x', 'user', '["attendance:admin"]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [c.userId, `${c.userId}@w7-1b-od.test`],
    )
    await pool.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [c.userId, c.orgId])
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1,$2,$3,'UTC','00:00','23:59',false,'[0,1,2,3,4,5,6]'::jsonb,5,5,15,'strict')`,
      [c.shiftId, c.orgId, `od-shift ${c.shiftId}`],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1,$2,$3,0,'00:00','23:59',0,0)`,
      [randomUUID(), c.orgId, c.shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1,$2,$3,'2026-01-01','2027-12-31',true,'published',1)`,
      [c.orgId, c.userId, c.shiftId],
    )
    // W4 rollout posture — walked through its legal edges.
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1,'legacy','w7-1b-od','TEST_FIXTURE','w7-1b-od-actor',1,NULL)`,
      [c.orgId],
    )
    if (c.w4 !== 'legacy') {
      const edges = c.w4 === 'shadow'
        ? ([['shadow','legacy',2]] as const)
        : ([['shadow','legacy',2],['eligible','shadow',3],['authoritative','eligible',4]] as const)
      for (const [state, prior, version] of edges) {
        await pool.query(
          `UPDATE attendance_calculation_rollout_state SET state=$2, prior_state=$3, version=$4 WHERE org_id=$1`,
          [c.orgId, state, prior, version],
        )
      }
    }
    if (c.w7 === 'group') {
      // W7-3 (#4556) landing-gate P1-1: the bare `(org_id, state, scope)` shape is
      // ILLEGAL under W7-3's `trg_accss_state_guard` (BEFORE-ROW, bootstrap shapes
      // only -> P0001) and its four NOT NULL columns (-> 23502). Seeded through the
      // ONE shared legal fixture: bootstrap at `off`, then walk the ratified ladder.
      // Never by dropping the trigger — that would run this evidence against a schema
      // production does not ship.
      await seedAttendanceW7ContextSourcePostureV1(pool, c.orgId, 'group_authoritative')
    }
    // The parent record + its PRIOR completed calculation.
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
          status, is_workday, projection_owner, visibility_state, visibility_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'UTC',480,0,0,'normal',true,'legacy_untracked','active','active',now(),now())`,
      [c.recordId, c.userId, c.orgId, WORK_DATE],
    )
    // W4C0_SEGMENT_COUNT is a DEFERRABLE INITIALLY DEFERRED trigger: it fires at
    // COMMIT, so the calculation and its child segment must land in the SAME
    // transaction. Separate autocommitting statements would trip it on the first.
    const seedClient = await pool.connect()
    try {
      await seedClient.query('BEGIN')
      await seedClient.query(
      `INSERT INTO attendance_record_calculations
         (id, attendance_record_id, org_id, version,
          calculation_kind, mode, entrypoint, engine_version, snapshot_schema_version,
          semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
          attribution_snapshot, segment_snapshot, evidence_snapshot, approved_facts_snapshot,
          input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count,
          actor_id, correlation_id, operation_id,
          projected_status, projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          context_snapshot, created_at)
       VALUES ($1,$2,$3,1,
               'calculation','authoritative','recompute','w7-1b-od',1,
               -- chk_arc_source_def_nullability: required on a completed row.
               $6,$7,$10,
               $5::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
               '{}'::jsonb,'append','segment_authoritative',
               'completed','calculated','set_active',1,
               -- chk_arc_operation_id: a non-legacy_baseline row must carry one.
               'w7-1b-od-actor',$8,$9::uuid,
               -- chk_arc_completed_shape requires a real projection on a
               -- completed calculation row. Seeded history, not asserted values.
               'normal',480,0,0,
               $4::jsonb, now())`,
      [
        c.calculationId, c.recordId, c.orgId,
        JSON.stringify(contextFor(c)),
        JSON.stringify({ posture: 'resolved_v2', value: { orgId: c.orgId, userId: c.userId, workDate: WORK_DATE, shiftId: c.shiftId } }),
        // 64-hex, deterministic per case: `chk_arc_semantic_fp` /
        // `chk_arc_provenance_fp` pin the SHAPE, and these rows are seeded
        // history, not values any assertion below reads.
        createHash('sha256').update(`semantic:${c.id}`).digest('hex'),
        createHash('sha256').update(`provenance:${c.id}`).digest('hex'),
        `w7-1b-od-${c.id}`,
        randomUUID(),
        createHash('sha256').update(`sourcedef:${c.id}`).digest('hex'),
      ],
    )
    // The parent points at it only when the owner is a pointer-bearing member;
    // `legacy_untracked` must keep a NULL pointer (that IS the shadow shape).
    // A DEFERRED trigger (`W4C0_SEGMENT_COUNT`) enforces that a calculation's
    // child segment rows match its `expected_segment_count`, so the child is
    // part of the fixture rather than optional decoration.
      await seedClient.query(
      `INSERT INTO attendance_record_segments
         (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
          work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
          matched_evidence_refs, unmatched_evidence_refs)
       VALUES ($1,$2::uuid,$3::uuid,0,$4::timestamptz,$5::timestamptz,480,0,0,'normal','["within_window"]'::jsonb,'[]'::jsonb,'[]'::jsonb)`,
      [c.orgId, c.recordId, c.calculationId, `${WORK_DATE}T00:00:00Z`, `${WORK_DATE}T23:59:00Z`],
    )
      await seedClient.query('COMMIT')
    } catch (error) {
      await seedClient.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      seedClient.release()
    }

    // chk_ar_owner_pointer_pair binds owner and pointer TOGETHER: a
    // pointer-bearing owner requires a non-NULL `current_calculation_id`, and
    // `legacy_untracked` requires NULL. So the row is inserted as
    // `legacy_untracked` and promoted in ONE statement once the calculation
    // exists — which is also what the product itself does.
    if (c.owner !== 'legacy_untracked') {
      await pool.query(
        `UPDATE attendance_records SET projection_owner=$3, current_calculation_id=$2::uuid WHERE id=$1::uuid`,
        [c.recordId, c.calculationId, c.owner],
      )
    }
  }

  /** Drives the real route. `expected*` are sourced from the same posture-dependent
   *  choice the adapter makes, so the upstream expectation guard cannot be the
   *  door that answers. */
  async function recompute(c: Case, policy: 'current_policy' | 'frozen_prior'): Promise<HttpResponse> {
    const pointerBearing = c.owner !== 'legacy_untracked'
    return requestJson(`${baseUrl}/api/attendance/records/${c.recordId}/recompute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await mintToken(c.userId)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // `getOrgId` reads `req.body.orgId` FIRST and falls back to the token's
        // org / DEFAULT_ORG_ID. Omitting it sends the request at the wrong org
        // and the ACTOR-MEMBERSHIP door answers with 403 FORBIDDEN — a fourth
        // door that would make every leg below pass for the wrong reason.
        orgId: c.orgId,
        policy,
        operationId: randomUUID(),
        expectedCalculationId: pointerBearing ? c.calculationId : c.calculationId,
        expectedCalculationVersion: 1,
      }),
    })
  }

  const codeOf = (res: HttpResponse): string =>
    String((res.body as { error?: { code?: string } } | undefined)?.error?.code ?? `<none:${res.status}>`)

  const calcCount = async (recordId: string): Promise<number> =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM attendance_record_calculations WHERE attendance_record_id=$1::uuid`, [recordId])).rows[0].n)

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('OD-W7-10 suite needs a loopback port + DATABASE_URL')

    priorW4 = process.env[W4_ENV]
    priorW7 = process.env[W7_ENV]
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'

    // ---- the matrix -----------------------------------------------------
    mk('r10a_group_x_group', 'group_effective', 'group', 'authoritative', 'w4_group')
    mk('r10b_group_x_off', 'group_effective', 'off', 'authoritative', 'w4_group')
    // T-R10c: the SHADOW shape — parent says `legacy_untracked`, the CALCULATION
    // says group. A `projection_owner`-based implementation passes every other
    // leg and fails only this one.
    // W4 posture is SHADOW here, deliberately: that is what the shadow SHAPE
    // means. Under `shadow` the adapter's posture-dependent selector reads
    // `latest_calc` (the completed calculation) rather than `current_calc`,
    // which is exactly why a `legacy_untracked` parent with a NULL pointer can
    // still carry a full group calculation. Pinning `authoritative` here would
    // make the upstream expectation guard answer instead of this decision.
    mk('r10c_shadow_shape', 'group_effective', 'off', 'shadow', 'legacy_untracked')
    mk('r10d_legacy_x_group', 'legacy', 'group', 'authoritative', 'w4')
    mk('r10e_legacy_x_off', 'legacy', 'off', 'authoritative', 'w4')
    // T-R10h: identical request shape, org left W4-LEGACY -> the OTHER door.
    mk('r10h_w4_legacy', 'group_effective', 'off', 'legacy', 'w4_group')

    const repoRoot = path.join(HERE, '../../../../')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    // The W4 allowlist carries every org whose W4 posture must be honoured; the
    // W7 allowlist carries ONLY the orgs whose current state is `group`.
    process.env[W4_ENV] = Object.values(cases).map((c) => c.orgId.toLowerCase()).join(',')
    process.env[W7_ENV] = Object.values(cases).filter((c) => c.w7 === 'group').map((c) => c.orgId.toLowerCase()).join(',')

    for (const c of Object.values(cases)) await seedCase(c)
  }, 240_000)

  afterAll(async () => {
    const orgs = Object.values(cases).map((c) => c.orgId)
    for (const table of [
      'attendance_record_segments', 'attendance_record_calculations', 'attendance_records',
      'attendance_shift_assignments', 'attendance_shift_segments', 'attendance_shifts', 'user_orgs',
    ]) {
      await pool?.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => undefined)
    }
    await pool?.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [orgs.map((o) => o.toLowerCase())]).catch(() => undefined)
    await pool?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [Object.values(cases).map((c) => c.userId)]).catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorW4 === undefined) delete process.env[W4_ENV]; else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]; else process.env[W7_ENV] = priorW7
  }, 60_000)

  // -------------------------------------------------------------------------

  it('fixture precondition: every OD-W7-10 case pins its W4 posture EXPLICITLY (door 1 must not be the one answering)', async () => {
    for (const c of Object.values(cases)) {
      const row = (await pool.query(`SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1`, [c.orgId])).rows[0]
      expect(row?.state, `${c.id}: W4 posture`).toBe(c.w4)
      const posture = (await pool.query(`SELECT 1 FROM ${POSTURE_TABLE} WHERE org_id=$1`, [c.orgId.toLowerCase()])).rowCount
      expect(posture === 1, `${c.id}: W7 posture row present?`).toBe(c.w7 === 'group')
      // And the prior calculation really carries the selector the case names —
      // otherwise the whole matrix would be comparing something it did not seed.
      const ctx = (await pool.query(`SELECT context_snapshot FROM attendance_record_calculations WHERE id=$1::uuid`, [c.calculationId])).rows[0]
      expect((ctx.context_snapshot as Record<string, unknown>).selector, `${c.id}: prior selector`).toBe(c.priorSelector)
    }
  })

  it('T-R10a: group x group => ALLOWED BY OD-W7-10 (the correctly-configured group org is NOT bricked)', async () => {
    const c = cases.r10a_group_x_group
    const before = await calcCount(c.recordId)
    const res = await recompute(c, 'current_policy')
    // ⚠️ WHAT THIS LEG PROVES, STATED EXACTLY.
    //
    // The assertion is the EXACT code of the NEXT door downstream — a POSITIVE
    // equality, not `notEqual('W4C3C_RECOMPUTE_SOURCE_SUPERSEDED')`. It proves
    // the request travelled THROUGH the OD-W7-10 gate and was stopped by
    // something else, which is precisely what "ALLOW" means for this decision.
    //
    // It does NOT prove a `current_policy` recompute can complete end to end.
    // It cannot, at this fixture depth: `resolveWorkContext` never populates
    // `context.shiftId`, and `attendance_rules` carries no shift binding, so the
    // authoritative-shift resolution this route needs comes from rotation
    // machinery this suite does not seed. That is a FIXTURE-DEPTH limit
    // downstream of the gate, not a property of OD-W7-10 — and saying so is
    // what stops this leg from being read as "recompute works".
    //
    // Discrimination is preserved: under the withdrawn "refuse whenever the org
    // is group" fence this code would be `W4C3C_RECOMPUTE_SOURCE_SUPERSEDED`
    // instead, so the leg reds. That is the mutation it exists to catch.
    expect(codeOf(res), `body: ${res.raw}`).toBe('W4C3C_RECOMPUTE_CURRENT_POLICY_INCOMPLETE')
    // The gate must not have written anything either — it is a refusal-or-pass
    // decision, never a producer.
    expect(await calcCount(c.recordId)).toBe(before)
  }, 60_000)

  it('T-R10b: group x legacy/off => REFUSE with the EXACT code, and ZERO writes', async () => {
    const c = cases.r10b_group_x_off
    const before = await calcCount(c.recordId)
    const res = await recompute(c, 'current_policy')
    expect(codeOf(res)).toBe('W4C3C_RECOMPUTE_SOURCE_SUPERSEDED')
    expect(res.status).toBe(409)
    // The refusal precedes production, so nothing may have been written.
    expect(await calcCount(c.recordId)).toBe(before)
  }, 60_000)

  it('T-R10c (MANDATORY discriminator): parent legacy_untracked + calculation group_effective, org legacy => REFUSE', async () => {
    // The ONLY leg that separates the correct design from the tempting
    // `projection_owner` shortcut: `projection_owner` is written only on the
    // authoritative path, so a shadow-posture org's parent reads
    // `legacy_untracked` while its calculations carry a full group context. A
    // parent-based predicate reads `legacy` here, computes legacy == legacy, and
    // ALLOWS the recompute the ruling refuses.
    const c = cases.r10c_shadow_shape
    const owner = (await pool.query(`SELECT projection_owner, current_calculation_id FROM attendance_records WHERE id=$1::uuid`, [c.recordId])).rows[0]
    expect(owner.projection_owner, 'fixture must really be the shadow shape').toBe('legacy_untracked')
    expect(owner.current_calculation_id, 'a legacy_untracked parent must carry a NULL pointer').toBeNull()

    const res = await recompute(c, 'current_policy')
    expect(codeOf(res), `body: ${res.raw}`).toBe('W4C3C_RECOMPUTE_SOURCE_SUPERSEDED')
  }, 60_000)

  it('T-R10d: legacy x group => REFUSE with the EXACT code', async () => {
    const res = await recompute(cases.r10d_legacy_x_group, 'current_policy')
    expect(codeOf(res)).toBe('W4C3C_RECOMPUTE_SOURCE_SUPERSEDED')
  }, 60_000)

  it('T-R10a2: legacy x legacy/off => ALLOWED BY OD-W7-10 (the ordinary case is untouched)', async () => {
    const c = cases.r10e_legacy_x_off
    const before = await calcCount(c.recordId)
    const res = await recompute(c, 'current_policy')
    // Same shape and same limit as T-R10a above; see that leg's note.
    expect(codeOf(res), `body: ${res.raw}`).toBe('W4C3C_RECOMPUTE_CURRENT_POLICY_INCOMPLETE')
    expect(await calcCount(c.recordId)).toBe(before)
  }, 60_000)

  it('T-R10e: `frozen_prior` is UNTOUCHED in the refused fixture — asserted as its own exact door', async () => {
    // Guarding `policy` unconditionally instead of `current_policy`-only would
    // red this. W7-R6 owns `frozen_prior` and the lock explicitly keeps it out
    // of this decision.
    const c = cases.r10b_group_x_off
    const res = await recompute(c, 'frozen_prior')
    // The EXACT code of the frozen_prior path's own door — a positive equality.
    // This is the SAME fixture that gets `W4C3C_RECOMPUTE_SOURCE_SUPERSEDED` on
    // `current_policy` (T-R10b), so the pair is the discrimination: guarding
    // `policy` unconditionally instead of `current_policy`-only would make this
    // leg report SUPERSEDED too, and it reds.
    //
    // As above, this does not claim a frozen_prior recompute completes — the
    // seeded prior lacks the evidence/segment snapshot shape replay needs. It
    // claims the request went down the frozen_prior path UNTOUCHED by this
    // decision, which is exactly what W7-R6 owning `frozen_prior` means.
    expect(codeOf(res), `body: ${res.raw}`).toBe('W4C3C_RECOMPUTE_PRIOR_UNSUPPORTED')
  }, 60_000)

  it('T-R10h (THREE-DOOR discrimination): the same request shape on a W4-LEGACY org reports the OTHER door', async () => {
    // Proves the fixtures can tell the three stacked doors apart rather than all
    // reporting "a 409". If every leg asserted only the status code, this leg
    // would go green under a broken implementation — which is the point.
    const res = await recompute(cases.r10h_w4_legacy, 'current_policy')
    expect(res.status).toBe(409)
    expect(codeOf(res)).toBe('W4C3C_RECOMPUTE_REQUIRES_W4_POSTURE')
    expect(codeOf(res)).not.toBe('W4C3C_RECOMPUTE_SOURCE_SUPERSEDED')
  }, 60_000)

  it('T-R10g: the refusal surface is VALUES-FREE', async () => {
    const c = cases.r10b_group_x_off
    const res = await recompute(c, 'current_policy')
    // ANCHOR FIRST: assert this really is the refusal under test. Without this
    // the leg passes vacuously against ANY other error whose message also
    // happens to carry no values (a 403 FORBIDDEN, say).
    expect(codeOf(res), `body: ${res.raw}`).toBe('W4C3C_RECOMPUTE_SOURCE_SUPERSEDED')
    const message = String((res.body as { error?: { message?: string } } | undefined)?.error?.message ?? '')
    expect(message.length).toBeGreaterThan(0)
    for (const [label, value] of [
      ['orgId', c.orgId], ['userId', c.userId], ['workDate', WORK_DATE],
      ['shiftId', c.shiftId], ['calculationId', c.calculationId], ['policy', 'current_policy'],
    ] as const) {
      expect(message, `refusal message leaked ${label}`).not.toContain(value)
    }
    expect(message, 'refusal message leaked a context fragment').not.toContain('group_effective')
  }, 60_000)
})
