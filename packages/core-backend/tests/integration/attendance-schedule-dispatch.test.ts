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
      `DELETE FROM approval_instances
       WHERE business_key IN (
         SELECT 'attendance-request:' || id FROM attendance_requests
          WHERE org_id = $1 AND user_id LIKE $2
       )`,
      [ORG, pattern],
    ).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_requests WHERE org_id = $1 AND user_id LIKE $2`, [ORG, pattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1 AND name LIKE $2`, [ORG, pattern]).catch(() => undefined)
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
