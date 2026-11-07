// Actual 088-093, host encryption, live ACL and native private plugin composition.
// Synthetic trusted future-host context only: no HTTP/JWT authentication, token,
// transport, remote identity verification or external send is exercised here.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { createYidaSendApprovalService, YidaSendAuthorityPrimitives, YidaSendApprovalMetadata, YidaSourceBindingReauthorizer } from '../../src/integration/yida-send-approval-service'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('../utils/yida-native-module-import.cjs')
const APPROVAL = 'integration_yida_send_approvals', REVOCATION = 'integration_yida_send_revocations'
const ADMISSION = 'integration_yida_send_admissions', AUDIT = 'integration_yida_send_approval_audit'
const LEDGER = 'integration_yida_delivery_ledger', LEDGER_AUDIT = 'integration_yida_delivery_audit'
const OP = 'integration_yida_draft_operations', MEMBERS = 'integration_yida_draft_rows'
const PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
// D21 (slice Y5): approve and admit first ENSURE the actor's subject authorization version row (an idempotent upsert of
// a version row, never a grant, admission, audit or ledger row) and hold it FOR SHARE. "No INSERT" in this file means
// no business write: only this exact statement is exempt, every other INSERT still fails those assertions.
const SUBJECT_VERSION_ENSURE = /^INSERT INTO subject_authorization_versions \(subject_id\) VALUES \(\$1\) ON CONFLICT \(subject_id\) DO NOTHING$/
const businessInsert = (sql: string) => /^INSERT /i.test(sql.trim()) && !SUBJECT_VERSION_ENSURE.test(sql.trim())
const proofTables = [APPROVAL, REVOCATION, ADMISSION, AUDIT, LEDGER, LEDGER_AUDIT]
type Row = Record<string, unknown>
type Context = { tenantId: string; workspaceId: null; ownerId: string }
type HostSecurity = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Service = ReturnType<typeof createYidaSendApprovalService>
type MutationMetadata = YidaSendApprovalMetadata & { reused: boolean }
type Database = { query(sql: string, params?: unknown[]): Promise<Row[]>
  transaction<T>(callback: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T> }
type Draft = { operationId: string; targetRef: string; rows: Array<{ rowKey: string; index: number }>; canSend: false }
type DraftStore = { createDraft(input: unknown): Promise<Draft> }
type MaterialStore = { create(input: unknown): Promise<{ credentialRef: string; credentialGeneration: number }>
  rotate(input: unknown): Promise<unknown>; revoke(input: unknown): Promise<unknown> }
type TargetStore = { register(input: unknown): Promise<{ targetRef: string; canSend: false }> }
type LedgerStore = { cancelPrepared(input: unknown): Promise<unknown>
  prepare(input: unknown): Promise<{ record: Row; reused: boolean }> }
type Input = { config: Row & { fieldMap: Row[]; businessKey: string[]; emptyKeyFields: string[] }; rowsText: string; allocation: Row }
type Compiled = { source: Row; planDigest: string; plan: { rows: Array<{ payload: Row; protocolPreview: { data: Row } }> }
  rowSpecs: Array<{ index: number; businessKeyDigest: string; payloadDigest: string }> }
type Gate = { reached: Promise<void>; release(): void }
// Gate 4 session knobs: a send-budget verdict override (null = the real primitive verdict), the
// multi-target service switch, and host security call counters.
type BudgetSwitch = { within: boolean | null; calls: number; verdict?: () => unknown }
type SessionOptions = { budget?: BudgetSwitch; multiTarget?: boolean; counter?: { encrypt: number; decrypt: number }
  // D20: the exact-listed target refs that may take unbound rows besides slot 1 (the runtime parses the env list).
  unboundTestTargetRefs?: ReadonlySet<string>
  // D21: a service built WITHOUT the host re-authorization (the fail-closed pin); every other session gets the real one.
  withoutReauthorization?: boolean }
type Session = { client: PoolClient; pid: number; db: unknown; service: Service; draft: DraftStore; material: MaterialStore
  target: TargetStore; ledger: LedgerStore; statements: string[]; gateInsert(table: string): Gate
  // Parks this session's transaction right BEFORE the n-th statement matching `pattern` executes (the RA4 barriers).
  gateMatch(pattern: RegExp, occurrence?: number): Gate
  release(): void; loseCommitResponse(): void }
type Fixture = { draft: Draft; credentialRef: string; credentialGeneration: number; targetRef: string
  request: { operationId: string; rowKey: string; confirmationId: string }; input: Input }

it('sentinel: send approvals require EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('SA05 internal single-attempt approvals — real PG, ACL and private primitives', () => {
  let pool: Pool, owner: PoolClient, first: Session, second: Session, security: HostSecurity
  let schema = '', ddl = '', approvalDdl = ''
  let createService: typeof createYidaSendApprovalService
  let createPrimitives: (options: { security: HostSecurity; context: Context }) => YidaSendAuthorityPrimitives
  let createDb: (options: { database: Database }) => unknown
  let createDraft: (options: { db: unknown; security: HostSecurity; context: Context }) => DraftStore
  let createMaterial: (options: { db: unknown; security: HostSecurity; context: Context }) => MaterialStore
  let createTarget: (options: { db: unknown; security: HostSecurity; context: Context }) => TargetStore
  let createLedger: (options: { db: unknown }) => LedgerStore
  let compile: (input: Input) => Compiled
  let canonical: (value: unknown) => string
  let executionDigest: (input: unknown) => string
  let assertActor: (trx: Queryable, input: { actorId: string; tenantId: string; workspaceId: null }) => Promise<void>
  let sendBudget: { YIDA_SEND_REQUEST_MAX_BYTES: number; encodeYidaFormRequestBody(data: unknown, systemToken: string, userId: string): string
    assessYidaSendBudget(input: { snapshot: Row; data: Row }): { withinBudget: boolean } }
  let plan: (input: { config: unknown; rows: unknown[] }) => { rows: Array<{ status: string; payload: Row; protocolPreview: { data: Row } }> }
  let createAdditionalWriter: (options: { security: HostSecurity; context: Context }) => (trx: unknown, input: unknown) => Promise<{ targetRef: string; slot: number }>
  // D21 (slice Y5): the host's in-transaction re-authorization and the access-graph mutex (the RA4 lock-order writer).
  let reauthorize: YidaSourceBindingReauthorizer
  let lockUsers: (client: PoolClient, userIds: string[]) => Promise<Map<string, { id: string }>>
  let multiTargetUp = ''
  const sessions: Session[] = []
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let savedEnv: Array<[typeof envKeys[number], string | undefined]> = []
  const context = (patch: Partial<Context> = {}): Context => ({ tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', ...patch })
  const material = () => ({ appKey: 'synthetic-approval-app', appSecret: 'synthetic-approval-secret',
    systemToken: 'synthetic-approval-system-token', userId: 'synthetic-executor' })
  function input(mode = 'original', quantity = 6): Input {
    return {
      config: { version: 2, kind: 'yida-form-protocol-static', intent: 'create',
        target: { appType: 'synthetic_approval_app', formUuid: 'synthetic_approval_form' },
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
      },
      rowsText: JSON.stringify([{ projectNo: 'DEMO-P1', lineId: 'LINE-1', parentCode: null,
        quantity, description: 'synthetic approval part' }]),
      allocation: mode === 'original' ? { mode } : { mode, projects: ['DEMO-P1', 'DEMO-P2', 'DEMO-P3'],
        projectField: 'projectNo', quantityField: 'quantity' },
    }
  }
  function alias(value: Input): Input {
    const renamed = JSON.parse(JSON.stringify(value)) as Input
    renamed.config.fieldMap = renamed.config.fieldMap.map(field => ({ ...field, source: `alias_${field.source}` }))
    renamed.config.businessKey = renamed.config.businessKey.map(key => `alias_${key}`)
    renamed.config.emptyKeyFields = renamed.config.emptyKeyFields.map(key => `alias_${key}`)
    renamed.rowsText = JSON.stringify((JSON.parse(value.rowsText) as Row[]).map(row =>
      Object.fromEntries(Object.entries(row).map(([key, val]) => [`alias_${key}`, val]))))
    return renamed
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
  async function rejected(promise: Promise<unknown>, suffix = 'UNAVAILABLE') {
    let caught: unknown
    try { await promise } catch (error) { caught = error }
    const code = `YIDA_SEND_APPROVAL_${suffix}`
    expect(codeOf(caught)).toBe(code)
    expect((caught as Error)?.message).toBe(code)
    expect(Object.keys(caught as object).sort()).toEqual(['code', 'name'])
    expect('cause' in (caught as object)).toBe(false)
  }
  // Boolean equality prevents a failed assertion from printing a secret envelope.
  const same = (left: unknown, right: unknown) => expect(canonical(left) === canonical(right)).toBe(true)
  const tableRows = async (table: string) => (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY 1`)).rows as Row[]
  async function evidence() {
    const rows = await Promise.all(proofTables.map(tableRows))
    return { counts: rows.map(value => value.length), digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
  }
  async function session(scope = context(), options: SessionOptions = {}): Promise<Session> {
    const client = await pool.connect()
    // The private schema shadows every table it defines; the migrated PUBLIC schema answers the rest (D21: the
    // version rows, their triggers, meta_* and the permission tables the re-authorization reads).
    await client.query(`SET search_path TO ${ident(schema)}, public`)
    await client.query("SET statement_timeout = '10s'")
    await client.query("SET default_transaction_isolation = 'repeatable read'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = []
    let lostCommit = false, gate: (Gate & { matches(sql: string): boolean; enter(): void; open: Promise<void> }) | undefined
    const query: Queryable['query'] = async (sql, params) => {
      statements.push(sql) // SQL shapes only, never parameter values or driver errors.
      if (gate && gate.matches(sql.trim())) {
        const held = gate; held.enter(); await held.open
        if (gate === held) gate = undefined
      }
      const result = await client.query(sql, params)
      return { rows: result.rows as Row[], rowCount: result.rowCount }
    }
    const database = { async transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> {
      await query('BEGIN')
      try {
        const result = await callback({ query }); await query('COMMIT')
        if (lostCommit) { lostCommit = false; throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST') }
        return result
      } catch (error) { await query('ROLLBACK'); throw error }
    } }
    const rowsQuery = async (sql: string, params?: unknown[]) => (await query(sql, params)).rows
    const pluginDatabase: Database = { query: rowsQuery, transaction: callback => database.transaction(trx =>
      callback({ query: async (sql, params) => (await trx.query(sql, params)).rows })) }
    const db = createDb({ database: pluginDatabase }), config = { db, security, context: scope }
    const counter = options.counter
    const hostSecurity: HostSecurity = counter ? {
      async encrypt(text) { counter.encrypt++; return security.encrypt(text) },
      async decrypt(text) { counter.decrypt++; return security.decrypt(text) },
    } : security
    const real = createPrimitives({ security: hostSecurity, context: scope })
    const budgetSwitch = options.budget
    // Only the verdict is overridden; selection, digest, preparation and material are the real primitives.
    const primitives: YidaSendAuthorityPrimitives = budgetSwitch ? { ...real, sendBudget(selection, grant) {
      budgetSwitch.calls++
      const verdict = real.sendBudget(selection, grant)
      if (budgetSwitch.verdict) return budgetSwitch.verdict() as ReturnType<YidaSendAuthorityPrimitives['sendBudget']>
      return budgetSwitch.within === null ? verdict : Object.freeze({ withinBudget: budgetSwitch.within })
    } } : real
    const value: Session = { client, pid, statements, db,
      service: createService({ database, security: hostSecurity, context: { tenantId: scope.tenantId, workspaceId: null, actorId: scope.ownerId },
        primitives, ...(options.multiTarget ? { multiTarget: true } : {}),
        ...(options.unboundTestTargetRefs ? { unboundTestTargetRefs: options.unboundTestTargetRefs } : {}),
        // D21 (slice Y5): the REAL host re-authorization — the multitable permission primitives on this session's trx.
        ...(options.withoutReauthorization ? {} : { reauthorizeSourceBinding: reauthorize }) }),
      draft: createDraft(config), material: createMaterial(config), target: createTarget(config), ledger: createLedger({ db }),
      gateInsert(table) {
        ident(table)
        const pattern = new RegExp(`^INSERT INTO "?${table}"?(?:\\s|\\()`, 'i')
        return value.gateMatch(pattern)
      },
      gateMatch(pattern, occurrence = 1) {
        let enter!: () => void, release!: () => void, seen = 0
        const reached = new Promise<void>(resolve => { enter = resolve }), open = new Promise<void>(resolve => { release = resolve })
        gate = { matches: sql => pattern.test(sql) && ++seen === occurrence, reached, open, enter, release }; return gate
      }, release() { gate?.release() }, loseCommitResponse() { lostCommit = true },
    }
    sessions.push(value); return value
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
      const found = await owner.query("SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1", [waiter.pid, holder.pid])
      if (found.rows[0]?.blocked === true) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('SYNTHETIC_PG_LOCK_NOT_OBSERVED')
  }
  async function fixture(value = input(), ordinal = 0): Promise<Fixture> {
    const draft = await first.draft.createDraft(value), secret = await first.material.create({ material: material() })
    const target = await first.target.register({ operationId: draft.operationId,
      credentialRef: secret.credentialRef, credentialGeneration: secret.credentialGeneration,
      attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review',
        organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' } })
    expect(draft.canSend || target.canSend).toBe(false)
    return { draft, ...secret, targetRef: target.targetRef, input: value,
      request: { operationId: draft.operationId, rowKey: draft.rows[ordinal].rowKey, confirmationId: 'synthetic-confirmation' } }
  }
  async function livePositive(scope: Context) {
    await owner.query('BEGIN'); await owner.query(PIN)
    try { await assertActor(owner as Queryable, { actorId: scope.ownerId, tenantId: scope.tenantId, workspaceId: null }) }
    finally { await owner.query('ROLLBACK') }
  }
  // Deliberate privileged corruption of our unique synthetic schema, not the
  // ordinary-DML threat model. Enabled guards are exercised below with rows present.
  async function corrupt(table: string, trigger: string, column: string, value: unknown) {
    await owner.query('BEGIN')
    try {
      await owner.query(`ALTER TABLE ${ident(table)} DISABLE TRIGGER ${ident(trigger)}`)
      await owner.query(`UPDATE ${ident(table)} SET ${ident(column)} = $1`, [value])
      await owner.query(`ALTER TABLE ${ident(table)} ENABLE TRIGGER ${ident(trigger)}`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
  }
  async function failInsert(table: string) {
    await owner.query(`CREATE FUNCTION synthetic_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SYNTHETIC_INSERT_FAILURE'; END $$`)
    await owner.query(`CREATE TRIGGER synthetic_fail_insert BEFORE INSERT ON ${ident(table)} FOR EACH ROW EXECUTE FUNCTION synthetic_fail_insert()`)
  }
  async function removeFailure(table: string) {
    await owner.query(`DROP TRIGGER synthetic_fail_insert ON ${ident(table)}`)
    await owner.query('DROP FUNCTION synthetic_fail_insert()')
  }

  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    createMaterial = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore
    createLedger = requireCjs(path.join(lib, 'yida-delivery-store.cjs')).createYidaDeliveryStore
    canonical = requireCjs(path.join(lib, 'gip-canonical-json.cjs')).stableCanonicalStringify
    executionDigest = requireCjs(path.join(lib, 'yida-execution-digest.cjs')).buildYidaExecutionPayloadDigest
    createDraft = (await importNative(pathToFileURL(path.join(lib, 'yida-draft-plan-store.mjs')).href)).createYidaDraftPlanStore
    createTarget = (await importNative(pathToFileURL(path.join(lib, 'yida-approved-target-store.mjs')).href)).createYidaApprovedTargetStore
    createPrimitives = (await importNative(pathToFileURL(path.join(lib, 'yida-send-authority-primitives.mjs')).href)).createYidaSendAuthorityPrimitives
    compile = (await importNative(pathToFileURL(path.join(lib, 'yida-draft-plan.mjs')).href)).compileYidaDraft
    const integration = path.join(root, 'packages/core-backend/src/integration')
    createService = (await import(pathToFileURL(path.join(integration, 'yida-send-approval-service.ts')).href)).createYidaSendApprovalService
    assertActor = (await import(pathToFileURL(path.join(integration, 'automation-live-authority.ts')).href)).assertAutomationIntegrationActor
    sendBudget = requireCjs(path.join(lib, 'yida-send-budget.cjs'))
    plan = (await importNative(pathToFileURL(path.join(lib, 'yida-static-plan.mjs')).href)).buildYidaStaticPlan
    createAdditionalWriter = (await importNative(pathToFileURL(path.join(lib, 'yida-approved-target-store.mjs')).href)).createInternalYidaAdditionalTargetTransactionWriter
    reauthorize = (await import(pathToFileURL(path.join(integration, 'yida-source-reauthorization-host.ts')).href)).createYidaSourceBindingReauthorizer()
    lockUsers = (await import(pathToFileURL(path.join(root, 'packages/core-backend/src/directory/access-graph-mutex.ts')).href)).lockUsersForAccessGraphWrite
    // Y2 migration SQL, exactly what zzzz20261103130000 up() executes.
    multiTargetUp = (await import(pathToFileURL(path.join(root, 'packages/core-backend/src/db/migrations/zzzz20261103130000_add_integration_yida_multi_target_slots.ts')).href) as
      { YIDA_MULTI_TARGET_UP_SQL: string }).YIDA_MULTI_TARGET_UP_SQL
    const migrations = path.join(root, 'packages/core-backend/migrations')
    approvalDdl = readFileSync(path.join(migrations, '095_create_integration_yida_send_approvals.sql'), 'utf8')
    // Source binding (design baseline v2.3 §3.3/§7.2): the three-table migration zzzz20261106110300 exactly as its up()
    // executes, plus the project-sheet registry (087) the bound admission reads.
    const sourceBindingUp = ((await import(pathToFileURL(path.join(root,
      'packages/core-backend/src/db/migrations/zzzz20261106110300_add_integration_yida_source_binding.ts')).href)) as
      { YIDA_SOURCE_BINDING_UP_SQL: string }).YIDA_SOURCE_BINDING_UP_SQL
    ddl = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql'].map(name => readFileSync(path.join(migrations, name), 'utf8')).join('\n') + '\n' + approvalDdl
      + '\n' + sourceBindingUp + '\n' + readFileSync(path.join(migrations, '087_create_integration_stock_prep_project_target.sql'), 'utf8')
    savedEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    const { PluginRuntimeSecurityService } = await import(pathToFileURL(path.join(root,
      'packages/core-backend/src/security/plugin-runtime-security-service.ts')).href) as { PluginRuntimeSecurityService: new () => HostSecurity }
    security = new PluginRuntimeSecurityService()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 9, connectionTimeoutMillis: 5000 })
    owner = await pool.connect(); await owner.query("SET statement_timeout = '10s'")
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_approval_' + randomUUID().replaceAll('-', '')
    // The private DDL runs with ONLY the private schema on the path: a migration's own existence probe (the identity
    // fence's `to_regclass(…)` in zzzz20261106110300) must not find the migrated PUBLIC copy and skip the private one.
    await owner.query(`CREATE SCHEMA ${ident(schema)}`); await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl)
    // Schema fixture of the six tables/columns actually consumed by live ACL.
    // This is intentionally NOT evidence for the complete user/auth migrations.
    await owner.query(`
      CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean,
        activation_status text, local_password_set boolean, is_admin boolean);
      CREATE TABLE user_roles (user_id varchar(255), role_id varchar(255), PRIMARY KEY(user_id,role_id));
      CREATE TABLE role_permissions (role_id varchar(255), permission_code varchar(255), PRIMARY KEY(role_id,permission_code));
      CREATE TABLE user_permissions (user_id varchar(255), permission_code varchar(255), PRIMARY KEY(user_id,permission_code));
      CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean NOT NULL, PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean NOT NULL DEFAULT false, UNIQUE(user_id,namespace));
      INSERT INTO users VALUES ('synthetic-owner','user','[]',true,'activated',false,false),
        ('synthetic-other-actor','admin','["role:admin"]',true,'activated',false,true);
      INSERT INTO user_roles VALUES ('synthetic-owner','integration_admin'),('synthetic-other-actor','admin'),('synthetic-other-actor','foreign_admin');
      INSERT INTO role_permissions VALUES ('foreign_admin','integration:admin'),('foreign_admin','role:admin'),
        ('integration_admin','multitable:read');
      INSERT INTO user_permissions VALUES ('synthetic-owner','integration:admin'),('synthetic-other-actor','role:admin');
      INSERT INTO user_orgs VALUES ('synthetic-owner','synthetic-tenant',true),('synthetic-owner','synthetic-other-tenant',true),
        ('synthetic-other-actor','synthetic-tenant',true);
      INSERT INTO user_namespace_admissions VALUES ('synthetic-owner','integration',true),('synthetic-other-actor','integration',true);
    `)
    // D21 (slice Y5): from here on the path falls back to the migrated PUBLIC schema for what this private schema does
    // not define — the two version rows and their triggers (zzzz20261106110500), meta_sheets / meta_fields /
    // meta_records and the permission tables — exactly what the re-authorization locks and reads; the YiDa and ACL
    // tables stay private.
    await owner.query(`SET search_path TO ${ident(schema)}, public`)
    await seedPublicSheet()
    first = await session(); second = await session()
  }, 30000)
  afterEach(async () => {
    for (const active of sessions) active.release()
    for (const active of sessions) { await active.client.query('ROLLBACK').catch(() => {}); active.client.release() }
    sessions.length = 0
    if (schema) { await cleanPublicSheet(); await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  })
  afterAll(async () => {
    try {
      if (owner) { if (schema) await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); owner.release() }
      await pool?.end()
    } finally { for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  })

  it.each(['original', 'equal_integer', 'equal_decimal_exact'])('seals full actual source, plan and expanded selected row: %s', async mode => {
    const f = await fixture(input(mode, mode === 'equal_decimal_exact' ? 0.3 : 6), mode === 'original' ? 0 : 2)
    first.statements.length = 0
    const granted = await first.service.approve(f.request), dbrow = (await tableRows(APPROVAL))[0]
    const sealed = JSON.parse(await security.decrypt(String(dbrow.snapshot_encrypted))) as Row
    const selected = sealed.selection as Row, compiled = compile(f.input), ordinal = mode === 'original' ? 0 : 2
    const planned = compiled.plan.rows[ordinal]
    const expectedSelected = Object.fromEntries(f.input.config.fieldMap.filter(field => Object.hasOwn(planned.payload, String(field.target)))
      .map(field => [String(field.source), planned.payload[String(field.target)]]))
    same(selected.source, compiled.source); same(selected.config, compiled.source.config); same(selected.plan, compiled.plan)
    same(selected.selectedRow, expectedSelected)
    expect((selected.selectedRow as Row).quantity === (mode === 'original' ? 6 : mode === 'equal_integer' ? 2 : 0.1)).toBe(true)
    if (mode !== 'original') expect((JSON.parse(f.input.rowsText) as Row[])[ordinal] === undefined).toBe(true)
    expect(sealed.purpose === 'yida-send-approval' && sealed.schemaVersion === 1 && sealed.grantId === granted.grantId
      && sealed.confirmationId === f.request.confirmationId && sealed.tenantId === context().tenantId
      && sealed.workspaceId === null && sealed.ownerId === context().ownerId && sealed.actorId === context().ownerId
      && sealed.approvedAt === granted.approvedAt && sealed.expiresAt === granted.expiresAt && sealed.ttlMs === 900000 && sealed.maxAttempts === 1).toBe(true)
    expect(selected.operationId === f.draft.operationId && selected.rowKey === f.request.rowKey && selected.targetRef === f.targetRef
      && selected.credentialRef === f.credentialRef && selected.credentialGeneration === 1
      && selected.planDigest === compiled.planDigest && selected.planRevision === compiled.planDigest
      && selected.businessKeyDigest === compiled.rowSpecs[ordinal].businessKeyDigest
      && selected.rowPayloadDigest === compiled.rowSpecs[ordinal].payloadDigest).toBe(true)
    const expectedDigest = executionDigest({ snapshot: { ...selected, grantRef: granted.grantId,
      expiresAt: granted.expiresAt, actorId: context().ownerId }, intent: 'create',
      data: { ...planned.protocolPreview.data, formDataJson: canonical(planned.payload) } })
    expect(dbrow.execution_payload_digest === expectedDigest && sealed.executionPayloadDigest === expectedDigest).toBe(true)
    expect(Object.keys(granted).sort()).toEqual(['admissionId', 'approvedAt', 'canSend', 'expiresAt', 'externalWriteAttempted',
      'grantId', 'ledgerId', 'maxAttempts', 'operationId', 'remainingAttempts', 'reused', 'revoked', 'rowKey', 'status', 'targetRef'])
    expect([granted.status, granted.remainingAttempts, granted.maxAttempts, granted.reused, granted.canSend, granted.externalWriteAttempted])
      .toEqual(['approved', 1, 1, false, false, false])
    expect(granted.expiresAt - granted.approvedAt).toBe(900000)
    expect(first.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    expect(first.statements[1]).toBe(PIN)
    expect(first.statements.filter(sql => sql === 'COMMIT').length).toBe(1)
    expect(first.statements.some(sql => sql.includes('user_permissions') && sql.includes('FOR SHARE'))).toBe(true)
    for (const table of ['integration_yida_credential_materials', OP, MEMBERS]) expect(first.statements.some(sql => sql.includes(table))).toBe(true)
    const persisted = JSON.stringify(await Promise.all(proofTables.map(tableRows)))
    for (const secret of [...Object.values(material()), 'synthetic approval part', 'synthetic_approval_form']) expect(persisted.includes(secret)).toBe(false)
    expect((await evidence()).counts).toEqual([1, 0, 0, 1, 0, 0])
    const admitted = await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    expect([admitted.status, admitted.remainingAttempts, admitted.canSend, admitted.externalWriteAttempted]).toEqual(['admitted', 0, false, false])
    const ledger = (await tableRows(LEDGER))[0]
    expect(ledger.id === admitted.ledgerId && ledger.status === 'prepared' && ledger.payload_digest === expectedDigest).toBe(true)
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
  })

  it('same confirmation is immutable and does not renew; different ttl, operation or member conflicts', async () => {
    const f = await fixture(input('equal_integer'), 0), one = await first.service.approve(f.request), before = await evidence()
    const restarted = await session(), two = await restarted.service.approve({ ...f.request, ttlMs: 900000 })
    expect(two.reused && two.grantId === one.grantId && two.approvedAt === one.approvedAt && two.expiresAt === one.expiresAt).toBe(true)
    await rejected(first.service.approve({ ...f.request, ttlMs: 1000 }), 'CONFLICT')
    await rejected(first.service.approve({ ...f.request, rowKey: f.draft.rows[1].rowKey }), 'CONFLICT')
    const changed = await second.draft.createDraft(input('equal_integer', 9))
    await rejected(first.service.approve({ ...f.request, operationId: changed.operationId, rowKey: changed.rows[0].rowKey }), 'CONFLICT')
    expect(await evidence()).toEqual(before)
  })

  it('closed input rejects unsafe TTL, caller authority and accessor/proxy inputs before opening a transaction', async () => {
    const f = await fixture(), before = await evidence(); first.statements.length = 0
    for (const ttlMs of [0, -1, 900001, 1.5, NaN, Infinity, '900000', null, undefined])
      await rejected(first.service.approve({ ...f.request, ttlMs }), 'INPUT')
    for (const key of ['ownerId', 'targetRef', 'selectedRow', 'config', 'maxAttempts', 'isAdmin'])
      await rejected(first.service.approve({ ...f.request, [key]: true }), 'INPUT')
    let calls = 0
    const accessor = { ...f.request }; Object.defineProperty(accessor, 'operationId', { enumerable: true, get() { calls++; return f.request.operationId } })
    await rejected(first.service.approve(accessor), 'INPUT')
    await rejected(first.service.approve(new Proxy(f.request, { ownKeys() { calls++; return [] } })), 'INPUT')
    await rejected(first.service.inspect({ grantId: 'synthetic', extra: true }), 'INPUT')
    await rejected(first.service.revoke({ grantId: 'synthetic', reason: 'synthetic' }), 'INPUT')
    await rejected(first.service.admit({ grantId: 'synthetic', submissionId: 'synthetic', operationId: f.request.operationId }), 'INPUT')
    expect(calls).toBe(0); expect(first.statements.length).toBe(0); expect(await evidence()).toEqual(before)
  })

  it('DB expiry is final for fresh admission and confirmation replay cannot renew the original window', async () => {
    const f = await fixture(), granted = await first.service.approve({ ...f.request, ttlMs: 20 })
    await new Promise(resolve => setTimeout(resolve, 60))
    const view = await second.service.inspect({ grantId: granted.grantId })
    expect([view.status, view.remainingAttempts]).toEqual(['expired', 0])
    await rejected(second.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' }), 'EXPIRED')
    const replay = await second.service.approve({ ...f.request, ttlMs: 20 })
    expect(replay.reused && replay.expiresAt === granted.expiresAt && replay.status === 'expired').toBe(true)
    expect((await evidence()).counts).toEqual([1, 0, 0, 1, 0, 0])
  })

  it.each(['missing-admin', 'revoked-permission', 'inactive', 'wrong-tenant', 'namespace-revoked'])('actual live ACL rejects %s without borrowing unrelated positive authority', async mode => {
    const f = await fixture()
    const granted = mode === 'missing-admin' ? undefined : await first.service.approve(f.request)
    if (mode === 'missing-admin' || mode === 'revoked-permission') await owner.query("DELETE FROM user_permissions WHERE user_id='synthetic-owner'")
    if (mode === 'inactive') await owner.query("UPDATE users SET is_active=false WHERE id='synthetic-owner'")
    if (mode === 'wrong-tenant') await owner.query("DELETE FROM user_orgs WHERE user_id='synthetic-owner' AND org_id='synthetic-tenant'")
    if (mode === 'namespace-revoked') await owner.query("UPDATE user_namespace_admissions SET enabled=false WHERE user_id='synthetic-owner'")
    await livePositive(context({ ownerId: 'synthetic-other-actor' }))
    if (mode === 'wrong-tenant') await livePositive(context({ tenantId: 'synthetic-other-tenant' }))
    const before = await evidence(); first.statements.length = 0
    await rejected(first.service.approve(f.request))
    if (granted) {
      await rejected(first.service.inspect({ grantId: granted.grantId }))
      await rejected(first.service.revoke({ grantId: granted.grantId }))
      await rejected(first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' }))
    }
    expect(first.statements.some(sql => sql.includes('integration_yida_'))).toBe(false)
    expect(await evidence()).toEqual(before)
  })

  it.each(['owner', 'tenant'])('independently authorized foreign %s cannot read, admit or revoke another scope', async mode => {
    const f = await fixture(), granted = await first.service.approve(f.request)
    const scope = mode === 'owner' ? context({ ownerId: 'synthetic-other-actor' }) : context({ tenantId: 'synthetic-other-tenant' })
    await livePositive(scope)
    const foreign = await session(scope), before = await evidence()
    await rejected(foreign.service.inspect({ grantId: granted.grantId }), 'NOT_FOUND')
    await rejected(foreign.service.revoke({ grantId: granted.grantId }), 'NOT_FOUND')
    await rejected(foreign.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' }), 'NOT_FOUND')
    await rejected(foreign.service.approve(f.request), 'NOT_FOUND')
    expect(await evidence()).toEqual(before)
  })

  it.each(['confirmation', 'submission'])('two different PIDs serialize the same %s to one committed identity', async mode => {
    const f = await fixture(), grant = mode === 'submission' ? await first.service.approve(f.request) : undefined
    const invoke = (active: Session) => mode === 'confirmation' ? active.service.approve(f.request)
      : active.service.admit({ grantId: grant!.grantId, submissionId: 'synthetic-submission' })
    let one: MutationMetadata | undefined, two: MutationMetadata | undefined
    const gate = first.gateInsert(mode === 'confirmation' ? AUDIT : ADMISSION)
    const winner = outcome(invoke(first).then(value => { one = value }))
    let follower: ReturnType<typeof outcome> | undefined
    try { await reached(gate); follower = outcome(invoke(second).then(value => { two = value })); await blocked(second, first) }
    finally { gate.release() }
    expect(await winner).toEqual({ ok: true }); expect(await follower).toEqual({ ok: true })
    expect(one?.reused === false && two?.reused === true && one?.grantId === two?.grantId).toBe(true)
    if (mode === 'submission') expect(one?.ledgerId === two?.ledgerId && one?.admissionId === two?.admissionId).toBe(true)
    expect((await evidence()).counts).toEqual(mode === 'confirmation' ? [1, 0, 0, 1, 0, 0] : [1, 0, 1, 2, 1, 1])
  })

  it.each(['approve-audit', 'prepare', 'prepare-audit', 'admission', 'admit-audit', 'revoke-audit'])('real SQL failure rolls back the whole transaction: %s', async mode => {
    const f = await fixture(), grant = mode === 'approve-audit' ? undefined : await first.service.approve(f.request)
    const table = mode === 'prepare' ? LEDGER : mode === 'prepare-audit' ? LEDGER_AUDIT : mode === 'admission' ? ADMISSION : AUDIT
    const invoke = () => mode === 'approve-audit' ? first.service.approve(f.request)
      : mode === 'revoke-audit' ? first.service.revoke({ grantId: grant!.grantId })
        : first.service.admit({ grantId: grant!.grantId, submissionId: 'synthetic-submission' })
    await failInsert(table)
    const before = await evidence(); await rejected(invoke()); expect(await evidence()).toEqual(before)
    await removeFailure(table)
    expect((await invoke()).reused).toBe(false)
    expect((await evidence()).counts).toEqual(mode === 'approve-audit' ? [1, 0, 0, 1, 0, 0]
      : mode === 'revoke-audit' ? [1, 1, 0, 2, 0, 0] : [1, 0, 1, 2, 1, 1])
  })

  it.each(['approve', 'admit'])('lost actual COMMIT reply is unavailable, and new-session %s replay only observes the committed identity', async mode => {
    const f = await fixture(), grant = mode === 'admit' ? await first.service.approve(f.request) : undefined
    const invoke = (active: Session) => mode === 'approve' ? active.service.approve(f.request)
      : active.service.admit({ grantId: grant!.grantId, submissionId: 'synthetic-submission' })
    first.loseCommitResponse(); await rejected(invoke(first))
    const before = await evidence(), restarted = await session(), observed = await invoke(restarted)
    expect(observed.reused).toBe(true); expect(await evidence()).toEqual(before)
    expect(restarted.statements.some(businessInsert)).toBe(false)
    if (mode === 'admit') {
      expect(observed.remainingAttempts).toBe(0)
      expect(restarted.statements.some(sql => sql.includes(OP) || sql.includes('integration_yida_credential_materials') || sql.includes(LEDGER))).toBe(false)
    }
    expect(before.counts).toEqual(mode === 'approve' ? [1, 0, 0, 1, 0, 0] : [1, 0, 1, 2, 1, 1])
  })

  it.each(['revoke-first', 'admit-first'])('revoke and admit obey observed PG lock/commit order: %s', async order => {
    const f = await fixture(), grant = await first.service.approve(f.request), args = { grantId: grant.grantId }
    const gate = first.gateInsert(order === 'revoke-first' ? AUDIT : ADMISSION)
    const winner = outcome(order === 'revoke-first' ? first.service.revoke(args) : first.service.admit({ ...args, submissionId: 'synthetic-submission' }))
    let follower: ReturnType<typeof outcome> | undefined
    try {
      await reached(gate)
      follower = outcome(order === 'revoke-first' ? second.service.admit({ ...args, submissionId: 'synthetic-submission' }) : second.service.revoke(args))
      await blocked(second, first)
    } finally { gate.release() }
    expect(await winner).toEqual({ ok: true })
    expect(await follower).toEqual(order === 'revoke-first' ? { ok: false, code: 'YIDA_SEND_APPROVAL_REVOKED' } : { ok: true })
    const restarted = await session(), view = await restarted.service.inspect(args)
    expect([view.status, view.revoked, view.remainingAttempts]).toEqual([order === 'revoke-first' ? 'revoked' : 'admitted', true, 0])
    const before = await evidence(); expect((await restarted.service.revoke(args)).reused).toBe(true); expect(await evidence()).toEqual(before)
    expect(before.counts).toEqual(order === 'revoke-first' ? [1, 1, 0, 2, 0, 0] : [1, 1, 1, 3, 1, 1])
  })

  it('live positive permission is locked through commit; the next operation observes its revocation', async () => {
    const f = await fixture(), gate = first.gateInsert(AUDIT), approving = outcome(first.service.approve(f.request))
    let revoked: ReturnType<typeof outcome> | undefined
    try {
      await reached(gate)
      revoked = outcome(second.client.query("DELETE FROM user_permissions WHERE user_id='synthetic-owner'"))
      await blocked(second, first)
    } finally { gate.release() }
    expect(await approving).toEqual({ ok: true }); expect(await revoked).toEqual({ ok: true })
    await rejected(first.service.inspect({ grantId: String((await tableRows(APPROVAL))[0].grant_id) }))
    expect((await evidence()).counts).toEqual([1, 0, 0, 1, 0, 0])
  })

  it.each(['revoke', 'rotate'])('current material %s invalidates fresh admission without deleting the grant', async mode => {
    const f = await fixture(), grant = await first.service.approve(f.request)
    const request = { credentialRef: f.credentialRef, expectedGeneration: 1 }
    if (mode === 'revoke') await second.material.revoke(request)
    else await second.material.rotate({ ...request, material: material() })
    const before = await evidence(); await rejected(first.service.admit({ grantId: grant.grantId, submissionId: 'synthetic-submission' }))
    expect(await evidence()).toEqual(before)
    expect((await first.service.inspect({ grantId: grant.grantId })).grantId === grant.grantId).toBe(true)
  })

  it.each(['revoke', 'rotate'])('lost approval COMMIT plus material %s still recovers exact confirmation without renewal or fresh resolution', async mode => {
    const f = await fixture(input('equal_integer'))
    const changed = await second.draft.createDraft(input('equal_integer', 9))
    first.loseCommitResponse(); await rejected(first.service.approve(f.request))
    const old = (await tableRows(APPROVAL))[0]
    const materialRequest = { credentialRef: f.credentialRef, expectedGeneration: 1 }
    if (mode === 'revoke') await second.material.revoke(materialRequest)
    else await second.material.rotate({ ...materialRequest, material: material() })
    const before = await evidence(), restarted = await session()
    const recovered = await restarted.service.approve({ ...f.request, ttlMs: 900000 })
    expect(recovered.reused && recovered.grantId === old.grant_id && recovered.approvedAt === Number(old.approved_at_ms)
      && recovered.expiresAt === Number(old.expires_at_ms)).toBe(true)
    expect(restarted.statements.some(sql => sql.includes(OP) || sql.includes('integration_yida_credential_materials') || businessInsert(sql))).toBe(false)
    await rejected(restarted.service.approve({ ...f.request, ttlMs: 1000 }), 'CONFLICT')
    await rejected(restarted.service.approve({ ...f.request, rowKey: f.draft.rows[1].rowKey }), 'CONFLICT')
    await rejected(restarted.service.approve({ ...f.request, operationId: changed.operationId, rowKey: changed.rows[0].rowKey }), 'CONFLICT')
    await rejected(restarted.service.approve({ ...f.request, confirmationId: 'synthetic-new-confirmation' }))
    expect(await evidence()).toEqual(before)
  })

  it('expiry after real prepare rolls back ledger and prepare audit together with admission', async () => {
    const f = await fixture(), grant = await first.service.approve({ ...f.request, ttlMs: 1000 })
    const before = await evidence(), gate = first.gateInsert(LEDGER_AUDIT)
    const pending = outcome(first.service.admit({ grantId: grant.grantId, submissionId: 'synthetic-submission' }))
    try { await reached(gate); await new Promise(resolve => setTimeout(resolve, 1100)) }
    finally { gate.release() }
    expect(await pending).toEqual({ ok: false, code: 'YIDA_SEND_APPROVAL_EXPIRED' })
    expect(await evidence()).toEqual(before)
  })

  it('admission holds actual 090 until commit; material revocation permits only historical observation, never a new attempt', async () => {
    const f = await fixture(), grant = await first.service.approve(f.request), gate = first.gateInsert(ADMISSION)
    const args = { grantId: grant.grantId, submissionId: 'synthetic-submission' }, admitting = outcome(first.service.admit(args))
    let revoked: ReturnType<typeof outcome> | undefined
    try { await reached(gate); revoked = outcome(second.material.revoke({ credentialRef: f.credentialRef, expectedGeneration: 1 })); await blocked(second, first) }
    finally { gate.release() }
    expect(await admitting).toEqual({ ok: true }); expect(await revoked).toEqual({ ok: true })
    const restarted = await session(), before = await evidence(), observed = await restarted.service.admit(args)
    expect(observed.reused && observed.remainingAttempts === 0).toBe(true)
    expect(restarted.statements.some(sql => sql.includes(OP) || sql.includes('integration_yida_credential_materials'))).toBe(false)
    await rejected(restarted.service.admit({ ...args, submissionId: 'synthetic-another-submission' }), 'CONFLICT')
    await owner.query("DELETE FROM user_permissions WHERE user_id='synthetic-owner'")
    await rejected(restarted.service.admit(args))
    expect(await evidence()).toEqual(before)
  })

  it.each(['source', 'plan', 'member'])('real 091 %s corruption is refused before preparing a ledger', async mode => {
    const f = await fixture(), grant = await first.service.approve(f.request)
    if (mode === 'member') await corrupt(MEMBERS, 'trg_yida_draft_rows_immutable', 'payload_digest', 'a'.repeat(64))
    else {
      const snapshot = JSON.parse(await security.decrypt(String((await tableRows(OP))[0].snapshot_encrypted))) as Row
      if (mode === 'source') (snapshot.source as Row).rowsText = input('original', 7).rowsText
      else ((snapshot.plan as Compiled['plan']).rows[0].payload).qty = 7
      await corrupt(OP, 'trg_yida_draft_operations_immutable', 'snapshot_encrypted', await security.encrypt(JSON.stringify(snapshot)))
    }
    const before = await evidence(); await rejected(first.service.admit({ grantId: grant.grantId, submissionId: 'synthetic-submission' }))
    expect(await evidence()).toEqual(before)
  })

  it.each(['owner', 'selected-row', 'grant'])('encrypted 093 snapshot binding refuses a validly re-encrypted wrong %s', async mode => {
    const f = await fixture(), grant = await first.service.approve(f.request)
    const sealed = JSON.parse(await security.decrypt(String((await tableRows(APPROVAL))[0].snapshot_encrypted))) as Row
    if (mode === 'owner') sealed.ownerId = 'synthetic-other-actor'
    if (mode === 'grant') sealed.grantId = randomUUID()
    if (mode === 'selected-row') ((sealed.selection as Row).selectedRow as Row).quantity = 7
    await corrupt(APPROVAL, 'trg_yida_send_approvals_immutable', 'snapshot_encrypted', await security.encrypt(JSON.stringify(sealed)))
    const before = await evidence(); await rejected(first.service.admit({ grantId: grant.grantId, submissionId: 'synthetic-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(before)
  })

  it.each(['prepared', 'not_sent'])('new grants, operations and aliases cannot release the permanent 089 business-key fence in %s', async status => {
    const f = await fixture(), granted = await first.service.approve(f.request)
    const admitted = await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    if (status === 'not_sent') await first.ledger.cancelPrepared({ ...context(), operationId: f.draft.operationId,
      rowKey: f.request.rowKey, actorId: context().ownerId })
    expect((await tableRows(LEDGER))[0].status).toBe(status)
    const changed = await second.draft.createDraft(alias(input('original', 7)))
    expect(changed.operationId !== f.draft.operationId && changed.rows[0].rowKey !== f.request.rowKey).toBe(true)
    const memberRows = await tableRows(MEMBERS)
    expect(new Set(memberRows.map(row => row.business_key_digest)).size).toBe(1)
    const newGrant = await second.service.approve({ operationId: changed.operationId, rowKey: changed.rows[0].rowKey, confirmationId: 'synthetic-new-confirmation' })
    expect(newGrant.targetRef === f.targetRef && newGrant.grantId !== granted.grantId).toBe(true)
    const before = await evidence()
    // Actual 089 unique violation is closed by the private port, not retried.
    await rejected(second.service.admit({ grantId: newGrant.grantId, submissionId: 'synthetic-new-submission' }))
    await rejected(second.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-new-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    const restarted = await session(), view = await restarted.service.inspect({ grantId: granted.grantId })
    expect(view.ledgerId === admitted.ledgerId && view.remainingAttempts === 0 && view.status === 'admitted').toBe(true)
    expect(before.counts).toEqual([2, 0, 1, 3, 1, status === 'not_sent' ? 2 : 1])
  })

  it('another confirmation for the same operation/member is not another usable attempt', async () => {
    const f = await fixture(), one = await first.service.approve(f.request)
    const consumed = await first.service.admit({ grantId: one.grantId, submissionId: 'synthetic-submission' })
    const two = await second.service.approve({ ...f.request, confirmationId: 'synthetic-other-confirmation' })
    expect(two.grantId !== one.grantId && two.targetRef === one.targetRef).toBe(true)
    const before = await evidence()
    await rejected(second.service.admit({ grantId: two.grantId, submissionId: 'synthetic-other-submission' }))
    expect(await evidence()).toEqual(before)
    expect((await tableRows(LEDGER))[0].id === consumed.ledgerId).toBe(true)
    expect(before.counts).toEqual([2, 0, 1, 3, 1, 1])
  })

  it('an identical already-prepared 088 snapshot cannot be adopted as a fresh 093 admission', async () => {
    const f = await fixture(), grant = await first.service.approve(f.request)
    const approved = (await tableRows(APPROVAL))[0]
    const snapshot = { tenantId: approved.tenant_id, workspaceId: approved.workspace_id, ownerId: approved.owner_id,
      operationId: approved.operation_id, rowKey: approved.row_key, targetRef: approved.target_ref,
      targetRevision: approved.target_revision, planRevision: approved.plan_revision,
      credentialRef: approved.credential_ref, credentialGeneration: approved.credential_generation,
      businessKeyDigest: approved.business_key_digest, payloadDigest: approved.execution_payload_digest, intent: 'create' }
    // Actual public LedgerStore.prepare establishes the same snapshot which the
    // private primitive will encounter, without fabricating a port or admission.
    const prepared = await first.ledger.prepare(snapshot)
    expect(prepared.reused === false && prepared.record.status === 'prepared').toBe(true)
    const before = await evidence()
    expect(before.counts).toEqual([1, 0, 0, 1, 1, 1])
    const exactReplay = await second.ledger.prepare(snapshot)
    expect(exactReplay.reused === true && exactReplay.record.id === prepared.record.id).toBe(true)
    expect(await evidence()).toEqual(before)
    // First observable failure must be this service guard, not a changed digest
    // rejected earlier by 088 sameSnapshot or a different target/business fence.
    await rejected(first.service.admit({ grantId: grant.grantId, submissionId: 'synthetic-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(before)
  })

  it('populated 093 tables reject ordinary UPDATE/DELETE/TRUNCATE; migration replay and restart preserve consumed budget', async () => {
    const f = await fixture(), grant = await first.service.approve(f.request), args = { grantId: grant.grantId }
    await first.service.admit({ ...args, submissionId: 'synthetic-submission' }); await first.service.revoke(args)
    const before = await evidence()
    expect(before.counts).toEqual([1, 1, 1, 3, 1, 1]) // No zero-row UPDATE false positive.
    for (const table of [APPROVAL, REVOCATION, ADMISSION, AUDIT]) {
      for (const sql of [`UPDATE ${ident(table)} SET created_at=created_at`, `DELETE FROM ${ident(table)}`, `TRUNCATE ${ident(table)} CASCADE`]) {
        expect(await outcome(owner.query(sql))).toEqual({ ok: false, code: 'P0001' })
        expect(await evidence()).toEqual(before)
      }
    }
    await owner.query(approvalDdl); await owner.query(approvalDdl)
    expect(await evidence()).toEqual(before)
    const restarted = await session(), view = await restarted.service.inspect(args)
    expect([view.status, view.revoked, view.remainingAttempts]).toEqual(['admitted', true, 0])
    expect((await restarted.service.admit({ ...args, submissionId: 'synthetic-submission' })).reused).toBe(true)
    expect(await evidence()).toEqual(before)
  })

  // Gate 4 (R-71 ⑦.2): the shared send budget is checked before the grant is written (approve) and
  // before the ledger fence is prepared (admit). Synthetic 32-field configs; nothing is a customer value.
  const WORST = { systemToken: '\u0001'.repeat(4096), userId: '\u0001'.repeat(128) }
  const shortTarget = (index: number) => 't' + index
  const longTarget = (index: number) => ('t' + index).padEnd(128, 'x')
  function budgetInput(row: Row, target = shortTarget, optionCount = 0,
    locator = { appType: 'synthetic_budget_app', formUuid: 'synthetic_budget_form' }): Input {
    const fields = Array.from({ length: 32 }, (_, index) => index)
    const options = Array.from({ length: optionCount }, (_, index) => (String(index) + '选项').padEnd(128, '项'))
    return { config: { version: 2, kind: 'yida-form-protocol-static', intent: 'create', target: { ...locator },
      businessKey: ['s0'], emptyKeyFields: [],
      fieldCatalog: fields.map(index => optionCount && index >= 16
        ? { id: target(index), control: 'select', required: false, options }
        : { id: target(index), control: 'text', required: index === 0 }),
      fieldMap: fields.map(index => ({ source: 's' + index, target: target(index), type: 'string', required: index === 0 })) },
    rowsText: JSON.stringify([row]), allocation: { mode: 'original' } }
  }
  // Key 'K', text fields s1..s<text> each 'b' + quotes, the rest null (select fields).
  function quoteRow(count: number, text = 31): Row {
    const row: Row = { s0: 'K' }
    let left = count
    for (let index = 1; index < 32; index++) {
      if (index > text) { row['s' + index] = null; continue }
      const take = Math.min(4095, left); row['s' + index] = 'b' + '"'.repeat(take); left -= take
    }
    return row
  }
  function worstBody(value: Input): number {
    const planned = plan({ config: value.config, rows: JSON.parse(value.rowsText) as Row[] }).rows[0]
    expect(planned.status).toBe('planned_create')
    const data = { ...planned.protocolPreview.data, formDataJson: canonical(planned.payload) }
    return Buffer.byteLength(sendBudget.encodeYidaFormRequestBody(data, WORST.systemToken, WORST.userId), 'utf8')
  }
  // The largest all-quote row whose worst-case request body is still within the shared limit.
  function boundaryRow(make: (row: Row) => Input): Row {
    let low = 0, high = 31 * 4095
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      let fits = false
      try { fits = worstBody(make(quoteRow(mid))) <= sendBudget.YIDA_SEND_REQUEST_MAX_BYTES } catch { fits = false }
      if (fits) low = mid; else high = mid - 1
    }
    return quoteRow(low)
  }
  // Measured identical on the pre-gate-4 source (main a066f61c7): the budget check adds no crypto call.
  const G4_EXPECTED_COUNTS = [{ encrypt: 1, decrypt: 6 }, { encrypt: 0, decrypt: 7 }]
  const statementsTouch = (active: Session, table: string) => active.statements.some(sql => sql.includes(table))

  it.each(['snapshot', 'request-body'])('gate 4: an over-budget %s row is refused at approval with LIMIT, before any grant, seal or audit', async kind => {
    const counter = { encrypt: 0, decrypt: 0 }
    const value = kind === 'snapshot'
      // 16 select fields of 64 long options: the config alone is over the snapshot limit.
      ? budgetInput({ s0: 'K', ...Object.fromEntries(Array.from({ length: 31 }, (_, index) => ['s' + (index + 1), index < 15 ? 'b' : null])) }, shortTarget, 64)
      // Escape doubling: every quote costs 4 bytes in the request body, so this row is over even with realistic credentials.
      : budgetInput(quoteRow(64000), longTarget)
    if (kind === 'request-body') expect(worstBody(value) > sendBudget.YIDA_SEND_REQUEST_MAX_BYTES).toBe(true)
    const f = await fixture(value), active = await session(context(), { counter })
    active.statements.length = 0
    await rejected(active.service.approve(f.request), 'LIMIT')
    expect((await evidence()).counts).toEqual([0, 0, 0, 0, 0, 0])
    expect(counter.encrypt).toBe(0)
    expect(active.statements.some(businessInsert)).toBe(false)
    expect(active.statements.filter(sql => sql === 'ROLLBACK').length).toBe(1)
    // Fixed values-free refusal: replaying it yields the same code and still writes nothing.
    await rejected(active.service.approve({ ...f.request, confirmationId: 'synthetic-other-confirmation' }), 'LIMIT')
    expect((await evidence()).counts).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('gate 4: a joint config+row snapshot overflow (config alone and body within) is refused at approval with no grant', async () => {
    // 16 selects x 20 long options (~124 KB config) plus 15 near-cap CJK text fields (~131 KB row JSON).
    const row: Row = { s0: 'K', ...Object.fromEntries(Array.from({ length: 31 }, (_, index) => ['s' + (index + 1), index < 15 ? '' : null])) }
    for (let index = 1; index <= 15; index++) {
      const room = Math.floor((130800 - Buffer.byteLength(JSON.stringify([row]), 'utf8')) / 3)
      row['s' + index] = '中'.repeat(Math.max(0, Math.min(4096, room)))
    }
    const value = budgetInput(row, shortTarget, 20)
    const planned = plan({ config: value.config, rows: [row] }).rows[0]
    expect(planned.status).toBe('planned_create')
    const data = { ...planned.protocolPreview.data, formDataJson: canonical(planned.payload) }
    const selectedRow = Object.fromEntries(Object.entries(row).filter(([, field]) => field !== null))
    // Real-length synthetic identifiers; the verdicts below hold with tens of KB of margin either way.
    const ids = (tag: string) => ('synthetic-' + tag).padEnd(36, '0')
    const snapshot = (rowValue: Row): Row => ({ tenantId: ids('tenant'), workspaceId: null, ownerId: ids('owner'), actorId: ids('owner'),
      operationId: ids('operation'), rowKey: ids('row'), grantRef: ids('grant'), expiresAt: 2000000000000, targetRef: ids('target'),
      targetRevision: 'evidence-1', planRevision: 'f'.repeat(64), credentialRef: ids('credential'), credentialGeneration: 1,
      config: value.config, row: rowValue })
    expect(worstBody(value) < sendBudget.YIDA_SEND_REQUEST_MAX_BYTES - 60000).toBe(true)
    expect(sendBudget.assessYidaSendBudget({ snapshot: snapshot({}), data }).withinBudget).toBe(true)
    expect(sendBudget.assessYidaSendBudget({ snapshot: snapshot(selectedRow), data }).withinBudget).toBe(false)
    const f = await fixture(value), active = await session(context())
    active.statements.length = 0
    await rejected(active.service.approve(f.request), 'LIMIT')
    expect((await evidence()).counts).toEqual([0, 0, 0, 0, 0, 0])
    expect(active.statements.some(businessInsert)).toBe(false)
  })

  it('gate 4: a row exactly within the worst-case request budget is approved and admitted', async () => {
    const make = (row: Row) => budgetInput(row)
    const row = boundaryRow(make), value = make(row)
    const body = worstBody(value)
    expect(body <= sendBudget.YIDA_SEND_REQUEST_MAX_BYTES && body > sendBudget.YIDA_SEND_REQUEST_MAX_BYTES - 4).toBe(true)
    const f = await fixture(value), granted = await first.service.approve(f.request)
    expect([granted.status, granted.remainingAttempts]).toEqual(['approved', 1])
    const admitted = await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    expect([admitted.status, admitted.remainingAttempts]).toEqual(['admitted', 0])
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
  })

  it('gate 4: an admission refused by the budget leaves no trace; once lifted the same grant is admitted', async () => {
    const budget: BudgetSwitch = { within: null, calls: 0 }
    const f = await fixture(), active = await session(context(), { budget })
    const granted = await active.service.approve(f.request)
    expect(budget.calls).toBe(1)
    const before = await evidence()
    expect(before.counts).toEqual([1, 0, 0, 1, 0, 0])
    budget.within = false; active.statements.length = 0
    const args = { grantId: granted.grantId, submissionId: 'synthetic-submission' }
    await rejected(active.service.admit(args), 'LIMIT')
    expect(budget.calls).toBe(2)
    // Refused before the ledger is even read: no prepare, no fence, no admission, no admit audit.
    expect(statementsTouch(active, LEDGER) || statementsTouch(active, LEDGER_AUDIT)).toBe(false)
    expect(active.statements.some(businessInsert)).toBe(false)
    expect(await evidence()).toEqual(before)
    const view = await active.service.inspect({ grantId: granted.grantId })
    expect([view.status, view.remainingAttempts, view.admissionId, view.ledgerId, view.revoked]).toEqual(['approved', 1, null, null, false])
    expect((await owner.query(`SELECT count(*)::int AS n FROM ${ident(ADMISSION)} WHERE grant_id = $1`, [granted.grantId])).rows[0].n).toBe(0)
    expect((await owner.query(`SELECT count(*)::int AS n FROM ${ident(LEDGER)} WHERE operation_id = $1 AND row_key = $2`,
      [f.request.operationId, f.request.rowKey])).rows[0].n).toBe(0)
    expect((await tableRows(AUDIT)).map(row => row.event)).toEqual(['approve'])
    // Not revoked or consumed (h1): lift the refusal and the very same grant is admitted.
    budget.within = null
    const admitted = await active.service.admit(args)
    expect([admitted.grantId, admitted.status, admitted.remainingAttempts, admitted.reused]).toEqual([granted.grantId, 'admitted', 0, false])
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
    expect((await tableRows(AUDIT)).map(row => row.event).sort()).toEqual(['admit', 'approve'])
  })

  const malformedVerdicts: Array<[string, () => unknown]> = [
    ['string-true', () => 'true'], ['true', () => true], ['empty', () => Object.freeze({})],
    ['truthy-number', () => Object.freeze({ withinBudget: 1 })], ['unfrozen', () => ({ withinBudget: true })],
    ['extra-key', () => Object.freeze({ withinBudget: true, bytes: 1 })],
    ['accessor', () => Object.freeze(Object.defineProperty({}, 'withinBudget', { enumerable: true, get: () => true }))],
    ['proxy', () => new Proxy(Object.freeze({ withinBudget: true }), {})],
    ['inherited', () => Object.freeze(Object.create(Object.freeze({ withinBudget: true })))],
    ['promise', () => Promise.resolve(Object.freeze({ withinBudget: true }))],
    ['rejected-promise', () => Promise.reject(new Error('SYNTHETIC_BUDGET_FAILURE'))],
    ['throws', () => { throw new Error('SYNTHETIC_BUDGET_FAILURE') }],
  ]
  it.each(malformedVerdicts.flatMap(([name, verdict]) => [['approve', name, verdict], ['admit', name, verdict]] as const))
  ('gate 4 fail-closed: a %s-time %s budget verdict is refused and writes nothing', async (stage, _name, verdict) => {
    const budget: BudgetSwitch = { within: null, calls: 0 }
    const f = await fixture(), active = await session(context(), { budget })
    const granted = stage === 'admit' ? await active.service.approve(f.request) : undefined
    const before = await evidence()
    budget.verdict = verdict
    await rejected(stage === 'approve' ? active.service.approve(f.request)
      : active.service.admit({ grantId: granted!.grantId, submissionId: 'synthetic-submission' }), 'UNAVAILABLE')
    expect(budget.calls).toBe(stage === 'approve' ? 1 : 2)
    expect(await evidence()).toEqual(before)
    expect(before.counts).toEqual(stage === 'approve' ? [0, 0, 0, 0, 0, 0] : [1, 0, 0, 1, 0, 0])
  })

  it('gate 4: approval and admission perform the same host encrypt/decrypt calls as before the budget check (no material read)', async () => {
    const counter = { encrypt: 0, decrypt: 0 }
    const f = await fixture(), active = await session(context(), { counter })
    const granted = await active.service.approve(f.request)
    const approveCounts = { ...counter }
    counter.encrypt = 0; counter.decrypt = 0
    await active.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    expect([approveCounts, { ...counter }]).toEqual(G4_EXPECTED_COUNTS)
  })

  it('gate 4 (Y2 multi-target): the named slot-2 target is budgeted with its own locator, not slot 1\'s', async () => {
    await owner.query(multiTargetUp)
    const longLocator = { appType: 'A'.repeat(128), formUuid: 'F'.repeat(128) }
    // One row at the slot-1 boundary; the same row under the 128-character slot-2 locator is over it.
    const row = boundaryRow(value => budgetInput(value))
    const one = budgetInput(row), two = budgetInput(row, shortTarget, 0, longLocator)
    expect(worstBody(one) <= sendBudget.YIDA_SEND_REQUEST_MAX_BYTES && worstBody(two) > sendBudget.YIDA_SEND_REQUEST_MAX_BYTES).toBe(true)
    const f = await fixture(one)
    const draft = await first.draft.createDraft(two), secret = await first.material.create({ material: material() })
    const writer = createAdditionalWriter({ security, context: context() })
    const slot2 = await (first.db as { transaction<T>(callback: (trx: { setTransactionIsolationLevel(level: string): Promise<void> }) => Promise<T>): Promise<T> })
      .transaction(async trx => {
        await trx.setTransactionIsolationLevel('read committed')
        return writer(trx, { operationId: draft.operationId, credentialRef: secret.credentialRef,
          credentialGeneration: secret.credentialGeneration, attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review',
            organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' } })
      })
    expect(slot2.slot).toBe(2)
    const multi = await session(context(), { multiTarget: true })
    const granted = await multi.service.approve({ ...f.request, targetRef: f.targetRef })
    expect([granted.status, granted.targetRef]).toEqual(['approved', f.targetRef])
    const before = await evidence()
    await rejected(multi.service.approve({ operationId: draft.operationId, rowKey: draft.rows[0].rowKey,
      confirmationId: 'synthetic-slot2-confirmation', targetRef: slot2.targetRef }), 'LIMIT')
    expect(await evidence()).toEqual(before)
    expect(before.counts).toEqual([1, 0, 0, 1, 0, 0])
  })

  // ---- Source binding, identity fence and D20 (design baseline v2.3 §3.3 / §7.2; D16 a, D20) ----
  const REGISTRY = 'integration_stock_prep_project_target'
  // D21 (slice Y5): the bound sheet, its fields, its records and every deny / membership row live in PUBLIC — the migrated
  // schema that carries the protocol's triggers and version rows (nothing in the private schema shadows them) — under
  // per-test ids that `afterEach` removes. The owner reads the sheet through `multitable:read` (role permission above).
  const ids = () => ({ sheet: `${schema}_sheet`, rec: (index: number) => `${schema}_rec_${index}`, fld: (target: string) => `${schema}_fld_${target}` })
  const LINES = ['LINE-1', 'LINE-2', 'LINE-3']
  // RA2 (i): a VISIBLE field whose id is the alias `description`; the real column behind that alias is `…_fld_description`.
  const DECOY_FIELD_ID = 'description'
  async function seedPublicSheet() {
    const { sheet, rec, fld } = ids()
    await owner.query('INSERT INTO public.meta_sheets (id, name, row_level_read_permissions_enabled) VALUES ($1, $2, true)', [sheet, 'synthetic bound sheet'])
    const columns: Array<[string, string]> = [['project', 'text'], ['line', 'text'], ['parent', 'text'], ['qty', 'number'],
      ['description', 'text'], ['note', 'text'], ['status', 'text']]
    for (const [order, [target, type]] of columns.entries()) {
      await owner.query('INSERT INTO public.meta_fields (id, sheet_id, name, type, "order", property) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
        [fld(target), sheet, target, type, order, JSON.stringify(target === 'line' ? { stockPreparation: { key: true } } : {})])
    }
    await owner.query('INSERT INTO public.meta_fields (id, sheet_id, name, type, "order", property) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [DECOY_FIELD_ID, sheet, 'decoy', 'text', columns.length, '{}'])
    for (const [index, line] of LINES.entries()) {
      await owner.query('INSERT INTO public.meta_records (id, sheet_id, data) VALUES ($1, $2, $3::jsonb)', [rec(index), sheet, JSON.stringify({
        [fld('project')]: 'DEMO-P1', [fld('line')]: line, [fld('qty')]: 6, [fld('description')]: 'synthetic approval part',
        [fld('note')]: 'synthetic note', [fld('status')]: 'open' })])
    }
    // The sheet's version row exists before any holder (as it does after the registering grants in production): a
    // writer's bump is then an UPDATE the holder's FOR SHARE blocks.
    await owner.query('INSERT INTO public.sheet_permission_versions (sheet_id) VALUES ($1) ON CONFLICT (sheet_id) DO NOTHING', [ids().sheet])
  }
  async function cleanPublicSheet() {
    const prefix = `${schema}%`
    await owner.query('DELETE FROM public.platform_member_group_members WHERE user_id = $1', [context().ownerId])
    await owner.query('DELETE FROM public.platform_member_groups WHERE name LIKE $1', [prefix])
    await owner.query('DELETE FROM public.users WHERE id = $1', [context().ownerId])
    await owner.query('DELETE FROM public.record_permissions WHERE sheet_id LIKE $1', [prefix])
    await owner.query('DELETE FROM public.field_permissions WHERE sheet_id LIKE $1', [prefix])
    await owner.query('DELETE FROM public.meta_sheets WHERE id LIKE $1', [prefix]) // cascades the fields, the records and the sheet grants
    await owner.query('DELETE FROM public.sheet_permission_versions WHERE sheet_id LIKE $1', [prefix])
  }
  function boundInput(value: Input = input(), records?: Array<{ recordId: string; keyValue: string; projectNo: string }>): Input & { sourceBinding: Row } {
    const rows = JSON.parse(value.rowsText) as Row[], { sheet, rec, fld } = ids()
    const fieldBindings = Object.fromEntries(value.config.fieldMap.map(field => [String(field.source), fld(String(field.target))]))
    return { ...value, sourceBinding: { sheetId: sheet, keyFieldId: fieldBindings.lineId, fieldBindings,
      records: records ?? rows.map((row, index) => ({ recordId: rec(index), keyValue: String(row.lineId), projectNo: String(row.projectNo) })) } }
  }
  // A bound draft of public record `index` (its own key LINE-n, so its creation identity is its own).
  function boundRow(index: number, quantity = 6): Input & { sourceBinding: Row } {
    const value = input('original', quantity), rows = JSON.parse(value.rowsText) as Row[]
    rows[0].lineId = LINES[index]; value.rowsText = JSON.stringify(rows)
    return boundInput(value, [{ recordId: ids().rec(index), keyValue: LINES[index], projectNo: 'DEMO-P1' }])
  }
  async function registerProject(patch: Row = {}) {
    await owner.query(`INSERT INTO ${ident(REGISTRY)} (id, tenant_id, project_no, sheet_id, object_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), patch.tenant_id ?? context().tenantId, patch.project_no ?? 'DEMO-P1', patch.sheet_id ?? ids().sheet,
        patch.object_id ?? 'synthetic-object', patch.status ?? 'active'])
  }
  async function acknowledge(f: Fixture, admitted: MutationMetadata) {
    // Store-level claim and synthetic receipt: the row reaches acknowledged without any transport.
    const store = first.ledger as LedgerStore & { claim(input: unknown): Promise<{ claimToken: string }>; recordAcknowledgement(input: unknown): Promise<Row> }
    const scope = { ...context(), operationId: f.draft.operationId, rowKey: f.request.rowKey, actorId: context().ownerId }
    const { claimToken } = await store.claim(scope)
    await store.recordAcknowledgement({ ...scope, claimToken, ack: { statusCode: 201, instanceId: 'synthetic-instance' } })
    expect(String((await tableRows(LEDGER)).find(row => row.id === admitted.ledgerId)!.status)).toBe('acknowledged')
  }

  it('bound draft: approval and admission carry both digests into the grant and the ledger; the registry must name the bound sheet', async () => {
    await registerProject()
    const f = await fixture(boundInput())
    const members = (await tableRows(MEMBERS)).filter(row => row.operation_id === f.draft.operationId).sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    expect(members.every(row => /^[0-9a-f]{64}$/.test(String(row.source_record_digest)) && /^[0-9a-f]{64}$/.test(String(row.creation_identity_digest)))).toBe(true)
    const granted = await first.service.approve(f.request)
    const grantRow = (await tableRows(APPROVAL))[0]
    expect([grantRow.source_record_digest, grantRow.creation_identity_digest]).toEqual([members[0].source_record_digest, members[0].creation_identity_digest])
    const sealed = JSON.parse(await security.decrypt(String(grantRow.snapshot_encrypted))) as Row
    const selection = sealed.selection as Row
    expect([selection.sourceRecordDigest, selection.creationIdentityDigest]).toEqual([members[0].source_record_digest, members[0].creation_identity_digest])
    expect((selection.sourceBinding as Row).sheetId === ids().sheet && (selection.sourceBinding as Row).recordId === ids().rec(0)
      && (selection.sourceBinding as Row).keyValue === 'LINE-1' && (selection.sourceBinding as Row).projectNo === 'DEMO-P1').toBe(true)
    const admitted = await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    const ledger = (await tableRows(LEDGER))[0]
    expect(ledger.id === admitted.ledgerId && ledger.source_record_digest === members[0].source_record_digest
      && ledger.creation_identity_digest === members[0].creation_identity_digest).toBe(true)
    expect(first.statements.some(sql => sql.includes(REGISTRY))).toBe(true)
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
    // The registry is read inside the approval AND the admission transaction (D21 check 1, held FOR SHARE): archived between
    // the two, the admission is CONFLICT and nothing is written; archived before an approval, that approval is CONFLICT as
    // well — both from the host re-authorization, ahead of the plugin primitive's own registry read (masked as UNAVAILABLE).
    const other = await second.draft.createDraft(boundRow(1, 7))
    const grant2 = await second.service.approve({ operationId: other.operationId, rowKey: other.rows[0].rowKey, confirmationId: 'synthetic-archived-confirmation' })
    await owner.query(`UPDATE ${ident(REGISTRY)} SET status = 'archived', archived_at = NOW()`)
    const before = await evidence()
    await rejected(second.service.admit({ grantId: grant2.grantId, submissionId: 'synthetic-archived-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    const third = await second.draft.createDraft(boundRow(2, 7))
    await rejected(second.service.approve({ operationId: third.operationId, rowKey: third.rows[0].rowKey, confirmationId: 'synthetic-archived-approval' }), 'CONFLICT')
    expect(await evidence()).toEqual(before)
  })
  // A FORMAL target: another owner-attested target (slot 2) with its own app/form locator, registered through the Y2 writer.
  function formalInput(value: Input = input('original', 8)): Input {
    return { ...value, config: { ...value.config, target: { appType: 'synthetic_formal_app', formUuid: 'synthetic_formal_form' } } }
  }
  async function addFormalTarget(draftInput: Input) {
    const draft = await first.draft.createDraft(draftInput), secret = await first.material.create({ material: material() })
    const writer = createAdditionalWriter({ security, context: context() })
    const slot2 = await (first.db as { transaction<T>(callback: (trx: { setTransactionIsolationLevel(level: string): Promise<void> }) => Promise<T>): Promise<T> })
      .transaction(async trx => {
        await trx.setTransactionIsolationLevel('read committed')
        return writer(trx, { operationId: draft.operationId, credentialRef: secret.credentialRef,
          credentialGeneration: secret.credentialGeneration, attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review',
            organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' } })
      })
    expect(slot2.slot).toBe(2)
    return { draft, slot2 }
  }

  it('CF2 (early rejection): a re-created record with the same key and project and a changed name is refused at approval with IDENTITY_RESERVED; the ACKed row, its audit and the form stay untouched', async () => {
    await registerProject()
    const f = await fixture(boundInput())
    const granted = await first.service.approve(f.request)
    const admitted = await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    await acknowledge(f, admitted)
    const before = await evidence()
    // R deleted, re-created as R′ (new record id) with the description corrected: same key value, same project.
    const corrected = input(); const rows = JSON.parse(corrected.rowsText) as Row[]
    rows[0].description = 'synthetic corrected approval part'; corrected.rowsText = JSON.stringify(rows)
    const recreated = await second.draft.createDraft(boundInput(corrected, [{ recordId: ids().rec(1), keyValue: 'LINE-1', projectNo: 'DEMO-P1' }]))
    expect(recreated.operationId).not.toBe(f.draft.operationId)
    const members = await tableRows(MEMBERS)
    const original = members.find(row => row.operation_id === f.draft.operationId)!, moved = members.find(row => row.operation_id === recreated.operationId)!
    expect(moved.creation_identity_digest === original.creation_identity_digest && moved.source_record_digest !== original.source_record_digest).toBe(true)
    // The seven keys did NOT change here (description is not a key); the identity fence answers before the seven-key fence could.
    await rejected(second.service.approve({ operationId: recreated.operationId, rowKey: recreated.rows[0].rowKey, confirmationId: 'synthetic-recreated-confirmation' }), 'IDENTITY_RESERVED')
    // Same record re-created on another registered sheet (registration moved): refused the same way.
    await owner.query(`UPDATE ${ident(REGISTRY)} SET sheet_id = 'sheet_moved'`)
    const movedSheet = await second.draft.createDraft({ ...boundInput(corrected, [{ recordId: 'rec_moved', keyValue: 'LINE-1', projectNo: 'DEMO-P1' }]),
      sourceBinding: { ...boundInput(corrected).sourceBinding, sheetId: 'sheet_moved', records: [{ recordId: 'rec_moved', keyValue: 'LINE-1', projectNo: 'DEMO-P1' }] } })
    await rejected(second.service.approve({ operationId: movedSheet.operationId, rowKey: movedSheet.rows[0].rowKey, confirmationId: 'synthetic-moved-confirmation' }), 'IDENTITY_RESERVED')
    expect(await evidence()).toEqual(before)
    expect(before.counts).toEqual([1, 0, 1, 2, 1, 3])
  })

  it('CF2 (index): a grant approved before the first row was admitted hits the identity fence at its own admission; one ledger row, no second attempt', async () => {
    await registerProject()
    const f = await fixture(boundInput())
    // R′: approved while X is only approved (the ledger is still empty, so the early check cannot see anything). Its
    // parent code is corrected as well: a NEW seven-key digest, so the seven-key fence cannot answer for it and only
    // the identity index can (the identity is the key value and the project, which are unchanged).
    const corrected = input('original', 9); const rows = JSON.parse(corrected.rowsText) as Row[]
    rows[0].description = 'synthetic corrected approval part'; rows[0].parentCode = 'PARENT-RECREATED'; corrected.rowsText = JSON.stringify(rows)
    const recreated = await second.draft.createDraft(boundInput(corrected, [{ recordId: ids().rec(1), keyValue: 'LINE-1', projectNo: 'DEMO-P1' }]))
    const members = await tableRows(MEMBERS)
    const original = members.find(row => row.operation_id === f.draft.operationId)!, moved = members.find(row => row.operation_id === recreated.operationId)!
    expect(moved.creation_identity_digest === original.creation_identity_digest && moved.business_key_digest !== original.business_key_digest).toBe(true)
    const laterGrant = await second.service.approve({ operationId: recreated.operationId, rowKey: recreated.rows[0].rowKey, confirmationId: 'synthetic-recreated-confirmation' })
    const granted = await first.service.approve(f.request)
    const admitted = await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    await acknowledge(f, admitted)
    const before = await evidence()
    // The index decides: the admission of R′ rolls back (closed by the private port), the grant stays approved with its attempt.
    await rejected(second.service.admit({ grantId: laterGrant.grantId, submissionId: 'synthetic-recreated-submission' }))
    expect(await evidence()).toEqual(before)
    const view = await second.service.inspect({ grantId: laterGrant.grantId })
    expect([view.status, view.remainingAttempts, view.ledgerId]).toEqual(['approved', 1, null])
    expect(before.counts).toEqual([2, 0, 1, 3, 1, 3])
  })

  it('RA3 / D20: a formal target refuses an unbound draft at approval and at admission; slot 1 and an exact-listed test target still take it', async () => {
    await owner.query(multiTargetUp)
    const f = await fixture()
    // Slot 2: a second owner-attested target (the formal form), registered through the Y2 writer; its pasted draft is unbound.
    const { draft, slot2 } = await addFormalTarget(formalInput())
    const multi = await session(context(), { multiTarget: true })
    const before = await evidence()
    // The pasted (unbound) draft of slot 2: approval refused, no grant row.
    await rejected(multi.service.approve({ operationId: draft.operationId, rowKey: draft.rows[0].rowKey,
      confirmationId: 'synthetic-slot2-confirmation', targetRef: slot2.targetRef }), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    // The same unbound draft of slot 1 (the material TEST copy) is approved as before.
    const onTest = await multi.service.approve({ ...f.request, targetRef: f.targetRef })
    expect(onTest.status).toBe('approved')
    // A target listed in INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS takes the unbound row.
    const listed = await session(context(), { multiTarget: true, unboundTestTargetRefs: new Set([slot2.targetRef]) })
    const onListed = await listed.service.approve({ operationId: draft.operationId, rowKey: draft.rows[0].rowKey,
      confirmationId: 'synthetic-slot2-confirmation', targetRef: slot2.targetRef })
    expect([onListed.status, onListed.targetRef]).toEqual(['approved', slot2.targetRef])
    // The list is read per run: a run without the listing refuses the admission of that grant, nothing written.
    const grants = await evidence()
    await rejected(multi.service.admit({ grantId: onListed.grantId, submissionId: 'synthetic-slot2-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(grants)
    expect(grants.counts).toEqual([2, 0, 0, 2, 0, 0])
    const admitted = await listed.service.admit({ grantId: onListed.grantId, submissionId: 'synthetic-slot2-submission' })
    expect(admitted.status).toBe('admitted')
    expect((await tableRows(LEDGER)).map(row => [row.source_record_digest, row.creation_identity_digest])).toEqual([[null, null]])
  })

  it('D20 is not a binding bypass: a bound draft on a formal target still needs the registry and the fence covers it', async () => {
    await owner.query(multiTargetUp)
    await registerProject()
    const f = await fixture()
    const { draft, slot2 } = await addFormalTarget(boundInput(formalInput()))
    const multi = await session(context(), { multiTarget: true })
    const granted = await multi.service.approve({ operationId: draft.operationId, rowKey: draft.rows[0].rowKey,
      confirmationId: 'synthetic-slot2-confirmation', targetRef: slot2.targetRef })
    const admitted = await multi.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-slot2-submission' })
    const ledger = (await tableRows(LEDGER)).find(row => row.id === admitted.ledgerId)!
    expect(/^[0-9a-f]{64}$/.test(String(ledger.creation_identity_digest)) && ledger.target_ref === slot2.targetRef).toBe(true)
    // The same identity again on this target (another record): IDENTITY_RESERVED at approval.
    const again = await second.draft.createDraft(boundInput(formalInput(input('original', 9)), [{ recordId: ids().rec(1), keyValue: 'LINE-1', projectNo: 'DEMO-P1' }]))
    const before = await evidence()
    await rejected(multi.service.approve({ operationId: again.operationId, rowKey: again.rows[0].rowKey,
      confirmationId: 'synthetic-again-confirmation', targetRef: slot2.targetRef }), 'IDENTITY_RESERVED')
    expect(await evidence()).toEqual(before)
    // The fence is per target: the same identity (same key value and project) bound on slot 1 is free there. The early
    // look-up must scope by target_ref, or this would be a false IDENTITY_RESERVED across targets; the index then takes
    // the second row because its target differs.
    const onTest = await second.draft.createDraft(boundInput())
    const slot1 = await multi.service.approve({ operationId: onTest.operationId, rowKey: onTest.rows[0].rowKey,
      confirmationId: 'synthetic-slot1-confirmation', targetRef: f.targetRef })
    expect([slot1.status, slot1.targetRef]).toEqual(['approved', f.targetRef])
    const admittedOnTest = await multi.service.admit({ grantId: slot1.grantId, submissionId: 'synthetic-slot1-submission' })
    expect(admittedOnTest.status).toBe('admitted')
    const ledgerRows = await tableRows(LEDGER)
    expect(ledgerRows.map(row => row.creation_identity_digest)).toEqual([ledger.creation_identity_digest, ledger.creation_identity_digest])
    expect(new Set(ledgerRows.map(row => row.target_ref))).toEqual(new Set([slot2.targetRef, f.targetRef]))
  })

  // ---- D21 in-transaction re-authorization (design baseline v2.3 §7.2 「进授权」 and 「分界是准入提交」; slice Y5) ----
  // The service's own transaction re-runs the four source checks on its own `trx` from the rows the protocol locked
  // there (never a request or the RBAC cache). No send port exists in this file: a refused approval or admission means
  // zero form requests by construction (the port is built only after an admission committed).
  const SUBJECT_ENSURE = /^INSERT INTO subject_authorization_versions \(subject_id\)/
  const SUBJECT_SHARE = /^SELECT subject_id, version::text AS version FROM subject_authorization_versions WHERE subject_id = \$1 FOR SHARE$/
  const USERS_SHARE = /FROM users\s+WHERE id = \$1 FOR SHARE/
  const REGISTRY_SHARE = /FROM integration_stock_prep_project_target WHERE tenant_id = \$1 AND project_no = \$2 FOR SHARE$/
  const SHEET_SHARE = /FROM sheet_permission_versions WHERE sheet_id = \$1 FOR SHARE$/
  const RECORD_SHARE = /FROM meta_records\s+WHERE id = \$1 AND sheet_id = ANY\(\$2::text\[\]\) FOR SHARE/
  const GRANT_INSERT = /^INSERT INTO integration_yida_send_approvals/, LEDGER_INSERT = /^INSERT INTO "?integration_yida_delivery_ledger"?/i
  const indexOf = (statements: string[], pattern: RegExp) => statements.findIndex(sql => pattern.test(sql))
  const ascending = (statements: string[], patterns: RegExp[]) => {
    const at = patterns.map(pattern => indexOf(statements, pattern))
    return at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1])) ? at : at
  }
  async function boundFixture() { await registerProject(); return fixture(boundInput()) }
  async function draftOf(session: Session, value: Input, confirmationId: string) {
    const draft = await session.draft.createDraft(value)
    return { operationId: draft.operationId, rowKey: draft.rows[0].rowKey, confirmationId }
  }
  const sql = {
    revokeRead: () => owner.query("DELETE FROM role_permissions WHERE role_id = 'integration_admin' AND permission_code = 'multitable:read'"),
    restoreRead: () => owner.query("INSERT INTO role_permissions VALUES ('integration_admin','multitable:read')"),
    hide: (fieldId: string) => owner.query(`UPDATE public.meta_fields SET property = property || '{"hidden": true}'::jsonb WHERE id = $1`, [fieldId]),
    unhide: (fieldId: string) => owner.query("UPDATE public.meta_fields SET property = property - 'hidden' WHERE id = $1", [fieldId]),
    denyRecord: (recordId: string) => owner.query("INSERT INTO public.record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1, $2, 'user', $3, 'none')", [ids().sheet, recordId, context().ownerId]),
    clearRecordDenies: () => owner.query('DELETE FROM public.record_permissions WHERE sheet_id = $1', [ids().sheet]),
  }

  it('D21 lock order: approve and admit hold the actor\'s subject version row BEFORE the live-authority rows, then — inside the same transaction — the registry FOR SHARE, the sheet version row and the bound record, all before the first write; inspect never does', async () => {
    const f = await boundFixture()
    first.statements.length = 0
    const granted = await first.service.approve(f.request)
    const approve = [...first.statements]
    expect([approve[0], approve[1], indexOf(approve, SUBJECT_ENSURE), indexOf(approve, SUBJECT_SHARE)]).toEqual(['BEGIN', PIN, 2, 3])
    const approveChain = ascending(approve, [SUBJECT_SHARE, USERS_SHARE, REGISTRY_SHARE, SHEET_SHARE, RECORD_SHARE, GRANT_INSERT])
    expect(approveChain.every((index, i) => index >= 0 && (i === 0 || index > approveChain[i - 1]))).toBe(true)
    expect(approve.filter(statement => statement === 'COMMIT')).toHaveLength(1)
    first.statements.length = 0
    const admitted = await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    expect(admitted.status).toBe('admitted')
    const admit = [...first.statements]
    expect([admit[0], admit[1], indexOf(admit, SUBJECT_ENSURE), indexOf(admit, SUBJECT_SHARE)]).toEqual(['BEGIN', PIN, 2, 3])
    const admitChain = ascending(admit, [SUBJECT_SHARE, USERS_SHARE, REGISTRY_SHARE, SHEET_SHARE, RECORD_SHARE, LEDGER_INSERT])
    expect(admitChain.every((index, i) => index >= 0 && (i === 0 || index > admitChain[i - 1]))).toBe(true)
    // inspect / observe never re-authorize and never take a protocol row.
    first.statements.length = 0
    await first.service.inspect({ grantId: granted.grantId })
    expect(first.statements.some(statement => statement.includes('authorization_versions') || REGISTRY_SHARE.test(statement) || RECORD_SHARE.test(statement))).toBe(false)
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
  })

  it('fail closed: a service without the host re-authorization refuses every bound row (UNAVAILABLE, nothing written) and still takes an unbound one', async () => {
    const f = await boundFixture()
    const bare = await session(context(), { withoutReauthorization: true })
    const before = await evidence()
    await rejected(bare.service.approve(f.request))
    expect(await evidence()).toEqual(before)
    const pasted = await draftOf(bare, input('original', 7), 'synthetic-pasted-confirmation')
    expect((await bare.service.approve(pasted)).status).toBe('approved')
  })

  it('RA1: table permissions unchanged, only a record-level read deny on the bound record — before approval the approval is CONFLICT with no grant row; before admission the admission is CONFLICT with no admission and no ledger row; lifted, the same grant is admitted', async () => {
    const f = await boundFixture()
    await sql.denyRecord(ids().rec(0))
    const before = await evidence()
    await rejected(first.service.approve(f.request), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    expect(before.counts).toEqual([0, 0, 0, 0, 0, 0])
    await sql.clearRecordDenies()
    const granted = await first.service.approve(f.request)
    await sql.denyRecord(ids().rec(0))
    const approved = await evidence()
    await rejected(first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(approved)
    expect(approved.counts).toEqual([1, 0, 0, 1, 0, 0])
    // The grant keeps its single attempt (nothing consumed, nothing revoked): the deny lifted, it is admitted.
    await sql.clearRecordDenies()
    expect((await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })).status).toBe('admitted')
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
  })

  it('RA2 and RA2 (i): table and record permissions unchanged, one source column hidden — by field visibility before approval and by a per-subject field permission before admission — refuses; the alias differs from the field id and hiding the visible decoy field that carries the alias changes nothing', async () => {
    const f = await boundFixture(), real = ids().fld('description')
    await sql.hide(real)
    const before = await evidence()
    await rejected(first.service.approve(f.request), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    await sql.unhide(real)
    const granted = await first.service.approve(f.request)
    await owner.query("INSERT INTO public.field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1, $2, 'user', $3, FALSE, FALSE)",
      [ids().sheet, real, context().ownerId])
    const approved = await evidence()
    await rejected(first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(approved)
    expect(approved.counts).toEqual([1, 0, 0, 1, 0, 0])
    // (i) by field id, never by alias: the decoy field named `description` is hidden, the real column is visible again.
    await owner.query('DELETE FROM public.field_permissions WHERE sheet_id = $1', [ids().sheet])
    await sql.hide(DECOY_FIELD_ID)
    expect((await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })).status).toBe('admitted')
  })

  // RA2 (ii): a v3 config whose `label` target is a concat of the key column and `partNote`, a column NO target maps directly.
  function v3BoundRow(index: number, quantity = 6): Input & { sourceBinding: Row } {
    const { sheet, rec, fld } = ids()
    const value: Input = {
      config: { version: 3, kind: 'yida-form-protocol-static', intent: 'create',
        target: { appType: 'synthetic_approval_app', formUuid: 'synthetic_approval_form' },
        // The SAME key definition as the v2 fixture's (project, line, parent; parent may be empty), named by primary
        // target as v3 does: one target keeps one key definition (the draft store refuses another).
        businessKey: ['project', 'line', 'parent'], emptyKeyFields: ['parent'],
        fieldCatalog: [{ id: 'project', control: 'text', required: true }, { id: 'line', control: 'text', required: true },
          { id: 'parent', control: 'text', required: false }, { id: 'qty', control: 'number', required: true },
          { id: 'label', control: 'text', required: false }],
        fieldMap: [{ transform: 'direct', source: 'projectNo', target: 'project', type: 'string', required: true },
          { transform: 'direct', source: 'lineId', target: 'line', type: 'string', required: true },
          { transform: 'direct', source: 'parentCode', target: 'parent', type: 'string', required: false },
          { transform: 'direct', source: 'quantity', target: 'qty', type: 'number', required: true },
          { transform: 'concat', parts: [{ source: 'lineId' }, { literal: '/' }, { source: 'partNote' }], separator: '', blank: 'skip',
            target: 'label', type: 'string', required: false }] },
      rowsText: JSON.stringify([{ projectNo: 'DEMO-P1', lineId: LINES[index], parentCode: null, quantity, partNote: 'synthetic note' }]),
      allocation: { mode: 'original' },
    }
    const fieldBindings = { projectNo: fld('project'), lineId: fld('line'), parentCode: fld('parent'), quantity: fld('qty'), partNote: fld('note') }
    return { ...value, sourceBinding: { sheetId: sheet, keyFieldId: fld('line'), fieldBindings,
      records: [{ recordId: rec(index), keyValue: LINES[index], projectNo: 'DEMO-P1' }] } }
  }

  it('RA2 (ii): a column that is only a concat dependency (never directly mapped) hidden before approval and before admission refuses; visible again, the row is approved and admitted', async () => {
    await boundFixture()
    const note = ids().fld('note')
    const members = (await tableRows(MEMBERS)).length
    const request = await draftOf(first, v3BoundRow(1), 'synthetic-v3-confirmation')
    const row = (await tableRows(MEMBERS)).find(member => member.operation_id === request.operationId)!
    expect((await tableRows(MEMBERS)).length).toBe(members + 1)
    expect(/^[0-9a-f]{64}$/.test(String(row.source_record_digest))).toBe(true)
    await sql.hide(note)
    const before = await evidence()
    await rejected(first.service.approve(request), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    await sql.unhide(note)
    const granted = await first.service.approve(request)
    // The sealed binding names `…_fld_note` ONLY as the concat target's dependency: no target maps it directly.
    const grantRow = (await tableRows(APPROVAL)).find(grant => grant.grant_id === granted.grantId)!
    const sealed = (JSON.parse(await security.decrypt(String(grantRow.snapshot_encrypted))) as Row).selection as Row
    const dependencies = (sealed.sourceBinding as Row).fieldDependencies as Record<string, string[]>
    expect(Object.entries(dependencies).filter(([, fieldIds]) => fieldIds.includes(note)).map(([target]) => target)).toEqual(['label'])
    expect(Object.values((sealed.sourceBinding as Row).fieldBindings as Record<string, string>).includes(note)).toBe(true)
    await sql.hide(note)
    const approved = await evidence()
    await rejected(first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-v3-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(approved)
    await sql.unhide(note)
    expect((await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-v3-submission' })).status).toBe('admitted')
  })

  // RA4 harness. Forward: connection 1 (`first`) admits, runs its four checks and parks on the barrier — the ledger INSERT,
  // its first write, after every check and before COMMIT; connection 2 (`second.client`, READ COMMITTED) issues the
  // revocation and must stay blocked until connection 1 commits ("admission in front, revocation after"); the committed
  // revocation then refuses the next bound approval of another record of the sheet. Reverse: the revocation commits
  // FIRST (connection 1 parked before its first protocol lock), connection 1 is released, runs its checks and refuses.
  type Ra4Case = { arm?: () => Promise<void>; revoke: (writer: PoolClient) => Promise<unknown>; undo: () => Promise<void> }
  async function ra4(spec: Ra4Case) {
    await registerProject()
    await spec.arm?.()
    const f = await fixture(boundInput())
    const granted = await first.service.approve(f.request)
    const gate = first.gateInsert(LEDGER)
    const admission = first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })
    admission.catch(() => {})
    await reached(gate)
    const writer = second.client
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    let settled = false
    const write = spec.revoke(writer).then(() => { settled = true })
    write.catch(() => {})
    await blocked(second, first)
    expect(settled).toBe(false)
    first.release()
    const admitted = await admission
    expect(admitted.status).toBe('admitted')
    await write
    expect(settled).toBe(true)
    await writer.query('COMMIT')
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
    // The committed revocation is effective: the next bound approval on this sheet is refused, nothing written.
    const next = await draftOf(first, boundRow(1, 7), 'synthetic-next-confirmation')
    const afterRevoke = await evidence()
    await rejected(first.service.approve(next), 'CONFLICT')
    expect(await evidence()).toEqual(afterRevoke)
    // Reverse direction.
    await spec.undo()
    const again = await draftOf(first, boundRow(2, 8), 'synthetic-reverse-confirmation')
    const grant2 = await first.service.approve(again)
    const early = first.gateInsert('subject_authorization_versions')
    const admission2 = first.service.admit({ grantId: grant2.grantId, submissionId: 'synthetic-reverse-submission' })
    admission2.catch(() => {})
    await reached(early)
    await spec.revoke(writer) // autocommit: committed before connection 1 takes its first lock
    const before = await evidence()
    first.release()
    await rejected(admission2, 'CONFLICT')
    expect(await evidence()).toEqual(before)
    expect(before.counts).toEqual([2, 0, 1, 3, 1, 1])
  }

  it('RA4 ①: deleting a role permission (positive authority) blocks until the parked admission commits; committed first, the admission is refused', async () => {
    await ra4({
      revoke: writer => writer.query("DELETE FROM role_permissions WHERE role_id = 'integration_admin' AND permission_code = 'multitable:read'"),
      undo: async () => { await sql.restoreRead() },
    })
  })

  it('RA4 ②: inserting a record-level read deny (negative, a new row) blocks on the sheet version row until the parked admission commits; committed first, the admission is refused', async () => {
    const { sheet, rec } = ids()
    await ra4({
      revoke: writer => writer.query(`INSERT INTO public.record_permissions (sheet_id, record_id, subject_type, subject_id, access_level)
        SELECT $1, unnest($2::text[]), 'user', $3, 'none'`, [sheet, [rec(0), rec(1), rec(2)], context().ownerId]),
      undo: async () => { await sql.clearRecordDenies() },
    })
  })

  it('RA4 ③: hiding a dependency field (configuration) blocks on the sheet version row until the parked admission commits; committed first, the admission is refused', async () => {
    const real = ids().fld('description')
    await ra4({
      revoke: writer => writer.query(`UPDATE public.meta_fields SET property = property || '{"hidden": true}'::jsonb WHERE id = $1`, [real]),
      undo: async () => { await sql.unhide(real) },
    })
  })

  it('RA4 ④: joining a member group that carries a read deny (membership) blocks on the SUBJECT version row until the parked admission commits; committed first, the admission is refused', async () => {
    const { sheet, rec } = ids()
    let groupId = ''
    await ra4({
      arm: async () => {
        // The member-group FK points at public.users: the owner exists there for this case only (removed by afterEach).
        await owner.query(`INSERT INTO public.users (id, email, password_hash, role, is_active, activation_status, is_admin, permissions)
          VALUES ($1, $1 || '@synthetic.invalid', 'x', 'user', TRUE, 'activated', FALSE, '[]'::jsonb)`, [context().ownerId])
        groupId = String((await owner.query('INSERT INTO public.platform_member_groups (name) VALUES ($1) RETURNING id::text AS id', [`${schema}_deny_group`])).rows[0].id)
        await owner.query(`INSERT INTO public.record_permissions (sheet_id, record_id, subject_type, subject_id, access_level)
          SELECT $1, unnest($2::text[]), 'member-group', $3, 'none'`, [sheet, [rec(0), rec(1), rec(2)], groupId])
      },
      revoke: writer => writer.query('INSERT INTO public.platform_member_group_members (group_id, user_id, created_at) VALUES ($1::uuid, $2, now())', [groupId, context().ownerId]),
      undo: async () => { await owner.query('DELETE FROM public.platform_member_group_members WHERE group_id = $1::uuid', [groupId]) },
    })
  })

  it('RA4 ⑤: changing the bound record so a conditional read rule denies it (record value) blocks on the record FOR SHARE until the parked admission commits; committed first, the admission is refused', async () => {
    const { sheet, fld } = ids(), status = fld('status')
    await ra4({
      arm: () => owner.query('UPDATE public.meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1',
        // A complete rule (the parser rejects one without an id, which would leave the sheet rule-free), active only
        // because row-level read permissions are enabled on the seeded sheet.
        [sheet, JSON.stringify([{ id: 'synthetic-secret-rule', fieldId: status, operator: 'eq', value: 'secret', effect: 'deny_read' }])]).then(() => undefined),
      revoke: writer => writer.query("UPDATE public.meta_records SET data = data || jsonb_build_object($2::text, 'secret'::text) WHERE sheet_id = $1", [sheet, status]),
      undo: async () => { await owner.query("UPDATE public.meta_records SET data = data || jsonb_build_object($2::text, 'open'::text) WHERE sheet_id = $1", [sheet, status]) },
    })
  })

  // RA4 lock order (closes Y5a B-05 at the service level). One bound admission parked on `gate`; one access-graph writer
  // on connection 2 — lockUsersForAccessGraphWrite: the subject version row bump FIRST, then users FOR UPDATE. The writer
  // must block until the admission commits and lock only after it ("admission first, writer after"), with no deadlock.
  // Where the holder was parked is asserted LAST, so a broken lock order shows up as the behaviour (not blocked, or a
  // deadlock), never only as a statement-shape pin.
  async function accessGraphWriterWaits(grantId: string, gate: Gate, parkedAt: (statements: string[]) => void) {
    const writer = second.client
    const admission = first.service.admit({ grantId, submissionId: 'synthetic-lock-order-submission' })
    admission.catch(() => {})
    await reached(gate)
    const parked = [...first.statements]
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const order: string[] = []
    const writerRun = (async () => {
      const locked = await lockUsers(writer, [context().ownerId])
      order.push('writer:locked')
      expect(locked.get(context().ownerId)?.id).toBe(context().ownerId)
      await writer.query('UPDATE users SET permissions = $2::jsonb WHERE id = $1', [context().ownerId, '[]'])
      await writer.query('COMMIT')
      order.push('writer:committed')
    })()
    writerRun.catch(() => {})
    await blocked(second, first)
    expect(order).toEqual([])
    order.push('holder:released'); first.release()
    const admitted = await admission
    order.push('holder:admitted')
    await writerRun
    expect(admitted.status).toBe('admitted')
    expect(order).toEqual(['holder:released', 'holder:admitted', 'writer:locked', 'writer:committed'])
    expect((await evidence()).counts).toEqual([1, 0, 1, 2, 1, 1])
    parkedAt(parked)
  }
  async function lockOrderGrant() {
    // The writer reads the profile columns the mutex returns; the private users fixture carries only the live-ACL ones.
    await owner.query('ALTER TABLE users ADD COLUMN name text, ADD COLUMN email text, ADD COLUMN username text, ADD COLUMN mobile text, ADD COLUMN access_generation bigint NOT NULL DEFAULT 0')
    const f = await boundFixture()
    const granted = await first.service.approve(f.request)
    first.statements.length = 0
    return granted.grantId
  }

  it('RA4 lock order (A): an access-graph writer is serialized behind a bound admission parked after its subject version row and before its users row (a writer taking users first would deadlock here)', async () => {
    // The first `FROM user_roles` is the live-actor check's first locking read: the subject row is held, users is not.
    await accessGraphWriterWaits(await lockOrderGrant(), first.gateMatch(/FROM user_roles/), statements => {
      expect(/FROM user_roles/.test(statements[statements.length - 1])).toBe(true)
      expect([indexOf(statements, SUBJECT_SHARE) >= 0, indexOf(statements, USERS_SHARE)]).toEqual([true, -1])
    })
  })

  it('RA4 lock order (C, the Y5a B-05 point): an access-graph writer is serialized behind a bound admission parked after its users row and before its sheet row and helper (without the phase-1 subject lock this is the users-vs-subject deadlock)', async () => {
    // The re-authorization's registry read: users and the rest of the live-actor rows are held, the sheet row and the
    // helper are not. Holder users → subject against writer subject → users is the B-05 cycle; the phase-1 subject row
    // the holder took first makes the writer's bump wait instead.
    await accessGraphWriterWaits(await lockOrderGrant(), first.gateMatch(REGISTRY_SHARE), statements => {
      expect(REGISTRY_SHARE.test(statements[statements.length - 1])).toBe(true)
      expect([indexOf(statements, SUBJECT_SHARE) >= 0, indexOf(statements, USERS_SHARE) > indexOf(statements, SUBJECT_SHARE),
        indexOf(statements, SHEET_SHARE)]).toEqual([true, true, -1])
    })
  })

  it('RA5: a session whose triggers do not fire (session_replication_role = replica) is refused at approval and at admission as UNAVAILABLE with nothing written; back in origin the same grant is admitted', async () => {
    const superuser = await owner.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
    expect(superuser.rows[0]?.rolsuper, 'session_replication_role is a superuser setting; the CI database user is one').toBe(true)
    const f = await boundFixture()
    await first.client.query("SET session_replication_role = 'replica'")
    try {
      const before = await evidence()
      await rejected(first.service.approve(f.request))
      expect(await evidence()).toEqual(before)
      await first.client.query("SET session_replication_role = 'origin'")
      const granted = await first.service.approve(f.request)
      await first.client.query("SET session_replication_role = 'replica'")
      const approved = await evidence()
      await rejected(first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' }))
      expect(await evidence()).toEqual(approved)
      expect(approved.counts).toEqual([1, 0, 0, 1, 0, 0])
      await first.client.query("SET session_replication_role = 'origin'")
      expect((await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })).status).toBe('admitted')
    } finally { await first.client.query("SET session_replication_role = 'origin'") }
  })

  it('SR4 (the approval and admission time points): the owner\'s export authority on the bound sheet revoked before approval refuses the approval (no grant row); revoked before admission refuses the admission (no admission, no ledger row); restored, the grant is admitted', async () => {
    const f = await boundFixture()
    await sql.revokeRead()
    const before = await evidence()
    await rejected(first.service.approve(f.request), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    await sql.restoreRead()
    const granted = await first.service.approve(f.request)
    await sql.revokeRead()
    const approved = await evidence()
    await rejected(first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(approved)
    expect(approved.counts).toEqual([1, 0, 0, 1, 0, 0])
    await sql.restoreRead()
    expect((await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-submission' })).status).toBe('admitted')
  })

  // RA2 (ii) with the generated transform (R-71 ⑦.4, Y6): the re-check covers generated inputs through transformDependencies.
  // Every generated input is a direct target, so a hidden input is also refused through its direct entry; what this
  // case adds is that the sealed binding names the input under the generated target too (fieldDependencies by target).
  function v3GeneratedRow(index: number): Input & { sourceBinding: Row } {
    const value = v3BoundRow(index)
    const config = value.config as unknown as { fieldCatalog: Row[]; fieldMap: Row[] }
    config.fieldCatalog.push({ id: 'code', control: 'text', required: false })
    config.fieldMap.push({ transform: 'generated', template: [{ literal: 'SYN-' }, { hash: ['project', 'line', 'parent'], form: 'uuid-32' }],
      target: 'code', type: 'string', required: false })
    return value
  }
  it('RA2 (ii) with generated: a generated input hidden before approval and before admission refuses; the sealed binding names it under the generated target', async () => {
    await boundFixture()
    const { fld } = ids(), parent = fld('parent')
    const request = await draftOf(first, v3GeneratedRow(1), 'synthetic-v3g-confirmation')
    const row = (await tableRows(MEMBERS)).find(member => member.operation_id === request.operationId)!
    expect(/^[0-9a-f]{64}$/.test(String(row.source_record_digest))).toBe(true)
    await sql.hide(parent)
    const before = await evidence()
    await rejected(first.service.approve(request), 'CONFLICT')
    expect(await evidence()).toEqual(before)
    await sql.unhide(parent)
    const granted = await first.service.approve(request)
    const grantRow = (await tableRows(APPROVAL)).find(grant => grant.grant_id === granted.grantId)!
    const sealed = (JSON.parse(await security.decrypt(String(grantRow.snapshot_encrypted))) as Row).selection as Row
    const dependencies = (sealed.sourceBinding as Row).fieldDependencies as Record<string, string[]>
    expect(dependencies.code).toEqual([fld('project'), fld('line'), fld('parent')].sort())
    expect(Object.entries(dependencies).filter(([, fieldIds]) => fieldIds.includes(parent)).map(([target]) => target).sort()).toEqual(['code', 'parent'])
    // The selected (projected) row carries the code's inputs and the planned payload carries the code.
    expect(String(((sealed.plan as Row).rows as Row[])[0] && (((sealed.plan as Row).rows as Row[])[0].payload as Row).code)).toMatch(/^SYN-[0-9A-F]{32}$/)
    await sql.hide(parent)
    const approved = await evidence()
    await rejected(first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-v3g-submission' }), 'CONFLICT')
    expect(await evidence()).toEqual(approved)
    await sql.unhide(parent)
    expect((await first.service.admit({ grantId: granted.grantId, submissionId: 'synthetic-v3g-submission' })).status).toBe('admitted')
  })
})
