import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import LocalOrganizationView from '../src/views/LocalOrganizationView.vue'
import { departmentRows, parentOptions } from '../src/components/localOrganization/departmentTree'
import type { LocalDepartment } from '../src/services/localOrganizationClient'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), admin: true, session: 'session-a',
  listeners: new Set<() => void>(), routeGuard: null as (() => boolean) | null,
}))
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }))
vi.mock('../src/composables/useAuth', () => ({ useAuth: () => ({ hasAdminAccess: () => mocks.admin }) }))
vi.mock('../src/composables/authPrincipal', () => ({
  readAuthSessionSignature: () => mocks.session,
  TOKEN_KEYS: ['auth_token', 'jwt', 'devToken'],
  onAuthPrincipalChange: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) },
}))
vi.mock('../src/utils/explicitSessionOrg', () => ({ EXPLICIT_SESSION_ORG_KEY: 'explicit-org' }))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: (guard: () => boolean) => { mocks.routeGuard = guard } }))
const anchor = '11111111-1111-4111-8111-111111111111'
const otherAnchor = '99999999-9999-4999-8999-999999999999'
const a = '22222222-2222-4222-8222-222222222222'
const b = '77777777-7777-4777-8777-777777777777'
const d1 = '33333333-3333-4333-8333-333333333333'
const d2 = '44444444-4444-4444-8444-444444444444'
const d3 = '55555555-5555-4555-8555-555555555555'
const d4 = '66666666-6666-4666-8666-666666666666'
const m1 = a + ':' + d1
const m2 = a + ':' + d2
const mb = b + ':' + d2
const departments: LocalDepartment[] = [
  { id: d1, name: '研发', parentDepartmentId: null, parentMissing: false, orderIndex: 1, isActive: true },
  { id: d2, name: '运营', parentDepartmentId: null, parentMissing: false, orderIndex: 2, isActive: true },
  { id: d3, name: '研发组', parentDepartmentId: d1, parentMissing: false, orderIndex: 0, isActive: true },
  { id: d4, name: '旧部门', parentDepartmentId: null, parentMissing: false, orderIndex: 3, isActive: false },
]
const membership = (accountId: string, departmentId: string, departmentName: string, isPrimary = false) =>
  ({ id: accountId + ':' + departmentId, departmentId, departmentName, departmentActive: true, isPrimary, isManager: false })
