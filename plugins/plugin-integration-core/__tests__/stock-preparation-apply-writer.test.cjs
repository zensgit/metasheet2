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

// `batchCapable` models the W9 host split. A host that DECLARES `supportsFilterValueLists`
// understands an array filter value (`= ANY(...)`); one that does not REFUSES it exactly the way an
// older host's `normalizeQueryFilters` does — so a writer that ignored the capability probe and sent
// a list anyway would fail here rather than quietly get the right answer from a lenient fake.
function createRecordsApi({ existing = [], batchCapable = false } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId || 'sheet_stock_preparation',
    version: entry.version || 1,
    data: { ...(entry.data || entry) },
  }))
  const calls = []
  const matchesFilter = (record, field, value) => {
    if (Array.isArray(value)) {
      if (!batchCapable) throw new Error(`Unsupported filter value for ${field}`)
      return value.some((entry) => record.data[field] === entry)
    }
    return record.data[field] === value
  }
  return {
    rows,
    calls,
    recordsApi: {
      ...(batchCapable ? { supportsFilterValueLists: true } : {}),
      async queryRecords(input) {
        calls.push(['queryRecords', input])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => matchesFilter(record, field, value)))
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
  // W9 attribution: a STRING key value is the server's own `->>` text; anything else is not, and
  // must be reported as unattributable rather than re-derived with `String(value)`.
  assert.equal(__internals.readRecordKeyValue({ data: { fld_key: 'K-1' } }, 'fld_key', 'idempotencyKey'), 'K-1')
  assert.equal(__internals.readRecordKeyValue({ data: { idempotencyKey: 'K-2' } }, 'fld_key', 'idempotencyKey'), 'K-2')
  assert.equal(__internals.readRecordKeyValue({ data: { k: 1 } }, 'k', 'k'), null, 'a JSON number is not `data ->> k`')
  assert.equal(__internals.readRecordKeyValue({ data: { k: true } }, 'k', 'k'), null)
  assert.equal(__internals.readRecordKeyValue({ data: { k: null } }, 'k', 'k'), null)
  assert.equal(__internals.readRecordKeyValue({ data: {} }, 'k', 'k'), null)
  assert.equal(__internals.readRecordKeyValue({}, 'k', 'k'), null)
  assert.equal(__internals.applyStatus({ failed: 1, held: 1 }, 0), 'failed')
  assert.equal(__internals.applyStatus({ failed: 0, held: 1 }, 0), 'held')
  assert.equal(__internals.applyStatus({ failed: 1, held: 0 }, 1), 'partial')
  assert.throws(() => __internals.normalizeTarget({}), StockPreparationApplyWriterError)
}

// W8-4 (L1): the writer opens ONE host metadata scope per apply run so the host stops re-reading
// this target's sheet row / field list / ownership row once per written record (measured on 222:
// 2x `meta_fields` + 2x registry + 3x `meta_sheets` per created row). These assertions pin the
// boundary and the fact that NOTHING else moved: same records calls, same order, same result body,
// same per-row failure semantics.
async function testMetadataCacheScopeIsOpenedOncePerApplyRun() {
  const plan = buildPlan()
  const api = createRecordsApi()
  const scopeCalls = []
  let depth = 0
  let maxDepth = 0
  const recordsApi = {
    async queryRecords(input) {
      scopeCalls.push(['queryRecords', depth])
      return api.recordsApi.queryRecords(input)
    },
    async createRecord(input) {
      scopeCalls.push(['createRecord', depth])
      return api.recordsApi.createRecord(input)
    },
    async patchRecord(input) {
      scopeCalls.push(['patchRecord', depth])
      return api.recordsApi.patchRecord(input)
    },
    async withMetadataCache(operation) {
      depth += 1
      maxDepth = Math.max(maxDepth, depth)
      try {
        return await operation()
      } finally {
        depth -= 1
      }
    },
  }

  const withScope = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi,
  })

  assert.equal(maxDepth, 1, 'exactly one metadata scope is opened, never one per row')
  assert.ok(scopeCalls.length > 0, 'the run actually touched the records API')
  assert.ok(
    scopeCalls.every(([, callDepth]) => callDepth === 1),
    'every records call happens INSIDE the single scope',
  )

  // Byte-for-byte the same answer as a host that offers no such capability at all.
  const baseline = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: createRecordsApi().recordsApi,
  })
  assert.deepEqual(withScope, baseline, 'opening a metadata scope does not change the result body')
  assert.deepEqual(
    Object.keys(summarizeApplyResultForEvidence(withScope)).sort(),
    Object.keys(summarizeApplyResultForEvidence(baseline)).sort(),
    'evidence key set is unchanged',
  )
}

