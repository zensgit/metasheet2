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
  let baseUrl = ''
  let priorW4: string | undefined
  let priorW7: string | undefined

  // BOTH-machines org (T-M5 / T-R1 / T-P1 / T-P7).
  const bothOrg = randomUUID()
  const bothUser = randomUUID()
  const bothShift = randomUUID()
  const bothGroup = randomUUID()
  // W4-legacy + W7-group org — the §2.4 incoherence fixture (T-R9).
  const incoherentOrg = randomUUID()
  const incoherentUser = randomUUID()
  const incoherentShift = randomUUID()
  const incoherentGroup = randomUUID()

  const allOrgs = () => [bothOrg, incoherentOrg]

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
    await pool.query(
      `INSERT INTO ${POSTURE_TABLE} (org_id, state, scope)
       VALUES ($1, 'group_authoritative', 'synthetic_staging')`,
      [orgId.toLowerCase()],
    )
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
    // BOTH allowlists carry the both-machines org, EXACTLY. The W4 half is what
    // makes the boundary's inner arm reachable at all (§1 Chain A).
    process.env[W4_ENV] = bothOrg.toLowerCase()
    process.env[W7_ENV] = bothOrg.toLowerCase()

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
    await pool?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[bothUser, incoherentUser]]).catch(() => undefined)
    await pool?.end()
    await server?.stop?.()
    if (priorW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]
    else process.env[W7_ENV] = priorW7
  }, 60_000)

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

  // -------------------------------------------------------------------------

  it('T-M5 + T-R1: both machines ON => the group arm runs END TO END and the inner/outer fingerprints AGREE', async () => {
    expect(process.env[W4_ENV], 'W4 allowlist must carry the org').toBe(bothOrg.toLowerCase())
    expect(process.env[W7_ENV], 'W7 allowlist must carry the org').toBe(bothOrg.toLowerCase())

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
    }
  }, 60_000)
})
