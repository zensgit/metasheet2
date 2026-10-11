/**
 * R-41 applied to routes/data-sources.ts: no body, of any status, carries what an adapter, a driver or a
 * transport said.
 *
 * WHAT IS PINNED
 *   - READ RESULTS (200 on /query and /select). A failed read comes back from the adapter as a QueryResult whose
 *     `error` is the caught value. Driven through the REAL adapters: a real HTTPAdapter whose axios client fails
 *     the request with a genuine AxiosError (config.headers carry the stored API key and the bearer token — both
 *     markers), and a real PostgresAdapter whose pool rejects with a genuine pg DatabaseError (marker in message,
 *     detail, table and a documentation IP). The body carries `{ code: SOURCE_READ_FAILED, message: <fixed> }`,
 *     neither marker, no 'stack' and no 'config' — checked on JSON.stringify(body), which is what res.json sends
 *     (AxiosError#toJSON included). An adapter's extra fields — top level, metadata, column, sub-source — do not
 *     travel; a sub-source's failure text becomes the fixed sentence.
 *   - Every GENERIC 500 arm: an ECONNREFUSED-shaped error carrying a marker and a documentation IP answers the
 *     route's literal 500, its unchanged code and its fixed sentence; neither appears anywhere in the body.
 *   - Positive control: a coded gate refusal (status + code) ahead of the generic arm keeps its 4xx status, its
 *     code and its message byte-for-byte on every route that has one.
 *   - A3 test routes: the redacted cause STRING still shows as it is (contract unchanged); a non-string cause is
 *     answered with the fixed sentence, never serialized.
 *   - The server log line is values-free: class, integer / token codes only; a code with an address shape is
 *     dropped.
 *   - Static: the values-free AST scanner finds no 5xx echo in the file other than the codedGateRefusal arms.
 *
 * HOW: handlers are invoked straight off the router stack with a response stub (never request(app), the CI
 * tripwire); DataSourceManager is the real class with its prototype methods spied per case.
 */
