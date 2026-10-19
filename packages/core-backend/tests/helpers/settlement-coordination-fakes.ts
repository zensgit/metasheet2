/**
 * Fakes for the settlement coordination unit tests: a lock world that answers S1 / S2 / unlock, a
 * client that records every statement and can hold one in flight on the manual clock, a pool that
 * hands out clients at once or by hand, and a setup that builds a coordinator around them.
 */
import { expect } from 'vitest'

import { deriveSettlementCoordinationCapacityV1 } from '../../src/attendance/coordination/settlement-coordination-capacity'
import {
  createSettlementCoordinatorV1,
  type SettlementCoordinationAttemptRecordV1,
  type SettlementCoordinationClientV1,
  type SettlementCoordinationPoolV1,
  type SettlementCoordinationUnitRequestV1,
} from '../../src/attendance/coordination/settlement-coordinator'
import { ManualCoordinationClock } from './settlement-coordination-manual-clock'

export const ORG = '0e4b1f8a-3c2d-4e5f-9a6b-7c8d9e0f1a2b'
export const REQUEST: SettlementCoordinationUnitRequestV1 = {
  needsClassZero: true,
  quotaClass: 'short',
  handover: { isolation: 'SERIALIZABLE', timeouts: { kind: 'none' }, entryLabel: 'unit.test' },
}

export const serializationError = (label: string) => Object.assign(new Error(`could not serialize access (${label})`), { code: '40001' })

/** Answers S1 from a tiny lock world: which families are busy right now. */
export class FakeLockWorld {
  dedicatedBusy = false
  classZeroBusy = false
  readonly s1Script: Array<Record<string, unknown> | Error> = []
  s1Count = 0
  /** Runs before a statement whose text starts with the key: holds it in flight on the manual clock. */
  readonly before = new Map<string, () => Promise<void>>()
  /** What the session unlock (cleanup before handover) answers. */
  unlockRow: Record<string, unknown> = { u_k: true, u_c: true }
  /** When set, S2 fails with this error (the handover then rolls back and reports uncertain). */
  s2Error: Error | null = null

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

export class FakeClient implements SettlementCoordinationClientV1 {
  readonly calls: string[] = []
  readonly released: unknown[] = []
  /** Statements (exact text) that fail once with the given error. */
  readonly failOnce = new Map<string, Error>()
  onRelease: (() => void) | null = null

  constructor(private readonly world: FakeLockWorld) {}

  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>>; command: string }> {
    this.calls.push(sql)
    for (const [prefix, hold] of this.world.before) if (sql.startsWith(prefix)) await hold()
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
    if (sql.startsWith('SELECT x_k')) {
      if (this.world.s2Error) throw this.world.s2Error
      return { rows: [{ x_k: true, x_c: true, u_k: true, u_c: true }], command: 'SELECT' }
    }
    if (sql.startsWith('SELECT u_k') || sql.startsWith('SELECT pg_advisory_unlock_shared')) return { rows: [this.world.unlockRow], command: 'SELECT' }
    return { rows: [], command: sql.split(/\s+/)[0].toUpperCase() }
  }

  release(error?: unknown): void {
    this.onRelease?.()
    this.released.push(error ?? null)
  }
}

export class FakePool implements SettlementCoordinationPoolV1 {
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
    expect(ledger.selfCheck(quota.snapshot())).toEqual([])
  }
  return { clock, world, pool, coordinator, records, quota, ledger, prober, baseline }
}

export function track<T>(promise: Promise<T>): { done: boolean; value?: T; error?: unknown } {
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
