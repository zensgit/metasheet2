// Actual host live ACL + permanent anchor + native 090/091/092 producer + 094
// in fresh synthetic PG schemas. Not JWT/HTTP/frontend or deployment DB-role proof.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { Pool, type PoolClient } from 'pg'
import ts from 'typescript'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as authority from '../../src/integration/automation-live-authority'
import * as bootstrap from '../../src/integration/yida-initialization-bootstrap'
import { createYidaInitializationRuntime, type YidaInitializationRuntimeBinding, type YidaInitializationInput } from '../../src/integration/yida-initialization-runtime'
import { PluginRuntimeSecurityService } from '../../src/security/plugin-runtime-security-service'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('../utils/yida-native-module-import.cjs') as (url: string) => Promise<Record<string, unknown>>
const actor = Object.freeze({ actorId: 'synthetic-initialization-owner', tenantId: 'synthetic-initialization-tenant', workspaceId: null })
const secondAdmin = Object.freeze({ ...actor, actorId: 'synthetic-initialization-second-admin' })
const otherTenant = 'synthetic-initialization-other-tenant'
type Security = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Row = Record<string, unknown>
const tables = ['integration_yida_credential_materials', 'integration_yida_credential_audit', 'integration_yida_draft_targets',
  'integration_yida_draft_operations', 'integration_yida_draft_rows', 'integration_yida_draft_audit',
  'integration_yida_approved_target', 'integration_yida_approved_target_audit', 'integration_yida_initializations'] as const
const sendTables = ['integration_yida_send_approvals', 'integration_yida_send_admissions', 'integration_yida_send_revocations',
  'integration_yida_send_approval_audit', 'integration_yida_delivery_ledger', 'integration_yida_delivery_audit'] as const
