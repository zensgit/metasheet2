import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, nextTick, reactive, ref, type App } from 'vue'
import AttendanceExperienceView from '../src/views/attendance/AttendanceExperienceView.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

const routeState = reactive<{
  query: Record<string, unknown>
  path: string
  fullPath: string
  name: string | undefined
  params: Record<string, unknown>
}>({
  query: {},
  path: '/attendance',
  fullPath: '/attendance',
  name: undefined,
  params: {},
})

const replaceSpy = vi.fn(async (location: { query?: Record<string, unknown> }) => {
  if (Object.prototype.hasOwnProperty.call(location, 'query')) {
    routeState.query = location.query ?? {}
  }
})
const pushSpy = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    replace: replaceSpy,
    push: pushSpy,
  }),
  // W4-2 OD-W4-7②: AttendanceExperienceView registers a route-leave confirm for
  // applied-but-unsaved template prefill. This suite mocks the router entirely, so the guard
  // registration is a no-op here; the guard's real behavior is covered with a memory router in
  // attendance-setup-templates.spec.ts.
  onBeforeRouteLeave: () => {},
}))

const adminFeatureEnabled = ref(true)
const workflowFeatureEnabled = ref(true)
// Fix 1 (retargeted per GATE-5086): hoisted so specific tests can flip the override gate and
// assert on the local-override write, mirroring adminFeatureEnabled/workflowFeatureEnabled above.
const overrideAllowedRef = ref(false)
const loadProductFeaturesSpy = vi.fn().mockResolvedValue(undefined)
const setLocalFeatureOverrideSpy = vi.fn()

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => {
      if (feature === 'attendanceAdmin') return adminFeatureEnabled.value
      if (feature === 'workflow') return workflowFeatureEnabled.value
      return false
    },
    loadProductFeatures: loadProductFeaturesSpy,
    isFeatureOverrideAllowed: () => overrideAllowedRef.value,
    setLocalFeatureOverride: setLocalFeatureOverrideSpy,
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    isZh: ref(false),
  }),
}))

vi.mock('../src/views/attendance/AttendanceOverview.vue', () => ({
  default: defineComponent({
    props: {
      initialSectionId: {
        type: String,
        default: '',
      },
      initialRequestId: {
        type: String,
        default: '',
      },
    },
    template: '<div data-view="overview" :data-section="initialSectionId" :data-request-id="initialRequestId"></div>',
  }),
}))

vi.mock('../src/views/attendance/AttendanceReportsView.vue', () => ({
  default: defineComponent({
    template: '<div data-view="reports"></div>',
  }),
}))

vi.mock('../src/views/attendance/AttendanceAdminCenter.vue', () => ({
  default: defineComponent({
    props: {
      initialSectionId: {
        type: String,
        default: '',
      },
      routeGroupContext: {
        type: Object,
        default: null,
      },
    },
    emits: ['clear-section', 'open-group-route'],
    template: '<div data-view="admin" :data-section="initialSectionId" :data-route-group="routeGroupContext?.group.id || \'\'"><button data-return-admin-home @click="$emit(\'clear-section\')">Home</button><button data-open-group-assignments @click="$emit(\'open-group-route\', { groupId: \'2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f\', step: \'schedule\', surface: \'assignments\' })">Assignments</button></div>',
  }),
}))

