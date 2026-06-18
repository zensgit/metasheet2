import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// auditLog hits the DB; no-op it for these in-memory tests.
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { BaseDataAdapter } from '../../src/data-adapters/BaseAdapter'
import type {
  DataSourceConfig,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  Transaction,
  DbValue,
} from '../../src/data-adapters/BaseAdapter'
import { dataSourcesRouter, getDataSourceManager } from '../../src/routes/data-sources'

const SECRET = 'EphemeralSecretPw!2026'

// Module-level cleanup ledgers so we can prove the ephemeral helper's `finally` ran
// (disconnect + removeAllListeners) even though it never hands us the adapter instance.
const disconnectCalls: string[] = []
const removeAllListenerCalls: string[] = []

// All-no-op concrete base so each fake only overrides the lifecycle bits it cares about.
abstract class FakeBase extends BaseDataAdapter {
  async query<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async select<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async insert<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async update<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async delete<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async getSchema(): Promise<SchemaInfo> { return { tables: [] } }
  async getTableInfo(): Promise<TableInfo> { return { name: '', columns: [] } }
  async getColumns(): Promise<ColumnInfo[]> { return [] }
  async tableExists(): Promise<boolean> { return false }
  async beginTransaction(): Promise<Transaction> { return {} as Transaction }
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async inTransaction<R = unknown>(_t: Transaction, cb: () => Promise<R>): Promise<R> { return cb() }
  async *stream<T = Record<string, DbValue>>(): AsyncIterableIterator<T> { /* no rows */ }
  removeAllListeners(event?: string | symbol): this {
    removeAllListenerCalls.push(this.config.id)
    return super.removeAllListeners(event)
  }
}

// Connects fine; testConnection passes.
class OkAdapter extends FakeBase {
  async connect(): Promise<void> { this.connected = true; await this.onConnect() }
  async disconnect(): Promise<void> { disconnectCalls.push(this.config.id); this.connected = false; await this.onDisconnect() }
  isConnected(): boolean { return this.connected }
  async testConnection(): Promise<boolean> { return true }
}

// connect() fails with an error embedding the configured password (proves redaction + no echo).
class FailAdapter extends FakeBase {
  async connect(): Promise<void> {
    const err = new Error(`ECONNREFUSED 127.0.0.1: login failed (password=${this.config.credentials?.password})`)
    await this.onError(err) // records redactSecrets(err.message) into lastConnectionError, emits 'error'
    throw err
  }
  async disconnect(): Promise<void> { disconnectCalls.push(this.config.id); this.connected = false }
  isConnected(): boolean { return this.connected }
  async testConnection(): Promise<boolean> { return false }
}

function appAs(userId: string) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.user = { id: userId, role: 'admin' } as never; next() })
  a.use(dataSourcesRouter())
  return a
}

function cfg(id: string, type: string, extra?: Partial<DataSourceConfig>): DataSourceConfig {
  return {
    id, name: id, type,
    connection: { host: 'unreachable.example' },
    credentials: { username: 'u', password: SECRET },
    options: { autoConnect: false },
    ...extra,
  } as DataSourceConfig
}

beforeEach(() => { disconnectCalls.length = 0; removeAllListenerCalls.length = 0 })
afterEach(() => { vi.restoreAllMocks() })

