/**
 * Revalidation switch off, and one installation read does not answer.
 *
 * The instance cannot tell which row it is in, so it serves nothing protected. It does not turn
 * anybody away for that either: a new connection is kept, connected and unserved, a room request
 * that cannot be decided is kept with it, and both are answered by the baseline as soon as a later
 * read answers. Connections that were there before stay exactly as they were.
 *
 * Real Socket.IO server, real clients, the real collaboration service, record editing adapter,
 * protection runtime and connection registry; only the installation read and the authority read
 * are held in memory. Every cell keeps a positive control, so "nothing arrived" is never the proof.
 */
import type { Server as HttpServer } from 'node:http'
import type { Socket as ClientSocket } from 'socket.io-client'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../src/integration/events/event-bus'
import { decideRealtimeAdmission } from '../../src/realtime-authz/admission'
import { SESSION_ENDED_EVENT, type SessionEndedPayload } from '../../src/realtime-authz/protected-connections'
import { CollabService, MAX_HELD_JOINS_PER_CONNECTION, buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import { buildCommentSheetRoom } from '../../src/services/commentRooms'
import {
  REVALIDATION,
  collect,
  connectClient,
  createProtectionHarness,
  listen,
  once,
  settle,
  until,
  type ProtectionHarness,
} from '../helpers/realtime-protection-harness'
import { RECORD, editor, pause, resume, stage as yjsStage, teardown as yjsTeardown, type Stage as YjsStage } from '../helpers/yjs-realtime-stage'

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }
const UNKNOWN = { strictScope: { state: 'unknown' as const }, enablement: { state: 'unknown' as const } }
const NEVER = { strictScope: { state: 'never-installed' as const }, enablement: { state: 'never-installed' as const, definedInThisBuild: false } }
const SCOPED = { strictScope: { state: 'installed' as const, hasScope: true }, enablement: { state: 'never-installed' as const, definedInThisBuild: false } }

interface Stage {
  harness: ProtectionHarness
  collab: CollabService
  httpServer: HttpServer
  url: string
  eventBus: EventBus
  sheetDenied: Map<string, Set<string>>
  /** When set, the next sheet permission check waits for it. */
  sheetGate: { until: Promise<void> | null }
  baselineVerifierCalls: string[]
  clients: ClientSocket[]
}

const stages: Stage[] = []
const yjsStages: YjsStage[] = []

async function open(options: { on?: boolean } = {}): Promise<Stage> {
  const harness = createProtectionHarness({ env: options.on ? { [REVALIDATION]: 'true' } : {} })
  const eventBus = new EventBus()
  const collab = new CollabService(quietLogger as never, eventBus)
  const sheetDenied = new Map<string, Set<string>>()
  const sheetGate: Stage['sheetGate'] = { until: null }
  const baselineVerifierCalls: string[] = []
  collab.setTokenVerifier(async (token) => {
    baselineVerifierCalls.push(token)
    return token.startsWith('token:') || token.startsWith('legacy:') ? token.slice(token.indexOf(':') + 1) : null
  })
  collab.setSheetRoomAuthChecker(async ({ sheetId, userId }) => {
    const gate = sheetGate.until
    if (gate) {
      sheetGate.until = null
      await gate
    }
    return !sheetDenied.get(userId)?.has(sheetId)
  })
  collab.setCommentRoomAuthChecker(async ({ spreadsheetId, userId }) => !sheetDenied.get(userId)?.has(spreadsheetId))
  collab.setRealtimeProtection(harness.protection, harness.connections)
  await harness.protection.start()
  const { httpServer, url } = await listen()
  collab.initialize(httpServer)
  const s: Stage = { harness, collab, httpServer, url, eventBus, sheetDenied, sheetGate, baselineVerifierCalls, clients: [] }
  stages.push(s)
  return s
}

async function openYjs(options: Parameters<typeof yjsStage>[0]): Promise<YjsStage> {
  const s = await yjsStage(options)
  yjsStages.push(s)
  return s
}

afterEach(async () => {
  for (const s of stages.splice(0)) {
    for (const socket of s.clients) socket.close()
    s.harness.connections.dispose()
    await s.harness.protection.stop()
    s.collab.getIO()?.close()
    await new Promise<void>((resolve) => s.httpServer.close(() => resolve()))
  }
  for (const s of yjsStages.splice(0)) await yjsTeardown(s)
})

