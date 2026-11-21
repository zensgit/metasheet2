/**
 * Realtime record editing: a change is authorized before it reaches the shared document, every
 * contributor of a merged write is checked again before it is persisted, and a refused write
 * invalidates the document generation. Real Socket.IO transport, the real sync protocol library,
 * the real sync service, bridge, adapter and invalidator; the record store and the persisted
 * document state are in memory so a test can read back exactly what was kept.
 */
import type { Server as HttpServer } from 'node:http'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { Server } from 'socket.io'
import type { Socket as ClientSocket } from 'socket.io-client'
import * as syncProtocol from 'y-protocols/sync'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { composeRefusalHandlers, createAuthorizationRefusalHandler, createYjsInvalidator } from '../../src/collab/yjs-invalidation'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'
import { YjsDocUnavailableError, YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsWebSocketAdapter, stageYjsUpdate } from '../../src/collab/yjs-websocket-adapter'
import { FieldWritePermissionDeniedError } from '../../src/multitable/permission-derivation'
import { SESSION_ENDED_EVENT } from '../../src/realtime-authz/protected-connections'
import {
  REVALIDATION,
  connectClient,
  createProtectionHarness,
  listen,
  once,
  settle,
  until,
  type ProtectionHarness,
} from '../helpers/realtime-protection-harness'

const RECORD = 'rec-1'

interface World {
  /** The committed record data: what a reopened document is built from. */
  records: Map<string, Record<string, unknown>>
  /** Persisted document updates per record. */
  updates: Map<string, Uint8Array[]>
  readOnlyUsers: Set<string>
  noReadUsers: Set<string>
  /** userId -> fields that user may not write. */
  forbiddenFields: Map<string, Set<string>>
  purgeFails: boolean
  storeDelay: Promise<void> | null
  loadDelay: Promise<void> | null
  patches: Array<{ actorId: string; fields: Record<string, unknown> }>
  persistenceLog: string[]
}

interface Stage {
  world: World
  sync: YjsSyncService
  bridge: YjsRecordBridge
  adapter: YjsWebSocketAdapter
  io: Server
  httpServer: HttpServer
  url: string
  harness: ProtectionHarness | null
  clients: ClientSocket[]
}

function createWorld(): World {
  return {
    records: new Map([[RECORD, { f1: 'one', f2: 'two' }]]),
    updates: new Map(),
    readOnlyUsers: new Set(),
    noReadUsers: new Set(),
    forbiddenFields: new Map(),
    purgeFails: false,
    storeDelay: null,
    loadDelay: null,
    patches: [],
    persistenceLog: [],
  }
}

function persistenceOf(world: World) {
  return {
    async loadDoc(recordId: string): Promise<Uint8Array | null> {
      if (world.loadDelay) await world.loadDelay
      const stored = world.updates.get(recordId) ?? []
      if (stored.length === 0) return null
      const doc = new Y.Doc()
      for (const update of stored) Y.applyUpdate(doc, update)
      const state = Y.encodeStateAsUpdate(doc)
      doc.destroy()
      return state
    },
    async storeUpdate(recordId: string, update: Uint8Array): Promise<void> {
      if (world.storeDelay) await world.storeDelay
      world.persistenceLog.push(`store:${recordId}`)
      world.updates.set(recordId, [...(world.updates.get(recordId) ?? []), update])
    },
    async storeSnapshot(): Promise<void> {},
    async purgeRecords(recordIds: string[]): Promise<void> {
      if (world.purgeFails) throw new Error('purge failed')
      for (const recordId of recordIds) {
        world.persistenceLog.push(`purge:${recordId}`)
        world.updates.delete(recordId)
      }
    },
  }
}

