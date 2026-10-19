import { describe, expect, it } from 'vitest'

import {
  AttendanceCoordinationCapacityError,
  SETTLEMENT_COORDINATION_CLI_DEFAULT_BACKOFF_MS,
  SETTLEMENT_COORDINATION_CLI_MIN_POOL_MAX,
  coordinatedTransactionCliV1,
  createSettlementCoordinationCliCoordinatorV1,
  deriveSettlementCoordinationCliCapacityV1,
} from '../coordination/settlement-coordination-cli'
import { SettlementCoordinationAbortedError, SettlementCoordinationAcquireError } from '../coordination/settlement-coordinator'
import { FakeLockWorld, FakePool, ORG, REQUEST, setupFakeCoordination as setup } from '../../../tests/helpers/settlement-coordination-fakes'

describe('CLI variant of the coordinated-transaction port (§1.1 P1-1, §3.5)', () => {
  it('retries a refused acquisition with a fresh one-shot unit per attempt and the schedule in between; no contention state is made', async () => {
    const { world, coordinator, prober, records, baseline } = setup()
    world.dedicatedBusy = true
    const slept: number[] = []
    const refused: Array<{ attempt: number; code: string; sleepMs: number }> = []
    const result = await coordinatedTransactionCliV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      retry: {
        backoffMs: [100, 300],
        jitter: 0,
        sleep: async (ms) => void slept.push(ms),
        onBusy: ({ attempt, error, sleepMs }) => {
          refused.push({ attempt, code: error.code, sleepMs })
          if (attempt === 3) world.dedicatedBusy = false
        },
      },
      body: async (context) => `unit attempt ${context.attempt}`,
    })
    // Every CLI attempt is a new unit, so the body always runs as that unit's first attempt.
    expect(result).toBe('unit attempt 1')
    expect(refused).toEqual([
      { attempt: 1, code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY', sleepMs: 100 },
      { attempt: 2, code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY', sleepMs: 300 },
      { attempt: 3, code: 'ATTENDANCE_SETTLEMENT_COORDINATION_BUSY', sleepMs: 300 },
    ])
    expect(slept).toEqual([100, 300, 300])
    expect(records.map((record) => record.outcome)).toEqual(['failed', 'failed', 'failed', 'handed-over'])
    // One-shot: the refused attempts registered no prober, no waiter, nothing to hand over.
    expect(prober.snapshot()).toEqual([])
    baseline()
  })

  it('retries nothing but an acquisition refusal: a business error reaches the caller on the first attempt', async () => {
    const { coordinator, records, baseline } = setup()
    const slept: number[] = []
    const business = new Error('test: business')
    await expect(
      coordinatedTransactionCliV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        retry: { sleep: async (ms) => void slept.push(ms) },
        body: async () => {
          throw business
        },
      }),
    ).rejects.toBe(business)
    expect(slept).toEqual([])
    expect(records.map((record) => record.outcome)).toEqual(['handed-over'])
    baseline()
  })

  it('gives up after the configured attempts with the last refusal', async () => {
    const { world, coordinator, records, baseline } = setup()
    world.dedicatedBusy = true
    const slept: number[] = []
    const failure = await coordinatedTransactionCliV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      retry: { attempts: 3, backoffMs: [50], jitter: 0, sleep: async (ms) => void slept.push(ms) },
      body: async () => 'never',
    }).then(
      () => null,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(SettlementCoordinationAcquireError)
    expect((failure as SettlementCoordinationAcquireError).code).toBe('ATTENDANCE_SETTLEMENT_COORDINATION_BUSY')
    expect(slept).toEqual([50, 50])
    expect(records).toHaveLength(3)
    baseline()
  })

  it('stops retrying once the request signal is aborted', async () => {
    const { world, coordinator, records, baseline } = setup()
    world.dedicatedBusy = true
    const controller = new AbortController()
    const slept: number[] = []
    await expect(
      coordinatedTransactionCliV1({
        coordinator,
        request: { ...REQUEST, signal: controller.signal },
        candidate: { org: ORG },
        retry: { backoffMs: [10], jitter: 0, sleep: async (ms) => void slept.push(ms), onBusy: () => controller.abort() },
        body: async () => 'never',
      }),
    ).rejects.toBeInstanceOf(SettlementCoordinationAbortedError)
    expect(slept).toEqual([10])
    expect(records).toHaveLength(1)
    baseline()
  })

  it('spreads each sleep symmetrically around the schedule entry by the jitter fraction', async () => {
    for (const [random, expected] of [
      [() => 1, 150],
      [() => 0, 50],
      [() => 0.5, 100],
    ] as const) {
      const { world, coordinator } = setup()
      world.dedicatedBusy = true
      const slept: number[] = []
      await coordinatedTransactionCliV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        retry: { backoffMs: [100], jitter: 0.5, random, sleep: async (ms) => void slept.push(ms), onBusy: () => void (world.dedicatedBusy = false) },
        body: async () => 'ok',
      })
      expect(slept).toEqual([expected])
    }
  })

  it('refuses a non-positive attempts setting and a jitter outside 0 … 1 before touching anything', async () => {
    const { coordinator, records } = setup()
    for (const retry of [{ attempts: 0 }, { attempts: 1.5 }, { jitter: 2 }, { jitter: -0.1 }]) {
      await expect(coordinatedTransactionCliV1({ coordinator, request: REQUEST, candidate: { org: ORG }, retry, body: async () => 'never' })).rejects.toBeInstanceOf(TypeError)
    }
    expect(records).toEqual([])
    expect(SETTLEMENT_COORDINATION_CLI_DEFAULT_BACKOFF_MS.length).toBeGreaterThan(0)
  })
})

