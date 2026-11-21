/**
 * Stage for realtime record editing tests: real Socket.IO transport, the real sync protocol library,
 * the real sync service, bridge, adapter and invalidator. The record store and the persisted document
 * state are in memory, so a test can read back exactly what was kept, and the permission facts are
 * plain sets a test changes between two messages.
 */
import type { Server as HttpServer } from 'node:http'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { Server } from 'socket.io'
import type { Socket as ClientSocket } from 'socket.io-client'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { composeRefusalHandlers, createAuthorizationRefusalHandler, createYjsInvalidator, type YjsInvalidate } from '../../src/collab/yjs-invalidation'
import { YjsRecordBridge, type YjsContribution } from '../../src/collab/yjs-record-bridge'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsWebSocketAdapter } from '../../src/collab/yjs-websocket-adapter'
import { FieldWritePermissionDeniedError } from '../../src/multitable/permission-derivation'
import {
  REVALIDATION,
  connectClient,
  createProtectionHarness,
  listen,
  once,
  settle,
  until,
  type ProtectionHarness,
} from './realtime-protection-harness'

export const RECORD = 'rec-1'

export interface World {
  /** The committed record data: what a reopened document is built from. */
  records: Map<string, Record<string, unknown>>
  /** Persisted document updates per record. */
  updates: Map<string, Uint8Array[]>
  readOnlyUsers: Set<string>
  noReadUsers: Set<string>
  /** userId -> fields that user may not write. */
  forbiddenFields: Map<string, Set<string>>
  purgeFails: boolean
  /** When true every permission read fails: the answer is neither yes nor no. */
  readFails: boolean
  /** Permission reads of these users fail; the others answer. */
  readFailsFor: Set<string>
  /** When set, the next permission read waits for it before answering. */
  readGate: Promise<void> | null
  /** When set, every permission read of these users waits for it; the reads of the others answer. */
  readGateFor: Map<string, Promise<void>>
  /**
   * The field-write check of these users answers 'unknown' the way the start-up closure does when
   * its own read fails: it returns the value, it does not throw. Their record access check answers.
   */
  fieldCheckUnknownFor: Set<string>
  /** Every permission read, by user, in order: what a check costs in reads. */
  permissionReads: string[]
  /** When true the record write fails. */
  patchFails: boolean
  /** When true the write-input builder answers that there is nothing to write. */
  builderReturnsNothing: boolean
  storeDelay: Promise<void> | null
  loadDelay: Promise<void> | null
  patches: Array<{ actorId: string; fields: Record<string, unknown> }>
  persistenceLog: string[]
}

export interface Stage {
  world: World
  sync: YjsSyncService
  bridge: YjsRecordBridge
  adapter: YjsWebSocketAdapter
  io: Server
  httpServer: HttpServer
  url: string
  harness: ProtectionHarness | null
  clients: ClientSocket[]
  invalidate: YjsInvalidate
}

export function createWorld(): World {
  return {
    records: new Map([[RECORD, { f1: 'one', f2: 'two' }]]),
    updates: new Map(),
    readOnlyUsers: new Set(),
    noReadUsers: new Set(),
    forbiddenFields: new Map(),
    purgeFails: false,
    readFails: false,
    readFailsFor: new Set(),
    readGate: null,
    readGateFor: new Map(),
    fieldCheckUnknownFor: new Set(),
    permissionReads: [],
    patchFails: false,
    builderReturnsNothing: false,
    storeDelay: null,
    loadDelay: null,
    patches: [],
    persistenceLog: [],
  }
}

