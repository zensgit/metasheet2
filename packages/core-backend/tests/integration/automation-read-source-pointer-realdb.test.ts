/** SA-06K: actual 079 store, scope-epoch migration and private pointer lock on PG.
 * Own synthetic metadata, not a JWT/live actor, full provider or source-IO proof.
 * EXT prerequisite contains only the columns its real pointer writer consumes.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up, down } from '../../src/db/migrations/zzzz20261001124000_stock_prep_source_pointer_revisions'
import { up as addReadLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { lockAutomationReadSourcePointer } from '../../src/integration/automation-read-source-pointer'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECT_DB requires the synthetic source-pointer database', () => expect(process.env.DATABASE_URL).toBeTruthy())
const table = 'integration_stock_prep_source_binding'
const epochTable = 'integration_stock_prep_source_pointer_revisions'
const scope = { tenantId: 'synthetic-tenant', workspaceId: null, actionId: 'plm.stock-preparation.pull-bom.v1' }
const systemA = 'synthetic-system-a', systemB = 'synthetic-system-b'
const denied = { code: 'AUTOMATION_SOURCE_POINTER_DENIED' }
const unavailable = { code: 'AUTOMATION_SOURCE_POINTER_UNAVAILABLE' }
type Row = Record<string, unknown>
type RawQuery = { query(statement: string, params?: unknown[]): Promise<unknown> }
type Store = { set(input: Row): Promise<{ changed: boolean; binding: Row }>; get(input: Row): Promise<Row | null> }
const requirePlugin = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
const { createDb } = requirePlugin(path.join(pluginLib, 'db.cjs')) as {
  createDb(input: { database: RawQuery & { transaction<T>(work: (trx: RawQuery) => Promise<T>): Promise<T> } }): unknown
}
const { createStockPreparationSourceBindingStore } = requirePlugin(path.join(pluginLib, 'stock-preparation-source-binding-store.cjs')) as {
  createStockPreparationSourceBindingStore(input: { db: unknown; idGenerator(): string }): Store
}

describeDatabase('Automation source pointer: exact scope, DB ABA epoch and actual writer locks', () => {
  const schema = `automation_pointer_${randomBytes(8).toString('hex')}`
  let pool: Pool, migrationDb: Kysely<unknown>
  let admin: PoolClient, reader: PoolClient, writer: PoolClient, observer: PoolClient
  let schemaCreated = false
  let store: Store
  const statements: string[] = []
  const traced: Queryable = { async query(statement, params) { statements.push(statement); return reader.query(statement, params) } }

  function makeStore(client: PoolClient): Store {
    const database = { query: (statement: string, params?: unknown[]) => client.query(statement, params),
      async transaction<T>(work: (trx: RawQuery) => Promise<T>): Promise<T> {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        try { const result = await work(database); await client.query('COMMIT'); return result }
        catch (error) { await client.query('ROLLBACK'); throw error }
      },
    }
    return createStockPreparationSourceBindingStore({ db: createDb({ database }), idGenerator: randomUUID })
  }
  async function set(externalSystemId = systemA, overrides: Row = {}) {
    return store.set({ ...scope, externalSystemId, actor: 'synthetic-operator', ...overrides })
  }
  async function capture(input = scope) {
    statements.length = 0
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { return await lockAutomationReadSourcePointer(traced, input) }
    finally { await reader.query('ROLLBACK') }
  }
  async function epoch() {
    return (await admin.query(`SELECT * FROM ${epochTable} WHERE tenant_id=$1 AND workspace_key='' AND action_id=$2`,
      [scope.tenantId, scope.actionId])).rows[0] as Row | undefined
  }
  async function metadata() {
    return Promise.all([table, epochTable].map(async relation =>
      (await admin.query(`SELECT to_jsonb(t) AS row FROM ${relation} t ORDER BY to_jsonb(t)::text`)).rows))
  }
  async function pid(client: PoolClient) { return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) }
  async function witnessBlocked(waiter: number, blocker: number, done: () => boolean) {
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
      const row = (await observer.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker])).rows[0]
      if (row?.blocked === true) { expect(done()).toBe(false); return }
      expect(done(), 'writer must remain pending behind our real reader lock').toBe(false)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    throw new Error('Owned PostgreSQL blocking relationship not observed')
  }
  async function migrate(direction: 'up' | 'down') { return migrationDb.transaction().execute(direction === 'up' ? up : down) }
  async function retainedGrant() {
    await admin.query(`INSERT INTO integration_automation_read_grants
      (id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions)
      VALUES ($1,$2,'synthetic-owner','{}',$3::jsonb,$4,ARRAY['synthetic-project'],ARRAY['manual'],'{}',clock_timestamp()+interval '1 hour',1)`,
    [randomUUID(), scope.tenantId, JSON.stringify({ connectionId: 'synthetic-connection', connectionIncarnation: randomUUID() }), 'a'.repeat(64)])
  }

  beforeAll(async () => {
    if (!/^automation_pointer_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6,
      options: `-c search_path=${schema} -c statement_timeout=8000` })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    await admin.query(`CREATE TABLE integration_external_systems (id text PRIMARY KEY, tenant_id text NOT NULL, workspace_id text)`)
    await admin.query(readFileSync(path.resolve(__dirname, '../../migrations/079_create_integration_stock_prep_source_binding.sql'), 'utf8'))
    await migrate('up')
    await migrationDb.transaction().execute(addReadLedger)
    reader = await pool.connect(); writer = await pool.connect(); observer = await pool.connect()
    store = makeStore(admin)
  })
  afterAll(async () => {
    for (const client of [reader, writer, observer]) if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    if (migrationDb) await migrationDb.destroy()
    else await pool?.end()
  })
  beforeEach(async () => {
    for (const client of [admin, reader, writer, observer]) await client.query('ROLLBACK')
    // Test-only superuser reset of these two owned-schema tables. Runtime cannot
    // clear tombstones through DML; that guard is positively tested below.
    await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER USER; ALTER TABLE ${epochTable} DISABLE TRIGGER USER`)
    try { await admin.query(`TRUNCATE ${table}, ${epochTable}, integration_external_systems,
      integration_automation_read_requests, integration_automation_read_grants`) }
    finally { await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER USER; ALTER TABLE ${epochTable} ENABLE TRIGGER USER`) }
    for (const id of [systemA, systemB]) await admin.query('INSERT INTO integration_external_systems VALUES ($1,$2,NULL)', [id, scope.tenantId])
    statements.length = 0
  })

  it('never-bound is an explicit frozen absence, not a guessed default or a read-time write', async () => {
    const before = await metadata()
    const absent = await capture()
    expect(absent).toEqual({ ...scope, state: 'absent', sourcePointerRevision: null, sourcePointerRowId: null, externalSystemId: null })
    expect(Object.isFrozen(absent)).toBe(true)
    expect(await metadata()).toEqual(before)
    expect(statements.some(statement => /\b(?:INSERT|DELETE|CREATE|ALTER|BEGIN|COMMIT)\b/iu.test(statement))).toBe(false)
    expect(statements.some(statement => /LOCK TABLE integration_stock_prep_source_binding IN SHARE MODE NOWAIT/iu.test(statement))).toBe(true)
  })
  it('actual manual set/get and strict reader agree on the exact null-workspace pointer', async () => {
    expect((await set()).changed).toBe(true)
    const row = await epoch()
    const loaded = await capture()
    expect(loaded).toEqual({ ...scope, state: 'bound', sourcePointerRevision: row?.revision,
      sourcePointerRowId: row?.binding_id, externalSystemId: systemA })
    expect(loaded.sourcePointerRevision).toMatch(/^[a-f0-9-]{36}$/u)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(await store.get(scope)).toMatchObject({ externalSystemId: systemA, matchedWorkspaceId: null, scopeFallback: null })
  })
  it('real manual A→B→A changes authority twice even though the final system id is unchanged', async () => {
    await set(); const a = await capture()
    await set(systemB); const b = await capture()
    await set(systemA); const again = await capture()
    expect(a.sourcePointerRowId).toBe(b.sourcePointerRowId)
    expect(again.sourcePointerRowId).toBe(a.sourcePointerRowId)
    expect(new Set([a.sourcePointerRevision, b.sourcePointerRevision, again.sourcePointerRevision]).size).toBe(3)
    expect(again.externalSystemId).toBe(a.externalSystemId)
  })
  it('same-pointer manual resave and metadata-only/no-op edits preserve authority revision', async () => {
    await set(); const original = await capture()
    expect((await set(systemA, { actor: 'synthetic-second-operator' })).changed).toBe(false)
    await admin.query(`UPDATE ${table} SET created_at=created_at+interval '1 day',updated_at=updated_at+interval '1 second'`)
    expect(await capture()).toEqual(original)
    await admin.query(`UPDATE ${table} SET external_system_id=external_system_id`)
    expect(await capture()).toEqual(original)
  })
  it('absent→insert→delete→absent retains a new tombstone and cannot revive a never-bound grant', async () => {
    const before = await capture()
    await set(); const bound = await capture()
    await admin.query(`DELETE FROM ${table}`)
    expect(await epoch()).toMatchObject({ binding_id: null, external_system_id: null })
    const after = await capture()
    expect(after).toEqual({ ...scope, state: 'absent', sourcePointerRevision: expect.any(String), sourcePointerRowId: null, externalSystemId: null })
    expect(after.sourcePointerRevision).not.toBe(before.sourcePointerRevision)
    expect(after.sourcePointerRevision).not.toBe(bound.sourcePointerRevision)
    expect((await epoch())?.binding_id).toBeNull()
  })
  it('same-id delete/recreate cannot inherit the old source pointer revision', async () => {
    await set(); const before = await capture()
    await admin.query(`DELETE FROM ${table}`)
    await admin.query(`INSERT INTO ${table} (id,tenant_id,workspace_id,action_id,external_system_id) VALUES ($1,$2,NULL,$3,$4)`,
      [before.sourcePointerRowId, scope.tenantId, scope.actionId, systemA])
    const after = await capture()
    expect(after.sourcePointerRowId).toBe(before.sourcePointerRowId)
    expect(after.sourcePointerRevision).not.toBe(before.sourcePointerRevision)
  })
  it.each(['tenant_id', 'workspace_id', 'action_id'] as const)('moving %s preserves the old scope tombstone and cannot revive it on move-back', async column => {
    await set(); const before = await capture()
    const original = column === 'tenant_id' ? scope.tenantId : column === 'action_id' ? scope.actionId : null
    await admin.query(`UPDATE ${table} SET ${column}=$1`, ['synthetic-other-scope'])
    expect(await epoch()).toMatchObject({ binding_id: null, external_system_id: null })
    const absent = await capture()
    expect(absent.state).toBe('absent')
    expect(absent.sourcePointerRevision).not.toBe(before.sourcePointerRevision)
    expect((await admin.query(`SELECT * FROM ${epochTable}`)).rows).toHaveLength(2)
    await admin.query(`UPDATE ${table} SET ${column}=$1`, [original])
    const restored = await capture()
    expect(restored.externalSystemId).toBe(systemA)
    expect(restored.sourcePointerRevision).not.toBe(before.sourcePointerRevision)
    expect(restored.sourcePointerRevision).not.toBe(absent.sourcePointerRevision)
  })
  it('raw empty workspace is not null: rejects it and tracks null→empty→null as a revision change', async () => {
    await set(); const before = await capture()
    await admin.query(`UPDATE ${table} SET workspace_id=''`)
    expect((await epoch())?.revision).not.toBe(before.sourcePointerRevision)
    await expect(capture()).rejects.toMatchObject(denied)
    await admin.query(`UPDATE ${table} SET workspace_id=NULL`)
    const after = await capture()
    expect(after.externalSystemId).toBe(systemA)
    expect(after.sourcePointerRevision).not.toBe(before.sourcePointerRevision)
  })
  it('does not borrow the real manual sibling fallback or another tenant/action row', async () => {
    await set(systemB, { workspaceId: 'synthetic-workspace' })
    expect(await store.get(scope)).toMatchObject({ externalSystemId: systemB, scopeFallback: 'single_workspace_binding' })
    expect(await capture()).toMatchObject({ state: 'absent', sourcePointerRevision: null })
    await admin.query(`INSERT INTO ${table} (id,tenant_id,action_id,external_system_id) VALUES
      ('synthetic-foreign-tenant','synthetic-other-tenant',$1,$2),('synthetic-foreign-action',$3,'synthetic-other-action',$2)`,
    [scope.actionId, systemB, scope.tenantId])
    expect(await capture()).toMatchObject({ state: 'absent', sourcePointerRevision: null })
    await set(systemA)
    expect(await capture()).toMatchObject({ state: 'bound', externalSystemId: systemA })
  })
  it.each([
    ['missing epoch', `DELETE FROM ${epochTable}`],
    ['tombstone over live row', `UPDATE ${epochTable} SET binding_id=NULL,external_system_id=NULL`],
    ['different row', `UPDATE ${epochTable} SET binding_id='synthetic-other-id'`],
    ['different system', `UPDATE ${epochTable} SET external_system_id='synthetic-other-system'`],
  ])('rejects inconsistent persisted material: %s', async (_name, edit) => {
    await set()
    // Deliberately emulate preexisting corrupt metadata, not a runtime attack
    // possible through ordinary CRUD (the epoch DML guard prevents that).
    await admin.query(`ALTER TABLE ${epochTable} DISABLE TRIGGER USER`)
    try { await admin.query(edit); await expect(capture()).rejects.toMatchObject(denied) }
    finally { await admin.query(`ALTER TABLE ${epochTable} ENABLE TRIGGER USER`) }
  })
  it('a live-looking epoch with no actual binding is not a usable default', async () => {
    await set()
    await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
    try { await admin.query(`DELETE FROM ${table}`); await expect(capture()).rejects.toMatchObject(denied) }
    finally { await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`) }
  })
  it('cannot forge transaction presence or use repeatable-read', async () => {
    await expect(lockAutomationReadSourcePointer(reader, scope)).rejects.toMatchObject({ code: 'AUTOMATION_SOURCE_POINTER_TRANSACTION_REQUIRED' })
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try { await expect(lockAutomationReadSourcePointer(reader, scope)).rejects.toMatchObject({ code: 'AUTOMATION_SOURCE_POINTER_TRANSACTION_REQUIRED' }) }
    finally { await reader.query('ROLLBACK') }
  })
  it.each(['insert', 'update', 'delete', 'epoch-update'] as const)('reader-first locks survive helper return and block %s until commit', async mode => {
    if (mode !== 'insert') await set()
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const before = await lockAutomationReadSourcePointer(reader, scope)
    const readerPid = await pid(reader), writerPid = await pid(writer)
    let done = false
    const editing = (mode === 'insert' ? makeStore(writer).set({ ...scope, externalSystemId: systemA })
      : mode === 'update' ? makeStore(writer).set({ ...scope, externalSystemId: systemB })
        : writer.query(mode === 'delete' ? `DELETE FROM ${table}` : `UPDATE ${epochTable} SET revision=gen_random_uuid()`))
      .finally(() => { done = true })
    void editing.catch(() => {})
    try {
      await witnessBlocked(writerPid, readerPid, () => done)
      expect(await lockAutomationReadSourcePointer(reader, scope)).toEqual(before)
      await reader.query('COMMIT'); await editing
      expect((await capture()).sourcePointerRevision).not.toBe(before.sourcePointerRevision)
    } finally { await reader.query('ROLLBACK'); await Promise.allSettled([editing]) }
  })
  it.each(['insert', 'update', 'delete', 'epoch-update'] as const)('writer-first %s is refused NOWAIT and rechecked after commit', async mode => {
    if (mode !== 'insert') await set()
    const before = await capture()
    await writer.query('BEGIN')
    try {
      if (mode === 'insert') await writer.query(`INSERT INTO ${table} (id,tenant_id,action_id,external_system_id) VALUES ($1,$2,$3,$4)`, [randomUUID(),scope.tenantId,scope.actionId,systemA])
      else if (mode === 'update') await writer.query(`UPDATE ${table} SET external_system_id=$1`, [systemB])
      else await writer.query(mode === 'delete' ? `DELETE FROM ${table}` : `UPDATE ${epochTable} SET revision=gen_random_uuid()`)
      await expect(capture()).rejects.toMatchObject(unavailable)
      await writer.query('COMMIT')
      expect((await capture()).sourcePointerRevision).not.toBe(before.sourcePointerRevision)
    } finally { await writer.query('ROLLBACK') }
  })
  it('an absent epoch cannot be inserted by ordinary CRUD while the reader holds its negative lookup fence', async () => {
    const insertEpoch = () => writer.query(`INSERT INTO ${epochTable} (tenant_id,workspace_key,action_id,revision)
      VALUES ($1,'',$2,$3)`, [scope.tenantId, scope.actionId, randomUUID()])
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      expect(await lockAutomationReadSourcePointer(reader, scope)).toMatchObject({ state: 'absent', sourcePointerRevision: null })
      await expect(insertEpoch()).rejects.toMatchObject({ code: '55P03' })
      expect(await lockAutomationReadSourcePointer(reader, scope)).toMatchObject({ state: 'absent', sourcePointerRevision: null })
    } finally { await reader.query('ROLLBACK') }
    await insertEpoch()
    expect(await capture()).toMatchObject({ state: 'absent', sourcePointerRevision: expect.any(String) })
  })
  it('a direct epoch INSERT also holds the same source-table writer fence through commit', async () => {
    await writer.query('BEGIN')
    try {
      await writer.query(`INSERT INTO ${epochTable} (tenant_id,workspace_key,action_id,revision)
        VALUES ($1,'',$2,$3)`, [scope.tenantId, scope.actionId, randomUUID()])
      await expect(capture()).rejects.toMatchObject(unavailable)
      await writer.query('COMMIT')
      expect(await capture()).toMatchObject({ state: 'absent', sourcePointerRevision: expect.any(String) })
    } finally { await writer.query('ROLLBACK') }
  })
  it('up replay preserves live and deleted scope revisions, including never-bound absence', async () => {
    await set(); const before = await capture()
    await set(systemB, { actionId: 'synthetic-retired-action' })
    await admin.query(`DELETE FROM ${table} WHERE action_id='synthetic-retired-action'`)
    const material = await metadata()
    await migrate('up')
    expect(await capture()).toEqual(before)
    expect(await metadata()).toEqual(material)
    expect(await capture({ ...scope, actionId: 'synthetic-never-bound-action' })).toMatchObject({ state: 'absent', sourcePointerRevision: null })
  })
  it('up does not silently rewrite an existing inconsistent epoch', async () => {
    await set(); const before = await epoch()
    await admin.query(`ALTER TABLE ${epochTable} DISABLE TRIGGER USER`)
    try { await admin.query(`UPDATE ${epochTable} SET external_system_id='synthetic-conflict'`) }
    finally { await admin.query(`ALTER TABLE ${epochTable} ENABLE TRIGGER USER`) }
    await expect(migrate('up')).rejects.toThrow()
    expect((await epoch())?.revision).toBe(before?.revision)
    expect((await epoch())?.external_system_id).toBe('synthetic-conflict')
  })
  it('ordinary epoch CRUD cannot replay an old nonce or invent the mirrored system', async () => {
    await set(); const original = await capture()
    await set(systemB); const changed = await capture()
    await admin.query(`UPDATE ${epochTable} SET revision=$1::uuid,binding_id='synthetic-forged',external_system_id=$2`,
      [original.sourcePointerRevision, systemA])
    const after = await capture()
    expect(after.externalSystemId).toBe(systemB)
    expect(after.sourcePointerRowId).toBe(changed.sourcePointerRowId)
    expect(after.sourcePointerRevision).not.toBe(original.sourcePointerRevision)
    expect(after.sourcePointerRevision).not.toBe(changed.sourcePointerRevision)
    await admin.query(`INSERT INTO ${epochTable} (tenant_id,workspace_key,action_id,revision,binding_id,external_system_id)
      VALUES ($1,'','synthetic-unused-action',$2,'synthetic-forged',$3)`, [scope.tenantId, original.sourcePointerRevision, systemA])
    const absent = await capture({ ...scope, actionId: 'synthetic-unused-action' })
    expect(absent).toMatchObject({ state: 'absent', externalSystemId: null, sourcePointerRowId: null })
    expect(absent.sourcePointerRevision).not.toBe(original.sourcePointerRevision)
  })
  it.each([
    `DELETE FROM ${epochTable}`, `TRUNCATE ${epochTable}`, `TRUNCATE ${table}`,
    `UPDATE ${epochTable} SET action_id='synthetic-moved-epoch'`,
  ])('runtime cannot erase or move revision history with %s', async statement => {
    await set(); const before = await capture()
    await expect(admin.query(statement)).rejects.toMatchObject({ code: '55000' })
    expect(await capture()).toEqual(before)
  })
  it('empty-history down/up backfills existing 079 rows without changing the manual binding', async () => {
    await set(); const original = await store.get(scope)
    await migrate('down')
    expect(await store.get(scope)).toEqual(original)
    await expect(capture()).rejects.toMatchObject(unavailable)
    await migrate('up')
    expect(await store.get(scope)).toEqual(original)
    expect(await capture()).toMatchObject({ state: 'bound', externalSystemId: systemA })
  })
  it('retained grant history forbids down even behind an empty same-named table in search_path', async () => {
    await set(); await retainedGrant()
    const before = await capture()
    const decoy = `${schema}_decoy`
    await admin.query(`CREATE SCHEMA "${decoy}"`)
    try {
      await admin.query(`CREATE TABLE "${decoy}".integration_automation_read_grants (id uuid)`)
      await expect(migrationDb.transaction().execute(async trx => {
        await sql.raw(`SET LOCAL search_path = "${decoy}", "${schema}"`).execute(trx)
        await down(trx)
      })).rejects.toMatchObject({ code: '55000' })
      expect(await capture()).toEqual(before)
    } finally { await migrate('up'); await admin.query(`DROP SCHEMA "${decoy}" CASCADE`) }
  })
  it('down is NOWAIT behind a writer and leaves both authority relations intact', async () => {
    await set(); const before = await capture()
    await writer.query('BEGIN')
    try {
      await writer.query(`UPDATE ${table} SET updated_at=updated_at`)
      await expect(migrate('down')).rejects.toMatchObject({ code: '55P03' })
    } finally { await writer.query('ROLLBACK') }
    expect(await capture()).toEqual(before)
  })
})
