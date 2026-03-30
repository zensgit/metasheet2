import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const schedulerMocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  schedule: vi.fn(),
  unschedule: vi.fn(),
  destroy: vi.fn(),
}))

const externalIdentityMocks = vi.hoisted(() => ({
  findExternalIdentityByProviderAndKey: vi.fn(),
  upsertExternalIdentity: vi.fn(),
}))

const authGrantMocks = vi.hoisted(() => ({
  upsertUserExternalAuthGrant: vi.fn(),
  isUserExternalAuthEnabled: vi.fn(),
}))

const passwordMocks = vi.hoisted(() => ({
  validatePassword: vi.fn(),
}))

const bcryptMocks = vi.hoisted(() => ({
  hash: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: queryMocks.query,
  transaction: queryMocks.transaction,
}))

vi.mock('../../src/services/SchedulerService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/SchedulerService')>('../../src/services/SchedulerService')
  return {
    ...actual,
    SchedulerServiceImpl: vi.fn().mockImplementation(() => schedulerMocks),
  }
})

vi.mock('../../src/auth/external-identities', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/external-identities')>('../../src/auth/external-identities')
  return {
    ...actual,
    findExternalIdentityByProviderAndKey: externalIdentityMocks.findExternalIdentityByProviderAndKey,
    upsertExternalIdentity: externalIdentityMocks.upsertExternalIdentity,
  }
})

vi.mock('../../src/auth/external-auth-grants', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/external-auth-grants')>('../../src/auth/external-auth-grants')
  return {
    ...actual,
    isUserExternalAuthEnabled: authGrantMocks.isUserExternalAuthEnabled,
    upsertUserExternalAuthGrant: authGrantMocks.upsertUserExternalAuthGrant,
  }
})

vi.mock('../../src/auth/password-policy', () => ({
  validatePassword: passwordMocks.validatePassword,
}))

vi.mock('bcryptjs', () => bcryptMocks)

vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}))

import { DirectorySyncError, DirectorySyncService } from '../../src/directory/directory-sync'

function createService() {
  return new DirectorySyncService()
}

function isoNow() {
  return new Date('2026-03-25T00:00:00.000Z').toISOString()
}

function mockAccountBaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-1',
    integration_id: 'dir-1',
    provider: 'dingtalk',
    corp_id: 'corp-1',
    external_user_id: 'user-1',
    union_id: null,
    open_id: null,
    external_key: 'dingtalk:corp-1:user-1',
    name: 'Alice',
    nick: 'Alice',
    email: 'alice@example.com',
    mobile: null,
    job_number: null,
    title: null,
    avatar_url: null,
    is_active: true,
    raw: null,
    last_seen_at: null,
    deprovision_policy_override: null,
    created_at: isoNow(),
    updated_at: isoNow(),
    ...overrides,
  }
}

function mockIntegrationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dir-1',
    org_id: 'default',
    provider: 'dingtalk',
    name: 'Directory Sync',
    status: 'active',
    corp_id: 'corp-1',
    config: JSON.stringify({
      appKey: 'app-key',
      appSecret: 'app-secret',
      rootDepartmentId: '1',
      tokenUrl: 'https://oapi.dingtalk.com/gettoken',
      departmentsUrl: 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
      usersUrl: 'https://oapi.dingtalk.com/topapi/v2/user/list',
      userDetailUrl: 'https://oapi.dingtalk.com/topapi/v2/user/get',
      pageSize: 100,
      captureUnboundLogins: true,
    }),
    sync_enabled: true,
    schedule_cron: '0 3 * * *',
    default_deprovision_policy: '["mark_inactive","disable_dingtalk_auth"]',
    last_sync_at: '2026-03-27T00:00:00.000Z',
    last_success_at: '2026-03-27T00:05:00.000Z',
    last_cursor: null,
    last_error: null,
    created_at: isoNow(),
    updated_at: isoNow(),
    ...overrides,
  }
}

function mockTemplateCenterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'center-1',
    integration_id: 'dir-1',
    team_templates: JSON.stringify({
      ticket: {
        template: '工单模板',
      },
    }),
    import_history: JSON.stringify([]),
    import_presets: JSON.stringify({
      ticket: [{
        id: 'preset-1',
        name: '值班模板',
        tags: ['值班'],
        favorite: true,
        pinned: false,
        useCount: 3,
        lastUsedAt: '2026-03-27T00:03:00.000Z',
        ignoredFieldKeys: ['owner', 'channel'],
      }],
    }),
    created_by: 'admin-1',
    updated_by: 'admin-1',
    created_at: isoNow(),
    updated_at: isoNow(),
    ...overrides,
  }
}

