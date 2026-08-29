import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

// End-to-end wiring check for buildPoolConfig() -> the real `mssql` driver constructor.
// mssql-adapter.test.ts already pins buildPoolConfig()'s OUTPUT (default + override timeouts) by
// calling the private builder directly, and pins SQL generation via a hand-rolled fake pool injected
// straight into the adapter's `pool` field (bypassing connect() entirely). Neither closes the
// remaining question: does connect() actually hand that config object to `new mssql.ConnectionPool()`
// — the one and only place the driver is constructed, and therefore the one place requestTimeout /
// connectionTimeout can reach (or fail to reach) every subsequent query on this connection (there is
// no per-request `.timeout` override anywhere in this adapter; `query()` always does
// `this.pool.request()` against the pool built here).
//
// MSSQLAdapter.ts loads the driver with a plain CommonJS `mssql = require('mssql')` inside a
// try/catch (kept optional so a build without the driver installed doesn't crash) — NOT an ES
// `import`. `vi.mock('mssql', factory)` does not intercept that call (proven while writing this
// file: the factory never ran and connect() hit a real DNS lookup for "db"), unlike the `import {
// Pool } from 'pg'` style used by PostgresAdapter/connection-pool.ts, which IS mockable that way.
// Instead this file requires the REAL installed `mssql` package once (Node's require cache makes
// this the SAME object MSSQLAdapter.ts captured) and swaps its `ConnectionPool`/`Transaction`
// properties for fakes for the duration of each test, restoring the originals afterward.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mssqlDriver = require('mssql') as Record<string, unknown>
const originalConnectionPool = mssqlDriver.ConnectionPool

let connectionPoolCalls: Array<Record<string, unknown>> = []
let connectShouldFail = false

class FakeConnectionPool {
  config: Record<string, unknown>
  constructor(config: Record<string, unknown>) {
    this.config = config
    connectionPoolCalls.push(config)
  }
  async connect() {
    if (connectShouldFail) throw new Error('boom: simulated connect failure')
    return this
  }
  async close() {
    /* no-op */
  }
  request() {
    const req = {
      input() {
        return req
      },
      async query() {
        return { recordset: [{ ok: 1 }], rowsAffected: [1] }
      },
    }
    return req
  }
}

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

beforeEach(() => {
  connectionPoolCalls = []
  connectShouldFail = false
  mssqlDriver.ConnectionPool = FakeConnectionPool
})

afterEach(() => {
  mssqlDriver.ConnectionPool = originalConnectionPool
})

function makeAdapter(connection: Record<string, unknown>): MSSQLAdapter {
  return new MSSQLAdapter({
    id: 's',
    name: 's',
    type: 'sqlserver',
    connection: connection as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  })
}

describe('MSSQLAdapter — connect() wiring to the real driver constructor', () => {
  it('constructs exactly one ConnectionPool per connect(), with the default requestTimeout/connectionTimeout', async () => {
    const a = makeAdapter({ host: 'db', database: 'D' })
    await a.connect()
    expect(connectionPoolCalls).toHaveLength(1)
    expect(connectionPoolCalls[0].requestTimeout).toBe(30000)
    expect(connectionPoolCalls[0].connectionTimeout).toBe(10000)
    expect(a.isConnected()).toBe(true)
  })

  it('carries an explicit requestTimeoutMs/connectionTimeoutMs override into the driver constructor', async () => {
    const a = makeAdapter({ host: 'db', database: 'D', requestTimeoutMs: 12000, connectionTimeoutMs: 5000 })
    await a.connect()
    expect(connectionPoolCalls[0].requestTimeout).toBe(12000)
    expect(connectionPoolCalls[0].connectionTimeout).toBe(5000)
  })

  it('every query on the connected pool reuses the same pool config — one requestTimeout governs query/select/insert alike', async () => {
    const a = makeAdapter({ host: 'db', database: 'D', requestTimeoutMs: 7000 })
    await a.connect()
    await a.query('SELECT 1')
    await a.select('t', {})
    // Still exactly one ConnectionPool was ever built (no per-call pool churn, no per-request
    // override mechanism) — the requestTimeout captured at connect() is what every call above ran
    // under.
    expect(connectionPoolCalls).toHaveLength(1)
    expect(connectionPoolCalls[0].requestTimeout).toBe(7000)
  })

  it('a failed connect() does not leave a half-wired pool: the adapter reports disconnected', async () => {
    connectShouldFail = true
    const a = makeAdapter({ host: 'db', database: 'D' })
    await expect(a.connect()).rejects.toThrow(/Failed to connect to SQL Server/)
    expect(a.isConnected()).toBe(false)
  })
})
