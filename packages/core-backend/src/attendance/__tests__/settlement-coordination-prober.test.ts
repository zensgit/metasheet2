import { describe, expect, it } from 'vitest'

import { CoordinationWaitEndedError } from '../coordination/settlement-coordination-clock'
import {
  SettlementCoordinationProberRegistryV1,
  type SettlementCoordinationProbeTicketV1,
  type SettlementCoordinationProbeWaitResultV1,
} from '../coordination/settlement-coordination-prober'
import { ManualCoordinationClock, settle } from '../../../tests/helpers/settlement-coordination-manual-clock'

interface Tracked {
  done: boolean
  value?: SettlementCoordinationProbeWaitResultV1
  error?: unknown
}

function track(promise: Promise<SettlementCoordinationProbeWaitResultV1>): Tracked {
  const box: Tracked = { done: false }
  promise.then(
    (value) => {
      box.done = true
      box.value = value
    },
    (error) => {
      box.done = true
      box.error = error
    },
  )
  return box
}

function proberTicket(result: ReturnType<SettlementCoordinationProberRegistryV1['reportFailure']>): SettlementCoordinationProbeTicketV1 {
  if (result.role !== 'prober') throw new Error(`expected prober, got ${result.role}`)
  return result.ticket
}

describe('settlement coordination single prober per (org, family) (L-05)', () => {
  it('contention is keyed by org and family: other families and other orgs are not held up', () => {
    const registry = new SettlementCoordinationProberRegistryV1({ clock: new ManualCoordinationClock() })
    const a = Symbol('a')
    const b = Symbol('b')
    proberTicket(registry.reportFailure('org-1', 'dedicated', a))
    expect(registry.mustWait('org-1', 'dedicated', b)).toBe(true)
    expect(registry.mustWait('org-1', 'class-00', b)).toBe(false)
    expect(registry.mustWait('org-2', 'dedicated', b)).toBe(false)
    expect(registry.mustWait('org-1', 'dedicated', a)).toBe(false)
  })

  it('two units losing in the same turn make one prober and one waiter', () => {
    const registry = new SettlementCoordinationProberRegistryV1({ clock: new ManualCoordinationClock() })
    expect(registry.reportFailure('org', 'dedicated', Symbol('a')).role).toBe('prober')
    expect(registry.reportFailure('org', 'dedicated', Symbol('b')).role).toBe('waiter')
    expect(registry.snapshot()).toEqual([{ org: 'org', family: 'dedicated', epoch: 1, waiting: 0 }])
  })

  it('failure never changes the prober, and every reported result restarts the takeover clock', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock })
    const a = Symbol('a')
    const ticket = proberTicket(registry.reportFailure('org', 'dedicated', a))
    const waiter = track(registry.wait('org', 'dedicated', Symbol('b')))
    for (let i = 0; i < 5; i += 1) {
      await clock.advance(300)
      expect(registry.reportFailure('org', 'dedicated', a, ticket)).toEqual({ role: 'prober', ticket })
    }
    await clock.advance(300)
    registry.reportUndetermined(ticket)
    await clock.advance(300)
    expect(waiter.done).toBe(false)
    expect(registry.isCurrent(ticket)).toBe(true)
  })

  it('a prober leaving without success hands over to the head at once, not through the fallback (set to 5 s)', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock, takeoverMs: 5000 })
    const ticket = proberTicket(registry.reportFailure('org', 'dedicated', Symbol('a')))
    const b = Symbol('b')
    const first = track(registry.wait('org', 'dedicated', b))
    const second = track(registry.wait('org', 'dedicated', Symbol('c')))
    await settle()
    registry.handOver(ticket)
    await settle()
    // Within 50 ms in L-05's terms: here without the clock moving at all.
    expect(first.value).toMatchObject({ kind: 'prober', ticket: { epoch: 2, unit: b } })
    expect(second.done).toBe(false)
    expect(registry.isCurrent(ticket)).toBe(false)
  })

  it('a silent prober is replaced by the head after 400 ms; back with its old epoch it is only a waiter', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock })
    const a = Symbol('a')
    const old = proberTicket(registry.reportFailure('org', 'dedicated', a))
    const b = Symbol('b')
    const waiter = track(registry.wait('org', 'dedicated', b))
    await clock.advance(399)
    expect(waiter.done).toBe(false)
    await clock.advance(1)
    expect(waiter.value).toMatchObject({ kind: 'prober', ticket: { epoch: 2, unit: b } })
    const fresh = (waiter.value as { ticket: SettlementCoordinationProbeTicketV1 }).ticket
    expect(registry.reportFailure('org', 'dedicated', a, old)).toEqual({ role: 'waiter' })
    registry.reportUndetermined(old)
    registry.handOver(old)
    expect(registry.isCurrent(fresh)).toBe(true)
    expect(registry.mustWait('org', 'dedicated', a)).toBe(true)
  })

  it('units joining the queue do not postpone the takeover of a silent prober', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock })
    proberTicket(registry.reportFailure('org', 'dedicated', Symbol('a')))
    const head = track(registry.wait('org', 'dedicated', Symbol('b')))
    await clock.advance(300)
    track(registry.wait('org', 'dedicated', Symbol('c')))
    await clock.advance(99)
    track(registry.wait('org', 'dedicated', Symbol('d')))
    await clock.advance(1)
    expect(head.value?.kind).toBe('prober')
  })

  it('a hand-over with nobody waiting ends the contention', () => {
    const registry = new SettlementCoordinationProberRegistryV1({ clock: new ManualCoordinationClock() })
    const ticket = proberTicket(registry.reportFailure('org', 'dedicated', Symbol('a')))
    registry.handOver(ticket)
    expect(registry.snapshot()).toEqual([])
    expect(registry.mustWait('org', 'dedicated', Symbol('b'))).toBe(false)
  })

  it('seeing the lock free ends contention and wakes every waiter to re-enter from the top', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock })
    proberTicket(registry.reportFailure('org', 'dedicated', Symbol('a')))
    const b = track(registry.wait('org', 'dedicated', Symbol('b')))
    const c = track(registry.wait('org', 'dedicated', Symbol('c')))
    await settle()
    registry.reportFree('org', 'dedicated')
    await settle()
    expect([b.value, c.value]).toEqual([{ kind: 'retry' }, { kind: 'retry' }])
    expect(clock.pendingTimers).toBe(0)
  })

  it('k_ok true ends the dedicated contention while the class-00 contention of the same org goes on', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock })
    const a = Symbol('a')
    proberTicket(registry.reportFailure('org', 'dedicated', a))
    proberTicket(registry.reportFailure('org', 'class-00', Symbol('c')))
    const dedicatedOnly = track(registry.wait('org', 'dedicated', Symbol('b')))
    const needsClassZero = track(registry.wait('org', 'class-00', Symbol('d')))
    await settle()
    // The dedicated prober's S1: k_ok true, c_ok false.
    registry.reportFree('org', 'dedicated')
    expect(registry.reportFailure('org', 'class-00', a)).toEqual({ role: 'waiter' })
    await settle()
    expect(dedicatedOnly.value).toEqual({ kind: 'retry' })
    expect(needsClassZero.done).toBe(false)
    expect(registry.snapshot()).toEqual([{ org: 'org', family: 'class-00', epoch: 1, waiting: 1 }])
  })

  it('a waiter leaves on its deadline or abort without disturbing the order behind it', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock, takeoverMs: 10_000 })
    const ticket = proberTicket(registry.reportFailure('org', 'dedicated', Symbol('a')))
    const timed = track(registry.wait('org', 'dedicated', Symbol('b'), { deadline: 100 }))
    const controller = new AbortController()
    const aborted = track(registry.wait('org', 'dedicated', Symbol('c'), { signal: controller.signal }))
    const d = Symbol('d')
    const last = track(registry.wait('org', 'dedicated', d))
    await clock.advance(100)
    controller.abort()
    await settle()
    expect(timed.error).toBeInstanceOf(CoordinationWaitEndedError)
    expect((aborted.error as CoordinationWaitEndedError).reason).toBe('aborted')
    expect(registry.snapshot()[0].waiting).toBe(1)
    registry.handOver(ticket)
    await settle()
    expect(last.value).toMatchObject({ kind: 'prober', ticket: { unit: d } })
  })

  it('a takeover and a waiter deadline due at the same instant: the earlier one wins and nothing is lost', async () => {
    // The waiter's deadline is scheduled after the takeover timer, both due at 400: takeover first.
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock })
    proberTicket(registry.reportFailure('org', 'dedicated', Symbol('a')))
    const b = Symbol('b')
    const promoted = track(registry.wait('org', 'dedicated', b, { deadline: 400 }))
    await clock.advance(400)
    expect(promoted.value).toMatchObject({ kind: 'prober', ticket: { unit: b } })
    expect(promoted.error).toBeUndefined()
  })

  it('a state with no waiters and no news for 30 s is dropped and leaves no timer behind', async () => {
    const clock = new ManualCoordinationClock()
    const registry = new SettlementCoordinationProberRegistryV1({ clock })
    proberTicket(registry.reportFailure('org', 'dedicated', Symbol('a')))
    await clock.advance(29_999)
    expect(registry.snapshot()).toHaveLength(1)
    await clock.advance(1)
    expect(registry.snapshot()).toEqual([])
    expect(clock.pendingTimers).toBe(0)
  })

  it('a waiter that is already the prober, or a contention that is already over, resolves at once', async () => {
    const registry = new SettlementCoordinationProberRegistryV1({ clock: new ManualCoordinationClock() })
    const a = Symbol('a')
    expect(await registry.wait('org', 'dedicated', a)).toEqual({ kind: 'retry' })
    const ticket = proberTicket(registry.reportFailure('org', 'dedicated', a))
    expect(await registry.wait('org', 'dedicated', a)).toEqual({ kind: 'prober', ticket })
  })
})
