import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

const mocks = vi.hoisted(() => ({
  loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  resolveHomePath: vi.fn(() => '/attendance'),
  routerReplace: vi.fn().mockResolvedValue(undefined),
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/api/auth/login') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            token: 'login-token',
            user: {
              role: 'admin',
              permissions: ['attendance:read'],
            },
            features: {
              attendance: true,
              workflow: false,
              attendanceAdmin: true,
              attendanceImport: true,
              mode: 'attendance',
            },
          },
        }),
      }
    }

    throw new Error(`Unexpected fetch path: ${path}`)
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({
    query: {},
  }),
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

vi.mock('../src/utils/api', () => ({
  apiFetch: mocks.apiFetch,
  clearStoredAuthState: vi.fn(),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('LoginView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let LoginViewComponent: Component

  beforeEach(async () => {
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    vi.clearAllMocks()
    LoginViewComponent = (await import('../src/views/LoginView.vue')).default as Component
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('renders a visible locale switcher and updates locale changes', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(LoginViewComponent)
    app.mount(container)
    await flushUi()

    const switcher = container.querySelector('[data-testid="locale-switcher"]') as HTMLSelectElement | null
    expect(switcher).not.toBeNull()
    expect(switcher?.value).toBe('en')

    if (switcher) {
      switcher.value = 'zh-CN'
      switcher.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await flushUi()

    expect(window.localStorage.getItem('metasheet_locale')).toBe('zh-CN')
  })

  it('hydrates from the login response and skips a separate auth/me probe', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(LoginViewComponent)
    app.mount(container)
    await flushUi()

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement | null
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement | null

    expect(emailInput).not.toBeNull()
    expect(passwordInput).not.toBeNull()
    expect(submitButton).not.toBeNull()

    if (emailInput) {
      emailInput.value = 'admin@example.com'
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (passwordInput) {
      passwordInput.value = 'secret'
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    }

    submitButton?.click()
    await flushUi(8)

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }))
    expect(window.localStorage.getItem('auth_token')).toBe('login-token')
    expect(window.localStorage.getItem('user_roles')).toBe(JSON.stringify(['admin']))
    expect(window.localStorage.getItem('user_permissions')).toBe(JSON.stringify(['attendance:read']))
    expect(window.localStorage.getItem('metasheet_features')).toContain('"attendance":true')
    expect(mocks.loadProductFeatures).toHaveBeenCalledWith(true, { skipSessionProbe: true })
    expect(mocks.resolveHomePath).toHaveBeenCalled()
    expect(mocks.routerReplace).toHaveBeenCalledWith('/attendance')
  })
})
