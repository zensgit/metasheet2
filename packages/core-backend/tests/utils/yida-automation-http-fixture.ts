// Actual HTTP + native AuthService/JWT/session checks + current SA06D service.
// Reuses the established owner fixture's isolated native auth pool/material.
// The fixed test binding is NOT proof of a production host installation.
import { createServer, request, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import express, { type RequestHandler } from 'express'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { createYidaAutomationAuthorizationService, YidaAutomationManagementError } from '../../src/integration/yida-automation-authorization-service'
import { createYidaAutomationManagementHost } from '../../src/integration/yida-automation-management-host'
import { createIntegrationYidaAutomationRouter, YIDA_AUTOMATION_HTTP_PREFIX as prefix,
  yidaAutomationNoStore, yidaAutomationJsonOnly, yidaAutomationParseError, yidaAutomationBodyLimit,
  type YidaAutomationHttpPort } from '../../src/routes/integration-yida-automation'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { YidaSendAuthorityPrimitives } from '../../src/integration/yida-send-approval-service'
import { up as migrateOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { createYidaOwnerHttpRealdbFixture, principals, tenant } from './stock-preparation-yida-owner-http-fixture'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const nativeImport = requireCjs('./yida-native-module-import.cjs') as (url: string) => Promise<Record<string, unknown>>
const load = (relative: string) => nativeImport(pathToFileURL(path.join(root, relative)).href)
const revision = '11111111-1111-4111-8111-111111111111'
type Security = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Actor = Parameters<YidaAutomationHttpPort['create']>[0]
type Options = { signal: AbortSignal }
export async function createYidaAutomationHttpFixture() {
  if (process.env.EXPECT_DB !== '1' || process.env.PLM_FULL_APP_ALLOW_OWN_HTTP !== '1') throw new Error('SA06D_OWNED_HTTP_REQUIRED')
  const oldLevel = process.env.LOG_LEVEL
  process.env.LOG_LEVEL = 'error'
  const owner = await createYidaOwnerHttpRealdbFixture()
  let pool: Pool | undefined, server: Server | undefined
  let historyHost: ReturnType<typeof createYidaAutomationManagementHost> | undefined
  let lostCommit = false, historySourceCalls = 0, historyFetchCalls = 0
  async function transaction<T>(work: (trx: Queryable) => Promise<T>) {
    const client = await pool!.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work(client)
      await client.query('COMMIT')
      if (lostCommit) { lostCommit = false; throw new Error('SYNTHETIC_COMMIT_RECEIPT_LOST') }
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  let calls = 0, foreignReads = 0, failure: 'NONE' | 'FOREIGN' | 'EXTRA_DTO' | 'OWNED_BAD_CODE' = 'NONE'
  let authenticatedTenantPresent = false, legacyHeaderFallback = false
  const services = new Set<ReturnType<typeof createYidaAutomationAuthorizationService>>()
  async function closeLocal() {
    const current = server; server = undefined
    if (current) await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()))
    services.forEach(service => service.close()); services.clear()
    await historyHost?.stop(); historyHost = undefined
    if (pool) { const currentPool = pool; pool = undefined; await currentPool.end() }
  }
  async function cleanup() {
    try { await closeLocal() } finally {
      try { await owner.cleanup() } finally {
        if (oldLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = oldLevel
      }
    }
  }
  async function reset() {
    await closeLocal(); await owner.reset()
    const endpoint = new URL(process.env.DATABASE_URL!)
    const owned = new URL(process.env.PLM_FULL_APP_DATABASE_URL!)
    if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== owned.port || endpoint.pathname !== owned.pathname
      || endpoint.username !== owned.username || endpoint.password !== owned.password
      || !/^-c search_path=yida_owner_http_[0-9a-f]{32} -c statement_timeout=10000$/u.test(endpoint.searchParams.get('options') ?? '')) {
      throw new Error('SA06D_HTTP_NATIVE_SCOPE_REQUIRED')
    }
    pool = new Pool({ connectionString: endpoint.href, max: 4 })
    await migrateOutbox(new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }))
    for (const name of ['097_create_integration_yida_automation_authorizations.sql',
      'zzzz20261019121000_link_integration_yida_automation_outbox.sql', '099_create_integration_yida_automation_execution_snapshots.sql',
      'zzzz20261021120000_create_yida_reconciliation_observations.sql']) {
      await pool.query(readFileSync(path.join(root, 'packages/core-backend/migrations', name), 'utf8'))
    }
    await pool.query(`CREATE TABLE meta_bases(id text PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,deleted_at timestamptz);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text,name text,trigger_type text,trigger_config jsonb,
        action_type text,action_config jsonb,enabled boolean,created_at timestamptz,updated_at timestamptz,
        created_by text,conditions jsonb,actions jsonb,execution_mode text,integration_authority_revision text);
      INSERT INTO meta_bases VALUES ('synthetic-http-base',NULL);
      INSERT INTO meta_sheets VALUES ('synthetic-http-sheet','synthetic-http-base',NULL)`)
    await pool.query(`INSERT INTO automation_rules VALUES ('synthetic-http-rule','synthetic-http-sheet','Synthetic',
      'schedule.interval','{"intervalMs":60000}','integration_yida_send_authorized',
      '{"authorizationSlot":"synthetic-slot"}',true,clock_timestamp(),clock_timestamp(),$1,NULL,'[]','legacy',$2)`,
    [principals.owner, revision])
    const securityModule = await load('packages/core-backend/src/security/plugin-runtime-security-service.ts')
    const SecurityClass = securityModule.PluginRuntimeSecurityService as new () => Security
    const security = new SecurityClass()
    historySourceCalls = 0; historyFetchCalls = 0; lostCommit = false
    historyHost = createYidaAutomationManagementHost({ database: { transaction }, security,
      readRuntime: { async withInstalledBindingSourceForYida() { historySourceCalls++; throw new Error('SYNTHETIC_HISTORY_MUST_NOT_RESOLVE_SOURCE') } },
      fetch: async () => { historyFetchCalls++; throw new Error('SYNTHETIC_HISTORY_MUST_NOT_FETCH') },
      deliveryReady: () => false, readEnablement: () => 'false' })
    const native = await load('plugins/plugin-integration-core/lib/yida-send-authority-primitives.mjs')
    const createPrimitives = native.createYidaSendAuthorityPrimitives as (options: { security: Security;
      context: { tenantId: string; workspaceId: null; ownerId: string } }) => YidaSendAuthorityPrimitives
    const jwt = (await load('packages/core-backend/src/auth/jwt-middleware.ts')).jwtAuthMiddleware as RequestHandler
    async function invoke<T>(actor: Actor, options: Options,
      run: (service: ReturnType<typeof createYidaAutomationAuthorizationService>) => Promise<T>): Promise<T> {
      calls += 1
      if (failure === 'FOREIGN') throw new Proxy({}, { get() { foreignReads += 1; throw new Error('SYNTHETIC_FOREIGN_GETTER') } })
      // Actual exported constructor, invoked as JS would invoke it. Do not
      // fabricate a branded error or assume a TS union enforces runtime input.
      if (failure === 'OWNED_BAD_CODE') throw Reflect.construct(YidaAutomationManagementError, ['synthetic-private-provider-code'])
      const current = pool!
      const database = { async transaction<R>(work: (trx: Queryable) => Promise<R>) {
        const client = await current.connect()
        const check = () => { if (options.signal.aborted) throw new Error('SA06D_HTTP_CANCELLED') }
        try {
          check(); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          const result = await work({ async query(sql, values) {
            check(); const result = await client.query(sql, values); check(); return result
          } })
          check(); await client.query('COMMIT'); check(); return result
        } catch (error) { await client.query('ROLLBACK'); throw error }
        finally { client.release() }
      } }
      const service = createYidaAutomationAuthorizationService({ grantor: actor,
        binding: { baseId: 'synthetic-http-base', sheetId: 'synthetic-http-sheet', projectField: 'projectNo' },
        primitives: createPrimitives({ security, context: { tenantId: actor.tenantId, workspaceId: null, ownerId: actor.actorId } }),
        database, activationId: '22222222-2222-4222-8222-222222222222' })
      services.add(service)
      try { return await run(service) } finally { service.close(); services.delete(service) }
    }
    const port: YidaAutomationHttpPort = Object.freeze({
      appendObservation: historyHost.port.appendObservation,
      listObservations: historyHost.port.listObservations,
      async create(actor, consent, options) {
        const saved = await invoke(actor, options, service => service.create(consent))
        return failure === 'EXTRA_DTO' ? { ...saved, token: 'synthetic-forbidden-token' } : saved
      },
      inspect: (actor, grantId, options) => invoke(actor, options, service => service.inspect(grantId)),
      revoke: (actor, grantId, options) => invoke(actor, options, service => service.revoke(grantId)),
      requestManual: (actor, grantId, input, options) => invoke(actor, options, service => service.requestManual(grantId, input)),
    })
    const app = express()
    app.use(prefix, yidaAutomationNoStore, yidaAutomationJsonOnly, express.json({ limit: '16kb', strict: true, verify: yidaAutomationBodyLimit }), yidaAutomationParseError)
    app.use(jwt)
    app.use((_req, _res, next) => {
      authenticatedTenantPresent = Boolean(_req.authenticatedTenantId)
      legacyHeaderFallback = !authenticatedTenantPresent && Boolean(_req.user?.tenantId)
      next()
    })
    app.use(prefix, createIntegrationYidaAutomationRouter(port))
    server = createServer(app)
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen({ port: 0, host: '127.0.0.1' }, () => { server!.removeListener('error', reject); resolve() })
    })
    calls = 0; foreignReads = 0; failure = 'NONE'
  }
  async function http(method: string, suffix = '', body?: unknown,
    options: { token?: string | null; headers?: Record<string, string>; raw?: string; contentType?: string } = {}) {
    const endpoint = server?.address()
    if (!endpoint || typeof endpoint === 'string') throw new Error('SA06D_HTTP_LISTENER_REQUIRED')
    const token = Object.hasOwn(options, 'token') ? options.token : owner.tokens.owner
    const raw = options.raw ?? (body === undefined ? undefined : JSON.stringify(body))
    return new Promise<{ status: number; body: { ok: boolean; data: Record<string, unknown>; error?: { code: string } };
      headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const client = request({ hostname: '127.0.0.1', port: endpoint.port, path: prefix + suffix, method, agent: false,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(raw === undefined ? {} : { 'content-type': options.contentType ?? 'application/json',
            'content-length': String(Buffer.byteLength(raw)) }), ...options.headers } }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.once('error', () => reject(new Error('SA06D_HTTP_RESPONSE_FAILED')))
        response.once('end', () => {
          try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: response.headers }) }
          catch { reject(new Error('SA06D_HTTP_JSON_FAILED')) }
        })
      })
      client.once('error', () => reject(new Error('SA06D_HTTP_REQUEST_FAILED')))
      client.end(raw)
    })
  }
  return { owner, reset, cleanup, http, transaction,
    stopHistoryHost: () => historyHost!.stop(),
    loseNextCommitResponse() { lostCommit = true },
    get historySourceCalls() { return historySourceCalls }, get historyFetchCalls() { return historyFetchCalls },
    consent: () => ({ confirmationId: 'synthetic-http-confirmation', ruleId: 'synthetic-http-rule', expectedRuleRevision: revision,
      actionId: 'synthetic-slot', projectNo: 'SYN-P1', operationId: owner.seedDraft.operationId,
      rowKeys: [owner.seedDraft.rows[0].rowKey], allowedTriggers: ['manual', 'schedule.interval'], maxExecutions: 1, ttlMs: 900000 }),
    counts: async () => (await pool!.query(`SELECT (SELECT count(*)::int FROM integration_yida_auto_grants) AS grants,
      (SELECT count(*)::int FROM integration_yida_auto_requests) AS requests,
      (SELECT count(*)::int FROM integration_yida_auto_admissions) AS admissions,
      (SELECT count(*)::int FROM meta_automation_outbox) AS outbox`)).rows[0],
    query: (sql: string, values?: unknown[]) => pool!.query(sql, values),
    get calls() { return calls }, get foreignReads() { return foreignReads },
    get authenticatedTenantPresent() { return authenticatedTenantPresent }, get legacyHeaderFallback() { return legacyHeaderFallback },
    setFailure(value: typeof failure) { failure = value }, tenant,
  }
}
