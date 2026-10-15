// Actual 091, db.cjs, draft store/compiler and host encryption. This owned-schema
// proof creates only local-unverified drafts: no delivery ledger or transport.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const TARGETS = 'integration_yida_draft_targets', OPERATIONS = 'integration_yida_draft_operations'
const ROWS = 'integration_yida_draft_rows', AUDIT = 'integration_yida_draft_audit'
const TABLES = [TARGETS, OPERATIONS, ROWS, AUDIT] as const
const PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
type Row = Record<string, unknown>
type Context = { tenantId: string; workspaceId: string | null; ownerId: string }
type HostSecurity = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Config = { version: number; target: { appType: string; formUuid: string }; intent: string
  businessKey: string[]; emptyKeyFields: string[]; fieldMap: Array<{ source: string; target: string; type: string }>; [key: string]: unknown }
type Input = { config: Config; rowsText: string; allocation: Row }
type Metadata = { targetRef: string; operationId: string; status: 'unverified'; identityKind: 'local-unverified'
  canSend: false; canApply: false; tokenIssued: false; externalWriteAttempted: false
  rowCount: number; rows: Array<{ rowKey: string; index: number }> }
type Created = Metadata & { reused: boolean }
type Store = { createDraft(input: unknown): Promise<Created>; inspect(input: unknown): Promise<Metadata>
  replay(input: unknown): Promise<Metadata & { replayVerified: true; evidence: Row }> }