async function undecidable(s: Stage): Promise<void> {
  s.harness.facts.installation = UNKNOWN
  await s.harness.protection.refresh()
  expect(s.harness.protection.decision()).toMatchObject({ row: 'undetermined', established: 'suspend' })
}

async function decidable(s: Stage): Promise<void> {
  s.harness.facts.installation = NEVER
  await s.harness.protection.refresh()
  expect(s.harness.protection.mode()).toBe('baseline')
}

/** Everything a client is told, in order, except presence. */
function transcript(socket: ClientSocket): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = []
  socket.onAny((event: string, payload: unknown) => {
    if (event !== 'sheet:presence') events.push([event, payload])
  })
  socket.on('disconnect', (reason) => events.push(['disconnect', reason]))
  return events
}

async function established(s: Stage, token: string, sheetId?: string): Promise<ClientSocket> {
  const socket = connectClient(s.url, token)
  s.clients.push(socket)
  await once(socket, 'connect')
  const userId = token.slice(token.indexOf(':') + 1)
  await until(async () => (await s.collab.getRoomMembers(buildAuthenticatedUserRoom(userId))).includes(userId), 2000, `user room of ${userId}`)
  if (sheetId) {
    const joined = once(socket, 'joined')
    socket.emit('join-sheet', sheetId)
    await joined
  }
  return socket
}

describe('the admission table: an undecidable read with the switch off holds handshakes, with the switch on refuses them', () => {
  const input = (revalidation: 'on' | 'off' | 'near-true', listener: 'ready' | 'not-ready' | 'not-started', facts: typeof UNKNOWN | typeof NEVER | typeof SCOPED) =>
    decideRealtimeAdmission({ revalidation, credentialChain: 'off', facts, listener } as never)

  it('switch off or only resembling on, read undecidable: both handshakes are held and established traffic is suspended', () => {
    for (const revalidation of ['off', 'near-true'] as const) {
      expect(input(revalidation, 'not-started', UNKNOWN)).toMatchObject({
        row: 'undetermined', ordinaryHandshake: 'hold', strictHandshake: 'hold', established: 'suspend', listenerRequired: false,
      })
    }
  })

  it('one generation undecidable is enough', () => {
    const half = { strictScope: { state: 'unknown' as const }, enablement: NEVER.enablement }
    expect(input('off', 'not-started', half as never)).toMatchObject({ ordinaryHandshake: 'hold', strictHandshake: 'hold' })
  })

  it('switch on: an undecidable read and a listener that is not ready still refuse handshakes', () => {
    expect(input('on', 'ready', UNKNOWN)).toMatchObject({ row: 'undetermined', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'suspend' })
    expect(input('on', 'not-ready', NEVER)).toMatchObject({ row: 'undetermined', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'suspend' })
  })

  it('switch off in an environment that carries a committed scope still refuses and ends connections', () => {
    expect(input('off', 'not-started', SCOPED)).toMatchObject({
      row: 'off-enabled-environment', ordinaryHandshake: 'refuse', strictHandshake: 'refuse', established: 'terminate',
    })
  })

  it('no other row holds a handshake', () => {
    const rows = [input('off', 'not-started', NEVER), input('on', 'ready', NEVER), input('on', 'ready', SCOPED)]
    for (const row of rows) expect([row.ordinaryHandshake, row.strictHandshake]).not.toContain('hold')
  })
})

