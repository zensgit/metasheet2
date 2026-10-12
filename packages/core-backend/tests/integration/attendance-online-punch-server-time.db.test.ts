import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

const fixture = createOnlinePunchDbFixture()
const instant = '2026-08-19T23:59:30.000Z'
describe('ordinary online punch server time (whole-file real HTTP/PostgreSQL)', () => {
  let admin: Awaited<ReturnType<typeof fixture.user>>
  beforeAll(async () => { admin = await fixture.start() }, 180_000)
  afterAll(async () => { await fixture.stop() }, 60_000)
  it.each(['occurredAt', 'occurred_at'].flatMap(alias => [null, '', 'invalid', '2020-01-01T00:00:00Z', false, 0, {}, []].map(value => ({ alias, value }))))(
    'rejects own $alias presence (%j) after permission with zero business writes', async ({ alias, value }) => {
      const actor = await fixture.user()
      const before = await fixture.counts(actor.userId)
      const response = await fixture.request('/api/attendance/punch', actor.token, { eventType: 'check_in', orgId: fixture.orgId, [alias]: value })
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ ok: false, error: { code: 'PUNCH_CLIENT_TIMESTAMP_FORBIDDEN', message: 'The server determines online punch time' } })
      expect(await fixture.counts(actor.userId)).toEqual(before)
    },
  )
  it('permission gate refuses before timestamp validation and before receipt/business IO', async () => {
    const actor = await fixture.user(false)
    const before = await fixture.counts(actor.userId)
    expect((await fixture.request('/api/attendance/rules/me',actor.token,undefined,'GET')).status).toBe(200)
    const response = await fixture.request('/api/attendance/punch', actor.token, { eventType: 'check_in', orgId: fixture.orgId, operationId: randomUUID(), occurred_at: null })
    expect(process.env.RBAC_BYPASS).toBe('false')
    const grants = await fixture.pool.query("SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1 AND rp.permission_code='attendance:write'",[actor.userId])
    expect(grants.rows).toEqual([])
    expect(response.status).toBe(403)
    expect(response.body.error.code).not.toBe('PUNCH_CLIENT_TIMESTAMP_FORBIDDEN')
    expect(await fixture.counts(actor.userId)).toEqual(before)
  })
  it('persists the captured server instant and its timezone day with a direct NULL business snapshot', async () => {
    const actor = await fixture.user()
    punchClock.setOnlinePunchInstantForTests(instant)
    const id = randomUUID()
    const response = await fixture.request('/api/attendance/punch', actor.token, { orgId: fixture.orgId, eventType: 'check_in', timezone: 'Asia/Singapore', operationId: id })
    expect(response.status).toBe(200)
    expect(new Date(response.body.data.event.occurred_at).toISOString()).toBe(instant)
    const event = (await fixture.pool.query('SELECT occurred_at, work_date::text, timezone FROM attendance_events WHERE user_id=$1', [actor.userId])).rows[0]
    expect(event).toEqual({ occurred_at: new Date(instant), work_date: '2026-08-20', timezone: 'Asia/Singapore' })
    const op = (await fixture.pool.query('SELECT response_snapshot,normalized_business_input_snapshot,state FROM attendance_result_operations WHERE org_id=$1 AND operation_id=$2', [fixture.orgId,id])).rows
    expect(op).toEqual([{ state: 'completed', normalized_business_input_snapshot: null, response_snapshot: { version: 'attendance-online-punch-v1', status: 200, body: response.body } }])
    expect(await fixture.counts(actor.userId)).toEqual({ events: 1, records: 1, requests: 0, operations: 1 })
  })
  it('null ID legacy still stamps server time and writes zero canonical operation rows', async () => {
    const actor = await fixture.user()
    punchClock.setOnlinePunchInstantForTests(instant)
    const response = await fixture.request('/api/attendance/punch', actor.token, { orgId: fixture.orgId, eventType: 'check_out' })
    expect(response.status).toBe(200)
    expect(new Date(response.body.data.event.occurred_at).toISOString()).toBe(instant)
    expect(await fixture.counts(actor.userId)).toEqual({ events: 1, records: 1, requests: 0, operations: 0 })
  })
  it('forbids both aliases together and preserves reserved-source refusal', async () => {
    const actor = await fixture.user()
    const both = await fixture.request('/api/attendance/punch', actor.token, { orgId: fixture.orgId, eventType: 'check_in', occurredAt: null, occurred_at: '' })
    expect(both.status).toBe(400)
    const forged = await fixture.request('/api/attendance/punch', actor.token, { orgId: fixture.orgId, eventType: 'check_in', source: 'outdoor_approval' })
    expect(forged.status).toBe(422)
    expect(forged.body.error.code).toBe('PUNCH_SOURCE_RESERVED')
    expect(await fixture.counts(actor.userId)).toEqual({ events: 0, records: 0, requests: 0, operations: 0 })
  })
})
