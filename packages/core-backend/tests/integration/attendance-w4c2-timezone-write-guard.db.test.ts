/**
 * W4C-2 (#4556 lock §12.2 last sentence; #4607 gate handover P3-4) — strict
 * IANA timezone WRITE-route guard, route-level against a real server + real
 * Postgres.
 *
 * "Default-rule and shift timezone writes use the same strict IANA validator;
 * a persisted invalid zone is never accepted as a future calculation input."
 *
 * Before this slice the default-rule route accepted ANY `z.string()` timezone
 * and the shift routes accepted any string too, so garbage zones could persist
 * and later reach the W4 calculator as frozen-context input (where they would
 * fail closed as invalid_timezone review — but the lock demands they never
 * persist in the first place). The plugin consumes the ONE host-provided
 * validator through the least-privilege `attendanceW4SegmentCalculation`
 * services port; it has no local copy.
 *
 * Discriminating fixtures:
 *  - `+05:00` is ACCEPTED by the plugin's older loose Intl probe
 *    (`isValidTimeZoneIdentifier`) but REJECTED by the strict validator —
 *    swapping the strict port call for the loose local probe flips that leg;
 *  - `Not/AZone` persisted silently before this slice — removing the route
 *    check entirely flips that leg;
 *  - valid `Asia/Shanghai` writes stay accepted end-to-end (positive control,
 *    proving the guard is discriminating rather than fail-all).
 *
 * Shared-DB fixture discipline: all rows live in a per-run random org
 * `w4c2tz_<run>` — no shared 'default'-org state is touched.
 */
import * as path from 'path'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MetaSheetServer } from '../../src/index'

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

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const ORG = `w4c2tz_${RUN}`

describeDb('W4C-2 strict IANA timezone write guard (#4607 P3-4, real DB, route level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let adminToken = ''

  const authHeaders = () => ({ Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' })
  const putDefaultRule = (body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/rules/default`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ orgId: ORG, ...body }) })
  const postShift = (body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/shifts`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ orgId: ORG, ...body }) })
  const putShift = (id: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/shifts/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ orgId: ORG, ...body }) })

  const ruleCount = async () =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_rules WHERE org_id = $1', [ORG])).rows[0].n)
  const shiftCount = async () =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_shifts WHERE org_id = $1', [ORG])).rows[0].n)

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('timezone write guard integration needs a loopback port + DATABASE_URL')

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
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=w4c2tz-admin-${RUN}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`,
    )
    adminToken = (res.body as { token?: string } | undefined)?.token ?? ''
    if (!adminToken) throw new Error('failed to mint dev token')
  }, 120_000)

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM attendance_shift_segments WHERE org_id = $1', [ORG]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_shifts WHERE org_id = $1', [ORG]).catch(() => undefined)
      await pool.query('DELETE FROM attendance_rules WHERE org_id = $1', [ORG]).catch(() => undefined)
    }
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) {
      await (server as unknown as { stop: () => Promise<void> }).stop()
    }
    await pool?.end().catch(() => undefined)
  })

  it('default-rule write with an offset-form timezone (+05:00 — the LOOSE Intl probe accepts it) is 400 with zero rule rows written', async () => {
    const before = await ruleCount()
    const res = await putDefaultRule({ timezone: '+05:00' })
    expect(res.status).toBe(400)
    expect((res.body as { error?: { code?: string } })?.error?.code).toBe('VALIDATION_ERROR')
    // Values-free: the rejected zone is not echoed back in the message.
    expect(res.raw).not.toContain('+05:00')
    expect(await ruleCount()).toBe(before)
  })

  it('default-rule write with a non-IANA string is 400 with zero rule rows written (previously persisted silently)', async () => {
    const before = await ruleCount()
    const res = await putDefaultRule({ timezone: 'Not/AZone' })
    expect(res.status).toBe(400)
    expect((res.body as { error?: { code?: string } })?.error?.code).toBe('VALIDATION_ERROR')
    expect(await ruleCount()).toBe(before)
  })

  it('positive control: a valid IANA default-rule timezone write persists end-to-end', async () => {
    const res = await putDefaultRule({ timezone: 'Asia/Shanghai', name: `w4c2tz-rule-${RUN}` })
    expect(res.status).toBe(200)
    const row = await pool.query(
      'SELECT timezone FROM attendance_rules WHERE org_id = $1 AND is_default = true',
      [ORG],
    )
    expect(row.rows).toEqual([{ timezone: 'Asia/Shanghai' }])
  })

  it('a timezone-less default-rule write is untouched by the guard (no new rejection surface)', async () => {
    const res = await putDefaultRule({ name: `w4c2tz-rule2-${RUN}` })
    expect(res.status).toBe(200)
  })

  it('shift create with an offset-form timezone is 400 with zero shift rows written', async () => {
    const before = await shiftCount()
    const res = await postShift({ name: `w4c2tz-shift-bad-${RUN}`, timezone: '+05:00' })
    expect(res.status).toBe(400)
    expect((res.body as { error?: { code?: string } })?.error?.code).toBe('VALIDATION_ERROR')
    expect(await shiftCount()).toBe(before)
  })

  it('shift create with a non-IANA string is 400 with zero shift rows written', async () => {
    const before = await shiftCount()
    const res = await postShift({ name: `w4c2tz-shift-bad2-${RUN}`, timezone: 'Mars/OlympusMons' })
    expect(res.status).toBe(400)
    expect(await shiftCount()).toBe(before)
  })

  it('shift create/update positive control + update rejection leaves the persisted zone unchanged', async () => {
    const created = await postShift({ name: `w4c2tz-shift-${RUN}`, timezone: 'Asia/Shanghai' })
    expect(created.status).toBe(201)
    const shiftId = (created.body as { data?: { id?: string } })?.data?.id ?? ''
    expect(shiftId).not.toBe('')

    const badUpdate = await putShift(shiftId, { timezone: '+08:00' })
    expect(badUpdate.status).toBe(400)
    const afterBad = await pool.query('SELECT timezone FROM attendance_shifts WHERE id = $1', [shiftId])
    expect(afterBad.rows).toEqual([{ timezone: 'Asia/Shanghai' }])

    const goodUpdate = await putShift(shiftId, { timezone: 'Europe/Berlin' })
    expect(goodUpdate.status).toBe(200)
    const afterGood = await pool.query('SELECT timezone FROM attendance_shifts WHERE id = $1', [shiftId])
    expect(afterGood.rows).toEqual([{ timezone: 'Europe/Berlin' }])
  })

  it('two-point wiring self-check: this file is listed in the plugin-tests attendance step and the no-DB vitest exclude', async () => {
    const fs = await import('fs/promises')
    const self = 'tests/integration/attendance-w4c2-timezone-write-guard.db.test.ts'
    const workflow = await fs.readFile(path.join(__dirname, '../../../../.github/workflows/plugin-tests.yml'), 'utf8')
    expect(workflow).toContain(self)
    const vitestConfig = await fs.readFile(path.join(__dirname, '../../vitest.config.ts'), 'utf8')
    expect(vitestConfig).toContain(self)
  })
})
