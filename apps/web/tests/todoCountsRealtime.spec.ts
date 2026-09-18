import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'

// Exercises the REAL `useTodoCountsRealtime` normalizer (mirrors
// `approvalCountsRealtime.spec.ts`'s structure for its sibling composable) — the badge's own spec
// (`approvalNavTodoBadge.spec.ts`) mocks this module entirely, so without this file the
// malformed-push handling (`normalizePayload`/`normalizeSources` returning `null`) would run under
// no test at all.

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
    getToken: vi.fn().mockReturnValue('jwt-token'),
  }),
}))

describe('useTodoCountsRealtime', () => {
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

  async function mountAndSubscribe(received: (payload: unknown) => void) {
    const { useTodoCountsRealtime } = await import('../src/todo/useTodoCountsRealtime')
    let reconnect: (() => Promise<unknown>) | null = null
    const Component = defineComponent({
      setup() {
        reconnect = useTodoCountsRealtime({ onCountsUpdated: received }).reconnect
        return () => h('div')
      },
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(Component)
    app.mount(host)
    await nextTick()
    await reconnect?.()
  }

  it('subscribes to todo:counts-updated and normalizes a well-formed push', async () => {
    const received = vi.fn()
    await mountAndSubscribe(received)

    expect(ioSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      path: '/socket.io',
      auth: { token: 'jwt-token' },
    }))

    socketHandlers.get('todo:counts-updated')?.({
      count: 5,
      sources: { approval: 'ok' },
      reason: 'approval-decision',
      updatedAt: '2026-09-18T00:00:00.000Z',
    })

    expect(received).toHaveBeenCalledWith({
      count: 5,
      sources: { approval: 'ok' },
      degraded: false,
      reason: 'approval-decision',
      updatedAt: '2026-09-18T00:00:00.000Z',
    })
  })

  it('drops a push with a non-numeric count rather than guessing', async () => {
    const received = vi.fn()
    await mountAndSubscribe(received)

    socketHandlers.get('todo:counts-updated')?.({ count: 'five', sources: { approval: 'ok' } })

    expect(received).not.toHaveBeenCalled()
  })

  it('drops a push missing `sources` rather than treating it as all-ok', async () => {
    const received = vi.fn()
    await mountAndSubscribe(received)

    socketHandlers.get('todo:counts-updated')?.({ count: 5 })

    expect(received).not.toHaveBeenCalled()
  })

  it('drops a push whose sources map carries an unrecognized status', async () => {
    const received = vi.fn()
    await mountAndSubscribe(received)

    socketHandlers.get('todo:counts-updated')?.({ count: 5, sources: { approval: 'stale' } })

    expect(received).not.toHaveBeenCalled()
  })

  it('drops a non-object push outright', async () => {
    const received = vi.fn()
    await mountAndSubscribe(received)

    socketHandlers.get('todo:counts-updated')?.(null)
    socketHandlers.get('todo:counts-updated')?.('not an object')

    expect(received).not.toHaveBeenCalled()
  })
})
