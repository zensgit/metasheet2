/**
 * Core `ConnectionPool.transaction()` on a real PostgreSQL: when the wrapper's ROLLBACK does not
 * complete, the connection is destroyed instead of going back to the pool, and the caller gets the
 * handler's own error object.
 *
 * Each leg builds its own wrapper pool with max 1, min 1 and a long idle timeout, so a connection that
 * went back to the pool would be the very connection the next transaction gets (min 1 keeps an idle
 * connection from being closed by the idle timer, and max 1 leaves no second connection to pick).
 * In each of the three legs, (a) to (c), the handler inserts a marker row and then runs one slow
 * statement, and the wrapper's ROLLBACK does not complete.
 *
 * After each leg: the destroy is the wrapper's own (no connection error was reported on the held
 * connection, and the destroy is counted with reason rollback_failed); right after the caller gets its
 * error the pool holds no connection; the old backend leaves pg_stat_activity; the next transaction on
 * the same pool runs on a different backend, its BEGIN completes with no server notice, and it commits
 * its own row; the observer never sees the marker row the failed transaction inserted.
 *
 * In-process, not a child process: every assertion here is about the pool, the server and the table,
 * none about the test process itself, and in-process the test can assert that the caller receives the
 * very Error object the handler saw (`toBe`).
 *
 * Shared-database safe: one table with a per-run name (dropped in afterAll), an advisory-lock key
 * drawn per run, no session is terminated, and pg_stat_activity is only read.
 */
import { randomBytes, randomInt } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { coreMetrics } from '../../src/integration/metrics/metrics'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const RUN = randomBytes(4).toString('hex')
const TABLE = `core_pool_release_${RUN}`
const LOCK_KEY = String(randomInt(1, 2 ** 47))
const QUERY_TIMEOUT_MS = 1000
const LEG_TIMEOUT_MS = 60_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

interface WrapperPool {
  pool: ConnectionPool
  /** Notices the server sent on any connection of this pool, since the last `notices.length = 0`. */
  notices: string[]
}

/** A wrapper pool for one leg. `statementTimeoutMs` 0 is sent explicitly (pg omits a 0 option). */
function wrapperPool(leg: string, statementTimeoutMs: number): WrapperPool {
  const pool = new ConnectionPool({
    connectionString: dbUrl,
    name: `core-pool-release-${leg}`,
    max: 1,
    min: 1,
    idleTimeoutMillis: 120_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: QUERY_TIMEOUT_MS,
    ...(statementTimeoutMs > 0
      ? { statement_timeout: statementTimeoutMs }
      : { options: '-c statement_timeout=0' }),
    application_name: 'core-pool-release-under-test',
  })
  const notices: string[] = []
  pool.getInternalPool().on('connect', (client) => {
    client.on('notice', (notice: { severity?: string; message?: string }) => {
      notices.push(`${String(notice.severity)}: ${String(notice.message)}`)
    })
  })
  return { pool, notices }
}

async function endWrapperPool(wrapper: WrapperPool | undefined): Promise<void> {
  if (!wrapper) return
  wrapper.pool.stopMetricsCollection()
  await wrapper.pool.getInternalPool().end()
}

function totalCount(wrapper: WrapperPool): number {
  return (wrapper.pool.getInternalPool() as unknown as { totalCount: number }).totalCount
}

interface Settled {
  rejected: boolean
  error: unknown
}

function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    () => ({ rejected: false, error: undefined }),
    (error: unknown) => ({ rejected: true, error }),
  )
}

