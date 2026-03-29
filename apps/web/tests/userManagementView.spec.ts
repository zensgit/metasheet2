import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'
import * as apiModule from '../src/utils/api'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasAdminAccess: () => true,
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

function mountUserManagement() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(UserManagementView)
  app.component('router-link', {
    props: ['to'],
    template: '<a><slot /></a>',
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

const userId = 'user-1'
const encodedUserId = encodeURIComponent(userId)

function setupApiMocks({
  sessionResponses,
  revokeSingleSessionResponse = createMockResponse({ error: '踢下线失败' }, 500, false),
  revokeAllSessionsResponse = createMockResponse({ error: '全部下线失败' }, 500, false),
}: {
  sessionResponses: Response[]
  revokeSingleSessionResponse?: Response
  revokeAllSessionsResponse?: Response
}) {
  let sessionCallCount = 0
  vi.mocked(apiModule.apiFetch).mockImplementation((url: string) => {
    if (url === '/api/admin/roles') {
      return Promise.resolve(createMockResponse({ ok: true, data: { items: [] } }))
    }

    if (url === '/api/admin/users') {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          data: {
            items: [{
              id: userId,
              email: 'admin@example.com',
              name: 'Admin',
              role: 'admin',
              is_active: true,
              is_admin: true,
              last_login_at: null,
              created_at: '2026-03-01T00:00:00.000Z',
            }],
          },
        }),
      )
    }

    if (url.startsWith('/api/admin/access-presets')) {
      return Promise.resolve(createMockResponse({ ok: true, data: { items: [] } }))
    }

    if (url.startsWith('/api/admin/invites')) {
      return Promise.resolve(createMockResponse({ ok: true, data: { items: [] } }))
    }

    if (url === `/api/admin/users/${encodedUserId}/access`) {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          data: {
            user: {
              id: userId,
              email: 'admin@example.com',
              name: 'Admin',
              role: 'admin',
              is_active: true,
              is_admin: true,
              last_login_at: null,
              created_at: '2026-03-01T00:00:00.000Z',
            },
            roles: ['admin'],
            permissions: ['admin'],
            isAdmin: true,
            dingtalkAuthEnabled: false,
          },
        }),
      )
    }

    if (url === `/api/admin/users/${encodedUserId}/dingtalk-auth`) {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          data: {
            user: {
              id: userId,
              email: 'admin@example.com',
              name: 'Admin',
              role: 'admin',
              is_active: true,
              is_admin: true,
              last_login_at: null,
              created_at: '2026-03-01T00:00:00.000Z',
            },
            roles: ['admin'],
            permissions: ['admin'],
            isAdmin: true,
            dingtalkAuthEnabled: true,
          },
        }),
      )
    }

    if (url === `/api/admin/users/${encodedUserId}/sessions`) {
      const nextResponse = sessionResponses[sessionCallCount] ?? sessionResponses[sessionResponses.length - 1]
      sessionCallCount += 1
      return Promise.resolve(nextResponse)
    }

    if (url === `/api/admin/users/${encodedUserId}/revoke-sessions`) {
      return Promise.resolve(revokeAllSessionsResponse)
    }

    if (url.includes(`/api/admin/users/${encodedUserId}/sessions/`) && url.endsWith('/revoke')) {
      return Promise.resolve(revokeSingleSessionResponse)
    }

    return Promise.reject(new Error(`Unexpected apiFetch call: ${url}`))
  })
}

const sampleSession = {
  id: 'sess-1',
  userId,
  issuedAt: '2026-03-12T00:00:00.000Z',
  expiresAt: '2026-03-13T00:00:00.000Z',
  lastSeenAt: '2026-03-12T08:00:00.000Z',
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  ipAddress: '127.0.0.1',
  userAgent: 'Vitest',
  createdAt: '2026-03-12T00:00:00.000Z',
  updatedAt: '2026-03-12T08:00:00.000Z',
}

