'use strict'

// #2253 C5-1 tests: backend parameterized stock-preparation action contract.
// Locks server-side dry-run token binding, recompute-before-apply, target-scoped
// records API, and values-free evidence. No UI, no external DB write, no K3.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  StockPreparationTableActionError,
  applyStockPreparationAction,
  createStockPreparationTableActionRegistry,
  dryRunStockPreparationAction,
  normalizeStockPreparationActionConfig,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const PHYSICAL_FIELD_ID_MAP = Object.fromEntries(
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]),
)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createMemoryStorage() {
  const map = new Map()
  return {
    map,
    async get(key) {
      return map.get(key) || null
    },
    async set(key, value) {
      map.set(key, clone(value))
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

function baseAction(overrides = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: {
      externalSystemId: 'plm_source_1',
      kind: 'data-source:sql-readonly',
    },
    target: {
      sheetId: 'sheet_stock',
      objectId: 'stockPreparationMain',
    },
    ...overrides,
  }
}

function basePlmData(overrides = {}) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
    ...overrides,
  }
}

function createSourceAdapter(data = basePlmData()) {
  const calls = []
  return {
    calls,
    adapter: {
      async read(input = {}) {
        calls.push(clone(input))
        assert.ok(input.object, 'source read has object')
        assert.ok(input.filters && Object.keys(input.filters).length > 0, 'source read has equality filters')
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const matches = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected),
        )
        const offset = input.cursor ? Number(input.cursor) : 0
        const limit = input.limit || 1000
        const records = matches.slice(offset, offset + limit).map(clone)
        return {
          records,
          done: offset + records.length >= matches.length,
          nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null,
        }
      },
    },
  }
}

function createRecordsApi({ existing = [] } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId || 'sheet_stock',
    version: entry.version || 1,
    data: { ...(entry.data || entry) },
  }))
  const calls = []
  return {
    rows,
    calls,
    recordsApi: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords', clone(input)])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map(clone)
      },
      async createRecord(input = {}) {
        calls.push(['createRecord', clone(input)])
        const record = {
          id: `rec_${rows.length + 1}`,
          sheetId: input.sheetId,
          version: 1,
          data: { ...(input.data || {}) },
        }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord', clone(input)])
        const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
        if (!record) throw new Error(`record not found: ${input.recordId}`)
        record.version += 1
        record.data = { ...record.data, ...(input.changes || {}) }
        return clone(record)
      },
    },
  }
}

