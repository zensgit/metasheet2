import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import History from '../src/views/attendance/AttendanceCalculationMembershipHistory.vue'
import Workspace from '../src/views/attendance/AttendanceCalculationMembershipWorkspace'
import { useAuth } from '../src/composables/useAuth'
import { useLocale } from '../src/composables/useLocale'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

const ORG = 'transport-org'
const USER = 'transport-person'
const GROUP = '11111111-1111-4111-8111-111111111111'
const record = {
  id: '22222222-2222-4222-8222-222222222222', orgId: ORG, userId: USER, groupId: GROUP,
  effectiveFrom: '2026-11-01', effectiveTo: null,
}
const flush = async () => { for (let i = 0; i < 12; i += 1) { await Promise.resolve(); await nextTick() } }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function reply(status = 200, payload: unknown = { ok: true, data: { items: [record] } }): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, clone: () => reply(status, payload) } as Response
}
const token = (sub: string) => 'header.' + btoa(JSON.stringify({ sub })) + '.synthetic'

describe('calculation membership actual API transport and capability boundary', () => {
  let app: App<Element> | null
  let host: HTMLDivElement
  let state: { enabled: boolean; active: boolean; orgId: string; groupId: string; groups: { id: string; orgId: string; name: string }[] }
  let fetchMock: ReturnType<typeof vi.fn>
  let auth: ReturnType<typeof useAuth>
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('auth_token', token('synthetic-admin-a'))
    localStorage.setItem('tenantId', ORG)
    localStorage.setItem('user_permissions', JSON.stringify(['attendance:admin']))
    useLocale().setLocale('en')
    auth = useAuth()
    app = null
    host = document.createElement('div')
    document.body.appendChild(host)
    state = reactive({
      enabled: true, active: true, orgId: ORG, groupId: GROUP,
      groups: [{ id: GROUP, orgId: ORG, name: 'Synthetic transport group' }],
    })
    fetchMock = vi.fn().mockResolvedValue(reply())
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(async () => {
    app?.unmount()
    host.remove()
    await vi.advanceTimersByTimeAsync(6000)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    localStorage.clear()
    sessionStorage.clear()
  })
  async function mount(workspace = false) {
    const canRead = () => auth.hasPermission('attendance:admin') === true
    expect(canRead()).toBe(true)
    app = createApp({
      render: () => workspace
        ? h(Workspace, { ...state, canRead }, { legacy: () => h('section', { 'data-legacy-people': '' }, 'Synthetic management members') })
        : h(History, { ...state, canRead }),
    })
    app.provide(attendanceSessionGuardKey, createAttendanceSessionGuard(ORG))
    app.mount(host)
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  }
  async function activate(kind: 'history' | 'search') {
    const input = host.querySelector<HTMLInputElement>(kind === 'history'
      ? '[data-attendance-calculation-person-id]' : '#attendance-calculation-person-search')!
    expect(input).toBeTruthy()
    input.value = kind === 'history' ? USER : 'synthetic'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    const button = host.querySelector<HTMLButtonElement>(kind === 'history'
      ? '[data-attendance-calculation-view]' : '[data-attendance-calculation-search]')!
    expect(button.disabled).toBe(false)
    button.click()
    await flush()
  }

  it('successful actual apiFetch still sends one scoped GET and renders the recorded dates', async () => {
    await mount(); await activate('history')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/attendance-admin/calculation-group-memberships')
    expect([...parsed.searchParams.entries()]).toEqual([['orgId', ORG], ['userId', USER]])
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('x-tenant-id')).toBe(ORG)
    expect(host.querySelector('[data-attendance-calculation-from]')?.textContent).toBe('2026-11-01')
  })

  it.each(['history', 'search'] as const)('keeps new-session authentication after the old %s GET returns 401', async kind => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    await mount(); await activate(kind)
    const next = token('synthetic-admin-b')
    localStorage.setItem('auth_token', next)
    pending.resolve(reply(401, { ok: false, error: { message: 'SYNTHETIC_PRIVATE_OLD_SESSION' } }))
    await flush()
    expect(localStorage.getItem('auth_token')).toBe(next)
    expect(localStorage.getItem('user_permissions')).toBe(JSON.stringify(['attendance:admin']))
    expect(host.querySelectorAll('[data-attendance-calculation-interval]')).toHaveLength(0)
  })

  it('does not hand scoped 403 password-change JSON to the global auth redirect before its own guard', async () => {
    const clone = vi.fn(() => reply(403, { error: { code: 'PASSWORD_CHANGE_REQUIRED' } }))
    fetchMock.mockResolvedValueOnce({ ...reply(403), clone })
    await mount(); await activate('history')
    expect(clone).not.toHaveBeenCalled()
    expect(host.querySelector('[data-attendance-calculation-error]')?.textContent).toBe('Administrator access required for this organization.')
  })

  it.each(['history', 'search'] as const)('prevents actual transport retry of a %s GET after leaving People', async kind => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await mount(); await activate(kind)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    state.active = false
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-attendance-calculation-history]')).toBeNull()
  })

  it('invalidates same-session permission-storage A-B-A before an older response can enter the new view', async () => {
    const old = deferred<Response>()
    fetchMock.mockReturnValueOnce(old.promise)
    await mount(true); await activate('history')
    localStorage.setItem('user_permissions', '[]')
    window.dispatchEvent(new StorageEvent('storage', { key: 'user_permissions', oldValue: '["attendance:admin"]', newValue: '[]' }))
    localStorage.setItem('user_permissions', JSON.stringify(['attendance:admin']))
    window.dispatchEvent(new StorageEvent('storage', { key: 'user_permissions', oldValue: '[]', newValue: '["attendance:admin"]' }))
    expect(auth.hasPermission('attendance:admin')).toBe(true)
    await flush()
    old.resolve(reply())
    await flush()
    expect(host.querySelector('[data-legacy-people]')?.textContent).toBe('Synthetic management members')
    expect(host.querySelectorAll('[data-attendance-calculation-interval]')).toHaveLength(0)
    expect(host.querySelector<HTMLButtonElement>('[data-attendance-calculation-view]')?.disabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns exactly the original legacy element while OFF, without Fragment or comment siblings', async () => {
    state.enabled = false
    await mount(true)
    expect(host.innerHTML).toBe('<section data-legacy-people="">Synthetic management members</section>')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns exactly the original legacy element after admin capability is denied', async () => {
    await mount(true)
    localStorage.setItem('user_permissions', '[]')
    window.dispatchEvent(new StorageEvent('storage', { key: 'user_permissions', oldValue: '["attendance:admin"]', newValue: '[]' }))
    await flush()
    expect(auth.hasPermission('attendance:admin')).toBe(false)
    expect(host.innerHTML).toBe('<section data-legacy-people="">Synthetic management members</section>')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps an authorized recorded timeline for unrelated storage notifications', async () => {
    await mount(true); await activate('history')
    expect(host.querySelectorAll('[data-attendance-calculation-interval]')).toHaveLength(1)
    window.dispatchEvent(new StorageEvent('storage', { key: 'synthetic-palette', oldValue: 'a', newValue: 'b' }))
    await flush()
    expect(host.querySelectorAll('[data-attendance-calculation-interval]')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
