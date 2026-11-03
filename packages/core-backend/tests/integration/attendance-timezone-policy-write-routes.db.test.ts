import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) {
  throw new Error('ATTENDANCE_TIMEZONE_WRITE_ROUTES_REAL_DATABASE_REQUIRED')
}

describe('attendance timezone policy admin writes (real HTTP/PostgreSQL)', () => {
  const live = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
  let actor: Awaited<ReturnType<typeof live.user>>
  let subject: Awaited<ReturnType<typeof live.user>>
  const policyRoute = '/api/attendance/timezone-policy'
  const createRoute = () => policyRoute + '/employees/' + subject.userId
  const send = (route: string, body: Record<string, unknown>, method = 'POST', token = actor.token) =>
    live.request(route, token, body, method)
  async function state() {
    const values = [live.orgId]
    return {
      policy: (await live.pool.query('SELECT enabled,version FROM attendance_timezone_policies WHERE org_id=$1', values)).rows,
      overrides: (await live.pool.query('SELECT id,user_id,timezone,version,effective_from,effective_to FROM attendance_employee_timezone_overrides WHERE org_id=$1 ORDER BY id', values)).rows,
      audit: (await live.pool.query('SELECT id,action,reference_id,version FROM attendance_timezone_policy_audit WHERE org_id=$1 ORDER BY id', values)).rows,
    }
  }
  const current = async () => (await state()).policy[0] ?? { enabled: false, version: 0 }
  const zero = { events: 0, records: 0, requests: 0, operations: 0 }
  beforeAll(async () => {
    punchClock.setOnlinePunchInstantForTests('2026-01-06T20:00:00.000Z')
    actor = await live.start()
    subject = await live.user(false)
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
  }, 180_000)
  afterAll(async () => { await live.stop() }, 60_000)

  it.each(['policy', 'create', 'close'])('refuses reader configuration write %s before source or audit mutation', async kind => {
    const before = await state()
    const route = kind === 'policy' ? policyRoute : createRoute() + (kind === 'close' ? '/' + randomUUID() + '/close' : '')
    const body = kind === 'policy' ? { enabled: true, expectedVersion: 0 }
      : kind === 'create' ? { timezone: 'Asia/Singapore', effectiveFrom: '2026-01-08T00:00:00Z', effectiveTo: null, expectedPolicyVersion: 0 }
        : { endAt: '2026-01-09T00:00:00Z', expectedVersion: 1 }
    const response = await send(route, body, kind === 'policy' ? 'PUT' : 'POST', subject.token)
    expect({ status: response.status, body: response.body }).toEqual({
      status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
    })
    expect(await state()).toEqual(before)
  })
  it('enables through actual transaction authorization and source guards at the expected revision', async () => {
    const old = await current()
    const response = await send(policyRoute, { enabled: true, expectedVersion: old.version }, 'PUT')
    expect({ status: response.status, body: response.body }).toEqual({
      status: 200, body: { ok: true, data: { enabled: true, version: old.version + 1 } },
    })
    expect((await state()).audit.map(row => ({ action: row.action, version: row.version }))).toEqual([{ action: 'policy_set', version: 1 }])
    expect(await live.counts(subject.userId)).toEqual(zero)
  })
  it('rejects stale policy CAS without changing configuration or audit', async () => {
    const before = await state()
    const response = await send(policyRoute, { enabled: false, expectedVersion: 0 }, 'PUT')
    expect({ status: response.status, body: response.body }).toEqual({
      status: 409, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_CONFIG_CHANGED' } },
    })
    expect(await state()).toEqual(before)
  })
  it('creates and closes a future employee interval with exact UTC provenance and close CAS', async () => {
    const created = await send(createRoute(), { timezone: 'Asia/Singapore', effectiveFrom: '2026-01-08T09:00:00+08:00',
      effectiveTo: null, expectedPolicyVersion: (await current()).version })
    const referenceId = created.body.data?.referenceId as string
    expect(typeof referenceId).toBe('string')
    const expected = { orgId: live.orgId, userId: subject.userId, referenceId, timezone: 'Asia/Singapore',
      version: 1, effectiveFrom: '2026-01-08T01:00:00.000Z', effectiveTo: null }
    expect({ status: created.status, body: created.body }).toEqual({ status: 201, body: { ok: true, data: expected } })
    const close = createRoute() + '/' + referenceId + '/close'
    const closed = await send(close, { endAt: '2026-01-09T09:00:00+08:00', expectedVersion: 1 })
    expect({ status: closed.status, body: closed.body }).toEqual({
      status: 200, body: { ok: true, data: { ...expected, version: 2, effectiveTo: '2026-01-09T01:00:00.000Z' } },
    })
    const before = await state()
    expect((await send(close, { endAt: '2026-01-09T00:00:00Z', expectedVersion: 1 })).status).toBe(409)
    expect(await state()).toEqual(before)
    expect((await state()).audit.map(row => row.action).sort()).toEqual(['override_closed', 'override_created', 'policy_set'])
  })
  it('refuses a foreign employee write without changing source or audit', async () => {
    const foreign = await live.user(false)
    await live.pool.query('UPDATE user_orgs SET org_id=$1 WHERE user_id=$2 AND org_id=$3', [randomUUID(), foreign.userId, live.orgId])
    const before = await state()
    const response = await send(policyRoute + '/employees/' + foreign.userId, { timezone: 'Asia/Tokyo',
      effectiveFrom: '2026-01-10T00:00:00Z', effectiveTo: null, expectedPolicyVersion: (await current()).version })
    expect({ status: response.status, body: response.body }).toEqual({
      status: 403, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' } },
    })
    expect(await state()).toEqual(before)
  })
  it('rejects enablement without default and permits guarded OFF recovery', async () => {
    await live.pool.query('UPDATE attendance_rules SET is_default=false WHERE org_id=$1 AND is_default=true', [live.orgId])
    try {
      const before = await state()
      const old = await current()
      const refused = await send(policyRoute, { enabled: true, expectedVersion: old.version }, 'PUT')
      expect({ status: refused.status, body: refused.body }).toEqual({
        status: 422, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED' } },
      })
      expect(await state()).toEqual(before)
      const disabled = await send(policyRoute, { enabled: false, expectedVersion: old.version }, 'PUT')
      expect({ status: disabled.status, body: disabled.body }).toEqual({
        status: 200, body: { ok: true, data: { enabled: false, version: old.version + 1 } },
      })
      expect((await state()).overrides).toEqual(before.overrides)
      expect(await live.counts(subject.userId)).toEqual(zero)
    } finally {
      await live.pool.query('UPDATE attendance_rules SET is_default=true WHERE org_id=$1', [live.orgId])
    }
  })
  it('preserves started published no-punch context, rolls back conflict audit, and allows the same edit after shift end', async () => {
    // The default is a rest day: its ordinary shift cannot mask this published-source guard.
    await live.pool.query("UPDATE attendance_rules SET working_days='[]'::jsonb WHERE org_id=$1 AND is_default=true", [live.orgId])
    const shiftId = randomUUID()
    await live.pool.query('INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,working_days) '
      + "VALUES($1,$2,'config synthetic','UTC','09:00','18:00',false,'[0,1,2,3,4,5,6]'::jsonb)", [shiftId, live.orgId])
    await live.pool.query('INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status) '
      + "VALUES($1,$2,$3,$4,'2026-01-07','2026-01-07',true,'published')", [randomUUID(), live.orgId, subject.userId, shiftId])
    punchClock.setOnlinePunchInstantForTests('2026-01-07T10:00:00.000Z')
    const before = await state()
    const old = await current()
    expect(await live.counts(subject.userId)).toEqual(zero)
    const response = await send(policyRoute, { enabled: !old.enabled, expectedVersion: old.version }, 'PUT')
    expect({ status: response.status, body: response.body }).toEqual({
      status: 409, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT' } },
    })
    expect(await state()).toEqual(before)
    punchClock.setOnlinePunchInstantForTests('2026-01-07T20:00:00.000Z')
    const later = await send(policyRoute, { enabled: !old.enabled, expectedVersion: old.version }, 'PUT')
    expect({ status: later.status, body: later.body }).toEqual({
      status: 200, body: { ok: true, data: { enabled: !old.enabled, version: old.version + 1 } },
    })
  })
})
