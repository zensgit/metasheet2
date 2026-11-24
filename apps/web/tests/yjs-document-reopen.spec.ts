/**
 * Record editing after a refusal by the realtime server: a transient refusal reopens the record
 * from scratch (new connection, new document) with capped backoff and a bound on attempts; a final
 * one does not; a caller that closes the record cancels a reopen that is waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef, type App } from 'vue'

type Handler = (...args: any[]) => void

interface FakeSocket {
  active: boolean
  connected: boolean
  emit: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  on(event: string, handler: Handler): FakeSocket
  fire(event: string, ...args: unknown[]): void
}

const sockets: FakeSocket[] = []

vi.mock('socket.io-client', () => ({
  io: () => {
    const handlers = new Map<string, Handler[]>()
    const socket: FakeSocket = {
      active: false,
      connected: false,
      emit: vi.fn(),
      disconnect: vi.fn(),
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
        return socket
      },
      fire(event, ...args) {
        if (event === 'connect') socket.connected = true
        if (event === 'disconnect') socket.connected = false
        for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
      },
    }
    sockets.push(socket)
    return socket
  },
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: vi.fn(() => 'jwt-token'),
    getCurrentUserId: vi.fn().mockResolvedValue('user_self'),
  }),
}))

import { useYjsDocument } from '../src/multitable/composables/useYjsDocument'

const TRANSIENT = { code: 'REALTIME_UNAVAILABLE', retry: true }
const FINAL = { code: 'SESSION_NOT_CURRENT', retry: false }
const SERVER_CLOSE = 'io server disconnect'
const LONG = 31_000
const refusal = (data?: unknown) => Object.assign(new Error('refused'), data === undefined ? {} : { data })

let app: App<Element> | null = null

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
  await vi.advanceTimersByTimeAsync(0)
}

async function openRecord(recordId = 'rec_1') {
  const recordRef = shallowRef<string | null>(recordId)
  let api: ReturnType<typeof useYjsDocument> | null = null
  app = createApp(defineComponent({
    setup() {
      api = useYjsDocument(recordRef as never)
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  await flush()
  return { api: api as unknown as ReturnType<typeof useYjsDocument>, recordRef }
}

/** A first sync message of the server: an empty first step. */
const serverSyncStep1 = { recordId: 'rec_1', data: [0, 0, 1, 0] }

beforeEach(() => {
  vi.useFakeTimers()
  sockets.length = 0
})

afterEach(() => {
  app?.unmount()
  app = null
  vi.useRealTimers()
})

describe('record editing: a handshake the server refuses', () => {
  it('marked transient: the record is reopened after the backoff with a new connection and a new document, and no error is shown', async () => {
    const { api } = await openRecord()
    expect(sockets).toHaveLength(1)
    const firstDocument = api.doc.value
    sockets[0].fire('connect_error', refusal(TRANSIENT))
    expect(api.doc.value).toBeNull()
    expect(sockets[0].disconnect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(LONG)
    await flush()
    expect(sockets).toHaveLength(2)
    expect(api.doc.value).not.toBeNull()
    expect(api.doc.value).not.toBe(firstDocument)
    expect(api.error.value).toBeNull()
    sockets[1].fire('connect')
    expect(sockets[1].emit).toHaveBeenCalledWith('yjs:subscribe', { recordId: 'rec_1' })
    expect(api.connected.value).toBe(true)
  })

  it('marked final, or not marked at all: nothing is reopened', async () => {
    for (const error of [refusal(FINAL), refusal(), new Error('UNAUTHENTICATED: invalid token')]) {
      sockets.length = 0
      const { api } = await openRecord()
      sockets[0].fire('connect_error', error)
      await vi.advanceTimersByTimeAsync(LONG * 4)
      await flush()
      expect(sockets).toHaveLength(1)
      expect(api.doc.value).not.toBeNull()
      app?.unmount()
      app = null
    }
  })

  it('still being retried by the transport library: nothing is done here', async () => {
    await openRecord()
    sockets[0].active = true
    sockets[0].fire('connect_error', refusal(TRANSIENT))
    await vi.advanceTimersByTimeAsync(LONG * 4)
    await flush()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].disconnect).not.toHaveBeenCalled()
  })
})

