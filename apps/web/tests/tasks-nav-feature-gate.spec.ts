import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type App as VueApp, type Component } from 'vue'
import { extractFeaturesFromPayload } from '../src/stores/featureFlags'

/**
 * The tasks top-bar entry follows the server's TASKS_ENABLED switch, not tasks:read alone.
 *
 * Defect seen on the demo server right after R61: TASKS_ENABLED was not set, so the backend mounted
 * no /api/tasks routes, yet an administrator's top bar showed 任务 with a "!" badge and every page
 * load issued GET /api/tasks/pending-count and got 404. The nav gate was `hasPermission('tasks:read')`
 * alone, and an administrator passes every permission probe.
 *
 * This spec mounts the REAL App.vue with the REAL feature-flag store, the REAL useAuth, the REAL
 * tasks badge and the REAL tasksApi. Only vue-router's useRoute, usePlugins and useLocale are
 * mocked; global fetch is a logging stub that answers GET /api/auth/me with the session payload
 * under test and everything else with an empty 200. So "no request" below means no request of ANY
 * kind whose URL contains /api/tasks, not just "one spied function was not called".
 */

const mocks = vi.hoisted(() => ({
  route: {
    path: '/multitable',
    fullPath: '/multitable',
    meta: { requiresAuth: true } as Record<string, unknown>,
  },
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ navItems: ref([]), fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref('zh-CN'), isZh: ref(true), setLocale: vi.fn() }),
}))

type SessionFeatures = Record<string, unknown>

