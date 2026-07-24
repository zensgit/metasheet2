import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { MySQLAdapter } from '../../src/data-adapters/MySQLAdapter'
import { DATA_SOURCE_MAX_ROWS } from '../../src/data-adapters/BaseAdapter'
import type { DataSourceConfig, QueryOptions } from '../../src/data-adapters/BaseAdapter'

/**
 * ADAPTER BOUNDARY-POLICY CONFORMANCE.
 *
 * The adapter layer is the chokepoint every structured read passes through — INCLUDING direct
 * internal callers that bypass the route — so the read-boundary policies must hold for EVERY SQL
 * adapter, not for whichever ones a given test happened to import.
 *
 * That gap was not hypothetical: `data-source-result-boundary.test.ts` imports only Postgres and
 * MSSQL, and MySQLAdapter consequently shipped with NO A5 bound at all — an omitted limit produced
 * `SELECT * FROM t` over the whole table, and an over-max limit was served verbatim. Separately,
 * all three adapters accepted OFFSET pagination with no ORDER BY, which silently duplicates and
 * skips rows across pages.
 *
 * So this suite is parameterised over EVERY SQL adapter × EVERY boundary policy. A new adapter
 * (or a new policy) is meant to be added here, so "this adapter quietly lacks that policy" cannot
 * recur as a silent gap.
 */

function cfg(type: string): DataSourceConfig {
  return {
    id: 's', name: 's', type,
    connection: { host: 'h', port: 1, database: 'd' } as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  } as DataSourceConfig
}

// Capture generated SQL without a real driver by stubbing the adapter's own query() sink.
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

const ORDERED: QueryOptions['orderBy'] = [{ column: 'id', direction: 'asc' }]

const SQL_ADAPTERS = [
  { name: 'MSSQL', make: () => new MSSQLAdapter(cfg('sqlserver')) },
  { name: 'Postgres', make: () => new PostgresAdapter(cfg('postgresql')) },
  { name: 'MySQL', make: () => new MySQLAdapter(cfg('mysql')) },
] as const

describe.each(SQL_ADAPTERS)('$name — adapter boundary policies', ({ make }) => {
  // ── A5: result boundary ────────────────────────────────────────────────────────────────────
  // "omit limit can never mean whole table" — the contract in BaseAdapter. Enforced HERE, at the
  // adapter, precisely so an internal caller that bypasses the route still cannot read unbounded.

  it('A5: an omitted limit is bounded at the adapter (never an unbounded whole-table read)', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, {})
    expect(sql).toHaveLength(1)
    // The emitted statement must carry the cap — as a row-count bound in whichever dialect form.
    expect(sql[0]).toMatch(new RegExp(String(DATA_SOURCE_MAX_ROWS)))
  })

  it('A5: an over-max limit is REFUSED, not silently clamped (paginate instead)', async () => {
    const adapter = make()
    capture(adapter)
    await expect(select(adapter, { limit: DATA_SOURCE_MAX_ROWS + 1 })).rejects.toThrow(/exceeds the maximum/)
  })

  it('A5: a valid limit is applied verbatim', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, { limit: 25 })
    expect(sql[0]).toMatch(/\b25\b/)
  })

  // ── Ordering boundary: the other half of a paginated read ──────────────────────────────────
  // An OFFSET is only meaningful against a deterministic total order. Without ORDER BY the engine
  // may return rows in a different order per call, so successive pages overlap and leave holes.

  it('ordering: offset WITHOUT orderBy fails closed', async () => {
    const adapter = make()
    capture(adapter)
    await expect(select(adapter, { limit: 10, offset: 10 }))
      .rejects.toThrow(/OFFSET pagination requires an explicit orderBy/)
  })

  it('ordering: offset WITH orderBy is allowed (positive control — not a blanket ban on offset)', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, { limit: 10, offset: 10, orderBy: ORDERED })
    expect(sql[0]).toMatch(/ORDER BY/i)
  })

  it('ordering: a limit-only first page stays legal (no cross-page contract to violate)', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, { limit: 10 })
    expect(sql).toHaveLength(1)
  })
})

describe('boundary policies — dialect-specific artifacts and known limits', () => {
  // SQL Server REQUIRES an ORDER BY for OFFSET, so the old code fabricated `ORDER BY (SELECT NULL)`
  // — syntactically valid, semantically NO ordering guarantee. That token is the "looks ordered,
  // isn't" construct that made paged reads corrupt silently; it must never come back.
  it('MSSQL never re-emits the non-deterministic `ORDER BY (SELECT NULL)` offset fallback', async () => {
    const adapter = new MSSQLAdapter(cfg('sqlserver'))
    const sql = capture(adapter)
    await select(adapter, { limit: 10, offset: 10, orderBy: ORDERED })
    expect(sql[0]).not.toMatch(/\(SELECT NULL\)/i)
    expect(sql[0]).toMatch(/ORDER BY .*OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY/i)
  })

  // Why the ordering policy is data-integrity rather than style: this models the engine returning
  // two different (both legal) physical orders for the same unordered query, and shows the caller
  // ending up with a duplicate AND a missing row while believing it read the whole table.
  it('demonstrates the corruption the ordering policy prevents (one duplicate + one skipped row)', () => {
    const table = ['a', 'b', 'c', 'd']
    const scanA = ['a', 'b', 'c', 'd']
    const scanB = ['c', 'a', 'd', 'b']
    const pageSize = 2
    const collected = [...scanA.slice(0, pageSize), ...scanB.slice(pageSize, pageSize * 2)]

    expect(collected).toHaveLength(table.length) // caller believes the table was fully read…
    expect(collected.filter((r, i) => collected.indexOf(r) !== i)).toEqual(['b']) // …'b' twice
    expect(table.filter(r => !collected.includes(r))).toEqual(['c']) // …'c' never read
  })

  // KNOWN LIMIT, pinned deliberately rather than left implicit. The guard triggers on `offset > 0`,
  // so a caller that reads page 1 with no offset/order and only supplies an order from page 2 still
  // has an incoherent sequence. The adapter cannot distinguish "standalone bounded preview" from
  // "page 1 of a sequence" — that intent is only known to the paginating caller, so the residual
  // hole must be closed by the caller's ordering contract, not by over-strictness here (rejecting
  // `offset: 0` would refuse reads that emit no OFFSET clause at all).
  it('KNOWN LIMIT: a limit-only first page is not covered by the adapter-level ordering guard', async () => {
    const adapter = new PostgresAdapter(cfg('postgresql'))
    const sql = capture(adapter)
    await select(adapter, { limit: 10 }) // page 1 of a sequence, unordered — accepted here
    expect(sql[0]).not.toMatch(/ORDER BY/i)
    // …and page 2 of that same sequence IS refused, which is where the caller's intent becomes visible.
    await expect(select(adapter, { limit: 10, offset: 10 }))
      .rejects.toThrow(/OFFSET pagination requires an explicit orderBy/)
  })
})
