/** SA-06M: owned PostgreSQL, real source triggers and private target composition.
 * No customer DB, Connection/source authorization, JWT, consumer or registration. */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up, down } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'
import { up as addRegistry } from '../../src/db/migrations/zzzz20260408123000_create_plugin_multitable_object_registry'
import { up as addProfiles } from '../../src/db/migrations/zzzz20261001125000_automation_read_profiles'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { lockAutomationReadMaterialEpochs } from '../../src/integration/automation-read-material-epochs'
import { loadAutomationReadInstalledMaterial } from '../../src/integration/automation-read-installed-material'
import { activateAutomationReadProfiles, type PreparedAutomationReadProfile } from '../../src/integration/automation-read-profiles'
import { createAutomationReadTargetContext } from '../../src/integration/automation-read-target-context'
import { loadAutomationReadTargetRecords } from '../../src/integration/automation-read-target-records'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies a real database', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const lib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
const plugin = createRequire(import.meta.url)
const { prepareStockPreparationAutomationProfiles: prepare, restoreStockPreparationAutomationProfileMaterial: restore } =
  plugin(path.join(lib, 'stock-preparation-automation-profile.cjs'))
const { deriveAutomationReadTargetContract: derive } = plugin(path.join(lib, 'stock-preparation-automation-target-contract.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: template } = plugin(path.join(lib, 'stock-preparation-templates.cjs'))
const { FACTORY_A_REHEARSAL_PACK: rawPack } = plugin(path.join(lib, 'customer-packs/factory-a.rehearsal.cjs'))
const { normalizeCustomerPack } = plugin(path.join(lib, 'stock-preparation-customer-pack.cjs'))
const { __internals: { buildExtensionFieldProperty } } = plugin(path.join(lib, 'stock-preparation-customer-pack-installer.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID: actionId, __internals: { readExistingStockPreparationRows } } =
  plugin(path.join(lib, 'stock-preparation-table-actions.cjs'))
type Field = { id: string; ownership: string; preserveOnRefresh: boolean }
const pack = normalizeCustomerPack(rawPack) as { packId: string; targetObjectId: string; extensionFields: Field[] }
const tenantId = 'synthetic-tenant', projectId = 'synthetic-project', sheetId = 'synthetic-sheet'
const baseId = 'synthetic-base-not-project', objectId = pack.targetObjectId, actorId = 'synthetic-actor'
const input = { tenantId, workspaceId: null, projectId, objectId, sheetId } as const
const packScope = { tenantId, projectId, objectId }
const allSourceTables = 'meta_bases, meta_sheets, meta_fields, plugin_multitable_object_registry, integration_stock_prep_pack_installs'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

describeDb('Automation target material: persistent ABA epochs and real composition', () => {
  const schema = 'automation_material_' + randomBytes(8).toString('hex')
  let pool: Pool, db: Kysely<unknown>, admin: PoolClient, reader: PoolClient, writer: PoolClient, observer: PoolClient
  let created = false
  async function tx<T>(client: PoolClient, work: (trx: PoolClient) => Promise<T>): Promise<T> {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { const value = await work(client); await client.query('COMMIT'); return value }
    catch (error) { await client.query('ROLLBACK'); throw error }
  }
  async function capture(candidate: typeof input = input) { return tx(reader, trx => lockAutomationReadMaterialEpochs(trx, candidate)) }
  async function epoch(kind: string, scope: object) {
    return (await admin.query('SELECT revision::text AS revision FROM automation_read_material_epochs WHERE kind=$1 AND scope=$2::jsonb',
      [kind, JSON.stringify(scope)])).rows[0]?.revision ?? null
  }
  async function insertPack(id = 'synthetic-pack', fields: unknown = []) {
    await admin.query('INSERT INTO integration_stock_prep_pack_installs '
      + '(id,tenant_id,project_id,object_id,pack_id,pack_version,mode,status,installed_fields_json) '
      + "VALUES ($1,$2,$3,$4,$5,'1','install','installed',$6::jsonb)",
    [id, tenantId, projectId, objectId, pack.packId, JSON.stringify(fields)])
  }
  async function original(table: string, key: string, value: string) {
    return (await admin.query('SELECT to_jsonb(t) AS row FROM ' + table + ' t WHERE ' + key + '=$1', [value])).rows[0].row
  }
  async function restoreRow(table: string, row: unknown) {
    await admin.query('INSERT INTO ' + table + ' SELECT * FROM jsonb_populate_record(NULL::' + table + ',$1::jsonb)', [JSON.stringify(row)])
  }
  async function pid(client: PoolClient) { return Number((await client.query('SELECT pg_backend_pid() AS id')).rows[0].id) }
  async function blockedWrite(statement: string) {
    await reader.query('BEGIN')
    await lockAutomationReadMaterialEpochs(reader, input)
    await writer.query('BEGIN')
    const blocker = await pid(reader), blocked = await pid(writer)
    let done = false
    const pending = writer.query(statement).then(result => { done = true; return result })
    void pending.catch(() => {})
    try {
      let witnessed = false
      for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
        const check = await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [blocked, blocker])
        if (check.rows[0]?.blocked) { witnessed = true; break }
        expect(done).toBe(false)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(witnessed).toBe(true)
      await reader.query('COMMIT')
      await pending
      await writer.query('COMMIT')
    } finally {
      await reader.query('ROLLBACK')
      await pending.catch(() => {})
      await writer.query('ROLLBACK')
    }
  }
  beforeAll(async () => {
    if (!/^automation_material_[a-f0-9]{16}$/u.test(schema)) throw new Error('Unowned fixture')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6,
      options: '-c search_path=' + schema + ' -c statement_timeout=8000' })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true
    // Minimal source/ACL fixture with production sheet/base/field FK actions.
    // Registry, pack ledger, profiles, read ledger and epochs use actual migrations.
    await admin.query([
      'CREATE TABLE users (id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text)',
      'CREATE TABLE user_roles (user_id text,role_id text)',
      'CREATE TABLE user_permissions (user_id text,permission_code text)',
      'CREATE TABLE role_permissions (role_id text,permission_code text)',
      'CREATE TABLE user_orgs (user_id text,org_id text,is_active boolean)',
      'CREATE TABLE user_namespace_admissions (user_id text,namespace text,enabled boolean)',
      'CREATE TABLE platform_member_group_members (user_id text,group_id uuid)',
      'CREATE TABLE spreadsheet_permissions (sheet_id text,subject_type text,subject_id text,perm_code text)',
      'CREATE TABLE field_permissions (sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean)',
      'CREATE TABLE record_permissions (sheet_id text,record_id text,subject_type text,subject_id text,access_level text)',
      "CREATE TABLE meta_bases (id text PRIMARY KEY,name text NOT NULL DEFAULT 'SYN',deleted_at timestamptz)",
      'CREATE TABLE meta_sheets (id text PRIMARY KEY,base_id text REFERENCES meta_bases(id) ON DELETE SET NULL,'
        + "name text NOT NULL DEFAULT 'SYN',deleted_at timestamptz,row_level_read_permissions_enabled boolean NOT NULL DEFAULT false)",
      'CREATE TABLE meta_fields (id text PRIMARY KEY,sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,'
        + "name text NOT NULL,type text NOT NULL,property jsonb NOT NULL DEFAULT '{}',\"order\" integer NOT NULL DEFAULT 0,"
        + 'created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())',
      "CREATE TABLE meta_records (id text PRIMARY KEY,sheet_id text NOT NULL,data jsonb NOT NULL DEFAULT '{}',"
        + 'created_by text,modified_by text,created_at timestamptz,updated_at timestamptz)',
    ].join(';'))
    await db.transaction().execute(addRegistry)
    await admin.query(readFileSync(path.resolve(__dirname, '../../migrations/076_create_integration_stock_prep_pack_installs.sql'), 'utf8'))
    await db.transaction().execute(addProfiles)
    await db.transaction().execute(addLedger)
    await db.transaction().execute(up)
    reader = await pool.connect(); writer = await pool.connect(); observer = await pool.connect()
  })
  afterAll(async () => {
    for (const client of [reader, writer, observer]) if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE')
      admin.release()
    }
    if (db) await db.destroy(); else await pool?.end()
  })
  beforeEach(async () => {
    for (const client of [admin, reader, writer, observer]) await client.query('ROLLBACK')
    // Test-owned superuser reset only; actual tests use live triggers.
    const protectedTables = ['automation_read_material_epochs', 'automation_read_producer_slot',
      'automation_read_target_profiles', 'automation_read_target_bindings']
    for (const table of protectedTables) await admin.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER')
    try {
      await admin.query('TRUNCATE ' + allSourceTables + ', meta_records, users, user_roles, user_permissions, role_permissions,'
        + 'user_orgs,user_namespace_admissions,platform_member_group_members,spreadsheet_permissions,field_permissions,record_permissions,'
        + 'automation_read_material_epochs,automation_read_target_profiles,automation_read_target_bindings,'
        + 'integration_automation_read_requests,integration_automation_read_grants')
      await admin.query('UPDATE automation_read_producer_slot SET generation=0,nonce=NULL,expires_at=NULL')
    } finally { for (const table of protectedTables) await admin.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER') }
    await admin.query("INSERT INTO users VALUES ($1,'admin','[]',true,'activated')", [actorId])
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [actorId, tenantId])
    await admin.query("INSERT INTO user_permissions VALUES ($1,'multitable:read')", [actorId])
    await admin.query('INSERT INTO meta_bases(id) VALUES ($1)', [baseId])
    await admin.query('INSERT INTO meta_sheets(id,base_id) VALUES ($1,$2)', [sheetId, baseId])
    await admin.query('INSERT INTO plugin_multitable_object_registry(sheet_id,project_id,object_id,plugin_name)'
      + " VALUES ($1,$2,$3,'plugin-integration-core')", [sheetId, projectId, objectId])
    await admin.query("INSERT INTO meta_fields(id,sheet_id,name,type) VALUES ('synthetic-field',$1,'SYN','string')", [sheetId])
  })
  it('captures actual base, frozen live epochs and explicit never-seen pack absence', async () => {
    const value = await capture()
    expect(value.baseId).toBe(baseId)
    expect(value.baseId).not.toBe(projectId)
    expect(value.revisions.sheet).toMatch(uuid)
    expect(value.revisions.base).toMatch(uuid)
    expect(value.revisions.pack).toBeNull()
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.revisions)).toBe(true)
  })
  it('pack empty → insert → delete → empty retains a non-null tombstone', async () => {
    const empty = await capture()
    await insertPack()
    const present = await capture()
    await admin.query('DELETE FROM integration_stock_prep_pack_installs')
    const absent = await capture()
    expect(empty.revisions.pack).toBeNull()
    expect(present.revisions.pack).toMatch(uuid)
    expect(absent.revisions.pack).toMatch(uuid)
    expect(absent.revisions.pack).not.toBe(present.revisions.pack)
  })
  const changes = [
    ['meta_fields', 'name', 'synthetic-field', 'sheet', 'id'],
    ['plugin_multitable_object_registry', 'plugin_name', sheetId, 'sheet', 'sheet_id'],
    ['meta_sheets', 'name', sheetId, 'sheet', 'id'],
    ['meta_bases', 'name', baseId, 'base', 'id'],
    ['integration_stock_prep_pack_installs', 'summary_json', 'synthetic-pack', 'pack', 'id'],
  ] as const
  it.each(changes)('%s real A→B→A cannot restore its old epoch', async (table, column, key, kind, keyColumn) => {
    await insertPack()
    const row = await original(table, keyColumn, key), before = await capture()
    const changed = column === 'summary_json' ? JSON.stringify({ synthetic: true }) : 'synthetic-changed'
    await admin.query('UPDATE ' + table + ' SET ' + column + '=$1 WHERE ' + keyColumn + '=$2', [changed, key])
    const intermediate = await capture()
    await admin.query('UPDATE ' + table + ' SET ' + column + '=$1 WHERE ' + keyColumn + '=$2',
      [column === 'summary_json' ? JSON.stringify(row[column]) : row[column], key])
    const after = await capture()
    expect(await original(table, keyColumn, key)).toEqual(row)
    expect(intermediate.revisions[kind]).not.toBe(before.revisions[kind])
    expect(after.revisions[kind]).not.toBe(before.revisions[kind])
    expect(after.revisions[kind]).not.toBe(intermediate.revisions[kind])
  })
  it.each(changes)('%s true full-row no-op preserves its epoch', async (table, column, key, kind, keyColumn) => {
    await insertPack()
    const before = await capture()
    await admin.query('UPDATE ' + table + ' SET ' + column + '=' + column + ' WHERE ' + keyColumn + '=$1', [key])
    expect((await capture()).revisions[kind]).toBe(before.revisions[kind])
  })
  it.each([
    ['meta_fields', 'id', 'synthetic-field', 'sheet'],
    ['plugin_multitable_object_registry', 'sheet_id', sheetId, 'sheet'],
    ['integration_stock_prep_pack_installs', 'id', 'synthetic-pack', 'pack'],
  ] as const)('%s same-id delete/recreate retains incarnation change', async (table, keyColumn, key, kind) => {
    await insertPack()
    const row = await original(table, keyColumn, key), before = await capture()
    await admin.query('DELETE FROM ' + table + ' WHERE ' + keyColumn + '=$1', [key])
    await restoreRow(table, row)
    expect(await original(table, keyColumn, key)).toEqual(row)
    expect((await capture()).revisions[kind]).not.toBe(before.revisions[kind])
  })
  it('sheet hard deletion cascades fields/registry but not its epoch tombstone', async () => {
    const rows = await Promise.all([original('meta_sheets', 'id', sheetId), original('meta_fields', 'id', 'synthetic-field'),
      original('plugin_multitable_object_registry', 'sheet_id', sheetId)])
    const before = await capture()
    await admin.query('DELETE FROM meta_sheets WHERE id=$1', [sheetId])
    expect((await admin.query('SELECT * FROM meta_fields')).rows).toHaveLength(0)
    expect((await admin.query('SELECT * FROM plugin_multitable_object_registry')).rows).toHaveLength(0)
    expect(await epoch('sheet', { id: sheetId })).toMatch(uuid)
    await expect(capture()).rejects.toBeDefined()
    for (const [index, table] of ['meta_sheets', 'meta_fields', 'plugin_multitable_object_registry'].entries()) await restoreRow(table, rows[index])
    expect((await capture()).revisions.sheet).not.toBe(before.revisions.sheet)
  })
  it('base hard deletion SET NULL changes sheet evidence and survives recreation', async () => {
    const row = await original('meta_bases', 'id', baseId), before = await capture()
    await admin.query('DELETE FROM meta_bases WHERE id=$1', [baseId])
    expect((await original('meta_sheets', 'id', sheetId)).base_id).toBeNull()
    await expect(capture()).rejects.toBeDefined()
    await restoreRow('meta_bases', row)
    await admin.query('UPDATE meta_sheets SET base_id=$1 WHERE id=$2', [baseId, sheetId])
    const after = await capture()
    expect(after.revisions.sheet).not.toBe(before.revisions.sheet)
    expect(after.revisions.base).not.toBe(before.revisions.base)
  })
  it.each(['tenant_id', 'project_id', 'object_id'])('pack scope move rotates OLD and NEW %s', async column => {
    await insertPack()
    const old = await epoch('pack', packScope)
    await admin.query('UPDATE integration_stock_prep_pack_installs SET ' + column + "='synthetic-other'")
    const movedScope = { ...packScope, [({ tenant_id: 'tenantId', project_id: 'projectId', object_id: 'objectId' } as Record<string, string>)[column]]: 'synthetic-other' }
    expect(await epoch('pack', packScope)).not.toBe(old)
    expect(await epoch('pack', movedScope)).toMatch(uuid)
    const moved = await epoch('pack', movedScope)
    const value = ({ tenant_id: tenantId, project_id: projectId, object_id: objectId } as Record<string, string>)[column]
    await admin.query('UPDATE integration_stock_prep_pack_installs SET ' + column + '=$1', [value])
    expect(await epoch('pack', movedScope)).not.toBe(moved)
    expect(await epoch('pack', packScope)).not.toBe(old)
  })
  it.each(['workspace_id', 'status'])('pack %s changes the same scope', async column => {
    await insertPack()
    const before = await capture()
    await admin.query('UPDATE integration_stock_prep_pack_installs SET ' + column + '=$1', [column === 'status' ? 'failed' : 'synthetic-workspace'])
    expect((await capture()).revisions.pack).not.toBe(before.revisions.pack)
    expect((await admin.query("SELECT * FROM automation_read_material_epochs WHERE kind='pack'")).rows).toHaveLength(1)
  })
  it.each(['meta_fields', 'plugin_multitable_object_registry'])('%s move rotates both sheet scopes', async table => {
    await admin.query("INSERT INTO meta_sheets(id,base_id) VALUES ('synthetic-other',$1)", [baseId])
    const old = await epoch('sheet', { id: sheetId }), other = await epoch('sheet', { id: 'synthetic-other' })
    await admin.query('UPDATE ' + table + " SET sheet_id='synthetic-other'")
    expect(await epoch('sheet', { id: sheetId })).not.toBe(old)
    expect(await epoch('sheet', { id: 'synthetic-other' })).not.toBe(other)
  })
  it.each(['sheet', 'base', 'pack'])('direct %s revision replay is replaced with database nonce', async kind => {
    if (kind === 'pack') await insertPack()
    const scope = kind === 'pack' ? packScope : { id: kind === 'sheet' ? sheetId : baseId }
    const before = await epoch(kind, scope)
    await admin.query('UPDATE automation_read_material_epochs SET revision=$1 WHERE kind=$2 AND scope=$3::jsonb',
      [before, kind, JSON.stringify(scope)])
    expect(await epoch(kind, scope)).not.toBe(before)
  })
  it('direct inserted revision is not adopted, and scope cannot move', async () => {
    const claimed = '11111111-1111-4111-8111-111111111111'
    await admin.query("INSERT INTO automation_read_material_epochs(kind,scope,revision) VALUES ('pack',$1::jsonb,$2)", [JSON.stringify(packScope), claimed])
    expect(await epoch('pack', packScope)).not.toBe(claimed)
    await expect(admin.query("UPDATE automation_read_material_epochs SET scope='{\"id\":\"synthetic-other\"}' WHERE kind='sheet'")).rejects.toBeDefined()
  })
  it.each(['DELETE FROM automation_read_material_epochs', 'TRUNCATE automation_read_material_epochs'])('%s cannot erase history', async statement => {
    const before = await capture()
    await expect(admin.query(statement)).rejects.toBeDefined()
    expect(await capture()).toEqual(before)
  })
  it.each(['meta_fields', 'plugin_multitable_object_registry', 'integration_stock_prep_pack_installs', 'meta_sheets', 'meta_bases'])(
    '%s TRUNCATE is allowed but rotates existing/empty tombstones', async table => {
      await insertPack()
      await admin.query('DELETE FROM integration_stock_prep_pack_installs')
      const kind = table === 'meta_bases' ? 'base' : table === 'integration_stock_prep_pack_installs' ? 'pack' : 'sheet'
      const scope = kind === 'pack' ? packScope : { id: kind === 'base' ? baseId : sheetId }
      const before = await epoch(kind, scope)
      await admin.query('TRUNCATE ' + table + ' CASCADE')
      expect(await epoch(kind, scope)).toMatch(uuid)
      expect(await epoch(kind, scope)).not.toBe(before)
    })
  it.each(['meta_bases', 'meta_sheets', 'meta_fields', 'plugin_multitable_object_registry', 'integration_stock_prep_pack_installs'])(
    'writer-first %s refuses the read without fallback', async table => {
      await writer.query('BEGIN')
      await writer.query('LOCK TABLE ' + table + ' IN ROW EXCLUSIVE MODE')
      await expect(capture()).rejects.toBeDefined()
      await writer.query('ROLLBACK')
    })
  it.each([
    "UPDATE meta_bases SET name='SYN-changed'",
    "UPDATE meta_sheets SET name='SYN-changed'",
    "UPDATE meta_fields SET name='SYN-changed'",
    "UPDATE plugin_multitable_object_registry SET plugin_name='synthetic-other'",
    'INSERT INTO integration_stock_prep_pack_installs(id,tenant_id,project_id,object_id,pack_id,pack_version,mode,status)'
      + " VALUES ('synthetic-insert','synthetic-tenant','synthetic-project','synthetic-object','pack','1','install','installed')",
  ])('reader-first blocks a real source writer until release %#', async statement => { await blockedWrite(statement) })
  it('reader-first missing pack epoch cannot be filled through direct epoch CRUD', async () => {
    await reader.query('BEGIN')
    expect((await lockAutomationReadMaterialEpochs(reader, input)).revisions.pack).toBeNull()
    await expect(writer.query("INSERT INTO automation_read_material_epochs(kind,scope,revision) VALUES ('pack',$1::jsonb,gen_random_uuid())",
      [JSON.stringify(packScope)])).rejects.toBeDefined()
    await reader.query('ROLLBACK')
    expect(await epoch('pack', packScope)).toBeNull()
  })
  it('direct epoch writer-first holds source fence and read refuses', async () => {
    await writer.query('BEGIN')
    await writer.query("INSERT INTO automation_read_material_epochs(kind,scope,revision) VALUES ('pack',$1::jsonb,gen_random_uuid())", [JSON.stringify(packScope)])
    await expect(capture()).rejects.toBeDefined()
    await writer.query('ROLLBACK')
  })
  it('identical installed content has different evidence after ABA', async () => {
    const candidate = { ...input, fieldIdMap: {} }
    const before = await tx(reader, trx => loadAutomationReadInstalledMaterial(trx, candidate))
    await admin.query("UPDATE meta_fields SET name='SYN-change'")
    await admin.query("UPDATE meta_fields SET name='SYN'")
    const after = await tx(reader, trx => loadAutomationReadInstalledMaterial(trx, candidate))
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.revisions.sheet).not.toBe(before.revisions.sheet)
  })
  it('no-history maintenance rollback/reinstall mints new evidence for current rows', async () => {
    await insertPack()
    const before = await capture()
    await db.transaction().execute(down)
    await db.transaction().execute(up)
    const after = await capture()
    expect(after.revisions.sheet).not.toBe(before.revisions.sheet)
    expect(after.revisions.base).not.toBe(before.revisions.base)
    expect(after.revisions.pack).not.toBe(before.revisions.pack)
  })
  it('duplicate migration up refuses instead of silently rewriting evidence', async () => {
    const before = await capture()
    await expect(db.transaction().execute(up)).rejects.toBeDefined()
    expect(await capture()).toEqual(before)
  })
  it('profile history blocks rollback even when disabled', async () => {
    const prepared = prepare({ config: { stockPreparationAutomationProfiles: [{ tenantId, workspaceId: null, projectId, actionId }],
      stockPreparationTableActions: [{ actionId, source: { externalSystemId: 'synthetic-source' }, target: { sheetId, fieldIdMap: {} } }] } }) as PreparedAutomationReadProfile[]
    await tx(admin, trx => activateAutomationReadProfiles(trx, prepared))
    await admin.query('UPDATE automation_read_target_profiles SET enabled=false')
    await expect(db.transaction().execute(down)).rejects.toBeDefined()
    await capture()
  })
  it.each(['sheet', 'base'])('live %s row with missing positive epoch never invents evidence', async kind => {
    // Test-owned corruption injects precisely a lost epoch, not a missing source.
    await admin.query('ALTER TABLE automation_read_material_epochs DISABLE TRIGGER USER')
    try { await admin.query('DELETE FROM automation_read_material_epochs WHERE kind=$1', [kind]) }
    finally { await admin.query('ALTER TABLE automation_read_material_epochs ENABLE TRIGGER USER') }
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_MATERIAL_DENIED' })
  })
  it('positive ledger with missing pack epoch is not classified as never-installed', async () => {
    await insertPack()
    await admin.query('ALTER TABLE automation_read_material_epochs DISABLE TRIGGER USER')
    try { await admin.query("DELETE FROM automation_read_material_epochs WHERE kind='pack'") }
    finally { await admin.query('ALTER TABLE automation_read_material_epochs ENABLE TRIGGER USER') }
    await expect(tx(reader, trx => loadAutomationReadInstalledMaterial(trx, { ...input, fieldIdMap: {} })))
      .rejects.toMatchObject({ code: 'AUTOMATION_INSTALLED_DENIED' })
  })
  async function insertGrantHistory() {
    await admin.query('INSERT INTO integration_automation_read_grants'
      + '(id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions) '
      + "VALUES (gen_random_uuid(),$1,$2,'{}',$3::jsonb,$4,ARRAY['SYN'],ARRAY['manual'],'{}',clock_timestamp()+interval '1 hour',1)",
    [tenantId, actorId, JSON.stringify({ connectionId: 'synthetic-connection', connectionIncarnation: '11111111-1111-4111-8111-111111111111' }), 'a'.repeat(64)])
  }
  it('grant-only history blocks rollback without any target profile', async () => {
    await insertGrantHistory()
    await expect(db.transaction().execute(down)).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_MATERIAL_HISTORY_ROLLBACK_FORBIDDEN' })
    await capture()
  })
  it('earlier empty search-path history table cannot hide the owning schema grant', async () => {
    await insertGrantHistory()
    const decoy = schema + '_decoy'
    await admin.query('CREATE SCHEMA "' + decoy + '"')
    try {
      await admin.query('CREATE TABLE "' + decoy + '".integration_automation_read_grants(id text)')
      await expect(db.transaction().execute(async trx => {
        await sql.raw('SET LOCAL search_path TO "' + decoy + '","' + schema + '"').execute(trx)
        await down(trx)
      })).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_MATERIAL_HISTORY_ROLLBACK_FORBIDDEN' })
      await capture()
    } finally { await admin.query('DROP SCHEMA "' + decoy + '" CASCADE') }
  })
  it.each(['automation_read_target_profiles', 'integration_automation_read_grants'])(
    'maintenance rollback cannot race concurrent %s insertion', async table => {
      await writer.query('BEGIN')
      await writer.query('LOCK TABLE ' + table + ' IN ROW EXCLUSIVE MODE')
      await expect(db.transaction().execute(down)).rejects.toMatchObject({ code: '55P03' })
      await writer.query('ROLLBACK')
      await capture()
    })
  const context = createAutomationReadTargetContext({ codec: {
    restoreStockPreparationAutomationProfileMaterial: restore, deriveAutomationReadTargetContract: derive,
  } })
  async function installedProfile(layout = 'synthetic-layout-a') {
    await admin.query('DELETE FROM meta_fields')
    const logicalFields = [...template.fields as Field[], ...pack.extensionFields]
    const fieldIdMap = Object.fromEntries(logicalFields.map((field, index) => [field.id, layout + '-' + index]))
    for (const field of logicalFields) {
      const extension = pack.extensionFields.find(entry => entry.id === field.id)
      const property: unknown = extension ? buildExtensionFieldProperty(extension, pack) : {}
      await admin.query('INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [fieldIdMap[field.id], sheetId, field.id, 'string', JSON.stringify(property)])
    }
    await insertPack('synthetic-pack', pack.extensionFields.map(field => ({
      fieldId: field.id, ownership: field.ownership, preserveOnRefresh: field.preserveOnRefresh, extension: true,
    })))
    const prepared = prepare({ config: {
      stockPreparationAutomationProfiles: [{ tenantId, workspaceId: null, projectId, actionId }],
      stockPreparationTableActions: [{ actionId, source: { externalSystemId: 'synthetic-source' },
        target: { sheetId, objectId, fieldIdMap }, extensionFieldIds: pack.extensionFields.map(field => field.id) }],
      stockPreparationCustomerPacks: { [pack.packId]: rawPack },
    } }) as PreparedAutomationReadProfile[]
    const registered = await tx(admin, trx => activateAutomationReadProfiles(trx, prepared))
    const selector = { actor: { actorId, tenantId, workspaceId: null }, producer: registered.producer,
      targetId: registered.targets[0].targetId } as const
    return { fieldIdMap, selector }
  }
  it.each(['synthetic-layout-a', 'synthetic-layout-b'])('real persisted profile→installed material→target permission→records for %s', async layout => {
    const { fieldIdMap: map, selector } = await installedProfile(layout)
    const projectNo = 'SYN-PROJECT'
    await admin.query('INSERT INTO meta_records(id,sheet_id,data) VALUES ($1,$2,$3::jsonb)', ['synthetic-record', sheetId,
      JSON.stringify({ [map.projectNo]: projectNo, [map.active]: true, [map.material]: 'SYN-material',
        [map.ext_spec]: 'SYN-spec', [map.notes]: 'SYN-note', undeclared: 'SYN-NOT-READ' })])
    const statements: string[] = []
    await reader.query('BEGIN')
    try {
      const tracked: Queryable = { async query(sql, params) { statements.push(sql); return reader.query(sql, params) } }
      const live = await context.lock(tracked, selector)
      expect(live.scope).toMatchObject({ actorId, tenantId, baseId, sheetId, projectId, objectId })
      expect(live.targetContract.projection.fieldIds).toEqual(Object.values(map).sort())
      expect(live.revisions.sheetRevision).toMatch(uuid)
      expect(live.revisions.baseRevision).toMatch(uuid)
      expect(live.revisions.packRevision).toMatch(uuid)
      expect(live.revisions.profileRevision).toMatch(uuid)
      expect(Object.isFrozen(live.targetContract.projection.fieldIds)).toBe(true)
      const projection = live.targetContract.projection
      const records = await loadAutomationReadTargetRecords(tracked, { actorId, baseId: live.scope.baseId, sheetId, projectNo,
        fieldIds: [...projection.fieldIds], projectFieldId: projection.projectFieldId, activeFieldId: projection.activeFieldId,
        maxRows: 10, maxQueries: 10, signal: new AbortController().signal })
      const rows = await readExistingStockPreparationRows(records, live.targetContract.action.target, projectNo) as Record<string, unknown>[]
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ projectNo, active: true, material: 'SYN-material', ext_spec: 'SYN-spec', notes: 'SYN-note' })
      expect(rows[0]).not.toHaveProperty('undeclared')
      records.close()
      expect(statements.some(statement => /\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|automation_|meta_)/i.test(statement))).toBe(false)
      expect(statements.some(statement => /\b(data_sources|integration_external_systems)\b/u.test(statement))).toBe(false)
    } finally { await reader.query('ROLLBACK') }
  })
  it.each(['tenant', 'inactive-actor', 'non-admin', 'hidden-field', 'missing-field', 'disabled-profile', 'deleted-base'])(
    'real composition rejects %s rather than returning a partial target', async change => {
      const { fieldIdMap: map, selector } = await installedProfile()
      if (change === 'tenant') await admin.query('DELETE FROM user_orgs')
      if (change === 'inactive-actor') await admin.query('UPDATE users SET is_active=false')
      if (change === 'non-admin') await admin.query("UPDATE users SET role='user'")
      if (change === 'hidden-field') await admin.query("UPDATE meta_fields SET property='{\"hidden\":true}' WHERE id=$1", [map.notes])
      if (change === 'missing-field') await admin.query('DELETE FROM meta_fields WHERE id=$1', [map.notes])
      if (change === 'disabled-profile') await admin.query('UPDATE automation_read_target_profiles SET enabled=false')
      if (change === 'deleted-base') await admin.query('UPDATE meta_bases SET deleted_at=clock_timestamp()')
      await expect(tx(reader, trx => context.lock(trx, selector))).rejects.toBeDefined()
    })
  it.each(['sheetId', 'objectId', 'actionId'])('DB profile header/material disagreement %s rejects even with live schema', async member => {
    const { selector } = await installedProfile()
    const jsonPath = member === 'actionId' ? '{action,actionId}' : '{action,target,' + member + '}'
    await admin.query('UPDATE automation_read_target_profiles SET material=jsonb_set(material,$1::text[],$2::jsonb)',
      [jsonPath, JSON.stringify('synthetic-other')])
    await expect(tx(reader, trx => context.lock(trx, selector))).rejects.toBeDefined()
  })
  it('real composition rereads producer wall-clock after target work', async () => {
    const { selector } = await installedProfile()
    // Test-controlled delay after the actual permission SQL; no substitute gate.
    await reader.query('BEGIN')
    let shortened = false
    const delayed: Queryable = { async query(sql, params) {
      const result = await reader.query(sql, params)
      if (!shortened && /LOCK TABLE users, user_roles/u.test(sql)) {
        shortened = true
        await reader.query("UPDATE automation_read_producer_slot SET expires_at=clock_timestamp()+interval '1 millisecond'")
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      return result
    } }
    try {
      await expect(context.lock(delayed, selector)).rejects.toBeDefined()
      expect(shortened).toBe(true)
    } finally { await reader.query('ROLLBACK') }
  })
  it('content equality cannot revive the real composition revision vector', async () => {
    const { fieldIdMap: map, selector } = await installedProfile()
    const before = await tx(reader, trx => context.lock(trx, selector))
    await admin.query("UPDATE meta_fields SET name='SYN-temporary' WHERE id=$1", [map.notes])
    await admin.query("UPDATE meta_fields SET name='notes' WHERE id=$1", [map.notes])
    const after = await tx(reader, trx => context.lock(trx, selector))
    expect(after.content).toEqual(before.content)
    expect(after.targetContract.executionKey).toBe(before.targetContract.executionKey)
    expect(after.revisions.sheetRevision).not.toBe(before.revisions.sheetRevision)
  })
})
