import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import {
  DEFAULT_ADAPTER_REGISTRY,
  DataSourceManager,
} from '../../src/data-adapters/DataSourceManager'
import {
  DATA_SOURCE_OFFSET_ORDERING_REQUIRED_CODE,
  DataSourceOffsetOrderingError,
} from '../../src/data-adapters/BaseAdapter'
import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { dataSourcesRouter } from '../../src/routes/data-sources'
import { usePinnedServer } from '../utils/pinned-server'
import type { DataSourceConfig, QueryOptions } from '../../src/data-adapters/BaseAdapter'

/**
 * OFFSET-ORDERING BOUNDARY CONFORMANCE (B2).
 *
 * SQL guarantees no row order without ORDER BY, so `LIMIT n OFFSET k` over an unordered relation
 * may return rows in a different order per call: successive pages silently overlap and skip. The
 * adapter chokepoint therefore fails closed on `offset > 0` without `orderBy` — with a TYPED,
 * closed contract error (`DATA_SOURCE_OFFSET_ORDERING_REQUIRED`) so the HTTP surface maps it to a
 * closed 422 instead of the catch-all `SELECT_ERROR` 500.
 *
 * The roster is derived from the PRODUCTION registry (same discipline as the landed A5 suite): a
 * newly registered SQL adapter is auto-covered, with no hand-maintained list to drift.
 */

function cfg(type: string): DataSourceConfig {
  return {
    id: 's', name: 's', type,
    connection: { host: 'h', port: 1, database: 'd', baseUrl: 'http://127.0.0.1:1' } as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  } as DataSourceConfig
}

