/**
 * Continuous authorization on the default collaboration channel, over a real Socket.IO server and
 * real clients. The committed facts are held in memory by the harness; every scenario keeps a
 * recipient whose session stays current as the positive control, so "nobody received anything"
 * can never pass as "the revoked one did not receive".
 */
import type { Server as HttpServer } from 'node:http'
import type { Socket as ClientSocket } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../src/integration/events/event-bus'
import { SESSION_ENDED_EVENT, type SessionEndedPayload } from '../../src/realtime-authz/protected-connections'
import { publishApprovalCountsUpdate } from '../../src/services/approval-realtime'
import { CollabService, buildAuthenticatedUserRoom, type ConstrainedPluginSocket } from '../../src/services/CollabService'
import { publishTodoCountsUpdate } from '../../src/services/todo-realtime'
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

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }

interface Stage {
  harness: ProtectionHarness
  collab: CollabService
  httpServer: HttpServer
  url: string
  eventBus: EventBus
  /** Sheets each user may read; absent user = every sheet. */
  sheetDenied: Map<string, Set<string>>
  baselineVerifierCalls: string[]
  clients: ClientSocket[]
}

async function stage(options: { on?: boolean; attach?: boolean; installation?: ProtectionHarness['facts']['installation']; sweepIntervalMs?: number } = {}): Promise<Stage> {
  const harness = createProtectionHarness({
    env: options.on === false ? {} : { [REVALIDATION]: 'true' },
    installation: options.installation,
    sweepIntervalMs: options.sweepIntervalMs,
  })
  const eventBus = new EventBus()
  const collab = new CollabService(quietLogger as never, eventBus)
  const sheetDenied = new Map<string, Set<string>>()
  const baselineVerifierCalls: string[] = []
  collab.setTokenVerifier(async (token) => {
    baselineVerifierCalls.push(token)
    return token.startsWith('token:') ? token.slice('token:'.length) : null
  })
  collab.setSheetRoomAuthChecker(async ({ sheetId, userId }) => !sheetDenied.get(userId)?.has(sheetId))
  collab.setCommentRoomAuthChecker(async ({ spreadsheetId, userId }) => !sheetDenied.get(userId)?.has(spreadsheetId))
  if (options.attach !== false) {
    collab.setRealtimeProtection(harness.protection, harness.connections)
    await harness.protection.start()
  }
  const { httpServer, url } = await listen()
  collab.initialize(httpServer)
  return { harness, collab, httpServer, url, eventBus, sheetDenied, baselineVerifierCalls, clients: [] }
}

let current: Stage | null = null

async function open(options?: Parameters<typeof stage>[0]): Promise<Stage> {
  current = await stage(options)
  return current
}

function client(s: Stage, token?: string): ClientSocket {
  const socket = connectClient(s.url, token)
  s.clients.push(socket)
  return socket
}

async function connected(s: Stage, token: string): Promise<ClientSocket> {
  const socket = client(s, token)
  await once(socket, 'connect')
  const userId = token.split(':')[1]
  await until(async () => (await s.collab.getRoomMembers(buildAuthenticatedUserRoom(userId))).includes(userId), 2000, `user room of ${userId}`)
  return socket
}

async function joinSheet(socket: ClientSocket, sheetId: string): Promise<void> {
  const joined = once(socket, 'joined')
  socket.emit('join-sheet', sheetId)
  await joined
}

beforeEach(() => { current = null })

afterEach(async () => {
  if (!current) return
  for (const socket of current.clients) socket.close()
  current.harness.connections.dispose()
  await current.harness.protection.stop()
  current.collab.getIO()?.close()
  await new Promise<void>((resolve) => current?.httpServer.close(() => resolve()))
})