describe('DirectorySyncService', () => {
  beforeEach(() => {
    queryMocks.query.mockReset().mockResolvedValue({ rows: [] })
    queryMocks.transaction.mockReset().mockImplementation(async (handler: (client: { query: typeof queryMocks.query }) => Promise<void>) => {
      await handler({ query: queryMocks.query })
    })
    schedulerMocks.listJobs.mockReset().mockResolvedValue([])
    schedulerMocks.schedule.mockReset()
    schedulerMocks.unschedule.mockReset()
    schedulerMocks.destroy.mockReset()
    externalIdentityMocks.findExternalIdentityByProviderAndKey.mockReset().mockResolvedValue(null)
    externalIdentityMocks.upsertExternalIdentity.mockReset().mockResolvedValue({ id: 'binding-1' })
    authGrantMocks.isUserExternalAuthEnabled.mockReset().mockResolvedValue(false)
    authGrantMocks.upsertUserExternalAuthGrant.mockReset().mockResolvedValue({ id: 'grant-1' })
    passwordMocks.validatePassword.mockReset().mockReturnValue({ valid: true, errors: [] })
    bcryptMocks.hash.mockReset().mockResolvedValue('hashed-password')
  })

  it('rejects invalid cron expressions when creating an integration', async () => {
    const service = createService()

    await expect(service.createIntegration({
      orgId: 'default',
      name: 'Directory Sync',
      corpId: 'corp-1',
      appKey: 'app-key',
      appSecret: 'app-secret',
      scheduleCron: '0 0 31 2 *',
    }, 'admin-1')).rejects.toMatchObject({
      status: 400,
      code: 'DIRECTORY_CRON_INVALID',
    })

    expect(queryMocks.query).not.toHaveBeenCalled()
  })

  it('clamps directory integration page size to a valid 1-100 range', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'dir-1',
          org_id: 'default',
          provider: 'dingtalk',
          name: 'Directory Sync',
          status: 'active',
          corp_id: 'corp-1',
          config: JSON.stringify({
            appKey: 'app-key',
            appSecret: 'app-secret',
            rootDepartmentId: '1',
            tokenUrl: 'https://oapi.dingtalk.com/gettoken',
            departmentsUrl: 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
            usersUrl: 'https://oapi.dingtalk.com/topapi/v2/user/list',
            userDetailUrl: 'https://oapi.dingtalk.com/topapi/v2/user/get',
            pageSize: 100,
          }),
          sync_enabled: false,
          schedule_cron: null,
          default_deprovision_policy: 'mark_inactive',
          last_sync_at: null,
          last_success_at: null,
          last_cursor: null,
          last_error: null,
          created_at: '2026-03-25T00:00:00.000Z',
          updated_at: '2026-03-25T00:00:00.000Z',
        }],
      })

    const created = await service.createIntegration({
      orgId: 'default',
      name: 'Directory Sync',
      corpId: 'corp-1',
      appKey: 'app-key',
      appSecret: 'app-secret',
      pageSize: 0,
    }, 'admin-1')

    const insertSql = queryMocks.query.mock.calls[0]?.[0]
    const insertParams = queryMocks.query.mock.calls[0]?.[1] ?? []
    expect(insertSql).toContain('INSERT INTO directory_integrations')
    const savedConfig = JSON.parse(insertParams[5] as string)
    expect(savedConfig.pageSize).toBe(1)
    expect(created.config.pageSize).toBe(100)
  })

  it('falls back integration page size to 100 when input is not a number', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'dir-2',
          org_id: 'default',
          provider: 'dingtalk',
          name: 'Directory Sync',
          status: 'active',
          corp_id: 'corp-1',
          config: JSON.stringify({
            appKey: 'app-key',
            appSecret: 'app-secret',
            rootDepartmentId: '1',
            tokenUrl: 'https://oapi.dingtalk.com/gettoken',
            departmentsUrl: 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
            usersUrl: 'https://oapi.dingtalk.com/topapi/v2/user/list',
            userDetailUrl: 'https://oapi.dingtalk.com/topapi/v2/user/get',
            pageSize: 100,
          }),
          sync_enabled: false,
          schedule_cron: null,
          default_deprovision_policy: 'mark_inactive',
          last_sync_at: null,
          last_success_at: null,
          last_cursor: null,
          last_error: null,
          created_at: '2026-03-25T00:00:00.000Z',
          updated_at: '2026-03-25T00:00:00.000Z',
        }],
      })

    const created = await service.createIntegration({
      orgId: 'default',
      name: 'Directory Sync',
      corpId: 'corp-1',
      appKey: 'app-key',
      appSecret: 'app-secret',
      // Intentionally passing a non-finite value to validate fallback behavior.
      pageSize: Number('invalid'),
    }, 'admin-1')

    const insertParams = queryMocks.query.mock.calls[0]?.[1] ?? []
    const savedConfig = JSON.parse(insertParams[5] as string)
    expect(savedConfig.pageSize).toBe(100)
    expect(created.config.pageSize).toBe(100)
  })

  it('enables unbound DingTalk login capture by default for directory integrations', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'dir-capture',
          org_id: 'default',
          provider: 'dingtalk',
          name: 'Directory Sync',
          status: 'active',
          corp_id: 'corp-1',
          config: JSON.stringify({
            appKey: 'app-key',
            appSecret: 'app-secret',
            rootDepartmentId: '1',
            tokenUrl: 'https://oapi.dingtalk.com/gettoken',
            departmentsUrl: 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
            usersUrl: 'https://oapi.dingtalk.com/topapi/v2/user/list',
            userDetailUrl: 'https://oapi.dingtalk.com/topapi/v2/user/get',
            pageSize: 100,
            captureUnboundLogins: true,
          }),
          sync_enabled: false,
          schedule_cron: null,
          default_deprovision_policy: 'mark_inactive',
          last_sync_at: null,
          last_success_at: null,
          last_cursor: null,
          last_error: null,
          created_at: '2026-03-25T00:00:00.000Z',
          updated_at: '2026-03-25T00:00:00.000Z',
        }],
      })

    const created = await service.createIntegration({
      orgId: 'default',
      name: 'Directory Sync',
      corpId: 'corp-1',
      appKey: 'app-key',
      appSecret: 'app-secret',
    }, 'admin-1')

    const insertParams = queryMocks.query.mock.calls[0]?.[1] ?? []
    const savedConfig = JSON.parse(insertParams[5] as string)
    expect(savedConfig.captureUnboundLogins).toBe(true)
    expect(created.config.captureUnboundLogins).toBe(true)
  })

  it('lists directory activity for an integration with summary metadata', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [mockIntegrationRow()] })
      .mockResolvedValueOnce({
        rows: [{
          total: 2,
          integrationActions: 1,
          accountActions: 1,
          syncActions: 1,
          alertActions: 0,
          templateActions: 0,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'audit-1',
          created_at: '2026-03-29T01:00:00.000Z',
          event_type: 'admin.directory',
          event_category: 'admin',
          event_severity: 'info',
          action: 'authorize',
          resource_type: 'directory-account',
          resource_id: 'acct-1',
          user_id: 'admin-1',
          user_name: '管理员',
          user_email: 'admin@example.com',
          action_details: { integrationId: 'dir-1', accountId: 'acct-1' },
          error_code: null,
          integration_id: 'dir-1',
          integration_name: 'Directory Sync',
          account_id: 'acct-1',
          account_name: 'Alice',
          account_email: 'alice@example.com',
          account_external_user_id: 'user-1',
        }],
      })

    const result = await service.listActivity('dir-1', {
      page: 1,
      pageSize: 10,
      q: 'Alice',
      action: 'authorize',
      resourceType: 'directory-account',
      accountId: 'acct-1',
      from: '2026-03-28T00:00:00.000Z',
      to: '2026-03-29T23:59:59.999Z',
    })

    expect(result.summary).toEqual({
      total: 2,
      integrationActions: 1,
      accountActions: 1,
      syncActions: 1,
      alertActions: 0,
      templateActions: 0,
    })
    expect(result.items[0]).toMatchObject({
      id: 'audit-1',
      action: 'authorize',
      resourceType: 'directory-account',
      integrationId: 'dir-1',
      integrationName: 'Directory Sync',
      accountId: 'acct-1',
      accountName: 'Alice',
      actorEmail: 'admin@example.com',
    })

    const summarySql = queryMocks.query.mock.calls[1]?.[0] as string
    const listSql = queryMocks.query.mock.calls[2]?.[0] as string
    expect(summarySql).toContain('FROM audit_logs al')
    expect(listSql).toContain('ORDER BY al.created_at DESC')
  })

  it('stores combined default deprovision policies as a JSON array string', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'dir-combo',
          org_id: 'default',
          provider: 'dingtalk',
          name: 'Directory Sync',
          status: 'active',
          corp_id: 'corp-1',
          config: JSON.stringify({
            appKey: 'app-key',
            appSecret: 'app-secret',
            rootDepartmentId: '1',
            tokenUrl: 'https://oapi.dingtalk.com/gettoken',
            departmentsUrl: 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
            usersUrl: 'https://oapi.dingtalk.com/topapi/v2/user/list',
            userDetailUrl: 'https://oapi.dingtalk.com/topapi/v2/user/get',
            pageSize: 100,
          }),
          sync_enabled: false,
          schedule_cron: null,
          default_deprovision_policy: '["mark_inactive","disable_dingtalk_auth"]',
          last_sync_at: null,
          last_success_at: null,
          last_cursor: null,
          last_error: null,
          created_at: isoNow(),
          updated_at: isoNow(),
        }],
      })

    const created = await service.createIntegration({
      orgId: 'default',
      name: 'Directory Sync',
      corpId: 'corp-1',
      appKey: 'app-key',
      appSecret: 'app-secret',
      defaultDeprovisionPolicy: ['mark_inactive', 'disable_dingtalk_auth'],
    }, 'admin-1')

    const insertParams = queryMocks.query.mock.calls[0]?.[1] ?? []
    expect(insertParams[8]).toBe('["mark_inactive","disable_dingtalk_auth"]')
    expect(created.defaultDeprovisionPolicy).toEqual(['mark_inactive', 'disable_dingtalk_auth'])
  })

  it('captures an unbound DingTalk login into the admin review queue', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'dir-1',
          org_id: 'default',
          provider: 'dingtalk',
          name: 'Directory Sync',
          status: 'active',
          corp_id: 'corp-1',
          config: JSON.stringify({
            appKey: 'app-key',
            appSecret: 'app-secret',
            rootDepartmentId: '1',
            tokenUrl: 'https://oapi.dingtalk.com/gettoken',
            departmentsUrl: 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
            usersUrl: 'https://oapi.dingtalk.com/topapi/v2/user/list',
            userDetailUrl: 'https://oapi.dingtalk.com/topapi/v2/user/get',
            pageSize: 100,
            captureUnboundLogins: true,
          }),
          sync_enabled: true,
          schedule_cron: null,
          default_deprovision_policy: 'mark_inactive',
          last_sync_at: null,
          last_success_at: null,
          last_cursor: null,
          last_error: null,
          created_at: isoNow(),
          updated_at: isoNow(),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'acct-captured' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-captured',
          external_user_id: 'dt-user-9',
          union_id: 'union-9',
          open_id: 'open-9',
          external_key: 'dingtalk:corp-1:dt-user-9',
          name: 'Pending Ding User',
          nick: 'Pending',
          email: 'pending@example.com',
          mobile: '13800000000',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await service.captureUnboundLoginForReview({
      provider: 'dingtalk',
      userId: 'dt-user-9',
      unionId: 'union-9',
      openId: 'open-9',
      corpId: 'corp-1',
      name: 'Pending Ding User',
      nick: 'Pending',
      email: 'pending@example.com',
      avatarUrl: null,
      mobile: '13800000000',
      raw: { userId: 'dt-user-9', corpId: 'corp-1' },
    })

    expect(result).toEqual({
      integrationId: 'dir-1',
      accountId: 'acct-captured',
      created: true,
      linkStatus: 'pending',
    })

    const insertCall = queryMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO directory_accounts'))
    expect(insertCall).toBeDefined()
    const insertParams = insertCall?.[1] ?? []
    expect(insertParams[2]).toBe('corp-1')
    expect(insertParams[3]).toBe('dt-user-9')
  })

  it('reuses an existing directory account matched by union id and removes redundant pending duplicates', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-existing',
          integration_id: 'dir-1',
          corp_id: 'corp-1',
          external_user_id: 'dt-user-legacy',
          union_id: 'union-legacy',
          open_id: null,
          external_key: 'dingtalk:corp-1:dt-user-legacy',
          email: null,
          mobile: null,
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          ...mockAccountBaseRow({
            id: 'acct-duplicate',
            integration_id: 'dir-1',
            corp_id: 'corp-1',
            external_user_id: 'union-legacy',
            union_id: 'union-legacy',
            open_id: null,
            external_key: 'dingtalk-union:union-legacy',
            email: null,
            mobile: null,
          }),
          local_user_id: null,
          link_status: 'pending',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-existing',
          integration_id: 'dir-1',
          corp_id: 'corp-1',
          external_user_id: 'dt-user-legacy',
          union_id: 'union-legacy',
          open_id: null,
          external_key: 'dingtalk:corp-1:dt-user-legacy',
          email: null,
          mobile: null,
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await service.captureUnboundLoginForReview({
      provider: 'dingtalk',
      userId: null,
      unionId: 'union-legacy',
      openId: null,
      corpId: 'corp-1',
      name: 'Pending Ding User',
      nick: 'Pending',
      email: null,
      avatarUrl: null,
      mobile: null,
      raw: { unionId: 'union-legacy', corpId: 'corp-1' },
    })

    expect(result).toEqual({
      integrationId: 'dir-1',
      accountId: 'acct-existing',
      created: false,
      linkStatus: 'pending',
    })

    const insertCall = queryMocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO directory_accounts'))
    expect(insertCall).toBeUndefined()

    const updateCall = queryMocks.query.mock.calls.find((call) => String(call[0]).includes('UPDATE directory_accounts'))
    expect(updateCall).toBeDefined()
    const updateParams = updateCall?.[1] ?? []
    expect(updateParams[2]).toBe('dt-user-legacy')
    expect(updateParams[5]).toBe('dingtalk:corp-1:dt-user-legacy')

    const deleteCall = queryMocks.query.mock.calls.find((call) => String(call[0]).includes('DELETE FROM directory_accounts'))
    expect(deleteCall).toBeDefined()
    expect(deleteCall?.[1]).toEqual([['acct-duplicate']])
  })

  it('serializes sync cursors as JSON strings for jsonb cursor columns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T12:34:56.000Z'))

    try {
      const service = createService()
      ;(service as unknown as {
        fetchAccessToken: () => Promise<string>
        fetchAllDepartments: () => Promise<never[]>
        fetchAllUsers: () => Promise<never[]>
        persistSyncSnapshot: () => Promise<Record<string, number>>
        getRun: (runId: string) => Promise<{ id: string; cursorAfter: string | null; cursorBefore: string | null }>
      }).fetchAccessToken = vi.fn().mockResolvedValue('token')
      ;(service as unknown as {
        fetchAccessToken: () => Promise<string>
        fetchAllDepartments: () => Promise<never[]>
        fetchAllUsers: () => Promise<never[]>
        persistSyncSnapshot: () => Promise<Record<string, number>>
        getRun: (runId: string) => Promise<{ id: string; cursorAfter: string | null; cursorBefore: string | null }>
      }).fetchAllDepartments = vi.fn().mockResolvedValue([])
      ;(service as unknown as {
        fetchAccessToken: () => Promise<string>
        fetchAllDepartments: () => Promise<never[]>
        fetchAllUsers: () => Promise<never[]>
        persistSyncSnapshot: () => Promise<Record<string, number>>
        getRun: (runId: string) => Promise<{ id: string; cursorAfter: string | null; cursorBefore: string | null }>
      }).fetchAllUsers = vi.fn().mockResolvedValue([])
      ;(service as unknown as {
        fetchAccessToken: () => Promise<string>
        fetchAllDepartments: () => Promise<never[]>
        fetchAllUsers: () => Promise<never[]>
        persistSyncSnapshot: () => Promise<Record<string, number>>
        getRun: (runId: string) => Promise<{ id: string; cursorAfter: string | null; cursorBefore: string | null }>
      }).persistSyncSnapshot = vi.fn().mockResolvedValue({
        departmentsFetched: 0,
        accountsFetched: 0,
        accountsInserted: 0,
        accountsUpdated: 0,
        linksMatched: 0,
        linksConflicted: 0,
        accountsDeactivated: 0,
      })
      ;(service as unknown as {
        fetchAccessToken: () => Promise<string>
        fetchAllDepartments: () => Promise<never[]>
        fetchAllUsers: () => Promise<never[]>
        persistSyncSnapshot: () => Promise<Record<string, number>>
        getRun: (runId: string) => Promise<{ id: string; cursorAfter: string | null; cursorBefore: string | null }>
      }).getRun = vi.fn().mockImplementation(async (runId: string) => ({
        id: runId,
        cursorBefore: '2026-03-24T00:00:00.000Z',
        cursorAfter: '2026-03-25T12:34:56.000Z',
      }))

      queryMocks.query
        .mockResolvedValueOnce({
          rows: [{
            id: 'dir-sync-1',
            org_id: 'default',
            provider: 'dingtalk',
            name: 'Directory Sync',
            status: 'active',
            corp_id: 'corp-1',
            config: JSON.stringify({
              appKey: 'app-key',
              appSecret: 'app-secret',
              rootDepartmentId: '1',
              tokenUrl: 'https://oapi.dingtalk.com/gettoken',
              departmentsUrl: 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
              usersUrl: 'https://oapi.dingtalk.com/topapi/v2/user/list',
              userDetailUrl: 'https://oapi.dingtalk.com/topapi/v2/user/get',
              pageSize: 100,
            }),
            sync_enabled: true,
            schedule_cron: null,
            default_deprovision_policy: 'mark_inactive',
            last_sync_at: null,
            last_success_at: null,
            last_cursor: '2026-03-24T00:00:00.000Z',
            last_error: null,
            created_at: '2026-03-25T00:00:00.000Z',
            updated_at: '2026-03-25T00:00:00.000Z',
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })

      await service.syncIntegration('dir-sync-1', 'admin-1')

      expect(queryMocks.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO directory_sync_runs'),
        expect.arrayContaining([
          'dir-sync-1',
          JSON.stringify('2026-03-24T00:00:00.000Z'),
        ]),
      )
      expect(queryMocks.query).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('UPDATE directory_sync_runs'),
        expect.arrayContaining([
          JSON.stringify('2026-03-25T12:34:56.000Z'),
        ]),
      )
      expect(queryMocks.query).toHaveBeenNthCalledWith(
        4,
        expect.stringContaining('UPDATE directory_integrations'),
        ['dir-sync-1', JSON.stringify('2026-03-25T12:34:56.000Z')],
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers external identity over email matching when reconciling links', async () => {
    const service = createService()
    externalIdentityMocks.findExternalIdentityByProviderAndKey.mockResolvedValue({
      userId: 'user-external',
    })

    queryMocks.query
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-1',
          email: 'alice@example.com',
          external_key: 'dingtalk:corp-1:user-1',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-email',
          email: 'alice@example.com',
          name: 'Alice Email',
        }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })

    const result = await (service as unknown as {
      reconcileAccountLink: (accountId: string) => Promise<{ status: string; matchStrategy: string | null; localUserId: string | null }>
    }).reconcileAccountLink('acct-1')

    expect(result).toMatchObject({
      status: 'conflict',
      matchStrategy: 'external_identity',
      localUserId: 'user-external',
    })
    expect(externalIdentityMocks.findExternalIdentityByProviderAndKey).toHaveBeenCalledWith('dingtalk', 'dingtalk:corp-1:user-1')
    expect(queryMocks.query.mock.calls[2]?.[0]).toContain('FROM users')
    expect(queryMocks.query.mock.calls[3]?.[0]).toContain('INSERT INTO directory_account_links')
  })

  it('matches by email when no external identity exists', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-2',
          external_key: 'dingtalk:corp-1:user-2',
          email: 'beta@example.com',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-email',
          email: 'beta@example.com',
          name: 'Beta',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const result = await (service as unknown as {
      reconcileAccountLink: (accountId: string) => Promise<{ status: string; matchStrategy: string | null; localUserId: string | null }>
    }).reconcileAccountLink('acct-2')

    expect(result).toMatchObject({
      status: 'linked',
      matchStrategy: 'email_exact',
      localUserId: 'user-email',
    })
    expect(queryMocks.query).toHaveBeenNthCalledWith(4, expect.stringContaining('INSERT INTO directory_account_links'), expect.any(Array))
  })

  it('keeps email matches pending when multiple users share the same email', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-dup-email',
          external_key: 'dingtalk:corp-1:user-4',
          email: 'beta@example.com',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-email-1', email: 'beta@example.com', name: 'Beta One' },
          { id: 'user-email-2', email: 'beta@example.com', name: 'Beta Two' },
        ],
      })

    const result = await (service as unknown as {
      reconcileAccountLink: (accountId: string) => Promise<{ status: string; matchStrategy: string | null; localUserId: string | null }>
    }).reconcileAccountLink('acct-dup-email')

    expect(result).toMatchObject({
      status: 'pending',
      matchStrategy: null,
      localUserId: null,
    })
    expect(queryMocks.query).toHaveBeenNthCalledWith(3, expect.stringContaining('FROM users'), expect.any(Array))
    expect(queryMocks.query).toHaveBeenNthCalledWith(4, expect.stringContaining('INSERT INTO directory_account_links'), expect.any(Array))
  })

  it('matches by mobile when no external identity or email exists', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-3',
          external_key: 'dingtalk:corp-1:user-3',
          email: null,
          mobile: '13800001234',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-mobile',
          mobile: '13800001234',
          name: 'Mobile User',
          email: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const result = await (service as unknown as {
      reconcileAccountLink: (accountId: string) => Promise<{ status: string; matchStrategy: string | null; localUserId: string | null }>
    }).reconcileAccountLink('acct-3')

    expect(result).toMatchObject({
      status: 'linked',
      matchStrategy: 'mobile_exact',
      localUserId: 'user-mobile',
    })
    expect(queryMocks.query).toHaveBeenNthCalledWith(3, expect.stringContaining('regexp_replace(mobile'), expect.any(Array))
    expect(queryMocks.query).toHaveBeenNthCalledWith(4, expect.stringContaining('INSERT INTO directory_account_links'), expect.any(Array))
  })

  it('keeps mobile matches pending when multiple users share the same normalized mobile', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-dup-mobile',
          external_key: 'dingtalk:corp-1:user-dup',
          email: null,
          mobile: '138-0000-1234',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-mobile-1', mobile: '13800001234', name: 'Mobile User A', email: 'a@example.com' },
          { id: 'user-mobile-2', mobile: '13800001234', name: 'Mobile User B', email: 'b@example.com' },
        ],
      })

    const result = await (service as unknown as {
      reconcileAccountLink: (accountId: string) => Promise<{ status: string; matchStrategy: string | null; localUserId: string | null }>
    }).reconcileAccountLink('acct-dup-mobile')

    expect(result).toMatchObject({
      status: 'pending',
      matchStrategy: null,
      localUserId: null,
    })
    expect(queryMocks.query).toHaveBeenNthCalledWith(3, expect.stringContaining('regexp_replace(mobile'), expect.any(Array))
    expect(queryMocks.query).toHaveBeenNthCalledWith(4, expect.stringContaining('INSERT INTO directory_account_links'), expect.any(Array))
  })

  it('disables DingTalk auth on deprovision policy disable_dingtalk_auth', async () => {
    const service = createService()
    queryMocks.query.mockResolvedValueOnce({
      rows: [{
        account_id: 'acct-1',
        local_user_id: 'user-1',
        effective_policy: 'disable_dingtalk_auth',
      }],
    })

    await (service as unknown as {
      applyDeprovisionPolicies: (accountIds: string[]) => Promise<void>
    }).applyDeprovisionPolicies(['acct-1'])

    expect(authGrantMocks.upsertUserExternalAuthGrant).toHaveBeenCalledWith({
      provider: 'dingtalk',
      userId: 'user-1',
      enabled: false,
      grantedBy: null,
    })
    expect(queryMocks.query).toHaveBeenCalledTimes(1)
  })

  it('disables the local user when deprovision policy is disable_local_user', async () => {
    const service = createService()
    queryMocks.query.mockResolvedValueOnce({
      rows: [{
        account_id: 'acct-2',
        local_user_id: 'user-2',
        effective_policy: 'disable_local_user',
      }],
    })
    queryMocks.query.mockResolvedValueOnce({ rows: [] })

    await (service as unknown as {
      applyDeprovisionPolicies: (accountIds: string[]) => Promise<void>
    }).applyDeprovisionPolicies(['acct-2'])

    expect(authGrantMocks.upsertUserExternalAuthGrant).toHaveBeenCalledWith({
      provider: 'dingtalk',
      userId: 'user-2',
      enabled: false,
      grantedBy: null,
    })
    expect(queryMocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining('UPDATE users'), ['user-2'])
  })

  it('applies every action from a combined deprovision policy set', async () => {
    const service = createService()
    queryMocks.query.mockResolvedValueOnce({
      rows: [{
        account_id: 'acct-3',
        local_user_id: 'user-3',
        effective_policy: '["mark_inactive","disable_dingtalk_auth","disable_local_user"]',
      }],
    })
    queryMocks.query.mockResolvedValueOnce({ rows: [] })

    await (service as unknown as {
      applyDeprovisionPolicies: (accountIds: string[]) => Promise<void>
    }).applyDeprovisionPolicies(['acct-3'])

    expect(authGrantMocks.upsertUserExternalAuthGrant).toHaveBeenCalledWith({
      provider: 'dingtalk',
      userId: 'user-3',
      enabled: false,
      grantedBy: null,
    })
    expect(queryMocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining('UPDATE users'), ['user-3'])
  })

  it('provisions a local user with a generated placeholder email and binds dingtalk when authorized', async () => {
    const service = createService()
    const serviceInternals = service as unknown as {
      getUserById: (userId: string) => Promise<unknown>
      getAccount: (accountId: string) => Promise<unknown>
    }
    serviceInternals.getUserById = vi.fn().mockResolvedValue({
      id: 'user-generated',
      email: '0357574763363730830@dingtalk.local',
      mobile: '18367808344',
      name: 'zaah',
      is_active: true,
    })
    serviceInternals.getAccount = vi.fn().mockResolvedValue({
      id: 'acct-generated',
      linkedUser: {
        id: 'user-generated',
        email: '0357574763363730830@dingtalk.local',
      },
      dingtalkAuthEnabled: true,
      isBound: true,
    })

    queryMocks.query
      .mockResolvedValueOnce({
        rows: [mockAccountBaseRow({
          id: 'acct-generated',
          external_user_id: '0357574763363730830',
          external_key: 'dingtalk:corp-1:0357574763363730830',
          email: null,
          mobile: '18367808344',
          name: 'zaah',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await service.provisionUser('acct-generated', {
      name: 'zaah',
      authorizeDingTalk: true,
    }, 'admin-1')

    expect(queryMocks.query).toHaveBeenNthCalledWith(
      2,
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      ['0357574763363730830@dingtalk.local'],
    )
    expect(queryMocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO users'),
      expect.arrayContaining(['0357574763363730830@dingtalk.local', '18367808344', 'zaah']),
    )
    expect(authGrantMocks.upsertUserExternalAuthGrant).toHaveBeenCalledWith({
      provider: 'dingtalk',
      userId: expect.any(String),
      enabled: true,
      grantedBy: 'admin-1',
    })
    expect(externalIdentityMocks.upsertExternalIdentity).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'dingtalk',
      externalKey: 'dingtalk:corp-1:0357574763363730830',
      providerUserId: '0357574763363730830',
      corpId: 'corp-1',
      boundBy: 'admin-1',
    }))
    expect(result).toMatchObject({
      user: {
        email: '0357574763363730830@dingtalk.local',
      },
      temporaryPassword: expect.any(String),
      account: {
        isBound: true,
        dingtalkAuthEnabled: true,
      },
    })
  })

  it('saves the template center, versions it, and reloads the latest snapshot', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [mockIntegrationRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [mockIntegrationRow()] })
      .mockResolvedValueOnce({
        rows: [mockTemplateCenterRow({
          team_templates: JSON.stringify({
            ticket: {
              template: '服务端工单模板',
            },
          }),
          import_history: JSON.stringify([{ id: 'history-1' }]),
          import_presets: JSON.stringify({
            ticket: [{
              id: 'preset-1',
              name: '值班模板',
              tags: ['值班'],
              useCount: 2,
            }],
          }),
        })],
      })

    const result = await service.saveTemplateCenter('dir-1', {
      teamTemplates: {
        ticket: {
          template: '服务端工单模板',
        },
      },
      importHistory: [{ id: 'history-1' }],
      importPresets: {
        ticket: [{
          id: 'preset-1',
          name: '值班模板',
          tags: ['值班'],
          useCount: 2,
        }],
      },
      changeReason: 'save_team_template',
    }, 'admin-1')

    expect(queryMocks.query).toHaveBeenNthCalledWith(3, expect.stringContaining('INSERT INTO directory_template_centers'), expect.any(Array))
    expect(queryMocks.query).toHaveBeenNthCalledWith(4, expect.stringContaining('INSERT INTO directory_template_center_versions'), expect.any(Array))
    expect(result).toMatchObject({
      integrationId: 'dir-1',
      updatedBy: 'admin-1',
      teamTemplates: {
        ticket: {
          template: '服务端工单模板',
        },
      },
    })
  })

  it('builds a governance report from the template center snapshot', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [mockIntegrationRow()] })
      .mockResolvedValueOnce({
        rows: [mockTemplateCenterRow({
          import_presets: JSON.stringify({
            ticket: [
              {
                id: 'preset-high',
                name: '高频预设',
                tags: ['值班', '工单'],
                favorite: true,
                pinned: true,
                useCount: 5,
                lastUsedAt: '2026-03-27T00:03:00.000Z',
                ignoredFieldKeys: ['owner'],
              },
              {
                id: 'preset-low',
                name: '低频预设',
                tags: ['值班'],
                favorite: false,
                pinned: false,
                useCount: 1,
                lastUsedAt: null,
                ignoredFieldKeys: [],
              },
            ],
          }),
        })],
      })

    const report = await service.buildTemplateGovernanceReport('dir-1')

    expect(report.totals.importPresets).toBe(2)
    expect(report.totals.favorites).toBe(1)
    expect(report.totals.pinned).toBe(1)
    expect(report.totals.highFrequency).toBe(1)
    expect(report.totals.lowFrequency).toBe(1)
    expect(report.tagSummary[0]).toEqual({ tag: '值班', count: 2 })
    expect(report.presets[0]).toMatchObject({
      id: 'preset-high',
      usageBucket: 'high',
    })
  })

  it('returns schedule status and alert counters for an integration', async () => {
    const service = createService()

    queryMocks.query
      .mockResolvedValueOnce({ rows: [mockIntegrationRow()] })
      .mockResolvedValueOnce({
        rows: [{
          status: 'success',
          started_at: '2026-03-27T00:00:00.000Z',
          finished_at: '2026-03-27T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          total: 2,
          unacknowledged: 1,
          last_alert_at: '2026-03-27T00:06:00.000Z',
        }],
      })

    const status = await service.getIntegrationOperationsStatus('dir-1')

    expect(status).toMatchObject({
      integrationId: 'dir-1',
      syncEnabled: true,
      scheduleCron: '0 3 * * *',
      lastRunStatus: 'success',
      alertCount: 2,
      unacknowledgedAlertCount: 1,
    })
    expect(status.nextRunAt).toBeTruthy()
  })

  it('records sync alerts and acknowledges them later', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    queryMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'alert-1',
          integration_id: 'dir-1',
          run_id: 'run-1',
          level: 'error',
          code: 'DIRECTORY_SYNC_FAILED',
          message: '同步失败',
          details: JSON.stringify({ source: 'scheduled', reason: 'boom' }),
          sent_to_webhook: true,
          acknowledged_at: '2026-03-27T00:07:00.000Z',
          acknowledged_by: 'admin-1',
          created_at: '2026-03-27T00:06:00.000Z',
          updated_at: '2026-03-27T00:07:00.000Z',
        }],
      })

    process.env.DIRECTORY_SYNC_ALERT_WEBHOOK_URL = 'https://alerts.example.test/directory'
    await (service as unknown as {
      recordSyncAlert: (
        integrationId: string,
        runId: string | null,
        source: 'manual' | 'scheduled',
        code: string,
        message: string,
        details: Record<string, unknown>,
      ) => Promise<void>
    }).recordSyncAlert('dir-1', 'run-1', 'scheduled', 'DIRECTORY_SYNC_FAILED', '同步失败', { reason: 'boom' })

    expect(fetchMock).toHaveBeenCalledWith('https://alerts.example.test/directory', expect.objectContaining({
      method: 'POST',
    }))
    expect(queryMocks.query).toHaveBeenNthCalledWith(1, expect.stringContaining('INSERT INTO directory_sync_alerts'), expect.any(Array))

    const alert = await service.acknowledgeSyncAlert('dir-1', 'alert-1', 'admin-1')
    expect(alert).toMatchObject({
      id: 'alert-1',
      acknowledgedBy: 'admin-1',
      sentToWebhook: true,
    })

    delete process.env.DIRECTORY_SYNC_ALERT_WEBHOOK_URL
    vi.unstubAllGlobals()
  })
})
