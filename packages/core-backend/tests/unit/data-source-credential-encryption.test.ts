import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The credential route writes an audit row; in these in-memory tests it must be a no-op.
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { dataSourcesRouter } from '../../src/routes/data-sources'

// Stateful Kysely stand-in: insert captures the persisted record (with its
// encrypted-at-rest config), select returns active rows for loadFromDatabase.
function statefulFakeDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const insertBuilder = () => {
    let pending: Record<string, unknown> = {}
    const b = {
      values: (v: Record<string, unknown>) => { pending = v; return b },
      onConflict: () => b,
      execute: async () => { rows.set(pending.id as string, { ...pending }); return [] },
    }
    return b
  }
  const selectBuilder = () => {
    const b = {
      selectAll: () => b,
      where: () => b,
      execute: async () => [...rows.values()].filter((r) => r.is_active === true && r.deleted_at == null),
    }
    return b
  }
  return {
    rows,
    db: {
      selectFrom: () => selectBuilder(),
      insertInto: () => insertBuilder(),
      updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => [] }) }) }),
      deleteFrom: () => ({ where: () => ({ execute: async () => [] }) }),
    },
  }
}

function dbRow(id: string, credentials: Record<string, unknown>) {
  return {
    id,
    name: id,
    type: 'postgres',
    description: null,
    config: { connection: {}, credentials },
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: 'a',
    workspace_id: null,
    is_active: true,
    auto_connect: false,
    metadata: null,
    tags: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  }
}

function pgConfigWithCreds(id: string): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'x' },
    // trailing space in password is significant and must survive the round-trip
    credentials: { username: 'u', password: 'p@ss ', apiKey: 'key-123', token: 'tok-xyz' },
    options: { autoConnect: false },
  }
}

describe('A1 credential encryption at rest', () => {
  it('encrypts secret fields at rest and decrypts on reload (username plaintext, no trim)', async () => {
    const { db, rows } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource(pgConfigWithCreds('ds1'), { ownerId: 'a' })

    // at rest: secrets are enc:, the identifier is not
    const stored = (rows.get('ds1') as { config: { credentials: Record<string, string> } }).config.credentials
    expect(stored.password).toMatch(/^enc:/)
    expect(stored.apiKey).toMatch(/^enc:/)
    expect(stored.token).toMatch(/^enc:/)
    expect(stored.username).toBe('u')

    // reload (fresh manager) decrypts back to the exact plaintext
    const m2 = new DataSourceManager()
    await m2.initialize(db as never)
    const creds = m2.getDataSource('ds1').getConfig().credentials as Record<string, string>
    expect(creds.password).toBe('p@ss ') // exact, incl. trailing space (no trim)
    expect(creds.apiKey).toBe('key-123')
    expect(creds.token).toBe('tok-xyz')
    expect(creds.username).toBe('u')
  })

  it('passes legacy plaintext credentials through unchanged (lazy migration)', async () => {
    const { db, rows } = statefulFakeDb()
    rows.set('legacy', dbRow('legacy', { username: 'u', password: 'plain-pw' }))
    const m = new DataSourceManager()
    await m.initialize(db as never)
    const creds = m.getDataSource('legacy').getConfig().credentials as Record<string, string>
    expect(creds.password).toBe('plain-pw')
  })

  it('fails loud (skips the source on load) when an encrypted credential cannot be decrypted', async () => {
    const { db, rows } = statefulFakeDb()
    rows.set('ok', dbRow('ok', { password: 'plain' }))
    rows.set('corrupt', dbRow('corrupt', { password: 'enc:invalid' }))
    const m = new DataSourceManager()
    await m.initialize(db as never)
    expect(() => m.getDataSource('ok')).not.toThrow() // valid row still loads
    expect(() => m.getDataSource('corrupt')).toThrow(/not found/) // undecryptable row skipped
  })

  it('round-trips a secret that literally starts with the enc: prefix', async () => {
    const { db, rows } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource(
      {
        id: 'pfx',
        name: 'pfx',
        type: 'postgres',
        connection: { host: 'localhost', port: 5432, database: 'x' },
        credentials: { username: 'u', password: 'enc:literal-secret', apiKey: 'enc:also', token: 'enc:too' },
        options: { autoConnect: false },
      },
      { ownerId: 'a' },
    )

    // must be genuinely encrypted, NOT passed through because it looked encrypted
    const stored = (rows.get('pfx') as { config: { credentials: Record<string, string> } }).config.credentials
    expect(stored.password).toMatch(/^enc:/)
    expect(stored.password).not.toBe('enc:literal-secret')

    const m2 = new DataSourceManager()
    await m2.initialize(db as never)
    const creds = m2.getDataSource('pfx').getConfig().credentials as Record<string, string>
    expect(creds.password).toBe('enc:literal-secret')
    expect(creds.apiKey).toBe('enc:also')
    expect(creds.token).toBe('enc:too')
  })
})

