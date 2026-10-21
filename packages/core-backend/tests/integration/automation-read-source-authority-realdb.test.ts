/** SA-06I: real lockActiveForAutomation + PostgreSQL row locks and DB revisions.
 * Own synthetic metadata only. This is NOT the host facade, source execution,
 * complete authority provider, tenant membership proof or post-commit authority.
 * Uses actual 087/120000/121000/124000/131000 migrations. DS/EXT prerequisites below contain
 * precisely the columns their real revision triggers and this helper consume;
 * they intentionally do not claim full Connection/Binding registration or FK proof.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up as addSourceRevisions } from '../../src/db/migrations/zzzz20261001120001_stock_prep_validation_source_revisions'
import { up as addValidationLedger } from '../../src/db/migrations/zzzz20261001121000_stock_prep_read_plan_validation_ledger'
import { up as addSourcePointerRevision } from '../../src/db/migrations/zzzz20261001124000_stock_prep_source_pointer_revisions'
import { lockAutomationReadSourcePointer } from '../../src/integration/automation-read-source-pointer'
import { up as addAutomationSourceEpochs, down as removeAutomationSourceEpochs } from '../../src/db/migrations/zzzz20261001131000_stock_prep_automation_source_epochs'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECTED_DB must actually provide a database', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
type Row = Record<string, unknown>
type RawQuery = { query(sql: string, params?: unknown[]): Promise<unknown> }
type Version = { id: string; contentKey: string; validationId: string | null; status: string; config: Row }
type Activation = { id: string; generation: number; validationId: string; versionId: string; contentKey: string; status: string }
type Source = { connectionId: string; connectionRevision: string; bindingRevision: string }
type SourceAuthority = { versionRevision: string; receiptRevision: string; activationRevision: string; receipt: Row }
type Locked = { activation: Activation; version: Version; sourceValidation: Source; sourceAuthority: SourceAuthority }
type Receipt = { validationId: string; status: string }
type Store = {
  saveVersion(input: Row): Promise<Version>
  beginValidation(input: Row): Promise<Receipt>
  finishValidation(input: Row): Promise<Receipt>
  confirmValidation(input: Row): Promise<Receipt>
  approve(input: Row): Promise<Version>
  activate(input: Row): Promise<Activation>
  lockActiveForAutomation(queryable: RawQuery, input: Row): Promise<Locked>
}
const requirePlugin = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
const { createDb } = requirePlugin(path.join(pluginLib, 'db.cjs')) as {
  createDb(input: { database: RawQuery & { transaction<T>(callback: (trx: RawQuery) => Promise<T>): Promise<T> } }): unknown
}
const { createStockPreparationReadPlanStore } = requirePlugin(path.join(pluginLib, 'stock-preparation-read-plan-store.cjs')) as {
  createStockPreparationReadPlanStore(input: { db: unknown; now(): number; idGenerator(): string }): Store
}
const { createStockPreparationSourceBindingStore } = requirePlugin(path.join(pluginLib, 'stock-preparation-source-binding-store.cjs')) as {
  createStockPreparationSourceBindingStore(input: { db: unknown }): { set(input: Row): Promise<unknown> }
}
const { validateStockPreparationReadPlanConfig } = requirePlugin(path.join(pluginLib, 'stock-preparation-read-plan-config.cjs')) as {
  validateStockPreparationReadPlanConfig(input: unknown): Row
}
const extTable = 'integration_external_systems'
const mirrorTable = 'integration_data_source_validation_revisions'
const versionTable = 'integration_stock_prep_read_plan_versions'
const receiptTable = 'integration_stock_prep_read_plan_validations'
const pointerTable = 'integration_stock_prep_read_plan_activation'
const auditTable = 'integration_stock_prep_read_plan_audit'
const lockedTables = [extTable, mirrorTable, versionTable, receiptTable, pointerTable] as const
const tenantId = 'synthetic-tenant'
const actor = 'synthetic-current-owner'
const systemId = 'synthetic-system'
const connectionId = 'synthetic-connection'
const actionId = 'plm.stock-preparation.pull-bom.v1'
const scope = { tenantId, workspaceId: null }
const args = { ...scope, actor, actionId, systemId }
const sourceIneligible = 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE'
const sourceChanged = 'READ_PLAN_VALIDATION_SOURCE_CHANGED'

function config(): Row {
  const role = (object: string, fields: string[]) => ({ object, ...Object.fromEntries(fields.map(field => [field, field])) })
  return validateStockPreparationReadPlanConfig({ schemaVersion: 1, actionId, systemId,
    readPlan: { id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly',
      matchField: 'matchField', maxReadCount: 200,
      pathExAttr: role('SYN_PathLink', ['matchField', 'pathIdField']), pathInfo: role('SYN_Path', ['idField']),
      orderHead: role('SYN_Order', ['idField', 'pathIdField']),
      orderDetail: role('SYN_OrderLine', ['orderIdField', 'componentIdField', 'quantityField']),
      part: role('SYN_Part', ['idField']), bomHead: role('SYN_Bom', ['parentPartField', 'bomIdField']),
      bomDetail: role('SYN_BomLine', ['bomParentField', 'componentIdField', 'quantityField']),
    } })
}
async function fixedRejection(promise: Promise<unknown>, code: string) {
  const error: unknown = await promise.then(() => undefined, failure => failure)
  expect(error).toMatchObject({ name: 'StockPreparationReadPlanStoreError', code, message: code })
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('detail')
}

describeDatabase('Automation source prerequisite: real store validation chain and caller-owned PostgreSQL locks', () => {
  const schema = `automation_source_${randomBytes(8).toString('hex')}`
  let pool: Pool, migrationDb: Kysely<unknown>
  let admin: PoolClient, reader: PoolClient, writer: PoolClient, observer: PoolClient
  let schemaCreated = false
  let store: Store, version: Version, activation: Activation, proof: Receipt, source: Source
  let sourceBindingStore: { set(input: Row): Promise<unknown> }
  let sequence = 0
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  const statements: string[] = []
  const setupStatements: string[] = []
  const readerQuery: RawQuery = { async query(sql, params = []) { statements.push(sql); return reader.query(sql, params) } }
  async function readSource(): Promise<Source> {
    const binding = (await admin.query(`SELECT connection_id, validation_revision FROM ${extTable} WHERE id=$1`, [systemId])).rows[0]
    const mirror = (await admin.query(`SELECT validation_revision FROM ${mirrorTable} WHERE data_source_id=$1`, [connectionId])).rows[0]
    return { connectionId: binding.connection_id as string, bindingRevision: binding.validation_revision as string,
      connectionRevision: mirror.validation_revision as string }
  }
  async function confirmCurrentVersion() {
    source = await readSource()
    const validationInput = { ...scope, actor, id: version.id, source }
    proof = await store.beginValidation(validationInput)
    await store.finishValidation({ ...validationInput, validationId: proof.validationId,
      counts: { sampleCount: 2, readCount: 10, objectCount: 7 } })
    await store.confirmValidation({ ...validationInput, validationId: proof.validationId })
  }
  async function capture(input: Row = args, queryable: RawQuery = readerQuery) {
    statements.length = 0
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { return await store.lockActiveForAutomation(queryable, input) }
    finally { await reader.query('ROLLBACK') }
  }
  async function pid(client: PoolClient) { return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) }
  async function witnessBlocked(blocked: number, blocker: number, done: () => boolean) {
    let witnessed = false
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
      const result = await observer.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [blocked, blocker])
      if (result.rows[0]?.blocked === true) { witnessed = true; break }
      expect(done()).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    expect(witnessed).toBe(true)
    expect(done()).toBe(false)
  }
  async function metadataSnapshot() {
    const result: Row = {}
    for (const table of ['data_sources', ...lockedTables, auditTable]) {
      result[table] = (await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows
    }
    return result
  }
  beforeAll(async () => {
    if (!/^automation_source_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid synthetic schema')
    // The only allowed connection is supplied by the root's isolated PG runner.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, options: `-c search_path=${schema}` })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    await admin.query(`CREATE TABLE data_sources (
      id text PRIMARY KEY, config jsonb NOT NULL DEFAULT '{}', type text NOT NULL,
      owner_id text NOT NULL, tenant_id text, workspace_id text, scope_kind text NOT NULL,
      is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
      CREATE TABLE integration_external_systems (
      id text PRIMARY KEY, tenant_id text NOT NULL, workspace_id text, kind text NOT NULL,
      role text NOT NULL, status text NOT NULL, connection_id text, config jsonb NOT NULL DEFAULT '{}',
      credentials_encrypted text)`)
    await admin.query(readFileSync(path.resolve(__dirname, '../../migrations/089_create_integration_stock_prep_read_plan_versions.sql'), 'utf8'))
    await admin.query(readFileSync(path.resolve(__dirname, '../../migrations/079_create_integration_stock_prep_source_binding.sql'), 'utf8'))
    await addSourceRevisions(migrationDb)
    await addValidationLedger(migrationDb)
    await migrationDb.transaction().execute(addSourcePointerRevision)
    await migrationDb.transaction().execute(addAutomationSourceEpochs)
    reader = await pool.connect(); writer = await pool.connect(); observer = await pool.connect()
    for (const client of [admin, reader, writer, observer]) {
      await client.query("SET statement_timeout = '8s'")
      expect((await client.query('SELECT current_schema() AS schema')).rows).toEqual([{ schema }])
    }
    // Actual createDb only wraps this real SQL transport. This is not an injected
    // authorization callback or a fabricated host facade/Connection registration.
    const database = {
      async query(sql: string, params: unknown[] = []) { setupStatements.push(sql); return admin.query(sql, params) },
      async transaction<T>(callback: (trx: RawQuery) => Promise<T>): Promise<T> {
        await admin.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        try { const result = await callback(database); await admin.query('COMMIT'); return result }
        catch (error) { await admin.query('ROLLBACK'); throw error }
      },
    }
    store = createStockPreparationReadPlanStore({ db: createDb({ database }), now: () => clock,
      idGenerator: () => `synthetic-generated-${++sequence}` })
    sourceBindingStore = createStockPreparationSourceBindingStore({ db: createDb({ database }) })
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
    await admin.query(`ALTER TABLE integration_stock_prep_source_binding DISABLE TRIGGER USER;
      ALTER TABLE integration_stock_prep_source_pointer_revisions DISABLE TRIGGER USER`)
    try { await admin.query('TRUNCATE integration_stock_prep_source_binding, integration_stock_prep_source_pointer_revisions') }
    finally { await admin.query(`ALTER TABLE integration_stock_prep_source_binding ENABLE TRIGGER USER;
      ALTER TABLE integration_stock_prep_source_pointer_revisions ENABLE TRIGGER USER`) }
    await admin.query(`TRUNCATE ${pointerTable}, ${auditTable}, ${versionTable}, ${receiptTable},
      ${mirrorTable}, ${extTable}, data_sources`)
    sequence = 0
    clock = Date.parse('2026-10-01T00:00:00.000Z')
    await admin.query(`INSERT INTO data_sources (id,type,owner_id,tenant_id,workspace_id,scope_kind,is_active,config)
      VALUES ($1,'postgresql',$2,$3,NULL,'private',true,'{"syntheticRevisionInput":1}')`, [connectionId, actor, tenantId])
    await admin.query(`INSERT INTO ${extTable} (id,tenant_id,workspace_id,kind,role,status,connection_id,config)
      VALUES ($1,$2,NULL,'data-source:sql-readonly','source','active',$3,'{}')`, [systemId, tenantId, connectionId])
    version = await store.saveVersion({ ...scope, actor, config: config() })
    await confirmCurrentVersion()
    version = await store.approve({ ...scope, actor, id: version.id })
    activation = await store.activate({ ...scope, actor, id: version.id, expectedGeneration: 0 })
    statements.length = 0; setupStatements.length = 0
  })

  it('resolves every metadata relation to its own schema and uses actual DB revision triggers', async () => {
    for (const table of ['data_sources', ...lockedTables, auditTable]) {
      expect((await admin.query(`SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid=to_regclass($1)`, [table])).rows).toEqual([{ schema }])
    }
    const sourceRow = (await admin.query('SELECT validation_revision FROM data_sources WHERE id=$1', [connectionId])).rows[0]
    expect(source.connectionRevision).toBe(sourceRow.validation_revision)
    expect(source.connectionRevision).toMatch(/^[a-f0-9-]{36}$/u)
    expect(source.bindingRevision).toMatch(/^[a-f0-9-]{36}$/u)
    const triggers = (await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid IN ('data_sources'::regclass,
      'integration_external_systems'::regclass) AND NOT tgisinternal ORDER BY tgname`)).rows
    expect(triggers).toEqual([{ tgname: 'stock_prep_binding_validation_revision' },
      { tgname: 'stock_prep_source_validation_mirror' }, { tgname: 'stock_prep_source_validation_revision' }])
  })
  it('locks EXT → mirror → version → frozen receipt → pointer in the caller transaction without writes', async () => {
    const before = await metadataSnapshot()
    const loaded = await capture()
    expect(loaded.activation).toMatchObject({ id: activation.id, generation: 1, validationId: proof.validationId })
    expect(loaded.version).toMatchObject({ id: version.id, contentKey: version.contentKey, status: 'approved', config: config() })
    expect(loaded.sourceValidation).toEqual(source)
    expect(Object.isFrozen(loaded.sourceValidation)).toBe(true)
    expect(Object.keys(loaded).sort()).toEqual(['activation', 'sourceAuthority', 'sourceValidation', 'version'])
    expect(loaded.sourceAuthority.receipt).toMatchObject({ id: proof.validationId, actor, status: 'confirmed',
      connection_id: connectionId, connection_revision: source.connectionRevision, binding_revision: source.bindingRevision })
    expect(loaded.sourceAuthority.receipt.automation_authority_revision).toBe(loaded.sourceAuthority.receiptRevision)
    expect(Object.isFrozen(loaded.sourceAuthority)).toBe(true)
    expect(Object.isFrozen(loaded.sourceAuthority.receipt)).toBe(true)
    expect(Object.isFrozen(loaded.sourceAuthority.receipt.counts)).toBe(true)
    expect(statements.slice(0, 2).every(sql => sql.includes("current_setting('transaction_isolation')"))).toBe(true)
    expect(statements.slice(2).map(sql => `${sql.endsWith(' FOR UPDATE') ? 'lock' : 'hint'}:${/FROM "([a-z_]+)"/u.exec(sql)?.[1]}`))
      .toEqual([`hint:${pointerTable}`, ...lockedTables.map(table => `lock:${table}`)])
    expect(statements.some(sql => /\b(BEGIN|COMMIT|ROLLBACK|SET|INSERT|UPDATE|DELETE)\b/u.test(sql.replace(/ FOR UPDATE$/u, '')))).toBe(false)
    expect(statements.some(sql => /FROM "data_sources"/u.test(sql))).toBe(false)
    expect(setupStatements).toEqual([])
    expect(await metadataSnapshot()).toEqual(before)
  })
  it('also uses genuine PostgreSQL rows through the existing host-array result shape', async () => {
    expect((await capture(args, { async query(sql, params) { return (await reader.query(sql, params)).rows } })).sourceValidation).toEqual(source)
  })
  it('composes real active-source validation first, then the strict persisted action pointer on the same transaction', async () => {
    await sourceBindingStore.set({ ...scope, actionId, externalSystemId: systemId, actor })
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const active = await store.lockActiveForAutomation(readerQuery, args)
      const pointer = await lockAutomationReadSourcePointer(reader, { ...scope, actionId })
      expect(active.sourceValidation).toEqual(source)
      expect(active.version.id).toBe(version.id)
      expect(pointer).toMatchObject({ ...scope, actionId, state: 'bound', externalSystemId: systemId,
        sourcePointerRowId: expect.any(String), sourcePointerRevision: expect.any(String) })
      await writer.query('BEGIN')
      await expect(writer.query('LOCK TABLE integration_stock_prep_source_binding IN ROW EXCLUSIVE MODE NOWAIT'))
        .rejects.toMatchObject({ code: '55P03' })
    } finally { await writer.query('ROLLBACK'); await reader.query('ROLLBACK') }
  })
  it('retains its locks after helper return until caller rollback, but never locks the DS row itself', async () => {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await store.lockActiveForAutomation(readerQuery, args)
    await writer.query('BEGIN')
    try {
      expect((await writer.query('SELECT id FROM data_sources WHERE id=$1 FOR UPDATE NOWAIT', [connectionId])).rowCount).toBe(1)
      await expect(writer.query(`SELECT data_source_id FROM ${mirrorTable} WHERE data_source_id=$1 FOR UPDATE NOWAIT`, [connectionId]))
        .rejects.toMatchObject({ code: '55P03' })
    } finally { await writer.query('ROLLBACK'); await reader.query('ROLLBACK') }
    expect((await writer.query(`SELECT data_source_id FROM ${mirrorTable} WHERE data_source_id=$1 FOR UPDATE NOWAIT`, [connectionId])).rowCount).toBe(1)
  })
  it('accepts an expired frozen activation receipt when a newer pending validation is the version latest', async () => {
    const oldProof = proof.validationId
    clock += 60 * 60 * 1000
    const latest = await store.beginValidation({ ...scope, actor, id: version.id, source })
    expect(latest.validationId).not.toBe(oldProof)
    const loaded = await capture()
    expect(loaded.activation.validationId).toBe(oldProof)
    expect(loaded.version.validationId).toBe(latest.validationId)
    expect(loaded.sourceValidation).toEqual(source)
  })
  it.each(['postgres', 'postgresql', 'sqlserver'])('accepts current private active %s after real revalidation', async type => {
    await admin.query('UPDATE data_sources SET type=$1 WHERE id=$2', [type, connectionId])
    await confirmCurrentVersion()
    activation = await store.activate({ ...scope, actor, id: version.id, expectedGeneration: activation.generation })
    expect((await capture()).sourceValidation).toEqual(source)
  })
  it('accepts bidirectional readonly EXT only after revalidating its new binding revision', async () => {
    await admin.query(`UPDATE ${extTable} SET role='bidirectional' WHERE id=$1`, [systemId])
    await confirmCurrentVersion()
    await store.activate({ ...scope, actor, id: version.id, expectedGeneration: activation.generation })
    expect((await capture()).sourceValidation).toEqual(source)
  })
  it('rejects real autocommit and a forged transaction marker before metadata reads', async () => {
    await fixedRejection(store.lockActiveForAutomation(readerQuery, args), 'READ_PLAN_TRANSACTION_UNAVAILABLE')
    expect(statements).toHaveLength(2)
    expect(statements.every(sql => sql.includes('pg_current_xact_id'))).toBe(true)
    await fixedRejection(store.lockActiveForAutomation(Object.assign({ query: readerQuery.query }, { isTransaction: true }), args),
      'READ_PLAN_TRANSACTION_UNAVAILABLE')
  })
  it.each(['REPEATABLE READ', 'SERIALIZABLE'])('rejects real %s without changing isolation', async isolation => {
    await reader.query(`BEGIN ISOLATION LEVEL ${isolation}`)
    try {
      await fixedRejection(store.lockActiveForAutomation(readerQuery, args), 'READ_PLAN_TRANSACTION_UNAVAILABLE')
      expect(statements).toHaveLength(1)
      expect((await reader.query("SELECT current_setting('transaction_isolation') AS level")).rows[0].level).toBe(isolation.toLowerCase())
    } finally { await reader.query('ROLLBACK') }
  })
  it.each([
    [{ ...args, tenantId: 'foreign-tenant' }, 'READ_PLAN_ACTIVATION_NOT_FOUND'],
    [{ ...args, workspaceId: 'foreign-workspace' }, sourceIneligible],
    [{ ...args, actor: 'foreign-owner' }, sourceIneligible],
    [{ ...args, systemId: 'foreign-system' }, 'READ_PLAN_ACTIVATION_SOURCE_MISMATCH'],
  ])('does not switch trusted scope/actor/system for %j', async (input, code) => {
    await fixedRejection(capture(input as Row), code as string)
  })

  const sourceEdits: Array<[string, string, unknown[], string]> = [
    ['missing EXT', `DELETE FROM ${extTable} WHERE id=$1`, [systemId], sourceIneligible],
    ['EXT tenant', `UPDATE ${extTable} SET tenant_id='foreign-tenant' WHERE id=$1`, [systemId], sourceIneligible],
    ['EXT workspace', `UPDATE ${extTable} SET workspace_id='foreign-workspace' WHERE id=$1`, [systemId], sourceIneligible],
    ['EXT kind', `UPDATE ${extTable} SET kind='synthetic-other-kind' WHERE id=$1`, [systemId], sourceIneligible],
    ['EXT status', `UPDATE ${extTable} SET status='inactive' WHERE id=$1`, [systemId], sourceIneligible],
    ['EXT target role', `UPDATE ${extTable} SET role='target' WHERE id=$1`, [systemId], sourceIneligible],
    ['missing canonical binding', `UPDATE ${extTable} SET connection_id=NULL WHERE id=$1`, [systemId], sourceIneligible],
    ['legacy-id conflict', `UPDATE ${extTable} SET config='{"dataSourceId":"other-connection"}' WHERE id=$1`, [systemId], sourceIneligible],
    ['missing mirror', `DELETE FROM ${mirrorTable} WHERE data_source_id=$1`, [connectionId], sourceIneligible],
    ['live owner revoked', 'UPDATE data_sources SET owner_id=$1 WHERE id=$2', ['foreign-owner', connectionId], sourceIneligible],
    ['live tenant changed', 'UPDATE data_sources SET tenant_id=$1 WHERE id=$2', ['foreign-tenant', connectionId], sourceIneligible],
    ['live workspace', 'UPDATE data_sources SET workspace_id=$1 WHERE id=$2', ['foreign-workspace', connectionId], sourceIneligible],
    ['non-private source', "UPDATE data_sources SET scope_kind='workspace' WHERE id=$1", [connectionId], sourceIneligible],
    ['unsupported source type', "UPDATE data_sources SET type='mysql' WHERE id=$1", [connectionId], sourceIneligible],
    ['disabled source', 'UPDATE data_sources SET is_active=false WHERE id=$1', [connectionId], sourceIneligible],
    ['soft-deleted source', 'UPDATE data_sources SET deleted_at=now() WHERE id=$1', [connectionId], sourceIneligible],
    ['hard-deleted source tombstone', 'DELETE FROM data_sources WHERE id=$1', [connectionId], sourceIneligible],
    ['actual DS config revision', "UPDATE data_sources SET config=config || '{\"syntheticChanged\":true}' WHERE id=$1", [connectionId], sourceChanged],
    ['actual EXT config revision', `UPDATE ${extTable} SET config=config || '{"syntheticChanged":true}' WHERE id=$1`, [systemId], sourceChanged],
  ]
  it.each(sourceEdits)('fails closed after committed %s', async (_name, sql, params, code) => {
    await admin.query(sql, params)
    await fixedRejection(capture(), code)
  })
  it('current owner cannot borrow the old receipt actor after a real ownership transfer', async () => {
    await admin.query('UPDATE data_sources SET owner_id=$1 WHERE id=$2', ['new-synthetic-owner', connectionId])
    await fixedRejection(capture({ ...args, actor: 'new-synthetic-owner' }), 'READ_PLAN_VALIDATION_ACTOR_MISMATCH')
  })
  it('mirror omits config and credentials while retaining the current DB nonce', async () => {
    const mirror = (await admin.query(`SELECT * FROM ${mirrorTable} WHERE data_source_id=$1`, [connectionId])).rows[0]
    expect(Object.keys(mirror).sort()).toEqual(['connection_incarnation', 'data_source_id', 'deleted_at', 'is_active', 'owner_id', 'scope_kind',
      'tenant_id', 'type', 'validation_revision', 'workspace_id'])
    expect(mirror.validation_revision).toBe(source.connectionRevision)
  })
  it.each(['source', 'binding'])('DB %s revision does not accept a caller-supplied rollback nonce or change on no-op', async kind => {
    const table = kind === 'source' ? 'data_sources' : extTable
    const id = kind === 'source' ? connectionId : systemId
    await admin.query(`UPDATE ${table} SET validation_revision='11111111-1111-4111-8111-111111111111' WHERE id=$1`, [id])
    expect(await readSource()).toEqual(source)
    expect((await capture()).sourceValidation).toEqual(source)
  })
  it.each(['source', 'binding'])('DB %s content ABA does not resurrect the old receipt revision', async kind => {
    const table = kind === 'source' ? 'data_sources' : extTable
    const id = kind === 'source' ? connectionId : systemId
    const original = (await admin.query(`SELECT config FROM ${table} WHERE id=$1`, [id])).rows[0].config
    await admin.query(`UPDATE ${table} SET config=config || '{"syntheticABA":true}' WHERE id=$1`, [id])
    await admin.query(`UPDATE ${table} SET config=$1::jsonb WHERE id=$2`, [JSON.stringify(original), id])
    const current = await readSource()
    expect(kind === 'source' ? current.connectionRevision : current.bindingRevision)
      .not.toBe(kind === 'source' ? source.connectionRevision : source.bindingRevision)
    await fixedRejection(capture(), sourceChanged)
  })
  it('DS delete/recreate keeps a tombstone then mints a different incarnation revision', async () => {
    await admin.query('DELETE FROM data_sources WHERE id=$1', [connectionId])
    const tombstone = (await admin.query(`SELECT * FROM ${mirrorTable} WHERE data_source_id=$1`, [connectionId])).rows[0]
    expect(tombstone.is_active).toBe(false)
    expect(tombstone.deleted_at).not.toBeNull()
    expect(tombstone.validation_revision).not.toBe(source.connectionRevision)
    await admin.query(`INSERT INTO data_sources (id,type,owner_id,tenant_id,scope_kind,is_active)
      VALUES ($1,'postgresql',$2,$3,'private',true)`, [connectionId, actor, tenantId])
    expect((await readSource()).connectionRevision).not.toBe(source.connectionRevision)
    await fixedRejection(capture(), sourceChanged)
  })

  const versionEdits: Array<[string, string, string]> = [
    ['changed stored config', `config=jsonb_set(config,'{readPlan,part,object}','"SYN_Changed"')`, 'READ_PLAN_CONTENT_INVALID'],
    ['noncanonical stored config', `config=jsonb_set(config,'{readPlan,part,object}','" SYN_Part "')`, 'READ_PLAN_CONTENT_INVALID'],
    ['stored content digest', `content_key=repeat('0',64)`, 'READ_PLAN_CONTENT_INVALID'],
    ['retired version', `status='retired'`, 'READ_PLAN_NOT_APPROVED'],
    ['draft version', `status='draft'`, 'READ_PLAN_NOT_APPROVED'],
    ['foreign version tenant', `tenant_id='foreign-tenant'`, 'READ_PLAN_ACTIVATION_INVALID'],
    ['foreign version workspace', `workspace_id='foreign-workspace'`, 'READ_PLAN_ACTIVATION_INVALID'],
  ]
  it.each(versionEdits)('refuses %s through the real version validator', async (_name, set, code) => {
    await admin.query(`UPDATE ${versionTable} SET ${set} WHERE id=$1`, [version.id])
    await fixedRejection(capture(), code)
  })
  const receiptEdits: Array<[string, string, string]> = [
    ['receipt actor', `actor='foreign-owner'`, 'READ_PLAN_VALIDATION_ACTOR_MISMATCH'],
    ['receipt tenant', `tenant_id='foreign-tenant'`, 'READ_PLAN_VALIDATION_INVALID'],
    ['receipt system', `system_id='foreign-system'`, 'READ_PLAN_VALIDATION_INVALID'],
    ['receipt content', `content_key=repeat('0',64)`, 'READ_PLAN_VALIDATION_INVALID'],
    ['receipt connection', `connection_id='foreign-connection'`, sourceChanged],
    ['receipt connection revision', `connection_revision=gen_random_uuid()`, sourceChanged],
    ['receipt binding revision', `binding_revision=gen_random_uuid()`, sourceChanged],
    ['unconfirmed passed receipt', `status='passed',confirmed_at=NULL`, 'READ_PLAN_VALIDATION_REQUIRED'],
    ['failed receipt', `status='failed',counts=NULL,confirmed_at=NULL`, 'READ_PLAN_VALIDATION_REQUIRED'],
  ]
  it.each(receiptEdits)('refuses legal-DDL tampering of %s', async (_name, set, code) => {
    await admin.query(`UPDATE ${receiptTable} SET ${set} WHERE id=$1`, [proof.validationId])
    await fixedRejection(capture(), code)
  })
  it.each([
    ['missing frozen receipt', `validation_id=NULL`, 'READ_PLAN_VALIDATION_REQUIRED'],
    ['disabled pointer', `status='disabled'`, 'READ_PLAN_ACTIVATION_DISABLED'],
    ['pointer/version content mismatch', `content_key=repeat('0',64)`, 'READ_PLAN_ACTIVATION_INVALID'],
    ['pointer source mismatch', `system_id='foreign-system'`, 'READ_PLAN_ACTIVATION_SOURCE_MISMATCH'],
  ])('refuses %s before exposing source facts', async (_name, set, code) => {
    await admin.query(`UPDATE ${pointerTable} SET ${set} WHERE id=$1`, [activation.id])
    await fixedRejection(capture(), code)
  })
  it('refuses a physically missing pointer', async () => {
    await admin.query(`DELETE FROM ${pointerTable}`)
    await fixedRejection(capture(), 'READ_PLAN_ACTIVATION_NOT_FOUND')
  })
  it('actual receipt DDL independently rejects invalid count/time shapes', async () => {
    await expect(admin.query(`UPDATE ${receiptTable} SET counts='{"sampleCount":0,"readCount":1,"objectCount":1}' WHERE id=$1`, [proof.validationId]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(admin.query(`UPDATE ${receiptTable} SET expires_at=begun_at+interval '16 minutes' WHERE id=$1`, [proof.validationId]))
      .rejects.toMatchObject({ code: '23514' })
    expect((await capture()).sourceValidation).toEqual(source)
  })
  it.each(lockedTables)('missing %s schema is a fixed unavailable error, never a compatibility fallback', async table => {
    await admin.query(`ALTER TABLE ${table} RENAME TO hidden_source_fixture_table`)
    try { await fixedRejection(capture(), 'READ_PLAN_VALIDATION_UNAVAILABLE') }
    finally { await admin.query(`ALTER TABLE hidden_source_fixture_table RENAME TO ${table}`) }
  })

  const races: Array<[string, string, () => unknown[], string]> = [
    ['EXT revision update', `UPDATE ${extTable} SET config=config || '{"syntheticRace":true}' WHERE id=$1`, () => [systemId], sourceChanged],
    ['EXT delete', `DELETE FROM ${extTable} WHERE id=$1`, () => [systemId], sourceIneligible],
    ['mirror ownership update', `UPDATE ${mirrorTable} SET owner_id='foreign-owner' WHERE data_source_id=$1`, () => [connectionId], sourceIneligible],
    ['version retirement', `UPDATE ${versionTable} SET status='retired' WHERE id=$1`, () => [version.id], 'READ_PLAN_NOT_APPROVED'],
    ['frozen receipt actor update', `UPDATE ${receiptTable} SET actor='foreign-owner' WHERE id=$1`, () => [proof.validationId], 'READ_PLAN_VALIDATION_ACTOR_MISMATCH'],
    ['activation disable', `UPDATE ${pointerTable} SET status='disabled',generation=generation+1 WHERE id=$1`, () => [activation.id], 'READ_PLAN_ACTIVATION_DISABLED'],
    ['DS trigger mirror update', `UPDATE data_sources SET config=config || '{"syntheticRace":true}' WHERE id=$1`, () => [connectionId], sourceChanged],
    ['DS trigger delete tombstone', 'DELETE FROM data_sources WHERE id=$1', () => [connectionId], sourceIneligible],
  ]
  it.each(races)('pg_blocking_pids proves %s waits after helper return until caller COMMIT', async (_name, sql, params, nextCode) => {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    expect((await store.lockActiveForAutomation(readerQuery, args)).sourceValidation).toEqual(source)
    await writer.query('BEGIN')
    const readerPid = await pid(reader), writerPid = await pid(writer)
    let done = false
    const pending = writer.query(sql, params()).then(result => { done = true; return result }, error => { done = true; throw error })
    void pending.catch(() => {})
    try {
      await witnessBlocked(writerPid, readerPid, () => done)
      await reader.query('COMMIT')
      expect((await pending).rowCount).toBe(1)
      await writer.query('COMMIT')
      await fixedRejection(capture(), nextCode)
    } finally {
      await reader.query('ROLLBACK')
      await pending.catch(() => {})
      await writer.query('ROLLBACK')
    }
  })
  it.each(races.filter(([name]) => !name.includes('delete')))('writer-first %s is reread after a real lock wait, not accepted from stale state', async (name, sql, params, nextCode) => {
    await writer.query('BEGIN')
    expect((await writer.query(sql, params())).rowCount).toBe(1)
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const readerPid = await pid(reader), writerPid = await pid(writer)
    let done = false
    const pending = store.lockActiveForAutomation(readerQuery, args).then(result => { done = true; return result }, error => { done = true; throw error })
    void pending.catch(() => {})
    try {
      await witnessBlocked(readerPid, writerPid, () => done)
      await writer.query('COMMIT')
      await fixedRejection(pending, name === 'activation disable' ? 'READ_PLAN_GENERATION_CONFLICT' : nextCode)
    } finally {
      await writer.query('ROLLBACK')
      await pending.catch(() => {})
      await reader.query('ROLLBACK')
    }
  })
  it.each([
    ['generation advance', 'generation=3'], ['generation regression', 'generation=1'],
    ['pointer replacement', "id='synthetic-replacement-pointer'"], ['disable', "status='disabled'"],
    ['frozen receipt removed', 'validation_id=NULL'], ['content change', "content_key=repeat('0',64)"],
    ['system change', "system_id='foreign-system'"], ['tenant move', "tenant_id='foreign-tenant'"],
    ['workspace move', "workspace_id='foreign-workspace'"],
  ])('rejects real %s committed after the unlocked pointer hint', async (_name, set) => {
    await admin.query(`UPDATE ${pointerTable} SET generation=2 WHERE id=$1`, [activation.id])
    let hints = 0
    const interleaved: RawQuery = { async query(sql, params) {
      const result = await reader.query(sql, params)
      if (hints === 0 && sql.includes(`FROM "${pointerTable}"`) && !sql.endsWith(' FOR UPDATE')) {
        hints += 1
        expect((await writer.query(`UPDATE ${pointerTable} SET ${set} WHERE id=$1`, [activation.id])).rowCount).toBe(1)
      }
      return result
    } }
    await fixedRejection(capture(args, interleaved), 'READ_PLAN_GENERATION_CONFLICT')
    expect(hints).toBe(1)
  })
  it('rejects pointer deletion committed after the unlocked hint', async () => {
    let hints = 0
    const interleaved: RawQuery = { async query(sql, params) {
      const result = await reader.query(sql, params)
      if (hints === 0 && sql.includes(`FROM "${pointerTable}"`) && !sql.endsWith(' FOR UPDATE')) {
        hints += 1
        expect((await writer.query(`DELETE FROM ${pointerTable} WHERE id=$1`, [activation.id])).rowCount).toBe(1)
      }
      return result
    } }
    await fixedRejection(capture(args, interleaved), 'READ_PLAN_GENERATION_CONFLICT')
    expect(hints).toBe(1)
  })

  const authorityTables = [versionTable, receiptTable, pointerTable] as const
  async function authorityRevisions(): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all(authorityTables.map(async table => {
      const rows = (await admin.query(`SELECT automation_authority_revision::text AS revision FROM ${table}`)).rows
      expect(rows).toHaveLength(1)
      expect(rows[0].revision).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)
      return [table, rows[0].revision]
    })))
  }
  it('returns the three actual DB epochs and the complete checked frozen receipt, not a reconstructed id proof', async () => {
    const expected = await authorityRevisions()
    const loaded = await capture()
    expect(loaded.sourceAuthority).toMatchObject({ versionRevision: expected[versionTable],
      receiptRevision: expected[receiptTable], activationRevision: expected[pointerTable] })
    const receipt = loaded.sourceAuthority.receipt
    const actual = (await admin.query(`SELECT to_jsonb(r) AS receipt FROM ${receiptTable} r`)).rows[0].receipt
    expect(Object.keys(receipt).sort()).toEqual(Object.keys(actual).sort())
    expect(receipt.counts).toEqual({ sampleCount: 2, readCount: 10, objectCount: 7 })
    for (const key of ['begun_at', 'expires_at', 'finished_at', 'confirmed_at']) {
      expect(receipt[key]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u)
      expect(Date.parse(String(receipt[key]))).toBe(Date.parse(actual[key]))
    }
    expect(loaded.version).not.toHaveProperty('automation_authority_revision')
    expect(loaded.activation).not.toHaveProperty('automation_authority_revision')
  })
  it.each(authorityTables)('database nonce ignores caller replay and real no-op on %s', async table => {
    const before = await authorityRevisions()
    await admin.query(`UPDATE ${table} SET id=id, automation_authority_revision='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)
    expect(await authorityRevisions()).toEqual(before)
  })
  it.each([
    [versionTable, "updated_by='synthetic-other'", 'updated_by=$1', actor],
    [receiptTable, `counts=jsonb_set(counts,'{sampleCount}','3')`, 'counts=$1::jsonb', JSON.stringify({ sampleCount: 2, readCount: 10, objectCount: 7 })],
    [pointerTable, 'generation=2', 'generation=$1', 1],
  ])('real %s A→B→A cannot resurrect an older grant identity', async (table, change, restore, original) => {
    const before = await authorityRevisions()
    const originalAuthority = (await capture()).sourceAuthority
    await admin.query(`UPDATE ${table} SET ${change}`)
    const middle = await authorityRevisions()
    expect(middle[table]).not.toBe(before[table])
    await admin.query(`UPDATE ${table} SET ${restore}`, [original])
    const after = await authorityRevisions()
    expect(after[table]).not.toBe(middle[table])
    expect(after[table]).not.toBe(before[table])
    expect((await capture()).sourceAuthority).not.toEqual(originalAuthority)
    for (const untouched of authorityTables.filter(candidate => candidate !== table)) expect(after[untouched]).toBe(before[untouched])
  })
  it('same-id deletion/recreation of the full real FK chain mints three fresh epochs even with old supplied nonces', async () => {
    const before = await authorityRevisions()
    const saved = Object.fromEntries(await Promise.all(authorityTables.map(async table =>
      [table, (await admin.query(`SELECT to_jsonb(r) AS row FROM ${table} r`)).rows[0].row])))
    await admin.query('BEGIN')
    try {
      await admin.query(`DELETE FROM ${pointerTable}; DELETE FROM ${auditTable}; UPDATE ${versionTable} SET validation_id=NULL;
        DELETE FROM ${receiptTable}; DELETE FROM ${versionTable}`)
      await admin.query(`INSERT INTO ${versionTable} SELECT * FROM jsonb_populate_record(NULL::${versionTable},$1::jsonb)`,
        [JSON.stringify({ ...saved[versionTable], validation_id: null })])
      await admin.query(`INSERT INTO ${receiptTable} SELECT * FROM jsonb_populate_record(NULL::${receiptTable},$1::jsonb)`, [JSON.stringify(saved[receiptTable])])
      await admin.query(`UPDATE ${versionTable} SET validation_id=$1`, [saved[versionTable].validation_id])
      await admin.query(`INSERT INTO ${pointerTable} SELECT * FROM jsonb_populate_record(NULL::${pointerTable},$1::jsonb)`, [JSON.stringify(saved[pointerTable])])
      await admin.query('COMMIT')
    } catch (error) { await admin.query('ROLLBACK'); throw error }
    const after = await authorityRevisions()
    for (const table of authorityTables) expect(after[table]).not.toBe(before[table])
    expect((await capture()).sourceValidation).toEqual(source)
  })
  it('preserves microseconds from the actual checked receipt and ignores session timezone', async () => {
    await admin.query(`UPDATE ${receiptTable} SET confirmed_at=finished_at+interval '1 microsecond'`)
    await reader.query("SET TIME ZONE 'Asia/Tokyo'")
    try {
      const one = (await capture()).sourceAuthority.receipt
      expect(String(one.confirmed_at)).toMatch(/\.000001Z$/u)
      await admin.query(`UPDATE ${receiptTable} SET confirmed_at=finished_at+interval '2 microseconds'`)
      const two = (await capture()).sourceAuthority.receipt
      expect(String(two.confirmed_at)).toMatch(/\.000002Z$/u)
      expect(one.automation_authority_revision).not.toBe(two.automation_authority_revision)
    } finally { await reader.query("SET TIME ZONE 'UTC'") }
  })
  it.each(authorityTables)('missing Automation nonce column in %s fails closed only in the private path', async table => {
    await admin.query(`ALTER TABLE ${table} RENAME COLUMN automation_authority_revision TO hidden_automation_revision`)
    try {
      await fixedRejection(capture(), 'READ_PLAN_VALIDATION_UNAVAILABLE')
    } finally { await admin.query(`ALTER TABLE ${table} RENAME COLUMN hidden_automation_revision TO automation_authority_revision`) }
  })
  it('empty-history down/up backfills fresh identities without changing ordinary source content', async () => {
    const before = await authorityRevisions()
    await migrationDb.transaction().execute(removeAutomationSourceEpochs)
    await migrationDb.transaction().execute(addAutomationSourceEpochs)
    const after = await authorityRevisions()
    for (const table of authorityTables) expect(after[table]).not.toBe(before[table])
    expect((await capture()).version.config).toEqual(config())
  })
  it('retained same-schema grant history refuses rollback before deleting any nonce', async () => {
    await admin.query('CREATE TABLE integration_automation_read_grants (id text PRIMARY KEY)')
    try {
      await admin.query("INSERT INTO integration_automation_read_grants VALUES ('synthetic-retained-grant')")
      const before = await authorityRevisions()
      await expect(migrationDb.transaction().execute(removeAutomationSourceEpochs))
        .rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_SOURCE_EPOCH_HISTORY_ROLLBACK_FORBIDDEN' })
      expect(await authorityRevisions()).toEqual(before)
    } finally { await admin.query('DROP TABLE integration_automation_read_grants') }
  })
  it('rollback never waits in reverse order behind a source writer', async () => {
    await writer.query('BEGIN')
    try {
      await writer.query(`UPDATE ${versionTable} SET id=id`)
      await expect(migrationDb.transaction().execute(removeAutomationSourceEpochs))
        .rejects.toMatchObject({ code: '55P03', message: 'AUTOMATION_SOURCE_EPOCH_MIGRATION_BUSY' })
    } finally { await writer.query('ROLLBACK') }
    expect((await capture()).sourceValidation).toEqual(source)
  })
})
