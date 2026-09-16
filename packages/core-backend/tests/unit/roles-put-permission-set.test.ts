/**
 * PUT /api/roles/:id — the permission set is actually persisted.
 *
 * The defect these legs pin: the handler used to read only `req.body.name`, never
 * reference `req.body.permissions`, never touch `role_permissions`, and still answer
 * `{ ok: true }`. The role editor therefore reported a successful grant while nothing
 * was written, and the documented remedy was raw SQL.
 *
 * No supertest / `request(app)` anywhere (CI tripwire #4154): the route's FINAL handler
 * is invoked directly, the same shape tests/unit/recovery-conflict-surfaces-routes-rbac
 * already uses for this router.
 *
 * The fake DB below is not a stub that answers fixed rows — it is a tiny interpreter with
 * REAL state, so "nothing was written" is asserted against the state a statement would
 * have produced, not against a mock call list. It models the two properties the fix
 * leans on:
 *   - `transaction()` rolls the state back when its callback throws (so a partial-failure
 *     leg can distinguish an atomic write from two independent ones), and
 *   - `role_permissions.permission_code` REFERENCES `permissions(code)` (so a leg that
 *     removes the explicit catalog probe still cannot write an uncatalogued code — the
 *     400 has to come from the route, not from luck).
 * Both pool.query and the transaction client route through the SAME interpreter, so a
 * mutation that moves a statement between those two seams still executes and is still
 * observed.
 */

import type { Request, Response, Router } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  poolQuery: vi.fn(),
}))

const rbacServiceMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
  userHasPermission: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.poolQuery },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacServiceMocks.isAdmin,
  listUserPermissions: rbacServiceMocks.listUserPermissions,
  invalidateUserPerms: rbacServiceMocks.invalidateUserPerms,
  userHasPermission: rbacServiceMocks.userHasPermission,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

import { rolesRouter } from '../../src/routes/roles'

// --------------------------------------------------------------------------- fake DB

type Rows = { rows: Array<Record<string, unknown>>; rowCount: number }

interface FakeDbState {
  roleNames: Map<string, string>
  rolePermissions: Map<string, string[]>
  members: Map<string, string[]>
}

function cloneState(state: FakeDbState): FakeDbState {
  return {
    roleNames: new Map(state.roleNames),
    rolePermissions: new Map(Array.from(state.rolePermissions, ([k, v]) => [k, [...v]])),
    members: new Map(Array.from(state.members, ([k, v]) => [k, [...v]])),
  }
}

/** `role_permissions_permission_code_fkey` — the error the route must never provoke. */
function fkViolation(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`insert or update on table "role_permissions" violates foreign key constraint "role_permissions_permission_code_fkey" (${code})`),
    { code: '23503' },
  )
}

