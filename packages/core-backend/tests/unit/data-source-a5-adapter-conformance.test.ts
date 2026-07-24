import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { MySQLAdapter } from '../../src/data-adapters/MySQLAdapter'
import { HTTPAdapter } from '../../src/data-adapters/HTTPAdapter'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { SUPPORTED_DATA_SOURCE_TYPES } from '../../src/data-adapters/DataSourceManager'
import { DATA_SOURCE_MAX_ROWS } from '../../src/data-adapters/BaseAdapter'
import type { DataSourceConfig, QueryOptions } from '../../src/data-adapters/BaseAdapter'

/**
 * A5 RESULT-BOUNDARY CONFORMANCE, ACROSS EVERY SQL ADAPTER.
 *
 * BaseAdapter's A5 contract states the row bound is "enforced at the ADAPTER layer — the chokepoint
 * every structured read passes through, INCLUDING direct internal callers that bypass the route —
 * so 'omit limit' can never mean 'whole table'".
 *
 * That sentence was FALSE for MySQLAdapter, which had zero `resolveEffectiveLimit` calls: an
 * omitted limit produced `SELECT * FROM t` over the whole table and an over-max limit was served
 * verbatim. `DataSourceManager.select` passes options straight through, so nothing upstream
 * compensated.
 *
 * It survived because `data-source-result-boundary.test.ts` imports only Postgres and MSSQL — the
 * policy was verified per-adapter, ad hoc, so an adapter could silently lack it. This suite is
 * therefore parameterised over the SQL adapters and, crucially, PINS THAT ROSTER against the
 * production registry so it cannot drift into a stale hand-maintained list (see the roster test).
 */

function cfg(type: string): DataSourceConfig {
  return {
    id: 's', name: 's', type,
    connection: { host: 'h', port: 1, database: 'd', baseUrl: 'http://127.0.0.1:1' } as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  } as DataSourceConfig
}

function capture(adapter: unknown): string[] {
  const sql: string[] = []
  ;(adapter as { query(s: string): Promise<unknown> }).query = async (s: string) => {
    sql.push(s)
    return { data: [], rowCount: 0 }
  }
  return sql
}

function select(adapter: unknown, options: QueryOptions): Promise<unknown> {
  return (adapter as { select(t: string, o: QueryOptions): Promise<unknown> }).select('t', options)
}

// EVERY registered data-source type, mapped to its adapter constructor. The key set is asserted
// against the production registry below, so registering a new type without classifying it here is
// a test failure rather than a silent gap.
const TYPE_TO_ADAPTER: Record<string, (t: string) => { isSqlDialect(): boolean }> = {
  postgresql: t => new PostgresAdapter(cfg(t)),
  postgres: t => new PostgresAdapter(cfg(t)),
  sqlserver: t => new MSSQLAdapter(cfg(t)),
  mysql: t => new MySQLAdapter(cfg(t)),
  http: t => new HTTPAdapter(cfg(t)),
  plm: t => new PLMAdapter(cfg(t)),
}

// The SQL adapters actually exercised below, keyed by the production type string.
const SQL_TYPES_UNDER_TEST = ['sqlserver', 'postgresql', 'mysql'] as const

describe('A5 roster pin — "every SQL adapter" is a checked claim, not a hand-maintained list', () => {
  it('every registered data-source type is classified here', () => {
    expect(Object.keys(TYPE_TO_ADAPTER).sort()).toEqual([...SUPPORTED_DATA_SOURCE_TYPES].sort())
  })

  it('the SQL adapters under test are EXACTLY the registered types reporting isSqlDialect()', () => {
    const sqlTypes = [...SUPPORTED_DATA_SOURCE_TYPES].filter(t => TYPE_TO_ADAPTER[t](t).isSqlDialect())
    // `postgres` is an alias of `postgresql` and maps to the same class, so it is covered by the
    // `postgresql` entry; dedupe by adapter class, not by type string.
    const coveredClasses = new Set(SQL_TYPES_UNDER_TEST.map(t => TYPE_TO_ADAPTER[t](t).constructor))
    const registeredSqlClasses = new Set(sqlTypes.map(t => TYPE_TO_ADAPTER[t](t).constructor))
    expect(coveredClasses).toEqual(registeredSqlClasses)
  })
})

describe.each(SQL_TYPES_UNDER_TEST)('%s — A5 result boundary', type => {
  const make = () => TYPE_TO_ADAPTER[type](type)

  it('an omitted limit is bounded at the adapter (never an unbounded whole-table read)', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, {})
    expect(sql).toHaveLength(1)
    expect(sql[0]).toMatch(new RegExp(String(DATA_SOURCE_MAX_ROWS)))
  })

  it('an over-max limit is REFUSED, not silently clamped (paginate instead)', async () => {
    const adapter = make()
    capture(adapter)
    await expect(select(adapter, { limit: DATA_SOURCE_MAX_ROWS + 1 })).rejects.toThrow(/exceeds the maximum/)
  })

  it('a valid limit is applied verbatim', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, { limit: 25 })
    expect(sql[0]).toMatch(/\b25\b/)
  })
})
