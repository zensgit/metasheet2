import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import App from '../src/App.vue'
import { setMultitableApiErrorLocaleResolver } from '../src/multitable/api/client'

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
      headers: {
        Authorization: 'Bearer session-token',
      },
    })
    expect(mocks.clearStoredAuthState).toHaveBeenCalledTimes(1)
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