async function testMetadataCacheScopeKeepsPerRowFailureSemantics() {
  const plan = buildPlan()
  const addDecision = plan.decisions.find((entry) => entry.decision === DECISIONS.ADD)
  const base = createRecordsApi()
  let scopes = 0
  const recordsApi = {
    queryRecords: (input) => base.recordsApi.queryRecords(input),
    async createRecord() {
      // Fail ONLY the add row; the update/inactive rows must still be written. A chunk-wide
      // transaction (L3) would lose exactly this contract — the metadata scope must not.
      throw new Error('create failed')
    },
    patchRecord: (input) => base.recordsApi.patchRecord(input),
    async withMetadataCache(operation) {
      scopes += 1
      return operation()
    },
  }
  base.rows.push(
    {
      id: 'rec_update',
      sheetId: 'sheet_stock_preparation',
      version: 1,
      data: {
        idempotencyKey: plan.decisions.find((entry) => entry.decision === DECISIONS.UPDATE).idempotencyKey,
      },
    },
    {
      id: 'rec_inactive',
      sheetId: 'sheet_stock_preparation',
      version: 1,
      data: {
        idempotencyKey: plan.decisions.find((entry) => entry.decision === DECISIONS.INACTIVE).idempotencyKey,
        active: true,
      },
    },
  )

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi,
  })

  assert.ok(addDecision, 'plan has an add decision to fail')
  assert.equal(scopes, 1, 'still one scope, even when a row throws')
  assert.equal(result.counts.failed, 1, 'the bad row is counted failed')
  assert.equal(result.counts.updated, 1, 'the update row was still written')
  assert.equal(result.counts.inactive, 1, 'the inactive row was still written')
  assert.equal(result.written, 2, 'a failing row does not roll back the rows around it')
  assert.equal(result.status, 'partial', 'one bad row does not abort the rest')
}

// The decision loop now runs inside a HOST capability, so "it ran" stopped being visible from the
// writer. A host that resolved `withMetadataCache` without invoking the operation would otherwise
// yield written=0 / errors=[] / status='succeeded', and the chunk runner would advance its
// checkpoint past every decision — rows silently dropped behind a green result.
async function testMetadataCacheScopeThatSkipsTheOperationFailsLoudly() {
  const plan = buildPlan()
  const base = createRecordsApi()
  const recordsApi = {
    queryRecords: (input) => base.recordsApi.queryRecords(input),
    createRecord: (input) => base.recordsApi.createRecord(input),
    patchRecord: (input) => base.recordsApi.patchRecord(input),
    // A host that forgets to call `operation`.
    async withMetadataCache() {},
  }

  await assert.rejects(
    () => applyStockPreparationPlan({
      permission: 'write',
      plan,
      target: target(),
      recordsApi,
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationApplyWriterError)
      assert.equal(error.details.code, 'metadata_scope_incomplete')
      assert.equal(error.details.actual, 0)
      assert.equal(error.details.expected, plan.decisions.length)
      return true
    },
    'a scope that never ran the decisions must not look like a successful apply',
  )
}

// ---------------------------------------------------------------------------
// W9: the per-chunk batch idempotency-key lookup. Every assertion below is about EQUIVALENCE — the
// batch path must answer what the per-row path answers, and every case it cannot answer must fall
// back to the per-row path rather than guess.
const BATCH_KEY_LOOKUP_ENV = 'MULTITABLE_STOCK_PREP_BATCH_KEY_LOOKUP'

async function withBatchKeyLookupEnv(value, run) {
  const had = Object.prototype.hasOwnProperty.call(process.env, BATCH_KEY_LOOKUP_ENV)
  const previous = process.env[BATCH_KEY_LOOKUP_ENV]
  if (value === undefined) delete process.env[BATCH_KEY_LOOKUP_ENV]
  else process.env[BATCH_KEY_LOOKUP_ENV] = value
  try {
    return await run()
  } finally {
    if (had) process.env[BATCH_KEY_LOOKUP_ENV] = previous
    else delete process.env[BATCH_KEY_LOOKUP_ENV]
  }
}

