import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, isNavigationFailure, NavigationFailureType, routerKey, type Router } from 'vue-router'
import UserManagementView from '../src/views/UserManagementView.vue'
import { useInviteManualDelivery } from '../src/views/useInviteManualDelivery'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ hasAdminAccess: () => true, getCurrentUser: () => ({ id: 'actor' }) }),
}))

const items = ['pending', 'expired', 'revoked', 'accepted', 'manual_delivery', 'unknown'].map(status => ({
  id: 'invite/' + status, email: status + '@example.test', user_name: 'Test recipient', status,
}))
const credentials = { loginIdentifier: 'actual@example.test', temporaryPassword: 'synthetic-secret' }
const success = () => Response.json({ ok: true, data: credentials })
const root = document.createElement('div')
let app: App | undefined
function button(label: string, scope: ParentNode = root) {
  const match = Array.from(scope.querySelectorAll('button')).find(item => item.textContent?.trim() === label)
  if (!match) throw new Error('Missing button: ' + label)
  return match
}
const panel = () => root.querySelector('[aria-label="手动交付"]')!
async function mount(router?: Router) {
  let release!: (result: Response | PromiseLike<Response>) => void
  const held = new Promise<Response>(resolve => { release = resolve })
  const request = vi.fn((_url: string, _options?: RequestInit) => held)
  const list = vi.fn((): Response | Promise<Response> => Response.json({ ok: true, data: { items } }))
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (url.endsWith('/manual-delivery')) return request(url, options)
    if (url.startsWith('/api/admin/invites?')) return list()
    return Response.json({ ok: true, data: { items: [] } })
  })
  app = createApp(UserManagementView)
  if (router) app.provide(routerKey, router)
  app.component('RouterLink', { template: '<a><slot /></a>' })
  app.mount(root)
  await vi.waitFor(() => expect(root.querySelector('.user-admin__invite-list')).toBeTruthy())
  root.querySelector<HTMLButtonElement>('[data-testid="pending-invites-tab"]')!.click()
  await nextTick()
  button('改为手动交付').click()
  await nextTick()
  return { release, request, list }
}
afterEach(() => { app?.unmount(); app = undefined; vi.clearAllMocks() })

