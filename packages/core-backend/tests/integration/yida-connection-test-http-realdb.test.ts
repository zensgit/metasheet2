// Owner-run YiDa 测试连接 (ADR adr-yida-connection-test-20261028), positive path on real PostgreSQL:
// a fresh synthetic schema (migrations 090-096 + the live-ACL tables), the actual server anchor
// provisioner, live ACL, RC transaction, host runtime, plugin probe and router over loopback HTTP.
// The authenticated principal is injected after the route's own JWT position (the real JWT boundary
// for this path is proved in yida-host-connection-test-realdb.test.ts); the DingTalk fetch is an
// in-process synthetic sink, so no socket leaves the process. Every value is synthetic.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import express from 'express'
import { Pool, type PoolClient } from 'pg'
import winston from 'winston'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { provisionYidaInitializationAnchor, type YidaInitializationDatabase } from '../../src/integration/yida-initialization-bootstrap'
import { createYidaConnectionTestRuntime, type YidaConnectionTestRuntimeBinding } from '../../src/integration/yida-connection-test-runtime'
import { createYidaInitializationRuntime, type YidaInitializationRuntimeBinding } from '../../src/integration/yida-initialization-runtime'
import { YIDA_OWNER_HTTP_PREFIX as PREFIX } from '../../src/integration/yida-owner-http-observation'
import { createIntegrationYidaOwnerRouter, yidaOwnerJsonOnlyMiddleware, yidaOwnerNoStoreMiddleware,
  type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { correlationIdMiddleware } from '../../src/middleware/correlation'
import { Logger } from '../../src/core/logger'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('../utils/yida-native-module-import.cjs') as (url: string) => Promise<Record<string, unknown>>
// Literal on purpose: never imported from the exchange module.
const DINGTALK_OAUTH_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const owner = Object.freeze({ actorId: 'synthetic-probe-owner', tenantId: 'synthetic-probe-tenant', workspaceId: null })
const secondAdmin = Object.freeze({ ...owner, actorId: 'synthetic-probe-second-admin' })
const otherCommand = '99999999-9999-4999-8999-999999999999'
const pair = () => ({ appKey: ' synthetic-probe-app-key ', appSecret: ' synthetic-probe-app-secret ' })
const ident = (value: string) => { if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('OWNED_SCHEMA_REQUIRED'); return `"${value}"` }
type Row = Record<string, unknown>
type Result = { status: number; headers: Record<string, string | string[] | undefined>; body: Row }

it('sentinel: connection-test real-DB proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const realdb = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip
realdb('YiDa connection test — anchor owner, live ACL, one synthetic token exchange, no write (real PG)', () => {
  let pool: Pool, admin: PoolClient, schema = '', ddl: string, server: Server | undefined
  let createProbeBinding: () => YidaConnectionTestRuntimeBinding
  let createInitBinding: (options: { security: { encrypt(v: string): Promise<string>; decrypt(v: string): Promise<string> } }) => YidaInitializationRuntimeBinding
  let example: () => { config: unknown; text: string }
  let principal: { actorId: string; tenantId: string } = owner
  let enablement: unknown = 'false', tokenOutcome: 'ok' | 'reject' | 'unreachable' = 'ok'
  const stops: Array<() => Promise<void>> = [], sql: string[] = [], tokenBodies: Row[] = [], foreignFetch: string[] = []
  const logs: Array<Record<PropertyKey, unknown>> = []
  let logSpy: ReturnType<typeof vi.spyOn>
  // L4 refuses unless ENCRYPTION_KEY / ENCRYPTION_SALT pass the production checks in every NODE_ENV,
  // and this suite's setup configures neither: beforeAll sets explicit synthetic material for the whole file
  // (only the POST /initialization case needs it; L3 without keys is covered by yida-host-connection-test-realdb).
  let savedEncryption: Array<[string, string | undefined]> = []
  const security = Object.freeze({ async encrypt(value: string) { return 'enc:' + Buffer.from(value).toString('base64') },
    async decrypt(value: string) { return Buffer.from(value.slice(4), 'base64').toString() } })
  const syntheticFetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) !== DINGTALK_OAUTH_ENDPOINT || init?.method !== 'POST' || init.redirect !== 'error') { foreignFetch.push('unexpected'); throw new Error('SYNTHETIC_UNEXPECTED_FETCH') }
    tokenBodies.push(JSON.parse(String(init.body)) as Row)
    if (tokenOutcome === 'reject') return new Response('{"code":"synthetic-invalid-client"}', { status: 401 })
    if (tokenOutcome === 'unreachable') throw new TypeError('synthetic fetch failed')
    return new Response(JSON.stringify({ accessToken: 'synthetic-probe-access-token', expireIn: 7200 }), { status: 200 })
  }) as typeof fetch
  const database: YidaInitializationDatabase = { async transaction<T>(work: (trx: Queryable) => Promise<T>) {
    const client = await pool.connect(); let committed = false
    try {
      await client.query(`SET search_path TO ${ident(schema)}`)
      await client.query("SET statement_timeout = '10s'")
      await client.query('BEGIN'); sql.push('BEGIN')
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const result = await work({ async query(text, params) { sql.push(text); const r = await client.query(text, params); return { rows: r.rows, rowCount: r.rowCount } } })
      await client.query('COMMIT'); committed = true; sql.push('COMMIT')
      return result
    } catch (error) { if (!committed) await client.query('ROLLBACK'); throw error } finally { client.release() }
  } }
  async function counts() {
    const tables = (await admin.query(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1
      AND starts_with(table_name, 'integration_yida_') ORDER BY table_name`, [schema])).rows as Array<{ name: string }>
    const result: Record<string, number> = {}
    for (const { name } of tables) result[name] = Number((await admin.query(`SELECT count(*) AS count FROM ${ident(name)}`)).rows[0].count)
    return result
  }
  async function start() {
    const probeRuntime = createYidaConnectionTestRuntime({ database, fetch: syntheticFetch, readEnablement: () => enablement })
    const probeRegistration = await probeRuntime.createPluginCapability().activate(createProbeBinding())
    const initRuntime = createYidaInitializationRuntime({ database, security })
    const initRegistration = await initRuntime.createPluginCapability().activate(createInitBinding({ security }))
    stops.push(() => probeRuntime.stop(), () => probeRegistration.stop(), () => initRuntime.stop(), () => initRegistration.stop())
    // The integration setup silences info; this one request logger runs at info like production.
    const level = process.env.LOG_LEVEL; process.env.LOG_LEVEL = 'info'
    const requestLog = new Logger('SyntheticProbeRequestLog')
    if (level === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = level
    const app = express()
    app.use(correlationIdMiddleware)
    app.use((req, _res, next) => { requestLog.info(`${req.method} ${req.path}`); next() })
    app.use(PREFIX, yidaOwnerNoStoreMiddleware, yidaOwnerJsonOnlyMiddleware, express.json({ limit: '64kb', strict: true }))
    // The authenticated principal, injected where the host's JWT middleware would have set it.
    app.use((req, _res, next) => { Object.assign(req, { user: { id: principal.actorId }, authenticatedTenantId: principal.tenantId }); next() })
    app.use(PREFIX, createIntegrationYidaOwnerRouter({ sendEnabled: () => false } as unknown as YidaOwnerHttpPort, initRuntime, probeRuntime))
    server = createServer(app)
    await new Promise<void>(resolve => server!.listen({ port: 0, host: '127.0.0.1' }, () => resolve()))
    return { initRuntime }
  }
  function http(method: string, suffix: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
    const address = server?.address()
    if (!address || typeof address === 'string') throw new Error('SYNTHETIC_LISTENER_REQUIRED')
    const raw = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path: PREFIX + suffix, method, agent: false,
        headers: { ...(raw === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) }), ...headers } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.once('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Row }))
      })
      req.setTimeout(15000, () => req.destroy(new Error('SYNTHETIC_HTTP_TIMEOUT')))
      req.once('error', reject); req.end(raw)
    })
  }
  const probe = (commandId: unknown, headers?: Record<string, string>) =>
    http('POST', '/initialization/connection-test', { commandId, mode: 'candidate', material: pair() }, headers)
  function data(result: Result, status: number): Row {
    expect(result.status).toBe(status); expect(result.headers['cache-control']).toBe('no-store')
    expect(Object.keys(result.body).sort()).toEqual(['data', 'ok'])
    return result.body.data as Row
  }
  function denied(result: Result, status: number, code: string) {
    expect(result.status).toBe(status); expect(result.headers['cache-control']).toBe('no-store')
    expect(result.body).toEqual({ ok: false, error: { code } })
  }
  beforeAll(async () => {
    savedEncryption = ['ENCRYPTION_KEY', 'ENCRYPTION_SALT'].map(key => [key, process.env[key]])
    process.env.ENCRYPTION_KEY = 'synthetic-probe-encryption-key-0123456789abcdef'
    process.env.ENCRYPTION_SALT = 'synthetic-probe-encryption-salt-0123456789abcdef'
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createProbeBinding = requireCjs(path.join(lib, 'yida-connection-probe.cjs')).createYidaConnectionProbeBinding
    createInitBinding = (await importNative(pathToFileURL(path.join(lib, 'yida-initialization-producer.mjs')).href)).createYidaInitializationBinding as typeof createInitBinding
    example = (await importNative(pathToFileURL(path.join(lib, 'yida-static-plan.mjs')).href)).createYidaProtocolExample as typeof example
    ddl = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql', '095_create_integration_yida_send_approvals.sql',
      '096_create_integration_yida_initialization.sql'].map(name => readFileSync(path.join(root, 'packages/core-backend/migrations', name), 'utf8')).join('\n')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000, application_name: 'yida_connection_test_synthetic' })
    admin = await pool.connect()
    logSpy = vi.spyOn(winston.transports.Console.prototype, 'log').mockImplementation(function (info: Record<PropertyKey, unknown>, callback: () => void) {
      logs.push({ ...info }); callback()
    } as never)
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_connection_test_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE SCHEMA ${ident(schema)}`); await admin.query(`SET search_path TO ${ident(schema)}`)
    await admin.query(`CREATE TABLE user_roles(user_id text,role_id text);
      CREATE TABLE role_permissions(role_id text,permission_code text);
      CREATE TABLE user_permissions(user_id text,permission_code text);
      CREATE TABLE users(id text PRIMARY KEY,role text,is_active boolean,activation_status text,permissions jsonb);
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean);
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean)`)
    await admin.query(ddl)
    for (const actor of [owner, secondAdmin]) {
      await admin.query("INSERT INTO users VALUES($1,'admin',true,'activated','[]')", [actor.actorId])
      await admin.query("INSERT INTO user_roles VALUES($1,'admin')", [actor.actorId])
      await admin.query('INSERT INTO user_orgs VALUES($1,$2,true)', [actor.actorId, owner.tenantId])
    }
    sql.length = 0; tokenBodies.length = 0; foreignFetch.length = 0; logs.length = 0
    principal = owner; enablement = 'false'; tokenOutcome = 'ok'
  }, 30000)
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
    if (server) { const owned = server; server = undefined; owned.closeAllConnections(); await new Promise<void>(resolve => owned.close(() => resolve())) }
    expect(foreignFetch).toEqual([])
    if (schema) { await admin.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  }, 30000)
  afterAll(async () => {
    try { logSpy?.mockRestore(); admin?.release(); await pool?.end() } catch { /* best effort */ }
    finally { for (const [key, value] of savedEncryption) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  }, 30000)

  it('switch OFF: the GET carries no connectionTestEnabled key and the probe is 403 DISABLED before any transaction', async () => {
    const anchor = await provisionYidaInitializationAnchor({ database }, { ownerId: owner.actorId, tenantId: owner.tenantId })
    await start()
    const off = data(await http('GET', '/initialization'), 200)
    expect(off).toMatchObject({ commandId: anchor.commandId, status: 'ready' })
    // Absent, not false: an older cached bundle with the closed pre-test key set keeps working.
    expect(Object.keys(off).sort()).toEqual(['canSend', 'commandId', 'draft', 'externalWriteAttempted', 'sendEnabled', 'status', 'tokenIssued'])
    const before = await counts(); sql.length = 0
    for (const value of ['false', 'TRUE', ' true', '1']) { enablement = value; denied(await probe(anchor.commandId), 403, 'YIDA_CONNECTION_TEST_DISABLED') }
    expect(sql).toEqual([]); expect(tokenBodies).toEqual([]); expect(await counts()).toEqual(before)
  })

  it('anchor owner before initialization: one exchange with exactly the pasted pair, after COMMIT, and no row anywhere', async () => {
    const anchor = await provisionYidaInitializationAnchor({ database }, { ownerId: owner.actorId, tenantId: owner.tenantId })
    await start(); enablement = 'true'
    expect(data(await http('GET', '/initialization'), 200)).toMatchObject({ status: 'ready', sendEnabled: false, connectionTestEnabled: true })
    const before = await counts(); sql.length = 0
    const result = data(await probe(anchor.commandId), 200)
    expect(result).toEqual({ commandId: anchor.commandId, mode: 'candidate', outcome: 'ok', tokenIssued: true,
      tokenRetained: false, externalWriteAttempted: false, canSend: false })
    expect(tokenBodies).toEqual([pair()])
    expect(sql.filter(text => text === 'BEGIN')).toHaveLength(1); expect(sql.at(-1)).toBe('COMMIT')
    expect(sql.some(text => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(text))).toBe(false)
    expect(await counts()).toEqual(before)
    expect(JSON.stringify(result).includes('synthetic-probe-access-token')).toBe(false)
  })

  it('upstream_rejected and unreachable come back as classes; a second click inside the cooldown is THROTTLED', async () => {
    const anchor = await provisionYidaInitializationAnchor({ database }, { ownerId: owner.actorId, tenantId: owner.tenantId })
    await start(); enablement = 'true'
    tokenOutcome = 'reject'
    expect(data(await probe(anchor.commandId), 200)).toMatchObject({ outcome: 'upstream_rejected', tokenIssued: false })
    denied(await probe(anchor.commandId), 429, 'YIDA_CONNECTION_TEST_THROTTLED')
    await new Promise(resolve => setTimeout(resolve, 5100))
    tokenOutcome = 'unreachable'
    expect(data(await probe(anchor.commandId), 200)).toMatchObject({ outcome: 'unreachable', tokenIssued: false })
    expect(tokenBodies).toHaveLength(2)
  }, 30000)

  it('another live administrator, a revoked role, another tenant and a wrong commandId never reach an exchange', async () => {
    const anchor = await provisionYidaInitializationAnchor({ database }, { ownerId: owner.actorId, tenantId: owner.tenantId })
    await start(); enablement = 'true'
    const before = await counts()
    principal = secondAdmin; denied(await probe(anchor.commandId), 403, 'YIDA_CONNECTION_TEST_DENIED')
    principal = { ...owner, tenantId: 'synthetic-probe-other-tenant' }; denied(await probe(anchor.commandId), 403, 'YIDA_CONNECTION_TEST_DENIED')
    principal = owner; denied(await probe(otherCommand), 409, 'YIDA_CONNECTION_TEST_CONFLICT')
    await admin.query('DELETE FROM user_roles WHERE user_id=$1', [owner.actorId])
    await admin.query("UPDATE users SET role='user' WHERE id=$1", [owner.actorId])
    denied(await probe(anchor.commandId), 403, 'YIDA_CONNECTION_TEST_DENIED')
    expect(tokenBodies).toEqual([]); expect(await counts()).toEqual(before)
  })

  it('once the slot is initialized, a candidate probe is CONFLICT with no exchange; the POST 201 carries the bit', async () => {
    const anchor = await provisionYidaInitializationAnchor({ database }, { ownerId: owner.actorId, tenantId: owner.tenantId })
    await start(); enablement = 'true'
    const source = example()
    const made = data(await http('POST', '/initialization', { commandId: anchor.commandId,
      material: { ...pair(), systemToken: ' synthetic-probe-system-token ', userId: 'synthetic-probe-user' },
      draft: { config: source.config, rowsText: source.text, allocation: { mode: 'original' } },
      attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-probe-review', organizationId: 'synthetic-probe-org', executionIdentity: 'synthetic-probe-user' } }), 201)
    expect(made).toMatchObject({ status: 'initialized', connectionTestEnabled: true, sendEnabled: false })
    const sealed = await counts()
    denied(await probe(anchor.commandId), 409, 'YIDA_CONNECTION_TEST_CONFLICT')
    expect(tokenBodies).toEqual([]); expect(await counts()).toEqual(sealed)
  })

  it('without a server anchor the probe is UNAVAILABLE; the actual Logger stays values-free on this path', async () => {
    await start(); enablement = 'true'
    denied(await probe(randomUUID(), { 'x-correlation-id': 'PRIVATE_PROBE_CORRELATION_CANARY' }), 503, 'YIDA_CONNECTION_TEST_UNAVAILABLE')
    expect(tokenBodies).toEqual([])
    await provisionYidaInitializationAnchor({ database }, { ownerId: owner.actorId, tenantId: owner.tenantId })
    const anchor = (await admin.query('SELECT command_id FROM integration_yida_initialization_anchor')).rows[0].command_id as string
    expect(data(await probe(anchor, { 'x-correlation-id': 'PRIVATE_PROBE_CORRELATION_CANARY' }), 200).outcome).toBe('ok')
    await new Promise(resolve => setImmediate(resolve))
    const mine = logs.filter(entry => entry.context === 'SyntheticProbeRequestLog')
    expect(mine.length).toBeGreaterThanOrEqual(2)
    for (const entry of mine) expect(entry.message).toBe('YIDA_OWNER_HTTP_INFO')
    const output = inspect(logs, { depth: null, colors: false, getters: false })
    for (const value of [...Object.values(pair()), 'synthetic-probe-access-token', 'PRIVATE_PROBE_CORRELATION_CANARY', 'connection-test', anchor])
      expect(output.includes(value)).toBe(false)
  })
})
