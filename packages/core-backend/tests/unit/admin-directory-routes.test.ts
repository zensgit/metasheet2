import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: {
    id: 'admin-1',
    role: 'user',
  },
}))

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
}))

const directoryMocks = vi.hoisted(() => ({
  listIntegrations: vi.fn(),
  createIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  testIntegration: vi.fn(),
  syncIntegration: vi.fn(),
  listRuns: vi.fn(),
  listActivity: vi.fn(),
  getIntegrationOperationsStatus: vi.fn(),
  getTemplateCenter: vi.fn(),
  saveTemplateCenter: vi.fn(),
  listTemplateCenterVersions: vi.fn(),
  restoreTemplateCenterVersion: vi.fn(),
  buildTemplateGovernanceReport: vi.fn(),
  listSyncAlerts: vi.fn(),
  acknowledgeSyncAlert: vi.fn(),
  listDepartments: vi.fn(),
  listAccounts: vi.fn(),
  getAccount: vi.fn(),
  linkExistingAccount: vi.fn(),
  autoLinkExistingAccountByEmail: vi.fn(),
  provisionUser: vi.fn(),
  authorizeDingTalk: vi.fn(),
  ignoreAccount: vi.fn(),
  unlinkAccount: vi.fn(),
  updateDeprovisionPolicy: vi.fn(),
  initializeSchedules: vi.fn(),
  shutdown: vi.fn(),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: (error?: unknown) => void) => {
    req.user = state.authUser as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacMocks.isAdmin,
}))

vi.mock('../../src/directory/directory-sync', () => {
  class DirectorySyncError extends Error {
    status: number
    code: string
    details?: unknown

    constructor(status: number, code: string, message: string, details?: unknown) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }

  return {
    DirectorySyncError,
    directorySyncService: directoryMocks,
  }
})

import { DirectorySyncError } from '../../src/directory/directory-sync'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    headers: {} as Record<string, string>,
    textBody: '',
    status(code: number) {
      this.statusCode = code
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = String(value)
      return this
    },
    write(chunk: unknown) {
      this.textBody += String(chunk)
      return true
    },
    end(chunk?: unknown) {
      if (chunk != null) this.textBody += String(chunk)
      this.headersSent = true
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
    headers: Record<string, string>
    textBody: string
  }
}