vi.mock('../src/views/attendance/AttendanceWorkflowDesigner.vue', () => ({
  default: defineComponent({
    props: {
      canDesign: {
        type: Boolean,
        default: false,
      },
    },
    template: '<div data-view="workflow" :data-can-design="String(canDesign)"></div>',
  }),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('Attendance experience entrypoints', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    replaceSpy.mockClear()
    pushSpy.mockClear()
    vi.mocked(apiFetch).mockReset()
    routeState.query = {}
    routeState.path = '/attendance'
    routeState.fullPath = '/attendance'
    routeState.name = undefined
    routeState.params = {}
    adminFeatureEnabled.value = true
    workflowFeatureEnabled.value = true
    overrideAllowedRef.value = false
    loadProductFeaturesSpy.mockClear()
    setLocalFeatureOverrideSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    })
    app = null
    container = null
  })

  it('renders explicit reports and import entry tabs when features are available', async () => {
    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const labels = Array.from(container!.querySelectorAll('.attendance-shell__tab')).map(node => node.textContent?.trim())
    expect(labels).toEqual(['Overview', 'Reports', 'Admin Center', 'Import', 'Workflow Designer'])
  })

  it('routes the import entrypoint into the admin import section', async () => {
    routeState.query = { tab: 'import' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const adminView = container!.querySelector<HTMLElement>('[data-view="admin"]')
    expect(adminView).toBeTruthy()
    expect(adminView?.dataset.section).toBe('attendance-admin-import')
  })

  it('routes admin section shortcuts into the requested admin section', async () => {
    routeState.query = { tab: 'admin', section: 'attendance-admin-assignments' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const adminView = container!.querySelector<HTMLElement>('[data-view="admin"]')
    expect(adminView).toBeTruthy()
    expect(adminView?.dataset.section).toBe('attendance-admin-assignments')
  })

  it('pushes a canonical group-context URL for an R2 admin entry point', async () => {
    routeState.query = { tab: 'admin', section: 'attendance-admin-groups' }
    routeState.fullPath = '/attendance?tab=admin&section=attendance-admin-groups'

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-group-assignments]')!.click()
    await flushUi(2)

    expect(pushSpy).toHaveBeenCalledWith(
      '/attendance/admin/groups/2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f/schedule'
      + '?surface=assignments&returnTo=%2Fattendance%3Ftab%3Dadmin%26section%3Dattendance-admin-groups',
    )
  })

  it('clears a deep-linked section through the router when returning to management home', async () => {
    routeState.query = { tab: 'admin', section: 'attendance-admin-assignments' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-return-admin-home]')!.click()
    await flushUi(2)

    expect(replaceSpy).toHaveBeenLastCalledWith({ query: { tab: 'admin' } })
    expect(routeState.query).toEqual({ tab: 'admin' })
    expect(container!.querySelector<HTMLElement>('[data-view="admin"]')?.dataset.section).toBe('')
  })

  it('returns the dedicated import entrypoint to the management home tab', async () => {
    routeState.query = { tab: 'import' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-return-admin-home]')!.click()
    await flushUi(2)

    expect(replaceSpy).toHaveBeenLastCalledWith({ query: { tab: 'admin' } })
    expect(routeState.query).toEqual({ tab: 'admin' })
    expect(container!.querySelector<HTMLElement>('[data-view="admin"]')?.dataset.section).toBe('')
  })

  it('routes the attendance approval queue shortcut into the overview requests section', async () => {
    routeState.query = { section: 'attendance-overview-requests', requestId: 'request-123' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const overviewView = container!.querySelector<HTMLElement>('[data-view="overview"]')
    expect(overviewView).toBeTruthy()
    expect(overviewView?.dataset.section).toBe('attendance-overview-requests')
    expect(overviewView?.dataset.requestId).toBe('request-123')
  })

  it('routes the attendance anomaly shortcut into the overview anomaly section', async () => {
    routeState.query = { section: 'attendance-overview-anomalies' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const overviewView = container!.querySelector<HTMLElement>('[data-view="overview"]')
    expect(overviewView).toBeTruthy()
    expect(overviewView?.dataset.section).toBe('attendance-overview-anomalies')
  })

  it('routes the reports entrypoint into a dedicated reports view', async () => {
    routeState.query = { tab: 'reports' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const reportsView = container!.querySelector<HTMLElement>('[data-view="reports"]')
    expect(reportsView).toBeTruthy()
    expect(container!.querySelector('[data-view="overview"]')).toBeNull()
  })

  it('updates the route query when selecting the explicit reports tab', async () => {
    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const reportsTab = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab'))
      .find(button => button.textContent?.trim() === 'Reports')
    expect(reportsTab).toBeTruthy()

    reportsTab!.click()
    await flushUi(2)

    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'reports' } })
  })

  it('gives Overview an explicit ?tab=overview so it is linkable (fix 3)', async () => {
    routeState.query = { tab: 'reports' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const overviewTab = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab'))
      .find(button => button.textContent?.trim() === 'Overview')
    expect(overviewTab).toBeTruthy()

    overviewTab!.click()
    await flushUi(2)

    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'overview' } })
  })

  it('merges a tab switch onto UNRELATED existing query params instead of discarding them (fix 3)', async () => {
    routeState.query = { tab: 'admin', surface: 'assignments', returnTo: '/attendance?tab=admin' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const reportsTab = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab'))
      .find(button => button.textContent?.trim() === 'Reports')
    reportsTab!.click()
    await flushUi(2)

    expect(replaceSpy).toHaveBeenCalledWith({
      query: { tab: 'reports', surface: 'assignments', returnTo: '/attendance?tab=admin' },
    })
  })

  it('drops the TAB-SCOPED section/requestId params on a tab switch (fix 3)', async () => {
    routeState.query = { tab: 'admin', section: 'attendance-admin-assignments', requestId: 'request-123' }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const reportsTab = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance-shell__tab'))
      .find(button => button.textContent?.trim() === 'Reports')
    reportsTab!.click()
    await flushUi(2)

    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'reports' } })
  })

  it('self-corrects to Overview (never renders a blank/unexplained state) when a tab\'s gating flag turns off while it is active', async () => {
    // Reachability probe for fix 1's "Capability not available" branch: this proves
    // `ensureTabAllowed()` / `watch(availableTabs, …)` bounce `activeTab` back to Overview
    // synchronously BEFORE the template can ever render `activeView === null` for a tab whose
    // flag just went false — through the same route+flags surface a real user's click-through
    // uses. See attendanceCapabilityUnavailable.ts's module doc for what this means for that
    // branch's live reachability.
    routeState.query = { tab: 'admin' }
    adminFeatureEnabled.value = true

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-view="admin"]')).toBeTruthy()
    expect(container!.textContent).not.toContain('Capability not available')

    adminFeatureEnabled.value = false
    await flushUi(4)

    expect(container!.querySelector('[data-view="admin"]')).toBeNull()
    expect(container!.querySelector('[data-view="overview"]')).toBeTruthy()
    expect(container!.textContent).not.toContain('Capability not available')
    // Neither the retargeted denial banner (this scenario doesn't go through syncFromRoute's
    // `?tab=` normalization — see the next test for that) nor the generic dead-branch safety net
    // renders here.
    expect(container!.querySelector('[data-attendance-tab-unavailable-banner]')).toBeNull()
    expect(container!.querySelector('[data-attendance-shell-unexpected-empty]')).toBeNull()
  })

  it('corrects the URL and names the denied capability when deep-linking to a disabled tab (fix 1, retargeted per GATE-5086)', async () => {
    // GATE-5086's actual reachable finding: `/attendance?tab=admin` with `attendanceAdmin` OFF
    // used to silently land on Overview while the address bar kept `?tab=admin` and nothing
    // explained why. Assert all three required behaviors: URL normalized, explanation names the
    // tab, and the user is actually on Overview (back-to-overview "works" because it's already
    // where they land — see the next test for the banner's own dismiss button).
    routeState.query = { tab: 'admin' }
    adminFeatureEnabled.value = false

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'overview' } })
    expect(routeState.query).toEqual({ tab: 'overview' })
    expect(container!.querySelector('[data-view="overview"]')).toBeTruthy()
    expect(container!.querySelector('[data-view="admin"]')).toBeNull()

    const banner = container!.querySelector('[data-attendance-tab-unavailable-banner]')
    expect(banner).toBeTruthy()
    expect(banner!.textContent).toContain('Admin Center')
    expect(container!.querySelector('[data-attendance-capability-contact-admin]')).toBeTruthy()
  })

  it('drops the denial banner (and the tab-scoped section/requestId) from the corrected URL', async () => {
    routeState.query = { tab: 'workflow', section: 'attendance-admin-assignments', requestId: 'request-1' }
    workflowFeatureEnabled.value = false

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'overview' } })
    const banner = container!.querySelector('[data-attendance-tab-unavailable-banner]')
    expect(banner!.textContent).toContain('Workflow Designer')
  })

  it('dismisses the denial banner via its own back-to-overview button without touching the route', async () => {
    routeState.query = { tab: 'admin' }
    adminFeatureEnabled.value = false

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()
    expect(container!.querySelector('[data-attendance-tab-unavailable-banner]')).toBeTruthy()
    replaceSpy.mockClear()

    container!.querySelector<HTMLButtonElement>('[data-attendance-capability-back-to-overview]')!.click()
    await flushUi(2)

    expect(container!.querySelector('[data-attendance-tab-unavailable-banner]')).toBeNull()
    expect(container!.querySelector('[data-view="overview"]')).toBeTruthy()
    // Dismissing is a pure UI-state action here — the URL was already corrected when the
    // denial fired, so dismissing it does not need to touch the router again.
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('retrying takes the user to the originally-requested tab once its flag resolves on', async () => {
    routeState.query = { tab: 'admin' }
    adminFeatureEnabled.value = false

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()
    expect(container!.querySelector('[data-attendance-tab-unavailable-banner]')).toBeTruthy()

    adminFeatureEnabled.value = true
    container!.querySelector<HTMLButtonElement>('[data-attendance-capability-retry]')!.click()
    await flushUi(4)

    expect(loadProductFeaturesSpy).toHaveBeenCalledWith(true)
    expect(container!.querySelector('[data-attendance-tab-unavailable-banner]')).toBeNull()
    expect(container!.querySelector('[data-view="admin"]')).toBeTruthy()
    expect(routeState.query).toEqual({ tab: 'admin' })
  })

  it('retrying leaves the banner in place (does not silently vanish) when the capability is still denied', async () => {
    routeState.query = { tab: 'admin' }
    adminFeatureEnabled.value = false

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-attendance-capability-retry]')!.click()
    await flushUi(4)

    expect(loadProductFeaturesSpy).toHaveBeenCalledWith(true)
    const banner = container!.querySelector('[data-attendance-tab-unavailable-banner]')
    expect(banner).toBeTruthy()
    expect(banner!.textContent).toContain('Admin Center')
  })

  it('enabling locally writes the override, then takes the user to the originally-requested tab (only when the override gate is open)', async () => {
    routeState.query = { tab: 'admin' }
    adminFeatureEnabled.value = false
    overrideAllowedRef.value = true

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const enableButton = container!.querySelector<HTMLButtonElement>('[data-attendance-capability-enable-locally]')
    expect(enableButton).toBeTruthy()
    expect(container!.querySelector('[data-attendance-capability-contact-admin]')).toBeNull()

    // The mocked store doesn't actually flip hasFeature() as a side effect of
    // setLocalFeatureOverride() — simulate the real store's effect directly, same as the retry
    // test above, since this suite mocks the whole flags store.
    adminFeatureEnabled.value = true
    enableButton!.click()
    await flushUi(4)

    expect(setLocalFeatureOverrideSpy).toHaveBeenCalledWith('attendanceAdmin', true)
    expect(loadProductFeaturesSpy).toHaveBeenCalledWith(true)
    expect(container!.querySelector('[data-attendance-tab-unavailable-banner]')).toBeNull()
    expect(container!.querySelector('[data-view="admin"]')).toBeTruthy()
  })

  it('shows "ask your administrator" instead of an enable-locally control when the override gate is closed', async () => {
    routeState.query = { tab: 'admin' }
    adminFeatureEnabled.value = false
    overrideAllowedRef.value = false

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-attendance-capability-enable-locally]')).toBeNull()
    expect(container!.querySelector('[data-attendance-capability-contact-admin]')).toBeTruthy()
  })

  it('does not block admin entrypoints for narrow desktop-like viewports without mobile signals', async () => {
    routeState.query = { tab: 'admin' }

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 899px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-view="admin"]')).toBeTruthy()
    expect(container!.textContent).not.toContain('Desktop recommended')
  })

  it('returns a mobile-blocked group route to its normalized returnTo', async () => {
    const groupId = '11111111-2222-4333-8444-555555555555'
    const returnTo = '/attendance?tab=admin&section=attendance-admin-groups'
    routeState.path = `/attendance/admin/groups/${groupId}/schedule`
    routeState.fullPath = `${routeState.path}?surface=assignments&returnTo=${encodeURIComponent(returnTo)}`
    routeState.name = 'attendance-admin-group-schedule'
    routeState.params = { groupId }
    routeState.query = { surface: 'assignments', returnTo }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 899px') || query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    const back = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Back to Overview')
    expect(back).toBeTruthy()
    back!.click()
    await flushUi(2)

    expect(pushSpy).toHaveBeenCalledWith(returnTo)
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('uses group route params as authority across direct load and route history changes', async () => {
    const groupA = '11111111-2222-4333-8444-555555555555'
    const groupB = '66666666-7777-4888-8999-000000000000'
    routeState.path = `/attendance/admin/groups/${groupA}/schedule`
    routeState.name = 'attendance-admin-group-schedule'
    routeState.params = { groupId: groupA }
    routeState.query = { tab: 'overview', surface: 'assignments' }
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, data: { id: groupA, name: 'A', timezone: 'UTC' } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, data: { id: groupB, name: 'B', timezone: 'UTC' } }) } as Response)

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(apiFetch).toHaveBeenNthCalledWith(1, `/api/attendance/groups/${groupA}`)
    expect(container!.querySelector<HTMLElement>('[data-view="admin"]')?.dataset.routeGroup).toBe(groupA)

    routeState.path = `/attendance/admin/groups/${groupB}/rules`
    routeState.name = 'attendance-admin-group-rules'
    routeState.params = { groupId: groupB }
    routeState.query = {}
    await flushUi()

    expect(apiFetch).toHaveBeenNthCalledWith(2, `/api/attendance/groups/${groupB}`)
    expect(container!.querySelector<HTMLElement>('[data-view="admin"]')?.dataset.routeGroup).toBe(groupB)
  })

  it('routes duplicate group query values to the route-level not-found posture', async () => {
    const groupId = '11111111-2222-4333-8444-555555555555'
    routeState.path = `/attendance/admin/groups/${groupId}/schedule`
    routeState.name = 'attendance-admin-group-schedule'
    routeState.params = { groupId }
    routeState.query = { surface: ['assignments', 'shifts'] }

    app = createApp(AttendanceExperienceView)
    app.mount(container!)
    await flushUi()

    expect(replaceSpy).toHaveBeenCalledWith({
      name: 'not-found',
      params: { pathMatch: ['attendance', 'admin', 'groups', groupId, 'schedule'] },
    })
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container!.querySelector('[data-attendance-group-context="unavailable"]')).toBeNull()
  })
})
