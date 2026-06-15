import { describe, expect, it } from 'vitest'

import { MySQLAdapter } from '../../src/data-adapters/MySQLAdapter'
import type { DataSourceConfig, QueryResult } from '../../src/data-adapters/BaseAdapter'

const cfg: DataSourceConfig = {
  id: 'mysql_schema_test',
  name: 'mysql_schema_test',
  type: 'mysql',
  connection: { database: 'stockorder' },
  options: { autoConnect: false },
}

class FakeMySQLAdapter extends MySQLAdapter {
  queries: Array<{ sql: string; params?: unknown[] }> = []

  override async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.queries.push({ sql, params })
    return {
      data: [
        {
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
          column_default: null,
          max_length: null,
          numeric_precision: 10,
          numeric_scale: 0,
          column_comment: 'primary key',
          extra_info: 'auto_increment',
        },
        {
          column_name: 'amount',
          data_type: 'decimal',
          is_nullable: 'YES',
          column_default: null,
          max_length: null,
          numeric_precision: 12,
          numeric_scale: 2,
          column_comment: 'order amount',
          extra_info: '',
        },
        {
          column_name: 'sku',
          data_type: 'varchar',
          is_nullable: 'NO',
          column_default: '',
          max_length: 64,
          numeric_precision: null,
          numeric_scale: null,
          column_comment: '',
          extra_info: '',
        },
      ] as T[],
    }
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

describe('MySQLAdapter schema metadata', () => {
  it('uses non-reserved metadata aliases and maps returned column fields', async () => {
    const adapter = new FakeMySQLAdapter(cfg)
    const columns = await adapter.getColumns('stock_info', 'stockorder')

    expect(adapter.queries).toHaveLength(1)
    expect(adapter.queries[0].sql).toContain('NUMERIC_PRECISION as numeric_precision')
    expect(adapter.queries[0].sql).toContain('NUMERIC_SCALE as numeric_scale')
    expect(adapter.queries[0].sql).toContain('COLUMN_COMMENT as column_comment')
    expect(adapter.queries[0].sql).not.toMatch(/\bas precision\b/i)
    expect(adapter.queries[0].params).toEqual(['stockorder', 'stock_info'])
    expect(columns).toEqual([
      {
        name: 'id',
        type: 'int',
        nullable: false,
        defaultValue: null,
        autoIncrement: true,
        comment: 'primary key',
      },
      {
        name: 'amount',
        type: 'decimal(12,2)',
        nullable: true,
        defaultValue: null,
        autoIncrement: false,
        comment: 'order amount',
      },
      {
        name: 'sku',
        type: 'varchar(64)',
        nullable: false,
        defaultValue: '',
        autoIncrement: false,
        comment: undefined,
      },
    ])
  })
})

describe('MySQLAdapter structured read SQL', () => {
  it('selects with structured OR groups for C3 composite keyset predicates', async () => {
    const adapter = new FakeMySQLAdapter(cfg)

    await adapter.select('stock_info', {
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

    expect(normalizeSql(adapter.queries[0].sql)).toBe(
      'SELECT * FROM `stock_info` WHERE `status` = ? AND ((`updated_at` > ?) OR (`updated_at` = ? AND `id` > ?)) ORDER BY `updated_at` ASC, `id` ASC LIMIT 100'
    )
    expect(adapter.queries[0].params).toEqual([
      'open',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      42,
    ])
    expect(adapter.queries[0].sql).not.toContain('2026-06-01')
  })

  it('rejects malformed structured groups before the query is issued', async () => {
    const adapter = new FakeMySQLAdapter(cfg)

    await expect(adapter.select('stock_info', {
      where: { $or: [] },
      limit: 1,
    })).rejects.toThrow(/\$or must be a non-empty array/)

    expect(adapter.queries).toHaveLength(0)
  })

  it('rejects unsupported operators before the query is issued', async () => {
    const adapter = new FakeMySQLAdapter(cfg)

    await expect(adapter.select('stock_info', {
      where: { updated_at: { $after: '2026-06-01T00:00:00.000Z' } as never },
      limit: 1,
    })).rejects.toThrow(/Unsupported where operator/)

    expect(adapter.queries).toHaveLength(0)
  })

  it('does not turn an empty update/delete where into a full-table write', async () => {
    const adapter = new FakeMySQLAdapter(cfg)

    await expect(adapter.update('stock_info', { status: 'closed' }, {}))
      .rejects.toThrow(/requires a non-empty where clause/)
    await expect(adapter.delete('stock_info', {}))
      .rejects.toThrow(/requires a non-empty where clause/)

    expect(adapter.queries).toHaveLength(0)
  })
})
