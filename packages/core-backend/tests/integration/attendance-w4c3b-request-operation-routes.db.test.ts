import { __computeAttendanceOuterAttributionValueForTestsV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'
import { ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1, computeAttendanceWindowEvidenceFingerprintV1 } from '../../src/attendance/w4c2-frozen-attribution'
import { EP01_READY_CASES, EP01_NON_UTC_READY_CASES, expectedReadyCallerResult, expectedCheckoutOnlyResult } from '../utils/attendance-ep01-ready-callers'
import { computeAttendanceSemanticInputFingerprintV1 } from '../../src/attendance/w4c0-fingerprints'
import { calculateAttendanceSegmentsV1, ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } from '../../src/attendance/w4c1-segment-calculator'
import {
  clearAttendanceW7ContextSourcePostureV1,
  seedAttendanceW7ContextSourcePostureV1,
} from '../utils/w7-context-source-posture-fixture'
import { requestOnlinePunchFixture } from '../utils/attendance-online-punch-fixture'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, Client } from 'pg'
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
    orgTimezone = 'UTC',
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
      [randomUUID(), orgId, orgTimezone],
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

  async function seedCanonicalDay(
    workDate: string,
    segments: Array<{ startTime: string; endTime: string; startDayOffset?: 0; endDayOffset?: 1 }>,
    timezone = 'UTC',
  ) {
    const fixture = await seedOrg('shadow', 'attendance:admin', timezone)
    await pool.query("UPDATE users SET activation_status = 'activated' WHERE id = $1", [fixture.userId])
    // Existing RBAC_BYPASS fixture posture; this is not a real-auth proof.
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [fixture.userId, ['attendance:read', 'attendance:write']],
    )
    const headers = { Authorization: `Bearer ${fixture.token}` }
    const shift = await requestJson(`${baseUrl}/api/attendance/shifts`, {
      method: 'POST', headers,
      body: {
        name: 'canonical day synthetic', timezone,
        lateGraceMinutes: 0, earlyGraceMinutes: 0, roundingMinutes: 1,
        workingDays: [0, 1, 2, 3, 4, 5, 6], segments,
      },
    })
    expect(shift.status, 'PARENT_CALC_DAY_SHIFT_HTTP_STATUS').toBe(201)
    const shiftId: unknown = shift.body?.data?.id
    expect(typeof shiftId).toBe('string')
    if (typeof shiftId !== 'string') throw new Error('PARENT_CALC_DAY_SHIFT_ID_REQUIRED')
    for (const [state, prior, version] of [['eligible', 'shadow', 3], ['authoritative', 'eligible', 4]] as const) {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
        [fixture.orgId, state, prior, version],
      )
    }
    expect(process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED === fixture.orgId).toBe(true)
    const assigned = await requestJson(`${baseUrl}/api/attendance/assignments`, {
      method: 'POST', headers,
      body: { userId: fixture.userId, shiftId, startDate: workDate, endDate: workDate },
    })
    expect(assigned.status, 'PARENT_CALC_DAY_ASSIGNMENT_HTTP_STATUS').toBe(201)
    return { ...fixture, headers, shiftId, workDate }
  }

  async function frozenCanonicalCalculation(orgId: string, calculationId: string) {
    const rows = await pool.query(
      `SELECT to_jsonb(c) AS calculation,
              (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.segment_index) FROM attendance_record_segments s
                WHERE s.org_id = c.org_id AND s.record_id = c.attendance_record_id AND s.calculation_id = c.id) AS children
         FROM attendance_record_calculations c WHERE c.org_id = $1 AND c.id = $2`,
      [orgId, calculationId],
    )
    expect(rows.rows).toHaveLength(1)
    return rows.rows[0]
  }

  // Date-scoped native reads support both w4_group live and w4 recompute.
  async function readNativeProofDay(fixture: { orgId: string; userId: string; workDate: string }) {
    const current = await pool.query(
      `SELECT c.*, to_jsonb(r) AS parent, r.work_date::text AS record_work_date,
              r.work_date AS record_http_work_date
         FROM attendance_records r JOIN attendance_record_calculations c
           ON c.id = r.current_calculation_id AND c.org_id = r.org_id AND c.attendance_record_id = r.id
        WHERE r.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date`,
      [fixture.orgId, fixture.userId, fixture.workDate],
    )
    expect(current.rows, 'NATIVE_DATE_CURRENT_POINTER_JOIN').toHaveLength(1)
    const row = current.rows[0]
    const children = await pool.query(
      `SELECT segment_index, expected_start_at, expected_end_at, actual_in_at, actual_out_at,
              work_minutes, late_minutes, early_leave_minutes, status, status_reasons
         FROM attendance_record_segments
        WHERE org_id = $1 AND record_id = $2 AND calculation_id = $3 ORDER BY segment_index`,
      [fixture.orgId, row.parent.id, row.id],
    )
    const events = await pool.query<{ id: string; work_date: string; event_type: string; occurred_at: Date }>(
      `SELECT id::text, work_date::text, event_type, occurred_at FROM attendance_events
        WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date ORDER BY occurred_at, id`,
      [fixture.orgId, fixture.userId, fixture.workDate],
    )
    return { row, children: children.rows, events: events.rows }
  }

  function assertNativeProofDay(
    day: Awaited<ReturnType<typeof readNativeProofDay>>,
    fixture: { orgId: string; userId: string; workDate: string; shiftId: string },
    startTime: string,
    endTime: string,
    minutes: number,
    groupId: string | null,
    entrypoint: 'live' | 'recompute' = 'live',
  ) {
    const { row, children, events } = day
    const start = `${fixture.workDate}T${startTime}:00.000Z`
    const end = `${fixture.workDate}T${endTime}:00.000Z`
    expect(row).toMatchObject({
      org_id: fixture.orgId, attendance_record_id: row.parent.id, record_work_date: fixture.workDate,
      calculation_kind: 'calculation', mode: 'authoritative', entrypoint,
      outcome: 'completed', outcome_reason_code: 'calculated', projection_effect: 'set_active',
      expected_segment_count: 1, projected_status: 'normal', projected_work_minutes: minutes,
      projected_late_minutes: 0, projected_early_leave_minutes: 0,
    })
    expect(row.parent).toMatchObject({
      org_id: fixture.orgId, user_id: fixture.userId, work_date: fixture.workDate,
      current_calculation_id: row.id, projection_owner: groupId === null ? 'w4' : 'w4_group',
      visibility_state: 'active', status: 'normal', work_minutes: minutes, late_minutes: 0, early_leave_minutes: 0,
    })
    expect([row.projected_first_in_at, row.projected_last_out_at]).toEqual([new Date(start), new Date(end)])
    expect([new Date(row.parent.first_in_at), new Date(row.parent.last_out_at)]).toEqual([new Date(start), new Date(end)])
    expect(row.parent.timezone).toBe('UTC')
    expect(row.attribution_snapshot).toMatchObject({
      posture: 'resolved_v2',
      value: { orgId: fixture.orgId, userId: fixture.userId, workDate: fixture.workDate, shiftId: fixture.shiftId },
    })
    expect(row.context_snapshot).toMatchObject({
      schemaVersion: groupId === null ? 1 : 2, selector: groupId === null ? 'legacy' : 'group_effective',
      orgId: fixture.orgId, userId: fixture.userId, workDate: fixture.workDate,
      shiftId: fixture.shiftId, calculationGroupId: groupId, timezone: 'UTC', roundingMinutes: 1,
    })
    expect(row.context_snapshot.segments).toEqual([{
      index: 0, startTime, endTime, startDayOffset: 0, endDayOffset: 0,
      lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0,
    }])
    expect(row.segment_snapshot).toEqual(row.context_snapshot.segments)
    expect(row.approved_facts_snapshot).toEqual([])
    expect(events.map(event => [event.work_date, event.event_type, event.occurred_at.toISOString()])).toEqual([
      [fixture.workDate, 'check_in', start], [fixture.workDate, 'check_out', end],
    ])
    expect(row.evidence_snapshot).toEqual(events.map(event => ({
      kind: 'punch', ref: event.id, direction: event.event_type,
      occurredAt: event.occurred_at.toISOString(), source: 'attendance_event',
    })))
    expect(children).toEqual([{
      segment_index: 0, expected_start_at: new Date(start), expected_end_at: new Date(end),
      actual_in_at: new Date(start), actual_out_at: new Date(end), work_minutes: minutes,
      late_minutes: 0, early_leave_minutes: 0, status: 'normal', status_reasons: ['within_window'],
    }])
  }

  async function readFrozenProofTarget(fixture: { orgId: string; userId: string; workDate: string }) {
    const rows = await pool.query(
      `SELECT to_jsonb(r) AS parent,
              (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at, e.id) FROM attendance_events e
                WHERE e.org_id = r.org_id AND e.user_id = r.user_id AND e.work_date = r.work_date) AS events,
              (SELECT count(*)::int FROM attendance_records p
                WHERE p.org_id = r.org_id AND p.user_id = r.user_id AND p.work_date = r.work_date) AS records,
              (SELECT count(*)::int FROM attendance_record_calculations c
                WHERE c.org_id = r.org_id AND c.attendance_record_id = r.id) AS calculations,
              (SELECT count(*)::int FROM attendance_record_segments s
                WHERE s.org_id = r.org_id AND s.record_id = r.id) AS children,
              (SELECT count(*)::int FROM attendance_events e
                WHERE e.org_id = r.org_id AND e.user_id = r.user_id AND e.work_date = r.work_date) AS event_count
         FROM attendance_records r WHERE r.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date`,
      [fixture.orgId, fixture.userId, fixture.workDate],
    )
    expect(rows.rows).toHaveLength(1)
    return rows.rows[0]
  }

  async function readProofShift(fixture: { orgId: string; shiftId: string }) {
    const rows = await pool.query(
      `SELECT to_jsonb(s) AS shift, left(s.work_start_time::text, 5) AS start_time,
              left(s.work_end_time::text, 5) AS end_time,
              (SELECT jsonb_agg(to_jsonb(seg) ORDER BY seg.segment_index) FROM attendance_shift_segments seg
                WHERE seg.org_id = s.org_id AND seg.shift_id = s.id) AS segments,
              (SELECT jsonb_agg(jsonb_build_object(
                'index', seg.segment_index, 'start', left(seg.start_time::text, 5),
                'end', left(seg.end_time::text, 5), 'startOffset', seg.start_day_offset,
                'endOffset', seg.end_day_offset) ORDER BY seg.segment_index)
                 FROM attendance_shift_segments seg WHERE seg.org_id = s.org_id AND seg.shift_id = s.id) AS timing
         FROM attendance_shifts s WHERE s.org_id = $1 AND s.id = $2`,
      [fixture.orgId, fixture.shiftId],
    )
    expect(rows.rows).toHaveLength(1)
    return rows.rows[0]
  }


  it.each([...EP01_READY_CASES, ...EP01_NON_UTC_READY_CASES])('EP01_READY_$id: same timed inputs across four ready production callers', async (scenario) => {
    const ownedEnv = {
      ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED: process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    }
    const wire = (value: unknown) => JSON.parse(JSON.stringify(value))
    type Fixture = Awaited<ReturnType<typeof seedCanonicalDay>>
    const checkpoints: string[] = []
    const plugin = pluginRequire('../../../../plugins/plugin-attendance/index.cjs') as {
      __setAttendanceW4LivePunchPreBoundarySeamForTests(callback: ((input: {
        outerResolution: Parameters<typeof __computeAttendanceOuterAttributionValueForTestsV1>[0]['resolution']
        outerContext: Parameters<typeof __computeAttendanceOuterAttributionValueForTestsV1>[0]['context']
      }) => Promise<void>) | null): void
    }
    async function nativeResult(fixture: Fixture, entrypoint: string, refs: [string, string]) {
      const day = await readNativeProofDay(fixture)
      const row = day.row
      expect(row).toMatchObject({
        org_id: fixture.orgId, attendance_record_id: row.parent.id, record_work_date: scenario.workDate,
        calculation_kind: 'calculation', mode: 'authoritative', entrypoint,
        outcome: 'completed', outcome_reason_code: 'calculated', projection_effect: 'set_active',
        expected_segment_count: 1, projected_status: 'normal', projected_work_minutes: 540,
        projected_late_minutes: 0, projected_early_leave_minutes: 0,
      })
      expect(row.parent).toMatchObject({
        org_id: fixture.orgId, user_id: fixture.userId, work_date: scenario.workDate,
        current_calculation_id: row.id, projection_owner: 'w4', visibility_state: 'active',
        status: 'normal', timezone: scenario.timezone, work_minutes: 540, late_minutes: 0, early_leave_minutes: 0,
      })
      expect([new Date(row.parent.first_in_at).toISOString(), new Date(row.parent.last_out_at).toISOString()], 'EP01_READY_LITERAL_PARENT_INSTANTS')
        .toEqual([scenario.startAt, scenario.endAt])
      expect([row.projected_first_in_at, row.projected_last_out_at]).toEqual([
        new Date(scenario.startAt), new Date(scenario.endAt),
      ])
      expect(row.attribution_snapshot).toMatchObject({
        posture: 'resolved_v2', value: { orgId: fixture.orgId, userId: fixture.userId,
          workDate: scenario.workDate, shiftId: fixture.shiftId },
      })
      expect(row.context_snapshot).toMatchObject({
        schemaVersion: 1, selector: 'legacy', orgId: fixture.orgId, userId: fixture.userId,
        workDate: scenario.workDate, shiftId: fixture.shiftId, calculationGroupId: null,
        timezone: scenario.timezone, roundingMinutes: 1,
      })
      expect(row.context_snapshot.segments).toEqual([{
        index: 0, startTime: scenario.startTime, endTime: scenario.endTime, startDayOffset: 0,
        endDayOffset: scenario.endDayOffset, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0,
      }])
      expect(row.segment_snapshot).toEqual(row.context_snapshot.segments)
      expect(row.evidence_snapshot).toEqual([
        { kind: 'punch', ref: refs[0], direction: 'check_in', occurredAt: scenario.startAt,
          source: entrypoint === 'live' ? 'attendance_event' : 'import' },
        { kind: 'punch', ref: refs[1], direction: 'check_out', occurredAt: scenario.endAt,
          source: entrypoint === 'live' ? 'attendance_event' : 'import' },
      ])
      expect(row.manual_override_snapshot).toBeNull()
      const result = calculateAttendanceSegmentsV1({
        attribution: row.attribution_snapshot, context: row.context_snapshot,
        evidence: row.evidence_snapshot, approvedFacts: row.approved_facts_snapshot,
      })
      expect(result, 'EP01_READY_LITERAL_SEGMENT_AND_DAILY_RESULT').toEqual(expectedReadyCallerResult(scenario, refs))
      const children = await pool.query(
        `SELECT org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
                actual_in_at, actual_out_at, work_minutes, late_minutes, early_leave_minutes,
                status, status_reasons, matched_evidence_refs, unmatched_evidence_refs
           FROM attendance_record_segments WHERE org_id=$1 AND record_id=$2 AND calculation_id=$3
          ORDER BY segment_index`, [fixture.orgId, row.parent.id, row.id],
      )
      expect(children.rows).toEqual([{
        org_id: fixture.orgId, record_id: row.parent.id, calculation_id: row.id, segment_index: 0,
        expected_start_at: new Date(scenario.startAt), expected_end_at: new Date(scenario.endAt),
        actual_in_at: new Date(scenario.startAt), actual_out_at: new Date(scenario.endAt),
        work_minutes: 540, late_minutes: 0, early_leave_minutes: 0, status: 'normal',
        status_reasons: ['within_window'], matched_evidence_refs: refs, unmatched_evidence_refs: [],
      }])
      expect((await pool.query(
        'SELECT work_date::text, current_calculation_id::text FROM attendance_records WHERE org_id=$1 AND user_id=$2 ORDER BY work_date',
        [fixture.orgId, fixture.userId],
      )).rows).toEqual([{ work_date: scenario.workDate, current_calculation_id: row.id }])
      expect(row.semantic_input_fingerprint).toBe(computeAttendanceSemanticInputFingerprintV1({
        attribution: row.attribution_snapshot, context: row.context_snapshot, evidence: row.evidence_snapshot,
        approvedFacts: row.approved_facts_snapshot, manualOverride: null, mergePolicy: row.merge_policy,
        calculationTier: 'segment_authoritative', engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
        snapshotSchemaVersion: 1,
      }))
      return row
    }
    async function recompute(fixture: Fixture, prior: Awaited<ReturnType<typeof nativeResult>>, refs: [string, string], checkpoint: string) {
      const frozen = await frozenCanonicalCalculation(fixture.orgId, prior.id)
      const operationId = randomUUID()
      const trace: string[] = []
      const originalQuery = Client.prototype.query
      const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: Parameters<Client['query']>) {
        const carrier: unknown = args[0]
        const text = typeof carrier === 'string' ? carrier : carrier && typeof carrier === 'object' && 'text' in carrier ? String(carrier.text) : ''
        trace.push(text.replace(/\s+/g, ' ').trim())
        return Reflect.apply(originalQuery, this, args)
      })
      let response: JsonResponse
      try {
        response = await requestJson(`${baseUrl}/api/attendance/records/${prior.parent.id}/recompute`, {
          method: 'POST', headers: { ...fixture.headers, 'X-Org-Id': fixture.orgId },
          body: { policy: 'frozen_prior', operationId, expectedCalculationId: prior.id, expectedCalculationVersion: prior.version },
        })
      } finally { spy.mockRestore() }
      expect(response.status, 'EP01_READY_RECOMPUTE_HTTP_STATUS').toBe(200)
      const next = await nativeResult(fixture, 'recompute', refs)
      expect(response.body).toEqual({ ok: true, data: { alreadyApplied: false, calculationId: next.id,
        policy: 'frozen_prior', contextDecision: 'prior_calculation_frozen', projectedStatus: 'normal' } })
      expect(next).toMatchObject({ supersedes_calculation_id: prior.id, version: prior.version + 1,
        operation_id: operationId, merge_policy: prior.merge_policy,
        input_provenance: { policy: 'frozen_prior', contextDecision: 'prior_calculation_frozen', priorCalculationId: prior.id } })
      for (const key of ['attribution_snapshot', 'context_snapshot', 'segment_snapshot', 'evidence_snapshot',
        'approved_facts_snapshot', 'manual_override_snapshot', 'source_definition_fingerprint', 'semantic_input_fingerprint']) {
        expect(next[key], 'EP01_READY_FROZEN_PRIOR:' + key).toEqual(prior[key])
      }
      expect(await frozenCanonicalCalculation(fixture.orgId, prior.id)).toEqual(frozen)
      expect(trace.some(sql => /\bFROM attendance_records\b/i.test(sql))).toBe(true)
      expect(trace.some(sql => /\bINSERT INTO attendance_record_calculations\b/i.test(sql))).toBe(true)
      const liveTables = ['attendance_calculation_group_memberships', 'attendance_groups', 'attendance_group_members',
        'attendance_group_fixed_schedule_configs', 'attendance_shift_assignments', 'attendance_shifts',
        'attendance_shift_segments', 'attendance_rotation_rules', 'attendance_rotation_assignments']
      expect(liveTables.filter(name => trace.some(sql => new RegExp('\\b' + name + '\\b', 'i').test(sql)))).toEqual([])
      checkpoints.push(checkpoint)
      return next
    }
    try {
      process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = 'false'
      const segments = [{ startTime: scenario.startTime, endTime: scenario.endTime, startDayOffset: 0 as const,
        ...(scenario.endDayOffset === 1 ? { endDayOffset: 1 as const } : {}) }]
      const live = await seedCanonicalDay(scenario.workDate, segments, scenario.timezone)
      let liveOut: JsonResponse | undefined
      let liveOutBody: Record<string, unknown> | undefined
      let liveResolution: Record<string, unknown> | undefined
      let liveSource: Record<string, unknown> | null = null
      let liveContext: unknown
      let captureClockMs = 0
      let completedClockMs = 0
      for (const [eventType, occurredAt] of [['check_in', scenario.startAt], ['check_out', scenario.endAt]] as const) {
        plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(async input => {
          captureClockMs = Date.now()
          liveResolution = wire(input.outerResolution)
          liveContext = wire(input.outerContext)
          liveSource = __computeAttendanceOuterAttributionValueForTestsV1({
            orgId: live.orgId, userId: live.userId, source: 'live_resolution', nowIso: new Date(captureClockMs).toISOString(),
            resolution: input.outerResolution, context: input.outerContext,
          })
        })
        const body = { orgId: live.orgId, eventType, operationId: randomUUID(), occurredAt, timezone: scenario.timezone }
        const response = await requestJson(baseUrl + '/api/attendance/punch', { method: 'POST', headers: live.headers, body })
        completedClockMs = Date.now()
        expect(response.status, 'EP01_READY_LIVE_HTTP_STATUS; code=' + String(response.body?.error?.code ?? 'none')).toBe(200)
        if (eventType === 'check_out') { liveOut = response; liveOutBody = body }
      }
      plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(null)
      const physical = (await pool.query('SELECT * FROM attendance_events WHERE org_id=$1 AND user_id=$2 ORDER BY occurred_at,id', [live.orgId, live.userId])).rows
      expect(physical.map(row => [row.event_type, row.occurred_at.toISOString()])).toEqual([
        ['check_in', scenario.startAt], ['check_out', scenario.endAt],
      ])
      const liveRefs: [string, string] = [physical[0].id, physical[1].id]
      const l0 = await nativeResult(live, 'live', liveRefs)
      expect(l0.approved_facts_snapshot).toEqual([])
      const expectedSource = {
        schemaVersion: 2, resolverVersion: ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1,
        orgId: live.orgId, userId: live.userId, workDate: scenario.workDate, shiftId: live.shiftId,
        reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT', resolvedAt: new Date(captureClockMs).toISOString(),
        absoluteWindow: { startAt: scenario.startAt, endAt: scenario.endAt },
        attributionWindow: { startAt: scenario.startAt, endAt: new Date(Date.parse(scenario.endAt) + 120 * 60000).toISOString() },
        attributionTailMinutes: 120, extendedByApprovedOvertime: false,
        windowEvidenceFingerprint: computeAttendanceWindowEvidenceFingerprintV1({ attributionTailMinutes: 120, approvedOvertimeWindows: [] }),
        source: 'live_resolution',
      }
      expect(liveSource, 'EP01_READY_CAPTURED_SOURCE_LITERAL').toEqual(expectedSource)
      // Business clock supplies punch time; source metadata records the actual core build clock.
      const storedResolvedAt = l0.attribution_snapshot.value.resolvedAt
      const storedResolvedAtMs = Date.parse(storedResolvedAt)
      expect(new Date(storedResolvedAtMs).toISOString(), 'EP01_READY_SOURCE_CLOCK_ISO').toBe(storedResolvedAt)
      expect(storedResolvedAtMs, 'EP01_READY_SOURCE_CLOCK_AFTER_CAPTURE').toBeGreaterThanOrEqual(captureClockMs)
      expect(storedResolvedAtMs, 'EP01_READY_SOURCE_CLOCK_BEFORE_RESPONSE').toBeLessThanOrEqual(completedClockMs)
      expect(l0.attribution_snapshot, 'EP01_READY_COMPLETE_LIVE_SOURCE').toEqual({
        posture: 'resolved_v2', value: { ...expectedSource, resolvedAt: storedResolvedAt },
      })
      expect(l0.context_snapshot, 'EP01_READY_COMPLETE_LIVE_CONTEXT').toEqual(liveContext)

      expect(liveResolution).toMatchObject({ kind: 'resolved', workDate: scenario.workDate, shiftId: live.shiftId, segmentIndex: null })
      const wireResolution = { ...liveResolution! }
      delete wireResolution.fullWinner
      delete wireResolution.attributionTailMinutes
      delete wireResolution.approvedOvertimeWindows
      const rawLiveParent = (await pool.query('SELECT * FROM attendance_records WHERE org_id=$1 AND id=$2', [live.orgId, l0.parent.id])).rows[0]
      expect(liveOut!.body).toEqual({ ok: true, data: { event: wire(physical[1]), record: wire(rawLiveParent), workDateResolution: wireResolution } })
      const replay = await requestJson(baseUrl + '/api/attendance/punch', { method: 'POST', headers: live.headers, body: liveOutBody })
      expect(replay.status).toBe(200)
      expect(replay.body).toEqual(liveOut!.body)
      checkpoints.push('L0')

      const importedFixture = await seedCanonicalDay(scenario.workDate, segments, scenario.timezone)
      const prepared = await requestJson(baseUrl + '/api/attendance/import/prepare', {
        method: 'POST', headers: importedFixture.headers, body: { orgId: importedFixture.orgId },
      })
      expect(prepared.status, 'EP01_READY_IMPORT_PREPARE_HTTP_STATUS').toBe(200)
      expect(Object.keys(prepared.body!.data).sort()).toEqual(['commitToken', 'expiresAt', 'ttlSeconds'])
      expect(prepared.body!.data.ttlSeconds).toBe(600)
      expect(typeof prepared.body!.data.commitToken).toBe('string')
      const imported = await requestJson(baseUrl + '/api/attendance/import/commit', {
        method: 'POST', headers: importedFixture.headers, body: {
          orgId: importedFixture.orgId, userId: importedFixture.userId, timezone: scenario.timezone, mode: 'override',
          idempotencyKey: randomUUID(), commitToken: prepared.body!.data.commitToken,
          rows: [{ workDate: scenario.workDate, fields: { firstInAt: scenario.startAt, lastOutAt: scenario.endAt } }],
        },
      })
      expect(imported.status, 'EP01_READY_IMPORT_COMMIT_HTTP_STATUS').toBe(200)
      expect(imported.body).toMatchObject({ ok: true, success: true, data: {
        imported: 1, processedRows: 1, failedRows: 0, itemsTruncated: false, skipped: [], csvWarnings: [], groupWarnings: [],
      } })
      expect(Object.keys(imported.body!.data).sort()).toEqual([
        'batchId', 'imported', 'processedRows', 'failedRows', 'elapsedMs', 'engine', 'recordUpsertStrategy',
        'items', 'itemsTruncated', 'skipped', 'csvWarnings', 'groupWarnings', 'meta',
      ].sort())
      const importRefs: [string, string] = [`import:${imported.body!.data.batchId}:0:check_in`, `import:${imported.body!.data.batchId}:0:check_out`]
      const i0 = await nativeResult(importedFixture, 'legacy_import', importRefs)
      expect(i0.approved_facts_snapshot).toEqual([])
      expect(imported.body!.data.items).toHaveLength(1)
      expect(imported.body!.data.items[0]).toMatchObject({ id: i0.parent.id, userId: importedFixture.userId, workDate: scenario.workDate })
      expect((await pool.query("SELECT id FROM attendance_events WHERE org_id=$1 AND user_id=$2", [importedFixture.orgId, importedFixture.userId])).rows).toEqual([])
      checkpoints.push('I0')
      const r0 = await recompute(importedFixture, i0, importRefs, 'R0')

      const prior = await frozenCanonicalCalculation(importedFixture.orgId, r0.id)
      const overtimeRuleId = randomUUID()
      await pool.query('INSERT INTO attendance_overtime_rules (id,org_id,name,rounding_minutes) VALUES ($1,$2,$3,1)',
        [overtimeRuleId, importedFixture.orgId, 'EP01_READY_' + overtimeRuleId])
      const created = await requestJson(baseUrl + '/api/attendance/requests', {
        method: 'POST', headers: importedFixture.headers, body: {
          operationId: randomUUID(), orgId: importedFixture.orgId, workDate: scenario.workDate, requestType: 'overtime',
          overtimeRuleId, requestedInAt: scenario.otStart, requestedOutAt: scenario.otEnd, minutes: scenario.otMinutes,
          reason: 'EP01 ready caller synthetic bounded interval',
        },
      })
      expect(created.status, 'EP01_READY_OVERTIME_CREATE_HTTP_STATUS').toBe(201)
      const requestId = created.body!.data.request.id
      const cursor = await loadApprovalCursor(requestId)
      await assignApprovalUser(cursor, importedFixture.userId)
      const snapshot = (await pool.query(
        'SELECT * FROM attendance_request_calculation_snapshots WHERE org_id=$1 AND request_id=$2 ORDER BY version',
        [importedFixture.orgId, requestId],
      )).rows
      expect(snapshot).toHaveLength(1)
      expect(created.body!.data.requestSnapshot).toEqual({ version: snapshot[0].version, fingerprint: snapshot[0].payload_fingerprint })
      const operationId = randomUUID()
      const approved = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST', headers: importedFixture.headers, body: { operationId, expectedApprovalVersion: cursor.version,
          expectedApprovalNode: cursor.node, comment: 'EP01 ready caller synthetic decision' },
      })
      expect(approved.status, 'EP01_READY_OVERTIME_APPROVE_HTTP_STATUS').toBe(200)
      const o1 = await nativeResult(importedFixture, 'approved_overtime', importRefs)
      const request = (await pool.query('SELECT *,work_date::text AS request_work_date_text FROM attendance_requests WHERE org_id=$1 AND id=$2', [importedFixture.orgId, requestId])).rows[0]
      const binding = request.metadata.w4RequestSnapshotTerminalBinding
      const terminal = (await pool.query(
        `SELECT ar.id::text, ar.instance_id, ar.actor_id, ar.action, ar.from_version, ar.to_version,
                ar.to_status, ai.status AS instance_status, ai.version AS instance_version
           FROM approval_records ar JOIN approval_instances ai ON ai.id=ar.instance_id
          WHERE ar.instance_id=$1 AND ar.to_version=$2 AND ar.action='approve' AND ar.to_status='approved'`,
        [cursor.approvalId, cursor.version + 1],
      )).rows
      expect(terminal, 'EP01_READY_ACTUAL_TERMINAL_APPROVAL').toHaveLength(1)
      expect(terminal[0]).toEqual({ id: terminal[0].id, instance_id: cursor.approvalId, actor_id: importedFixture.userId,
        action: 'approve', from_version: cursor.version, to_version: cursor.version + 1, to_status: 'approved',
        instance_status: 'approved', instance_version: cursor.version + 1 })
      expect(terminal[0].id).toMatch(/^[1-9][0-9]*$/)
      expect(binding, 'EP01_READY_INDEPENDENT_TERMINAL_BINDING').toEqual({
        schemaVersion: 1, kind: 'w4c3b_request_snapshot_terminal_binding', orgId: importedFixture.orgId,
        requestId, requestType: 'overtime', subjectUserId: importedFixture.userId,
        requestSnapshotVersion: snapshot[0].version, requestSnapshotFingerprint: snapshot[0].payload_fingerprint,
        approvalVersion: terminal[0].to_version, approvalRecordId: terminal[0].id,
        action: 'approve', bindingPosture: 'bound',
      })
      expect(request.metadata.approvalFlow?.steps ?? []).toEqual([])

      expect(request.status).toBe('approved')
      expect(request.request_work_date_text).toBe(scenario.workDate)
      expect(o1.attribution_snapshot).toEqual(snapshot[0].attribution_snapshot)
      expect(o1.context_snapshot).toEqual(snapshot[0].context_snapshot)
      expect(o1.evidence_snapshot).toEqual(r0.evidence_snapshot)
      expect(o1.approved_facts_snapshot).toEqual([{ kind: 'overtime', requestId,
        requestSnapshotVersion: snapshot[0].version, requestSnapshotFingerprint: snapshot[0].payload_fingerprint,
        approvalVersion: terminal[0].to_version, approvalRecordId: terminal[0].id,
        coverage: { kind: 'bounded_interval', startAt: scenario.otStart, endAt: scenario.otEnd, minutes: scenario.otMinutes } }])
      expect(await frozenCanonicalCalculation(importedFixture.orgId, r0.id)).toEqual(prior)
      const approvedParent = (await pool.query('SELECT * FROM attendance_records WHERE org_id=$1 AND id=$2', [importedFixture.orgId, o1.parent.id])).rows[0]
      expect(approved.body).toEqual({ ok: true, data: { requestId, status: 'approved', record: wire(approvedParent),
        orgId: null, userId: importedFixture.userId, approvalStep: { index: 0, total: 0 } } })
      const sealed = await pool.query(
        'SELECT state,resolved_record_id::text,resolved_calculation_id::text,resolved_request_id::text,result_semantic_fingerprint,result_provenance_fingerprint FROM attendance_result_operations WHERE org_id=$1 AND operation_id=$2',
        [importedFixture.orgId, operationId],
      )
      expect(sealed.rows).toEqual([{ state: 'completed', resolved_record_id: o1.parent.id, resolved_calculation_id: o1.id,
        resolved_request_id: requestId, result_semantic_fingerprint: o1.semantic_input_fingerprint,
        result_provenance_fingerprint: o1.provenance_fingerprint }])
      checkpoints.push('O1')
      await recompute(importedFixture, o1, importRefs, 'R1')
      expect(checkpoints).toEqual(['L0', 'I0', 'R0', 'O1', 'R1'])
      console.log('EP01_READY_CALLER_RECEIPT ' + JSON.stringify({ case: scenario.id, checkpoints,
        readyCallerCount: 4, correction: 'OPEN', resultMinutes: 540, physicalSegmentCount: 1,
        sameRawTransportFingerprintClaimed: false, fullEP01: false }))
    } finally {
      plugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(null)
      for (const [key, value] of Object.entries(ownedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 120000)


  it.each([EP01_READY_CASES[0], ...EP01_NON_UTC_READY_CASES])('EP01_IMPORT_CHECKOUT_ONLY_$id: first-available-instant calendar fallback discriminates the origin day', async (scenario) => {
    const ownedEnv = {
      ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED: process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    }
    try {
      process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = 'false'
      const fixture = await seedCanonicalDay(scenario.workDate, [{ startTime: '21:00', endTime: '06:00', startDayOffset: 0, endDayOffset: 1 }], scenario.timezone)
      const prepared = await requestJson(baseUrl + '/api/attendance/import/prepare', {
        method: 'POST', headers: fixture.headers, body: { orgId: fixture.orgId },
      })
      expect(prepared.status).toBe(200)
      const imported = await requestJson(baseUrl + '/api/attendance/import/commit', {
        method: 'POST', headers: fixture.headers, body: { orgId: fixture.orgId, userId: fixture.userId, timezone: scenario.timezone,
          mode: 'override', idempotencyKey: randomUUID(), commitToken: prepared.body!.data.commitToken,
          rows: [{ workDate: scenario.workDate, fields: { lastOutAt: scenario.endAt } }] },
      })
      expect(imported.status, 'EP01_IMPORT_CHECKOUT_ONLY_HTTP_STATUS; code=' + String(imported.body?.error?.code ?? 'none')).toBe(200)
      expect(imported.body).toMatchObject({ ok: true, success: true, data: { imported: 1, processedRows: 1, failedRows: 0, skipped: [] } })
      const day = await readNativeProofDay(fixture)
      const ref = `import:${imported.body!.data.batchId}:0:check_out`
      expect(day.row).toMatchObject({ entrypoint: 'legacy_import', mode: 'authoritative', outcome: 'completed',
        outcome_reason_code: 'calculated', expected_segment_count: 1, projected_status: 'partial', projected_work_minutes: 0 })
      expect(day.row.parent).toMatchObject({ work_date: scenario.workDate, projection_owner: 'w4', visibility_state: 'active',
        current_calculation_id: day.row.id, status: 'partial', work_minutes: 0, first_in_at: null })
      expect(new Date(day.row.parent.last_out_at).toISOString(), 'EP01_IMPORT_CHECKOUT_ONLY_LAST_INSTANT').toBe(scenario.endAt)
      expect(day.row.evidence_snapshot).toEqual([{ kind: 'punch', ref, direction: 'check_out', source: 'import', occurredAt: scenario.endAt }])
      expect(calculateAttendanceSegmentsV1({ attribution: day.row.attribution_snapshot, context: day.row.context_snapshot,
        evidence: day.row.evidence_snapshot, approvedFacts: day.row.approved_facts_snapshot })).toEqual(expectedCheckoutOnlyResult(ref, scenario))
      expect(day.children).toEqual([{ segment_index: 0, expected_start_at: new Date(scenario.startAt), expected_end_at: new Date(scenario.endAt),
        actual_in_at: null, actual_out_at: new Date(scenario.endAt), work_minutes: 0, late_minutes: 0, early_leave_minutes: 0,
        status: 'missing_check_in', status_reasons: ['missing_check_in'] }])
      expect(day.events).toEqual([])
      expect((await pool.query('SELECT work_date::text FROM attendance_records WHERE org_id=$1 AND user_id=$2 ORDER BY work_date',
        [fixture.orgId, fixture.userId])).rows).toEqual([{ work_date: scenario.workDate }])
      console.log('EP01_IMPORT_CHECKOUT_ONLY_RECEIPT ' + JSON.stringify({ input: 'check_out_only', expected: 'partial',
        minutes: 0, originDayRetained: true, full540ParityClaimed: false, correction: 'OPEN' }))
    } finally {
      for (const [key, value] of Object.entries(ownedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 120000)

  it('CALC12_HTTP_PG: same user switches calculation groups at the inclusive effective-date boundary', async () => {
    const ownedEnv = {
      ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED: process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    }
    let ownedOrg: string | undefined
    try {
      const fixture = await seedOrg('shadow')
      ownedOrg = fixture.orgId
      await pool.query("UPDATE users SET activation_status = 'activated' WHERE id = $1", [fixture.userId])
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [fixture.userId, ['attendance:read', 'attendance:write']],
      )
      const headers = { Authorization: `Bearer ${fixture.token}` }
      const { buildAttendanceGroupFixedScheduleProducerKey } = pluginRequire(
        '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
      ) as { buildAttendanceGroupFixedScheduleProducerKey(input: {
        groupId: string; shiftId: string; startDate: string; endDate: string
      }): string }
      const days = [
        { workDate: '2026-07-01', effectiveFrom: '2026-06-01', effectiveTo: '2026-07-01', start: '09:00', end: '17:00', minutes: 480 },
        { workDate: '2026-07-02', effectiveFrom: '2026-07-02', effectiveTo: null, start: '10:00', end: '16:00', minutes: 360 },
      ].map(day => ({ ...day, groupId: randomUUID(), shiftId: '' }))
      for (const day of days) {
        const shift = await requestJson(`${baseUrl}/api/attendance/shifts`, {
          method: 'POST', headers,
          body: {
            name: 'bounded group cutover synthetic', timezone: 'UTC',
            lateGraceMinutes: 0, earlyGraceMinutes: 0, roundingMinutes: 1,
            workingDays: [0, 1, 2, 3, 4, 5, 6], flexPolicy: { mode: 'strict' },
            segments: [{ startTime: day.start, endTime: day.end }],
          },
        })
        expect(shift.status, 'CALC12_SHIFT_HTTP_STATUS').toBe(201)
        expect(shift.body?.ok).toBe(true)
        const shiftId: unknown = shift.body?.data?.id
        expect(typeof shiftId).toBe('string')
        if (typeof shiftId !== 'string') throw new Error('CALC12_SHIFT_ID_REQUIRED')
        day.shiftId = shiftId
        await pool.query(
          `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
           VALUES ($1, $2, $3, 'fixed_shift', 'UTC')`,
          [day.groupId, fixture.orgId, 'bounded cutover ' + day.workDate],
        )
        await pool.query(
          `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
          [fixture.orgId, day.groupId, fixture.userId],
        )
        await pool.query(
          `INSERT INTO attendance_calculation_group_memberships
             (org_id, user_id, group_id, effective_from, effective_to, assigned_by, assigned_reason, assigned_correlation_id)
           VALUES ($1, $2, $3, $4::date, $5::date, $2, 'bounded native proof', $6)`,
          [fixture.orgId, fixture.userId, day.groupId, day.effectiveFrom, day.effectiveTo, randomUUID()],
        )
        await pool.query(
          `INSERT INTO attendance_group_fixed_schedule_configs
             (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
           VALUES ($1, $2, $3, $4::date, $4::date, 1, $5)`,
          [fixture.orgId, day.groupId, day.shiftId, day.workDate, fixture.userId],
        )
        const producerKey = buildAttendanceGroupFixedScheduleProducerKey({
          groupId: day.groupId, shiftId: day.shiftId, startDate: day.workDate, endDate: day.workDate,
        })
        await pool.query(
          `INSERT INTO attendance_shift_assignments
             (org_id, user_id, shift_id, start_date, end_date, is_active, slot_index,
              producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
           VALUES ($1, $2, $3, $4::date, $4::date, true, 0,
                   'attendance_group_fixed_schedule', $5, $6, $7, 'published')`,
          [fixture.orgId, fixture.userId, day.shiftId, day.workDate, day.groupId, producerKey, randomUUID()],
        )
      }
      for (const [state, prior, version] of [['eligible', 'shadow', 3], ['authoritative', 'eligible', 4]] as const) {
        await pool.query(
          `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
          [fixture.orgId, state, prior, version],
        )
      }
      await seedAttendanceW7ContextSourcePostureV1(pool, fixture.orgId, 'group_authoritative', { scope: 'synthetic_staging' })
      process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = fixture.orgId
      expect(process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED).toBe(fixture.orgId)
      expect(process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED).toBe(fixture.orgId)
      // Verify both complete static source tuples before any punch is issued.
      for (const day of days) {
        const members = await pool.query(
          `SELECT group_id FROM attendance_calculation_group_memberships
            WHERE org_id = $1 AND user_id = $2 AND effective_from <= $3::date
              AND (effective_to IS NULL OR effective_to >= $3::date) ORDER BY group_id`,
          [fixture.orgId, fixture.userId, day.workDate],
        )
        expect(members.rows).toEqual([{ group_id: day.groupId }])
        const source = await pool.query(
          `SELECT g.attendance_type, g.timezone, m.user_id, c.shift_id,
                  c.start_date::text, c.end_date::text, c.revision,
                  a.shift_id AS assigned_shift, a.start_date::text AS assigned_start,
                  a.end_date::text AS assigned_end, a.is_active, a.slot_index,
                  a.producer_type, a.producer_ref_id, a.producer_key, a.publish_status,
                  s.flex_mode, s.late_grace_minutes, s.early_grace_minutes, s.rounding_minutes
             FROM attendance_groups g JOIN attendance_group_members m ON m.org_id = g.org_id AND m.group_id = g.id
             JOIN attendance_group_fixed_schedule_configs c ON c.org_id = g.org_id AND c.group_id = g.id
             JOIN attendance_shift_assignments a ON a.org_id = g.org_id AND a.producer_ref_id = g.id AND a.user_id = m.user_id
             JOIN attendance_shifts s ON s.org_id = g.org_id AND s.id = c.shift_id
            WHERE g.org_id = $1 AND g.id = $2`,
          [fixture.orgId, day.groupId],
        )
        expect(source.rows).toEqual([{
          attendance_type: 'fixed_shift', timezone: 'UTC', user_id: fixture.userId,
          shift_id: day.shiftId, start_date: day.workDate, end_date: day.workDate, revision: 1,
          assigned_shift: day.shiftId, assigned_start: day.workDate, assigned_end: day.workDate,
          is_active: true, slot_index: 0, producer_type: 'attendance_group_fixed_schedule',
          producer_ref_id: day.groupId, producer_key: buildAttendanceGroupFixedScheduleProducerKey({
            groupId: day.groupId, shiftId: day.shiftId, startDate: day.workDate, endDate: day.workDate,
          }), publish_status: 'published', flex_mode: 'strict',
          late_grace_minutes: 0, early_grace_minutes: 0, rounding_minutes: 1,
        }])
      }
      for (const day of days) {
        const target = { ...fixture, ...day }
        for (const [eventType, time] of [['check_in', day.start], ['check_out', day.end]] as const) {
          const response = await requestJson(`${baseUrl}/api/attendance/punch`, {
            method: 'POST', headers,
            body: { orgId: fixture.orgId, eventType, operationId: randomUUID(), occurredAt: `${day.workDate}T${time}:00.000Z`, timezone: 'UTC' },
          })
          expect(response.status, 'CALC12_PUNCH_HTTP_STATUS').toBe(200)
          expect(response.body?.ok).toBe(true)
          const current = await readNativeProofDay(target)
          expect(response.body?.data?.record).toMatchObject({
            id: current.row.parent.id, work_date: JSON.parse(JSON.stringify(current.row.record_http_work_date)),
            current_calculation_id: current.row.id, projection_owner: 'w4_group', visibility_state: 'active',
            status: current.row.parent.status, work_minutes: current.row.parent.work_minutes,
          })
        }
      }
      const parents = await pool.query(
        `SELECT work_date::text FROM attendance_records WHERE org_id = $1 AND user_id = $2 ORDER BY work_date`,
        [fixture.orgId, fixture.userId],
      )
      expect(parents.rows).toEqual(days.map(day => ({ work_date: day.workDate })))
      const nativeMinutes: number[] = []
      const nativeOwners: string[] = []
      for (const day of days) {
        const target = { ...fixture, ...day }
        const native = await readNativeProofDay(target)
        assertNativeProofDay(native, target, day.start, day.end, day.minutes, day.groupId)
        nativeMinutes.push(Number(native.row.projected_work_minutes))
        nativeOwners.push(String(native.row.parent.projection_owner))
      }
      const events = await pool.query(
        `SELECT count(*)::int AS count FROM attendance_events WHERE org_id = $1 AND user_id = $2`,
        [fixture.orgId, fixture.userId],
      )
      expect(events.rows).toEqual([{ count: 4 }])
      console.log('PARENT_CALC12_CUTOVER_HTTP_RECEIPT ' + JSON.stringify({
        clause: 'CALC12', dateParents: parents.rows.length, groups: days.length,
        eventCount: Number(events.rows[0].count), nativeWorkMinutes: nativeMinutes,
        nativeProjectionOwners: nativeOwners, selector: 'group_effective',
        membershipBoundaryAssertions: true, exactNativeSnapshotsAndEvidence: true,
      }))
    } finally {
      for (const [key, value] of Object.entries(ownedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (ownedOrg) await clearAttendanceW7ContextSourcePostureV1(pool, ownedOrg)
    }
  }, 120000)

  it('CALC13_HTTP_PG: actual shift edits preserve a historical frozen target and frozen_prior inputs', async () => {
    const ownedEnv = {
      ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED: process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    }
    try {
      delete process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED
      const fixture = await seedCanonicalDay('2026-07-03', [{ startTime: '09:00', endTime: '17:00' }])
      for (const [eventType, time] of [['check_in', '09:00'], ['check_out', '17:00']] as const) {
        const response = await requestJson(`${baseUrl}/api/attendance/punch`, {
          method: 'POST', headers: fixture.headers,
          body: { orgId: fixture.orgId, eventType, operationId: randomUUID(), occurredAt: `${fixture.workDate}T${time}:00.000Z`, timezone: 'UTC' },
        })
        expect(response.status, 'CALC13_PUNCH_HTTP_STATUS').toBe(200)
        expect(response.body?.ok).toBe(true)
        const current = await readNativeProofDay(fixture)
        expect(response.body?.data?.record).toMatchObject({
          id: current.row.parent.id, work_date: JSON.parse(JSON.stringify(current.row.record_http_work_date)),
          current_calculation_id: current.row.id, projection_owner: 'w4', visibility_state: 'active',
          status: current.row.parent.status, work_minutes: current.row.parent.work_minutes,
        })
      }
      const before = await readNativeProofDay(fixture)
      assertNativeProofDay(before, fixture, '09:00', '17:00', 480, null)
      const c0 = before.row
      expect(typeof c0.id).toBe('string')
      expect(Number.isInteger(c0.version)).toBe(true)
      const frozen = await frozenCanonicalCalculation(fixture.orgId, c0.id)
      const targetBefore = await readFrozenProofTarget(fixture)
      expect(targetBefore).toMatchObject({ records: 1, event_count: 2 })
      const liveBefore = await readProofShift(fixture)
      expect(liveBefore).toMatchObject({
        start_time: '09:00', end_time: '17:00',
        shift: { late_grace_minutes: 0, early_grace_minutes: 0, rounding_minutes: 1 },
        timing: [{ index: 0, start: '09:00', end: '17:00', startOffset: 0, endOffset: 0 }],
      })
      const edited = await requestJson(`${baseUrl}/api/attendance/shifts/${fixture.shiftId}`, {
        method: 'PUT', headers: fixture.headers,
        body: { segments: [{ startTime: '10:00', endTime: '16:00' }], lateGraceMinutes: 30, earlyGraceMinutes: 20, roundingMinutes: 5 },
      })
      expect(edited.status, 'CALC13_SHIFT_EDIT_HTTP_STATUS').toBe(200)
      expect(edited.body).toMatchObject({ ok: true, data: { id: fixture.shiftId } })
      const liveEdited = await readProofShift(fixture)
      expect(liveEdited).not.toEqual(liveBefore)
      expect(liveEdited).toMatchObject({
        start_time: '10:00', end_time: '16:00',
        shift: { late_grace_minutes: 30, early_grace_minutes: 20, rounding_minutes: 5 },
      })
      expect(liveEdited.timing).toEqual([{ index: 0, start: '10:00', end: '16:00', startOffset: 0, endOffset: 0 }])
      expect(await frozenCanonicalCalculation(fixture.orgId, c0.id)).toEqual(frozen)
      expect(await readFrozenProofTarget(fixture)).toEqual(targetBefore)
      assertNativeProofDay(await readNativeProofDay(fixture), fixture, '09:00', '17:00', 480, null)
      const operationId = randomUUID()
      const recomputed = await requestJson(`${baseUrl}/api/attendance/records/${c0.parent.id}/recompute`, {
        method: 'POST', headers: { ...fixture.headers, 'X-Org-Id': fixture.orgId },
        body: { policy: 'frozen_prior', operationId, expectedCalculationId: c0.id, expectedCalculationVersion: c0.version },
      })
      if (recomputed.status !== 200) {
        const denial = recomputed.body?.error?.message
        const reason = denial === 'Record operation requires active org membership' ? 'ORG_MEMBERSHIP_REQUIRED'
          : denial === 'Record operation requires attendance admin permission' ? 'DB_ADMIN_REQUIRED' : 'OTHER'
        const code = recomputed.body?.error?.code
        console.log('CALC13_RECOMPUTE_DENIAL_DIAGNOSTIC ' + JSON.stringify({
          status: recomputed.status, reason,
          code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNCLASSIFIED',
        }))
      }
      expect(recomputed.status, 'CALC13_FROZEN_PRIOR_HTTP_STATUS').toBe(200)
      // Explicit read: the canonical-day live helper is not valid after recompute.
      const after = await readNativeProofDay(fixture)
      const c1 = after.row
      expect(c1.id).not.toBe(c0.id)
      expect(recomputed.body).toEqual({
        ok: true, data: {
          alreadyApplied: false, calculationId: c1.id, policy: 'frozen_prior',
          contextDecision: 'prior_calculation_frozen', projectedStatus: 'normal',
        },
      })
      assertNativeProofDay(after, fixture, '09:00', '17:00', 480, null, 'recompute')
      expect(c1).toMatchObject({
        supersedes_calculation_id: c0.id, version: c0.version + 1, operation_id: operationId,
        input_provenance: { policy: 'frozen_prior', contextDecision: 'prior_calculation_frozen', priorCalculationId: c0.id },
      })
      // Only frozen inputs/fingerprints compare C1 to C0; identities and operation provenance differ.
      for (const key of [
        'attribution_snapshot', 'context_snapshot', 'segment_snapshot', 'evidence_snapshot',
        'approved_facts_snapshot', 'manual_override_snapshot',
        'source_definition_fingerprint',
      ] as const) {
        expect(c1[key], `CALC13_FROZEN_INPUT_EQUAL:${key}`).toEqual(c0[key])
      }
      // frozen_prior retains the persisted prior merge policy. Recompute the
      // complete semantic inputs independently; never copy the prior hash.
      const semanticForPolicy = (mergePolicy: 'append' | 'merge') => computeAttendanceSemanticInputFingerprintV1({
        attribution: c0.attribution_snapshot, context: c0.context_snapshot, evidence: c0.evidence_snapshot,
        approvedFacts: c0.approved_facts_snapshot, manualOverride: c0.manual_override_snapshot,
        mergePolicy, calculationTier: 'segment_authoritative',
        engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, snapshotSchemaVersion: 1,
      })
      expect(c0.merge_policy, 'CALC13_PRIOR_APPEND_POLICY').toBe('append')
      expect(c0.semantic_input_fingerprint, 'CALC13_LIVE_APPEND_SEMANTIC_DOMAIN').toBe(semanticForPolicy('append'))
      expect(c1.merge_policy, 'CALC13_RECOMPUTE_PRESERVES_PRIOR_POLICY').toBe(c0.merge_policy)
      expect(c1.semantic_input_fingerprint, 'CALC13_RECOMPUTE_FROZEN_PRIOR_SEMANTIC_DOMAIN').toBe(semanticForPolicy(c0.merge_policy))
      expect(c1.semantic_input_fingerprint).toBe(c0.semantic_input_fingerprint)
      const preservedC0 = await frozenCanonicalCalculation(fixture.orgId, c0.id)
      expect(preservedC0).toEqual(frozen)
      expect(await readProofShift(fixture)).toEqual(liveEdited)
      const targetAfter = await readFrozenProofTarget(fixture)
      expect(targetAfter.events).toEqual(targetBefore.events)
      expect({
        records: targetAfter.records, calculations: targetAfter.calculations,
        children: targetAfter.children, event_count: targetAfter.event_count,
      }).toEqual({
        records: targetBefore.records, calculations: targetBefore.calculations + 1,
        children: targetBefore.children + 1, event_count: targetBefore.event_count,
      })
      console.log('PARENT_CALC13_FROZEN_HTTP_RECEIPT ' + JSON.stringify({
        clause: 'CALC13', editHTTP: edited.status, recomputeHTTP: recomputed.status,
        policy: 'frozen_prior', contextDecision: 'prior_calculation_frozen',
        sourceWindowChanged: liveEdited.start_time !== liveBefore.start_time
          && liveEdited.end_time !== liveBefore.end_time,
        originalCalculationUnchanged: JSON.stringify(preservedC0) === JSON.stringify(frozen),
        sourceFingerprintEqual: c1.source_definition_fingerprint === c0.source_definition_fingerprint,
        semanticPolicyDomainsVerified: true,
        semanticMergePolicyChanged: c1.semantic_input_fingerprint !== c0.semantic_input_fingerprint,
        frozenSnapshotKeysCompared: 6, priorWorkMinutes: Number(c0.projected_work_minutes),
        currentWorkMinutes: Number(c1.projected_work_minutes),
        versionAdvancedByOne: c1.version === c0.version + 1, nativeProjectionOwner: c1.parent.projection_owner,
        eventCount: Number(targetAfter.event_count),
      }))
    } finally {
      for (const [key, value] of Object.entries(ownedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
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
