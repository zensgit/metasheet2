import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'

// Per-user import-template field-picker memory — route-level real-DB tests
// (attendance-import-template-prefs design-lock §4). Drives the actual
// GET/PUT /api/attendance/import/template-prefs routes against a migrated
// postgres with two distinct authenticated actors: the actor is ALWAYS the
// token user (personal-views §7 Q1 rule) — a client-supplied userId must not
// steer the row.

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

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const ORG = 'default'
const ORG_B = `prefs-org-b-${Date.now()}`
const USER_A = `prefs-user-a-${Date.now()}`
const USER_B = `prefs-user-b-${Date.now()}`

describeDb('import template prefs (real DB, route-level, actor-scoped)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let tokenA = ''
  let tokenB = ''

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:import,attendance:admin')}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const getPrefs = (token: string, orgId = ORG) =>
    requestJson(`${baseUrl}/api/attendance/import/template-prefs?orgId=${encodeURIComponent(orgId)}`, { headers: authHeaders(token) })
  const putPrefs = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/import/template-prefs`, { method: 'PUT', headers: authHeaders(token), body: JSON.stringify(body) })
  const keysOf = (res: HttpResponse) => ((res.body as { data?: { selectedKeys?: string[] } })?.data?.selectedKeys ?? null)

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('template-prefs integration needs a loopback port + DATABASE_URL')

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
    tokenA = await mintToken(USER_A)
    tokenB = await mintToken(USER_B)
  })

  afterAll(async () => {
    await pool?.query(`DELETE FROM attendance_import_template_prefs WHERE user_id = ANY($1::text[])`, [[USER_A, USER_B]]).catch(() => undefined)
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
  })

  it('empty read returns [] (no record yet)', async () => {
    const res = await getPrefs(tokenA)
    expect(res.status).toBe(200)
    expect(keysOf(res)).toEqual([])
  })

  it('actor isolation golden: A saves; B reads own (empty); A reads theirs; a spoofed body userId cannot steer the row', async () => {
    const put = await putPrefs(tokenA, { selectedKeys: ['firstInAt', 'status', 'overtimeHours'], userId: USER_B })
    expect(put.status).toBe(200)

    const aRead = await getPrefs(tokenA)
    expect(keysOf(aRead)).toEqual(['firstInAt', 'status', 'overtimeHours'])

    const bRead = await getPrefs(tokenB)
    expect(keysOf(bRead)).toEqual([])

    const row = await pool.query(
      `SELECT user_id FROM attendance_import_template_prefs WHERE org_id = $1 AND user_id = ANY($2::text[])`,
      [ORG, [USER_A, USER_B]],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].user_id).toBe(USER_A)
  })

  it('org dimension isolates records for the same actor', async () => {
    await putPrefs(tokenA, { orgId: ORG_B, selectedKeys: ['lateMinutes'] })
    expect(keysOf(await getPrefs(tokenA, ORG_B))).toEqual(['lateMinutes'])
    expect(keysOf(await getPrefs(tokenA, ORG))).toEqual(['firstInAt', 'status', 'overtimeHours'])
  })

  it('upsert overwrites; trims, dedupes, drops empties', async () => {
    const put = await putPrefs(tokenA, { selectedKeys: [' status ', 'status', '', 'shiftName'] })
    expect(put.status).toBe(200)
    expect(keysOf(put)).toEqual(['status', 'shiftName'])
    expect(keysOf(await getPrefs(tokenA))).toEqual(['status', 'shiftName'])
  })

  it('empty array clears the record (恢复默认 semantics)', async () => {
    const put = await putPrefs(tokenA, { selectedKeys: [] })
    expect(put.status).toBe(200)
    const row = await pool.query(
      `SELECT 1 FROM attendance_import_template_prefs WHERE org_id = $1 AND user_id = $2`,
      [ORG, USER_A],
    )
    expect(row.rows).toHaveLength(0)
    expect(keysOf(await getPrefs(tokenA))).toEqual([])
  })

  it('validation: over-limit and non-string shapes are 400', async () => {
    const tooMany = await putPrefs(tokenA, { selectedKeys: Array.from({ length: 65 }, (_, i) => `k${i}`) })
    expect(tooMany.status).toBe(400)
    const badShape = await putPrefs(tokenA, { selectedKeys: 'status' })
    expect(badShape.status).toBe(400)
    const badItem = await putPrefs(tokenA, { selectedKeys: ['ok', 42] })
    expect(badItem.status).toBe(400)
    const longKey = await putPrefs(tokenA, { selectedKeys: ['x'.repeat(129)] })
    expect(longKey.status).toBe(400)
  })
})
