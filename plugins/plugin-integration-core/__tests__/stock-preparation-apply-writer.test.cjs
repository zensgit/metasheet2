'use strict'

// #2253 C4 tests: apply writer. No PLM read, no external DB write, no route/UI,
// and no K3. The fake records API is the MetaSheet write surface.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  DECISIONS,
  planStockPreparationConflicts,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const {
  StockPreparationApplyWriterError,
  __internals,
  applyStockPreparationPlan,
  summarizeApplyResultForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-apply-writer.cjs'))

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

function createRecordsApi({ existing = [] } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId || 'sheet_stock_preparation',
    version: entry.version || 1,
    data: { ...(entry.data || entry) },
  }))
  const calls = []
  return {
    rows,
    calls,
    recordsApi: {
      async queryRecords(input) {
        calls.push(['queryRecords', input])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
      },
      async createRecord(input) {
        calls.push(['createRecord', input])
        const record = {
          id: `rec_${rows.length + 1}`,
          sheetId: input.sheetId,
          version: 1,
          data: { ...input.data },
        }
        rows.push(record)
        return record
      },
      async patchRecord(input) {
        calls.push(['patchRecord', input])
        const record = rows.find((item) => item.sheetId === input.sheetId && item.id === input.recordId)
        if (!record) throw new Error(`record not found: ${input.recordId}`)
        record.version += 1
        record.data = { ...record.data, ...input.changes }
        return record
      },
    },
  }
}

function createFailingCreateRecordsApi({ error, queryError = null } = {}) {
  const calls = []
  return {
    calls,
    recordsApi: {
      async queryRecords(input) {
        calls.push(['queryRecords', input])
        if (queryError) throw queryError
        return []
      },
      async createRecord(input) {
        calls.push(['createRecord', input])
        throw error || new Error('create failed for P-001 / PART-A / SECRET-OPTION')
      },
      async patchRecord(input) {
        calls.push(['patchRecord', input])
        throw new Error(`unexpected patch for ${input.recordId}`)
      },
    },
  }
}

function target(overrides = {}) {
  return {
    sheetId: 'sheet_stock_preparation',
    ...overrides,
  }
}

function buildPlan() {
  const addRow = row({ componentSourceId: 'PART-ADD', pathTokens: ['PART-ADD'] })
  const updateRow = row({ componentSourceId: 'PART-UPD', pathTokens: ['PART-UPD'], rawQuantity: 5, totalQuantity: 5 })
  const skipRow = row({ componentSourceId: 'PART-SKIP', pathTokens: ['PART-SKIP'] })
  const inactiveExisting = row({ componentSourceId: 'PART-GONE', pathTokens: ['PART-GONE'] })
  const existingUpdate = { ...updateRow, rawQuantity: 4, totalQuantity: 4, notes: 'operator note', materialType: 'human material' }
  const existingSkip = { ...skipRow, notes: 'keep me' }

  return planStockPreparationConflicts({
    expandedRows: [addRow, updateRow, skipRow],
    existingRows: [existingUpdate, existingSkip, inactiveExisting],
    rowErrors: [{ type: 'invalid_quantity', field: 'quantity' }],
    runId: 'run-c4',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
}

async function testApplyCleanDecisionsAndHoldManualConfirm() {
  const plan = buildPlan()
  const updateDecision = plan.decisions.find((entry) => entry.decision === DECISIONS.UPDATE)
  const inactiveDecision = plan.decisions.find((entry) => entry.decision === DECISIONS.INACTIVE)
  const api = createRecordsApi({
    existing: [
      { id: 'rec_update', data: { idempotencyKey: updateDecision.idempotencyKey, notes: 'operator note', materialType: 'human material', rawQuantity: 4 } },
      { id: 'rec_inactive', data: { idempotencyKey: inactiveDecision.idempotencyKey, notes: 'keep gone', active: true } },
    ],
  })

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: api.recordsApi,
  })

  assert.equal(result.status, 'partial', 'manual_confirm is held while clean rows still apply')
  assert.equal(result.counts.created, 1)
  assert.equal(result.counts.updated, 1)
  assert.equal(result.counts.inactive, 1)
  assert.equal(result.counts.skipped, 1)
  assert.equal(result.counts.held, 1)
  assert.equal(result.counts.failed, 0)
  assert.equal(api.calls.filter((call) => call[0] === 'createRecord').length, 1, 'add creates one row')
  assert.equal(api.calls.filter((call) => call[0] === 'patchRecord').length, 2, 'update + inactive patch existing rows')

  const updated = api.rows.find((entry) => entry.id === 'rec_update').data
  assert.equal(updated.rawQuantity, 5)
  assert.equal(updated.notes, 'operator note', 'human field is preserved by omission from patch')
  assert.equal(updated.materialType, 'human material', 'human select field is preserved by omission from patch')
  assert.equal(updated.lastPlmRefreshDecision, DECISIONS.UPDATE)

  const inactive = api.rows.find((entry) => entry.id === 'rec_inactive').data
  assert.equal(inactive.active, false)
  assert.equal(inactive.notes, 'keep gone')
  assert.equal(inactive.lastPlmRefreshDecision, DECISIONS.INACTIVE)

  const evidence = summarizeApplyResultForEvidence(result)
  const text = JSON.stringify(evidence)
  assert.equal(evidence.counts.held, 1)
  assert.ok(!text.includes('P-001'), 'evidence must not include project values')
  assert.ok(!text.includes('PART-ADD'), 'evidence must not include component values')
}

