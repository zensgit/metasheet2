/**
 * P1 test: useYjsDocument's connect/disconnect generation guard.
 *
 * Reviewer finding on PR #960 (2026-04-20):
 *
 *   "在创建 doc/socket 前 await getCurrentUserId()，但 timeout fallback
 *    会在 useYjsCellBinding 触发并断开。await 返回后没有 stale guard，
 *    仍可能创建隐藏 socket/doc。"
 *
 * This test proves that if disconnect() runs while the pre-socket
 * `getCurrentUserId()` promise is still pending, the resolve path
 * aborts BEFORE the socket.io-client factory is called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, shallowRef, nextTick, type App } from 'vue'

const handlers = new Map<string, (...args: any[]) => void>()
const emitMock = vi.fn()
const disconnectMock = vi.fn()
const ioMock = vi.fn(() => ({
  connected: true,
  on: (event: string, handler: (...args: any[]) => void) => {
    handlers.set(event, handler)
  },
  emit: emitMock,
  disconnect: disconnectMock,
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

// Control the getCurrentUserId resolution manually per-test.
let pendingUserIdResolve: ((v: string | null) => void) | null = null
function primeUserIdPromise() {
  return new Promise<string | null>((resolve) => {
    pendingUserIdResolve = resolve
  })
}

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: vi.fn(() => 'jwt'),
    getCurrentUserId: vi.fn(() => primeUserIdPromise()),
  }),
}))

import { useYjsDocument } from '../src/multitable/composables/useYjsDocument'

describe('useYjsDocument stale-guard (P1)', () => {
  beforeEach(() => {
    handlers.clear()
    emitMock.mockClear()
    disconnectMock.mockClear()
    ioMock.mockClear()
    pendingUserIdResolve = null
  })

  it('disconnect before getCurrentUserId resolves must NOT create a socket', async () => {
    let apiRef: ReturnType<typeof useYjsDocument> | null = null
    const recordRef = shallowRef<string | null>('rec_1')
    const Comp = defineComponent({
      setup() {
        apiRef = useYjsDocument(recordRef as any)
        return () => h('div')
      },
    })
    const app = createApp(Comp)
    app.mount(document.createElement('div'))

    // useYjsDocument auto-connects on mount because recordId is set.
    // Give it a tick to start connect().
    await nextTick()

    // connect() is blocked at `await getCurrentUserId()`. Before the
    // promise resolves, the caller "disconnects" (simulates the
    // timeout fallback path).
    apiRef!.disconnect()

    // NOW resolve the user id. Without the guard, connect() would
    // proceed and call `io('/yjs', ...)`.
    pendingUserIdResolve!('user_self')
    await nextTick()
    await nextTick()

    // io() must NOT have been called — the stale-guard aborts.
    expect(ioMock).not.toHaveBeenCalled()
    expect(apiRef!.doc.value).toBeNull()
    expect(apiRef!.connected.value).toBe(false)

    app.unmount()
  })

  it('a fresh connect that starts AFTER disconnect still works normally', async () => {
    let apiRef: ReturnType<typeof useYjsDocument> | null = null
    const recordRef = shallowRef<string | null>('rec_1')
    const Comp = defineComponent({
      setup() {
        apiRef = useYjsDocument(recordRef as any)
        return () => h('div')
      },
    })
    const app = createApp(Comp)
    app.mount(document.createElement('div'))

    await nextTick()
    // First connect is mid-flight. Cancel it.
    apiRef!.disconnect()
    // Drain the original pending resolve so it bails.
    const firstResolve = pendingUserIdResolve!
    pendingUserIdResolve = null

    // Second connect (a normal user re-focus). Do NOT await — connect()
    // is blocked at its own `await getCurrentUserId()`, so the returned
    // promise only resolves after we resolve secondResolve below. The
    // call synchronously runs up to the inner await, which assigns
    // `pendingUserIdResolve` to the new resolve fn.
    void apiRef!.connect('rec_2')
    const secondResolve = pendingUserIdResolve!

    // Old first promise now resolves — must be ignored.
    firstResolve('stale_user')
    await nextTick()
    expect(ioMock).not.toHaveBeenCalled() // still nothing wired

    // New promise resolves — THIS one should cause the socket to open.
    secondResolve('user_self')
    // connect() awaits a promise wrapped in .catch — several microtask
    // hops are needed before the `socketIO(...)` call executes under
    // Vue's scheduler.
    for (let i = 0; i < 6; i += 1) await nextTick()
    expect(ioMock).toHaveBeenCalledTimes(1)

    app.unmount()
  })
})
