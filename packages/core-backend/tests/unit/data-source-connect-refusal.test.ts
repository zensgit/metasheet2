import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import {
  DataSourceManager,
  DATA_SOURCE_UNAVAILABLE_CODE,
  DATA_SOURCE_UNAVAILABLE_MESSAGE,
} from '../../src/data-adapters/DataSourceManager'
import { dataSourcesRouter, getDataSourceManager } from '../../src/routes/data-sources'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

// #2 VALUES-FREE CONNECT REFUSAL.
// Before: an unconnected external source + a click on 「结构」/「表」 ran the route's on-demand
// `connectDataSource`, whose adapter-level failure text (`Failed to connect to SQL Server:
// ConnectionError: ... 10.10.52.16:1433 ... Login failed for user '...'`) was echoed VERBATIM as a
// 500 SCHEMA_ERROR body — leaking host, port, database and login to any reader of the browser
// console. After: connectDataSource translates every connect failure into a coded 503
// SOURCE_UNAVAILABLE carrying a fixed sentence, and /schema, /tables/:table, /query, /select and
// /:id/connect surface it through the existing codedGateRefusal path.
//
// The driver text used here is the shape mssql actually produces (see MSSQLAdapter.ts:230, which
// this change deliberately does NOT touch — mssql-adapter-connect-wiring.test.ts pins it).
const DRIVER_TEXT =
  "Failed to connect to SQL Server: ConnectionError: Failed to connect to 10.10.52.16:1433 - Login failed for user 'plm_reader'."
// Every fragment of the driver text that must never reach the client.
const LEAKS = [
  '10.10.52.16',
  '1433',
  'Login failed',
  'plm_reader',
  'ConnectionError',
  'Failed to connect to SQL Server',
]

function expectValuesFree(payload: unknown): void {
  const text = JSON.stringify(payload)
  for (const leak of LEAKS) {
    expect(text).not.toContain(leak)
  }
}

const sqlServerConfig = (id: string): DataSourceConfig => ({
  id,
  name: id,
  type: 'sqlserver',
  connection: { host: '10.10.52.16', port: 1433, database: 'PLM' },
  credentials: { username: 'plm_reader', password: 'secret' },
  options: { autoConnect: false },
}) as DataSourceConfig

// ── (a) manager layer ────────────────────────────────────────────────────────────────────────
describe('DataSourceManager.connectDataSource — coded, values-free refusal (#2)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('translates the raw driver failure into 503 SOURCE_UNAVAILABLE without echoing it', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlServerConfig('mssql-a'), { ownerId: 'alice' })
    vi.spyOn(m.getDataSource('mssql-a'), 'connect').mockRejectedValue(new Error(DRIVER_TEXT))

    const err = await m.connectDataSource('mssql-a').then(
      () => { throw new Error('expected connectDataSource to reject') },
      (e: unknown) => e as Error & { status?: number; code?: string },
    )

    expect(err.status).toBe(503)
    expect(err.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
    expect(err.message).toBe(DATA_SOURCE_UNAVAILABLE_MESSAGE)
    expectValuesFree({ message: err.message, ...err })
  })

  it('a piggy-backing caller sharing the in-flight connect gets the SAME values-free refusal', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlServerConfig('mssql-shared'), { ownerId: 'alice' })
    let release: (e: Error) => void = () => {}
    vi.spyOn(m.getDataSource('mssql-shared'), 'connect').mockReturnValue(
      new Promise<void>((_resolve, reject) => { release = reject }),
    )

    const first = m.connectDataSource('mssql-shared')
    const second = m.connectDataSource('mssql-shared') // reuses the pooled promise
    release(new Error(DRIVER_TEXT))

    for (const p of [first, second]) {
      const err = await p.then(
        () => { throw new Error('expected rejection') },
        (e: unknown) => e as Error & { status?: number; code?: string },
      )
      expect(err.status).toBe(503)
      expect(err.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
      expectValuesFree({ message: err.message })
    }
  })

  it('never downgrades a deliberate coded gate refusal (403 stays 403)', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlServerConfig('mssql-coded'), { ownerId: 'alice' })
    const gate = Object.assign(new Error('write arm is not provisioned'), {
      status: 403,
      code: 'ARM_NOT_PROVISIONED',
    })
    vi.spyOn(m.getDataSource('mssql-coded'), 'connect').mockRejectedValue(gate)
    await expect(m.connectDataSource('mssql-coded')).rejects.toBe(gate)
  })

  it('a missing data source still throws the plain not-found error (404 mapping preserved)', async () => {
    const m = new DataSourceManager()
    await expect(m.connectDataSource('ghost')).rejects.toThrow(/not found/)
  })
})