async function testRerunIsIdempotentForAddDecision() {
  const plan = buildPlan()
  const api = createRecordsApi()

  await applyStockPreparationPlan({
    permission: 'admin',
    plan,
    target: target(),
    recordsApi: api.recordsApi,
  })
  const rowCountAfterFirstRun = api.rows.length
  await applyStockPreparationPlan({
    permission: 'admin',
    plan,
    target: target(),
    recordsApi: api.recordsApi,
  })

  assert.equal(api.rows.length, rowCountAfterFirstRun, 'rerunning the same plan does not duplicate add rows')
}

async function testUpdateAndInactiveNeverCreateMissingTargets() {
  const addRow = row({ componentSourceId: 'PART-ADDONLY', pathTokens: ['PART-ADDONLY'] })
  const updateRow = row({ componentSourceId: 'PART-MISSING-UPD', pathTokens: ['PART-MISSING-UPD'], totalQuantity: 9 })
  const plan = planStockPreparationConflicts({
    expandedRows: [addRow, updateRow],
    existingRows: [{ ...updateRow, totalQuantity: 8 }],
    runId: 'run-missing-target',
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  const api = createRecordsApi()

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: api.recordsApi,
  })

  assert.equal(result.counts.created, 1, 'unrelated add still succeeds')
  assert.equal(result.counts.failed, 1, 'missing update target is a row-level failure')
  assert.equal(result.errors[0].code, 'target_row_not_found')
  assert.equal(api.calls.filter((call) => call[0] === 'createRecord').length, 1, 'update did not create a partial row')
}

async function testPermissionAndHumanFieldGuards() {
  const api = createRecordsApi()
  await assert.rejects(
    () => applyStockPreparationPlan({
      permission: 'read',
      plan: { decisions: [] },
      target: target(),
      recordsApi: api.recordsApi,
    }),
    StockPreparationApplyWriterError,
    'apply requires write/admin',
  )
  assert.equal(api.calls.length, 0, 'permission failure happens before any records API call')

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan: {
      decisions: [{
        decision: DECISIONS.ADD,
        idempotencyKey: 'key-human',
        record: {
          idempotencyKey: 'key-human',
          projectNo: 'P-001',
          materialType: 'must not write',
        },
      }],
    },
    target: target(),
    recordsApi: api.recordsApi,
  })
  assert.equal(result.counts.failed, 1)
  assert.equal(result.errors[0].code, 'target_record_validation_failed')
  assert.equal(api.calls.length, 0, 'human-field guard fails before query/create')
}

