/**
 * W3 / #4556 — writer-matrix zero-write coverage for shift segments (real DB, route-level).
 *
 * W3 has no authoritative calculator: even a mistakenly populated
 * ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED value cannot lift the guard.
 * multi-segment authoring is preview-only: every reference producer named in the W3
 * safety erratum must return a typed 422 and write nothing:
 *   fixed schedule apply/rebuild, automatic matching, draft/active assignment
 *   create/update, rotation rule create/update, generated rotation assignment
 *   create/update, shift-swap create/final approval, schedule-dispatch
 *   create/final approval — plus schedule publication (draft -> active reference).
 *
 * Delete returns a typed 409 with zero writes for every durable blocker and preserves
 * historical evidence; rejected/cancelled snapshots do not block, remain stored, and
 * reads redact the unresolvable raw shift UUID behind a neutral label.
 *
 * The concurrency legs prove the shared delete/reference lock protocol on real
 * PostgreSQL with pg_blocking_pids (never vacuously).
 *
 * House rules: unique org id per leg (shared DB stays clean); the global
 * attendance.settings row is snapshotted/restored around the auto-matching leg.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { MetaSheetServer as MetaSheetServerType } from '../../src/index'
import {
  restoreAttendanceSettingsRow,
  snapshotAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const GUARD_CODE = 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED'
const DELETE_BLOCKED_CODE = 'ATTENDANCE_SHIFT_DELETE_BLOCKED'
const CONVERSION_BLOCKED_CODE = 'ATTENDANCE_SHIFT_SEGMENT_CONVERSION_BLOCKED'
const DELETED_LABEL = 'Deleted or unavailable shift'

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

const codeOf = (r: HttpResponse) => r.body?.error?.code
// The typed 422's message embeds the `producer` of the guard that refused
// ("... so <producer> cannot use a multi-segment shift", attendance-shift-service.cjs).
// That makes the producer an observable ATTRIBUTION channel on the HTTP response: it
// identifies WHICH reference guard fail-closed, not merely that some guard did. Used by
// the P2-1 leg below to hold one specific writer site load-bearing on its own.
const messageOf = (r: HttpResponse) => String(r.body?.error?.message ?? '')

describeDb('W3 shift-segments writer matrix (real DB, route-level)', () => {
  let server: MetaSheetServerType | undefined
  let baseUrl = ''
  let pool: Pool
  let settingsSnapshot: AttendanceSettingsRowSnapshot

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('loopback port required')

    process.env.DATABASE_URL = dbUrl as string
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // The automatic-matching leg enables this env gate per request; it stays unset otherwise.
    delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = '*'

    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')
    settingsSnapshot = await snapshotAttendanceSettingsRow(pool)

    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
  }, 120000)

  afterAll(async () => {
    delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    if (server) await server.stop().catch(() => undefined)
    if (pool) {
      await restoreAttendanceSettingsRow(pool, settingsSnapshot).catch(() => undefined)
      await pool.end()
    }
  })

  function org(tag: string) {
    return `w3wm-${tag}-${randomUUID().slice(0, 8)}`
  }

  // Persist a `shadow` rollout-state row for an org (no env mutation). Factored out of
  // enableShadowPosture so the Gate A lock-in describe can seed rows for orgs it reaches only
  // via the wildcard — reusing the SAME INSERT text, so no new DML statement is introduced.
  async function insertShadowRolloutRow(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'shadow', 'w4c3b-p12-test', 'TEST_FIXTURE', 'w4c3b-p12-test', 1, NULL)`,
      [orgId],
    )
  }

  async function enableShadowPosture(orgId: string): Promise<void> {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
    await insertShadowRolloutRow(orgId)
  }

  async function mintToken(userId: string, tenantId?: string): Promise<string> {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin,attendance:approve,attendance:import')}`,
    )
    expect(res.status, res.raw).toBe(200)
    return (res.body as { token?: string })?.token ?? ''
  }

  async function seedActiveIdentity(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (
       id, email, username, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, created_at, updated_at
       ) VALUES ($1, $2, $1, 'W3 Writer Matrix User', 'x', 'user', '["attendance:admin"]'::jsonb,
                 true, false, 'activated', now(), now())
       ON CONFLICT (id) DO UPDATE
         SET is_active = true,
             activation_status = 'activated',
             permissions = '["attendance:admin"]'::jsonb`,
      [userId, `${userId}@example.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [userId, orgId],
    )
  }

  function authHeaders(token: string, orgId: string) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-org-id': orgId }
  }

  async function postJson(pathname: string, token: string, orgId: string, payload: unknown): Promise<HttpResponse> {
    return requestJson(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: authHeaders(token, orgId),
      body: JSON.stringify(payload ?? {}),
    })
  }

  async function putJson(pathname: string, token: string, orgId: string, payload: unknown): Promise<HttpResponse> {
    return requestJson(`${baseUrl}${pathname}`, {
      method: 'PUT',
      headers: authHeaders(token, orgId),
      body: JSON.stringify(payload ?? {}),
    })
  }

  async function countRows(table: string, orgId: string, extra = ''): Promise<number> {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE org_id = $1 ${extra}`, [orgId])
    return Number(r.rows[0]?.n ?? 0)
  }

  async function waitForBlockedPid(blockerPid: number): Promise<number> {
    const deadline = Date.now() + 10000
    for (;;) {
      const result = await pool.query(
        `SELECT pid
           FROM pg_stat_activity
          WHERE pid <> $1
            AND $1 = ANY(pg_blocking_pids(pid))
          ORDER BY pid`,
        [blockerPid],
      )
      const blockedPid = Number(result.rows[0]?.pid)
      if (Number.isInteger(blockedPid) && blockedPid > 0) return blockedPid
      if (Date.now() > deadline) {
        throw new Error(`no backend became blocked by pid ${blockerPid} (vacuous concurrency proof)`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function waitUntilBlockedBy(blockedPid: number, blockerPid: number): Promise<void> {
    const deadline = Date.now() + 10000
    for (;;) {
      const result = await pool.query('SELECT pg_blocking_pids($1)::int[] AS blockers', [blockedPid])
      if ((result.rows[0]?.blockers ?? []).includes(blockerPid)) return
      if (Date.now() > deadline) {
        throw new Error(`pid ${blockedPid} never blocked by ${blockerPid} (vacuous concurrency proof)`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async function expectBlockedOnScheduleLock(
    blockedPid: number,
    orgId: string,
    userIds: string[],
  ): Promise<void> {
    const result = await pool.query(
      `SELECT classid::bigint AS class_id,
              objid::bigint AS object_id,
              hashtext($2::text)::oid::bigint AS expected_class_id,
              ARRAY(
                SELECT hashtext(value)::oid::bigint
                  FROM unnest($3::text[]) AS value
              ) AS expected_object_ids
         FROM pg_locks
        WHERE pid = $1
          AND locktype = 'advisory'
          AND granted = false`,
      [blockedPid, `attendance-schedule:${orgId}`, userIds],
    )
    const matched = result.rows.some((row) => (
      Number(row.class_id) === Number(row.expected_class_id)
      && row.expected_object_ids.map(Number).includes(Number(row.object_id))
    ))
    if (!matched) throw new Error(`blocked on the wrong advisory key: ${JSON.stringify(result.rows)}`)
  }

  async function loadApprovalCursor(requestId: string): Promise<{ version: number; node: string }> {
    const result = await pool.query(
      `SELECT ai.version, ai.current_node_key
         FROM attendance_requests request
         JOIN approval_instances ai ON ai.id = request.approval_instance_id
        WHERE request.id = $1::uuid`,
      [requestId],
    )
    expect(result.rows).toHaveLength(1)
    expect(typeof result.rows[0].current_node_key).toBe('string')
    return {
      version: Number(result.rows[0].version),
      node: String(result.rows[0].current_node_key),
    }
  }

  async function expectRequestDecisionOperation(orgId: string, operationId: string): Promise<void> {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND operation_id = $2::uuid AND entrypoint = 'request_decision') AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND operation_id = $2::uuid AND entrypoint = 'request_decision') AS outbox`,
      [orgId, operationId],
    )
    expect(result.rows[0]).toEqual({ operations: 1, outbox: 1 })
  }

  async function loadPublishedCandidates(
    client: import('pg').PoolClient,
    input: { orgId: string; userId: string; workDates: string[] },
  ): Promise<any[]> {
    const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
    return plugin.__attendanceWorkDateResolverForTests.loadPublishedCandidatesForWorkDateResolver(
      {
        query: async (text: string, params?: unknown[]) =>
          (await client.query(text, params as never[])).rows,
      },
      { ...input, lockScheduleFacts: true },
    )
  }

  async function segmentCount(shiftId: string): Promise<number> {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM attendance_shift_segments WHERE shift_id = $1', [shiftId])
    return Number(r.rows[0]?.n ?? 0)
  }

  async function createShiftViaApi(token: string, orgId: string, payload: Record<string, unknown>): Promise<HttpResponse> {
    return postJson('/api/attendance/shifts', token, orgId, payload)
  }

  /** Multi-segment shift M (08:00-12:00 + 13:00-17:00) authored via the preview-only API. */
  async function createMultiShift(token: string, orgId: string, name = 'Split'): Promise<string> {
    const res = await createShiftViaApi(token, orgId, {
      name,
      timezone: 'UTC',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(res.status, res.raw).toBe(201)
    return res.body.data.id as string
  }

  async function seedPublishedAssignment(orgId: string, userId: string, shiftId: string, workDate: string): Promise<string> {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shift_assignments
       (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, 0, $5, $5, true, 'published', 'regular')`,
      [id, orgId, userId, shiftId, workDate],
    )
    return id
  }

  /** Convert a single-segment shift to multi-segment beneath the API (simulates flag-ON legacy state). */
  async function injectSecondSegment(orgId: string, shiftId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shift_segments
       (id, org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
       VALUES ($1, $2, $3, 1, '13:00', 0, '17:00', 0)`,
      [randomUUID(), orgId, shiftId],
    )
  }

  /** Dispatch create requires exactly one active schedule_dispatch approval flow per org. */
  async function seedDispatchFlow(token: string, orgId: string): Promise<void> {
    const flow = await postJson('/api/attendance/approval-flows', token, orgId, {
      name: `${orgId}-dispatch-flow`,
      requestType: 'schedule_dispatch',
      isActive: true,
      steps: [],
    })
    expect(flow.status, flow.raw).toBe(201)
  }

  async function seedScheduleGroup(orgId: string): Promise<string> {
    const scheduleGroupId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_schedule_groups (id, org_id, name, code, source, is_active)
       VALUES ($1, $2, $3, $4, 'manual', true)`,
      [scheduleGroupId, orgId, `${orgId}-sg`, `${orgId}-sgc`],
    )
    return scheduleGroupId
  }

  it('creates a legacy-envelope shift with a persisted segment 0 (dual-write)', async () => {
    const orgId = org('create-legacy')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const res = await createShiftViaApi(token, orgId, { name: 'Day', timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00' })
    expect(res.status, res.raw).toBe(201)
    const shift = res.body.data
    expect(shift.calculationMode).toBe('envelope')
    expect(shift.plannedMinutes).toBe(540)
    expect(shift.segments).toHaveLength(1)
    expect(shift.segments[0]).toMatchObject({ segmentIndex: 0, startTime: '09:00', endTime: '18:00', endDayOffset: 0 })
    expect(shift.capabilities.segmentCalculation).toMatchObject({
      enabled: false,
      defaultEnabled: false,
      authoritativeResults: false,
      multiSegmentAuthoring: 'preview_only',
      flag: 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',
    })
    expect(await segmentCount(shift.id)).toBe(1)
  })

  it('creates a multi-segment shift with derived envelope and preview-only capability', async () => {
    const orgId = org('create-multi')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const res = await createShiftViaApi(token, orgId, {
      name: 'Split',
      timezone: 'UTC',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(res.status, res.raw).toBe(201)
    const shift = res.body.data
    expect(shift.calculationMode).toBe('segments')
    // R1: sum of segment minutes — the 60-minute break is never payable time.
    expect(shift.plannedMinutes).toBe(480)
    // Legacy envelope fields pass through mapShiftRow unchanged (pre-existing HH:MM:SS shape).
    expect(shift.workStartTime).toBe('08:00:00')
    expect(shift.workEndTime).toBe('17:00:00')
    expect(shift.isOvernight).toBe(false)
    expect(shift.segments).toHaveLength(2)
    expect(await segmentCount(shift.id)).toBe(2)

    const detail = await requestJson(`${baseUrl}/api/attendance/shifts/${shift.id}`, { headers: authHeaders(token, orgId) })
    expect(detail.status, detail.raw).toBe(200)
    expect(detail.body.data.segments).toHaveLength(2)

    const list = await requestJson(`${baseUrl}/api/attendance/shifts?page=1&pageSize=10`, { headers: authHeaders(token, orgId) })
    expect(list.status, list.raw).toBe(200)
    const listed = list.body.data.items.find((item: any) => item.id === shift.id)
    expect(listed.segments).toHaveLength(2)
    expect(listed.plannedMinutes).toBe(480)
  })

  it('rejects invalid segment arrays with a typed 422 and zero writes', async () => {
    const orgId = org('create-invalid')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const before = await countRows('attendance_shifts', orgId)

    const overlap = await createShiftViaApi(token, orgId, {
      name: 'Bad',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '11:00', endTime: '15:00' },
      ],
    })
    expect(overlap.status, overlap.raw).toBe(422)
    expect(codeOf(overlap)).toBe('ATTENDANCE_SHIFT_SEGMENTS_INVALID')

    const twoCrossings = await createShiftViaApi(token, orgId, {
      name: 'Bad2',
      segments: [
        { startTime: '20:00', endTime: '23:00', endDayOffset: 1 },
        { startTime: '23:30', endTime: '01:00', endDayOffset: 1 },
      ],
    })
    expect(twoCrossings.status, twoCrossings.raw).toBe(422)
    expect(codeOf(twoCrossings)).toBe('ATTENDANCE_SHIFT_SEGMENTS_INVALID')

    const ambiguous = await createShiftViaApi(token, orgId, {
      name: 'Bad3',
      workStartTime: '09:00',
      segments: [{ startTime: '09:00', endTime: '17:00' }],
    })
    expect(ambiguous.status, ambiguous.raw).toBe(422)
    expect(codeOf(ambiguous)).toBe('ATTENDANCE_SHIFT_SEGMENT_MODE_AMBIGUOUS')

    expect(await countRows('attendance_shifts', orgId)).toBe(before)
  })

  it('metadata-only PUT preserves segments; start/end-only PUT on a multi-segment shift is rejected', async () => {
    const orgId = org('put-modes')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const multiId = await createMultiShift(token, orgId)

    const metadata = await putJson(`/api/attendance/shifts/${multiId}`, token, orgId, { name: 'Split Renamed', lateGraceMinutes: 7 })
    expect(metadata.status, metadata.raw).toBe(200)
    expect(metadata.body.data.segments).toHaveLength(2)
    expect(metadata.body.data.name).toBe('Split Renamed')
    expect(metadata.body.data.plannedMinutes).toBe(480)

    const collapse = await putJson(`/api/attendance/shifts/${multiId}`, token, orgId, { workStartTime: '07:00', workEndTime: '19:00' })
    expect(collapse.status, collapse.raw).toBe(422)
    expect(codeOf(collapse)).toBe('ATTENDANCE_SHIFT_ENVELOPE_COLLAPSE_REJECTED')
    const persisted = await pool.query(
      'SELECT start_time, end_time FROM attendance_shift_segments WHERE shift_id = $1 ORDER BY segment_index',
      [multiId],
    )
    expect(persisted.rows.map((row) => `${row.start_time}-${row.end_time}`)).toEqual(['08:00:00-12:00:00', '13:00:00-17:00:00'])

    // Legacy envelope write on a single-segment shift updates envelope and segment 0 together.
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const envelopePut = await putJson(`/api/attendance/shifts/${singleId}`, token, orgId, { workStartTime: '10:00', workEndTime: '19:00' })
    expect(envelopePut.status, envelopePut.raw).toBe(200)
    expect(envelopePut.body.data.workStartTime).toBe('10:00:00')
    expect(envelopePut.body.data.segments[0]).toMatchObject({ startTime: '10:00', endTime: '19:00' })

    // Segments PUT on an UNREFERENCED shift may convert 1 -> 2 (authoring preview).
    const convert = await putJson(`/api/attendance/shifts/${singleId}`, token, orgId, {
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(convert.status, convert.raw).toBe(200)
    expect(convert.body.data.calculationMode).toBe('segments')
    expect(convert.body.data.workStartTime).toBe('08:00:00')
    expect(convert.body.data.workEndTime).toBe('17:00:00')
  })

  it('blocks converting one segment to multiple while an active assignment references the shift', async () => {
    const orgId = org('put-conversion')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const created = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const shiftId = created.body.data.id as string
    await seedPublishedAssignment(orgId, `${orgId}-worker`, shiftId, '2049-06-10')

    const res = await putJson(`/api/attendance/shifts/${shiftId}`, token, orgId, {
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(res.status, res.raw).toBe(409)
    expect(codeOf(res)).toBe(CONVERSION_BLOCKED_CODE)
    expect(await segmentCount(shiftId)).toBe(1)
  })

  it('blocks converting one segment to multiple when only ended assignment history references the shift', async () => {
    const orgId = org('put-ended-conversion')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const created = await createShiftViaApi(token, orgId, { name: 'Historic Day', workStartTime: '09:00', workEndTime: '18:00' })
    const shiftId = created.body.data.id as string
    await seedPublishedAssignment(orgId, `${orgId}-worker`, shiftId, '2020-01-06')

    const res = await putJson(`/api/attendance/shifts/${shiftId}`, token, orgId, {
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(res.status, res.raw).toBe(409)
    expect(codeOf(res)).toBe(CONVERSION_BLOCKED_CODE)
    expect((res.body?.error?.details ?? []).map((detail: any) => detail.field)).toContain('shift_assignments')
    expect(await segmentCount(shiftId)).toBe(1)
  })

  it('fails closed before a historical import can calculate a forced multi-segment shift with the legacy envelope', async () => {
    const orgId = randomUUID()
    const userId = randomUUID()
    const adminId = randomUUID()
    const workDate = '2020-01-06'
    await seedActiveIdentity(adminId, orgId)
    await seedActiveIdentity(userId, orgId)
    const token = await mintToken(adminId, orgId)
    const created = await createShiftViaApi(token, orgId, {
      name: 'Historic Split',
      timezone: 'UTC',
      workStartTime: '08:00',
      workEndTime: '17:00',
    })
    const shiftId = created.body.data.id as string
    await seedPublishedAssignment(orgId, userId, shiftId, workDate)

    // Simulate a legacy/direct-DB invalid state that bypassed the authoring guard.
    // The compatibility envelope spans 540 minutes; the two segments sum to 480.
    await pool.query(
      `UPDATE attendance_shift_segments
          SET end_time = '12:00'
        WHERE org_id = $1 AND shift_id = $2 AND segment_index = 0`,
      [orgId, shiftId],
    )
    await injectSecondSegment(orgId, shiftId)
    expect(await segmentCount(shiftId)).toBe(2)

    const imported = await postJson('/api/attendance/import', token, orgId, {
      userId,
      mode: 'override',
      rows: [{
        workDate,
        fields: {
          firstInAt: `${workDate}T08:00:00Z`,
          lastOutAt: `${workDate}T17:00:00Z`,
        },
      }],
    })
    expect(imported.status, imported.raw).toBe(422)
    expect(codeOf(imported)).toBe(GUARD_CODE)

    const records = await pool.query(
      'SELECT work_minutes FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3',
      [orgId, userId, workDate],
    )
    expect(records.rows).toHaveLength(0)
  })

  it('fails closed before a punch can calculate a forced multi-segment shift with the legacy envelope', async () => {
    const orgId = org('runtime-punch-guard')
    const userId = `${orgId}-worker`
    const workDate = '2024-10-07'
    const token = await mintToken(userId, orgId)
    const created = await createShiftViaApi(token, orgId, {
      name: 'Punch Split',
      timezone: 'UTC',
      workStartTime: '08:00',
      workEndTime: '17:00',
    })
    const shiftId = created.body.data.id as string
    await seedPublishedAssignment(orgId, userId, shiftId, workDate)

    await pool.query(
      `UPDATE attendance_shift_segments
          SET end_time = '12:00'
        WHERE org_id = $1 AND shift_id = $2 AND segment_index = 0`,
      [orgId, shiftId],
    )
    await injectSecondSegment(orgId, shiftId)
    expect(await segmentCount(shiftId)).toBe(2)

    const punch = await postJson('/api/attendance/punch', token, orgId, {
      eventType: 'check_in',
      occurredAt: `${workDate}T08:00:00Z`,
      timezone: 'UTC',
    })
    expect(punch.status, punch.raw).toBe(422)
    expect(codeOf(punch)).toBe(GUARD_CODE)

    const [events, records] = await Promise.all([
      pool.query(
        'SELECT id FROM attendance_events WHERE org_id = $1 AND user_id = $2 AND work_date = $3',
        [orgId, userId, workDate],
      ),
      pool.query(
        'SELECT id FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3',
        [orgId, userId, workDate],
      ),
    ])
    expect(events.rows).toHaveLength(0)
    expect(records.rows).toHaveLength(0)
  })

  it('rename + rejected segment conversion is atomic and leaves legacy rotation rules untouched', async () => {
    const orgId = org('put-rename-atomic')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const created = await createShiftViaApi(token, orgId, {
      name: 'Legacy Named',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })
    const shiftId = created.body.data.id as string
    await seedPublishedAssignment(orgId, `${orgId}-worker`, shiftId, '2049-06-10')
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Legacy Rule', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify(['Legacy Named'])],
    )

    const rejected = await putJson(`/api/attendance/shifts/${shiftId}`, token, orgId, {
      name: 'Renamed',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(rejected.status, rejected.raw).toBe(409)
    expect(codeOf(rejected)).toBe(CONVERSION_BLOCKED_CODE)

    const persisted = await pool.query(
      `SELECT s.name, r.shift_sequence
         FROM attendance_shifts s
         JOIN attendance_rotation_rules r ON r.id = $2
        WHERE s.id = $1`,
      [shiftId, ruleId],
    )
    expect(persisted.rows[0].name).toBe('Legacy Named')
    expect(persisted.rows[0].shift_sequence).toEqual(['Legacy Named'])
    expect(await segmentCount(shiftId)).toBe(1)
  })

  it('rename normalization rolls back when the later shift update fails', async () => {
    const orgId = org('rename-update-failure')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const created = await createShiftViaApi(token, orgId, {
      name: 'Atomic Legacy Name',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })
    const shiftId = created.body.data.id as string
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Atomic Legacy Rule', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify(['Atomic Legacy Name'])],
    )

    await pool.query(`
      CREATE OR REPLACE FUNCTION w3wm_fail_named_shift_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.name LIKE 'W3WM_FAIL_%' THEN
          RAISE EXCEPTION 'forced W3 shift update failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await pool.query('DROP TRIGGER IF EXISTS w3wm_fail_named_shift_update ON attendance_shifts')
    await pool.query(`
      CREATE TRIGGER w3wm_fail_named_shift_update
      BEFORE UPDATE ON attendance_shifts
      FOR EACH ROW EXECUTE FUNCTION w3wm_fail_named_shift_update()
    `)

    try {
      const rejected = await putJson(`/api/attendance/shifts/${shiftId}`, token, orgId, {
        name: 'W3WM_FAIL_Renamed',
      })
      expect(rejected.status, rejected.raw).toBe(500)

      const persisted = await pool.query(
        `SELECT s.name, r.shift_sequence
           FROM attendance_shifts s
           JOIN attendance_rotation_rules r ON r.id = $2
          WHERE s.id = $1`,
        [shiftId, ruleId],
      )
      expect(persisted.rows[0].name).toBe('Atomic Legacy Name')
      expect(persisted.rows[0].shift_sequence).toEqual(['Atomic Legacy Name'])
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS w3wm_fail_named_shift_update ON attendance_shifts')
      await pool.query('DROP FUNCTION IF EXISTS w3wm_fail_named_shift_update()')
    }
  })

  it('cross-org: a shift is invisible and unreferenceable from another org', async () => {
    const orgX = org('xorg-x')
    const orgY = org('xorg-y')
    const tokenX = await mintToken(`${orgX}-admin`, orgX)
    const tokenY = await mintToken(`${orgY}-admin`, orgY)
    const multiId = await createMultiShift(tokenX, orgX)

    const detail = await requestJson(`${baseUrl}/api/attendance/shifts/${multiId}`, { headers: authHeaders(tokenY, orgY) })
    expect(detail.status, detail.raw).toBe(404)

    const assignment = await postJson('/api/attendance/assignments', tokenY, orgY, {
      userId: `${orgY}-worker`,
      shiftId: multiId,
      startDate: '2049-06-10',
    })
    expect(assignment.status, assignment.raw).toBe(404)
    expect(codeOf(assignment)).toBe('NOT_FOUND')
    expect(await countRows('attendance_shift_assignments', orgY)).toBe(0)
  })

  it('matrix: draft + active assignment create/update return typed 422 with zero writes', async () => {
    const orgId = org('matrix-assign')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const multiId = await createMultiShift(token, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string

    const draftCreate = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: multiId,
      startDate: '2049-06-10',
    })
    expect(draftCreate.status, draftCreate.raw).toBe(422)
    expect(codeOf(draftCreate)).toBe(GUARD_CODE)

    const activeCreate = await postJson('/api/attendance/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: multiId,
      startDate: '2049-06-10',
    })
    expect(activeCreate.status, activeCreate.raw).toBe(422)
    expect(codeOf(activeCreate)).toBe(GUARD_CODE)
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)

    // Update legs: a valid row on the single shift must not be re-pointed at M.
    const draft = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: singleId,
      startDate: '2049-06-10',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string
    const draftUpdate = await putJson(`/api/attendance/schedule-drafts/assignments/${draftId}`, token, orgId, { shiftId: multiId })
    expect(draftUpdate.status, draftUpdate.raw).toBe(422)
    expect(codeOf(draftUpdate)).toBe(GUARD_CODE)

    const active = await postJson('/api/attendance/assignments', token, orgId, {
      userId: `${orgId}-worker-2`,
      shiftId: singleId,
      startDate: '2049-06-10',
    })
    expect(active.status, active.raw).toBe(201)
    const activeId = active.body.data.assignment.id as string
    const activeUpdate = await putJson(`/api/attendance/assignments/${activeId}`, token, orgId, { shiftId: multiId })
    expect(activeUpdate.status, activeUpdate.raw).toBe(422)
    expect(codeOf(activeUpdate)).toBe(GUARD_CODE)

    const rows = await pool.query(
      'SELECT id, shift_id FROM attendance_shift_assignments WHERE org_id = $1',
      [orgId],
    )
    expect(rows.rows).toHaveLength(2)
    for (const row of rows.rows) expect(row.shift_id).toBe(singleId)
  })

  it('matrix: rotation rule create/update return typed 422 with zero writes', async () => {
    const orgId = org('matrix-rules')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const multiId = await createMultiShift(token, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string

    const create = await postJson('/api/attendance/rotation-rules', token, orgId, {
      name: 'Rotate',
      shiftSequence: [singleId, multiId],
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_rotation_rules', orgId)).toBe(0)

    const okRule = await postJson('/api/attendance/rotation-rules', token, orgId, {
      name: 'Rotate',
      shiftSequence: [singleId],
    })
    expect(okRule.status, okRule.raw).toBe(201)
    const ruleId = okRule.body.data.id as string
    const update = await putJson(`/api/attendance/rotation-rules/${ruleId}`, token, orgId, {
      shiftSequence: [singleId, multiId],
    })
    expect(update.status, update.raw).toBe(422)
    expect(codeOf(update)).toBe(GUARD_CODE)
    const persisted = await pool.query('SELECT shift_sequence FROM attendance_rotation_rules WHERE id = $1', [ruleId])
    expect(persisted.rows[0].shift_sequence).toEqual([singleId])
  })

  it('matrix: generated rotation assignment create/update (draft + active) return typed 422 with zero writes', async () => {
    const orgId = org('matrix-rotasgn')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const multiId = await createMultiShift(token, orgId)
    // Rule seeded directly: the API create would (correctly) 422 on M.
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Rotate', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify([multiId])],
    )

    const draftCreate = await postJson('/api/attendance/schedule-drafts/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: ruleId,
      startDate: '2049-06-10',
    })
    expect(draftCreate.status, draftCreate.raw).toBe(422)
    expect(codeOf(draftCreate)).toBe(GUARD_CODE)

    const activeCreate = await postJson('/api/attendance/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: ruleId,
      startDate: '2049-06-10',
    })
    expect(activeCreate.status, activeCreate.raw).toBe(422)
    expect(codeOf(activeCreate)).toBe(GUARD_CODE)
    expect(await countRows('attendance_rotation_assignments', orgId)).toBe(0)

    // Update legs: valid rows on a single-shift rule must not survive the rule gaining M.
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const singleRuleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'RotateSingle', 'UTC', $3::jsonb, true)`,
      [singleRuleId, orgId, JSON.stringify([singleId])],
    )
    const draft = await postJson('/api/attendance/schedule-drafts/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: singleRuleId,
      startDate: '2049-06-10',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string
    const active = await postJson('/api/attendance/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker-2`,
      rotationRuleId: singleRuleId,
      startDate: '2049-06-10',
    })
    expect(active.status, active.raw).toBe(201)
    const activeId = active.body.data.assignment.id as string

    // The rule's sequence gains M beneath the API (flag-ON legacy state); both updates must fail closed.
    await pool.query('UPDATE attendance_rotation_rules SET shift_sequence = $2::jsonb WHERE id = $1', [singleRuleId, JSON.stringify([singleId, multiId])])
    const draftUpdate = await putJson(`/api/attendance/schedule-drafts/rotation-assignments/${draftId}`, token, orgId, { startDate: '2049-06-11' })
    expect(draftUpdate.status, draftUpdate.raw).toBe(422)
    expect(codeOf(draftUpdate)).toBe(GUARD_CODE)
    const activeUpdate = await putJson(`/api/attendance/rotation-assignments/${activeId}`, token, orgId, { startDate: '2049-06-11' })
    expect(activeUpdate.status, activeUpdate.raw).toBe(422)
    expect(codeOf(activeUpdate)).toBe(GUARD_CODE)
    const dates = await pool.query(
      'SELECT id, start_date::text AS start_date FROM attendance_rotation_assignments WHERE org_id = $1 ORDER BY id',
      [orgId],
    )
    for (const row of dates.rows) expect(String(row.start_date).slice(0, 10)).toBe('2049-06-10')
  })

  it('legacy duplicate-name rotation references fail closed when any matching shift is multi-segment', async () => {
    const orgId = org('matrix-legacy-name')
    const token = await mintToken(`${orgId}-admin`, orgId)
    await createShiftViaApi(token, orgId, {
      name: 'Duplicate',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })
    await createMultiShift(token, orgId, 'Duplicate')
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Legacy Duplicate Rule', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify(['Duplicate'])],
    )

    const create = await postJson('/api/attendance/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: ruleId,
      startDate: '2049-06-10',
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_rotation_assignments', orgId)).toBe(0)
  })

  it('matrix: fixed schedule apply and rebuild return typed 422 with zero writes', async () => {
    const orgId = org('matrix-fixed')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const multiId = await createMultiShift(token, orgId)

    const group = await postJson('/api/attendance/groups', token, orgId, {
      name: `${orgId}-group`,
      timezone: 'UTC',
      attendanceType: 'fixed_shift',
    })
    expect(group.status, group.raw).toBe(200)
    const groupId = group.body.data.id as string
    const members = await postJson(`/api/attendance/groups/${groupId}/members`, token, orgId, { userIds: [`${orgId}-worker`] })
    expect(members.status, members.raw).toBe(200)

    const apply = await postJson(`/api/attendance/groups/${groupId}/fixed-schedule/apply`, token, orgId, {
      shiftId: multiId,
      startDate: '2049-06-01',
      endDate: '2049-06-30',
    })
    expect(apply.status, apply.raw).toBe(422)
    expect(codeOf(apply)).toBe(GUARD_CODE)

    const rebuild = await postJson(`/api/attendance/groups/${groupId}/fixed-schedule/rebuild`, token, orgId, {
      shiftId: multiId,
      startDate: '2049-06-01',
      endDate: '2049-06-30',
    })
    expect(rebuild.status, rebuild.raw).toBe(422)
    expect(codeOf(rebuild)).toBe(GUARD_CODE)
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)
  })

  it('matrix: shift-swap create returns typed 422 with zero writes', async () => {
    const orgId = org('matrix-swap')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const multiId = await createMultiShift(token, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'Other', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const assignmentA = await seedPublishedAssignment(orgId, `${orgId}-a`, multiId, '2049-06-14')
    const assignmentB = await seedPublishedAssignment(orgId, `${orgId}-b`, singleId, '2049-06-15')

    const create = await postJson('/api/attendance/shift-swap-requests', token, orgId, {
      requesterAssignmentId: assignmentA,
      counterpartyAssignmentId: assignmentB,
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_shift_swap_requests', orgId)).toBe(0)
    expect(await countRows('attendance_requests', orgId)).toBe(0)
    await pool.query('DELETE FROM attendance_shift_assignments WHERE org_id = $1', [orgId])
  })

  it('matrix: schedule-dispatch create returns typed 422 with zero writes', async () => {
    const orgId = org('matrix-dispatch')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const multiId = await createMultiShift(token, orgId)
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)

    const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: multiId,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_schedule_dispatch_requests', orgId)).toBe(0)
    expect(await countRows('attendance_requests', orgId)).toBe(0)
  })

  it('P12: dedicated shift-swap and schedule-dispatch creates append version-1 snapshots', async () => {
    const orgId = randomUUID()
    const actorId = `${orgId}-admin`
    await seedActiveIdentity(actorId, orgId)
    const token = await mintToken(actorId, orgId)
    await enableShadowPosture(orgId)

    const requesterShift = (await createShiftViaApi(token, orgId, {
      name: 'P12 requester',
      workStartTime: '09:00',
      workEndTime: '13:00',
    })).body.data.id as string
    const counterpartyShift = (await createShiftViaApi(token, orgId, {
      name: 'P12 counterparty',
      workStartTime: '14:00',
      workEndTime: '18:00',
    })).body.data.id as string
    const requesterAssignmentId = await seedPublishedAssignment(
      orgId,
      actorId,
      requesterShift,
      '2049-06-14',
    )
    const counterpartyAssignmentId = await seedPublishedAssignment(
      orgId,
      `${orgId}-counterparty`,
      counterpartyShift,
      '2049-06-15',
    )
    const swap = await postJson('/api/attendance/shift-swap-requests', token, orgId, {
      requesterAssignmentId,
      counterpartyAssignmentId,
      operationId: randomUUID(),
    })
    expect(swap.status, swap.raw).toBe(201)
    expect(swap.body.data.requestSnapshot).toMatchObject({ version: 1 })
    const swapRequestId = swap.body.data.request.id as string

    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)
    const dispatchUserId = `${orgId}-dispatch-user`
    await seedActiveIdentity(dispatchUserId, orgId)
    const dispatch = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: dispatchUserId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: requesterShift,
      startDate: '2049-06-16',
      endDate: '2049-06-16',
      operationId: randomUUID(),
    })
    expect(dispatch.status, dispatch.raw).toBe(201)
    expect(dispatch.body.data.requestSnapshot).toMatchObject({ version: 1 })
    const dispatchRequestId = dispatch.body.data.request.id as string

    const snapshots = await pool.query(
      `SELECT request_id::text AS request_id, version, request_type
         FROM attendance_request_calculation_snapshots
        WHERE org_id = $1 AND request_id = ANY($2::uuid[])
        ORDER BY request_type`,
      [orgId, [swapRequestId, dispatchRequestId]],
    )
    expect(snapshots.rows).toEqual([
      { request_id: dispatchRequestId, version: 1, request_type: 'schedule_dispatch' },
      { request_id: swapRequestId, version: 1, request_type: 'shift_swap' },
    ])
  })

  it('matrix: schedule publication fails closed when a draft shift became multi-segment', async () => {
    const orgId = org('matrix-publish')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const draft = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: singleId,
      startDate: '2049-06-10',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string

    // The shift is converted 1 -> 2 beneath the API (drafts deliberately do not block
    // authoring); publication is the last fail-closed gate before an active reference exists.
    await injectSecondSegment(orgId, singleId)
    const publish = await postJson('/api/attendance/schedule-publications', token, orgId, { assignmentIds: [draftId] })
    expect(publish.status, publish.raw).toBe(422)
    expect(codeOf(publish)).toBe(GUARD_CODE)
    const persisted = await pool.query('SELECT publish_status FROM attendance_shift_assignments WHERE id = $1', [draftId])
    expect(persisted.rows[0].publish_status).toBe('draft')
  })

  it('P27: schedule publication consumes the canonical posture seam before publishing a multi-segment reference', async () => {
    const orgId = randomUUID()
    const token = await mintToken(`${orgId}-admin`, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'P27 Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const draft = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: singleId,
      startDate: '2049-06-11',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string

    await injectSecondSegment(orgId, singleId)
    await enableShadowPosture(orgId)
    const publish = await postJson('/api/attendance/schedule-publications', token, orgId, { assignmentIds: [draftId] })
    expect(publish.status, publish.raw).toBe(200)
    const persisted = await pool.query('SELECT publish_status FROM attendance_shift_assignments WHERE id = $1', [draftId])
    expect(persisted.rows[0].publish_status).toBe('published')
  })

  it('P27: rotation publication consumes the same posture seam before publishing a multi-segment reference', async () => {
    const orgId = randomUUID()
    const token = await mintToken(`${orgId}-admin`, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'P27 Rotation Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const rule = await postJson('/api/attendance/rotation-rules', token, orgId, {
      name: 'P27 Rotation',
      shiftSequence: [singleId],
    })
    expect(rule.status, rule.raw).toBe(201)
    const ruleId = rule.body.data.id as string
    const draft = await postJson('/api/attendance/schedule-drafts/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: ruleId,
      startDate: '2049-06-12',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string

    await injectSecondSegment(orgId, singleId)
    await enableShadowPosture(orgId)
    const publish = await postJson('/api/attendance/schedule-publications', token, orgId, {
      rotationAssignmentIds: [draftId],
    })
    expect(publish.status, publish.raw).toBe(200)
    const persisted = await pool.query('SELECT publish_status FROM attendance_rotation_assignments WHERE id = $1', [draftId])
    expect(persisted.rows[0].publish_status).toBe('published')
  })

  it('P27: calculation-first holds the shared schedule context until publication can commit', async () => {
    const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
    const loadCandidates = plugin.__attendanceWorkDateResolverForTests.loadPublishedCandidatesForWorkDateResolver
    const orgId = randomUUID()
    const userId = `${orgId}-worker`
    const workDate = '2049-06-17'
    const token = await mintToken(`${orgId}-admin`, orgId)
    const shiftId = (await createShiftViaApi(token, orgId, {
      name: 'P27 calculation first',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })).body.data.id as string
    const draft = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId,
      shiftId,
      startDate: workDate,
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string
    await enableShadowPosture(orgId)

    const calculationClient = await pool.connect()
    try {
      const calculationPid = Number((await calculationClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await calculationClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const calculationTrx = {
        query: async (text: string, params?: unknown[]) =>
          (await calculationClient.query(text, params as never[])).rows,
      }
      const frozenCandidates = await loadCandidates(calculationTrx, {
        orgId,
        userId,
        workDates: [workDate],
        lockScheduleFacts: true,
      })
      expect(frozenCandidates).toEqual([])

      const publishPromise = postJson('/api/attendance/schedule-publications', token, orgId, {
        assignmentIds: [draftId],
      })
      await waitForBlockedPid(calculationPid)
      await calculationClient.query('COMMIT')

      const publish = await publishPromise
      expect(publish.status, publish.raw).toBe(200)
      const persisted = await pool.query(
        'SELECT publish_status FROM attendance_shift_assignments WHERE id = $1',
        [draftId],
      )
      expect(persisted.rows[0].publish_status).toBe('published')
    } finally {
      await calculationClient.query('ROLLBACK').catch(() => undefined)
      calculationClient.release()
    }
  })

  it('P27: publication-first holds the exclusive schedule context without mixing the calculation snapshot', async () => {
    const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
    const loadCandidates = plugin.__attendanceWorkDateResolverForTests.loadPublishedCandidatesForWorkDateResolver
    const orgId = randomUUID()
    const userId = `${orgId}-worker`
    const workDate = '2049-06-18'
    const token = await mintToken(`${orgId}-admin`, orgId)
    const shiftId = (await createShiftViaApi(token, orgId, {
      name: 'P27 publication first',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })).body.data.id as string
    const draft = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId,
      shiftId,
      startDate: workDate,
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string
    await enableShadowPosture(orgId)

    const suffix = randomUUID().replaceAll('-', '')
    const functionName = `w4c3b_p27_pause_${suffix}`
    const triggerName = `w4c3b_p27_pause_${suffix}`
    const pauseKey = BigInt(`0x${suffix.slice(0, 15)}`).toString()
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
       BEGIN
         IF NEW.id = '${draftId}'::uuid THEN
           PERFORM pg_advisory_xact_lock(${pauseKey}::bigint);
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await pool.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE UPDATE ON attendance_shift_assignments
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    )

    const pauseClient = await pool.connect()
    const calculationClient = await pool.connect()
    try {
      await pauseClient.query('BEGIN')
      const pausePid = Number((await pauseClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await pauseClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [pauseKey])

      const publishPromise = postJson('/api/attendance/schedule-publications', token, orgId, {
        assignmentIds: [draftId],
      })
      const publicationPid = await waitForBlockedPid(pausePid)

      const calculationPid = Number((await calculationClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await calculationClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const calculationTrx = {
        query: async (text: string, params?: unknown[]) =>
          (await calculationClient.query(text, params as never[])).rows,
      }
      const candidatesPromise = loadCandidates(calculationTrx, {
        orgId,
        userId,
        workDates: [workDate],
        lockScheduleFacts: true,
      })
      await waitUntilBlockedBy(calculationPid, publicationPid)

      await pauseClient.query('COMMIT')
      const publish = await publishPromise
      expect(publish.status, publish.raw).toBe(200)
      const candidates = await candidatesPromise
      // SERIALIZABLE fixes its snapshot on the shared-lock statement before it
      // waits. This overlapping transaction therefore remains wholly before the
      // publication; it must not splice the newly committed row into that frozen
      // context. A fresh transaction below observes the complementary state.
      expect(candidates).toEqual([])
      await calculationClient.query('COMMIT')

      const freshClient = await pool.connect()
      let freshCandidates
      try {
        await freshClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        freshCandidates = await loadCandidates({
          query: async (text: string, params?: unknown[]) =>
            (await freshClient.query(text, params as never[])).rows,
        }, {
          orgId,
          userId,
          workDates: [workDate],
          lockScheduleFacts: true,
        })
        await freshClient.query('COMMIT')
      } finally {
        await freshClient.query('ROLLBACK').catch(() => undefined)
        freshClient.release()
      }
      expect(freshCandidates).toHaveLength(1)
      expect(freshCandidates[0]).toMatchObject({
        orgId,
        userId,
        workDate,
        shiftId,
        assignmentId: draftId,
        source: 'shift',
      })
    } finally {
      await pauseClient.query('ROLLBACK').catch(() => undefined)
      await calculationClient.query('ROLLBACK').catch(() => undefined)
      pauseClient.release()
      calculationClient.release()
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON attendance_shift_assignments`).catch(() => undefined)
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined)
    }
  })

  it('P18: calculation-first serializes shift-swap finalization through the request operation boundary', async () => {
    const orgId = randomUUID()
    const requesterId = randomUUID()
    const counterpartyId = randomUUID()
    const lockProbeDate = '2049-06-18'
    const requesterDate = '2049-06-19'
    const counterpartyDate = '2049-06-20'
    await seedActiveIdentity(requesterId, orgId)
    await seedActiveIdentity(counterpartyId, orgId)
    const requesterToken = await mintToken(requesterId, orgId)
    const counterpartyToken = await mintToken(counterpartyId, orgId)
    await enableShadowPosture(orgId)

    const requesterShift = (await createShiftViaApi(requesterToken, orgId, {
      name: 'P18 requester shift', workStartTime: '09:00', workEndTime: '13:00',
    })).body.data.id as string
    const counterpartyShift = (await createShiftViaApi(requesterToken, orgId, {
      name: 'P18 counterparty shift', workStartTime: '14:00', workEndTime: '18:00',
    })).body.data.id as string
    const requesterAssignmentId = await seedPublishedAssignment(
      orgId, requesterId, requesterShift, requesterDate,
    )
    const counterpartyAssignmentId = await seedPublishedAssignment(
      orgId, counterpartyId, counterpartyShift, counterpartyDate,
    )
    const create = await postJson('/api/attendance/shift-swap-requests', requesterToken, orgId, {
      requesterAssignmentId,
      counterpartyAssignmentId,
      operationId: randomUUID(),
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string
    const accept = await postJson(
      `/api/attendance/shift-swap-requests/${requestId}/accept`,
      counterpartyToken,
      orgId,
      { operationId: randomUUID() },
    )
    expect(accept.status, accept.raw).toBe(200)
    const approval = await loadApprovalCursor(requestId)

    const calculationClient = await pool.connect()
    try {
      const calculationPid = Number((await calculationClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await calculationClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const frozenRequester = await loadPublishedCandidates(calculationClient, {
        orgId, userId: requesterId, workDates: [lockProbeDate],
      })
      const frozenCounterparty = await loadPublishedCandidates(calculationClient, {
        orgId, userId: counterpartyId, workDates: [lockProbeDate],
      })
      expect(frozenRequester).toEqual([])
      expect(frozenCounterparty).toEqual([])

      const operationId = randomUUID()
      const approvePromise = postJson(
        `/api/attendance/requests/${requestId}/approve`,
        requesterToken,
        orgId,
        {
          operationId,
          expectedApprovalVersion: approval.version,
          expectedApprovalNode: approval.node,
          comment: 'P18 calculation-first swap',
        },
      )
      const blockedPid = await waitForBlockedPid(calculationPid)
      await expectBlockedOnScheduleLock(blockedPid, orgId, [requesterId, counterpartyId])
      await calculationClient.query('COMMIT')

      const approve = await approvePromise
      expect(approve.status, approve.raw).toBe(200)
      await expectRequestDecisionOperation(orgId, operationId)

      const freshClient = await pool.connect()
      try {
        await freshClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        const freshRequester = await loadPublishedCandidates(freshClient, {
          orgId, userId: requesterId, workDates: [counterpartyDate],
        })
        const freshCounterparty = await loadPublishedCandidates(freshClient, {
          orgId, userId: counterpartyId, workDates: [requesterDate],
        })
        await freshClient.query('COMMIT')
        expect(freshRequester[0]).toMatchObject({ shiftId: counterpartyShift })
        expect(freshCounterparty[0]).toMatchObject({ shiftId: requesterShift })
      } finally {
        await freshClient.query('ROLLBACK').catch(() => undefined)
        freshClient.release()
      }
    } finally {
      await calculationClient.query('ROLLBACK').catch(() => undefined)
      calculationClient.release()
    }
  }, 90_000)

  it('P18: schedule-dispatch finalization blocks calculation until one coherent writer transaction commits', async () => {
    const orgId = randomUUID()
    const actorId = randomUUID()
    const subjectId = randomUUID()
    const workDate = '2049-06-21'
    await seedActiveIdentity(actorId, orgId)
    await seedActiveIdentity(subjectId, orgId)
    const token = await mintToken(actorId, orgId)
    await enableShadowPosture(orgId)
    const shiftId = (await createShiftViaApi(token, orgId, {
      name: 'P18 dispatch shift', workStartTime: '09:00', workEndTime: '18:00',
    })).body.data.id as string
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)
    const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: subjectId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: workDate,
      endDate: workDate,
      operationId: randomUUID(),
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string
    const approval = await loadApprovalCursor(requestId)

    const suffix = randomUUID().replaceAll('-', '')
    const functionName = `w4c3b_p18_pause_${suffix}`
    const triggerName = `w4c3b_p18_pause_${suffix}`
    const pauseKey = BigInt(`0x${suffix.slice(0, 15)}`).toString()
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
       BEGIN
         IF NEW.org_id = '${orgId}' AND NEW.user_id = '${subjectId}' THEN
           PERFORM pg_advisory_xact_lock(${pauseKey}::bigint);
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await pool.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON attendance_shift_assignments
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    )

    const pauseClient = await pool.connect()
    const calculationClient = await pool.connect()
    try {
      await pauseClient.query('BEGIN')
      const pausePid = Number((await pauseClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await pauseClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [pauseKey])

      const operationId = randomUUID()
      const approvePromise = postJson(
        `/api/attendance/requests/${requestId}/approve`,
        token,
        orgId,
        {
          operationId,
          expectedApprovalVersion: approval.version,
          expectedApprovalNode: approval.node,
          comment: 'P18 writer-first dispatch',
        },
      )
      const writerPid = await waitForBlockedPid(pausePid)

      const calculationPid = Number((await calculationClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await calculationClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const candidatesPromise = loadPublishedCandidates(calculationClient, {
        orgId, userId: subjectId, workDates: [workDate],
      })
      await waitUntilBlockedBy(calculationPid, writerPid)

      await pauseClient.query('COMMIT')
      const approve = await approvePromise
      expect(approve.status, approve.raw).toBe(200)
      const frozenCandidates = await candidatesPromise
      expect(frozenCandidates).toEqual([])
      await calculationClient.query('COMMIT')
      await expectRequestDecisionOperation(orgId, operationId)

      const freshClient = await pool.connect()
      try {
        await freshClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        const freshCandidates = await loadPublishedCandidates(freshClient, {
          orgId, userId: subjectId, workDates: [workDate],
        })
        await freshClient.query('COMMIT')
        expect(freshCandidates).toHaveLength(1)
        expect(freshCandidates[0]).toMatchObject({ orgId, userId: subjectId, workDate, shiftId })
      } finally {
        await freshClient.query('ROLLBACK').catch(() => undefined)
        freshClient.release()
      }
    } finally {
      await pauseClient.query('ROLLBACK').catch(() => undefined)
      await calculationClient.query('ROLLBACK').catch(() => undefined)
      pauseClient.release()
      calculationClient.release()
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON attendance_shift_assignments`).catch(() => undefined)
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined)
    }
  }, 90_000)

  it('matrix: shift-swap final approval fails closed after the source shift became multi-segment', async () => {
    const orgId = org('matrix-swap-final')
    const requesterId = `${orgId}-a`
    const counterpartyId = `${orgId}-b`
    await seedActiveIdentity(requesterId, orgId)
    await seedActiveIdentity(counterpartyId, orgId)
    const requesterToken = await mintToken(requesterId, orgId)
    const counterpartyToken = await mintToken(counterpartyId, orgId)
    const shiftA = (await createShiftViaApi(requesterToken, orgId, { name: 'A', workStartTime: '09:00', workEndTime: '13:00' })).body.data.id as string
    const shiftB = (await createShiftViaApi(requesterToken, orgId, { name: 'B', workStartTime: '14:00', workEndTime: '18:00' })).body.data.id as string
    const assignmentA = await seedPublishedAssignment(orgId, requesterId, shiftA, '2049-06-14')
    const assignmentB = await seedPublishedAssignment(orgId, counterpartyId, shiftB, '2049-06-15')

    const create = await postJson('/api/attendance/shift-swap-requests', requesterToken, orgId, {
      requesterAssignmentId: assignmentA,
      counterpartyAssignmentId: assignmentB,
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string
    const accept = await postJson(`/api/attendance/shift-swap-requests/${requestId}/accept`, counterpartyToken, orgId, {})
    expect(accept.status, accept.raw).toBe(200)

    // The requester shift became multi-segment after the snapshot was taken.
    await injectSecondSegment(orgId, shiftA)
    const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, requesterToken, orgId, { comment: 'go' })
    expect(approve.status, approve.raw).toBe(422)
    expect(codeOf(approve)).toBe(GUARD_CODE)

    const state = await pool.query(
      `SELECT r.status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id, d.finalized_at
         FROM attendance_requests r
         JOIN attendance_shift_swap_requests d ON d.request_id = r.id
        WHERE r.id = $1`,
      [requestId],
    )
    expect(state.rows[0].status).toBe('pending')
    expect(state.rows[0].requester_replacement_assignment_id).toBeNull()
    expect(state.rows[0].counterparty_replacement_assignment_id).toBeNull()
    expect(state.rows[0].finalized_at).toBeNull()
    // Zero writes: only the two seeded source assignments exist.
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(2)
  })

  it('matrix: schedule-dispatch final approval fails closed after the target shift became multi-segment', async () => {
    const orgId = org('matrix-dispatch-final')
    const actorId = `${orgId}-admin`
    await seedActiveIdentity(actorId, orgId)
    const token = await mintToken(actorId, orgId)
    const shiftId = (await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)

    const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string

    await injectSecondSegment(orgId, shiftId)
    const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, token, orgId, { comment: 'go' })
    expect(approve.status, approve.raw).toBe(422)
    expect(codeOf(approve)).toBe(GUARD_CODE)

    const state = await pool.query(
      `SELECT r.status, d.publish_status, d.assignment_ids, d.finalized_at
         FROM attendance_schedule_dispatch_requests d
         JOIN attendance_requests r ON r.id = d.request_id
        WHERE r.id = $1`,
      [requestId],
    )
    expect(state.rows[0].status).toBe('pending')
    expect(state.rows[0].publish_status).toBe('pending')
    expect(state.rows[0].finalized_at).toBeNull()
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)
  })

  /**
   * #4556 Gate A / P2-1 — hold the `schedule_dispatch_final_approval` posture wiring
   * (`index.cjs`, the `referenceSegments:` argument of its `assertShiftReferenceAllowed`
   * call) load-bearing ON ITS OWN.
   *
   * Why the matrix leg above cannot do it: forcing THAT ONE site fail-open
   * (`referenceSegments: true`) leaves it green, because a SECOND fail-closed door downstream —
   * `assertWorkContextSegmentCalculationAllowed` — refuses the same request and produces an
   * identical `422` + identical error code. Classic 多道 fail-closed 门互相掩护: status and code
   * are dominated for a NON-enabled org, so neither can discriminate. (R4 re-sourced that door
   * from the port; for a non-enabled org it still resolves `false`, so the covering behaviour
   * above is unchanged and this leg keeps its discriminating power.)
   *
   * What discriminates here: WHICH producer refused. The typed 422's message names the refusing
   * guard's `producer`. Correct behaviour ⇒ the dispatch final-approval guard refuses FIRST and
   * the message names `schedule_dispatch_final_approval`. With that one site forced fail-open,
   * the request survives it and is refused later by the calculation read path instead, whose
   * message names `attendance calculation` — so this leg REDS while status/code stay
   * 422/GUARD_CODE. Verified by executing exactly that mutation.
   *
   * SCOPE, post-R4: this leg is the FAIL-OPEN half of P2-1. The FAIL-CLOSED half — a 200-vs-422
   * status flip at the same site — is the enabled-org leg at the bottom of this file
   * ("R4/P2-1: dispatch final approval is status-coverable ..."), which became constructible
   * once R4 lifted the covering door for an enabled org. Neither leg subsumes the other:
   * fail-open is invisible to status, fail-closed is invisible to attribution.
   */
  it('P2-1: schedule-dispatch final approval 422 is attributed to ITS OWN guard, not to the covering R4 door', async () => {
    const orgId = org('p21-dispatch-final-attribution')
    const actorId = `${orgId}-admin`
    await seedActiveIdentity(actorId, orgId)
    const token = await mintToken(actorId, orgId)
    const shiftId = (await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)

    const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string

    await injectSecondSegment(orgId, shiftId)
    const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, token, orgId, { comment: 'go' })
    expect(approve.status, approve.raw).toBe(422)
    expect(codeOf(approve)).toBe(GUARD_CODE)

    // The load-bearing assertions: the refusal is attributed to the dispatch final-approval
    // writer's own guard. If that site stops consuming the resolved posture, the refusal
    // migrates to the calculation read path and both assertions fail.
    expect(messageOf(approve), approve.raw).toContain('schedule_dispatch_final_approval')
    expect(messageOf(approve), approve.raw).not.toContain('attendance calculation')

    expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)
  })

  /**
   * #4556 Gate A / owner P1 — ROLLOUT-LOCK ORDER COUNTEREXAMPLE (deterministic, two real
   * connections, real approval route).
   *
   * The hazard: the rollout TRANSITION path takes the rollout advisory lock EXCLUSIVE first and
   * only then `SELECT ... FROM attendance_requests ... FOR UPDATE` (w4c3a-rollout-control.ts —
   * exclusive at the top of the control transaction, request scan at `:948`). If the APPROVAL
   * transaction were to take the request row lock FIRST and reach for the rollout SHARED lock
   * only later, the two form a textbook wait cycle:
   *     approval  holds request row   + waits rollout-shared
   *     transition holds rollout-excl + waits request row
   * PostgreSQL's detector fires and one side dies with SQLSTATE 40P01.
   *
   * This test pins the SAFE order by construction, against the production HTTP approval chain:
   *   1. conn B opens a transaction and takes the rollout advisory lock EXCLUSIVE for the org
   *      (same key builder the production code uses — not a hand-rolled key).
   *   2. conn A fires the real approval route. It must block on the rollout SHARED lock
   *      **before** it has taken any `attendance_requests` row lock.
   *   3. conn B then takes `FOR UPDATE` on that very request row. This SUCCEEDS only because A
   *      holds no row lock — it is the discriminating observation.
   *   4. conn B commits (releasing exclusive); A then proceeds and completes.
   *
   * Load-bearing — the mutation NAMED HERE IS THE ONE THAT WAS EXECUTED, at this head.
   * (#4899 residual R4 rewrote this paragraph: the slice removed the in-finalization posture
   * resolve, so the old wording — "hoist the posture resolution back below the request row
   * lock" — no longer names a site that exists. At head the ONLY rollout-lock takes on this
   * path are above `execute`: the request-decision adapter's `prepare` resolving the posture
   * through the port, and the W4C-3b boundary's own `acquireAttendanceCalculationRolloutLock`.)
   *
   * The single-point mutation that recreates the hazard is to move the ROW lock up instead of
   * the rollout lock down: append `FOR UPDATE` to the request-decision adapter's `prepare`
   * `SELECT * FROM attendance_requests ...` (`index.cjs`, the query immediately above
   * `const legacyAuthorization = await resolveRequestLegacyAuthorization(...)`). Then A holds
   * the request row while parked on the rollout SHARED lock, step 3 blocks on A, and the run
   * dies with SQLSTATE `40P01`. Executed against this file: the leg fails with
   * `transition-order connection failed (SQLSTATE 40P01): error: deadlock detected`.
   */
  it('P1: approval acquires the rollout lock BEFORE any request row lock (no deadlock vs a concurrent transition)', async () => {
    const { buildAttendanceCalculationRolloutAdvisoryKey } = await import('../../src/attendance/w4c0-identity')
    const orgId = randomUUID() // canonical rollout org key, so the port really takes the lock
    const actorId = `${orgId}-admin`
    await seedActiveIdentity(actorId, orgId)
    const token = await mintToken(actorId, orgId)
    const shiftId = (await createShiftViaApi(token, orgId, { name: 'Lock order', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)

    const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-08-01',
      endDate: '2049-08-01',
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string

    const advisoryKey = buildAttendanceCalculationRolloutAdvisoryKey(orgId as never).toString()
    const connB = await pool.connect()
    let approval: Promise<HttpResponse> | undefined
    try {
      // (1) transition-order connection: rollout EXCLUSIVE first.
      await connB.query('BEGIN')
      await connB.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryKey])

      // (2) approval, real route. Blocks on the rollout SHARED lock.
      approval = postJson(`/api/attendance/requests/${requestId}/approve`, token, orgId, { comment: 'go' })
      // Give the approval time to reach (and block on) the rollout lock.
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // (3) THE DISCRIMINATOR: the transition-order connection now takes the same request row.
      // With the safe ordering the approval is parked on the advisory lock holding no row lock,
      // so this returns promptly. With the inverted ordering this blocks on the approval while
      // the approval waits on us -> 40P01.
      await connB.query('SET LOCAL lock_timeout = \'20s\'')
      const locked = await connB.query(
        'SELECT id FROM attendance_requests WHERE id = $1::uuid FOR UPDATE',
        [requestId],
      )
      expect(locked.rows).toHaveLength(1)

      // (4) release the exclusive lock; the approval may now proceed.
      await connB.query('COMMIT')
    } catch (error) {
      await connB.query('ROLLBACK').catch(() => undefined)
      // Surface a deadlock explicitly rather than as an opaque failure.
      const code = (error as { code?: string })?.code
      throw new Error(`transition-order connection failed${code ? ` (SQLSTATE ${code})` : ''}: ${String(error)}`)
    } finally {
      connB.release()
    }

    const approveRes = await approval!
    // The approval must NOT have died of a deadlock. Its own outcome may legitimately be a
    // typed refusal, but never a 40P01-driven 500.
    expect(approveRes.raw).not.toContain('40P01')
    expect(approveRes.raw).not.toContain('deadlock')
    expect([200, 201, 422]).toContain(approveRes.status)
  })

  it('matrix: automatic matching apply returns typed 422 with zero writes', async () => {
    const orgId = org('matrix-automatch')
    const token = await mintToken(`${orgId}-admin`, orgId)
    process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
    try {
      const settings = await putJson('/api/attendance/settings', token, orgId, {
        autoShiftMatching: {
          enabled: true,
          mode: 'apply',
          maxToleranceMinutes: 30,
          minConfidenceToApply: 'high',
          autoWrite: { enabled: false, lookaheadDays: 1, maxAssignmentsPerRun: 25, minConfidence: 'high' },
        },
      })
      expect(settings.status, settings.raw).toBe(200)

      const multiId = await createMultiShift(token, orgId)
      const userId = `${orgId}-worker`
      const workDate = '2049-06-10'
      // Automatic matching only considers users in a scheduled_shift group.
      const group = await postJson('/api/attendance/groups', token, orgId, {
        name: `${orgId}-group`,
        timezone: 'UTC',
        attendanceType: 'scheduled_shift',
      })
      expect(group.status, group.raw).toBe(200)
      const groupId = group.body.data.id as string
      const members = await postJson(`/api/attendance/groups/${groupId}/members`, token, orgId, { userIds: [userId] })
      expect(members.status, members.raw).toBe(200)
      const inId = randomUUID()
      const outId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_events (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
         VALUES ($1, $3, $4, $5, $6, 'check_in', 'integration-test', 'UTC', '{}'::jsonb, '{}'::jsonb),
                ($2, $3, $4, $5, $7, 'check_out', 'integration-test', 'UTC', '{}'::jsonb, '{}'::jsonb)`,
        [inId, outId, userId, orgId, workDate, `${workDate}T08:00:00.000Z`, `${workDate}T17:00:00.000Z`],
      )

      const preview = await postJson('/api/attendance/auto-shift-matching/preview', token, orgId, {
        userIds: [userId],
        from: workDate,
        to: workDate,
      })
      expect(preview.status, preview.raw).toBe(200)
      const candidate = (preview.body.data.items ?? []).find((item: any) => item.candidateShiftId === multiId)
      expect(candidate, preview.raw).toBeTruthy()

      const apply = await postJson('/api/attendance/auto-shift-matching/apply', token, orgId, {
        items: [{
          userId,
          workDate,
          candidateShiftId: multiId,
          evidence: { eventIds: candidate.evidence?.eventIds ?? [inId, outId] },
        }],
      })
      expect(apply.status, apply.raw).toBe(422)
      expect(codeOf(apply)).toBe(GUARD_CODE)
      expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)
    } finally {
      delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      await restoreAttendanceSettingsRow(pool, settingsSnapshot).catch(() => undefined)
    }
  })

  it('delete: typed 409 with zero writes for every durable blocker class', async () => {
    const orgId = org('delete-blockers')
    const token = await mintToken(`${orgId}-admin`, orgId)

    async function expectDeleteBlocked(shiftId: string, blocker: string) {
      const segmentsBefore = await segmentCount(shiftId)
      const res = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
        method: 'DELETE',
        headers: authHeaders(token, orgId),
      })
      expect(res.status, `${blocker}: ${res.raw}`).toBe(409)
      expect(codeOf(res)).toBe(DELETE_BLOCKED_CODE)
      const shiftStillThere = await pool.query('SELECT 1 FROM attendance_shifts WHERE id = $1', [shiftId])
      expect(shiftStillThere.rows).toHaveLength(1)
      expect(await segmentCount(shiftId)).toBe(segmentsBefore)
    }

    // (a) ANY assignment row, including ended/inactive history.
    const shiftA = (await createShiftViaApi(token, orgId, { name: 'Del A', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await pool.query(
      `INSERT INTO attendance_shift_assignments
       (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active)
       VALUES ($1, $2, $3, $4, 0, '2020-01-01', '2020-01-02', false)`,
      [randomUUID(), orgId, `${orgId}-hist`, shiftA],
    )
    await expectDeleteBlocked(shiftA, 'historical assignment')

    // (b) rotation rule referencing the shift id.
    const shiftB = (await createShiftViaApi(token, orgId, { name: 'Del B', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    const rule = await postJson('/api/attendance/rotation-rules', token, orgId, { name: 'DelRuleB', shiftSequence: [shiftB] })
    expect(rule.status, rule.raw).toBe(201)
    await expectDeleteBlocked(shiftB, 'rotation rule id reference')

    // (c) rotation rule referencing the legacy shift NAME.
    const shiftC = (await createShiftViaApi(token, orgId, { name: 'Del C', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'DelRuleC', 'UTC', $3::jsonb, true)`,
      [randomUUID(), orgId, JSON.stringify(['Del C'])],
    )
    await expectDeleteBlocked(shiftC, 'rotation rule legacy name reference')

    // (d) pending swap requester/counterparty snapshot.
    const shiftD1 = (await createShiftViaApi(token, orgId, { name: 'Del D1', workStartTime: '09:00', workEndTime: '13:00' })).body.data.id as string
    const shiftD2 = (await createShiftViaApi(token, orgId, { name: 'Del D2', workStartTime: '14:00', workEndTime: '18:00' })).body.data.id as string
    const assignmentD1 = await seedPublishedAssignment(orgId, `${orgId}-da`, shiftD1, '2049-06-14')
    const assignmentD2 = await seedPublishedAssignment(orgId, `${orgId}-db`, shiftD2, '2049-06-15')
    const swap = await postJson('/api/attendance/shift-swap-requests', token, orgId, {
      requesterAssignmentId: assignmentD1,
      counterpartyAssignmentId: assignmentD2,
    })
    expect(swap.status, swap.raw).toBe(201)

    // The pending swap snapshot is itself a durable blocker: the delete error details
    // must name BOTH the assignment rows and the swap reference class.
    const swapDelete = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftD1}`, {
      method: 'DELETE',
      headers: authHeaders(token, orgId),
    })
    expect(swapDelete.status, swapDelete.raw).toBe(409)
    expect(codeOf(swapDelete)).toBe(DELETE_BLOCKED_CODE)
    const blockerFields = (swapDelete.body?.error?.details ?? []).map((detail: any) => detail.field)
    expect(blockerFields).toContain('shift_assignments')
    expect(blockerFields).toContain('shift_swap_requests')

    // (e) pending dispatch target.
    const shiftE = (await createShiftViaApi(token, orgId, { name: 'Del E', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)
    const dispatch = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftE,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(dispatch.status, dispatch.raw).toBe(201)
    await expectDeleteBlocked(shiftE, 'pending dispatch target')
  })

  it('delete: rejected/cancelled evidence does not block, remains stored, and reads redact the raw UUID', async () => {
    const orgId = org('delete-evidence')
    const requesterToken = await mintToken(`${orgId}-a`, orgId)
    const shiftA = (await createShiftViaApi(requesterToken, orgId, { name: 'Ev A', workStartTime: '09:00', workEndTime: '13:00' })).body.data.id as string
    const shiftB = (await createShiftViaApi(requesterToken, orgId, { name: 'Ev B', workStartTime: '14:00', workEndTime: '18:00' })).body.data.id as string

    // Rejected swap snapshot referencing shiftA. The swap snapshot's assignment FKs
    // must stay valid, so the dummy assignments point at the SURVIVING shift; the
    // snapshot's requester_shift_id (a plain NOT NULL column without FK) points at A.
    // This is exactly the legacy state the erratum describes: historical evidence
    // whose shift no longer exists, with no live assignment reference to A.
    const swapRequestId = randomUUID()
    const assignmentA = await seedPublishedAssignment(orgId, `${orgId}-a`, shiftB, '2049-06-14')
    const assignmentB = await seedPublishedAssignment(orgId, `${orgId}-b`, shiftB, '2049-06-15')
    await pool.query(
      `INSERT INTO attendance_requests (id, user_id, org_id, work_date, request_type, reason, status)
       VALUES ($1, $2, $3, '2049-06-14', 'shift_swap', 'w3 evidence', 'rejected')`,
      [swapRequestId, `${orgId}-a`, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_swap_requests
       (request_id, org_id, requester_user_id, counterparty_user_id,
        requester_assignment_id, counterparty_assignment_id,
        requester_work_date, counterparty_work_date,
        requester_shift_id, counterparty_shift_id,
        requester_slot_index, counterparty_slot_index,
        requester_start_date, requester_end_date,
        counterparty_start_date, counterparty_end_date,
        requester_publish_status, counterparty_publish_status,
        requester_assignment_kind, counterparty_assignment_kind,
        source_key)
       VALUES
       ($1, $2, $3, $4, $5, $6, '2049-06-14', '2049-06-15', $7, $8, 0, 0,
        '2049-06-14', '2049-06-14', '2049-06-15', '2049-06-15',
        'published', 'published', 'regular', 'regular', $9)`,
      [swapRequestId, orgId, `${orgId}-a`, `${orgId}-b`, assignmentA, assignmentB, shiftA, shiftB, `w3evidence:${randomUUID()}`],
    )

    // Cancelled dispatch snapshot referencing shiftA (via the API).
    await seedDispatchFlow(requesterToken, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)
    const dispatch = await postJson('/api/attendance/schedule-dispatch-requests', requesterToken, orgId, {
      userId: `${orgId}-a`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftA,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(dispatch.status, dispatch.raw).toBe(201)
    const dispatchRequestId = dispatch.body.data.request.id as string
    const cancel = await postJson(`/api/attendance/schedule-dispatch-requests/${dispatchRequestId}/cancel`, requesterToken, orgId, {})
    expect(cancel.status, cancel.raw).toBe(200)

    // Neither the rejected swap snapshot nor the cancelled dispatch snapshot blocks.
    const del = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftA}`, {
      method: 'DELETE',
      headers: authHeaders(requesterToken, orgId),
    })
    expect(del.status, del.raw).toBe(200)

    // Evidence rows remain stored untouched (the dispatch FK is ON DELETE SET NULL:
    // the row stays, only the unresolvable pointer is cleared).
    const evidence = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM attendance_shift_swap_requests WHERE org_id = $1) AS swaps,
         (SELECT COUNT(*)::int FROM attendance_schedule_dispatch_requests WHERE org_id = $1) AS dispatches`,
      [orgId],
    )
    expect(evidence.rows[0]).toMatchObject({ swaps: 1, dispatches: 1 })

    // Reads redact the unresolvable raw UUID behind a neutral label.
    const swapList = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, { headers: authHeaders(requesterToken, orgId) })
    expect(swapList.status, swapList.raw).toBe(200)
    const swapItem = swapList.body.data.items.find((item: any) => item.requestId === swapRequestId)
    expect(swapItem.requesterShiftId).toBeNull()
    expect(swapItem.requester_shift_id).toBeNull()
    expect(swapItem.requesterShiftLabel).toBe(DELETED_LABEL)
    expect(swapItem.requesterShiftStatus).toBe('deleted')
    expect(swapItem.counterpartyShiftLabel).toBe('Ev B')
    expect(swapItem.counterpartyShiftStatus).toBe('available')

    const swapDetail = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${swapRequestId}`, { headers: authHeaders(requesterToken, orgId) })
    expect(swapDetail.status, swapDetail.raw).toBe(200)
    expect(swapDetail.body.data.shiftSwap.requesterShiftId).toBeNull()
    expect(swapDetail.body.data.shiftSwap.requesterShiftLabel).toBe(DELETED_LABEL)

    const dispatchDetail = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${dispatchRequestId}`, { headers: authHeaders(requesterToken, orgId) })
    expect(dispatchDetail.status, dispatchDetail.raw).toBe(200)
    expect(dispatchDetail.body.data.scheduleDispatch.targetShiftId).toBeNull()
    expect(dispatchDetail.body.data.scheduleDispatch.targetShiftLabel).toBe(DELETED_LABEL)
    expect(dispatchDetail.body.data.scheduleDispatch.targetShiftStatus).toBe('deleted')

    const requestList = await requestJson(
      `${baseUrl}/api/attendance/requests?from=2049-06-10&to=2049-06-10`,
      { headers: authHeaders(requesterToken, orgId) },
    )
    expect(requestList.status, requestList.raw).toBe(200)
    const requestItem = requestList.body.data.items.find((item: any) => item.id === dispatchRequestId)
    expect(requestItem.metadata.scheduleDispatch.targetShiftId).toBeNull()
    expect(requestItem.metadata.scheduleDispatch.targetShiftLabel).toBe(DELETED_LABEL)
    expect(requestItem.metadata.scheduleDispatch.targetShiftStatus).toBe('deleted')

    const requestDetail = await requestJson(
      `${baseUrl}/api/attendance/requests/${dispatchRequestId}`,
      { headers: authHeaders(requesterToken, orgId) },
    )
    expect(requestDetail.status, requestDetail.raw).toBe(200)
    expect(requestDetail.body.data.request.metadata.scheduleDispatch.targetShiftId).toBeNull()
    expect(requestDetail.body.data.request.metadata.scheduleDispatch.targetShiftLabel).toBe(DELETED_LABEL)
    expect(requestDetail.body.data.request.metadata.scheduleDispatch.targetShiftStatus).toBe('deleted')

    const crossOrgRequestDetail = await requestJson(
      `${baseUrl}/api/attendance/requests/${dispatchRequestId}`,
      { headers: authHeaders(requesterToken, org('delete-evidence-other')) },
    )
    expect(crossOrgRequestDetail.status, crossOrgRequestDetail.raw).toBe(404)

    // The raw UUID of the deleted shift must appear NOWHERE in these read payloads.
    expect(swapList.raw).not.toContain(shiftA)
    expect(swapDetail.raw).not.toContain(shiftA)
    expect(dispatchDetail.raw).not.toContain(shiftA)
    expect(requestList.raw).not.toContain(shiftA)
    expect(requestDetail.raw).not.toContain(shiftA)
  })

  it('read hardening: an orphaned schedule-dispatch request never trusts or exposes a metadata-only shift UUID', async () => {
    const orgId = org('orphan-dispatch')
    const userId = `${orgId}-user`
    const token = await mintToken(userId, orgId)
    const orphanRequestId = randomUUID()
    const rawShiftId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, org_id, work_date, request_type, reason, status, metadata)
       VALUES
         ($1, $2, $3, '2049-06-20', 'schedule_dispatch', 'orphan evidence', 'cancelled', $4::jsonb)`,
      [
        orphanRequestId,
        userId,
        orgId,
        JSON.stringify({ scheduleDispatch: { targetShiftId: rawShiftId } }),
      ],
    )

    const list = await requestJson(
      `${baseUrl}/api/attendance/requests?from=2049-06-20&to=2049-06-20`,
      { headers: authHeaders(token, orgId) },
    )
    expect(list.status, list.raw).toBe(200)
    const item = list.body.data.items.find((row: any) => row.id === orphanRequestId)
    expect(item.metadata.scheduleDispatch).toMatchObject({
      targetShiftId: null,
      targetShiftLabel: DELETED_LABEL,
      targetShiftStatus: 'deleted',
    })
    expect(list.raw).not.toContain(rawShiftId)

    const detail = await requestJson(
      `${baseUrl}/api/attendance/requests/${orphanRequestId}`,
      { headers: authHeaders(token, orgId) },
    )
    expect(detail.status, detail.raw).toBe(200)
    expect(detail.body.data.request.metadata.scheduleDispatch).toMatchObject({
      targetShiftId: null,
      targetShiftLabel: DELETED_LABEL,
      targetShiftStatus: 'deleted',
    })
    expect(detail.raw).not.toContain(rawShiftId)
  })

  it('concurrency: a reference insert racing a delete is serialized by the shared lock protocol', async () => {
    const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
    const service = plugin.__attendanceShiftServiceForTests.getService()
    const orgId = org('concurrency')
    const token = await mintToken(`${orgId}-admin`, orgId)
    const shiftId = (await createShiftViaApi(token, orgId, { name: 'Race', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string

    const wrap = (client: import('pg').PoolClient) => ({
      query: async (text: string, params?: unknown[]) => (await client.query(text, params as never[])).rows,
      transaction: async (cb: (trx: { query: (text: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) => {
        await client.query('BEGIN')
        try {
          const result = await cb({ query: async (text: string, params?: unknown[]) => (await client.query(text, params as never[])).rows })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        }
      },
    })

    async function waitUntilBlockedBy(blockedPid: number, blockerPid: number) {
      const deadline = Date.now() + 10000
      for (;;) {
        const r = await pool.query('SELECT pg_blocking_pids($1)::int[] AS blockers', [blockedPid])
        if ((r.rows[0]?.blockers ?? []).includes(blockerPid)) return
        if (Date.now() > deadline) throw new Error(`pid ${blockedPid} never blocked by ${blockerPid} (vacuous concurrency proof)`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    // Leg A: writer first. W locks the shift FOR SHARE and inserts the reference
    // uncommitted; the canonical delete must block, then fail 409 with zero writes.
    const clientW = await pool.connect()
    const clientD = await pool.connect()
    try {
      const pidW = (await clientW.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pidD = (await clientD.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

      await clientW.query('BEGIN')
      const trxW = { query: async (text: string, params?: unknown[]) => (await clientW.query(text, params as never[])).rows }
      await service.assertShiftReferenceAllowed(trxW, { orgId, shiftId, producer: 'concurrency_test' })
      await clientW.query(
        `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active)
         VALUES ($1, $2, $3, $4, 0, '2049-06-10', '2049-06-10', true)`,
        [randomUUID(), orgId, `${orgId}-racer`, shiftId],
      )

      let deleteOutcome: { error?: any } = {}
      const deletePromise = service.deleteShift(wrap(clientD), { orgId, shiftId })
        .then(() => { deleteOutcome = {} })
        .catch((error: unknown) => { deleteOutcome = { error } })
      await waitUntilBlockedBy(pidD, pidW)
      await clientW.query('COMMIT')
      await deletePromise

      expect(deleteOutcome.error).toBeTruthy()
      expect(deleteOutcome.error.status).toBe(409)
      expect(deleteOutcome.error.code).toBe(DELETE_BLOCKED_CODE)
      const stillThere = await pool.query('SELECT 1 FROM attendance_shifts WHERE id = $1', [shiftId])
      expect(stillThere.rows).toHaveLength(1)
    } finally {
      await clientW.query('ROLLBACK').catch(() => undefined)
      await clientD.query('ROLLBACK').catch(() => undefined)
      clientW.release()
      clientD.release()
    }

    // Leg B: delete first. D locks FOR UPDATE and deletes uncommitted; the guard
    // must block, then fail 404 — the reference can never land on a deleted shift.
    const shiftB = (await createShiftViaApi(token, orgId, { name: 'Race B', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    const clientD2 = await pool.connect()
    const clientW2 = await pool.connect()
    try {
      const pidD2 = (await clientD2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pidW2 = (await clientW2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

      await clientD2.query('BEGIN')
      // Same lock acquisition order as the canonical delete (FOR UPDATE on the parent row).
      await clientD2.query('SELECT id, name FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR UPDATE', [shiftB, orgId])
      await clientD2.query('DELETE FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2', [orgId, shiftB])
      await clientD2.query('DELETE FROM attendance_shifts WHERE id = $1 AND org_id = $2', [shiftB, orgId])

      let guardOutcome: { error?: any } = {}
      const trxW2 = { query: async (text: string, params?: unknown[]) => (await clientW2.query(text, params as never[])).rows }
      await clientW2.query('BEGIN')
      const guardPromise = service.assertShiftReferenceAllowed(trxW2, { orgId, shiftId: shiftB, producer: 'concurrency_test' })
        .then(() => { guardOutcome = {} })
        .catch((error: unknown) => { guardOutcome = { error } })
      await waitUntilBlockedBy(pidW2, pidD2)
      await clientD2.query('COMMIT')
      await guardPromise

      expect(guardOutcome.error).toBeTruthy()
      expect(guardOutcome.error.status).toBe(404)
      expect(guardOutcome.error.code).toBe('NOT_FOUND')
    } finally {
      await clientD2.query('ROLLBACK').catch(() => undefined)
      await clientW2.query('ROLLBACK').catch(() => undefined)
      clientD2.release()
      clientW2.release()
    }
  })

  /**
   * #4556 Gate A / Option B lock-in (real-PG, route-level, production writer chain).
   *
   * After the cutover the ONLY authorization for a multi-segment shift reference is the core
   * canonical posture port (exact-org allowlist, wildcard REFUSED, persisted rollout row). One
   * env value holds org A EXACTLY plus the wildcard `*`. Three orgs, one production writer route
   * (`POST /api/attendance/assignments` -> the `assignment_create` reference guard):
   *   - org A: exact env entry + a persisted `shadow` row => the guard admits the multi-segment
   *     reference and the writer chain persists a row (200/201, non-vacuous);
   *   - org B: no env entry and no row => typed 422 + zero writes (fail-closed baseline);
   *   - org W: a persisted `shadow` row but reachable only via the wildcard `*` => STILL 422 +
   *     zero writes — the wildcard is INERT, which is the security property this gate locks in.
   *
   * Mutation-provable against the private `isOrgExactlyAllowlisted` body (execution point
   * `resolveSegmentCalculationPosture` consults, NOT the re-export wrapper):
   *   - re-admit `*` (add `if (entries.includes('*')) return true`) => org W leg flips 422->201;
   *     org A stays 201, org B stays 422 (still no row);
   *   - force it to always return false => org A leg flips 201->422; org B and org W stay 422.
   * Org B is the fail-closed baseline; it is NOT separately mutation-proven, because a no-row org
   * resolves `legacy` regardless of the allowlist (POSTURE_TABLE has no non-legacy row for it).
   */
  describe('Gate A lock-in: exact-org allows, wildcard is inert', () => {
    const orgA = randomUUID()
    const orgB = randomUUID()
    const orgW = randomUUID()
    let tokenA = ''
    let tokenB = ''
    let tokenW = ''

    beforeAll(async () => {
      // Org A exact + wildcard. randomUUID() is already the canonical lower-case org key, so the
      // env entry, the persisted row's org_id, and the request org header are byte-identical.
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = `${orgA},*`
      await insertShadowRolloutRow(orgA)
      await insertShadowRolloutRow(orgW)
      tokenA = await mintToken(`${orgA}-admin`, orgA)
      tokenB = await mintToken(`${orgB}-admin`, orgB)
      tokenW = await mintToken(`${orgW}-admin`, orgW)
    })

    // Author a multi-segment shift (preview-only, always allowed) then drive the production
    // active-assignment writer, whose reference guard resolves the port on its own write trx.
    async function attemptMultiSegmentAssignment(token: string, orgId: string): Promise<HttpResponse> {
      const shiftId = await createMultiShift(token, orgId, 'Gate A lock-in split')
      return postJson('/api/attendance/assignments', token, orgId, {
        userId: `${orgId}-worker`,
        shiftId,
        startDate: '2049-07-01',
      })
    }

    it('org A (exact env entry + persisted shadow row) admits the multi-segment reference and persists a row', async () => {
      const res = await attemptMultiSegmentAssignment(tokenA, orgA)
      expect(res.status, res.raw).toBe(201)
      // Non-vacuous: the production writer chain ran to completion, not merely past the guard.
      expect(await countRows('attendance_shift_assignments', orgA)).toBe(1)
    })

    it('org B (no env entry, no rollout row) fails closed with the typed 422 and zero writes', async () => {
      const res = await attemptMultiSegmentAssignment(tokenB, orgB)
      expect(res.status, res.raw).toBe(422)
      expect(codeOf(res)).toBe(GUARD_CODE)
      expect(await countRows('attendance_shift_assignments', orgB)).toBe(0)
    })

    it('org W (persisted shadow row, reachable only via the wildcard) STILL fails closed — wildcard inert', async () => {
      const res = await attemptMultiSegmentAssignment(tokenW, orgW)
      expect(res.status, res.raw).toBe(422)
      expect(codeOf(res)).toBe(GUARD_CODE)
      expect(await countRows('attendance_shift_assignments', orgW)).toBe(0)
    })
  })

  /**
   * #4899 residual R4 — P2-1 FULL closure (route-level, real PG, production approval chain).
   *
   * The P2-1 leg above can only prove ATTRIBUTION, because while
   * `assertWorkContextSegmentCalculationAllowed` was hardcoded `referenceSegments: false` a
   * SECOND fail-closed door dominated the status for every org: both a correct refusal and a
   * fail-open at the dispatch site produced `422 + GUARD_CODE`. R4 re-sources that door from
   * the SAME boundary-resolved posture the finalization guard consumes, which lifts the cover
   * for an ENABLED org and makes a 200-vs-422 flip constructible here for the first time.
   *
   * Shape (mirrors the Gate A lock-in describe, one route further down the chain — the
   * production approval chain `POST /api/attendance/requests/:id/approve` ->
   * `schedule_dispatch_final_approval`):
   *   - org A: exact env entry + persisted `shadow` row => BOTH doors admit; the approval
   *     completes, the request flips to `approved`/`published` and ONE assignment is persisted.
   *   - org W: persisted `shadow` row but reachable only via the wildcard `*` => still 422 +
   *     zero writes, and the refusal is still attributed to the dispatch guard, not to the now
   *     re-sourced calculation door. The wildcard stays inert at this route too.
   *
   * Enablement lands AFTER the request is created, which is both the realistic Gate C order
   * and the reason org A's create needs no `operationId`: the org is still legacy at that
   * moment. Its approve DOES carry one (plus approval OCC), because a W4-enabled org's
   * boundary refuses null-ID commands (`W4C0_OPERATION_ID_REQUIRED`).
   *
   * MUTATION-PROVABLE ON STATUS — each verified by executing exactly that mutation:
   *   - `index.cjs` `finalizeScheduleDispatchRequest`'s `referenceSegments:` argument forced
   *     `false` (equivalently: delete the key => `undefined` => fail-closed) => org A flips
   *     200 -> 422. This is the direction that was UNDETECTABLE before R4 and it dominates
   *     "wrong org", "wrong posture field", and "value ignored" — all of them collapse to a
   *     non-`true` boolean at this site.
   *   - `index.cjs` `assertWorkContextSegmentCalculationAllowed` forced back to
   *     `referenceSegments: false` (the pre-R4 pin) => org A flips 200 -> 422, i.e. this leg
   *     also holds the R4 door itself open.
   *   - the W4C-3b boundary's `referenceSegments: preflight.referenceSegments` forced `false`
   *     => org A flips 200 -> 422, holding the whole thread-through load-bearing.
   *   - fail-OPEN at the dispatch site (`referenceSegments: true`) does NOT flip this leg's
   *     status; it reds the ATTRIBUTION leg above instead. The two legs are complementary and
   *     both are required: fail-open is caught by attribution, fail-closed by status.
   */
  describe('R4/P2-1: dispatch final approval is status-coverable once the calculation door is re-sourced', () => {
    const orgA = randomUUID()
    const orgW = randomUUID()
    let savedEnv: string | undefined

    beforeAll(() => {
      savedEnv = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    })

    afterAll(() => {
      if (savedEnv === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = savedEnv
    })

    /** Create a pending dispatch request for a still-legacy org, then make its shift multi-segment. */
    async function seedPendingDispatchWithMultiSegmentTarget(orgId: string, token: string) {
      const shiftId = (await createShiftViaApi(token, orgId, {
        name: 'R4 dispatch target', workStartTime: '09:00', workEndTime: '18:00',
      })).body.data.id as string
      await seedDispatchFlow(token, orgId)
      const scheduleGroupId = await seedScheduleGroup(orgId)
      const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
        userId: `${orgId}-worker`,
        targetScheduleGroupId: scheduleGroupId,
        targetShiftId: shiftId,
        startDate: '2049-09-01',
        endDate: '2049-09-01',
      })
      expect(create.status, create.raw).toBe(201)
      await injectSecondSegment(orgId, shiftId)
      return create.body.data.request.id as string
    }

    async function approvalCursor(requestId: string) {
      const result = await pool.query(
        `SELECT ai.version, ai.current_node_key
           FROM attendance_requests ar
           JOIN approval_instances ai ON ai.id = ar.approval_instance_id
          WHERE ar.id = $1::uuid`,
        [requestId],
      )
      expect(result.rows).toHaveLength(1)
      return { version: Number(result.rows[0].version), node: String(result.rows[0].current_node_key) }
    }

    it('org A (exact env entry + persisted shadow row) FINALIZES the dispatch — 2xx and a persisted assignment', async () => {
      const actorId = `${orgA}-admin`
      await seedActiveIdentity(actorId, orgA)
      // A W4-enabled org rechecks the SUBJECT's liveness/membership in-transaction, so the
      // dispatched worker must be a durable active member too.
      await seedActiveIdentity(`${orgA}-worker`, orgA)
      const token = await mintToken(actorId, orgA)

      // Still legacy at create time — no rollout row, and the env holds nothing for this org.
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ''
      const requestId = await seedPendingDispatchWithMultiSegmentTarget(orgA, token)

      // Gate C enablement: exact entry (plus the inert wildcard) AND the persisted row.
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = `${orgA},*`
      await insertShadowRolloutRow(orgA)

      const cursor = await approvalCursor(requestId)
      const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, token, orgA, {
        comment: 'go',
        operationId: randomUUID(),
        expectedApprovalVersion: cursor.version,
        expectedApprovalNode: cursor.node,
      })

      // THE load-bearing assertion: a STATUS-level admission, not an attribution message.
      expect(approve.status, approve.raw).toBe(200)
      // Non-vacuous: the production writer chain ran to completion, not merely past one guard.
      expect(await countRows('attendance_shift_assignments', orgA)).toBe(1)
      const state = await pool.query(
        `SELECT r.status, d.publish_status, d.finalized_at
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE r.id = $1`,
        [requestId],
      )
      expect(state.rows[0].status).toBe('approved')
      expect(state.rows[0].publish_status).toBe('published')
      expect(state.rows[0].finalized_at).not.toBeNull()
    })

    it('org W (shadow row, wildcard-only) still fails closed at ITS OWN dispatch guard — wildcard inert here too', async () => {
      const actorId = `${orgW}-admin`
      await seedActiveIdentity(actorId, orgW)
      await seedActiveIdentity(`${orgW}-worker`, orgW)
      const token = await mintToken(actorId, orgW)

      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = `${orgA},*`
      await insertShadowRolloutRow(orgW)
      const requestId = await seedPendingDispatchWithMultiSegmentTarget(orgW, token)

      // No operationId: a wildcard-only org resolves `legacy`, so the boundary still accepts
      // null-ID legacy commands. That it does is itself part of the inertness claim.
      const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, token, orgW, { comment: 'go' })
      expect(approve.status, approve.raw).toBe(422)
      expect(codeOf(approve)).toBe(GUARD_CODE)
      // The refusal still belongs to the dispatch writer's own guard — R4 did not merely move
      // the refusal to a different door for non-enabled orgs.
      expect(messageOf(approve), approve.raw).toContain('schedule_dispatch_final_approval')
      expect(messageOf(approve), approve.raw).not.toContain('attendance calculation')
      expect(await countRows('attendance_shift_assignments', orgW)).toBe(0)
      const state = await pool.query(
        `SELECT r.status, d.publish_status, d.finalized_at
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE r.id = $1`,
        [requestId],
      )
      expect(state.rows[0].status).toBe('pending')
      expect(state.rows[0].publish_status).toBe('pending')
      expect(state.rows[0].finalized_at).toBeNull()
    })

    /**
     * The SAME asymmetry, one producer over: `shift_swap_final_approval` also stopped
     * re-resolving the posture in this slice and now consumes the boundary-threaded value.
     * Measured before writing this leg: forcing that site fail-OPEN reds the existing
     * `matrix: shift-swap final approval fails closed ...` leg, but forcing it fail-CLOSED
     * reddened NOTHING in the whole file — i.e. "value ignored / wrong org / wrong posture
     * field" was undetectable there for exactly the P2-1 reason. This leg closes it on status.
     *
     * Mutation-proven: `referenceSegments: referenceSegments === true` -> `false` at the
     * `shift_swap_final_approval` guard flips this leg 200 -> 422.
     */
    it('org S (enabled) FINALIZES a shift swap whose source shift became multi-segment — 2xx and replacement rows', async () => {
      const orgS = randomUUID()
      const requesterId = `${orgS}-req`
      const counterpartyId = `${orgS}-cpy`
      await seedActiveIdentity(requesterId, orgS)
      await seedActiveIdentity(counterpartyId, orgS)
      const requesterToken = await mintToken(requesterId, orgS)
      const counterpartyToken = await mintToken(counterpartyId, orgS)

      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ''
      const shiftA = (await createShiftViaApi(requesterToken, orgS, { name: 'S-A', workStartTime: '09:00', workEndTime: '13:00' })).body.data.id as string
      const shiftB = (await createShiftViaApi(requesterToken, orgS, { name: 'S-B', workStartTime: '14:00', workEndTime: '18:00' })).body.data.id as string
      const assignmentA = await seedPublishedAssignment(orgS, requesterId, shiftA, '2049-09-14')
      const assignmentB = await seedPublishedAssignment(orgS, counterpartyId, shiftB, '2049-09-15')

      const create = await postJson('/api/attendance/shift-swap-requests', requesterToken, orgS, {
        requesterAssignmentId: assignmentA,
        counterpartyAssignmentId: assignmentB,
      })
      expect(create.status, create.raw).toBe(201)
      const requestId = create.body.data.request.id as string
      const accept = await postJson(`/api/attendance/shift-swap-requests/${requestId}/accept`, counterpartyToken, orgS, {})
      expect(accept.status, accept.raw).toBe(200)

      // The requester shift becomes multi-segment AFTER the snapshot, then Gate C enables the org.
      await injectSecondSegment(orgS, shiftA)
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = `${orgS},*`
      await insertShadowRolloutRow(orgS)

      const cursor = await approvalCursor(requestId)
      const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, requesterToken, orgS, {
        comment: 'go',
        operationId: randomUUID(),
        expectedApprovalVersion: cursor.version,
        expectedApprovalNode: cursor.node,
      })
      expect(approve.status, approve.raw).toBe(200)

      const state = await pool.query(
        `SELECT r.status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id, d.finalized_at
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
          WHERE r.id = $1`,
        [requestId],
      )
      expect(state.rows[0].status).toBe('approved')
      expect(state.rows[0].requester_replacement_assignment_id).not.toBeNull()
      expect(state.rows[0].counterparty_replacement_assignment_id).not.toBeNull()
      expect(state.rows[0].finalized_at).not.toBeNull()
      // Non-vacuous: the two seeded sources plus the two replacements.
      expect(await countRows('attendance_shift_assignments', orgS)).toBe(4)
    })
  })
})