/** The /api/auth/me shape the backend returns (`{ success, data: { user, features } }`). */
function sessionPayload(features: SessionFeatures): unknown {
  return {
    success: true,
    data: {
      user: { id: 'admin-1', email: 'admin@test.local', role: 'admin', roles: ['admin'], permissions: [] },
      features: { attendance: false, workflow: false, plm: false, mode: 'platform', ...features },
    },
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

async function settle(rounds = 6): Promise<void> {
  const { nextTick } = await import('vue')
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

describe('tasks top-bar entry follows the tasks session feature (real shell, real store, logged fetch)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let fetchLog: string[] = []
  // Bumped per case. A case that timed out on a slow runner keeps running in the background; the
  // mount below refuses to go ahead once a newer case has started, so it cannot mount a second
  // shell onto the next case's freshly reset store and pollute its request log.
  let caseSeq = 0

  beforeEach(() => {
    caseSeq += 1
    vi.resetModules()
    window.localStorage.clear()
    mocks.route.path = '/multitable'
    mocks.route.fullPath = '/multitable'
    mocks.route.meta = { requiresAuth: true }
    fetchLog = []
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    window.localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * An administrator (role admin, so `hasPermission('tasks:read')` is true through the real
   * useAuth) whose /api/auth/me answers with `features`. Modules are reset per case so the store
   * starts from its defaults, exactly like a fresh page load.
   */
  async function mountShellAsAdmin(features: SessionFeatures) {
    const myCase = caseSeq
    window.localStorage.setItem('auth_token', 'session-token')
    window.localStorage.setItem('user_roles', JSON.stringify(['admin']))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      fetchLog.push(url)
      if (url.includes('/api/auth/me')) {
        return new Response(JSON.stringify(sessionPayload(features)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/tasks/pending-count')) {
        return new Response(JSON.stringify({ count: 3 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const { createApp, h } = await import('vue')
    const { default: App } = await import('../src/App.vue')
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const { useAuth } = await import('../src/composables/useAuth')
    const flags = useFeatureFlags()

    const routerViewStub = { render: () => h('div') }
    const routerLinkStub = {
      props: { to: { type: String, required: true } },
      render(this: { to: string; $slots: { default?: () => unknown[] } }) {
        return h('a', { href: this.to }, this.$slots.default ? (this.$slots.default() as never) : [])
      },
    }

    if (myCase !== caseSeq) throw new Error('abandoned case: not mounting after its own teardown')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('RouterView', routerViewStub)
    app.component('RouterLink', routerLinkStub as Component)
    app.mount(container)

    // The shell's own onMounted feature load (session probe included) must have finished before
    // any absence below means anything; then a few more turns let a badge mount and poll.
    await vi.waitFor(() => {
      expect(flags.state.loaded).toBe(true)
      expect(flags.state.sessionAwareLoaded).toBe(true)
    }, { timeout: 15_000 })
    await settle()

    return { root: container, flags, auth: useAuth() }
  }

  function navTasks(root: HTMLElement): Element | null {
    return root.querySelector('[data-testid="nav-tasks"]')
  }

  function tasksBadge(root: HTMLElement): Element | null {
    return root.querySelector('[data-testid="tasks-todo-badge"]')
  }

  function tasksRequests(): string[] {
    return fetchLog.filter((url) => url.includes('/api/tasks'))
  }

  it.each([
    ['an older session payload with no tasks value', {}],
    ['an explicit tasks=false', { tasks: false }],
    ['a non-boolean tasks="true"', { tasks: 'true' }],
  ] as const)('feature off (%s): an administrator gets no tasks entry, no badge and no /api/tasks request', async (_label, features) => {
    const { root, flags, auth } = await mountShellAsAdmin(features)

    // Preconditions, so the absence below is the feature gate and nothing else: the caller does
    // hold tasks:read, the session probe really ran, and the admin's other gated entries rendered.
    expect(auth.hasPermission('tasks:read')).toBe(true)
    expect(fetchLog.some((url) => url.includes('/api/auth/me'))).toBe(true)
    expect(flags.hasFeature('tasks')).toBeFalsy()
    expect(root.querySelector('.app-nav')).toBeTruthy()
    expect(root.querySelector('[data-testid="nav-todo-center"]')).toBeTruthy()

    // One assertion for the three symptoms, so a failure shows all of them side by side.
    expect({
      navEntry: navTasks(root) !== null,
      navGroup: root.querySelector('.nav-tasks') !== null,
      badge: tasksBadge(root) !== null,
      tasksRequests: tasksRequests(),
    }).toEqual({ navEntry: false, navGroup: false, badge: false, tasksRequests: [] })
  }, 30_000)

  it('feature on (tasks=true): the same administrator gets the entry, the badge, and exactly the pending-count read', async () => {
    const { root, flags } = await mountShellAsAdmin({ tasks: true })

    expect(flags.hasFeature('tasks')).toBe(true)
    await vi.waitFor(() => {
      expect(tasksBadge(root)?.getAttribute('data-state')).toBe('ready')
    }, { timeout: 15_000 })
    expect(navTasks(root)?.getAttribute('href')).toBe('/tasks')
    expect(tasksBadge(root)?.getAttribute('data-count')).toBe('3')
    expect(tasksRequests().map((url) => new URL(url, 'http://localhost').pathname)).toEqual(['/api/tasks/pending-count'])
    // EXHAUSTIVE and ordered: every request this shell makes with the badge mounted. The
    // feature-off shell's list is pinned by App.spec; this one covers the badge-mounted shell, so
    // a stray request added later (by the badge or anything mounted with it) reddens this line.
    expect(fetchLog.map((url) => new URL(url, 'http://localhost').pathname)).toEqual([
      '/api/todo/count',
      '/api/approvals/admin/capability',
      '/api/auth/me',
      '/api/tasks/pending-count',
    ])
  }, 30_000)
})

describe('tasks session feature parsing and resolution', () => {
  it.each([
    [{ data: { features: { tasks: true } } }, true],
    [{ data: { features: { tasks: false } } }, false],
    [{ data: { user: { features: { tasks: true } } } }, true],
    [{ data: { features: { tasks: 'true' } } }, undefined],
    [{ data: { features: { tasks: 1 } } }, undefined],
    [{ data: { features: {} } }, undefined],
  ])('extractFeaturesFromPayload reads only an explicit boolean tasks value (%j)', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).tasks).toBe(expected)
  })

  describe('loadProductFeatures', () => {
    beforeEach(() => {
      vi.resetModules()
      window.localStorage.clear()
    })

    afterEach(() => {
      window.localStorage.clear()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    async function loadWith(features: SessionFeatures, override?: Record<string, unknown>) {
      window.localStorage.setItem('auth_token', 'session-token')
      if (override) window.localStorage.setItem('metasheet_features', JSON.stringify(override))
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input)
        if (url.includes('/api/auth/me')) {
          return new Response(JSON.stringify(sessionPayload(features)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }))
      const { useFeatureFlags } = await import('../src/stores/featureFlags')
      return useFeatureFlags().loadProductFeatures(true)
    }

    it('defaults tasks off before any load', async () => {
      const { useFeatureFlags } = await import('../src/stores/featureFlags')
      expect(useFeatureFlags().hasFeature('tasks')).toBe(false)
      expect(useFeatureFlags().state.features.tasks).toBe(false)
    })

    it('treats a session payload without a tasks value as off, even for an administrator', async () => {
      const features = await loadWith({})
      expect(features.tasks).toBe(false)
      expect(features.attendanceAdmin).toBe(true)
    })

    it('enables tasks only from an explicit backend true', async () => {
      expect((await loadWith({ tasks: true })).tasks).toBe(true)
    })

    it('keeps tasks off for an explicit backend false', async () => {
      expect((await loadWith({ tasks: false })).tasks).toBe(false)
    })

    it('lets the existing authorized development override switch tasks on over backend false', async () => {
      expect((await loadWith({ tasks: false }, { tasks: true })).tasks).toBe(true)
    })
  })
})