async function stage(options: { protectedMode?: boolean; mergeWindowMs?: number } = {}): Promise<Stage> {
  const world = createWorld()
  const sync = new YjsSyncService(persistenceOf(world) as never, async (recordId) => world.records.get(recordId) ?? null)
  const adapter = new YjsWebSocketAdapter(sync)
  const recordWriter = {
    async patchRecords(input: { actorId: string; changesByRecord: Map<string, Array<{ fieldId: string; value: unknown }>> }) {
      const updated: string[] = []
      for (const [recordId, changes] of input.changesByRecord) {
        const fields = Object.fromEntries(changes.map((change) => [change.fieldId, change.value]))
        world.patches.push({ actorId: input.actorId, fields })
        world.records.set(recordId, { ...(world.records.get(recordId) ?? {}), ...fields })
        updated.push(recordId)
      }
      return { updated }
    },
  }
  const bridge = new YjsRecordBridge(
    sync,
    recordWriter as never,
    async (recordId, patch, actorId) => {
      // The existing flush gate: the primary actor only.
      const forbidden = world.forbiddenFields.get(actorId)
      if (Object.keys(patch).some((fieldId) => forbidden?.has(fieldId))) throw new FieldWritePermissionDeniedError()
      return { actorId, changesByRecord: new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]]) } as never
    },
    { mergeWindowMs: options.mergeWindowMs ?? 60, maxDelayMs: 400 },
    (socketId) => adapter.getSocketUserId(socketId),
  )
  adapter.setTokenVerifier(async (token) => (token.startsWith('token:') ? token.slice('token:'.length) : null))
  adapter.setAuthChecker(async (userId) => ({
    canRead: !world.noReadUsers.has(userId),
    canWrite: !world.readOnlyUsers.has(userId) && !world.noReadUsers.has(userId),
    canReadAllFields: true,
  }))
  adapter.setFieldWriteChecker(async (userId, _recordId, fieldIds) => !fieldIds.some((fieldId) => world.forbiddenFields.get(userId)?.has(fieldId)))
  bridge.setContributionChecker((recordId, contribution) => adapter.checkContribution(recordId, contribution))
  const invalidate = createYjsInvalidator({ bridge, syncService: sync, adapter })
  bridge.setRefusalHandler(composeRefusalHandlers(createAuthorizationRefusalHandler(invalidate)))
  adapter.setBridge(bridge)

  let harness: ProtectionHarness | null = null
  if (options.protectedMode !== undefined) {
    harness = createProtectionHarness({ env: options.protectedMode ? { [REVALIDATION]: 'true' } : {} })
    adapter.setRealtimeProtection(harness.protection, harness.connections)
    await harness.protection.start()
  }
  const { httpServer, url } = await listen()
  const io = new Server(httpServer)
  adapter.register(io)
  return { world, sync, bridge, adapter, io, httpServer, url, harness, clients: [] }
}

let current: Stage | null = null

afterEach(async () => {
  if (!current) return
  for (const client of current.clients) client.close()
  current.harness?.connections.dispose()
  await current.harness?.protection.stop()
  current.bridge.destroy()
  await current.sync.destroy()
  current.io.close()
  await new Promise<void>((resolve) => current?.httpServer.close(() => resolve()))
  current = null
})

interface Editor {
  socket: ClientSocket
  doc: Y.Doc
  errors: Array<{ code: string; message: string }>
  invalidated: unknown[]
  received: number[][]
  fields(): Record<string, unknown>
}

function fieldsOf(doc: Y.Doc): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of doc.getMap('fields')) out[key] = value instanceof Y.Text ? value.toString() : value
  return out
}

