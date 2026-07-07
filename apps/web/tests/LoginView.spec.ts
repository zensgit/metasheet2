import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

const mocks = vi.hoisted(() => ({
  loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  resolveHomePath: vi.fn(() => '/attendance'),
  routerReplace: vi.fn().mockResolvedValue(undefined),
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/api/auth/dingtalk/launch?probe=1') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            configured: true,
            available: true,
            corpId: 'ding-corp',
            allowedCorpIds: [],
            requireGrant: false,
            autoLinkEmail: false,
            autoProvision: false,
            unavailableReason: null,
          },
        }),
      }
    }

    if (path === '/api/auth/login/dingtalk/container') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            mode: 'login',
            token: 'container-token',
            user: { role: 'user', permissions: ['attendance:read'] },
            features: { attendance: true, mode: 'attendance' },
          },
        }),
      }
    }

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

    const identifierInput = container.querySelector('input[autocomplete="username"]') as HTMLInputElement | null
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement | null

    expect(identifierInput).not.toBeNull()
    expect(passwordInput).not.toBeNull()
    expect(submitButton).not.toBeNull()

    if (identifierInput) {
      identifierInput.value = 'admin@example.com'
      identifierInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (passwordInput) {
      passwordInput.value = 'secret'
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    }

    submitButton?.click()
    await flushUi(8)

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/auth/dingtalk/launch?probe=1',
      expect.objectContaining({ method: 'GET', suppressUnauthorizedRedirect: true }),
    )
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          identifier: 'admin@example.com',
          password: 'secret',
        }),
      }),
    )
    expect(window.localStorage.getItem('auth_token')).toBe('login-token')
    expect(window.localStorage.getItem('user_roles')).toBe(JSON.stringify(['admin']))
    expect(window.localStorage.getItem('user_permissions')).toBe(JSON.stringify(['attendance:read']))
    expect(window.localStorage.getItem('metasheet_features')).toContain('"attendance":true')
    expect(mocks.loadProductFeatures).toHaveBeenCalledWith(true, { skipSessionProbe: true })
    expect(mocks.resolveHomePath).toHaveBeenCalled()
    expect(mocks.routerReplace).toHaveBeenCalledWith('/attendance')
  })

  it('redirects to force-password-change when login requires password rotation', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/auth/dingtalk/launch?probe=1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              configured: true,
              available: true,
              corpId: 'ding-corp',
              allowedCorpIds: [],
              requireGrant: false,
              autoLinkEmail: false,
              autoProvision: false,
              unavailableReason: null,
            },
          }),
        }
      }

      if (path === '/api/auth/login') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              token: 'forced-login-token',
              user: {
                role: 'user',
                permissions: ['attendance:read'],
                must_change_password: true,
              },
              features: {
                attendance: true,
                workflow: false,
                attendanceAdmin: false,
                attendanceImport: false,
                mode: 'attendance',
              },
            },
          }),
        }
      }

      throw new Error(`Unexpected fetch path: ${path}`)
    })

    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(LoginViewComponent)
    app.mount(container)
    await flushUi()

    const identifierInput = container.querySelector('input[autocomplete="username"]') as HTMLInputElement | null
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null
    const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement | null

    identifierInput!.value = 'forced@example.com'
    identifierInput!.dispatchEvent(new Event('input', { bubbles: true }))
    passwordInput!.value = 'TempPass9A'
    passwordInput!.dispatchEvent(new Event('input', { bubbles: true }))

    submitButton?.click()
    await flushUi(8)

    expect(window.localStorage.getItem('auth_token')).toBe('forced-login-token')
    expect(mocks.loadProductFeatures).not.toHaveBeenCalledWith(true, { skipSessionProbe: true })
    expect(mocks.routerReplace).toHaveBeenCalledWith('/force-password-change')
  })

  it('uses the probe flag when checking DingTalk availability on mount', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(LoginViewComponent)
    app.mount(container)
    await flushUi()

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/auth/dingtalk/launch?probe=1',
      expect.objectContaining({ method: 'GET', suppressUnauthorizedRedirect: true }),
    )
    const dingtalkButton = container?.querySelector('.login-dingtalk')
    expect(dingtalkButton).not.toBeNull()
  })

  it('shows a status hint and hides the button when the probe reports DingTalk unavailable', async () => {
    mocks.apiFetch.mockImplementationOnce(async (path: string) => {
      if (path === '/api/auth/dingtalk/launch?probe=1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              configured: true,
              available: false,
              corpId: 'ding-corp-blocked',
              allowedCorpIds: ['ding-corp-allowed'],
              requireGrant: true,
              autoLinkEmail: false,
              autoProvision: false,
              unavailableReason: 'corp_not_allowed',
            },
          }),
        }
      }

      throw new Error(`Unexpected fetch path: ${path}`)
    })

    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(LoginViewComponent)
    app.mount(container)
    await flushUi()

    expect(container?.querySelector('.login-dingtalk')).toBeNull()
    expect(container?.textContent).toContain('白名单')
  })

  describe('E2b container auto 免登', () => {
    function setContainer(withAuthCode = true) {
      // navigator.userAgent is a prototype getter in jsdom (no own descriptor),
      // so we define an own property and delete it on teardown to fall back.
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android) AliApp(DingTalk/7.0.0) Mobile',
        configurable: true,
      })
      ;(window as unknown as { dd?: unknown }).dd = {
        runtime: {
          permission: {
            requestAuthCode: (opts: any) => {
              if (withAuthCode) opts.onSuccess({ code: 'container-auth-code' })
              else opts.onFail({ errorMessage: 'user cancelled' })
            },
          },
        },
      }
    }
    afterEach(() => {
      try { delete (navigator as unknown as { userAgent?: unknown }).userAgent } catch { /* falls back to prototype getter */ }
      delete (window as unknown as { dd?: unknown }).dd
      document.querySelectorAll('script[data-dingtalk-jsapi]').forEach(node => node.remove())
    })

    it('auto-logs-in inside a container: calls /container, sets token, navigates home', async () => {
      setContainer(true)
      // Self-contained mock (a prior test's mockImplementation persists past
      // vi.clearAllMocks, which resets call history but not the implementation).
      mocks.apiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/auth/dingtalk/launch?probe=1') {
          return { ok: true, status: 200, json: async () => ({ success: true, data: { available: true, corpId: 'ding-corp' } }) }
        }
        if (path === '/api/auth/login/dingtalk/container') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { mode: 'login', token: 'container-token', user: { role: 'user', permissions: ['attendance:read'] }, features: { attendance: true, mode: 'attendance' } } }),
          }
        }
        throw new Error(`Unexpected fetch path: ${path}`)
      })
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(LoginViewComponent)
      app.mount(container)
      for (let i = 0; i < 20; i += 1) { await flushUi(2) }

      expect(mocks.apiFetch).toHaveBeenCalledWith(
        '/api/auth/login/dingtalk/container',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ authCode: 'container-auth-code' }) }),
      )
      const tokenKeys = ['auth_token', 'jwt', 'devToken']
      expect(tokenKeys.some(k => window.localStorage.getItem(k) === 'container-token')).toBe(true)
      expect(mocks.routerReplace).toHaveBeenCalledWith('/attendance')
    })

    it('fail-soft: a 404 (endpoint disabled) leaves the normal login form, no token, no throw', async () => {
      setContainer(true)
      mocks.apiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/auth/dingtalk/launch?probe=1') {
          return { ok: true, status: 200, json: async () => ({ success: true, data: { available: true, corpId: 'ding-corp' } }) }
        }
        if (path === '/api/auth/login/dingtalk/container') {
          return { ok: false, status: 404, json: async () => ({ success: false, error: 'disabled', code: 'container_login_disabled' }) }
        }
        throw new Error(`Unexpected fetch path: ${path}`)
      })
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(LoginViewComponent)
      app.mount(container)
      for (let i = 0; i < 20; i += 1) { await flushUi(2) }

      expect(window.localStorage.getItem('auth_token')).toBeNull()
      expect(mocks.routerReplace).not.toHaveBeenCalled()
      expect(container.querySelector('input[type="password"]'), 'normal login form still present').toBeTruthy()
    })

    it('does not attempt container login in a plain browser (no /container call, no jsapi injected)', async () => {
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(LoginViewComponent)
      app.mount(container)
      for (let i = 0; i < 10; i += 1) { await flushUi(2) }

      const containerCalls = mocks.apiFetch.mock.calls.filter(c => String(c[0]).includes('/dingtalk/container'))
      expect(containerCalls).toHaveLength(0)
      // The isDingTalkContainer gate must short-circuit BEFORE the JSAPI load —
      // otherwise a plain browser would inject the CDN script and stall ~5s.
      expect(document.querySelector('script[data-dingtalk-jsapi]'), 'no jsapi script in a plain browser').toBeNull()
    })
  })
})
