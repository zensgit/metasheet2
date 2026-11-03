/**
 * Fakes for the settlement coordination tests, free of the test runner so child processes can load
 * them too: a lock world that answers S1 / S2 / unlock, a client that records every statement, can
 * hold one in flight and can lose its connection the way pg reports it, and a pool that hands out
 * clients at once or by hand. `settlement-coordination-fakes.ts` adds the runner-side setup.
 */
import { EventEmitter } from 'node:events'

import type {
  SettlementCoordinationClientV1,
  SettlementCoordinationPoolV1,
  SettlementCoordinationUnitRequestV1,
} from '../../src/attendance/coordination/settlement-coordinator'

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

export class FakeClient extends EventEmitter implements SettlementCoordinationClientV1 {
  readonly calls: string[] = []
  readonly released: unknown[] = []
  /** Statements (exact text) that fail once with the given error. */
  readonly failOnce = new Map<string, Error>()
  onRelease: (() => void) | null = null
  /** Set by a pool that reuses connections (`FakePool.reuse`): told of every release, after it is booked. */
  returnTo: ((client: FakeClient, error: unknown) => void) | null = null
  /** Set by `lose()`: like pg after a connection error, every later query fails at once. */
  lost: Error | null = null

  constructor(private readonly world: FakeLockWorld) {
    super()
  }

  /** Loses the connection the way pg reports it: the client stops being queryable, then emits 'error'. */
  lose(error: Error): void {
    this.lost = error
    this.emit('error', error)
  }

  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>>; command: string }> {
    this.calls.push(sql)
    if (this.lost) throw new Error('Client has encountered a connection error and is not queryable')
    for (const [prefix, hold] of this.world.before) if (sql.startsWith(prefix)) await hold()
    if (this.lost) throw new Error('Client has encountered a connection error and is not queryable')
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
    this.returnTo?.(this, error)
  }
}

export class FakePool implements SettlementCoordinationPoolV1 {
  readonly clients: FakeClient[] = []
  readonly pending: Array<{ succeed(): FakeClient; fail(error: Error): void }> = []
  connects = 0
  manual = false
  /**
   * Like pg-pool: a client released without an error (and not lost) goes back to the idle list and is
   * handed out again by the next connect, so a test can watch the same client across release and
   * re-borrow. Off by default: every connect then makes a new client.
   */
  reuse = false
  readonly idle: FakeClient[] = []
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
    const reused = this.reuse ? this.idle.shift() : undefined
    if (reused) return reused
    const client = new FakeClient(this.world)
    client.returnTo = (released, error) => {
      if (this.reuse && !error && !released.lost) this.idle.push(released)
    }
    this.clients.push(client)
    return client
  }
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
