/**
 * W4C-2 (#4612 review, P2 findings — owner-authorized HOLD restricted to two
 * remediation legs; P1-2 is explicitly OUT OF SCOPE here) — real DB, route-level.
 *
 * Leg 1 (P1-3 re-derivation, "genuine production race"): the existing
 * P1-3-remediation test proves `deriveLegacyLivePunchAttributionV1`'s own
 * ambiguous/shift-changed 409 branch by calling it directly on a hand-built
 * transaction (attendance-w4c2-live-scheduled-boundary.db.test.ts) — it does
 * NOT prove that the PRODUCTION route reaches that branch via a real
 * concurrent write between the route's own pre-check and the canonical
 * write-boundary transaction. This suite installs the test-only
 * `__setAttendanceW4LivePunchPreBoundarySeamForTests` hook (module-declared
 * next to `attendanceW4LivePunchPreBoundarySeamForTests` in
 * plugins/plugin-attendance/index.cjs, called from the POST
 * /api/attendance/punch route immediately before
 * `w4LiveScheduledBoundary.executeLivePunch`) to pause connection A AFTER its
 * own precheck has already resolved a single (non-ambiguous) shift, let a
 * SECOND real connection commit a conflicting overlapping shift assignment,
 * then resume A into the real canonical transaction. The in-transaction
 * re-read now sees both assignments, so the SAME "ambiguous in transaction"
 * 409 branch fires — this time reached through the genuine two-transaction
 * race, not a direct call. Judgment: delete/neuter the in-transaction
 * re-derivation (i.e. make it trust the route's stale resolution) and this
 * leg must go red on its own, without touching the direct-seam leg in the
 * sibling suite.
 *
 * Leg 2 (admin_run authorization is load-bearing): the existing P1-4 gate
 * only proves `initiator: 'admin_run'` carries a real, ACTIVE actor id (not
 * the internal scheduler constant) — it never drives the route with an actor
 * who lacks `attendance:admin` under REAL RBAC (every existing admin_run test
 * runs with RBAC_BYPASS='true'). This suite toggles RBAC_BYPASS='false' for
 * one pair of cases: a plain actor with ZERO DB permission rows is refused
 * 403 with zero DML, and the SAME route with a real `attendance:admin`
 * `user_permissions` row (not RBAC_BYPASS) succeeds and writes the absence
 * row — a genuine positive control, not merely "everything 403s".
 *
 * Caller enumeration (documented here, restated in the PR body): grep across
 * plugins/**, packages/core-backend/src/**, apps/** for `initiator === 'admin_run'`
 * / `initiator: 'admin_run'` finds exactly ONE production caller —
 * plugins/plugin-attendance/index.cjs's POST /api/attendance/auto-absence/run
 * route (~L43630), itself gated by `withPermission('attendance:admin', ...)`
 * (~L43633). No other route, internal call, or scheduler dispatch path ever
 * sets `initiator: 'admin_run'`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'

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

// No DB needed — this just requires the CJS module directly, same as the
// other __xyzForTests unit-level guards elsewhere in this codebase (e.g.
// packages/core-backend/tests/unit/attendance-live-punch-work-date.test.ts).
// Runs regardless of dbUrl availability (ungated `describe`, not `describeDb`).
describe('__setAttendanceW4LivePunchPreBoundarySeamForTests env guard', () => {
  it('forbids installing the race seam outside a test runtime (matches the __setAttendanceW4DigestSeamForTests precedent in w4c0-identity.ts)', () => {
    const plugin = loadPlugin()
    const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
    if (typeof setSeam !== 'function') {
      throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
    }
    const savedVitest = process.env.VITEST
    const savedNodeEnv = process.env.NODE_ENV
    try {
      delete process.env.VITEST
      process.env.NODE_ENV = 'production'
      expect(() => setSeam(async () => {})).toThrow('W4C2_LIVE_PUNCH_PRE_BOUNDARY_SEAM_FORBIDDEN')
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST
      else process.env.VITEST = savedVitest
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = savedNodeEnv
      // Leave the seam cleared regardless of outcome — this describe block
      // runs before the DB-gated suite below in file order.
      setSeam(null)
    }
  })
})

describeDb('W4C-2 #4612 P2 remediation — genuine live-punch race + admin_run authorization (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string, perms: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const punch = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const autoAbsenceRun = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/auto-absence/run`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 P2 remediation fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w4c2-p2.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  async function insertLegacyRolloutRow(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w4c2-p2-remediation', 'TEST_FIXTURE', 'w4c2-p2-remediation-actor', 1, NULL)`,
      [orgId],
    )
  }

  const eventCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_events WHERE user_id = $1', [userId])).rows[0].n)
  const recordCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1', [userId])).rows[0].n)
  const recordCountForOrgDate = async (orgId: string, workDate: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_records WHERE org_id = $1 AND work_date = $2', [orgId, workDate])).rows[0].n)
  // Third and fourth DML surfaces the task named alongside events/records: a
  // future reordering that claims a result-operation row (or enqueues an
  // outbox row) BEFORE the in-transaction re-derivation/permission check
  // fires would be invisible to eventCount/recordCount alone.
  const operationCountForOrg = async (orgId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1', [orgId])).rows[0].n)
  const outboxCountForOrg = async (orgId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE org_id = $1', [orgId])).rows[0].n)

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W4C-2 P2 remediation integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
  }, 120000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
  }, 60000)

  // ---------------------------------------------------------------------
  // Leg 1: genuine two-connection race on the in-transaction ambiguous
  // re-derivation added by P1-3.
  // ---------------------------------------------------------------------
  describe('leg 1: live-punch route reaches the in-transaction ambiguous 409 via a REAL concurrent write (not a direct-call seam)', () => {
    it('positive control: single shift assignment, NO concurrent write => 200, exactly one event/record row', async () => {
      const org = randomUUID()
      const user = randomUUID()
      const shiftA = randomUUID()
      const asgA = randomUUID()
      await insertLegacyRolloutRow(org)
      await insertActiveUser(user, org)
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
         VALUES ($1, $2, 'W4C2-P2-Race-A', 'UTC', '06:00', '14:00', false, '[0,1,2,3,4,5,6]'::jsonb)`,
        [shiftA, org],
      )
      await pool.query(
        `INSERT INTO attendance_shift_assignments (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
         VALUES ($1, $2, $3, $4, '2026-07-17', '2026-07-17', true, 'published', 1)`,
        [asgA, org, user, shiftA],
      )
      const token = await mintToken(user, 'attendance:write')
      const res = await punch(token, { orgId: org, eventType: 'check_in', occurredAt: '2026-07-17T13:30:00.000Z', timezone: 'UTC' })
      expect(res.status, res.raw).toBe(200)
      expect(res.body?.ok).toBe(true)
      // Discriminator: proves this punch actually matched shiftA (not the
      // unrelated "no shift assigned" unresolved fallback for a mismatched org).
      expect(res.body?.data?.workDateResolution?.kind).toBe('resolved')
      expect(await eventCount(user)).toBe(1)
      expect(await recordCount(user)).toBe(1)
    })

    it('race: connection B commits a conflicting overlapping shift assignment while A is paused after its OWN precheck => A observes the closed 409, ZERO event/record rows (judgment: neutering the in-transaction re-derivation must flip this leg red)', async () => {
      const org = randomUUID()
      const user = randomUUID()
      const shiftA = randomUUID()
      const shiftB = randomUUID()
      const asgA = randomUUID()
      const asgB = randomUUID()
      await insertLegacyRolloutRow(org)
      await insertActiveUser(user, org)
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
         VALUES ($1, $2, 'W4C2-P2-Race-A', 'UTC', '06:00', '14:00', false, '[0,1,2,3,4,5,6]'::jsonb),
                ($3, $2, 'W4C2-P2-Race-B', 'UTC', '12:00', '16:00', false, '[0,1,2,3,4,5,6]'::jsonb)`,
        [shiftA, org, shiftB],
      )
      // Only shiftA is assigned at request time — the route's own precheck
      // resolves a single, non-ambiguous match and is allowed to proceed.
      await pool.query(
        `INSERT INTO attendance_shift_assignments (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
         VALUES ($1, $2, $3, $4, '2026-07-17', '2026-07-17', true, 'published', 1)`,
        [asgA, org, user, shiftA],
      )

      const plugin = loadPlugin()
      const setSeam = plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests
      if (typeof setSeam !== 'function') {
        throw new Error('W4C2_TEST_SEAM_MISSING: __setAttendanceW4LivePunchPreBoundarySeamForTests')
      }

      let signalAReachedBarrier: () => void
      const aReachedBarrier = new Promise<void>((resolve) => { signalAReachedBarrier = resolve })
      let releaseA: () => void
      const aReleased = new Promise<void>((resolve) => { releaseA = resolve })

      setSeam(async () => {
        // Connection A: signal it has reached the barrier (route precheck
        // already succeeded, canonical transaction not yet opened), then
        // suspend until the test releases it — a REAL await point inside the
        // live route handler, not a mocked/inline race.
        signalAReachedBarrier()
        await aReleased
      })

      try {
        const token = await mintToken(user, 'attendance:write')
        const punchPromise = punch(token, { orgId: org, eventType: 'check_in', occurredAt: '2026-07-17T13:30:00.000Z', timezone: 'UTC' })

        await aReachedBarrier
        // Connection B: a SECOND, independent connection commits a
        // conflicting overlapping shift assignment for the SAME user/date —
        // this is the genuine concurrent write. It fully commits (bare
        // pool.query auto-commits) BEFORE connection A is released, so A's
        // canonical transaction (opened strictly after this resolves) is
        // guaranteed to observe it under READ COMMITTED.
        await pool.query(
          `INSERT INTO attendance_shift_assignments (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
           VALUES ($1, $2, $3, $4, '2026-07-17', '2026-07-17', true, 'published', 2)`,
          [asgB, org, user, shiftB],
        )
        releaseA!()

        const res = await punchPromise
        expect(res.status, res.raw).toBe(409)
        expect(res.body?.error?.code).toBe('W4C2_LEGACY_WORK_DATE_ATTRIBUTION_AMBIGUOUS_IN_TRANSACTION')
        // Zero source/result DML: the throw happens BEFORE the
        // attendance_events INSERT inside applyLivePunchProjectionLegacyV1,
        // and this is the legacy_projection_only path (no operation/outbox
        // row is ever minted for it even on success) — prove all three
        // surfaces with row counts, not just the response code.
        expect(await eventCount(user)).toBe(0)
        expect(await recordCount(user)).toBe(0)
        expect(await operationCountForOrg(org)).toBe(0)
        expect(await outboxCountForOrg(org)).toBe(0)
      } finally {
        setSeam(null)
      }
    })
  })

  // ---------------------------------------------------------------------
  // Leg 2: admin_run route-level authorization is load-bearing.
  // ---------------------------------------------------------------------
  describe('leg 2: POST /api/attendance/auto-absence/run authorization is load-bearing (real RBAC, not RBAC_BYPASS)', () => {
    it('non-admin actor with ZERO DB permission rows is refused 403 FORBIDDEN before any DML', async () => {
      const org = randomUUID()
      const user = randomUUID()
      const workDate = '2026-07-22'
      await insertLegacyRolloutRow(org)
      await insertActiveUser(user, org)
      const actorId = randomUUID()
      const actorToken = await mintToken(actorId, 'attendance:read')

      const previousRbacBypass = process.env.RBAC_BYPASS
      process.env.RBAC_BYPASS = 'false'
      try {
        const res = await autoAbsenceRun(actorToken, { orgId: org, workDate })
        expect(res.status, res.raw).toBe(403)
        expect(res.body?.error?.code).toBe('FORBIDDEN')
        expect(await recordCountForOrgDate(org, workDate)).toBe(0)
        // withPermission 403s before runAutoAbsenceForOrgDate is ever called —
        // no result-operation or outbox row can exist for this org either.
        expect(await operationCountForOrg(org)).toBe(0)
        expect(await outboxCountForOrg(org)).toBe(0)
      } finally {
        if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
        else process.env.RBAC_BYPASS = previousRbacBypass
      }
    })

    it('positive control: the SAME route with a REAL attendance:admin user_permissions row (no RBAC_BYPASS) succeeds and writes the absence row', async () => {
      const org = randomUUID()
      const user = randomUUID()
      const workDate = '2026-07-22'
      await insertLegacyRolloutRow(org)
      await insertActiveUser(user, org)
      const adminActorId = randomUUID()
      const adminToken = await mintToken(adminActorId, 'attendance:read')
      await pool.query(`INSERT INTO permissions (code, name) VALUES ('attendance:admin', 'Attendance Admin') ON CONFLICT (code) DO NOTHING`)
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING`,
        [adminActorId],
      )

      const previousRbacBypass = process.env.RBAC_BYPASS
      process.env.RBAC_BYPASS = 'false'
      try {
        const res = await autoAbsenceRun(adminToken, { orgId: org, workDate })
        expect(res.status, res.raw).toBe(200)
        expect(res.body?.data).toMatchObject({ skipped: false, generated: 1, total: 1 })
        expect(await recordCountForOrgDate(org, workDate)).toBe(1)
      } finally {
        if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
        else process.env.RBAC_BYPASS = previousRbacBypass
      }
    })
  })
})
