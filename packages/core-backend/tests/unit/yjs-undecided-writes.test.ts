/**
 * Realtime record editing while an answer cannot be had.
 *
 * A permission or session read that fails, times out or is suspended is neither a yes nor a no. An
 * edit that was already admitted stays in the shared document and is written once the answer is
 * yes; nothing is written and nothing new is shared while the answer is missing; only an
 * authoritative no refuses a write, and the editors are always told. An edit that arrives meanwhile
 * is held in order and processed afterwards, or refused visibly once it was held too long.
 *
 * Real Socket.IO transport, sync service, bridge, adapter, invalidator and protection runtime; only
 * the installation probe, the permission reads and the stores are in memory.
 */
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { SESSION_ENDED_EVENT } from '../../src/realtime-authz/protected-connections'
import { connectClient, once, settle, until } from '../helpers/realtime-protection-harness'
import {
  RECORD,
  append,
  editor,
  pause,
  resume,
  sendUpdate,
  shared,
  stage,
  teardown,
  type Stage,
  type StageOptions,
  requestMissing,
} from '../helpers/yjs-realtime-stage'

let current: Stage | null = null

async function open(options: StageOptions = {}): Promise<Stage> {
  current = await stage({
    mergeWindowMs: 100,
    bridgeOptions: { deferRetryMinMs: 20, deferRetryMaxMs: 40 },
    adapterOptions: { heldUpdateRetryMs: 20, ...(options.adapterOptions ?? {}) },
    ...options,
  })
  return current
}

afterEach(async () => {
  if (!current) return
  await teardown(current)
  current = null
})

const persisted = (s: Stage): number => (s.world.updates.get(RECORD) ?? []).length
const recordF1 = (s: Stage): unknown => s.world.records.get(RECORD)?.f1