describeIfDatabase('core pool: a connection whose ROLLBACK did not complete is destroyed (real DB, in-process)', () => {
  let observer: Client
  let lockHolder: Client

  beforeAll(async () => {
    observer = new Client({ connectionString: dbUrl, application_name: 'core-pool-release-observer' })
    await observer.connect()
    lockHolder = new Client({ connectionString: dbUrl, application_name: 'core-pool-release-lock-holder' })
    await lockHolder.connect()

    const expectedDb = decodeURIComponent(new URL(String(dbUrl)).pathname.replace(/^\//, ''))
    expect(expectedDb, 'DATABASE_URL must name its database').not.toBe('')
    const { rows } = await observer.query<{ db: string }>('SELECT current_database() AS db')
    expect(rows[0].db).toBe(expectedDb)

    await observer.query(`CREATE TABLE ${TABLE} (id serial PRIMARY KEY, tag text NOT NULL)`)
  })

  afterAll(async () => {
    await lockHolder?.end().catch(() => undefined)
    if (observer) {
      try {
        await observer.query("SET lock_timeout = '5s'")
        await observer.query(`DROP TABLE IF EXISTS ${TABLE}`)
      } finally {
        await observer.end()
      }
    }
  })

  async function rowsTagged(tag: string): Promise<number> {
    const { rows } = await observer.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE} WHERE tag = $1`, [tag])
    return Number(rows[0].n)
  }

  /** Polls until `pid` leaves pg_stat_activity or the deadline passes; never throws on the deadline. */
  async function waitUntilBackendLeaves(pid: number, deadlineAt: number): Promise<{ left: boolean; lastState: string | null }> {
    let lastState: string | null = null
    for (;;) {
      const { rows } = await observer.query<{ state: string | null }>('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])
      if (rows.length === 0) return { left: true, lastState }
      lastState = rows[0].state
      if (Date.now() >= deadlineAt) return { left: false, lastState }
      await delay(100)
    }
  }

  /** The first transaction of a leg: records its backend, settings and marker, then runs `slow`. */
  async function failingTransaction(
    wrapper: WrapperPool,
    marker: string,
    slow: string,
    slowParams: unknown[] = [],
  ): Promise<{
    settled: Settled
    handlerError: unknown
    pid: number
    db: string
    statementTimeout: string
    slowStartedAt: number
    connectionErrorsWhileHeld: number
    destroyCounted: unknown[]
  }> {
    let handlerError: unknown
    // Connection errors reported on the held connection, counted by a listener of the test's own; and
    // the wrapper's destroy counts, read through a spy that passes through to the real collector.
    let connectionErrorsWhileHeld = 0
    const countConnectionError = (): void => {
      connectionErrorsWhileHeld += 1
    }
    let held: { on: (event: 'error', fn: () => void) => unknown; removeListener: (event: 'error', fn: () => void) => unknown } | undefined
    const destroySpy = vi.spyOn(coreMetrics, 'increment')
    let pid = 0
    let db = ''
    let statementTimeout = ''
    let slowStartedAt = 0
    const settled = await settle(
      wrapper.pool.transaction(async (trx) => {
        held = trx.__rawClient as unknown as NonNullable<typeof held>
        held.on('error', countConnectionError)
        const who = await trx.query<{ pid: number; db: string }>('SELECT pg_backend_pid() AS pid, current_database() AS db')
        pid = Number(who.rows[0].pid)
        db = who.rows[0].db
        const show = await trx.query<{ statement_timeout: string }>('SHOW statement_timeout')
        statementTimeout = show.rows[0].statement_timeout
        await trx.query(`INSERT INTO ${TABLE} (tag) VALUES ($1)`, [marker])
        slowStartedAt = Date.now()
        try {
          await trx.query(slow, slowParams)
        } catch (error) {
          handlerError = error
          throw error
        }
        return 'unreachable'
      }),
    )
    held?.removeListener('error', countConnectionError)
    const destroyCounted = destroySpy.mock.calls
      .filter((call) => call[0] === 'db_pool_connection_destroyed_total')
      .map((call) => call[1])
    destroySpy.mockRestore()
    return { settled, handlerError, pid, db, statementTimeout, slowStartedAt, connectionErrorsWhileHeld, destroyCounted }
  }

  /** The next transaction on the same pool: its backend, whether BEGIN completed, notices, commit. */
  async function nextTransaction(
    wrapper: WrapperPool,
    own: string,
    firstPid: number,
  ): Promise<{ beginCompleted: boolean; committed: boolean; differentBackend: boolean; notices: string[]; error: string | null }> {
    wrapper.notices.length = 0
    let beginCompleted = false
    let pid = 0
    const settled = await settle(
      wrapper.pool.transaction(async (trx) => {
        beginCompleted = true
        const who = await trx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        pid = Number(who.rows[0].pid)
        await trx.query(`INSERT INTO ${TABLE} (tag) VALUES ($1)`, [own])
      }),
    )
    return {
      beginCompleted,
      committed: !settled.rejected,
      differentBackend: pid !== 0 && pid !== firstPid,
      notices: [...wrapper.notices],
      error: settled.rejected ? String((settled.error as Error)?.message ?? settled.error) : null,
    }
  }

  it('(a) the next transaction runs on a different backend, BEGIN completes with no server notice, and the observer never sees the marker row', async () => {
    const STATEMENT_TIMEOUT_MS = 4000
    const marker = `a-marker-${RUN}`
    const own = `a-own-${RUN}`
    let wrapper: WrapperPool | undefined
    try {
      wrapper = wrapperPool('a', STATEMENT_TIMEOUT_MS)
      const first = await failingTransaction(wrapper, marker, 'SELECT pg_sleep(8)')
      const poolTotalRightAfterCaller = totalCount(wrapper)

      expect(first.db).toBe(observer.database)
      expect(first.statementTimeout).toBe('4s')
      expect(first.handlerError, `the slow statement is the one that failed; caller got: ${String(first.settled.error)}`).toBeInstanceOf(Error)
      expect(first.settled.rejected).toBe(true)
      expect(first.settled.error).toBe(first.handlerError)

      const settleAt = first.slowStartedAt + STATEMENT_TIMEOUT_MS
      const oldBackend = await waitUntilBackendLeaves(first.pid, settleAt + 8000)
      await delay(settleAt + 1000 - Date.now())

      const next = await nextTransaction(wrapper, own, first.pid)
      const observed = {
        slowStatementError: first.handlerError instanceof Error ? first.handlerError.message : String(first.handlerError),
        connectionErrorsWhileHeld: first.connectionErrorsWhileHeld,
        destroyCounted: first.destroyCounted,
        poolTotalRightAfterCaller,
        next,
        ownRows: await rowsTagged(own),
        markerRows: await rowsTagged(marker),
        oldBackendLeft: oldBackend.left,
      }
      expect(observed, `old backend last state: ${String(oldBackend.lastState)}`).toEqual({
        slowStatementError: 'Query read timeout',
        connectionErrorsWhileHeld: 0,
        destroyCounted: [{ pool: 'core-pool-release-a', reason: 'rollback_failed' }],
        poolTotalRightAfterCaller: 0,
        next: { beginCompleted: true, committed: true, differentBackend: true, notices: [], error: null },
        ownRows: 1,
        markerRows: 0,
        oldBackendLeft: true,
      })
    } finally {
      await endWrapperPool(wrapper)
    }
  }, LEG_TIMEOUT_MS)

  it('(b) the next transaction runs on a different backend, BEGIN completes with no server notice, the observer never sees the marker row, and the old backend leaves', async () => {
    const SLEEP_MS = 4000
    const marker = `b-marker-${RUN}`
    const own = `b-own-${RUN}`
    let wrapper: WrapperPool | undefined
    try {
      wrapper = wrapperPool('b', 0)
      const first = await failingTransaction(wrapper, marker, 'SELECT pg_sleep($1)', [SLEEP_MS / 1000])
      const poolTotalRightAfterCaller = totalCount(wrapper)

      expect(first.db).toBe(observer.database)
      expect(first.statementTimeout).toBe('0')
      expect(first.handlerError, `the slow statement is the one that failed; caller got: ${String(first.settled.error)}`).toBeInstanceOf(Error)
      expect(first.settled.rejected).toBe(true)
      expect(first.settled.error).toBe(first.handlerError)

      const settleAt = first.slowStartedAt + SLEEP_MS
      const oldBackend = await waitUntilBackendLeaves(first.pid, settleAt + 6000)
      await delay(settleAt + 1500 - Date.now())

      const next = await nextTransaction(wrapper, own, first.pid)
      const observed = {
        slowStatementError: first.handlerError instanceof Error ? first.handlerError.message : String(first.handlerError),
        connectionErrorsWhileHeld: first.connectionErrorsWhileHeld,
        destroyCounted: first.destroyCounted,
        poolTotalRightAfterCaller,
        next,
        ownRows: await rowsTagged(own),
        markerRows: await rowsTagged(marker),
        oldBackendLeft: oldBackend.left,
      }
      expect(observed, `old backend last state: ${String(oldBackend.lastState)}`).toEqual({
        slowStatementError: 'Query read timeout',
        connectionErrorsWhileHeld: 0,
        destroyCounted: [{ pool: 'core-pool-release-b', reason: 'rollback_failed' }],
        poolTotalRightAfterCaller: 0,
        next: { beginCompleted: true, committed: true, differentBackend: true, notices: [], error: null },
        ownRows: 1,
        markerRows: 0,
        oldBackendLeft: true,
      })
    } finally {
      await endWrapperPool(wrapper)
    }
  }, LEG_TIMEOUT_MS)

  it('(c) two-connection lock wait: the old backend leaves, the key can be taken again, and the next transaction runs on a different backend with no server notice', async () => {
    const marker = `c-marker-${RUN}`
    const own = `c-own-${RUN}`
    let wrapper: WrapperPool | undefined
    try {
      wrapper = wrapperPool('c', 0)
      const held = await lockHolder.query<{ ok: boolean }>('SELECT pg_advisory_lock($1::bigint) IS NOT NULL AS ok', [LOCK_KEY])
      expect(held.rows[0].ok).toBe(true)

      let attempt: Awaited<ReturnType<typeof failingTransaction>> | undefined
      let poolTotalRightAfterCaller = -1
      let callerSettledAt = 0
      let unlockedAt = 0
      try {
        attempt = await failingTransaction(wrapper, marker, 'SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY])
        callerSettledAt = Date.now()
        poolTotalRightAfterCaller = totalCount(wrapper)
      } finally {
        await delay(1000)
        const released = await lockHolder.query<{ released: boolean }>('SELECT pg_advisory_unlock($1::bigint) AS released', [LOCK_KEY])
        unlockedAt = Date.now()
        expect(released.rows[0].released).toBe(true)
      }
      if (!attempt) throw new Error('the first transaction did not settle')
      const first = attempt
      expect(unlockedAt).toBeGreaterThan(callerSettledAt)

      expect(first.db).toBe(observer.database)
      expect(first.statementTimeout).toBe('0')
      expect(first.handlerError, `the slow statement is the one that failed; caller got: ${String(first.settled.error)}`).toBeInstanceOf(Error)
      expect(first.settled.rejected).toBe(true)
      expect(first.settled.error).toBe(first.handlerError)

      const oldBackend = await waitUntilBackendLeaves(first.pid, unlockedAt + 8000)

      const retaken = await lockHolder.query<{ taken: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS taken', [LOCK_KEY])
      const keyTakenAgain = retaken.rows[0].taken
      if (keyTakenAgain) await lockHolder.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY])

      const next = await nextTransaction(wrapper, own, first.pid)
      const observed = {
        slowStatementError: first.handlerError instanceof Error ? first.handlerError.message : String(first.handlerError),
        connectionErrorsWhileHeld: first.connectionErrorsWhileHeld,
        destroyCounted: first.destroyCounted,
        poolTotalRightAfterCaller,
        oldBackendLeft: oldBackend.left,
        keyTakenAgain,
        next,
        ownRows: await rowsTagged(own),
        markerRows: await rowsTagged(marker),
      }
      expect(observed, `old backend last state: ${String(oldBackend.lastState)}`).toEqual({
        slowStatementError: 'Query read timeout',
        connectionErrorsWhileHeld: 0,
        destroyCounted: [{ pool: 'core-pool-release-c', reason: 'rollback_failed' }],
        poolTotalRightAfterCaller: 0,
        oldBackendLeft: true,
        keyTakenAgain: true,
        next: { beginCompleted: true, committed: true, differentBackend: true, notices: [], error: null },
        ownRows: 1,
        markerRows: 0,
      })
    } finally {
      await endWrapperPool(wrapper)
    }
  }, LEG_TIMEOUT_MS)
})
