import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DirectoryManagementView from '../src/views/DirectoryManagementView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function createIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dir-1',
    name: 'DingTalk CN',
    corpId: 'dingcorp',
    status: 'active',
    syncEnabled: true,
    scheduleCron: null,
    defaultDeprovisionPolicy: 'mark_inactive',
    lastSyncAt: '2026-04-08T01:00:00.000Z',
    lastSuccessAt: '2026-04-08T01:00:00.000Z',
    lastError: null,
    config: {
      appKey: 'ding-app-key',
      appSecretConfigured: true,
      rootDepartmentId: '1',
      baseUrl: null,
      pageSize: 50,
    },
    stats: {
      departmentCount: 12,
      accountCount: 98,
      pendingLinkCount: 4,
      linkedCount: 88,
      lastRunStatus: 'completed',
    },
    ...overrides,
  }
}

function createAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    integrationId: 'dir-1',
    provider: 'dingtalk',
    corpId: 'dingcorp',
    externalUserId: '0447654442691174',
    unionId: 'union-1',
    openId: null,
    externalKey: 'union-1',
    name: '周华',
    email: null,
    mobile: '13758875801',
    isActive: true,
    updatedAt: '2026-04-08T01:00:00.000Z',
    linkStatus: 'unmatched',
    matchStrategy: 'none',
    reviewedBy: null,
    reviewNote: null,
    linkUpdatedAt: '2026-04-08T01:00:00.000Z',
    localUser: null,
    departmentPaths: ['DingTalk CN'],
    ...overrides,
  }
}

function createAccountListPayload(items: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      items,
      total: items.length,
      page: 1,
      pageSize: 25,
      ...overrides,
    },
  }
}

function createReviewItemsPayload(
  items: Record<string, unknown>[],
  counts: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    ok: true,
    data: {
      items,
      counts: {
        total: items.length,
        needsBinding: items.length,
        inactiveLinked: 0,
        missingIdentity: 0,
        ...counts,
      },
      total: items.length,
      page: 1,
      pageSize: 25,
      queue: 'all',
      ...overrides,
    },
  }
}

function createAlertListPayload(
  items: Record<string, unknown>[],
  counts: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    ok: true,
    data: {
      items,
      counts: {
        total: items.length,
        pending: items.filter((item) => !item.acknowledgedAt).length,
        acknowledged: items.filter((item) => item.acknowledgedAt).length,
        ...counts,
      },
      total: items.length,
      page: 1,
      pageSize: 10,
      ack: 'all',
      ...overrides,
    },
  }
}

function createScheduleSnapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      snapshot: {
        integrationId: 'dir-1',
        syncEnabled: true,
        scheduleCron: '0 * * * *',
        cronValid: true,
        nextExpectedRunAt: '2026-04-08T02:00:00.000Z',
        timezone: 'UTC',
        latestRunAt: '2026-04-08T01:00:00.000Z',
        latestRunStatus: 'completed',
        latestRunTriggerSource: 'manual',
        latestManualRunAt: '2026-04-08T01:00:00.000Z',
        latestManualRunStatus: 'completed',
        latestAutoRunAt: null,
        latestAutoRunStatus: null,
        autoTriggerObserved: false,
        observationStatus: 'manual_only',
        note: '当前只观察到 manual 触发记录；尚未看到自动执行。',
        ...overrides,
      },
    },
  }
}

function createTestResultPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      corpId: 'dingcorp',
      rootDepartmentId: '1',
      appKey: 'ding-app-key',
      departmentSampleCount: 0,
      sampledDepartments: [],
      userSampleCount: 1,
      sampledUsers: [
        { userId: '0447654442691174', name: '周华' },
      ],
      diagnostics: {
        rootDepartmentChildCount: 0,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
        rootDepartmentDirectUserCountWithAccessLimit: 1,
        rootDepartmentDirectUserHasMoreWithAccessLimit: false,
        sampledRootDepartmentUsers: [
          { userId: '0447654442691174', name: '周华' },
        ],
        sampledRootDepartmentUsersWithAccessLimit: [
          { userId: '0447654442691174', name: '周华' },
        ],
      },
      warnings: [
        '根部门 1 未返回任何子部门。',
        '根部门 1 当前仅返回 1 个直属成员；如果钉钉企业通讯录里实际成员更多，通常是应用通讯录接口范围未覆盖，或根部门 ID 配置不正确。',
      ],
      ...overrides,
    },
  }
}