describe('a write that was admitted is not lost when its re-check cannot be answered', () => {
  it('permission read fails at the re-check: the write waits, the document stays, and it is written once the read answers', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-typed'))
    await until(() => shared(s).f1 === 'one-typed' && persisted(s) === 1)
    s.world.readFails = true
    await settle(350)
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
    expect(shared(s).f1).toBe('one-typed')
    expect(persisted(s)).toBe(1)
    expect(s.world.patches).toEqual([])
    expect(recordF1(s)).toBe('one')
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
    expect(s.bridge.getMetrics().pendingWriteCount).toBe(1)

    s.world.readFails = false
    await until(() => recordF1(s) === 'one-typed')
    expect(s.world.patches).toHaveLength(1)
    expect(a.invalidated).toEqual([])
    expect(a.errors).toEqual([])
  })

  it('switch off, one undecidable installation read while a write is pending: nothing is lost and nobody is cut off', async () => {
    const s = await open({ protectedMode: false })
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-1'))
    await until(() => shared(s).f1 === 'one-1' && persisted(s) === 1)
    await pause(s)
    expect(s.harness?.protection.decision()).toMatchObject({ row: 'undetermined', established: 'suspend' })
    await settle(300)
    // The pending write was neither written nor refused; the document and its persisted state are intact.
    expect(s.world.patches).toEqual([])
    expect(s.sync.getDoc(RECORD)).toBeDefined()
    expect(persisted(s)).toBe(1)
    expect(a.invalidated).toEqual([])

    // An edit typed during the pause is not shared and not written while the answer is missing.
    sendUpdate(a, append(a, 'f1', '-2'))
    await settle(120)
    expect(shared(s).f1).toBe('one-1')
    expect(a.errors).toEqual([])

    await resume(s)
    expect(s.harness?.protection.mode()).toBe('baseline')
    await until(() => shared(s).f1 === 'one-1-2')
    sendUpdate(a, append(a, 'f1', '-3'))
    await until(() => recordF1(s) === 'one-1-2-3')
    expect(a.errors).toEqual([])
    expect(a.invalidated).toEqual([])
    expect(a.socket.connected).toBe(true)
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
  })

  it('switch off, one undecidable installation read with nothing pending: an edit typed meanwhile is held, then shared and written in order', async () => {
    const s = await open({ protectedMode: false })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-1'))
    await until(() => recordF1(s) === 'one-1' && b.fields().f1 === 'one-1')
    await pause(s)
    sendUpdate(a, append(a, 'f1', '-2'))
    await settle(150)
    expect(shared(s).f1).toBe('one-1')
    expect(b.fields().f1).toBe('one-1')
    expect(persisted(s)).toBe(1)
    expect(a.errors).toEqual([])

    await resume(s)
    await until(() => b.fields().f1 === 'one-1-2')
    sendUpdate(a, append(a, 'f1', '-3'))
    await until(() => recordF1(s) === 'one-1-2-3' && b.fields().f1 === 'one-1-2-3')
    expect(a.errors).toEqual([])
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
  })

  it('switch on, the listening session is lost while a write is pending: the write waits and is written when the session is back', async () => {
    const s = await open({ protectedMode: true })
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-1'))
    await until(() => shared(s).f1 === 'one-1' && persisted(s) === 1)
    s.harness?.listener.set('not-ready')
    await settle(300)
    expect(s.world.patches).toEqual([])
    expect(s.sync.getDoc(RECORD)).toBeDefined()
    expect(persisted(s)).toBe(1)
    expect(a.invalidated).toEqual([])
    s.harness?.listener.set('ready')
    await until(() => recordF1(s) === 'one-1')
    expect(a.invalidated).toEqual([])
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
  })

  it('switch on, an established connection that sends during the pause is ended visibly and its edit is not shared', async () => {
    const s = await open({ protectedMode: true })
    const a = await editor(s, 'a')
    s.harness?.listener.set('not-ready')
    const ended = once(a.socket, SESSION_ENDED_EVENT)
    sendUpdate(a, append(a, 'f1', '-during-pause'))
    expect(await ended).toEqual({ code: 'REALTIME_UNAVAILABLE', retry: true })
    await settle(100)
    expect(shared(s).f1).toBe('one')
    expect(persisted(s)).toBe(0)
  })

  it('a contributor that left long ago is still attributed when its deferred write is finally re-checked', async () => {
    const s = await open({ adapterOptions: { contributorRetentionMs: 30 } })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-last'))
    await until(() => shared(s).f1 === 'one-last')
    s.world.readFails = true
    a.socket.close()
    await settle(120)
    // Other connections come and go: retired contributors are pruned on every disconnect.
    const passerBy = connectClient(`${s.url}/yjs`, 'token:passer-by')
    s.clients.push(passerBy)
    await once(passerBy, 'connect')
    passerBy.close()
    await settle(120)
    s.world.readFails = false
    await until(() => recordF1(s) === 'one-last')
    expect(b.invalidated).toEqual([])
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
  })
})

describe('a deferred write does not outlive an invalidation of its document', () => {
  it('a write commits elsewhere while a deferred write is waiting: the deferred write is void and is not written afterwards', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-stale'))
    await until(() => shared(s).f1 === 'one-stale')
    s.world.readFails = true
    await until(() => s.bridge.getMetrics().deferredFlushCount >= 1)
    s.world.records.set(RECORD, { f1: 'committed-elsewhere', f2: 'two' })
    await s.invalidate([RECORD])
    s.world.readFails = false
    await settle(300)
    expect(recordF1(s)).toBe('committed-elsewhere')
    expect(s.world.patches).toEqual([])
    expect(s.bridge.getMetrics().pendingWriteCount).toBe(0)
  })

  it('a write commits elsewhere while the re-check of a pending write is running: that write is void and is not written', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-stale'))
    await until(() => shared(s).f1 === 'one-stale')
    let release: () => void = () => undefined
    s.world.readGate = new Promise<void>((resolve) => { release = resolve })
    await settle(180)
    // The re-check of the pending write is waiting for its read now.
    s.world.records.set(RECORD, { f1: 'committed-elsewhere', f2: 'two' })
    await s.invalidate([RECORD])
    release()
    await settle(300)
    expect(recordF1(s)).toBe('committed-elsewhere')
    expect(s.world.patches).toEqual([])
  })
})