function makeFakeDb(options: {
  catalog: string[]
  state: FakeDbState
  /** Injects a failure at a chosen statement, to exercise the rollback. */
  failOn?: (sql: string, params: unknown[]) => Error | null
}) {
  const catalog = new Set(options.catalog)
  const statements: Array<{ sql: string; params: unknown[] }> = []
  let state = options.state

  const run = async (sql: string, params: unknown[] = []): Promise<Rows> => {
    statements.push({ sql, params })
    const injected = options.failOn?.(sql, params)
    if (injected) throw injected

    const norm = sql.replace(/\s+/g, ' ').trim()

    if (/^SELECT id, name FROM roles WHERE id=/i.test(norm)) {
      const id = String(params[0])
      const name = state.roleNames.get(id)
      return name === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id, name }], rowCount: 1 }
    }
    if (/^SELECT user_id FROM user_roles WHERE role_id=/i.test(norm)) {
      const members = state.members.get(String(params[0])) || []
      return { rows: members.map((user_id) => ({ user_id })), rowCount: members.length }
    }
    if (/^SELECT permission_code FROM role_permissions WHERE role_id=/i.test(norm)) {
      const codes = state.rolePermissions.get(String(params[0])) || []
      return { rows: codes.map((permission_code) => ({ permission_code })), rowCount: codes.length }
    }
    if (/^SELECT code FROM permissions WHERE code = ANY/i.test(norm)) {
      const wanted = (params[0] as string[]) || []
      const hit = wanted.filter((code) => catalog.has(code))
      return { rows: hit.map((code) => ({ code })), rowCount: hit.length }
    }
    if (/^UPDATE roles SET name=/i.test(norm)) {
      const [name, id] = [String(params[0]), String(params[1])]
      if (!state.roleNames.has(id)) return { rows: [], rowCount: 0 }
      state.roleNames.set(id, name)
      return { rows: [], rowCount: 1 }
    }
    if (/^DELETE FROM role_permissions WHERE role_id=/i.test(norm)) {
      const id = String(params[0])
      const keep = new Set((params[1] as string[]) || [])
      const current = state.rolePermissions.get(id) || []
      const next = current.filter((code) => keep.has(code))
      state.rolePermissions.set(id, next)
      return { rows: [], rowCount: current.length - next.length }
    }
    if (/^INSERT INTO role_permissions/i.test(norm)) {
      const [id, code] = [String(params[0]), String(params[1])]
      // The FK is real in both migration paths, so the fake enforces it.
      if (!catalog.has(code)) throw fkViolation(code)
      const current = state.rolePermissions.get(id) || []
      if (!current.includes(code)) state.rolePermissions.set(id, [...current, code])
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`fake db: unhandled statement: ${norm}`)
  }

  return {
    run,
    statements,
    permissionsOf: (roleId: string) => [...(state.rolePermissions.get(roleId) || [])].sort(),
    nameOf: (roleId: string) => state.roleNames.get(roleId),
    /** ATOMIC: the callback's writes survive only if it resolves. */
    transaction: async <T>(handler: (client: { query: typeof run }) => Promise<T>): Promise<T> => {
      const snapshot = cloneState(state)
      try {
        return await handler({ query: run })
      } catch (error) {
        state = snapshot
        throw error
      }
    },
  }
}

// ------------------------------------------------------------------------- harness

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
  }
  return res as Response & { statusCode: number; body: unknown }
}

/** Invoke the route's FINAL handler directly (the rbacGuard above it is not under test). */
function invokeHandler(
  router: Router,
  method: 'put',
  path: string,
  req: Partial<Request>,
  res: Response,
): Promise<unknown> {
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
      }
    }>
  }).stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const fullReq = {
    method: method.toUpperCase(),
    headers: {},
    query: {},
    params: {},
    body: {},
    user: { id: 'owner-1' },
    ...req,
  } as unknown as Request
  return Promise.resolve(handler(fullReq, res, (err?: unknown) => {
    if (err) throw err
  }))
}

const CATALOG = ['stock-prep:read', 'stock-prep:write', 'roles:read', 'roles:write', 'admin:users', '*:*']

function seed(overrides: Partial<{ permissions: string[]; members: string[] }> = {}) {
  return makeFakeDb({
    catalog: CATALOG,
    state: {
      roleNames: new Map([['role-1', '备料角色'], ['role-other', '其它角色']]),
      rolePermissions: new Map([
        ['role-1', overrides.permissions ?? ['roles:read', 'stock-prep:read']],
        ['role-other', ['roles:read']],
      ]),
      members: new Map([
        ['role-1', overrides.members ?? ['user-a', 'user-b']],
        ['role-other', ['user-z']],
      ]),
    },
  })
}

function wire(db: ReturnType<typeof makeFakeDb>) {
  pgMocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) => db.run(sql, params ?? []))
  pgMocks.transaction.mockImplementation((handler: Parameters<typeof db.transaction>[0]) => db.transaction(handler))
}

function putRole(body: Record<string, unknown>, res: Response, id = 'role-1', userId = 'owner-1') {
  return invokeHandler(rolesRouter(), 'put', '/api/roles/:id', {
    params: { id },
    body,
    user: { id: userId } as Request['user'],
  }, res)
}

