/**
 * Core `ConnectionPool` connection-error listeners, without a database.
 *
 *  - pool level: every `ConnectionPool` listens for 'error' on its pg Pool from construction, exactly
 *    once; an idle-connection error event is recorded (counter + metric) and nothing is thrown or
 *    re-emitted.
 *  - borrow level: `transaction()` listens on the checked-out connection for exactly the time it holds
 *    it — attached once after checkout, removed before release (the fake records the listener count at
 *    the moment of release) — on the success path, the handler-failure path, the BEGIN-failure path and
 *    the COMMIT-failure path; a connection that reported an error while held is released with that error
 *    (the first one it reported), so the pool destroys it — also when the error is reported after COMMIT
 *    has resolved and before the wrapper resumes; repeated transactions leave no listener behind.
 *
 * The pool points at a closed port (pattern of `settlement-coordination-main-pool-hook.test.ts`), so no
 * connection is ever made; the borrow-level cases hand `transaction()` a fake client through the pool's
 * `connect`, so what is under test is only how the wrapper attaches, detaches and releases.
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { coreMetrics } from '../../src/integration/metrics/metrics'

const POOL_METRIC = 'db_pool_connection_errors_total'

function closedPool(name: string): ConnectionPool {
  return new ConnectionPool({ host: '127.0.0.1', port: 1, max: 2, connectionTimeoutMillis: 500, name })
}

function metric(): number {
  return coreMetrics.getCustomMetric(POOL_METRIC) ?? 0
}

function serverError(code: string, severity: string): Error {
  return Object.assign(new Error('fake server error'), { code, severity })
}

/** A fake checked-out connection: records statements and releases; can fail chosen statements. */
class FakeClient extends EventEmitter {
  readonly statements: string[] = []
  readonly releases: Array<Error | undefined> = []
  /** How many 'error' listeners the connection had at the moment of each release. */
  readonly listenersAtRelease: number[] = []
  /** Statement text that rejects; `'*'` rejects every statement from then on. */
  failOn: string | null = null
  failWith: Error = new Error('fake statement failure')
  /** When set, reported as a connection error right after COMMIT resolves, before the caller resumes. */
  errorAfterCommit: Error | null = null
  /** Order of connection errors reported by the fake and releases. */
  readonly events: string[] = []

  query = async (config: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }> => {
    const text = typeof config === 'string' ? config : config.text
    this.statements.push(text)
    if (this.failOn !== null && (this.failOn === '*' || this.failOn === text)) throw this.failWith
    if (text === 'COMMIT' && this.errorAfterCommit !== null) {
      const heard = this.errorAfterCommit
      // Queued before this call's promise settles, so it runs after COMMIT has resolved and before the
      // code awaiting COMMIT resumes.
      queueMicrotask(() => {
        this.events.push('error-after-commit')
        this.emit('error', heard)
      })
    }
    return { rows: [], rowCount: 0 }
  }

  release = (error?: Error): void => {
    this.events.push('release')
    this.listenersAtRelease.push(this.listenerCount('error'))
    this.releases.push(error)
  }
}

/** Makes `pool.transaction()` check out `client` instead of connecting anywhere. */
function lend(pool: ConnectionPool, client: FakeClient): void {
  ;(pool.getInternalPool() as unknown as { connect: () => Promise<FakeClient> }).connect = async () => client
}

const opened: ConnectionPool[] = []
function open(name: string): ConnectionPool {
  const pool = closedPool(name)
  opened.push(pool)
  return pool
}

afterEach(async () => {
  for (const pool of opened.splice(0)) {
    pool.stopMetricsCollection()
    await pool.getInternalPool().end()
  }
})