describe('switch off, read undecidable, default channel: a new connection is held and admitted by itself', () => {
  it('is not told its session ended and is not disconnected; it is served nothing until the read answers, then everything', async () => {
    const s = await open()
    const control = await established(s, 'token:control', 'sheet-1')
    const controlOps = collect<{ data: { n: number } }>(control, 'sheet:op')
    await undecidable(s)

    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    const told = transcript(held)
    const ops = collect<{ data: { n: number } }>(held, 'sheet:op')
    const direct = collect(held, 'direct')
    await once(held, 'connect')
    held.emit('join-sheet', 'sheet-1')
    await settle(150)

    // Held: connected, told nothing, member of nothing.
    expect(held.connected).toBe(true)
    expect(told).toEqual([])
    expect(await s.collab.getRoomMembers(buildAuthenticatedUserRoom('held'))).toEqual([])
    expect(s.baselineVerifierCalls).not.toContain('token:held')
    // Nothing protected is delivered meanwhile: not to it, and not to the connection that was there before.
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    s.collab.sendTo('held', 'direct', { n: 1 })
    await settle(150)
    expect(ops).toEqual([])
    expect(direct).toEqual([])
    expect(controlOps).toEqual([])
    expect(told).toEqual([])

    await decidable(s)
    // Admitted by itself: its user room and the sheet it asked for, with no new request from the client.
    await until(() => told.some(([event]) => event === 'joined'), 2000, 'the held join')
    await until(async () => (await s.collab.getRoomMembers(buildAuthenticatedUserRoom('held'))).includes('held'), 2000, 'the user room')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    s.collab.sendTo('held', 'direct', { n: 2 })
    await until(() => ops.length === 1 && direct.length === 1 && controlOps.length === 1)
    expect(direct).toEqual([{ n: 2 }])
    expect(ops.map((op) => op.data.n)).toEqual([2])
    expect(told.filter(([event]) => event === 'join-denied' || event === SESSION_ENDED_EVENT || event === 'disconnect')).toEqual([])
    expect(held.connected).toBe(true)
  })

  it('a credential the baseline accepts is not judged while held, whatever the session binder would say of it', async () => {
    const s = await open()
    await undecidable(s)
    // `legacy:` verifies for the baseline verifier of this stage and does not bind as a session.
    const legacy = connectClient(s.url, 'legacy:old')
    s.clients.push(legacy)
    const told = transcript(legacy)
    await once(legacy, 'connect')
    legacy.emit('join-sheet', 'sheet-1')
    await settle(150)
    expect(legacy.connected).toBe(true)
    expect(told).toEqual([])
    await decidable(s)
    await until(() => told.some(([event]) => event === 'joined'), 2000, 'the held join')
    expect(told.map(([event]) => event)).toEqual(['joined'])
  })

  it('a credential the baseline refuses is answered by the baseline after the release, as it always was', async () => {
    const s = await open()
    await undecidable(s)
    const bad = connectClient(s.url, 'garbage')
    const none = connectClient(s.url)
    s.clients.push(bad, none)
    const toldBad = transcript(bad)
    const toldNone = transcript(none)
    await Promise.all([once(bad, 'connect'), once(none, 'connect')])
    bad.emit('join-sheet', 'sheet-1')
    none.emit('join-sheet', 'sheet-1')
    await settle(150)
    expect(toldBad).toEqual([])
    expect(toldNone).toEqual([])
    await decidable(s)
    await until(() => toldBad.length === 1 && toldNone.length === 1)
    expect(toldBad).toEqual([['join-denied', { sheetId: 'sheet-1', reason: 'unauthorized' }]])
    expect(toldNone).toEqual([['join-denied', { sheetId: 'sheet-1', reason: 'unauthorized' }]])
    expect(bad.connected).toBe(true)
  })

  it('a held request is still subject to the permission check when it is answered', async () => {
    const s = await open()
    s.sheetDenied.set('held', new Set(['sheet-secret']))
    await undecidable(s)
    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    const told = transcript(held)
    await once(held, 'connect')
    held.emit('join-sheet', 'sheet-secret')
    held.emit('join-sheet', 'sheet-open')
    await settle(100)
    await decidable(s)
    await until(() => told.length === 2)
    expect(told).toEqual(expect.arrayContaining([
      ['join-denied', { sheetId: 'sheet-secret', reason: 'forbidden' }],
      ['joined', { sheetId: 'sheet-open' }],
    ]))
  })

  it('every kind of room request is held and answered: sheet, comment sheet, comment record, comment inbox', async () => {
    const s = await open()
    await undecidable(s)
    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    const told = transcript(held)
    await once(held, 'connect')
    held.emit('join-sheet', 'sheet-1')
    held.emit('join-comment-sheet', { spreadsheetId: 'sheet-1' })
    held.emit('join-comment-record', { spreadsheetId: 'sheet-1', rowId: 'row-1' })
    held.emit('join-comment-inbox')
    await settle(150)
    expect(told).toEqual([])
    await decidable(s)
    await until(() => told.length === 3)
    expect(told.map(([event]) => event).sort()).toEqual(['joined', 'joined-comment-inbox', 'joined-comment-record'])
    await until(async () => (await s.collab.getRoomMembers(buildCommentSheetRoom({ spreadsheetId: 'sheet-1' }))).length === 1, 2000, 'the comment sheet room')
  })

  it('a room left again while held is not joined after the release', async () => {
    const s = await open()
    await undecidable(s)
    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    const told = transcript(held)
    const ops = collect(held, 'sheet:op')
    await once(held, 'connect')
    held.emit('join-sheet', 'sheet-gone')
    held.emit('join-sheet', 'sheet-kept')
    held.emit('join-comment-inbox')
    await settle(100)
    held.emit('leave-sheet', 'sheet-gone')
    held.emit('leave-comment-inbox')
    await settle(100)
    await decidable(s)
    await until(() => told.some(([event]) => event === 'joined'))
    await settle(100)
    expect(told).toEqual([['joined', { sheetId: 'sheet-kept' }]])
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-gone', n: 1 })
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-kept', n: 2 })
    await until(() => ops.length === 1)
    expect((ops[0] as { data: { n: number } }).data.n).toBe(2)
  })

  it('a connection holds a bounded number of requests; one more is answered as unavailable right away', async () => {
    const s = await open()
    await undecidable(s)
    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    const told = transcript(held)
    await once(held, 'connect')
    for (let index = 0; index < MAX_HELD_JOINS_PER_CONNECTION; index += 1) held.emit('join-sheet', `sheet-${index}`)
    await settle(150)
    expect(told).toEqual([])
    held.emit('join-sheet', 'sheet-0') // asked again: the same request, not one more
    held.emit('join-sheet', 'sheet-over')
    await until(() => told.length === 1)
    expect(told).toEqual([['join-denied', { sheetId: 'sheet-over', reason: 'unavailable' }]])
    await decidable(s)
    await until(() => told.filter(([event]) => event === 'joined').length === MAX_HELD_JOINS_PER_CONNECTION)
  })

  it('a held connection that goes away is forgotten: nothing is joined for it after the release', async () => {
    const s = await open()
    await undecidable(s)
    const held = connectClient(s.url, 'token:gone')
    s.clients.push(held)
    await once(held, 'connect')
    held.emit('join-sheet', 'sheet-1')
    await settle(100)
    held.close()
    await settle(100)
    await decidable(s)
    await settle(150)
    expect(s.baselineVerifierCalls).not.toContain('token:gone')
    expect(await s.collab.getRoomMembers('sheet:sheet-1')).toEqual([])
  })

  it('held connections are not read again on every pass and are counted once each', async () => {
    const s = await open()
    await undecidable(s)
    const first = connectClient(s.url, 'token:one')
    const second = connectClient(s.url, 'token:two')
    s.clients.push(first, second)
    await Promise.all([once(first, 'connect'), once(second, 'connect')])
    await settle(50)
    const refusedBefore = s.harness.diagnostics.snapshot().events.find((event) => event.code === 'handshake-refused')?.count ?? 0
    for (let pass = 0; pass < 5; pass += 1) await s.harness.connections.sweep()
    const events = s.harness.diagnostics.snapshot().events
    expect(events.find((event) => event.code === 'handshake-held')?.count).toBe(2)
    expect(events.find((event) => event.code === 'handshake-refused')?.count ?? 0).toBe(refusedBefore)
    expect(s.harness.authorityReads).toEqual([])
    expect(s.baselineVerifierCalls).toEqual([])
  })
})

