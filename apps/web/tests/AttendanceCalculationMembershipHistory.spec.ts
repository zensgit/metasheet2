import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref, type App } from 'vue'
import History from '../src/views/attendance/AttendanceCalculationMembershipHistory.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
const ORG = 'org-a'
const USER = 'person-a'
const GROUP = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ID = '33333333-3333-4333-8333-333333333333'
const ID2 = '44444444-4444-4444-8444-444444444444'
const record = (overrides: Record<string, unknown> = {}) => ({
  id: ID, orgId: ORG, userId: USER, groupId: GROUP,
  effectiveFrom: '2026-10-31', effectiveTo: '2026-10-31', ...overrides,
})
const body = (items: unknown) => ({ ok: true, data: { items } })
const response = (payload: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300, status, json: async () => payload,
}) as Response
const flush = async () => { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() } }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('calculation membership read-only history', () => {
  let app: App<Element> | null
  let host: HTMLDivElement
  let state: { enabled: boolean; active: boolean; orgId: string; groupId: string; groups: { id: string; orgId?: string; name: string }[] }
  let allowed: ReturnType<typeof ref<boolean>>
  let principal: ReturnType<typeof ref<string>>
  let session: ReturnType<typeof createAttendanceSessionGuard>
  beforeEach(() => {
    app = null
    host = document.createElement('div')
    document.body.appendChild(host)
    useLocale().setLocale('en')
    allowed = ref(true)
    principal = ref('synthetic-identity-a')
    session = createAttendanceSessionGuard(ORG, () => principal.value)
    state = reactive({
      enabled: true, active: true, orgId: ORG, groupId: GROUP,
      groups: [{ id: GROUP, orgId: ORG, name: 'Synthetic group A' }, { id: OTHER, orgId: ORG, name: 'Synthetic group B' }],
    })
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValue(response(body([record()])))
  })
  afterEach(() => { app?.unmount(); host.remove(); vi.restoreAllMocks() })
  async function mount() {
    app = createApp({ render: () => h(History, { ...state, canRead: () => allowed.value }) })
    app.provide(attendanceSessionGuardKey, session)
    app.mount(host)
    await flush()
  }
  async function input(selector: string, value: string) {
    const el = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
    expect(el, selector).toBeTruthy()
    el!.value = value
    el!.dispatchEvent(new Event(el!.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await flush()
  }
  async function click(selector: string) {
    const el = host.querySelector<HTMLButtonElement>(selector)
    expect(el, selector).toBeTruthy()
    expect(el!.disabled).toBe(false)
    el!.click()
    await flush()
  }
  const select = (id = USER) => input('[data-attendance-calculation-person-id]', id)
  const view = () => click('[data-attendance-calculation-view]')
  const intervalRows = () => host.querySelectorAll('[data-attendance-calculation-interval]')
  const viewButton = () => host.querySelector<HTMLButtonElement>('[data-attendance-calculation-view]')!

  it('requires explicit reads with exact org/user query and no write or group filter', async () => {
    await mount()
    expect(apiFetch).not.toHaveBeenCalled()
    await select()
    expect(apiFetch).not.toHaveBeenCalled()
    await view()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-admin/calculation-group-memberships?orgId=org-a&userId=person-a', {
      signal: expect.any(AbortSignal), suppressUnauthorizedRedirect: true,
    })
    expect(intervalRows()).toHaveLength(1)
    expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('shows the entire inclusive timeline and no end without inferring activity or Joined dates', async () => {
    vi.mocked(apiFetch).mockResolvedValue(response(body([
      record({ createdAt: '2099-12-31', assignedReason: 'SYNTHETIC_PRIVATE_REASON' }),
      record({ id: ID2, groupId: OTHER, effectiveFrom: '2026-11-01', effectiveTo: null, active: true }),
    ])))
    await mount(); await select(); await view()
    expect([...host.querySelectorAll('[data-attendance-calculation-from]')].map(el => el.textContent)).toEqual(['2026-10-31', '2026-11-01'])
    expect([...host.querySelectorAll('[data-attendance-calculation-through]')].map(el => el.textContent)).toEqual(['2026-10-31', 'No recorded end'])
    expect([...host.querySelectorAll('[data-attendance-calculation-group-name]')].map(el => el.textContent)).toEqual(['Synthetic group A', 'Synthetic group B'])
    expect(host.textContent).toContain('both dates inclusive')
    expect(host.textContent).not.toContain('2099')
    expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_REASON')
    expect(host.querySelector('[data-attendance-calculation-active]')).toBeNull()
  })

  it('does not treat an empty recorded timeline as organization inheritance', async () => {
    vi.mocked(apiFetch).mockResolvedValue(response(body([])))
    await mount(); await select(); await view()
    expect(intervalRows()).toHaveLength(0)
    expect(host.querySelector('[data-attendance-calculation-empty]')?.textContent).toContain('does not imply an organization default')
    expect(host.querySelector('[data-attendance-calculation-error]')).toBeNull()
  })

  it.each([401, 403, 404, 409, 500, 503])('shows fixed unavailable/denied state for HTTP%s without raw server values', async status => {
    vi.mocked(apiFetch).mockResolvedValue(response({ ok: false, error: { message: 'SYNTHETIC_PRIVATE_DRIVER', details: 'SYNTHETIC_PRIVATE_PERSON' } }, status))
    await mount(); await select(); await view()
    expect(host.querySelector('[data-attendance-calculation-error]')?.textContent).toBe(status === 401 || status === 403
      ? 'Administrator access required for this organization.'
      : 'Recorded calculation-group history unavailable.')
    expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_')
    expect(host.querySelector('[data-attendance-calculation-empty]')).toBeNull()
    expect(intervalRows()).toHaveLength(0)
  })

  it.each([
    body([record(), record({ id: ID2, orgId: 'foreign-org', effectiveFrom: '2026-11-01', effectiveTo: null })]),
    body([record({ userId: 'foreign-person' })]),
    body([record({ effectiveFrom: '2026-02-30' })]),
    body([record({ effectiveTo: null }), record({ id: ID2, effectiveFrom: '2026-11-01', effectiveTo: null })]),
    { ok: false, data: { items: [] }, error: { message: 'SYNTHETIC_PRIVATE_ERROR' } },
  ])('refuses the whole malformed or cross-scope response rather than filtering it: %j', async payload => {
    vi.mocked(apiFetch).mockResolvedValue(response(payload))
    await mount(); await select(); await view()
    expect(intervalRows()).toHaveLength(0)
    expect(host.querySelector('[data-attendance-calculation-error]')?.textContent).toBe('Recorded calculation-group history unavailable.')
    expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_')
  })

  it('neutralizes missing group names and never takes a name from a foreign org catalog', async () => {
    state.groups = [{ id: GROUP, orgId: 'foreign-org', name: 'SYNTHETIC_PRIVATE_GROUP' }]
    await mount(); await select(); await view()
    expect(host.querySelector('[data-attendance-calculation-group-name]')?.textContent).toBe('Unavailable group')
    expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_GROUP')
    expect(host.querySelector('[data-attendance-calculation-interval] details code')?.textContent).toBe(GROUP)
  })

  it('searches explicitly within the org, never globally, with neutral and genuine labels', async () => {
    const users = [
      { id: USER, name: 'Synthetic person', email: null },
      { id: 'missing-person', name: null, email: 'missing-person' },
      { id: 'genuine-name-is-ID', name: 'genuine-name-is-ID', email: null },
      { id: 'email-person', name: null, email: 'synthetic@example.invalid' },
    ]
    vi.mocked(apiFetch).mockResolvedValue(response(body(users)))
    await mount()
    await input('#attendance-calculation-person-search', 'person & name')
    expect(apiFetch).not.toHaveBeenCalled()
    await click('[data-attendance-calculation-search]')
    const [path, init] = vi.mocked(apiFetch).mock.calls[0]!
    const u = new URL(String(path), 'https://synthetic.invalid')
    expect(u.pathname).toBe('/api/attendance-admin/users/search')
    expect([...u.searchParams.entries()]).toEqual([['orgId', ORG], ['q', 'person & name']])
    expect(init?.method).toBeUndefined()
    expect([...host.querySelectorAll('[data-attendance-calculation-person] option')].slice(1).map(el => el.textContent)).toEqual([
      'Synthetic person', 'Unknown member', 'genuine-name-is-ID', 'synthetic@example.invalid',
    ])
    await input('[data-attendance-calculation-person]', 'missing-person')
    expect(host.querySelector('[data-attendance-calculation-person-label]')?.textContent).toBe('Unknown member')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    response({ ok: false, error: { message: 'SYNTHETIC_PRIVATE_SEARCH' } }, 403),
    response({ ok: false, error: { message: 'SYNTHETIC_PRIVATE_SEARCH' } }),
    response(body([{ id: USER, name: { secret: 'SYNTHETIC_PRIVATE_SEARCH' } }])),
  ])('never shows raw search errors or malformed labels', async reply => {
    vi.mocked(apiFetch).mockResolvedValue(reply)
    await mount()
    await input('#attendance-calculation-person-search', 'person')
    await click('[data-attendance-calculation-search]')
    expect(host.querySelector('[data-attendance-calculation-search-error]')?.textContent).toBe('Organization person search unavailable.')
    expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_')
    expect(host.querySelectorAll('[data-attendance-calculation-person] option')).toHaveLength(1)
  })

  it.each(['group', 'org', 'stage', 'flag', 'permission', 'session'] as const)('clears loaded data and makes no automatic read on %s change', async kind => {
    await mount(); await select(); await view()
    expect(intervalRows()).toHaveLength(1)
    if (kind === 'group') state.groupId = OTHER
    if (kind === 'org') state.orgId = 'org-b'
    if (kind === 'stage') state.active = false
    if (kind === 'flag') state.enabled = false
    if (kind === 'permission') allowed.value = false
    if (kind === 'session') session.invalidate()
    await flush()
    expect(intervalRows()).toHaveLength(0)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    if (kind === 'group' || kind === 'org') expect(viewButton().disabled).toBe(true)
    else expect(host.querySelector('[data-attendance-calculation-history]')).toBeNull()
  })

  it('rejects an earlier A header result after person A-B-A and leaves the new load busy', async () => {
    const old = deferred<Response>(); const fresh = deferred<Response>()
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    await mount(); await select(); await view()
    await select('person-b'); await select(USER); await view()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    old.resolve(response(body([record({ effectiveFrom: '2025-01-01', effectiveTo: null })])))
    await flush()
    expect(intervalRows()).toHaveLength(0)
    expect(viewButton().disabled).toBe(true)
    expect(viewButton().textContent).toBe('Loading...')
    fresh.resolve(response(body([record()])))
    await flush()
    expect([...host.querySelectorAll('[data-attendance-calculation-from]')].map(el => el.textContent)).toEqual(['2026-10-31'])
    expect(viewButton().disabled).toBe(false)
  })

  it('rejects an earlier JSON result after person A-B-A without overwriting the newer record', async () => {
    const oldJSON = deferred<unknown>()
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => oldJSON.promise } as Response)
      .mockResolvedValueOnce(response(body([record({ effectiveFrom: '2027-01-01', effectiveTo: null })])))
    await mount(); await select(); await view()
    await select('person-b'); await select(USER); await view()
    expect(host.querySelector('[data-attendance-calculation-from]')?.textContent).toBe('2027-01-01')
    oldJSON.resolve(body([record()]))
    await flush()
    expect(host.querySelector('[data-attendance-calculation-from]')?.textContent).toBe('2027-01-01')
    expect(host.querySelector('[data-attendance-calculation-error]')).toBeNull()
  })

  it.each(['network', 'json'] as const)('does not apply stale %s rejection/catch/finally to a newer load', async kind => {
    const old = deferred<Response>(); const oldJSON = deferred<unknown>(); const fresh = deferred<Response>()
    if (kind === 'network') vi.mocked(apiFetch).mockReturnValueOnce(old.promise)
    else vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => oldJSON.promise } as Response)
    vi.mocked(apiFetch).mockReturnValueOnce(fresh.promise)
    await mount(); await select(); await view()
    await select('person-b'); await view()
    if (kind === 'network') old.reject(new Error('SYNTHETIC_PRIVATE_STALE_ERROR'))
    else oldJSON.reject(new Error('SYNTHETIC_PRIVATE_STALE_ERROR'))
    await flush()
    expect(host.querySelector('[data-attendance-calculation-error]')).toBeNull()
    expect(viewButton().disabled).toBe(true)
    expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_')
    fresh.resolve(response(body([record({ userId: 'person-b' })])))
    await flush()
    expect(intervalRows()).toHaveLength(1)
    expect(viewButton().disabled).toBe(false)
  })

  it.each(['group', 'org', 'stage', 'flag', 'permission'] as const)('rejects in-flight data after %s A-B-A, with no replay', async kind => {
    const old = deferred<Response>()
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise)
    await mount(); await select(); await view()
    if (kind === 'group') state.groupId = OTHER
    if (kind === 'org') state.orgId = 'org-b'
    if (kind === 'stage') state.active = false
    if (kind === 'flag') state.enabled = false
    if (kind === 'permission') allowed.value = false
    await flush()
    state.groupId = GROUP; state.orgId = ORG; state.active = true; state.enabled = true; allowed.value = true
    await flush()
    old.resolve(response(body([record()])))
    await flush()
    expect(intervalRows()).toHaveLength(0)
    expect(viewButton().disabled).toBe(true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('does not issue a new request when the captured session identity changes', async () => {
    await mount(); await select()
    principal.value = 'synthetic-identity-b'
    await view()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(host.querySelector('[data-attendance-calculation-history]')).toBeNull()
  })

  it('discards responses after unmount', async () => {
    const old = deferred<Response>()
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise)
    await mount(); await select(); await view()
    app!.unmount(); app = null
    old.resolve(response(body([record()])))
    await flush()
    expect(host.innerHTML).toBe('')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('discards an old organization search response after an org A-B-A round trip', async () => {
    const old = deferred<Response>()
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise)
    await mount()
    await input('#attendance-calculation-person-search', 'old person')
    await click('[data-attendance-calculation-search]')
    state.orgId = 'org-b'; await flush(); state.orgId = ORG; await flush()
    old.resolve(response(body([{ id: USER, name: 'SYNTHETIC_STALE_NAME', email: null }])))
    await flush()
    expect(host.textContent).not.toContain('SYNTHETIC_STALE_NAME')
    expect(host.querySelectorAll('[data-attendance-calculation-person] option')).toHaveLength(1)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects old search JSON after a newer explicit query has completed', async () => {
    const old = deferred<unknown>()
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => old.promise } as Response)
      .mockResolvedValueOnce(response(body([{ id: 'new-person', name: 'Synthetic new search result', email: null }])))
    await mount()
    await input('#attendance-calculation-person-search', 'old')
    await click('[data-attendance-calculation-search]')
    await input('#attendance-calculation-person-search', 'new')
    await click('[data-attendance-calculation-search]')
    expect(host.textContent).toContain('Synthetic new search result')
    old.resolve(body([{ id: 'old-person', name: 'SYNTHETIC_STALE_JSON_NAME', email: null }]))
    await flush()
    expect(host.textContent).toContain('Synthetic new search result')
    expect(host.textContent).not.toContain('SYNTHETIC_STALE_JSON_NAME')
    expect(host.querySelector('[data-attendance-calculation-search-error]')).toBeNull()
  })
})