describe('DataSourceManager.testEphemeralConnection (helper)', () => {
  it('returns success + latency, registers nothing, and disposes the transient adapter', async () => {
    const manager = getDataSourceManager()
    manager.registerAdapterType('okeph', OkAdapter as never)
    const id = `eph_ok_${Date.now()}`

    const result = await manager.testEphemeralConnection(cfg(id, 'okeph'))

    expect(result.success).toBe(true)
    expect(typeof result.latency).toBe('number')
    // EPHEMERAL: no in-memory registration (the sole persist path, addDataSource, also registers here).
    expect(manager.getScope(id)).toBeUndefined()
    expect(() => manager.assertAccess(id, 'tester')).toThrow(/not found/)
    expect(manager.listDataSources({ ownerId: 'tester' }).some(s => s.id === id)).toBe(false)
    // CLEANUP: finally ran disconnect + removeAllListeners.
    expect(disconnectCalls).toContain(id)
    expect(removeAllListenerCalls).toContain(id)
  })

  it('returns success:false with a REDACTED cause on connect failure, leaking no secret', async () => {
    const manager = getDataSourceManager()
    manager.registerAdapterType('faileph', FailAdapter as never)
    const id = `eph_fail_${Date.now()}`

    const result = await manager.testEphemeralConnection(cfg(id, 'faileph'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('***')
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(manager.getScope(id)).toBeUndefined() // still nothing registered on failure
    expect(removeAllListenerCalls).toContain(id) // disposed even on failure
  })

  it('throws Unsupported data source type for an unknown adapter type', async () => {
    const manager = getDataSourceManager()
    await expect(manager.testEphemeralConnection(cfg('eph_x', 'no-such-type')))
      .rejects.toThrow(/Unsupported data source type/)
  })
})

describe('POST /api/data-sources/test (route)', () => {
  it('400s on an unsupported type (create allowlist)', async () => {
    const res = await request(appAs('tester')).post('/api/data-sources/test').send({
      id: 'x', name: 'x', type: 'mongodb', connection: { host: 'h' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('400s on a malformed payload (missing required fields)', async () => {
    const res = await request(appAs('tester')).post('/api/data-sources/test').send({ type: 'postgres' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns a RESULT-ONLY success body — never echoes config / connection / credentials', async () => {
    const manager = getDataSourceManager()
    manager.registerAdapterType('postgres', OkAdapter as never) // override real PG with a fake for this unit
    const res = await request(appAs('tester')).post('/api/data-sources/test').send({
      id: 'eph_echo', name: 'Echo Probe', type: 'postgres',
      connection: { host: 'secret-host.internal' },
      credentials: { username: 'admin_user', password: SECRET },
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.success).toBe(true)
    expect(res.body.data.latency).toMatch(/ms$/)
    // NO ECHO: none of the submitted config/connection/credentials may appear in the response.
    expect(Object.keys(res.body.data).sort()).toEqual(['latency', 'success'])
    const wire = JSON.stringify(res.body)
    for (const leak of [SECRET, 'secret-host.internal', 'admin_user', 'connection', 'credentials', 'Echo Probe']) {
      expect(wire).not.toContain(leak)
    }
  })

  it('returns a RESULT-ONLY failure body with a redacted error and no secret', async () => {
    const manager = getDataSourceManager()
    manager.registerAdapterType('postgres', FailAdapter as never)
    const res = await request(appAs('tester')).post('/api/data-sources/test').send({
      id: 'eph_echo_fail', name: 'x', type: 'postgres',
      connection: { host: 'h' }, credentials: { username: 'u', password: SECRET },
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.success).toBe(false)
    expect(res.body.data.error.message).toContain('***')
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
  })

  it('persists nothing: a /test call adds no source to the list and the id stays 404', async () => {
    const manager = getDataSourceManager()
    manager.registerAdapterType('postgres', OkAdapter as never)
    // control source so the list is non-empty — proves the absence below is real, not vacuous.
    await manager.addDataSource(cfg('ctrl_keep', 'postgres'), { ownerId: 'tester', persist: false })

    await request(appAs('tester')).post('/api/data-sources/test').send({
      id: 'eph_nopersist', name: 'x', type: 'postgres', connection: { host: 'h' },
    }).expect(200)

    const ids = manager.listDataSources({ ownerId: 'tester' }).map(s => s.id)
    expect(ids).toContain('ctrl_keep')
    expect(ids).not.toContain('eph_nopersist')
    const got = await request(appAs('tester')).get('/api/data-sources/eph_nopersist')
    expect(got.status).toBe(404)
  })
})
