import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'

const socketHandlers = new Map<string, (payload?: unknown) => void>()
const disconnectSpy = vi.fn()
const ioSpy = vi.fn(() => ({
  on: (event: string, handler: (payload?: unknown) => void) => {
    socketHandlers.set(event, handler)
  },
  disconnect: disconnectSpy,
}))

vi.mock('socket.io-client', () => ({
  io: ioSpy,
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('approval-user-1'),
  }),
}))

describe('useApprovalCountsRealtime', () => {
  let app: VueApp<Element> | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = null
    host = null
    socketHandlers.clear()
    ioSpy.mockClear()
    disconnectSpy.mockClear()
  })

  it('subscribes to approval:counts-updated and normalizes scoped counts', async () => {
    const received = vi.fn()
    const { useApprovalCountsRealtime } = await import('../src/approvals/useApprovalCountsRealtime')
    let reconnect: (() => Promise<unknown>) | null = null
    const Component = defineComponent({
      setup() {
        reconnect = useApprovalCountsRealtime({ onCountsUpdated: received }).reconnect
        return () => h('div')
      },
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(Component)
    app.mount(host)
    await nextTick()
    await reconnect?.()

    expect(ioSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      path: '/socket.io',
      query: { userId: 'approval-user-1' },
    }))

    socketHandlers.get('approval:counts-updated')?.({
      count: 5,
      unreadCount: 3,
      countsBySourceSystem: {
        all: { count: 5, unreadCount: 3 },
        platform: { count: 2, unreadCount: 1 },
        plm: { count: 3, unreadCount: 2 },
      },
      reason: 'mark-read',
    })

    expect(received).toHaveBeenCalledWith(expect.objectContaining({
      count: 5,
      unreadCount: 3,
      countsBySourceSystem: expect.objectContaining({
        platform: { count: 2, unreadCount: 1 },
      }),
      reason: 'mark-read',
    }))
  })
})
