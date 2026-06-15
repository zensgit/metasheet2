import { createRequire } from 'module'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { createDataSourcePluginFacade } from '../../src/data-adapters/data-source-plugin-facade'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

type ReadResult = {
  records: Array<Record<string, unknown>>
  nextCursor: string | null
  done: boolean
  metadata?: Record<string, unknown>
}

const require = createRequire(import.meta.url)
const {
  ADAPTER_KIND,
  createDataSourceSqlReadonlySourceAdapter,
} = require('../../../../plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs') as {
  ADAPTER_KIND: string
  createDataSourceSqlReadonlySourceAdapter: (input: {
    system: { kind: string; config: { dataSourceId: string } }
    context: { api: { dataSources: ReturnType<typeof createDataSourcePluginFacade> } }
    principal?: string
  }) => {
    read(input: Record<string, unknown>): Promise<ReadResult>
  }
}

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const OWNER_ID = 'c3-realdb-owner'
const DATA_SOURCE_ID = 'c3-realdb-postgres'
const WATERMARK_TIMESTAMP = '2026-06-01T01:00:00.000Z'
const LATER_TIMESTAMP = '2026-06-01T01:05:00.000Z'
const BIGINT_FLOOR = '9007199254740992'

function decodeWatermarkCursor(cursor: string | null): Record<string, unknown> {
  expect(cursor).toBeTruthy()
  const prefix = 'dswm1:'
  expect(cursor!.startsWith(prefix)).toBe(true)
  return JSON.parse(Buffer.from(cursor!.slice(prefix.length), 'base64url').toString('utf8')) as Record<string, unknown>
}

