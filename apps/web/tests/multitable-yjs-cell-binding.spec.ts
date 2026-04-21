import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import type { Ref } from 'vue'

// Socket.IO mock: records every `io()` call and hands out a fake socket
// whose lifecycle we drive from the tests.
type Handler = (...args: any[]) => void
const handlers = new Map<string, Handler>()
const emitMock = vi.fn()
const disconnectMock = vi.fn()
const ioMock = vi.fn(() => ({
  connected: true,
  on: (event: string, handler: Handler) => {
    handlers.set(event, handler)
  },
  emit: emitMock,
  disconnect: disconnectMock,
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: vi.fn(() => 'jwt-token'),
    getCurrentUserId: vi.fn().mockResolvedValue('user_self'),
  }),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function loadBinding() {
  // Dynamic import so each test picks up the current stubbed env.
  return import('../src/multitable/composables/useYjsCellBinding')
}

describe('useYjsCellBinding', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    handlers.clear()
    emitMock.mockReset()
    disconnectMock.mockReset()
    ioMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.useRealTimers()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.unstubAllEnvs()
    vi.useRealTimers()
    vi.resetModules()
  })

  it('is inert when VITE_ENABLE_YJS_COLLAB is not "true" (flag off)', async () => {
    vi.stubEnv('VITE_ENABLE_YJS_COLLAB', '')
    vi.resetModules()
    const { useYjsCellBinding } = await loadBinding()

    const onFallback = vi.fn()
    let activeRef: Ref<boolean> | null = null
    let setText: (n: string) => void = () => {}

    app = createApp(defineComponent({
      setup() {
        const binding = useYjsCellBinding({
          recordId: ref('rec_1'),
          fieldId: ref('fld_title'),
          onFallback,
        })
        activeRef = binding.active
        setText = binding.setText
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi()

    // Discriminating assertion: no Socket.IO client was constructed.
    expect(ioMock).not.toHaveBeenCalled()
    expect(activeRef?.value).toBe(false)
    // fallback 'disabled' is the single contract signal.
    expect(onFallback).toHaveBeenCalledWith('disabled')
    expect(onFallback).toHaveBeenCalledTimes(1)

    // setText is a safe no-op when flag off.
    expect(() => setText('hello')).not.toThrow()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('is inert when VITE_ENABLE_YJS_COLLAB is "1" (not exactly "true")', async () => {
    vi.stubEnv('VITE_ENABLE_YJS_COLLAB', '1')
    vi.resetModules()
    const { useYjsCellBinding } = await loadBinding()

    app = createApp(defineComponent({
      setup() {
        useYjsCellBinding({
          recordId: ref('rec_1'),
          fieldId: ref('fld_title'),
        })
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi()

    expect(ioMock).not.toHaveBeenCalled()
  })

  it('drives Y.Text when flag is on and the sync handshake completes', async () => {
    vi.stubEnv('VITE_ENABLE_YJS_COLLAB', 'true')
    vi.resetModules()
    const { useYjsCellBinding } = await loadBinding()

    let activeRef: Ref<boolean> | null = null
    let textRef: Ref<string> | null = null
    let setText: (n: string) => void = () => {}

    app = createApp(defineComponent({
      setup() {
        const binding = useYjsCellBinding({
          recordId: ref('rec_1'),
          fieldId: ref('fld_title'),
          // Long enough that the test never trips the timeout.
          connectTimeoutMs: 10_000,
        })
        activeRef = binding.active
        textRef = binding.text
        setText = binding.setText
        return () => h('div')
      },
    }))
    app.mount(container!)
    await flushUi()

    // io() was called, socket subscribe sent.
    expect(ioMock).toHaveBeenCalledTimes(1)
    handlers.get('connect')?.()
    await flushUi()
    expect(emitMock).toHaveBeenCalledWith('yjs:subscribe', { recordId: 'rec_1' })

    // Simulate a sync-protocol message: useYjsDocument uses real
    // y-protocols readSyncMessage, so we need a well-formed envelope. We
    // send a SyncStep2 carrying a primer Y.Doc update that already
    // contains a Y.Text for 'fld_title' — matching what the backend
    // YjsSyncService does by seeding from meta_records.data. Without
    // this, useYjsTextField's seed guard would keep yjsActive=false
    // (no auto-create of empty Y.Text).
    const encodingModule = await import('lib0/encoding')
    const Y = await import('yjs')
    const primerDoc = new Y.Doc()
    const seededText = new Y.Text()
    seededText.insert(0, '')
    primerDoc.getMap('fields').set('fld_title', seededText)
    const primerUpdate = Y.encodeStateAsUpdate(primerDoc)
    primerDoc.destroy()
    const encoder = encodingModule.createEncoder()
    encodingModule.writeVarUint(encoder, 0) // MSG_SYNC (outer envelope in useYjsDocument)
    encodingModule.writeVarUint(encoder, 1) // messageYjsSyncStep2 (y-protocols)
    encodingModule.writeVarUint8Array(encoder, primerUpdate)
    const payload = encodingModule.toUint8Array(encoder)
    handlers.get('yjs:message')?.({ recordId: 'rec_1', data: Array.from(payload) })
    await flushUi()

    expect(activeRef?.value).toBe(true)

    // Writing via setText should fire a yjs:update emit (Y.Doc 'update' path).
    setText('hello')
    await flushUi()
    const emittedEvents = emitMock.mock.calls.map((call) => call[0])
    expect(emittedEvents).toContain('yjs:update')
    const updateCall = emitMock.mock.calls.find((call) => call[0] === 'yjs:update')
    expect(updateCall?.[1]).toMatchObject({ recordId: 'rec_1' })
    expect(Array.isArray(updateCall?.[1].data)).toBe(true)

    // text mirrors the Y.Text content.
    expect(textRef?.value).toBe('hello')
  })

  it('falls back to REST when the connection times out', async () => {
    vi.stubEnv('VITE_ENABLE_YJS_COLLAB', 'true')
    vi.resetModules()
    vi.useFakeTimers()
    const { useYjsCellBinding } = await loadBinding()

    const onFallback = vi.fn()
    let activeRef: Ref<boolean> | null = null
    let setText: (n: string) => void = () => {}

    app = createApp(defineComponent({
      setup() {
        const binding = useYjsCellBinding({
          recordId: ref('rec_1'),
          fieldId: ref('fld_title'),
          connectTimeoutMs: 100,
          onFallback,
        })
        activeRef = binding.active
        setText = binding.setText
        return () => h('div')
      },
    }))
    app.mount(container!)
    // Flush the initial watcher without advancing the fake timer.
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
    await nextTick()

    expect(ioMock).toHaveBeenCalledTimes(1)
    // Intentionally do NOT fire `connect` / `yjs:message`.

    // Advance timers past the timeout → fallback fires.
    vi.advanceTimersByTime(200)
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
    await nextTick()

    expect(onFallback).toHaveBeenCalledWith('timeout')
    expect(activeRef?.value).toBe(false)
    // disconnect was invoked as part of tearing down the stale socket.
    expect(disconnectMock).toHaveBeenCalled()

    // After fallback, setText is a no-op (nothing emitted via socket).
    const emitCountBefore = emitMock.mock.calls.length
    setText('post-fallback')
    await Promise.resolve()
    await nextTick()
    expect(emitMock.mock.calls.length).toBe(emitCountBefore)
  })
})
