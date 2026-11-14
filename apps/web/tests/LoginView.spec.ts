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

  it.each([
    ['missing_client_id',
      '缺少服务端配置 DINGTALK_CLIENT_ID（或 DINGTALK_APP_KEY），请联系管理员配置钉钉登录。',
      'Ask an administrator to configure DINGTALK_CLIENT_ID (or DINGTALK_APP_KEY) for DingTalk login.'],
    ['missing_client_secret',
      '缺少服务端配置 DINGTALK_CLIENT_SECRET（或 DINGTALK_APP_SECRET），请联系管理员配置钉钉登录。',
      'Ask an administrator to configure DINGTALK_CLIENT_SECRET (or DINGTALK_APP_SECRET) for DingTalk login.'],
    ['missing_redirect_uri',
      '缺少服务端配置 DINGTALK_REDIRECT_URI，请联系管理员填写与钉钉开放平台一致的登录回调地址。',
      'Ask an administrator to configure DINGTALK_REDIRECT_URI to match the login callback URL in DingTalk.'],
    ['corp_not_allowed',
      '钉钉企业白名单未放行，请联系管理员检查 DINGTALK_CORP_ID 与 DINGTALK_ALLOWED_CORP_IDS。',
      'Ask an administrator to check DINGTALK_CORP_ID against DINGTALK_ALLOWED_CORP_IDS; the corporate allowlist blocks DingTalk login.'],
  ])('shows %s only when configured and updates the hint when switching language', async (reason, zh, en) => {
    mocks.apiFetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          configured: reason === 'corp_not_allowed',
          available: false,
          corpId: 'private-corp-value',
          allowedCorpIds: ['private-allowlist-value'],
          requireGrant: false,
          autoLinkEmail: false,
          autoProvision: false,
          unavailableReason: reason,
        },
      }),
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(LoginViewComponent)
    app.mount(container)
    await flushUi()

    const switcher = container.querySelector<HTMLSelectElement>('[data-testid="locale-switcher"]')!
    for (const [locale, expected] of [['en', en], ['zh-CN', zh]]) {
      switcher.value = locale
      switcher.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      expect(container.querySelector('.login-hint')?.textContent).toBe(reason === 'corp_not_allowed' ? expected : undefined)
      expect(container.querySelector('.login-dingtalk')).toBeNull()
      expect(container.querySelector('button[type="submit"]')).not.toBeNull()
      expect(container.textContent).not.toContain('private-corp-value')
      expect(container.textContent).not.toContain('private-allowlist-value')
    }
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/auth/dingtalk/launch?probe=1',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('uses a safe generic hint for an unknown reason without exposing response values', async () => {
    mocks.apiFetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          configured: true,
          available: false,
          corpId: 'private-corp-value',
          allowedCorpIds: [],
          requireGrant: false,
          autoLinkEmail: false,
          autoProvision: false,
          unavailableReason: 'unexpected-private-value',
          clientSecret: 'private-secret-value',
        },
      }),
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(LoginViewComponent)
    app.mount(container)
    await flushUi()
    const switcher = container.querySelector<HTMLSelectElement>('[data-testid="locale-switcher"]')!
    switcher.value = 'en'
    switcher.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container.querySelector('.login-hint')?.textContent).toBe('DingTalk login is unavailable right now.')
    expect(container.querySelector('.login-dingtalk')).toBeNull()
    for (const value of ['unexpected-private-value', 'private-secret-value', 'private-corp-value']) {
      expect(container.textContent).not.toContain(value)
    }
  })

  describe('#6467 unknown configuration state retains safe missingEnv hints', () => {
    async function mountWithProbe(data: Record<string, unknown>): Promise<HTMLSelectElement> {
      mocks.apiFetch.mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            available: false,
            corpId: null,
            allowedCorpIds: [],
            requireGrant: false,
            autoLinkEmail: false,
            autoProvision: false,
            ...data,
          },
        }),
      }))
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(LoginViewComponent)
      app.mount(container)
      await flushUi()
      return container.querySelector<HTMLSelectElement>('[data-testid="locale-switcher"]')!
    }

    async function hintIn(switcher: HTMLSelectElement, locale: 'en' | 'zh-CN'): Promise<string | null | undefined> {
      switcher.value = locale
      switcher.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      return container!.querySelector('.login-hint')?.textContent
    }

    it.each([
      [
        'all three',
        'missing_client_id',
        ['DINGTALK_CLIENT_ID|DINGTALK_APP_KEY', 'DINGTALK_CLIENT_SECRET|DINGTALK_APP_SECRET', 'DINGTALK_REDIRECT_URI'],
        '缺少服务端配置 DINGTALK_CLIENT_ID（或 DINGTALK_APP_KEY）、DINGTALK_CLIENT_SECRET（或 DINGTALK_APP_SECRET）、DINGTALK_REDIRECT_URI，请联系管理员配置钉钉登录；DINGTALK_REDIRECT_URI 须与钉钉开放平台的登录回调地址一致。',
        'Ask an administrator to configure DINGTALK_CLIENT_ID (or DINGTALK_APP_KEY), DINGTALK_CLIENT_SECRET (or DINGTALK_APP_SECRET), DINGTALK_REDIRECT_URI for DingTalk login; DINGTALK_REDIRECT_URI must match the login callback URL in DingTalk.',
      ],
      [
        'id + secret',
        'missing_client_id',
        ['DINGTALK_CLIENT_SECRET|DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_ID|DINGTALK_APP_KEY'],
        '缺少服务端配置 DINGTALK_CLIENT_ID（或 DINGTALK_APP_KEY）、DINGTALK_CLIENT_SECRET（或 DINGTALK_APP_SECRET），请联系管理员配置钉钉登录。',
        'Ask an administrator to configure DINGTALK_CLIENT_ID (or DINGTALK_APP_KEY), DINGTALK_CLIENT_SECRET (or DINGTALK_APP_SECRET) for DingTalk login.',
      ],
      [
        'secret + redirect',
        'missing_client_secret',
        ['DINGTALK_CLIENT_SECRET|DINGTALK_APP_SECRET', 'DINGTALK_REDIRECT_URI'],
        '缺少服务端配置 DINGTALK_CLIENT_SECRET（或 DINGTALK_APP_SECRET）、DINGTALK_REDIRECT_URI，请联系管理员配置钉钉登录；DINGTALK_REDIRECT_URI 须与钉钉开放平台的登录回调地址一致。',
        'Ask an administrator to configure DINGTALK_CLIENT_SECRET (or DINGTALK_APP_SECRET), DINGTALK_REDIRECT_URI for DingTalk login; DINGTALK_REDIRECT_URI must match the login callback URL in DingTalk.',
      ],
    ])('lists %s in canonical order (zh/en)', async (_label, reason, missingEnv, zh, en) => {
      const switcher = await mountWithProbe({ unavailableReason: reason, missingEnv })
      expect(await hintIn(switcher, 'en')).toBe(en)
      expect(await hintIn(switcher, 'zh-CN')).toBe(zh)
      expect(container!.querySelector('.login-dingtalk')).toBeNull()
    })

    it.each([
      ['missing_client_id', 'DINGTALK_CLIENT_ID|DINGTALK_APP_KEY',
        'Ask an administrator to configure DINGTALK_CLIENT_ID (or DINGTALK_APP_KEY) for DingTalk login.',
        '缺少服务端配置 DINGTALK_CLIENT_ID（或 DINGTALK_APP_KEY），请联系管理员配置钉钉登录。'],
      ['missing_client_secret', 'DINGTALK_CLIENT_SECRET|DINGTALK_APP_SECRET',
        'Ask an administrator to configure DINGTALK_CLIENT_SECRET (or DINGTALK_APP_SECRET) for DingTalk login.',
        '缺少服务端配置 DINGTALK_CLIENT_SECRET（或 DINGTALK_APP_SECRET），请联系管理员配置钉钉登录。'],
    ])('retains the standalone %s hint when configuration is unknown', async (unavailableReason, requirement, en, zh) => {
      const switcher = await mountWithProbe({ unavailableReason, missingEnv: [requirement] })
      expect(await hintIn(switcher, 'en')).toBe(en)
      expect(await hintIn(switcher, 'zh-CN')).toBe(zh)
    })

    it('keeps the per-reason sentence when only one variable is missing', async () => {
      const switcher = await mountWithProbe({
        unavailableReason: 'missing_redirect_uri',
        missingEnv: ['DINGTALK_REDIRECT_URI'],
      })
      expect(await hintIn(switcher, 'zh-CN')).toBe('缺少服务端配置 DINGTALK_REDIRECT_URI，请联系管理员填写与钉钉开放平台一致的登录回调地址。')
    })

    it('renders only known names: unexpected or value-bearing entries are dropped', async () => {
      const switcher = await mountWithProbe({
        unavailableReason: 'missing_client_id',
        missingEnv: [
          'DINGTALK_CLIENT_ID|DINGTALK_APP_KEY',
          'private-secret-value',
          'DINGTALK_REDIRECT_URI=https://private-host.example',
          'DINGTALK_REDIRECT_URI',
          42,
        ],
      })
      expect(await hintIn(switcher, 'en')).toBe(
        'Ask an administrator to configure DINGTALK_CLIENT_ID (or DINGTALK_APP_KEY), DINGTALK_REDIRECT_URI for DingTalk login; DINGTALK_REDIRECT_URI must match the login callback URL in DingTalk.',
      )
      for (const value of ['private-secret-value', 'private-host.example']) {
        expect(container!.textContent).not.toContain(value)
      }
    })

    it('corp_not_allowed keeps its own sentence even if missingEnv were non-empty', async () => {
      const switcher = await mountWithProbe({
        configured: true,
        unavailableReason: 'corp_not_allowed',
        missingEnv: ['DINGTALK_CLIENT_ID|DINGTALK_APP_KEY', 'DINGTALK_REDIRECT_URI'],
      })
      expect(await hintIn(switcher, 'zh-CN')).toBe('钉钉企业白名单未放行，请联系管理员检查 DINGTALK_CORP_ID 与 DINGTALK_ALLOWED_CORP_IDS。')
    })
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

    it('fail-soft P2: authCode cancellation (throwing path) leaves the normal form, no token, no throw', async () => {
      setContainer(false)  // user rejects the 免登 authorization → onFail → requestAuthCode rejects → catch
      mocks.apiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/auth/dingtalk/launch?probe=1') {
          return { ok: true, status: 200, json: async () => ({ success: true, data: { available: true, corpId: 'ding-corp' } }) }
        }
        throw new Error(`Unexpected fetch path: ${path}`)
      })
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(LoginViewComponent)
      app.mount(container)
      for (let i = 0; i < 20; i += 1) { await flushUi(2) }

      // The throwing failure (authCode rejected) must be swallowed by the catch:
      const containerCalls = mocks.apiFetch.mock.calls.filter(c => String(c[0]).includes('/dingtalk/container'))
      expect(containerCalls, 'authCode never obtained → /container never called').toHaveLength(0)
      expect(window.localStorage.getItem('auth_token')).toBeNull()
      expect(mocks.routerReplace).not.toHaveBeenCalled()
      expect(container.querySelector('input[type="password"]'), 'normal login form still present').toBeTruthy()
      expect(container.querySelector('[data-testid="dingtalk-container-login-progress"]'), 'progress hint cleared').toBeNull()
    })

    it('P3-4: skips container login when a token already exists', async () => {
      setContainer(true)
      window.localStorage.setItem('auth_token', 'existing-token')
      window.localStorage.setItem('jwt', 'existing-token')
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(LoginViewComponent)
      app.mount(container)
      for (let i = 0; i < 15; i += 1) { await flushUi(2) }

      const containerCalls = mocks.apiFetch.mock.calls.filter(c => String(c[0]).includes('/dingtalk/container'))
      expect(containerCalls, 'already authenticated → no re-login').toHaveLength(0)
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

  describe('explicit unconfigured login status', () => {
    const unavailableHint = 'DingTalk login is unavailable right now.'

    async function mountLogin(): Promise<void> {
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(LoginViewComponent)
      app.mount(container)
      await flushUi()
      const switcher = container.querySelector<HTMLSelectElement>('[data-testid="locale-switcher"]')!
      switcher.value = 'en'
      switcher.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
    }

    function probe(data: Record<string, unknown>): void {
      mocks.apiFetch.mockImplementationOnce(async () => ({
        ok: true, status: 200, json: async () => ({ success: true, data }),
      }))
    }

    it.each(['missing_client_id', 'unknown_reason'])('unconfigured status hides %s guidance in both languages', async (unavailableReason) => {
      probe({ configured: false, available: false, unavailableReason,
        missingEnv: ['DINGTALK_CLIENT_ID|DINGTALK_APP_KEY', 'DINGTALK_CLIENT_SECRET|DINGTALK_APP_SECRET', 'DINGTALK_REDIRECT_URI'] })
      await mountLogin()
      const switcher = container!.querySelector<HTMLSelectElement>('[data-testid="locale-switcher"]')!
      for (const locale of ['en', 'zh-CN']) {
        switcher.value = locale
        switcher.dispatchEvent(new Event('change', { bubbles: true }))
        await flushUi()
        expect(container!.querySelector('.login-hint')).toBeNull()
        expect(container!.querySelector('.login-dingtalk')).toBeNull()
        expect(container!.querySelector('.login-divider')).toBeNull()
        expect(container!.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.disabled).toBe(false)
        expect(container!.querySelector<HTMLInputElement>('input[type="password"]')?.disabled).toBe(false)
        expect(container!.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
      }
      expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    })

    it.each([undefined, null, 0, 'false', true])('keeps unavailable hints for non-false configured=%s', async (configured) => {
      probe({ configured, available: false })
      await mountLogin()
      expect(container!.querySelector('.login-hint')?.textContent).toBe(unavailableHint)
      expect(container!.querySelector('.login-dingtalk')).toBeNull()
    })

    it.each(['network', 'http', 'json'])('keeps the unavailable hint after a %s probe failure', async (failure) => {
      mocks.apiFetch.mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error('synthetic network failure')
        return {
          ok: failure !== 'http', status: failure === 'http' ? 503 : 200,
          json: async () => {
            if (failure === 'json') throw new Error('synthetic invalid JSON')
            return { success: true, data: { configured: false, available: false } }
          },
        }
      })
      await mountLogin()
      expect(container!.querySelector('.login-hint')?.textContent).toBe(unavailableHint)
      expect(container!.querySelector('.login-dingtalk')).toBeNull()
    })

    it('keeps active DingTalk launch failures visible', async () => {
      probe({ configured: true, available: true })
      mocks.apiFetch.mockImplementationOnce(async () => ({
        ok: false, status: 503, json: async () => ({ success: false }),
      }))
      await mountLogin()
      const button = container!.querySelector<HTMLButtonElement>('.login-dingtalk')!
      expect(button).not.toBeNull()
      button.click()
      await flushUi(8)
      expect(container!.querySelector('.login-error')?.textContent).toBe(unavailableHint)
      expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/auth/dingtalk/launch', expect.objectContaining({ method: 'GET' }))
      expect(mocks.routerReplace).not.toHaveBeenCalled()
    })

    it.each([true, false])('preserves password login success=%s while DingTalk is unconfigured', async (success) => {
      probe({ configured: false, available: false, unavailableReason: 'missing_client_id' })
      mocks.apiFetch.mockImplementationOnce(async () => ({
        ok: success, status: success ? 200 : 401,
        json: async () => success
          ? { success: true, data: { token: 'synthetic-password-token', user: { role: 'user', permissions: [] }, features: {} } }
          : { success: false },
      }))
      await mountLogin()
      for (const [selector, value] of [['input[autocomplete="username"]', 'demo-user'], ['input[type="password"]', 'synthetic-password']]) {
        const input = container!.querySelector<HTMLInputElement>(selector)!
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
      await flushUi(8)
      expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
      expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ identifier: 'demo-user', password: 'synthetic-password' }),
      }))
      expect(container!.querySelector('.login-hint')).toBeNull()
      if (success) {
        expect(window.localStorage.getItem('auth_token')).toBe('synthetic-password-token')
        expect(mocks.routerReplace).toHaveBeenCalledWith('/attendance')
        expect(container!.querySelector('.login-error')).toBeNull()
      } else {
        expect(window.localStorage.getItem('auth_token')).toBeNull()
        expect(mocks.routerReplace).not.toHaveBeenCalled()
        expect(container!.querySelector('.login-error')?.textContent).toBe('Sign-in failed. Check your account or password.')
      }
    })
  })
})
