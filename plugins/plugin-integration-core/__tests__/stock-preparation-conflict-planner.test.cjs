'use strict'

// #2253 C3 tests: conflict planner. Pure node test; no PLM read, no MetaSheet
// write, no route/UI, no K3. Locks add/update/skip/inactive/manual_confirm,
// human-field preservation, no pick-first, and C2 rowErrors -> manual_confirm
// without aborting good expanded rows.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  DECISIONS,
  DENORMALIZED_PLM_FIELD_IDS,
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

function testTemplateTypeEquivalentValuesSkipAfterCreate() {
  const expanded = row({
    componentSourceId: 'PART-TYPE',
    parentSourceId: 0,
    pathTokens: ['ROOT', 'PART-TYPE'],
    depth: '1',
    componentCode: 1001,
    componentName: 2002,
    material: 3003,
    sourceVersion: 7,
    rawQuantity: '2',
    totalQuantity: '6',
    active: 'true',
  })
  const existing = {
    ...expanded,
    parentSourceId: '0',
    depth: 1,
    componentCode: '1001',
    componentName: '2002',
    material: '3003',
    sourceVersion: '7',
    rawQuantity: 2,
    totalQuantity: 6,
    active: true,
    lastPlmRefreshDecision: DECISIONS.ADD,
  }

  const plan = planStockPreparationConflicts({
    expandedRows: [expanded],
    existingRows: [existing],
    runId: 'run-type',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(plan.valid, true, 'type-only drift must not force manual confirmation')
  assert.deepEqual(plan.counts, {
    add: 0,
    update: 0,
    skip: 1,
    inactive: 0,
    manual_confirm: 0,
  })
  assert.deepEqual(byDecision(plan, DECISIONS.SKIP).map((entry) => entry.conflictSummary.type), ['unchanged'])
}

function testTemplateNormalizationDoesNotHideRealIdentityOrLineageConflicts() {
  const identityNext = row({
    componentSourceId: 'PART-REAL-ID',
    pathTokens: ['PART-REAL-ID'],
    componentCode: 1001,
  })
  const lineageNext = row({
    componentSourceId: 'PART-REAL-LINE',
    parentSourceId: 0,
    pathTokens: ['ROOT', 'PART-REAL-LINE'],
  })

  const plan = planStockPreparationConflicts({
    expandedRows: [identityNext, lineageNext],
    existingRows: [
      { ...identityNext, componentCode: '1002' },
      { ...lineageNext, parentSourceId: '1' },
    ],
    runId: 'run-real-conflict',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(plan.valid, false)
  assert.deepEqual(
    byDecision(plan, DECISIONS.MANUAL_CONFIRM).map((entry) => entry.conflictSummary.type).sort(),
    ['component_identity_conflict', 'lineage_mismatch'],
  )
  assert.equal(plan.counts.add, 0, 'real conflicts must not fall through to add')
  assert.equal(plan.counts.update, 0, 'real conflicts must not fall through to update')
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

function testDuplicateExpandedKeyDiagnosticsValuesFree() {
  const sameParentA = row({
    idempotencyKey: 'DUP-SAME-PARENT',
    componentSourceId: 'PART-DUP-SAME-A',
    parentSourceId: 'PARENT-SAME',
    path: 'ROOT/PARENT-SAME/PART-DUP',
    pathTokens: ['ROOT', 'PARENT-SAME', 'PART-DUP'],
    componentCode: 'DUP-CODE',
    componentName: 'Duplicate Widget',
    material: 'Secret Alloy',
    totalQuantity: 2,
    sortLine: '10',
  })
  const sameParentB = {
    ...sameParentA,
    componentSourceId: 'PART-DUP-SAME-B',
    totalQuantity: 3,
    sortLine: '20',
  }
  const crossParentA = row({
    idempotencyKey: 'DUP-CROSS-PARENT',
    componentSourceId: 'PART-DUP-CROSS-A',
    parentSourceId: 'PARENT-A',
    path: 'ROOT/PARENT-A/PART-DUP',
    pathTokens: ['ROOT', 'PARENT-A', 'PART-DUP'],
    componentCode: 'CROSS-CODE',
    componentName: 'Cross Parent Widget',
    material: 'Cross Alloy',
    totalQuantity: 5,
    sourceDetailId: 'DETAIL-A',
  })
  const crossParentB = {
    ...crossParentA,
    componentSourceId: 'PART-DUP-CROSS-B',
    parentSourceId: 'PARENT-B',
    path: 'ROOT/PARENT-B/PART-DUP',
    pathTokens: ['ROOT', 'PARENT-B', 'PART-DUP'],
    sourceDetailId: 'DETAIL-B',
  }

  const plan = planStockPreparationConflicts({
    expandedRows: [sameParentA, sameParentB, crossParentA, crossParentB],
    existingRows: [],
    runId: 'run-duplicate-diagnostics',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  const evidence = summarizeConflictPlanForEvidence(plan)
  const diagnostics = evidence.duplicateExpandedKeyDiagnostics

  assert.equal(plan.valid, false)
  assert.equal(evidence.counts.manual_confirm, 2)
  assert.equal(diagnostics.conflictType, 'duplicate_expanded_key')
  assert.equal(diagnostics.groupCount, 2)
  assert.equal(diagnostics.rowCount, 4)
  assert.deepEqual(diagnostics.rowsPerGroup, [{ rowCount: 2, groups: 2 }])
  assert.equal(diagnostics.parentShapeCounts.same_parent, 1)
  assert.equal(diagnostics.parentShapeCounts.cross_parent, 1)
  assert.equal(diagnostics.quantityShapeCounts.varied, 1)
  assert.equal(diagnostics.quantityShapeCounts.all_equal, 1)
  assert.equal(diagnostics.attributeShapeCounts.all_equal, 2)
  assert.equal(diagnostics.stableDiscriminatorCounts.any, 2)
  assert.equal(diagnostics.stableDiscriminatorCounts.pathParent, 1)
  assert.equal(diagnostics.stableDiscriminatorCounts.sourceDetail, 1)
  assert.equal(diagnostics.stableDiscriminatorCounts.sortLine, 1)
  // POLICY HONESTY: allowedPolicies advertises only the policies the planner actually honours.
  // merge_quantity / select_representative / skip_selected stay in the frozen persisted vocabulary
  // (see the POLICY HONESTY section of stock-preparation-conflict-policies.test.cjs) but are never
  // offered as choices.
  assert.deepEqual(diagnostics.allowedPolicies, [
    'hold',
    'keep_multiple_rows',
    'source_correction_required',
  ])
  assert.deepEqual(diagnostics.unimplementedPolicies, [
    'merge_quantity',
    'select_representative',
    'skip_selected',
  ])
  assert.equal(diagnostics.defaultPolicy, 'hold')
  assert.equal(diagnostics.groups.length, 2)
  assert.match(diagnostics.groups[0].fingerprint, /^sha16:[a-f0-9]{16}$/)
  assert.equal(
    __internals.stableFingerprint('DUP-SAME-PARENT'),
    __internals.stableFingerprint('DUP-SAME-PARENT'),
    'collision fingerprints are deterministic',
  )

  const text = JSON.stringify(evidence)
  assert.ok(!text.includes('P-001'), 'evidence must not include project value')
  assert.ok(!text.includes('DUP-SAME-PARENT'), 'evidence must not include raw collision key')
  assert.ok(!text.includes('DUP-CROSS-PARENT'), 'evidence must not include raw collision key')
  assert.ok(!text.includes('PART-DUP'), 'evidence must not include component source ids')
  assert.ok(!text.includes('Duplicate Widget'), 'evidence must not include component names')
  assert.ok(!text.includes('Secret Alloy'), 'evidence must not include material')
  assert.ok(!text.includes('DETAIL-A'), 'evidence must not include source detail ids')
  assert.ok(!text.includes('PARENT-A'), 'evidence must not include parent ids')
  assert.ok(!text.includes('ROOT/PARENT'), 'evidence must not include paths')
}

function duplicatePolicyReviewFor(baseKey, policy = 'keep_multiple_rows', scope = 'table_scope') {
  return {
    conflictType: 'duplicate_expanded_key',
    selectedPolicies: [{
      fingerprint: __internals.stableFingerprint(baseKey),
      policy,
      scope,
    }],
  }
}

function testKeepMultipleRowsResolvesSurgically() {
  const duplicateKey = 'DUP-CROSS-PARENT-KEY'
  const duplicateA = row({
    idempotencyKey: duplicateKey,
    componentSourceId: 'PART-DUP-A',
    parentSourceId: 'PARENT-A',
    path: 'ROOT/PARENT-A/PART-DUP',
    pathTokens: ['ROOT', 'PARENT-A', 'PART-DUP'],
  })
  const duplicateB = row({
    ...duplicateA,
    idempotencyKey: duplicateKey,
    componentSourceId: 'PART-DUP-B',
    parentSourceId: 'PARENT-B',
    path: 'ROOT/PARENT-B/PART-DUP',
    pathTokens: ['ROOT', 'PARENT-B', 'PART-DUP'],
  })
  const clean = row({ componentSourceId: 'PART-CLEAN', pathTokens: ['PART-CLEAN'] })

  const plan = planStockPreparationConflicts({
    expandedRows: [duplicateA, duplicateB, clean],
    existingRows: [],
    duplicatePolicyReview: duplicatePolicyReviewFor(duplicateKey, 'keep_multiple_rows', 'table_scope'),
    runId: 'run-d3-resolve',
    plannedAt: '2026-06-07T09:00:00.000Z',
  })

  assert.equal(plan.valid, true, 'resolved duplicate groups should not leave manual_confirm')
  assert.equal(plan.counts.add, 3)
  assert.equal(plan.counts.manual_confirm, 0)
  const addKeys = byDecision(plan, DECISIONS.ADD).map((entry) => entry.idempotencyKey)
  const duplicateKeys = addKeys.filter((key) => key.startsWith(`${duplicateKey}::duplicate:pathParent:`))
  assert.equal(duplicateKeys.length, 2, 'only the duplicate group receives surgical discriminator keys')
  assert.equal(new Set(duplicateKeys).size, 2, 'resolved duplicate keys are distinct')
  assert.ok(addKeys.includes(clean.idempotencyKey), 'clean row keeps its original idempotency key')

  const resolution = summarizeConflictPlanForEvidence(plan).duplicateExpandedKeyResolution
  assert.equal(resolution.resolvedGroupCount, 1)
  assert.equal(resolution.resolvedRowCount, 2)
  assert.equal(resolution.tableScopeResolvedGroupCount, 1, 'saved table-scope policy activation is explicit')
  assert.equal(resolution.heldGroupCount, 0)
  assert.equal(resolution.resolvedPolicies[0].discriminator, 'pathParent')
  const text = JSON.stringify(resolution)
  assert.ok(!text.includes('PARENT-A'), 'resolution evidence hides parent values')
  assert.ok(!text.includes('ROOT/PARENT'), 'resolution evidence hides paths')
}

function testDuplicateResolutionEvidenceValuesFree() {
  const resolvedKey = 'DUP-RESOLVED-SECRET-KEY'
  const heldKey = 'DUP-HELD-SECRET-KEY'
  const resolvedA = row({
    idempotencyKey: resolvedKey,
    projectNo: 'PROJECT-LEAK',
    componentSourceId: 'COMP-RESOLVED-A',
    parentSourceId: 'PARENT-RESOLVED-A',
    path: 'ROOT/PARENT-RESOLVED-A/COMP-RESOLVED',
    pathTokens: ['ROOT', 'PARENT-RESOLVED-A', 'COMP-RESOLVED'],
    componentCode: 'RESOLVED-CODE',
    componentName: 'Resolved Secret Widget',
    material: 'Resolved Secret Alloy',
    sourceDetailId: 'DETAIL-RESOLVED-A',
    sortLine: 'SORT-RESOLVED-A',
  })
  const resolvedB = {
    ...resolvedA,
    componentSourceId: 'COMP-RESOLVED-B',
    parentSourceId: 'PARENT-RESOLVED-B',
    path: 'ROOT/PARENT-RESOLVED-B/COMP-RESOLVED',
    pathTokens: ['ROOT', 'PARENT-RESOLVED-B', 'COMP-RESOLVED'],
    sourceDetailId: 'DETAIL-RESOLVED-B',
    sortLine: 'SORT-RESOLVED-B',
  }
  const heldA = row({
    idempotencyKey: heldKey,
    projectNo: 'PROJECT-LEAK',
    componentSourceId: 'COMP-HELD-A',
    parentSourceId: 'PARENT-HELD',
    path: 'ROOT/PARENT-HELD/COMP-HELD',
    pathTokens: ['ROOT', 'PARENT-HELD', 'COMP-HELD'],
    componentCode: 'HELD-CODE',
    componentName: 'Held Secret Widget',
    material: 'Held Secret Alloy',
    sourceDetailId: '',
    sortLine: '',
  })
  const heldB = {
    ...heldA,
    componentSourceId: 'COMP-HELD-B',
  }

  const plan = planStockPreparationConflicts({
    expandedRows: [resolvedA, resolvedB, heldA, heldB],
    existingRows: [],
    duplicatePolicyReview: {
      conflictType: 'duplicate_expanded_key',
      selectedPolicies: [
        { fingerprint: __internals.stableFingerprint(resolvedKey), policy: 'keep_multiple_rows', scope: 'table_scope' },
        { fingerprint: __internals.stableFingerprint(heldKey), policy: 'keep_multiple_rows', scope: 'run_only' },
      ],
    },
    runId: 'run-d3-resolution-evidence',
    plannedAt: '2026-06-07T09:00:00.000Z',
  })
  const evidence = summarizeConflictPlanForEvidence(plan)
  const resolution = evidence.duplicateExpandedKeyResolution
  const text = JSON.stringify(resolution)

  assert.equal(evidence.valid, false, 'held group keeps the overall plan fail-closed')
  assert.equal(resolution.resolvedGroupCount, 1)
  assert.equal(resolution.resolvedRowCount, 2)
  assert.equal(resolution.heldGroupCount, 1)
  assert.equal(resolution.heldRowCount, 2)
  assert.equal(resolution.tableScopeResolvedGroupCount, 1)
  assert.equal(resolution.runOnlyResolvedGroupCount, 0)
  assert.equal(resolution.heldReasonCounts.missing_stable_discriminator, 1)
  assert.equal(resolution.resolvedPolicies[0].discriminator, 'sourceDetail')
  assert.equal(resolution.heldPolicies[0].reason, 'missing_stable_discriminator')

  for (const sensitive of [
    'PROJECT-LEAK',
    'DUP-RESOLVED-SECRET-KEY',
    'DUP-HELD-SECRET-KEY',
    'COMP-RESOLVED',
    'COMP-HELD',
    'PARENT-RESOLVED',
    'PARENT-HELD',
    'ROOT/',
    'RESOLVED-CODE',
    'HELD-CODE',
    'Resolved Secret Widget',
    'Held Secret Widget',
    'Resolved Secret Alloy',
    'Held Secret Alloy',
    'DETAIL-RESOLVED',
    'SORT-RESOLVED',
  ]) {
    assert.ok(!text.includes(sensitive), `duplicate resolution evidence must not include ${sensitive}`)
  }
}

function testKeepMultipleRowsCleanToCollisionHolds() {
  const duplicateKey = 'DUP-CLEAN-TO-COLLISION'
  const duplicateA = row({ idempotencyKey: duplicateKey, componentSourceId: 'PART-DUP-A', parentSourceId: 'PARENT-A', pathTokens: ['ROOT', 'PARENT-A', 'PART-DUP'] })
  const duplicateB = row({ ...duplicateA, componentSourceId: 'PART-DUP-B', parentSourceId: 'PARENT-B', pathTokens: ['ROOT', 'PARENT-B', 'PART-DUP'] })

  const plan = planStockPreparationConflicts({
    expandedRows: [duplicateA, duplicateB],
    existingRows: [{ ...duplicateA, idempotencyKey: duplicateKey, notes: 'already written clean row' }],
    duplicatePolicyReview: duplicatePolicyReviewFor(duplicateKey, 'keep_multiple_rows', 'table_scope'),
    runId: 'run-d3-clean-collision',
    plannedAt: '2026-06-07T09:00:00.000Z',
  })

  assert.equal(plan.valid, false)
  assert.equal(plan.counts.add, 0, 'clean-to-collision must not silently add re-keyed rows')
  assert.equal(plan.counts.inactive, 0, 'clean-to-collision must not orphan the existing base-key row')
  assert.equal(plan.counts.manual_confirm, 1)
  const resolution = summarizeConflictPlanForEvidence(plan).duplicateExpandedKeyResolution
  assert.equal(resolution.heldGroupCount, 1)
  assert.equal(resolution.heldReasonCounts.clean_to_collision_requires_review, 1)
}

function testKeepMultipleRowsWithoutStableDiscriminatorHolds() {
  const duplicateKey = 'DUP-NO-STABLE-DISCRIMINATOR'
  const duplicateA = row({ idempotencyKey: duplicateKey, componentSourceId: 'PART-DUP', pathTokens: ['PART-DUP'] })
  const duplicateB = { ...duplicateA }

  const plan = planStockPreparationConflicts({
    expandedRows: [duplicateA, duplicateB],
    existingRows: [],
    duplicatePolicyReview: duplicatePolicyReviewFor(duplicateKey, 'keep_multiple_rows', 'run_only'),
    runId: 'run-d3-no-discriminator',
    plannedAt: '2026-06-07T09:00:00.000Z',
  })

  assert.equal(plan.valid, false)
  assert.equal(plan.counts.add, 0)
  assert.equal(plan.counts.manual_confirm, 1)
  const resolution = summarizeConflictPlanForEvidence(plan).duplicateExpandedKeyResolution
  assert.equal(resolution.runOnlyResolvedGroupCount, 0)
  assert.equal(resolution.heldReasonCounts.missing_stable_discriminator, 1)
}

function testSourceCorrectionRequiredHoldsWithExplicitReason() {
  const duplicateKey = 'DUP-SOURCE-CORRECTION'
  const duplicateA = row({
    idempotencyKey: duplicateKey,
    projectNo: 'PROJECT-LEAK',
    componentSourceId: 'COMP-SOURCE-CORRECTION-A',
    parentSourceId: 'PARENT-SOURCE-CORRECTION',
    path: 'ROOT/PARENT-SOURCE-CORRECTION/COMP-SOURCE-CORRECTION',
    pathTokens: ['ROOT', 'PARENT-SOURCE-CORRECTION', 'COMP-SOURCE-CORRECTION'],
    componentCode: 'SOURCE-CORRECTION-CODE',
    componentName: 'Source Correction Widget',
    material: 'Source Correction Alloy',
  })
  const duplicateB = {
    ...duplicateA,
    componentSourceId: 'COMP-SOURCE-CORRECTION-B',
  }

  const plan = planStockPreparationConflicts({
    expandedRows: [duplicateA, duplicateB],
    existingRows: [],
    duplicatePolicyReview: duplicatePolicyReviewFor(duplicateKey, 'source_correction_required', 'table_scope'),
    runId: 'run-d4-source-correction',
    plannedAt: '2026-06-08T09:00:00.000Z',
  })

  assert.equal(plan.valid, false, 'source correction keeps the plan fail-closed')
  assert.equal(plan.counts.add, 0, 'source correction must not produce add decisions')
  assert.equal(plan.counts.update, 0, 'source correction must not produce update decisions')
  assert.equal(plan.counts.skip, 0, 'source correction must not produce skip decisions')
  assert.equal(plan.counts.inactive, 0, 'source correction must not produce inactive decisions')
  assert.equal(plan.counts.manual_confirm, 1)

  const evidence = summarizeConflictPlanForEvidence(plan)
  const resolution = evidence.duplicateExpandedKeyResolution
  const held = resolution.heldPolicies[0]
  assert.equal(resolution.heldGroupCount, 1)
  assert.equal(resolution.heldRowCount, 2)
  assert.equal(resolution.heldReasonCounts.source_correction_required, 1)
  assert.equal(resolution.heldReasonCounts.unsupported_policy || 0, 0)
  assert.equal(held.policy, 'source_correction_required')
  assert.equal(held.reason, 'source_correction_required')
  assert.equal(held.scope, 'table_scope')
  assert.equal(held.rowCount, 2)

  const text = JSON.stringify(resolution)
  for (const sensitive of [
    'PROJECT-LEAK',
    duplicateKey,
    'COMP-SOURCE-CORRECTION',
    'PARENT-SOURCE-CORRECTION',
    'ROOT/',
    'SOURCE-CORRECTION-CODE',
    'Source Correction Widget',
    'Source Correction Alloy',
  ]) {
    assert.ok(!text.includes(sensitive), `source-correction evidence must not include ${sensitive}`)
  }
}

function testUnimplementedDuplicatePoliciesRemainHeldAsUnsupported() {
  for (const policy of ['merge_quantity', 'select_representative', 'skip_selected']) {
    const duplicateKey = `DUP-${policy}`
    const duplicateA = row({ idempotencyKey: duplicateKey, componentSourceId: `PART-${policy}` })
    const duplicateB = { ...duplicateA }

    const plan = planStockPreparationConflicts({
      expandedRows: [duplicateA, duplicateB],
      existingRows: [],
      duplicatePolicyReview: duplicatePolicyReviewFor(duplicateKey, policy, 'run_only'),
      runId: `run-${policy}`,
      plannedAt: '2026-06-08T09:00:00.000Z',
    })

    assert.equal(plan.valid, false, `${policy} must remain fail-closed`)
    assert.equal(plan.counts.add, 0, `${policy} must not produce add decisions`)
    assert.equal(plan.counts.update, 0, `${policy} must not produce update decisions`)
    assert.equal(plan.counts.skip, 0, `${policy} must not produce skip decisions`)
    assert.equal(plan.counts.inactive, 0, `${policy} must not produce inactive decisions`)
    assert.equal(plan.counts.manual_confirm, 1)
    const resolution = summarizeConflictPlanForEvidence(plan).duplicateExpandedKeyResolution
    assert.equal(resolution.heldReasonCounts.unsupported_policy, 1)
    assert.equal(resolution.heldPolicies[0].policy, policy)
    assert.equal(resolution.heldPolicies[0].reason, 'unsupported_policy')
  }
}

// ── O1-B: identity for the ANONYMOUS hold families ──────────────────────────
//
// RED-witnessed guards (mutation table in the landing commit body):
//   O1B-P1  every identity-capable anonymous family gets a derived identity,
//           at the granularity its emitter actually supports
//   O1B-P2  the identity is a pure function of the plan input (repeat-plan
//           reproducibility, the property supersede/reopen leans on)
//   O1B-P3  the reserved namespace is enforced at the planner too: an
//           idempotencyKey may not impersonate a derived identity
//   O1B-P4  a hold whose emitter attached nothing stable gets NO identity
//           (honest deferral, never a hash of nothing)
//   O1B-P5  keyed holds are untouched — no identity field appears on them

const ANONYMOUS_IDENTITY_PREFIX = 'anon-hold:v1:'

function anonymousPlanInput() {
  // Every identity-capable family shape at once, plus both deferral shapes.
  return {
    expandedRows: [
      row({ componentSourceId: 'PART-OK', pathTokens: ['PART-OK'] }),
      // keyless expanded row WITH lineage -> `row` granularity
      { projectNo: 'P-001', componentSourceId: 'PART-NOKEY', path: '["PART-NOKEY"]', depth: 0 },
    ],
    existingRows: [
      // keyless existing row WITH lineage -> `row` granularity
      { projectNo: 'P-001', componentSourceId: 'PART-OLD', parentSourceId: null, path: '["PART-OLD"]', depth: 0, active: true },
      // keyless existing row with NO discriminator at all -> deferral
      { active: true },
    ],
    rowErrors: [
      // two errors on the SAME locus -> one identity, deliberately
      { type: 'missing_component', field: 'OBJ_ID', depth: 2 },
      { type: 'missing_component', field: 'OBJ_ID', depth: 2 },
      // same type, different depth -> different locus
      { type: 'missing_component', field: 'OBJ_ID', depth: 3 },
      // depth 0 is a REAL discriminator, not a blank
      { type: 'missing_order_id', field: 'OrderNo', depth: 0 },
      { type: 'invalid_quantity', field: 'Qty', depth: 0, relation: 'root' },
      { type: 'invalid_quantity', field: 'Qty', depth: 0, relation: 'child' },
      // ext-mapping coercion refusal -> `cell` granularity
      { type: 'SOURCE_VALUE_NOT_A_NUMBER', target: 'ext_weight', sourceColumn: 'WGT', expectedType: 'number', depth: 0 },
      { type: 'SOURCE_VALUE_SECRET_SHAPED', target: 'ext_token', sourceColumn: 'TOK', expectedType: 'string', depth: 0 },
      // the unvalidated umbrella fallback: no type, no context -> deferral
      { message: 'only a message' },
    ],
    runId: 'run-o1b',
    plannedAt: '2026-06-04T09:00:00.000Z',
  }
}

function anonymousHolds(plan) {
  return plan.decisions.filter((entry) => entry.decision === DECISIONS.MANUAL_CONFIRM && !entry.idempotencyKey)
}

function testO1bAnonymousFamiliesGetGranularityCorrectIdentities() {
  const plan = planStockPreparationConflicts(anonymousPlanInput())
  const holds = anonymousHolds(plan)
  const identified = holds.filter((entry) => entry.derivedRowIdentity)
  const deferred = holds.filter((entry) => !entry.derivedRowIdentity)

  // O1B-P1: identity present exactly where the emitter carries stable context.
  assert.equal(holds.length, 12, 'every keyless hold is an anonymous hold')
  assert.equal(identified.length, 10)
  assert.deepEqual(
    deferred.map((entry) => entry.conflictSummary.type).sort(),
    ['c2_row_error', 'missing_existing_idempotency_key'],
    'O1B-P4: the contextless umbrella fallback and the discriminator-less row defer',
  )

  const identityByType = {}
  for (const hold of identified) {
    const type = hold.conflictSummary.type
    identityByType[type] = identityByType[type] || new Set()
    identityByType[type].add(hold.derivedRowIdentity)
  }

  // Granularity is encoded in the identity itself, so a reviewer can read it
  // off a ledger row without re-deriving anything.
  const granularityOf = (identity) => identity.slice(ANONYMOUS_IDENTITY_PREFIX.length).split(':')[0]
  for (const hold of identified) {
    assert.ok(hold.derivedRowIdentity.startsWith(ANONYMOUS_IDENTITY_PREFIX), 'identities are namespaced')
    assert.match(hold.derivedRowIdentity, /:sha256:[0-9a-f]{32}$/, 'identities are HASHES, never plaintext context')
  }
  assert.equal(granularityOf([...identityByType.missing_expanded_idempotency_key][0]), 'row')
  assert.equal(granularityOf([...identityByType.missing_existing_idempotency_key][0]), 'row')
  assert.equal(granularityOf([...identityByType.missing_component][0]), 'locus')
  assert.equal(granularityOf([...identityByType.missing_order_id][0]), 'locus')
  assert.equal(granularityOf([...identityByType.SOURCE_VALUE_NOT_A_NUMBER][0]), 'cell')
  assert.equal(granularityOf([...identityByType.SOURCE_VALUE_SECRET_SHAPED][0]), 'cell')

  // Locus semantics, stated as an assertion: same (type, field, depth) folds to
  // ONE identity; a different depth or relation is a DIFFERENT locus.
  assert.equal(identityByType.missing_component.size, 2, 'depth separates loci; same depth folds')
  assert.equal(identityByType.invalid_quantity.size, 2, 'relation separates loci')

  // No collision across families, granularities or loci.
  const all = identified.map((entry) => entry.derivedRowIdentity)
  assert.equal(new Set(all).size, 9, 'exactly 9 distinct identities behind 10 identified holds')

  // A source id that went INTO a hash must not come back OUT of the plan.
  for (const identity of new Set(all)) {
    for (const secret of ['PART-NOKEY', 'PART-OLD', 'OBJ_ID', 'ext_weight', 'WGT', 'P-001']) {
      assert.equal(identity.includes(secret), false, `identity must not leak ${secret}`)
    }
  }
}

function testO1bIdentityIsReproducibleFromTheSameInput() {
  // O1B-P2. Two independent planner runs over equal (not shared) input must
  // produce identical identities — without this, every reconcile would
  // supersede its own ledger rows and no confirmation could ever stick.
  const first = planStockPreparationConflicts(clone(anonymousPlanInput()))
  const second = planStockPreparationConflicts(clone(anonymousPlanInput()))
  const identitiesOf = (plan) => anonymousHolds(plan).map((entry) => entry.derivedRowIdentity || null)
  assert.deepEqual(identitiesOf(first), identitiesOf(second), 'identity must be a pure function of the input')

  // Key order in the source object must not move the identity either.
  const reordered = planStockPreparationConflicts({
    expandedRows: [],
    existingRows: [],
    rowErrors: [{ depth: 2, type: 'missing_component', field: 'OBJ_ID' }],
    runId: 'run-o1b',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  const straight = planStockPreparationConflicts({
    expandedRows: [],
    existingRows: [],
    rowErrors: [{ type: 'missing_component', field: 'OBJ_ID', depth: 2 }],
    runId: 'run-o1b',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  assert.equal(
    anonymousHolds(reordered)[0].derivedRowIdentity,
    anonymousHolds(straight)[0].derivedRowIdentity,
    'stable stringification makes key order irrelevant',
  )

  // A canonical read that hands `depth` back as a string must NOT re-key the row.
  const numericDepth = planStockPreparationConflicts({
    expandedRows: [],
    existingRows: [{ projectNo: 'P-001', componentSourceId: 'PART-OLD', depth: 2, active: true }],
    runId: 'run-o1b',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  const stringDepth = planStockPreparationConflicts({
    expandedRows: [],
    existingRows: [{ projectNo: 'P-001', componentSourceId: 'PART-OLD', depth: '2', active: true }],
    runId: 'run-o1b',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  assert.equal(
    anonymousHolds(numericDepth)[0].derivedRowIdentity,
    anonymousHolds(stringDepth)[0].derivedRowIdentity,
    'scalar normalisation survives the records-API round trip',
  )
}

function testO1bKeyedHoldsAndTheReservedNamespaceAreUntouched() {
  // O1B-P5: a keyed hold carries no identity field at all — the decision object
  // of every pre-O1-B class is unchanged, so no existing fingerprint moves.
  const duplicate = row({ componentSourceId: 'PART-DUP', pathTokens: ['PART-DUP'] })
  const plan = planStockPreparationConflicts({
    expandedRows: [duplicate, { ...duplicate }],
    existingRows: [],
    runId: 'run-o1b',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  const keyed = plan.decisions.filter((entry) => entry.decision === DECISIONS.MANUAL_CONFIRM && entry.idempotencyKey)
  assert.equal(keyed.length, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(keyed[0], 'derivedRowIdentity'), false)

  // O1B-P3: the reserved namespace is fenced at the planner, not only at the
  // ledger. A HOLD whose idempotencyKey impersonates a derived identity is
  // refused rather than keyed under somebody else's addressing scheme — this is
  // the ledger-relevant surface, since only holds ever reach the ledger.
  const forgedKey = `${ANONYMOUS_IDENTITY_PREFIX}row:sha256:${'0'.repeat(32)}`
  const forged = row({ idempotencyKey: forgedKey })
  assert.throws(
    () => planStockPreparationConflicts({
      expandedRows: [forged, { ...forged }],
      existingRows: [],
      rowErrors: [],
      runId: 'run-o1b',
      plannedAt: '2026-06-04T09:00:00.000Z',
    }),
    StockPreparationConflictPlannerError,
    'a forged anonymous-namespace idempotencyKey must be refused',
  )

  // THE WALL IS UNTOUCHED: a hold never carries a record or a patch, so adding
  // identity added no write capability anywhere.
  for (const hold of plan.decisions.filter((entry) => entry.decision === DECISIONS.MANUAL_CONFIRM)) {
    assert.equal(Object.prototype.hasOwnProperty.call(hold, 'record'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(hold, 'patch'), false)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 备料主表 gains 父组件图号 / 父组件名称 / 规格
//
// RED WITNESSES for the three PLM columns the WORKING SHEET was missing. They are
// composed at record construction, from the SAME expansion batch the snapshot line
// is built from:
//   * the parent pair through the in-batch parent index (the expansion emits the
//     parent as an OBJ_ID only), and
//   * 规格 from the expansion row's `spec`, which exists ONLY where the deployment
//     DECLARED readPlan.part.specField — undeclared means an empty column, never a
//     guessed source column and never a throw.
// ─────────────────────────────────────────────────────────────────────────────

// A two-level batch: one root and one child of it, as the expander emits them.
function parentChildBatch(childOverrides = {}) {
  const parent = row({ componentSourceId: 'PART-ROOT', componentCode: 'TZ-0001', componentName: '主体组件' })
  const child = row({
    componentSourceId: 'PART-CHILD',
    parentSourceId: 'PART-ROOT',
    pathTokens: ['PART-ROOT', 'PART-CHILD'],
    componentCode: 'GJ-0007',
    componentName: '筒体',
    ...childOverrides,
  })
  return { parent, child }
}

// 父组件名称 = 父件的**未切分** identityName(老系统口径),不是 F1c 切出来的首段。
//
// 老系统 StockInfoController 754-755:
//   stockInfo.setParentComponentCode(parentBomInfo.getIdentityNo());
//   stockInfo.setParentComponentName(parentBomInfo.getIdentityName());
// —— 父件那一侧取的是 identityName **全串**,老系统导出第 5 列 父组件名称 打印的就是它。切分
// (fillBasicStockInfo 762-770 的 split(" ", 2))只作用在**当前组件**那一侧的 名称/规格 上。
//
// F1c 把展开层的 `componentName` 改成了首段,如果这里照抄 `parent.componentName`,父组件名称 就从
// 「主体组件 DN1200」悄悄退成「主体组件」—— 既偏离老系统,也是对改前行为的回退。行上现成有全串
// (展开层 createRow 落的 `nameAndSpec`),所以先取它。
//
// 把 `firstPresentValue(parent, EXPANSION_NAME_AND_SPEC_KEYS)` 换回 `parent.componentName` ⇒ 本用例必红。
function testParentComponentNameIsTheUnsplitLegacyString() {
  const { parent, child } = parentChildBatch()
  parent.nameAndSpec = '主体组件 DN1200'
  const plan = planStockPreparationConflicts({
    expandedRows: [parent, child],
    existingRows: [],
    runId: 'run-parent-unsplit',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  const childAdd = byDecision(plan, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD')
  assert.equal(
    childAdd.record.parentComponentName,
    '主体组件 DN1200',
    '父组件名称 取父件未切分的 名称及规格(老系统 754-755),不是 F1c 切出来的首段',
  )
  // 负控:父件没有全串时退回首段 —— 改前写进去的老行、以及源行本就没有 名称及规格 的行,
  // 都不会因为这条规则而丢值。
  const plain = parentChildBatch()
  const plainPlan = planStockPreparationConflicts({
    expandedRows: [plain.parent, plain.child],
    existingRows: [],
    runId: 'run-parent-fallback',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  const plainChild = byDecision(plainPlan, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD')
  assert.equal(plainChild.record.parentComponentName, '主体组件', '父件没有全串时退回 componentName,不丢值')
}

function testDenormalizedParentAndSpecReachTheMainRow() {
  const { parent, child } = parentChildBatch({ spec: 'DN1200' })
  const plan = planStockPreparationConflicts({
    expandedRows: [parent, child],
    existingRows: [],
    runId: 'run-parent-spec',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  const adds = byDecision(plan, DECISIONS.ADD)
  assert.equal(adds.length, 2, 'both rows are added')

  const childAdd = adds.find((decision) => decision.record.componentSourceId === 'PART-CHILD')
  assert.equal(childAdd.record.parentComponentCode, 'TZ-0001', '父组件图号 lands on the child row')
  assert.equal(childAdd.record.parentComponentName, '主体组件', '父组件名称 lands on the child row')
  assert.equal(childAdd.record.componentSpec, 'DN1200', '规格 lands on the row')
  // ALL SEVEN on one record — the claim the project export depends on.
  for (const [fieldId, expected] of [
    ['parentComponentCode', 'TZ-0001'],
    ['parentComponentName', '主体组件'],
    ['componentCode', 'GJ-0007'],
    ['componentName', '筒体'],
    ['componentSpec', 'DN1200'],
    ['material', 'Steel'],
    ['totalQuantity', 2],
  ]) {
    assert.equal(childAdd.record[fieldId], expected, `the seven fields are all on the main row: ${fieldId}`)
  }
  assertNoHumanFields(childAdd.record, 'parent/spec add record')

  // A ROOT row has no parent: absence, not an empty string. `spec` still rides.
  const rootAdd = adds.find((decision) => decision.record.componentSourceId === 'PART-ROOT')
  assert.equal(Object.prototype.hasOwnProperty.call(rootAdd.record, 'parentComponentCode'), false, 'a root row carries no 父组件图号 key at all')
  assert.equal(Object.prototype.hasOwnProperty.call(rootAdd.record, 'parentComponentName'), false, 'a root row carries no 父组件名称 key at all')
}

function testUndeclaredSpecSlotYieldsAnEmptyColumnAndNoError() {
  // The DEFAULT read plan declares no part.specField, so the expansion row has no `spec` key at
  // all. That must be an empty column, never a crash and never a guessed source column.
  const { parent, child } = parentChildBatch()
  assert.equal(Object.prototype.hasOwnProperty.call(child, 'spec'), false, 'the fixture models an undeclared spec slot')
  const plan = planStockPreparationConflicts({
    expandedRows: [parent, child],
    existingRows: [],
    runId: 'run-no-spec',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  assert.equal(plan.valid, true, 'a deployment with no declared spec slot plans cleanly')
  for (const decision of byDecision(plan, DECISIONS.ADD)) {
    assert.equal(Object.prototype.hasOwnProperty.call(decision.record, 'componentSpec'), false, 'no 规格 key is invented')
  }
  // The parent join is unaffected by the missing spec slot.
  const childAdd = byDecision(plan, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD')
  assert.equal(childAdd.record.parentComponentCode, 'TZ-0001')

  // A blank spec is the same as an absent one — no empty-string cell.
  for (const blank of ['', '   ', null, undefined]) {
    const blanked = parentChildBatch({ spec: blank })
    const blankPlan = planStockPreparationConflicts({
      expandedRows: [blanked.parent, blanked.child],
      existingRows: [],
      runId: 'run-blank-spec',
      plannedAt: '2026-09-02T00:00:00.000Z',
    })
    const add = byDecision(blankPlan, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD')
    assert.equal(Object.prototype.hasOwnProperty.call(add.record, 'componentSpec'), false, `blank spec ${JSON.stringify(blank)} writes no cell`)
  }
}

function testUnresolvableParentIsAbsenceNotAGuess() {
  // The child's parent is NOT in this batch (a partial expansion). Nothing may be invented from
  // the OBJ_ID, and the plan must not fail.
  const { child } = parentChildBatch()
  const plan = planStockPreparationConflicts({
    expandedRows: [child],
    existingRows: [],
    runId: 'run-orphan',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  assert.equal(plan.valid, true)
  const add = byDecision(plan, DECISIONS.ADD)[0]
  assert.equal(Object.prototype.hasOwnProperty.call(add.record, 'parentComponentCode'), false, 'an unresolvable parent writes no 父组件图号')
  assert.equal(Object.prototype.hasOwnProperty.call(add.record, 'parentComponentName'), false, 'an unresolvable parent writes no 父组件名称')
  assert.equal(add.record.parentSourceId, 'PART-ROOT', 'the OBJ_ID lineage column itself is untouched')
}

function testExistingRowsAreBackfilledByAReRun() {
  // The migration answer for rows written BEFORE this change: an ordinary re-pull. The row is
  // otherwise unchanged, so before this change it was a SKIP; the three empty columns make it a
  // plm_system refresh like any other — no migration, no backfill script.
  const { parent, child } = parentChildBatch({ spec: 'DN1200' })
  const stale = { ...child, notes: 'human note that must survive' }
  delete stale.spec
  const plan = planStockPreparationConflicts({
    expandedRows: [parent, child],
    existingRows: [{ ...parent }, stale],
    runId: 'run-backfill',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  const updates = byDecision(plan, DECISIONS.UPDATE)
  assert.equal(updates.length, 1, 'only the child row needs a refresh')
  const patch = updates[0].patch
  assert.equal(patch.parentComponentCode, 'TZ-0001', 're-pull backfills 父组件图号')
  assert.equal(patch.parentComponentName, '主体组件', 're-pull backfills 父组件名称')
  assert.equal(patch.componentSpec, 'DN1200', 're-pull backfills 规格')
  assert.deepEqual(
    updates[0].changedFields.slice().sort(),
    ['componentSpec', 'parentComponentCode', 'parentComponentName'],
    'the three empty columns are exactly what changed — nothing else was touched',
  )
  assertNoHumanFields(patch, 'backfill patch')

  // Idempotent: a SECOND run over the already-backfilled sheet is a SKIP again.
  const backfilled = { ...stale, parentComponentCode: 'TZ-0001', parentComponentName: '主体组件', componentSpec: 'DN1200' }
  const second = planStockPreparationConflicts({
    expandedRows: [parent, child],
    existingRows: [{ ...parent }, backfilled],
    runId: 'run-backfill-2',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  assert.equal(byDecision(second, DECISIONS.UPDATE).length, 0, 'a re-run over a backfilled sheet writes nothing')
  assert.equal(byDecision(second, DECISIONS.SKIP).length, 2)
}

function testTheHumanFieldWallIsUnaffected() {
  const humanBand = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields
    .filter((field) => field.ownership === 'human_preserved')
    .map((field) => field.id)
  const { parent, child } = parentChildBatch({ spec: 'DN1200' })
  const plan = planStockPreparationConflicts({
    expandedRows: [parent, child],
    existingRows: [],
    runId: 'run-wall',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  // The band is reported exactly as the template declares it, in template order. It is 13
  // today: the original 8 plus 自制/外购 and the departmental response band (makeOrBuy /
  // procurementDone / procurementReplyDate / warehouseDone / actualArrivalDate), which grew
  // it through the design gate — NOT through the three plm_system columns this test is about.
  assert.deepEqual(
    plan.summary.humanPreservedFields,
    humanBand,
    'the human-preserved band is untouched by three new plm_system columns',
  )
  assert.equal(plan.summary.humanPreservedFields.length, 13)
  assert.deepEqual(plan.summary.humanPreservedFields.slice(0, 8), [
    'materialType', 'blankType', 'stockPreparationStatus', 'demandDate', 'leadTimeDays', 'notes',
    'procurementReply', 'warehouseConfirmation',
  ], 'the original eight are first and unchanged')
  // The three newcomers are on the PLM side of the wall, and only there.
  for (const fieldId of ['parentComponentCode', 'parentComponentName', 'componentSpec']) {
    assert.ok(plan.summary.plmSystemFields.includes(fieldId), `${fieldId} is refreshable`)
    assert.equal(plan.summary.humanPreservedFields.includes(fieldId), false, `${fieldId} is never human-preserved`)
  }
  // MUTATION CONTROL: the guard still bites. Feed a human field into a record the way a mis-scoped
  // projection would, and the planner must refuse — if this passes silently the wall is decorative.
  let refused = null
  try {
    __internals.assertNoHumanFields({ componentSpec: 'DN1200', notes: 'smuggled' }, humanBand, 'add record')
  } catch (error) {
    refused = error
  }
  assert.ok(refused instanceof StockPreparationConflictPlannerError, 'the human-field wall still throws')
  assert.equal(refused.details.field, 'notes')
  // ...and it does NOT fire on the three new columns.
  __internals.assertNoHumanFields(
    { parentComponentCode: 'TZ-0001', parentComponentName: '主体组件', componentSpec: 'DN1200' },
    humanBand,
    'add record',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// W3a M-03 / M-04 — THE MISSING-COMPONENT SIDE CHANNEL DOES NOT REACH THE PLANNER
// ─────────────────────────────────────────────────────────────────────────────
//
// W3a gives the expander a second, VALUE-BEARING output — `expansion.missingComponents`, carrying
// real PLM part numbers — so an operator can be told which parts to create. The planner's two
// durable surfaces must not be able to see it:
//
//   M-03 THE ANONYMOUS-HOLD IDENTITY. `ANONYMOUS_LOCUS_IDENTITY_FIELDS` reads {field, depth,
//        relation} off the ROWERROR, and the rowError did not change. Pinned against HARD-CODED
//        baselines rather than against a re-derivation: a re-derivation moves with the recipe and
//        would stay green through exactly the change that supersedes every pending hold in the
//        customer's ledger.
//   M-04 THE LEDGER PROJECTION. `details` is {field, depth, relation}, and `conflictSummary` is what
//        the confirmation ledger's `inputFingerprint` is computed over. Asserted as an absence of the
//        part-number literals over the WHOLE plan, not just over `details`.
function testW3aMissingComponentDetailNeverReachesTheHoldOrTheLedger() {
  // M-03: the recipe, frozen. These two strings were computed on the pre-W3a tree.
  assert.equal(
    __internals.anonymousRowErrorIdentity('missing_component', { type: 'missing_component', field: 'OBJ_ID', depth: 2 }),
    'anon-hold:v1:locus:sha256:71f697ebef98612c8b12ef96093b7e01',
    'M-03: the missing_component locus identity is byte-for-byte what it was before W3a',
  )
  assert.equal(
    __internals.anonymousRowErrorIdentity('missing_component', { type: 'missing_component', field: 'OBJ_ID', depth: 0 }),
    'anon-hold:v1:locus:sha256:6cbfb57eb7057856c257b2012e73796e',
    'M-03: depth 0 (the BOM root) too',
  )

  // The expansion the route would hold at this point: BOTH arrays populated, exactly as
  // `expandPlmProjectBom` now returns them. The planner is handed `expansion.rowErrors` — which is
  // the only thing table-actions passes it — so the side channel is structurally out of reach.
  const expansion = {
    rowErrors: [
      { type: 'missing_component', field: 'OBJ_ID', depth: 1 },
      { type: 'missing_component', field: 'OBJ_ID', depth: 1 },
    ],
    missingComponents: [
      { componentSourceId: 'ZZPARTZZ', parentSourceId: 'ZZPARENTZZ', bomId: 'ZZBOMZZ', path: '["ZZPARENTZZ","ZZPARTZZ"]', depth: 1 },
      { componentSourceId: 'ZZPARTZZ', parentSourceId: 'ZZOTHERPARENTZZ', bomId: 'ZZBOM2ZZ', path: '["ZZOTHERPARENTZZ","ZZPARTZZ"]', depth: 1 },
    ],
  }
  const plan = planStockPreparationConflicts({
    expandedRows: [row({ componentSourceId: 'PART-OK' })],
    existingRows: [],
    rowErrors: expansion.rowErrors,
    runId: 'run-w3a',
    plannedAt: '2026-09-05T00:00:00.000Z',
  })

  const holds = plan.decisions.filter((entry) => entry.decision === DECISIONS.MANUAL_CONFIRM)
  assert.equal(holds.length, 2, 'both missing-component rowErrors still hold the run')
  for (const hold of holds) {
    assert.deepEqual(
      Object.keys(hold.conflictSummary),
      ['type', 'field', 'depth'],
      'M-04: the ledger projection is the same key set it always was',
    )
  }

  // M-04, stated the way it matters: not one of these literals appears ANYWHERE in the plan — not in
  // details, not in a summary, not in an identity, not in the evidence projection.
  const planText = JSON.stringify(plan)
  const evidenceText = JSON.stringify(summarizeConflictPlanForEvidence(plan))
  for (const literal of ['ZZPARTZZ', 'ZZPARENTZZ', 'ZZOTHERPARENTZZ', 'ZZBOMZZ', 'ZZBOM2ZZ']) {
    assert.equal(planText.includes(literal), false, `M-04: the plan carries no ${literal}`)
    assert.equal(evidenceText.includes(literal), false, `M-04: the plan evidence carries no ${literal}`)
  }
}

// -----------------------------------------------------------------------------
// F1c-b -- 客户包的 父组件图号 / 父组件名称 (ext_parentDrawingNo / ext_parentName)
//
// 现场(222,演示项目 581 行):模板列 parentComponentCode / parentComponentName 在 F1c 之后
// 579/581 行有值(规格记录的缺值原因:根行无父),而**同名同义**的客户包列 ext_parentDrawingNo /
// ext_parentName 是 0 行有值 —— 人看的是中文包列,填上的是英文模板列。包列填不上不是"没配":
// 这条拉取链上能往 ext_ 列写值的只有部署自己的 ext 映射(applyExtFieldMapping,读 PART 行)
// 和 F1c 起规划器派生的那三列,而父件这一侧展开层只发出一个 OBJ_ID,part 列映射够不着它。
//
// 这几条用例钉住:①**派生出来的**两列与模板列逐行相等(同源 —— 值就是模板列那一个值本身,不是
// 复制一份规则),包括父件自己那个字段为空时两边一起缺席、不发明空串;②根行/父件不在批内 ⇒ 一个
// 键都不写;③动作没声明 ⇒ 不派生;④**本次拉取带上来的**映射值 ⇒ 不覆盖(表上手填的值不在这道闸
// 的作用域内,见该用例的作用域说明);⑤存量空列在下一次 dry-run 以 update 补上且不触发
// manual_confirm。
// -----------------------------------------------------------------------------

const PARENT_PACK_COLUMN_IDS = ['ext_parentDrawingNo', 'ext_parentName']

// 包安装到表上之后的字段属性,与安装器盖的那一份同形(ownership=plm_system ⇒ 进 pickFields 的
// 可写 band)。只列扩展列:模板列由冻结模板自己管,写进 installed 也会被 template_governed 挡掉。
function installedPackColumn(fieldId, type = 'string') {
  return {
    logicalId: fieldId,
    name: fieldId,
    type,
    property: {
      stockPreparation: {
        ownership: 'plm_system',
        preserveOnRefresh: false,
        required: false,
        key: false,
        extension: true,
        packId: 'factory-a-rehearsal',
        packVersion: '1.0.0',
      },
    },
  }
}

function planWithParentPackColumns(input = {}) {
  const declared = input.extensionFieldIds === undefined ? PARENT_PACK_COLUMN_IDS : input.extensionFieldIds
  const installPack = input.installPack !== false
  return planStockPreparationConflicts({
    expandedRows: input.expandedRows,
    existingRows: input.existingRows || [],
    runId: input.runId || 'run-parent-pack',
    plannedAt: '2026-09-12T00:00:00.000Z',
    ...(declared === null ? {} : { extensionFieldIds: declared }),
    ...(installPack ? { installedFieldProperties: PARENT_PACK_COLUMN_IDS.map((id) => installedPackColumn(id)) } : {}),
  })
}

// 四个父 + 四个子 + 一个父件不在批内的孤儿。第二个父件**没有**未切分全串,走的是模板列自己的
// 退回路径(nameAndSpec -> componentName)—— 包列跟着同一条路径走,才叫同源。
// 第三、第四家族钉的是「模板列缺席 ⇒ 包列也缺席,不发明空串」这条硬规则里**父件在批内、但父件
// 自己那个字段为空**的象限:前两个家族的父件图号与名字都有值,`out.parentComponentCode !==
// undefined` / `out.parentComponentName !== undefined` 两道守卫在它们身上永远是真,去掉守卫改写
// 空串也照绿(反驳 B blocker 1 的 MXEMPTY / MXEMPTY2)。
function twoFamilyBatch() {
  const parentA = row({ componentSourceId: 'PART-ROOT', componentCode: 'TZ-0001', componentName: '主体组件', nameAndSpec: '主体组件 DN1200' })
  const childA = row({
    componentSourceId: 'PART-CHILD',
    parentSourceId: 'PART-ROOT',
    pathTokens: ['PART-ROOT', 'PART-CHILD'],
    componentCode: 'GJ-0007',
    componentName: '筒体',
  })
  const parentB = row({ componentSourceId: 'PART-ROOT-2', componentCode: 'TZ-0002', componentName: '副体组件' })
  const childB = row({
    componentSourceId: 'PART-CHILD-2',
    parentSourceId: 'PART-ROOT-2',
    pathTokens: ['PART-ROOT-2', 'PART-CHILD-2'],
    componentCode: 'GJ-0008',
    componentName: '封头',
  })
  // 父件在批内,但父件**自己的图号是空的** ⇒ 模板列 parentComponentCode 缺席 ⇒ 包列必须同样缺席。
  const parentC = row({ componentSourceId: 'PART-ROOT-3', componentCode: '', componentName: '无图号组件', nameAndSpec: '无图号组件 DN800' })
  const childC = row({
    componentSourceId: 'PART-CHILD-3',
    parentSourceId: 'PART-ROOT-3',
    pathTokens: ['PART-ROOT-3', 'PART-CHILD-3'],
    componentCode: 'GJ-0010',
    componentName: '裙座',
  })
  // 父件在批内,但父件**两个名字键都空**(没有 nameAndSpec 键、componentName 为空串)
  // ⇒ 模板列 parentComponentName 缺席 ⇒ 包列必须同样缺席。
  const parentD = row({ componentSourceId: 'PART-ROOT-4', componentCode: 'TZ-0004', componentName: '' })
  const childD = row({
    componentSourceId: 'PART-CHILD-4',
    parentSourceId: 'PART-ROOT-4',
    pathTokens: ['PART-ROOT-4', 'PART-CHILD-4'],
    componentCode: 'GJ-0011',
    componentName: '法兰',
  })
  const orphan = row({
    componentSourceId: 'PART-ORPHAN',
    parentSourceId: 'PART-NOT-IN-THIS-BATCH',
    pathTokens: ['PART-NOT-IN-THIS-BATCH', 'PART-ORPHAN'],
    componentCode: 'GJ-0009',
    componentName: '接管',
  })
  return {
    parentA,
    childA,
    parentB,
    childB,
    parentC,
    childC,
    parentD,
    childD,
    orphan,
    rows: [parentA, childA, parentB, childB, parentC, childC, parentD, childD, orphan],
  }
}

// 同源 = 包列的值就是模板列那一个值本身。
// M1(派生源换成子行自己的 componentCode / componentName)⇒ 本用例红。
function testParentPackColumnsAreTheTemplateColumnsOwnValue() {
  const batch = twoFamilyBatch()
  const plan = planWithParentPackColumns({ expandedRows: batch.rows, runId: 'run-parent-pack-same-source' })
  const adds = byDecision(plan, DECISIONS.ADD)
  assert.equal(adds.length, 9, 'nine rows are added')

  const childA = adds.find((decision) => decision.record.componentSourceId === 'PART-CHILD').record
  assert.equal(childA.ext_parentDrawingNo, 'TZ-0001', '父组件图号 落进客户包列')
  assert.equal(childA.ext_parentName, '主体组件 DN1200', '父组件名称 落进客户包列,并且是父件**未切分**的全串')
  const childB = adds.find((decision) => decision.record.componentSourceId === 'PART-CHILD-2').record
  assert.equal(childB.ext_parentDrawingNo, 'TZ-0002')
  assert.equal(childB.ext_parentName, '副体组件', '父件没有全串时包列跟着模板列一起退回 componentName —— 同一条路径,不是第二套规则')

  // 父件在批内、但父件自己那个字段为空:模板列缺席 ⇒ 包列**缺席**,不是空串。
  // 这两条各自单独钉住 `out.parentComponentCode !== undefined` / `out.parentComponentName !== undefined`
  // 那两道守卫 —— 去掉任意一道改写空串,这里必红(反驳 B blocker 1)。
  const childC = adds.find((decision) => decision.record.componentSourceId === 'PART-CHILD-3').record
  assert.equal(
    Object.prototype.hasOwnProperty.call(childC, 'ext_parentDrawingNo'),
    false,
    '父件图号为空 ⇒ 客户包列缺席,不写空串',
  )
  assert.equal(childC.ext_parentName, '无图号组件 DN800', '名字那一列不受图号缺值牵连,照派生')
  const childD = adds.find((decision) => decision.record.componentSourceId === 'PART-CHILD-4').record
  assert.equal(childD.ext_parentDrawingNo, 'TZ-0004', '图号那一列不受名字缺值牵连,照派生')
  assert.equal(
    Object.prototype.hasOwnProperty.call(childD, 'ext_parentName'),
    false,
    '父件两个名字键都空 ⇒ 客户包列缺席,不写空串',
  )

  // 逐行相等,而且**键在不在**也相等:把两列与模板列拆成两份取值逻辑,这一圈必红。
  for (const decision of adds) {
    const record = decision.record
    for (const [packId, templateId] of [
      ['ext_parentDrawingNo', 'parentComponentCode'],
      ['ext_parentName', 'parentComponentName'],
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(record, packId),
        Object.prototype.hasOwnProperty.call(record, templateId),
        record.componentSourceId + ': ' + packId + ' 与 ' + templateId + ' 要么都写要么都不写',
      )
      assert.equal(record[packId], record[templateId], record.componentSourceId + ': ' + packId + ' 与模板列逐行相等')
    }
    assertNoHumanFields(record, 'F1c-b add record')
  }

  // 根行无父、孤儿的父件不在这批里:都是**缺席**,不是空串。
  for (const componentSourceId of ['PART-ROOT', 'PART-ROOT-2', 'PART-ROOT-3', 'PART-ROOT-4', 'PART-ORPHAN']) {
    const record = adds.find((decision) => decision.record.componentSourceId === componentSourceId).record
    for (const fieldId of ['ext_parentDrawingNo', 'ext_parentName', 'parentComponentCode', 'parentComponentName']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(record, fieldId),
        false,
        componentSourceId + ' 不写 ' + fieldId + ' —— 无父就是无键,不是空串',
      )
    }
  }
}

// 两道闸,各一条否定控制。
// M2(去掉 canDeriveExtensionField 闸)⇒ 第一段红。
function testParentPackColumnsNeedBothTheDeclarationAndThePack() {
  const batch = twoFamilyBatch()

  // ① 包装了(pickFields 认这两列),但动作没声明 ⇒ 不派生。声明才是"目标表已绑定"的凭据,
  //    派进一个 target 没绑的 ext_ 列会让整行写入被 apply-writer 拒("这列空着"升级成"这个项目
  //    根本 apply 不了")。
  const undeclared = planWithParentPackColumns({ expandedRows: batch.rows, extensionFieldIds: null, runId: 'run-parent-pack-undeclared' })
  for (const decision of byDecision(undeclared, DECISIONS.ADD)) {
    assert.deepEqual(
      Object.keys(decision.record).filter((key) => key.startsWith('ext_')),
      [],
      '动作没声明扩展列 ⇒ 一个 ext_ 键都不派生',
    )
  }
  const undeclaredChild = byDecision(undeclared, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD').record
  assert.equal(undeclaredChild.parentComponentCode, 'TZ-0001', '模板列照旧 —— 这次改动纯加法')
  assert.equal(undeclaredChild.parentComponentName, '主体组件 DN1200')

  // ② 声明了,但表上没装这个包 ⇒ pickFields 的可写 band 里没有这两列,记录上同样没有。
  //    派生只能给内存行加一个键,加不了任何人表上的一列。
  const noPack = planWithParentPackColumns({ expandedRows: batch.rows, installPack: false, runId: 'run-parent-pack-no-pack' })
  for (const decision of byDecision(noPack, DECISIONS.ADD)) {
    assert.deepEqual(
      Object.keys(decision.record).filter((key) => key.startsWith('ext_')),
      [],
      '没装包的部署一个 ext_ 列都写不出去',
    )
  }
  assert.equal(noPack.summary.plmSystemFields.includes('ext_parentDrawingNo'), false, '没装包 ⇒ 可写 band 里没有这两列')
}

// **本次拉取带上来的**值(部署自己的 ext 映射测到的)永远优先;派生的从不覆盖这一次测得的值。
// M3(去掉 isBlank 判断)⇒ 本用例红。
//
// 作用域:isBlank 读的是**展开行**,不是表上的存量行 —— 人在表里手填进这两个包列的值不受这道
// 闸保护,下一次拉取会被派生值以 update 覆盖(见 testExistingRowsGetThePackColumnsAsAPlainUpdate
// 的 'empty-string' 分支同理)。手填值的保护在另一道闸上:包把这两列声明成 human_preserved 或钉
// preserveOnRefresh,它们就根本不进 pickFields 的可写 band。这是包声明的事,不是这段代码的事。
function testParentPackColumnsNeverOverwriteAValueMeasuredByThisPull() {
  const batch = twoFamilyBatch()
  const mapped = {
    ...batch.childA,
    ext_parentDrawingNo: 'MAPPED-DWG-9',
    ext_parentName: '映射来的父件名',
  }
  const plan = planWithParentPackColumns({
    expandedRows: [batch.parentA, mapped],
    runId: 'run-parent-pack-measured',
  })
  const record = byDecision(plan, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD').record
  assert.equal(record.ext_parentDrawingNo, 'MAPPED-DWG-9', '部署自己映射到的值胜出 —— 测得的压过派生的')
  assert.equal(record.ext_parentName, '映射来的父件名')
  // 模板列不受影响:它本来就不归这条规则管。
  assert.equal(record.parentComponentCode, 'TZ-0001')
  assert.equal(record.parentComponentName, '主体组件 DN1200')

  // 空白的几种写法都算"没有值",照派生(空串/空格不是人写下的值)。
  for (const blank of ['', '   ', null, undefined]) {
    const blanked = { ...batch.childA, ext_parentDrawingNo: blank, ext_parentName: blank }
    const blankedPlan = planWithParentPackColumns({
      expandedRows: [batch.parentA, blanked],
      runId: 'run-parent-pack-blank',
    })
    const blankedRecord = byDecision(blankedPlan, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD').record
    assert.equal(blankedRecord.ext_parentDrawingNo, 'TZ-0001', '空白值 ' + JSON.stringify(blank) + ' 照派生')
    assert.equal(blankedRecord.ext_parentName, '主体组件 DN1200')
  }

  // 逐列接线的负控。上面两种形状都是**对称**的(两列同时带映射值 / 两列同时空白),把两个
  // `isBlank` 读交叉接线(图号闸去读名称列、名称闸去读图号列)在对称形状下判据恒等 ⇒ 变异存活。
  // 现网真正可达的是不对称形状:部署只映射了两列中的**一列**。两个方向各跑一次 —— 被映射的那列
  // 必须保住映射值(交叉接线会拿派生值把它盖掉),另一列必须照常派生(交叉接线会因为「另一列有
  // 值」把它的派生关掉)。这两条断言把每一道闸钉到它自己那一列上。
  const DERIVED_PARENT_VALUE = {
    ext_parentDrawingNo: 'TZ-0001',
    ext_parentName: '主体组件 DN1200',
  }
  for (const [mappedId, derivedId] of [
    ['ext_parentDrawingNo', 'ext_parentName'],
    ['ext_parentName', 'ext_parentDrawingNo'],
  ]) {
    const asymmetric = { ...batch.childA, [mappedId]: 'ONLY-MAPPED-' + mappedId }
    const asymmetricPlan = planWithParentPackColumns({
      expandedRows: [batch.parentA, asymmetric],
      runId: 'run-parent-pack-asymmetric',
    })
    const asymmetricRecord = byDecision(asymmetricPlan, DECISIONS.ADD)
      .find((decision) => decision.record.componentSourceId === 'PART-CHILD').record
    assert.equal(
      asymmetricRecord[mappedId],
      'ONLY-MAPPED-' + mappedId,
      '只映射了 ' + mappedId + ' 一列 ⇒ 这一列的映射值保住(这道闸读的必须是它自己那一列)',
    )
    assert.equal(
      asymmetricRecord[derivedId],
      DERIVED_PARENT_VALUE[derivedId],
      '只映射了 ' + mappedId + ' 一列 ⇒ ' + derivedId + ' 照常派生(另一列有值不该关掉这一列的派生)',
    )
  }
}

// DENORMALIZED_PLM_FIELD_IDS 是「这个函数会派生哪些列」的登记表,在这条用例之前它没有任何运行时
// 消费者,加进去两项也好、漏登记也好,整条套件照绿(反驳 B blocker 2 的 MXDEAD)。这里把它绑成
// 真闸,两半各管一个方向:
//  · **行为半**(一次让全部派生列同时落地的批次):记录上的 ext_ 键集合必须与登记表的 ext_ 半边
//    逐项相同(deepEqual,不是包含),登记表里的非 ext_ 三列也必须都在 —— 登记了却派生不出来
//    ⇒ 红,删掉一条已登记的派生 ⇒ 红。这一半**证不到「漏登记」**:没登记的新 id 不会出现在任何
//    用例的 extensionFieldIds 里,`canDeriveExtensionField` 先把它挡掉,记录上永远不出现,
//    deepEqual 照样相等(反驳 B blocker 2 的 MXNEWCOL)。
//  · **结构半**(直接读 lib 源码):派生点的两种字面量 —— 闸 `canDeriveExtensionField('ext_…'`
//    与落值 `out.ext_… =` —— 抽出来的 id 集合也必须与登记表的 ext_ 半边逐项相同。往
//    denormalizedPlmFields 里加第六列而**不**登记 ⇒ 这里红。两种抽法都留着:只有闸没有落值
//    (或反过来)的新列同样是漏登记,也同样是一条自相矛盾的派生。
function testDenormalizedFieldRegistryMatchesWhatIsActuallyDerived() {
  const ALL_DERIVED_EXT_IDS = ['ext_componentSortNo', 'ext_parentSortNo', 'ext_nameAndSpec', 'ext_parentDrawingNo', 'ext_parentName']
  const parent = row({
    componentSourceId: 'PART-ROOT',
    componentCode: 'TZ-0001',
    componentName: '主体组件',
    nameAndSpec: '主体组件 DN1200',
    sortLine: 3,
  })
  const child = row({
    componentSourceId: 'PART-CHILD',
    parentSourceId: 'PART-ROOT',
    pathTokens: ['PART-ROOT', 'PART-CHILD'],
    componentCode: 'GJ-0007',
    componentName: '筒体',
    nameAndSpec: '筒体 DN1200',
    spec: 'DN1200',
    sortLine: 7,
  })
  const plan = planStockPreparationConflicts({
    expandedRows: [parent, child],
    existingRows: [],
    runId: 'run-denormalized-registry',
    plannedAt: '2026-09-12T00:00:00.000Z',
    extensionFieldIds: ALL_DERIVED_EXT_IDS,
    installedFieldProperties: ALL_DERIVED_EXT_IDS.map((id) => installedPackColumn(id, id.endsWith('SortNo') ? 'number' : 'string')),
  })
  const record = byDecision(plan, DECISIONS.ADD).find((d) => d.record.componentSourceId === 'PART-CHILD').record

  assert.deepEqual(
    Object.keys(record).filter((key) => key.startsWith('ext_')).sort(),
    DENORMALIZED_PLM_FIELD_IDS.filter((id) => id.startsWith('ext_')).slice().sort(),
    '派生出来的 ext_ 列集合必须与 DENORMALIZED_PLM_FIELD_IDS 的 ext_ 半边逐项相同',
  )
  for (const fieldId of DENORMALIZED_PLM_FIELD_IDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(record, fieldId),
      true,
      '登记表里的 ' + fieldId + ' 必须真的派生得出来',
    )
  }
  assertNoHumanFields(record, 'denormalized registry record')

  // 结构半:漏登记那个方向只能从源码上抓(见函数头)。
  const plannerSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'),
    'utf8',
  )
  const registeredExtIds = DENORMALIZED_PLM_FIELD_IDS.filter((id) => id.startsWith('ext_')).slice().sort()
  const gatedExtIds = [...new Set(
    Array.from(plannerSource.matchAll(/canDeriveExtensionField\('(ext_[A-Za-z0-9_]+)'/g), (match) => match[1]),
  )].sort()
  const assignedExtIds = [...new Set(
    Array.from(plannerSource.matchAll(/\bout\.(ext_[A-Za-z0-9_]+)\s*=[^=]/g), (match) => match[1]),
  )].sort()
  assert.deepEqual(
    gatedExtIds,
    registeredExtIds,
    '源码里过 canDeriveExtensionField 的 ext_ 列必须与 DENORMALIZED_PLM_FIELD_IDS 逐项相同(漏登记 ⇒ 红)',
  )
  assert.deepEqual(
    assignedExtIds,
    registeredExtIds,
    '源码里真的落值(out.ext_… =)的 ext_ 列必须与 DENORMALIZED_PLM_FIELD_IDS 逐项相同(漏登记 ⇒ 红)',
  )
}

// 222 上那 581 行的迁移答案:没有迁移。下一次 dry-run 把两列以 **update** 补上,不触发
// manual_confirm(这两列既不在 IDENTITY_FIELD_IDS 也不在 LINEAGE_FIELD_IDS,是普通的
// plm_system 刷新),人工列一字不动,补完之后再拉一次是 SKIP。
//
// 第三种形状('hand-authored')钉的是**行为变化**,不是补值:这两列从本次改动起第一次有了刷新
// 写手,于是人**在表里手填**进这两个包列的值会被下一次刷新以 update 覆盖(manual_confirm 仍然
// 是 0 —— 这不是冲突,是刷新)。`isBlank` 那道闸读的是展开行,管不到表上的存量值;包列要挡住
// 刷新只有一条路:包把该列声明成 `ownership: 'human_preserved'` —— 它随即离开 plm_system 可写
// band(派生照样在内存里跑,只是 pickFields 一个字也不往表上写)。规格「已有值(人工/映射)⇒
// 不覆盖」的**人工**那一半今天不成立,这里把现状钉死,免得合进去的是一条自己说不覆盖、实际
// 覆盖的硬规则(见 PR 正文 owner 待办)。
function testExistingRowsGetThePackColumnsAsAPlainUpdate() {
  const batch = twoFamilyBatch()
  const HAND_AUTHORED = { ext_parentDrawingNo: '人手填的图号', ext_parentName: '人手填的父件名' }
  // 存量行的三种真实形状:列不存在(从没写过)、列存在但为空串、列里是人手填的值。
  for (const existingShape of ['absent', 'empty-string', 'hand-authored']) {
    const emptyShape = existingShape
    const existingChild = {
      ...batch.childA,
      parentComponentCode: 'TZ-0001',
      parentComponentName: '主体组件 DN1200',
      notes: '人工备注必须活下来',
      ...(existingShape === 'empty-string' ? { ext_parentDrawingNo: '', ext_parentName: '' } : {}),
      ...(existingShape === 'hand-authored' ? { ...HAND_AUTHORED } : {}),
    }
    const plan = planWithParentPackColumns({
      expandedRows: [batch.parentA, batch.childA],
      existingRows: [{ ...batch.parentA }, existingChild],
      runId: 'run-parent-pack-backfill',
    })
    assert.equal(plan.counts[DECISIONS.MANUAL_CONFIRM], 0, emptyShape + ': 补两列不挂起任何一行')
    assert.equal(plan.valid, true, emptyShape + ': 计划仍然是可执行的')
    const updates = byDecision(plan, DECISIONS.UPDATE)
    assert.equal(updates.length, 1, emptyShape + ': 只有那条子行需要刷新')
    assert.deepEqual(
      updates[0].changedFields.slice().sort(),
      ['ext_parentDrawingNo', 'ext_parentName'],
      emptyShape + ': 变的就是这两列,别的一列没动',
    )
    assert.equal(updates[0].patch.ext_parentDrawingNo, 'TZ-0001', emptyShape + ': update 把 父组件图号 填进包列')
    assert.equal(updates[0].patch.ext_parentName, '主体组件 DN1200', emptyShape + ': update 把 父组件名称 填进包列')
    // update 计划里同样逐行相等(硬规则 1 覆盖 add 与 update 两条路径)。
    assert.equal(updates[0].patch.ext_parentDrawingNo, updates[0].patch.parentComponentCode)
    assert.equal(updates[0].patch.ext_parentName, updates[0].patch.parentComponentName)
    assertNoHumanFields(updates[0].patch, 'F1c-b backfill patch')

    if (existingShape === 'hand-authored') {
      // 现状,不是理想:手填值被派生值取代,而且这一行照样是普通 update(不挂起、不提示)。
      assert.notEqual(
        updates[0].patch.ext_parentDrawingNo,
        HAND_AUTHORED.ext_parentDrawingNo,
        'hand-authored: 手填进包列的图号被派生值覆盖 —— 规格「人工值不覆盖」那一半今天不成立',
      )
      assert.notEqual(
        updates[0].patch.ext_parentName,
        HAND_AUTHORED.ext_parentName,
        'hand-authored: 手填进包列的父件名被派生值覆盖',
      )
      assert.equal(plan.counts[DECISIONS.MANUAL_CONFIRM], 0, 'hand-authored: 覆盖手填值不会挂起这一行')
      assert.equal(
        Object.prototype.hasOwnProperty.call(updates[0].patch, 'notes'),
        false,
        'hand-authored: 真正的人工列(notes)不进 patch,一字不动',
      )

      // 唯一挡得住的那条路:包把这一列声明成 human_preserved ⇒ 它离开 plm_system 可写 band,
      // 手填值活下来(派生也一并停掉 —— 这是包声明的取舍,不是这段代码的开关)。
      const preservedPlan = planStockPreparationConflicts({
        expandedRows: [batch.parentA, batch.childA],
        existingRows: [{ ...batch.parentA }, existingChild],
        runId: 'run-parent-pack-human-preserved',
        plannedAt: '2026-09-12T00:00:00.000Z',
        extensionFieldIds: PARENT_PACK_COLUMN_IDS,
        installedFieldProperties: PARENT_PACK_COLUMN_IDS.map((id) => ({
          ...installedPackColumn(id),
          property: {
            stockPreparation: {
              ...installedPackColumn(id).property.stockPreparation,
              ownership: 'human_preserved',
              preserveOnRefresh: true,
            },
          },
        })),
      })
      assert.equal(
        byDecision(preservedPlan, DECISIONS.UPDATE).length,
        0,
        'hand-authored: 包把这两列声明成 human_preserved ⇒ 刷新一个字也不写',
      )
    }

    // 幂等:填好之后再拉一次是 SKIP,不会每次 dry-run 都报一条 update。
    const filled = { ...existingChild, ext_parentDrawingNo: 'TZ-0001', ext_parentName: '主体组件 DN1200' }
    const second = planWithParentPackColumns({
      expandedRows: [batch.parentA, batch.childA],
      existingRows: [{ ...batch.parentA }, filled],
      runId: 'run-parent-pack-backfill-2',
    })
    assert.equal(byDecision(second, DECISIONS.UPDATE).length, 0, emptyShape + ': 填好之后重拉不再写')
    assert.equal(byDecision(second, DECISIONS.SKIP).length, 2, emptyShape + ': 两行都是 SKIP')
  }
}

function main() {
  testW3aMissingComponentDetailNeverReachesTheHoldOrTheLedger()
  testAddUpdateSkipInactive()
  testRowErrorsDoNotAbortGoodRows()
  testDuplicatesAndConflictsFailClosed()
  testMissingKeysAndStrategyGuards()
  testHumanFieldWhitelistOrderIndependent()
  testPrimitiveValueComparisonFastPath()
  testTemplateTypeEquivalentValuesSkipAfterCreate()
  testTemplateNormalizationDoesNotHideRealIdentityOrLineageConflicts()
  testValuesFreeEvidence()
  testDuplicateExpandedKeyDiagnosticsValuesFree()
  testKeepMultipleRowsResolvesSurgically()
  testDuplicateResolutionEvidenceValuesFree()
  testKeepMultipleRowsCleanToCollisionHolds()
  testKeepMultipleRowsWithoutStableDiscriminatorHolds()
  testSourceCorrectionRequiredHoldsWithExplicitReason()
  testUnimplementedDuplicatePoliciesRemainHeldAsUnsupported()
  testO1bAnonymousFamiliesGetGranularityCorrectIdentities()
  testO1bIdentityIsReproducibleFromTheSameInput()
  testO1bKeyedHoldsAndTheReservedNamespaceAreUntouched()
  testDenormalizedParentAndSpecReachTheMainRow()
  testParentComponentNameIsTheUnsplitLegacyString()
  testParentPackColumnsAreTheTemplateColumnsOwnValue()
  testParentPackColumnsNeedBothTheDeclarationAndThePack()
  testParentPackColumnsNeverOverwriteAValueMeasuredByThisPull()
  testDenormalizedFieldRegistryMatchesWhatIsActuallyDerived()
  testExistingRowsGetThePackColumnsAsAPlainUpdate()
  testUndeclaredSpecSlotYieldsAnEmptyColumnAndNoError()
  testUnresolvableParentIsAbsenceNotAGuess()
  testExistingRowsAreBackfilledByAReRun()
  testTheHumanFieldWallIsUnaffected()

  console.log('stock-preparation-conflict-planner.test.cjs OK')
}

main()
