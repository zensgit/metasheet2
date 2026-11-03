import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('ATTENDANCE_TIMEZONE_POLICY_PREVIEW_REAL_DATABASE_REQUIRED')
const live = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
describe('timezone enable impact preview actual HTTP and PostgreSQL', () => {
  let admin: Awaited<ReturnType<typeof live.user>>
  let employee: Awaited<ReturnType<typeof live.user>>
  let excluded: Awaited<ReturnType<typeof live.user>>
  const route = '/api/attendance/timezone-policy/preview'
  const post = (body: Record<string, unknown>, token?: string) => live.request(route, token, body)
  const shape = (response: Awaited<ReturnType<typeof post>>) => ({ status: response.status, body: response.body })
  const failure = (status: number, code: string) => ({ status, body: { ok: false, error: { code } } })
  async function snapshot() {
    const rows: Record<string, unknown[]> = {}
    for (const table of ['attendance_timezone_policies', 'attendance_timezone_policy_audit',
      'attendance_employee_timezone_overrides', 'attendance_events', 'attendance_records',
      'attendance_requests', 'attendance_result_operations']) {
      rows[table] = (await live.pool.query('SELECT t.* FROM ' + table + ' t WHERE org_id=$1 ORDER BY to_jsonb(t)::text', [live.orgId])).rows
    }
    return rows
  }
  beforeAll(async () => {
    punchClock.setOnlinePunchInstantForTests('2026-01-06T20:00:00.000Z')
    admin = await live.start()
    employee = await live.user(false)
    excluded = await live.user(false)
    await live.pool.query('UPDATE user_orgs SET org_id=$1 WHERE user_id=$2 AND org_id=$3', [randomUUID(), excluded.userId, live.orgId])
  }, 180_000)
  afterAll(async () => { await live.stop() }, 60_000)
  it('returns real active-member counts, current revision and zero configuration/business writes', async () => {
    const before = await snapshot()
    const response = await post({ enabled: true, expectedVersion: 0 }, admin.token)
    expect(shape(response)).toEqual({ status: 200, body: { ok: true, data: {
      currentVersion: 0, proposedEnabled: true, evaluatedUsers: 2, affectedUsers: 2, conflictingUsers: 0,
      conflictCounts: { startedContext: 0, tripContext: 0, invalidTargetContext: 0 },
    } } })
    expect(response.raw).not.toContain(employee.userId)
    expect(response.raw).not.toContain(excluded.userId)
    expect(await snapshot()).toEqual(before)
  })
  it('counts currently started default shifts even when neither employee has punched', async () => {
    punchClock.setOnlinePunchInstantForTests('2026-01-07T10:00:00.000Z')
    try {
      const before = await snapshot()
      expect(shape(await post({ enabled: true, expectedVersion: 0 }, admin.token))).toEqual({
        status: 200, body: { ok: true, data: {
          currentVersion: 0, proposedEnabled: true, evaluatedUsers: 2, affectedUsers: 2, conflictingUsers: 2,
          conflictCounts: { startedContext: 2, tripContext: 0, invalidTargetContext: 0 },
        } },
      })
      expect(await snapshot()).toEqual(before)
    } finally { punchClock.setOnlinePunchInstantForTests('2026-01-06T20:00:00.000Z') }
  })
  it('refuses an anonymous preview at the JWT gate', async () => {
    expect(shape(await post({ enabled: true, expectedVersion: 0 }))).toEqual({
      status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } },
    })
  })
  it('refuses a reader preview without writing or exposing partial counts', async () => {
    const before = await snapshot()
    expect(shape(await post({ enabled: true, expectedVersion: 0 }, employee.token))).toEqual({
      status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
    })
    expect(await snapshot()).toEqual(before)
  })
  it.each([{ enabled: 'true', expectedVersion: 0 }, { enabled: true, expectedVersion: 0, policyProjection: {} }])(
    'rejects malformed client projection without source changes', async body => {
      const before = await snapshot()
      expect(shape(await post(body, admin.token))).toEqual(failure(400, 'ATTENDANCE_TIMEZONE_INVALID_INPUT'))
      expect(await snapshot()).toEqual(before)
    },
  )
  it('fails explicitly without counts when the default source is absent', async () => {
    await live.pool.query('UPDATE attendance_rules SET is_default=false WHERE org_id=$1', [live.orgId])
    try {
      const before = await snapshot()
      expect(shape(await post({ enabled: true, expectedVersion: 0 }, admin.token))).toEqual(failure(422, 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED'))
      expect(await snapshot()).toEqual(before)
    } finally { await live.pool.query('UPDATE attendance_rules SET is_default=true WHERE org_id=$1', [live.orgId]) }
  })
  it('rejects a stale expected policy version after an actual configuration change', async () => {
    const saved = await live.request('/api/attendance/timezone-policy', admin.token, { enabled: true, expectedVersion: 0 }, 'PUT')
    expect(shape(saved)).toEqual({ status: 200, body: { ok: true, data: { enabled: true, version: 1 } } })
    const before = await snapshot()
    expect(shape(await post({ enabled: false, expectedVersion: 0 }, admin.token))).toEqual(failure(409, 'ATTENDANCE_TIMEZONE_CONFIG_CHANGED'))
    expect(await snapshot()).toEqual(before)
  })
})