async function testRegistryListsConfiguredMetadataWithoutTargetSecrets() {
  const registry = createStockPreparationTableActionRegistry({ actions: [baseAction()] })
  const actions = await registry.listTableActions()
  assert.equal(actions.length, 1)
  assert.equal(actions[0].actionId, PLM_STOCK_PREPARATION_ACTION_ID)
  assert.equal(actions[0].configured, true)
  assert.deepEqual(actions[0].parameters.map((param) => param.id), ['projectNo'])
  const text = JSON.stringify(actions)
  assert.equal(text.includes('sheet_stock'), false, 'public action metadata does not expose target sheetId')
  assert.equal(text.includes('plm_source_1'), false, 'public action metadata does not expose source binding')

  const unconfigured = createStockPreparationTableActionRegistry()
  assert.equal((await unconfigured.listTableActions())[0].configured, false)
  await assert.rejects(
    () => unconfigured.getTableAction({ actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
    /not configured/,
  )
}

async function testDryRunRequiresAllowlistedParametersAndStoresToken() {
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const storage = createMemoryStorage()

  await assert.rejects(
    () => dryRunStockPreparationAction({
      action: baseAction(),
      parameters: { projectNo: 'P-001', sheetId: 'evil' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
    }),
    /unsupported parameter: sheetId/,
    'operator cannot add extra parameters',
  )

  const dryRun = await dryRunStockPreparationAction({
    action: baseAction(),
    parameters: { projectNo: ' P-001 ' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(dryRun.status, 'ready')
  assert.equal(typeof dryRun.dryRunToken, 'string')
  assert.equal(dryRun.counts.add, 1)
  assert.equal(records.calls[0][1].sheetId, 'sheet_stock', 'existing-row read is scoped to configured target sheet')
  assert.deepEqual(records.calls[0][1].filters, { projectNo: 'P-001' }, 'existing-row read filters to one project')
  assert.equal(JSON.stringify(dryRun.evidence).includes('P-001'), false, 'evidence hides project value')
  assert.equal(JSON.stringify(dryRun.evidence).includes('Assembly'), false, 'evidence hides component name')
}

async function testDryRunUsesPhysicalTargetFieldMapForExistingRowFilter() {
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const storage = createMemoryStorage()

  const dryRun = await dryRunStockPreparationAction({
    action: baseAction({
      target: {
        sheetId: 'sheet_stock',
        objectId: 'stockPreparationMain',
        fieldIdMap: PHYSICAL_FIELD_ID_MAP,
      },
    }),
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(dryRun.status, 'ready')
  assert.deepEqual(
    records.calls[0][1].filters,
    { fld_projectNo: 'P-001' },
    'canonical target bindings with physical ids filter existing rows by the physical project field',
  )
  assert.equal(JSON.stringify(dryRun.evidence).includes('P-001'), false, 'field-map dry-run evidence hides project value')
}

async function testBridgeSourceKindRequiresExplicitMatchingReadPlanAndCanDryRun() {
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const storage = createMemoryStorage()
  const action = normalizeStockPreparationActionConfig(baseAction({
    source: {
      externalSystemId: 'bridge_source_1',
      kind: 'bridge:legacy-sql-readonly',
    },
  }))

  assert.equal(action.source.kind, 'bridge:legacy-sql-readonly')
  assert.equal(action.source.readPlan.sourceKind, 'bridge:legacy-sql-readonly', 'omitted readPlan sourceKind inherits the explicit Bridge source kind')

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(dryRun.status, 'ready')
  assert.equal(dryRun.counts.add, 1)
  assert.equal(source.calls.every((call) => call.filters && Object.keys(call.filters).length > 0), true, 'Bridge C5 dry-run still uses equality-filtered flat reads')

  assert.throws(
    () => normalizeStockPreparationActionConfig(baseAction({
      source: {
        externalSystemId: 'bridge_source_1',
        kind: 'bridge:legacy-sql-readonly',
        readPlan: { ...action.source.readPlan, sourceKind: 'data-source:sql-readonly' },
      },
    })),
    /source\.readPlan\.sourceKind must match source\.kind/,
    'Bridge source cannot carry a data-source readPlan by accident',
  )
}

async function testTargetFieldMapIncompleteFailsBeforeReads() {
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const storage = createMemoryStorage()
  const action = baseAction({
    target: {
      sheetId: 'sheet_stock',
      objectId: 'stockPreparationMain',
      fieldIdMap: {
        projectNo: 'fld_project_no',
        componentSourceId: 'fld_component_source_id',
      },
    },
  })

  function assertTargetSchemaIncomplete(error) {
    assert.equal(error.name, 'StockPreparationTableActionError')
    assert.equal(error.status, 422)
    assert.equal(error.code, 'TARGET_SCHEMA_INCOMPLETE')
    assert.equal(error.details.fieldMapMode, 'explicit')
    assert.equal(error.details.targetObjectId, 'stockPreparationMain')
    assert.ok(error.details.missingFields.includes('idempotencyKey'), 'idempotencyKey is required')
    assert.ok(error.details.missingFields.includes('path'), 'path is required')
    assert.ok(error.details.missingFields.includes('lastPlmRefreshDecision'), 'refresh decision is required')
    assert.equal(JSON.stringify(error.details).includes('sheet_stock'), false, 'error details do not expose sheetId')
    return true
  }

  await assert.rejects(
    () => dryRunStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
    }),
    assertTargetSchemaIncomplete,
  )
  assert.equal(source.calls.length, 0, 'dry-run target preflight fails before PLM source reads')
  assert.equal(records.calls.length, 0, 'dry-run target preflight fails before target reads')

  await assert.rejects(
    () => applyStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      dryRunToken: 'not-used',
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      permission: 'write',
    }),
    assertTargetSchemaIncomplete,
  )
  assert.equal(source.calls.length, 0, 'apply target preflight fails before PLM source reads')
  assert.equal(records.calls.length, 0, 'apply target preflight fails before target reads or writes')
}

async function testApplyRequiresTokenRecomputesAndScopesTarget() {
  const storage = createMemoryStorage()
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const action = baseAction()

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  await assert.rejects(
    () => applyStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      permission: 'write',
    }),
    /dryRunToken is required/,
    'apply cannot jump straight past dry-run',
  )

  const result = await applyStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    dryRunToken: dryRun.dryRunToken,
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    permission: 'write',
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.permission, 'write')
  assert.equal(result.apply.counts.created, 1)
  const createCall = records.calls.find((call) => call[0] === 'createRecord')
  assert.equal(createCall[1].sheetId, 'sheet_stock', 'C4 writes only the configured target sheet')
  assert.equal(JSON.stringify(result.evidence).includes('P-001'), false, 'apply evidence hides project value')
  assert.equal(JSON.stringify(result.evidence).includes('A-001'), false, 'apply evidence hides component code')

  await assert.rejects(
    () => applyStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      dryRunToken: dryRun.dryRunToken,
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      permission: 'write',
    }),
    /missing, expired, or already used/,
    'dry-run token is one-use',
  )
}

