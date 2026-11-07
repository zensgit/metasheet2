import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import AttendanceExperienceView from '../src/views/attendance/AttendanceExperienceView.vue'
import AttendanceGroupContextHost from '../src/views/attendance/AttendanceGroupContextHost.vue'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { useLocale } from '../src/composables/useLocale'
import { apiFetch } from '../src/utils/api'

// The entire panel -> authorized host -> Experience -> AdminCenter -> AttendanceView chain is real.
// IO, principal and rollout inputs are mocked; the unrendered workflow designer is isolated.
// The target editor chain above is not stubbed.
vi.mock('../src/views/attendance/AttendanceWorkflowDesigner.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn(), getApiBase: () => '/api' }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    buildAuthHeaders: () => ({ 'x-tenant-id': 'synthetic-org' }),
    getCurrentUserId: async () => 'synthetic-admin',
    getAccessSnapshot: () => ({ roles: ['admin'], permissions: ['attendance:admin'], isAdmin: true, email: '' }),
    hasAdminAccess: () => true,
  }),
}))
vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null),
    fetchPlugins: async () => {},
  }),
}))
const panelEnabled = ref(true)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => feature === 'attendance' || feature === 'attendanceAdmin'
      || (feature === 'attendanceGroupEffectivePolicyPanel' && panelEnabled.value),
    loadProductFeatures: async () => {},
    isFeatureOverrideAllowed: () => false,
    setLocalFeatureOverride: vi.fn(),
  }),
}))

const A = '11111111-2222-4333-8444-555555555555'
const B = '66666666-7777-4888-8999-000000000000'
const RETURN_TO = '/attendance?tab=admin&section=attendance-admin-groups'
const groupA = { id: A, name: 'Authorized A', timezone: 'UTC', attendanceType: 'scheduled_shift', memberCount: 0 }
const groupB = { ...groupA, id: B, name: 'Listed B' }
type Intercept = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: status < 400, data }) } as Response
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function policy(groupId: string) {
  return {
    groupId, groupType: 'scheduled_shift', timezone: 'UTC', activeMemberCount: 0,
    managerPosture: { ownerCount: 0, subOwnerCount: 0 }, calculationPosture: 'legacy',
    domains: { membership: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'people' } } },
    conflicts: [{
      code: 'TIMEZONE_MISSING', domain: 'basics', label: 'conflict_action_required',
      editorRef: { kind: 'group_stage', stage: 'basics' },
    }],
    evaluatedAt: '2026-10-25T00:00:00.000Z',
  }
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
let app: App | null
let router: Router
let currentHost: InstanceType<typeof AttendanceGroupContextHost> | null
let container: HTMLDivElement
let intercept: Intercept
let listed: Array<typeof groupA>
let total: number
let identity: string
let guard: ReturnType<typeof createAttendanceSessionGuard>

async function flush() { await Promise.resolve(); await nextTick() }
function button(selector: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(selector)
  expect(found, selector).toBeTruthy()
  return found!
}
async function click(selector: string) { button(selector).click(); await flush() }
function nameInput() { return container.querySelector<HTMLInputElement>('#attendance-group-name')! }
function activeStage() {
  return container.querySelector('[data-attendance-group-workflow-step][aria-current="step"]')
    ?.getAttribute('data-attendance-group-workflow-step')
}
function selectGroup(id: string) {
  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-attendance-group-row]'))
    .find(item => item.textContent?.includes(id === A ? groupA.name : groupB.name))
  expect(row, `listed group ${id}`).toBeTruthy()
  row!.querySelector<HTMLButtonElement>('.attendance__group-list-main')!.click()
}
async function mount(step: 'schedule' | 'rules' = 'schedule') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/attendance', component: AttendanceExperienceView },
      ...(['schedule', 'calendar', 'rules'] as const).map(step => ({
        path: `/attendance/admin/groups/:groupId/${step}`,
        name: `attendance-admin-group-${step}`,
        component: AttendanceExperienceView,
      })),
    ],
  })
  await router.push(`/attendance/admin/groups/${A}/${step}?returnTo=${encodeURIComponent(RETURN_TO)}`)
  await router.isReady()
  app = createApp(RouterView)
  app.mixin({
    mounted() {
      if (this.$.type === AttendanceGroupContextHost) {
        currentHost = this as unknown as InstanceType<typeof AttendanceGroupContextHost>
      }
    },
  })
  app.provide(attendanceSessionGuardKey, guard)
  app.use(router)
  app.mount(container)
  await flush()
}
async function ready(expected = groupA) {
  await vi.waitFor(() => {
    expect(nameInput()?.value).toBe(expected.name)
    expect(container.querySelector('[data-attendance-group-list]')?.textContent).toContain(groupB.name)
    const reload = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-attendance-group-manager] button'))
      .find(node => node.textContent?.trim() === 'Reload groups')
    expect(reload?.disabled).toBe(false)
  })
}
async function openPolicy() {
  await click('[data-attendance-w6-effective-policy-open]')
  await vi.waitFor(() => expect(container.querySelector('[data-attendance-w6-effective-policy-content]')).toBeTruthy())
}

