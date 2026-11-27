'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { test } = require('node:test')
const { deriveStockPreparationProjectSheetObjectId, deriveStockPreparationBaseId } = require('../lib/stock-preparation-own-base.cjs')
const { planSheets, deleteSheets, existsProjectRoot } = require('../lib/stock-preparation-project-delete-sheets.cjs')
const { planSheetDependencies, deleteSheetDependencies } = require('../lib/stock-preparation-project-delete-sheet-dependencies.cjs')

const scope = { tenantId: 'synthetic', projectNo: 'one' }
const stage = scope.tenantId + ':integration-core'
const object = deriveStockPreparationProjectSheetObjectId(scope.tenantId, scope.projectNo)
const physical = (prefix, ...parts) => prefix + '_' + createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 24)
const id = physical('sheet', stage, object)
const ambiguous = { code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS', status: 409 }
const owner = { id, name: 'Synthetic dedicated sheet', object_id: object, project_id: stage, plugin_name: 'plugin-integration-core', sheet_hash: 's', owner_hash: 'o' }
const target = { sheet_id: id, object_id: object, hash: 'r' }
const pulled = { id: 'pulled', record_id: 'pulled', projectNo: 'one', hash: 'a' }
const manual = { id: 'hand', record_id: 'hand', projectNo: null, idempotencyKey: 'manual:v1:hand', hash: 'b' }
const binned = { id: '00000000-0000-4000-8000-000000000001', record_id: 'bin', projectNo: null, hash: 'c' }

function sheetFixture({ registry = [target], owners = [owner], live = [pulled, manual], trash = [binned] } = {}) {
  const writes = []
  const reads = []
  const tx = { async query(sql, params) {
    reads.push({ sql, params })
    if (sql.includes('FROM integration_stock_prep_project_target t')) return registry
    if (sql.includes('FROM meta_sheets s LEFT JOIN')) return owners
    if (sql.includes('FROM meta_fields f')) return params[1].map(id => ({ sheet_id: params[0][0], id, hash: id }))
    if (sql.includes('FROM meta_records r WHERE r.sheet_id')) return live
    if (sql.includes('FROM meta_records_trash r WHERE r.sheet_id')) return trash
    if (sql.includes('ORDER BY rule') || sql.includes('NOT id = ANY')) return []
    if (sql.startsWith('SELECT 1 FROM meta_records')) return live.length ? [{ exists: 1 }] : []
    if (sql.startsWith('DELETE')) {
      writes.push({ sql, params })
      return Array.from({ length: Array.isArray(params[1]) ? params[1].length : 1 }, () => ({}))
    }
    assert.fail('Unexpected query')
  } }
  return { tx, reads, writes }
}

test('dedicated sheet covers manual and recycled rows; same-count content edits invalidate its fingerprint', async () => {
  const { tx, writes } = sheetFixture()
  const plan = await planSheets(tx, scope)
  assert.equal(plan.counts.dedicatedRows, 2)
  assert.equal(plan.counts.trashRows, 1)
  assert.deepEqual(plan.tables, [{ sheetId: id, name: owner.name, kind: 'dedicated', rowCount: 2 }])
  assert.equal(plan.identityPresent, true)
  assert.deepEqual(plan.ownedTargetSheetIds, [id])
  assert.deepEqual(writes, [])
  const changed = await planSheets(sheetFixture({ live: [pulled, { ...manual, hash: 'changed' }] }).tx, scope)
  assert.notEqual(changed.fingerprint, plan.fingerprint)
  await deleteSheets(tx, scope, plan)
  assert.deepEqual(writes.map(({ sql }) => sql.split(' ')[2]), ['meta_records_trash', 'meta_records', 'integration_stock_prep_project_target', 'plugin_multitable_object_registry', 'meta_sheets'])
  assert.deepEqual(writes[2].params, ['synthetic', 'one', id])
  assert.deepEqual(writes[3].params, [stage, object, 'plugin-integration-core', id])
})

test('registry, ownership, both row ownership signals and writer state are independently enforced', async () => {
  for (const data of [
    { registry: [] }, { owners: [] }, { registry: [{ ...target, object_id: 'wrong' }] },
    { owners: [{ ...owner, plugin_name: 'another-plugin' }] }, { owners: [{ ...owner, project_id: 'foreign:integration-core' }] },
    { live: [{ ...manual, projectNo: 'other' }] },
    { live: [{ ...pulled, idempotencyKey: JSON.stringify({ projectNo: 'other' }) }] },
    { trash: [{ ...binned, projectNo: 'other' }] },
  ]) {
    const { tx, writes } = sheetFixture(data)
    await assert.rejects(planSheets(tx, scope), ambiguous)
    assert.deepEqual(writes, [])
  }
  await assert.rejects(planSheets(sheetFixture({ owners: [{ ...owner, writer_state: 'applying' }] }).tx, scope), {
    code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY', status: 409,
  })
})

test('uses the server-bound shared ownership column and keeps the legacy sheet and managed registry', async () => {
  const legacy = { ...owner, id: 'registered-bound', object_id: 'custom-bound' }
  const data = { registry: [], owners: [legacy], live: [pulled], trash: [] }
  const scoped = { ...scope, boundTarget: { sheetId: legacy.id, objectId: legacy.object_id, fieldIdMap: { projectNo: 'mapped-project-field' } } }
  const { tx, reads, writes } = sheetFixture(data)
  const plan = await planSheets(tx, scoped)
  assert.equal(plan.counts.sharedPullRows, 1)
  assert.equal(plan.dedicatedSheetId, null)
  assert.deepEqual(plan.tables, [{ sheetId: legacy.id, name: legacy.name, kind: 'shared', rowCount: 1 }])
  assert.ok(reads.some(read => read.sql.includes('FROM meta_records r WHERE') && read.params.includes('mapped-project-field')))
  assert.equal(await existsProjectRoot(tx, scoped), true)
  await deleteSheets(tx, scoped, plan)
  assert.deepEqual(writes.map(w => w.params), [[legacy.id, ['pulled']]])
  await assert.rejects(planSheets(sheetFixture({ ...data, live: [{ ...pulled, projectNo: null }] }).tx, scoped), ambiguous)
  await assert.rejects(planSheets(sheetFixture(data).tx, { ...scope, boundTarget: { ...scoped.boundTarget, fieldIdMap: { bogus: 'column' } } }), ambiguous)
  const foreign = sheetFixture({ ...data, owners: [{ ...legacy, project_id: 'other:integration-core' }] })
  assert.equal((await planSheets(foreign.tx, scoped)).identityPresent, false)
  assert.equal(await existsProjectRoot(foreign.tx, scoped), false)
})

test('cross-sheet dependencies block cleanup and ordinary side-table deletes must match the preview', async () => {
  const selected = new Map([[id, { live: ['pulled'], trash: [], recordIds: ['pulled'] }]])
  const inventory = []
  const tx = { query: async sql => sql.includes('NOT id = ANY') ? [] : inventory }
  inventory.push({ rule: 0, n: 1, blocked: true, hash: 'sealed' })
  await assert.rejects(planSheetDependencies(tx, id, selected), {
    code: 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY', status: 409, details: { reason: 'recovery' },
  })
  inventory[0] = { rule: 3, n: 1, blocked: false, hash: 'metadata' }
  const plan = await planSheetDependencies(tx, id, selected)
  assert.equal(plan.count, 1)
  await assert.rejects(deleteSheetDependencies({ query: async () => [{ n: 0 }] }, id, selected, plan), {
    code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE', status: 409,
  })
})


test('pre-registry legacy binding accepts only a live tenant stock-preparation system base', async () => {
  const objectId = 'plm_stock_preparation_sandbox'
  const sheetId = physical('sheet', stage, objectId)
  const legacy = {
    id: sheetId, name: 'Legacy', sheet_hash: 's', object_id: null, plugin_name: null, project_id: null,
    base_id: deriveStockPreparationBaseId(scope.tenantId), owner_id: null, workspace_id: null, base_deleted_at: null,
  }
  const bound = { ...scope, boundTarget: { sheetId, objectId, fieldIdMap: { projectNo: 'mapped' } } }
  const fixture = (change = {}) => sheetFixture({ registry: [], owners: [{ ...legacy, ...change }], live: [pulled], trash: [] })
  assert.equal((await planSheets(fixture().tx, bound)).counts.sharedPullRows, 1)
  for (const change of [
    { base_id: 'default' }, { base_id: deriveStockPreparationBaseId('foreign') }, { owner_id: 'user' }, { workspace_id: 'ws' },
    { deleted_at: new Date() }, { base_deleted_at: new Date() },
  ]) await assert.rejects(planSheets(fixture(change).tx, bound), ambiguous)
})

test('shared MVP proof visits the blocked generation run even with no prep lines, checks inverse joins and preserves tenant controls', async () => {
  const { generationRunId } = require('../lib/stock-preparation-mvp-generation.cjs')
  const generated = generationRunId('platform-id', 'batch')
  const registry = [
    ['project', [{ sourceProjectNo: 'one', projectId: 'platform-id', lastSyncRunId: 'sync' }, { sourceProjectNo: 'two', projectId: 'other' }]],
    ['bom_snapshot_batch', [{ projectId: 'platform-id', snapshotBatchId: 'batch', syncRunId: 'sync' }]],
    ['bom_snapshot_line', [{ snapshotBatchId: 'batch', snapshotLineId: 'line' }]],
    ['line', []],
    ['exception_confirmation', [{ projectId: 'platform-id', snapshotBatchId: 'batch', snapshotLineId: 'line' }]],
    ['run', [{ runId: 'sync', status: 'succeeded' }, { runId: generated, status: 'failed' }]],
  ]
  const sheets = registry.map(([role]) => {
    const objectId = 'plm_stock_preparation_' + role
    return { ...owner, id: physical('sheet', stage, objectId), object_id: objectId }
  })
  const grid = new Map(sheets.map((sheet, i) => [sheet.id, registry[i][1]]))
  const tx = { async query(sql, params) {
    if (sql.includes('FROM integration_stock_prep_project_target t')) return []
    if (sql.includes('FROM meta_sheets s LEFT JOIN')) return sheets
    if (sql.includes('FROM meta_fields f')) {
      const keys = ['sourceProjectNo', 'projectId', 'lastSyncRunId', 'snapshotBatchId', 'snapshotLineId', 'stockPrepLineId', 'createdFromRunId', 'runId', 'status', 'syncRunId']
      return sheets.flatMap(sheet => keys.map(key => {
        const id = physical('fld', stage, sheet.object_id, key)
        return { sheet_id: sheet.id, id, hash: id }
      }))
    }
    if (sql.includes('NOT id = ANY') || sql.includes('ORDER BY rule') || sql.includes('FROM meta_records_trash r')) return []
    if (sql.includes('FROM meta_records r WHERE r.sheet_id')) {
      const keyAt = new Map([...sql.matchAll(/r\.data->\$(\d+)::text AS "(\w+)"/g)].map(m => [m[1], m[2]]))
      const filters = [...sql.matchAll(/btrim\(r\.data->>\$(\d+)::text\) = ANY\(\$(\d+)::text\[\]\)/g)].map(m => [keyAt.get(m[1]), params[Number(m[2]) - 1]])
      const rows = grid.get(params[0])
      return rows.map((row, i) => ({ id: params[0] + i, record_id: params[0] + i, ...row, hash: JSON.stringify(row) }))
        .filter(row => filters.some(([key, values]) => values.includes(row[key])))
    }
    assert.fail('Unexpected query')
  } }
  const plan = await planSheets(tx, scope)
  assert.equal(plan.counts.runRows, 2)
  assert.equal(plan.counts.projectRows, 1)
  assert.equal(plan.counts.snapshotLines, 1)
  assert.equal(plan.counts.preparationLines, 0)
  assert.equal(plan.counts.exceptions, 1)
  assert.deepEqual(plan.tables.map(t => t.kind), Array(5).fill('shared'))
  registry[5][1][1].status = 'running'
  await assert.rejects(planSheets(tx, scope), { code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY', status: 409 })
  registry[5][1][1].status = 'failed'
  registry[1][1].push({ projectId: 'other', snapshotBatchId: 'batch' })
  await assert.rejects(planSheets(tx, scope), ambiguous)
})
