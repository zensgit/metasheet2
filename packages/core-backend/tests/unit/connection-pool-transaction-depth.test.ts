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
})

function createPoolWithFakeClients(): ConnectionPool {
  const connectionPool = new ConnectionPool({ name: 'transaction-depth-test' })
  const originalPool = connectionPool.getInternalPool()
  const fakePool = {
    connect: vi.fn(async () => fakeClient()),
  }
  Object.defineProperty(connectionPool, 'pool', {
    configurable: true,
    value: fakePool,
    writable: true,
  })
  pools.push({ connectionPool, originalPool })
  return connectionPool
}

function fakeClient(): PoolClient {
  const result: QueryResult = {
    command: '',
    rowCount: 0,
    oid: 0,
    rows: [],
    fields: [],
  }
  return {
    query: vi.fn(async () => result),
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