describe('switch off, read undecidable, default channel: connections that were there before stay as they were', () => {
  it('keep their rooms, receive nothing meanwhile, and a room they ask for meanwhile is theirs after the release', async () => {
    const s = await open()
    const a = await established(s, 'token:a', 'sheet-1')
    const told = transcript(a)
    const ops = collect<{ spreadsheetId?: string; data: { spreadsheetId: string; n: number } }>(a, 'sheet:op')
    await undecidable(s)
    a.emit('join-sheet', 'sheet-2')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await settle(150)
    expect(told).toEqual([])
    expect(ops).toEqual([])
    expect(a.connected).toBe(true)
    await decidable(s)
    await until(() => told.some(([event]) => event === 'joined'), 2000, 'the held join')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-2', n: 3 })
    await until(() => ops.length === 2)
    expect(ops.map((op) => op.data.n)).toEqual([2, 3])
    expect(told.filter(([event]) => event === 'join-denied' || event === 'disconnect')).toEqual([])
  })
})

describe('switch off, read undecidable, default channel: the read answers while a request is being decided', () => {
  it('a request that was asked while held and answered after the release is joined, not refused', async () => {
    const s = await open()
    await undecidable(s)
    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    const told = transcript(held)
    await once(held, 'connect')
    await settle(50)
    // The identity question of this request is asked while held; the release arrives before the
    // service looks at the answer.
    const original = s.harness.connections.checkCurrent.bind(s.harness.connections)
    let straddled = false
    s.harness.connections.checkCurrent = async (socket) => {
      const answer = await original(socket)
      if (!straddled) {
        straddled = true
        await decidable(s)
      }
      return answer
    }
    held.emit('join-sheet', 'sheet-1')
    await until(() => told.length > 0, 2000, 'an answer to the request')
    expect(straddled).toBe(true)
    expect(told).toEqual([['joined', { sheetId: 'sheet-1' }]])
  })

  it('the instance becomes undecidable again right after a release: requests are held again, not lost', async () => {
    const s = await open()
    await undecidable(s)
    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    const told = transcript(held)
    await once(held, 'connect')
    held.emit('join-sheet', 'sheet-1')
    await settle(100)
    // The replayed request waits on its permission check while the instance leaves the baseline again.
    let open_: () => void = () => undefined
    s.sheetGate.until = new Promise<void>((resolve) => { open_ = resolve })
    await decidable(s)
    await settle(50)
    await undecidable(s)
    open_()
    await settle(100)
    held.emit('join-sheet', 'sheet-2')
    await settle(100)
    expect(told.filter(([event]) => event === 'join-denied')).toEqual([])
    await decidable(s)
    await until(() => told.filter(([event]) => event === 'joined').length === 2, 2000, 'both joins')
  })
})

