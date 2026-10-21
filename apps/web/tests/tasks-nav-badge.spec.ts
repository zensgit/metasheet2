import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

/**
 * P2-1 — App.vue's tasks nav entry + `TasksTodoBadge` gating (App.vue ~:45-48).
 *
 * Modelled directly on `approvalNavTodoBadge.spec.ts` (the sibling app-level badge gate for
 * 审批中心): a real, fully mounted `App.vue`, with only `vue-router` / `useAuth` / `useFeatureFlags`
 * / `usePlugins` / `useLocale` / `utils/api` mocked, so the SAME permission/focus/public-route
 * predicates the template actually reads are exercised end to end — not a hand-copied re-statement
 * of them.
 *
 * `tasksApi.fetchPendingCount` is spied (not the whole module stubbed away) specifically so "no
 * request fires" is a real, falsifiable assertion on the one function the badge's poll calls, the
 * same discipline `approvalNavTodoBadge.spec.ts` uses for `getPendingCount`.
 */

const fetchPendingCountSpy = vi.fn()
vi.mock('../src/tasks/tasksApi', () => ({
  fetchPendingCount: (...args: unknown[]) => fetchPendingCountSpy(...args),
}))

const mocks = vi.hoisted(() => ({
  permissions: ['tasks:read'] as string[],
  isAdmin: false,
  // Product features the mocked store reports as on. The existing cases describe a server with
  // the tasks feature ON (TASKS_ENABLED exactly 'true'); case (d) switches it off.
  features: ['tasks'] as string[],
  isZh: true,
  routePath: '/multitable',
  routeMeta: { requiresAuth: true } as Record<string, unknown>,
  focus: { attendance: false, plm: false },
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: mocks.routePath, fullPath: mocks.routePath, meta: mocks.routeMeta }),
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    resolveHomePath: () => '/home',
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
    isAttendanceFocused: () => mocks.focus.attendance,
    isPlmWorkbenchFocused: () => mocks.focus.plm,
    hasFeature: (feature: string) => mocks.features.includes(feature),
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(mocks.isZh ? 'zh-CN' : 'en'),
    isZh: ref(mocks.isZh),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({
      email: 'tasks-viewer@test.local',
      roles: [],
      permissions: mocks.permissions,
      isAdmin: mocks.isAdmin,
    }),
    getToken: () => 'session-token',
    hasPermission: (permission: string) => mocks.isAdmin || mocks.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, getApiBase: () => 'http://example.test' }
})

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('app-level tasks nav entry + badge gating (P2-1)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mocks.permissions = ['tasks:read']
    mocks.isAdmin = false
    mocks.features = ['tasks']
    mocks.isZh = true
    mocks.routePath = '/multitable'
    mocks.routeMeta = { requiresAuth: true }
    mocks.focus = { attendance: false, plm: false }
    fetchPendingCountSpy.mockReset()
    fetchPendingCountSpy.mockResolvedValue({ kind: 'ok', count: 0 })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountApp(): Promise<HTMLElement> {
    const { default: App } = await import('../src/App.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('router-view', { render: () => h('div') })
    app.component('router-link', {
      props: ['to'],
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    await flushUi()
    return container
  }

  function navTasksLink(root: HTMLElement): HTMLElement | null {
    return root.querySelector('[data-testid="nav-tasks"]')
  }

  function badgeOf(root: HTMLElement): HTMLElement | null {
    return root.querySelector('[data-testid="tasks-todo-badge"]')
  }

  it('positive control: a principal WITH tasks:read on an ordinary gated route gets the nav entry, the badge, and the pending-count request', async () => {
    fetchPendingCountSpy.mockResolvedValue({ kind: 'ok', count: 5 })
    const root = await mountApp()

    expect(navTasksLink(root)).toBeTruthy()
    expect(navTasksLink(root)?.getAttribute('href')).toBe('/tasks')
    expect(badgeOf(root)).toBeTruthy()
    expect(fetchPendingCountSpy).toHaveBeenCalledTimes(1)
  })

  // (a) no tasks:read -> no nav-tasks, no badge, NO pending-count request.
  it('(a) a principal WITHOUT tasks:read gets no nav-tasks entry, no badge, and no pending-count request', async () => {
    mocks.permissions = []
    const root = await mountApp()

    expect(navTasksLink(root)).toBeNull()
    expect(badgeOf(root)).toBeNull()
    expect(fetchPendingCountSpy).not.toHaveBeenCalled()
    // Positive control that the shell itself rendered — the absence above is the guard, not a
    // nav that failed to mount at all.
    expect(root.querySelector('.app-nav')).toBeTruthy()
  })

  // (b) attendance-focused shell hides the tasks entry entirely, even with tasks:read.
  it('(b) an attendance-focused shell renders no tasks entry/badge, even WITH tasks:read', async () => {
    mocks.focus = { attendance: true, plm: false }
    const root = await mountApp()

    expect(navTasksLink(root)).toBeNull()
    expect(badgeOf(root)).toBeNull()
    expect(fetchPendingCountSpy).not.toHaveBeenCalled()
    // The attendance-focused branch renders its OWN single link — proves the shell rendered.
    const hrefs = Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/attendance')
  })

  // (b) plmWorkbench-focused shell hides the tasks entry entirely, even with tasks:read.
  it('(b) a plmWorkbench-focused shell renders no tasks entry/badge, even WITH tasks:read', async () => {
    mocks.focus = { attendance: false, plm: true }
    const root = await mountApp()

    expect(navTasksLink(root)).toBeNull()
    expect(badgeOf(root)).toBeNull()
    expect(fetchPendingCountSpy).not.toHaveBeenCalled()
    const hrefs = Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/plm')
  })

  // (c) a public route: the badge (and its request) are suppressed even though the nav entry
  // itself (gated on tasks:read alone) still renders — mirrors App.vue's own `!isPublicRoute`
  // guard on the badge, one level more specific than the nav-entry gate above.
  it('(c) a public route issues no pending-count request and renders no badge, even WITH tasks:read', async () => {
    mocks.routePath = '/public-thing'
    mocks.routeMeta = { requiresAuth: false }
    const root = await mountApp()

    expect(fetchPendingCountSpy).not.toHaveBeenCalled()
    expect(badgeOf(root)).toBeNull()
    // Positive control: the nav entry itself is still there — this route is not also gated on
    // showNav (hideNavbar), so the absence above is specifically the badge/request guard.
    expect(navTasksLink(root)).toBeTruthy()
  })

  it('(c) /login issues no pending-count request', async () => {
    mocks.routePath = '/login'
    mocks.routeMeta = {}
    const root = await mountApp()

    expect(fetchPendingCountSpy).not.toHaveBeenCalled()
    expect(badgeOf(root)).toBeNull()
  })

  // (d) the tasks feature is off (TASKS_ENABLED not exactly 'true'): nothing about tasks renders or
  // polls, for a tasks:read holder AND for an administrator, who passes every permission probe.
  it.each([
    ['a tasks:read holder', false],
    ['an administrator', true],
  ] as const)('(d) with the tasks feature off, %s gets no nav-tasks entry, no badge and no pending-count request', async (_label, isAdmin) => {
    mocks.features = []
    mocks.isAdmin = isAdmin
    const root = await mountApp()

    expect(navTasksLink(root)).toBeNull()
    expect(badgeOf(root)).toBeNull()
    expect(fetchPendingCountSpy).not.toHaveBeenCalled()
    expect(root.querySelector('.app-nav')).toBeTruthy()
  })
})
