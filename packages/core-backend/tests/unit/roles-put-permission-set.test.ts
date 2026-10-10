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
  roleUpdatedAt: Map<string, string>
  rolePermissions: Map<string, string[]>
  members: Map<string, string[]>
}

function cloneState(state: FakeDbState): FakeDbState {
  return {
    roleNames: new Map(state.roleNames),
    roleUpdatedAt: new Map(state.roleUpdatedAt),
    rolePermissions: new Map(Array.from(state.rolePermissions, ([k, v]) => [k, [...v]])),
    members: new Map(Array.from(state.members, ([k, v]) => [k, [...v]])),
  }
}

/** The stored concurrency token of the seeded roles. */
const SEEDED_UPDATED_AT = '2026-09-16T01:02:03.000Z'

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

    if (/^SELECT id, name, updated_at FROM roles WHERE id=\$1 FOR UPDATE$/i.test(norm)) {
      const id = String(params[0])
      const name = state.roleNames.get(id)
      return name === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id, name, updated_at: state.roleUpdatedAt.get(id) ?? null }], rowCount: 1 }
    }
    if (/^SELECT id FROM roles WHERE id=\$1 FOR UPDATE$/i.test(norm)) {
      const id = String(params[0])
      return state.roleNames.has(id)
        ? { rows: [{ id }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (/^SELECT id, name FROM roles WHERE id=/i.test(norm)) {
      const id = String(params[0])
      const name = state.roleNames.get(id)
      return name === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id, name }], rowCount: 1 }
    }
    if (/^SELECT id, name, created_at, updated_at FROM roles WHERE id=/i.test(norm)) {
      const id = String(params[0])
      const name = state.roleNames.get(id)
      return name === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id, name, created_at: SEEDED_UPDATED_AT, updated_at: state.roleUpdatedAt.get(id) ?? null }], rowCount: 1 }
    }
    if (/^INSERT INTO roles\(id, name\)/i.test(norm)) {
      // ON CONFLICT (id) DO NOTHING — an existing role keeps its name, as the real statement does.
      const [id, name] = [String(params[0]), String(params[1])]
      if (!state.roleNames.has(id)) {
        state.roleNames.set(id, name)
        state.roleUpdatedAt.set(id, SEEDED_UPDATED_AT)
      }
      return { rows: [], rowCount: 1 }
    }
    if (/^DELETE FROM roles WHERE id=/i.test(norm)) {
      const id = String(params[0])
      const existed = state.roleNames.delete(id)
      state.rolePermissions.delete(id)
      // ON DELETE CASCADE on BOTH children (migrations/033_create_rbac_core.sql:17 and :36).
      // Modelling the user_roles half is what makes "read the members before the delete"
      // a testable property instead of a code-shape preference: a fan-out that looked them
      // up afterwards finds nobody here, exactly as it would in Postgres.
      state.members.delete(id)
      return { rows: [], rowCount: existed ? 1 : 0 }
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
      // `updated_at=now()` — the token moves on every successful write.
      state.roleUpdatedAt.set(id, new Date(Date.parse(SEEDED_UPDATED_AT) + 60_000).toISOString())
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

type RouteMethod = 'post' | 'put' | 'delete'

/** The registered middleware chain of one route, guard included. */
function routeStack(router: Router, method: RouteMethod, path: string) {
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
  return layer.route.stack
}

/** Invoke the route's FINAL handler directly (the rbacGuard above it is not under test). */
function invokeHandler(
  router: Router,
  method: RouteMethod,
  path: string,
  req: Partial<Request>,
  res: Response,
): Promise<unknown> {
  const stack = routeStack(router, method, path)
  const handler = stack[stack.length - 1].handle
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

const CATALOG = ['stock-prep:read', 'stock-prep:write', 'stock-prep:*', 'roles:read', 'roles:write', 'admin:users', '*:*']

function seed(overrides: Partial<{
  permissions: string[]
  members: string[]
  adminPermissions: string[]
  failOn: (sql: string, params: unknown[]) => Error | null
}> = {}) {
  return makeFakeDb({
    catalog: CATALOG,
    failOn: overrides.failOn,
    state: {
      roleNames: new Map([['role-1', '备料角色'], ['role-other', '其它角色'], ['admin', 'platform admin']]),
      roleUpdatedAt: new Map([
        ['role-1', SEEDED_UPDATED_AT],
        ['role-other', SEEDED_UPDATED_AT],
        ['admin', SEEDED_UPDATED_AT],
      ]),
      rolePermissions: new Map([
        ['role-1', overrides.permissions ?? ['roles:read', 'stock-prep:read']],
        ['role-other', ['roles:read']],
        ['admin', overrides.adminPermissions ?? ['*:*', 'admin:users']],
      ]),
      members: new Map([
        ['role-1', overrides.members ?? ['user-a', 'user-b']],
        ['role-other', ['user-z']],
        ['admin', ['owner-9']],
      ]),
    },
  })
}

function wire(db: ReturnType<typeof makeFakeDb>) {
  pgMocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) => db.run(sql, params ?? []))
  pgMocks.transaction.mockImplementation((handler: Parameters<typeof db.transaction>[0]) => db.transaction(handler))
}

