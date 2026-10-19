import { describe, expect, it } from 'vitest'

import { settlementCoordinationBackoffMsV1 } from '../coordination/settlement-coordination-backoff'
import {
  SETTLEMENT_COORDINATION_BACKGROUND_QUOTA_WAIT_MS,
  SETTLEMENT_COORDINATION_REQUEST_BUDGET_MS,
  SettlementCoordinationBudgetV1,
} from '../coordination/settlement-coordination-budget'
import {
  deriveSettlementCoordinationCapacityV1,
  validateSettlementCoordinationCapacityV1,
} from '../coordination/settlement-coordination-capacity'
import { CoordinationWaitEndedError, createSystemCoordinationClockV1 } from '../coordination/settlement-coordination-clock'
import { SettlementCoordinationQuotaV1 } from '../coordination/settlement-coordination-quota'
import { CoordinationSemaphoreV1, type CoordinationPermitV1 } from '../coordination/settlement-coordination-semaphore'
import { ManualCoordinationClock, settle } from '../../../tests/helpers/settlement-coordination-manual-clock'

describe('settlement coordination capacity (§3.6)', () => {
  it('derives the documented defaults for a pool of 20', () => {
    expect(deriveSettlementCoordinationCapacityV1({ poolMax: 20 })).toEqual({
      poolMax: 20,
      exclusiveSlots: 2,
      scanSlots: 1,
      longTxnSlots: 2,
      orgLongTxnSlots: 1,
      reservedConnections: 4,
      txnSlots: 11,
      orgTxnSlots: 6,
    })
  })

  it('takes one long-transaction slot when the pool is below 16', () => {
    expect(deriveSettlementCoordinationCapacityV1({ poolMax: 16 }).longTxnSlots).toBe(2)
    const small = deriveSettlementCoordinationCapacityV1({ poolMax: 15 })
    expect(small).toMatchObject({ longTxnSlots: 1, txnSlots: 7, orgTxnSlots: 4 })
    expect(deriveSettlementCoordinationCapacityV1({ poolMax: 10 })).toMatchObject({ longTxnSlots: 1, txnSlots: 2, orgTxnSlots: 1 })
  })

  it('lets explicit values win over derived ones', () => {
    expect(deriveSettlementCoordinationCapacityV1({ poolMax: 20, txnSlots: 8, orgTxnSlots: 8 })).toMatchObject({ txnSlots: 8, orgTxnSlots: 8 })
  })

  it('reports, without throwing, every startup condition a configuration breaks', () => {
    expect(validateSettlementCoordinationCapacityV1(deriveSettlementCoordinationCapacityV1({ poolMax: 20 }))).toEqual([])
    const broken = deriveSettlementCoordinationCapacityV1({ poolMax: 9 })
    expect(() => validateSettlementCoordinationCapacityV1(broken)).not.toThrow()
    expect(validateSettlementCoordinationCapacityV1(broken).join('\n')).toMatch(/txnSlots/)
    expect(validateSettlementCoordinationCapacityV1(deriveSettlementCoordinationCapacityV1({ poolMax: 20, reservedConnections: 3 })).join('\n')).toMatch(/at least 4/)
    expect(validateSettlementCoordinationCapacityV1(deriveSettlementCoordinationCapacityV1({ poolMax: 20, orgTxnSlots: 12 })).join('\n')).toMatch(/must not exceed/)
    expect(validateSettlementCoordinationCapacityV1(deriveSettlementCoordinationCapacityV1({ poolMax: 20, txnSlots: 12 })).join('\n')).toMatch(/exceeds poolMax/)
  })
})