describe('invite manual delivery', () => {
  it('confirms the individual target, posts once and discards credentials on close', async () => {
    const { release, request } = await mount()
    expect(request).not.toHaveBeenCalled()
    expect(panel().textContent).toContain('Test recipient')
    expect(panel().textContent).toContain('pending@example.test')
    expect(panel().textContent).toContain('旧密码将失效')
    button('关闭', panel()).click()
    await nextTick()
    expect(panel()).toBeNull()
    expect(request).not.toHaveBeenCalled()
    button('改为手动交付').click()
    await nextTick()
    const confirm = button('确认手动交付')
    confirm.click()
    confirm.click()
    expect(request.mock.calls).toEqual([['/api/admin/invites/invite%2Fpending/manual-delivery',
      { method: 'POST', body: '{}', cache: 'no-store' }]])
    release(success())
    await vi.waitFor(() => expect(panel().textContent).toContain(credentials.temporaryPassword))
    expect(panel().textContent).toContain(credentials.loginIdentifier)
    button('关闭', panel()).click()
    await nextTick()
    expect(root.textContent).not.toContain(credentials.temporaryPassword)
    button('全部记录').click()
    await nextTick()
    const rows = Array.from(root.querySelectorAll('.user-admin__invite-list article'))
    expect(rows.map(row => row.textContent?.includes('重发邀请'))).toEqual([false, true, true, false, false, false])
    expect(rows[0].textContent).toContain('已手动交付')
    expect(root.textContent).not.toContain(' · manual_delivery · ')
    expect(rows[0].querySelector('a,button')).toBeNull()
  })

  it('keeps the pending receipt visible across attempted close, tab, filter and route changes', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:page', component: { template: '<div />' } }],
    })
    await router.push('/users')
    const { release, request } = await mount(router)
    button('确认手动交付').click()
    button('关闭', panel()).click()
    await nextTick()
    expect(panel()).not.toBeNull()
    const controls = [button('关闭', panel()), button('成员'), button('全部记录'), button('待处理'), button('邀请用户'),
      root.querySelector<HTMLButtonElement>('[data-testid="recycle-bin-tab"]')!]
    for (const control of controls) {
      expect(control.disabled).toBe(true)
      control.click()
    }
    expect(isNavigationFailure(await router.push('/roles'), NavigationFailureType.aborted)).toBe(true)
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    expect(root.querySelector('[data-testid="pending-invites-tab"]')?.getAttribute('aria-selected')).toBe('true')
    expect(panel().textContent).toContain('正在交付')
    release(success())
    await vi.waitFor(() => expect(panel().textContent).toContain(credentials.temporaryPassword))
    expect(request).toHaveBeenCalledTimes(1)
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
    expect(controls.every(control => !control.disabled)).toBe(true)
    expect(await router.push('/roles')).toBeUndefined()
  })

  it.each(['pending', 'displayed'])('clears the actual receipt state on forced unmount (%s)', async phase => {
    let release!: (response: Response) => void
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const onDelivered = vi.fn()
    let delivery!: ReturnType<typeof useInviteManualDelivery>
    app = createApp({ setup() { delivery = useInviteManualDelivery(onDelivered); return () => null } })
    app.mount(root)
    delivery.open({ ...items[0], userName: items[0].user_name })
    const result = delivery.confirm()
    if (phase === 'displayed') {
      release(success())
      await result
      expect(delivery.credentials.value).toEqual(credentials)
    }
    app!.unmount()
    app = undefined
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
    if (phase === 'pending') release(success())
    await result
    expect(delivery.target.value).toBeNull()
    expect(delivery.credentials.value).toBeNull()
    expect(onDelivered).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1)
  })

  it.each([200, 503])('does not let a stale list undo a delivery outcome (%s)', async status => {
    const { release, list } = await mount()
    button('确认手动交付').click()
    let finishRead!: (response: Response) => void
    list.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
    button('刷新邀请记录').click()
    release(status === 200 ? success() : Response.json({}, { status }))
    await vi.waitFor(() => expect(root.textContent).toContain(status === 200 ? credentials.temporaryPassword : '请先刷新邀请记录'))
    finishRead(Response.json({ ok: true, data: { items } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    if (status === 200) {
      button('关闭', panel()).click()
      await nextTick()
      expect(root.textContent).not.toContain('改为手动交付')
    } else {
      expect(button('改为手动交付').disabled).toBe(true)
    }
  })

  it('treats HTTP 409 as ineligible, suppressing another submission even after refresh', async () => {
    const { request, release, list } = await mount()
    button('确认手动交付').click()
    release(Response.json({ ok: false, error: { code: 'INVITE_MANUAL_DELIVERY_CONFLICT', message: credentials.temporaryPassword } }, { status: 409 }))
    await vi.waitFor(() => expect(root.textContent).toContain('此邀请不符合手动交付条件，请勿再次提交'))
    button('刷新邀请记录').click()
    await vi.waitFor(() => expect(button('刷新邀请记录').disabled).toBe(false))
    expect(list).toHaveBeenCalledTimes(2)
    expect(root.textContent).not.toContain('改为手动交付')
    expect(root.textContent).not.toContain('未能确认交付结果')
    expect(root.textContent).not.toContain(credentials.temporaryPassword)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([503, 200, 0])('requires a successful fresh read after an error or incomplete receipt (%s)', async status => {
    const { request, release, list } = await mount()
    button('确认手动交付').click()
    release(status === 0 ? Promise.reject(new TypeError('network')) : Response.json({ ok: true, data: { temporaryPassword: credentials.temporaryPassword },
      error: { message: credentials.temporaryPassword } }, { status }))
    await vi.waitFor(() => expect(root.textContent).toContain('请先刷新邀请记录'))
    expect(root.textContent).not.toContain(credentials.temporaryPassword)
    expect(button('改为手动交付').disabled).toBe(true)
    list.mockReturnValueOnce(Response.json({}, { status: 503 }))
    button('刷新邀请记录').click()
    await vi.waitFor(() => expect(root.textContent).toContain('加载邀请记录失败'))
    expect(button('改为手动交付').disabled).toBe(true)
    button('刷新邀请记录').click()
    await vi.waitFor(() => expect(button('改为手动交付').disabled).toBe(false))
    expect(request).toHaveBeenCalledTimes(1)
  })
})
