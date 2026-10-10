/**
 * #6164 step 1 — GET /api/admin/security/encrypted-stores (routes/admin-routes.ts).
 *
 * The route runs the read-only encrypted-store probe on demand. What this suite pins:
 *   - platform admin only, with the same three-state gate as every sibling admin read
 *     (requireAdminRole: no user / non-admin -> 403 ADMIN_REQUIRED, RBAC lookup throwing -> 503
 *     RBAC_CHECK_FAILED) — and the gate answers BEFORE the probe touches the database: the fake
 *     pool's query is never called on a denial;
 *   - an admin gets the probe's report (counts only — no plaintext / ciphertext in the body);
 *   - a failure that stops the probe from starting answers the router's fixed 500 sentence
 *     (ADMIN_READ_FAILED) with no error text, the original going to the log only;
 *   - the gate is the FIRST handler of the route (structural backstop).
 *
 * Transport: usePinnedServer() + request(pinned.url()), never request(app) (#4154). The database is
 * a memory-level fake installed with vi.spyOn(poolManager, 'get'); fixtures are obvious fakes.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/db/pg', () => ({ pool: null }))
vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))

import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { ENCRYPTED_STORE_CATALOG, ENCRYPTED_STORE_COLUMNS_SQL } from '../../src/security/encrypted-store-probe'
import { poolManager } from '../../src/integration/db/connection-pool'
import { Logger } from '../../src/core/logger'
import {
  initAdminRoutes,
  ADMIN_READ_FAILED_CODE,
  ADMIN_READ_FAILED_MESSAGE,
} from '../../src/routes/admin-routes'

const ROUTE = '/api/admin/security/encrypted-stores'
const MARKER = 'MARKER-route-secret-3e8a51d2'
const LEAKY = 'connect ECONNREFUSED 203.0.113.9:5432 — password authentication failed for user "fixture-role"'
const LEAKY_FRAGMENTS = ['203.0.113.9', '5432', 'fixture-role', 'ECONNREFUSED', 'password authentication']

let sealed = ''
const query = vi.fn()

function fakePool() {
  return {
    query: (sql: string, params?: unknown[]) => query(sql, params),
  }
}

function buildApp(user?: { id: string }): Express {
  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  app.use('/api/admin', initAdminRoutes())
  return app
}

const pinned = usePinnedServer()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isAdmin).mockResolvedValue(true)
  // Whatever material the process runs with, this value is sealed under it — so the probe opens it.
  sealed = encryptStoredSecretValue(MARKER)
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    // Existence precheck: every catalog table exists with the columns its entries read, except
    // system_configs, which this deployment does not have (zero rows = to_regclass NULL).
    if (sql === ENCRYPTED_STORE_COLUMNS_SQL) {
      if (params?.[0] === 'system_configs') return { rows: [] }
      return { rows: [...new Set(ENCRYPTED_STORE_CATALOG.filter((e) => e.store === params?.[0]).flatMap((e) => e.columns))].map((attname) => ({ attname })) }
    }
    const entry = ENCRYPTED_STORE_CATALOG.find((candidate) => candidate.sql === sql)
    if (entry?.store === 'data_sources' && entry.field === 'config.credentials.password') {
      return { rows: [{ value: sealed }, { value: 'enc:AAAA' }, { value: `${MARKER}-plain` }] }
    }
    return { rows: [] }
  })
  vi.spyOn(poolManager, 'get').mockReturnValue(fakePool() as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/admin/security/encrypted-stores — platform-admin gate', () => {
  it('unauthenticated (no req.user) -> 403 ADMIN_REQUIRED, the probe never reaches the database', async () => {
    pinned.setApp(buildApp(undefined))
    const res = await request(pinned.url()).get(ROUTE).expect(403)
    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(query).not.toHaveBeenCalled()
  })

  it('non-admin -> 403 ADMIN_REQUIRED, the probe never reaches the database', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    pinned.setApp(buildApp({ id: 'u-nonadmin-fixture' }))
    const res = await request(pinned.url()).get(ROUTE).expect(403)
    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(JSON.stringify(res.body)).not.toContain('encrypted')
    expect(query).not.toHaveBeenCalled()
  })

  it('RBAC lookup throwing -> 503 fail-closed, the probe never reaches the database', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac lookup failed'))
    pinned.setApp(buildApp({ id: 'u-503-fixture' }))
    const res = await request(pinned.url()).get(ROUTE).expect(503)
    expect(res.body.code).toBe('RBAC_CHECK_FAILED')
    expect(query).not.toHaveBeenCalled()
  })

  it('platform admin -> 200 with a fresh, values-free report', async () => {
    pinned.setApp(buildApp({ id: 'u-admin-fixture' }))
    const res = await request(pinned.url()).get(ROUTE).expect(200)
    expect(res.body.success).toBe(true)
    const report = res.body.report
    expect(report.stores).toHaveLength(ENCRYPTED_STORE_CATALOG.length)
    expect(report.stores[0]).toMatchObject({
      store: 'data_sources', field: 'config.credentials.password', status: 'ok', rows: 3, encrypted: 2, undecryptable: 1, plaintext: 1,
    })
    expect(report.stores.find((s: { store: string }) => s.store === 'system_configs')).toMatchObject({ status: 'table_missing' })
    expect(report.totals).toMatchObject({ encrypted: 2, undecryptable: 1, plaintext: 1, missing: 1 })
    // 6 per-table prechecks + every catalog SELECT except system_configs' (absent: never issued)
    expect(query).toHaveBeenCalledTimes(6 + ENCRYPTED_STORE_CATALOG.length - 1)
    expect(query.mock.calls.map((c) => c[0])).not.toContain(ENCRYPTED_STORE_CATALOG.find((e) => e.store === 'system_configs')?.sql)
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('MARKER')
    expect(serialized).not.toContain(sealed)
    expect(serialized).not.toContain(sealed.slice(4, 20))
  })

  it('the gate is the FIRST handler on the route', async () => {
    type Layer = { route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }
    const layer = ((initAdminRoutes() as unknown as { stack: Layer[] }).stack).find(
      (l) => l.route?.path === '/security/encrypted-stores' && l.route.methods?.get,
    )
    expect(layer?.route?.stack.length).toBe(2)
    vi.mocked(isAdmin).mockResolvedValue(false)
    const res = { statusCode: 200, body: null as unknown, status(code: number) { this.statusCode = code; return this }, json(body: unknown) { this.body = body; return this } }
    const next = vi.fn()
    await layer!.route!.stack[0].handle({ user: { id: 'u-structural' }, ip: '127.0.0.1', path: '/security/encrypted-stores', params: {}, query: {}, headers: {} }, res, next)
    expect(res.statusCode).toBe(403)
    expect((res.body as { code?: string }).code).toBe('ADMIN_REQUIRED')
    expect(next).not.toHaveBeenCalled()
  })
})

describe('GET /api/admin/security/encrypted-stores — failure envelope', () => {
  it('a failure before the probe can start -> 500 ADMIN_READ_FAILED with the fixed sentence; the text goes to the log only', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    vi.spyOn(poolManager, 'get').mockImplementation(() => {
      throw Object.assign(new Error(LEAKY), { code: '28P01' })
    })
    pinned.setApp(buildApp({ id: 'u-admin-fixture' }))
    const res = await request(pinned.url()).get(ROUTE)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ success: false, code: ADMIN_READ_FAILED_CODE, error: ADMIN_READ_FAILED_MESSAGE })
    const serialized = JSON.stringify(res.body)
    for (const fragment of LEAKY_FRAGMENTS) expect(serialized).not.toContain(fragment)
    expect(errorLog.mock.calls.some((call) => (call[1] as { message?: string } | undefined)?.message === LEAKY)).toBe(true)
  })

  it('a store that cannot be read is NOT a 500: it is reported inside the 200 report', async () => {
    query.mockImplementation(async () => {
      throw Object.assign(new Error(LEAKY), { code: '28P01' })
    })
    pinned.setApp(buildApp({ id: 'u-admin-fixture' }))
    const res = await request(pinned.url()).get(ROUTE).expect(200)
    expect(res.body.report.stores.every((s: { status: string; sqlState?: string }) => s.status === 'read_failed' && s.sqlState === '28P01')).toBe(true)
    const serialized = JSON.stringify(res.body)
    for (const fragment of LEAKY_FRAGMENTS) expect(serialized).not.toContain(fragment)
  })
})

describe('GET /api/admin/security/encrypted-stores — single-flight', () => {
  it('two concurrent admin reads share ONE probe run and get the same report; a later read runs again', async () => {
    pinned.setApp(buildApp({ id: 'u-admin-fixture' }))
    const ONE_RUN = 6 + ENCRYPTED_STORE_CATALOG.length - 1 // prechecks + every SELECT but system_configs'
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const answer = query.getMockImplementation() as (sql: string, params?: unknown[]) => Promise<unknown>
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      await gate
      return answer(sql, params)
    })
    const poolGet = vi.mocked(poolManager.get)

    const first = request(pinned.url()).get(ROUTE).then((r) => r)
    const second = request(pinned.url()).get(ROUTE).then((r) => r)
    // Both requests are past the gate and inside the handler before the (blocked) run is released.
    await vi.waitFor(() => expect(vi.mocked(isAdmin)).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const [a, b] = await Promise.all([first, second])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(b.body.report).toEqual(a.body.report)
    expect(poolGet).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(ONE_RUN)

    // Nothing is cached once the run settled: the next read is a fresh run.
    await request(pinned.url()).get(ROUTE).expect(200)
    expect(poolGet).toHaveBeenCalledTimes(2)
    expect(query).toHaveBeenCalledTimes(2 * ONE_RUN)
  })
})
