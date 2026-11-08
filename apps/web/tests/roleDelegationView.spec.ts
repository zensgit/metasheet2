/* eslint-disable vue/one-component-per-file -- Tests mount isolated apps with local component stubs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RoleDelegationView from '../src/views/RoleDelegationView.vue'

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

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

function createApiImplementation(callLog: string[]) {
  return async (input: unknown) => {
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
              enabled: false,
              effective: false,
              hasRole: true,
              updatedAt: '2026-04-09T00:00:00.000Z',
            },
          ],
        },
      })
    }

    if (pathname === '/api/admin/role-delegation/users/user-1/namespaces/crm/admission') {
      return createJsonResponse({
        ok: true,
        data: {
          namespaceAdmissions: [
            {
              namespace: 'crm',
              enabled: true,
              effective: true,
              hasRole: true,
              updatedAt: '2026-04-10T00:00:00.000Z',
            },
          ],
        },
      })
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

  async function mountView(): Promise<void> {
    app = createApp(RoleDelegationView)
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await waitForCondition(() => callLog.includes('/api/admin/role-delegation/users/user-1/scopes'))
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
      if (pathname === '/api/admin/role-delegation/users/user-1/roles/unassign' && init?.method === 'POST') {
        posts.push({ path: pathname, body: JSON.parse(String(init.body)) })
        access = delegateAccess(['attendance_employee'])
        return createJsonResponse({ ok: true, data: access })
      }
      throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
    })

    app = createApp(RoleDelegationView)
    app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a><slot /></a>' })
    app.mount(container!)
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
    await waitForCondition(() => posts.length === 1)
    expect(posts[0]).toEqual({ path: '/api/admin/role-delegation/users/user-1/roles/unassign', body: { roleId: 'plugin_elearning_viewer' } })
    await waitForCondition(() => !optionValues('delegation-revoke-role').includes('plugin_elearning_viewer'))
    await flushUi()
    expect(revokeSelect.value).toBe('')
    // The revoked pick is cleared, not merely hidden: the button cannot re-send it.
    expect(revokeButton.disabled).toBe(true)
    expect(container?.textContent).toContain('角色已撤销')
  })

  it('shows namespace admission controls for delegated members and can toggle plugin usage', async () => {
    await mountView()

    expect(container?.textContent).toContain('插件使用准入')
    expect(container?.textContent).toContain('插件使用未开通')
    expect(container?.textContent).toContain('当前不可用')

    findButtonByText(container!, '开通插件使用').click()
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/role-delegation/users/user-1/namespaces/crm/admission')))

    expect(container?.textContent).toContain('已开通 crm 插件使用')
    expect(container?.textContent).toContain('当前实际可用')
  })

  it('explains management scope without treating plugin admission as a delegate prerequisite', async () => {
    await mountView()
    const explanation = container?.querySelector('[data-testid="scope-explanation"]')?.textContent || ''
    expect(explanation).toContain('部门范围包含该部门及其下级')
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
})
