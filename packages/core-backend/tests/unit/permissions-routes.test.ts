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
    params: {},
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
})