describe('switch off, nothing installed: ordinary collaboration is the baseline', () => {
  it('reads no authority, starts no listener and uses the baseline token verifier', async () => {
    const s = await open({ on: false })
    expect(s.harness.protection.mode()).toBe('baseline')
    const a = await connected(s, 'token:a')
    const b = await connected(s, 'token:b')
    await joinSheet(a, 'sheet-1')
    await joinSheet(b, 'sheet-1')
    const ops = collect(b, 'sheet:op')
    const cursors = collect(b, 'sheet:cursor')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', value: 1 })
    a.emit('sheet:cursor', { sheetId: 'sheet-1', recordId: 'r1', fieldId: 'f1' })
    s.collab.broadcast('notice', { all: true })
    await until(() => ops.length === 1 && cursors.length === 1)
    expect(s.harness.authorityReads).toEqual([])
    expect(s.harness.listener.starts).toBe(0)
    expect(s.harness.probes.count).toBe(1)
    expect(s.harness.connections.size()).toBe(0)
    expect(s.baselineVerifierCalls.sort()).toEqual(['token:a', 'token:b'])
  })

  it('behaves message for message like a service with no protection attached', async () => {
    const transcript = async (attach: boolean): Promise<unknown[]> => {
      const s = await stage({ on: false, attach })
      try {
        const events: unknown[] = []
        const a = connectClient(s.url, 'token:a')
        const b = connectClient(s.url, 'token:b')
        const anonymous = connectClient(s.url)
        s.clients.push(a, b, anonymous)
        for (const [name, socket] of [['a', a], ['b', b], ['anonymous', anonymous]] as const) {
          socket.onAny((event, payload) => events.push([name, event, event === 'pong' ? 'pong' : payload]))
        }
        await Promise.all([once(a, 'connect'), once(b, 'connect'), once(anonymous, 'connect')])
        await until(async () => (await s.collab.getRoomMembers('a')).length === 1 && (await s.collab.getRoomMembers('b')).length === 1)
        a.emit('join-sheet', 'sheet-1')
        await until(() => events.some((entry) => (entry as unknown[])[0] === 'a' && (entry as unknown[])[1] === 'sheet:presence'))
        b.emit('join-sheet', 'sheet-1')
        anonymous.emit('join-sheet', 'sheet-1')
        await until(() => events.some((entry) => (entry as unknown[])[0] === 'anonymous' && (entry as unknown[])[1] === 'join-denied'))
        a.emit('sheet:cursor', { sheetId: 'sheet-1', recordId: 'r1', fieldId: 'f1' })
        s.collab.broadcast('notice', { n: 1 })
        s.collab.sendTo('b', 'direct', { n: 2 })
        s.collab.broadcastTo('sheet:sheet-1', 'room', { n: 3 })
        anonymous.emit('ping')
        await settle(150)
        return events.map((entry) => JSON.stringify(entry)).sort()
      } finally {
        for (const socket of s.clients) socket.close()
        s.harness.connections.dispose()
        await s.harness.protection.stop()
        s.collab.getIO()?.close()
        await new Promise<void>((resolve) => s.httpServer.close(() => resolve()))
      }
    }
    const withoutProtection = await transcript(false)
    const withBaselineProtection = await transcript(true)
    expect(withBaselineProtection).toEqual(withoutProtection)
    expect(withoutProtection.length).toBeGreaterThan(8)
  })
})