describe('record editing: the server closes an open connection', () => {
  it('as transient: the record is reopened; as final: it is not', async () => {
    const { api } = await openRecord()
    sockets[0].fire('connect')
    sockets[0].fire('yjs:message', serverSyncStep1)
    expect(api.synced.value).toBe(true)
    sockets[0].fire('realtime:session-ended', TRANSIENT)
    sockets[0].fire('disconnect', SERVER_CLOSE)
    expect(api.connected.value).toBe(false)
    await vi.advanceTimersByTimeAsync(LONG)
    await flush()
    expect(sockets).toHaveLength(2)

    sockets[1].fire('connect')
    sockets[1].fire('realtime:session-ended', FINAL)
    sockets[1].fire('disconnect', SERVER_CLOSE)
    await vi.advanceTimersByTimeAsync(LONG * 4)
    await flush()
    expect(sockets).toHaveLength(2)
    expect(api.connected.value).toBe(false)
  })

  it('a network failure is left to the transport library', async () => {
    await openRecord()
    sockets[0].fire('connect')
    for (const reason of ['transport close', 'transport error', 'ping timeout']) sockets[0].fire('disconnect', reason)
    await vi.advanceTimersByTimeAsync(LONG * 4)
    await flush()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].disconnect).not.toHaveBeenCalled()
  })
})

describe('record editing: a reopen that is waiting', () => {
  it('is cancelled when the caller closes the record', async () => {
    const { api } = await openRecord()
    sockets[0].fire('connect_error', refusal(TRANSIENT))
    api.disconnect()
    await vi.advanceTimersByTimeAsync(LONG * 4)
    await flush()
    expect(sockets).toHaveLength(1)
    expect(api.doc.value).toBeNull()
  })

  it('is cancelled when the component goes away', async () => {
    await openRecord()
    sockets[0].fire('connect_error', refusal(TRANSIENT))
    app?.unmount()
    app = null
    await vi.advanceTimersByTimeAsync(LONG * 4)
    await flush()
    expect(sockets).toHaveLength(1)
  })

  it('does not reopen the old record after another record was opened', async () => {
    const { recordRef } = await openRecord('rec_1')
    sockets[0].fire('connect_error', refusal(TRANSIENT))
    recordRef.value = 'rec_2'
    await flush()
    expect(sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(LONG * 4)
    await flush()
    expect(sockets).toHaveLength(2)
    sockets[1].fire('connect')
    expect(sockets[1].emit).toHaveBeenCalledWith('yjs:subscribe', { recordId: 'rec_2' })
  })
})

describe('record editing: transient refusals in a row', () => {
  it('are retried a bounded number of times, then an error is shown and nothing more is tried', async () => {
    const { api } = await openRecord()
    let reopened = 0
    for (let round = 0; round < 12; round += 1) {
      const before = sockets.length
      sockets[sockets.length - 1].fire('connect_error', refusal(TRANSIENT))
      await vi.advanceTimersByTimeAsync(LONG)
      await flush()
      if (sockets.length > before) reopened += 1
      else break
    }
    expect(reopened).toBe(6)
    expect(api.error.value).toBe('UNAVAILABLE: realtime unavailable')
    expect(api.doc.value).toBeNull()
    await vi.advanceTimersByTimeAsync(LONG * 4)
    await flush()
    expect(sockets).toHaveLength(7)
  })

  it('a record that synced in between starts the count over', async () => {
    const { api } = await openRecord()
    for (let round = 0; round < 5; round += 1) {
      sockets[sockets.length - 1].fire('connect_error', refusal(TRANSIENT))
      await vi.advanceTimersByTimeAsync(LONG)
      await flush()
    }
    expect(sockets).toHaveLength(6)
    sockets[5].fire('connect')
    sockets[5].fire('yjs:message', serverSyncStep1)
    expect(api.synced.value).toBe(true)
    let reopened = 0
    for (let round = 0; round < 12; round += 1) {
      const before = sockets.length
      const last = sockets[sockets.length - 1]
      last.fire('realtime:session-ended', TRANSIENT)
      last.fire('disconnect', SERVER_CLOSE)
      await vi.advanceTimersByTimeAsync(LONG)
      await flush()
      if (sockets.length > before) reopened += 1
      else break
    }
    expect(reopened).toBe(6)
  })
})
