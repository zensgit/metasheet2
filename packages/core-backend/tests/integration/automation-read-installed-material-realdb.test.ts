/** SA-06H: actual PostgreSQL metadata census/locks and real target composition.
 * This is not a deployment/tenant/owner proof or an installer lifecycle fence.
 * All rows belong to this suite's disposable synthetic schema. */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadAutomationReadInstalledMaterial } from '../../src/integration/automation-read-installed-material'
import { loadAutomationReadTargetRecords } from '../../src/integration/automation-read-target-records'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { up as addMaterialEpochs } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECTED_DB must actually provide a database', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const pluginLib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
const requirePlugin = createRequire(import.meta.url)
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: template } = requirePlugin(path.join(pluginLib, 'stock-preparation-templates.cjs')) as {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: { objectId: string; fields: Array<{ id: string; type: string }> }
}
const { FACTORY_A_REHEARSAL_PACK: rawPack } = requirePlugin(path.join(pluginLib, 'customer-packs/factory-a.rehearsal.cjs')) as {
  FACTORY_A_REHEARSAL_PACK: unknown
}
type PackField = { id: string; ownership: string; preserveOnRefresh: boolean; type: string }
const { normalizeCustomerPack } = requirePlugin(path.join(pluginLib, 'stock-preparation-customer-pack.cjs')) as {
  normalizeCustomerPack(input: unknown): { packId: string; packVersion: number; targetObjectId: string; extensionFields: PackField[] }
}
const { __internals: { buildExtensionFieldProperty } } = requirePlugin(path.join(pluginLib, 'stock-preparation-customer-pack-installer.cjs')) as {
  __internals: { buildExtensionFieldProperty(field: PackField, pack: unknown): Record<string, unknown> }
}
type Target = { sheetId: string; objectId: string; fieldIdMap: Record<string, string> }
const { deriveAutomationReadTargetContract } = requirePlugin(path.join(pluginLib, 'stock-preparation-automation-target-contract.cjs')) as {
  deriveAutomationReadTargetContract(input: { action: unknown; installedFieldProperties: unknown; extFieldMapping: null }): {
    action: { target: Target }; projection: { fieldIds: string[]; projectFieldId: string; activeFieldId: string }; executionKey: string
  }
}
const { __internals: readers } = requirePlugin(path.join(pluginLib, 'stock-preparation-table-actions.cjs')) as {
  __internals: { readExistingStockPreparationRows(api: Awaited<ReturnType<typeof loadAutomationReadTargetRecords>>,
    target: Target, projectNo: string): Promise<Array<Record<string, unknown>>> }
}
const pack = normalizeCustomerPack(rawPack)
const tenantId = 'synthetic-tenant'
const projectId = 'synthetic-deployment'
const objectId = pack.targetObjectId
const sheetId = 'synthetic-target-sheet'
const baseId = 'synthetic-base-not-deployment'
const actorId = 'synthetic-reader'
const projectNo = 'SYN-PROJECT-001'
const deniedCode = 'AUTOMATION_INSTALLED_DENIED'
type Input = Parameters<typeof loadAutomationReadInstalledMaterial>[1]

