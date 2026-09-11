/**
 * #5621 — `connection.password` must never be accepted, stored bare, or echoed.
 *
 * THE GAP (four surfaces, three answers, one field):
 *   - routes/data-sources.ts ConnectionConfigSchema (free `z.record`) ACCEPTED connection.password;
 *   - DataSourceManager.configToRecord encrypts `credentials` only -> it landed in the row PLAINTEXT;
 *   - routes/data-sources.ts sanitizeConfig destructured `credentials` only -> `GET /:id` (and the
 *     update/rotate/delete AUDIT rows) echoed it back;
 *   - BaseAdapter.redactSecrets nevertheless treated connection.password as a secret.
 * The stock UI never triggers it (apps/web/src/data-sources/buildPayload.ts puts the password in
 * `credentials`); a direct API call did.
 *
 * WHAT THIS FILE PINS
 *   A. WRITE FAIL-CLOSED — create / update / draft-test refuse a secret-shaped key under
 *      `connection` with a coded 400, and NOTHING is persisted (insert count unchanged).
 *   B. READ STRIP — a LEGACY row that already holds a plaintext connection secret (inserted
 *      straight into the table, as production rows were) is never echoed by GET /:id, by the
 *      /:id/test cause, or by the audit rows — while the STORED row stays untouched (removing it
 *      is the migration ticket, deliberately out of this cut).
 *   C. POSITIVE PATH — the supported shape (secret under `credentials`) still creates 201 and
 *      reports `hasCredentials: true`.
 *   D. SINGLE DEFINITION — schema refusal, read strip and redactSecrets all consult the one word
 *      list in data-adapters/data-source-secret-keys.ts, and that list is narrow enough not to eat
 *      legitimate connection keys. Also pinned here: the value list is LONGEST-FIRST (a short
 *      secret that is a prefix of a longer one must not cut it up), and the known over-inclusion
 *      (`passThroughMode` / `pass_through` / `byPass` hit because tokenisation precedes the
 *      whole-token test) is nailed down in BOTH directions so nobody can restate it as "passthrough
 *      and bypass never hit".
 *
 * Harness follows tests/unit/data-source-visibility-authority-matrix.test.ts: mocked audit + rbac
 * deps, a fake Kysely, fake adapters (no dialing), and ONE pinned listener for the file (the repo
 * bans `request(app)` — supertest-app-mode-tripwire).
 */
import express from 'express'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => false),
  userHasPermission: vi.fn(async () => false),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))
vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn(async () => true),
}))

import { BaseDataAdapter } from '../../src/data-adapters/BaseAdapter'
import type {
  ColumnInfo,
  DataSourceConfig,
  DbValue,
  QueryResult,
  SchemaInfo,
  TableInfo,
  Transaction,
} from '../../src/data-adapters/BaseAdapter'
import {
  collectSecretConfigValues,
  DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE,
  isSecretConfigKey,
  secretKeyValueTextPattern,
  stripSecretConfigKeys,
} from '../../src/data-adapters/data-source-secret-keys'
import {
  dataSourcesRouter,
  getDataSourceManager,
  initializeDataSourceManager,
} from '../../src/routes/data-sources'
import { auditLog } from '../../src/audit/audit'
import { usePinnedServer } from '../utils/pinned-server'

const auditMock = vi.mocked(auditLog)

// ── poison values: a hit anywhere in a response body / audit row means the secret escaped ─────
const POISON = {
  connectionPassword: 'POISON-conn-pw-4b1d9e07c352',
  legacyPassword: 'POISON-legacy-pw-8fa3c61d7b20',
  legacyAuthorization: 'POISON-legacy-authz-2c7e4b90da16',
  failPassword: 'POISON-fail-pw-6d0a37f9c481',
  credentialPassword: 'POISON-cred-pw-05e9b83a7fc4',
}
const POISON_VALUES = Object.values(POISON)

function expectNoPoison(value: unknown): void {
  const text = JSON.stringify(value)
  for (const poison of POISON_VALUES) {
    expect(text).not.toContain(poison)
  }
}

