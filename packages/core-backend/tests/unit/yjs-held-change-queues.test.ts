/**
 * Incoming changes that wait for an answer: who waits behind whom, how many may wait, how long,
 * and what is read for them.
 *
 * Changes wait per sender. A sender that cannot write, or whose checks do not answer, never makes
 * another sender wait or be refused. A sender that is refused is told once; what it had waiting is
 * ended without a read. A check that never returns does not keep a change past its time.
 *
 * Real Socket.IO, sync service, bridge, adapter and invalidator; only the permission reads and the
 * stores are in memory.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { settle, until } from '../helpers/realtime-protection-harness'
import {
  RECORD,
  append,
  change,
  editor,
  requestMissing,
  sendUpdate,
  shared,
  stage,
  teardown,
  type Editor,
  type Stage,
  type StageOptions,
} from '../helpers/yjs-realtime-stage'

let current: Stage | null = null

async function open(options: StageOptions = {}): Promise<Stage> {
  current = await stage({
    mergeWindowMs: 60,
    ...options,
    bridgeOptions: { deferRetryMinMs: 20, deferRetryMaxMs: 40, ...(options.bridgeOptions ?? {}) },
    adapterOptions: { heldUpdateRetryMs: 20, ...(options.adapterOptions ?? {}) },
  })
  return current
}

afterEach(async () => {
  if (current) await teardown(current)
  current = null
})

const written = (s: Stage): Array<Record<string, unknown>> => s.world.patches.map((patch) => patch.fields)
const record = (s: Stage): Record<string, unknown> => s.world.records.get(RECORD) ?? {}
const readsOf = (s: Stage, userId: string): number => s.world.permissionReads.filter((reader) => reader === userId).length
const codes = (target: Editor): string[] => target.errors.map((error) => `${error.code}: ${error.message}`)

describe('how many changes of one sender may wait', () => {
  it('one more than the bound is refused visibly, to that sender only; nothing of it is shared or written, and what it had waiting is ended', async () => {
    const s = await open({ adapterOptions: { heldUpdateRetryMs: 20, heldUpdateMaxQueued: 2 } })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.world.readFailsFor.add('a')
    sendUpdate(a, append(a, 'f1', '-1'))
    sendUpdate(a, append(a, 'f1', '-2'))
    await settle(80)
    expect(a.errors).toEqual([])
    sendUpdate(a, append(a, 'f1', '-3'))
    await until(() => a.errors.length === 1 && a.invalidated.length === 1, 2000, 'the refusal of the change over the bound')
    expect(codes(a)).toEqual(['UNAVAILABLE: Too many changes are waiting for this record; reopen it'])
    // The other sender is not refused and does not wait.
    sendUpdate(b, append(b, 'f2', '-b'))
    await until(() => shared(s).f2 === 'two-b' && record(s).f2 === 'two-b', 2000, 'the change of the other sender')
    expect(b.errors).toEqual([])
    expect(b.invalidated).toEqual([])
    // The reads of the refused sender answer again: nothing it had waiting is processed any more.
    const readsBefore = readsOf(s, 'a')
    s.world.readFailsFor.delete('a')
    await settle(250)
    expect(shared(s).f1).toBe('one')
    expect(b.received).toEqual([])
    expect(written(s)).toEqual([{ f2: 'two-b' }])
    expect(readsOf(s, 'a')).toBe(readsBefore)
    expect(a.errors).toHaveLength(1)
    expect(a.invalidated).toHaveLength(1)
  })

  it('a sender within its bound is held and processed in order, whatever the others have waiting', async () => {
    const s = await open({ adapterOptions: { heldUpdateRetryMs: 20, heldUpdateMaxQueued: 2 } })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.world.readFailsFor.add('a')
    s.world.readFailsFor.add('b')
    sendUpdate(a, append(a, 'f1', '-1'))
    sendUpdate(a, append(a, 'f1', '-2'))
    sendUpdate(b, append(b, 'f2', '-1'))
    sendUpdate(b, append(b, 'f2', '-2'))
    await settle(100)
    expect(codes(a)).toEqual([])
    expect(codes(b)).toEqual([])
    s.world.readFailsFor.clear()
    await until(() => shared(s).f1 === 'one-1-2' && shared(s).f2 === 'two-1-2', 2000, 'all four changes')
    await until(() => record(s).f1 === 'one-1-2' && record(s).f2 === 'two-1-2', 2000, 'the record write')
  })

  it('the record as a whole has its own bound: past it the arriving change is refused visibly', async () => {
    const s = await open({ adapterOptions: { heldUpdateRetryMs: 20, heldUpdateMaxQueued: 2, heldUpdateMaxQueuedPerRecord: 3 } })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    const c = await editor(s, 'c')
    for (const user of ['a', 'b', 'c']) s.world.readFailsFor.add(user)
    sendUpdate(a, append(a, 'f1', '-1'))
    sendUpdate(a, append(a, 'f1', '-2'))
    sendUpdate(b, append(b, 'f2', '-1'))
    await settle(80)
    sendUpdate(c, append(c, 'f2', '-c'))
    await until(() => c.errors.length === 1 && c.invalidated.length === 1, 2000, 'the refusal at the record bound')
    expect(codes(c)).toEqual(['UNAVAILABLE: Too many changes are waiting for this record; reopen it'])
    expect(codes(a)).toEqual([])
    expect(codes(b)).toEqual([])
  })
})

describe('a sender that may not write does not get in the way of one that may', () => {
  it('a reader sends the same change many times, fewer than its bound, an editor one change right after: the editor is served, the reader is refused once and read for once', async () => {
    const s = await open({ adapterOptions: { heldUpdateRetryMs: 20, heldUpdateMaxQueued: 16 } })
    s.world.readOnlyUsers.add('r')
    const r = await editor(s, 'r')
    const e = await editor(s, 'e')
    const readsBefore = readsOf(s, 'r')
    const spam = change(r, 'f1', 'spam')
    for (let index = 0; index < 12; index += 1) sendUpdate(r, spam)
    sendUpdate(e, append(e, 'f1', '-legit'))
    await until(() => shared(s).f1 === 'one-legit' && record(s).f1 === 'one-legit', 2000, 'the change of the editor')
    await settle(300)
    expect(e.errors).toEqual([])
    expect(e.invalidated).toEqual([])
    // Refused once, for the first change. The other eleven are ended without a read: those already
    // waiting get no answer, those that arrive after the refusal are answered as not subscribed.
    expect(codes(r).filter((code) => code === 'FORBIDDEN: No write access')).toHaveLength(1)
    expect(codes(r).filter((code) => code !== 'FORBIDDEN: No write access' && code !== 'FORBIDDEN: Not subscribed')).toEqual([])
    expect(r.invalidated).toHaveLength(1)
    expect(readsOf(s, 'r') - readsBefore).toBe(1)
  })

  it('a reader sends far more than its bound, an editor one change right after: the editor is served and not refused; the reader is told once to reopen and read for at most once', async () => {
    const s = await open({ adapterOptions: { heldUpdateRetryMs: 20, heldUpdateMaxQueued: 16 } })
    s.world.readOnlyUsers.add('r')
    const r = await editor(s, 'r')
    const e = await editor(s, 'e')
    const readsBefore = readsOf(s, 'r')
    const spam = change(r, 'f1', 'spam')
    for (let index = 0; index < 200; index += 1) sendUpdate(r, spam)
    sendUpdate(e, append(e, 'f1', '-legit'))
    await until(() => shared(s).f1 === 'one-legit' && record(s).f1 === 'one-legit', 2000, 'the change of the editor')
    await settle(400)
    expect(e.errors).toEqual([])
    expect(e.invalidated).toEqual([])
    expect(r.invalidated).toHaveLength(1)
    expect(readsOf(s, 'r') - readsBefore).toBeLessThanOrEqual(1)
    // Whatever the reader was answered, it was never anything but a refusal.
    expect(codes(r).every((code) => code.startsWith('FORBIDDEN') || code.startsWith('UNAVAILABLE'))).toBe(true)
    expect(shared(s).f1).toBe('one-legit')
  })

  it('a sender whose checks do not answer does not make another sender wait', async () => {
    const s = await open()
    const stuck = await editor(s, 'stuck')
    const free = await editor(s, 'free')
    s.world.readGateFor.set('stuck', new Promise<void>(() => undefined))
    sendUpdate(stuck, append(stuck, 'f1', '-stuck'))
    await settle(40)
    const sentAt = Date.now()
    sendUpdate(free, append(free, 'f2', '-free'))
    await until(() => shared(s).f2 === 'two-free', 2000, 'the change of the other sender')
    expect(Date.now() - sentAt).toBeLessThan(500)
    expect(shared(s).f1).toBe('one')
  })
})

describe('what is checked again when a waiting change is processed', () => {
  it('a sender that left the record while connected: its waiting change is ended without a read and it is told', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.world.readFailsFor.add('a')
    sendUpdate(a, append(a, 'f1', '-after-leaving'))
    await settle(80)
    a.socket.emit('yjs:unsubscribe', { recordId: RECORD })
    await settle(40)
    const readsBefore = readsOf(s, 'a')
    s.world.readFailsFor.delete('a')
    await until(() => a.errors.length === 1, 2000, 'the answer to the sender')
    await settle(150)
    expect(codes(a)).toEqual(['FORBIDDEN: Not subscribed'])
    expect(readsOf(s, 'a')).toBe(readsBefore)
    expect(shared(s).f1).toBe('one')
    expect(b.received).toEqual([])
    expect(written(s)).toEqual([])
  })

  it('a sender whose first change is refused and that reopens the record: what it sends afterwards is processed, not ended with the old ones', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    s.world.fieldCheckUnknownFor.add('a')
    sendUpdate(a, append(a, 'f1', '-old-1'))
    sendUpdate(a, append(a, 'f1', '-old-2'))
    await settle(80)
    // The sender loses write access: its first waiting change is refused, the second ended.
    s.world.readOnlyUsers.add('a')
    s.world.fieldCheckUnknownFor.delete('a')
    await until(() => a.errors.length === 1 && a.invalidated.length === 1, 2000, 'the refusal')
    expect(codes(a)).toEqual(['FORBIDDEN: No write access'])
    // It may write again and reopens the record on the same connection, from the shared state.
    s.world.readOnlyUsers.delete('a')
    // A client that reopens drops its old copy: the old document of this editor answers nothing more.
    a.socket.off('yjs:message')
    const reopened = new Y.Doc()
    a.socket.emit('yjs:subscribe', { recordId: RECORD })
    await settle(80)
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(s.sync.getDoc(RECORD) as Y.Doc))
    const before = Y.encodeStateVector(reopened)
    const text = reopened.getMap('fields').get('f1') as Y.Text
    reopened.transact(() => { text.insert(text.length, '-new') }, 'local')
    a.socket.emit('yjs:update', { recordId: RECORD, data: Array.from(Y.encodeStateAsUpdate(reopened, before)) })
    await until(() => shared(s).f1 === 'one-new' && record(s).f1 === 'one-new', 2000, 'the change sent after reopening')
    expect(a.errors).toHaveLength(1)
  })

  it('write access taken away while a change waits: the change is refused when it is processed, not applied on the earlier answer', async () => {
    const s = await open({ protectedMode: true })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    // The record and field checks answer yes; the session cannot be read: the change waits.
    s.harness!.facts.unreadableUsers.add('a')
    sendUpdate(a, append(a, 'f1', '-held-then-revoked'))
    await settle(120)
    expect(a.errors).toEqual([])
    s.world.readOnlyUsers.add('a')
    s.harness!.facts.unreadableUsers.delete('a')
    await until(() => a.errors.length === 1, 2000, 'the refusal')
    await settle(150)
    expect(codes(a)).toEqual(['FORBIDDEN: No write access'])
    expect(shared(s).f1).toBe('one')
    expect(b.received).toEqual([])
    expect(written(s)).toEqual([])
  })

  it('a sender that disconnects while its change waits and whose session ends meanwhile: the change is not applied', async () => {
    const s = await open({ protectedMode: true })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.harness!.facts.unreadableUsers.add('a')
    sendUpdate(a, append(a, 'f1', '-revoked-sender'))
    await settle(120)
    a.socket.close()
    await settle(60)
    s.harness!.facts.revokedUsers.add('a')
    s.harness!.facts.unreadableUsers.delete('a')
    await settle(400)
    expect(shared(s).f1).toBe('one')
    expect(b.received).toEqual([])
    expect(written(s)).toEqual([])
  })

  it('a sender that disconnects while its change waits and whose session is still current: the change is applied (control)', async () => {
    const s = await open({ protectedMode: true })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.harness!.facts.unreadableUsers.add('a')
    sendUpdate(a, append(a, 'f1', '-kept'))
    await settle(120)
    a.socket.close()
    await settle(60)
    s.harness!.facts.unreadableUsers.delete('a')
    await until(() => shared(s).f1 === 'one-kept' && b.fields().f1 === 'one-kept', 2000, 'the change of the sender that left')
  })

  it('switch on, the session of the sender cannot be read: the change waits and is processed once it can, it is not dropped', async () => {
    const s = await open({ protectedMode: true })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.harness!.facts.unreadableUsers.add('a')
    sendUpdate(a, append(a, 'f1', '-waited'))
    await settle(150)
    expect(shared(s).f1).toBe('one')
    expect(a.errors).toEqual([])
    expect(a.socket.connected).toBe(true)
    s.harness!.facts.unreadableUsers.delete('a')
    await until(() => shared(s).f1 === 'one-waited' && b.fields().f1 === 'one-waited', 2000, 'the change once the session is readable')
    expect(a.errors).toEqual([])
  })
})

describe('how long a change may wait', () => {
  it('a check that never returns: the change is refused visibly at its time, the late answer changes nothing, and nobody else waited', async () => {
    const s = await open({ adapterOptions: { heldUpdateRetryMs: 20, heldUpdateMaxMs: 150 } })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    let release: () => void = () => undefined
    s.world.readGateFor.set('a', new Promise<void>((resolve) => { release = resolve }))
    const sentAt = Date.now()
    sendUpdate(a, append(a, 'f1', '-never-answered'))
    await settle(30)
    sendUpdate(b, append(b, 'f2', '-b'))
    await until(() => shared(s).f2 === 'two-b', 1000, 'the change of the other sender')
    await until(() => a.errors.length === 1 && a.invalidated.length === 1, 2000, 'the refusal at the time bound')
    expect(Date.now() - sentAt).toBeLessThan(900)
    expect(codes(a)).toEqual(['UNAVAILABLE: Change could not be checked in time; reopen the record'])
    // The read returns at last and says yes: too late, nothing is applied.
    s.world.readGateFor.delete('a')
    release()
    await settle(250)
    expect(shared(s).f1).toBe('one')
    expect(b.received).toEqual([])
    expect(written(s)).toEqual([{ f2: 'two-b' }])
    expect(a.errors).toHaveLength(1)
  })
})

describe('the field-write check answers unknown without throwing, the way the start-up closure does', () => {
  it('when a change arrives: the change waits, it is not refused; it is processed once the check answers', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    s.world.fieldCheckUnknownFor.add('a')
    sendUpdate(a, append(a, 'f1', '-held'))
    await settle(150)
    expect(shared(s).f1).toBe('one')
    expect(b.received).toEqual([])
    expect(a.errors).toEqual([])
    expect(a.invalidated).toEqual([])
    s.world.fieldCheckUnknownFor.delete('a')
    await until(() => shared(s).f1 === 'one-held' && record(s).f1 === 'one-held', 2000, 'the change once the check answers')
    expect(a.errors).toEqual([])
  })

  it('when the write is re-checked: the write waits, the document stays, nobody is told, and it is written once the check answers', async () => {
    const s = await open({ mergeWindowMs: 150 })
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-written-later'))
    await until(() => shared(s).f1 === 'one-written-later' && b.fields().f1 === 'one-written-later')
    s.world.fieldCheckUnknownFor.add('a') // before the merge window ends: the re-check gets unknown
    await settle(350)
    expect(written(s)).toEqual([])
    expect(shared(s).f1).toBe('one-written-later')
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
    expect(s.bridge.getMetrics().deferredFlushCount).toBeGreaterThanOrEqual(1)
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
    s.world.fieldCheckUnknownFor.delete('a')
    await until(() => record(s).f1 === 'one-written-later', 2000, 'the write once the check answers')
    expect(a.invalidated).toEqual([])
  })
})

describe('switch on: what the first sync step returns', () => {
  it('nothing while read access cannot be read, and nobody is refused for it', async () => {
    const s = await open({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const asker = await editor(s, 'asker')
    // The asker is behind by one change that was made while it could not be delivered to it.
    s.world.readFailsFor.add('asker')
    sendUpdate(writer, append(writer, 'f1', '-missed'))
    await until(() => shared(s).f1 === 'one-missed')
    await settle(100)
    requestMissing(asker)
    await settle(150)
    expect(asker.fields().f1).toBe('one')
    expect(asker.errors).toEqual([])
    s.world.readFailsFor.delete('asker')
    requestMissing(asker)
    await until(() => asker.fields().f1 === 'one-missed', 2000, 'the state once read access can be read')
  })

  it('nothing to a subscriber that may no longer read every field: it loses the subscription', async () => {
    const s = await open({ protectedMode: true })
    const writer = await editor(s, 'writer')
    const masked = await editor(s, 'masked')
    s.world.readFailsFor.add('masked')
    sendUpdate(writer, append(writer, 'f1', '-missed'))
    await until(() => shared(s).f1 === 'one-missed')
    await settle(100)
    s.world.readFailsFor.delete('masked')
    s.world.maskedUsers.add('masked')
    requestMissing(masked)
    await until(() => masked.errors.length === 1, 2000, 'the refusal')
    expect(codes(masked)).toEqual(['FORBIDDEN: No read access'])
    expect(masked.fields().f1).toBe('one')
  })
})
