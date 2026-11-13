/* eslint-disable vue/one-component-per-file -- Tests mount isolated apps with local component stubs. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'
import { useLocale } from '../src/composables/useLocale'
import { describeCreateUserError } from '../src/utils/createUserValidationCopy'

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

function oneShotJsonResponse(payload: unknown, status = 200) {
  let used = false
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (used) throw new Error('body already read')
      used = true
      return payload
    },
  }
}

function realJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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

async function openListedUser(container: HTMLElement, name: string): Promise<void> {
  const button = findUserRow(container, name).querySelector('button.user-admin__user-body')
  if (!(button instanceof HTMLButtonElement)) throw new Error(`User button missing: ${name}`)
  button.click()
  await waitForCondition(() => container.querySelector('[data-testid="selected-user-heading"]')?.textContent?.includes(name) ?? false)
}

async function confirmAdminAuthorization(container: HTMLElement, phrase?: string): Promise<void> {
  await waitForCondition(() => Boolean(container.querySelector('[data-testid="admin-authorization-confirm"]')))
  if (phrase) {
    const input = container.querySelector('[data-testid="admin-authorization-phrase"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('authorization phrase input missing')
    input.value = phrase
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
  }
  const confirm = container.querySelector('[data-testid="admin-authorization-confirm"]')
  if (!(confirm instanceof HTMLButtonElement)) throw new Error('authorization confirm missing')
  if (confirm.disabled) throw new Error('authorization confirm is disabled')
  confirm.click()
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
    props: { to: { type: [String, Object], default: '' } },
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
  roleIds?: string[]
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
      roleIds: user.roleIds ?? [],
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
        capabilities: { explicitNamespaceAdmission: true },
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
      const role = url.searchParams.get('role')?.trim() || ''
      const accountStatus = url.searchParams.get('accountStatus')?.trim() || ''
      const listFilter = url.searchParams.get('listFilter')?.trim() || ''
      const sort = url.searchParams.get('sort')?.trim() || ''
      const direction = url.searchParams.get('dir') === 'desc' ? -1 : 1
      const requestedPage = Math.max(1, Number(url.searchParams.get('page') || '1') || 1)
      const requestedPageSize = Number(url.searchParams.get('pageSize') || '')
      const openIdMissing = (user: UserFixture) => (
        user.dingtalkIdentityExists !== false
        && Boolean(user.dingtalkCorpId ?? 'dingcorp')
        && !user.hasOpenId
      )
      let listed = filteredUsers.filter((user) => {
        if (role && user.role !== role) return false
        if (accountStatus === 'active' && !user.is_active) return false
        if (accountStatus === 'inactive' && user.is_active) return false
        if (listFilter === 'account-disabled' && user.is_active) return false
        if (listFilter === 'dingtalk-disabled' && user.grantEnabled !== false) return false
        if (listFilter === 'directory-unlinked' && user.directoryLinked === true) return false
        if (listFilter === 'dingtalk-openid-missing' && !openIdMissing(user)) return false
        if (listFilter === 'platform-admin' && user.role !== 'admin') return false
        return true
      })
      if (sort === 'name' || sort === 'role' || sort === 'status') {
        const valueOf = (user: UserFixture) => {
          if (sort === 'name') return user.name
          if (sort === 'role') return user.role
          return user.is_active ? '0' : '1'
        }
        listed = [...listed].sort((left, right) => valueOf(left).localeCompare(valueOf(right), 'zh') * direction)
      }
      const pageSize = typeof options.paginatedPageSize === 'number'
        ? Math.max(options.paginatedPageSize, 0)
        : (Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : listed.length)
      const start = (requestedPage - 1) * pageSize
      const visible = listed.slice(start, start + pageSize)
      const items = visible.map((user) => buildUserPayload(user))
      if (pinUserId && !items.some((item) => item.id === pinUserId)) {
        const pinned = state.find((user) => user.id === pinUserId)
        if (pinned) {
          items.unshift(buildUserPayload(pinned))
          if (items.length > pageSize) items.length = pageSize
        }
      }
      const roleOptions = [...new Set(filteredUsers.map((user) => user.role).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, 'zh'))
      return createJsonResponse({
        ok: true,
        data: {
          items,
          page: requestedPage,
          pageSize,
          total: listed.length,
          roleOptions,
          pinUserId,
          pinUserIncluded: pinUserId ? items.some((item) => item.id === pinUserId) : null,
        },
      })
    }

    if (pathname === '/api/admin/users/batch/disable') {
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as { userIds?: unknown[] } : {}
      const count = Array.isArray(parsed.userIds) ? parsed.userIds.length : 0
      return createJsonResponse({
        ok: true,
        data: { successCount: count, failureCount: 0, results: [] },
      })
    }

    if (pathname === '/api/admin/users/batch/create' || pathname === '/api/admin/users/batch/update') {
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as { items?: unknown[]; dryRun?: boolean } : {}
      const count = Array.isArray(parsed.items) ? parsed.items.length : 0
      return oneShotJsonResponse({
        ok: true,
        data: {
          successCount: count,
          failureCount: 0,
          dryRun: parsed.dryRun === true,
          results: Array.from({ length: count }, (_item, index) => ({ index, ok: true, code: null, message: 'ok' })),
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
    if (namespaceAdmissionMatch && (init?.method || 'GET').toUpperCase() === 'PATCH') {
      const user = findUserById(decodeURIComponent(namespaceAdmissionMatch[1]))
      const namespace = decodeURIComponent(namespaceAdmissionMatch[2])
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const parsed = rawBody ? JSON.parse(rawBody) as { enabled?: unknown } : {}
      const enabled = parsed.enabled === true
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
      return createJsonResponse({
        ok: true,
        data: {
          namespaceAdmissions: user.namespaceAdmissions.map((item) => ({ ...item })),
        },
      })
    }

    if (pathname === '/api/admin/users/recycle' && (init?.method || 'GET').toUpperCase() !== 'POST') {
      return createJsonResponse({
        ok: true,
        data: {
          total: 1,
          retentionDays: 30,
          items: [{
            id: 'user-gone',
            email: 'gone@example.com',
            name: '已删除同事',
            department: '装配',
            deletedAt: '2026-10-01T00:00:00.000Z',
            deletedBy: 'admin-1',
            purgeAfter: '2026-10-31T00:00:00.000Z',
          }],
        },
      })
    }

    if (pathname === '/api/admin/users/recycle/restore') {
      return createJsonResponse({
        ok: true,
        data: { successCount: 1, failureCount: 0, results: [{ ok: true, userId: 'user-gone', message: '已恢复' }] },
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
    useLocale().setLocale('en')
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
      props: { to: { type: [String, Object], default: '' } },
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi(20)
    await openListedUser(container!, 'Alpha')

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
    await confirmAdminAuthorization(container!)
    await waitForCondition(() => container?.textContent?.includes('已开通 crm 插件使用') ?? false)

    expect(container?.textContent).toContain('已开通 crm 插件使用')
    expect(container?.textContent).toContain('当前实际可用')
  })

  it('can select filtered users and batch update DingTalk grants', async () => {
    app = createApp(UserManagementView)
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
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
    await waitForCondition(() => callLog.some((url) => {
      if (!url.startsWith('/api/admin/users?')) return false
      const params = new URL(url, 'http://localhost').searchParams
      return params.get('q') === '' && params.get('page') === '1'
    }))

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

  it('keeps unrelated query fields and the hash when a member filter changes', async () => {
    window.history.replaceState({}, '', '/admin/users?userId=user-2&source=directory-sync&integrationId=ding-1&accountId=user-2-directory&directoryFailure=missing_account&handoff=keep#member-detail')
    const state = createApiState()
    state[1].hasOpenId = false
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app.mount(container!)
    await flushUi(20)

    findButtonByText(container!, '缺 OpenID').click()
    await flushUi()

    const url = new URL(window.location.href)
    expect(url.searchParams.get('userId')).toBe('user-2')
    expect(url.searchParams.get('source')).toBe('directory-sync')
    expect(url.searchParams.get('integrationId')).toBe('ding-1')
    expect(url.searchParams.get('accountId')).toBe('user-2-directory')
    expect(url.searchParams.get('directoryFailure')).toBe('missing_account')
    expect(url.searchParams.get('filter')).toBe('dingtalk-openid-missing')
    expect(url.searchParams.get('handoff')).toBe('keep')
    expect(url.hash).toBe('#member-detail')
    expect(container?.textContent).toContain('目录定位未完成')
  })

  it('links the selected member to permission sources and management scope', async () => {
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)
    await openListedUser(container!, 'Alpha')

    const permissionLink = container!.querySelector('[data-testid="member-permission-source-link"]')
    const scopeLink = container!.querySelector('[data-testid="management-scope-link"]')
    expect(permissionLink?.getAttribute('href')).toBe('/admin/permissions?userId=user-1')
    expect(scopeLink?.getAttribute('href')).toBe('/admin/role-delegation?userId=user-1')
    expect(container?.textContent).toContain('不是最终业务访问结论')
    expect(container?.textContent).toContain('每条部门范围单独设置是否包含下级部门')
    expect(container?.textContent).not.toContain('部门范围包含该部门及其下级')
    expect(container?.textContent).toContain('共享成员组')
    expect(container?.textContent).toContain('取并集')
    expect(container?.textContent).toContain('委派管理员只能给允许的成员分配允许的角色')
    expect(container?.textContent).toContain('平台管理员配置管理范围')
    expect(container?.textContent).not.toContain('必须开通插件')
    expect(container?.textContent).toContain('管理委派不要求先开通插件使用')
    expect(container?.textContent).not.toContain('私有圈定')
    expect(container?.textContent).not.toContain('不新增范围类型')
    expect(container?.textContent).not.toContain('中文名只用于阅读')
    expect(container?.textContent).not.toContain('保存仍使用角色 ID')

    const bravo = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('Bravo'))
    bravo?.click()
    await waitForCondition(() => container!.querySelector('[data-testid="member-permission-source-link"]')?.getAttribute('href') === '/admin/permissions?userId=user-2')
    expect(container!.querySelector('[data-testid="member-permission-source-link"]')?.getAttribute('href')).toBe('/admin/permissions?userId=user-2')
    expect(container!.querySelector('[data-testid="management-scope-link"]')?.getAttribute('href')).toBe('/admin/role-delegation?userId=user-2')
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
      props: { to: { type: [String, Object], default: '' } },
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
    await waitForCondition(() => container!.querySelector('[data-testid="bulk-admission-target"]') !== null)
    expect(apiFetchMock.mock.calls.some((args) => String(args[0]).includes('/admission/bulk'))).toBe(false)
    const frozenTarget = container!.querySelector('[data-testid="bulk-admission-target"]')?.textContent || ''
    expect(frozenTarget).toContain('Bravo')
    expect(frozenTarget).toContain('user-2')
    expect(container!.textContent).toContain('将开通插件使用「finance」。不改变这些用户的角色，也不写入直接权限。')
    const confirm = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (!(confirm instanceof HTMLButtonElement)) throw new Error('bulk admission confirm missing')
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/namespaces/finance/admission/bulk'))

    const bulkCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/namespaces/finance/admission/bulk')
    if (!bulkCall) throw new Error('Bulk namespace request not found')
    expect(JSON.parse(String((bulkCall[1] as RequestInit | undefined)?.body))).toEqual({
      userIds: ['user-2'],
      enabled: true,
    })
    await waitForCondition(() => callLog.filter((url) => url.includes('/api/admin/users/user-2/member-admission')).length > admissionBefore)
    await waitForCondition(() => container?.textContent?.includes('已批量开通 finance 插件使用') === true)
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

    await waitForCondition(() => !findButtonByText(container!, '创建用户').disabled)
    findButtonByText(container!, '创建用户').click()
    await confirmAdminAuthorization(container!)
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
      admissionNamespaces: [],
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
      await waitForCondition(() => !findButtonByText(container!, '创建用户').disabled)
      findButtonByText(container!, '创建用户').click()
      await confirmAdminAuthorization(container!)
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
      await waitForCondition(() => !findButtonByText(container!, '创建用户').disabled)
      findButtonByText(container!, '创建用户').click()
      await confirmAdminAuthorization(container!)
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
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/users?') && url.includes('q=Alpha')))
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
      await openListedUser(container!, 'Alpha')
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
      await openListedUser(container!, 'Alpha')
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
      await openListedUser(container!, 'Alpha')
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
      await openListedUser(container!, 'Alpha')
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
      await confirmAdminAuthorization(container!)
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
    const RULE_COPY = '至少 8 位。留空则自动生成临时密码。'
    const SHORT_COPY = '临时密码不足 8 位，未重置。'
    const SERVER_SHORT_ENGLISH = 'Password must be at least 8 characters long'

    type ResetOutcome = 'ok' | 'short' | 'other-400' | 'failed'
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
      await waitForCondition(() => container!.querySelector('.user-admin__user') !== null)
      await openListedUser(container!, 'Alpha')
      await waitForCondition(() => ruleEl() !== null)
    }

    it('shows the length rule beside the input and blocks a trimmed short value before POST', async () => {
      await mountAdmin()
      const input = passwordInput()
      const rule = ruleEl()
      expect(rule?.textContent?.trim()).toBe(RULE_COPY)
      expect(rule?.textContent).not.toMatch(/大写|小写|弱口令/)
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

    it('posts a trimmed 8-character value that has no other character classes', async () => {
      await mountAdmin()
      await typeManual(`  ${marks(8)}  `)
      await clickReset()
      await waitForCondition(() => resets.length === 1 && pageBanner()?.textContent?.includes('密码已重置') === true)
      expect(resets).toEqual([{ userId: 'user-1', passwordLength: 8 }])
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

    it('maps server PASSWORD_TOO_SHORT to the inline sentence and leaves other reset failures on the page error', async () => {
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
      resetOutcome = 'short'
      await typeManual(marks(8))
      await clickReset()
      await waitForCondition(() => errorEl()?.textContent?.includes(SHORT_COPY) === true)

      resetOutcome = 'ok'
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

  // Customer field report 2026-10-21 (#4), kept after the member-table redesign: long unbreakable
  // identifiers must not widen the page. The list is one minmax(0, 1fr) track and the editor is a
  // fixed drawer, so it cannot be drawn over the table. jsdom cannot lay out; this pins the DOM
  // structure and the CSS contract in the SFC.
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
      props: { to: { type: [String, Object], default: '' } },
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
    expect(rule('.user-admin__layout')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.user-admin__panel--detail')).toContain('position: fixed;')
    expect(rule('.user-admin__panel--detail')).toContain('width: min(640px, 100%);')
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
    expect(style).toMatch(/\.user-admin__user-body > span,\n\.user-admin__detail-head h2,\n\.user-admin__detail-head p \{\n {2}overflow-wrap: anywhere;/)
    // The shared flex-wrap rule for every action row is still in place.
    expect(style).toMatch(/\.user-admin__role-actions,\n\.user-admin__role-list \{\n {2}display: flex;\n {2}flex-wrap: wrap;/)
  })

  it('keeps invite and editing off the member table until the admin opens them', async () => {
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    const modal = container!.querySelector('.user-admin__modal')
    const detail = container!.querySelector('.user-admin__panel--detail')
    expect(modal?.classList.contains('user-admin__modal--open')).toBe(false)
    expect(detail?.classList.contains('user-admin__panel--detail-open')).toBe(false)
    expect(container!.querySelector('.user-admin__panel--create input[aria-label="登录名（可选）"]')).toBeTruthy()
    expect(container!.querySelectorAll('.user-admin__user').length).toBeGreaterThan(0)

    findButtonByText(container!, '邀请用户').click()
    await flushUi()
    expect(container!.querySelector('.user-admin__modal')?.classList.contains('user-admin__modal--open')).toBe(true)
    expect(container!.querySelector('.user-admin__panel--create')?.textContent).toContain('一次邀请一名成员')

    findButtonByText(container!, '待处理邀请').click()
    await flushUi()
    expect(container!.querySelector('[data-testid="pending-invites-tab"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container!.textContent).toContain('邀请记录')

    const alphaRow = findUserRow(container!, 'Alpha')
    const alphaButton = Array.from(alphaRow.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Alpha'))
    if (!(alphaButton instanceof HTMLButtonElement)) throw new Error('Alpha row button not found')
    alphaButton.click()
    await flushUi()
    expect(container!.querySelector('.user-admin__panel--detail')?.classList.contains('user-admin__panel--detail-open')).toBe(true)
    expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
  })

  it('filters the member table by role and status and sorts by name without dropping rows', async () => {
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container!)
    await flushUi(20)

    const roleSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="角色筛选"]')
    const statusSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="账号状态"]')
    if (!roleSelect || !statusSelect) throw new Error('Role or status filter not found')

    await setSelectValue(roleSelect, 'admin')
    const adminRows = Array.from(container!.querySelectorAll('.user-admin__user')).map((row) => row.textContent || '')
    expect(adminRows).toHaveLength(1)
    expect(adminRows[0]).toContain('Delta')

    await setSelectValue(roleSelect, '')
    await setSelectValue(statusSelect, 'inactive')
    const inactiveRows = Array.from(container!.querySelectorAll('.user-admin__user')).map((row) => row.textContent || '')
    expect(inactiveRows).toHaveLength(1)
    expect(inactiveRows[0]).toContain('Charlie')

    await setSelectValue(statusSelect, '')
    const nameSort = container!.querySelector<HTMLButtonElement>('.user-admin__table-head button')
    if (!nameSort) throw new Error('Name sort button not found')
    nameSort.click()
    nameSort.click()
    await flushUi()
    const names = Array.from(container!.querySelectorAll('.user-admin__user strong')).map((node) => node.textContent?.trim())
    expect(names).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha'])
  })

  it('shows the recycle bin and restores a deleted account', async () => {
    useLocale().setLocale('zh-CN')
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(12)

    findButtonByText(container!, '回收站').click()
    await waitForCondition(() => container!.textContent?.includes('已删除同事') === true)
    expect(container!.textContent).toContain('不能登录')
    expect(container!.textContent).toContain('30')

    const row = findUserRow(container!, '已删除同事')
    findButtonByText(row, '恢复').click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/recycle/restore'))
    const restoreCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/recycle/restore')
    expect(JSON.parse(String((restoreCall?.[1] as RequestInit | undefined)?.body))).toEqual({ userIds: ['user-gone'] })
    useLocale().setLocale('en')
  })

  it.each(['restore', 'purge'] as const)('reloads the previous recycle page after the last %s on the last page', async (action) => {
    useLocale().setLocale('zh-CN')
    let finished = false
    const kept = {
      id: 'user-keep',
      email: 'keep@example.com',
      name: '仍在回收站',
      department: '装配',
      deletedAt: '2026-10-01T00:00:00.000Z',
      deletedBy: 'admin-1',
      purgeAfter: '2026-10-31T00:00:00.000Z',
    }
    const last = {
      id: 'user-last',
      email: 'last@example.com',
      name: '最后一条',
      department: '装配',
      deletedAt: '2026-10-02T00:00:00.000Z',
      deletedBy: 'admin-1',
      purgeAfter: '2026-11-01T00:00:00.000Z',
    }
    const base = apiFetchMock.getMockImplementation()
    apiFetchMock.mockImplementation(async (rawUrl: unknown, init?: RequestInit) => {
      const url = String(rawUrl)
      const path = url.split('?')[0]
      if (path === '/api/admin/users/recycle') {
        const page = new URL(url, 'http://localhost').searchParams.get('page') || '1'
        if (!finished && page === '2') {
          return createJsonResponse({ ok: true, data: { total: 21, retentionDays: 30, items: [last] } })
        }
        if (finished && page === '2') {
          return createJsonResponse({ ok: true, data: { total: 20, retentionDays: 30, items: [] } })
        }
        return createJsonResponse({ ok: true, data: { total: finished ? 20 : 21, retentionDays: 30, items: [kept] } })
      }
      if (path === '/api/admin/users/recycle/restore' || path === '/api/admin/users/recycle/purge') {
        finished = true
        return createJsonResponse({ ok: true, data: { successCount: 1, failureCount: 0, results: [{ ok: true, message: 'ok' }] } })
      }
      if (!base) throw new Error(`Unhandled apiFetch call: ${url}`)
      return base(rawUrl, init)
    })

    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(12)
    findButtonByText(container!, '回收站').click()
    await waitForCondition(() => container!.textContent?.includes('仍在回收站') === true)
    findButtonByText(container!, '下一页').click()
    await waitForCondition(() => container!.textContent?.includes('最后一条') === true)
    if (action === 'restore') {
      findButtonByText(findUserRow(container!, '最后一条'), '恢复').click()
    } else {
      const row = findUserRow(container!, '最后一条')
      const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')
      if (!checkbox) throw new Error('recycle checkbox missing')
      checkbox.click()
      const phrase = container!.querySelector<HTMLInputElement>('[data-testid="recycle-purge-phrase"]')
      if (!phrase) throw new Error('purge phrase missing')
      phrase.value = '立即清除'
      phrase.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
      const purge = findButtonByText(container!, '立即清除所选')
      if (purge.disabled) throw new Error('purge button stayed disabled')
      purge.click()
    }
    await waitForCondition(() => container!.textContent?.includes('仍在回收站') === true && container!.textContent?.includes('回收站是空的') !== true)
    expect(container!.textContent).not.toContain('最后一条')
    expect(container!.querySelector('[data-testid="recycle-pager"]')).toBeNull()
    const pages = apiFetchMock.mock.calls
      .map((args) => String(args[0]))
      .filter((url) => url.split('?')[0] === '/api/admin/users/recycle')
      .map((url) => new URL(url, 'http://localhost').searchParams.get('page'))
    expect(pages).toEqual(['1', '2', '2', '1'])
  })

  it('pages, filters, and bulk-selects every user when the server has 110', async () => {
    const state: UserFixture[] = Array.from({ length: 110 }, (_, index) => {
      const number = index + 1
      return {
        id: `user-${number}`,
        email: `user${number}@example.com`,
        username: `user${number}`,
        name: `Member ${String(number).padStart(3, '0')}`,
        mobile: null,
        role: number % 10 === 0 ? 'auditor' : 'user',
        is_active: true,
        grantEnabled: true,
        directoryLinked: false,
        hasOpenId: true,
        hasUnionId: true,
        namespaceAdmissions: [],
      }
    })
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    expect(container!.textContent).toContain('第 1 / 6 页 · 共 110 人')
    expect(container!.querySelectorAll('.user-admin__user')).toHaveLength(20)
    const firstRequest = callLog.find((url) => url.startsWith('/api/admin/users?'))
    const firstParams = new URL(firstRequest || 'http://localhost/missing', 'http://localhost').searchParams
    expect(firstParams.get('page')).toBe('1')
    expect(firstParams.get('pageSize')).toBe('20')
    expect(Number(firstParams.get('pageSize'))).toBeLessThanOrEqual(100)

    const seen = new Set<string>()
    for (let pageNumber = 1; pageNumber <= 6; pageNumber += 1) {
      for (const name of container!.querySelectorAll('.user-admin__user strong')) {
        seen.add(name.textContent?.trim() || '')
      }
      if (pageNumber === 6) break
      const nextFirst = `Member ${String(pageNumber * 20 + 1).padStart(3, '0')}`
      findButtonByText(container!, '下一页').click()
      await waitForCondition(() => container!.textContent?.includes(nextFirst) === true)
    }
    expect(seen.size).toBe(110)
    expect(seen.has('Member 001')).toBe(true)
    expect(seen.has('Member 110')).toBe(true)

    const roleSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="角色筛选"]')
    if (!roleSelect) throw new Error('Role filter not found')
    await setSelectValue(roleSelect, 'auditor')
    await waitForCondition(() => container!.querySelectorAll('.user-admin__user').length === 11)
    const auditorNames = Array.from(container!.querySelectorAll('.user-admin__user strong')).map((node) => node.textContent?.trim())
    expect(auditorNames).toHaveLength(11)
    expect(auditorNames).toContain('Member 010')
    expect(auditorNames).toContain('Member 110')

    findButtonByText(container!, '选择当前筛选结果').click()
    await waitForCondition(() => container!.textContent?.includes('已选择 11 / 11 个当前筛选结果') === true)
    findButtonByText(container!, '批量停用').click()
    await flushUi()
    const confirm = container!.querySelector<HTMLButtonElement>('[data-testid="bulk-confirm-submit"]')
    if (!confirm) throw new Error('Bulk confirm button not found')
    confirm.click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/batch/disable'))
    const disableCall = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/batch/disable')
    const disabledIds = JSON.parse(String((disableCall?.[1] as RequestInit | undefined)?.body)).userIds as string[]
    expect(disabledIds).toHaveLength(11)
    expect(disabledIds).toEqual(Array.from({ length: 11 }, (_, index) => `user-${(index + 1) * 10}`))
  })

  it('drops the previous selection when the search changes so bulk deactivate cannot submit it', async () => {
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    await setSearchValue(container!, 'Alpha')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((url) => url.includes('q=Alpha')))
    findButtonByText(container!, '选择当前筛选结果').click()
    await flushUi()
    expect(container!.textContent).toContain('已选择 1 / 1 个当前筛选结果')
    findButtonByText(container!, '批量停用').click()
    await flushUi()
    expect(container!.querySelector('[data-testid="bulk-confirm"]')).toBeTruthy()

    await setSearchValue(container!, 'bravo')
    expect(container!.querySelector('[data-testid="bulk-confirm"]')).toBeNull()
    expect(container!.textContent).toContain('已选择 0 /')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((url) => url.includes('q=bravo')))
    await waitForCondition(() => container!.textContent?.includes('已选择 0 / 1 个当前筛选结果') === true)
    expect(findUserRow(container!, 'Bravo')).toBeTruthy()

    findButtonByText(container!, '选择当前筛选结果').click()
    await flushUi()
    expect(container!.textContent).toContain('已选择 1 / 1 个当前筛选结果')
    findButtonByText(container!, '批量停用').click()
    await flushUi()
    const confirm = container!.querySelector<HTMLButtonElement>('[data-testid="bulk-confirm-submit"]')
    if (!confirm) throw new Error('Bulk confirm button not found')
    confirm.click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/batch/disable'))
    const disableCalls = apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/batch/disable')
    const submitted = disableCalls.map((args) => JSON.parse(String((args[1] as RequestInit | undefined)?.body)).userIds as string[])
    expect(submitted.some((ids) => ids.includes('user-1'))).toBe(false)
    expect(submitted.at(-1)).toEqual(['user-2'])
  })

  it('does not apply a stale select-all after the search changes', async () => {
    const state: UserFixture[] = [
      ...Array.from({ length: 25 }, (_, index) => {
        const number = index + 1
        return {
          id: `alpha-${number}`,
          email: `alpha${number}@example.com`,
          username: `alpha${number}`,
          name: `Alpha ${String(number).padStart(2, '0')}`,
          mobile: null,
          role: 'user',
          is_active: true,
          grantEnabled: true,
          directoryLinked: false,
          hasOpenId: true,
          hasUnionId: true,
          namespaceAdmissions: [],
        }
      }),
      {
        id: 'bravo-1',
        email: 'bravo-only@example.com',
        username: 'bravo-only',
        name: 'Bravo',
        mobile: null,
        role: 'user',
        is_active: true,
        grantEnabled: true,
        directoryLinked: false,
        hasOpenId: true,
        hasUnionId: true,
        namespaceAdmissions: [],
      },
    ]
    const base = createApiImplementation(callLog, state)
    let releaseSelectAll: (() => void) | null = null
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('pageSize=100') && url.includes('q=Alpha') && !releaseSelectAll) {
        await new Promise<void>((resolve) => {
          releaseSelectAll = resolve
        })
      }
      return base(input, init)
    })
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    await setSearchValue(container!, 'Alpha')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => container!.textContent?.includes('共 25 人') === true)
    findButtonByText(container!, '选择当前筛选结果').click()
    await waitForCondition(() => releaseSelectAll !== null)

    await setSearchValue(container!, 'Bravo')
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => container!.textContent?.includes('已选择 0 / 1 个当前筛选结果') === true)
    releaseSelectAll?.()
    await flushUi(12)
    expect(container!.textContent).toContain('已选择 0 / 1 个当前筛选结果')
    expect(apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/batch/disable')).toBe(false)
  })

  async function uploadCsv(testId: string, csv: string, fileName: string): Promise<void> {
    const input = container!.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)
    if (!input) throw new Error(`File input not found: ${testId}`)
    const file = new File([csv], fileName, { type: 'text/csv' })
    if (typeof file.text !== 'function') {
      Object.defineProperty(file, 'text', { value: async () => csv })
    }
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(12)
  }

  function createImportCsv(count: number): string {
    const lines = ['name,email,roleId,department']
    for (let index = 1; index <= count; index += 1) {
      lines.push(`用户${String(index).padStart(3, '0')},batch${index}@example.com,crm_admin,装配`)
    }
    return lines.join('\n')
  }

  function updateImportCsv(count: number): string {
    const lines = ['userId,email,name,roleId,department,isActive,roleIds']
    for (let index = 1; index <= count; index += 1) {
      lines.push(`import-${index},batch${index}@example.com,用户${String(index).padStart(3, '0')},,装配,true,`)
    }
    return lines.join('\n')
  }

  it.each([100, 101, 105])('create import of %i rows rejects the file before any write when it is over 100', async (count) => {
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)
    const before = apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/batch/create').length
    await uploadCsv('batch-import-file', createImportCsv(count), 'create.csv')
    if (count <= 100) {
      expect(container!.textContent).toContain('可导入 100 行')
      findButtonByText(container!, '确认导入').click()
      await waitForCondition(() => Boolean(container!.querySelector('[data-testid="batch-create-confirm"]')))
      expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/batch/create').length).toBe(before)
      const confirm = container!.querySelector('[data-testid="batch-create-confirm"]')
      if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) throw new Error('batch create confirm is not ready')
      confirm.click()
      await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/batch/create'))
      const call = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/batch/create')
      const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as { items?: Array<Record<string, unknown>> }
      expect(body.items).toHaveLength(100)
      expect(body.items?.[0]).toEqual({
        name: '用户001',
        email: 'batch1@example.com',
        roleId: 'crm_admin',
        department: '装配',
      })
      expect(Object.prototype.hasOwnProperty.call(body, 'admissionNamespaces')).toBe(false)
      expect(body.items?.some((item) => Object.prototype.hasOwnProperty.call(item, 'admissionNamespaces'))).toBe(false)
    } else {
      expect(container!.textContent).toContain(`共 ${count} 行，超出 ${count - 100} 行`)
      expect(container!.textContent).toContain('未写入任何数据')
      expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/batch/create').length).toBe(before)
      expect(container!.textContent).not.toContain('可导入 100 行')
    }
  })

  it.each([100, 101, 105])('update import of %i rows rejects the file before any write when it is over 100', async (count) => {
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)
    findButtonByText(container!, '导入更新').click()
    await flushUi()
    const before = apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/batch/update').length
    await uploadCsv('reimport-file', updateImportCsv(count), 'update.csv')
    if (count <= 100) {
      findButtonByText(container!, '预览差异').click()
      await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/batch/update'))
      const call = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/batch/update')
      const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as { items: unknown[]; dryRun?: boolean }
      expect(body.items).toHaveLength(100)
      expect(body.dryRun).toBe(true)
    } else {
      expect(container!.textContent).toContain(`共 ${count} 行，超出 ${count - 100} 行`)
      expect(container!.textContent).toContain('未写入任何数据')
      expect(apiFetchMock.mock.calls.filter((args) => String(args[0]) === '/api/admin/users/batch/update').length).toBe(before)
    }
  })

  it('round-trips an editable export without writing the legacy profile role or dropping multiple roles', async () => {
    const state = createApiState()
    const alpha = state.find((user) => user.id === 'user-1')
    const bravo = state.find((user) => user.id === 'user-2')
    if (!alpha || !bravo) throw new Error('fixture missing')
    alpha.role = 'user'
    alpha.roleIds = ['crm_admin']
    bravo.role = 'user'
    bravo.roleIds = ['finance_admin', 'crm_admin']
    apiFetchMock.mockImplementation(createApiImplementation(callLog, state))
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)

    findButtonByText(container!, '导出以便修改').click()
    await waitForCondition(() => createdBlobParts.some((part) => part.includes('roleIds')))
    const csv = createdBlobParts.join('')
    const { parseCsv, previewUpdateRows } = await import('../src/views/adminUserBatch')
    const parsed = parseCsv(csv)
    const exportedAlpha = parsed.find((row) => row.userId === 'user-1')
    const exportedBravo = parsed.find((row) => row.userId === 'user-2')
    expect(exportedAlpha?.roleId).toBe('')
    expect(exportedAlpha?.roleIds).toBe('crm_admin')
    expect(exportedBravo?.roleId).toBe('')
    expect(exportedBravo?.roleIds).toBe('crm_admin;finance_admin')
    expect(parsed.some((row) => row.roleId === 'user')).toBe(false)
    const preview = previewUpdateRows(parsed, state.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      roleIds: user.roleIds,
      department: user.department,
      is_active: user.is_active,
    })), new Set(['crm_admin', 'finance_admin']))
    expect(preview.filter((row) => row.userId === 'user-1' || row.userId === 'user-2').every((row) => row.ok)).toBe(true)
    expect(preview.filter((row) => row.userId === 'user-1' || row.userId === 'user-2').every((row) => row.changes.every((change) => change.field !== '角色'))).toBe(true)

    const unknown = previewUpdateRows(
      [{ userId: 'user-1', email: alpha.email || '', roleId: 'not-a-real-role', department: alpha.department || '' }],
      [{ id: 'user-1', email: alpha.email, name: alpha.name, role: 'user', roleIds: ['crm_admin'], department: alpha.department, is_active: true }],
      new Set(['crm_admin', 'finance_admin']),
    )
    expect(unknown[0]?.ok).toBe(false)
    expect(unknown[0]?.message).toBe('角色不存在')

    findButtonByText(container!, '导入更新').click()
    await flushUi()
    await uploadCsv('reimport-file', csv, 'user-update.csv')
    expect(container!.textContent).not.toContain('角色不存在')
    findButtonByText(container!, '预览差异').click()
    await waitForCondition(() => apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/batch/update'))
    const call = apiFetchMock.mock.calls.find((args) => String(args[0]) === '/api/admin/users/batch/update')
    const items = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)).items as Array<{ userId?: string; roleId?: string }>
    expect(items.find((item) => item.userId === 'user-1')?.roleId).toBeUndefined()
    expect(items.find((item) => item.userId === 'user-2')?.roleId).toBeUndefined()
  })

  function userCheckbox(name: string): HTMLInputElement {
    const input = findUserRow(container!, name).querySelector('input[type="checkbox"]')
    if (!(input instanceof HTMLInputElement)) throw new Error(`checkbox missing: ${name}`)
    return input
  }

  function setUserChecked(name: string, checked: boolean): void {
    const input = userCheckbox(name)
    input.checked = checked
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function batchUpdateBodies(): Array<Record<string, unknown>> {
    return apiFetchMock.mock.calls
      .filter((args) => String(args[0]).includes('/api/admin/users/batch/update'))
      .map((args) => JSON.parse(String((args[1] as RequestInit | undefined)?.body || '{}')) as Record<string, unknown>)
  }

  async function mountMembers(): Promise<void> {
    app = createApp(UserManagementView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi(20)
  }

  async function chooseBulkRole(roleId: string): Promise<void> {
    await waitForCondition(() => container!.querySelector(`select[aria-label="批量角色"] option[value="${roleId}"]`) !== null)
    const select = container!.querySelector('select[aria-label="批量角色"]')
    if (!(select instanceof HTMLSelectElement)) throw new Error('bulk role select missing')
    await setSelectValue(select, roleId)
    findButtonByText(container!, '应用角色').click()
    await waitForCondition(() => container!.querySelector('[data-testid="bulk-role-target"]') !== null)
  }

  it('shows role-catalog codes in the admission dialog and does not relabel the access snapshot as inherited', async () => {
    const base = createApiImplementation(callLog)
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const response = await base(input, init)
      if (new URL(String(input), 'http://localhost').pathname !== '/api/admin/users/user-1/access') return response
      const payload = await response.json() as { data: { permissions: string[] } }
      payload.data.permissions = ['aggregate:only', 'crm:admin']
      return createJsonResponse(payload)
    })
    await mountMembers()
    await openListedUser(container!, 'Alpha')
    const codes = Array.from(container!.querySelectorAll('.user-admin__chip--permission .user-admin__code')).map((node) => node.textContent?.trim())
    expect(codes).toContain('aggregate:only')
    const namespaceCard = container!.querySelector('.user-admin__role-card--namespace')
    const openButton = Array.from(namespaceCard?.querySelectorAll('button') ?? []).find((candidate) => candidate.textContent?.trim() === '开通插件使用')
    if (!(openButton instanceof HTMLButtonElement)) throw new Error('Namespace open button not found')
    openButton.click()
    await waitForCondition(() => Boolean(container!.querySelector('[data-testid="admin-authorization-dialog"]')))
    const dialog = container!.querySelector('[data-testid="admin-authorization-dialog"]')
    const inherited = dialog?.querySelector('[data-testid="admin-authorization-inherited-permissions"]')
    expect(inherited?.textContent).toContain('crm:admin')
    expect(inherited?.textContent).not.toContain('aggregate:only')
    expect(dialog?.textContent).toContain('下列权限码来自这些角色在角色目录中的清单。')
    expect(dialog?.textContent).not.toContain('aggregate:only')
    ;(dialog?.querySelector('[data-testid="admin-authorization-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    expect(apiFetchMock.mock.calls.some((args) => (
      new URL(String(args[0]), 'http://localhost').pathname.includes('/admission')
      && ((args[1] as RequestInit | undefined)?.method || 'GET').toUpperCase() === 'PATCH'
    ))).toBe(false)
  })

  it('does not apply a stale admission write when the same user is selected again', async () => {
    const base = createApiImplementation(callLog)
    let releasePatch: (() => void) | null = null
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase()
      const pathname = new URL(String(input), 'http://localhost').pathname
      if (method === 'PATCH' && /\/namespaces\/[^/]+\/admission$/.test(pathname)) {
        await new Promise<void>((resolve) => {
          releasePatch = resolve
        })
      }
      return base(input, init)
    })
    await mountMembers()
    await openListedUser(container!, 'Alpha')
    const openButton = Array.from(container!.querySelectorAll('.user-admin__role-card--namespace button')).find((candidate) => candidate.textContent?.trim() === '开通插件使用')
    if (!(openButton instanceof HTMLButtonElement)) throw new Error('Namespace open button not found')
    openButton.click()
    await confirmAdminAuthorization(container!)
    await waitForCondition(() => releasePatch !== null)
    const admissionCount = () => callLog.filter((url) => url.includes('/api/admin/users/user-1/member-admission')).length
    const accessCount = () => callLog.filter((url) => url.includes('/api/admin/users/user-1/access')).length
    const admissionsBeforeReturn = admissionCount()
    await openListedUser(container!, 'Bravo')
    await openListedUser(container!, 'Alpha')
    await waitForCondition(() => admissionCount() > admissionsBeforeReturn)
    await flushUi(8)
    const admissionsBeforeRelease = admissionCount()
    const accessBeforeRelease = accessCount()
    releasePatch?.()
    releasePatch = null
    await flushUi(16)
    const status = container!.querySelector('.user-admin__status')?.textContent || ''
    expect(status).not.toContain('已开通')
    expect(container!.textContent).toContain('插件使用未开通')
    expect(accessCount()).toBe(accessBeforeRelease)
    expect(admissionCount()).toBe(admissionsBeforeRelease)
    expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
  })

  it('cancels bulk role replacement without a write and drops it when the selection changes', async () => {
    await mountMembers()
    setUserChecked('Delta', true)
    await flushUi()
    expect(userCheckbox('Delta').checked).toBe(true)
    await chooseBulkRole('finance_admin')
    const preview = container!.querySelector('[data-testid="bulk-role-target"]')?.textContent || ''
    expect(preview).toContain('user-4')
    expect(preview).toContain('finance_admin')
    expect(preview).toContain('finance:admin')
    expect(preview).toContain('目前看不出这次会不会关闭插件使用。')
    expect(container!.querySelector('[data-testid="bulk-admin-removal-phrase"]')).toBeTruthy()
    const dialog = container!.querySelector('[data-testid="bulk-confirm"]')
    const cancel = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === '取消')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('bulk cancel missing')
    cancel.click()
    await flushUi()
    expect(container!.querySelector('[data-testid="bulk-confirm"]')).toBeNull()
    expect(batchUpdateBodies()).toEqual([])
    expect(userCheckbox('Delta').checked).toBe(true)

    setUserChecked('Alpha', true)
    await flushUi()
    await chooseBulkRole('finance_admin')
    setUserChecked('Alpha', false)
    await flushUi()
    expect(container!.querySelector('[data-testid="bulk-confirm"]')).toBeNull()
    expect(batchUpdateBodies()).toEqual([])
    expect(userCheckbox('Delta').checked).toBe(true)
    expect(userCheckbox('Alpha').checked).toBe(false)
  })

  it('requires the platform-admin phrase before bulk role replacement can remove an admin', async () => {
    const base = createApiImplementation(callLog)
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (String(input).includes('/api/admin/users/batch/update') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as { dryRun?: boolean }
        if (body.dryRun !== true) {
          return oneShotJsonResponse({
            ok: true,
            data: {
              successCount: 0,
              failureCount: 1,
              results: [{
                index: 0,
                ok: false,
                userId: 'user-4',
                email: 'delta@example.com',
                code: 'LAST_PLATFORM_ADMIN',
                message: '至少保留一名可登录的平台管理员',
              }],
            },
          })
        }
      }
      return base(input, init)
    })
    await mountMembers()
    setUserChecked('Delta', true)
    await flushUi()
    await chooseBulkRole('finance_admin')
    const submit = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (!(submit instanceof HTMLButtonElement)) throw new Error('bulk submit missing')
    expect(submit.disabled).toBe(true)
    const phrase = container!.querySelector('[data-testid="bulk-admin-removal-phrase"]')
    if (!(phrase instanceof HTMLInputElement)) throw new Error('bulk phrase missing')
    phrase.value = '取消'
    phrase.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(submit.disabled).toBe(true)
    expect(batchUpdateBodies()).toEqual([])
    phrase.value = '取消平台管理员'
    phrase.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(submit.disabled).toBe(false)
    submit.click()
    await waitForCondition(() => container!.querySelector('.user-admin__status')?.textContent?.includes('不能取消最后一名平台管理员') === true)
    expect(batchUpdateBodies()).toEqual([{
      items: [{ userId: 'user-4', email: 'delta@example.com', roleId: 'finance_admin' }],
    }])
    const status = container!.querySelector('.user-admin__status')?.textContent || ''
    expect(status).toContain('不能取消最后一名平台管理员')
    expect(status).not.toContain('已撤销')
    expect(status).not.toContain('至少保留一名可登录的平台管理员')
    expect(userCheckbox('Delta').checked).toBe(true)
  })

  it('keeps a top-level last-admin rejection in Chinese and does not claim the role was removed', async () => {
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (String(input).includes('/api/admin/users/batch/update') && method === 'POST') {
        return oneShotJsonResponse({
          ok: false,
          error: { code: 'LAST_PLATFORM_ADMIN', message: 'Cannot remove the last platform administrator' },
        }, 409)
      }
      return createApiImplementation(callLog)(input, init)
    })
    await mountMembers()
    setUserChecked('Delta', true)
    await flushUi()
    await chooseBulkRole('finance_admin')
    const phrase = container!.querySelector('[data-testid="bulk-admin-removal-phrase"]')
    if (!(phrase instanceof HTMLInputElement)) throw new Error('bulk phrase missing')
    phrase.value = '取消平台管理员'
    phrase.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container!.querySelector('[data-testid="bulk-confirm-submit"]') as HTMLButtonElement).click()
    await waitForCondition(() => container!.querySelector('.user-admin__status')?.textContent?.includes('不能取消最后一名平台管理员') === true)
    const status = container!.querySelector('.user-admin__status')?.textContent || ''
    expect(status).not.toContain('已撤销')
    expect(status).not.toContain('Cannot remove the last platform administrator')
    expect(batchUpdateBodies()).toHaveLength(1)
  })

  it('previews a role-bearing reimport before writing and leaves selection unchanged on cancel', async () => {
    await mountMembers()
    setUserChecked('Delta', true)
    await flushUi()
    findButtonByText(container!, '导入更新').click()
    await flushUi()
    const csv = [
      'userId,email,name,roleId,department,isActive,roleIds',
      'user-4,delta@example.com,Delta,finance_admin,装配,true,admin',
    ].join('\n')
    await uploadCsv('reimport-file', csv, 'role-update.csv')
    findButtonByText(container!, '预览差异').click()
    await waitForCondition(() => batchUpdateBodies().length === 1)
    expect(batchUpdateBodies()[0]?.dryRun).toBe(true)
    findButtonByText(container!, '确认更新').click()
    await waitForCondition(() => container!.querySelector('[data-testid="reimport-role-target"]') !== null)
    expect(batchUpdateBodies()).toHaveLength(1)
    const target = container!.querySelector('[data-testid="reimport-role-target"]')?.textContent || ''
    expect(target).toContain('user-4')
    expect(target).toContain('finance_admin')
    expect(target).toContain('finance:admin')
    expect(target).toContain('目前看不出这次会不会关闭插件使用。')
    const write = container!.querySelector('[data-testid="reimport-role-confirm"]')
    if (!(write instanceof HTMLButtonElement)) throw new Error('reimport role confirm missing')
    expect(write.disabled).toBe(true)
    findButtonByText(container!, '取消这次角色更新').click()
    await flushUi()
    expect(container!.querySelector('[data-testid="reimport-role-preview"]')).toBeNull()
    expect(batchUpdateBodies()).toHaveLength(1)
    expect(userCheckbox('Delta').checked).toBe(true)

    findButtonByText(container!, '确认更新').click()
    await waitForCondition(() => container!.querySelector('[data-testid="reimport-role-target"]') !== null)
    const phrase = container!.querySelector('[data-testid="bulk-admin-removal-phrase"]')
    if (!(phrase instanceof HTMLInputElement)) throw new Error('reimport phrase missing')
    phrase.value = '取消平台管理员'
    phrase.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container!.querySelector('[data-testid="reimport-role-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => batchUpdateBodies().length === 2)
    expect(batchUpdateBodies()[1]).toEqual({
      dryRun: false,
      items: [{
        userId: 'user-4',
        email: 'delta@example.com',
        name: 'Delta',
        roleId: 'finance_admin',
        department: '装配',
        isActive: true,
      }],
    })
    await waitForCondition(() => container!.querySelector('.user-admin__status')?.textContent?.includes('更新完成') === true)
    expect(container!.querySelector('[data-testid="reimport-dialog"]')).toBeNull()
    expect(container!.querySelector('[data-testid="reimport-role-preview"]')).toBeNull()
    const status = container!.querySelector('.user-admin__status')?.textContent || ''
    expect(status).toContain('更新完成：成功 1，失败 0')
    expect(status).not.toContain('批量操作完成')
    expect(userCheckbox('Delta').checked).toBe(true)
  })

  it('still writes a department-only reimport without a role confirmation', async () => {
    await mountMembers()
    findButtonByText(container!, '导入更新').click()
    await flushUi()
    const csv = [
      'userId,email,name,roleId,department,isActive,roleIds',
      'user-2,bravo@example.com,Bravo,,新部门,true,',
    ].join('\n')
    await uploadCsv('reimport-file', csv, 'department-update.csv')
    findButtonByText(container!, '预览差异').click()
    await waitForCondition(() => batchUpdateBodies().some((body) => body.dryRun === true))
    findButtonByText(container!, '确认更新').click()
    await waitForCondition(() => batchUpdateBodies().some((body) => body.dryRun === false))
    expect(container!.querySelector('[data-testid="reimport-role-preview"]')).toBeNull()
    const write = batchUpdateBodies().find((body) => body.dryRun === false)
    const items = write?.items as Array<{ userId?: string; roleId?: string; department?: string }>
    expect(items).toEqual([{
      userId: 'user-2',
      email: 'bravo@example.com',
      name: 'Bravo',
      department: '新部门',
      isActive: true,
    }])
    expect(items?.some((item) => item.roleId)).toBe(false)
    await waitForCondition(() => container!.querySelector('.user-admin__status')?.textContent?.includes('更新完成') === true)
    expect(container!.querySelector('[data-testid="reimport-dialog"]')).toBeNull()
    const departmentStatus = container!.querySelector('.user-admin__status')?.textContent || ''
    expect(departmentStatus).toContain('更新完成')
    expect(departmentStatus).not.toContain('批量操作完成')
  })

  function pageStatus(): string {
    return container!.querySelector('.user-admin__status')?.textContent || ''
  }

  function namespaceBulkPosts(): Array<Record<string, unknown>> {
    return apiFetchMock.mock.calls
      .filter((args) => String(args[0]).includes('/namespaces/') && String(args[0]).includes('/admission/bulk'))
      .map((args) => JSON.parse(String((args[1] as RequestInit | undefined)?.body || '{}')) as Record<string, unknown>)
  }

  function installRealBatchUpdate(payload: unknown, status = 200): void {
    const base = createApiImplementation(callLog)
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const pathname = new URL(String(input), 'http://localhost').pathname
      if (pathname === '/api/admin/users/batch/update') return realJsonResponse(payload, status)
      return base(input, init)
    })
  }

  async function confirmDepartmentUpdate(): Promise<void> {
    setUserChecked('Alpha', true)
    await flushUi()
    const input = container!.querySelector('input[aria-label="批量部门"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('department input missing')
    input.value = '装配车间'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    findButtonByText(container!, '应用部门').click()
    await flushUi()
    const submit = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (!(submit instanceof HTMLButtonElement)) throw new Error('department confirm missing')
    submit.click()
  }

  async function openFinanceAdmissionConfirm(name = 'Bravo'): Promise<void> {
    await setSelectValue(findNamespaceSelect(container!), 'finance')
    setUserChecked(name, true)
    await flushUi()
    findButtonByText(container!, '批量开通插件使用').click()
    await waitForCondition(() => container!.querySelector('[data-testid="bulk-admission-target"]') !== null)
  }

  function roleUpdateCsv(roleId: string): string {
    return [
      'userId,email,name,roleId,department,isActive,roleIds',
      `user-4,delta@example.com,Delta,${roleId},装配,true,admin`,
    ].join('\n')
  }

  async function openReimportRolePreview(csv: string, fileName: string): Promise<void> {
    if (!container!.querySelector('[data-testid="reimport-dialog"]')) {
      findButtonByText(container!, '导入更新').click()
      await flushUi()
    }
    await uploadCsv('reimport-file', csv, fileName)
    findButtonByText(container!, '预览差异').click()
    await waitForCondition(() => {
      const button = Array.from(container!.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('确认更新'))
      return Boolean(button && !button.disabled && batchUpdateBodies().some((body) => body.dryRun === true))
    })
    findButtonByText(container!, '确认更新').click()
    await waitForCondition(() => container!.querySelector('[data-testid="reimport-role-target"]') !== null)
  }

  async function typeBulkAdminPhrase(): Promise<void> {
    const phrase = container!.querySelector('[data-testid="bulk-admin-removal-phrase"]')
    if (!(phrase instanceof HTMLInputElement)) throw new Error('bulk phrase missing')
    phrase.value = '取消平台管理员'
    phrase.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
  }

  it('reads a real batch-update Response once for success, failure, and last-admin', async () => {
    installRealBatchUpdate({
      ok: true,
      data: {
        successCount: 1,
        failureCount: 0,
        results: [{ index: 0, ok: true, userId: 'user-1', code: null, message: 'ok' }],
      },
    })
    await mountMembers()
    await confirmDepartmentUpdate()
    await waitForCondition(() => pageStatus().includes('批量操作完成：成功 1，失败 0'))
    expect(pageStatus()).not.toContain('批量操作失败')
    expect(batchUpdateBodies()).toEqual([{
      items: [{ userId: 'user-1', email: 'alpha@example.com', department: '装配车间' }],
    }])

    app?.unmount()
    installRealBatchUpdate({ ok: false, error: { message: '批量写入失败' } }, 500)
    await mountMembers()
    await confirmDepartmentUpdate()
    await waitForCondition(() => pageStatus().includes('批量写入失败'))
    expect(pageStatus()).not.toContain('批量操作完成')
    expect(pageStatus()).not.toContain('成功 1')

    app?.unmount()
    installRealBatchUpdate({
      ok: true,
      data: {
        successCount: 0,
        failureCount: 1,
        results: [{
          index: 0,
          ok: false,
          userId: 'user-1',
          code: 'LAST_PLATFORM_ADMIN',
          message: '至少保留一名可登录的平台管理员',
        }],
      },
    })
    await mountMembers()
    await confirmDepartmentUpdate()
    await waitForCondition(() => pageStatus().includes('不能取消最后一名平台管理员'))
    const itemStatus = pageStatus()
    expect(itemStatus).toContain('批量操作完成：成功 0，失败 1。不能取消最后一名平台管理员')
    expect(itemStatus).not.toContain('已撤销')
    expect(itemStatus).not.toContain('至少保留一名可登录的平台管理员')

    app?.unmount()
    installRealBatchUpdate({
      ok: false,
      error: { code: 'LAST_PLATFORM_ADMIN', message: 'Cannot remove the last platform administrator' },
    }, 409)
    await mountMembers()
    await confirmDepartmentUpdate()
    await waitForCondition(() => pageStatus().includes('不能取消最后一名平台管理员'))
    const topStatus = pageStatus()
    expect(topStatus).not.toContain('Cannot remove the last platform administrator')
    expect(topStatus).not.toContain('批量操作完成')
    expect(topStatus).not.toContain('已撤销')
  })

  it('requires the platform-admin phrase when the access payload belongs to a different user', async () => {
    const base = createApiImplementation(callLog)
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
      if (match && decodeURIComponent(match[1]) === 'user-4') {
        return createJsonResponse({
          ok: true,
          data: {
            user: { id: 'user-1', name: 'Alpha', role: 'user', is_active: true, is_admin: false },
            roles: ['crm_admin'],
            permissions: ['crm:admin'],
            isAdmin: false,
          },
        })
      }
      return base(input, init)
    })
    await mountMembers()
    setUserChecked('Delta', true)
    await flushUi()
    await chooseBulkRole('finance_admin')
    const submit = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (!(submit instanceof HTMLButtonElement)) throw new Error('bulk submit missing')
    expect(submit.disabled).toBe(true)
    expect(container!.querySelector('[data-testid="bulk-admin-removal-phrase"]')).toBeTruthy()
    expect(batchUpdateBodies()).toEqual([])

    const dialog = container!.querySelector('[data-testid="bulk-confirm"]')
    const cancel = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === '取消')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('bulk cancel missing')
    cancel.click()
    await flushUi()
    setUserChecked('Delta', false)
    setUserChecked('Alpha', true)
    await flushUi()
    await chooseBulkRole('finance_admin')
    expect(container!.querySelector('[data-testid="bulk-admin-removal-phrase"]')).toBeNull()
    const alphaSubmit = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (!(alphaSubmit instanceof HTMLButtonElement)) throw new Error('alpha bulk submit missing')
    expect(alphaSubmit.disabled).toBe(false)
    expect(batchUpdateBodies()).toEqual([])
  })

  it('drops a frozen role reimport when a new file arrives, even with the same rows', async () => {
    await mountMembers()
    const csv = roleUpdateCsv('finance_admin')
    await openReimportRolePreview(csv, 'role-update.csv')
    await typeBulkAdminPhrase()
    const confirm = container!.querySelector('[data-testid="reimport-role-confirm"]')
    if (!(confirm instanceof HTMLButtonElement)) throw new Error('reimport role confirm missing')
    expect(confirm.disabled).toBe(false)
    const writesBefore = batchUpdateBodies().filter((body) => body.dryRun === false).length
    await uploadCsv('reimport-file', csv, 'role-update-again.csv')
    expect(container!.querySelector('[data-testid="reimport-dialog"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="reimport-role-preview"]')).toBeNull()
    expect(batchUpdateBodies().filter((body) => body.dryRun === false)).toHaveLength(writesBefore)
    expect(findButtonByText(container!, '确认更新').disabled).toBe(true)
  })

  it('drops a frozen role reimport when the uploaded role rows change', async () => {
    await mountMembers()
    await openReimportRolePreview(roleUpdateCsv('finance_admin'), 'role-finance.csv')
    await typeBulkAdminPhrase()
    await uploadCsv('reimport-file', roleUpdateCsv('crm_admin'), 'role-crm.csv')
    expect(container!.querySelector('[data-testid="reimport-dialog"]')).toBeTruthy()
    expect(container!.querySelector('[data-testid="reimport-role-preview"]')).toBeNull()
    expect(batchUpdateBodies().some((body) => body.dryRun === false)).toBe(false)
    findButtonByText(container!, '预览差异').click()
    await waitForCondition(() => {
      const button = Array.from(container!.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('确认更新'))
      return Boolean(button && !button.disabled && batchUpdateBodies().filter((body) => body.dryRun === true).length >= 2)
    })
    findButtonByText(container!, '确认更新').click()
    await waitForCondition(() => container!.querySelector('[data-testid="reimport-role-target"]') !== null)
    expect(container!.querySelector('[data-testid="reimport-role-target"]')?.textContent).toContain('crm_admin')
    expect(container!.querySelector('[data-testid="reimport-role-target"]')?.textContent).not.toContain('finance_admin')
    expect(batchUpdateBodies().some((body) => body.dryRun === false)).toBe(false)
  })

  it('drops a frozen role reimport when the role catalog changes', async () => {
    let catalogChanged = false
    const base = createApiImplementation(callLog)
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (url.pathname === '/api/admin/roles' && catalogChanged) {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'crm_admin', name: 'CRM 管理员', memberCount: 1, permissions: ['crm:admin'] },
              {
                id: 'finance_admin',
                name: '财务管理员',
                memberCount: 1,
                permissions: ['finance:changed'],
                admissionNamespaces: ['finance'],
              },
            ],
          },
        })
      }
      if (method === 'POST' && /\/roles\/assign$/.test(url.pathname)) {
        catalogChanged = true
        return createJsonResponse({ ok: false, error: { code: 'ROLE_MODIFIED', message: 'Role catalog version mismatch' } }, 409)
      }
      return base(input, init)
    })
    await mountMembers()
    await openListedUser(container!, 'Alpha')
    await openReimportRolePreview(roleUpdateCsv('finance_admin'), 'role-catalog.csv')
    await typeBulkAdminPhrase()
    expect((container!.querySelector('[data-testid="reimport-role-confirm"]') as HTMLButtonElement).disabled).toBe(false)
    const roleSelect = container!.querySelector('[data-testid="user-role-select"]')
    if (!(roleSelect instanceof HTMLSelectElement)) throw new Error('role select missing')
    await setSelectValue(roleSelect, 'finance_admin')
    const assign = container!.querySelector('[data-testid="assign-role-button"]')
    if (!(assign instanceof HTMLButtonElement)) throw new Error('assign missing')
    expect(assign.disabled).toBe(false)
    assign.click()
    await confirmAdminAuthorization(container!)
    await waitForCondition(() => container!.querySelector('[data-testid="reimport-role-preview"]') === null)
    expect(container!.querySelector('[data-testid="reimport-dialog"]')).toBeTruthy()
    expect(pageStatus()).toContain('角色目录已变化，本次未写入。请刷新角色后再确认。')
    expect(batchUpdateBodies().some((body) => body.dryRun === false)).toBe(false)
  })

  it('cancels bulk plugin admission without posting and drops a stale selection or namespace', async () => {
    await mountMembers()
    await openFinanceAdmissionConfirm()
    expect(container!.querySelector('[data-testid="bulk-admission-preview"]')?.textContent).toContain('不改变这些用户的角色，也不写入直接权限。')
    expect(container!.textContent).toContain('确认开通插件使用：finance？')
    const dialog = container!.querySelector('[data-testid="bulk-confirm"]')
    const cancel = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === '取消')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('admission cancel missing')
    cancel.click()
    await flushUi()
    expect(container!.querySelector('[data-testid="bulk-confirm"]')).toBeNull()
    expect(namespaceBulkPosts()).toEqual([])
    expect(userCheckbox('Bravo').checked).toBe(true)

    findButtonByText(container!, '批量开通插件使用').click()
    await waitForCondition(() => container!.querySelector('[data-testid="bulk-admission-target"]') !== null)
    setUserChecked('Bravo', false)
    const staleSubmit = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (!(staleSubmit instanceof HTMLButtonElement)) throw new Error('stale admission confirm missing')
    staleSubmit.click()
    await flushUi()
    expect(namespaceBulkPosts()).toEqual([])
    expect(container!.querySelector('[data-testid="bulk-confirm"]')).toBeNull()

    setUserChecked('Bravo', true)
    await flushUi()
    findButtonByText(container!, '批量开通插件使用').click()
    await waitForCondition(() => container!.querySelector('[data-testid="bulk-admission-target"]') !== null)
    await setSelectValue(findNamespaceSelect(container!), 'crm')
    const namespaceSubmit = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (namespaceSubmit instanceof HTMLButtonElement) namespaceSubmit.click()
    await flushUi()
    expect(namespaceBulkPosts()).toEqual([])
    expect(container!.querySelector('[data-testid="bulk-confirm"]')).toBeNull()
    expect(userCheckbox('Bravo').checked).toBe(true)
  })

  it('posts bulk plugin admission once when confirm is clicked twice', async () => {
    await mountMembers()
    await openListedUser(container!, 'Bravo')
    await openFinanceAdmissionConfirm()
    const submit = container!.querySelector('[data-testid="bulk-confirm-submit"]')
    if (!(submit instanceof HTMLButtonElement)) throw new Error('admission confirm missing')
    submit.click()
    submit.click()
    await waitForCondition(() => pageStatus().includes('已批量开通 finance 插件使用'))
    expect(namespaceBulkPosts()).toEqual([{ userIds: ['user-2'], enabled: true }])
    expect(pageStatus()).toContain('已批量开通 finance 插件使用')
  })

  it('does not claim bulk plugin admission succeeded before the enabled readback matches', async () => {
    const state = createApiState()
    const base = createApiImplementation(callLog, state)
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'POST' && url.pathname === '/api/admin/users/namespaces/finance/admission/bulk') {
        return createJsonResponse({
          ok: true,
          data: { namespace: 'finance', userIds: ['user-2'], enabled: true, updatedCount: 1 },
        })
      }
      return base(input, init)
    })
    await mountMembers()
    await openListedUser(container!, 'Bravo')
    await openFinanceAdmissionConfirm()
    ;(container!.querySelector('[data-testid="bulk-confirm-submit"]') as HTMLButtonElement).click()
    await waitForCondition(() => pageStatus().includes('插件使用回读未显示「finance」已对所选用户开通，本次未记为成功。'))
    expect(namespaceBulkPosts()).toEqual([{ userIds: ['user-2'], enabled: true }])
    expect(pageStatus()).not.toContain('已批量开通')
    expect(container!.textContent).not.toContain('插件使用已开通')
  })

  function installDeferredBulkDetailAccess(): { waiting: () => boolean; release: () => void } {
    const state = createApiState()
    const base = createApiImplementation(callLog, state)
    let bulkPosted = false
    let heldBulkAccess = false
    let bulkAccessWaiting = false
    let releaseBulkAccess: () => void = () => {}
    const bulkAccessHold = new Promise<void>((resolve) => {
      releaseBulkAccess = resolve
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'POST' && url.pathname === '/api/admin/users/namespaces/finance/admission/bulk') {
        bulkPosted = true
      }
      if (method === 'GET' && url.pathname === '/api/admin/users/user-1/access' && bulkPosted && !heldBulkAccess) {
        heldBulkAccess = true
        bulkAccessWaiting = true
        await bulkAccessHold
        const response = await base(input, init)
        const payload = await response.json() as { data: { user: { name: string }; permissions: string[] } }
        payload.data.user.name = 'Stale Alpha'
        payload.data.permissions = ['stale-bulk-access']
        return createJsonResponse(payload)
      }
      if (method === 'GET' && url.pathname === '/api/admin/users/user-1/access' && heldBulkAccess) {
        const response = await base(input, init)
        const payload = await response.json() as { data: { user: { name: string }; permissions: string[] } }
        payload.data.user.name = 'Alpha Again'
        payload.data.permissions = ['alpha-reselected']
        return createJsonResponse(payload)
      }
      if (method === 'GET' && url.pathname === '/api/admin/users/user-2/access') {
        const response = await base(input, init)
        const payload = await response.json() as { data: { permissions: string[] } }
        payload.data.permissions = ['bravo-live-access']
        return createJsonResponse(payload)
      }
      return base(input, init)
    })
    return {
      waiting: () => bulkAccessWaiting,
      release: () => releaseBulkAccess(),
    }
  }

  it('leaves the current detail untouched when bulk access readback returns after A switches to B', async () => {
    const deferred = installDeferredBulkDetailAccess()
    try {
      await mountMembers()
      await openListedUser(container!, 'Alpha')
      await openFinanceAdmissionConfirm('Alpha')
      ;(container!.querySelector('[data-testid="bulk-confirm-submit"]') as HTMLButtonElement).click()
      await waitForCondition(() => deferred.waiting())
      expect(namespaceBulkPosts()).toEqual([{ userIds: ['user-1'], enabled: true }])
      expect(apiFetchMock.mock.calls.some((args) => String(args[0]) === '/api/admin/users/user-1/member-admission')).toBe(true)
      expect(pageStatus()).not.toContain('已批量开通')
      await openListedUser(container!, 'Bravo')
      await waitForCondition(() => container!.textContent?.includes('bravo-live-access') === true)
      deferred.release()
      await waitForCondition(() => pageStatus().includes('已批量开通 finance 插件使用'))
      expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
      expect(container!.querySelector('[data-testid="user-access-unread"]')).toBeNull()
      expect(container!.textContent).toContain('bravo-live-access')
      expect(container!.textContent).not.toContain('stale-bulk-access')
      expect(container!.textContent).not.toContain('Stale Alpha')
      expect(pageStatus()).not.toContain('生效权限回读与当前用户不一致')
      const namespaceCards = Array.from(container!.querySelectorAll('.user-admin__role-card--namespace')).map((card) => card.textContent || '')
      expect(namespaceCards.some((text) => text.includes('finance'))).toBe(false)
      expect(namespaceCards.some((text) => text.includes('crm') && text.includes('插件使用未开通'))).toBe(true)
    } finally {
      deferred.release()
    }
  })

  it('does not apply a stale bulk access readback when the detail returns from B to A', async () => {
    const deferred = installDeferredBulkDetailAccess()
    try {
      await mountMembers()
      await openListedUser(container!, 'Alpha')
      await openFinanceAdmissionConfirm('Alpha')
      ;(container!.querySelector('[data-testid="bulk-confirm-submit"]') as HTMLButtonElement).click()
      await waitForCondition(() => deferred.waiting())
      expect(pageStatus()).not.toContain('已批量开通')
      await openListedUser(container!, 'Bravo')
      await waitForCondition(() => container!.textContent?.includes('bravo-live-access') === true)
      await openListedUser(container!, 'Alpha')
      await waitForCondition(() => container!.textContent?.includes('alpha-reselected') === true)
      expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha Again')
      deferred.release()
      await waitForCondition(() => pageStatus().includes('已批量开通 finance 插件使用'))
      expect(container!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha Again')
      expect(container!.querySelector('[data-testid="user-access-unread"]')).toBeNull()
      expect(container!.textContent).toContain('alpha-reselected')
      expect(container!.textContent).not.toContain('stale-bulk-access')
      expect(container!.textContent).not.toContain('Stale Alpha')
      expect(pageStatus()).not.toContain('生效权限回读与当前用户不一致')
      expect(namespaceBulkPosts()).toEqual([{ userIds: ['user-1'], enabled: true }])
    } finally {
      deferred.release()
    }
  })

  it('does not claim bulk plugin admission succeeded when the access readback is for another user', async () => {
    const base = createApiImplementation(callLog)
    let bulkPosted = false
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'POST' && url.pathname === '/api/admin/users/namespaces/finance/admission/bulk') {
        bulkPosted = true
      }
      const response = await base(input, init)
      if (bulkPosted && url.pathname === '/api/admin/users/user-2/access') {
        const payload = await response.json() as { data: { user: { id: string } } }
        payload.data.user.id = 'user-9'
        return createJsonResponse(payload)
      }
      return response
    })
    await mountMembers()
    await openListedUser(container!, 'Bravo')
    await openFinanceAdmissionConfirm()
    ;(container!.querySelector('[data-testid="bulk-confirm-submit"]') as HTMLButtonElement).click()
    await waitForCondition(() => pageStatus().includes('生效权限回读与当前用户不一致，本次插件使用未记为成功。'))
    expect(namespaceBulkPosts()).toEqual([{ userIds: ['user-2'], enabled: true }])
    expect(pageStatus()).not.toContain('已批量开通')
  })
})

describe('UserManagementView authorization handlers', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    window.history.replaceState({}, '', '/')
    apiFetchMock.mockReset()
  })

  function adminSideResponse(pathname: string) {
    if (pathname.endsWith('/sessions')) return createJsonResponse({ ok: true, data: { items: [] } })
    if (pathname.endsWith('/dingtalk-access')) {
      return createJsonResponse({
        ok: true,
        data: {
          provider: 'dingtalk',
          requireGrant: false,
          grant: { exists: false, enabled: false, grantedBy: null, createdAt: null, updatedAt: null },
          identity: { exists: false, corpId: null, unionId: null, openId: null, hasUnionId: false, hasOpenId: false, lastLoginAt: null, createdAt: null, updatedAt: null },
        },
      })
    }
    if (pathname.endsWith('/member-admission')) {
      return createJsonResponse({
        ok: true,
        data: {
          userId: pathname.split('/')[4] || '',
          accountEnabled: true,
          platformAdminEnabled: false,
          attendanceAdminEnabled: false,
          businessRoleIds: [],
          directoryMemberships: [],
          dingtalk: { grant: { enabled: false } },
          namespaceAdmissions: [],
        },
      })
    }
    return null
  }

  function postCalls(): Array<{ url: string; body: Record<string, unknown> }> {
    return apiFetchMock.mock.calls
      .filter((args) => ((args[1] as RequestInit | undefined)?.method || 'GET').toUpperCase() === 'POST')
      .map((args) => ({
        url: String(args[0]),
        body: JSON.parse(String((args[1] as RequestInit).body || '{}')) as Record<string, unknown>,
      }))
  }

  function install(handlers: {
    capability?: boolean
    users?: Array<Record<string, unknown>>
    presets?: Array<Record<string, unknown>>
    roleItems?: Array<Record<string, unknown>>
    roleWrite?: { status: number; error?: Record<string, unknown> }
  } = {}): void {
    const users = handlers.users ?? [
      { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true, is_admin: false },
      { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true, is_admin: false },
    ]
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (url.pathname === '/api/admin/roles') {
        return createJsonResponse({
          ok: true,
          data: {
            items: handlers.roleItems ?? [
              {
                id: 'crm_admin',
                name: 'CRM 管理员',
                memberCount: 1,
                permissions: ['crm:read'],
                updatedAt: '2026-11-01T00:00:00.000Z',
                admissionNamespaces: ['stock-prep'],
              },
              {
                id: 'admin',
                name: '平台管理员',
                memberCount: 1,
                permissions: [],
                updatedAt: '2026-11-01T00:00:00.000Z',
                admissionNamespaces: [],
              },
            ],
          },
        })
      }
      if (url.pathname === '/api/admin/access-presets') {
        return createJsonResponse({
          ok: true,
          data: { items: handlers.presets ?? [] },
          capabilities: handlers.capability === false ? { explicitNamespaceAdmission: false } : { explicitNamespaceAdmission: true },
        })
      }
      if (url.pathname === '/api/admin/users' && method === 'GET') {
        const query = url.searchParams.get('q')
        const items = query ? users.filter((user) => String(user.name || '').includes(query)) : users
        return createJsonResponse({ ok: true, data: { items, total: items.length } })
      }
      if (url.pathname === '/api/admin/users' && method === 'POST') {
        return createJsonResponse({
          ok: true,
          data: {
            user: { id: 'user-created', name: String(body.name || '新用户'), role: 'user', is_active: true, is_admin: false },
            roles: [],
            permissions: [],
            isAdmin: false,
          },
        })
      }
      const accessMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
      if (accessMatch) {
        const userId = decodeURIComponent(accessMatch[1])
        const user = users.find((item) => item.id === userId) || { id: userId, name: userId, role: 'user', is_active: true, is_admin: false }
        return createJsonResponse({
          ok: true,
          data: {
            user,
            roles: userId === 'user-1' ? ['crm_admin'] : [],
            permissions: userId === 'user-1' ? ['crm:read'] : [],
            isAdmin: false,
          },
        })
      }
      const roleMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles\/(assign|unassign)$/)
      if (roleMatch && method === 'POST') {
        if (handlers.roleWrite) {
          return createJsonResponse({ ok: false, error: handlers.roleWrite.error || { message: 'conflict' } }, handlers.roleWrite.status)
        }
        const userId = decodeURIComponent(roleMatch[1])
        const roleId = String(body.roleId || '')
        return createJsonResponse({
          ok: true,
          data: {
            user: { id: userId, name: userId === 'user-1' ? 'Alpha' : 'Bravo' },
            roles: roleMatch[2] === 'assign' ? ['crm_admin', roleId] : [],
            permissions: [],
            isAdmin: false,
            changedRoleId: roleId,
            roleHeld: roleMatch[2] === 'assign',
            membershipChanged: true,
          },
        })
      }
      const side = adminSideResponse(url.pathname)
      if (side) return side
      if (method === 'GET') return createJsonResponse({ ok: true, data: { items: [] } })
      return createJsonResponse({ ok: false, error: { message: 'unexpected' } }, 500)
    })
  }

  async function mount(): Promise<HTMLDivElement> {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(UserManagementView)
    registerRouterLink(app, true)
    app.mount(container)
    await flushUi(20)
    return container
  }

  it('does not select the first user, keeps an explicit selection when the deep link is removed, and skips a missing deep link', async () => {
    install()
    const root = await mount()
    await waitForCondition(() => root.textContent?.includes('Alpha') ?? false)
    expect(root.querySelector('[data-testid="selected-user-heading"]')).toBeNull()
    expect(apiFetchMock.mock.calls.some((args) => /\/api\/admin\/users\/[^/]+\/access(?:\?|$)/.test(String(args[0])))).toBe(false)

    await openListedUser(root, 'Alpha')
    expect(root.querySelector('[data-testid="effective-access-title"]')?.textContent).toBe('生效权限')
    expect(root.querySelector('[data-testid="effective-access-note"]')?.textContent).toContain('服务端控制')
    expect(root.textContent).toContain('不是最终业务访问结论')

    window.history.replaceState({}, '', '/admin/users')
    await flushUi(8)
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')

    app?.unmount()
    container?.remove()
    apiFetchMock.mockReset()
    window.history.replaceState({}, '', '/admin/users?userId=missing-user')
    install()
    const missing = await mount()
    await waitForCondition(() => missing.textContent?.includes('Alpha') ?? false)
    expect(missing.querySelector('[data-testid="selected-user-heading"]')).toBeNull()
    expect(apiFetchMock.mock.calls.some((args) => /\/api\/admin\/users\/[^/]+\/access(?:\?|$)/.test(String(args[0])))).toBe(false)
  })

  it('sends no create request before confirm, defaults admission to an empty list, and opts in only checked namespaces', async () => {
    install({
      presets: [{
        id: 'preset-stock',
        name: '备料预设',
        description: '给备料同事',
        productMode: 'platform',
        role: 'user',
        roleId: 'missing-role',
        permissions: ['crm:read'],
        admissionNamespaces: ['stock-prep'],
        homePath: '/stock',
        welcomeTitle: '欢迎',
        checklist: [],
      }],
    })
    const root = await mount()
    const nameInput = Array.from(root.querySelectorAll<HTMLInputElement>('.user-admin__panel--create input')).find((input) => input.placeholder === '姓名')
    if (!nameInput) throw new Error('name input missing')
    nameInput.value = '林岚'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    const preset = Array.from(root.querySelectorAll('select')).find((select) => select.innerHTML.includes('备料预设'))
    if (!(preset instanceof HTMLSelectElement)) throw new Error('preset select missing')
    preset.value = 'preset-stock'
    preset.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(root.querySelector('[data-testid="preset-direct-permissions"]')?.textContent).toContain('crm:read')
    expect(root.querySelector('[data-testid="preset-inherited-permissions"]')?.textContent).toContain('不能把预设自带的权限说成角色继承')
    const namespaceBox = Array.from(root.querySelectorAll('[data-testid="create-admission-namespaces"] input')).find((input) => input.parentElement?.textContent?.includes('stock-prep'))
    expect(namespaceBox).toBeTruthy()
    expect(root.querySelector('[data-testid="create-admission-namespaces"]')?.textContent).not.toContain('crm:read')
    expect((namespaceBox as HTMLInputElement).checked).toBe(false)

    findButtonByText(root, '创建用户').click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="admin-authorization-dialog"]')))
    expect(postCalls()).toEqual([])
    expect(root.querySelector('[data-testid="admin-authorization-dialog"]')?.textContent).not.toContain('admissionNamespaces')
    expect(root.querySelector('[data-testid="admin-authorization-dialog"]')?.textContent).not.toContain('前缀')
    ;(root.querySelector('[data-testid="admin-authorization-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    expect(postCalls()).toEqual([])

    ;(namespaceBox as HTMLInputElement).checked = true
    namespaceBox?.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    findButtonByText(root, '创建用户').click()
    await confirmAdminAuthorization(root)
    await waitForCondition(() => postCalls().some((call) => call.url === '/api/admin/users'))
    const created = postCalls().find((call) => call.url === '/api/admin/users')
    expect(created?.body.admissionNamespaces).toEqual(['stock-prep'])
    expect(created?.body.roleId).toBe('missing-role')
  })

  it('blocks create until explicit namespace capability is loaded and does not replay a 409 role write', async () => {
    let capability = false
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (url.pathname === '/api/admin/access-presets') {
        return createJsonResponse({
          ok: true,
          data: { items: [] },
          capabilities: { explicitNamespaceAdmission: capability },
        })
      }
      if (url.pathname === '/api/admin/roles') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [{ id: 'crm_admin', name: 'CRM 管理员', memberCount: 1, permissions: ['crm:read'], updatedAt: '2026-11-01T00:00:00.000Z', admissionNamespaces: [] }],
          },
        })
      }
      if (url.pathname === '/api/admin/users' && method === 'GET') {
        return createJsonResponse({
          ok: true,
          data: { items: [{ id: 'user-1', name: 'Alpha', email: 'alpha@example.com', role: 'user', is_active: true, is_admin: false }], total: 1 },
        })
      }
      const roleMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles\/assign$/)
      if (roleMatch && method === 'POST') {
        return createJsonResponse({ ok: false, error: { code: 'ROLE_MODIFIED', message: 'Role catalog version mismatch' } }, 409)
      }
      const accessMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
      if (accessMatch) {
        return createJsonResponse({
          ok: true,
          data: {
            user: { id: 'user-1', name: 'Alpha', role: 'user', is_active: true, is_admin: false },
            roles: [],
            permissions: [],
            isAdmin: false,
          },
        })
      }
      const side = adminSideResponse(url.pathname)
      if (side) return side
      if (method === 'GET') return createJsonResponse({ ok: true, data: { items: [] } })
      return createJsonResponse({ ok: false, error: { message: 'unexpected' } }, 500)
    })
    const root = await mount()
    expect(root.querySelector('[data-testid="namespace-admission-capability"]')?.textContent).toContain('已暂停创建')
    expect(findButtonByText(root, '创建用户').disabled).toBe(true)
    findButtonByText(root, '创建用户').click()
    await flushUi()
    expect(postCalls()).toEqual([])

    capability = true
    ;(root.querySelector('[data-testid="retry-access-presets"]') as HTMLButtonElement).click()
    await waitForCondition(() => !findButtonByText(root, '创建用户').disabled)
    const nameInput = Array.from(root.querySelectorAll<HTMLInputElement>('.user-admin__panel--create input')).find((input) => input.placeholder === '姓名')
    if (!nameInput) throw new Error('name input missing')
    nameInput.value = '林岚'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    findButtonByText(root, '创建用户').click()
    await confirmAdminAuthorization(root)
    await waitForCondition(() => postCalls().some((call) => call.url === '/api/admin/users'))
    expect(postCalls().find((call) => call.url === '/api/admin/users')?.body.admissionNamespaces).toEqual([])

    await openListedUser(root, 'Alpha')
    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    await confirmAdminAuthorization(root)
    await waitForCondition(() => root.textContent?.includes('角色目录已变化，本次未写入。请刷新角色后再确认。') ?? false)
    expect(root.textContent).not.toContain('已分配角色')
    expect(root.textContent).not.toContain('Role catalog version mismatch')
    expect(root.querySelector('[data-testid="user-access-unread"]')).toBeTruthy()
    const assign = postCalls().find((call) => call.url.includes('/roles/assign'))
    expect(assign?.body).toEqual({ roleId: 'crm_admin', expectedUpdatedAt: '2026-11-01T00:00:00.000Z' })
  })

  it('drops a pending role confirmation when the user changes and refuses the last platform admin in Chinese', async () => {
    install({
      users: [
        { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'admin', is_active: true, is_admin: true },
        { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true, is_admin: false },
      ],
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (url.pathname === '/api/admin/access-presets') {
        return createJsonResponse({ ok: true, data: { items: [] }, capabilities: { explicitNamespaceAdmission: true } })
      }
      if (url.pathname === '/api/admin/roles') {
        return createJsonResponse({
          ok: true,
          data: { items: [{ id: 'admin', name: '平台管理员', memberCount: 1, permissions: [], updatedAt: '2026-11-01T00:00:00.000Z', admissionNamespaces: [] }] },
        })
      }
      if (url.pathname === '/api/admin/users' && method === 'GET') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', name: 'Alpha', email: 'alpha@example.com', role: 'admin', is_active: true, is_admin: true },
              { id: 'user-2', name: 'Bravo', email: 'bravo@example.com', role: 'user', is_active: true, is_admin: false },
            ],
            total: 2,
          },
        })
      }
      const accessMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
      if (accessMatch) {
        const userId = decodeURIComponent(accessMatch[1])
        return createJsonResponse({
          ok: true,
          data: {
            user: { id: userId, name: userId === 'user-1' ? 'Alpha' : 'Bravo', role: userId === 'user-1' ? 'admin' : 'user', is_active: true, is_admin: userId === 'user-1' },
            roles: userId === 'user-1' ? ['admin'] : [],
            permissions: [],
            isAdmin: userId === 'user-1',
          },
        })
      }
      if (url.pathname.endsWith('/roles/unassign') && method === 'POST') {
        return createJsonResponse({ ok: false, error: { code: 'LAST_PLATFORM_ADMIN', message: 'Cannot remove the last platform administrator' } }, 409)
      }
      const side = adminSideResponse(url.pathname)
      if (side) return side
      if (method === 'GET') return createJsonResponse({ ok: true, data: { items: [] } })
      return createJsonResponse({ ok: false, error: { message: 'unexpected' } }, 500)
    })
    const root = await mount()
    await openListedUser(root, 'Alpha')
    ;(root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="admin-authorization-dialog"]')))
    expect(root.querySelector('[data-testid="admin-authorization-platform-admin"]')?.textContent).toContain('权限码列表即使为空')
    await openListedUser(root, 'Bravo')
    expect(root.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()
    expect(postCalls().some((call) => call.url.includes('/roles/'))).toBe(false)

    await openListedUser(root, 'Alpha')
    ;(root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement).click()
    await confirmAdminAuthorization(root, '取消平台管理员')
    await waitForCondition(() => root.textContent?.includes('不能取消最后一名平台管理员') ?? false)
    const outcome = `${root.querySelector('.user-admin__status')?.textContent || ''} ${root.querySelector('[data-testid="role-action-feedback"]')?.textContent || ''}`
    expect(outcome).toContain('不能取消最后一名平台管理员')
    expect(outcome).not.toContain('已撤销')
    expect(outcome).not.toContain('Cannot remove the last platform administrator')
    expect(root.querySelector('[data-testid="user-access-unread"]')).toBeTruthy()
  })

  it('shows an unknown inherited list when unassigning a role the catalog does not describe', async () => {
    install({
      users: [
        { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'admin', is_active: true, is_admin: true },
      ],
      roleItems: [
        {
          id: 'crm_admin',
          name: 'CRM 管理员',
          memberCount: 1,
          permissions: ['crm:read'],
          updatedAt: '2026-11-01T00:00:00.000Z',
          admissionNamespaces: ['stock-prep'],
        },
      ],
    })
    const root = await mount()
    await openListedUser(root, 'Alpha')
    const revoke = root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement
    expect(revoke.disabled).toBe(false)
    revoke.click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="admin-authorization-dialog"]')))
    const inherited = root.querySelector('[data-testid="admin-authorization-inherited-permissions"]')
    expect(inherited?.textContent).toContain('角色目录没有这份角色，不能把缺失列表当作没有继承权限。')
    expect(inherited?.textContent).not.toContain('无')
    const confirm = root.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(postCalls().some((call) => call.url.includes('/roles/unassign'))).toBe(false)
    await confirmAdminAuthorization(root, '取消平台管理员')
    await waitForCondition(() => postCalls().some((call) => call.url.includes('/roles/unassign')))
    expect(postCalls().find((call) => call.url.includes('/roles/unassign'))?.body).toEqual({ roleId: 'admin' })
  })

  it('does not present a malformed catalog permission list as an empty inherited list', async () => {
    install({
      users: [
        { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'admin', is_active: true, is_admin: true },
      ],
      roleItems: [
        {
          id: 'admin',
          name: '平台管理员',
          memberCount: 1,
          permissions: ['crm:read', 1],
          updatedAt: '2026-11-01T00:00:00.000Z',
          admissionNamespaces: [],
        },
      ],
    })
    const root = await mount()
    await openListedUser(root, 'Alpha')
    ;(root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="admin-authorization-dialog"]')))
    const inherited = root.querySelector('[data-testid="admin-authorization-inherited-permissions"]')
    expect(inherited?.textContent).toContain('角色目录没有这份角色，不能把缺失列表当作没有继承权限。')
    expect(inherited?.textContent).not.toContain('无')
    expect(inherited?.textContent).not.toContain('crm:read')
    await confirmAdminAuthorization(root, '取消平台管理员')
    await waitForCondition(() => postCalls().some((call) => call.url.includes('/roles/unassign')))
    expect(postCalls().find((call) => call.url.includes('/roles/unassign'))?.body).toEqual({ roleId: 'admin' })
  })

  function batchCreatePosts(): Array<{ url: string; body: Record<string, unknown> }> {
    return postCalls().filter((call) => call.url === '/api/admin/users/batch/create')
  }

  function allowBatchCreate(): void {
    const base = apiFetchMock.getMockImplementation()
    if (!base) throw new Error('api mock missing')
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (url.pathname === '/api/admin/users/batch/create' && method === 'POST') {
        const parsed = JSON.parse(String(init?.body || '{}')) as { items?: Array<Record<string, unknown>> }
        const items = Array.isArray(parsed.items) ? parsed.items : []
        return createJsonResponse({
          ok: true,
          data: {
            successCount: items.length,
            failureCount: 0,
            results: items.map((item, index) => ({
              index,
              ok: true,
              email: typeof item.email === 'string' ? item.email : '',
              temporaryPassword: 'Temp#123456',
              message: 'ok',
            })),
          },
        })
      }
      return base(input, init)
    })
  }

  async function uploadCsv(root: HTMLElement, testId: string, csv: string, fileName: string): Promise<void> {
    const input = root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)
    if (!input) throw new Error(`File input not found: ${testId}`)
    const file = new File([csv], fileName, { type: 'text/csv' })
    if (typeof file.text !== 'function') {
      Object.defineProperty(file, 'text', { value: async () => csv })
    }
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(12)
  }

  function deferredCsvFile(csv: string, fileName: string): { file: File; release: () => void; fail: (error?: Error) => void } {
    let resolveText: (value: string) => void = () => {}
    let rejectText: (error: Error) => void = () => {}
    const pending = new Promise<string>((resolve, reject) => {
      resolveText = resolve
      rejectText = reject
    })
    const file = new File([csv], fileName, { type: 'text/csv' })
    Object.defineProperty(file, 'text', { configurable: true, value: () => pending })
    return {
      file,
      release: () => resolveText(csv),
      fail: (error?: Error) => rejectText(error ?? new Error('读取文件失败')),
    }
  }

  async function chooseImportFile(root: HTMLElement, file: File): Promise<void> {
    const input = root.querySelector<HTMLInputElement>('[data-testid="batch-import-file"]')
    if (!input) throw new Error('File input not found: batch-import-file')
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
  }

  async function setPasteEmails(root: HTMLElement, value: string): Promise<void> {
    const input = root.querySelector('textarea[aria-label="粘贴多个邮箱"]')
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('paste box missing')
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
  }

  async function setPasteRole(root: HTMLElement, roleId: string): Promise<void> {
    const select = root.querySelector('select[aria-label="粘贴邀请角色"]')
    if (!(select instanceof HTMLSelectElement)) throw new Error('paste role missing')
    select.value = roleId
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
  }

  it('cancels an import preview and drops it when the file or rows change before any create', async () => {
    install()
    allowBatchCreate()
    const root = await mount()
    const csv = 'name,email,roleId,department\n林岚,lin@example.com,crm_admin,装配\n'
    await uploadCsv(root, 'batch-import-file', csv, 'create.csv')
    findButtonByText(root, '确认导入').click()
    await flushUi()
    const preview = root.querySelector('[data-testid="batch-create-preview"]')
    expect(preview?.textContent).toContain('crm:read')
    expect(preview?.textContent).toContain('不写入直接权限')
    expect(preview?.textContent).toContain('默认都不开通')
    expect(root.querySelector('[data-testid="batch-create-platform-admin"]')).toBeNull()
    ;(root.querySelector('[data-testid="batch-create-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(batchCreatePosts()).toEqual([])

    findButtonByText(root, '确认导入').click()
    await flushUi()
    const confirm = root.querySelector('[data-testid="batch-create-confirm"]') as HTMLButtonElement
    await uploadCsv(root, 'batch-import-file', csv, 'create-again.csv')
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    confirm.click()
    await flushUi()
    expect(batchCreatePosts()).toEqual([])

    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-target"]')?.textContent).toContain('lin@example.com')
    await uploadCsv(root, 'batch-import-file', 'name,email,roleId,department\n周宁,zhou@example.com,crm_admin,财务\n', 'other.csv')
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(root.textContent).toContain('zhou@example.com')
    expect(batchCreatePosts()).toEqual([])
  })

  it('posts the frozen import rows only after confirmation and then clears temporary passwords', async () => {
    install()
    allowBatchCreate()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const root = await mount()
      await uploadCsv(root, 'batch-import-file', 'name,email,roleId,department\n林岚,lin@example.com,crm_admin,装配\n', 'create.csv')
      findButtonByText(root, '确认导入').click()
      await flushUi()
      expect(batchCreatePosts()).toEqual([])
      const confirm = root.querySelector('[data-testid="batch-create-confirm"]') as HTMLButtonElement
      expect(confirm.disabled).toBe(false)
      confirm.click()
      confirm.click()
      await waitForCondition(() => root.textContent?.includes('Temp#123456') === true)
      expect(batchCreatePosts()).toEqual([{
        url: '/api/admin/users/batch/create',
        body: { items: [{ name: '林岚', email: 'lin@example.com', roleId: 'crm_admin', department: '装配' }] },
      }])
      ;(root.querySelector('[data-testid="copy-batch-passwords"]') as HTMLButtonElement).click()
      await waitForCondition(() => root.textContent?.includes('临时密码已复制，并从页面上清除') === true)
      expect(root.querySelector('[data-testid="batch-temporary-passwords"]')).toBeNull()
      expect(root.textContent).not.toContain('Temp#123456')
      expect(writeText).toHaveBeenCalledWith('lin@example.com\tTemp#123456')
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('cancels a paste preview and drops it when the emails or role change before any create', async () => {
    install()
    allowBatchCreate()
    const root = await mount()
    await setPasteEmails(root, 'a@example.com, b@example.com')
    await setPasteRole(root, 'crm_admin')
    findButtonByText(root, '邀请这些邮箱').click()
    await flushUi()
    expect(root.querySelectorAll('[data-testid="batch-create-target"]')).toHaveLength(2)
    expect(root.querySelector('[data-testid="batch-create-effects"]')?.textContent).toContain('直接权限：无')
    ;(root.querySelector('[data-testid="batch-create-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(batchCreatePosts()).toEqual([])

    findButtonByText(root, '邀请这些邮箱').click()
    await flushUi()
    await setPasteEmails(root, 'c@example.com')
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(batchCreatePosts()).toEqual([])

    findButtonByText(root, '邀请这些邮箱').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-target"]')?.textContent).toContain('c@example.com')
    await setPasteRole(root, 'admin')
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(batchCreatePosts()).toEqual([])
  })

  it('requires confirmation before a pasted admin invite and posts only the frozen email and role', async () => {
    install()
    allowBatchCreate()
    const root = await mount()
    await setPasteEmails(root, 'Admin-Invite@example.com')
    await setPasteRole(root, 'admin')
    findButtonByText(root, '邀请这些邮箱').click()
    await flushUi()
    expect(batchCreatePosts()).toEqual([])
    const target = root.querySelector('[data-testid="batch-create-target"]')
    expect(target?.textContent).toContain('admin-invite@example.com')
    expect(target?.textContent).toContain('角色继承权限：无')
    expect(target?.textContent).not.toContain('角色目录没有这份角色')
    expect(root.querySelector('[data-testid="batch-create-platform-admin"]')?.textContent).toContain('平台管理员拥有平台管理权限')
    expect(root.querySelector('[data-testid="batch-create-effects"]')?.textContent).toContain('插件使用默认都不开通')
    ;(root.querySelector('[data-testid="batch-create-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => batchCreatePosts().length === 1)
    expect(batchCreatePosts()).toEqual([{
      url: '/api/admin/users/batch/create',
      body: { items: [{ email: 'admin-invite@example.com', roleId: 'admin' }] },
    }])
  })

  it('says inherited permissions are unknown when a batch role has no honest catalog list', async () => {
    install({
      roleItems: [
        { id: 'gap', name: '缺口角色', memberCount: 0 },
        { id: 'crm_admin', name: 'CRM 管理员', memberCount: 1, permissions: ['crm:read', 1], admissionNamespaces: [] },
      ],
    })
    allowBatchCreate()
    const root = await mount()
    await uploadCsv(
      root,
      'batch-import-file',
      'name,email,roleId,department\n林岚,lin@example.com,gap,装配\n周宁,zhou@example.com,crm_admin,财务\n',
      'gaps.csv',
    )
    findButtonByText(root, '确认导入').click()
    await flushUi()
    const targets = Array.from(root.querySelectorAll('[data-testid="batch-create-target"]'))
    expect(targets).toHaveLength(2)
    expect(targets[0]?.textContent).toContain('角色目录没有这份角色，不能把缺失列表当作没有继承权限。')
    expect(targets[0]?.textContent).not.toContain('角色继承权限：无')
    expect(targets[1]?.textContent).toContain('角色目录没有这份角色，不能把缺失列表当作没有继承权限。')
    expect(targets[1]?.textContent).not.toContain('crm:read')
    expect(batchCreatePosts()).toEqual([])
  })

  it('drops a frozen paste preview when the role catalog changes and sends no create', async () => {
    install()
    allowBatchCreate()
    const base = apiFetchMock.getMockImplementation()
    if (!base) throw new Error('api mock missing')
    let permissions = ['crm:read']
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/admin/roles') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [{
              id: 'crm_admin',
              name: 'CRM 管理员',
              memberCount: 1,
              permissions: [...permissions],
              updatedAt: '2026-11-01T00:00:00.000Z',
              admissionNamespaces: [],
            }],
          },
        })
      }
      return base(input, init)
    })
    const root = await mount()
    await setPasteEmails(root, 'a@example.com')
    await setPasteRole(root, 'crm_admin')
    findButtonByText(root, '邀请这些邮箱').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-target"]')?.textContent).toContain('crm:read')
    permissions = ['crm:write']
    await openListedUser(root, 'Alpha')
    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    await confirmAdminAuthorization(root)
    await waitForCondition(() => root.querySelector('[data-testid="batch-create-preview"]') === null)
    expect(batchCreatePosts()).toEqual([])
    expect(postCalls().some((call) => call.url.includes('/roles/assign'))).toBe(true)
  })

  it('sends no batch create when the server has no explicit admission capability', async () => {
    let releasePresets: (() => void) | null = null
    let presetsSettled = false
    let explicitCapability: boolean | null = null
    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method || 'GET').toUpperCase()
      if (url.pathname === '/api/admin/access-presets') {
        if (!presetsSettled) {
          await new Promise<void>((resolve) => {
            releasePresets = () => {
              presetsSettled = true
              resolve()
            }
          })
        }
        const payload: Record<string, unknown> = { ok: true, data: { items: [] } }
        if (explicitCapability !== null) payload.capabilities = { explicitNamespaceAdmission: explicitCapability }
        return createJsonResponse(payload)
      }
      if (url.pathname === '/api/admin/roles') {
        return createJsonResponse({
          ok: true,
          data: { items: [{ id: 'crm_admin', name: 'CRM 管理员', memberCount: 1, permissions: ['crm:read'], admissionNamespaces: [] }] },
        })
      }
      if (url.pathname === '/api/admin/users' && method === 'GET') {
        return createJsonResponse({ ok: true, data: { items: [], total: 0 } })
      }
      if (url.pathname === '/api/admin/users/batch/create' && method === 'POST') {
        return createJsonResponse({ ok: true, data: { successCount: 1, failureCount: 0, results: [] } })
      }
      if (method === 'GET') return createJsonResponse({ ok: true, data: { items: [] } })
      return createJsonResponse({ ok: false, error: { message: 'unexpected' } }, 500)
    })
    const root = await mount()
    await uploadCsv(root, 'batch-import-file', 'name,email,roleId,department\n林岚,lin@example.com,crm_admin,装配\n', 'create.csv')
    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(root.querySelector('[data-testid="namespace-admission-capability"]')).toBeNull()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(root.textContent).not.toContain('已暂停创建')
    expect(batchCreatePosts()).toEqual([])

    releasePresets?.()
    await waitForCondition(() => root.querySelector('[data-testid="namespace-admission-capability"]')?.textContent?.includes('已暂停创建') === true)
    findButtonByText(root, '确认导入').click()
    await flushUi()
    await setPasteEmails(root, 'a@example.com')
    findButtonByText(root, '邀请这些邮箱').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(root.querySelector('p.user-admin__status')?.textContent).toContain('已暂停创建')
    expect(root.querySelector('[data-testid="retry-access-presets"]')).toBeTruthy()
    expect(batchCreatePosts()).toEqual([])

    explicitCapability = false
    ;(root.querySelector('[data-testid="retry-access-presets"]') as HTMLButtonElement).click()
    await flushUi(12)
    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(batchCreatePosts()).toEqual([])

    explicitCapability = true
    ;(root.querySelector('[data-testid="retry-access-presets"]') as HTMLButtonElement).click()
    await waitForCondition(() => !findButtonByText(root, '创建用户').disabled)
    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeTruthy()
    expect(batchCreatePosts()).toEqual([])
    ;(root.querySelector('[data-testid="batch-create-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => batchCreatePosts().length === 1)
    expect(batchCreatePosts()[0]?.body).toEqual({
      items: [{ name: '林岚', email: 'lin@example.com', roleId: 'crm_admin', department: '装配' }],
    })
  })

  it('does not preview or write the previous import while the next file is still reading', async () => {
    install()
    allowBatchCreate()
    const root = await mount()
    await uploadCsv(root, 'batch-import-file', 'name,email,roleId,department\n林岚,import-a@example.com,crm_admin,装配\n', 'a.csv')
    expect(root.textContent).toContain('import-a@example.com')
    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-target"]')?.textContent).toContain('import-a@example.com')

    const pending = deferredCsvFile('name,email,roleId,department\n周宁,import-b@example.com,crm_admin,财务\n', 'b.csv')
    await chooseImportFile(root, pending.file)
    expect(root.textContent).not.toContain('import-a@example.com')
    expect(root.textContent).not.toContain('import-b@example.com')
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(findButtonByText(root, '确认导入').disabled).toBe(true)
    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(batchCreatePosts()).toEqual([])

    pending.release()
    await waitForCondition(() => root.textContent?.includes('import-b@example.com') === true)
    expect(root.textContent).not.toContain('import-a@example.com')
    expect(findButtonByText(root, '确认导入').disabled).toBe(false)
    expect(batchCreatePosts()).toEqual([])
  })

  it('keeps the faster import when an earlier file read finishes later', async () => {
    install()
    allowBatchCreate()
    const root = await mount()
    const slowA = deferredCsvFile('name,email,roleId,department\n林岚,import-a@example.com,crm_admin,装配\n', 'a.csv')
    const fastB = deferredCsvFile('name,email,roleId,department\n周宁,import-b@example.com,crm_admin,财务\n', 'b.csv')
    await chooseImportFile(root, slowA.file)
    await chooseImportFile(root, fastB.file)
    fastB.release()
    await waitForCondition(() => root.textContent?.includes('import-b@example.com') === true)
    expect(root.textContent).not.toContain('import-a@example.com')
    findButtonByText(root, '确认导入').click()
    await flushUi()
    ;(root.querySelector('[data-testid="batch-create-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => root.textContent?.includes('Temp#123456') === true)
    expect(batchCreatePosts()).toEqual([{
      url: '/api/admin/users/batch/create',
      body: { items: [{ name: '周宁', email: 'import-b@example.com', roleId: 'crm_admin', department: '财务' }] },
    }])

    slowA.release()
    await flushUi(12)
    expect(root.textContent).toContain('import-b@example.com')
    expect(root.textContent).not.toContain('import-a@example.com')
    expect(root.textContent).toContain('Temp#123456')
    expect(batchCreatePosts()).toHaveLength(1)
  })

  it('drops the previous import rows when the current file cannot be read', async () => {
    install()
    allowBatchCreate()
    const root = await mount()
    await uploadCsv(root, 'batch-import-file', 'name,email,roleId,department\n林岚,import-a@example.com,crm_admin,装配\n', 'a.csv')
    expect(root.textContent).toContain('import-a@example.com')
    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeTruthy()

    const broken = deferredCsvFile('name,email,roleId,department\n周宁,import-b@example.com,crm_admin,财务\n', 'b.csv')
    await chooseImportFile(root, broken.file)
    expect(root.textContent).not.toContain('import-a@example.com')
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    broken.fail(new Error('读取文件失败'))
    await waitForCondition(() => root.querySelector('p.user-admin__status')?.textContent?.includes('读取文件失败') === true)
    expect(root.textContent).not.toContain('import-a@example.com')
    expect(root.textContent).not.toContain('import-b@example.com')
    expect(root.querySelector('[data-testid="batch-create-preview"]')).toBeNull()
    expect(findButtonByText(root, '确认导入').disabled).toBe(true)
    findButtonByText(root, '确认导入').click()
    await flushUi()
    expect(batchCreatePosts()).toEqual([])
  })
})
