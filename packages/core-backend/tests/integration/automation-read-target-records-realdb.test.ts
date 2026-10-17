/** SA-06F: actual SQL projection + actual target permission service + actual
 * stock-preparation target readers. Synthetic owned schema only. This does NOT
 * authorize a source, wire a worker, or prove the future full host provider. */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadAutomationReadTargetRecords } from '../../src/integration/automation-read-target-records'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECTED_DB must actually provide a database', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})
type Snapshot = Awaited<ReturnType<typeof loadAutomationReadTargetRecords>>
type SnapshotInput = Parameters<typeof loadAutomationReadTargetRecords>[1]
type ReaderTarget = { sheetId: string; fieldIdMap: Record<string, string> }
const target = { sheetId: 'synthetic-sheet', fieldIdMap: {
  projectNo: 'physical-project', active: 'physical-active', material: 'physical-value',
} }
const scope = { actorId: 'synthetic-actor', baseId: 'synthetic-base', sheetId: target.sheetId,
  fieldIds: Object.values(target.fieldIdMap), projectFieldId: target.fieldIdMap.projectNo,
  activeFieldId: target.fieldIdMap.active, projectNo: 'SYN-001', maxRows: 100, maxQueries: 100 }
const requirePlugin = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
type DerivedTargetContract = {
  action: { target: { sheetId: string; objectId: string; fieldIdMap: Record<string, string> } }
  projection: { logicalFieldIds: string[]; fieldIds: string[]; projectFieldId: string; activeFieldId: string }
  executionKey: string
}
const { deriveAutomationReadTargetContract } = requirePlugin(path.join(pluginLib,
  'stock-preparation-automation-target-contract.cjs')) as {
  deriveAutomationReadTargetContract(input: { action: Record<string, unknown>;
    installedFieldProperties: Array<{ fieldId: string; property: Record<string, unknown> }>;
    extFieldMapping: null }): DerivedTargetContract
}
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: template } = requirePlugin(path.join(pluginLib,
  'stock-preparation-templates.cjs')) as { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: { fields: Array<{ id: string }> } }
const { FACTORY_A_REHEARSAL_PACK: rawPack } = requirePlugin(path.join(pluginLib, 'customer-packs/factory-a.rehearsal.cjs')) as {
  FACTORY_A_REHEARSAL_PACK: unknown
}
const { normalizeCustomerPack } = requirePlugin(path.join(pluginLib, 'stock-preparation-customer-pack.cjs')) as {
  normalizeCustomerPack(input: unknown): { extensionFields: Array<{ id: string; ownership: string; preserveOnRefresh: boolean }> }
}
const { __internals: readers } = requirePlugin(path.resolve(__dirname,
  '../../../../plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs')) as {
  __internals: {
    readExistingStockPreparationRows(api: Snapshot, boundTarget: ReaderTarget, project: string,
      options?: { limit: number; maxPages: number }): Promise<Array<Record<string | symbol, unknown>>>
    assertTargetSheetHoldsNoForeignActiveRows(api: Snapshot, boundTarget: ReaderTarget, project: string,
      options?: { limit: number; maxPages: number }): Promise<void>
  }
}