describe('ConnectionPool: pool-level connection-error listener', () => {
  it('every pool listens for connection errors exactly once from construction', () => {
    const first = open('d2-pool-a')
    const second = open('d2-pool-b')
    expect(first.getInternalPool().listenerCount('error')).toBe(1)
    expect(second.getInternalPool().listenerCount('error')).toBe(1)
  })

  it('an idle-connection error event is recorded and the process keeps running: counter and metric move by one, nothing throws', () => {
    const pool = open('d2-pool-record')
    const before = metric()
    expect(pool.connectionErrorCount).toBe(0)
    expect(() => pool.getInternalPool().emit('error', serverError('57P01', 'FATAL'), {})).not.toThrow()
    expect(pool.connectionErrorCount).toBe(1)
    expect(metric()).toBe(before + 1)
    // An error without server fields (a socket error) is recorded the same way.
    expect(() => pool.getInternalPool().emit('error', new Error('read ECONNRESET'), {})).not.toThrow()
    expect(pool.connectionErrorCount).toBe(2)
    expect(metric()).toBe(before + 2)
  })

  it('the event is not re-emitted: no other listener on the pool sees anything from the recorder', () => {
    const pool = open('d2-pool-noreemit')
    const raw = pool.getInternalPool()
    const seen: unknown[] = []
    raw.on('error', (error) => seen.push(error))
    const error = serverError('57P01', 'FATAL')
    raw.emit('error', error, {})
    // Only pg's own emit above reached the second listener — exactly once, with the original error.
    expect(seen).toEqual([error])
  })
})

