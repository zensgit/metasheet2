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

type UserFixture = {
  id: string
  email: string | null
  username?: string | null
  name: string
  mobile: string | null
  role: string
  is_active: boolean
  grantEnabled: boolean
  dingtalkGrantUpdatedAt?: string | null
  dingtalkGrantUpdatedBy?: string | null
  directoryLinked: boolean
  dingtalkIdentityExists?: boolean
  hasOpenId: boolean
  hasUnionId: boolean
  dingtalkCorpId?: string | null
  lastDirectorySyncAt?: string | null
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
      username: 'alpha',
      name: 'Alpha',
      mobile: null,
      role: 'user',
      is_active: true,
      grantEnabled: true,
      dingtalkGrantUpdatedAt: '2026-04-09T00:00:00.000Z',
      dingtalkGrantUpdatedBy: 'Admin One',
      directoryLinked: true,
      dingtalkIdentityExists: true,
      hasOpenId: true,
      hasUnionId: true,
      dingtalkCorpId: 'dingcorp',
      lastDirectorySyncAt: '2026-04-09T00:00:00.000Z',
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
      username: 'bravo',
      name: 'Bravo',
      mobile: null,
      role: 'user',
      is_active: true,
      grantEnabled: false,
      dingtalkGrantUpdatedAt: '2026-04-09T00:00:00.000Z',
      dingtalkGrantUpdatedBy: 'Admin One',
      directoryLinked: false,
      dingtalkIdentityExists: true,
      hasOpenId: true,
      hasUnionId: true,
      dingtalkCorpId: 'dingcorp',
      lastDirectorySyncAt: null,
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
      username: 'charlie',
      name: 'Charlie',
      mobile: null,
      role: 'user',
      is_active: false,
      grantEnabled: true,
      dingtalkGrantUpdatedAt: '2026-04-09T00:00:00.000Z',
      dingtalkGrantUpdatedBy: 'Admin One',
      directoryLinked: false,
      dingtalkIdentityExists: true,
      hasOpenId: true,
      hasUnionId: true,
      dingtalkCorpId: 'dingcorp',
      lastDirectorySyncAt: null,
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
      username: 'delta',
      name: 'Delta',
      mobile: '13800000004',
      role: 'admin',
      is_active: true,
      grantEnabled: false,
      dingtalkGrantUpdatedAt: '2026-04-09T00:00:00.000Z',
      dingtalkGrantUpdatedBy: 'Admin One',
      directoryLinked: false,
      dingtalkIdentityExists: true,
      hasOpenId: true,
      hasUnionId: true,
      dingtalkCorpId: 'dingcorp',
      lastDirectorySyncAt: null,
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

interface ApiImplementationOptions {
  /** Limit the default user list to the first N rows so deep-link pinning can be exercised. */
  paginatedPageSize?: number
}

function createApiImplementation(
  callLog: string[],
  state = createApiState(),
  options: ApiImplementationOptions = {},
) {
  return async (input: unknown, init?: RequestInit) => {
    const rawUrl = String(input)
    callLog.push(rawUrl)
    const url = new URL(rawUrl, 'http://localhost')
    const pathname = url.pathname
    const query = url.searchParams.get('q')?.trim().toLowerCase() || ''
    const filteredUsers = query
      ? state.filter((user) => [user.name, user.email || '', user.username || '', user.id, user.role, user.mobile || ''].some((field) => field.toLowerCase().includes(query)))
      : state

    const findUserById = (userId: string) => state.find((user) => user.id === userId) || state[0]

    const buildUserPayload = (user: UserFixture) => ({
      id: user.id,
      email: user.email,
      username: user.username ?? null,
      name: user.name,
      mobile: user.mobile,
      role: user.role,
      is_active: user.is_active,
      is_admin: user.role === 'admin',
      last_login_at: '2026-04-09T00:00:00.000Z',
      created_at: '2026-04-09T00:00:00.000Z',
      platformAdminEnabled: user.role === 'admin',
      attendanceAdminEnabled: false,
      dingtalkLoginEnabled: user.grantEnabled,
      dingtalkGrantUpdatedAt: user.dingtalkGrantUpdatedAt ?? '2026-04-09T00:00:00.000Z',
      dingtalkGrantUpdatedBy: user.dingtalkGrantUpdatedBy ?? 'Admin One',
      directoryLinked: user.directoryLinked,
      dingtalkIdentityExists: user.dingtalkIdentityExists !== false,
      dingtalkHasUnionId: user.hasUnionId,
      dingtalkHasOpenId: user.hasOpenId,
      dingtalkOpenIdMissing: (user.dingtalkIdentityExists !== false) && Boolean((user.dingtalkCorpId ?? 'dingcorp')) && !user.hasOpenId,
      dingtalkCorpId: user.dingtalkCorpId ?? 'dingcorp',
      lastDirectorySyncAt: user.lastDirectorySyncAt ?? null,
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
        unionId: user.hasUnionId ? `${user.id}-union` : null,
        openId: user.hasOpenId ? `${user.id}-open` : null,
        hasUnionId: user.hasUnionId,
        hasOpenId: user.hasOpenId,
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

    if (pathname === '/api/admin/users' && (init?.method || 'GET').toUpperCase() === 'POST') {
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as {
        name?: unknown
        email?: unknown
        username?: unknown
        mobile?: unknown
      } : {}
      const newUser: UserFixture = {
        id: 'user-created',
        email: typeof parsed.email === 'string' && parsed.email.trim().length > 0 ? parsed.email.trim() : null,
        username: typeof parsed.username === 'string' && parsed.username.trim().length > 0 ? parsed.username.trim() : null,
        name: typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : '新用户',
        mobile: typeof parsed.mobile === 'string' && parsed.mobile.trim().length > 0 ? parsed.mobile.trim() : null,
        role: 'user',
        is_active: true,
        grantEnabled: false,
        directoryLinked: false,
        namespaceAdmissions: [],
      }
      state.unshift(newUser)
      return createJsonResponse({
        ok: true,
        data: {
          user: buildUserPayload(newUser),
          roles: [],
          permissions: [],
          isAdmin: false,
          temporaryPassword: 'Temp#123456',
          onboarding: {
            accountLabel: newUser.username || newUser.mobile || newUser.id,
            acceptInviteUrl: '',
            inviteMessage: `账号：${newUser.username || newUser.mobile || newUser.id}`,
          },
        },
      })
    }

    if (pathname === '/api/admin/users') {
      const pinUserId = url.searchParams.get('userId')?.trim() || ''
      const visible = typeof options.paginatedPageSize === 'number'
        ? filteredUsers.slice(0, Math.max(options.paginatedPageSize, 0))
        : filteredUsers
      const items = visible.map((user) => buildUserPayload(user))
      if (pinUserId && !items.some((item) => item.id === pinUserId)) {
        const pinned = state.find((user) => user.id === pinUserId)
        if (pinned) {
          items.unshift(buildUserPayload(pinned))
          if (typeof options.paginatedPageSize === 'number' && items.length > options.paginatedPageSize) {
            items.length = options.paginatedPageSize
          }
        }
      }
      return createJsonResponse({
        ok: true,
        data: {
          items,
          pinUserId,
          pinUserIncluded: pinUserId ? items.some((item) => item.id === pinUserId) : null,
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
          user.dingtalkGrantUpdatedAt = '2026-04-10T00:00:00.000Z'
          user.dingtalkGrantUpdatedBy = 'Admin One'
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

    const dingtalkGrantMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/dingtalk-grant$/)
    if (dingtalkGrantMatch) {
      const user = findUserById(decodeURIComponent(dingtalkGrantMatch[1]))
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as { enabled?: unknown } : {}
      user.grantEnabled = parsed.enabled === true
      return createJsonResponse({
        ok: true,
        data: buildDingTalkAccessPayload(user),
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

    const profileMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/profile$/)
    if (profileMatch) {
      const user = findUserById(decodeURIComponent(profileMatch[1]))
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as { name?: unknown; mobile?: unknown } : {}
      if (typeof parsed.name === 'string') user.name = parsed.name
      if (typeof parsed.mobile === 'string') user.mobile = parsed.mobile.trim() || null
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
  const OriginalBlob = Blob
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  let createObjectURLMock: ReturnType<typeof vi.fn>
  let revokeObjectURLMock: ReturnType<typeof vi.fn>
  let clickedAnchors: Array<{ href: string; download: string }> = []
  let createdBlobParts: string[] = []

  beforeEach(() => {
    apiFetchMock.mockReset()
    callLog = []
    apiFetchMock.mockImplementation(createApiImplementation(callLog))
    createObjectURLMock = vi.fn(() => 'blob:user-management-export')
    revokeObjectURLMock = vi.fn()
    clickedAnchors = []
    createdBlobParts = []
    globalThis.Blob = class TestBlob extends OriginalBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        createdBlobParts = Array.isArray(parts) ? parts.map((part) => String(part)) : []
        super(parts, options)
      }
    } as typeof Blob
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
    const originalClick = HTMLAnchorElement.prototype.click
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      clickedAnchors.push({ href: this.href, download: this.download })
      return originalClick.call(this)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    window.history.replaceState({}, '', '/')
    app = null
    container = null
    vi.restoreAllMocks()
    globalThis.Blob = OriginalBlob
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
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
    expect(container?.textContent).toContain('身份 corpId：dingcorp')
    expect(container?.textContent).toContain('Union ID：user-1-union')
    expect(container?.textContent).toContain('Open ID：user-1-open')
    expect(container?.textContent).toContain('最近目录同步：')
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

  it('warns and disables enabling DingTalk grant when the identity is missing openId', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    state[1].directoryLinked = true
    state[1].lastDirectorySyncAt = '2026-04-10T00:00:00.000Z'
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    const bravoRow = findUserRow(container!, 'Bravo')
    const bravoDetailButton = Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))
    if (!(bravoDetailButton instanceof HTMLButtonElement)) {
      throw new Error('Bravo detail button not found')
    }
    bravoDetailButton.click()
    await waitForCondition(() => callLog.includes('/api/admin/users/user-2/dingtalk-access'))

    expect(container?.textContent).toContain('当前钉钉身份缺少 openId')
    expect(container?.textContent).toContain('Union ID：user-2-union')
    expect(container?.textContent).toContain('Open ID：未记录')
    expect(container?.textContent).toContain('最近目录同步：')
    expect(container?.textContent).toContain('修复建议：先回到目录同步查看该成员是否已补齐 openId')
    const enableButton = findButtonByText(container!, '开通钉钉扫码')
    expect(enableButton.disabled).toBe(true)
    const directoryLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('前往目录成员'))
    expect(directoryLink?.getAttribute('href')).toBe('/admin/directory?integrationId=ding-1&accountId=user-2-directory&source=user-management&userId=user-2')
    expect(apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/user-2/dingtalk-grant')).toBe(false)
  })

  it('filters the list to users missing DingTalk openId', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    state[1].directoryLinked = true
    state[1].lastDirectorySyncAt = '2026-04-10T00:00:00.000Z'
    app = createApp(UserManagementView)
    registerRouterLink(app)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    expect(container?.textContent).toContain('缺 OpenID')
    const filterButton = findButtonByText(container!, '缺 OpenID')
    filterButton.click()
    await flushUi()

    const userRows = Array.from(container!.querySelectorAll('.user-admin__user')).map((row) => row.textContent || '')
    expect(userRows.some((text) => text.includes('Bravo'))).toBe(true)
    expect(userRows.some((text) => text.includes('Alpha'))).toBe(false)
    expect(container?.textContent).toContain('corpId dingcorp')
    expect(container?.textContent).toContain('最近目录同步')
  })

  it('exports the current missing-openid screening list as CSV', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    state[1].directoryLinked = true
    state[1].lastDirectorySyncAt = '2026-04-10T00:00:00.000Z'
    app = createApp(UserManagementView)
    registerRouterLink(app)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    const exportButton = findButtonByText(container!, '导出缺 OpenID 清单')
    expect(exportButton.disabled).toBe(false)
    exportButton.click()
    await flushUi()

    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    const exportedBlob = createObjectURLMock.mock.calls[0]?.[0] as Blob
    expect(exportedBlob).toBeInstanceOf(Blob)
    const exportedText = createdBlobParts.join('')
    expect(exportedText).toContain('userId,name,account,role,dingtalkCorpId,directoryLinked,lastDirectorySyncAt')
    expect(exportedText).toContain('user-2,Bravo,bravo@example.com,user,dingcorp,linked,2026-04-10T00:00:00.000Z')
    expect(clickedAnchors[0]?.download).toContain('dingtalk-missing-openid-users-')
    expect(container?.textContent).toContain('已导出 1 个缺 OpenID 用户的治理清单')
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:user-management-export')
  })

  it('exports the governance daily summary with counts, suggestions, and workbench links', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T08:00:00.000Z'))
    try {
      const state = createApiState()
      state[1].hasOpenId = false
      state[1].directoryLinked = true
      state[1].grantEnabled = false
      state[1].dingtalkGrantUpdatedAt = '2026-05-04T08:00:00.000Z'
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
      app.mount(container!)
      await flushUi(20)

      const exportButton = findButtonByText(container!, '导出治理日报摘要')
      exportButton.click()
      await flushUi()

      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      const exportedText = createdBlobParts.join('')
      expect(exportedText).toContain('# DingTalk 治理日报摘要')
      expect(exportedText).toContain('日期：2026-05-05')
      expect(exportedText).toContain('- 缺 OpenID：1')
      expect(exportedText).toContain('- 待收口：0')
      expect(exportedText).toContain('- 已收口：1')
      expect(exportedText).toContain('缺 OpenID 成员：当前没有待收口成员需要优先处理')
      expect(exportedText).toContain('目录同步修复入口：1 个成员可先回目录同步继续补齐 openId')
      expect(exportedText).toContain('最近 7 天收口审计：最近 7 天已收口 1 个成员，可直接复盘处理动作')
      expect(exportedText).toContain('/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
      expect(exportedText).toContain('/admin/directory?source=dingtalk-governance')
      expect(exportedText).toContain('/admin/audit?resourceType=user-auth-grant&action=revoke&from=2026-04-29T00%3A00%3A00.000Z&to=2026-05-05T23%3A59%3A59.999Z')
      expect(clickedAnchors[0]?.download).toBe('dingtalk-governance-daily-summary-2026-05-05.md')
      expect(container?.textContent).toContain('已导出 DingTalk 治理日报摘要')
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports the live validation checklist with baseline, steps, and workbench links', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T08:00:00.000Z'))
    try {
      const state = createApiState()
      state[1].hasOpenId = false
      state[1].directoryLinked = true
      state[1].grantEnabled = false
      state[1].dingtalkGrantUpdatedAt = '2026-05-04T08:00:00.000Z'
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
      app.mount(container!)
      await flushUi(20)

      const exportButton = findButtonByText(container!, '导出联调检查单')
      exportButton.click()
      await flushUi()

      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      const exportedText = createdBlobParts.join('')
      expect(exportedText).toContain('# DingTalk 治理联调检查单')
      expect(exportedText).toContain('日期：2026-05-05')
      expect(exportedText).toContain('- 缺 OpenID：1')
      expect(exportedText).toContain('- 待收口：0')
      expect(exportedText).toContain('- 已收口：1')
      expect(exportedText).toContain('## 联调步骤')
      expect(exportedText).toContain('打开缺 OpenID 成员清单')
      expect(exportedText).toContain('跳到目录同步页，刷新目录成员并确认是否补齐 openId')
      expect(exportedText).toContain('打开最近 7 天收口审计')
      expect(exportedText).toContain('/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
      expect(exportedText).toContain('/admin/directory?source=dingtalk-governance')
      expect(exportedText).toContain('/admin/audit?resourceType=user-auth-grant&action=revoke&from=2026-04-29T00%3A00%3A00.000Z&to=2026-05-05T23%3A59%3A59.999Z')
      expect(clickedAnchors[0]?.download).toBe('dingtalk-governance-live-validation-checklist-2026-05-05.md')
      expect(container?.textContent).toContain('已导出 DingTalk 联调检查单')
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports the validation result template with baseline, fill-in sections, and workbench links', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T08:00:00.000Z'))
    try {
      const state = createApiState()
      state[1].hasOpenId = false
      state[1].directoryLinked = true
      state[1].grantEnabled = false
      state[1].dingtalkGrantUpdatedAt = '2026-05-04T08:00:00.000Z'
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
      app.mount(container!)
      await flushUi(20)

      const exportButton = findButtonByText(container!, '导出联调结果模板')
      exportButton.click()
      await flushUi()

      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      const exportedText = createdBlobParts.join('')
      expect(exportedText).toContain('# DingTalk 治理联调结果回填模板')
      expect(exportedText).toContain('日期：2026-05-05')
      expect(exportedText).toContain('## 联调环境')
      expect(exportedText).toContain('- 缺 OpenID：1')
      expect(exportedText).toContain('- 待收口：0')
      expect(exportedText).toContain('- 已收口：1')
      expect(exportedText).toContain('## 结果回填')
      expect(exportedText).toContain('缺 OpenID 成员清单与预期一致')
      expect(exportedText).toContain('目录同步可补齐 openId / 或确认仍缺失原因')
      expect(exportedText).toContain('最近 7 天收口审计可看到时间、处理人和动作')
      expect(exportedText).toContain('## 执行后结论')
      expect(exportedText).toContain('/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
      expect(exportedText).toContain('/admin/directory?source=dingtalk-governance')
      expect(exportedText).toContain('/admin/audit?resourceType=user-auth-grant&action=revoke&from=2026-04-29T00%3A00%3A00.000Z&to=2026-05-05T23%3A59%3A59.999Z')
      expect(clickedAnchors[0]?.download).toBe('dingtalk-governance-validation-result-template-2026-05-05.md')
      expect(container?.textContent).toContain('已导出 DingTalk 联调结果模板')
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports the governance execution package index with ordered artifacts and workbench links', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T08:00:00.000Z'))
    try {
      const state = createApiState()
      state[1].hasOpenId = false
      state[1].directoryLinked = true
      state[1].grantEnabled = false
      state[1].dingtalkGrantUpdatedAt = '2026-05-04T08:00:00.000Z'
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
      app.mount(container!)
      await flushUi(20)

      const exportButton = findButtonByText(container!, '导出联调执行包索引')
      exportButton.click()
      await flushUi()

      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      const exportedText = createdBlobParts.join('')
      expect(exportedText).toContain('# DingTalk 治理联调执行包索引')
      expect(exportedText).toContain('日期：2026-05-05')
      expect(exportedText).toContain('## 推荐执行顺序')
      expect(exportedText).toContain('1. 导出治理日报摘要')
      expect(exportedText).toContain('2. 导出联调检查单')
      expect(exportedText).toContain('3. 执行真实联调')
      expect(exportedText).toContain('4. 导出联调结果模板')
      expect(exportedText).toContain('5. 回填并归档结果')
      expect(exportedText).toContain('dingtalk-governance-daily-summary-2026-05-05.md')
      expect(exportedText).toContain('dingtalk-governance-live-validation-checklist-2026-05-05.md')
      expect(exportedText).toContain('dingtalk-governance-validation-result-template-2026-05-05.md')
      expect(exportedText).toContain('/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
      expect(exportedText).toContain('/admin/directory?source=dingtalk-governance')
      expect(exportedText).toContain('/admin/audit?resourceType=user-auth-grant&action=revoke&from=2026-04-29T00%3A00%3A00.000Z&to=2026-05-05T23%3A59%3A59.999Z')
      expect(clickedAnchors[0]?.download).toBe('dingtalk-governance-execution-package-index-2026-05-05.md')
      expect(container?.textContent).toContain('已导出 DingTalk 联调执行包索引')
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports the full governance validation package as one markdown handoff file', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T08:00:00.000Z'))
    try {
      const state = createApiState()
      state[1].hasOpenId = false
      state[1].directoryLinked = true
      state[1].grantEnabled = false
      state[1].dingtalkGrantUpdatedAt = '2026-05-04T08:00:00.000Z'
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
      app.mount(container!)
      await flushUi(20)

      const exportButton = findButtonByText(container!, '导出完整联调包')
      exportButton.click()
      await flushUi()

      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      const exportedText = createdBlobParts.join('')
      expect(exportedText).toContain('# DingTalk 治理完整联调包')
      expect(exportedText).toContain('日期：2026-05-05')
      expect(exportedText).toContain('## 包内目录')
      expect(exportedText).toContain('## 当前基线')
      expect(exportedText).toContain('- 缺 OpenID：1')
      expect(exportedText).toContain('- 待收口：0')
      expect(exportedText).toContain('- 已收口：1')
      expect(exportedText).toContain('## 推荐执行顺序')
      expect(exportedText).toContain('## 治理日报摘要')
      expect(exportedText).toContain('## 联调检查单')
      expect(exportedText).toContain('## 联调结果回填模板')
      expect(exportedText).toContain('/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
      expect(exportedText).toContain('/admin/directory?source=dingtalk-governance')
      expect(exportedText).toContain('/admin/audit?resourceType=user-auth-grant&action=revoke&from=2026-04-29T00%3A00%3A00.000Z&to=2026-05-05T23%3A59%3A59.999Z')
      expect(clickedAnchors[0]?.download).toBe('dingtalk-governance-full-validation-package-2026-05-05.md')
      expect(container?.textContent).toContain('已导出 DingTalk 完整联调包')
    } finally {
      vi.useRealTimers()
    }
  })

  it('links the screening view to the DingTalk governance audit shortcut', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    const auditLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('查看钉钉治理审计'))
    expect(auditLink?.getAttribute('href')).toBe('/admin/audit?resourceType=user-auth-grant&action=revoke')
  })

  it('shows a governance workbench with fixed quick links', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T08:00:00.000Z'))
    try {
      const state = createApiState()
      state[1].hasOpenId = false
      state[1].directoryLinked = true
      state[1].grantEnabled = false
      state[1].dingtalkGrantUpdatedAt = '2026-05-04T08:00:00.000Z'
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
      app.mount(container!)
      await flushUi(20)

      const missingUsersLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('缺 OpenID 成员'))
      const directoryLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('目录同步修复入口'))
      const recentAuditLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('最近 7 天收口审计'))

      expect(missingUsersLink?.getAttribute('href')).toBe('/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
      expect(directoryLink?.getAttribute('href')).toBe('/admin/directory?source=dingtalk-governance')
      expect(recentAuditLink?.getAttribute('href')).toBe('/admin/audit?resourceType=user-auth-grant&action=revoke&from=2026-04-29T00%3A00%3A00.000Z&to=2026-05-05T23%3A59%3A59.999Z')
      expect(container?.textContent).toContain('当前没有待收口成员需要优先处理')
      expect(container?.textContent).toContain('1 个成员可先回目录同步继续补齐 openId')
      expect(container?.textContent).toContain('最近 7 天已收口 1 个成员，可直接复盘处理动作')
    } finally {
      vi.useRealTimers()
    }
  })

  it('links the pending governance summary metric to the DingTalk governance audit shortcut', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    const pendingLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('待收口'))
    expect(pendingLink?.getAttribute('href')).toBe('/admin/audit?resourceType=user-auth-grant&action=revoke')
  })

  it('links the missing-openid summary metric to a shareable filtered user-management view', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    const missingLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('缺 OpenID'))
    expect(missingLink?.getAttribute('href')).toBe('/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
  })

  it('links the governed summary metric to the recent 7 day DingTalk governance audit shortcut', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T08:00:00.000Z'))
    try {
      const state = createApiState()
      state[1].hasOpenId = false
      state[1].grantEnabled = false
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
      app.mount(container!)
      await flushUi(20)

      const governedLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('已收口'))
      expect(governedLink?.getAttribute('href')).toBe('/admin/audit?resourceType=user-auth-grant&action=revoke&from=2026-04-29T00%3A00%3A00.000Z&to=2026-05-05T23%3A59%3A59.999Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the missing-openid filter from a deep link on first load', async () => {
    window.history.replaceState({}, '', '/admin/users?filter=dingtalk-openid-missing&source=dingtalk-governance')
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    const rows = Array.from(container!.querySelectorAll('.user-admin__user'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Bravo')
  })

  it('syncs the missing-openid filter back to the URL when selected in-page', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    findButtonByText(container!, '缺 OpenID').click()
    await flushUi()

    expect(window.location.search).toBe('?filter=dingtalk-openid-missing')
    const rows = Array.from(container!.querySelectorAll('.user-admin__user'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Bravo')
  })

  it('preserves directory return context when the user changes governance filters', async () => {
    window.history.replaceState({}, '', '/admin/users?userId=user-2&source=directory-sync&directoryFailure=missing_account&integrationId=ding-1&accountId=user-2-directory')
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    findButtonByText(container!, '缺 OpenID').click()
    await flushUi()

    expect(window.location.search).toBe('?userId=user-2&source=directory-sync&directoryFailure=missing_account&integrationId=ding-1&accountId=user-2-directory&filter=dingtalk-openid-missing')
    expect(container?.textContent).toContain('目录定位未完成')
    expect(container?.textContent).toContain('目标集成：ding-1 · 目标成员：user-2-directory')
  })

  it('can clear directory return context while keeping the focused user and filter', async () => {
    window.history.replaceState({}, '', '/admin/users?userId=user-2&source=directory-sync&directoryFailure=missing_account&integrationId=ding-1&accountId=user-2-directory')
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    findButtonByText(container!, '缺 OpenID').click()
    await flushUi()
    findButtonByText(container!, '清除目录回跳').click()
    await flushUi()

    expect(window.location.search).toBe('?userId=user-2&filter=dingtalk-openid-missing')
    expect(container?.textContent).toContain('已清除目录回跳上下文')
    expect(container?.textContent).not.toContain('目录定位未完成')
    expect(container?.textContent).not.toContain('目标集成：ding-1 · 目标成员：user-2-directory')
    expect(container?.textContent).toContain('Bravo')
  })

  it('bulk disables dingtalk grant for the current missing-openid screening list', async () => {
    const state = createApiState()
    state[1].hasOpenId = false
    state[1].directoryLinked = true
    state[1].grantEnabled = true
    state[1].lastDirectorySyncAt = '2026-04-10T00:00:00.000Z'
    app = createApp(UserManagementView)
    registerRouterLink(app)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    expect(container?.textContent).toContain('1缺 OpenID')
    expect(container?.textContent).toContain('0已收口')
    expect(container?.textContent).toContain('1待收口')

    findButtonByText(container!, '缺 OpenID').click()
    await flushUi()

    const actionButton = findButtonByText(container!, '批量关闭缺 OpenID 钉钉扫码')
    expect(actionButton.disabled).toBe(false)
    actionButton.click()
    await waitForCondition(() => apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/dingtalk-grants/bulk').length >= 1)

    const bulkCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/dingtalk-grants/bulk')
    expect(JSON.parse(String((bulkCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      userIds: ['user-2'],
      enabled: false,
    })
    await flushUi()
    expect(container?.textContent).toContain('已批量关闭 1 个缺 OpenID 用户的钉钉扫码')
    expect(container?.textContent).toContain('最近关闭钉钉扫码')
    expect(container?.textContent).toContain('处理人 Admin One')
    expect(container?.textContent).toContain('1已收口')
    expect(container?.textContent).toContain('0待收口')
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

  it('can update user mobile profile and persist the refreshed detail snapshot', async () => {
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    const bravoRow = findUserRow(container!, 'Bravo')
    const bravoDetailButton = Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))
    if (!(bravoDetailButton instanceof HTMLButtonElement)) {
      throw new Error('Bravo detail button not found')
    }
    bravoDetailButton.click()
    await waitForCondition(() => callLog.includes('/api/admin/users/user-2/access'))

    const inputs = Array.from(container!.querySelectorAll('input[type="text"]'))
    const mobileInput = inputs.find((candidate) => (candidate as HTMLInputElement).placeholder === '手机号，可留空')
    if (!(mobileInput instanceof HTMLInputElement)) {
      throw new Error('Profile mobile input not found')
    }

    mobileInput.value = '13800138000'
    mobileInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    findButtonByText(container!, '保存资料').click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/user-2/profile'))

    const profileCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/user-2/profile')
    if (!profileCall) throw new Error('Profile update request not found')
    expect(JSON.parse(String((profileCall[1] as RequestInit | undefined)?.body))).toEqual({
      name: 'Bravo',
      mobile: '13800138000',
      expectedMobile: null,
    })

    await waitForCondition(() => container?.textContent?.includes('用户资料已更新') ?? false)
    expect(container?.textContent).toContain('手机号：13800138000')
  })

  it('refreshes and surfaces the latest mobile when a PROFILE_MOBILE_CONFLICT happens', async () => {
    const state = createApiState()
    const bravo = state.find((user) => user.id === 'user-2')
    if (!bravo) throw new Error('Bravo fixture not found')
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))

    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    const bravoRow = findUserRow(container!, 'Bravo')
    const bravoDetailButton = Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))
    if (!(bravoDetailButton instanceof HTMLButtonElement)) {
      throw new Error('Bravo detail button not found')
    }
    bravoDetailButton.click()
    await waitForCondition(() => callLog.includes('/api/admin/users/user-2/access'))

    const inputs = Array.from(container!.querySelectorAll('input[type="text"]'))
    const mobileInput = inputs.find((candidate) => (candidate as HTMLInputElement).placeholder === '手机号，可留空')
    if (!(mobileInput instanceof HTMLInputElement)) {
      throw new Error('Profile mobile input not found')
    }
    mobileInput.value = '13800000000'
    mobileInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    // Simulate a concurrent backend edit landing right before our PATCH lands.
    bravo.mobile = '13999999999'
    apiFetchMock.mockImplementationOnce(async (input) => {
      callLog.push(String(input))
      return createJsonResponse({
        ok: false,
        error: {
          code: 'PROFILE_MOBILE_CONFLICT',
          message: 'User mobile changed before update was applied',
        },
      }, 409)
    })

    const accessCallsBefore = callLog.filter((url) => url === '/api/admin/users/user-2/access').length
    findButtonByText(container!, '保存资料').click()

    await waitForCondition(() => container?.textContent?.includes('用户手机号已被其他操作更新为 13999999999') ?? false)

    expect(container?.textContent).not.toContain('用户资料已更新')
    expect(container?.textContent).toContain('手机号：13999999999')
    const accessCallsAfter = callLog.filter((url) => url === '/api/admin/users/user-2/access').length
    expect(accessCallsAfter).toBeGreaterThan(accessCallsBefore)
  })

  it('falls back to a generic message when the post-conflict access refresh fails', async () => {
    const state = createApiState()
    const bravo = state.find((user) => user.id === 'user-2')
    if (!bravo) throw new Error('Bravo fixture not found')
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))

    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    const bravoRow = findUserRow(container!, 'Bravo')
    const bravoDetailButton = Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))
    if (!(bravoDetailButton instanceof HTMLButtonElement)) {
      throw new Error('Bravo detail button not found')
    }
    bravoDetailButton.click()
    await waitForCondition(() => callLog.includes('/api/admin/users/user-2/access'))

    const inputs = Array.from(container!.querySelectorAll('input[type="text"]'))
    const mobileInput = inputs.find((candidate) => (candidate as HTMLInputElement).placeholder === '手机号，可留空')
    if (!(mobileInput instanceof HTMLInputElement)) {
      throw new Error('Profile mobile input not found')
    }
    mobileInput.value = '13800000000'
    mobileInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    // Backend reports a CAS conflict…
    apiFetchMock.mockImplementationOnce(async (input) => {
      callLog.push(String(input))
      return createJsonResponse({
        ok: false,
        error: {
          code: 'PROFILE_MOBILE_CONFLICT',
          message: 'User mobile changed before update was applied',
        },
      }, 409)
    })
    // …and the follow-up access GET also fails, so the view can't confirm the
    // true latest value. The UI must NOT advertise a stale mobile as "latest".
    apiFetchMock.mockImplementationOnce(async (input) => {
      callLog.push(String(input))
      return createJsonResponse({
        ok: false,
        error: { code: 'USER_ACCESS_FAILED', message: 'downstream unavailable' },
      }, 500)
    })

    findButtonByText(container!, '保存资料').click()
    await waitForCondition(() => container?.textContent?.includes('用户手机号已被其他操作更新，请刷新后重试') ?? false)

    expect(container?.textContent).not.toContain('用户手机号已被其他操作更新为')
    expect(container?.textContent).not.toContain('用户资料已更新')
  })

  it('creates a no-email user with username/mobile and surfaces temporary-password onboarding', async () => {
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    const inputs = Array.from(container!.querySelectorAll('.user-admin__panel--create input'))
    const nameInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '姓名') as HTMLInputElement | undefined
    const usernameInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '用户名（可选）') as HTMLInputElement | undefined
    const mobileInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '手机号（可选）') as HTMLInputElement | undefined
    if (!nameInput || !usernameInput || !mobileInput) {
      throw new Error('Create-user form inputs not found')
    }

    nameInput.value = '林岚'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    usernameInput.value = 'linlan'
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
    mobileInput.value = '13900001234'
    mobileInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    findButtonByText(container!, '创建用户').click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users' && (args[1] as RequestInit | undefined)?.method === 'POST'))
    await flushUi(8)

    const createCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users' && (args[1] as RequestInit | undefined)?.method === 'POST')
    if (!createCall) throw new Error('Create-user request not found')
    expect(JSON.parse(String((createCall[1] as RequestInit | undefined)?.body))).toEqual({
      name: '林岚',
      email: '',
      username: 'linlan',
      mobile: '13900001234',
      role: 'user',
      isActive: true,
    })
    expect(container?.textContent).toContain('用户已创建')
    expect(container?.textContent).toContain('新用户临时密码：Temp#123456')
    expect(container?.textContent).toContain('账号：linlan')
    expect(container?.textContent).not.toContain('首次设置密码链接：')
  })

  it('can auto-focus a user from directory query params', async () => {
    window.history.replaceState({}, '', '/admin/users?userId=user-2&source=directory-sync&integrationId=ding-1&accountId=user-2-directory')
    const state = createApiState()
    const bravo = state.find((user) => user.id === 'user-2')
    if (!bravo) throw new Error('Bravo fixture not found')
    bravo.directoryLinked = true
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))

    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    expect(container?.textContent).toContain('已从目录同步定位到用户 Bravo')
    expect(container?.textContent).toContain('目录同步回跳')
    expect(container?.textContent).toContain('已从目录同步返回用户管理')
    expect(container?.textContent).toContain('目标集成：ding-1 · 目标成员：user-2-directory')
    const returnDirectoryLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('返回目录同步'))
    expect(returnDirectoryLink?.getAttribute('href')).toBe('/admin/directory?integrationId=ding-1&accountId=user-2-directory&source=user-management&userId=user-2')
    expect(container?.textContent).toContain('Bravo')
  })

  it('shows a directory failure banner when returning from a missing directory account', async () => {
    window.history.replaceState({}, '', '/admin/users?userId=user-2&source=directory-sync&directoryFailure=missing_account&integrationId=ding-1&accountId=user-2-directory')
    const state = createApiState()
    const bravo = state.find((user) => user.id === 'user-2')
    if (!bravo) throw new Error('Bravo fixture not found')
    bravo.directoryLinked = true
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))

    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    expect(container?.textContent).toContain('目录定位未完成')
    expect(container?.textContent).toContain('未找到目标目录成员')
    expect(container?.textContent).toContain('目标集成：ding-1 · 目标成员：user-2-directory')
    expect(container?.textContent).toContain('已从目录同步定位到用户 Bravo')
    const returnDirectoryLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('返回目录同步'))
    expect(returnDirectoryLink?.getAttribute('href')).toBe('/admin/directory?integrationId=ding-1&accountId=user-2-directory&source=user-management&userId=user-2')
  })

  it('shows a directory failure banner when returning from a missing directory integration', async () => {
    window.history.replaceState({}, '', '/admin/users?userId=user-2&source=directory-sync&directoryFailure=missing_integration&integrationId=ding-missing&accountId=user-2-directory')
    const state = createApiState()
    const bravo = state.find((user) => user.id === 'user-2')
    if (!bravo) throw new Error('Bravo fixture not found')
    bravo.directoryLinked = true
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))

    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    expect(container?.textContent).toContain('目录定位未完成')
    expect(container?.textContent).toContain('未找到目标目录集成')
    expect(container?.textContent).toContain('目标集成：ding-missing · 目标成员：user-2-directory')
    expect(container?.textContent).toContain('已从目录同步定位到用户 Bravo')
    const returnDirectoryLink = Array.from(container!.querySelectorAll('a')).find((candidate) => candidate.textContent?.includes('返回目录同步'))
    expect(returnDirectoryLink?.getAttribute('href')).toBe('/admin/directory?integrationId=ding-missing&accountId=user-2-directory&source=user-management&userId=user-2')
  })

  it('can re-focus a user when query params change on the same mounted instance', async () => {
    const state = createApiState()
    const bravo = state.find((user) => user.id === 'user-2')
    if (!bravo) throw new Error('Bravo fixture not found')
    bravo.directoryLinked = true
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))

    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    await setSearchValue(container!, 'Alpha')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.includes('/api/admin/users?q=Alpha'))
    expect(container?.textContent).toContain('Alpha')

    window.history.replaceState({}, '', '/admin/users?userId=user-2&source=directory-sync&integrationId=ding-1&accountId=user-2-directory')
    await waitForCondition(() => container?.textContent?.includes('已从目录同步定位到用户 Bravo') ?? false)

    const searchInput = container!.querySelector('input[type="search"]')
    expect(searchInput).toBeInstanceOf(HTMLInputElement)
    expect((searchInput as HTMLInputElement).value).toBe('')
  })

  it('auto-focuses a deep-linked user whose row is outside the paginated first page', async () => {
    window.history.replaceState({}, '', '/admin/users?userId=user-4&source=directory-sync&integrationId=ding-1&accountId=user-4-directory')
    const state = createApiState()
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state, { paginatedPageSize: 2 }))

    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    const pinnedCall = callLog.find((url) => url.startsWith('/api/admin/users?') && url.includes('userId=user-4'))
    expect(pinnedCall, 'expected loadUsers to forward the deep-link userId to the backend').toBeTruthy()

    expect(container?.textContent).toContain('Delta')
    expect(container?.textContent).toContain('已从目录同步定位到用户 Delta')
  })

  it('re-loads with the pinned userId when the deep link changes on the same instance', async () => {
    const state = createApiState()
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state, { paginatedPageSize: 2 }))

    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    // Initially no deep link — Alpha (first row) should be selected.
    expect(container?.textContent).toContain('Alpha')

    window.history.replaceState({}, '', '/admin/users?userId=user-4&source=directory-sync&integrationId=ding-1&accountId=user-4-directory')
    await waitForCondition(() => callLog.some((url) => url.startsWith('/api/admin/users?') && url.includes('userId=user-4')))
    await waitForCondition(() => container?.textContent?.includes('已从目录同步定位到用户 Delta') ?? false)

    expect(container?.textContent).toContain('Delta')
  })
})
