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

describeDb('shift-swap envelope and dedicated routes (real DB, route-level)', () => {
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
    await pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1 AND name LIKE $2`, [ORG, userPattern]).catch(() => undefined)
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

  async function seedSwapPair(prefix: string, options: {
    requesterDate?: string
    counterpartyDate?: string
    requesterEndDate?: string
    requesterPublishStatus?: string
    requesterProducerType?: string | null
    requesterAssignmentKind?: string
  } = {}) {
    const requester = `${prefix}-a`
    const counterparty = `${prefix}-b`
    const shiftA = randomUUID()
    const shiftB = randomUUID()
    const assignmentA = randomUUID()
    const assignmentB = randomUUID()
    const requesterDate = options.requesterDate ?? '2049-06-14'
    const counterpartyDate = options.counterpartyDate ?? '2049-06-15'
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
       VALUES ($1, $2, $3, '09:00', '13:00'), ($4, $2, $5, '14:00', '18:00')`,
      [shiftA, ORG, `${prefix}-shift-a`, shiftB, `${prefix}-shift-b`],
    )
    const producerRefId = options.requesterProducerType ? randomUUID() : null
    const producerRunId = options.requesterProducerType ? randomUUID() : null
    const producerKey = options.requesterProducerType ? `${prefix}:producer` : null
    await pool.query(
      `INSERT INTO attendance_shift_assignments
       (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind,
        producer_type, producer_ref_id, producer_key, producer_run_id)
       VALUES
       ($1, $2, $3, $4, 0, $5, $6, true, $7, $8, $9, $10, $11, $12),
       ($13, $2, $14, $15, 0, $16, $16, true, 'published', 'regular', NULL, NULL, NULL, NULL)`,
      [
        assignmentA,
        ORG,
        requester,
        shiftA,
        requesterDate,
        options.requesterEndDate ?? requesterDate,
        options.requesterPublishStatus ?? 'published',
        options.requesterAssignmentKind ?? 'regular',
        options.requesterProducerType ?? null,
        producerRefId,
        producerKey,
        producerRunId,
        assignmentB,
        counterparty,
        shiftB,
        counterpartyDate,
      ],
    )
    return { requester, counterparty, shiftA, shiftB, assignmentA, assignmentB, requesterDate, counterpartyDate }
  }

  async function seedExtraSource(prefix: string, userSuffix = 'c') {
    const user = `${prefix}-${userSuffix}`
    const shiftId = randomUUID()
    const assignmentId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
       VALUES ($1, $2, $3, '10:00', '14:00')`,
      [shiftId, ORG, `${prefix}-shift-${userSuffix}`],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
       (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, 0, '2049-06-16', '2049-06-16', true, 'published', 'regular')`,
      [assignmentId, ORG, user, shiftId],
    )
    return { user, shiftId, assignmentId }
  }

  async function seedApprovalFlow(prefix: string, requestType: string, isActive = true) {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_approval_flows (id, org_id, name, request_type, steps, is_active)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)`,
      [id, ORG, `${prefix}-flow-${requestType}-${isActive ? 'active' : 'inactive'}`, requestType, isActive],
    )
    return id
  }

  function dateKey(offsetDays: number) {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() + offsetDays)
    return date.toISOString().slice(0, 10)
  }

  async function getAttendanceSettings(token: string): Promise<Record<string, unknown>> {
    const res = await requestJson(`${baseUrl}/api/attendance/settings`, { headers: authHeaders(token) })
    expect(res.status, res.raw).toBe(200)
    return ((res.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
  }

  async function saveAttendanceSettings(token: string, body: Record<string, unknown>) {
    const res = await requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    })
    expect(res.status, res.raw).toBe(200)
    return ((res.body as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>
  }

  async function restoreScheduleGuardSettings(token: string, originalSettings: Record<string, unknown>) {
    await saveAttendanceSettings(token, {
      shiftCompliance: originalSettings.shiftCompliance ?? {
        enforcement: 'block',
        dailyMaxMinutes: null,
        weeklyMaxMinutes: null,
        monthlyMaxMinutes: null,
      },
      shiftEditPolicy: originalSettings.shiftEditPolicy ?? { mode: 'unrestricted', windowDays: 0 },
    })
  }

  async function createShiftSwap(pair: { assignmentA: string; assignmentB: string }, requesterToken: string, body: Record<string, unknown> = {}) {
    const res = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
      method: 'POST',
      headers: authHeaders(requesterToken),
      body: JSON.stringify({
        requesterAssignmentId: pair.assignmentA,
        counterpartyAssignmentId: pair.assignmentB,
        ...body,
      }),
    })
    expect(res.status, res.raw).toBe(201)
    const requestId = (res.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
    expect(requestId).toBeTruthy()
    return String(requestId)
  }

  async function acceptShiftSwap(requestId: string, counterpartyToken: string) {
    const res = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/accept`, {
      method: 'POST',
      headers: authHeaders(counterpartyToken),
      body: '{}',
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

  it('creates a dedicated shift-swap request, accepts consent, and final approval writes replacement assignments once', async () => {
    const prefix = `swap-api-${Date.now().toString(36)}`
    try {
      const pair = await seedSwapPair(prefix)
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write,attendance:approve')
      const counterpartyToken = await mintToken(pair.counterparty, 'attendance:read,attendance:write')
      const otherToken = await mintToken(`${prefix}-other`, 'attendance:read,attendance:write')

      const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
          reason: 'swap api smoke',
        }),
      })
      expect(create.status).toBe(201)
      const createBody = create.body as {
        data?: {
          request?: { id?: string; request_type?: string; status?: string }
          shiftSwap?: { counterpartyStatus?: string; requesterWorkDate?: string; counterpartyWorkDate?: string }
        }
      }
      const requestId = createBody.data?.request?.id
      expect(requestId).toBeTruthy()
      expect(createBody.data?.request?.request_type).toBe('shift_swap')
      expect(createBody.data?.shiftSwap?.counterpartyStatus).toBe('pending')
      expect(createBody.data?.shiftSwap?.requesterWorkDate).toBe('2049-06-14')
      expect(createBody.data?.shiftSwap?.counterpartyWorkDate).toBe('2049-06-15')

      const list = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        headers: authHeaders(requesterToken),
      })
      expect(list.status).toBe(200)
      const listed = (list.body as { data?: { items?: Array<{ requestId?: string }> } } | undefined)?.data?.items ?? []
      expect(listed.some(item => item.requestId === requestId)).toBe(true)

      const readAsCounterparty = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}`, {
        headers: authHeaders(counterpartyToken),
      })
      expect(readAsCounterparty.status).toBe(200)

      const otherAccept = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/accept`, {
        method: 'POST',
        headers: authHeaders(otherToken),
        body: '{}',
      })
      expect(otherAccept.status).toBe(403)

      const accept = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/accept`, {
        method: 'POST',
        headers: authHeaders(counterpartyToken),
        body: '{}',
      })
      expect(accept.status).toBe(200)
      expect((accept.body as { data?: { shiftSwap?: { counterpartyStatus?: string } } } | undefined)?.data?.shiftSwap?.counterpartyStatus).toBe('accepted')

      const eventCountBefore = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_events
          WHERE org_id = $1 AND user_id LIKE $2`,
        [ORG, `${prefix}%`],
      )).rows[0].n)
      const recordCountBefore = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_records
          WHERE org_id = $1 AND user_id LIKE $2`,
        [ORG, `${prefix}%`],
      )).rows[0].n)
      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ comment: 'approved swap' }),
      })
      expect(approve.status, approve.raw).toBe(200)
      expect((approve.body as { data?: { status?: string } } | undefined)?.data?.status).toBe('approved')

      const persisted = (await pool.query(
        `SELECT r.status, d.counterparty_status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id,
                d.finalized_at, d.source_key
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
          WHERE r.id = $1`,
        [requestId],
      )).rows[0]
      expect(persisted.status).toBe('approved')
      expect(persisted.counterparty_status).toBe('accepted')
      expect(persisted.requester_replacement_assignment_id).toBeTruthy()
      expect(persisted.counterparty_replacement_assignment_id).toBeTruthy()
      expect(persisted.finalized_at).toBeTruthy()
      expect(String(persisted.source_key)).not.toContain(':closed:')

      const sourceRows = await pool.query(
        `SELECT id, is_active
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[])
          ORDER BY id`,
        [[pair.assignmentA, pair.assignmentB]],
      )
      expect(sourceRows.rows.map(row => row.is_active)).toEqual([false, false])

      const replacementRows = await pool.query(
        `SELECT id, user_id, shift_id, slot_index, start_date, end_date, is_active,
                publish_status, published_at, published_by, locked_at,
                producer_type, producer_ref_id, producer_key, producer_run_id
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[])
          ORDER BY user_id`,
        [[persisted.requester_replacement_assignment_id, persisted.counterparty_replacement_assignment_id]],
      )
      expect(replacementRows.rows).toHaveLength(2)
      const requesterReplacement = replacementRows.rows.find(row => row.user_id === pair.requester)
      const counterpartyReplacement = replacementRows.rows.find(row => row.user_id === pair.counterparty)
      expect(requesterReplacement).toMatchObject({
        shift_id: pair.shiftB,
        slot_index: 0,
        is_active: true,
        publish_status: 'published',
        published_by: pair.requester,
        producer_type: 'shift_swap',
        producer_ref_id: requestId,
        producer_run_id: requestId,
      })
      expect(counterpartyReplacement).toMatchObject({
        shift_id: pair.shiftA,
        slot_index: 0,
        is_active: true,
        publish_status: 'published',
        published_by: pair.requester,
        producer_type: 'shift_swap',
        producer_ref_id: requestId,
        producer_run_id: requestId,
      })
      expect(new Date(requesterReplacement.start_date).toISOString().slice(0, 10)).toBe(pair.counterpartyDate)
      expect(new Date(requesterReplacement.end_date).toISOString().slice(0, 10)).toBe(pair.counterpartyDate)
      expect(new Date(counterpartyReplacement.start_date).toISOString().slice(0, 10)).toBe(pair.requesterDate)
      expect(new Date(counterpartyReplacement.end_date).toISOString().slice(0, 10)).toBe(pair.requesterDate)
      expect(requesterReplacement.locked_at).toBeTruthy()
      expect(counterpartyReplacement.locked_at).toBeTruthy()
      expect(requesterReplacement.producer_key).toBe(`shift_swap:${requestId}:${pair.requester}:${pair.counterpartyDate}:0`)
      expect(counterpartyReplacement.producer_key).toBe(`shift_swap:${requestId}:${pair.counterparty}:${pair.requesterDate}:0`)

      const eventCountAfter = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_events
          WHERE org_id = $1 AND user_id LIKE $2`,
        [ORG, `${prefix}%`],
      )).rows[0].n)
      expect(eventCountAfter).toBe(eventCountBefore)
      const recordCountAfter = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_records
          WHERE org_id = $1 AND user_id LIKE $2`,
        [ORG, `${prefix}%`],
      )).rows[0].n)
      expect(recordCountAfter).toBe(recordCountBefore)

      const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ comment: 'again' }),
      })
      expect(replay.status).toBe(400)
      expect((replay.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('INVALID_STATUS')
      const replacementCount = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE org_id = $1 AND producer_type = 'shift_swap' AND producer_ref_id = $2`,
        [ORG, requestId],
      )).rows[0].n)
      expect(replacementCount).toBe(2)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('requires counterparty acceptance before final approval can write schedule rows', async () => {
    const prefix = `swap-consent-${Date.now().toString(36)}`
    try {
      const pair = await seedSwapPair(prefix)
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write,attendance:approve')
      const requestId = await createShiftSwap(pair, requesterToken)

      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ comment: 'too early' }),
      })
      expect(approve.status).toBe(422)
      expect((approve.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_SWAP_COUNTERPARTY_CONSENT_REQUIRED')

      const state = (await pool.query(
        `SELECT r.status, d.counterparty_status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
          WHERE r.id = $1`,
        [requestId],
      )).rows[0]
      expect(state.status).toBe('pending')
      expect(state.counterparty_status).toBe('pending')
      expect(state.requester_replacement_assignment_id).toBeNull()
      expect(state.counterparty_replacement_assignment_id).toBeNull()
      const activeSources = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[]) AND COALESCE(is_active, true) = true`,
        [[pair.assignmentA, pair.assignmentB]],
      )).rows[0].n)
      expect(activeSources).toBe(2)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('rolls back final approval when a captured source assignment changed after request creation', async () => {
    const prefix = `swap-drift-${Date.now().toString(36)}`
    try {
      const pair = await seedSwapPair(prefix)
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write,attendance:approve')
      const counterpartyToken = await mintToken(pair.counterparty, 'attendance:read,attendance:write')
      const requestId = await createShiftSwap(pair, requesterToken)
      await acceptShiftSwap(requestId, counterpartyToken)

      await pool.query(
        `UPDATE attendance_shift_assignments
            SET shift_id = $3, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [ORG, pair.assignmentA, pair.shiftB],
      )

      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ comment: 'drift' }),
      })
      expect(approve.status).toBe(409)
      expect((approve.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_SWAP_SOURCE_CHANGED')

      const state = (await pool.query(
        `SELECT r.status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
          WHERE r.id = $1`,
        [requestId],
      )).rows[0]
      expect(state.status).toBe('pending')
      expect(state.requester_replacement_assignment_id).toBeNull()
      expect(state.counterparty_replacement_assignment_id).toBeNull()
      const activeSources = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[]) AND COALESCE(is_active, true) = true`,
        [[pair.assignmentA, pair.assignmentB]],
      )).rows[0].n)
      expect(activeSources).toBe(2)
      const replacementCount = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE org_id = $1 AND producer_type = 'shift_swap' AND producer_ref_id = $2`,
        [ORG, requestId],
      )).rows[0].n)
      expect(replacementCount).toBe(0)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('rolls back final approval when the swapped assignment conflicts with an existing assignment', async () => {
    const prefix = `swap-conflict-${Date.now().toString(36)}`
    try {
      const pair = await seedSwapPair(prefix)
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write,attendance:approve')
      const counterpartyToken = await mintToken(pair.counterparty, 'attendance:read,attendance:write')
      const requestId = await createShiftSwap(pair, requesterToken)
      await acceptShiftSwap(requestId, counterpartyToken)

      const conflictShiftId = randomUUID()
      const conflictAssignmentId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time)
         VALUES ($1, $2, $3, '15:00', '19:00')`,
        [conflictShiftId, ORG, `${prefix}-conflict-shift`],
      )
      await pool.query(
        `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
         VALUES ($1, $2, $3, $4, 0, $5, $5, true, 'published', 'regular')`,
        [conflictAssignmentId, ORG, pair.requester, conflictShiftId, pair.counterpartyDate],
      )

      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ comment: 'conflict' }),
      })
      expect(approve.status).toBe(409)
      expect((approve.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT')

      const state = (await pool.query(
        `SELECT r.status, d.counterparty_status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
          WHERE r.id = $1`,
        [requestId],
      )).rows[0]
      expect(state.status).toBe('pending')
      expect(state.counterparty_status).toBe('accepted')
      expect(state.requester_replacement_assignment_id).toBeNull()
      expect(state.counterparty_replacement_assignment_id).toBeNull()
      const activeSources = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[]) AND COALESCE(is_active, true) = true`,
        [[pair.assignmentA, pair.assignmentB]],
      )).rows[0].n)
      expect(activeSources).toBe(2)
      const replacementCount = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE org_id = $1 AND producer_type = 'shift_swap' AND producer_ref_id = $2`,
        [ORG, requestId],
      )).rows[0].n)
      expect(replacementCount).toBe(0)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('rolls back final approval when shift compliance caps reject the swapped load', async () => {
    const prefix = `swap-cap-${Date.now().toString(36)}`
    let originalSettings: Record<string, unknown> | null = null
    try {
      const pair = await seedSwapPair(prefix, { counterpartyDate: '2049-09-15' })
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write,attendance:approve,attendance:admin')
      const counterpartyToken = await mintToken(pair.counterparty, 'attendance:read,attendance:write')
      originalSettings = await getAttendanceSettings(requesterToken)
      await saveAttendanceSettings(requesterToken, {
        shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 60, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
        shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
      })
      const requestId = await createShiftSwap(pair, requesterToken)
      await acceptShiftSwap(requestId, counterpartyToken)

      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ comment: 'cap' }),
      })
      expect(approve.status).toBe(422)
      expect((approve.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_COMPLIANCE_CAP_EXCEEDED')

      const state = (await pool.query(
        `SELECT r.status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
          WHERE r.id = $1`,
        [requestId],
      )).rows[0]
      expect(state.status).toBe('pending')
      expect(state.requester_replacement_assignment_id).toBeNull()
      expect(state.counterparty_replacement_assignment_id).toBeNull()
      const activeSources = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[]) AND COALESCE(is_active, true) = true`,
        [[pair.assignmentA, pair.assignmentB]],
      )).rows[0].n)
      expect(activeSources).toBe(2)
      const replacementCount = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE org_id = $1 AND producer_type = 'shift_swap' AND producer_ref_id = $2`,
        [ORG, requestId],
      )).rows[0].n)
      expect(replacementCount).toBe(0)
    } finally {
      if (originalSettings) {
        const token = await mintToken(`${prefix}-settings-restore`, 'attendance:admin')
        await restoreScheduleGuardSettings(token, originalSettings).catch(() => undefined)
      }
      await cleanupPrefix(prefix)
    }
  })

  it('rolls back final approval when the shift edit window rejects a source or target date', async () => {
    const prefix = `swap-window-${Date.now().toString(36)}`
    let originalSettings: Record<string, unknown> | null = null
    try {
      const pair = await seedSwapPair(prefix, {
        requesterDate: dateKey(-3),
        counterpartyDate: dateKey(-2),
      })
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write,attendance:approve,attendance:admin')
      const counterpartyToken = await mintToken(pair.counterparty, 'attendance:read,attendance:write')
      originalSettings = await getAttendanceSettings(requesterToken)
      await saveAttendanceSettings(requesterToken, {
        shiftEditPolicy: { mode: 'past_locked', windowDays: 0 },
        shiftCompliance: { enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      })
      const requestId = await createShiftSwap(pair, requesterToken)
      await acceptShiftSwap(requestId, counterpartyToken)

      const approve = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ comment: 'window' }),
      })
      expect(approve.status).toBe(422)
      expect((approve.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_EDIT_WINDOW_EXCEEDED')

      const state = (await pool.query(
        `SELECT r.status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
          WHERE r.id = $1`,
        [requestId],
      )).rows[0]
      expect(state.status).toBe('pending')
      expect(state.requester_replacement_assignment_id).toBeNull()
      expect(state.counterparty_replacement_assignment_id).toBeNull()
      const activeSources = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_shift_assignments
          WHERE id = ANY($1::uuid[]) AND COALESCE(is_active, true) = true`,
        [[pair.assignmentA, pair.assignmentB]],
      )).rows[0].n)
      expect(activeSources).toBe(2)
    } finally {
      if (originalSettings) {
        const token = await mintToken(`${prefix}-settings-restore`, 'attendance:admin')
        await restoreScheduleGuardSettings(token, originalSettings).catch(() => undefined)
      }
      await cleanupPrefix(prefix)
    }
  })

  it('hard-blocks a source assignment while a shift-swap request is pending, then releases it after cancel', async () => {
    const prefix = `swap-dupe-${Date.now().toString(36)}`
    try {
      const pair = await seedSwapPair(prefix)
      const third = await seedExtraSource(prefix, 'c')
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write')

      const first = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
        }),
      })
      expect(first.status).toBe(201)
      const firstRequestId = (first.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(firstRequestId).toBeTruthy()

      const duplicateSource = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: third.assignmentId,
        }),
      })
      expect(duplicateSource.status).toBe(409)
      expect((duplicateSource.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('DUPLICATE_SHIFT_SWAP_SOURCE')

      const cancel = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${firstRequestId}/cancel`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: '{}',
      })
      expect(cancel.status).toBe(200)
      expect((cancel.body as { data?: { shiftSwap?: { requestStatus?: string } } } | undefined)?.data?.shiftSwap?.requestStatus).toBe('cancelled')

      const afterCancel = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
        }),
      })
      expect(afterCancel.status).toBe(201)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('requires an explicit approvalFlowId to be an active shift_swap flow', async () => {
    const prefix = `swap-flow-${Date.now().toString(36)}`
    try {
      const pair = await seedSwapPair(prefix)
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write')
      const leaveFlowId = await seedApprovalFlow(prefix, 'leave', true)
      const inactiveSwapFlowId = await seedApprovalFlow(prefix, 'shift_swap', false)
      const activeSwapFlowId = await seedApprovalFlow(prefix, 'shift_swap', true)

      for (const approvalFlowId of [leaveFlowId, inactiveSwapFlowId]) {
        const invalidFlow = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
          method: 'POST',
          headers: authHeaders(requesterToken),
          body: JSON.stringify({
            requesterAssignmentId: pair.assignmentA,
            counterpartyAssignmentId: pair.assignmentB,
            approvalFlowId,
          }),
        })
        expect(invalidFlow.status).toBe(422)
        expect((invalidFlow.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_SWAP_APPROVAL_FLOW_REQUIRED')
      }

      const countBeforeValid = Number((await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_requests
          WHERE org_id = $1 AND user_id = $2 AND request_type = 'shift_swap'`,
        [ORG, pair.requester],
      )).rows[0].n)
      expect(countBeforeValid).toBe(0)

      const validFlow = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({
          requesterAssignmentId: pair.assignmentA,
          counterpartyAssignmentId: pair.assignmentB,
          approvalFlowId: activeSwapFlowId,
        }),
      })
      expect(validFlow.status).toBe(201)
      const requestId = (validFlow.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(requestId).toBeTruthy()
      const metadata = (await pool.query(
        `SELECT metadata FROM attendance_requests WHERE id = $1`,
        [requestId],
      )).rows[0]?.metadata as { approvalFlow?: { id?: string } } | undefined
      expect(metadata?.approvalFlow?.id).toBe(activeSwapFlowId)
    } finally {
      await cleanupPrefix(prefix)
    }
  })

  it('rejects unsupported source snapshots before creating a shift-swap envelope', async () => {
    const multiPrefix = `swap-multiday-${Date.now().toString(36)}`
    const generatedPrefix = `swap-generated-${Date.now().toString(36)}`
    try {
      const multi = await seedSwapPair(multiPrefix, { requesterEndDate: '2049-06-16' })
      const multiToken = await mintToken(multi.requester, 'attendance:read,attendance:write')
      const multiRes = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(multiToken),
        body: JSON.stringify({ requesterAssignmentId: multi.assignmentA, counterpartyAssignmentId: multi.assignmentB }),
      })
      expect(multiRes.status).toBe(422)
      expect((multiRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_SWAP_SOURCE_NOT_SINGLE_DAY')

      const generated = await seedSwapPair(generatedPrefix, { requesterProducerType: 'fixed_schedule' })
      const generatedToken = await mintToken(generated.requester, 'attendance:read,attendance:write')
      const generatedRes = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(generatedToken),
        body: JSON.stringify({ requesterAssignmentId: generated.assignmentA, counterpartyAssignmentId: generated.assignmentB }),
      })
      expect(generatedRes.status).toBe(422)
      expect((generatedRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('SHIFT_SWAP_SOURCE_UNSUPPORTED')

      const count = Number((await pool.query(
        `SELECT count(*)::int AS n FROM attendance_requests
          WHERE org_id = $1 AND request_type = 'shift_swap' AND user_id LIKE ANY($2::text[])`,
        [ORG, [`${multiPrefix}%`, `${generatedPrefix}%`]],
      )).rows[0].n)
      expect(count).toBe(0)
    } finally {
      await cleanupPrefix(multiPrefix)
      await cleanupPrefix(generatedPrefix)
    }
  })

  it('lets the counterparty reject and closes the approval envelope without schedule writes', async () => {
    const prefix = `swap-reject-${Date.now().toString(36)}`
    try {
      const pair = await seedSwapPair(prefix)
      const requesterToken = await mintToken(pair.requester, 'attendance:read,attendance:write')
      const counterpartyToken = await mintToken(pair.counterparty, 'attendance:read,attendance:write')
      const create = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ requesterAssignmentId: pair.assignmentA, counterpartyAssignmentId: pair.assignmentB }),
      })
      expect(create.status).toBe(201)
      const requestId = (create.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
      expect(requestId).toBeTruthy()

      const reject = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${requestId}/reject`, {
        method: 'POST',
        headers: authHeaders(counterpartyToken),
        body: '{}',
      })
      expect(reject.status).toBe(200)
      expect((reject.body as { data?: { shiftSwap?: { counterpartyStatus?: string; requestStatus?: string } } } | undefined)?.data?.shiftSwap?.counterpartyStatus).toBe('rejected')
      expect((reject.body as { data?: { shiftSwap?: { requestStatus?: string } } } | undefined)?.data?.shiftSwap?.requestStatus).toBe('rejected')

      const statusRows = await pool.query(
        `SELECT r.status AS request_status, ai.status AS approval_status,
                d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id
           FROM attendance_requests r
           JOIN attendance_shift_swap_requests d ON d.request_id = r.id
           LEFT JOIN approval_instances ai ON ai.id = r.approval_instance_id
          WHERE r.id = $1`,
        [requestId],
      )
      expect(statusRows.rows[0].request_status).toBe('rejected')
      expect(statusRows.rows[0].approval_status).toBe('rejected')
      expect(statusRows.rows[0].requester_replacement_assignment_id).toBeNull()
      expect(statusRows.rows[0].counterparty_replacement_assignment_id).toBeNull()

      const retry = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, {
        method: 'POST',
        headers: authHeaders(requesterToken),
        body: JSON.stringify({ requesterAssignmentId: pair.assignmentA, counterpartyAssignmentId: pair.assignmentB }),
      })
      expect(retry.status).toBe(201)
    } finally {
      await cleanupPrefix(prefix)
    }
  })
})
