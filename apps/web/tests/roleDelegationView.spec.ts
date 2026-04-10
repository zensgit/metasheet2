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

  async function mountView(): Promise<void> {
    app = createApp(RoleDelegationView)
    app.component('RouterLink', {
      props: ['to'],
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
})