describeDatabase('Automation installed material: actual PostgreSQL census, locks and production target readers', () => {
  const schema = `automation_installed_${randomBytes(8).toString('hex')}`
  let pool: Pool, admin: PoolClient, reader: PoolClient, writer: PoolClient, observer: PoolClient
  let migrationDb: Kysely<unknown>
  let input: Input
  const statements: string[] = []
  const tracked: Queryable = { async query(sql, params) { statements.push(sql); return reader.query(sql, params) } }
  async function capture(candidate = input) {
    statements.length = 0
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { return await loadAutomationReadInstalledMaterial(tracked, candidate) }
    finally { await reader.query('ROLLBACK') }
  }
  async function setPackFields(fields: unknown, id = 'synthetic-pack-row') {
    await admin.query('UPDATE integration_stock_prep_pack_installs SET installed_fields_json=$1::jsonb WHERE id=$2', [JSON.stringify(fields), id])
  }
  async function insertPack(id = 'synthetic-pack-row', packIdentity = pack.packId, fields: unknown = pack.extensionFields.map(field => ({
    fieldId: field.id, ownership: field.ownership, preserveOnRefresh: field.preserveOnRefresh, extension: true,
  }))) {
    await admin.query(`INSERT INTO integration_stock_prep_pack_installs
      (id,tenant_id,workspace_id,project_id,object_id,pack_id,pack_version,mode,status,installed_fields_json)
      VALUES ($1,$2,NULL,$3,$4,$5,'1','install','installed',$6::jsonb)`,
    [id, tenantId, projectId, objectId, packIdentity, JSON.stringify(fields)])
  }
  async function installLayout(layout: string, withPack = true) {
    await admin.query('DELETE FROM integration_stock_prep_pack_installs')
    await admin.query('DELETE FROM meta_fields')
    const logical = [...template.fields, ...(withPack ? pack.extensionFields : [])]
    input = { tenantId, workspaceId: null, projectId, objectId, sheetId,
      fieldIdMap: Object.fromEntries(logical.map(field => [field.id, `${layout}-${field.id}`])) }
    for (const field of logical) {
      const extension = pack.extensionFields.find(candidate => candidate.id === field.id)
      const property = extension ? buildExtensionFieldProperty(extension, pack) : {}
      await admin.query(`INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,'string',$4::jsonb,0)`,
        [input.fieldIdMap[field.id], sheetId, field.id, JSON.stringify(property)])
    }
    if (withPack) await insertPack()
  }
  async function pid(client: PoolClient) { return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) }
  async function proveBlocked(sql: string, params: unknown[] = []) {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await loadAutomationReadInstalledMaterial(reader, input)
    await writer.query('BEGIN')
    const blocker = await pid(reader), blocked = await pid(writer)
    let done = false
    const pending = writer.query(sql, params).then(result => { done = true; return result })
    void pending.catch(() => {})
    try {
      let witnessed = false
      for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        const state = await observer.query(`SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`, [blocked, blocker])
        if (state.rows[0]?.blocked === true) { witnessed = true; break }
        expect(done).toBe(false)
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      expect(witnessed).toBe(true)
      expect(done).toBe(false)
      await reader.query('COMMIT')
      expect((await pending).rowCount).toBeGreaterThan(0)
      await writer.query('COMMIT')
    } finally {
      await reader.query('ROLLBACK')
      await pending.catch(() => {})
      await writer.query('ROLLBACK')
    }
  }
  beforeAll(async () => {
    if (!/^automation_installed_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid synthetic schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, options: `-c search_path=${schema}` })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(`CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean);
      CREATE TABLE user_roles (user_id text,role_id text,PRIMARY KEY(user_id,role_id));
      CREATE TABLE user_permissions (user_id text,permission_code text,PRIMARY KEY(user_id,permission_code));
      CREATE TABLE role_permissions (role_id text,permission_code text,PRIMARY KEY(role_id,permission_code));
      CREATE TABLE platform_member_group_members (user_id text,group_id uuid,PRIMARY KEY(user_id,group_id));
      CREATE TABLE spreadsheet_permissions (sheet_id text,subject_type text,subject_id text,perm_code text);
      CREATE TABLE field_permissions (sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean);
      CREATE TABLE record_permissions (sheet_id text,record_id text,subject_type text,subject_id text,access_level text);
      CREATE TABLE meta_bases (id text PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE meta_sheets (id text PRIMARY KEY,base_id text NOT NULL,deleted_at timestamptz,
        row_level_read_permissions_enabled boolean NOT NULL DEFAULT false);
      CREATE TABLE meta_fields (id text PRIMARY KEY,sheet_id text NOT NULL,name text NOT NULL,type text NOT NULL,
        property jsonb,"order" integer DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE meta_records (id text PRIMARY KEY,sheet_id text NOT NULL,data jsonb NOT NULL DEFAULT '{}',
        version integer DEFAULT 1,created_by text,modified_by text,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE plugin_multitable_object_registry (sheet_id text PRIMARY KEY,project_id text NOT NULL,object_id text NOT NULL,
        plugin_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(project_id,object_id))`)
    // Exercise the actual legacy pack ledger DDL in the owned schema.
    await admin.query(readFileSync(path.resolve(__dirname, '../../migrations/076_create_integration_stock_prep_pack_installs.sql'), 'utf8'))
    await migrationDb.transaction().execute(addMaterialEpochs)
    reader = await pool.connect(); writer = await pool.connect(); observer = await pool.connect()
    for (const client of [admin, reader, writer, observer]) {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query("SET statement_timeout = '8s'")
    }
  })
  afterAll(async () => {
    for (const client of [reader, writer, observer]) if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    if (admin) { await admin.query('ROLLBACK').catch(() => {}); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); admin.release() }
    await migrationDb?.destroy()
  })
  beforeEach(async () => {
    for (const client of [admin, reader, writer, observer]) await client.query('ROLLBACK')
    await admin.query(`TRUNCATE users,user_roles,user_permissions,role_permissions,platform_member_group_members,
      spreadsheet_permissions,field_permissions,record_permissions,meta_bases,meta_sheets,meta_fields,meta_records,
      integration_stock_prep_pack_installs,plugin_multitable_object_registry`)
    await admin.query("INSERT INTO users VALUES ($1,'user','[]',true)", [actorId])
    await admin.query("INSERT INTO user_permissions VALUES ($1,'multitable:read')", [actorId])
    await admin.query('INSERT INTO meta_bases (id) VALUES ($1)', [baseId])
    await admin.query('INSERT INTO meta_sheets (id,base_id) VALUES ($1,$2)', [sheetId, baseId])
    await admin.query(`INSERT INTO plugin_multitable_object_registry (sheet_id,project_id,object_id,plugin_name)
      VALUES ($1,$2,$3,'plugin-integration-core')`, [sheetId, projectId, objectId])
    await installLayout('mapped-a')
  })

  it.each(['mapped-a', 'mapped-b'])('reads actual mapped properties and composes the real target reader for %s', async layout => {
    await installLayout(layout)
    const map = input.fieldIdMap
    await admin.query('INSERT INTO meta_records (id,sheet_id,data) VALUES ($1,$2,$3::jsonb)', ['synthetic-row', sheetId,
      JSON.stringify({ [map.projectNo]: projectNo, [map.active]: true, [map.material]: 'SYN-material',
        [map.notes]: 'SYN-note', [map.ext_spec]: 'SYN-spec', [map.ext_blankMass]: 7, undeclared: 'SYN-NOT-READ' })])
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const material = await loadAutomationReadInstalledMaterial(tracked, input)
      expect(material.installedFieldProperties.map(field => field.fieldId)).toEqual(pack.extensionFields.map(field => field.id).sort())
      const contract = deriveAutomationReadTargetContract({ action: {
        source: { externalSystemId: 'synthetic-canonical-source', kind: 'data-source:sql-readonly' },
        target: { sheetId, objectId, fieldIdMap: map }, extensionFieldIds: pack.extensionFields.map(field => field.id),
      }, installedFieldProperties: material.installedFieldProperties, extFieldMapping: null })
      const snapshot = await loadAutomationReadTargetRecords(tracked, { actorId, baseId, sheetId, projectNo,
        fieldIds: contract.projection.fieldIds, projectFieldId: contract.projection.projectFieldId,
        activeFieldId: contract.projection.activeFieldId, maxRows: 10, maxQueries: 10, signal: new AbortController().signal })
      const existing = await readers.readExistingStockPreparationRows(snapshot, contract.action.target, projectNo)
      expect(existing).toHaveLength(1)
      expect(existing[0]).toMatchObject({ projectNo, active: true, material: 'SYN-material', notes: 'SYN-note', ext_spec: 'SYN-spec', ext_blankMass: 7 })
      expect(existing[0]).not.toHaveProperty('undeclared')
    } finally { await reader.query('ROLLBACK') }
  })
  it('legitimate empty ledger and unmarked target return explicit empty, not undefined', async () => {
    await installLayout('empty', false)
    const material = await capture()
    expect(material.installedFieldProperties).toEqual([])
    expect(Object.isFrozen(material.installedFieldProperties)).toBe(true)
    expect(statements.some(sql => /\bmeta_records\b/i.test(sql))).toBe(false)
  })
  it('supports explicit identity mapping and reads those exact physical rows', async () => {
    await admin.query('UPDATE meta_fields SET id=name')
    input.fieldIdMap = {}
    expect((await capture()).installedFieldProperties.map(field => field.fieldId)).toEqual(pack.extensionFields.map(field => field.id).sort())
  })
  it.each(['tenant', 'workspace', 'project', 'object', 'plugin', 'sheet', 'missing-registry'])('rejects invalid scope %s without fallback', async change => {
    if (change === 'tenant') input.tenantId = 'other-tenant'
    if (change === 'workspace') await admin.query("UPDATE integration_stock_prep_pack_installs SET workspace_id='other-workspace'")
    if (change === 'project') input.projectId = 'other-project'
    if (change === 'object') input.objectId = 'other-object'
    if (change === 'plugin') await admin.query("UPDATE plugin_multitable_object_registry SET plugin_name='other-plugin'")
    if (change === 'sheet') input.sheetId = 'other-sheet'
    if (change === 'missing-registry') await admin.query('DELETE FROM plugin_multitable_object_registry')
    await expect(capture()).rejects.toMatchObject({ code: deniedCode })
  })
  it('does not ingest foreign scope ledger rows or fields into the target', async () => {
    await admin.query(`INSERT INTO integration_stock_prep_pack_installs
      (id,tenant_id,project_id,object_id,pack_id,pack_version,mode,status,installed_fields_json)
      VALUES ('foreign','other-tenant',$1,$2,'foreign','1','install','failed','null')`, [projectId, objectId])
    await admin.query("INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ('foreign','other-sheet','foreign','string','null')")
    expect((await capture()).installedFieldProperties).toHaveLength(pack.extensionFields.length)
  })
  it('uses live ownership and preserves full properties instead of stale ledger classifications', async () => {
    const before = await capture()
    await admin.query(`UPDATE meta_fields SET property=property || '{"syntheticNested":{"keep":[1,null]}}'::jsonb
      WHERE id=$1`, [input.fieldIdMap.ext_spec])
    await admin.query(`UPDATE meta_fields SET property=jsonb_set(property,'{stockPreparation,ownership}','"human_preserved"') WHERE id=$1`, [input.fieldIdMap.ext_spec])
    const after = await capture()
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.installedFieldProperties.find(field => field.fieldId === 'ext_spec')?.property).toMatchObject({
      stockPreparation: { ownership: 'human_preserved' }, syntheticNested: { keep: [1, null] },
    })
    expect(before.installedFieldProperties.find(field => field.fieldId === 'ext_spec')?.property).not.toHaveProperty('syntheticNested')
    expect(Object.isFrozen(after.installedFieldProperties[0].property)).toBe(true)
  })
  it('accepts partial rows, but never filters a failed row away to create an empty success', async () => {
    await admin.query("UPDATE integration_stock_prep_pack_installs SET status='partial'")
    expect((await capture()).installedFieldProperties).toHaveLength(pack.extensionFields.length)
    await admin.query("UPDATE integration_stock_prep_pack_installs SET status='failed'")
    await expect(capture()).rejects.toMatchObject({ code: deniedCode })
  })
  it.each(['workspace', 'failed'])('does not mask an unsupported %s row behind an empty candidate set', async change => {
    await installLayout('empty-but-ledger', false)
    await insertPack('empty-row', 'empty-pack', [])
    expect((await capture()).installedFieldProperties).toEqual([])
    if (change === 'workspace') await admin.query("UPDATE integration_stock_prep_pack_installs SET workspace_id='other-workspace'")
    else await admin.query("UPDATE integration_stock_prep_pack_installs SET status='failed'")
    await expect(capture()).rejects.toMatchObject({ code: deniedCode })
  })
  it.each([null, {}, '[]', [null], [{ fieldId: 'ext_spec' }],
    [{ fieldId: 'ext_spec', ownership: 'unknown', preserveOnRefresh: false, extension: true }]])('rejects malformed ledger JSON %#', async value => {
    await setPackFields(value)
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_INSTALLED_UNAVAILABLE' })
  })
  it.each([null, [], 'serialized-property'])('does not convert bad live property to empty metadata %#', async value => {
    await admin.query('UPDATE meta_fields SET property=$1::jsonb WHERE id=$2', [JSON.stringify(value), input.fieldIdMap.ext_spec])
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_INSTALLED_UNAVAILABLE' })
  })
  it.each(['missing-field', 'partial-map', 'orphan-marker', 'orphan-declared'])('refuses incomplete mapped census: %s', async change => {
    if (change === 'missing-field') await admin.query('DELETE FROM meta_fields WHERE id=$1', [input.fieldIdMap.ext_spec])
    if (change === 'partial-map') delete input.fieldIdMap.ext_spec
    if (change === 'orphan-marker') await admin.query('DELETE FROM integration_stock_prep_pack_installs')
    if (change === 'orphan-declared') {
      await admin.query('DELETE FROM integration_stock_prep_pack_installs')
      await admin.query("UPDATE meta_fields SET property='{}'")
    }
    await expect(capture()).rejects.toMatchObject({ code: deniedCode })
  })
  it('detects a stamped orphan outside the explicit map as well as inside it', async () => {
    await admin.query('DELETE FROM integration_stock_prep_pack_installs')
    input.fieldIdMap = Object.fromEntries(Object.entries(input.fieldIdMap).filter(([logical]) => !logical.startsWith('ext_')))
    await expect(capture()).rejects.toMatchObject({ code: deniedCode })
  })
  it('canonical option-only provenance is not misclassified as an unledgered extension', async () => {
    await installLayout('option-only', false)
    await admin.query(`UPDATE meta_fields SET property='{"stockPreparation":{"customerPack":{"packId":"old-pack","fieldId":"notes"}}}' WHERE id=$1`,
      [input.fieldIdMap.notes])
    expect((await capture()).installedFieldProperties).toEqual([])
  })
  it('does not require stale provenance pack/version to equal a later ledger version', async () => {
    await admin.query("UPDATE integration_stock_prep_pack_installs SET pack_version='99'")
    expect((await capture()).installedFieldProperties).toHaveLength(pack.extensionFields.length)
  })
  it('deduplicates candidate IDs across installed packs, not duplicate entries inside one row', async () => {
    await insertPack('second-row', 'second-pack')
    expect((await capture()).installedFieldProperties).toHaveLength(pack.extensionFields.length)
    const entry = { fieldId: 'ext_spec', ownership: 'plm_system', preserveOnRefresh: false, extension: true }
    await setPackFields([entry, entry])
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_INSTALLED_UNAVAILABLE' })
  })
  it('reads a 201st ledger sentinel and refuses truncation; exact cap remains valid', async () => {
    await admin.query(`INSERT INTO integration_stock_prep_pack_installs
      (id,tenant_id,project_id,object_id,pack_id,pack_version,mode,status,installed_fields_json)
      SELECT 'bulk-'||i,$1,$2,$3,'bulk-'||i,'1','install','installed','[]'::jsonb FROM generate_series(1,199) i`, [tenantId, projectId, objectId])
    expect((await capture()).installedFieldProperties).toHaveLength(pack.extensionFields.length)
    // Sort overflow AFTER every already-proved row: a missing sentinel cannot
    // be masked by dropping the real candidate row and hitting orphan refusal.
    await insertPack('zzzz-overflow-row', 'overflow-pack', [])
    await expect(capture()).rejects.toMatchObject({ code: deniedCode })
  })
  it('reads an extra field sentinel and refuses whole-sheet metadata truncation', async () => {
    const existing = Number((await admin.query('SELECT count(*) AS n FROM meta_fields')).rows[0].n)
    await admin.query(`INSERT INTO meta_fields (id,sheet_id,name,type,property)
      SELECT 'zzzz-bulk-field-'||i,$1,'synthetic','string','{}'::jsonb FROM generate_series(1,$2::int) i`, [sheetId, 2048 - existing])
    expect((await capture()).installedFieldProperties).toHaveLength(pack.extensionFields.length)
    await admin.query("INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ('zzzzz-overflow',$1,'synthetic','string','{}')", [sheetId])
    await expect(capture()).rejects.toMatchObject({ code: deniedCode })
  })
  it('retains microsecond content changes and is independent of session timezone', async () => {
    await admin.query("UPDATE meta_fields SET updated_at='2026-10-01 01:02:03.123456+00'")
    const first = await capture()
    await reader.query("SET TIME ZONE 'Asia/Singapore'")
    try { expect((await capture()).fingerprint).toBe(first.fingerprint) }
    finally { await reader.query("SET TIME ZONE 'UTC'") }
    await admin.query("UPDATE meta_fields SET updated_at='2026-10-01 01:02:03.123457+00'")
    expect((await capture()).fingerprint).not.toBe(first.fingerprint)
  })
  it.each(['no-transaction', 'repeatable-read'])('rejects invalid transaction %s', async kind => {
    if (kind === 'repeatable-read') await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try { await expect(loadAutomationReadInstalledMaterial(reader, input)).rejects.toMatchObject({ code: 'AUTOMATION_INSTALLED_TRANSACTION_REQUIRED' }) }
    finally { await reader.query('ROLLBACK') }
  })
  it.each(['integration_stock_prep_pack_installs', 'meta_fields', 'plugin_multitable_object_registry'])('missing %s cannot become allowed empty', async table => {
    await admin.query(`ALTER TABLE ${table} RENAME TO temporarily_missing`)
    try { await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_INSTALLED_UNAVAILABLE' }) }
    finally { await admin.query(`ALTER TABLE temporarily_missing RENAME TO ${table}`) }
  })
  it.each(['field-update', 'field-delete', 'field-insert', 'pack-update', 'pack-delete', 'pack-insert', 'registry-update', 'registry-delete'])('holds actual metadata lock against %s', async change => {
    const mutations: Record<string, [string, unknown[]]> = {
      'field-update': ['UPDATE meta_fields SET property=\'{}\' WHERE id=$1', [input.fieldIdMap.ext_spec]],
      'field-delete': ['DELETE FROM meta_fields WHERE id=$1', [input.fieldIdMap.ext_spec]],
      'field-insert': ["INSERT INTO meta_fields (id,sheet_id,name,type,property) VALUES ('new-field',$1,'synthetic','string','{}')", [sheetId]],
      'pack-update': ["UPDATE integration_stock_prep_pack_installs SET pack_version='2'", []],
      'pack-delete': ['DELETE FROM integration_stock_prep_pack_installs', []],
      'pack-insert': ["INSERT INTO integration_stock_prep_pack_installs (id,tenant_id,project_id,object_id,pack_id,pack_version,mode,status) VALUES ('new-pack',$1,$2,$3,'new-pack','1','install','installed')", [tenantId, projectId, objectId]],
      'registry-update': ["UPDATE plugin_multitable_object_registry SET plugin_name='other'", []],
      'registry-delete': ['DELETE FROM plugin_multitable_object_registry', []],
    }
    await proveBlocked(...mutations[change])
  })
  it.each(['meta_fields', 'integration_stock_prep_pack_installs', 'plugin_multitable_object_registry'])('fails closed when a %s writer acquires its lock first', async table => {
    await writer.query('BEGIN')
    await writer.query(`UPDATE ${table} SET ${table === 'integration_stock_prep_pack_installs' ? 'pack_version=pack_version' : 'updated_at=updated_at'}`)
    try { await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_INSTALLED_UNAVAILABLE' }) }
    finally { await writer.query('ROLLBACK') }
  })
})