describe('CLI coordinator over a private pool', () => {
  it('lays the smallest valid capacity over a small pool and gives everything above the minimum to short units', () => {
    expect(deriveSettlementCoordinationCliCapacityV1(SETTLEMENT_COORDINATION_CLI_MIN_POOL_MAX)).toMatchObject({
      poolMax: 4,
      exclusiveSlots: 1,
      scanSlots: 1,
      longTxnSlots: 1,
      reservedConnections: 0,
      txnSlots: 1,
      orgTxnSlots: 1,
    })
    expect(deriveSettlementCoordinationCliCapacityV1(8)).toMatchObject({ txnSlots: 5, orgTxnSlots: 1 })
    expect(deriveSettlementCoordinationCliCapacityV1(8, { orgTxnSlots: 2, reservedConnections: 1 })).toMatchObject({ txnSlots: 4, orgTxnSlots: 2 })
  })

  it('validates before constructing: a pool below the minimum fails with the named code, not a RangeError', () => {
    for (const poolMax of [0, 1, 3]) {
      let failure: unknown
      try {
        deriveSettlementCoordinationCliCapacityV1(poolMax)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(AttendanceCoordinationCapacityError)
      expect((failure as AttendanceCoordinationCapacityError).code).toBe('ATTENDANCE_COORDINATION_CAPACITY_INVALID')
      expect((failure as AttendanceCoordinationCapacityError).problems.length).toBeGreaterThan(0)
    }
    expect(() => deriveSettlementCoordinationCliCapacityV1(8, { orgTxnSlots: 9 })).toThrow(/orgTxnSlots must not exceed txnSlots/)
    expect(() => createSettlementCoordinationCliCoordinatorV1({ pool: new FakePool(new FakeLockWorld()), poolMax: 2 })).toThrow(AttendanceCoordinationCapacityError)
  })

  it('a coordinator over the CLI pool acquires, hands over and commits through the port', async () => {
    const { clock } = setup()
    const world = new FakeLockWorld()
    const pool = new FakePool(world)
    const coordinator = createSettlementCoordinationCliCoordinatorV1({ pool, poolMax: 4, clock, random: () => 0.5 })
    const result = await coordinatedTransactionCliV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        await context.client.query('UPDATE t SET v = 1')
        return 'committed'
      },
    })
    expect(result).toBe('committed')
    expect(pool.clients[0].calls.at(-1)).toBe('COMMIT')
    expect(coordinator.deps.quota.snapshot().global.short.held).toBe(0)
    expect(coordinator.deps.ledger.snapshot().holding).toEqual([])
  })
})
