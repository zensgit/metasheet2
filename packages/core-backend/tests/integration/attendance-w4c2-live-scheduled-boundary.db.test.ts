import { AttendanceManagedPgPool } from '../../src/attendance/attendance-owning-session'
import { requestOnlinePunchFixture } from '../utils/attendance-online-punch-fixture'
import { createLegacyLivePunchBoundaryDriver } from '../utils/attendance-legacy-live-punch-boundary-driver'
/**
 * W4C-2 (#4556 lock §12.3) — canonical live/scheduled write-boundary WIRING gates
 * (route-level, real DB, real MetaSheetServer + plugin activate).
 *
 * These legs prove the PRODUCTION initiators actually execute through the canonical
 * boundary — not merely that the boundary module works in isolation:
 *
 *  1. posture split, legacy side (live): a null-ID punch keeps the legacy response and
 *     creates ZERO operation/calculation/outbox rows;
 *  2. stable-ID legacy_compat: operation claim + seal, congruent replay returns the stored
 *     response with zero new source DML, and a same-key/different-payload retry is 409 —
 *     with zero calculation/outbox rows (the legacy side of the posture split);
 *  3. suspension preflight precedes the live source DML: a punch into a SUSPENDED rollout
 *     org is refused (values-free closed code) and writes NO attendance_events row, with a
 *     paired POSITIVE CONTROL (identical punch shape into a legacy-state rollout org DOES
 *     write) — mutating the route to bypass the boundary fails the suspended leg on its own;
 *  4. suspension preflight precedes the scheduled source DML: the administrator absence run
 *     over a SUSPENDED org reports the closed suspended outcome and inserts NO absent row,
 *     with a paired POSITIVE CONTROL (same fixture shape over a legacy-state org generates
 *     exactly one absent row) — mutating either absence initiator to bypass the canonical
 *     writer fails the suspended leg on its own.
 *
 * The historical P1 client-timezone drift leg explicitly drives the legacy boundary
 * through real activated adapters and PostgreSQL. Its original Tokyo geometry and
 * frozen evidence pin remain there; a separate HTTP leg proves strict UTC authority
 * rejects Tokyo without seven-table writes and accepts UTC for the same subject.
 *
 * Suspension fixtures walk the guarded rollout state machine's legal edges
 * (legacy->shadow->eligible->authoritative->suspended); a persisted `suspended` state is
 * honored REGARDLESS of the env allowlist (w4c0-identity posture doctrine), so no env
 * flag is touched and `legacy_projection_only` stays the posture everywhere else.
 *
 * Shared-DB discipline: fixture ids are file-namespaced random UUIDs; rollout-state rows are
 * append-only by design (DELETE is trigger-denied) and keyed by throwaway org UUIDs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import type { Pool } from 'pg'
import { acquireAttendanceTimezoneRuntimeLocksV1, buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../../src/attendance/attendance-timezone-runtime-locks'
import {
  snapshotAttendanceSettingsRow,
  restoreAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'
import {
  assertLegacyPunchResponseGoldenShapeV1,
  assertLegacyPunchResponseGoldenShapeResolvedV1,
} from '../utils/attendance-w4c2-golden-response'

// Shared-DB isolation for the deployment-wide 'attendance.settings' row: the replay leg turns
// the min-punch-interval throttle off (the throttle fires on the ROUTE before the registry
// replay is reachable — a keyed same-instant retry would 429; whether stable-ID retries should
// bypass PUNCH_TOO_SOON is an owner call recorded in the slice handoff, NOT decided here), so
// this suite must leave the row exactly as found and drop the plugin's settings cache.
const settingsRowRequireCjs = createRequire(import.meta.url)
function resetAttendanceSettingsCacheAfterRestore(): void {
  const plugin = settingsRowRequireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
    resetAttendanceSettingsCacheForTests?: () => void
  }
  plugin.resetAttendanceSettingsCacheForTests?.()
}
let settingsRowSnapshot: AttendanceSettingsRowSnapshot | undefined

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

type HttpResponse = { status: number; body?: any; raw: string }

const requestJson = (...args: Parameters<typeof rawRequestJson>): ReturnType<typeof rawRequestJson> =>
  requestOnlinePunchFixture(args[0], args[1] ?? {}, rawRequestJson)

function rawRequestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
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

describeDb('W4C-2 canonical live/scheduled boundary wiring (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  const seededDefaultRuleIds: string[] = []

  const settingsAdminUserId = randomUUID()
  const settingsAdminOrg = randomUUID()

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string, perms: string, tenantId?: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const punch = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const autoAbsenceRun = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/auto-absence/run`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })

  // File-namespaced fixtures (shared DB).
  const legacyLiveUser = randomUUID()
  const compatUser = randomUUID()
  const suspendedLiveUser = randomUUID()
  const controlLiveUser = randomUUID()
  const scheduledLegacyUser = randomUUID()
  const scheduledSuspendedUser = randomUUID()
  const suspendedLiveOrg = randomUUID()
  const controlLiveOrg = randomUUID()
  const scheduledLegacyOrg = randomUUID()
  const scheduledSuspendedOrg = randomUUID()
  // P2-1 / P1 remediation (#4612 gate2) fixtures: a single published shift,
  // bounded to exactly one calendar day so BOTH the "no tz drift" and the
  // "client tz != winning shift tz" legs resolve the SAME shift row via the
  // SAME candidate set — the only things that can legitimately differ
  // between the two legs are `reasonCode` and `evidenceSnapshot.calendarWorkDate`.
  const resolvedFixtureOrg = randomUUID()
  const resolvedFixtureShift = randomUUID()
  const resolvedFixtureAssignmentA = randomUUID()
  const resolvedFixtureAssignmentB = randomUUID()
  const plainResolvedUser = randomUUID()
  const driftResolvedUser = randomUUID()
  const httpContractOrg = randomUUID()
  const httpContractUser = randomUUID()
  const httpContractShift = randomUUID()
  const httpContractAssignment = randomUUID()

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 boundary fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w4c2-boundary.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
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

  /** Walk the guarded state machine's legal edges to a persisted `suspended` state. */
  async function walkRolloutToSuspended(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w4c2-wiring', 'TEST_FIXTURE', 'w4c2-wiring-actor', 1, NULL)`,
      [orgId],
    )
    const edges: Array<[string, string, number]> = [
      ['shadow', 'legacy', 2],
      ['eligible', 'shadow', 3],
      ['authoritative', 'eligible', 4],
      ['suspended', 'authoritative', 5],
    ]
    for (const [state, prior, version] of edges) {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
        [orgId, state, prior, version],
      )
    }
  }

  async function insertLegacyRolloutRow(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w4c2-wiring', 'TEST_FIXTURE', 'w4c2-wiring-actor', 1, NULL)`,
      [orgId],
    )
  }

  const eventCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_events WHERE user_id = $1', [userId])).rows[0].n)
  const recordCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1', [userId])).rows[0].n)
  const liveOperationRows = async (orgId: string) =>
    (await pool.query(
      `SELECT operation_id::text AS operation_id, state, accepted_write_posture, actor_id, capability,
              resolved_calculation_id::text AS resolved_calculation_id, response_snapshot
       FROM attendance_result_operations WHERE org_id = $1 AND entrypoint = 'live_punch'
       ORDER BY created_at`,
      [orgId],
    )).rows
  const calculationCountForUser = async (userId: string) =>
    Number((await pool.query(
      `SELECT count(*)::int AS n
       FROM attendance_record_calculations c
       JOIN attendance_records r ON r.id = c.attendance_record_id
       WHERE r.user_id = $1`,
      [userId],
    )).rows[0].n)
  const outboxCount = async (orgId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE org_id = $1', [orgId])).rows[0].n)

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W4C-2 boundary wiring integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // Stage D no-env leg precondition: this server activates WITHOUT the W4
    // segment-calculation allowlist env, so the outbox drain worker must NOT
    // exist (the paired env-present leg lives in the posture-matrix suite).
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new AttendanceManagedPgPool({ connectionString: dbUrl })
    await insertActiveUser(legacyLiveUser, 'default')
    await insertActiveUser(settingsAdminUserId, settingsAdminOrg)
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [settingsAdminUserId],
    )
    settingsRowSnapshot = await snapshotAttendanceSettingsRow(pool)
    // Throttle off for the replay leg (see module note); exact-restored in afterAll.
    const adminToken = await mintToken(settingsAdminUserId, 'attendance:read,attendance:write,attendance:admin', settingsAdminOrg)
    const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ minPunchIntervalMinutes: 0 }),
    })
    if (putRes.status !== 200) throw new Error(`settings PUT failed: ${putRes.status}`)

    // P2-1 / P1 remediation (#4612 gate2) fixtures: one org, one published
    // shift bounded to a single calendar day (2026-07-19, UTC 20:00-23:00),
    // two users each individually assigned to it.
    // P2-2 remediation (#4612 gate3): `late_grace_minutes`/`early_grace_minutes`
    // are explicit zero (NOT the column default of 10, which coincidentally
    // equals DEFAULT_RULE's own 10-minute grace) so the shift's own rule is
    // deterministically DIFFERENT from `defaultRule` for any check-in/out
    // pair with more than a few minutes' margin — the K-L/K-L2 mutation legs
    // below depend on this to be non-vacuous.
    await insertLegacyRolloutRow(resolvedFixtureOrg)
    await insertActiveUser(plainResolvedUser, resolvedFixtureOrg)
    await insertActiveUser(driftResolvedUser, resolvedFixtureOrg)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days, late_grace_minutes, early_grace_minutes)
       VALUES ($1, $2, 'W4C2-P1-Resolved', 'UTC', '20:00', '23:00', false, '[0,1,2,3,4,5,6]'::jsonb, 0, 0)`,
      [resolvedFixtureShift, resolvedFixtureOrg],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $3, $4, $5, '2026-07-19', '2026-07-19', true, 'published', 1),
              ($2, $3, $6, $5, '2026-07-19', '2026-07-19', true, 'published', 1)`,
      [resolvedFixtureAssignmentA, resolvedFixtureAssignmentB, resolvedFixtureOrg, plainResolvedUser, resolvedFixtureShift, driftResolvedUser],
    )
  }, 120000)

  afterAll(async () => {
    if (pool && settingsRowSnapshot) {
      await restoreAttendanceSettingsRow(pool, settingsRowSnapshot).catch(() => undefined)
      resetAttendanceSettingsCacheAfterRestore()
    }
    await pool?.query('DELETE FROM attendance_shift_assignments WHERE id = $1', [httpContractAssignment]).catch(() => undefined)
    await pool?.query('DELETE FROM attendance_shifts WHERE id = $1', [httpContractShift]).catch(() => undefined)
    for (const userId of [legacyLiveUser, compatUser, suspendedLiveUser, controlLiveUser, scheduledLegacyUser, scheduledSuspendedUser, plainResolvedUser, driftResolvedUser, httpContractUser]) {
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
    }
    // Rollout-state and operation rows are append-only/immutable by design (trigger-denied
    // DELETE); they are keyed by this file's throwaway UUIDs and cannot collide.
    await pool?.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [settingsAdminUserId, 'admin']).catch(() => undefined)
    await pool?.query('DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2', [settingsAdminUserId, settingsAdminOrg]).catch(() => undefined)
    await pool?.query('DELETE FROM users WHERE id = $1', [settingsAdminUserId]).catch(() => undefined)
    // Retain the existing unique owned default with any retained source history.
    // Repeated suites reuse it through insertActiveUser's NOT EXISTS seed.
    await pool?.query(`DELETE FROM attendance_rules r WHERE r.id=ANY($1::uuid[])
      AND NOT EXISTS (SELECT 1 FROM attendance_shift_assignments a WHERE a.org_id=r.org_id AND a.is_active=true)
      AND NOT EXISTS (SELECT 1 FROM attendance_rotation_assignments a WHERE a.org_id=r.org_id AND a.is_active=true)
      AND NOT EXISTS (SELECT 1 FROM attendance_timezone_context_companions c WHERE c.org_id=r.org_id)
      AND NOT EXISTS (SELECT 1 FROM attendance_business_trip_arrangements b WHERE b.org_id=r.org_id AND b.effective_end_at>now())`,
    [seededDefaultRuleIds])
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
  }, 60000)

  it('legacy posture, null-ID live punch: legacy response with ZERO operation/calculation/outbox rows', async () => {
    const token = await mintToken(legacyLiveUser, 'attendance:write')
    const opsBefore = (await liveOperationRows('default')).length
    const outboxBefore = await outboxCount('default')

    const res = await punch(token, { eventType: 'check_in', occurredAt: '2026-07-20T01:00:00.000Z' })
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    // P1-1 remediation (#4612 gate MK-2): recursive key-path pin + deterministic
    // value assertions — see attendance-w4c2-golden-response.ts module note.
    // first_in_at mirrors the punch's own occurred_at (genuine cross-field
    // invariant, not a hardcoded instant).
    assertLegacyPunchResponseGoldenShapeV1(res.body.data, {
      userId: legacyLiveUser,
      status: 'partial',
      workMinutes: 0,
      lateMinutes: 0,
      firstInAt: res.body.data.event.occurred_at,
      lastOutAt: null,
      workDateResolutionKind: 'unresolved',
      workDateResolutionReasonCode: 'UNSCHEDULED_NO_SHIFT',
    })

    expect(await eventCount(legacyLiveUser)).toBe(1)
    expect(await recordCount(legacyLiveUser)).toBe(1)
    // Posture-split legacy side: NO operation, NO calculation, NO outbox row.
    expect((await liveOperationRows('default')).length).toBe(opsBefore)
    expect(await calculationCountForUser(legacyLiveUser)).toBe(0)
    expect(await outboxCount('default')).toBe(outboxBefore)
  })

  it.each([
    { label: 'default/null-id', orgId: 'default', stableId: false },
    { label: 'custom/null-id', orgId: randomUUID(), stableId: false },
    { label: 'default/stable-id', orgId: 'default', stableId: true },
    { label: 'custom/stable-id', orgId: randomUUID(), stableId: true },
  ] as const)('legacy text user keeps the real org and companion freeze ($label)', async ({ orgId, stableId }) => {
    const userId = `w4c2-legacy-text-${randomUUID()}`
    await insertActiveUser(userId, orgId)
    const token = await mintToken(userId, 'attendance:write', orgId)
    expect(token).not.toBe('')
    const opsBefore = await liveOperationRows(orgId)
    const outboxBefore = await outboxCount(orgId)
    const firstId = stableId ? randomUUID() : null
    const lastId = stableId ? randomUUID() : null
    const firstBody = { orgId, eventType: 'check_in', occurredAt: '2026-07-20T01:00:00.000Z', ...(firstId ? { operationId: firstId } : {}) }
    try {
      const first = await punch(token, firstBody)
      expect(first.status, first.raw).toBe(200)
      expect(first.body.data).toMatchObject({ event: { org_id: orgId }, record: { org_id: orgId } })
      assertLegacyPunchResponseGoldenShapeV1(first.body.data, {
        userId, status: 'partial', workMinutes: 0, lateMinutes: 0,
        firstInAt: first.body.data.event.occurred_at, lastOutAt: null,
        workDateResolutionKind: 'unresolved', workDateResolutionReasonCode: 'UNSCHEDULED_NO_SHIFT',
      })
      const frozen = (await pool.query(
        'SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2', [orgId, userId],
      )).rows
      expect(frozen).toHaveLength(1)
      expect(frozen[0]).toMatchObject({ org_id: orgId, user_id: userId, timezone: 'UTC' })
      if (stableId) {
        const sealed = await liveOperationRows(orgId)
        expect(sealed.filter(row => row.operation_id === firstId)).toHaveLength(1)
        expect(sealed.find(row => row.operation_id === firstId)).toMatchObject({
          state: 'completed', accepted_write_posture: 'legacy_projection_only', resolved_calculation_id: null,
        })
        const replay = await punch(token, firstBody)
        expect({ status: replay.status, body: replay.body }).toEqual({ status: first.status, body: first.body })
        const conflict = await punch(token, { ...firstBody, meta: { note: 'different fixture frame' } })
        expect(conflict.status, conflict.raw).toBe(409)
        expect(conflict.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')
        expect(await liveOperationRows(orgId)).toEqual(sealed)
        expect(await eventCount(userId)).toBe(1)
        expect(await recordCount(userId)).toBe(1)
        expect((await pool.query(
          'SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2', [orgId, userId],
        )).rows).toEqual(frozen)
      }
      const last = await punch(token, { orgId, eventType: 'check_out', occurredAt: '2026-07-20T02:00:00.000Z', ...(lastId ? { operationId: lastId } : {}) })
      expect(last.status, last.raw).toBe(200)
      expect(await eventCount(userId)).toBe(2)
      expect(await recordCount(userId)).toBe(1)
      expect((await pool.query(
        'SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2', [orgId, userId],
      )).rows).toEqual(frozen)
      expect((await pool.query(
        'SELECT DISTINCT org_id FROM attendance_records WHERE user_id=$1', [userId],
      )).rows).toEqual([{ org_id: orgId }])
      const operations = await liveOperationRows(orgId)
      const owned = operations.filter(row => row.operation_id === firstId || row.operation_id === lastId)
      expect(owned).toHaveLength(stableId ? 2 : 0)
      for (const row of owned) expect(row).toMatchObject({
        state: 'completed', accepted_write_posture: 'legacy_projection_only', actor_id: userId, resolved_calculation_id: null,
      })
      expect(operations.filter(row => !owned.includes(row))).toEqual(opsBefore)
      expect(await calculationCountForUser(userId)).toBe(0)
      expect(await outboxCount(orgId)).toBe(outboxBefore)
      await pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [userId, orgId])
      const denied = await punch(token, { orgId, eventType: 'check_in', occurredAt: '2026-07-21T01:00:00.000Z' })
      expect(denied.status, denied.raw).toBe(403)
      expect(denied.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' } })
      expect(await eventCount(userId)).toBe(2)
      expect(await recordCount(userId)).toBe(1)
      expect(await liveOperationRows(orgId)).toEqual(operations)
      expect(await calculationCountForUser(userId)).toBe(0)
      expect(await outboxCount(orgId)).toBe(outboxBefore)
      expect((await pool.query(
        'SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2', [orgId, userId],
      )).rows).toEqual(frozen)
    } finally {
      // retainHistoryInIsolatedDatabase: companion and its record/events/operations
      // are immutable paired evidence; only these owned identities are removable.
      await pool.query('DELETE FROM user_orgs WHERE user_id=$1 AND org_id=$2', [userId, orgId])
      await pool.query('DELETE FROM users WHERE id=$1', [userId])
    }
  })

  it('W4 shadow text user still fails the strict target domain before business writes', async () => {
    const orgId = randomUUID()
    const userId = `w4c2-shadow-text-${randomUUID()}`
    const priorAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    await insertActiveUser(userId, orgId)
    await insertLegacyRolloutRow(orgId)
    await pool.query(`UPDATE attendance_calculation_rollout_state
      SET state='shadow', prior_state='legacy', version=2 WHERE org_id=$1`, [orgId])
    const snapshot = async () => {
      const result: Record<string, unknown[]> = {}
      for (const table of ['attendance_events', 'attendance_records', 'attendance_record_calculations',
        'attendance_record_segments', 'attendance_result_operations', 'attendance_result_event_outbox',
        'attendance_requests', 'attendance_timezone_context_companions']) {
        result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [orgId])).rows
      }
      return result
    }
    try {
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
      const token = await mintToken(userId, 'attendance:write', orgId)
      expect(token).not.toBe('')
      const before = await snapshot()
      expect(Object.values(before).every(rows => rows.length === 0)).toBe(true)
      const result = await punch(token, { orgId, eventType: 'check_in', occurredAt: '2026-07-20T01:00:00.000Z', operationId: randomUUID() })
      // Preserve the existing strict identity error mapping; this patch does not widen W4 users.
      expect(result.status, result.raw).toBe(500)
      expect(result.body).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to punch attendance' } })
      expect(await snapshot()).toEqual(before)
    } finally {
      if (priorAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlist
      await pool.query('DELETE FROM user_orgs WHERE user_id=$1 AND org_id=$2', [userId, orgId])
      await pool.query('DELETE FROM users WHERE id=$1', [userId])
    }
  })

  it('suspended org rejects a text-user null-ID command before any business writes', async () => {
    const orgId = randomUUID()
    const userId = `w4c2-suspended-text-${randomUUID()}`
    await insertActiveUser(userId, orgId)
    await walkRolloutToSuspended(orgId)
    const token = await mintToken(userId, 'attendance:write', orgId)
    expect(token).not.toBe('')
    const snapshot = async () => {
      const result: Record<string, unknown[]> = {}
      for (const table of ['attendance_events', 'attendance_records', 'attendance_record_calculations',
        'attendance_record_segments', 'attendance_result_operations', 'attendance_result_event_outbox',
        'attendance_requests', 'attendance_timezone_context_companions']) {
        result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [orgId])).rows
      }
      return result
    }
    try {
      const before = await snapshot()
      expect(Object.values(before).every(rows => rows.length === 0)).toBe(true)
      const result = await punch(token, { orgId, eventType: 'check_in', occurredAt: '2026-07-20T01:00:00.000Z' })
      expect(result.status, result.raw).toBe(503)
      expect(result.body).toEqual({ ok: false, error: { code: 'SEGMENT_CALCULATION_SUSPENDED', message: 'SEGMENT_CALCULATION_SUSPENDED' } })
      expect(await snapshot()).toEqual(before)
    } finally {
      await pool.query('DELETE FROM user_orgs WHERE user_id=$1 AND org_id=$2', [userId, orgId])
      await pool.query('DELETE FROM users WHERE id=$1', [userId])
    }
  })

  it('P1-3 remediation declare-item: in-transaction legacy attribution re-derivation rejects an ambiguous shift match with a CLOSED 409 (not an unmapped 500)', async () => {
    // This branch is only reachable in production via a genuine race (assignment
    // data changes between the route's own pre-check and this transaction) — the
    // route's identical pre-check would already 422 the SAME data before ever
    // calling the boundary. Rather than construct a contrived HTTP-level race
    // (out of scope for this remediation round; see PR body §declare-items), this
    // proves the branch's OWN behavior directly via the test-only seam, matching
    // the existing __xyzForTests direct-call convention used elsewhere in this
    // plugin (see resetAttendanceSettingsCacheForTests above).
    const plugin = settingsRowRequireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4c2LegacyAttributionForTests?: {
        deriveLegacyLivePunchAttributionV1: (
          trx: unknown,
          // P1 remediation (#4612 gate2): the function's param is `requestTimezone`,
          // NOT `timezone` — see the module comment above
          // `deriveLegacyLivePunchAttributionV1` in index.cjs.
          args: { orgId: string; userId: string; occurredAt: Date; requestTimezone: string },
        ) => Promise<unknown>
        HttpError: new (status: number, code: string, message: string) => Error & { status: number; code: string }
      }
    }
    const seam = plugin.__attendanceW4c2LegacyAttributionForTests
    if (!seam) throw new Error('W4C2_TEST_SEAM_MISSING: __attendanceW4c2LegacyAttributionForTests')

    const ambigOrg = randomUUID()
    const ambigUser = randomUUID()
    const shiftA = randomUUID()
    const shiftB = randomUUID()
    const asgA = randomUUID()
    const asgB = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days)
       VALUES ($1, $2, 'W4C2-Ambig-A', 'UTC', '06:00', '14:00', false, '[0,1,2,3,4,5,6]'::jsonb),
              ($3, $2, 'W4C2-Ambig-B', 'UTC', '12:00', '16:00', false, '[0,1,2,3,4,5,6]'::jsonb)`,
      [shiftA, ambigOrg, shiftB],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $3, $4, $5, '2026-07-17', '2026-07-17', true, 'published', 1),
              ($2, $3, $4, $6, '2026-07-17', '2026-07-17', true, 'published', 2)`,
      [asgA, asgB, ambigOrg, ambigUser, shiftA, shiftB],
    )

    // Adapters expect `query -> rows[]` (plugin-shaped), not the raw pg
    // `QueryResult` — mirrors `pluginShapedTrx` in w4c2-live-scheduled-boundary.ts.
    const pluginShaped = (raw: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => ({
      async query(sqlText: string, params?: unknown[]) {
        const result = await raw.query(sqlText, params ?? [])
        return result.rows
      },
    })

    const client = await pool.connect()
    let caught: (Error & { status?: number; code?: string }) | undefined
    try {
      // 13:30 hits both A (06-14) and B (12-16) — same overlap recipe as the W2
      // resolver's own "ambiguous (no row-order)" leg.
      await seam.deriveLegacyLivePunchAttributionV1(pluginShaped(client), {
        orgId: ambigOrg,
        userId: ambigUser,
        occurredAt: new Date('2026-07-17T13:30:00.000Z'),
        requestTimezone: 'UTC',
      })
    } catch (error) {
      caught = error as Error & { status?: number; code?: string }
    } finally {
      client.release()
    }

    expect(caught).toBeInstanceOf(seam.HttpError)
    expect(caught?.status).toBe(409)
    expect(caught?.code).toBe('W4C2_LEGACY_WORK_DATE_ATTRIBUTION_AMBIGUOUS_IN_TRANSACTION')

    // Positive control: the SAME seam on a NON-ambiguous (single-shift) fixture
    // resolves cleanly instead of throwing — proves the 409 above is caused by
    // the overlap, not by the direct-call harness itself.
    const cleanUser = randomUUID()
    const controlClient = await pool.connect()
    let controlResult: unknown
    let controlError: unknown
    try {
      controlResult = await seam.deriveLegacyLivePunchAttributionV1(pluginShaped(controlClient), {
        orgId: ambigOrg,
        userId: cleanUser,
        occurredAt: new Date('2026-07-17T13:30:00.000Z'),
        requestTimezone: 'UTC',
      })
    } catch (error) {
      controlError = error
    } finally {
      controlClient.release()
    }
    expect(controlError).toBeUndefined()
    expect(controlResult).toBeTruthy()
  })

  it('P2-1 remediation: legacy posture, `resolved` live punch (published shift, client tz == shift tz) is covered by the byte red-line pin', async () => {
    // #4612 gate2 M10 finding: the ORIGINAL golden pin's two fixtures were
    // both unscheduled (`unresolved`/`UNSCHEDULED_NO_SHIFT`), so
    // `deriveLegacyLivePunchAttributionV1`'s `resolution.kind === 'resolved'`
    // branch had ZERO coverage — shifting `calendarWorkDate` by a whole day
    // left 794/795 green. This leg is the plain "shift actually resolves, no
    // tz drift" fixture — see assertLegacyPunchResponseGoldenShapeResolvedV1's
    // module comment for why both the response AND the frozen DB meta copy
    // are asserted.
    //
    // #4612 gate3 P2-2 remediation: a check-in-only fixture makes
    // `computeMetrics` take its `!lastOutAt` short-circuit
    // (`{workMinutes:0, lateMinutes:0, status:'partial'}` UNCONDITIONALLY,
    // regardless of which `rule` object was used) — the gate's K-L/K-L2
    // mutations proved this fixture shape gives the `rule: resolvedShift`
    // projection (`index.cjs` `deriveLegacyLivePunchAttributionV1` return
    // value) ZERO judging power: swapping it for `defaultRule`, or for an
    // impossible-to-coincide 03:00-04:00/zero-grace rule, left the full
    // suite green. A `check_out` closes the day so `computeMetrics` actually
    // runs its rule-driven late/early-threshold arithmetic. The shift's own
    // rule is `late_grace_minutes=0` (fixture setup above, explicit — NOT
    // the column default of 10, which coincidentally equals DEFAULT_RULE's
    // own grace); check-in is 6 minutes after the shift's 20:00 start, so
    // only the ACTUAL (shift) rule reports it late — DEFAULT_RULE's 10-
    // minute grace would swallow it (`lateMinutes: 0`, `status: 'normal'`).
    // check-out lands exactly at the shift's 23:00 end so neither rule's
    // early-leave threshold fires, isolating the discriminator to lateness.
    const token = await mintToken(plainResolvedUser, 'attendance:write')
    const checkin = await punch(token, {
      eventType: 'check_in',
      occurredAt: '2026-07-19T20:06:00.000Z',
      timezone: 'UTC',
      orgId: resolvedFixtureOrg,
    })
    expect(checkin.status).toBe(200)
    expect(checkin.body?.ok).toBe(true)
    const res = await punch(token, {
      eventType: 'check_out',
      occurredAt: '2026-07-19T23:00:00.000Z',
      timezone: 'UTC',
      orgId: resolvedFixtureOrg,
    })
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    assertLegacyPunchResponseGoldenShapeResolvedV1(res.body.data, {
      userId: plainResolvedUser,
      status: 'late',
      workMinutes: 170,
      lateMinutes: 6,
      firstInAt: checkin.body.data.event.occurred_at,
      lastOutAt: res.body.data.event.occurred_at,
      calendarWorkDate: '2026-07-19',
      reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT',
      shiftId: resolvedFixtureShift,
      resolvedWorkDate: '2026-07-19',
      matchingCount: 1,
    })
  })

  it('P1 remediation (#4612 gate2 finding, exact-head `ad5541027`): zero-concurrency client-tz != winning-shift-tz drift no longer byte-flips the legacy response or the frozen DB evidence', async () => {
    // Same published shift as the leg above (UTC 20:00-23:00, 2026-07-19),
    // but the legacy command explicitly carries `timezone: 'Asia/Tokyo'`. The historical route's
    // PRE-resolution timezone is 'Asia/Tokyo' (client input wins the route's
    // own resolvePunchWorkDateByShiftWindow call: `calendarWorkDate` =
    // toWorkDate(2026-07-19T22:00:00Z, 'Asia/Tokyo') = '2026-07-20'); the
    // POST-resolution timezone the route persists is 'UTC' (the winning
    // shift's own rule timezone unconditionally overwrites it — see
    // resolvePunchWorkDateByShiftWindow's `nextTimezone`, which does NOT
    // re-consult the client's explicit choice). Before the P1 fix, the
    // in-transaction re-derivation used the POST-resolution 'UTC' to
    // recompute `calendarWorkDate`, landing on '2026-07-19' instead of the
    // route's own '2026-07-20' — a DIFFERENT resolver call, DIFFERENT
    // reasonCode (CURRENT_DAY_CONTAINING_SHIFT instead of
    // SINGLE_MATCHING_CANDIDATE), permanently frozen into DB evidence. This
    // leg pins the CORRECT legacy boundary values; HTTP now rejects this drift
    // before the boundary, as the separate HTTP contract test proves.
    //
    // #4612 gate3 P2-2 remediation: same rationale as the leg above — a
    // check_out closes the day so `rule: resolvedShift` (shift, late_grace=0)
    // vs `rule: defaultRule`/a mutated rule (K-L/K-L2) actually diverge in
    // `record.late_minutes`/`.status`. The winning shift row/window is
    // IDENTICAL to the leg above (UTC 20:00-23:00 on 2026-07-19) regardless
    // of the client's tz-drift input — `nextTimezone` always persists the
    // WINNING SHIFT's own rule timezone ('UTC'), so the same check-in/out
    // instants produce the same late/work/status numbers here.
    const driver = createLegacyLivePunchBoundaryDriver(pool)
    const checkin = await driver.execute(await driver.prepare({
      userId: driftResolvedUser,
      eventType: 'check_in',
      occurredAt: '2026-07-19T20:06:00.000Z',
      timezone: 'Asia/Tokyo',
      orgId: resolvedFixtureOrg,
    }))
    expect(checkin.kind).toBe('legacy')
    const checkinData = JSON.parse(JSON.stringify(checkin.response))
    const res = await driver.execute(await driver.prepare({
      userId: driftResolvedUser,
      eventType: 'check_out',
      occurredAt: '2026-07-19T23:00:00.000Z',
      timezone: 'Asia/Tokyo',
      orgId: resolvedFixtureOrg,
    }))
    expect(res.kind).toBe('legacy')
    const data = JSON.parse(JSON.stringify(res.response))
    assertLegacyPunchResponseGoldenShapeResolvedV1(data, {
      userId: driftResolvedUser,
      status: 'late',
      workMinutes: 170,
      lateMinutes: 6,
      firstInAt: checkinData.event.occurred_at,
      lastOutAt: data.event.occurred_at,
      calendarWorkDate: '2026-07-20',
      reasonCode: 'SINGLE_MATCHING_CANDIDATE',
      shiftId: resolvedFixtureShift,
      resolvedWorkDate: '2026-07-19',
      matchingCount: 1,
    })
    const persisted = await pool.query('SELECT meta FROM attendance_records WHERE user_id = $1 AND org_id = $2', [driftResolvedUser, resolvedFixtureOrg])
    expect(persisted.rows).toHaveLength(1)
    expect(persisted.rows[0].meta.workDateAttributionV1).toEqual(data.record.meta.workDateAttributionV1)
    expect(await eventCount(driftResolvedUser)).toBe(2)
    expect(await recordCount(driftResolvedUser)).toBe(1)
  })

  it('HTTP timezone authority: Tokyo conflicts with default UTC with seven-table zero writes; same-subject UTC succeeds', async () => {
    await insertActiveUser(httpContractUser, httpContractOrg)
    await insertLegacyRolloutRow(httpContractOrg)
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days, late_grace_minutes, early_grace_minutes)
       VALUES ($1, $2, 'W4C2-HTTP-UTC', 'UTC', '20:00', '23:00', false, '[0,1,2,3,4,5,6]'::jsonb, 0, 0)`,
      [httpContractShift, httpContractOrg],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, $4, '2026-07-19', '2026-07-19', true, 'published', 1)`,
      [httpContractAssignment, httpContractOrg, httpContractUser, httpContractShift],
    )
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM attendance_events WHERE org_id=$1) AS events,
      (SELECT count(*)::int FROM attendance_records WHERE org_id=$1) AS records,
      (SELECT count(*)::int FROM attendance_result_operations WHERE org_id=$1) AS operations,
      (SELECT count(*)::int FROM attendance_record_calculations WHERE org_id=$1) AS calculations,
      (SELECT count(*)::int FROM attendance_record_segments s JOIN attendance_record_calculations c ON c.id=s.calculation_id WHERE c.org_id=$1) AS segments,
      (SELECT count(*)::int FROM attendance_result_event_outbox WHERE org_id=$1) AS outbox,
      (SELECT count(*)::int FROM attendance_timezone_context_companions WHERE org_id=$1) AS companions`, [httpContractOrg])).rows[0]
    const zero = { events: 0, records: 0, operations: 0, calculations: 0, segments: 0, outbox: 0, companions: 0 }
    const token = await mintToken(httpContractUser, 'attendance:write', httpContractOrg)
    const body = {
      eventType: 'check_in', occurredAt: '2026-07-19T20:06:00.000Z',
      timezone: 'Asia/Tokyo', orgId: httpContractOrg, operationId: randomUUID(),
    }
    expect(await counts()).toEqual(zero)
    const conflict = await punch(token, body)
    expect(conflict.status, conflict.raw).toBe(409)
    expect(conflict.body).toEqual({
      ok: false,
      error: { code: 'ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT', message: 'ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT' },
    })
    expect(await counts()).toEqual(zero)

    const checkin = await punch(token, { ...body, timezone: 'UTC' })
    expect(checkin.status, checkin.raw).toBe(200)
    expect(checkin.body?.ok).toBe(true)
    const res = await punch(token, {
      ...body, eventType: 'check_out', occurredAt: '2026-07-19T23:00:00.000Z',
      timezone: 'UTC', operationId: randomUUID(),
    })
    expect(res.status, res.raw).toBe(200)
    expect(res.body?.ok).toBe(true)
    assertLegacyPunchResponseGoldenShapeResolvedV1(res.body.data, {
      userId: httpContractUser,
      status: 'late',
      workMinutes: 170,
      lateMinutes: 6,
      firstInAt: checkin.body.data.event.occurred_at,
      lastOutAt: res.body.data.event.occurred_at,
      calendarWorkDate: '2026-07-19',
      reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT',
      shiftId: httpContractShift,
      resolvedWorkDate: '2026-07-19',
      matchingCount: 1,
    })
    expect(await eventCount(httpContractUser)).toBe(2)
    expect(await recordCount(httpContractUser)).toBe(1)
    expect(await calculationCountForUser(httpContractUser)).toBe(0)
    expect(await outboxCount(httpContractOrg)).toBe(0)
  })

  it('stable-ID legacy_compat: claim+seal, congruent replay returns stored response with zero new DML, incongruent same key is 409', async () => {
    await insertActiveUser(compatUser, 'default')
    const token = await mintToken(compatUser, 'attendance:write')
    const operationId = randomUUID()
    const body = { eventType: 'check_in' as const, occurredAt: '2026-07-20T02:00:00.000Z', operationId }

    const first = await punch(token, body)
    expect(first.status).toBe(200)
    expect(first.body?.ok).toBe(true)
    expect(await eventCount(compatUser)).toBe(1)

    // Sealed compatibility operation with the frozen legacy write posture.
    const ops = (await liveOperationRows('default')).filter((row) => row.operation_id === operationId)
    expect(ops.length).toBe(1)
    expect(ops[0]).toMatchObject({
      state: 'completed',
      accepted_write_posture: 'legacy_projection_only',
      actor_id: compatUser,
      capability: 'punch',
      resolved_calculation_id: null,
    })
    expect(ops[0].response_snapshot).not.toBeNull()
    // Legacy side of the posture split: still no calculation/outbox row.
    expect(await calculationCountForUser(compatUser)).toBe(0)

    // Congruent replay: same stored response, ZERO new source DML.
    const replay = await punch(token, body)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(await eventCount(compatUser)).toBe(1)

    // Advancing only the server clock replays the first sealed receipt exactly.
    const laterReplay = await punch(token, { ...body, occurredAt: '2026-07-21T03:00:00.000Z' })
    expect(laterReplay).toEqual(first)
    // A real client business-frame change still conflicts with zero new DML.
    const conflict = await punch(token, { ...body, meta: { note: 'changed client business frame' } })
    expect(conflict.status).toBe(409)
    expect(conflict.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    expect(await eventCount(compatUser)).toBe(1)
  })

  it('suspended rollout org: live punch is refused BEFORE any source DML (positive control: legacy-state org writes)', async () => {
    // Membership-derived punch-route org resolution (this route only) now requires an
    // active `user_orgs` row for the org named on the request before any downstream
    // gate (including the suspended-rollout check below) is ever reached — both users
    // punch into an explicit `orgId`, so both need a matching active membership.
    await insertActiveUser(controlLiveUser, controlLiveOrg)
    await insertActiveUser(suspendedLiveUser, suspendedLiveOrg)
    await walkRolloutToSuspended(suspendedLiveOrg)
    await insertLegacyRolloutRow(controlLiveOrg)

    // POSITIVE CONTROL first: the identical punch shape into a legacy-state rollout org
    // succeeds and writes exactly one event — the suspended leg below cannot pass vacuously.
    const controlToken = await mintToken(controlLiveUser, 'attendance:write')
    const control = await punch(controlToken, { eventType: 'check_in', occurredAt: '2026-07-20T01:30:00.000Z', orgId: controlLiveOrg })
    expect(control.status).toBe(200)
    expect(await eventCount(controlLiveUser)).toBe(1)

    const token = await mintToken(suspendedLiveUser, 'attendance:write')
    const res = await punch(token, { eventType: 'check_in', occurredAt: '2026-07-20T01:30:00.000Z', orgId: suspendedLiveOrg })
    expect(res.status).toBe(503)
    expect(res.body?.error?.code).toBe('SEGMENT_CALCULATION_SUSPENDED')
    // Values-free: the closed code is the whole message; no caller value is echoed.
    expect(res.body?.error?.message).toBe('SEGMENT_CALCULATION_SUSPENDED')
    expect(await eventCount(suspendedLiveUser)).toBe(0)
    expect(await recordCount(suspendedLiveUser)).toBe(0)
  })

  it('no allowlist env at activate => NO outbox drain worker exists (byte-identical runtime; paired env-present leg in the posture-matrix suite)', async () => {
    const plugin = settingsRowRequireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4OutboxDrainForTests?: {
        getState(): { gated: boolean }
        runOnce(): Promise<unknown>
      }
    }
    const probe = plugin.__attendanceW4OutboxDrainForTests
    expect(probe).toBeTruthy()
    expect(probe!.getState()).toEqual({ gated: false })
    await expect(probe!.runOnce()).rejects.toThrow('W4_OUTBOX_DRAIN_NOT_GATED')
  })

  it('legacy live write waits on the real org runtime lock before companion creation', async () => {
    const orgId = randomUUID()
    const readerUser = randomUUID()
    const writerUser = `w4c2-lock-text-${randomUUID()}`
    await insertActiveUser(readerUser, orgId)
    await insertActiveUser(writerUser, orgId)
    const token = await mintToken(writerUser, 'attendance:write', orgId)
    expect(token).not.toBe('')
    const holder = await pool.connect()
    let transactionOpen = false
    let pending: Promise<{ response?: HttpResponse; error?: unknown }> | undefined
    let settled = false
    try {
      await holder.query('BEGIN')
      transactionOpen = true
      // Different subjects exclude per-user locks; the HTTP route's shared pre-read can pass.
      await acquireAttendanceTimezoneRuntimeLocksV1(holder, { orgId, userId: readerUser, mode: 'shared' })
      pending = punch(token, { orgId, eventType: 'check_in', occurredAt: '2026-07-20T01:00:00.000Z' })
        .then(response => { settled = true; return { response } }, error => { settled = true; return { error } })
      type Waiter = { mode: string; granted: boolean; blocked_by_holder: boolean }
      let waiters: Waiter[] = []
      const deadline = Date.now() + 10_000
      do {
        const observed = await holder.query<Waiter>(`SELECT waiting.mode, waiting.granted,
          held.pid=ANY(pg_blocking_pids(waiting.pid)) AS blocked_by_holder
          FROM pg_locks held JOIN pg_locks waiting
            ON waiting.locktype=held.locktype AND waiting.database=held.database
            AND waiting.classid=held.classid AND waiting.objid=held.objid AND waiting.objsubid=held.objsubid
          WHERE held.locktype='advisory' AND held.pid=pg_backend_pid()
            AND held.mode='ShareLock' AND held.granted
            AND held.classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid
            AND held.objid=(hashtextextended($1,0) & 4294967295)::oid AND held.objsubid=1
            AND waiting.pid<>held.pid AND NOT waiting.granted`,
        [buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgId)])
        waiters = observed.rows
        if (waiters.length || settled) break
        await new Promise(resolve => setTimeout(resolve, 25))
      } while (Date.now() < deadline)
      expect(waiters, 'LEGACY_RUNTIME_EXCLUSIVE_WAIT_REQUIRED').toEqual([
        { mode: 'ExclusiveLock', granted: false, blocked_by_holder: true },
      ])
      expect(settled).toBe(false)
      const before = await holder.query(`SELECT
        (SELECT count(*)::int FROM attendance_events WHERE org_id=$1) AS events,
        (SELECT count(*)::int FROM attendance_records WHERE org_id=$1) AS records,
        (SELECT count(*)::int FROM attendance_timezone_context_companions WHERE org_id=$1) AS companions`, [orgId])
      expect(before.rows).toEqual([{ events: 0, records: 0, companions: 0 }])
      await holder.query('COMMIT')
      transactionOpen = false
      const outcome = await pending
      if (outcome.error) throw outcome.error
      expect(outcome.response?.status, outcome.response?.raw).toBe(200)
      expect(await eventCount(writerUser)).toBe(1)
      expect(await recordCount(writerUser)).toBe(1)
      expect(await liveOperationRows(orgId)).toEqual([])
      expect(await calculationCountForUser(writerUser)).toBe(0)
      expect(await outboxCount(orgId)).toBe(0)
      const paired = await holder.query(`SELECT c.org_id,c.user_id,c.timezone,r.org_id AS record_org_id
        FROM attendance_timezone_context_companions c JOIN attendance_records r ON r.id=c.record_id AND r.org_id=c.org_id
        WHERE c.org_id=$1 AND c.user_id=$2`, [orgId, writerUser])
      expect(paired.rows).toEqual([{ org_id: orgId, user_id: writerUser, timezone: 'UTC', record_org_id: orgId }])
    } finally {
      try { if (transactionOpen) await holder.query('ROLLBACK') } finally { holder.release() }
      // Drain the real request after releasing the blocker, including mutation/failure paths.
      if (pending) await pending
      // Keep the immutable record/events/companion evidence and its owned default in this isolated DB.
      await pool.query('DELETE FROM user_orgs WHERE org_id=$1 AND user_id=ANY($2::text[])', [orgId, [readerUser, writerUser]])
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[readerUser, writerUser]])
    }
  }, 30000)

  it('suspended rollout org: administrator absence run reports the closed suspended outcome and inserts NO absent row (positive control: legacy-state org generates)', async () => {
    // POSITIVE CONTROL: same fixture shape over a legacy-state rollout org generates one row.
    await insertLegacyRolloutRow(scheduledLegacyOrg)
    await insertActiveUser(scheduledLegacyUser, scheduledLegacyOrg)
    const adminToken = await mintToken(randomUUID(), 'attendance:read,attendance:write,attendance:admin')
    // 2026-07-22 is a past Wednesday (default rule working day), no shifts => rule-source
    // calendar derivation => absence target.
    const control = await autoAbsenceRun(adminToken, { orgId: scheduledLegacyOrg, workDate: '2026-07-22' })
    expect(control.status).toBe(200)
    expect(control.body?.data).toMatchObject({ skipped: false, generated: 1, total: 1 })
    expect(await recordCount(scheduledLegacyUser)).toBe(1)

    await walkRolloutToSuspended(scheduledSuspendedOrg)
    await insertActiveUser(scheduledSuspendedUser, scheduledSuspendedOrg)
    const res = await autoAbsenceRun(adminToken, { orgId: scheduledSuspendedOrg, workDate: '2026-07-22' })
    expect(res.status).toBe(200)
    expect(res.body?.data).toMatchObject({ skipped: true, reason: 'segment_calculation_suspended', total: 0 })
    expect(await recordCount(scheduledSuspendedUser)).toBe(0)
  })
})
