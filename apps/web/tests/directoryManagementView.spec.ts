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

function registerRouterLink(app: App<Element>, withHref = false): void {
  app.component('RouterLink', {
    props: ['to'],
    computed: {
      resolvedHref(): string {
        return typeof this.to === 'string' ? this.to : String(this.to || '')
      },
    },
    template: withHref ? '<a :href="resolvedHref"><slot /></a>' : '<a><slot /></a>',
  })
}

function findAccountsSection(container: HTMLElement): HTMLElement {
  const section = Array.from(container.querySelectorAll('.directory-admin__section')).find((candidate) => candidate.textContent?.includes('成员账号'))
  if (!(section instanceof HTMLElement)) {
    throw new Error('Accounts section not found')
  }
  return section
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
      admissionMode: 'manual_only',
      admissionDepartmentIds: [],
      excludeDepartmentIds: [],
      memberGroupSyncMode: 'disabled',
      memberGroupDepartmentIds: [],
      memberGroupDefaultRoleIds: [],
      memberGroupDefaultNamespaces: [],
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
    openId: 'open-1',
    externalKey: 'union-1',
    name: '林岚',
    email: null,
    mobile: '13900001234',
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

function createScheduleSnapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      snapshot: {
        integrationId: 'dir-1',
        syncEnabled: true,
        scheduleCron: '*/15 * * * *',
        cronValid: true,
        nextExpectedRunAt: '2026-04-08T01:15:00.000Z',
        lastRun: {
          id: 'run-1',
          status: 'completed',
          startedAt: '2026-04-08T01:00:00.000Z',
          finishedAt: '2026-04-08T01:05:00.000Z',
          stats: {},
          errorMessage: null,
          triggeredBy: 'admin-1',
          triggerSource: 'manual',
          createdAt: '2026-04-08T01:00:00.000Z',
          updatedAt: '2026-04-08T01:05:00.000Z',
        },
        lastManualRun: {
          id: 'run-1',
          status: 'completed',
          startedAt: '2026-04-08T01:00:00.000Z',
          finishedAt: '2026-04-08T01:05:00.000Z',
          stats: {},
          errorMessage: null,
          triggeredBy: 'admin-1',
          triggerSource: 'manual',
          createdAt: '2026-04-08T01:00:00.000Z',
          updatedAt: '2026-04-08T01:05:00.000Z',
        },
        lastAutomaticRun: null,
        observationStatus: 'awaiting_first_run',
        observationMessage: '已配置 cron，等待首次自动触发或尚未观察到调度执行。',
        ...overrides,
      },
    },
  }
}

function createAlertListPayload(items: Record<string, unknown>[]) {
  return {
    ok: true,
    data: {
      items,
      total: items.length,
      page: 1,
      pageSize: 20,
      filter: 'all',
    },
  }
}