beforeEach(() => {
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  pgMocks.poolQuery.mockReset()
  rbacServiceMocks.isAdmin.mockReset()
  rbacServiceMocks.listUserPermissions.mockReset()
  rbacServiceMocks.invalidateUserPerms.mockReset()
  rbacServiceMocks.userHasPermission.mockReset()
  rbacServiceMocks.isAdmin.mockResolvedValue(false)
  rbacServiceMocks.userHasPermission.mockResolvedValue(false)
  auditMocks.auditLog.mockReset()
  auditMocks.auditLog.mockResolvedValue(undefined)
})

describe('PUT /api/roles/:id — permission set persistence', () => {
  it('ABSENT permissions key: a name-only rename leaves the permission set untouched', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ name: '备料角色(改名)' }, res)

    expect(res.statusCode).toBe(200)
    expect(db.nameOf('role-1')).toBe('备料角色(改名)')
    // The whole point of absent-vs-empty: a rename must not strip the role.
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
    // and it must not have TOUCHED role_permissions at all.
    expect(db.statements.some((s) => /role_permissions/i.test(s.sql))).toBe(false)
    // nothing changed for any member, so no cache fan-out.
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })

  it('PRESENT array: replace semantics — the listed codes are added AND the unlisted ones removed', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    // drops stock-prep:read, keeps roles:read, adds stock-prep:write
    await putRole({ name: '备料角色', permissions: ['roles:read', 'stock-prep:write'] }, res)

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:write'])
    expect((res.body as { ok: boolean }).ok).toBe(true)
    expect((res.body as { data: { permissions: string[] } }).data.permissions).toEqual(['roles:read', 'stock-prep:write'])
    // the sibling role is untouched — the DELETE is scoped to this role_id.
    expect(db.permissionsOf('role-other')).toEqual(['roles:read'])
  })

  it('PRESENT empty array: clears the set (an unchecked grid is a real instruction, unlike an absent key)', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ name: '备料角色', permissions: [] }, res)

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual([])
  })

  it('UNKNOWN code → 400 and NOTHING written (the old set and the old name both survive)', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ name: '改了的名字', permissions: ['roles:read', 'not-a-real:code'] }, res)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe('UNKNOWN_PERMISSION_CODE')
    const details = (res.body as { error: { details: { unknownCount: number; unknown: string[] } } }).error.details
    expect(details.unknownCount).toBe(1)
    // Echoing is safe: these codes came from THIS request's own body.
    expect(details.unknown).toEqual(['not-a-real:code'])

    // NOTHING written — not the permissions, not even the rename.
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
    expect(db.nameOf('role-1')).toBe('备料角色')
    expect(db.statements.some((s) => /^INSERT INTO role_permissions/i.test(s.sql.trim()))).toBe(false)
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('non-array permissions → 400 rather than a guess', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ name: 'x', permissions: 'roles:read' }, res)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe('PERMISSIONS_INVALID')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
    expect(db.nameOf('role-1')).toBe('备料角色')
  })

  it('TRANSACTION: a failure part-way through the permission write leaves NEITHER change applied', async () => {
    const db = makeFakeDb({
      catalog: CATALOG,
      state: {
        roleNames: new Map([['role-1', '备料角色']]),
        rolePermissions: new Map([['role-1', ['roles:read', 'stock-prep:read']]]),
        members: new Map([['role-1', ['user-a']]]),
      },
      // The DELETE lands first, then the second INSERT blows up — the worst case for a
      // non-atomic writer: the role would be left renamed AND half-granted.
      failOn: (sql, params) =>
        /^INSERT INTO role_permissions/i.test(sql.trim()) && params[1] === 'stock-prep:write'
          ? Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' })
          : null,
    })
    wire(db)
    const res = mockResponse()

    await expect(putRole({ name: '改了的名字', permissions: ['roles:write', 'stock-prep:write'] }, res))
      .rejects.toThrow('connection terminated unexpectedly')

    expect(db.nameOf('role-1')).toBe('备料角色')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('CACHE: the permission memo is invalidated for exactly the role members, and nobody else', async () => {
    const db = seed({ members: ['user-a', 'user-b'] })
    wire(db)
    const res = mockResponse()

    await putRole({ name: '备料角色', permissions: ['roles:read', 'stock-prep:write'] }, res)

    expect(res.statusCode).toBe(200)
    expect(rbacServiceMocks.invalidateUserPerms.mock.calls.map((call) => call[0]).sort())
      .toEqual(['user-a', 'user-b'])
    // scoped by role_id: a member of the OTHER role is not invalidated.
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalledWith('user-z')
    expect(db.statements.some((s) => /FROM user_roles WHERE role_id=/i.test(s.sql))).toBe(true)
  })

  it('CACHE: a REVOCATION invalidates too (the direction that otherwise fails open for the TTL)', async () => {
    const db = seed({ permissions: ['roles:read', 'stock-prep:write'], members: ['user-a'] })
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read'] }, res)

    expect(db.permissionsOf('role-1')).toEqual(['roles:read'])
    expect(rbacServiceMocks.invalidateUserPerms).toHaveBeenCalledWith('user-a')
  })

  it('AUDIT: the entry records the permission delta (codes and counts, no user data)', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ name: '备料角色', permissions: ['roles:read', 'stock-prep:write'] }, res)

    expect(auditMocks.auditLog).toHaveBeenCalledTimes(1)
    const entry = auditMocks.auditLog.mock.calls[0][0] as {
      action: string
      resourceType: string
      resourceId: string
      meta: Record<string, unknown>
    }
    expect(entry.action).toBe('update')
    expect(entry.resourceType).toBe('role')
    expect(entry.resourceId).toBe('role-1')
    expect(entry.meta.permissionsChanged).toBe(true)
    expect(entry.meta.permissionsAdded).toEqual(['stock-prep:write'])
    expect(entry.meta.permissionsRemoved).toEqual(['stock-prep:read'])
    expect(entry.meta.membersInvalidated).toBe(2)
    expect((entry.meta.before as { permissions: string[] }).permissions).toEqual(['roles:read', 'stock-prep:read'])
    expect((entry.meta.after as { permissions: string[] }).permissions).toEqual(['roles:read', 'stock-prep:write'])
  })

  it('AUDIT: a name-only rename reports no permission change', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ name: '新名字' }, res)

    const entry = auditMocks.auditLog.mock.calls[0][0] as { meta: Record<string, unknown> }
    expect(entry.meta.permissionsChanged).toBe(false)
    expect(entry.meta.permissionsAdded).toEqual([])
    expect(entry.meta.permissionsRemoved).toEqual([])
  })

  it('ESCALATION: a non-admin, non-wildcard caller cannot ADD the all-permissions code', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read', 'stock-prep:read', '*:*'] }, res)

    expect(res.statusCode).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('PERMISSION_ESCALATION_FORBIDDEN')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('ESCALATION: a platform admin may add it (the gate narrows, it does not block the owner)', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read', 'stock-prep:read', '*:*'] }, res)

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['*:*', 'roles:read', 'stock-prep:read'])
  })

  it('ESCALATION: a wildcard HOLDER who is not in the admin role may add it too (live check, not the memo)', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(false)
    rbacServiceMocks.userHasPermission.mockImplementation(async (_userId: string, code: string) => code === '*:*')
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read', 'stock-prep:read', 'admin:users'] }, res)

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['admin:users', 'roles:read', 'stock-prep:read'])
    expect(rbacServiceMocks.userHasPermission).toHaveBeenCalledWith('owner-1', '*:*')
  })

  it('ESCALATION: keeping an already-granted elevated code is not an escalation (rename must stay possible)', async () => {
    const db = seed({ permissions: ['*:*'] })
    wire(db)
    const res = mockResponse()

    await putRole({ name: '超级角色', permissions: ['*:*'] }, res)

    expect(res.statusCode).toBe(200)
    expect(db.nameOf('role-1')).toBe('超级角色')
    expect(db.permissionsOf('role-1')).toEqual(['*:*'])
  })

  it('a missing role is still a 404 and writes nothing', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ name: 'x', permissions: ['roles:read'] }, res, 'role-missing')

    expect(res.statusCode).toBe(404)
    expect(db.statements.some((s) => /role_permissions/i.test(s.sql))).toBe(false)
  })
})
