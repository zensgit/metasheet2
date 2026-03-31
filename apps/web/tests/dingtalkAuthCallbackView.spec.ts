import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import DingTalkAuthCallbackView from '../src/views/DingTalkAuthCallbackView.vue'

const replaceMock = vi.fn(async () => undefined)
const setTokenMock = vi.fn()
const primeSessionMock = vi.fn()
const loadProductFeaturesMock = vi.fn(async () => ({ attendance: true, workflow: true, attendanceAdmin: true, attendanceImport: true, mode: 'platform' }))
const resolveHomePathMock = vi.fn(() => '/attendance')

let mockQuery: Record<string, string> = {}

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useRoute: () => ({ query: mockQuery }),
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

function mountView() {
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
    loadProductFeaturesMock.mockReset()
    resolveHomePathMock.mockReset().mockReturnValue('/attendance')
    mockQuery = {}
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows error when code is missing', async () => {
    mockQuery = {}

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()

    const errorText = container.querySelector('.dingtalk-callback__error-text')
    expect(errorText).not.toBeNull()
    expect(errorText?.textContent).toContain('缺少授权码参数')
    unmount()
  })

  it('calls backend callback and sets token on success', async () => {
    mockQuery = { code: 'auth-code-123', state: 'random-state' }

    vi.stubGlobal('fetch', vi.fn(async () => createMockResponse({
      success: true,
      data: {
        token: 'jwt-dingtalk-token',
        user: { id: 'user-1', email: 'test@example.com', name: 'Test' },
        features: { attendance: true, workflow: true, mode: 'platform' },
      },
    })))

    const { unmount } = mountView()
    await flushPromises()
    await nextTick()

    expect(setTokenMock).toHaveBeenCalledWith('jwt-dingtalk-token')
    expect(primeSessionMock).toHaveBeenCalledWith({
      success: true,
      data: {
        user: { id: 'user-1', email: 'test@example.com', name: 'Test' },
        features: { attendance: true, workflow: true, mode: 'platform' },
      },
    })
    expect(loadProductFeaturesMock).toHaveBeenCalledWith(true)
    expect(replaceMock).toHaveBeenCalled()
    unmount()
  })

  it('shows error when backend returns error', async () => {
    mockQuery = { code: 'bad-code', state: 'random-state' }

    vi.stubGlobal('fetch', vi.fn(async () => createMockResponse({
      success: false,
      error: 'Invalid DingTalk code',
    }, 502, false)))

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()

    const errorText = container.querySelector('.dingtalk-callback__error-text')
    expect(errorText).not.toBeNull()
    expect(errorText?.textContent).toContain('Invalid DingTalk code')
    expect(setTokenMock).not.toHaveBeenCalled()
    unmount()
  })

  it('shows error when response has no token', async () => {
    mockQuery = { code: 'auth-code', state: 'random-state' }

    vi.stubGlobal('fetch', vi.fn(async () => createMockResponse({
      success: true,
      data: { user: { id: 'user-1' } },
    })))

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()

    const errorText = container.querySelector('.dingtalk-callback__error-text')
    expect(errorText).not.toBeNull()
    expect(errorText?.textContent).toContain('未获取到令牌')
    unmount()
  })

  it('"返回登录" navigates to login route', async () => {
    mockQuery = {}
    replaceMock.mockResolvedValue(undefined)

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()

    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('返回登录'),
    )
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(replaceMock).toHaveBeenCalledWith({ name: 'login' })
    unmount()
  })

  it('shows loading spinner while processing', async () => {
    mockQuery = { code: 'auth-code', state: 'random-state' }

    // Delay the fetch to observe loading state
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {
      // Never resolves — keeps loading
    })))

    const { container, unmount } = mountView()
    await nextTick()

    const spinner = container.querySelector('.dingtalk-callback__spinner')
    expect(spinner).not.toBeNull()

    const loadingText = container.querySelector('.dingtalk-callback__loading p')
    expect(loadingText?.textContent).toContain('正在验证')
    unmount()
  })
})
