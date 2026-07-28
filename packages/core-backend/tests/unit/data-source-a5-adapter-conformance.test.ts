import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { DEFAULT_ADAPTER_REGISTRY, SUPPORTED_DATA_SOURCE_TYPES } from '../../src/data-adapters/DataSourceManager'
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

// Instantiate straight from the PRODUCTION registry — the same object DataSourceManager registers
// from and derives SUPPORTED_DATA_SOURCE_TYPES from. The test therefore has NO adapter list of its
// own to drift: a newly registered adapter appears here automatically.
function instantiate(type: string): { isSqlDialect(): boolean } {
  const AdapterClass = (DEFAULT_ADAPTER_REGISTRY as Record<string, new (c: DataSourceConfig) => { isSqlDialect(): boolean }>)[type]
  return new AdapterClass(cfg(type))
}

// The SQL types are DERIVED by asking each registered adapter, not hand-listed.
const SQL_TYPES = Object.keys(DEFAULT_ADAPTER_REGISTRY).filter(t => instantiate(t).isSqlDialect())

// `postgres` aliases `postgresql` onto the same class; exercise one type per distinct class.
const SQL_TYPES_UNDER_TEST = [
  ...new Map(SQL_TYPES.map(t => [instantiate(t).constructor, t])).values(),
]

describe('A5 roster pin — bound to the production registry, not to a hand-maintained list', () => {
  it('the public supported-type list is DERIVED from the adapter registry (single source)', () => {
    // If these ever diverge, a type is registered-but-unsupported or supported-but-unregistered.
    expect([...SUPPORTED_DATA_SOURCE_TYPES].sort()).toEqual(Object.keys(DEFAULT_ADAPTER_REGISTRY).sort())
  })

  it('every registered SQL adapter is exercised below (one per distinct class)', () => {
    const exercised = new Set(SQL_TYPES_UNDER_TEST.map(t => instantiate(t).constructor))
    const registered = new Set(SQL_TYPES.map(t => instantiate(t).constructor))
    expect(exercised).toEqual(registered)
    expect(SQL_TYPES_UNDER_TEST.length).toBeGreaterThan(0) // the derivation must not be vacuous
  })

  // NEGATIVE CONTROLS — the single source is only single if it cannot be mutated at runtime.
  // `as const` is compile-time only; another module could otherwise assign/delete/push an entry and
  // re-desync registration from the derived supported-type set. Both must be FROZEN.
  it('the registry is frozen — assignment, replacement, and deletion are all rejected at runtime', () => {
    const reg = DEFAULT_ADAPTER_REGISTRY as unknown as Record<string, unknown>
    expect(Object.isFrozen(DEFAULT_ADAPTER_REGISTRY)).toBe(true)
    expect(() => { 'use strict'; reg.oracle = MysqlLikeStub }).toThrow() // add a new type
    expect(() => { 'use strict'; reg.mysql = MysqlLikeStub }).toThrow() // replace an existing adapter
    expect(() => { 'use strict'; delete reg.plm }).toThrow() // remove a type
    // …and none of the attempts left a mark.
    expect(Object.keys(DEFAULT_ADAPTER_REGISTRY).sort()).toEqual(['http', 'mysql', 'plm', 'postgres', 'postgresql', 'sqlserver'])
  })

  it('the derived supported-type list is frozen — push/splice cannot inject an unregistered type', () => {
    const list = SUPPORTED_DATA_SOURCE_TYPES as unknown as string[]
    expect(Object.isFrozen(SUPPORTED_DATA_SOURCE_TYPES)).toBe(true)
    expect(() => { 'use strict'; list.push('oracle') }).toThrow()
    expect(() => { 'use strict'; list.splice(0, 1) }).toThrow()
    // still exactly the registry's keys.
    expect([...SUPPORTED_DATA_SOURCE_TYPES].sort()).toEqual(Object.keys(DEFAULT_ADAPTER_REGISTRY).sort())
  })
})

// A stand-in adapter class for the mutation-attempt negative controls (never registered).
class MysqlLikeStub {
  isSqlDialect(): boolean { return true }
}

describe.each(SQL_TYPES_UNDER_TEST)('%s — A5 result boundary', type => {
  const make = () => instantiate(type)

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
