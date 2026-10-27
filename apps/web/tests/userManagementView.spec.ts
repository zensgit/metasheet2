import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'
import { describeCreateUserError, describePasswordPolicyFailure, getCreateUserRuleHints } from '../src/utils/createUserValidationCopy'
import { describeAdminResetPasswordInlineError } from '../src/views/adminTemporaryPasswordFeedback'

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
  employeeNo?: string | null
  department?: string | null
  position?: string | null
  hireDate?: string | null
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
      employeeNo: 'E-2002',
      department: 'Production',
      position: 'Assembler',
      hireDate: '2026-05-01',
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
  /** W1-6: org ids GET /api/auth/session-orgs returns, or 'fail' for a 503. Default: one org. */
  sessionOrgs?: string[] | 'fail'
  /** W1-6: the currentOrgId GET /api/auth/session-orgs reports (the token's org). Default: null. */
  sessionCurrentOrgId?: string | null
  /** W1-6 ⑥: the `orgId` the attendance group list reports for its group. Default: no `orgId` field. */
  attendanceGroupOrgId?: string
  /** W1-6 ⑥: the `orgId` the shift list reports for its shift. Default: no `orgId` field. */
  attendanceShiftOrgId?: string
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
      ? state.filter((user) => [
        user.name,
        user.email || '',
        user.username || '',
        user.id,
        user.role,
        user.mobile || '',
        user.employeeNo || '',
        user.department || '',
      ].some((field) => field.toLowerCase().includes(query)))
      : state

    const findUserById = (userId: string) => state.find((user) => user.id === userId) || state[0]

    const buildUserPayload = (user: UserFixture) => ({
      id: user.id,
      email: user.email,
      username: user.username ?? null,
      name: user.name,
      mobile: user.mobile,
      employeeNo: user.employeeNo ?? null,
      department: user.department ?? null,
      position: user.position ?? null,
      hireDate: user.hireDate ?? null,
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
      workNotification: {
        configured: true,
        available: true,
        unavailableReason: null,
        requirements: {
          appKey: {
            configured: true,
            selectedKey: 'DINGTALK_APP_KEY',
          },
          appSecret: {
            configured: true,
            selectedKey: 'DINGTALK_APP_SECRET',
          },
          agentId: {
            configured: true,
            selectedKey: 'DINGTALK_AGENT_ID',
          },
          baseUrl: {
            configured: false,
            selectedKey: null,
          },
        },
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

    if (pathname === '/api/auth/session-orgs') {
      if (options.sessionOrgs === 'fail') {
        return createJsonResponse({ success: false, error: 'Organization list unavailable', code: 'SESSION_ORGS_UNAVAILABLE' }, 503)
      }
      return createJsonResponse({
        success: true,
        data: { orgs: options.sessionOrgs ?? ['org-alpha'], currentOrgId: options.sessionCurrentOrgId ?? null },
      })
    }

    if (pathname === '/api/attendance/groups') {
      return createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              name: '总装一组',
              code: 'ASM-1',
              ...(options.attendanceGroupOrgId !== undefined ? { orgId: options.attendanceGroupOrgId } : {}),
            },
          ],
        },
      })
    }

    if (pathname === '/api/attendance/shifts') {
      return createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: '早班',
              workStartTime: '09:00',
              workEndTime: '18:00',
              ...(options.attendanceShiftOrgId !== undefined ? { orgId: options.attendanceShiftOrgId } : {}),
            },
          ],
        },
      })
    }

    if (pathname === '/api/admin/users' && (init?.method || 'GET').toUpperCase() === 'POST') {
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as {
        name?: unknown
        email?: unknown
        username?: unknown
        mobile?: unknown
        employeeNo?: unknown
        department?: unknown
        position?: unknown
        hireDate?: unknown
      } : {}
      const newUser: UserFixture = {
        id: 'user-created',
        email: typeof parsed.email === 'string' && parsed.email.trim().length > 0 ? parsed.email.trim() : null,
        username: typeof parsed.username === 'string' && parsed.username.trim().length > 0 ? parsed.username.trim() : null,
        name: typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : '新用户',
        mobile: typeof parsed.mobile === 'string' && parsed.mobile.trim().length > 0 ? parsed.mobile.trim() : null,
        employeeNo: typeof parsed.employeeNo === 'string' && parsed.employeeNo.trim().length > 0 ? parsed.employeeNo.trim() : null,
        department: typeof parsed.department === 'string' && parsed.department.trim().length > 0 ? parsed.department.trim() : null,
        position: typeof parsed.position === 'string' && parsed.position.trim().length > 0 ? parsed.position.trim() : null,
        hireDate: typeof parsed.hireDate === 'string' && parsed.hireDate.trim().length > 0 ? parsed.hireDate.trim() : null,
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
      const parsed = rawBody ? JSON.parse(rawBody) as {
        name?: unknown
        mobile?: unknown
        employeeNo?: unknown
        department?: unknown
        position?: unknown
        hireDate?: unknown
      } : {}
      if (typeof parsed.name === 'string') user.name = parsed.name
      if (typeof parsed.mobile === 'string') user.mobile = parsed.mobile.trim() || null
      if (typeof parsed.employeeNo === 'string') user.employeeNo = parsed.employeeNo.trim() || null
      if (typeof parsed.department === 'string') user.department = parsed.department.trim() || null
      if (typeof parsed.position === 'string') user.position = parsed.position.trim() || null
      if (typeof parsed.hireDate === 'string') user.hireDate = parsed.hireDate.trim() || null
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
    expect(container?.textContent).toContain('工作通知已配置')
    expect(container?.textContent).toContain('钉钉工作通知可用')
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
    expect(container?.textContent).toContain('修复建议：确认账号已激活并已绑定钉钉身份 → 让成员用钉钉扫码登录一次（登录会补齐 openId）→ 刷新本页后再开通钉钉扫码。')
    expect(container?.textContent).not.toContain('重新同步目录')
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
      expect(exportedText).toContain('成员用钉钉扫码登录一次后已补齐 openId（目录同步本身不返回 openId）/ 或确认仍缺失原因')
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
    await waitForCondition(() => container!.querySelector('input[placeholder="手机号，可留空"]') !== null)

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
      employeeNo: 'E-2002',
      department: 'Production',
      position: 'Assembler',
      hireDate: '2026-05-01',
      expectedMobile: null,
    })

    await waitForCondition(() => container?.textContent?.includes('用户资料已更新') ?? false)
    expect(container?.textContent).toContain('手机号：13800138000')
  })

  it('can update attendance HR profile fields from the user detail panel', async () => {
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
    const detailPanel = () => container!.querySelector('.user-admin__panel--detail') as HTMLElement | null
    await waitForCondition(() => detailPanel()?.textContent?.includes('员工号：E-2002') ?? false)
    expect(detailPanel()?.textContent).toContain('部门：Production')

    const inputs = Array.from(container!.querySelectorAll('input'))
    const employeeNoInput = inputs.find((candidate) => (candidate as HTMLInputElement).placeholder === '员工号，可留空')
    const departmentInput = inputs.find((candidate) => (candidate as HTMLInputElement).placeholder === '部门，可留空')
    const positionInput = inputs.find((candidate) => (candidate as HTMLInputElement).placeholder === '岗位，可留空')
    const hireDateInput = inputs.find((candidate) => (candidate as HTMLInputElement).getAttribute('aria-label') === '入职日期，可留空')
    if (!(employeeNoInput instanceof HTMLInputElement) || !(departmentInput instanceof HTMLInputElement) || !(positionInput instanceof HTMLInputElement) || !(hireDateInput instanceof HTMLInputElement)) {
      throw new Error('HR profile inputs not found')
    }

    employeeNoInput.value = 'E-2026-009'
    employeeNoInput.dispatchEvent(new Event('input', { bubbles: true }))
    departmentInput.value = 'Assembly'
    departmentInput.dispatchEvent(new Event('input', { bubbles: true }))
    positionInput.value = 'Line Lead'
    positionInput.dispatchEvent(new Event('input', { bubbles: true }))
    hireDateInput.value = '2026-05-29'
    hireDateInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    findButtonByText(container!, '保存资料').click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/user-2/profile'))

    const profileCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/user-2/profile')
    if (!profileCall) throw new Error('Profile update request not found')
    expect(JSON.parse(String((profileCall[1] as RequestInit | undefined)?.body))).toEqual({
      name: 'Bravo',
      mobile: '',
      employeeNo: 'E-2026-009',
      department: 'Assembly',
      position: 'Line Lead',
      hireDate: '2026-05-29',
      expectedMobile: null,
    })

    await waitForCondition(() => container?.textContent?.includes('员工号：E-2026-009') ?? false)
    expect(container?.textContent).toContain('部门：Assembly')
    expect(container?.textContent).toContain('岗位：Line Lead')
    expect(container?.textContent).toContain('入职：2026-05-29')
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
    await waitForCondition(() => container!.querySelector('input[placeholder="手机号，可留空"]') !== null)

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
    await waitForCondition(() => container!.querySelector('input[placeholder="手机号，可留空"]') !== null)

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
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    const inputs = Array.from(container!.querySelectorAll('.user-admin__panel--create input'))
    const nameInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '姓名') as HTMLInputElement | undefined
    const usernameInput = inputs.find((candidate) => candidate.getAttribute('aria-label') === '登录名（可选）') as HTMLInputElement | undefined
    const mobileInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '手机号（可选）') as HTMLInputElement | undefined
    const employeeNoInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '员工号（可选）') as HTMLInputElement | undefined
    const departmentInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '部门（可选）') as HTMLInputElement | undefined
    const positionInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '岗位（可选）') as HTMLInputElement | undefined
    const hireDateInput = inputs.find((candidate) => candidate.getAttribute('aria-label') === '入职日期（可选）') as HTMLInputElement | undefined
    const groupSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="考勤组（可选）"]')
    const shiftSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="默认班次（可选）"]')
    const shiftStartDateInput = inputs.find((candidate) => candidate.getAttribute('aria-label') === '默认班次生效日期（可选）') as HTMLInputElement | undefined
    if (
      !nameInput
      || !usernameInput
      || !mobileInput
      || !employeeNoInput
      || !departmentInput
      || !positionInput
      || !hireDateInput
      || !groupSelect
      || !shiftSelect
      || !shiftStartDateInput
    ) {
      throw new Error('Create-user form inputs not found')
    }

    nameInput.value = '林岚'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    usernameInput.value = 'linlan'
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
    mobileInput.value = '13900001234'
    mobileInput.dispatchEvent(new Event('input', { bubbles: true }))
    employeeNoInput.value = 'E-2026-010'
    employeeNoInput.dispatchEvent(new Event('input', { bubbles: true }))
    departmentInput.value = 'Assembly'
    departmentInput.dispatchEvent(new Event('input', { bubbles: true }))
    positionInput.value = 'Operator'
    positionInput.dispatchEvent(new Event('input', { bubbles: true }))
    hireDateInput.value = '2026-05-29'
    hireDateInput.dispatchEvent(new Event('input', { bubbles: true }))
    await setSelectValue(groupSelect, '11111111-1111-4111-8111-111111111111')
    await setSelectValue(shiftSelect, '22222222-2222-4222-8222-222222222222')
    shiftStartDateInput.value = '2026-06-01'
    shiftStartDateInput.dispatchEvent(new Event('input', { bubbles: true }))
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
      employeeNo: 'E-2026-010',
      department: 'Assembly',
      position: 'Operator',
      hireDate: '2026-05-29',
      attendanceGroupId: '11111111-1111-4111-8111-111111111111',
      defaultShiftId: '22222222-2222-4222-8222-222222222222',
      defaultShiftStartDate: '2026-06-01',
      role: 'user',
      isActive: true,
    })
    expect(container?.textContent).toContain('用户已创建')
    expect(container?.textContent).toContain('新用户临时密码：Temp#123456')
    expect(container?.textContent).toContain('账号：linlan')
    const nextStep = container!.querySelector<HTMLElement>('[data-attendance-onboarding-next-step]')
    expect(nextStep).toBeTruthy()
    expect(nextStep?.textContent).toContain('下一步：补齐考勤配置')
    expect(nextStep?.textContent).toContain('林岚 · 员工号 E-2026-010 · Assembly · Operator · 入职 2026-05-29')
    const nextStepLinks = Array.from(nextStep!.querySelectorAll<HTMLAnchorElement>('a')).map(link => ({
      text: link.textContent?.trim(),
      href: link.getAttribute('href'),
    }))
    expect(nextStepLinks).toEqual([
      {
        text: '考勤组成员',
        href: '/attendance?tab=admin&section=attendance-admin-groups&userId=user-created&q=E-2026-010',
      },
      {
        text: '班次分配',
        href: '/attendance?tab=admin&section=attendance-admin-assignments&userId=user-created&q=E-2026-010',
      },
      {
        text: '审批流',
        href: '/attendance?tab=admin&section=attendance-admin-approval-flows&userId=user-created&q=E-2026-010',
      },
    ])
    expect(container?.textContent).not.toContain('首次设置密码链接：')
  })

  describe('create-user validation copy (customer feedback 20261008 #1)', () => {
    async function submitCreateUserAgainst(error: Record<string, unknown>, fields: { name: string; username: string; password: string }): Promise<void> {
      const fallback = createApiImplementation(callLog)
      apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost')
        if (url.pathname === '/api/admin/users' && (init?.method || 'GET').toUpperCase() === 'POST') {
          callLog.push(String(input))
          return createJsonResponse({ ok: false, error }, 400)
        }
        return fallback(input, init)
      })
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      app.mount(container!)
      await flushUi(20)

      const inputs = Array.from(container!.querySelectorAll<HTMLInputElement>('.user-admin__panel--create input'))
      const nameInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '姓名')
      const usernameInput = inputs.find((candidate) => candidate.getAttribute('aria-label') === '登录名（可选）')
      const passwordInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '可选：初始密码')
      if (!nameInput || !usernameInput || !passwordInput) throw new Error('Create-user form inputs not found')
      for (const [input, value] of [[nameInput, fields.name], [usernameInput, fields.username], [passwordInput, fields.password]] as const) {
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await flushUi(2)
      findButtonByText(container!, '创建用户').click()
      await waitForCondition(() => Boolean(container!.querySelector('.user-admin__status--error')))
    }

    function errorBannerText(): string {
      return container!.querySelector('.user-admin__status--error')?.textContent?.trim() || ''
    }

    it('states both rules in the create form and labels the login-name field', async () => {
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      app.mount(container!)
      await flushUi(20)

      const loginNameRule = container!.querySelector('[data-create-user-rule="login-name"]')?.textContent || ''
      const passwordRule = container!.querySelector('[data-create-user-rule="password"]')?.textContent || ''
      expect(loginNameRule).toContain('小写字母、数字和 . _ -')
      expect(loginNameRule).toContain('中文姓名请填「姓名」栏')
      expect(passwordRule).toContain('8–128 位')
      expect(passwordRule).toContain('大写字母、小写字母和数字')
      expect(passwordRule).toContain('不能包含 123456、password')
      const usernameInput = container!.querySelector<HTMLInputElement>('.user-admin__panel--create input[aria-label="登录名（可选）"]')
      expect(usernameInput?.getAttribute('placeholder')).toBe('登录名（可选，小写字母/数字）')
    })

    it('renders the weak-pattern password failure as a Chinese sentence instead of the English server message', async () => {
      await submitCreateUserAgainst({
        code: 'PASSWORD_POLICY_FAILED',
        message: 'Password does not meet requirements',
        details: {
          details: ['Password contains a common weak pattern'],
          reasons: ['weak_pattern'],
        },
      }, { name: '测试员', username: 'operator.a', password: '123456Asd' })

      expect(errorBannerText()).toBe('密码不符合要求：不能包含 123456、password、qwerty、abc123、letmein、admin 这类常见片段（不区分大小写）')
      expect(errorBannerText()).not.toContain('Password')
    })

    it('renders the non-ASCII login-name failure as a Chinese sentence that points at the 姓名 field', async () => {
      await submitCreateUserAgainst({
        code: 'INVALID_USERNAME',
        message: 'Username must be 3-64 characters and include at least one letter. Only lowercase letters, numbers, dot, underscore, and dash are allowed',
        details: { rule: 'login_name_ascii' },
      }, { name: '测试员', username: '测试员', password: '12345Asd' })

      expect(errorBannerText()).toBe('登录名只能用小写字母、数字和 . _ -，3–64 位且至少一个字母；中文姓名请填「姓名」栏')
      expect(errorBannerText()).not.toContain('Username')
    })

    it('falls back to the server message for an unmapped code', async () => {
      await submitCreateUserAgainst({
        code: 'USERNAME_ALREADY_EXISTS',
        message: 'User with this username already exists',
      }, { name: '测试员', username: 'operator.a', password: '12345Asd' })

      expect(errorBannerText()).toBe('User with this username already exists')
    })

    it('maps every password reason in order, keeps an en variant, and falls back when it cannot map', () => {
      expect(describeCreateUserError({
        code: 'PASSWORD_POLICY_FAILED',
        details: { reasons: ['too_short', 'too_long', 'no_lowercase', 'no_uppercase', 'no_digit', 'weak_pattern'] },
      }, 'zh')).toBe('密码不符合要求：至少 8 位；不超过 128 位；要有小写字母；要有大写字母；要有数字；不能包含 123456、password、qwerty、abc123、letmein、admin 这类常见片段（不区分大小写）')
      expect(describeCreateUserError({
        code: 'PASSWORD_POLICY_FAILED',
        details: { reasons: ['too_short', 'no_digit'] },
      }, 'en')).toBe('Password does not meet requirements: at least 8 characters; at least one number')
      expect(describeCreateUserError({
        code: 'INVALID_USERNAME',
        details: { rule: 'login_name_ascii' },
      }, 'en')).toContain('put a Chinese name in the Name field')
      // An unknown reason next to a known one keeps the server's index-aligned English string.
      expect(describeCreateUserError({
        code: 'PASSWORD_POLICY_FAILED',
        details: { details: ['Password must be at least 8 characters long', 'Some future rule'], reasons: ['too_short', 'future_rule'] },
      }, 'zh')).toBe('密码不符合要求：至少 8 位；Some future rule')
      // No mapping at all -> null, so the view keeps the server message.
      expect(describeCreateUserError({ code: 'PASSWORD_POLICY_FAILED', details: { details: ['x'] } }, 'zh')).toBeNull()
      // The shared sentence builder used by the forced first-login change page.
      expect(describePasswordPolicyFailure(['no_lowercase', 'no_uppercase'], 'zh')).toBe('密码不符合要求：要有小写字母；要有大写字母')
      expect(describePasswordPolicyFailure(['no_digit'], 'en')).toBe('Password does not meet requirements: at least one number')
      expect(describePasswordPolicyFailure([], 'zh')).toBeNull()
      expect(describeCreateUserError({ code: 'PASSWORD_POLICY_FAILED', details: { reasons: ['future_rule'] } }, 'zh')).toBeNull()
      expect(describeCreateUserError({ code: 'INVALID_USERNAME', details: { rule: 'something_else' } }, 'zh')).toBeNull()
      expect(describeCreateUserError({ code: 'INVALID_USERNAME' }, 'zh')).toBeNull()
      expect(describeCreateUserError({ code: 'USER_ALREADY_EXISTS', message: 'x' }, 'zh')).toBeNull()
      expect(describeCreateUserError(undefined, 'zh')).toBeNull()
    })
  })

  describe('W1-6: create-form org selector (owner ruling 2026-10-10)', () => {
    function mountWith(options: ApiImplementationOptions): void {
      apiFetchMock.mockImplementation(createApiImplementation(callLog, createApiState(), options))
      app = createApp(UserManagementView)
      registerRouterLink(app, true)
      app.mount(container!)
    }

    function orgSelect(): HTMLSelectElement {
      const select = container!.querySelector<HTMLSelectElement>('select[aria-label="所属组织（可选）"]')
      if (!select) throw new Error('Org select not found')
      return select
    }

    async function fillRequiredAndSubmit(): Promise<Record<string, unknown>> {
      const inputs = Array.from(container!.querySelectorAll<HTMLInputElement>('.user-admin__panel--create input'))
      const nameInput = inputs.find((candidate) => candidate.getAttribute('placeholder') === '姓名')
      const usernameInput = inputs.find((candidate) => candidate.getAttribute('aria-label') === '登录名（可选）')
      if (!nameInput || !usernameInput) throw new Error('Create-user form inputs not found')
      nameInput.value = '组织测试'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      usernameInput.value = 'org.tester'
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi(2)
      findButtonByText(container!, '创建用户').click()
      await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users' && (args[1] as RequestInit | undefined)?.method === 'POST'))
      await flushUi(8)
      const createCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users' && (args[1] as RequestInit | undefined)?.method === 'POST')
      if (!createCall) throw new Error('Create-user request not found')
      return JSON.parse(String((createCall[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    }

    it('lists the session orgs but never pre-selects one, even when it is the only option', async () => {
      mountWith({ sessionOrgs: ['org-alpha'] })
      await flushUi(20)

      expect(callLog).toContain('/api/auth/session-orgs')
      const select = orgSelect()
      expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'org-alpha'])
      expect(select.options[0].textContent?.trim()).toBe('不指定组织（不写入组织归属）')
      expect(select.value).toBe('')
      expect(container!.querySelector('[data-create-user-org-clear]')).toBeNull()

      const body = await fillRequiredAndSubmit()
      expect(body).not.toHaveProperty('attendanceOrgId')
    })

    // Gate r1 P2-2: "never silently default" must hold for every option count, and also when the
    // session reports a current org (a single-org install's admin token carries one).
    for (const [label, sessionOrgs, sessionCurrentOrgId] of [
      ['two options, no current org', ['org-alpha', 'org-beta'], null],
      ['one option that is also the current org', ['org-alpha'], 'org-alpha'],
      ['several options, the current org listed second', ['org-alpha', 'org-beta', 'org-gamma'], 'org-beta'],
    ] as const) {
      it(`does not pre-select or send an org without a choice (${label})`, async () => {
        mountWith({ sessionOrgs: [...sessionOrgs], sessionCurrentOrgId })
        await flushUi(20)

        const select = orgSelect()
        expect(Array.from(select.options).map((option) => option.value)).toEqual(['', ...sessionOrgs])
        expect(select.value).toBe('')
        expect(select.selectedIndex).toBe(0)
        expect(container!.querySelector('[data-create-user-org-clear]')).toBeNull()

        const body = await fillRequiredAndSubmit()
        expect(body).not.toHaveProperty('attendanceOrgId')
      })
    }

    // Reconcile §5.3 acceptance: picking only an attendance group must not drag an org along (on an
    // anchorless upgrade install an added attendanceOrgId would turn today's 200 into a 404).
    it('does not add attendanceOrgId when only an attendance group is picked', async () => {
      mountWith({ sessionOrgs: ['org-alpha'], sessionCurrentOrgId: 'org-alpha' })
      await flushUi(20)

      const groupSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="考勤组（可选）"]')
      if (!groupSelect) throw new Error('Attendance group select not found')
      await setSelectValue(groupSelect, '11111111-1111-4111-8111-111111111111')
      expect(orgSelect().value).toBe('')

      const body = await fillRequiredAndSubmit()
      expect(body.attendanceGroupId).toBe('11111111-1111-4111-8111-111111111111')
      expect(body).not.toHaveProperty('attendanceOrgId')
    })

    it('sends attendanceOrgId only when an org is chosen, and the clear button drops it again', async () => {
      mountWith({ sessionOrgs: ['org-alpha', 'org-beta'], sessionCurrentOrgId: 'org-beta' })
      await flushUi(20)
      expect(orgSelect().value).toBe('')

      await setSelectValue(orgSelect(), 'org-beta')
      const clear = container!.querySelector<HTMLButtonElement>('[data-create-user-org-clear]')
      expect(clear?.textContent?.trim()).toBe('清除组织')
      clear!.click()
      await flushUi(2)
      expect(orgSelect().value).toBe('')
      expect(container!.querySelector('[data-create-user-org-clear]')).toBeNull()

      await setSelectValue(orgSelect(), 'org-alpha')
      const body = await fillRequiredAndSubmit()
      expect(body.attendanceOrgId).toBe('org-alpha')
      // The form resets after a successful create: the org choice does not leak into the next user.
      expect(orgSelect().value).toBe('')
    })

    it('keeps the form usable with no org when the org list cannot be loaded', async () => {
      mountWith({ sessionOrgs: 'fail' })
      await flushUi(20)

      expect(Array.from(orgSelect().options).map((option) => option.value)).toEqual([''])
      expect(container!.querySelector('[data-create-user-org-hint]')?.textContent?.trim())
        .toBe('组织列表暂不可用；不指定组织时不会写入组织归属。')
      const body = await fillRequiredAndSubmit()
      expect(body).not.toHaveProperty('attendanceOrgId')
    })

    it('says so when the signed-in admin has no org to offer', async () => {
      mountWith({ sessionOrgs: [] })
      await flushUi(20)

      expect(Array.from(orgSelect().options).map((option) => option.value)).toEqual([''])
      expect(container!.querySelector('[data-create-user-org-hint]')?.textContent?.trim())
        .toBe('当前账号没有可选的组织；不指定组织时不会写入组织归属。')
    })

    // W1-6 ⑥ (owner ruling 2026-10-10): show which org a picked attendance group / default shift puts
    // the new user in -- display only, never an implicit attendanceOrgId.
    describe('⑥ the org an attendance group / default shift puts the new user in', () => {
      const GROUP_ID = '11111111-1111-4111-8111-111111111111'
      const SHIFT_ID = '22222222-2222-4222-8222-222222222222'

      function groupSelect(): HTMLSelectElement {
        const select = container!.querySelector<HTMLSelectElement>('select[aria-label="考勤组（可选）"]')
        if (!select) throw new Error('Attendance group select not found')
        return select
      }

      function shiftSelect(): HTMLSelectElement {
        const select = container!.querySelector<HTMLSelectElement>('select[aria-label="默认班次（可选）"]')
        if (!select) throw new Error('Default shift select not found')
        return select
      }

      function note(): string | null {
        return container!.querySelector('[data-create-user-attendance-org-note]')?.textContent?.trim() ?? null
      }

      it('shows nothing while no group or shift is picked', async () => {
        mountWith({ sessionOrgs: ['org-alpha'], attendanceGroupOrgId: 'org-alpha', attendanceShiftOrgId: 'org-alpha' })
        await flushUi(20)
        expect(note()).toBeNull()
      })

      it('group picked: names the group\'s org, leaves the org selector empty and sends no attendanceOrgId', async () => {
        mountWith({ sessionOrgs: ['org-alpha', 'org-beta'], sessionCurrentOrgId: 'org-beta', attendanceGroupOrgId: 'org-alpha' })
        await flushUi(20)

        await setSelectValue(groupSelect(), GROUP_ID)
        expect(note()).toBe('新用户将加入组织 org-alpha（所选考勤组所属的组织）。')
        expect(orgSelect().value).toBe('')
        expect(container!.querySelector('[data-create-user-org-clear]')).toBeNull()

        const body = await fillRequiredAndSubmit()
        expect(body.attendanceGroupId).toBe(GROUP_ID)
        expect(body).not.toHaveProperty('attendanceOrgId')
      })

      it('shift only: names the shift\'s org and still sends no attendanceOrgId', async () => {
        mountWith({ sessionOrgs: ['org-alpha'], attendanceShiftOrgId: 'org-alpha' })
        await flushUi(20)

        await setSelectValue(shiftSelect(), SHIFT_ID)
        expect(note()).toBe('新用户将加入组织 org-alpha（所选默认班次所属的组织）。')
        expect(orgSelect().value).toBe('')

        const body = await fillRequiredAndSubmit()
        expect(body.defaultShiftId).toBe(SHIFT_ID)
        expect(body).not.toHaveProperty('attendanceOrgId')
      })

      it('the note disappears again when the group is cleared', async () => {
        mountWith({ sessionOrgs: ['org-alpha'], attendanceGroupOrgId: 'org-alpha' })
        await flushUi(20)
        await setSelectValue(groupSelect(), GROUP_ID)
        expect(note()).not.toBeNull()
        await setSelectValue(groupSelect(), '')
        expect(note()).toBeNull()
      })

      it('says the create will be refused when the chosen org differs from the group\'s org', async () => {
        mountWith({ sessionOrgs: ['org-alpha', 'org-beta'], attendanceGroupOrgId: 'org-alpha' })
        await flushUi(20)
        await setSelectValue(groupSelect(), GROUP_ID)
        await setSelectValue(orgSelect(), 'org-beta')
        expect(note()).toBe('所选考勤组属于组织 org-alpha，与上面选择的组织不一致，创建会被拒绝；请改选组织或清除组织。')
        await setSelectValue(orgSelect(), 'org-alpha')
        expect(note()).toBe('新用户将加入组织 org-alpha（所选考勤组所属的组织）。')
      })

      it('says the create will be refused when the group and the shift belong to different orgs', async () => {
        mountWith({ sessionOrgs: ['org-alpha'], attendanceGroupOrgId: 'org-alpha', attendanceShiftOrgId: 'org-beta' })
        await flushUi(20)
        await setSelectValue(groupSelect(), GROUP_ID)
        await setSelectValue(shiftSelect(), SHIFT_ID)
        expect(note()).toBe('所选考勤组和默认班次属于不同的组织，创建会被拒绝；请改选其中之一。')
      })

      it('shows nothing (never a guessed default) when the group list carries no org', async () => {
        mountWith({ sessionOrgs: ['org-alpha'] })
        await flushUi(20)
        await setSelectValue(groupSelect(), GROUP_ID)
        expect(note()).toBeNull()
        const body = await fillRequiredAndSubmit()
        expect(body).not.toHaveProperty('attendanceOrgId')
      })
    })

    it('renders the org validation failures as values-free Chinese sentences', () => {
      expect(describeCreateUserError({ code: 'ATTENDANCE_ORG_NOT_FOUND', message: 'attendanceOrgId does not match a known org' }, 'zh'))
        .toBe('所选组织尚未在目录中建立，未创建用户；请改选其他组织或不指定组织')
      expect(describeCreateUserError({ code: 'ATTENDANCE_ORG_CONFLICT' }, 'zh'))
        .toBe('所选组织与考勤组/默认班次所属的组织不一致，未创建用户')
      expect(describeCreateUserError({ code: 'ATTENDANCE_ORG_NOT_FOUND' }, 'en')).toContain('not set up in the directory')
    })
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

  describe('slice B: read-only 所属组织 in the member-admission block (owner ruling on #6079)', () => {
    const NONE_NOTICE = '未归属任何组织：该账号无法使用云课堂等按组织隔离的应用；请用目录管理或新建账号时的「所属组织」补齐'
    const MULTIPLE_NOTICE = '属于多个组织：登录后需在页面顶部选择组织'

    // `organizations: undefined` leaves the field out of the payload entirely (an older backend).
    function installOrganizations(organizations: unknown, overrides: { accountEnabled?: boolean } = {}): void {
      const base = createApiImplementation(callLog)
      apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const response = await base(input, init)
        const pathname = new URL(String(input), 'http://localhost').pathname
        if (!/^\/api\/admin\/users\/[^/]+\/member-admission$/.test(pathname)) return response
        const payload = await response.json() as { ok: boolean; data: Record<string, unknown> }
        const data: Record<string, unknown> = { ...payload.data, ...overrides }
        if (organizations !== undefined) data.organizations = organizations
        return createJsonResponse({ ...payload, data })
      })
    }

    function orgBlock(): HTMLElement | null {
      return container!.querySelector('[data-testid="member-admission-organizations"]')
    }

    function orgChips(): string[] {
      return Array.from(container!.querySelectorAll('[data-testid="member-admission-org-chip"]'))
        .map((chip) => chip.textContent?.trim() ?? '')
    }

    async function mountPage(): Promise<void> {
      app = createApp(UserManagementView)
      registerRouterLink(app)
      app.mount(container!)
      await flushUi(20)
      await waitForCondition(() => callLog.some((url) => url.endsWith('/member-admission')))
      await flushUi(8)
    }

    it('one active organization: shows that org as a chip under 所属组织 and no warning', async () => {
      installOrganizations({ active: [{ orgId: 'org-alpha' }], hasTenantContext: true })
      await mountPage()
      await waitForCondition(() => orgBlock() !== null)

      expect(orgBlock()!.closest('.user-admin__section')?.querySelector('h3')?.textContent?.trim()).toBe('成员准入')
      expect(orgBlock()!.textContent).toContain('所属组织')
      expect(orgChips()).toEqual(['org-alpha'])
      expect(container!.querySelector('[data-testid="member-admission-org-chip"]')!.classList.contains('user-admin__chip--success')).toBe(true)
      expect(container!.querySelector('[data-testid="member-admission-org-none"]')).toBeNull()
      expect(container!.querySelector('[data-testid="member-admission-org-multiple"]')).toBeNull()
    })

    it('no active organization: no chips and the 未归属任何组织 sentence', async () => {
      installOrganizations({ active: [], hasTenantContext: false })
      await mountPage()
      await waitForCondition(() => orgBlock() !== null)

      expect(orgChips()).toEqual([])
      expect(container!.querySelector('[data-testid="member-admission-org-none"]')!.textContent!.trim()).toBe(NONE_NOTICE)
      expect(container!.querySelector('[data-testid="member-admission-org-multiple"]')).toBeNull()
    })

    it('two active organizations: both chips and the 属于多个组织 sentence', async () => {
      installOrganizations({ active: [{ orgId: 'org-alpha' }, { orgId: 'org-bravo' }], hasTenantContext: false })
      await mountPage()
      await waitForCondition(() => orgBlock() !== null)

      expect(orgChips()).toEqual(['org-alpha', 'org-bravo'])
      expect(container!.querySelector('[data-testid="member-admission-org-chip"]')!.classList.contains('user-admin__chip--success')).toBe(false)
      expect(container!.querySelector('[data-testid="member-admission-org-multiple"]')!.textContent!.trim()).toBe(MULTIPLE_NOTICE)
      expect(container!.querySelector('[data-testid="member-admission-org-none"]')).toBeNull()
    })

    it('older backend without the field: renders nothing for organizations, the rest of the block still renders', async () => {
      installOrganizations(undefined)
      await mountPage()
      await waitForCondition(() => container!.textContent?.includes('平台账号已启用') ?? false)

      expect(orgBlock()).toBeNull()
      expect(orgChips()).toEqual([])
      expect(container!.textContent).not.toContain(NONE_NOTICE)
      expect(container!.textContent).not.toContain(MULTIPLE_NOTICE)
    })

    it('a malformed field (no active list) is treated like an absent one, not as "no organization"', async () => {
      installOrganizations({ hasTenantContext: false })
      await mountPage()
      await waitForCondition(() => container!.textContent?.includes('平台账号已启用') ?? false)

      expect(orgBlock()).toBeNull()
      expect(container!.textContent).not.toContain(NONE_NOTICE)
    })

    it('organizations: null from the server (its read failed, "unknown") renders nothing, not 「未归属任何组织」', async () => {
      installOrganizations(null)
      await mountPage()
      await waitForCondition(() => container!.textContent?.includes('平台账号已启用') ?? false)

      expect(orgBlock()).toBeNull()
      expect(container!.textContent).not.toContain(NONE_NOTICE)
    })

    for (const [label, organizations] of [
      ['an item without a string orgId', { active: [{ orgId: 42 }], hasTenantContext: false }],
      ['an item with a whitespace-only orgId', { active: [{ orgId: '   ' }], hasTenantContext: false }],
      ['a good item next to a bad one', { active: [{ orgId: 'org-alpha' }, {}], hasTenantContext: false }],
      ['a non-boolean hasTenantContext', { active: [{ orgId: 'org-alpha' }], hasTenantContext: 'yes' }],
    ] as const) {
      it(`a malformed payload (${label}) renders nothing instead of a wrong claim`, async () => {
        installOrganizations(organizations)
        await mountPage()
        await waitForCondition(() => container!.textContent?.includes('平台账号已启用') ?? false)

        expect(orgBlock()).toBeNull()
        expect(orgChips()).toEqual([])
        expect(container!.textContent).not.toContain(NONE_NOTICE)
      })
    }

    it('disabled account: renders nothing for organizations (the login predicate reads it as none, which is not the remedy)', async () => {
      installOrganizations({ active: [], hasTenantContext: false }, { accountEnabled: false })
      await mountPage()
      await waitForCondition(() => container!.textContent?.includes('平台账号未启用') ?? false)

      expect(orgBlock()).toBeNull()
      expect(container!.textContent).not.toContain(NONE_NOTICE)
    })
  })

  describe('slice C: 加入默认组织 for a zero-org user (owner 2026-10-13)', () => {
    const JOIN_PATH = '/api/admin/directory/local/accounts'
    const ADMISSION_PATH = '/api/admin/users/user-1/member-admission'
    // What a server might put in an error body; it must never reach the page.
    const SERVER_TEXT = 'MKSLICEC a local directory account already exists for this user in this org'
    const GENERIC_FAILURE = '加入默认组织失败，请稍后重试'
    const CONFLICT_MESSAGE = '该账号已有本地目录账号或已停用，不能再加入默认组织；请到目录管理查看'
    const HISTORY_MESSAGE = '该账号在默认组织已有归属记录或离职记录，不能从本页加入；活跃归属无需处理，停用归属或离职记录请按目录管理 / 离职证据流程处理。'
    const USER_GONE_MESSAGE = '该账号已不存在，请刷新列表'
    const ZERO_ORG_CLEAR = { active: [], hasTenantContext: false, hasAnyRow: false, deprovisionApplied: false }

    type JoinResponder = () => ReturnType<typeof createJsonResponse> | Promise<ReturnType<typeof createJsonResponse>>
    let joinCalls: Array<{ method: string | undefined; body: unknown }> = []

    // Before any successful POST the member-admission read answers `organizations` (left out when undefined, an
    // older backend); after one it answers the `default` membership the route creates.
    function installJoin(
      organizations: unknown,
      options: {
        accountEnabled?: boolean
        respond?: JoinResponder
        // Per-user `organizations` overriding the shared one.
        organizationsFor?: Record<string, unknown>
        // Overrides the `userId` the admission payload claims (a malformed / mismatched answer).
        admissionUserId?: string
        // Lets a test hold (or fail) a given user's n-th admission read.
        holdAdmission?: (userId: string, callIndex: number) => Promise<void> | undefined
      } = {},
    ): void {
      joinCalls = []
      const joinedUserIds = new Set<string>()
      const admissionCalls = new Map<string, number>()
      const respond: JoinResponder = options.respond
        ?? (() => createJsonResponse({ ok: true, data: { account: { id: 'acct-1', localUserId: 'user-1' } } }))
      const base = createApiImplementation(callLog)
      apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const pathname = new URL(String(input), 'http://localhost').pathname
        if (pathname === JOIN_PATH) {
          callLog.push(String(input))
          const body = init?.body ? JSON.parse(String(init.body)) as { localUserId?: string } : undefined
          joinCalls.push({ method: init?.method, body })
          const response = await respond()
          if (response.ok && body?.localUserId) joinedUserIds.add(body.localUserId)
          return response
        }
        const isAdmission = pathname.startsWith('/api/admin/users/') && pathname.endsWith('/member-admission')
        const admissionUser = isAdmission ? decodeURIComponent(pathname.split('/')[4]) : ''
        if (isAdmission) {
          const callIndex = admissionCalls.get(admissionUser) ?? 0
          admissionCalls.set(admissionUser, callIndex + 1)
          const hold = options.holdAdmission?.(admissionUser, callIndex)
          if (hold) await hold
        }
        const response = await base(input, init)
        if (!isAdmission) return response
        const payload = await response.json() as { ok: boolean; data: Record<string, unknown> }
        const data: Record<string, unknown> = { ...payload.data }
        if (options.accountEnabled !== undefined) data.accountEnabled = options.accountEnabled
        if (options.admissionUserId !== undefined) data.userId = options.admissionUserId
        const ownOrganizations = options.organizationsFor && admissionUser in options.organizationsFor
          ? options.organizationsFor[admissionUser]
          : organizations
        if (joinedUserIds.has(admissionUser)) {
          data.organizations = { active: [{ orgId: 'default' }], hasTenantContext: true, hasAnyRow: true, deprovisionApplied: false }
        } else if (ownOrganizations !== undefined) {
          data.organizations = ownOrganizations
        }
        return createJsonResponse({ ...payload, data })
      })
    }

    function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    async function openUser(name: string, userId: string): Promise<void> {
      const row = findUserRow(container!, name)
      const detailButton = Array.from(row.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(name))
      detailButton!.click()
      await waitForCondition(() => callLog.includes(`/api/admin/users/${userId}/member-admission`))
      await flushUi(12)
    }

    async function mountPage(): Promise<void> {
      app = createApp(UserManagementView)
      registerRouterLink(app)
      app.mount(container!)
      await flushUi(20)
      await waitForCondition(() => callLog.some((url) => url.endsWith('/member-admission')))
      await flushUi(8)
      await waitForCondition(() => container!.textContent?.includes('平台账号') ?? false)
    }

    function joinButton(): HTMLButtonElement | null {
      return container!.querySelector('[data-testid="join-default-org-button"]')
    }

    function confirmPanel(): HTMLElement | null {
      return container!.querySelector('[data-testid="join-default-org-confirm"]')
    }

    function orgChips(): string[] {
      return Array.from(container!.querySelectorAll('[data-testid="member-admission-org-chip"]'))
        .map((chip) => chip.textContent?.trim() ?? '')
    }

    function admissionLoads(): number {
      return callLog.filter((url) => url.includes(ADMISSION_PATH)).length
    }

    function errorStatus(): string {
      return container!.querySelector('.user-admin__status--error')?.textContent?.trim() ?? ''
    }

    async function confirmJoin(): Promise<void> {
      joinButton()!.click()
      await flushUi()
      container!.querySelector<HTMLButtonElement>('[data-testid="join-default-org-confirm-submit"]')!.click()
      await waitForCondition(() => joinCalls.length === 1)
      await flushUi(12)
    }

    for (const [label, organizations, accountEnabled] of [
      ['an older backend without organizations', undefined, true],
      ['organizations without the two slice-C booleans', { active: [], hasTenantContext: false }, true],
      ['hasAnyRow missing', { active: [], hasTenantContext: false, deprovisionApplied: false }, true],
      ['deprovisionApplied missing', { active: [], hasTenantContext: false, hasAnyRow: false }, true],
      ['hasAnyRow as a non-boolean', { ...ZERO_ORG_CLEAR, hasAnyRow: 'false' }, true],
      ['hasAnyRow: null (its read failed)', { ...ZERO_ORG_CLEAR, hasAnyRow: null }, true],
      ['deprovisionApplied: null (its read failed)', { ...ZERO_ORG_CLEAR, deprovisionApplied: null }, true],
      ['both slice-C booleans null', { ...ZERO_ORG_CLEAR, hasAnyRow: null, deprovisionApplied: null }, true],
      ['one active organization', { ...ZERO_ORG_CLEAR, active: [{ orgId: 'org-alpha' }] }, true],
      ['a prior membership row (hasAnyRow)', { ...ZERO_ORG_CLEAR, hasAnyRow: true }, true],
      ['an applied deprovision', { ...ZERO_ORG_CLEAR, deprovisionApplied: true }, true],
      ['a disabled account', ZERO_ORG_CLEAR, false],
    ] as const) {
      it(`hides 加入默认组织 for ${label}`, async () => {
        installJoin(organizations, { accountEnabled })
        await mountPage()

        expect(joinButton()).toBeNull()
        expect(container!.textContent).not.toContain('加入默认组织')
      })
    }

    it('shows 加入默认组织 only when all conditions are positively clear, and asks before writing', async () => {
      installJoin(ZERO_ORG_CLEAR)
      await mountPage()
      await waitForCondition(() => joinButton() !== null)

      expect(joinButton()!.textContent!.trim()).toBe('加入默认组织')
      expect(confirmPanel()).toBeNull()

      joinButton()!.click()
      await flushUi()
      const panel = confirmPanel()
      expect(panel).not.toBeNull()
      expect(panel!.getAttribute('role')).toBe('dialog')
      const items = Array.from(panel!.querySelectorAll('li')).map((item) => item.textContent?.trim())
      expect(items).toEqual([
        '会为该账号创建一条本地目录账号与链接（目录管理里可见）；',
        '加入组织后该用户进入考勤全员名册（自动缺勤 / 年假累计 / 考勤报表 / 汇总会计入）；',
        '用户需重新登录或刷新后，云课堂等按组织隔离的应用才可用。',
      ])
      expect(panel!.querySelector('[data-testid="join-default-org-confirm-undo"]')!.textContent!.trim())
        .toBe('此操作不能在本页撤销；撤销需运维调用目录接口归档该本地目录账号（界面暂无），归档后也不能再经本按钮加入。')
      expect(joinCalls).toEqual([])

      container!.querySelector<HTMLButtonElement>('[data-testid="join-default-org-confirm-cancel"]')!.click()
      await flushUi()
      expect(confirmPanel()).toBeNull()
      expect(joinCalls).toEqual([])
    })

    it('on confirm posts the user id, reloads the admission and shows the default chip', async () => {
      installJoin(ZERO_ORG_CLEAR)
      await mountPage()
      await waitForCondition(() => joinButton() !== null)
      const loadsBefore = admissionLoads()

      await confirmJoin()

      expect(joinCalls).toEqual([{ method: 'POST', body: { localUserId: 'user-1' } }])
      await waitForCondition(() => orgChips().length > 0)
      expect(admissionLoads()).toBeGreaterThan(loadsBefore)
      expect(orgChips()).toEqual(['default'])
      expect(joinButton()).toBeNull()
      expect(confirmPanel()).toBeNull()
      expect(container!.querySelector('[data-testid="member-admission-org-none"]')).toBeNull()
      expect(container!.textContent).toContain('已加入默认组织')
      expect(errorStatus()).toBe('')
    })

    it('disables the button while the request is in flight', async () => {
      let release: (() => void) | null = null
      installJoin(ZERO_ORG_CLEAR, {
        respond: () => new Promise((resolve) => {
          release = () => resolve(createJsonResponse({ ok: true, data: { account: { id: 'acct-1', localUserId: 'user-1' } } }))
        }),
      })
      await mountPage()
      await waitForCondition(() => joinButton() !== null)

      await confirmJoin()

      expect(joinButton()!.disabled).toBe(true)
      expect(joinButton()!.textContent!.trim()).toBe('加入中...')
      release!()
      await waitForCondition(() => orgChips().length > 0)
      expect(joinButton()).toBeNull()
    })

    it('a confirm panel opened for one user is not shown for another user', async () => {
      installJoin(ZERO_ORG_CLEAR)
      await mountPage()
      await waitForCondition(() => joinButton() !== null)
      joinButton()!.click()
      await flushUi()
      expect(confirmPanel()).not.toBeNull()

      const bravoRow = findUserRow(container!, 'Bravo')
      const bravoDetailButton = Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))
      bravoDetailButton!.click()
      await waitForCondition(() => callLog.includes('/api/admin/users/user-2/member-admission'))
      await flushUi(12)

      expect(joinButton()).not.toBeNull()
      expect(confirmPanel()).toBeNull()
      expect(joinCalls).toEqual([])
    })

    async function mountWithHeldFirstAdmission(): Promise<void> {
      app = createApp(UserManagementView)
      registerRouterLink(app)
      app.mount(container!)
      await flushUi(20)
      await waitForCondition(() => container!.querySelector('.user-admin__user') !== null)
    }

    it("refuter scenario: user-1's slow admission landing while user-2 is shown neither replaces user-2's panel nor offers a join", async () => {
      const heldAlpha = deferred()
      installJoin(ZERO_ORG_CLEAR, {
        organizationsFor: { 'user-2': { active: [{ orgId: 'org-bravo' }], hasTenantContext: true, hasAnyRow: true, deprovisionApplied: false } },
        holdAdmission: (userId, callIndex) => (userId === 'user-1' && callIndex === 0 ? heldAlpha.promise : undefined),
      })
      await mountWithHeldFirstAdmission()
      await openUser('Bravo', 'user-2')
      await waitForCondition(() => orgChips().length > 0)
      expect(orgChips()).toEqual(['org-bravo'])

      heldAlpha.resolve()
      await waitForCondition(() => callLog.includes(ADMISSION_PATH))
      await flushUi(12)

      expect(orgChips()).toEqual(['org-bravo'])
      expect(container!.querySelector('[data-testid="member-admission-org-none"]')).toBeNull()
      expect(joinButton()).toBeNull()
      expect(joinCalls).toEqual([])
    })

    it("user-1's slow admission failing while user-2 is shown does not wipe user-2's panel", async () => {
      const heldAlpha = deferred()
      installJoin(ZERO_ORG_CLEAR, {
        organizationsFor: { 'user-2': { active: [{ orgId: 'org-bravo' }], hasTenantContext: true, hasAnyRow: true, deprovisionApplied: false } },
        holdAdmission: (userId, callIndex) => (userId === 'user-1' && callIndex === 0 ? heldAlpha.promise : undefined),
      })
      await mountWithHeldFirstAdmission()
      await openUser('Bravo', 'user-2')
      await waitForCondition(() => orgChips().length > 0)

      heldAlpha.reject(new Error('MKSLICEC late failure'))
      await flushUi(20)

      expect(orgChips()).toEqual(['org-bravo'])
      expect(container!.querySelector('[data-testid="member-admission-load-failure"]')).toBeNull()
    })

    it('an admission whose userId is not the selected user never offers a join', async () => {
      installJoin(ZERO_ORG_CLEAR, { admissionUserId: 'user-other' })
      await mountPage()
      await waitForCondition(() => container!.querySelector('[data-testid="member-admission-org-none"]') !== null)

      expect(joinButton()).toBeNull()
    })

    it('a confirm clicked after the selection moved (before the page re-rendered) posts nothing and says so', async () => {
      installJoin(ZERO_ORG_CLEAR)
      await mountPage()
      await waitForCondition(() => joinButton() !== null)
      joinButton()!.click()
      await flushUi()
      const submit = container!.querySelector<HTMLButtonElement>('[data-testid="join-default-org-confirm-submit"]')!

      const bravoRow = findUserRow(container!, 'Bravo')
      Array.from(bravoRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Bravo'))!.click()
      submit.click()
      await waitForCondition(() => callLog.includes('/api/admin/users/user-2/member-admission'))
      await flushUi(12)

      expect(joinCalls).toEqual([])
      expect(errorStatus()).toBe(GENERIC_FAILURE)
    })

    it("a join in flight for user-1 does not mark user-2's button, and its success is not announced under user-2", async () => {
      let release: (() => void) | null = null
      installJoin(ZERO_ORG_CLEAR, {
        respond: () => new Promise((resolve) => {
          release = () => resolve(createJsonResponse({ ok: true, data: { account: { id: 'acct-1', localUserId: 'user-1' } } }))
        }),
      })
      await mountPage()
      await waitForCondition(() => joinButton() !== null)
      await confirmJoin()
      expect(joinButton()!.disabled).toBe(true)

      await openUser('Bravo', 'user-2')
      await waitForCondition(() => joinButton() !== null)
      expect(joinButton()!.disabled).toBe(false)
      expect(joinButton()!.textContent!.trim()).toBe('加入默认组织')
      const alphaLoadsBefore = admissionLoads()

      release!()
      await flushUi(20)

      expect(container!.textContent).not.toContain('已加入默认组织')
      expect(admissionLoads()).toBe(alphaLoadsBefore)
      expect(joinButton()).not.toBeNull()
      expect(joinButton()!.disabled).toBe(false)
    })

    for (const [label, respond, expected] of [
      [
        '404 DIRECTORY_LOCAL_NOT_FOUND (the user was deleted meanwhile)',
        () => createJsonResponse({ ok: false, error: { code: 'DIRECTORY_LOCAL_NOT_FOUND', message: SERVER_TEXT } }, 404),
        USER_GONE_MESSAGE,
      ],
      [
        'the not-found code on a non-404 status',
        () => createJsonResponse({ ok: false, error: { code: 'DIRECTORY_LOCAL_NOT_FOUND', message: SERVER_TEXT } }, 400),
        GENERIC_FAILURE,
      ],
      [
        '404 with another code',
        () => createJsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: SERVER_TEXT } }, 404),
        GENERIC_FAILURE,
      ],
      [
        '409 DIRECTORY_LOCAL_CONFLICT (existing account / inactive user)',
        () => createJsonResponse({ ok: false, error: { code: 'DIRECTORY_LOCAL_CONFLICT', message: SERVER_TEXT } }, 409),
        CONFLICT_MESSAGE,
      ],
      [
        '409 DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY (prior membership or deprovision)',
        () => createJsonResponse({ ok: false, error: { code: 'DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY', message: SERVER_TEXT } }, 409),
        HISTORY_MESSAGE,
      ],
      [
        '409 with an unknown code',
        () => createJsonResponse({ ok: false, error: { code: 'SOMETHING_ELSE', message: SERVER_TEXT } }, 409),
        GENERIC_FAILURE,
      ],
      [
        'a known conflict code on a non-409 status',
        () => createJsonResponse({ ok: false, error: { code: 'DIRECTORY_LOCAL_CONFLICT', message: SERVER_TEXT } }, 400),
        GENERIC_FAILURE,
      ],
      [
        '500',
        () => createJsonResponse({ ok: false, error: { code: 'DIRECTORY_LOCAL_INTERNAL_ERROR', message: SERVER_TEXT } }, 500),
        GENERIC_FAILURE,
      ],
      [
        'a 2xx without the created account',
        () => createJsonResponse({ ok: true, data: { message: SERVER_TEXT } }),
        GENERIC_FAILURE,
      ],
      [
        'a network failure',
        () => Promise.reject(new Error(SERVER_TEXT)),
        GENERIC_FAILURE,
      ],
    ] as const) {
      it(`maps ${label} to this page's sentence, never the server text, and does not reload`, async () => {
        installJoin(ZERO_ORG_CLEAR, { respond })
        await mountPage()
        await waitForCondition(() => joinButton() !== null)
        const loadsBefore = admissionLoads()

        await confirmJoin()

        expect(errorStatus()).toBe(expected)
        expect(container!.textContent).not.toContain('MKSLICEC')
        expect(container!.textContent).not.toContain('已加入默认组织')
        expect(admissionLoads()).toBe(loadsBefore)
        expect(joinButton()).not.toBeNull()
      })
    }
  })

  describe('#6163: a failed DingTalk-access or member-admission load is shown inside its block', () => {
    // What the server might put in a 500 body: the text of an underlying error. It must never reach the page.
    const SERVER_TEXT = 'MK6163 Unsupported state or unable to authenticate data at probe.invalid'
    const DINGTALK_NOTICE = '钉钉扫码登录信息暂时无法加载，请刷新页面后重试。'
    const ADMISSION_NOTICE = '成员准入信息暂时无法加载，请刷新页面后重试。'
    const NAMESPACE_NOTICE = '插件使用准入信息暂时无法加载，请刷新页面后重试。'

    type SidePanelFailure = 'none' | 'server-500' | 'server-500-no-id' | 'server-500-bad-id' | 'network'

    function installSidePanelFailures(failures: { dingtalk: SidePanelFailure; admission: SidePanelFailure }) {
      const base = createApiImplementation(callLog)
      const respond = (kind: SidePanelFailure, code: string, correlationId: string) => {
        if (kind === 'network') throw new TypeError('Failed to fetch')
        const error: Record<string, unknown> = { code, message: SERVER_TEXT }
        if (kind === 'server-500') error.correlationId = correlationId
        if (kind === 'server-500-bad-id') error.correlationId = `${SERVER_TEXT} id`
        return createJsonResponse({ ok: false, error }, 500)
      }
      apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const pathname = new URL(String(input), 'http://localhost').pathname
        if (failures.dingtalk !== 'none' && /^\/api\/admin\/users\/[^/]+\/dingtalk-access$/.test(pathname)) {
          callLog.push(String(input))
          return respond(failures.dingtalk, 'DINGTALK_ACCESS_FAILED', 'probe-corr-6163-dingtalk')
        }
        if (failures.admission !== 'none' && /^\/api\/admin\/users\/[^/]+\/member-admission$/.test(pathname)) {
          callLog.push(String(input))
          return respond(failures.admission, 'MEMBER_ADMISSION_FAILED', 'probe-corr-6163-admission')
        }
        return base(input, init)
      })
      return failures
    }

    function topBanner(): HTMLElement | null {
      return container!.querySelector('section.user-admin > p.user-admin__status')
    }

    function blockNotice(testId: string): HTMLElement | null {
      return container!.querySelector(`[data-testid="${testId}"]`)
    }

    function sectionTitleOf(element: HTMLElement): string {
      return element.closest('.user-admin__section')?.querySelector('h3')?.textContent?.trim() ?? ''
    }

    async function mountPage(): Promise<void> {
      app = createApp(UserManagementView)
      registerRouterLink(app)
      app.mount(container!)
      await flushUi(20)
      await waitForCondition(() => callLog.some((url) => url.endsWith('/dingtalk-access'))
        && callLog.some((url) => url.endsWith('/member-admission')))
      await flushUi(8)
    }

    it('shows each failure in its own block with the page sentence and the reference number; the top banner is not written and the server text appears nowhere', async () => {
      installSidePanelFailures({ dingtalk: 'server-500', admission: 'server-500' })
      await mountPage()
      await waitForCondition(() => blockNotice('dingtalk-access-load-failure') !== null && blockNotice('member-admission-load-failure') !== null)

      const dingtalkNotice = blockNotice('dingtalk-access-load-failure')!
      expect(sectionTitleOf(dingtalkNotice)).toBe('钉钉扫码登录')
      expect(dingtalkNotice.textContent).toContain(DINGTALK_NOTICE)
      expect(dingtalkNotice.querySelector('small')?.textContent?.trim()).toBe('排查编号：probe-corr-6163-dingtalk')

      const admissionNotice = blockNotice('member-admission-load-failure')!
      expect(sectionTitleOf(admissionNotice)).toBe('成员准入')
      expect(admissionNotice.textContent).toContain(ADMISSION_NOTICE)
      expect(admissionNotice.querySelector('small')?.textContent?.trim()).toBe('排查编号：probe-corr-6163-admission')

      // The plugin-usage block does not claim that there is no data.
      const namespaceNotice = blockNotice('namespace-admission-load-failure')!
      expect(sectionTitleOf(namespaceNotice)).toBe('插件使用')
      expect(namespaceNotice.textContent).toContain(NAMESPACE_NOTICE)
      expect(container!.textContent).not.toContain('暂无插件使用准入信息')

      // A load failure, not a configuration state: no "not configured" wording in the notices.
      for (const notice of [dingtalkNotice, admissionNotice, namespaceNotice]) {
        expect(notice.textContent).not.toMatch(/未配置|未开通|不可用/)
      }

      expect(topBanner()).toBeNull()
      expect(container!.textContent).not.toContain('MK6163')
      expect(container!.textContent).not.toContain('Unsupported state')
      expect(container!.textContent).not.toContain('DINGTALK_ACCESS_FAILED')
      expect(container!.textContent).not.toContain('MEMBER_ADMISSION_FAILED')
    })

    it('leaves the top banner exactly as it was when a refresh of either block fails', async () => {
      const failures = installSidePanelFailures({ dingtalk: 'none', admission: 'none' })
      await mountPage()

      // Put a known message in the banner first (a successful plugin-usage change).
      const namespaceCard = container!.querySelector('.user-admin__role-card--namespace')
      const openButton = Array.from(namespaceCard?.querySelectorAll('button') ?? []).find((candidate) => candidate.textContent?.trim() === '开通插件使用')
      if (!(openButton instanceof HTMLButtonElement)) throw new Error('Namespace open button not found')
      openButton.click()
      await waitForCondition(() => topBanner()?.textContent?.includes('已开通 crm 插件使用') ?? false)
      const bannerBefore = { text: topBanner()!.textContent, className: topBanner()!.className }

      failures.dingtalk = 'server-500'
      findButtonByText(container!, '刷新钉钉状态').click()
      await waitForCondition(() => blockNotice('dingtalk-access-load-failure') !== null)

      failures.admission = 'server-500'
      findButtonByText(container!, '刷新准入状态').click()
      await waitForCondition(() => blockNotice('member-admission-load-failure') !== null)
      await flushUi(8)

      expect({ text: topBanner()!.textContent, className: topBanner()!.className }).toEqual(bannerBefore)
      expect(container!.textContent).not.toContain('MK6163')
    })

    it('a successful reload after a failure clears the block notice and shows the data again', async () => {
      const failures = installSidePanelFailures({ dingtalk: 'server-500', admission: 'server-500' })
      await mountPage()
      await waitForCondition(() => blockNotice('dingtalk-access-load-failure') !== null && blockNotice('member-admission-load-failure') !== null)

      failures.dingtalk = 'none'
      findButtonByText(container!, '刷新钉钉状态').click()
      await waitForCondition(() => blockNotice('dingtalk-access-load-failure') === null)
      expect(container!.textContent).toContain('服务端已启用钉钉登录')
      expect(container!.textContent).not.toContain(DINGTALK_NOTICE)
      // The other block's failure is its own: still shown.
      expect(blockNotice('member-admission-load-failure')).not.toBeNull()

      failures.admission = 'none'
      findButtonByText(container!, '刷新准入状态').click()
      await waitForCondition(() => blockNotice('member-admission-load-failure') === null)
      expect(blockNotice('namespace-admission-load-failure')).toBeNull()
      expect(container!.textContent).toContain('平台账号已启用')
      expect(container!.textContent).toContain('插件使用未开通')
      expect(container!.textContent).not.toContain(ADMISSION_NOTICE)
      expect(container!.textContent).not.toContain(NAMESPACE_NOTICE)
      expect(topBanner()).toBeNull()
    })

    it('shows no reference number when the body has none or a malformed one, and a network failure gets the same sentence', async () => {
      const failures = installSidePanelFailures({ dingtalk: 'server-500-no-id', admission: 'server-500-bad-id' })
      await mountPage()
      await waitForCondition(() => blockNotice('dingtalk-access-load-failure') !== null && blockNotice('member-admission-load-failure') !== null)

      expect(blockNotice('dingtalk-access-load-failure')!.textContent).toContain(DINGTALK_NOTICE)
      expect(blockNotice('dingtalk-access-load-failure')!.querySelector('small')).toBeNull()
      expect(blockNotice('member-admission-load-failure')!.textContent).toContain(ADMISSION_NOTICE)
      expect(blockNotice('member-admission-load-failure')!.querySelector('small')).toBeNull()
      expect(container!.textContent).not.toContain('MK6163')
      expect(container!.textContent).not.toContain('排查编号')

      failures.dingtalk = 'none'
      findButtonByText(container!, '刷新钉钉状态').click()
      await waitForCondition(() => blockNotice('dingtalk-access-load-failure') === null)

      failures.dingtalk = 'network'
      findButtonByText(container!, '刷新钉钉状态').click()
      await waitForCondition(() => blockNotice('dingtalk-access-load-failure') !== null)
      expect(blockNotice('dingtalk-access-load-failure')!.textContent).toContain(DINGTALK_NOTICE)
      expect(blockNotice('dingtalk-access-load-failure')!.querySelector('small')).toBeNull()
      expect(container!.textContent).not.toContain('Failed to fetch')
      expect(topBanner()).toBeNull()
    })
  })

  describe('admin reset-password inline rule', () => {
    // Customer report 2026-10-27: the reset rule now matches create-user (full password policy).
    const RULE_COPY = '临时密码：8–128 位，要同时有大写字母、小写字母和数字，不能包含 123456、password 这类常见片段；留空则自动生成临时密码。'
    const SHORT_COPY = '临时密码不足 8 位，未重置。'
    const POLICY_COPY = '临时密码不符合要求：要有大写字母；要有数字。未重置。'
    const SERVER_SHORT_ENGLISH = 'Password must be at least 8 characters long'
    const SERVER_POLICY_ENGLISH = 'Password does not meet requirements'
    const COMPLIANT_VALUE = 'Abcdefg1'

    type ResetOutcome = 'ok' | 'short' | 'policy' | 'other-400' | 'failed'
    const resets: Array<{ userId: string; passwordLength: number | null }> = []
    const revokes: string[] = []
    let resetOutcome: ResetOutcome = 'ok'
    let resetGate: Promise<void> | null = null

    function marks(length: number): string {
      return 'x'.repeat(length)
    }

    function installResetApi(): void {
      const base = createApiImplementation(callLog)
      apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const rawUrl = String(input)
        const method = (init?.method || 'GET').toUpperCase()
        const pathname = new URL(rawUrl, 'http://localhost').pathname
        if (method === 'POST' && pathname.endsWith('/reset-password')) {
          const match = pathname.match(/\/users\/([^/]+)\/reset-password$/)
          const rawBody = typeof init?.body === 'string' ? init.body : ''
          let passwordLength: number | null = null
          if (rawBody) {
            const parsed = JSON.parse(rawBody) as { password?: unknown }
            if (typeof parsed.password === 'string') passwordLength = parsed.password.length
          }
          resets.push({
            userId: match ? decodeURIComponent(match[1]) : '',
            passwordLength,
          })
          if (resetGate) await resetGate
          if (resetOutcome === 'short') {
            return createJsonResponse({
              ok: false,
              error: { code: 'PASSWORD_TOO_SHORT', message: SERVER_SHORT_ENGLISH },
            }, 400)
          }
          if (resetOutcome === 'policy') {
            return createJsonResponse({
              ok: false,
              error: {
                code: 'PASSWORD_POLICY_FAILED',
                message: SERVER_POLICY_ENGLISH,
                details: {
                  details: [
                    'Password must contain at least one uppercase letter',
                    'Password must contain at least one number',
                  ],
                  reasons: ['no_uppercase', 'no_digit'],
                },
              },
            }, 400)
          }
          if (resetOutcome === 'other-400') {
            return createJsonResponse({
              ok: false,
              error: { code: 'USER_ID_REQUIRED', message: 'userId is required' },
            }, 400)
          }
          if (resetOutcome === 'failed') {
            return createJsonResponse({
              ok: false,
              error: { code: 'PASSWORD_RESET_FAILED', message: 'Failed to reset password' },
            }, 500)
          }
          return createJsonResponse({
            ok: true,
            data: { userId: match ? decodeURIComponent(match[1]) : '', temporaryPassword: 'issued' },
          })
        }
        if (method === 'POST' && pathname.endsWith('/revoke-sessions')) {
          const match = pathname.match(/\/users\/([^/]+)\/revoke-sessions$/)
          revokes.push(match ? decodeURIComponent(match[1]) : '')
          return createJsonResponse({ ok: true, data: {} })
        }
        return base(input, init)
      })
    }

    function ruleEl(): HTMLElement | null {
      const node = container?.querySelector('[data-testid="admin-temporary-password-rule"]')
      return node instanceof HTMLElement ? node : null
    }

    function errorEl(): HTMLElement | null {
      const node = container?.querySelector('[data-testid="admin-temporary-password-error"]')
      return node instanceof HTMLElement ? node : null
    }

    function passwordInput(): HTMLInputElement {
      const node = container!.querySelector('[data-testid="admin-temporary-password"]')
      if (!(node instanceof HTMLInputElement)) throw new Error('temporary password input missing')
      return node
    }

    function pageBanner(): HTMLElement | null {
      const node = container!.querySelector('.user-admin > p.user-admin__status')
      return node instanceof HTMLElement ? node : null
    }

    function sessionHint(): HTMLElement | null {
      const node = Array.from(container!.querySelectorAll('p.user-admin__hint')).find((candidate) => candidate.textContent?.includes('现有会话失效'))
      return node instanceof HTMLElement ? node : null
    }

    async function typeManual(value: string): Promise<void> {
      const input = passwordInput()
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
    }

    async function clickReset(): Promise<void> {
      findButtonByText(container!, '重置密码').click()
      await flushUi()
    }

    async function openNamedUser(name: string): Promise<void> {
      const button = findUserRow(container!, name).querySelector('button.user-admin__user-body')
      if (!(button instanceof HTMLButtonElement)) throw new Error(`User button missing: ${name}`)
      button.click()
      await waitForCondition(() => container!.querySelector('[data-testid="selected-user-heading"]')?.textContent?.includes(name) ?? false)
    }

    async function mountAdmin(): Promise<void> {
      resets.length = 0
      revokes.length = 0
      resetOutcome = 'ok'
      resetGate = null
      installResetApi()
      app = createApp(UserManagementView)
      registerRouterLink(app)
      app.mount(container!)
      await waitForCondition(() => ruleEl() !== null)
    }

    it('maps PASSWORD_POLICY_FAILED reason codes to Chinese inline copy without echoing the value', () => {
      expect(describeAdminResetPasswordInlineError({
        code: 'PASSWORD_POLICY_FAILED',
        details: { reasons: ['no_lowercase', 'no_uppercase'] },
      })).toBe('临时密码不符合要求：要有小写字母；要有大写字母。未重置。')
      expect(describeAdminResetPasswordInlineError({
        code: 'PASSWORD_POLICY_FAILED',
        details: { reasons: ['too_short'] },
      })).toBe('临时密码不符合要求：至少 8 位。未重置。')
      // Nothing mappable still gives a Chinese sentence rather than the English server message.
      expect(describeAdminResetPasswordInlineError({ code: 'PASSWORD_POLICY_FAILED' })).toBe('临时密码不符合密码规则，未重置。')
      expect(describeAdminResetPasswordInlineError({ code: 'PASSWORD_TOO_SHORT' })).toBe(SHORT_COPY)
      expect(describeAdminResetPasswordInlineError({ code: 'USER_ID_REQUIRED' })).toBeNull()
      expect(describeAdminResetPasswordInlineError(null)).toBeNull()
    })

    it('uses the same rule wording as the create-user password hint', () => {
      const createHint = getCreateUserRuleHints('zh').password
      expect(RULE_COPY.replace(/^临时密码：/, '')).toBe(createHint.replace(/^初始密码：/, ''))
    })

    it('shows the length rule beside the input and blocks a trimmed short value before POST', async () => {
      await mountAdmin()
      const input = passwordInput()
      const rule = ruleEl()
      expect(rule?.textContent?.trim()).toBe(RULE_COPY)
      // Same rule sentence as create-user: length, all three character classes, common fragments.
      expect(rule?.textContent).toContain('8–128 位')
      expect(rule?.textContent).toContain('大写字母、小写字母和数字')
      expect(rule?.textContent).toContain('不能包含 123456、password')
      expect(rule?.textContent).not.toMatch(/至少 8 位。/)
      expect(input.compareDocumentPosition(rule!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(sessionHint()?.textContent).toContain('现有会话失效')
      expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')

      await typeManual(marks(1))
      await clickReset()
      expect(resets).toEqual([])
      expect(errorEl()?.textContent?.trim()).toBe(SHORT_COPY)
      expect(errorEl()?.classList.contains('user-admin__status--error')).toBe(true)
      expect(passwordInput().getAttribute('aria-invalid')).toBe('true')
      expect(findButtonByText(container!, '重置密码').disabled).toBe(false)
      expect(findButtonByText(container!, '停用账号').disabled).toBe(false)
      expect(pageBanner()?.textContent || '').not.toContain(SERVER_SHORT_ENGLISH)
      expect(errorEl()?.textContent || '').not.toContain(SERVER_SHORT_ENGLISH)

      await typeManual(`  ${marks(7)}  `)
      await clickReset()
      expect(resets).toEqual([])
      expect(errorEl()?.textContent?.trim()).toBe(SHORT_COPY)
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
    })

    it('shows the server policy reasons in Chinese for an 8-character value with no other character classes, and does not reset', async () => {
      await mountAdmin()
      resetOutcome = 'policy'
      await typeManual(`  ${marks(8)}  `)
      await clickReset()
      await waitForCondition(() => errorEl() !== null)
      expect(resets).toEqual([{ userId: 'user-1', passwordLength: 8 }])
      expect(errorEl()?.textContent?.trim()).toBe(POLICY_COPY)
      expect(errorEl()?.classList.contains('user-admin__status--error')).toBe(true)
      expect(errorEl()?.textContent || '').not.toContain(SERVER_POLICY_ENGLISH)
      expect(errorEl()?.textContent || '').not.toContain('Password')
      expect(pageBanner()?.textContent || '').not.toContain(SERVER_POLICY_ENGLISH)
      expect(pageBanner()?.textContent || '').not.toContain('密码已重置')
      expect(container!.querySelector('[data-testid="admin-reset-temporary-password"]')).toBeNull()
      expect(passwordInput().value.trim()).toHaveLength(8)
      expect(passwordInput().getAttribute('aria-invalid')).toBe('true')
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
    })

    it('posts a trimmed value that meets the policy and shows the issued temporary password', async () => {
      await mountAdmin()
      await typeManual(`  ${COMPLIANT_VALUE}  `)
      await clickReset()
      await waitForCondition(() => resets.length === 1 && pageBanner()?.textContent?.includes('密码已重置') === true)
      expect(resets).toEqual([{ userId: 'user-1', passwordLength: COMPLIANT_VALUE.length }])
      expect(errorEl()).toBeNull()
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
      expect(passwordInput().value).toBe('')
      expect(passwordInput().getAttribute('aria-invalid')).toBe('false')
      expect(pageBanner()?.classList.contains('user-admin__status--error')).toBe(false)
      const issued = container!.querySelector('[data-testid="admin-reset-temporary-password"]')
      expect(issued?.textContent?.trim().startsWith('临时密码：')).toBe(true)
      expect(pageBanner()?.textContent || '').not.toContain(SERVER_SHORT_ENGLISH)
    })

    it('posts a blank or whitespace value with the password field omitted', async () => {
      await mountAdmin()
      await clickReset()
      await waitForCondition(() => resets.length === 1)
      expect(resets[0]).toEqual({ userId: 'user-1', passwordLength: null })

      await typeManual('   ')
      await clickReset()
      await waitForCondition(() => resets.length === 2)
      expect(resets[1]).toEqual({ userId: 'user-1', passwordLength: null })
      expect(errorEl()).toBeNull()
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
      expect(pageBanner()?.textContent).toContain('密码已重置')
    })

    it('still maps an older server PASSWORD_TOO_SHORT to the inline sentence and leaves other reset failures on the page error', async () => {
      await mountAdmin()
      resetOutcome = 'short'
      await typeManual(marks(8))
      await clickReset()
      await waitForCondition(() => errorEl() !== null)
      expect(resets).toEqual([{ userId: 'user-1', passwordLength: 8 }])
      expect(errorEl()?.textContent?.trim()).toBe(SHORT_COPY)
      expect(errorEl()?.textContent || '').not.toContain(SERVER_SHORT_ENGLISH)
      expect(pageBanner()?.textContent || '').not.toContain(SERVER_SHORT_ENGLISH)
      expect(pageBanner()?.textContent || '').not.toContain(SHORT_COPY)
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
      expect(passwordInput().value).toHaveLength(8)

      resetOutcome = 'other-400'
      await clickReset()
      await waitForCondition(() => pageBanner()?.textContent?.includes('userId is required') === true)
      expect(errorEl()).toBeNull()
      expect(pageBanner()?.classList.contains('user-admin__status--error')).toBe(true)
      expect(pageBanner()?.textContent).not.toContain(SHORT_COPY)
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)

      resetOutcome = 'failed'
      await clickReset()
      await waitForCondition(() => pageBanner()?.textContent?.includes('Failed to reset password') === true)
      expect(resets).toHaveLength(3)
      expect(errorEl()).toBeNull()
      expect(pageBanner()?.classList.contains('user-admin__status--error')).toBe(true)
      expect(pageBanner()?.textContent).not.toContain('密码已重置')
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
    })

    it('clears the inline error on success and keeps the rule', async () => {
      await mountAdmin()
      resetOutcome = 'policy'
      await typeManual(marks(8))
      await clickReset()
      await waitForCondition(() => errorEl()?.textContent?.includes(POLICY_COPY) === true)

      resetOutcome = 'ok'
      await typeManual(COMPLIANT_VALUE)
      await clickReset()
      await waitForCondition(() => pageBanner()?.textContent?.includes('密码已重置') === true)
      expect(errorEl()).toBeNull()
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
      expect(passwordInput().getAttribute('aria-invalid')).toBe('false')
      expect(pageBanner()?.classList.contains('user-admin__status--error')).toBe(false)
    })

    it('does not carry a short-password error onto the next account', async () => {
      await mountAdmin()
      await typeManual(marks(7))
      await clickReset()
      expect(resets).toEqual([])
      expect(errorEl()?.textContent?.trim()).toBe(SHORT_COPY)

      await openNamedUser('Bravo')
      expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
      expect(errorEl()).toBeNull()
      expect(passwordInput().value).toBe('')
      expect(passwordInput().getAttribute('aria-invalid')).toBe('false')
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)

      await clickReset()
      await waitForCondition(() => resets.length === 1)
      expect(resets).toEqual([{ userId: 'user-2', passwordLength: null }])
      expect(pageBanner()?.textContent).toContain('密码已重置')
    })

    it('does not paint a late short-password response onto the account selected afterward', async () => {
      await mountAdmin()
      resetOutcome = 'short'
      let releaseReset = (): void => {}
      resetGate = new Promise<void>((resolve) => {
        releaseReset = resolve
      })
      await typeManual(marks(8))
      findButtonByText(container!, '重置密码').click()
      await waitForCondition(() => resets.length === 1)
      expect(resets[0]).toEqual({ userId: 'user-1', passwordLength: 8 })

      await openNamedUser('Bravo')
      releaseReset()
      await flushUi(8)
      expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
      expect(errorEl()).toBeNull()
      expect(pageBanner()?.textContent || '').not.toContain(SERVER_SHORT_ENGLISH)
      expect(pageBanner()?.textContent || '').not.toContain(SHORT_COPY)
      expect(pageBanner()?.textContent || '').not.toContain('密码已重置')
      expect(resets).toHaveLength(1)
    })

    it('still logs the current account out after a short password was refused', async () => {
      await mountAdmin()
      await typeManual(marks(4))
      await clickReset()
      expect(resets).toEqual([])
      expect(errorEl()?.textContent?.trim()).toBe(SHORT_COPY)

      findButtonByText(container!, '全部下线').click()
      await waitForCondition(() => revokes.length === 1 && pageBanner()?.textContent?.includes('该用户现有会话已失效') === true)
      expect(revokes).toEqual(['user-1'])
      expect(resets).toEqual([])
      expect(pageBanner()?.textContent).not.toContain('密码已重置')
      expect(ruleEl()?.textContent?.trim()).toBe(RULE_COPY)
      expect(sessionHint()?.textContent).toContain('现有会话失效')
    })
  })

  // Customer field report 2026-10-21 (#4): at ~1270px the left card's export buttons were clipped and
  // the bulk-action buttons were drawn over the right panel. jsdom cannot lay out, so this pins the
  // DOM structure the fix relies on plus the CSS contract in the SFC's style block; the real-browser
  // measurement was done against a lab harness (see the PR body).
  it('keeps the left-card buttons in wrapping containers and caps the card track at the card width', async () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1270 })
    onTestFinished(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    })
    // A listed user whose DingTalk identity has a corpId but no openId renders the governance hint (with
    // the whole corpId, one unbreakable token) as a third child of the user row.
    const state = createApiState()
    state[1].hasOpenId = false
    state[1].dingtalkCorpId = 'ding' + '0'.repeat(32)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app = createApp(UserManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi(20)

    const layout = container!.querySelector('.user-admin__layout')
    const aside = layout?.querySelector(':scope > aside.user-admin__panel')
    const detail = layout?.querySelector(':scope > section.user-admin__panel')
    expect(aside).toBeInstanceOf(HTMLElement)
    expect(detail).toBeInstanceOf(HTMLElement)
    const exportButtons = Array.from(aside!.querySelectorAll('.user-admin__section-head--workbench > .user-admin__role-actions > button'))
    expect(exportButtons.map((button) => button.textContent?.trim())).toEqual([
      '导出治理日报摘要',
      '导出联调检查单',
      '导出联调结果模板',
      '导出联调执行包索引',
      '导出完整联调包',
    ])
    const bulkButtons = aside!.querySelectorAll('.user-admin__bulkbar > .user-admin__role-actions > .user-admin__button')
    expect(bulkButtons.length).toBeGreaterThanOrEqual(9)
    const rowHints = Array.from(aside!.querySelectorAll('.user-admin__user > p.user-admin__hint'))
    expect(rowHints).toHaveLength(1)
    expect(rowHints[0].textContent).toContain('ding' + '0'.repeat(32))

    const source = readFileSync(resolve(process.cwd(), 'src/views/UserManagementView.vue'), 'utf8').replace(/\r\n/g, '\n')
    const style = source.slice(source.indexOf('<style scoped>'))
    const rule = (selector: string) => {
      const start = style.indexOf(`\n${selector} {`)
      expect(start, selector).toBeGreaterThan(-1)
      return style.slice(start, style.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
    }
    expect(rule('.user-admin__layout')).toContain('grid-template-columns: minmax(0, 320px) minmax(0, 1fr);')
    expect(rule('.user-admin__layout > *')).toContain('min-width: 0;')
    expect(rule('.user-admin__panel')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.user-admin__panel')).toContain('min-width: 0;')
    expect(rule('.user-admin__section-head--workbench')).toContain('flex-wrap: wrap;')
    expect(rule('.user-admin__role-actions > .user-admin__button')).toContain('max-width: 100%;')
    expect(rule('.user-admin__role-actions > .user-admin__button')).toContain('white-space: normal;')
    expect(rule('.user-admin__user')).toContain('box-sizing: border-box;')
    expect(rule('.user-admin__user')).toContain('flex-wrap: wrap;')
    expect(rule('.user-admin__user > .user-admin__hint')).toContain('flex-basis: 100%;')
    expect(rule('.user-admin__user > .user-admin__hint')).toContain('min-width: 0;')
    expect(rule('.user-admin__user > .user-admin__hint')).toContain('overflow-wrap: anywhere;')
    expect(style).toMatch(/\.user-admin__user-body > span,\n\.user-admin__detail-head h2,\n\.user-admin__detail-head p \{\n  overflow-wrap: anywhere;/)
    // The shared flex-wrap rule for every action row is still in place.
    expect(style).toMatch(/\.user-admin__role-actions,\n\.user-admin__role-list \{\n  display: flex;\n  flex-wrap: wrap;/)
  })
})
