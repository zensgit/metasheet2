import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import App from '../src/App.vue'
import { setMultitableApiErrorLocaleResolver } from '../src/multitable/api/client'
import { middleEllipsis } from '../src/utils/middleEllipsis'

function fakeJwt(payload: Record<string, unknown>): string {
  const base64url = (input: string): string =>
    Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  return `${header}.${body}.signature`
}

const mocks = vi.hoisted(() => ({
  route: {
    path: '/login',
    fullPath: '/login',
    meta: {
      hideNavbar: true,
      requiresGuest: true,
    } as Record<string, unknown>,
  },
  loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  fetchPlugins: vi.fn().mockResolvedValue(undefined),
  getApiBase: vi.fn(() => 'https://api.example.com'),
  clearStoredAuthState: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    navItems: ref([]),
    fetchPlugins: mocks.fetchPlugins,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: mocks.loadProductFeatures,
    isAttendanceFocused: () => false,
    isPlmWorkbenchFocused: () => false,
    hasFeature: () => false,
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref('zh-CN'),
    isZh: ref(true),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return {
    ...actual,
    clearStoredAuthState: mocks.clearStoredAuthState,
    getApiBase: mocks.getApiBase,
  }
})

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('App guest bootstrap', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalFetch = globalThis.fetch
  const originalLocation = window.location

  beforeEach(() => {
    mocks.route.path = '/login'
    mocks.route.fullPath = '/login'
    mocks.route.meta = {
      hideNavbar: true,
      requiresGuest: true,
    }
    mocks.loadProductFeatures.mockResolvedValue(undefined)
    mocks.fetchPlugins.mockResolvedValue(undefined)
    mocks.getApiBase.mockReturnValue('https://api.example.com')
    mocks.clearStoredAuthState.mockImplementation(() => {
      for (const key of [
        'auth_token',
        'jwt',
        'devToken',
        'tenantId',
        'workspaceId',
        'metasheet_features',
        'metasheet_product_mode',
        'user_permissions',
        'user_roles',
      ]) {
        window.localStorage.removeItem(key)
      }
    })
    window.localStorage.clear()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    setMultitableApiErrorLocaleResolver(undefined)
    globalThis.fetch = originalFetch
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    vi.clearAllMocks()
  })

  it('skips session probing and plugin fetches on guest routes', async () => {
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

    expect(mocks.loadProductFeatures).toHaveBeenCalledTimes(1)
    expect(mocks.loadProductFeatures).toHaveBeenCalledWith(false, { skipSessionProbe: true })
    expect(mocks.fetchPlugins).not.toHaveBeenCalled()
  })

  it('clears local auth state and redirects after sign out', async () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: {
        ...originalLocation,
        assign,
        href: 'https://app.example.com/attendance?tab=admin',
        origin: 'https://app.example.com',
        pathname: '/attendance',
        search: '?tab=admin',
        hash: '',
      },
      writable: true,
      configurable: true,
    })

    mocks.route.path = '/attendance'
    mocks.route.fullPath = '/attendance?tab=admin'
    mocks.route.meta = {}
    window.localStorage.setItem('auth_token', 'session-token')
    window.localStorage.setItem('jwt', 'session-token')
    window.localStorage.setItem('devToken', 'dev-token')
    window.localStorage.setItem('metasheet_features', '{"attendance":true}')
    window.localStorage.setItem('metasheet_product_mode', 'attendance')
    window.localStorage.setItem('user_permissions', '["attendance:admin"]')
    window.localStorage.setItem('user_roles', '["admin"]')
    const authTokensSeenByLogoutFetch: Array<string | null> = []
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      authTokensSeenByLogoutFetch.push(window.localStorage.getItem('auth_token'))
      return new Response('{}', { status: 200 })
    })

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

    const signOutButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('退出登录')) as HTMLButtonElement | undefined
    expect(signOutButton).toBeTruthy()

    signOutButton?.click()
    await flushUi()

    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.example.com/api/auth/logout', {
      method: 'POST',
      keepalive: true,
      headers: {
        Authorization: 'Bearer session-token',
      },
    })
    expect(mocks.clearStoredAuthState).toHaveBeenCalledTimes(1)
    expect(authTokensSeenByLogoutFetch).toEqual([null])
    for (const key of [
      'auth_token',
      'jwt',
      'devToken',
      'metasheet_features',
      'metasheet_product_mode',
      'user_permissions',
      'user_roles',
    ]) {
      expect(window.localStorage.getItem(key)).toBeNull()
    }
    expect(assign).toHaveBeenCalledWith('/login')
  })
})

describe('App top-bar account identity display', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mocks.route.path = '/attendance'
    mocks.route.fullPath = '/attendance'
    mocks.route.meta = {}
    mocks.loadProductFeatures.mockResolvedValue(undefined)
    mocks.fetchPlugins.mockResolvedValue(undefined)
    mocks.getApiBase.mockReturnValue('https://api.example.com')
    window.localStorage.clear()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    setMultitableApiErrorLocaleResolver(undefined)
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  async function mountApp(): Promise<HTMLDivElement> {
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
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve()
      await nextTick()
    }
    return container
  }

  it('carries the FULL account name on title and keeps the distinguishing tail visible for a long name', async () => {
    const longEmail = 'synth-w4w7-9f2ab61c@example.com'
    const token = fakeJwt({ email: longEmail })
    window.localStorage.setItem('auth_token', token)
    window.localStorage.setItem('jwt', token)

    const el = await mountApp()
    const navUser = el.querySelector('.nav-user') as HTMLElement | null
    expect(navUser).toBeTruthy()

    // Full value must be recoverable regardless of visible truncation.
    expect(navUser?.getAttribute('title')).toBe(longEmail)

    // The visible text must retain the distinguishing tail. This is an exact literal (not
    // just endsWith/derived-from-the-function) so the assertion still discriminates if the
    // wiring stops calling middleEllipsis at all; the truncation shape itself (default
    // head/tail lengths) is middleEllipsis's own contract, covered exhaustively in
    // tests/middleEllipsis.spec.ts.
    expect(navUser?.textContent).toBe('synth-…9f2ab61c@example.com')
    expect(navUser?.textContent).toBe(middleEllipsis(longEmail))
    expect(navUser?.textContent).not.toBe(longEmail)
    expect(navUser?.textContent?.endsWith('9f2ab61c@example.com')).toBe(true)
  })

  it('renders a short account name unchanged, with title still present', async () => {
    const shortEmail = 'a@b.io'
    const token = fakeJwt({ email: shortEmail })
    window.localStorage.setItem('auth_token', token)
    window.localStorage.setItem('jwt', token)

    const el = await mountApp()
    const navUser = el.querySelector('.nav-user') as HTMLElement | null
    expect(navUser?.getAttribute('title')).toBe(shortEmail)
    expect(navUser?.textContent).toBe(shortEmail)
  })

  it('renders nothing when there is no account email (no title, no element)', async () => {
    const token = fakeJwt({}) // no email claim
    window.localStorage.setItem('auth_token', token)
    window.localStorage.setItem('jwt', token)

    const el = await mountApp()
    expect(el.querySelector('.nav-user')).toBeNull()
  })
})
