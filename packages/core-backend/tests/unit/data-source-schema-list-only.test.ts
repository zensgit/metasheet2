/**
 * 2026-09-10 222 PLM 504 — 「库表结构」listing is LIST-ONLY by default.
 *
 * Evidence this exists (222 nginx error.log, 2026-09-10): a tester clicked 「结构」 on the customer
 * PLM (SQL Server) and `GET /api/data-sources/plm/schema` answered nginx 504 FOUR times in a row —
 * `upstream timed out (10060) while reading response header from upstream`. Root cause was not the
 * network: `getSchema()` looped `getTableInfo()` over EVERY table, and getTableInfo itself runs
 * columns + pk + index + fk serially, i.e. 4N+2 round trips on a several-hundred-table database.
 *
 * The listing the UI needs is names only (the panel is "pick a table → read its fields"), so the
 * default is now one pair of INFORMATION_SCHEMA queries. What the tests below pin:
 *   (A) default = list only: NO per-table query is issued, and the empty `columns` is labelled
 *       `columnsLoaded: false` / `detail: 'list'` so it can never be read as "no columns".
 *   (B) `includeColumns: true` still does the full fan-out (the callers that read columns off the
 *       listing must ASK for it) — and is bounded by a wall-clock budget that refuses with a coded
 *       504 BEFORE the proxy times out.
 *   (C) the route defaults to lazy and only widens on an explicit `?includeColumns=1`/`?detail=full`.
 *   (D) the plugin facade — whose consumer maps listing columns into its object schema — passes
 *       `includeColumns: true`, so no caller silently receives empty columns.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { MSSQLAdapter } from '../../src/data-adapters/MSSQLAdapter'
import { MongoDBAdapter } from '../../src/data-adapters/MongoDBAdapter'
import { MySQLAdapter } from '../../src/data-adapters/MySQLAdapter'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import {
  createDataSourcePluginFacade,
  createDataSourceWritePluginFacade,
} from '../../src/data-adapters/data-source-plugin-facade'
import type { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import {
  DEFAULT_SCHEMA_DETAIL_BUDGET_MS,
  SCHEMA_DETAIL_BUDGET_DISABLED,
  SCHEMA_DETAIL_BUDGET_ENV,
  SCHEMA_DETAIL_TIMEOUT_CODE,
  resolveSchemaDetailBudgetMs,
  schemaDetailTimeoutError,
} from '../../src/data-adapters/schema-detail-budget'
import { dataSourcesRouter, getDataSourceManager, wantsSchemaColumns } from '../../src/routes/data-sources'
import type { DataSourceConfig, DbValue, QueryResult } from '../../src/data-adapters/BaseAdapter'
import { usePinnedServer } from '../utils/pinned-server'

const TABLE_ROWS = [
  { table_name: 'Bom_ExAttr1', table_schema: 'dbo' },
  { table_name: 'Bom_Master', table_schema: 'dbo' },
  { table_name: 'Item_Master', table_schema: 'dbo' },
]
const VIEW_ROWS = [{ view_name: 'v_Bom', view_schema: 'dbo', view_definition: 'SELECT 1' }]
const COLUMN_ROWS = [
  {
    column_name: 'FItemID', data_type: 'int', is_nullable: 'NO', column_default: null,
    character_maximum_length: null, numeric_precision: 10, numeric_scale: 0,
  },
]

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * SQL-routing fake mssql pool: answers the listing queries and the per-table detail queries
 * differently so a test can tell WHICH round trips were actually made. `delayMs` makes the budget
 * observable without a fake clock.
 */
function routingMssqlPool(delayMs = 0) {
  const calls: string[] = []
  const pool = {
    request() {
      const req = {
        input() { return req },
        async query(sql: string) {
          calls.push(sql)
          if (delayMs > 0) await sleep(delayMs)
          if (sql.includes('INFORMATION_SCHEMA.VIEWS')) return { recordset: VIEW_ROWS, rowsAffected: [] }
          if (sql.includes('INFORMATION_SCHEMA.TABLES')) return { recordset: TABLE_ROWS, rowsAffected: [] }
          if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return { recordset: COLUMN_ROWS, rowsAffected: [] }
          return { recordset: [], rowsAffected: [] }
        },
      }
      return req
    },
    async close() {},
  }
  return { pool, calls }
}