const ident = (value: string) => { if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('OWNED_SCHEMA_REQUIRED'); return `"${value}"` }
const material = () => ({ appKey: ' synthetic-local-app ', appSecret: ' synthetic-local-secret ', systemToken: ' synthetic-local-token ', userId: 'synthetic-local-user' })
const attestation = () => ({ kind: 'owner-reviewed-target', reviewRef: 'synthetic-local-review', organizationId: 'synthetic-local-org', executionIdentity: material().userId })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const rejected = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code: `YIDA_INITIALIZATION_${code}` })
it('sentinel: real initialization proof requires EXPECT_DB=1 and dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const realdb = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip
realdb('Approved A initialization — actual PG/live ACL/native producer/transaction', () => {
  let pool: Pool, admin: PoolClient, schema = '', ddl: string, security: Security
  let createBinding: (options: { security: Security }) => YidaInitializationRuntimeBinding
  let example: () => { config: unknown; text: string }
  const running: ReturnType<typeof createYidaInitializationRuntime>[] = []
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let savedEnv: Array<[typeof envKeys[number], string | undefined]>
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const sql: string[] = [], commits: string[] = []
  async function counts() {
    return Promise.all(tables.map(async table => Number((await admin.query(`SELECT COUNT(*) AS count FROM ${ident(table)}`)).rows[0].count)))
  }
  async function noSend() {
    for (const table of sendTables) expect(Number((await admin.query(`SELECT COUNT(*) AS count FROM ${ident(table)}`)).rows[0].count)).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  }
  function database(options: { commitGate?: () => Promise<void>; lostCommit?: boolean; autocommit?: boolean;
    afterQuery?: (text: string) => void; isolation?: string } = {}): bootstrap.YidaInitializationDatabase {
    return { async transaction<T>(work: (trx: Queryable) => Promise<T>) {
      const client = await pool.connect(); let committed = false
      try {
        await client.query(`SET search_path TO ${ident(schema)}`)
        await client.query("SET statement_timeout = '10s'")
        if (!options.autocommit) {
          await client.query('BEGIN')
          await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation === 'serializable' ? 'SERIALIZABLE' : 'READ COMMITTED'}`)
        }
        const query: Queryable['query'] = async (text, params) => {
          sql.push(text)
          const result = await client.query(text, params)
          options.afterQuery?.(text)
          return { rows: result.rows, rowCount: result.rowCount }
        }
        const result = await work(Object.assign({ query }, options.autocommit ? { isTransaction: true } : {}))
        await options.commitGate?.()
        if (!options.autocommit) { await client.query('COMMIT'); committed = true; commits.push('COMMIT') }
        if (options.lostCommit) throw new Error('synthetic acknowledgement loss after actual COMMIT')
        return result
      } catch (error) {
        if (!committed && !options.autocommit) await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    } }
  }
  async function active(options: Parameters<typeof database>[0] = {}, suppliedSecurity = security,
    factory = createYidaInitializationRuntime, suppliedBinding?: YidaInitializationRuntimeBinding) {
    const db = database(options), runtime = factory({ database: db, security: suppliedSecurity })
    running.push(runtime)
    const exactSecurity = Object.freeze({ encrypt: suppliedSecurity.encrypt.bind(suppliedSecurity), decrypt: suppliedSecurity.decrypt.bind(suppliedSecurity) })
    const binding = suppliedBinding ?? createBinding({ security: exactSecurity })
    const registration = await runtime.createPluginCapability().activate(binding)
    return { db, runtime, registration }
  }
  async function provision(db = database(), identity = actor) {
    return bootstrap.provisionYidaInitializationAnchor({ database: db }, { ownerId: identity.actorId, tenantId: identity.tenantId })
  }
  function input(commandId: string): YidaInitializationInput {
    const source = example()
    return { commandId, material: material(), draft: { config: source.config, rowsText: source.text, allocation: { mode: 'original' } }, attestation: attestation() }
  }
  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    const producer = await importNative(pathToFileURL(path.join(lib, 'yida-initialization-producer.mjs')).href)
    createBinding = producer.createYidaInitializationBinding as typeof createBinding
    example = (await importNative(pathToFileURL(path.join(lib, 'yida-static-plan.mjs')).href)).createYidaProtocolExample as typeof example
    ddl = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql', '095_create_integration_yida_send_approvals.sql',
      '096_create_integration_yida_initialization.sql'].map(name => readFileSync(path.join(root, 'packages/core-backend/migrations', name), 'utf8')).join('\n')
    savedEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'; process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    security = new PluginRuntimeSecurityService()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000,
      application_name: 'yida_initialization_synthetic' })
    admin = await pool.connect()
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NO_EXTERNAL_IO') })
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_initialization_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE SCHEMA ${ident(schema)}`); await admin.query(`SET search_path TO ${ident(schema)}`)
    await admin.query(`CREATE TABLE user_roles(user_id text,role_id text);
      CREATE TABLE role_permissions(role_id text,permission_code text);
      CREATE TABLE user_permissions(user_id text,permission_code text);
      CREATE TABLE users(id text PRIMARY KEY,role text,is_active boolean,activation_status text,permissions jsonb);
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean);
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean)`)
    await admin.query(ddl)
    for (const principal of [actor, secondAdmin]) {
      await admin.query("INSERT INTO users VALUES($1,'admin',true,'activated','[]')", [principal.actorId])
      await admin.query("INSERT INTO user_roles VALUES($1,'admin')", [principal.actorId])
      for (const tenantId of [actor.tenantId, otherTenant]) await admin.query('INSERT INTO user_orgs VALUES($1,$2,true)', [principal.actorId, tenantId])
    }
    sql.length = 0; commits.length = 0; fetchSpy.mockClear()
  }, 30000)
  afterEach(async () => {
    await Promise.all(running.splice(0).map(runtime => runtime.stop()))
    expect(fetchSpy).not.toHaveBeenCalled()
    if (schema) { await admin.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  }, 30000)
  afterAll(async () => {
    try { fetchSpy?.mockRestore(); admin?.release(); await pool?.end() }
    finally { for (const [key, value] of savedEnv ?? []) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  }, 30000)

  it('provisions persistent owner command once and atomically initializes actual encrypted 090/091/092 + result while OFF', async () => {
    const anchor = await provision(), repeated = await provision()
    expect(repeated).toEqual(anchor)
    await rejected(bootstrap.provisionYidaInitializationAnchor({ database: database() }, { ownerId: secondAdmin.actorId, tenantId: actor.tenantId }), 'CONFLICT')
    const { runtime } = await active()
    expect(await runtime.status(actor)).toEqual({ commandId: anchor.commandId, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
    sql.length = 0; commits.length = 0
    const result = await runtime.initialize(actor, input(anchor.commandId))
    expect(result).toMatchObject({ commandId: anchor.commandId, status: 'initialized', draft: { status: 'unverified', reused: false }, canSend: false, tokenIssued: false, externalWriteAttempted: false })
    expect(await counts()).toEqual([1, 1, 1, 1, 2, 1, 1, 1, 1])
    expect(commits).toEqual(['COMMIT'])
    expect(sql.filter(text => text.includes('pg_advisory_xact_lock'))).toHaveLength(1)
    expect(sql.some(text => /(?:INSERT|UPDATE|DELETE).*integration_yida_initialization_anchor/u.test(text))).toBe(false)
    expect((await runtime.status(actor)).draft?.reused).toBe(true)
    await rejected(runtime.initialize(actor, input(anchor.commandId)), 'CONFLICT')
    expect(await counts()).toEqual([1, 1, 1, 1, 2, 1, 1, 1, 1]); await noSend()
    const persisted = (await admin.query('SELECT material_encrypted FROM integration_yida_credential_materials')).rows[0]
    const clear = JSON.parse(await security.decrypt(persisted.material_encrypted)) as Row
    expect(clear).toMatchObject({ material: material() })
    const dto = JSON.stringify(result)
    for (const hidden of [...Object.values(material()), attestation().organizationId]) expect(dto.includes(hidden)).toBe(false)
  })
  it('second actual qualified admin and alternate actual membership tenant cannot read ready or initialize', async () => {
    const anchor = await provision(), { runtime } = await active()
    await rejected(runtime.status(secondAdmin), 'DENIED')
    await rejected(runtime.status({ ...actor, tenantId: otherTenant }), 'DENIED')
    await rejected(runtime.initialize(secondAdmin, input(anchor.commandId)), 'DENIED')
    expect(await counts()).toEqual(Array(9).fill(0)); await noSend()
    expect(sql.some(text => text.includes('FROM integration_yida_initializations'))).toBe(false)
  })
  it('actual second-admin empty-slot GET isolates and kills removal of the runtime anchor equality guard', async () => {
    await provision()
    const source = readFileSync(path.join(root, 'packages/core-backend/src/integration/yida-initialization-runtime.ts'), 'utf8')
    const guard = "if (anchor.owner_id !== actor.actorId || anchor.tenant_id !== actor.tenantId) fail('DENIED')"
    expect(source.split(guard)).toHaveLength(2)
    const code = ts.transpileModule(source.replace(guard, '// mutation: remove anchor comparison'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: { createYidaInitializationRuntime?: typeof createYidaInitializationRuntime } = {}
    new Function('require', 'exports', code)((specifier: string) => {
      if (specifier === 'node:util') return { types }
      if (specifier === './automation-live-authority') return authority
      if (specifier === './yida-initialization-bootstrap') return bootstrap
      throw new Error('Unexpected mutated module dependency')
    }, exports)
    const original = await active(); await rejected(original.runtime.status(secondAdmin), 'DENIED')
    const mutant = await active({}, security, exports.createYidaInitializationRuntime!)
    expect((await mutant.runtime.status(secondAdmin)).status).toBe('ready')
    expect(await counts()).toEqual(Array(9).fill(0))
  })
  it('missing anchor, missing membership and revoked actual admin all refuse before writers', async () => {
    const { runtime } = await active()
    await rejected(runtime.status(actor), 'UNAVAILABLE')
    const anchor = await provision()
    await admin.query('DELETE FROM user_orgs WHERE user_id=$1 AND org_id=$2', [actor.actorId, actor.tenantId])
    await rejected(runtime.initialize(actor, input(anchor.commandId)), 'DENIED')
    await admin.query('INSERT INTO user_orgs VALUES($1,$2,true)', [actor.actorId, actor.tenantId])
    await runtime.status(actor)
    await admin.query('DELETE FROM user_roles WHERE user_id=$1', [actor.actorId]); await admin.query("UPDATE users SET role='user' WHERE id=$1", [actor.actorId])
    await rejected(runtime.initialize(actor, input(anchor.commandId)), 'DENIED')
    expect(await counts()).toEqual(Array(9).fill(0)); await noSend()
  })
  it('real autocommit forged marker and wrong isolation do not qualify as actual transactions', async () => {
    const anchor = await provision()
    for (const options of [{ autocommit: true }, { isolation: 'serializable' }]) {
      const { runtime } = await active(options)
      await rejected(runtime.initialize(actor, input(anchor.commandId)), 'UNAVAILABLE')
    }
    expect(await counts()).toEqual(Array(9).fill(0)); await noSend()
  })
  it('real first material INSERT cannot survive a later awaited crypto failure in same transaction', async () => {
    const anchor = await provision(); let encrypts = 0
    const failedSecurity = { encrypt: async (value: string) => {
      if (++encrypts === 2) throw new Error('synthetic second encryption failure')
      return security.encrypt(value)
    }, decrypt: security.decrypt.bind(security) }
    const { runtime } = await active({}, failedSecurity)
    await rejected(runtime.initialize(actor, input(anchor.commandId)), 'UNAVAILABLE')
    expect(sql.some(text => /INSERT INTO "integration_yida_credential_materials"/u.test(text))).toBe(true)
    expect(await counts()).toEqual(Array(9).fill(0)); await noSend()
  })
  it.each(['integration_yida_credential_audit', 'integration_yida_draft_audit', 'integration_yida_approved_target_audit'])('actual %s INSERT failure rolls back all three writers and initialization result', async audit => {
    const anchor = await provision(), { runtime } = await active()
    await admin.query("CREATE FUNCTION synthetic_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END; $$")
    await admin.query(`CREATE TRIGGER synthetic_fail_audit BEFORE INSERT ON ${ident(audit)} FOR EACH ROW EXECUTE FUNCTION synthetic_fail_audit()`)
    await rejected(runtime.initialize(actor, input(anchor.commandId)), 'UNAVAILABLE')
    expect(sql.some(text => text.includes(`INSERT INTO "${audit}"`))).toBe(true)
    expect(await counts()).toEqual(Array(9).fill(0)); await noSend()
    expect((await runtime.status(actor)).status).toBe('ready')
  })
  it('legacy actual target without initialization result is unconfirmed, never ready', async () => {
    const anchor = await provision(), { db, runtime } = await active()
    const exactSecurity = { encrypt: security.encrypt.bind(security), decrypt: security.decrypt.bind(security) }
    await db.transaction(trx => createBinding({ security: exactSecurity }).createInitializationProducer(actor).initializeInTransaction(trx, input(anchor.commandId)))
    await rejected(runtime.status(actor), 'UNAVAILABLE')
    await rejected(runtime.initialize(actor, input(anchor.commandId)), 'UNAVAILABLE')
    expect(await counts()).toEqual([1, 1, 1, 1, 2, 1, 1, 1, 0]); await noSend()
  })
  it('host rejects forged row metadata even after actual producer writes, rolling back all tables', async () => {
    const anchor = await provision(), underlying = createBinding({ security: {
      encrypt: security.encrypt.bind(security), decrypt: security.decrypt.bind(security) } })
    const binding: YidaInitializationRuntimeBinding = { createInitializationProducer(context) {
      const producer = underlying.createInitializationProducer(context)
      return { inspectDraftInTransaction: producer.inspectDraftInTransaction,
        async initializeInTransaction(trx, supplied) {
          const actual = await producer.initializeInTransaction(trx, supplied)
          return { ...actual, draft: { ...(actual.draft as Row), rows: [{ rowKey: randomUUID(), index: 0 }] } }
        } }
    } }
    const { runtime } = await active({}, security, createYidaInitializationRuntime, binding)
    await rejected(runtime.initialize(actor, input(anchor.commandId)), 'UNAVAILABLE')
    expect(await counts()).toEqual(Array(9).fill(0)); await noSend()
  })
  it('lost actual COMMIT acknowledgement is unavailable; explicit later status recovers initialized without retry', async () => {
    const anchor = await provision(), unknown = await active({ lostCommit: true })
    await rejected(unknown.runtime.initialize(actor, input(anchor.commandId)), 'UNAVAILABLE')
    expect(await counts()).toEqual([1, 1, 1, 1, 2, 1, 1, 1, 1])
    const normal = await active()
    expect((await normal.runtime.status(actor)).status).toBe('initialized')
    await rejected(normal.runtime.initialize(actor, input(anchor.commandId)), 'CONFLICT')
    expect(await counts()).toEqual([1, 1, 1, 1, 2, 1, 1, 1, 1]); await noSend()
  })
  it('status waits on the actual cross-session advisory barrier through COMMIT and stop drains actual commit', async () => {
    const anchor = await provision(), entered = deferred(), release = deferred()
    const first = await active({ commitGate: async () => { entered.resolve(); await release.promise } }), second = await active()
    const pending = first.runtime.initialize(actor, input(anchor.commandId)); await entered.promise
    let settled = false
    const status = second.runtime.status(actor).then(result => { settled = true; return result })
    // Evidence is PostgreSQL's actual lock wait, not a guessed sleep or fake gate.
    const deadline = Date.now() + 3000; let waiting = false
    while (Date.now() < deadline) {
      const locks = await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name='yida_initialization_synthetic' AND wait_event='advisory'")
      if (locks.rows.length) { waiting = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(waiting).toBe(true); expect(settled).toBe(false)
    let drained = false
    const drain = first.runtime.stop().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    release.resolve(); await rejected(pending, 'CANCELLED'); await drain
    expect((await status).status).toBe('initialized'); expect(drained).toBe(true)
    expect(await counts()).toEqual([1, 1, 1, 1, 2, 1, 1, 1, 1]); await noSend()
  })
  it('actual 094 anchor/result immutable guards reject UPDATE DELETE TRUNCATE and retain permanent slot', async () => {
    const anchor = await provision(), { runtime } = await active()
    await runtime.initialize(actor, input(anchor.commandId))
    for (const table of ['integration_yida_initialization_anchor', 'integration_yida_initializations']) {
      for (const text of [`UPDATE ${ident(table)} SET command_id=command_id`, `DELETE FROM ${ident(table)}`, `TRUNCATE ${ident(table)} CASCADE`]) {
        await expect(admin.query(text)).rejects.toMatchObject({ code: '55000' })
      }
    }
    expect((await runtime.status(actor)).status).toBe('initialized')
    expect(await counts()).toEqual([1, 1, 1, 1, 2, 1, 1, 1, 1]); await noSend()
  })
})
