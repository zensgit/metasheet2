import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import LoginView from '../src/views/LoginView.vue'

const replaceMock = vi.fn(async () => undefined)
const setTokenMock = vi.fn()
const primeSessionMock = vi.fn()
const loadProductFeaturesMock = vi.fn(async () => ({ attendance: true, workflow: true, attendanceAdmin: true, attendanceImport: true, mode: 'platform' }))
const resolveHomePathMock = vi.fn(() => '/attendance')

const mockRoute = { query: { redirect: '/settings' as string | undefined } }

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useRoute: () => mockRoute,
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

function mountLoginView() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(LoginView)
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

describe('LoginView', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    setTokenMock.mockReset()
    primeSessionMock.mockReset()
    loadProductFeaturesMock.mockReset()
    resolveHomePathMock.mockReset().mockReturnValue('/attendance')
    mockRoute.query.redirect = '/settings'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows error message from top-level payload.error object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => createMockResponse({
      error: { message: 'Invalid credentials' },
    }, 401, false)))

    const { container, unmount } = mountLoginView()
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement
    emailInput.value = 'admin@example.com'
    passwordInput.value = 'test-password'
    emailInput.dispatchEvent(new Event('input'))
    passwordInput.dispatchEvent(new Event('input'))

    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    await nextTick()

    const errorMessage = container.querySelector('.error')
    expect(errorMessage).not.toBeNull()
    expect(errorMessage?.textContent).toContain('Invalid credentials')
    expect(setTokenMock).not.toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
    unmount()
  })

  it('navigates using route redirect after login success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => createMockResponse({
      success: true,
      data: {
        token: 'session-token',
        user: { id: 'user-1', email: 'admin@example.com' },
        features: { attendance: true, workflow: true, mode: 'platform' },
      },
    })))

    const { container, unmount } = mountLoginView()
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement
    emailInput.value = 'admin@example.com'
    passwordInput.value = 'test-password'
    emailInput.dispatchEvent(new Event('input'))
    passwordInput.dispatchEvent(new Event('input'))

    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    await nextTick()

    expect(setTokenMock).toHaveBeenCalledWith('session-token')
    expect(primeSessionMock).toHaveBeenCalledWith({
      success: true,
      data: {
        user: {
          id: 'user-1',
          email: 'admin@example.com',
        },
        features: {
          attendance: true,
          workflow: true,
          mode: 'platform',
        },
      },
    })
    expect(loadProductFeaturesMock).toHaveBeenCalledWith(true)
    expect(replaceMock).toHaveBeenCalledWith('/settings')
    unmount()
  })

  it('hides DingTalk button when launch probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/dingtalk/launch')) {
        return createMockResponse({ success: false, error: 'not configured' }, 503, false)
      }
      return createMockResponse({})
    }))

    const { container, unmount } = mountLoginView()
    await flushPromises()
    await nextTick()

    const dingtalkBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('钉钉登录'),
    )
    expect(dingtalkBtn).toBeUndefined()
    unmount()
  })

  it('shows DingTalk button when launch probe succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/dingtalk/launch')) {
        return createMockResponse({ success: true, data: { url: 'https://dingtalk.com/auth', state: 'test' } })
      }
      return createMockResponse({})
    }))

    const { container, unmount } = mountLoginView()
    await flushPromises()
    await nextTick()

    const dingtalkBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('钉钉登录'),
    )
    expect(dingtalkBtn).toBeDefined()
    unmount()
  })
})
