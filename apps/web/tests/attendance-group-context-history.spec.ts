import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import {
  RouterView,
  createMemoryHistory,
  createWebHistory,
  createRouter,
  type RouteRecordRaw,
} from 'vue-router'
import AttendanceExperienceView from '../src/views/attendance/AttendanceExperienceView.vue'
import { apiFetch } from '../src/utils/api'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => feature === 'attendanceAdmin' || feature === 'attendance',
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
    isFeatureOverrideAllowed: () => false,
    setLocalFeatureOverride: vi.fn(),
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ isZh: ref(false) }),
}))

vi.mock('../src/views/attendance/AttendanceAdminCenter.vue', () => ({
  default: defineComponent({
    props: {
      routeGroupContext: { type: Object, default: null },
      returnGroupContext: { type: Object, default: null },
    },
    emits: ['clear-section', 'open-group-route'],
    template: `
      <div
        :data-history-parent-group="returnGroupContext?.group.id || ''"
        :data-history-parent-stage="returnGroupContext?.stage || ''"
        data-history-admin
        :data-history-group="routeGroupContext?.group.id || ''"
        :data-history-step="routeGroupContext?.step || ''"
        :data-history-surface="routeGroupContext?.surface || ''"
      >
        <button
          data-history-open-assignments
          @click="$emit('open-group-route', {
            groupId: '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f',
            step: 'schedule',
            surface: 'assignments',
          })"
        >Assignments</button>
        <button data-history-management-home @click="$emit('clear-section')">Management home</button>
        <button data-history-open-parent-rules @click="$emit('open-group-route', { groupId: '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f', step: 'rules', surface: 'rule-sets', originStage: 'policies' })">Open rules from B/policies</button>
      </div>
    `,
  }),
}))

vi.mock('../src/views/attendance/AttendanceOverview.vue', () => ({
  default: defineComponent({ template: '<div data-history-overview />' }),
}))
vi.mock('../src/views/attendance/AttendanceReportsView.vue', () => ({
  default: defineComponent({ template: '<div data-history-reports />' }),
}))
vi.mock('../src/views/attendance/AttendanceWorkflowDesigner.vue', () => ({
  default: defineComponent({ template: '<div />' }),
}))

