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

describeDb('shift-swap SW1 envelope (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string, perms: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }

  async function cleanupPrefix(prefix: string) {
    const userPattern = `${prefix}%`
    await pool.query(
      `DELETE FROM approval_instances
       WHERE business_key IN (
         SELECT 'attendance-request:' || id FROM attendance_requests
         WHERE org_id = $1 AND (user_id LIKE $2 OR id IN (
           SELECT request_id FROM attendance_shift_swap_requests
           WHERE org_id = $1 AND (requester_user_id LIKE $2 OR counterparty_user_id LIKE $2)
         ))
       )`,
      [ORG, userPattern],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM attendance_requests
       WHERE org_id = $1 AND (user_id LIKE $2 OR id IN (
         SELECT request_id FROM attendance_shift_swap_requests
         WHERE org_id = $1 AND (requester_user_id LIKE $2 OR counterparty_user_id LIKE $2)
       ))`,
      [ORG, userPattern],
    ).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_shift_assignments WHERE org_id = $1 AND user_id LIKE $2`, [ORG, userPattern]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1 AND name LIKE $2`, [ORG, userPattern]).catch(() => undefined)
  }

  async function expectPgReject(promise: Promise<unknown>, code: string) {
    try {
      await promise
      throw new Error(`expected postgres error ${code}`)
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code)
    }
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('shift-swap integration needs a loopback port + DATABASE_URL')

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
    await cleanupPrefix('swap-').catch(() => undefined)
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
  })

  it('generic /requests API cannot create or update shift_swap', async () => {
    const userId = `swap-route-${Date.now().toString(36)}`
    const workDate = '2049-06-12'
    const token = await mintToken(userId, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    try {
      const create = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ workDate, requestType: 'shift_swap', reason: 'blocked generic create' }),
      })
      expect(create.status).toBe(422)
      expect((create.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_SWAP_DEDICATED_ROUTE_ONLY')
      const createdCount = Number((await pool.query(
        `SELECT count(*)::int AS n FROM attendance_requests WHERE org_id = $1 AND request_type = 'shift_swap' AND work_date = $2`,
        [ORG, workDate],
      )).rows[0].n)
      expect(createdCount).toBe(0)

      const normal = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          workDate: '2049-06-13',
          requestType: 'missed_check_in',
          requestedInAt: '2049-06-13T09:00:00.000Z',
          reason: userId,
        }),
      })
      expect(normal.status).toBe(201)
      const requestId = (normal.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(requestId).toBeTruthy()

      const update = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ requestType: 'shift_swap' }),
      })
      expect(update.status).toBe(422)
      expect((update.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_SWAP_DEDICATED_ROUTE_ONLY')
      const unchanged = (await pool.query(`SELECT request_type FROM attendance_requests WHERE id = $1`, [requestId])).rows[0]
      expect(unchanged.request_type).toBe('missed_check_in')
    } finally {
      await cleanupPrefix('swap-route-')
    }
  })

  it('persists structured single-day swap details and rejects duplicate or multi-day shapes', async () => {
    const prefix = `swap-db-${Date.now().toString(36)}`
    const requester = `${prefix}-a`
    const counterparty = `${prefix}-b`
    const requestId = randomUUID()
    const duplicateRequestId = randomUUID()
    const multiDayRequestId = randomUUID()
    const shiftA = randomUUID()
    const shiftB = randomUUID()
    const assignmentA = randomUUID()
    const assignmentB = randomUUID()
    try {
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
         VALUES ($1, $2, $3, '09:00', '13:00'), ($4, $2, $5, '14:00', '18:00')`,
        [shiftA, ORG, `${prefix}-shift-a`, shiftB, `${prefix}-shift-b`],
      )
      await pool.query(
        `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
         VALUES
         ($1, $2, $3, $4, 0, '2049-06-14', '2049-06-14', true, 'published', 'regular'),
         ($5, $2, $6, $7, 0, '2049-06-15', '2049-06-15', true, 'published', 'regular')`,
        [assignmentA, ORG, requester, shiftA, assignmentB, counterparty, shiftB],
      )
      await pool.query(
        `INSERT INTO attendance_requests (id, user_id, org_id, work_date, request_type, status, metadata)
         VALUES ($1, $2, $3, '2049-06-14', 'shift_swap', 'pending', '{}'::jsonb),
                ($4, $2, $3, '2049-06-14', 'shift_swap', 'pending', '{}'::jsonb),
                ($5, $2, $3, '2049-06-14', 'shift_swap', 'pending', '{}'::jsonb)`,
        [requestId, requester, ORG, duplicateRequestId, multiDayRequestId],
      )

      const insertDetail = (id: string, sourceKey: string, requesterEndDate = '2049-06-14') => pool.query(
        `INSERT INTO attendance_shift_swap_requests
         (request_id, org_id, requester_user_id, counterparty_user_id, requester_assignment_id, counterparty_assignment_id,
          requester_work_date, counterparty_work_date, requester_shift_id, counterparty_shift_id,
          requester_slot_index, counterparty_slot_index, requester_start_date, requester_end_date,
          counterparty_start_date, counterparty_end_date, requester_publish_status, counterparty_publish_status,
          requester_assignment_kind, counterparty_assignment_kind, source_key)
         VALUES
         ($1, $2, $3, $4, $5, $6,
          '2049-06-14', '2049-06-15', $7, $8,
          0, 0, '2049-06-14', $9,
          '2049-06-15', '2049-06-15', 'published', 'published',
          'regular', 'regular', $10)`,
        [id, ORG, requester, counterparty, assignmentA, assignmentB, shiftA, shiftB, requesterEndDate, sourceKey],
      )

      await insertDetail(requestId, `${prefix}:source`)
      const detail = (await pool.query(
        `SELECT counterparty_status, requester_work_date, counterparty_work_date
         FROM attendance_shift_swap_requests WHERE request_id = $1`,
        [requestId],
      )).rows[0]
      expect(detail.counterparty_status).toBe('pending')
      expect(new Date(detail.requester_work_date).toISOString().slice(0, 10)).toBe('2049-06-14')
      expect(new Date(detail.counterparty_work_date).toISOString().slice(0, 10)).toBe('2049-06-15')

      await expectPgReject(insertDetail(duplicateRequestId, `${prefix}:source`), '23505')
      await expectPgReject(insertDetail(multiDayRequestId, `${prefix}:multi`, '2049-06-16'), '23514')
    } finally {
      await cleanupPrefix(prefix)
    }
  })
})