describe('switch off, read undecidable, then the environment turns out to be enabled', () => {
  it('held connections end with the transient notice, like every other protected connection', async () => {
    const s = await open()
    await undecidable(s)
    const held = connectClient(s.url, 'token:held')
    s.clients.push(held)
    await once(held, 'connect')
    held.emit('join-sheet', 'sheet-1')
    await settle(100)
    const ended = once<SessionEndedPayload>(held, SESSION_ENDED_EVENT)
    const closed = once<string>(held, 'disconnect')
    s.harness.facts.installation = SCOPED
    await s.harness.protection.refresh()
    expect(s.harness.protection.decision().row).toBe('off-enabled-environment')
    expect(await ended).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    expect(await closed).toBe('io server disconnect')
  })
})

describe('switch on: handshakes are refused as before, nothing is held', () => {
  it('default channel: a new connection during an undecidable read is told the transient notice and disconnected', async () => {
    const s = await open({ on: true })
    await undecidable(s)
    expect(s.harness.protection.decision()).toMatchObject({ ordinaryHandshake: 'refuse', strictHandshake: 'refuse' })
    const refused = connectClient(s.url, 'token:b')
    s.clients.push(refused)
    const ended = once<SessionEndedPayload>(refused, SESSION_ENDED_EVENT)
    const closed = once<string>(refused, 'disconnect')
    expect(await ended).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    expect(await closed).toBe('io server disconnect')
    expect(s.harness.diagnostics.snapshot().events.find((event) => event.code === 'handshake-held')).toBeUndefined()
  })

  it('record editing: a handshake during an undecidable read is refused at once with the transient error', async () => {
    const s = await openYjs({ protectedMode: true })
    await pause(s)
    const started = Date.now()
    const refused = connectClient(`${s.url}/yjs`, 'token:b')
    s.clients.push(refused)
    const error = await once<Error & { data?: unknown }>(refused, 'connect_error')
    expect(error.data).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(s.adapter.heldHandshakeCount()).toBe(0)
  })
})

