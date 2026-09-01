import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))
// The non-owner-404 pin below now needs a NON-ADMIN denied user (platform admins
// legitimately see every source — data-source-visibility-authority-matrix.test.ts).
// Stub rbacGuard's DB-backed fallbacks so a member with req.user.permissions is
// deterministic without a pool.
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => false),
  userHasPermission: vi.fn(async () => false),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))
vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn(async () => true),
}))

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { dataSourcesRouter } from '../../src/routes/data-sources'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { usePinnedServer } from '../utils/pinned-server'
import { __resetSqlArmBindingsForTests, pinSqlSourceConnection } from '../../src/data-adapters/sql-write-arm-binding'
import { OUTBOUND_SQL_WRITE_TARGETS_ENV } from '../../src/data-adapters/outbound-sql-write-gate'

const pinned = usePinnedServer()

// The adapter's structured insert/update/delete build write SQL and funnel through query(), which the
// default-deny SQL write gate now governs. To exercise SQL GENERATION for a write, arm source 's' in a
// throwaway allowlist file and pin it to the fake-pool connection (the deploy-tier provisioning these
// tests stand in for). Returns a cleanup to restore the env and the process-singleton pin registry.
function armAndPinWriteSource(connection: Record<string, unknown>): () => void {
  const saved = process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV]
  const file = path.join(os.tmpdir(), `mssql-adapter-arm-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, JSON.stringify({
    allowlistId: 'mssql-adapter-test', allowlistVersion: 1,
    targets: [{ entryId: 'e1', systemId: 's', allObjects: true }],
  }))
  process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV] = file
  pinSqlSourceConnection('s', connection)
  return () => {
    if (saved === undefined) delete process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV]
    else process.env[OUTBOUND_SQL_WRITE_TARGETS_ENV] = saved
    __resetSqlArmBindingsForTests()
    try { fs.unlinkSync(file) } catch { /* best effort */ }
  }
}

// The default connection adapterWithFakePool builds (no overrides) — what the write source is pinned to.
const FAKE_POOL_CONNECTION = { host: 'db', port: 1433, database: 'ERP' }

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

function adapterWithFakePool(
  fp: ReturnType<typeof fakePool>,
  connectionOverrides: Record<string, unknown> = {}
): MSSQLAdapter {
  const a = new MSSQLAdapter({
    id: 's', name: 's', type: 'sqlserver',
    connection: { host: 'db', port: 1433, database: 'ERP', ...connectionOverrides } as DataSourceConfig['connection'],
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

  // #4591 (DATA_SOURCE_OFFSET_ORDERING_REQUIRED, DRAFT) documents that an offset read with no real
  // ORDER BY key cannot guarantee stable row order across pages. This pins TODAY's default (flag
  // unset) behavior byte-for-byte: SQL Server's OFFSET/FETCH syntax requires SOME ORDER BY to be
  // valid at all, so the adapter falls back to a no-op `(SELECT NULL)`. That fallback is NOT a fix —
  // it exists only to keep the SQL syntactically legal — and this test exists so nobody mistakes
  // silence here for "MSSQL solved #4591": it did not, this is still the exposure the doc describes.
  it('select: offset without orderBy falls back to a non-deterministic ORDER BY (SELECT NULL) — pins the KNOWN #4591 exposure, unchanged by default', async () => {
    const fp = fakePool()
    await adapterWithFakePool(fp).select('t', { limit: 10, offset: 20 })
    const { sql } = fp.calls[0]
    expect(sql).toContain('ORDER BY (SELECT NULL) OFFSET 20 ROWS')
    expect(sql).toContain('FETCH NEXT 10 ROWS ONLY')
  })

  describe('select: strictOffsetOrdering opt-in (default OFF, narrow #4591 belt)', () => {
    it('default (flag unset): offset without orderBy still runs, unchanged (byte-identical to before this change)', async () => {
      const fp = fakePool()
      await adapterWithFakePool(fp).select('t', { limit: 10, offset: 20 })
      expect(fp.calls[0].sql).toContain('ORDER BY (SELECT NULL) OFFSET 20 ROWS')
    })

    it('strictOffsetOrdering:true + offset>0 + no orderBy -> refused BEFORE the driver query is issued', async () => {
      const fp = fakePool()
      await expect(
        adapterWithFakePool(fp, { strictOffsetOrdering: true }).select('t', { limit: 10, offset: 20 })
      ).rejects.toThrow(/strictOffsetOrdering/)
      expect(fp.calls).toHaveLength(0)
    })

    it('strictOffsetOrdering:true + offset>0 + an explicit orderBy -> still runs normally (unaffected)', async () => {
      const fp = fakePool()
      await adapterWithFakePool(fp, { strictOffsetOrdering: true }).select('t', {
        limit: 10,
        offset: 20,
        orderBy: [{ column: 'id', direction: 'asc' }],
      })
      const { sql } = fp.calls[0]
      expect(sql).toContain('ORDER BY [id] ASC OFFSET 20 ROWS')
    })

    it('strictOffsetOrdering:true + offset omitted/0 -> unaffected (TOP path never requires ORDER BY)', async () => {
      const fp = fakePool()
      await adapterWithFakePool(fp, { strictOffsetOrdering: true }).select('t', { limit: 10 })
      expect(fp.calls[0].sql).toContain('SELECT TOP (10)')
      const fp2 = fakePool()
      await adapterWithFakePool(fp2, { strictOffsetOrdering: true }).select('t', { limit: 10, offset: 0 })
      expect(fp2.calls[0].sql).toContain('SELECT TOP (10)')
    })

    it('strictOffsetOrdering:"false" (string) behaves as off, like the other boolean-ish connection knobs', async () => {
      const fp = fakePool()
      await adapterWithFakePool(fp, { strictOffsetOrdering: 'false' }).select('t', { limit: 10, offset: 20 })
      expect(fp.calls[0].sql).toContain('ORDER BY (SELECT NULL) OFFSET 20 ROWS')
    })
  })

  // W-5 (armed B2a floor 2): `options.strictOffsetOrdering` is a PER-CALL override of the SAME check
  // above — the seam that resolves an armed B2a read's source config sets it for one read, without
  // touching this data source's own connection.strictOffsetOrdering setting.
  describe('select: options.strictOffsetOrdering per-call override (W-5)', () => {
    it('options.strictOffsetOrdering:true refuses offset>0 without orderBy even when connection.strictOffsetOrdering is unset', async () => {
      const fp = fakePool()
      await expect(
        adapterWithFakePool(fp).select('t', { limit: 10, offset: 20, strictOffsetOrdering: true })
      ).rejects.toThrow(/strictOffsetOrdering/)
      expect(fp.calls).toHaveLength(0)
    })

    it('options.strictOffsetOrdering:true refuses even when connection.strictOffsetOrdering is explicitly false', async () => {
      const fp = fakePool()
      await expect(
        adapterWithFakePool(fp, { strictOffsetOrdering: false }).select('t', { limit: 10, offset: 20, strictOffsetOrdering: true })
      ).rejects.toThrow(/strictOffsetOrdering/)
      expect(fp.calls).toHaveLength(0)
    })

    it('options.strictOffsetOrdering:true + an explicit orderBy still runs normally (unaffected)', async () => {
      const fp = fakePool()
      await adapterWithFakePool(fp).select('t', {
        limit: 10,
        offset: 20,
        strictOffsetOrdering: true,
        orderBy: [{ column: 'id', direction: 'asc' }],
      })
      expect(fp.calls[0].sql).toContain('ORDER BY [id] ASC OFFSET 20 ROWS')
    })

    it('options.strictOffsetOrdering:true + offset omitted/0 is unaffected (TOP path never requires ORDER BY)', async () => {
      const fp = fakePool()
      await adapterWithFakePool(fp).select('t', { limit: 10, strictOffsetOrdering: true })
      expect(fp.calls[0].sql).toContain('SELECT TOP (10)')
    })

    it('options.strictOffsetOrdering unset/false is byte-identical to before this option existed', async () => {
      const fp = fakePool()
      await adapterWithFakePool(fp).select('t', { limit: 10, offset: 20 })
      expect(fp.calls[0].sql).toContain('ORDER BY (SELECT NULL) OFFSET 20 ROWS')
      const fp2 = fakePool()
      await adapterWithFakePool(fp2).select('t', { limit: 10, offset: 20, strictOffsetOrdering: false })
      expect(fp2.calls[0].sql).toContain('ORDER BY (SELECT NULL) OFFSET 20 ROWS')
    })
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
    // FIX B: WHERE identifiers are BRACKETED, like every other clause this adapter emits. This golden
    // string previously pinned `WHERE status = @p0 AND ((updated_at > @p1) …)` — bare — while already
    // expecting a bracketed `ORDER BY [updated_at]`, and that inconsistency WAS the defect: a bare
    // identifier that happens to be a reserved word is indistinguishable from the keyword to the write
    // gate's text classifier, so `WHERE key = @p0` was read as a WRITE and an ordinary read was refused.
    // Only the quoting changed; the clause structure, operators, ordering and parameters are identical.
    expect(normalizeSql(sql)).toBe(
      'SELECT TOP (100) * FROM [dbo].[orders] WHERE [status] = @p0 AND (([updated_at] > @p1) OR ([updated_at] = @p2 AND [id] > @p3)) ORDER BY [updated_at] ASC, [id] ASC'
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
    const cleanup = armAndPinWriteSource(FAKE_POOL_CONNECTION)
    try {
      const fp = fakePool()
      await adapterWithFakePool(fp).insert('t', { name: 'x', n: 3 })
      const { sql, params } = fp.calls[0]
      expect(sql).toContain('INSERT INTO [t]')
      expect(sql).toContain('OUTPUT INSERTED.*')
      expect(params.p0).toBe('x')
      expect(params.p1).toBe(3)
      expect(sql).not.toContain("'x'")
    } finally {
      cleanup()
    }
  })

  it('delete: OUTPUT DELETED.* + parameterized where', async () => {
    const cleanup = armAndPinWriteSource(FAKE_POOL_CONNECTION)
    try {
      const fp = fakePool()
      await adapterWithFakePool(fp).delete('t', { id: 7 })
      const { sql, params } = fp.calls[0]
      expect(sql).toContain('DELETE FROM [t]')
      expect(sql).toContain('OUTPUT DELETED.*')
      expect(params.p0).toBe(7)
    } finally {
      cleanup()
    }
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
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/data-sources').send(body('sql-prod'))
    expect(res.status).toBe(201)
  })

  // POST /api/data-sources never auto-connects (addDataSource always passes autoConnect=false to
  // addDataSourceInternal), so before this fix a sqlserver source missing BOTH connection.host and
  // connection.server persisted successfully at 201 and only failed later — the first time
  // something actually called connect() (next /select, /query, /test, or a server restart replaying
  // persisted sources) — with MSSQLAdapter.resolveServerAndPort()'s
  // "SQL Server data source requires connection.host or connection.server". This closes that gap at
  // the API boundary instead.
  it('rejects a sqlserver create with neither connection.host nor connection.server (400, never persists)', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/data-sources').send({
      id: 'sql-no-host', name: 'sql-no-host', type: 'sqlserver',
      connection: { database: 'ERP' },
      credentials: { username: 'u', password: 'p' },
      options: { autoConnect: false },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toMatch(/connection\.host.*connection\.server/)
    // Never persisted: a follow-up create with the SAME id must not 409 (a 409 would mean the
    // rejected payload landed in the store anyway).
    const retry = await request(pinned.url()).post('/api/data-sources').send(body('sql-no-host'))
    expect(retry.status).toBe(201)
  })

  it('accepts a sqlserver create using connection.server instead of connection.host (documented alias)', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/data-sources').send({
      id: 'sql-server-alias', name: 'sql-server-alias', type: 'sqlserver',
      connection: { server: 'db2,1444', database: 'ERP' },
      credentials: { username: 'u', password: 'p' },
      options: { autoConnect: false },
    })
    expect(res.status).toBe(201)
  })

  it('a read-only sqlserver source rejects write SQL on /query (A-RO)', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send(body('sql-ro'))
    const res = await request(pinned.url()).post('/api/data-sources/sql-ro/query').send({ sql: 'DELETE FROM t' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('READ_ONLY')
  })

  it('a non-admin non-owner gets 404 on a sqlserver source (A0.1)', async () => {
    currentUser = admin('alice')
    pinned.setApp(app)
    await request(pinned.url()).post('/api/data-sources').send(body('sql-own'))
    // bob is a NON-ADMIN holding the global read code: rbacGuard passes, the
    // manager's ownership scope must still refuse with the uniform 404.
    // (Platform admins now legitimately see every source by design.)
    currentUser = { id: 'bob', roles: ['member'], permissions: ['data_sources:read'] } as never
    expect((await request(pinned.url()).get('/api/data-sources/sql-own')).status).toBe(404)
  })
})
