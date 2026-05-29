import { describe, expect, it } from 'vitest'

import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { MySQLAdapter } from '../../src/data-adapters/MySQLAdapter'
import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

// A2: sanitizeIdentifier now VALIDATES (throws on illegal) instead of silently stripping, and supports
// schema-qualified names; each SQL adapter quotes PER SEGMENT.
const cfg = (type: string): DataSourceConfig => ({ id: 'x', name: 'x', type, connection: {}, options: {} })
const pg = new PostgresAdapter(cfg('postgres'))
const mysql = new MySQLAdapter(cfg('mysql'))
const mssql = new MSSQLAdapter(cfg('sqlserver'))

const sanitize = (a: unknown, id: string) => (a as { sanitizeIdentifier(s: string): string }).sanitizeIdentifier(id)
const mssqlQuote = (id: string) => (mssql as unknown as { quoteIdent(s: string): string }).quoteIdent(id)
const mysqlQuote = (id: string) => (mysql as unknown as { sanitizeMySQLIdentifier(s: string): string }).sanitizeMySQLIdentifier(id)

// Fake mssql pool capturing executed SQL — covers that the quoting is actually applied on the wire.
function fakePool() {
  const calls: string[] = []
  const pool = {
    request() {
      const req = { input() { return req }, async query(sql: string) { calls.push(sql); return { recordset: [], rowsAffected: [] } } }
      return req
    },
    async close() {},
  }
  return { pool, calls }
}
function mssqlWithPool(fp: ReturnType<typeof fakePool>): MSSQLAdapter {
  const a = new MSSQLAdapter({
    id: 's', name: 's', type: 'sqlserver',
    connection: { host: 'db', database: 'D' }, credentials: { username: 'u', password: 'p' }, options: { autoConnect: false },
  })
  const internal = a as unknown as { pool: unknown; connected: boolean }
  internal.pool = fp.pool
  internal.connected = true
  return a
}

describe('A2 identifier validation + per-segment quoting', () => {
  it('sanitizeIdentifier: valid passes, schema-qualified preserved (NOT collapsed), illegal throws', () => {
    expect(sanitize(pg, 'users')).toBe('users')
    expect(sanitize(pg, 'public.users')).toBe('public.users') // dot preserved — not the old "publicusers"
    expect(() => sanitize(pg, 'bad-name')).toThrow(/Invalid identifier/)
    expect(() => sanitize(pg, 'a;DROP TABLE x')).toThrow(/Invalid identifier/)
    expect(() => sanitize(pg, 'public.')).toThrow(/Invalid identifier/) // empty segment
    expect(() => sanitize(pg, '')).toThrow(/Invalid identifier/)
  })

  it('MSSQL brackets PER SEGMENT: dbo.orders -> [dbo].[orders]; illegal throws', () => {
    expect(mssqlQuote('orders')).toBe('[orders]')
    expect(mssqlQuote('dbo.orders')).toBe('[dbo].[orders]')
    expect(() => mssqlQuote('bad-name')).toThrow(/Invalid identifier/)
  })

  it('MySQL backticks PER SEGMENT: shop.orders -> `shop`.`orders`; illegal throws', () => {
    expect(mysqlQuote('orders')).toBe('`orders`')
    expect(mysqlQuote('shop.orders')).toBe('`shop`.`orders`')
    expect(() => mysqlQuote('bad name')).toThrow(/Invalid identifier/)
  })

  it('MSSQL select wire: table / select / orderBy quoted per segment; where key validated', async () => {
    const fp = fakePool()
    await mssqlWithPool(fp).select('dbo.orders', {
      select: ['rpt.amount'],
      where: { status: 'open' },
      orderBy: [{ column: 'created', direction: 'asc' }],
    })
    const sql = fp.calls[0]
    expect(sql).toContain('[dbo].[orders]') // table (schema-qualified)
    expect(sql).toContain('[rpt].[amount]') // select column (schema-qualified)
    expect(sql).toContain('[created]')       // orderBy column
    expect(sql).toMatch(/\bstatus\b/)        // where key validated (base where-clause is unbracketed)
  })

  it('MSSQL select rejects an illegal table / where-key (throws — not a silent strip)', async () => {
    await expect(mssqlWithPool(fakePool()).select('bad-table', {})).rejects.toThrow(/Invalid identifier/)
    await expect(mssqlWithPool(fakePool()).select('orders', { where: { 'bad-key': 1 } })).rejects.toThrow(/Invalid identifier/)
  })
})