async function testApplyDetectsDataShiftAndManualConfirmHold() {
  const storage = createMemoryStorage()
  const originalSource = createSourceAdapter()
  const shiftedSource = createSourceAdapter(basePlmData({
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '3' }],
  }))
  const records = createRecordsApi()
  const action = baseAction()

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: originalSource.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  await assert.rejects(
    () => applyStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      dryRunToken: dryRun.dryRunToken,
      sourceAdapter: shiftedSource.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      permission: 'write',
    }),
    /does not match the current dry-run revision/,
    'apply recomputes and rejects data shifted after review',
  )

  const manualStorage = createMemoryStorage()
  const sourceWithRowError = createSourceAdapter(basePlmData({
    DN_PDM_OrderDetailInfo: [
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' },
      { order_id: 'ORDER-1', part_id: 'PART-MISSING', quantity: '1' },
    ],
  }))
  const manualDryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: sourceWithRowError.adapter,
    recordsApi: records.recordsApi,
    tokenStore: manualStorage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })
  assert.equal(manualDryRun.status, 'manual_confirm_required')
  await assert.rejects(
    () => applyStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      dryRunToken: manualDryRun.dryRunToken,
      sourceAdapter: sourceWithRowError.adapter,
      recordsApi: records.recordsApi,
      tokenStore: manualStorage,
      permission: 'write',
    }),
    /manual-confirm rows require acceptManualConfirmHold=true/,
  )
}

async function main() {
  await testRegistryListsConfiguredMetadataWithoutTargetSecrets()
  await testDryRunRequiresAllowlistedParametersAndStoresToken()
  await testDryRunUsesPhysicalTargetFieldMapForExistingRowFilter()
  await testBridgeSourceKindRequiresExplicitMatchingReadPlanAndCanDryRun()
  await testTargetFieldMapIncompleteFailsBeforeReads()
  await testApplyRequiresTokenRecomputesAndScopesTarget()
  await testApplyDetectsDataShiftAndManualConfirmHold()

  console.log('stock-preparation-table-actions.test.cjs OK')
}

main().catch((err) => {
  console.error('stock-preparation-table-actions.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
