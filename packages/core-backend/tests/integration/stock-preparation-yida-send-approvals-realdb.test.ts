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
import type { createYidaSendApprovalService, YidaSendAuthorityPrimitives, YidaSendApprovalMetadata } from '../../src/integration/yida-send-approval-service'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('../utils/yida-native-module-import.cjs')
const APPROVAL = 'integration_yida_send_approvals', REVOCATION = 'integration_yida_send_revocations'
const ADMISSION = 'integration_yida_send_admissions', AUDIT = 'integration_yida_send_approval_audit'
const LEDGER = 'integration_yida_delivery_ledger', LEDGER_AUDIT = 'integration_yida_delivery_audit'
const OP = 'integration_yida_draft_operations', MEMBERS = 'integration_yida_draft_rows'
const PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
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
type Session = { client: PoolClient; pid: number; service: Service; draft: DraftStore; material: MaterialStore
  target: TargetStore; ledger: LedgerStore; statements: string[]; gateInsert(table: string): Gate
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
  async function session(scope = context()): Promise<Session> {
    const client = await pool.connect()
    await client.query(`SET search_path TO ${ident(schema)}`)
    await client.query("SET statement_timeout = '10s'")
    await client.query("SET default_transaction_isolation = 'repeatable read'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = []
    let lostCommit = false, gate: (Gate & { table: string; enter(): void; open: Promise<void> }) | undefined
    const query: Queryable['query'] = async (sql, params) => {
      statements.push(sql) // SQL shapes only, never parameter values or driver errors.
      if (gate && new RegExp(`^INSERT INTO "?${gate.table}"?(?:\\s|\\()`, 'i').test(sql.trim())) {
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
    const value: Session = { client, pid, statements,
      service: createService({ database, security, context: { tenantId: scope.tenantId, workspaceId: null, actorId: scope.ownerId },
        primitives: createPrimitives({ security, context: scope }) }),
      draft: createDraft(config), material: createMaterial(config), target: createTarget(config), ledger: createLedger({ db }),
      gateInsert(table) {
        ident(table)
        let enter!: () => void, release!: () => void
        const reached = new Promise<void>(resolve => { enter = resolve }), open = new Promise<void>(resolve => { release = resolve })
        gate = { table, reached, open, enter, release }; return gate
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
    createService = (await importNative(pathToFileURL(path.join(integration, 'yida-send-approval-service.ts')).href)).createYidaSendApprovalService
    assertActor = (await importNative(pathToFileURL(path.join(integration, 'automation-live-authority.ts')).href)).assertAutomationIntegrationActor
    const migrations = path.join(root, 'packages/core-backend/migrations')
    approvalDdl = readFileSync(path.join(migrations, '095_create_integration_yida_send_approvals.sql'), 'utf8')
    ddl = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql'].map(name => readFileSync(path.join(migrations, name), 'utf8')).join('\n') + '\n' + approvalDdl
    savedEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    const { PluginRuntimeSecurityService } = await importNative(pathToFileURL(path.join(root,
      'packages/core-backend/src/security/plugin-runtime-security-service.ts')).href) as { PluginRuntimeSecurityService: new () => HostSecurity }
    security = new PluginRuntimeSecurityService()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 9, connectionTimeoutMillis: 5000 })
    owner = await pool.connect(); await owner.query("SET statement_timeout = '10s'")
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_approval_' + randomUUID().replaceAll('-', '')
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
      INSERT INTO role_permissions VALUES ('foreign_admin','integration:admin'),('foreign_admin','role:admin');
      INSERT INTO user_permissions VALUES ('synthetic-owner','integration:admin'),('synthetic-other-actor','role:admin');
      INSERT INTO user_orgs VALUES ('synthetic-owner','synthetic-tenant',true),('synthetic-owner','synthetic-other-tenant',true),
        ('synthetic-other-actor','synthetic-tenant',true);
      INSERT INTO user_namespace_admissions VALUES ('synthetic-owner','integration',true),('synthetic-other-actor','integration',true);
    `)
    first = await session(); second = await session()
  }, 30000)
  afterEach(async () => {
    for (const active of sessions) active.release()
    for (const active of sessions) { await active.client.query('ROLLBACK').catch(() => {}); active.client.release() }
    sessions.length = 0
    if (schema) { await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
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
    expect(restarted.statements.some(sql => /^INSERT /i.test(sql.trim()))).toBe(false)
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
    expect(restarted.statements.some(sql => sql.includes(OP) || sql.includes('integration_yida_credential_materials') || /^INSERT /i.test(sql.trim()))).toBe(false)
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
})
