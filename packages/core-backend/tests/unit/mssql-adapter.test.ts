import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { dataSourcesRouter } from '../../src/routes/data-sources'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

type PoolConfig = {
  server: string
  port?: number
  database?: string
  user?: string
  password?: string
  options: { encrypt: boolean; trustServerCertificate: boolean }
  connectionTimeout: number
  requestTimeout: number
}

// Access private buildPoolConfig without invoking the real driver.
function poolConfig(connection: Record<string, unknown>): PoolConfig {
  const cfg: DataSourceConfig = {
    id: 's', name: 's', type: 'sqlserver',
    connection: connection as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  }
  return (new MSSQLAdapter(cfg) as unknown as { buildPoolConfig(): PoolConfig }).buildPoolConfig()
}

// Fake mssql pool capturing executed SQL + bound params.
function fakePool(rows: unknown[] = [], rowsAffected: number[] = []) {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
  const pool = {
    request() {
      const params: Record<string, unknown> = {}
      const req = {
        input(name: string, value: unknown) { params[name] = value; return req },
        async query(sql: string) { calls.push({ sql, params }); return { recordset: rows, rowsAffected } },
      }
      return req
    },
    async close() {},
  }
  return { pool, calls }
}

function adapterWithFakePool(fp: ReturnType<typeof fakePool>): MSSQLAdapter {
  const a = new MSSQLAdapter({
    id: 's', name: 's', type: 'sqlserver',
    connection: { host: 'db', port: 1433, database: 'ERP' },
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  })
  const internal = a as unknown as { pool: unknown; connected: boolean }
  internal.pool = fp.pool
  internal.connected = true
  return a
}

describe('MSSQLAdapter — config mapping', () => {
  it('maps host/port/db/credentials with secure TLS + timeout defaults', () => {
    const cfg = poolConfig({ host: 'db.internal', port: 1433, database: 'ERP' })
    expect(cfg.server).toBe('db.internal')
    expect(cfg.port).toBe(1433)
    expect(cfg.database).toBe('ERP')
    expect(cfg.user).toBe('u')
    expect(cfg.password).toBe('p')
    expect(cfg.options.encrypt).toBe(true) // secure default
    expect(cfg.options.trustServerCertificate).toBe(true)
    expect(cfg.connectionTimeout).toBe(10000)
    expect(cfg.requestTimeout).toBe(30000)
  })

  it('honors explicit encrypt:false and custom timeouts', () => {
    const cfg = poolConfig({ host: 'db', database: 'D', encrypt: false, connectionTimeoutMs: 5000, requestTimeoutMs: 12000 })
    expect(cfg.options.encrypt).toBe(false)
    expect(cfg.connectionTimeout).toBe(5000)
    expect(cfg.requestTimeout).toBe(12000)
  })

  it('parses server alias (host:port and host,port) and host wins over server', () => {
    expect(poolConfig({ server: 'h1:1444', database: 'D' })).toMatchObject({ server: 'h1', port: 1444 })
    expect(poolConfig({ server: 'h2,1455', database: 'D' })).toMatchObject({ server: 'h2', port: 1455 })
    expect(poolConfig({ host: 'hWin', server: 'hLose,1466', port: 1433, database: 'D' })).toMatchObject({ server: 'hWin', port: 1433 })
  })

  it('throws on a server-embedded port that conflicts with an explicit port', () => {
    expect(() => poolConfig({ server: 'h,1444', port: 9999, database: 'D' })).toThrow(/Conflicting port/)
  })
})

