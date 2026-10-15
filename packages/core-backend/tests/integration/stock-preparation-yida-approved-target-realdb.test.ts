// Actual 090/091/092, native MJS planner/stores, db.cjs and host encryption.
// This internal mechanism does not establish integration-admin authority or
// validate executable secret contents. No token, sender, ledger or route here.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('../utils/yida-native-module-import.cjs')
const TARGET = 'integration_yida_approved_target', AUDIT = 'integration_yida_approved_target_audit'
const DRAFT = 'integration_yida_draft_targets', OP = 'integration_yida_draft_operations', ROWS = 'integration_yida_draft_rows'
const MATERIAL = 'integration_yida_credential_materials'
const MATERIAL_AUDIT = 'integration_yida_credential_audit', DRAFT_AUDIT = 'integration_yida_draft_audit'
const ONBOARDING_TABLES = [MATERIAL, MATERIAL_AUDIT, DRAFT, OP, ROWS, DRAFT_AUDIT, TARGET, AUDIT]
const PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
type Row = Record<string, unknown>
type Context = { tenantId: string; workspaceId: string | null; ownerId: string }
type HostSecurity = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Metadata = { targetRef: string; evidenceVersion: number; status: string; identityKind: string
  evidenceStatus: string; canSend: false; canApply: false; tokenIssued: false; externalWriteAttempted: false }
type Request = { operationId: string; credentialRef: string; credentialGeneration: number; attestation: Row }
type TargetStore = { register(input: unknown): Promise<Metadata & { reused: boolean }>; inspect(input?: unknown): Promise<Metadata> }
type Draft = { operationId: string; targetRef: string; rows: Array<{ rowKey: string; index: number }>; canSend: false }
type DraftStore = { createDraft(input: unknown): Promise<Draft>; inspect(input: unknown): Promise<Draft>; replay(input: unknown): Promise<Draft> }
type MaterialStore = { create(input: unknown): Promise<{ credentialRef: string; credentialGeneration: number }>
  rotate(input: unknown): Promise<unknown>; revoke(input: unknown): Promise<unknown> }