describe('only an authoritative refusal invalidates, and the editors are always told', () => {
  it('a contributor is refused while the instance is suspended: the generation is invalidated and every editor is told', async () => {
    const s = await open({ protectedMode: false })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-1'))
    await until(() => shared(s).f1 === 'one-1')
    await pause(s)
    s.world.forbiddenFields.set('a', new Set(['f1']))
    await until(() => a.invalidated.length === 1 && b.invalidated.length === 1, 2000, 'the invalidation notice during suspension')
    expect(s.world.patches).toEqual([])
    expect(recordF1(s)).toBe('one')
    expect(persisted(s)).toBe(0)
    expect(s.bridge.getMetrics().flushFailureCount).toBe(1)
  })

  it('a committed write from elsewhere invalidates the document while the instance is suspended: the editors are told', async () => {
    const s = await open({ protectedMode: false })
    const a = await editor(s, 'a')
    await pause(s)
    s.world.records.set(RECORD, { f1: 'written-elsewhere', f2: 'two' })
    await s.invalidate([RECORD])
    await until(() => a.invalidated.length === 1)
  })

  it('switch on: the invalidation notice reaches every subscriber while deliveries are withheld', async () => {
    const s = await open({ protectedMode: true })
    const a = await editor(s, 'a')
    s.harness!.facts.authorityDown = true
    await s.invalidate([RECORD])
    await until(() => a.invalidated.length === 1)
  })
})

