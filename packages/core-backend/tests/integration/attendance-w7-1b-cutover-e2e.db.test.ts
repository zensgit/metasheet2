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
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import * as path from 'node:path'
import net from 'net'
import http from 'http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import {
  appendAttendanceRequestCreateSnapshotV1,
  bindAttendanceRequestTerminalSnapshotV1,
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
  extractAttendanceRequestPayloadMetadataFieldsV1,
} from '../../src/attendance/w4c3b-request-snapshots'
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

  const overtimeHistoryOrgs: string[] = []
  const overtimeHistoryUsers: string[] = []
  const allOrgs = () => [bothOrg, incoherentOrg, w4OnlyOrg, suspendedOrg, boundaryOrg, ...overtimeHistoryOrgs]

  const mintToken = async (userId: string, orgId?: string): Promise<string> => {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}${orgId ? '&tenantId=' + encodeURIComponent(orgId) : ''}`,
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
      ?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[bothUser, incoherentUser, w4OnlyUser, suspendedUser, boundaryUser, ...overtimeHistoryUsers]])
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

  async function seedIsolatedOvertimeFixture() {
    const w4OnlyOrg = randomUUID()
    const w4OnlyUser = randomUUID()
    const w4OnlyShift = randomUUID()
    overtimeHistoryOrgs.push(w4OnlyOrg)
    overtimeHistoryUsers.push(w4OnlyUser)
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
    return { w4OnlyOrg, w4OnlyUser, w4OnlyShift }
  }

  it('EP01 approved overtime final decision appends a canonical calculation on the anchored work date', async () => {
    const { w4OnlyOrg, w4OnlyUser } = await seedIsolatedOvertimeFixture()
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + w4OnlyOrg }, async () => {
      await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [w4OnlyUser])
      await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [w4OnlyUser])
      const headers = {
        Authorization: `Bearer ${await mintToken(w4OnlyUser)}`,
        'Content-Type': 'application/json',
      }
      const punched = await punch(w4OnlyUser, w4OnlyOrg, 'check_in')
      expect(punched.status, 'positive canonical live punch').toBe(200)
      const before = await pool.query(
        'SELECT id::text, work_date::text, current_calculation_id::text FROM attendance_records WHERE org_id = $1 AND user_id = $2',
        [w4OnlyOrg, w4OnlyUser],
      )
      expect(before.rows).toHaveLength(1)
      const record = before.rows[0]
      expect(record.current_calculation_id).toEqual(expect.any(String))
      const overtimeRuleId = randomUUID()
      await pool.query('INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)', [overtimeRuleId, w4OnlyOrg, 'EP01_' + overtimeRuleId])
      const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers,
        body: JSON.stringify({
          operationId: randomUUID(), orgId: w4OnlyOrg, workDate: record.work_date,
          requestType: 'overtime', overtimeRuleId, requestedInAt: record.work_date + 'T20:00:00.000Z',
          requestedOutAt: record.work_date + 'T21:00:00.000Z', minutes: 60,
          reason: 'EP01 synthetic overtime bridge',
        }),
      })
      expect(created.status, 'overtime request create status; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
      const requestId = created.body?.data?.request?.id
      expect(requestId).toEqual(expect.any(String))
      const cursor = await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests ar JOIN approval_instances ai ON ai.id = ar.approval_instance_id WHERE ar.id = $1::uuid',
        [requestId],
      )
      expect(cursor.rows).toHaveLength(1)
      const approval = cursor.rows[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, w4OnlyUser, approval.current_node_key],
      )
      const frozen = await pool.query(
        'SELECT version, payload_fingerprint, attribution_snapshot, context_snapshot FROM attendance_request_calculation_snapshots WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version DESC LIMIT 1',
        [w4OnlyOrg, requestId],
      )
      expect(frozen.rows).toHaveLength(1)
      const priorCalculation = await pool.query(
        'SELECT evidence_snapshot, approved_facts_snapshot, manual_override_snapshot FROM attendance_record_calculations WHERE org_id = $1 AND id = $2::uuid',
        [w4OnlyOrg, record.current_calculation_id],
      )
      expect(priorCalculation.rows).toHaveLength(1)
      const decisionOperationId = randomUUID()
      const approved = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST', headers,
        body: JSON.stringify({
          operationId: decisionOperationId, expectedApprovalVersion: Number(approval.version),
          expectedApprovalNode: approval.current_node_key, comment: 'EP01 synthetic final decision',
        }),
      })
      expect(approved.status, 'final overtime approval status; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
      const after = await pool.query(
        'SELECT ar.current_calculation_id::text, c.entrypoint, c.approved_facts_snapshot, c.evidence_snapshot, c.manual_override_snapshot, c.attribution_snapshot, c.context_snapshot, c.semantic_input_fingerprint, c.provenance_fingerprint FROM attendance_records ar LEFT JOIN attendance_record_calculations c ON c.id = ar.current_calculation_id WHERE ar.id = $1::uuid AND ar.org_id = $2',
        [record.id, w4OnlyOrg],
      )
      expect(after.rows).toHaveLength(1)
      expect(after.rows[0].current_calculation_id, 'final approval must move canonical calculation pointer').not.toBe(record.current_calculation_id)
      const calculation = after.rows[0]
      expect(calculation.entrypoint).toBe('approved_overtime')
      expect(calculation.attribution_snapshot).toEqual(frozen.rows[0].attribution_snapshot)
      expect(calculation.context_snapshot).toEqual(frozen.rows[0].context_snapshot)
      expect(calculation.evidence_snapshot).toEqual(priorCalculation.rows[0].evidence_snapshot)
      expect(calculation.manual_override_snapshot).toEqual(priorCalculation.rows[0].manual_override_snapshot)
      const terminal = await pool.query('SELECT metadata FROM attendance_requests WHERE org_id = $1 AND id = $2::uuid', [w4OnlyOrg, requestId])
      const binding = terminal.rows[0].metadata.w4RequestSnapshotTerminalBinding
      expect(calculation.approved_facts_snapshot).toEqual([
        ...priorCalculation.rows[0].approved_facts_snapshot,
        {
          kind: 'overtime', requestId,
          requestSnapshotVersion: frozen.rows[0].version,
          requestSnapshotFingerprint: frozen.rows[0].payload_fingerprint,
          approvalVersion: binding.approvalVersion,
          approvalRecordId: binding.approvalRecordId,
          coverage: {
            kind: 'bounded_interval', startAt: record.work_date + 'T20:00:00.000Z',
            endAt: record.work_date + 'T21:00:00.000Z', minutes: 60,
          },
        },
      ])
      const sealed = await pool.query(
        'SELECT state, resolved_record_id::text, resolved_calculation_id::text, resolved_request_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
        [w4OnlyOrg, decisionOperationId],
      )
      expect(sealed.rows).toEqual([{
        state: 'completed', resolved_record_id: record.id,
        resolved_calculation_id: calculation.current_calculation_id, resolved_request_id: requestId,
        result_semantic_fingerprint: calculation.semantic_input_fingerprint,
        result_provenance_fingerprint: calculation.provenance_fingerprint,
      }])
      expect(approved.body.data).not.toHaveProperty('calculationProof')

    })
  }, 120_000)


  it('EP01 recovered overtime context remains review on a second approval', async () => {
    const orgId = randomUUID()
    const userId = randomUUID()
    const shiftId = randomUUID()
    const overtimeRuleId = randomUUID()
    overtimeHistoryOrgs.push(orgId)
    overtimeHistoryUsers.push(userId)
    await insertActiveUser(userId, orgId)
    await seedAuthoritativeRollout(orgId)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, 'EP01 inherited context', 'UTC', '00:00', '23:59', false,
               '[0,1,2,3,4,5,6]'::jsonb, 7, 5, 15, 'strict')`,
      [shiftId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`, [randomUUID(), orgId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
      [orgId, userId, shiftId],
    )
    await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
    await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
    await pool.query('INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)', [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId])
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
      const headers = { Authorization: `Bearer ${await mintToken(userId)}`, 'Content-Type': 'application/json' }
      const workDate = new Date().toISOString().slice(0, 10)
      let historicalRequestId: string | null = null
      const createAndApprove = async (hour: number, historicalFixture = false) => {
        let requestId: string
        if (historicalFixture) {
          const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
            method: 'POST', headers,
            body: JSON.stringify({
              operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
              requestedInAt: workDate + `T${hour}:00:00.000Z`,
              requestedOutAt: workDate + `T${hour + 1}:00:00.000Z`, minutes: 60, reason: 'EP01 inherited context',
            }),
          })
          expect(created.status, 'create bounded OT; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
          requestId = created.body.data.request.id
          historicalRequestId = requestId
        } else {

          // Legacy/imported duplicate history is schema-valid but today's create API
          // refuses it. Seed pending rows explicitly; never weaken that API guard.
          const source = (await pool.query(
            'SELECT to_jsonb(r) AS request, to_jsonb(a) AS approval FROM attendance_requests r JOIN approval_instances a ON a.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid',
            [orgId, historicalRequestId],
          )).rows[0]
          const parent = (await pool.query(
            'SELECT r.id::text AS record_id, c.attribution_snapshot, c.context_snapshot, t.frame_snapshot FROM attendance_records r JOIN attendance_record_calculations c ON c.id = r.current_calculation_id JOIN attendance_timezone_context_companions t ON t.record_id = r.id AND t.org_id = r.org_id WHERE r.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date',
            [orgId, userId, workDate],
          )).rows[0]
          expect(parent).toBeDefined()
          requestId = randomUUID()
          const approvalId = randomUUID()
          const requestedInAt = workDate + `T${hour}:00:00.000Z`
          const requestedOutAt = workDate + `T${hour + 1}:00:00.000Z`
          const frame = parent.frame_snapshot
          // Match readTargetTimezoneContext's stored-frame -> request-token shape.
          const metadata = { ...source.request.metadata, timezoneContextV1: {
            orgId, userId, workDate, timezone: frame.timezone, contextFingerprint: frame.fingerprint,
            frozen: true, referenceId: parent.record_id, provenance: frame.timezoneContext,
            window: { startAt: frame.absoluteWindow.startAt, endAt: frame.absoluteWindow.endAt },
            rule: frame.context.rule, isWorkingDay: frame.context.isWorkingDay === true,
          } }
          delete metadata.w4RequestSnapshotTerminalBinding
          const payload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
            workDate, requestedInAt, requestedOutAt, reason: source.request.reason,
            ...extractAttendanceRequestPayloadMetadataFieldsV1(metadata),
          })
          const approval = JSON.parse(JSON.stringify(source.approval).replaceAll(historicalRequestId!, requestId))
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await client.query(
              `INSERT INTO approval_instances
               (id, status, version, source_system, workflow_key, business_key, title,
                requester_snapshot, subject_snapshot, policy_snapshot, metadata,
                current_step, total_steps, request_no, form_snapshot, current_node_key, org_id, sync_status)
               VALUES ($1, 'pending', 0, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
                       $10, $11, $12, $13::jsonb, $14, $15, 'ok')`,
              [approvalId, approval.source_system, approval.workflow_key, 'attendance-request:' + requestId,
                approval.title, JSON.stringify(approval.requester_snapshot), JSON.stringify(approval.subject_snapshot),
                JSON.stringify(approval.policy_snapshot), JSON.stringify(approval.metadata), approval.current_step,
                approval.total_steps, 'EP01-' + requestId, JSON.stringify(approval.form_snapshot), approval.current_node_key, orgId],
            )
            await client.query(
              `INSERT INTO attendance_requests
               (id, user_id, org_id, work_date, request_type, requested_in_at, requested_out_at,
                reason, status, approval_instance_id, approval_workflow_key, metadata)
               VALUES ($1, $2, $3, $4::date, 'overtime', $5, $6, $7, 'pending', $8, $9, $10::jsonb)`,
              [requestId, userId, orgId, workDate, requestedInAt, requestedOutAt,
                source.request.reason, approvalId, source.request.approval_workflow_key, JSON.stringify(metadata)],
            )
            await client.query(
              `INSERT INTO attendance_request_calculation_snapshots
               (org_id, request_id, version, request_type, subject_user_id, payload,
                payload_fingerprint, attribution_snapshot, context_snapshot, created_by)
               VALUES ($1, $2::uuid, 1, 'overtime', $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $3)`,
              [orgId, requestId, userId, JSON.stringify(payload),
                computeAttendanceRequestPayloadFingerprintV1(payload),
                JSON.stringify(parent.attribution_snapshot), JSON.stringify(parent.context_snapshot)],
            )
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
        }
        const cursor = (await pool.query(
          'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests ar JOIN approval_instances ai ON ai.id = ar.approval_instance_id WHERE ar.id = $1::uuid', [requestId],
        )).rows[0]
        await pool.query(
          "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
          [cursor.id, userId, cursor.current_node_key],
        )
        if (historicalFixture) {
          // Native missing-projection fixture, not an HTTP approval/cutover claim.
          // Keep the API-created immutable snapshot. Obtain a real BIGSERIAL and
          // let the existing binder validate its instance/action/version linkage.
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const version = Number(cursor.version) + 1
            await client.query("UPDATE approval_instances SET status = 'approved', version = $2 WHERE id = $1", [cursor.id, version])
            const record = await client.query(
              "INSERT INTO approval_records (instance_id, action, actor_id, from_status, to_status, from_version, to_version) VALUES ($1, 'approve', $2, 'pending', 'approved', $3, $4) RETURNING id::text AS id",
              [cursor.id, userId, Number(cursor.version), version],
            )
            const bound = await bindAttendanceRequestTerminalSnapshotV1({
              client, orgId, requestId, requestType: 'overtime', subjectUserId: userId,
              action: 'approve', approvalVersion: version, approvalRecordId: record.rows[0].id,
            })
            expect(bound.kind).toBe('bound')
            if (bound.kind !== 'bound') throw new Error('historical snapshot binding fixture failed')
            await client.query(
              "UPDATE attendance_requests SET status = 'approved', metadata = metadata || $3::jsonb WHERE org_id = $1 AND id = $2::uuid",
              [orgId, requestId, JSON.stringify({ w4RequestSnapshotTerminalBinding: bound.binding })],
            )
            await client.query('UPDATE approval_assignments SET is_active = FALSE WHERE instance_id = $1', [cursor.id])
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
          return { requestId, operationId: null }
        }
        const operationId = randomUUID()
        const approved = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
          method: 'POST', headers,
          body: JSON.stringify({ operationId, expectedApprovalVersion: Number(cursor.version), expectedApprovalNode: cursor.current_node_key }),
        })
        expect(approved.status, 'approve bounded OT; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
        return { requestId, operationId }
      }
      const historical = await createAndApprove(18, true)
      const historicalSnapshot = (await pool.query(
        'SELECT context_snapshot FROM attendance_request_calculation_snapshots WHERE org_id = $1 AND request_id = $2::uuid',
        [orgId, historical.requestId],
      )).rows[0]
      expect(historicalSnapshot).toBeDefined()
      await pool.query('UPDATE attendance_shifts SET late_grace_minutes = 5 WHERE id = $1', [shiftId])
      const punched = await punch(userId, orgId, 'check_in')
      expect(punched.status, 'canonical parent after missing-projection history; code=' + String(punched.body?.error?.code ?? 'none')).toBe(200)
      const parent = (await pool.query(
        'SELECT id::text, current_calculation_id::text, to_jsonb(attendance_records) AS original_row FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date',
        [orgId, userId, workDate],
      )).rows[0]
      expect(parent.current_calculation_id).toEqual(expect.any(String))
      const current = (await pool.query('SELECT context_snapshot, approved_facts_snapshot FROM attendance_record_calculations WHERE org_id = $1 AND id = $2::uuid', [orgId, parent.current_calculation_id])).rows[0]
      expect(current.context_snapshot).not.toEqual(historicalSnapshot.context_snapshot)
      expect(current.approved_facts_snapshot).toEqual([])
      const expectedRequests = [historical.requestId]
      for (const hour of [20, 22]) {
        const next = await createAndApprove(hour)
        expectedRequests.push(next.requestId)
        const calculation = (await pool.query(
          `SELECT c.id::text, c.outcome, c.outcome_reason_code, c.projection_effect,
                  c.expected_segment_count, c.approved_facts_snapshot, c.context_snapshot,
                  c.projected_status, c.projected_first_in_at, c.projected_last_out_at,
                  c.projected_work_minutes, c.projected_late_minutes, c.projected_early_leave_minutes
             FROM attendance_record_calculations c
            WHERE c.org_id = $1 AND c.operation_id = $2::uuid AND c.entrypoint = 'approved_overtime'`,
          [orgId, next.operationId],
        )).rows[0]
        expect(calculation.outcome, 'unresolved historical context must stay review at approval ' + hour).toBe('review_required')
        expect(calculation.outcome_reason_code).toBe('context_mismatch')
        expect(calculation.projection_effect).toBe('none')
        expect(calculation.expected_segment_count).toBe(0)
        expect([
          calculation.projected_status, calculation.projected_first_in_at, calculation.projected_last_out_at,
          calculation.projected_work_minutes, calculation.projected_late_minutes, calculation.projected_early_leave_minutes,
        ]).toEqual([null, null, null, null, null, null])
        expect((await pool.query('SELECT to_jsonb(r) AS value FROM attendance_records r WHERE org_id = $1 AND id = $2::uuid', [orgId, parent.id])).rows[0].value).toEqual(parent.original_row)
        expect(calculation.context_snapshot).toEqual(current.context_snapshot)
        expect(calculation.approved_facts_snapshot.map((fact: { requestId: string }) => fact.requestId).sort()).toEqual([...expectedRequests].sort())
        expect((await pool.query('SELECT current_calculation_id::text FROM attendance_records WHERE org_id = $1 AND id = $2::uuid', [orgId, parent.id])).rows[0].current_calculation_id).toBe(parent.current_calculation_id)
        expect((await pool.query('SELECT count(*)::int AS n FROM attendance_record_segments WHERE org_id = $1 AND calculation_id = $2::uuid', [orgId, calculation.id])).rows[0].n).toBe(0)
      }
    })
  }, 120_000)

  it('EP01 frozen overtime payload conflict returns typed 409 without terminal writes', async () => {
    const { w4OnlyOrg, w4OnlyUser } = await seedIsolatedOvertimeFixture()
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + w4OnlyOrg }, async () => {
      await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [w4OnlyUser])
      await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [w4OnlyUser])
      const headers = {
        Authorization: `Bearer ${await mintToken(w4OnlyUser)}`,
        'Content-Type': 'application/json',
      }
      const punched = await punch(w4OnlyUser, w4OnlyOrg, 'check_in')
      expect(punched.status, 'positive canonical live punch').toBe(200)
      const before = await pool.query(
        'SELECT id::text, work_date::text, current_calculation_id::text FROM attendance_records WHERE org_id = $1 AND user_id = $2',
        [w4OnlyOrg, w4OnlyUser],
      )
      expect(before.rows).toHaveLength(1)
      const record = before.rows[0]
      expect(record.current_calculation_id).toEqual(expect.any(String))
      const overtimeRuleId = randomUUID()
      await pool.query('INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)', [overtimeRuleId, w4OnlyOrg, 'EP01_' + overtimeRuleId])
      const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers,
        body: JSON.stringify({
          operationId: randomUUID(), orgId: w4OnlyOrg, workDate: record.work_date,
          requestType: 'overtime', overtimeRuleId, requestedInAt: record.work_date + 'T20:00:00.000Z',
          requestedOutAt: record.work_date + 'T21:00:00.000Z', minutes: 60,
          reason: 'EP01 synthetic overtime bridge',
        }),
      })
      expect(created.status, 'overtime request create status; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
      const requestId = created.body?.data?.request?.id
      expect(requestId).toEqual(expect.any(String))
      const cursor = await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests ar JOIN approval_instances ai ON ai.id = ar.approval_instance_id WHERE ar.id = $1::uuid',
        [requestId],
      )
      expect(cursor.rows).toHaveLength(1)
      const approval = cursor.rows[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, w4OnlyUser, approval.current_node_key],
      )
      const frozen = await pool.query(
        'SELECT version, payload_fingerprint, attribution_snapshot, context_snapshot FROM attendance_request_calculation_snapshots WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version DESC LIMIT 1',
        [w4OnlyOrg, requestId],
      )
      expect(frozen.rows).toHaveLength(1)
      const priorCalculation = await pool.query(
        'SELECT evidence_snapshot, approved_facts_snapshot, manual_override_snapshot FROM attendance_record_calculations WHERE org_id = $1 AND id = $2::uuid',
        [w4OnlyOrg, record.current_calculation_id],
      )
      expect(priorCalculation.rows).toHaveLength(1)
      const decisionOperationId = randomUUID()
      const decisionBody = JSON.stringify({
        operationId: decisionOperationId, expectedApprovalVersion: Number(approval.version),
        expectedApprovalNode: approval.current_node_key, comment: 'EP01 synthetic final decision',
      })
      const readAtomicState = async () => (await pool.query(
        `SELECT jsonb_build_object(
          'request', (SELECT to_jsonb(r) FROM attendance_requests r WHERE r.org_id = $1 AND r.id = $2::uuid),
          'approval', (SELECT to_jsonb(ai) FROM approval_instances ai WHERE ai.id = $3),
          'record', (SELECT to_jsonb(r) FROM attendance_records r WHERE r.org_id = $1 AND r.id = $4::uuid),
          'approvalRecords', (SELECT count(*) FROM approval_records WHERE instance_id = $3),
          'assignments', (SELECT jsonb_agg(to_jsonb(aa) ORDER BY aa.id) FROM approval_assignments aa WHERE aa.instance_id = $3),
          'calculations', (SELECT count(*) FROM attendance_record_calculations WHERE org_id = $1 AND attendance_record_id = $4::uuid),
          'operation', (SELECT to_jsonb(o) FROM attendance_result_operations o WHERE o.org_id = $1 AND o.operation_id = $5::uuid),
          'outbox', (SELECT count(*) FROM attendance_result_event_outbox WHERE org_id = $1 AND operation_id = $5::uuid)
        ) AS value`,
        [w4OnlyOrg, requestId, approval.id, record.id, decisionOperationId],
      )).rows[0].value
      // Synthetic stale mutable row; the immutable request snapshot stays untouched.
      await pool.query("UPDATE attendance_requests SET requested_out_at = requested_out_at + interval '1 minute' WHERE org_id = $1 AND id = $2::uuid", [w4OnlyOrg, requestId])
      const beforeConflict = await readAtomicState()
      const refused = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST', headers, body: decisionBody,
      })
      expect(refused.status, 'frozen payload conflict status').toBe(409)
      expect(refused.body).toEqual({
        ok: false, error: {
          code: 'ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH',
          message: 'ATTENDANCE_OVERTIME_SNAPSHOT_PAYLOAD_MISMATCH',
        },
      })
      expect(await readAtomicState()).toEqual(beforeConflict)
    })
  }, 120_000)

  it('EP01 frozen overtime rolls back a calculation fault and retries with one sealed result', async () => {
    const { w4OnlyOrg, w4OnlyUser, w4OnlyShift } = await seedIsolatedOvertimeFixture()
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + w4OnlyOrg }, async () => {
      await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [w4OnlyUser])
      await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [w4OnlyUser])
      const headers = {
        Authorization: `Bearer ${await mintToken(w4OnlyUser)}`,
        'Content-Type': 'application/json',
      }
      const punched = await punch(w4OnlyUser, w4OnlyOrg, 'check_in')
      expect(punched.status, 'positive canonical live punch').toBe(200)
      const before = await pool.query(
        'SELECT id::text, work_date::text, current_calculation_id::text FROM attendance_records WHERE org_id = $1 AND user_id = $2',
        [w4OnlyOrg, w4OnlyUser],
      )
      expect(before.rows).toHaveLength(1)
      const record = before.rows[0]
      expect(record.current_calculation_id).toEqual(expect.any(String))
      const overtimeRuleId = randomUUID()
      await pool.query('INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)', [overtimeRuleId, w4OnlyOrg, 'EP01_' + overtimeRuleId])
      const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers,
        body: JSON.stringify({
          operationId: randomUUID(), orgId: w4OnlyOrg, workDate: record.work_date,
          requestType: 'overtime', overtimeRuleId, requestedInAt: record.work_date + 'T20:00:00.000Z',
          requestedOutAt: record.work_date + 'T21:00:00.000Z', minutes: 60,
          reason: 'EP01 synthetic overtime bridge',
        }),
      })
      expect(created.status, 'overtime request create status; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
      const requestId = created.body?.data?.request?.id
      expect(requestId).toEqual(expect.any(String))
      const cursor = await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests ar JOIN approval_instances ai ON ai.id = ar.approval_instance_id WHERE ar.id = $1::uuid',
        [requestId],
      )
      expect(cursor.rows).toHaveLength(1)
      const approval = cursor.rows[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, w4OnlyUser, approval.current_node_key],
      )
      const frozen = await pool.query(
        'SELECT version, payload_fingerprint, attribution_snapshot, context_snapshot FROM attendance_request_calculation_snapshots WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version DESC LIMIT 1',
        [w4OnlyOrg, requestId],
      )
      expect(frozen.rows).toHaveLength(1)
      const priorCalculation = await pool.query(
        'SELECT evidence_snapshot, approved_facts_snapshot, manual_override_snapshot FROM attendance_record_calculations WHERE org_id = $1 AND id = $2::uuid',
        [w4OnlyOrg, record.current_calculation_id],
      )
      expect(priorCalculation.rows).toHaveLength(1)
      const decisionOperationId = randomUUID()
      const decisionBody = JSON.stringify({
        operationId: decisionOperationId, expectedApprovalVersion: Number(approval.version),
        expectedApprovalNode: approval.current_node_key, comment: 'EP01 synthetic final decision',
      })
      const readAtomicState = async () => (await pool.query(
        `SELECT jsonb_build_object(
          'request', (SELECT to_jsonb(r) FROM attendance_requests r WHERE r.org_id = $1 AND r.id = $2::uuid),
          'approval', (SELECT to_jsonb(ai) FROM approval_instances ai WHERE ai.id = $3),
          'record', (SELECT to_jsonb(r) FROM attendance_records r WHERE r.org_id = $1 AND r.id = $4::uuid),
          'approvalRecords', (SELECT count(*) FROM approval_records WHERE instance_id = $3),
          'assignments', (SELECT jsonb_agg(to_jsonb(aa) ORDER BY aa.id) FROM approval_assignments aa WHERE aa.instance_id = $3),
          'calculations', (SELECT count(*) FROM attendance_record_calculations WHERE org_id = $1 AND attendance_record_id = $4::uuid),
          'operation', (SELECT to_jsonb(o) FROM attendance_result_operations o WHERE o.org_id = $1 AND o.operation_id = $5::uuid),
          'outbox', (SELECT count(*) FROM attendance_result_event_outbox WHERE org_id = $1 AND operation_id = $5::uuid)
        ) AS value`,
        [w4OnlyOrg, requestId, approval.id, record.id, decisionOperationId],
      )).rows[0].value
      const originalTimezone = (await pool.query('SELECT timezone FROM attendance_shifts WHERE id = $1', [w4OnlyShift])).rows[0].timezone
      await pool.query("UPDATE attendance_shifts SET timezone = 'Asia/Tokyo' WHERE id = $1", [w4OnlyShift])
      try {
        const beforeFault = await readAtomicState()
        const faultName = 'ep01_ot_fault_' + randomUUID().replaceAll('-', '')
        // Test-owned schema fault, scoped to this synthetic org and only the OT append.
        // No production constraint or trigger is disabled.
        await pool.query(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $ep01$
          BEGIN
            IF NEW.org_id = '${w4OnlyOrg}' AND NEW.entrypoint = 'approved_overtime' THEN
              RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EP01_SYNTHETIC_CALCULATION_ABORT';
            END IF;
            RETURN NEW;
          END
        $ep01$`)
        try {
          await pool.query(`CREATE TRIGGER ${faultName} BEFORE INSERT ON attendance_record_calculations FOR EACH ROW EXECUTE FUNCTION ${faultName}()`)
          const refused = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
            method: 'POST', headers, body: decisionBody,
          })
          expect(refused.status, 'synthetic calculation append fault must abort approval').toBe(500)
          expect(await readAtomicState()).toEqual(beforeFault)
        } finally {
          await pool.query(`DROP TRIGGER IF EXISTS ${faultName} ON attendance_record_calculations`)
          await pool.query(`DROP FUNCTION IF EXISTS ${faultName}()`)
        }
        const approved = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
          method: 'POST', headers,
          body: decisionBody,
        })
        expect(approved.status, 'final overtime approval status; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
        const after = await pool.query(
          'SELECT ar.current_calculation_id::text, c.entrypoint, c.approved_facts_snapshot, c.evidence_snapshot, c.manual_override_snapshot, c.attribution_snapshot, c.context_snapshot, c.semantic_input_fingerprint, c.provenance_fingerprint FROM attendance_records ar LEFT JOIN attendance_record_calculations c ON c.id = ar.current_calculation_id WHERE ar.id = $1::uuid AND ar.org_id = $2',
          [record.id, w4OnlyOrg],
        )
        expect(after.rows).toHaveLength(1)
        expect(after.rows[0].current_calculation_id, 'final approval must move canonical calculation pointer').not.toBe(record.current_calculation_id)
        const calculation = after.rows[0]
        expect(calculation.entrypoint).toBe('approved_overtime')
        expect(calculation.attribution_snapshot).toEqual(frozen.rows[0].attribution_snapshot)
        expect(calculation.context_snapshot).toEqual(frozen.rows[0].context_snapshot)
        expect(calculation.evidence_snapshot).toEqual(priorCalculation.rows[0].evidence_snapshot)
        expect(calculation.manual_override_snapshot).toEqual(priorCalculation.rows[0].manual_override_snapshot)
        const terminal = await pool.query('SELECT metadata FROM attendance_requests WHERE org_id = $1 AND id = $2::uuid', [w4OnlyOrg, requestId])
        const binding = terminal.rows[0].metadata.w4RequestSnapshotTerminalBinding
        expect(calculation.approved_facts_snapshot).toEqual([
          ...priorCalculation.rows[0].approved_facts_snapshot,
          {
            kind: 'overtime', requestId,
            requestSnapshotVersion: frozen.rows[0].version,
            requestSnapshotFingerprint: frozen.rows[0].payload_fingerprint,
            approvalVersion: binding.approvalVersion,
            approvalRecordId: binding.approvalRecordId,
            coverage: {
              kind: 'bounded_interval', startAt: record.work_date + 'T20:00:00.000Z',
              endAt: record.work_date + 'T21:00:00.000Z', minutes: 60,
            },
          },
        ])
        const sealed = await pool.query(
          'SELECT state, resolved_record_id::text, resolved_calculation_id::text, resolved_request_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
          [w4OnlyOrg, decisionOperationId],
        )
        expect(sealed.rows).toEqual([{
          state: 'completed', resolved_record_id: record.id,
          resolved_calculation_id: calculation.current_calculation_id, resolved_request_id: requestId,
          result_semantic_fingerprint: calculation.semantic_input_fingerprint,
          result_provenance_fingerprint: calculation.provenance_fingerprint,
        }])
        expect(approved.body.data).not.toHaveProperty('calculationProof')
        const adjustment = await pool.query(
          "SELECT timezone FROM attendance_events WHERE org_id = $1 AND user_id = $2 AND event_type = 'adjustment' AND meta->>'requestId' = $3",
          [w4OnlyOrg, w4OnlyUser, requestId],
        )
        expect(adjustment.rows).toEqual([{ timezone: frozen.rows[0].context_snapshot.timezone }])
        const beforeReplay = await readAtomicState()
        const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
          method: 'POST', headers, body: decisionBody,
        })
        expect(replay.status).toBe(200)
        expect(replay.body).toEqual(approved.body)
        expect(await readAtomicState()).toEqual(beforeReplay)
      } finally {
        await pool.query('UPDATE attendance_shifts SET timezone = $2 WHERE id = $1', [w4OnlyShift, originalTimezone])
      }

    })
  }, 120_000)

  it.each(['bounded-existing', 'bounded-absent', 'missing-pre-w4', 'unsupported-frozen', 'bounded-manual', 'bounded-manual-explicit', 'bounded-manual-unlinked'] as const)(
    'EP01 shadow overtime %s preserves legacy projection and seals a comparison',
    async (mode) => {
      const orgId = randomUUID()
      const userId = randomUUID()
      const shiftId = randomUUID()
      const overtimeRuleId = randomUUID()
      overtimeHistoryOrgs.push(orgId)
      overtimeHistoryUsers.push(userId)
      await insertActiveUser(userId, orgId)
      await seedLegacyRollout(orgId)
      const enableShadow = () => pool.query(
        "UPDATE attendance_calculation_rollout_state SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1",
        [orgId],
      )
      if (mode === 'bounded-existing' || mode === 'bounded-absent' || mode.startsWith('bounded-manual')) await enableShadow()
      await pool.query(
        `INSERT INTO attendance_shifts
           (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
            late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
         VALUES ($1, $2, 'EP01 shadow fixture', 'UTC', '00:00', '23:59', false,
                 '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 1, 'strict')`,
        [shiftId, orgId],
      )
      await pool.query(
        `INSERT INTO attendance_shift_segments
           (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
         VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
        [randomUUID(), orgId, shiftId],
      )
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
         VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
        [orgId, userId, shiftId],
      )
      await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
      await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
      await pool.query(
        'INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)',
        [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId],
      )
      await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
        const headers = { Authorization: `Bearer ${await mintToken(userId, orgId)}`, 'Content-Type': 'application/json' }
        const workDate = new Date().toISOString().slice(0, 10)
        const settings = await requestJson(`${baseUrl}/api/attendance/settings`, { headers })
        expect(settings.status).toBe(200)
        const original = settings.body.data
        const restoreSettings = {
          compTimeFromOvertime: original.compTimeFromOvertime,
          overtimeBankPolicy: original.overtimeBankPolicy,
          overtimeSegmentation: original.overtimeSegmentation,
        }
        let settingsChanged = false
        try {
        // Synthetic isolated DB only: exercise a real grant before the injected append fault.
        const configured = await requestJson(`${baseUrl}/api/attendance/settings`, {
          method: 'PUT', headers, body: JSON.stringify({
            compTimeFromOvertime: { ...original.compTimeFromOvertime, enabled: mode === 'bounded-existing' },
            overtimeBankPolicy: { ...original.overtimeBankPolicy, enabled: false },
            overtimeSegmentation: { ...original.overtimeSegmentation, enabled: false },
          }),
        })
        expect(configured.status, 'configure fixture; code=' + String(configured.body?.error?.code ?? 'none')).toBe(200)
        settingsChanged = true
        if (mode === 'bounded-existing' || mode.startsWith('bounded-manual')) {
          const punched = await punch(userId, orgId, 'check_in')
          expect(punched.status, 'shadow physical punch').toBe(200)
        }
        let manualOverride = null
        if (mode.startsWith('bounded-manual')) {
          const prior = (await pool.query(
            "SELECT c.id, c.version, c.attendance_record_id FROM attendance_record_calculations c WHERE c.org_id = $1 AND c.mode = 'shadow' AND c.operation_id IS NOT NULL ORDER BY c.version DESC LIMIT 1",
            [orgId],
          )).rows[0]
          const manualOperationId = randomUUID()
          const manualKey = mode === 'bounded-manual-explicit' ? 'manual-' + randomUUID().slice(0, 16) : manualOperationId
          const edited = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
            method: 'POST', headers, body: JSON.stringify({
              orgId, recordId: prior.attendance_record_id,
              expectedCalculationId: prior.id, expectedCalculationVersion: prior.version,
              idempotencyKey: manualKey, targetStatus: 'adjusted',
              ...(mode === 'bounded-manual-explicit' ? { operationId: manualOperationId } : {}),
              overrideMetrics: { workMinutes: 123, lateMinutes: 0, earlyLeaveMinutes: 0 },
              reason: 'EP01 manual identity synthetic fixture', evidence: [],
            }),
          })
          expect(edited.status, 'manual edit; code=' + String(edited.body?.error?.code ?? 'none')).toBe(200)
          const audit = (await pool.query(
            'SELECT id, idempotency_key FROM attendance_record_result_edits WHERE org_id = $1 AND record_id = $2',
            [orgId, prior.attendance_record_id],
          )).rows
          expect(audit).toHaveLength(1)
          expect(audit[0].id).not.toBe(manualOperationId)
          expect(audit[0].idempotency_key).toBe(manualKey)
          manualOverride = (await pool.query(
            'SELECT manual_override_snapshot FROM attendance_record_calculations WHERE org_id = $1 AND id = $2',
            [orgId, edited.body.data.calculationId],
          )).rows[0].manual_override_snapshot
          expect(manualOverride.editId).toBe(manualOperationId)
          if (mode === 'bounded-manual-unlinked') {
            // Historical extra audit with no producing calculation: never accept it
            // merely because an older audit links to the frozen override.
            await pool.query(
              `INSERT INTO attendance_record_result_edits
                (org_id, record_id, user_id, work_date, before_status, after_status,
                 before_snapshot, after_snapshot, reason, evidence, actor_user_id, idempotency_key, created_at)
               SELECT org_id, record_id, user_id, work_date, before_status, after_status,
                      before_snapshot, after_snapshot, reason, evidence, actor_user_id, $2, created_at + interval '1 second'
                 FROM attendance_record_result_edits WHERE id = $1`,
              [audit[0].id, randomUUID()],
            )
          }
        }
        const existingRows = (await pool.query(
          'SELECT to_jsonb(r) AS value FROM attendance_records r WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date',
          [orgId, userId, workDate],
        )).rows
        expect(existingRows).toHaveLength(mode === 'bounded-existing' || mode.startsWith('bounded-manual') ? 1 : 0)
        const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
          method: 'POST', headers,
          body: JSON.stringify({
            operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
            requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
            minutes: 60, reason: 'EP01 shadow synthetic fixture',
          }),
        })
        expect(created.status, 'shadow create; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
        const requestId = created.body.data.request.id
        if (mode === 'unsupported-frozen') {
          await enableShadow()
          // Explicit historical unsupported-snapshot fixture. Use the real immutable
          // appender/binder; this is not a claim that today's create producer emits it.
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const appended = await appendAttendanceRequestCreateSnapshotV1({
              client, orgId, requestId, requestType: 'overtime',
              subjectUserId: userId, actorUserId: userId, payloadFields: { minutes: 60 },
              attributionSnapshot: { posture: 'unsupported', sourceSchemaVersion: null, reason: 'unresolved', sourceFingerprint: null },
              contextSnapshot: null,
            })
            expect(appended.kind).toBe('appended')
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
        }
        const frozen = (await pool.query(
          'SELECT version, payload_fingerprint, attribution_snapshot, context_snapshot FROM attendance_request_calculation_snapshots WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version DESC LIMIT 1',
          [orgId, requestId],
        )).rows
        expect(frozen).toHaveLength(mode === 'missing-pre-w4' ? 0 : 1)
        if (mode === 'missing-pre-w4') await enableShadow()
        const approval = (await pool.query(
          'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid',
          [orgId, requestId],
        )).rows[0]
        await pool.query(
          "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
          [approval.id, userId, approval.current_node_key],
        )
        const operationId = randomUUID()
        const body = JSON.stringify({
          operationId, expectedApprovalVersion: Number(approval.version),
          expectedApprovalNode: approval.current_node_key, comment: 'EP01 shadow decision',
        })
        const approve = () => requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
          method: 'POST', headers, body,
        })
        const state = async () => (await pool.query(
          `SELECT jsonb_build_object(
            'request', (SELECT to_jsonb(r) FROM attendance_requests r WHERE r.org_id = $1 AND r.id = $2::uuid),
            'approval', (SELECT to_jsonb(a) FROM approval_instances a WHERE a.id = $3),
            'approvalRecords', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_records a WHERE a.instance_id = $3),
            'assignments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_assignments a WHERE a.instance_id = $3),
            'records', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM attendance_records r WHERE r.org_id = $1),
            'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM attendance_events e WHERE e.org_id = $1),
            'calculations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM attendance_record_calculations c WHERE c.org_id = $1),
            'segments', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM attendance_record_segments s WHERE s.org_id = $1),
            'balances', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balances b WHERE b.org_id = $1),
            'balanceEvents', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balance_events b WHERE b.org_id = $1),
            'operation', (SELECT to_jsonb(o) FROM attendance_result_operations o WHERE o.org_id = $1 AND o.operation_id = $4::uuid),
            'outbox', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM attendance_result_event_outbox o WHERE o.org_id = $1 AND o.operation_id = $4::uuid)
          ) AS value`, [orgId, requestId, approval.id, operationId],
        )).rows[0].value
        if (mode === 'bounded-existing') {
          const beforeFault = await state()
          const faultName = 'ep01_shadow_fault_' + randomUUID().replaceAll('-', '')
          await pool.query(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $ep01$
            BEGIN
              IF NEW.org_id = '${orgId}' AND NEW.entrypoint = 'approved_overtime' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EP01_SHADOW_SYNTHETIC_ABORT';
              END IF;
              RETURN NEW;
            END
          $ep01$`)
          try {
            await pool.query(`CREATE TRIGGER ${faultName} BEFORE INSERT ON attendance_record_calculations FOR EACH ROW EXECUTE FUNCTION ${faultName}()`)
            expect((await approve()).status, 'shadow append failure aborts terminal and legacy writes').toBe(500)
            expect(await state()).toEqual(beforeFault)
          } finally {
            await pool.query(`DROP TRIGGER IF EXISTS ${faultName} ON attendance_record_calculations`)
            await pool.query(`DROP FUNCTION IF EXISTS ${faultName}()`)
          }
        }
        const approved = await approve()
        expect(approved.status, 'shadow final approval; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
        const records = (await pool.query(
          'SELECT to_jsonb(r) AS value FROM attendance_records r WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date',
          [orgId, userId, workDate],
        )).rows
        expect(records).toHaveLength(1)
        const record = records[0].value
        expect(record.projection_owner).toBe('legacy_untracked')
        expect(record.current_calculation_id).toBeNull()
        expect(record.visibility_state).toBe('active')
        expect(record.status).toBe('adjusted')
        expect(record.timezone).toBe('UTC')
        expect(record.is_workday).toBe(true)
        expect(record.first_in_at).toBe(existingRows[0]?.value.first_in_at ?? null)
        expect(record.last_out_at).toBe(existingRows[0]?.value.last_out_at ?? null)
        if (!mode.startsWith('bounded-manual')) expect(record.work_minutes).toBe(mode === 'bounded-existing' ? existingRows[0].value.work_minutes : 0)
        expect(approved.body.data.record.id).toBe(record.id)
        expect(approved.body.data.record.status).toBe(record.status)
        expect(approved.body.data).not.toHaveProperty('calculationProof')
        const calculations = (await pool.query(
          "SELECT * FROM attendance_record_calculations WHERE org_id = $1 AND operation_id = $2::uuid AND entrypoint = 'approved_overtime'",
          [orgId, operationId],
        )).rows
        expect(calculations).toHaveLength(1)
        const calculation = calculations[0]
        expect(calculation.mode).toBe('shadow')
        expect(calculation.attendance_record_id).toBe(record.id)
        expect(calculation.projection_effect).toBe('none')
        if (mode.startsWith('bounded-manual') && mode !== 'bounded-manual-unlinked') {
          expect(calculation.outcome, 'complete frozen manual edit must remain calculable').toBe('completed')
          expect(calculation.manual_override_snapshot).toEqual(manualOverride)
          expect(calculation.projected_status).toBe('adjusted')
          expect(calculation.projected_work_minutes).toBe(123)
        }
        const terminal = (await pool.query(
          'SELECT status, metadata FROM attendance_requests WHERE org_id = $1 AND id = $2::uuid', [orgId, requestId],
        )).rows[0]
        expect(terminal.status).toBe('approved')
        expect(terminal.metadata.minutes).toBe(60)
        const binding = terminal.metadata.w4RequestSnapshotTerminalBinding
        if (mode === 'missing-pre-w4') {
          expect(binding.bindingPosture).toBe('unsupported_pre_w4_shadow')
          expect(calculation.outcome).toBe('review_required')
          expect(calculation.outcome_reason_code).toBe('missing_frozen_context')
          expect(calculation.context_snapshot).toBeNull()
          expect(calculation.source_definition_fingerprint).toBeNull()
          expect(calculation.approved_facts_snapshot).toEqual([])
          expect(calculation.expected_segment_count).toBe(0)
          expect([
            calculation.projected_status, calculation.projected_first_in_at, calculation.projected_last_out_at,
            calculation.projected_work_minutes, calculation.projected_late_minutes, calculation.projected_early_leave_minutes,
          ]).toEqual([null, null, null, null, null, null])
          expect((await pool.query(
            'SELECT count(*)::int AS n FROM attendance_request_calculation_snapshots WHERE org_id = $1 AND request_id = $2::uuid',
            [orgId, requestId],
          )).rows[0].n).toBe(0)
        } else {
          expect(binding.bindingPosture).toBe('bound')
          expect(calculation.outcome).toBe(mode === 'unsupported-frozen' || mode === 'bounded-manual-unlinked' ? 'review_required' : 'completed')
          if (mode === 'bounded-manual-unlinked') {
            expect(calculation.outcome_reason_code).toBe('frozen_evidence_unavailable')
            expect(calculation.manual_override_snapshot).toEqual(manualOverride)
            expect(calculation.projected_status).toBeNull()
            expect(calculation.projected_work_minutes).toBeNull()
          }
          if (mode === 'unsupported-frozen') {
            expect(calculation.outcome_reason_code).toBe('missing_frozen_context')
            expect(calculation.source_definition_fingerprint).toBeNull()
            expect(calculation.context_snapshot).toBeNull()
          }
          expect(calculation.attribution_snapshot).toEqual(frozen[0].attribution_snapshot)
          expect(calculation.context_snapshot).toEqual(frozen[0].context_snapshot)
          expect(calculation.approved_facts_snapshot).toEqual([{
            kind: 'overtime', requestId, requestSnapshotVersion: frozen[0].version,
            requestSnapshotFingerprint: frozen[0].payload_fingerprint,
            approvalVersion: binding.approvalVersion, approvalRecordId: binding.approvalRecordId,
            coverage: {
              kind: 'bounded_interval', startAt: workDate + 'T20:00:00.000Z',
              endAt: workDate + 'T21:00:00.000Z', minutes: 60,
            },
          }])
        }
        const physical = (await pool.query(
          "SELECT id::text AS id FROM attendance_events WHERE org_id = $1 AND event_type IN ('check_in','check_out')",
          [orgId],
        )).rows
        expect(calculation.evidence_snapshot.map((item: { ref: string }) => item.ref).sort()).toEqual(physical.map(item => item.id).sort())
        const children = (await pool.query(
          'SELECT count(*)::int AS n FROM attendance_record_segments WHERE org_id = $1 AND calculation_id = $2::uuid',
          [orgId, calculation.id],
        )).rows[0].n
        expect(children).toBe(calculation.expected_segment_count)
        expect(children).toBe(mode === 'missing-pre-w4' || mode === 'unsupported-frozen' || mode === 'bounded-manual-unlinked' ? 0 : 1)
        const operation = (await pool.query(
          'SELECT state, resolved_record_id::text, resolved_calculation_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
          [orgId, operationId],
        )).rows
        expect(operation).toEqual([{
          state: 'completed', resolved_record_id: record.id, resolved_calculation_id: calculation.id,
          result_semantic_fingerprint: calculation.semantic_input_fingerprint,
          result_provenance_fingerprint: calculation.provenance_fingerprint,
        }])
        expect((await pool.query(
          'SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE org_id = $1 AND operation_id = $2::uuid',
          [orgId, operationId],
        )).rows[0].n).toBe(1)
        const balances = (await pool.query(
          'SELECT id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_id, source_key, status FROM attendance_leave_balances WHERE org_id = $1',
          [orgId],
        )).rows
        if (mode === 'bounded-existing') {
          expect(balances).toEqual([{
            id: expect.any(String), leave_type_code: 'comp_time', amount_minutes: 60, remaining_minutes: 60,
            source_type: 'overtime_conversion', source_id: requestId,
            source_key: 'overtime_conversion:' + requestId, status: 'active',
          }])
          expect((await pool.query(
            'SELECT balance_id, event_type, delta_minutes, source_type, source_id FROM attendance_leave_balance_events WHERE org_id = $1',
            [orgId],
          )).rows).toEqual([{
            balance_id: balances[0].id, event_type: 'grant', delta_minutes: 60,
            source_type: 'overtime_conversion', source_id: requestId,
          }])
        } else {
          expect(balances).toEqual([])
        }
        const after = await state()
        const replay = await approve()
        expect(replay.status).toBe(200)
        expect(replay.body.data).toEqual(approved.body.data)
        expect(await state()).toEqual(after)
        } finally {
          if (settingsChanged) {
          const restored = await requestJson(`${baseUrl}/api/attendance/settings`, {
            method: 'PUT', headers, body: JSON.stringify(restoreSettings),
          })
          expect(restored.status, 'restore isolated fixture settings').toBe(200)
          }
        }
      })
    },
    120_000,
  )

  it.each(['absent', 'absent-review', 'legacy-complete', 'legacy-incomplete', 'hidden-placeholder', 'operator-retired'] as const)(
    'EP01 authoritative overtime parent %s uses native frozen sources',
    async (mode) => {
      const orgId = randomUUID()
      const userId = randomUUID()
      const shiftId = randomUUID()
      const overtimeRuleId = randomUUID()
      overtimeHistoryOrgs.push(orgId)
      overtimeHistoryUsers.push(userId)
      await insertActiveUser(userId, orgId)
      if (mode === 'operator-retired') await seedAuthoritativeRollout(orgId)
      else await seedLegacyRollout(orgId)
      await pool.query(
        `INSERT INTO attendance_shifts
           (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
            late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
         VALUES ($1, $2, 'EP01 parent mode fixture', 'UTC', '00:00', '23:59', false,
                 '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 1, 'strict')`,
        [shiftId, orgId],
      )
      await pool.query(
        `INSERT INTO attendance_shift_segments
           (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
         VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
        [randomUUID(), orgId, shiftId],
      )
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
         VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
        [orgId, userId, shiftId],
      )
      await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
      await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
      await pool.query(
        'INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)',
        [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId],
      )
      await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
        const headers = { Authorization: `Bearer ${await mintToken(userId, orgId)}`, 'Content-Type': 'application/json' }
        const workDate = new Date().toISOString().slice(0, 10)
        const parentRows = async () => (await pool.query(
          'SELECT to_jsonb(r) AS value FROM attendance_records r WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date',
          [orgId, userId, workDate],
        )).rows.map(row => row.value)
        // Real legacy punch: genuine companion, but no immutable calculation.
        if (mode === 'legacy-incomplete') {
          expect((await punch(userId, orgId, 'check_in')).status, 'native legacy punch').toBe(200)
          expect((await pool.query('SELECT count(*)::int AS n FROM attendance_record_calculations WHERE org_id = $1', [orgId])).rows[0].n).toBe(0)
        }
        if (mode !== 'operator-retired') {
          await pool.query("UPDATE attendance_calculation_rollout_state SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1", [orgId])
        }
        if (mode === 'legacy-complete' || mode === 'operator-retired') {
          expect((await punch(userId, orgId, 'check_in')).status, 'native frozen punch source').toBe(200)
        }
        if (mode === 'legacy-complete' || mode === 'legacy-incomplete' || mode === 'operator-retired') {
          expect((await pool.query(
            'SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date',
            [orgId, userId, workDate],
          )).rows[0].n, 'require genuine timezone admission').toBe(1)
        }
        if (mode === 'legacy-complete') {
          const source = (await pool.query(
            "SELECT id, version, attendance_record_id FROM attendance_record_calculations WHERE org_id = $1 AND mode = 'shadow' AND operation_id IS NOT NULL ORDER BY version DESC LIMIT 1", [orgId],
          )).rows[0]
          const edited = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
            method: 'POST', headers, body: JSON.stringify({
              orgId, recordId: source.attendance_record_id,
              expectedCalculationId: source.id, expectedCalculationVersion: source.version,
              idempotencyKey: randomUUID(), targetStatus: 'adjusted',
              overrideMetrics: { workMinutes: 123, lateMinutes: 0, earlyLeaveMinutes: 0 },
              reason: 'EP01 frozen legacy promotion fixture', evidence: [],
            }),
          })
          expect(edited.status, 'native manual override; code=' + String(edited.body?.error?.code ?? 'none')).toBe(200)
        }
        const shadows = (await pool.query(
          "SELECT to_jsonb(c) AS value FROM attendance_record_calculations c WHERE org_id = $1 AND mode = 'shadow' AND operation_id IS NOT NULL ORDER BY version", [orgId],
        )).rows.map(row => row.value)
        if (mode === 'legacy-complete') {
          expect(shadows).toHaveLength(2)
          expect(shadows.map(row => row.outcome)).toEqual(['completed', 'completed'])
          expect(shadows[1].manual_override_snapshot).not.toBeNull()
        }
        const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
          method: 'POST', headers, body: JSON.stringify({
            operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
            requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
            minutes: 60, reason: 'EP01 authoritative parent mode fixture',
          }),
        })
        expect(created.status, 'native bounded create; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
        const requestId = created.body.data.request.id
        const readSnapshots = async () => (await pool.query(
          'SELECT to_jsonb(s) AS value FROM attendance_request_calculation_snapshots s WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version', [orgId, requestId],
        )).rows.map(row => row.value)
        const snapshots = await readSnapshots()
        expect(snapshots).toHaveLength(1)
        const frozen = snapshots[0]
        expect(frozen.attribution_snapshot.posture).toBe('resolved_v2')
        expect(frozen.context_snapshot).toMatchObject({ orgId, userId, workDate, timezone: 'UTC' })
        if (mode === 'legacy-complete') expect(frozen.context_snapshot).toEqual(shadows[1].context_snapshot)
        if (mode === 'absent-review') {
          // Durable synthetic physical PG inputs, not adjustment audit events,
          // requested OT endpoints, fabricated snapshots, or a forced outcome.
          for (const hour of ['09', '10']) {
            await pool.query(
              `INSERT INTO attendance_events (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
               VALUES ($1, $2, $3, $4::date, $5::timestamptz, 'check_in', 'manual', 'UTC', '{}'::jsonb, '{}'::jsonb)`,
              [randomUUID(), userId, orgId, workDate, workDate + 'T' + hour + ':00:00.000Z'],
            )
          }
        }
        if (mode === 'hidden-placeholder') {
          // Explicit PG parent-state fixture with complete EMPTY history. This
          // is not a claim of repairing an earlier unsupported immutable review.
          expect(await parentRows()).toEqual([])
          const { insertAuthoritativeReviewPlaceholderParentV1 } = await import('../../src/attendance/w4c2-live-scheduled-boundary')
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            expect(await insertAuthoritativeReviewPlaceholderParentV1(client, {
              orgId, userId, workDate, timezone: frozen.context_snapshot.timezone,
              isWorkday: frozen.context_snapshot.isWorkday,
            })).toEqual({ created: true })
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
          expect(await businessCounts(orgId)).toMatchObject({ events: 0, calculations: 0, segments: 0, companions: 0 })
        }
        if (mode !== 'operator-retired') {
          for (const [state, prior, version] of [['eligible', 'shadow', 3], ['authoritative', 'eligible', 4]] as const) {
            await pool.query('UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1', [orgId, state, prior, version])
          }
        } else {
          // Real HTTP retirement supplies its reversed calculation and pointer.
          const parent = (await parentRows())[0]
          const current = (await pool.query('SELECT version FROM attendance_record_calculations WHERE org_id = $1 AND id = $2::uuid', [orgId, parent.current_calculation_id])).rows[0]
          const retired = await requestJson(`${baseUrl}/api/attendance/records/${parent.id}/ops-retirement`, {
            method: 'POST', headers: { ...headers, 'X-Org-Id': orgId }, body: JSON.stringify({ operationId: randomUUID(),
              expectedCalculationId: parent.current_calculation_id, expectedCalculationVersion: current.version,
              ticket: 'EP01', reason: 'EP01 parent refusal fixture' }),
          })
          expect(retired.status, 'native operator retirement; code=' + String(retired.body?.error?.code ?? 'none')).toBe(200)
        }
        const beforeParents = await parentRows()
        if (mode === 'absent' || mode === 'absent-review') expect(beforeParents).toEqual([])
        else {
          expect(beforeParents).toHaveLength(1)
          expect(beforeParents[0]).toMatchObject(mode === 'operator-retired'
            ? { visibility_state: 'retired', visibility_reason: 'operator_retirement', current_calculation_id: expect.any(String) }
            : { projection_owner: 'legacy_untracked', current_calculation_id: null,
              visibility_state: mode === 'hidden-placeholder' ? 'retired' : 'active',
              visibility_reason: mode === 'hidden-placeholder' ? 'review_placeholder' : 'active' })
        }
        const approval = (await pool.query(
          'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid', [orgId, requestId],
        )).rows[0]
        await pool.query(
          "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)", [approval.id, userId, approval.current_node_key],
        )
        const operationId = randomUUID()
        const body = JSON.stringify({ operationId, expectedApprovalVersion: Number(approval.version), expectedApprovalNode: approval.current_node_key })
        const approve = () => requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, { method: 'POST', headers, body })
        const state = async () => (await pool.query(
          `SELECT jsonb_build_object(
            'request', (SELECT to_jsonb(r) FROM attendance_requests r WHERE r.org_id = $1 AND r.id = $2::uuid),
            'approval', (SELECT to_jsonb(a) FROM approval_instances a WHERE a.id = $3),
            'approvalRecords', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_records a WHERE a.instance_id = $3),
            'assignments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_assignments a WHERE a.instance_id = $3),
            'records', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM attendance_records r WHERE r.org_id = $1),
            'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM attendance_events e WHERE e.org_id = $1),
            'calculations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM attendance_record_calculations c WHERE c.org_id = $1),
            'segments', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM attendance_record_segments s WHERE s.org_id = $1),
            'companions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.record_id) FROM attendance_timezone_context_companions t WHERE t.org_id = $1),
            'balances', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balances b WHERE b.org_id = $1),
            'balanceEvents', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balance_events b WHERE b.org_id = $1),
            'operation', (SELECT to_jsonb(o) FROM attendance_result_operations o WHERE o.org_id = $1 AND o.operation_id = $4::uuid),
            'outbox', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM attendance_result_event_outbox o WHERE o.org_id = $1 AND o.operation_id = $4::uuid)
          ) AS value`, [orgId, requestId, approval.id, operationId],
        )).rows[0].value
        const before = await state()
        if (mode === 'absent') {
          const faultName = 'ep01_parent_fault_' + randomUUID().replaceAll('-', '')
          await pool.query(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $ep01$
            BEGIN
              IF NEW.org_id = '${orgId}' AND NEW.entrypoint = 'approved_overtime' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EP01_PARENT_SYNTHETIC_ABORT';
              END IF;
              RETURN NEW;
            END
          $ep01$`)
          try {
            await pool.query(`CREATE TRIGGER ${faultName} BEFORE INSERT ON attendance_record_calculations FOR EACH ROW EXECUTE FUNCTION ${faultName}()`)
            expect((await approve()).status, 'append fault rolls back freshly inserted placeholder').toBe(500)
            expect(await state()).toEqual(before)
            expect(await parentRows()).toEqual([])
          } finally {
            await pool.query(`DROP TRIGGER IF EXISTS ${faultName} ON attendance_record_calculations`)
            await pool.query(`DROP FUNCTION IF EXISTS ${faultName}()`)
          }
        }
        const approved = await approve()
        if (mode === 'operator-retired') {
          expect(approved.status).toBe(409)
          expect(approved.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_OVERTIME_RETIRED_PARENT', message: 'ATTENDANCE_OVERTIME_RETIRED_PARENT' } })
          expect(await state()).toEqual(before)
          return
        }
        expect(approved.status, 'native final decision; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
        const calculations = (await pool.query(
          "SELECT * FROM attendance_record_calculations WHERE org_id = $1 AND operation_id = $2::uuid AND entrypoint = 'approved_overtime'", [orgId, operationId],
        )).rows
        expect(calculations).toHaveLength(1)
        const calculation = calculations[0]
        expect(calculation.mode).toBe('authoritative')
        expect(calculation.attribution_snapshot).toEqual(frozen.attribution_snapshot)
        expect(calculation.context_snapshot).toEqual(frozen.context_snapshot)
        const terminal = (await pool.query('SELECT status, metadata FROM attendance_requests WHERE org_id = $1 AND id = $2::uuid', [orgId, requestId])).rows[0]
        expect(terminal.status).toBe('approved')
        const binding = terminal.metadata.w4RequestSnapshotTerminalBinding
        expect(binding.bindingPosture).toBe('bound')
        expect(calculation.approved_facts_snapshot).toEqual([{
          kind: 'overtime', requestId, requestSnapshotVersion: frozen.version, requestSnapshotFingerprint: frozen.payload_fingerprint,
          approvalVersion: binding.approvalVersion, approvalRecordId: binding.approvalRecordId,
          coverage: { kind: 'bounded_interval', startAt: workDate + 'T20:00:00.000Z', endAt: workDate + 'T21:00:00.000Z', minutes: 60 },
        }])
        const physical = (await pool.query("SELECT id::text AS id FROM attendance_events WHERE org_id = $1 AND event_type IN ('check_in','check_out') ORDER BY id", [orgId])).rows
        expect(calculation.evidence_snapshot.map((item: { ref: string }) => item.ref).sort()).toEqual(physical.map(item => item.id).sort())
        const parents = await parentRows()
        expect(parents).toHaveLength(1)
        const parent = parents[0]
        expect(calculation.attendance_record_id).toBe(parent.id)
        const baselines = (await pool.query("SELECT * FROM attendance_record_calculations WHERE org_id = $1 AND calculation_kind = 'legacy_baseline' ORDER BY version", [orgId])).rows
        if (mode === 'legacy-incomplete' || mode === 'absent-review') {
          expect(calculation.outcome).toBe('review_required')
          expect(calculation.outcome_reason_code).toBe(mode === 'absent-review' ? 'duplicate_check_in' : 'frozen_evidence_unavailable')
          expect(calculation.projection_effect).toBe('none')
          expect(calculation.expected_segment_count).toBe(0)
          expect(calculation.segment_snapshot).toEqual([])
          expect([calculation.projected_status, calculation.projected_first_in_at, calculation.projected_last_out_at,
            calculation.projected_work_minutes, calculation.projected_late_minutes, calculation.projected_early_leave_minutes,
          ]).toEqual([null, null, null, null, null, null])
          expect(baselines).toEqual([])
          if (mode === 'legacy-incomplete') {
            expect(parents).toEqual(beforeParents)
            expect(approved.body.data.record.id).toBe(parent.id)
          } else {
            expect(physical).toHaveLength(2)
            expect(parent).toMatchObject({ projection_owner: 'legacy_untracked', current_calculation_id: null,
              visibility_state: 'retired', visibility_reason: 'review_placeholder' })
            expect(calculation.parent_preimage_snapshot).toEqual({ posture: 'absent' })
            expect(approved.body.data.record).toBeNull()
            expect((await pool.query('SELECT record_id::text FROM attendance_timezone_context_companions WHERE org_id = $1', [orgId])).rows).toEqual([{ record_id: parent.id }])
          }
        } else {
          expect(calculation.outcome).toBe('completed')
          expect(calculation.outcome_reason_code).toBe('calculated')
          expect(calculation.projection_effect).toBe('set_active')
          expect(parent).toMatchObject({ projection_owner: 'w4', current_calculation_id: calculation.id, visibility_state: 'active', visibility_reason: 'active' })
          expect(approved.body.data.record.id).toBe(parent.id)
          if (mode === 'legacy-complete') {
            expect(baselines).toHaveLength(1)
            const baseline = baselines[0]
            expect(baseline.outcome).toBe('baseline')
            expect(baseline.projection_effect).toBe('none')
            expect(baseline.operation_id).toBeNull()
            expect(Number(baseline.version)).toBe(Number(shadows[1].version) + 1)
            expect(Number(calculation.version)).toBe(Number(baseline.version) + 1)
            expect(calculation.supersedes_calculation_id).toBe(baseline.id)
            const old = beforeParents[0]
            const projection = { status: old.status,
              firstInAt: old.first_in_at === null ? null : new Date(old.first_in_at).toISOString(),
              lastOutAt: old.last_out_at === null ? null : new Date(old.last_out_at).toISOString(),
              workMinutes: old.work_minutes, lateMinutes: old.late_minutes, earlyLeaveMinutes: old.early_leave_minutes }
            const { computeAttendanceImportRollbackPreimageFingerprintV1 } = await import('../../src/attendance/w4c3a-import-rollback')
            const fingerprint = computeAttendanceImportRollbackPreimageFingerprintV1({ projection,
              projectionOwner: old.projection_owner, currentCalculationId: null, visibilityState: 'active', visibilityReason: 'active' })
            expect(baseline.projected_daily_fingerprint).toBe(fingerprint)
            expect(calculation.parent_preimage_snapshot).toEqual({ posture: 'present', projection,
              projectionOwner: old.projection_owner, currentCalculationId: null, visibilityState: 'active', visibilityReason: 'active', compatibilityFingerprint: fingerprint })
            expect(calculation.evidence_snapshot).toEqual(shadows[1].evidence_snapshot)
            expect(calculation.manual_override_snapshot).toEqual(shadows[1].manual_override_snapshot)
            expect(calculation.projected_work_minutes).toBe(123)
            expect(parent.work_minutes).toBe(123)
            expect((await pool.query("SELECT to_jsonb(c) AS value FROM attendance_record_calculations c WHERE org_id = $1 AND mode = 'shadow' AND operation_id IS NOT NULL ORDER BY version", [orgId])).rows.map(row => row.value)).toEqual(shadows)
          } else {
            expect(baselines).toEqual([])
            expect(calculation.supersedes_calculation_id).toBeNull()
            expect(calculation.evidence_snapshot).toEqual([])
            expect(calculation.projected_first_in_at).toBeNull()
            expect(calculation.projected_last_out_at).toBeNull()
            expect(calculation.projected_work_minutes).toBe(0)
            if (mode === 'absent') expect(calculation.parent_preimage_snapshot).toEqual({ posture: 'absent' })
            else {
              expect(parent.id).toBe(beforeParents[0].id)
              expect(calculation.parent_preimage_snapshot).toMatchObject({ posture: 'present', projectionOwner: 'legacy_untracked',
                currentCalculationId: null, visibilityState: 'retired', visibilityReason: 'review_placeholder' })
            }
          }
        }
        expect((await pool.query('SELECT count(*)::int AS n FROM attendance_record_segments WHERE org_id = $1 AND calculation_id = $2::uuid', [orgId, calculation.id])).rows[0].n).toBe(mode === 'legacy-incomplete' || mode === 'absent-review' ? 0 : frozen.context_snapshot.segments.length)
        expect((await pool.query(
          'SELECT state, resolved_record_id::text, resolved_calculation_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid', [orgId, operationId],
        )).rows).toEqual([{ state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: calculation.id,
          result_semantic_fingerprint: calculation.semantic_input_fingerprint, result_provenance_fingerprint: calculation.provenance_fingerprint }])
        expect((await pool.query('SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE org_id = $1 AND operation_id = $2::uuid', [orgId, operationId])).rows[0].n).toBe(1)
        expect(await readSnapshots()).toEqual(snapshots)
        const after = await state()
        const replay = await approve()
        expect(replay.status).toBe(200)
        expect(replay.body).toEqual(approved.body)
        expect(await state()).toEqual(after)
      })
    },
    120_000,
  )

  it('EP01 native authoritative review history survives first ordinary overtime approval', async () => {
    const orgId = randomUUID()
    const userId = randomUUID()
    const shiftId = randomUUID()
    const overtimeRuleId = randomUUID()
    overtimeHistoryOrgs.push(orgId)
    overtimeHistoryUsers.push(userId)
    await insertActiveUser(userId, orgId)
    await seedAuthoritativeRollout(orgId)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, 'EP01 native review history fixture', 'UTC', '00:00', '23:59', false,
               '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 1, 'strict')`,
      [shiftId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), orgId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
      [orgId, userId, shiftId],
    )
    await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
    await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
    await pool.query(
      'INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)',
      [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId],
    )
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
      const headers = { Authorization: `Bearer ${await mintToken(userId, orgId)}`, 'Content-Type': 'application/json' }
      const workDate = new Date().toISOString().slice(0, 10)
      const parentRows = async () => (await pool.query(
        'SELECT to_jsonb(r) AS value FROM attendance_records r WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date',
        [orgId, userId, workDate],
      )).rows.map(row => row.value)
      const historyRows = async () => (await pool.query(
        'SELECT to_jsonb(c) AS value FROM attendance_record_calculations c WHERE org_id = $1 ORDER BY version', [orgId],
      )).rows.map(row => row.value)
      const physicalRows = async () => (await pool.query(
        "SELECT to_jsonb(e) AS value FROM attendance_events e WHERE org_id = $1 AND event_type IN ('check_in','check_out') ORDER BY occurred_at, id", [orgId],
      )).rows.map(row => row.value)
      expect(await businessCounts(orgId)).toEqual(zeroBusinessCounts)
      expect(await parentRows()).toEqual([])
      expect(await historyRows()).toEqual([])
      expect((await pool.query('SELECT id FROM attendance_requests WHERE org_id = $1', [orgId])).rows).toEqual([])

      // One synthetic physical PG input; the second event and all immutable
      // review history must be produced by the actual HTTP live-punch path.
      const seededEventId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_events (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
         VALUES ($1, $2, $3, $4::date, $5::timestamptz, 'check_in', 'manual', 'UTC', '{}'::jsonb, '{}'::jsonb)`,
        [seededEventId, userId, orgId, workDate, workDate + 'T09:00:00.000Z'],
      )
      const punched = await punch(userId, orgId, 'check_in')
      expect(punched.status, 'native review punch; code=' + String(punched.body?.error?.code ?? 'none')).toBe(200)
      const priorHistory = await historyRows()
      expect(priorHistory).toHaveLength(1)
      const prior = priorHistory[0]
      expect(prior).toMatchObject({
        mode: 'authoritative', entrypoint: 'live', calculation_kind: 'calculation',
        outcome: 'review_required', outcome_reason_code: 'duplicate_check_in',
        projection_effect: 'none', expected_segment_count: 0,
        supersedes_calculation_id: null, restores_calculation_id: null,
        approved_facts_snapshot: [], manual_override_snapshot: null,
      })
      expect(prior.operation_id).toEqual(expect.any(String))
      expect(prior.attribution_snapshot.posture).toBe('resolved_v2')
      expect(prior.context_snapshot).toMatchObject({ orgId, userId, workDate, timezone: 'UTC' })
      expect(prior.context_snapshot.segments).toHaveLength(1)
      expect(prior.source_definition_fingerprint).toMatch(/^[0-9a-f]{64}$/)
      const beforeParents = await parentRows()
      expect(beforeParents).toHaveLength(1)
      const parent = beforeParents[0]
      expect(parent).toMatchObject({
        id: prior.attendance_record_id, projection_owner: 'legacy_untracked', current_calculation_id: null,
        visibility_state: 'retired', visibility_reason: 'review_placeholder',
      })
      expect((await pool.query('SELECT id FROM attendance_record_segments WHERE org_id = $1', [orgId])).rows).toEqual([])
      const physical = await physicalRows()
      expect(physical).toHaveLength(2)
      expect(physical.map(row => row.id).sort()).toEqual([seededEventId, punched.body.data.event.id].sort())
      expect(physical.map(row => row.event_type)).toEqual(['check_in', 'check_in'])
      const expectedEvidence = physical.map(row => ({
        kind: 'punch', ref: row.id, direction: 'check_in',
        occurredAt: new Date(row.occurred_at).toISOString(), source: 'attendance_event',
      }))
      expect(prior.evidence_snapshot).toEqual(expectedEvidence)
      expect((await pool.query(
        'SELECT state, resolved_record_id::text, resolved_calculation_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
        [orgId, prior.operation_id],
      )).rows).toEqual([{
        state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: prior.id,
        result_semantic_fingerprint: prior.semantic_input_fingerprint,
        result_provenance_fingerprint: prior.provenance_fingerprint,
      }])

      // This is the day's first ordinary OT request, not a second same-type request.
      expect((await pool.query('SELECT id FROM attendance_requests WHERE org_id = $1', [orgId])).rows).toEqual([])
      const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers, body: JSON.stringify({
          operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
          requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
          minutes: 60, reason: 'EP01 native review history fixture',
        }),
      })
      expect(created.status, 'first native OT create; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
      const requestId = created.body.data.request.id
      const readSnapshots = async () => (await pool.query(
        'SELECT to_jsonb(s) AS value FROM attendance_request_calculation_snapshots s WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version', [orgId, requestId],
      )).rows.map(row => row.value)
      const snapshots = await readSnapshots()
      expect(snapshots).toHaveLength(1)
      const frozen = snapshots[0]
      expect(frozen.attribution_snapshot.posture).toBe('resolved_v2')
      expect(frozen.context_snapshot).toEqual(prior.context_snapshot)
      expect(frozen.attribution_snapshot.value.absoluteWindow).toEqual(prior.attribution_snapshot.value.absoluteWindow)
      expect(frozen.attribution_snapshot.value.attributionWindow).toEqual(prior.attribution_snapshot.value.attributionWindow)
      expect(await historyRows()).toEqual(priorHistory)
      expect(await parentRows()).toEqual(beforeParents)
      const approval = (await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid', [orgId, requestId],
      )).rows[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, userId, approval.current_node_key],
      )
      const operationId = randomUUID()
      const approved = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST', headers, body: JSON.stringify({
          operationId, expectedApprovalVersion: Number(approval.version), expectedApprovalNode: approval.current_node_key,
        }),
      })
      expect(approved.status, 'native final decision; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
      expect(approved.body.data.record).toBeNull()
      const history = await historyRows()
      expect(history).toHaveLength(2)
      expect(history[0]).toEqual(prior)
      const calculation = history[1]
      expect(calculation).toMatchObject({
        attendance_record_id: parent.id, operation_id: operationId,
        mode: 'authoritative', entrypoint: 'approved_overtime', calculation_kind: 'calculation',
        outcome: 'review_required', outcome_reason_code: 'duplicate_check_in',
        projection_effect: 'none', expected_segment_count: 0, segment_snapshot: [],
        supersedes_calculation_id: null, restores_calculation_id: null, manual_override_snapshot: null,
      })
      expect(Number(calculation.version)).toBe(Number(prior.version) + 1)
      expect(calculation.attribution_snapshot).toEqual(frozen.attribution_snapshot)
      expect(calculation.context_snapshot).toEqual(frozen.context_snapshot)
      expect(calculation.evidence_snapshot).toEqual(prior.evidence_snapshot)
      expect(calculation.evidence_snapshot).toEqual(expectedEvidence)
      expect(await physicalRows()).toEqual(physical)
      const auditEvents = (await pool.query(
        "SELECT id::text, event_type, source, meta->>'requestId' AS request_id FROM attendance_events WHERE org_id = $1 AND event_type NOT IN ('check_in','check_out')", [orgId],
      )).rows
      expect(auditEvents).toEqual([{
        id: expect.any(String), event_type: 'adjustment', source: 'request', request_id: requestId,
      }])
      expect(calculation.evidence_snapshot.map((item: { ref: string }) => item.ref)).not.toContain(auditEvents[0].id)
      expect(calculation.input_provenance.priorCalculations).toEqual([{
        id: prior.id, semanticFingerprint: prior.semantic_input_fingerprint,
        provenanceFingerprint: prior.provenance_fingerprint,
      }])
      const terminal = (await pool.query(
        'SELECT status, metadata FROM attendance_requests WHERE org_id = $1 AND id = $2::uuid', [orgId, requestId],
      )).rows[0]
      expect(terminal.status).toBe('approved')
      const terminalRecords = (await pool.query(
        'SELECT id::text, action, from_version, to_version FROM approval_records WHERE instance_id = $1 ORDER BY id', [approval.id],
      )).rows
      expect(terminalRecords).toEqual([{
        id: expect.any(String), action: 'approve', from_version: Number(approval.version), to_version: Number(approval.version) + 1,
      }])
      const binding = terminal.metadata.w4RequestSnapshotTerminalBinding
      expect(binding).toEqual({
        schemaVersion: 1, kind: 'w4c3b_request_snapshot_terminal_binding', orgId, requestId,
        requestType: 'overtime', subjectUserId: userId,
        requestSnapshotVersion: frozen.version, requestSnapshotFingerprint: frozen.payload_fingerprint,
        approvalVersion: terminalRecords[0].to_version, approvalRecordId: terminalRecords[0].id,
        action: 'approve', bindingPosture: 'bound',
      })
      expect(calculation.approved_facts_snapshot).toEqual([{
        kind: 'overtime', requestId, requestSnapshotVersion: frozen.version,
        requestSnapshotFingerprint: frozen.payload_fingerprint,
        approvalVersion: binding.approvalVersion, approvalRecordId: binding.approvalRecordId,
        coverage: { kind: 'bounded_interval', startAt: workDate + 'T20:00:00.000Z', endAt: workDate + 'T21:00:00.000Z', minutes: 60 },
      }])
      for (const row of history) {
        expect([row.projected_status, row.projected_first_in_at, row.projected_last_out_at,
          row.projected_work_minutes, row.projected_late_minutes, row.projected_early_leave_minutes,
          row.projected_daily_fingerprint,
        ]).toEqual([null, null, null, null, null, null, null])
      }
      expect((await pool.query('SELECT id FROM attendance_record_segments WHERE org_id = $1', [orgId])).rows).toEqual([])
      expect((await pool.query("SELECT id FROM attendance_record_calculations WHERE org_id = $1 AND calculation_kind = 'legacy_baseline'", [orgId])).rows).toEqual([])
      expect(await parentRows()).toEqual(beforeParents)
      const projection = {
        status: parent.status, firstInAt: parent.first_in_at, lastOutAt: parent.last_out_at,
        workMinutes: parent.work_minutes, lateMinutes: parent.late_minutes, earlyLeaveMinutes: parent.early_leave_minutes,
      }
      const { computeAttendanceImportRollbackPreimageFingerprintV1 } = await import('../../src/attendance/w4c3a-import-rollback')
      const fingerprint = computeAttendanceImportRollbackPreimageFingerprintV1({
        projection, projectionOwner: 'legacy_untracked', currentCalculationId: null,
        visibilityState: 'retired', visibilityReason: 'review_placeholder',
      })
      expect(calculation.parent_preimage_snapshot).toEqual({
        posture: 'present', projection, projectionOwner: 'legacy_untracked', currentCalculationId: null,
        visibilityState: 'retired', visibilityReason: 'review_placeholder', compatibilityFingerprint: fingerprint,
      })
      expect((await pool.query(
        'SELECT state, resolved_record_id::text, resolved_calculation_id::text, resolved_request_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
        [orgId, operationId],
      )).rows).toEqual([{
        state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: calculation.id,
        resolved_request_id: requestId, result_semantic_fingerprint: calculation.semantic_input_fingerprint,
        result_provenance_fingerprint: calculation.provenance_fingerprint,
      }])
      expect((await pool.query(
        'SELECT event_kind FROM attendance_result_event_outbox WHERE org_id = $1 AND operation_id = $2::uuid', [orgId, operationId],
      )).rows).toEqual([{ event_kind: 'attendance.resolved' }])
      expect(await readSnapshots()).toEqual(snapshots)
    })
  }, 120_000)


  it('EP01 native authoritative overtime final approval waits on the exact class-11 target lock', async () => {
    const {
      buildAttendanceCalculationTargetAdvisoryKey,
      createVerifiedAttendanceCalculationTargetIdentityV1,
      rehydrateVerifiedAttendanceOrgIdentityV1,
    } = await import('../../src/attendance/w4c0-identity')
    const orgId = randomUUID()
    const userId = randomUUID()
    const shiftId = randomUUID()
    const overtimeRuleId = randomUUID()
    overtimeHistoryOrgs.push(orgId)
    overtimeHistoryUsers.push(userId)
    await insertActiveUser(userId, orgId)
    await seedAuthoritativeRollout(orgId)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, 'EP01 target contention fixture', 'UTC', '00:00', '23:59', false,
               '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 1, 'strict')`,
      [shiftId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), orgId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
      [orgId, userId, shiftId],
    )
    await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
    await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
    await pool.query(
      'INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)',
      [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId],
    )
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
      const headers = { Authorization: `Bearer ${await mintToken(userId, orgId)}`, 'Content-Type': 'application/json' }
      expect((await punch(userId, orgId, 'check_in')).status, 'native canonical parent').toBe(200)
      const parents = (await pool.query(
        'SELECT id::text, work_date::text, current_calculation_id::text FROM attendance_records WHERE org_id = $1 AND user_id = $2',
        [orgId, userId],
      )).rows
      expect(parents).toHaveLength(1)
      const parent = parents[0]
      const workDate = parent.work_date
      // Rehydrate from the real completed punch operation, never a fabricated witness.
      const durableOrgs = (await pool.query(
        `SELECT o.org_id AS "orgId", o.accepted_write_posture AS "acceptedWritePosture"
           FROM attendance_result_operations o
           JOIN attendance_record_calculations c
             ON c.org_id = o.org_id AND c.operation_id = o.operation_id AND o.entrypoint = 'live_punch'
          WHERE c.org_id = $1 AND c.id = $2::uuid AND o.state = 'completed'`,
        [orgId, parent.current_calculation_id],
      )).rows
      expect(durableOrgs).toEqual([{ orgId, acceptedWritePosture: 'authoritative' }])
      const targetKey = buildAttendanceCalculationTargetAdvisoryKey(
        createVerifiedAttendanceCalculationTargetIdentityV1({
          org: rehydrateVerifiedAttendanceOrgIdentityV1(durableOrgs[0]), userId, workDate,
        }),
      ).toString()
      const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers, body: JSON.stringify({
          operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
          requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
          minutes: 60, reason: 'EP01 target contention fixture',
        }),
      })
      expect(created.status, 'native OT create; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
      const requestId = created.body.data.request.id
      const approvals = (await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid',
        [orgId, requestId],
      )).rows
      expect(approvals).toHaveLength(1)
      const approval = approvals[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, userId, approval.current_node_key],
      )
      const operationId = randomUUID()
      const body = JSON.stringify({
        operationId, expectedApprovalVersion: Number(approval.version), expectedApprovalNode: approval.current_node_key,
      })
      const approve = () => requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST', headers, body,
      })
      const state = async () => (await pool.query(
        `SELECT jsonb_build_object(
          'request', (SELECT to_jsonb(r) FROM attendance_requests r WHERE r.org_id = $1 AND r.id = $2::uuid),
          'approval', (SELECT to_jsonb(a) FROM approval_instances a WHERE a.id = $3),
          'approvalRecords', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_records a WHERE a.instance_id = $3),
          'assignments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_assignments a WHERE a.instance_id = $3),
          'records', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM attendance_records r WHERE r.org_id = $1),
          'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM attendance_events e WHERE e.org_id = $1),
          'calculations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM attendance_record_calculations c WHERE c.org_id = $1),
          'segments', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM attendance_record_segments s WHERE s.org_id = $1),
          'balances', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balances b WHERE b.org_id = $1),
          'balanceEvents', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balance_events b WHERE b.org_id = $1),
          'operations', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.operation_id) FROM attendance_result_operations o WHERE o.org_id = $1),
          'outbox', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM attendance_result_event_outbox o WHERE o.org_id = $1),
          'snapshots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.version) FROM attendance_request_calculation_snapshots s WHERE s.org_id = $1 AND s.request_id = $2::uuid)
        ) AS value`, [orgId, requestId, approval.id],
      )).rows[0].value
      const before = await state()
      expect(before.request.status).toBe('pending')
      expect(before.calculations).toHaveLength(1)
      expect(before.calculations[0]).toMatchObject({ id: parent.current_calculation_id, outcome: 'completed' })
      const blocker = await pool.connect()
      let pending: Promise<HttpResponse> | undefined
      let settled = false
      try {
        await blocker.query('BEGIN')
        const holderPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [targetKey])
        pending = approve()
        void pending.then(() => { settled = true }, () => { settled = true })
        // Observe THIS key in the bigint keyspace and THIS independent holder.
        // This proves target-lock contention, not two business-writer concurrency.
        const deadline = Date.now() + 3000
        let blocked = false
        while (Date.now() < deadline) {
          const waiters = await pool.query(
            `SELECT waiter.pid FROM pg_locks waiter
               JOIN pg_locks held ON held.locktype = waiter.locktype
                AND held.database = waiter.database AND held.classid = waiter.classid
                AND held.objid = waiter.objid AND held.objsubid = waiter.objsubid
              WHERE waiter.locktype = 'advisory' AND NOT waiter.granted
                AND waiter.mode = 'ExclusiveLock' AND waiter.objsubid = 1
                AND waiter.classid = (($2::bigint >> 32) & 4294967295)::oid
                AND waiter.objid = ($2::bigint & 4294967295)::oid
                AND held.pid = $1::int AND held.granted AND held.mode = 'ExclusiveLock'
                AND $1::int = ANY(pg_blocking_pids(waiter.pid))`,
            [holderPid, targetKey],
          )
          if (waiters.rows.length > 0) {
            expect(waiters.rows).toHaveLength(1)
            blocked = true
            break
          }
          if (settled) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(blocked, 'final HTTP approval must wait on our exact class-11 target key within 3000ms').toBe(true)
        expect(settled, 'HTTP final approval remains pending while blocker holds the target').toBe(false)
        expect(await state(), 'no committed terminal, financial, canonical, operation or outbox changes before release').toEqual(before)
        expect(settled).toBe(false)
      } finally {
        try {
          await blocker.query('ROLLBACK')
        } finally {
          blocker.release()
          // Drain the actual HTTP request even when a barrier/state assertion fails.
          if (pending) await pending
        }
      }
      const approved = await pending!
      expect(approved.status, 'native final approval after target release; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
      const after = await state()
      expect(after.request.status).toBe('approved')
      expect(after.approvalRecords).toHaveLength(1)
      expect(after.approvalRecords[0]).toMatchObject({
        action: 'approve', from_version: Number(approval.version), to_version: Number(approval.version) + 1,
      })
      expect(after.records).toHaveLength(1)
      expect(after.calculations).toHaveLength(2)
      expect(after.calculations.find((c: { id: string }) => c.id === parent.current_calculation_id)).toEqual(before.calculations[0])
      const calculations = after.calculations.filter((c: { operation_id: string }) => c.operation_id === operationId)
      expect(calculations).toHaveLength(1)
      const calculation = calculations[0]
      expect(calculation).toMatchObject({
        attendance_record_id: parent.id, entrypoint: 'approved_overtime', mode: 'authoritative', outcome: 'completed',
      })
      expect(after.records[0].current_calculation_id).toBe(calculation.id)
      expect(calculation.approved_facts_snapshot).toHaveLength(1)
      expect(calculation.approved_facts_snapshot[0]).toMatchObject({ kind: 'overtime', requestId })
      expect(after.operations.filter((o: { operation_id: string }) => o.operation_id === operationId)).toEqual([expect.objectContaining({
        state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: calculation.id,
        resolved_request_id: requestId, result_semantic_fingerprint: calculation.semantic_input_fingerprint,
        result_provenance_fingerprint: calculation.provenance_fingerprint,
      })])
      expect(after.outbox.filter((o: { operation_id: string }) => o.operation_id === operationId)).toEqual([expect.objectContaining({
        event_kind: 'attendance.resolved',
      })])
      expect(after.events.filter((e: { event_type: string }) => e.event_type === 'adjustment')).toHaveLength(1)
      expect(after.snapshots).toEqual(before.snapshots)
      const replay = await approve()
      expect(replay.status).toBe(200)
      expect(replay.body).toEqual(approved.body)
      expect(await state(), 'sealed replay adds no terminal, financial, calculation, event or outbox duplicates').toEqual(after)
    })
  }, 120_000)


  it('EP01 two native HTTP writers serialize check-out then overtime approval on the exact class-11 target', async () => {
    const {
      buildAttendanceCalculationTargetAdvisoryKey,
      createVerifiedAttendanceCalculationTargetIdentityV1,
      rehydrateVerifiedAttendanceOrgIdentityV1,
    } = await import('../../src/attendance/w4c0-identity')
    const orgId = randomUUID()
    const userId = randomUUID()
    const shiftId = randomUUID()
    const overtimeRuleId = randomUUID()
    overtimeHistoryOrgs.push(orgId)
    overtimeHistoryUsers.push(userId)
    await insertActiveUser(userId, orgId)
    await seedAuthoritativeRollout(orgId)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, 'EP01 two HTTP writers fixture', 'UTC', '00:00', '23:59', false,
               '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 1, 'strict')`,
      [shiftId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), orgId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
      [orgId, userId, shiftId],
    )
    await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
    await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
    await pool.query(
      'INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)',
      [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId],
    )
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
      const headers = { Authorization: `Bearer ${await mintToken(userId, orgId)}`, 'Content-Type': 'application/json' }
      expect((await punch(userId, orgId, 'check_in')).status, 'native canonical parent').toBe(200)
      const parents = (await pool.query(
        'SELECT id::text, work_date::text, current_calculation_id::text FROM attendance_records WHERE org_id = $1 AND user_id = $2',
        [orgId, userId],
      )).rows
      expect(parents).toHaveLength(1)
      const parent = parents[0]
      const workDate = parent.work_date
      // Rehydrate from the real completed punch operation, never a fabricated witness.
      const durableOrgs = (await pool.query(
        `SELECT o.org_id AS "orgId", o.accepted_write_posture AS "acceptedWritePosture"
           FROM attendance_result_operations o
           JOIN attendance_record_calculations c
             ON c.org_id = o.org_id AND c.operation_id = o.operation_id AND o.entrypoint = 'live_punch'
          WHERE c.org_id = $1 AND c.id = $2::uuid AND o.state = 'completed'`,
        [orgId, parent.current_calculation_id],
      )).rows
      expect(durableOrgs).toEqual([{ orgId, acceptedWritePosture: 'authoritative' }])
      const targetKey = buildAttendanceCalculationTargetAdvisoryKey(
        createVerifiedAttendanceCalculationTargetIdentityV1({
          org: rehydrateVerifiedAttendanceOrgIdentityV1(durableOrgs[0]), userId, workDate,
        }),
      ).toString()
      const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers, body: JSON.stringify({
          operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
          requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
          minutes: 60, reason: 'EP01 two HTTP writers fixture',
        }),
      })
      expect(created.status, 'native OT create; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
      const requestId = created.body.data.request.id
      const approvals = (await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid',
        [orgId, requestId],
      )).rows
      expect(approvals).toHaveLength(1)
      const approval = approvals[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, userId, approval.current_node_key],
      )
      const operationId = randomUUID()
      const body = JSON.stringify({
        operationId, expectedApprovalVersion: Number(approval.version), expectedApprovalNode: approval.current_node_key,
      })
      const approve = () => requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST', headers, body,
      })
      const punchOperationId = randomUUID()
      const punchBody = JSON.stringify({ orgId, eventType: 'check_out', timezone: 'UTC', operationId: punchOperationId })
      const checkOut = () => requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST', headers, body: punchBody,
      })
      const state = async () => (await pool.query(
        `SELECT jsonb_build_object(
          'request', (SELECT to_jsonb(r) FROM attendance_requests r WHERE r.org_id = $1 AND r.id = $2::uuid),
          'approval', (SELECT to_jsonb(a) FROM approval_instances a WHERE a.id = $3),
          'approvalRecords', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_records a WHERE a.instance_id = $3),
          'assignments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_assignments a WHERE a.instance_id = $3),
          'records', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM attendance_records r WHERE r.org_id = $1),
          'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM attendance_events e WHERE e.org_id = $1),
          'calculations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM attendance_record_calculations c WHERE c.org_id = $1),
          'segments', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM attendance_record_segments s WHERE s.org_id = $1),
          'balances', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balances b WHERE b.org_id = $1),
          'balanceEvents', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balance_events b WHERE b.org_id = $1),
          'operations', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.operation_id) FROM attendance_result_operations o WHERE o.org_id = $1),
          'outbox', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM attendance_result_event_outbox o WHERE o.org_id = $1),
          'snapshots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.version) FROM attendance_request_calculation_snapshots s WHERE s.org_id = $1 AND s.request_id = $2::uuid)
        ) AS value`, [orgId, requestId, approval.id],
      )).rows[0].value
      const before = await state()
      expect(before.request.status).toBe('pending')
      expect(before.calculations).toHaveLength(1)
      expect(before.calculations[0]).toMatchObject({ id: parent.current_calculation_id, outcome: 'completed' })
      // The gate holds ONLY the parent row. The first real HTTP writer owns the
      // target lock; the second real HTTP writer must wait on that writer's PID.
      const gate = await pool.connect()
      let pendingPunch: Promise<HttpResponse> | undefined
      let pendingApproval: Promise<HttpResponse> | undefined
      let punchSettled = false
      let approvalSettled = false
      try {
        await gate.query('BEGIN')
        const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        expect((await gate.query(
          'SELECT id FROM attendance_records WHERE org_id = $1 AND id = $2::uuid FOR UPDATE',
          [orgId, parent.id],
        )).rows).toHaveLength(1)
        pendingPunch = checkOut()
        void pendingPunch.then(() => { punchSettled = true }, () => { punchSettled = true })
        const deadline = Date.now() + 3000
        let punchPid: number | undefined
        while (Date.now() < deadline) {
          const holders = await pool.query(
            `SELECT held.pid FROM pg_locks held
               JOIN pg_stat_activity activity ON activity.pid = held.pid
              WHERE held.locktype = 'advisory' AND held.granted
                AND held.mode = 'ExclusiveLock' AND held.objsubid = 1
                AND held.classid = (($2::bigint >> 32) & 4294967295)::oid
                AND held.objid = ($2::bigint & 4294967295)::oid
                AND held.pid <> $1::int AND $1::int = ANY(pg_blocking_pids(held.pid))
                AND activity.query LIKE '%FROM attendance_records%'
                AND activity.query LIKE '%FOR UPDATE%'`,
            [gatePid, targetKey],
          )
          if (holders.rows.length > 0) {
            expect(holders.rows).toHaveLength(1)
            punchPid = holders.rows[0].pid
            break
          }
          if (punchSettled) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(punchPid, 'native HTTP check-out owns exact class-11 key and waits on the parent-row gate').toEqual(expect.any(Number))
        expect(punchSettled).toBe(false)
        pendingApproval = approve()
        void pendingApproval.then(() => { approvalSettled = true }, () => { approvalSettled = true })
        let approvalPid: number | undefined
        while (Date.now() < deadline) {
          const waiters = await pool.query(
            `SELECT waiter.pid FROM pg_locks waiter
               JOIN pg_locks held ON held.locktype = waiter.locktype
                AND held.database = waiter.database AND held.classid = waiter.classid
                AND held.objid = waiter.objid AND held.objsubid = waiter.objsubid
              WHERE waiter.locktype = 'advisory' AND NOT waiter.granted
                AND waiter.mode = 'ExclusiveLock' AND waiter.objsubid = 1
                AND waiter.classid = (($2::bigint >> 32) & 4294967295)::oid
                AND waiter.objid = ($2::bigint & 4294967295)::oid
                AND held.pid = $1::int AND held.granted AND held.mode = 'ExclusiveLock'
                AND $1::int = ANY(pg_blocking_pids(waiter.pid))
                AND $3::int = ANY(pg_blocking_pids(held.pid))`,
            [punchPid, targetKey, gatePid],
          )
          if (waiters.rows.length > 0) {
            expect(waiters.rows).toHaveLength(1)
            approvalPid = waiters.rows[0].pid
            break
          }
          if (approvalSettled || punchSettled) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(approvalPid, 'native HTTP final approval waits on the check-out writer, not the gate, within 3000ms').toEqual(expect.any(Number))
        expect(new Set([gatePid, punchPid, approvalPid]).size).toBe(3)
        expect([punchSettled, approvalSettled]).toEqual([false, false])
        expect(await state(), 'both business transactions remain uncommitted before the row gate opens').toEqual(before)
        expect([punchSettled, approvalSettled]).toEqual([false, false])
      } finally {
        try {
          await gate.query('ROLLBACK')
        } finally {
          gate.release()
          // Always drain both real requests, including on failed barrier assertions.
          await Promise.allSettled([pendingPunch, pendingApproval].filter(Boolean))
        }
      }
      const punched = await pendingPunch!
      expect(punched.status, 'native check-out writer; code=' + String(punched.body?.error?.code ?? 'none')).toBe(200)
      expect(punched.body.data.event).toMatchObject({ event_type: 'check_out' })
      const approved = await pendingApproval!
      expect(approved.status, 'native final approval after target release; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
      const after = await state()
      expect(after.request.status).toBe('approved')
      expect(after.approvalRecords).toHaveLength(1)
      expect(after.approvalRecords[0]).toMatchObject({
        action: 'approve', from_version: Number(approval.version), to_version: Number(approval.version) + 1,
      })
      expect(after.records).toHaveLength(1)
      expect(after.calculations).toHaveLength(3)
      expect(after.calculations.find((c: { id: string }) => c.id === parent.current_calculation_id)).toEqual(before.calculations[0])
      const punchCalculations = after.calculations.filter((c: { operation_id: string }) => c.operation_id === punchOperationId)
      expect(punchCalculations).toHaveLength(1)
      const punchCalculation = punchCalculations[0]
      expect(punchCalculation).toMatchObject({
        attendance_record_id: parent.id, entrypoint: 'live', mode: 'authoritative', outcome: 'completed',
        version: Number(before.calculations[0].version) + 1, approved_facts_snapshot: [],
      })
      expect(punched.body.data.record.current_calculation_id).toBe(punchCalculation.id)
      const physical = after.events.filter((e: { event_type: string }) => e.event_type !== 'adjustment')
      expect(physical).toHaveLength(2)
      expect(physical.map((e: { event_type: string }) => e.event_type).sort()).toEqual(['check_in', 'check_out'])
      expect(physical.find((e: { id: string }) => e.id === before.events[0].id)).toEqual(before.events[0])
      const expectedEvidence = physical
        .sort((a: { occurred_at: string; id: string }, b: { occurred_at: string; id: string }) =>
          a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id))
        .map((e: { id: string; event_type: string; occurred_at: string }) => ({
          kind: 'punch', ref: e.id, direction: e.event_type,
          occurredAt: new Date(e.occurred_at).toISOString(), source: 'attendance_event',
        }))
      expect(punchCalculation.evidence_snapshot).toEqual(expectedEvidence)
      const calculations = after.calculations.filter((c: { operation_id: string }) => c.operation_id === operationId)
      expect(calculations).toHaveLength(1)
      const calculation = calculations[0]
      expect(calculation).toMatchObject({
        attendance_record_id: parent.id, entrypoint: 'approved_overtime', mode: 'authoritative', outcome: 'completed',
      })
      expect(calculation.version).toBe(Number(punchCalculation.version) + 1)
      expect(calculation.evidence_snapshot).toEqual(expectedEvidence)
      expect(calculation.input_provenance.priorCalculations).toEqual([{
        id: punchCalculation.id, semanticFingerprint: punchCalculation.semantic_input_fingerprint,
        provenanceFingerprint: punchCalculation.provenance_fingerprint,
      }])
      expect(calculation.manual_override_snapshot).toEqual(punchCalculation.manual_override_snapshot)
      expect(after.records[0]).toMatchObject({
        projection_owner: 'w4', visibility_state: 'active', visibility_reason: 'active',
        status: calculation.projected_status, first_in_at: calculation.projected_first_in_at,
        last_out_at: calculation.projected_last_out_at, work_minutes: calculation.projected_work_minutes,
        late_minutes: calculation.projected_late_minutes, early_leave_minutes: calculation.projected_early_leave_minutes,
      })
      expect(after.balances).toEqual(before.balances)
      expect(after.balanceEvents).toEqual(before.balanceEvents)
      expect(after.segments.filter((s: { calculation_id: string }) => s.calculation_id === parent.current_calculation_id)).toEqual(before.segments)
      for (const result of [punchCalculation, calculation]) {
        expect(after.segments.filter((s: { calculation_id: string }) => s.calculation_id === result.id)).toHaveLength(result.expected_segment_count)
        expect(result.expected_segment_count).toBe(1)
      }
      expect(after.records[0].current_calculation_id).toBe(calculation.id)
      expect(calculation.approved_facts_snapshot).toHaveLength(1)
      const binding = after.request.metadata.w4RequestSnapshotTerminalBinding
      expect(calculation.approved_facts_snapshot).toEqual([{
        kind: 'overtime', requestId, requestSnapshotVersion: before.snapshots[0].version,
        requestSnapshotFingerprint: before.snapshots[0].payload_fingerprint,
        approvalVersion: binding.approvalVersion, approvalRecordId: binding.approvalRecordId,
        coverage: { kind: 'bounded_interval', startAt: workDate + 'T20:00:00.000Z', endAt: workDate + 'T21:00:00.000Z', minutes: 60 },
      }])
      expect(after.operations).toHaveLength(before.operations.length + 2)
      expect(after.outbox).toHaveLength(before.outbox.length + 2)
      expect(after.operations.filter((o: { operation_id: string }) => o.operation_id === punchOperationId)).toEqual([expect.objectContaining({
        state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: punchCalculation.id,
        result_semantic_fingerprint: punchCalculation.semantic_input_fingerprint,
        result_provenance_fingerprint: punchCalculation.provenance_fingerprint,
      })])
      expect(after.outbox.filter((o: { operation_id: string }) => o.operation_id === punchOperationId)).toEqual([expect.objectContaining({
        event_kind: 'attendance.punched',
      })])
      expect(after.operations.filter((o: { operation_id: string }) => o.operation_id === operationId)).toEqual([expect.objectContaining({
        state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: calculation.id,
        resolved_request_id: requestId, result_semantic_fingerprint: calculation.semantic_input_fingerprint,
        result_provenance_fingerprint: calculation.provenance_fingerprint,
      })])
      expect(after.outbox.filter((o: { operation_id: string }) => o.operation_id === operationId)).toEqual([expect.objectContaining({
        event_kind: 'attendance.resolved',
      })])
      expect(after.events.filter((e: { event_type: string }) => e.event_type === 'adjustment')).toHaveLength(1)
      expect(after.snapshots).toEqual(before.snapshots)
      const punchReplay = await checkOut()
      expect(punchReplay.status).toBe(200)
      expect(punchReplay.body).toEqual(punched.body)
      expect(await state(), 'check-out sealed replay preserves the later overtime result and immutable history').toEqual(after)
      const replay = await approve()
      expect(replay.status).toBe(200)
      expect(replay.body).toEqual(approved.body)
      expect(await state(), 'sealed replay adds no terminal, financial, calculation, event or outbox duplicates').toEqual(after)
    })
  }, 120_000)


  it('EP01 two native HTTP writers serialize overtime approval then check-out on the exact class-11 target', async () => {
    const {
      buildAttendanceCalculationTargetAdvisoryKey,
      createVerifiedAttendanceCalculationTargetIdentityV1,
      rehydrateVerifiedAttendanceOrgIdentityV1,
    } = await import('../../src/attendance/w4c0-identity')
    const orgId = randomUUID()
    const userId = randomUUID()
    const shiftId = randomUUID()
    const overtimeRuleId = randomUUID()
    overtimeHistoryOrgs.push(orgId)
    overtimeHistoryUsers.push(userId)
    await insertActiveUser(userId, orgId)
    await seedAuthoritativeRollout(orgId)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, 'EP01 reverse HTTP writers fixture', 'UTC', '00:00', '23:59', false,
               '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 1, 'strict')`,
      [shiftId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '00:00', '23:59', 0, 0)`,
      [randomUUID(), orgId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2027-12-31', true, 'published', 1)`,
      [orgId, userId, shiftId],
    )
    await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
    await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
    await pool.query(
      'INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)',
      [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId],
    )
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
      const headers = { Authorization: `Bearer ${await mintToken(userId, orgId)}`, 'Content-Type': 'application/json' }
      expect((await punch(userId, orgId, 'check_in')).status, 'native canonical parent').toBe(200)
      const parents = (await pool.query(
        'SELECT id::text, work_date::text, current_calculation_id::text FROM attendance_records WHERE org_id = $1 AND user_id = $2',
        [orgId, userId],
      )).rows
      expect(parents).toHaveLength(1)
      const parent = parents[0]
      const workDate = parent.work_date
      // Rehydrate from the real completed punch operation, never a fabricated witness.
      const durableOrgs = (await pool.query(
        `SELECT o.org_id AS "orgId", o.accepted_write_posture AS "acceptedWritePosture"
           FROM attendance_result_operations o
           JOIN attendance_record_calculations c
             ON c.org_id = o.org_id AND c.operation_id = o.operation_id AND o.entrypoint = 'live_punch'
          WHERE c.org_id = $1 AND c.id = $2::uuid AND o.state = 'completed'`,
        [orgId, parent.current_calculation_id],
      )).rows
      expect(durableOrgs).toEqual([{ orgId, acceptedWritePosture: 'authoritative' }])
      const targetKey = buildAttendanceCalculationTargetAdvisoryKey(
        createVerifiedAttendanceCalculationTargetIdentityV1({
          org: rehydrateVerifiedAttendanceOrgIdentityV1(durableOrgs[0]), userId, workDate,
        }),
      ).toString()
      const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers, body: JSON.stringify({
          operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
          requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
          minutes: 60, reason: 'EP01 reverse HTTP writers fixture',
        }),
      })
      expect(created.status, 'native OT create; code=' + String(created.body?.error?.code ?? 'none')).toBe(201)
      const requestId = created.body.data.request.id
      const approvals = (await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid',
        [orgId, requestId],
      )).rows
      expect(approvals).toHaveLength(1)
      const approval = approvals[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, userId, approval.current_node_key],
      )
      const operationId = randomUUID()
      const body = JSON.stringify({
        operationId, expectedApprovalVersion: Number(approval.version), expectedApprovalNode: approval.current_node_key,
      })
      const approve = () => requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST', headers, body,
      })
      const punchOperationId = randomUUID()
      const punchBody = JSON.stringify({ orgId, eventType: 'check_out', timezone: 'UTC', operationId: punchOperationId })
      const checkOut = () => requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST', headers, body: punchBody,
      })
      const state = async () => (await pool.query(
        `SELECT jsonb_build_object(
          'request', (SELECT to_jsonb(r) FROM attendance_requests r WHERE r.org_id = $1 AND r.id = $2::uuid),
          'approval', (SELECT to_jsonb(a) FROM approval_instances a WHERE a.id = $3),
          'approvalRecords', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_records a WHERE a.instance_id = $3),
          'assignments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approval_assignments a WHERE a.instance_id = $3),
          'records', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM attendance_records r WHERE r.org_id = $1),
          'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM attendance_events e WHERE e.org_id = $1),
          'calculations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM attendance_record_calculations c WHERE c.org_id = $1),
          'segments', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM attendance_record_segments s WHERE s.org_id = $1),
          'balances', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balances b WHERE b.org_id = $1),
          'balanceEvents', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM attendance_leave_balance_events b WHERE b.org_id = $1),
          'operations', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.operation_id) FROM attendance_result_operations o WHERE o.org_id = $1),
          'outbox', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM attendance_result_event_outbox o WHERE o.org_id = $1),
          'snapshots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.version) FROM attendance_request_calculation_snapshots s WHERE s.org_id = $1 AND s.request_id = $2::uuid)
        ) AS value`, [orgId, requestId, approval.id],
      )).rows[0].value
      const before = await state()
      expect(before.request.status).toBe('pending')
      expect(before.calculations).toHaveLength(1)
      expect(before.calculations[0]).toMatchObject({ id: parent.current_calculation_id, outcome: 'completed' })
      // The gate holds ONLY the parent row. The first real HTTP writer owns the
      // target lock; the second real HTTP writer must wait on that writer's PID.
      const gate = await pool.connect()
      let pendingApproval: Promise<HttpResponse> | undefined
      let pendingPunch: Promise<HttpResponse> | undefined
      let approvalSettled = false
      let punchSettled = false
      try {
        await gate.query('BEGIN')
        const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        expect((await gate.query(
          'SELECT id FROM attendance_records WHERE org_id = $1 AND id = $2::uuid FOR UPDATE',
          [orgId, parent.id],
        )).rows).toHaveLength(1)
        pendingApproval = approve()
        void pendingApproval.then(() => { approvalSettled = true }, () => { approvalSettled = true })
        const deadline = Date.now() + 3000
        let approvalPid: number | undefined
        while (Date.now() < deadline) {
          const holders = await pool.query(
            `SELECT held.pid FROM pg_locks held
               JOIN pg_stat_activity activity ON activity.pid = held.pid
              WHERE held.locktype = 'advisory' AND held.granted
                AND held.mode = 'ExclusiveLock' AND held.objsubid = 1
                AND held.classid = (($2::bigint >> 32) & 4294967295)::oid
                AND held.objid = ($2::bigint & 4294967295)::oid
                AND held.pid <> $1::int AND $1::int = ANY(pg_blocking_pids(held.pid))
                AND activity.query LIKE '%FROM attendance_records%'
                AND activity.query LIKE '%FOR UPDATE%'`,
            [gatePid, targetKey],
          )
          if (holders.rows.length > 0) {
            expect(holders.rows).toHaveLength(1)
            approvalPid = holders.rows[0].pid
            break
          }
          if (approvalSettled) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(approvalPid, 'native HTTP final approval owns exact class-11 key and waits on the parent-row gate').toEqual(expect.any(Number))
        expect(approvalSettled).toBe(false)
        pendingPunch = checkOut()
        void pendingPunch.then(() => { punchSettled = true }, () => { punchSettled = true })
        let punchPid: number | undefined
        while (Date.now() < deadline) {
          const waiters = await pool.query(
            `SELECT waiter.pid FROM pg_locks waiter
               JOIN pg_locks held ON held.locktype = waiter.locktype
                AND held.database = waiter.database AND held.classid = waiter.classid
                AND held.objid = waiter.objid AND held.objsubid = waiter.objsubid
              WHERE waiter.locktype = 'advisory' AND NOT waiter.granted
                AND waiter.mode = 'ExclusiveLock' AND waiter.objsubid = 1
                AND waiter.classid = (($2::bigint >> 32) & 4294967295)::oid
                AND waiter.objid = ($2::bigint & 4294967295)::oid
                AND held.pid = $1::int AND held.granted AND held.mode = 'ExclusiveLock'
                AND $1::int = ANY(pg_blocking_pids(waiter.pid))
                AND $3::int = ANY(pg_blocking_pids(held.pid))`,
            [approvalPid, targetKey, gatePid],
          )
          if (waiters.rows.length > 0) {
            expect(waiters.rows).toHaveLength(1)
            punchPid = waiters.rows[0].pid
            break
          }
          if (punchSettled || approvalSettled) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(punchPid, 'native HTTP check-out waits on the final-approval writer, not the gate, within 3000ms').toEqual(expect.any(Number))
        expect(new Set([gatePid, approvalPid, punchPid]).size).toBe(3)
        expect([approvalSettled, punchSettled]).toEqual([false, false])
        expect(await state(), 'both business transactions remain uncommitted before the row gate opens').toEqual(before)
        expect([approvalSettled, punchSettled]).toEqual([false, false])
      } finally {
        try {
          await gate.query('ROLLBACK')
        } finally {
          gate.release()
          // Always drain both real requests, including on failed barrier assertions.
          await Promise.allSettled([pendingApproval, pendingPunch].filter(Boolean))
        }
      }
      const approved = await pendingApproval!
      expect(approved.status, 'native final approval writer; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
      const punched = await pendingPunch!
      expect(punched.status, 'native check-out after overtime target release; code=' + String(punched.body?.error?.code ?? 'none')).toBe(200)
      expect(punched.body.data.event).toMatchObject({ event_type: 'check_out' })
      const after = await state()
      expect(after.request.status).toBe('approved')
      expect(after.approvalRecords).toHaveLength(1)
      expect(after.approvalRecords[0]).toMatchObject({
        action: 'approve', from_version: Number(approval.version), to_version: Number(approval.version) + 1,
      })
      expect(after.records).toHaveLength(1)
      expect(after.calculations).toHaveLength(3)
      const initial = before.calculations[0]
      expect(after.calculations.find((c: { id: string }) => c.id === initial.id)).toEqual(initial)
      expect(after.segments.filter((s: { calculation_id: string }) => s.calculation_id === initial.id)).toEqual(before.segments)
      const calculations = after.calculations.filter((c: { operation_id: string }) => c.operation_id === operationId)
      expect(calculations).toHaveLength(1)
      const calculation = calculations[0]
      expect(calculation).toMatchObject({
        attendance_record_id: parent.id, entrypoint: 'approved_overtime', mode: 'authoritative',
        outcome: 'completed', outcome_reason_code: 'calculated', projection_effect: 'set_active',
        version: Number(initial.version) + 1, supersedes_calculation_id: initial.id,
        projected_first_in_at: initial.projected_first_in_at, projected_last_out_at: null,
      })
      // The first writer freezes only the initial check-in, never the later check-out.
      expect(calculation.evidence_snapshot).toEqual(initial.evidence_snapshot)
      expect(calculation.context_snapshot).toEqual(before.snapshots[0].context_snapshot)
      expect(calculation.attribution_snapshot).toEqual(before.snapshots[0].attribution_snapshot)
      expect(calculation.manual_override_snapshot).toEqual(initial.manual_override_snapshot)
      expect(calculation.input_provenance.priorCalculations).toEqual([{
        id: initial.id, semanticFingerprint: initial.semantic_input_fingerprint,
        provenanceFingerprint: initial.provenance_fingerprint,
      }])
      expect(approved.body.data.record.current_calculation_id).toBe(calculation.id)
      expect(approved.body.data.record.last_out_at).toBeNull()
      const binding = after.request.metadata.w4RequestSnapshotTerminalBinding
      expect(binding.bindingPosture).toBe('bound')
      const expectedFacts = [{
        kind: 'overtime', requestId, requestSnapshotVersion: before.snapshots[0].version,
        requestSnapshotFingerprint: before.snapshots[0].payload_fingerprint,
        approvalVersion: binding.approvalVersion, approvalRecordId: binding.approvalRecordId,
        coverage: { kind: 'bounded_interval', startAt: workDate + 'T20:00:00.000Z', endAt: workDate + 'T21:00:00.000Z', minutes: 60 },
      }]
      expect(calculation.approved_facts_snapshot).toEqual(expectedFacts)
      const punchCalculations = after.calculations.filter((c: { operation_id: string }) => c.operation_id === punchOperationId)
      expect(punchCalculations).toHaveLength(1)
      const punchCalculation = punchCalculations[0]
      expect(after.events.map((e: { event_type: string }) => e.event_type).sort()).toEqual(['adjustment', 'check_in', 'check_out'])
      const adjustmentRefs = new Set(after.events.filter((e: { event_type: string }) => e.event_type === 'adjustment').map((e: { id: string }) => e.id))
      console.info('EP01_REVERSE_WRITER_RECEIPT', JSON.stringify({
        eventTypes: after.events.map((e: { event_type: string }) => e.event_type).sort(),
        overtimeFactCount: calculation.approved_facts_snapshot.length,
        nextPunchFactCount: punchCalculation.approved_facts_snapshot.length,
        nextPunchEvidenceCount: punchCalculation.evidence_snapshot.length,
        adjustmentMappedToPunchCount: punchCalculation.evidence_snapshot.filter((e: { ref: string; kind: string }) => e.kind === 'punch' && adjustmentRefs.has(e.ref)).length,
        nextPunchOutcome: punchCalculation.outcome,
        nextPunchReason: punchCalculation.outcome_reason_code,
      }))
      expect(punchCalculation).toMatchObject({
        attendance_record_id: parent.id, entrypoint: 'live', mode: 'authoritative',
        outcome: 'completed', outcome_reason_code: 'calculated', projection_effect: 'set_active',
        version: Number(calculation.version) + 1, supersedes_calculation_id: calculation.id,
      })
      expect(punched.body.data.record.current_calculation_id).toBe(punchCalculation.id)
      const physical = after.events.filter((e: { event_type: string }) => e.event_type !== 'adjustment')
      expect(physical).toHaveLength(2)
      expect(physical.map((e: { event_type: string }) => e.event_type).sort()).toEqual(['check_in', 'check_out'])
      expect(physical.find((e: { id: string }) => e.id === before.events[0].id)).toEqual(before.events[0])
      expect(physical.find((e: { id: string }) => e.id === punched.body.data.event.id)).toMatchObject({ event_type: 'check_out' })
      const expectedEvidence = physical
        .sort((a: { occurred_at: string; id: string }, b: { occurred_at: string; id: string }) =>
          a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id))
        .map((e: { id: string; event_type: string; occurred_at: string }) => ({
          kind: 'punch', ref: e.id, direction: e.event_type,
          occurredAt: new Date(e.occurred_at).toISOString(), source: 'attendance_event',
        }))
      expect(punchCalculation.evidence_snapshot).toEqual(expectedEvidence)
      // Serializing the writers must also preserve the already-approved OT fact.
      expect(punchCalculation.approved_facts_snapshot).toEqual(expectedFacts)
      expect(punchCalculation.manual_override_snapshot).toEqual(calculation.manual_override_snapshot)
      expect(after.records[0]).toMatchObject({
        id: parent.id, current_calculation_id: punchCalculation.id,
        projection_owner: 'w4', visibility_state: 'active', visibility_reason: 'active',
        status: punchCalculation.projected_status, first_in_at: punchCalculation.projected_first_in_at,
        last_out_at: punchCalculation.projected_last_out_at, work_minutes: punchCalculation.projected_work_minutes,
        late_minutes: punchCalculation.projected_late_minutes, early_leave_minutes: punchCalculation.projected_early_leave_minutes,
      })
      expect(new Date(after.records[0].last_out_at).toISOString()).toBe(new Date(punched.body.data.event.occurred_at).toISOString())
      expect(after.balances).toEqual(before.balances)
      expect(after.balanceEvents).toEqual(before.balanceEvents)
      for (const result of [calculation, punchCalculation]) {
        expect(after.segments.filter((s: { calculation_id: string }) => s.calculation_id === result.id)).toHaveLength(result.expected_segment_count)
        expect(result.expected_segment_count).toBe(1)
      }
      const overtimeSegments = after.segments.filter((s: { calculation_id: string }) => s.calculation_id === calculation.id)
      expect(overtimeSegments[0].actual_out_at).toBeNull()
      expect(overtimeSegments[0].matched_evidence_refs).toEqual(before.segments[0].matched_evidence_refs)
      expect(after.operations).toHaveLength(before.operations.length + 2)
      expect(after.outbox).toHaveLength(before.outbox.length + 2)
      const operationIds = [operationId, punchOperationId]
      expect(after.operations.filter((o: { operation_id: string }) => !operationIds.includes(o.operation_id))).toEqual(before.operations)
      expect(after.outbox.filter((o: { operation_id: string }) => !operationIds.includes(o.operation_id))).toEqual(before.outbox)
      for (const [id, result, entrypoint, eventKind, resolvedRequestId] of [
        [operationId, calculation, 'request_decision', 'attendance.resolved', requestId],
        [punchOperationId, punchCalculation, 'live_punch', 'attendance.punched', null],
      ] as const) {
        expect(after.operations.filter((o: { operation_id: string }) => o.operation_id === id)
          .map((o: Record<string, unknown>) => ({
            operation_id: o.operation_id, entrypoint: o.entrypoint, state: o.state,
            accepted_write_posture: o.accepted_write_posture, resolved_record_id: o.resolved_record_id,
            resolved_calculation_id: o.resolved_calculation_id, resolved_request_id: o.resolved_request_id,
            result_semantic_fingerprint: o.result_semantic_fingerprint,
            result_provenance_fingerprint: o.result_provenance_fingerprint,
          }))).toEqual([{
          operation_id: id, entrypoint, state: 'completed', accepted_write_posture: 'authoritative',
          resolved_record_id: parent.id, resolved_calculation_id: result.id, resolved_request_id: resolvedRequestId,
          result_semantic_fingerprint: result.semantic_input_fingerprint,
          result_provenance_fingerprint: result.provenance_fingerprint,
        }])
        expect(after.outbox.filter((o: { operation_id: string }) => o.operation_id === id)
          .map((o: Record<string, unknown>) => ({ operation_id: o.operation_id, event_kind: o.event_kind })))
          .toEqual([{ operation_id: id, event_kind: eventKind }])
      }
      expect(after.events).toHaveLength(before.events.length + 2)
      expect(after.events.filter((e: { event_type: string }) => e.event_type === 'adjustment')).toHaveLength(1)
      expect(after.snapshots).toEqual(before.snapshots)
      const replay = await approve()
      expect(replay.status).toBe(200)
      expect(replay.body).toEqual(approved.body)
      expect(await state(), 'sealed OT replay preserves the later punch pointer and both immutable histories').toEqual(after)
      const punchReplay = await checkOut()
      expect(punchReplay.status).toBe(200)
      expect(punchReplay.body).toEqual(punched.body)
      expect(await state(), 'sealed check-out replay preserves both histories and adds no operation or outbox duplicates').toEqual(after)
    })
  }, 120_000)
  it.each(['matched', 'different'] as const)('EP01 native first completion revalidates historical context drift: %s', async (mode) => {
    const { w4OnlyOrg: orgId, w4OnlyUser: userId, w4OnlyShift: shiftId } = await seedIsolatedOvertimeFixture()
    const overtimeRuleId = randomUUID()
    await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
    await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
    await pool.query('INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)', [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId])
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
      const headers = { Authorization: 'Bearer ' + await mintToken(userId, orgId), 'Content-Type': 'application/json' }
      const workDate = new Date().toISOString().slice(0, 10)
      const historyRows = async () => (await pool.query(
        'SELECT to_jsonb(c) AS value FROM attendance_record_calculations c WHERE org_id = $1 ORDER BY version', [orgId],
      )).rows.map(row => row.value)
      const parentRows = async () => (await pool.query(
        'SELECT to_jsonb(r) AS value FROM attendance_records r WHERE org_id = $1 AND user_id = $2', [orgId, userId],
      )).rows.map(row => row.value)
      const physicalRows = async () => (await pool.query(
        "SELECT to_jsonb(e) AS value FROM attendance_events e WHERE org_id = $1 AND event_type IN ('check_in','check_out') ORDER BY occurred_at, id", [orgId],
      )).rows.map(row => row.value)
      // Historical/core boundary producer: HTTP's current timezone frame rejects
      // this pre-freeze drift before it can create a review. Do not weaken it.
      const driver = createLegacyLivePunchBoundaryDriver(pool)
      const prepared = await driver.prepare({
        orgId, userId, eventType: 'check_in', occurredAt: workDate + 'T09:00:00.000Z',
        timezone: 'UTC', operationId: randomUUID(),
      })
      await pool.query('UPDATE attendance_shifts SET late_grace_minutes = late_grace_minutes + 1 WHERE org_id = $1 AND id = $2', [orgId, shiftId])
      const punched = await driver.execute(prepared)
      expect(punched.kind, 'native core drift review').toBe('w4')
      const priorHistory = await historyRows()
      expect(priorHistory).toHaveLength(1)
      const prior = priorHistory[0]
      expect(prior).toMatchObject({
        entrypoint: 'live', mode: 'authoritative', outcome: 'review_required',
        outcome_reason_code: 'context_mismatch', projection_effect: 'none', expected_segment_count: 0,
        approved_facts_snapshot: [], manual_override_snapshot: null,
      })
      expect(prior.attribution_snapshot.posture).toBe('resolved_v2')
      expect(prior.context_snapshot.segments[0].lateGraceMinutes).toBe(6)
      const beforeParents = await parentRows()
      expect(beforeParents).toHaveLength(1)
      const parent = beforeParents[0]
      expect(parent).toMatchObject({
        id: prior.attendance_record_id, current_calculation_id: null, projection_owner: 'legacy_untracked',
        visibility_state: 'retired', visibility_reason: 'review_placeholder',
      })
      const physical = await physicalRows()
      expect(physical).toHaveLength(1)
      expect(prior.evidence_snapshot).toEqual([{
        kind: 'punch', ref: physical[0].id, direction: 'check_in',
        occurredAt: new Date(physical[0].occurred_at).toISOString(), source: 'attendance_event',
      }])
      if (mode === 'different') {
        await pool.query('UPDATE attendance_shifts SET late_grace_minutes = late_grace_minutes + 1 WHERE org_id = $1 AND id = $2', [orgId, shiftId])
      }
      const created = await requestJson(baseUrl + '/api/attendance/requests', {
        method: 'POST', headers, body: JSON.stringify({
          operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
          requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
          minutes: 60, reason: 'EP01 first completion source repair',
        }),
      })
      expect(created.status, 'first native OT request').toBe(201)
      const requestId = created.body.data.request.id
      const frozen = (await pool.query(
        'SELECT version, payload_fingerprint, attribution_snapshot, context_snapshot FROM attendance_request_calculation_snapshots WHERE org_id = $1 AND request_id = $2::uuid', [orgId, requestId],
      )).rows
      expect(frozen).toHaveLength(1)
      if (mode === 'matched') expect(frozen[0].context_snapshot).toEqual(prior.context_snapshot)
      else {
        expect(frozen[0].context_snapshot).not.toEqual(prior.context_snapshot)
        expect(frozen[0].context_snapshot.segments[0].lateGraceMinutes).toBe(7)
      }
      expect(frozen[0].attribution_snapshot.value.absoluteWindow).toEqual(prior.attribution_snapshot.value.absoluteWindow)
      expect(await historyRows()).toEqual(priorHistory)
      const approval = (await pool.query(
        'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid', [orgId, requestId],
      )).rows[0]
      await pool.query(
        "INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)",
        [approval.id, userId, approval.current_node_key],
      )
      const operationId = randomUUID()
      const decision = { operationId, expectedApprovalVersion: Number(approval.version), expectedApprovalNode: approval.current_node_key }
      const approved = await requestJson(baseUrl + '/api/attendance/requests/' + requestId + '/approve', {
        method: 'POST', headers, body: JSON.stringify(decision),
      })
      expect(approved.status, 'new frozen source decision').toBe(200)
      const history = await historyRows()
      expect(history).toHaveLength(2)
      expect(history[0]).toEqual(prior)
      const calculation = history[1]
      expect(calculation, 'matching complete frozen sources must permit the first completed result').toMatchObject({
        mode: 'authoritative', entrypoint: 'approved_overtime',
        outcome: mode === 'matched' ? 'completed' : 'review_required',
        outcome_reason_code: mode === 'matched' ? 'calculated' : 'context_mismatch',
        projection_effect: mode === 'matched' ? 'set_active' : 'none',
        attendance_record_id: parent.id, operation_id: operationId,
      })
      expect(calculation.context_snapshot).toEqual(frozen[0].context_snapshot)
      expect(calculation.evidence_snapshot).toEqual(prior.evidence_snapshot)
      expect(calculation.approved_facts_snapshot).toEqual([{
        kind: 'overtime', requestId, requestSnapshotVersion: frozen[0].version,
        requestSnapshotFingerprint: frozen[0].payload_fingerprint,
        approvalVersion: Number(approval.version) + 1, approvalRecordId: expect.any(String),
        coverage: { kind: 'bounded_interval', startAt: workDate + 'T20:00:00.000Z', endAt: workDate + 'T21:00:00.000Z', minutes: 60 },
      }])
      expect(calculation.input_provenance.priorCalculations).toEqual([{
        id: prior.id, semanticFingerprint: prior.semantic_input_fingerprint, provenanceFingerprint: prior.provenance_fingerprint,
      }])
      const afterParents = await parentRows()
      expect(afterParents).toHaveLength(1)
      if (mode === 'matched') {
        expect(afterParents[0]).toMatchObject({
          id: parent.id, current_calculation_id: calculation.id, projection_owner: 'w4',
          visibility_state: 'active', visibility_reason: 'active',
        })
      } else expect(afterParents).toEqual(beforeParents)
      expect((await pool.query('SELECT segment_index FROM attendance_record_segments WHERE org_id = $1 AND calculation_id = $2::uuid ORDER BY segment_index', [orgId, calculation.id])).rows).toEqual(mode === 'matched' ? [{ segment_index: 0 }] : [])
      expect(await physicalRows()).toEqual(physical)
      expect((await pool.query("SELECT id FROM attendance_record_calculations WHERE org_id = $1 AND calculation_kind = 'legacy_baseline'", [orgId])).rows).toEqual([])
      expect((await pool.query(
        'SELECT state, resolved_record_id::text, resolved_calculation_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid', [orgId, operationId],
      )).rows).toEqual([{
        state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: calculation.id,
        result_semantic_fingerprint: calculation.semantic_input_fingerprint, result_provenance_fingerprint: calculation.provenance_fingerprint,
      }])
      const counts = await businessCounts(orgId)
      const replay = await requestJson(baseUrl + '/api/attendance/requests/' + requestId + '/approve', {
        method: 'POST', headers, body: JSON.stringify(decision),
      })
      expect(replay.status).toBe(200)
      expect(await businessCounts(orgId)).toEqual(counts)
      expect(await historyRows()).toEqual(history)
      expect(await parentRows()).toEqual(afterParents)
    })
  }, 120_000)

  it.each(['shift', 'calendar'] as const)('EP01 native frozen source decision ignores later current configuration: %s', async (mode) => {
    const { w4OnlyOrg: orgId, w4OnlyUser: userId, w4OnlyShift: shiftId } = await seedIsolatedOvertimeFixture()
    const overtimeRuleId = randomUUID()
    await pool.query("UPDATE users SET permissions = '[\"attendance:admin\"]'::jsonb WHERE id = $1", [userId])
    await pool.query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING", [userId])
    await pool.query('INSERT INTO attendance_overtime_rules (id, org_id, name, rounding_minutes) VALUES ($1, $2, $3, 1)', [overtimeRuleId, orgId, 'EP01_' + overtimeRuleId])
    await withEnv({ ...BOTH_MACHINES_ENV(), [W4_ENV]: BOTH_MACHINES_ENV()[W4_ENV] + ',' + orgId }, async () => {
      const headers = { Authorization: 'Bearer ' + await mintToken(userId, orgId), 'Content-Type': 'application/json' }
      const punched = await punch(userId, orgId, 'check_in')
      expect(punched.status, 'initial canonical punch').toBe(200)
      const parents = async () => (await pool.query('SELECT to_jsonb(r) AS value FROM attendance_records r WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows.map(row => row.value)
      const history = async () => (await pool.query('SELECT to_jsonb(c) AS value FROM attendance_record_calculations c WHERE org_id = $1 ORDER BY version', [orgId])).rows.map(row => row.value)
      const beforeParents = await parents()
      const beforeHistory = await history()
      expect(beforeParents).toHaveLength(1)
      expect(beforeHistory).toHaveLength(1)
      const parent = beforeParents[0]
      expect(beforeHistory[0]).toMatchObject({ id: parent.current_calculation_id, outcome: 'completed' })
      const workDate = parent.work_date
      const created = await requestJson(baseUrl + '/api/attendance/requests', {
        method: 'POST', headers, body: JSON.stringify({
          operationId: randomUUID(), orgId, workDate, requestType: 'overtime', overtimeRuleId,
          requestedInAt: workDate + 'T20:00:00.000Z', requestedOutAt: workDate + 'T21:00:00.000Z',
          minutes: 60, reason: 'EP01 frozen source validation',
        }),
      })
      expect(created.status, 'bounded OT create').toBe(201)
      const requestId = created.body.data.request.id
      const snapshots = async () => (await pool.query('SELECT to_jsonb(s) AS value FROM attendance_request_calculation_snapshots s WHERE org_id = $1 AND request_id = $2::uuid ORDER BY version', [orgId, requestId])).rows.map(row => row.value)
      const beforeSnapshots = await snapshots()
      expect(beforeSnapshots).toHaveLength(1)
      const frozen = beforeSnapshots[0]
      expect(frozen.context_snapshot.timezone).toBe('UTC')
      expect(frozen.context_snapshot.isWorkday).toBe(true)
      expect(frozen.context_snapshot.holidayKind).toBeNull()
      const holidayId = randomUUID()
      if (mode === 'shift') {
        await pool.query("UPDATE attendance_shifts SET timezone = 'Asia/Tokyo', late_grace_minutes = late_grace_minutes + 17 WHERE org_id = $1 AND id = $2", [orgId, shiftId])
      } else {
        await pool.query("INSERT INTO attendance_holidays(id,org_id,holiday_date,name,is_working_day,origin) VALUES($1,$2,$3::date,'EP01 synthetic calendar change',false,'manual')", [holidayId, orgId, workDate])
      }
      try {
        const currentSource = async () => (await pool.query(
          'SELECT s.timezone, s.late_grace_minutes, h.is_working_day FROM attendance_shifts s LEFT JOIN attendance_holidays h ON h.org_id = s.org_id AND h.holiday_date = $3::date WHERE s.org_id = $1 AND s.id = $2',
          [orgId, shiftId, workDate],
        )).rows
        const changed = await currentSource()
        expect(changed).toHaveLength(1)
        if (mode === 'shift') {
          expect(changed[0].timezone).toBe('Asia/Tokyo')
          expect(changed[0].late_grace_minutes).toBe(frozen.context_snapshot.segments[0].lateGraceMinutes + 17)
        } else expect(changed[0].is_working_day).toBe(false)
        expect(await snapshots()).toEqual(beforeSnapshots)
        const approval = (await pool.query(
          'SELECT ai.id, ai.version, ai.current_node_key FROM attendance_requests r JOIN approval_instances ai ON ai.id = r.approval_instance_id WHERE r.org_id = $1 AND r.id = $2::uuid', [orgId, requestId],
        )).rows[0]
        await pool.query("INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata) VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)", [approval.id, userId, approval.current_node_key])
        const operationId = randomUUID()
        const decisionBody = JSON.stringify({ operationId, expectedApprovalVersion: Number(approval.version), expectedApprovalNode: approval.current_node_key })
        const url = baseUrl + '/api/attendance/requests/' + requestId + '/approve'
        const approved = await requestJson(url, { method: 'POST', headers, body: decisionBody })
        expect(approved.status, 'frozen decision status; code=' + String(approved.body?.error?.code ?? 'none')).toBe(200)
        const after = await history()
        expect(after).toHaveLength(2)
        expect(after[0]).toEqual(beforeHistory[0])
        const calc = after[1]
        expect(calc).toMatchObject({ entrypoint: 'approved_overtime', mode: 'authoritative', outcome: 'completed', outcome_reason_code: 'calculated', projection_effect: 'set_active', operation_id: operationId })
        expect(calc.attribution_snapshot).toEqual(frozen.attribution_snapshot)
        expect(calc.context_snapshot).toEqual(frozen.context_snapshot)
        expect(calc.evidence_snapshot).toEqual(beforeHistory[0].evidence_snapshot)
        expect(calc.manual_override_snapshot).toEqual(beforeHistory[0].manual_override_snapshot)
        const terminal = (await pool.query('SELECT status, metadata FROM attendance_requests WHERE org_id = $1 AND id = $2::uuid', [orgId, requestId])).rows[0]
        expect(terminal.status).toBe('approved')
        const binding = terminal.metadata.w4RequestSnapshotTerminalBinding
        expect(calc.approved_facts_snapshot).toEqual([...beforeHistory[0].approved_facts_snapshot, {
          kind: 'overtime', requestId, requestSnapshotVersion: frozen.version, requestSnapshotFingerprint: frozen.payload_fingerprint,
          approvalVersion: binding.approvalVersion, approvalRecordId: binding.approvalRecordId,
          coverage: { kind: 'bounded_interval', startAt: workDate + 'T20:00:00.000Z', endAt: workDate + 'T21:00:00.000Z', minutes: 60 },
        }])
        const { computeAttendanceSemanticInputFingerprintV1, computeAttendanceProvenanceFingerprintV1 } = await import('../../src/attendance/w4c0-fingerprints')
        const { computeAttendanceSourceDefinitionFingerprintV1 } = await import('../../src/attendance/w4c1-fingerprints')
        expect(calc.semantic_input_fingerprint).toBe(computeAttendanceSemanticInputFingerprintV1({
          attribution: calc.attribution_snapshot, context: calc.context_snapshot, evidence: calc.evidence_snapshot,
          approvedFacts: calc.approved_facts_snapshot, manualOverride: calc.manual_override_snapshot,
          mergePolicy: calc.merge_policy, calculationTier: calc.calculation_tier, engineVersion: calc.engine_version, snapshotSchemaVersion: calc.snapshot_schema_version,
        }))
        const ref = calc.input_provenance
        expect(calc.provenance_fingerprint).toBe(computeAttendanceProvenanceFingerprintV1({
          transport: ref.transport, sourceRef: ref.sourceRef, artifactSha256: ref.artifactSha256, normalizedCsvSha256: ref.normalizedCsvSha256, convertedSheetName: ref.convertedSheetName,
        }))
        expect(calc.source_definition_fingerprint).toBe(computeAttendanceSourceDefinitionFingerprintV1({ attribution: calc.attribution_snapshot, context: calc.context_snapshot }))
        const afterParents = await parents()
        expect(afterParents[0]).toMatchObject({ id: parent.id, current_calculation_id: calc.id, projection_owner: 'w4', visibility_state: 'active', visibility_reason: 'active', is_workday: true })
        expect((await pool.query('SELECT state, resolved_record_id::text, resolved_calculation_id::text, result_semantic_fingerprint, result_provenance_fingerprint FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid', [orgId, operationId])).rows).toEqual([{
          state: 'completed', resolved_record_id: parent.id, resolved_calculation_id: calc.id,
          result_semantic_fingerprint: calc.semantic_input_fingerprint, result_provenance_fingerprint: calc.provenance_fingerprint,
        }])
        expect(await snapshots()).toEqual(beforeSnapshots)
        expect(await currentSource()).toEqual(changed)
        const counts = await businessCounts(orgId)
        const replay = await requestJson(url, { method: 'POST', headers, body: decisionBody })
        expect(replay.status).toBe(200)
        expect(replay.body).toEqual(approved.body)
        expect(await businessCounts(orgId)).toEqual(counts)
        expect(await history()).toEqual(after)
        expect(await parents()).toEqual(afterParents)
        expect(await currentSource()).toEqual(changed)
      } finally {
        await pool.query('DELETE FROM attendance_holidays WHERE org_id = $1 AND id = $2', [orgId, holidayId])
      }
    })
  }, 120_000)

})