async function invokeRoute(
  method: 'get' | 'post' | 'patch',
  path: string,
  options: {
    query?: Record<string, unknown>
    params?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  const router = adminDirectoryRouter()
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

describe('admin-directory routes', () => {
  beforeEach(() => {
    state.authUser = {
      id: 'admin-1',
      role: 'user',
    }
    rbacMocks.isAdmin.mockReset().mockResolvedValue(true)
    directoryMocks.listIntegrations.mockReset().mockResolvedValue([])
    directoryMocks.createIntegration.mockReset()
    directoryMocks.updateIntegration.mockReset()
    directoryMocks.testIntegration.mockReset()
    directoryMocks.syncIntegration.mockReset()
    directoryMocks.listRuns.mockReset().mockResolvedValue([])
    directoryMocks.listActivity.mockReset().mockResolvedValue({
      total: 0,
      page: 1,
      pageSize: 10,
      pageCount: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      summary: {
        total: 0,
        integrationActions: 0,
        accountActions: 0,
        syncActions: 0,
        alertActions: 0,
        templateActions: 0,
      },
      items: [],
    })
    directoryMocks.getIntegrationOperationsStatus.mockReset().mockResolvedValue({
      integrationId: 'dir-1',
      syncEnabled: true,
      scheduleCron: '0 3 * * *',
      nextRunAt: '2026-03-27T03:00:00.000Z',
      lastRunStatus: 'success',
      lastRunStartedAt: '2026-03-27T00:00:00.000Z',
      lastRunFinishedAt: '2026-03-27T00:05:00.000Z',
      lastSuccessAt: '2026-03-27T00:05:00.000Z',
      lastError: null,
      alertCount: 1,
      unacknowledgedAlertCount: 1,
      lastAlertAt: '2026-03-27T00:06:00.000Z',
    })
    directoryMocks.getTemplateCenter.mockReset().mockResolvedValue({
      integrationId: 'dir-1',
      teamTemplates: {
        ticket: {
          title: '模板 A',
        },
      },
      importHistory: [],
      importPresets: {
        ticket: [],
      },
      createdBy: 'admin-1',
      updatedBy: 'admin-1',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:01:00.000Z',
    })
    directoryMocks.saveTemplateCenter.mockReset().mockResolvedValue({
      integrationId: 'dir-1',
      teamTemplates: {
        ticket: {
          title: '模板 B',
        },
      },
      importHistory: [],
      importPresets: {
        ticket: [],
      },
      createdBy: 'admin-1',
      updatedBy: 'admin-1',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:02:00.000Z',
    })
    directoryMocks.listTemplateCenterVersions.mockReset().mockResolvedValue([{
      id: 'ver-1',
      centerId: 'center-1',
      integrationId: 'dir-1',
      changeReason: 'save_team_template',
      createdBy: 'admin-1',
      createdAt: '2026-03-27T00:02:00.000Z',
      snapshotSummary: {
        outputModes: ['ticket'],
        teamTemplateCount: 1,
        importPresetCount: 0,
        importHistoryCount: 0,
      },
    }])
    directoryMocks.restoreTemplateCenterVersion.mockReset().mockResolvedValue({
      integrationId: 'dir-1',
      teamTemplates: {
        ticket: {
          title: '模板 A',
        },
      },
      importHistory: [],
      importPresets: {
        ticket: [],
      },
      createdBy: 'admin-1',
      updatedBy: 'admin-1',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:03:00.000Z',
    })
    directoryMocks.buildTemplateGovernanceReport.mockReset().mockResolvedValue({
      integrationId: 'dir-1',
      generatedAt: '2026-03-27T00:04:00.000Z',
      totals: {
        outputModes: 1,
        teamTemplates: 1,
        importPresets: 1,
        favorites: 1,
        pinned: 0,
        highFrequency: 1,
        lowFrequency: 0,
        unused: 0,
        distinctTags: 1,
      },
      tagSummary: [{
        tag: '值班',
        count: 1,
      }],
      presets: [{
        outputMode: 'ticket',
        id: 'preset-1',
        name: '值班模板',
        tags: ['值班'],
        favorite: true,
        pinned: false,
        useCount: 3,
        lastUsedAt: '2026-03-27T00:03:00.000Z',
        ignoredFieldCount: 2,
        usageBucket: 'high',
      }],
    })
    directoryMocks.listSyncAlerts.mockReset().mockResolvedValue([{
      id: 'alert-1',
      integrationId: 'dir-1',
      runId: 'run-1',
      level: 'error',
      code: 'DIRECTORY_SYNC_FAILED',
      message: '同步失败',
      details: { source: 'scheduled' },
      sentToWebhook: true,
      acknowledgedAt: null,
      acknowledgedBy: null,
      createdAt: '2026-03-27T00:06:00.000Z',
      updatedAt: '2026-03-27T00:06:00.000Z',
    }])
    directoryMocks.acknowledgeSyncAlert.mockReset().mockResolvedValue({
      id: 'alert-1',
      integrationId: 'dir-1',
      runId: 'run-1',
      level: 'error',
      code: 'DIRECTORY_SYNC_FAILED',
      message: '同步失败',
      details: { source: 'scheduled' },
      sentToWebhook: true,
      acknowledgedAt: '2026-03-27T00:07:00.000Z',
      acknowledgedBy: 'admin-1',
      createdAt: '2026-03-27T00:06:00.000Z',
      updatedAt: '2026-03-27T00:07:00.000Z',
    })
    directoryMocks.listDepartments.mockReset().mockResolvedValue([])
    directoryMocks.listAccounts.mockReset().mockResolvedValue({ total: 0, page: 1, pageSize: 20, items: [] })
    directoryMocks.getAccount.mockReset()
    directoryMocks.linkExistingAccount.mockReset()
    directoryMocks.autoLinkExistingAccountByEmail.mockReset()
    directoryMocks.provisionUser.mockReset()
    directoryMocks.authorizeDingTalk.mockReset()
    directoryMocks.ignoreAccount.mockReset()
    directoryMocks.unlinkAccount.mockReset()
    directoryMocks.updateDeprovisionPolicy.mockReset()
  })

  it('rejects non-admin requests', async () => {
    state.authUser = {
      id: 'user-2',
      role: 'user',
    }
    rbacMocks.isAdmin.mockResolvedValue(false)

    const response = await invokeRoute('get', '/api/admin/directory/integrations')

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).error.code).toBe('FORBIDDEN')
  })

  it('creates a directory integration', async () => {
    directoryMocks.createIntegration.mockResolvedValue({
      id: 'dir-1',
      name: 'DingTalk Org Sync',
      provider: 'dingtalk',
      corpId: 'corp-1',
      syncEnabled: true,
      defaultDeprovisionPolicy: ['mark_inactive'],
    })

    const response = await invokeRoute('post', '/api/admin/directory/integrations', {
      body: {
        orgId: 'default',
        name: 'DingTalk Org Sync',
        corpId: 'corp-1',
        appKey: 'app-key',
        appSecret: 'app-secret',
        captureUnboundLogins: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.createIntegration).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'default',
      name: 'DingTalk Org Sync',
      corpId: 'corp-1',
      appKey: 'app-key',
      appSecret: 'app-secret',
      captureUnboundLogins: true,
    }), 'admin-1')
    expect((response.body as Record<string, any>).data).toMatchObject({
      id: 'dir-1',
      corpId: 'corp-1',
      provider: 'dingtalk',
      syncEnabled: true,
    })
  })

  it('auto-links a directory account by exact email within the integration scope', async () => {
    directoryMocks.getAccount
      .mockResolvedValueOnce({ integrationId: 'dir-1' })
    directoryMocks.autoLinkExistingAccountByEmail.mockResolvedValue({
      id: 'acct-1',
      linkStatus: 'linked',
      matchStrategy: 'email_exact',
    })

    const response = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/accounts/:accountId/auto-link-by-email', {
      params: { integrationId: 'dir-1', accountId: 'acct-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.autoLinkExistingAccountByEmail).toHaveBeenCalledWith('acct-1', 'admin-1')
  })

  it('runs sync and returns a run record', async () => {
    directoryMocks.syncIntegration.mockResolvedValue({
      id: 'run-1',
      integrationId: 'dir-1',
      status: 'success',
      startedAt: '2026-03-25T00:00:00.000Z',
      finishedAt: '2026-03-25T00:01:00.000Z',
      stats: { accountsFetched: 5 },
    })

    const response = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/sync', {
      params: { integrationId: 'dir-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.syncIntegration).toHaveBeenCalledWith('dir-1', 'admin-1', { source: 'manual' })
    expect((response.body as Record<string, any>).data.id).toBe('run-1')
  })

  it('forwards DingTalk permission remediation details on sync failure', async () => {
    directoryMocks.syncIntegration.mockRejectedValue(new DirectorySyncError(
      502,
      'DINGTALK_PERMISSION_REQUIRED',
      '应用尚未开通所需的权限：[qyapi_get_department_list]',
      {
        provider: 'dingtalk',
        subcode: '60011',
        requiredScopes: ['qyapi_get_department_list'],
        applyUrl: 'https://open-dev.dingtalk.com/appscope/apply?content=ding33bpfsmhnrdt0clu%23qyapi_get_department_list',
      },
    ))

    const response = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/sync', {
      params: { integrationId: 'dir-1' },
    })

    expect(response.statusCode).toBe(502)
    expect((response.body as Record<string, any>).error.code).toBe('DINGTALK_PERMISSION_REQUIRED')
    expect((response.body as Record<string, any>).error.details).toEqual({
      provider: 'dingtalk',
      subcode: '60011',
      requiredScopes: ['qyapi_get_department_list'],
      applyUrl: 'https://open-dev.dingtalk.com/appscope/apply?content=ding33bpfsmhnrdt0clu%23qyapi_get_department_list',
    })
  })

  it('loads directory schedule status', async () => {
    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/schedule-status', {
      params: { integrationId: 'dir-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.getIntegrationOperationsStatus).toHaveBeenCalledWith('dir-1')
    expect((response.body as Record<string, any>).data).toMatchObject({
      integrationId: 'dir-1',
      syncEnabled: true,
      alertCount: 1,
      unacknowledgedAlertCount: 1,
    })
  })

  it('loads directory activity with filters', async () => {
    directoryMocks.listActivity.mockResolvedValue({
      total: 1,
      page: 2,
      pageSize: 5,
      pageCount: 1,
      hasNextPage: false,
      hasPreviousPage: true,
      summary: {
        total: 1,
        integrationActions: 0,
        accountActions: 1,
        syncActions: 0,
        alertActions: 0,
        templateActions: 0,
      },
      items: [{
        id: 'audit-1',
        createdAt: '2026-03-29T01:00:00.000Z',
        eventType: 'admin.directory',
        eventCategory: 'admin',
        eventSeverity: 'info',
        action: 'authorize',
        resourceType: 'directory-account',
        resourceId: 'acct-1',
        actorUserId: 'admin-1',
        actorName: '管理员',
        actorEmail: 'admin@example.com',
        actionDetails: { integrationId: 'dir-1', accountId: 'acct-1' },
        errorCode: null,
        integrationId: 'dir-1',
        integrationName: '钉钉总部目录',
        accountId: 'acct-1',
        accountName: '周华',
        accountEmail: 'zhou@example.com',
        accountExternalUserId: 'ding-user-1',
      }],
    })

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/activity', {
      params: { integrationId: 'dir-1' },
      query: {
        page: '2',
        pageSize: '5',
        q: '周华',
        action: 'authorize',
        resourceType: 'directory-account',
        accountId: 'acct-1',
        from: '2026-03-28',
        to: '2026-03-29',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listActivity).toHaveBeenCalledWith('dir-1', {
      page: 2,
      pageSize: 5,
      q: '周华',
      action: 'authorize',
      resourceType: 'directory-account',
      accountId: 'acct-1',
      from: '2026-03-28T00:00:00.000Z',
      to: '2026-03-29T23:59:59.999Z',
    })
    expect((response.body as Record<string, any>).data.items).toHaveLength(1)
  })

  it('exports directory activity csv', async () => {
    directoryMocks.listActivity.mockResolvedValue({
      total: 1,
      page: 1,
      pageSize: 20,
      pageCount: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      summary: {
        total: 1,
        integrationActions: 1,
        accountActions: 0,
        syncActions: 1,
        alertActions: 0,
        templateActions: 0,
      },
      items: [{
        id: 'audit-1',
        createdAt: '2026-03-29T01:00:00.000Z',
        eventType: 'admin.directory',
        eventCategory: 'admin',
        eventSeverity: 'info',
        action: 'sync',
        resourceType: 'directory-integration',
        resourceId: 'dir-1',
        actorUserId: 'admin-1',
        actorName: '管理员',
        actorEmail: 'admin@example.com',
        actionDetails: { integrationId: 'dir-1', source: 'manual' },
        errorCode: null,
        integrationId: 'dir-1',
        integrationName: '钉钉总部目录',
        accountId: null,
        accountName: null,
        accountEmail: null,
        accountExternalUserId: null,
      }],
    })

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/activity/export.csv', {
      params: { integrationId: 'dir-1' },
      query: { limit: '20', action: 'sync' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listActivity).toHaveBeenCalledWith('dir-1', {
      page: 1,
      pageSize: 20,
      q: null,
      action: 'sync',
      resourceType: null,
      accountId: null,
      from: null,
      to: null,
    })
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['x-export-total']).toBe('1')
    expect(response.textBody).toContain('resource_type')
    expect(response.textBody).toContain('directory-integration')
  })

  it('loads and saves the template center', async () => {
    const loadResponse = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/template-center', {
      params: { integrationId: 'dir-1' },
    })

    expect(loadResponse.statusCode).toBe(200)
    expect(directoryMocks.getTemplateCenter).toHaveBeenCalledWith('dir-1')

    const saveResponse = await invokeRoute('patch', '/api/admin/directory/integrations/:integrationId/template-center', {
      params: { integrationId: 'dir-1' },
      body: {
        teamTemplates: {
          ticket: {
            title: '模板 B',
          },
        },
        importHistory: [],
        importPresets: {
          ticket: [],
        },
        changeReason: 'save_team_template',
      },
    })

    expect(saveResponse.statusCode).toBe(200)
    expect(directoryMocks.saveTemplateCenter).toHaveBeenCalledWith('dir-1', {
      teamTemplates: {
        ticket: {
          title: '模板 B',
        },
      },
      importHistory: [],
      importPresets: {
        ticket: [],
      },
      changeReason: 'save_team_template',
    }, 'admin-1')
  })

  it('lists template center versions and restores a selected version', async () => {
    const versionsResponse = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/template-center/versions', {
      params: { integrationId: 'dir-1' },
      query: { limit: '8' },
    })

    expect(versionsResponse.statusCode).toBe(200)
    expect(directoryMocks.listTemplateCenterVersions).toHaveBeenCalledWith('dir-1', 8)
    expect((versionsResponse.body as Record<string, any>).data.items).toHaveLength(1)

    const restoreResponse = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/template-center/versions/:versionId/restore', {
      params: { integrationId: 'dir-1', versionId: 'ver-1' },
    })

    expect(restoreResponse.statusCode).toBe(200)
    expect(directoryMocks.restoreTemplateCenterVersion).toHaveBeenCalledWith('dir-1', 'ver-1', 'admin-1')
  })

  it('returns governance report json and csv', async () => {
    const jsonResponse = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/template-center/report', {
      params: { integrationId: 'dir-1' },
    })

    expect(jsonResponse.statusCode).toBe(200)
    expect(directoryMocks.buildTemplateGovernanceReport).toHaveBeenCalledWith('dir-1')
    expect((jsonResponse.body as Record<string, any>).data.totals.importPresets).toBe(1)

    const csvResponse = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/template-center/report.csv', {
      params: { integrationId: 'dir-1' },
    })

    expect(csvResponse.statusCode).toBe(200)
    expect(csvResponse.headers['content-type']).toContain('text/csv')
    expect(csvResponse.headers['content-disposition']).toContain('directory-template-governance-dir-1-')
    expect(csvResponse.textBody).toContain('output_mode,preset_id,name,tags,favorite,pinned,use_count,last_used_at,ignored_field_count,usage_bucket')
    expect(csvResponse.textBody).toContain('preset-1')
    expect(csvResponse.textBody).toContain('值班模板')
  })

  it('lists and acknowledges sync alerts', async () => {
    const alertsResponse = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/alerts', {
      params: { integrationId: 'dir-1' },
      query: { limit: '8' },
    })

    expect(alertsResponse.statusCode).toBe(200)
    expect(directoryMocks.listSyncAlerts).toHaveBeenCalledWith('dir-1', 8)
    expect((alertsResponse.body as Record<string, any>).data.items).toHaveLength(1)

    const ackResponse = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/alerts/:alertId/ack', {
      params: { integrationId: 'dir-1', alertId: 'alert-1' },
    })

    expect(ackResponse.statusCode).toBe(200)
    expect(directoryMocks.acknowledgeSyncAlert).toHaveBeenCalledWith('dir-1', 'alert-1', 'admin-1')
    expect((ackResponse.body as Record<string, any>).data).toMatchObject({
      id: 'alert-1',
      acknowledgedBy: 'admin-1',
    })
  })

  it('allows blank email for provision-user so the service can generate a placeholder email', async () => {
    directoryMocks.getAccount.mockResolvedValue({
      id: 'acct-1',
      integrationId: 'dir-1',
    })
    directoryMocks.provisionUser.mockResolvedValue({
      user: {
        email: '0357574763363730830@dingtalk.local',
      },
      temporaryPassword: 'Temp#20260325',
    })

    const response = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/accounts/:accountId/provision-user', {
      params: { integrationId: 'dir-1', accountId: 'acct-1' },
      body: { email: '', authorizeDingTalk: true },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.provisionUser).toHaveBeenCalledWith('acct-1', {
      email: '',
      name: undefined,
      password: undefined,
      authorizeDingTalk: true,
      isActive: undefined,
    }, 'admin-1')
    expect((response.body as Record<string, any>).data.user.email).toBe('0357574763363730830@dingtalk.local')
  })

  it('authorizes dingtalk login for a linked account', async () => {
    directoryMocks.getAccount.mockResolvedValue({
      id: 'acct-1',
      integrationId: 'dir-1',
    })
    directoryMocks.authorizeDingTalk.mockResolvedValue({
      id: 'acct-1',
      dingtalkAuthEnabled: true,
    })

    const response = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/accounts/:accountId/authorize-dingtalk', {
      params: { integrationId: 'dir-1', accountId: 'acct-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.authorizeDingTalk).toHaveBeenCalledWith('acct-1', 'admin-1', true)
    expect((response.body as Record<string, any>).data.dingtalkAuthEnabled).toBe(true)
  })

  it('updates deprovision policy override', async () => {
    directoryMocks.getAccount.mockResolvedValue({
      id: 'acct-1',
      integrationId: 'dir-1',
    })
    directoryMocks.updateDeprovisionPolicy.mockResolvedValue({
      id: 'acct-1',
      deprovisionPolicyOverride: ['disable_dingtalk_auth', 'disable_local_user'],
    })

    const response = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/accounts/:accountId/deprovision-policy', {
      params: { integrationId: 'dir-1', accountId: 'acct-1' },
      body: { policy: ['disable_dingtalk_auth', 'disable_local_user'] },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.updateDeprovisionPolicy).toHaveBeenCalledWith('acct-1', ['disable_dingtalk_auth', 'disable_local_user'], 'admin-1')
    expect((response.body as Record<string, any>).data.deprovisionPolicyOverride).toEqual(['disable_dingtalk_auth', 'disable_local_user'])
  })

  it('rejects integration-scoped operations when account does not belong to the integration', async () => {
    directoryMocks.getAccount.mockResolvedValue({
      id: 'acct-1',
      integrationId: 'dir-other',
    })

    const response = await invokeRoute('post', '/api/admin/directory/integrations/:integrationId/accounts/:accountId/provision-user', {
      params: {
        integrationId: 'dir-1',
        accountId: 'acct-1',
      },
      body: {},
    })

    expect(response.statusCode).toBe(404)
    expect((response.body as Record<string, any>).error.code).toBe('DIRECTORY_ACCOUNT_NOT_FOUND')
    expect(directoryMocks.provisionUser).not.toHaveBeenCalled()
  })

  it('lists directory accounts with filters', async () => {
    directoryMocks.listAccounts.mockResolvedValue({
      total: 1,
      page: 1,
      pageSize: 20,
      pageCount: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      summary: {
        linked: 0,
        pending: 1,
        conflict: 0,
        ignored: 0,
        active: 1,
        inactive: 0,
        dingtalkAuthEnabled: 0,
        dingtalkAuthDisabled: 1,
        bound: 0,
        unbound: 1,
      },
      items: [{ id: 'acct-1', linkStatus: 'pending' }],
    })

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/accounts', {
      params: { integrationId: 'dir-1' },
      query: { q: 'zhou', linkStatus: 'pending', isActive: 'true' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listAccounts).toHaveBeenCalledWith('dir-1', {
      page: 1,
      pageSize: 20,
      q: 'zhou',
      linkStatus: 'pending',
      isActive: true,
      matchStrategy: null,
      dingtalkAuthEnabled: null,
      isBound: null,
      departmentId: null,
    })
    expect((response.body as Record<string, any>).data.total).toBe(1)
  })

  it('passes advanced directory account filters to the service layer', async () => {
    directoryMocks.listAccounts.mockResolvedValue({
      total: 4,
      page: 2,
      pageSize: 50,
      pageCount: 1,
      hasNextPage: false,
      hasPreviousPage: true,
      summary: {
        linked: 2,
        pending: 1,
        conflict: 1,
        ignored: 0,
        active: 4,
        inactive: 0,
        dingtalkAuthEnabled: 2,
        dingtalkAuthDisabled: 2,
        bound: 1,
        unbound: 3,
      },
      items: [],
    })

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/accounts', {
      params: { integrationId: 'dir-1' },
      query: {
        page: '2',
        pageSize: '50',
        matchStrategy: 'email_exact',
        dingtalkAuthEnabled: 'false',
        isBound: 'true',
        departmentId: 'dep-1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listAccounts).toHaveBeenCalledWith('dir-1', {
      page: 2,
      pageSize: 50,
      q: null,
      linkStatus: null,
      isActive: null,
      matchStrategy: 'email_exact',
      dingtalkAuthEnabled: false,
      isBound: true,
      departmentId: 'dep-1',
    })
  })

  it('exports filtered directory accounts as csv', async () => {
    directoryMocks.listAccounts.mockResolvedValue({
      total: 1,
      page: 1,
      pageSize: 100,
      pageCount: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      summary: {
        linked: 1,
        pending: 0,
        conflict: 0,
        ignored: 0,
        active: 1,
        inactive: 0,
        dingtalkAuthEnabled: 1,
        dingtalkAuthDisabled: 0,
        bound: 1,
        unbound: 0,
      },
      items: [{
        externalUserId: 'ding-user-1',
        name: 'Zhou',
        nick: 'Z',
        email: 'zhou@example.com',
        mobile: '13800000000',
        jobNumber: 'E001',
        title: 'Engineer',
        linkStatus: 'linked',
        matchStrategy: 'manual',
        dingtalkAuthEnabled: true,
        isBound: true,
        isActive: true,
        linkedUser: { id: 'user-1', email: 'zhou@example.com', name: 'Zhou' },
        effectiveDeprovisionPolicy: ['mark_inactive'],
        departmentNames: ['研发中心'],
        reviewNote: 'linked manually',
      }],
    })

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/accounts/export.csv', {
      params: { integrationId: 'dir-1' },
      query: { matchStrategy: 'manual', dingtalkAuthEnabled: 'true', limit: '5000' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listAccounts).toHaveBeenCalledWith('dir-1', {
      page: 1,
      pageSize: 100,
      q: null,
      linkStatus: null,
      isActive: null,
      matchStrategy: 'manual',
      dingtalkAuthEnabled: true,
      isBound: null,
      departmentId: null,
    })
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['x-export-total']).toBe('1')
    expect(response.textBody).toContain('external_user_id,name,nick,email')
    expect(response.textBody).toContain('ding-user-1')
    expect(response.textBody).toContain('zhou@example.com')
  })

  it('exports directory accounts across pages, escapes csv cells, and marks truncation headers', async () => {
    directoryMocks.listAccounts
      .mockResolvedValueOnce({
        total: 3,
        page: 1,
        pageSize: 2,
        pageCount: 2,
        hasNextPage: true,
        hasPreviousPage: false,
        summary: {
          linked: 2,
          pending: 1,
          conflict: 0,
          ignored: 0,
          active: 3,
          inactive: 0,
          dingtalkAuthEnabled: 2,
          dingtalkAuthDisabled: 1,
          bound: 2,
          unbound: 1,
        },
        items: [{
          externalUserId: 'ding-user-1',
          name: 'Zhou, "A"\nLead',
          nick: 'Z',
          email: 'zhou@example.com',
          mobile: '13800000000',
          jobNumber: 'E001',
          title: 'Engineer',
          linkStatus: 'linked',
          matchStrategy: 'manual',
          dingtalkAuthEnabled: true,
          isBound: true,
          isActive: true,
          linkedUser: { id: 'user-1', email: 'zhou@example.com', name: 'Zhou' },
          effectiveDeprovisionPolicy: ['mark_inactive'],
          departmentNames: ['研发中心'],
          reviewNote: 'line1\nline2',
        }],
      })
      .mockResolvedValueOnce({
        total: 3,
        page: 2,
        pageSize: 1,
        pageCount: 3,
        hasNextPage: true,
        hasPreviousPage: true,
        summary: {
          linked: 2,
          pending: 1,
          conflict: 0,
          ignored: 0,
          active: 3,
          inactive: 0,
          dingtalkAuthEnabled: 2,
          dingtalkAuthDisabled: 1,
          bound: 2,
          unbound: 1,
        },
        items: [{
          externalUserId: 'ding-user-2',
          name: 'Li',
          nick: 'L',
          email: 'li@example.com',
          mobile: '13900000000',
          jobNumber: 'E002',
          title: 'PM',
          linkStatus: 'pending',
          matchStrategy: 'email_exact',
          dingtalkAuthEnabled: false,
          isBound: false,
          isActive: true,
          linkedUser: null,
          effectiveDeprovisionPolicy: ['mark_inactive'],
          departmentNames: ['产品中心'],
          reviewNote: '',
        }],
      })

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/accounts/export.csv', {
      params: { integrationId: 'dir-1' },
      query: { q: '研发中心', limit: '2' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listAccounts).toHaveBeenNthCalledWith(1, 'dir-1', {
      page: 1,
      pageSize: 2,
      q: '研发中心',
      linkStatus: null,
      isActive: null,
      matchStrategy: null,
      dingtalkAuthEnabled: null,
      isBound: null,
      departmentId: null,
    })
    expect(directoryMocks.listAccounts).toHaveBeenNthCalledWith(2, 'dir-1', {
      page: 2,
      pageSize: 1,
      q: '研发中心',
      linkStatus: null,
      isActive: null,
      matchStrategy: null,
      dingtalkAuthEnabled: null,
      isBound: null,
      departmentId: null,
    })
    expect(response.headers['x-export-total']).toBe('3')
    expect(response.headers['x-export-returned']).toBe('2')
    expect(response.headers['x-export-truncated']).toBe('true')
    expect(response.textBody).toContain('"Zhou, ""A""\nLead"')
    expect(response.textBody).toContain('"line1\nline2"')
    expect(response.textBody).toContain('ding-user-2')
  })

  it('clamps invalid export limit to at least one row', async () => {
    directoryMocks.listAccounts.mockResolvedValue({
      total: 2,
      page: 1,
      pageSize: 1,
      pageCount: 2,
      hasNextPage: true,
      hasPreviousPage: false,
      summary: {
        linked: 1,
        pending: 1,
        conflict: 0,
        ignored: 0,
        active: 2,
        inactive: 0,
        dingtalkAuthEnabled: 1,
        dingtalkAuthDisabled: 1,
        bound: 1,
        unbound: 1,
      },
      items: [{
        externalUserId: 'ding-user-1',
        name: 'Zhou',
        nick: 'Z',
        email: 'zhou@example.com',
        mobile: '13800000000',
        jobNumber: 'E001',
        title: 'Engineer',
        linkStatus: 'linked',
        matchStrategy: 'manual',
        dingtalkAuthEnabled: true,
        isBound: true,
        isActive: true,
        linkedUser: { id: 'user-1', email: 'zhou@example.com', name: 'Zhou' },
        effectiveDeprovisionPolicy: ['mark_inactive'],
        departmentNames: ['研发中心'],
        reviewNote: '',
      }],
    })

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/accounts/export.csv', {
      params: { integrationId: 'dir-1' },
      query: { limit: '0' },
    })

    expect(response.statusCode).toBe(200)
    expect(directoryMocks.listAccounts).toHaveBeenCalledWith('dir-1', {
      page: 1,
      pageSize: 1,
      q: null,
      linkStatus: null,
      isActive: null,
      matchStrategy: null,
      dingtalkAuthEnabled: null,
      isBound: null,
      departmentId: null,
    })
    expect(response.headers['x-export-returned']).toBe('1')
    expect(response.headers['x-export-truncated']).toBe('true')
  })

  it('returns a structured error when csv export fails', async () => {
    directoryMocks.listAccounts.mockRejectedValue(new Error('export failed'))

    const response = await invokeRoute('get', '/api/admin/directory/integrations/:integrationId/accounts/export.csv', {
      params: { integrationId: 'dir-1' },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).error.code).toBe('DIRECTORY_ACCOUNTS_EXPORT_FAILED')
  })
})