function addDecisionFor(componentSourceId) {
  const record = row({ componentSourceId, pathTokens: [componentSourceId] })
  return { decision: DECISIONS.ADD, idempotencyKey: record.idempotencyKey, record }
}

function countQueryCalls(api) {
  return api.calls.filter((call) => call[0] === 'queryRecords').length
}

// (f) + (a): one query for the whole chunk instead of one per row, and a key that already exists is
// still an update — the batch answer is used, not ignored.
async function testBatchKeyLookupIssuesOneQueryPerChunk() {
  const plan = { decisions: ['PART-1', 'PART-2', 'PART-3', 'PART-4', 'PART-5', 'PART-6'].map(addDecisionFor) }
  const existingKey = plan.decisions[2].idempotencyKey

  const batched = createRecordsApi({
    batchCapable: true,
    existing: [{ id: 'rec_pre', data: { idempotencyKey: existingKey, notes: 'operator note' } }],
  })
  const batchedResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: batched.recordsApi,
  })

  assert.equal(countQueryCalls(batched), 1, 'a whole chunk costs ONE idempotency-key query')
  const batchQuery = batched.calls.find((call) => call[0] === 'queryRecords')[1]
  assert.deepEqual(
    batchQuery.filters.idempotencyKey,
    plan.decisions.map((decision) => decision.idempotencyKey),
    'the one query carries every key in the chunk, in decision order',
  )
  assert.equal(batchQuery.limit, plan.decisions.length * 2 + 1, 'the batch query is bounded, never open-ended')
  assert.equal(batchedResult.counts.created, 5)
  assert.equal(batchedResult.counts.updated, 1, 'the pre-existing key is updated, not re-created')
  assert.equal(batchedResult.results[2].status, 'updated')
  assert.equal(batchedResult.results[2].recordId, 'rec_pre')

  // Same plan, host that cannot filter by a list: one query PER ROW, and the same answer.
  const perRow = createRecordsApi({
    existing: [{ id: 'rec_pre', data: { idempotencyKey: existingKey, notes: 'operator note' } }],
  })
  const perRowResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: perRow.recordsApi,
  })
  assert.equal(countQueryCalls(perRow), plan.decisions.length, 'without the capability it is one query per row')
  assert.deepEqual(batchedResult, perRowResult, 'batching changes the number of queries, not the answer')
}

// (b) THE mutation this design has to survive: two decisions carrying the SAME key inside ONE chunk.
// A prefetched index that is not updated after the first write still says "no such row" and the
// second decision inserts a duplicate.
async function testSecondDecisionWithSameKeyInOneChunkUpdatesInsteadOfCreating() {
  const first = addDecisionFor('PART-DUP')
  const plan = {
    decisions: [
      first,
      { ...first, record: { ...first.record, rawQuantity: 9, totalQuantity: 9 } },
    ],
  }

  const batched = createRecordsApi({ batchCapable: true })
  const batchedResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: batched.recordsApi,
  })

  assert.equal(batchedResult.results[0].status, 'created')
  assert.equal(batchedResult.results[1].status, 'updated', 'the second decision for the same key must NOT create a second row')
  assert.equal(batchedResult.counts.created, 1)
  assert.equal(batchedResult.counts.updated, 1)
  assert.equal(batched.rows.length, 1, 'exactly one target row exists afterwards')
  assert.equal(batched.rows[0].data.rawQuantity, 9, 'the second decision landed on that row')

  const perRow = createRecordsApi()
  const perRowResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: perRow.recordsApi,
  })
  assert.deepEqual(batchedResult, perRowResult, 'same-key-twice behaves identically on both paths')
  assert.equal(perRow.rows.length, 1)
}

// (c) the duplicate_target_key guard survives batching: it is now "more than one row grouped under
// this key", which is the same question `LIMIT 2` asks per row.
async function testDuplicateTargetKeyStillRefusesUnderBatchLookup() {
  const decision = addDecisionFor('PART-TWIN')
  const plan = { decisions: [decision] }
  const existing = [
    { id: 'rec_a', data: { idempotencyKey: decision.idempotencyKey } },
    { id: 'rec_b', data: { idempotencyKey: decision.idempotencyKey } },
  ]

  const batched = createRecordsApi({ batchCapable: true, existing })
  const batchedResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: batched.recordsApi,
  })

  assert.equal(batchedResult.counts.failed, 1)
  assert.equal(batchedResult.errors[0].code, 'duplicate_target_key')
  assert.equal(batched.calls.filter((call) => call[0] === 'createRecord').length, 0, 'a duplicate key writes nothing')

  const perRowResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: createRecordsApi({ existing }).recordsApi,
  })
  assert.deepEqual(batchedResult, perRowResult, 'the duplicate guard reads the same on both paths')
}

