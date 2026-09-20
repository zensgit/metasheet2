'use strict'

// GOV-05 (#5647 方案 (c) 第一刀，读侧打标): 托管主表里「导入插的全新行」(野行) 与「插件写的无键行」
// 在 planner 的 existing.missing 分支里分成两类 conflictType + 两个计数。行为零变化:
// 挂起照挂、不写、不删、不阻断 apply。判别位 = meta_records.created_by (插件 INSERT 不含该列 => NULL;
// REST 写带 actorId), 经 unmapRecordFields 以 Symbol 保留键透传, 不落 data、不进 revision 哈希。
//
// values-free: 只出现合成的 projectNo / componentSourceId / actor 占位符与冻结 token。

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  DECISIONS,
  EXISTING_ROW_CREATED_BY,
  EXISTING_MISSING_KEY_CONFLICT_TYPES,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const {
  dryRunStockPreparationAction,
  __internals: { buildRevision, unmapRecordFields, stableStringify },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const PLUGIN_OR_LEGACY = 'missing_existing_idempotency_key'
const FOREIGN = 'foreign_existing_row_missing_idempotency_key'

const PHYSICAL_FIELD_ID_MAP = Object.fromEntries(
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]),
)

const ACTION = {
  actionId: 'plm.stock-preparation.pull-bom.v1',
  source: { externalSystemId: 'plm_source_1', workspaceId: null, readPlan: 'plm.bom' },
  target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
}
const PARAMETERS = { projectNo: 'P-001' }
const KEYED_ROW = Object.freeze({
  idempotencyKey: 'P-001:PART-A',
  projectNo: 'P-001',
  componentSourceId: 'PART-A',
  parentSourceId: null,
  path: ['PART-A'],
  depth: 0,
  active: true,
})

function markForeign(row, actor = 'actor_1') {
  return Object.assign({ ...row }, { [EXISTING_ROW_CREATED_BY]: actor })
}

function manualConfirmTypes(plan) {
  return plan.decisions
    .filter((decision) => decision.decision === DECISIONS.MANUAL_CONFIRM)
    .map((decision) => decision.conflictSummary.type)
    .sort()
}

