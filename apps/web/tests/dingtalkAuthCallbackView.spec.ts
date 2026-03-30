import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import DingTalkAuthCallbackView from '../src/views/DingTalkAuthCallbackView.vue'
import * as apiModule from '../src/utils/api'

const replaceMock = vi.fn(async () => undefined)
const setTokenMock = vi.fn()
const primeSessionMock = vi.fn()
const clearExternalAuthContextMock = vi.fn()
const openExternalUrlMock = vi.fn()
const loadProductFeaturesMock = vi.fn(async () => ({ attendance: true, workflow: true, attendanceAdmin: true, attendanceImport: true, mode: 'platform' }))
const getExternalAuthContextMock = vi.fn(() => ({ provider: 'dingtalk', mode: 'login', redirect: '/settings', state: 'state-123', createdAt: Date.now() }))
const mockRoute = {
  query: {
    code: 'auth-code',
    state: 'state-123',
    redirect: '/settings',
    mode: 'login' as 'login' | 'bind',
  },
}

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useRoute: () => mockRoute,
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    setToken: setTokenMock,
    primeSession: primeSessionMock,
    clearExternalAuthContext: clearExternalAuthContextMock,
    openExternalUrl: openExternalUrlMock,
    getExternalAuthContext: getExternalAuthContextMock,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: loadProductFeaturesMock,
    resolveHomePath: () => '/attendance',
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
  getApiBase: () => 'http://localhost:8900',
}))

function createMockResponse(payload: unknown, status = 200, ok = status < 300) {
  return {
    ok,
    status,
    json: vi.fn(async () => payload),
  } as Response
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0)
  })
}

function mountCallbackView() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(DingTalkAuthCallbackView)
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

describe('DingTalkAuthCallbackView', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    setTokenMock.mockReset()
    primeSessionMock.mockReset()
    clearExternalAuthContextMock.mockReset()
    openExternalUrlMock.mockReset()
    loadProductFeaturesMock.mockReset()
    getExternalAuthContextMock.mockReset().mockReturnValue({
      provider: 'dingtalk',
      mode: 'login',
      redirect: '/settings',
      state: 'state-123',
      createdAt: Date.now(),
    })
    vi.mocked(apiModule.apiFetch).mockReset()
    mockRoute.query = {
      code: 'auth-code',
      state: 'state-123',
      redirect: '/settings',
      mode: 'login',
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('exchanges code for token and redirects to the requested path', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({
        success: true,
        data: {
          token: 'dingtalk-token',
          user: {
            id: 'user-1',
            email: 'admin@example.com',
            name: 'Admin',
            role: 'admin',
            permissions: ['attendance:admin'],
          },
          features: {
            attendance: true,
            workflow: true,
            attendanceAdmin: true,
            attendanceImport: true,
            mode: 'platform',
          },
        },
      }),
    )

    const { container, unmount } = mountCallbackView()
    await flushPromises()
    await nextTick()

    expect(apiModule.apiFetch).toHaveBeenCalledWith('/api/auth/dingtalk/exchange', {
      method: 'POST',
      body: JSON.stringify({
        code: 'auth-code',
        state: 'state-123',
        mode: 'login',
      }),
    })
    expect(setTokenMock).toHaveBeenCalledWith('dingtalk-token')
    expect(primeSessionMock).toHaveBeenCalled()
    expect(loadProductFeaturesMock).toHaveBeenCalledWith(true)
    expect(replaceMock).toHaveBeenCalledWith('/settings')
    expect(container.textContent).toContain('登录成功')
    unmount()
  })

  it('shows a helpful error when code is missing', async () => {
    mockRoute.query = {
      state: 'state-123',
    }

    const { container, unmount } = mountCallbackView()
    await flushPromises()
    await nextTick()

    expect(container.textContent).toContain('钉钉回调缺少 code 或 state')
    expect(apiModule.apiFetch).not.toHaveBeenCalled()
    unmount()
  })

  it('shows a helpful error when stored DingTalk state does not match callback state', async () => {
    getExternalAuthContextMock.mockReturnValue({
      provider: 'dingtalk',
      mode: 'login',
      redirect: '/settings',
      state: 'state-from-storage',
      createdAt: Date.now(),
    })
    mockRoute.query = {
      code: 'auth-code',
      state: 'state-from-query',
      redirect: '/settings',
      mode: 'login',
    }

    const { container, unmount } = mountCallbackView()
    await flushPromises()
    await nextTick()

    expect(container.textContent).toContain('钉钉授权状态已失效')
    expect(apiModule.apiFetch).not.toHaveBeenCalled()
    unmount()
  })

  it('returns to the login entry instead of reusing the same code after a failed login callback', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({
        success: false,
        error: {
          code: 'DINGTALK_EXCHANGE_FAILED',
          message: 'Failed to fetch DingTalk user info',
        },
      }, 400, false),
    )

    const { container, unmount } = mountCallbackView()
    await flushPromises()
    await nextTick()

    const retryButton = Array.from(container.querySelectorAll('button')).find((element) => element.textContent?.includes('重试'))
    expect(retryButton).toBeTruthy()
    retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    await nextTick()

    expect(apiModule.apiFetch).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith({
      name: 'login',
      query: {
        redirect: '/settings',
      },
    })
    unmount()
  })

  it('redirects back to settings after a successful bind callback', async () => {
    getExternalAuthContextMock.mockReturnValue({
      provider: 'dingtalk',
      mode: 'bind',
      redirect: '/settings',
      state: 'bind-state',
      createdAt: Date.now(),
    })
    mockRoute.query = {
      code: 'bind-code',
      state: 'bind-state',
      mode: 'bind',
    }
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({
        success: true,
        data: {
          mode: 'bind',
          redirect: '/settings',
          binding: {
            provider: 'dingtalk',
            bindingId: 'bind-1',
          },
        },
      }),
    )

    const { container, unmount } = mountCallbackView()
    await flushPromises()
    await nextTick()

    expect(setTokenMock).not.toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledWith('/settings')
    expect(container.textContent).toContain('绑定成功')
    unmount()
  })

  it('shows an administrator review hint when the DingTalk account was queued for provisioning', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({
        success: false,
        error: {
          code: 'DINGTALK_ACCOUNT_REVIEW_REQUIRED',
          message: 'DingTalk account is pending administrator provisioning',
          details: {
            queuedForReview: true,
            integrationId: 'dir-1',
            accountId: 'acct-9',
          },
        },
      }, 409, false),
    )

    const { container, unmount } = mountCallbackView()
    await flushPromises()
    await nextTick()

    expect(container.textContent).toContain('当前钉钉账号尚未开通 MetaSheet')
    expect(container.textContent).toContain('该钉钉账号已加入管理员待审核队列')
    unmount()
  })
})