describeDatabase('Automation closed target snapshot: actual PostgreSQL and production target readers', () => {
  const schema = `automation_target_records_${randomBytes(8).toString('hex')}`
  let pool: Pool, admin: PoolClient, reader: PoolClient
  const sqlLog: string[] = []
  const wireRows: unknown[] = []
  const tracked: Queryable = { async query(sql, params) {
    sqlLog.push(sql)
    const result = await reader.query(sql, params)
    if (/\bFROM\s+meta_records\b/i.test(sql)) wireRows.push(...structuredClone(result.rows))
    return result
  } }
  async function capture(overrides: Partial<SnapshotInput> = {}) {
    sqlLog.length = 0
    wireRows.length = 0
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      return await loadAutomationReadTargetRecords(tracked, {
        ...scope, signal: new AbortController().signal, ...overrides,
      })
    } finally { await reader.query('ROLLBACK') }
  }
  const scan = (snapshot: Snapshot, filters: Record<string, string> = {}, offset = 0, limit = 1000) =>
    snapshot.queryRecords({ sheetId: scope.sheetId, filters, offset, limit })
  const projectFilter = { [scope.projectFieldId]: scope.projectNo }
  async function insert(id: string, data: unknown, sheetId = scope.sheetId, createdBy: string | null = 'record-owner') {
    await admin.query(`INSERT INTO meta_records
      (id,sheet_id,data,created_by,modified_by,created_at,updated_at)
      VALUES ($1,$2,$3::jsonb,$4,'record-editor','2026-10-01T01:02:03.123456Z','2026-10-01T02:03:04.654321Z')`,
    [id, sheetId, JSON.stringify(data), createdBy])
  }
  const row = (project: unknown = scope.projectNo, active: unknown = true) => ({
    [scope.projectFieldId]: project, [scope.activeFieldId]: active,
    'physical-value': { nested: ['synthetic-material'] },
    'private-unrequested': 'SYNTHETIC-UNREQUESTED-CANARY', createdBy: 'forged-data-owner',
  })

  beforeAll(async () => {
    if (!/^automation_target_records_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(`CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean);
      CREATE TABLE user_roles (user_id text, role_id text);
      CREATE TABLE user_permissions (user_id text, permission_code text);
      CREATE TABLE role_permissions (role_id text, permission_code text);
      CREATE TABLE platform_member_group_members (user_id text, group_id uuid);
      CREATE TABLE spreadsheet_permissions (sheet_id text, subject_type text, subject_id text, perm_code text);
      CREATE TABLE field_permissions (sheet_id text, field_id text, subject_type text, subject_id text, visible boolean, read_only boolean);
      CREATE TABLE record_permissions (sheet_id text, record_id text, subject_type text, subject_id text, access_level text);
      CREATE TABLE meta_bases (id text PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE meta_sheets (id text PRIMARY KEY, base_id text NOT NULL, deleted_at timestamptz,
        row_level_read_permissions_enabled boolean DEFAULT false);
      CREATE TABLE meta_fields (id text PRIMARY KEY, sheet_id text NOT NULL, type text NOT NULL, property jsonb);
      CREATE TABLE meta_records (id text PRIMARY KEY, sheet_id text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
        version integer NOT NULL DEFAULT 1, created_by text, modified_by text,
        created_at timestamptz, updated_at timestamptz)`)
    reader = await pool.connect()
    for (const client of [admin, reader]) {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query("SET statement_timeout = '8s'")
    }
  })
  afterAll(async () => {
    if (reader) { await reader.query('ROLLBACK').catch(() => {}); reader.release() }
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })
  beforeEach(async () => {
    await reader.query('ROLLBACK')
    await admin.query(`TRUNCATE users,user_roles,user_permissions,role_permissions,platform_member_group_members,
      spreadsheet_permissions,field_permissions,record_permissions,meta_bases,meta_sheets,meta_fields,meta_records`)
    await admin.query(`INSERT INTO users VALUES ($1,'user','[]',true)`, [scope.actorId])
    await admin.query('INSERT INTO user_permissions VALUES ($1,$2)', [scope.actorId, 'multitable:read'])
    await admin.query('INSERT INTO meta_bases (id) VALUES ($1)', [scope.baseId])
    await admin.query('INSERT INTO meta_sheets (id,base_id) VALUES ($1,$2)', [scope.sheetId, scope.baseId])
    for (const id of scope.fieldIds) await admin.query(`INSERT INTO meta_fields VALUES ($1,$2,'string','{}')`, [id, scope.sheetId])
  })

  it('projects at SQL boundary, not after loading raw JSON; both real readers consume the closed facade', async () => {
    await insert('a', row())
    await insert('b', row('SYN-OTHER', false))
    await insert('c', row(), 'different-sheet')
    const snapshot = await capture().finally(() => {
      // Check the actual SQL boundary EVEN IF the downstream shape guard rejects.
      // Its refusal must not mask an overbroad SELECT mutation in this evidence.
      expect(sqlLog.filter(sql => /\bFROM\s+meta_records\b/i.test(sql))).toHaveLength(1)
      expect(wireRows).toHaveLength(2)
      expect(JSON.stringify(wireRows)).not.toContain('SYNTHETIC-UNREQUESTED-CANARY')
      expect(JSON.stringify(wireRows[1])).not.toContain('synthetic-material')
    })
    const existing = await readers.readExistingStockPreparationRows(snapshot, target, scope.projectNo, { limit: 1, maxPages: 5 })
    expect(existing).toHaveLength(1)
    expect(Object.keys(existing[0]).sort()).toEqual(['active', 'material', 'projectNo'])
    expect(existing[0].material).toEqual({ nested: ['synthetic-material'] })
    expect(existing[0][Symbol.for('metasheet.stock-preparation.existingRow.createdBy')]).toBe('record-owner')
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(snapshot, target, scope.projectNo, { limit: 1, maxPages: 5 })).resolves.toBeUndefined()
    const all = await scan(snapshot)
    expect(all.every(record => Object.keys(record.data).sort().join(',') === [...scope.fieldIds.slice(0, 2)].sort().join(','))).toBe(true)
    expect(all.every(record => !Object.hasOwn(record, 'createdBy'))).toBe(true)
    expect(snapshot).not.toHaveProperty('createRecord')
    expect(snapshot).not.toHaveProperty('patchRecord')
    expect((await admin.query('SELECT count(*)::int AS n FROM meta_records')).rows[0].n).toBe(3)
  })

  it('keeps a stable one-statement snapshot across deletes, inserts and changed row values between pages', async () => {
    await insert('b', row())
    await insert('d', row())
    const snapshot = await capture()
    expect((await scan(snapshot, projectFilter, 0, 1))[0].id).toBe('b')
    await admin.query(`DELETE FROM meta_records WHERE id='b'`)
    await admin.query(`UPDATE meta_records SET data='{}' WHERE id='d'`)
    await insert('a', row('SYN-OTHER', true))
    expect((await scan(snapshot, projectFilter, 1, 1))[0]).toMatchObject({ id: 'd', data: rowProjection() })
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(snapshot, target, scope.projectNo)).resolves.toBeUndefined()
    // A fresh capture observes the actual change; the prior snapshot is not an authorization token.
    const next = await capture()
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(next, target, scope.projectNo)).rejects.toMatchObject({ code: 'TARGET_SHEET_FOREIGN_PROJECT' })
  })
  function rowProjection() {
    return { [scope.projectFieldId]: scope.projectNo, [scope.activeFieldId]: true,
      'physical-value': { nested: ['synthetic-material'] } }
  }

  it('uses actual SQL text equality for project filtering without normalizing the whole-sheet guard', async () => {
    await insert('a', row(123, true))
    const snapshot = await capture({ projectNo: '123' })
    const existing = await readers.readExistingStockPreparationRows(snapshot, target, '123')
    expect(existing).toHaveLength(1)
    expect(existing[0].projectNo).toBe(123)
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(snapshot, target, '123')).rejects.toMatchObject({ code: 'TARGET_SHEET_FOREIGN_PROJECT' })
  })
  it.each([true, 1, '1', 'yes', ' Y ', 'unexpected', {}, []])('does not drop a foreign active row with representation %#', async active => {
    await insert('a', row('SYN-OTHER', active))
    const snapshot = await capture()
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(snapshot, target, scope.projectNo)).rejects.toMatchObject({ code: 'TARGET_SHEET_FOREIGN_PROJECT' })
  })
  it.each([false, 0, '0', 'no', ' N ', '', null])('retains existing inactive interpretation %#', async active => {
    await insert('a', row('SYN-OTHER', active))
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(await capture(), target, scope.projectNo)).resolves.toBeUndefined()
  })
  it('rejects row overflow before a partial snapshot can look complete, but permits the exact bound', async () => {
    await insert('a', row())
    await insert('b', row('SYN-OTHER', true))
    await expect(capture({ maxRows: 1 })).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_ROW_LIMIT_EXCEEDED' })
    expect(await scan(await capture({ maxRows: 2 }))).toHaveLength(2)
  })
  it('preserves missing vs explicit null cells and cannot manufacture createdBy from stored data', async () => {
    await insert('a', { [scope.projectFieldId]: scope.projectNo, [scope.activeFieldId]: null, createdBy: 'forged' }, scope.sheetId, null)
    const snapshot = await capture()
    const selected = await scan(snapshot, projectFilter)
    expect(selected[0].data).toEqual({ [scope.projectFieldId]: scope.projectNo, [scope.activeFieldId]: null })
    expect(selected[0]).not.toHaveProperty('createdBy')
    const unmapped = await readers.readExistingStockPreparationRows(snapshot, target, scope.projectNo)
    expect(unmapped[0][Symbol.for('metasheet.stock-preparation.existingRow.createdBy')]).toBeUndefined()
  })
  it.each([null, [], 'not-an-object', 42])('fails closed on malformed stored JSON shape %#', async data => {
    await insert('a', data)
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_PROJECTION_INVALID' })
  })
  it('injects system field values from actual metadata, not forged cells, with the same timestamp precision as legacy mapping', async () => {
    const extras = ['createdTime', 'modifiedTime', 'createdBy', 'modifiedBy']
    for (const type of extras) await admin.query('INSERT INTO meta_fields VALUES ($1,$2,$3,\'{}\')', [`sys-${type}`, scope.sheetId, type])
    await insert('a', { ...row(), ...Object.fromEntries(extras.map(type => [`sys-${type}`, 'forged'])) })
    const snapshot = await capture({ fieldIds: [...scope.fieldIds, ...extras.map(type => `sys-${type}`)] })
    expect((await scan(snapshot, projectFilter))[0].data).toMatchObject({
      'sys-createdTime': '2026-10-01T01:02:03.123Z', 'sys-modifiedTime': '2026-10-01T02:03:04.654Z',
      'sys-createdBy': 'record-owner', 'sys-modifiedBy': 'record-editor',
    })
    expect(Object.keys((await scan(snapshot))[0].data)).toHaveLength(2)
  })
  it('does not confuse stored filter values with injected project/active system cells', async () => {
    await admin.query(`UPDATE meta_fields SET type='createdBy' WHERE id=$1`, [scope.projectFieldId])
    await admin.query(`UPDATE meta_fields SET type='modifiedBy' WHERE id=$1`, [scope.activeFieldId])
    await insert('a', row(scope.projectNo, false))
    await insert('b', row('STORED-OTHER', false), scope.sheetId, scope.projectNo)
    const snapshot = await capture()
    const selected = await readers.readExistingStockPreparationRows(snapshot, target, scope.projectNo)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ projectNo: 'record-owner', active: 'record-editor' })
    expect((await scan(snapshot))[1].data).toEqual({ [scope.projectFieldId]: scope.projectNo, [scope.activeFieldId]: 'record-editor' })
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(snapshot, target, scope.projectNo)).rejects.toMatchObject({ code: 'TARGET_SHEET_FOREIGN_PROJECT' })
  })
  it('binds physical field identifiers as values even when they contain SQL syntax', async () => {
    const weird = "physical' OR true --"
    await admin.query('UPDATE meta_fields SET id=$1 WHERE id=$2', [weird, 'physical-value'])
    await insert('a', { ...row(), [weird]: 'synthetic-exact-value' })
    const snapshot = await capture({ fieldIds: [scope.projectFieldId, scope.activeFieldId, weird] })
    expect((await scan(snapshot, projectFilter))[0].data[weird]).toBe('synthetic-exact-value')
    expect(sqlLog.some(sql => sql.includes(weird))).toBe(false)
    expect(wireRows).toHaveLength(1)
  })
  it.each(['hidden-field', 'row-policy', 'no-read', 'deleted-sheet'])('runs actual authority gate before records SQL for %s', async change => {
    await insert('a', row())
    if (change === 'hidden-field') await admin.query(`UPDATE meta_fields SET property='{"hidden":true}' WHERE id=$1`, ['physical-value'])
    if (change === 'row-policy') await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled=true')
    if (change === 'no-read') await admin.query('DELETE FROM user_permissions')
    if (change === 'deleted-sheet') await admin.query('UPDATE meta_sheets SET deleted_at=now()')
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_DENIED' })
    expect(wireRows).toHaveLength(0)
    expect(sqlLog.some(sql => /\bFROM\s+meta_records\b/i.test(sql))).toBe(false)
  })
  it('does not convert a missing table or missing transaction into an empty allowed snapshot', async () => {
    await expect(loadAutomationReadTargetRecords(tracked, { ...scope, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_TRANSACTION_REQUIRED' })
    await admin.query('ALTER TABLE meta_records RENAME TO temporarily_missing_records')
    try { await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_UNAVAILABLE' }) }
    finally { await admin.query('ALTER TABLE temporarily_missing_records RENAME TO meta_records') }
  })
  it('replay observes abort, close and query budgets without issuing another SQL statement', async () => {
    await insert('a', row())
    const controller = new AbortController()
    const snapshot = await capture({ signal: controller.signal, maxQueries: 1 })
    await scan(snapshot)
    await expect(scan(snapshot)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_QUERY_LIMIT_EXCEEDED' })
    const aborted = await capture({ signal: controller.signal })
    controller.abort('not-public')
    await expect(scan(aborted)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_ABORTED' })
    const closed = await capture()
    closed.close()
    await expect(scan(closed)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_CLOSED' })
    expect(sqlLog.filter(sql => /\bFROM\s+meta_records\b/i.test(sql))).toHaveLength(1)
  })

  // SA-06G composes the REAL config normalizer/classifier/contract with the REAL
  // PG authority + projection + plugin target readers. The installed metadata
  // here is explicitly synthetic; no claim of live registry/pack proof yet.
  function adaptationContract(layout: string) {
    const pack = normalizeCustomerPack(rawPack)
    const logicalIds = [...template.fields.map(field => field.id), ...pack.extensionFields.map(field => field.id)]
    const fieldIdMap = Object.fromEntries(logicalIds.map(id => [id, `${layout}-${id}`]))
    const action = { source: { externalSystemId: 'synthetic-canonical-source', kind: 'data-source:sql-readonly' },
      target: { sheetId: scope.sheetId, fieldIdMap }, extensionFieldIds: pack.extensionFields.map(field => field.id) }
    const installedFieldProperties = pack.extensionFields.map(field => ({ fieldId: field.id,
      property: { stockPreparation: { ownership: field.ownership, preserveOnRefresh: field.preserveOnRefresh, extension: true } } }))
    return { input: { action, installedFieldProperties, extFieldMapping: null },
      contract: deriveAutomationReadTargetContract({ action, installedFieldProperties, extFieldMapping: null }) }
  }
  async function installDerivedFields(contract: DerivedTargetContract) {
    await admin.query('DELETE FROM meta_fields')
    // Install from the independent explicit action map, not the projection under
    // test: dropping a projected field must not also delete our hidden fixture.
    for (const id of Object.values(contract.action.target.fieldIdMap)) {
      await admin.query(`INSERT INTO meta_fields VALUES ($1,$2,'string','{}')`, [id, scope.sheetId])
    }
  }
  const captureContract = (contract: DerivedTargetContract) => capture({
    fieldIds: [...contract.projection.fieldIds], projectFieldId: contract.projection.projectFieldId,
    activeFieldId: contract.projection.activeFieldId,
  })
  it.each(['layout-a', 'layout-b'])('derives the full declared template/pack projection for %s and consumes real PG rows', async layout => {
    const { contract } = adaptationContract(layout)
    await installDerivedFields(contract)
    const map = contract.action.target.fieldIdMap
    await insert('a', { [map.projectNo]: scope.projectNo, [map.active]: true,
      [map.material]: 'SYN-material', [map.ext_spec]: 'SYN-spec', [map.ext_blankMass]: 7,
      [map.notes]: 'SYN-preserved-note', undeclared_private: 'SYN-DO-NOT-READ' })
    const snapshot = await captureContract(contract)
    expect(JSON.stringify(wireRows)).not.toContain('SYN-DO-NOT-READ')
    const existing = await readers.readExistingStockPreparationRows(snapshot, contract.action.target, scope.projectNo)
    expect(existing[0]).toMatchObject({ projectNo: scope.projectNo, active: true, material: 'SYN-material',
      ext_spec: 'SYN-spec', ext_blankMass: 7, notes: 'SYN-preserved-note' })
    expect(Object.keys(existing[0]).sort()).toEqual(['active', 'ext_blankMass', 'ext_spec', 'material', 'notes', 'projectNo'])
    await expect(readers.assertTargetSheetHoldsNoForeignActiveRows(snapshot, contract.action.target, scope.projectNo)).resolves.toBeUndefined()
    expect(contract.projection.logicalFieldIds).toEqual([...template.fields.map(field => field.id),
      ...normalizeCustomerPack(rawPack).extensionFields.map(field => field.id)].sort())
  })
  it.each(['notes', 'ext_spec', 'ext_blankMass'])('cannot shrink derived projection around required hidden %s', async logicalId => {
    const { contract } = adaptationContract('layout-gated')
    await installDerivedFields(contract)
    const hidden = await admin.query(`UPDATE meta_fields SET property='{"hidden":true}' WHERE id=$1`, [contract.action.target.fieldIdMap[logicalId]])
    expect(hidden.rowCount).toBe(1)
    await expect(captureContract(contract)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_DENIED' })
    expect(wireRows).toHaveLength(0)
    expect(sqlLog.some(sql => /\bFROM\s+meta_records\b/i.test(sql))).toBe(false)
  })
  it('rejects outside-projection physical aliases before any database access', async () => {
    const { input: material } = adaptationContract('layout-alias')
    material.action.target.fieldIdMap.extra_unused_alias = material.action.target.fieldIdMap.projectNo
    sqlLog.length = 0
    expect(() => deriveAutomationReadTargetContract(material)).toThrow('AUTOMATION_TARGET_CONTRACT_INVALID')
    expect(sqlLog).toHaveLength(0)
  })
})