function mssqlAdapter(fp: ReturnType<typeof routingMssqlPool>): MSSQLAdapter {
  const adapter = new MSSQLAdapter({
    id: 's', name: 's', type: 'sqlserver',
    connection: { host: 'db', port: 1433, database: 'PLM' } as DataSourceConfig['connection'],
    credentials: { username: 'u', password: 'p' },
    options: { autoConnect: false },
  })
  const internal = adapter as unknown as { pool: unknown; connected: boolean }
  internal.pool = fp.pool
  internal.connected = true
  return adapter
}

/**
 * Fake Mongo db: every per-collection read (getColumns' 100-document sample, getIndexes) is
 * recorded, so a test can prove the default listing issues NONE of them — and that the
 * includeColumns path walks the collections SEQUENTIALLY (the budget needs a checkpoint between
 * collections; a Promise.all fan-out would have none).
 */
function fakeMongoAdapter(collections: string[]) {
  const calls: string[] = []
  const db = {
    listCollections() {
      calls.push('listCollections')
      return { async toArray() { return collections.map(name => ({ name })) } }
    },
    collection(name: string) {
      const cursor = {
        limit() { return cursor },
        async toArray() { calls.push(`sample:${name}`); return [{ _id: 1, code: 'A' }] },
      }
      return {
        find() { return cursor },
        async indexes() { calls.push(`indexes:${name}`); return [{ name: '_id_', key: { _id: 1 }, unique: true }] },
      }
    },
  }
  const adapter = new MongoDBAdapter({
    id: 'mongo', name: 'mongo', type: 'mongodb',
    connection: { database: 'plm' } as DataSourceConfig['connection'],
    options: { autoConnect: false },
  })
  const internal = adapter as unknown as { client: unknown; db: unknown; connected: boolean }
  internal.db = db
  internal.client = { db: () => db }
  internal.connected = true
  return { adapter, calls }
}

const perTableQueries = (calls: string[]) =>
  calls.filter(sql =>
    sql.includes('INFORMATION_SCHEMA.COLUMNS') ||
    sql.includes('TABLE_CONSTRAINTS') ||
    sql.includes('sys.indexes') ||
    sql.includes('sys.foreign_keys'))

