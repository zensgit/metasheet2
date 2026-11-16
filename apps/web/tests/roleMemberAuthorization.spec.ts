/**
 * Role member add/remove on the roles page.
 * Confirmation is frozen to the user and role shown in the dialog. The write is the
 * existing assign/unassign route, checked with the shared readback helper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import RoleManagementView from '../src/views/RoleManagementView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

const PERMISSIONS = [
  { code: 'attendance:read', name: 'Attendance Read', description: 'Read attendance records and summaries' },
  { code: 'stock-prep:read', name: 'Stock Prep Read', description: null },
  { code: 'custom:note', name: 'Floor only', description: 'Keep this note', category: '现场' },
]

type RoleRow = {
  id: string
  name: string
  permissions: string[]
  memberCount: number
  updatedAt?: string | null
  admissionNamespaces?: unknown
}

const UPDATED_AT = '2026-11-11T03:04:05.000Z'

function roleRow(overrides: Partial<RoleRow> & Pick<RoleRow, 'id' | 'name'>): RoleRow {
  return {
    permissions: [],
    memberCount: 1,
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function accessBody(userId: string, roles: string[], name = '甲一') {
  return {
    ok: true,
    data: {
      user: { id: userId, name },
      roles,
      permissions: ['attendance:read'],
      isAdmin: roles.includes('admin'),
    },
  }
}

function writeBody(input: {
  userId: string
  roleId: string
  held: boolean
  changed: boolean
  roles?: string[]
}) {
  return {
    ok: true,
    data: {
      user: { id: input.userId, name: '甲一' },
      roles: input.roles ?? (input.held ? [input.roleId] : []),
      permissions: ['attendance:read'],
      isAdmin: false,
      changedRoleId: input.roleId,
      roleHeld: input.held,
      membershipChanged: input.changed,
      actorId: 'actor-1',
    },
  }
}

type Deferred = {
  resolve: (value: ReturnType<typeof jsonResponse>) => void
  reject: (reason?: unknown) => void
}

function defer(bucket: Deferred[]): Promise<ReturnType<typeof jsonResponse>> {
  return new Promise((resolve, reject) => {
    bucket.push({ resolve, reject })
  })
}

async function flushUi(cycles = 12): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let container: HTMLElement | null = null
let app: App<Element> | null = null
let router: Router | null = null

function rootText(): string {
  return container?.textContent || ''
}

function feedback(): string {
  return container?.querySelector('.role-members__feedback')?.textContent?.trim() || ''
}

function postCalls(): Array<{ url: string; body: Record<string, unknown> | null }> {
  return apiFetchMock.mock.calls.flatMap((call) => {
    const [url, init] = call as [unknown, { method?: string; body?: string } | undefined]
    if (init?.method !== 'POST') return []
    return [{ url: String(url), body: init.body ? JSON.parse(init.body) as Record<string, unknown> : null }]
  })
}

function memberGets(): string[] {
  return apiFetchMock.mock.calls.flatMap((call) => {
    const url = String(call[0])
    const init = call[1] as { method?: string } | undefined
    if (init?.method && init.method !== 'GET') return []
    if (!url.includes('/members')) return []
    return [url]
  })
}

function roleGets(): number {
  return apiFetchMock.mock.calls.filter((call) => String(call[0]) === '/api/admin/roles' && !(call[1] as { method?: string } | undefined)?.method).length
}

function roleButton(id: string): HTMLButtonElement {
  const button = Array.from(container?.querySelectorAll('.admin-page__item') || []).find((item) => (
    item.querySelector('span')?.textContent === id
  ))
  if (!button) throw new Error(`role ${id} not found`)
  return button as HTMLButtonElement
}

function memberRow(id: string): HTMLButtonElement {
  const button = container?.querySelector(`[data-role-member-row][data-user-id="${id}"]`)
  if (!button) throw new Error(`member ${id} not found`)
  return button as HTMLButtonElement
}

function candidateRow(id: string): HTMLButtonElement {
  const button = container?.querySelector(`[data-role-member-candidate][data-user-id="${id}"]`)
  if (!button) throw new Error(`candidate ${id} not found`)
  return button as HTMLButtonElement
}

async function selectMember(id: string): Promise<void> {
  memberRow(id).click()
  // Add and remove stay disabled until this selection renders.
  await flushUi()
}

function clickAdd(): void {
  const button = container?.querySelector('[data-role-member-add]') as HTMLButtonElement | null
  if (!button) throw new Error('add button missing')
  button.click()
}

function clickRemove(): void {
  const button = container?.querySelector('[data-role-member-remove]') as HTMLButtonElement | null
  if (!button) throw new Error('remove button missing')
  button.click()
}

function confirmButton(): HTMLButtonElement {
  const button = container?.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement | null
  if (!button) throw new Error('confirm button missing')
  return button
}

function cancelButton(): HTMLButtonElement {
  const button = container?.querySelector('[data-testid="admin-authorization-cancel"]') as HTMLButtonElement | null
  if (!button) throw new Error('cancel button missing')
  return button
}

function dialogText(): string {
  return container?.querySelector('[data-testid="admin-authorization-dialog"]')?.textContent || ''
}

function setPhrase(value: string): void {
  const input = container?.querySelector('[data-testid="admin-authorization-phrase"]') as HTMLInputElement | null
  if (!input) throw new Error('phrase input missing')
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function nameInput(): HTMLInputElement {
  const input = container?.querySelector('[data-role-name-input]') as HTMLInputElement | null
  if (!input) throw new Error('name input missing')
  return input
}

function permissionBox(code: string): HTMLInputElement {
  const input = container?.querySelector(`[data-permission-code="${code}"] input`) as HTMLInputElement | null
  if (!input) throw new Error(`checkbox ${code} missing`)
  return input
}

function activeCount(): string {
  return container?.querySelector('.admin-page__item--active small')?.textContent?.trim() || ''
}

async function mountView(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(RoleManagementView)
  app.mount(container)
  await flushUi()
}

async function mountRouted(query: Record<string, string>): Promise<void> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/admin/roles', component: RoleManagementView }],
  })
  await router.push({ path: '/admin/roles', query })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({ render: () => h(RouterView) })
  app.use(router)
  app.mount(container)
  await router.isReady()
  await flushUi()
}

function install(options: {
  roles: RoleRow[]
  members?: (roleId: string, page: number) => { items: Array<{ id: string; displayName: string; email?: string }>; total: number } | Promise<{ items: Array<{ id: string; displayName: string; email?: string }>; total: number }>
  access?: (userId: string) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>
  search?: (url: string) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>
  onPost?: (url: string, body: Record<string, unknown>) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>
}): void {
  apiFetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET'
    if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
    if (url === '/api/admin/roles' && method === 'GET') {
      return jsonResponse({ ok: true, data: { items: options.roles, total: options.roles.length } })
    }
    if (method === 'POST' && url.includes('/roles/')) {
      const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (!options.onPost) throw new Error(`unexpected post ${url}`)
      return options.onPost(url, body)
    }
    const members = url.match(/^\/api\/admin\/roles\/([^/]+)\/members/)
    if (members && method === 'GET') {
      const roleId = decodeURIComponent(members[1] || '')
      const page = Number(new URL(url, 'http://local.test').searchParams.get('page') || '1')
      const pageData = await Promise.resolve(options.members?.(roleId, page) ?? { items: [], total: 0 })
      return jsonResponse({ ok: true, data: { items: pageData.items, page, pageSize: 20, total: pageData.total } })
    }
    const access = url.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
    if (access && method === 'GET') {
      if (!options.access) throw new Error(`unexpected access ${url}`)
      return options.access(decodeURIComponent(access[1] || ''))
    }
    if (url.startsWith('/api/admin/users?') && method === 'GET') {
      if (!options.search) throw new Error(`unexpected search ${url}`)
      return options.search(url)
    }
    throw new Error(`unexpected call ${method} ${url}`)
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  router = null
  container?.remove()
  container = null
})

describe('RoleManagementView member authorization', () => {
  it('groups permissions with the business name first and the code second', async () => {
    install({
      roles: [roleRow({ id: 'attendance_admin', name: 'Attendance Admin', permissions: ['attendance:read'] })],
    })
    await mountView()
    const attendance = container?.querySelector('[data-permission-group="attendance"]')
    const custom = container?.querySelector('[data-permission-group="现场"]')
    expect(attendance?.querySelector('h4')?.textContent).toContain('考勤')
    expect(attendance?.querySelector('h4')?.textContent).toContain('attendance')
    expect(attendance?.querySelector('strong')?.textContent).toBe('考勤读取')
    expect(attendance?.querySelector('[data-permission-code="attendance:read"] .admin-page__technical-code')?.textContent).toContain('attendance:read')
    expect(attendance?.textContent).not.toContain('Attendance Read')
    expect(custom?.textContent).toContain('Floor only')
    expect(custom?.textContent).toContain('custom:note')
    expect(attendance?.textContent).not.toContain('Floor only')
  })

  it('does not select the first member, and a deep link only selects the requested role and user', async () => {
    install({
      roles: [
        roleRow({ id: 'attendance_admin', name: 'Attendance Admin', permissions: ['attendance:read'], memberCount: 2 }),
        roleRow({ id: 'other-role', name: 'Other', memberCount: 1 }),
      ],
      members: () => ({
        items: [
          { id: 'user-1', displayName: '甲一', email: 'secret@example.test' },
          { id: 'user-2', displayName: '甲二' },
        ],
        total: 2,
      }),
      access: (userId) => jsonResponse(accessBody(userId, ['attendance_admin'], '深链甲')),
    })
    await mountView()
    roleButton('attendance_admin').click()
    await flushUi()
    expect(rootText()).toContain('尚未选择用户')
    expect(container?.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(rootText()).not.toContain('secret@example.test')
    expect(postCalls()).toHaveLength(0)

    app?.unmount()
    container?.remove()
    await mountRouted({ roleId: 'attendance_admin', userId: 'user-9' })
    expect(container?.querySelector('.admin-page__item--active span')?.textContent).toBe('attendance_admin')
    expect(container?.querySelector('.role-members__selected')?.getAttribute('data-user-id')).toBe('user-9')
    expect(rootText()).toContain('深链甲')
    expect(postCalls()).toHaveLength(0)

    app?.unmount()
    container?.remove()
    await mountRouted({ roleId: 'missing-role', userId: 'user-9' })
    expect(container?.querySelector('.admin-page__item--active')).toBeNull()
    expect(rootText()).toContain('没有打开角色 missing-role')
    expect(rootText()).not.toContain('深链甲')
    expect(postCalls()).toHaveLength(0)
  })

  it('ignores a stale deep-link access reply when the route moves A to B to A', async () => {
    const pending: Deferred[] = []
    install({
      roles: [
        roleRow({ id: 'role-a', name: 'Role A', memberCount: 1 }),
        roleRow({ id: 'role-b', name: 'Role B', memberCount: 1 }),
      ],
      members: (roleId) => ({ items: [{ id: `${roleId}-member`, displayName: roleId }], total: 1 }),
      access: () => defer(pending),
    })
    await mountRouted({ roleId: 'role-a', userId: 'user-a' })
    if (!router) throw new Error('router missing')
    await router.replace({ path: '/admin/roles', query: { roleId: 'role-b', userId: 'user-b' } })
    await flushUi()
    await router.replace({ path: '/admin/roles', query: { roleId: 'role-a', userId: 'user-a' } })
    await flushUi()
    expect(pending.length).toBeGreaterThanOrEqual(3)
    const oldest = pending[0]
    const newest = pending[pending.length - 1]
    if (!oldest || !newest) throw new Error('expected deferred access reads')
    newest.resolve(jsonResponse(accessBody('user-a', ['role-a'], '当前甲')))
    await flushUi()
    expect(container?.querySelector('.role-members__selected')?.textContent).toContain('当前甲')
    oldest.resolve(jsonResponse(accessBody('user-a', ['role-a'], '过期甲')))
    await flushUi()
    expect(rootText()).toContain('当前甲')
    expect(rootText()).not.toContain('过期甲')
    expect(postCalls()).toHaveLength(0)
  })

  it('searches and pages users without selecting the first result or writing', async () => {
    const seen: string[] = []
    install({
      roles: [roleRow({ id: 'attendance_admin', name: 'Attendance Admin', permissions: ['attendance:read'] })],
      members: () => ({ items: [], total: 0 }),
      search: (url) => {
        seen.push(url)
        const page = Number(new URL(url, 'http://local.test').searchParams.get('page') || '1')
        if (page === 1) {
          return jsonResponse({
            ok: true,
            data: {
              items: [
                { id: 'user-1', name: '甲一', email: 'secret@example.test' },
                { id: 'user-2', name: '甲二', email: 'other@example.test' },
              ],
              page: 1,
              pageSize: 20,
              total: 21,
            },
          })
        }
        return jsonResponse({
          ok: true,
          data: {
            items: [{ id: 'user-3', name: '乙三', email: 'secret@example.test' }],
            page: 2,
            pageSize: 20,
            total: 21,
          },
        })
      },
    })
    await mountView()
    roleButton('attendance_admin').click()
    await flushUi()
    const query = container?.querySelector('[data-role-member-query]') as HTMLInputElement
    query.value = '甲'
    query.dispatchEvent(new Event('input'))
    ;(container?.querySelector('[data-role-member-search]') as HTMLButtonElement).click()
    await flushUi()
    expect(seen[0]).toContain('q=%E7%94%B2')
    expect(seen[0]).toContain('page=1')
    expect(seen[0]).toContain('pageSize=20')
    expect(container?.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(rootText()).not.toContain('secret@example.test')
    candidateRow('user-2').click()
    await flushUi()
    expect(container?.querySelector('.role-members__selected')?.getAttribute('data-user-id')).toBe('user-2')
    expect(postCalls()).toHaveLength(0)
    ;(container?.querySelector('.role-members__search-next') as HTMLButtonElement).click()
    await flushUi()
    expect(seen.at(-1)).toContain('page=2')
    expect(container?.querySelector('[data-role-member-candidate][aria-pressed="true"]')).toBeNull()
    expect(rootText()).toContain('乙三')
    expect(postCalls()).toHaveLength(0)
  })

  it('does not post until confirm, and cancel or a wrong platform-admin phrase writes nothing', async () => {
    install({
      roles: [
        roleRow({
          id: 'attendance_admin',
          name: 'Attendance Admin',
          permissions: ['attendance:read'],
          admissionNamespaces: ['attendance'],
        }),
        roleRow({ id: 'admin', name: 'admin', permissions: [], memberCount: 1, admissionNamespaces: [] }),
      ],
      members: (roleId) => ({
        items: [{ id: 'user-1', displayName: '甲一' }],
        total: roleId === 'admin' ? 1 : 1,
      }),
      access: (userId) => jsonResponse(accessBody(userId, ['attendance_admin'])),
      onPost: () => jsonResponse(writeBody({ userId: 'user-1', roleId: 'attendance_admin', held: true, changed: true })),
    })
    await mountView()
    roleButton('attendance_admin').click()
    await flushUi()
    await selectMember('user-1')
    clickAdd()
    await flushUi()
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    expect(dialogText()).toContain('attendance:read')
    expect(dialogText()).toContain('不写入直接权限')
    expect(dialogText()).toContain('也不开通插件使用')
    expect(container?.querySelector('[data-testid="admin-authorization-direct-permissions"]')?.textContent).toContain('无')
    expect(postCalls()).toHaveLength(0)
    cancelButton().click()
    await flushUi()
    expect(postCalls()).toHaveLength(0)
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()

    roleButton('admin').click()
    await flushUi()
    await selectMember('user-1')
    clickRemove()
    await flushUi()
    expect(dialogText()).toContain('取消平台管理员')
    setPhrase('取消')
    await flushUi()
    expect(confirmButton().disabled).toBe(true)
    confirmButton().click()
    confirmButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()
    expect(postCalls()).toHaveLength(0)
    expect(permissionBox('attendance:read').checked).toBe(false)
  })

  it('assigns with the catalog token and reloads the readback without clearing later editor edits', async () => {
    const pending: Deferred[] = []
    let memberReads = 0
    install({
      roles: [roleRow({
        id: 'attendance_admin',
        name: 'Attendance Admin',
        permissions: ['attendance:read'],
        memberCount: 1,
        admissionNamespaces: ['attendance'],
      })],
      members: () => {
        memberReads += 1
        if (memberReads > 1) {
          return {
            items: [{ id: 'user-1', displayName: '甲一' }, { id: 'user-9', displayName: '新成员' }],
            total: 2,
          }
        }
        return { items: [{ id: 'user-1', displayName: '甲一' }], total: 1 }
      },
      access: (userId) => jsonResponse(accessBody(userId, [])),
      onPost: () => defer(pending),
    })

    await mountView()
    roleButton('attendance_admin').click()
    await flushUi()
    const readsBefore = roleGets()
    await selectMember('user-1')
    clickAdd()
    await flushUi()
    expect(postCalls()).toHaveLength(0)
    confirmButton().click()
    expect(postCalls()).toHaveLength(1)
    expect(postCalls()[0]?.url).toBe('/api/admin/users/user-1/roles/assign')
    expect(postCalls()[0]?.body).toEqual({ roleId: 'attendance_admin', expectedUpdatedAt: UPDATED_AT })
    nameInput().value = '临时名称'
    nameInput().dispatchEvent(new Event('input'))
    permissionBox('custom:note').checked = true
    permissionBox('custom:note').dispatchEvent(new Event('change'))
    await flushUi()
    pending[0]?.resolve(jsonResponse(writeBody({ userId: 'user-1', roleId: 'attendance_admin', held: true, changed: true })))
    await flushUi()
    expect(feedback()).toContain('已分配角色 attendance_admin')
    expect(feedback()).toContain('用户 user-1')
    expect(activeCount()).toBe('成员数：2')
    expect(rootText()).toContain('新成员')
    expect(nameInput().value).toBe('临时名称')
    expect(permissionBox('attendance:read').checked).toBe(true)
    expect(permissionBox('custom:note').checked).toBe(true)
    expect(roleGets()).toBe(readsBefore)
  })

  it('omits the version token when the catalog has none, and an incomplete readback does not change the count', async () => {
    install({
      roles: [roleRow({
        id: 'custom-role',
        name: 'Floor Captain',
        permissions: ['custom:note'],
        memberCount: 4,
        updatedAt: null,
      })],
      members: () => ({ items: [{ id: 'user-4', displayName: '丁' }], total: 4 }),
      access: (userId) => jsonResponse(accessBody(userId, [], '丁')),
      onPost: (_url, body) => {
        expect(body).toEqual({ roleId: 'custom-role' })
        return jsonResponse({ ok: true, data: { user: { id: 'user-4' } } })
      },
    })
    await mountView()
    roleButton('custom-role').click()
    await flushUi()
    expect(activeCount()).toBe('成员数：4')
    await selectMember('user-4')
    clickAdd()
    await flushUi()
    confirmButton().click()
    await flushUi()
    expect(postCalls()).toHaveLength(1)
    expect(feedback()).toContain('角色回读不完整')
    expect(activeCount()).toBe('成员数：4')
    expect(rootText()).toContain('丁')
    expect(container?.querySelector('.role-members__selected')?.getAttribute('data-user-id')).toBe('user-4')
  })

  it('unassign lists a possible admission close, and unknown metadata does not claim there is no change', async () => {
    install({
      roles: [
        roleRow({
          id: 'stock-prep_admin',
          name: '备料主管理员',
          permissions: ['stock-prep:read'],
          admissionNamespaces: ['stock-prep'],
        }),
        roleRow({
          id: 'other-role',
          name: 'Other',
          admissionNamespaces: ['stock-prep'],
        }),
        roleRow({
          id: 'custom-role',
          name: 'Floor Captain',
          permissions: ['custom:note'],
          memberCount: 1,
          updatedAt: UPDATED_AT,
        }),
      ],
      members: () => ({ items: [{ id: 'user-1', displayName: '甲一' }], total: 1 }),
      access: (userId) => jsonResponse(accessBody(userId, ['stock-prep_admin'])),
    })
    await mountView()
    roleButton('stock-prep_admin').click()
    await flushUi()
    await selectMember('user-1')
    clickRemove()
    await flushUi()
    expect(dialogText()).toContain('可能会关闭插件使用：stock-prep')
    expect(dialogText()).toContain('stock-prep:read')
    expect(postCalls()).toHaveLength(0)
    cancelButton().click()
    await flushUi()

    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        return jsonResponse({
          ok: true,
          data: {
            items: [
              roleRow({
                id: 'stock-prep_admin',
                name: '备料主管理员',
                permissions: ['stock-prep:read'],
                admissionNamespaces: ['stock-prep'],
              }),
              roleRow({ id: 'other-role', name: 'Other', admissionNamespaces: ['stock-prep'] }),
            ],
            total: 2,
          },
        })
      }
      if (String(url).includes('/members')) {
        return jsonResponse({ ok: true, data: { items: [{ id: 'user-1', displayName: '甲一' }], page: 1, pageSize: 20, total: 1 } })
      }
      if (String(url).endsWith('/access')) return jsonResponse(accessBody('user-1', ['stock-prep_admin', 'other-role']))
      throw new Error(`unexpected call ${init?.method || 'GET'} ${url}`)
    })
    roleButton('other-role').click()
    await flushUi()
    roleButton('stock-prep_admin').click()
    await flushUi()
    await selectMember('user-1')
    clickRemove()
    await flushUi()
    expect(dialogText()).toContain('按目前的角色目录，这次撤销不会关闭插件使用')
    expect(dialogText()).not.toContain('可能会关闭插件使用')
    cancelButton().click()
    await flushUi()

    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        return jsonResponse({
          ok: true,
          data: {
            items: [roleRow({ id: 'custom-role', name: 'Floor Captain', permissions: ['custom:note'] })],
            total: 1,
          },
        })
      }
      if (String(url).includes('/members')) {
        return jsonResponse({ ok: true, data: { items: [{ id: 'user-1', displayName: '甲一' }], page: 1, pageSize: 20, total: 1 } })
      }
      if (String(url).endsWith('/access')) return jsonResponse(accessBody('user-1', ['custom-role']))
      throw new Error(`unexpected call ${init?.method || 'GET'} ${url}`)
    })
    roleButton('custom-role').click()
    await flushUi()
    await selectMember('user-1')
    clickRemove()
    await flushUi()
    expect(container?.querySelector('[data-testid="admin-authorization-admissions-unknown"]')).toBeTruthy()
    expect(dialogText()).toContain('目前看不出这次会不会关闭插件使用')
    expect(dialogText()).not.toContain('按目前的角色目录，这次撤销不会关闭插件使用')
    cancelButton().click()
    await flushUi()

    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        return jsonResponse({
          ok: true,
          data: {
            items: [roleRow({
              id: 'stock-prep_admin',
              name: '备料主管理员',
              permissions: ['stock-prep:read'],
              admissionNamespaces: ['stock-prep'],
            })],
            total: 1,
          },
        })
      }
      if (String(url).includes('/members')) {
        return jsonResponse({ ok: true, data: { items: [{ id: 'user-1', displayName: '甲一' }], page: 1, pageSize: 20, total: 1 } })
      }
      if (String(url).endsWith('/access')) return jsonResponse({ ok: false, error: { message: 'down' } }, 503)
      throw new Error(`unexpected call ${init?.method || 'GET'} ${url}`)
    })
    roleButton('stock-prep_admin').click()
    await flushUi()
    await selectMember('user-1')
    clickRemove()
    await flushUi()
    expect(container?.querySelector('[data-testid="admin-authorization-admissions-unknown"]')).toBeTruthy()
    expect(dialogText()).not.toContain('按目前的角色目录，这次撤销不会关闭插件使用')
    expect(postCalls()).toHaveLength(0)
  })

  it('keeps the editor when membership is blocked, and refuses last-admin and stale-version writes without changing state', async () => {
    install({
      roles: [
        roleRow({
          id: 'admin',
          name: 'admin',
          permissions: [],
          memberCount: 1,
          admissionNamespaces: [],
        }),
        roleRow({
          id: 'attendance_admin',
          name: 'Attendance Admin',
          permissions: ['attendance:read'],
          memberCount: 3,
          admissionNamespaces: ['attendance'],
        }),
      ],
      members: (roleId) => ({
        items: [{ id: 'user-1', displayName: '甲一' }],
        total: roleId === 'attendance_admin' ? 3 : 1,
      }),
      access: (userId) => jsonResponse(accessBody(userId, ['admin'], '甲一')),
      onPost: (url) => {
        if (url.endsWith('/roles/unassign')) {
          return jsonResponse({ ok: false, error: { code: 'LAST_PLATFORM_ADMIN', message: '至少保留一名可登录的平台管理员' } }, 409)
        }
        return jsonResponse({ ok: false, error: { code: 'ROLE_MODIFIED', message: 'role row changed' } }, 409)
      },
    })
    await mountView()
    roleButton('attendance_admin').click()
    await flushUi()
    permissionBox('custom:note').checked = true
    permissionBox('custom:note').dispatchEvent(new Event('change'))
    await flushUi()
    expect(container?.querySelector('[data-role-members-locked]')?.textContent).toContain('成员变更已暂停')
    expect((container?.querySelector('[data-role-member-add]') as HTMLButtonElement).disabled).toBe(true)
    const add = container?.querySelector('[data-role-member-add]') as HTMLButtonElement
    add.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()
    expect(postCalls()).toHaveLength(0)
    expect(permissionBox('custom:note').checked).toBe(true)
    expect(nameInput().value).toBe('考勤管理员')

    const discard = container?.querySelector('[data-role-leave-discard]')
    expect(discard).toBeNull()
    permissionBox('custom:note').checked = false
    permissionBox('custom:note').dispatchEvent(new Event('change'))
    await flushUi()

    roleButton('admin').click()
    await flushUi()
    await selectMember('user-1')
    clickRemove()
    await flushUi()
    setPhrase('取消平台管理员')
    await flushUi()
    const readsBefore = roleGets()
    confirmButton().click()
    await flushUi()
    expect(postCalls()).toHaveLength(1)
    expect(postCalls()[0]?.body).toEqual({ roleId: 'admin' })
    expect(feedback()).toBe('不能取消最后一名平台管理员')
    expect(rootText()).toContain('甲一')
    expect(container?.querySelector('.role-members__selected')?.getAttribute('data-user-id')).toBe('user-1')
    expect(activeCount()).toBe('成员数：1')
    expect(roleGets()).toBe(readsBefore)
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()

    roleButton('attendance_admin').click()
    await flushUi()
    await selectMember('user-1')
    clickAdd()
    await flushUi()
    confirmButton().click()
    await flushUi()
    expect(postCalls()).toHaveLength(2)
    expect(feedback()).toBe('角色目录已变化，本次未写入。请刷新角色后再确认。')
    expect(activeCount()).toBe('成员数：3')
    expect(container?.querySelector('.role-members__selected')?.getAttribute('data-user-id')).toBe('user-1')
    expect(permissionBox('attendance:read').checked).toBe(true)
    expect(permissionBox('custom:note').checked).toBe(false)
    expect(roleGets()).toBe(readsBefore)
  })

  it('refuses a confirm after the user or role changes, and ignores a stale assign reply', async () => {
    const pending: Deferred[] = []
    install({
      roles: [
        roleRow({ id: 'role-a', name: 'Role A', permissions: ['attendance:read'], memberCount: 1, admissionNamespaces: [] }),
        roleRow({ id: 'role-b', name: 'Role B', memberCount: 7, admissionNamespaces: [] }),
      ],
      members: (roleId) => ({
        items: roleId === 'role-b'
          ? [{ id: 'user-b', displayName: '乙成员' }]
          : [
              { id: 'user-1', displayName: '甲一' },
              { id: 'user-2', displayName: '甲二' },
            ],
        total: roleId === 'role-b' ? 7 : 2,
      }),
      access: (userId) => jsonResponse(accessBody(userId, [], '甲一')),
      onPost: () => defer(pending),
    })
    await mountView()
    roleButton('role-a').click()
    await flushUi()
    await selectMember('user-1')
    clickAdd()
    await flushUi()
    memberRow('user-2').click()
    await flushUi()
    expect(postCalls()).toHaveLength(0)
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()
    expect(feedback()).toBe('确认对象已变化，本次未写入。')

    await selectMember('user-1')
    clickAdd()
    await flushUi()
    confirmButton().click()
    expect(postCalls()).toHaveLength(1)
    roleButton('role-b').click()
    await flushUi()
    roleButton('role-a').click()
    await flushUi()
    const getsAfterSwitch = memberGets().length
    pending[0]?.resolve(jsonResponse(writeBody({
      userId: 'user-1',
      roleId: 'role-a',
      held: true,
      changed: true,
    })))
    await flushUi()
    expect(memberGets()).toHaveLength(getsAfterSwitch)
    expect(feedback()).not.toContain('已分配角色')
    expect(container?.querySelector('.admin-page__item--active span')?.textContent).toBe('role-a')
    expect(rootText()).toContain('甲一')
    expect(activeCount()).toBe('成员数：2')
  })

  it('keeps a manual member when a deferred deep-link access read returns', async () => {
    const pending: Deferred[] = []
    install({
      roles: [roleRow({ id: 'role-a', name: 'Role A', memberCount: 2, admissionNamespaces: [] })],
      members: () => ({
        items: [
          { id: 'user-a', displayName: '名单甲' },
          { id: 'user-b', displayName: '名单乙' },
        ],
        total: 2,
      }),
      access: () => defer(pending),
    })
    await mountRouted({ roleId: 'role-a', userId: 'user-a' })
    expect(pending.length).toBeGreaterThanOrEqual(1)
    memberRow('user-b').click()
    await flushUi()
    expect(container?.querySelector('.role-members__selected')?.getAttribute('data-user-id')).toBe('user-b')
    for (const item of pending) item.resolve(jsonResponse(accessBody('user-a', ['role-a'], '过期深链')))
    await flushUi()
    expect(container?.querySelector('.role-members__selected')?.getAttribute('data-user-id')).toBe('user-b')
    expect(container?.querySelector('.role-members__selected')?.textContent).toContain('名单乙')
    expect(rootText()).not.toContain('过期深链')
    expect(postCalls()).toHaveLength(0)
  })

  it('closes a pending member confirmation when the leave flow locks the editor', async () => {
    install({
      roles: [
        roleRow({ id: 'role-a', name: 'Role A', permissions: ['attendance:read'], memberCount: 1, admissionNamespaces: [] }),
        roleRow({ id: 'role-b', name: 'Role B', memberCount: 1, admissionNamespaces: [] }),
      ],
      members: () => ({ items: [{ id: 'user-1', displayName: '甲一' }], total: 1 }),
      access: (userId) => jsonResponse(accessBody(userId, [], '甲一')),
      onPost: () => {
        throw new Error('member write during leave')
      },
    })
    await mountView()
    roleButton('role-a').click()
    await flushUi()
    await selectMember('user-1')
    clickAdd()
    await flushUi()
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    nameInput().value = '临时名称'
    nameInput().dispatchEvent(new Event('input'))
    await flushUi()
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    roleButton('role-b').click()
    await flushUi()
    expect(postCalls()).toHaveLength(0)
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()
    expect(container?.querySelector('[data-role-leave-shield]')).toBeTruthy()
    ;(container?.querySelector('[data-role-leave-stay]') as HTMLButtonElement).click()
    await flushUi()
    expect(postCalls()).toHaveLength(0)
    expect(nameInput().value).toBe('临时名称')
    expect(container?.querySelector('.admin-page__item--active span')?.textContent).toBe('role-a')
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()
  })

  it('drops a member roster read that resolves after the panel is gone', async () => {
    let releaseMembers: ((page: { items: Array<{ id: string; displayName: string }>; total: number }) => void) | null = null
    install({
      roles: [roleRow({ id: 'role-a', name: 'Role A', memberCount: 1, admissionNamespaces: [] })],
      members: () => new Promise((resolve) => {
        releaseMembers = resolve
      }),
    })
    await mountView()
    roleButton('role-a').click()
    await flushUi()
    expect(releaseMembers).toBeTruthy()
    ;(container?.querySelector('[data-role-cancel]') as HTMLButtonElement).click()
    await flushUi()
    expect(container?.querySelector('.role-members')).toBeNull()
    releaseMembers?.({ items: [{ id: 'user-9', displayName: '迟到成员' }], total: 99 })
    await flushUi()
    expect(roleButton('role-a').querySelector('small')?.textContent).toBe('成员数：1')
    expect(rootText()).not.toContain('迟到成员')
  })
})
