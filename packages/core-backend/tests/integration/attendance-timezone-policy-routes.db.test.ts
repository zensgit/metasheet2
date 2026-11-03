import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createOnlinePunchDbFixture } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) {
  throw new Error('ATTENDANCE_TIMEZONE_ROUTES_REAL_DATABASE_REQUIRED')
}
const fixture = createOnlinePunchDbFixture()

describe('attendance timezone policy admin reads (whole-file real HTTP/PostgreSQL)', () => {
  let admin: Awaited<ReturnType<typeof fixture.user>>
  let employee: Awaited<ReturnType<typeof fixture.user>>
  let systemDefault: { orgId: string; referenceId: string; timezone: string; version: number }
  const endpoints = [
    '/api/attendance/timezone-policy',
    '/api/attendance/timezone-policy/employees/:userId',
  ]
  const endpoint = (route: string) => route.replace(':userId', employee.userId)
  const get = (route: string, token?: string) => fixture.request(route, token, undefined, 'GET')
  const assertResponse = (response: Awaited<ReturnType<typeof get>>, status: number, body: unknown) => {
    expect({ status: response.status, body: response.body }).toEqual({ status, body })
    expect(JSON.parse(response.raw)).toEqual(body)
  }

  beforeAll(async () => {
    admin = await fixture.start()
    employee = await fixture.user(false)
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    const initial = await fixture.pool.query(
      'SELECT id, timezone, timezone_version FROM attendance_rules WHERE org_id=$1 AND is_default=true',
      [fixture.orgId],
    )
    expect(initial.rows).toEqual([{ id: initial.rows[0].id, timezone: 'UTC', timezone_version: 1 }])
    // Exercise the real source revision trigger, then a no-op update.
    await fixture.pool.query(
      "UPDATE attendance_rules SET timezone='Asia/Singapore' WHERE org_id=$1 AND is_default=true",
      [fixture.orgId],
    )
    await fixture.pool.query(
      "UPDATE attendance_rules SET timezone='Asia/Singapore' WHERE org_id=$1 AND is_default=true",
      [fixture.orgId],
    )
    const actual = await fixture.pool.query(
      'SELECT id, timezone, timezone_version FROM attendance_rules WHERE org_id=$1 AND is_default=true',
      [fixture.orgId],
    )
    expect(actual.rows).toEqual([{ id: initial.rows[0].id, timezone: 'Asia/Singapore', timezone_version: 2 }])
    systemDefault = {
      orgId: fixture.orgId, referenceId: actual.rows[0].id, timezone: 'Asia/Singapore', version: 2,
    }
  }, 180_000)

  afterAll(async () => {
    // Only this synthetic fixture's mutable configuration. Append-only audit
    // remains for the isolated database owner; never delete audit to clean users.
    await fixture.pool.query('DELETE FROM attendance_employee_timezone_overrides WHERE org_id=$1', [fixture.orgId])
    await fixture.pool.query('DELETE FROM attendance_timezone_policies WHERE org_id=$1', [fixture.orgId])
    await fixture.stop()
  }, 60_000)

  it('returns the full OFF response with the actual default reference and governed revision', async () => {
    expect((await fixture.pool.query(
      'SELECT org_id FROM attendance_timezone_policies WHERE org_id=$1', [fixture.orgId],
    )).rows).toEqual([])
    assertResponse(await get(endpoints[0], admin.token), 200, {
      ok: true, data: { enabled: false, version: 0, systemDefault },
    })
    expect(await fixture.counts(admin.userId)).toEqual({ events: 0, records: 0, requests: 0, operations: 0 })
  })

  it.each(endpoints)('rejects anonymous GET %s through the real JWT gate', async route => {
    assertResponse(await get(endpoint(route)), 401, {
      ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' },
    })
  })

  it.each(endpoints)('refuses a reader claiming admin in a signed JWT on GET %s', async route => {
    const minted = await get(
      `/api/auth/dev-token?userId=${employee.userId}&tenantId=${fixture.orgId}&roles=admin&perms=attendance:admin`,
    )
    expect(minted.status).toBe(200)
    const token = minted.body.token as string
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    expect({ id: claims.id, tenantId: claims.tenantId, roles: claims.roles, perms: claims.perms }).toEqual({
      id: employee.userId, tenantId: fixture.orgId, roles: ['admin'], perms: ['attendance:admin'],
    })
    const grants = await fixture.pool.query(
      "SELECT permission_code FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:admin' "
      + "UNION SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id "
      + "WHERE ur.user_id=$1 AND rp.permission_code='attendance:admin'",
      [employee.userId],
    )
    expect(grants.rows).toEqual([])
    expect((await fixture.pool.query(
      "SELECT role_id FROM user_roles WHERE user_id=$1 AND role_id='admin'", [employee.userId],
    )).rows).toEqual([])
    assertResponse(await get(endpoint(route), token), 403, {
      ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
    expect(await fixture.counts(employee.userId)).toEqual({ events: 0, records: 0, requests: 0, operations: 0 })
  })

  it.each(endpoints)('refuses forged orgId query on GET %s', async route => {
    assertResponse(await get(`${endpoint(route)}?orgId=${randomUUID()}`, admin.token), 404, {
      ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' },
    })
  })

  it('refuses a target who only belongs to another synthetic organization', async () => {
    const foreign = await fixture.user(false)
    const foreignOrg = randomUUID()
    await fixture.pool.query('DELETE FROM user_orgs WHERE user_id=$1 AND org_id=$2', [foreign.userId, fixture.orgId])
    await fixture.pool.query(
      'INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)', [foreign.userId, foreignOrg],
    )
    expect((await fixture.pool.query(
      'SELECT org_id,is_active FROM user_orgs WHERE user_id=$1', [foreign.userId],
    )).rows).toEqual([{ org_id: foreignOrg, is_active: true }])
    assertResponse(await get(`/api/attendance/timezone-policy/employees/${foreign.userId}`, admin.token), 403, {
      ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' },
    })
  })

  it.each(endpoints)('rejects a deactivated actor with the previously valid JWT on GET %s', async route => {
    const actor = await fixture.user()
    assertResponse(await get(endpoints[0], actor.token), 200, {
      ok: true, data: { enabled: false, version: 0, systemDefault },
    })
    await fixture.pool.query('UPDATE users SET is_active=false WHERE id=$1', [actor.userId])
    try {
      expect((await fixture.pool.query('SELECT is_active FROM users WHERE id=$1', [actor.userId])).rows)
        .toEqual([{ is_active: false }])
      assertResponse(await get(endpoint(route), actor.token), 401, {
        ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
      })
    } finally {
      await fixture.pool.query('UPDATE users SET is_active=true WHERE id=$1', [actor.userId])
    }
  })

  it.each(endpoints)('rejects an inactive org membership while the actor remains active on GET %s', async route => {
    const actor = await fixture.user()
    const expected = route === endpoints[0]
      ? { ok: true, data: { enabled: false, version: 0, systemDefault } }
      : { ok: true, data: { override: null } }
    assertResponse(await get(endpoint(route), actor.token), 200, expected)
    await fixture.pool.query(
      'UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [actor.userId, fixture.orgId],
    )
    try {
      expect((await fixture.pool.query(
        'SELECT u.is_active AS user_active,uo.is_active AS member_active FROM users u '
        + 'JOIN user_orgs uo ON uo.user_id=u.id WHERE u.id=$1 AND uo.org_id=$2',
        [actor.userId, fixture.orgId],
      )).rows).toEqual([{ user_active: true, member_active: false }])
      // The real JWT gate rechecks the tenant membership before the route can
      // obtain an authenticated org; this is not a transaction race proof.
      assertResponse(await get(endpoint(route), actor.token), 403, {
        ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found' },
      })
    } finally {
      await fixture.pool.query(
        'UPDATE user_orgs SET is_active=true WHERE user_id=$1 AND org_id=$2', [actor.userId, fixture.orgId],
      )
    }
  })

  it('permits a real attendance-admin role without platform administrator authority on both GETs', async () => {
    const actor = await fixture.user(false)
    const roles = await fixture.pool.query('SELECT role_id FROM user_roles WHERE user_id=$1', [actor.userId])
    const roleId = roles.rows[0].role_id as string
    expect(roles.rows).toEqual([{ role_id: roleId }])
    expect(roleId.startsWith('online_clock_reader_')).toBe(true)
    expect((await fixture.pool.query(
      'SELECT is_admin,role,is_active FROM users WHERE id=$1', [actor.userId],
    )).rows).toEqual([{ is_admin: false, role: 'user', is_active: true }])
    expect((await fixture.pool.query(
      "SELECT role_id FROM user_roles WHERE user_id=$1 AND role_id='admin'", [actor.userId],
    )).rows).toEqual([])
    expect((await fixture.pool.query(
      "SELECT permission_code FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:admin'",
      [actor.userId],
    )).rows).toEqual([])
    // Only the helper-owned synthetic role is changed and later cleaned up.
    await fixture.pool.query(
      "INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'attendance:admin')", [roleId],
    )
    expect((await fixture.pool.query(
      "SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id "
      + "WHERE ur.user_id=$1 AND rp.permission_code='attendance:admin'", [actor.userId],
    )).rows).toEqual([{ permission_code: 'attendance:admin' }])
    assertResponse(await get(endpoints[0], actor.token), 200, {
      ok: true, data: { enabled: false, version: 0, systemDefault },
    })
    assertResponse(await get(endpoint(endpoints[1]), actor.token), 200, { ok: true, data: { override: null } })
    expect(await fixture.counts(actor.userId)).toEqual({ events: 0, records: 0, requests: 0, operations: 0 })
  })

  it('returns exact null for an active same-org employee without a current override', async () => {
    assertResponse(await get(endpoint(endpoints[1]), admin.token), 200, { ok: true, data: { override: null } })
  })

  it('returns the current same-org override with exact source provenance and performs no business writes', async () => {
    const referenceId = randomUUID()
    const effectiveFrom = new Date(Date.now() - 60_000)
    const effectiveTo = new Date(Date.now() + 3_600_000)
    // Synthetic configuration bootstrap; both GETs remain read-only.
    await fixture.pool.query(
      'INSERT INTO attendance_employee_timezone_overrides '
      + '(id,org_id,user_id,timezone,effective_from,effective_to,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
      [referenceId, fixture.orgId, employee.userId, 'Europe/London', effectiveFrom, effectiveTo, admin.userId],
    )
    const before = await fixture.pool.query(
      'SELECT id,version,effective_from,effective_to FROM attendance_employee_timezone_overrides WHERE id=$1 AND org_id=$2',
      [referenceId, fixture.orgId],
    )
    const auditBefore = await fixture.pool.query(
      'SELECT id,action,reference_id,version FROM attendance_timezone_policy_audit WHERE org_id=$1 ORDER BY id',
      [fixture.orgId],
    )
    assertResponse(await get(endpoint(endpoints[1]), admin.token), 200, {
      ok: true, data: { override: {
        orgId: fixture.orgId, userId: employee.userId, referenceId, timezone: 'Europe/London', version: 1,
        effectiveFrom: effectiveFrom.toISOString(), effectiveTo: effectiveTo.toISOString(),
      } },
    })
    expect((await fixture.pool.query(
      'SELECT id,version,effective_from,effective_to FROM attendance_employee_timezone_overrides WHERE id=$1 AND org_id=$2',
      [referenceId, fixture.orgId],
    )).rows).toEqual(before.rows)
    expect((await fixture.pool.query(
      'SELECT id,action,reference_id,version FROM attendance_timezone_policy_audit WHERE org_id=$1 ORDER BY id',
      [fixture.orgId],
    )).rows).toEqual(auditBefore.rows)
    expect(await fixture.counts(employee.userId)).toEqual({ events: 0, records: 0, requests: 0, operations: 0 })
  })

  it('distinguishes a persisted OFF policy revision from policy row absence', async () => {
    await fixture.pool.query(
      'INSERT INTO attendance_timezone_policies (org_id,enabled,updated_by) VALUES ($1,false,$2)',
      [fixture.orgId, admin.userId],
    )
    assertResponse(await get(endpoints[0], admin.token), 200, {
      ok: true, data: { enabled: false, version: 1, systemDefault },
    })
  })
})