describe('(A) getSchema default — list only, no per-table fan-out (2026-09-10 222 PLM 504)', () => {
  it('MSSQL: exactly TWO listing queries and ZERO per-table queries, whatever the table count', async () => {
    const fp = routingMssqlPool()
    const schema = await mssqlAdapter(fp).getSchema('dbo')

    // The whole point: 2 round trips, not 4N+2. This is the assertion that goes red if the
    // list-only branch is removed.
    expect(fp.calls).toHaveLength(2)
    expect(perTableQueries(fp.calls)).toEqual([])
    expect(schema.detail).toBe('list')
    expect(schema.tables.map(t => t.name)).toEqual(['Bom_ExAttr1', 'Bom_Master', 'Item_Master'])
    expect(schema.tables.every(t => t.schema === 'dbo')).toBe(true)
  })

  it('MSSQL: an empty `columns` is LABELLED unloaded — it never reads as "this table has no fields"', async () => {
    const schema = await mssqlAdapter(routingMssqlPool()).getSchema('dbo')
    for (const table of schema.tables) {
      expect(table.columns).toEqual([])
      expect(table.columnsLoaded).toBe(false)
    }
    expect(schema.views?.every(v => v.columnsLoaded === false)).toBe(true)
  })

  it('MSSQL: includeColumns:true still returns the full 4N+2 shape (compat path unchanged)', async () => {
    const fp = routingMssqlPool()
    const schema = await mssqlAdapter(fp).getSchema('dbo', { includeColumns: true })

    expect(perTableQueries(fp.calls).length).toBe(TABLE_ROWS.length * 4)
    expect(fp.calls).toHaveLength(2 + TABLE_ROWS.length * 4)
    expect(schema.detail).toBe('full')
    expect(schema.tables[0].columns.map(c => c.name)).toEqual(['FItemID'])
    // `columnsLoaded` is left unset on the full path — absent means "legacy/loaded", and every
    // pre-existing consumer keeps reading `columns` exactly as before.
    expect(schema.tables[0].columnsLoaded).toBeUndefined()
  })

  it('Mongo: default samples ZERO documents — listCollections only (its per-item cost is 100 docs)', async () => {
    const { adapter, calls } = fakeMongoAdapter(['bom', 'item'])

    const schema = await adapter.getSchema()

    // getColumns() samples up to 100 documents PER collection and getIndexes() is another round
    // trip; the default listing must issue neither.
    expect(calls).toEqual(['listCollections'])
    expect(schema.detail).toBe('list')
    expect(schema.tables).toEqual([
      { name: 'bom', columns: [], columnsLoaded: false, primaryKey: ['_id'] },
      { name: 'item', columns: [], columnsLoaded: false, primaryKey: ['_id'] },
    ])
  })

  it('Mongo: includeColumns:true samples every collection, SEQUENTIALLY (so the budget has a checkpoint)', async () => {
    const { adapter, calls } = fakeMongoAdapter(['bom', 'item'])

    const schema = await adapter.getSchema(undefined, { includeColumns: true })

    // Interleaved (sample→indexes→sample→indexes), not batched: proves the per-collection work is
    // serial, which is what lets assertWithinBudget() refuse between collections.
    expect(calls).toEqual(['listCollections', 'sample:bom', 'indexes:bom', 'sample:item', 'indexes:item'])
    expect(schema.detail).toBe('full')
    expect(schema.tables.map(t => t.name)).toEqual(['bom', 'item'])
    expect(schema.tables[0].columns.map(c => c.name)).toContain('code')
    expect(schema.tables[0].columnsLoaded).toBeUndefined()
  })

  it('Postgres: same split — default issues only the tables+views listing', async () => {
    const calls: string[] = []
    const adapter = new PostgresAdapter({
      id: 'pg', name: 'pg', type: 'postgres',
      connection: { host: 'db', database: 'ERP' }, credentials: { username: 'u', password: 'p' },
      options: { autoConnect: false },
    })
    const internal = adapter as unknown as { pool: unknown; connected: boolean }
    internal.pool = {
      async query(sql: string) {
        calls.push(sql)
        if (/information_schema\.views/i.test(sql)) {
          return { rows: [{ view_name: 'v_bom', view_schema: 'public', view_definition: 'SELECT 1' }], rowCount: 1, fields: [] }
        }
        if (/information_schema\.tables/i.test(sql)) {
          return { rows: [{ table_name: 'items', table_schema: 'public' }], rowCount: 1, fields: [] }
        }
        return { rows: [], rowCount: 0, fields: [] }
      },
    }
    internal.connected = true

    const schema = await adapter.getSchema('public')

    expect(calls).toHaveLength(2)
    expect(calls.some(sql => /information_schema\.columns|pg_index|pg_indexes/i.test(sql))).toBe(false)
    expect(schema.detail).toBe('list')
    expect(schema.tables).toEqual([{ name: 'items', schema: 'public', columns: [], columnsLoaded: false }])
  })

  it('MySQL: same split — default issues only the tables+views listing', async () => {
    const calls: string[] = []
    class FakeMySQLAdapter extends MySQLAdapter {
      override async query<T = Record<string, unknown>>(sql: string): Promise<QueryResult<T>> {
        calls.push(sql)
        if (/information_schema\.VIEWS/i.test(sql)) {
          return { data: [{ view_name: 'v_bom', view_schema: 'erp', view_definition: 'SELECT 1' }] as T[] }
        }
        if (/information_schema\.TABLES/i.test(sql)) {
          return { data: [{ table_name: 'items', table_schema: 'erp' }] as T[] }
        }
        return { data: [] as T[] }
      }
    }
    const adapter = new FakeMySQLAdapter({
      id: 'my', name: 'my', type: 'mysql', connection: { database: 'erp' }, options: { autoConnect: false },
    })

    const schema = await adapter.getSchema('erp')

    expect(calls).toHaveLength(2)
    expect(calls.some(sql => /information_schema\.COLUMNS|information_schema\.STATISTICS/i.test(sql))).toBe(false)
    expect(schema.detail).toBe('list')
    expect(schema.tables).toEqual([{ name: 'items', schema: 'erp', columns: [], columnsLoaded: false }])
  })
})

