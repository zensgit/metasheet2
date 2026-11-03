import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A second sign-in in the same tab must re-read the session features (PR #6173 fix round, F1/F2).
 *
 * One module instance per case, two sessions inside it: the REAL router with main.ts's guard, the
 * REAL App.vue, the REAL LoginView (rendered for the login route), the REAL feature-flag store,
 * useAuth, tasks badge and tasksApi. Only createRouter is wrapped (to capture the instance) and
 * element-plus is stubbed; fetch is a logging stub that plays the backend.
 *
 * Production mode (DEV=false): the development feature override that LoginView feeds through
 * `metasheet_features` is inert in a real build, and it would otherwise hide the defect.
 *
 * Before the fix, the login view's feature load (session probe skipped) kept `sessionAwareLoaded`
 * from the previous session, so the guard's load returned early and user B's features stayed
 * resolved from an empty payload: no tasks entry, /tasks redirected home, and the same for the
 * cloud-course (elearning) feature.
 */

const cap = vi.hoisted(() => ({ router: null as unknown }))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    createRouter: (options: Parameters<typeof actual.createRouter>[0]) => {
      const router = actual.createRouter(options)
      cap.router = router
      return router
    },
  }
})

vi.mock('element-plus', () => ({ default: { install() {} } }))

type TestUser = { id: string; email: string; role: string; roles: string[]; permissions: string[] }