type Database = { query(sql: string, params?: unknown[]): Promise<Row[]>
  transaction<T>(callback: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T> }
type Gate = { reached: Promise<void>; release(): void }
type Session = { client: PoolClient; pid: number; store: Store; statements: string[]; races: string[]
  gateAudit(): Gate; release(): void; loseCommitResponse(): void }

// Deliberately outside describe.skip: running the whole file without an owned
// database is a failed proof, never a green skipped suite.
it('sentinel: draft proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('SA05 immutable local-unverified drafts — real PG, compiler and host encryption', () => {
  let pool: Pool, owner: PoolClient, first: Session, second: Session, security: HostSecurity
  let schema = '', ddl = ''
  let createDb: (input: { database: Database }) => unknown
  let createStore: (input: { db: unknown; security: HostSecurity; context: Context }) => Store
  let example: (variant?: 'primary' | 'renamed') => { config: Config; rows: Row[] }
  const sessions: Session[] = []
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let savedEnv: Array<[typeof envKeys[number], string | undefined]> = []
  const context = (patch: Partial<Context> = {}): Context => ({
    tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', ...patch,
  })
  function input(variant: 'primary' | 'renamed' = 'primary', mode = 'original'): Input {
    const value = example(variant)
    const quantityField = value.config.fieldMap.find(field => field.target === 'qty')!.source
    const projectField = value.config.fieldMap.find(field => field.target === 'project')!.source
    value.rows[0][quantityField] = 6; value.rows[1][quantityField] = 3
    return { config: value.config, rowsText: JSON.stringify(value.rows), allocation: mode === 'original' ? { mode }
      : { mode, projects: mode === 'equal_integer' ? ['SYN-A', 'SYN-B', 'SYN-C'] : ['SYN-A', 'SYN-B'], projectField, quantityField } }
  }
  function changedPlan() {
    const value = input(), parsed = JSON.parse(value.rowsText) as Row[]
    parsed[0].quantity = 9; value.rowsText = JSON.stringify(parsed)
    return value
  }
  const ident = (value: string) => {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('SYNTHETIC_IDENTIFIER_REQUIRED')
    return `"${value}"`
  }
  const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NO_FIXED_CODE'
  async function outcome(promise: Promise<unknown>) {
    // Never include a successful result in a failed negative assertion.
    try { await promise; return { ok: true as const } }
    catch (error) { return { ok: false as const, code: codeOf(error) } }
  }
  async function rejected(promise: Promise<unknown>, code: string) {
    let error: unknown
    try { await promise } catch (caught) { error = caught }
    expect(codeOf(error)).toBe(code)
    expect((error as Error)?.message).toBe(code)
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name'])
    expect('cause' in (error as object)).toBe(false)
  }
  const tableRows = async (table: typeof TABLES[number]) => (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY 1`)).rows as Row[]
  async function evidence() {
    const all = await Promise.all(TABLES.map(tableRows))
    return { counts: all.map(rows => rows.length), digest: createHash('sha256').update(JSON.stringify(all)).digest('hex') }
  }
  async function insert(table: typeof TABLES[number], value: Row) {
    const keys = Object.keys(value)
    return owner.query(`INSERT INTO ${ident(table)} (${keys.map(ident).join(',')}) VALUES (${keys.map((_, index) => '$' + (index + 1)).join(',')})`, keys.map(key => value[key]))
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
      statements.push(sql) // SQL shapes only, never parameters or database error text.
      if (gate && sql.startsWith(`INSERT INTO "${AUDIT}"`)) {
        const held = gate; held.enter(); await held.open
        if (gate === held) gate = undefined
      }
      try { return (await client.query(sql, params)).rows as Row[] }
      catch (error) {
        if (codeOf(error) === '23505' && (error as { constraint?: string }).constraint === 'uniq_yida_draft_target_locator') races.push('TARGET_UNIQUE')
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
    const value: Session = { client, pid, statements, races, store: createStore({ db: createDb({ database }), security, context: scope }),
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
  // Privileged corruption fixture in this unique owned schema only. Ordinary
  // DML denial is tested separately; no production SELECT/guard is substituted.
  async function corrupt(table: typeof TABLES[number], key: string, id: string, column: string, value: unknown) {
    const suffix = table.slice('integration_yida_draft_'.length)
    const trigger = `trg_yida_draft_${suffix}_immutable`
    await owner.query('BEGIN')
    try {
      await owner.query(`ALTER TABLE ${ident(table)} DISABLE TRIGGER ${ident(trigger)}`)
      await owner.query(`UPDATE ${ident(table)} SET ${ident(column)} = $1 WHERE ${ident(key)} = $2`, [value, id])
      await owner.query(`ALTER TABLE ${ident(table)} ENABLE TRIGGER ${ident(trigger)}`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
  }

  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    const storeModule = pathToFileURL(path.join(lib, 'yida-draft-plan-store.mjs')).href
    createStore = (await import(storeModule)).createYidaDraftPlanStore
    const plannerModule = pathToFileURL(path.join(lib, 'yida-static-plan.mjs')).href
    example = (await import(plannerModule)).createYidaProtocolExample
    ddl = readFileSync(path.join(root, 'packages/core-backend/migrations/093_create_integration_yida_draft_plans.sql'), 'utf8')
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
    schema = 'yida_drafts_' + randomUUID().replaceAll('-', '')
    await owner.query(`CREATE SCHEMA ${ident(schema)}`); await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl); first = await session(); second = await session()
  }, 30000)
  afterEach(async () => {
    for (const entry of sessions) {
      entry.release(); await entry.client.query('ROLLBACK').catch(() => {}); entry.client.release()
    }
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

  it.each(['original', 'equal_integer', 'equal_decimal_exact'])('persists and replays actual %s plans with metadata-only closed capabilities', async mode => {
    const draft = await first.store.createDraft(input('primary', mode))
    expect(Object.keys(first.store).sort()).toEqual(['createDraft', 'inspect', 'replay'])
    expect(Object.keys(draft).sort()).toEqual(['canApply', 'canSend', 'externalWriteAttempted', 'identityKind', 'operationId', 'reused', 'rowCount', 'rows', 'status', 'targetRef', 'tokenIssued'])
    expect([draft.status, draft.identityKind, draft.canSend, draft.canApply, draft.tokenIssued, draft.externalWriteAttempted, draft.reused])
      .toEqual(['unverified', 'local-unverified', false, false, false, false, false])
    expect(draft.rowCount).toBe(mode === 'original' ? 2 : mode === 'equal_integer' ? 6 : 4)
    expect([draft.targetRef, draft.operationId, ...draft.rows.map(row => row.rowKey)].every(id => /^[0-9a-f-]{36}$/.test(id))).toBe(true)
    expect(draft.rows.every((row, index) => row.index === index && Object.keys(row).sort().join(',') === 'index,rowKey')).toBe(true)
    const target = (await tableRows(TARGETS))[0], operation = (await tableRows(OPERATIONS))[0]
    expect([target.target_encrypted, operation.snapshot_encrypted].every(value => typeof value === 'string' && value.startsWith('enc:'))).toBe(true)
    const targetEnvelope = JSON.parse(await security.decrypt(String(target.target_encrypted))) as Row
    const snapshot = JSON.parse(await security.decrypt(String(operation.snapshot_encrypted))) as Row
    expect(targetEnvelope.purpose === 'yida-draft-target' && targetEnvelope.targetRef === draft.targetRef).toBe(true)
    expect(snapshot.purpose === 'yida-draft-operation' && snapshot.operationId === draft.operationId).toBe(true)
    const persisted = JSON.stringify([await tableRows(TARGETS), await tableRows(OPERATIONS), await tableRows(ROWS), await tableRows(AUDIT)])
    expect(['synthetic_stock_app', 'synthetic_stock_form', 'DEMO-PART-A', 'formDataJson'].every(value => !persisted.includes(value))).toBe(true)
    const restarted = await session(), { reused: _reused, ...metadata } = draft
    expect(JSON.stringify(await restarted.store.inspect({ operationId: draft.operationId })) === JSON.stringify(metadata)).toBe(true)
    const replay = await restarted.store.replay({ operationId: draft.operationId })
    expect(replay.replayVerified).toBe(true)
    expect(replay.evidence).toEqual({ rowCount: draft.rowCount, plannedCreate: draft.rowCount, plannedUpdate: 0, invalid: 0, duplicateKeyCount: 0 })
    for (const active of [first, restarted]) {
      const starts = active.statements.flatMap((sql, index) => sql === 'BEGIN' ? [index] : [])
      expect(starts.length > 0 && starts.every(index => active.statements[index + 1] === PIN)).toBe(true)
      expect(active.statements.some(sql => sql.includes('FOR UPDATE'))).toBe(true)
      expect(active.statements.some(sql => /integration_yida_(delivery|credential)/.test(sql))).toBe(false)
    }
  })

  it('same semantic plan, renamed source aliases and reversed input order reuse immutable operation and row keys', async () => {
    const one = await first.store.createDraft(input()), before = await evidence()
    const renamed = input('renamed'); renamed.rowsText = JSON.stringify((JSON.parse(renamed.rowsText) as Row[]).reverse())
    const two = await second.store.createDraft(renamed)
    expect(two.reused && two.targetRef === one.targetRef && two.operationId === one.operationId && JSON.stringify(two.rows) === JSON.stringify(one.rows)).toBe(true)
    expect(await evidence()).toEqual(before)
    await owner.query(ddl); await owner.query(ddl)
    expect(await evidence()).toEqual(before)
    expect((await first.store.replay({ operationId: one.operationId })).replayVerified).toBe(true)
  })

  it('changed payload makes a new immutable operation without replacing the old source or target', async () => {
    const one = await first.store.createDraft(input()), originalRows = await tableRows(OPERATIONS)
    const two = await second.store.createDraft(changedPlan())
    expect(two.targetRef === one.targetRef && two.operationId !== one.operationId && !two.reused).toBe(true)
    expect(JSON.stringify((await tableRows(OPERATIONS)).find(row => row.operation_id === one.operationId)) === JSON.stringify(originalRows[0])).toBe(true)
    expect((await evidence()).counts).toEqual([1, 2, 4, 2])
    expect((await first.store.replay({ operationId: one.operationId })).replayVerified).toBe(true)
    expect((await first.store.replay({ operationId: two.operationId })).replayVerified).toBe(true)
  })

  it.each(['tenantId', 'workspaceId', 'ownerId'] as const)('exact %s boundary applies before inspection or replay and does not leak snapshots', async field => {
    const one = await first.store.createDraft(input()), foreign = await session(context({ [field]: 'synthetic-other' }))
    const before = await evidence()
    await rejected(foreign.store.inspect({ operationId: one.operationId }), 'YIDA_DRAFT_NOT_FOUND')
    await rejected(foreign.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_NOT_FOUND')
    expect(await evidence()).toEqual(before)
    if (field === 'ownerId') {
      await rejected(foreign.store.createDraft(input()), 'YIDA_DRAFT_CONFLICT')
      expect(await evidence()).toEqual(before)
    } else {
      const separate = await foreign.store.createDraft(input())
      expect(separate.targetRef !== one.targetRef && separate.operationId !== one.operationId).toBe(true)
      await rejected(first.store.inspect({ operationId: separate.operationId }), 'YIDA_DRAFT_NOT_FOUND')
    }
  })

  it('changed key definition cannot split the same owner locator namespace', async () => {
    await first.store.createDraft(input()); const before = await evidence(), altered = input()
    altered.config.businessKey = altered.config.businessKey.filter(key => key !== 'componentName')
    await rejected(second.store.createDraft(altered), 'YIDA_DRAFT_KEY_DEFINITION_CONFLICT')
    expect(await evidence()).toEqual(before)
  })

  it('another declared locator gets a distinct local-only target, not remote ownership verification', async () => {
    const one = await first.store.createDraft(input()), altered = input()
    altered.config.target.formUuid = 'synthetic-other-form'
    const two = await first.store.createDraft(altered)
    expect(two.targetRef !== one.targetRef && two.status === 'unverified' && !two.canSend).toBe(true)
    expect((await evidence()).counts).toEqual([2, 2, 4, 2])
  })

  it.each(['same-plan', 'changed-plan', 'foreign-owner'] as const)('real two-PID first-target unique race: %s gets only the committed canonical namespace', async mode => {
    const competitor = mode === 'foreign-owner' ? await session(context({ ownerId: 'synthetic-other-owner' })) : second
    let one: Created | undefined, two: Created | undefined
    const gate = first.gateAudit(), winner = outcome(first.store.createDraft(input()).then(value => { one = value }))
    await reached(gate)
    const loser = outcome(competitor.store.createDraft(mode === 'changed-plan' ? changedPlan() : input()).then(value => { two = value }))
    try { await blocked(competitor, first) } finally { gate.release() }
    expect(await winner).toEqual({ ok: true })
    expect(await loser).toEqual(mode === 'foreign-owner' ? { ok: false, code: 'YIDA_DRAFT_CONFLICT' } : { ok: true })
    expect(competitor.races).toEqual(['TARGET_UNIQUE'])
    expect(competitor.statements.filter(sql => sql === 'BEGIN').length).toBe(2)
    const rollback = competitor.statements.indexOf('ROLLBACK')
    expect(rollback >= 0 && competitor.statements[rollback + 1] === 'BEGIN' && competitor.statements[rollback + 2] === PIN).toBe(true)
    if (mode !== 'foreign-owner') {
      expect(one!.targetRef === two!.targetRef).toBe(true)
      expect(two!.reused).toBe(mode === 'same-plan')
      expect(one!.operationId === two!.operationId).toBe(mode === 'same-plan')
    }
    expect((await evidence()).counts).toEqual(mode === 'changed-plan' ? [1, 2, 4, 2] : [1, 1, 2, 1])
  })

  it('existing-target row lock serializes concurrent new-operation reuse without a second audit', async () => {
    await first.store.createDraft(input())
    let one: Created | undefined, two: Created | undefined
    const gate = first.gateAudit(), winner = outcome(first.store.createDraft(changedPlan()).then(value => { one = value }))
    await reached(gate)
    const loser = outcome(second.store.createDraft(changedPlan()).then(value => { two = value }))
    try { await blocked(second, first) } finally { gate.release() }
    expect(await winner).toEqual({ ok: true }); expect(await loser).toEqual({ ok: true })
    expect(one!.operationId === two!.operationId && !one!.reused && two!.reused).toBe(true)
    expect(second.races.length).toBe(0)
    expect((await evidence()).counts).toEqual([1, 2, 4, 2])
  })

  it.each([false, true])('actual audit INSERT failure rolls back all new rows (existing target=%s)', async existing => {
    if (existing) await first.store.createDraft(input())
    const before = await evidence()
    await owner.query(`ALTER TABLE ${ident(AUDIT)} ADD CONSTRAINT synthetic_audit_failure CHECK (false) NOT VALID`)
    await rejected(first.store.createDraft(existing ? changedPlan() : input()), 'YIDA_DRAFT_UNAVAILABLE')
    expect(await evidence()).toEqual(before)
    expect(first.statements.at(-1)).toBe('ROLLBACK')
  })

  it('lost COMMIT response is unavailable, while a fresh store finds and reuses the durable snapshot', async () => {
    first.loseCommitResponse()
    await rejected(first.store.createDraft(input()), 'YIDA_DRAFT_UNAVAILABLE')
    expect(first.statements.filter(sql => sql === 'BEGIN').length).toBe(1)
    expect((await evidence()).counts).toEqual([1, 1, 2, 1])
    const operationId = String((await tableRows(OPERATIONS))[0].operation_id), before = await evidence(), restarted = await session()
    expect((await restarted.store.replay({ operationId })).replayVerified).toBe(true)
    const retry = await restarted.store.createDraft(input())
    expect(retry.reused && retry.operationId === operationId).toBe(true)
    expect(await evidence()).toEqual(before)
  })

  it.each(['targetRef', 'operationId', 'rowKey', 'planDigest', 'locatorDigest', 'credentialRef', 'canSend'])('caller-supplied %s is rejected before any transaction', async key => {
    const before = await evidence(), statements = first.statements.length
    await rejected(first.store.createDraft({ ...input(), [key]: 'synthetic-untrusted' }), 'YIDA_DRAFT_INPUT')
    expect(first.statements.length).toBe(statements)
    expect(await evidence()).toEqual(before)
  })

  it('null original allocation and unknown opaque operation fail closed without persisted plans', async () => {
    await rejected(first.store.createDraft({ ...input(), allocation: null }), 'YIDA_DRAFT_INPUT')
    await rejected(first.store.inspect({ operationId: randomUUID() }), 'YIDA_DRAFT_NOT_FOUND')
    await rejected(first.store.replay({ operationId: randomUUID(), canSend: true }), 'YIDA_DRAFT_INPUT')
    expect((await evidence()).counts).toEqual([0, 0, 0, 0])
  })

  it.each(TABLES)('ordinary UPDATE/DELETE/TRUNCATE cannot mutate or erase %s', async table => {
    await first.store.createDraft(input()); const before = await evidence()
    for (const sql of [`UPDATE ${ident(table)} SET created_at = created_at`, `DELETE FROM ${ident(table)}`, `TRUNCATE ${ident(table)} CASCADE`]) {
      expect(await outcome(owner.query(sql))).toEqual({ ok: false, code: 'P0001' })
      expect(await evidence()).toEqual(before)
    }
  })

  it.each([TARGETS, OPERATIONS] as const)('ordinary DML cannot promote %s to verified or active', async table => {
    await first.store.createDraft(input()); const before = await evidence()
    for (const status of ['verified', 'active', 'approved']) {
      expect(await outcome(owner.query(`UPDATE ${ident(table)} SET status = $1`, [status]))).toEqual({ ok: false, code: 'P0001' })
    }
    expect(await evidence()).toEqual(before)
  })

  it('DB INSERT timestamps override caller time for every immutable table', async () => {
    await first.store.createDraft(input())
    const values = await Promise.all(TABLES.map(tableRows)), target = randomUUID(), operation = randomUUID()
    const copies = [
      { ...values[0][0], target_ref: target, locator_digest: 'a'.repeat(64) },
      { ...values[1][0], operation_id: operation, target_ref: target },
      { ...values[2][0], row_key: randomUUID(), operation_id: operation },
      { ...values[3][0], id: randomUUID(), operation_id: operation, target_ref: target },
    ]
    for (let index = 0; index < TABLES.length; index++) await insert(TABLES[index], { ...copies[index], created_at: new Date(0) })
    for (const table of TABLES) expect((await tableRows(table)).every(row => new Date(row.created_at as string).getTime() > 0)).toBe(true)
  })

  it.each([
    [TARGETS, 'target_encrypted', 'plaintext'], [TARGETS, 'target_encrypted', 'v1:legacy'],
    [OPERATIONS, 'snapshot_encrypted', 'plaintext'], [OPERATIONS, 'snapshot_encrypted', 'v1:legacy'], [OPERATIONS, 'snapshot_encrypted', 'enc:'],
    [TARGETS, 'status', 'verified'], [OPERATIONS, 'row_count', 0], [OPERATIONS, 'row_count', 101],
    [ROWS, 'ordinal', -1], [ROWS, 'ordinal', 100], [ROWS, 'business_key_digest', 'invalid'],
    [AUDIT, 'event', 'send'],
  ] as const)('INSERT shape constraint refuses forbidden durable data %#', async (table, column, invalid) => {
    await first.store.createDraft(input()); const before = await evidence(), copy = { ...(await tableRows(table))[0], [column]: invalid }
    if (table === TARGETS) { copy.target_ref = randomUUID(); copy.locator_digest = 'b'.repeat(64) }
    if (table === OPERATIONS) { copy.operation_id = randomUUID(); copy.plan_digest = 'b'.repeat(64) }
    if (table === ROWS) copy.row_key = randomUUID()
    if (table === AUDIT) copy.id = randomUUID()
    expect(await outcome(insert(table, copy))).toEqual({ ok: false, code: '23514' })
    expect(await evidence()).toEqual(before)
  })

  it.each(['target', 'operation'] as const)('moving another real %s ciphertext is rejected by actual host decryption plus binding checks', async kind => {
    const one = await first.store.createDraft(input()), other = input(); other.config.target.formUuid = 'synthetic-other-form'
    const two = await second.store.createDraft(other), table = kind === 'target' ? TARGETS : OPERATIONS
    const key = kind === 'target' ? 'target_ref' : 'operation_id', column = kind === 'target' ? 'target_encrypted' : 'snapshot_encrypted'
    const donor = (await tableRows(table)).find(row => row[key] === (kind === 'target' ? two.targetRef : two.operationId))!
    await corrupt(table, key, kind === 'target' ? one.targetRef : one.operationId, column, donor[column])
    await rejected(first.store.inspect({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
    await rejected(first.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
  })

  it.each([
    ['target', 'tenantId'], ['target', 'workspaceId'], ['target', 'ownerId'], ['target', 'targetRef'],
    ['target', 'purpose'], ['target', 'schemaVersion'], ['target', 'locator'], ['target', 'keyDefinition'],
    ['operation', 'tenantId'], ['operation', 'workspaceId'], ['operation', 'ownerId'], ['operation', 'targetRef'],
    ['operation', 'operationId'], ['operation', 'planDigest'], ['operation', 'purpose'], ['operation', 'schemaVersion'],
    ['operation', 'source'], ['operation', 'plan'],
  ] as const)('actual encrypted %s envelope refuses mismatched %s without returning a snapshot', async (kind, field) => {
    const one = await first.store.createDraft(input()), table = kind === 'target' ? TARGETS : OPERATIONS
    const key = kind === 'target' ? 'target_ref' : 'operation_id', column = kind === 'target' ? 'target_encrypted' : 'snapshot_encrypted'
    const envelope = JSON.parse(await security.decrypt(String((await tableRows(table))[0][column]))) as Row
    envelope[field] = field === 'schemaVersion' ? 2 : 'synthetic-wrong-binding'
    await corrupt(table, key, kind === 'target' ? one.targetRef : one.operationId, column, await security.encrypt(JSON.stringify(envelope)))
    await rejected(second.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
  })

  it.each(['target', 'operation'] as const)('authenticated %s ciphertext byte tampering fails with fixed values-free error', async kind => {
    const one = await first.store.createDraft(input()), table = kind === 'target' ? TARGETS : OPERATIONS
    const key = kind === 'target' ? 'target_ref' : 'operation_id', column = kind === 'target' ? 'target_encrypted' : 'snapshot_encrypted'
    const bytes = Buffer.from(String((await tableRows(table))[0][column]).slice(4), 'base64'); bytes[bytes.length - 1] ^= 1
    await corrupt(table, key, kind === 'target' ? one.targetRef : one.operationId, column, 'enc:' + bytes.toString('base64'))
    await rejected(second.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
  })

  it('a genuinely encrypted but falsely applyable stored plan cannot replace actual planner output', async () => {
    const one = await first.store.createDraft(input()), row = (await tableRows(OPERATIONS))[0]
    const envelope = JSON.parse(await security.decrypt(String(row.snapshot_encrypted))) as Row & { plan: Row }
    envelope.plan.canApply = true
    await corrupt(OPERATIONS, 'operation_id', one.operationId, 'snapshot_encrypted', await security.encrypt(JSON.stringify(envelope)))
    await rejected(second.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
  })

  it.each(['row_count', 'ordinal', 'business_key_digest', 'payload_digest'])('replay independently checks actual durable %s against sealed planner output', async field => {
    const one = await first.store.createDraft(input())
    if (field === 'row_count') await corrupt(OPERATIONS, 'operation_id', one.operationId, field, 3)
    else await corrupt(ROWS, 'row_key', one.rows[0].rowKey, field, field === 'ordinal' ? 99 : 'c'.repeat(64))
    await rejected(second.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
  })

  it('a missing durable member cannot be hidden behind an intact encrypted plan', async () => {
    const one = await first.store.createDraft(input())
    // Privileged owned-schema fault injection only; ordinary DELETE rejection
    // above remains a separate assertion against the enabled real trigger.
    await owner.query('BEGIN')
    try {
      await owner.query(`ALTER TABLE ${ident(ROWS)} DISABLE TRIGGER trg_yida_draft_rows_immutable`)
      await owner.query(`DELETE FROM ${ident(ROWS)} WHERE row_key = $1`, [one.rows[0].rowKey])
      await owner.query(`ALTER TABLE ${ident(ROWS)} ENABLE TRIGGER trg_yida_draft_rows_immutable`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
    await rejected(second.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
  })

  it.each(['ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const)('missing production %s cannot write or read immutable drafts', async key => {
    const one = await first.store.createDraft(input()), before = await evidence(), prior = process.env[key]
    delete process.env[key]
    try {
      await rejected(second.store.createDraft(changedPlan()), 'YIDA_DRAFT_UNAVAILABLE')
      await rejected(second.store.replay({ operationId: one.operationId }), 'YIDA_DRAFT_UNAVAILABLE')
      expect(await evidence()).toEqual(before)
    } finally { process.env[key] = prior }
  })
})
