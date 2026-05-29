import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter } from '../../src/routes/data-sources'
import {
  DATA_SOURCE_MAX_ROWS,
  DATA_SOURCE_DEFAULT_LIMIT,
  type DataSourceConfig,
} from '../../src/data-adapters/BaseAdapter'

// A5 — result-boundary policy: read paths must be bounded so a large source table cannot OOM the
// backend. DEFAULT_LIMIT is the route's friendly default when limit is omitted; MAX_ROWS is the
// hard ceiling enforced at the ADAPTER layer (the chokepoint every read passes through, including
// direct internal callers that bypass the route).

const cfg = (id: string, type = 'postgres'): DataSourceConfig => ({
  id, name: id, type, connection: { host: 'localhost', database: 'x' }, options: { autoConnect: false },
})
const eff = (a: unknown, l?: number | null): number =>
  (a as { resolveEffectiveLimit(l?: number | null): number }).resolveEffectiveLimit(l)

describe('A5 constants + resolveEffectiveLimit backstop', () => {
  const pg = new PostgresAdapter(cfg('postgres'))

  it('exposes the agreed boundary values', () => {
    expect(DATA_SOURCE_DEFAULT_LIMIT).toBe(1000)
    expect(DATA_SOURCE_MAX_ROWS).toBe(10000)
  })

  it('omitted/null limit -> MAX (bounded, never "whole table")', () => {
    expect(eff(pg)).toBe(DATA_SOURCE_MAX_ROWS)
    expect(eff(pg, null)).toBe(DATA_SOURCE_MAX_ROWS)
  })

  it('within range -> passthrough (boundary inclusive)', () => {
    expect(eff(pg, 1)).toBe(1)
    expect(eff(pg, 5000)).toBe(5000)
    expect(eff(pg, DATA_SOURCE_MAX_ROWS)).toBe(DATA_SOURCE_MAX_ROWS)
  })

  it('over MAX -> throw (no silent clamp); invalid -> throw', () => {
    expect(() => eff(pg, DATA_SOURCE_MAX_ROWS + 1)).toThrow(/exceeds the maximum/)
    expect(() => eff(pg, 0)).toThrow(/positive integer/)
    expect(() => eff(pg, -5)).toThrow(/positive integer/)
    expect(() => eff(pg, 1.5)).toThrow(/positive integer/)
  })
})

// Fake mssql pool capturing executed SQL (same pattern as data-source-identifier-quoting.test.ts).
function mssqlFakePool() {
  const calls: string[] = []
  const pool = {
    request() {
      const req = { input() { return req }, async query(sql: string) { calls.push(sql); return { recordset: [], rowsAffected: [] } } }
      return req
    },
    async close() {},
  }
  const a = new MSSQLAdapter({
    id: 's', name: 's', type: 'sqlserver',
    connection: { host: 'db', database: 'D' }, credentials: { username: 'u', password: 'p' }, options: { autoConnect: false },
  })
  const internal = a as unknown as { pool: unknown; connected: boolean }
  internal.pool = pool
  internal.connected = true
  return { a, calls }
}

function pgFakePool() {
  const calls: string[] = []
  const pool = { async query(sql: string) { calls.push(sql); return { rows: [], rowCount: 0, fields: [] } } }
  const a = new PostgresAdapter(cfg('postgres'))
  const internal = a as unknown as { pool: unknown; connected: boolean }
  internal.pool = pool
  internal.connected = true
  return { a, calls }
}

describe('A5 adapter backstop on the wire (select is always bounded)', () => {
  it('MSSQL: omitted limit emits TOP (MAX) — never an unbounded scan', async () => {
    const { a, calls } = mssqlFakePool()
    await a.select('dbo.orders', {})
    expect(calls[0]).toContain(`TOP (${DATA_SOURCE_MAX_ROWS})`)
  })

  it('MSSQL: explicit in-range limit passes through as TOP (n)', async () => {
    const { a, calls } = mssqlFakePool()
    await a.select('orders', { limit: 50 })
    expect(calls[0]).toContain('TOP (50)')
  })

  it('MSSQL: over-MAX throws and NEVER executes the query (no silent clamp)', async () => {
    const { a, calls } = mssqlFakePool()
    await expect(a.select('orders', { limit: DATA_SOURCE_MAX_ROWS + 1 })).rejects.toThrow(/exceeds the maximum/)
    expect(calls.length).toBe(0)
  })

  it('Postgres: omitted limit emits LIMIT MAX; over-MAX throws without querying', async () => {
    const omit = pgFakePool()
    await omit.a.select('users', {})
    expect(omit.calls[0]).toContain(`LIMIT ${DATA_SOURCE_MAX_ROWS}`)

    const over = pgFakePool()
    await expect(over.a.select('users', { limit: 99999 })).rejects.toThrow(/exceeds the maximum/)
    expect(over.calls.length).toBe(0)
  })
})

