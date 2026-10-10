// Actual native core authority + private material/readers + token client/exchange,
// runner, form transport and 088-093. Only the explicit fetch returns synthetic
// native Responses: it cannot access a network. No HTTP/JWT/full-app claim.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { createYidaSendApprovalService, YidaSendApprovalMetadata } from '../../src/integration/yida-send-approval-service'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('../utils/yida-native-module-import.cjs')
const APPROVAL = 'integration_yida_send_approvals', REVOCATION = 'integration_yida_send_revocations'
const ADMISSION = 'integration_yida_send_admissions', AUDIT = 'integration_yida_send_approval_audit'
const LEDGER = 'integration_yida_delivery_ledger', LEDGER_AUDIT = 'integration_yida_delivery_audit'
const OP = 'integration_yida_draft_operations', TARGET = 'integration_yida_approved_target'
const PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const proofTables = [APPROVAL, REVOCATION, ADMISSION, AUDIT, LEDGER, LEDGER_AUDIT]
type Row = Record<string, unknown>
type Context = { tenantId: string; workspaceId: null; ownerId: string }
type HostSecurity = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Approvals = ReturnType<typeof createYidaSendApprovalService>
type Approval = YidaSendApprovalMetadata & { reused: boolean }
type Delivery = { id: string; status: string; durable: true }
type Observation = { approval: YidaSendApprovalMetadata; delivery: Delivery | null }
type Handle = { context: Row; operation: Row; credentialBinding: Row
  resolveExecutionSnapshot(identity: unknown, options: { signal: AbortSignal }): Promise<Row>
  loadCredential(binding: unknown, options: { signal: AbortSignal }): Promise<Row>; close(): void }
type Authority = { approvals: Approvals; admitForExecution(input: unknown): Promise<{ approval: Approval; permit: object | null }>
  takeExecution(permit: unknown): Handle; observe(input: unknown): Promise<Observation> }