export function persistenceOf(world: World) {
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

export interface StageOptions {
  protectedMode?: boolean
  mergeWindowMs?: number
  /** Passed to the adapter as its second constructor argument. */
  adapterOptions?: Record<string, number>
  /** Passed to the bridge configuration next to the merge window. */
  bridgeOptions?: Record<string, number>
  /**
   * Replaces the in-memory permission stand-ins of this stage: the two adapter checkers and the
   * write-input builder of the bridge. Used to run closures taken from the production start-up code.
   */
  wiring?: {
    authChecker: (userId: string, recordId: string) => Promise<unknown>
    fieldWriteChecker: (userId: string, recordId: string, fieldIds: string[]) => Promise<unknown>
    getWriteInput: (recordId: string, patch: Record<string, unknown>, actorId: string, allActorIds: string[], contributions?: YjsContribution[]) => Promise<unknown>
  }
}

async function permissionRead(world: World, userId: string): Promise<void> {
  world.permissionReads.push(userId)
  const own = world.readGateFor.get(userId)
  if (own) await own
  const gate = world.readGate
  if (gate) {
    world.readGate = null
    await gate
  }
  if (world.readFails || world.readFailsFor.has(userId)) throw new Error('permission read failed')
}

export async function stage(options: StageOptions = {}): Promise<Stage> {
  const world = createWorld()
  const sync = new YjsSyncService(persistenceOf(world) as never, async (recordId) => world.records.get(recordId) ?? null)
  const adapter = new (YjsWebSocketAdapter as unknown as new (sync: YjsSyncService, options?: Record<string, number>) => YjsWebSocketAdapter)(sync, options.adapterOptions)
  const recordWriter = {
    async patchRecords(input: { actorId: string; changesByRecord: Map<string, Array<{ fieldId: string; value: unknown }>> }) {
      if (world.patchFails) throw new Error('record write failed')
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
    options.wiring ? (options.wiring.getWriteInput as never) : ((async (recordId: string, patch: Record<string, unknown>, actorId: string, _allActorIds: string[], contributions?: YjsContribution[]) => {
      if (world.builderReturnsNothing) return null as never
      // The gate of the write-input builder: every field is checked against each actor that changed
      // it; without contribution records, against the primary actor of the merged write.
      const writers = new Map<string, Set<string>>()
      for (const contribution of contributions ?? []) {
        for (const fieldId of contribution.fieldIds) writers.set(fieldId, (writers.get(fieldId) ?? new Set<string>()).add(contribution.actorId))
      }
      for (const fieldId of Object.keys(patch)) {
        for (const writer of writers.get(fieldId) ?? [actorId]) {
          if (world.forbiddenFields.get(writer)?.has(fieldId)) throw new FieldWritePermissionDeniedError()
        }
      }
      return { actorId, changesByRecord: new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]]) } as never
    }) as never),
    { mergeWindowMs: options.mergeWindowMs ?? 60, maxDelayMs: 400, ...(options.bridgeOptions ?? {}) },
    (socketId) => adapter.getSocketUserId(socketId),
  )
  adapter.setTokenVerifier(async (token) => (token.startsWith('token:') ? token.slice('token:'.length) : null))
  adapter.setAuthChecker(async (userId) => {
    await permissionRead(world, userId)
    return {
      canRead: !world.noReadUsers.has(userId),
      canWrite: !world.readOnlyUsers.has(userId) && !world.noReadUsers.has(userId),
      canReadAllFields: true,
    }
  })
  adapter.setFieldWriteChecker(async (userId, _recordId, fieldIds) => {
    if (world.fieldCheckUnknownFor.has(userId)) return 'unknown'
    await permissionRead(world, userId)
    return !fieldIds.some((fieldId) => world.forbiddenFields.get(userId)?.has(fieldId))
  })
  if (options.wiring) {
    adapter.setAuthChecker(options.wiring.authChecker as never)
    adapter.setFieldWriteChecker(options.wiring.fieldWriteChecker as never)
  }
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
  return { world, sync, bridge, adapter, io, httpServer, url, harness, clients: [], invalidate }
}

export async function teardown(s: Stage): Promise<void> {
  for (const client of s.clients) client.close()
  s.harness?.connections.dispose()
  await s.harness?.protection.stop()
  s.bridge.destroy()
  await s.sync.destroy()
  s.io.close()
  await new Promise<void>((resolve) => s.httpServer.close(() => resolve()))
}


export interface Editor {
  socket: ClientSocket
  doc: Y.Doc
  errors: Array<{ code: string; message: string }>
  invalidated: unknown[]
  received: number[][]
  fields(): Record<string, unknown>
}

export function fieldsOf(doc: Y.Doc): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of doc.getMap('fields')) out[key] = value instanceof Y.Text ? value.toString() : value
  return out
}

/** Connects, subscribes and completes the initial sync; local changes are NOT sent automatically. */
export async function editor(s: Stage, userId: string, options: { expectSubscribed?: boolean } = {}): Promise<Editor> {
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
export function change(target: Editor, fieldId: string, value: string): Uint8Array {
  const before = Y.encodeStateVector(target.doc)
  const fields = target.doc.getMap('fields')
  target.doc.transact(() => {
    const text = new Y.Text()
    text.insert(0, value)
    fields.set(fieldId, text)
  }, 'local')
  return Y.encodeStateAsUpdate(target.doc, before)
}

export function sendUpdate(target: Editor, update: Uint8Array): void {
  target.socket.emit('yjs:update', { recordId: RECORD, data: Array.from(update) })
}

export function sendAsSyncMessage(target: Editor, update: Uint8Array, form: 'step2' | 'update'): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  encoding.writeVarUint(encoder, form === 'step2' ? syncProtocol.messageYjsSyncStep2 : syncProtocol.messageYjsUpdate)
  encoding.writeVarUint8Array(encoder, update)
  target.socket.emit('yjs:message', { recordId: RECORD, data: Array.from(encoding.toUint8Array(encoder)) })
}

/** Asks the server for everything this editor is missing: the first sync step, with its own state. */
export function requestMissing(target: Editor): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeSyncStep1(encoder, target.doc)
  target.socket.emit('yjs:message', { recordId: RECORD, data: Array.from(encoding.toUint8Array(encoder)) })
}

export function shared(s: Stage): Record<string, unknown> {
  const doc = s.sync.getDoc(RECORD)
  return doc ? fieldsOf(doc) : {}
}


/** Appends to the text of a field and returns the update that carries the change. */
export function append(target: Editor, fieldId: string, suffix: string): Uint8Array {
  const before = Y.encodeStateVector(target.doc)
  const text = target.doc.getMap('fields').get(fieldId) as Y.Text
  target.doc.transact(() => { text.insert(text.length, suffix) }, 'local')
  return Y.encodeStateAsUpdate(target.doc, before)
}

/** Makes every installation read undecidable: the instance leaves the row it was in until `resume`. */
export async function pause(s: Stage): Promise<void> {
  if (!s.harness) throw new Error('stage has no protection harness')
  s.harness.facts.installation = { strictScope: { state: 'unknown' }, enablement: { state: 'unknown' } }
  await s.harness.protection.refresh()
}

export async function resume(s: Stage): Promise<void> {
  if (!s.harness) throw new Error('stage has no protection harness')
  s.harness.facts.installation = {
    strictScope: { state: 'never-installed' },
    enablement: { state: 'never-installed', definedInThisBuild: false },
  }
  await s.harness.protection.refresh()
}