function planAndRevision(existingRows) {
  const expandedRows = [{ ...KEYED_ROW }]
  const plan = planStockPreparationConflicts({
    expandedRows,
    existingRows,
    runId: 'run-g',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  const expansion = { status: 'complete', rows: expandedRows, errors: [], rowErrors: [] }
  return {
    plan,
    revision: buildRevision({ action: ACTION, parameters: PARAMETERS, expansion, existingRows, conflictPolicyReview: null, plan }),
  }
}

test('vocabulary: the two existing-missing-key conflict types are frozen and distinct', () => {
  assert.deepEqual(EXISTING_MISSING_KEY_CONFLICT_TYPES, { pluginOrLegacy: PLUGIN_OR_LEGACY, foreign: FOREIGN })
  assert.ok(Object.isFrozen(EXISTING_MISSING_KEY_CONFLICT_TYPES))
  assert.equal(typeof EXISTING_ROW_CREATED_BY, 'symbol', 'reserved key is a Symbol, so it can never come out of jsonb data')
})

test('unmapRecordFields carries record.createdBy on the reserved key, outside data/keys/JSON', () => {
  const fieldIdMap = PHYSICAL_FIELD_ID_MAP
  const foreign = unmapRecordFields({ id: 'rec_9', data: { fld_projectNo: 'P-001', fld_active: true }, createdBy: 'actor_1' }, fieldIdMap)
  assert.equal(foreign.projectNo, 'P-001', 'logical unmapping unchanged')
  assert.equal(foreign[EXISTING_ROW_CREATED_BY], 'actor_1')
  assert.deepEqual(Object.keys(foreign).sort(), ['active', 'projectNo'], 'reserved key is not an enumerable string key')
  assert.equal(JSON.stringify(foreign).includes('actor_1'), false, 'reserved key never serializes')
  assert.equal(stableStringify(foreign).includes('actor_1'), false, 'reserved key never reaches hashJson input')
  assert.equal({ ...foreign }[EXISTING_ROW_CREATED_BY], 'actor_1', 'survives the planner normalizeRows copy')

  const plugin = unmapRecordFields({ id: 'rec_1', data: { fld_projectNo: 'P-001' } }, fieldIdMap)
  assert.equal(Object.getOwnPropertySymbols(plugin).length, 0, 'NULL created_by => reserved key ABSENT, not null')
  const blank = unmapRecordFields({ id: 'rec_2', data: { fld_projectNo: 'P-001' }, createdBy: '   ' }, fieldIdMap)
  assert.equal(Object.getOwnPropertySymbols(blank).length, 0, 'blank createdBy is not a marker')
  const forged = unmapRecordFields({ id: 'rec_3', data: { fld_projectNo: 'P-001', createdBy: 'actor_x' } }, fieldIdMap)
  assert.equal(Object.getOwnPropertySymbols(forged).length, 0, 'a createdBy CELL inside data cannot forge the marker')
  assert.equal(forged.createdBy, 'actor_x', 'and the cell itself still unmaps as an ordinary column')
})

test('planner splits existing.missing into plugin/legacy vs foreign and counts each (red before GOV-05)', () => {
  const pluginRow = { id: 'rec_1', projectNo: 'P-001', active: true }
  const foreignRow = markForeign({ id: 'rec_2', projectNo: 'P-001', active: true })
  const { plan } = planAndRevision([{ id: 'rec_0', ...KEYED_ROW }, pluginRow, foreignRow])

  assert.deepEqual(manualConfirmTypes(plan), [FOREIGN, PLUGIN_OR_LEGACY])
  assert.deepEqual(plan.summary.existingRowsMissingKey, { pluginOrLegacy: 1, foreign: 1 })
  assert.deepEqual(plan.summary.conflictTypes, [FOREIGN, PLUGIN_OR_LEGACY, 'unchanged'])
  // Behavior unchanged: both are holds, nothing is written, counts are the same shape.
  assert.equal(plan.counts[DECISIONS.MANUAL_CONFIRM], 2)
  assert.equal(plan.counts.add + plan.counts.update + plan.counts.inactive, 0)
  assert.deepEqual(Object.keys(plan.counts).sort(), ['add', 'inactive', 'manual_confirm', 'skip', 'update'], 'no new key in the hashed counts')
  for (const decision of plan.decisions.filter((entry) => entry.decision === DECISIONS.MANUAL_CONFIRM)) {
    assert.equal(decision.source, 'existing_row')
    assert.equal(decision.idempotencyKey, undefined)
  }
  const evidence = summarizeConflictPlanForEvidence(plan)
  assert.deepEqual(evidence.existingRowsMissingKey, { pluginOrLegacy: 1, foreign: 1 })
  assert.equal(JSON.stringify(plan).includes('actor_1'), false, 'actor never leaks into the plan')
  assert.equal(JSON.stringify(evidence).includes('actor_1'), false, 'actor never leaks into evidence')

  // Asymmetric batch: an inverted NULL/non-NULL test would swap these two numbers.
  const lopsided = planAndRevision([
    { id: 'rec_1', projectNo: 'P-001', active: true },
    { id: 'rec_2', projectNo: 'P-001', active: true },
    markForeign({ id: 'rec_3', projectNo: 'P-001', active: true }),
  ]).plan
  assert.deepEqual(lopsided.summary.existingRowsMissingKey, { pluginOrLegacy: 2, foreign: 1 })
  assert.deepEqual(manualConfirmTypes(lopsided), [FOREIGN, PLUGIN_OR_LEGACY, PLUGIN_OR_LEGACY])
})

test('a foreign row WITH an idempotencyKey is still an ordinary keyed row (only existing.missing is classified)', () => {
  const { plan } = planAndRevision([markForeign({ id: 'rec_0', ...KEYED_ROW })])
  assert.deepEqual(manualConfirmTypes(plan), [])
  assert.equal(Object.prototype.hasOwnProperty.call(plan.summary, 'existingRowsMissingKey'), false,
    'no keyless existing row => no stanza, whole-plan JSON stays byte-identical to pre-GOV-05')
  assert.equal(Object.prototype.hasOwnProperty.call(summarizeConflictPlanForEvidence(plan), 'existingRowsMissingKey'), false)
  assert.equal(plan.counts.skip, 1)
})

test('buildRevision golden: byte-identical to pre-GOV-05 for a batch without foreign rows', () => {
  // Pinned on origin/main @ 62fd24461 (before this change) over the same input.
  const PRE_CHANGE_REVISION = 'fcfc3b7dd2702ceb0cd79e54db097457cf1da160ff21b1600ad24c01f0ce5214'
  const { plan, revision } = planAndRevision([{ id: 'rec_1', ...KEYED_ROW }, { id: 'rec_2', projectNo: 'P-001', active: true }])
  assert.deepEqual(plan.summary.conflictTypes, [PLUGIN_OR_LEGACY, 'unchanged'])
  assert.equal(revision, PRE_CHANGE_REVISION)
})

test('buildRevision golden: the reserved key is outside the hash (marked and unmarked rows hash the same)', () => {
  const expandedRows = [{ ...KEYED_ROW }]
  const expansion = { status: 'complete', rows: expandedRows, errors: [], rowErrors: [] }
  const unmarked = [{ id: 'rec_1', ...KEYED_ROW }, { id: 'rec_2', projectNo: 'P-001', active: true }]
  const marked = [markForeign(unmarked[0]), markForeign(unmarked[1], 'actor_2')]
  // Same plan object on both sides: this isolates the existingRows projection of the hash.
  const plan = planStockPreparationConflicts({ expandedRows, existingRows: unmarked, runId: 'run-g', plannedAt: '2026-06-04T09:00:00.000Z' })
  const left = buildRevision({ action: ACTION, parameters: PARAMETERS, expansion, existingRows: unmarked, conflictPolicyReview: null, plan })
  const right = buildRevision({ action: ACTION, parameters: PARAMETERS, expansion, existingRows: marked, conflictPolicyReview: null, plan })
  assert.equal(left, right)
  assert.equal(left, 'fcfc3b7dd2702ceb0cd79e54db097457cf1da160ff21b1600ad24c01f0ce5214')
})

test('end-to-end dry-run: a REST-created row (createdBy) surfaces as foreign, nothing else moves', async () => {
  const plmData = {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
  const sourceAdapter = {
    async read(input = {}) {
      const rows = Array.isArray(plmData[input.object]) ? plmData[input.object] : []
      const records = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: records.map((row) => ({ ...row })), done: true, nextCursor: null }
    },
  }
  // Two keyless rows under the same projectNo: one plugin-shaped (no createdBy), one REST-shaped.
  const records = [
    { id: 'rec_1', sheetId: 'sheet_stock', version: 1, data: { fld_projectNo: 'P-001', fld_active: true } },
    { id: 'rec_2', sheetId: 'sheet_stock', version: 1, data: { fld_projectNo: 'P-001', fld_active: true }, createdBy: 'actor_1' },
  ]
  const recordsApi = {
    async queryRecords(input = {}) {
      return records
        .filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
        .map((record) => JSON.parse(JSON.stringify(record)))
    },
  }
  const tokens = new Map()
  const tokenStore = {
    async get(key) { return tokens.has(key) ? tokens.get(key) : null },
    async set(key, value) { tokens.set(key, JSON.parse(JSON.stringify(value))) },
    async delete(key) { tokens.delete(key) },
  }
  const dryRun = await dryRunStockPreparationAction({
    action: { ...ACTION, source: { externalSystemId: 'plm_source_1', kind: 'data-source:sql-readonly' }, target: { ...ACTION.target, fieldIdMap: PHYSICAL_FIELD_ID_MAP } },
    parameters: { projectNo: 'P-001' },
    sourceAdapter,
    recordsApi,
    tokenStore,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  // The public dry-run exposes counts + values-free evidence (never the plan or the rows).
  assert.equal(dryRun.status, 'manual_confirm_required', 'holds still surface as before')
  assert.deepEqual(dryRun.evidence.plan.existingRowsMissingKey, { pluginOrLegacy: 1, foreign: 1 })
  assert.deepEqual(dryRun.evidence.plan.conflictTypes, ['add_missing', FOREIGN, PLUGIN_OR_LEGACY])
  assert.equal(dryRun.counts.add, 1, 'the PLM row still ADDs; holds do not block')
  assert.equal(dryRun.counts[DECISIONS.MANUAL_CONFIRM], 2)
  assert.equal(dryRun.canApply, true, 'manual_confirm holds never gate apply (unchanged)')
  assert.equal(typeof dryRun.dryRunToken, 'string')
  assert.equal(JSON.stringify(dryRun).includes('actor_1'), false, 'actor id never leaves the process boundary')
})
