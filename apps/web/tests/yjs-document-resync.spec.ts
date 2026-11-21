/**
 * Record editing when the server says a change did not reach this subscriber: the document and the
 * subscription are kept, the server is asked for what is missing until it answers, and only when
 * it never answers the document is given up like a voided one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef, type App } from 'vue'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

type Handler = (...args: any[]) => void
const handlers = new Map<string, Handler[]>()
const emitMock = vi.fn()
const disconnectMock = vi.fn()

vi.mock('socket.io-client', () => ({
  io: () => ({
    connected: true,
    active: false,
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    emit: emitMock,
    disconnect: disconnectMock,
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: vi.fn(() => 'jwt-token'),
    getCurrentUserId: vi.fn().mockResolvedValue('user_self'),
  }),
}))

import { useYjsDocument } from '../src/multitable/composables/useYjsDocument'

const fire = (event: string, ...args: unknown[]) => { for (const handler of [...(handlers.get(event) ?? [])]) handler(...args) }

/** The kinds of sync message this client has sent, in order. */
function sentSyncTypes(): number[] {
  return emitMock.mock.calls
    .filter(([event]) => event === 'yjs:message')
    .map(([, payload]) => {
      const decoder = decoding.createDecoder(new Uint8Array((payload as { data: number[] }).data))
      decoding.readVarUint(decoder)
      return decoding.readVarUint(decoder)
    })
}
const firstSteps = () => sentSyncTypes().filter((type) => type === syncProtocol.messageYjsSyncStep1).length

function serverStep1(doc: Y.Doc): number[] {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeSyncStep1(encoder, doc)
  return Array.from(encoding.toUint8Array(encoder))
}

function serverStep2(doc: Y.Doc): number[] {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeSyncStep2(encoder, doc)
  return Array.from(encoding.toUint8Array(encoder))
}

let app: App<Element> | null = null

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
  await vi.advanceTimersByTimeAsync(0)
}

/** Opens a record and completes the first sync against a server document that holds `text`. */
async function openSynced(text = 'one') {
  const server = new Y.Doc()
  const field = new Y.Text()
  field.insert(0, text)
  server.getMap('fields').set('f1', field)
  const recordRef = shallowRef<string | null>('rec_1')
  let api: ReturnType<typeof useYjsDocument> | null = null
  app = createApp(defineComponent({
    setup() {
      api = useYjsDocument(recordRef as never)
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  await flush()
  fire('connect')
  fire('yjs:message', { recordId: 'rec_1', data: serverStep1(server) })
  fire('yjs:message', { recordId: 'rec_1', data: serverStep2(server) })
  const typed = api as unknown as ReturnType<typeof useYjsDocument>
  const read = () => (typed.doc.value?.getMap('fields').get('f1') as Y.Text | undefined)?.toString()
  expect(read()).toBe(text)
  return { api: typed, server, serverField: field, read }
}

beforeEach(() => {
  vi.useFakeTimers()
  handlers.clear()
  emitMock.mockReset()
  disconnectMock.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  vi.useRealTimers()
})

describe('record editing: the server says a change did not arrive', () => {
  it('keeps the connection, the subscription and the document, shows no error, and asks for what is missing at once', async () => {
    const { api, server, serverField, read } = await openSynced()
    const document = api.doc.value
    const before = firstSteps()
    serverField.insert(3, '-missed')
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    expect(firstSteps()).toBe(before + 1)
    expect(disconnectMock).not.toHaveBeenCalled()
    expect(emitMock.mock.calls.filter(([event]) => event === 'yjs:unsubscribe')).toEqual([])
    expect(api.error.value).toBeNull()
    expect(api.connected.value).toBe(true)
    expect(api.synced.value).toBe(true)
    expect(api.doc.value).toBe(document)
    // The answer of the server brings the change into the same document.
    fire('yjs:message', { recordId: 'rec_1', data: serverStep2(server) })
    expect(read()).toBe('one-missed')
    expect(api.doc.value).toBe(document)
  })

  it('asks again with growing delays while the server does not answer, and stops as soon as it does', async () => {
    const { server } = await openSynced()
    const before = firstSteps()
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    expect(firstSteps()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(249)
    expect(firstSteps()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(251)
    expect(firstSteps()).toBe(before + 2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(firstSteps()).toBe(before + 3)
    fire('yjs:message', { recordId: 'rec_1', data: serverStep2(server) })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(firstSteps()).toBe(before + 3)
    expect(disconnectMock).not.toHaveBeenCalled()
  })

  it('a second notice while it is already asking does not start a second series', async () => {
    await openSynced()
    const before = firstSteps()
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    expect(firstSteps()).toBe(before + 1)
  })

  it('a first sync step of the server is not the answer: it keeps asking', async () => {
    const { server } = await openSynced()
    const before = firstSteps()
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    fire('yjs:message', { recordId: 'rec_1', data: serverStep1(server) })
    await vi.advanceTimersByTimeAsync(500)
    expect(firstSteps()).toBe(before + 2)
  })

  it('no answer after a bounded number of questions: the document is given up like a voided one', async () => {
    const { api } = await openSynced()
    const before = firstSteps()
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(firstSteps()).toBe(before + 6)
    expect(api.error.value).toBe('INVALIDATED: document invalidated by REST write')
    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(api.doc.value).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(firstSteps()).toBe(before + 6)
  })

  it('closing the record stops the questions', async () => {
    const { api } = await openSynced()
    const before = firstSteps()
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    api.disconnect()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(firstSteps()).toBe(before + 1)
    expect(api.error.value).toBeNull()
  })

  it('a notice for another record is ignored', async () => {
    await openSynced()
    const before = firstSteps()
    fire('yjs:invalidated', { recordId: 'rec_other', reason: 'resync' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(firstSteps()).toBe(before)
  })

  it('a voided document is still dropped as before, with or without a reason this client knows', async () => {
    for (const reason of ['rest-write', 'something-new', undefined]) {
      const { api } = await openSynced()
      fire('yjs:invalidated', { recordId: 'rec_1', ...(reason === undefined ? {} : { reason }) })
      expect(api.error.value).toBe('INVALIDATED: document invalidated by REST write')
      expect(api.doc.value).toBeNull()
      expect(disconnectMock).toHaveBeenCalledTimes(1)
      app?.unmount()
      app = null
      handlers.clear()
      emitMock.mockReset()
      disconnectMock.mockReset()
    }
  })

  it('a document that is voided while it is asking is dropped, and the questions stop', async () => {
    const { api } = await openSynced()
    const before = firstSteps()
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'resync' })
    fire('yjs:invalidated', { recordId: 'rec_1', reason: 'rest-write' })
    expect(api.doc.value).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(firstSteps()).toBe(before + 1)
  })
})
