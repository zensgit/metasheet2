import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MetaSheetServer as MetaSheetServerType } from '../../src/index'

const require = createRequire(import.meta.url)
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
type ShiftDto = { id: string; capabilities: unknown; name: string }
type HttpResponse = {
  status: number
  body?: { token?: string; data?: ShiftDto | { items: ShiftDto[] }; error?: { code?: string } }
  raw: string
}
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
          let body: HttpResponse['body']
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

// No skip-shaped green when the isolated database is missing.
describe('W6 reference capability, actual canonical port and HTTP on PostgreSQL', () => {
  let server: MetaSheetServerType | undefined
  let baseUrl = ''
  let pool: Pool
  const savedAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  beforeAll(async () => {
    if (!dbUrl) throw new Error('Isolated W6 database required')
    process.env.DATABASE_URL = dbUrl
    process.env.SKIP_PLUGINS = 'false'
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    pool = new Pool({ connectionString: dbUrl })
    expect((await pool.query('SHOW server_encoding')).rows[0].server_encoding).toBe('UTF8')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0, host: '127.0.0.1',
      pluginDirs: [path.join(__dirname, '../../../../plugins/plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('TCP listener required')
    baseUrl = 'http://127.0.0.1:' + address.port
  }, 120000)
  afterAll(async () => {
    if (savedAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = savedAllowlist
    if (server) await server.stop()
    if (pool) await pool.end()
  })
  const requestJson = rawRequestJson
  async function mintToken(userId: string, tenantId: string): Promise<string> {
    await seedActiveIdentity(userId, tenantId)
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&tenantId=${encodeURIComponent(tenantId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin,attendance:approve,attendance:import')}`,
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
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin') ON CONFLICT DO NOTHING`,
      [userId],
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


  function capabilities(enabled: boolean) {
    return { segmentCalculation: {
      enabled: false, defaultEnabled: false, authoritativeResults: false,
      multiSegmentAuthoring: enabled ? 'enabled' : 'preview_only',
      flag: 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',
    } }
  }
  async function actor(state?: 'shadow' | 'authoritative' | 'suspended') {
    const orgId = randomUUID()
    const token = await mintToken(randomUUID(), orgId)
    if (state) {
      await pool.query(
        "INSERT INTO attendance_calculation_rollout_state (org_id,state,engine_version,reason_code,actor_id,version,prior_state) VALUES ($1,'legacy','w6-capability-synthetic','TEST_FIXTURE','w6-capability-synthetic',1,NULL)",
        [orgId],
      )
      const walk = state === 'shadow' ? ['shadow'] : state === 'authoritative'
        ? ['shadow', 'eligible', 'authoritative'] : ['shadow', 'eligible', 'authoritative', 'suspended']
      for (const next of walk) await pool.query(
        'UPDATE attendance_calculation_rollout_state SET prior_state=state,state=$2,version=version+1 WHERE org_id=$1',
        [orgId, next],
      )
    }
    return { orgId, token }
  }
  async function roundTrip(orgId: string, token: string, admitted: boolean) {
    const created = await postJson('/api/attendance/shifts', token, orgId, {
      name: 'Synthetic split', timezone: 'UTC',
      segments: [{ startTime: '08:00', endTime: '12:00' }, { startTime: '13:00', endTime: '17:00' }],
    })
    expect(created.status, created.raw).toBe(201)
    const shift = created.body?.data as ShiftDto
    expect(shift.capabilities).toEqual(capabilities(admitted))
    const before = (await pool.query('SELECT row_to_json(s)::text AS snapshot FROM attendance_shifts s WHERE id=$1', [shift.id])).rows
    const detail = await requestJson(baseUrl + '/api/attendance/shifts/' + shift.id, { headers: authHeaders(token, orgId) })
    expect(detail.status, detail.raw).toBe(200)
    expect((detail.body?.data as ShiftDto).capabilities).toEqual(capabilities(admitted))
    const list = await requestJson(baseUrl + '/api/attendance/shifts?pageSize=10', { headers: authHeaders(token, orgId) })
    expect(list.status, list.raw).toBe(200)
    expect((list.body?.data as { items: ShiftDto[] }).items.find(item => item.id === shift.id)?.capabilities).toEqual(capabilities(admitted))
    expect((await pool.query('SELECT row_to_json(s)::text AS snapshot FROM attendance_shifts s WHERE id=$1', [shift.id])).rows).toEqual(before)
    const updated = await putJson('/api/attendance/shifts/' + shift.id, token, orgId, { name: 'Synthetic renamed' })
    expect(updated.status, updated.raw).toBe(200)
    expect((updated.body?.data as ShiftDto).name).toBe('Synthetic renamed')
    expect((updated.body?.data as ShiftDto).capabilities).toEqual(capabilities(admitted))
    return shift.id
  }

  it('keeps all four HTTP paths closed under the default posture', async () => {
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const a = await actor()
    await roundTrip(a.orgId, a.token, false)
  })
  it('reports reference admission on all four HTTP paths but no available calculator', async () => {
    const a = await actor('shadow')
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = a.orgId
    await roundTrip(a.orgId, a.token, true)
  })
  it('does not leak admission from A to non-allowlisted B or expose an A shift to B', async () => {
    const a = await actor('shadow'), b = await actor('shadow')
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = a.orgId
    const id = await roundTrip(a.orgId, a.token, true)
    await roundTrip(b.orgId, b.token, false)
    const again = await requestJson(baseUrl + '/api/attendance/shifts/' + id, { headers: authHeaders(a.token, a.orgId) })
    expect((again.body?.data as ShiftDto).capabilities).toEqual(capabilities(true))
    const cross = await requestJson(baseUrl + '/api/attendance/shifts/' + id, { headers: authHeaders(b.token, b.orgId) })
    expect(cross.status, cross.raw).toBe(404)
  })
  it('keeps authoritative-result metadata false in a canonical authoritative posture', async () => {
    const a = await actor('authoritative')
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = a.orgId
    await roundTrip(a.orgId, a.token, true)
  })
  it('honors suspension and rejects wildcard admission without rewriting the rollout state', async () => {
    const a = await actor('shadow')
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = '*'
    const id = await roundTrip(a.orgId, a.token, false)
    for (const next of ['eligible', 'authoritative', 'suspended']) await pool.query(
      'UPDATE attendance_calculation_rollout_state SET prior_state=state,state=$2,version=version+1 WHERE org_id=$1',
      [a.orgId, next],
    )
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = a.orgId
    const detail = await requestJson(baseUrl + '/api/attendance/shifts/' + id, { headers: authHeaders(a.token, a.orgId) })
    expect(detail.status, detail.raw).toBe(200)
    expect((detail.body?.data as ShiftDto).capabilities).toEqual(capabilities(false))
    expect((await pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1', [a.orgId])).rows).toEqual([{ state: 'suspended' }])
  })
  it('sets actual PostgreSQL read-only before the hint callback and cannot change an existing shift', async () => {
    const a = await actor()
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const id = await roundTrip(a.orgId, a.token, false)
    const before = (await pool.query('SELECT name FROM attendance_shifts WHERE id=$1', [id])).rows
    expect(before).toEqual([{ name: 'Synthetic renamed' }])
    const { readAttendanceShiftReferenceCapability } = require('../../../../plugins/plugin-attendance/lib/attendance-shift-reference-capability.cjs') as {
      readAttendanceShiftReferenceCapability: (db: unknown, port: unknown, orgId: string) => Promise<boolean>
    }
    const events: string[] = []
    let readOnly = '', state = ''
    const db = {
      async transaction(run: (trx: { query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]> }) => Promise<unknown>) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN'); events.push('BEGIN')
          const value = await run({ query: async (sql, values) => {
            events.push(sql)
            return (await client.query(sql, values)).rows
          } })
          await client.query('COMMIT'); events.push('COMMIT')
          return value
        } catch (error) {
          await client.query('ROLLBACK'); events.push('ROLLBACK')
          throw error
        } finally { client.release() }
      },
    }
    const admitted = await readAttendanceShiftReferenceCapability(db, {
      async resolveTimezoneSegmentReferencePosture(trx: { query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]> }) {
        readOnly = String((await trx.query('SHOW transaction_read_only'))[0].transaction_read_only)
        try { await trx.query("UPDATE attendance_shifts SET name='must-not-write' WHERE id=$1", [id]) }
        catch (error) { state = String((error as { code?: string }).code); throw error }
        return { referenceSegments: true }
      },
    }, a.orgId)
    expect(admitted).toBe(false)
    expect(readOnly).toBe('on')
    expect(state).toBe('25006')
    expect(events.slice(0, 2)).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY'])
    expect(events[events.length - 1]).toBe('ROLLBACK')
    expect((await pool.query('SELECT name FROM attendance_shifts WHERE id=$1', [id])).rows).toEqual(before)
  })

  it('keeps canonical shared-lock and posture SELECT on the actual readonly PostgreSQL connection', async () => {
    const a = await actor('shadow')
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = a.orgId
    const created = await postJson('/api/attendance/shifts', a.token, a.orgId, {
      name: 'Synthetic trace', timezone: 'UTC', workStartTime: '09:00', workEndTime: '17:00',
    })
    expect(created.status, created.raw).toBe(201)
    const id = (created.body?.data as ShiftDto).id
    const observed: Array<{ sql: string; pid: number }> = []
    const original = Client.prototype.query
    const wrapped = function (this: Client, ...args: unknown[]) {
      const input = args[0]
      const sql = typeof input === 'string' ? input : String((input as { text?: unknown })?.text ?? '')
      observed.push({ sql, pid: Number((this as unknown as { processID?: number }).processID) })
      return Reflect.apply(original, this, args)
    }
    // Forward all pg overloads untouched; observe only SQL text and the real backend process ID.
    const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(wrapped as typeof original)
    try {
      const detail = await requestJson(baseUrl + '/api/attendance/shifts/' + id, { headers: authHeaders(a.token, a.orgId) })
      expect(detail.status, detail.raw).toBe(200)
      expect((detail.body?.data as ShiftDto).capabilities).toEqual(capabilities(true))
    } finally { spy.mockRestore() }
    const start = observed.findIndex(item => item.sql === 'SET TRANSACTION READ ONLY')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = observed.findIndex((item, index) => index > start && item.sql === 'COMMIT')
    expect(end).toBeGreaterThan(start)
    const readonly = observed.slice(start, end + 1)
    expect(readonly.every(item => item.pid === readonly[0].pid && item.pid > 0)).toBe(true)
    const lock = readonly.findIndex(item => item.sql.includes('pg_advisory_xact_lock_shared'))
    const posture = readonly.findIndex(item => item.sql.includes('SELECT state, scope FROM attendance_calculation_rollout_state'))
    expect(lock).toBeGreaterThan(0)
    expect(posture).toBeGreaterThan(lock)
    expect(readonly.filter(item => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(item.sql))).toEqual([])
  })

  it('refuses foreign detail selectors exactly as the collection with real authenticated tenants', async () => {
    const a = await actor('shadow'), b = await actor()
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = a.orgId
    const id = await roundTrip(a.orgId, a.token, true)
    const list = await requestJson(baseUrl + '/api/attendance/shifts?orgId=' + a.orgId, { headers: authHeaders(b.token, b.orgId) })
    expect(list.status).toBe(404)
    expect(list.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    for (const selector of ['query', 'header', 'body'] as const) {
      const headers = authHeaders(b.token, selector === 'header' ? a.orgId : b.orgId)
      const detail = await requestJson(baseUrl + '/api/attendance/shifts/' + id + (selector === 'query' ? '?orgId=' + a.orgId : ''), {
        headers: selector === 'body' ? { ...headers, 'Content-Length': String(Buffer.byteLength(JSON.stringify({ orgId: a.orgId }))) } : headers,
        body: selector === 'body' ? JSON.stringify({ orgId: a.orgId }) : undefined,
      })
      expect(detail.status, selector).toBe(404)
      expect(detail.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    }
    const foreign = await requestJson(baseUrl + '/api/attendance/shifts/' + id, { headers: authHeaders(b.token, b.orgId) })
    expect(foreign.status).toBe(404)
    expect(foreign.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Shift not found' } })
    const own = await requestJson(baseUrl + '/api/attendance/shifts/' + id, { headers: authHeaders(a.token, a.orgId) })
    expect(own.status).toBe(200)
    expect((own.body?.data as ShiftDto).capabilities).toEqual(capabilities(true))
  })

})