const GROUP_ID = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('attendance group-context R2 history', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement
  const ownedHistories: Array<{ destroy: () => void }> = []

  beforeEach(() => {
    window.history.replaceState(null, '', '/attendance')
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === `/api/attendance/groups/${GROUP_ID}`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            id: GROUP_ID,
            name: 'Authorized Operations',
            timezone: 'Asia/Shanghai',
            attendanceType: 'fixed_shift',
          },
        })
      }
      return jsonResponse(404, { ok: false })
    })
  })

  afterEach(() => {
    app?.unmount()
    app = null
    ownedHistories.splice(0).forEach(history => history.destroy())
    window.history.replaceState(null, '', '/attendance')
    container.remove()
    vi.clearAllMocks()
    localStorage.removeItem('auth_token')
    localStorage.removeItem('tenantId')
  })

  it('uses real router push, Back, and Forward while preserving group, step, and surface', async () => {
    const routes: RouteRecordRaw[] = [
      { path: '/attendance', name: 'attendance', component: AttendanceExperienceView },
      {
        path: '/attendance/admin/groups/:groupId/schedule',
        name: 'attendance-admin-group-schedule',
        component: AttendanceExperienceView,
      },
      {
        path: '/attendance/admin/groups/:groupId/calendar',
        name: 'attendance-admin-group-calendar',
        component: AttendanceExperienceView,
      },
      {
        path: '/attendance/admin/groups/:groupId/rules',
        name: 'attendance-admin-group-rules',
        component: AttendanceExperienceView,
      },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: defineComponent({ template: '<div />' }) },
    ]
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/attendance?tab=admin&section=attendance-admin-groups')
    await router.isReady()
    ownedHistories.push(router.options.history)

    app = createApp({ render: () => h(RouterView) })
    app.use(router)
    app.mount(container)
    await flushUi()

    const pushSpy = vi.spyOn(router, 'push')
    container.querySelector<HTMLButtonElement>('[data-history-open-assignments]')!.click()
    await pushSpy.mock.results[0]?.value
    await flushUi(8)

    const expectedRoute = `/attendance/admin/groups/${GROUP_ID}/schedule`
      + '?surface=assignments&returnTo=%2Fattendance%3Ftab%3Dadmin%26section%3Dattendance-admin-groups'
    expect(pushSpy).toHaveBeenCalledWith(expectedRoute)
    expect(router.currentRoute.value.fullPath).toBe(expectedRoute)
    expect(container.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-step')).toBe('schedule')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-surface')).toBe('assignments')

    const backComplete = new Promise<void>((resolve) => {
      const remove = router.afterEach(() => {
        remove()
        resolve()
      })
    })
    router.back()
    await backComplete
    await flushUi(8)
    expect(router.currentRoute.value.fullPath).toBe('/attendance?tab=admin&section=attendance-admin-groups')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe('')

    const forwardComplete = new Promise<void>((resolve) => {
      const remove = router.afterEach(() => {
        remove()
        resolve()
      })
    })
    router.forward()
    await forwardComplete
    await flushUi(8)
    expect(router.currentRoute.value.fullPath).toBe(expectedRoute)
    expect(container.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-step')).toBe('schedule')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-surface')).toBe('assignments')
  })
  async function mountParentHistory(origin = '/attendance?tab=admin&section=attendance-admin-groups', token = 'parent-return-test-session') {
    localStorage.setItem('auth_token', token)
    localStorage.setItem('tenantId', 'parent-return-test-org')
    const router = createRouter({
      history: createWebHistory(),
      routes: [
        { path: '/attendance', name: 'attendance', component: AttendanceExperienceView },
        { path: '/attendance/admin/groups/:groupId/rules', name: 'attendance-admin-group-rules', component: AttendanceExperienceView },
      ],
    })
    await router.push(origin)
    await router.isReady()
    ownedHistories.push(router.options.history)
    app = createApp({ render: () => h(RouterView) })
    app.use(router)
    app.mount(container)
    await flushUi(10)
    return router
  }

  async function openParentRules(router: ReturnType<typeof createRouter>) {
    const push = vi.spyOn(router, 'push')
    container.querySelector<HTMLButtonElement>('[data-history-open-parent-rules]')!.click()
    expect(push).toHaveBeenCalledTimes(1)
    await push.mock.results[0].value
    push.mockRestore()
    await flushUi(12)
  }

  async function returnParent(router: ReturnType<typeof createRouter>) {
    const push = vi.spyOn(router, 'push')
    const button = container.querySelector<HTMLButtonElement>('[data-attendance-group-return]')
    expect(button).toBeTruthy()
    button!.click()
    expect(push).toHaveBeenCalledTimes(1)
    await push.mock.results[0].value
    push.mockRestore()
    await flushUi(12)
  }

  async function returnedParent(origin?: string) {
    const router = await mountParentHistory(origin)
    await openParentRules(router)
    await navigateHistory(router, 'back')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe(GROUP_ID)
    return router
  }

  async function explicitParentAction(router: ReturnType<typeof createRouter>, selector: string) {
    const replace = vi.spyOn(router, 'replace')
    container.querySelector<HTMLButtonElement>(selector)!.click()
    expect(replace).toHaveBeenCalledTimes(1)
    await replace.mock.results[0].value
    replace.mockRestore()
    await flushUi(12)
  }

  async function navigateHistory(router: ReturnType<typeof createRouter>, direction: 'back' | 'forward') {
    const complete = new Promise<void>((resolve) => {
      const remove = router.afterEach(() => { remove(); resolve() })
    })
    router[direction]()
    await complete
    await flushUi(10)
  }

  it.each(['return', 'back'] as const)('restores B/policies through %s after a fresh probe and preserves Forward', async (action) => {
    const router = await mountParentHistory()
    await openParentRules(router)
    expect(router.currentRoute.value.path).toBe(`/attendance/admin/groups/${GROUP_ID}/rules`)
    expect(container.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    const callsBefore = vi.mocked(apiFetch).mock.calls.length
    if (action === 'return') {
      await returnParent(router)
    } else {
      await navigateHistory(router, 'back')
    }
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-stage')).toBe('policies')
    expect(vi.mocked(apiFetch).mock.calls.slice(callsBefore).map(([url]) => url)).toEqual([`/api/attendance/groups/${GROUP_ID}`])
    if (action === 'back') {
      await navigateHistory(router, 'forward')
      expect(container.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
      expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe(GROUP_ID)
    }
    expect(vi.mocked(apiFetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it.each([403, 404, 500, 200])('does not mount an editor while returning probe is pending or rejected (%s)', async (status) => {
    const router = await mountParentHistory()
    await openParentRules(router)
    let resolveProbe!: (response: Response) => void
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((resolve) => { resolveProbe = resolve }))
    await navigateHistory(router, 'back')
    expect(container.querySelector('[data-attendance-parent-return="loading"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
    resolveProbe(jsonResponse(status, { ok: true, data: { id: 'wrong-group', name: 'Other', timezone: 'UTC' } }))
    await flushUi(10)
    expect(container.querySelector('[data-history-admin]')).toBeNull()
    expect(container.querySelector(`[data-attendance-parent-return="${status === 403 || status === 404 ? 'unavailable' : 'error'}"]`)).toBeTruthy()
  })

  it('ignores a late return probe after leaving the origin entry', async () => {
    const router = await mountParentHistory()
    await openParentRules(router)
    let resolveProbe!: (response: Response) => void
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((resolve) => { resolveProbe = resolve }))
    await navigateHistory(router, 'back')
    await router.push('/attendance?tab=overview')
    resolveProbe(jsonResponse(200, { ok: true, data: { id: GROUP_ID, name: 'Old result', timezone: 'UTC' } }))
    await flushUi(10)
    expect(container.querySelector('[data-history-overview]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
  })

  it('does not reuse return state across a notified principal/session switch', async () => {
    const router = await mountParentHistory()
    await openParentRules(router)
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'other-parent-return-session')
    await navigateHistory(router, 'back')
    expect(container.querySelector('[data-history-admin]')).toBeNull()
    expect(container.querySelector('[data-attendance-parent-return="unavailable"]')).toBeTruthy()
  })

  it('keeps the origin metadata on a direct same-group canonical push', async () => {
    const router = await mountParentHistory()
    await openParentRules(router)
    const intent = window.history.state.attendanceGroupReturn
    await router.push(`/attendance/admin/groups/${GROUP_ID}/rules?returnTo=%2Fattendance%3Ftab%3Dadmin%26section%3Dattendance-admin-groups`)
    await flushUi(12)
    expect(window.history.state.attendanceGroupReturn).toEqual(intent)
    await returnParent(router)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-stage')).toBe('policies')
  })

  it('discards a pending response when tenant scope changes without a principal notification', async () => {
    const router = await mountParentHistory()
    await openParentRules(router)
    let resolveProbe!: (response: Response) => void
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((resolve) => { resolveProbe = resolve }))
    await navigateHistory(router, 'back')
    expect(container.querySelector('[data-history-admin]')).toBeNull()
    localStorage.setItem('tenantId', 'other-return-org')
    resolveProbe(jsonResponse(200, { ok: true, data: { id: GROUP_ID, name: 'Old scope', timezone: 'UTC' } }))
    await flushUi(10)
    expect(container.querySelector('[data-history-admin]')).toBeNull()
  })

  it('preserves unrelated query spelling when restoring the origin', async () => {
    const router = await mountParentHistory('/attendance?tab=admin&section=attendance-admin-groups&filter=hello%20world')
    await openParentRules(router)
    await returnParent(router)
    expect(router.currentRoute.value.query.filter).toBe('hello world')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-stage')).toBe('policies')
  })

  it('attaches small metadata without changing source URL or replacing router state fields', async () => {
    const router = await mountParentHistory()
    const href = window.location.href
    const priorState = { ...window.history.state }
    const push = vi.spyOn(router, 'push').mockResolvedValueOnce(undefined)
    container.querySelector<HTMLButtonElement>('[data-history-open-parent-rules]')!.click()
    await flushUi(4)
    expect(window.location.href).toBe(href)
    expect(window.history.state).toMatchObject(priorState)
    expect(Object.keys(window.history.state.attendanceGroupReturn).sort()).toEqual(['groupId', 'nonce', 'origin', 'stage'])
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe('')
    push.mockRestore()
  })

  it('never overrides a canonical group with mismatched metadata or silently selects a default on Return', async () => {
    const router = await mountParentHistory()
    await openParentRules(router)
    const metadata = window.history.state.attendanceGroupReturn
    window.history.replaceState({
      ...window.history.state,
      attendanceGroupReturn: { ...metadata, groupId: '3f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f' },
    }, '')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe(GROUP_ID)
    await returnParent(router)
    expect(container.querySelector('[data-attendance-parent-return="unavailable"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
  })

  it('uses the authenticated probe to reject a valid-shaped foreign group on origin restore', async () => {
    const router = await mountParentHistory()
    await openParentRules(router)
    const intent = window.history.state.attendanceGroupReturn
    await navigateHistory(router, 'back')
    const foreignId = '3f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'
    window.history.replaceState({ ...window.history.state, attendanceGroupReturn: { ...intent, groupId: foreignId } }, '')
    await router.push({
      path: `/attendance/admin/groups/${GROUP_ID}/rules`,
      query: { surface: 'rule-sets', returnTo: intent.origin },
      state: { attendanceGroupReturn: intent },
    })
    await flushUi(12)
    await navigateHistory(router, 'back')
    expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url === `/api/attendance/groups/${foreignId}`)).toBe(true)
    expect(container.querySelector('[data-attendance-parent-return="unavailable"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
  })

  it.each(['Reports', 'Overview'])('allows intentional %s after a returned group without trapping the new tab', async (label) => {
    const router = await returnedParent()
    const before = vi.mocked(apiFetch).mock.calls.length
    const replace = vi.spyOn(router, 'replace')
    Array.from(container.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab')).find(button => button.textContent?.trim() === label)!.click()
    expect(replace).toHaveBeenCalledTimes(1)
    await replace.mock.results[0].value
    replace.mockRestore()
    await flushUi(12)
    expect(container.querySelector('[data-history-' + label.toLowerCase() + ']')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
    expect(container.querySelector('[data-attendance-parent-return]')).toBeNull()
    expect(window.history.state.attendanceGroupReturn).toBeUndefined()
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(before)
  })

  it.each([
    '/attendance?tab=admin&section=attendance-admin-groups',
    '/attendance?tab=admin',
  ])('allows intentional Management home from returned origin %s', async (origin) => {
    const router = await returnedParent(origin)
    await explicitParentAction(router, '[data-history-management-home]')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe('')
    expect(container.querySelector('[data-attendance-parent-return]')).toBeNull()
    expect(window.history.state.attendanceGroupReturn).toBeUndefined()
    expect(router.currentRoute.value.query.section).toBeUndefined()
  })

  const scopeCases = [
    ['fetch', 'token'], ['fetch', 'tenant'], ['json', 'token'], ['json', 'tenant'],
  ] as const
  it.each(scopeCases)('settles changed scope before storage after %s for %s instead of leaving loading', async (phase, scope) => {
    const jwt = (stamp: number) => ['e30', btoa(JSON.stringify({ sub: 'same-actor', orgId: 'same-org', iat: stamp, exp: 4102444800 })), 'test'].join('.')
    const router = await mountParentHistory(undefined, jwt(1))
    await openParentRules(router)
    let resolveProbe!: (response: Response) => void
    let resolveJson!: (payload: unknown) => void
    const payload = { ok: true, data: { id: GROUP_ID, name: 'Old scope', timezone: 'UTC' } }
    vi.mocked(apiFetch).mockImplementation(() => phase === 'fetch'
      ? new Promise<Response>(resolve => { resolveProbe = resolve })
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { resolveJson = resolve }) } as Response))
    await navigateHistory(router, 'back')
    expect(container.querySelector('[data-attendance-parent-return="loading"]')).toBeTruthy()
    localStorage.setItem(scope === 'token' ? 'auth_token' : 'tenantId', scope === 'token' ? jwt(2) : 'changed-return-org')
    if (phase === 'fetch') resolveProbe(jsonResponse(200, payload))
    else resolveJson(payload)
    await flushUi(12)
    expect(container.querySelector('[data-attendance-parent-return="loading"]')).toBeNull()
    expect(container.querySelector('[data-attendance-parent-return="unavailable"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
    window.dispatchEvent(new StorageEvent('storage', { key: scope === 'token' ? 'auth_token' : 'tenantId' }))
    await flushUi(12)
    expect(container.querySelector('[data-attendance-parent-return="unavailable"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
  })

  it.each(['ready', 'pending'])('keeps automatic principal invalidation neutral while %s, and permits explicit exit', async (phase) => {
    const router = await mountParentHistory()
    await openParentRules(router)
    let resolveProbe!: (response: Response) => void
    if (phase === 'pending') vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(resolve => { resolveProbe = resolve }))
    await navigateHistory(router, 'back')
    expect(container.querySelector(phase === 'pending' ? '[data-attendance-parent-return="loading"]' : '[data-history-admin]')).toBeTruthy()
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', 'other-return-principal')
    await flushUi(12)
    expect(container.querySelector('[data-attendance-parent-return="unavailable"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')).toBeNull()
    if (phase === 'pending') {
      resolveProbe(jsonResponse(200, { ok: true, data: { id: GROUP_ID, name: 'Old principal', timezone: 'UTC' } }))
      await flushUi(12)
      expect(container.querySelector('[data-attendance-parent-return="unavailable"]')).toBeTruthy()
      expect(container.querySelector('[data-history-admin]')).toBeNull()
    }
    container.querySelector<HTMLButtonElement>('[data-attendance-parent-return="unavailable"] button')!.click()
    await flushUi(12)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe('')
    expect(window.history.state.attendanceGroupReturn).toBeUndefined()
  })

  it('keeps unchanged-scope storage events on the returned editor without a fresh probe', async () => {
    await returnedParent()
    const admin = container.querySelector('[data-history-admin]')
    const before = vi.mocked(apiFetch).mock.calls.length
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-setting' }))
    await flushUi(12)
    expect(container.querySelector('[data-history-admin]')).toBe(admin)
    expect(admin?.getAttribute('data-history-parent-group')).toBe(GROUP_ID)
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(before)
  })

  it('does not revoke older same-scope return entries when intentionally leaving the current one', async () => {
    const router = await mountParentHistory()
    await openParentRules(router)
    await returnParent(router)
    await explicitParentAction(router, '[data-history-management-home]')
    expect(window.history.state.attendanceGroupReturn).toBeUndefined()
    await navigateHistory(router, 'back')
    expect(container.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    await navigateHistory(router, 'back')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-stage')).toBe('policies')
  })

  it.each(['Reports', 'Overview'])('preserves canonical return association when the existing %s tab action stays on the canonical path', async (label) => {
    const router = await mountParentHistory()
    await openParentRules(router)
    const intent = window.history.state.attendanceGroupReturn
    const replace = vi.spyOn(router, 'replace')
    Array.from(container.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab')).find(button => button.textContent?.trim() === label)!.click()
    expect(replace).toHaveBeenCalledTimes(1)
    await replace.mock.results[0].value
    replace.mockRestore()
    await flushUi(12)
    // Preserve the existing canonical route authority; this slice does not rewrite top-tab routing.
    expect(router.currentRoute.value.path).toBe('/attendance/admin/groups/' + GROUP_ID + '/rules')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe(GROUP_ID)
    expect(window.history.state.attendanceGroupReturn).toEqual(intent)
    await returnParent(router)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-parent-stage')).toBe('policies')
  })

})
