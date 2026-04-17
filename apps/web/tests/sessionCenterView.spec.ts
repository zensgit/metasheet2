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

  it('starts DingTalk self-bind from settings', async () => {
    sessionStorage.clear()
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null)
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
            exists: false,
            enabled: false,
            grantedBy: null,
            createdAt: null,
            updatedAt: null,
          },
          identity: {
            exists: false,
            corpId: null,
            lastLoginAt: null,
            createdAt: null,
            updatedAt: null,
          },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        success: true,
        data: {
          mode: 'bind',
          url: 'https://login.dingtalk.test/oauth-bind',
          state: 'state-bind-1',
        },
      }))

    app = createApp(SessionCenterView)
    app.mount(container!)
    await flushUi()

    const bindButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('绑定钉钉账号'))
    expect(bindButton).toBeTruthy()
    bindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(apiFetchMock).toHaveBeenLastCalledWith(
      '/api/auth/dingtalk/launch?intent=bind&redirect=%2Fsettings%3Fdingtalk%3Dbound',
      expect.objectContaining({
        suppressUnauthorizedRedirect: true,
      }),
    )
    expect(sessionStorage.getItem('metasheet_dingtalk_intent_state-bind-1')).toBe('bind')
    expect(openMock).toHaveBeenCalledWith('https://login.dingtalk.test/oauth-bind', '_self')
    openMock.mockRestore()
    sessionStorage.clear()
  })

  it('allows a self-managed DingTalk identity to be unbound from settings', async () => {
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
            exists: false,
            corpId: null,
            lastLoginAt: null,
            createdAt: null,
            updatedAt: null,
          },
        },
      }))

    app = createApp(SessionCenterView)
    app.mount(container!)
    await flushUi()

    const unbindButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('解除当前绑定'))
    expect(unbindButton).toBeTruthy()
    unbindButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    expect(apiFetchMock).toHaveBeenLastCalledWith(
      '/api/auth/dingtalk/unbind',
      expect.objectContaining({
        method: 'POST',
        suppressUnauthorizedRedirect: true,
      }),
    )
    expect(container?.textContent).toContain('当前钉钉绑定已解除')
    expect(container?.textContent).toContain('绑定钉钉账号')
  })

  it('blocks self-unbind in settings when the identity is directory-managed', async () => {
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
            linked: true,
            linkedCount: 1,
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

    expect(container?.textContent).toContain('已关联 1 个目录成员')
    expect(container?.textContent).toContain('请联系平台管理员')
    const unbindButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('解除当前绑定'))
    expect(unbindButton?.hasAttribute('disabled')).toBe(true)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })
})
