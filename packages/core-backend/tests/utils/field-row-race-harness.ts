/**
 * Deterministic interleavings for the field-row lost-update cases (real Postgres).
 *
 * `holdAfter(texts)` pauses ONE transaction right after a statement whose text EXACTLY equals one of `texts` (string
 * equality, never a regex: the PATCH route's locked re-read text starts with its first-read text). The pause is
 * injected by wrapping `poolManager.get().transaction`, so the production code runs unmodified. On the match it records
 * the held transaction's backend pid, resolves `reached()`, and waits for `release()`. It keeps COUNTING matches after
 * the hold is spent — the non-vacuity check for a transparent retry (the first read runs twice).
 *
 * `raceParkedOrSettled` polls `pg_stat_activity` for a backend that waits on a lock held by the blocker pid (optionally
 * running exactly `queryText`), racing the competitor's own completion. It answers 'parked', 'settled' or 'timeout', so
 * a case can assert the interleaving it expects AND, on a red, show which interleaving actually happened.
 *
 * `useWriterFencePinnedOff()` clears MULTITABLE_ENABLE_WRITER_FENCE for the describe block and restores it afterwards.
 * With the fence on, every writer here serializes per sheet on the canonical advisory lock, which already closes these
 * races — so a race case run under the fence would be green on main and prove nothing. Every race case asserts
 * `isWriterFenceEnabled() === false` first.
 */
import type { PoolClient } from 'pg'
import { afterAll, beforeAll } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

const FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'

export interface StatementHold {
  /** Resolves with the held transaction's backend pid; throws `hold point never reached` after `timeoutMs`. */
  reached(timeoutMs?: number): Promise<number>
  release(): void
  /** How many statements matched so far, including those after the hold was spent. */
  count(): number
  /** Unwrap `transaction` again (idempotent). Always call it in `finally`. */
  restore(): void
}

type TxClient = { query: (sql: unknown, params?: unknown, options?: unknown) => Promise<{ rows: unknown[] }> }
type TxHandler = (client: TxClient) => Promise<unknown>
type TransactionFn = (handler: TxHandler) => Promise<unknown>

export function holdAfter(texts: string | readonly string[]): StatementHold {
  const wanted = new Set(typeof texts === 'string' ? [texts] : texts)
  const pool = poolManager.get() as unknown as { transaction: TransactionFn }
  const hadOwn = Object.prototype.hasOwnProperty.call(pool, 'transaction')
  const ownBefore = hadOwn ? pool.transaction : undefined
  const original = pool.transaction
  let armed = true
  let matches = 0
  let restored = false
  let resolveReached!: (pid: number) => void
  const reachedP = new Promise<number>((resolve) => { resolveReached = resolve })
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })

  pool.transaction = function wrappedTransaction(handler: TxHandler) {
    return original.call(pool, async (client: TxClient) => {
      const query = async (sql: unknown, params?: unknown, options?: unknown) => {
        const res = await client.query(sql, params, options)
        if (typeof sql === 'string' && wanted.has(sql)) {
          matches += 1
          if (armed) {
            armed = false
            const pid = await client.query('SELECT pg_backend_pid() AS pid')
            resolveReached(Number((pid.rows[0] as { pid: number }).pid))
            await gate
          }
        }
        return res
      }
      return handler({ ...client, query })
    })
  }

  return {
    async reached(timeoutMs = 10_000) {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`hold point never reached within ${timeoutMs} ms`)), timeoutMs)
      })
      try {
        return await Promise.race([reachedP, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    release() {
      releaseGate()
    },
    count() {
      return matches
    },
    restore() {
      if (restored) return
      restored = true
      releaseGate()
      if (hadOwn) pool.transaction = ownBefore as TransactionFn
      else delete (pool as { transaction?: TransactionFn }).transaction
    },
  }
}

export type ParkOutcome = 'parked' | 'settled' | 'timeout'

/**
 * Poll until a backend waits on a lock held by `blockerPid` (running exactly `queryText` when given), or until
 * `settled()` reports that the competitor finished first, or until `timeoutMs`.
 */
export async function raceParkedOrSettled(opts: {
  blockerPid: number
  queryText?: string
  settled: () => boolean
  timeoutMs?: number
}): Promise<ParkOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  while (Date.now() < deadline) {
    if (opts.settled()) return 'settled'
    const res = await poolManager.get().query(
      `SELECT count(*)::int AS c FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
          AND ($2::text IS NULL OR query = $2::text)`,
      [opts.blockerPid, opts.queryText ?? null],
    )
    if ((res.rows[0] as { c: number }).c >= 1) return 'parked'
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return opts.settled() ? 'settled' : 'timeout'
}

/** A dedicated connection outside every wrapped transaction: the "raw" competitor runs one atomic statement on it. */
export async function rawClient(): Promise<PoolClient> {
  return poolManager.get().getInternalPool().connect()
}

/** Run `run()` and report whether it finished; the flag lets `raceParkedOrSettled` see a competitor that finished. */
export function tracked<T>(run: () => PromiseLike<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false
  // Promise.resolve: a supertest request is a thenable without `finally`; adopting it also starts it.
  const promise = Promise.resolve(run()).finally(() => { done = true })
  // A rejection is asserted by the case that awaits `promise`; never let it surface as unhandled meanwhile.
  promise.catch(() => {})
  return { promise, settled: () => done }
}

export function useWriterFencePinnedOff(): void {
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env[FENCE_FLAG]
    delete process.env[FENCE_FLAG]
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[FENCE_FLAG]
    else process.env[FENCE_FLAG] = saved
  })
}

/** For the one fence-ON positive control: set the flag for `run()` only, then put back whatever the pin left. */
export async function withWriterFenceOn<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env[FENCE_FLAG]
  process.env[FENCE_FLAG] = 'true'
  try {
    return await run()
  } finally {
    if (saved === undefined) delete process.env[FENCE_FLAG]
    else process.env[FENCE_FLAG] = saved
  }
}