// ── fake db: captures every data_sources upsert, serves the two pre-seeded LEGACY rows ─────────
const persisted = new Map<string, Record<string, unknown>>()
let insertCalls = 0

function legacyRow(
  id: string,
  type: string,
  connection: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    name: id,
    type,
    description: null,
    // Exactly what a pre-fix API call produced: the secret sits in plaintext under `connection`,
    // `credentials` holds the username only.
    config: { connection, credentials: { username: 'legacy-user' }, options: { autoConnect: false } },
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: 'u_dscs_owner',
    workspace_id: null,
    tenant_id: 'tenant-dscs',
    scope_kind: 'private',
    is_active: true,
    auto_connect: false,
    metadata: null,
    tags: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  }
}

const LEGACY_ID = 'dscs-legacy'
const LEGACY_FAIL_ID = 'dscs-legacy-fail'

function fakeDb() {
  return {
    selectFrom: (table: string) => {
      if (table === 'integration_external_systems') {
        const b = { select: () => b, where: () => b, execute: async () => [{ count: 0 }] }
        return b
      }
      const b = {
        selectAll: () => b,
        where: () => b,
        execute: async () => [
          legacyRow(LEGACY_ID, 'postgres', {
            host: 'legacy.internal.example',
            port: 5432,
            database: 'plm',
            password: POISON.legacyPassword,
            headers: { Authorization: POISON.legacyAuthorization },
          }),
          legacyRow(LEGACY_FAIL_ID, 'faildb', {
            host: 'legacy-fail.internal.example',
            password: POISON.failPassword,
          }),
        ],
      }
      return b
    },
    insertInto: () => {
      let pending: Record<string, unknown> = {}
      const b = {
        values: (v: Record<string, unknown>) => { pending = v; return b },
        onConflict: () => b,
        execute: async () => {
          insertCalls += 1
          persisted.set(String(pending.id), { ...pending })
          return []
        },
      }
      return b
    },
    updateTable: () => {
      const b = { set: () => b, where: () => b, execute: async () => [] }
      return b
    },
    deleteFrom: () => {
      const b = { where: () => b, execute: async () => [] }
      return b
    },
  }
}

// ── fake adapters (no sockets) ─────────────────────────────────────────────────────────────────
abstract class FakeBase extends BaseDataAdapter {
  async query<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async select<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async insert<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async update<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async delete<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async getSchema(): Promise<SchemaInfo> { return { tables: [] } }
  async getTableInfo(): Promise<TableInfo> { return { name: 't', columns: [] } }
  async getColumns(): Promise<ColumnInfo[]> { return [] }
  async tableExists(): Promise<boolean> { return false }
  async beginTransaction(): Promise<Transaction> { return {} as Transaction }
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async inTransaction<R = unknown>(_t: Transaction, cb: () => Promise<R>): Promise<R> { return cb() }
  async *stream<T = Record<string, DbValue>>(): AsyncIterableIterator<T> { /* no rows */ }
}

let dialAttempts = 0
class OkAdapter extends FakeBase {
  async connect(): Promise<void> { dialAttempts += 1; this.connected = true; await this.onConnect() }
  async disconnect(): Promise<void> { this.connected = false; await this.onDisconnect() }
  isConnected(): boolean { return this.connected }
  async testConnection(): Promise<boolean> { return true }
}

/**
 * Models the real leak shape on the /:id/test surface: a driver diagnostic that embeds the very
 * secret stored under `connection`. The secret is embedded BARE (inside a connection URL, as pg
 * does) — NOT as `password=...` — so only the VALUE list can scrub it; the `key=value` text rule
 * cannot see it. That keeps this case honest evidence that redactSecrets reads connection values
 * through the shared word list.
 */