type Submit = Observation & { reused: boolean; status: string; externalWriteAttempted: boolean; businessVerified: false; durable: boolean }
type Port = { submit(input: unknown, options?: { signal?: AbortSignal }): Promise<Submit>; inspect(input: unknown): Promise<Observation> }
type Database = { query(sql: string, params?: unknown[]): Promise<Row[]>
  transaction<T>(callback: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T> }
type Draft = { operationId: string; rows: Array<{ rowKey: string; index: number }> }
type DraftStore = { createDraft(input: unknown): Promise<Draft> }
type MaterialStore = { create(input: unknown): Promise<{ credentialRef: string; credentialGeneration: number }>
  rotate(input: unknown): Promise<unknown>; revoke(input: unknown): Promise<unknown> }
type TargetStore = { register(input: unknown): Promise<{ targetRef: string }> }
type LedgerStore = { prepare(input: unknown): Promise<{ record: Row; reused: boolean }> }
type Input = { config: Row; rowsText: string; allocation: Row }
type Compiled = { plan: { rows: Array<{ payload: Row }> } }
type Gate = { reached: Promise<void>; release(): void }
type Latch = Gate & { enter(): void; open: Promise<void> }
type FetchDouble = { fetch: (url: string, init: RequestInit) => Promise<Response>; token: number; form: number
  requestValid: boolean; formPayload: Row | null; tokenCommitted: boolean; gateToken(): Gate; gateForm(): Gate; release(): void }
type Stage = 'admission' | 'claim' | 'other'
type Session = { client: PoolClient; pid: number; db: unknown; authority: Authority; draft: DraftStore
  target: TargetStore; material: MaterialStore; ledger: LedgerStore; statements: string[]
  port(http: FetchDouble, enablement?: (() => unknown) | null, timeoutMs?: number): Port
  gateCommit(stage: Stage): Gate; gateRead(table: string, occurrence?: number): Gate; release(): void; loseCommit(stage: Stage): void }
type Fixture = { draft: Draft; credentialRef: string; credentialGeneration: number; targetRef: string; input: Input
  grant: Approval; request: { grantId: string; submissionId: string } }

it('sentinel: owner send proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('SA05 internal owner send port — actual authority and synthetic-only fetch', () => {
  let pool: Pool, owner: PoolClient, first: Session, second: Session, security: HostSecurity
  let schema = '', ddl = ''
  let createDb: (options: { database: Database }) => unknown
  let createAuthority: (options: { database: { transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> }
    security: HostSecurity; context: { actorId: string; tenantId: string; workspaceId: null }; primitives: unknown }) => Authority
  let createPrimitives: (options: { security: HostSecurity; context: Context }) => unknown
  let createPort: (options: { db: unknown; context: Row; authority: Authority; fetch: FetchDouble['fetch']
    readEnablement?: () => unknown; timeoutMs?: number }) => Port
  let createDraft: (options: { db: unknown; security: HostSecurity; context: Context }) => DraftStore
  let createTarget: (options: { db: unknown; security: HostSecurity; context: Context }) => TargetStore
  let createMaterial: (options: { db: unknown; security: HostSecurity; context: Context }) => MaterialStore
  let createLedger: (options: { db: unknown }) => LedgerStore
  let compile: (input: Input) => Compiled
  let canonical: (input: unknown) => string
  const sessions: Session[] = [], doubles: FetchDouble[] = []
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let savedEnv: Array<[typeof envKeys[number], string | undefined]> = []
  const context = (patch: Partial<Context> = {}): Context => ({ tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', ...patch })
  const material = () => ({ appKey: ' synthetic-owner-port-app ', appSecret: ' synthetic-owner-port-secret ',
    systemToken: ' synthetic-owner-port-system ', userId: 'synthetic-executor' })
  function input(mode = 'original', quantity = 6): Input {
    return { config: { version: 2, kind: 'yida-form-protocol-static', intent: 'create',
      target: { appType: 'synthetic_owner_app', formUuid: 'synthetic_owner_form' },
      businessKey: ['projectNo', 'lineId', 'parentCode'], emptyKeyFields: ['parentCode'],
      fieldCatalog: [
        { id: 'project', control: 'text', required: true }, { id: 'line', control: 'text', required: true },
        { id: 'parent', control: 'text', required: false }, { id: 'qty', control: 'number', required: true },
        { id: 'description', control: 'text', required: false },
      ],
      fieldMap: [
        { source: 'projectNo', target: 'project', type: 'string', required: true },
        { source: 'lineId', target: 'line', type: 'string', required: true },
        { source: 'parentCode', target: 'parent', type: 'string', required: false },
        { source: 'quantity', target: 'qty', type: 'number', required: true },
        { source: 'description', target: 'description', type: 'string', required: false },
      ],
    }, rowsText: JSON.stringify([{ projectNo: 'DEMO-P1', lineId: 'LINE-1', parentCode: null,
      quantity, description: 'synthetic owner port part' }]),
    allocation: mode === 'original' ? { mode } : { mode, projects: ['DEMO-P1', 'DEMO-P2', 'DEMO-P3'],
      projectField: 'projectNo', quantityField: 'quantity' } }
  }
  const ident = (value: string) => {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('SYNTHETIC_IDENTIFIER_REQUIRED')
    return `"${value}"`
  }
  const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NO_FIXED_CODE'
  const outcome = async (promise: Promise<unknown>) => {
    try { await promise; return { ok: true as const } }
    catch (error) { return { ok: false as const, code: codeOf(error) } }
  }
  function assertError(error: unknown, code: string) {
    expect(codeOf(error)).toBe(code)
    expect((error as Error)?.message).toBe(code)
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name'])
    expect('cause' in (error as object)).toBe(false)
  }
  async function rejected(promise: Promise<unknown>, code = 'YIDA_OWNER_SEND_UNAVAILABLE') {
    let caught: unknown
    try { await promise } catch (error) { caught = error }
    assertError(caught, code)
  }
  function rejectedSync(callback: () => unknown, code = 'YIDA_SEND_APPROVAL_CONFLICT') {
    let caught: unknown
    try { callback() } catch (error) { caught = error }
    assertError(caught, code)
  }
  const tableRows = async (table: string) => (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY 1`)).rows as Row[]
  async function evidence() {
    const rows = await Promise.all(proofTables.map(tableRows))
    return { counts: rows.map(value => value.length), digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
  }
  function latch(): Latch {
    let enter!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { enter = resolve }), open = new Promise<void>(resolve => { release = resolve })
    return { reached, open, enter, release }
  }
  async function reached(gate: Gate) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([gate.reached, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SYNTHETIC_GATE_TIMEOUT')), 5000)
    })]) } finally { clearTimeout(timer) }
  }
  async function blocked(waiter: Session, holder: Session) {
    expect(waiter.pid !== holder.pid).toBe(true)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const result = await owner.query("SELECT wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1", [waiter.pid, holder.pid])
      if (result.rows[0]?.blocked === true) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('SYNTHETIC_PG_LOCK_NOT_OBSERVED')
  }
  function http(): FetchDouble {
    let tokenGate: Latch | undefined, formGate: Latch | undefined
    const value: FetchDouble = { token: 0, form: 0, requestValid: true, formPayload: null, tokenCommitted: false,
      async fetch(url, init) {
        // Fixed synthetic implementation; never calls global fetch or opens a socket.
        value.requestValid &&= init.method === 'POST' && init.redirect === 'error'
        if (url.endsWith('/v1.0/oauth2/accessToken')) {
          value.token++
          const body = JSON.parse(String(init.body)) as Row
          value.requestValid &&= body.appKey === material().appKey && body.appSecret === material().appSecret
          const rows = await tableRows(ADMISSION), ledger = await tableRows(LEDGER)
          value.tokenCommitted = rows.length === 1 && ledger.length === 1 && ledger[0].status === 'prepared'
          if (tokenGate) { tokenGate.enter(); await tokenGate.open }
          return new Response(JSON.stringify({ accessToken: 'synthetic-token', expireIn: 3600 }), { status: 200 })
        }
        if (url.endsWith('/v1.0/yida/forms/instances')) {
          value.form++
          const body = JSON.parse(String(init.body)) as Row
          value.formPayload = JSON.parse(String(body.formDataJson)) as Row
          value.requestValid &&= body.systemToken === material().systemToken && body.userId === material().userId
            && (init.headers as Record<string, string>)['x-acs-dingtalk-access-token'] === 'synthetic-token'
          if (formGate) { formGate.enter(); await formGate.open }
          return new Response(JSON.stringify({ result: 'synthetic-instance' }), { status: 201 })
        }
        throw new Error('SYNTHETIC_UNEXPECTED_FETCH')
      },
      gateToken() { tokenGate = latch(); return tokenGate }, gateForm() { formGate = latch(); return formGate },
      release() { tokenGate?.release(); formGate?.release() },
    }
    doubles.push(value); return value
  }
  async function session(scope = context()): Promise<Session> {
    const client = await pool.connect()
    await client.query(`SET search_path TO ${ident(schema)}`)
    await client.query("SET statement_timeout='10s'")
    await client.query("SET default_transaction_isolation='repeatable read'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = []
    let stage: Stage = 'other', lostStage: Stage | undefined
    let commitGate: (Latch & { stage: Stage }) | undefined, readGate: (Latch & { table: string; remaining: number }) | undefined
    const query: Queryable['query'] = async (sql, params) => {
      statements.push(sql) // Shapes only. No values or driver errors retained.
      if (sql === 'BEGIN') stage = 'other'
      if (/^INSERT INTO/i.test(sql.trim()) && sql.includes(ADMISSION)) stage = 'admission'
      if (/^UPDATE/i.test(sql.trim()) && sql.includes(LEDGER) && params?.includes('dispatching')) stage = 'claim'
      if (readGate && /^SELECT/i.test(sql.trim()) && sql.includes(readGate.table) && --readGate.remaining === 0) {
        const held = readGate; held.enter(); await held.open
        if (readGate === held) readGate = undefined
      }
      const result = await client.query(sql, params)
      if (sql === 'COMMIT' && commitGate?.stage === stage) {
        const held = commitGate; held.enter(); await held.open
        if (commitGate === held) commitGate = undefined
      }
      return { rows: result.rows as Row[], rowCount: result.rowCount }
    }
    const database = { async transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> {
      await query('BEGIN')
      try {
        const result = await callback({ query }); await query('COMMIT')
        if (lostStage === stage) { lostStage = undefined; throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST') }
        return result
      } catch (error) { await query('ROLLBACK'); throw error }
    } }
    const pluginDatabase: Database = { query: async (sql, params) => (await query(sql, params)).rows,
      transaction: callback => database.transaction(trx => callback({ query: async (sql, params) => (await trx.query(sql, params)).rows })) }
    const db = createDb({ database: pluginDatabase }), config = { db, security, context: scope }
    const authority = createAuthority({ database, security, context: { actorId: scope.ownerId, tenantId: scope.tenantId, workspaceId: null },
      primitives: createPrimitives({ security, context: scope }) })
    const value: Session = { client, pid, db, authority, statements, draft: createDraft(config), target: createTarget(config),
      material: createMaterial(config), ledger: createLedger({ db }),
      port(fake, enablement = () => 'true', timeoutMs = 10000) {
        return createPort({ db, context: { ...scope, actorId: scope.ownerId }, authority, fetch: fake.fetch,
          ...(enablement === null ? {} : { readEnablement: enablement }), timeoutMs })
      }, gateCommit(heldStage) { commitGate = { ...latch(), stage: heldStage }; return commitGate },
      gateRead(table, occurrence = 1) {
        ident(table)
        if (!Number.isInteger(occurrence) || occurrence < 1) throw new Error('SYNTHETIC_GATE_OCCURRENCE_REQUIRED')
        readGate = { ...latch(), table, remaining: occurrence }; return readGate
      },
      release() { commitGate?.release(); readGate?.release() }, loseCommit(heldStage) { lostStage = heldStage },
    }
    sessions.push(value); return value
  }
  async function fixture(value = input(), ordinal = 0, ttlMs = 900000): Promise<Fixture> {
    const draft = await first.draft.createDraft(value), secret = await first.material.create({ material: material() })
    const target = await first.target.register({ operationId: draft.operationId, credentialRef: secret.credentialRef,
      credentialGeneration: secret.credentialGeneration, attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review',
        organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' } })
    const grant = await first.authority.approvals.approve({ operationId: draft.operationId, rowKey: draft.rows[ordinal].rowKey,
      confirmationId: 'synthetic-confirmation', ttlMs })
    return { draft, ...secret, targetRef: target.targetRef, input: value, grant,
      request: { grantId: grant.grantId, submissionId: 'synthetic-submission' } }
  }
  async function corrupt(table: string, trigger: string, column: string, value: unknown) {
    await owner.query('BEGIN')
    try {
      await owner.query(`ALTER TABLE ${ident(table)} DISABLE TRIGGER ${ident(trigger)}`)
      await owner.query(`UPDATE ${ident(table)} SET ${ident(column)}=$1`, [value])
      await owner.query(`ALTER TABLE ${ident(table)} ENABLE TRIGGER ${ident(trigger)}`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
  }
  async function privateHandle(f: Fixture) {
    const result = await first.authority.admitForExecution(f.request)
    expect(result.approval.reused === false && result.permit !== null).toBe(true)
    const handle = first.authority.takeExecution(result.permit)
    return { result, handle, identity: { ...handle.context, ...handle.operation }, options: { signal: new AbortController().signal } }
  }

  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    createMaterial = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore
    createLedger = requireCjs(path.join(lib, 'yida-delivery-store.cjs')).createYidaDeliveryStore
    canonical = requireCjs(path.join(lib, 'gip-canonical-json.cjs')).stableCanonicalStringify
    createDraft = (await importNative(pathToFileURL(path.join(lib, 'yida-draft-plan-store.mjs')).href)).createYidaDraftPlanStore
    createTarget = (await importNative(pathToFileURL(path.join(lib, 'yida-approved-target-store.mjs')).href)).createYidaApprovedTargetStore
    createPrimitives = (await importNative(pathToFileURL(path.join(lib, 'yida-send-authority-primitives.mjs')).href)).createYidaSendAuthorityPrimitives
    createPort = (await importNative(pathToFileURL(path.join(lib, 'yida-owner-send-port.mjs')).href)).createYidaOwnerSendPort
    compile = (await importNative(pathToFileURL(path.join(lib, 'yida-draft-plan.mjs')).href)).compileYidaDraft
    createAuthority = (await importNative(pathToFileURL(path.join(root,
      'packages/core-backend/src/integration/yida-send-approval-service.ts')).href)).createInternalYidaSendExecutionAuthority
    ddl = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql', '095_create_integration_yida_send_approvals.sql']
      .map(name => readFileSync(path.join(root, 'packages/core-backend/migrations', name), 'utf8')).join('\n')
    savedEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'; process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    const { PluginRuntimeSecurityService } = await importNative(pathToFileURL(path.join(root,
      'packages/core-backend/src/security/plugin-runtime-security-service.ts')).href) as { PluginRuntimeSecurityService: new () => HostSecurity }
    security = new PluginRuntimeSecurityService()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 9, connectionTimeoutMillis: 5000 })
    owner = await pool.connect(); await owner.query("SET statement_timeout='10s'")
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_owner_port_' + randomUUID().replaceAll('-', '')
    await owner.query(`CREATE SCHEMA ${ident(schema)}`); await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl)
    // Only the six consumed ACL table shapes, not all user/auth migrations.
    await owner.query(`
      CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean,
        activation_status text, local_password_set boolean, is_admin boolean);
      CREATE TABLE user_roles (user_id varchar(255),role_id varchar(255),PRIMARY KEY(user_id,role_id));
      CREATE TABLE role_permissions (role_id varchar(255),permission_code varchar(255),PRIMARY KEY(role_id,permission_code));
      CREATE TABLE user_permissions (user_id varchar(255),permission_code varchar(255),PRIMARY KEY(user_id,permission_code));
      CREATE TABLE user_orgs (user_id text,org_id text,is_active boolean NOT NULL,PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_namespace_admissions (user_id text,namespace text,enabled boolean NOT NULL DEFAULT false,UNIQUE(user_id,namespace));
      INSERT INTO users VALUES ('synthetic-owner','user','[]',true,'activated',false,false),
        ('synthetic-other-actor','admin','["role:admin"]',true,'activated',false,true);
      INSERT INTO user_roles VALUES ('synthetic-owner','integration_admin'),('synthetic-other-actor','admin'),('synthetic-other-actor','foreign_admin');
      INSERT INTO role_permissions VALUES ('foreign_admin','integration:admin'),('foreign_admin','role:admin');
      INSERT INTO user_permissions VALUES ('synthetic-owner','integration:admin'),('synthetic-other-actor','role:admin');
      INSERT INTO user_orgs VALUES ('synthetic-owner','synthetic-tenant',true),('synthetic-owner','synthetic-other-tenant',true),
        ('synthetic-other-actor','synthetic-tenant',true);
      INSERT INTO user_namespace_admissions VALUES ('synthetic-owner','integration',true),('synthetic-other-actor','integration',true);
    `)
    first = await session(); second = await session()
  }, 30000)
  afterEach(async () => {
    for (const value of doubles) value.release()
    for (const active of sessions) active.release()
    for (const active of sessions) { await active.client.query('ROLLBACK').catch(() => {}); active.client.release() }
    sessions.length = 0; doubles.length = 0
    if (schema) { await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  })
  afterAll(async () => {
    try {
      if (owner) { if (schema) await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); owner.release() }
      await pool?.end()
    } finally { for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  })

  it.each(['original', 'equal_integer', 'equal_decimal_exact'])('confirmed admission drives one actual token/claim/form/ACK, then refresh only observes: %s', async mode => {
    const ordinal = mode === 'original' ? 0 : 2
    const f = await fixture(input(mode, mode === 'equal_decimal_exact' ? 0.3 : 6), ordinal)
    const fake = http(), port = first.port(fake)
    const initial = await port.inspect({ grantId: f.grant.grantId })
    expect(initial.delivery === null && initial.approval.remainingAttempts === 1 && initial.approval.canSend === false).toBe(true)
    expect([fake.token, fake.form]).toEqual([0, 0])
    expect((await evidence()).counts).toEqual([1, 0, 0, 1, 0, 0])
    first.statements.length = 0
    const result = await port.submit(f.request)
    expect([result.status, result.reused, result.externalWriteAttempted, result.businessVerified, result.durable])
      .toEqual(['acknowledged', false, true, false, true])
    expect([fake.token, fake.form, fake.requestValid, fake.tokenCommitted]).toEqual([1, 1, true, true])
    expect(canonical(fake.formPayload) === canonical(compile(f.input).plan.rows[ordinal].payload)).toBe(true)
    expect(fake.formPayload?.qty === (mode === 'original' ? 6 : mode === 'equal_integer' ? 2 : 0.1)).toBe(true)
    if (mode !== 'original') expect((JSON.parse(f.input.rowsText) as Row[])[ordinal] === undefined).toBe(true)
    expect(result.approval.remainingAttempts === 0 && result.approval.ledgerId === result.delivery?.id).toBe(true)
    expect(Object.keys(result).sort()).toEqual(['approval', 'businessVerified', 'delivery', 'durable', 'externalWriteAttempted', 'reused', 'status'])
    expect(Object.keys(result.delivery!).sort()).toEqual(['durable', 'id', 'status'])
    expect(Object.keys(port).sort()).toEqual(['inspect', 'submit'])
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 3])
    expect((await tableRows(LEDGER_AUDIT)).map(row => row.event).sort()).toEqual(['acknowledgement', 'claim', 'prepare'])
    const before = await evidence(), restarted = await session(), freshHttp = http(), refreshed = restarted.port(freshHttp)
    const observed = await refreshed.submit(f.request), inspected = await refreshed.inspect({ grantId: f.grant.grantId })
    expect([observed.status, observed.reused, observed.externalWriteAttempted, observed.approval.remainingAttempts])
      .toEqual(['acknowledged', true, false, 0])
    expect(observed.delivery?.id === result.delivery?.id && inspected.delivery?.id === result.delivery?.id).toBe(true)
    expect([freshHttp.token, freshHttp.form]).toEqual([0, 0])
    expect(restarted.statements.some(sql => sql.includes(OP) || sql.includes('integration_yida_credential_materials') || /^INSERT /i.test(sql.trim()))).toBe(false)
    expect(await evidence()).toEqual(before)
    const publicText = JSON.stringify([result, observed, inspected])
    for (const privateValue of [...Object.values(material()), 'synthetic-token', 'synthetic-instance', 'synthetic owner port part', 'synthetic_owner_form'])
      expect(publicText.includes(privateValue)).toBe(false)
  })

  it.each(['default', 'false', 'TRUE', ' true ', 'boolean', 'promise'])('non-exact enablement is closed before any SQL or HTTP: %s', async mode => {
    const f = await fixture(), fake = http(), before = await evidence()
    const enablement = mode === 'default' ? null : () => mode === 'boolean' ? true : mode === 'promise' ? Promise.resolve('true') : mode
    const port = first.port(fake, enablement); first.statements.length = 0
    await rejected(port.submit(f.request), 'YIDA_OWNER_SEND_DISABLED')
    expect(first.statements.length).toBe(0); expect([fake.token, fake.form]).toEqual([0, 0])
    expect(await evidence()).toEqual(before)
  })

  it('closed submit rejects caller authority, getters and pre-aborted signal before admission', async () => {
    const f = await fixture(), fake = http(), port = first.port(fake), before = await evidence()
    first.statements.length = 0
    for (const key of ['actorId', 'operationId', 'rowKey', 'permit', 'credential', 'config'])
      await rejected(port.submit({ ...f.request, [key]: 'synthetic-forged' }), 'YIDA_OWNER_SEND_INPUT')
    let calls = 0
    const accessor = { ...f.request }; Object.defineProperty(accessor, 'grantId', { enumerable: true, get() { calls++; return f.grant.grantId } })
    await rejected(port.submit(accessor), 'YIDA_OWNER_SEND_INPUT')
    const controller = new AbortController(); controller.abort()
    await rejected(port.submit(f.request, { signal: controller.signal }), 'YIDA_OWNER_SEND_CANCELLED')
    expect(calls).toBe(0); expect(first.statements.length).toBe(0)
    expect([fake.token, fake.form]).toEqual([0, 0]); expect(await evidence()).toEqual(before)
  })

  it.each(['permission', 'inactive', 'foreign-owner', 'foreign-tenant', 'material-revoke', 'material-rotate', 'expired', 'grant-revoke', 'draft', 'target'])
    ('actual pre-admission %s refusal performs no HTTP and creates no attempt', async mode => {
      const f = await fixture(input(), 0, mode === 'expired' ? 20 : 900000), fake = http()
      let active = first
      if (mode === 'permission') await owner.query("DELETE FROM user_permissions WHERE user_id='synthetic-owner'")
      if (mode === 'inactive') await owner.query("UPDATE users SET is_active=false WHERE id='synthetic-owner'")
      if (mode === 'foreign-owner') active = await session(context({ ownerId: 'synthetic-other-actor' }))
      if (mode === 'foreign-tenant') active = await session(context({ tenantId: 'synthetic-other-tenant' }))
      if (mode === 'material-revoke') await second.material.revoke({ credentialRef: f.credentialRef, expectedGeneration: 1 })
      if (mode === 'material-rotate') await second.material.rotate({ credentialRef: f.credentialRef, expectedGeneration: 1, material: material() })
      if (mode === 'expired') await new Promise(resolve => setTimeout(resolve, 60))
      if (mode === 'grant-revoke') await second.authority.approvals.revoke({ grantId: f.grant.grantId })
      if (mode === 'draft') {
        const sealed = JSON.parse(await security.decrypt(String((await tableRows(OP))[0].snapshot_encrypted))) as Row
        ;(sealed.source as Row).rowsText = input('original', 7).rowsText
        await corrupt(OP, 'trg_yida_draft_operations_immutable', 'snapshot_encrypted', await security.encrypt(JSON.stringify(sealed)))
      }
      if (mode === 'target') {
        const sealed = JSON.parse(await security.decrypt(String((await tableRows(TARGET))[0].evidence_encrypted))) as Row
        sealed.targetRef = randomUUID()
        await corrupt(TARGET, 'trg_yida_approved_target_immutable', 'evidence_encrypted', await security.encrypt(JSON.stringify(sealed)))
      }
      const before = await evidence(); await rejected(active.port(fake).submit(f.request))
      expect([fake.token, fake.form]).toEqual([0, 0]); expect(await evidence()).toEqual(before)
    })

  it('full execution material must match the encrypted human-attested execution identity before token exchange', async () => {
    const f = await fixture(), fake = http()
    const sealed = JSON.parse(await security.decrypt(String((await tableRows(TARGET))[0].evidence_encrypted))) as Row
    ;(sealed.attestation as Row).executionIdentity = 'synthetic-wrong-executor'
    await corrupt(TARGET, 'trg_yida_approved_target_immutable', 'evidence_encrypted', await security.encrypt(JSON.stringify(sealed)))
    await rejected(first.port(fake).submit(f.request))
    expect([fake.token, fake.form]).toEqual([0, 0])
    // Admission authenticates target/material metadata; the new full-material
    // reader authenticates executionIdentity. Its refusal does not refund 093.
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
    expect((await tableRows(LEDGER))[0].status).toBe('prepared')
    const observed = await second.port(http()).submit(f.request)
    expect(observed.reused && observed.approval.remainingAttempts === 0).toBe(true)
  })

  it('two actual PIDs competing for one submission produce one permit, token exchange and form attempt', async () => {
    const f = await fixture(), oneHttp = http(), twoHttp = http(), gate = first.gateRead('integration_yida_credential_materials')
    let one: Submit | undefined, two: Submit | undefined
    const winner = outcome(first.port(oneHttp).submit(f.request).then(value => { one = value }))
    let follower: ReturnType<typeof outcome> | undefined
    try {
      await reached(gate)
      follower = outcome(second.port(twoHttp).submit(f.request).then(value => { two = value }))
      await blocked(second, first)
    } finally { gate.release() }
    expect(await winner).toEqual({ ok: true }); expect(await follower).toEqual({ ok: true })
    expect(one?.reused === false && one?.status === 'acknowledged' && two?.reused === true
      && one?.delivery?.id === two?.delivery?.id).toBe(true)
    expect([oneHttp.token, oneHttp.form, twoHttp.token, twoHttp.form]).toEqual([1, 1, 0, 0])
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 3])
  })

  it.each(['permission', 'material', 'grant'])('actual %s revocation during token exchange prevents claim/body, without refunding admission', async kind => {
    const f = await fixture(), fake = http(), gate = fake.gateToken(), port = first.port(fake)
    const pending = outcome(port.submit(f.request))
    try {
      await reached(gate)
      if (kind === 'permission') await owner.query("DELETE FROM user_permissions WHERE user_id='synthetic-owner'")
      if (kind === 'material') await second.material.revoke({ credentialRef: f.credentialRef, expectedGeneration: 1 })
      if (kind === 'grant') await second.authority.approvals.revoke({ grantId: f.grant.grantId })
    } finally { gate.release() }
    expect(await pending).toEqual({ ok: false, code: 'YIDA_OWNER_SEND_UNAVAILABLE' })
    expect([fake.token, fake.form]).toEqual([1, 0])
    expect((await tableRows(LEDGER))[0].status).toBe('prepared')
    expect((await tableRows(ADMISSION)).length).toBe(1)
    expect((await tableRows(LEDGER_AUDIT)).map(row => row.event)).toEqual(['prepare'])
    if (kind !== 'permission') {
      const refreshed = await second.port(http()).submit(f.request)
      expect(refreshed.reused && refreshed.status === 'prepared' && refreshed.approval.remainingAttempts === 0).toBe(true)
    }
  })

  it('literal enablement is checked again after real private credential loading and immediately before token HTTP', async () => {
    const f = await fixture(), fake = http()
    let enabled = 'true'
    // The actual live-ACL user_roles reads are admission, resolver #1, then
    // token loader #1. No SQL/result/authority is replaced by this pause.
    first.statements.length = 0
    const gate = first.gateRead('user_roles', 3)
    const pending = outcome(first.port(fake, () => enabled).submit(f.request))
    try {
      await reached(gate)
      expect(first.statements.filter(sql => /^SELECT/i.test(sql.trim()) && sql.includes('user_roles')).length).toBe(3)
      expect((await tableRows(ADMISSION)).length).toBe(1)
      expect((await tableRows(LEDGER))[0].status).toBe('prepared')
      enabled = 'false'
    } finally { gate.release() }
    expect(await pending).toEqual({ ok: false, code: 'YIDA_OWNER_SEND_UNAVAILABLE' })
    expect([fake.token, fake.form]).toEqual([0, 0])
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
    const observed = await second.port(http()).submit(f.request)
    expect(observed.reused && observed.status === 'prepared' && observed.approval.remainingAttempts === 0).toBe(true)
  })

  it('grant revocation after confirmed claim but before final resolver marks unknown without publishing a form body', async () => {
    const f = await fixture(), fake = http(), gate = first.gateCommit('claim')
    let result: Submit | undefined
    const pending = outcome(first.port(fake).submit(f.request).then(value => { result = value }))
    try {
      await reached(gate)
      expect((await tableRows(LEDGER))[0].status).toBe('dispatching')
      await second.authority.approvals.revoke({ grantId: f.grant.grantId })
    } finally { gate.release() }
    expect(await pending).toEqual({ ok: true })
    expect([result?.status, result?.externalWriteAttempted, result?.approval.remainingAttempts]).toEqual(['outcome_unknown', false, 0])
    expect([fake.token, fake.form]).toEqual([1, 0])
    expect((await tableRows(LEDGER_AUDIT)).map(row => row.event).sort()).toEqual(['claim', 'prepare', 'unknown'])
    const replay = await second.port(http()).submit(f.request)
    expect(replay.reused && replay.status === 'outcome_unknown' && replay.externalWriteAttempted === false).toBe(true)
  })

  it.each(['token', 'form'])('cancelled pending %s fetch never makes its consumed CREATE attempt available again', async phase => {
    const f = await fixture(), fake = http(), gate = phase === 'token' ? fake.gateToken() : fake.gateForm()
    const controller = new AbortController(), port = first.port(fake)
    let result: Submit | undefined
    const pending = outcome(port.submit(f.request, { signal: controller.signal }).then(value => { result = value }))
    try {
      await reached(gate); controller.abort()
      const duplicateHttp = http(), duplicate = await second.port(duplicateHttp).submit(f.request)
      expect(duplicate.reused && duplicate.approval.remainingAttempts === 0).toBe(true)
      expect([duplicateHttp.token, duplicateHttp.form]).toEqual([0, 0])
      expect((await tableRows(ADMISSION)).length).toBe(1)
    } finally { gate.release() }
    if (phase === 'form') {
      expect(await pending).toEqual({ ok: true })
      expect([result?.status, result?.externalWriteAttempted]).toEqual(['outcome_unknown', true])
    } else expect(await pending).toEqual({ ok: false, code: 'YIDA_OWNER_SEND_UNAVAILABLE' })
    expect([fake.token, fake.form]).toEqual([1, phase === 'form' ? 1 : 0])
    expect((await tableRows(LEDGER))[0].status).toBe(phase === 'form' ? 'outcome_unknown' : 'prepared')
    const third = await session(), lateHttp = http(), late = await third.port(lateHttp).submit(f.request)
    expect(late.reused && late.approval.remainingAttempts === 0).toBe(true)
    expect([lateHttp.token, lateHttp.form]).toEqual([0, 0])
  })

  it.each(['admission', 'claim'] as const)('lost real %s COMMIT reply yields no resumed permit or second token/send', async stage => {
    const f = await fixture(), fake = http(); first.loseCommit(stage)
    await rejected(first.port(fake).submit(f.request))
    expect([fake.token, fake.form]).toEqual([stage === 'claim' ? 1 : 0, 0])
    const expected = stage === 'claim' ? 'dispatching' : 'prepared'
    expect((await tableRows(LEDGER))[0].status).toBe(expected)
    const before = await evidence(), restarted = await session(), laterHttp = http()
    const replay = await restarted.port(laterHttp).submit(f.request)
    expect([replay.status, replay.reused, replay.externalWriteAttempted, replay.approval.remainingAttempts]).toEqual([expected, true, false, 0])
    expect([laterHttp.token, laterHttp.form]).toEqual([0, 0]); expect(await evidence()).toEqual(before)
    const admission = await restarted.authority.admitForExecution(f.request)
    expect(admission.approval.reused && admission.permit === null).toBe(true)
  })

  it('real acknowledgement SQL failure records unknown and is never automatically sent again', async () => {
    const f = await fixture(), fake = http()
    await owner.query(`CREATE FUNCTION synthetic_reject_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event='acknowledgement' THEN RAISE EXCEPTION 'SYNTHETIC_ACK_FAILURE'; END IF; RETURN NEW; END $$`)
    await owner.query(`CREATE TRIGGER synthetic_reject_ack BEFORE INSERT ON ${ident(LEDGER_AUDIT)} FOR EACH ROW EXECUTE FUNCTION synthetic_reject_ack()`)
    const result = await first.port(fake).submit(f.request)
    expect([result.status, result.externalWriteAttempted, result.durable]).toEqual(['outcome_unknown', true, true])
    expect([fake.token, fake.form]).toEqual([1, 1])
    expect((await tableRows(LEDGER_AUDIT)).map(row => row.event).sort()).toEqual(['claim', 'prepare', 'unknown'])
    const before = await evidence(), lateHttp = http(), replay = await second.port(lateHttp).submit(f.request)
    expect(replay.reused && replay.status === 'outcome_unknown' && replay.approval.remainingAttempts === 0).toBe(true)
    expect([lateHttp.token, lateHttp.form]).toEqual([0, 0]); expect(await evidence()).toEqual(before)
  })

  it('a fresh permit is empty, factory-bound and synchronously consumable exactly once', async () => {
    const f = await fixture(), admission = await first.authority.admitForExecution(f.request)
    expect(admission.permit !== null && Object.isFrozen(admission.permit)).toBe(true)
    expect(Reflect.ownKeys(admission.permit!)).toEqual([])
    rejectedSync(() => first.authority.takeExecution({ ...admission.permit }))
    rejectedSync(() => second.authority.takeExecution(admission.permit))
    const handle = first.authority.takeExecution(admission.permit)
    expect(Object.keys(handle).sort()).toEqual(['close', 'context', 'credentialBinding', 'loadCredential', 'operation', 'resolveExecutionSnapshot'])
    expect(Object.keys(handle.context).sort()).toEqual(['actorId', 'ownerId', 'tenantId', 'workspaceId'])
    expect(Object.keys(handle.operation).sort()).toEqual(['operationId', 'rowKey'])
    expect(Object.keys(handle.credentialBinding).sort()).toEqual(['credentialGeneration', 'credentialRef', 'ownerId', 'tenantId', 'workspaceId'])
    rejectedSync(() => first.authority.takeExecution(admission.permit))
    handle.close()
    const replay = await first.authority.admitForExecution(f.request)
    expect(replay.approval.reused && replay.permit === null).toBe(true)
  })

  it('public admit consumes the attempt but cannot later be upgraded to an execution permit', async () => {
    const f = await fixture(); await first.authority.approvals.admit(f.request)
    const recovered = await second.authority.admitForExecution(f.request)
    expect(recovered.approval.reused && recovered.permit === null).toBe(true)
    const fake = http(), result = await second.port(fake).submit(f.request)
    expect(result.reused && result.status === 'prepared' && result.approval.remainingAttempts === 0).toBe(true)
    expect([fake.token, fake.form]).toEqual([0, 0])
  })

  it.each(['loader-first', 'resolve-without-loader', 'loader-after-resolve-two', 'final-before-claim', 'wrong-identity', 'wrong-binding', 'closed', 'aborted'])
    ('real private execution handle closes on %s misuse', async mode => {
      const f = await fixture(), { handle, identity, options } = await privateHandle(f)
      let operation: Promise<unknown>
      if (mode === 'loader-first') operation = handle.loadCredential(handle.credentialBinding, options)
      else if (mode === 'wrong-identity') operation = handle.resolveExecutionSnapshot({ ...identity, rowKey: randomUUID() }, options)
      else if (mode === 'closed') { handle.close(); operation = handle.resolveExecutionSnapshot(identity, options) }
      else if (mode === 'aborted') {
        const controller = new AbortController(); controller.abort()
        operation = handle.resolveExecutionSnapshot(identity, { signal: controller.signal })
      } else {
        await handle.resolveExecutionSnapshot(identity, options)
        if (mode === 'resolve-without-loader') operation = handle.resolveExecutionSnapshot(identity, options)
        else if (mode === 'wrong-binding') operation = handle.loadCredential({ ...handle.credentialBinding, credentialGeneration: 2 }, options)
        else {
          const loaded = await handle.loadCredential(handle.credentialBinding, options)
          expect(Object.keys(loaded).sort()).toEqual(['appKey', 'appSecret', 'credentialGeneration', 'credentialRef', 'ownerId', 'tenantId', 'workspaceId'])
          await handle.resolveExecutionSnapshot(identity, options)
          operation = mode === 'loader-after-resolve-two' ? handle.loadCredential(handle.credentialBinding, options)
            : handle.resolveExecutionSnapshot(identity, options)
        }
      }
      await rejected(operation, `YIDA_SEND_APPROVAL_${mode === 'aborted' ? 'CANCELLED' : 'CONFLICT'}`)
      await rejected(handle.resolveExecutionSnapshot(identity, options), 'YIDA_SEND_APPROVAL_CONFLICT')
      expect((await tableRows(LEDGER))[0].status).toBe('prepared')
      expect((await tableRows(ADMISSION)).length).toBe(1)
    })

  it.each(['initial-resolver', 'token-loader'])('private %s independently rechecks database expiry after a valid committed admission', async phase => {
    const f = await fixture()
    const shortGrant = await first.authority.approvals.approve({ operationId: f.draft.operationId, rowKey: f.draft.rows[0].rowKey,
      confirmationId: 'synthetic-private-expiry-confirmation', ttlMs: 2000 })
    const request = { ...f.request, grantId: shortGrant.grantId }
    const { handle, identity, options, result } = await privateHandle({ ...f, grant: shortGrant, request })
    expect(result.approval.status === 'admitted' && result.approval.remainingAttempts === 0).toBe(true)
    if (phase === 'token-loader') {
      const initial = await handle.resolveExecutionSnapshot(identity, options)
      expect(initial.grantRef === shortGrant.grantId && initial.expiresAt === shortGrant.expiresAt).toBe(true)
    }
    const before = await evidence()
    expect(before.counts).toEqual([2, 0, 1, 3, 1, 1])
    // Read the actual DB clock; never replace Date.now, SQL, expiry or material.
    // The bounded wait tolerates scheduling delays without assuming wall-clock
    // agreement between the Node process and the owned PostgreSQL instance.
    let expired = false
    for (let poll = 0; poll < 40; poll++) {
      const time = await owner.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms')
      const nowMs = Number(time.rows[0].now_ms)
      expect(Number.isSafeInteger(nowMs)).toBe(true)
      if (nowMs >= shortGrant.expiresAt + 25) { expired = true; break }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, shortGrant.expiresAt + 25 - nowMs)))
    }
    if (!expired) throw new Error('SYNTHETIC_DB_EXPIRY_TIMEOUT')
    await rejected(phase === 'token-loader' ? handle.loadCredential(handle.credentialBinding, options)
      : handle.resolveExecutionSnapshot(identity, options), 'YIDA_SEND_APPROVAL_EXPIRED')
    await rejected(handle.resolveExecutionSnapshot(identity, options), 'YIDA_SEND_APPROVAL_CONFLICT')
    expect(await evidence()).toEqual(before)
    const fake = http(), observed = await second.port(fake).submit(request)
    expect(observed.reused && observed.status === 'prepared' && observed.approval.remainingAttempts === 0).toBe(true)
    expect([fake.token, fake.form]).toEqual([0, 0])
    expect(await evidence()).toEqual(before)
  }, 12000)

  it('private final expiry gate refuses material that finishes after the valid entry check crossed its DB deadline', async () => {
    const f = await fixture()
    const shortGrant = await first.authority.approvals.approve({ operationId: f.draft.operationId, rowKey: f.draft.rows[0].rowKey,
      confirmationId: 'synthetic-cross-deadline-confirmation', ttlMs: 2000 })
    const request = { ...f.request, grantId: shortGrant.grantId }
    const { handle, identity, options } = await privateHandle({ ...f, grant: shortGrant, request })
    const before = await evidence()
    expect(before.counts).toEqual([2, 0, 1, 3, 1, 1])
    first.statements.length = 0
    // This is the first actual structured 090 read INSIDE the private resolver,
    // after its entry now_ms check, not the earlier ACL or public admission.
    const gate = first.gateRead('integration_yida_credential_materials')
    const pending = outcome(handle.resolveExecutionSnapshot(identity, options))
    try {
      await reached(gate)
      const heldIndex = first.statements.length - 1
      expect(/^SELECT\b[\s\S]*\bFROM "integration_yida_credential_materials"/.test(first.statements[heldIndex])).toBe(true)
      const timeIndexes = first.statements.flatMap((sql, index) => sql.includes('AS now_ms') ? [index] : [])
      expect(timeIndexes.length).toBe(1)
      expect(timeIndexes[0] < heldIndex).toBe(true)
      const atGate = await owner.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms')
      const enteredAt = Number(atGate.rows[0].now_ms)
      expect(Number.isSafeInteger(enteredAt) && enteredAt < shortGrant.expiresAt).toBe(true)
      let expired = false
      for (let poll = 0; poll < 40; poll++) {
        const time = await owner.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms')
        const nowMs = Number(time.rows[0].now_ms)
        expect(Number.isSafeInteger(nowMs)).toBe(true)
        if (nowMs >= shortGrant.expiresAt + 25) { expired = true; break }
        await new Promise(resolve => setTimeout(resolve, Math.min(250, shortGrant.expiresAt + 25 - nowMs)))
      }
      if (!expired) throw new Error('SYNTHETIC_DB_EXPIRY_TIMEOUT')
    } finally { gate.release() }
    // Assert the private rejection first, so a deleted final check fails here
    // on returned snapshot, not on a later runner wall clock or count assertion.
    expect(await pending).toEqual({ ok: false, code: 'YIDA_SEND_APPROVAL_EXPIRED' })
    await rejected(handle.resolveExecutionSnapshot(identity, options), 'YIDA_SEND_APPROVAL_CONFLICT')
    expect(await evidence()).toEqual(before)
    const fake = http(), observed = await second.port(fake).submit(request)
    expect(observed.reused && observed.status === 'prepared' && observed.approval.remainingAttempts === 0).toBe(true)
    expect([fake.token, fake.form]).toEqual([0, 0])
    expect(await evidence()).toEqual(before)
  }, 12000)

  it.each(['close', 'abort'])('a private resolver with real PG work pending discards late output after %s', async action => {
    const f = await fixture(), { handle, identity } = await privateHandle(f), controller = new AbortController()
    const gate = first.gateRead('integration_yida_credential_materials')
    const pending = outcome(handle.resolveExecutionSnapshot(identity, { signal: controller.signal }))
    let revoking: ReturnType<typeof outcome> | undefined
    try {
      await reached(gate)
      revoking = outcome(second.authority.approvals.revoke({ grantId: f.grant.grantId }))
      await blocked(second, first)
      if (action === 'close') handle.close(); else controller.abort()
    } finally { gate.release() }
    expect(await pending).toEqual({ ok: false, code: `YIDA_SEND_APPROVAL_${action === 'close' ? 'CONFLICT' : 'CANCELLED'}` })
    expect(await revoking).toEqual({ ok: true })
    expect((await tableRows(LEDGER))[0].status).toBe('prepared')
    expect((await tableRows(ADMISSION)).length).toBe(1)
  })

  it('an identical orphan prepared ledger cannot mint an execution capability', async () => {
    const f = await fixture(), approved = (await tableRows(APPROVAL))[0]
    const snapshot = { tenantId: approved.tenant_id, workspaceId: approved.workspace_id, ownerId: approved.owner_id,
      operationId: approved.operation_id, rowKey: approved.row_key, targetRef: approved.target_ref,
      targetRevision: approved.target_revision, planRevision: approved.plan_revision,
      credentialRef: approved.credential_ref, credentialGeneration: approved.credential_generation,
      businessKeyDigest: approved.business_key_digest, payloadDigest: approved.execution_payload_digest, intent: 'create' }
    const seeded = await first.ledger.prepare(snapshot), exact = await second.ledger.prepare(snapshot)
    expect(seeded.reused === false && exact.reused === true && seeded.record.id === exact.record.id).toBe(true)
    const before = await evidence(), fake = http()
    await rejected(first.authority.admitForExecution(f.request), 'YIDA_SEND_APPROVAL_CONFLICT')
    await rejected(first.port(fake).submit(f.request))
    expect([fake.token, fake.form]).toEqual([0, 0]); expect(await evidence()).toEqual(before)
    expect(before.counts).toEqual([1, 0, 0, 1, 1, 1])
  })
})
