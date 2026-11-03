import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createOnlinePunchDbFixture, punchClock, punchPlugin } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('ATTENDANCE_TIMEZONE_TARGET_ROUTES_REAL_DATABASE_REQUIRED')
const live = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
type Target = {
  orgId: string, userId: string, workDate: string, timezone: string, contextFingerprint: string,
  frozen: boolean, referenceId: string | null, provenance: Record<string, unknown> | null,
  window: { startAt: Date, endAt: Date }, rule: Record<string, unknown>, isWorkingDay: boolean,
}
const plugin = punchPlugin as unknown as {
  readTargetTimezoneContext(trx: { query: (text: string, values: unknown[]) => Promise<unknown[]> },
    input: { orgId: string, userId: string, workDate: string }): Promise<Target>
}
describe('target timezone preview actual HTTP and PostgreSQL', () => {
  let admin: Awaited<ReturnType<typeof live.user>>
  let employee: Awaited<ReturnType<typeof live.user>>
  const self = '/api/attendance/timezone-context/me?workDate=2026-01-07'
  const employeePath = (userId: string) => '/api/attendance/timezone-context/employees/' + userId + '?workDate=2026-01-07'
  const get = (route: string, token?: string) => live.request(route, token, undefined, 'GET')
  const failure = (status: number, code: string) => ({ status, body: { ok: false, error: { code } } })
  const shape = (response: Awaited<ReturnType<typeof get>>) => ({ status: response.status, body: response.body })
  const zero = { events: 0, records: 0, requests: 0, operations: 0 }
  async function expected(userId: string) {
    const client = await live.pool.connect()
    try {
      await client.query('BEGIN')
      const target = await plugin.readTargetTimezoneContext({
        query: async (text, values) => (await client.query(text, values)).rows,
      }, { orgId: live.orgId, userId, workDate: '2026-01-07' })
      return { ...target, window: {
        startAt: target.window.startAt.toISOString(), endAt: target.window.endAt.toISOString(),
      } }
    } finally { await client.query('ROLLBACK'); client.release() }
  }
  beforeAll(async () => {
    punchClock.setOnlinePunchInstantForTests('2026-01-06T20:00:00.000Z')
    admin = await live.start()
    employee = await live.user(false)
  }, 180_000)
  afterAll(async () => { await live.stop() }, 60_000)

  it('serves employee self preview from the real scoped runtime port, default OFF', async () => {
    const response = await get(self, employee.token)
    expect(shape(response)).toEqual({ status: 200, body: { ok: true, data: await expected(employee.userId) } })
    const rule = (await live.pool.query('SELECT id,timezone,timezone_version FROM attendance_rules WHERE org_id=$1 AND is_default=true', [live.orgId])).rows[0]
    expect(response.body.data.provenance).toEqual({
      timezone: 'UTC', source: 'system_default', mode: 'default_only',
      referenceId: rule.id, version: rule.timezone_version, policyVersion: 0, calculationGroupMembership: null,
    })
    expect(response.body.data.window).toEqual({ startAt: '2026-01-07T09:00:00.000Z', endAt: '2026-01-07T18:00:00.000Z' })
    expect(response.body.data.contextFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(await live.counts(employee.userId)).toEqual(zero)
  })
  it('serves admin employee preview with the same exact target', async () => {
    expect(shape(await get(employeePath(employee.userId), admin.token))).toEqual({
      status: 200, body: { ok: true, data: await expected(employee.userId) },
    })
    expect(await live.counts(employee.userId)).toEqual(zero)
  })
  it.each(['self', 'employee'])('rejects anonymous %s preview at the JWT gate', async kind => {
    expect(shape(await get(kind === 'self' ? self : employeePath(employee.userId)))).toEqual({
      status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } },
    })
  })
  it('refuses reader access to another employee via the admin route', async () => {
    expect(shape(await get(employeePath(admin.userId), employee.token))).toEqual({
      status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
    })
  })
  it.each(['userId', 'timezone'])('rejects a self preview override %s', async key => {
    expect(shape(await get(self + '&' + key + '=untrusted', employee.token))).toEqual(failure(400, 'ATTENDANCE_TIMEZONE_TARGET_INVALID'))
  })
  it('rejects an impossible calendar date', async () => {
    expect(shape(await get('/api/attendance/timezone-context/me?workDate=2026-02-30', employee.token))).toEqual(failure(400, 'ATTENDANCE_TIMEZONE_TARGET_INVALID'))
  })
  it('does not permit an admin to select another organization through query', async () => {
    expect(shape(await get(self + '&orgId=' + randomUUID(), admin.token))).toEqual({
      status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } },
    })
  })
  it('rejects a subject whose actual membership belongs to another organization', async () => {
    const foreign = await live.user(false)
    await live.pool.query('UPDATE user_orgs SET org_id=$1 WHERE user_id=$2 AND org_id=$3', [randomUUID(), foreign.userId, live.orgId])
    expect(shape(await get(employeePath(foreign.userId), admin.token))).toEqual(failure(403, 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED'))
    expect(await live.counts(foreign.userId)).toEqual(zero)
  })
  it('rejects revoked actor membership despite a previously valid JWT', async () => {
    const revoked = await live.user(false)
    expect((await get(self, revoked.token)).status).toBe(200)
    await live.pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [revoked.userId, live.orgId])
    expect(shape(await get(self, revoked.token))).toEqual({
      status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found' } },
    })
    expect(await live.counts(revoked.userId)).toEqual(zero)
  })
  it('does not materialize configuration, companion, or attendance data during preview', async () => {
    await get(self, employee.token)
    const result = await live.pool.query('SELECT '
      + '(SELECT count(*)::int FROM attendance_timezone_policies WHERE org_id=$1) AS policies,'
      + '(SELECT count(*)::int FROM attendance_timezone_policy_audit WHERE org_id=$1) AS audit,'
      + '(SELECT count(*)::int FROM attendance_timezone_context_companions WHERE org_id=$1) AS companions', [live.orgId])
    expect(result.rows).toEqual([{ policies: 0, audit: 0, companions: 0 }])
    expect(await live.counts(employee.userId)).toEqual(zero)
  })
})