// ── (b)-(f) route layer ──────────────────────────────────────────────────────────────────────
describe('data-source routes surface the connect refusal as 503 SOURCE_UNAVAILABLE (#2)', () => {
  const pinned = usePinnedServer()
  let currentUser: { id: string; role?: string } | undefined

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = currentUser as never
    req.authenticatedTenantId = currentUser ? 'tenant-connect-refusal' : undefined
    next()
  })
  app.use(dataSourcesRouter())

  let seq = 0
  // Creates the source through the real route, then makes its adapter's connect() fail with the
  // real driver text. Everything downstream (manager translation + route mapping) stays REAL.
  async function makeUnconnectableSource(): Promise<string> {
    const id = `ds-refuse-${++seq}`
    const created = await request(pinned.url()).post('/api/data-sources').send(sqlServerConfig(id))
    expect(created.status).toBe(201)
    vi.spyOn(getDataSourceManager().getDataSource(id), 'connect').mockRejectedValue(new Error(DRIVER_TEXT))
    return id
  }

  beforeEach(() => {
    currentUser = { id: 'alice', role: 'admin' }
    pinned.setApp(app)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('(b1) GET /:id/schema — 503 SOURCE_UNAVAILABLE, no driver text', async () => {
    const id = await makeUnconnectableSource()
    const res = await request(pinned.url()).get(`/api/data-sources/${id}/schema`)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
    expect(res.body.error.message).toBe(DATA_SOURCE_UNAVAILABLE_MESSAGE)
    expectValuesFree(res.body)
  })

  it('(b2) GET /:id/tables/:table — 503 SOURCE_UNAVAILABLE, no driver text', async () => {
    const id = await makeUnconnectableSource()
    const res = await request(pinned.url()).get(`/api/data-sources/${id}/tables/dbo.Orders`)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
    expectValuesFree(res.body)
  })

  it('(c) GET /:id/schema on an ALREADY connected adapter is unchanged (200, no connect attempt)', async () => {
    const id = `ds-connected-${++seq}`
    await request(pinned.url()).post('/api/data-sources').send(sqlServerConfig(id))
    const adapter = getDataSourceManager().getDataSource(id)
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    const connectSpy = vi.spyOn(adapter, 'connect')
    vi.spyOn(adapter, 'getSchema').mockResolvedValue({ tables: [] } as never)

    const res = await request(pinned.url()).get(`/api/data-sources/${id}/schema`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('(d) an unknown data source is still 404 NOT_FOUND, not 503', async () => {
    const schema = await request(pinned.url()).get('/api/data-sources/no-such-source/schema')
    expect(schema.status).toBe(404)
    expect(schema.body.error.code).toBe('NOT_FOUND')

    const table = await request(pinned.url()).get('/api/data-sources/no-such-source/tables/t')
    expect(table.status).toBe(404)
    expect(table.body.error.code).toBe('NOT_FOUND')
  })

  it('(e1) POST /:id/query — 503 SOURCE_UNAVAILABLE, no driver text', async () => {
    const id = await makeUnconnectableSource()
    const res = await request(pinned.url())
      .post(`/api/data-sources/${id}/query`)
      .send({ sql: 'SELECT TOP (1) 1 AS x' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
    expectValuesFree(res.body)
  })

  it('(e2) POST /:id/select — 503 SOURCE_UNAVAILABLE, no driver text', async () => {
    const id = await makeUnconnectableSource()
    const res = await request(pinned.url())
      .post(`/api/data-sources/${id}/select`)
      .send({ table: 'dbo.Orders' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
    expectValuesFree(res.body)
  })

  it('(f) POST /:id/connect — 503 SOURCE_UNAVAILABLE, no driver text', async () => {
    const id = await makeUnconnectableSource()
    const res = await request(pinned.url()).post(`/api/data-sources/${id}/connect`).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
    expectValuesFree(res.body)
  })
})
