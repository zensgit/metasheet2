import type { Pool, PoolClient, QueryResult } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionPool } from '../../src/integration/db/connection-pool'
import { assertKeyCustodyCallOutsideTransaction } from '../../src/multitable/recovery-archive-crypto'

const pools: Array<{ connectionPool: ConnectionPool; originalPool: Pool }> = []

afterEach(async () => {
  for (const { connectionPool, originalPool } of pools.splice(0)) {
    connectionPool.stopMetricsCollection()
    await originalPool.end()
  }
})

describe('ConnectionPool transaction depth', () => {
  it('isolates concurrent async contexts and restores zero outside transactions', async () => {
    const connectionPool = createPoolWithFakeClients()
    const probe = connectionPool.transactionDepthProbe
    const aEntered = deferred<void>()
    const sampleA = deferred<void>()
    const aSampled = deferred<void>()
    const nestedEntered = deferred<void>()
    const releaseNested = deferred<void>()

    expect(probe.currentTransactionDepth()).toBe(0)
    expect(() => assertKeyCustodyCallOutsideTransaction(probe)).not.toThrow()
    expect(Object.isFrozen(probe)).toBe(true)

    const transactionA = connectionPool.transaction(async () => {
      expect(probe.currentTransactionDepth()).toBe(1)
      expect(() => assertKeyCustodyCallOutsideTransaction(probe)).toThrow(
        'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION',
      )
      aEntered.resolve()
      await sampleA.promise
      expect(probe.currentTransactionDepth()).toBe(1)
      aSampled.resolve()
    })
    await aEntered.promise
    expect(probe.currentTransactionDepth()).toBe(0)

    const transactionB = connectionPool.transaction(async () => {
      expect(probe.currentTransactionDepth()).toBe(1)
      await connectionPool.transaction(async () => {
        expect(probe.currentTransactionDepth()).toBe(2)
        nestedEntered.resolve()
        await releaseNested.promise
        expect(probe.currentTransactionDepth()).toBe(2)
      })
      expect(probe.currentTransactionDepth()).toBe(1)
    })
    await nestedEntered.promise

    expect(probe.currentTransactionDepth()).toBe(0)
    sampleA.resolve()
    await aSampled.promise
    releaseNested.resolve()
    await Promise.all([transactionA, transactionB])

    expect(probe.currentTransactionDepth()).toBe(0)
  })

  it('reports zero to async work that outlives its transaction', async () => {
    const connectionPool = createPoolWithFakeClients()
    const probe = connectionPool.transactionDepthProbe
    const runDetached = deferred<void>()
    const detachedObserved = deferred<void>()
    let detachedDepth = -1

    await connectionPool.transaction(async () => {
      expect(probe.currentTransactionDepth()).toBe(1)
      void runDetached.promise.then(() => {
        detachedDepth = probe.currentTransactionDepth()
        detachedObserved.resolve()
      })
    })

    runDetached.resolve()
    await detachedObserved.promise
    expect(detachedDepth).toBe(0)
    expect(probe.currentTransactionDepth()).toBe(0)
  })

  it('returns committed results and releases the confirmed connection once', async () => {
    const client = fakeClient()
    const connectionPool = createPoolWithFakeClients(client)
    const probe = connectionPool.transactionDepthProbe

    await expect(connectionPool.transaction(async () => {
      expect(probe.currentTransactionDepth()).toBe(1)
      return 'committed'
    })).resolves.toBe('committed')

    expect(vi.mocked(client.query).mock.calls.map(([statement]) => statement)).toEqual(['BEGIN', 'COMMIT'])
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledWith()
    expect(probe.currentTransactionDepth()).toBe(0)
  })

  it('preserves the business error after confirmed rollback and releases once', async () => {
    const client = fakeClient()
    const connectionPool = createPoolWithFakeClients(client)
    const probe = connectionPool.transactionDepthProbe
    const failure = new Error('business operation refused')

    await expect(connectionPool.transaction(async () => {
      expect(probe.currentTransactionDepth()).toBe(1)
      throw failure
    })).rejects.toBe(failure)

    expect(vi.mocked(client.query).mock.calls.map(([statement]) => statement)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledWith()
    expect(probe.currentTransactionDepth()).toBe(0)
  })

  it.each([
    ['rejection', new Error('rollback refused')],
    ['timeout', new Error('Query read timeout')],
  ] as const)('discards an unconfirmed connection while preserving the business error (%s)', async (_label, rollbackFailure) => {
    const client = fakeClient(rollbackFailure)
    const connectionPool = createPoolWithFakeClients(client)
    const probe = connectionPool.transactionDepthProbe
    const failure = new Error('business operation refused')

    await expect(connectionPool.transaction(async () => {
      expect(probe.currentTransactionDepth()).toBe(1)
      throw failure
    })).rejects.toBe(failure)

    expect(vi.mocked(client.query).mock.calls.map(([statement]) => statement)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledWith(true)
    expect(probe.currentTransactionDepth()).toBe(0)
  })
})

function createPoolWithFakeClients(client?: PoolClient): ConnectionPool {
  const connectionPool = new ConnectionPool({ name: 'transaction-depth-test' })
  const originalPool = connectionPool.getInternalPool()
  const fakePool = {
    connect: vi.fn(async () => client ?? fakeClient()),
  }
  Object.defineProperty(connectionPool, 'pool', {
    configurable: true,
    value: fakePool,
    writable: true,
  })
  pools.push({ connectionPool, originalPool })
  return connectionPool
}

function fakeClient(rollbackFailure?: Error): PoolClient {
  const result: QueryResult = {
    command: '',
    rowCount: 0,
    oid: 0,
    rows: [],
    fields: [],
  }
  return {
    query: vi.fn(async (statement: string) => {
      if (statement === 'ROLLBACK' && rollbackFailure) throw rollbackFailure
      return result
    }),
    release: vi.fn(),
  } as unknown as PoolClient
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value?: T) => void
} {
  let resolve!: (value?: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done as typeof resolve
  })
  return { promise, resolve }
}