describe('switch on: every delivery reads the session of each recipient again', () => {
  it('stops delivering to a session that ended, closes it and keeps serving the others', async () => {
    const s = await open()
    expect(s.harness.protection.decision().row).toBe('on-without-scope')
    const kept = await connected(s, 'token:kept')
    const revoked = await connected(s, 'token:revoked')
    await joinSheet(kept, 'sheet-1')
    await joinSheet(revoked, 'sheet-1')
    const keptOps = collect<{ data: { n: number } }>(kept, 'sheet:op')
    const revokedOps = collect(revoked, 'sheet:op')

    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await until(() => keptOps.length === 1 && revokedOps.length === 1)

    const ended = once<SessionEndedPayload>(revoked, SESSION_ENDED_EVENT)
    const closed = once(revoked, 'disconnect')
    s.harness.facts.revokedUsers.add('revoked')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })

    expect(await ended).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    await closed
    await until(() => keptOps.length === 2)
    expect(keptOps.map((op) => op.data.n)).toEqual([1, 2])
    expect(revokedOps).toHaveLength(1)
  })

  it('refuses a new handshake with the credential of an ended session', async () => {
    const s = await open()
    s.harness.facts.revokedUsers.add('revoked')
    const again = client(s, 'token:revoked')
    const ended = once<SessionEndedPayload>(again, SESSION_ENDED_EVENT)
    const closed = once(again, 'disconnect')
    const anything = collect(again, 'joined')
    again.emit('join-sheet', 'sheet-1')
    expect(await ended).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    await closed
    expect(anything).toEqual([])
    expect(await s.collab.getRoomMembers(buildAuthenticatedUserRoom('revoked'))).toEqual([])
    // Control: a current session connects on the same instance.
    const kept = await connected(s, 'token:kept')
    await joinSheet(kept, 'sheet-1')
  })

  it('refuses a credential that does not verify, and serves nothing protected to a connection without one', async () => {
    const s = await open()
    const forged = client(s, 'not-a-token')
    expect(await once<SessionEndedPayload>(forged, SESSION_ENDED_EVENT)).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    const anonymous = client(s)
    await once(anonymous, 'connect')
    const denied = once<{ reason: string }>(anonymous, 'join-denied')
    anonymous.emit('join-sheet', 'sheet-1')
    expect((await denied).reason).toBe('unauthorized')
    const notices = collect(anonymous, 'notice')
    const kept = await connected(s, 'token:kept')
    const keptNotices = collect(kept, 'notice')
    s.collab.broadcast('notice', { n: 1 })
    await until(() => keptNotices.length === 1)
    await settle()
    expect(notices).toEqual([])
    // An unauthenticated connection still gets the liveness reply.
    const pong = once(anonymous, 'pong')
    anonymous.emit('ping')
    await pong
  })

  it('does not relay a cursor from a session that ended, and closes the sender', async () => {
    const s = await open()
    const kept = await connected(s, 'token:kept')
    const sender = await connected(s, 'token:sender')
    await joinSheet(kept, 'sheet-1')
    await joinSheet(sender, 'sheet-1')
    const cursors = collect<{ recordId: string | null }>(kept, 'sheet:cursor')
    sender.emit('sheet:cursor', { sheetId: 'sheet-1', recordId: 'r1', fieldId: 'f1' })
    await until(() => cursors.length === 1)

    const closed = once(sender, 'disconnect')
    s.harness.facts.revokedUsers.add('sender')
    sender.emit('sheet:cursor', { sheetId: 'sheet-1', recordId: 'r2', fieldId: 'f1' })
    await closed
    await settle()
    // The only later cursor event the room sees is the clearing of the cursor of the closed sender.
    expect(cursors.map((cursor) => cursor.recordId)).toEqual(['r1', null])
  })

  it('refuses a new subscription from a session that ended', async () => {
    const s = await open()
    const socket = await connected(s, 'token:late')
    s.harness.facts.revokedUsers.add('late')
    const joined = collect(socket, 'joined')
    const closed = once(socket, 'disconnect')
    socket.emit('join-sheet', 'sheet-1')
    await closed
    expect(joined).toEqual([])
  })

  it('closes an idle connection whose session ended, without any traffic', async () => {
    const s = await open({ sweepIntervalMs: 40 })
    const idle = await connected(s, 'token:idle')
    const kept = await connected(s, 'token:kept')
    const closed = once(idle, 'disconnect', 1000)
    const ended = once<SessionEndedPayload>(idle, SESSION_ENDED_EVENT, 1000)
    const startedAt = Date.now()
    s.harness.facts.revokedUsers.add('idle')
    expect(await ended).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    await closed
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(kept.connected).toBe(true)
  })

  it('closes on an invalidation notice without waiting for the next sweep', async () => {
    const s = await open({ sweepIntervalMs: 3_600_000 })
    const idle = await connected(s, 'token:idle')
    const closed = once(idle, 'disconnect', 1000)
    s.harness.facts.revokedUsers.add('idle')
    s.harness.listener.notify({ kind: 'user', ref: 'opaque-ref' })
    await closed
  })

  it('a notice alone never restores or grants anything: it only triggers a re-read', async () => {
    const s = await open()
    s.harness.facts.revokedUsers.add('revoked')
    const before = s.harness.authorityReads.length
    for (let index = 0; index < 5; index += 1) s.harness.listener.notify({ kind: 'global' })
    await settle()
    const again = client(s, 'token:revoked')
    expect(await once<SessionEndedPayload>(again, SESSION_ENDED_EVENT)).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    expect(s.harness.authorityReads.length).toBeGreaterThan(before)
  })

  it('withholds deliveries while the authority cannot be read, and resumes when it can', async () => {
    const s = await open()
    const a = await connected(s, 'token:a')
    await joinSheet(a, 'sheet-1')
    const ops = collect<{ data: { n: number } }>(a, 'sheet:op')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await until(() => ops.length === 1)

    s.harness.facts.authorityDown = true
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    const denied = once<{ reason: string }>(a, 'join-denied')
    a.emit('join-sheet', 'sheet-2')
    expect((await denied).reason).toBe('unavailable')
    await settle()
    expect(ops.map((op) => op.data.n)).toEqual([1])
    expect(a.connected).toBe(true)

    s.harness.facts.authorityDown = false
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 3 })
    await until(() => ops.length === 2)
    expect(ops.map((op) => op.data.n)).toEqual([1, 3])
  })

  it('reads one batch per delivery, not one read per recipient', async () => {
    const s = await open()
    const sockets = await Promise.all(['u1', 'u2', 'u3', 'u4'].map((user) => connected(s, `token:${user}`)))
    for (const socket of sockets) await joinSheet(socket, 'sheet-1')
    const received = sockets.map((socket) => collect(socket, 'sheet:op'))
    await settle()
    const before = s.harness.authorityReads.length
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await until(() => received.every((ops) => ops.length === 1))
    const reads = s.harness.authorityReads.slice(before)
    expect(reads).toHaveLength(1)
    expect([...reads[0]].sort()).toEqual(['u1', 'u2', 'u3', 'u4'])
  })

  it('caches no positive answer between two deliveries', async () => {
    const s = await open()
    const a = await connected(s, 'token:a')
    await joinSheet(a, 'sheet-1')
    const ops = collect(a, 'sheet:op')
    await settle()
    const before = s.harness.authorityReads.length
    for (let n = 1; n <= 3; n += 1) await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n })
    await until(() => ops.length === 3)
    expect(s.harness.authorityReads.slice(before)).toEqual([['a'], ['a'], ['a']])
  })

  it('a connection that joined after the sample of a delivery waits for the next delivery', async () => {
    const s = await open()
    const early = await connected(s, 'token:early')
    const late = await connected(s, 'token:late')
    await joinSheet(early, 'sheet-1')
    const earlyOps = collect<{ data: { n: number } }>(early, 'sheet:op')
    const lateOps = collect<{ data: { n: number } }>(late, 'sheet:op')
    await settle()

    let release: () => void = () => undefined
    s.harness.holdAuthority.until = new Promise<void>((resolve) => { release = resolve })
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await settle(30)
    // The delivery is waiting on its authority read; `late` enters the room now.
    await joinSheet(late, 'sheet-1')
    release()
    await until(() => earlyOps.length === 1)
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    await until(() => earlyOps.length === 2 && lateOps.length === 1)
    expect(lateOps.map((op) => op.data.n)).toEqual([2])
  })

  it('a session that ends while a delivery is being checked does not receive that delivery', async () => {
    const s = await open()
    const kept = await connected(s, 'token:kept')
    const revoked = await connected(s, 'token:revoked')
    await joinSheet(kept, 'sheet-1')
    await joinSheet(revoked, 'sheet-1')
    const keptOps = collect(kept, 'sheet:op')
    const revokedOps = collect(revoked, 'sheet:op')
    await settle()
    let release: () => void = () => undefined
    s.harness.holdAuthority.until = new Promise<void>((resolve) => { release = resolve })
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await settle(30)
    s.harness.facts.revokedUsers.add('revoked')
    release()
    await until(() => keptOps.length === 1)
    await settle()
    expect(revokedOps).toEqual([])
  })
})

