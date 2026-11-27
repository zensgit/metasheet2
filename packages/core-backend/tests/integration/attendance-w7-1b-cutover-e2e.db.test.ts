/**
 * W7-1b (#4556) — THE CUTOVER, END TO END, with BOTH state machines ON.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (merge `0287b250b33fe4c7ea98b880360af74fc08a5ebf`, blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE IS THE ONE THAT MATTERS
 * ---------------------------------------------------------------------------
 * An earlier revision of the W7-1b PR body claimed the slice was "ordered the
 * safe way round" because no producer persisted a V2 context. That was WRONG
 * and inverted, and this suite is the mechanical statement of the correction:
 *
 *   - the mirror hashes whatever the SEAM issued (V2 for a group org);
 *   - that value is handed to `executeLivePunch` verbatim;
 *   - if the boundary's INNER arms still built V1, the two canonical JSONs
 *     differ, `authoritativeFingerprintMismatch` / `fingerprintMismatch` fires,
 *     and EVERY punch of that org lands `review_required` /
 *     `context_mismatch` / zeroed segments.
 *
 * Wiring the mirror without the producers, or the producers without the mirror,
 * both create that landmine — symmetrically. Only shipping them together closes
 * it. **T-M5 below is the leg the brief names as "the one that would otherwise
 * first appear on the owner's first flip", and it is asserted as a POSITIVE
 * SUCCESS EQUALITY, never as `notEqual('context_mismatch')`** — a `notEqual`
 * cannot distinguish "the fingerprints matched" from "it failed for another
 * reason".
 *
 * The fixture org is postured in BOTH machines, which per O-1 is the only
 * configuration in which the live group arm is reachable at all.
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createRequire } from 'module'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool, Client } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import { seedAttendanceW7ContextSourcePostureV1 } from '../utils/w7-context-source-posture-fixture'
import { createLegacyLivePunchBoundaryDriver } from '../utils/attendance-legacy-live-punch-boundary-driver'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'
const POSTURE_TABLE = 'attendance_calculation_context_source_state'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const requireCjs = createRequire(import.meta.url)
/* eslint-disable @typescript-eslint/no-var-requires */
const { buildAttendanceGroupFixedScheduleProducerKey } = requireCjs(
  '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
)

