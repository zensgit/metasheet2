import { describe, expect, it } from 'vitest'

import { deriveSettlementCoordinationCapacityV1 } from '../coordination/settlement-coordination-capacity'
import {
  AttendanceCoordinationConnectionUncertainError,
  commitSettlementCoordinationTransactionV1,
} from '../coordination/settlement-coordination-handover'
import {
  SettlementCoordinationAbortedError,
  SettlementCoordinationAcquireError,
  SettlementCoordinationScopeChangedError,
  createSettlementCoordinatorV1,
  shouldLogSettlementCoordinationAttemptV1,
  type SettlementCoordinationAttemptRecordV1,
  type SettlementCoordinationClientV1,
  type SettlementCoordinationPoolV1,
  type SettlementCoordinationUnitRequestV1,
} from '../coordination/settlement-coordinator'
import { ManualCoordinationClock, settle } from '../../../tests/helpers/settlement-coordination-manual-clock'

const ORG = '0e4b1f8a-3c2d-4e5f-9a6b-7c8d9e0f1a2b'
const REQUEST: SettlementCoordinationUnitRequestV1 = {
  needsClassZero: true,
  quotaClass: 'short',
  handover: { isolation: 'SERIALIZABLE', timeouts: { kind: 'none' }, entryLabel: 'unit.test' },
}

/** Answers S1 from a tiny lock world: which families are busy right now. */
class FakeLockWorld {
  dedicatedBusy = false
  classZeroBusy = false
  readonly s1Script: Array<Record<string, unknown> | Error> = []
  s1Count = 0

  /** `withClassZero`: whether this S1 carries the class-00 layer (plans without it answer c_ok = true). */
  nextS1(withClassZero: boolean): Record<string, unknown> | Error {
    this.s1Count += 1
    const scripted = this.s1Script.shift()
    if (scripted) return scripted
    if (this.dedicatedBusy) return { idle: true, k_ok: false, c_ok: withClassZero ? null : true, k_undo: null }
    if (withClassZero && this.classZeroBusy) return { idle: true, k_ok: true, c_ok: false, k_undo: true }
    return { idle: true, k_ok: true, c_ok: true, k_undo: null }
  }
}

class FakeClient implements SettlementCoordinationClientV1 {
  readonly calls: string[] = []
  readonly released: unknown[] = []
  /** Statements (exact text) that fail once with the given error. */
  readonly failOnce = new Map<string, Error>()
  onRelease: (() => void) | null = null

  constructor(private readonly world: FakeLockWorld) {}

  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>>; command: string }> {
    this.calls.push(sql)
    const failure = this.failOnce.get(sql)
    if (failure) {
      this.failOnce.delete(sql)
      throw failure
    }
    if (sql.startsWith('SELECT idle')) {
      const row = this.world.nextS1(sql.includes('::bigint'))
      if (row instanceof Error) throw row
      return { rows: [row], command: 'SELECT' }
    }
    if (sql.startsWith('BEGIN')) return { rows: [], command: 'BEGIN' }
    if (sql.startsWith('SELECT x_k')) return { rows: [{ x_k: true, x_c: true, u_k: true, u_c: true }], command: 'SELECT' }
    return { rows: [], command: sql.split(/\s+/)[0].toUpperCase() }
  }

  release(error?: unknown): void {
    this.onRelease?.()
    this.released.push(error ?? null)
  }
}

class FakePool implements SettlementCoordinationPoolV1 {
  readonly clients: FakeClient[] = []
  readonly pending: Array<{ succeed(): FakeClient; fail(error: Error): void }> = []
  connects = 0
  manual = false
  onConnect: (() => void) | null = null

  constructor(private readonly world: FakeLockWorld) {}

  connect(): Promise<SettlementCoordinationClientV1> {
    this.connects += 1
    this.onConnect?.()
    if (!this.manual) return Promise.resolve(this.#client())
    return new Promise((resolve, reject) => {
      this.pending.push({
        succeed: () => {
          const client = this.#client()
          resolve(client)
          return client
        },
        fail: (error) => reject(error),
      })
    })
  }

  #client(): FakeClient {
    const client = new FakeClient(this.world)
    this.clients.push(client)
    return client
  }
}