describe('switch on: resource narrowing removes the subscription, not the session', () => {
  it('stops delivering a sheet to a user who may no longer read it and keeps the session', async () => {
    const s = await open()
    const kept = await connected(s, 'token:kept')
    const narrowed = await connected(s, 'token:narrowed')
    await joinSheet(kept, 'sheet-1')
    await joinSheet(narrowed, 'sheet-1')
    const keptOps = collect(kept, 'sheet:op')
    const narrowedOps = collect(narrowed, 'sheet:op')
    const direct = collect(narrowed, 'direct')

    s.sheetDenied.set('narrowed', new Set(['sheet-1']))
    const dropped = once<{ sheetId: string; reason: string }>(narrowed, 'join-denied')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    expect(await dropped).toEqual({ sheetId: 'sheet-1', reason: 'forbidden' })
    await until(() => keptOps.length === 1)
    expect(narrowedOps).toEqual([])
    expect(narrowed.connected).toBe(true)
    s.collab.sendTo('narrowed', 'direct', { n: 1 })
    await until(() => direct.length === 1)
    expect(await s.collab.getRoomMembers('sheet:sheet-1')).toEqual(['kept'])
  })

  it('takes an idle subscription out of a room once its user may no longer read the resource', async () => {
    const s = await open({ sweepIntervalMs: 40 })
    const narrowed = await connected(s, 'token:narrowed')
    await joinSheet(narrowed, 'sheet-1')
    const dropped = once<{ sheetId: string; reason: string }>(narrowed, 'join-denied', 1000)
    s.sheetDenied.set('narrowed', new Set(['sheet-1']))
    expect(await dropped).toEqual({ sheetId: 'sheet-1', reason: 'forbidden' })
    expect(narrowed.connected).toBe(true)
  })

  it('lists as room members only users whose session is current and who may read the resource', async () => {
    const s = await open()
    const a = await connected(s, 'token:a')
    const b = await connected(s, 'token:b')
    const c = await connected(s, 'token:c')
    for (const socket of [a, b, c]) {
      socket.emit('join-comment-sheet', { spreadsheetId: 'sheet-1' })
    }
    await until(async () => (await s.collab.getRoomMembers('comments-sheet:sheet-1')).length === 3)
    s.harness.facts.revokedUsers.add('b')
    s.sheetDenied.set('c', new Set(['sheet-1']))
    expect(await s.collab.getRoomMembers('comments-sheet:sheet-1')).toEqual(['a'])
  })
})

