import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import SessionCenterView from '../src/views/SessionCenterView.vue'

const apiFetchMock = vi.fn()
const clearTokenMock = vi.fn()
const replaceMock = vi.fn(() => Promise.resolve())

const routeState = {
  query: {} as Record<string, unknown>,
}

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    clearToken: clearTokenMock,
    getAccessSnapshot: () => ({
      email: 'manager@example.com',
    }),
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    replace: replaceMock,
  }),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

describe('SessionCenterView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    clearTokenMock.mockReset()
    replaceMock.mockReset()
    replaceMock.mockResolvedValue(undefined)
    routeState.query = {}
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('loads current-user DingTalk access status in settings', async () => {
    routeState.query = { dingtalk: 'bound' }
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        success: true,
        data: {
          items: [],
          currentSessionId: null,
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        success: true,
        data: {
          available: true,
          userId: 'user-1',
          provider: 'dingtalk',
          requireGrant: false,
          autoLinkEmail: false,
          autoProvision: false,
          directory: {
            linked: false,
            linkedCount: 0,
          },
          grant: {
            exists: true,
            enabled: true,
            grantedBy: 'admin-1',
            createdAt: '2026-04-11T12:00:00.000Z',
            updatedAt: '2026-04-11T12:00:00.000Z',
          },
          identity: {
            exists: true,
            corpId: 'dingcorp',
            lastLoginAt: '2026-04-11T12:00:00.000Z',
            createdAt: '2026-04-11T12:00:00.000Z',
            updatedAt: '2026-04-11T12:00:00.000Z',
          },
        },
      }))

    app = createApp(SessionCenterView)
    app.mount(container!)
    await flushUi()

    expect(apiFetchMock).toHaveBeenNthCalledWith(1, '/api/auth/sessions')
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/auth/dingtalk/access')
    expect(container?.textContent).toContain('钉钉登录')
    expect(container?.textContent).toContain('钉钉账号已绑定')
    expect(container?.textContent).toContain('已开通')
    expect(container?.textContent).toContain('dingcorp')
  })

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])('keeps identity=%s directory=%s read-only while allowing status refresh', async (identityExists, directoryLinked) => {
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null)
    const snapshot = {
      available: true,
      userId: 'user-1',
      provider: 'dingtalk',
      requireGrant: false,
      autoLinkEmail: false,
      autoProvision: false,
      directory: { linked: directoryLinked, linkedCount: directoryLinked ? 1 : 0 },
      grant: { exists: identityExists, enabled: identityExists, grantedBy: null, createdAt: null, updatedAt: null },
      identity: { exists: identityExists, corpId: null, lastLoginAt: null, createdAt: null, updatedAt: null },
    }
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({ success: true, data: { items: [], currentSessionId: null } }))
      .mockResolvedValue(createJsonResponse({ success: true, data: snapshot }))

    try {
      app = createApp(SessionCenterView)
      app.mount(container!)
      await flushUi()

      expect(container?.textContent).toContain('自行绑定和解绑未开放')
      expect(container?.textContent).toContain('请联系平台管理员核实可用办理方式')
      const buttons = Array.from(container?.querySelectorAll('button') ?? [])
      expect(buttons.some((button) => /绑定钉钉账号|解除当前绑定/.test(button.textContent ?? ''))).toBe(false)
      expect(apiFetchMock).toHaveBeenCalledTimes(2)
      expect(openMock).not.toHaveBeenCalled()

      const refreshButton = buttons.find((button) => button.textContent?.includes('刷新钉钉状态'))
      expect(refreshButton).toBeTruthy()
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushUi()

      expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
        '/api/auth/sessions',
        '/api/auth/dingtalk/access',
        '/api/auth/dingtalk/access',
      ])
      expect(openMock).not.toHaveBeenCalled()
    } finally {
      openMock.mockRestore()
    }
  })
})
