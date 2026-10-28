import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import type { App } from 'vue'
import UserApprovalRelations from '../src/components/UserApprovalRelations.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const state = vi.hoisted(() => ({ admin: true, fetch: vi.fn() }))
vi.mock('../src/composables/useAuth', () => ({ useAuth: () => ({ hasAdminAccess: () => state.admin }) }))
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => state.fetch(...args) }))

function data(userId = 'person-a') {
  return { userId, source: { mode: 'policy', provider: 'local' }, primaryDepartment: '演示部门',
    manager: { id: 'manager-a', name: '主管甲' }, departmentHead: { id: 'head-a', name: '负责人乙' } }
}
function response(value = data(), status = 200) {
  return { ok: status === 200, status, json: async () => ({ ok: status === 200, data: value }) }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
let app: App | null
let host: HTMLDivElement
const target = ref('person-a')
function mount() {
  host = document.createElement('div'); document.body.appendChild(host)
  app = createApp({ render: () => h(UserApprovalRelations, { userId: target.value }) }); app.mount(host)
}
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('auth_token', 'session-a')
  state.admin = true; state.fetch.mockReset(); state.fetch.mockResolvedValue(response()); target.value = 'person-a'; app = null
})
afterEach(() => { app?.unmount(); host?.remove(); localStorage.clear() })

describe('user approval relationship summary', () => {
  it('shows independent local manager/head and a maintenance link using GET only', async () => {
    mount(); await flush()
    expect(host.textContent).toContain('本地组织')
    expect(host.textContent).toContain('直属上级（部门级主管）：主管甲')
    expect(host.textContent).toContain('部门主管：负责人乙')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/admin/organization')
    expect(state.fetch.mock.calls).toEqual([['/api/admin/users/person-a/approval-relations', { method: 'GET', suppressUnauthorizedRedirect: true }]])
  })
  it('shows DingTalk source without claiming local maintenance changes that source', async () => {
    const value = data(); value.source.provider = 'dingtalk'; state.fetch.mockResolvedValue(response(value))
    mount(); await flush(); expect(host.textContent).toContain('钉钉目录')
    expect(host.textContent).toContain('不是某张流程的最终审批人预览')
  })
  it('labels legacy source selection as implicit and changeable', async () => {
    const value = data(); value.source.mode = 'legacy-default'; state.fetch.mockResolvedValue(response(value))
    mount(); await flush(); expect(host.textContent).toContain('资料更新或同步可能改变来源')
  })
  it('renders unresolved relations as missing, without inferring from position', async () => {
    state.fetch.mockResolvedValue(response({ ...data(), source: { mode: 'unresolved', provider: null }, primaryDepartment: null, manager: null, departmentHead: null } as unknown as ReturnType<typeof data>))
    mount(); await flush(); expect(host.textContent).toContain('尚未解析'); expect(host.textContent).toContain('对应审批节点可能无法找到审批人')
    expect(host.textContent).not.toContain('主管甲')
  })
  it.each([401, 403])('clears private data and maintenance access on %s', async status => {
    mount(); await flush(); state.fetch.mockResolvedValue(response(data(), status))
    host.querySelector('button')!.click(); await flush()
    expect(host.textContent).not.toContain('主管甲'); expect(host.textContent).toContain('无权查看审批关系')
    expect(host.querySelector('a')).toBeNull()
  })
  it('distinguishes server failure from unconfigured relationships', async () => {
    state.fetch.mockResolvedValue(response(data(), 500)); mount(); await flush()
    expect(host.textContent).toContain('不能据此判断为未配置'); expect(host.textContent).not.toContain('主部门：尚未配置')
  })
  it('rejects a response for a different subject', async () => {
    state.fetch.mockResolvedValue(response(data('foreign'))); mount(); await flush()
    expect(host.textContent).not.toContain('主管甲'); expect(host.textContent).toContain('暂不可用')
  })
  it('rejects unknown source enums', async () => {
    const value = data(); value.source.mode = 'guess'; state.fetch.mockResolvedValue(response(value))
    mount(); await flush(); expect(host.textContent).not.toContain('主管甲')
    expect(host.textContent).toContain('暂不可用')
  })
  it('refuses a late old subject response after user selection changes', async () => {
    const old = deferred<ReturnType<typeof response>>(); state.fetch.mockReturnValueOnce(old.promise)
    mount(); target.value = 'person-b'; state.fetch.mockResolvedValue(response({ ...data('person-b'), manager: { id: 'm-b', name: '主管丙' } })); await flush()
    old.resolve(response()); await flush()
    expect(host.textContent).toContain('主管丙'); expect(host.textContent).not.toContain('主管甲')
  })
  it('invalidates visible and pending data on principal change', async () => {
    const pending = deferred<ReturnType<typeof response>>(); state.fetch.mockReturnValue(pending.promise)
    mount(); notifyAuthPrincipalChange(); pending.resolve(response()); await flush()
    expect(host.textContent).not.toContain('主管甲'); expect(host.textContent).toContain('会话或组织已变化')
    expect(host.querySelector('a')).toBeNull()
  })
  it('invalidates on cross-tab token change', async () => {
    mount(); await flush(); window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' })); await flush()
    expect(host.textContent).not.toContain('主管甲'); expect(host.querySelector('a')).toBeNull()
  })
  it('does not render a late response after unmount', async () => {
    const pending = deferred<ReturnType<typeof response>>(); state.fetch.mockReturnValue(pending.promise)
    mount(); app!.unmount(); app = null; pending.resolve(response()); await flush(); expect(host.textContent).toBe('')
  })
  it('makes no request without a saved subject or admin access', async () => {
    target.value = ''; mount(); await flush(); expect(state.fetch).not.toHaveBeenCalled()
    state.admin = false; target.value = 'person-a'; await flush(); expect(state.fetch).not.toHaveBeenCalled()
  })
  it('clears previous successful data while refreshing', async () => {
    mount(); await flush(); state.fetch.mockReturnValue(new Promise(() => {})); host.querySelector('button')!.click(); await flush()
    expect(host.textContent).toContain('正在读取'); expect(host.textContent).not.toContain('主管甲')
  })
  it('escapes display names as text', async () => {
    const value = data(); value.manager.name = '<img src=x onerror=alert(1)>'; state.fetch.mockResolvedValue(response(value))
    mount(); await flush(); expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('<img src=x onerror=alert(1)>')
  })
  it('distinguishes a fixed policy conflict from a transient outage without echoing detail', async () => {
    state.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'APPROVAL_RELATIONS_UNRESOLVED', message: 'private-detail' } }) })
    mount(); await flush()
    expect(host.textContent).toContain('审批来源需要管理员核对')
    expect(host.textContent).not.toContain('暂不可用')
    expect(host.textContent).not.toContain('private-detail')
    expect(host.textContent).not.toContain('主管甲')
  })
  it('keeps unknown409 codes generic rather than trusting provider error text', async () => {
    state.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'OTHER', message: 'private-detail' } }) })
    mount(); await flush(); expect(host.textContent).toContain('暂不可用'); expect(host.textContent).not.toContain('private-detail')
  })

})
