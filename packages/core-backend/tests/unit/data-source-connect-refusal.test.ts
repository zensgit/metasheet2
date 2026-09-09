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
import {
  dataSourcesRouter,
  getDataSourceManager,
  SCHEMA_FAILURE_MESSAGE,
  TABLE_INFO_FAILURE_MESSAGE,
  CONNECT_FAILURE_MESSAGE,
} from '../../src/routes/data-sources'
import { auditLog } from '../../src/audit/audit'
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

  // The failure class that has NO `connectionError`: every adapter's driver-package-missing guard
  // throws BEFORE the try block that calls onError (MSSQLAdapter.ts:217 `mssql package is not
  // installed`, PostgresAdapter.ts:74, MySQLAdapter.ts:195, HTTPAdapter.ts:134), so
  // `adapter.connectionError` stays null. If the manager logged shape only, this cause would be
  // readable NOWHERE — not in the response (fixed sentence), not in 「测试连接」 (same null
  // connectionError), not in the log. The refusal must stay values-free AND the log must carry it.
  it('still logs the cause when the failure never reached onError (connectionError === null)', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlServerConfig('mssql-no-driver'), { ownerId: 'alice' })
    const adapter = m.getDataSource('mssql-no-driver')
    // NOT via onError — exactly MSSQLAdapter.ts:217's early throw.
    vi.spyOn(adapter, 'connect').mockRejectedValue(new Error('mssql package is not installed'))
    expect(adapter.connectionError).toBeNull()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const err = await m.connectDataSource('mssql-no-driver').then(
      () => { throw new Error('expected connectDataSource to reject') },
      (e: unknown) => e as Error & { status?: number; code?: string },
    )

    // Client side unchanged: still the fixed 503.
    expect(err.status).toBe(503)
    expect(err.code).toBe(DATA_SOURCE_UNAVAILABLE_CODE)
    expect(err.message).toBe(DATA_SOURCE_UNAVAILABLE_MESSAGE)
    // Server side: the cause survives in the log.
    const call = logged.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('Connect failed for mssql-no-driver'),
    )
    expect(call).toBeDefined()
    expect((call?.[1] as { redactedCause?: unknown }).redactedCause).toBe('mssql package is not installed')
  })

  it('redacts the fallback message, so a pre-onError throw cannot log a secret', async () => {
    const PASSWORD = 'SuperSecretPw!2026'
    const m = new DataSourceManager()
    await m.addDataSource(
      { ...sqlServerConfig('mssql-secret'), credentials: { username: 'plm_reader', password: PASSWORD } },
      { ownerId: 'alice' },
    )
    const adapter = m.getDataSource('mssql-secret')
    vi.spyOn(adapter, 'connect').mockRejectedValue(
      new Error(`driver bootstrap failed (password=${PASSWORD})`), // no onError -> no connectionError
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(m.connectDataSource('mssql-secret')).rejects.toMatchObject({ status: 503 })

    const call = logged.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('Connect failed for mssql-secret'),
    )
    const cause = (call?.[1] as { redactedCause?: unknown }).redactedCause as string
    expect(cause).toContain('driver bootstrap failed')
    expect(cause).not.toContain(PASSWORD)
    expect(cause).toContain('***')
  })

  it('prefers the onError-recorded redacted cause over the raw message', async () => {
    const m = new DataSourceManager()
    await m.addDataSource(sqlServerConfig('mssql-onerror'), { ownerId: 'alice' })
    const adapter = m.getDataSource('mssql-onerror')
    vi.spyOn(adapter, 'connect').mockImplementation(async () => {
      // What a real adapter does: record the redacted cause, then rethrow the wrapped driver text.
      await (adapter as unknown as { onError(e: Error): Promise<void> }).onError(new Error('recorded cause'))
      throw new Error(DRIVER_TEXT)
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(m.connectDataSource('mssql-onerror')).rejects.toMatchObject({ status: 503 })

    const call = logged.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('Connect failed for mssql-onerror'),
    )
    expect((call?.[1] as { redactedCause?: unknown }).redactedCause).toBe('recorded cause')
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
  // ── (g) the OTHER half: connect succeeded, the STATEMENT (or the audit write) failed ─────────
  // These land in the very same catch blocks but on the NON-coded branch — the branch that used to
  // answer `error.message` verbatim. It is the likeliest place for the leak to grow back, because
  // nothing about it looks like a "connect" path: mssql answers `Invalid object name
  // 'PLM.dbo.Bom_ExAttr1'` (database + schema + table), pg answers `relation ... does not exist`,
  // and a failing audit write answers a full pg connection string. The client gets the fixed
  // sentence and the pre-existing code (SCHEMA_ERROR / TABLE_INFO_ERROR / CONNECTION_ERROR); the
  // cause goes to the server log only.
  const MSSQL_OBJECT_TEXT =
    "Invalid object name 'PLM.dbo.Bom_ExAttr1'. RequestError at Connection.tds 10.10.52.16:1433"
  const PG_RELATION_TEXT =
    'error: relation "plm_stage.stock_prep_orders" does not exist at Parser.parseErrorMessage (host 10.10.52.16:5432)'
  const AUDIT_DB_TEXT =
    'insert into "audit_logs" - connection to server at "10.10.52.16", port 5432 failed: password authentication failed for user "metasheet_rw"'

  // A source whose adapter is CONNECTED — so the route skips connect-on-demand entirely and the
  // failure can only come from the statement itself.
  async function makeConnectedSource(): Promise<string> {
    const id = `ds-stmt-${++seq}`
    const created = await request(pinned.url()).post('/api/data-sources').send(sqlServerConfig(id))
    expect(created.status).toBe(201)
    const adapter = getDataSourceManager().getDataSource(id)
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    return id
  }

  it('(g1) GET /:id/schema — a connected adapter whose getSchema throws the driver text answers the fixed sentence', async () => {
    const id = await makeConnectedSource()
    vi.spyOn(getDataSourceManager().getDataSource(id), 'getSchema').mockRejectedValue(new Error(MSSQL_OBJECT_TEXT))

    const res = await request(pinned.url()).get(`/api/data-sources/${id}/schema`)

    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('SCHEMA_ERROR')
    expect(res.body.error.message).toBe(SCHEMA_FAILURE_MESSAGE)
    for (const leak of ['Invalid object name', 'PLM.dbo', 'Bom_ExAttr1', '10.10.52.16', '1433', 'RequestError']) {
      expect(JSON.stringify(res.body)).not.toContain(leak)
    }
  })

  it('(g2) GET /:id/tables/:table — a connected adapter whose getTableInfo throws the driver text answers the fixed sentence', async () => {
    const id = await makeConnectedSource()
    vi.spyOn(getDataSourceManager().getDataSource(id), 'getTableInfo').mockRejectedValue(new Error(PG_RELATION_TEXT))

    const res = await request(pinned.url()).get(`/api/data-sources/${id}/tables/stock_prep_orders`)

    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('TABLE_INFO_ERROR')
    expect(res.body.error.message).toBe(TABLE_INFO_FAILURE_MESSAGE)
    for (const leak of ['relation', 'plm_stage', 'does not exist', '10.10.52.16', '5432', 'Parser']) {
      expect(JSON.stringify(res.body)).not.toContain(leak)
    }
  })

  it("(g3) GET /:id/tables/:table — an adapter's own `not found` keeps 404 but no longer echoes its text", async () => {
    // MongoDB's shape: `ns not found` names database.collection. The mapping to 404 is preserved;
    // the body now repeats only the table the caller asked for.
    const id = await makeConnectedSource()
    vi.spyOn(getDataSourceManager().getDataSource(id), 'getTableInfo').mockRejectedValue(
      new Error('ns not found: plm_stage.Bom_ExAttr1 (10.10.52.16:27017)'),
    )

    const res = await request(pinned.url()).get(`/api/data-sources/${id}/tables/Bom_ExAttr1`)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(res.body.error.message).toBe("Table 'Bom_ExAttr1' not found")
    for (const leak of ['ns not found', 'plm_stage', '10.10.52.16', '27017']) {
      expect(JSON.stringify(res.body)).not.toContain(leak)
    }
  })

  it('(g4) an unknown source keeps the source-level 404 wording on /tables (not the table-level one)', async () => {
    // The two 404 branches must stay distinguishable in code but indistinguishable to a prober:
    // assertAccess throws the SAME `Data source with id '<id>' not found` for a source that does not
    // exist and for one owned by somebody else (DataSourceManager.ts:563-573), so both render this
    // wording. The foreign-owner half is pinned for status by
    // data-source-visibility-authority-matrix.test.ts:547; it cannot run here because a non-admin
    // request never reaches the handler in this harness (rbacGuard needs a DB).
    const unknown = await request(pinned.url()).get('/api/data-sources/ds-does-not-exist/tables/t')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('NOT_FOUND')
    expect(unknown.body.error.message).toBe("Data source 'ds-does-not-exist' not found")
  })

  it('(g5) POST /:id/connect — a NON-coded failure (the cross-owner audit write) answers the fixed sentence', async () => {
    // Reachable without touching the adapter: a platform admin connecting someone else's source
    // writes a cross-owner audit row first, and that write talks to Postgres — whose failure text is
    // a connection string. Before, it was echoed as the CONNECTION_ERROR body.
    const id = await makeConnectedSource() // created by alice
    currentUser = { id: 'root', role: 'admin' } // platform admin acting on alice's source
    vi.mocked(auditLog).mockRejectedValueOnce(new Error(AUDIT_DB_TEXT))

    const res = await request(pinned.url()).post(`/api/data-sources/${id}/connect`).send({})

    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('CONNECTION_ERROR')
    expect(res.body.error.message).toBe(CONNECT_FAILURE_MESSAGE)
    for (const leak of ['audit_logs', '10.10.52.16', '5432', 'password authentication', 'metasheet_rw']) {
      expect(JSON.stringify(res.body)).not.toContain(leak)
    }
  })
})