describe('switch on: pushes addressed to a user and the plugin bridge pass the same boundary', () => {
  it('delivers count updates and mentions only to a user whose session is current', async () => {
    const s = await open()
    const kept = await connected(s, 'token:kept')
    const revoked = await connected(s, 'token:revoked')
    const keptEvents: string[] = []
    const revokedEvents: string[] = []
    kept.onAny((event) => keptEvents.push(event))
    revoked.onAny((event) => { if (event !== SESSION_ENDED_EVENT) revokedEvents.push(event) })
    s.harness.facts.revokedUsers.add('revoked')

    for (const userId of ['kept', 'revoked']) {
      await publishApprovalCountsUpdate({
        collabService: s.collab, userId, reason: 'test',
        query: (async () => ({ rows: [{ count: '1', unread_count: '1' }] })) as never,
      })
      await publishTodoCountsUpdate({
        collabService: s.collab, userId, reason: 'test',
        countPendingForUser: async () => ({ count: 1, sources: {} }) as never,
      })
      s.collab.broadcastTo(buildAuthenticatedUserRoom(userId), 'tasks:counts-updated', {})
      s.collab.sendTo(userId, 'comment:mention', { id: 'c1' })
      s.collab.sendTo(userId, 'approval:comment-mention', { id: 'c2' })
    }
    await until(() => keptEvents.length === 5)
    await settle()
    expect(keptEvents.sort()).toEqual(['approval:comment-mention', 'approval:counts-updated', 'comment:mention', 'tasks:counts-updated', 'todo:counts-updated'])
    expect(revokedEvents).toEqual([])
  })

  it('never delivers a push addressed to one user to a connection bound to another', async () => {
    const s = await open()
    const owner = await connected(s, 'token:owner')
    const other = await connected(s, 'token:other')
    const ownerEvents = collect(owner, 'private')
    const otherEvents = collect(other, 'private')
    // A plugin puts the other connection into the room addressed to the owner.
    await s.collab.join(buildAuthenticatedUserRoom('owner'), { userId: 'other' })
    await s.collab.join('owner', { userId: 'other' })
    s.collab.broadcastTo(buildAuthenticatedUserRoom('owner'), 'private', { n: 1 })
    s.collab.sendTo('owner', 'private', { n: 2 })
    await until(() => ownerEvents.length === 2)
    await settle()
    expect(otherEvents).toEqual([])
  })

  it('filters a broadcast to everyone, a room broadcast and a plugin room join by recipient', async () => {
    const s = await open()
    const kept = await connected(s, 'token:kept')
    const revoked = await connected(s, 'token:revoked')
    await s.collab.join('plugin:room', { userId: 'kept' })
    const keptAll = collect(kept, 'all')
    const keptRoom = collect(kept, 'room')
    const revokedAny: string[] = []
    revoked.onAny((event) => { if (event !== SESSION_ENDED_EVENT) revokedAny.push(event) })

    s.harness.facts.revokedUsers.add('revoked')
    await s.collab.join('plugin:room', { userId: 'revoked' })
    s.collab.broadcast('all', { n: 1 })
    s.collab.broadcastTo('plugin:room', 'room', { n: 1 })
    await until(() => keptAll.length === 1 && keptRoom.length === 1)
    await settle()
    expect(revokedAny).toEqual([])
  })

  it('hands a plugin connection handler a constrained connection, only after admission, and re-checks its inbound events', async () => {
    const s = await open()
    const seen: ConstrainedPluginSocket[] = []
    const inbound: unknown[] = []
    s.collab.onConnection((raw) => {
      const socket = raw as unknown as ConstrainedPluginSocket
      seen.push(socket)
      socket.on('plugin:hello', (payload) => {
        inbound.push([socket.userId, payload])
        socket.emit('plugin:reply', { to: socket.userId })
      })
    })
    s.harness.facts.revokedUsers.add('never')
    const never = client(s, 'token:never')
    await once(never, 'disconnect')
    const anonymous = client(s)
    await once(anonymous, 'connect')
    const kept = await connected(s, 'token:kept')
    await until(() => seen.length === 1)
    expect(seen.map((socket) => socket.userId)).toEqual(['kept'])
    expect(Object.keys(seen[0]).sort()).toEqual(['connected', 'data', 'disconnect', 'emit', 'id', 'join', 'leave', 'on', 'to', 'userId'])
    expect((seen[0] as unknown as { handshake?: unknown }).handshake).toBeUndefined()

    const reply = once(kept, 'plugin:reply')
    kept.emit('plugin:hello', { n: 1 })
    expect(await reply).toEqual({ to: 'kept' })

    const closed = once(kept, 'disconnect')
    s.harness.facts.revokedUsers.add('kept')
    kept.emit('plugin:hello', { n: 2 })
    await closed
    await settle()
    expect(inbound).toEqual([['kept', { n: 1 }]])
  })
})