describe('MSSQLAdapter — SQL generation (fake driver)', () => {
  it('select: bracketed table, TOP for limit, @pN params, no leftover $N', async () => {
    const fp = fakePool([{ id: 1 }])
    await adapterWithFakePool(fp).select('users', { where: { active: true }, limit: 5 })
    const { sql, params } = fp.calls[0]
    expect(sql).toContain('SELECT TOP (5)')
    expect(sql).toContain('[users]')
    expect(sql).toMatch(/@p0/)
    expect(sql).not.toMatch(/\$\d/)
    expect(params.p0).toBe(true)
  })

  it('select: OFFSET/FETCH with ORDER BY when offset is given', async () => {
    const fp = fakePool()
    await adapterWithFakePool(fp).select('t', { orderBy: [{ column: 'id', direction: 'asc' }], limit: 10, offset: 20 })
    const { sql } = fp.calls[0]
    expect(sql).toContain('ORDER BY [id] ASC')
    expect(sql).toContain('OFFSET 20 ROWS')
    expect(sql).toContain('FETCH NEXT 10 ROWS ONLY')
  })

  it('insert: OUTPUT INSERTED.* + parameterized values (not concatenated)', async () => {
    const fp = fakePool()
    await adapterWithFakePool(fp).insert('t', { name: 'x', n: 3 })
    const { sql, params } = fp.calls[0]
    expect(sql).toContain('INSERT INTO [t]')
    expect(sql).toContain('OUTPUT INSERTED.*')
    expect(params.p0).toBe('x')
    expect(params.p1).toBe(3)
    expect(sql).not.toContain("'x'")
  })

  it('delete: OUTPUT DELETED.* + parameterized where', async () => {
    const fp = fakePool()
    await adapterWithFakePool(fp).delete('t', { id: 7 })
    const { sql, params } = fp.calls[0]
    expect(sql).toContain('DELETE FROM [t]')
    expect(sql).toContain('OUTPUT DELETED.*')
    expect(params.p0).toBe(7)
  })

  it('query: translates $N to @pN and returns the recordset', async () => {
    const fp = fakePool([{ ok: 1 }], [1])
    const res = await adapterWithFakePool(fp).query('SELECT * FROM t WHERE x = $1', [42])
    expect(fp.calls[0].sql).toBe('SELECT * FROM t WHERE x = @p0')
    expect(fp.calls[0].params.p0).toBe(42)
    expect(res.data).toEqual([{ ok: 1 }])
  })

  it('tableExists queries INFORMATION_SCHEMA', async () => {
    const fp = fakePool([{ cnt: 1 }])
    expect(await adapterWithFakePool(fp).tableExists('users')).toBe(true)
    expect(fp.calls[0].sql).toContain('INFORMATION_SCHEMA.TABLES')
  })

  it('is a SQL dialect and read-only by default', () => {
    const a = adapterWithFakePool(fakePool())
    expect(a.isSqlDialect()).toBe(true)
    expect(a.isReadOnly()).toBe(true)
  })

  it('throws a clear error when not connected', async () => {
    const a = new MSSQLAdapter({
      id: 's', name: 's', type: 'sqlserver',
      connection: { host: 'db', database: 'ERP' },
      credentials: { username: 'u', password: 'p' }, options: { autoConnect: false },
    })
    await expect(a.query('SELECT 1')).rejects.toThrow(/Not connected/)
  })
})

describe('data-sources route — sqlserver type', () => {
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.user = currentUser as never; next() })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })
  const body = (id: string) => ({
    id, name: id, type: 'sqlserver',
    connection: { host: 'db', port: 1433, database: 'ERP' },
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  })

  it('accepts type=sqlserver on create', async () => {
    currentUser = admin('alice')
    const res = await request(app).post('/api/data-sources').send(body('sql-prod'))
    expect(res.status).toBe(201)
  })

  it('a read-only sqlserver source rejects write SQL on /query (A-RO)', async () => {
    currentUser = admin('alice')
    await request(app).post('/api/data-sources').send(body('sql-ro'))
    const res = await request(app).post('/api/data-sources/sql-ro/query').send({ sql: 'DELETE FROM t' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('READ_ONLY')
  })

  it('a non-owner gets 404 on a sqlserver source (A0.1)', async () => {
    currentUser = admin('alice')
    await request(app).post('/api/data-sources').send(body('sql-own'))
    currentUser = admin('bob')
    expect((await request(app).get('/api/data-sources/sql-own')).status).toBe(404)
  })
})
