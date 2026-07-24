import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { MySQLAdapter } from '../../src/data-adapters/MySQLAdapter'
import type { DataSourceConfig, QueryOptions } from '../../src/data-adapters/BaseAdapter'

// Ordering-boundary policy (A5 sibling): an OFFSET page without a deterministic ORDER BY is not a
// stable page sequence — successive pages can silently DUPLICATE and SKIP rows. These tests pin the
// fail-closed guard at the adapter chokepoint, for all three SQL adapters.

function cfg(type: DataSourceConfig['type']): DataSourceConfig {
  return {
    id: 's', name: 's', type,
    connection: { host: 'h', port: 1, database: 'd' } as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  }
}

// Capture generated SQL without a real driver: stub the adapter's own query() sink.
function capturing<T extends { query: unknown }>(adapter: T): { adapter: T; sql: string[] } {
  const sql: string[] = []
  ;(adapter as unknown as { query(s: string): Promise<unknown> }).query = async (s: string) => {
    sql.push(s)
    return { data: [], rowCount: 0 }
  }
  return { adapter, sql }
}

const ORDERED: QueryOptions['orderBy'] = [{ column: 'id', direction: 'asc' }]

describe('offset pagination requires a deterministic order (all SQL adapters)', () => {
  const cases = [
    { name: 'MSSQL', make: () => new MSSQLAdapter(cfg('sqlserver')) },
    { name: 'Postgres', make: () => new PostgresAdapter(cfg('postgresql')) },
    { name: 'MySQL', make: () => new MySQLAdapter(cfg('mysql')) },
  ] as const

  for (const { name, make } of cases) {
    it(`${name}: offset WITHOUT orderBy fails closed`, async () => {
      const { adapter } = capturing(make() as unknown as { query: unknown })
      await expect(
        (adapter as unknown as { select(t: string, o: QueryOptions): Promise<unknown> })
          .select('t', { limit: 10, offset: 10 })
      ).rejects.toThrow(/OFFSET pagination requires an explicit orderBy/)
    })

    it(`${name}: offset WITH orderBy is allowed (positive control — the guard is not a blanket ban)`, async () => {
      const { adapter, sql } = capturing(make() as unknown as { query: unknown })
      await (adapter as unknown as { select(t: string, o: QueryOptions): Promise<unknown> })
        .select('t', { limit: 10, offset: 10, orderBy: ORDERED })
      expect(sql).toHaveLength(1)
      expect(sql[0]).toMatch(/ORDER BY/i)
    })

    it(`${name}: a limit-only first page stays legal (no cross-page contract to violate)`, async () => {
      const { adapter, sql } = capturing(make() as unknown as { query: unknown })
      await (adapter as unknown as { select(t: string, o: QueryOptions): Promise<unknown> })
        .select('t', { limit: 10 })
      expect(sql).toHaveLength(1)
    })
  }

  // The DEFECT this guard closes, stated as the artifact it used to emit. SQL Server REQUIRES an
  // ORDER BY for OFFSET, so the old code fabricated `ORDER BY (SELECT NULL)` — syntactically valid,
  // semantically NO ordering guarantee. That token must never appear again: it is precisely the
  // "looks ordered, isn't" construct that made paged reads duplicate and skip rows silently.
  it('MSSQL never emits the non-deterministic `ORDER BY (SELECT NULL)` offset fallback', async () => {
    const { adapter, sql } = capturing(new MSSQLAdapter(cfg('sqlserver')) as unknown as { query: unknown })
    await (adapter as unknown as { select(t: string, o: QueryOptions): Promise<unknown> })
      .select('t', { limit: 10, offset: 10, orderBy: ORDERED })
    expect(sql[0]).not.toMatch(/\(SELECT NULL\)/i)
    expect(sql[0]).toMatch(/ORDER BY .*OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY/i)
  })

  // Why the guard is data-integrity and not style: an unordered relation may hand back rows in a
  // DIFFERENT order per call, so offset windows over it overlap and leave holes. This models that
  // permitted-by-SQL behaviour and shows the corruption the guard now makes unreachable.
  it('demonstrates the corruption: unordered offset paging both duplicates and skips rows', () => {
    const table = ['a', 'b', 'c', 'd']
    // Two legal-but-different physical orders the engine may return for the same unordered query.
    const scan1 = ['a', 'b', 'c', 'd']
    const scan2 = ['c', 'a', 'd', 'b']
    const pageSize = 2
    // Page 1 read against scan1, page 2 against scan2 — no ORDER BY means nothing forbids this.
    const page1 = scan1.slice(0, pageSize)
    const page2 = scan2.slice(pageSize, pageSize * 2)
    const collected = [...page1, ...page2]

    const duplicates = collected.filter((row, i) => collected.indexOf(row) !== i)
    const missing = table.filter(row => !collected.includes(row))

    expect(collected).toHaveLength(table.length) // the caller believes it read the whole table…
    expect(duplicates).toEqual(['b']) // …but 'b' arrived twice
    expect(missing).toEqual(['c']) // …and 'c' was never read
  })
})