beforeEach(() => {
  vi.clearAllMocks()
  currentHost = null
  panelEnabled.value = true
  listed = [groupA, groupB]
  total = listed.length
  identity = 'synthetic-session-a'
  guard = createAttendanceSessionGuard('synthetic-org', () => identity)
  intercept = () => undefined
  useLocale().setLocale('en')
  window.localStorage.clear()
  window.history.replaceState({}, '', '/attendance')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('UNEXPECTED_EXTERNAL_FETCH'))))
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const path = String(input)
    const result = intercept(path, init)
    if (result !== undefined) return result
    if (path === `/api/attendance/groups/${A}`) return response(groupA)
    if (path === `/api/attendance/groups/${B}`) return response(groupB)
    if (path.startsWith('/api/attendance/groups?')) return response({ items: listed, total, scope: 'org' })
    if (path.endsWith('/effective-policy')) return response(policy(path.includes(A) ? A : B))
    if (/\/groups\/[^/]+\/(members|managers)$/.test(path)) return response({ items: [], total: 0 })
    if (path === '/api/attendance-admin/users/batch/resolve') {
      const { userIds } = JSON.parse(String(init?.body)) as { userIds: string[] }
      return response({ items: userIds.map(id => ({ id, name: 'Current label', email: '', is_active: true })) })
    }
    return response({ items: [], total: 0, summary: null })
  })
})
afterEach(() => {
  app?.unmount()
  app = null
  container.remove()
  // batch/resolve is an existing read-only POST, never an application write.
  const writes = vi.mocked(apiFetch).mock.calls.filter(([path, init]) =>
    !['GET', 'HEAD'].includes(String(init?.method ?? 'GET').toUpperCase())
    && !(String(path) === '/api/attendance-admin/users/batch/resolve' && init?.method === 'POST'))
  expect(writes).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('W6 real host-to-editor stage navigation', () => {
  it('restores route A from editor B outside the first 200 and preserves edits on repeated actions', async () => {
    listed = [groupB]
    total = 201
    await mount()
    await ready()
    await openPolicy()
    selectGroup(B)
    await vi.waitFor(() => expect(nameInput().value).toBe(groupB.name))
    await click('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    await vi.waitFor(() => {
      expect(nameInput().value).toBe(groupA.name)
      expect(activeStage()).toBe('people')
    })
    nameInput().value = 'Unsaved A'
    nameInput().dispatchEvent(new Event('input', { bubbles: true }))
    await click('[data-attendance-group-workflow-step="policies"]')
    await click('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    await vi.waitFor(() => {
      expect(nameInput().value).toBe('Unsaved A')
      expect(activeStage()).toBe('people')
    })
    await click('[data-attendance-w6-effective-policy-conflict-nav="0"]')
    await vi.waitFor(() => {
      expect(nameInput().value).toBe('Unsaved A')
      expect(activeStage()).toBe('basics')
    })
    expect(router.currentRoute.value.path).toBe(`/attendance/admin/groups/${A}/schedule`)
    expect(router.currentRoute.value.query).toEqual({ returnTo: RETURN_TO })
    expect(window.location.hash).toBe('')
  })


  it.each(['schedule', 'policies'] as const)('replays a same-route %s action into the exact editor without losing edits', async (stage) => {
    intercept = path => path.endsWith('/effective-policy') ? response({ ...policy(A), domains: {
      punchMethod: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage } },
    } }) : undefined
    await mount(stage === 'schedule' ? 'schedule' : 'rules')
    await ready()
    await openPolicy()
    selectGroup(B)
    await vi.waitFor(() => expect(nameInput().value).toBe(groupB.name))
    await click('[data-attendance-w6-effective-policy-domain-nav="punchMethod"]')
    await vi.waitFor(() => {
      expect(nameInput().value).toBe(groupA.name)
      expect(activeStage()).toBe(stage)
    })
    nameInput().value = 'Unsaved same-route A'
    nameInput().dispatchEvent(new Event('input', { bubbles: true }))
    await click('[data-attendance-group-workflow-step="people"]')
    await click('[data-attendance-w6-effective-policy-domain-nav="punchMethod"]')
    await vi.waitFor(() => {
      expect(nameInput().value).toBe('Unsaved same-route A')
      expect(activeStage()).toBe(stage)
    })
  })


  it.each(['schedule', 'policies'] as const)('preserves a same-group draft from a queryless %s entry', async (stage) => {
    intercept = path => path.endsWith('/effective-policy') ? response({ ...policy(A), domains: {
      membership: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'people' } },
      punchMethod: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage } },
    } }) : undefined
    const step = stage === 'schedule' ? 'schedule' : 'rules'
    await mount(step)
    await ready()
    await router.replace(`/attendance/admin/groups/${A}/${step}`)
    await ready()
    await openPolicy()
    await click('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    await vi.waitFor(() => expect(activeStage()).toBe('people'))
    nameInput().value = 'Unsaved queryless A'
    nameInput().dispatchEvent(new Event('input', { bubbles: true }))
    await click('[data-attendance-w6-effective-policy-domain-nav="punchMethod"]')
    await vi.waitFor(() => {
      expect(nameInput().value).toBe('Unsaved queryless A')
      expect(activeStage()).toBe(stage)
    })
    expect(router.currentRoute.value.query).toEqual({})
  })


  it.each(['members', 'managers'] as const)('makes a held %s reload inert after the editor unmounts', async (family) => {
    await mount()
    await ready()
    const selector = family === 'managers' ? '[data-attendance-group-manager-reload]'
      : '[data-attendance-group-people] .attendance__admin-section-header button'
    await vi.waitFor(() => expect(button(selector).disabled).toBe(false))
    const held = button(selector)
    await router.push(`/attendance/admin/groups/${B}/rules`)
    await ready(groupB)
    await new Promise(resolve => setTimeout(resolve, 0))
    const calls = vi.mocked(apiFetch).mock.calls.length
    held.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(calls)
    expect(nameInput().value).toBe(groupB.name)
  })

  it('keeps an explicit people action and unsaved fields when the initial list resolves late', async () => {
    const list = deferred<Response>()
    intercept = path => path.startsWith('/api/attendance/groups?') ? list.promise : undefined
    await mount()
    await vi.waitFor(() => expect(nameInput()?.value).toBe(groupA.name))
    await openPolicy()
    await click('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    await vi.waitFor(() => expect(activeStage()).toBe('people'))
    nameInput().value = 'Unsaved during list load'
    nameInput().dispatchEvent(new Event('input', { bubbles: true }))
    list.resolve(response({ items: [groupB], total: 201, scope: 'org' }))
    await vi.waitFor(() => expect(container.querySelector('[data-attendance-group-list]')?.textContent).toContain(groupB.name))
    expect(nameInput().value).toBe('Unsaved during list load')
    expect(activeStage()).toBe('people')
  })

  it('rejects held panel/list actions after navigation and Back restores only the canonical route step', async () => {
    await mount()
    await ready()
    await openPolicy()
    const oldAction = button('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    const oldList = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-attendance-group-manager] button'))
      .find(node => node.textContent?.trim() === 'Reload groups')!
    await router.push(`/attendance/admin/groups/${B}/rules`)
    await ready(groupB)
    expect(activeStage()).toBe('policies')
    await new Promise(resolve => setTimeout(resolve, 0))
    const calls = vi.mocked(apiFetch).mock.calls.length
    oldAction.click()
    oldList.click()
    await flush()
    expect(nameInput().value).toBe(groupB.name)
    expect(activeStage()).toBe('policies')
    expect(apiFetch).toHaveBeenCalledTimes(calls)
    await router.back()
    await vi.waitFor(() => {
      expect(nameInput()?.value).toBe(groupA.name)
      expect(activeStage()).toBe('schedule')
    })
  })

  it('rejects an old host-context action after route A-B-A and a mismatched group at consumption', async () => {
    await mount()
    await ready()
    const originalSource = currentHost!.$props.context!
    await router.push(`/attendance/admin/groups/${B}/rules`)
    await vi.waitFor(() => expect(nameInput()?.value).toBe(groupB.name))
    await router.push(`/attendance/admin/groups/${A}/schedule`)
    await vi.waitFor(() => expect(nameInput()?.value).toBe(groupA.name))
    expect(currentHost!.$props.context).not.toBe(originalSource)
    // Deliver through the real host's public event boundary, without replacing any editor component.
    currentHost!.$emit('open-group-stage', { groupId: A, stage: 'people' }, originalSource)
    await flush()
    expect(activeStage()).toBe('schedule')
    currentHost!.$emit('open-group-stage', { groupId: B, stage: 'people' }, currentHost!.$props.context!)
    await flush()
    expect(nameInput().value).toBe(groupA.name)
    expect(activeStage()).toBe('schedule')
  })

  it('rejects held actions synchronously when the session identity changes', async () => {
    await mount()
    await ready()
    await openPolicy()
    const oldAction = button('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    identity = 'synthetic-session-b'
    const calls = vi.mocked(apiFetch).mock.calls.length
    oldAction.click()
    await flush()
    expect(activeStage()).toBe('schedule')
    expect(guard.stale.value).toBe(true)
    expect(apiFetch).toHaveBeenCalledTimes(calls)
  })

  it('makes no new request or stage action when the panel gate is OFF', async () => {
    panelEnabled.value = false
    await mount()
    await ready()
    expect(container.querySelector('[data-attendance-w6-effective-policy-panel]')).toBeNull()
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).endsWith('/effective-policy'))).toBe(false)
    expect(activeStage()).toBe('schedule')
    panelEnabled.value = true
    await flush()
    await openPolicy()
    const held = button('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    panelEnabled.value = false
    await flush()
    const calls = vi.mocked(apiFetch).mock.calls.length
    held.click()
    await flush()
    expect(activeStage()).toBe('schedule')
    expect(apiFetch).toHaveBeenCalledTimes(calls)
  })

  it.each(['unknown', 'deleted', 'cross-org', 'denied'] as const)('keeps %s group probes unavailable without a first-row fallback', async reason => {
    intercept = path => path === `/api/attendance/groups/${A}`
      ? response(null, reason === 'denied' ? 403 : 404) : undefined
    await mount()
    await vi.waitFor(() => expect(container.querySelector('[data-attendance-group-context="unavailable"]')).toBeTruthy())
    expect(nameInput()).toBeNull()
    expect(container.querySelector('[data-attendance-w6-effective-policy-panel]')).toBeNull()
    expect(vi.mocked(apiFetch).mock.calls).toEqual([[`/api/attendance/groups/${A}`]])
    expect(container.textContent).toContain('This attendance group is unavailable.')
    expect(container.textContent).not.toContain(groupB.name)
  })

  it('does not trust a successful probe body naming a different group', async () => {
    intercept = path => path === `/api/attendance/groups/${A}` ? response(groupB) : undefined
    await mount()
    await vi.waitFor(() => expect(container.querySelector('[data-attendance-group-context="error"]')).toBeTruthy())
    expect(nameInput()).toBeNull()
    expect(vi.mocked(apiFetch).mock.calls).toEqual([[`/api/attendance/groups/${A}`]])
  })
})