function createReviewItemsPayload(items: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      items,
      total: items.length,
      page: 1,
      pageSize: 100,
      filter: 'all',
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
        { userId: '0447654442691174', name: '林岚' },
      ],
      diagnostics: {
        rootDepartmentChildCount: 0,
        rootDepartmentDirectUserCount: 1,
        rootDepartmentDirectUserHasMore: false,
        rootDepartmentDirectUserCountWithAccessLimit: 1,
        rootDepartmentDirectUserHasMoreWithAccessLimit: false,
        sampledRootDepartmentUsers: [
          { userId: '0447654442691174', name: '林岚' },
        ],
        sampledRootDepartmentUsersWithAccessLimit: [
          { userId: '0447654442691174', name: '林岚' },
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
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  let scrollIntoViewMock = vi.fn()

  beforeEach(() => {
    apiFetchMock.mockReset()
    scrollIntoViewMock = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    })
    window.history.replaceState({}, '', '/')
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
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-1',
            integrationId: 'dir-1',
            runId: 'run-1',
            level: 'warning',
            code: 'root_department_sparse',
            message: '根部门直属成员过少',
            details: {},
            createdAt: '2026-04-08T01:06:00.000Z',
            acknowledgedAt: null,
            acknowledgedBy: null,
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount(),
            flags: {
              missingUnionId: false,
              missingOpenId: true,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()], { total: 60 }),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    expect(apiFetchMock).toHaveBeenNthCalledWith(1, '/api/admin/directory/integrations')
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/admin/directory/integrations/dir-1/runs?page=1&pageSize=10')
    expect(apiFetchMock).toHaveBeenNthCalledWith(3, '/api/admin/directory/integrations/dir-1/schedule')
    expect(apiFetchMock).toHaveBeenNthCalledWith(4, '/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=20&filter=all')
    expect(apiFetchMock).toHaveBeenNthCalledWith(5, '/api/admin/directory/integrations/dir-1/review-items?page=1&pageSize=100&filter=all')
    expect(apiFetchMock).toHaveBeenNthCalledWith(6, '/api/admin/directory/integrations/dir-1/accounts?page=1&pageSize=25')
    expect(container?.textContent).toContain('DingTalk CN')
    expect(container?.textContent).toContain('账号 98')
    expect(container?.textContent).toContain('completed')
    expect(container?.textContent).toContain('待处理队列')
    expect(container?.textContent).toContain('自动同步观测')
    expect(container?.textContent).toContain('最近告警')
    expect(container?.textContent).toContain('Union ID')
    expect(container?.textContent).toContain('0447654442691174')
    expect(container?.textContent).toContain('最近目录同步')
    expect(container?.textContent).toContain('第 1 / 3 页')
  })

  it('warns and disables DingTalk grant toggles when a directory account is missing openId', async () => {
    const missingOpenIdAccount = createAccount({
      openId: null,
      localUser: {
        id: 'user-1',
        email: 'alpha@example.com',
        username: 'alpha',
        name: 'Alpha',
      },
    })
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: missingOpenIdAccount,
            flags: {
              missingUnionId: false,
              missingOpenId: true,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([missingOpenIdAccount]),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('openId 缺失，当前无法同时开通钉钉登录')
    expect(container?.textContent).toContain('修复建议：若该成员刚完成钉钉登录/绑定，先刷新当前成员')
    const refreshButtons = Array.from(container!.querySelectorAll('button')).filter((button) => button.textContent?.includes('刷新当前成员'))
    expect(refreshButtons.length).toBeGreaterThanOrEqual(2)
    const userLinks = Array.from(container!.querySelectorAll('a')).filter((link) => link.textContent?.includes('前往用户管理'))
    expect(userLinks.length).toBeGreaterThanOrEqual(1)
    expect(userLinks[0]?.getAttribute('href')).toBe('/admin/users?userId=user-1&source=directory-sync&integrationId=dir-1&accountId=account-1&filter=dingtalk-openid-missing')
    const grantLabels = Array.from(container!.querySelectorAll('label.directory-admin__toggle'))
      .filter((label) => label.textContent?.includes('绑定后同时开通钉钉登录'))
    expect(grantLabels.length).toBeGreaterThanOrEqual(2)
    for (const label of grantLabels) {
      const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null
      expect(input?.disabled).toBe(true)
      expect(input?.checked).toBe(false)
    }
  })

  it('binds an openId-missing account without enabling DingTalk grant', async () => {
    const missingOpenIdAccount = createAccount({ openId: null })
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
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([missingOpenIdAccount]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            openId: null,
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
        data: { items: [createIntegration()] },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          openId: null,
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
          },
        })]),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    const accountsSection = findAccountsSection(container!)
    const bindInput = accountsSection.querySelector('input[placeholder="例如 user-123 或 alpha@example.com"]') as HTMLInputElement | null
    expect(bindInput).toBeTruthy()
    bindInput!.value = 'alpha@example.com'
    bindInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const bindButton = Array.from(accountsSection.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('绑定用户'))
    expect(bindButton).toBeTruthy()
    bindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(10)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/account-1/bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          localUserRef: 'alpha@example.com',
          enableDingTalkGrant: false,
        }),
      }),
    )
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
            kind: 'inactive_linked',
            reason: '目录成员已停用，但仍绑定本地用户，需要停权处理。',
            account: createAccount({
              isActive: false,
              linkStatus: 'linked',
              matchStrategy: 'external_identity',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
              },
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: true,
            },
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
          run: {
            id: 'run-2',
            status: 'completed',
            stats: {
              autoAdmittedCount: 2,
              autoAdmittedNoEmailCount: 1,
              autoAdmissionExcludedCount: 1,
              memberGroupsSyncedCount: 2,
              memberGroupsCreatedCount: 1,
              memberGroupGovernedUserCount: 3,
              memberGroupDefaultRoleAssignmentsCount: 4,
              memberGroupDefaultNamespaceAdmissionsCount: 6,
            },
          },
          autoAdmissionOnboardingPackets: [
            {
              userId: 'user-no-email-1',
              name: '林岚',
              email: null,
              username: 'dt_linlan_12345678',
              mobile: '13900001234',
              temporaryPassword: 'Tmp-NoEmail-123',
              onboarding: {
                accountLabel: 'dt_linlan_12345678',
                acceptInviteUrl: '',
                inviteMessage: '账号：dt_linlan_12345678\n临时密码：Tmp-NoEmail-123',
              },
            },
          ],
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
                autoAdmittedCount: 2,
                autoAdmittedNoEmailCount: 1,
                autoAdmissionExcludedCount: 1,
                memberGroupsSyncedCount: 2,
                memberGroupsCreatedCount: 1,
                memberGroupGovernedUserCount: 3,
                memberGroupDefaultRoleAssignmentsCount: 4,
                memberGroupDefaultNamespaceAdmissionsCount: 6,
              },
              errorMessage: null,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createScheduleSnapshotPayload({
          nextExpectedRunAt: '2026-04-08T02:15:00.000Z',
          lastRun: {
            id: 'run-2',
            status: 'completed',
            startedAt: '2026-04-08T02:00:00.000Z',
            finishedAt: '2026-04-08T02:05:00.000Z',
            stats: {},
            errorMessage: null,
            triggeredBy: 'system:directory-sync-scheduler',
            triggerSource: 'scheduler',
            createdAt: '2026-04-08T02:00:00.000Z',
            updatedAt: '2026-04-08T02:05:00.000Z',
          },
          lastAutomaticRun: {
            id: 'run-2',
            status: 'completed',
            startedAt: '2026-04-08T02:00:00.000Z',
            finishedAt: '2026-04-08T02:05:00.000Z',
            stats: {},
            errorMessage: null,
            triggeredBy: 'system:directory-sync-scheduler',
            triggerSource: 'scheduler',
            createdAt: '2026-04-08T02:00:00.000Z',
            updatedAt: '2026-04-08T02:05:00.000Z',
          },
          observationStatus: 'scheduler_observed',
          observationMessage: '已观察到调度器触发的自动同步。',
        }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-1',
            integrationId: 'dir-1',
            runId: 'run-2',
            level: 'warning',
            code: 'root_department_sparse',
            message: '根部门直属成员过少',
            details: {},
            createdAt: '2026-04-08T02:06:00.000Z',
            acknowledgedAt: null,
            acknowledgedBy: null,
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
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
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=20&filter=all')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/review-items?page=1&pageSize=100&filter=all')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/accounts?page=1&pageSize=25')
    expect(container?.textContent).toContain('目录同步已完成，自动准入 2 位成员，其中 1 位成员无邮箱，已生成平台登录账号和临时密码，1 位成员命中排除部门，未自动创建，同步 2 个成员组（新建 1 个），为 3 位成员补齐默认治理（角色新增 4 项，插件开通新增 6 项）')
    expect(container?.textContent).toContain('本次自动准入临时凭据')
    expect(container?.textContent).toContain('dt_linlan_12345678')
    expect(container?.textContent).toContain('Tmp-NoEmail-123')
    expect(container?.textContent).toContain('该账号未生成邀请链接，请直接分发登录账号和临时密码。')
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
        createScheduleSnapshotPayload(),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
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

  it('quick-binds a pending review item via batch-bind', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount(),
            flags: {
              missingUnionId: false,
              missingOpenId: true,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
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
          items: [
            {
              accountId: 'account-1',
              localUserRef: 'alpha@example.com',
              enableDingTalkGrant: true,
            },
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
              pendingLinkCount: 3,
              linkedCount: 89,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
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

    const bindButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('快速绑定'))
    expect(bindButton).toBeTruthy()
    bindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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
    expect(container?.textContent).toContain('已完成快速绑定')
    expect(container?.textContent).toContain('alpha@example.com')
  })

  it('creates a local user from a pending review item and binds it immediately', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-manual-create',
              name: '李青',
              email: null,
              mobile: '13900001234',
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: true,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: false,
            },
            recommendations: [],
            recommendationStatus: {
              code: 'no_exact_match',
              message: '未匹配到本地用户',
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-manual-create',
          name: '李青',
          email: null,
          mobile: '13900001234',
        })], { total: 1 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          user: {
            id: 'user-created',
            email: 'liqing@example.com',
            name: '李青',
            mobile: null,
            role: 'user',
            is_active: true,
          },
          roles: [],
          permissions: [],
          isAdmin: false,
          temporaryPassword: 'Temp#123456',
          onboarding: {
            acceptInviteUrl: 'https://example.com/invite/abc',
            inviteMessage: '请使用邀请链接加入平台',
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-manual-create',
          name: '李青',
          email: 'liqing@example.com',
          mobile: '13900001234',
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-created',
            email: 'liqing@example.com',
            name: '李青',
          },
        })], { total: 1 }),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    const toggleButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('手动创建用户'))
    expect(toggleButton).toBeTruthy()
    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const emailInput = Array.from(container!.querySelectorAll('input')).find((input) => input.getAttribute('type') === 'email') as HTMLInputElement | undefined
    expect(emailInput).toBeTruthy()
    emailInput!.value = 'liqing@example.com'
    emailInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const createAndBindButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('创建用户并绑定'))
    expect(createAndBindButton).toBeTruthy()
    createAndBindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(12)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/account-manual-create/admit-user',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '李青',
          email: 'liqing@example.com',
          mobile: '13900001234',
          enableDingTalkGrant: true,
        }),
      }),
    )
    expect(container?.textContent).toContain('最近创建并绑定结果')
    expect(container?.textContent).toContain('新用户临时密码：Temp#123456')
    expect(container?.textContent).toContain('https://example.com/invite/abc')
    expect(container?.textContent).toContain('请使用邀请链接加入平台')
    expect(container?.textContent).toContain('已创建本地用户并完成绑定')
  })

  it('supports no-email manual admission with username/mobile and shows temporary-password onboarding', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-manual-no-email',
              name: '林岚',
              email: null,
              mobile: '13900004567',
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: true,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: false,
            },
            recommendations: [],
            recommendationStatus: {
              code: 'no_exact_match',
              message: '未匹配到本地用户',
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-manual-no-email',
          name: '林岚',
          email: null,
          mobile: '13900004567',
        })], { total: 1 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          user: {
            id: 'user-created-no-email',
            email: null,
            username: 'linlan',
            name: '林岚',
            mobile: '13900004567',
            role: 'user',
            is_active: true,
          },
          roles: [],
          permissions: [],
          isAdmin: false,
          temporaryPassword: 'Temp#654321',
          onboarding: {
            accountLabel: 'linlan',
            acceptInviteUrl: '',
            inviteMessage: '账号：linlan',
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-manual-no-email',
          name: '林岚',
          email: null,
          mobile: '13900004567',
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-created-no-email',
            email: null,
            username: 'linlan',
            name: '林岚',
          },
        })], { total: 1 }),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    const toggleButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('手动创建用户'))
    expect(toggleButton).toBeTruthy()
    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const inputs = Array.from(container!.querySelectorAll('.directory-admin__review-item input'))
    const usernameInput = inputs.find((input) => input.getAttribute('placeholder') === '例如 liqing') as HTMLInputElement | undefined
    if (!usernameInput) throw new Error('Username input not found')
    usernameInput.value = 'linlan'
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const createAndBindButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('创建用户并绑定'))
    expect(createAndBindButton).toBeTruthy()
    createAndBindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(12)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/account-manual-no-email/admit-user',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '林岚',
          username: 'linlan',
          mobile: '13900004567',
          enableDingTalkGrant: true,
        }),
      }),
    )
    expect(container?.textContent).toContain('最近创建并绑定结果')
    expect(container?.textContent).toContain('新用户临时密码：Temp#654321')
    expect(container?.textContent).toContain('账号：linlan')
    expect(container?.textContent).toContain('登录账号')
    expect(container?.textContent).toContain('linlan')
    expect(container?.textContent).not.toContain('https://example.com/invite/abc')
  })

  it('creates and binds a no-email local user from the account list', async () => {
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
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-list-no-email',
          name: '王武',
          email: null,
          mobile: '13900008888',
        })], { total: 1 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          user: {
            id: 'user-created-list-no-email',
            email: null,
            username: 'wangwu',
            name: '王武',
            mobile: '13900008888',
            role: 'user',
            is_active: true,
          },
          temporaryPassword: 'Temp#888888',
          onboarding: {
            accountLabel: 'wangwu',
            acceptInviteUrl: '',
            inviteMessage: '账号：wangwu',
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-list-no-email',
          name: '王武',
          email: null,
          mobile: '13900008888',
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-created-list-no-email',
            email: null,
            username: 'wangwu',
            name: '王武',
          },
        })], { total: 1 }),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    const accountsSection = findAccountsSection(container!)
    const accountCard = accountsSection.querySelector('.directory-admin__account') as HTMLElement
    expect(accountCard).toBeTruthy()
    const toggleButton = Array.from(accountCard.querySelectorAll('button')).find((button) => button.textContent?.includes('手动创建用户'))
    expect(toggleButton).toBeTruthy()
    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const usernameInput = Array.from(accountCard.querySelectorAll('input')).find((input) => input.getAttribute('placeholder') === '例如 liqing') as HTMLInputElement | undefined
    expect(usernameInput).toBeTruthy()
    usernameInput!.value = 'wangwu'
    usernameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const createAndBindButton = Array.from(accountCard.querySelectorAll('button')).find((button) => button.textContent?.includes('创建用户并绑定'))
    expect(createAndBindButton).toBeTruthy()
    createAndBindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(12)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/account-list-no-email/admit-user',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '王武',
          username: 'wangwu',
          mobile: '13900008888',
          enableDingTalkGrant: true,
        }),
      }),
    )
    expect(container?.textContent).toContain('最近创建并绑定结果')
    expect(container?.textContent).toContain('新用户临时密码：Temp#888888')
    expect(container?.textContent).toContain('账号：wangwu')
    expect(container?.textContent).toContain('目录成员 王武 已创建本地用户并完成绑定')
  })

  it('focuses a reviewed account and quick-binds it from the accounts banner', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-focus',
              name: '定位成员',
              externalUserId: '0447654442691199',
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-other',
            name: '其他成员',
            externalUserId: '0447654442691188',
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
          }),
        ], { total: 1 }),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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

    const reviewBindInput = container!.querySelector('.directory-admin__review-item input[placeholder="例如 user-123 或 alpha@example.com"]') as HTMLInputElement | null
    expect(reviewBindInput).toBeTruthy()
    reviewBindInput!.value = 'alpha@example.com'
    reviewBindInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const focusButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('定位到成员'))
    expect(focusButton).toBeTruthy()
    focusButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/accounts?page=1&pageSize=25&q=0447654442691199')
    expect(scrollIntoViewMock).toHaveBeenCalledWith(expect.objectContaining({
      behavior: 'smooth',
      block: 'start',
    }))
    const focusCard = container!.querySelector('.directory-admin__focus-card')
    expect(focusCard?.textContent).toContain('当前定位成员：定位成员')
    expect(focusCard?.textContent).toContain('已在当前成员结果中高亮显示，可直接继续绑定、解绑或复核。')
    const focusedAccount = container!.querySelector('.directory-admin__account--focused')
    expect(focusedAccount?.textContent).toContain('定位成员')
    expect(focusedAccount?.textContent).toContain('已定位')
    const focusedAccountBindInput = focusedAccount?.querySelector('input[placeholder="例如 user-123 或 alpha@example.com"]') as HTMLInputElement | null
    expect(focusedAccountBindInput?.value).toBe('alpha@example.com')

    const quickBindButton = Array.from(focusCard?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('绑定当前成员'))
    expect(quickBindButton).toBeTruthy()
    quickBindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/account-focus/bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          localUserRef: 'alpha@example.com',
          enableDingTalkGrant: true,
        }),
      }),
    )
    expect(container?.textContent).toContain('目录成员 定位成员 已绑定到本地用户')
    expect(container?.textContent).toContain('alpha@example.com')
  })

  it('can auto-focus a directory member from user-management query params and expose a link back to user management', async () => {
    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-1&accountId=account-focus&source=user-management&userId=user-1')

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
          account: createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload()))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(12)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/accounts/account-focus')
    expect(container?.textContent).toContain('已从用户管理定位到目录成员 定位成员')
    expect(container?.textContent).toContain('当前定位成员：定位成员')

    const userLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('前往用户管理'))
    expect(userLink?.getAttribute('href')).toBe('/admin/users?userId=user-1&source=directory-sync&integrationId=dir-1&accountId=account-focus')
  })

  it('clears stale focus and shows a specific error when query targets a missing integration', async () => {
    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-1&accountId=account-focus&source=user-management&userId=user-1')

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
          account: createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload()))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
          createAccount({
            id: 'account-other',
            name: '恢复成员列表',
            externalUserId: '0447654442691200',
            linkStatus: 'unmatched',
            matchStrategy: 'none',
            localUser: null,
          }),
        ], { total: 2 }),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(12)

    expect(container?.textContent).toContain('当前定位成员：定位成员')

    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-missing&accountId=account-missing&source=user-management&userId=user-2')
    await flushUi(12)

    const accountsSection = findAccountsSection(container!)
    const routeBanner = accountsSection.querySelector('.directory-admin__route-banner')
    expect(routeBanner).toBeInstanceOf(HTMLElement)
    expect(routeBanner?.textContent).toContain('定位未完成')
    expect(routeBanner?.textContent).toContain('未找到目录集成 dir-missing')
    expect(routeBanner?.textContent).toContain('目标集成：dir-missing')
    expect(routeBanner?.textContent).toContain('目标成员：account-missing')
    expect(routeBanner?.textContent).toContain('当前仍停留在 DingTalk CN')
    const returnUserLink = Array.from(accountsSection.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('返回用户管理'))
    expect(returnUserLink?.getAttribute('href')).toBe('/admin/users?userId=user-2&source=directory-sync&directoryFailure=missing_integration&integrationId=dir-missing&accountId=account-missing')
    expect(container?.querySelector('.directory-admin__focus-card')).toBeNull()
    expect(container?.querySelector('.directory-admin__account--focused')).toBeNull()
    const accountSearch = container?.querySelector('input[placeholder="搜索姓名 / 邮箱 / 手机 / 钉钉 ID / 本地用户"]')
    expect(accountSearch).toBeInstanceOf(HTMLInputElement)
    expect((accountSearch as HTMLInputElement).value).toBe('')
    expect(container?.textContent).toContain('恢复成员列表')
    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/accounts/account-missing')).toHaveLength(0)

    const retainButton = Array.from(accountsSection.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('留在 DingTalk CN'))
    expect(retainButton).toBeTruthy()
    retainButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)
    expect(window.location.search).toBe('?integrationId=dir-1')
    expect(container?.textContent).toContain('已保留当前目录上下文 DingTalk CN')
    expect(findAccountsSection(container!).querySelector('.directory-admin__route-banner')).toBeNull()
  })

  it('clears stale focus and shows a specific error when query targets a missing account', async () => {
    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-1&accountId=account-focus&source=user-management&userId=user-1')

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
          account: createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload()))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({ ok: false }, 404))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(12)

    expect(container?.textContent).toContain('当前定位成员：定位成员')

    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-1&accountId=account-missing&source=user-management&userId=user-2')
    await flushUi(12)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/accounts/account-missing')
    const accountsSection = findAccountsSection(container!)
    const routeBanner = accountsSection.querySelector('.directory-admin__route-banner')
    expect(routeBanner).toBeInstanceOf(HTMLElement)
    expect(routeBanner?.textContent).toContain('定位未完成')
    expect(routeBanner?.textContent).toContain('未找到目录成员 account-missing')
    expect(routeBanner?.textContent).toContain('目标集成：dir-1')
    expect(routeBanner?.textContent).toContain('目标成员：account-missing')
    expect(routeBanner?.textContent).toContain('当前仍停留在 DingTalk CN')
    const returnUserLink = Array.from(accountsSection.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('返回用户管理'))
    expect(returnUserLink?.getAttribute('href')).toBe('/admin/users?userId=user-2&source=directory-sync&directoryFailure=missing_account&integrationId=dir-1&accountId=account-missing')
    expect(container?.querySelector('.directory-admin__focus-card')).toBeNull()
    expect(container?.querySelector('.directory-admin__account--focused')).toBeNull()
    const accountSearch = container?.querySelector('input[placeholder="搜索姓名 / 邮箱 / 手机 / 钉钉 ID / 本地用户"]')
    expect(accountSearch).toBeInstanceOf(HTMLInputElement)
    expect((accountSearch as HTMLInputElement).value).toBe('')
  })

  it('can retry route navigation from the failure banner after a missing account result', async () => {
    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-1&accountId=account-focus&source=user-management&userId=user-1')

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
          account: createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload()))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({ ok: false }, 404))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            id: 'account-missing',
            name: '重试定位成员',
            externalUserId: '0447654442692299',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'bravo@example.com',
              name: 'Bravo',
            },
          }),
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-missing',
            name: '重试定位成员',
            externalUserId: '0447654442692299',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'bravo@example.com',
              name: 'Bravo',
            },
          }),
        ], { total: 1 }),
      ))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(12)

    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-1&accountId=account-missing&source=user-management&userId=user-2')
    await flushUi(12)

    const accountsSection = findAccountsSection(container!)
    const retryButton = Array.from(accountsSection.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('重试定位'))
    expect(retryButton).toBeTruthy()
    retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(12)

    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/accounts/account-missing')).toHaveLength(2)
    expect(findAccountsSection(container!).querySelector('.directory-admin__route-banner')).toBeNull()
    expect(container?.textContent).toContain('已从用户管理定位到目录成员 重试定位成员')
    expect(container?.textContent).toContain('当前定位成员：重试定位成员')
  })

  it('can re-focus a directory member when query params change on the same mounted instance', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload()))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createAccountListPayload([
        createAccount({
          id: 'account-initial',
          name: '初始成员',
          externalUserId: '0447654442691100',
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-0',
            email: 'initial@example.com',
            name: 'Initial',
          },
        }),
      ], { total: 1 })))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-focus',
            name: '定位成员',
            externalUserId: '0447654442691199',
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
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(12)

    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-1&accountId=account-focus&source=user-management&userId=user-1')
    await flushUi(12)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/accounts/account-focus')
    expect(container?.textContent).toContain('已从用户管理定位到目录成员 定位成员')

    const userLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('前往用户管理'))
    expect(userLink?.getAttribute('href')).toBe('/admin/users?userId=user-1&source=directory-sync&integrationId=dir-1&accountId=account-focus')
  })

  it('can switch to a newly refreshed integration when query params target another integration', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({ id: 'dir-1', name: 'DingTalk CN 1', corpId: 'dingcorp-1' })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload({ integrationId: 'dir-1' })))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createAccountListPayload([
        createAccount({
          id: 'account-dir-1',
          integrationId: 'dir-1',
          name: '成员一',
          externalUserId: 'dir1-user',
        }),
      ], { total: 1 })))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            createIntegration({ id: 'dir-1', name: 'DingTalk CN 1', corpId: 'dingcorp-1' }),
            createIntegration({ id: 'dir-2', name: 'DingTalk CN 2', corpId: 'dingcorp-2' }),
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            id: 'account-dir-2',
            integrationId: 'dir-2',
            name: '切换成员',
            externalUserId: 'dir2-user',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'bravo@example.com',
              name: 'Bravo',
            },
          }),
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload({ integrationId: 'dir-2' })))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createAccountListPayload([
        createAccount({
          id: 'account-dir-2',
          integrationId: 'dir-2',
          name: '切换成员',
          externalUserId: 'dir2-user',
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-2',
            email: 'bravo@example.com',
            name: 'Bravo',
          },
        }),
      ], { total: 1 })))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(12)

    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-2&accountId=account-dir-2&source=user-management&userId=user-2')
    await flushUi(16)

    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/integrations')).toHaveLength(2)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/accounts/account-dir-2')
    expect(container?.textContent).toContain('已从用户管理定位到目录成员 切换成员')
    expect(container?.textContent).toContain('DingTalk CN 2')

    const userLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('前往用户管理'))
    expect(userLink?.getAttribute('href')).toBe('/admin/users?userId=user-2&source=directory-sync&integrationId=dir-2&accountId=account-dir-2')
  })

  it('keeps pending cross-integration navigation until a later refresh reveals the target integration', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({ id: 'dir-1', name: 'DingTalk CN 1', corpId: 'dingcorp-1' })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload({ integrationId: 'dir-1' })))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createAccountListPayload([
        createAccount({
          id: 'account-dir-1',
          integrationId: 'dir-1',
          name: '成员一',
          externalUserId: 'dir1-user',
        }),
      ], { total: 1 })))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration({ id: 'dir-1', name: 'DingTalk CN 1', corpId: 'dingcorp-1' })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(createAccountListPayload([
        createAccount({
          id: 'account-dir-1',
          integrationId: 'dir-1',
          name: '成员一',
          externalUserId: 'dir1-user',
        }),
        createAccount({
          id: 'account-dir-1b',
          integrationId: 'dir-1',
          name: '成员二',
          externalUserId: 'dir1-user-b',
        }),
      ], { total: 2 })))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            createIntegration({ id: 'dir-1', name: 'DingTalk CN 1', corpId: 'dingcorp-1' }),
            createIntegration({ id: 'dir-2', name: 'DingTalk CN 2', corpId: 'dingcorp-2' }),
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
            id: 'account-dir-2-late',
            integrationId: 'dir-2',
            name: '延迟出现成员',
            externalUserId: 'dir2-late-user',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'bravo@example.com',
              name: 'Bravo',
            },
          }),
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(createJsonResponse(createScheduleSnapshotPayload({ integrationId: 'dir-2' })))
      .mockResolvedValueOnce(createJsonResponse(createAlertListPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createReviewItemsPayload([])))
      .mockResolvedValueOnce(createJsonResponse(createAccountListPayload([
        createAccount({
          id: 'account-dir-2-late',
          integrationId: 'dir-2',
          name: '延迟出现成员',
          externalUserId: 'dir2-late-user',
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-2',
            email: 'bravo@example.com',
            name: 'Bravo',
          },
        }),
      ], { total: 1 })))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            createIntegration({ id: 'dir-1', name: 'DingTalk CN 1', corpId: 'dingcorp-1' }),
            createIntegration({ id: 'dir-2', name: 'DingTalk CN 2', corpId: 'dingcorp-2' }),
          ],
        },
      }))

    app = createApp(DirectoryManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(12)

    window.history.replaceState({}, '', '/admin/directory?integrationId=dir-2&accountId=account-dir-2-late&source=user-management&userId=user-2')
    await flushUi(12)

    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/integrations')).toHaveLength(2)
    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/accounts/account-dir-2-late')).toHaveLength(0)
    expect(container?.textContent).not.toContain('已从用户管理定位到目录成员 延迟出现成员')
    expect(container?.textContent).toContain('成员二')

    const refreshButton = Array.from(container!.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('刷新列表'))
    expect(refreshButton).toBeTruthy()
    refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(16)

    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/integrations')).toHaveLength(3)
    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/accounts/account-dir-2-late')).toHaveLength(1)
    expect(container?.textContent).toContain('已从用户管理定位到目录成员 延迟出现成员')

    refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(10)

    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/integrations')).toHaveLength(4)
    expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/directory/accounts/account-dir-2-late')).toHaveLength(1)
  })

  it('confirms a recommended pending binding', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              linkStatus: 'pending',
              matchStrategy: 'email',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
              },
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['pending_link', 'email'],
            }],
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
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
              id: 'account-1',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
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

    expect(container?.textContent).toContain('邮箱精确匹配')

    const confirmButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('确认推荐'))
    expect(confirmButton).toBeTruthy()
    confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: [
            {
              accountId: 'account-1',
              localUserRef: 'user-1',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('已确认推荐绑定')
  })

  it('requires explicit confirmation before overriding an existing user mobile during recommended binding', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-mobile-bind',
              mobile: '13900001234',
              linkStatus: 'pending',
              matchStrategy: 'mobile',
              localUser: null,
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                mobile: '13600000000',
                role: 'user',
                isActive: true,
              },
              reasons: ['mobile'],
            }],
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-mobile-bind',
          mobile: '13900001234',
          linkStatus: 'pending',
          matchStrategy: 'mobile',
        })]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          user: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            mobile: '13900001234',
          },
          roles: ['user'],
          permissions: [],
          isAdmin: false,
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'account-mobile-bind',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-mobile-bind',
          mobile: '13900001234',
          linkStatus: 'linked',
          matchStrategy: 'manual_admin',
          localUser: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
          },
        })]),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const backfillAndBindButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('回填手机号后绑定'))
    expect(backfillAndBindButton).toBeTruthy()
    backfillAndBindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    expect(apiFetchMock).not.toHaveBeenCalledWith(
      '/api/admin/users/user-1/profile',
      expect.anything(),
    )
    expect(container?.textContent).toContain('平台手机号：13600000000')
    expect(container?.textContent).toContain('目录手机号：13900001234')
    expect(container?.textContent).toContain('存在差异，覆盖前需确认。')
    expect(container?.textContent).toContain('确认覆盖手机号并绑定')

    const confirmOverrideButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('确认覆盖手机号并绑定'))
    expect(confirmOverrideButton).toBeTruthy()
    confirmOverrideButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(10)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/users/user-1/profile',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          mobile: '13900001234',
          expectedMobile: '13600000000',
        }),
      }),
    )
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: [
            {
              accountId: 'account-mobile-bind',
              localUserRef: 'user-1',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('已回填手机号并完成绑定')
  })

  it('clears override confirmation and refreshes review data when mobile CAS returns conflict', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-mobile-conflict',
              mobile: '13900001234',
              linkStatus: 'pending',
              matchStrategy: 'mobile',
              localUser: null,
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                mobile: '13600000000',
                role: 'user',
                isActive: true,
              },
              reasons: ['mobile'],
            }],
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-mobile-conflict',
          mobile: '13900001234',
          linkStatus: 'pending',
          matchStrategy: 'mobile',
        })]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: false,
        error: {
          code: 'PROFILE_MOBILE_CONFLICT',
          message: 'User mobile changed before update was applied',
        },
      }, 409))
      .mockResolvedValueOnce(createJsonResponse(
        {
          ok: true,
          data: {
            item: {
              kind: 'pending_binding',
              reason: '目录成员当前不是已确认绑定状态，建议复核。',
              account: createAccount({
                id: 'account-mobile-conflict',
                mobile: '13900001234',
                linkStatus: 'pending',
                matchStrategy: 'mobile',
                localUser: null,
              }),
              recommendations: [{
                localUser: {
                  id: 'user-1',
                  email: 'alpha@example.com',
                  name: 'Alpha',
                  mobile: '13700000000',
                  role: 'user',
                  isActive: true,
                },
                reasons: ['mobile'],
              }],
              flags: {
                missingUnionId: false,
                missingOpenId: false,
              },
              actionable: {
                canBatchUnbind: false,
                canConfirmRecommendation: true,
              },
            },
          },
        },
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          account: createAccount({
          id: 'account-mobile-conflict',
          mobile: '13900001234',
          linkStatus: 'pending',
          matchStrategy: 'mobile',
        }),
        },
      }))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const initialBackfillButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('回填手机号后绑定'))
    expect(initialBackfillButton).toBeTruthy()
    initialBackfillButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    const confirmOverrideButton = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).find((button) => button.textContent?.includes('确认覆盖手机号并绑定'))
    expect(confirmOverrideButton).toBeTruthy()
    confirmOverrideButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(10)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/users/user-1/profile',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          mobile: '13900001234',
          expectedMobile: '13600000000',
        }),
      }),
    )
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/accounts/account-mobile-conflict/review-item')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/accounts/account-mobile-conflict')
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.anything(),
    )
    expect(container?.textContent).toContain('平台手机号已被其他操作更新，请刷新后的最新差异为准')
    expect(container?.textContent).toContain('平台手机号已更新为 13700000000，请按最新差异重新确认。')
    expect(container?.textContent).not.toContain('确认覆盖手机号并绑定')
    expect(container?.textContent).toContain('按最新手机号重试')
    expect(container?.textContent).toContain('平台手机号：13700000000')
  })

  it('hides mobile backfill affordances when the directory and platform mobile already match', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-mobile-same',
              mobile: '13900001234',
              linkStatus: 'pending',
              matchStrategy: 'mobile',
              localUser: null,
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                mobile: '13900001234',
                role: 'user',
                isActive: true,
              },
              reasons: ['mobile'],
            }],
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount({
          id: 'account-mobile-same',
          mobile: '13900001234',
          linkStatus: 'pending',
          matchStrategy: 'mobile',
        })]),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).not.toContain('平台手机号：13900001234')
    expect(container?.textContent).not.toContain('目录手机号：13900001234')
    expect(container?.textContent).not.toContain('回填手机号后绑定')
    expect(container?.textContent).not.toContain('确认覆盖手机号并绑定')
  })

  it('batch-binds selected pending review items', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-1',
              name: '成员一',
              externalUserId: '0447654442691174',
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: true,
            },
            actionable: {
              canBatchUnbind: false,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-2',
              name: '成员二',
              externalUserId: '0447654442691175',
            }),
            flags: {
              missingUnionId: true,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-1',
            name: '成员一',
          }),
          createAccount({
            id: 'account-2',
            name: '成员二',
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              accountId: 'account-1',
              localUserRef: 'alpha@example.com',
              enableDingTalkGrant: true,
            },
            {
              accountId: 'account-2',
              localUserRef: 'beta@example.com',
              enableDingTalkGrant: true,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-1',
            name: '成员一',
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
            name: '成员二',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'beta@example.com',
              name: 'Beta',
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

    const pendingInputs = Array.from(container!.querySelectorAll('.directory-admin__review-item input[placeholder="例如 user-123 或 alpha@example.com"]')) as HTMLInputElement[]
    expect(pendingInputs).toHaveLength(2)
    pendingInputs[0].value = 'alpha@example.com'
    pendingInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    pendingInputs[1].value = 'beta@example.com'
    pendingInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const reviewCheckboxes = Array.from(container!.querySelectorAll('.directory-admin__review-item .directory-admin__review-select input[type="checkbox"]')) as HTMLInputElement[]
    reviewCheckboxes[0].checked = true
    reviewCheckboxes[0].dispatchEvent(new Event('change', { bubbles: true }))
    reviewCheckboxes[1].checked = true
    reviewCheckboxes[1].dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const batchButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量绑定'))
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
              localUserRef: 'beta@example.com',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('已完成 2 个目录成员的批量绑定')
    expect(container?.textContent).toContain('暂无待处理项')
  })

  it('batch-confirms recommended pending bindings', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-1',
              name: '成员一',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-2',
              name: '成员二',
              externalUserId: '0447654442691175',
            }),
            recommendations: [{
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
                name: 'Beta',
                role: 'user',
                isActive: true,
              },
              reasons: ['mobile'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-1',
            name: '成员一',
          }),
          createAccount({
            id: 'account-2',
            name: '成员二',
            externalUserId: '0447654442691175',
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'account-1',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
              },
            },
            {
              id: 'account-2',
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-1',
            name: '成员一',
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
            name: '成员二',
            externalUserId: '0447654442691175',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'beta@example.com',
              name: 'Beta',
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

    const reviewCheckboxes = Array.from(container!.querySelectorAll('.directory-admin__review-item .directory-admin__review-select input[type="checkbox"]')) as HTMLInputElement[]
    expect(reviewCheckboxes).toHaveLength(2)

    reviewCheckboxes[0].checked = true
    reviewCheckboxes[0].dispatchEvent(new Event('change', { bubbles: true }))
    reviewCheckboxes[1].checked = true
    reviewCheckboxes[1].dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const batchConfirmButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量确认推荐'))
    expect(batchConfirmButton).toBeTruthy()
    batchConfirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: [
            {
              accountId: 'account-1',
              localUserRef: 'user-1',
              enableDingTalkGrant: true,
            },
            {
              accountId: 'account-2',
              localUserRef: 'user-2',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('已完成 2 个目录成员的推荐绑定确认')
    expect(container?.textContent).toContain('处理进度')
    expect(container?.textContent).toContain('推荐绑定确认')
    expect(container?.textContent).toContain('已完成')
    expect(container?.textContent).toContain('进度 2 / 2')
  })

  it('shows visible progress while batch-confirming recommended pending bindings', async () => {
    let resolveBatchBindResponse: ((value: unknown) => void) | null = null

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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-progress',
              name: '进度成员',
            }),
            recommendations: [{
              localUser: {
                id: 'user-progress',
                email: 'progress@example.com',
                name: 'Progress',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-progress',
            name: '进度成员',
          }),
        ]),
      ))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveBatchBindResponse = resolve
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-progress',
            name: '进度成员',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-progress',
              email: 'progress@example.com',
              name: 'Progress',
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

    const batchConfirmButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量确认推荐 (1)'))
    expect(batchConfirmButton).toBeTruthy()
    batchConfirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    expect(container?.textContent).toContain('处理进度')
    expect(container?.textContent).toContain('推荐绑定确认')
    expect(container?.textContent).toContain('提交中')
    expect(container?.textContent).toContain('进度 0 / 1')

    resolveBatchBindResponse?.(createJsonResponse({
      ok: true,
      data: {
        items: [
          {
            id: 'account-progress',
            localUser: {
              id: 'user-progress',
              email: 'progress@example.com',
            },
          },
        ],
      },
    }))
    await flushUi(8)

    expect(container?.textContent).toContain('已完成 1 个目录成员的推荐绑定确认')
    expect(container?.textContent).toContain('已完成')
    expect(container?.textContent).toContain('进度 1 / 1')
  })

  it('filters review queue by recommendation readiness and selects visible recommended items', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-recommended',
              name: '可推荐成员',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-manual',
              name: '人工成员',
              externalUserId: '0447654442691175',
            }),
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
          },
          {
            kind: 'inactive_linked',
            reason: '目录成员已停用，但仍绑定本地用户，需要停权处理。',
            account: createAccount({
              id: 'account-inactive',
              name: '停用成员',
              isActive: false,
              linkStatus: 'linked',
              matchStrategy: 'external_identity',
              localUser: {
                id: 'user-9',
                email: 'inactive@example.com',
                name: 'Inactive',
              },
            }),
            recommendations: [],
            recommendationStatus: null,
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: true,
              canConfirmRecommendation: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-recommended',
            name: '可推荐成员',
          }),
          createAccount({
            id: 'account-manual',
            name: '人工成员',
            externalUserId: '0447654442691175',
          }),
          createAccount({
            id: 'account-inactive',
            name: '停用成员',
            isActive: false,
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'account-recommended',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
              },
            },
          ],
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-manual',
              name: '人工成员',
              externalUserId: '0447654442691175',
            }),
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
          },
          {
            kind: 'inactive_linked',
            reason: '目录成员已停用，但仍绑定本地用户，需要停权处理。',
            account: createAccount({
              id: 'account-inactive',
              name: '停用成员',
              isActive: false,
              linkStatus: 'linked',
              matchStrategy: 'external_identity',
              localUser: {
                id: 'user-9',
                email: 'inactive@example.com',
                name: 'Inactive',
              },
            }),
            recommendations: [],
            recommendationStatus: null,
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: true,
              canConfirmRecommendation: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-recommended',
            name: '可推荐成员',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
          createAccount({
            id: 'account-manual',
            name: '人工成员',
            externalUserId: '0447654442691175',
          }),
          createAccount({
            id: 'account-inactive',
            name: '停用成员',
            isActive: false,
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

    expect(container?.textContent).toContain('待绑定中：可推荐 1 · 需人工 1')

    const reviewCardsAfterDefaultLoad = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCardsAfterDefaultLoad.join(' ')).toContain('可推荐成员')
    expect(reviewCardsAfterDefaultLoad.join(' ')).toContain('已命中唯一精确候选，可直接确认推荐绑定。')
    expect(reviewCardsAfterDefaultLoad.join(' ')).not.toContain('人工成员')
    expect(reviewCardsAfterDefaultLoad.join(' ')).not.toContain('停用成员')

    const initialBatchConfirmButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量确认推荐 (1)'))
    expect(initialBatchConfirmButton).toBeTruthy()

    const clearSelectionButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('清空选择'))
    expect(clearSelectionButton).toBeTruthy()
    clearSelectionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    expect(container?.textContent).toContain('批量确认推荐 (0)')

    const selectRecommendedButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('选择可推荐 (1)'))
    expect(selectRecommendedButton).toBeTruthy()
    selectRecommendedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    expect(container?.textContent).toContain('批量确认推荐 (1)')

    const batchConfirmButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量确认推荐 (1)'))
    expect(batchConfirmButton).toBeTruthy()
    batchConfirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/accounts/batch-bind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: [
            {
              accountId: 'account-recommended',
              localUserRef: 'user-1',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )

    const manualFilter = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('需人工处理 (1)'))
    expect(manualFilter).toBeTruthy()
    manualFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const reviewCardsAfterManualFilter = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCardsAfterManualFilter.join(' ')).toContain('人工成员')
    expect(reviewCardsAfterManualFilter.join(' ')).toContain('未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。')
    expect(reviewCardsAfterManualFilter.join(' ')).not.toContain('可推荐成员')
  })

  it('loads additional review queue pages and resets to the first page on refresh', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-1-recommended',
              name: '第一页推荐成员',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-page-1-manual',
              name: '第一页人工成员',
              externalUserId: '0447654442691175',
            }),
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
          },
        ], { total: 3, page: 1, pageSize: 100 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-page-1-recommended',
            name: '第一页推荐成员',
          }),
          createAccount({
            id: 'account-page-1-manual',
            name: '第一页人工成员',
            externalUserId: '0447654442691175',
          }),
        ], { total: 3 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-2-recommended',
              name: '第二页推荐成员',
              externalUserId: '0447654442691176',
            }),
            recommendations: [{
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
                name: 'Beta',
                role: 'user',
                isActive: true,
              },
              reasons: ['mobile'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ], { total: 3, page: 2, pageSize: 100 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-1-recommended',
              name: '第一页推荐成员',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-page-1-manual',
              name: '第一页人工成员',
              externalUserId: '0447654442691175',
            }),
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
          },
        ], { total: 3, page: 1, pageSize: 100 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('当前已加载 2 / 3 项')
    expect(container?.textContent).toContain('加载更多 (1)')

    let reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('第一页推荐成员')
    expect(reviewCards.join(' ')).not.toContain('第一页人工成员')

    const loadMoreButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('加载更多 (1)'))
    expect(loadMoreButton).toBeTruthy()
    loadMoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/review-items?page=2&pageSize=100&filter=all')
    expect(container?.textContent).toContain('当前已加载 3 / 3 项')

    reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('第二页推荐成员')

    const refreshQueueButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('刷新队列'))
    expect(refreshQueueButton).toBeTruthy()
    refreshQueueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenLastCalledWith('/api/admin/directory/integrations/dir-1/review-items?page=1&pageSize=100&filter=all')
    expect(container?.textContent).toContain('当前已加载 2 / 3 项')

    reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('第一页推荐成员')
    expect(reviewCards.join(' ')).not.toContain('第二页推荐成员')
  })

  it('filters manual review items by recommendationStatus reason', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-no-match',
              name: '无精确匹配成员',
              externalUserId: '0447654442691174',
            }),
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
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-ambiguous',
              name: '精确匹配冲突成员',
              externalUserId: '0447654442691175',
            }),
            recommendations: [],
            recommendationStatus: {
              code: 'ambiguous_exact_match',
              message: '命中多个精确候选，请人工确认绑定目标。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-no-match',
            name: '无精确匹配成员',
            externalUserId: '0447654442691174',
          }),
          createAccount({
            id: 'account-ambiguous',
            name: '精确匹配冲突成员',
            externalUserId: '0447654442691175',
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [createIntegration()],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-no-match',
              name: '无精确匹配成员',
              externalUserId: '0447654442691174',
            }),
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
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-ambiguous',
              name: '精确匹配冲突成员',
              externalUserId: '0447654442691175',
            }),
            recommendations: [],
            recommendationStatus: {
              code: 'ambiguous_exact_match',
              message: '命中多个精确候选，请人工确认绑定目标。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-no-match',
            name: '无精确匹配成员',
            externalUserId: '0447654442691174',
          }),
          createAccount({
            id: 'account-ambiguous',
            name: '精确匹配冲突成员',
            externalUserId: '0447654442691175',
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

    expect(container?.textContent).toContain('待绑定中：可推荐 0 · 需人工 2')
    expect(container?.textContent).toContain('全部人工')
    expect(container?.textContent).toContain('无精确匹配')
    expect(container?.textContent).toContain('冲突待复核')

    const noExactMatchFilter = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('无精确匹配'))
    expect(noExactMatchFilter).toBeTruthy()
    noExactMatchFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    let reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('无精确匹配成员')
    expect(reviewCards.join(' ')).not.toContain('精确匹配冲突成员')

    const conflictFilter = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('冲突待复核'))
    expect(conflictFilter).toBeTruthy()
    conflictFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('精确匹配冲突成员')
    expect(reviewCards.join(' ')).not.toContain('无精确匹配成员')

    const allManualFilter = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('全部人工'))
    expect(allManualFilter).toBeTruthy()
    allManualFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('无精确匹配成员')
    expect(reviewCards.join(' ')).toContain('精确匹配冲突成员')
  })

  it('loads more review items and refreshes back to the first page', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-1-a',
              name: '第一页成员一',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-1-b',
              name: '第一页成员二',
              externalUserId: '0447654442691175',
            }),
            recommendations: [{
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
                name: 'Beta',
                role: 'user',
                isActive: true,
              },
              reasons: ['mobile'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ], { total: 3, page: 1, pageSize: 100 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-2',
              name: '第二页成员',
              externalUserId: '0447654442691176',
            }),
            recommendations: [{
              localUser: {
                id: 'user-3',
                email: 'gamma@example.com',
                name: 'Gamma',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ], { total: 3, page: 2, pageSize: 100 }),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-1-a',
              name: '第一页成员一',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-page-1-b',
              name: '第一页成员二',
              externalUserId: '0447654442691175',
            }),
            recommendations: [{
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
                name: 'Beta',
                role: 'user',
                isActive: true,
              },
              reasons: ['mobile'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
        ], { total: 2, page: 1, pageSize: 100 }),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('当前已加载 2 / 3 项')
    expect(container?.textContent).toContain('第一页成员一')
    expect(container?.textContent).toContain('第一页成员二')
    expect(container?.textContent).not.toContain('第二页成员')

    const loadMoreButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('加载更多 (1)'))
    expect(loadMoreButton).toBeTruthy()
    loadMoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/review-items?page=2&pageSize=100&filter=all')
    expect(container?.textContent).toContain('当前已加载 3 / 3 项')
    expect(container?.textContent).toContain('第二页成员')
    expect(container?.textContent).not.toContain('加载更多 (1)')

    const refreshQueueButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('刷新队列'))
    expect(refreshQueueButton).toBeTruthy()
    refreshQueueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    expect(container?.textContent).toContain('当前已加载 2 / 2 项')
    expect(container?.textContent).not.toContain('第二页成员')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/review-items?page=1&pageSize=100&filter=all')
  })

  it('keeps the manual review view on queue refresh after the user explicitly switches to it', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-recommended',
              name: '可推荐成员',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-manual',
              name: '人工成员',
              externalUserId: '0447654442691175',
            }),
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
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-recommended',
            name: '可推荐成员',
          }),
          createAccount({
            id: 'account-manual',
            name: '人工成员',
            externalUserId: '0447654442691175',
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员当前不是已确认绑定状态，建议复核。',
            account: createAccount({
              id: 'account-recommended',
              name: '可推荐成员',
            }),
            recommendations: [{
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
                role: 'user',
                isActive: true,
              },
              reasons: ['email'],
            }],
            recommendationStatus: {
              code: 'recommended',
              message: '已命中唯一精确候选，可直接确认推荐绑定。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: true,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-manual',
              name: '人工成员',
              externalUserId: '0447654442691175',
            }),
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
          },
        ]),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('批量确认推荐 (1)')

    const manualFilter = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('需人工处理 (1)'))
    expect(manualFilter).toBeTruthy()
    manualFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    const reviewCardsAfterManualFilter = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCardsAfterManualFilter.join(' ')).toContain('人工成员')
    expect(reviewCardsAfterManualFilter.join(' ')).not.toContain('可推荐成员')

    const refreshQueueButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('刷新队列'))
    expect(refreshQueueButton).toBeTruthy()
    refreshQueueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    const reviewCardsAfterRefresh = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCardsAfterRefresh.join(' ')).toContain('人工成员')
    expect(reviewCardsAfterRefresh.join(' ')).not.toContain('可推荐成员')
    expect(container?.textContent).toContain('批量确认推荐 (0)')
  })

  it('filters manual review items by recommendation reason and falls back when the chosen reason disappears', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-no-match',
              name: '无匹配成员',
            }),
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
          },
          {
            kind: 'pending_binding',
            reason: '待确认绑定与候选用户不一致，需要人工复核。',
            account: createAccount({
              id: 'account-conflict',
              name: '冲突成员',
              externalUserId: '0447654442691175',
            }),
            recommendations: [],
            recommendationStatus: {
              code: 'pending_link_conflict',
              message: '现有待确认匹配与精确候选不一致，请人工复核。',
            },
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
              canConfirmRecommendation: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-no-match',
            name: '无匹配成员',
          }),
          createAccount({
            id: 'account-conflict',
            name: '冲突成员',
            externalUserId: '0447654442691175',
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-no-match',
              name: '无匹配成员',
            }),
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
          },
        ]),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('待绑定中：可推荐 0 · 需人工 2')
    expect(container?.textContent).toContain('人工处理中：无精确匹配 1 · 冲突待复核 1')

    const allManualButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('全部人工 (2)'))
    const noMatchButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('无精确匹配 (1)'))
    const conflictButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('冲突待复核 (1)'))
    expect(allManualButton).toBeTruthy()
    expect(noMatchButton).toBeTruthy()
    expect(conflictButton).toBeTruthy()

    noMatchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    let reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('无匹配成员')
    expect(reviewCards.join(' ')).toContain('未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。')
    expect(reviewCards.join(' ')).not.toContain('冲突成员')

    conflictButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('冲突成员')
    expect(reviewCards.join(' ')).toContain('现有待确认匹配与精确候选不一致，请人工复核。')
    expect(reviewCards.join(' ')).not.toContain('无匹配成员')

    const refreshQueueButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('刷新队列'))
    expect(refreshQueueButton).toBeTruthy()
    refreshQueueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(4)

    reviewCards = Array.from(container!.querySelectorAll('.directory-admin__review-item'))
      .map((item) => item.textContent ?? '')
    expect(reviewCards.join(' ')).toContain('无匹配成员')
    expect(reviewCards.join(' ')).not.toContain('冲突成员')
    expect(container?.textContent).toContain('人工处理中：无精确匹配 1 · 冲突待复核 0')
  })

  it('batch-binds pending review items', async () => {
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-1',
              name: '林岚',
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
            },
          },
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              id: 'account-2',
              externalUserId: '0447654442691175',
              name: '次页成员',
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({ id: 'account-1' }),
          createAccount({ id: 'account-2', externalUserId: '0447654442691175', name: '次页成员' }),
        ]),
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
          items: [
            {
              id: 'user-2',
              email: 'beta@example.com',
              name: 'Beta',
              role: 'user',
              is_active: true,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'account-1',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
              },
            },
            {
              id: 'account-2',
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
              },
            },
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
              pendingLinkCount: 2,
              linkedCount: 90,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-1',
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
            name: '次页成员',
            linkStatus: 'linked',
            matchStrategy: 'manual_admin',
            localUser: {
              id: 'user-2',
              email: 'beta@example.com',
              name: 'Beta',
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

    const reviewCheckboxes = Array.from(container!.querySelectorAll('.directory-admin__review-item .directory-admin__review-select input[type="checkbox"]')) as HTMLInputElement[]
    expect(reviewCheckboxes).toHaveLength(2)

    const searchButtons = Array.from(container!.querySelectorAll('.directory-admin__review-item button')).filter((button) => button.textContent?.includes('搜索本地用户'))
    expect(searchButtons).toHaveLength(2)

    const reviewInputs = Array.from(container!.querySelectorAll('.directory-admin__review-item input[placeholder=\"例如 user-123 或 alpha@example.com\"]')) as HTMLInputElement[]
    reviewInputs[0].value = 'alpha@example.com'
    reviewInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    reviewInputs[1].value = 'beta@example.com'
    reviewInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    searchButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(3)
    searchButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(3)

    const reviewSearchResults = Array.from(container!.querySelectorAll('.directory-admin__review-item .directory-admin__search-result'))
    expect(reviewSearchResults.length).toBeGreaterThanOrEqual(2)
    reviewSearchResults[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)
    reviewSearchResults[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(2)

    reviewCheckboxes[0].checked = true
    reviewCheckboxes[0].dispatchEvent(new Event('change', { bubbles: true }))
    reviewCheckboxes[1].checked = true
    reviewCheckboxes[1].dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const batchBindButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('批量绑定'))
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
              localUserRef: 'beta@example.com',
              enableDingTalkGrant: true,
            },
          ],
        }),
      }),
    )
    expect(container?.textContent).toContain('批量绑定')
    expect(container?.textContent).toContain('处理进度')
    expect(container?.textContent).toContain('批量绑定')
    expect(container?.textContent).toContain('已完成')
    expect(container?.textContent).toContain('进度 2 / 2')
    expect(container?.textContent).toContain('暂无待处理项')
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
        createReviewItemsPayload([]),
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

    const includeTextarea = container!.querySelector('textarea[placeholder*="将覆盖所选部门及其子部门"]') as HTMLTextAreaElement | null
    const excludeTextarea = container!.querySelector('textarea[placeholder*="会覆盖白名单父部门"]') as HTMLTextAreaElement | null
    const roleTextarea = container!.querySelector('textarea[placeholder*="填写 role ID"]') as HTMLTextAreaElement | null
    const namespaceTextarea = container!.querySelector('textarea[placeholder*="填写命名空间"]') as HTMLTextAreaElement | null
    expect(includeTextarea).toBeTruthy()
    expect(excludeTextarea).toBeTruthy()
    expect(roleTextarea).toBeTruthy()
    expect(namespaceTextarea).toBeTruthy()
    includeTextarea!.value = 'dept-root\ndept-child'
    includeTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    excludeTextarea!.value = 'dept-private'
    excludeTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    roleTextarea!.value = 'crm_user\nsales_user'
    roleTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    namespaceTextarea!.value = 'crm\nsales'
    namespaceTextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

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
          admissionMode: 'manual_only',
          admissionDepartmentIds: ['dept-root', 'dept-child'],
          excludeDepartmentIds: ['dept-private'],
          memberGroupSyncMode: 'disabled',
          memberGroupDepartmentIds: [],
          memberGroupDefaultRoleIds: ['crm_user', 'sales_user'],
          memberGroupDefaultNamespaces: ['crm', 'sales'],
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
            kind: 'inactive_linked',
            reason: '目录成员已停用，但仍绑定本地用户，需要停权处理。',
            account: createAccount({
              linkStatus: 'linked',
              matchStrategy: 'manual_admin',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
              },
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: true,
            },
          },
        ]),
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
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount({
              linkStatus: 'unmatched',
              matchStrategy: 'manual_unbound',
              localUser: null,
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: false,
            },
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

  it('batch unbinds inactive linked review items', async () => {
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
            kind: 'inactive_linked',
            reason: '目录成员已停用，但仍绑定本地用户，需要停权处理。',
            account: createAccount({
              id: 'account-1',
              isActive: false,
              linkStatus: 'linked',
              matchStrategy: 'external_identity',
              localUser: {
                id: 'user-1',
                email: 'alpha@example.com',
                name: 'Alpha',
              },
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: true,
            },
          },
          {
            kind: 'inactive_linked',
            reason: '目录成员已停用，但仍绑定本地用户，需要停权处理。',
            account: createAccount({
              id: 'account-2',
              externalUserId: '0447654442691175',
              name: '次页成员',
              isActive: false,
              linkStatus: 'linked',
              matchStrategy: 'external_identity',
              localUser: {
                id: 'user-2',
                email: 'beta@example.com',
                name: 'Beta',
              },
            }),
            flags: {
              missingUnionId: false,
              missingOpenId: false,
            },
            actionable: {
              canBatchUnbind: true,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-1',
            isActive: false,
            linkStatus: 'linked',
            localUser: {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
            },
          }),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            name: '次页成员',
            isActive: false,
            linkStatus: 'linked',
            localUser: {
              id: 'user-2',
              email: 'beta@example.com',
              name: 'Beta',
            },
          }),
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            { id: 'account-1' },
            { id: 'account-2' },
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
              pendingLinkCount: 6,
              linkedCount: 86,
              lastRunStatus: 'completed',
            },
          })],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([
          createAccount({
            id: 'account-1',
            isActive: false,
            linkStatus: 'unmatched',
            matchStrategy: 'manual_unbound',
            localUser: null,
          }),
          createAccount({
            id: 'account-2',
            externalUserId: '0447654442691175',
            name: '次页成员',
            isActive: false,
            linkStatus: 'unmatched',
            matchStrategy: 'manual_unbound',
            localUser: null,
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

    const checkboxes = Array.from(container!.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
    const reviewCheckboxes = checkboxes.filter((input) => input.closest('.directory-admin__review-item'))
    expect(reviewCheckboxes).toHaveLength(2)
    reviewCheckboxes[0].checked = true
    reviewCheckboxes[0].dispatchEvent(new Event('change', { bubbles: true }))
    reviewCheckboxes[1].checked = true
    reviewCheckboxes[1].dispatchEvent(new Event('change', { bubbles: true }))
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
          accountIds: ['account-1', 'account-2'],
          disableDingTalkGrant: true,
        }),
      }),
    )
    expect(container?.textContent).toContain('批量停权处理')
    expect(container?.textContent).toContain('处理进度')
    expect(container?.textContent).toContain('已完成')
    expect(container?.textContent).toContain('进度 2 / 2')
    expect(container?.textContent).toContain('暂无待处理项')
  })

  it('acknowledges a pending directory alert and refreshes the alert list', async () => {
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
            level: 'warning',
            code: 'root_department_sparse',
            message: '根部门直属成员过少',
            details: {},
            createdAt: '2026-04-08T01:06:00.000Z',
            acknowledgedAt: null,
            acknowledgedBy: null,
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createReviewItemsPayload([
          {
            kind: 'pending_binding',
            reason: '目录成员尚未绑定本地用户。',
            account: createAccount(),
            flags: {
              missingUnionId: false,
              missingOpenId: true,
            },
            actionable: {
              canBatchUnbind: false,
            },
          },
        ]),
      ))
      .mockResolvedValueOnce(createJsonResponse(
        createAccountListPayload([createAccount()]),
      ))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          alert: {
            id: 'alert-1',
            acknowledgedAt: '2026-04-08T01:10:00.000Z',
            acknowledgedBy: 'admin-1',
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse(
        createAlertListPayload([
          {
            id: 'alert-1',
            integrationId: 'dir-1',
            runId: 'run-1',
            level: 'warning',
            code: 'root_department_sparse',
            message: '根部门直属成员过少',
            details: {},
            createdAt: '2026-04-08T01:06:00.000Z',
            acknowledgedAt: '2026-04-08T01:10:00.000Z',
            acknowledgedBy: 'admin-1',
          },
        ]),
      ))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const ackButton = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('确认告警'))
    expect(ackButton).toBeTruthy()
    ackButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/alerts/alert-1/ack',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=20&filter=all')
    expect(container?.textContent).toContain('目录告警已确认')
    expect(container?.textContent).toContain('已确认')
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
        createReviewItemsPayload([]),
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
            { userId: '0447654442691174', name: '林岚' },
          ],
          sampledRootDepartmentUsersWithAccessLimit: [
            { userId: '0447654442691174', name: '林岚' },
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
