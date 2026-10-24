/**
 * Runner-side setup for the settlement coordination unit tests: builds a coordinator around the
 * fakes of `settlement-coordination-fakes-core.ts` (re-exported here) on the manual clock.
 */
import { expect } from 'vitest'

import { deriveSettlementCoordinationCapacityV1 } from '../../src/attendance/coordination/settlement-coordination-capacity'
import {
  createSettlementCoordinatorV1,
  type SettlementCoordinationAttemptRecordV1,
} from '../../src/attendance/coordination/settlement-coordinator'
import { FakeLockWorld, FakePool } from './settlement-coordination-fakes-core'
import { ManualCoordinationClock } from './settlement-coordination-manual-clock'

export * from './settlement-coordination-fakes-core'

export function setupFakeCoordination(options: { connectTimeoutMs?: number; takeoverMs?: number; txnSlots?: number; orgTxnSlots?: number; observerThrows?: boolean } = {}) {
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
    onAttempt: (record) => {
      records.push(record)
      if (options.observerThrows) throw new Error('test: attempt observer failed')
    },
  })
  const { quota, ledger, prober } = coordinator.deps
  const baseline = () => {
    expect(quota.snapshot()).toEqual({ global: { short: { held: 0, waiting: 0 }, long: { held: 0, waiting: 0 } }, orgs: [] })
    expect(ledger.snapshot().holding).toEqual([])
    expect(ledger.snapshot().abandoned).toEqual({ short: 0, long: 0 })
    // Every unit has left (Opus S3 P3-10): a port that never closed its own unit would leave one in flight.
    expect(ledger.snapshot().inFlight).toEqual({ short: 0, long: 0 })
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
  }
  return { clock, world, pool, coordinator, records, quota, ledger, prober, baseline }
}