describe('admission rows on a running instance', () => {
  it('refuses handshakes and withholds traffic while the listener is not ready, then re-reads every session before serving again', async () => {
    const s = await open()
    const kept = await connected(s, 'token:kept')
    const revokedMeanwhile = await connected(s, 'token:meanwhile')
    await joinSheet(kept, 'sheet-1')
    await joinSheet(revokedMeanwhile, 'sheet-1')
    const keptOps = collect<{ data: { n: number } }>(kept, 'sheet:op')
    const meanwhileOps = collect(revokedMeanwhile, 'sheet:op')

    s.harness.listener.set('not-ready')
    expect(s.harness.protection.decision()).toMatchObject({ row: 'undetermined', established: 'suspend' })
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    const refused = client(s, 'token:newcomer')
    expect(await once<SessionEndedPayload>(refused, SESSION_ENDED_EVENT)).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    await settle()
    expect(keptOps).toEqual([])
    expect(kept.connected).toBe(true)

    // The session of one established connection ends while the listener is away: no notice arrives.
    s.harness.facts.revokedUsers.add('meanwhile')
    const closed = once(revokedMeanwhile, 'disconnect')
    s.harness.listener.set('ready')
    await closed
    await until(() => s.harness.connections.isServiceable([...s.collab.getIO()!.sockets.sockets.values()].find((socket) => socket.data.trustedUserId === 'kept')!))
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    await until(() => keptOps.length === 1)
    expect(keptOps.map((op) => op.data.n)).toEqual([2])
    expect(meanwhileOps).toEqual([])
  })

  it('switch on but the listener never becomes ready: nothing protected is served', async () => {
    current = null
    const harness = createProtectionHarness({ env: { [REVALIDATION]: 'true' } })
    harness.listener.stateOnStart = 'not-ready'
    const collab = new CollabService(quietLogger as never, new EventBus())
    collab.setRealtimeProtection(harness.protection, harness.connections)
    await harness.protection.start()
    const { httpServer, url } = await listen()
    collab.initialize(httpServer)
    current = { harness, collab, httpServer, url, eventBus: new EventBus(), sheetDenied: new Map(), baselineVerifierCalls: [], clients: [] }
    expect(harness.listener.starts).toBe(1)
    expect(harness.protection.decision().row).toBe('undetermined')
    const socket = client(current, 'token:a')
    expect(await once<SessionEndedPayload>(socket, SESSION_ENDED_EVENT)).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
  })

  it('switch off while the database carries a login scope: handshakes are refused', async () => {
    const s = await open({
      on: false,
      installation: { strictScope: { state: 'installed', hasScope: true }, enablement: { state: 'never-installed', definedInThisBuild: false } },
    })
    expect(s.harness.protection.decision()).toMatchObject({ row: 'off-enabled-environment', established: 'terminate' })
    const socket = client(s, 'token:a')
    const closed = once(socket, 'disconnect')
    expect(await once<SessionEndedPayload>(socket, SESSION_ENDED_EVENT)).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    await closed
    expect(s.harness.listener.starts).toBe(0)
  })

  it('a login scope that appears under a running baseline instance ends its established connections', async () => {
    const s = await open({ on: false })
    const a = await connected(s, 'token:a')
    await joinSheet(a, 'sheet-1')
    const closed = once(a, 'disconnect')
    const ended = once<SessionEndedPayload>(a, SESSION_ENDED_EVENT)
    s.harness.facts.installation = {
      strictScope: { state: 'installed', hasScope: true },
      enablement: { state: 'never-installed', definedInThisBuild: false },
    }
    await s.harness.protection.refresh()
    expect(await ended).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    await closed
  })

  it('an undecidable installation suspends traffic and recovers by itself when a later read succeeds', async () => {
    const s = await open({ on: false })
    const a = await connected(s, 'token:a')
    await joinSheet(a, 'sheet-1')
    const ops = collect<{ data: { n: number } }>(a, 'sheet:op')
    const healthy = s.harness.facts.installation
    s.harness.facts.installation = { strictScope: { state: 'unknown' }, enablement: { state: 'unknown' } }
    await s.harness.protection.refresh()
    expect(s.harness.protection.decision()).toMatchObject({ row: 'undetermined', established: 'suspend' })
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    const refused = client(s, 'token:b')
    expect(await once<SessionEndedPayload>(refused, SESSION_ENDED_EVENT)).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    await settle()
    expect(ops).toEqual([])
    expect(a.connected).toBe(true)

    s.harness.facts.installation = healthy
    await until(() => s.harness.protection.decision().row === 'off-baseline', 2000, 'automatic recovery')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    await until(() => ops.length === 1)
    expect(ops.map((op) => op.data.n)).toEqual([2])
  })

  it('the configuration conflict alone suspends nothing and is visible in the diagnostics', async () => {
    const s = await open({ on: false })
    s.harness.facts.env.DIRECTORY_DEPROVISION_REVOKE_CREDENTIALS_ENABLED = 'true'
    await s.harness.protection.refresh()
    expect(s.harness.protection.mode()).toBe('baseline')
    const a = await connected(s, 'token:a')
    const b = await connected(s, 'token:b')
    await joinSheet(a, 'sheet-1')
    await joinSheet(b, 'sheet-1')
    const ops = collect(b, 'sheet:op')
    await s.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await until(() => ops.length === 1)
    expect(s.harness.authorityReads).toEqual([])
    expect(s.harness.diagnostics.snapshot().notices.filter((notice) => notice.active).map((notice) => notice.code))
      .toContain('CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED')
  })

  it('a strict session stops at the expiry of its credential, idle or not', async () => {
    const s = await open({
      installation: { strictScope: { state: 'installed', hasScope: true }, enablement: { state: 'never-installed', definedInThisBuild: false } },
    })
    expect(s.harness.protection.decision().row).toBe('on-with-scope')
    const exp = Math.floor(Date.now() / 1000) + 1
    const strict = client(s, `strict:su:${exp}`)
    await once(strict, 'connect')
    const ended = once<SessionEndedPayload>(strict, SESSION_ENDED_EVENT, 3000)
    expect(await ended).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
  })

  it('a strict credential is refused where no login scope exists', async () => {
    const s = await open()
    const strict = client(s, `strict:su:${Math.floor(Date.now() / 1000) + 600}`)
    expect(await once<SessionEndedPayload>(strict, SESSION_ENDED_EVENT)).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
  })
})