function instantiate(type: string): { isSqlDialect(): boolean } {
  const AdapterClass = (DEFAULT_ADAPTER_REGISTRY as Record<string, new (c: DataSourceConfig) => { isSqlDialect(): boolean }>)[type]
  return new AdapterClass(cfg(type))
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

const ORDERED: QueryOptions['orderBy'] = [{ column: 'id', direction: 'asc' }]

// Derived from the registry, deduped by class (`postgres` aliases `postgresql`).
const SQL_TYPES = Object.keys(DEFAULT_ADAPTER_REGISTRY).filter(t => instantiate(t).isSqlDialect())
const SQL_TYPES_UNDER_TEST = [...new Map(SQL_TYPES.map(t => [instantiate(t).constructor, t])).values()]

describe('roster: every registered SQL adapter is exercised (registry-derived, no hand list)', () => {
  it('derivation is non-vacuous and covers each distinct SQL adapter class', () => {
    const exercised = new Set(SQL_TYPES_UNDER_TEST.map(t => instantiate(t).constructor))
    const registered = new Set(SQL_TYPES.map(t => instantiate(t).constructor))
    expect(exercised).toEqual(registered)
    expect(SQL_TYPES_UNDER_TEST.length).toBeGreaterThan(0)
  })
})

describe.each(SQL_TYPES_UNDER_TEST)('%s — offset-ordering boundary', type => {
  const make = () => instantiate(type)

  it('offset WITHOUT orderBy fails closed with the TYPED closed error', async () => {
    const adapter = make()
    capture(adapter)
    let caught: unknown = null
    try {
      await select(adapter, { limit: 10, offset: 10 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DataSourceOffsetOrderingError)
    expect((caught as DataSourceOffsetOrderingError).code).toBe(DATA_SOURCE_OFFSET_ORDERING_REQUIRED_CODE)
    expect((caught as Error).message).toMatch(/OFFSET pagination requires an explicit orderBy/)
  })

  it('offset WITH orderBy is allowed (positive control — not a blanket ban on offset)', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, { limit: 10, offset: 10, orderBy: ORDERED })
    expect(sql).toHaveLength(1)
    expect(sql[0]).toMatch(/ORDER BY/i)
  })

  it('a limit-only first page stays legal (no cross-page contract to violate)', async () => {
    const adapter = make()
    const sql = capture(adapter)
    await select(adapter, { limit: 10 })
    expect(sql).toHaveLength(1)
  })
})

describe('dialect artifacts and known limits', () => {
  // SQL Server REQUIRES an ORDER BY for OFFSET, so the old code fabricated `ORDER BY (SELECT NULL)`
  // — syntactically valid, semantically NO ordering guarantee: the "looks ordered, isn't" construct
  // that made paged reads corrupt silently. It must never come back.
  it('MSSQL never re-emits the non-deterministic `ORDER BY (SELECT NULL)` offset fallback', async () => {
    const adapter = new MSSQLAdapter(cfg('sqlserver'))
    const sql = capture(adapter)
    await select(adapter, { limit: 10, offset: 10, orderBy: ORDERED })
    expect(sql[0]).not.toMatch(/\(SELECT NULL\)/i)
    expect(sql[0]).toMatch(/ORDER BY .*OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY/i)
  })

  // Why this is data-integrity and not style: two legal-but-different physical orders for the same
  // unordered query leave the caller with a duplicate AND a missing row while believing the table
  // was fully read.
  it('demonstrates the corruption the policy prevents (one duplicate + one skipped row)', () => {
    const table = ['a', 'b', 'c', 'd']
    const scanA = ['a', 'b', 'c', 'd']
    const scanB = ['c', 'a', 'd', 'b']
    const pageSize = 2
    const collected = [...scanA.slice(0, pageSize), ...scanB.slice(pageSize, pageSize * 2)]

    expect(collected).toHaveLength(table.length) // caller believes the table was fully read…
    expect(collected.filter((r, i) => collected.indexOf(r) !== i)).toEqual(['b']) // …'b' twice
    expect(table.filter(r => !collected.includes(r))).toEqual(['c']) // …'c' never read
  })

  // KNOWN LIMIT, pinned deliberately: the guard triggers on `offset > 0`, so a caller that reads
  // page 1 with no offset/order and only supplies an order from page 2 still has an incoherent
  // sequence. The adapter cannot distinguish "standalone bounded preview" from "page 1 of a
  // sequence" — that intent closes in the caller's ordering contract, not by over-strictness here.
  it('KNOWN LIMIT: a limit-only first page is not covered by the adapter-level guard', async () => {
    const adapter = new PostgresAdapter(cfg('postgresql'))
    const sql = capture(adapter)
    await select(adapter, { limit: 10 }) // page 1 of a sequence, unordered — accepted here
    expect(sql[0]).not.toMatch(/ORDER BY/i)
    await expect(select(adapter, { limit: 10, offset: 10 }))
      .rejects.toThrow(/OFFSET pagination requires an explicit orderBy/)
  })
})

describe('/select route — the typed contract error maps to a CLOSED 422, never a 500', () => {
  let currentUser: { id: string; role?: string } | undefined
  const pinned = usePinnedServer()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { user?: unknown }).user = currentUser; next() })
  app.use(dataSourcesRouter())
  const admin = (id: string) => ({ id, role: 'admin' })
  const body = (id: string) => ({
    id, name: id, type: 'sqlserver',
    connection: { host: 'db', port: 1433, database: 'ERP' },
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  })

  beforeEach(() => {
    currentUser = admin('alice')
    vi.restoreAllMocks()
    pinned.setApp(app)
  })

  it('an offset-ordering violation returns 422 with the closed code (not SELECT_ERROR 500)', async () => {
    vi.spyOn(DataSourceManager.prototype, 'select').mockRejectedValue(
      new DataSourceOffsetOrderingError('OFFSET pagination requires an explicit orderBy: …')
    )
    await request(pinned.url()).post('/api/data-sources').send(body('ord-422'))
    const res = await request(pinned.url())
      .post('/api/data-sources/ord-422/select')
      .send({ table: 't', limit: 10, offset: 10 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe(DATA_SOURCE_OFFSET_ORDERING_REQUIRED_CODE)
  })

  it('a generic failure still maps to SELECT_ERROR 500 (the 422 mapping is closed, not widened)', async () => {
    vi.spyOn(DataSourceManager.prototype, 'select').mockRejectedValue(new Error('boom'))
    await request(pinned.url()).post('/api/data-sources').send(body('ord-500'))
    const res = await request(pinned.url())
      .post('/api/data-sources/ord-500/select')
      .send({ table: 't', limit: 10 })
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('SELECT_ERROR')
  })

  it('a successful select still returns 200 (positive control)', async () => {
    vi.spyOn(DataSourceManager.prototype, 'select').mockResolvedValue({ data: [] })
    await request(pinned.url()).post('/api/data-sources').send(body('ord-200'))
    const res = await request(pinned.url())
      .post('/api/data-sources/ord-200/select')
      .send({ table: 't', limit: 10, offset: 10, orderBy: [{ column: 'id', direction: 'asc' }] })
    expect(res.status).toBe(200)
  })
})
