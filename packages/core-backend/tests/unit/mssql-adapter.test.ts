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
  options: {
    encrypt: boolean
    trustServerCertificate: boolean
    cryptoCredentialsDetails?: { minVersion?: string; ciphers?: string }
  }
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

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
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

  it('keeps numeric boolean-like security knobs on the legacy fallback path', () => {
    const cfg = poolConfig({
      host: 'db',
      database: 'D',
      encrypt: 0,
      legacyTls: 1,
      trustServerCertificate: 0,
    })
    expect(cfg.options.encrypt).toBe(true)
    expect(cfg.options.trustServerCertificate).toBe(true)
    expect(cfg.options.cryptoCredentialsDetails).toBeUndefined()
  })

  it('passes an explicit timeout of 0 through (no-timeout), not the default', () => {
    const cfg = poolConfig({ host: 'db', database: 'D', connectionTimeoutMs: 0, requestTimeoutMs: 0 })
    expect(cfg.connectionTimeout).toBe(0)
    expect(cfg.requestTimeout).toBe(0)
  })

  it('parses server alias (host:port and host,port) and host wins over server', () => {
    expect(poolConfig({ server: 'h1:1444', database: 'D' })).toMatchObject({ server: 'h1', port: 1444 })
    expect(poolConfig({ server: 'h2,1455', database: 'D' })).toMatchObject({ server: 'h2', port: 1455 })
    expect(poolConfig({ server: 'db\\inst,1444', database: 'D' })).toMatchObject({ server: 'db\\inst', port: 1444 })
    expect(poolConfig({ host: 'hWin', server: 'hLose,1466', port: 1433, database: 'D' })).toMatchObject({ server: 'hWin', port: 1433 })
  })

  it('throws on a server-embedded port that conflicts with an explicit port', () => {
    expect(() => poolConfig({ server: 'h,1444', port: 9999, database: 'D' })).toThrow(/Conflicting port/)
    expect(() => poolConfig({ server: 'db\\inst,1444', port: 9999, database: 'D' })).toThrow(/Conflicting port/)
  })
})