// (g) the batch is BOUNDED, and hitting the bound is treated as "I may not have seen everything" —
// the whole chunk falls back to per-row lookups rather than acting on a truncated set.
async function testBatchAtTheUpperBoundFallsBackToPerRowLookup() {
  const decision = addDecisionFor('PART-CROWD')
  const plan = { decisions: [decision] }
  // limit = 1 key * 2 + 1 = 3, and three rows carry the key: the host filled the bound exactly.
  const existing = ['rec_a', 'rec_b', 'rec_c'].map((id) => ({ id, data: { idempotencyKey: decision.idempotencyKey } }))

  const batched = createRecordsApi({ batchCapable: true, existing })
  const batchedResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: batched.recordsApi,
  })

  assert.equal(countQueryCalls(batched), 2, 'the bounded batch is followed by the per-row query it fell back to')
  assert.equal(batched.calls[0][1].limit, 3, 'the batch asked for one more row than it could ever need')
  assert.equal(batched.calls[1][1].limit, 2, 'the fallback is the unchanged per-row lookup')
  assert.equal(batchedResult.counts.failed, 1)
  assert.equal(batchedResult.errors[0].code, 'duplicate_target_key')

  const perRowResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: createRecordsApi({ existing }).recordsApi,
  })
  assert.deepEqual(batchedResult, perRowResult, 'a truncated batch changes nothing about the answer')
}

// (d) + (e): the two ways the batch path is not taken — no host capability, and the kill switch —
// produce the SAME result body and the SAME evidence as the batch path, on a full mixed plan.
async function testFallbackPathsMatchTheBatchPathExactly() {
  const existingFor = (plan) => {
    const updateDecision = plan.decisions.find((entry) => entry.decision === DECISIONS.UPDATE)
    const inactiveDecision = plan.decisions.find((entry) => entry.decision === DECISIONS.INACTIVE)
    return [
      { id: 'rec_update', data: { idempotencyKey: updateDecision.idempotencyKey, notes: 'operator note', materialType: 'human material', rawQuantity: 4 } },
      { id: 'rec_inactive', data: { idempotencyKey: inactiveDecision.idempotencyKey, notes: 'keep gone', active: true } },
    ]
  }
  const run = async (options) => {
    const plan = buildPlan()
    const api = createRecordsApi({ ...options, existing: existingFor(plan) })
    const result = await applyStockPreparationPlan({
      permission: 'write',
      plan,
      target: target(),
      recordsApi: api.recordsApi,
    })
    return { api, result }
  }

  const batched = await withBatchKeyLookupEnv(undefined, () => run({ batchCapable: true }))
  const noCapability = await withBatchKeyLookupEnv(undefined, () => run({}))
  const switchedOff = await withBatchKeyLookupEnv('false', () => run({ batchCapable: true }))

  const perRowQueries = countQueryCalls(noCapability.api)
  assert.ok(perRowQueries > 1, 'the per-row baseline really does query more than once')
  assert.equal(countQueryCalls(batched.api), 1, 'default is ON: one query for the chunk')
  assert.equal(countQueryCalls(switchedOff.api), perRowQueries, 'the kill switch restores the per-row lookup')
  assert.ok(
    switchedOff.api.calls.every((call) => call[0] !== 'queryRecords' || !Array.isArray(call[1].filters.idempotencyKey)),
    'with the switch off no list filter is ever sent',
  )

  assert.deepEqual(noCapability.result, batched.result, 'a host without the capability gets the same answer')
  assert.deepEqual(switchedOff.result, batched.result, 'the kill switch changes the answer not at all')
  assert.deepEqual(
    summarizeApplyResultForEvidence(noCapability.result),
    summarizeApplyResultForEvidence(batched.result),
    'evidence is identical on both paths',
  )
  assert.deepEqual(
    summarizeApplyResultForEvidence(switchedOff.result),
    summarizeApplyResultForEvidence(batched.result),
    'evidence is identical with the switch off',
  )
  assert.deepEqual(
    batched.api.rows.map((entry) => entry.data),
    noCapability.api.rows.map((entry) => entry.data),
    'the rows actually written are identical',
  )
}