describe('DirectoryManagementView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('loads integrations and recent runs on mount', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'run-1',
              status: 'completed',
              startedAt: '2026-04-08T01:00:00.000Z',
              finishedAt: '2026-04-08T01:05:00.000Z',
              stats: {
                departmentsSynced: 12,
                accountsSynced: 98,
                pendingCount: 4,
                linkedCount: 88,
              },
              errorMessage: null,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload({
          latestRunAt: '2026-04-08T02:00:00.000Z',
          latestRunStatus: 'completed',
          latestRunTriggerSource: 'manual',
          latestManualRunAt: '2026-04-08T02:00:00.000Z',
          latestManualRunStatus: 'completed',
          nextExpectedRunAt: '2026-04-08T03:00:00.000Z',
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-2',
            integrationId: 'dir-1',
            runId: 'run-2',
            level: 'warning',
            code: 'root_members_sparse',
            message: '根部门直属成员明显偏少',
            details: {},
            sentToWebhook: false,
            acknowledgedAt: null,
            acknowledgedBy: null,
            createdAt: '2026-04-08T02:05:00.000Z',
            updatedAt: '2026-04-08T02:05:00.000Z',
          },
        ], {
          total: 1,
          pending: 1,
          acknowledged: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding', 'missing_identity'],
          },
        ], {
          total: 2,
          needsBinding: 1,
          inactiveLinked: 1,
          missingIdentity: 1,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()], { total: 60 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(apiFetchMock).toHaveBeenNthCalledWith(1, '/api/admin/directory/integrations')
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/admin/directory/integrations/dir-1/runs?page=1&pageSize=10')
    expect(apiFetchMock).toHaveBeenNthCalledWith(3, '/api/admin/directory/integrations/dir-1/schedule')
    expect(apiFetchMock).toHaveBeenNthCalledWith(4, '/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=10&ack=pending')
    expect(apiFetchMock).toHaveBeenNthCalledWith(5, '/api/admin/directory/integrations/dir-1/review-items?page=1&pageSize=25&queue=all')
    expect(apiFetchMock).toHaveBeenNthCalledWith(6, '/api/admin/directory/integrations/dir-1/accounts?page=1&pageSize=25')
    expect(container?.textContent).toContain('DingTalk CN')
    expect(container?.textContent).toContain('账号 98')
    expect(container?.textContent).toContain('completed')
    expect(container?.textContent).toContain('自动同步观测')
    expect(container?.textContent).toContain('最近告警')
    expect(container?.textContent).toContain('待处理队列')
    expect(container?.textContent).toContain('Union ID')
    expect(container?.textContent).toContain('0447654442691174')
    expect(container?.textContent).toContain('第 1 / 3 页')
  })

  it('posts manual sync and refreshes the selected integration', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()], { total: 98 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          integration: { id: 'dir-1' },
          run: { id: 'run-2', status: 'completed' },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({
            lastSyncAt: '2026-04-08T02:00:00.000Z',
            lastSuccessAt: '2026-04-08T02:00:00.000Z',
            stats: {
              departmentCount: 13,
              accountCount: 99,
              pendingLinkCount: 3,
              linkedCount: 89,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'run-2',
              status: 'completed',
              startedAt: '2026-04-08T02:00:00.000Z',
              finishedAt: '2026-04-08T02:05:00.000Z',
              stats: {
                departmentsSynced: 13,
                accountsSynced: 99,
                pendingCount: 3,
                linkedCount: 89,
              },
              errorMessage: null,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload({
          latestRunAt: '2026-04-08T02:00:00.000Z',
          latestRunStatus: 'completed',
          latestRunTriggerSource: 'manual',
          latestManualRunAt: '2026-04-08T02:00:00.000Z',
          latestManualRunStatus: 'completed',
          nextExpectedRunAt: '2026-04-08T03:00:00.000Z',
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-3',
            integrationId: 'dir-1',
            level: 'warning',
            code: 'sync_latency',
            message: '同步耗时较长',
            acknowledgedAt: null,
            createdAt: '2026-04-08T02:06:00.000Z',
          },
        ], {
          total: 1,
          pending: 1,
          acknowledged: 0,
        }, {
          ack: 'pending',
          total: 1,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount({
              id: 'account-2',
              linkStatus: 'linked',
              matchStrategy: 'external_identity',
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
                name: 'Beta',
              },
            }),
            reviewReasons: ['inactive_linked'],
          },
        ], {
          total: 1,
          needsBinding: 0,
          inactiveLinked: 1,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            matchStrategy: 'external_identity',
            linkStatus: 'linked',
          }),
        ], { total: 99 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const buttons = Array.from(container!.querySelectorAll('button'))
    const syncButton = buttons.find((button) => button.textContent?.includes('手动同步'))
    expect(syncButton).toBeTruthy()

    syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/integrations/dir-1/sync',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/schedule')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=10&ack=pending')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/review-items?page=1&pageSize=25&queue=all')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/accounts?page=1&pageSize=25')
    expect(container?.textContent).toContain('目录同步已完成')
    expect(container?.textContent).toContain('账号 99')
  })

  it('filters and acknowledges directory alerts', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-1',
            integrationId: 'dir-1',
            runId: 'run-1',
            level: 'error',
            code: 'sync_failed',
            message: '请求超时',
            details: {},
            sentToWebhook: false,
            acknowledgedAt: null,
            acknowledgedBy: null,
            createdAt: '2026-04-08T01:05:00.000Z',
            updatedAt: '2026-04-08T01:05:00.000Z',
          },
        ], {
          total: 2,
          pending: 1,
          acknowledged: 1,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()], { total: 1 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-2',
            integrationId: 'dir-1',
            runId: 'run-0',
            level: 'warning',
            code: 'root_members_sparse',
            message: '根部门直属成员偏少',
            details: {},
            sentToWebhook: false,
            acknowledgedAt: '2026-04-08T01:03:00.000Z',
            acknowledgedBy: 'admin-1',
            createdAt: '2026-04-08T01:01:00.000Z',
            updatedAt: '2026-04-08T01:03:00.000Z',
          },
        ], {
          total: 2,
          pending: 1,
          acknowledged: 1,
        }, {
          ack: 'acknowledged',
          total: 1,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-1',
            integrationId: 'dir-1',
            runId: 'run-1',
            level: 'error',
            code: 'sync_failed',
            message: '请求超时',
            details: {},
            sentToWebhook: false,
            acknowledgedAt: null,
            acknowledgedBy: null,
            createdAt: '2026-04-08T01:05:00.000Z',
            updatedAt: '2026-04-08T01:05:00.000Z',
          },
        ], {
          total: 2,
          pending: 1,
          acknowledged: 1,
        }, {
          ack: 'pending',
          total: 1,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          alert: {
            id: 'alert-1',
            integrationId: 'dir-1',
            runId: 'run-1',
            level: 'error',
            code: 'sync_failed',
            message: '请求超时',
            details: {},
            sentToWebhook: false,
            acknowledgedAt: '2026-04-08T01:06:00.000Z',
            acknowledgedBy: 'admin-1',
            createdAt: '2026-04-08T01:05:00.000Z',
            updatedAt: '2026-04-08T01:06:00.000Z',
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-2',
            integrationId: 'dir-1',
            runId: 'run-0',
            level: 'warning',
            code: 'root_members_sparse',
            message: '根部门直属成员偏少',
            details: {},
            sentToWebhook: false,
            acknowledgedAt: '2026-04-08T01:03:00.000Z',
            acknowledgedBy: 'admin-1',
            createdAt: '2026-04-08T01:01:00.000Z',
            updatedAt: '2026-04-08T01:03:00.000Z',
          },
          {
            id: 'alert-1',
            integrationId: 'dir-1',
            runId: 'run-1',
            level: 'error',
            code: 'sync_failed',
            message: '请求超时',
            details: {},
            sentToWebhook: false,
            acknowledgedAt: '2026-04-08T01:06:00.000Z',
            acknowledgedBy: 'admin-1',
            createdAt: '2026-04-08T01:05:00.000Z',
            updatedAt: '2026-04-08T01:06:00.000Z',
          },
        ], {
          total: 2,
          pending: 0,
          acknowledged: 2,
        }, {
          ack: 'acknowledged',
          total: 2,
        }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('请求超时')

    const alertPanel = Array.from(container!.querySelectorAll('.directory-admin__section')).find((section) =>
      section.textContent?.includes('最近告警'),
    ) as HTMLElement | undefined
    expect(alertPanel).toBeTruthy()

    const alertFilters = Array.from(alertPanel?.querySelectorAll('.directory-admin__filter') ?? []) as HTMLButtonElement[]
    const acknowledgedFilter = alertFilters[1] ?? null
    expect(acknowledgedFilter).toBeTruthy()
    acknowledgedFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=10&ack=acknowledged')
    expect(container?.textContent).toContain('根部门直属成员偏少')

    const pendingFilter = alertFilters[0] ?? null
    expect(pendingFilter).toBeTruthy()
    pendingFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(6)

    const ackButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.trim() === '确认告警')
    expect(ackButton).toBeTruthy()
    ackButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/alerts/alert-1/ack',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=10&ack=pending')
    expect(container?.textContent).toContain('目录告警已确认')
  })

  it('paginates directory accounts', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()], { total: 60 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            unionId: 'union-2',
            name: '次页成员',
          }),
        ], { total: 60, page: 2 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const nextPageButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('下一页'))
    expect(nextPageButton).toBeTruthy()
    nextPageButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenLastCalledWith('/api/admin/directory/integrations/dir-1/accounts?page=2&pageSize=25')
    expect(container?.textContent).toContain('第 2 / 3 页')
    expect(container?.textContent).toContain('次页成员')
  })

  it('binds a directory account to a local user reference', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
              role: 'user',
              is_active: true,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({
            stats: {
              departmentCount: 12,
              accountCount: 98,
              pendingLinkCount: 3,
              linkedCount: 89,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([], {
          total: 0,
          needsBinding: 0,
          inactiveLinked: 0,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
        ]),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const bindInputs = Array.from(container!.querySelectorAll('input[placeholder="例如 user-123 或 alpha@example.com"]')) as HTMLInputElement[]
    const bindInput = bindInputs.at(-1) ?? null
    expect(bindInput).toBeTruthy()
    bindInput!.value = 'alpha@example.com'
    bindInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const searchButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('搜索本地用户'))
    expect(searchButton).toBeTruthy()
    searchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/users?page=1&pageSize=8&q=alpha%40example.com',
    )

    const searchResult = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('alpha@example.com'))
    expect(searchResult).toBeTruthy()
    searchResult?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const bindButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.trim() === '绑定用户')
    expect(bindButton).toBeTruthy()
    bindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/account-1/bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          localUserRef: 'alpha@example.com',
          enableDingTalkGrant: true,
        }),
      }),
    )
    expect(container?.textContent).toContain('已绑定到本地用户')
    expect(container?.textContent).toContain('alpha@example.com')
  })

  it('quick-binds a review item from the queue after searching a local user', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
        ], {
          total: 1,
          needsBinding: 1,
          inactiveLinked: 0,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()], { total: 1 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
              role: 'user',
              is_active: true,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          updatedCount: 1,
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({
            stats: {
              departmentCount: 12,
              accountCount: 98,
              pendingLinkCount: 0,
              linkedCount: 89,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([], {
          total: 0,
          needsBinding: 0,
          inactiveLinked: 0,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
        ], { total: 1 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const reviewInput = Array.from(container!.querySelectorAll('.directory-admin__account--review input[placeholder="例如 user-123 或 alpha@example.com"]')) as HTMLInputElement[]
    expect(reviewInput[0]).toBeTruthy()
    reviewInput[0].value = 'alpha@example.com'
    reviewInput[0].dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const searchButton = Array.from(container!.querySelectorAll('.directory-admin__account--review button')).find((button) => button.textContent?.includes('搜索候选用户'))
    expect(searchButton).toBeTruthy()
    searchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/users?page=1&pageSize=8&q=alpha%40example.com',
    )

    const searchResult = Array.from(container!.querySelectorAll('.directory-admin__search-result')).find((button) => button.textContent?.includes('alpha@example.com'))
    expect(searchResult).toBeTruthy()
    searchResult?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const quickBindButton = Array.from(container!.querySelectorAll('.directory-admin__account--review button')).find((button) => button.textContent?.includes('快速绑定'))
    expect(quickBindButton).toBeTruthy()
    quickBindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: [
            {
              accountId: 'account-1',
              localUserRef: 'alpha@example.com',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('当前筛选下暂无待处理成员')
  })

  it('batch-binds selected review items with filled local user refs', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
          {
            ...createAccount({
              id: 'account-2',
              externalUserId: '0447654442691175',
              unionId: 'union-2',
              name: '次级成员',
              linkStatus: 'unmatched',
              localUser: null,
            }),
            reviewReasons: ['needs_binding'],
          },
        ], {
          total: 2,
          needsBinding: 2,
          inactiveLinked: 0,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount(),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            unionId: 'union-2',
            name: '次级成员',
            linkStatus: 'unmatched',
            localUser: null,
          }),
        ], { total: 2 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
              role: 'user',
              is_active: true,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          bindings: [
            { accountId: 'account-1', updated: true },
            { accountId: 'account-2', updated: true },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({
            stats: {
              departmentCount: 12,
              accountCount: 98,
              pendingLinkCount: 0,
              linkedCount: 90,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([], {
          total: 0,
          needsBinding: 0,
          inactiveLinked: 0,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            unionId: 'union-2',
            name: '次级成员',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'bravo@example.com',
              name: 'Bravo',
            },
          }),
        ], { total: 2 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const reviewCards = Array.from(container!.querySelectorAll('.directory-admin__account--review'))
    expect(reviewCards).toHaveLength(2)

    const firstReviewInput = reviewCards[0].querySelector('input[placeholder="例如 user-123 或 alpha@example.com"]') as HTMLInputElement | null
    const secondReviewInput = reviewCards[1].querySelector('input[placeholder="例如 user-123 或 alpha@example.com"]') as HTMLInputElement | null
    expect(firstReviewInput).toBeTruthy()
    expect(secondReviewInput).toBeTruthy()

    firstReviewInput!.value = 'alpha@example.com'
    firstReviewInput!.dispatchEvent(new Event('input', { bubbles: true }))
    secondReviewInput!.value = 'bravo@example.com'
    secondReviewInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const searchButton = Array.from(reviewCards[0].querySelectorAll('button')).find((button) => button.textContent?.includes('搜索候选用户'))
    expect(searchButton).toBeTruthy()
    searchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    const searchResult = Array.from(container!.querySelectorAll('.directory-admin__search-result')).find((button) => button.textContent?.includes('alpha@example.com'))
    expect(searchResult).toBeTruthy()
    searchResult?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const firstSelection = reviewCards[0].querySelector('input[type="checkbox"]') as HTMLInputElement | null
    const secondSelection = reviewCards[1].querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(firstSelection).toBeTruthy()
    expect(secondSelection).toBeTruthy()
    firstSelection!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    secondSelection!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const batchButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量绑定用户'))
    expect(batchButton).toBeTruthy()
    batchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: [
            {
              accountId: 'account-1',
              localUserRef: 'alpha@example.com',
              enableDingTalkGrant: true,
            },
            {
              accountId: 'account-2',
              localUserRef: 'bravo@example.com',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('当前筛选下暂无待处理成员')
  })

  it('tests a saved integration with diagnostics and reuses the saved secret on the backend', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createTestResultPayload(),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const testButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('测试连通性'))
    expect(testButton).toBeTruthy()
    testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/integrations/test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          integrationId: 'dir-1',
          name: 'DingTalk CN',
          corpId: 'dingcorp',
          appKey: 'ding-app-key',
          appSecret: '',
          rootDepartmentId: '1',
          baseUrl: '',
          pageSize: 50,
          status: 'active',
          scheduleCron: '',
          defaultDeprovisionPolicy: 'mark_inactive',
          syncEnabled: true,
        }),
      }),
    )
    expect(container?.textContent).toContain('根部门子部门 0')
    expect(container?.textContent).toContain('根部门直属成员 1')
    expect(container?.textContent).toContain('根部门 1 当前仅返回 1 个直属成员')
  })

  it('unbinds a linked directory account', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount({
              linkStatus: 'linked',
              matchStrategy: 'manual_admin',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
              },
            }),
            reviewReasons: ['inactive_linked'],
          },
        ], {
          total: 1,
          needsBinding: 0,
          inactiveLinked: 1,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
          },
        })]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            linkStatus: 'unmatched',
            matchStrategy: 'manual_unbound',
            localUser: null,
          }),
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount({
              linkStatus: 'unmatched',
              matchStrategy: 'manual_unbound',
              localUser: null,
            }),
            reviewReasons: ['needs_binding'],
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          linkStatus: 'unmatched',
          matchStrategy: 'manual_unbound',
          localUser: null,
        })]),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const unbindButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('解除绑定'))
    expect(unbindButton).toBeTruthy()
    unbindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/account-1/unbind',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(container?.textContent).toContain('已解除绑定')
  })

  it('supports review-queue filtering and batch deprovision for linked inactive members', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding', 'missing_identity'],
          },
          {
            ...createAccount({
              id: 'account-2',
              externalUserId: '0447654442691175',
              openId: 'open-2',
              unionId: 'union-2',
              name: '停用成员',
              isActive: false,
              linkStatus: 'linked',
              matchStrategy: 'manual_admin',
              localUser: {
                id: 'user-2',
                email: 'bravo@example.com',
                name: 'Bravo',
              },
            }),
            reviewReasons: ['inactive_linked'],
          },
        ], {
          total: 2,
          needsBinding: 1,
          inactiveLinked: 1,
          missingIdentity: 1,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount(),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            openId: 'open-2',
            unionId: 'union-2',
            name: '停用成员',
            isActive: false,
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'bravo@example.com',
              name: 'Bravo',
            },
          }),
        ], { total: 2 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount({
              id: 'account-2',
              externalUserId: '0447654442691175',
              openId: 'open-2',
              unionId: 'union-2',
              name: '停用成员',
              isActive: false,
              linkStatus: 'linked',
              matchStrategy: 'manual_admin',
              localUser: {
                id: 'user-2',
                email: 'bravo@example.com',
                name: 'Bravo',
              },
            }),
            reviewReasons: ['inactive_linked'],
          },
        ], {
          total: 2,
          needsBinding: 1,
          inactiveLinked: 1,
          missingIdentity: 1,
        }, { queue: 'inactive_linked', total: 1 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'account-2',
              linkStatus: 'unmatched',
              localUser: null,
            },
          ],
          updatedCount: 1,
          disableDingTalkGrant: true,
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({
            stats: {
              departmentCount: 12,
              accountCount: 98,
              pendingLinkCount: 5,
              linkedCount: 87,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([], {
          total: 1,
          needsBinding: 1,
          inactiveLinked: 0,
          missingIdentity: 1,
        }, { queue: 'inactive_linked', total: 0 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount(),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            openId: 'open-2',
            unionId: 'union-2',
            name: '停用成员',
            isActive: false,
            linkStatus: 'unmatched',
            matchStrategy: 'manual_unbound',
            localUser: null,
          }),
        ], { total: 2 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const inactiveFilter = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('目录停用但仍已绑定'))
    expect(inactiveFilter).toBeTruthy()
    inactiveFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/review-items?page=1&pageSize=25&queue=inactive_linked')

    const selectCurrentQueueButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('选择当前队列'))
    expect(selectCurrentQueueButton).toBeTruthy()
    selectCurrentQueueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const batchButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量停权处理'))
    expect(batchButton).toBeTruthy()
    batchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-unbind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          accountIds: ['account-2'],
          disableDingTalkGrant: true,
        }),
      }),
    )
    await flushUi(4)
    expect(container?.textContent).toContain('当前筛选下暂无待处理成员')
  })

  it('supports batch binding selected review items', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
          {
            ...createAccount({
              id: 'account-2',
              externalUserId: '0447654442691175',
              unionId: 'union-2',
              openId: 'open-2',
              name: '待绑定成员 2',
            }),
            reviewReasons: ['needs_binding'],
          },
        ], {
          total: 2,
          needsBinding: 2,
          inactiveLinked: 0,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount(),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            unionId: 'union-2',
            openId: 'open-2',
            name: '待绑定成员 2',
          }),
        ], { total: 2 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            createAccount({
              linkStatus: 'linked',
              matchStrategy: 'manual_admin',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
              },
            }),
            createAccount({
              id: 'account-2',
              externalUserId: '0447654442691175',
              unionId: 'union-2',
              openId: 'open-2',
              name: '待绑定成员 2',
              linkStatus: 'linked',
              matchStrategy: 'manual_admin',
              localUser: {
                id: 'user-2',
                email: 'bravo@example.com',
                name: 'Bravo',
              },
            }),
          ],
          updatedCount: 2,
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({
            stats: {
              departmentCount: 12,
              accountCount: 98,
              pendingLinkCount: 2,
              linkedCount: 90,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([], {
          total: 0,
          needsBinding: 0,
          inactiveLinked: 0,
          missingIdentity: 0,
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            unionId: 'union-2',
            openId: 'open-2',
            name: '待绑定成员 2',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'bravo@example.com',
              name: 'Bravo',
            },
          }),
        ], { total: 2 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const bindInputs = Array.from(container!.querySelectorAll('input[placeholder="例如 user-123 或 alpha@example.com"]')) as HTMLInputElement[]
    expect(bindInputs.length).toBeGreaterThanOrEqual(2)

    bindInputs[0]!.value = 'alpha@example.com'
    bindInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    bindInputs[1]!.value = 'bravo@example.com'
    bindInputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const selectCurrentQueueButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('选择当前队列'))
    expect(selectCurrentQueueButton).toBeTruthy()
    selectCurrentQueueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const batchBindButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量绑定用户'))
    expect(batchBindButton).toBeTruthy()
    batchBindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: [
            {
              accountId: 'account-1',
              localUserRef: 'alpha@example.com',
              enableDingTalkGrant: true,
            },
            {
              accountId: 'account-2',
              localUserRef: 'bravo@example.com',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('已批量绑定 2 个目录成员')
    expect(container?.textContent).toContain('当前筛选下暂无待处理成员')
  })

  it('does not show the sparse root-member warning when child departments are present', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            ...createAccount(),
            reviewReasons: ['needs_binding'],
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()]),
      ))
      .mockResolvedValueOnce(createJsonResponse(createTestResultPayload({
        departmentSampleCount: 4,
        sampledDepartments: [
          { id: '1068569133', name: '产品部' },
          { id: '1068569134', name: '技术部' },
        ],
        diagnostics: {
          rootDepartmentChildCount: 4,
          rootDepartmentDirectUserCount: 1,
          rootDepartmentDirectUserHasMore: false,
          rootDepartmentDirectUserCountWithAccessLimit: 1,
          rootDepartmentDirectUserHasMoreWithAccessLimit: false,
          sampledRootDepartmentUsers: [
            { userId: '0447654442691174', name: '周华' },
          ],
          sampledRootDepartmentUsersWithAccessLimit: [
            { userId: '0447654442691174', name: '周华' },
          ],
        },
        warnings: [],
      })))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const testButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('测试连通性'))
    expect(testButton).toBeTruthy()
    testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushUi(6)

    expect(container?.textContent).toContain('根部门子部门 4')
    expect(container?.textContent).toContain('根部门直属成员 1')
    expect(container?.textContent).not.toContain('根部门 1 当前仅返回 1 个直属成员')
  })
})
