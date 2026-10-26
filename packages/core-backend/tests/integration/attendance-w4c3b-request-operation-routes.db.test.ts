import { requestOnlinePunchFixture } from '../utils/attendance-online-punch-fixture'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import {
  restoreAttendanceSettingsRow,
  snapshotAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

type JsonResponse = { status: number; body: Record<string, any> | null; raw: string }

function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

const requestJson = (...args: Parameters<typeof rawRequestJson>): ReturnType<typeof rawRequestJson> =>
  requestOnlinePunchFixture(args[0], args[1] ?? {}, rawRequestJson)

function rawRequestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = options.body ? JSON.stringify(options.body) : null
    const request = http.request({
      method: options.method ?? 'GET',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...options.headers,
      },
    }, (response) => {
      let raw = ''
      response.on('data', (chunk) => { raw += String(chunk) })
      response.on('end', () => {
        let body: Record<string, any> | null = null
        try { body = raw ? JSON.parse(raw) as Record<string, any> : null } catch { body = null }
        resolve({ status: response.statusCode ?? 0, body, raw })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

describeIfDatabase('W4C-3b P13 request operation routes (real plugin, real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  const seededDefaultRuleIds: string[] = []
  const seededAdminPermissionUserIds: string[] = []
  let baseUrl = ''
  let settingsRowSnapshot: AttendanceSettingsRowSnapshot | undefined
  const pluginRequire = createRequire(import.meta.url)
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    rollout: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
  }

  async function mintToken(userId: string, tenantId?: string): Promise<string> {
    const response = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}&roles=admin&perms=${encodeURIComponent('*:*')}`,
    )
    const token = response.body?.token
    if (typeof token !== 'string' || !token) throw new Error(`failed to mint token: ${response.raw}`)
    return token
  }

  async function seedOrg(
    state: 'legacy' | 'shadow' | 'suspended',
    permission = 'attendance:admin',
  ) {
    const orgId = randomUUID()
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-3b request fixture', 'x', 'user', $3::jsonb,
               true, false, now(), now())`,
      [userId, `w4c3b-request-${userId}@example.test`, JSON.stringify([permission])],
    )
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
    if (permission === 'attendance:admin') {
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin')`,
        [userId],
      )
      seededAdminPermissionUserIds.push(userId)
    }
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3b-request-test', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
      [orgId, userId],
    )
    if (state === 'shadow' || state === 'suspended') {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'shadow', prior_state = 'legacy', version = 2
          WHERE org_id = $1`,
        [orgId],
      )
    }
    if (state === 'suspended') {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'eligible', prior_state = 'shadow', version = 3
          WHERE org_id = $1`,
        [orgId],
      )
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'authoritative', prior_state = 'eligible', version = 4
          WHERE org_id = $1`,
        [orgId],
      )
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'suspended', prior_state = 'authoritative', version = 5
          WHERE org_id = $1`,
        [orgId],
      )
    }
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
    const defaultRule = await pool.query<{ id: string }>(
      `INSERT INTO attendance_rules
       (id, org_id, name, timezone, timezone_version, work_start_time, work_end_time, working_days, is_default)
       SELECT $1, $2, 'owned timezone fixture', $3, 1, '09:00', '18:00', '[1,2,3,4,5]'::jsonb, true
       WHERE NOT EXISTS (SELECT 1 FROM attendance_rules WHERE org_id = $2 AND is_default = true)
       RETURNING id`,
      [randomUUID(), orgId, 'UTC'],
    )
    seededDefaultRuleIds.push(...defaultRule.rows.map(row => row.id))
    return { orgId, userId, token: await mintToken(userId, orgId) }
  }

  async function createRequest(
    fixture: Awaited<ReturnType<typeof seedOrg>>,
    workDate: string,
  ) {
    const response = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: {
        operationId: randomUUID(),
        orgId: fixture.orgId,
        workDate,
        requestType: 'missed_check_in',
        requestedInAt: `${workDate}T09:00:00.000Z`,
        reason: 'W4C-3b decision fixture',
      },
    })
    expect(response.status, response.raw).toBe(201)
    const requestId = response.body?.data?.request?.id
    expect(typeof requestId).toBe('string')
    return requestId as string
  }

  async function loadApprovalCursor(requestId: string) {
    const result = await pool.query(
      `SELECT ai.id, ai.version, ai.current_node_key
         FROM attendance_requests ar
         JOIN approval_instances ai ON ai.id = ar.approval_instance_id
        WHERE ar.id = $1::uuid`,
      [requestId],
    )
    expect(result.rows).toHaveLength(1)
    return {
      approvalId: String(result.rows[0].id),
      version: Number(result.rows[0].version),
      node: String(result.rows[0].current_node_key),
    }
  }

  async function assignApprovalUser(
    approval: Awaited<ReturnType<typeof loadApprovalCursor>>,
    userId: string,
  ) {
    await pool.query(
      `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata)
       VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)`,
      [approval.approvalId, userId, approval.node],
    )
  }

  async function seedOrgActor(orgId: string, permission: string) {
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'W4C-3b org actor', 'x', 'user', $3::jsonb,
               TRUE, FALSE, 'activated')`,
      [userId, `w4c3b-org-actor-${userId}@example.test`, JSON.stringify([permission])],
    )
    await pool.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [userId, orgId],
    )
    return { userId, token: await mintToken(userId, orgId) }
  }

  async function requestDecisionResidue(orgId: string, requestId: string, operationId: string | null = null) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1
             AND entrypoint = 'request_decision'
             AND (resolved_request_id = $2::uuid OR ($3::uuid IS NOT NULL AND operation_id = $3::uuid))) AS operations,
         (SELECT count(*)::int
            FROM attendance_result_event_outbox outbox
           WHERE outbox.org_id = $1
             AND outbox.entrypoint = 'request_decision'
             AND (
               ($3::uuid IS NOT NULL AND outbox.operation_id = $3::uuid)
               OR EXISTS (
                 SELECT 1 FROM attendance_result_operations operation
                  WHERE operation.org_id = outbox.org_id
                    AND operation.entrypoint = outbox.entrypoint
                    AND operation.operation_id = outbox.operation_id
                    AND operation.resolved_request_id = $2::uuid
               )
             )) AS outbox,
         (SELECT count(*)::int FROM approval_records pr
           JOIN attendance_requests ar ON ar.approval_instance_id = pr.instance_id
          WHERE ar.org_id = $1 AND ar.id = $2::uuid) AS approval_records`,
      [orgId, requestId, operationId],
    )
    return result.rows[0] as { operations: number; outbox: number; approval_records: number }
  }

  async function operationResidue(orgId: string, operationId: string, entrypoint: string) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND operation_id = $2::uuid AND entrypoint = $3) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND operation_id = $2::uuid AND entrypoint = $3) AS outbox,
         (SELECT source_ref FROM attendance_result_operations
           WHERE org_id = $1 AND operation_id = $2::uuid AND entrypoint = $3
           LIMIT 1) AS source_ref`,
      [orgId, operationId, entrypoint],
    )
    return result.rows[0] as { operations: number; outbox: number; source_ref: string | null }
  }

  async function dispatchCentralDecision(
    approvalId: string,
    actorId: string,
    action: 'approve' | 'reject',
  ) {
    const { ApprovalBridgeService } = await import('../../src/services/ApprovalBridgeService')
    const bridge = new ApprovalBridgeService(null)
    return bridge.dispatchAction(
      approvalId,
      { action, comment: `central ${action}` },
      { userId: actorId, userName: actorId },
    )
  }

  async function counts(orgId: string) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1) AS requests,
         (SELECT count(*)::int FROM attendance_request_calculation_snapshots WHERE org_id = $1) AS snapshots,
         (SELECT count(*)::int FROM attendance_result_operations WHERE org_id = $1) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox WHERE org_id = $1) AS outbox`,
      [orgId],
    )
    return result.rows[0] as { requests: number; snapshots: number; operations: number; outbox: number }
  }

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) throw new Error('W4C3B_REQUEST_ROUTE_TEST_REQUIRES_DATABASE_AND_LOOPBACK')
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const loaded = await import('../../src/index')
    server = new loaded.MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('attendance server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    settingsRowSnapshot = await snapshotAttendanceSettingsRow(pool)
  }, 120000)

  afterEach(async () => {
    if (pool) await restoreAttendanceSettingsRow(pool, settingsRowSnapshot)
    const plugin = pluginRequire('../../../../plugins/plugin-attendance/index.cjs') as {
      resetAttendanceSettingsCacheForTests?: () => void
    }
    plugin.resetAttendanceSettingsCacheForTests?.()
  })

  afterAll(async () => {
    await pool?.query(
      "DELETE FROM user_permissions WHERE user_id = ANY($1::text[]) AND permission_code = 'attendance:admin'",
      [seededAdminPermissionUserIds],
    ).catch(() => undefined)
    await pool?.query('DELETE FROM attendance_rules WHERE id = ANY($1::uuid[])', [seededDefaultRuleIds]).catch(() => undefined)
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      RBAC_BYPASS: priorEnv.rbacBypass,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: priorEnv.rollout,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it.each([
    { scenario: 'core-violation', inTime: '10:30', outTime: '14:30', minutes: 240, late: 25, early: 205,
      status: 'late_early', reasons: ['early_check_out', 'late_check_in'] },
    { scenario: 'on-time-control', inTime: '10:00', outTime: '18:00', minutes: 480, late: 0, early: 0,
      status: 'normal', reasons: ['within_window'] },
  ] as const)('PARENT_CALC10_CORE_HTTP: legal core policy ($scenario)', async proof => {
    const fixture = await seedOrg('shadow')
    const workDate = '2026-07-01'
    const headers = { Authorization: 'Bearer ' + fixture.token }
    await pool.query("UPDATE users SET activation_status = 'activated' WHERE id = $1", [fixture.userId])
    await pool.query(
      "INSERT INTO user_permissions (user_id, permission_code) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING",
      [fixture.userId, ['attendance:read', 'attendance:write']],
    )
    const flexPolicy = { mode: 'flex_required_duration', requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60, arrivalWindowAfterMinutes: 60,
      coreStartTime: '10:00', coreEndTime: '15:00' }
    // Every permitted clamped start in [08:00,10:00] covers core [10:00,15:00].
    const created = await requestJson(baseUrl + '/api/attendance/shifts', {
      method: 'POST', headers,
      body: { name: 'Core-hours native proof', timezone: 'UTC',
        segments: [{ startTime: '09:00', endTime: '18:00' }], flexPolicy,
        lateGraceMinutes: 5, earlyGraceMinutes: 5, roundingMinutes: 1,
        workingDays: [0, 1, 2, 3, 4, 5, 6] },
    })
    expect(created.status, created.raw).toBe(201)
    expect(created.body?.data?.flexPolicy).toEqual(flexPolicy)
    const shiftId = created.body?.data?.id as string
    expect(typeof shiftId).toBe('string')
    // Native synthetic source fixture, not public assignment-write admission.
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, $4, $5::date, $5::date, true, 'published', 0)`,
      [randomUUID(), fixture.orgId, fixture.userId, shiftId, workDate],
    )
    for (const [state, prior, version] of [['eligible', 'shadow', 3], ['authoritative', 'eligible', 4]] as const) {
      await pool.query(
        'UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1',
        [fixture.orgId, state, prior, version],
      )
    }
    for (const [eventType, time] of [['check_in', proof.inTime], ['check_out', proof.outTime]] as const) {
      const response = await requestJson(baseUrl + '/api/attendance/punch', {
        method: 'POST', headers, body: { orgId: fixture.orgId, eventType,
          operationId: randomUUID(), occurredAt: workDate + 'T' + time + ':00.000Z' },
      })
      expect(response.status, 'PARENT_CALC10_CANONICAL_HTTP_200: ' + response.raw).toBe(200)
    }
    const rows = await pool.query(
      `SELECT r.id, r.work_date::text, r.current_calculation_id, r.projection_owner, r.visibility_state,
              r.status, r.work_minutes, r.late_minutes, r.early_leave_minutes,
              r.first_in_at, r.last_out_at, c.id AS calculation_id, c.mode, c.outcome, c.outcome_reason_code,
              c.entrypoint, c.projection_effect, c.expected_segment_count, c.projected_status,
              c.projected_work_minutes, c.projected_late_minutes, c.projected_early_leave_minutes,
              c.attribution_snapshot, c.context_snapshot, c.segment_snapshot
         FROM attendance_records r JOIN attendance_record_calculations c
           ON c.id = r.current_calculation_id AND c.org_id = r.org_id AND c.attendance_record_id = r.id
        WHERE r.org_id = $1 AND r.user_id = $2`,
      [fixture.orgId, fixture.userId],
    )
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]
    expect({
      workDate: row.work_date, currentIsCanonical: row.current_calculation_id === row.calculation_id,
      projectionOwner: row.projection_owner, visibility: row.visibility_state,
      status: row.status, worked: row.work_minutes, late: row.late_minutes, early: row.early_leave_minutes,
      firstIn: row.first_in_at.toISOString(), lastOut: row.last_out_at.toISOString(),
      mode: row.mode, outcome: row.outcome, reason: row.outcome_reason_code, entrypoint: row.entrypoint,
      effect: row.projection_effect, segmentCount: row.expected_segment_count,
      projectedStatus: row.projected_status, projectedWorked: row.projected_work_minutes,
      projectedLate: row.projected_late_minutes, projectedEarly: row.projected_early_leave_minutes,
    }).toEqual({
      workDate, currentIsCanonical: true, projectionOwner: 'w4', visibility: 'active',
      status: proof.status, worked: proof.minutes, late: proof.late, early: proof.early,
      firstIn: workDate + 'T' + proof.inTime + ':00.000Z', lastOut: workDate + 'T' + proof.outTime + ':00.000Z',
      mode: 'authoritative', outcome: 'completed', reason: 'calculated', entrypoint: 'live',
      effect: 'set_active', segmentCount: 1, projectedStatus: proof.status,
      projectedWorked: proof.minutes, projectedLate: proof.late, projectedEarly: proof.early,
    })
    expect(row.attribution_snapshot).toMatchObject({
      posture: 'resolved_v2', value: { orgId: fixture.orgId, userId: fixture.userId, workDate, shiftId },
    })
    expect(row.context_snapshot).toMatchObject({ selector: 'legacy', workDate, timezone: 'UTC', shiftId })
    expect(row.context_snapshot.flexPolicy).toEqual(flexPolicy)
    expect(row.context_snapshot.segments).toEqual([{ index: 0, startTime: '09:00', endTime: '18:00',
      startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 5, earlyLeaveGraceMinutes: 5 }])
    const expected = {
      segment_index: 0, expected_start_at: workDate + 'T10:00:00.000Z',
      expected_end_at: workDate + 'T18:00:00.000Z',
      actual_in_at: workDate + 'T' + proof.inTime + ':00.000Z',
      actual_out_at: workDate + 'T' + proof.outTime + ':00.000Z',
      status: proof.status, status_reasons: [...proof.reasons],
      work_minutes: proof.minutes, late_minutes: proof.late, early_leave_minutes: proof.early,
    }
    const children = await pool.query(
      `SELECT segment_index, expected_start_at, expected_end_at, actual_in_at, actual_out_at,
              status, status_reasons, work_minutes, late_minutes, early_leave_minutes
         FROM attendance_record_segments WHERE org_id = $1 AND record_id = $2 AND calculation_id = $3
        ORDER BY segment_index`, [fixture.orgId, row.id, row.calculation_id],
    )
    expect(children.rows.map(child => ({ ...child, expected_start_at: child.expected_start_at.toISOString(),
      expected_end_at: child.expected_end_at.toISOString(), actual_in_at: child.actual_in_at.toISOString(),
      actual_out_at: child.actual_out_at.toISOString() }))).toEqual([expected])
    expect(row.segment_snapshot).toHaveLength(1)
    // The immutable calculation snapshot stores authored definitions, while
    // calculated output is persisted in the canonical child rows asserted above.
    expect(row.segment_snapshot).toEqual(row.context_snapshot.segments)
    const events = await pool.query(
      'SELECT work_date::text, event_type, occurred_at FROM attendance_events WHERE org_id = $1 ORDER BY occurred_at',
      [fixture.orgId],
    )
    expect(events.rows.map(event => [event.work_date, event.event_type, event.occurred_at.toISOString()])).toEqual([
      [workDate, 'check_in', expected.actual_in_at], [workDate, 'check_out', expected.actual_out_at],
    ])
    console.log('PARENT_CALC10_CORE_HTTP_RECEIPT ' + JSON.stringify({
      scenario: proof.scenario, authoringHTTP: 201, punchHTTP: [200, 200],
      canonicalMode: row.mode, outcome: row.outcome, selector: row.context_snapshot.selector,
      exactFrozenCore: row.context_snapshot.flexPolicy.coreStartTime === '10:00'
        && row.context_snapshot.flexPolicy.coreEndTime === '15:00',
      workedMinutes: proof.minutes, lateMinutes: proof.late, earlyLeaveMinutes: proof.early,
      expectedStartAt: expected.expected_start_at, expectedEndAt: expected.expected_end_at,
      reasons: proof.reasons, canonicalChildAndParentAgree: true,
    }))
  }, 120000)

  it('replays shadow create and edit without duplicate source, snapshot, operation, or outbox rows', async () => {
    const fixture = await seedOrg('shadow')
    const createOperationId = randomUUID()
      const createBody = {
        operationId: createOperationId,
        orgId: fixture.orgId,
        workDate: '2049-08-01',
        requestType: 'missed_check_in',
        requestedInAt: '2049-08-01T09:00:00.000Z',
        reason: 'P13 create',
      }
      const headers = { Authorization: `Bearer ${fixture.token}` }
      const first = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: createBody })
      const replay = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: createBody })
      expect(first.status).toBe(201)
      expect(replay.status).toBe(201)
      expect(replay.body).toEqual(first.body)
      expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 1, operations: 1, outbox: 1 })
      expect(await createResidue(fixture.orgId, createOperationId)).toMatchObject({
        source_ref: 'plugin-attendance:POST /api/attendance/requests',
      })

      const requestId = first.body?.data?.request?.id
      const snapshot = first.body?.data?.requestSnapshot
      expect(typeof requestId).toBe('string')
      expect(snapshot).toMatchObject({ version: 1 })
      const editOperationId = randomUUID()
      const editBody = {
        operationId: editOperationId,
        reason: 'P13 edit',
        expectedSnapshotVersion: snapshot.version,
        expectedSnapshotFingerprint: snapshot.fingerprint,
      }
      const edited = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
        method: 'PUT', headers, body: editBody,
      })
      const editReplay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
        method: 'PUT', headers, body: editBody,
      })
      expect(edited.status, JSON.stringify(edited.body)).toBe(200)
      expect(editReplay.status).toBe(200)
      expect(editReplay.body).toEqual(edited.body)
    expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 2, operations: 2, outbox: 2 })
  })

  it('keeps null-ID legacy bytes while producing zero W4 rows', async () => {
    const fixture = await seedOrg('legacy')
    const response = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token}` },
        body: {
          orgId: fixture.orgId,
          workDate: '2049-08-02',
          requestType: 'missed_check_in',
          requestedInAt: '2049-08-02T09:00:00.000Z',
          reason: 'legacy create',
        },
      })
      expect(response.status).toBe(201)
      expect(response.body?.data?.request).toMatchObject({
        org_id: fixture.orgId,
        request_type: 'missed_check_in',
      })
    expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 0, operations: 0, outbox: 0 })
  })

  it('keeps stable-ID legacy replay durable without creating an outbox row', async () => {
    const fixture = await seedOrg('legacy')
    const operationId = randomUUID()
    const requestOptions = {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: {
        operationId,
        orgId: fixture.orgId,
        workDate: '2049-08-22',
        requestType: 'missed_check_in',
        requestedInAt: '2049-08-22T09:00:00.000Z',
        reason: 'legacy compatibility replay',
      },
    }
    const first = await requestJson(`${baseUrl}/api/attendance/requests`, requestOptions)
    const replay = await requestJson(`${baseUrl}/api/attendance/requests`, requestOptions)

    expect(first.status, first.raw).toBe(201)
    expect(replay.status, replay.raw).toBe(201)
    expect(replay.body).toEqual(first.body)
    expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 0, operations: 1, outbox: 0 })
  })

  it('keeps null-ID legacy decision validation bytes unchanged', async () => {
    const fixture = await seedOrg('legacy')
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${randomUUID()}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: { comment: 42 },
    })
    const legacyZodMessage = JSON.stringify([{
      code: 'invalid_type',
      expected: 'string',
      received: 'number',
      path: ['comment'],
      message: 'Expected string, received number',
    }], null, 2)
    expect(response.status).toBe(400)
    expect(response.raw).toBe(JSON.stringify({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: legacyZodMessage },
    }))
    expect(await counts(fixture.orgId)).toEqual({ requests: 0, snapshots: 0, operations: 0, outbox: 0 })
  })

  it('keeps null-ID legacy decisions tolerant of W4-only OCC fields', async () => {
    const fixture = await seedOrg('legacy')
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${randomUUID()}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: { comment: 'legacy payload', expectedApprovalVersion: 'not-an-integer' },
    })
    expect(response.status).toBe(404)
    expect(response.raw).toBe(JSON.stringify({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Request not found' },
    }))
    expect(await counts(fixture.orgId)).toEqual({ requests: 0, snapshots: 0, operations: 0, outbox: 0 })
  })

  it('blocks suspended create before request, approval, snapshot, operation, and outbox DML', async () => {
    const fixture = await seedOrg('suspended')
    const response = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token}` },
        body: {
          operationId: randomUUID(),
          orgId: fixture.orgId,
          workDate: '2049-08-03',
          requestType: 'missed_check_in',
          requestedInAt: '2049-08-03T09:00:00.000Z',
        },
      })
      expect(response.status).toBe(503)
      expect(response.body?.error?.code).toBe('SEGMENT_CALCULATION_SUSPENDED')
    expect(await counts(fixture.orgId)).toEqual({ requests: 0, snapshots: 0, operations: 0, outbox: 0 })
  })

  it('replays a shadow cancellation without duplicating source, operation, or outbox rows', async () => {
    const fixture = await seedOrg('shadow')
    const headers = { Authorization: `Bearer ${fixture.token}` }
    const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers,
      body: {
        operationId: randomUUID(),
        orgId: fixture.orgId,
        workDate: '2049-08-04',
        requestType: 'missed_check_in',
        requestedInAt: '2049-08-04T09:00:00.000Z',
        reason: 'P14 cancel replay',
      },
    })
    expect(created.status, created.raw).toBe(201)
    const requestId = created.body?.data?.request?.id
    const snapshot = created.body?.data?.requestSnapshot
    expect(typeof requestId).toBe('string')
    expect(snapshot).toMatchObject({ version: 1 })

    const cancelBody = {
      operationId: randomUUID(),
      expectedSnapshotVersion: snapshot.version,
      expectedSnapshotFingerprint: snapshot.fingerprint,
      comment: 'cancel once',
    }
    const first = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
      method: 'POST', headers, body: cancelBody,
    })
    const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
      method: 'POST', headers, body: cancelBody,
    })
    expect(first.status, first.raw).toBe(200)
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(first.body?.data).toMatchObject({ requestId, status: 'cancelled', orgId: fixture.orgId })
    expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 1, operations: 2, outbox: 2 })

    const persisted = await pool.query(
      'SELECT status, resolved_by FROM attendance_requests WHERE id = $1::uuid AND org_id = $2',
      [requestId, fixture.orgId],
    )
    expect(persisted.rows).toEqual([{ status: 'cancelled', resolved_by: fixture.userId }])
  })

  it('rolls back approved-leave cancellation when P14 has no frozen parent calculation', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests
         (id, org_id, user_id, work_date, request_type, status, reason)
       VALUES ($1::uuid, $2, $3, '2049-08-05', 'leave', 'approved', 'P14 no-parent route')`,
      [requestId, fixture.orgId, fixture.userId],
    )
    const before = await counts(fixture.orgId)
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: { operationId: randomUUID(), comment: 'must fail closed' },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error).toMatchObject({
      code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
      details: [{ field: 'calculation', message: 'record_missing' }],
    })
    expect(await counts(fixture.orgId)).toEqual(before)
    const persisted = await pool.query(
      'SELECT status, resolved_by, resolved_at FROM attendance_requests WHERE id = $1::uuid AND org_id = $2',
      [requestId, fixture.orgId],
    )
    expect(persisted.rows).toEqual([{ status: 'approved', resolved_by: null, resolved_at: null }])
  })

  it('replays a shadow reject with exact approval OCC and no duplicate decision residue', async () => {
    const fixture = await seedOrg('shadow', 'attendance:approve')
    const requestId = await createRequest(fixture, '2049-08-06')
    const approval = await loadApprovalCursor(requestId)
    await assignApprovalUser(approval, fixture.userId)
    const operationId = randomUUID()
    const body = {
      operationId,
      expectedApprovalVersion: approval.version,
      expectedApprovalNode: approval.node,
      comment: 'reject exactly once',
    }
    const headers = { Authorization: `Bearer ${fixture.token}` }
    const first = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body,
    })
    const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body,
    })
    expect(first.status, first.raw).toBe(200)
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(first.body?.data).toMatchObject({ requestId, status: 'rejected' })
    expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
      operations: 1,
      outbox: 1,
      approval_records: 1,
    })
  })

  it('fails closed on missing OCC, incongruent replay, and a new operation after resolution', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = await createRequest(fixture, '2049-08-07')
    const approval = await loadApprovalCursor(requestId)
    const headers = { Authorization: `Bearer ${fixture.token}` }

    const missingOccOperationId = randomUUID()
    const missingOcc = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers,
      body: { operationId: missingOccOperationId, comment: 'missing OCC' },
    })
    expect(missingOcc.status, missingOcc.raw).toBe(400)
    expect(missingOcc.body?.error?.code).toBe('REQUEST_DECISION_OCC_REQUIRED')
    expect(await requestDecisionResidue(fixture.orgId, requestId, missingOccOperationId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })

    const operationId = randomUUID()
    const acceptedBody = {
      operationId,
      expectedApprovalVersion: approval.version,
      expectedApprovalNode: approval.node,
      comment: 'accepted command',
    }
    const accepted = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body: acceptedBody,
    })
    expect(accepted.status, accepted.raw).toBe(200)

    const conflict = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers,
      body: { ...acceptedBody, comment: 'different command' },
    })
    expect(conflict.status, conflict.raw).toBe(409)
    expect(conflict.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')

    const resolvedRetry = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers,
      body: {
        ...acceptedBody,
        operationId: randomUUID(),
      },
    })
    expect(resolvedRetry.status, resolvedRetry.raw).toBe(400)
    expect(resolvedRetry.body?.error?.code).toBe('INVALID_STATUS')
    expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
      operations: 1,
      outbox: 1,
      approval_records: 1,
    })
  })

  it('rejects a durable actor without active org membership before decision DML', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = await createRequest(fixture, '2049-08-08')
    const approval = await loadApprovalCursor(requestId)
    const outsiderId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'W4C-3b outsider', 'x', 'user', '["attendance:approve"]'::jsonb,
               TRUE, FALSE, 'activated')`,
      [outsiderId, `w4c3b-outsider-${outsiderId}@example.test`],
    )
    await assignApprovalUser(approval, outsiderId)
    const outsiderToken = await mintToken(outsiderId)
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsiderToken}` },
      body: {
        operationId,
        expectedApprovalVersion: approval.version,
        expectedApprovalNode: approval.node,
        comment: 'cross-org attempt',
      },
    })
    expect(response.status, response.raw).toBe(403)
    expect(response.body?.error?.code).toBe('FORBIDDEN')
    expect(await requestDecisionResidue(fixture.orgId, requestId, operationId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })
  })

  it('accepts only the DB-backed platform-admin posture as the cross-org override', async () => {
    const fixture = await seedOrg('shadow')

    const impostorRequestId = await createRequest(fixture, '2049-08-14')
    const impostorApproval = await loadApprovalCursor(impostorRequestId)
    const impostorId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'W4C-3b marker-only admin', 'x', 'admin', '["attendance:approve"]'::jsonb,
               TRUE, TRUE, 'activated')`,
      [impostorId, `w4c3b-marker-admin-${impostorId}@example.test`],
    )
    await assignApprovalUser(impostorApproval, impostorId)
    const impostorOperationId = randomUUID()
    const impostorResponse = await requestJson(
      `${baseUrl}/api/attendance/requests/${impostorRequestId}/reject`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await mintToken(impostorId)}` },
        body: {
          operationId: impostorOperationId,
          expectedApprovalVersion: impostorApproval.version,
          expectedApprovalNode: impostorApproval.node,
          comment: 'marker-only admin must not cross orgs',
        },
      },
    )
    expect(impostorResponse.status, impostorResponse.raw).toBe(403)
    expect(impostorResponse.body?.error?.code).toBe('FORBIDDEN')
    expect(await requestDecisionResidue(fixture.orgId, impostorRequestId, impostorOperationId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })

    const platformRequestId = await createRequest(fixture, '2049-08-15')
    const platformApproval = await loadApprovalCursor(platformRequestId)
    const platformAdminId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'W4C-3b platform admin', 'x', 'user', '[]'::jsonb,
               TRUE, FALSE, 'activated')`,
      [platformAdminId, `w4c3b-platform-admin-${platformAdminId}@example.test`],
    )
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')",
      [platformAdminId],
    )
    const platformOperationId = randomUUID()
    const platformResponse = await requestJson(
      `${baseUrl}/api/attendance/requests/${platformRequestId}/reject`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await mintToken(platformAdminId)}` },
        body: {
          operationId: platformOperationId,
          expectedApprovalVersion: platformApproval.version,
          expectedApprovalNode: platformApproval.node,
          comment: 'DB-backed platform admin override',
        },
      },
    )
    expect(platformResponse.status, platformResponse.raw).toBe(200)
    expect(platformResponse.body?.data).toMatchObject({ requestId: platformRequestId, status: 'rejected' })
    expect(await requestDecisionResidue(fixture.orgId, platformRequestId, platformOperationId)).toEqual({
      operations: 1,
      outbox: 1,
      approval_records: 1,
    })
  })

  it('rejects an active same-org approver who is not assigned before decision DML', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = await createRequest(fixture, '2049-08-09')
    const approval = await loadApprovalCursor(requestId)
    const unassigned = await seedOrgActor(fixture.orgId, 'attendance:approve')
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unassigned.token}` },
      body: {
        operationId,
        expectedApprovalVersion: approval.version,
        expectedApprovalNode: approval.node,
        comment: 'same-org unassigned attempt',
      },
    })
    expect(response.status, response.raw).toBe(403)
    expect(response.body?.error?.code).toBe('FORBIDDEN')
    expect(await requestDecisionResidue(fixture.orgId, requestId, operationId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })
  })

  it('fails closed when frozen flow metadata disagrees with the locked approval step', async () => {
    const fixture = await seedOrg('shadow', 'attendance:approve')
    const requestId = await createRequest(fixture, '2049-08-12')
    const approval = await loadApprovalCursor(requestId)
    await pool.query(
      `UPDATE attendance_requests
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{approvalFlow}',
            $2::jsonb,
            TRUE
          )
        WHERE id = $1::uuid`,
      [requestId, JSON.stringify({
        steps: [
          { name: 'locked-step-zero', approverUserIds: ['someone-else'] },
          { name: 'forged-step-one', approverUserIds: [fixture.userId] },
        ],
        currentStep: 1,
      })],
    )
    await pool.query('DELETE FROM approval_assignments WHERE instance_id = $1', [approval.approvalId])
    await pool.query(
      `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata)
       VALUES ($1, 'user', $2, 'attendance_request_step_1', 1, TRUE, '{}'::jsonb)`,
      [approval.approvalId, fixture.userId],
    )
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: {
        operationId,
        expectedApprovalVersion: approval.version,
        expectedApprovalNode: approval.node,
      },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error?.code).toBe('APPROVAL_FLOW_STATE_CONFLICT')
    expect(await requestDecisionResidue(fixture.orgId, requestId, operationId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })
    const unchanged = await pool.query(
      `SELECT ar.status AS request_status,
              ai.status AS approval_status,
              ai.version AS approval_version,
              ai.current_step,
              ai.current_node_key,
              count(aa.id) FILTER (WHERE aa.is_active = TRUE)::int AS active_assignments
         FROM attendance_requests ar
         JOIN approval_instances ai ON ai.id = ar.approval_instance_id
         LEFT JOIN approval_assignments aa ON aa.instance_id = ai.id
        WHERE ar.id = $1::uuid
        GROUP BY ar.status, ai.status, ai.version, ai.current_step, ai.current_node_key`,
      [requestId],
    )
    expect(unchanged.rows).toEqual([{
      request_status: 'pending',
      approval_status: 'pending',
      approval_version: approval.version,
      current_step: 0,
      current_node_key: approval.node,
      active_assignments: 1,
    }])
  })

  it('replays a scope-native dispatch decision after its mutable scheduler scope is revoked', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = await createRequest(fixture, '2049-08-13')
    const approval = await loadApprovalCursor(requestId)
    const scheduler = await seedOrgActor(fixture.orgId, 'attendance:read')
    const attendanceGroupId = randomUUID()
    const scheduleGroupId = randomUUID()
    const shiftId = randomUUID()
    const departmentRef = `w4c3b-dept-${requestId}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, code, timezone)
       VALUES ($1, $2, $3, $4, 'UTC')`,
      [attendanceGroupId, fixture.orgId, `w4c3b-${requestId}`, `w4-${requestId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO attendance_schedule_groups
         (id, org_id, name, code, attendance_group_id, department_ref, source, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', TRUE)`,
      [scheduleGroupId, fixture.orgId, `w4c3b-${requestId}`, `sg-${requestId.slice(0, 8)}`, attendanceGroupId, departmentRef],
    )
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
       VALUES ($1, $2, $3, '09:00', '18:00')`,
      [shiftId, fixture.orgId, `w4c3b-${requestId}`],
    )
    await pool.query(
      `UPDATE attendance_requests
          SET request_type = 'schedule_dispatch',
              metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{approvalFlow}', $2::jsonb, TRUE)
        WHERE id = $1::uuid`,
      [requestId, JSON.stringify({ steps: [], currentStep: 0 })],
    )
    await pool.query(
      `INSERT INTO attendance_schedule_dispatch_requests
         (request_id, org_id, user_id, target_schedule_group_id, target_shift_id,
          start_date, end_date, source_key)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, '2049-08-13', '2049-08-13', $6)`,
      [requestId, fixture.orgId, fixture.userId, scheduleGroupId, shiftId, `w4c3b-dispatch:${requestId}`],
    )
    for (const [actions, scope] of [
      [['approve'], { userIds: [fixture.userId] }],
      [['dispatch'], {
        userIds: [fixture.userId],
        scheduleGroupIds: [scheduleGroupId],
        departments: [departmentRef],
      }],
    ] as const) {
      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
           (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1::uuid, $2, 'user', $3, $4::text[], $5::jsonb, TRUE, $3, $3)`,
        [randomUUID(), fixture.orgId, scheduler.userId, actions, JSON.stringify(scope)],
      )
    }

    const operationId = randomUUID()
    const body = {
      operationId,
      expectedApprovalVersion: approval.version,
      expectedApprovalNode: approval.node,
      comment: 'scope-native durable replay',
    }
    const headers = { Authorization: `Bearer ${scheduler.token}` }
    const first = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body,
    })
    expect(first.status, first.raw).toBe(200)
    await pool.query(
      `UPDATE attendance_scheduler_scopes
          SET is_active = FALSE
        WHERE org_id = $1 AND subject_type = 'user' AND subject_ref = $2`,
      [fixture.orgId, scheduler.userId],
    )
    const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body,
    })
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(await requestDecisionResidue(fixture.orgId, requestId, operationId)).toEqual({
      operations: 1,
      outbox: 1,
      approval_records: 1,
    })
  })

  it('keeps central and plugin approve/reject paths single-bodied in both sequential orders', async () => {
    let dateOffset = 14
    for (const action of ['approve', 'reject'] as const) {
      for (const order of ['central-first', 'plugin-first'] as const) {
      const fixture = await seedOrg('shadow', 'attendance:approve')
      const requestId = await createRequest(
        fixture,
        `2049-08-${dateOffset++}`,
      )
      const approval = await loadApprovalCursor(requestId)
      await assignApprovalUser(approval, fixture.userId)
      const headers = { Authorization: `Bearer ${fixture.token}` }
      const body = {
        operationId: randomUUID(),
        expectedApprovalVersion: approval.version,
        expectedApprovalNode: approval.node,
        comment: `${order} plugin ${action}`,
      }
      const pluginDecision = () => requestJson(
        `${baseUrl}/api/attendance/requests/${requestId}/${action}`,
        { method: 'POST', headers, body },
      )

      if (order === 'central-first') {
        await expect(
          dispatchCentralDecision(approval.approvalId, fixture.userId, action),
        ).rejects.toMatchObject({
          code: 'ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED',
          statusCode: 409,
        })
        expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
          operations: 0,
          outbox: 0,
          approval_records: 0,
        })
        const response = await pluginDecision()
        expect(response.status, response.raw).toBe(200)
      } else {
        const response = await pluginDecision()
        expect(response.status, response.raw).toBe(200)
        await expect(
          dispatchCentralDecision(approval.approvalId, fixture.userId, action),
        ).rejects.toMatchObject({
          code: 'INVALID_STATUS_TRANSITION',
          statusCode: 409,
        })
      }

      expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
        operations: 1,
        outbox: 1,
        approval_records: 1,
      })
      const terminal = await pool.query(
        `SELECT ar.status AS request_status,
                ai.status AS approval_status,
                ai.version AS approval_version,
                count(aa.id) FILTER (WHERE aa.is_active = TRUE)::int AS active_assignments
           FROM attendance_requests ar
           JOIN approval_instances ai ON ai.id = ar.approval_instance_id
           LEFT JOIN approval_assignments aa ON aa.instance_id = ai.id
          WHERE ar.id = $1::uuid AND ar.org_id = $2
          GROUP BY ar.status, ai.status, ai.version`,
        [requestId, fixture.orgId],
      )
      expect(terminal.rows).toEqual([{
        request_status: action === 'approve' ? 'approved' : 'rejected',
        approval_status: action === 'approve' ? 'approved' : 'rejected',
        approval_version: approval.version + 1,
        active_assignments: 0,
      }])
      }
    }
  })

  async function createResidue(orgId: string, operationId: string | null = null) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1) AS requests,
         (SELECT count(*)::int FROM attendance_request_calculation_snapshots WHERE org_id = $1) AS snapshots,
         (SELECT count(*)::int FROM attendance_schedule_dispatch_requests WHERE org_id = $1) AS schedule_dispatch,
         (SELECT count(*)::int FROM attendance_shift_swap_requests WHERE org_id = $1) AS shift_swap,
         (SELECT count(*)::int FROM approval_instances
           WHERE metadata ->> 'orgId' = $1) AS approval_instances,
         (SELECT count(*)::int FROM approval_assignments aa
           JOIN approval_instances ai ON ai.id = aa.instance_id
          WHERE ai.metadata ->> 'orgId' = $1) AS approval_assignments,
         (SELECT count(*)::int FROM approval_records ar
           JOIN approval_instances ai ON ai.id = ar.instance_id
          WHERE ai.metadata ->> 'orgId' = $1) AS approval_records,
         (SELECT count(*)::int FROM attendance_events WHERE org_id = $1) AS attendance_events,
         (SELECT count(*)::int FROM attendance_records WHERE org_id = $1) AS attendance_records,
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1
             AND entrypoint = 'request_create'
             AND ($2::uuid IS NULL OR operation_id = $2::uuid)) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1
             AND entrypoint = 'request_create'
             AND ($2::uuid IS NULL OR operation_id = $2::uuid)) AS outbox,
         (SELECT source_ref FROM attendance_result_operations
           WHERE org_id = $1 AND entrypoint = 'request_create'
             AND ($2::uuid IS NULL OR operation_id = $2::uuid)
           ORDER BY created_at DESC NULLS LAST
           LIMIT 1) AS source_ref`,
      [orgId, operationId],
    )
    return result.rows[0] as {
      requests: number
      snapshots: number
      schedule_dispatch: number
      shift_swap: number
      approval_instances: number
      approval_assignments: number
      approval_records: number
      attendance_events: number
      attendance_records: number
      operations: number
      outbox: number
      source_ref: string | null
    }
  }

  async function seedOutdoorFlow(orgId: string, token: string) {
    const flowId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_approval_flows
         (id, org_id, name, request_type, steps, is_active)
       VALUES ($1::uuid, $2, 'W4C-3b outdoor flow', 'outdoor_punch', '[]'::jsonb, TRUE)`,
      [flowId, orgId],
    )
    const settings = await requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: {
        punchPolicy: {
          outdoor: {
            requireApproval: true,
            requireNote: false,
            requirePhoto: false,
            approvalFlowId: flowId,
          },
        },
        geoFence: { enabled: true, lat: 31.23, lng: 121.47, radiusMeters: 100 },
      },
    })
    expect(settings.status, settings.raw).toBe(200)
    return flowId
  }

  async function seedScheduleDispatchTargets(orgId: string, actorId: string) {
    const attendanceGroupId = randomUUID()
    const scheduleGroupId = randomUUID()
    const shiftId = randomUUID()
    const flowId = randomUUID()
    const subjectUserId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'dispatch subject', 'x', 'user', '[]'::jsonb, TRUE, FALSE, 'activated')`,
      [subjectUserId, `w4c3b-dispatch-subject-${subjectUserId}@example.test`],
    )
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [subjectUserId, orgId])
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, code, timezone)
       VALUES ($1::uuid, $2, 'w4c3b-ag', 'w4c3b-ag', 'UTC')`,
      [attendanceGroupId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_schedule_groups
         (id, org_id, name, code, attendance_group_id, department_ref, source, is_active)
       VALUES ($1::uuid, $2, 'w4c3b-sg', 'w4c3b-sg', $3::uuid, 'w4c3b-dept', 'manual', TRUE)`,
      [scheduleGroupId, orgId, attendanceGroupId],
    )
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
       VALUES ($1::uuid, $2, 'w4c3b-shift', '09:00', '18:00')`,
      [shiftId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_approval_flows
         (id, org_id, name, request_type, steps, is_active)
       VALUES ($1::uuid, $2, 'w4c3b-dispatch-flow', 'schedule_dispatch', '[]'::jsonb, TRUE)`,
      [flowId, orgId],
    )
    // Full attendance admin on actor covers dispatch authorization in these fixtures.
    await pool.query(
      `UPDATE users SET permissions = $2::jsonb WHERE id = $1`,
      [actorId, JSON.stringify(['attendance:admin', 'attendance:write', 'attendance:read', 'attendance:approve'])],
    )
    return { subjectUserId, scheduleGroupId, shiftId, flowId }
  }

  async function seedShiftSwapPair(orgId: string, actorId: string) {
    const counterpartyId = randomUUID()
    const shiftA = randomUUID()
    const shiftB = randomUUID()
    const assignmentA = randomUUID()
    const assignmentB = randomUUID()
    const flowId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'swap counterparty', 'x', 'user', '[]'::jsonb, TRUE, FALSE, 'activated')`,
      [counterpartyId, `w4c3b-swap-cp-${counterpartyId}@example.test`],
    )
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [counterpartyId, orgId])
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
       VALUES ($1::uuid, $3, 'swap-a', '09:00', '18:00'),
              ($2::uuid, $3, 'swap-b', '10:00', '19:00')`,
      [shiftA, shiftB, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status,
          assignment_kind, slot_index)
       VALUES
         ($1::uuid, $3, $4, $5::uuid, '2049-09-01', '2049-09-01', TRUE, 'published', 'regular', 0),
         ($2::uuid, $3, $6, $7::uuid, '2049-09-02', '2049-09-02', TRUE, 'published', 'regular', 0)`,
      [assignmentA, assignmentB, orgId, actorId, shiftA, counterpartyId, shiftB],
    )
    await pool.query(
      `INSERT INTO attendance_approval_flows
         (id, org_id, name, request_type, steps, is_active)
       VALUES ($1::uuid, $2, 'w4c3b-swap-flow', 'shift_swap', '[]'::jsonb, TRUE)`,
      [flowId, orgId],
    )
    return { counterpartyId, assignmentA, assignmentB, flowId }
  }

  it('P13 create families: outdoor/schedule_dispatch/shift_swap shadow success with exact source_ref', async () => {
    // Outdoor
    {
      const fixture = await seedOrg('shadow')
      const flowId = await seedOutdoorFlow(fixture.orgId, fixture.token)
      const operationId = randomUUID()
      const requestOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          operationId,
          orgId: fixture.orgId,
          eventType: 'check_in',
          occurredAt: '2020-09-10T01:00:00.000Z',
          timezone: 'UTC',
          source: 'mobile',
          location: { lat: 0, lng: 0 },
          meta: { outdoor: true, note: 'field' },
        },
      }
      const punch = await requestJson(`${baseUrl}/api/attendance/punch`, requestOptions)
      await pool.query('UPDATE attendance_approval_flows SET is_active = FALSE WHERE id = $1::uuid', [flowId])
      const replay = await requestJson(`${baseUrl}/api/attendance/punch`, requestOptions)
      expect(punch.status, punch.raw).toBe(202)
      expect(replay.status, replay.raw).toBe(202)
      expect(replay.body).toEqual(punch.body)
      expect(punch.body?.data?.pendingApproval).toBe(true)
      const pairedReceipts = await pool.query(
        `SELECT entrypoint, identity_source_kind, state, source_ref, response_snapshot,
                normalized_business_input_snapshot FROM attendance_result_operations
         WHERE org_id=$1 AND operation_id=$2::uuid ORDER BY entrypoint`, [fixture.orgId, operationId],
      )
      expect(pairedReceipts.rows).toEqual([
        { entrypoint: 'live_punch', identity_source_kind: 'direct_live_punch', state: 'completed',
          source_ref: 'plugin-attendance:POST /api/attendance/punch:online-v1', normalized_business_input_snapshot: null,
          response_snapshot: { version: 'attendance-online-punch-v1', status: 202, body: punch.body } },
        { entrypoint: 'request_create', identity_source_kind: 'direct_request_create', state: 'completed',
          source_ref: 'plugin-attendance:POST /api/attendance/punch#outdoor-approval',
          normalized_business_input_snapshot: expect.any(Object), response_snapshot: punch.body },
      ])
      const residue = await createResidue(fixture.orgId, operationId)
      expect(residue).toMatchObject({
        requests: 1,
        snapshots: 1,
        approval_instances: 1,
        approval_assignments: 3,
        approval_records: 0,
        attendance_events: 0,
        attendance_records: 0,
        operations: 1,
        outbox: 1,
        source_ref: 'plugin-attendance:POST /api/attendance/punch#outdoor-approval',
      })
    }

    // Schedule dispatch
    {
      const fixture = await seedOrg('shadow')
      const targets = await seedScheduleDispatchTargets(fixture.orgId, fixture.userId)
      const token = await mintToken(fixture.userId, fixture.orgId)
      const operationId = randomUUID()
      const requestOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          operationId,
          userId: targets.subjectUserId,
          targetScheduleGroupId: targets.scheduleGroupId,
          targetShiftId: targets.shiftId,
          startDate: '2049-09-11',
          endDate: '2049-09-11',
          approvalFlowId: targets.flowId,
          reason: 'dispatch shadow',
        },
      }
      const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, requestOptions)
      await pool.query('UPDATE attendance_schedule_groups SET is_active = FALSE WHERE id = $1::uuid', [targets.scheduleGroupId])
      const replay = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, requestOptions)
      expect(create.status, create.raw).toBe(201)
      expect(replay.status, replay.raw).toBe(201)
      expect(replay.body).toEqual(create.body)
      const residue = await createResidue(fixture.orgId, operationId)
      expect(residue).toMatchObject({
        requests: 1,
        snapshots: 1,
        schedule_dispatch: 1,
        approval_instances: 1,
        approval_assignments: 3,
        approval_records: 0,
        attendance_events: 0,
        attendance_records: 0,
        operations: 1,
        outbox: 1,
        source_ref: 'plugin-attendance:POST /api/attendance/schedule-dispatch-requests',
      })
    }

    // Shift swap
    {
      const fixture = await seedOrg('shadow')
      const requester = await seedOrgActor(fixture.orgId, 'attendance:write')
      const pair = await seedShiftSwapPair(fixture.orgId, requester.userId)
      const operationId = randomUUID()
      const requestOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          operationId,
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
          approvalFlowId: pair.flowId,
          reason: 'swap shadow',
        },
      }
      const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, requestOptions)
      await pool.query('UPDATE attendance_approval_flows SET is_active = FALSE WHERE id = $1::uuid', [pair.flowId])
      await pool.query(
        'UPDATE attendance_shift_assignments SET user_id = $2 WHERE id = $1::uuid AND org_id = $3',
        [pair.assignmentA, fixture.userId, fixture.orgId],
      )
      const replay = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, requestOptions)
      expect(create.status, create.raw).toBe(201)
      expect(replay.status, replay.raw).toBe(201)
      expect(replay.body).toEqual(create.body)
      const residue = await createResidue(fixture.orgId, operationId)
      expect(residue).toMatchObject({
        requests: 1,
        snapshots: 1,
        shift_swap: 1,
        approval_instances: 1,
        approval_assignments: 3,
        approval_records: 0,
        attendance_events: 0,
        attendance_records: 0,
        operations: 1,
        outbox: 1,
        source_ref: 'plugin-attendance:POST /api/attendance/shift-swap-requests',
      })
      const durableIdentity = await pool.query(
        `SELECT actor_id, actor_posture, subject_scope
           FROM attendance_result_operations
          WHERE org_id = $1 AND entrypoint = 'request_create' AND operation_id = $2::uuid`,
        [fixture.orgId, operationId],
      )
      expect(durableIdentity.rows).toEqual([{
        actor_id: fixture.userId,
        actor_posture: 'attendance_admin',
        subject_scope: { kind: 'explicit_users', userIds: [requester.userId] },
      }])
      const persistedRequest = await pool.query(
        `SELECT user_id FROM attendance_requests
          WHERE org_id = $1 AND request_type = 'shift_swap'`,
        [fixture.orgId],
      )
      expect(persistedRequest.rows).toEqual([{ user_id: requester.userId }])
    }
  })

  it('P13 specialized routes: dispatch cancel and shift-swap consent/cancel are replayable boundary writes', async () => {
    // Schedule-dispatch cancel.
    {
      const fixture = await seedOrg('shadow')
      const targets = await seedScheduleDispatchTargets(fixture.orgId, fixture.userId)
      const token = await mintToken(fixture.userId, fixture.orgId)
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-org-id': fixture.orgId,
      }
      const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST', headers, body: {
          operationId: randomUUID(),
          userId: targets.subjectUserId,
          targetScheduleGroupId: targets.scheduleGroupId,
          targetShiftId: targets.shiftId,
          startDate: '2049-09-20',
          endDate: '2049-09-20',
          approvalFlowId: targets.flowId,
        },
      })
      expect(create.status, create.raw).toBe(201)
      const requestId = create.body?.data?.request?.id
      const operationId = randomUUID()
      const options = { method: 'POST', headers, body: { operationId } }
      const first = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${requestId}/cancel`, options)
      const replay = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${requestId}/cancel`, options)
      expect(first.status, first.raw).toBe(200)
      expect(replay.status, replay.raw).toBe(200)
      expect(replay.body).toEqual(first.body)
      expect(first.body?.data?.scheduleDispatch).toMatchObject({ publishStatus: 'cancelled' })
      expect(await operationResidue(fixture.orgId, operationId, 'request_cancel')).toMatchObject({
        operations: 1,
        outbox: 1,
        source_ref: 'plugin-attendance:POST /api/attendance/schedule-dispatch-requests/:id/cancel',
      })
    }

    // Shift-swap counterparty consent.
    {
      const fixture = await seedOrg('shadow')
      const pair = await seedShiftSwapPair(fixture.orgId, fixture.userId)
      const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          operationId: randomUUID(),
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
          approvalFlowId: pair.flowId,
        },
      })
      expect(create.status, create.raw).toBe(201)
      const requestId = create.body?.data?.request?.id
      const operationId = randomUUID()
      const headers = {
        Authorization: `Bearer ${await mintToken(pair.counterpartyId, fixture.orgId)}`,
        'Content-Type': 'application/json',
        'x-org-id': fixture.orgId,
      }
      const options = { method: 'POST', headers, body: { operationId } }
      const first = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/accept`, options)
      const replay = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/accept`, options)
      expect(first.status, first.raw).toBe(200)
      expect(replay.status, replay.raw).toBe(200)
      expect(replay.body).toEqual(first.body)
      expect(first.body?.data?.shiftSwap).toMatchObject({ counterpartyStatus: 'accepted' })
      expect(await operationResidue(fixture.orgId, operationId, 'request_decision')).toMatchObject({
        operations: 1,
        outbox: 1,
        source_ref: 'plugin-attendance:POST /api/attendance/shift-swap-requests/:id/accept',
      })
    }

    // Shift-swap cancel.
    {
      const fixture = await seedOrg('shadow')
      const pair = await seedShiftSwapPair(fixture.orgId, fixture.userId)
      const headers = {
        Authorization: `Bearer ${fixture.token}`,
        'Content-Type': 'application/json',
        'x-org-id': fixture.orgId,
      }
      const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST', headers, body: {
          operationId: randomUUID(),
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
          approvalFlowId: pair.flowId,
        },
      })
      expect(create.status, create.raw).toBe(201)
      const requestId = create.body?.data?.request?.id
      const operationId = randomUUID()
      const options = { method: 'POST', headers, body: { operationId } }
      const first = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/cancel`, options)
      const replay = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/cancel`, options)
      expect(first.status, first.raw).toBe(200)
      expect(replay.status, replay.raw).toBe(200)
      expect(replay.body).toEqual(first.body)
      expect(first.body?.data?.shiftSwap).toMatchObject({ requestStatus: 'cancelled' })
      expect(await operationResidue(fixture.orgId, operationId, 'request_cancel')).toMatchObject({
        operations: 1,
        outbox: 1,
        source_ref: 'plugin-attendance:POST /api/attendance/shift-swap-requests/:id/cancel',
      })
    }
  })

  it('P13 cancellation scope: approved non-leave requests fail before durable boundary residue', async () => {
    const requestTypes = ['overtime', 'time_correction', 'outdoor_punch']
    for (const requestType of requestTypes) {
      const fixture = await seedOrg('shadow')
      const requestId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_requests
           (id, org_id, user_id, work_date, request_type, status, reason)
         VALUES ($1::uuid, $2, $3, '2049-09-21', $4, 'approved', 'P13 approved non-leave scope')`,
        [requestId, fixture.orgId, fixture.userId, requestType],
      )
      const before = await counts(fixture.orgId)
      const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
        body: { operationId: randomUUID(), comment: 'approved non-leave must remain terminal' },
      })
      expect(response.status, `${requestType}: ${response.raw}`).toBe(400)
      expect(response.body?.error?.code).toBe('INVALID_STATUS')
      expect(await counts(fixture.orgId)).toEqual(before)
      const persisted = await pool.query(
        'SELECT status, resolved_by, resolved_at FROM attendance_requests WHERE id = $1::uuid AND org_id = $2',
        [requestId, fixture.orgId],
      )
      expect(persisted.rows).toEqual([{ status: 'approved', resolved_by: null, resolved_at: null }])
    }

    const specializedCases = [
      {
        kind: 'schedule_dispatch',
        create: async (fixture: Awaited<ReturnType<typeof seedOrg>>) => {
          const targets = await seedScheduleDispatchTargets(fixture.orgId, fixture.userId)
          const response = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixture.token}`,
              'Content-Type': 'application/json',
              'x-org-id': fixture.orgId,
            },
            body: {
              operationId: randomUUID(),
              userId: targets.subjectUserId,
              targetScheduleGroupId: targets.scheduleGroupId,
              targetShiftId: targets.shiftId,
              startDate: '2049-09-22',
              endDate: '2049-09-22',
              approvalFlowId: targets.flowId,
            },
          })
          return { response, path: 'schedule-dispatch-requests' }
        },
      },
      {
        kind: 'shift_swap',
        create: async (fixture: Awaited<ReturnType<typeof seedOrg>>) => {
          const pair = await seedShiftSwapPair(fixture.orgId, fixture.userId)
          const response = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixture.token}`,
              'Content-Type': 'application/json',
              'x-org-id': fixture.orgId,
            },
            body: {
              operationId: randomUUID(),
              requesterAssignmentId: pair.assignmentA,
              counterpartyAssignmentId: pair.assignmentB,
              approvalFlowId: pair.flowId,
            },
          })
          return { response, path: 'shift-swap-requests' }
        },
      },
    ]
    for (const specialized of specializedCases) {
      const fixture = await seedOrg('shadow')
      const { response: created, path: routePath } = await specialized.create(fixture)
      expect(created.status, created.raw).toBe(201)
      const requestId = created.body?.data?.request?.id
      await pool.query(
        `UPDATE attendance_requests
            SET status = 'approved'
          WHERE id = $1::uuid AND org_id = $2`,
        [requestId, fixture.orgId],
      )
      const before = await counts(fixture.orgId)
      const response = await requestJson(`${baseUrl}/api/attendance/${routePath}/${requestId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: { operationId: randomUUID() },
      })
      expect(response.status, `${specialized.kind}: ${response.raw}`).toBe(400)
      expect(response.body?.error?.code).toBe('INVALID_STATUS')
      expect(await counts(fixture.orgId)).toEqual(before)
      const persisted = await pool.query(
        'SELECT status, resolved_by, resolved_at FROM attendance_requests WHERE id = $1::uuid AND org_id = $2',
        [requestId, fixture.orgId],
      )
      expect(persisted.rows).toEqual([{ status: 'approved', resolved_by: null, resolved_at: null }])
    }
  })

  it('P13 specialized routes: spoofed org fails before operation, outbox, or source mutation', async () => {
    const owner = await seedOrg('shadow')
    const attacker = await seedOrg('shadow')
    const pair = await seedShiftSwapPair(owner.orgId, owner.userId)
    const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
        'x-org-id': owner.orgId,
      },
      body: {
        operationId: randomUUID(),
        requesterAssignmentId: pair.assignmentA,
        counterpartyAssignmentId: pair.assignmentB,
        approvalFlowId: pair.flowId,
      },
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body?.data?.request?.id
    const beforeOwner = await counts(owner.orgId)
    const beforeAttacker = await counts(attacker.orgId)
    const response = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${attacker.token}`,
        'Content-Type': 'application/json',
        'x-org-id': attacker.orgId,
      },
      body: { operationId: randomUUID() },
    })
    expect(response.status, response.raw).toBe(404)
    expect(response.body?.error?.code).toBe('NOT_FOUND')
    expect(await counts(owner.orgId)).toEqual(beforeOwner)
    expect(await counts(attacker.orgId)).toEqual(beforeAttacker)
    const detail = await pool.query(
      `SELECT ar.status, swap.source_key
         FROM attendance_requests ar
         JOIN attendance_shift_swap_requests swap ON swap.request_id = ar.id
        WHERE ar.id = $1::uuid AND ar.org_id = $2`,
      [requestId, owner.orgId],
    )
    expect(detail.rows).toEqual([{ status: 'pending', source_key: expect.any(String) }])
  })

  it('P13 create families: missing operationId on W4 org fails closed with zero source/shared residue', async () => {
    // Outdoor missing-ID on shadow fails closed
    {
      const fixture = await seedOrg('shadow')
      await seedOutdoorFlow(fixture.orgId, fixture.token)
      const before = await createResidue(fixture.orgId)
      const punch = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          orgId: fixture.orgId,
          eventType: 'check_in',
          occurredAt: '2020-09-12T01:00:00.000Z',
          timezone: 'UTC',
          source: 'mobile',
          location: { lat: 0, lng: 0 },
          meta: { outdoor: true, note: 'no-id' },
        },
      })
      expect(punch.status, punch.raw).toBe(422)
      expect(punch.body?.error?.code).toBe('W4C0_OPERATION_ID_REQUIRED')
      expect(await createResidue(fixture.orgId)).toEqual(before)
    }

    // Schedule dispatch missing-ID
    {
      const fixture = await seedOrg('shadow')
      const targets = await seedScheduleDispatchTargets(fixture.orgId, fixture.userId)
      const token = await mintToken(fixture.userId, fixture.orgId)
      const before = await createResidue(fixture.orgId)
      const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          userId: targets.subjectUserId,
          targetScheduleGroupId: targets.scheduleGroupId,
          targetShiftId: targets.shiftId,
          startDate: '2049-09-13',
          endDate: '2049-09-13',
          approvalFlowId: targets.flowId,
        },
      })
      expect(create.status, create.raw).toBe(422)
      expect(create.body?.error?.code).toBe('W4C0_OPERATION_ID_REQUIRED')
      expect(await createResidue(fixture.orgId)).toEqual(before)
    }

    // Shift swap missing-ID
    {
      const fixture = await seedOrg('shadow')
      const pair = await seedShiftSwapPair(fixture.orgId, fixture.userId)
      const before = await createResidue(fixture.orgId)
      const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
          approvalFlowId: pair.flowId,
        },
      })
      expect(create.status, create.raw).toBe(422)
      expect(create.body?.error?.code).toBe('W4C0_OPERATION_ID_REQUIRED')
      expect(await createResidue(fixture.orgId)).toEqual(before)
    }
  })

  it('P13 create families: legacy null-ID preserves zero W4 operation/outbox rows', async () => {
    {
      const fixture = await seedOrg('legacy')
      await seedOutdoorFlow(fixture.orgId, fixture.token)
      const punch = await requestJson(`${baseUrl}/api/attendance/punch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          orgId: fixture.orgId,
          eventType: 'check_out',
          occurredAt: '2020-09-14T10:00:00.000Z',
          timezone: 'UTC',
          source: 'mobile',
          location: { lat: 0, lng: 0 },
          meta: { outdoor: true, note: 'legacy outdoor' },
        },
      })
      expect(punch.status, punch.raw).toBe(202)
      expect(punch.body?.data?.pendingApproval).toBe(true)
      expect(Object.keys(punch.body ?? {})).toEqual(['ok', 'data'])
      expect(Object.keys(punch.body?.data ?? {})).toEqual(['pendingApproval', 'request'])
      expect(await createResidue(fixture.orgId)).toMatchObject({
        requests: 1,
        snapshots: 0,
        operations: 0,
        outbox: 0,
      })
    }

    {
      const fixture = await seedOrg('legacy')
      const targets = await seedScheduleDispatchTargets(fixture.orgId, fixture.userId)
      const token = await mintToken(fixture.userId, fixture.orgId)
      const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          userId: targets.subjectUserId,
          targetScheduleGroupId: targets.scheduleGroupId,
          targetShiftId: targets.shiftId,
          startDate: '2049-09-15',
          endDate: '2049-09-15',
          approvalFlowId: targets.flowId,
        },
      })
      expect(create.status, create.raw).toBe(201)
      expect(Object.keys(create.body ?? {})).toEqual(['ok', 'data'])
      expect(Object.keys(create.body?.data ?? {})).toEqual(['request', 'scheduleDispatch'])
      expect(await createResidue(fixture.orgId)).toMatchObject({
        requests: 1,
        schedule_dispatch: 1,
        snapshots: 0,
        operations: 0,
        outbox: 0,
      })
    }

    {
      const fixture = await seedOrg('legacy')
      const pair = await seedShiftSwapPair(fixture.orgId, fixture.userId)
      const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          'x-org-id': fixture.orgId,
        },
        body: {
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
          approvalFlowId: pair.flowId,
        },
      })
      expect(create.status, create.raw).toBe(201)
      expect(Object.keys(create.body ?? {})).toEqual(['ok', 'data'])
      expect(Object.keys(create.body?.data ?? {})).toEqual(['request', 'shiftSwap'])
      expect(await createResidue(fixture.orgId)).toMatchObject({
        requests: 1,
        shift_swap: 1,
        snapshots: 0,
        operations: 0,
        outbox: 0,
      })
    }
  })

  it('P13 create families: body routeVariant spoof cannot change host source_ref', async () => {
    const fixture = await seedOrg('shadow')
    const targets = await seedScheduleDispatchTargets(fixture.orgId, fixture.userId)
    const token = await mintToken(fixture.userId, fixture.orgId)
    const operationId = randomUUID()
    const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-org-id': fixture.orgId,
      },
      body: {
        operationId,
        routeVariant: 'outdoor',
        userId: targets.subjectUserId,
        targetScheduleGroupId: targets.scheduleGroupId,
        targetShiftId: targets.shiftId,
        startDate: '2049-09-16',
        endDate: '2049-09-16',
        approvalFlowId: targets.flowId,
      },
    })
    // strict schema rejects unknown body keys (routeVariant is host-only).
    expect(create.status, create.raw).toBe(400)
    expect(await createResidue(fixture.orgId, operationId)).toMatchObject({
      requests: 0,
      operations: 0,
      outbox: 0,
      schedule_dispatch: 0,
    })
  })

  it('P13 source guard: specialized terminal routes stay delegated and approval updates keep OCC', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const source = readFileSync(path.join(repoRoot, 'plugins/plugin-attendance/index.cjs'), 'utf8')
    const registrars = ['context.api.http.addRoute(', 'addAttendanceIdUpdateRoute(']
    const nextRegistration = (from: number): number => {
      let next = -1
      for (const marker of registrars) {
        const at = source.indexOf(marker, from)
        if (at !== -1 && (next === -1 || at < next)) next = at
      }
      return next
    }
    const previousRegistration = (from: number): number => {
      let previous = -1
      for (const marker of registrars) {
        const at = source.lastIndexOf(marker, from)
        if (at > previous) previous = at
      }
      return previous
    }
    const routeContracts = [
      ['/api/attendance/schedule-dispatch-requests/:id/cancel', 'w4RequestOperationBoundary.execute({', "routeVariant: 'schedule_dispatch_cancel'"],
      ['/api/attendance/shift-swap-requests/:id/accept', "respondShiftSwapConsent(req, res, 'accepted')", null],
      ['/api/attendance/shift-swap-requests/:id/reject', "respondShiftSwapConsent(req, res, 'rejected')", null],
      ['/api/attendance/shift-swap-requests/:id/cancel', 'w4RequestOperationBoundary.execute({', "routeVariant: 'shift_swap_cancel'"],
    ] as const
    for (const [route, delegate, variant] of routeContracts) {
      const pathIndex = source.lastIndexOf(`'${route}'`)
      const start = previousRegistration(pathIndex)
      const end = nextRegistration(pathIndex + route.length)
      expect(pathIndex, `${route} must remain registered`).toBeGreaterThan(-1)
      expect(start, `${route} must remain a host route`).toBeGreaterThan(-1)
      const body = source.slice(start, end < 0 ? source.length : end)
      expect(body).toContain(delegate)
      if (variant) expect(body).toContain(variant)
      expect(body).not.toMatch(/\b(?:trx|db|client)\.query\s*\(/)
    }
    const consentStart = source.indexOf('async function respondShiftSwapConsent(')
    const consentEnd = nextRegistration(consentStart)
    const consentBody = source.slice(consentStart, consentEnd)
    expect(consentStart).toBeGreaterThan(-1)
    expect(consentBody).toContain('w4RequestOperationBoundary.execute({')
    expect(consentBody).toContain("routeVariant: decision === 'accepted' ? 'shift_swap_accept' : 'shift_swap_reject'")
    expect(consentBody).not.toMatch(/\b(?:trx|db|client)\.query\s*\(/)
    expect(source).toMatch(
      /UPDATE approval_instances[\s\S]*?WHERE id = \$3 AND version = \$4 AND status = \$5[\s\S]*?RETURNING id/,
    )
    expect(source).toMatch(
      /UPDATE approval_instances[\s\S]*?WHERE id = \$1 AND version = \$3 AND status = \$4[\s\S]*?RETURNING id/,
    )
  })
})
