import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import DingTalkAuthCallbackView from '../src/views/DingTalkAuthCallbackView.vue'

const apiFetchMock = vi.fn()
const setTokenMock = vi.fn()
const primeSessionMock = vi.fn()
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
    setTokenMock.mockReset()
    primeSessionMock.mockReset()
    loadProductFeaturesMock.mockReset()
    resolveHomePathMock.mockReset()
    resolveHomePathMock.mockReturnValue('/attendance')
    replaceMock.mockReset()
    replaceMock.mockResolvedValue(undefined)
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
})
