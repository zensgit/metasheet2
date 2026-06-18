import { describe, expect, it } from 'vitest'

import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { MySQLAdapter } from '../../src/data-adapters/MySQLAdapter'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

// M1 regression: a FAILED connect() must not leak the driver Pool. The ephemeral test-before-save
// helper gates teardown on isConnected() (false after a failed connect) and disconnect() self-guards
// on `connected`, so the adapter's own connect() catch must end + null the pool. 127.0.0.1:1 gives a
// deterministic, fast ECONNREFUSED with no DB required.
function badCfg(type: string): DataSourceConfig {
  return {
    id: `bad_${type}`, name: 'bad', type,
    connection: { host: '127.0.0.1', port: 1, database: 'nope' },
    credentials: { username: 'u', password: 'p' },
    poolConfig: { min: 0, max: 1, idleTimeout: 500, acquireTimeout: 1500 },
  } as DataSourceConfig
}

function poolOf(adapter: unknown): unknown {
  return (adapter as { pool: unknown }).pool
}

describe('SQL adapter connect() failure cleans up the pool (M1 — no leak)', () => {
  it('PostgresAdapter: failed connect rejects, stays disconnected, and nulls the pool', async () => {
    const adapter = new PostgresAdapter(badCfg('postgres'))
    adapter.on('error', () => { /* swallow onError emit */ })
    await expect(adapter.connect()).rejects.toThrow()
    expect(adapter.isConnected()).toBe(false)
    expect(poolOf(adapter)).toBeNull()
  })

  it('MySQLAdapter: failed connect rejects, stays disconnected, and nulls the pool', async () => {
    const adapter = new MySQLAdapter(badCfg('mysql'))
    adapter.on('error', () => { /* swallow onError emit */ })
    await expect(adapter.connect()).rejects.toThrow()
    expect(adapter.isConnected()).toBe(false)
    expect(poolOf(adapter)).toBeNull()
  })
})