// A host that DECLARES the capability but answers with rows the writer cannot attribute to a key it
// asked for must not be trusted into a wrong index — the chunk falls back instead.
async function testUnattributableBatchRowsFallBackToPerRowLookup() {
  const decision = addDecisionFor('PART-ODD')
  const plan = { decisions: [decision] }
  const calls = []
  const inner = createRecordsApi({ batchCapable: true })
  const recordsApi = {
    supportsFilterValueLists: true,
    async queryRecords(input) {
      calls.push(input)
      if (Array.isArray(input.filters.idempotencyKey)) {
        // A row with no recognizable key value at all.
        return [{ id: 'rec_mystery', sheetId: input.sheetId, version: 1, data: { componentCode: 'X' } }]
      }
      return inner.recordsApi.queryRecords(input)
    },
    createRecord: (input) => inner.recordsApi.createRecord(input),
    patchRecord: (input) => inner.recordsApi.patchRecord(input),
  }

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi,
  })

  assert.equal(calls.length, 2, 'the unusable batch is followed by the per-row query')
  assert.equal(result.counts.created, 1, 'and the row is written exactly once')
  assert.equal(result.counts.failed, 0)
  assert.equal(inner.rows.length, 1)
}

// The one fake in this file that models PostgreSQL's `data ->> key` TEXT projection instead of JS
// `===`. It has to exist: every other fake here matches with `===`, which cannot distinguish
// "the server matched this row" from "the writer re-derived the same text", and so cannot see the
// bug this guards. A jsonb number keeps the scale it was stored with — `1.0` projects to "1.0" —
// while `JSON.parse('1.0')` is already the JS number 1 and `String(1)` is "1". JS cannot hold that
// difference, so each row carries its `->>` text beside its parsed `data`, exactly as the database
// and the JSON payload hold two different things.
function createPgTextRecordsApi({ existing = [], batchCapable = false, keyField = 'idempotencyKey' } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId || 'sheet_stock_preparation',
    version: 1,
    data: { ...entry.data },
    keyText: entry.keyText,
  }))
  const calls = []
  const matches = (record, field, value) => {
    // Only the key column has a hand-written projection; everything else is an ordinary value.
    const projected = field === keyField ? record.keyText : record.data[field]
    if (Array.isArray(value)) {
      if (!batchCapable) throw new Error(`Unsupported filter value for ${field}`)
      return value.some((entry) => projected === entry)
    }
    return projected === value
  }
  return {
    rows,
    calls,
    recordsApi: {
      ...(batchCapable ? { supportsFilterValueLists: true } : {}),
      async queryRecords(input) {
        calls.push(['queryRecords', input])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => matches(record, field, value)))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map((record) => ({ id: record.id, sheetId: record.sheetId, version: record.version, data: record.data }))
      },
      async createRecord(input) {
        calls.push(['createRecord', input])
        const record = {
          id: `rec_${rows.length + 1}`,
          sheetId: input.sheetId,
          version: 1,
          data: { ...input.data },
          keyText: String(input.data[keyField]),
        }
        rows.push(record)
        return { id: record.id, sheetId: record.sheetId, version: record.version, data: record.data }
      },
      async patchRecord(input) {
        calls.push(['patchRecord', input])
        const record = rows.find((item) => item.sheetId === input.sheetId && item.id === input.recordId)
        if (!record) throw new Error(`record not found: ${input.recordId}`)
        record.version += 1
        record.data = { ...record.data, ...input.changes }
        return { id: record.id, sheetId: record.sheetId, version: record.version, data: record.data }
      },
    },
  }
}