describe('coordination semaphore: first come first served, atomic grant and cancel', () => {
  async function queued(semaphore: CoordinationSemaphoreV1, clock: ManualCoordinationClock, label: string, order: string[], deadline?: number) {
    const permit = semaphore.acquire({ clock, deadline }).then((p) => {
      order.push(label)
      return p
    })
    await settle()
    return permit
  }

  it('grants in arrival order and never lets tryAcquire overtake a waiter', async () => {
    const clock = new ManualCoordinationClock()
    const semaphore = new CoordinationSemaphoreV1(1)
    const first = semaphore.tryAcquire() as CoordinationPermitV1
    const order: string[] = []
    const a = queued(semaphore, clock, 'a', order)
    const b = queued(semaphore, clock, 'b', order)
    await settle()
    expect(semaphore.waiting).toBe(2)
    expect(semaphore.tryAcquire()).toBeNull()
    first.release()
    ;(await a).release()
    ;(await b).release()
    expect(order).toEqual(['a', 'b'])
    expect(semaphore.held).toBe(0)
  })

  it('a waiter whose deadline passes leaves the queue and the order behind it is kept', async () => {
    const clock = new ManualCoordinationClock()
    const semaphore = new CoordinationSemaphoreV1(1)
    const holder = semaphore.tryAcquire() as CoordinationPermitV1
    const order: string[] = []
    const a = semaphore.acquire({ clock, deadline: 50 })
    const aFailed = a.then(() => 'granted', (error) => error)
    const b = queued(semaphore, clock, 'b', order, 500)
    await clock.advance(60)
    expect(await aFailed).toBeInstanceOf(CoordinationWaitEndedError)
    expect(semaphore.waiting).toBe(1)
    holder.release()
    ;(await b).release()
    expect(order).toEqual(['b'])
    expect(semaphore.held).toBe(0)
    expect(clock.pendingTimers).toBe(0)
  })

  it('an aborted waiter leaves the queue with an aborted error', async () => {
    const clock = new ManualCoordinationClock()
    const semaphore = new CoordinationSemaphoreV1(1)
    const holder = semaphore.tryAcquire() as CoordinationPermitV1
    const controller = new AbortController()
    const waiting = semaphore.acquire({ clock, signal: controller.signal }).then(() => 'granted', (error) => error)
    await settle()
    controller.abort()
    expect(await waiting).toMatchObject({ reason: 'aborted' })
    expect(semaphore.waiting).toBe(0)
    holder.release()
    expect(semaphore.held).toBe(0)
  })

  it('release and deadline in the same turn: a permit granted first stays granted; a waiter cancelled first loses nothing', async () => {
    // Ordering 1: the waiter's deadline timer is due first (same instant, scheduled earlier), so it is
    // cancelled, and the holder's release returns the permit to the pool instead of to a cancelled waiter.
    const clock = new ManualCoordinationClock()
    const semaphore = new CoordinationSemaphoreV1(1)
    const holder = semaphore.tryAcquire() as CoordinationPermitV1
    const cancelled = semaphore.acquire({ clock, deadline: 100 }).then(() => 'granted', (error) => error)
    clock.setTimer(100, () => holder.release())
    await clock.advance(100)
    expect(await cancelled).toBeInstanceOf(CoordinationWaitEndedError)
    expect(semaphore.held).toBe(0)
    expect(semaphore.waiting).toBe(0)

    // Ordering 2: the release is due first, so the permit is granted and the waiter's deadline timer
    // is cancelled with it; the waiter receives the permit even though its deadline instant passes.
    const clock2 = new ManualCoordinationClock()
    const semaphore2 = new CoordinationSemaphoreV1(1)
    const holder2 = semaphore2.tryAcquire() as CoordinationPermitV1
    clock2.setTimer(100, () => holder2.release())
    const late = semaphore2.acquire({ clock: clock2, deadline: 100 })
    await clock2.advance(100)
    const permit = await late
    expect(semaphore2.held).toBe(1)
    permit.release()
    expect(semaphore2.held).toBe(0)
  })

  it('a permit says whether it was handed over after queueing', async () => {
    const clock = new ManualCoordinationClock()
    const semaphore = new CoordinationSemaphoreV1(1)
    const immediate = await semaphore.acquire({ clock })
    expect(immediate.queued).toBe(false)
    const waited = semaphore.acquire({ clock })
    await settle()
    immediate.release()
    const handedOver = await waited
    expect(handedOver.queued).toBe(true)
    handedOver.release()
  })

  it('a permit cannot be released twice', () => {
    const permit = new CoordinationSemaphoreV1(1).tryAcquire() as CoordinationPermitV1
    permit.release()
    expect(() => permit.release()).toThrow(/twice/)
  })
})