const members = [
  { id: a, name: '陈晨', title: '工程师', isActive: true, localUser: { id: 'user-a', name: '陈晨', username: 'chen' }, isEligible: true,
    memberships: [membership(a, d1, '研发'), membership(a, d2, '运营', true)] },
  { id: b, name: '李林', title: null, isActive: true, localUser: { id: 'user-b', name: '李林', username: 'li' }, isEligible: true,
    memberships: [membership(b, d2, '运营')] },
]
const workspace = (isActive = true, id = anchor) => ({ integration: { id, name: '本地组织', isActive }, departments })
type TestResponse = { ok: boolean; status: number; json: () => Promise<unknown> }
const candidates = [
  { id: 'platform-one', name: '王文', username: 'wang' },
  { id: 'platform-two', name: null, username: 'lin' },
  { id: 'platform-unnamed', name: null, username: null },
]
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) })
const failure = (status: number) => ({ ok: false, status, json: async () => ({ ok: false, error: { code: status === 409 ? 'DIRECTORY_LOCAL_CONFLICT' : 'DIRECTORY_LOCAL_INVALID_INPUT', message: 'private-error-detail' } }) })
const head = (id: string, isDepartmentHead = false, readOnly = false) => {
  const [accountId, departmentId] = id.split(':')
  return { membership: { id, accountId, departmentId, isDepartmentHead, readOnly } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush(cycles = 18) {
  for (let i = 0; i < cycles; i++) { await Promise.resolve(); await nextTick() }
}
let app: App<Element> | null
let container: HTMLDivElement
function server(path: string, init: RequestInit = {}) {
  const url = new URL(path, 'https://test.invalid')
  if (init.method && init.method !== 'GET') {
    if (url.pathname.endsWith('/member-projections')) return response({ projection: { accountId: a, created: true } })
    if (url.pathname.endsWith('/department-head')) {
      const id = decodeURIComponent(url.pathname.split('/').slice(-2)[0])
      const value = JSON.parse(String(init.body)).isDepartmentHead
      const { readOnly: _readOnly, ...membership } = head(id, value).membership
      return response({ membership })
    }
    return response({ department: {}, account: {}, membership: {} })
  }
  if (url.pathname.endsWith('/workspace')) return response(workspace())
  if (url.pathname.endsWith('/member-candidates')) return response({
    integrationId: url.searchParams.get('integrationId'), page: Number(url.searchParams.get('page')),
    pageSize: 25, total: 60, items: candidates,
  })
  if (url.pathname.endsWith('/members')) return response({
    integrationId: url.searchParams.get('integrationId'), page: Number(url.searchParams.get('page')),
    pageSize: 25, total: 60, items: members,
  })
  if (url.pathname.endsWith('/department-head')) return response(head(decodeURIComponent(url.pathname.split('/').slice(-2)[0])))
  throw new Error('unexpected test request')
}
function mount() { app = createApp(LocalOrganizationView); app.mount(container) }
function button(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find(el => el.textContent?.trim() === text)
  if (!result) throw new Error('missing labeled button: ' + text)
  return result
}
async function click(text: string) { button(text).click(); await flush() }
function control(label: string): HTMLInputElement | HTMLSelectElement {
  const element = Array.from(container.querySelectorAll('label')).find(el => el.textContent?.trim().startsWith(label))?.querySelector('input, select')
  if (!element) throw new Error('missing labeled control: ' + label)
  return element as HTMLInputElement | HTMLSelectElement
}
const memberArchiveAck = '我已了解并确认归档本地组织成员的影响'
const departmentArchiveAck = '我已了解并确认归档部门的影响'
const archiveCases = [
  { kind: 'member', selection: '陈晨', next: '李林', action: '归档本地组织成员', ack: memberArchiveAck, path: '/accounts/' + a + '/archive' },
  { kind: 'department', selection: '研发', next: '运营', action: '归档部门', ack: departmentArchiveAck, path: '/departments/' + d1 + '/archive' },
]
async function acknowledge(label: string) {
  const checkbox = control(label) as HTMLInputElement
  expect(checkbox.type).toBe('checkbox')
  expect(checkbox.checked).toBe(false)
  checkbox.click(); await flush()
  expect(checkbox.checked).toBe(true)
}
async function value(label: string, v: string) {
  const el = control(label); el.value = v
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  await flush()
}
function writes() { return mocks.fetch.mock.calls.filter(([, init]) => init.method !== 'GET') }
function expectLastWrite(path: string, method: string, body: object) {
  const commands = writes()
  expect(commands[commands.length - 1]).toEqual(['/api/admin/directory/local' + path, {
    method, suppressUnauthorizedRedirect: true, body: JSON.stringify(body),
  }])
}
beforeEach(() => {
  mocks.fetch.mockReset(); mocks.fetch.mockImplementation(server)
  mocks.admin = true; mocks.session = 'session-a'; mocks.listeners.clear(); mocks.routeGuard = null
  app = null; container = document.createElement('div'); document.body.appendChild(container)
})
afterEach(() => { app?.unmount(); container.remove(); app = null })

describe('local organization workspace', () => {
  it('shows meaningful projection labels, explicit primary and no config entry or head N+1', async () => {
    mount(); await flush()
    expect(container.textContent).toContain('MetaSheet')
    expect(container.textContent).not.toContain(anchor)
    expect(container.textContent).not.toContain(a)
    expect(container.textContent).not.toContain('appSecret')
    expect(container.textContent).toContain('建立目录表示')
    expect(container.textContent).not.toContain('platform-one')
    expect(container.textContent).toContain('王文（wang）')
    expect(container.textContent).toContain('不授予权限')
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/admin/directory/local/workspace',
      '/api/admin/directory/local/members?integrationId=' + anchor + '&page=1&pageSize=25&q=',
      '/api/admin/directory/local/member-candidates?integrationId=' + anchor + '&page=1&pageSize=25&q=',
    ])
    await click('陈晨')
    expect(container.textContent).toContain('组织目录职务（只读）：工程师')
    expect(mocks.fetch.mock.calls).toHaveLength(3)
    await value('选择部门关系', m1)
    expect(container.textContent).toContain('非主部门')
    expect(button('设为主部门').matches(':disabled')).toBe(false)
    await value('选择部门关系', m2)
    expect(container.textContent).toContain('当前主部门')
    expect(button('设为主部门').matches(':disabled')).toBe(true)
  })
  it('creates and renames/reparents/reorders/archives departments with exact HTTP commands', async () => {
    mount(); await flush()
    await value('部门名称', '测试部门'); await value('上级部门', d2); await value('部门排序', '7')
    await click('保存部门')
    expectLastWrite('/departments', 'POST', { name: '测试部门', parentDepartmentId: d2, orderIndex: 7 })
    await click('研发')
    expect(Array.from((control('上级部门') as HTMLSelectElement).options).map(o => o.value)).not.toContain(d3)
    await value('部门名称', '研发中心'); await value('上级部门', d2); await value('部门排序', '-2')
    await click('保存部门')
    expectLastWrite('/departments/' + d1, 'PATCH', { name: '研发中心', parentDepartmentId: d2, orderIndex: -2 })
    await click('研发'); await acknowledge(departmentArchiveAck); await click('归档部门')
    expectLastWrite('/departments/' + d1 + '/archive', 'POST', {})
    await click('旧部门（已归档）')
    expect(button('保存部门').matches(':disabled')).toBe(true)
  })
  it('saves only member names and keeps directory title read-only with an existing platform-job link', async () => {
    mount(); await flush(); await click('陈晨')
    expect(container.textContent).toContain('组织目录职务（只读）：工程师')
    expect(container.textContent).toContain('组织目录职务可能用于审批条件；不授予权限，也不会自动同步到平台岗位')
    expect(Array.from(container.querySelectorAll('label')).some(el => el.textContent?.trim() === '职务')).toBe(false)
    expect(Array.from(container.querySelectorAll('input')).some(el => el.value === '工程师')).toBe(false)
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/users"]')!
    expect(link.textContent).toBe('维护平台岗位')
    expect(link.getAttribute('href')).toBe('/admin/users')
    await value('成员姓名', '陈新'); await click('保存成员资料')
    expectLastWrite('/accounts/' + a, 'PATCH', { name: '陈新' })
    await click('李林')
    expect(container.textContent).toContain('组织目录职务（只读）：未提供')
    await click('保存成员资料')
    expectLastWrite('/accounts/' + b, 'PATCH', { name: '李林' })
    expect(writes()).toHaveLength(2)
  })
  it.each(archiveCases)('requires explicit $kind archive acknowledgement before the exact old POST', async target => {
    mount(); await flush(); await click(target.selection)
    expect(button(target.action).matches(':disabled')).toBe(true)
    button(target.action).dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush()
    expect(writes()).toHaveLength(0)
    if (target.kind === 'member') {
      expect(container.textContent).toContain('停用本地目录账号')
      expect(container.textContent).toContain('同一组织内没有其他活跃且已链接的目录账号')
      expect(container.textContent).toContain('现有组织成员资格可能被停用')
      expect(container.textContent).toContain('不会删除平台用户或角色')
    } else {
      expect(container.textContent).toContain('不能切换任何主部门，即使被归档的只是非主部门')
      expect(container.textContent).toContain('此页不会自动迁移或恢复关系')
    }
    await acknowledge(target.ack); await click(target.action)
    expectLastWrite(target.path, 'POST', {})
    expect(writes()).toHaveLength(1)
    await click(target.selection)
    expect((control(target.ack) as HTMLInputElement).checked).toBe(false)
    await click(target.action)
    expect(writes()).toHaveLength(1)
  })
  it.each(archiveCases)('does not reuse $kind archive acknowledgement after selecting another target or returning', async target => {
    mount(); await flush(); await click(target.selection); await acknowledge(target.ack)
    await click(target.next)
    expect((control(target.ack) as HTMLInputElement).checked).toBe(false)
    await click(target.action)
    await click(target.selection)
    expect((control(target.ack) as HTMLInputElement).checked).toBe(false)
    await click(target.action)
    expect(writes()).toHaveLength(0)
  })
  it.each(archiveCases.flatMap(target => (['refresh', 'session', 'context'] as const).map(reset => ({ ...target, reset }))))(
    'clears $kind archive acknowledgement on $reset', async target => {
      mount(); await flush(); await click(target.selection); await acknowledge(target.ack)
      if (target.reset === 'session') {
        mocks.session = 'session-b'; for (const listener of mocks.listeners) listener()
        await flush()
      } else if (target.reset === 'context') {
        window.dispatchEvent(new StorageEvent('storage', { key: 'explicit-org' })); await flush()
      }
      await click('重新加载组织'); await click(target.selection)
      expect((control(target.ack) as HTMLInputElement).checked).toBe(false)
      await click(target.action)
      expect(writes()).toHaveLength(0)
    },
  )
  it.each(archiveCases.flatMap(target => ([400, 403, 409, 'network'] as const).map(outcome => ({ ...target, outcome }))))(
    'consumes $kind acknowledgement on $outcome without refresh or replay', async target => {
      mount(); await flush(); await click(target.selection); await acknowledge(target.ack)
      mocks.fetch.mockImplementation((path: string, init: RequestInit) => {
        if (path.endsWith('/archive')) return typeof target.outcome === 'number'
          ? failure(target.outcome) : Promise.reject(new Error('private-archive-error'))
        return server(path, init)
      })
      const count = mocks.fetch.mock.calls.length
      await click(target.action)
      expectLastWrite(target.path, 'POST', {})
      expect(mocks.fetch).toHaveBeenCalledTimes(count + 1)
      expect(writes()).toHaveLength(1)
      expect(container.textContent).not.toContain('private-archive-error')
      expect(container.textContent).not.toContain('private-error-detail')
      if (target.outcome !== 403) {
        expect((control(target.ack) as HTMLInputElement).checked).toBe(false)
        button(target.action).dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush()
        expect(mocks.fetch).toHaveBeenCalledTimes(count + 1)
      } else expect(container.querySelector('#departments-heading')).toBeNull()
    },
  )
  it.each(archiveCases)('captures the $kind archive target and holds the single-write lock until completion', async target => {
    const pending = deferred<TestResponse>()
    mount(); await flush(); await click('陈晨'); await click(target.selection); await acknowledge(target.ack)
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/archive') ? pending.promise : server(path, init))
    await click(target.action)
    expectLastWrite(target.path, 'POST', {})
    expect((control(target.ack) as HTMLInputElement).checked).toBe(false)
    expect(button(target.next).matches(':disabled')).toBe(true)
    expect(button('保存成员资料').matches(':disabled')).toBe(true)
    expect(mocks.routeGuard?.()).toBe(false)
    const navigation = new MouseEvent('click', { bubbles: true, cancelable: true })
    container.querySelector('a[href="/admin/users"]')!.dispatchEvent(navigation)
    expect(navigation.defaultPrevented).toBe(true)
    await click(target.next)
    button(target.action).dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush()
    await click('保存成员资料')
    expect(writes()).toHaveLength(1)
    expectLastWrite(target.path, 'POST', {})
    pending.resolve(response({ account: {}, department: {} })); await flush()
    expect(mocks.routeGuard?.()).toBe(true)
  })
  it('resets member archive acknowledgement on membership selection and member refresh', async () => {
    mount(); await flush(); await click('陈晨'); await acknowledge(memberArchiveAck)
    await value('选择部门关系', m1)
    expect((control(memberArchiveAck) as HTMLInputElement).checked).toBe(false)
    await acknowledge(memberArchiveAck); await click('搜索成员'); await click('陈晨')
    expect((control(memberArchiveAck) as HTMLInputElement).checked).toBe(false)
    await click('归档本地组织成员')
    expect(writes()).toHaveLength(0)
  })
  it('blocks every primary switch when an archived non-primary sibling is linked', async () => {
    const archivedSibling = { ...membership(a, d4, '旧部门'), departmentActive: false }
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.includes('/members?') ? response({
      integrationId: anchor, page: 1, pageSize: 25, total: 1,
      items: [{ ...members[0], memberships: [...members[0].memberships, archivedSibling] }],
    }) : server(path, init))
    mount(); await flush(); await click('陈晨'); await value('选择部门关系', m1)
    expect(container.textContent).toContain('即使只是非主部门，也不能切换任何主部门')
    expect(button('设为主部门').matches(':disabled')).toBe(true)
    await click('设为主部门')
    await value('选择部门关系', a + ':' + d4)
    expect(button('设为主部门').matches(':disabled')).toBe(true)
    expect(button('设为部门直属主管').matches(':disabled')).toBe(true)
    expect(button('设为部门负责人').matches(':disabled')).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it('keeps department manager and head independent of job text without activating approval sources', async () => {
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.includes('/members?') ? response({
      integrationId: anchor, page: 1, pageSize: 25, total: 1,
      items: [{ ...members[0], title: '部门负责人兼直属主管' }],
    }) : server(path, init))
    mount(); await flush(); await click('陈晨'); await value('选择部门关系', m1)
    expect(container.textContent).toContain('部门直属主管是部门级关系，不是为每位员工独立设置直属上级')
    expect(container.textContent).toContain('部门负责人为独立标记，二者互不推导')
    expect(container.textContent).toContain('成员角色不会从职务或部门名称等自由文本推导')
    expect(container.textContent).toContain('不会自动选择审批组织来源、启用审批策略或发布模板')
    expect(button('设为部门直属主管').matches(':disabled')).toBe(false)
    expect(button('设为部门负责人').matches(':disabled')).toBe(false)
    expect(container.textContent).toContain('非部门直属主管')
    expect(container.textContent).toContain('部门负责人：否')
    expect(writes()).toHaveLength(0)
  })
  it('adds membership and sets explicit primary, direct manager and selected department head', async () => {
    mount(); await flush(); await click('陈晨')
    await value('添加到部门', d3); await click('添加部门关系')
    expectLastWrite('/memberships', 'POST', { accountId: a, departmentId: d3 })
    await click('陈晨'); await value('选择部门关系', m1); await click('设为主部门')
    expectLastWrite('/memberships/' + encodeURIComponent(m1), 'PATCH', { isPrimary: true })
    await click('陈晨'); await value('选择部门关系', m1); await click('设为部门直属主管')
    expectLastWrite('/memberships/' + encodeURIComponent(m1), 'PATCH', { isManager: true })
    await click('陈晨'); await value('选择部门关系', m1); await click('设为部门负责人')
    expectLastWrite('/memberships/' + encodeURIComponent(m1) + '/department-head', 'PATCH', { isDepartmentHead: true })
  })
  it.each([400, 403, 409])('renders fixed read errors for %s, clearing private data on 403', async status => {
    mount(); await flush(); await click('陈晨'); await value('选择部门关系', m1)
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/workspace') ? failure(status) : server(path, init))
    await click('重新加载组织')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).not.toContain('private-error-detail')
    expect(container.textContent).not.toContain('陈晨')
    expect(container.querySelector('#member-heading')).toBeNull()
    expect(writes()).toHaveLength(0)
  })
  it('keeps unknown or unavailable head inert and supports an explicit retry', async () => {
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/department-head') ? failure(404) : server(path, init))
    mount(); await flush(); await click('陈晨'); await value('选择部门关系', m1)
    expect(container.textContent).toContain('部门负责人：未知')
    expect(button('设为部门负责人').matches(':disabled')).toBe(true)
    await click('设为部门负责人')
    expect(writes()).toHaveLength(0)
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/department-head') ? response(head(m1, false, true)) : server(path, init))
    await click('重试读取负责人')
    expect(container.textContent).toContain('部门负责人：否')
    expect(button('设为部门负责人').matches(':disabled')).toBe(true)
  })
  it.each(['success', 'error', 'forbidden'] as const)('ignores late selected-member head %s and its finally while a newer head is loading', async outcome => {
    const old = deferred<TestResponse>()
    const next = deferred<TestResponse>()
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => {
      if (path.endsWith('/department-head')) return path.includes(encodeURIComponent(m1)) ? old.promise : next.promise
      return server(path, init)
    })
    mount(); await flush(); await click('陈晨'); await value('选择部门关系', m1)
    await click('李林'); await value('选择部门关系', mb)
    if (outcome === 'success') old.resolve(response(head(m1, true)))
    else if (outcome === 'forbidden') old.resolve(failure(403))
    else old.reject(new Error('private-old-error'))
    await flush()
    expect(container.querySelector('#member-heading')?.textContent).toBe('李林')
    expect(container.textContent).toContain('部门负责人：读取中')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    next.resolve(response(head(mb, false))); await flush()
    expect(container.textContent).toContain('部门负责人：否')
  })
  it('guards selected membership changes independently within the same member', async () => {
    const old = deferred<TestResponse>()
    const next = deferred<TestResponse>()
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/department-head')
      ? (path.includes(encodeURIComponent(m1)) ? old.promise : next.promise) : server(path, init))
    mount(); await flush(); await click('陈晨'); await value('选择部门关系', m1); await value('选择部门关系', m2)
    old.resolve(response(head(m1, true))); await flush()
    expect(container.textContent).toContain('部门负责人：读取中')
    next.resolve(response(head(m2, false))); await flush()
    expect(container.textContent).toContain('部门负责人：否')
  })
  it.each(['success', 'error'] as const)('ignores late page %s/catch/finally while newer search is loading', async outcome => {
    const old = deferred<TestResponse>()
    const next = deferred<TestResponse>()
    mount(); await flush(); await click('陈晨')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => {
      if (path.includes('/members?')) return path.includes('page=2&') ? old.promise : next.promise
      return server(path, init)
    })
    await click('下一页成员')
    await value('查找组织成员', '李'); await click('搜索成员')
    expect(container.querySelector('#member-heading')).toBeNull()
    if (outcome === 'success') old.resolve(response({ integrationId: anchor, page: 2, pageSize: 25, total: 60, items: members }))
    else old.reject(new Error('private-old-page'))
    await flush()
    expect(container.textContent).toContain('正在加载成员')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    next.resolve(response({ integrationId: anchor, page: 1, pageSize: 25, total: 1, items: [members[1]] }))
    await flush()
    expect(container.textContent).toContain('李林')
    expect(container.textContent).not.toContain('陈晨')
  })
  it('clears on a session event and ignores old workspace JSON/finally after a newer context starts', async () => {
    const json = deferred<unknown>()
    mocks.fetch.mockReturnValueOnce({ ok: true, status: 200, json: () => json.promise })
    mount(); await flush()
    mocks.session = 'session-b'; for (const listener of mocks.listeners) listener()
    await flush()
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/workspace') ? response(workspace(true, otherAnchor)) : server(path, init))
    await click('重新加载组织')
    json.resolve({ ok: true, data: workspace() }); await flush()
    const lastMemberRead = mocks.fetch.mock.calls.filter(([path]) => path.includes('/members?')).pop()
    expect(lastMemberRead?.[0]).toContain('integrationId=' + otherAnchor)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain('正在加载组织')
  })
  it('invalidates displayed data on storage/context changes and silently changed signatures', async () => {
    mount(); await flush(); await click('陈晨'); await value('选择部门关系', m1)
    mocks.session = 'session-b'
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' })); await flush()
    expect(container.textContent).not.toContain('陈晨')
    expect(container.querySelector('#member-heading')).toBeNull()
    await click('重新加载组织'); await click('陈晨')
    mocks.session = 'session-c'; await click('保存成员资料')
    expect(writes()).toHaveLength(0)
    expect(container.textContent).not.toContain('陈晨')
  })
  it('captures the submitted target/values, serializes writes, disables switches and blocks navigation', async () => {
    const pending = deferred<TestResponse>()
    mount(); await flush(); await click('陈晨')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => init.method === 'PATCH' ? pending.promise : server(path, init))
    await value('成员姓名', '提交姓名'); await click('保存成员资料')
    expectLastWrite('/accounts/' + a, 'PATCH', { name: '提交姓名' })
    expect(button('李林').matches(':disabled')).toBe(true)
    expect(button('重新加载组织').matches(':disabled')).toBe(true)
    expect(button('保存部门').matches(':disabled')).toBe(true)
    expect(mocks.routeGuard?.()).toBe(false)
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(true)
    await value('成员姓名', '后来输入'); await click('李林'); await click('保存成员资料')
    expect(writes()).toHaveLength(1)
    expectLastWrite('/accounts/' + a, 'PATCH', { name: '提交姓名' })
    pending.resolve(response({ account: {} })); await flush()
    expect(mocks.routeGuard?.()).toBe(true)
  })
  it.each(['success', 'error'] as const)('suppresses a disposed write %s and all subsequent refresh', async outcome => {
    const pending = deferred<TestResponse>()
    mount(); await flush(); await click('陈晨')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => init.method === 'PATCH' ? pending.promise : server(path, init))
    await click('保存成员资料')
    const count = mocks.fetch.mock.calls.length
    app!.unmount(); app = null
    if (outcome === 'success') pending.resolve(response({ account: {} }))
    else pending.reject(new Error('private-late-write'))
    await flush()
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
    expect(container.textContent).toBe('')
    expect(mocks.listeners.size).toBe(0)
  })
  it('suppresses unmounted reads including delayed JSON and head errors', async () => {
    const json = deferred<unknown>()
    mocks.fetch.mockReturnValueOnce({ ok: true, status: 200, json: () => json.promise })
    mount(); await flush()
    app!.unmount(); app = null
    json.resolve({ ok: true, data: workspace() }); await flush()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')
  })
  it('supports empty/read-only/archived states without bootstrap, grants or writes', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ integration: null, departments: [] }))
    mount(); await flush()
    expect(container.textContent).toContain('暂无本地组织目录')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/workspace') ? response(workspace(false)) : server(path, init))
    await click('重新加载组织'); await click('陈晨')
    expect(container.textContent).toContain('只读')
    expect(button('保存成员资料').matches(':disabled')).toBe(true)
    expect(button('新建部门').matches(':disabled')).toBe(true)
    expect(writes()).toHaveLength(0)
    mocks.admin = false; await click('重新加载组织')
    expect(container.textContent).not.toContain('陈晨')
    expect(container.textContent).toContain('无权管理组织')
  })
  it('projects one canonical department tree, keeps orphans/cycles visible, excludes descendants as parents', () => {
    const orphan = { ...departments[0], id: 'orphan', parentDepartmentId: 'missing', parentMissing: true }
    const cycleA = { ...departments[0], id: 'cycle-a', parentDepartmentId: 'cycle-b' }
    const cycleB = { ...departments[1], id: 'cycle-b', parentDepartmentId: 'cycle-a' }
    const input = [...departments, orphan, cycleA, cycleB]
    const rows = departmentRows(input)
    expect(rows).toHaveLength(input.length)
    expect(new Set(rows.map(r => r.department.id)).size).toBe(input.length)
    expect(rows.find(r => r.department.id === d3)?.depth).toBe(1)
    expect(rows.find(r => r.department.id === 'orphan')?.department.parentMissing).toBe(true)
    expect(parentOptions(input, d1).map(d => d.id)).not.toContain(d1)
    expect(parentOptions(input, d1).map(d => d.id)).not.toContain(d3)
    expect(parentOptions(input, d1).map(d => d.id)).not.toContain(d4)
  })
  it.each(['success', 'error'] as const)('keeps a newer workspace loading through late old headers/%s/finally', async outcome => {
    const old = deferred<TestResponse>()
    const next = deferred<TestResponse>()
    mocks.fetch.mockReturnValueOnce(old.promise)
    mount(); await flush()
    mocks.session = 'session-b'; for (const listener of mocks.listeners) listener()
    await flush()
    expect(button('重新加载组织').disabled).toBe(false)
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/workspace') ? next.promise : server(path, init))
    await click('重新加载组织')
    expect(mocks.fetch.mock.calls.filter(([path]) => path.endsWith('/workspace'))).toHaveLength(2)
    if (outcome === 'success') old.resolve(response(workspace()))
    else old.reject(new Error('private-old-workspace'))
    await flush()
    expect(container.textContent).toContain('正在加载组织')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    next.resolve(response(workspace(true, otherAnchor))); await flush()
    expect(container.textContent).not.toContain('正在加载组织')
    expect(mocks.fetch.mock.calls.filter(([path]) => path.includes('/members?'))[0][0]).toContain(otherAnchor)
  })
  it('clears member/head data immediately on a current 403 even when its JSON never resolves', async () => {
    mount(); await flush(); await click('陈晨')
    const json = vi.fn(() => new Promise(() => {}))
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/department-head')
      ? { ok: false, status: 403, json } : server(path, init))
    await value('选择部门关系', m1)
    expect(json).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('陈晨')
    expect(container.querySelector('#member-heading')).toBeNull()
    expect(container.textContent).toContain('无权管理组织')
  })
  it('does not refresh, replay or refill private data when a submitted write changes session', async () => {
    const pending = deferred<TestResponse>()
    mount(); await flush(); await click('陈晨')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => init.method === 'PATCH' ? pending.promise : server(path, init))
    await click('保存成员资料')
    const count = mocks.fetch.mock.calls.length
    mocks.session = 'session-b'
    pending.resolve(response({ account: {} })); await flush()
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
    expect(container.textContent).not.toContain('陈晨')
    expect(container.querySelector('#member-heading')).toBeNull()
    expect(container.textContent).toContain('会话已变化')
  })
  it('does not refresh or replay a 409 mutation and retains manual recovery', async () => {
    mount(); await flush(); await click('陈晨')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => init.method === 'PATCH' ? failure(409) : server(path, init))
    const count = mocks.fetch.mock.calls.length
    await click('保存成员资料')
    expect(mocks.fetch).toHaveBeenCalledTimes(count + 1)
    expect(writes()).toHaveLength(1)
    expect(container.textContent).toContain('冲突')
    expect(container.textContent).not.toContain('private-error-detail')
    expect(button('重新加载组织').matches(':disabled')).toBe(false)
  })
  it('shows empty member pages and archived/no-membership members without guessing primary', async () => {
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.includes('/members?') ? response({
      integrationId: anchor, page: 1, pageSize: 25, total: 0, items: [],
    }) : server(path, init))
    mount(); await flush()
    expect(container.textContent).toContain('本页暂无成员')
    expect(container.textContent).toContain('共 0 人')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.includes('/members?') ? response({
      integrationId: anchor, page: 1, pageSize: 25, total: 1, items: [{ ...members[0], memberships: [], isActive: false }],
    }) : server(path, init))
    await click('搜索成员'); await click('陈晨（已归档）')
    expect(container.textContent).toContain('成员已归档')
    expect(container.textContent).toContain('主部门需要明确设置')
    expect(button('保存成员资料').matches(':disabled')).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it.each([true, false])('submits an existing candidate using the exact frozen body and handles created=%s', async created => {
    let submitted = false
    const projected = { ...members[0], id: '88888888-8888-4888-8888-888888888888', name: '王文',
      localUser: { id: 'platform-one', name: '王文', username: 'wang' }, memberships: [] }
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => {
      if (path.endsWith('/member-projections')) {
        submitted = true
        return response({ projection: { accountId: projected.id, created } })
      }
      if (submitted && path.includes('/member-candidates?')) {
        const url = new URL(path, 'https://test.invalid')
        return response({ integrationId: anchor, page: Number(url.searchParams.get('page')), pageSize: 25, total: 1, items: [candidates[1]] })
      }
      if (submitted && path.includes('/members?')) return response({ integrationId: anchor, page: 1, pageSize: 25, total: 3, items: [...members, projected] })
      return server(path, init)
    })
    mount(); await flush()
    expect(button('建立目录表示').matches(':disabled')).toBe(true)
    await value('选择已有平台成员', 'platform-one')
    await click('建立目录表示')
    expectLastWrite('/member-projections', 'POST', { integrationId: anchor, localUserId: 'platform-one' })
    expect(writes()).toHaveLength(1)
    expect(container.textContent).toContain('目录表示已确认')
    expect(container.querySelector('[aria-label="组织成员"]')?.textContent).toContain('王文')
    expect(control('选择已有平台成员').value).toBe('')
    expect(control('选择已有平台成员').textContent).not.toContain('王文')
    expect(button('建立目录表示').matches(':disabled')).toBe(true)
  })
  it('searches/pages candidates with the expected anchor, clears selection and never offers technical ID entry', async () => {
    mount(); await flush(); await value('选择已有平台成员', 'platform-one')
    await click('下一页平台成员')
    expect(control('选择已有平台成员').value).toBe('')
    expect(mocks.fetch.mock.calls.filter(([path]) => path.includes('/member-candidates?')).pop()?.[0]).toBe(
      '/api/admin/directory/local/member-candidates?integrationId=' + anchor + '&page=2&pageSize=25&q=')
    await value('查找已有平台成员', '  lin  '); await click('搜索平台成员')
    expect(mocks.fetch.mock.calls.filter(([path]) => path.includes('/member-candidates?')).pop()?.[0]).toBe(
      '/api/admin/directory/local/member-candidates?integrationId=' + anchor + '&page=1&pageSize=25&q=lin')
    expect(Array.from(container.querySelectorAll('input')).map(el => el.getAttribute('placeholder'))).not.toContain('localUserId')
    const unnamed = Array.from((control('选择已有平台成员') as HTMLSelectElement).options).find(o => o.value === 'platform-unnamed')!
    expect(unnamed.disabled).toBe(true)
    await value('选择已有平台成员', 'platform-unnamed'); await click('建立目录表示')
    expect(writes()).toHaveLength(0)
  })
  it.each(['success', 'error', 'forbidden'] as const)('ignores old candidate page %s/catch/finally while a new search loads', async outcome => {
    const old = deferred<TestResponse>()
    const next = deferred<TestResponse>()
    mount(); await flush(); await value('选择已有平台成员', 'platform-one')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.includes('/member-candidates?')
      ? (path.includes('page=2&') ? old.promise : next.promise) : server(path, init))
    await click('下一页平台成员')
    expect(button('建立目录表示').matches(':disabled')).toBe(true)
    await value('查找已有平台成员', 'lin'); await click('搜索平台成员')
    if (outcome === 'success') old.resolve(response({ integrationId: anchor, page: 2, pageSize: 25, total: 60, items: candidates }))
    else if (outcome === 'forbidden') old.resolve(failure(403))
    else old.reject(new Error('private-old-candidate'))
    await flush()
    expect(container.textContent).toContain('正在加载候选成员')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    next.resolve(response({ integrationId: anchor, page: 1, pageSize: 25, total: 1, items: [candidates[1]] }))
    await flush()
    expect(control('选择已有平台成员').textContent).not.toContain('王文')
    expect(control('选择已有平台成员').textContent).toContain('lin')
  })
  it('refuses mismatched candidate response context without allowing projection', async () => {
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.includes('/member-candidates?')
      ? response({ integrationId: otherAnchor, page: 1, pageSize: 25, total: 1, items: [candidates[0]] }) : server(path, init))
    mount(); await flush()
    expect(container.querySelector('#projection-heading')?.parentElement?.querySelector('[role="alert"]')).not.toBeNull()
    expect(control('选择已有平台成员').textContent).not.toContain('王文')
    expect(button('建立目录表示').matches(':disabled')).toBe(true)
    await click('陈晨')
    expect(button('保存成员资料').matches(':disabled')).toBe(false)
    expect(writes()).toHaveLength(0)
  })
  it.each([400, 403, 409])('handles projection %s without replay; current 403 removes all private state', async status => {
    mount(); await flush(); await click('陈晨'); await value('选择已有平台成员', 'platform-one')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/member-projections') ? failure(status) : server(path, init))
    const count = mocks.fetch.mock.calls.length
    await click('建立目录表示')
    expectLastWrite('/member-projections', 'POST', { integrationId: anchor, localUserId: 'platform-one' })
    expect(mocks.fetch).toHaveBeenCalledTimes(count + 1)
    expect(writes()).toHaveLength(1)
    expect(container.textContent).not.toContain('private-error-detail')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    if (status === 403) {
      expect(container.textContent).not.toContain('陈晨')
      expect(container.querySelector('#projection-heading')).toBeNull()
    }
  })
  it('captures projection anchor/candidate before await and disables all conflicting write/navigation actions', async () => {
    const pending = deferred<TestResponse>()
    mount(); await flush(); await click('陈晨'); await value('选择已有平台成员', 'platform-one')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/member-projections') ? pending.promise : server(path, init))
    await click('建立目录表示')
    expect(control('选择已有平台成员').matches(':disabled')).toBe(true)
    expect(button('搜索平台成员').matches(':disabled')).toBe(true)
    expect(button('保存成员资料').matches(':disabled')).toBe(true)
    expect(button('下一页平台成员').matches(':disabled')).toBe(true)
    expect(mocks.routeGuard?.()).toBe(false)
    await value('选择已有平台成员', 'platform-two')
    await click('建立目录表示'); await click('保存成员资料')
    expect(writes()).toHaveLength(1)
    expectLastWrite('/member-projections', 'POST', { integrationId: anchor, localUserId: 'platform-one' })
    pending.resolve(response({ projection: { accountId: a, created: true } })); await flush()
    expect(mocks.routeGuard?.()).toBe(true)
  })
  it.each(['success', 'error'] as const)('suppresses projection completion %s after unmount without refresh', async outcome => {
    const pending = deferred<TestResponse>()
    mount(); await flush(); await value('选择已有平台成员', 'platform-one')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/member-projections') ? pending.promise : server(path, init))
    await click('建立目录表示')
    const count = mocks.fetch.mock.calls.length
    app!.unmount(); app = null
    if (outcome === 'success') pending.resolve(response({ projection: { accountId: a, created: true } }))
    else pending.reject(new Error('private-late-projection'))
    await flush()
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
    expect(container.textContent).toBe('')
  })
  it('clears candidates/selection on session switch and never refreshes a projection from the prior session', async () => {
    const pending = deferred<TestResponse>()
    mount(); await flush(); await value('选择已有平台成员', 'platform-one')
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/member-projections') ? pending.promise : server(path, init))
    await click('建立目录表示')
    const count = mocks.fetch.mock.calls.length
    mocks.session = 'session-b'; for (const listener of mocks.listeners) listener()
    await flush()
    expect(container.querySelector('#projection-heading')).toBeNull()
    pending.resolve(response({ projection: { accountId: a, created: true } })); await flush()
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
    expect(container.textContent).not.toContain('目录表示已确认')
    expect(container.textContent).not.toContain('王文')
  })
  it('handles late candidate JSON after a newer workspace and unmount', async () => {
    const json = deferred<unknown>()
    let pending = true
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => pending && path.includes('/member-candidates?')
      ? { ok: true, status: 200, json: () => json.promise } : server(path, init))
    mount(); await flush()
    mocks.session = 'session-b'; for (const listener of mocks.listeners) listener()
    pending = false
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/workspace')
      ? response(workspace(true, otherAnchor)) : server(path, init))
    await click('重新加载组织')
    const count = mocks.fetch.mock.calls.length
    app!.unmount(); app = null
    json.resolve({ ok: true, data: { integrationId: anchor, page: 1, pageSize: 25, total: 3, items: candidates } })
    await flush()
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
    expect(container.textContent).toBe('')
  })
  it('keeps projection empty/read-only/error states usable without fallback account creation', async () => {
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.includes('/member-candidates?')
      ? response({ integrationId: anchor, page: 1, pageSize: 25, total: 0, items: [] }) : server(path, init))
    mount(); await flush()
    expect(container.textContent).toContain('本页没有可表示的活跃平台成员')
    expect(button('建立目录表示').matches(':disabled')).toBe(true)
    mocks.fetch.mockImplementation((path: string, init: RequestInit) => path.endsWith('/workspace') ? response(workspace(false)) : server(path, init))
    await click('重新加载组织')
    expect(control('选择已有平台成员').matches(':disabled')).toBe(true)
    expect(button('建立目录表示').matches(':disabled')).toBe(true)
    expect(writes()).toHaveLength(0)
    expect(mocks.fetch.mock.calls.some(([path]) => path.endsWith('/accounts'))).toBe(false)
  })
})
