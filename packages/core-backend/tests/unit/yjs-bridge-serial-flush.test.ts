/**
 * The record write of a document is taken out one at a time per record.
 *
 * A write whose re-check cannot be answered is put back and re-checked later. Without an order,
 * such a write would come back with the field values it was taken out with and overwrite a later
 * value that had been written in the meantime, and nobody would be told. With one write per record
 * at a time, a later change waits behind the earlier write and is merged over it when that write
 * is put back, so what is written is always the latest value of every field, re-checked for every
 * contributor of it.
 *
 * Real Socket.IO, sync service, bridge, adapter and invalidator; only the permission reads and the
 * stores are in memory.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { settle, until } from '../helpers/realtime-protection-harness'
import { RECORD, append, change, editor, sendUpdate, shared, stage, teardown, type Stage, type StageOptions } from '../helpers/yjs-realtime-stage'

let current: Stage | null = null

async function open(options: StageOptions = {}): Promise<Stage> {
  current = await stage({
    mergeWindowMs: 60,
    ...options,
    bridgeOptions: { deferRetryMinMs: 80, deferRetryMaxMs: 160, ...(options.bridgeOptions ?? {}) },
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

function gate(): { promise: Promise<void>; open(): void; fail(error: Error): void } {
  let open_: () => void = () => undefined
  let fail_: (error: Error) => void = () => undefined
  const promise = new Promise<void>((resolve, reject) => { open_ = resolve; fail_ = reject })
  promise.catch(() => undefined)
  return { promise, open: open_, fail: fail_ }
}

describe('a write that is put back never overwrites a later value', () => {
  it('the re-check of one user hangs and then fails while another user changes the same field: one write, with the later value', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A' && b.fields().f1 === 'one-A')
    const hung = gate()
    s.world.readGate = hung.promise
    s.world.readFailsFor.add('a')
    await settle(120) // the write of a is taken out; its re-check waits on the read
    sendUpdate(b, append(b, 'f1', '-B'))
    await until(() => shared(s).f1 === 'one-A-B')
    await settle(150) // longer than the merge window: the later change is not written past the earlier one
    expect(written(s)).toEqual([])
    hung.open() // the read of a fails now: its write is put back
    await settle(30)
    s.world.readFailsFor.delete('a')
    await until(() => written(s).length >= 1, 3000, 'the write')
    await settle(250)
    expect(written(s)).toEqual([{ f1: 'one-A-B' }])
    expect(record(s).f1).toBe('one-A-B')
    expect(shared(s).f1).toBe('one-A-B')
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
    expect(s.bridge.getMetrics().flushFailureCount).toBe(0)
  })

  it('the re-checks of both users fail one after the other: nothing of either is lost, the record ends as the shared document', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A' && b.fields().f1 === 'one-A')
    const first = gate()
    s.world.readGate = first.promise
    s.world.readFailsFor.add('a')
    await settle(120)
    sendUpdate(b, append(b, 'f1', '-B'))
    await until(() => shared(s).f1 === 'one-A-B')
    s.world.readFailsFor.add('b')
    await settle(120)
    first.open()
    await settle(200) // re-checked again meanwhile, still not answerable
    expect(written(s)).toEqual([])
    s.world.readFailsFor.clear()
    await until(() => written(s).length >= 1, 3000, 'the write')
    await settle(250)
    expect(written(s)).toEqual([{ f1: 'one-A-B' }])
    expect(record(s).f1).toBe('one-A-B')
    expect(a.invalidated).toEqual([])
    expect(b.invalidated).toEqual([])
  })

  it('one user, a read that is slow and then fails on the first re-check, while the user keeps typing: one write, with everything typed', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-1'))
    await until(() => shared(s).f1 === 'one-1')
    const slow = gate()
    s.world.readGate = slow.promise
    await settle(120)
    sendUpdate(a, append(a, 'f1', '-2'))
    await until(() => shared(s).f1 === 'one-1-2')
    await settle(150)
    expect(written(s)).toEqual([])
    slow.fail(new Error('timeout exceeded when trying to connect'))
    await until(() => written(s).length >= 1, 3000, 'the write')
    await settle(250)
    expect(written(s)).toEqual([{ f1: 'one-1-2' }])
    expect(record(s).f1).toBe('one-1-2')
    expect(a.errors).toEqual([])
    expect(a.invalidated).toEqual([])
  })

  it('a later change of another field waits too and is written together with the earlier one', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A' && b.fields().f1 === 'one-A')
    const hung = gate()
    s.world.readGate = hung.promise
    await settle(120)
    sendUpdate(b, append(b, 'f2', '-B'))
    await until(() => shared(s).f2 === 'two-B')
    await settle(150)
    expect(written(s)).toEqual([])
    hung.open() // answered after all: the first write goes out, then the one that waited
    await until(() => written(s).length === 2, 3000, 'both writes')
    expect(written(s)).toEqual([{ f1: 'one-A' }, { f2: 'two-B' }])
    expect(record(s)).toMatchObject({ f1: 'one-A', f2: 'two-B' })
  })
})

describe('a write that is put back keeps who changed what', () => {
  it('its contributor loses the field while a change of somebody else is merged over it: the merged write is refused', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    const b = await editor(s, 'b')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A' && b.fields().f1 === 'one-A')
    const hung = gate()
    s.world.readGate = hung.promise
    s.world.readFailsFor.add('a')
    await settle(120)
    sendUpdate(b, append(b, 'f2', '-B'))
    await until(() => shared(s).f2 === 'two-B')
    await settle(100)
    hung.open()
    await settle(30)
    // a may no longer write f1; its reads answer again.
    s.world.forbiddenFields.set('a', new Set(['f1']))
    s.world.readFailsFor.delete('a')
    await until(() => a.invalidated.length === 1 && b.invalidated.length === 1, 3000, 'the refusal of the merged write')
    await settle(200)
    expect(written(s)).toEqual([])
    expect(record(s)).toMatchObject({ f1: 'one', f2: 'two' })
    expect(s.bridge.getMetrics().flushFailureCount).toBe(1)
  })

  it('the same connection changes another field afterwards: the field of the write that was put back is still re-checked for it', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A')
    const hung = gate()
    s.world.readGate = hung.promise
    s.world.readFailsFor.add('a')
    await settle(120)
    hung.open()
    await settle(30) // put back; now the same connection changes f2 before the retry
    s.world.readFailsFor.delete('a')
    s.world.fieldCheckUnknownFor.add('a') // keeps the retry undecided while the next change arrives
    sendUpdate(a, change(a, 'f2', 'two-A'))
    await settle(60)
    s.world.fieldCheckUnknownFor.delete('a')
    // By now a may not write f1 any more; f2 it still may.
    s.world.forbiddenFields.set('a', new Set(['f1']))
    await until(() => a.invalidated.length >= 1, 3000, 'the refusal')
    await settle(200)
    expect(written(s)).toEqual([])
    expect(record(s)).toMatchObject({ f1: 'one', f2: 'two' })
  })
})

describe('the record is free again after every way a write can end', () => {
  async function nextWriteLands(s: Stage, who: string): Promise<void> {
    const before = written(s).length
    const next = await editor(s, who)
    sendUpdate(next, change(next, 'f2', `by-${who}`))
    await until(() => written(s).length === before + 1, 3000, `the next write after ${who}`)
    expect(record(s).f2).toBe(`by-${who}`)
  }

  it('written', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => written(s).length === 1)
    await nextWriteLands(s, 'b')
  })

  it('refused', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A')
    s.world.forbiddenFields.set('a', new Set(['f1']))
    await until(() => a.invalidated.length === 1, 3000, 'the refusal')
    expect(written(s)).toEqual([])
    await nextWriteLands(s, 'b')
  })

  it('void, because the document was invalidated while the re-check ran', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A')
    const hung = gate()
    s.world.readGate = hung.promise
    await settle(120)
    await s.invalidate([RECORD])
    hung.open()
    await settle(150)
    expect(written(s)).toEqual([])
    await nextWriteLands(s, 'b')
  })

  it('nothing to write, because the builder had no record to write to', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    s.world.builderReturnsNothing = true
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A')
    await settle(200)
    expect(written(s)).toEqual([])
    s.world.builderReturnsNothing = false
    await nextWriteLands(s, 'b')
  })

  it('failed, because the record write threw', async () => {
    const s = await open()
    const a = await editor(s, 'a')
    s.world.patchFails = true
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => s.bridge.getMetrics().flushFailureCount === 1, 3000, 'the failed write')
    s.world.patchFails = false
    await nextWriteLands(s, 'b')
  })

  it('a re-check that never answers does not hold the record: it counts as not answered after its time, and its late answer changes nothing', async () => {
    const s = await open({ bridgeOptions: { recheckTimeoutMs: 150 } })
    const a = await editor(s, 'a')
    const never = gate()
    sendUpdate(a, append(a, 'f1', '-A'))
    await until(() => shared(s).f1 === 'one-A')
    s.world.readGate = never.promise
    await settle(120) // the re-check hangs on the read
    expect(written(s)).toEqual([])
    // After its time the write is put back and re-checked again; that read answers.
    await until(() => written(s).length === 1, 3000, 'the write after the timed-out re-check')
    expect(written(s)).toEqual([{ f1: 'one-A' }])
    expect(s.bridge.getMetrics().deferredFlushCount).toBeGreaterThanOrEqual(1)
    never.open() // the first re-check answers at last
    await settle(200)
    expect(written(s)).toEqual([{ f1: 'one-A' }])
    expect(a.invalidated).toEqual([])
  })
})
