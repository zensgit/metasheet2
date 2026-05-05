import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

const mocks = vi.hoisted(() => ({
  routerReplace: vi.fn().mockResolvedValue(undefined),
  loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  resolveHomePath: vi.fn(() => '/attendance'),
  apiFetch: vi.fn(),
  clearStoredAuthState: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: mocks.routerReplace,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: mocks.loadProductFeatures,
    resolveHomePath: mocks.resolveHomePath,
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return {
    ...actual,
    apiFetch: mocks.apiFetch,
    clearStoredAuthState: mocks.clearStoredAuthState,
  }
})

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  } as Storage
}

function installMemoryStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
}

function resetAuthStorage(): void {
  const keys = [
    'auth_token',
    'jwt',
    'devToken',
    'metasheet_locale',
    'metasheet_features',
    'metasheet_product_mode',
    'user_permissions',
    'user_roles',
  ]
  for (const key of keys) {
    window.localStorage.removeItem(key)
  }
}

describe('ForcePasswordChangeView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let ForcePasswordChangeViewComponent: Component
  const originalFetch = globalThis.fetch
  const originalLocalStorage = globalThis.localStorage

  beforeEach(async () => {
    installMemoryStorage(createMemoryStorage())
    resetAuthStorage()
    window.localStorage.setItem('auth_token', 'forced-token')
    window.localStorage.setItem('metasheet_locale', 'zh-CN')
    vi.clearAllMocks()
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/me')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            user: {
              id: 'user-1',
              email: 'forced@example.com',
              role: 'user',
              permissions: ['attendance:read'],
              must_change_password: true,
            },
            features: {
              attendance: true,
              workflow: false,
              mode: 'attendance',
            },
          },
        }), { status: 200 })
      }
      throw new Error(`Unexpected fetch call: ${String(input)}`)
    }) as typeof fetch

    mocks.apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          token: 'fresh-token',
          user: {
            id: 'user-1',
            email: 'forced@example.com',
            role: 'user',
            permissions: ['attendance:read'],
            must_change_password: false,
          },
          features: {
            attendance: true,
            workflow: false,
            mode: 'attendance',
          },
        },
      }),
    })

    ForcePasswordChangeViewComponent = (await import('../src/views/ForcePasswordChangeView.vue')).default as Component
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    globalThis.fetch = originalFetch
    installMemoryStorage(originalLocalStorage)
  })

  it('changes the password and redirects back to the resolved home path', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(ForcePasswordChangeViewComponent)
    app.mount(container)
    await flushUi(6)

    const inputs = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[]
    expect(inputs).toHaveLength(2)

    inputs[0]!.value = 'WelcomePass9A'
    inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    inputs[1]!.value = 'WelcomePass9A'
    inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement | null
    submitButton?.click()
    await flushUi(8)

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/auth/password/change',
      expect.objectContaining({
        method: 'POST',
        suppressUnauthorizedRedirect: true,
        body: JSON.stringify({ password: 'WelcomePass9A' }),
      }),
    )
    expect(window.localStorage.getItem('auth_token')).toBe('fresh-token')
    expect(mocks.loadProductFeatures).toHaveBeenCalledWith(true, { skipSessionProbe: true })
    expect(mocks.routerReplace).toHaveBeenCalledWith('/attendance')
  })

  it('allows signing out from the forced password change page', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(ForcePasswordChangeViewComponent)
    app.mount(container)
    await flushUi(6)

    const logoutButton = container.querySelector('.force-password-logout') as HTMLButtonElement | null
    expect(logoutButton?.textContent).toContain('退出登录')

    logoutButton?.click()
    await flushUi(8)

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        suppressUnauthorizedRedirect: true,
      }),
    )
    expect(window.localStorage.getItem('auth_token')).toBeNull()
    expect(mocks.clearStoredAuthState).toHaveBeenCalled()
    expect(mocks.routerReplace).toHaveBeenCalledWith('/login')
  })
})
