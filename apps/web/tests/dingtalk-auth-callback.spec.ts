import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import DingTalkAuthCallbackView from '../src/views/DingTalkAuthCallbackView.vue'

const apiFetchMock = vi.fn()
const setTokenMock = vi.fn()
const primeSessionMock = vi.fn()
const getTokenMock = vi.fn()
const bootstrapSessionMock = vi.fn()
const loadProductFeaturesMock = vi.fn()
const resolveHomePathMock = vi.fn(() => '/attendance')
const replaceMock = vi.fn(() => Promise.resolve())

const routeState = {
  query: {
    code: 'auth-code',
    state: 'state-1',
  },
}

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    isZh: ref(true),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: getTokenMock,
    bootstrapSession: bootstrapSessionMock,
    setToken: setTokenMock,
    primeSession: primeSessionMock,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: loadProductFeaturesMock,
    resolveHomePath: resolveHomePathMock,
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    replace: replaceMock,
  }),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('DingTalkAuthCallbackView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    getTokenMock.mockReset()
    bootstrapSessionMock.mockReset()
    setTokenMock.mockReset()
    primeSessionMock.mockReset()
    loadProductFeaturesMock.mockReset()
    resolveHomePathMock.mockReset()
    resolveHomePathMock.mockReturnValue('/attendance')
    replaceMock.mockReset()
    replaceMock.mockResolvedValue(undefined)
    getTokenMock.mockReturnValue(null)
    bootstrapSessionMock.mockResolvedValue({ ok: false, status: 401, payload: null })
    routeState.query.code = 'auth-code'
    routeState.query.state = 'state-1'

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('stores the returned token and redirects to the backend-provided path', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          token: 'jwt-dingtalk-token',
          redirectPath: '/workflows',
          user: {
            id: 'user-1',
            email: 'manager@example.com',
            role: 'admin',
            permissions: ['attendance:admin'],
          },
          features: {
            attendance: true,
            workflow: true,
            attendanceAdmin: true,
            attendanceImport: true,
            plm: false,
            mode: 'platform',
          },
        },
      }),
    })
    loadProductFeaturesMock.mockResolvedValue(undefined)

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/auth/dingtalk/callback',
      expect.objectContaining({
        method: 'POST',
        suppressUnauthorizedRedirect: true,
      }),
    )
    expect(setTokenMock).toHaveBeenCalledWith('jwt-dingtalk-token')
    expect(primeSessionMock).toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledWith('/workflows')
  })

  it('shows an inline error when the callback is missing the code query param', async () => {
    routeState.query.code = ''
    routeState.query.state = ''

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(4)

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(container?.textContent).toContain('缺少授权码参数')
  })

  it('keeps an existing authenticated session instead of overwriting it via callback', async () => {
    getTokenMock.mockReturnValue('existing-token')
    bootstrapSessionMock.mockResolvedValue({
      ok: true,
      status: 200,
      payload: {
        data: {
          user: {
            id: 'user-1',
          },
        },
      },
    })
    loadProductFeaturesMock.mockResolvedValue(undefined)

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(setTokenMock).not.toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledWith('/attendance')
  })

  it('completes a DingTalk bind callback without overwriting the current session', async () => {
    routeState.query.state = 'state-bind-1'
    sessionStorage.setItem('metasheet_dingtalk_intent_state-bind-1', 'bind')
    getTokenMock.mockReturnValue('existing-token')
    bootstrapSessionMock.mockResolvedValue({
      ok: true,
      status: 200,
      payload: {
        data: {
          user: {
            id: 'user-1',
          },
        },
      },
    })
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          mode: 'bind',
          bound: true,
          redirectPath: '/settings?dingtalk=bound',
          identity: {
            userId: 'user-1',
            identity: { exists: true },
          },
        },
      }),
    })

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/auth/dingtalk/callback',
      expect.objectContaining({
        method: 'POST',
        suppressUnauthorizedRedirect: true,
      }),
    )
    expect(setTokenMock).not.toHaveBeenCalled()
    expect(primeSessionMock).not.toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledWith('/settings?dingtalk=bound')
    expect(sessionStorage.getItem('metasheet_dingtalk_intent_state-bind-1')).toBeNull()
    sessionStorage.clear()
  })

  it('shows an error when attempting DingTalk bind without an active session', async () => {
    routeState.query.state = 'state-bind-2'
    sessionStorage.setItem('metasheet_dingtalk_intent_state-bind-2', 'bind')
    getTokenMock.mockReturnValue(null)

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(setTokenMock).not.toHaveBeenCalled()
    expect(container?.textContent ?? '').toContain('绑定失败')
    expect(sessionStorage.getItem('metasheet_dingtalk_intent_state-bind-2')).toBeNull()
    sessionStorage.clear()
  })
})