describe('switch off, read undecidable, record editing: a handshake waits and is admitted by itself', () => {
  it('no error is answered; the connection is not a member of the namespace while it waits; it connects when the read answers and can subscribe', async () => {
    const s = await openYjs({ protectedMode: false })
    const control = await editor(s, 'control')
    await pause(s)
    const waiting = connectClient(`${s.url}/yjs`, 'token:late')
    s.clients.push(waiting)
    const errors = collect(waiting, 'connect_error')
    let connectedAt = 0
    waiting.on('connect', () => { connectedAt = Date.now() })
    await until(() => s.adapter.heldHandshakeCount() === 1, 2000, 'the waiting handshake')
    await settle(200)
    expect(waiting.connected).toBe(false)
    expect(errors).toEqual([])
    expect([...s.io.of('/yjs').sockets.values()].map((socket) => socket.id)).toEqual([control.socket.id])
    const resumedAt = Date.now()
    await resume(s)
    await until(() => waiting.connected, 2000, 'the held handshake')
    expect(connectedAt).toBeGreaterThanOrEqual(resumedAt)
    expect(errors).toEqual([])
    expect(s.adapter.heldHandshakeCount()).toBe(0)
    // It is an ordinary baseline connection now.
    const synced = once(waiting, 'yjs:message')
    waiting.emit('yjs:subscribe', { recordId: RECORD })
    await synced
  })

  it('a credential the baseline refuses waits like any other and is refused by the baseline when the read answers', async () => {
    const s = await openYjs({ protectedMode: false })
    await pause(s)
    const bad = connectClient(`${s.url}/yjs`, 'garbage')
    s.clients.push(bad)
    const errors = collect<Error & { data?: unknown }>(bad, 'connect_error')
    await until(() => s.adapter.heldHandshakeCount() === 1)
    await settle(100)
    expect(errors).toEqual([])
    await resume(s)
    await until(() => errors.length === 1)
    expect(errors[0].message).toMatch(/^UNAUTHENTICATED/)
    expect(errors[0].data).toBeUndefined()
  })

  it('a handshake that waits longer than the bound is refused with the transient error', async () => {
    const s = await openYjs({ protectedMode: false, adapterOptions: { heldHandshakeMaxMs: 250 } })
    await pause(s)
    const started = Date.now()
    const waiting = connectClient(`${s.url}/yjs`, 'token:late')
    s.clients.push(waiting)
    const error = await once<Error & { data?: unknown }>(waiting, 'connect_error', 3000)
    expect(Date.now() - started).toBeGreaterThanOrEqual(240)
    expect(error.data).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    expect(s.adapter.heldHandshakeCount()).toBe(0)
  })

  it('no more than the bound wait at once; one more is refused with the transient error right away', async () => {
    const s = await openYjs({ protectedMode: false, adapterOptions: { heldHandshakeMaxWaiting: 2 } })
    await pause(s)
    const first = connectClient(`${s.url}/yjs`, 'token:one')
    const second = connectClient(`${s.url}/yjs`, 'token:two')
    s.clients.push(first, second)
    await until(() => s.adapter.heldHandshakeCount() === 2)
    const third = connectClient(`${s.url}/yjs`, 'token:three')
    s.clients.push(third)
    const error = await once<Error & { data?: unknown }>(third, 'connect_error')
    expect(error.data).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    expect(s.adapter.heldHandshakeCount()).toBe(2)
    await resume(s)
    await until(() => first.connected && second.connected)
  })

  it('a client that goes away while its handshake waits is forgotten', async () => {
    const s = await openYjs({ protectedMode: false })
    await pause(s)
    const waiting = connectClient(`${s.url}/yjs`, 'token:late')
    s.clients.push(waiting)
    await until(() => s.adapter.heldHandshakeCount() === 1)
    waiting.close()
    await until(() => s.adapter.heldHandshakeCount() === 0, 2000, 'the waiter to be released')
    await resume(s)
    await settle(100)
    expect([...s.io.of('/yjs').sockets.values()]).toEqual([])
  })

  it('the environment turns out to be enabled: the waiting handshake is refused with the transient error', async () => {
    const s = await openYjs({ protectedMode: false })
    await pause(s)
    const waiting = connectClient(`${s.url}/yjs`, 'token:late')
    s.clients.push(waiting)
    const failed = once<Error & { data?: unknown }>(waiting, 'connect_error')
    await until(() => s.adapter.heldHandshakeCount() === 1)
    s.harness!.facts.installation = SCOPED
    await s.harness!.protection.refresh()
    expect((await failed).data).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
  })
})