type Config = { target: { appType: string; formUuid: string }; businessKey: string[]; emptyKeyFields: string[]; [key: string]: unknown }
type Input = { config: Config; rowsText: string; allocation: Row }
type Database = { query(sql: string, params?: unknown[]): Promise<Row[]>
  transaction<T>(callback: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T> }
type Gate = { reached: Promise<void>; release(): void }
type StructuredTransaction = { setTransactionIsolationLevel(level: 'read committed'): Promise<void>
  select(table: string, options: Row): Promise<unknown>; selectOne(table: string, where: Row): Promise<Row | null>
  selectOneForUpdate(table: string, where: Row): Promise<Row | null>; insertOne(table: string, row: Row): Promise<unknown>
  updateRow(table: string, values: Row, where: Row): Promise<unknown> }
type StructuredDb = { transaction<T>(callback: (trx: StructuredTransaction) => Promise<T>): Promise<T> }
type MaterialMetadata = { credentialRef: string; credentialGeneration: number; tenantId: string; workspaceId: string | null; ownerId: string; status: string }
type TransactionWriter<T> = (trx: StructuredTransaction, input: unknown) => Promise<T>
type WriterOptions = { security: HostSecurity; context: Context }
type Onboarded = { registered: Metadata & { reused: boolean }; createdMaterial: MaterialMetadata; createdDraft: Draft }
type Session = { client: PoolClient; pid: number; db: StructuredDb; scope: Context; target: TargetStore; draft: DraftStore; material: MaterialStore
  statements: string[]; races: string[]; gateAudit(): Gate; release(): void; loseCommitResponse(): void }

it('sentinel: approved target proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('SA05 permanent human-attested target — actual PG and no online authority', () => {
  let pool: Pool, owner: PoolClient, first: Session, second: Session, security: HostSecurity
  let schema = '', ddl = ''
  let createDb: (input: { database: Database }) => StructuredDb
  let createTarget: (input: { db: unknown; security: HostSecurity; context: Context }) => TargetStore
  let createDraft: (input: { db: unknown; security: HostSecurity; context: Context }) => DraftStore
  let createMaterial: (input: { db: unknown; security: HostSecurity; context: Context }) => MaterialStore
  let createMaterialWriter: (input: WriterOptions) => TransactionWriter<MaterialMetadata>
  let createDraftWriter: (input: WriterOptions) => TransactionWriter<Draft>
  let createTargetWriter: (input: WriterOptions) => TransactionWriter<Metadata & { reused: boolean }>
  let example: (variant?: 'primary' | 'renamed') => { config: Config; text: string }
  const sessions: Session[] = []
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let savedEnv: Array<[typeof envKeys[number], string | undefined]> = []
  const context = (patch: Partial<Context> = {}): Context => ({
    tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', ...patch,
  })
  const material = () => ({ appKey: 'synthetic-app-key', appSecret: 'synthetic-secret',
    systemToken: 'synthetic-system-token', userId: 'synthetic-executor' })
  const attestation = () => ({ kind: 'owner-reviewed-target', reviewRef: 'synthetic-review',
    organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' })
  function input(variant: 'primary' | 'renamed' = 'primary'): Input {
    const value = example(variant)
    return { config: value.config, rowsText: value.text, allocation: { mode: 'original' } }
  }
  async function request(active = first, value = input()): Promise<Request> {
    const draft = await active.draft.createDraft(value), secret = await active.material.create({ material: material() })
    return { operationId: draft.operationId, credentialRef: secret.credentialRef,
      credentialGeneration: secret.credentialGeneration, attestation: attestation() }
  }
  const ident = (value: string) => {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('SYNTHETIC_IDENTIFIER_REQUIRED')
    return `"${value}"`
  }
  const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NO_FIXED_CODE'
  async function rejected(promise: Promise<unknown>, code = 'YIDA_APPROVED_TARGET_UNAVAILABLE') {
    let caught: unknown
    try { await promise } catch (error) { caught = error }
    expect(codeOf(caught)).toBe(code)
    expect((caught as Error)?.message).toBe(code)
    expect(Object.keys(caught as object).sort()).toEqual(['code', 'name'])
    expect('cause' in (caught as object)).toBe(false)
  }
  const outcome = async (promise: Promise<unknown>) => {
    try { await promise; return { ok: true as const } }
    catch (error) { return { ok: false as const, code: codeOf(error) } }
  }
  const tableRows = async (table: string) => (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY 1`)).rows as Row[]
  async function evidence() {
    const rows = await Promise.all([TARGET, AUDIT].map(tableRows))
    return { counts: rows.map(value => value.length), digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
  }
  async function onboardingEvidence() {
    const rows = await Promise.all(ONBOARDING_TABLES.map(tableRows))
    return { counts: rows.map(value => value.length), digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
  }
  async function onboard(active = first, value = input(), bundle = material(), beforeCommit?: (made: Onboarded) => Promise<void>): Promise<Onboarded> {
    const options = { security, context: active.scope }
    const writeMaterial = createMaterialWriter(options), writeDraft = createDraftWriter(options), writeTarget = createTargetWriter(options)
    return active.db.transaction(async trx => {
      await trx.setTransactionIsolationLevel('read committed')
      const start = active.statements.length
      const createdMaterial = await writeMaterial(trx, { material: bundle }), createdDraft = await writeDraft(trx, value)
      const registered = await writeTarget(trx, { operationId: createdDraft.operationId, credentialRef: createdMaterial.credentialRef,
        credentialGeneration: createdMaterial.credentialGeneration, attestation: attestation() })
      expect(active.statements.slice(start).some(sql => /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql))).toBe(false)
      const made = { registered, createdMaterial, createdDraft }
      await beforeCommit?.(made)
      return made
    })
  }
  async function session(scope = context()): Promise<Session> {
    const client = await pool.connect()
    await client.query(`SET search_path TO ${ident(schema)}`)
    await client.query("SET statement_timeout = '10s'")
    await client.query("SET default_transaction_isolation = 'repeatable read'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = [], races: string[] = []
    let gate: (Gate & { enter(): void; open: Promise<void> }) | undefined, lostCommit = false
    const query = async (sql: string, params?: unknown[]): Promise<Row[]> => {
      statements.push(sql) // Shapes only. Never capture driver errors or parameter values.
      if (gate && sql.startsWith(`INSERT INTO "${AUDIT}"`)) {
        const held = gate; held.enter(); await held.open
        if (gate === held) gate = undefined
      }
      try { return (await client.query(sql, params)).rows as Row[] }
      catch (error) {
        if (codeOf(error) === '23505' && (error as { constraint?: string }).constraint === 'integration_yida_approved_target_pkey') races.push('SLOT_UNIQUE')
        throw error
      }
    }
    const database: Database = { query, async transaction(callback) {
      await query('BEGIN')
      try {
        const result = await callback({ query }); await query('COMMIT')
        if (lostCommit) { lostCommit = false; throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST') }
        return result
      } catch (error) { await query('ROLLBACK'); throw error }
    } }
    const config = { db: createDb({ database }), security, context: scope }
    const value: Session = { client, pid, db: config.db, scope, statements, races, target: createTarget(config), draft: createDraft(config), material: createMaterial(config),
      gateAudit() {
        let enter!: () => void, release!: () => void
        const reached = new Promise<void>(resolve => { enter = resolve }), open = new Promise<void>(resolve => { release = resolve })
        gate = { reached, open, enter, release }; return gate
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
  // Only privileged fault injection in a unique synthetic schema. Enabled
  // ordinary-DML trigger denial is tested separately, not silently bypassed.
  async function corrupt(table: string, trigger: string, column: string, value: unknown) {
    await owner.query('BEGIN')
    try {
      await owner.query(`ALTER TABLE ${ident(table)} DISABLE TRIGGER ${ident(trigger)}`)
      await owner.query(`UPDATE ${ident(table)} SET ${ident(column)} = $1`, [value])
      await owner.query(`ALTER TABLE ${ident(table)} ENABLE TRIGGER ${ident(trigger)}`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
  }

  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    const materials = requireCjs(path.join(lib, 'yida-credential-material-store.cjs'))
    createMaterial = materials.createYidaCredentialMaterialStore
    createMaterialWriter = materials.createInternalYidaCredentialTransactionWriter
    const targets = await importNative(pathToFileURL(path.join(lib, 'yida-approved-target-store.mjs')).href)
    createTarget = targets.createYidaApprovedTargetStore
    createTargetWriter = targets.createInternalYidaApprovedTargetTransactionWriter
    const drafts = await importNative(pathToFileURL(path.join(lib, 'yida-draft-plan-store.mjs')).href)
    createDraft = drafts.createYidaDraftPlanStore
    createDraftWriter = drafts.createInternalYidaDraftTransactionWriter
    example = (await importNative(pathToFileURL(path.join(lib, 'yida-static-plan.mjs')).href)).createYidaProtocolExample
    ddl = ['092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql'].map(name => readFileSync(path.join(root, 'packages/core-backend/migrations', name), 'utf8')).join('\n')
    savedEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    const securityModule = pathToFileURL(path.join(root, 'packages/core-backend/src/security/plugin-runtime-security-service.ts')).href
    const { PluginRuntimeSecurityService } = await import(securityModule) as { PluginRuntimeSecurityService: new () => HostSecurity }
    security = new PluginRuntimeSecurityService()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 9, connectionTimeoutMillis: 5000 })
    owner = await pool.connect(); await owner.query("SET statement_timeout = '10s'")
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_target_' + randomUUID().replaceAll('-', '')
    await owner.query(`CREATE SCHEMA ${ident(schema)}`); await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl); first = await session(); second = await session()
  }, 30000)
  afterEach(async () => {
    for (const active of sessions) { active.release(); await active.client.query('ROLLBACK').catch(() => {}); active.client.release() }
    sessions.length = 0
    if (schema) { await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  })
  afterAll(async () => {
    try {
      if (owner) { if (schema) await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); owner.release() }
      await pool?.end()
    } finally {
      for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })

  it('registers encrypted human evidence from actual full replay in one RC transaction; public 091 remains unverified', async () => {
    const requested = await request(); first.statements.length = 0
    const registered = await first.target.register(requested)
    expect(Object.keys(first.target).sort()).toEqual(['inspect', 'register'])
    expect(Object.keys(first.draft).sort()).toEqual(['createDraft', 'inspect', 'replay'])
    expect(Object.keys(registered).sort()).toEqual(['canApply', 'canSend', 'evidenceStatus', 'evidenceVersion',
      'externalWriteAttempted', 'identityKind', 'reused', 'status', 'targetRef', 'tokenIssued'])
    expect([registered.status, registered.identityKind, registered.evidenceStatus, registered.evidenceVersion, registered.reused])
      .toEqual(['manually_confirmed', 'owner-attested-single-target', 'current', 1, false])
    expect([registered.canSend, registered.canApply, registered.tokenIssued, registered.externalWriteAttempted]).toEqual([false, false, false, false])
    expect(first.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    expect(first.statements.filter(sql => sql === PIN).length).toBe(1)
    const locks = first.statements.filter(sql => sql.includes('FOR UPDATE'))
    expect(locks.map(sql => [TARGET, MATERIAL, DRAFT, OP].find(table => sql.includes(`"${table}"`)))).toEqual([TARGET, MATERIAL, DRAFT, OP])
    expect(first.statements.some(sql => /integration_yida_(delivery|create_fence)/.test(sql))).toBe(false)
    const row = (await tableRows(TARGET))[0], sealed = JSON.parse(await security.decrypt(String(row.evidence_encrypted))) as Row
    expect(sealed.purpose === 'yida-approved-target' && sealed.targetRef === registered.targetRef && sealed.operationId === requested.operationId).toBe(true)
    expect(row.target_ref !== row.draft_target_ref && row.slot === 1).toBe(true)
    expect(JSON.stringify(await tableRows(TARGET)).includes('synthetic-organization')).toBe(false)
    expect(JSON.stringify(await tableRows(TARGET)).includes('synthetic_stock_form')).toBe(false)
    const publicDraft = await first.draft.inspect({ operationId: requested.operationId })
    expect(publicDraft.canSend).toBe(false)
    expect((await tableRows(DRAFT))[0].status).toBe('unverified')
    expect((await first.draft.replay({ operationId: requested.operationId })).canSend).toBe(false)
  })

  it('restart and source aliases recover the same permanent physical target with no second evidence/audit', async () => {
    const requested = await request(), one = await first.target.register(requested), before = await evidence()
    const renamed = input('renamed'); renamed.rowsText = JSON.stringify((JSON.parse(renamed.rowsText) as Row[]).reverse())
    const alias = await second.draft.createDraft(renamed), restarted = await session()
    const two = await restarted.target.register({ ...requested, operationId: alias.operationId })
    expect(two.reused && two.targetRef === one.targetRef).toBe(true)
    expect((await restarted.target.inspect()).targetRef === one.targetRef).toBe(true)
    await owner.query(ddl); await owner.query(ddl)
    expect(await evidence()).toEqual(before)
  })

  it.each(['tenantId', 'ownerId'] as const)('another %s cannot register another permanent target or inspect the first', async field => {
    const requested = await request(); await first.target.register(requested)
    const foreign = await session(context({ [field]: 'synthetic-other' })), value = input()
    value.config.target.formUuid = 'synthetic-other-form'
    const competing = await request(foreign, value), before = await evidence()
    await rejected(foreign.target.register(competing), 'YIDA_APPROVED_TARGET_CONFLICT')
    await rejected(foreign.target.inspect(), 'YIDA_APPROVED_TARGET_NOT_FOUND')
    expect(await evidence()).toEqual(before)
  })

  it('only null workspace is accepted and no self-reported verified/digest fields enter the registration contract', async () => {
    expect(() => createTarget({ db: {}, security, context: context({ workspaceId: 'synthetic-workspace' }) }))
      .toThrow('YIDA_APPROVED_TARGET_INPUT')
    const requested = await request()
    for (const field of ['verified', 'targetRef', 'locator', 'keyDefinitionDigest']) {
      await rejected(first.target.register({ ...requested, [field]: true }), 'YIDA_APPROVED_TARGET_INPUT')
    }
    expect((await evidence()).counts).toEqual([0, 0])
  })

  it('another locator, changed key definition or another material cannot replace a registered target', async () => {
    const requested = await request(); await first.target.register(requested)
    const altered = input(); altered.config.target.formUuid = 'synthetic-other-form'
    const other = await second.draft.createDraft(altered), before = await evidence()
    await rejected(second.target.register({ ...requested, operationId: other.operationId }), 'YIDA_APPROVED_TARGET_CONFLICT')
    const changedKey = input(); changedKey.config.businessKey = changedKey.config.businessKey.filter(key => key !== 'componentName')
    await expect(outcome(second.draft.createDraft(changedKey))).resolves.toEqual({ ok: false, code: 'YIDA_DRAFT_KEY_DEFINITION_CONFLICT' })
    const replacement = await second.material.create({ material: material() })
    await rejected(second.target.register({ ...requested, credentialRef: replacement.credentialRef }), 'YIDA_APPROVED_TARGET_CONFLICT')
    await rejected(second.target.register({ ...requested, attestation: { ...attestation(), organizationId: 'synthetic-other' } }), 'YIDA_APPROVED_TARGET_CONFLICT')
    expect(await evidence()).toEqual(before)
  })

  it('wrong generation/revoked 090 prevents registration; later rotation invalidates evidence without releasing identity', async () => {
    const requested = await request()
    await rejected(first.target.register({ ...requested, credentialGeneration: 2 }), 'YIDA_APPROVED_TARGET_CONFLICT')
    await first.material.revoke({ credentialRef: requested.credentialRef, expectedGeneration: 1 })
    await rejected(second.target.register(requested), 'YIDA_APPROVED_TARGET_CONFLICT')
    expect((await evidence()).counts).toEqual([0, 0])
    await first.material.rotate({ credentialRef: requested.credentialRef, expectedGeneration: 1, material: material() })
    const current = { ...requested, credentialGeneration: 2 }, one = await first.target.register(current), before = await evidence()
    await second.material.rotate({ credentialRef: requested.credentialRef, expectedGeneration: 2, material: material() })
    const stale = await first.target.inspect()
    expect(stale.targetRef === one.targetRef && stale.evidenceStatus === 'invalidated' && !stale.canSend).toBe(true)
    await rejected(first.target.register(current), 'YIDA_APPROVED_TARGET_CONFLICT')
    await rejected(first.target.register({ ...current, credentialGeneration: 3 }), 'YIDA_APPROVED_TARGET_CONFLICT')
    expect(await evidence()).toEqual(before)
  })

  it.each(['same-owner', 'other-tenant', 'other-owner'] as const)('two actual PG sessions compete for one permanent slot: %s', async mode => {
    const requested = await request()
    const competitor = mode === 'same-owner' ? second : await session(context(mode === 'other-tenant'
      ? { tenantId: 'synthetic-other' } : { ownerId: 'synthetic-other' }))
    const value = input(); value.config.target.formUuid = 'synthetic-other-form'
    const competing = mode === 'same-owner' ? requested : await request(competitor, value)
    let one: Metadata | undefined, two: Metadata | undefined
    const gate = first.gateAudit(), winner = outcome(first.target.register(requested).then(result => { one = result }))
    let loser: ReturnType<typeof outcome> | undefined
    try {
      await reached(gate)
      loser = outcome(competitor.target.register(competing).then(result => { two = result }))
      await blocked(competitor, first)
    } finally { gate.release() }
    expect(await winner).toEqual({ ok: true })
    expect(await loser).toEqual(mode === 'same-owner' ? { ok: true } : { ok: false, code: 'YIDA_APPROVED_TARGET_CONFLICT' })
    if (mode === 'same-owner') expect(one?.targetRef === two?.targetRef).toBe(true)
    expect(competitor.races).toEqual(['SLOT_UNIQUE'])
    expect((await evidence()).counts).toEqual([1, 1])
  })

  it('register holds the real 090 row lock until commit so concurrent revoke waits, then invalidates evidence', async () => {
    const requested = await request(), gate = first.gateAudit()
    const registered = outcome(first.target.register(requested))
    let revoked: ReturnType<typeof outcome> | undefined
    try {
      await reached(gate)
      revoked = outcome(second.material.revoke({ credentialRef: requested.credentialRef, expectedGeneration: 1 }))
      await blocked(second, first)
    } finally { gate.release() }
    expect(await registered).toEqual({ ok: true }); expect(await revoked).toEqual({ ok: true })
    expect((await first.target.inspect()).evidenceStatus).toBe('invalidated')
    expect((await evidence()).counts).toEqual([1, 1])
  })

  it('audit insertion failure rolls back the singleton and a lost COMMIT reply never repeats registration writes', async () => {
    const requested = await request()
    await owner.query(`CREATE FUNCTION synthetic_target_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_DETAIL'; END; $$`)
    await owner.query(`CREATE TRIGGER synthetic_target_audit_failure BEFORE INSERT ON ${ident(AUDIT)} FOR EACH ROW EXECUTE FUNCTION synthetic_target_audit_failure()`)
    await rejected(first.target.register(requested))
    expect((await evidence()).counts).toEqual([0, 0])
    await owner.query(`DROP TRIGGER synthetic_target_audit_failure ON ${ident(AUDIT)}`)
    first.statements.length = 0; first.loseCommitResponse()
    await rejected(first.target.register(requested))
    expect(first.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    const committed = (await tableRows(TARGET))[0].target_ref
    const restored = await second.target.register(requested)
    expect(restored.reused && restored.targetRef === committed).toBe(true)
    expect((await evidence()).counts).toEqual([1, 1])
  })

  it('ordinary UPDATE DELETE TRUNCATE and second-slot INSERT cannot clear or replace target/audit; DDL rerun preserves them', async () => {
    const requested = await request(); await first.target.register(requested)
    const before = await evidence()
    for (const table of [TARGET, AUDIT]) {
      for (const statement of [`UPDATE ${ident(table)} SET created_at = NOW()`, `DELETE FROM ${ident(table)}`, `TRUNCATE ${ident(table)} CASCADE`]) {
        const result = await outcome(owner.query(statement))
        expect(result.ok).toBe(false)
        expect(await evidence()).toEqual(before)
      }
    }
    const row = { ...(await tableRows(TARGET))[0], slot: 2, target_ref: randomUUID() }, keys = Object.keys(row)
    const result = await outcome(owner.query(`INSERT INTO ${ident(TARGET)} (${keys.map(ident).join(',')}) VALUES (${keys.map((_, index) => '$' + (index + 1)).join(',')})`, keys.map(key => row[key as keyof typeof row])))
    expect(result.ok).toBe(false)
    await owner.query(ddl); expect(await evidence()).toEqual(before)
  })

  it.each(['ciphertext', 'bound-owner', 'key-definition'] as const)('actual host encryption and target binding fail closed on %s fault injection', async mode => {
    const requested = await request(); await first.target.register(requested)
    const row = (await tableRows(TARGET))[0]
    let damaged = 'enc:invalid-synthetic'
    if (mode !== 'ciphertext') {
      const envelope = JSON.parse(await security.decrypt(String(row.evidence_encrypted))) as Row
      if (mode === 'bound-owner') envelope.ownerId = 'synthetic-other'
      else envelope.keyDefinition = { algorithm: 'changed', fields: [] }
      damaged = await security.encrypt(JSON.stringify(envelope))
    }
    await corrupt(TARGET, 'trg_yida_approved_target_immutable', 'evidence_encrypted', damaged)
    await rejected(second.target.inspect(), mode === 'key-definition' ? 'YIDA_APPROVED_TARGET_CONFLICT' : 'YIDA_APPROVED_TARGET_UNAVAILABLE')
    await rejected(second.target.register(requested), mode === 'key-definition' ? 'YIDA_APPROVED_TARGET_CONFLICT' : 'YIDA_APPROVED_TARGET_UNAVAILABLE')
  })

  it.each(['source', 'compiled-plan', 'row-membership'] as const)('registration replays persisted complete 091 %s without a caller verification substitute', async mode => {
    const requested = await request()
    if (mode === 'row-membership') {
      await corrupt(ROWS, 'trg_yida_draft_rows_immutable', 'payload_digest', 'a'.repeat(64))
    } else {
      const row = (await tableRows(OP))[0], envelope = JSON.parse(await security.decrypt(String(row.snapshot_encrypted))) as Row & { source: Row; plan: Row }
      if (mode === 'source') envelope.source.rowsText = '[]'
      else envelope.plan.canApply = true
      await corrupt(OP, 'trg_yida_draft_operations_immutable', 'snapshot_encrypted', await security.encrypt(JSON.stringify(envelope)))
    }
    await rejected(first.target.register(requested))
    expect((await evidence()).counts).toEqual([0, 0])
  })

  it('three real writers commit 090/091/092 together in one host transaction and an independent session sees only committed rows', async () => {
    const bundle = { appKey: ' synthetic-app-key\t', appSecret: '\nsynthetic-secret字 ',
      systemToken: ' synthetic-system-token\r\n', userId: '\tsynthetic-executor ' }
    first.statements.length = 0
    const made = await onboard(first, input(), bundle, async pending => {
      expect(first.pid === second.pid).toBe(false)
      for (const table of ONBOARDING_TABLES) {
        const observed = await second.client.query(`SELECT count(*)::int AS count FROM ${ident(table)}`)
        expect(observed.rows[0].count).toBe(0)
      }
      expect(pending.createdMaterial.tenantId === first.scope.tenantId && pending.createdMaterial.ownerId === first.scope.ownerId).toBe(true)
    })
    expect(first.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    expect(first.statements.filter(sql => sql === PIN).length).toBe(1)
    expect(first.statements.filter(sql => sql === 'COMMIT').length).toBe(1)
    expect(first.statements.filter(sql => sql === 'ROLLBACK').length).toBe(0)
    expect((await onboardingEvidence()).counts).toEqual([1, 1, 1, 1, made.createdDraft.rows.length, 1, 1, 1])
    const observed = await second.client.query(`SELECT credential_ref, material_encrypted FROM ${ident(MATERIAL)}`)
    expect(observed.rows[0].credential_ref).toBe(made.createdMaterial.credentialRef)
    const sealed = JSON.parse(await security.decrypt(observed.rows[0].material_encrypted)) as { material: unknown }
    expect(sealed.material).toEqual(bundle)
    expect((await second.target.inspect()).targetRef).toBe(made.registered.targetRef)
    expect((await second.draft.replay({ operationId: made.createdDraft.operationId })).canSend).toBe(false)
  })

  it.each([MATERIAL_AUDIT, DRAFT_AUDIT, AUDIT])('a real %s audit failure rolls back all three writers to the full before snapshot', async auditTable => {
    const before = await onboardingEvidence()
    await owner.query(`CREATE FUNCTION synthetic_onboarding_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_DETAIL'; END; $$`)
    await owner.query(`CREATE TRIGGER synthetic_onboarding_audit_failure BEFORE INSERT ON ${ident(auditTable)} FOR EACH ROW EXECUTE FUNCTION synthetic_onboarding_audit_failure()`)
    first.statements.length = 0
    const expected = auditTable === MATERIAL_AUDIT ? 'YIDA_CREDENTIAL_UNAVAILABLE'
      : auditTable === DRAFT_AUDIT ? 'YIDA_DRAFT_UNAVAILABLE' : 'YIDA_APPROVED_TARGET_UNAVAILABLE'
    await rejected(onboard(), expected)
    expect(await onboardingEvidence()).toEqual(before)
    expect(first.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    expect(first.statements.filter(sql => sql === PIN).length).toBe(1)
    expect(first.statements.filter(sql => sql === 'COMMIT').length).toBe(0)
    expect(first.statements.filter(sql => sql === 'ROLLBACK').length).toBe(1)
    const insertedTables = first.statements.filter(sql => sql.startsWith('INSERT INTO')).map(sql => ONBOARDING_TABLES.find(table => sql.startsWith(`INSERT INTO "${table}"`)))
    expect(insertedTables.includes(MATERIAL)).toBe(true)
    if (auditTable !== MATERIAL_AUDIT) expect(insertedTables.includes(OP)).toBe(true)
    if (auditTable === AUDIT) expect(insertedTables.includes(TARGET)).toBe(true)
  })

  it.each(['tenantId', 'ownerId'] as const)('an occupied singleton rejects another %s and rolls back its newly written material and draft', async field => {
    await onboard()
    const foreign = await session(context({ [field]: 'synthetic-other' })), value = input()
    value.config.target.formUuid = 'synthetic-other-onboarding-form'
    const before = await onboardingEvidence()
    foreign.statements.length = 0
    await rejected(onboard(foreign, value), 'YIDA_APPROVED_TARGET_CONFLICT')
    expect(await onboardingEvidence()).toEqual(before)
    expect(foreign.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    expect(foreign.statements.filter(sql => sql === PIN).length).toBe(1)
    expect(foreign.statements.filter(sql => sql === 'ROLLBACK').length).toBe(1)
    expect(foreign.statements.some(sql => sql.startsWith(`INSERT INTO "${MATERIAL}"`))).toBe(true)
    expect(foreign.statements.some(sql => sql.startsWith(`INSERT INTO "${OP}"`))).toBe(true)
    expect(foreign.statements.some(sql => sql.startsWith(`INSERT INTO "${TARGET}"`))).toBe(false)
  })

  it('private target slot INSERT race returns a closed conflict without retrying the outer transaction', async () => {
    const value = input(), competitorInput = input(); competitorInput.config.target.formUuid = 'synthetic-race-onboarding-form'
    const gate = first.gateAudit()
    first.statements.length = 0; second.statements.length = 0
    let committed: Onboarded | undefined
    const one = outcome(onboard(first, value).then(made => { committed = made }))
    let two: ReturnType<typeof outcome> | undefined
    try {
      await reached(gate)
      two = outcome(onboard(second, competitorInput))
      await blocked(second, first)
    } finally { gate.release() }
    expect(await one).toEqual({ ok: true })
    expect(await two).toEqual({ ok: false, code: 'YIDA_APPROVED_TARGET_CONFLICT' })
    expect(second.races).toEqual(['SLOT_UNIQUE'])
    expect(second.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    expect(second.statements.filter(sql => sql === PIN).length).toBe(1)
    expect(second.statements.filter(sql => sql === 'ROLLBACK').length).toBe(1)
    expect(second.statements.filter(sql => sql === 'COMMIT').length).toBe(0)
    expect(second.statements.some(sql => sql.startsWith(`INSERT INTO "${MATERIAL}"`))).toBe(true)
    expect(second.statements.some(sql => sql.startsWith(`INSERT INTO "${OP}"`))).toBe(true)
    expect((await onboardingEvidence()).counts).toEqual([1, 1, 1, 1, committed?.createdDraft.rows.length, 1, 1, 1])
  })
})