describe('(B) includeColumns budget — the server refuses before the proxy does (2026-09-10 222 PLM 504)', () => {
  it('a fan-out that outruns the budget throws a coded 504, values-free', async () => {
    // 10ms per round trip vs a 5ms budget: the two listing queries alone spend the budget, so the
    // check fires before the FIRST table's detail queries. No fake clock, no flakiness window.
    const fp = routingMssqlPool(10)
    const error = await mssqlAdapter(fp)
      .getSchema('dbo', { includeColumns: true, budgetMs: 5 })
      .then(() => { throw new Error('expected the budget to refuse') },
        (e: unknown) => e as Error & { status?: number; code?: string })

    expect(error.status).toBe(504)
    expect(error.code).toBe(SCHEMA_DETAIL_TIMEOUT_CODE)
    expect(error.message).toContain('0/3')
    // The refusal is about counts and time only — no host, port, database or table names.
    for (const leak of ['db', '1433', 'PLM', 'Bom_ExAttr1']) {
      expect(error.message).not.toContain(leak)
    }
    // It refused instead of grinding through the fan-out.
    expect(perTableQueries(fp.calls)).toEqual([])
  })

  it('the budget never touches the DEFAULT (list-only) path — a slow source still lists', async () => {
    const fp = routingMssqlPool(10)
    const schema = await mssqlAdapter(fp).getSchema('dbo', { budgetMs: 1 })
    expect(schema.tables).toHaveLength(3)
    expect(fp.calls).toHaveLength(2)
  })

  it('budgetMs <= 0 disables the budget (the documented offline-script escape hatch)', async () => {
    const fp = routingMssqlPool(2)
    const schema = await mssqlAdapter(fp).getSchema('dbo', { includeColumns: true, budgetMs: 0 })
    expect(schema.detail).toBe('full')
    expect(schema.tables).toHaveLength(3)
  })

  it('budget resolution: explicit → env → default, and junk falls back to the default (never to unbounded)', () => {
    expect(resolveSchemaDetailBudgetMs(1234, {})).toBe(1234)
    expect(resolveSchemaDetailBudgetMs(undefined, { [SCHEMA_DETAIL_BUDGET_ENV]: '9000' })).toBe(9000)
    expect(resolveSchemaDetailBudgetMs(undefined, {})).toBe(DEFAULT_SCHEMA_DETAIL_BUDGET_MS)
    expect(resolveSchemaDetailBudgetMs(undefined, { [SCHEMA_DETAIL_BUDGET_ENV]: 'soon' })).toBe(DEFAULT_SCHEMA_DETAIL_BUDGET_MS)
    expect(resolveSchemaDetailBudgetMs(undefined, { [SCHEMA_DETAIL_BUDGET_ENV]: '  ' })).toBe(DEFAULT_SCHEMA_DETAIL_BUDGET_MS)
  })
})

