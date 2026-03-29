import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref } from 'vue'
import App from '../src/App.vue'

const clearTokenMock = vi.fn()
const buildAuthHeadersMock = vi.fn(() => ({ Authorization: 'Bearer session-token' }))
const getTokenMock = vi.fn(() => 'session-token')
const fetchPluginsMock = vi.fn(async () => undefined)
const loadProductFeaturesMock = vi.fn(async () => undefined)
const isAttendanceFocusedMock = vi.fn(() => true)
const hasFeatureMock = vi.fn(() => false)

const mockRoute = {
  meta: {},
  fullPath: '/attendance',
}

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getAccessSnapshot: () => ({
      user: {
        email: 'zen0888@live.com',
      },
    }),
    getToken: getTokenMock,
    buildAuthHeaders: buildAuthHeadersMock,
    clearToken: clearTokenMock,
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref('zh-CN'),
    isZh: ref(true),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    navItems: ref([]),
    fetchPlugins: fetchPluginsMock,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: loadProductFeaturesMock,
    isAttendanceFocused: isAttendanceFocusedMock,
    hasFeature: hasFeatureMock,
  }),
}))

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0)
  })
}

function mountApp() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(App)
  app.component('router-link', {
    props: ['to'],
    template: '<a><slot /></a>',
  })
  app.component('router-view', {
    template: '<div />',
  })
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

describe('App', () => {
  const originalFetch = globalThis.fetch
  const originalLocation = window.location

  beforeEach(() => {
    clearTokenMock.mockReset()
    buildAuthHeadersMock.mockReset().mockReturnValue({ Authorization: 'Bearer session-token' })
    getTokenMock.mockReset().mockReturnValue('session-token')
    fetchPluginsMock.mockReset().mockResolvedValue(undefined)
    loadProductFeaturesMock.mockReset().mockResolvedValue(undefined)
    isAttendanceFocusedMock.mockReset().mockReturnValue(true)
    hasFeatureMock.mockReset().mockReturnValue(false)
    mockRoute.meta = {}
    mockRoute.fullPath = '/attendance'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    globalThis.fetch = originalFetch
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('logs out the current user, clears local auth state, and redirects to login', async () => {
    const assignMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'http://142.171.239.56:8081',
        assign: assignMock,
      },
      writable: true,
      configurable: true,
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: true }),
    }) as unknown as typeof fetch

    const { container, unmount } = mountApp()
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('退出登录'))

    expect(button).toBeDefined()
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://142.171.239.56:8081/api/auth/logout',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
        },
      },
    )
    expect(clearTokenMock).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('/login?redirect=%2Fattendance')
    unmount()
  })

  it('shows the directory entry for platform admins in attendance-focused mode', async () => {
    hasFeatureMock.mockImplementation((feature: string) => feature === 'platformAdmin')

    const { container, unmount } = mountApp()

    expect(container.textContent).toContain('考勤')
    expect(container.textContent).toContain('目录同步')
    unmount()
  })
})
