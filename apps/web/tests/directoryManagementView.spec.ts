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
    expect(apiFetchMock).toHaveBeenNthCalledWith(3, '/api/admin/directory/integrations/dir-1/accounts?page=1&pageSize=25')
    expect(container?.textContent).toContain('DingTalk CN')
    expect(container?.textContent).toContain('账号 98')
    expect(container?.textContent).toContain('completed')
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
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/accounts?page=1&pageSize=25')
    expect(container?.textContent).toContain('目录同步已完成')
    expect(container?.textContent).toContain('账号 99')
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

    const bindInput = container!.querySelector('input[placeholder="例如 user-123 或 alpha@example.com"]') as HTMLInputElement | null
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

    const bindButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('绑定用户'))
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
})