/** Connects, subscribes and completes the initial sync; local changes are NOT sent automatically. */
async function editor(s: Stage, userId: string, options: { expectSubscribed?: boolean } = {}): Promise<Editor> {
  const socket = connectClient(`${s.url}/yjs`, `token:${userId}`)
  s.clients.push(socket)
  await once(socket, 'connect')
  const doc = new Y.Doc()
  const self: Editor = { socket, doc, errors: [], invalidated: [], received: [], fields: () => fieldsOf(doc) }
  socket.on('yjs:error', (error: { code: string; message: string }) => self.errors.push(error))
  socket.on('yjs:invalidated', (payload: unknown) => self.invalidated.push(payload))
  socket.on('yjs:update', ({ data }: { data: number[] }) => {
    self.received.push(data)
    Y.applyUpdate(doc, new Uint8Array(data), 'remote')
  })
  let synced = false
  socket.on('yjs:message', ({ data }: { data: number[] }) => {
    const decoder = decoding.createDecoder(new Uint8Array(data))
    decoding.readVarUint(decoder)
    const reply = encoding.createEncoder()
    encoding.writeVarUint(reply, 0)
    const type = syncProtocol.readSyncMessage(decoder, reply, doc, 'remote')
    if (type === syncProtocol.messageYjsSyncStep2) synced = true
    // The reply to the first sync step of the server is the (empty) second step of this client.
    if (encoding.length(reply) > 1) socket.emit('yjs:message', { recordId: RECORD, data: Array.from(encoding.toUint8Array(reply)) })
  })
  socket.emit('yjs:subscribe', { recordId: RECORD })
  if (options.expectSubscribed === false) {
    await until(() => self.errors.length > 0)
    return self
  }
  // Ask for the document state with the first sync step of this client.
  await until(() => s.sync.getDoc(RECORD) !== undefined)
  await settle(20)
  const step1 = encoding.createEncoder()
  encoding.writeVarUint(step1, 0)
  syncProtocol.writeSyncStep1(step1, doc)
  socket.emit('yjs:message', { recordId: RECORD, data: Array.from(encoding.toUint8Array(step1)) })
  await until(() => synced, 2000, `initial sync of ${userId}`)
  return self
}

/** Makes a local change and returns the update that carries it. */
function change(target: Editor, fieldId: string, value: string): Uint8Array {
  const before = Y.encodeStateVector(target.doc)
  const fields = target.doc.getMap('fields')
  target.doc.transact(() => {
    const text = new Y.Text()
    text.insert(0, value)
    fields.set(fieldId, text)
  }, 'local')
  return Y.encodeStateAsUpdate(target.doc, before)
}

function sendUpdate(target: Editor, update: Uint8Array): void {
  target.socket.emit('yjs:update', { recordId: RECORD, data: Array.from(update) })
}

function sendAsSyncMessage(target: Editor, update: Uint8Array, form: 'step2' | 'update'): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  encoding.writeVarUint(encoder, form === 'step2' ? syncProtocol.messageYjsSyncStep2 : syncProtocol.messageYjsUpdate)
  encoding.writeVarUint8Array(encoder, update)
  target.socket.emit('yjs:message', { recordId: RECORD, data: Array.from(encoding.toUint8Array(encoder)) })
}

function shared(s: Stage): Record<string, unknown> {
  const doc = s.sync.getDoc(RECORD)
  return doc ? fieldsOf(doc) : {}
}