function setup(options: { connectTimeoutMs?: number; takeoverMs?: number; txnSlots?: number; orgTxnSlots?: number } = {}) {
  const clock = new ManualCoordinationClock()
  const world = new FakeLockWorld()
  const pool = new FakePool(world)
  const records: SettlementCoordinationAttemptRecordV1[] = []
  const coordinator = createSettlementCoordinatorV1({
    pool,
    capacity: deriveSettlementCoordinationCapacityV1({ poolMax: 20, txnSlots: options.txnSlots, orgTxnSlots: options.orgTxnSlots }),
    connectTimeoutMs: options.connectTimeoutMs ?? 1000,
    clock,
    random: () => 0.5,
    takeoverMs: options.takeoverMs,
    onAttempt: (record) => records.push(record),
  })
  const { quota, ledger, prober } = coordinator.deps
  const baseline = () => {
    expect(quota.snapshot()).toEqual({ global: { short: { held: 0, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [] })
    expect(ledger.snapshot().holding).toEqual([])
    expect(ledger.snapshot().abandoned).toEqual({ short: 0, long: 0 })
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
  }
  return { clock, world, pool, coordinator, records, quota, ledger, prober, baseline }
}

function track<T>(promise: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const box: { done: boolean; value?: T; error?: unknown } = { done: false }
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

  it('a one-shot caller tries once and leaves no contention behind', async () => {
    const { world, coordinator, prober, baseline } = setup()
    world.dedicatedBusy = true
    const unit = coordinator.openUnit({ ...REQUEST, oneShot: true })
    await expect(unit.acquire(ORG)).rejects.toMatchObject({ code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY' })
    expect(prober.snapshot()).toEqual([])
    unit.close()
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

describe('settlement coordinator: budget, background units and abort', () => {
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

describe('settlement coordinator: ledger self-check', () => {
  it('counts in-flight units from entry and exit, not from who still holds a permit', async () => {
    const { coordinator, quota, ledger } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const handle = await unit.acquire(ORG)
    expect(ledger.snapshot().inFlight.short).toBe(1)
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
    // A leaked permit (taken outside any unit) is reported.
    const leaked = await quota.acquire('org-leak', 'short', { clock: coordinator.deps.clock })
    expect(ledger.selfCheck(quota.snapshot())).toHaveLength(1)
    leaked.release()
    handle.end()
    unit.close()
    expect(ledger.snapshot().inFlight.short).toBe(0)
  })
})

describe('settlement coordinator: coordination restart (§3.2 step 8, A07)', () => {
  const serializationError = (label: string) => Object.assign(new Error(`could not serialize access (${label})`), { code: '40001' })

  it('a live transaction is rolled back, connection and quotas return, and the next attempt borrows anew', async () => {
    const { pool, coordinator, quota, ledger, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    const startedAt = unit.budget.startedAt
    const first = await unit.acquire(ORG)
    await unit.restart(first, { reason: 'serialization', transaction: 'live', error: serializationError('1') })
    expect(pool.clients[0].calls.at(-1)).toBe('ROLLBACK')
    expect(pool.clients[0].released).toEqual([null])
    expect(quota.snapshot().global.short.held).toBe(0)
    expect(ledger.snapshot().holding).toEqual([])
    const second = await unit.acquire(ORG)
    expect(second.client).toBe(pool.clients[1])
    expect(second.attempt).toBe(2)
    expect(unit.budget.startedAt).toBe(startedAt)
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
    expect(await commitSettlementCoordinationTransactionV1(first.client, first.credential)).toEqual({ kind: 'retryable', error })
    await unit.restart(first, { reason: 'serialization', transaction: 'ended', error })
    expect(pool.clients[0].calls.filter((sql) => sql === 'ROLLBACK')).toEqual([])
    expect(pool.clients[0].released).toEqual([null])
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

