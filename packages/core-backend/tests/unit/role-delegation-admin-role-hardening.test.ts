/**
 * Owner ruling 2026-10-10 「只有平台管理员能任命 *_admin」, for EVERY namespace.
 *
 *  R1. A delegated (non-platform) admin may neither assign nor revoke a role whose id derives a
 *      delegated-admin namespace (`deriveDelegatedAdminNamespace`, the predicate that GRANTS
 *      delegated-admin identity) — `attendance_admin`, `stock-prep_admin`, any `x_admin`, and a
 *      nested `stock-prep_data_admin`. Platform admins are unaffected.
 *  R2. A delegated admin may neither assign nor revoke a role that carries a permission code
 *      outside the namespace it reaches the role through (platform codes). The codes are read
 *      INSIDE the write transaction, after the role row is held FOR SHARE.
 *  R3. Revoking a main-admin role removes that user's delegated audience for the namespace (both
 *      the department table and the member-group table) in the same transaction, unless another
 *      held role still derives the namespace; a fresh appointment starts with no audience.
 *  R4. Every R1/R2 refusal is audited in the delegation audit shape; responses are values-free.
 *  R5. The delegate's assignable list and "current delegable roles" agree with the route.
 *  R6. Gate order: an empty body still answers its 400 first on the role route and on the
 *      admission PATCH (#5690 pins "not 401/403" for a delegated attendance_admin).
 *
 * Harness: only `db/pg`, `rbac/service` and `audit/audit` are mocked; `namespace-admission` and
 * `role-assignment` are the shipped modules. `db/pg` is a small in-memory model keyed by SQL
 * shape, so no leg depends on a call-ordering count, and the transaction client tags every
 * statement it carries so "inside the transaction" is an observed fact, not an assumption.
 *
 * LANE: `tests/unit/*.test.ts`, collected by the default vitest discovery of the required
 * `test (20.x)` check. No `request(app)` here (#4154): handlers are invoked directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response, Router } from 'express'

type Via = 'pool' | 'tx'
type Seen = { sql: string; params: unknown[]; via: Via }

const db = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  userRoles: new Map<string, Set<string>>(),
  roles: new Map<string, string[]>(),
  scopes: [] as Array<{ adminUserId: string; namespace: string; table: 'dept' | 'group' }>,
  seen: [] as Array<{ sql: string; params: unknown[]; via: 'pool' | 'tx' }>,
  transactions: 0,
}))

const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn(async () => undefined) }))
const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(async (_userId: string) => false),
  listUserPermissions: vi.fn(async () => [] as string[]),
  invalidateUserPerms: vi.fn(),
  userHasPermission: vi.fn(async () => false),
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))
vi.mock('../../src/rbac/service', () => rbacMocks)

const pgMocks = vi.hoisted(() => {
  const route = async (sql: string, params: unknown[] = [], via: 'pool' | 'tx' = 'pool') => {
    db.seen.push({ sql, params, via })
    const s = sql.replace(/\s+/g, ' ').trim()
    const rolesOf = (userId: string) => {
      if (!db.userRoles.has(userId)) db.userRoles.set(userId, new Set())
      return db.userRoles.get(userId) as Set<string>
    }
    const scopeRowsFor = (table: 'dept' | 'group', adminUserId: string, namespaces?: string[]) =>
      db.scopes.filter((scope) => scope.table === table && scope.adminUserId === adminUserId
        && (!namespaces || namespaces.includes(scope.namespace)))

    if (/WITH RECURSIVE/i.test(s)) return { rows: [{ allowed: true }], rowCount: 1 }
    if (/^SELECT id FROM roles WHERE id = \$1 FOR SHARE$/i.test(s)) {
      const roleId = String(params[0])
      return db.roles.has(roleId) ? { rows: [{ id: roleId }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/^SELECT permission_code FROM role_permissions WHERE role_id = \$1$/i.test(s)) {
      const codes = db.roles.get(String(params[0])) ?? []
      return { rows: codes.map((permission_code) => ({ permission_code })), rowCount: codes.length }
    }
    if (/^INSERT INTO user_roles/i.test(s)) {
      const [userIds, roleId] = params as [string[], string]
      const affected = userIds.filter((userId) => {
        const held = rolesOf(userId)
        if (held.has(roleId)) return false
        held.add(roleId)
        return true
      })
      return { rows: affected.map((user_id) => ({ user_id })), rowCount: affected.length }
    }
    if (/^DELETE FROM user_roles/i.test(s)) {
      const [userIds, roleId] = params as [string[], string]
      const affected = userIds.filter((userId) => rolesOf(userId).delete(roleId))
      return { rows: affected.map((user_id) => ({ user_id })), rowCount: affected.length }
    }
    if (/^SELECT user_id, role_id FROM user_roles WHERE user_id = ANY/i.test(s)) {
      const userIds = params[0] as string[]
      const rows = userIds.flatMap((userId) => Array.from(rolesOf(userId)).map((role_id) => ({ user_id: userId, role_id })))
      return { rows, rowCount: rows.length }
    }
    if (/^DELETE FROM delegated_role_admin_(scopes|member_groups)/i.test(s)) {
      const table = /member_groups/i.test(s) ? 'group' : 'dept'
      const [userIds, namespace] = params as [string[], string]
      const removed = db.scopes.filter((scope) => scope.table === table && userIds.includes(scope.adminUserId) && scope.namespace === namespace)
      db.scopes = db.scopes.filter((scope) => !removed.includes(scope))
      return { rows: removed.map((scope) => ({ admin_user_id: scope.adminUserId })), rowCount: removed.length }
    }
    if (/FROM delegated_role_admin_scopes s/i.test(s)) {
      const rows = scopeRowsFor('dept', String(params[0]), params[1] as string[] | undefined).map((scope, index) => ({
        id: `scope-${index}`, admin_user_id: scope.adminUserId, namespace: scope.namespace, directory_department_id: 'dept-1',
        created_by: 'platform-admin', created_at: 'now', updated_at: 'now', integration_id: 'int-1', integration_name: 'Dir',
        provider: 'local', corp_id: null, external_department_id: '1', department_name: 'Dept', department_full_path: 'Dept',
        department_is_active: true,
      }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM delegated_role_admin_member_groups gscope/i.test(s)) {
      const rows = scopeRowsFor('group', String(params[0]), params[1] as string[] | undefined).map((scope, index) => ({
        id: `group-scope-${index}`, admin_user_id: scope.adminUserId, namespace: scope.namespace, group_id: 'group-1',
        created_by: 'platform-admin', created_at: 'now', updated_at: 'now', group_name: 'Group', group_description: null,
        member_count: 1,
      }))
      return { rows, rowCount: rows.length }
    }
    if (/^SELECT role_id FROM user_roles WHERE user_id = \$1/i.test(s)) {
      const rows = Array.from(rolesOf(String(params[0]))).sort().map((role_id) => ({ role_id }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM users WHERE id = \$1/i.test(s)) {
      const user = db.users.get(String(params[0]))
      return user ? { rows: [user], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/^SELECT id FROM roles WHERE id = \$1$/i.test(s)) {
      const roleId = String(params[0])
      return db.roles.has(roleId) ? { rows: [{ id: roleId }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/FROM roles r LEFT JOIN role_permissions rp/i.test(s)) {
      const namespaces = params[0] as string[] | undefined
      const rows = Array.from(db.roles.entries())
        .filter(([id]) => !namespaces || namespaces.some((namespace) => id === namespace || id.startsWith(`${namespace}_`)))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, permissions]) => ({ id, name: id, permissions }))
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  }
  return {
    route,
    query: vi.fn(async (sql: string, params?: unknown[]) => route(sql, params ?? [], 'pool')),
    transaction: vi.fn(async (handler: (client: { query: (sql: string, params?: unknown[]) => unknown }) => unknown) => {
      db.transactions += 1
      return handler({ query: (sql: string, params?: unknown[]) => route(sql, params ?? [], 'tx') })
    }),
  }
})

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))

import { adminUsersRouter } from '../../src/routes/admin-users'
import { deriveDelegatedAdminNamespace } from '../../src/rbac/namespace-admission'
import { assignUserRoles, unassignUserRoles } from '../../src/rbac/role-assignment'

const ROLE_ROUTE = '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)'
const ADMISSION_ROUTE = '/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission'
const ACCESS_ROUTE = '/api/admin/role-delegation/users/:userId/access'
const PLATFORM_UNASSIGN_ROUTE = '/api/admin/users/:userId/roles/unassign'
const PLATFORM_ASSIGN_ROUTE = '/api/admin/users/:userId/roles/assign'

const PLATFORM_ADMIN = 'platform-admin-1'
const TARGET = 'target-user-1'

function profile(id: string) {
  return {
    id, email: `${id}@example.test`, username: null, name: id, mobile: null, employeeNo: null, department: null,
    position: null, hireDate: null, role: 'user', is_active: true, is_admin: false, last_login_at: null,
    created_at: 'now', updated_at: 'now',
  }
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    setHeader() {
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; body: any }
}

async function call(
  method: 'get' | 'post' | 'patch',
  routePath: string,
  options: { actor: string; params?: Record<string, string>; body?: Record<string, unknown> },
) {
  const router = adminUsersRouter() as unknown as Router & {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>
  }
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`route ${method} ${routePath} not found`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const res = mockResponse()
  const req = {
    method: method.toUpperCase(), headers: {}, query: {}, params: options.params ?? {}, body: options.body ?? {},
    user: { id: options.actor, role: 'user', roles: [], perms: [] },
  } as unknown as Request
  await handler(req, res, (error?: unknown) => { if (error) throw error })
  return res
}

function seedDelegate(actorId: string, adminRoleId: string, namespace: string) {
  db.users.set(actorId, profile(actorId))
  db.userRoles.set(actorId, new Set([adminRoleId]))
  db.scopes.push({ adminUserId: actorId, namespace, table: 'group' })
}

const userRoleWrites = () => db.seen.filter((entry) => /(INSERT INTO|DELETE FROM)\s+user_roles/i.test(entry.sql))
const auditCalls = () => auditMocks.auditLog.mock.calls.map(([entry]) => entry as Record<string, any>)

beforeEach(() => {
  db.users = new Map([[TARGET, profile(TARGET)], [PLATFORM_ADMIN, profile(PLATFORM_ADMIN)]])
  db.userRoles = new Map()
  db.roles = new Map([
    ['attendance_admin', ['attendance:admin', 'attendance:read']],
    ['attendance_employee', ['attendance:read', 'attendance:write']],
    // Ends in "admin" but derives NO namespace (`deriveDelegatedAdminNamespace` is
    // case-sensitive and needs the `_admin` suffix): holders are NOT delegated admins.
    ['attendance_ADMIN', ['attendance:read']],
    ['attendance_sysadmin', ['attendance:read']],
    ['attendance_platformish', ['attendance:read', 'users:write']],
    ['stock-prep_admin', ['stock-prep:admin']],
    ['stock-prep_data_admin', ['stock-prep:read']],
    ['stock-prep_frontline', ['stock-prep:read', 'stock-prep:operate']],
    ['adgx_admin', ['adgx:admin']],
    ['adgx_member', ['adgx:read']],
  ])
  db.scopes = []
  db.seen = []
  db.transactions = 0
  auditMocks.auditLog.mockClear()
  pgMocks.query.mockClear()
  pgMocks.transaction.mockClear()
  rbacMocks.isAdmin.mockReset()
  rbacMocks.isAdmin.mockImplementation(async (userId: string) => userId === PLATFORM_ADMIN)
  rbacMocks.listUserPermissions.mockResolvedValue([])
})

describe('R1 — only a platform admin assigns or revokes a namespace main-admin role', () => {
  it.each([
    ['attendance_admin', 'attendance_admin', 'attendance'],
    ['stock-prep_admin', 'stock-prep_admin', 'stock-prep'],
    ['adgx_admin', 'adgx_admin', 'adgx'],
    // Nested: matches the delegate's namespace by prefix, and derives `stock-prep_data`.
    ['stock-prep_admin', 'stock-prep_data_admin', 'stock-prep'],
  ])('a delegate holding %s assigning %s → 403 ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN, nothing written', async (actorRole, roleId, namespace) => {
    seedDelegate('delegate-1', actorRole, namespace)
    expect(deriveDelegatedAdminNamespace(roleId)).not.toBeNull()

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId } })

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN', message: 'Only a platform administrator can assign or revoke a namespace admin role' },
    })
    expect(userRoleWrites()).toEqual([])
    expect(db.userRoles.get(TARGET)?.has(roleId) ?? false).toBe(false)
  })

  it('a delegate cannot demote a peer main admin either (unassign → 403, the role stays)', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.userRoles.set(TARGET, new Set(['attendance_admin']))

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'attendance_admin' } })

    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN')
    expect(userRoleWrites()).toEqual([])
    expect(db.userRoles.get(TARGET)?.has('attendance_admin')).toBe(true)
  })

  it('POSITIVE CONTROL — a platform admin assigns stock-prep_admin through the same route', async () => {
    const res = await call('post', ROLE_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET, action: 'assign' }, body: { roleId: 'stock-prep_admin' } })

    expect(res.statusCode).toBe(200)
    expect(db.userRoles.get(TARGET)?.has('stock-prep_admin')).toBe(true)
  })

  it('PREDICATE IDENTITY — ids that end in "admin" but derive no namespace are NOT refused (the refusal set is the identity set)', async () => {
    // A suffix/case-insensitive string check would refuse these; the shipped identity predicate
    // says their holders are not delegated admins, so the refusal must say the same.
    expect(deriveDelegatedAdminNamespace('attendance_ADMIN')).toBeNull()
    expect(deriveDelegatedAdminNamespace('attendance_sysadmin')).toBeNull()
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')

    for (const roleId of ['attendance_ADMIN', 'attendance_sysadmin']) {
      const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId } })
      expect({ roleId, status: res.statusCode }).toEqual({ roleId, status: 200 })
    }
  })
})

describe('R2 — a delegate cannot assign a role carrying codes outside its namespace', () => {
  it.each([
    ['users:write'],
    ['multitable:write'],
    ['approvals:read'],
    ['roles:write'],
    ['integration:admin'],
    ['workflow:write'],
    ['*:*'],
    ['stock-prep:read'],
  ])('attendance delegate, role carrying attendance:read + %s → 403 ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN', async (foreignCode) => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.roles.set('attendance_probe', ['attendance:read', foreignCode])

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_probe' } })

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN',
        message: 'Only a platform administrator can assign or revoke a role that carries permissions outside your delegated namespace',
      },
    })
    // Values-free: neither the role id nor the offending code reaches the body.
    expect(JSON.stringify(res.body)).not.toContain('attendance_probe')
    expect(JSON.stringify(res.body)).not.toContain(foreignCode)
    expect(userRoleWrites()).toEqual([])
  })

  it('POSITIVE CONTROL — only in-namespace codes → 200 and the membership is written', async () => {
    seedDelegate('delegate-1', 'stock-prep_admin', 'stock-prep')

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'stock-prep_frontline' } })

    expect(res.statusCode).toBe(200)
    expect(db.userRoles.get(TARGET)?.has('stock-prep_frontline')).toBe(true)
  })

  it('the codes are read INSIDE the write transaction, after the role row is held FOR SHARE', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_employee' } })

    expect(res.statusCode).toBe(200)
    const lockAt = db.seen.findIndex((entry) => /FROM roles WHERE id = \$1 FOR SHARE/i.test(entry.sql))
    const codesAt = db.seen.findIndex((entry) => /^SELECT permission_code FROM role_permissions/i.test(entry.sql.trim()))
    const writeAt = db.seen.findIndex((entry) => /INSERT INTO user_roles/i.test(entry.sql))
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(codesAt).toBeGreaterThan(lockAt)
    expect(writeAt).toBeGreaterThan(codesAt)
    expect([db.seen[lockAt].via, db.seen[codesAt].via, db.seen[writeAt].via]).toEqual(['tx', 'tx', 'tx'])
    expect(db.transactions).toBe(1)
  })

  it('a role that vanished before the lock answers 404, writes nothing, audits no policy refusal', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    const original = pgMocks.transaction.getMockImplementation()
    pgMocks.transaction.mockImplementationOnce(async (handler) => {
      db.roles.delete('attendance_employee')
      return original!(handler)
    })

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_employee' } })

    expect(res.statusCode).toBe(404)
    expect(res.body.error.code).toBe('ROLE_NOT_FOUND')
    expect(userRoleWrites()).toEqual([])
    expect(auditCalls().filter((entry) => /_denied$/.test(entry.action))).toEqual([])
  })
})

describe('R4 — every refusal is audited in the delegation audit shape', () => {
  it('main-admin refusal → user-role grant_denied with the refusal code', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')

    await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_admin' } })

    expect(auditCalls()).toEqual([
      expect.objectContaining({
        actorId: 'delegate-1',
        actorType: 'user',
        action: 'grant_denied',
        resourceType: 'user-role',
        resourceId: `${TARGET}:attendance_admin`,
        meta: expect.objectContaining({
          adminUserId: 'delegate-1',
          userId: TARGET,
          roleId: 'attendance_admin',
          delegated: true,
          delegableNamespaces: ['attendance'],
          refusalCode: 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN',
        }),
      }),
    ])
  })

  it('platform-code refusal → user-role grant_denied with an offending COUNT, never the codes', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')

    await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_platformish' } })

    const denied = auditCalls().filter((entry) => entry.action === 'grant_denied')
    expect(denied).toHaveLength(1)
    expect(denied[0].meta).toMatchObject({ refusalCode: 'ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN', offendingCount: 1 })
    expect(JSON.stringify(denied[0])).not.toContain('users:write')
  })

  it('a revoke refusal is audited as revoke_denied', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.userRoles.set(TARGET, new Set(['attendance_admin']))

    await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'attendance_admin' } })

    expect(auditCalls().map((entry) => entry.action)).toEqual(['revoke_denied'])
  })
})

describe('R5 — the delegate is never offered what the route refuses', () => {
  it('access: roleCatalog and delegableRoles drop main-admin and platform-coded roles, keep the rest', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.userRoles.set(TARGET, new Set(['attendance_admin', 'attendance_employee', 'attendance_platformish']))

    const res = await call('get', ACCESS_ROUTE, { actor: 'delegate-1', params: { userId: TARGET } })

    expect(res.statusCode).toBe(200)
    expect(res.body.data.roleCatalog.map((role: { id: string }) => role.id)).toEqual([
      'attendance_ADMIN',
      'attendance_employee',
      'attendance_sysadmin',
    ])
    expect(res.body.data.delegableRoles).toEqual(['attendance_employee'])
  })

  it('POSITIVE CONTROL — a platform admin still sees the whole catalog, main-admin roles included', async () => {
    const res = await call('get', ACCESS_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET } })

    expect(res.statusCode).toBe(200)
    expect(res.body.data.roleCatalog.map((role: { id: string }) => role.id)).toEqual(
      expect.arrayContaining(['attendance_admin', 'stock-prep_admin', 'adgx_admin', 'attendance_platformish']),
    )
  })
})

describe('R3 — the delegated audience follows the main-admin role', () => {
  it('platform revoke via the delegation route clears BOTH audience tables for that namespace, in the transaction, and audits it', async () => {
    db.userRoles.set(TARGET, new Set(['stock-prep_admin', 'attendance_admin']))
    db.scopes.push(
      { adminUserId: TARGET, namespace: 'stock-prep', table: 'dept' },
      { adminUserId: TARGET, namespace: 'stock-prep', table: 'group' },
      { adminUserId: TARGET, namespace: 'stock-prep', table: 'group' },
      { adminUserId: TARGET, namespace: 'attendance', table: 'group' },
    )

    const res = await call('post', ROLE_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'stock-prep_admin' } })

    expect(res.statusCode).toBe(200)
    // Only the revoked namespace's audience goes; the other main-admin role keeps its own.
    expect(db.scopes).toEqual([{ adminUserId: TARGET, namespace: 'attendance', table: 'group' }])
    const cleanup = db.seen.filter((entry) => /DELETE FROM delegated_role_admin_/i.test(entry.sql))
    expect(cleanup.map((entry) => entry.via)).toEqual(['tx', 'tx'])
    expect(auditCalls()).toContainEqual(expect.objectContaining({
      actorId: PLATFORM_ADMIN,
      action: 'revoke',
      resourceType: 'delegated-admin-scope',
      resourceId: `${TARGET}:stock-prep`,
      meta: expect.objectContaining({ namespace: 'stock-prep', trigger: 'role_unassigned', scopeRows: 1, groupScopeRows: 2 }),
    }))
  })

  it('platform revoke via /api/admin/users/:userId/roles/unassign clears it too, in a transaction', async () => {
    db.userRoles.set(TARGET, new Set(['attendance_admin']))
    db.scopes.push({ adminUserId: TARGET, namespace: 'attendance', table: 'dept' })

    const res = await call('post', PLATFORM_UNASSIGN_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET }, body: { roleId: 'attendance_admin' } })

    expect(res.statusCode).toBe(200)
    expect(db.scopes).toEqual([])
    expect(db.seen.filter((entry) => /DELETE FROM (user_roles|delegated_role_admin_)/i.test(entry.sql)).map((entry) => entry.via))
      .toEqual(['tx', 'tx', 'tx'])
  })

  it('G7 — revoke then re-appoint (platform routes) starts the user with ZERO audience', async () => {
    db.userRoles.set(TARGET, new Set(['stock-prep_admin']))
    db.scopes.push({ adminUserId: TARGET, namespace: 'stock-prep', table: 'group' })

    await call('post', ROLE_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'stock-prep_admin' } })
    const res = await call('post', PLATFORM_ASSIGN_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET }, body: { roleId: 'stock-prep_admin' } })

    expect(res.statusCode).toBe(200)
    expect(db.userRoles.get(TARGET)?.has('stock-prep_admin')).toBe(true)
    expect(db.scopes).toEqual([])
    // ...so the re-appointed admin has no audience until a platform admin configures one.
    const access = await call('get', ACCESS_ROUTE, { actor: TARGET, params: { userId: 'someone' } })
    expect(access.statusCode).toBe(403)
    expect(access.body.error.code).toBe('ROLE_DELEGATION_SCOPE_REQUIRED')
  })

  it('a fresh appointment drops audience left over from before this fix (orphan rows), and audits it', async () => {
    // A row that outlived an earlier revocation: no main-admin role, audience still present.
    db.scopes.push({ adminUserId: TARGET, namespace: 'attendance', table: 'dept' })

    const res = await call('post', PLATFORM_ASSIGN_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET }, body: { roleId: 'attendance_admin' } })

    expect(res.statusCode).toBe(200)
    expect(db.scopes).toEqual([])
    expect(auditCalls()).toContainEqual(expect.objectContaining({
      resourceType: 'delegated-admin-scope',
      meta: expect.objectContaining({ trigger: 'role_appointed', scopeRows: 1, groupScopeRows: 0 }),
    }))
  })
})

describe('R3 at the writer — role-assignment.ts', () => {
  function executor() {
    const seen: string[] = []
    return {
      seen,
      query: async (sql: string, params?: unknown[]) => {
        seen.push(sql)
        return pgMocks.route(sql, params ?? [], 'tx') as Promise<{ rows: unknown[]; rowCount: number }>
      },
    }
  }

  it('revoking a non-admin role issues no audience statement at all', async () => {
    db.userRoles.set(TARGET, new Set(['attendance_employee']))
    db.scopes.push({ adminUserId: TARGET, namespace: 'attendance', table: 'dept' })
    const exec = executor()

    const result = await unassignUserRoles({ userIds: [TARGET], roleId: 'attendance_employee', scope: { kind: 'platform-admin' }, executor: exec })

    expect(result.delegatedAdminScopeCleanup).toEqual([])
    expect(exec.seen.filter((sql) => /delegated_role_admin_/i.test(sql))).toEqual([])
    expect(db.scopes).toHaveLength(1)
  })

  it('POSITIVE CONTROL — another held role still deriving the namespace keeps the audience', async () => {
    // `attendance _admin` (inner space) derives `attendance` too: the user is still its admin.
    expect(deriveDelegatedAdminNamespace('attendance _admin')).toBe('attendance')
    db.userRoles.set(TARGET, new Set(['attendance_admin', 'attendance _admin']))
    db.scopes.push({ adminUserId: TARGET, namespace: 'attendance', table: 'group' })
    const exec = executor()

    const result = await unassignUserRoles({ userIds: [TARGET], roleId: 'attendance_admin', scope: { kind: 'platform-admin' }, executor: exec })

    expect(result.affectedUserIds).toEqual([TARGET])
    expect(result.delegatedAdminScopeCleanup).toEqual([])
    expect(db.scopes).toHaveLength(1)
  })

  it('re-sending an appointment the user already holds clears nothing', async () => {
    db.userRoles.set(TARGET, new Set(['attendance_admin']))
    db.scopes.push({ adminUserId: TARGET, namespace: 'attendance', table: 'dept' })
    const exec = executor()

    const result = await assignUserRoles({ userIds: [TARGET], roleId: 'attendance_admin', scope: { kind: 'platform-admin' }, executor: exec })

    expect(result.affectedUserIds).toEqual([])
    expect(db.scopes).toHaveLength(1)
  })

  it('all statements run on the executor the caller passed', async () => {
    db.userRoles.set(TARGET, new Set(['adgx_admin']))
    db.scopes.push({ adminUserId: TARGET, namespace: 'adgx', table: 'dept' }, { adminUserId: TARGET, namespace: 'adgx', table: 'group' })
    const exec = executor()
    db.seen = []

    const result = await unassignUserRoles({ userIds: [TARGET], roleId: 'adgx_admin', scope: { kind: 'platform-admin' }, executor: exec })

    expect(result.delegatedAdminScopeCleanup).toEqual([{ userId: TARGET, namespace: 'adgx', scopeRows: 1, groupScopeRows: 1 }])
    expect(db.seen.every((entry) => entry.via === 'tx')).toBe(true)
    expect(pgMocks.query).not.toHaveBeenCalledWith(expect.stringMatching(/delegated_role_admin_/), expect.anything())
  })
})

describe('R6 — gate order: an empty body answers 400 before any new refusal (delegated attendance_admin)', () => {
  it('role route: empty body → 400 ROLE_REQUIRED, not 401/403, nothing audited, no transaction', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')

    for (const action of ['assign', 'unassign']) {
      const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action }, body: {} })
      expect({ action, status: res.statusCode, code: res.body?.error?.code }).toEqual({ action, status: 400, code: 'ROLE_REQUIRED' })
    }
    expect(auditCalls()).toEqual([])
    expect(db.transactions).toBe(0)
  })

  it('admission PATCH: empty body → 400 ENABLED_REQUIRED, not 401/403', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')

    const res = await call('patch', ADMISSION_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, namespace: 'attendance' }, body: {} })

    expect(res.statusCode).toBe(400)
    expect(res.body.error.code).toBe('ENABLED_REQUIRED')
  })
})