class FailAdapter extends FakeBase {
  async connect(): Promise<void> {
    dialAttempts += 1
    const secret = String((this.config.connection as Record<string, unknown>).password ?? '')
    const err = new Error(
      `connect ECONNREFUSED postgres://legacy-user:${secret}@legacy-fail.internal.example:5432/plm`,
    )
    await this.onError(err)
    throw err
  }
  async disconnect(): Promise<void> { this.connected = false }
  isConnected(): boolean { return false }
  async testConnection(): Promise<boolean> { return false }
}

// ── app harness ────────────────────────────────────────────────────────────────────────────────
const DS_PERMS = ['data_sources:read', 'data_sources:write', 'data_sources:execute']
const OWNER = { id: 'u_dscs_owner', roles: ['member'], permissions: DS_PERMS }

let currentUser: Record<string, unknown> | undefined
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = currentUser as never
  req.authenticatedTenantId = currentUser ? 'tenant-dscs' : undefined
  next()
})
app.use(dataSourcesRouter())

const pinned = usePinnedServer()

function as(user: Record<string, unknown> | undefined) {
  currentUser = user
  pinned.setApp(app)
  return request(pinned.url())
}

function createPayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'db.internal.example', port: 5432, database: 'plm' },
    options: { autoConnect: false },
    ...overrides,
  }
}

beforeAll(async () => {
  // Register BEFORE initialize so the pre-seeded legacy rows load onto fakes, never a real driver.
  const manager = getDataSourceManager()
  manager.registerAdapterType('postgres', OkAdapter as never)
  manager.registerAdapterType('faildb', FailAdapter as never)
  await initializeDataSourceManager(fakeDb() as never)
})

beforeEach(() => {
  auditMock.mockClear()
  insertCalls = 0
  dialAttempts = 0
})

// ── A. WRITE FAIL-CLOSED ───────────────────────────────────────────────────────────────────────

