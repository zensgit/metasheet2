/**
 * Acceptance: a real client comes back by itself after a transient refusal and stays away after a
 * final one.
 *
 * The client is the transport library the web app ships (same version, asserted below) with the
 * reconnect helper of the web app installed on it — the helper file itself, not a copy. The server
 * side is the real collaboration service, record editing adapter, protection runtime and connection
 * registry over a real Socket.IO server; only the installation read and the authority read are
 * held in memory.
 *
 * What each group proves:
 *   - switch off, read undecidable: nobody is turned away at all. The connection is held, served
 *     nothing, and admitted by itself. No reconnect is involved; the helper has nothing to do.
 *   - switch on, read undecidable, and a record editing handshake held past its bound: the server
 *     refuses as transient, and it is the helper that brings the client back.
 *   - a session that is no longer current: the server refuses for good and the client stays away.
 *   - the same transient refusal without the helper: the client never comes back (control).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Server as HttpServer } from 'node:http'
import { dirname, join } from 'node:path'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import { afterEach, describe, expect, it } from 'vitest'
import { installRealtimeReconnect, type RealtimeReconnectHandle } from '../../../../apps/web/src/utils/realtimeReconnect'
import { YjsWebSocketAdapter } from '../../src/collab/yjs-websocket-adapter'
import { EventBus } from '../../src/integration/events/event-bus'
import { SESSION_ENDED_EVENT } from '../../src/realtime-authz/protected-connections'
import { CollabService, buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import { REVALIDATION, collect, createProtectionHarness, listen, settle, until, type ProtectionHarness } from '../helpers/realtime-protection-harness'
import { RECORD, pause, resume, stage as yjsStage, teardown as yjsTeardown, type Stage as YjsStage } from '../helpers/yjs-realtime-stage'

const require_ = createRequire(import.meta.url)
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }
const UNKNOWN = { strictScope: { state: 'unknown' as const }, enablement: { state: 'unknown' as const } }
const NEVER = { strictScope: { state: 'never-installed' as const }, enablement: { state: 'never-installed' as const, definedInThisBuild: false } }
/** Short delays so a test sees several attempts; the shape of the backoff is the one the app uses. */
const FAST = { minDelayMs: 40, maxDelayMs: 160 }

interface Stage {
  harness: ProtectionHarness
  collab: CollabService
  adapter: YjsWebSocketAdapter
  httpServer: HttpServer
  url: string
  eventBus: EventBus
  /** Namespace handshakes the server saw on the default channel, by token. */
  connections: string[]
}

const stages: Stage[] = []
const yjsStages: YjsStage[] = []
const clients: ClientSocket[] = []
const handles: RealtimeReconnectHandle[] = []

async function open(options: { on?: boolean } = {}): Promise<Stage> {
  const harness = createProtectionHarness({ env: options.on ? { [REVALIDATION]: 'true' } : {} })
  const eventBus = new EventBus()
  const collab = new CollabService(quietLogger as never, eventBus)
  collab.setTokenVerifier(async (token) => (token.startsWith('token:') ? token.slice('token:'.length) : null))
  collab.setSheetRoomAuthChecker(async () => true)
  collab.setRealtimeProtection(harness.protection, harness.connections)
  await harness.protection.start()
  const { httpServer, url } = await listen()
  collab.initialize(httpServer)
  const connections: string[] = []
  collab.getIO()!.on('connection', (socket) => connections.push(String((socket.handshake.auth as { token?: unknown })?.token ?? '')))
  // The record editing namespace on the same server, as in the running app. Only its handshake is
  // exercised in this file; documents are exercised in the record editing stage below.
  const adapter = new YjsWebSocketAdapter({ getDoc: () => undefined, getOrCreateDoc: async () => { throw new Error('not used') } } as never)
  adapter.setTokenVerifier(async (token) => (token.startsWith('token:') ? token.slice('token:'.length) : null))
  adapter.setRealtimeProtection(harness.protection, harness.connections)
  adapter.register(collab.getIO()!)
  const s: Stage = { harness, collab, adapter, httpServer, url, eventBus, connections }
  stages.push(s)
  return s
}

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.stop()
  for (const client of clients.splice(0)) client.close()
  for (const s of stages.splice(0)) {
    s.harness.connections.dispose()
    await s.harness.protection.stop()
    s.collab.getIO()?.close()
    await new Promise<void>((resolve) => s.httpServer.close(() => resolve()))
  }
  for (const s of yjsStages.splice(0)) await yjsTeardown(s)
})

