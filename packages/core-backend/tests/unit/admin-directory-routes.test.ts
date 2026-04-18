import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rbacMocks = vi.hoisted(() => ({
  isRbacAdmin: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}))

const directoryMocks = vi.hoisted(() => ({
  acknowledgeDirectorySyncAlert: vi.fn(),
  admitDirectoryAccountUser: vi.fn(),
  batchBindDirectoryAccounts: vi.fn(),
  batchUnbindDirectoryAccounts: vi.fn(),
  bindDirectoryAccount: vi.fn(),
  createDirectoryIntegration: vi.fn(),
  getDirectorySyncScheduleSnapshot: vi.fn(),
  getDirectoryAccountSummary: vi.fn(),
  getDirectoryReviewItem: vi.fn(),
  listDirectoryIntegrationAccounts: vi.fn(),
  listDirectoryIntegrations: vi.fn(),
  listDirectoryReviewItems: vi.fn(),
  listDirectorySyncAlerts: vi.fn(),
  listDirectorySyncRuns: vi.fn(),
  syncDirectoryIntegration: vi.fn(),
  testDirectoryIntegration: vi.fn(),
  unbindDirectoryAccount: vi.fn(),
  updateDirectoryIntegration: vi.fn(),
}))

const schedulerMocks = vi.hoisted(() => ({
  refreshDirectoryIntegrationSchedule: vi.fn(),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isRbacAdmin,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: auditMocks.auditLog,
}))

vi.mock('../../src/directory/directory-sync', () => ({
  acknowledgeDirectorySyncAlert: directoryMocks.acknowledgeDirectorySyncAlert,
  admitDirectoryAccountUser: directoryMocks.admitDirectoryAccountUser,
  batchBindDirectoryAccounts: directoryMocks.batchBindDirectoryAccounts,
  batchUnbindDirectoryAccounts: directoryMocks.batchUnbindDirectoryAccounts,
  bindDirectoryAccount: directoryMocks.bindDirectoryAccount,
  createDirectoryIntegration: directoryMocks.createDirectoryIntegration,
  getDirectorySyncScheduleSnapshot: directoryMocks.getDirectorySyncScheduleSnapshot,
  getDirectoryAccountSummary: directoryMocks.getDirectoryAccountSummary,
  getDirectoryReviewItem: directoryMocks.getDirectoryReviewItem,
  listDirectoryIntegrationAccounts: directoryMocks.listDirectoryIntegrationAccounts,
  listDirectoryIntegrations: directoryMocks.listDirectoryIntegrations,
  listDirectoryReviewItems: directoryMocks.listDirectoryReviewItems,
  listDirectorySyncAlerts: directoryMocks.listDirectorySyncAlerts,
  listDirectorySyncRuns: directoryMocks.listDirectorySyncRuns,
  syncDirectoryIntegration: directoryMocks.syncDirectoryIntegration,
  testDirectoryIntegration: directoryMocks.testDirectoryIntegration,
  unbindDirectoryAccount: directoryMocks.unbindDirectoryAccount,
  updateDirectoryIntegration: directoryMocks.updateDirectoryIntegration,
}))