import type { Request, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { AxiosError } from 'axios'
import { DatabaseError } from 'pg'
import { Logger } from '../../src/core/logger'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { HTTPAdapter } from '../../src/data-adapters/HTTPAdapter'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import type { BaseDataAdapter, DataSourceConfig, QueryResult } from '../../src/data-adapters/BaseAdapter'
import {
  DATA_SOURCE_FAILURE_MESSAGES,
  SOURCE_READ_FAILED_CODE,
  SOURCE_READ_FAILURE_MESSAGE,
  dataSourcesRouter,
} from '../../src/routes/data-sources'
import { scanResponseErrorEcho } from '../utils/response-error-echo-scan'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_FILE = path.resolve(HERE, '../../src/routes/data-sources.ts')

const API_KEY_MARKER = 'MARKER_ECHO_S1_APIKEY_7f3'
const BEARER_MARKER = 'MARKER_ECHO_S1_BEARER_9k2'
const BODY_MARKER = 'MARKER_ECHO_S1_BODY_4d1'
const PG_MARKER = 'MARKER_ECHO_S1_PG_2x8'
const ARM_MARKER = 'MARKER_ECHO_S1_ARM_5m6'
const DOC_IP = '192.0.2.44'
const DOC_IP_HTTP = '203.0.113.9'

type Method = 'get' | 'post' | 'put' | 'delete'
type StubResponse = Response & { statusCode: number; body: unknown }

function stubResponse(): StubResponse {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as unknown as StubResponse
}

async function invoke(
  method: Method,
  routePath: string,
  options: { params?: Record<string, string>; body?: unknown } = {},
): Promise<StubResponse> {
  const router = dataSourcesRouter()
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && (entry.route as { methods?: Record<string, boolean> }).methods?.[method],
  )
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${routePath} not found`)
  const req = {
    method: method.toUpperCase(),
    url: routePath,
    headers: {},
    query: {},
    params: options.params ?? {},
    body: options.body ?? {},
    user: { id: 'alice', role: 'admin' },
    authenticatedTenantId: 'tenant-echo-s1',
  } as unknown as Request
  const res = stubResponse()
  for (const routeLayer of layer.route.stack) {
    if (res.headersSent) break
    await new Promise<void>((resolve, reject) => {
      try {
        const out = routeLayer.handle(req, res, (error?: unknown) => (error ? reject(error) : resolve()))
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          Promise.resolve(out).then(() => resolve()).catch(reject)
        }
      } catch (error) {
        reject(error)
      }
    })
  }
  return res
}

/** What res.json puts on the wire. */
const wire = (res: StubResponse): string => JSON.stringify(res.body)

const proto = DataSourceManager.prototype

function armError(): Error {
  return Object.assign(new Error(`connect ECONNREFUSED ${DOC_IP}:5432 (${ARM_MARKER})`), {
    code: 'ECONNREFUSED',
    errno: -111,
    syscall: 'connect',
    address: DOC_IP,
    port: 5432,
  })
}

function codedRefusal(): Error {
  return Object.assign(new Error('this data source is not authorized for generic outbound SQL write'), {
    status: 403,
    code: 'OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED',
  })
}

/** A minimal stand-in adapter for the routes that read config / flags before the failing call. */
function fakeAdapter(): BaseDataAdapter {
  return {
    getConfig: () => ({ id: 'ds-1', name: 'ds-1', type: 'postgres', connection: {}, options: { readOnly: false } }),
    isConnected: () => true,
    isReadOnly: () => false,
    isSqlDialect: () => true,
  } as unknown as BaseDataAdapter
}

const validCreateBody = {
  id: 'ds-new',
  name: 'ds-new',
  type: 'postgres',
  connection: { host: 'db.example.test', database: 'x' },
}

/** A REAL HTTPAdapter whose axios client fails every request with a genuine AxiosError built from the real config. */
async function failingHttpAdapter(): Promise<HTTPAdapter> {
  const adapter = new HTTPAdapter({
    id: 'ds-http',
    name: 'ds-http',
    type: 'http',
    connection: { baseURL: `http://${DOC_IP_HTTP}` },
    credentials: { apiKey: API_KEY_MARKER },
    options: { autoConnect: false, readOnly: false },
  } as DataSourceConfig)
  adapter.on('error', () => {})
  // A token provider (as PLMAdapter uses) adds the bearer header in the request interceptor.
  adapter.setTokenProvider({ getToken: async () => BEARER_MARKER })
  await adapter.connect()
  const client = (adapter as unknown as { client: { defaults: Record<string, unknown> } }).client
  client.defaults.adapter = (config: Record<string, unknown>) =>
    Promise.reject(
      new AxiosError(
        `Request failed with status code 502 from ${DOC_IP_HTTP}`,
        AxiosError.ERR_BAD_RESPONSE,
        config as never,
        {},
        { status: 502, statusText: 'Bad Gateway', headers: {}, config: config as never, data: { detail: BODY_MARKER } },
      ),
    )
  return adapter
}

/** A REAL PostgresAdapter whose pool rejects with a genuine pg DatabaseError. */
function failingPgAdapter(): PostgresAdapter {
  const adapter = new PostgresAdapter({
    id: 'ds-pg',
    name: 'ds-pg',
    type: 'postgres',
    connection: { host: 'db.example.test', database: 'x' },
    options: { autoConnect: false },
  })
  adapter.on('error', () => {})
  const dbError = new DatabaseError(`relation "${PG_MARKER}" does not exist`, 120, 'error')
  dbError.code = '42P01'
  dbError.detail = `Failing row contains (${DOC_IP}, ${PG_MARKER}).`
  dbError.table = PG_MARKER
  dbError.where = `SQL statement "SELECT * FROM ${PG_MARKER}"`
  const internal = adapter as unknown as { pool: unknown; connected: boolean }
  internal.pool = { query: async () => { throw dbError } }
  internal.connected = true
  return adapter
}

