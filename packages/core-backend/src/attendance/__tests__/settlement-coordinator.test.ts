import { describe, expect, it } from 'vitest'

import {
  AttendanceCoordinationConnectionUncertainError,
  commitSettlementCoordinationTransactionV1,
} from '../coordination/settlement-coordination-handover'
import { SettlementCoordinationLedgerV1 } from '../coordination/settlement-coordination-ledger'
import {
  SettlementCoordinationAbortedError,
  SettlementCoordinationAcquireError,
  SettlementCoordinationScopeChangedError,
  shouldLogSettlementCoordinationAttemptV1,
  type SettlementCoordinationAttemptRecordV1,
  type SettlementCoordinationHandleV1,
} from '../coordination/settlement-coordinator'
import { settle } from '../../../tests/helpers/settlement-coordination-manual-clock'
import { ORG, REQUEST, serializationError, setupFakeCoordination as setup, track } from '../../../tests/helpers/settlement-coordination-fakes'

describe('settlement coordinator: order of an attempt', () => {
  it('takes org then global quota before borrowing, hands over, and gives everything back on end', async () => {
    const { pool, coordinator, quota, ledger, records, baseline } = setup()
    const seenAtConnect: unknown[] = []
    pool.onConnect = () => seenAtConnect.push(quota.snapshot())
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    expect(seenAtConnect).toEqual([{ global: { short: { held: 1, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [{ org: ORG, quotaClass: 'short', held: 1, waiting: 0 }] }])
    expect(pool.clients[0].calls[0]).toMatch(/^SELECT idle/)
    expect(pool.clients[0].calls[1]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE')
    expect(pool.clients[0].calls[2]).toMatch(/^SELECT x_k/)
    expect(ledger.snapshot().holding).toEqual([{ quotaClass: 'short', lease: true, client: true }])
    // The connection goes back while both quotas are still held.
    const heldAtRelease: unknown[] = []
    pool.clients[0].onRelease = () => heldAtRelease.push(quota.snapshot().global.short.held)
    handle.end()
    expect(heldAtRelease).toEqual([1])
    expect(pool.clients[0].released).toEqual([null])
    expect(() => handle.end()).toThrow(/twice/)
    unit.close()
    baseline()
    expect(records.map((record) => record.outcome)).toEqual(['handed-over'])
    expect(records[0].events.map((event) => event.kind)).toEqual(['quota', 'connect', 's1', 'handover'])
    expect(shouldLogSettlementCoordinationAttemptV1(records[0])).toBe(false)
  })

  it('refuses overlapping acquisitions and a close that would strand an attempt', async () => {
    const { coordinator, baseline, pool } = setup()
    const unit = coordinator.openUnit(REQUEST)
    await unit.acquire(ORG)
    await expect(unit.acquire(ORG)).rejects.toThrow(/overlapping/)
    expect(() => unit.close()).toThrow(/closed while holding/)
    expect(pool.clients[0].released[0]).toBeInstanceOf(Error)
    baseline()
  })

  it('an invalid org fails before any quota or connection is taken', async () => {
    const { coordinator, pool, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    await expect(unit.acquire(' padded ')).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_ORG_INVALID' })
    expect(pool.connects).toBe(0)
    unit.close()
    baseline()
  })
})

describe('settlement coordinator: contention', () => {
  it('a lost try gives the connection and both quotas back before backing off', async () => {
    const { clock, world, pool, coordinator, quota, ledger, baseline, records } = setup()
    world.dedicatedBusy = true
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await settle()
    // Backing off now: nothing held.
    expect(world.s1Count).toBe(1)
    expect(pool.clients[0].released).toEqual([null])
    expect(quota.snapshot().global.short.held).toBe(0)
    expect(ledger.snapshot().holding).toEqual([])
    world.dedicatedBusy = false
    await clock.advance(25)
    expect(acquiring.done).toBe(true)
    ;(acquiring.value as { end(): void }).end()
    unit.close()
    baseline()
    expect(records[0].events.map((event) => event.kind)).toEqual(['quota', 'connect', 's1', 'released', 'backoff', 'quota', 'connect', 's1', 'handover'])
    expect(shouldLogSettlementCoordinationAttemptV1(records[0])).toBe(true)
  })

  it('one prober per (org, family): other units of the org wait without quota or connections', async () => {
    const { clock, world, pool, coordinator, quota, baseline } = setup()
    world.dedicatedBusy = true
    const a = coordinator.openUnit(REQUEST)
    const b = coordinator.openUnit(REQUEST)
    const otherOrg = coordinator.openUnit(REQUEST)
    const acquiringA = track(a.acquire(ORG))
    await settle()
    const acquiringB = track(b.acquire(ORG))
    await settle()
    // B waits: it took no quota and borrowed nothing.
    expect(pool.connects).toBe(1)
    expect(quota.snapshot().global.short.held).toBe(0)
    // A different org is not held up.
    world.dedicatedBusy = false
    const handleOther = await otherOrg.acquire('legacy-org-elsewhere')
    handleOther.end()
    world.dedicatedBusy = true
    // The prober keeps trying, B keeps waiting.
    await clock.advance(25)
    expect(world.s1Count).toBe(3)
    expect(acquiringB.done).toBe(false)
    world.dedicatedBusy = false
    await clock.advance(50)
    expect(acquiringA.done).toBe(true)
    ;(acquiringA.value as { end(): void }).end()
    await settle()
    expect(acquiringB.done).toBe(true)
    ;(acquiringB.value as { end(): void }).end()
    a.close()
    b.close()
    otherOrg.close()
    baseline()
  })

  it('k_ok true with class-00 lost: units needing only the dedicated family go on, units needing class-00 wait', async () => {
    const { clock, world, pool, coordinator, prober, baseline } = setup()
    world.classZeroBusy = true
    const both = coordinator.openUnit(REQUEST)
    const acquiringBoth = track(both.acquire(ORG))
    await settle()
    expect(prober.snapshot()).toEqual([{ org: ORG, family: 'class-00', epoch: 1, waiting: 0 }])
    // Needs only the dedicated family: not held up by the class-00 contention.
    const dedicatedOnly = coordinator.openUnit({ ...REQUEST, needsClassZero: false })
    const handle = await dedicatedOnly.acquire(ORG)
    handle.end()
    dedicatedOnly.close()
    // Needs class-00: waits for the prober's result without borrowing.
    const alsoClassZero = coordinator.openUnit(REQUEST)
    const connectsBefore = pool.connects
    const acquiringAlso = track(alsoClassZero.acquire(ORG))
    await settle()
    expect(pool.connects).toBe(connectsBefore)
    expect(prober.snapshot()).toEqual([{ org: ORG, family: 'class-00', epoch: 1, waiting: 1 }])
    world.classZeroBusy = false
    await clock.advance(25)
    expect(acquiringBoth.done).toBe(true)
    ;(acquiringBoth.value as { end(): void }).end()
    await settle()
    expect(acquiringAlso.done).toBe(true)
    ;(acquiringAlso.value as { end(): void }).end()
    both.close()
    alsoClassZero.close()
    baseline()
  })

  it('a unit probing the dedicated family keeps probing it while someone else probes class-00 (S2 choice 4)', async () => {
    const { clock, world, coordinator, prober, baseline } = setup({ takeoverMs: 60_000 })
    world.classZeroBusy = true
    const b = coordinator.openUnit(REQUEST)
    const acquiringB = track(b.acquire(ORG))
    await settle()
    expect(prober.snapshot()).toEqual([{ org: ORG, family: 'class-00', epoch: 1, waiting: 0 }])
    world.dedicatedBusy = true
    const controller = new AbortController()
    const c = coordinator.openUnit({ ...REQUEST, needsClassZero: false, signal: controller.signal })
    const acquiringC = track(c.acquire(ORG))
    await settle()
    const a = coordinator.openUnit(REQUEST)
    const acquiringA = track(a.acquire(ORG))
    await settle()
    expect(prober.snapshot()).toEqual(expect.arrayContaining([{ org: ORG, family: 'dedicated', epoch: 1, waiting: 1 }]))
    const triesBefore = world.s1Count
    // C leaves: the dedicated probe goes to A, the head of its queue.
    controller.abort()
    await settle()
    expect(acquiringC.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    // A probes the dedicated family at once, although class-00 is still B's to probe.
    expect(world.s1Count).toBe(triesBefore + 1)
    expect(prober.snapshot()).toEqual(expect.arrayContaining([{ org: ORG, family: 'dedicated', epoch: 2, waiting: 0 }]))
    world.dedicatedBusy = false
    world.classZeroBusy = false
    await clock.advance(1000)
    expect(acquiringA.done).toBe(true)
    expect(acquiringB.done).toBe(true)
    ;(acquiringA.value as { end(): void }).end()
    ;(acquiringB.value as { end(): void }).end()
    a.close()
    b.close()
    c.close()
    baseline()
  })

  it('a one-shot caller tries once and leaves no contention behind', async () => {
    const { world, coordinator, prober, baseline } = setup()
    world.dedicatedBusy = true
    const unit = coordinator.openUnit({ ...REQUEST, oneShot: true })
    await expect(unit.acquire(ORG)).rejects.toMatchObject({ code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY' })
    expect(prober.snapshot()).toEqual([])
    unit.close()
    baseline()
  })

  it('a one-shot caller that succeeds leaves an existing contention alone (Fable S2 NIT-1)', async () => {
    const { clock, world, coordinator, prober, baseline } = setup({ takeoverMs: 60_000 })
    world.dedicatedBusy = true
    const a = coordinator.openUnit(REQUEST)
    const b = coordinator.openUnit(REQUEST)
    const acquiringA = track(a.acquire(ORG))
    await settle()
    const acquiringB = track(b.acquire(ORG))
    await settle()
    expect(prober.snapshot()).toEqual([{ org: ORG, family: 'dedicated', epoch: 1, waiting: 1 }])
    // The scanner happens to see the lock free on its single try.
    world.s1Script.push({ idle: true, k_ok: true, c_ok: true, k_undo: null })
    const oneShot = coordinator.openUnit({ ...REQUEST, oneShot: true })
    const handle = await oneShot.acquire(ORG)
    handle.end()
    oneShot.close()
    // Neither made, read nor ended: B still waits for the prober.
    expect(prober.snapshot()).toEqual([{ org: ORG, family: 'dedicated', epoch: 1, waiting: 1 }])
    expect(acquiringB.done).toBe(false)
    world.dedicatedBusy = false
    await clock.advance(25)
    expect(acquiringA.done).toBe(true)
    ;(acquiringA.value as { end(): void }).end()
    await settle()
    expect(acquiringB.done).toBe(true)
    ;(acquiringB.value as { end(): void }).end()
    a.close()
    b.close()
    baseline()
  })

  it('an uncertain S1 destroys the connection, returns the quota and hands the probe over', async () => {
    const { clock, world, pool, coordinator, prober, baseline } = setup()
    world.dedicatedBusy = true
    const a = coordinator.openUnit(REQUEST)
    const b = coordinator.openUnit(REQUEST)
    const acquiringA = track(a.acquire(ORG))
    await settle()
    const acquiringB = track(b.acquire(ORG))
    await settle()
    world.s1Script.push({ idle: false, k_ok: null, c_ok: null, k_undo: null })
    await clock.advance(25)
    expect(acquiringA.error).toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    expect(pool.clients[1].released[0]).toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    // B was handed the probe and tries at once.
    expect(prober.snapshot()).toEqual([{ org: ORG, family: 'dedicated', epoch: 2, waiting: 0 }])
    world.dedicatedBusy = false
    await clock.advance(25)
    expect(acquiringB.done).toBe(true)
    ;(acquiringB.value as { end(): void }).end()
    a.close()
    b.close()
    baseline()
  })
})

describe('settlement coordinator: connect race and late connections', () => {
  it('a connect that loses the race keeps its quota until it settles; a late client is released, then the quota returns', async () => {
    const { clock, pool, coordinator, quota, ledger, baseline } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(1000)
    expect((acquiring.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE')
    expect(quota.snapshot().global.short.held).toBe(1)
    expect(ledger.snapshot().abandoned.short).toBe(1)
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
    const late = pool.pending[0].succeed()
    await settle()
    expect(late.released).toEqual([null])
    unit.close()
    baseline()
  })

  it('a late client is released while its quota is still held, and only then does the quota return (exec doc §5.5)', async () => {
    const { clock, pool, coordinator, quota, baseline } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(1000)
    expect(acquiring.done).toBe(true)
    const late = pool.pending[0].succeed()
    const heldAtRelease: number[] = []
    late.onRelease = () => heldAtRelease.push(quota.snapshot().global.short.held)
    await settle()
    expect(late.released).toEqual([null])
    expect(heldAtRelease).toEqual([1])
    unit.close()
    baseline()
  })

  it('a late connect failure returns the quota', async () => {
    const { clock, pool, coordinator, baseline } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(1000)
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAcquireError)
    pool.pending[0].fail(new Error('test: connect refused'))
    await settle()
    unit.close()
    baseline()
  })

  it('the race is bounded by the remaining budget when that is shorter than the connect timeout', async () => {
    const { clock, pool, coordinator } = setup({ connectTimeoutMs: 10_000 })
    pool.manual = true
    const unit = coordinator.openUnit({ ...REQUEST, budgetMs: 300 })
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(299)
    expect(acquiring.done).toBe(false)
    await clock.advance(1)
    expect((acquiring.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE')
    pool.pending[0].succeed()
    await settle()
    unit.close()
  })

  it('a connect error returns the quota at once and fails as unavailable', async () => {
    const { pool, coordinator, baseline } = setup()
    pool.connect = () => Promise.reject(new Error('test: pool closed'))
    const unit = coordinator.openUnit(REQUEST)
    await expect(unit.acquire(ORG)).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE' })
    unit.close()
    baseline()
  })

  it('an abort while the connect races: the late client is released and the quota returns', async () => {
    const { pool, coordinator, quota, ledger, baseline } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const controller = new AbortController()
    const unit = coordinator.openUnit({ ...REQUEST, signal: controller.signal })
    const acquiring = track(unit.acquire(ORG))
    await settle()
    expect(pool.pending).toHaveLength(1)
    controller.abort()
    await settle()
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(quota.snapshot().global.short.held).toBe(1)
    expect(ledger.snapshot().abandoned.short).toBe(1)
    const late = pool.pending[0].succeed()
    await settle()
    expect(late.released).toEqual([null])
    unit.close()
    baseline()
  })

  it('the candidate short read borrows outside quota, is counted against the budget, and destroys on error', async () => {
    const { clock, pool, coordinator, quota, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const seen: number[] = []
    const reading = unit.readCandidate(async (client) => {
      seen.push(quota.snapshot().global.short.held)
      await client.query('SELECT 1')
      await clock.sleep(120)
      return 'candidate-org'
    })
    await clock.advance(120)
    expect(await reading).toBe('candidate-org')
    expect(seen).toEqual([0])
    expect(unit.budget.waits().connect).toBe(120)
    expect(unit.budget.remaining()).toBe(5000 - 120)
    expect(pool.clients[0].released).toEqual([null])
    await expect(unit.readCandidate(async () => Promise.reject(new Error('test: read failed')))).rejects.toThrow(/read failed/)
    expect(pool.clients[1].released[0]).toBeInstanceOf(Error)
    unit.close()
    baseline()
  })
})

describe('settlement coordinator: the budget counts coordination waits only (§3.2 step 9)', () => {
  it('business time between the handover and a restart spends nothing: the restart re-acquires (Fable S2 P1-1, Codex S2 P2-1)', async () => {
    const { clock, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    // The business transaction runs for 6 s; nothing is waited for.
    await clock.advance(6000)
    await unit.restart(first, { reason: 'serialization', transaction: 'live', error: serializationError('1') })
    expect(unit.budget.spentMs).toBe(0)
    expect(unit.budget.waits()).toEqual({ 'class-00': 0, dedicated: 0, quota: 0, connect: 0, cleaning: 0 })
    const second = await unit.acquire(ORG)
    expect(second.attempt).toBe(2)
    second.end()
    unit.close()
    baseline()
  })

  it('the outer loop\'s jitter sleep spends nothing (§3.2 step 8(c))', async () => {
    const { clock, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    await unit.restart(first, { reason: 'serialization', transaction: 'live', error: serializationError('1') })
    unit.beginOuterAttempt()
    await clock.advance(5000)
    const second = await unit.acquire(ORG)
    expect(unit.budget.remaining()).toBe(5000)
    second.end()
    unit.close()
    baseline()
  })

  it('a unit waiting for the prober runs out of budget with the family it waited for', async () => {
    const { clock, world, coordinator, baseline } = setup({ takeoverMs: 60_000 })
    world.dedicatedBusy = true
    const a = coordinator.openUnit(REQUEST)
    const acquiringA = track(a.acquire(ORG))
    await settle()
    const b = coordinator.openUnit(REQUEST)
    const acquiringB = track(b.acquire(ORG))
    await clock.advance(5000)
    expect((acquiringB.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
    expect((acquiringA.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
    a.close()
    b.close()
    baseline()
  })

  it('waiting on or probing class-00 until the budget runs out names the W4 family', async () => {
    const { clock, world, coordinator, baseline } = setup({ takeoverMs: 60_000 })
    world.classZeroBusy = true
    const a = coordinator.openUnit(REQUEST)
    const acquiringA = track(a.acquire(ORG))
    await settle()
    const b = coordinator.openUnit(REQUEST)
    const acquiringB = track(b.acquire(ORG))
    await clock.advance(5000)
    expect((acquiringB.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_CALCULATION_ROLLOUT_BUSY')
    expect((acquiringA.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_CALCULATION_ROLLOUT_BUSY')
    a.close()
    b.close()
    baseline()
  })

  it('a request unit waiting for quota runs out of budget as capacity busy; a background unit waits up to 30 s outside its budget', async () => {
    const { clock, coordinator, baseline } = setup({ txnSlots: 2, orgTxnSlots: 1 })
    const holder = coordinator.openUnit(REQUEST)
    const held = await holder.acquire(ORG)
    const request = coordinator.openUnit(REQUEST)
    const waitingRequest = track(request.acquire(ORG))
    const background = coordinator.openUnit({ ...REQUEST, background: true })
    const waitingBackground = track(background.acquire(ORG))
    await clock.advance(5000)
    expect((waitingRequest.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_COORDINATION_CAPACITY_BUSY')
    expect(waitingBackground.done).toBe(false)
    await clock.advance(25_000)
    expect((waitingBackground.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_COORDINATION_CAPACITY_BUSY')
    expect(background.budget.remaining()).toBe(5000)
    held.end()
    holder.close()
    request.close()
    background.close()
    baseline()
  })

  it('an abort while backing off ends the unit with nothing held and hands the probe over', async () => {
    const { world, coordinator, prober, baseline } = setup()
    world.dedicatedBusy = true
    const controller = new AbortController()
    const unit = coordinator.openUnit({ ...REQUEST, signal: controller.signal })
    const acquiring = track(unit.acquire(ORG))
    await settle()
    controller.abort()
    await settle()
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(prober.snapshot()).toEqual([])
    unit.close()
    baseline()
  })
})

describe('settlement coordinator: nothing is handed over once the budget is gone (Codex S2 P2-2)', () => {
  it('an S1 that answers after the budget ran out: the session locks are unlocked, no BEGIN is sent, everything goes back', async () => {
    const { clock, world, pool, coordinator, records, baseline } = setup()
    world.before.set('SELECT idle', () => clock.sleep(6000))
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(6000)
    expect((acquiring.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
    const calls = pool.clients[0].calls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatch(/^SELECT idle/)
    expect(calls[1]).toMatch(/^SELECT u_k/)
    expect(pool.clients[0].released).toEqual([null])
    expect(records[0].outcome).toBe('failed')
    expect(records[0].events.map((event) => event.kind)).toEqual(['quota', 'connect', 's1', 'unlocked', 'released'])
    unit.close()
    baseline()
  })

  it('an S1 that answers within the budget is handed over with what is left', async () => {
    const { clock, world, pool, coordinator, baseline } = setup()
    world.before.set('SELECT idle', () => clock.sleep(4000))
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(4000)
    expect(acquiring.done).toBe(true)
    expect(pool.clients[0].calls[1]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE')
    expect(unit.budget.remaining()).toBe(1000)
    ;(acquiring.value as { end(): void }).end()
    unit.close()
    baseline()
  })

  it('a handover that answers after the budget ran out is rolled back, not handed over', async () => {
    const { clock, world, pool, coordinator, records, baseline } = setup()
    world.before.set('BEGIN', () => clock.sleep(6000))
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(6000)
    expect((acquiring.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
    expect(pool.clients[0].calls.at(-1)).toBe('ROLLBACK')
    expect(pool.clients[0].released).toEqual([null])
    expect(records[0].events.map((event) => event.kind)).toEqual(['quota', 'connect', 's1', 'handover', 'rolled-back', 'released'])
    unit.close()
    baseline()
  })

  it('closed and out of budget at the same checkpoint: the acquisition fails as aborted (Fable S2 closure NIT-N5)', async () => {
    const { clock, world, pool, coordinator, baseline } = setup()
    world.before.set('SELECT idle', () => clock.sleep(6000))
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await settle()
    unit.close()
    await clock.advance(6000)
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(pool.clients[0].calls[1]).toMatch(/^SELECT u_k/)
    baseline()
  })

  it('a connection that arrives just as the budget runs out goes back untried', async () => {
    const { clock, pool, coordinator, baseline } = setup({ connectTimeoutMs: 10_000 })
    pool.manual = true
    // Scheduled before the race timer, so at 300 ms the connect wins and spends the whole budget.
    clock.setTimer(300, () => void pool.pending[0].succeed())
    const unit = coordinator.openUnit({ ...REQUEST, budgetMs: 300 })
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(300)
    expect((acquiring.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE')
    expect(pool.clients[0].calls).toEqual([])
    expect(pool.clients[0].released).toEqual([null])
    unit.close()
    baseline()
  })

  it('a handover that fails at once spends nothing on its slow cleanup ROLLBACK (Codex S2 closure P3-01)', async () => {
    const { clock, world, pool, coordinator, baseline } = setup()
    world.s2Error = Object.assign(new Error('test: S2 failed'), { code: 'XX000' })
    world.before.set('ROLLBACK', () => clock.sleep(6000))
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(6000)
    expect(acquiring.error).toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    expect(acquiring.error).toMatchObject({ reason: 's2-statement-failed' })
    expect(pool.clients[0].calls.at(-1)).toBe('ROLLBACK')
    expect(pool.clients[0].released[0]).toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    expect(unit.budget.spentMs).toBe(0)
    unit.close()
    baseline()
  })

  it('an unlock that does not confirm both releases destroys the connection', async () => {
    const { clock, world, pool, coordinator, baseline } = setup()
    world.before.set('SELECT idle', () => clock.sleep(6000))
    world.unlockRow = { u_k: false, u_c: true }
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(6000)
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAcquireError)
    expect(pool.clients[0].released[0]).toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    expect(pool.clients[0].released[0]).toMatchObject({ reason: 'unlock-returned-false' })
    unit.close()
    baseline()
  })
})

describe('settlement coordinator: one acquisition at a time, and close() while one is in flight', () => {
  it('a second acquisition on a busy unit is refused before it takes anything (Codex S2 P2-3)', async () => {
    const { pool, coordinator, quota, ledger, baseline } = setup()
    pool.manual = true
    const unit = coordinator.openUnit(REQUEST)
    const first = track(unit.acquire(ORG))
    // Same turn: the first acquisition has not awaited anything yet.
    await expect(unit.acquire(ORG)).rejects.toThrow(/overlapping/)
    await settle()
    await expect(unit.acquire(ORG)).rejects.toThrow(/overlapping/)
    await expect(unit.readCandidate(async () => 'candidate')).rejects.toThrow(/overlapping/)
    expect(() => unit.beginOuterAttempt()).toThrow(/overlapping/)
    expect(quota.snapshot().orgs).toEqual([{ org: ORG, quotaClass: 'short', held: 1, waiting: 0 }])
    expect(quota.snapshot().global.short.held).toBe(1)
    expect(pool.connects).toBe(1)
    expect(ledger.snapshot().holding).toEqual([{ quotaClass: 'short', lease: true, client: false }])
    pool.pending[0].succeed()
    await settle()
    expect(first.done).toBe(true)
    ;(first.value as { end(): void }).end()
    unit.close()
    baseline()
  })

  it('close() while the unit queues for quota cancels the wait; nothing stays out', async () => {
    const { coordinator, quota, ledger, baseline } = setup({ txnSlots: 2, orgTxnSlots: 1 })
    const holder = coordinator.openUnit(REQUEST)
    const held = await holder.acquire(ORG)
    const waiting = coordinator.openUnit(REQUEST)
    const acquiring = track(waiting.acquire(ORG))
    await settle()
    expect(quota.snapshot().orgs).toEqual([{ org: ORG, quotaClass: 'short', held: 1, waiting: 1 }])
    waiting.close()
    await settle()
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(ledger.snapshot().inFlight.short).toBe(1)
    held.end()
    holder.close()
    baseline()
  })

  it('close() in the same turn as the quota is granted: the granted lease goes straight back, nothing is borrowed', async () => {
    const { pool, coordinator, ledger, baseline } = setup({ txnSlots: 2, orgTxnSlots: 1 })
    const holder = coordinator.openUnit(REQUEST)
    const held = await holder.acquire(ORG)
    const waiting = coordinator.openUnit(REQUEST)
    const acquiring = track(waiting.acquire(ORG))
    await settle()
    // The org permit is handed to the waiting unit, and its caller gives up in the same turn.
    held.end()
    waiting.close()
    await settle()
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(pool.connects).toBe(1)
    expect(ledger.snapshot().inFlight.short).toBe(1)
    holder.close()
    baseline()
  })

  it('close() while the unit waits for connect: the connect is abandoned, the late client goes back, then the quota (Fable S2 P2-1)', async () => {
    const { pool, coordinator, quota, ledger, baseline } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await settle()
    expect(pool.pending).toHaveLength(1)
    unit.close()
    await settle()
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(ledger.snapshot().inFlight.short).toBe(0)
    expect(quota.snapshot().global.short.held).toBe(1)
    expect(ledger.snapshot().abandoned.short).toBe(1)
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
    const late = pool.pending[0].succeed()
    await settle()
    expect(late.released).toEqual([null])
    baseline()
  })

  it('abort() then close() in one handler while the connect races: the late client is still released and nothing stays out (Fable S2 P2-1)', async () => {
    const { pool, coordinator, quota, ledger, baseline } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const controller = new AbortController()
    const unit = coordinator.openUnit({ ...REQUEST, signal: controller.signal })
    const acquiring = track(unit.acquire(ORG))
    await settle()
    controller.abort()
    expect(() => unit.close()).not.toThrow()
    await settle()
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    const late = pool.pending[0].succeed()
    await settle()
    expect(late.released).toEqual([null])
    expect(quota.snapshot().global.short.held).toBe(0)
    expect(ledger.snapshot().inFlight.short).toBe(0)
    baseline()
  })

  it('close() while S1 is in flight: an acquired S1 is unlocked and given back, nothing is handed over', async () => {
    const { clock, world, pool, coordinator, ledger, baseline } = setup()
    world.before.set('SELECT idle', () => clock.sleep(100))
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await settle()
    unit.close()
    // Still in flight until S1 answers.
    expect(ledger.snapshot().inFlight.short).toBe(1)
    await clock.advance(100)
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    const calls = pool.clients[0].calls
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatch(/^SELECT u_k/)
    expect(pool.clients[0].released).toEqual([null])
    expect(ledger.snapshot().inFlight.short).toBe(0)
    baseline()
  })

  it('close() while the handover is in flight: the transaction is rolled back, nothing is handed over', async () => {
    const { clock, world, pool, coordinator, ledger, baseline } = setup()
    world.before.set('BEGIN', () => clock.sleep(100))
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await settle()
    unit.close()
    await clock.advance(100)
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(pool.clients[0].calls.at(-1)).toBe('ROLLBACK')
    expect(pool.clients[0].released).toEqual([null])
    expect(ledger.snapshot().inFlight.short).toBe(0)
    baseline()
  })

  it('close() during a restart lets the restart finish converting, then the unit leaves', async () => {
    const { clock, world, pool, coordinator, ledger, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    world.before.set('ROLLBACK', () => clock.sleep(100))
    const restarting = track(unit.restart(handle, { reason: 'serialization', transaction: 'live', error: serializationError('1') }))
    await settle()
    expect(() => unit.close()).not.toThrow()
    expect(ledger.snapshot().inFlight.short).toBe(1)
    await clock.advance(100)
    expect(restarting.done).toBe(true)
    expect(restarting.error).toBeUndefined()
    expect(pool.clients[0].released).toEqual([null])
    expect(ledger.snapshot().inFlight.short).toBe(0)
    baseline()
  })
})

describe('settlement coordinator: the candidate read and close() / abort (Codex S2 closure P3-03)', () => {
  it('an acquisition during an in-flight candidate read is refused before it takes anything (Fable S2 closure NIT-N5)', async () => {
    const { pool, coordinator, quota, ledger, baseline } = setup()
    pool.manual = true
    const unit = coordinator.openUnit(REQUEST)
    const reading = track(unit.readCandidate(async () => 'candidate'))
    await settle()
    expect(pool.pending).toHaveLength(1)
    await expect(unit.acquire(ORG)).rejects.toThrow(/overlapping/)
    expect(pool.connects).toBe(1)
    expect(quota.snapshot().global.short.held).toBe(0)
    expect(ledger.snapshot().holding).toEqual([])
    pool.pending[0].succeed()
    await settle()
    expect(reading.value).toBe('candidate')
    unit.close()
    baseline()
  })

  it('close() while the candidate read runs: the read finishes, its connection goes back once, and no candidate is handed out', async () => {
    const { clock, pool, coordinator, ledger, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const reading = track(
      unit.readCandidate(async (client) => {
        await client.query('SELECT 1')
        await clock.sleep(100)
        return 'candidate-org'
      }),
    )
    await settle()
    unit.close()
    expect(ledger.snapshot().inFlight.short).toBe(1)
    await clock.advance(100)
    expect(reading.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(pool.clients[0].released).toEqual([null])
    expect(ledger.snapshot().inFlight.short).toBe(0)
    baseline()
  })

  it('an abort while the candidate read runs: no candidate is handed out, the connection goes back once', async () => {
    const { clock, pool, coordinator, baseline } = setup()
    const controller = new AbortController()
    const unit = coordinator.openUnit({ ...REQUEST, signal: controller.signal })
    const reading = track(
      unit.readCandidate(async () => {
        await clock.sleep(100)
        return 'candidate-org'
      }),
    )
    await settle()
    controller.abort()
    await clock.advance(100)
    expect(reading.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(pool.clients[0].released).toEqual([null])
    unit.close()
    baseline()
  })
})

describe('settlement coordinator: ledger self-check', () => {
  it('a permit taken outside any unit is reported', async () => {
    const { coordinator, quota, ledger } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    expect(ledger.snapshot().inFlight.short).toBe(1)
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
    const leaked = await quota.acquire('org-leak', 'short', { clock: coordinator.deps.clock })
    expect(ledger.selfCheck(quota.snapshot())).toHaveLength(1)
    leaked.release()
    handle.end()
    unit.close()
    expect(ledger.snapshot().inFlight.short).toBe(0)
  })

  it('in flight means entered and not yet left: a permit handed to a unit that has not resumed is not a leak (Fable S2 NIT-3)', async () => {
    const { coordinator, quota, ledger, baseline } = setup({ txnSlots: 1, orgTxnSlots: 1 })
    const a = coordinator.openUnit(REQUEST)
    const held = await a.acquire(ORG)
    const b = coordinator.openUnit(REQUEST)
    const acquiringB = track(b.acquire('legacy-org-b'))
    await settle()
    expect(quota.snapshot().global.short).toEqual({ held: 1, waiting: 1 })
    // A's global permit goes straight to B, which has not resumed to record its lease yet.
    held.end()
    expect(quota.snapshot().global.short.held).toBe(1)
    expect(ledger.snapshot().holding).toEqual([])
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
    await settle()
    expect(acquiringB.done).toBe(true)
    ;(acquiringB.value as { end(): void }).end()
    a.close()
    b.close()
    baseline()
  })

  it('a unit that leaves while still holding is refused by the ledger (Fable S2 NIT-4)', () => {
    const ledger = new SettlementCoordinationLedgerV1()
    const unit = Symbol('test-unit')
    ledger.enter(unit, 'short')
    ledger.takeLease(unit)
    expect(() => ledger.exit(unit)).toThrow(/still holding/)
    expect(ledger.snapshot().inFlight.short).toBe(0)
  })
})

describe('settlement coordinator: attempt records worth a log line (§3.2 step 10, Fable S2 P3-2)', () => {
  it('an immediate quota grant is not a wait; queueing for quota is', async () => {
    const { coordinator, records, baseline } = setup({ txnSlots: 2, orgTxnSlots: 1 })
    const holder = coordinator.openUnit(REQUEST)
    const held = await holder.acquire(ORG)
    expect(records[0].events.find((event) => event.kind === 'quota')?.detail).toMatchObject({ queued: false })
    expect(shouldLogSettlementCoordinationAttemptV1(records[0])).toBe(false)
    const queued = coordinator.openUnit(REQUEST)
    const acquiring = track(queued.acquire(ORG))
    await settle()
    held.end()
    await settle()
    expect(acquiring.done).toBe(true)
    expect(records[1].events.find((event) => event.kind === 'quota')?.detail).toMatchObject({ queued: true })
    expect(shouldLogSettlementCoordinationAttemptV1(records[1])).toBe(true)
    ;(acquiring.value as { end(): void }).end()
    holder.close()
    queued.close()
    baseline()
  })

  it('a quota wait that runs out or is aborted is worth a log line (Codex S2 closure P3-02)', async () => {
    const { clock, coordinator, records, baseline } = setup({ txnSlots: 3, orgTxnSlots: 1 })
    const holder = coordinator.openUnit(REQUEST)
    const held = await holder.acquire(ORG)
    const outOfTime = coordinator.openUnit({ ...REQUEST, handover: { ...REQUEST.handover, entryLabel: 'unit.out-of-time' } })
    const waitingOut = track(outOfTime.acquire(ORG))
    await clock.advance(5000)
    expect((waitingOut.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_COORDINATION_CAPACITY_BUSY')
    const controller = new AbortController()
    const aborted = coordinator.openUnit({ ...REQUEST, signal: controller.signal, handover: { ...REQUEST.handover, entryLabel: 'unit.aborted' } })
    const waitingAborted = track(aborted.acquire(ORG))
    await settle()
    controller.abort()
    await settle()
    expect(waitingAborted.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    for (const label of ['unit.out-of-time', 'unit.aborted']) {
      const record = records.find((entry) => entry.entryLabel === label) as SettlementCoordinationAttemptRecordV1
      expect(record.outcome).toBe('failed')
      expect(record.events.find((event) => event.kind === 'quota')?.detail).toMatchObject({ queued: true })
      expect(shouldLogSettlementCoordinationAttemptV1(record)).toBe(true)
    }
    held.end()
    holder.close()
    outOfTime.close()
    aborted.close()
    baseline()
  })

  it('a connect that waited is worth a log line whether it then succeeds or fails; one refused at once is not (Codex S2 closure P3-02)', async () => {
    const { clock, pool, coordinator, records, baseline } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const slowSuccess = coordinator.openUnit(REQUEST)
    const succeeding = track(slowSuccess.acquire(ORG))
    await clock.advance(900)
    pool.pending[0].succeed()
    await settle()
    expect(succeeding.done).toBe(true)
    expect(shouldLogSettlementCoordinationAttemptV1(records[0])).toBe(true)
    ;(succeeding.value as { end(): void }).end()
    slowSuccess.close()
    const slowFailure = coordinator.openUnit(REQUEST)
    const failing = track(slowFailure.acquire(ORG))
    await clock.advance(900)
    pool.pending[1].fail(new Error('test: connect refused late'))
    await settle()
    expect((failing.error as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE')
    expect(shouldLogSettlementCoordinationAttemptV1(records[1])).toBe(true)
    slowFailure.close()
    pool.manual = false
    pool.connect = () => Promise.reject(new Error('test: refused at once'))
    const refused = coordinator.openUnit(REQUEST)
    await expect(refused.acquire(ORG)).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE' })
    expect(shouldLogSettlementCoordinationAttemptV1(records[2])).toBe(false)
    refused.close()
    baseline()
  })

  it('a lost connect race is worth a log line', async () => {
    const { clock, pool, coordinator, records } = setup({ connectTimeoutMs: 1000 })
    pool.manual = true
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await clock.advance(1000)
    expect(acquiring.done).toBe(true)
    expect(shouldLogSettlementCoordinationAttemptV1(records[0])).toBe(true)
    pool.pending[0].succeed()
    await settle()
    unit.close()
  })
})

describe('settlement coordinator: coordination restart (§3.2 step 8, A07)', () => {
  it('a live transaction is rolled back, connection and quotas return, the next attempt borrows anew, and what the waits spent carries over', async () => {
    const { clock, world, pool, coordinator, quota, ledger, baseline } = setup()
    world.dedicatedBusy = true
    const unit = coordinator.openUnit(REQUEST)
    const acquiring = track(unit.acquire(ORG))
    await settle()
    world.dedicatedBusy = false
    // One backoff of 25 ms: the only wait of the first attempt.
    await clock.advance(25)
    const first = acquiring.value as SettlementCoordinationHandleV1
    expect(unit.budget.waits().dedicated).toBe(25)
    await unit.restart(first, { reason: 'serialization', transaction: 'live', error: serializationError('1') })
    // Time outside every coordination wait (cleanup, business, the caller's own work) spends nothing.
    await clock.advance(1500)
    expect(pool.clients[1].calls.at(-1)).toBe('ROLLBACK')
    expect(pool.clients[1].released).toEqual([null])
    expect(quota.snapshot().global.short.held).toBe(0)
    expect(ledger.snapshot().holding).toEqual([])
    const second = await unit.acquire(ORG)
    expect(second.client).toBe(pool.clients[2])
    expect(second.attempt).toBe(2)
    expect(unit.budget.waits().dedicated).toBe(25)
    expect(unit.budget.remaining()).toBe(5000 - 25)
    expect(unit.innerRestarts).toEqual({ serialization: 1, recheck: 0 })
    second.end()
    unit.close()
    baseline()
  })

  it('a failed ROLLBACK destroys the old connection, and the next attempt never reuses it', async () => {
    const { pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    pool.clients[0].failOnce.set('ROLLBACK', Object.assign(new Error('test: rollback lost'), { code: '08006' }))
    await unit.restart(first, { reason: 'serialization', transaction: 'live', error: serializationError('1') })
    expect(pool.clients[0].released[0]).toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    const second = await unit.acquire(ORG)
    expect(second.client).toBe(pool.clients[1])
    second.end()
    unit.close()
    baseline()
  })

  it('a transaction that already ended at COMMIT is not rolled back again', async () => {
    const { pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    const error = serializationError('at commit')
    pool.clients[0].failOnce.set('COMMIT', error)
    const committed = await commitSettlementCoordinationTransactionV1(first.client, first.credential)
    expect(committed).toEqual({ kind: 'retryable', error })
    await unit.restart(first, { reason: 'serialization', transaction: 'ended', commit: committed })
    expect(pool.clients[0].calls.filter((sql) => sql === 'ROLLBACK')).toEqual([])
    expect(pool.clients[0].released).toEqual([null])
    expect(unit.innerRestarts.serialization).toBe(1)
    unit.close()
    baseline()
  })

  it('calling an ended transaction live is refused and destroys the connection', async () => {
    const { pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    const error = serializationError('at commit')
    pool.clients[0].failOnce.set('COMMIT', error)
    await commitSettlementCoordinationTransactionV1(first.client, first.credential)
    await expect(unit.restart(first, { reason: 'serialization', transaction: 'live', error })).rejects.toMatchObject({
      code: 'ATTENDANCE_COORDINATION_CREDENTIAL_MISMATCH',
    })
    expect(pool.clients[0].released[0]).toMatchObject({ code: 'ATTENDANCE_COORDINATION_CREDENTIAL_MISMATCH' })
    unit.close()
    baseline()
  })

  it('calling a transaction that is still open "ended" is refused, destroys the connection and counts nothing (Fable S2 P3-3)', async () => {
    const { pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    const claimed = { kind: 'retryable' as const, error: serializationError('claimed') }
    await expect(unit.restart(first, { reason: 'serialization', transaction: 'ended', commit: claimed })).rejects.toMatchObject({
      code: 'ATTENDANCE_COORDINATION_RESTART_REFUSED',
      reason: 'transaction-still-open',
    })
    expect(pool.clients[0].calls.filter((sql) => sql === 'ROLLBACK')).toEqual([])
    expect(pool.clients[0].released[0]).toMatchObject({ reason: 'transaction-still-open' })
    expect(unit.innerRestarts).toEqual({ serialization: 0, recheck: 0 })
    unit.close()
    baseline()
  })

  it('an uncertain COMMIT is never restarted: the connection is destroyed and nothing is counted (Fable S2 P3-3)', async () => {
    const { pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    pool.clients[0].failOnce.set('COMMIT', Object.assign(new Error('test: connection lost at COMMIT'), { code: '08006' }))
    const committed = await commitSettlementCoordinationTransactionV1(first.client, first.credential)
    expect(committed.kind).toBe('uncertain')
    await expect(unit.restart(first, { reason: 'serialization', transaction: 'ended', commit: committed })).rejects.toMatchObject({
      reason: 'commit-not-retryable',
    })
    expect(pool.clients[0].released[0]).toMatchObject({ reason: 'commit-not-retryable' })
    expect(unit.innerRestarts.serialization).toBe(0)
    unit.close()
    baseline()
  })

  it('a second restart while one is converting is refused and leaves the first alone (Fable S2 closure NIT-N5)', async () => {
    const { clock, world, pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    world.before.set('ROLLBACK', () => clock.sleep(100))
    const first = track(unit.restart(handle, { reason: 'serialization', transaction: 'live', error: serializationError('1') }))
    await settle()
    await expect(unit.restart(handle, { reason: 'serialization', transaction: 'live', error: serializationError('2') })).rejects.toThrow(/overlapping restart/)
    await clock.advance(100)
    expect(first.done).toBe(true)
    expect(first.error).toBeUndefined()
    expect(pool.clients[0].released).toEqual([null])
    expect(unit.innerRestarts.serialization).toBe(1)
    unit.close()
    baseline()
  })

  it('three COMMIT-time 40001 restarts: the third rethrows exactly the error the commit primitive returned (Fable S2 closure NIT-N5)', async () => {
    const { pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    let last: unknown = null
    let thrown: unknown = null
    for (const label of ['1', '2', '3']) {
      const handle = await unit.acquire(ORG)
      const error = serializationError(`commit ${label}`)
      pool.clients[pool.clients.length - 1].failOnce.set('COMMIT', error)
      const committed = await commitSettlementCoordinationTransactionV1(handle.client, handle.credential)
      expect(committed).toEqual({ kind: 'retryable', error })
      last = error
      try {
        await unit.restart(handle, { reason: 'serialization', transaction: 'ended', commit: committed })
      } catch (caught) {
        thrown = caught
      }
    }
    expect(thrown).toBe(last)
    expect(unit.innerRestarts.serialization).toBe(3)
    unit.close()
    baseline()
  })

  it('ending an attempt invalidates its credential: COMMIT through the old handle is refused and nothing is sent', async () => {
    const { pool, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    handle.end()
    const sent = pool.clients[0].calls.length
    await expect(commitSettlementCoordinationTransactionV1(handle.client, handle.credential)).rejects.toMatchObject({
      code: 'ATTENDANCE_COORDINATION_CREDENTIAL_MISMATCH',
    })
    expect(pool.clients[0].calls.length).toBe(sent)
    unit.close()
    baseline()
  })

  it('the serialization counter allows two restarts; the third rethrows the original error object after converting', async () => {
    const { coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    for (const label of ['1', '2']) {
      const handle = await unit.acquire(ORG)
      await unit.restart(handle, { reason: 'serialization', transaction: 'live', error: serializationError(label) })
    }
    const last = serializationError('3')
    const handle = await unit.acquire(ORG)
    await expect(unit.restart(handle, { reason: 'serialization', transaction: 'live', error: last })).rejects.toBe(last)
    unit.close()
    baseline()
  })

  it('the recheck counter is separate and ends with the registered conflict code; an outer attempt restarts both', async () => {
    const { coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    for (const reason of ['serialization', 'serialization', 'recheck', 'recheck'] as const) {
      const handle = await unit.acquire(ORG)
      await unit.restart(handle, { reason, transaction: 'live', error: serializationError(reason) })
    }
    expect(unit.innerRestarts).toEqual({ serialization: 2, recheck: 2 })
    const handle = await unit.acquire(ORG)
    const conflict = unit.restart(handle, { reason: 'recheck', transaction: 'live', error: null, conflictCode: 'CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED' })
    await expect(conflict).rejects.toBeInstanceOf(SettlementCoordinationScopeChangedError)
    await expect(conflict).rejects.toMatchObject({ code: 'CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED' })
    unit.beginOuterAttempt()
    expect(unit.innerRestarts).toEqual({ serialization: 0, recheck: 0 })
    const again = await unit.acquire(ORG)
    await unit.restart(again, { reason: 'serialization', transaction: 'live', error: serializationError('after outer') })
    unit.close()
    baseline()
  })

  it('a scope change re-acquires under the new org; the old org\'s quota is back before the new one is taken', async () => {
    const { pool, coordinator, quota, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const first = await unit.acquire(ORG)
    await unit.restart(first, { reason: 'recheck', transaction: 'live', error: null })
    const seen: unknown[] = []
    pool.onConnect = () => seen.push(quota.snapshot().orgs.map((entry) => entry.org))
    const second = await unit.acquire('legacy-org-new-scope')
    expect(seen).toEqual([['legacy-org-new-scope']])
    expect(second.plan.key.org.lexical).toBe('legacy-org-new-scope')
    second.end()
    unit.close()
    baseline()
  })

  it('restarting an attempt the unit does not hold is refused', async () => {
    const { coordinator } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    handle.end()
    await expect(unit.restart(handle, { reason: 'serialization', transaction: 'live', error: null })).rejects.toThrow(/does not hold/)
    unit.close()
  })
})

describe('settlement coordinator: a throwing attempt observer (Fable S2 closure NIT-N4)', () => {
  it('changes neither the outcome nor the bookkeeping, and each failure is counted', async () => {
    const { pool, coordinator, ledger, baseline } = setup({ observerThrows: true })
    // Success path: the handle still reaches the caller.
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    expect(coordinator.deps.stats.attemptObserverFailures).toBe(1)
    handle.end()
    unit.close()
    // Failure path of a unit closed in flight: it still leaves the ledger.
    pool.manual = true
    const other = coordinator.openUnit(REQUEST)
    const acquiring = track(other.acquire(ORG))
    await settle()
    other.close()
    await settle()
    expect(acquiring.error).toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(coordinator.deps.stats.attemptObserverFailures).toBe(2)
    expect(ledger.snapshot().inFlight.short).toBe(0)
    pool.pending[0].succeed()
    await settle()
    baseline()
  })
})

describe('settlement coordinator: the give-back path takes this unit\'s listener off (Opus S3 closure P3-N3)', () => {
  // `#giveBack` (S1 contended, stop before the try, after an unlock, after a rollback) must give the
  // connection back through `#release`: listener off first, destroyed when it reported an error.
  // Both cases go red when it calls `client.release()` directly (oscl_17).
  it('a contended S1 gives the connection back without our listener; the next borrower of the same connection holds only its own (kills oscl_17)', async () => {
    const { world, pool, coordinator, baseline } = setup()
    pool.reuse = true
    world.dedicatedBusy = true
    const first = coordinator.openUnit({ ...REQUEST, oneShot: true })
    await expect(first.acquire(ORG)).rejects.toMatchObject({ code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY' })
    first.close()
    expect(pool.clients).toHaveLength(1)
    const [client] = pool.clients
    expect(client.released).toEqual([null])
    expect(client.listenerCount('error')).toBe(0)
    expect(pool.idle).toEqual([client])

    world.dedicatedBusy = false
    const second = coordinator.openUnit({ ...REQUEST, oneShot: true })
    const handle = await second.acquire(ORG)
    expect(handle.client).toBe(client)
    expect(pool.clients).toHaveLength(1)
    expect(pool.connects).toBe(2)
    expect(client.listenerCount('error')).toBe(1)
    handle.end()
    second.close()
    expect(client.released).toEqual([null, null])
    expect(client.listenerCount('error')).toBe(0)
    baseline()
  })

  it('an error the connection reports after the borrow and before a contended S1 destroys it with that error on the give-back (kills oscl_17)', async () => {
    const { world, pool, coordinator, baseline } = setup()
    pool.reuse = true
    world.dedicatedBusy = true
    const reported = new Error('test: the connection reported an error')
    // Emitted while S1 is on its way, without making the client unqueryable, so S1 still answers contended.
    world.before.set('SELECT idle', async () => {
      pool.clients[0].emit('error', reported)
    })
    const unit = coordinator.openUnit({ ...REQUEST, oneShot: true })
    await expect(unit.acquire(ORG)).rejects.toMatchObject({ code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY' })
    unit.close()
    const [client] = pool.clients
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toMatch(/^SELECT idle/)
    expect(client.released).toEqual([reported])
    expect(client.listenerCount('error')).toBe(0)
    expect(pool.idle).toEqual([])
    baseline()
  })
})
