import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: {
    id: 'admin-1',
  },
}))

const poolMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  inspectUserPermissionGrants: vi.fn(),
  userHasPermission: vi.fn(),
  invalidateUserPerms: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: {
    query: poolMocks.query,
  },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
  inspectUserPermissionGrants: rbacMocks.inspectUserPermissionGrants,
  userHasPermission: rbacMocks.userHasPermission,
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

import { permissionsRouter } from '../../src/routes/permissions'

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as Response & {
    statusCode: number
    body: unknown
    headersSent: boolean
  }
}

async function invokeRoute(
  method: 'get' | 'post',
  path: string,
  options: {
    query?: Record<string, unknown>
    params?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  const router = permissionsRouter()
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body ?? {},
    user: undefined,
  } as unknown as Request

  const res = createMockResponse()

  for (const routeLayer of layer.route.stack) {
    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof maybePromise.then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (routeLayer.handle.length < 3) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  return res
}

describe('permissions routes', () => {
  beforeEach(() => {
    state.authUser = { id: 'admin-1' }
    poolMocks.query.mockReset()
    rbacMocks.isAdmin.mockReset()
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.inspectUserPermissionGrants.mockReset()
    rbacMocks.inspectUserPermissionGrants.mockResolvedValue({
      direct: [],
      inherited: [],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: [],
    })
    rbacMocks.userHasPermission.mockReset()
    rbacMocks.invalidateUserPerms.mockReset()
    auditMocks.auditLog.mockReset()
    auditMocks.auditLog.mockResolvedValue(undefined)
  })

  it('grants direct permissions and writes an audit entry', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    poolMocks.query
      .mockResolvedValueOnce({ rows: [{ code: 'attendance:approve' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })

    const response = await invokeRoute('post', '/api/permissions/grant', {
      body: {
        userId: 'user-1',
        permission: 'attendance:approve',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'permission',
      resourceId: 'user-1:attendance:approve',
    }))
    expect(poolMocks.query.mock.calls.map((call) => String(call[0])).join('\n'))
      .not.toMatch(/user_namespace_admissions/)
  })

  it('revokes direct permissions and writes an audit entry', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    poolMocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    const response = await invokeRoute('post', '/api/permissions/revoke', {
      body: {
        userId: 'user-1',
        permission: 'attendance:approve',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke',
      resourceType: 'permission',
      resourceId: 'user-1:attendance:approve',
    }))
  })

  it('lists permission templates filtered by mode', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)

    const response = await invokeRoute('get', '/api/admin/permission-templates', {
      query: { mode: 'attendance' },
    })

    expect(response.statusCode).toBe(200)
    const payload = response.body as Record<string, any>
    expect(Array.isArray(payload.data)).toBe(true)
    expect(payload.data.length).toBeGreaterThan(0)
    expect(payload.data.every((item: Record<string, unknown>) => item.productMode === 'attendance')).toBe(true)
  })

  it('applies permission template to a user and audits the action', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read', 'attendance:write'])
    poolMocks.query.mockResolvedValueOnce({ rowCount: 2, rows: [] })

    const response = await invokeRoute('post', '/api/admin/permission-templates/apply', {
      body: {
        userId: 'user-1',
        templateId: 'attendance-employee',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(rbacMocks.invalidateUserPerms).toHaveBeenCalledWith('user-1')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant',
      resourceType: 'permission-template',
      resourceId: 'user-1:attendance-employee',
    }))
    expect((response.body as Record<string, any>).template.id).toBe('attendance-employee')
    expect((response.body as Record<string, any>).permissions).toEqual(['attendance:read', 'attendance:write'])
  })

  it('lets a platform admin GET another user by userId and returns persisted vs effective breakdown', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['workflow:read'])
    rbacMocks.inspectUserPermissionGrants.mockResolvedValue({
      direct: ['crm:read', 'workflow:read'],
      inherited: ['crm:write'],
      legacy: [],
      effective: ['workflow:read'],
      blockedByNamespaceAdmission: ['crm:read', 'crm:write'],
    })

    const response = await invokeRoute('get', '/api/permissions/user/:userId', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      userId: 'user-1',
      permissions: ['workflow:read'],
      isAdmin: false,
      direct: ['crm:read', 'workflow:read'],
      inherited: ['crm:write'],
      legacy: [],
      effective: ['workflow:read'],
      blockedByNamespaceAdmission: ['crm:read', 'crm:write'],
    })
    // Existing authorized boundary on this route is isAdmin (or self). Platform-admin
    // reads are keyed by userId only; this handler does not add a tenant/org partition.
    expect(rbacMocks.isAdmin.mock.calls[0]).toEqual(['admin-1'])
    expect(rbacMocks.inspectUserPermissionGrants.mock.calls[0]).toEqual(['user-1'])
    expect(rbacMocks.listUserPermissions).not.toHaveBeenCalled()
    expect(poolMocks.query).not.toHaveBeenCalled()
  })

  it('does not mix a stale authorization memo into the fresh inspection readback', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.listUserPermissions.mockResolvedValue(['workflow:read'])
    rbacMocks.inspectUserPermissionGrants.mockResolvedValue({
      direct: [],
      inherited: [],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: [],
    })

    const response = await invokeRoute('get', '/api/permissions/user/:userId', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      userId: 'user-1',
      permissions: [],
      isAdmin: false,
      direct: [],
      inherited: [],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: [],
    })
    expect(rbacMocks.listUserPermissions).not.toHaveBeenCalled()
    expect((response.body as Record<string, unknown>).degraded).toBeUndefined()
  })

  it('returns an explicit degraded inspection when source tables are unavailable', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.inspectUserPermissionGrants.mockResolvedValue({
      direct: [],
      inherited: [],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: [],
      unavailable: true,
    })

    const response = await invokeRoute('get', '/api/permissions/user/:userId', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      userId: 'user-1',
      permissions: [],
      isAdmin: false,
      degraded: true,
      unavailable: true,
      direct: [],
      inherited: [],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: [],
    })
    expect(rbacMocks.listUserPermissions).not.toHaveBeenCalled()
  })

  it('does not treat a generic database error as a healthy empty inspection', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.inspectUserPermissionGrants.mockRejectedValue(
      Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
    )

    const response = await invokeRoute('get', '/api/permissions/user/:userId', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({ error: 'Failed to get user permissions' })
  })

  it('does not treat a thrown 42P01 as a healthy empty inspection when optional schema is off', async () => {
    rbacMocks.isAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    rbacMocks.inspectUserPermissionGrants.mockRejectedValue(
      Object.assign(new Error('relation "role_permissions" does not exist'), { code: '42P01' }),
    )

    const response = await invokeRoute('get', '/api/permissions/user/:userId', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({ error: 'Failed to get user permissions' })
  })

  it('refuses a non-admin GET of another user at the existing isAdmin gate', async () => {
    state.authUser = { id: 'user-2' }
    rbacMocks.isAdmin.mockResolvedValue(false)

    const response = await invokeRoute('get', '/api/permissions/user/:userId', {
      params: { userId: 'user-1' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.body).toEqual({ error: "Only admins can view other users' permissions" })
    expect(rbacMocks.isAdmin).toHaveBeenCalledWith('user-2')
    expect(rbacMocks.listUserPermissions).not.toHaveBeenCalled()
    expect(rbacMocks.inspectUserPermissionGrants).not.toHaveBeenCalled()
  })

  it('grants a namespaced code into user_permissions only and never writes namespace admissions', async () => {
    rbacMocks.isAdmin.mockResolvedValue(true)
    poolMocks.query
      .mockResolvedValueOnce({ rows: [{ code: 'crm:read' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })

    const response = await invokeRoute('post', '/api/permissions/grant', {
      body: {
        userId: 'user-1',
        permission: 'crm:read',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      success: true,
      userId: 'user-1',
      permission: 'crm:read',
    })
    const sql = poolMocks.query.mock.calls.map((call) => String(call[0]))
    expect(sql.some((statement) => statement.includes('INSERT INTO user_permissions'))).toBe(true)
    expect(sql.join('\n')).not.toMatch(/user_namespace_admissions/)
    expect(sql.join('\n')).not.toMatch(/\bUPDATE\b/i)
  })
})