describe('settlement coordination quota: org first, global second; global back first', () => {
  const capacity = deriveSettlementCoordinationCapacityV1({ poolMax: 20, txnSlots: 2, orgTxnSlots: 1 })

  it('a unit blocked on its org quota takes no global quota', async () => {
    const clock = new ManualCoordinationClock()
    const quota = new SettlementCoordinationQuotaV1(capacity)
    const first = await quota.acquire('org-a', 'short', { clock })
    const second = quota.acquire('org-a', 'short', { clock })
    await settle()
    expect(quota.snapshot().global.short).toEqual({ held: 1, waiting: 0 })
    expect(quota.snapshot().orgs).toEqual([{ org: 'org-a', quotaClass: 'short', held: 1, waiting: 1 }])
    first.release()
    ;(await second).release()
    expect(quota.snapshot()).toEqual({ global: { short: { held: 0, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [] })
  })

  it('a unit waiting for the global quota holds only its org quota, and gives it back when the wait ends', async () => {
    const clock = new ManualCoordinationClock()
    const quota = new SettlementCoordinationQuotaV1(capacity)
    const a = await quota.acquire('org-a', 'short', { clock })
    const b = await quota.acquire('org-b', 'short', { clock })
    const c = quota.acquire('org-c', 'short', { clock, deadline: 100 }).then(() => 'granted', (error) => error)
    await settle()
    expect(quota.snapshot().orgs.find((entry) => entry.org === 'org-c')).toEqual({ org: 'org-c', quotaClass: 'short', held: 1, waiting: 0 })
    expect(quota.snapshot().global.short).toEqual({ held: 2, waiting: 1 })
    await clock.advance(100)
    expect(await c).toBeInstanceOf(CoordinationWaitEndedError)
    expect(quota.snapshot().orgs.map((entry) => entry.org).sort()).toEqual(['org-a', 'org-b'])
    a.release()
    b.release()
    expect(quota.snapshot().global.short).toEqual({ held: 0, waiting: 0 })
  })

  it('a released lease serves waiters in arrival order: another org\'s global waiter is served before the same org\'s next unit', async () => {
    const clock = new ManualCoordinationClock()
    const quota = new SettlementCoordinationQuotaV1(capacity)
    const order: string[] = []
    const a1 = await quota.acquire('org-a', 'short', { clock })
    const b1 = await quota.acquire('org-b', 'short', { clock })
    const c1 = quota.acquire('org-c', 'short', { clock }).then((lease) => (order.push('c1'), lease))
    await settle()
    const a2 = quota.acquire('org-a', 'short', { clock }).then((lease) => (order.push('a2'), lease))
    await settle()
    a1.release() // global → c1 (queued first), then org-a → a2, which now queues for global behind nobody
    await settle()
    expect(order).toEqual(['c1'])
    b1.release()
    await settle()
    expect(order).toEqual(['c1', 'a2'])
    ;(await c1).release()
    ;(await a2).release()
    expect(quota.snapshot().orgs).toEqual([])
  })

  it('short and long transactions use separate quotas, and a long one is limited to one per org', async () => {
    const clock = new ManualCoordinationClock()
    const quota = new SettlementCoordinationQuotaV1(deriveSettlementCoordinationCapacityV1({ poolMax: 20 }))
    const long1 = await quota.acquire('org-a', 'long', { clock })
    const long2 = quota.acquire('org-a', 'long', { clock, deadline: 10 }).then(() => 'granted', (error) => error)
    const short = await quota.acquire('org-a', 'short', { clock })
    await clock.advance(10)
    expect(await long2).toBeInstanceOf(CoordinationWaitEndedError)
    expect(quota.snapshot().global).toEqual({ short: { held: 1, waiting: 0 }, long: { held: 1, waiting: 0 } })
    long1.release()
    short.release()
  })

  it('a lease is queued when either level made the unit wait', async () => {
    const clock = new ManualCoordinationClock()
    const quota = new SettlementCoordinationQuotaV1(capacity)
    const first = await quota.acquire('org-a', 'short', { clock })
    expect(first.queued).toBe(false)
    // Queued at the org level.
    const second = quota.acquire('org-a', 'short', { clock })
    await settle()
    first.release()
    const lease = await second
    expect(lease.queued).toBe(true)
    // Org free at once, queued at the global level (capacity: 2 global permits).
    const other = await quota.acquire('org-b', 'short', { clock })
    const third = quota.acquire('org-c', 'short', { clock })
    await settle()
    other.release()
    const globalOnly = await third
    expect(globalOnly.queued).toBe(true)
    globalOnly.release()
    lease.release()
  })

  it('a lease cannot be released twice', async () => {
    const lease = await new SettlementCoordinationQuotaV1(capacity).acquire('org-a', 'short', { clock: new ManualCoordinationClock() })
    lease.release()
    expect(() => lease.release()).toThrow(/twice/)
  })
})

describe('settlement coordination budget (§3.2 step 9)', () => {
  it('is spent only by recorded waits and names the stage that waited longest', async () => {
    const clock = new ManualCoordinationClock()
    const budget = new SettlementCoordinationBudgetV1({ clock })
    expect(budget.limitMs).toBe(SETTLEMENT_COORDINATION_REQUEST_BUDGET_MS)
    budget.record('quota', 300)
    budget.record('dedicated', 1200)
    budget.record('connect', 900)
    // Time that passes outside the recorded waits (business, cleanup, the outer loop) spends nothing.
    await clock.advance(60_000)
    expect(budget.spentMs).toBe(2400)
    expect(budget.remaining()).toBe(2600)
    budget.record('dedicated', 2599)
    expect(budget.exhausted()).toBe(false)
    budget.record('dedicated', 1)
    expect(budget.exhausted()).toBe(true)
    expect(budget.remaining()).toBe(0)
    expect(budget.exhaustionCode()).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
    // dedicated now holds 3800 ms: an equal class-00 wait loses the tie, a longer one wins.
    budget.record('class-00', 3800)
    expect(budget.exhaustionCode()).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
    budget.record('class-00', 1)
    expect(budget.exhaustionCode()).toBe('ATTENDANCE_CALCULATION_ROLLOUT_BUSY')
  })

  it('a wait that starts now may run until what remains is spent', async () => {
    const clock = new ManualCoordinationClock()
    const budget = new SettlementCoordinationBudgetV1({ clock })
    budget.record('connect', 1000)
    await clock.advance(7000)
    expect(budget.deadline()).toBe(7000 + 4000)
    expect(budget.quotaDeadline()).toBe(budget.deadline())
  })

  it('maps quota and connection stages to their codes and breaks ties in a fixed order', () => {
    const clock = new ManualCoordinationClock()
    const budget = new SettlementCoordinationBudgetV1({ clock })
    budget.record('connect', 10)
    expect(budget.exhaustionCode()).toBe('ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE')
    budget.record('quota', 10)
    expect(budget.exhaustionCode()).toBe('ATTENDANCE_COORDINATION_CAPACITY_BUSY')
  })

  it('background units do not count quota waits and cap each quota wait at 30 s', async () => {
    const clock = new ManualCoordinationClock()
    await clock.advance(1000)
    const budget = new SettlementCoordinationBudgetV1({ clock, background: true })
    expect(budget.quotaDeadline()).toBe(1000 + SETTLEMENT_COORDINATION_BACKGROUND_QUOTA_WAIT_MS)
    budget.record('quota', 20_000)
    expect(budget.waits().quota).toBe(0)
    expect(budget.spentMs).toBe(0)
    expect(budget.remaining()).toBe(5000)
    const request = new SettlementCoordinationBudgetV1({ clock })
    request.record('quota', 20)
    expect(request.waits().quota).toBe(20)
    expect(request.remaining()).toBe(4980)
  })
})

describe('settlement coordination backoff (§3.2 step 3)', () => {
  it('starts at 25 ms, doubles, caps at 200 ms, then applies ±50% jitter', () => {
    const middle = () => 0.5
    expect([1, 2, 3, 4, 5, 9].map((retry) => settlementCoordinationBackoffMsV1(retry, middle, 10_000))).toEqual([25, 50, 100, 200, 200, 200])
    expect(settlementCoordinationBackoffMsV1(4, () => 0, 10_000)).toBe(100)
    expect(settlementCoordinationBackoffMsV1(4, () => 0.999_999, 10_000)).toBeLessThan(300)
    expect(settlementCoordinationBackoffMsV1(1, () => 0, 10_000)).toBe(12.5)
  })

  it('never sleeps past the remaining budget', () => {
    expect(settlementCoordinationBackoffMsV1(4, () => 0.9, 40)).toBe(40)
    expect(settlementCoordinationBackoffMsV1(4, () => 0.9, 0)).toBe(0)
  })
})

describe('system coordination clock', () => {
  it('its timers never keep the process alive, and cancel clears them', async () => {
    const original = globalThis.setTimeout
    const handles: Array<{ hasRef?: () => boolean }> = []
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const handle = original(fn, ms)
      handles.push(handle as unknown as { hasRef?: () => boolean })
      return handle
    }) as unknown as typeof setTimeout
    const controller = new AbortController()
    try {
      const clock = createSystemCoordinationClockV1()
      const timer = clock.setTimer(60_000, () => undefined)
      const sleeping = clock.sleep(60_000, controller.signal).then(() => 'slept', (error) => error)
      expect(handles).toHaveLength(2)
      expect(handles.map((handle) => handle.hasRef?.())).toEqual([false, false])
      timer.cancel()
      controller.abort()
      expect(await sleeping).toMatchObject({ reason: 'aborted' })
    } finally {
      globalThis.setTimeout = original
    }
  })
})