function expectFixedReadFailure(res: StubResponse): void {
  expect(res.statusCode).toBe(200)
  const body = res.body as { ok: boolean; data: { data: unknown[]; error?: unknown } }
  expect(body.ok).toBe(true)
  expect(body.data.data).toEqual([])
  expect(body.data.error).toEqual({ code: SOURCE_READ_FAILED_CODE, message: SOURCE_READ_FAILURE_MESSAGE })
  const text = wire(res)
  for (const needle of [API_KEY_MARKER, BEARER_MARKER, BODY_MARKER, PG_MARKER, 'MARKER_', DOC_IP, DOC_IP_HTTP, '"stack"', '"config"', 'headers', 'Authorization', 'X-API-Key']) {
    expect(text).not.toContain(needle)
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('read results (/query, /select) never serialize the adapter error', () => {
  it('HTTP adapter: a real AxiosError (stored API key + bearer in config.headers) is not on the wire', async () => {
    const adapter = await failingHttpAdapter()

    // Precondition — the probe is meaningful: the value the adapter hands back DOES serialize both credentials,
    // the stack and the config (AxiosError#toJSON), and the adapter returns it as result.error, not a throw.
    const raw = await adapter.select('/items', { limit: 5 })
    expect(raw.error).toBeInstanceOf(AxiosError)
    const rawText = JSON.stringify(raw)
    expect(rawText).toContain(API_KEY_MARKER)
    expect(rawText).toContain(BEARER_MARKER)
    expect(rawText).toContain('"stack"')
    expect(rawText).toContain('"config"')

    vi.spyOn(proto, 'assertAccess').mockImplementation(() => undefined)
    vi.spyOn(proto, 'getDataSource').mockReturnValue(adapter)
    const res = await invoke('post', '/api/data-sources/:id/select', { params: { id: 'ds-http' }, body: { table: '/items' } })
    expectFixedReadFailure(res)

    // /query on the same adapter (the raw path's manager wrapper is stubbed to the adapter's own answer: for a
    // non-SQL source the write gate would refuse the endpoint text before it reaches the adapter).
    const rawQuery = await adapter.query('/items')
    expect(JSON.stringify(rawQuery)).toContain(API_KEY_MARKER)
    vi.spyOn(proto, 'query').mockResolvedValue(rawQuery as QueryResult)
    const queried = await invoke('post', '/api/data-sources/:id/query', { params: { id: 'ds-http' }, body: { sql: '/items' } })
    expectFixedReadFailure(queried)
  })

  it('SQL adapter: a real pg DatabaseError (marker in message / detail / table, a documentation IP) is not on the wire', async () => {
    const adapter = failingPgAdapter()
    const raw = await adapter.query('SELECT 1')
    expect(raw.error).toBeInstanceOf(DatabaseError)
    expect(JSON.stringify(raw)).toContain(DOC_IP)

    vi.spyOn(proto, 'assertAccess').mockImplementation(() => undefined)
    vi.spyOn(proto, 'getDataSource').mockReturnValue(adapter)
    const queried = await invoke('post', '/api/data-sources/:id/query', {
      params: { id: 'ds-pg' },
      body: { sql: 'SELECT * FROM t LIMIT 1' },
    })
    expectFixedReadFailure(queried)

    const selected = await invoke('post', '/api/data-sources/:id/select', { params: { id: 'ds-pg' }, body: { table: 't' } })
    expectFixedReadFailure(selected)
  })

  it('the log line for a failed read is values-free: class and code tokens, the data source id, never the text', async () => {
    const adapter = await failingHttpAdapter()
    vi.spyOn(proto, 'assertAccess').mockImplementation(() => undefined)
    vi.spyOn(proto, 'getDataSource').mockReturnValue(adapter)
    await invoke('post', '/api/data-sources/:id/select', { params: { id: 'ds-http' }, body: { table: '/items' } })

    const calls = warnSpy.mock.calls.filter(([message]) => message === 'data source select failed')
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual({
      dataSourceId: 'ds-http',
      errorClass: 'AxiosError',
      code: 'ERR_BAD_RESPONSE',
      errno: undefined,
      sqlState: undefined,
      httpStatus: 502,
    })
    const logged = JSON.stringify(warnSpy.mock.calls)
    expect(logged).not.toContain('MARKER_')
    expect(logged).not.toContain(DOC_IP_HTTP)
  })

  it('a class name or a code that does not have the shape of one (an address, a sentence) is dropped from the log', async () => {
    class OddDriverError extends Error {}
    Object.defineProperty(OddDriverError, 'name', { value: `${DOC_IP} ${ARM_MARKER}` })
    vi.spyOn(proto, 'assertAccess').mockImplementation(() => undefined)
    vi.spyOn(proto, 'select').mockResolvedValue({
      data: [],
      error: Object.assign(new OddDriverError('x'), {
        code: `${DOC_IP}:5432 ${ARM_MARKER}`,
        errno: 0.5,
        sqlState: '28000',
        response: { status: `${DOC_IP}` },
      }),
    })
    const res = await invoke('post', '/api/data-sources/:id/select', { params: { id: 'ds-1' }, body: { table: 't' } })
    expectFixedReadFailure(res)
    const call = warnSpy.mock.calls.find(([message]) => message === 'data source select failed')
    expect(call?.[1]).toEqual({
      dataSourceId: 'ds-1',
      errorClass: 'unknown',
      code: undefined,
      errno: undefined,
      sqlState: '28000',
      httpStatus: undefined,
    })
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(ARM_MARKER)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(DOC_IP)
  })

  it('a successful read copies only the typed fields: no extra top-level, metadata, column or sub-source field', async () => {
    vi.spyOn(proto, 'assertAccess').mockImplementation(() => undefined)
    const rows = [{ id: 1, name: 'row-1' }]
    const result = {
      data: rows,
      metadata: {
        totalCount: 1,
        pageCount: 1,
        currentPage: 1,
        driverNotice: `MARKER_META ${DOC_IP}`,
        columns: [{ name: 'id', type: 'integer', nullable: false, sourceTable: 'MARKER_COLUMN' }],
        sources: [
          { name: 'attachments', ok: false, count: 0, error: `MARKER_SOURCE_ERROR ${DOC_IP}`, raw: 'MARKER_SOURCE_RAW' },
          { name: 'related', ok: true, count: 3 },
        ],
      },
      raw: { request: 'MARKER_TOP_LEVEL' },
      fields: [{ name: 'MARKER_FIELDS' }],
    } as unknown as QueryResult
    vi.spyOn(proto, 'select').mockResolvedValue(result)

    const res = await invoke('post', '/api/data-sources/:id/select', { params: { id: 'ds-1' }, body: { table: 't' } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        data: rows,
        metadata: {
          totalCount: 1,
          pageCount: 1,
          currentPage: 1,
          columns: [{ name: 'id', type: 'integer', nullable: false }],
          sources: [
            { name: 'attachments', ok: false, count: 0, error: SOURCE_READ_FAILURE_MESSAGE },
            { name: 'related', ok: true, count: 3 },
          ],
        },
      },
    })
    expect(wire(res)).not.toContain('MARKER_')
    expect(wire(res)).not.toContain(DOC_IP)
  })

  it('/query: rows, metadata and the unbounded-read warning travel as before', async () => {
    vi.spyOn(proto, 'assertAccess').mockImplementation(() => undefined)
    vi.spyOn(proto, 'getDataSource').mockReturnValue(fakeAdapter())
    vi.spyOn(proto, 'query').mockResolvedValue({ data: [{ a: 1 }], metadata: { totalCount: 1 } })
    const res = await invoke('post', '/api/data-sources/:id/query', { params: { id: 'ds-1' }, body: { sql: 'SELECT * FROM big' } })
    expect(res.statusCode).toBe(200)
    const body = res.body as { ok: boolean; data: unknown; warning?: string }
    expect(body.data).toEqual({ data: [{ a: 1 }], metadata: { totalCount: 1 } })
    expect(body.warning).toMatch(/no row-count limit/)
  })
})

interface ArmCase {
  name: string
  method: Method
  path: string
  params?: Record<string, string>
  body?: unknown
  code: string
  message: string
  /** Make the route's own operation fail with `error`. */
  arrange: (error: Error) => void
}

const allowAccess = () => vi.spyOn(proto, 'assertAccess').mockImplementation(() => undefined)
const loadedTarget = () => {
  vi.spyOn(proto, 'resolveCredentialRouteTarget').mockReturnValue('loaded')
  allowAccess()
  vi.spyOn(proto, 'getDataSource').mockReturnValue(fakeAdapter())
  vi.spyOn(proto, 'getScope').mockReturnValue({ ownerId: 'alice' } as never)
}

const ARM_CASES: ArmCase[] = [
  {
    name: 'GET /api/data-sources (list)',
    method: 'get', path: '/api/data-sources', code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.list,
    arrange: (e) => { vi.spyOn(proto, 'listDataSources').mockImplementation(() => { throw e }) },
  },
  {
    name: 'GET /api/data-sources/health',
    method: 'get', path: '/api/data-sources/health', code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.health,
    arrange: (e) => { vi.spyOn(proto, 'healthCheck').mockRejectedValue(e) },
  },
  {
    name: 'GET /api/data-sources/:id',
    method: 'get', path: '/api/data-sources/:id', params: { id: 'ds-1' }, code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.get,
    arrange: (e) => { vi.spyOn(proto, 'assertAccess').mockImplementation(() => { throw e }) },
  },
  {
    name: 'POST /api/data-sources (create)',
    method: 'post', path: '/api/data-sources', body: validCreateBody, code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.create,
    arrange: (e) => { vi.spyOn(proto, 'addDataSource').mockRejectedValue(e) },
  },
  {
    name: 'POST /api/data-sources/test (draft test)',
    method: 'post', path: '/api/data-sources/test', body: validCreateBody, code: 'TEST_FAILED', message: DATA_SOURCE_FAILURE_MESSAGES.draftTest,
    arrange: (e) => { vi.spyOn(proto, 'testEphemeralConnection').mockRejectedValue(e) },
  },
  {
    name: 'PUT /api/data-sources/:id (update)',
    method: 'put', path: '/api/data-sources/:id', params: { id: 'ds-1' }, body: { name: 'renamed' }, code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.update,
    arrange: (e) => {
      allowAccess()
      vi.spyOn(proto, 'getDataSource').mockReturnValue(fakeAdapter())
      vi.spyOn(proto, 'getScope').mockReturnValue({ ownerId: 'alice' } as never)
      vi.spyOn(proto, 'updateDataSource').mockRejectedValue(e)
    },
  },
  {
    name: 'PUT /api/data-sources/:id/credentials (loaded id)',
    method: 'put', path: '/api/data-sources/:id/credentials', params: { id: 'ds-1' }, body: { credentials: { password: 'new-secret' } },
    code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.credentials,
    arrange: (e) => { loadedTarget(); vi.spyOn(proto, 'updateDataSource').mockRejectedValue(e) },
  },
  {
    name: 'PUT /api/data-sources/:id/credentials (load-failed id, re-seal)',
    method: 'put', path: '/api/data-sources/:id/credentials', params: { id: 'ds-1' }, body: { credentials: { password: 'new-secret' } },
    code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.credentials,
    arrange: (e) => {
      vi.spyOn(proto, 'resolveCredentialRouteTarget').mockReturnValue('load_failed')
      vi.spyOn(proto, 'resealLoadFailedDataSource').mockRejectedValue(e)
    },
  },
  {
    name: 'DELETE /api/data-sources/:id',
    method: 'delete', path: '/api/data-sources/:id', params: { id: 'ds-1' }, code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.remove,
    arrange: (e) => {
      allowAccess()
      vi.spyOn(proto, 'getDataSource').mockReturnValue(fakeAdapter())
      vi.spyOn(proto, 'getScope').mockReturnValue({ ownerId: 'alice' } as never)
      vi.spyOn(proto, 'countExternalSystemReferences').mockResolvedValue(0)
      vi.spyOn(proto, 'removeDataSource').mockRejectedValue(e)
    },
  },
  {
    name: 'POST /api/data-sources/:id/disconnect',
    method: 'post', path: '/api/data-sources/:id/disconnect', params: { id: 'ds-1' }, code: 'INTERNAL_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.disconnect,
    arrange: (e) => {
      allowAccess()
      vi.spyOn(proto, 'getScope').mockReturnValue({ ownerId: 'alice' } as never)
      vi.spyOn(proto, 'disconnectDataSource').mockRejectedValue(e)
    },
  },
  {
    name: 'GET /api/data-sources/:id/test',
    method: 'get', path: '/api/data-sources/:id/test', params: { id: 'ds-1' }, code: 'TEST_FAILED', message: DATA_SOURCE_FAILURE_MESSAGES.test,
    arrange: (e) => { allowAccess(); vi.spyOn(proto, 'testConnection').mockRejectedValue(e) },
  },
  {
    name: 'POST /api/data-sources/:id/query',
    method: 'post', path: '/api/data-sources/:id/query', params: { id: 'ds-1' }, body: { sql: 'SELECT 1 LIMIT 1' },
    code: 'QUERY_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.query,
    arrange: (e) => {
      allowAccess()
      vi.spyOn(proto, 'getDataSource').mockReturnValue(fakeAdapter())
      vi.spyOn(proto, 'query').mockRejectedValue(e)
    },
  },
  {
    name: 'POST /api/data-sources/:id/select',
    method: 'post', path: '/api/data-sources/:id/select', params: { id: 'ds-1' }, body: { table: 't' },
    code: 'SELECT_ERROR', message: DATA_SOURCE_FAILURE_MESSAGES.select,
    arrange: (e) => { allowAccess(); vi.spyOn(proto, 'select').mockRejectedValue(e) },
  },
]

describe('every generic 500 arm answers its literal status, its code and a fixed sentence', () => {
  it.each(ARM_CASES)('$name', async (c) => {
    c.arrange(armError())
    const res = await invoke(c.method, c.path, { params: c.params, body: c.body })
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: c.code, message: c.message } })
    const text = wire(res)
    expect(text).not.toContain(ARM_MARKER)
    expect(text).not.toContain('MARKER_')
    expect(text).not.toContain(DOC_IP)
    expect(text).not.toContain('ECONNREFUSED')
    // The log line is values-free too, and it was written (the failure did not vanish).
    expect(warnSpy).toHaveBeenCalled()
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(ARM_MARKER)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(DOC_IP)
    expect(JSON.stringify(warnSpy.mock.calls)).toContain('ECONNREFUSED')
  })

  it('every case has its own sentence, and every sentence is used', () => {
    expect(new Set(ARM_CASES.map((c) => c.message))).toEqual(new Set(Object.values(DATA_SOURCE_FAILURE_MESSAGES)))
  })
})

