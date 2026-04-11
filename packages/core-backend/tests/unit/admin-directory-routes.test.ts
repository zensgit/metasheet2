import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rbacMocks = vi.hoisted(() => ({
  isRbacAdmin: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const directoryMocks = vi.hoisted(() => ({
  listDirectoryIntegrations: vi.fn(),
  createDirectoryIntegration: vi.fn(),
  updateDirectoryIntegration: vi.fn(),
  testDirectoryIntegration: vi.fn(),
  syncDirectoryIntegration: vi.fn(),
  listDirectorySyncRuns: vi.fn(),
  listDirectoryIntegrationAccounts: vi.fn(),
  bindDirectoryAccount: vi.fn(),
  unbindDirectoryAccount: vi.fn(),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isRbacAdmin,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

vi.mock('../../src/directory/directory-sync', () => ({
  listDirectoryIntegrations: directoryMocks.listDirectoryIntegrations,
  createDirectoryIntegration: directoryMocks.createDirectoryIntegration,
  updateDirectoryIntegration: directoryMocks.updateDirectoryIntegration,
  testDirectoryIntegration: directoryMocks.testDirectoryIntegration,
  syncDirectoryIntegration: directoryMocks.syncDirectoryIntegration,
  listDirectorySyncRuns: directoryMocks.listDirectorySyncRuns,
  listDirectoryIntegrationAccounts: directoryMocks.listDirectoryIntegrationAccounts,
  bindDirectoryAccount: directoryMocks.bindDirectoryAccount,
  unbindDirectoryAccount: directoryMocks.unbindDirectoryAccount,
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
    auditMocks.auditLog.mockReset()
    directoryMocks.listDirectoryIntegrations.mockReset()
    directoryMocks.createDirectoryIntegration.mockReset()
    directoryMocks.updateDirectoryIntegration.mockReset()
    directoryMocks.testDirectoryIntegration.mockReset()
    directoryMocks.syncDirectoryIntegration.mockReset()
    directoryMocks.listDirectorySyncRuns.mockReset()
    directoryMocks.listDirectoryIntegrationAccounts.mockReset()
    directoryMocks.bindDirectoryAccount.mockReset()
    directoryMocks.unbindDirectoryAccount.mockReset()
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

  it('tests a saved integration by forwarding the integrationId and payload to the directory service', async () => {
    directoryMocks.testDirectoryIntegration.mockResolvedValue({
      corpId: 'dingcorp',
      rootDepartmentId: '1',
      appKey: 'ding-app-key',
      departmentSampleCount: 0,
      sampledDepartments: [],
      userSampleCount: 1,
      sampledUsers: [{ userId: '0447654442691174', name: '周华' }],
      diagnostics: {
        rootDepartmentChildCount: 0,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
        rootDepartmentDirectUserCountWithAccessLimit: 1,
        rootDepartmentDirectUserHasMoreWithAccessLimit: false,
        sampledRootDepartmentUsers: [{ userId: '0447654442691174', name: '周华' }],
        sampledRootDepartmentUsersWithAccessLimit: [{ userId: '0447654442691174', name: '周华' }],
      },
      warnings: ['根部门 1 未返回任何子部门。'],
    })

    const payload = {
      integrationId: 'dir-1',
      name: 'DingTalk CN',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      appSecret: '',
      rootDepartmentId: '1',
      pageSize: 50,
      status: 'active',
      defaultDeprovisionPolicy: 'mark_inactive',
      syncEnabled: true,
    }

    const response = await invokeRoute('post', '/integrations/test', {
      body: payload,
      user: {
        id: 'admin-1',
        role: 'admin',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.testDirectoryIntegration).toHaveBeenCalledWith(payload)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          rootDepartmentDirectUserCount: 1,
        },
        warnings: ['根部门 1 未返回任何子部门。'],
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

  it('lists directory accounts for an integration', async () => {
    directoryMocks.listDirectoryIntegrationAccounts.mockResolvedValue({
      items: [{ id: 'account-1', externalUserId: '0447654442691174' }],
      total: 1,
    })

    const response = await invokeRoute('get', '/integrations/:integrationId/accounts', {
      params: { integrationId: 'dir-1' },
      query: { page: '1', pageSize: '50', q: '0447' },
      user: {
        id: 'admin-1',
        role: 'admin',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listDirectoryIntegrationAccounts).toHaveBeenCalledWith('dir-1', { limit: 50, offset: 0 }, '0447')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        total: 1,
        query: '0447',
      },
    })
  })

  it('binds a directory account to a local user reference', async () => {
    directoryMocks.bindDirectoryAccount.mockResolvedValue({
      account: {
        id: 'account-1',
        integrationId: 'dir-1',
        corpId: 'dingcorp',
        externalUserId: '0447654442691174',
        localUser: {
          id: 'user-1',
          email: 'alpha@example.com',
        },
      },
      previousLocalUser: null,
    })

    const response = await invokeRoute('post', '/accounts/:accountId/bind', {
      params: { accountId: 'account-1' },
      body: {
        localUserRef: 'alpha@example.com',
        enableDingTalkGrant: true,
      },
      user: {
        id: 'admin-1',
        role: 'admin',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.bindDirectoryAccount).toHaveBeenCalledWith('account-1', {
      localUserRef: 'alpha@example.com',
      adminUserId: 'admin-1',
      enableDingTalkGrant: true,
    })
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        account: {
          id: 'account-1',
          externalUserId: '0447654442691174',
        },
      },
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bind',
      resourceType: 'directory-account-link',
      resourceId: 'account-1',
    }))
  })

  it('unbinds a directory account', async () => {
    directoryMocks.unbindDirectoryAccount.mockResolvedValue({
      account: {
        id: 'account-1',
        externalUserId: '0447654442691174',
        integrationId: 'dir-1',
        corpId: 'dingcorp',
        localUser: null,
      },
      previousLocalUser: {
        id: 'user-1',
        email: 'alpha@example.com',
        name: 'Alpha',
      },
    })

    const response = await invokeRoute('post', '/accounts/:accountId/unbind', {
      params: { accountId: 'account-1' },
      user: {
        id: 'admin-1',
        role: 'admin',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.unbindDirectoryAccount).toHaveBeenCalledWith('account-1', {
      adminUserId: 'admin-1',
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unbind',
      resourceType: 'directory-account-link',
      resourceId: 'account-1',
    }))
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        account: {
          id: 'account-1',
          externalUserId: '0447654442691174',
        },
      },
    })
  })
})