describe('MSSQLAdapter — legacy TLS lever (B3)', () => {
  // Build an adapter so we can subscribe to the audit event before buildPoolConfig.
  function adapter(connection: Record<string, unknown>, name = 's'): MSSQLAdapter {
    return new MSSQLAdapter({
      id: 's', name, type: 'sqlserver',
      connection: connection as DataSourceConfig['connection'],
      credentials: { username: 'u', password: 'p' }, options: { autoConnect: false },
    })
  }
  const build = (a: MSSQLAdapter): PoolConfig =>
    (a as unknown as { buildPoolConfig(): PoolConfig }).buildPoolConfig()

  it('secure by default: no TLS keys → no cryptoCredentialsDetails', () => {
    const cfg = poolConfig({ host: 'db', database: 'D' })
    expect(cfg.options.cryptoCredentialsDetails).toBeUndefined()
    expect(cfg.options.encrypt).toBe(true)
  })

  it('explicit tlsMinVersion lowers the floor but keeps the wire encrypted', () => {
    const cfg = poolConfig({ host: 'db', database: 'D', tlsMinVersion: 'TLSv1' })
    expect(cfg.options.cryptoCredentialsDetails).toEqual({ minVersion: 'TLSv1' })
    expect(cfg.options.encrypt).toBe(true) // a downgrade lowers the floor, not encryption
  })

  it('explicit tlsCiphers sets cryptoCredentialsDetails.ciphers', () => {
    const cfg = poolConfig({ host: 'db', database: 'D', tlsCiphers: 'DEFAULT@SECLEVEL=0' })
    expect(cfg.options.cryptoCredentialsDetails).toEqual({ ciphers: 'DEFAULT@SECLEVEL=0' })
  })

  it('legacyTls:true applies the documented legacy defaults', () => {
    const cfg = poolConfig({ host: 'db', database: 'D', legacyTls: true })
    expect(cfg.options.cryptoCredentialsDetails).toEqual({ minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' })
  })

  it('explicit keys override the legacyTls convenience defaults', () => {
    const cfg = poolConfig({ host: 'db', database: 'D', legacyTls: true, tlsMinVersion: 'TLSv1.1', tlsCiphers: 'HIGH' })
    expect(cfg.options.cryptoCredentialsDetails).toEqual({ minVersion: 'TLSv1.1', ciphers: 'HIGH' })
  })

  it('throws on an invalid tlsMinVersion (enum-strict, no silent fallback)', () => {
    expect(() => poolConfig({ host: 'db', database: 'D', tlsMinVersion: 'SSLv3' })).toThrow(/Invalid connection\.tlsMinVersion/)
  })

  it('rejects combining a B3 TLS downgrade with encrypt:false (plaintext is a separate hatch)', () => {
    expect(() => poolConfig({ host: 'db', database: 'D', legacyTls: true, encrypt: false }))
      .toThrow(/encrypt=false cannot be combined/)
    expect(() => poolConfig({ host: 'db', database: 'D', tlsMinVersion: 'TLSv1', encrypt: false }))
      .toThrow(/encrypt=false cannot be combined/)
    expect(() => poolConfig({ host: 'db', database: 'D', tlsCiphers: 'DEFAULT@SECLEVEL=0', encrypt: false }))
      .toThrow(/encrypt=false cannot be combined/)
  })

  it('still allows encrypt:false on its own (plaintext escape hatch, no B3 keys)', () => {
    const cfg = poolConfig({ host: 'db', database: 'D', encrypt: false })
    expect(cfg.options.encrypt).toBe(false)
    expect(cfg.options.cryptoCredentialsDetails).toBeUndefined()
  })

  it('emits a tls-downgrade audit event (with source name + params) when downgrading', () => {
    const a = adapter({ host: 'db', database: 'D', legacyTls: true }, 'legacy-erp')
    const events: Array<{ adapter: string; minVersion?: string; ciphers?: string }> = []
    a.on('tls-downgrade', e => events.push(e as never))
    build(a)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ adapter: 'legacy-erp', minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' })
  })

  it('emits no audit event for a secure-default source', () => {
    const a = adapter({ host: 'db', database: 'D' })
    const events: unknown[] = []
    a.on('tls-downgrade', e => events.push(e))
    build(a)
    expect(events).toHaveLength(0)
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

  it('select: preserves legacy-compatible SQL Server identifier shapes through the helper', async () => {
    const fp = fakePool()
    await adapterWithFakePool(fp).select('tenant.dbo.2024_orders', {
      select: ['2024_amount'],
      orderBy: [{ column: 'tenant.dbo.2024_created_at', direction: 'asc' }],
      limit: 5,
    })
    const { sql } = fp.calls[0]
    expect(sql).toContain('[tenant].[dbo].[2024_orders]')
    expect(sql).toContain('[2024_amount]')
    expect(sql).toContain('[tenant].[dbo].[2024_created_at] ASC')
  })

  it('select: OFFSET/FETCH with ORDER BY when offset is given', async () => {
    const fp = fakePool()
    await adapterWithFakePool(fp).select('t', { orderBy: [{ column: 'id', direction: 'asc' }], limit: 10, offset: 20 })
    const { sql } = fp.calls[0]
    expect(sql).toContain('ORDER BY [id] ASC')
    expect(sql).toContain('OFFSET 20 ROWS')
    expect(sql).toContain('FETCH NEXT 10 ROWS ONLY')
  })

  it('select: structured OR groups support C3 composite keyset predicates', async () => {
    const fp = fakePool()
    await adapterWithFakePool(fp).select('dbo.orders', {
      where: {
        status: 'open',
        $or: [
          { updated_at: { $gt: '2026-06-01T00:00:00.000Z' } },
          {
            updated_at: '2026-06-01T00:00:00.000Z',
            id: { $gt: 42 },
          },
        ],
      },
      orderBy: [
        { column: 'updated_at', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
      limit: 100,
    })

    const { sql, params } = fp.calls[0]
    expect(normalizeSql(sql)).toBe(
      'SELECT TOP (100) * FROM [dbo].[orders] WHERE status = @p0 AND ((updated_at > @p1) OR (updated_at = @p2 AND id > @p3)) ORDER BY [updated_at] ASC, [id] ASC'
    )
    expect(params).toEqual({
      p0: 'open',
      p1: '2026-06-01T00:00:00.000Z',
      p2: '2026-06-01T00:00:00.000Z',
      p3: 42,
    })
    expect(sql).not.toContain('2026-06-01')
  })

  it('select: rejects malformed structured groups before the driver query is issued', async () => {
    const fp = fakePool()

    await expect(adapterWithFakePool(fp).select('dbo.orders', {
      where: { $or: [] },
      limit: 1,
    })).rejects.toThrow(/\$or must be a non-empty array/)

    expect(fp.calls).toHaveLength(0)
  })

  it('select: rejects unsupported where operators before the driver query is issued', async () => {
    const fp = fakePool()

    await expect(adapterWithFakePool(fp).select('dbo.orders', {
      where: { updated_at: { $after: '2026-06-01T00:00:00.000Z' } as never },
      limit: 1,
    })).rejects.toThrow(/Unsupported where operator/)

    expect(fp.calls).toHaveLength(0)
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