describe('A5 route layer (/select default + /query warning)', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.user = currentUser as never; next() })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })

  beforeEach(() => {
    currentUser = admin('alice')
    vi.restoreAllMocks()
  })

  it('/select applies DEFAULT_LIMIT when the caller omits limit', async () => {
    const spy = vi.spyOn(DataSourceManager.prototype, 'select').mockResolvedValue({ data: [] })
    await request(app).post('/api/data-sources').send(cfg('sel-default'))
    const res = await request(app).post('/api/data-sources/sel-default/select').send({ table: 't' })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0][2]).toMatchObject({ limit: DATA_SOURCE_DEFAULT_LIMIT })
  })

  it('/select passes an explicit in-range limit through unchanged', async () => {
    const spy = vi.spyOn(DataSourceManager.prototype, 'select').mockResolvedValue({ data: [] })
    await request(app).post('/api/data-sources').send(cfg('sel-explicit'))
    await request(app).post('/api/data-sources/sel-explicit/select').send({ table: 't', limit: 42 })
    expect(spy.mock.calls[0][2]).toMatchObject({ limit: 42 })
  })

  it('/select rejects an over-MAX limit with 400 (schema gate, never reaches the adapter)', async () => {
    const spy = vi.spyOn(DataSourceManager.prototype, 'select').mockResolvedValue({ data: [] })
    await request(app).post('/api/data-sources').send(cfg('sel-over'))
    const res = await request(app)
      .post('/api/data-sources/sel-over/select')
      .send({ table: 't', limit: DATA_SOURCE_MAX_ROWS + 1 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(spy).not.toHaveBeenCalled()
  })

  it('/query warns (response + audit) when the raw SQL has no row-count limit', async () => {
    vi.spyOn(DataSourceManager.prototype, 'query').mockResolvedValue({ data: [] })
    await request(app).post('/api/data-sources').send(cfg('q-warn'))
    const res = await request(app).post('/api/data-sources/q-warn/query').send({ sql: 'SELECT * FROM big' })
    expect(res.status).toBe(200)
    expect(res.body.warning).toMatch(/no row-count limit \(LIMIT\/TOP\/FETCH\)/)
  })

  it('/query STILL warns for a bare OFFSET — it skips rows but does not cap them', async () => {
    // P2: `SELECT * FROM big OFFSET 1000` returns the rest of a huge table; OFFSET is not a bound.
    vi.spyOn(DataSourceManager.prototype, 'query').mockResolvedValue({ data: [] })
    await request(app).post('/api/data-sources').send(cfg('q-offset'))
    const res = await request(app).post('/api/data-sources/q-offset/query').send({ sql: 'SELECT * FROM big OFFSET 1000 ROWS' })
    expect(res.status).toBe(200)
    expect(res.body.warning).toMatch(/no row-count limit/)
  })

  it('/query does NOT warn when the SQL actually caps rows (LIMIT, or OFFSET+FETCH)', async () => {
    vi.spyOn(DataSourceManager.prototype, 'query').mockResolvedValue({ data: [] })
    await request(app).post('/api/data-sources').send(cfg('q-ok'))
    const limited = await request(app).post('/api/data-sources/q-ok/query').send({ sql: 'SELECT * FROM big LIMIT 10' })
    expect(limited.body.warning).toBeUndefined()
    // OFFSET + FETCH NEXT is a genuine bound (T-SQL pagination)
    const fetched = await request(app)
      .post('/api/data-sources/q-ok/query')
      .send({ sql: 'SELECT * FROM big ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY' })
    expect(fetched.body.warning).toBeUndefined()
  })
})
