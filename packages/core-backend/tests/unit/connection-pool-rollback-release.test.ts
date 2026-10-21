/**
 * Core `ConnectionPool.transaction()`: how the connection goes back when the wrapper's ROLLBACK does
 * not complete, without a database.
 *
 *  - the caller always receives the original error object (the handler's, COMMIT's or BEGIN's),
 *    never the ROLLBACK error;
 *  - a ROLLBACK that rejects means the connection is released with an Error, so the pool destroys it
 *    instead of handing it out again, and `db_pool_connection_destroyed_total` is counted with
 *    reason 'rollback_failed';
 *  - a connection that also reported a connection error while held is released with that connection
 *    error (the first cause) and counted with reason 'connection_error';
 *  - with no connection error heard while held, a ROLLBACK that resolves, and the success path,
 *    release the connection with no error and count no destroy;
 *  - the connection is released before the destroy is counted;
 *  - on every path the connection is released exactly once, and the borrow-time 'error' listener is
 *    already off the connection when release is called.
 *
 * The pool points at a closed port (pattern of `connection-pool-error-listener.test.ts`), so no
 * connection is ever made; `transaction()` checks out a fake client through the pool's `connect`.
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { coreMetrics } from '../../src/integration/metrics/metrics'

const DESTROYED_METRIC = 'db_pool_connection_destroyed_total'

/** A fake checked-out connection: records statements and releases; rejects chosen statements. */
class FakeClient extends EventEmitter {
  readonly statements: string[] = []
  readonly releases: Array<Error | undefined> = []
  /** `listenerCount('error')` at the moment each release was called. */
  readonly errorListenersAtRelease: number[] = []
  /** Statement text → the Error that statement rejects with. */
  readonly failures = new Map<string, Error>()

  query = async (config: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }> => {
    const text = typeof config === 'string' ? config : config.text
    this.statements.push(text)
    const failure = this.failures.get(text)
    if (failure) throw failure
    return { rows: [], rowCount: 0 }
  }

  release = (error?: Error): void => {
    this.errorListenersAtRelease.push(this.listenerCount('error'))
    this.releases.push(error)
  }
}

const opened: ConnectionPool[] = []
function open(name: string, client: FakeClient): ConnectionPool {
  const pool = new ConnectionPool({ host: '127.0.0.1', port: 1, max: 2, connectionTimeoutMillis: 500, name })
  opened.push(pool)
  ;(pool.getInternalPool() as unknown as { connect: () => Promise<FakeClient> }).connect = async () => client
  return pool
}

function destroyCounts(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((call) => call[0] === DESTROYED_METRIC)
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const pool of opened.splice(0)) {
    pool.stopMetricsCollection()
    await pool.getInternalPool().end()
  }
})

