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
import { Pool } from 'pg'
import {
  snapshotAttendanceSettingsRow,
  restoreAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'
import { assertLegacyPunchResponseGoldenShapeV1 } from '../utils/attendance-w4c2-golden-response'

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

describeDb('W4C-2 canonical live/scheduled boundary wiring (real DB, route-level)', () => {
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
    pool = new Pool({ connectionString: dbUrl })
    settingsRowSnapshot = await snapshotAttendanceSettingsRow(pool)
    // Throttle off for the replay leg (see module note); exact-restored in afterAll.
    const adminToken = await mintToken(randomUUID(), 'attendance:read,attendance:write,attendance:admin')
    const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ minPunchIntervalMinutes: 0 }),
    })
    if (putRes.status !== 200) throw new Error(`settings PUT failed: ${putRes.status}`)
  }, 120000)

  afterAll(async () => {
    if (pool && settingsRowSnapshot) {
      await restoreAttendanceSettingsRow(pool, settingsRowSnapshot).catch(() => undefined)
      resetAttendanceSettingsCacheAfterRestore()
    }
    for (const userId of [legacyLiveUser, compatUser, suspendedLiveUser, controlLiveUser, scheduledLegacyUser, scheduledSuspendedUser]) {
      await pool?.query('DELETE FROM attendance_events WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM attendance_records WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
    }
    // Rollout-state and operation rows are append-only/immutable by design (trigger-denied
    // DELETE); they are keyed by this file's throwaway UUIDs and cannot collide.
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

    // Same key, different business time: closed 409 conflict, still zero new DML.
    const conflict = await punch(token, { ...body, occurredAt: '2026-07-20T03:00:00.000Z' })
    expect(conflict.status).toBe(409)
    expect(conflict.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    expect(await eventCount(compatUser)).toBe(1)
  })

  it('suspended rollout org: live punch is refused BEFORE any source DML (positive control: legacy-state org writes)', async () => {
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