async function testPlainCreateErrorsBecomeTypedValuesFreeDiagnostics() {
  const api = createFailingCreateRecordsApi({
    error: new Error('Invalid select option for fld_materialType: PART-A / P-001 / SECRET-OPTION'),
  })

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan: {
      decisions: [{
        decision: DECISIONS.ADD,
        idempotencyKey: 'key-create-fail',
        record: {
          idempotencyKey: 'key-create-fail',
          projectNo: 'P-001',
          componentSourceId: 'PART-A',
          path: '["PART-A"]',
          active: true,
        },
      }],
    },
    target: target(),
    recordsApi: api.recordsApi,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.counts.failed, 1)
  assert.equal(result.errors[0].code, 'select_option_not_found')
  assert.equal(result.errors[0].operation, 'createRecord')
  assert.equal(result.errors[0].message, 'create target row failed: select_option_not_found')
  assert.equal(api.calls.some((call) => call[0] === 'createRecord'), true, 'create path was exercised')

  const evidence = summarizeApplyResultForEvidence(result)
  assert.deepEqual(evidence.errorCodes, ['select_option_not_found'])
  assert.deepEqual(evidence.errorSummaries, [{
    code: 'select_option_not_found',
    count: 1,
    decisions: [DECISIONS.ADD],
    operations: ['createRecord'],
  }])
  const text = JSON.stringify({ result, evidence })
  assert.equal(text.includes('SECRET-OPTION'), false, 'diagnostics must not expose option values')
  assert.equal(text.includes('PART-A / P-001'), false, 'diagnostics must not expose row/project values')
  assert.equal(text.includes('Invalid select option for'), false, 'raw error message must not be surfaced')
  assert.equal(text.includes('"Error"'), false, 'plain Error must not remain the only diagnostic code')
}

async function testPlainQueryErrorsBecomeTypedValuesFreeDiagnostics() {
  const api = createFailingCreateRecordsApi({
    queryError: new Error('Unknown field fld_idempotency_key for project P-001 / component PART-A'),
  })

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan: {
      decisions: [{
        decision: DECISIONS.ADD,
        idempotencyKey: 'key-query-fail',
        record: {
          idempotencyKey: 'key-query-fail',
          projectNo: 'P-001',
          componentSourceId: 'PART-A',
          path: '["PART-A"]',
          active: true,
        },
      }],
    },
    target: target(),
    recordsApi: api.recordsApi,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.counts.failed, 1)
  assert.equal(result.errors[0].code, 'field_mapping_failed')
  assert.equal(result.errors[0].operation, 'queryRecords')
  assert.equal(result.errors[0].message, 'query target rows failed: field_mapping_failed')
  assert.equal(api.calls.some((call) => call[0] === 'createRecord'), false, 'query failure blocks create')

  const evidence = summarizeApplyResultForEvidence(result)
  assert.deepEqual(evidence.errorCodes, ['field_mapping_failed'])
  assert.deepEqual(evidence.errorSummaries, [{
    code: 'field_mapping_failed',
    count: 1,
    decisions: [DECISIONS.ADD],
    operations: ['queryRecords'],
  }])
  const text = JSON.stringify({ result, evidence })
  assert.equal(text.includes('P-001'), false, 'diagnostics must not expose project values')
  assert.equal(text.includes('PART-A'), false, 'diagnostics must not expose component values')
  assert.equal(text.includes('Unknown field'), false, 'raw query error message must not be surfaced')
}

async function testPlmStringFieldsAreNormalizedBeforeCreate() {
  const api = createRecordsApi()

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan: {
      decisions: [{
        decision: DECISIONS.ADD,
        idempotencyKey: 'key-string-normalize',
        record: {
          idempotencyKey: 'key-string-normalize',
          projectNo: 'P-001',
          componentSourceId: 'PART-A',
          parentSourceId: 0,
          path: '["PART-A"]',
          componentCode: 1001,
          componentName: 2002,
          material: 3003,
          sourceVersion: 7,
          rawQuantity: '2',
          totalQuantity: '6',
          active: 'true',
        },
      }],
    },
    target: target(),
    recordsApi: api.recordsApi,
  })

  assert.equal(result.status, 'succeeded')
  const createCall = api.calls.find((call) => call[0] === 'createRecord')
  assert.equal(createCall[1].data.parentSourceId, '0')
  assert.equal(createCall[1].data.componentCode, '1001')
  assert.equal(createCall[1].data.componentName, '2002')
  assert.equal(createCall[1].data.material, '3003')
  assert.equal(createCall[1].data.sourceVersion, '7')
  assert.equal(createCall[1].data.rawQuantity, 2)
  assert.equal(createCall[1].data.totalQuantity, 6)
  assert.equal(createCall[1].data.active, true)
}

