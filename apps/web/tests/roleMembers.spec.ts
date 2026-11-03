/**
 * Mounted role directory: member pages, failed reads, generation guards, and
 * Chinese builtin labels that do not rewrite a permissions-only save.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RoleManagementView from '../src/views/RoleManagementView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

const PERMISSIONS = [
  { code: 'attendance:read', name: 'Attendance Read', description: 'Read attendance records and summaries' },
  { code: 'custom:note', name: 'Floor only', description: 'Keep this note' },
  { code: 'constructor', name: 'Attendance Read', description: 'Read attendance records and summaries' },
]

const ROLES = [
  { id: 'attendance_admin', name: 'Attendance Admin', permissions: ['attendance:read'], memberCount: 25, updatedAt: '2026-10-14T00:00:00.000Z' },
  { id: 'custom-role', name: 'Floor Captain', permissions: [], memberCount: 0, updatedAt: '2026-10-14T00:00:00.000Z' },
  { id: 'constructor', name: 'Attendance Admin', permissions: [], memberCount: 1, updatedAt: '2026-10-14T00:00:00.000Z' },
  { id: 'role-a', name: 'Role A', permissions: [], memberCount: 1, updatedAt: '2026-10-14T00:00:00.000Z' },
  { id: 'role-b', name: 'Role B', permissions: [], memberCount: 1, updatedAt: '2026-10-14T00:00:00.000Z' },
]

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function catalogResponse() {
  return jsonResponse({ ok: true, data: { items: ROLES, total: ROLES.length } })
}

function membersResponse(items: Array<{ id: string; displayName: string; email?: string }>, total: number, page: number, status = 200) {
  return jsonResponse({
    ok: status >= 200 && status < 300,
    data: { items, page, pageSize: 20, total },
  }, status)
}

type DeferredMemberRead = {
  resolve: (value: ReturnType<typeof membersResponse>) => void
  reject: (reason: unknown) => void
}

function deferMemberRead(pending: DeferredMemberRead[]): Promise<ReturnType<typeof membersResponse>> {
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject })
  })
}

function readMembersUrl(url: string): { roleId: string; page: number; pageSize: string | null } | null {
  const parsed = new URL(url, 'http://local.test')
  const prefix = '/api/admin/roles/'
  if (!parsed.pathname.startsWith(prefix) || !parsed.pathname.endsWith('/members')) return null
  const roleId = decodeURIComponent(parsed.pathname.slice(prefix.length, -'/members'.length))
  return {
    roleId,
    page: Number(parsed.searchParams.get('page') || '1'),
    pageSize: parsed.searchParams.get('pageSize'),
  }
}

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let container: HTMLElement | null = null
let app: App<Element> | null = null

function membersRoot(): HTMLElement {
  const root = container?.querySelector('.role-members')
  if (!root) throw new Error('member panel not mounted')
  return root as HTMLElement
}

function membersText(): string {
  return membersRoot().textContent || ''
}

function roleButton(id: string): HTMLButtonElement {
  const button = Array.from(container?.querySelectorAll('.admin-page__item') || []).find((item) => (
    item.querySelector('span')?.textContent === id
  ))
  if (!button) throw new Error(`role ${id} not found`)
  return button as HTMLButtonElement
}

function permissionLabel(code: string): string {
  const label = Array.from(container?.querySelectorAll('.admin-page__checkbox') || []).find((item) => (
    item.querySelector('strong')?.textContent === code
  ))
  if (!label) throw new Error(`permission ${code} not found`)
  return label.textContent || ''
}

function nameInput(): HTMLInputElement {
  const field = Array.from(container?.querySelectorAll('.admin-page__field') || []).find((item) => (
    item.textContent?.includes('角色名称')
  ))
  const input = field?.querySelector('input')
  if (!input) throw new Error('role name input not found')
  return input as HTMLInputElement
}

function clickSave(): void {
  const save = container?.querySelector('.admin-page__footer .admin-page__button') as HTMLButtonElement | null
  if (!save) throw new Error('save button not found')
  save.click()
}

function savedBody(): Record<string, unknown> {
  const write = apiFetchMock.mock.calls
    .map(([url, init]) => ({ url: String(url), init: init as { method?: string; body?: string } | undefined }))
    .find((call) => call.init?.method === 'PUT')
  if (!write?.init?.body) throw new Error('no save recorded')
  return JSON.parse(write.init.body) as Record<string, unknown>
}

async function mountView(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(RoleManagementView)
  app.mount(container)
  await flushUi()
}

async function selectRole(id: string): Promise<void> {
  roleButton(id).click()
  await flushUi()
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

describe('RoleManagementView members and Chinese labels', () => {
  it('shows verified Chinese labels and keeps the stored name on a permissions-only save', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return catalogResponse()
      if (readMembersUrl(url)) return membersResponse([], 0, 1)
      if (init?.method === 'PUT') {
        return jsonResponse({ ok: true, data: { id: 'attendance_admin', name: 'Attendance Admin', permissions: ['attendance:read', 'custom:note'] } })
      }
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    expect(roleButton('attendance_admin').querySelector('strong')?.textContent).toBe('考勤管理员')
    expect(roleButton('custom-role').querySelector('strong')?.textContent).toBe('Floor Captain')
    expect(roleButton('constructor').querySelector('strong')?.textContent).toBe('Attendance Admin')
    expect(permissionLabel('attendance:read')).toContain('考勤读取')
    expect(permissionLabel('attendance:read')).toContain('读取考勤记录和汇总')
    expect(permissionLabel('attendance:read')).not.toContain('Attendance Read')
    expect(permissionLabel('custom:note')).toContain('Floor only')
    expect(permissionLabel('custom:note')).toContain('Keep this note')
    expect(permissionLabel('constructor')).toContain('Attendance Read')
    expect(permissionLabel('constructor')).toContain('Read attendance records and summaries')

    await selectRole('attendance_admin')
    expect(nameInput().value).toBe('考勤管理员')
    const customLabel = Array.from(container?.querySelectorAll('.admin-page__checkbox') || []).find((item) => (
      item.querySelector('strong')?.textContent === 'custom:note'
    ))
    const checkbox = customLabel?.querySelector('input') as HTMLInputElement | null
    if (!checkbox) throw new Error('custom permission missing')
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
    await flushUi()
    clickSave()
    await flushUi()

    expect(savedBody().name).toBe('Attendance Admin')
    expect(savedBody().permissions).toEqual(['attendance:read', 'custom:note'])
    expect(nameInput().value).toBe('考勤管理员')
  })

  it('persists an explicit name edit and a custom stored name', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return catalogResponse()
      if (readMembersUrl(url)) return membersResponse([], 0, 1)
      if (init?.method === 'PUT') return jsonResponse({ ok: true, data: { id: 'attendance_admin' } })
      throw new Error(`unexpected call ${url}`)
    })

    await mountView()
    await selectRole('custom-role')
    expect(nameInput().value).toBe('Floor Captain')
    clickSave()
    await flushUi()
    expect(savedBody().name).toBe('Floor Captain')

    apiFetchMock.mockClear()
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return catalogResponse()
      if (readMembersUrl(url)) return membersResponse([], 0, 1)
      if (init?.method === 'PUT') return jsonResponse({ ok: true, data: { id: 'attendance_admin' } })
      throw new Error(`unexpected call ${url}`)
    })
    await selectRole('attendance_admin')
    const input = nameInput()
    input.value = '现场负责人'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    clickSave()
    await flushUi()
    expect(savedBody().name).toBe('现场负责人')
  })

  it('pages member names and distinguishes an empty page, an empty role, and a failed read', async () => {
    const seen: string[] = []
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return catalogResponse()
      const members = readMembersUrl(url)
      if (!members) throw new Error(`unexpected call ${url}`)
      seen.push(`${members.roleId}:${members.page}:${members.pageSize}`)
      if (members.roleId === 'custom-role') return membersResponse([], 0, members.page)
      if (members.roleId === 'constructor') return jsonResponse({ ok: false, error: { code: 'ROLE_MEMBERS_UNAVAILABLE' } }, 503)
      if (members.page === 1) {
        return membersResponse([
          { id: 'u1', displayName: '甲一', email: 'secret@example.test' },
          { id: 'u2', displayName: '甲二' },
        ], 25, 1)
      }
      return membersResponse([], 25, 2)
    })

    await mountView()
    await selectRole('attendance_admin')
    expect(membersText()).toContain('甲一')
    expect(membersText()).toContain('甲二')
    expect(membersText()).toContain('共 25 人')
    expect(membersText()).not.toContain('secret@example.test')
    expect(membersText()).not.toContain('暂无成员')
    expect(seen[0]).toBe('attendance_admin:1:20')

    ;(membersRoot().querySelector('.role-members__next') as HTMLButtonElement).click()
    await flushUi()
    expect(membersText()).toContain('这一页没有成员')
    expect(membersText()).toContain('共 25 人')
    expect(membersText()).not.toContain('甲一')
    expect(membersText()).not.toContain('暂无成员')
    expect(seen.at(-1)).toBe('attendance_admin:2:20')

    ;(membersRoot().querySelector('.role-members__prev') as HTMLButtonElement).click()
    await flushUi()
    expect(membersText()).toContain('甲一')
    expect(membersText()).not.toContain('这一页没有成员')

    await selectRole('custom-role')
    expect(membersText()).toContain('暂无成员')
    expect(membersText()).toContain('共 0 人')
    expect(membersText()).not.toContain('暂时不可用')

    await selectRole('constructor')
    expect(membersText()).toContain('成员名单暂时不可用')
    expect(membersText()).not.toContain('暂无成员')
    expect(membersText()).not.toContain('共 0 人')
  })

  it('a refresh failure clears the roster and does not claim there are no members', async () => {
    let reads = 0
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/permissions') return jsonResponse({ ok: true, data: PERMISSIONS })
      if (url === '/api/admin/roles') return catalogResponse()
      if (!readMembersUrl(url)) throw new Error(`unexpected call ${url}`)
      reads += 1
      if (reads === 1) return membersResponse([{ id: 'u1', displayName: '张三' }], 1, 1)
      return jsonResponse({ ok: false, error: { message: 'down' } }, 503)
    })

    await mountView()
    await selectRole('attendance_admin')
    expect(membersText()).toContain('张三')
    ;(membersRoot().querySelector('.role-members__refresh') as HTMLButtonElement).click()
    await flushUi()
    expect(membersText()).toContain('成员名单暂时不可用')
    expect(membersText()).not.toContain('张三')
    expect(membersText()).not.toContain('暂无成员')
    expect(membersText()).not.toContain('共 0 人')
  })

  it('ignores stale member replies when the role switches A to B to A', async () => {
    const pending: DeferredMemberRead[] = []
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/permissions') return Promise.resolve(jsonResponse({ ok: true, data: PERMISSIONS }))
      if (url === '/api/admin/roles') return Promise.resolve(catalogResponse())
      const members = readMembersUrl(url)
      if (!members) return Promise.reject(new Error(`unexpected call ${url}`))
      return deferMemberRead(pending)
    })

    await mountView()
    await selectRole('role-a')
    expect(membersText()).toContain('正在加载成员')
    expect(membersText()).not.toContain('暂无成员')
    await selectRole('role-b')
    await selectRole('role-a')
    expect(pending).toHaveLength(3)
    const [oldest, intermediate, newest] = pending
    if (!oldest || !intermediate || !newest) throw new Error('expected three member reads')

    // The newest read completes before the older ones. Finishing the old reads first
    // would keep their names behind the loading line until the fresh read landed.
    newest.resolve(membersResponse([{ id: 'fresh-a', displayName: '当前甲' }], 1, 1))
    await flushUi()
    expect(membersText()).toContain('当前甲')
    expect(membersText()).toContain('共 1 人')
    expect(membersText()).not.toContain('正在加载')

    oldest.resolve(membersResponse([{ id: 'stale-a', displayName: '过期甲' }], 9, 1))
    await flushUi()
    expect(membersText()).toContain('当前甲')
    expect(membersText()).not.toContain('过期甲')
    expect(membersText()).not.toContain('共 9 人')

    intermediate.reject(new Error('stale member read'))
    await flushUi()
    expect(membersText()).toContain('当前甲')
    expect(membersText()).toContain('共 1 人')
    expect(membersText()).not.toContain('过期甲')
    expect(membersText()).not.toContain('过期乙')
    expect(membersText()).not.toContain('成员名单暂时不可用')
    expect(membersText()).not.toContain('暂无成员')
    expect(membersText()).not.toContain('正在加载')
  })

  it('ignores stale page replies when paging forward and back', async () => {
    const pending: DeferredMemberRead[] = []
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/permissions') return Promise.resolve(jsonResponse({ ok: true, data: PERMISSIONS }))
      if (url === '/api/admin/roles') return Promise.resolve(catalogResponse())
      if (!readMembersUrl(url)) return Promise.reject(new Error(`unexpected call ${url}`))
      return deferMemberRead(pending)
    })

    await mountView()
    await selectRole('attendance_admin')
    ;(membersRoot().querySelector('.role-members__next') as HTMLButtonElement).click()
    await flushUi()
    ;(membersRoot().querySelector('.role-members__prev') as HTMLButtonElement).click()
    await flushUi()
    expect(pending).toHaveLength(3)
    const [oldest, intermediate, newest] = pending
    if (!oldest || !intermediate || !newest) throw new Error('expected three member reads')

    newest.resolve(membersResponse([{ id: 'p1b', displayName: '第一页新' }], 25, 1))
    await flushUi()
    expect(membersText()).toContain('第一页新')
    expect(membersText()).toContain('共 25 人')
    expect(membersText()).toContain('第 1 页')
    expect(membersText()).not.toContain('正在加载')

    oldest.resolve(membersResponse([{ id: 'p1', displayName: '第一页旧' }], 99, 1))
    await flushUi()
    expect(membersText()).toContain('第一页新')
    expect(membersText()).not.toContain('第一页旧')
    expect(membersText()).not.toContain('共 99 人')

    intermediate.resolve(membersResponse([{ id: 'p2', displayName: '第二页旧' }], 99, 2, 503))
    await flushUi()
    expect(membersText()).toContain('第一页新')
    expect(membersText()).toContain('共 25 人')
    expect(membersText()).toContain('第 1 页')
    expect(membersText()).not.toContain('第一页旧')
    expect(membersText()).not.toContain('第二页旧')
    expect(membersText()).not.toContain('第 2 页')
    expect(membersText()).not.toContain('共 99 人')
    expect(membersText()).not.toContain('成员名单暂时不可用')
    expect(membersText()).not.toContain('暂无成员')
    expect(membersText()).not.toContain('正在加载')
  })
})
