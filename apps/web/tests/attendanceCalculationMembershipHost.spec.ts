import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { writeFileSync } from 'node:fs'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'

const shellReady = import('../src/App.vue')
beforeAll(async () => { await shellReady })
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
const gate = ref(true)
const allowed = ref(true)
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    buildAuthHeaders: () => ({ 'x-tenant-id': 'synthetic-history-org' }),
    getCurrentUserId: async () => 'synthetic-history-admin',
    getAccessSnapshot: () => ({ roles: ['admin'], permissions: ['attendance:admin'], isAdmin: true, email: '' }),
    hasPermission: (permission: string) => permission === 'attendance:admin' && allowed.value,
    hasAdminAccess: () => true,
  }),
}))
vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null), fetchPlugins: async () => {},
  }),
}))
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (key: string) => key === 'attendance' || key === 'attendanceAdmin'
      || key === 'attendanceAdminRail'
      || (key === 'attendanceGroupEffectivePolicyPanel' && gate.value),
  }),
}))
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  const router = actual.createRouter({ history: actual.createMemoryHistory(), routes: [] })
  return { ...actual, useRouter: () => router }
})

const orgId = 'synthetic-history-org'
const personId = '55555555-5555-4555-8555-555555555555'
const managementPersonId = '66666666-6666-4666-8666-666666666666'
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const groups = [
  { id: first, orgId, name: 'Synthetic current group', timezone: 'UTC', attendanceType: 'fixed_shift', memberCount: 1 },
  { id: second, orgId, name: 'Synthetic other group', timezone: 'UTC', attendanceType: 'fixed_shift', memberCount: 0 },
]
const intervals = [
  { id: '33333333-3333-4333-8333-333333333333', orgId, userId: personId, groupId: first, effectiveFrom: '2026-10-30', effectiveTo: '2026-10-31', createdAt: '2099-01-01T00:00:00Z' },
  { id: '44444444-4444-4444-8444-444444444444', orgId, userId: personId, groupId: second, effectiveFrom: '2026-11-01', effectiveTo: null, assignedReason: 'SYNTHETIC_PRIVATE_REASON' },
]
const flush = async () => { for (let i = 0; i < 10; i += 1) { await Promise.resolve(); await nextTick() } }
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) }) as Response
function timelineCalls() {
  return vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).startsWith('/api/attendance-admin/calculation-group-memberships'))
}
function writerCalls() {
  return vi.mocked(apiFetch).mock.calls.filter(([path, init]) =>
    init?.method && init.method !== 'GET' && !(String(path) === '/api/attendance-admin/users/batch/resolve' && init.method === 'POST'))
}

describe('W6 calculation membership People host', () => {
  let app: App<Element> | null
  let host: HTMLDivElement
  let originalScroll: typeof HTMLElement.prototype.scrollIntoView
  beforeEach(() => {
    app = null
    host = document.createElement('div')
    document.body.appendChild(host)
    gate.value = true
    allowed.value = true
    window.localStorage.clear()
    useLocale().setLocale('en')
    window.history.replaceState({}, '', '/attendance')
    originalScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const path = String(input)
      if (init?.method && init.method !== 'GET' && !(path === '/api/attendance-admin/users/batch/resolve' && init.method === 'POST')) throw new Error('UNEXPECTED_WRITE')
      if (path.startsWith('/api/attendance/groups?')) return response({ items: groups, total: 2, scope: 'org' })
      if (path === '/api/attendance/groups/' + first) return response(groups[0])
      if (path === '/api/attendance/groups/' + first + '/members') return response({
        items: [{ id: 'synthetic-management-row', userId: managementPersonId, createdAt: '2099-01-01T12:00:00Z' }], total: 1,
      })
      if (path === '/api/attendance-admin/users/batch/resolve') return response({ requested: 1, found: 0, missingUserIds: [managementPersonId], inactiveUserIds: [], items: [] })
      if (path.startsWith('/api/attendance-admin/calculation-group-memberships?')) return response({ items: intervals })
      return response({ items: [], total: 0 })
    })
  })
  afterEach(() => {
    app?.unmount()
    host.remove()
    HTMLElement.prototype.scrollIntoView = originalScroll
    window.history.replaceState({}, '', '/attendance')
    window.localStorage.clear()
  })
  async function click(selector: string) {
    const button = host.querySelector<HTMLButtonElement>(selector)
    expect(button, selector).toBeTruthy()
    button!.click()
    await flush()
  }
  async function mountPeople() {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-groups' })
    app.mount(host)
    await flush()
    await click('[data-attendance-group-row] .attendance__group-list-main')
    await click('[data-attendance-group-workflow-step="people"]')
    expect(host.querySelector('[data-attendance-group-people]')).toBeTruthy()
  }

  it('renders recorded inclusive calculation dates separately from management Joined', async () => {
    await mountPeople()
    expect(host.querySelector('[data-attendance-calculation-history]')).toBeTruthy()
    expect(timelineCalls()).toHaveLength(0)
    const input = host.querySelector<HTMLInputElement>('[data-attendance-calculation-person-id]')!
    input.value = personId
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    await click('[data-attendance-calculation-view]')
    const params = new URL(String(timelineCalls()[0]![0]), 'https://synthetic.invalid').searchParams
    expect([...params.entries()]).toEqual([['orgId', orgId], ['userId', personId]])
    expect(host.querySelector('[data-attendance-calculation-person-label]')?.textContent).toBe('Unknown member')
    expect([...host.querySelectorAll('[data-attendance-calculation-from]')].map(el => el.textContent)).toEqual(['2026-10-30', '2026-11-01'])
    expect([...host.querySelectorAll('[data-attendance-calculation-through]')].map(el => el.textContent)).toEqual(['2026-10-31', 'No recorded end'])
    expect([...host.querySelectorAll('[data-attendance-calculation-group-name]')].map(el => el.textContent)).toEqual(groups.map(group => group.name))
    expect(host.querySelector('[data-attendance-calculation-history]')?.textContent).not.toContain('2099')
    expect(host.querySelector('[data-attendance-calculation-history]')?.textContent).not.toContain('SYNTHETIC_PRIVATE_REASON')
    expect(writerCalls()).toEqual([])
  })

  it('preserves management list and Joined as an original positive control', async () => {
    await mountPeople()
    const people = host.querySelector('[data-attendance-group-people]')!
    expect(people.querySelector('thead')?.textContent).toContain('Joined')
    expect(people.querySelector('tbody')?.textContent).toContain('2099')
    expect(people.querySelector('[data-attendance-group-member-user-id]')?.textContent).toBe(managementPersonId)
    expect(timelineCalls()).toHaveLength(0)
    expect(writerCalls()).toEqual([])
  })

  it('keeps original OFF People DOM and zero timeline reads', async () => {
    gate.value = false
    await mountPeople()
    expect(host.querySelector('[data-attendance-calculation-history]')).toBeNull()
    expect(timelineCalls()).toHaveLength(0)
    expect(writerCalls()).toEqual([])
    const capture = process.env.W6_MEMBERSHIP_PEOPLE_CAPTURE
    if (capture) writeFileSync(capture, JSON.stringify({
      rawPeople: host.querySelector('[data-attendance-group-people]')!.outerHTML,
      API: vi.mocked(apiFetch).mock.calls.map(([path, init]) => ({ path: String(path), method: init?.method ?? 'GET', body: init?.body ?? null })),
    }, null, 2) + '\n')
  })
})
