import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef, type App } from 'vue'

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

import { useYjsDocument } from '../src/multitable/composables/useYjsDocument'

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('useYjsDocument invalidation event', () => {
  let app: App<Element> | null = null

  beforeEach(() => {
    handlers.clear()
    emitMock.mockReset()
    disconnectMock.mockReset()
    ioMock.mockClear()
  })

  afterEach(() => {
    app?.unmount()
    app = null
  })

  function mountDocument(recordId = 'rec_1') {
    let apiRef: ReturnType<typeof useYjsDocument> | null = null
    const recordRef = shallowRef<string | null>(recordId)

    app = createApp(defineComponent({
      setup() {
        apiRef = useYjsDocument(recordRef as any)
        return () => h('div')
      },
    }))
    app.mount(document.createElement('div'))

    return {
      get api() {
        if (!apiRef) throw new Error('api not mounted')
        return apiRef
      },
      recordRef,
    }
  }

  it('disconnects the current Yjs document when the server invalidates its record', async () => {
    const { api } = mountDocument('rec_1')
    await flushUi()

    expect(ioMock).toHaveBeenCalledTimes(1)
    expect(api.doc.value).not.toBeNull()

    handlers.get('connect')?.()
    await flushUi()
    expect(api.connected.value).toBe(true)

    handlers.get('yjs:invalidated')?.({ recordId: 'rec_1', reason: 'rest-write' })
    await flushUi()

    expect(emitMock).toHaveBeenCalledWith('yjs:unsubscribe', { recordId: 'rec_1' })
    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(api.doc.value).toBeNull()
    expect(api.connected.value).toBe(false)
    expect(api.synced.value).toBe(false)
    expect(api.error.value).toBe('INVALIDATED: document invalidated by REST write')
  })

  it('ignores invalidation events for another record', async () => {
    const { api } = mountDocument('rec_1')
    await flushUi()

    handlers.get('connect')?.()
    await flushUi()

    handlers.get('yjs:invalidated')?.({ recordId: 'rec_other', reason: 'rest-write' })
    await flushUi()

    expect(disconnectMock).not.toHaveBeenCalled()
    expect(api.doc.value).not.toBeNull()
    expect(api.connected.value).toBe(true)
    expect(api.error.value).toBeNull()
  })

  it('ignores malformed invalidation payloads without throwing', async () => {
    const { api } = mountDocument('rec_1')
    await flushUi()

    handlers.get('connect')?.()
    await flushUi()

    const invalidatedHandler = handlers.get('yjs:invalidated')
    expect(() => invalidatedHandler?.(undefined)).not.toThrow()
    expect(() => invalidatedHandler?.('rec_1')).not.toThrow()
    expect(() => invalidatedHandler?.({ recordId: 123 })).not.toThrow()
    await flushUi()

    expect(disconnectMock).not.toHaveBeenCalled()
    expect(api.doc.value).not.toBeNull()
    expect(api.connected.value).toBe(true)
    expect(api.error.value).toBeNull()
  })

  it('requests server state after the server sync step and does not echo remote sync updates', async () => {
    const { api } = mountDocument('rec_1')
    await flushUi()

    handlers.get('connect')?.()
    await flushUi()
    expect(emitMock).toHaveBeenCalledWith('yjs:subscribe', { recordId: 'rec_1' })

    const Y = await import('yjs')
    const syncProtocol = await import('y-protocols/sync')
    const encodingModule = await import('lib0/encoding')

    const serverDoc = new Y.Doc()
    const fields = serverDoc.getMap('fields')
    const seededText = new Y.Text()
    seededText.insert(0, 'from-server')
    fields.set('fld_title', seededText)

    const step1Encoder = encodingModule.createEncoder()
    encodingModule.writeVarUint(step1Encoder, 0)
    syncProtocol.writeSyncStep1(step1Encoder, serverDoc)
    handlers.get('yjs:message')?.({
      recordId: 'rec_1',
      data: Array.from(encodingModule.toUint8Array(step1Encoder)),
    })
    await flushUi()

    const emittedMessages = emitMock.mock.calls.filter((call) => call[0] === 'yjs:message')
    expect(emittedMessages.length).toBeGreaterThanOrEqual(2)
    expect(emitMock.mock.calls.some((call) => call[0] === 'yjs:update')).toBe(false)

    const step2Encoder = encodingModule.createEncoder()
    encodingModule.writeVarUint(step2Encoder, 0)
    syncProtocol.writeSyncStep2(step2Encoder, serverDoc)
    handlers.get('yjs:message')?.({
      recordId: 'rec_1',
      data: Array.from(encodingModule.toUint8Array(step2Encoder)),
    })
    await flushUi()

    const clientText = api.doc.value?.getMap('fields').get('fld_title')
    expect(clientText).toBeInstanceOf(Y.Text)
    expect((clientText as { toString(): string }).toString()).toBe('from-server')
    expect(emitMock.mock.calls.some((call) => call[0] === 'yjs:update')).toBe(false)

    serverDoc.destroy()
  })
})