describe('ConnectionPool.transaction: borrow-time connection-error listener', () => {
  it('success path: the listener is on the connection only while held, and the connection goes back without an error', async () => {
    const pool = open('d2-borrow-ok')
    const client = new FakeClient()
    lend(pool, client)
    expect(client.listenerCount('error')).toBe(0)
    const result = await pool.transaction(async (trx) => {
      expect(client.listenerCount('error')).toBe(1)
      await trx.query('SELECT 1')
      return 'done'
    })
    expect(result).toBe('done')
    expect(client.listenerCount('error')).toBe(0)
    expect(client.statements).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
    expect(client.releases).toEqual([undefined])
    expect(client.listenersAtRelease).toEqual([0])
  })

  it('handler-failure path: the caller gets the handler error, ROLLBACK is sent, the listener comes off, the connection goes back without an error', async () => {
    const pool = open('d2-borrow-handler-fails')
    const client = new FakeClient()
    lend(pool, client)
    const failure = new Error('handler failed')
    await expect(
      pool.transaction(async () => {
        expect(client.listenerCount('error')).toBe(1)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(client.listenerCount('error')).toBe(0)
    expect(client.statements).toEqual(['BEGIN', 'ROLLBACK'])
    expect(client.releases).toEqual([undefined])
    expect(client.listenersAtRelease).toEqual([0])
  })

  it('BEGIN-failure path: the listener attached at checkout still comes off before release', async () => {
    const pool = open('d2-borrow-begin-fails')
    const client = new FakeClient()
    client.failOn = 'BEGIN'
    lend(pool, client)
    await expect(pool.transaction(async () => 'unreachable')).rejects.toBe(client.failWith)
    expect(client.listenerCount('error')).toBe(0)
    expect(client.releases).toHaveLength(1)
    expect(client.releases[0]).toBeUndefined()
    expect(client.listenersAtRelease).toEqual([0])
  })

  it('COMMIT-failure path: the caller gets the COMMIT error, ROLLBACK is sent, the listener comes off before release, the connection goes back without an error', async () => {
    const pool = open('d2-borrow-commit-fails')
    const client = new FakeClient()
    client.failOn = 'COMMIT'
    lend(pool, client)
    await expect(pool.transaction(async () => 'handler done')).rejects.toBe(client.failWith)
    expect(client.statements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK'])
    expect(client.listenerCount('error')).toBe(0)
    expect(client.releases).toEqual([undefined])
    expect(client.listenersAtRelease).toEqual([0])
  })

  it('a connection that reports an error while held: the caller gets an error, the listener comes off, and the connection is released with the first error it reported', async () => {
    const pool = open('d2-borrow-heard')
    const client = new FakeClient()
    lend(pool, client)
    const first = serverError('57P01', 'FATAL')
    const second = new Error('Connection terminated unexpectedly')
    // Created here, assigned inside the handler: `.rejects.toBe(...)` reads its argument before the
    // handler runs, so it must already hold the very Error the fake will throw.
    const notQueryable = new Error('Client has encountered a connection error and is not queryable')
    await expect(
      pool.transaction(async (trx) => {
        await trx.query('SELECT 1')
        // A connection error is reported on the held client (possibly more than once); later statements
        // are refused.
        client.emit('error', first)
        client.emit('error', second)
        client.failOn = '*'
        client.failWith = notQueryable
        await trx.query('SELECT 2')
        return 'unreachable'
      }),
    ).rejects.toBe(notQueryable)
    expect(client.listenerCount('error')).toBe(0)
    // ROLLBACK was attempted (and refused by the fake, as pg would); what matters here is the release.
    expect(client.statements).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'ROLLBACK'])
    expect(client.releases).toEqual([first])
    expect(client.listenersAtRelease).toEqual([0])
  })

  it('a connection that reported an error while held is released with it even when the handler and COMMIT went through', async () => {
    const pool = open('d2-borrow-heard-but-committed')
    const client = new FakeClient()
    lend(pool, client)
    const heard = serverError('08006', 'FATAL')
    const result = await pool.transaction(async () => {
      client.emit('error', heard)
      return 'committed'
    })
    expect(result).toBe('committed')
    expect(client.statements).toEqual(['BEGIN', 'COMMIT'])
    expect(client.releases).toEqual([heard])
    expect(client.listenerCount('error')).toBe(0)
    expect(client.listenersAtRelease).toEqual([0])
  })

  it('a connection error reported after COMMIT has resolved, before the wrapper resumes: the result is returned and the connection is released with that error', async () => {
    const pool = open('d2-borrow-error-after-commit')
    const client = new FakeClient()
    const heard = serverError('57P01', 'FATAL')
    client.errorAfterCommit = heard
    lend(pool, client)
    const result = await pool.transaction(async () => 'committed')
    expect(result).toBe('committed')
    expect(client.statements).toEqual(['BEGIN', 'COMMIT'])
    expect(client.events).toEqual(['error-after-commit', 'release'])
    expect(client.releases).toEqual([heard])
    expect(client.listenersAtRelease).toEqual([0])
  })

  it('an error reported while held never goes unhandled: emitting on the held connection does not throw', async () => {
    const pool = open('d2-borrow-no-unhandled')
    const client = new FakeClient()
    lend(pool, client)
    await pool.transaction(async () => {
      expect(() => client.emit('error', serverError('57P01', 'FATAL'))).not.toThrow()
    })
    // Outside a borrow the fake has no listener, so the same emit would throw — the guard of this case.
    expect(() => client.emit('error', new Error('unheld'))).toThrow()
  })

  it('repeated transactions on the same connection leave no listener behind (no accumulation, no MaxListeners warning)', async () => {
    const pool = open('d2-borrow-no-leak')
    const client = new FakeClient()
    lend(pool, client)
    const warnings: string[] = []
    const onWarning = (warning: Error): void => {
      if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning.message)
    }
    process.on('warning', onWarning)
    try {
      for (let i = 0; i < 25; i += 1) {
        const run = pool.transaction(async () => {
          expect(client.listenerCount('error')).toBe(1)
          if (i % 2 === 1) throw new Error(`odd ${i}`)
          return i
        })
        // Each outcome is checked exactly: a failed assertion inside the handler surfaces as a different
        // rejection (or as a rejection where a result is expected), never as a silently ignored one.
        if (i % 2 === 1) await expect(run).rejects.toThrow(`odd ${i}`)
        else await expect(run).resolves.toBe(i)
        expect(client.listenerCount('error')).toBe(0)
      }
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.removeListener('warning', onWarning)
    }
    expect(client.listenerCount('error')).toBe(0)
    expect(client.releases).toHaveLength(25)
    expect(client.releases.every((error) => error === undefined)).toBe(true)
    expect(client.listenersAtRelease.every((count) => count === 0)).toBe(true)
    expect(warnings).toEqual([])
  })
})