describe('(C) GET /api/data-sources/:id/schema — lazy by default, full only on request (2026-09-10 222 PLM 504)', () => {
  const pinned = usePinnedServer()
  let currentUser: { id: string; role?: string } | undefined
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    req.authenticatedTenantId = currentUser ? 'tenant-schema-lazy' : undefined
    next()
  })
  app.use(dataSourcesRouter())

  let seq = 0
  async function makeConnectedSource(): Promise<string> {
    const id = `ds-schema-${++seq}`
    const created = await request(pinned.url()).post('/api/data-sources').send({
      id, name: id, type: 'sqlserver',
      connection: { host: 'db', port: 1433, database: 'PLM' },
      credentials: { username: 'u', password: 'p' },
      options: { autoConnect: false },
    })
    expect(created.status).toBe(201)
    const adapter = getDataSourceManager().getDataSource(id)
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    return id
  }

  beforeEach(() => {
    currentUser = { id: 'alice', role: 'admin' }
    pinned.setApp(app)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('no query param → the adapter is asked for the LIST, and the body says so', async () => {
    const id = await makeConnectedSource()
    const fp = routingMssqlPool()
    const internal = getDataSourceManager().getDataSource(id) as unknown as { pool: unknown }
    internal.pool = fp.pool

    const res = await request(pinned.url()).get(`/api/data-sources/${id}/schema`)

    expect(res.status).toBe(200)
    expect(res.body.data.detail).toBe('list')
    expect(res.body.data.tables).toHaveLength(3)
    expect(res.body.data.tables[0].columnsLoaded).toBe(false)
    expect(perTableQueries(fp.calls)).toEqual([])
  })

  it('?includeColumns=1 restores the full body (explicit opt-in, unchanged for old callers)', async () => {
    const id = await makeConnectedSource()
    const fp = routingMssqlPool()
    const internal = getDataSourceManager().getDataSource(id) as unknown as { pool: unknown }
    internal.pool = fp.pool

    const res = await request(pinned.url()).get(`/api/data-sources/${id}/schema?includeColumns=1`)

    expect(res.status).toBe(200)
    expect(res.body.data.detail).toBe('full')
    expect(res.body.data.tables[0].columns).toHaveLength(1)
    expect(perTableQueries(fp.calls).length).toBe(TABLE_ROWS.length * 4)
  })

  it('?detail=full is the documented alias; anything else stays lazy', async () => {
    const id = await makeConnectedSource()
    const adapter = getDataSourceManager().getDataSource(id)
    const spy = vi.spyOn(adapter, 'getSchema').mockResolvedValue({ tables: [], detail: 'list' } as never)

    await request(pinned.url()).get(`/api/data-sources/${id}/schema?detail=full`)
    expect(spy).toHaveBeenLastCalledWith(undefined, { includeColumns: true })

    await request(pinned.url()).get(`/api/data-sources/${id}/schema?detail=list`)
    expect(spy).toHaveBeenLastCalledWith(undefined, { includeColumns: false })

    await request(pinned.url()).get(`/api/data-sources/${id}/schema?includeColumns=0`)
    expect(spy).toHaveBeenLastCalledWith(undefined, { includeColumns: false })

    // A repeated param arrives as an array — not a recognised opt-in, so it must NOT widen.
    await request(pinned.url()).get(`/api/data-sources/${id}/schema?includeColumns=1&includeColumns=1`)
    expect(spy).toHaveBeenLastCalledWith(undefined, { includeColumns: false })
  })

  it('a full listing that outruns the budget answers a coded 504 (not a proxy timeout, not a 500)', async () => {
    const id = await makeConnectedSource()
    vi.spyOn(getDataSourceManager().getDataSource(id), 'getSchema')
      .mockRejectedValue(schemaDetailTimeoutError(12, 480, 25_000))

    const res = await request(pinned.url()).get(`/api/data-sources/${id}/schema?includeColumns=1`)

    expect(res.status).toBe(504)
    expect(res.body.error.code).toBe(SCHEMA_DETAIL_TIMEOUT_CODE)
    expect(res.body.error.message).toContain('12/480')
    for (const leak of ['10.10.52.16', '1433', 'PLM.dbo']) {
      expect(JSON.stringify(res.body)).not.toContain(leak)
    }
  })

  it('the opt-in parser is strict and default-OFF', () => {
    for (const query of [{}, { includeColumns: '0' }, { includeColumns: 'maybe' }, { detail: 'list' },
      { includeColumns: ['1', '1'] }, { detail: ['full'] }]) {
      expect(wantsSchemaColumns(query as Record<string, unknown>)).toBe(false)
    }
    for (const query of [{ includeColumns: '1' }, { includeColumns: 'true' }, { includeColumns: 'YES' },
      { includeColumns: ' on ' }, { detail: 'FULL' }]) {
      expect(wantsSchemaColumns(query as Record<string, unknown>)).toBe(true)
    }
  })
})

