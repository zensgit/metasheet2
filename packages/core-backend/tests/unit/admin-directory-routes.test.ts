import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rbacMocks = vi.hoisted(() => ({
  isRbacAdmin: vi.fn(),
}))

const directoryMocks = vi.hoisted(() => ({
  listDirectoryIntegrations: vi.fn(),
  createDirectoryIntegration: vi.fn(),
  updateDirectoryIntegration: vi.fn(),
  testDirectoryIntegration: vi.fn(),
  syncDirectoryIntegration: vi.fn(),
  listDirectorySyncRuns: vi.fn(),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isRbacAdmin,
}))

vi.mock('../../src/directory/directory-sync', () => ({
  listDirectoryIntegrations: directoryMocks.listDirectoryIntegrations,
  createDirectoryIntegration: directoryMocks.createDirectoryIntegration,
  updateDirectoryIntegration: directoryMocks.updateDirectoryIntegration,
  testDirectoryIntegration: directoryMocks.testDirectoryIntegration,
  syncDirectoryIntegration: directoryMocks.syncDirectoryIntegration,
  listDirectorySyncRuns: directoryMocks.listDirectorySyncRuns,
}))

import { adminDirectoryRouter } from '../../src/routes/admin-directory'

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
  method: 'get' | 'post' | 'put',
  path: string,
  options: {
    params?: Record<string, string>
    query?: Record<string, unknown>
    body?: Record<string, unknown>
    user?: Record<string, unknown>
  } = {},
) {
  const router = adminDirectoryRouter()
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    params: options.params ?? {},
    query: options.query ?? {},
    body: options.body ?? {},
    user: options.user,
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

describe('adminDirectoryRouter', () => {
  beforeEach(() => {
    rbacMocks.isRbacAdmin.mockReset()
    directoryMocks.listDirectoryIntegrations.mockReset()
    directoryMocks.createDirectoryIntegration.mockReset()
    directoryMocks.updateDirectoryIntegration.mockReset()
    directoryMocks.testDirectoryIntegration.mockReset()
    directoryMocks.syncDirectoryIntegration.mockReset()
    directoryMocks.listDirectorySyncRuns.mockReset()
  })

  it('rejects unauthenticated requests', async () => {
    const response = await invokeRoute('get', '/integrations')
    expect(response.statusCode).toBe(401)
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
      },
    })
  })

  it('lists integrations for admin users', async () => {
    directoryMocks.listDirectoryIntegrations.mockResolvedValue([
      { id: 'dir-1', name: 'DingTalk CN' },
    ])

    const response = await invokeRoute('get', '/integrations', {
      user: {
        id: 'admin-1',
        role: 'admin',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listDirectoryIntegrations).toHaveBeenCalledTimes(1)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        items: [{ id: 'dir-1', name: 'DingTalk CN' }],
      },
    })
  })

  it('delegates sync to the directory service and returns its payload', async () => {
    directoryMocks.syncDirectoryIntegration.mockResolvedValue({
      integration: { id: 'dir-1', name: 'DingTalk CN' },
      run: { id: 'run-1', status: 'completed' },
    })

    const response = await invokeRoute('post', '/integrations/:integrationId/sync', {
      params: { integrationId: 'dir-1' },
      user: {
        id: 'admin-1',
        role: 'admin',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.syncDirectoryIntegration).toHaveBeenCalledWith('dir-1', 'admin-1')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        integration: { id: 'dir-1' },
        run: { id: 'run-1', status: 'completed' },
      },
    })
  })

  it('supports admin checks via RBAC fallback', async () => {
    rbacMocks.isRbacAdmin.mockResolvedValue(true)
    directoryMocks.listDirectorySyncRuns.mockResolvedValue({
      items: [{ id: 'run-1', status: 'completed' }],
      total: 1,
    })

    const response = await invokeRoute('get', '/integrations/:integrationId/runs', {
      params: { integrationId: 'dir-1' },
      query: { page: '1', pageSize: '10' },
      user: {
        id: 'user-2',
        role: 'user',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(rbacMocks.isRbacAdmin).toHaveBeenCalledWith('user-2')
    expect(directoryMocks.listDirectorySyncRuns).toHaveBeenCalledWith('dir-1', { limit: 10, offset: 0 })
  })
})
