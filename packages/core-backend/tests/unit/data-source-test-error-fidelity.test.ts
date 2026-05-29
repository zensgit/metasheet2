import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const SECRET = 'SuperSecretPw!2026'

// A fake adapter whose connect() fails with an error that EMBEDS the configured password — to prove the
// surfaced cause is redacted and the secret never reaches the wire (A3 safety guardrail).
class FailingConnectAdapter extends BaseDataAdapter {
  async connect(): Promise<void> {
    const err = new Error(
      `ECONNREFUSED 127.0.0.1: login failed (password=${this.config.credentials?.password}; ` +
        `conn=Server=db;Pwd=${this.config.credentials?.password})`
    )
    await this.onError(err) // records redactSecrets(err.message) into lastConnectionError
    throw err
  }
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return false }
  async testConnection(): Promise<boolean> { return false }
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
}

function appAs(userId: string) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.user = { id: userId, role: 'admin' } as never; next() })
  a.use(dataSourcesRouter())
  return a
}

afterEach(() => { vi.restoreAllMocks() })

describe('data-source /test error fidelity (A3)', () => {
  it('surfaces a redacted failure cause (ok:true, success:false, error.message) and never the secret', async () => {
    const manager = getDataSourceManager()
    manager.registerAdapterType('faildb', FailingConnectAdapter as never)
    const id = `ds_fail_${Date.now()}`
    await manager.addDataSource(
      {
        id, name: id, type: 'faildb',
        connection: { host: 'unreachable' },
        credentials: { username: 'u', password: SECRET },
        options: { autoConnect: false },
      },
      { ownerId: 'tester', persist: false }
    )

    const res = await request(appAs('tester')).get(`/api/data-sources/${id}/test`)

    expect(res.status).toBe(200)                       // the request itself completed
    expect(res.body.ok).toBe(true)                     // backward-compatible: request layer stays ok:true
    expect(res.body.data.success).toBe(false)          // the connection failed
    expect(res.body.data.error?.message).toBeTruthy()  // the cause is surfaced (A3 observability)
    expect(res.body.data.error.message).toContain('ECONNREFUSED') // real cause visible
    // SAFETY: the password must appear NOWHERE in the response, and the message is scrubbed.
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    expect(res.body.data.error.message).toContain('***')
  })

  it('redactSecrets scrubs both the configured secret value and password=/token= patterns', () => {
    const adapter = new FailingConnectAdapter({
      id: 'x', name: 'x', type: 'faildb', connection: {}, credentials: { password: SECRET }, options: {},
    } as DataSourceConfig)
    const redact = (adapter as unknown as { redactSecrets(m: string): string }).redactSecrets.bind(adapter)
    const out = redact(`boom: value=${SECRET} password=hunter2 token: abc.def.ghi authorization=Bearer xyz`)
    expect(out).not.toContain(SECRET)   // configured secret value scrubbed
    expect(out).not.toContain('hunter2') // password=… pattern scrubbed
    expect(out).not.toContain('abc.def.ghi') // token: … pattern scrubbed
    expect(out).not.toContain('xyz') // P2: the bearer token after "authorization=Bearer" is fully removed
    expect(out).toContain('***')
  })

  it('does not leak the secret via the adapter:error event / forwarded status (P1)', async () => {
    const manager = getDataSourceManager()
    manager.registerAdapterType('faildb', FailingConnectAdapter as never)
    const id = `ds_evt_${Date.now()}`
    await manager.addDataSource(
      {
        id, name: id, type: 'faildb',
        connection: { host: 'unreachable' },
        credentials: { username: 'u', password: SECRET },
        options: { autoConnect: false },
      },
      { ownerId: 'tester', persist: false }
    )
    const events: Array<{ error?: unknown }> = []
    manager.on('adapter:error', (p) => events.push(p as { error?: unknown }))

    await manager.testConnection(id) // connect fails → onError → adapter emits 'error' → manager forwards

    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      // the forwarded event (and thus the persisted last_error) must NOT carry the secret
      expect(JSON.stringify(e)).not.toContain(SECRET)
    }
    expect(events.some((e) => typeof e.error === 'string' && e.error.includes('***'))).toBe(true)
  })
})
