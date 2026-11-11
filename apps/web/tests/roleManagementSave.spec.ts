/**
 * 角色管理页 — 保存后的核对与并发令牌。
 *
 * The page re-reads the role catalog after a save and compares the PERSISTED permission set
 * with the one it submitted, because the backend used to answer `ok: true` while writing
 * nothing. Two ways that reconciliation can lie, both pinned here:
 *   - it must not report 「不一致」 when the RE-READ is what failed (the write said ok, the
 *     comparison then ran against the stale pre-save array and always disagreed) — a
 *     cry-wolf message teaches admins to ignore the one signal this page added;
 *   - it must still report 「不一致」 when the re-read SUCCEEDS and really disagrees.
 * Plus the mid-air-collision token: the grid is submitted together with the `updatedAt` it
 * was loaded with, and a 409 answer reloads instead of offering to replay a stale draft.
 * A catalog reload that does not apply the editor must not replace expectedUpdatedAt or
 * expectedPermissions. A second role click while the leave dialog is open must not start
 * a second save.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import RoleManagementView from '../src/views/RoleManagementView.vue'

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

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function isRoleMembersGet(url: string): boolean {
  return url.startsWith('/api/admin/roles/') && url.includes('/members')
}

function membersResponse() {
  return jsonResponse({
    ok: true,
    data: { items: [], page: 1, pageSize: 20, total: 0 },
  })
}

const PERMISSIONS = [
  { code: 'stock-prep:read', name: '备料查看', description: null },
  { code: 'stock-prep:write', name: '备料写入', description: null },
]

function roleCatalog(permissions: string[], updatedAt: string | null = '2026-09-16T01:02:03.000Z') {
  return {
    ok: true,
    data: {
      items: [{ id: 'role-1', name: '备料角色', permissions, memberCount: 2, updatedAt }],
      total: 1,
    },
  }
}

type Call = { url: string; init?: { method?: string; body?: string } }

function recordedCalls(): Call[] {
  return apiFetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as Call['init'] }))
}

function savedBody(): Record<string, unknown> {
  const write = recordedCalls().find((call) => call.init?.method === 'PUT' || call.init?.method === 'POST')
  if (!write?.init?.body) throw new Error('no write call recorded')
  return JSON.parse(write.init.body) as Record<string, unknown>
}

let container: HTMLElement | null = null
let app: App<Element> | null = null

function statusText(): string {
  return container?.querySelector('.admin-page__status')?.textContent?.trim() || ''
}

function clickRole(): void {
  const item = container?.querySelector('.admin-page__item') as HTMLButtonElement | null
  if (!item) throw new Error('role list item not found')
  item.click()
}

function clickSave(): void {
  const save = container?.querySelector('.admin-page__footer .admin-page__button') as HTMLButtonElement | null
  if (!save) throw new Error('save button not found')
  save.click()
}

function togglePermission(code: string): void {
  const labels = Array.from(container?.querySelectorAll('.admin-page__checkbox') || [])
  const label = labels.find((candidate) => candidate.textContent?.includes(code))
  const input = label?.querySelector('input') as HTMLInputElement | null
  if (!input) throw new Error(`checkbox for ${code} not found`)
  input.checked = !input.checked
  input.dispatchEvent(new Event('change'))
}

async function mountView(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(RoleManagementView)
  app.mount(container)
  await flushUi()
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  if (app) app.unmount()
  app = null
  container?.remove()
  container = null
})

describe('RoleManagementView — reserved role name (#6348 follow-up)', () => {
  it('a 400 ROLE_NAME_RESERVED is shown in Chinese, not as the server\'s English message', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return jsonResponse(roleCatalog(['stock-prep:read']))
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: false, error: { code: 'ROLE_NAME_RESERVED', message: 'this display name is reserved for a built-in role' } }, 400)
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    clickSave()
    await flushUi()

    expect(statusText()).toBe('该名称为系统保留名，不能用于自定义角色')
    expect(statusText()).not.toContain('reserved')
  })

  it('another refusal still shows the server message', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return jsonResponse(roleCatalog(['stock-prep:read']))
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: false, error: { code: 'ROLE_ID_INVALID', message: '角色 ID 不合法' } }, 400)
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    clickSave()
    await flushUi()

    expect(statusText()).toBe('角色 ID 不合法')
  })
})

describe('RoleManagementView — save reconciliation', () => {
  it('does NOT claim a permission mismatch when it is the post-save RELOAD that failed', async () => {
    let rolesReads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        // First read seeds the page; the post-save read fails (transient 500).
        return rolesReads === 1
          ? jsonResponse(roleCatalog(['stock-prep:read']))
          : jsonResponse({ ok: false, error: { message: '加载角色失败' } }, 500)
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } })
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(statusText()).toBe('已保存，但无法重新加载角色目录以核对，请刷新确认')
    // the old message asserted a data loss that never happened.
    expect(statusText()).not.toContain('不一致')
  })

  it('STILL reports a mismatch when the reload SUCCEEDS and the persisted set disagrees', async () => {
    let rolesReads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        // The server silently dropped the submitted set — the defect this page watches for.
        return jsonResponse(roleCatalog(['stock-prep:read']))
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色' } })
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(rolesReads).toBe(2)
    expect(statusText()).toContain('不一致')
  })

  it('submits the concurrency token the grid was loaded with', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return jsonResponse(roleCatalog(['stock-prep:read']))
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } })
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(savedBody().expectedUpdatedAt).toBe('2026-09-16T01:02:03.000Z')
    // and the set as LOADED, which catches a writer that never touches roles.updated_at.
    expect(savedBody().expectedPermissions).toEqual(['stock-prep:read'])
  })

  it('a 409 ROLE_MODIFIED reloads the grid instead of replaying the stale draft', async () => {
    let rolesReads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        return jsonResponse(roleCatalog(rolesReads === 1 ? ['stock-prep:read'] : [], '2026-09-16T02:00:00.000Z'))
      }
      if (init?.method === 'PUT') {
        return jsonResponse({
          ok: false,
          error: { code: 'ROLE_MODIFIED', message: 'This role changed since it was loaded; reload it and re-apply the change' },
        }, 409)
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(rolesReads).toBe(2)
    expect(statusText()).toBe('该角色已被其他人修改，已重新加载最新权限，请确认后再保存')
    // the raw server sentence must not be what the admin reads.
    expect(statusText()).not.toContain('This role changed')
  })

  it('a clean save still reports success', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        const permissions = recordedCalls().some((call) => call.init?.method === 'PUT')
          ? ['stock-prep:read', 'stock-prep:write']
          : ['stock-prep:read']
        return jsonResponse(roleCatalog(permissions))
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } })
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickSave()
    await flushUi()

    expect(statusText()).toBe('角色已更新')
  })
})

describe('RoleManagementView — an existing role is addressed by the id it was LOADED with', () => {
  // Two stored ids that render identically to the real namespace main-admin role. Deleting
  // the REAL one takes every membership and delegated audience with it, so a trimmed id here
  // turns "clean up the empty duplicate" into "demote every attendance admin".
  const REAL = 'attendance_admin'
  const PADDED = 'attendance_admin '
  const BOM_LED = '\uFEFFattendance_admin'

  function lookAlikeCatalog() {
    return {
      ok: true,
      data: {
        items: [
          { id: REAL, name: '考勤管理员', permissions: ['stock-prep:read'], memberCount: 3, updatedAt: '2026-09-16T01:02:03.000Z' },
          { id: PADDED, name: '考勤管理员', permissions: [], memberCount: 0, updatedAt: '2026-09-16T01:02:03.000Z' },
          { id: BOM_LED, name: '考勤管理员', permissions: [], memberCount: 0, updatedAt: '2026-09-16T01:02:03.000Z' },
        ],
        total: 3,
      },
    }
  }

  function clickRoleAt(index: number): void {
    const items = Array.from(container?.querySelectorAll('.admin-page__item') || []) as HTMLButtonElement[]
    const item = items[index]
    if (!item) throw new Error(`role list item ${index} not found`)
    item.click()
  }

  function clickDelete(): void {
    const button = container?.querySelector('.admin-page__button--danger') as HTMLButtonElement | null
    if (!button) throw new Error('delete button not found')
    button.click()
  }

  it('PUT and DELETE on a padded look-alike go to that exact id, never to the real `<ns>_admin`', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return jsonResponse(lookAlikeCatalog())
      if (init?.method === 'PUT' || init?.method === 'DELETE') return jsonResponse({ ok: true, data: {} })
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    try {
      await mountView()

      clickRoleAt(1)
      await flushUi()
      togglePermission('stock-prep:write')
      await flushUi()
      clickSave()
      await flushUi()

      clickRoleAt(1)
      await flushUi()
      clickDelete()
      await flushUi()

      clickRoleAt(2)
      await flushUi()
      clickDelete()
      await flushUi()
    } finally {
      confirmSpy.mockRestore()
    }

    const writes = recordedCalls()
      .filter((call) => call.init?.method === 'PUT' || call.init?.method === 'DELETE')
      .map((call) => `${call.init?.method} ${call.url}`)
    expect(writes).toEqual([
      `PUT /api/roles/${encodeURIComponent(PADDED)}`,
      `DELETE /api/roles/${encodeURIComponent(PADDED)}`,
      `DELETE /api/roles/${encodeURIComponent(BOM_LED)}`,
    ])
    expect(writes.some((write) => write.endsWith(`/api/roles/${REAL}`))).toBe(false)
    expect(savedBody().id).toBe(PADDED)
  })
})

describe('RoleManagementView — unsaved draft protection', () => {
  function twoRoleCatalog(
    roleOnePermissions: string[],
    roleOneUpdatedAt = '2026-09-16T01:02:03.000Z',
    roleOneName = '备料角色',
    roleOneId = 'role-1',
  ) {
    return {
      ok: true,
      data: {
        items: [
          { id: roleOneId, name: roleOneName, permissions: roleOnePermissions, memberCount: 2, updatedAt: roleOneUpdatedAt },
          { id: 'role-2', name: '复核角色', permissions: ['stock-prep:write'], memberCount: 0, updatedAt: '2026-09-16T01:02:03.000Z' },
        ],
        total: 2,
      },
    }
  }

  function clickRoleAt(index: number): void {
    const items = Array.from(container?.querySelectorAll('.admin-page__item') || []) as HTMLButtonElement[]
    const item = items[index]
    if (!item) throw new Error(`role list item ${index} not found`)
    item.click()
  }

  function clickNamed(selector: string): void {
    const button = container?.querySelector(selector) as HTMLButtonElement | null
    if (!button) throw new Error(`${selector} not found`)
    button.click()
  }

  function leaveDialog(): HTMLElement | null {
    return container?.querySelector('[data-role-leave-dialog]') ?? null
  }

  function clickLeave(choice: 'save' | 'discard' | 'stay'): void {
    clickNamed(`[data-role-leave-${choice}]`)
  }

  function roleNameInput(): HTMLInputElement {
    const input = container?.querySelector('[data-role-name-input]') as HTMLInputElement | null
    if (!input) throw new Error('name input not found')
    return input
  }

  async function setRoleName(value: string): Promise<void> {
    const input = roleNameInput()
    input.value = value
    input.dispatchEvent(new Event('input'))
    await flushUi()
  }

  function permissionChecked(code: string): boolean {
    const labels = Array.from(container?.querySelectorAll('.admin-page__checkbox') || [])
    const label = labels.find((candidate) => candidate.textContent?.includes(code))
    const input = label?.querySelector('input') as HTMLInputElement | null
    if (!input) throw new Error(`checkbox for ${code} not found`)
    return input.checked
  }

  function activeRoleId(): string {
    return container?.querySelector('.admin-page__item--active span')?.textContent?.trim() || ''
  }

  function unloadCancelled(): boolean {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  async function mountRouted(): Promise<Router> {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', redirect: '/admin/roles' },
        { path: '/admin/roles', component: RoleManagementView },
        { path: '/elsewhere', component: { render: () => h('div', { 'data-elsewhere': 'true' }) } },
      ],
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = { name: 'RoleRouteRoot', render: () => h(RouterView) }
    app = createApp(root)
    app.use(router)
    app.mount(container)
    await router.isReady()
    await flushUi()
    return router
  }

  function installCatalog(options?: {
    roleOnePermissions?: string[]
    onRolesRead?: (readIndex: number) => { permissions: string[]; updatedAt?: string; name?: string; id?: string } | 'fail' | 'missing'
    onWrite?: () => { status: number; body: Record<string, unknown> }
  }): { rolesReads: () => number; writeCount: () => number } {
    let rolesReads = 0
    let writeCount = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        const override = options?.onRolesRead?.(rolesReads)
        if (override === 'fail') return jsonResponse({ ok: false, error: { message: '加载角色失败' } }, 500)
        if (override === 'missing') return jsonResponse({ ok: true, data: { items: [], total: 0 } })
        const permissions = override?.permissions ?? options?.roleOnePermissions ?? ['stock-prep:read']
        const updatedAt = override?.updatedAt ?? '2026-09-16T01:02:03.000Z'
        return jsonResponse(twoRoleCatalog(permissions, updatedAt, override?.name ?? '备料角色', override?.id ?? 'role-1'))
      }
      if (init?.method === 'PUT' || init?.method === 'POST') {
        writeCount += 1
        const write = options?.onWrite?.() ?? {
          status: 200,
          body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read'] } },
        }
        return jsonResponse(write.body, write.status)
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${init?.method || 'GET'} ${url}`)
    })
    return {
      rolesReads: () => rolesReads,
      writeCount: () => writeCount,
    }
  }

  it('does not prompt or warn when a clean editor switches, resets, refreshes, or leaves the route', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const calls = installCatalog()
    await mountView()
    clickRoleAt(0)
    await flushUi()

    clickRoleAt(1)
    await flushUi()
    expect(leaveDialog()).toBeNull()
    expect(activeRoleId()).toBe('role-2')
    expect(container?.querySelector('.role-members')).not.toBeNull()

    clickRoleAt(0)
    await flushUi()
    clickNamed('[data-role-new]')
    await flushUi()
    expect(leaveDialog()).toBeNull()
    expect(activeRoleId()).toBe('')
    expect(roleNameInput().value).toBe('')

    clickRoleAt(0)
    await flushUi()
    clickNamed('[data-role-cancel]')
    await flushUi()
    expect(leaveDialog()).toBeNull()
    expect(activeRoleId()).toBe('')

    clickRoleAt(0)
    await flushUi()
    const readsBeforeRefresh = calls.rolesReads()
    clickNamed('[data-role-refresh]')
    await flushUi()
    expect(leaveDialog()).toBeNull()
    expect(activeRoleId()).toBe('role-1')
    expect(calls.rolesReads()).toBe(readsBeforeRefresh + 1)
    expect(calls.writeCount()).toBe(0)
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('onBeforeRouteLeave'))).toBe(false)
    warnSpy.mockRestore()
  })

  it('asks before leaving a name-only edit and stays without writing when cancelled', async () => {
    const calls = installCatalog()
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('新名称')

    clickRoleAt(1)
    await flushUi()
    expect(leaveDialog()?.textContent).toContain('保存并继续')
    expect(leaveDialog()?.textContent).toContain('放弃并继续')
    expect(leaveDialog()?.textContent).toContain('留在此页')
    clickLeave('stay')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(roleNameInput().value).toBe('新名称')
    expect(calls.writeCount()).toBe(0)
    expect(container?.querySelector('.role-members')).not.toBeNull()
  })

  it('treats permission reorder and a full undo as clean, and a real set change as dirty', async () => {
    installCatalog({ roleOnePermissions: ['stock-prep:write', 'stock-prep:read'] })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()

    clickRoleAt(1)
    await flushUi()
    expect(leaveDialog()).toBeNull()
    expect(activeRoleId()).toBe('role-2')

    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:read')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    expect(leaveDialog()).not.toBeNull()
    clickLeave('stay')
    await flushUi()
    expect(activeRoleId()).toBe('role-1')
    expect(permissionChecked('stock-prep:read')).toBe(false)

    togglePermission('stock-prep:read')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    expect(leaveDialog()).toBeNull()
    expect(activeRoleId()).toBe('role-2')
  })

  it('restoring the original name clears the name-only draft', async () => {
    installCatalog()
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('临时名称')
    clickNamed('[data-role-cancel]')
    await flushUi()
    expect(leaveDialog()).not.toBeNull()
    clickLeave('stay')
    await flushUi()

    await setRoleName('备料角色')
    clickNamed('[data-role-new]')
    await flushUi()
    expect(leaveDialog()).toBeNull()
    expect(activeRoleId()).toBe('')
  })

  it('stay cancels switch, new, reset, refresh, and in-app navigation', async () => {
    const calls = installCatalog()
    const router = await mountRouted()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('新名称')
    const readsAfterLoad = calls.rolesReads()

    clickRoleAt(1)
    await flushUi()
    clickLeave('stay')
    await flushUi()
    expect(activeRoleId()).toBe('role-1')

    clickNamed('[data-role-new]')
    await flushUi()
    clickLeave('stay')
    await flushUi()
    expect(activeRoleId()).toBe('role-1')

    clickNamed('[data-role-cancel]')
    await flushUi()
    clickLeave('stay')
    await flushUi()
    expect(roleNameInput().value).toBe('新名称')

    clickNamed('[data-role-refresh]')
    await flushUi()
    clickLeave('stay')
    await flushUi()
    expect(calls.rolesReads()).toBe(readsAfterLoad)
    expect(roleNameInput().value).toBe('新名称')

    const navigation = router.push('/elsewhere')
    await flushUi()
    expect(leaveDialog()).not.toBeNull()
    clickLeave('stay')
    await navigation
    await flushUi()
    expect(router.currentRoute.value.path).toBe('/admin/roles')
    expect(roleNameInput().value).toBe('新名称')
    expect(calls.writeCount()).toBe(0)
  })

  it('discard-and-continue leaves the draft behind', async () => {
    const calls = installCatalog()
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('新名称')
    clickRoleAt(1)
    await flushUi()
    clickLeave('discard')
    await flushUi()

    expect(activeRoleId()).toBe('role-2')
    expect(roleNameInput().value).toBe('复核角色')
    expect(calls.writeCount()).toBe(0)
  })

  it('save-and-continue switches only after the write is acknowledged and the readback matches', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (
        readIndex === 1
          ? { permissions: ['stock-prep:read'] }
          : { permissions: ['stock-prep:read', 'stock-prep:write'] }
      ),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-2')
    expect(savedBody().expectedUpdatedAt).toBe('2026-09-16T01:02:03.000Z')
    expect(savedBody().expectedPermissions).toEqual(['stock-prep:read'])
    expect(savedBody().permissions).toEqual(['stock-prep:read', 'stock-prep:write'])
    const urls = recordedCalls().map((call) => `${call.init?.method || 'GET'} ${call.url}`)
    const putAt = urls.findIndex((entry) => entry.startsWith('PUT '))
    const readbackAt = urls.findIndex((entry, index) => index > putAt && entry === 'GET /api/admin/roles')
    const switchedAt = urls.findIndex((entry) => entry.startsWith('GET /api/admin/roles/role-2/members'))
    expect(putAt).toBeGreaterThan(-1)
    expect(readbackAt).toBeGreaterThan(putAt)
    expect(switchedAt).toBeGreaterThan(readbackAt)
  })

  it('save-and-continue navigates only after a matching readback', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (
        readIndex === 1
          ? { permissions: ['stock-prep:read'] }
          : { permissions: ['stock-prep:read'], name: '改名角色' }
      ),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '改名角色', permissions: ['stock-prep:read'] } },
      }),
    })
    const router = await mountRouted()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('改名角色')
    const navigation = router.push('/elsewhere')
    await flushUi()
    clickLeave('save')
    await navigation
    await flushUi()

    expect(router.currentRoute.value.path).toBe('/elsewhere')
    expect(container?.querySelector('[data-elsewhere]')).not.toBeNull()
    expect(savedBody().name).toBe('改名角色')
    expect(savedBody().permissions).toEqual(['stock-prep:read'])
  })

  it('a refused save blocks continuation and keeps the draft', async () => {
    installCatalog({
      onWrite: () => ({
        status: 400,
        body: { ok: false, error: { code: 'ROLE_ID_INVALID', message: '角色 ID 不合法' } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('新名称')
    clickNamed('[data-role-new]')
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(roleNameInput().value).toBe('新名称')
    expect(statusText()).toBe('角色 ID 不合法')
    expect(leaveDialog()).toBeNull()
  })

  it('ROLE_MODIFIED reloads the catalog, keeps the original draft for recovery, and does not replay it', async () => {
    let rolesReads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        rolesReads += 1
        const authoritative = rolesReads === 1 ? ['stock-prep:read'] : []
        const updatedAt = rolesReads === 1 ? '2026-09-16T01:02:03.000Z' : '2026-09-16T02:00:00.000Z'
        return jsonResponse(twoRoleCatalog(authoritative, updatedAt))
      }
      if (init?.method === 'PUT') {
        return jsonResponse({
          ok: false,
          error: { code: 'ROLE_MODIFIED', message: 'This role changed since it was loaded; reload it and re-apply the change' },
        }, 409)
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('临时名称')
    togglePermission('stock-prep:write')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(rolesReads).toBe(2)
    expect(activeRoleId()).toBe('role-1')
    expect(roleNameInput().value).toBe('备料角色')
    expect(permissionChecked('stock-prep:write')).toBe(false)
    expect(permissionChecked('stock-prep:read')).toBe(false)
    expect(statusText()).toBe('该角色已被其他人修改，已重新加载最新权限，请确认后再保存')
    const conflict = container?.querySelector('[data-role-conflict-draft]')
    expect(conflict?.textContent).toContain('服务端当前权限：（无）')
    expect(conflict?.textContent).toContain('未保存名称：临时名称')
    expect(conflict?.textContent).toContain('未保存修改：stock-prep:read、stock-prep:write')
    expect(recordedCalls().filter((call) => call.init?.method === 'PUT')).toHaveLength(1)

    clickSave()
    await flushUi()
    const puts = recordedCalls().filter((call) => call.init?.method === 'PUT')
    expect(puts).toHaveLength(2)
    const ordinary = JSON.parse(String(puts[1]?.init?.body)) as Record<string, unknown>
    expect(ordinary.expectedUpdatedAt).toBe('2026-09-16T02:00:00.000Z')
    expect(ordinary.expectedPermissions).toEqual([])
    expect(ordinary.permissions).toEqual([])
    expect(ordinary.name).toBe('备料角色')
    expect(roleNameInput().value).toBe('备料角色')
    expect(permissionChecked('stock-prep:write')).toBe(false)
    expect(container?.querySelector('[data-role-conflict-draft]')?.textContent).toContain('未保存名称：临时名称')

    clickNamed('[data-role-conflict-recover]')
    await flushUi()
    expect(roleNameInput().value).toBe('临时名称')
    expect(permissionChecked('stock-prep:write')).toBe(true)
    clickSave()
    await flushUi()
    const recoveredPuts = recordedCalls().filter((call) => call.init?.method === 'PUT')
    expect(recoveredPuts).toHaveLength(3)
    const recovered = JSON.parse(String(recoveredPuts[2]?.init?.body)) as Record<string, unknown>
    expect(recovered.expectedUpdatedAt).toBe('2026-09-16T02:00:00.000Z')
    expect(recovered.expectedPermissions).toEqual([])
    expect(recovered.permissions).toEqual(['stock-prep:read', 'stock-prep:write'])
    expect(recovered.name).toBe('临时名称')
    expect(activeRoleId()).toBe('role-1')
  })

  it('a failed ROLE_MODIFIED reload keeps the draft and the previous token baseline', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (readIndex === 1 ? { permissions: ['stock-prep:read'] } : 'fail'),
      onWrite: () => ({
        status: 409,
        body: { ok: false, error: { code: 'ROLE_MODIFIED', message: 'This role changed since it was loaded' } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('临时名称')
    togglePermission('stock-prep:write')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(roleNameInput().value).toBe('临时名称')
    expect(permissionChecked('stock-prep:write')).toBe(true)
    expect(statusText()).toBe('该角色已被其他人修改，但无法重新加载最新权限，未保存修改已保留')
    expect(container?.querySelector('[data-role-conflict-draft]')?.textContent).toContain('未能载入服务端最新权限')
    expect(recordedCalls().filter((call) => call.init?.method === 'PUT')).toHaveLength(1)

    clickSave()
    await flushUi()
    const puts = recordedCalls().filter((call) => call.init?.method === 'PUT')
    expect(puts).toHaveLength(2)
    const again = JSON.parse(String(puts[1]?.init?.body)) as Record<string, unknown>
    expect(again.expectedUpdatedAt).toBe('2026-09-16T01:02:03.000Z')
    expect(again.expectedPermissions).toEqual(['stock-prep:read'])
    expect(again.permissions).toEqual(['stock-prep:read', 'stock-prep:write'])
    expect(again.name).toBe('临时名称')
    expect(roleNameInput().value).toBe('临时名称')
  })

  it('a failed readback blocks continuation and keeps the submitted draft', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (readIndex === 1 ? { permissions: ['stock-prep:read'] } : 'fail'),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(permissionChecked('stock-prep:write')).toBe(true)
    expect(statusText()).toBe('已保存，但无法重新加载角色目录以核对，请刷新确认')
    expect(statusText()).not.toContain('不一致')
  })

  it('a missing readback blocks continuation and keeps the submitted draft', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (readIndex === 1 ? { permissions: ['stock-prep:read'] } : 'missing'),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(roleNameInput().value).toBe('备料角色')
    expect(permissionChecked('stock-prep:write')).toBe(true)
    expect(container?.querySelector('.role-members')).not.toBeNull()
    expect(statusText()).toBe('已保存，但重新加载后未找到该角色，请刷新确认')
    expect(activeRoleId()).toBe('')
  })

  it('a disagreeing readback blocks continuation and keeps the submitted draft', async () => {
    installCatalog({
      onRolesRead: () => ({ permissions: ['stock-prep:read'] }),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickNamed('[data-role-refresh]')
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(permissionChecked('stock-prep:write')).toBe(true)
    expect(statusText()).toContain('不一致')
    expect(recordedCalls().filter((call) => call.init?.method === 'PUT')).toHaveLength(1)
  })

  it('a readback whose persisted name differs blocks continuation and keeps the draft', async () => {
    installCatalog({
      onRolesRead: () => ({ permissions: ['stock-prep:read'] }),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '改名角色', permissions: ['stock-prep:read'] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('改名角色')
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(roleNameInput().value).toBe('改名角色')
    expect(statusText()).toContain('服务端记录的名称为 备料角色')
    expect(recordedCalls().filter((call) => call.init?.method === 'PUT')).toHaveLength(1)
  })

  it('a readback whose acknowledged id differs blocks continuation and keeps the draft', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (
        readIndex === 1
          ? { permissions: ['stock-prep:read'] }
          : { permissions: ['stock-prep:read', 'stock-prep:write'] }
      ),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-other', name: '备料角色', permissions: ['stock-prep:read', 'stock-prep:write'] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:write')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(permissionChecked('stock-prep:write')).toBe(true)
    expect(roleNameInput().value).toBe('备料角色')
    expect(statusText()).toBe('已保存，但服务端确认的角色与提交的不一致，请刷新确认')
    expect(savedBody().id).toBe('role-1')
    expect(recordedCalls().filter((call) => call.init?.method === 'PUT')).toHaveLength(1)
  })

  it('a disagreeing readback keeps the editor baseline tokens for the next save', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (
        readIndex === 1
          ? { permissions: ['stock-prep:read'] }
          : { permissions: ['stock-prep:write'], updatedAt: '2026-09-16T02:00:00.000Z' }
      ),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: [] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:read')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(permissionChecked('stock-prep:read')).toBe(false)
    expect(permissionChecked('stock-prep:write')).toBe(false)
    expect(statusText()).toContain('不一致')

    clickSave()
    await flushUi()
    const puts = recordedCalls().filter((call) => call.init?.method === 'PUT')
    expect(puts).toHaveLength(2)
    const second = JSON.parse(String(puts[1]?.init?.body)) as Record<string, unknown>
    expect(second.id).toBe('role-1')
    expect(second.name).toBe('备料角色')
    expect(second.permissions).toEqual([])
    expect(second.expectedPermissions).toEqual(['stock-prep:read'])
    expect(second.expectedUpdatedAt).toBe('2026-09-16T01:02:03.000Z')
    expect(String(puts[1]?.url)).toBe('/api/roles/role-1')
  })

  it('a missing readback keeps the editor baseline tokens when the role is absent', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (readIndex === 1 ? { permissions: ['stock-prep:read'] } : 'missing'),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: [] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:read')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(permissionChecked('stock-prep:read')).toBe(false)
    expect(roleNameInput().value).toBe('备料角色')
    expect(statusText()).toBe('已保存，但重新加载后未找到该角色，请刷新确认')

    clickSave()
    await flushUi()
    const puts = recordedCalls().filter((call) => call.init?.method === 'PUT')
    expect(puts).toHaveLength(2)
    const second = JSON.parse(String(puts[1]?.init?.body)) as Record<string, unknown>
    expect(second.id).toBe('role-1')
    expect(second.name).toBe('备料角色')
    expect(second.permissions).toEqual([])
    expect(second.expectedPermissions).toEqual(['stock-prep:read'])
    expect(second.expectedUpdatedAt).toBe('2026-09-16T01:02:03.000Z')
    expect(String(puts[1]?.url)).toBe('/api/roles/role-1')
  })

  it('a failed readback keeps the editor baseline tokens for the next save', async () => {
    installCatalog({
      onRolesRead: (readIndex) => (readIndex === 1 ? { permissions: ['stock-prep:read'] } : 'fail'),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '备料角色', permissions: [] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    togglePermission('stock-prep:read')
    await flushUi()
    clickRoleAt(1)
    await flushUi()
    clickLeave('save')
    await flushUi()

    expect(permissionChecked('stock-prep:read')).toBe(false)
    expect(statusText()).toBe('已保存，但无法重新加载角色目录以核对，请刷新确认')

    clickSave()
    await flushUi()
    const puts = recordedCalls().filter((call) => call.init?.method === 'PUT')
    expect(puts).toHaveLength(2)
    const second = JSON.parse(String(puts[1]?.init?.body)) as Record<string, unknown>
    expect(second.permissions).toEqual([])
    expect(second.expectedPermissions).toEqual(['stock-prep:read'])
    expect(second.expectedUpdatedAt).toBe('2026-09-16T01:02:03.000Z')
  })

  it('one leave prompt produces one save when another role is clicked while it is open', async () => {
    const calls = installCatalog({
      onRolesRead: (readIndex) => (
        readIndex === 1
          ? { permissions: ['stock-prep:read'] }
          : { permissions: ['stock-prep:read'], name: '合成待保存草稿' }
      ),
      onWrite: () => ({
        status: 200,
        body: { ok: true, data: { id: 'role-1', name: '合成待保存草稿', permissions: ['stock-prep:read'] } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('合成待保存草稿')
    clickRoleAt(1)
    await flushUi()

    expect(leaveDialog()).not.toBeNull()
    expect(container?.querySelector('[data-role-leave-shield]')).not.toBeNull()
    const roleButtons = Array.from(container?.querySelectorAll('.admin-page__item') || []) as HTMLButtonElement[]
    expect(roleButtons[0]?.disabled).toBe(true)
    expect(roleButtons[1]?.disabled).toBe(true)
    expect((container?.querySelector('[data-role-refresh]') as HTMLButtonElement).disabled).toBe(true)
    expect((container?.querySelector('[data-role-new]') as HTMLButtonElement).disabled).toBe(true)
    expect((container?.querySelector('.admin-page__footer .admin-page__button') as HTMLButtonElement).disabled).toBe(true)
    expect(roleNameInput().disabled).toBe(true)

    roleButtons[0].disabled = false
    roleButtons[0].click()
    await flushUi()
    expect(leaveDialog()).not.toBeNull()
    expect(activeRoleId()).toBe('role-1')
    expect(calls.writeCount()).toBe(0)

    clickLeave('save')
    await flushUi()
    expect(calls.writeCount()).toBe(1)
    expect(activeRoleId()).toBe('role-2')
    expect(savedBody().id).toBe('role-1')
    expect(savedBody().name).toBe('合成待保存草稿')
    expect(savedBody().expectedPermissions).toEqual(['stock-prep:read'])
    expect(leaveDialog()).toBeNull()
  })

  it('a failed save-and-continue stays on the draft after another role click during the prompt', async () => {
    installCatalog({
      onWrite: () => ({
        status: 400,
        body: { ok: false, error: { code: 'ROLE_ID_INVALID', message: '角色 ID 不合法' } },
      }),
    })
    await mountView()
    clickRoleAt(0)
    await flushUi()
    await setRoleName('新名称')
    clickRoleAt(1)
    await flushUi()
    const first = container?.querySelector('.admin-page__item') as HTMLButtonElement
    first.disabled = false
    first.click()
    clickLeave('save')
    await flushUi()

    expect(activeRoleId()).toBe('role-1')
    expect(roleNameInput().value).toBe('新名称')
    expect(permissionChecked('stock-prep:read')).toBe(true)
    expect(statusText()).toBe('角色 ID 不合法')
    expect(leaveDialog()).toBeNull()
    expect(recordedCalls().filter((call) => call.init?.method === 'PUT')).toHaveLength(1)
  })

  it('arms beforeunload only while the draft is dirty and removes it on unmount', async () => {
    installCatalog()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    await mountView()
    clickRoleAt(0)
    await flushUi()
    expect(unloadCancelled()).toBe(false)

    await setRoleName('新名称')
    expect(unloadCancelled()).toBe(true)

    await setRoleName('备料角色')
    expect(unloadCancelled()).toBe(false)

    await setRoleName('新名称')
    expect(unloadCancelled()).toBe(true)
    app?.unmount()
    app = null
    expect(unloadCancelled()).toBe(false)
    expect(removeSpy.mock.calls.some((call) => call[0] === 'beforeunload')).toBe(true)
    removeSpy.mockRestore()
  })

  it('an untouched localized title is not persisted, including after the field is restored', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') {
        return jsonResponse({
          ok: true,
          data: {
            items: [{
              id: 'attendance_admin',
              name: 'Attendance Admin',
              permissions: ['stock-prep:read'],
              memberCount: 1,
              updatedAt: '2026-09-16T01:02:03.000Z',
            }],
            total: 1,
          },
        })
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'attendance_admin', name: 'Attendance Admin', permissions: ['stock-prep:read'] } })
      }
      if (isRoleMembersGet(url)) return membersResponse()
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    clickRole()
    await flushUi()
    expect(roleNameInput().value).toBe('考勤管理员')
    clickSave()
    await flushUi()
    expect(savedBody().name).toBe('Attendance Admin')
    expect(savedBody().id).toBe('attendance_admin')

    await setRoleName('现场负责人')
    await setRoleName('考勤管理员')
    clickSave()
    await flushUi()
    const puts = recordedCalls().filter((call) => call.init?.method === 'PUT')
    const restored = JSON.parse(String(puts[1]?.init?.body)) as Record<string, unknown>
    expect(restored.name).toBe('Attendance Admin')
    expect(restored.expectedPermissions).toEqual(['stock-prep:read'])
  })
})
