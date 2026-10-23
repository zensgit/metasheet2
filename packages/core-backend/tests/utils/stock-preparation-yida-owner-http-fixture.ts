// Real native JWT/AuthService, owner runtime, plugin binding and PostgreSQL.
// Only the YiDa fetch dependency is synthetic; it never opens a socket.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { Pool, type PoolClient } from 'pg'
import type { User } from '../../src/auth/AuthService'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { createYidaOwnerRuntime, YidaOwnerRuntimeBinding } from '../../src/integration/yida-owner-runtime'
import type { createIntegrationYidaOwnerRouter } from '../../src/routes/integration-yida-owner'
import type { createYidaInitializationRuntime, YidaInitializationRuntimeBinding } from '../../src/integration/yida-initialization-runtime'
import type { provisionYidaInitializationAnchor } from '../../src/integration/yida-initialization-bootstrap'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('./yida-native-module-import.cjs') as (url: string) => Promise<Record<string, unknown>>
const prefix = '/api/integration/yida-owner-send'
export type Data = Record<string, unknown>
export type Input = { config: Data; rowsText: string; allocation: Data }
export type Draft = { targetRef: string; operationId: string; rows: Array<{ rowKey: string; index: number }>; reused: boolean }
type Security = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Database = { query(sql: string, params?: unknown[]): Promise<Data[]>;
  transaction<T>(work: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T> }
type DraftStore = { createDraft(input: Input): Promise<Draft> }
type MaterialStore = { create(input: unknown): Promise<{ credentialRef: string; credentialGeneration: number }>;
  revoke(input: unknown): Promise<unknown> }
type TargetStore = { register(input: unknown): Promise<{ targetRef: string }> }
type NativePool = { query(sql: string, params?: unknown[]): Promise<{ rows: Data[] }>;
  getInternalPool(): Pool; stopMetricsCollection(): void }
type Auth = { createToken(user: User, options: { sid: string }): string }
type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: Data }
type HttpOptions = { token?: string | null; headers?: Record<string, string>; raw?: string; contentType?: string }
type Runtime = ReturnType<typeof createYidaOwnerRuntime>
const proofTables = ['integration_yida_send_approvals', 'integration_yida_send_revocations',
  'integration_yida_send_admissions', 'integration_yida_send_approval_audit',
  'integration_yida_delivery_ledger', 'integration_yida_delivery_audit'] as const
export const principals = Object.freeze({ owner: 'synthetic-http-owner', otherOwner: 'synthetic-http-other-owner',
  reader: 'synthetic-http-reader', fakeRole: 'synthetic-http-fake-role' })
export const tenant = 'synthetic-http-tenant', otherTenant = 'synthetic-http-other-tenant'
export const syntheticMaterial = () => ({ appKey: ' synthetic-http-app-key ', appSecret: ' synthetic-http-app-secret ',
  systemToken: ' synthetic-http-system-token ', userId: 'synthetic-http-executor' })
function ident(value: string) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('SYNTHETIC_OWNED_IDENTIFIER_REQUIRED')
  return `"${value}"`
}
export function draftInput(mode = 'original', quantity = 6): Input {
  return { config: { version: 2, kind: 'yida-form-protocol-static', intent: 'create',
    target: { appType: 'synthetic_http_app', formUuid: 'synthetic_http_form' },
    businessKey: ['projectNo', 'lineId', 'parentCode'], emptyKeyFields: ['parentCode'],
    fieldCatalog: [{ id: 'project', control: 'text', required: true }, { id: 'line', control: 'text', required: true },
      { id: 'parent', control: 'text', required: false }, { id: 'qty', control: 'number', required: true },
      { id: 'description', control: 'text', required: false }],
    fieldMap: [{ source: 'projectNo', target: 'project', type: 'string', required: true },
      { source: 'lineId', target: 'line', type: 'string', required: true },
      { source: 'parentCode', target: 'parent', type: 'string', required: false },
      { source: 'quantity', target: 'qty', type: 'number', required: true },
      { source: 'description', target: 'description', type: 'string', required: false }],
  }, rowsText: JSON.stringify([{ projectNo: 'SYN-P1', lineId: 'SYN-L1', parentCode: null,
    quantity, description: 'synthetic HTTP part' }]), allocation: mode === 'original' ? { mode }
    : { mode, projects: ['SYN-P1', 'SYN-P2', 'SYN-P3'], projectField: 'projectNo', quantityField: 'quantity' } }
}

