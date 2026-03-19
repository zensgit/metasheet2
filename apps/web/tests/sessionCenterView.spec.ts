import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import SessionCenterView from '../src/views/SessionCenterView.vue'
import * as apiModule from '../src/utils/api'

const replaceMock = vi.fn(async () => undefined)
const clearTokenMock = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getAccessSnapshot: () => ({ user: { email: 'admin@example.com' } }),
    clearToken: clearTokenMock,
  }),
}))

vi.mock('../src/utils/api', () => {
  return {
    apiFetch: vi.fn(),
  }
})

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

function mountSessionCenter() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(SessionCenterView)
  app.mount(container)
  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

describe('SessionCenterView', () => {
  beforeEach(() => {
    clearTokenMock.mockClear()
    replaceMock.mockClear()
    vi.mocked(apiModule.apiFetch).mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders empty state when no sessions are returned', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({
        ok: true,
        data: { currentSessionId: null, items: [] },
      }),
    )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const emptyState = container.querySelector('.session-center__empty')
    expect(emptyState).not.toBeNull()
    expect(emptyState?.textContent).toContain('当前没有可展示的会话记录。')
    unmount()
  })

  it('shows error message when sessions load fails', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({ error: 'Session load failed' }, 500, false),
    )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('Session load failed')
    unmount()
  })

  it('uses nested list error message when payload.data.error is provided', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({ data: { error: 'Session list blocked' } }, 500, false),
    )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('Session list blocked')
    unmount()
  })

  it('uses top-level message when payload.error is an object with message', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({ error: { message: 'Top-level object message' } }, 500, false),
    )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('Top-level object message')
    unmount()
  })

  it('redirects to login when sessions load returns 401', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({ error: 'token expired' }, 401, false),
    )

    const { unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    expect(clearTokenMock).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/settings' },
    })
    unmount()
  })

  it('displays revoke failure when ending a session fails', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: null,
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ error: 'Session end failed' }, 500, false),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('结束此会话'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('Session end failed')
    unmount()
  })

  it('redirects when current session is revoked', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ ok: true, data: { sessionId: 'sess-1' } }),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('退出当前会话'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(replaceMock).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/settings' },
    })
    unmount()
  })

  it('syncs current session when user clicks current-device sync button', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            sessionId: 'sess-1',
            session: {
              id: 'sess-1',
              userId: 'user-1',
              issuedAt: '2026-03-12T00:00:00.000Z',
              expiresAt: '2026-03-13T00:00:00.000Z',
              lastSeenAt: '2026-03-12T08:30:00.000Z',
              revokedAt: null,
              revokedBy: null,
              revokeReason: null,
              ipAddress: '127.0.0.1',
              userAgent: 'Vitest 2.0',
              createdAt: '2026-03-12T00:00:00.000Z',
              updatedAt: '2026-03-12T08:30:00.000Z',
            },
          },
        }),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const pingButton = buttons.find((button) => button.textContent?.includes('同步当前设备'))
    expect(pingButton).toBeDefined()
    pingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('当前设备已同步')
    unmount()
  })

  it('redirects to login when current-session sync returns 401', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ error: 'invalid token' }, 401, false),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const pingButton = buttons.find((button) => button.textContent?.includes('同步当前设备'))
    expect(pingButton).toBeDefined()
    pingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(clearTokenMock).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/settings' },
    })
    unmount()
  })

  it('uses nested error message when sync current session fails', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ data: { error: 'nested heartbeat error' } }, 400, false),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const pingButton = buttons.find((button) => button.textContent?.includes('同步当前设备'))
    expect(pingButton).toBeDefined()
    pingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('nested heartbeat error')
    unmount()
  })

  it('calls others logout and refreshes session list', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [
              {
                id: 'sess-1',
                userId: 'user-1',
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
              },
              {
                id: 'sess-2',
                userId: 'user-1',
                issuedAt: '2026-03-12T00:00:00.000Z',
                expiresAt: '2026-03-13T00:00:00.000Z',
                lastSeenAt: '2026-03-12T07:00:00.000Z',
                revokedAt: null,
                revokedBy: null,
                revokeReason: null,
                ipAddress: '127.0.0.2',
                userAgent: 'Vitest-2',
                createdAt: '2026-03-12T00:00:00.000Z',
                updatedAt: '2026-03-12T07:00:00.000Z',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: { revokedCount: 1 },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeOthersButton = buttons.find((button) => button.textContent?.includes('退出其他会话'))
    expect(revokeOthersButton).toBeDefined()
    revokeOthersButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenNthCalledWith(
      2,
      '/api/auth/sessions/others/logout',
      { method: 'POST' },
    )
    unmount()
  })

  it('uses nested error message when revoking other sessions fails with payload.data.error', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ data: { error: 'nested others revoke failed' } }, 500, false),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeOthersButton = buttons.find((button) => button.textContent?.includes('退出其他会话'))
    expect(revokeOthersButton).toBeDefined()
    revokeOthersButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('nested others revoke failed')
    unmount()
  })

  it('logs out a non-current session and refreshes the list', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [
              {
                id: 'sess-1',
                userId: 'user-1',
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
              },
              {
                id: 'sess-2',
                userId: 'user-1',
                issuedAt: '2026-03-12T00:00:00.000Z',
                expiresAt: '2026-03-13T00:00:00.000Z',
                lastSeenAt: '2026-03-12T07:00:00.000Z',
                revokedAt: null,
                revokedBy: null,
                revokeReason: null,
                ipAddress: '127.0.0.2',
                userAgent: 'Vitest-2',
                createdAt: '2026-03-12T00:00:00.000Z',
                updatedAt: '2026-03-12T07:00:00.000Z',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: { sessionId: 'sess-2' },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('结束此会话'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenNthCalledWith(
      2,
      '/api/auth/sessions/sess-2/logout',
      { method: 'POST' },
    )
    expect(clearTokenMock).not.toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
    unmount()
  })

  it('filters out malformed session records when loading sessions', async () => {
    vi.mocked(apiModule.apiFetch).mockResolvedValueOnce(
      createMockResponse({
        ok: true,
        data: {
          currentSessionId: 'sess-1',
          items: [
            {
              id: 'sess-1',
              userId: 'user-1',
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
            },
            null,
            { id: 0 },
            {},
            'invalid',
            123,
          ],
        },
      }),
    )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('已同步 1 条会话记录')
    expect(container.querySelectorAll('.session-center__card').length).toBe(1)
    const firstCard = container.querySelector('.session-center__card')
    expect(firstCard?.textContent).toContain('sess-1')
    unmount()
  })

  it('calls encoded endpoint when non-current session id contains reserved characters', async () => {
    const specialSessionId = 'sess with space/2'

    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [
              {
                id: 'sess-1',
                userId: 'user-1',
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
              },
              {
                id: specialSessionId,
                userId: 'user-1',
                issuedAt: '2026-03-12T00:00:00.000Z',
                expiresAt: '2026-03-13T00:00:00.000Z',
                lastSeenAt: '2026-03-12T07:00:00.000Z',
                revokedAt: null,
                revokedBy: null,
                revokeReason: null,
                ipAddress: '127.0.0.2',
                userAgent: 'Vitest-2',
                createdAt: '2026-03-12T00:00:00.000Z',
                updatedAt: '2026-03-12T07:00:00.000Z',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: { sessionId: specialSessionId },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('结束此会话'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(vi.mocked(apiModule.apiFetch)).toHaveBeenNthCalledWith(
      2,
      `/api/auth/sessions/${encodeURIComponent(specialSessionId)}/logout`,
      { method: 'POST' },
    )
    unmount()
  })

  it('uses nested error message from payload.data.error when available', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-2',
              userId: 'user-1',
              issuedAt: '2026-03-12T00:00:00.000Z',
              expiresAt: '2026-03-13T00:00:00.000Z',
              lastSeenAt: '2026-03-12T08:00:00.000Z',
              revokedAt: null,
              revokedBy: null,
              revokeReason: null,
              ipAddress: '127.0.0.2',
              userAgent: 'Vitest-2',
              createdAt: '2026-03-12T00:00:00.000Z',
              updatedAt: '2026-03-12T08:00:00.000Z',
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse(
          { data: { error: 'nested revoke denied' } },
          400,
          false,
        ),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('结束此会话'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.session-center__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('nested revoke denied')
    unmount()
  })

  it('redirects to login when non-current session logout returns 401', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [
              {
                id: 'sess-1',
                userId: 'user-1',
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
              },
              {
                id: 'sess-2',
                userId: 'user-1',
                issuedAt: '2026-03-12T00:00:00.000Z',
                expiresAt: '2026-03-13T00:00:00.000Z',
                lastSeenAt: '2026-03-12T07:00:00.000Z',
                revokedAt: null,
                revokedBy: null,
                revokeReason: null,
                ipAddress: '127.0.0.2',
                userAgent: 'Vitest-2',
                createdAt: '2026-03-12T00:00:00.000Z',
                updatedAt: '2026-03-12T07:00:00.000Z',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ error: 'invalid token' }, 401, false),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeButton = buttons.find((button) => button.textContent?.includes('结束此会话'))
    expect(revokeButton).toBeDefined()
    revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(clearTokenMock).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/settings' },
    })
    unmount()
  })

  it('redirects to login when revoking others returns 401', async () => {
    vi.mocked(apiModule.apiFetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          data: {
            currentSessionId: 'sess-1',
            items: [{
              id: 'sess-1',
              userId: 'user-1',
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
            }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ error: 'invalid token' }, 401, false),
      )

    const { container, unmount } = mountSessionCenter()
    await flushPromises()
    await nextTick()

    const buttons = Array.from(container.querySelectorAll('button'))
    const revokeOthersButton = buttons.find((button) => button.textContent?.includes('退出其他会话'))
    expect(revokeOthersButton).toBeDefined()
    revokeOthersButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(clearTokenMock).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith({
      name: 'login',
      query: { redirect: '/settings' },
    })
    unmount()
  })
})