describe('ConnectionPool.transaction: release after ROLLBACK', () => {
  it('the connection is released before the destroy is counted, for both reasons', async () => {
    for (const reason of ['rollback_failed', 'connection_error'] as const) {
      const client = new FakeClient()
      client.failures.set('ROLLBACK', new Error('fake ROLLBACK did not complete'))
      const pool = open(`d1-order-${reason}`, client)
      const events: string[] = []
      const release = client.release
      client.release = (error?: Error): void => {
        events.push('release')
        release(error)
      }
      const spy = vi.spyOn(coreMetrics, 'increment').mockImplementation((name: string, meta?: number | Record<string, unknown>) => {
        if (name === DESTROYED_METRIC) events.push(`count:${String((meta as Record<string, unknown> | undefined)?.reason)}`)
      })
      const handlerError = new Error(`handler failed (${reason})`)
      await expect(
        pool.transaction(async () => {
          if (reason === 'connection_error') client.emit('error', new Error('fake connection error'))
          throw handlerError
        }),
      ).rejects.toBe(handlerError)
      expect(events).toEqual(['release', `count:${reason}`])
      spy.mockRestore()
    }
  })

  it('handler throws and ROLLBACK rejects: the caller gets the handler error object, the connection is released once with the ROLLBACK error, reason rollback_failed', async () => {
    const client = new FakeClient()
    const rollbackError = new Error('fake ROLLBACK did not complete')
    client.failures.set('ROLLBACK', rollbackError)
    const pool = open('d1-rollback-rejects', client)
    const spy = vi.spyOn(coreMetrics, 'increment')
    const handlerError = new Error('handler failed')

    await expect(
      pool.transaction(async () => {
        throw handlerError
      }),
    ).rejects.toBe(handlerError)

    expect(client.statements).toEqual(['BEGIN', 'ROLLBACK'])
    expect(client.releases).toHaveLength(1)
    expect(client.releases[0]).toBe(rollbackError)
    expect(client.releases[0]).toBeInstanceOf(Error)
    expect(client.errorListenersAtRelease).toEqual([0])
    expect(destroyCounts(spy)).toEqual([[DESTROYED_METRIC, { pool: 'd1-rollback-rejects', reason: 'rollback_failed' }]])
  })

  it('a ROLLBACK rejection that is not an Error still releases the connection with an Error', async () => {
    const client = new FakeClient()
    const pool = open('d1-rollback-rejects-non-error', client)
    const notAnError: unknown = 'not an Error'
    client.query = async (config: string | { text: string }) => {
      const text = typeof config === 'string' ? config : config.text
      client.statements.push(text)
      if (text === 'ROLLBACK') throw notAnError
      return { rows: [], rowCount: 0 }
    }
    const handlerError = new Error('handler failed')

    await expect(
      pool.transaction(async () => {
        throw handlerError
      }),
    ).rejects.toBe(handlerError)

    expect(client.releases).toHaveLength(1)
    expect(client.releases[0]).toBeInstanceOf(Error)
    expect(client.errorListenersAtRelease).toEqual([0])
  })

  it('handler throws and ROLLBACK resolves: the connection is released once without an error and nothing is counted', async () => {
    const client = new FakeClient()
    const pool = open('d1-rollback-resolves', client)
    const spy = vi.spyOn(coreMetrics, 'increment')
    const handlerError = new Error('handler failed')

    await expect(
      pool.transaction(async () => {
        throw handlerError
      }),
    ).rejects.toBe(handlerError)

    expect(client.statements).toEqual(['BEGIN', 'ROLLBACK'])
    expect(client.releases).toEqual([undefined])
    expect(client.errorListenersAtRelease).toEqual([0])
    expect(destroyCounts(spy)).toEqual([])
  })

  it('success path: the result comes back and the connection is released once without an error', async () => {
    const client = new FakeClient()
    const pool = open('d1-success', client)
    const spy = vi.spyOn(coreMetrics, 'increment')

    const result = await pool.transaction(async (trx) => {
      await trx.query('SELECT 1')
      return 'done'
    })

    expect(result).toBe('done')
    expect(client.statements).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
    expect(client.releases).toEqual([undefined])
    expect(client.errorListenersAtRelease).toEqual([0])
    expect(destroyCounts(spy)).toEqual([])
  })

  it('COMMIT rejects and ROLLBACK rejects: the caller gets the COMMIT error object and the connection is released with an Error', async () => {
    const client = new FakeClient()
    const commitError = new Error('fake COMMIT failure')
    const rollbackError = new Error('fake ROLLBACK did not complete')
    client.failures.set('COMMIT', commitError)
    client.failures.set('ROLLBACK', rollbackError)
    const pool = open('d1-commit-and-rollback-reject', client)
    const spy = vi.spyOn(coreMetrics, 'increment')

    await expect(pool.transaction(async () => 'body done')).rejects.toBe(commitError)

    expect(client.statements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK'])
    expect(client.releases).toHaveLength(1)
    expect(client.releases[0]).toBe(rollbackError)
    expect(client.errorListenersAtRelease).toEqual([0])
    expect(destroyCounts(spy)).toEqual([[DESTROYED_METRIC, { pool: 'd1-commit-and-rollback-reject', reason: 'rollback_failed' }]])
  })

  it('BEGIN rejects and ROLLBACK rejects: the caller gets the BEGIN error object, the handler never runs, the connection is released with an Error', async () => {
    const client = new FakeClient()
    const beginError = new Error('fake BEGIN failure')
    const rollbackError = new Error('fake ROLLBACK did not complete')
    client.failures.set('BEGIN', beginError)
    client.failures.set('ROLLBACK', rollbackError)
    const pool = open('d1-begin-and-rollback-reject', client)
    const spy = vi.spyOn(coreMetrics, 'increment')
    let handlerRan = false

    await expect(
      pool.transaction(async () => {
        handlerRan = true
        return 'unreachable'
      }),
    ).rejects.toBe(beginError)

    expect(handlerRan).toBe(false)
    expect(client.statements).toEqual(['BEGIN', 'ROLLBACK'])
    expect(client.releases).toHaveLength(1)
    expect(client.releases[0]).toBe(rollbackError)
    expect(client.errorListenersAtRelease).toEqual([0])
    expect(destroyCounts(spy)).toEqual([[DESTROYED_METRIC, { pool: 'd1-begin-and-rollback-reject', reason: 'rollback_failed' }]])
  })

  it('a connection error heard while held and a ROLLBACK that rejects: the connection is released with the connection error (first cause), reason connection_error, counted once', async () => {
    const client = new FakeClient()
    const rollbackError = new Error('fake ROLLBACK did not complete')
    client.failures.set('ROLLBACK', rollbackError)
    const pool = open('d1-heard-and-rollback-rejects', client)
    const spy = vi.spyOn(coreMetrics, 'increment')
    const heard = new Error('fake connection error')
    const handlerError = new Error('handler failed')

    await expect(
      pool.transaction(async () => {
        client.emit('error', heard)
        throw handlerError
      }),
    ).rejects.toBe(handlerError)

    expect(client.statements).toEqual(['BEGIN', 'ROLLBACK'])
    expect(client.releases).toHaveLength(1)
    expect(client.releases[0]).toBe(heard)
    expect(client.errorListenersAtRelease).toEqual([0])
    expect(destroyCounts(spy)).toEqual([[DESTROYED_METRIC, { pool: 'd1-heard-and-rollback-rejects', reason: 'connection_error' }]])
  })

  it('a connection error heard while held with a ROLLBACK that resolves: released with the connection error, reason connection_error', async () => {
    const client = new FakeClient()
    const pool = open('d1-heard-rollback-resolves', client)
    const spy = vi.spyOn(coreMetrics, 'increment')
    const heard = new Error('fake connection error')
    const handlerError = new Error('handler failed')

    await expect(
      pool.transaction(async () => {
        client.emit('error', heard)
        throw handlerError
      }),
    ).rejects.toBe(handlerError)

    expect(client.releases).toEqual([heard])
    expect(client.errorListenersAtRelease).toEqual([0])
    expect(destroyCounts(spy)).toEqual([[DESTROYED_METRIC, { pool: 'd1-heard-rollback-resolves', reason: 'connection_error' }]])
  })

  it('repeated transactions on one connection, alternating ROLLBACK outcomes: one release per transaction, listener never left behind', async () => {
    const client = new FakeClient()
    const pool = open('d1-repeated', client)
    const rollbackError = new Error('fake ROLLBACK did not complete')
    for (let i = 0; i < 10; i += 1) {
      if (i % 2 === 0) client.failures.set('ROLLBACK', rollbackError)
      else client.failures.delete('ROLLBACK')
      const handlerError = new Error(`handler failed ${i}`)
      await expect(
        pool.transaction(async () => {
          throw handlerError
        }),
      ).rejects.toBe(handlerError)
      expect(client.listenerCount('error')).toBe(0)
    }
    expect(client.releases).toHaveLength(10)
    expect(client.releases.map((error) => error === rollbackError)).toEqual(
      Array.from({ length: 10 }, (_, i) => i % 2 === 0),
    )
    expect(client.errorListenersAtRelease.every((count) => count === 0)).toBe(true)
  })
})