vi.mock('../../src/directory/directory-sync-scheduler', () => ({
  refreshDirectoryIntegrationSchedule: schedulerMocks.refreshDirectoryIntegrationSchedule,
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
    directoryMocks.acknowledgeDirectorySyncAlert.mockReset()
    directoryMocks.admitDirectoryAccountUser.mockReset()
    directoryMocks.batchBindDirectoryAccounts.mockReset()
    directoryMocks.batchUnbindDirectoryAccounts.mockReset()
    directoryMocks.bindDirectoryAccount.mockReset()
    directoryMocks.createDirectoryIntegration.mockReset()
    directoryMocks.getDirectorySyncScheduleSnapshot.mockReset()
    directoryMocks.getDirectoryAccountSummary.mockReset()
    directoryMocks.getDirectoryReviewItem.mockReset()
    directoryMocks.listDirectoryIntegrationAccounts.mockReset()
    directoryMocks.listDirectoryIntegrations.mockReset()
    directoryMocks.listDirectoryReviewItems.mockReset()
    directoryMocks.listDirectorySyncAlerts.mockReset()
    directoryMocks.listDirectorySyncRuns.mockReset()
    directoryMocks.syncDirectoryIntegration.mockReset()
    directoryMocks.testDirectoryIntegration.mockReset()
    directoryMocks.unbindDirectoryAccount.mockReset()
    directoryMocks.updateDirectoryIntegration.mockReset()
    schedulerMocks.refreshDirectoryIntegrationSchedule.mockReset()
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
    directoryMocks.listDirectoryIntegrations.mockResolvedValue([{ id: 'dir-1', name: 'DingTalk CN' }])

    const response = await invokeRoute('get', '/integrations', {
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listDirectoryIntegrations).toHaveBeenCalledTimes(1)
    expect(response.body).toMatchObject({
      ok: true,
      data: { items: [{ id: 'dir-1', name: 'DingTalk CN' }] },
    })
  })

  it('refreshes scheduler state after creating an integration', async () => {
    directoryMocks.createDirectoryIntegration.mockResolvedValue({ id: 'dir-1', name: 'DingTalk CN' })

    const payload = {
      name: 'DingTalk CN',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      appSecret: 'secret',
      syncEnabled: true,
      scheduleCron: '*/15 * * * *',
      memberGroupDefaultRoleIds: ['crm_user'],
      memberGroupDefaultNamespaces: ['crm'],
    }

    const response = await invokeRoute('post', '/integrations', {
      body: payload,
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.createDirectoryIntegration).toHaveBeenCalledWith(payload)
    expect(schedulerMocks.refreshDirectoryIntegrationSchedule).toHaveBeenCalledWith('dir-1')
  })

  it('refreshes scheduler state after updating an integration', async () => {
    directoryMocks.updateDirectoryIntegration.mockResolvedValue({ id: 'dir-1', name: 'DingTalk CN' })

    const payload = {
      name: 'DingTalk CN',
      scheduleCron: '*/10 * * * *',
      syncEnabled: true,
      memberGroupDefaultRoleIds: ['crm_user'],
      memberGroupDefaultNamespaces: ['crm'],
    }

    const response = await invokeRoute('put', '/integrations/:integrationId', {
      params: { integrationId: 'dir-1' },
      body: payload,
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.updateDirectoryIntegration).toHaveBeenCalledWith('dir-1', payload)
    expect(schedulerMocks.refreshDirectoryIntegrationSchedule).toHaveBeenCalledWith('dir-1')
  })

  it('delegates sync to the directory service and returns its payload', async () => {
    directoryMocks.syncDirectoryIntegration.mockResolvedValue({
      integration: { id: 'dir-1', name: 'DingTalk CN' },
      run: { id: 'run-1', status: 'completed' },
      autoAdmissionOnboardingPackets: [
        {
          userId: 'user-1',
          name: '林岚',
          email: null,
          username: 'dt_linlan_12345678',
          mobile: '13900001234',
          temporaryPassword: 'Tmp-123',
          onboarding: {
            accountLabel: 'dt_linlan_12345678',
            acceptInviteUrl: '',
            inviteMessage: '账号：dt_linlan_12345678',
          },
        },
      ],
    })

    const response = await invokeRoute('post', '/integrations/:integrationId/sync', {
      params: { integrationId: 'dir-1' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.syncDirectoryIntegration).toHaveBeenCalledWith('dir-1', 'admin-1')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        integration: { id: 'dir-1' },
        run: { id: 'run-1', status: 'completed' },
        autoAdmissionOnboardingPackets: [
          {
            userId: 'user-1',
            username: 'dt_linlan_12345678',
            temporaryPassword: 'Tmp-123',
          },
        ],
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
      sampledUsers: [{ userId: '0447654442691174', name: '林岚' }],
      diagnostics: {
        rootDepartmentChildCount: 0,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
        rootDepartmentDirectUserCountWithAccessLimit: 1,
        rootDepartmentDirectUserHasMoreWithAccessLimit: false,
        sampledRootDepartmentUsers: [{ userId: '0447654442691174', name: '林岚' }],
        sampledRootDepartmentUsersWithAccessLimit: [{ userId: '0447654442691174', name: '林岚' }],
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
      user: { id: 'admin-1', role: 'admin' },
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
      user: { id: 'user-2', role: 'user' },
    })

    expect(response.statusCode).toBe(200)
    expect(rbacMocks.isRbacAdmin).toHaveBeenCalledWith('user-2')
    expect(directoryMocks.listDirectorySyncRuns).toHaveBeenCalledWith('dir-1', { limit: 10, offset: 0 })
  })

  it('returns the directory sync schedule snapshot', async () => {
    directoryMocks.getDirectorySyncScheduleSnapshot.mockResolvedValue({
      integrationId: 'dir-1',
      syncEnabled: true,
      scheduleCron: '*/15 * * * *',
      cronValid: true,
      nextExpectedRunAt: '2026-04-14T01:15:00.000Z',
      lastRun: null,
      lastManualRun: null,
      lastAutomaticRun: null,
      observationStatus: 'awaiting_first_run',
      observationMessage: '已配置 cron，等待首次自动触发或尚未观察到调度执行。',
    })

    const response = await invokeRoute('get', '/integrations/:integrationId/schedule', {
      params: { integrationId: 'dir-1' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.getDirectorySyncScheduleSnapshot).toHaveBeenCalledWith('dir-1')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          integrationId: 'dir-1',
          observationStatus: 'awaiting_first_run',
        },
      },
    })
  })

  it('lists directory sync alerts for an integration', async () => {
    directoryMocks.listDirectorySyncAlerts.mockResolvedValue({
      items: [
        {
          id: 'alert-1',
          integrationId: 'dir-1',
          runId: 'run-1',
          level: 'warning',
          code: 'root_department_sparse',
          message: '根部门直属成员过少',
          details: {},
          sentToWebhook: false,
          acknowledgedAt: null,
          acknowledgedBy: null,
          createdAt: '2026-04-14T01:00:00.000Z',
          updatedAt: '2026-04-14T01:00:00.000Z',
        },
      ],
      total: 1,
    })

    const response = await invokeRoute('get', '/integrations/:integrationId/alerts', {
      params: { integrationId: 'dir-1' },
      query: { page: '1', pageSize: '20', filter: 'pending' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listDirectorySyncAlerts).toHaveBeenCalledWith('dir-1', { limit: 20, offset: 0 }, 'pending')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        filter: 'pending',
        total: 1,
      },
    })
  })

  it('lists directory review items for an integration', async () => {
    directoryMocks.listDirectoryReviewItems.mockResolvedValue({
      items: [
        {
          kind: 'inactive_linked',
          reason: '目录成员已停用，但仍绑定本地用户，需要停权处理。',
          account: {
            id: 'account-1',
            integrationId: 'dir-1',
            externalUserId: '0447654442691174',
            name: '林岚',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
            },
          },
          flags: {
            missingUnionId: false,
            missingOpenId: false,
          },
          actionable: {
            canBatchUnbind: true,
          },
        },
      ],
      total: 1,
    })

    const response = await invokeRoute('get', '/integrations/:integrationId/review-items', {
      params: { integrationId: 'dir-1' },
      query: { page: '1', pageSize: '100', filter: 'inactive_linked' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listDirectoryReviewItems).toHaveBeenCalledWith(
      'dir-1',
      { limit: 100, offset: 0 },
      'inactive_linked',
    )
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        filter: 'inactive_linked',
        total: 1,
      },
    })
  })

  it('lists directory accounts for an integration', async () => {
    directoryMocks.listDirectoryIntegrationAccounts.mockResolvedValue({
      items: [{ id: 'account-1', externalUserId: '0447654442691174' }],
      total: 1,
    })

    const response = await invokeRoute('get', '/integrations/:integrationId/accounts', {
      params: { integrationId: 'dir-1' },
      query: { page: '1', pageSize: '50', q: '0447' },
      user: { id: 'admin-1', role: 'admin' },
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

  it('returns a single directory account summary', async () => {
    directoryMocks.getDirectoryAccountSummary.mockResolvedValue({
      id: 'account-1',
      integrationId: 'dir-1',
      name: '林岚',
    })

    const response = await invokeRoute('get', '/accounts/:accountId', {
      params: { accountId: 'account-1' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.getDirectoryAccountSummary).toHaveBeenCalledWith('account-1')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        account: {
          id: 'account-1',
          integrationId: 'dir-1',
          name: '林岚',
        },
      },
    })
  })

  it('returns 400 when a single directory account lookup is missing accountId', async () => {
    directoryMocks.getDirectoryAccountSummary.mockRejectedValue(new Error('accountId is required'))

    const response = await invokeRoute('get', '/accounts/:accountId', {
      params: { accountId: '   ' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'DIRECTORY_ACCOUNT_FAILED',
        message: 'accountId is required',
      },
    })
  })

  it('returns a single directory review item', async () => {
    directoryMocks.getDirectoryReviewItem.mockResolvedValue({
      kind: 'pending_binding',
      reason: '目录成员当前不是已确认绑定状态，建议复核。',
      account: {
        id: 'account-1',
        integrationId: 'dir-1',
        name: '林岚',
      },
      recommendations: [],
      recommendationStatus: {
        code: 'no_exact_match',
        message: '未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。',
      },
      flags: {
        missingUnionId: false,
        missingOpenId: false,
      },
      actionable: {
        canBatchUnbind: false,
        canConfirmRecommendation: false,
      },
    })

    const response = await invokeRoute('get', '/accounts/:accountId/review-item', {
      params: { accountId: 'account-1' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.getDirectoryReviewItem).toHaveBeenCalledWith('account-1')
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        item: {
          kind: 'pending_binding',
          account: {
            id: 'account-1',
          },
        },
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
      user: { id: 'admin-1', role: 'admin' },
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

  it('creates a local user and binds the directory account through manual admission', async () => {
    directoryMocks.admitDirectoryAccountUser.mockResolvedValue({
      account: {
        id: 'account-1',
        integrationId: 'dir-1',
        corpId: 'dingcorp',
        externalUserId: '0447654442691174',
        localUser: {
          id: 'user-created',
          email: 'liqing@example.com',
          name: '李青',
        },
      },
      previousLocalUser: null,
      user: {
        id: 'user-created',
        email: 'liqing@example.com',
        name: '李青',
        mobile: '13900001234',
        role: 'user',
        is_active: true,
      },
      temporaryPassword: 'Temp#123456',
      inviteToken: 'invite-token-fixed',
      onboarding: {
        acceptInviteUrl: 'https://example.com/invite/abc',
        inviteMessage: '请使用邀请链接加入平台',
      },
    })

    const response = await invokeRoute('post', '/accounts/:accountId/admit-user', {
      params: { accountId: 'account-1' },
      body: {
        name: '李青',
        email: 'liqing@example.com',
        mobile: '13900001234',
        enableDingTalkGrant: true,
      },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.admitDirectoryAccountUser).toHaveBeenCalledWith('account-1', {
      adminUserId: 'admin-1',
      name: '李青',
      email: 'liqing@example.com',
      mobile: '13900001234',
      password: '',
      enableDingTalkGrant: true,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        account: {
          id: 'account-1',
        },
        user: {
          id: 'user-created',
          email: 'liqing@example.com',
        },
        temporaryPassword: 'Temp#123456',
        inviteToken: 'invite-token-fixed',
      },
    })
  })

  it('supports manual admission without email when username or mobile is provided', async () => {
    directoryMocks.admitDirectoryAccountUser.mockResolvedValue({
      account: {
        id: 'account-1',
        integrationId: 'dir-1',
        corpId: 'dingcorp',
        externalUserId: '0447654442691174',
        localUser: {
          id: 'user-created',
          email: null,
          username: 'liqing',
          name: '李青',
        },
      },
      previousLocalUser: null,
      user: {
        id: 'user-created',
        email: null,
        username: 'liqing',
        name: '李青',
        mobile: '13900001234',
        role: 'user',
        is_active: true,
      },
      temporaryPassword: 'Temp#123456',
      inviteToken: null,
      onboarding: {
        accountLabel: 'liqing',
        acceptInviteUrl: '',
        inviteMessage: '账号：liqing',
      },
    })

    const response = await invokeRoute('post', '/accounts/:accountId/admit-user', {
      params: { accountId: 'account-1' },
      body: {
        name: '李青',
        username: 'liqing',
        mobile: '13900001234',
        enableDingTalkGrant: true,
      },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.admitDirectoryAccountUser).toHaveBeenCalledWith('account-1', {
      adminUserId: 'admin-1',
      name: '李青',
      email: '',
      username: 'liqing',
      mobile: '13900001234',
      password: '',
      enableDingTalkGrant: true,
    })
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        user: {
          id: 'user-created',
          email: null,
          username: 'liqing',
        },
        inviteToken: null,
      },
    })
  })

  it('batch binds directory accounts', async () => {
    directoryMocks.batchBindDirectoryAccounts.mockResolvedValue([
      {
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
      },
      {
        account: {
          id: 'account-2',
          integrationId: 'dir-1',
          corpId: 'dingcorp',
          externalUserId: '0447654442691175',
          localUser: {
            id: 'user-2',
            email: 'beta@example.com',
          },
        },
        previousLocalUser: null,
      },
    ])

    const response = await invokeRoute('post', '/accounts/batch-bind', {
      body: {
        bindings: [
          {
            accountId: 'account-1',
            localUserRef: 'alpha@example.com',
            enableDingTalkGrant: true,
          },
          {
            accountId: 'account-2',
            localUserRef: 'beta@example.com',
            enableDingTalkGrant: false,
          },
        ],
      },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.batchBindDirectoryAccounts).toHaveBeenCalledWith([
      {
        accountId: 'account-1',
        localUserRef: 'alpha@example.com',
        enableDingTalkGrant: true,
      },
      {
        accountId: 'account-2',
        localUserRef: 'beta@example.com',
        enableDingTalkGrant: false,
      },
    ], {
      adminUserId: 'admin-1',
    })
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        items: [
          { id: 'account-1' },
          { id: 'account-2' },
        ],
      },
    })
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
      body: { disableDingTalkGrant: true },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.unbindDirectoryAccount).toHaveBeenCalledWith('account-1', {
      adminUserId: 'admin-1',
      disableDingTalkGrant: true,
    })
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unbind',
      resourceType: 'directory-account-link',
      resourceId: 'account-1',
      meta: expect.objectContaining({
        disableDingTalkGrant: true,
      }),
    }))
  })

  it('batch unbinds directory accounts', async () => {
    directoryMocks.batchUnbindDirectoryAccounts.mockResolvedValue([
      {
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
      },
      {
        account: {
          id: 'account-2',
          externalUserId: '0447654442691175',
          integrationId: 'dir-1',
          corpId: 'dingcorp',
          localUser: null,
        },
        previousLocalUser: {
          id: 'user-2',
          email: 'beta@example.com',
          name: 'Beta',
        },
      },
    ])

    const response = await invokeRoute('post', '/accounts/batch-unbind', {
      body: {
        accountIds: ['account-1', 'account-2'],
        disableDingTalkGrant: true,
      },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.batchUnbindDirectoryAccounts).toHaveBeenCalledWith(
      ['account-1', 'account-2'],
      {
        adminUserId: 'admin-1',
        disableDingTalkGrant: true,
      },
    )
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(2)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        items: [
          { id: 'account-1' },
          { id: 'account-2' },
        ],
      },
    })
  })

  it('acknowledges a directory sync alert', async () => {
    directoryMocks.acknowledgeDirectorySyncAlert.mockResolvedValue({
      id: 'alert-1',
      integrationId: 'dir-1',
      runId: 'run-1',
      level: 'warning',
      code: 'root_department_sparse',
      message: '根部门直属成员过少',
      details: {},
      sentToWebhook: false,
      acknowledgedAt: '2026-04-14T01:10:00.000Z',
      acknowledgedBy: 'admin-1',
      createdAt: '2026-04-14T01:00:00.000Z',
      updatedAt: '2026-04-14T01:10:00.000Z',
    })

    const response = await invokeRoute('post', '/alerts/:alertId/ack', {
      params: { alertId: 'alert-1' },
      user: { id: 'admin-1', role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.acknowledgeDirectorySyncAlert).toHaveBeenCalledWith('alert-1', 'admin-1')
    expect(auditMocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'acknowledge',
      resourceType: 'directory-sync-alert',
      resourceId: 'alert-1',
    }))
  })
})