describe('(D) plugin facades ask for columns EXPLICITLY — no caller gets a silently empty listing', () => {
  function facadeRig(readOnly = true) {
    const adapter = {
      isConnected: () => true,
      testConnection: vi.fn(async () => true),
      isReadOnly: () => readOnly,
      getName: () => 'pg',
      getType: () => 'postgres',
      getConfig: vi.fn(() => ({
        id: 'pg', name: 'pg', type: 'postgres', connection: {},
        // The write facade only authorizes a C6 write-gated target (readOnly:false +
        // c6WriteTarget + genericQueryDisabled) — mirror that posture, do not relax it.
        options: readOnly
          ? { readOnly: true }
          : { readOnly: false, c6WriteTarget: true, genericQueryDisabled: true },
      })),
      getSchema: vi.fn(async (_schema?: string, _options?: unknown) => ({ tables: [], views: [] })),
      getTableInfo: vi.fn(async (table: string) => ({ name: table, columns: [] })),
    }
    const manager = {
      assertAccess: vi.fn(),
      getScope: vi.fn(() => ({ ownerId: 'owner-1', workspaceId: null, tenantId: 't1', scopeKind: 'private' })),
      getDataSource: vi.fn(() => adapter),
      connectDataSource: vi.fn(async () => undefined),
      select: vi.fn(async () => ({ data: [], metadata: {} } as unknown as QueryResult<Record<string, DbValue>>)),
    } as unknown as DataSourceManager
    return { adapter, manager }
  }

  // plugin-integration-core's read-only source adapter maps EVERY listing entry's `columns` into the
  // object schema its listObjects() returns. A lazy listing would hand it empty field lists — a
  // WRONG answer ("no fields"), not merely a slow one. So the facade opts in.
  it('read facade forwards { includeColumns: true } and OPTS OUT of the route budget', async () => {
    const { adapter, manager } = facadeRig()
    const facade = createDataSourcePluginFacade(() => manager)
    await facade.getSchema('pg', 'owner-1', 'public')
    expect(adapter.getSchema).toHaveBeenCalledWith('public', {
      includeColumns: true,
      budgetMs: SCHEMA_DETAIL_BUDGET_DISABLED,
    })
  })

  it('write facade forwards { includeColumns: true } and OPTS OUT of the route budget', async () => {
    const { adapter, manager } = facadeRig(false)
    const facade = createDataSourceWritePluginFacade(() => manager)
    await facade.getSchema('pg', 'owner-1', 'public')
    expect(adapter.getSchema).toHaveBeenCalledWith('public', {
      includeColumns: true,
      budgetMs: SCHEMA_DETAIL_BUDGET_DISABLED,
    })
  })

  // The behavioural half of the assertion above: the budget is scoped to the opt-in
  // GET /:id/schema?includeColumns=1 route. This facade is the plugin listObjects() path, which was
  // unbounded before and sits behind a proxy configured for 300s (docker/nginx.conf:63) — a listing
  // that used to SUCCEED must not start failing SCHEMA_DETAIL_TIMEOUT. Drop `budgetMs` in the
  // facade and this goes red (the deployment default / env value would apply instead).
  it('a facade listing slower than the configured default budget still SUCCEEDS (no new hard failure)', async () => {
    const previous = process.env[SCHEMA_DETAIL_BUDGET_ENV]
    process.env[SCHEMA_DETAIL_BUDGET_ENV] = '5'
    try {
      const { adapter, manager } = facadeRig()
      // 10ms per round trip against a 5ms deployment budget: the listing queries alone outrun it.
      const real = mssqlAdapter(routingMssqlPool(10))
      adapter.getSchema = vi.fn((schema?: string, options?: unknown) =>
        real.getSchema(schema, options as { includeColumns?: boolean; budgetMs?: number })) as never

      const schema = await createDataSourcePluginFacade(() => manager).getSchema('pg', 'owner-1', 'dbo')

      expect((schema as { detail?: string }).detail).toBe('full')
      expect(schema.tables).toHaveLength(TABLE_ROWS.length)
      expect(schema.tables[0].columns.map((c: { name: string }) => c.name)).toEqual(['FItemID'])
    } finally {
      if (previous === undefined) delete process.env[SCHEMA_DETAIL_BUDGET_ENV]
      else process.env[SCHEMA_DETAIL_BUDGET_ENV] = previous
    }
  })
})
