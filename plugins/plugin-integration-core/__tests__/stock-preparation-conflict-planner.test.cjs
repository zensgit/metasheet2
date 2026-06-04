'use strict'

// #2253 C3 tests: conflict planner. Pure node test; no PLM read, no MetaSheet
// write, no route/UI, no K3. Locks add/update/skip/inactive/manual_confirm,
// human-field preservation, no pick-first, and C2 rowErrors -> manual_confirm
// without aborting good expanded rows.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  DECISIONS,
  StockPreparationConflictPlannerError,
  __internals,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

function row(overrides = {}) {
  const componentSourceId = overrides.componentSourceId || 'PART-A'
  const parentSourceId = overrides.parentSourceId === undefined ? null : overrides.parentSourceId
  const pathTokens = overrides.pathTokens || [componentSourceId]
  return {
    projectNo: 'P-001',
    idempotencyKey: JSON.stringify({
      projectNo: 'P-001',
      componentSourceId,
      parentSourceId,
      path: pathTokens,
    }),
    componentSourceId,
    parentSourceId,
    path: JSON.stringify(pathTokens),
    depth: pathTokens.length - 1,
    componentCode: `${componentSourceId}-CODE`,
    componentName: `${componentSourceId} Name`,
    material: 'Steel',
    sourceVersion: 'V1',
    rawQuantity: 2,
    totalQuantity: 2,
    active: true,
    ...overrides,
  }
}

function byDecision(plan, decision) {
  return plan.decisions.filter((entry) => entry.decision === decision)
}