interface Watched {
  socket: ClientSocket
  handle: RealtimeReconnectHandle | null
  /** connect / disconnect:<reason> / ended:<code> / error:<code or message>, in order. */
  events: string[]
  connects(): number
}

/** A client built the way the web app builds it: default options of the library, token in `auth`. */
function client(url: string, token: string, options: { helper?: boolean; onReconnected?: (socket: ClientSocket) => void; manager?: Record<string, unknown> } = {}): Watched {
  const socket = ioClient(url, { transports: ['websocket'], auth: { token }, ...(options.manager ?? { forceNew: true }) })
  clients.push(socket)
  const handle = options.helper === false ? null : installRealtimeReconnect(socket, { ...FAST, onReconnected: () => options.onReconnected?.(socket) })
  if (handle) handles.push(handle)
  const events: string[] = []
  socket.on('connect', () => events.push('connect'))
  socket.on('disconnect', (reason) => events.push(`disconnect:${reason}`))
  socket.on(SESSION_ENDED_EVENT, (payload: { code: string }) => events.push(`ended:${payload.code}`))
  socket.on('connect_error', (error: Error & { data?: { code?: string } }) => events.push(`error:${error.data?.code ?? error.message}`))
  return { socket, handle, events, connects: () => events.filter((event) => event === 'connect').length }
}

async function makeUndecidable(s: Stage): Promise<void> {
  s.harness.facts.installation = UNKNOWN
  await s.harness.protection.refresh()
  expect(s.harness.protection.decision().row).toBe('undetermined')
}

async function makeDecidable(s: Stage): Promise<void> {
  s.harness.facts.installation = NEVER
  await s.harness.protection.refresh()
}

describe('the client under test is the one the web app ships', () => {
  it('the transport library is version 4.8.3 in the backend tests and in the web app', () => {
    const versionAt = (from: string): string => {
      const entry = createRequire(from).resolve('socket.io-client')
      let dir = dirname(entry)
      while (!/[\\/]socket\.io-client$/.test(dir)) dir = dirname(dir)
      return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version
    }
    expect(versionAt(import.meta.url)).toBe('4.8.3')
    expect(versionAt(join(dirname(require_.resolve('../../package.json')), '../../apps/web/package.json'))).toBe('4.8.3')
  })
})

describe('switch off, the read does not answer: nobody is turned away, so there is nothing to recover from', () => {
  it('default channel: the client stays connected, gets nothing, and is in its rooms by itself once the read answers', async () => {
    const s = await open()
    await makeUndecidable(s)
    const late = client(s.url, 'token:late')
    const ops = collect<{ data: { n: number } }>(late.socket, 'sheet:op')
    await until(() => late.socket.connected, 2000, 'the connection')
    late.socket.emit('join-sheet', 'sheet-1')
    await settle(200)
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await settle(100)
    expect(late.events).toEqual(['connect'])
    expect(ops).toEqual([])
    await makeDecidable(s)
    await until(async () => (await s.collab.getRoomMembers('sheet:sheet-1')).includes('late'), 2000, 'the held room request')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    await until(() => ops.length === 1)
    expect(ops[0].data.n).toBe(2)
    // One connection, never closed, never reconnected.
    expect(late.events).toEqual(['connect'])
    expect(s.connections).toEqual(['token:late'])
    expect(late.handle?.waiting).toBe(false)
  })

  it('record editing: the handshake waits and completes by itself once the read answers, with no error', async () => {
    const s = await yjsStage({ protectedMode: false })
    yjsStages.push(s)
    await pause(s)
    const late = client(`${s.url}/yjs`, 'token:late')
    await until(() => s.adapter.heldHandshakeCount() === 1, 2000, 'the waiting handshake')
    await settle(200)
    expect(late.events).toEqual([])
    await resume(s)
    await until(() => late.socket.connected, 2000, 'the held handshake')
    expect(late.events).toEqual(['connect'])
    const answered = new Promise<void>((resolve) => late.socket.once('yjs:message', () => resolve()))
    late.socket.emit('yjs:subscribe', { recordId: RECORD })
    await answered
  })
})

