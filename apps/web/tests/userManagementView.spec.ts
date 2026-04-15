import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasAdminAccess: () => true,
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitForCondition(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushUi(2)
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Condition not reached in time')
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

function findUserRow(container: HTMLElement, keyword: string): HTMLElement {
  const row = Array.from(container.querySelectorAll('.user-admin__user')).find((candidate) => candidate.textContent?.includes(keyword))
  if (!(row instanceof HTMLElement)) {
    throw new Error(`User row not found: ${keyword}`)
  }
  return row
}

function findNamespaceSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector('select[aria-label="插件命名空间"]')
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error('Namespace select not found')
  }
  return select
}

async function setSearchValue(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector('input[type="search"]')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Search input not found')
  }
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

type UserFixture = {
  id: string
  email: string
  name: string
  role: string
  is_active: boolean
  grantEnabled: boolean
  directoryLinked: boolean
  namespaceAdmissions: Array<{
    namespace: string
    enabled: boolean
    effective: boolean
    hasRole: boolean
    updatedAt: string
  }>
}

function createApiState(): UserFixture[] {
  return [
    {
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      role: 'user',
      is_active: true,
      grantEnabled: true,
      directoryLinked: true,
      namespaceAdmissions: [
        {
          namespace: 'crm',
          enabled: false,
          effective: false,
          hasRole: true,
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'user-2',
      email: 'bravo@example.com',
      name: 'Bravo',
      role: 'user',
      is_active: true,
      grantEnabled: false,
      directoryLinked: false,
      namespaceAdmissions: [
        {
          namespace: 'crm',
          enabled: false,
          effective: false,
          hasRole: true,
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'user-3',
      email: 'charlie@example.com',
      name: 'Charlie',
      role: 'user',
      is_active: false,
      grantEnabled: true,
      directoryLinked: false,
      namespaceAdmissions: [
        {
          namespace: 'crm',
          enabled: false,
          effective: false,
          hasRole: true,
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'user-4',
      email: 'delta@example.com',
      name: 'Delta',
      role: 'admin',
      is_active: true,
      grantEnabled: false,
      directoryLinked: false,
      namespaceAdmissions: [
        {
          namespace: 'crm',
          enabled: false,
          effective: false,
          hasRole: true,
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      ],
    },
  ]
}

function createApiImplementation(callLog: string[], state = createApiState()) {
  return async (input: unknown, init?: RequestInit) => {
    const rawUrl = String(input)
    callLog.push(rawUrl)
    const url = new URL(rawUrl, 'http://localhost')
    const pathname = url.pathname
    const query = url.searchParams.get('q')?.trim().toLowerCase() || ''
    const filteredUsers = query
      ? state.filter((user) => [user.name, user.email, user.id, user.role].some((field) => field.toLowerCase().includes(query)))
      : state

    const findUserById = (userId: string) => state.find((user) => user.id === userId) || state[0]

    const buildUserPayload = (user: UserFixture) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      is_active: user.is_active,
      is_admin: user.role === 'admin',
      last_login_at: '2026-04-09T00:00:00.000Z',
      created_at: '2026-04-09T00:00:00.000Z',
      platformAdminEnabled: user.role === 'admin',
      attendanceAdminEnabled: false,
      dingtalkLoginEnabled: user.grantEnabled,
      directoryLinked: user.directoryLinked,
      businessRoleCount: 1,
    })

    const buildDingTalkAccessPayload = (user: UserFixture) => ({
      provider: 'dingtalk',
      userId: user.id,
      requireGrant: true,
      autoLinkEmail: false,
      autoProvision: false,
      server: {
        configured: true,
        available: true,
        corpId: 'dingcorp',
        allowedCorpIds: ['dingcorp', 'dingcorp-2'],
        requireGrant: true,
        autoLinkEmail: false,
        autoProvision: false,
        unavailableReason: null,
      },
      directory: {
        linked: user.directoryLinked,
        linkedCount: user.directoryLinked ? 1 : 0,
      },
      grant: {
        exists: true,
        enabled: user.grantEnabled,
        grantedBy: 'admin-1',
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
      identity: {
        exists: true,
        corpId: 'dingcorp',
        lastLoginAt: '2026-04-09T00:00:00.000Z',
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
    })

    const buildMemberAdmissionPayload = (user: UserFixture) => ({
      userId: user.id,
      accountEnabled: user.is_active,
      platformAdminEnabled: user.role === 'admin',
      attendanceAdminEnabled: false,
      businessRoleIds: ['crm_admin'],
      directoryMemberships: user.directoryLinked
        ? [
            {
              integrationId: 'ding-1',
              integrationName: '钉钉组织',
              provider: 'dingtalk',
              corpId: 'dingcorp',
              directoryAccountId: `${user.id}-directory`,
              externalUserId: `${user.id}-external`,
              name: user.name,
              email: user.email,
              mobile: null,
              accountEnabled: true,
              accountUpdatedAt: '2026-04-09T00:00:00.000Z',
              linkStatus: 'linked',
              matchStrategy: 'manual',
              reviewedBy: 'admin-1',
              reviewNote: null,
              linkUpdatedAt: '2026-04-09T00:00:00.000Z',
              departmentPaths: ['总部', '产品'],
            },
          ]
        : [],
      dingtalk: buildDingTalkAccessPayload(user),
      namespaceAdmissions: user.namespaceAdmissions,
    })

    if (pathname === '/api/admin/roles') {
      return createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'crm_admin',
              name: 'CRM 管理员',
              memberCount: 1,
              permissions: ['crm:admin'],
            },
            {
              id: 'finance_admin',
              name: '财务管理员',
              memberCount: 1,
              permissions: ['finance:admin'],
            },
          ],
        },
      })
    }

    if (pathname === '/api/admin/access-presets') {
      return createJsonResponse({
        ok: true,
        data: { items: [] },
      })
    }

    if (pathname === '/api/admin/users') {
      return createJsonResponse({
        ok: true,
        data: {
          items: filteredUsers.map((user) => buildUserPayload(user)),
        },
      })
    }

    if (pathname === '/api/admin/users/dingtalk-grants/bulk') {
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as { userIds?: unknown; enabled?: unknown } : {}
      const userIds = Array.isArray(parsed.userIds) ? parsed.userIds.map((value) => String(value)) : []
      const enabled = parsed.enabled === true
      for (const user of state) {
        if (userIds.includes(user.id)) {
          user.grantEnabled = enabled
        }
      }
      return createJsonResponse({
        ok: true,
        data: {
          userIds,
          enabled,
        },
      })
    }

    const namespaceBulkMatch = pathname.match(/^\/api\/admin\/users\/namespaces\/([^/]+)\/admission\/bulk$/)
    if (namespaceBulkMatch) {
      const namespace = decodeURIComponent(namespaceBulkMatch[1])
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as { userIds?: unknown; enabled?: unknown } : {}
      const userIds = Array.isArray(parsed.userIds) ? parsed.userIds.map((value) => String(value)) : []
      const enabled = parsed.enabled === true
      for (const user of state) {
        if (!userIds.includes(user.id)) continue
        const existing = user.namespaceAdmissions.find((item) => item.namespace === namespace)
        if (existing) {
          existing.enabled = enabled
          existing.effective = enabled && existing.hasRole
          existing.updatedAt = '2026-04-10T00:00:00.000Z'
        } else {
          user.namespaceAdmissions = [
            ...user.namespaceAdmissions,
            {
              namespace,
              enabled,
              effective: enabled,
              hasRole: true,
              updatedAt: '2026-04-10T00:00:00.000Z',
            },
          ]
        }
      }
      return createJsonResponse({
        ok: true,
        data: {
          namespace,
          userIds,
          enabled,
        },
      })
    }

    const accessMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
    if (accessMatch) {
      const user = findUserById(decodeURIComponent(accessMatch[1]))
      return createJsonResponse({
        ok: true,
        data: {
          user: buildUserPayload(user),
          roles: ['crm_admin'],
          permissions: ['crm:admin'],
          isAdmin: user.role === 'admin',
        },
      })
    }

    if (pathname === '/api/admin/invites') {
      return createJsonResponse({
        ok: true,
        data: { items: [] },
      })
    }

    const sessionsMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/sessions$/)
    if (sessionsMatch) {
      return createJsonResponse({
        ok: true,
        data: { items: [] },
      })
    }

    const dingtalkAccessMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/dingtalk-access$/)
    if (dingtalkAccessMatch) {
      const user = findUserById(decodeURIComponent(dingtalkAccessMatch[1]))
      return createJsonResponse({
        ok: true,
        data: buildDingTalkAccessPayload(user),
      })
    }

    const memberAdmissionMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/member-admission$/)
    if (memberAdmissionMatch) {
      const user = findUserById(decodeURIComponent(memberAdmissionMatch[1]))
      return createJsonResponse({
        ok: true,
        data: buildMemberAdmissionPayload(user),
      })
    }

    const namespaceAdmissionMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/namespaces\/([^/]+)\/admission$/)
    if (namespaceAdmissionMatch) {
      const namespace = decodeURIComponent(namespaceAdmissionMatch[2])
      return createJsonResponse({
        ok: true,
        data: {
          namespaceAdmissions: [
            {
              namespace,
              enabled: true,
              effective: true,
              hasRole: true,
              updatedAt: '2026-04-10T00:00:00.000Z',
            },
          ],
        },
      })
    }

    throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
  }
}