// HTTPAdapter.connect() sends `credentials.bearerToken` as `Authorization: Bearer …`, so it is a secret
// like password / apiKey / token and is sealed at rest the same way.
describe('bearerToken is encrypted at rest (HTTP sources)', () => {
  const BEARER = 'MARKER_BEARER_AT_REST_6q1 '
  const LEGACY_BEARER = 'MARKER_BEARER_LEGACY_PLAIN_3v8'

  function httpConfig(id: string, bearerToken: string): DataSourceConfig {
    return {
      id,
      name: id,
      type: 'http',
      connection: { baseURL: 'http://203.0.113.9' },
      credentials: { bearerToken },
      options: { autoConnect: false },
    }
  }

  function storedCredentials(rows: Map<string, Record<string, unknown>>, id: string): Record<string, string> {
    return (rows.get(id) as { config: { credentials: Record<string, string> } }).config.credentials
  }

  async function authorizationAfterConnect(manager: DataSourceManager, id: string): Promise<unknown> {
    const adapter = manager.getDataSource(id)
    await adapter.connect()
    const client = (adapter as unknown as { client: { defaults: { headers: { common: Record<string, unknown> } } } }).client
    return client.defaults.headers.common.Authorization
  }

  it('a new write stores ciphertext, and a reload hands the adapter the exact plaintext', async () => {
    const { db, rows } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource(httpConfig('http-new', BEARER), { ownerId: 'a' })

    const stored = storedCredentials(rows, 'http-new')
    expect(stored.bearerToken).toMatch(/^enc:/)
    expect(JSON.stringify(rows.get('http-new'))).not.toContain(BEARER.trim())

    const m2 = new DataSourceManager()
    await m2.initialize(db as never)
    expect((m2.getDataSource('http-new').getConfig().credentials as Record<string, string>).bearerToken).toBe(BEARER) // no trim
    expect(await authorizationAfterConnect(m2, 'http-new')).toBe(`Bearer ${BEARER}`)
  })

  it('a legacy plaintext bearerToken row still loads and works, and is re-encrypted on the next update', async () => {
    const { db, rows } = statefulFakeDb()
    rows.set('http-legacy', { ...dbRow('http-legacy', { bearerToken: LEGACY_BEARER }), type: 'http', config: { connection: { baseURL: 'http://203.0.113.9' }, credentials: { bearerToken: LEGACY_BEARER }, options: { autoConnect: false } } })

    const m1 = new DataSourceManager()
    await m1.initialize(db as never)
    expect(m1.getLoadState('http-legacy')).toBe('loaded')
    expect((m1.getDataSource('http-legacy').getConfig().credentials as Record<string, string>).bearerToken).toBe(LEGACY_BEARER)
    expect(await authorizationAfterConnect(m1, 'http-legacy')).toBe(`Bearer ${LEGACY_BEARER}`)
    // Loading alone writes nothing: the row is still the legacy plaintext.
    expect(storedCredentials(rows, 'http-legacy').bearerToken).toBe(LEGACY_BEARER)

    // Any update persists the (preserved) credential through encryptCredentials.
    const m2 = new DataSourceManager({ db: db as never })
    await m2.initialize(db as never)
    const current = m2.getDataSource('http-legacy').getConfig()
    await m2.updateDataSource('http-legacy', { ...current, name: 'renamed' }, { ownerId: 'a' })
    expect(storedCredentials(rows, 'http-legacy').bearerToken).toMatch(/^enc:/)
    expect(JSON.stringify(rows.get('http-legacy'))).not.toContain(LEGACY_BEARER)

    const m3 = new DataSourceManager()
    await m3.initialize(db as never)
    expect((m3.getDataSource('http-legacy').getConfig().credentials as Record<string, string>).bearerToken).toBe(LEGACY_BEARER)
  })

  describe('API responses never return the bearer token, plaintext or sealed', () => {
    type StubResponse = Response & { statusCode: number; body: unknown; headersSent: boolean }
    const proto = DataSourceManager.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    const ROUTED_METHODS = [
      'assertAccess', 'getDataSource', 'getScope', 'listDataSources', 'listLoadFailedDataSources',
      'countExternalSystemReferencesByIds', 'resolveCredentialRouteTarget', 'updateDataSource',
    ] as const

    afterEach(() => {
      vi.restoreAllMocks()
    })

    /** Route the router's singleton manager to `target` (a real manager on the fake store). */
    function routeManagerTo(target: DataSourceManager): void {
      for (const name of ROUTED_METHODS) {
        const original = proto[name]
        vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
          return original.apply(target, args)
        })
      }
    }

    async function invoke(method: 'get' | 'put', routePath: string, params: Record<string, string> = {}, body: unknown = {}): Promise<StubResponse> {
      const layer = dataSourcesRouter().stack.find(
        (entry) => entry.route?.path === routePath && (entry.route as { methods?: Record<string, boolean> }).methods?.[method],
      )
      if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${routePath} not found`)
      const req = {
        method: method.toUpperCase(), url: routePath, headers: {}, query: {}, params, body,
        user: { id: 'a', role: 'admin' },
        authenticatedTenantId: 'tenant-bearer',
      } as unknown as Request
      const res = {
        statusCode: 200,
        body: undefined as unknown,
        headersSent: false,
        status(code: number) { this.statusCode = code; return this },
        json(payload: unknown) { this.body = payload; this.headersSent = true; return this },
      } as unknown as StubResponse
      for (const routeLayer of layer.route.stack) {
        if (res.headersSent) break
        await new Promise<void>((resolve, reject) => {
          try {
            const out = routeLayer.handle(req, res, (error?: unknown) => (error ? reject(error) : resolve()))
            if (out && typeof (out as Promise<unknown>).then === 'function') Promise.resolve(out).then(() => resolve()).catch(reject)
          } catch (error) {
            reject(error)
          }
        })
      }
      return res
    }

    it('list, detail and credential rotation bodies carry neither the value nor its ciphertext', async () => {
      const { db, rows } = statefulFakeDb()
      const seed = new DataSourceManager({ db: db as never })
      await seed.addDataSource(httpConfig('http-api', BEARER), { ownerId: 'a' })
      const sealed = storedCredentials(rows, 'http-api').bearerToken
      expect(sealed).toMatch(/^enc:/)

      const live = new DataSourceManager({ db: db as never })
      await live.initialize(db as never)
      routeManagerTo(live)

      const list = await invoke('get', '/api/data-sources')
      const detail = await invoke('get', '/api/data-sources/:id', { id: 'http-api' })
      const rotate = await invoke('put', '/api/data-sources/:id/credentials', { id: 'http-api' }, { credentials: { apiKey: 'MARKER_ROTATED_API_KEY_8w4' } })
      expect([list.statusCode, detail.statusCode, rotate.statusCode]).toEqual([200, 200, 200])
      expect(JSON.stringify(list.body)).toContain('http-api')
      expect((detail.body as { data: { hasCredentials: boolean } }).data.hasCredentials).toBe(true)
      for (const res of [list, detail, rotate]) {
        const wire = JSON.stringify(res.body)
        for (const needle of [BEARER.trim(), sealed, 'enc:', 'bearerToken', 'MARKER_']) expect(wire).not.toContain(needle)
      }
      // The rotation re-persisted the preserved bearer token sealed, beside the new sealed apiKey.
      const afterRotate = storedCredentials(rows, 'http-api')
      expect(afterRotate.bearerToken).toMatch(/^enc:/)
      expect(afterRotate.apiKey).toMatch(/^enc:/)
    })
  })
})
