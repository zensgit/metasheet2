/**
 * `PostgresAdapter` (external data-source PG pool): the pool it builds in `connect()` listens for
 * 'error' exactly once; an idle-connection error event is counted and logged, is not thrown, and is
 * not re-emitted on the adapter (nothing listens on the adapter on that path).
 *
 * No database: the pool's `query` is stubbed on the pg Pool prototype so `connect()`'s probe resolves
 * without a connection being made. `require('pg')` inside the adapter and `import { Pool } from 'pg'`
 * here resolve to the same CommonJS module instance, so the prototype stub reaches the adapter's pool.
 */
import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { coreMetrics } from '../../src/integration/metrics/metrics'

const METRIC = 'data_source_pool_connection_errors_total'

function cfg(): DataSourceConfig {
  return {
    id: 'd2_source', name: 'd2', type: 'postgres',
    connection: { host: '127.0.0.1', port: 1, database: 'nope' },
    credentials: { username: 'u', password: 'p' },
    poolConfig: { min: 0, max: 1, idleTimeout: 500, acquireTimeout: 1500 },
  } as DataSourceConfig
}

function poolOf(adapter: unknown): Pool {
  return (adapter as { pool: Pool }).pool
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PostgresAdapter: data-source pool connection-error listener', () => {
  it('the pool listens once; an idle-connection error is counted, not thrown, and not re-emitted on the adapter', async () => {
    vi.spyOn(Pool.prototype, 'query').mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
    const adapter = new PostgresAdapter(cfg())
    const adapterErrors: unknown[] = []
    adapter.on('error', (event) => adapterErrors.push(event))
    await adapter.connect()
    try {
      const pool = poolOf(adapter)
      expect(pool).toBeTruthy()
      expect(pool.listenerCount('error')).toBe(1)
      const before = coreMetrics.getCustomMetric(METRIC) ?? 0
      const error = Object.assign(new Error('fake server error'), { code: '57P01', severity: 'FATAL' })
      expect(() => pool.emit('error', error, {} as never)).not.toThrow()
      expect(coreMetrics.getCustomMetric(METRIC)).toBe(before + 1)
      expect(adapterErrors).toEqual([])
      expect(adapter.isConnected()).toBe(true)
      expect(adapter.connectionError).toBeNull()
    } finally {
      await adapter.disconnect()
    }
    expect(adapterErrors).toEqual([])
  })
})
