import { describe, expect, it } from 'vitest'

import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import type { DataSourceConfig, DbValue } from '../../src/data-adapters/BaseAdapter'

type PgField = { name: string; dataTypeID: number }
type PgResult = { rows: unknown[]; rowCount?: number; fields?: PgField[] }
type PgCall = { sql: string; params: DbValue[] }

const cfg = (): DataSourceConfig => ({
  id: 'pg',
  name: 'pg',
  type: 'postgres',
  connection: { host: 'db', database: 'ERP' },
  credentials: { username: 'u', password: 'p' },
  options: { autoConnect: false },
})

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function fakePgPool(results: PgResult[] = [{ rows: [], rowCount: 0, fields: [] }]) {
  const calls: PgCall[] = []
  const pending = [...results]
  let error: Error | null = null

  const pool = {
    async query(sql: string, params?: DbValue[]) {
      calls.push({ sql, params: params ?? [] })
      if (error) {
        throw error
      }
      return pending.shift() ?? { rows: [], rowCount: 0, fields: [] }
    },
  }

  return {
    pool,
    calls,
    failOnce(nextError: Error) {
      error = nextError
    },
  }
}

function adapterWithFakePool(fp: ReturnType<typeof fakePgPool>): PostgresAdapter {
  const adapter = new PostgresAdapter(cfg())
  const internal = adapter as unknown as { pool: unknown; connected: boolean }
  internal.pool = fp.pool
  internal.connected = true
  return adapter
}

describe('PostgresAdapter - query result mapping', () => {
  it('passes params through and maps row metadata from pg fields', async () => {
    const fp = fakePgPool([{
      rows: [{ id: 1, name: 'Widget', payload: { ok: true } }],
      rowCount: 1,
      fields: [
        { name: 'id', dataTypeID: 23 },
        { name: 'name', dataTypeID: 25 },
        { name: 'payload', dataTypeID: 3802 },
        { name: 'mystery', dataTypeID: 999999 },
      ],
    }])

    const result = await adapterWithFakePool(fp).query('SELECT * FROM public.items WHERE id = $1', [1])

    expect(fp.calls).toEqual([{ sql: 'SELECT * FROM public.items WHERE id = $1', params: [1] }])
    expect(result.data).toEqual([{ id: 1, name: 'Widget', payload: { ok: true } }])
    expect(result.metadata).toMatchObject({
      totalCount: 1,
      columns: [
        { name: 'id', type: 'integer', nullable: true },
        { name: 'name', type: 'text', nullable: true },
        { name: 'payload', type: 'jsonb', nullable: true },
        { name: 'mystery', type: 'unknown', nullable: true },
      ],
    })
  })

  it('returns an error result instead of throwing on driver query failure', async () => {
    const fp = fakePgPool()
    fp.failOnce(new Error('driver exploded'))

    const result = await adapterWithFakePool(fp).query('SELECT 1')

    expect(result.data).toEqual([])
    expect(result.error?.message).toBe('driver exploded')
  })
})

describe('PostgresAdapter - structured read SQL', () => {
  it('selects with sanitized identifiers, parameterized filters, order, limit, and offset', async () => {
    const fp = fakePgPool()

    await adapterWithFakePool(fp).select('public.orders', {
      select: ['id', 'status'],
      where: {
        status: 'open',
        amount: { $gte: 10 },
        deleted_at: null,
        id: [1, 2],
      },
      orderBy: [{ column: 'created_at', direction: 'desc' }],
      limit: 5,
      offset: 10,
    })

    expect(normalizeSql(fp.calls[0].sql)).toBe(
      'SELECT id, status FROM public.orders WHERE status = $1 AND amount >= $2 AND deleted_at IS NULL AND id IN ($3, $4) ORDER BY created_at DESC LIMIT 5 OFFSET 10'
    )
    expect(fp.calls[0].params).toEqual(['open', 10, 1, 2])
    expect(fp.calls[0].sql).not.toContain('open')
  })

  it('rejects invalid identifiers before the pool is queried', async () => {
    const badTable = fakePgPool()
    await expect(adapterWithFakePool(badTable).select('bad-table', { limit: 1 }))
      .rejects.toThrow(/Invalid identifier segment/)
    expect(badTable.calls).toHaveLength(0)

    const badColumn = fakePgPool()
    await expect(adapterWithFakePool(badColumn).select('orders', { where: { 'bad-key': 'x' }, limit: 1 }))
      .rejects.toThrow(/Invalid identifier segment/)
    expect(badColumn.calls).toHaveLength(0)
  })
})

describe('PostgresAdapter - write SQL generation', () => {
  it('insert parameterizes multi-row values and returns rows', async () => {
    const fp = fakePgPool([{ rows: [{ id: 1 }, { id: 2 }], rowCount: 2, fields: [] }])

    const result = await adapterWithFakePool(fp).insert('orders', [
      { name: 'alpha', qty: 1 },
      { name: 'beta', qty: 2 },
    ])

    expect(normalizeSql(fp.calls[0].sql)).toBe(
      'INSERT INTO orders (name, qty) VALUES ($1, $2), ($3, $4) RETURNING *'
    )
    expect(fp.calls[0].params).toEqual(['alpha', 1, 'beta', 2])
    expect(fp.calls[0].sql).not.toContain('alpha')
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('does not query for an empty insert batch', async () => {
    const fp = fakePgPool()

    const result = await adapterWithFakePool(fp).insert('orders', [])

    expect(result).toEqual({ data: [] })
    expect(fp.calls).toHaveLength(0)
  })

  it('update offsets WHERE placeholders after SET placeholders', async () => {
    const fp = fakePgPool([{ rows: [{ id: 7, status: 'closed' }], rowCount: 1, fields: [] }])

    await adapterWithFakePool(fp).update('orders', { status: 'closed', total: 20 }, { id: 7 })

    expect(normalizeSql(fp.calls[0].sql)).toBe(
      'UPDATE orders SET status = $1, total = $2 WHERE id = $3 RETURNING *'
    )
    expect(fp.calls[0].params).toEqual(['closed', 20, 7])
  })

  it('delete parameterizes its WHERE clause', async () => {
    const fp = fakePgPool()

    await adapterWithFakePool(fp).delete('orders', { id: 7 })

    expect(normalizeSql(fp.calls[0].sql)).toBe(
      'DELETE FROM orders WHERE id = $1 RETURNING *'
    )
    expect(fp.calls[0].params).toEqual([7])
  })
})

describe('PostgresAdapter - schema helpers', () => {
  it('tableExists uses a parameterized information_schema lookup', async () => {
    const fp = fakePgPool([{ rows: [{ exists: true }], rowCount: 1, fields: [] }])

    await expect(adapterWithFakePool(fp).tableExists('orders', 'erp')).resolves.toBe(true)

    expect(normalizeSql(fp.calls[0].sql)).toContain(
      'FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2'
    )
    expect(fp.calls[0].params).toEqual(['erp', 'orders'])
  })
})