// (h) A returned row whose key value is not a string must NOT be attributed by re-deriving the
// server's text with `String(value)`. Here the stored key is the jsonb number `1.0`: the server
// answers the `= ANY('{"1.0","1"}')` query with it because `->>` yields "1.0", but `String(1)` is
// "1" — another key in this very chunk. Re-derivation would file the row under "1", patch it with
// THAT decision's payload, and insert a fresh duplicate for "1.0", with `index.has()` returning
// true so no guard ever fires. The chunk must fall back to per-row lookups instead and let the
// database keep deciding.
async function testNonStringKeyValuesFallBackInsteadOfBeingMisattributed() {
  const decisionFor = (key, rawQuantity) => {
    const record = row({ componentSourceId: `PART-${key}`, pathTokens: [`PART-${key}`], rawQuantity, totalQuantity: rawQuantity })
    return { decision: DECISIONS.ADD, idempotencyKey: key, record: { ...record, idempotencyKey: key } }
  }
  // `1.0` already exists in the target sheet; `1` does not. Both are in this chunk.
  const existing = [{ id: 'rec_a', keyText: '1.0', data: { idempotencyKey: 1, notes: 'operator note' } }]
  const plan = { decisions: [decisionFor('1.0', 11), decisionFor('1', 22)] }

  const batched = createPgTextRecordsApi({ batchCapable: true, existing })
  const batchedResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: batched.recordsApi,
  })

  assert.equal(countQueryCalls(batched), 3, 'the batch is attempted once, then the whole chunk falls back to per-row')
  assert.ok(Array.isArray(batched.calls[0][1].filters.idempotencyKey), 'the first query really was the batch')
  assert.equal(batchedResult.results[0].status, 'updated', 'key `1.0` belongs to the row the server matched')
  assert.equal(batchedResult.results[0].recordId, 'rec_a')
  assert.equal(batchedResult.results[1].status, 'created', 'key `1` is a new row, not a patch of `1.0`')
  assert.equal(batched.rows.length, 2)
  assert.equal(batched.rows[0].data.rawQuantity, 11, 'the existing row carries ITS OWN key’s payload')
  assert.equal(batched.rows[0].data.notes, 'operator note', 'and keeps the operator column')

  const perRow = createPgTextRecordsApi({ existing })
  const perRowResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: perRow.recordsApi,
  })
  assert.deepEqual(batchedResult, perRowResult, 'an unattributable row costs the speed-up, never the answer')
  assert.deepEqual(
    batched.rows.map((entry) => entry.data),
    perRow.rows.map((entry) => entry.data),
    'and the rows written are identical',
  )
}

// A write that LANDED and then threw — a connection lost after COMMIT is the realistic shape, and
// `createRecord`/`patchRecord` have nothing else outside the transaction. Only the success paths
// keep the prefetched index in step, so a stale empty bucket would make the second decision
// carrying this key insert a SECOND row under one idempotency key: a durable defect that fails
// every future apply of that key with `duplicate_target_key` until someone cleans it up by hand.
async function testWriteThatLandedBeforeThrowingLeavesNoStaleIndexEntry() {
  const first = addDecisionFor('PART-POSTCOMMIT')
  const plan = {
    decisions: [first, { ...first, record: { ...first.record, rawQuantity: 9, totalQuantity: 9 } }],
  }
  const build = (batchCapable) => {
    const inner = createRecordsApi({ batchCapable })
    let creates = 0
    return {
      inner,
      recordsApi: {
        ...(batchCapable ? { supportsFilterValueLists: true } : {}),
        queryRecords: (input) => inner.recordsApi.queryRecords(input),
        async createRecord(input) {
          const created = await inner.recordsApi.createRecord(input)
          creates += 1
          if (creates === 1) throw new Error('connection terminated unexpectedly')
          return created
        },
        patchRecord: (input) => inner.recordsApi.patchRecord(input),
      },
    }
  }

  const batched = build(true)
  const batchedResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: batched.recordsApi,
  })

  assert.equal(batchedResult.results[0].status, 'failed', 'the create reported failure, as it did')
  assert.equal(batchedResult.results[1].status, 'updated', 'the second decision finds the row that landed anyway')
  assert.equal(batched.inner.rows.length, 1, 'ONE row for one idempotency key, never two')
  assert.equal(batched.inner.rows[0].data.rawQuantity, 9, 'and the second decision landed on it')

  const perRow = build(false)
  const perRowResult = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi: perRow.recordsApi,
  })
  assert.deepEqual(batchedResult, perRowResult, 'a write that landed before throwing reads identically on both paths')
  assert.equal(perRow.inner.rows.length, 1)
}