function putRole(
  body: Record<string, unknown>,
  res: Response,
  id = 'role-1',
  user: Record<string, unknown> = { id: 'owner-1' },
) {
  return invokeHandler(rolesRouter(), 'put', '/api/roles/:id', {
    params: { id },
    body,
    user: user as Request['user'],
  }, res)
}

function postRole(body: Record<string, unknown>, res: Response, user: Record<string, unknown> = { id: 'owner-1' }) {
  return invokeHandler(rolesRouter(), 'post', '/api/roles', {
    body,
    user: user as Request['user'],
  }, res)
}

function deleteRole(res: Response, id: string, user: Record<string, unknown> = { id: 'owner-1' }) {
  return invokeHandler(rolesRouter(), 'delete', '/api/roles/:id', {
    params: { id },
    user: user as Request['user'],
  }, res)
}

/** Audit entries whose action is a WRITE (`create`/`update`/`delete`), i.e. not a `*_denied` refusal. */
function writeAuditEntries() {
  return auditMocks.auditLog.mock.calls
    .map((call) => call[0] as { action: string })
    .filter((entry) => !entry.action.endsWith('_denied'))
}

/** Audit entries the refusal path records (values-free: counts, never the codes). */
function deniedAuditEntries() {
  return auditMocks.auditLog.mock.calls
    .map((call) => call[0] as { action: string; resourceId: string; meta: Record<string, unknown> })
    .filter((entry) => entry.action.endsWith('_denied'))
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
    // No WRITE-shaped entry — but the refusal itself IS recorded, values-free.
    expect(writeAuditEntries()).toEqual([])
    const denied = deniedAuditEntries()
    expect(denied).toHaveLength(1)
    expect(denied[0].action).toBe('update_denied')
    expect(denied[0].resourceId).toBe('role-1')
    expect(denied[0].meta.refusalCode).toBe('UNKNOWN_PERMISSION_CODE')
    expect(denied[0].meta.offendingCount).toBe(1)
    // counts only: the durable record must not carry the submitted codes.
    expect(JSON.stringify(denied[0].meta)).not.toContain('not-a-real:code')
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
        roleUpdatedAt: new Map([['role-1', SEEDED_UPDATED_AT]]),
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

    await putRole({ name: '改了的名字', permissions: ['roles:write', 'stock-prep:write'] }, res)

    // The unclassified failure ANSWERS. This router has no async error wrapper, so a
    // rethrow here would leave the caller with no response at all — a hung request.
    expect(res.statusCode).toBe(500)
    expect((res.body as { error: { code: string } }).error.code).toBe('ROLE_WRITE_FAILED')
    // and the body stays values-free: no driver text, no submitted codes.
    expect(JSON.stringify(res.body)).not.toContain('connection terminated')
    expect(db.nameOf('role-1')).toBe('备料角色')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
  })

  it('a role deleted mid-write (role_id FK, 23503) answers 409 instead of hanging the caller', async () => {
    const db = makeFakeDb({
      catalog: CATALOG,
      state: {
        roleNames: new Map([['role-1', '备料角色']]),
        roleUpdatedAt: new Map([['role-1', SEEDED_UPDATED_AT]]),
        rolePermissions: new Map([['role-1', ['roles:read']]]),
        members: new Map([['role-1', ['user-a']]]),
      },
      failOn: (sql) => /^INSERT INTO role_permissions/i.test(sql.trim())
        ? Object.assign(
          new Error('insert or update on table "role_permissions" violates foreign key constraint "role_permissions_role_id_fkey"'),
          { code: '23503' },
        )
        : null,
    })
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read', 'stock-prep:write'] }, res)

    expect(res.statusCode).toBe(409)
    expect((res.body as { error: { code: string } }).error.code).toBe('ROLE_WRITE_CONFLICT')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read'])
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
    // Nothing was written — but the attempt is on the record, so a caller probing the gate
    // cannot spend an afternoon guessing codes and leave no trace.
    expect(writeAuditEntries()).toEqual([])
    const denied = deniedAuditEntries()
    expect(denied).toHaveLength(1)
    expect(denied[0].meta.refusalCode).toBe('PERMISSION_ESCALATION_FORBIDDEN')
    expect(denied[0].meta.offendingCount).toBe(1)
    expect(JSON.stringify(denied[0].meta)).not.toContain('*:*')
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

  it('LOCK: the role row is read FOR UPDATE as the FIRST statement inside the transaction', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read', 'stock-prep:write'] }, res)

    expect(res.statusCode).toBe(200)
    // Without the lock, two overlapping saves both read the pre-state under READ COMMITTED
    // and interleave their DELETE/INSERT pairs into the union of both desired sets.
    expect(db.statements[0].sql.replace(/\s+/g, ' ').trim())
      .toBe('SELECT id, name, updated_at FROM roles WHERE id=$1 FOR UPDATE')
    // and it is the same read the 404 and the rename are decided from — no pre-read outside
    // the transaction that the lock could not cover.
    expect(db.statements.filter((s) => /FROM roles WHERE id=\$1/i.test(s.sql)))
      .toHaveLength(1)
  })

  it('RENAME stays lease-proof: an unchanged set skips the DELETE/INSERT entirely', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    // What the editor actually sends on a rename: the WHOLE grid it loaded, unchanged.
    await putRole({ name: '新名字', permissions: ['roles:read', 'stock-prep:read'] }, res)

    expect(res.statusCode).toBe(200)
    expect(db.nameOf('role-1')).toBe('新名字')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
    // role_permissions carries a recovery-authority trigger; `roles` carries none. Writing
    // it for a no-op would make a rename answer the retryable 409 under a held lease, and
    // amplify every save into a pointless revoke+regrant.
    expect(db.statements.some((s) => /^DELETE FROM role_permissions/i.test(s.sql.trim()))).toBe(false)
    expect(db.statements.some((s) => /^INSERT INTO role_permissions/i.test(s.sql.trim()))).toBe(false)
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })

  it('CONCURRENCY: a stale editor cannot resurrect a revoked code — the echoed token 409s', async () => {
    const db = seed({ permissions: ['roles:read'] })
    wire(db)
    const res = mockResponse()

    // Admin A loaded {roles:read, stock-prep:read} at SEEDED_UPDATED_AT; admin B has since
    // revoked stock-prep:read (the seeded state above), moving the row's updated_at.
    await putRole({
      permissions: ['roles:read', 'stock-prep:read'],
      expectedUpdatedAt: new Date(Date.parse(SEEDED_UPDATED_AT) - 60_000).toISOString(),
    }, res)

    expect(res.statusCode).toBe(409)
    expect((res.body as { error: { code: string } }).error.code).toBe('ROLE_MODIFIED')
    // the revocation SURVIVES — the fail-open direction is the security-relevant one.
    expect(db.permissionsOf('role-1')).toEqual(['roles:read'])
    expect(writeAuditEntries()).toEqual([])
  })

  it('CONCURRENCY: the matching token is accepted, and an absent token keeps the old behaviour', async () => {
    const db = seed()
    wire(db)
    const matching = mockResponse()

    await putRole({ permissions: ['roles:read'], expectedUpdatedAt: SEEDED_UPDATED_AT }, matching)
    expect(matching.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['roles:read'])

    const db2 = seed()
    wire(db2)
    const noToken = mockResponse()
    await putRole({ permissions: ['roles:read'] }, noToken)
    expect(noToken.statusCode).toBe(200)
    expect(db2.permissionsOf('role-1')).toEqual(['roles:read'])
  })

  it('CONCURRENCY: a set changed WITHOUT touching roles.updated_at is still caught (the provisioner case)', async () => {
    // applyRoleMatrix (the plugin provisioner) grants codes by writing role_permissions
    // directly, so the timestamp token stays valid while the set underneath has moved.
    const db = seed({ permissions: ['roles:read', 'stock-prep:read', 'stock-prep:write'] })
    wire(db)
    const res = mockResponse()

    await putRole({
      permissions: ['roles:read'],
      expectedUpdatedAt: SEEDED_UPDATED_AT,
      expectedPermissions: ['roles:read', 'stock-prep:read'],
    }, res)

    expect(res.statusCode).toBe(409)
    expect((res.body as { error: { code: string } }).error.code).toBe('ROLE_MODIFIED')
    // the code the admin never saw is NOT revoked.
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read', 'stock-prep:write'])
  })

  it('CONCURRENCY: a baseline that matches the stored set is accepted', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({
      permissions: ['roles:read'],
      expectedPermissions: ['stock-prep:read', 'roles:read'],
    }, res)

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['roles:read'])
  })

  it('CONCURRENCY: an unparseable token is a 400, never a silently skipped check', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read'], expectedUpdatedAt: 'not-a-timestamp' }, res)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe('EXPECTED_UPDATED_AT_INVALID')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
  })

  it('ESCALATION is SYMMETRIC: a non-admin cannot REMOVE an elevated code either', async () => {
    const db = seed({ permissions: ['stock-prep:*', 'roles:read'] })
    wire(db)
    const res = mockResponse()

    // Quietly revoking a whole delivery team, reported as ok:true, is not "less dangerous"
    // than granting — and the cache fan-out makes it effective immediately.
    await putRole({ permissions: ['roles:read'] }, res)

    expect(res.statusCode).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('PERMISSION_ESCALATION_FORBIDDEN')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:*'])
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalled()
  })

  it('ESCALATION is SYMMETRIC: a non-admin cannot EMPTY the seeded platform-admin role', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: [] }, res, 'admin')

    expect(res.statusCode).toBe(403)
    expect(db.permissionsOf('admin')).toEqual(['*:*', 'admin:users'])
    expect(db.nameOf('admin')).toBe('platform admin')
  })

  it('PROTECTED ROLE: a non-admin cannot even add an ordinary code to the platform-admin role', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['*:*', 'admin:users', 'roles:read'] }, res, 'admin')

    expect(res.statusCode).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('PROTECTED_ROLE_FORBIDDEN')
    expect(db.permissionsOf('admin')).toEqual(['*:*', 'admin:users'])
  })

  it('PROTECTED ROLE: a platform admin may still edit it (the gate narrows, it does not brick)', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['*:*', 'admin:users', 'roles:read'] }, res, 'admin')

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('admin')).toEqual(['*:*', 'admin:users', 'roles:read'])
  })

  it('PROTECTED ROLE: DELETE of the platform-admin role is refused for a non-admin and allowed for an admin', async () => {
    const db = seed()
    wire(db)
    const refused = mockResponse()

    await deleteRole(refused, 'admin')

    expect(refused.statusCode).toBe(403)
    expect((refused.body as { error: { code: string } }).error.code).toBe('PROTECTED_ROLE_FORBIDDEN')
    expect(db.nameOf('admin')).toBe('platform admin')
    expect(deniedAuditEntries().map((entry) => entry.action)).toEqual(['delete_denied'])

    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    const allowed = mockResponse()
    await deleteRole(allowed, 'admin')
    expect(allowed.statusCode).toBe(200)
    expect(db.nameOf('admin')).toBeUndefined()
  })

  it('DELETE of an ordinary role is untouched by the protection', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await deleteRole(res, 'role-1')

    expect(res.statusCode).toBe(200)
    expect(db.nameOf('role-1')).toBeUndefined()
  })

  it('CACHE: DELETE drops the memo for exactly the deleted role members, and nobody else', async () => {
    const db = seed({ members: ['user-a', 'user-b'] })
    wire(db)
    const res = mockResponse()

    await deleteRole(res, 'role-1')

    expect(res.statusCode).toBe(200)
    // Deleting a role is the WIDEST revocation this router offers — every code it carried,
    // for every member — and it is open to any roles:write holder for every role but
    // `admin`. Without the fan-out its members keep the whole revoked set for up to
    // RBAC_CACHE_TTL_MS (rbac/service.ts:13, default 60s): a revoke that fails OPEN.
    expect(rbacServiceMocks.invalidateUserPerms.mock.calls.map((call) => call[0]).sort())
      .toEqual(['user-a', 'user-b'])
    // scoped by role_id, like PUT's: a member of the OTHER role is untouched.
    expect(rbacServiceMocks.invalidateUserPerms).not.toHaveBeenCalledWith('user-z')
    // and the trail records the COUNT, never the member ids.
    const entry = auditMocks.auditLog.mock.calls[0][0] as { action: string; meta: Record<string, unknown> }
    expect(entry.action).toBe('delete')
    expect(entry.meta.membersInvalidated).toBe(2)
    expect(JSON.stringify(entry.meta)).not.toContain('user-a')
  })

  it('CACHE: DELETE reads the members BEFORE the row goes (user_roles cascades with it)', async () => {
    const db = seed({ members: ['user-a', 'user-b'] })
    wire(db)
    const res = mockResponse()

    await deleteRole(res, 'role-1')

    const memberRead = db.statements.findIndex((s) => /FROM user_roles WHERE role_id=/i.test(s.sql))
    const roleDelete = db.statements.findIndex((s) => /^DELETE FROM roles WHERE id=/i.test(s.sql.trim()))
    expect(memberRead).toBeGreaterThanOrEqual(0)
    expect(roleDelete).toBeGreaterThanOrEqual(0)
    // The ordering is the whole fix: user_roles.role_id REFERENCES roles(id) ON DELETE
    // CASCADE, so a fan-out placed after the DELETE reads an empty set and invalidates
    // nobody while still looking like a fan-out.
    expect(memberRead).toBeLessThan(roleDelete)
    expect(rbacServiceMocks.invalidateUserPerms).toHaveBeenCalledWith('user-a')
  })

  it('DELETE: a failing member snapshot refuses BEFORE deleting anything (the read is pre-commit)', async () => {
    const db = seed({
      members: ['user-a'],
      failOn: (sql) => /^SELECT user_id FROM user_roles/i.test(sql.trim())
        ? Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' })
        : null,
    })
    wire(db)
    const res = mockResponse()

    // The snapshot is a statement this fix ADDED to the handler; it must not become a new
    // way to hang the caller. It runs inside the try, so its failure is an answer.
    await expect(deleteRole(res, 'role-1')).resolves.toBeDefined()

    expect(res.statusCode).toBe(500)
    expect((res.body as { error: { code: string } }).error.code).toBe('ROLE_WRITE_FAILED')
    // and nothing was deleted: the failure is pre-commit, so refusing is the honest answer.
    expect(db.nameOf('role-1')).toBe('备料角色')
    expect(auditMocks.auditLog).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toContain('connection slots')
  })

  it('POST-COMMIT: DELETE still answers when the memo drop itself throws (the row is already gone)', async () => {
    const db = seed({ members: ['user-a'] })
    wire(db)
    rbacServiceMocks.invalidateUserPerms.mockImplementation(() => {
      throw new Error('memo backend down')
    })
    const res = mockResponse()

    await expect(deleteRole(res, 'role-1')).resolves.toBeDefined()

    expect(res.statusCode).toBe(200)
    expect(db.nameOf('role-1')).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('memo backend down')
  })

  it('ADMIT SET: an administrator known only by the legacy claim is NOT refused', async () => {
    // isAdmin() and userHasPermission() both false — this principal has no user_roles row
    // and no '*:*' grant. It is exactly the population `ensurePlatformAdmin` admits for
    // GET /api/admin/roles, i.e. the read side of this very editor; refusing it here would
    // recreate the "the owner has to do it in SQL" symptom this route exists to remove.
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read', 'stock-prep:read', '*:*'] }, res, 'role-1', { id: 'owner-1', role: 'admin' })

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['*:*', 'roles:read', 'stock-prep:read'])
    expect(rbacServiceMocks.isAdmin).not.toHaveBeenCalled()
  })

  it('ADMIT SET: a token `perms` claim of admin:all is admitted too (the same predicate admin-users.ts uses)', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await putRole({ permissions: ['roles:read', 'admin:users'] }, res, 'role-1', { id: 'owner-1', perms: ['admin:all'] })

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['admin:users', 'roles:read'])
  })

  it('POST-COMMIT: a failing cache fan-out still ANSWERS 200 — the write is already committed', async () => {
    const db = seed({
      members: ['user-a'],
      failOn: (sql) => /^SELECT user_id FROM user_roles/i.test(sql.trim())
        ? Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' })
        : null,
    })
    wire(db)
    const res = mockResponse()

    // The handler must RESOLVE. This router is mounted bare in src/index.ts — no
    // asyncHandler, Express 4 — so a rejection in the post-commit tail is an unhandled
    // rejection and the caller gets NO response at all: a hung request until its own
    // timeout, which is the exact failure sendRoleWriteFailure exists to prevent.
    await expect(putRole({ permissions: ['roles:read', 'stock-prep:write'] }, res)).resolves.toBeDefined()

    expect(res.statusCode).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
    // ...and 200 is the TRUTH: the row really is committed. A 500 here would report a
    // landed write as a failed one and invite a retry whose delta is empty.
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:write'])
    // the audit entry still lands, with the fan-out reported as UNKNOWN rather than as 0
    // (0 is the "no members / nothing changed" value and would read as a clean run).
    const entry = auditMocks.auditLog.mock.calls[0][0] as { meta: Record<string, unknown> }
    expect(entry.meta.membersInvalidated).toBeNull()
    // values-free: no driver text reaches the caller.
    expect(JSON.stringify(res.body)).not.toContain('connection slots')
  })

  it('POST-COMMIT: a failing AUDIT write answers 200 too, and the fan-out already ran', async () => {
    const db = seed({ members: ['user-a'] })
    wire(db)
    auditMocks.auditLog.mockRejectedValue(Object.assign(new Error('audit sink down'), { code: '57P01' }))
    const res = mockResponse()

    await expect(putRole({ permissions: ['roles:read'] }, res)).resolves.toBeDefined()

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['roles:read'])
    // ordering matters: the fan-out runs FIRST, so a dead audit sink cannot leave the
    // revocation effective-for-60s on top of losing the record.
    expect(rbacServiceMocks.invalidateUserPerms).toHaveBeenCalledWith('user-a')
  })

  it('GUARD: every write verb is still registered BEHIND rbacGuard, and the guard refuses an unauthenticated request', async () => {
    const router = rolesRouter()
    for (const [method, path] of [['post', '/api/roles'], ['put', '/api/roles/:id'], ['delete', '/api/roles/:id']] as const) {
      const stack = routeStack(router, method, path)
      // guard + handler. Dropping the guard would turn this RBAC write path into an
      // authenticated-free-for-all while every behaviour leg above (which invokes the FINAL
      // handler directly) stayed green.
      expect(stack).toHaveLength(2)
      const res = mockResponse()
      let nexted = false
      await stack[0].handle(
        { method: method.toUpperCase(), headers: {}, query: {}, params: {}, body: {} } as unknown as Request,
        res,
        () => { nexted = true },
      )
      expect(nexted).toBe(false)
      expect(res.statusCode).toBe(401)
    }
  })
})