function assertNoHumanFields(payload, message) {
  for (const field of ['materialType', 'blankType', 'stockPreparationStatus', 'demandDate', 'leadTimeDays', 'notes', 'procurementReply', 'warehouseConfirmation']) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload, field), false, `${message}: ${field} must not be present`)
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function testAddUpdateSkipInactive() {
  const addRow = row({ componentSourceId: 'PART-ADD', pathTokens: ['PART-ADD'] })
  const updateRow = row({ componentSourceId: 'PART-UPD', pathTokens: ['PART-UPD'], rawQuantity: 5, totalQuantity: 5 })
  const skipRow = row({ componentSourceId: 'PART-SKIP', pathTokens: ['PART-SKIP'] })
  const inactiveExisting = row({ componentSourceId: 'PART-GONE', pathTokens: ['PART-GONE'] })
  const alreadyInactive = row({ componentSourceId: 'PART-OFF', pathTokens: ['PART-OFF'], active: false })
  const existingUpdate = { ...updateRow, rawQuantity: 4, totalQuantity: 4, notes: 'operator note', materialType: 'human material' }
  const existingSkip = { ...skipRow, notes: 'keep me' }

  const plan = planStockPreparationConflicts({
    expandedRows: [addRow, updateRow, skipRow],
    existingRows: [existingUpdate, existingSkip, inactiveExisting, alreadyInactive],
    runId: 'run-1',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(plan.valid, true)
  assert.deepEqual(plan.counts, {
    add: 1,
    update: 1,
    skip: 2,
    inactive: 1,
    manual_confirm: 0,
  })

  const add = byDecision(plan, DECISIONS.ADD)[0]
  assert.equal(add.idempotencyKey, addRow.idempotencyKey)
  assert.equal(add.record.lastPlmRefreshRunId, 'run-1')
  assert.equal(add.record.lastPlmRefreshDecision, DECISIONS.ADD)
  assertNoHumanFields(add.record, 'add record')

  const update = byDecision(plan, DECISIONS.UPDATE)[0]
  assert.equal(update.idempotencyKey, updateRow.idempotencyKey)
  assert.ok(update.changedFields.includes('rawQuantity'))
  assert.ok(update.changedFields.includes('totalQuantity'))
  assert.equal(update.patch.rawQuantity, 5)
  assert.equal(update.patch.lastPlmRefreshDecision, DECISIONS.UPDATE)
  assertNoHumanFields(update.patch, 'update patch')

  const inactive = byDecision(plan, DECISIONS.INACTIVE)[0]
  assert.equal(inactive.idempotencyKey, inactiveExisting.idempotencyKey)
  assert.deepEqual(inactive.patch.active, false)
  assert.equal(inactive.patch.lastPlmRefreshDecision, DECISIONS.INACTIVE)
  assertNoHumanFields(inactive.patch, 'inactive patch')

  const skipReasons = byDecision(plan, DECISIONS.SKIP).map((entry) => entry.conflictSummary.type).sort()
  assert.deepEqual(skipReasons, ['already_inactive', 'unchanged'])
}

function testRowErrorsDoNotAbortGoodRows() {
  const goodAdd = row({ componentSourceId: 'PART-GOOD', pathTokens: ['PART-GOOD'] })
  const plan = planStockPreparationConflicts({
    expandedRows: [goodAdd],
    existingRows: [],
    rowErrors: [
      { type: 'invalid_quantity', field: 'quantity', depth: 1, relation: 'child' },
    ],
    runId: 'run-2',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(plan.valid, false, 'manual_confirm makes the plan not directly applyable')
  assert.equal(plan.counts.add, 1, 'good rows still plan as add')
  assert.equal(plan.counts.manual_confirm, 1, 'C2 row error plans as manual_confirm')
  const manual = byDecision(plan, DECISIONS.MANUAL_CONFIRM)[0]
  assert.equal(manual.source, 'c2_row_error')
  assert.equal(manual.conflictSummary.type, 'invalid_quantity')
  assert.equal(manual.conflictSummary.field, 'quantity')
}

function testDuplicatesAndConflictsFailClosed() {
  const duplicate = row({ componentSourceId: 'PART-DUP', pathTokens: ['PART-DUP'] })
  const existingDuplicate = row({ componentSourceId: 'PART-EXDUP', pathTokens: ['PART-EXDUP'] })
  const lineageNext = row({ componentSourceId: 'PART-LINE', pathTokens: ['PART-LINE'] })
  const identityNext = row({ componentSourceId: 'PART-ID', pathTokens: ['PART-ID'] })

  const plan = planStockPreparationConflicts({
    expandedRows: [duplicate, { ...duplicate }, lineageNext, identityNext],
    existingRows: [
      existingDuplicate,
      { ...existingDuplicate },
      { ...lineageNext, parentSourceId: 'OTHER-PARENT' },
      { ...identityNext, componentName: 'Different Name' },
    ],
    runId: 'run-3',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(plan.valid, false)
  const types = byDecision(plan, DECISIONS.MANUAL_CONFIRM).map((entry) => entry.conflictSummary.type).sort()
  assert.deepEqual(types, [
    'component_identity_conflict',
    'duplicate_existing_key',
    'duplicate_expanded_key',
    'lineage_mismatch',
  ])
  assert.equal(plan.counts.add, 0, 'duplicates/conflicts do not fall through to add')
  assert.equal(plan.counts.update, 0, 'duplicates/conflicts do not fall through to update')
}

function testMissingKeysAndStrategyGuards() {
  const plan = planStockPreparationConflicts({
    expandedRows: [{ componentSourceId: 'NO-KEY' }],
    existingRows: [{ active: true }],
    runId: 'run-4',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  assert.equal(plan.valid, false)
  assert.deepEqual(
    byDecision(plan, DECISIONS.MANUAL_CONFIRM).map((entry) => entry.conflictSummary.type).sort(),
    ['missing_existing_idempotency_key', 'missing_expanded_idempotency_key'],
  )

  assert.throws(
    () => planStockPreparationConflicts({ expandedRows: [], existingRows: [], conflictStrategy: { deleteByDefault: true } }),
    StockPreparationConflictPlannerError,
    'deleteByDefault rejected',
  )
  assert.throws(
    () => planStockPreparationConflicts({ expandedRows: [], existingRows: [], conflictStrategy: { preserveHumanFields: false } }),
    StockPreparationConflictPlannerError,
    'overwriting human fields rejected',
  )
  assert.throws(
    () => planStockPreparationConflicts({ expandedRows: [], existingRows: [], conflictStrategy: { missingFromPlmPolicy: 'delete' } }),
    StockPreparationConflictPlannerError,
    'delete missing rows rejected',
  )
  assert.throws(
    () => planStockPreparationConflicts({ expandedRows: [], existingRows: [], plannedAt: 'not-a-date' }),
    StockPreparationConflictPlannerError,
    'invalid plannedAt string rejected',
  )
  const plannedAtPlan = planStockPreparationConflicts({
    expandedRows: [],
    existingRows: [],
    plannedAt: '2026-06-04T09:00:00Z',
  })
  assert.equal(plannedAtPlan.plannedAt, '2026-06-04T09:00:00.000Z', 'valid plannedAt string is normalized')
}

function testHumanFieldWhitelistOrderIndependent() {
  const template = clone(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const humanFields = template.fields.filter((field) => field.ownership === 'human_preserved').reverse()
  const systemFields = template.fields.filter((field) => field.ownership !== 'human_preserved')
  template.fields = [...humanFields, ...systemFields]

  const plan = planStockPreparationConflicts({
    template,
    expandedRows: [row({ componentSourceId: 'PART-ORDER', pathTokens: ['PART-ORDER'] })],
    existingRows: [],
    runId: 'run-order',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(plan.valid, true)
  assert.equal(plan.counts.add, 1, 'same human field set is accepted even when template order changes')
  assert.equal(__internals.sameStringSet(['a', 'b', 'c'], ['a', 'a', 'b']), false, 'duplicate right-side entries are not set-equal')
}

function testPrimitiveValueComparisonFastPath() {
  assert.equal(__internals.valuesEqual(undefined, null), true, 'undefined and null retain legacy equivalence')
  assert.equal(__internals.valuesEqual(1, 1), true)
  assert.equal(__internals.valuesEqual(1, '1'), false, 'primitive comparisons stay type-sensitive')
  assert.equal(__internals.valuesEqual(true, false), false)
  assert.equal(__internals.valuesEqual({ a: 1 }, { a: 1 }), true, 'object fallback keeps structural comparison')
  assert.equal(__internals.valuesEqual(['a'], ['a']), true, 'array fallback keeps structural comparison')
}

function testValuesFreeEvidence() {
  const expanded = row({ componentSourceId: 'PART-SECRET', componentName: 'Widget Name', material: 'Copper' })
  const plan = planStockPreparationConflicts({
    expandedRows: [expanded],
    existingRows: [],
    runId: 'run-sensitive',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  const evidence = summarizeConflictPlanForEvidence(plan)
  const text = JSON.stringify(evidence)

  assert.equal(evidence.valid, true)
  assert.equal(evidence.counts.add, 1)
  assert.ok(!text.includes('P-001'), 'evidence must not include project value')
  assert.ok(!text.includes('PART-SECRET'), 'evidence must not include component source id')
  assert.ok(!text.includes('Widget Name'), 'evidence must not include component name')
  assert.ok(!text.includes('Copper'), 'evidence must not include material')
  assert.ok(evidence.humanPreservedFields.includes('notes'), 'evidence may include field names')
}

function main() {
  testAddUpdateSkipInactive()
  testRowErrorsDoNotAbortGoodRows()
  testDuplicatesAndConflictsFailClosed()
  testMissingKeysAndStrategyGuards()
  testHumanFieldWhitelistOrderIndependent()
  testPrimitiveValueComparisonFastPath()
  testValuesFreeEvidence()

  console.log('stock-preparation-conflict-planner.test.cjs OK')
}

main()