describe('#5621 A — write entry refuses secrets under connection (fail-closed, zero persistence)', () => {
  it('POST /api/data-sources with connection.password => coded 400, nothing persisted, nothing registered', async () => {
    const id = 'dscs-refuse-create'
    const before = insertCalls
    const res = await as(OWNER)
      .post('/api/data-sources')
      .send(createPayload(id, {
        connection: { host: 'db.internal.example', port: 5432, database: 'plm', password: POISON.connectionPassword },
      }))

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE)
    // Names the offending KEY PATH, never the value, and points at `credentials`.
    expect(res.body.error.message).toContain('connection.password')
    expect(res.body.error.message).toContain('credentials')
    expectNoPoison(res.body)

    // ZERO LANDING: no upsert ran, and the id is not registered (uniform 404 on read-back).
    expect(insertCalls).toBe(before)
    expect(persisted.has(id)).toBe(false)
    const readBack = await as(OWNER).get(`/api/data-sources/${id}`)
    expect(readBack.status).toBe(404)
  })

  it.each([
    ['password', { password: 'x' }],
    ['dbPassword (camel prefix)', { dbPassword: 'x' }],
    ['API_KEY (underscore + case)', { API_KEY: 'x' }],
    ['accessToken', { accessToken: 'x' }],
    ['clientSecret', { clientSecret: 'x' }],
    ['pass (bare token)', { pass: 'x' }],
    ['pwd', { pwd: 'x' }],
    ['sslPassphrase', { sslPassphrase: 'x' }],
    // Pinned CURRENT behaviour (known over-inclusion, see the module header): tokenisation runs
    // before the `pass` whole-token test, so these camel/underscore spellings hit and 400.
    ['passThroughMode (camel split -> [pass, through, mode])', { passThroughMode: 'direct' }],
    ['pass_through (underscore split -> [pass, through])', { pass_through: 'yes' }],
  ])('POST create refuses connection.%s', async (_label, extra) => {
    const res = await as(OWNER)
      .post('/api/data-sources')
      .send(createPayload('dscs-refuse-variant', {
        connection: { host: 'db.internal.example', database: 'plm', ...extra },
      }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE)
    expect(persisted.has('dscs-refuse-variant')).toBe(false)
  })

  it('NARROWNESS CONTROL: legitimate connection keys still create 201 (the guard is not a blanket ban)', async () => {
    const id = 'dscs-legit-keys'
    const res = await as(OWNER)
      .post('/api/data-sources')
      .send(createPayload(id, {
        connection: {
          host: 'db.internal.example',
          port: 1433,
          database: 'plm',
          encrypt: true,
          trustServerCertificate: false,
          strictOffsetOrdering: true,
          // must NOT trip the `pass` whole-token rule
          passthroughMode: 'direct',
        },
      }))
    expect(res.status).toBe(201)
    expect(res.body.data.connection).toMatchObject({
      host: 'db.internal.example',
      encrypt: true,
      trustServerCertificate: false,
      strictOffsetOrdering: true,
      passthroughMode: 'direct',
    })
  })

  it('NESTED shape (connection.headers.Authorization) => the SAME coded 400, not a generic VALIDATION_ERROR', async () => {
    const res = await as(OWNER)
      .post('/api/data-sources')
      .send(createPayload('dscs-refuse-nested', {
        type: 'http',
        connection: { baseURL: 'https://api.example', headers: { Authorization: 'Bearer POISON-nested' } },
      }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE)
    expect(res.body.error.message).toContain('connection.headers.Authorization')
    expect(JSON.stringify(res.body)).not.toContain('Bearer POISON-nested')
  })

  it('a caller-controlled KEY that is not identifier-shaped is reported as <key>, never echoed', async () => {
    const res = await as(OWNER)
      .post('/api/data-sources')
      .send(createPayload('dscs-refuse-weirdkey', {
        connection: { host: 'db.internal.example', 'password=hunter2': 'x' },
      }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE)
    expect(res.body.error.message).toContain('connection.<key>')
    expect(res.body.error.message).not.toContain('hunter2')
  })

  it('PUT /api/data-sources/:id with connection.password => coded 400, stored connection untouched', async () => {
    const res = await as(OWNER)
      .put(`/api/data-sources/${LEGACY_ID}`)
      .send({ name: 'renamed', connection: { host: 'new.internal.example', password: POISON.connectionPassword } })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE)
    expect(insertCalls).toBe(0)
    expectNoPoison(res.body)

    const after = await as(OWNER).get(`/api/data-sources/${LEGACY_ID}`)
    expect(after.status).toBe(200)
    expect(after.body.data.name).toBe(LEGACY_ID) // the rename never happened
    expect(after.body.data.connection.host).toBe('legacy.internal.example')
  })

  it('POST /api/data-sources/test with connection.password => coded 400 BEFORE any dial-out', async () => {
    const res = await as(OWNER)
      .post('/api/data-sources/test')
      .send(createPayload('dscs-refuse-drafttest', {
        connection: { host: 'db.internal.example', database: 'plm', password: POISON.connectionPassword },
      }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE)
    expect(dialAttempts).toBe(0)
    expectNoPoison(res.body)
  })

  it('ORDER: rbacGuard still answers first — an anonymous caller gets 401, not the refusal', async () => {
    const res = await as(undefined)
      .post('/api/data-sources')
      .send(createPayload('dscs-anon', {
        connection: { host: 'h', password: POISON.connectionPassword },
      }))
    expect(res.status).toBe(401)
  })
})

// ── B. READ STRIP (legacy rows) ────────────────────────────────────────────────────────────────

describe('#5621 B — a legacy row with a plaintext connection secret is never echoed', () => {
  it('GET /api/data-sources/:id strips connection.password and the nested Authorization header', async () => {
    const res = await as(OWNER).get(`/api/data-sources/${LEGACY_ID}`)
    expect(res.status).toBe(200)
    // Non-secret connection keys survive — this is a strip, not a blanket removal of `connection`.
    expect(res.body.data.connection.host).toBe('legacy.internal.example')
    expect(res.body.data.connection.database).toBe('plm')
    expect(res.body.data.connection.password).toBeUndefined()
    expect(res.body.data.connection.headers?.Authorization).toBeUndefined()
    expect(res.body.data.hasCredentials).toBe(true) // the presence flag survives the strip
    expectNoPoison(res.body)
  })

  it('GET /api/data-sources/:id/test never echoes the stored connection secret in the failure cause', async () => {
    const res = await as(OWNER).get(`/api/data-sources/${LEGACY_FAIL_ID}/test`)
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(false)
    expect(res.body.data.error.message).toContain('ECONNREFUSED') // the real cause is still explainable
    expect(res.body.data.error.message).toContain('***')
    expectNoPoison(res.body)
  })

  it('the AUDIT rows of an unrelated update carry no legacy secret — while the STORED row keeps it (migration ticket)', async () => {
    const res = await as(OWNER)
      .put(`/api/data-sources/${LEGACY_ID}`)
      .send({ connection: { host: 'moved.internal.example' } })
    expect(res.status).toBe(200)
    expect(res.body.data.connection.host).toBe('moved.internal.example')
    expectNoPoison(res.body)

    const updates = auditMock.mock.calls.map(([o]) => o).filter((o) => o.action === 'update')
    expect(updates.length).toBeGreaterThan(0)
    expectNoPoison(updates) // before/after go through sanitizeConfig

    // SCOPE PIN (deliberate, documented): this cut changes the ECHO only. The persisted row still
    // carries the legacy plaintext — the inventory + removal migration is the follow-up ticket.
    const stored = persisted.get(LEGACY_ID) as { config: { connection: Record<string, unknown> } }
    expect(stored.config.connection.password).toBe(POISON.legacyPassword)
  })
})

// ── C. POSITIVE PATH ───────────────────────────────────────────────────────────────────────────

describe('#5621 C — the supported shape is unaffected', () => {
  it('POST with the secret under credentials => 201, hasCredentials:true, credentials never returned', async () => {
    const id = 'dscs-happy'
    const res = await as(OWNER)
      .post('/api/data-sources')
      .send(createPayload(id, {
        credentials: { username: 'svc_reader', password: POISON.credentialPassword },
      }))
    expect(res.status).toBe(201)
    expect(res.body.data.hasCredentials).toBe(true)
    expect(res.body.data.credentials).toBeUndefined()
    expect(res.body.data.connection).toMatchObject({ host: 'db.internal.example', database: 'plm' })
    expectNoPoison(res.body)

    const got = await as(OWNER).get(`/api/data-sources/${id}`)
    expect(got.status).toBe(200)
    expect(got.body.data.hasCredentials).toBe(true)
    expectNoPoison(got.body)

    // and it is encrypted at rest, not plaintext (the `credentials` half already worked — pinned
    // here so the refusal can never be "fixed" by moving secrets back into `connection`)
    const stored = persisted.get(id) as { config: { credentials: Record<string, string> } }
    expect(stored.config.credentials.password).toMatch(/^enc:/)
  })

  it('POST /api/data-sources/test with credentials only still dials and reports success', async () => {
    const res = await as(OWNER)
      .post('/api/data-sources/test')
      .send(createPayload('dscs-happy-test', {
        credentials: { username: 'svc_reader', password: POISON.credentialPassword },
      }))
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(true)
    expect(dialAttempts).toBeGreaterThan(0)
    expectNoPoison(res.body)
  })
})

// ── D. SINGLE DEFINITION ───────────────────────────────────────────────────────────────────────

describe('#5621 D — one word list feeds the schema refusal, the read strip and redactSecrets', () => {
  it.each([
    'password', 'Password', 'PASSWORD', 'passwd', 'pwd', 'pass', 'db_pass', 'dbPassword',
    'apiKey', 'api_key', 'API-KEY', 'accessKey', 'privateKey', 'token', 'accessToken',
    'refreshToken', 'secret', 'clientSecret', 'credential', 'credentials', 'authorization',
    'sslPassphrase',
  ])('isSecretConfigKey("%s") === true', (key) => {
    expect(isSecretConfigKey(key)).toBe(true)
  })

  // Tokenisation happens BEFORE the whole-token comparison, so these camel/underscore spellings
  // DO hit while the unsplit lower-case ones below do not. Pinned as the CURRENT behaviour and as
  // the counterexample to "passthrough / bypass never hit": if a real connection key ever looks
  // like this, the fix is a word-list exception, never a looser rule (looser would pass `passHash`).
  it.each(['passThroughMode', 'pass_through', 'passThrough', 'byPass'])(
    'isSecretConfigKey("%s") === true (camel/underscore over-inclusion, pinned)',
    (key) => {
      expect(isSecretConfigKey(key)).toBe(true)
    },
  )

  it.each([
    'host', 'server', 'port', 'database', 'user', 'username', 'baseURL', 'url', 'uri', 'ssl',
    'encrypt', 'trustServerCertificate', 'tlsMinVersion', 'tlsCiphers', 'legacyTls',
    'connectionTimeoutMs', 'requestTimeoutMs', 'instanceName', 'strictOffsetOrdering',
    'passthrough', 'bypass', 'keyspace', 'primaryKeyColumn',
  ])('isSecretConfigKey("%s") === false (narrowness)', (key) => {
    expect(isSecretConfigKey(key)).toBe(false)
  })

  it('stripSecretConfigKeys removes secret-shaped keys at every depth and keeps the rest verbatim', () => {
    const stripped = stripSecretConfigKeys({
      host: 'h',
      port: 5432,
      password: 'p',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer t' },
      nested: [{ apiKey: 'k', keep: 1 }],
    })
    expect(stripped).toEqual({
      host: 'h',
      port: 5432,
      headers: { 'content-type': 'application/json' },
      nested: [{ keep: 1 }],
    })
  })

  it('collectSecretConfigValues feeds redactSecrets from BOTH credentials and connection', () => {
    expect(
      collectSecretConfigValues([
        { username: 'u', password: 'cred-secret' },
        { host: 'h', password: 'conn-secret', headers: { Authorization: 'nested-secret' } },
      ]).sort(),
    ).toEqual(['conn-secret', 'cred-secret', 'nested-secret'])
  })

  it('collectSecretConfigValues returns LONGEST-FIRST (a short secret must not cut a longer one up)', () => {
    // Insertion order here is ['xy', 'xyz']; replacing 'xy' first would leave '***z' of the longer
    // secret in the message. The sort in collectSecretConfigValues is what makes this ['xyz', 'xy'].
    expect(collectSecretConfigValues([{ secret: 'xy', password: 'xyz' }, {}])).toEqual(['xyz', 'xy'])
  })

  it('redactSecrets consumes the WHOLE longer secret when a shorter secret is its prefix', () => {
    const adapter = new OkAdapter({
      id: 'dscs-redact-order',
      name: 'dscs-redact-order',
      type: 'postgres',
      connection: { host: 'db.internal.example' },
      credentials: { secret: 'xy', password: 'xyz' },
    } as unknown as DataSourceConfig)
    // Bare value (no `key=value` shape), so only the VALUE list can scrub it: without the
    // longest-first order this reads '... tried ***z'.
    expect(adapter.redactCause('auth failed, tried xyz')).toBe('auth failed, tried ***')
  })

  it('the generated text pattern is a SUPERSET of the hand-written one it replaced', () => {
    // The pre-#5621 alternation in BaseAdapter.redactSecrets.
    for (const legacyWord of ['password', 'pwd', 'pass', 'token', 'api_key', 'apiKey', 'secret']) {
      expect(`boom ${legacyWord}=hunter2`.replace(secretKeyValueTextPattern(), '$1***'))
        .not.toContain('hunter2')
    }
    // …and the words the shared list adds on top.
    for (const addedWord of ['passphrase', 'credential', 'accessKey', 'privateKey']) {
      expect(`boom ${addedWord}: hunter2`.replace(secretKeyValueTextPattern(), '$1***'))
        .not.toContain('hunter2')
    }
    // The dedicated authorization rule keeps owning "scheme + token" (see skipInTextPattern).
    expect('authorization=Bearer xyz'.replace(secretKeyValueTextPattern(), '$1***')).toContain('xyz')
  })
})
