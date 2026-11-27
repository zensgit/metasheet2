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
  await deleteSheets(tx, scope, plan, { deleteDedicatedSheet: async () => { writes.push({ sql: 'host delete meta_sheets' }); return 1 } })
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

test('shared pull ownership checks both projects and the configured PLM key in live and recycled rows', async () => {
  const legacy = { ...owner, id: 'mapped-shared', object_id: 'bound' }
  const scoped = { ...scope, boundTarget: { sheetId: legacy.id, keyField: 'configuredKey',
    fieldIdMap: { projectNo: 'mapped-owner', configuredKey: 'mapped-key' } } }
  const fixture = (live, trash) => sheetFixture({ registry: [], owners: [legacy], live, trash })
  for (const [column, embedded] of [['one', 'two'], ['two', 'one']]) {
    const row = { ...pulled, projectNo: column, idempotencyKey: JSON.stringify({ projectNo: embedded }) }
    for (const f of [fixture([row], []), fixture([], [row])]) {
      await assert.rejects(planSheets(f.tx, scoped), ambiguous)
      assert.deepEqual(f.writes, [])
    }
  }
  const base = JSON.stringify({ projectNo: 'one', componentSourceId: 'part::duplicate:detail' })
  const split = { ...pulled, idempotencyKey: base + '::duplicate:sourceDetail:sha16:1234567890abcdef' }
  const control = { ...pulled, id: 'other', record_id: 'other', projectNo: 'two', idempotencyKey: '{"projectNo":"two"}' }
  const f = fixture([split, control], [])
  const plan = await planSheets(f.tx, scoped)
  assert.deepEqual(plan.selected.get(legacy.id), { live: ['pulled'], trash: [], recordIds: ['pulled'] })
  for (const relation of ['meta_records', 'meta_records_trash']) {
    const read = f.reads.find(r => r.sql.includes('FROM ' + relation + ' r WHERE r.sheet_id'))
    assert.deepEqual(read.params, [legacy.id, 'mapped-owner', 'mapped-key', ['one'], '"one"'])
    assert.ok(read.sql.includes('strpos(r.data->>$3::text, $5::text)'))
  }
  await assert.rejects(planSheets(fixture([{ ...split, idempotencyKey: base + '::duplicate:broken' }], []).tx, scoped), ambiguous)
})

test('cross-sheet dependencies block cleanup and ordinary side-table deletes must match the preview', async () => {
  const selected = new Map([[id, { live: ['pulled'], trash: [], recordIds: ['pulled'] }]])
  const inventory = []
  let commentsRule
  const tx = { query: async sql => {
    if (sql.includes('NOT id = ANY')) return []
    const comments = sql.split('\nUNION ALL\n').find(branch => branch.includes('AS deny FROM meta_comments r WHERE'))
    commentsRule = Number(comments.match(/SELECT (\d+) AS rule/)[1])
    return inventory
  } }
  inventory.push({ rule: 0, n: 1, blocked: true, hash: 'sealed' })
  await assert.rejects(planSheetDependencies(tx, id, selected), {
    code: 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY', status: 409, details: { reason: 'recovery' },
  })
  const stale = { code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE', status: 409 }
  for (const rule of [0, 3, -1, 99999]) {
    const refuseWrite = { query: async () => assert.fail('A refusal-only or unknown dependency cannot be written') }
    await assert.rejects(deleteSheetDependencies(refuseWrite, id, selected, { present: [{ rule, count: 1 }] }), stale)
  }
  inventory[0] = { rule: commentsRule, n: 1, blocked: false, hash: 'metadata' }
  const plan = await planSheetDependencies(tx, id, selected)
  assert.equal(plan.count, 1)
  let writes = 0
  await assert.rejects(deleteSheetDependencies({ query: async (sql, params) => {
    writes++
    assert.match(sql, /DELETE FROM meta_comments r WHERE/)
    assert.deepEqual(params, [id, [id], ['pulled']])
    return [{ n: 0 }]
  } }, id, selected, plan), stale)
  assert.equal(writes, 1)
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

test('runbook-adopted sandbox keeps the managed claim, drops only A rows and releases the project registry', async () => {
  const actualObject = 'plm_stock_preparation_sandbox_legacy'
  const actual = { ...owner, id: physical('sheet', stage, actualObject), object_id: actualObject }
  const registered = { ...target, sheet_id: actual.id, object_id: actualObject }
  const neighbor = { ...pulled, id: 'other-row', record_id: 'other-row', projectNo: 'two', idempotencyKey: '{"projectNo":"two"}' }
  const data = { registry: [registered], owners: [actual], live: [pulled, neighbor], trash: [] }
  const { tx, writes } = sheetFixture(data)
  const plan = await planSheets(tx, scope)
  assert.equal(plan.identityPresent, true)
  assert.deepEqual([plan.dedicatedSheetId, plan.counts.dedicatedSheets, plan.counts.managedRegistrations, plan.counts.projectTargets, plan.counts.sharedPullRows], [null, 0, 0, 1, 1])
  assert.deepEqual(plan.tables, [{ sheetId: actual.id, name: actual.name, kind: 'shared', rowCount: 1 }])
  assert.equal(await existsProjectRoot(tx, scope), true)
  await deleteSheets(tx, scope, plan)
  assert.deepEqual(writes.map(({ sql, params }) => [sql.split(' ')[2], params]), [
    ['meta_records', [actual.id, ['pulled']]], ['integration_stock_prep_project_target', [scope.tenantId, scope.projectNo, actual.id]],
  ])
  const empty = await planSheets(sheetFixture({ ...data, live: [] }).tx, scope)
  assert.deepEqual(empty.tables, [{ sheetId: actual.id, name: actual.name, kind: 'shared', rowCount: 0 }])
  const scoped = { ...scope, boundTarget: { sheetId: actual.id, objectId: actualObject } }
  for (const change of [
    { owners: [] }, { owners: [{ ...actual, object_id: actualObject + '_other' }] },
    { owners: [{ ...actual, project_id: 'another:integration-core' }] }, { owners: [{ ...actual, plugin_name: 'foreign' }] },
    { owners: [{ ...actual, object_id: null, project_id: null, plugin_name: null }] },
    { live: [{ ...pulled, projectNo: null }] },
    { live: [{ ...neighbor, idempotencyKey: '{"projectNo":"one"}' }] },
  ]) await assert.rejects(planSheets(sheetFixture({ ...data, ...change }).tx, scoped), ambiguous)
})

test('a member of a shared checkpoint blocks cleanup even when only the other project has a sealed event', async () => {
  const selected = new Map([['shared', { recordIds: ['A'], live: ['A'], trash: [] }]])
  const tx = { async query(sql, params) {
    if (sql.includes('NOT id = ANY')) return []
    assert.deepEqual(params, [null, ['shared'], ['A']])
    const branch = sql.split('UNION ALL').find(s => s.includes('FROM meta_history_baselines r WHERE'))
    assert.match(branch, /true AS deny/)
    assert.match(branch, /\(r.sheet_id, r.record_id\) IN \(SELECT \* FROM affected\)/)
    return [{ rule: Number(branch.match(/SELECT (\d+) AS rule/)[1]), n: 1, blocked: true, hash: '' }]
  } }
  await assert.rejects(planSheetDependencies(tx, null, selected), {
    status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY', details: { reason: 'recovery' },
  })
})