const USERS: Record<'admin' | 'reader', TestUser> = {
  admin: { id: 'u-admin', email: 'admin@test.local', role: 'admin', roles: ['admin'], permissions: ['*:*'] },
  reader: { id: 'u-reader', email: 'reader@test.local', role: 'user', roles: ['user'], permissions: ['tasks:read', 'multitable:read'] },
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function fakeJwt(user: TestUser): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ userId: user.id, email: user.email, role: user.role, exp: 4102444800 })}.sig`
}

async function settle(rounds = 10): Promise<void> {
  const { nextTick } = await import('vue')
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

/** Upper bound for one sign-in to leave the login route (the cases themselves allow 60 s). */
const SIGN_IN_DEADLINE_MS = 15_000

type Router = import('vue-router').Router
type Flags = ReturnType<typeof import('../src/stores/featureFlags').useFeatureFlags>
type Auth = ReturnType<typeof import('../src/composables/useAuth').useAuth>

describe('a second sign-in in the same tab re-reads the session features (one module instance)', () => {
  let app: import('vue').App<Element> | null = null
  let container: HTMLDivElement | null = null
  let requests: string[] = []
  let flags: Flags | null = null
  let auth: Auth | null = null
  // What the backend's session payload says. `undefined` = the payload carries no such key.
  const server: { tasks: boolean | undefined; elearning: boolean | undefined; loginUser: TestUser } = {
    tasks: true,
    elearning: undefined,
    loginUser: USERS.admin,
  }

  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('DEV', false)
    vi.stubEnv('PROD', true)
    window.localStorage.clear()
    cap.router = null
    requests = []
    flags = null
    auth = null
    server.tasks = true
    server.elearning = undefined
    server.loginUser = USERS.admin
  })

  afterEach(() => {
    try {
      app?.unmount()
    } catch {
      // already gone
    }
    container?.remove()
    app = null
    container = null
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  function userFromStoredToken(): TestUser | null {
    const token = window.localStorage.getItem('auth_token')
    if (!token) return null
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))
      return Object.values(USERS).find((user) => user.id === payload.userId) ?? null
    } catch {
      return null
    }
  }

  function stubBackend(): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method || 'GET').toUpperCase()
      const path = new URL(url, 'http://test.invalid').pathname
      requests.push(`${method} ${path}`)
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      const features = () => {
        const out: Record<string, unknown> = { attendance: false, workflow: false, plm: false, mode: 'platform' }
        if (server.tasks !== undefined) out.tasks = server.tasks
        if (server.elearning !== undefined) out.elearning = server.elearning
        return out
      }
      if (path === '/api/auth/login') {
        const user = server.loginUser
        return json(200, { success: true, data: { token: fakeJwt(user), user, features: features() } })
      }
      if (path === '/api/auth/me') {
        const user = userFromStoredToken()
        if (!user) return json(401, { success: false })
        return json(200, { success: true, data: { user, features: features() } })
      }
      if (path.startsWith('/api/tasks')) {
        if (server.tasks !== true) return json(404, {})
        if (path === '/api/tasks/pending-count') return json(200, { count: 5 })
        return json(200, {})
      }
      return json(200, {})
    }))
  }

  async function bootAtLogin(): Promise<Router> {
    window.history.replaceState({}, '', '/login')
    await import('../src/main')
    const router = cap.router as Router
    const { createApp, h } = await import('vue')
    const { createPinia } = await import('pinia')
    const { default: App } = await import('../src/App.vue')
    const { default: LoginView } = await import('../src/views/LoginView.vue')
    const flagsModule = await import('../src/stores/featureFlags')
    const authModule = await import('../src/composables/useAuth')
    flags = flagsModule.useFeatureFlags()
    auth = authModule.useAuth()
    expect(flags.isFeatureOverrideAllowed()).toBe(false)

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App)
    app.use(createPinia())
    app.use(router)
    app.component('RouterView', {
      render: () => (router.currentRoute.value.name === 'login'
        ? h(LoginView)
        : h('div', { 'data-view': router.currentRoute.value.fullPath })),
    })
    await router.isReady()
    app.mount(container)
    await settle()
    return router
  }

  async function signIn(router: Router, user: TestUser): Promise<void> {
    server.loginUser = user
    const inputs = container!.querySelectorAll('input')
    const identifier = inputs[0] as HTMLInputElement
    const password = inputs[1] as HTMLInputElement
    identifier.value = user.email
    identifier.dispatchEvent(new Event('input'))
    password.value = 'not-a-real-password'
    password.dispatchEvent(new Event('input'))
    ;(container!.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }))
    // Wait by wall clock, not by a fixed number of event-loop turns: on a loaded CI runner the
    // login round trip (fetch stub -> bootstrapSession -> loadProductFeatures -> router.replace)
    // can take more turns than a fixed budget allows (web-tests run 36808069343 on 2026-10-01).
    const deadline = Date.now() + SIGN_IN_DEADLINE_MS
    while (router.currentRoute.value.name === 'login' && Date.now() < deadline) {
      await settle(2)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await settle()
    expect(
      router.currentRoute.value.name,
      `still on the login route after ${SIGN_IN_DEADLINE_MS} ms; requests so far: ${requests.join(', ')}`,
    ).not.toBe('login')
  }

  /** What SessionCenterView.redirectToLogin() does on a revoked session: an in-app redirect. */
  async function inAppRedirectToLogin(router: Router): Promise<void> {
    auth!.clearToken()
    window.localStorage.removeItem('metasheet_features')
    window.localStorage.removeItem('metasheet_product_mode')
    await router.replace({ name: 'login', query: { redirect: '/settings' } }).catch(() => undefined)
    await settle()
    expect(router.currentRoute.value.name).toBe('login')
  }

  function navTasks(): Element | null {
    return container!.querySelector('[data-testid="nav-tasks"]')
  }

  it('flag on throughout: user B signing in after user A in the same tab gets the entry, the badge read, and a reachable /tasks', async () => {
    stubBackend()
    const router = await bootAtLogin()
    await signIn(router, USERS.admin)
    expect(flags!.hasFeature('tasks')).toBe(true)
    expect(navTasks()).toBeTruthy()

    await inAppRedirectToLogin(router)
    const sessionBStart = requests.length
    await signIn(router, USERS.reader)
    const sessionB = requests.slice(sessionBStart)

    expect(flags!.hasFeature('tasks')).toBe(true)
    expect(navTasks()).toBeTruthy()
    expect(sessionB).toContain('GET /api/tasks/pending-count')
    // The guard's re-read uses the session the login view primed: no extra /api/auth/me.
    expect(sessionB.filter((entry) => entry === 'GET /api/auth/me')).toEqual([])

    await router.push('/tasks').catch(() => undefined)
    await settle()
    expect(router.currentRoute.value.path).toBe('/tasks')
  }, 60_000)

  it.each([
    ['tasks=false', false],
    ['no tasks value', undefined],
  ] as const)('session A with tasks on, then session B whose payload has %s: tasks is off and B makes no /api/tasks request', async (_label, sessionBTasks) => {
    stubBackend()
    const router = await bootAtLogin()
    await signIn(router, USERS.admin)
    expect(flags!.hasFeature('tasks')).toBe(true)
    expect(requests).toContain('GET /api/tasks/pending-count')

    await inAppRedirectToLogin(router)
    server.tasks = sessionBTasks
    const sessionBStart = requests.length
    await signIn(router, USERS.reader)
    const sessionB = requests.slice(sessionBStart)

    expect(flags!.hasFeature('tasks')).toBe(false)
    expect(navTasks()).toBeNull()
    expect(container!.querySelector('[data-testid="tasks-todo-badge"]')).toBeNull()
    expect(sessionB.filter((entry) => entry.includes('/api/tasks'))).toEqual([])

    await router.push('/tasks').catch(() => undefined)
    await settle()
    expect(router.currentRoute.value.path).not.toBe('/tasks')
  }, 60_000)

  it('the cloud-course (elearning) feature follows the same rule: user B signing in after user A keeps it on', async () => {
    server.elearning = true
    stubBackend()
    const router = await bootAtLogin()
    await signIn(router, USERS.admin)
    expect(flags!.hasFeature('elearning')).toBe(true)

    await inAppRedirectToLogin(router)
    await signIn(router, USERS.reader)
    expect(flags!.hasFeature('elearning')).toBe(true)
  }, 60_000)
})