function configFromDatabaseUrl(id: string, databaseUrl: string): DataSourceConfig {
  const parsed = new URL(databaseUrl)
  const credentials: Record<string, string> = {}
  if (parsed.username) credentials.username = decodeURIComponent(parsed.username)
  if (parsed.password) credentials.password = decodeURIComponent(parsed.password)

  return {
    id,
    name: 'C3 real-DB Postgres',
    type: 'postgresql',
    connection: {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? Number(parsed.port) : 5432,
      database: parsed.pathname.replace(/^\//, ''),
    },
    credentials,
    options: { readOnly: true, autoConnect: false },
    poolConfig: { min: 0, max: 2, idleTimeout: 1000 },
  }
}

describeIfDatabase('data-source:sql-readonly C3 keyset watermark real-DB wire', () => {
  const tableName = `c3_keyset_realdb_${process.pid}_${Date.now()}`
  const qualifiedTable = `public.${tableName}`
  let pool: Pool
  let manager: DataSourceManager
  let adapter: ReturnType<typeof createDataSourceSqlReadonlySourceAdapter>

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    await pool.query(`DROP TABLE IF EXISTS public.${tableName}`)
    await pool.query(`
      CREATE TABLE public.${tableName} (
        id bigint NOT NULL,
        updated_at timestamptz NOT NULL,
        status text NOT NULL,
        payload text NOT NULL
      )
    `)
    // Insert deliberately out of id order. If the host facade drops orderBy, the first page follows
    // heap/insertion order on this table and the assertion below fails; if it drops where, inactive
    // rows leak into the adapter result.
    await pool.query(
      `
        INSERT INTO public.${tableName} (id, updated_at, status, payload)
        VALUES
          (4, $1::timestamptz, 'active', 'same-ts-4'),
          (1, $1::timestamptz, 'inactive', 'same-ts-inactive'),
          (2, $1::timestamptz, 'active', 'same-ts-2'),
          (3, $1::timestamptz, 'active', 'same-ts-3'),
          (5, $2::timestamptz, 'active', 'later-5'),
          (6, $2::timestamptz, 'inactive', 'later-inactive'),
          (7, $2::timestamptz, 'active', 'later-7'),
          (9007199254740994, $2::timestamptz, 'big', 'big-4'),
          (9007199254740993, $2::timestamptz, 'big', 'big-3')
      `,
      [WATERMARK_TIMESTAMP, LATER_TIMESTAMP],
    )

    manager = new DataSourceManager()
    await manager.addDataSource(configFromDatabaseUrl(DATA_SOURCE_ID, process.env.DATABASE_URL!), {
      ownerId: OWNER_ID,
      persist: false,
    })
    const facade = createDataSourcePluginFacade(() => manager)
    adapter = createDataSourceSqlReadonlySourceAdapter({
      system: { kind: ADAPTER_KIND, config: { dataSourceId: DATA_SOURCE_ID } },
      context: { api: { dataSources: facade } },
      principal: OWNER_ID,
    })
  })

  afterAll(async () => {
    if (manager) {
      await manager.disconnectDataSource(DATA_SOURCE_ID).catch(() => undefined)
    }
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS public.${tableName}`).catch(() => undefined)
      await pool.end()
    }
  })

  it('preserves equality filters and composite updated_at keyset paging through the real Postgres path', async () => {
    const first = await adapter.read({
      object: qualifiedTable,
      limit: 2,
      filters: { status: 'active' },
      watermark: { updated_at: WATERMARK_TIMESTAMP },
      watermarkConfig: { type: 'updated_at', field: 'updated_at', tiebreaker: 'id' },
    })

    expect(first.done).toBe(false)
    expect(first.records.map((row) => row.id)).toEqual(['2', '3'])
    expect(first.records.map((row) => row.status)).toEqual(['active', 'active'])
    expect(first.metadata).toMatchObject({
      mode: 'wm-composite',
      watermarkType: 'updated_at',
      watermarkField: 'updated_at',
      count: 2,
    })
    expect(decodeWatermarkCursor(first.nextCursor)).toMatchObject({
      mode: 'wm-composite',
      type: 'updated_at',
      field: 'updated_at',
      tiebreaker: 'id',
      value: WATERMARK_TIMESTAMP,
      tiebreakerValue: '3',
    })

    const second = await adapter.read({
      object: qualifiedTable,
      limit: 2,
      cursor: first.nextCursor,
      filters: { status: 'active' },
      watermark: { updated_at: WATERMARK_TIMESTAMP },
      watermarkConfig: { type: 'updated_at', field: 'updated_at', tiebreaker: 'id' },
    })

    expect(second.done).toBe(false)
    expect(second.records.map((row) => row.id)).toEqual(['4', '5'])
    expect(second.records.map((row) => row.status)).toEqual(['active', 'active'])
    expect(decodeWatermarkCursor(second.nextCursor)).toMatchObject({
      mode: 'wm-composite',
      value: LATER_TIMESTAMP,
      tiebreakerValue: '5',
    })

    const third = await adapter.read({
      object: qualifiedTable,
      limit: 2,
      cursor: second.nextCursor,
      filters: { status: 'active' },
      watermark: { updated_at: WATERMARK_TIMESTAMP },
      watermarkConfig: { type: 'updated_at', field: 'updated_at', tiebreaker: 'id' },
    })

    expect(third.done).toBe(true)
    expect(third.nextCursor).toBeNull()
    expect(third.records.map((row) => row.id)).toEqual(['7'])
    expect(third.records.map((row) => row.status)).toEqual(['active'])
  })

  it('preserves BIGINT monotonic_id keyset values as strings through the real Postgres path', async () => {
    const result = await adapter.read({
      object: qualifiedTable,
      limit: 2,
      filters: { status: 'big' },
      watermark: { id: BIGINT_FLOOR },
      watermarkConfig: { type: 'monotonic_id', field: 'id' },
    })

    expect(result.done).toBe(false)
    expect(result.records.map((row) => row.id)).toEqual(['9007199254740993', '9007199254740994'])
    expect(decodeWatermarkCursor(result.nextCursor)).toMatchObject({
      mode: 'wm-mono',
      type: 'monotonic_id',
      field: 'id',
      value: '9007199254740994',
    })
  })
})