describe('an edit that cannot be processed is never dropped in silence', () => {
  it('an edit held longer than the bound is refused visibly and the sender is told to reopen the record', async () => {
    const s = await open({ protectedMode: false, adapterOptions: { heldUpdateRetryMs: 20, heldUpdateMaxMs: 150 } })
    const a = await editor(s, 'a')
    await pause(s)
    sendUpdate(a, append(a, 'f1', '-too-late'))
    // The refusal and the notice are two messages: wait for both.
    await until(() => a.errors.length === 1 && a.invalidated.length === 1, 2000, 'the visible refusal and the notice')
    expect(a.errors[0]).toMatchObject({ code: 'UNAVAILABLE' })
    expect(a.invalidated).toHaveLength(1)
    expect(shared(s).f1).toBe('one')
    await resume(s)
    await settle(150)
    expect(shared(s).f1).toBe('one')
    expect(s.world.patches).toEqual([])
  })

  it('the permission read fails when an edit arrives: the edit is held, not applied and not refused, and processed once the read answers', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.world.readFails = true
    sendUpdate(a, append(a, 'f1', '-held'))
    await settle(200)
    expect(shared(s).f1).toBe('one')
    expect(b.received).toEqual([])
    expect(persisted(s)).toBe(0)
    expect(a.errors).toEqual([])
    expect(a.invalidated).toEqual([])
    s.world.readFails = false
    await until(() => b.fields().f1 === 'one-held' && recordF1(s) === 'one-held')
    expect(a.errors).toEqual([])
  })

  it('a sender that leaves while its edit is held still has the edit processed once the answer is back', async () => {
    const s = await open({ protectedMode: false })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    await pause(s)
    sendUpdate(a, append(a, 'f1', '-parting'))
    await settle(60)
    a.socket.close()
    await settle(60)
    expect(shared(s).f1).toBe('one')
    await resume(s)
    await until(() => recordF1(s) === 'one-parting' && b.fields().f1 === 'one-parting')
  })

  it('an edit for a document that is gone is answered: the sender is told to reopen the record', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    // Released without any notice (an idle document): the client still believes it is subscribed.
    await s.sync.releaseDoc(RECORD)
    sendUpdate(a, append(a, 'f1', '-into-nothing'))
    await until(() => a.invalidated.length === 1)
    expect(a.errors).toEqual([])
    expect(recordF1(s)).toBe('one')
  })

  it('a document invalidated while an edit was being checked: the edit is not applied to the old generation, not relayed and not written', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    let release: () => void = () => undefined
    s.world.readGate = new Promise<void>((resolve) => { release = resolve })
    sendUpdate(a, append(a, 'f1', '-stale'))
    await settle(60)
    // A write commits elsewhere while the check of the edit is still waiting for its read.
    s.world.records.set(RECORD, { f1: 'committed-elsewhere', f2: 'two' })
    await s.invalidate([RECORD])
    release()
    await settle(400)
    expect(recordF1(s)).toBe('committed-elsewhere')
    expect(s.world.patches).toEqual([])
    expect(b.received).toEqual([])
    expect(persisted(s)).toBe(0)
    expect(a.invalidated.length).toBeGreaterThanOrEqual(1)
    const later = await editor(s, 'later')
    expect(later.fields().f1).toBe('committed-elsewhere')
  })

  it('a subscription whose permission read fails is answered the way it always was', async () => {
    const s = await open()
    s.world.readFails = true
    const a = await editor(s, 'a', { expectSubscribed: false })
    expect(a.errors[0]).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('switch on: a subscriber that cannot be given a change is told, not left behind', () => {
  it('read access of one recipient cannot be read when a change is relayed: it is told to resync, stays subscribed and is not refused; the others get the change', async () => {
    const s = await open({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const kept = await editor(s, 'kept')
    const flaky = await editor(s, 'flaky')
    s.world.readFailsFor.add('flaky')
    sendUpdate(writer, append(writer, 'f1', '-relayed'))
    await until(() => kept.fields().f1 === 'one-relayed')
    await until(() => flaky.invalidated.length === 1)
    expect(flaky.invalidated).toEqual([{ recordId: RECORD, reason: 'resync' }])
    expect(flaky.received).toEqual([])
    expect(flaky.errors).toEqual([])
    expect(flaky.socket.connected).toBe(true)
    expect(kept.invalidated).toEqual([])
    expect(flaky.fields().f1).toBe('one')

    // Asking while its read still cannot be answered gets no answer and loses nothing.
    requestMissing(flaky)
    await settle(150)
    expect(flaky.fields().f1).toBe('one')
    expect(flaky.errors).toEqual([])

    // Once its read answers, the same question gets what it is missing, on the same document.
    s.world.readFailsFor.delete('flaky')
    requestMissing(flaky)
    await until(() => flaky.fields().f1 === 'one-relayed')
    // It never left the record: the next change reaches it like everybody else, and its own change is taken.
    sendUpdate(writer, append(writer, 'f1', '-next'))
    await until(() => flaky.fields().f1 === 'one-relayed-next' && kept.fields().f1 === 'one-relayed-next')
    sendUpdate(flaky, append(flaky, 'f2', '-mine'))
    await until(() => kept.fields().f2 === 'two-mine' && shared(s).f2 === 'two-mine')
    expect(flaky.invalidated).toHaveLength(1)
    expect(flaky.errors).toEqual([])
  })

  it('the session of one recipient cannot be read when a change is relayed: the same notice; its question gets no answer and no error until its session can be read again', async () => {
    const s = await open({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const flaky = await editor(s, 'flaky')
    s.harness!.facts.unreadableUsers.add('flaky')
    sendUpdate(writer, append(writer, 'f1', '-relayed'))
    await until(() => flaky.invalidated.length === 1)
    expect(flaky.invalidated).toEqual([{ recordId: RECORD, reason: 'resync' }])
    expect(flaky.received).toEqual([])
    requestMissing(flaky)
    await settle(150)
    expect(flaky.fields().f1).toBe('one')
    expect(flaky.errors).toEqual([])
    expect(flaky.socket.connected).toBe(true)
    s.harness!.facts.unreadableUsers.delete('flaky')
    requestMissing(flaky)
    await until(() => flaky.fields().f1 === 'one-relayed')
    expect(flaky.errors).toEqual([])
    expect(flaky.invalidated).toHaveLength(1)
  })

  it('the document is voided by a write from elsewhere before it resyncs: it is told that too, because it never left the record', async () => {
    const s = await open({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const flaky = await editor(s, 'flaky')
    s.world.readFailsFor.add('flaky')
    sendUpdate(writer, append(writer, 'f1', '-relayed'))
    await until(() => flaky.invalidated.length === 1)
    s.world.readFailsFor.delete('flaky')
    await s.invalidate([RECORD])
    await until(() => flaky.invalidated.length === 2 && writer.invalidated.length === 1)
    expect(flaky.invalidated).toEqual([{ recordId: RECORD, reason: 'resync' }, { recordId: RECORD, reason: 'rest-write' }])
  })

  it('a recipient that may no longer read is refused, not told to resync', async () => {
    const s = await open({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const gone = await editor(s, 'gone')
    s.world.noReadUsers.add('gone')
    sendUpdate(writer, append(writer, 'f1', '-relayed'))
    await until(() => gone.errors.length === 1)
    expect(gone.errors[0].code).toBe('FORBIDDEN')
    expect(gone.invalidated).toEqual([])
    expect(gone.received).toEqual([])
  })
})

describe('switch on: a handshake whose session cannot be read is not admitted', () => {
  it('the namespace handshake is refused while the session facts cannot be read, and accepted once they can', async () => {
    const s = await open({ protectedMode: true })
    s.harness!.facts.authorityDown = true
    const socket = connectClient(`${s.url}/yjs`, 'token:undecided')
    s.clients.push(socket)
    const error = await once<Error & { data?: { code?: string } }>(socket, 'connect_error')
    expect(error.data?.code).toBe('REALTIME_UNAVAILABLE')
    expect(s.adapter.getSocketUserId(socket.id ?? 'none')).toBeUndefined()
    expect(s.adapter.getMetrics().activeSocketCount).toBe(0)
    s.harness!.facts.authorityDown = false
    const later = await editor(s, 'undecided')
    expect(later.fields()).toEqual({ f1: 'one', f2: 'two' })
  })
})

describe('switch on: the first sync step re-reads read access before any document state is returned', () => {
  it('a subscriber that lost read access gets no state and loses the subscription; another subscriber still gets state', async () => {
    const s = await open({ protectedMode: true })
    const lost = await editor(s, 'lost')
    const kept = await editor(s, 'kept')
    const writer = await editor(s, 'writer')
    s.world.noReadUsers.add('lost')
    const step1 = (): number[] => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.writeSyncStep1(encoder, new Y.Doc())
      return Array.from(encoding.toUint8Array(encoder))
    }
    const lostMessages: unknown[] = []
    lost.socket.on('yjs:message', (message: unknown) => lostMessages.push(message))
    const keptMessages: unknown[] = []
    kept.socket.on('yjs:message', (message: unknown) => keptMessages.push(message))
    lost.socket.emit('yjs:message', { recordId: RECORD, data: step1() })
    kept.socket.emit('yjs:message', { recordId: RECORD, data: step1() })
    await until(() => keptMessages.length === 1 && lost.errors.length === 1)
    await settle(80)
    expect(lostMessages).toEqual([])
    expect(lost.errors[0]).toMatchObject({ code: 'FORBIDDEN' })
    expect(lost.socket.connected).toBe(true)
    // The session of `lost` is still current: only the subscription went.
    sendUpdate(writer, append(writer, 'f1', '-after'))
    await until(() => kept.fields().f1 === 'one-after')
    expect(lost.received).toEqual([])
  })
})
