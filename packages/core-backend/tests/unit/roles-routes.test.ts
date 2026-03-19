import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgQuery = vi.hoisted(() => vi.fn())
const auditLog = vi.hoisted(() => vi.fn())

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = { id: 'admin-1' } as never
    next()
  },
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog,
}))

vi.mock('../../src/db/pg', () => ({
  pool: {
    query: pgQuery,
  },
}))

import { rolesRouter } from '../../src/routes/roles'

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
  method: 'post' | 'put' | 'delete',
  path: string,
  options: {
    params?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  const router = rolesRouter()
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    query: {},
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

describe('roles routes', () => {
  beforeEach(() => {
    pgQuery.mockReset()
    auditLog.mockReset()
    auditLog.mockResolvedValue(undefined)
  })

  it('updates a role name and replaces permissions when provided', async () => {
    pgQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'role-1', name: 'Old Name' }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })

    const response = await invokeRoute('put', '/api/roles/:id', {
      params: { id: 'role-1' },
      body: {
        name: 'New Name',
        permissions: ['permissions:read', 'permissions:write'],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        id: 'role-1',
        name: 'New Name',
        permissions: ['permissions:read', 'permissions:write'],
      },
    })
    expect(pgQuery).toHaveBeenCalledWith('DELETE FROM role_permissions WHERE role_id = $1', ['role-1'])
    expect(pgQuery).toHaveBeenCalledWith(
      'INSERT INTO role_permissions(role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      ['role-1', 'permissions:read'],
    )
    expect(pgQuery).toHaveBeenCalledWith(
      'INSERT INTO role_permissions(role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      ['role-1', 'permissions:write'],
    )
  })

  it('creates a role through the admin alias without exposing a duplicate list route', async () => {
    pgQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'role-2', name: 'Workflow Admin', created_at: '2026-03-18T00:00:00.000Z', updated_at: '2026-03-18T00:00:00.000Z' }],
      })

    const response = await invokeRoute('post', '/api/admin/roles', {
      body: {
        id: 'role-2',
        name: 'Workflow Admin',
        permissions: ['workflow:read', 'workflow:write'],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        id: 'role-2',
        name: 'Workflow Admin',
      },
    })
    expect(pgQuery).toHaveBeenCalledWith(
      'INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      ['role-2', 'workflow:read'],
    )
    expect(
      rolesRouter().stack.find((entry) => entry.route?.path === '/api/admin/roles' && entry.route?.methods?.get),
    ).toBeUndefined()
  })

  it('deletes role permissions before deleting the role', async () => {
    pgQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'role-1', name: 'Attendance Admin' }],
      })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })

    const response = await invokeRoute('delete', '/api/roles/:id', {
      params: { id: 'role-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: { id: 'role-1' },
    })
    expect(pgQuery.mock.calls[1]).toEqual(['DELETE FROM role_permissions WHERE role_id=$1', ['role-1']])
    expect(pgQuery.mock.calls[2]).toEqual(['DELETE FROM roles WHERE id=$1', ['role-1']])
  })
})