describe('staging an update on an isolated copy', () => {
  function base(): Y.Doc {
    const doc = new Y.Doc()
    const text = new Y.Text()
    text.insert(0, 'one')
    doc.getMap('fields').set('f1', text)
    doc.getMap('fields').set('n1', 5 as never)
    return doc
  }
  function fork(doc: Y.Doc): Y.Doc {
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    return copy
  }
  function diff(from: Y.Doc, mutate: (doc: Y.Doc) => void): Uint8Array {
    const copy = fork(from)
    const before = Y.encodeStateVector(copy)
    mutate(copy)
    return Y.encodeStateAsUpdate(copy, before)
  }

  it('names the fields an update touches and leaves the shared document untouched', () => {
    const doc = base()
    const before = Y.encodeStateAsUpdate(doc)
    expect(stageYjsUpdate(doc, diff(doc, (copy) => (copy.getMap('fields').get('f1') as Y.Text).insert(3, '!')))).toEqual({ kind: 'fields', fieldIds: ['f1'] })
    expect(stageYjsUpdate(doc, diff(doc, (copy) => copy.getMap('fields').set('n1', 6 as never)))).toEqual({ kind: 'fields', fieldIds: ['n1'] })
    expect(stageYjsUpdate(doc, diff(doc, (copy) => {
      copy.getMap('fields').set('n1', 7 as never)
      const text = new Y.Text()
      text.insert(0, 'new')
      copy.getMap('fields').set('f2', text)
    }))).toEqual({ kind: 'fields', fieldIds: ['f2', 'n1'] })
    expect(stageYjsUpdate(doc, diff(doc, (copy) => copy.getMap('fields').delete('f1')))).toEqual({ kind: 'fields', fieldIds: ['f1'] })
    // Replacing a text value names its field once, whatever happens to the replaced value.
    expect(stageYjsUpdate(doc, diff(doc, (copy) => {
      const text = new Y.Text()
      text.insert(0, 'replaced')
      copy.getMap('fields').set('f1', text)
    }))).toEqual({ kind: 'fields', fieldIds: ['f1'] })
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('reads an update that changes nothing as a no-op', () => {
    const doc = base()
    expect(stageYjsUpdate(doc, Y.encodeStateAsUpdate(fork(doc)))).toEqual({ kind: 'noop' })
    expect(stageYjsUpdate(doc, Y.encodeStateAsUpdate(new Y.Doc()))).toEqual({ kind: 'noop' })
  })

  it('cannot attribute an update that changes anything other than a record field', () => {
    const doc = base()
    expect(stageYjsUpdate(doc, diff(doc, (copy) => copy.getMap('other').set('x', 1 as never)))).toEqual({ kind: 'undeterminable' })
    expect(stageYjsUpdate(doc, diff(doc, (copy) => copy.getArray('list').push([1])))).toEqual({ kind: 'undeterminable' })
    expect(stageYjsUpdate(doc, diff(doc, (copy) => {
      const nested = new Y.Map()
      copy.getMap('fields').set('f3', nested as never)
      nested.set('inner', 1 as never)
    })).kind).not.toBe('noop')
    expect(stageYjsUpdate(doc, new Uint8Array([1, 2, 3, 4, 5]))).toEqual({ kind: 'undeterminable' })
  })

  it('cannot attribute an update that depends on state the document does not have', () => {
    const doc = base()
    const ahead = fork(doc)
    ;(ahead.getMap('fields').get('f1') as Y.Text).insert(3, 'A')
    const before = Y.encodeStateVector(ahead)
    ;(ahead.getMap('fields').get('f1') as Y.Text).insert(4, 'B')
    expect(stageYjsUpdate(doc, Y.encodeStateAsUpdate(ahead, before))).toEqual({ kind: 'undeterminable' })
  })
})

describe('a change is authorized before it reaches the shared document', () => {
  it('a writer changes a field: applied, persisted, relayed and written to the record (control)', async () => {
    const s = current = await stage()
    const writer = await editor(s, 'writer')
    const reader = await editor(s, 'reader')
    s.world.readOnlyUsers.add('reader')
    sendUpdate(writer, change(writer, 'f1', 'changed'))
    await until(() => reader.fields().f1 === 'changed')
    expect(shared(s).f1).toBe('changed')
    await until(() => s.world.records.get(RECORD)?.f1 === 'changed')
    expect(s.world.updates.get(RECORD)).toHaveLength(1)
    expect(writer.errors).toEqual([])
  })

  it.each(['yjs:update', 'sync-step-2', 'sync-update'] as const)('a user who may only read cannot write through %s', async (form) => {
    const s = current = await stage()
    const writer = await editor(s, 'writer')
    const reader = await editor(s, 'reader')
    s.world.readOnlyUsers.add('reader')
    const update = change(reader, 'f1', 'forged')
    if (form === 'yjs:update') sendUpdate(reader, update)
    else sendAsSyncMessage(reader, update, form === 'sync-step-2' ? 'step2' : 'update')
    await until(() => reader.errors.length === 1)
    await settle(150)
    expect(reader.errors[0]).toMatchObject({ code: 'FORBIDDEN' })
    expect(reader.invalidated).toHaveLength(1)
    expect(shared(s).f1).toBe('one')
    expect(s.world.updates.get(RECORD) ?? []).toEqual([])
    expect(writer.received).toEqual([])
    expect(writer.fields().f1).toBe('one')
    expect(s.world.records.get(RECORD)).toEqual({ f1: 'one', f2: 'two' })
    expect(s.world.patches).toEqual([])
    // Control on the same record: the writer still writes and its change is kept.
    sendUpdate(writer, change(writer, 'f2', 'kept'))
    await until(() => shared(s).f2 === 'kept' && s.world.records.get(RECORD)?.f2 === 'kept')
  })

  it('a user restricted on one field writes the others and not that one', async () => {
    const s = current = await stage()
    const limited = await editor(s, 'limited')
    const other = await editor(s, 'other')
    s.world.forbiddenFields.set('limited', new Set(['f2']))
    sendUpdate(limited, change(limited, 'f1', 'allowed'))
    await until(() => other.fields().f1 === 'allowed')
    sendUpdate(limited, change(limited, 'f2', 'forbidden'))
    await until(() => limited.errors.length === 1)
    await settle(150)
    expect(shared(s)).toMatchObject({ f1: 'allowed', f2: 'two' })
    expect(other.fields().f2).toBe('two')
    expect(s.world.records.get(RECORD)).toEqual({ f1: 'allowed', f2: 'two' })
  })

  it('write access is read for every change, not remembered from the subscription', async () => {
    const s = current = await stage()
    const user = await editor(s, 'user')
    const other = await editor(s, 'other')
    sendUpdate(user, change(user, 'f1', 'first'))
    await until(() => other.fields().f1 === 'first' && s.world.records.get(RECORD)?.f1 === 'first')
    s.world.readOnlyUsers.add('user')
    sendUpdate(user, change(user, 'f1', 'second'))
    await until(() => user.errors.length === 1)
    await settle(150)
    expect(shared(s).f1).toBe('first')
    expect(other.fields().f1).toBe('first')
    expect(s.world.records.get(RECORD)?.f1).toBe('first')
  })

  it('a change that cannot be attributed to record fields is refused, and a malformed message is refused', async () => {
    const s = current = await stage()
    const user = await editor(s, 'user')
    const other = await editor(s, 'other')
    const before = Y.encodeStateVector(user.doc)
    user.doc.getMap('elsewhere').set('x', 1 as never)
    sendUpdate(user, Y.encodeStateAsUpdate(user.doc, before))
    await until(() => user.errors.length === 1)
    user.socket.emit('yjs:message', { recordId: RECORD, data: [0, 9, 1, 2] })
    await until(() => user.errors.length === 2)
    await settle(100)
    expect(user.errors.map((error) => error.code)).toEqual(['FORBIDDEN', 'FORBIDDEN'])
    expect(other.received).toEqual([])
    expect(s.world.updates.get(RECORD) ?? []).toEqual([])
    const doc = s.sync.getDoc(RECORD) as Y.Doc
    expect([...doc.share.keys()]).toEqual(['fields'])
  })

  it('the empty second sync step of a reader is not an error', async () => {
    const s = current = await stage()
    s.world.readOnlyUsers.add('reader')
    const reader = await editor(s, 'reader')
    await settle(100)
    expect(reader.errors).toEqual([])
    expect(reader.fields()).toEqual({ f1: 'one', f2: 'two' })
  })

  it('changes of one connection are applied in the order they were sent', async () => {
    const s = current = await stage()
    const user = await editor(s, 'user')
    const other = await editor(s, 'other')
    for (const value of ['a', 'ab', 'abc', 'abcd']) {
      const before = Y.encodeStateVector(user.doc)
      const text = user.doc.getMap('fields').get('f1') as Y.Text
      user.doc.transact(() => { text.delete(0, text.length); text.insert(0, value) }, 'local')
      sendUpdate(user, Y.encodeStateAsUpdate(user.doc, before))
    }
    await until(() => other.fields().f1 === 'abcd')
    expect(user.errors).toEqual([])
    expect(shared(s).f1).toBe('abcd')
  })
})

describe('every contributor of a merged write is checked again before it is persisted', () => {
  it.each([['first', ['a', 'b']], ['second', ['b', 'a']]] as const)('one contributor loses a field before the write: nothing of the batch is written (%s arrival order)', async (_label, order) => {
    const s = current = await stage({ mergeWindowMs: 150 })
    const editors = { a: await editor(s, 'a'), b: await editor(s, 'b') }
    const fieldOf = { a: 'f1', b: 'f2' } as const
    for (const who of order) {
      sendUpdate(editors[who], change(editors[who], fieldOf[who], `by-${who}`))
      await until(() => shared(s)[fieldOf[who]] === `by-${who}`)
    }
    // Both changes are in the shared document and waiting to be written; b loses its field now.
    s.world.forbiddenFields.set('b', new Set(['f2']))
    await until(() => editors.a.invalidated.length === 1 && editors.b.invalidated.length === 1, 2000, 'invalidation of the generation')
    expect(s.world.patches).toEqual([])
    expect(s.world.records.get(RECORD)).toEqual({ f1: 'one', f2: 'two' })
    expect(s.world.updates.get(RECORD) ?? []).toEqual([])
    expect(s.sync.getDoc(RECORD)).toBeUndefined()
    expect(s.bridge.getMetrics().flushFailureCount).toBe(1)
  })

  it('all contributors still authorized: both changes are written (control)', async () => {
    const s = current = await stage({ mergeWindowMs: 150 })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'by-a'))
    sendUpdate(b, change(b, 'f2', 'by-b'))
    await until(() => s.world.records.get(RECORD)?.f1 === 'by-a' && s.world.records.get(RECORD)?.f2 === 'by-b')
    expect(a.invalidated).toEqual([])
    expect(s.world.patches).toHaveLength(1)
  })

  it('a contributor that closed its connection right after editing is still attributed and written', async () => {
    const s = current = await stage({ mergeWindowMs: 150 })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'last-words'))
    await until(() => shared(s).f1 === 'last-words')
    a.socket.close()
    await until(() => s.world.records.get(RECORD)?.f1 === 'last-words')
    expect(b.invalidated).toEqual([])
  })

  it('a contribution that cannot be attributed refuses the batch', async () => {
    const s = current = await stage({ mergeWindowMs: 80 })
    const a = await editor(s, 'a')
    await until(() => s.sync.getDoc(RECORD) !== undefined)
    const doc = s.sync.getDoc(RECORD) as Y.Doc
    doc.transact(() => { doc.getMap('fields').set('f1', 'no-origin' as never) }, 'someone-else')
    await until(() => a.invalidated.length === 1)
    expect(s.world.patches).toEqual([])
    expect(s.world.records.get(RECORD)).toEqual({ f1: 'one', f2: 'two' })
  })
})