// `rememberWrittenRow` records a real row id or nothing — never a fabricated one. A host that
// creates the row but answers without an id must send the next lookup for that key back to the
// database; assuming "absent" would insert a duplicate, and inventing an id would patch nothing.
async function testCreateWithoutARowIdSendsTheNextLookupBackToTheDatabase() {
  const first = addDecisionFor('PART-NOID')
  const plan = {
    decisions: [first, { ...first, record: { ...first.record, rawQuantity: 7, totalQuantity: 7 } }],
  }
  const inner = createRecordsApi({ batchCapable: true })
  const calls = []
  const recordsApi = {
    supportsFilterValueLists: true,
    async queryRecords(input) {
      calls.push(input)
      return inner.recordsApi.queryRecords(input)
    },
    async createRecord(input) {
      const created = await inner.recordsApi.createRecord(input)
      return { ...created, id: undefined }
    },
    patchRecord: (input) => inner.recordsApi.patchRecord(input),
  }

  const result = await applyStockPreparationPlan({
    permission: 'write',
    plan,
    target: target(),
    recordsApi,
  })

  assert.equal(calls.length, 2, 'the dropped key is asked of the database, not assumed absent')
  assert.ok(!Array.isArray(calls[1].filters.idempotencyKey), 'and it is asked with the unchanged per-row lookup')
  assert.equal(result.results[1].status, 'updated', 'the second decision patches the row that was created')
  assert.equal(inner.rows.length, 1, 'exactly one row exists afterwards')
  assert.equal(inner.rows[0].data.rawQuantity, 7)
}

// A chunk larger than any chunk the capped route can produce falls back rather than building a
// list filter with no ceiling of its own.
async function testOversizedChunkFallsBackToPerRowLookup() {
  const oversized = { decisions: Array.from({ length: 1001 }, (unused, index) => addDecisionFor(`PART-BIG-${index}`)) }
  const api = createRecordsApi({ batchCapable: true })
  await applyStockPreparationPlan({ permission: 'write', plan: oversized, target: target(), recordsApi: api.recordsApi })
  assert.equal(countQueryCalls(api), 1001, 'past the bound it is the per-row path, unchanged')
  assert.ok(
    api.calls.every((call) => call[0] !== 'queryRecords' || !Array.isArray(call[1].filters.idempotencyKey)),
    'and no unbounded list filter is ever sent',
  )

  const atBound = { decisions: oversized.decisions.slice(0, 1000) }
  const bounded = createRecordsApi({ batchCapable: true })
  await applyStockPreparationPlan({ permission: 'write', plan: atBound, target: target(), recordsApi: bounded.recordsApi })
  assert.equal(countQueryCalls(bounded), 1, 'a chunk at the bound is still batched')
}

// The only off switch of a default-ON behaviour has to answer to what an operator types under
// pressure, not to one blessed spelling.
function testKillSwitchAcceptsTheSpellingsOperatorsType() {
  for (const value of ['false', 'FALSE', ' false ', '0', 'off', 'OFF', 'no', 'No']) {
    assert.equal(
      __internals.batchKeyLookupDisabled({ [BATCH_KEY_LOOKUP_ENV]: value }),
      true,
      `${JSON.stringify(value)} must roll the batch lookup back`,
    )
  }
  for (const value of [undefined, '', '   ', 'true', '1', 'on', 'yes', 'falsey']) {
    assert.equal(
      __internals.batchKeyLookupDisabled({ [BATCH_KEY_LOOKUP_ENV]: value }),
      false,
      `${JSON.stringify(value)} must leave the default ON`,
    )
  }
  assert.equal(__internals.batchKeyLookupDisabled({}), false, 'unset is ON')
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
  await testMetadataCacheScopeIsOpenedOncePerApplyRun()
  await testMetadataCacheScopeKeepsPerRowFailureSemantics()
  await testMetadataCacheScopeThatSkipsTheOperationFailsLoudly()
  await testBatchKeyLookupIssuesOneQueryPerChunk()
  await testSecondDecisionWithSameKeyInOneChunkUpdatesInsteadOfCreating()
  await testDuplicateTargetKeyStillRefusesUnderBatchLookup()
  await testBatchAtTheUpperBoundFallsBackToPerRowLookup()
  await testFallbackPathsMatchTheBatchPathExactly()
  await testUnattributableBatchRowsFallBackToPerRowLookup()
  await testNonStringKeyValuesFallBackInsteadOfBeingMisattributed()
  await testWriteThatLandedBeforeThrowingLeavesNoStaleIndexEntry()
  await testCreateWithoutARowIdSendsTheNextLookupBackToTheDatabase()
  await testOversizedChunkFallsBackToPerRowLookup()
  testKillSwitchAcceptsTheSpellingsOperatorsType()
  testInternals()

  console.log('stock-preparation-apply-writer.test.cjs OK')
}

main().catch((err) => {
  console.error('stock-preparation-apply-writer.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
