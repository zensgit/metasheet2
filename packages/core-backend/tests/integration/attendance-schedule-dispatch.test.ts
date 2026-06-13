import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'

type HttpResponse = { status: number; body?: unknown; raw: string }

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

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip
const ORG = 'default'

describeDb('schedule-dispatch D1 contract (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string, perms: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  async function cleanupPrefix(prefix: string) {
    const pattern = `${prefix}%`
    await pool.query(
      `DELETE FROM approval_records
       WHERE instance_id IN (
         SELECT approval_instance_id FROM attendance_requests
          WHERE org_id = $1 AND user_id LIKE $2
            AND approval_instance_id IS NOT NULL
       )`,
      [ORG, pattern],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM approval_instances
       WHERE business_key IN (
         SELECT 'attendance-request:' || id FROM attendance_requests
          WHERE org_id = $1 AND user_id LIKE $2
       )`,
      [ORG, pattern],
    ).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_requests WHERE org_id = $1 AND user_id LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_shift_assignments WHERE org_id = $1 AND user_id LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1 AND name LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_scheduler_scopes WHERE org_id = $1 AND subject_ref LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_schedule_groups WHERE org_id = $1 AND name LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_groups WHERE org_id = $1 AND name LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1 AND name LIKE $2`, [ORG, pattern]).catch(() => undefined)
  }

  async function expectPgReject(promise: Promise<unknown>, code: string) {
    try {
      await promise
      throw new Error(`expected postgres error ${code}`)
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code)
    }
  }

  function dateOnly(value: unknown): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value ?? '').slice(0, 10)
  }

  async function seedDispatchTargets(prefix: string) {
    const attendanceGroupId = randomUUID()
    const scheduleGroupId = randomUUID()
    const shiftId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, code, timezone)
       VALUES ($1, $2, $3, $4, 'UTC')`,
      [attendanceGroupId, ORG, `${prefix}-attendance-group`, `${prefix}-ag`],
    )
    await pool.query(
      `INSERT INTO attendance_schedule_groups
       (id, org_id, name, code, attendance_group_id, department_ref, source, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', true)`,
      [scheduleGroupId, ORG, `${prefix}-schedule-group`, `${prefix}-sg`, attendanceGroupId, `${prefix}-dept`],
    )
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
       VALUES ($1, $2, $3, '09:00', '18:00')`,
      [shiftId, ORG, `${prefix}-shift`],
    )
    return { attendanceGroupId, scheduleGroupId, shiftId, departmentRef: `${prefix}-dept` }
  }

  async function seedDispatchFlow(prefix: string, name = `${prefix}-flow`) {
    const flow = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(await mintToken(`${prefix}-flow-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')),
      body: JSON.stringify({
        name,
        requestType: 'schedule_dispatch',
        isActive: true,
        steps: [],
      }),
    })
    expect(flow.status, flow.raw).toBe(201)
    const id = (flow.body as { data?: { id?: string } } | undefined)?.data?.id
    expect(id).toBeTruthy()
    return id as string
  }

  async function createScheduleDispatchRequest(token: string, payload: Record<string, unknown>): Promise<string> {
    const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = (create.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
    expect(requestId).toBeTruthy()
    return requestId as string
  }

  async function saveAttendanceSettings(token: string, payload: Record<string, unknown>) {
    const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    })
    expect(res.status, res.raw).toBe(200)
    return res
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('schedule-dispatch integration needs a loopback port + DATABASE_URL')

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
  })

  afterAll(async () => {
    await cleanupPrefix('dispatch-').catch(() => undefined)
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
  })

  it('generic /requests API cannot create or update schedule_dispatch', async () => {
    const userId = `dispatch-route-${Date.now().toString(36)}`
    const workDate = '2049-07-12'
    const token = await mintToken(userId, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    try {
      const create = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ workDate, requestType: 'schedule_dispatch', reason: 'blocked generic create' }),
      })
      expect(create.status, create.raw).toBe(422)
      expect((create.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULE_DISPATCH_VIA_DEDICATED_ROUTE')
      const createdCount = Number((await pool.query(
        `SELECT count(*)::int AS n FROM attendance_requests WHERE org_id = $1 AND request_type = 'schedule_dispatch' AND work_date = $2`,
        [ORG, workDate],
      )).rows[0].n)
      expect(createdCount).toBe(0)

      const normal = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          workDate: '2049-07-13',
          requestType: 'missed_check_in',
          requestedInAt: '2049-07-13T09:00:00.000Z',
          reason: userId,
        }),
      })
      expect(normal.status, normal.raw).toBe(201)
      const requestId = (normal.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(requestId).toBeTruthy()

      const update = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ requestType: 'schedule_dispatch' }),
      })
      expect(update.status, update.raw).toBe(422)
      expect((update.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULE_DISPATCH_VIA_DEDICATED_ROUTE')
      const unchanged = (await pool.query(`SELECT request_type FROM attendance_requests WHERE id = $1`, [requestId])).rows[0]
      expect(unchanged.request_type).toBe('missed_check_in')
    } finally {
      await cleanupPrefix('dispatch-route-')
    }
  })

  it('approval flows can be created and filtered for schedule_dispatch', async () => {
    const prefix = `dispatch-flow-${Date.now().toString(36)}`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    try {
      const create = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          name: `${prefix}-schedule-dispatch`,
          requestType: 'schedule_dispatch',
          isActive: true,
          steps: [],
        }),
      })
      expect(create.status, create.raw).toBe(201)
      expect((create.body as { data?: { requestType?: string } } | undefined)?.data?.requestType).toBe('schedule_dispatch')

      const list = await requestJson(`${baseUrl}/api/attendance/approval-flows?requestType=schedule_dispatch`, {
        headers: authHeaders(token),
      })
      expect(list.status, list.raw).toBe(200)
      const items = (list.body as { data?: { items?: Array<{ name?: string; requestType?: string }> } } | undefined)?.data?.items ?? []
      expect(items.some(item => item.name === `${prefix}-schedule-dispatch` && item.requestType === 'schedule_dispatch')).toBe(true)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('creates, lists, reads, cancels, and re-creates schedule dispatch requests through the dedicated API', async () => {
    const prefix = `dispatch-api-${Date.now().toString(36)}`
    const userId = `${prefix}-user`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { attendanceGroupId, scheduleGroupId, shiftId, departmentRef } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const payload = {
      userId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-08-01',
      endDate: '2049-08-03',
      slotIndex: 0,
      reason: `${prefix} support`,
      approvalFlowId,
    }
    try {
      const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      })
      expect(create.status, create.raw).toBe(201)
      const created = (create.body as { data?: { request?: { id?: string; user_id?: string; workDate?: string; request_type?: string }, scheduleDispatch?: Record<string, unknown> } } | undefined)?.data
      const requestId = created?.request?.id
      expect(requestId).toBeTruthy()
      expect(created?.request?.user_id).toBe(userId)
      expect(created?.request?.workDate).toBe('2049-08-01')
      expect(created?.request?.request_type).toBe('schedule_dispatch')
      expect(created?.scheduleDispatch).toMatchObject({
        requestId,
        userId,
        targetScheduleGroupId: scheduleGroupId,
        targetAttendanceGroupId: attendanceGroupId,
        targetDepartmentRef: departmentRef,
        targetShiftId: shiftId,
        slotIndex: 0,
        startDate: '2049-08-01',
        endDate: '2049-08-03',
        publishStatus: 'pending',
      })

      const detailRows = await pool.query(
        `SELECT d.target_department_ref, d.assignment_ids, d.membership_id, d.finalized_at,
                r.user_id, r.work_date, r.request_type, r.status, r.metadata -> 'scheduleDispatch' ->> 'targetDepartmentRef' AS metadata_department
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE d.request_id = $1`,
        [requestId],
      )
      expect(detailRows.rows[0]).toMatchObject({
        target_department_ref: departmentRef,
        assignment_ids: [],
        membership_id: null,
        finalized_at: null,
        user_id: userId,
        request_type: 'schedule_dispatch',
        status: 'pending',
        metadata_department: departmentRef,
      })
      expect(dateOnly(detailRows.rows[0].work_date)).toBe('2049-08-01')
      const assignmentCount = Number((await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM attendance_shift_assignments
          WHERE org_id = $1 AND producer_type = 'schedule_dispatch'`,
        [ORG],
      )).rows[0].n)
      expect(assignmentCount).toBe(0)

      const duplicate = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      })
      expect(duplicate.status, duplicate.raw).toBe(409)
      expect((duplicate.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('DUPLICATE_SCHEDULE_DISPATCH_REQUEST')

      const overlapping = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          ...payload,
          startDate: '2049-08-02',
          endDate: '2049-08-02',
        }),
      })
      expect(overlapping.status, overlapping.raw).toBe(409)
      expect((overlapping.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('DUPLICATE_SCHEDULE_DISPATCH_REQUEST')

      const list = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests?userId=${encodeURIComponent(userId)}&pageSize=20`, {
        headers: authHeaders(token),
      })
      expect(list.status, list.raw).toBe(200)
      const listed = (list.body as { data?: { items?: Array<{ requestId?: string }>; total?: number } } | undefined)?.data
      expect(listed?.total).toBeGreaterThanOrEqual(1)
      expect((listed?.items ?? []).map(item => item.requestId)).toContain(requestId)

      const read = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${requestId}`, {
        headers: authHeaders(token),
      })
      expect(read.status, read.raw).toBe(200)
      expect((read.body as { data?: { scheduleDispatch?: { requestId?: string } } } | undefined)?.data?.scheduleDispatch?.requestId).toBe(requestId)

      const cancel = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${requestId}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
      })
      expect(cancel.status, cancel.raw).toBe(200)
      expect((cancel.body as { data?: { scheduleDispatch?: { publishStatus?: string; request?: { status?: string } } } } | undefined)?.data?.scheduleDispatch?.publishStatus).toBe('cancelled')
      const cancelledRows = await pool.query(
        `SELECT d.publish_status, d.source_key, r.status AS request_status, ai.status AS approval_status
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
           LEFT JOIN approval_instances ai ON ai.id = r.approval_instance_id
          WHERE d.request_id = $1`,
        [requestId],
      )
      expect(cancelledRows.rows[0]).toMatchObject({
        publish_status: 'cancelled',
        request_status: 'cancelled',
        approval_status: 'cancelled',
      })
      expect(String(cancelledRows.rows[0].source_key)).toContain(':archived:')

      const recreate = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      })
      expect(recreate.status, recreate.raw).toBe(201)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('finalizes schedule-dispatch approvals into published assignments and membership rows', async () => {
    const prefix = `dispatch-resolution-${Date.now().toString(36)}`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const payload = {
      userId: `${prefix}-user`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-08-04',
      endDate: '2049-08-04',
      approvalFlowId,
    }
    try {
      const requestId = await createScheduleDispatchRequest(token, payload)
      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} approve` }),
      })
      expect(approve.status, approve.raw).toBe(200)
      expect((approve.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('approved')

      const afterApprove = await pool.query(
        `SELECT r.status AS request_status, ai.status AS approval_status, d.publish_status,
                d.assignment_ids, d.membership_id, d.finalized_at, d.source_key,
                r.metadata -> 'scheduleDispatchFinalization' AS finalization
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
           LEFT JOIN approval_instances ai ON ai.id = r.approval_instance_id
          WHERE d.request_id = $1`,
        [requestId],
      )
      const approvedRow = afterApprove.rows[0]
      expect(approvedRow).toMatchObject({
        request_status: 'approved',
        approval_status: 'approved',
        publish_status: 'published',
        source_key: `schedule_dispatch:${payload.userId}:${scheduleGroupId}:2049-08-04:2049-08-04:0`,
      })
      expect(approvedRow.finalized_at).toBeTruthy()
      expect(approvedRow.assignment_ids).toHaveLength(1)
      expect(approvedRow.membership_id).toBeTruthy()
      expect(approvedRow.finalization).toMatchObject({
        assignmentIds: approvedRow.assignment_ids,
        membershipId: approvedRow.membership_id,
      })

      const assignment = (await pool.query(
        `SELECT id, user_id, shift_id, slot_index, start_date, end_date, is_active,
                publish_status, published_by, locked_at, assignment_kind,
                producer_type, producer_ref_id, producer_key, producer_run_id
           FROM attendance_shift_assignments
          WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid`,
        [ORG, requestId],
      )).rows[0]
      expect(assignment).toMatchObject({
        id: approvedRow.assignment_ids[0],
        user_id: payload.userId,
        shift_id: shiftId,
        slot_index: 0,
        is_active: true,
        publish_status: 'published',
        published_by: `${prefix}-admin`,
        assignment_kind: 'regular',
        producer_type: 'schedule_dispatch',
        producer_key: `schedule_dispatch:${payload.userId}:${scheduleGroupId}:2049-08-04:2049-08-04:0`,
      })
      expect(String(assignment.producer_ref_id)).toBe(requestId)
      expect(String(assignment.producer_run_id)).toBe(requestId)
      expect(assignment.locked_at).toBeTruthy()
      expect(dateOnly(assignment.start_date)).toBe('2049-08-04')
      expect(dateOnly(assignment.end_date)).toBe('2049-08-04')

      const membership = (await pool.query(
        `SELECT id, schedule_group_id, user_id, effective_from, effective_to, role, source
           FROM attendance_schedule_group_members
          WHERE org_id = $1 AND id = $2`,
        [ORG, approvedRow.membership_id],
      )).rows[0]
      expect(membership).toMatchObject({
        id: approvedRow.membership_id,
        schedule_group_id: scheduleGroupId,
        user_id: payload.userId,
        role: 'member',
        source: 'schedule_dispatch',
      })
      expect(dateOnly(membership.effective_from)).toBe('2049-08-04')
      expect(dateOnly(membership.effective_to)).toBe('2049-08-04')

      const sideEffectsAfterApprove = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND meta ->> 'requestId' = $2) AS event_count,
           (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count,
           (SELECT count(*)::int FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id = $3 AND source = 'schedule_dispatch') AS membership_count`,
        [ORG, requestId, payload.userId],
      )
      expect(sideEffectsAfterApprove.rows[0]).toMatchObject({
        event_count: 0,
        assignment_count: 1,
        membership_count: 1,
      })

      const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} replay` }),
      })
      expect(replay.status, replay.raw).toBe(400)
      expect((replay.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('INVALID_STATUS')
      const countsAfterReplay = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count,
           (SELECT count(*)::int FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id = $3 AND source = 'schedule_dispatch') AS membership_count`,
        [ORG, requestId, payload.userId],
      )
      expect(countsAfterReplay.rows[0]).toMatchObject({ assignment_count: 1, membership_count: 1 })
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('reuses an existing target membership as the finalized schedule-dispatch context', async () => {
    const prefix = `dispatch-membership-reuse-${Date.now().toString(36)}`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const userId = `${prefix}-user`
    const existingMembershipId = randomUUID()
    const payload = {
      userId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-08-05',
      endDate: '2049-08-05',
      approvalFlowId,
    }
    try {
      await pool.query(
        `INSERT INTO attendance_schedule_group_members
         (id, org_id, schedule_group_id, user_id, effective_from, effective_to, role, source)
         VALUES ($1, $2, $3, $4, '2049-08-01', '2049-08-31', 'member', 'manual')`,
        [existingMembershipId, ORG, scheduleGroupId, userId],
      )

      const requestId = await createScheduleDispatchRequest(token, payload)
      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} approve` }),
      })
      expect(approve.status, approve.raw).toBe(200)

      const rows = await pool.query(
        `SELECT d.membership_id,
                r.metadata -> 'scheduleDispatchFinalization' AS finalization,
                (SELECT count(*)::int FROM attendance_schedule_group_members
                  WHERE org_id = $1 AND user_id = $3 AND schedule_group_id = $4) AS membership_count,
                (SELECT count(*)::int FROM attendance_schedule_group_members
                  WHERE org_id = $1 AND user_id = $3 AND source = 'schedule_dispatch') AS dispatch_membership_count
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE d.request_id = $2`,
        [ORG, requestId, userId, scheduleGroupId],
      )
      expect(rows.rows[0]).toMatchObject({
        membership_id: existingMembershipId,
        membership_count: 1,
        dispatch_membership_count: 0,
      })
      expect(rows.rows[0].finalization).toMatchObject({ membershipId: existingMembershipId })
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('closes schedule-dispatch detail rows on reject and cancel without materializing assignments', async () => {
    const prefix = `dispatch-close-${Date.now().toString(36)}`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const payload = {
      userId: `${prefix}-user`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-08-04',
      endDate: '2049-08-04',
      approvalFlowId,
    }
    try {
      const requestId = await createScheduleDispatchRequest(token, payload)
      const reject = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} reject` }),
      })
      expect(reject.status, reject.raw).toBe(200)
      expect((reject.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('rejected')
      const rejectedRows = await pool.query(
        `SELECT r.status AS request_status, ai.status AS approval_status, d.publish_status, d.source_key
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
           LEFT JOIN approval_instances ai ON ai.id = r.approval_instance_id
          WHERE d.request_id = $1`,
        [requestId],
      )
      expect(rejectedRows.rows[0]).toMatchObject({
        request_status: 'rejected',
        approval_status: 'rejected',
        publish_status: 'cancelled',
      })
      expect(String(rejectedRows.rows[0].source_key)).toContain(':archived:')
      const rejectedSideEffects = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count,
           (SELECT count(*)::int FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id = $3 AND source = 'schedule_dispatch') AS membership_count`,
        [ORG, requestId, payload.userId],
      )
      expect(rejectedSideEffects.rows[0]).toMatchObject({ assignment_count: 0, membership_count: 0 })

      const recreateAfterReject = await createScheduleDispatchRequest(token, payload)
      expect(recreateAfterReject).not.toBe(requestId)

      const cancelPayload = {
        ...payload,
        startDate: '2049-08-05',
        endDate: '2049-08-05',
      }
      const cancelRequestId = await createScheduleDispatchRequest(token, cancelPayload)
      const cancel = await requestJson(`${baseUrl}/api/attendance/requests/${cancelRequestId}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} cancel` }),
      })
      expect(cancel.status, cancel.raw).toBe(200)
      expect((cancel.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('cancelled')
      const cancelledRows = await pool.query(
        `SELECT r.status AS request_status, ai.status AS approval_status, d.publish_status, d.source_key
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
           LEFT JOIN approval_instances ai ON ai.id = r.approval_instance_id
          WHERE d.request_id = $1`,
        [cancelRequestId],
      )
      expect(cancelledRows.rows[0]).toMatchObject({
        request_status: 'cancelled',
        approval_status: 'cancelled',
        publish_status: 'cancelled',
      })
      expect(String(cancelledRows.rows[0].source_key)).toContain(':archived:')

      const recreateAfterCancel = await createScheduleDispatchRequest(token, cancelPayload)
      expect(recreateAfterCancel).not.toBe(cancelRequestId)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('serializes concurrent overlapping schedule-dispatch creates for the same user, group, and slot', async () => {
    const prefix = `dispatch-concurrent-${Date.now().toString(36)}`
    const userId = `${prefix}-user`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const basePayload = {
      userId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      slotIndex: 0,
      approvalFlowId,
    }
    try {
      const [first, second] = await Promise.all([
        requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({
            ...basePayload,
            startDate: '2049-08-06',
            endDate: '2049-08-08',
          }),
        }),
        requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({
            ...basePayload,
            startDate: '2049-08-07',
            endDate: '2049-08-09',
          }),
        }),
      ])
      const statuses = [first.status, second.status].sort((a, b) => a - b)
      expect(statuses).toEqual([201, 409])
      const duplicate = [first, second].find(response => response.status === 409)
      expect((duplicate?.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('DUPLICATE_SCHEDULE_DISPATCH_REQUEST')
      const activeCount = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE d.org_id = $1
            AND d.user_id = $2
            AND d.target_schedule_group_id = $3
            AND d.slot_index = 0
            AND r.status IN ('pending', 'approved')`,
        [ORG, userId, scheduleGroupId],
      )).rows[0].n)
      expect(activeCount).toBe(1)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('rejects ambiguous schedule dispatch approval-flow selection', async () => {
    const prefix = `dispatch-flow-ambiguous-${Date.now().toString(36)}`
    const userId = `${prefix}-user`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    await seedDispatchFlow(prefix, `${prefix}-flow-a`)
    await seedDispatchFlow(prefix, `${prefix}-flow-b`)
    try {
      const create = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          userId,
          targetScheduleGroupId: scheduleGroupId,
          targetShiftId: shiftId,
          startDate: '2049-08-10',
          endDate: '2049-08-10',
        }),
      })
      expect(create.status, create.raw).toBe(422)
      expect((create.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULE_DISPATCH_APPROVAL_FLOW_REQUIRED')
      const rowCount = Number((await pool.query(
        `SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1 AND user_id = $2 AND request_type = 'schedule_dispatch'`,
        [ORG, userId],
      )).rows[0].n)
      expect(rowCount).toBe(0)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('requires scoped dispatch actors to cover user, target schedule group, and target department', async () => {
    const prefix = `dispatch-scope-${Date.now().toString(36)}`
    const scopedUserId = `${prefix}-actor`
    const dispatchedUserId = `${prefix}-user`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const { scheduleGroupId, shiftId, departmentRef } = await seedDispatchTargets(prefix)
    const updatedDepartmentRef = `${prefix}-dept-updated`
    const sibling = await seedDispatchTargets(`${prefix}-sibling`)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const token = await mintToken(scopedUserId, 'attendance:read,attendance:write')
    const payload = {
      userId: dispatchedUserId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-08-20',
      endDate: '2049-08-20',
      approvalFlowId,
    }
    try {
      process.env.RBAC_BYPASS = 'false'
      const noScope = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      })
      expect(noScope.status, noScope.raw).toBe(403)
      expect((noScope.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')

      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'user', $3, ARRAY['dispatch']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [randomUUID(), ORG, scopedUserId, JSON.stringify({ scheduleGroupIds: [scheduleGroupId], userIds: [dispatchedUserId] })],
      )
      const missingDepartment = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      })
      expect(missingDepartment.status, missingDepartment.raw).toBe(403)
      expect((missingDepartment.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')

      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'user', $3, ARRAY['dispatch']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [randomUUID(), ORG, scopedUserId, JSON.stringify({ scheduleGroupIds: [scheduleGroupId], userIds: [dispatchedUserId], departments: [departmentRef] })],
      )
      const allowed = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      })
      expect(allowed.status, allowed.raw).toBe(201)
      const requestId = (allowed.body as { data?: { scheduleDispatch?: { requestId?: string; targetDepartmentRef?: string | null } } } | undefined)?.data?.scheduleDispatch?.requestId
      expect(requestId).toBeTruthy()
      expect((allowed.body as { data?: { scheduleDispatch?: { targetDepartmentRef?: string | null } } } | undefined)?.data?.scheduleDispatch?.targetDepartmentRef).toBe(departmentRef)

      const siblingRequestId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_requests
         (id, user_id, org_id, work_date, request_type, status, reason, metadata)
         VALUES ($1, $2, $3, '2049-08-21', 'schedule_dispatch', 'pending', $4, '{}'::jsonb)`,
        [siblingRequestId, dispatchedUserId, ORG, `${prefix} sibling`],
      )
      await pool.query(
        `INSERT INTO attendance_schedule_dispatch_requests
         (request_id, org_id, dispatch_type, user_id, target_schedule_group_id, target_attendance_group_id,
          target_department_ref, target_shift_id, slot_index, start_date, end_date, publish_status, source_key)
         VALUES ($1, $2, 'daily', $3, $4, $5, $6, $7, 0, '2049-08-21', '2049-08-21', 'pending', $8)`,
        [
          siblingRequestId,
          ORG,
          dispatchedUserId,
          sibling.scheduleGroupId,
          sibling.attendanceGroupId,
          sibling.departmentRef,
          sibling.shiftId,
          `schedule_dispatch:${dispatchedUserId}:${sibling.scheduleGroupId}:2049-08-21:2049-08-21:0`,
        ],
      )

      const scopedList = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests?pageSize=100`, {
        headers: authHeaders(token),
      })
      expect(scopedList.status, scopedList.raw).toBe(200)
      const scopedIds = ((scopedList.body as { data?: { items?: Array<{ requestId?: string }> } } | undefined)?.data?.items ?? []).map(item => item.requestId)
      expect(scopedIds).toContain(requestId)
      expect(scopedIds).not.toContain(siblingRequestId)

      const scopedReadAllowed = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${requestId}`, {
        headers: authHeaders(token),
      })
      expect(scopedReadAllowed.status, scopedReadAllowed.raw).toBe(200)

      const scopedReadSibling = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${siblingRequestId}`, {
        headers: authHeaders(token),
      })
      expect(scopedReadSibling.status, scopedReadSibling.raw).toBe(403)
      expect((scopedReadSibling.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')

      const scopedCancelSibling = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${siblingRequestId}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
      })
      expect(scopedCancelSibling.status, scopedCancelSibling.raw).toBe(403)
      expect((scopedCancelSibling.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')
      const siblingStatus = (await pool.query(`SELECT status FROM attendance_requests WHERE id = $1`, [siblingRequestId])).rows[0]?.status
      expect(siblingStatus).toBe('pending')

      const scopedCancelAllowed = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${requestId}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
      })
      expect(scopedCancelAllowed.status, scopedCancelAllowed.raw).toBe(200)
      expect((scopedCancelAllowed.body as { data?: { scheduleDispatch?: { publishStatus?: string } } } | undefined)?.data?.scheduleDispatch?.publishStatus).toBe('cancelled')
    } finally {
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await cleanupPrefix(prefix)
    }
  })

  it('revalidates dispatch scope at final approval before materializing schedule writes', async () => {
    const prefix = `dispatch-final-scope-${Date.now().toString(36)}`
    const adminToken = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const approvalActorId = `${prefix}-approver`
    const dispatchedUserId = `${prefix}-user`
    const previousRbacBypass = process.env.RBAC_BYPASS
    const { scheduleGroupId, shiftId, departmentRef } = await seedDispatchTargets(prefix)
    const updatedDepartmentRef = `${prefix}-dept-updated`
    const approvalFlowId = await seedDispatchFlow(prefix)
    const approvalToken = await mintToken(approvalActorId, 'attendance:read,attendance:approve')
    const payload = {
      userId: dispatchedUserId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-08-22',
      endDate: '2049-08-22',
      approvalFlowId,
    }
    try {
      const requestId = await createScheduleDispatchRequest(adminToken, payload)
      await pool.query(
        `UPDATE attendance_schedule_groups
            SET department_ref = $1, updated_at = now()
          WHERE org_id = $2 AND id = $3`,
        [updatedDepartmentRef, ORG, scheduleGroupId],
      )
      process.env.RBAC_BYPASS = 'false'

      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'user', $3, ARRAY['approve']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [randomUUID(), ORG, approvalActorId, JSON.stringify({ userIds: [dispatchedUserId] })],
      )
      const approveOnly = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(approvalToken),
        body: JSON.stringify({ comment: `${prefix} approve-only` }),
      })
      expect(approveOnly.status, approveOnly.raw).toBe(403)
      expect((approveOnly.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')

      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'user', $3, ARRAY['dispatch']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [randomUUID(), ORG, approvalActorId, JSON.stringify({ userIds: [dispatchedUserId], scheduleGroupIds: [scheduleGroupId] })],
      )
      const missingDepartment = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(approvalToken),
        body: JSON.stringify({ comment: `${prefix} missing-department` }),
      })
      expect(missingDepartment.status, missingDepartment.raw).toBe(403)
      expect((missingDepartment.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')

      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'user', $3, ARRAY['dispatch']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [randomUUID(), ORG, approvalActorId, JSON.stringify({ userIds: [dispatchedUserId], scheduleGroupIds: [scheduleGroupId], departments: [departmentRef] })],
      )
      const staleDepartment = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(approvalToken),
        body: JSON.stringify({ comment: `${prefix} stale-department` }),
      })
      expect(staleDepartment.status, staleDepartment.raw).toBe(403)
      expect((staleDepartment.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULER_SCOPE_FORBIDDEN')

      const beforeAllowed = await pool.query(
        `SELECT r.status AS request_status, d.publish_status,
                (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE d.request_id = $2`,
        [ORG, requestId],
      )
      expect(beforeAllowed.rows[0]).toMatchObject({
        request_status: 'pending',
        publish_status: 'pending',
        assignment_count: 0,
      })

      await pool.query(
        `INSERT INTO attendance_scheduler_scopes
         (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by)
         VALUES ($1, $2, 'user', $3, ARRAY['dispatch']::text[], $4::jsonb, true, 'integration-test', 'integration-test')`,
        [randomUUID(), ORG, approvalActorId, JSON.stringify({ userIds: [dispatchedUserId], scheduleGroupIds: [scheduleGroupId], departments: [updatedDepartmentRef] })],
      )
      const allowed = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(approvalToken),
        body: JSON.stringify({ comment: `${prefix} allowed` }),
      })
      expect(allowed.status, allowed.raw).toBe(200)
      expect((allowed.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('approved')
      const afterAllowed = await pool.query(
        `SELECT d.publish_status, d.target_department_ref,
                (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count
           FROM attendance_schedule_dispatch_requests d
          WHERE d.request_id = $2`,
        [ORG, requestId],
      )
      expect(afterAllowed.rows[0]).toMatchObject({
        publish_status: 'published',
        target_department_ref: updatedDepartmentRef,
        assignment_count: 1,
      })
    } finally {
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      await cleanupPrefix(prefix)
    }
  })

  it('enforces schedule-dispatch slot semantics at create and final approval', async () => {
    const prefix = `dispatch-final-slot-${Date.now().toString(36)}`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const userId = `${prefix}-user`
    const payloadBase = {
      userId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      approvalFlowId,
    }
    const assertPendingWithoutDispatchAssignment = async (requestId: string) => {
      const rows = await pool.query(
        `SELECT r.status AS request_status, d.publish_status,
                (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE d.request_id = $2`,
        [ORG, requestId],
      )
      expect(rows.rows[0]).toMatchObject({
        request_status: 'pending',
        publish_status: 'pending',
        assignment_count: 0,
      })
    }
    try {
      await saveAttendanceSettings(token, { multiShiftDay: { enabled: false, maxSlots: 3 } })
      const disabledCreate = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          ...payloadBase,
          startDate: '2049-08-25',
          endDate: '2049-08-25',
          slotIndex: 1,
        }),
      })
      expect(disabledCreate.status, disabledCreate.raw).toBe(422)
      expect((disabledCreate.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULE_DISPATCH_SLOT_UNAVAILABLE')
      const createdCount = Number((await pool.query(
        `SELECT count(*)::int AS n FROM attendance_requests WHERE org_id = $1 AND user_id = $2 AND request_type = 'schedule_dispatch'`,
        [ORG, userId],
      )).rows[0].n)
      expect(createdCount).toBe(0)

      const latentRequestId = await createScheduleDispatchRequest(token, {
        ...payloadBase,
        startDate: '2049-08-26',
        endDate: '2049-08-26',
        slotIndex: 0,
      })
      await pool.query(
        `UPDATE attendance_schedule_dispatch_requests
            SET slot_index = 1, updated_at = now()
          WHERE org_id = $1 AND request_id = $2`,
        [ORG, latentRequestId],
      )
      const latentApprove = await requestJson(`${baseUrl}/api/attendance/requests/${latentRequestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} latent-slot` }),
      })
      expect(latentApprove.status, latentApprove.raw).toBe(422)
      expect((latentApprove.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULE_DISPATCH_SLOT_UNAVAILABLE')
      await assertPendingWithoutDispatchAssignment(latentRequestId)

      await saveAttendanceSettings(token, { multiShiftDay: { enabled: true, maxSlots: 2 } })
      const slotOneRequestId = await createScheduleDispatchRequest(token, {
        ...payloadBase,
        startDate: '2049-08-27',
        endDate: '2049-08-27',
        slotIndex: 1,
      })
      const slotOneApprove = await requestJson(`${baseUrl}/api/attendance/requests/${slotOneRequestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} enabled-slot` }),
      })
      expect(slotOneApprove.status, slotOneApprove.raw).toBe(200)
      const slotOneAssignment = (await pool.query(
        `SELECT slot_index
           FROM attendance_shift_assignments
          WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid`,
        [ORG, slotOneRequestId],
      )).rows[0]
      expect(slotOneAssignment?.slot_index).toBe(1)
    } finally {
      await saveAttendanceSettings(token, { multiShiftDay: { enabled: false, maxSlots: 3 } }).catch(() => undefined)
      await cleanupPrefix(prefix)
    }
  })

  it('blocks final schedule-dispatch approval over protected generated rows even when multi-shift slots do not conflict', async () => {
    const prefix = `dispatch-protected-row-${Date.now().toString(36)}`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const userId = `${prefix}-user`
    const protectedShiftId = randomUUID()
    const protectedAssignmentId = randomUUID()
    const protectedProducerRunId = randomUUID()
    try {
      await saveAttendanceSettings(token, { multiShiftDay: { enabled: true, maxSlots: 2 } })
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
         VALUES ($1, $2, $3, '00:00', '01:00')`,
        [protectedShiftId, ORG, `${prefix}-protected-shift`],
      )
      await pool.query(
        `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active,
          publish_status, assignment_kind, producer_type, producer_ref_id, producer_key, producer_run_id)
         VALUES
         ($1, $2, $3, $4, 1, '2049-08-26', '2049-08-26', true,
          'published', 'regular', 'auto_shift_match', $5, $6, $5)`,
        [protectedAssignmentId, ORG, userId, protectedShiftId, protectedProducerRunId, `${prefix}:auto-shift`],
      )

      const requestId = await createScheduleDispatchRequest(token, {
        userId,
        targetScheduleGroupId: scheduleGroupId,
        targetShiftId: shiftId,
        startDate: '2049-08-26',
        endDate: '2049-08-26',
        slotIndex: 0,
        approvalFlowId,
      })
      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} protected row` }),
      })
      expect(approve.status, approve.raw).toBe(409)
      expect((approve.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SCHEDULE_DISPATCH_PROTECTED_ASSIGNMENT_CONFLICT')

      const rows = await pool.query(
        `SELECT r.status AS request_status, d.publish_status,
                (SELECT count(*)::int FROM attendance_shift_assignments
                  WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count,
                (SELECT count(*)::int FROM attendance_schedule_group_members
                  WHERE org_id = $1 AND user_id = $3 AND source = 'schedule_dispatch') AS membership_count
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE d.request_id = $2`,
        [ORG, requestId, userId],
      )
      expect(rows.rows[0]).toMatchObject({
        request_status: 'pending',
        publish_status: 'pending',
        assignment_count: 0,
        membership_count: 0,
      })
    } finally {
      await saveAttendanceSettings(token, { multiShiftDay: { enabled: false, maxSlots: 3 } }).catch(() => undefined)
      await cleanupPrefix(prefix)
    }
  })

  it('keeps final schedule-dispatch approval transactional across conflict, edit-window, and compliance guards', async () => {
    const prefix = `dispatch-final-guards-${Date.now().toString(36)}`
    const token = await mintToken(`${prefix}-admin`, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const { scheduleGroupId, shiftId } = await seedDispatchTargets(prefix)
    const approvalFlowId = await seedDispatchFlow(prefix)
    const userId = `${prefix}-user`
    const payloadBase = {
      userId,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      approvalFlowId,
    }
    const assertPendingWithoutDispatchAssignment = async (requestId: string) => {
      const rows = await pool.query(
        `SELECT r.status AS request_status, d.publish_status,
                (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count,
                (SELECT count(*)::int FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id = $3 AND source = 'schedule_dispatch') AS membership_count
           FROM attendance_schedule_dispatch_requests d
           JOIN attendance_requests r ON r.id = d.request_id
          WHERE d.request_id = $2`,
        [ORG, requestId, userId],
      )
      expect(rows.rows[0]).toMatchObject({
        request_status: 'pending',
        publish_status: 'pending',
        assignment_count: 0,
        membership_count: 0,
      })
    }
    try {
      const conflictRequestId = await createScheduleDispatchRequest(token, {
        ...payloadBase,
        startDate: '2049-08-23',
        endDate: '2049-08-23',
      })
      await pool.query(
        `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active)
         VALUES ($1, $2, $3, $4, 0, '2049-08-23', '2049-08-23', true)`,
        [randomUUID(), ORG, userId, shiftId],
      )
      const conflict = await requestJson(`${baseUrl}/api/attendance/requests/${conflictRequestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} conflict` }),
      })
      expect(conflict.status, conflict.raw).toBe(409)
      expect((conflict.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT')
      await assertPendingWithoutDispatchAssignment(conflictRequestId)

      const editWindowRequestId = await createScheduleDispatchRequest(token, {
        ...payloadBase,
        startDate: '2020-01-10',
        endDate: '2020-01-10',
      })
      await saveAttendanceSettings(token, { shiftEditPolicy: { mode: 'past_locked', windowDays: 0 } })
      const editWindow = await requestJson(`${baseUrl}/api/attendance/requests/${editWindowRequestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} edit-window` }),
      })
      expect(editWindow.status, editWindow.raw).toBe(422)
      expect((editWindow.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_EDIT_WINDOW_EXCEEDED')
      await assertPendingWithoutDispatchAssignment(editWindowRequestId)

      await saveAttendanceSettings(token, {
        shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
        shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 60, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      })
      const complianceRequestId = await createScheduleDispatchRequest(token, {
        ...payloadBase,
        startDate: '2049-08-24',
        endDate: '2049-08-24',
      })
      const compliance = await requestJson(`${baseUrl}/api/attendance/requests/${complianceRequestId}/approve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ comment: `${prefix} compliance` }),
      })
      expect(compliance.status, compliance.raw).toBe(422)
      expect((compliance.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')
      await assertPendingWithoutDispatchAssignment(complianceRequestId)
    } finally {
      await saveAttendanceSettings(token, {
        shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
        shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      }).catch(() => undefined)
      await cleanupPrefix(prefix)
    }
  })

  it('persists latent schedule_dispatch detail rows with parent request mapping and constraints', async () => {
    const prefix = `dispatch-db-${Date.now().toString(36)}`
    const userId = `${prefix}-user`
    const requestId = randomUUID()
    const duplicateRequestId = randomUUID()
    const invalidDateRequestId = randomUUID()
    const invalidSlotRequestId = randomUUID()
    const { attendanceGroupId, scheduleGroupId, shiftId, departmentRef } = await seedDispatchTargets(prefix)
    try {
      await pool.query(
        `INSERT INTO attendance_requests (id, user_id, org_id, work_date, request_type, status, reason, metadata)
         VALUES ($1, $2, $3, '2049-07-15', 'schedule_dispatch', 'pending', $4, $5::jsonb),
                ($6, $2, $3, '2049-07-15', 'schedule_dispatch', 'pending', $4, '{}'::jsonb),
                ($7, $2, $3, '2049-07-16', 'schedule_dispatch', 'pending', $4, '{}'::jsonb),
                ($8, $2, $3, '2049-07-17', 'schedule_dispatch', 'pending', $4, '{}'::jsonb)`,
        [
          requestId,
          userId,
          ORG,
          `${prefix} reason`,
          JSON.stringify({
            scheduleDispatch: {
              userId,
              targetScheduleGroupId: scheduleGroupId,
              targetShiftId: shiftId,
              startDate: '2049-07-15',
              endDate: '2049-07-20',
              slotIndex: 1,
            },
          }),
          duplicateRequestId,
          invalidDateRequestId,
          invalidSlotRequestId,
        ],
      )
      const inserted = await pool.query(
        `INSERT INTO attendance_schedule_dispatch_requests
         (request_id, org_id, dispatch_type, user_id, target_schedule_group_id, target_attendance_group_id,
          target_department_ref, target_shift_id, slot_index, start_date, end_date, publish_status, source_key)
         VALUES ($1, $2, 'daily', $3, $4, $5, $6, $7, 1, '2049-07-15', '2049-07-20', 'pending', $8)
         RETURNING request_id, org_id, dispatch_type, user_id, target_schedule_group_id, target_attendance_group_id,
                   target_department_ref, target_shift_id, slot_index, start_date, end_date, publish_status, source_key,
                   assignment_ids, membership_id, finalized_at`,
        [
          requestId,
          ORG,
          userId,
          scheduleGroupId,
          attendanceGroupId,
          departmentRef,
          shiftId,
          `schedule_dispatch:${userId}:${scheduleGroupId}:2049-07-15:2049-07-20:1`,
        ],
      )
      expect(inserted.rows[0]).toMatchObject({
        request_id: requestId,
        org_id: ORG,
        dispatch_type: 'daily',
        user_id: userId,
        target_schedule_group_id: scheduleGroupId,
        target_attendance_group_id: attendanceGroupId,
        target_department_ref: departmentRef,
        target_shift_id: shiftId,
        slot_index: 1,
        publish_status: 'pending',
        source_key: `schedule_dispatch:${userId}:${scheduleGroupId}:2049-07-15:2049-07-20:1`,
        assignment_ids: [],
        membership_id: null,
        finalized_at: null,
      })

      const parent = (await pool.query(
        `SELECT user_id, work_date, request_type, metadata -> 'scheduleDispatch' ->> 'targetScheduleGroupId' AS target_group
           FROM attendance_requests
          WHERE id = $1`,
        [requestId],
      )).rows[0]
      expect(parent.user_id).toBe(userId)
      expect(dateOnly(parent.work_date)).toBe('2049-07-15')
      expect(parent.request_type).toBe('schedule_dispatch')
      expect(parent.target_group).toBe(scheduleGroupId)

      await expectPgReject(pool.query(
        `INSERT INTO attendance_schedule_dispatch_requests
         (request_id, org_id, user_id, target_schedule_group_id, target_shift_id, start_date, end_date, source_key)
         VALUES ($1, $2, $3, $4, $5, '2049-07-15', '2049-07-20', $6)`,
        [
          duplicateRequestId,
          ORG,
          userId,
          scheduleGroupId,
          shiftId,
          `schedule_dispatch:${userId}:${scheduleGroupId}:2049-07-15:2049-07-20:1`,
        ],
      ), '23505')
      await expectPgReject(pool.query(
        `INSERT INTO attendance_schedule_dispatch_requests
         (request_id, org_id, user_id, target_schedule_group_id, target_shift_id, start_date, end_date, source_key)
         VALUES ($1, $2, $3, $4, $5, '2049-07-20', '2049-07-15', $6)`,
        [invalidDateRequestId, ORG, userId, scheduleGroupId, shiftId, `${prefix}:bad-date`],
      ), '23514')
      await expectPgReject(pool.query(
        `INSERT INTO attendance_schedule_dispatch_requests
         (request_id, org_id, user_id, target_schedule_group_id, target_shift_id, slot_index, start_date, end_date, source_key)
         VALUES ($1, $2, $3, $4, $5, 3, '2049-07-15', '2049-07-20', $6)`,
        [invalidSlotRequestId, ORG, userId, scheduleGroupId, shiftId, `${prefix}:bad-slot`],
      ), '23514')
    } finally {
      await cleanupPrefix(prefix)
    }
  })
})