describe('a refused write invalidates the document generation', () => {
  async function refusedGeneration(): Promise<{ s: Stage }> {
    const s = current = await stage({ mergeWindowMs: 100 })
    const a = await editor(s, 'a')
    sendUpdate(a, change(a, 'f1', 'refused-content'))
    await until(() => shared(s).f1 === 'refused-content')
    await until(() => (s.world.updates.get(RECORD) ?? []).length === 1)
    s.world.forbiddenFields.set('a', new Set(['f1']))
    await until(() => a.invalidated.length === 1)
    return { s }
  }

  it('a new subscription in the same process reads the committed record, not the refused content', async () => {
    const { s } = await refusedGeneration()
    const later = await editor(s, 'later')
    expect(later.fields()).toEqual({ f1: 'one', f2: 'two' })
    // A later authorized change is applied and persisted normally.
    sendUpdate(later, change(later, 'f2', 'after'))
    await until(() => s.world.records.get(RECORD)?.f2 === 'after')
    expect(s.world.records.get(RECORD)?.f1).toBe('one')
  })

  it('a restarted process reads the committed record, not the refused content', async () => {
    const { s } = await refusedGeneration()
    const restarted = new YjsSyncService(persistenceOf(s.world) as never, async (recordId) => s.world.records.get(recordId) ?? null)
    try {
      expect(fieldsOf(await restarted.getOrCreateDoc(RECORD))).toEqual({ f1: 'one', f2: 'two' })
    } finally {
      await restarted.destroy()
    }
  })

  it('a write of the old generation that is still on its way is settled before the persisted state is removed', async () => {
    const world = createWorld()
    const sync = new YjsSyncService(persistenceOf(world) as never, async (recordId) => world.records.get(recordId) ?? null)
    try {
      const doc = await sync.getOrCreateDoc(RECORD)
      let release: () => void = () => undefined
      world.storeDelay = new Promise<void>((resolve) => { release = resolve })
      doc.getMap('fields').set('f1', 'late' as never)
      const invalidating = sync.invalidateDocs([RECORD])
      await settle(30)
      expect(world.persistenceLog).toEqual([])
      release()
      await invalidating
      expect(world.persistenceLog).toEqual([`store:${RECORD}`, `purge:${RECORD}`])
      expect(world.updates.get(RECORD)).toBeUndefined()
    } finally {
      await sync.destroy()
    }
  })

  it('a loader that was already reading the old state does not publish it', async () => {
    const world = createWorld()
    const stale = new Y.Doc()
    stale.getMap('fields').set('f1', 'stale-generation' as never)
    world.updates.set(RECORD, [Y.encodeStateAsUpdate(stale)])
    const sync = new YjsSyncService(persistenceOf(world) as never, async (recordId) => world.records.get(recordId) ?? null)
    try {
      let release: () => void = () => undefined
      const original = persistenceOf(world).loadDoc
      let calls = 0
      ;(sync as unknown as { persistence: { loadDoc: typeof original } }).persistence.loadDoc = async (recordId: string) => {
        calls += 1
        const state = await original(recordId)
        if (calls === 1) await new Promise<void>((resolve) => { release = resolve })
        return state
      }
      const loading = sync.getOrCreateDoc(RECORD)
      await settle(30)
      await sync.invalidateDocs([RECORD])
      release()
      const doc = await loading
      expect(fieldsOf(doc)).toEqual({ f1: 'one', f2: 'two' })
      expect(calls).toBe(2)
    } finally {
      await sync.destroy()
    }
  })

  it('when the persisted state cannot be removed the record is not served until it can', async () => {
    const s = current = await stage({ mergeWindowMs: 100 })
    const a = await editor(s, 'a')
    sendUpdate(a, change(a, 'f1', 'refused-content'))
    await until(() => (s.world.updates.get(RECORD) ?? []).length === 1)
    s.world.purgeFails = true
    s.world.forbiddenFields.set('a', new Set(['f1']))
    await until(() => a.invalidated.length === 1)
    await expect(s.sync.getOrCreateDoc(RECORD)).rejects.toBeInstanceOf(YjsDocUnavailableError)
    const refused = await editor(s, 'later', { expectSubscribed: false })
    expect(refused.errors[0]).toMatchObject({ code: 'UNAVAILABLE' })
    s.world.purgeFails = false
    const served = await editor(s, 'again')
    expect(served.fields()).toEqual({ f1: 'one', f2: 'two' })
  })
})