async function testTemplateTypeMismatchIsValuesFreeAndLogical() {
  const api = createRecordsApi()

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan: {
      decisions: [{
        decision: DECISIONS.ADD,
        idempotencyKey: 'key-type-mismatch',
        record: {
          idempotencyKey: 'key-type-mismatch',
          projectNo: 'P-001',
          componentSourceId: 'PART-A',
          path: '["PART-A"]',
          componentCode: { raw: 'PART-A / P-001 / SECRET-OPTION' },
          active: true,
        },
      }],
    },
    target: target(),
    recordsApi: api.recordsApi,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.counts.failed, 1)
  assert.equal(api.calls.length, 0, 'type mismatch fails before any target read/write')
  assert.equal(result.errors[0].code, 'target_field_type_mismatch')
  assert.equal(result.errors[0].field, 'componentCode')
  assert.equal(result.errors[0].reason, 'type_mismatch')
  assert.equal(result.errors[0].expectedType, 'string')

  const evidence = summarizeApplyResultForEvidence(result)
  assert.deepEqual(evidence.errorCodes, ['target_field_type_mismatch'])
  assert.deepEqual(evidence.errorSummaries, [{
    code: 'target_field_type_mismatch',
    count: 1,
    decisions: [DECISIONS.ADD],
    operations: [],
    fields: ['componentCode'],
    reasons: ['type_mismatch'],
    expectedTypes: ['string'],
  }])
  const text = JSON.stringify({ result, evidence })
  assert.equal(text.includes('SECRET-OPTION'), false, 'diagnostics must not expose nested values')
  assert.equal(text.includes('PART-A / P-001'), false, 'diagnostics must not expose row/project values')
}

async function testFieldIdMapAndDuplicateTargetKey() {
  const decision = {
    decision: DECISIONS.UPDATE,
    idempotencyKey: 'dup-key',
    patch: {
      totalQuantity: 3,
      lastPlmRefreshDecision: DECISIONS.UPDATE,
    },
  }
  const api = createRecordsApi({
    existing: [
      { id: 'rec_1', data: { fld_idempotencyKey: 'dup-key' } },
      { id: 'rec_2', data: { fld_idempotencyKey: 'dup-key' } },
    ],
  })
  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan: { decisions: [decision] },
    target: target({
      fieldIdMap: {
        idempotencyKey: 'fld_idempotencyKey',
        totalQuantity: 'fld_totalQuantity',
        lastPlmRefreshDecision: 'fld_lastPlmRefreshDecision',
      },
    }),
    recordsApi: api.recordsApi,
  })

  assert.deepEqual(api.calls[0], ['queryRecords', {
    sheetId: 'sheet_stock_preparation',
    filters: { fld_idempotencyKey: 'dup-key' },
    limit: 2,
    offset: 0,
  }])
  assert.equal(result.counts.failed, 1)
  assert.equal(result.errors[0].code, 'duplicate_target_key')
  assert.equal(api.calls.some((call) => call[0] === 'patchRecord'), false, 'duplicate target keys fail before patch')
}

function testInternals() {
  assert.deepEqual(__internals.mapRecordFields({ idempotencyKey: 'k', totalQuantity: 2 }, {
    idempotencyKey: 'fld_key',
  }), {
    fld_key: 'k',
    totalQuantity: 2,
  })
  assert.equal(__internals.applyStatus({ failed: 1, held: 1 }, 0), 'failed')
  assert.equal(__internals.applyStatus({ failed: 0, held: 1 }, 0), 'held')
  assert.equal(__internals.applyStatus({ failed: 1, held: 0 }, 1), 'partial')
  assert.throws(() => __internals.normalizeTarget({}), StockPreparationApplyWriterError)
}

async function main() {
  await testApplyCleanDecisionsAndHoldManualConfirm()
  await testRerunIsIdempotentForAddDecision()
  await testUpdateAndInactiveNeverCreateMissingTargets()
  await testPermissionAndHumanFieldGuards()
  await testPlainCreateErrorsBecomeTypedValuesFreeDiagnostics()
  await testPlainQueryErrorsBecomeTypedValuesFreeDiagnostics()
  await testPlmStringFieldsAreNormalizedBeforeCreate()
  await testTemplateTypeMismatchIsValuesFreeAndLogical()
  await testFieldIdMapAndDuplicateTargetKey()
  testInternals()

  console.log('stock-preparation-apply-writer.test.cjs OK')
}

main().catch((err) => {
  console.error('stock-preparation-apply-writer.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