export async function createYidaOwnerHttpRealdbFixture(options: { initialization?: boolean; bootstrap?: boolean } = {}) {
  const databaseUrl = process.env.DATABASE_URL
  if (process.env.EXPECT_DB !== '1' || !databaseUrl) throw new Error('SYNTHETIC_DATABASE_REQUIRED')
  const schema = 'yida_owner_http_' + randomUUID().replaceAll('-', '')
  const adminPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000 })
  const env = new Map<string, string | undefined>()
  const setEnv = (key: string, value?: string) => {
    if (!env.has(key)) env.set(key, process.env[key])
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  let admin: PoolClient | undefined, client: PoolClient | undefined, hostPool: NativePool | undefined
  let runtime: Runtime | undefined, registration: { stop(): Promise<void> } | undefined, server: Server | undefined
  let initializationRuntime: ReturnType<typeof createYidaInitializationRuntime> | undefined
  let initializationRegistration: { stop(): Promise<void> } | undefined
  let createInitialization: typeof createYidaInitializationRuntime, provisionInitialization: typeof provisionYidaInitializationAnchor
  let createInitializationBinding: (input: { security: Security }) => YidaInitializationRuntimeBinding
  let correlation: RequestHandler, privateLogger: { info(message: string): void; winston: { close(): void } } | undefined
  let schemaCreated = false, ownerDb: unknown, security: Security, auth: Auth
  let createRuntime: typeof createYidaOwnerRuntime, createRouter: typeof createIntegrationYidaOwnerRouter
  let createBinding: (input: { db: unknown; security: Security }) => YidaOwnerRuntimeBinding
  let noStore: RequestHandler, jsonOnly: RequestHandler, parseError: ErrorRequestHandler, jwtMiddleware: RequestHandler
  let invalidateUserPerms: (userId: string) => void
  let createDb: (input: { database: Database }) => unknown
  let createDraft: (input: { db: unknown; security: Security; context: Data }) => DraftStore
  let createMaterial: (input: { db: unknown; security: Security; context: Data }) => MaterialStore
  let createTarget: (input: { db: unknown; security: Security; context: Data }) => TargetStore
  let compile: (input: Input) => { plan: { rows: Array<{ payload: Data }> } }
  const sql: string[] = [], tokenPayloads: Data[] = [], formPayloads: Data[] = []
  const sessions: Record<string, string> = {}, tokens: Record<string, string> = {}
  let enablement: unknown = 'false', tokenCommitted = false, validRequests = true, formOutcome = 'ack'
  let credentialRef = '', credentialGeneration = 0, seedDraft: Draft
  const load = (relative: string) => importNative(pathToFileURL(path.join(root, relative)).href)
  const query: Queryable['query'] = async (text, params) => {
    if (!client) throw new Error('SYNTHETIC_SESSION_REQUIRED')
    sql.push(text) // SQL shapes only; never retain request/driver values.
    const result = await client.query(text, params)
    return { rows: result.rows as Data[], rowCount: result.rowCount }
  }
  const database = { async transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T> {
    await query(options.initialization ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN')
    try { const result = await work({ query }); await query('COMMIT'); return result }
    catch (error) { await query('ROLLBACK'); throw error }
  } }
  const pluginDatabase: Database = { query: async (text, params) => (await query(text, params)).rows,
    transaction: work => database.transaction(trx => work({ query: async (text, params) => (await trx.query(text, params)).rows })) }
  async function rows(table: string) {
    if (!admin) throw new Error('SYNTHETIC_ADMIN_REQUIRED')
    return (await admin.query(`SELECT * FROM ${ident(table)} ORDER BY 1`)).rows as Data[]
  }
  async function proof() {
    const values = await Promise.all(proofTables.map(rows))
    return { counts: values.map(value => value.length), digest: createHash('sha256').update(JSON.stringify(values)).digest('hex') }
  }
  const syntheticFetch: typeof fetch = async (url, init) => {
    const fixed = String(url), body = JSON.parse(String(init?.body)) as Data
    validRequests &&= init?.method === 'POST' && init.redirect === 'error'
    if (fixed === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      tokenPayloads.push(body)
      validRequests &&= body.appKey === syntheticMaterial().appKey && body.appSecret === syntheticMaterial().appSecret
      // Read from an independent committed PG session at the first token call.
      const admissions = await rows('integration_yida_send_admissions'), ledger = await rows('integration_yida_delivery_ledger')
      tokenCommitted = admissions.length === 1 && ledger.length === 1 && ledger[0].status === 'prepared'
      return new Response(JSON.stringify({ accessToken: 'synthetic-http-access-token', expireIn: 3600 }), { status: 200 })
    }
    if (fixed === 'https://api.dingtalk.com/v1.0/yida/forms/instances') {
      formPayloads.push(JSON.parse(String(body.formDataJson)) as Data)
      validRequests &&= body.systemToken === syntheticMaterial().systemToken && body.userId === syntheticMaterial().userId
        && (init?.headers as Record<string, string>)['x-acs-dingtalk-access-token'] === 'synthetic-http-access-token'
      if (formOutcome === 'unknown') throw new Error('SYNTHETIC_FORM_RESULT_UNKNOWN')
      return new Response(JSON.stringify({ result: 'synthetic-http-instance' }), { status: 201 })
    }
    throw new Error('SYNTHETIC_UNEXPECTED_FETCH')
  }
  async function closeRuntime() {
    const initializationDrain = initializationRuntime?.stop()
    await runtime?.stop()
    await initializationDrain
    await initializationRegistration?.stop()
    initializationRegistration = undefined; initializationRuntime = undefined
    await registration?.stop()
    registration = undefined; runtime = undefined
    if (server) {
      const owned = server; server = undefined
      owned.closeAllConnections()
      await new Promise<void>((resolve, reject) => owned.close(error => error ? reject(error) : resolve()))
    }
    privateLogger?.winston.close(); privateLogger = undefined
  }
  async function startRuntime(useDefault = false) {
    await closeRuntime()
    runtime = createRuntime({ database, security, fetch: syntheticFetch,
      ...(useDefault ? {} : { readEnablement: () => enablement }), timeoutMs: 5000 })
    // Match the production plugin injector: class methods are captured as
    // narrow own data members, never supplied as an inherited capability.
    const pluginSecurity = Object.freeze({ encrypt: security.encrypt.bind(security), decrypt: security.decrypt.bind(security) })
    registration = await runtime.createPluginCapability().activate(createBinding({ db: ownerDb, security: pluginSecurity }))
    if (options.initialization) {
      initializationRuntime = createInitialization({ database, security })
      initializationRegistration = await initializationRuntime.createPluginCapability().activate(createInitializationBinding({ security: pluginSecurity }))
    }
    const app = express()
    if (options.initialization) {
      const LoggerClass = (await load('packages/core-backend/src/core/logger.ts')).Logger as new (context: string) => NonNullable<typeof privateLogger>
      privateLogger = new LoggerClass('YidaInitializationHttpSynthetic')
      app.use(correlation)
      app.use((req, _res, next) => { privateLogger!.info(`${req.method} ${req.path}`); next() })
    }
    app.use(prefix, noStore, jsonOnly, express.json({ limit: '192kb', strict: true }), parseError)
    // Mount actual JWT at the prefix preserving the original path for auth policy.
    app.use(jwtMiddleware)
    app.use(prefix, createRouter(runtime, initializationRuntime))
    server = createServer(app)
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen({ port: 0, host: '127.0.0.1' }, () => { server!.removeListener('error', reject); resolve() })
    })
  }
  async function tokenFor(actorId: string, tenantId: string | null = tenant, role = 'user') {
    const sid = sessions[actorId]
    if (!sid) throw new Error('SYNTHETIC_SESSION_REQUIRED')
    return auth.createToken({ id: actorId, email: actorId + '@synthetic.invalid', name: 'Synthetic owner HTTP actor',
      role, permissions: [], ...(tenantId === null ? {} : { tenantId }),
      created_at: new Date(0), updated_at: new Date(0) }, { sid })
  }
  async function http(method: string, suffix: string, body?: unknown, options: HttpOptions = {}): Promise<HttpResult> {
    const address = server?.address()
    if (!address || typeof address === 'string') throw new Error('SYNTHETIC_OWNED_LISTENER_REQUIRED')
    const token = Object.hasOwn(options, 'token') ? options.token : tokens.owner
    const raw = options.raw ?? (body === undefined ? undefined : JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: prefix + suffix, method, agent: false,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(raw === undefined ? {} : { 'content-type': options.contentType ?? 'application/json',
            'content-length': String(Buffer.byteLength(raw)) }), ...options.headers } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.once('error', () => reject(new Error('SYNTHETIC_OWNER_HTTP_FAILURE')))
        res.once('end', () => {
          try { resolve({ status: res.statusCode ?? 0, headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Data }) }
          catch { reject(new Error('SYNTHETIC_OWNER_HTTP_RESPONSE_REQUIRED')) }
        })
      })
      req.setTimeout(10000, () => req.destroy(new Error('SYNTHETIC_OWNER_HTTP_TIMEOUT')))
      req.once('error', () => reject(new Error('SYNTHETIC_OWNER_HTTP_FAILURE')))
      req.end(raw)
    })
  }
  async function cleanup() {
    try {
      await closeRuntime()
      if (client) { await client.query('ROLLBACK'); client.release(); client = undefined }
      if (hostPool) {
        hostPool.stopMetricsCollection()
        const owned = hostPool.getInternalPool()
        if (!(owned as Pool & { ended?: boolean }).ended) await owned.end()
        hostPool = undefined
      }
      if (admin) {
        if (schemaCreated) { await admin.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schemaCreated = false }
        admin.release(); admin = undefined
      }
      await adminPool.end()
    } finally { for (const [key, value] of env) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  }
  try {
    admin = await adminPool.connect()
    await admin.query(`CREATE SCHEMA ${ident(schema)}`); schemaCreated = true
    const scoped = new URL(databaseUrl)
    scoped.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`)
    setEnv('DATABASE_URL', scoped.toString())
    for (const [key, value] of Object.entries({ NODE_ENV: 'production', SECRET_PROVIDER: 'env', ALLOW_SECRET_FALLBACK: 'false',
      RBAC_TOKEN_TRUST: 'false', RBAC_OPTIONAL: '0', RBAC_BYPASS: 'false', ALLOW_UNSAFE_ADMIN: 'false',
      PRODUCT_MODE: 'plm-workbench', DB_SSL: 'false', DB_POOL_MIN: '0', DB_POOL_MAX: '4', JWT_EXPIRY: '1h' })) setEnv(key, value)
    for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT']) setEnv(key, randomBytes(32).toString('hex'))
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    createMaterial = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore
    createDraft = (await load('plugins/plugin-integration-core/lib/yida-draft-plan-store.mjs')).createYidaDraftPlanStore as typeof createDraft
    createTarget = (await load('plugins/plugin-integration-core/lib/yida-approved-target-store.mjs')).createYidaApprovedTargetStore as typeof createTarget
    createBinding = (await load('plugins/plugin-integration-core/lib/yida-owner-runtime-factory.mjs')).createYidaOwnerRuntimeBinding as typeof createBinding
    compile = (await load('plugins/plugin-integration-core/lib/yida-draft-plan.mjs')).compileYidaDraft as typeof compile
    const nativePool = await load('packages/core-backend/src/integration/db/connection-pool.ts')
    hostPool = (nativePool.poolManager as { get(): NativePool }).get()
    auth = (await load('packages/core-backend/src/auth/AuthService.ts')).authService as Auth
    jwtMiddleware = (await load('packages/core-backend/src/auth/jwt-middleware.ts')).jwtAuthMiddleware as RequestHandler
    invalidateUserPerms = (await load('packages/core-backend/src/rbac/service.ts')).invalidateUserPerms as typeof invalidateUserPerms
    const SecurityClass = (await load('packages/core-backend/src/security/plugin-runtime-security-service.ts')).PluginRuntimeSecurityService as new () => Security
    security = new SecurityClass()
    createRuntime = (await load('packages/core-backend/src/integration/yida-owner-runtime.ts')).createYidaOwnerRuntime as typeof createRuntime
    if (options.initialization) {
      setEnv('LOG_LEVEL', 'info')
      createInitialization = (await load('packages/core-backend/src/integration/yida-initialization-runtime.ts')).createYidaInitializationRuntime as typeof createInitialization
      provisionInitialization = (await load('packages/core-backend/src/integration/yida-initialization-bootstrap.ts')).provisionYidaInitializationAnchor as typeof provisionInitialization
      createInitializationBinding = (await load('plugins/plugin-integration-core/lib/yida-initialization-producer.mjs')).createYidaInitializationBinding as typeof createInitializationBinding
      correlation = (await load('packages/core-backend/src/middleware/correlation.ts')).correlationIdMiddleware as RequestHandler
    }
    const route = await load('packages/core-backend/src/routes/integration-yida-owner.ts')
    createRouter = route.createIntegrationYidaOwnerRouter as typeof createRouter
    noStore = route.yidaOwnerNoStoreMiddleware as RequestHandler; jsonOnly = route.yidaOwnerJsonOnlyMiddleware as RequestHandler
    parseError = route.yidaOwnerParseErrorHandler as ErrorRequestHandler
    const current = await hostPool.query('SELECT current_schema() AS schema')
    if (current.rows[0]?.schema !== schema) throw new Error('SYNTHETIC_NATIVE_AUTH_POOL_SCHEMA_REQUIRED')
  } catch (error) { await cleanup(); throw error }
  const ddl = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
    '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
    '094_create_integration_yida_approved_target.sql', '095_create_integration_yida_send_approvals.sql',
    ...(options.initialization ? ['096_create_integration_yida_initialization.sql'] : [])]
    .map(name => readFileSync(path.join(root, 'packages/core-backend/migrations', name), 'utf8')).join('\n')
  return {
    sql, tokens, sessions, tokenPayloads, formPayloads, rows, proof, http, tokenFor, startRuntime, closeRuntime, cleanup,
    setEnablement(value: unknown) { enablement = value }, setFormOutcome(value: 'ack' | 'unknown') { formOutcome = value },
    get tokenCommitted() { return tokenCommitted }, get validRequests() { return validRequests },
    get seedDraft() { return seedDraft }, get runtime() { return runtime! },
    get initializationRuntime() { return initializationRuntime! },
    async initializationProof() {
      const tables = ['integration_yida_credential_materials', 'integration_yida_credential_audit', 'integration_yida_draft_targets',
        'integration_yida_draft_operations', 'integration_yida_draft_rows', 'integration_yida_draft_audit',
        'integration_yida_approved_target', 'integration_yida_approved_target_audit', 'integration_yida_initializations']
      const values = await Promise.all(tables.map(rows))
      return { counts: values.map(value => value.length), digest: createHash('sha256').update(JSON.stringify(values)).digest('hex') }
    },
    get origin() {
      const address = server?.address()
      if (!address || typeof address === 'string') throw new Error('SYNTHETIC_OWNED_LISTENER_REQUIRED')
      return `http://127.0.0.1:${address.port}`
    },
    compiledPayload(input: Input, ordinal: number) { return compile(input).plan.rows[ordinal].payload },
    async sqlAdmin(text: string, params?: unknown[]) { return admin!.query(text, params) },
    async revokeMaterial() { return createMaterial({ db: ownerDb, security, context: { tenantId: tenant,
      workspaceId: null, ownerId: principals.owner } }).revoke({ credentialRef, expectedGeneration: credentialGeneration }) },
    async reset() {
      await closeRuntime()
      if (client) { await client.query('ROLLBACK'); client.release(); client = undefined }
      if (schemaCreated) { await admin!.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schemaCreated = false }
      await admin!.query(`CREATE SCHEMA ${ident(schema)}`); schemaCreated = true
      await admin!.query(`SET search_path TO ${ident(schema)}`)
      await admin!.query(ddl)
      // Exact consumed auth/RBAC/session shapes: no absent-table fallback.
      await admin!.query(`
        CREATE TABLE users(id text PRIMARY KEY,email text,username text,mobile text,name text,role text,permissions jsonb,
          password_hash text,is_active boolean,must_change_password boolean,activation_status text,local_password_set boolean,
          is_admin boolean,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE user_roles(user_id text,role_id text,PRIMARY KEY(user_id,role_id));
        CREATE TABLE role_permissions(role_id text,permission_code text,PRIMARY KEY(role_id,permission_code));
        CREATE TABLE user_permissions(user_id text,permission_code text,PRIMARY KEY(user_id,permission_code));
        CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean,PRIMARY KEY(user_id,org_id));
        CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean,source text,granted_by text,
          updated_by text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,namespace));
        CREATE TABLE user_session_revocations(user_id text PRIMARY KEY,revoked_after timestamptz,updated_at timestamptz,
          updated_by text,reason text);
        CREATE TABLE user_sessions(id text PRIMARY KEY,user_id text,issued_at timestamptz,expires_at timestamptz,
          last_seen_at timestamptz,revoked_at timestamptz,revoked_by text,revoke_reason text,ip_address text,user_agent text,
          created_at timestamptz,updated_at timestamptz);
      `)
      for (const [key, actorId] of Object.entries(principals)) {
        await admin!.query(`INSERT INTO users(id,email,username,name,role,permissions,password_hash,is_active,
          must_change_password,activation_status,local_password_set,is_admin)
          VALUES($1,$2,$1,'Synthetic HTTP actor',$3,'[]','synthetic-unusable-hash',true,false,'activated',false,$4)`,
        [actorId, actorId + '@synthetic.invalid', key === 'otherOwner' ? 'admin' : 'user', key === 'otherOwner' || key === 'fakeRole'])
        await admin!.query('INSERT INTO user_orgs VALUES($1,$2,true)', [actorId, tenant])
        await admin!.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES($1,'integration',true)", [actorId])
        sessions[actorId] = randomUUID()
        await admin!.query(`INSERT INTO user_sessions(id,user_id,issued_at,expires_at,last_seen_at,created_at,updated_at)
          VALUES($1,$2,now(),now()+interval '1 hour',now(),now(),now())`, [sessions[actorId], actorId])
        invalidateUserPerms(actorId)
        tokens[key] = await tokenFor(actorId, tenant, key === 'otherOwner' || key === 'fakeRole' ? 'admin' : 'user')
      }
      await admin!.query('INSERT INTO user_orgs VALUES($1,$2,true)', [principals.owner, otherTenant])
      await admin!.query("INSERT INTO user_roles VALUES($1,'integration_admin'),($2,'admin'),($3,'integration_admin_display_only')",
        [principals.owner, principals.otherOwner, principals.fakeRole])
      await admin!.query("INSERT INTO user_permissions VALUES($1,'integration:admin')", [principals.owner])
      client = await adminPool.connect()
      await client.query(`SET search_path TO ${ident(schema)}`)
      await client.query("SET statement_timeout='10s'")
      ownerDb = createDb({ database: pluginDatabase })
      if (options.initialization) {
        credentialRef = ''; credentialGeneration = 0
        if (options.bootstrap !== false) await provisionInitialization({ database }, { ownerId: principals.owner, tenantId: tenant })
      } else {
        const owned = { db: ownerDb, security, context: { tenantId: tenant, workspaceId: null, ownerId: principals.owner } }
        // Keep the old send fixture's private pre-registration unchanged.
        const material = await createMaterial(owned).create({ material: syntheticMaterial() })
        credentialRef = material.credentialRef; credentialGeneration = material.credentialGeneration
        seedDraft = await createDraft(owned).createDraft(draftInput())
        await createTarget(owned).register({ operationId: seedDraft.operationId, credentialRef, credentialGeneration,
          attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-http-review',
            organizationId: 'synthetic-http-organization', executionIdentity: syntheticMaterial().userId } })
      }
      const current = await hostPool!.query('SELECT current_schema() AS schema')
      if (current.rows[0]?.schema !== schema) throw new Error('SYNTHETIC_NATIVE_AUTH_POOL_SCHEMA_REQUIRED')
      tokenPayloads.length = 0; formPayloads.length = 0; sql.length = 0
      enablement = 'false'; tokenCommitted = false; validRequests = true; formOutcome = 'ack'
      await startRuntime()
    },
  }
}
export type YidaOwnerHttpRealdbFixture = Awaited<ReturnType<typeof createYidaOwnerHttpRealdbFixture>>