describe('a transient refusal: the client comes back by itself', () => {
  it('default channel, switch on, read undecidable: refused and closed by the server, retried with growing delays, back in its room after the read answers', async () => {
    const s = await open({ on: true })
    await makeUndecidable(s)
    const ops = [] as Array<{ data: { n: number } }>
    const late = client(s.url, 'token:late', { onReconnected: (socket) => socket.emit('join-sheet', 'sheet-1') })
    late.socket.on('sheet:op', (payload: { data: { n: number } }) => ops.push(payload))
    late.socket.emit('join-sheet', 'sheet-1')
    // Refused several times while the read does not answer; each refusal is the transient one.
    await until(() => s.connections.length >= 3, 4000, 'three attempts')
    expect(late.events.filter((event) => event.startsWith('ended:'))).toEqual(expect.arrayContaining(['ended:REALTIME_UNAVAILABLE']))
    expect(new Set(late.events.filter((event) => event.startsWith('ended:')))).toEqual(new Set(['ended:REALTIME_UNAVAILABLE']))
    expect(late.events.filter((event) => event.startsWith('disconnect:')).every((event) => event === 'disconnect:io server disconnect')).toBe(true)
    expect(late.handle?.final).toBe(false)
    await makeDecidable(s)
    expect(s.harness.protection.decision().row).toBe('on-without-scope')
    await until(async () => (await s.collab.getRoomMembers(buildAuthenticatedUserRoom('late'))).includes('late'), 4000, 'the client to be admitted')
    await until(async () => (await s.collab.getRoomMembers('sheet:sheet-1')).includes('late'), 4000, 'the room to be asked for again')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 7 })
    await until(() => ops.length >= 1)
    expect(ops[ops.length - 1].data.n).toBe(7)
    expect(late.socket.connected).toBe(true)
    // It stays: no further refusal, no further attempt.
    const attempts = s.connections.length
    await settle(400)
    expect(s.connections).toHaveLength(attempts)
  })

  it('record editing, switch on, read undecidable: refused in the handshake, retried, connected after the read answers', async () => {
    const s = await yjsStage({ protectedMode: true })
    yjsStages.push(s)
    await pause(s)
    const late = client(`${s.url}/yjs`, 'token:late')
    await until(() => late.events.filter((event) => event === 'error:REALTIME_UNAVAILABLE').length >= 3, 4000, 'three refused handshakes')
    expect(late.connects()).toBe(0)
    await resume(s)
    await until(() => late.socket.connected, 4000, 'the client to come back')
    expect(late.events.filter((event) => !event.startsWith('error:REALTIME_UNAVAILABLE'))).toEqual(['connect'])
  })

  it('record editing, switch off, the handshake waited longer than its bound: refused as transient, retried, connected after the read answers', async () => {
    const s = await yjsStage({ protectedMode: false, adapterOptions: { heldHandshakeMaxMs: 150 } })
    yjsStages.push(s)
    await pause(s)
    const late = client(`${s.url}/yjs`, 'token:late')
    await until(() => late.events.filter((event) => event === 'error:REALTIME_UNAVAILABLE').length >= 2, 4000, 'two expired handshakes')
    expect(late.connects()).toBe(0)
    await resume(s)
    await until(() => late.socket.connected, 4000, 'the client to come back')
    expect(late.connects()).toBe(1)
  })

  it('control: the same refusal without the helper leaves the client closed for good', async () => {
    const s = await open({ on: true })
    await makeUndecidable(s)
    const bare = client(s.url, 'token:bare', { helper: false })
    await until(() => bare.events.includes('disconnect:io server disconnect'), 2000, 'the refusal')
    await makeDecidable(s)
    await settle(1200)
    expect(bare.events).toEqual(['connect', 'ended:REALTIME_UNAVAILABLE', 'disconnect:io server disconnect'])
    expect(bare.socket.connected).toBe(false)
    expect(bare.socket.active).toBe(false)
    expect(s.connections).toEqual(['token:bare'])
  })
})