describe('POST /api/roles — the same authority boundary as PUT', () => {
  it('BYPASS CLOSED: the intent PUT refuses cannot be re-sent as POST with an existing id', async () => {
    const db = seed()
    wire(db)

    const putRes = mockResponse()
    await putRole({ permissions: ['roles:read', 'stock-prep:read', '*:*'] }, putRes)
    expect(putRes.statusCode).toBe(403)

    // Same caller, same role, same intent — POST's INSERT … ON CONFLICT DO NOTHING on the
    // role row plus its additive per-code INSERT used to land the grant unguarded.
    const postRes = mockResponse()
    await postRole({ id: 'role-1', name: '备料角色', permissions: ['*:*'] }, postRes)

    expect(postRes.statusCode).toBe(403)
    expect((postRes.body as { error: { code: string } }).error.code).toBe('PERMISSION_ESCALATION_FORBIDDEN')
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read'])
  })

  it('BYPASS CLOSED: the seeded platform-admin role cannot be topped up through POST either', async () => {
    const db = seed({ adminPermissions: ['admin:users'] })
    wire(db)
    const res = mockResponse()

    await postRole({ id: 'admin', name: '管理员', permissions: ['*:*'] }, res)

    expect(res.statusCode).toBe(403)
    expect(db.permissionsOf('admin')).toEqual(['admin:users'])
  })

  it('a brand-new role cannot be born with an elevated code either, and the role row rolls back', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await postRole({ id: 'role-new', name: '新角色', permissions: ['*:*'] }, res)

    expect(res.statusCode).toBe(403)
    // atomic: the role row itself must not survive a refused grant.
    expect(db.nameOf('role-new')).toBeUndefined()
    expect(writeAuditEntries()).toEqual([])
    expect(deniedAuditEntries().map((entry) => entry.action)).toEqual(['create_denied'])
  })

  it('a platform admin may still create an elevated role (the gate narrows, it does not block the owner)', async () => {
    rbacServiceMocks.isAdmin.mockResolvedValue(true)
    const db = seed()
    wire(db)
    const res = mockResponse()

    await postRole({ id: 'role-new', name: '新角色', permissions: ['*:*'] }, res)

    expect(res.statusCode).toBe(200)
    expect(db.permissionsOf('role-new')).toEqual(['*:*'])
  })

  it('ordinary codes are unaffected: a roles:write holder still creates and tops up normal roles', async () => {
    const db = seed()
    wire(db)

    const created = mockResponse()
    await postRole({ id: 'role-new', name: '新角色', permissions: ['stock-prep:read'] }, created)
    expect(created.statusCode).toBe(200)
    expect(db.permissionsOf('role-new')).toEqual(['stock-prep:read'])

    // additive on an existing role — POST's documented semantics, deliberately NOT replace.
    const topped = mockResponse()
    await postRole({ id: 'role-1', name: '备料角色', permissions: ['stock-prep:write'] }, topped)
    expect(topped.statusCode).toBe(200)
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read', 'stock-prep:write'])
    // and the members' permission memo is dropped, exactly as on PUT.
    expect(rbacServiceMocks.invalidateUserPerms.mock.calls.map((call) => call[0]).sort())
      .toEqual(['user-a', 'user-b'])
  })

  it('POST-COMMIT: POST answers when its fan-out AND its read-back fail (both are past the commit)', async () => {
    const db = seed({
      failOn: (sql) => /^SELECT user_id FROM user_roles/i.test(sql.trim())
        || /^SELECT id, name, created_at, updated_at FROM roles/i.test(sql.trim())
        ? Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' })
        : null,
    })
    wire(db)
    const res = mockResponse()

    await expect(postRole({ id: 'role-1', name: '备料角色', permissions: ['stock-prep:write'] }, res))
      .resolves.toBeDefined()

    expect(res.statusCode).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
    // the grant landed; only the tail failed.
    expect(db.permissionsOf('role-1')).toEqual(['roles:read', 'stock-prep:read', 'stock-prep:write'])
    // with the read-back gone, the id is all the handler can state as FACT: POST's
    // `ON CONFLICT (id) DO NOTHING` means the submitted name need not be the stored one,
    // so echoing it back would be a guess.
    expect((res.body as { data: unknown }).data).toEqual({ id: 'role-1' })
  })

  it('an uncatalogued code is a 400 here too, not a foreign-key rejection with no response', async () => {
    const db = seed()
    wire(db)
    const res = mockResponse()

    await postRole({ id: 'role-new', name: '新角色', permissions: ['not-a-real:code'] }, res)

    expect(res.statusCode).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe('UNKNOWN_PERMISSION_CODE')
    expect(db.nameOf('role-new')).toBeUndefined()
    expect(db.statements.some((s) => /^INSERT INTO role_permissions/i.test(s.sql.trim()))).toBe(false)
  })
})
