/**
 * Owner ruling 2026-10-10 「只有平台管理员能任命 *_admin」, for EVERY namespace.
 *
 *  R1. A delegated (non-platform) admin may neither assign nor revoke a role whose id derives a
 *      delegated-admin namespace (`deriveDelegatedAdminNamespace`, the predicate that GRANTS
 *      delegated-admin identity) — `attendance_admin`, `stock-prep_admin`, any `x_admin`, and a
 *      nested `stock-prep_data_admin`. Platform admins are unaffected.
 *  R2. A delegated admin may not assign a role that carries a permission code outside the
 *      namespace it reaches the role through (platform codes). It MAY revoke one (removing a role
 *      only lowers privilege) unless an out-of-namespace code is admin-level (`*:*`, `admin:*`,
 *      `<other>:admin`). The codes are read INSIDE the write transaction, after the role row is
 *      held FOR SHARE.
 *  R7. Admin power via CODES: a role carrying an admin-level code of its own namespace
 *      (`<ns>:admin`, `<ns>:*`) is admin-equivalent — refused to delegates both ways, and absent
 *      from the delegate's catalogs.
 *  R8. The write boundary (`rbac/role-assignment.ts`, delegated `namespaces` scope) refuses all
 *      of the above by itself, so a route that reuses the scope inherits the ruling.
 *  R9. The post-commit cleanup audit is best-effort: its failure never changes the response.
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
      // The namespace predicate is honoured only when the statement carries it, so a cleanup
      // that dropped `AND namespace = $2` would clear every namespace here as it would in PG.
      const filtersNamespace = /\bAND namespace = \$2\b/i.test(s)
      const removed = db.scopes.filter((scope) => scope.table === table && userIds.includes(scope.adminUserId)
        && (!filtersNamespace || scope.namespace === namespace))
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
import {
  assignUserRoles,
  auditDelegatedAdminScopeCleanup,
  isAdminLevelPermissionCode,
  RoleAssignmentForbiddenError,
  unassignUserRoles,
  type RoleAssignmentScope,
} from '../../src/rbac/role-assignment'
import { Logger } from '../../src/core/logger'

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

  it('revoking a role that carries only ordinary platform codes is ALLOWED (removing a role only lowers privilege); the row goes', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.userRoles.set(TARGET, new Set(['attendance_platformish']))

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'attendance_platformish' } })

    expect(res.statusCode).toBe(200)
    expect(db.userRoles.get(TARGET)?.has('attendance_platformish')).toBe(false)
    expect(auditCalls().filter((entry) => /_denied$/.test(entry.action))).toEqual([])
    expect(auditCalls()).toContainEqual(expect.objectContaining({ action: 'revoke', resourceType: 'user-role', resourceId: `${TARGET}:attendance_platformish` }))
  })

  it.each([
    ['*:*'],
    ['admin:all'],
    ['integration:admin'],
    ['multitable:*'],
  ])('revoking a role carrying the ADMIN-LEVEL platform code %s stays refused (it would demote an administrator); the row stays', async (adminLevelCode) => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.roles.set('attendance_superish', ['attendance:read', adminLevelCode])
    db.userRoles.set(TARGET, new Set(['attendance_superish']))

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'attendance_superish' } })

    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN')
    expect(JSON.stringify(res.body)).not.toContain(adminLevelCode)
    expect(userRoleWrites()).toEqual([])
    expect(db.userRoles.get(TARGET)?.has('attendance_superish')).toBe(true)
    expect(auditCalls().filter((entry) => entry.action === 'revoke_denied').map((entry) => entry.meta))
      .toEqual([expect.objectContaining({ refusalCode: 'ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN', offendingCount: 1 })])
  })

  it('V4 — codes are judged against the namespace the role id matched, not every namespace the delegate holds', async () => {
    // A delegate of BOTH attendance and stock-prep: an `attendance_*` role carrying a
    // `stock-prep:*` code is still a cross-namespace grant for that role.
    db.users.set('delegate-2ns', profile('delegate-2ns'))
    db.userRoles.set('delegate-2ns', new Set(['attendance_admin', 'stock-prep_admin']))
    db.scopes.push(
      { adminUserId: 'delegate-2ns', namespace: 'attendance', table: 'group' },
      { adminUserId: 'delegate-2ns', namespace: 'stock-prep', table: 'group' },
    )
    db.roles.set('attendance_crossns', ['attendance:read', 'stock-prep:read'])

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-2ns', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_crossns' } })

    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN')
    expect(userRoleWrites()).toEqual([])
    // ...and it is not offered in that delegate's assignable catalog either.
    const access = await call('get', ACCESS_ROUTE, { actor: 'delegate-2ns', params: { userId: TARGET } })
    expect(access.body.data.roleCatalog.map((role: { id: string }) => role.id)).not.toContain('attendance_crossns')
    // POSITIVE CONTROL — the same delegate assigns each namespace's own role.
    for (const roleId of ['attendance_employee', 'stock-prep_frontline']) {
      const ok = await call('post', ROLE_ROUTE, { actor: 'delegate-2ns', params: { userId: TARGET, action: 'assign' }, body: { roleId } })
      expect({ roleId, status: ok.statusCode }).toEqual({ roleId, status: 200 })
    }
  })

  it('KNOWN CONSEQUENCE (e-learning): role ids `plugin_elearning_*` carry `elearning:*` codes, a different namespace, so its delegate cannot ASSIGN them but CAN revoke them', async () => {
    // The e-learning templates deliberately use role namespace `plugin_elearning` and code
    // namespace `elearning` (zzzz20260826140000_add_elearning_role_templates.ts; ADR §11.2-2).
    // Under the strict rule those codes are outside the delegate's namespace. Pinned so the
    // outcome is visible; an alias between the two would be a separate owner decision.
    db.roles.set('plugin_elearning_admin', ['elearning:admin', 'elearning:read'])
    db.roles.set('plugin_elearning_operator', ['elearning:grade', 'elearning:read', 'elearning:stats', 'elearning:write'])
    db.roles.set('plugin_elearning_viewer', ['elearning:read'])
    seedDelegate('delegate-el', 'plugin_elearning_admin', 'plugin_elearning')

    for (const roleId of ['plugin_elearning_viewer', 'plugin_elearning_operator']) {
      const assign = await call('post', ROLE_ROUTE, { actor: 'delegate-el', params: { userId: TARGET, action: 'assign' }, body: { roleId } })
      expect({ roleId, status: assign.statusCode, code: assign.body?.error?.code })
        .toEqual({ roleId, status: 403, code: 'ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN' })

      // A grant made earlier (by a platform admin, or before this ruling) can be revoked.
      db.userRoles.set(TARGET, new Set([roleId]))
      const revoke = await call('post', ROLE_ROUTE, { actor: 'delegate-el', params: { userId: TARGET, action: 'unassign' }, body: { roleId } })
      expect({ roleId, status: revoke.statusCode }).toEqual({ roleId, status: 200 })
      expect(db.userRoles.get(TARGET)?.has(roleId)).toBe(false)
    }
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
  it('access: roleCatalog (assignable) drops main-admin, admin-equivalent and platform-coded roles; delegableRoles (revocable) keeps ordinary platform-coded ones', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.roles.set('attendance_lead', ['attendance:read', 'attendance:admin'])
    db.roles.set('attendance_wild', ['attendance:*'])
    db.roles.set('attendance_superish', ['attendance:read', '*:*'])
    db.userRoles.set(TARGET, new Set([
      'attendance_admin', 'attendance_employee', 'attendance_platformish',
      'attendance_lead', 'attendance_wild', 'attendance_superish',
    ]))

    const res = await call('get', ACCESS_ROUTE, { actor: 'delegate-1', params: { userId: TARGET } })

    expect(res.statusCode).toBe(200)
    expect(res.body.data.roleCatalog.map((role: { id: string }) => role.id)).toEqual([
      'attendance_ADMIN',
      'attendance_employee',
      'attendance_sysadmin',
    ])
    expect(res.body.data.delegableRoles).toEqual(['attendance_employee', 'attendance_platformish'])
  })

  it('the assign route\'s answer agrees with the access response, role by role and direction by direction', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.roles.set('attendance_lead', ['attendance:read', 'attendance:admin'])
    db.roles.set('attendance_superish', ['attendance:read', '*:*'])
    const candidates = ['attendance_admin', 'attendance_employee', 'attendance_platformish', 'attendance_lead', 'attendance_superish', 'attendance_ADMIN']
    db.userRoles.set(TARGET, new Set(candidates))
    const access = await call('get', ACCESS_ROUTE, { actor: 'delegate-1', params: { userId: TARGET } })
    const assignable = new Set(access.body.data.roleCatalog.map((role: { id: string }) => role.id))
    const revocable = new Set(access.body.data.delegableRoles)

    for (const roleId of candidates) {
      db.userRoles.set(TARGET, new Set())
      const assign = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId } })
      expect({ roleId, assignOk: assign.statusCode === 200 }).toEqual({ roleId, assignOk: assignable.has(roleId) })
      db.userRoles.set(TARGET, new Set([roleId]))
      const revoke = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'unassign' }, body: { roleId } })
      expect({ roleId, revokeOk: revoke.statusCode === 200 }).toEqual({ roleId, revokeOk: revocable.has(roleId) })
    }
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

  it('V5 — a batch appointment clears audience only for users it NEWLY appointed; a sitting admin keeps the audience it was given', async () => {
    const SITTING = 'sitting-admin'
    const FRESH = 'fresh-admin'
    db.userRoles.set(SITTING, new Set(['attendance_admin']))
    db.scopes.push(
      { adminUserId: SITTING, namespace: 'attendance', table: 'dept' },
      { adminUserId: SITTING, namespace: 'attendance', table: 'group' },
      // FRESH has no main-admin role: these rows are an orphan from an earlier tenure.
      { adminUserId: FRESH, namespace: 'attendance', table: 'group' },
    )
    const exec = executor()

    const result = await assignUserRoles({ userIds: [SITTING, FRESH], roleId: 'attendance_admin', scope: { kind: 'platform-admin' }, executor: exec })

    expect(result.affectedUserIds).toEqual([FRESH])
    expect(result.delegatedAdminScopeCleanup).toEqual([{ userId: FRESH, namespace: 'attendance', scopeRows: 0, groupScopeRows: 1 }])
    expect(db.scopes).toEqual([
      { adminUserId: SITTING, namespace: 'attendance', table: 'dept' },
      { adminUserId: SITTING, namespace: 'attendance', table: 'group' },
    ])
  })

  it('V12 — the cleanup removes only the revoked namespace\'s audience; the user\'s audience in another namespace stays', async () => {
    // The user stays a delegated admin of stock-prep: that audience is not this revocation's.
    db.userRoles.set(TARGET, new Set(['attendance_admin', 'stock-prep_admin']))
    db.scopes.push(
      { adminUserId: TARGET, namespace: 'attendance', table: 'dept' },
      { adminUserId: TARGET, namespace: 'attendance', table: 'group' },
      { adminUserId: TARGET, namespace: 'stock-prep', table: 'dept' },
      { adminUserId: TARGET, namespace: 'stock-prep', table: 'group' },
    )
    const exec = executor()

    const result = await unassignUserRoles({ userIds: [TARGET], roleId: 'attendance_admin', scope: { kind: 'platform-admin' }, executor: exec })

    expect(result.delegatedAdminScopeCleanup).toEqual([{ userId: TARGET, namespace: 'attendance', scopeRows: 1, groupScopeRows: 1 }])
    expect(db.scopes).toEqual([
      { adminUserId: TARGET, namespace: 'stock-prep', table: 'dept' },
      { adminUserId: TARGET, namespace: 'stock-prep', table: 'group' },
    ])
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

describe('R7 — admin power via codes: a role carrying an admin-level code of its namespace is admin-equivalent', () => {
  it('the admin-level predicate follows the access matchers (`<r>:admin`, `<r>:*`, `*:*`, `admin:*`), and nothing else', () => {
    for (const code of ['attendance:admin', 'attendance:*', 'stock-prep:admin', ' elearning:admin ', '*:*', '*:read', 'admin:all', 'admin:read', 'multitable:*']) {
      expect({ code, adminLevel: isAdminLevelPermissionCode(code) }).toEqual({ code, adminLevel: true })
    }
    // Domain actions are not wildcards in any access matcher (`manage` is approval-templates',
    // `all` is a wildcard only in the demo metrics middleware).
    for (const code of ['attendance:read', 'attendance:approve', 'attendance:manage', 'attendance:all', 'stock-prep:pull', 'attendance', 'attendance:', ':admin', '', 'attendance:administer', 'attendance:Admin']) {
      expect({ code, adminLevel: isAdminLevelPermissionCode(code) }).toEqual({ code, adminLevel: false })
    }
  })

  it.each([
    ['attendance_admin', 'attendance', 'attendance_lead', ['attendance:read', 'attendance:admin']],
    ['attendance_admin', 'attendance', 'attendance_wild', ['attendance:*']],
    ['stock-prep_admin', 'stock-prep', 'stock-prep_lead', ['stock-prep:read', 'stock-prep:admin']],
  ])('a delegate holding %s cannot assign or revoke %s-admin-equivalent %s → 403 ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN, audited, nothing written', async (actorRole, namespace, roleId, codes) => {
    seedDelegate('delegate-1', actorRole, namespace)
    db.roles.set(roleId, codes)
    expect(deriveDelegatedAdminNamespace(roleId)).toBeNull() // not a main-admin id: refused by its codes alone

    const assign = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId } })
    expect(assign.statusCode).toBe(403)
    expect(assign.body).toEqual({
      ok: false,
      error: { code: 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN', message: 'Only a platform administrator can assign or revoke a namespace admin role' },
    })
    expect(db.userRoles.get(TARGET)?.has(roleId) ?? false).toBe(false)

    db.userRoles.set(TARGET, new Set([roleId]))
    const revoke = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'unassign' }, body: { roleId } })
    expect(revoke.statusCode).toBe(403)
    expect(revoke.body.error.code).toBe('ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN')
    expect(db.userRoles.get(TARGET)?.has(roleId)).toBe(true)

    expect(userRoleWrites()).toEqual([])
    expect(auditCalls().filter((entry) => /_denied$/.test(entry.action)).map((entry) => [entry.action, entry.meta.refusalCode, entry.meta.offendingCount]))
      .toEqual([
        ['grant_denied', 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN', 1],
        ['revoke_denied', 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN', 1],
      ])
  })

  it('the admin-equivalent check reads the codes inside the write transaction under the role-row lock (an editor adding `<ns>:admin` is seen)', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.roles.set('attendance_promoted', ['attendance:read'])
    // The editor's commit lands after the route's pre-transaction reads and before the lock.
    const original = pgMocks.transaction.getMockImplementation()
    pgMocks.transaction.mockImplementationOnce(async (handler) => {
      db.roles.set('attendance_promoted', ['attendance:read', 'attendance:admin'])
      return original!(handler)
    })

    const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_promoted' } })

    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN')
    expect(userRoleWrites()).toEqual([])
  })

  it('POSITIVE CONTROL — domain actions are not admin-level: a role with approve/import/manage is delegable both ways', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.roles.set('attendance_domain', ['attendance:approve', 'attendance:import', 'attendance:manage'])

    const assign = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_domain' } })
    const revoke = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'attendance_domain' } })

    expect([assign.statusCode, revoke.statusCode]).toEqual([200, 200])
  })

  it('a platform admin still assigns and revokes an admin-equivalent role', async () => {
    db.roles.set('attendance_lead', ['attendance:read', 'attendance:admin'])
    const assign = await call('post', ROLE_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET, action: 'assign' }, body: { roleId: 'attendance_lead' } })
    const revoke = await call('post', ROLE_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET, action: 'unassign' }, body: { roleId: 'attendance_lead' } })
    expect([assign.statusCode, revoke.statusCode]).toEqual([200, 200])
  })
})

describe('R8 — the write boundary refuses by itself under the delegated `namespaces` scope', () => {
  const delegated: RoleAssignmentScope = { kind: 'namespaces', namespaces: ['attendance'] }
  function executor() {
    const seen: string[] = []
    return {
      seen,
      query: async (sql: string, params?: unknown[]) => {
        seen.push(sql.replace(/\s+/g, ' ').trim())
        return pgMocks.route(sql, params ?? [], 'tx') as Promise<{ rows: unknown[]; rowCount: number }>
      },
    }
  }
  async function refusalOf(write: Promise<unknown>): Promise<string | null> {
    try {
      await write
      return null
    } catch (error) {
      expect(error).toBeInstanceOf(RoleAssignmentForbiddenError)
      return (error as RoleAssignmentForbiddenError).reason
    }
  }
  const writes = (seen: string[]) => seen.filter((sql) => /^(INSERT INTO|DELETE FROM) user_roles/i.test(sql))

  it('a main-admin role id is refused in both directions before any statement', async () => {
    for (const roleId of ['attendance_admin', 'attendance_data_admin']) {
      const exec = executor()
      expect(await refusalOf(assignUserRoles({ userIds: [TARGET], roleId, scope: delegated, executor: exec }))).toBe('main_admin_role')
      expect(await refusalOf(unassignUserRoles({ userIds: [TARGET], roleId, scope: delegated, executor: exec }))).toBe('main_admin_role')
      expect(exec.seen).toEqual([])
    }
  })

  it('an admin-equivalent role is refused in both directions, after the lock and code read, with no membership write', async () => {
    db.roles.set('attendance_lead', ['attendance:read', 'attendance:admin'])
    db.roles.set('attendance_wild', ['attendance:*'])
    for (const roleId of ['attendance_lead', 'attendance_wild']) {
      db.userRoles.set(TARGET, new Set([roleId]))
      const exec = executor()
      expect(await refusalOf(assignUserRoles({ userIds: ['someone-else'], roleId, scope: delegated, executor: exec }))).toBe('admin_equivalent_role')
      expect(await refusalOf(unassignUserRoles({ userIds: [TARGET], roleId, scope: delegated, executor: exec }))).toBe('admin_equivalent_role')
      expect(writes(exec.seen)).toEqual([])
      expect(exec.seen.slice(0, 2)).toEqual([
        'SELECT id FROM roles WHERE id = $1 FOR SHARE',
        'SELECT permission_code FROM role_permissions WHERE role_id = $1',
      ])
      expect(db.userRoles.get(TARGET)?.has(roleId)).toBe(true)
    }
  })

  it('a role carrying codes outside the namespace: assign refused; unassign allowed unless a code is admin-level', async () => {
    const exec = executor()
    expect(await refusalOf(assignUserRoles({ userIds: [TARGET], roleId: 'attendance_platformish', scope: delegated, executor: exec }))).toBe('platform_permission')
    expect(writes(exec.seen)).toEqual([])

    db.userRoles.set(TARGET, new Set(['attendance_platformish']))
    expect(await refusalOf(unassignUserRoles({ userIds: [TARGET], roleId: 'attendance_platformish', scope: delegated, executor: exec }))).toBeNull()
    expect(db.userRoles.get(TARGET)?.has('attendance_platformish')).toBe(false)

    db.roles.set('attendance_superish', ['attendance:read', '*:*'])
    db.userRoles.set(TARGET, new Set(['attendance_superish']))
    expect(await refusalOf(unassignUserRoles({ userIds: [TARGET], roleId: 'attendance_superish', scope: delegated, executor: exec }))).toBe('platform_permission')
    expect(db.userRoles.get(TARGET)?.has('attendance_superish')).toBe(true)
  })

  it('a role with no row to lock is refused (fail-closed), no membership write', async () => {
    const exec = executor()
    expect(await refusalOf(assignUserRoles({ userIds: [TARGET], roleId: 'attendance_ghost', scope: delegated, executor: exec }))).toBe('role_missing')
    expect(writes(exec.seen)).toEqual([])
  })

  it('POSITIVE CONTROL — an in-namespace ordinary role is written under the delegated scope, after the lock and code read', async () => {
    const exec = executor()
    const result = await assignUserRoles({ userIds: [TARGET], roleId: 'attendance_employee', scope: delegated, executor: exec })
    expect(result.affectedUserIds).toEqual([TARGET])
    expect(exec.seen.map((sql) => sql.split(' ').slice(0, 3).join(' '))).toEqual(['SELECT id FROM', 'SELECT permission_code FROM', 'INSERT INTO user_roles'])
  })

  it('POSITIVE CONTROL — the platform arms skip the code review: a platform admin through the attendance router appoints attendance_admin', async () => {
    const exec = executor()
    const result = await assignUserRoles({ userIds: [TARGET], roleId: 'attendance_admin', scope: { kind: 'platform-admin-in-namespaces', namespaces: ['attendance'] }, executor: exec })
    expect(result.affectedUserIds).toEqual([TARGET])
    expect(exec.seen.filter((sql) => /role_permissions|FOR SHARE/i.test(sql))).toEqual([])
  })

  it('the delegation route\'s own typed refusals stay in front of the boundary (it is the backstop, not the answer)', async () => {
    seedDelegate('delegate-1', 'attendance_admin', 'attendance')
    db.roles.set('attendance_lead', ['attendance:read', 'attendance:admin'])
    for (const [roleId, code] of [
      ['attendance_admin', 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN'],
      ['attendance_lead', 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN'],
      ['attendance_platformish', 'ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN'],
    ]) {
      const res = await call('post', ROLE_ROUTE, { actor: 'delegate-1', params: { userId: TARGET, action: 'assign' }, body: { roleId } })
      expect({ roleId, status: res.statusCode, code: res.body?.error?.code }).toEqual({ roleId, status: 403, code })
    }
  })
})

describe('R9 — the post-commit cleanup audit is best-effort', () => {
  it('an audit failure after commit leaves the committed 200 response intact and logs a code only', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn')
    auditMocks.auditLog.mockImplementation(async (entry: Record<string, any>) => {
      if (entry?.resourceType === 'delegated-admin-scope') throw Object.assign(new Error('audit sentinel adgf-leak'), { code: 'EAUDITDOWN' })
    })
    try {
      db.userRoles.set(TARGET, new Set(['attendance_admin']))
      db.scopes.push({ adminUserId: TARGET, namespace: 'attendance', table: 'dept' })

      const res = await call('post', PLATFORM_UNASSIGN_ROUTE, { actor: PLATFORM_ADMIN, params: { userId: TARGET }, body: { roleId: 'attendance_admin' } })

      expect(res.statusCode).toBe(200)
      expect(JSON.stringify(res.body)).not.toContain('adgf-leak')
      expect(db.userRoles.get(TARGET)?.has('attendance_admin')).toBe(false)
      expect(db.scopes).toEqual([])
      const logged = warn.mock.calls.map((args) => JSON.stringify(args))
      expect(logged.some((line) => line.includes('error_code=EAUDITDOWN'))).toBe(true)
      expect(logged.some((line) => line.includes('adgf-leak'))).toBe(false)

      // The helper itself never rejects, whatever the failure carries.
      await expect(auditDelegatedAdminScopeCleanup({
        actorId: PLATFORM_ADMIN,
        roleId: 'attendance_admin',
        trigger: 'role_unassigned',
        cleanup: [{ userId: TARGET, namespace: 'attendance', scopeRows: 1, groupScopeRows: 0 }],
      })).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
      auditMocks.auditLog.mockImplementation(async () => undefined)
    }
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