describe('positive control: a coded gate refusal keeps its status, code and message byte-for-byte', () => {
  const CODED_ROUTES = ARM_CASES.filter((c) =>
    [
      'POST /api/data-sources (create)',
      'PUT /api/data-sources/:id (update)',
      'PUT /api/data-sources/:id/credentials (loaded id)',
      'PUT /api/data-sources/:id/credentials (load-failed id, re-seal)',
      'DELETE /api/data-sources/:id',
      'POST /api/data-sources/:id/query',
      'POST /api/data-sources/:id/select',
    ].includes(c.name),
  )

  it('covers the seven routes whose catch has a coded arm', () => {
    expect(CODED_ROUTES).toHaveLength(7)
  })

  it.each(CODED_ROUTES)('$name', async (c) => {
    const refusal = codedRefusal()
    c.arrange(refusal)
    const res = await invoke(c.method, c.path, { params: c.params, body: c.body })
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED', message: refusal.message },
    })
  })
})

describe('A3 test routes: the redacted cause string is unchanged; any other value is never serialized', () => {
  it('GET /:id/test shows the redacted cause string as it is', async () => {
    allowAccess()
    vi.spyOn(proto, 'getScope').mockReturnValue({ ownerId: 'alice' } as never)
    vi.spyOn(proto, 'testConnection').mockResolvedValue({ success: false, error: 'login failed for user ***' })
    const res = await invoke('get', '/api/data-sources/:id/test', { params: { id: 'ds-1' } })
    expect(res.statusCode).toBe(200)
    expect((res.body as { data: { error?: unknown } }).data.error).toEqual({ message: 'login failed for user ***' })
  })

  it('GET /:id/test: a non-string cause (an AxiosError) answers the fixed sentence', async () => {
    const adapter = await failingHttpAdapter()
    const raw = await adapter.select('/items')
    allowAccess()
    vi.spyOn(proto, 'getScope').mockReturnValue({ ownerId: 'alice' } as never)
    vi.spyOn(proto, 'testConnection').mockResolvedValue({ success: false, error: raw.error as never })
    const res = await invoke('get', '/api/data-sources/:id/test', { params: { id: 'ds-1' } })
    expect(res.statusCode).toBe(200)
    expect((res.body as { data: { error?: unknown } }).data.error).toEqual({ message: DATA_SOURCE_FAILURE_MESSAGES.test })
    expect(wire(res)).not.toContain('MARKER_')
    expect(wire(res)).not.toContain('"stack"')
  })

  it('POST /test: the scrubbed cause string is unchanged; a non-string cause answers the fixed sentence', async () => {
    const adapter = await failingHttpAdapter()
    const raw = await adapter.select('/items')
    vi.spyOn(proto, 'testEphemeralConnection')
      .mockResolvedValueOnce({ success: false, latency: 3, error: 'connect ECONNREFUSED ***' })
      .mockResolvedValueOnce({ success: false, latency: 3, error: raw.error as never })

    const shown = await invoke('post', '/api/data-sources/test', { body: validCreateBody })
    expect((shown.body as { data: unknown }).data).toEqual({ success: false, latency: '3ms', error: { message: 'connect ECONNREFUSED ***' } })

    const hidden = await invoke('post', '/api/data-sources/test', { body: validCreateBody })
    expect((hidden.body as { data: unknown }).data).toEqual({
      success: false,
      latency: '3ms',
      error: { message: DATA_SOURCE_FAILURE_MESSAGES.draftTest },
    })
    expect(wire(hidden)).not.toContain('MARKER_')
  })
})

describe('static: no 5xx body in the file carries caught-error text except the codedGateRefusal arms', () => {
  it('the values-free AST scanner finds only coded-refusal sinks', () => {
    const text = fs.readFileSync(ROUTE_FILE, 'utf-8')
    const { sinks, offenders } = scanResponseErrorEcho('data-sources.ts', text)
    // The scan reaches the file's 500s (it is not vacuous): the twelve generic arms plus connect / schema / tables.
    expect(sinks.filter((s) => s.status === 500).length).toBeGreaterThanOrEqual(15)
    // ... and it does see the coded arms (a dynamic status) as sinks — the filter below is not vacuous either.
    expect(offenders.length).toBeGreaterThan(0)
    const lines = text.split(/\r?\n/)
    const notCoded = offenders.filter((o) => !/\bcoded\.(?:status|code|message)\b/.test(lines[o.line - 1] ?? '') && !/res\.status\(coded\.status\)/.test(lines[o.line - 1] ?? ''))
    expect(notCoded).toEqual([])
  })
})