describe('UserManagementView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let callLog: string[] = []

  beforeEach(() => {
    apiFetchMock.mockReset()
    callLog = []
    apiFetchMock.mockImplementation(createApiImplementation(callLog))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('distinguishes DingTalk login from plugin usage and can open namespace admission', async () => {
    app = createApp(UserManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi(20)

    expect(container?.textContent).toContain('钉钉扫码登录')
    expect(container?.textContent).toContain('插件使用')
    expect(container?.textContent).toContain('服务端已启用钉钉登录')
    expect(container?.textContent).toContain('服务端钉钉登录可用')
    expect(container?.textContent).toContain('允许企业：dingcorp、dingcorp-2')
    expect(container?.textContent).toContain('已开通钉钉扫码')
    expect(container?.textContent).toContain('插件使用未开通')
    expect(container?.textContent).toContain('当前不可用')

    const namespaceCard = container!.querySelector('.user-admin__role-card--namespace')
    if (!(namespaceCard instanceof HTMLElement)) {
      throw new Error('Namespace card not found')
    }
    const namespaceOpenButton = Array.from(namespaceCard.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === '开通插件使用')
    if (!(namespaceOpenButton instanceof HTMLButtonElement)) {
      throw new Error('Namespace open button not found')
    }
    namespaceOpenButton.click()
    await waitForCondition(() => container?.textContent?.includes('已开通 crm 插件使用') ?? false)

    expect(container?.textContent).toContain('已开通 crm 插件使用')
    expect(container?.textContent).toContain('当前实际可用')
  })

  it('can select filtered users and batch update DingTalk grants', async () => {
    app = createApp(UserManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi(20)

    await setSearchValue(container!, 'bravo')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/users?q=bravo')))

    expect(container?.textContent).toContain('已选择 0 / 1 个当前筛选结果')

    findButtonByText(container!, '选择当前筛选结果').click()
    await flushUi()
    expect(container?.textContent).toContain('已选择 1 / 1 个当前筛选结果')

    const bravoRow = findUserRow(container!, 'Bravo')
    const bravoDetailButton = Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))
    if (!(bravoDetailButton instanceof HTMLButtonElement)) {
      throw new Error('Bravo detail button not found')
    }
    bravoDetailButton.click()
    await waitForCondition(() => callLog.includes('/api/admin/users/user-2/member-admission'))

    const bravoAccessBefore = callLog.filter((url) => url.includes('/api/admin/users/user-2/dingtalk-access')).length
    const bravoAdmissionBefore = callLog.filter((url) => url.includes('/api/admin/users/user-2/member-admission')).length

    findButtonByText(container!, '批量开通钉钉扫码').click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/dingtalk-grants/bulk'))

    const bulkEnableCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/dingtalk-grants/bulk')
    if (!bulkEnableCall) throw new Error('Bulk enable request not found')
    expect(JSON.parse(String((bulkEnableCall[1] as RequestInit | undefined)?.body)) ).toEqual({
      userIds: ['user-2'],
      enabled: true,
    })
    await waitForCondition(() => callLog.filter((url) => url.includes('/api/admin/users/user-2/dingtalk-access')).length > bravoAccessBefore)
    await waitForCondition(() => callLog.filter((url) => url.includes('/api/admin/users/user-2/member-admission')).length > bravoAdmissionBefore)
    await flushUi()
    expect(container?.textContent).toContain('已批量开通 1 个用户的钉钉扫码')
    expect(container?.textContent).toContain('已开通钉钉登录')

    findButtonByText(container!, '清空选择').click()
    await waitForCondition(() => container?.textContent?.includes('已选择 0 / 1 个当前筛选结果') ?? false)
    expect(findButtonByText(container!, '批量关闭钉钉扫码').disabled).toBe(true)

    await setSearchValue(container!, '')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.filter((url) => url === '/api/admin/users?q=').length >= 1)

    findButtonByText(container!, '选择当前筛选结果').click()
    await flushUi()
    expect(container?.textContent).toContain('已选择 4 / 4 个当前筛选结果')

    findButtonByText(container!, '批量关闭钉钉扫码').click()
    await waitForCondition(() => apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/dingtalk-grants/bulk').length >= 2)

    const bulkDisableCalls = apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/dingtalk-grants/bulk')
    const bulkDisableCall = bulkDisableCalls[bulkDisableCalls.length - 1]
    expect(JSON.parse(String((bulkDisableCall[1] as RequestInit | undefined)?.body)) ).toEqual({
      userIds: ['user-1', 'user-2', 'user-3', 'user-4'],
      enabled: false,
    })
    const bravoAccessBeforeDisable = callLog.filter((url) => url.includes('/api/admin/users/user-2/dingtalk-access')).length
    const bravoAdmissionBeforeDisable = callLog.filter((url) => url.includes('/api/admin/users/user-2/member-admission')).length
    await waitForCondition(() => callLog.filter((url) => url.includes('/api/admin/users/user-2/dingtalk-access')).length > bravoAccessBeforeDisable)
    await waitForCondition(() => callLog.filter((url) => url.includes('/api/admin/users/user-2/member-admission')).length > bravoAdmissionBeforeDisable)
    await flushUi()
    expect(container?.textContent).toContain('已批量关闭 4 个用户的钉钉扫码')
    expect(container?.textContent).toContain('未开通钉钉登录')
  })

  it('can batch update plugin usage with namespace selection and refresh the current detail user', async () => {
    app = createApp(UserManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi(20)

    const namespaceSelect = findNamespaceSelect(container!)
    expect(Array.from(namespaceSelect.options).map((option) => option.value)).toEqual(['', 'crm', 'finance'])
    await setSelectValue(namespaceSelect, 'finance')
    expect(namespaceSelect.value).toBe('finance')

    await setSearchValue(container!, 'bravo')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/users?q=bravo')))

    findButtonByText(container!, '选择当前筛选结果').click()
    await flushUi()
    expect(container?.textContent).toContain('已选择 1 / 1 个当前筛选结果')

    const bravoRow = findUserRow(container!, 'Bravo')
    const bravoDetailButton = Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))
    if (!(bravoDetailButton instanceof HTMLButtonElement)) {
      throw new Error('Bravo detail button not found')
    }
    bravoDetailButton.click()
    await waitForCondition(() => callLog.includes('/api/admin/users/user-2/member-admission'))

    const admissionBefore = callLog.filter((url) => url.includes('/api/admin/users/user-2/member-admission')).length

    findButtonByText(container!, '批量开通插件使用').click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/namespaces/finance/admission/bulk'))

    const bulkCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/namespaces/finance/admission/bulk')
    if (!bulkCall) throw new Error('Bulk namespace request not found')
    expect(JSON.parse(String((bulkCall[1] as RequestInit | undefined)?.body))).toEqual({
      userIds: ['user-2'],
      enabled: true,
    })
    await waitForCondition(() => callLog.filter((url) => url.includes('/api/admin/users/user-2/member-admission')).length > admissionBefore)
    await flushUi()
    expect(container?.textContent).toContain('已批量开通 finance 插件使用')
    expect(container?.textContent).toContain('finance')
    expect(container?.textContent).toContain('插件使用已开通')
  })
})