describe('realtime protection on the record editing namespace', () => {
  it('switch off: no authority read, the baseline handshake', async () => {
    const s = current = await stage({ protectedMode: false })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'x'))
    await until(() => b.fields().f1 === 'x')
    expect(s.harness?.authorityReads).toEqual([])
    expect(s.harness?.connections.size()).toBe(0)
    expect(s.harness?.listener.starts).toBe(0)
  })

  it('switch on: the handshake of an ended session is refused, with a code the client can act on', async () => {
    const s = current = await stage({ protectedMode: true })
    s.harness?.facts.revokedUsers.add('gone')
    const socket = connectClient(`${s.url}/yjs`, 'token:gone')
    s.clients.push(socket)
    const error = await once<Error & { data?: unknown }>(socket, 'connect_error')
    expect(error.data).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    const forged = connectClient(`${s.url}/yjs`, 'forged')
    s.clients.push(forged)
    expect((await once<Error & { data?: unknown }>(forged, 'connect_error')).data).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    // Control: a current session connects, subscribes and syncs.
    const kept = await editor(s, 'kept')
    expect(kept.fields()).toEqual({ f1: 'one', f2: 'two' })
  })

  it('switch on: a session that ended cannot write, receives no relayed change and is closed', async () => {
    const s = current = await stage({ protectedMode: true })
    const kept = await editor(s, 'kept')
    const other = await editor(s, 'other')
    const gone = await editor(s, 'gone')
    s.harness?.facts.revokedUsers.add('gone')

    const closedByWrite = once(gone.socket, 'disconnect')
    const ended = once(gone.socket, SESSION_ENDED_EVENT)
    sendUpdate(gone, change(gone, 'f1', 'after-the-end'))
    expect(await ended).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    await closedByWrite
    await settle(100)
    expect(shared(s).f1).toBe('one')
    expect(s.world.updates.get(RECORD) ?? []).toEqual([])
    expect(kept.received).toEqual([])

    sendUpdate(kept, change(kept, 'f2', 'still-works'))
    await until(() => other.fields().f2 === 'still-works')
    expect(gone.received).toEqual([])
  })

  it('switch on: a recipient whose session ended gets no relayed change', async () => {
    const s = current = await stage({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const kept = await editor(s, 'kept')
    const gone = await editor(s, 'gone')
    const closed = once(gone.socket, 'disconnect')
    s.harness?.facts.revokedUsers.add('gone')
    sendUpdate(writer, change(writer, 'f1', 'for-current-sessions'))
    await until(() => kept.fields().f1 === 'for-current-sessions')
    await closed
    expect(gone.received).toEqual([])
    expect(gone.fields().f1).toBe('one')
  })

  it('switch on: a recipient that may no longer read the record gets no relayed change and loses the subscription only', async () => {
    const s = current = await stage({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const kept = await editor(s, 'kept')
    const narrowed = await editor(s, 'narrowed')
    s.world.noReadUsers.add('narrowed')
    sendUpdate(writer, change(writer, 'f1', 'not-for-narrowed'))
    await until(() => kept.fields().f1 === 'not-for-narrowed')
    await until(() => narrowed.errors.length === 1)
    expect(narrowed.received).toEqual([])
    expect(narrowed.socket.connected).toBe(true)
  })

  it('switch on: document state is not returned to a session that ended', async () => {
    const s = current = await stage({ protectedMode: true })
    const gone = await editor(s, 'gone')
    const writer = await editor(s, 'writer')
    sendUpdate(writer, change(writer, 'f1', 'secret-after-end'))
    await until(() => shared(s).f1 === 'secret-after-end')
    // `gone` already received that relay; from here on its session is ended.
    s.harness?.facts.revokedUsers.add('gone')
    const messages: unknown[] = []
    gone.socket.on('yjs:message', (message) => messages.push(message))
    const closed = once(gone.socket, 'disconnect')
    const step1 = encoding.createEncoder()
    encoding.writeVarUint(step1, 0)
    syncProtocol.writeSyncStep1(step1, new Y.Doc())
    gone.socket.emit('yjs:message', { recordId: RECORD, data: Array.from(encoding.toUint8Array(step1)) })
    await closed
    expect(messages).toEqual([])
  })

  it('switch on: a contributor whose session ended before the write is persisted refuses the batch', async () => {
    const s = current = await stage({ protectedMode: true, mergeWindowMs: 200 })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, change(a, 'f1', 'by-a'))
    sendUpdate(b, change(b, 'f2', 'by-b'))
    await until(() => shared(s).f1 === 'by-a' && shared(s).f2 === 'by-b')
    s.harness?.facts.revokedUsers.add('b')
    await until(() => a.invalidated.length === 1, 3000)
    expect(s.world.patches).toEqual([])
    expect(s.world.records.get(RECORD)).toEqual({ f1: 'one', f2: 'two' })
    expect(s.world.updates.get(RECORD) ?? []).toEqual([])
  })
})
