/* eslint-disable vue/one-component-per-file -- Tests mount isolated apps with local component stubs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import RoleDelegationView from '../src/views/RoleDelegationView.vue'
import {
  ADMIN_AUTHORIZATION_OPERATIONS_PATH,
  ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY,
  ADMIN_AUTHORIZATION_PREVIEW_PATH,
  type AdminAuthorizationImpact,
} from '../src/utils/adminAuthorizationOperation'

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => ({ id: 'admin-1' }),
  }),
}))

const apiFetchMock = vi.fn()

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

function blankImpact(partial: Partial<AdminAuthorizationImpact> = {}): AdminAuthorizationImpact {
  return {
    sourceChanges: [],
    admissionChanges: [],
    scopeCleanup: [],
    effectiveBefore: [],
    effectiveAfter: [],
    retainedOtherGrants: [],
    warnings: [],
    ...partial,
  }
}

function authorizationPreviewResponse(impact: AdminAuthorizationImpact = blankImpact()) {
  return createJsonResponse({ expectedVersion: 'version-1', impact })
}

function readAuthorizationBody(body: string | undefined): {
  targetUserId: string
  action: { kind: string; roleId?: string }
  admissionChanges: Array<{ namespace: string; enabled: boolean }>
  clientOperationId: string
  expectedVersion?: string
} {
  return JSON.parse(String(body)) as {
    targetUserId: string
    action: { kind: string; roleId?: string }
    admissionChanges: Array<{ namespace: string; enabled: boolean }>
    clientOperationId: string
    expectedVersion?: string
  }
}

function authorizationCommitResponse(body: string | undefined, impact: AdminAuthorizationImpact = blankImpact()) {
  const request = readAuthorizationBody(body)
  return createJsonResponse({
    status: 'committed',
    clientOperationId: request.clientOperationId,
    receipt: {
      targetUserId: request.targetUserId,
      action: request.action,
      impact,
      resultVersion: 'result-1',
    },
  })
}

function isAuthorizationPreview(pathname: string): boolean {
  return pathname === ADMIN_AUTHORIZATION_PREVIEW_PATH
}

function isAuthorizationCommit(pathname: string): boolean {
  return pathname === ADMIN_AUTHORIZATION_OPERATIONS_PATH
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

function createApiImplementation(callLog: string[]) {
  let crmAdmissionEnabled = false
  return async (input: unknown, init?: { method?: string; body?: string }) => {
    const rawUrl = String(input)
    callLog.push(rawUrl)
    const url = new URL(rawUrl, 'http://localhost')
    const pathname = url.pathname
    const q = url.searchParams.get('q') || ''

    if (pathname === '/api/admin/role-delegation/summary') {
      return createJsonResponse({
        ok: true,
        data: {
          actorId: 'admin-1',
          isPlatformAdmin: true,
          delegableNamespaces: [],
          roleCatalog: [],
          scopeAssignments: [],
          groupAssignments: [],
        },
      })
    }

    if (pathname === '/api/admin/role-delegation/departments') {
      return createJsonResponse({
        ok: true,
        data: { items: [] },
      })
    }

    if (pathname === '/api/admin/role-delegation/member-groups') {
      return createJsonResponse({
        ok: true,
        data: {
          items: q === 'does-not-exist'
            ? []
            : [{
              id: 'group-1',
              name: '制造中心',
              description: '制造中心成员集',
              createdBy: 'admin-1',
              updatedBy: 'admin-1',
              createdAt: '2026-04-09T00:00:00.000Z',
              updatedAt: '2026-04-09T00:00:00.000Z',
              memberCount: 1,
            }],
        },
      })
    }

    if (pathname === '/api/admin/role-delegation/member-groups/group-1') {
      return createJsonResponse({
        ok: true,
        data: {
          item: {
            id: 'group-1',
            name: '制造中心',
            description: '制造中心成员集',
            createdBy: 'admin-1',
            updatedBy: 'admin-1',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            memberCount: 1,
            members: [],
          },
        },
      })
    }

    if (pathname === '/api/admin/role-delegation/scope-templates') {
      return createJsonResponse({
        ok: true,
        data: {
          items: q === 'empty-template'
            ? []
            : [{
              id: 'template-1',
              name: '华东销售',
              description: '华东销售模板',
              createdBy: 'admin-1',
              updatedBy: 'admin-1',
              createdAt: '2026-04-09T00:00:00.000Z',
              updatedAt: '2026-04-09T00:00:00.000Z',
              departmentCount: 0,
              memberGroupCount: 0,
            }],
        },
      })
    }

    if (pathname === '/api/admin/role-delegation/scope-templates/template-1') {
      return createJsonResponse({
        ok: true,
        data: {
          item: {
            id: 'template-1',
            name: '华东销售',
            description: '华东销售模板',
            createdBy: 'admin-1',
            updatedBy: 'admin-1',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
            departmentCount: 0,
            memberGroupCount: 0,
            departments: [],
            memberGroups: [],
          },
        },
      })
    }

    if (pathname === '/api/admin/role-delegation/users') {
      return createJsonResponse({
        ok: true,
        data: {
          items: q === 'nobody'
            ? []
            : [{
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
              role: 'user',
              is_active: true,
            }],
        },
      })
    }

    if (pathname === '/api/admin/role-delegation/users/user-1/access') {
      return createJsonResponse({
        ok: true,
        data: {
          actorId: 'admin-1',
          isPlatformAdmin: true,
          delegableNamespaces: [],
          roleCatalog: [],
          scopeAssignments: [],
          groupAssignments: [],
          user: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
          },
          roles: [],
          memberGroups: [],
          delegableRoles: [],
          namespaceAdmissions: [
            {
              namespace: 'crm',
              enabled: crmAdmissionEnabled,
              effective: crmAdmissionEnabled,
              hasRole: true,
              updatedAt: crmAdmissionEnabled ? '2026-04-10T00:00:00.000Z' : '2026-04-09T00:00:00.000Z',
            },
          ],
        },
      })
    }

    if (isAuthorizationPreview(pathname) && init?.method === 'POST') {
      return authorizationPreviewResponse()
    }

    if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
      const request = readAuthorizationBody(init.body)
      const change = request.admissionChanges[0]
      if (request.action.kind === 'admission.set' && change) crmAdmissionEnabled = change.enabled
      return authorizationCommitResponse(init.body)
    }

    if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
      return createJsonResponse({
        ok: true,
        data: {
          actorId: 'admin-1',
          user: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
          },
          adminNamespaces: ['crm'],
          scopeAssignments: [],
          groupAssignments: [],
        },
      })
    }

    throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
  }
}

describe('RoleDelegationView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let callLog: string[] = []

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    sessionStorage.removeItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)
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
    window.history.replaceState({}, '', '/')
  })

  function listedMemberButton(label: string): HTMLButtonElement | null {
    const button = Array.from(container!.querySelectorAll('button.delegation-page__user')).find((node) => (
      node instanceof HTMLButtonElement && (node.textContent || '').includes(label)
    ))
    return button instanceof HTMLButtonElement ? button : null
  }

  async function selectListedMember(label: string): Promise<void> {
    await waitForCondition(() => {
      const button = listedMemberButton(label)
      return Boolean(button && !button.disabled)
    })
    listedMemberButton(label)?.click()
  }

  async function waitForMemberListSettled(callsBefore = 0): Promise<void> {
    await waitForCondition(() => {
      const requested = callLog.slice(callsBefore).some((url) => {
        try {
          return new URL(url, 'http://localhost').pathname === '/api/admin/role-delegation/users'
        } catch {
          return false
        }
      })
      const loading = Array.from(container!.querySelectorAll('button')).some((button) => button.textContent?.includes('加载中'))
      return requested && !loading
    })
  }

  async function mountView(): Promise<void> {
    app = createApp(RoleDelegationView)
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="scope-include-children"]')))
  }

  it('clears stale selected member group after searching to an empty result set', async () => {
    await mountView()

    const searchInput = container?.querySelector('input[placeholder="搜索成员集"]')
    expect(searchInput).toBeTruthy()
    ;(searchInput as HTMLInputElement).value = 'does-not-exist'
    searchInput?.dispatchEvent(new Event('input'))
    await flushUi()

    findButtonByText(container!, '查询成员集').click()
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/role-delegation/member-groups?q=does-not-exist')))

    const assignButton = findButtonByText(container!, '将当前成员加入成员集')
    expect(assignButton.disabled).toBe(true)
    expect(container?.textContent).not.toContain('制造中心成员集')
  })

  it('clears stale selected scope template after searching to an empty result set', async () => {
    await mountView()

    const searchInput = container?.querySelector('input[placeholder="搜索模板"]')
    expect(searchInput).toBeTruthy()
    ;(searchInput as HTMLInputElement).value = 'empty-template'
    searchInput?.dispatchEvent(new Event('input'))
    await flushUi()

    findButtonByText(container!, '查询模板').click()
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/role-delegation/scope-templates?q=empty-template')))

    const applyButton = findButtonByText(container!, '覆盖应用到当前命名空间')
    expect(applyButton.disabled).toBe(true)
    expect(container?.textContent).not.toContain('华东销售模板')
  })

  it('clears stale selected user after filtering to an empty result set', async () => {
    await mountView()

    const searchInput = container?.querySelector('input[placeholder="搜索邮箱、姓名或用户 ID"]')
    expect(searchInput).toBeTruthy()
    ;(searchInput as HTMLInputElement).value = 'nobody'
    searchInput?.dispatchEvent(new Event('input'))
    await flushUi()

    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/role-delegation/users?q=nobody')))

    expect(container?.textContent).toContain('请选择一个成员')
    expect(container?.textContent).not.toContain('alpha@example.com')
  })

  it('revokes from the server\'s revocable list (delegableRoles), not from the assignable catalog', async () => {
    // A delegate may REVOKE a role it may not ASSIGN (a role carrying ordinary codes outside its
    // namespace — e.g. `plugin_elearning_viewer` for an e-learning delegate). The server answers the
    // two sets separately; the revoke control must offer the revocable one.
    const catalog = [{ id: 'attendance_employee', name: '考勤员工', permissions: ['attendance:read'] }]
    const delegateAccess = (delegableRoles: string[]) => ({
      actorId: 'delegate-1',
      isPlatformAdmin: false,
      delegableNamespaces: ['attendance'],
      roleCatalog: catalog,
      scopeAssignments: [],
      groupAssignments: [],
      user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
      roles: delegableRoles,
      memberGroups: [],
      delegableRoles,
      namespaceAdmissions: [],
    })
    let access = delegateAccess(['attendance_employee', 'plugin_elearning_viewer'])
    const posts: Array<{ path: string; body: unknown }> = []
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['attendance'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({ ok: true, data: access })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        posts.push({ path: pathname, body: JSON.parse(String(init.body)) })
        access = delegateAccess(['attendance_employee'])
        return authorizationCommitResponse(init.body)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })

    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('select[data-testid="delegation-revoke-role"] option[value="plugin_elearning_viewer"]')))

    const optionValues = (testId: string) => Array.from(
      container!.querySelectorAll(`select[data-testid="${testId}"] option`),
    ).map((option) => (option as HTMLOptionElement).value)
    expect(optionValues('delegation-assign-role')).toEqual(['', 'attendance_employee'])
    expect(optionValues('delegation-revoke-role')).toEqual(['', 'attendance_employee', 'plugin_elearning_viewer'])

    const revokeButton = findButtonByText(container!, '撤销角色')
    const assignButton = findButtonByText(container!, '分配角色')
    expect(revokeButton.disabled).toBe(true)

    const revokeSelect = container!.querySelector('select[data-testid="delegation-revoke-role"]') as HTMLSelectElement
    revokeSelect.value = 'plugin_elearning_viewer'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(revokeButton.disabled).toBe(false)
    // Picking a role to revoke does not arm the assign button with it.
    expect(assignButton.disabled).toBe(true)

    // BOTH dropdowns hold a pick: the revoke button must still send the REVOKE pick, never the
    // assign one (a single shared selection is the defect this split exists to remove).
    const assignSelect = container!.querySelector('select[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'attendance_employee'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(assignButton.disabled).toBe(false)
    expect(revokeSelect.value).toBe('plugin_elearning_viewer')

    revokeButton.click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation-permissions-empty"]')?.textContent).toContain('目录未提供权限码')
    expect(container?.querySelector('[data-testid="delegation-confirmation-typed"]')).toBeNull()
    expect(container?.textContent).toContain('命名空间准入')
    expect(container?.textContent).toContain('直接权限码')
    expect(container?.textContent).not.toContain('如果该角色包含平台管理员')
    expect(container?.textContent).not.toContain('冻结')
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirm.disabled === false)
    confirm.click()
    await waitForCondition(() => posts.length === 1)
    expect(posts[0]?.path).toBe(ADMIN_AUTHORIZATION_OPERATIONS_PATH)
    expect(posts[0]?.body).toMatchObject({
      targetUserId: 'user-1',
      action: { kind: 'role.revoke', roleId: 'plugin_elearning_viewer' },
      admissionChanges: [],
      expectedVersion: 'version-1',
    })
    await waitForCondition(() => !optionValues('delegation-revoke-role').includes('plugin_elearning_viewer'))
    await flushUi()
    expect(revokeSelect.value).toBe('')
    // The revoked pick is cleared, not merely hidden: the button cannot re-send it.
    expect(revokeButton.disabled).toBe(true)
    expect(container?.textContent).toContain('角色已从该成员移除')
  })

  it('shows namespace admission controls for delegated members and can toggle plugin usage', async () => {
    await mountView()

    expect(container?.textContent).toContain('插件使用准入')
    expect(container?.textContent).toContain('插件使用未开通')
    expect(container?.textContent).toContain('当前不可用')

    findButtonByText(container!, '开通插件使用').click()
    await flushUi()
    const confirmAdmission = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirmAdmission.disabled === false)
    confirmAdmission.click()
    await waitForCondition(() => (container?.textContent || '').includes('已开通 crm 插件使用'))

    expect(container?.textContent).toContain('当前实际可用')
    expect(callLog.some((url) => url.includes(ADMIN_AUTHORIZATION_OPERATIONS_PATH) && !url.includes('/preview'))).toBe(true)
  })

  it('explains management scope without treating plugin admission as a delegate prerequisite', async () => {
    await mountView()
    const explanation = container?.querySelector('[data-testid="scope-explanation"]')?.textContent || ''
    expect(explanation).toContain('部门范围可以选择是否包含下级部门')
    expect(explanation).not.toContain('部门范围包含该部门及其下级')
    expect(explanation).toContain('共享成员组')
    expect(explanation).toContain('同一命名空间内')
    expect(explanation).toContain('取并集')
    expect(explanation).toContain('平台管理员配置管理范围')
    expect(explanation).toContain('只能给允许的成员分配允许的角色')
    expect(explanation).toContain('插件使用准入不是管理委派的前提')
    expect(container?.textContent).not.toContain('必须开通插件')
    expect(container?.textContent).not.toContain('没有新的范围类型')
    expect(container?.textContent).not.toContain('私有圈定')
    expect(container?.textContent).not.toContain('单个成员 ID')
    expect(container?.textContent).not.toContain('中文名只用于阅读')

  })

  it('consumes the requested userId and ignores a stale access response', async () => {
    window.history.replaceState({}, '', '/admin/role-delegation?userId=user-2&source=members#scope')
    let releaseUser2: (() => void) | undefined
    const user2Gate = new Promise<void>((resolve) => {
      releaseUser2 = resolve
    })
    const accessFor = (id: string, name: string, email: string) => ({
      actorId: 'admin-1',
      isPlatformAdmin: true,
      delegableNamespaces: [],
      roleCatalog: [],
      scopeAssignments: [],
      groupAssignments: [],
      user: { id, email, name, role: 'user', is_active: true },
      roles: [],
      memberGroups: [],
      delegableRoles: [],
      namespaceAdmissions: [],
    })
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [], scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (
        pathname === '/api/admin/role-delegation/departments'
        || pathname === '/api/admin/role-delegation/member-groups'
        || pathname === '/api/admin/role-delegation/scope-templates'
      ) {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/access') {
        await user2Gate
        return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', 'bravo@example.com') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({ ok: true, data: accessFor('user-1', 'Alpha', 'alpha@example.com') })
      }
      if (pathname.endsWith('/scopes')) {
        const id = pathname.includes('user-2') ? 'user-2' : 'user-1'
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id, email: `${id}@example.com`, name: id, role: 'user', is_active: true },
            adminNamespaces: [],
            scopeAssignments: [],
            groupAssignments: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })

    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/role-delegation/users/user-2/access')))
    expect(callLog.some((url) => url.includes('/api/admin/role-delegation/users/user-1/access'))).toBe(false)

    const alpha = Array.from(container!.querySelectorAll('.delegation-page__user')).find((button) => button.textContent?.includes('Alpha'))
    expect(alpha).toBeTruthy()
    ;(alpha as HTMLButtonElement).click()
    await waitForCondition(() => (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Alpha'))
    releaseUser2?.()
    await flushUi(8)

    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Alpha')
    expect(container?.querySelector('.delegation-page__panel--detail')?.textContent).not.toContain('Bravo')
    expect(container?.querySelector('.delegation-page__user--active')?.textContent).toContain('Alpha')
    expect(window.location.search).toContain('userId=user-2')
    expect(window.location.search).toContain('source=members')
    expect(window.location.hash).toBe('#scope')
  })

  it.each([false, true])('refresh keeps an outside-list linked member even when its read fails (%s)', async (failRefresh) => {
    const location = '/admin/role-delegation?userId=user-41&source=members#scope'
    window.history.replaceState({}, '', location)
    const baseApi = createApiImplementation(callLog)
    let targetReads = 0
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const path = String(input)
      if (path === '/api/admin/role-delegation/users/user-41/access') {
        callLog.push(path)
        targetReads += 1
        if (failRefresh && targetReads === 2) {
          return createJsonResponse({ ok: false, error: { message: 'Target unavailable' } }, 403)
        }
        return createJsonResponse({ ok: true, data: {
          user: { id: 'user-41', name: 'Linked member', email: 'linked@example.invalid', role: 'user', is_active: true },
          roles: [], memberGroups: [], delegableRoles: [], roleCatalog: [], namespaceAdmissions: [],
        } })
      }
      if (path === '/api/admin/role-delegation/users/user-41/scopes') {
        callLog.push(path)
        return createJsonResponse({ ok: true, data: {
          user: { id: 'user-41' }, adminNamespaces: [], scopeAssignments: [], groupAssignments: [],
        } })
      }
      return baseApi(input)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await waitForCondition(() => callLog.includes('/api/admin/role-delegation/users/user-41/scopes'))
    await flushUi()
    expect(container!.querySelector('.delegation-page__detail-head')?.textContent).toContain('Linked member')
    expect(container!.querySelector('.delegation-page__user')?.textContent).toContain('Alpha')

    findButtonByText(container!, '查询').click()
    await waitForCondition(() => targetReads === 2)
    await flushUi()
    expect(callLog).not.toContain('/api/admin/role-delegation/users/user-1/access')
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(location)
    if (failRefresh) {
      expect(container!.querySelector('.delegation-page__detail-head')).toBeNull()
      expect(container!.querySelector('[data-testid="delegation-assign-role"]')).toBeNull()
      expect(container!.textContent).toContain('Target unavailable')
      findButtonByText(container!, '查询').click()
      await waitForCondition(() => targetReads === 3)
      await flushUi()
    }
    expect(container!.querySelector('.delegation-page__detail-head')?.textContent).toContain('Linked member')
    expect(apiFetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('clears the previous member and blocks assignment while the next access read is delayed', async () => {
    let releaseBravo: (() => void) | undefined
    const bravoGate = new Promise<void>((resolve) => {
      releaseBravo = resolve
    })
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:admin'] }]
    const accessFor = (id: string, name: string, email: string) => ({
      actorId: 'admin-1',
      isPlatformAdmin: true,
      delegableNamespaces: ['crm'],
      roleCatalog: catalog,
      scopeAssignments: [],
      groupAssignments: [],
      user: { id, email, name, role: 'user', is_active: true },
      roles: [],
      memberGroups: [],
      delegableRoles: [],
      namespaceAdmissions: [],
    })
    const scopesFor = (id: string) => ({
      actorId: 'admin-1',
      user: { id, email: `${id}@example.com`, name: id, role: 'user', is_active: true },
      adminNamespaces: ['crm'],
      scopeAssignments: [],
      groupAssignments: [],
    })
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (
        pathname === '/api/admin/role-delegation/departments'
        || pathname === '/api/admin/role-delegation/member-groups'
        || pathname === '/api/admin/role-delegation/scope-templates'
      ) {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({ ok: true, data: accessFor('user-1', 'Alpha', 'alpha@example.com') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({ ok: true, data: scopesFor('user-1') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/access') {
        await bravoGate
        return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', 'bravo@example.com') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/scopes') {
        return createJsonResponse({ ok: true, data: scopesFor('user-2') })
      }
      if (pathname.includes('/roles/') && init?.method === 'POST') {
        return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', 'bravo@example.com') })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })

    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Alpha'))
    await waitForCondition(() => callLog.some((url) => url.includes('/users/user-1/scopes')))
    await flushUi()

    const bravo = Array.from(container!.querySelectorAll('.delegation-page__user')).find((button) => button.textContent?.includes('bravo@example.com'))
    expect(bravo).toBeTruthy()
    ;(bravo as HTMLButtonElement).click()
    await flushUi()

    const detail = container!.querySelector('.delegation-page__panel--detail')
    expect(detail?.querySelector('h2')).toBeNull()
    expect(detail?.textContent).toContain('请选择一个成员')
    expect(detail?.textContent).not.toContain('Alpha')
    expect(detail?.textContent).not.toContain('alpha@example.com')
    expect(detail?.querySelector('[data-testid="delegation-assign-role"]')).toBeNull()
    expect(container?.querySelector('.delegation-page__user--active')?.textContent).toContain('bravo@example.com')
    expect(callLog.some((url) => url.includes('/roles/assign'))).toBe(false)

    releaseBravo?.()
    await waitForCondition(() => (
      (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Bravo')
      && callLog.some((url) => url.includes('/users/user-2/scopes'))
    ))
    await flushUi()
    expect(container?.querySelector('.delegation-page__panel--detail')?.textContent).not.toContain('Alpha')
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(findButtonByText(container!, '分配角色').disabled).toBe(false)
  })

  it('keeps assignment disabled until the matching scope read finishes', async () => {
    let releaseScopes: (() => void) | undefined
    const scopeGate = new Promise<void>((resolve) => {
      releaseScopes = resolve
    })
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:admin'] }]
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (
        pathname === '/api/admin/role-delegation/departments'
        || pathname === '/api/admin/role-delegation/member-groups'
        || pathname === '/api/admin/role-delegation/scope-templates'
      ) {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            isPlatformAdmin: true,
            delegableNamespaces: ['crm'],
            roleCatalog: catalog,
            scopeAssignments: [],
            groupAssignments: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [],
            memberGroups: [],
            delegableRoles: [],
            namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        await scopeGate
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [],
            groupAssignments: [],
          },
        })
      }
      if (pathname.includes('/roles/') && init?.method === 'POST') {
        throw new Error('role write while scopes were pending')
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })

    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-assign-role"]')))
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    const assignButton = findButtonByText(container!, '分配角色')
    expect(assignButton.disabled).toBe(true)
    assignButton.click()
    await flushUi()
    expect(callLog.some((url) => url.includes('/roles/assign'))).toBe(false)

    releaseScopes?.()
    await waitForCondition(() => callLog.some((url) => url.includes('/users/user-1/scopes')))
    await flushUi()
    expect(assignButton.disabled).toBe(false)
  })

  it('ignores access and scope payloads for a different member', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:admin'] }]
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (
        pathname === '/api/admin/role-delegation/departments'
        || pathname === '/api/admin/role-delegation/member-groups'
        || pathname === '/api/admin/role-delegation/scope-templates'
      ) {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            isPlatformAdmin: true,
            delegableNamespaces: ['crm'],
            roleCatalog: catalog,
            scopeAssignments: [],
            groupAssignments: [],
            user: { id: 'user-foreign', email: 'foreign@example.invalid', name: '外来成员', role: 'user', is_active: true },
            roles: ['crm_admin'],
            memberGroups: [],
            delegableRoles: ['crm_admin'],
            namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-foreign', email: 'foreign@example.invalid', name: '外来成员', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [{
              id: 'scope-foreign',
              namespace: 'crm',
              directoryDepartmentId: 'dept-foreign',
              integrationId: 'ding',
              integrationName: '外来集成',
              provider: 'dingtalk',
              corpId: null,
              externalDepartmentId: 'ext-foreign',
              departmentName: '外来部门',
              departmentFullPath: '外来部门路径',
              departmentActive: true,
            }],
            groupAssignments: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })

    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => callLog.some((url) => url.includes('/users/user-1/access')))
    await flushUi()
    const detail = container!.querySelector('.delegation-page__panel--detail')
    expect(detail?.textContent).toContain('请选择一个成员')
    expect(detail?.textContent).not.toContain('外来成员')
    expect(detail?.textContent).not.toContain('foreign@example.invalid')
    expect(detail?.querySelector('[data-testid="delegation-assign-role"]')).toBeNull()
    expect(callLog.some((url) => url.includes('/users/user-1/scopes'))).toBe(false)
    expect(container?.textContent).toContain('加载成员委派权限失败')

    if (app) app.unmount()
    app = null
    callLog = []
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (
        pathname === '/api/admin/role-delegation/departments'
        || pathname === '/api/admin/role-delegation/member-groups'
        || pathname === '/api/admin/role-delegation/scope-templates'
      ) {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            isPlatformAdmin: true,
            delegableNamespaces: ['crm'],
            roleCatalog: catalog,
            scopeAssignments: [],
            groupAssignments: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [],
            memberGroups: [],
            delegableRoles: [],
            namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-foreign', email: 'foreign@example.invalid', name: '外来成员', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [{
              id: 'scope-foreign',
              namespace: 'crm',
              directoryDepartmentId: 'dept-foreign',
              integrationId: 'ding',
              integrationName: '外来集成',
              provider: 'dingtalk',
              corpId: null,
              externalDepartmentId: 'ext-foreign',
              departmentName: '外来部门',
              departmentFullPath: '外来部门路径',
              departmentActive: true,
            }],
            groupAssignments: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })

    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => callLog.some((url) => url.includes('/users/user-1/scopes')))
    await flushUi()
    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Alpha')
    expect(container?.textContent).not.toContain('外来部门路径')
    expect(container?.textContent).not.toContain('外来成员')
    expect(container?.textContent).toContain('加载管理员范围失败')
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    expect(assignSelect).toBeTruthy()
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(findButtonByText(container!, '分配角色').disabled).toBe(true)
  })

  function choiceLabels(): string[] {
    return Array.from(container!.querySelectorAll('[data-testid="department-scope-choice"]')).map((node) => node.textContent || '')
  }

  it('confirms catalog permissions and sends expectedUpdatedAt only from the catalog field', async () => {
    const catalog = [{
      id: 'crm_admin',
      name: '客户管理员（crm:delete）',
      permissions: ['crm:read'],
      namespace: 'crm',
      updatedAt: 'stamp-1',
      expectedUpdatedAt: 'do-not-send',
    }]
    const posts: Array<{ path: string; body: unknown }> = []
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (pathname === '/api/admin/role-delegation/departments' || pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        const assigned = posts.length > 0
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog,
            scopeAssignments: [], groupAssignments: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: assigned ? ['crm_admin'] : [], memberGroups: [], delegableRoles: assigned ? ['crm_admin'] : [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', user: { id: 'user-1' }, adminNamespaces: ['crm'], scopeAssignments: [], groupAssignments: [] } })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        const request = readAuthorizationBody(init.body)
        expect(request).not.toHaveProperty('expectedUpdatedAt')
        expect(JSON.stringify(request)).not.toContain('do-not-send')
        posts.push({ path: pathname, body: request })
        return authorizationCommitResponse(init.body)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-assign-role"] option[value="crm_admin"]')))
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    const permissions = container!.querySelector('[data-testid="delegation-confirmation-permissions"]')
    expect(permissions?.textContent).toContain('crm:read')
    expect(permissions?.textContent).not.toContain('crm:delete')
    expect(container?.textContent).toContain('不会开通插件使用准入')
    expect(container?.textContent).toContain('不会写入直接权限码')
    expect(container?.textContent).not.toContain('推断')
    expect(callLog.some((url) => url.includes('/roles/assign'))).toBe(false)
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirm.disabled === false)
    confirm.click()
    await waitForCondition(() => posts.length === 1)
    expect(posts[0]?.body).toMatchObject({
      targetUserId: 'user-1',
      action: { kind: 'role.assign', roleId: 'crm_admin' },
      admissionChanges: [],
      expectedVersion: 'version-1',
    })
    expect(posts[0]?.body).not.toMatchObject({ expectedUpdatedAt: 'stamp-1' })
  })

  function setupConfirmationLifecycle(options: { delayed?: boolean, failFirst?: boolean, admissionFallback?: boolean } = {}) {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    const posts: Array<{ path: string, body: unknown }> = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let roles = ['crm_admin']
    let admissionEnabled = false
    const access = () => ({
      actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: catalog,
      user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
      roles, memberGroups: [], delegableRoles: roles,
      namespaceAdmissions: [{ namespace: 'crm', enabled: admissionEnabled, effective: admissionEnabled, hasRole: true, updatedAt: 'stamp' }],
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string, body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: access() })
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        const request = readAuthorizationBody(init.body)
        posts.push({ path: pathname, body: request })
        if (options.delayed) await gate
        if (options.failFirst && posts.length === 1) return createJsonResponse({ ok: false, error: { message: '保存失败' } }, 409)
        if (request.action.kind === 'role.assign') roles = ['crm_admin']
        else if (request.action.kind === 'role.revoke') roles = []
        else if (request.action.kind === 'admission.set') admissionEnabled = request.admissionChanges[0]?.enabled === true
        else throw new Error(`Unexpected write: ${rawUrl}`)
        return authorizationCommitResponse(init.body)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    return { posts, release: () => release?.() }
  }

  async function openLifecycleConfirmation(kind: 'grant' | 'revoke' | 'admission'): Promise<void> {
    await mountDelegation()
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-assign-role"]')))
    if (kind === 'admission') {
      findButtonByText(container!, '开通插件使用').click()
    } else {
      const select = container!.querySelector(`[data-testid="delegation-${kind === 'grant' ? 'assign' : 'revoke'}-role"]`) as HTMLSelectElement
      select.value = 'crm_admin'
      select.dispatchEvent(new Event('change'))
      await flushUi()
      findButtonByText(container!, kind === 'grant' ? '分配角色' : '撤销角色').click()
    }
    await flushUi()
  }

  it('keeps the same confirmation in place and latches duplicate events while a role write is pending', async () => {
    const { posts, release } = setupConfirmationLifecycle({ delayed: true })
    await openLifecycleConfirmation('grant')
    const panel = container!.querySelector('[data-testid="delegation-confirmation"]')
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    const cancel = container!.querySelector('[data-testid="delegation-confirmation-cancel"]') as HTMLButtonElement
    try {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushUi()
      expect(posts).toHaveLength(1)
      expect(posts[0]?.path).toBe(ADMIN_AUTHORIZATION_OPERATIONS_PATH)
      expect(posts[0]?.body).toMatchObject({
        targetUserId: 'user-1',
        action: { kind: 'role.assign', roleId: 'crm_admin' },
        admissionChanges: [],
        expectedVersion: 'version-1',
      })
      expect(container!.querySelector('[data-testid="delegation-confirmation"]')).toBe(panel)
      expect(container!.querySelector('[data-testid="delegation-confirmation-confirm"]')).toBe(confirm)
      expect(confirm.disabled).toBe(true)
      expect(cancel.disabled).toBe(true)
      expect(document.activeElement).toBe(panel)
      for (const shiftKey of [false, true]) {
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, shiftKey })
        document.dispatchEvent(tab)
        expect(tab.defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(panel)
      }
      cancel.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushUi()
      expect(container!.querySelector('[data-testid="delegation-confirmation"]')).toBe(panel)
      release()
      await waitForCondition(() => statusText().includes('角色已分配'))
      expect(container!.querySelector('[data-testid="delegation-confirmation"]')).toBe(panel)
      expect(container!.querySelector('[data-testid="delegation-confirmation-confirm"]')).toBe(confirm)
      expect(confirm.disabled).toBe(true)
      expect(document.activeElement).toBe(cancel)
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushUi()
      expect(posts).toHaveLength(1)
    } finally {
      release()
      await flushUi()
    }
  })

  it.each([
    ['grant', '角色已分配', 'role.assign'],
    ['revoke', '角色已从该成员移除', 'role.revoke'],
    ['admission', '已开通 crm 插件使用', 'admission.set'],
  ] as const)('retains the completed %s confirmation until explicitly closed', async (kind, message, actionKind) => {
    const { posts } = setupConfirmationLifecycle({ admissionFallback: true })
    await openLifecycleConfirmation(kind)
    const panel = container!.querySelector('[data-testid="delegation-confirmation"]')
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    confirm.click()
    await waitForCondition(() => statusText().includes(message))
    expect(posts).toHaveLength(1)
    expect(posts[0]?.path).toBe(ADMIN_AUTHORIZATION_OPERATIONS_PATH)
    expect(posts[0]?.body).toMatchObject(kind === 'admission'
      ? { action: { kind: actionKind }, admissionChanges: [{ namespace: 'crm', enabled: true }] }
      : { action: { kind: actionKind, roleId: 'crm_admin' }, admissionChanges: [] })
    expect(container!.querySelector('[data-testid="delegation-confirmation"]')).toBe(panel)
    expect(container!.querySelector('[data-testid="delegation-confirmation-confirm"]')).toBe(confirm)
    expect(confirm.disabled).toBe(true)
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()
    expect(posts).toHaveLength(1)
    const close = container!.querySelector('[data-testid="delegation-confirmation-cancel"]') as HTMLButtonElement
    expect(close.disabled).toBe(false)
    expect(close.textContent).toContain('关闭')
    close.click()
    await flushUi()
    expect(container!.querySelector('[data-testid="delegation-confirmation"]')).toBeNull()
    if (kind === 'admission') expect(callLog.filter((url) => url.endsWith('/user-1/access')).length).toBeGreaterThan(1)
  })

  it('retains a failed confirmation until closed and requires a fresh confirmation to retry', async () => {
    const { posts } = setupConfirmationLifecycle({ failFirst: true })
    await openLifecycleConfirmation('grant')
    const panel = container!.querySelector('[data-testid="delegation-confirmation"]')
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    confirm.click()
    await waitForCondition(() => statusText().includes('保存失败'))
    expect(container!.querySelector('[data-testid="delegation-confirmation"]')).toBe(panel)
    expect(confirm.disabled).toBe(true)
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()
    expect(posts).toHaveLength(1)
    ;(container!.querySelector('[data-testid="delegation-confirmation-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="delegation-confirmation"]')).toBeNull()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    ;(container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => statusText().includes('角色已分配'))
    expect(posts).toHaveLength(2)
    expect(posts[1]?.body).toMatchObject({
      targetUserId: 'user-1',
      action: { kind: 'role.assign', roleId: 'crm_admin' },
      admissionChanges: [],
    })
    expect(posts[1]?.body.clientOperationId).not.toBe(posts[0]?.body.clientOperationId)
  })

  it('cancels confirmation without posting and drops it when the member changes', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], namespace: 'crm', expectedUpdatedAt: 'stamp-1' }]
    const accessFor = (id: string, name: string, email: string) => ({
      actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog,
      user: { id, email, name, role: 'user', is_active: true },
      roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments' || pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: accessFor('user-1', 'Alpha', 'alpha@example.com') })
      if (pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', 'bravo@example.com') })
      if (pathname.endsWith('/scopes')) {
        const id = pathname.includes('user-2') ? 'user-2' : 'user-1'
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', user: { id }, adminNamespaces: ['crm'], scopeAssignments: [], groupAssignments: [] } })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (init?.method === 'POST') throw new Error(`unexpected post ${rawUrl}`)
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-assign-role"]')))
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation"]')).toBeTruthy()
    ;(container!.querySelector('[data-testid="delegation-confirmation-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation"]')).toBeNull()
    expect(callLog.some((url) => url.includes('/roles/assign'))).toBe(false)

    findButtonByText(container!, '分配角色').click()
    await flushUi()
    const bravo = Array.from(container!.querySelectorAll('.delegation-page__user')).find((button) => button.textContent?.includes('Bravo'))
    ;(bravo as HTMLButtonElement).click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation"]')).toBeNull()
    expect(callLog.some((url) => url.includes('/roles/assign'))).toBe(false)
  })

  it('sends includeChildren and shows an explicit false beside an omitted true', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const department = {
      directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录', provider: 'dingtalk',
      corpId: null, externalDepartmentId: 'ext-1', departmentName: '可选部门', departmentFullPath: '可选部门', departmentActive: true,
    }
    const keptScope = {
      id: 'scope-false', namespace: 'crm', directoryDepartmentId: 'dept-false', integrationId: 'ding', integrationName: '目录',
      provider: 'dingtalk', corpId: null, externalDepartmentId: 'ext-false', departmentName: '财务部', departmentFullPath: '财务部',
      departmentActive: true, includeChildren: false,
    }
    const omittedScope = {
      id: 'scope-omit', namespace: 'crm', directoryDepartmentId: 'dept-omit', integrationId: 'ding', integrationName: '目录',
      provider: 'dingtalk', corpId: null, externalDepartmentId: 'ext-omit', departmentName: '销售部', departmentFullPath: '销售部',
      departmentActive: true,
    }
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], exactDepartmentScopeAvailable: true, roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [department] } })
      if (pathname === '/api/admin/role-delegation/member-groups') return createJsonResponse({ ok: true, data: { items: [] } })
      if (pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'template-1', name: '华东销售', description: '', createdBy: null, updatedBy: null, createdAt: '', updatedAt: '', departmentCount: 2, memberGroupCount: 0 }] } })
      }
      if (pathname === '/api/admin/role-delegation/scope-templates/template-1') {
        return createJsonResponse({
          ok: true,
          data: {
            item: {
              id: 'template-1', name: '华东销售', description: '', departmentCount: 2, memberGroupCount: 0,
              departments: [
                { ...department, directoryDepartmentId: 'tmpl-false', departmentName: '模板本级', departmentFullPath: '模板本级', includeChildren: false },
                { ...department, directoryDepartmentId: 'tmpl-omit', departmentName: '模板下级', departmentFullPath: '模板下级' },
              ],
              memberGroups: [],
            },
          },
        })
      }
      if (pathname.endsWith('/scopes/assign')) {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        posts.push({ path: pathname, body })
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [
              keptScope,
              omittedScope,
              {
                ...department,
                id: 'scope-new',
                namespace: 'crm',
                directoryDepartmentId: 'dept-1',
                departmentName: '可选部门',
                includeChildren: body.includeChildren === true,
              },
            ],
            groupAssignments: [],
          },
        })
      }
      if (pathname.endsWith('/departments/assign') || pathname.endsWith('/departments/unassign')) {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        posts.push({ path: pathname, body })
        return createJsonResponse({
          ok: true,
          data: {
            item: {
              id: 'template-1', name: '华东销售', description: '', departmentCount: 2, memberGroupCount: 0,
              departments: [
                { ...department, directoryDepartmentId: 'tmpl-false', departmentName: '模板本级', departmentFullPath: '模板本级', includeChildren: false },
                { ...department, directoryDepartmentId: 'tmpl-omit', departmentName: '模板下级', departmentFullPath: '模板下级' },
                { ...department, directoryDepartmentId: 'dept-1', departmentName: '可选部门', departmentFullPath: '可选部门', includeChildren: body.includeChildren === true },
              ],
              memberGroups: [],
            },
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }, adminNamespaces: ['crm'], scopeAssignments: [keptScope, omittedScope], groupAssignments: [] } })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => (
      Boolean(container?.querySelector('[data-testid="scope-include-children-value"]'))
      && choiceLabels().includes('仅本部门')
      && choiceLabels().includes('未返回是否包含下级')
    ))
    expect(container?.querySelector('[data-testid="scope-include-children-value"]')?.textContent).toContain('包含下级部门')
    const scopeBox = container!.querySelector('[data-testid="scope-include-children"]') as HTMLInputElement
    scopeBox.checked = false
    scopeBox.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container?.querySelector('[data-testid="scope-include-children-value"]')?.textContent).toContain('仅本部门')
    const departmentSelect = Array.from(container!.querySelectorAll('select')).find((select) => select.textContent?.includes('可选部门')) as HTMLSelectElement
    departmentSelect.value = 'dept-1'
    departmentSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '添加部门范围').click()
    await waitForCondition(() => posts.some((post) => post.path.endsWith('/scopes/assign')))
    expect(posts.find((post) => post.path.endsWith('/scopes/assign'))?.body).toEqual({
      namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: false,
    })
    await waitForCondition(() => (container?.textContent || '').includes('插件管理员部门范围已添加'))

    const templateBox = container!.querySelector('[data-testid="template-include-children"]') as HTMLInputElement
    templateBox.checked = false
    templateBox.dispatchEvent(new Event('change'))
    await flushUi()
    const templateSelect = Array.from(container!.querySelectorAll('select')).find((select) => select.textContent?.includes('选择部门加入模板')) as HTMLSelectElement
    templateSelect.value = 'dept-1'
    templateSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '添加模板部门').click()
    await waitForCondition(() => posts.some((post) => post.path.endsWith('/departments/assign')))
    expect(posts.find((post) => post.path.endsWith('/departments/assign'))?.body).toEqual({
      directoryDepartmentId: 'dept-1', includeChildren: false,
    })
    await waitForCondition(() => !findButtonByText(container!, '移除模板部门').disabled)
    findButtonByText(container!, '移除模板部门').click()
    await waitForCondition(() => posts.some((post) => post.path.endsWith('/departments/unassign')))
    expect(posts.find((post) => post.path.endsWith('/departments/unassign'))?.body).toEqual({ directoryDepartmentId: 'tmpl-false' })
  })

  it('shows a disabled candidate without its email and does not request that profile', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-9', name: '外围成员', selectable: false, disabledReason: '不在管理范围', email: 'secret@example.com', role: 'admin' },
              { id: 'user-8', name: '坏标记', selectable: 'yes', email: 'leak@example.com', role: 'admin' },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-disabled-reason-user-9"]')))
    const disabled = container!.querySelector('[data-testid="delegation-user-disabled"]') as HTMLButtonElement
    expect(disabled.disabled).toBe(true)
    expect(disabled.textContent).toContain('不在管理范围')
    expect(container!.textContent).not.toContain('secret@example.com')
    expect(container!.textContent).not.toContain('leak@example.com')
    expect(container!.querySelector('[data-testid="delegation-disabled-reason-user-8"]')?.textContent).toContain('成员标记无效')
    disabled.click()
    await flushUi()
    expect(callLog.some((url) => url.includes('/users/user-9/access'))).toBe(false)
    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Alpha')
  })

  it('does not drift a pinned disabled member onto another user', async () => {
    window.history.replaceState({}, '', '/admin/role-delegation?userId=user-9&source=members#scope')
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-9', name: '外围成员', selectable: false, disabledReason: '不在管理范围', email: 'secret@example.com' },
            ],
          },
        })
      }
      if (pathname.includes('/access') || pathname.includes('/scopes')) throw new Error(`unexpected profile read ${rawUrl}`)
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-disabled-reason-user-9"]')))
    await flushUi()
    expect(container?.textContent).not.toContain('secret@example.com')
    expect(container?.querySelector('.delegation-page__panel--detail h2')).toBeNull()
    expect(container?.textContent).toContain('请选择一个成员')
    expect(window.location.search).toContain('userId=user-9')
    findButtonByText(container!, '查询').click()
    await flushUi(8)
    expect(container?.querySelector('.delegation-page__panel--detail h2')).toBeNull()
    expect(callLog.some((url) => url.includes('/access'))).toBe(false)
  })

  it('uses the filtered role lists and locks admissions outside manageableNamespaces', async () => {
    const catalog = [
      { id: 'attendance_admin', name: '考勤管理员', permissions: ['attendance:read'] },
      { id: 'mystery_role', name: '缺少目录权限' },
    ]
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['attendance'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['attendance'], roleCatalog: catalog,
            manageableNamespaces: ['attendance'],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: ['crm_admin', 'attendance_admin'], memberGroups: [], delegableRoles: ['attendance_admin'],
            namespaceAdmissions: [
              { namespace: 'crm', enabled: false, effective: false, hasRole: true, updatedAt: null },
              { namespace: 'attendance', enabled: false, effective: false, hasRole: true, updatedAt: null },
            ],
          },
        })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (init?.method === 'POST' || init?.method === 'PATCH') throw new Error(`unexpected write ${rawUrl}`)
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => container!.querySelectorAll('[data-testid="admission-namespace-locked"]').length === 1)
    const enableButtons = Array.from(container!.querySelectorAll('button')).filter((button) => button.textContent?.includes('开通插件使用'))
    expect(enableButtons[0]?.disabled).toBe(true)
    expect(enableButtons[1]?.disabled).toBe(false)
    const assignValues = Array.from(container!.querySelectorAll('[data-testid="delegation-assign-role"] option')).map((option) => (option as HTMLOptionElement).value)
    expect(assignValues).toEqual(['', 'attendance_admin', 'mystery_role'])
    expect(Array.from(container!.querySelectorAll('[data-testid="delegation-revoke-role"] option')).map((option) => (option as HTMLOptionElement).value)).toEqual(['', 'attendance_admin'])
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'mystery_role'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(findButtonByText(container!, '分配角色').disabled).toBe(true)
    assignSelect.value = 'attendance_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation-permissions"]')?.textContent).toContain('attendance:read')
    ;(container!.querySelector('[data-testid="delegation-confirmation-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    expect(callLog.some((url) => url.includes('/roles/assign'))).toBe(false)
  })

  it('ignores a slower user list that would restore the previous member', async () => {
    let releaseStale: (() => void) | undefined
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve })
    const accessFor = (id: string, name: string, email: string) => ({
      actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: [], roleCatalog: [],
      user: { id, email, name, role: 'user', is_active: true },
      roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
    })
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const url = new URL(rawUrl, 'http://localhost')
      if (url.pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: [], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (url.pathname === '/api/admin/role-delegation/users') {
        const q = url.searchParams.get('q') || ''
        if (q === 'stale') {
          await staleGate
          return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
        }
        if (q === 'fresh') {
          return createJsonResponse({ ok: true, data: { items: [{ id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true }] } })
        }
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (url.pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: accessFor('user-1', 'Alpha', 'alpha@example.com') })
      if (url.pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', 'bravo@example.com') })
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Alpha'))
    const searchInput = container!.querySelector('input[placeholder="搜索邮箱、姓名或用户 ID"]') as HTMLInputElement
    searchInput.value = 'stale'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((url) => url.includes('q=stale')))
    searchInput.value = 'fresh'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    const searchAgain = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('查询') || button.textContent?.includes('加载中'))
    if (!(searchAgain instanceof HTMLButtonElement)) throw new Error('Search button missing')
    searchAgain.click()
    await waitForCondition(() => callLog.some((url) => url.includes('q=fresh')) && (container?.textContent || '').includes('请选择一个成员'))
    expect(container?.querySelector('.delegation-page__panel--detail h2')).toBeNull()
    expect(callLog.some((url) => url.includes('/users/user-2/access'))).toBe(false)
    await selectListedMember('bravo@example.com')
    await waitForCondition(() => (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Bravo'))
    const alphaReads = callLog.filter((url) => url.includes('/users/user-1/access')).length
    releaseStale?.()
    await flushUi(8)
    expect(callLog.filter((url) => url.includes('/users/user-1/access')).length).toBe(alphaReads)
    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Bravo')
  })

  it('shows a forbidden member list instead of an empty directory', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: [], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') return createJsonResponse({ ok: false, error: { message: 'forbidden' } }, 403)
      if (pathname.includes('/access')) throw new Error('access must not be read')
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-users-forbidden"]')))
    expect(container?.textContent).toContain('当前账号没有可管理的范围。')
    expect(container?.textContent).not.toContain('暂无成员')
    expect(callLog.some((url) => url.includes('/access'))).toBe(false)
  })

  it('keeps the current role and scope when unassign is forbidden', async () => {
    const catalog = [{ id: 'platform_admin', name: '平台管理员', permissions: ['admin:all'], namespace: 'platform' }]
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments' || pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: ['platform_admin'], memberGroups: [], delegableRoles: ['platform_admin'], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', user: { id: 'user-1' }, adminNamespaces: ['crm'],
            scopeAssignments: [{
              id: 'scope-1', namespace: 'crm', directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录',
              provider: 'dingtalk', corpId: null, externalDepartmentId: 'ext-1', departmentName: '保留部门', departmentFullPath: '保留部门',
              departmentActive: true, includeChildren: false,
            }],
            groupAssignments: [],
          },
        })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        return createJsonResponse({ ok: false, error: { message: '不能撤销最后的平台管理员' } }, 409)
      }
      if (init?.method) return createJsonResponse({ ok: false }, 500)
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => (container?.textContent || '').includes('保留部门'))
    const revokeSelect = container!.querySelector('[data-testid="delegation-revoke-role"]') as HTMLSelectElement
    revokeSelect.value = 'platform_admin'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '撤销角色').click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation-typed"]')).toBeNull()
    const confirmForbidden = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirmForbidden.disabled === false)
    confirmForbidden.click()
    await waitForCondition(() => (container?.textContent || '').includes('不能撤销最后的平台管理员'))
    expect(container?.textContent).toContain('保留部门')
    expect(container?.textContent).not.toContain('该成员尚未配置任何插件管理员范围')
    expect(Array.from(container!.querySelectorAll('[data-testid="delegation-revoke-role"] option')).map((option) => (option as HTMLOptionElement).value)).toContain('platform_admin')
  })

  it('drops stale departments when a role write cannot reload scope', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], namespace: 'crm' }]
    let scopeReads = 0
    let assigned = false
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments' || pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: assigned ? ['crm_admin'] : [],
            memberGroups: [],
            delegableRoles: assigned ? ['crm_admin'] : [],
            namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        scopeReads += 1
        if (scopeReads > 1) return createJsonResponse({ ok: false, error: { message: '加载管理员范围失败' } }, 500)
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', user: { id: 'user-1' }, adminNamespaces: ['crm'],
            scopeAssignments: [{
              id: 'scope-old', namespace: 'crm', directoryDepartmentId: 'dept-old', integrationId: 'ding', integrationName: '目录',
              provider: 'dingtalk', corpId: null, externalDepartmentId: 'ext-old', departmentName: '旧部门', departmentFullPath: '旧部门',
              departmentActive: true,
            }],
            groupAssignments: [],
          },
        })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        assigned = true
        return authorizationCommitResponse(init.body)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => (container?.textContent || '').includes('旧部门'))
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    ;(container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => (container?.textContent || '').includes('加载管理员范围失败'))
    expect(container?.textContent).not.toContain('旧部门')
    expect(Array.from(container!.querySelectorAll('[data-testid="delegation-revoke-role"] option')).map((option) => (option as HTMLOptionElement).value)).toContain('crm_admin')
    expect(container?.textContent).not.toContain('该成员尚未配置任何插件管理员范围')
  })

  it('requires the exact phrase to remove platform admin and Escape cancels', async () => {
    const catalog = [{ id: 'admin', name: '平台管理员', permissions: ['admin:all'], updatedAt: 'stamp-admin' }]
    const posts: Array<{ path: string; body: unknown }> = []
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments' || pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', user: { id: 'user-1' }, adminNamespaces: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        posts.push({ path: pathname, body: JSON.parse(String(init.body)) })
        return authorizationCommitResponse(init.body)
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        const revoked = posts.length > 0
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: revoked ? [] : ['admin'],
            memberGroups: [],
            delegableRoles: revoked ? [] : ['admin'],
            namespaceAdmissions: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-revoke-role"] option[value="admin"]')))
    const revokeSelect = container!.querySelector('[data-testid="delegation-revoke-role"]') as HTMLSelectElement
    revokeSelect.value = 'admin'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '撤销角色').click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation-platform-admin"]')?.textContent).toContain('特殊权限')
    expect(container?.textContent).toContain('取消平台管理员')
    expect(container?.textContent).not.toContain('如果该角色包含平台管理员')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation"]')).toBeNull()
    expect(posts).toHaveLength(0)

    findButtonByText(container!, '撤销角色').click()
    await flushUi()
    const typed = container!.querySelector('[data-testid="delegation-confirmation-typed"]') as HTMLInputElement
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    typed.value = 'Alpha'
    typed.dispatchEvent(new Event('input'))
    await flushUi()
    expect(confirm.disabled).toBe(true)
    confirm.click()
    await flushUi()
    expect(posts).toHaveLength(0)
    typed.value = '取消平台管理员'
    typed.dispatchEvent(new Event('input'))
    await flushUi()
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await waitForCondition(() => posts.length === 1)
    expect(posts[0]?.body).toMatchObject({
      targetUserId: 'user-1',
      action: { kind: 'role.revoke', roleId: 'admin' },
      admissionChanges: [],
    })
  })

  it('shows a known-empty catalog separately from a role the catalog does not list', async () => {
    const catalog = [{ id: 'empty_role', name: '空角色', permissions: [], updatedAt: 'stamp-empty' }]
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: ['plugin_elearning_viewer'], memberGroups: [], delegableRoles: ['empty_role', 'plugin_elearning_viewer'],
            namespaceAdmissions: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-revoke-role"] option[value="empty_role"]')))
    const revokeSelect = container!.querySelector('[data-testid="delegation-revoke-role"]') as HTMLSelectElement
    revokeSelect.value = 'empty_role'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '撤销角色').click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation-permissions-empty"]')?.textContent).toContain('目录中该角色没有权限码')
    ;(container!.querySelector('[data-testid="delegation-confirmation-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    revokeSelect.value = 'plugin_elearning_viewer'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '撤销角色').click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-confirmation-permissions-empty"]')?.textContent).toContain('目录未提供权限码')
    expect(container?.textContent).not.toContain('目录中该角色没有权限码')
  })

  it('does not treat a mismatched includeChildren receipt as success', async () => {
    const posts: Array<Record<string, unknown>> = []
    const department = {
      directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录', provider: 'dingtalk',
      corpId: null, externalDepartmentId: 'ext-1', departmentName: '可选部门', departmentFullPath: '可选部门', departmentActive: true,
    }
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], exactDepartmentScopeAvailable: true, roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [department] } })
      if (pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', user: { id: 'user-1' }, adminNamespaces: ['crm'], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname.endsWith('/scopes/assign')) {
        posts.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>)
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [{ ...department, id: 'scope-new', namespace: 'crm', includeChildren: true }],
            groupAssignments: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="scope-include-children"]')))
    const scopeBox = container!.querySelector('[data-testid="scope-include-children"]') as HTMLInputElement
    scopeBox.checked = false
    scopeBox.dispatchEvent(new Event('change'))
    await flushUi()
    const departmentSelect = Array.from(container!.querySelectorAll('select')).find((select) => select.textContent?.includes('可选部门')) as HTMLSelectElement
    departmentSelect.value = 'dept-1'
    departmentSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '添加部门范围').click()
    await waitForCondition(() => posts.length === 1)
    expect(posts[0]).toEqual({ namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: false })
    await flushUi(4)
    expect(container?.textContent).toContain('返回的是否包含下级与提交不一致')
    expect(container?.textContent).not.toContain('插件管理员部门范围已添加')
  })

  it('locks namespace admission when a non-platform payload omits manageableNamespaces', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [
              { namespace: 'crm', enabled: false, effective: false, hasRole: true, updatedAt: null },
            ],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="admission-namespace-locked"]')))
    const enable = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent?.includes('开通插件使用'))
    expect((enable as HTMLButtonElement).disabled).toBe(true)
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(findButtonByText(container!, '分配角色').disabled).toBe(false)
  })

  function mountWithLinks(): void {
    app = createApp(RoleDelegationView)
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      setup(props, { slots }) {
        return () => h('a', { href: typeof props.to === 'string' ? props.to : '' }, slots.default?.())
      },
    })
    app.mount(container!)
  }

  it('hides /admin/users from a business-only account', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'biz-1', isPlatformAdmin: false, delegableNamespaces: [], roleCatalog: [], scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    mountWithLinks()
    await waitForCondition(() => (container?.textContent || '').includes('无可委派命名空间'))
    expect(container?.querySelector('a[href="/admin/users"]')).toBeNull()
    expect(container?.textContent).not.toContain('成员与授权')

    app?.unmount()
    container?.replaceChildren()
    callLog = []
    apiFetchMock.mockImplementation(createApiImplementation(callLog))
    mountWithLinks()
    await waitForCondition(() => (container?.textContent || '').includes('平台管理员模式'))
    expect(container?.querySelector('a[href="/admin/users"]')?.textContent).toContain('成员与授权')
  })

  it('explains an out-of-scope member in Chinese and keeps a custom reason', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-9', name: '外围成员', selectable: false, disabledReason: '不在管理范围' },
              { id: 'user-7', name: '范围外', selectable: false, disabledReason: 'ROLE_DELEGATION_USER_OUT_OF_SCOPE' },
            ],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-disabled-reason-user-7"]')))
    expect(container?.querySelector('[data-testid="delegation-disabled-reason-user-7"]')?.textContent).toBe('这个人不在您可管理的部门或成员组里。')
    expect(container?.querySelector('[data-testid="delegation-disabled-reason-user-9"]')?.textContent).toContain('不在管理范围')
    expect(container?.textContent).not.toContain('ROLE_DELEGATION_USER_OUT_OF_SCOPE')
  })

  function clickListedUser(email: string): void {
    const button = Array.from(container!.querySelectorAll('.delegation-page__user')).find((node) => node.textContent?.includes(email))
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing user ${email}`)
    button.click()
  }

  async function mountDelegation(): Promise<void> {
    const callsBefore = callLog.length
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
    if (new URL(window.location.href).searchParams.get('userId')?.trim()) return
    await waitForMemberListSettled(callsBefore)
    const alpha = listedMemberButton('alpha@example.com')
    if (alpha && !alpha.disabled) alpha.click()
  }

  function statusText(): string {
    return container?.querySelector('.delegation-page__status')?.textContent || ''
  }

  it('matches includeChildren by namespace when one department is shared', async () => {
    const posts: Array<Record<string, unknown>> = []
    const department = {
      directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录', provider: 'dingtalk',
      corpId: null, externalDepartmentId: 'ext-1', departmentName: '可选部门', departmentFullPath: '可选部门', departmentActive: true,
    }
    const attendanceScope = {
      ...department, id: 'scope-attendance', namespace: 'attendance', includeChildren: true,
    }
    const crmScope = {
      ...department, id: 'scope-crm', namespace: 'crm', includeChildren: false,
    }
    let assigned = false
    const scopeConfig = (assignments: unknown[]) => ({
      ok: true,
      data: {
        actorId: 'admin-1',
        user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
        adminNamespaces: ['crm', 'attendance'],
        scopeAssignments: assignments,
        groupAssignments: [],
      },
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], exactDepartmentScopeAvailable: true, roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [department] } })
      if (pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse(scopeConfig(assigned ? [attendanceScope, crmScope] : [attendanceScope]))
      }
      if (pathname.endsWith('/scopes/assign')) {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        posts.push(body)
        assigned = true
        return createJsonResponse(scopeConfig([attendanceScope, crmScope]))
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('可选部门'))
    const namespaceSelect = Array.from(container!.querySelectorAll('select')).find((select) => select.textContent?.includes('attendance')) as HTMLSelectElement
    namespaceSelect.value = 'crm'
    namespaceSelect.dispatchEvent(new Event('change'))
    const scopeBox = container!.querySelector('[data-testid="scope-include-children"]') as HTMLInputElement
    scopeBox.checked = false
    scopeBox.dispatchEvent(new Event('change'))
    await flushUi()
    const departmentSelect = Array.from(container!.querySelectorAll('select')).find((select) => select.textContent?.includes('可选部门')) as HTMLSelectElement
    departmentSelect.value = 'dept-1'
    departmentSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '添加部门范围').click()
    await waitForCondition(() => posts.length === 1 && (container?.textContent || '').includes('插件管理员部门范围已添加'))
    expect(posts[0]).toEqual({ namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: false })
    const card = (namespace: string) => Array.from(container!.querySelectorAll('.delegation-page__scope-card')).find((node) => node.querySelector('strong')?.textContent === namespace)
    expect(card('attendance')?.querySelector('[data-testid="department-scope-choice"]')?.textContent).toContain('包含下级部门')
    expect(card('crm')?.querySelector('[data-testid="department-scope-choice"]')?.textContent).toContain('仅本部门')
    expect(container?.textContent).not.toContain('返回的是否包含下级与提交不一致')
  })

  it('keeps the fresh member when a delayed role write returns after reselection', async () => {
    let releaseRole: (() => void) | undefined
    const roleGate = new Promise<void>((resolve) => { releaseRole = resolve })
    let roleSettled = false
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    let alphaReads = 0
    const accessFor = (id: string, name: string, roles: string[]) => ({
      actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: catalog,
      user: { id, email: `${id}@example.com`, name, role: 'user', is_active: true },
      roles, memberGroups: [], delegableRoles: roles, namespaceAdmissions: [],
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        alphaReads += 1
        const fresh = alphaReads > 1
        return createJsonResponse({ ok: true, data: accessFor('user-1', fresh ? 'Alpha Fresh' : 'Alpha', fresh ? ['fresh_role'] : []) })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/access') {
        return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', ['bravo_role']) })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        await roleGate
        roleSettled = true
        return authorizationCommitResponse(init.body)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-assign-role"]')))
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirm.disabled === false)
    confirm.click()
    try {
      await waitForCondition(() => callLog.some((url) => url === ADMIN_AUTHORIZATION_OPERATIONS_PATH || url.endsWith('/api/admin/authorization-operations')))
      clickListedUser('bravo@example.com')
      await waitForCondition(() => (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Bravo'))
      clickListedUser('alpha@example.com')
      await waitForCondition(() => (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Alpha Fresh'))
      releaseRole?.()
      await waitForCondition(() => roleSettled)
      await flushUi(8)
      expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Alpha Fresh')
      const chips = Array.from(container!.querySelectorAll('.delegation-page__chip--success')).map((node) => node.textContent || '')
      expect(chips).toContain('fresh_role')
      expect(chips).not.toContain('stale_role')
      expect(statusText()).not.toContain('角色已分配')
      expect(container?.textContent).not.toContain('Alpha Stale')
    } finally {
      releaseRole?.()
      await flushUi(8)
    }
  })

  it('keeps the fresh admission when a delayed write returns after reselection', async () => {
    let releaseAdmission: (() => void) | undefined
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve })
    let admissionSettled = false
    let alphaReads = 0
    const admission = (enabled: boolean, updatedAt: string) => ({ namespace: 'crm', enabled, effective: enabled, hasRole: true, updatedAt })
    const accessFor = (id: string, name: string, updatedAt: string, enabled = true) => ({
      actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: [],
      user: { id, email: `${id}@example.com`, name, role: 'user', is_active: true },
      roles: [], memberGroups: [], delegableRoles: [],
      namespaceAdmissions: [admission(enabled, updatedAt)],
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        alphaReads += 1
        const fresh = alphaReads > 1
        return createJsonResponse({ ok: true, data: accessFor('user-1', fresh ? 'Alpha Fresh' : 'Alpha', fresh ? 'fresh-stamp' : 'initial-stamp') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/access') {
        return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', 'bravo-stamp') })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        await admissionGate
        admissionSettled = true
        return authorizationCommitResponse(init?.body)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('插件使用已开通'))
    findButtonByText(container!, '关闭插件使用').click()
    await flushUi()
    const confirmClose = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirmClose.disabled === false)
    confirmClose.click()
    try {
      await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/authorization-operations') && !url.includes('/preview')))
      clickListedUser('bravo@example.com')
      await waitForCondition(() => (container?.querySelector('.delegation-page__panel--detail h2')?.textContent || '').includes('Bravo'))
      clickListedUser('alpha@example.com')
      await waitForCondition(() => (container?.textContent || '').includes('fresh-stamp'))
      releaseAdmission?.()
      await waitForCondition(() => admissionSettled)
      await flushUi(8)
      expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Alpha Fresh')
      expect(container?.textContent).toContain('更新时间：fresh-stamp')
      expect(container?.textContent).toContain('插件使用已开通')
      expect(container?.textContent).not.toContain('stale-stamp')
      expect(container?.textContent).not.toContain('Alpha Stale')
      expect(statusText()).not.toContain('已关闭 crm 插件使用')
    } finally {
      releaseAdmission?.()
      await flushUi(8)
    }
  })

  it('does not announce a role write when its scope reload is stale', async () => {
    let releaseScope: (() => void) | undefined
    const scopeGate = new Promise<void>((resolve) => { releaseScope = resolve })
    let scopeSettled = false
    let user1ScopeReads = 0
    let assignedRole = false
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    const accessFor = (id: string, name: string, roles: string[]) => ({
      actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog,
      user: { id, email: `${id}@example.com`, name, role: 'user', is_active: true },
      roles, memberGroups: [], delegableRoles: roles, namespaceAdmissions: [],
    })
    const scopeFor = (id: string, departmentName: string) => ({
      ok: true,
      data: {
        actorId: 'admin-1',
        user: { id, email: `${id}@example.com`, name: id, role: 'user', is_active: true },
        adminNamespaces: ['crm'],
        scopeAssignments: [{
          id: `scope-${id}`, namespace: 'crm', directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录',
          provider: 'dingtalk', corpId: null, externalDepartmentId: 'ext-1', departmentName, departmentFullPath: departmentName, departmentActive: true, includeChildren: true,
        }],
        groupAssignments: [],
      },
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments' || pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({ ok: true, data: accessFor('user-1', 'Alpha', assignedRole ? ['crm_admin'] : []) })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', ['bravo_role']) })
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        user1ScopeReads += 1
        if (user1ScopeReads > 1) {
          await scopeGate
          scopeSettled = true
          return createJsonResponse(scopeFor('user-1', '过期部门'))
        }
        return createJsonResponse(scopeFor('user-1', '旧部门'))
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/scopes') return createJsonResponse(scopeFor('user-2', 'Bravo范围'))
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') {
        assignedRole = true
        return authorizationCommitResponse(init.body)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('旧部门'))
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    ;(container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement).click()
    try {
      await waitForCondition(() => user1ScopeReads > 1)
      clickListedUser('bravo@example.com')
      await waitForCondition(() => (container?.textContent || '').includes('Bravo范围'))
      releaseScope?.()
      await waitForCondition(() => scopeSettled)
      await flushUi(8)
      expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Bravo')
      expect(container?.textContent).toContain('Bravo范围')
      expect(container?.textContent).not.toContain('过期部门')
      expect(container?.textContent).not.toContain('Alpha Stale')
      expect(statusText()).not.toContain('角色已分配')
    } finally {
      releaseScope?.()
      await flushUi(8)
    }
  })

  it('does not merge an admission payload whose enabled flag or member does not match', async () => {
    const catalog: never[] = []
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [],
            namespaceAdmissions: [{ namespace: 'crm', enabled: false, effective: false, hasRole: true, updatedAt: 'initial-stamp' }],
          },
        })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') return authorizationCommitResponse(init.body)
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('插件使用未开通'))
    findButtonByText(container!, '开通插件使用').click()
    await flushUi()
    ;(container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => statusText().includes('还没有核对成功'))
    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Alpha')
    expect(container?.textContent).toContain('插件使用未开通')
    expect(container?.textContent).toContain('initial-stamp')
    expect(container?.textContent).not.toContain('被覆盖')
    expect(container?.textContent).not.toContain('should-not-appear')
    expect(container?.textContent).not.toContain('mismatch-stamp')
    expect(statusText()).not.toContain('已开通 crm 插件使用')
  })

  it('does not announce admission success when the follow-up read does not show it', async () => {
    let accessReads = 0
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        accessReads += 1
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [],
            namespaceAdmissions: [{ namespace: 'crm', enabled: false, effective: false, hasRole: true, updatedAt: 'still-closed' }],
          },
        })
      }
      if (isAuthorizationPreview(pathname) && init?.method === 'POST') return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname) && init?.method === 'POST') return authorizationCommitResponse(init.body)
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('插件使用未开通'))
    const readsBefore = accessReads
    findButtonByText(container!, '开通插件使用').click()
    await flushUi()
    ;(container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement).click()
    await waitForCondition(() => accessReads > readsBefore && statusText().includes('还没有核对成功'))
    expect(container?.textContent).toContain('插件使用未开通')
    expect(statusText()).not.toContain('已开通 crm 插件使用')
  })

  it('does not adopt a newer member generation when a scope refresh list returns late', async () => {
    let releaseUsers: (() => void) | undefined
    const usersGate = new Promise<void>((resolve) => { releaseUsers = resolve })
    let usersReads = 0
    let usersSettled = false
    let alphaReads = 0
    let alphaScopeReads = 0
    const department = {
      directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录', provider: 'dingtalk',
      corpId: null, externalDepartmentId: 'ext-1', departmentName: '可选部门', departmentFullPath: '可选部门', departmentActive: true,
    }
    const accessFor = (id: string, name: string) => ({
      actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
      user: { id, email: `${id}@example.com`, name, role: 'user', is_active: true },
      roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
    })
    const scopeFor = (id: string, departmentName: string) => ({
      ok: true,
      data: {
        actorId: 'admin-1',
        user: { id, email: `${id}@example.com`, name: id, role: 'user', is_active: true },
        adminNamespaces: ['crm'],
        scopeAssignments: [{
          ...department,
          id: `scope-${departmentName}`,
          namespace: 'crm',
          departmentName,
          departmentFullPath: departmentName,
          includeChildren: true,
        }],
        groupAssignments: [],
      },
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [department] } })
      if (pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        usersReads += 1
        if (usersReads > 1) {
          await usersGate
          usersSettled = true
        }
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        alphaReads += 1
        const name = alphaReads === 1 ? 'Alpha' : alphaReads === 2 ? 'Alpha Fresh' : 'Alpha Rebound'
        return createJsonResponse({ ok: true, data: accessFor('user-1', name) })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/access') {
        return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        alphaScopeReads += 1
        const departmentName = alphaScopeReads === 1 ? '保留部门' : alphaScopeReads === 2 ? '新鲜部门' : '回写部门'
        return createJsonResponse(scopeFor('user-1', departmentName))
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/scopes') return createJsonResponse(scopeFor('user-2', 'Bravo范围'))
      if (pathname.endsWith('/scopes/assign') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as { includeChildren?: boolean }
        return createJsonResponse(scopeFor('user-1', body.includeChildren === true ? '写入部门' : '错误部门'))
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('保留部门'))
    const departmentSelect = Array.from(container!.querySelectorAll('select')).find((select) => select.textContent?.includes('可选部门')) as HTMLSelectElement
    departmentSelect.value = 'dept-1'
    departmentSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '添加部门范围').click()
    try {
      await waitForCondition(() => usersReads > 1)
      clickListedUser('bravo@example.com')
      await waitForCondition(() => (container?.textContent || '').includes('Bravo范围'))
      clickListedUser('alpha@example.com')
      await waitForCondition(() => (container?.textContent || '').includes('Alpha Fresh') && (container?.textContent || '').includes('新鲜部门'))
      const readsAfterReselect = alphaReads
      const scopesAfterReselect = alphaScopeReads
      releaseUsers?.()
      await waitForCondition(() => usersSettled)
      await flushUi(8)
      expect(alphaReads).toBe(readsAfterReselect)
      expect(alphaScopeReads).toBe(scopesAfterReselect)
      expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Alpha Fresh')
      expect(container?.textContent).toContain('新鲜部门')
      expect(container?.textContent).not.toContain('Alpha Rebound')
      expect(container?.textContent).not.toContain('回写部门')
      expect(statusText()).not.toContain('插件管理员部门范围已添加')
    } finally {
      releaseUsers?.()
      await flushUi(8)
    }
  })

  it('keeps a pinned member who is missing from the current search page after a scope save', async () => {
    const location = '/admin/role-delegation?userId=user-41&source=members#scope'
    window.history.replaceState({}, '', location)
    const department = {
      directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录', provider: 'dingtalk',
      corpId: null, externalDepartmentId: 'ext-1', departmentName: '可选部门', departmentFullPath: '可选部门', departmentActive: true,
    }
    let accessReads = 0
    let scopeReads = 0
    let saved = false
    const pinnedUser = { id: 'user-41', email: 'pinned@example.com', name: 'Pinned Alpha', role: 'user', is_active: true }
    const bravo = { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true }
    const accessFor = (id: string, name: string, email: string) => ({
      actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
      user: { id, email, name, role: 'user', is_active: true },
      roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
    })
    const scopeFor = (id: string, departmentName: string) => ({
      ok: true,
      data: {
        actorId: 'admin-1',
        user: { id, email: id === 'user-41' ? pinnedUser.email : bravo.email, name: id === 'user-41' ? pinnedUser.name : bravo.name, role: 'user', is_active: true },
        adminNamespaces: ['crm'],
        scopeAssignments: [{
          ...department,
          id: 'scope-saved',
          namespace: 'crm',
          departmentName,
          departmentFullPath: departmentName,
          includeChildren: true,
        }],
        groupAssignments: [],
      },
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const url = new URL(rawUrl, 'http://localhost')
      const { pathname } = url
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [department] } })
      if (pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        const query = url.searchParams.get('q') || ''
        const items = query === 'bravo' ? [bravo] : [pinnedUser, bravo]
        return createJsonResponse({ ok: true, data: { items } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-41/access') {
        accessReads += 1
        return createJsonResponse({ ok: true, data: accessFor('user-41', 'Pinned Alpha', 'pinned@example.com') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-2/access') {
        return createJsonResponse({ ok: true, data: accessFor('user-2', 'Bravo', 'bravo@example.com') })
      }
      if (pathname === '/api/admin/role-delegation/users/user-41/scopes') {
        scopeReads += 1
        return createJsonResponse(scopeFor('user-41', saved ? '已保存部门' : '原部门'))
      }
      if (pathname.endsWith('/scopes/assign') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as { includeChildren?: boolean }
        saved = true
        return createJsonResponse(scopeFor('user-41', body.includeChildren === true ? '已保存部门' : '错误部门'))
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('原部门'))
    const searchInput = container!.querySelector('input[placeholder="搜索邮箱、姓名或用户 ID"]') as HTMLInputElement
    searchInput.value = 'bravo'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((entry) => entry.includes('q=bravo')) && accessReads >= 2 && scopeReads >= 2)
    await flushUi()
    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Pinned Alpha')
    expect(container?.querySelector('.delegation-page__user--active')).toBeNull()
    expect(callLog.some((entry) => entry.includes('/users/user-2/access'))).toBe(false)

    const departmentSelect = Array.from(container!.querySelectorAll('select')).find((select) => select.textContent?.includes('可选部门')) as HTMLSelectElement
    departmentSelect.value = 'dept-1'
    departmentSelect.dispatchEvent(new Event('change'))
    await flushUi()
    const readsBeforeSave = accessReads
    findButtonByText(container!, '添加部门范围').click()
    await waitForCondition(() => statusText().includes('插件管理员部门范围已添加'))
    expect(accessReads).toBe(readsBeforeSave + 1)
    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).toContain('Pinned Alpha')
    expect(container?.textContent).toContain('已保存部门')
    expect(container?.querySelector('.delegation-page__panel--detail h2')?.textContent).not.toContain('Bravo')
    expect(container?.querySelector('.delegation-page__user--active')).toBeNull()
    expect(callLog.some((entry) => entry.includes('/users/user-2/access'))).toBe(false)
    expect(statusText()).not.toContain('该成员已不在可管理范围内')
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(location)
  })

  function catalogDepartment(overrides: Record<string, unknown> = {}) {
    return {
      directoryDepartmentId: 'dept-1',
      integrationId: 'ding',
      integrationName: '目录',
      provider: 'dingtalk',
      corpId: null,
      externalDepartmentId: 'ext-1',
      departmentName: '可选部门',
      departmentFullPath: '可选部门',
      departmentActive: true,
      ...overrides,
    }
  }

  function selectControl(text: string): HTMLSelectElement {
    const select = Array.from(container!.querySelectorAll('select')).find((candidate) => candidate.textContent?.includes(text))
    if (!(select instanceof HTMLSelectElement)) throw new Error(`Select not found: ${text}`)
    return select
  }

  async function mountCapabilitySummary(availability: unknown, includeAvailability: boolean): Promise<void> {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        const data: Record<string, unknown> = {
          actorId: 'admin-1',
          isPlatformAdmin: true,
          delegableNamespaces: [],
          roleCatalog: [],
          scopeAssignments: [],
          groupAssignments: [],
        }
        if (includeAvailability) data.exactDepartmentScopeAvailable = availability
        return createJsonResponse({ ok: true, data })
      }
      if (pathname === '/api/admin/role-delegation/departments') {
        return createJsonResponse({ ok: true, data: { items: [catalogDepartment()] } })
      }
      if (pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [],
            groupAssignments: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    if (app) app.unmount()
    container?.replaceChildren()
    await mountDelegation()
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="scope-include-children"]')))
  }

  it('treats missing, false, and non-true exact-department availability as disabled', async () => {
    const cases: Array<{ label: string, include: boolean, value?: unknown }> = [
      { label: 'missing', include: false },
      { label: 'false', include: true, value: false },
      { label: 'string true', include: true, value: 'true' },
      { label: 'number 1', include: true, value: 1 },
    ]
    for (const entry of cases) {
      await mountCapabilitySummary(entry.value, entry.include)
      const box = container!.querySelector('[data-testid="scope-include-children"]') as HTMLInputElement
      const templateHint = container!.querySelector('[data-testid="template-include-children"]')
      expect(box.checked, entry.label).toBe(true)
      expect(box.disabled, entry.label).toBe(true)
      expect(container?.querySelector('[data-testid="scope-include-children-value"]')?.textContent, entry.label).toContain('包含下级部门')
      expect(container?.textContent, entry.label).toContain('当前不能新建仅本部门的范围')
      expect(container?.textContent, entry.label).not.toContain('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED')
      expect(container?.textContent, entry.label).not.toContain('exactDepartmentScopeAvailable')
      expect(templateHint, entry.label).toBeNull()
      box.checked = false
      box.dispatchEvent(new Event('change'))
      await flushUi()
      expect(box.checked, entry.label).toBe(true)
      expect(callLog.some((url) => url.includes('/scopes/assign')), entry.label).toBe(false)
    }
  })

  it('enables exact-department controls only when the summary boolean is true', async () => {
    await mountCapabilitySummary(true, true)
    const box = container!.querySelector('[data-testid="scope-include-children"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(false)
    expect(container?.querySelector('[data-testid="exact-department-unavailable"]')).toBeNull()
    expect(container?.textContent).not.toContain('当前不能新建仅本部门的范围')
    expect(container?.textContent).not.toContain('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED')
  })

  it('keeps a stored exact department visible for a business admin when availability is absent', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1',
            isPlatformAdmin: false,
            delegableNamespaces: ['crm'],
            roleCatalog: [],
            scopeAssignments: [
              catalogDepartment({ id: 'scope-false', namespace: 'crm', departmentName: '财务部', departmentFullPath: '财务部', includeChildren: false }),
              catalogDepartment({ id: 'scope-true', namespace: 'crm', directoryDepartmentId: 'dept-true', departmentName: '研发部', departmentFullPath: '研发部', includeChildren: true }),
              catalogDepartment({ id: 'scope-omit', namespace: 'crm', directoryDepartmentId: 'dept-omit', departmentName: '销售部', departmentFullPath: '销售部' }),
            ],
            groupAssignments: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => choiceLabels().includes('仅本部门'))
    expect(choiceLabels()).toEqual(expect.arrayContaining(['仅本部门', '包含下级部门', '未返回是否包含下级']))
    expect(container?.querySelector('[data-testid="scope-include-children"]')).toBeNull()
    expect(container?.textContent).toContain('财务部')
    expect(container?.textContent).not.toContain('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED')
  })

  it('does not request a false direct scope, template department, or false template apply while availability is off', async () => {
    const posts: Array<{ path: string, body: Record<string, unknown> }> = []
    const falseScope = catalogDepartment({
      id: 'scope-false', namespace: 'crm', directoryDepartmentId: 'dept-false', departmentName: '财务部', departmentFullPath: '财务部', includeChildren: false,
    })
    const omittedScope = catalogDepartment({
      id: 'scope-omit', namespace: 'crm', directoryDepartmentId: 'dept-omit', departmentName: '销售部', departmentFullPath: '销售部',
    })
    const falseTemplateDepartment = catalogDepartment({
      directoryDepartmentId: 'tmpl-false', departmentName: '模板本级', departmentFullPath: '模板本级', includeChildren: false,
    })
    let directSaved = false
    let falseScopeRemoved = false
    let templateDepartments = [falseTemplateDepartment]
    const scopeData = () => ({
      ok: true,
      data: {
        actorId: 'admin-1',
        user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
        adminNamespaces: ['crm'],
        scopeAssignments: [
          ...(falseScopeRemoved ? [] : [falseScope]),
          omittedScope,
          ...(directSaved ? [catalogDepartment({ id: 'scope-new', namespace: 'crm', includeChildren: true })] : []),
        ],
        groupAssignments: [],
      },
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string, body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], exactDepartmentScopeAvailable: false,
            roleCatalog: [], scopeAssignments: [], groupAssignments: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [catalogDepartment()] } })
      if (pathname === '/api/admin/role-delegation/member-groups') return createJsonResponse({ ok: true, data: { items: [] } })
      if (pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({
          ok: true,
          data: { items: [{ id: 'template-1', name: '华东销售', description: '', createdBy: null, updatedBy: null, createdAt: '', updatedAt: '', departmentCount: templateDepartments.length, memberGroupCount: 0 }] },
        })
      }
      if (pathname === '/api/admin/role-delegation/scope-templates/template-1') {
        return createJsonResponse({
          ok: true,
          data: { item: { id: 'template-1', name: '华东销售', description: '', departmentCount: templateDepartments.length, memberGroupCount: 0, departments: templateDepartments, memberGroups: [] } },
        })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') return createJsonResponse(scopeData())
      if (pathname.endsWith('/scopes/assign') || pathname.endsWith('/departments/assign') || pathname.endsWith('/scope-templates/apply')) {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        if (body.includeChildren === false || pathname.endsWith('/scope-templates/apply')) {
          posts.push({ path: pathname, body })
          throw new Error(`unexpected false-scope write ${pathname}`)
        }
        posts.push({ path: pathname, body })
        if (pathname.endsWith('/scopes/assign')) {
          directSaved = true
          return createJsonResponse(scopeData())
        }
        templateDepartments = [
          falseTemplateDepartment,
          catalogDepartment({ directoryDepartmentId: 'dept-1', departmentName: '可选部门', departmentFullPath: '可选部门', includeChildren: true }),
        ]
        return createJsonResponse({
          ok: true,
          data: { item: { id: 'template-1', name: '华东销售', description: '', departmentCount: 2, memberGroupCount: 0, departments: templateDepartments, memberGroups: [] } },
        })
      }
      if (pathname.endsWith('/scopes/unassign') || pathname.endsWith('/departments/unassign')) {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        posts.push({ path: pathname, body })
        if (pathname.endsWith('/scopes/unassign')) {
          falseScopeRemoved = true
          return createJsonResponse(scopeData())
        }
        templateDepartments = templateDepartments.filter((department) => department.directoryDepartmentId !== body.directoryDepartmentId)
        return createJsonResponse({
          ok: true,
          data: { item: { id: 'template-1', name: '华东销售', description: '', departmentCount: templateDepartments.length, memberGroupCount: 0, departments: templateDepartments, memberGroups: [] } },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => choiceLabels().includes('仅本部门') && choiceLabels().includes('未返回是否包含下级'))
    const scopeBox = container!.querySelector('[data-testid="scope-include-children"]') as HTMLInputElement
    expect(scopeBox.checked).toBe(true)
    expect(scopeBox.disabled).toBe(true)
    expect(container?.querySelector('[data-testid="scope-include-children-value"]')?.textContent).toContain('包含下级部门')
    expect(container?.textContent).toContain('当前不能新建仅本部门的范围')
    expect(container?.textContent).not.toContain('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED')
    scopeBox.checked = false
    scopeBox.dispatchEvent(new Event('change'))
    await flushUi()
    expect(scopeBox.checked).toBe(true)
    selectControl('crm').value = 'crm'
    selectControl('crm').dispatchEvent(new Event('change'))
    const departmentSelect = selectControl('可选部门')
    departmentSelect.value = 'dept-1'
    departmentSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '添加部门范围').click()
    await waitForCondition(() => posts.some((post) => post.path.endsWith('/scopes/assign')) && statusText().includes('插件管理员部门范围已添加'))
    expect(posts.find((post) => post.path.endsWith('/scopes/assign'))?.body).toEqual({
      namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: true,
    })
    expect(choiceLabels().some((label) => label.includes('仅本部门'))).toBe(true)

    selectControl('华东销售').value = 'template-1'
    selectControl('华东销售').dispatchEvent(new Event('change'))
    await waitForCondition(() => (container?.textContent || '').includes('模板本级') && Boolean(container?.querySelector('[data-testid="template-include-children"]')))
    const templateBox = container!.querySelector('[data-testid="template-include-children"]') as HTMLInputElement
    expect(templateBox.checked).toBe(true)
    expect(templateBox.disabled).toBe(true)
    expect(container?.querySelector('[data-testid="template-include-children-value"]')?.textContent).toContain('包含下级部门')
    const templateChoices = Array.from(container!.querySelectorAll('.delegation-page__scope-card')).filter((card) => card.textContent?.includes('模板本级'))
    expect(templateChoices.some((card) => card.querySelector('[data-testid="department-scope-choice"]')?.textContent?.includes('仅本部门'))).toBe(true)
    templateBox.checked = false
    templateBox.dispatchEvent(new Event('change'))
    await flushUi()
    expect(templateBox.checked).toBe(true)
    const applyButton = findButtonByText(container!, '覆盖应用到当前命名空间')
    expect(applyButton.disabled).toBe(true)
    expect(container?.querySelector('[data-testid="exact-department-apply-unavailable"]')?.textContent).toContain('这个模板含有仅本部门的范围')
    applyButton.click()
    await flushUi(4)
    expect(posts.some((post) => post.path.includes('/scope-templates/apply'))).toBe(false)
    expect(callLog.some((url) => url.includes('/scope-templates/apply'))).toBe(false)

    selectControl('选择部门加入模板').value = 'dept-1'
    selectControl('选择部门加入模板').dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '添加模板部门').click()
    await waitForCondition(() => posts.some((post) => post.path.endsWith('/departments/assign')))
    expect(posts.find((post) => post.path.endsWith('/departments/assign'))?.body).toEqual({
      directoryDepartmentId: 'dept-1', includeChildren: true,
    })
    expect(posts.some((post) => post.body.includeChildren === false)).toBe(false)
    await waitForCondition(() => statusText().includes('模板部门已添加') && !findButtonByText(container!, '移除部门范围').disabled)

    findButtonByText(container!, '移除部门范围').click()
    await waitForCondition(() => posts.some((post) => post.path.endsWith('/scopes/unassign')))
    expect(posts.find((post) => post.path.endsWith('/scopes/unassign'))?.body).toEqual({
      namespace: 'crm', directoryDepartmentId: 'dept-false',
    })
    expect(posts.find((post) => post.path.endsWith('/scopes/unassign'))?.body).not.toHaveProperty('includeChildren')
    await waitForCondition(() => statusText().includes('插件管理员部门范围已移除') && !findButtonByText(container!, '移除模板部门').disabled)

    findButtonByText(container!, '移除模板部门').click()
    await waitForCondition(() => posts.some((post) => post.path.endsWith('/departments/unassign')))
    expect(posts.find((post) => post.path.endsWith('/departments/unassign'))?.body).toEqual({ directoryDepartmentId: 'tmpl-false' })
    expect(posts.find((post) => post.path.endsWith('/departments/unassign'))?.body).not.toHaveProperty('includeChildren')
    await waitForCondition(() => statusText().includes('模板部门已移除'))
  })

  it('still applies a template that has no exact department while availability is off', async () => {
    const posts: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string, body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [] } })
      if (pathname === '/api/admin/role-delegation/member-groups') return createJsonResponse({ ok: true, data: { items: [] } })
      if (pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'template-true', name: '含下级模板', description: '', createdBy: null, updatedBy: null, createdAt: '', updatedAt: '', departmentCount: 1, memberGroupCount: 0 }] } })
      }
      if (pathname === '/api/admin/role-delegation/scope-templates/template-true') {
        return createJsonResponse({
          ok: true,
          data: {
            item: {
              id: 'template-true', name: '含下级模板', description: '', departmentCount: 1, memberGroupCount: 0,
              departments: [catalogDepartment({ includeChildren: true, departmentName: '模板下级', departmentFullPath: '模板下级' })],
              memberGroups: [],
            },
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', user: { id: 'user-1' }, adminNamespaces: ['crm'], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname.endsWith('/scope-templates/apply')) {
        posts.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>)
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [catalogDepartment({ id: 'scope-applied', namespace: 'crm', includeChildren: true })],
            groupAssignments: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="scope-include-children"]')))
    selectControl('crm').value = 'crm'
    selectControl('crm').dispatchEvent(new Event('change'))
    selectControl('含下级模板').value = 'template-true'
    selectControl('含下级模板').dispatchEvent(new Event('change'))
    await waitForCondition(() => (container?.textContent || '').includes('模板下级'))
    const applyButton = findButtonByText(container!, '覆盖应用到当前命名空间')
    expect(applyButton.disabled).toBe(false)
    applyButton.click()
    await waitForCondition(() => posts.length === 1)
    expect(posts[0]).toEqual({ namespace: 'crm', templateId: 'template-true', mode: 'replace' })
    expect(posts[0]).not.toHaveProperty('includeChildren')
    await waitForCondition(() => statusText().includes('范围模板已覆盖应用到该插件管理员命名空间'))
  })

  it('explains a stale exact-department 403 and still allows an explicit include-descendants write', async () => {
    const posts: Array<Record<string, unknown>> = []
    const falseScope = catalogDepartment({
      id: 'scope-false', namespace: 'crm', directoryDepartmentId: 'dept-false', departmentName: '财务部', departmentFullPath: '财务部', includeChildren: false,
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string, body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({
          ok: true,
          data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], exactDepartmentScopeAvailable: true, roleCatalog: [], scopeAssignments: [], groupAssignments: [] },
        })
      }
      if (pathname === '/api/admin/role-delegation/departments') return createJsonResponse({ ok: true, data: { items: [catalogDepartment()] } })
      if (pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: [], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [falseScope],
            groupAssignments: [],
          },
        })
      }
      if (pathname.endsWith('/scopes/assign')) {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        posts.push(body)
        if (body.includeChildren === false) {
          return createJsonResponse({
            ok: false,
            error: { code: 'DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED', message: 'Exact department scope is disabled' },
          }, 403)
        }
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: [falseScope, catalogDepartment({ id: 'scope-new', namespace: 'crm', includeChildren: true })],
            groupAssignments: [],
          },
        })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => choiceLabels().includes('仅本部门') && Boolean(container?.querySelector('[data-testid="scope-include-children"]')))
    selectControl('crm').value = 'crm'
    selectControl('crm').dispatchEvent(new Event('change'))
    selectControl('可选部门').value = 'dept-1'
    selectControl('可选部门').dispatchEvent(new Event('change'))
    await flushUi()
    const scopeBox = container!.querySelector('[data-testid="scope-include-children"]') as HTMLInputElement
    expect(scopeBox.disabled).toBe(false)
    scopeBox.checked = false
    scopeBox.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container?.querySelector('[data-testid="scope-include-children-value"]')?.textContent).toContain('仅本部门')
    findButtonByText(container!, '添加部门范围').click()
    await waitForCondition(() => statusText().includes('当前不能新建仅本部门的范围'))
    expect(posts).toEqual([{ namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: false }])
    expect(statusText()).not.toContain('插件管理员部门范围已添加')
    expect(statusText()).not.toContain('Exact department scope is disabled')
    expect(container?.textContent).not.toContain('DELEGATED_SCOPE_EXACT_DEPARTMENT')
    expect(choiceLabels()).toContain('仅本部门')
    expect(scopeBox.disabled).toBe(false)
    findButtonByText(container!, '添加部门范围').click()
    await flushUi(4)
    expect(posts).toHaveLength(1)

    scopeBox.checked = true
    scopeBox.dispatchEvent(new Event('change'))
    await flushUi()
    expect(scopeBox.checked).toBe(true)
    expect(scopeBox.disabled).toBe(true)
    scopeBox.checked = false
    scopeBox.dispatchEvent(new Event('change'))
    await flushUi()
    expect(scopeBox.checked).toBe(true)
    expect(container?.querySelector('[data-testid="scope-include-children-value"]')?.textContent).toContain('包含下级部门')
    findButtonByText(container!, '添加部门范围').click()
    await waitForCondition(() => posts.length === 2)
    expect(posts[1]).toEqual({ namespace: 'crm', directoryDepartmentId: 'dept-1', includeChildren: true })
    await waitForCondition(() => statusText().includes('插件管理员部门范围已添加'))
    expect(choiceLabels()).toContain('仅本部门')
  })

  function detailHeading(): string {
    return container?.querySelector('.delegation-page__panel--detail h2')?.textContent || ''
  }

  function mountPlain(): void {
    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
  }

  function accessPayload(id: string, name: string, email: string) {
    return {
      actorId: 'admin-1',
      isPlatformAdmin: false,
      delegableNamespaces: ['crm'],
      roleCatalog: [],
      user: { id, email, name, role: 'user', is_active: true },
      roles: [],
      memberGroups: [],
      delegableRoles: [],
      namespaceAdmissions: [],
    }
  }

  it('does not select the first member when the management scope page opens', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: accessPayload('user-1', 'Alpha', 'alpha@example.com') })
      if (pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessPayload('user-2', 'Bravo', 'bravo@example.com') })
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    mountPlain()
    await waitForMemberListSettled()
    expect(container?.querySelector('.delegation-page__user--active')).toBeNull()
    expect(container?.querySelector('.delegation-page__panel--detail')?.textContent).toContain('请选择一个成员')
    expect(callLog.some((url) => url.includes('/access') || url.includes('/scopes'))).toBe(false)
    expect(apiFetchMock.mock.calls.some(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')).toBe(false)
    await selectListedMember('bravo@example.com')
    await waitForCondition(() => detailHeading().includes('Bravo'))
    expect(callLog.some((url) => url.includes('/users/user-2/access'))).toBe(true)
    expect(callLog.some((url) => url.includes('/users/user-1/access'))).toBe(false)
    expect(container?.querySelector('.delegation-page__user--active')?.textContent).toContain('Bravo')
  })

  it('clears the current member when a search page hides them and does not select the next member', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const url = new URL(rawUrl, 'http://localhost')
      if (url.pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (url.pathname === '/api/admin/role-delegation/users') {
        const items = url.searchParams.get('q') === 'bravo'
          ? [{ id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true }]
          : [
            { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
          ]
        return createJsonResponse({ ok: true, data: { items } })
      }
      if (url.pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: accessPayload('user-1', 'Alpha', 'alpha@example.com') })
      if (url.pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessPayload('user-2', 'Bravo', 'bravo@example.com') })
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    mountPlain()
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => detailHeading().includes('Alpha'))
    const searchInput = container!.querySelector('input[placeholder="搜索邮箱、姓名或用户 ID"]') as HTMLInputElement
    searchInput.value = 'bravo'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    findButtonByText(container!, '查询').click()
    await waitForMemberListSettled()
    await waitForCondition(() => callLog.some((url) => url.includes('q=bravo')) && (container?.textContent || '').includes('请选择一个成员'))
    expect(detailHeading()).toBe('')
    expect(container?.querySelector('.delegation-page__user--active')).toBeNull()
    expect(listedMemberButton('bravo@example.com')).toBeTruthy()
    expect(callLog.some((url) => url.includes('/users/user-2/access'))).toBe(false)
    expect(apiFetchMock.mock.calls.some(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')).toBe(false)
  })

  it('does not let a late user list replace a newer explicit member', async () => {
    let releaseLate: (() => void) | undefined
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve })
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const url = new URL(rawUrl, 'http://localhost')
      if (url.pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (url.pathname === '/api/admin/role-delegation/users') {
        if (url.searchParams.get('q') === 'late') {
          await lateGate
          return createJsonResponse({
            ok: true,
            data: { items: [{ id: 'user-3', email: 'charlie@example.com', name: 'Charlie', role: 'user', is_active: true }] },
          })
        }
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
              { id: 'user-3', email: 'charlie@example.com', name: 'Charlie', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (url.pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: accessPayload('user-1', 'Alpha', 'alpha@example.com') })
      if (url.pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessPayload('user-2', 'Bravo', 'bravo@example.com') })
      if (url.pathname === '/api/admin/role-delegation/users/user-3/access') return createJsonResponse({ ok: true, data: accessPayload('user-3', 'Charlie', 'charlie@example.com') })
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    mountPlain()
    await selectListedMember('bravo@example.com')
    await waitForCondition(() => detailHeading().includes('Bravo'))
    const searchInput = container!.querySelector('input[placeholder="搜索邮箱、姓名或用户 ID"]') as HTMLInputElement
    searchInput.value = 'late'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.some((url) => url.includes('q=late')))
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => detailHeading().includes('Alpha'))
    const alphaReads = callLog.filter((url) => url.includes('/users/user-1/access')).length
    const charlieReads = callLog.filter((url) => url.includes('/users/user-3/access')).length
    try {
      releaseLate?.()
      await flushUi(8)
      expect(detailHeading()).toContain('Alpha')
      expect(detailHeading()).not.toContain('Charlie')
      expect(container?.textContent).not.toContain('请选择一个成员')
      expect(callLog.filter((url) => url.includes('/users/user-1/access')).length).toBe(alphaReads)
      expect(callLog.filter((url) => url.includes('/users/user-3/access')).length).toBe(charlieReads)
      expect(apiFetchMock.mock.calls.some(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')).toBe(false)
    } finally {
      releaseLate?.()
      await flushUi(4)
    }
  })

  it('previews, posts once, and reads back each delegation action without moving the admission switch early', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    const commits: Array<ReturnType<typeof readAuthorizationBody>> = []
    const lookups: string[] = []
    let releaseRead: (() => void) | undefined
    let readGate = Promise.resolve()
    let holdAccess = false
    let roles: string[] = []
    let admissionEnabled = false
    const impact = blankImpact({
      sourceChanges: [{ source: 'role', id: 'crm_admin', operation: 'assign', changed: true }],
      admissionChanges: [
        { namespace: 'crm', before: false, after: true, cause: 'explicit' },
        { namespace: 'attendance', before: true, after: false, cause: 'role_revoke' },
      ],
      scopeCleanup: [{ namespace: 'crm', kind: 'department', id: 'dept-1' }],
      retainedOtherGrants: [{ code: 'sheet:read', sources: [{ kind: 'legacy', id: null }], effective: true }],
    })
    const access = () => ({
      actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: catalog,
      user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
      roles, memberGroups: [], delegableRoles: roles,
      namespaceAdmissions: [{ namespace: 'crm', enabled: admissionEnabled, effective: admissionEnabled, hasRole: roles.includes('crm_admin'), updatedAt: 'stamp' }],
    })
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        if (holdAccess) await readGate
        return createJsonResponse({ ok: true, data: access() })
      }
      if (isAuthorizationPreview(pathname)) return authorizationPreviewResponse(impact)
      if (isAuthorizationCommit(pathname)) {
        commits.push(readAuthorizationBody(init?.body))
        const request = commits[commits.length - 1]
        if (request?.action.kind === 'role.assign') roles = ['crm_admin']
        if (request?.action.kind === 'role.revoke') roles = []
        if (request?.action.kind === 'admission.set') admissionEnabled = request.admissionChanges[0]?.enabled === true
        // The preview above is display-only. The receipt must agree with the access read.
        return authorizationCommitResponse(init?.body)
      }
      if (pathname.startsWith(`${ADMIN_AUTHORIZATION_OPERATIONS_PATH}/`)) {
        lookups.push(pathname)
        return createJsonResponse({ status: 'unknown_or_pending', clientOperationId: pathname.split('/').pop() })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('插件使用未开通'))
    const run = async (open: () => void, action: Record<string, unknown>, admission: Array<{ namespace: string; enabled: boolean }>) => {
      const switchBefore = admissionEnabled ? '插件使用已开通' : '插件使用未开通'
      const outcome = action.kind === 'role.revoke'
        ? '角色已从该成员移除'
        : action.kind === 'role.assign'
          ? '角色已分配'
          : admission[0]?.enabled ? '已开通 crm 插件使用' : '已关闭 crm 插件使用'
      open()
      await flushUi()
      expect(container?.querySelector('[data-testid="delegation-preview-roles"]')?.textContent).toContain('分配 crm_admin')
      expect(container?.querySelector('[data-testid="delegation-preview-explicit-admissions"]')?.textContent).toContain('开通 crm')
      expect(container?.querySelector('[data-testid="delegation-preview-derived-admissions"]')?.textContent).toContain('关闭 attendance')
      expect(container?.querySelector('[data-testid="delegation-preview-scope-cleanup"]')?.textContent).toContain('crm department dept-1')
      expect(container?.querySelector('[data-testid="delegation-preview-retained"]')?.textContent).toContain('sheet:read')
      const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
      await waitForCondition(() => confirm.disabled === false)
      const commitsBefore = commits.length
      holdAccess = true
      readGate = new Promise<void>((resolve) => { releaseRead = resolve })
      confirm.click()
      await flushUi()
      expect(commits).toHaveLength(commitsBefore + 1)
      expect(container?.textContent).toContain(switchBefore)
      expect(container?.textContent).not.toContain(outcome)
      holdAccess = false
      releaseRead?.()
      const switchAfter = admissionEnabled ? '插件使用已开通' : '插件使用未开通'
      await waitForCondition(() => {
        const text = container?.textContent || ''
        return text.includes(outcome) && text.includes(switchAfter)
      })
      expect(commits[commits.length - 1]).toMatchObject({ action, admissionChanges: admission, expectedVersion: 'version-1' })
      expect(callLog.filter((url) => url.includes('/roles/') || url.includes('/namespaces/'))).toHaveLength(0)
      ;(container!.querySelector('[data-testid="delegation-confirmation-cancel"]') as HTMLButtonElement).click()
      await flushUi()
    }
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    await run(
      () => findButtonByText(container!, '分配角色').click(),
      { kind: 'role.assign', roleId: 'crm_admin' },
      [],
    )
    const revokeSelect = container!.querySelector('[data-testid="delegation-revoke-role"]') as HTMLSelectElement
    revokeSelect.value = 'crm_admin'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    await run(
      () => findButtonByText(container!, '撤销角色').click(),
      { kind: 'role.revoke', roleId: 'crm_admin' },
      [],
    )
    await run(
      () => findButtonByText(container!, '开通插件使用').click(),
      { kind: 'admission.set' },
      [{ namespace: 'crm', enabled: true }],
    )
    await run(
      () => findButtonByText(container!, '关闭插件使用').click(),
      { kind: 'admission.set' },
      [{ namespace: 'crm', enabled: false }],
    )
    expect(commits).toHaveLength(4)
    expect(lookups).toHaveLength(0)
  })

  it('recovers an unknown receipt with GET and does not post the command again', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    const posts: string[] = []
    const lookups: string[] = []
    apiFetchMock.mockImplementation(async (input: unknown, _init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (isAuthorizationPreview(pathname)) return authorizationPreviewResponse()
      if (isAuthorizationCommit(pathname)) {
        posts.push(pathname)
        return createJsonResponse({ ok: false, error: { message: 'lost' } }, 500)
      }
      if (pathname.startsWith(`${ADMIN_AUTHORIZATION_OPERATIONS_PATH}/`)) {
        lookups.push(pathname)
        const id = pathname.split('/').pop()
        return createJsonResponse({ status: 'unknown_or_pending', clientOperationId: id })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-assign-role"]')))
    const assignSelect = container!.querySelector('[data-testid="delegation-assign-role"]') as HTMLSelectElement
    assignSelect.value = 'crm_admin'
    assignSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '分配角色').click()
    await flushUi()
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirm.disabled === false)
    confirm.click()
    await waitForCondition(() => lookups.length === 1 && statusText().includes('不要再次提交'))
    expect(posts).toHaveLength(1)
    confirm.click()
    await flushUi()
    expect(posts).toHaveLength(1)
    const readAgain = container!.querySelector('[data-testid="delegation-confirmation-read-again"]') as HTMLButtonElement
    readAgain.click()
    await waitForCondition(() => lookups.length === 2)
    expect(posts).toHaveLength(1)
    expect(callLog.some((url) => url.includes('/roles/assign'))).toBe(false)
  })

  it('keeps plugin admission when a revoke receipt only cleans scope, and labels that cleanup as receipt-time', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    const impact = blankImpact({
      sourceChanges: [{ source: 'role', id: 'crm_admin', operation: 'revoke', changed: true }],
      scopeCleanup: [{ namespace: 'crm', kind: 'department', id: 'dept-1' }],
      retainedOtherGrants: [{ code: 'sheet:read', sources: [{ kind: 'legacy', id: null }], effective: true }],
    })
    let roles = ['crm_admin']
    const posts: string[] = []
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'delegate-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles, memberGroups: [], delegableRoles: roles,
            namespaceAdmissions: [{ namespace: 'crm', enabled: true, effective: true, hasRole: roles.includes('crm_admin'), updatedAt: 'stamp' }],
          },
        })
      }
      if (isAuthorizationPreview(pathname)) return authorizationPreviewResponse(impact)
      if (isAuthorizationCommit(pathname)) {
        posts.push(pathname)
        roles = []
        return authorizationCommitResponse(init?.body, impact)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => (container?.textContent || '').includes('插件使用已开通'))
    const revokeSelect = container!.querySelector('[data-testid="delegation-revoke-role"]') as HTMLSelectElement
    revokeSelect.value = 'crm_admin'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '撤销角色').click()
    await flushUi()
    expect(container?.querySelector('[data-testid="delegation-preview-scope-cleanup"]')?.textContent).toContain('crm department dept-1')
    expect(container?.querySelector('[data-testid="delegation-preview-retained"]')?.textContent).toContain('sheet:read')
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirm.disabled === false)
    confirm.click()
    await waitForCondition(() => statusText().includes('角色已从该成员移除'))
    expect(posts).toHaveLength(1)
    expect(statusText()).toContain('提交时回执记录范围清理：crm department dept-1')
    expect(statusText()).toContain('提交时回执记录其他来源')
    expect(statusText()).toContain('sheet:read')
    expect(statusText()).not.toContain('范围读取确认')
    expect(container?.textContent).toContain('插件使用已开通')
  })

  it('says scope cleanup is gone only after the scope endpoint no longer lists those ids', async () => {
    const catalog = [{ id: 'crm_admin', name: 'CRM 管理员', permissions: ['crm:read'], updatedAt: 'stamp-1' }]
    const impact = blankImpact({
      scopeCleanup: [{ namespace: 'crm', kind: 'department', id: 'dept-1' }],
    })
    let roles = ['crm_admin']
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], roleCatalog: catalog, scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/departments' || pathname === '/api/admin/role-delegation/member-groups' || pathname === '/api/admin/role-delegation/scope-templates') {
        return createJsonResponse({ ok: true, data: { items: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: true, delegableNamespaces: ['crm'], manageableNamespaces: ['crm'], roleCatalog: catalog,
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles, memberGroups: [], delegableRoles: roles,
            namespaceAdmissions: [{ namespace: 'crm', enabled: true, effective: false, hasRole: roles.includes('crm_admin'), updatedAt: 'stamp' }],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/scopes') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1',
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            adminNamespaces: ['crm'],
            scopeAssignments: roles.length > 0
              ? [{ id: 'scope-1', namespace: 'crm', directoryDepartmentId: 'dept-1', integrationId: 'ding', integrationName: '目录', provider: 'dingtalk', corpId: null, externalDepartmentId: 'ext-1', departmentName: '旧部门', departmentFullPath: null, departmentActive: true }]
              : [],
            groupAssignments: [],
          },
        })
      }
      if (isAuthorizationPreview(pathname)) return authorizationPreviewResponse(impact)
      if (isAuthorizationCommit(pathname)) {
        roles = []
        return authorizationCommitResponse(init?.body, impact)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => Boolean(container?.querySelector('[data-testid="delegation-revoke-role"]')))
    const revokeSelect = container!.querySelector('[data-testid="delegation-revoke-role"]') as HTMLSelectElement
    revokeSelect.value = 'crm_admin'
    revokeSelect.dispatchEvent(new Event('change'))
    await flushUi()
    findButtonByText(container!, '撤销角色').click()
    await flushUi()
    const confirm = container!.querySelector('[data-testid="delegation-confirmation-confirm"]') as HTMLButtonElement
    await waitForCondition(() => confirm.disabled === false)
    confirm.click()
    await waitForCondition(() => statusText().includes('范围读取确认这些项已不在：crm department dept-1'))
    expect(statusText()).toContain('角色已从该成员移除')
    expect(statusText()).not.toContain('提交时回执记录范围清理')
    expect(callLog.filter((url) => url.includes('/users/user-1/scopes')).length).toBeGreaterThan(1)
  })

  it('does not verify or replay a restored direct grant receipt', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    sessionStorage.setItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY, JSON.stringify({
      formatVersion: 1,
      entries: [{ principalId: 'admin-1', targetId: 'user-1', clientOperationId: operationId }],
    }))
    const lookups: string[] = []
    const posts: string[] = []
    apiFetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({ ok: true, data: { items: [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }] } })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') {
        return createJsonResponse({
          ok: true,
          data: {
            actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [],
            user: { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            roles: [], memberGroups: [], delegableRoles: [], namespaceAdmissions: [],
          },
        })
      }
      if (pathname === `${ADMIN_AUTHORIZATION_OPERATIONS_PATH}/${operationId}` && init?.method !== 'POST') {
        lookups.push(pathname)
        return createJsonResponse({
          status: 'committed',
          clientOperationId: operationId,
          receipt: {
            targetUserId: 'user-1',
            action: { kind: 'direct.grant', code: 'sheet:write' },
            impact: blankImpact(),
            resultVersion: 'result-1',
          },
        })
      }
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        posts.push(pathname)
        throw new Error(`unexpected write ${rawUrl}`)
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    await mountDelegation()
    await waitForCondition(() => statusText().includes('直接授权 sheet:write') && statusText().includes('不要再次提交'))
    expect(posts).toHaveLength(0)
    expect(lookups).toHaveLength(1)
    expect(container?.querySelector('[data-testid="delegation-confirmation"]')).toBeNull()
    ;(container!.querySelector('[data-testid="delegation-restored-read-again"]') as HTMLButtonElement).click()
    await waitForCondition(() => lookups.length === 2)
    expect(posts).toHaveLength(0)
    expect(statusText()).toContain('不能确认这个回执')
  })

  it('opens the member named by the userId query and does not select the first listed member', async () => {
    window.history.replaceState({}, '', '/admin/role-delegation?userId=user-2&source=members#scope')
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: accessPayload('user-1', 'Alpha', 'alpha@example.com') })
      if (pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessPayload('user-2', 'Bravo', 'bravo@example.com') })
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    mountPlain()
    await waitForCondition(() => detailHeading().includes('Bravo'))
    expect(callLog.some((url) => url.includes('/users/user-1/access'))).toBe(false)
    expect(callLog.filter((url) => url.includes('/users/user-2/access'))).toHaveLength(1)
    expect(container?.querySelector('.delegation-page__user--active')?.textContent).toContain('Bravo')
    expect(container?.querySelector('.delegation-page__panel--detail')?.textContent).not.toContain('请选择一个成员')
    expect(window.location.search).toContain('userId=user-2')
    expect(apiFetchMock.mock.calls.some(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')).toBe(false)
  })

  it('keeps an explicitly selected member when a refresh still lists that member', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const rawUrl = String(input)
      callLog.push(rawUrl)
      const { pathname } = new URL(rawUrl, 'http://localhost')
      if (pathname === '/api/admin/role-delegation/summary') {
        return createJsonResponse({ ok: true, data: { actorId: 'admin-1', isPlatformAdmin: false, delegableNamespaces: ['crm'], roleCatalog: [], scopeAssignments: [], groupAssignments: [] } })
      }
      if (pathname === '/api/admin/role-delegation/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/admin/role-delegation/users/user-1/access') return createJsonResponse({ ok: true, data: accessPayload('user-1', 'Alpha', 'alpha@example.com') })
      if (pathname === '/api/admin/role-delegation/users/user-2/access') return createJsonResponse({ ok: true, data: accessPayload('user-2', 'Bravo', 'bravo@example.com') })
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })
    mountPlain()
    await selectListedMember('alpha@example.com')
    await waitForCondition(() => detailHeading().includes('Alpha'))
    const alphaReads = callLog.filter((url) => url.includes('/users/user-1/access')).length
    findButtonByText(container!, '查询').click()
    await waitForCondition(() => callLog.filter((url) => url.includes('/api/admin/role-delegation/users')).length >= 2)
    await waitForMemberListSettled()
    expect(detailHeading()).toContain('Alpha')
    expect(container?.querySelector('.delegation-page__user--active')?.textContent).toContain('Alpha')
    expect(callLog.filter((url) => url.includes('/users/user-1/access')).length).toBe(alphaReads)
    expect(callLog.some((url) => url.includes('/users/user-2/access'))).toBe(false)
  })
})