type HttpResponse = { status: number; body?: any; raw: string }
function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
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
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describeDb('W7-1b — cutover end-to-end: both machines ON (real host, real DB)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  const seededDefaultRuleIds: string[] = []
  let baseUrl = ''
  let priorW4: string | undefined
  let priorW7: string | undefined

  // BOTH-machines org (T-M5 / T-R1 / T-P1 / T-P7).
  const bothOrg = randomUUID()
  const bothUser = randomUUID()
  const bothShift = randomUUID()
  const bothGroup = randomUUID()
  // W4-ON + NO posture row — T-B4 / T-M4 arm-A-TRUE. THE CONFIGURATION THAT
  // ACTUALLY SHIPS once W4 is rolled out and W7 is not: the mirror RUNS (arm A
  // of the disjunction is true) and must still take the LEGACY arm and produce a
  // non-null fingerprint. Every other leg in this repo's W7 matrix has either the
  // W4 env unset or a posture row present, so without this org the one live
  // combination for existing W4 orgs is unmeasured.
  const w4OnlyOrg = randomUUID()
  const w4OnlyUser = randomUUID()
  const w4OnlyShift = randomUUID()
  // Suspended HTTP org and independent prepare/execute boundary fixture.
  const suspendedOrg = randomUUID()
  const suspendedUser = randomUUID()
  const suspendedShift = randomUUID()
  const suspendedGroup = randomUUID()
  const boundaryOrg = randomUUID()
  const boundaryUser = randomUUID()
  const boundaryShift = randomUUID()
  const boundaryGroup = randomUUID()
  // W4-legacy + W7-group org — the §2.4 incoherence fixture (T-R9).
  const incoherentOrg = randomUUID()
  const incoherentUser = randomUUID()
  const incoherentShift = randomUUID()
  const incoherentGroup = randomUUID()

  const allOrgs = () => [bothOrg, incoherentOrg, w4OnlyOrg, suspendedOrg, boundaryOrg]

  const mintToken = async (userId: string): Promise<string> => {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W7-1b cutover fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w7-1b-e2e.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
    if (orgId === 'default') return
    const defaultRule = await pool.query<{ id: string }>(
      `INSERT INTO attendance_rules
       (id, org_id, name, timezone, timezone_version, work_start_time, work_end_time, working_days, is_default)
       SELECT $1, $2, 'owned timezone fixture', $3, 1, '09:00', '18:00', '[1,2,3,4,5]'::jsonb, true
       WHERE NOT EXISTS (SELECT 1 FROM attendance_rules WHERE org_id = $2 AND is_default = true)
       RETURNING id`,
      [randomUUID(), orgId, 'UTC'],
    )
    seededDefaultRuleIds.push(...defaultRule.rows.map(row => row.id))
  }

  /** Walks the rollout state machine's LEGAL edges to `authoritative`. Inserting
   *  `authoritative` directly is trigger-denied; the walk is the fixture. */
  async function seedAuthoritativeRollout(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w7-1b-e2e', 'TEST_FIXTURE', 'w7-1b-actor', 1, NULL)`,
      [orgId],
    )
    for (const [state, prior, version] of [
      ['shadow', 'legacy', 2],
      ['eligible', 'shadow', 3],
      ['authoritative', 'eligible', 4],
    ] as const) {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
        [orgId, state, prior, version],
      )
    }
  }

  async function seedLegacyRollout(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w7-1b-e2e', 'TEST_FIXTURE', 'w7-1b-actor', 1, NULL)`,
      [orgId],
    )
  }

  async function seedShiftAndEffectiveGroup(
    orgId: string,
    userId: string,
    shiftId: string,
    groupId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, $3, 'UTC', '00:00', '23:59', false, '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 15, 'strict')`,
      [shiftId, orgId, `w7-1b-e2e ${shiftId}`],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), orgId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
       VALUES ($1, $2, $3, 'fixed_shift', 'UTC')`,
      [groupId, orgId, `w7-1b-e2e group ${groupId}`],
    )
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', 1, 'w7-1b-e2e')`,
      [orgId, groupId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
      [orgId, groupId, userId],
    )
    const producerKey = buildAttendanceGroupFixedScheduleProducerKey({
      groupId,
      shiftId,
      startDate: '2026-01-01',
      endDate: '2027-12-31',
    })
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active,
          producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true,
               'attendance_group_fixed_schedule', $4, $5, $6, 'published')`,
      [orgId, userId, shiftId, groupId, producerKey, randomUUID()],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships
         (org_id, user_id, group_id, effective_from, effective_to,
          assigned_by, assigned_reason, assigned_correlation_id)
       VALUES ($1, $2, $3, '2026-01-01', NULL, 'w7-1b-e2e', 'seed', $4)`,
      [orgId, userId, groupId, `w7-1b-e2e-${groupId}`],
    )
    // W7-3 (#4556) landing-gate P1-1: the bare `(org_id, state, scope)` shape is
      // ILLEGAL under W7-3's `trg_accss_state_guard` (BEFORE-ROW, bootstrap shapes
      // only -> P0001) and its four NOT NULL columns (-> 23502). Seeded through the
      // ONE shared legal fixture: bootstrap at `off`, then walk the ratified ladder.
      // Never by dropping the trigger — that would run this evidence against a schema
      // production does not ship.
    await seedAttendanceW7ContextSourcePostureV1(pool, orgId, 'group_authoritative')
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W7-1b cutover suite needs a loopback port + DATABASE_URL')

    priorW4 = process.env[W4_ENV]
    priorW7 = process.env[W7_ENV]
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // ⚠️ TWO MECHANISMS, BOTH REQUIRED — they guard different things.
    //
    // (1) BOOT-TIME REGISTRATION. Some attendance machinery is ENV-GATED AT
    //     REGISTRATION rather than at call time (the outbox-drain gate at
    //     index.cjs:50150 and its sibling sweep gate read the W4 allowlist
    //     inside `activate()`), and registration happens once, during
    //     `server.start()` below. So the allowlists MUST be set BEFORE that
    //     call. A previous revision of this suite deleted them here in the name
    //     of hermeticity — which booted those pieces UNREGISTERED, and no
    //     per-test restore can reach a decision already made at registration.
    //
    // (2) PER-TEST HERMETICITY (see `withEnv`). `beforeAll` is a per-FILE hook
    //     while `process.env` is per-WORKER, and several attendance suites in
    //     the same run-list set or clear these same variables, so each leg still
    //     installs and restores the values it needs.
    //
    // Doing only (2) breaks registration; doing only (1) leaves the premise at a
    // neighbour's mercy. The earlier round mistook one for the other.
    process.env[W4_ENV] = `${bothOrg.toLowerCase()},${w4OnlyOrg.toLowerCase()},${suspendedOrg.toLowerCase()},${boundaryOrg.toLowerCase()}`
    process.env[W7_ENV] = `${bothOrg.toLowerCase()},${suspendedOrg.toLowerCase()},${boundaryOrg.toLowerCase()}`

    const repoRoot = path.join(HERE, '../../../../')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    await insertActiveUser(bothUser, bothOrg)
    await seedAuthoritativeRollout(bothOrg)
    await seedShiftAndEffectiveGroup(bothOrg, bothUser, bothShift, bothGroup)

    // T-B4 fixture: W4-authoritative and W4-allowlisted, but NO posture row and
    // NO W7 allowlist entry. Seeded with a PLAIN published assignment (not a
    // group-produced one) so nothing about it is group-shaped.
    await insertActiveUser(w4OnlyUser, w4OnlyOrg)
    await seedAuthoritativeRollout(w4OnlyOrg)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, $3, 'UTC', '00:00', '23:59', false, '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 15, 'strict')`,
      [w4OnlyShift, w4OnlyOrg, `w7-1b-e2e w4only ${w4OnlyShift}`],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), w4OnlyOrg, w4OnlyShift],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
      [w4OnlyOrg, w4OnlyUser, w4OnlyShift],
    )

    // SUSPENDED fixture: fully effective group AND W4-authoritative, so the only
    // thing stopping a calculation is the suspension itself.
    await insertActiveUser(suspendedUser, suspendedOrg)
    await seedAuthoritativeRollout(suspendedOrg)
    await seedShiftAndEffectiveGroup(suspendedOrg, suspendedUser, suspendedShift, suspendedGroup)
    // W7-3 (#4556) landing-gate P1-1, UPDATE half: this bare `SET state =
    // 'suspended'` is illegal under `trg_accss_state_guard`'s UPDATE branch too
    // — it carries no `prior_state` and no `version` increment, so the trigger
    // raises `prior_state must record the previous state`. (The gate's list
    // enumerated INSERT fixtures; a repo-wide sweep for UPDATEs found this
    // seventh site.) Routed through the shared legal fixture, which rebuilds
    // the row by walking the ratified ladder — the final row is exactly what
    // the production writer would have produced for a suspended org.
    await seedAttendanceW7ContextSourcePostureV1(pool, suspendedOrg, 'suspended')

    await insertActiveUser(boundaryUser, boundaryOrg)
    await seedAuthoritativeRollout(boundaryOrg)
    await seedShiftAndEffectiveGroup(boundaryOrg, boundaryUser, boundaryShift, boundaryGroup)
    await seedAttendanceW7ContextSourcePostureV1(pool, boundaryOrg, 'off')

    await insertActiveUser(incoherentUser, incoherentOrg)
    await seedLegacyRollout(incoherentOrg)
    await seedShiftAndEffectiveGroup(incoherentOrg, incoherentUser, incoherentShift, incoherentGroup)
  }, 180_000)

  afterAll(async () => {
    const orgs = allOrgs()
    for (const table of [
      'attendance_record_segments',
      'attendance_record_calculations',
      'attendance_records',
      'attendance_events',
      'attendance_calculation_group_memberships',
      'attendance_shift_assignments',
      'attendance_group_fixed_schedule_configs',
      'attendance_group_members',
      'attendance_groups',
      'attendance_shift_segments',
      'attendance_shifts',
      'user_orgs',
    ]) {
      await pool?.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => undefined)
    }
    await pool
      ?.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [
        orgs.map((o) => o.toLowerCase()),
      ])
      .catch(() => undefined)
    await pool
      ?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[bothUser, incoherentUser, w4OnlyUser, suspendedUser, boundaryUser]])
      .catch(() => undefined)
    await pool?.query('DELETE FROM attendance_rules WHERE id = ANY($1::uuid[])', [seededDefaultRuleIds]).catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]
    else process.env[W7_ENV] = priorW7
  }, 60_000)

  /**
   * HERMETIC per-test env. `beforeAll` is a per-FILE hook, but `process.env` is
   * per-WORKER and several attendance suites in the same run-list set or clear
   * these two variables. Relying on a `beforeAll` value to still be there when a
   * test body runs is an ordering assumption, not an invariant — and it is the
   * mechanism behind this suite's CI-only failure while the file passed alone.
   *
   * Every leg that depends on the env now installs it itself and restores the
   * previous value, so a neighbour cannot invalidate the premise and this suite
   * cannot leak into one either.
   */
  function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
    const prior = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(vars)) {
      prior.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const restore = () => {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    return body().then(
      (result) => {
        restore()
        return result
      },
      (error) => {
        restore()
        throw error
      },
    )
  }

  /** The allowlist state every punching leg needs, installed per test. */
  const BOTH_MACHINES_ENV = () => ({
    [W4_ENV]: `${bothOrg.toLowerCase()},${w4OnlyOrg.toLowerCase()},${suspendedOrg.toLowerCase()},${boundaryOrg.toLowerCase()}`,
    [W7_ENV]: `${bothOrg.toLowerCase()},${suspendedOrg.toLowerCase()},${boundaryOrg.toLowerCase()}`,
  })

  const punch = async (userId: string, orgId: string, eventType: 'check_in' | 'check_out') =>
    requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(userId)}`,
        'Content-Type': 'application/json',
      },
      // The AUTHORITATIVE posture refuses a null-ID command
      // (`W4C0_OPERATION_ID_REQUIRED`), so the stable operation id is part of
      // the fixture rather than optional decoration.
      body: JSON.stringify({ orgId, eventType, timezone: 'UTC', operationId: randomUUID() }),
    })

  const zeroBusinessCounts = { events: 0, records: 0, operations: 0, calculations: 0, segments: 0, outbox: 0, companions: 0 }
  const businessCounts = async (orgId: string) => (await pool.query(`
    SELECT
      (SELECT count(*)::int FROM attendance_events WHERE org_id=$1) AS events,
      (SELECT count(*)::int FROM attendance_records WHERE org_id=$1) AS records,
      (SELECT count(*)::int FROM attendance_result_operations WHERE org_id=$1) AS operations,
      (SELECT count(*)::int FROM attendance_record_calculations WHERE org_id=$1) AS calculations,
      (SELECT count(*)::int FROM attendance_record_segments s JOIN attendance_record_calculations c ON c.id=s.calculation_id WHERE c.org_id=$1) AS segments,
      (SELECT count(*)::int FROM attendance_result_event_outbox WHERE org_id=$1) AS outbox,
      (SELECT count(*)::int FROM attendance_timezone_context_companions WHERE org_id=$1) AS companions`, [orgId])).rows[0]

  const calculationsFor = async (userId: string) =>
    (
      await pool.query(
        `SELECT c.outcome, c.outcome_reason_code, c.context_snapshot, c.source_definition_fingerprint
           FROM attendance_record_calculations c
           JOIN attendance_records r ON r.id = c.attendance_record_id
          WHERE r.user_id = $1
          ORDER BY c.version`,
        [userId],
      )
    ).rows

  const recordFor = async (userId: string) =>
    (
      await pool.query(
        `SELECT projection_owner, current_calculation_id::text AS current_calculation_id
           FROM attendance_records WHERE user_id = $1`,
        [userId],
      )
    ).rows[0]


  it('h24-midnight regression pin: zoned midnight wall times land on the SAME calendar day', () => {
    // ROOT CAUSE of this suite's three CI-only reds (node 18/20, both legs,
    // deterministic across four heads): older ICU resolves `hour12: false` to
    // the h24 cycle, formatting midnight as hour '24'; the offset computation
    // then overflowed `Date.UTC(..., 24, ...)` a day forward and every
    // midnight wall time froze ONE DAY EARLY, so this suite's '00:00' shift
    // produced an absoluteWindow starting on workDate-1, which the W4 strict
    // rebuild refuses (fingerprint null -> review_required / legacy fallback).
    // The CI node 18/20 matrix IS the old-ICU oracle: without the
    // `hourCycle: 'h23'` + `24 -> 0` fix these assertions red exactly there
    // while staying green on newer local runtimes.
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __buildZonedDateForTests: (d: string, t: string, tz: string) => Date | null
      __getZonedMinutesForTests: (v: Date, tz: string) => number
    }
    const bzd = plugin.__buildZonedDateForTests
    expect(bzd('2026-08-15', '00:00', 'UTC')?.toISOString()).toBe('2026-08-15T00:00:00.000Z')
    expect(bzd('2026-08-15', '00:00', 'Asia/Shanghai')?.toISOString()).toBe('2026-08-14T16:00:00.000Z')
    expect(bzd('2026-08-15', '00:00', 'America/New_York')?.toISOString()).toBe('2026-08-15T04:00:00.000Z')
    // Non-midnight control: proves the pin is midnight-specific, not a tz bug.
    expect(bzd('2026-08-15', '23:59', 'UTC')?.toISOString()).toBe('2026-08-15T23:59:00.000Z')
    // The sibling in-class site: a midnight instant is minute 0, never 1440.
    expect(plugin.__getZonedMinutesForTests(new Date('2026-08-15T00:00:00.000Z'), 'UTC')).toBe(0)

    // STRUCTURAL PREMISE PINS — deterministic on EVERY ICU, so this leg keeps
    // teeth after CI runners upgrade past the h24-resolving versions (the
    // assertions above are discriminating only on old ICU; these two are
    // discriminating everywhere):
    //   (1) h24 really does render the midnight that BEGINS a day as hour '24'
    //       on the SAME displayed calendar date — the `24 -> 0` fold's exact
    //       assumption; if any ICU ever rolled the date back instead, the fold
    //       would land a day early and this pin would red first;
    //   (2) an explicit `hourCycle: 'h23'` is honoured (midnight = '00') — the
    //       property the fix stands on.
    const partsOf = (hourCycle: 'h23' | 'h24') =>
      Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          hourCycle,
          timeZone: 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
          .formatToParts(new Date('2026-08-15T00:30:00.000Z'))
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, part.value]),
      )
    expect(partsOf('h24')).toMatchObject({ day: '15', hour: '24' })
    expect(partsOf('h23')).toMatchObject({ day: '15', hour: '00' })
  })

  it('T-M5 + T-R1: both machines ON => the group arm runs END TO END and the inner/outer fingerprints AGREE', async () => {
    await withEnv(BOTH_MACHINES_ENV(), async () => {
    // EXACT membership, not substring: the allowlist rule is exact-org, and a
    // substring check would pass for an org that merely shares a prefix.
    expect(
      String(process.env[W4_ENV] || '').split(',').map((v) => v.trim()),
      'W4 allowlist must carry the org',
    ).toContain(bothOrg.toLowerCase())
    expect(
      String(process.env[W7_ENV] || '').split(',').map((v) => v.trim()),
      'W7 allowlist must carry the org',
    ).toContain(bothOrg.toLowerCase())

    const res = await punch(bothUser, bothOrg, 'check_in')
    expect(res.status, `punch failed: ${res.raw}`).toBe(200)

    const calcs = await calculationsFor(bothUser)
    expect(calcs.length, 'no calculation was persisted').toBeGreaterThan(0)
    const calc = calcs[calcs.length - 1]

    // ---- T-M5, as a POSITIVE EQUALITY -------------------------------------
    // If the mirror hashed a V2 while the inner arm built a V1, this row would
    // be `review_required` / `context_mismatch` with zeroed segments. Asserting
    // the SUCCESS value (not `notEqual('context_mismatch')`) is what makes this
    // able to distinguish "the fingerprints matched" from "it failed for some
    // other reason".
    expect(calc.outcome).toBe('completed')
    // The SUCCESS reason code, asserted positively. `context_mismatch` is the
    // value this row would carry if the mirror's V2 and the inner arm's context
    // disagreed, so pinning the success value is what closes the inversion.
    expect(calc.outcome_reason_code).toBe('calculated')

    // ---- T-R1: the cutover actually happened ------------------------------
    const ctx = calc.context_snapshot as Record<string, unknown>
    expect(ctx.schemaVersion).toBe(2)
    expect(ctx.selector).toBe('group_effective')
    expect(ctx.calculationGroupId).toBe(bothGroup)

    // ---- T-P1 / T-P7: PROVENANCE EMISSION, the first real producer --------
    // W7-1a-M widened `projection_owner` to accept `w4_group` and emitted it
    // nowhere; this is the row the product actually produces reaching
    // `chk_ar_projection_owner` and `chk_ar_owner_pointer_pair` for real,
    // rather than via a synthetic insert.
    const record = await recordFor(bothUser)
    expect(record.projection_owner).toBe('w4_group')
    expect(record.current_calculation_id).toEqual(expect.any(String))
    expect(String(record.current_calculation_id).length).toBeGreaterThan(0)
    })
  }, 60_000)

  it('T-B4 + T-M4 arm-A-TRUE: W4 env SET with the posture table EMPTY => the mirror RUNS, takes the LEGACY arm, and the punch completes', async () => {
    // THE CONFIGURATION THAT ACTUALLY SHIPS for every existing W4-rolled-out org
    // once this lands. It is the only combination in which arm A of the mirror's
    // `A || B` gate is TRUE while arm B is false — every other leg in this matrix
    // has either the W4 env unset or a posture row present, so without this leg
    // the live path for existing W4 orgs is unmeasured and "arm A true" is only
    // ever tested as "arm A false".
    await withEnv(BOTH_MACHINES_ENV(), async () => {
    expect(
      String(process.env[W4_ENV] || '').split(',').map((v) => v.trim()),
      'the W4 allowlist must carry this org',
    ).toContain(w4OnlyOrg.toLowerCase())
    expect(
      String(process.env[W7_ENV] || '').split(',').map((v) => v.trim()),
      'the W7 allowlist must NOT carry this org',
    ).not.toContain(w4OnlyOrg.toLowerCase())
    const postureRows = await pool.query(
      `SELECT 1 FROM ${POSTURE_TABLE} WHERE org_id = $1`,
      [w4OnlyOrg.toLowerCase()],
    )
    expect(postureRows.rowCount, 'this org must have NO posture row').toBe(0)

    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __setAttendanceW4LivePunchPreBoundarySeamForTests: (
        seam: ((ctx: Record<string, unknown>) => Promise<void>) | null,
      ) => void
    }
    const observed: Record<string, unknown>[] = []
    plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(async (ctx) => {
      observed.push(ctx)
    })
    try {
      const res = await punch(w4OnlyUser, w4OnlyOrg, 'check_in')
      expect(res.status, `punch failed: ${res.raw}`).toBe(200)
      expect(observed.length, 'the pre-boundary seam never fired').toBeGreaterThan(0)
      const ctx = observed[observed.length - 1]

      // Arm A TRUE, arm B FALSE — asserted as exact values, not as "not group".
      expect(ctx.w7MirrorEffectiveState).toBe('off')
      expect(ctx.w7MirrorSelectsGroupArm).toBe(false)

      // T-B4: the mirror RAN and produced a real fingerprint over a LEGACY V1
      // context. A null here would mean the disjunction lost its W4 arm; a v2
      // context here would mean the seam mis-routed an org with no posture row.
      //
      // ⚠️ TYPE ASSERTED BEFORE SHAPE, deliberately. `typeof null === 'object'`,
      // so a NULL fingerprint makes `.toMatch()` report
      // "expects to receive a string, but got object" — a TypeError that reads
      // like a producer type bug and completely hides the real condition (the
      // mirror did not run). That is exactly how CI's T-B4 failure was first
      // mis-read. The producing site is correctly typed `string | null`; the
      // ambiguity was in the ASSERTION, so the assertion now names it.
      expect(
        typeof ctx.outerSourceDefinitionFingerprint,
        'the mirror produced NO fingerprint (null) — it did not run, which means ' +
          'the W4 allowlist was not visible at the time the mirror gate was evaluated',
      ).toBe('string')
      expect(ctx.outerSourceDefinitionFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect((ctx.outerContext as Record<string, unknown>).schemaVersion).toBe(1)
      expect((ctx.outerContext as Record<string, unknown>).selector).toBe('legacy')
      expect((ctx.outerContext as Record<string, unknown>).calculationGroupId).toBeNull()

      // ...and the punch COMPLETES: the mirror's outer fingerprint and the
      // boundary's inner one agree on the legacy arm too, not only on the group
      // arm. Asserted as the positive success equality.
      const calcs = await calculationsFor(w4OnlyUser)
      expect(calcs.length).toBeGreaterThan(0)
      const calc = calcs[calcs.length - 1]
      expect(calc.outcome).toBe('completed')
      expect(calc.outcome_reason_code).toBe('calculated')
      expect((calc.context_snapshot as Record<string, unknown>).selector).toBe('legacy')

      // Provenance stays `w4` — the group emitter must not fire for a non-group
      // org. This is the negative half of T-P1, in the same run.
      const record = await recordFor(w4OnlyUser)
      expect(record.projection_owner).toBe('w4')
    } finally {
      plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(null)
    }
    })
  }, 60_000)

  it('OD-W7-4(a) HTTP refusal: a suspended org punch returns 409 with zero business writes', async () => {
    // HTTP preflight now encounters suspension before the live boundary.
    // The separate direct-boundary case below proves the inner guard.
    await withEnv(BOTH_MACHINES_ENV(), async () => {
      expect(await businessCounts(suspendedOrg)).toEqual(zeroBusinessCounts)
      const res = await punch(suspendedUser, suspendedOrg, 'check_in')
      expect(res.status, res.raw).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: { code: 'W4C2_W7_CONTEXT_SOURCE_SUSPENDED', message: 'W4C2_W7_CONTEXT_SOURCE_SUSPENDED' },
      })
      expect(await businessCounts(suspendedOrg)).toEqual(zeroBusinessCounts)
    })
  }, 60_000)

  it('legacy boundary refuses suspension after prepare; disarmed control completes', async () => {
    await withEnv(BOTH_MACHINES_ENV(), async () => {
      const driver = createLegacyLivePunchBoundaryDriver(pool)
      const command = {
        orgId: boundaryOrg, userId: boundaryUser, eventType: 'check_in' as const,
        occurredAt: '2026-08-20T12:00:00.000Z', timezone: 'UTC', operationId: randomUUID(),
      }
      await seedAttendanceW7ContextSourcePostureV1(pool, boundaryOrg, 'off')
      try {
        const prepared = await driver.prepare(command)
        expect(prepared.outerIssued?.arm).toBe('legacy')
        await seedAttendanceW7ContextSourcePostureV1(pool, boundaryOrg, 'suspended')
        expect(await businessCounts(boundaryOrg)).toEqual(zeroBusinessCounts)
        await expect(driver.execute(prepared)).rejects.toMatchObject({
          code: 'W4C2_W7_CONTEXT_SOURCE_SUSPENDED', httpStatus: 409,
        })
        expect(await businessCounts(boundaryOrg)).toEqual(zeroBusinessCounts)

        await seedAttendanceW7ContextSourcePostureV1(pool, boundaryOrg, 'off')
        const control = await driver.execute(await driver.prepare({ ...command, operationId: randomUUID() }))
        expect(control.kind).toBe('w4')
        const calcs = await calculationsFor(boundaryUser)
        expect(calcs).toHaveLength(1)
        expect(calcs[0].outcome).toBe('completed')
        const counts = await businessCounts(boundaryOrg)
        expect(counts.calculations).toBe(1)
        expect(counts.segments).toBeGreaterThan(0)
      } finally {
        await seedAttendanceW7ContextSourcePostureV1(pool, boundaryOrg, 'off')
      }
    })
  })


  it('OD-W7-4(a) PLUGIN-PRODUCER refusal: the same suspension is refused at the plugin producer with its own code', async () => {
    // The SECOND refusal site. Deleting either one alone previously left the
    // whole battery green, which is the untested-guard class this pair closes.
    await withEnv(BOTH_MACHINES_ENV(), async () => {
      const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
        __attendanceW7ProducerForTests?: {
          issueW4FrozenContextForProducerV1:
            | ((trx: unknown, args: Record<string, unknown>) => Promise<unknown>)
            | null
        }
      }
      const ref = plugin.__attendanceW7ProducerForTests
      expect(typeof ref?.issueW4FrozenContextForProducerV1).toBe('function')
      const trx = {
        __w4CanonicalTrx: true,
        query: async (sql: string, p?: unknown[]) => (await pool.query(sql, p)).rows,
      }
      let code: string | null = null
      try {
        await ref!.issueW4FrozenContextForProducerV1!(trx, {
          orgId: suspendedOrg,
          userId: suspendedUser,
          workDate: '2026-06-02',
          timezone: 'UTC',
          isWorkday: true,
          holidayKind: null,
          shiftId: suspendedShift,
        })
      } catch (error) {
        code = (error as { code?: string }).code ?? `<nocode:${String(error)}>`
      }
      expect(code).toBe('W7_CONTEXT_SOURCE_SUSPENDED')
    })
  }, 60_000)

  it('T-R9 (§2.4 coherence precondition): W4-legacy + W7-group is REFUSED at a plugin-side producer, with its own closed code', async () => {
    // The §2.4 fence and the OD-W7-10 refusal are DIFFERENT predicates and must
    // stay singly deletable. This one compares the two state machines NOW; it
    // fires regardless of any prior calculation.
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW7ProducerForTests?: {
        issueW4FrozenContextForProducerV1:
          | ((trx: unknown, args: Record<string, unknown>) => Promise<unknown>)
          | null
      }
    }
    const ref = plugin.__attendanceW7ProducerForTests
    expect(ref, 'the plugin must export the producer reference').toBeTruthy()
    expect(typeof ref?.issueW4FrozenContextForProducerV1).toBe('function')

    const priorW7Env = process.env[W7_ENV]
    const priorW4Env = process.env[W4_ENV]
    // This leg needs the W4 allowlist state too: the coherent-org positive
    // control below only reaches the group arm when both machines are live.
    process.env[W4_ENV] = `${bothOrg.toLowerCase()},${w4OnlyOrg.toLowerCase()}`
    process.env[W7_ENV] = incoherentOrg.toLowerCase()
    try {
      // The plugin-shaped client production passes carries the `__w4CanonicalTrx`
      // marker; several W4C modules validate it, so a bare `{query}` is rejected
      // as `W4C3B_TRANSACTION_CLIENT_INVALID` before the fence is reached.
      const trx = {
        __w4CanonicalTrx: true,
        query: async (sql: string, p?: unknown[]) => (await pool.query(sql, p)).rows,
      }
      let code: string | null = null
      try {
        await ref!.issueW4FrozenContextForProducerV1!(trx, {
          orgId: incoherentOrg,
          userId: incoherentUser,
          workDate: '2026-06-01',
          timezone: 'UTC',
          isWorkday: true,
          holidayKind: null,
          shiftId: incoherentShift,
        })
      } catch (error) {
        code = (error as { code?: string }).code ?? null
      }
      // The EXACT closed code, never "a 409 was thrown" and never `notEqual`.
      expect(code).toBe('W7_GROUP_CONTEXT_POSTURE_INCOHERENT')

      // Paired positive control, SAME run: the coherent org is NOT refused, so
      // the fence is discriminating on coherence rather than refusing the group
      // arm outright.
      process.env[W7_ENV] = bothOrg.toLowerCase()
      const ok = (await ref!.issueW4FrozenContextForProducerV1!(trx, {
        orgId: bothOrg,
        userId: bothUser,
        workDate: '2026-06-01',
        timezone: 'UTC',
        isWorkday: true,
        holidayKind: null,
        shiftId: bothShift,
      })) as { arm: string; context: unknown }
      expect(ok.arm).toBe('group')
      expect(ok.context).not.toBeNull()
    } finally {
      if (priorW7Env === undefined) delete process.env[W7_ENV]
      else process.env[W7_ENV] = priorW7Env
      if (priorW4Env === undefined) delete process.env[W4_ENV]
      else process.env[W4_ENV] = priorW4Env
    }
  }, 60_000)
  // Randomly namespaced immutable history is retained in the disposable integration DB.
  // Do not bypass append-only triggers or partially delete its source facts.
  const frozenFamilies = [
    { family: 'membership', prefix: '76160001', table: 'attendance_calculation_group_memberships', change: "effective_to = effective_from" },
    { family: 'group-policy', prefix: '76160002', table: 'attendance_groups', change: "attendance_type = 'scheduled_shift'" },
    { family: 'FSER-schedule', prefix: '76160003', table: 'attendance_group_fixed_schedule_configs', change: 'end_date = start_date, revision = revision + 1' },
  ] as const

  it.each(frozenFamilies)('W7-R6 frozen_prior preserves snapshots and fingerprints after $family change without live reads', async ({ prefix, table, change }) => {
    const fixture = { orgId: prefix + randomUUID().slice(8), userId: randomUUID(), shiftId: randomUUID(), groupId: randomUUID() }
    const { orgId, userId, shiftId, groupId } = fixture
    await insertActiveUser(userId, orgId)
    // Recompute rechecks stored attendance-admin authority, independently of JWT claims.
    await pool.query(`UPDATE users SET permissions = '["attendance:admin"]'::jsonb WHERE id = $1`, [userId])
    await seedAuthoritativeRollout(orgId)
    await seedShiftAndEffectiveGroup(orgId, userId, shiftId, groupId)
    await withEnv({ [W4_ENV]: orgId.toLowerCase(), [W7_ENV]: orgId.toLowerCase() }, async () => {
      const created = await punch(userId, orgId, 'check_in')
      expect(created.status, 'real group punch must succeed before freezing').toBe(200)
      const priorRows = await pool.query(
        `SELECT c.*, to_jsonb(c)::text AS whole_bytes
           FROM attendance_record_calculations c
           JOIN attendance_records r ON r.current_calculation_id = c.id
          WHERE r.org_id = $1 AND r.user_id = $2`, [orgId, userId],
      )
      expect(priorRows.rows).toHaveLength(1)
      const prior = priorRows.rows[0]
      expect(prior.outcome).toBe('completed')
      expect(prior.context_snapshot.selector).toBe('group_effective')
      expect(prior.context_snapshot.calculationGroupId).toBe(groupId)
      expect(prior.evidence_snapshot.length).toBeGreaterThan(0)
      const snapshotFields = ['attribution_snapshot', 'context_snapshot', 'evidence_snapshot', 'approved_facts_snapshot', 'manual_override_snapshot'] as const
      const snapshotSql = snapshotFields.map(column => `${column}::text AS ${column}`).join(', ')
      const before = (await pool.query(`SELECT ${snapshotSql} FROM attendance_record_calculations WHERE id=$1`, [prior.id])).rows[0]
      const liveBefore = (await pool.query(`SELECT to_jsonb(t)::text AS bytes FROM ${table} t WHERE org_id=$1`, [orgId])).rows
      expect(liveBefore).toHaveLength(1)
      const changed = await pool.query(`UPDATE ${table} SET ${change} WHERE org_id=$1 RETURNING org_id`, [orgId])
      expect(changed.rowCount, 'ordinary live fact UPDATE must actually affect one row').toBe(1)
      const liveAfter = (await pool.query(`SELECT to_jsonb(t)::text AS bytes FROM ${table} t WHERE org_id=$1`, [orgId])).rows
      expect(liveAfter).toHaveLength(1)
      expect(liveAfter).not.toEqual(liveBefore)

      const token = await mintToken(userId)
      const sqlTrace: string[] = []
      const originalQuery = Client.prototype.query
      // Observe actual native delegation; no SQL/result substitution and no provider IO.
      const querySpy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: Parameters<Client['query']>) {
        const carrier: unknown = args[0]
        const text = typeof carrier === 'string' ? carrier : carrier && typeof carrier === 'object' && 'text' in carrier ? String(carrier.text) : ''
        sqlTrace.push(text.replace(/\s+/g, ' ').trim())
        return Reflect.apply(originalQuery, this, args)
      })
      let response: HttpResponse
      try {
        response = await requestJson(`${baseUrl}/api/attendance/records/${prior.attendance_record_id}/recompute`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId, policy: 'frozen_prior', operationId: randomUUID(), expectedCalculationId: prior.id, expectedCalculationVersion: prior.version }),
        })
      } finally { querySpy.mockRestore() }
      expect(response.status, 'actual frozen_prior HTTP recompute must append: ' + String(response.body?.error?.code ?? 'NO_ERROR_CODE')).toBe(200)
      expect(sqlTrace.some(sql => /\bFROM attendance_records\b/i.test(sql)), 'native trace must observe actual record read').toBe(true)
      expect(sqlTrace.some(sql => /\bINSERT INTO attendance_record_calculations\b/i.test(sql)), 'native trace must observe actual calculation append').toBe(true)
      const liveTables = ['attendance_calculation_group_memberships', 'attendance_groups', 'attendance_group_members', 'attendance_group_fixed_schedule_configs', 'attendance_shift_assignments', 'attendance_shifts', 'attendance_shift_segments', 'attendance_rotation_rules', 'attendance_rotation_assignments']
      // Conservative identifier ban, not a FROM/JOIN grammar: also catches ONLY,
      // quoted/schema-qualified relations, comma joins and nested subqueries.
      const liveReads = liveTables.filter(name => sqlTrace.some(sql => new RegExp('\\b' + name + '\\b', 'i').test(sql)))
      expect(liveReads, 'W7-R6 forbids live membership/group/shift/FSER reads during frozen_prior').toEqual([])
      const nextRows = await pool.query(
        `SELECT c.*, ${snapshotFields.map(column => `c.${column}::text AS ${column}_bytes`).join(', ')}
           FROM attendance_record_calculations c
           JOIN attendance_records r ON r.current_calculation_id = c.id
          WHERE r.org_id = $1 AND r.user_id = $2`, [orgId, userId],
      )
      expect(nextRows.rows).toHaveLength(1)
      const next = nextRows.rows[0]
      expect(next.id).not.toBe(prior.id)
      expect(next.version).toBe(prior.version + 1)
      expect(next.entrypoint).toBe('recompute')
      expect(next.outcome).toBe('completed')
      for (const column of snapshotFields) expect(next[column + '_bytes'], column).toBe(before[column])
      expect(next.source_definition_fingerprint).toBe(prior.source_definition_fingerprint)
      expect(next.merge_policy).toBe(prior.merge_policy)
      expect(next.semantic_input_fingerprint).toBe(prior.semantic_input_fingerprint)
      expect((await pool.query('SELECT to_jsonb(c)::text AS whole_bytes FROM attendance_record_calculations c WHERE id=$1', [prior.id])).rows[0].whole_bytes).toBe(prior.whole_bytes)
    })
  }, 60_000)

})