describe('a final refusal: the client stays away', () => {
  it('default channel: a session that is no longer current is ended once and never retried', async () => {
    const s = await open({ on: true })
    s.harness.facts.revokedUsers.add('gone')
    const gone = client(s.url, 'token:gone')
    await until(() => gone.events.includes('disconnect:io server disconnect'), 2000, 'the refusal')
    await settle(1200)
    expect(gone.events).toEqual(['connect', 'ended:SESSION_NOT_CURRENT', 'disconnect:io server disconnect'])
    expect(s.connections).toEqual(['token:gone'])
    expect(gone.handle?.final).toBe(true)
    expect(gone.handle?.waiting).toBe(false)
    expect(gone.socket.connected).toBe(false)
  })

  it('default channel: a session that ends while connected is ended once and never retried', async () => {
    const s = await open({ on: true })
    const user = client(s.url, 'token:user')
    await until(async () => (await s.collab.getRoomMembers(buildAuthenticatedUserRoom('user'))).includes('user'), 2000, 'admission')
    s.harness.facts.revokedUsers.add('user')
    await s.harness.connections.sweep()
    await until(() => user.events.includes('disconnect:io server disconnect'), 2000, 'the end of the session')
    await settle(1200)
    expect(user.events).toEqual(['connect', 'ended:SESSION_NOT_CURRENT', 'disconnect:io server disconnect'])
    expect(s.connections).toEqual(['token:user'])
    expect(user.handle?.final).toBe(true)
  })

  it('record editing: a handshake refused for good is not retried', async () => {
    const s = await yjsStage({ protectedMode: true })
    yjsStages.push(s)
    s.harness!.facts.revokedUsers.add('gone')
    const gone = client(`${s.url}/yjs`, 'token:gone')
    await until(() => gone.events.length > 0, 2000, 'the refusal')
    await settle(1200)
    expect(gone.events).toEqual(['error:SESSION_NOT_CURRENT'])
    expect(gone.handle?.final).toBe(true)
  })

  it('a credential that does not verify at all is refused without a retry mark and is not retried, as before', async () => {
    const s = await yjsStage({ protectedMode: false })
    yjsStages.push(s)
    const bad = client(`${s.url}/yjs`, 'garbage')
    await until(() => bad.events.length > 0, 2000, 'the refusal')
    await settle(800)
    expect(bad.events).toHaveLength(1)
    expect(bad.events[0]).toMatch(/^error:UNAUTHENTICATED/)
    expect(bad.handle?.final).toBe(false)
    expect(bad.handle?.waiting).toBe(false)
  })
})

describe('two connections of one page that share a transport, as the web app opens them', () => {
  it('a transient refusal of the default channel closes both; both come back by themselves', async () => {
    const s = await open({ on: true })
    const shared = { multiplex: true }
    const main = client(s.url, 'token:pair', { manager: shared })
    const editing = client(`${s.url}/yjs`, 'token:pair', { manager: shared })
    expect(editing.socket.io).toBe(main.socket.io)
    await until(() => main.socket.connected && editing.socket.connected, 2000, 'both connections')
    await makeUndecidable(s)
    // Established connections are kept while the read does not answer. A plugin-style end of the
    // default-channel connection closes the shared transport, and with it the other connection.
    const serverSide = [...s.collab.getIO()!.sockets.sockets.values()][0]
    s.harness.connections.end(serverSide as never, { code: 'REALTIME_UNAVAILABLE', retry: true })
    await until(() => !main.socket.connected && !editing.socket.connected, 2000, 'both closed')
    await makeDecidable(s)
    await until(() => main.socket.connected && editing.socket.connected, 4000, 'both back')
    expect(main.events.filter((event) => event.startsWith('ended:'))).toContain('ended:REALTIME_UNAVAILABLE')
    expect(main.handle?.final).toBe(false)
    expect(editing.handle?.final).toBe(false)
  })

  it('a final refusal of the default channel closes both; neither stays connected', async () => {
    const s = await open({ on: true })
    const shared = { multiplex: true }
    const main = client(s.url, 'token:pair', { manager: shared })
    const editing = client(`${s.url}/yjs`, 'token:pair', { manager: shared })
    await until(() => main.socket.connected && editing.socket.connected, 2000, 'both connections')
    s.harness.facts.revokedUsers.add('pair')
    await s.harness.connections.sweep()
    await until(() => !main.socket.connected && !editing.socket.connected, 2000, 'both closed')
    await settle(1500)
    expect(main.socket.connected).toBe(false)
    expect(editing.socket.connected).toBe(false)
    expect(main.handle?.waiting).toBe(false)
    expect(editing.handle?.waiting).toBe(false)
    // Whichever of the two was told directly stops at once; the other stops at its next refusal.
    expect(main.handle?.final || editing.handle?.final).toBe(true)
  })
})