describe('UserManagementView', () => {
  beforeEach(() => {
    vi.mocked(apiModule.apiFetch).mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('filters malformed sessions returned by admin sessions endpoint', async () => {
    setupApiMocks({
      sessionResponses: [
        createMockResponse({
          ok: true,
          data: {
            items: [
              sampleSession,
              null,
              'invalid',
              123,
              {},
              { id: '   ', userId, issuedAt: '2026-03-12T00:00:00.000Z', expiresAt: '2026-03-13T00:00:00.000Z', lastSeenAt: '2026-03-12T08:00:00.000Z', revokedAt: null, revokedBy: null, revokeReason: null, ipAddress: null, userAgent: null, createdAt: '2026-03-12T00:00:00.000Z', updatedAt: '2026-03-12T08:00:00.000Z' },
            ],
          },
        }),
      ],
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const sessionCards = container.querySelectorAll('.user-admin__section .user-admin__role-card')
    expect(sessionCards.length).toBe(1)
    expect(sessionCards[0]?.textContent).toContain('sess-1')
    unmount()
  })

  it('uses nested data error when revoking a single session fails', async () => {
    setupApiMocks({
      sessionResponses: [
        createMockResponse({
          ok: true,
          data: { items: [sampleSession] },
        }),
      ],
      revokeSingleSessionResponse: createMockResponse(
        { data: { error: 'nested session revoke blocked' } },
        500,
        false,
      ),
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('踢下线'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.user-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('nested session revoke blocked')
    unmount()
  })

  it('calls encoded admin sessions revoke endpoint for special session ids', async () => {
    const specialSessionId = 'special id/with space'
    const successSession = {
      ...sampleSession,
      id: specialSessionId,
      ipAddress: '127.0.0.2',
      userAgent: 'Vitest-Special',
    }

    setupApiMocks({
      sessionResponses: [
        createMockResponse({
          ok: true,
          data: { items: [successSession] },
        }),
        createMockResponse({
          ok: true,
          data: { items: [] },
        }),
      ],
      revokeSingleSessionResponse: createMockResponse({
        ok: true,
        data: { revokedAt: '2026-03-12T08:30:00.000Z' },
      }),
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('踢下线'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(specialSessionId)}/revoke`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin-console-force-single-session-logout' }),
      },
    )
    unmount()
  })

  it('shows nested data error when loading sessions fails', async () => {
    setupApiMocks({
      sessionResponses: [
        createMockResponse(
          { data: { error: 'load sessions blocked' } },
          500,
          false,
        ),
      ],
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.user-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('load sessions blocked')
    unmount()
  })

  it('uses nested data error when revoking all sessions fails', async () => {
    setupApiMocks({
      sessionResponses: [
        createMockResponse({
          ok: true,
          data: { items: [sampleSession] },
        }),
      ],
      revokeAllSessionsResponse: createMockResponse(
        { data: { error: 'nested bulk revoke denied' } },
        500,
        false,
      ),
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeAllButton = buttons.find((button) => button.textContent?.includes('全部下线'))
    expect(revokeAllButton).toBeDefined()
    revokeAllButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.user-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('nested bulk revoke denied')
    unmount()
  })

  it('calls admin revoke-all sessions endpoint', async () => {
    setupApiMocks({
      sessionResponses: [
        createMockResponse({
          ok: true,
          data: { items: [sampleSession] },
        }),
        createMockResponse({
          ok: true,
          data: { items: [sampleSession] },
        }),
      ],
      revokeAllSessionsResponse: createMockResponse({
        ok: true,
        data: { revokedAfter: '2026-03-12T09:00:00.000Z' },
      }),
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeAllButton = buttons.find((button) => button.textContent?.includes('全部下线'))
    expect(revokeAllButton).toBeDefined()
    revokeAllButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/users/${encodedUserId}/revoke-sessions`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'admin-console-force-logout' }),
      },
    )

    const status = container.querySelector('.user-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('该用户会话已失效')
    unmount()
  })

  it('shows top-level error message when loading users fails', async () => {
    vi.mocked(apiModule.apiFetch).mockImplementation((url: string) => {
      if (url === '/api/admin/roles') {
        return Promise.resolve(createMockResponse({ ok: true, data: { items: [] } }))
      }

      if (url.startsWith('/api/admin/access-presets')) {
        return Promise.resolve(createMockResponse({ ok: true, data: { items: [] } }))
      }

      if (url.startsWith('/api/admin/invites')) {
        return Promise.resolve(createMockResponse({ ok: true, data: { items: [] } }))
      }

      if (url === '/api/admin/users') {
        return Promise.resolve(createMockResponse({ error: { message: 'users load blocked' } }, 500, false))
      }

      return Promise.reject(new Error(`Unexpected apiFetch call: ${url}`))
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.user-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('users load blocked')
    unmount()
  })

  it('authorizes DingTalk login for the selected user', async () => {
    setupApiMocks({
      sessionResponses: [
        createMockResponse({
          ok: true,
          data: { items: [] },
        }),
      ],
    })

    const { container, unmount } = mountUserManagement()
    await flushPromises()
    await nextTick()

    const authorizeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('授权钉钉登录'))
    expect(authorizeButton).toBeDefined()
    authorizeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenCalledWith(
      `/api/admin/users/${encodedUserId}/dingtalk-auth`,
      {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      },
    )

    const status = container.querySelector('.user-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('已授权该账号绑定并使用钉钉登录')
    unmount()
  })
})
