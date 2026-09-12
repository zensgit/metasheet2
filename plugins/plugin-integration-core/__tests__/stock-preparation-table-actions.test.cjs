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
  assertStockPrepApplySandboxAllowed,
  resolveStockPrepApplySandboxPolicy,
  createStockPreparationTableActionRegistry,
  dryRunStockPreparationAction,
  normalizeStockPreparationActionConfig,
  createTargetScopedRecordsApi,
  __internals: tableActionInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const {
  ROW_ERROR_LIMIT_CEILING,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-bom-expansion.cjs'))
const {
  DECISIONS,
  __internals: plannerInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const {
  saveTableScopeConflictPolicies,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-policies.cjs'))
const {
  normalizeExtFieldMapping,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-ext-field-mapping.cjs'))
const {
  FACTORY_A_REHEARSAL_PACK,
} = require(path.join(__dirname, '..', 'lib', 'customer-packs', 'factory-a.rehearsal.cjs'))

// Read off the REAL committed pack rather than a hand-typed stand-in, so the ext_ write-口 scope
// assertions below cannot quietly disagree with the pack about which ids it declares.
const PACK_EXTENSION_FIELD_IDS = FACTORY_A_REHEARSAL_PACK.extensionFields.map((field) => field.id)
const UNDECLARED_EXT_FIELD_ID = 'ext_notInAnyPackWhatsoever'

const PHYSICAL_FIELD_ID_MAP = Object.fromEntries(
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]),
)

// FOS-4b-3 P0 sandbox gate: apply-logic tests run against the test target objectId 'stockPreparationMain',
// so they must pass an explicit sandbox policy enabling it. (Gate negative controls are tested directly via
// assertStockPrepApplySandboxAllowed below.)
const SANDBOX_POLICY = { enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] }

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

function childBomPlmData(overrides = {}) {
  return basePlmData({
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' },
      { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1' },
    ],
    DN_PDM_BomHeadInfo: [{ part_id: 'PART-A', bom_id: 'BOM-A', SysVer: 'V1', bom_able: true }],
    DN_PDM_BomDetailsInfo: [{ bom_pid: 'BOM-A', part_id: 'PART-B', Bom_ExAttr1: '3' }],
    ...overrides,
  })
}

function duplicateRootPlmData(overrides = {}) {
  return basePlmData({
    DN_PDM_OrderDetailInfo: [
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2', sort_id: '10' },
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '3', sort_id: '20' },
    ],
    ...overrides,
  })
}

function rootPartFingerprint(projectNo = 'P-001', componentSourceId = 'PART-A') {
  return plannerInternals.stableFingerprint(JSON.stringify({
    projectNo,
    componentSourceId,
    parentSourceId: null,
    path: [componentSourceId],
  }))
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

function createRecordsApi({ existing = [], failCreateWith = null } = {}) {
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
        if (failCreateWith) throw failCreateWith
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
  const registry = createStockPreparationTableActionRegistry({
    actions: [baseAction({
      label: 'sheet_stock private action label',
      template: {
        ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
        label: 'sheet_stock private target label',
      },
    })],
  })
  const actions = await registry.listTableActions()
  assert.equal(actions.length, 1)
  assert.equal(actions[0].actionId, PLM_STOCK_PREPARATION_ACTION_ID)
  assert.equal(actions[0].configured, true)
  assert.equal(actions[0].label, 'Apply to target table')
  assert.equal(actions[0].display.genericActionKind, 'apply_to_target_table')
  assert.equal(actions[0].display.commandLabel, 'Apply to target table')
  assert.equal(actions[0].display.commandLabelZh, 'Apply 到目标表')
  assert.equal(actions[0].display.targetLabel, 'configured target table')
  assert.equal(actions[0].display.targetLabelZh, '已配置目标表')
  assert.equal(actions[0].display.presetLabel, 'PLM stock-preparation preset')
  assert.equal(actions[0].display.policyLabel, 'fresh dry-run token + server recompute')
  assert.deepEqual(actions[0].parameters.map((param) => param.id), ['projectNo'])
  assert.equal(actions[0].parameters[0].binding, undefined, 'public parameter metadata hides source binding details')
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
      workspaceId: 'workspace_source',
      kind: 'bridge:legacy-sql-readonly',
    },
  }))

  assert.equal(action.source.kind, 'bridge:legacy-sql-readonly')
  assert.equal(action.source.workspaceId, 'workspace_source', 'source workspace binding is preserved for route lookup')
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
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
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
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
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

  const result = await applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
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
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
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

async function testSavedKeepMultipleRowsPolicyRequiresFreshReviewAndAppliesResolvedRows() {
  const storage = createMemoryStorage()
  const source = createSourceAdapter(duplicateRootPlmData())
  const records = createRecordsApi()
  const action = normalizeStockPreparationActionConfig(baseAction())
  const fingerprint = rootPartFingerprint()

  await saveTableScopeConflictPolicies({
    action,
    policyStore: storage,
    approver: 'admin-user',
    request: {
      conflictType: 'duplicate_expanded_key',
      policies: [{ fingerprint, policy: 'keep_multiple_rows' }],
    },
  })

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    plannedAt: '2026-06-07T09:00:00.000Z',
  })

  assert.equal(dryRun.status, 'ready')
  assert.equal(dryRun.counts.add, 2)
  assert.equal(dryRun.counts.manual_confirm, 0)
  assert.equal(typeof dryRun.dryRunToken, 'string')
  const resolution = dryRun.evidence.plan.duplicateExpandedKeyResolution
  assert.equal(resolution.resolvedGroupCount, 1)
  assert.equal(resolution.resolvedRowCount, 2)
  assert.equal(resolution.tableScopeResolvedGroupCount, 1, 'previously saved table-scope policy is explicitly shown as active')
  assert.equal(resolution.resolvedPolicies[0].discriminator, 'sortLine')
  assert.equal(dryRun.evidence.plan.conflictPolicyReview.writeEffect, 'add_decisions_require_ack')
  assert.equal(dryRun.evidence.plan.conflictPolicyReview.selectedPolicies[0].scope, 'table_scope')
  assert.equal(dryRun.evidence.plan.conflictPolicyReview.selectedPolicies[0].policy, 'keep_multiple_rows')
  assert.equal(dryRun.evidence.plan.conflictPolicyReview.selectedPolicies[0].writeEffect, 'add_decisions_require_ack')
  assert.equal(JSON.stringify(dryRun.evidence).includes('P-001'), false, 'duplicate resolution evidence hides project value')
  assert.equal(JSON.stringify(dryRun.evidence).includes('sort_id'), false, 'duplicate resolution evidence hides source column internals')

  await saveTableScopeConflictPolicies({
    action,
    policyStore: storage,
    approver: 'admin-user',
    request: {
      conflictType: 'duplicate_expanded_key',
      policies: [{ fingerprint, policy: 'hold' }],
    },
  })
  await assert.rejects(
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
      action,
      parameters: { projectNo: 'P-001' },
      dryRunToken: dryRun.dryRunToken,
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      policyStore: storage,
      permission: 'write',
      acceptDuplicateResolution: true,
    }),
    /does not match the current dry-run revision/,
    'saved table-scope policy changes after review invalidate the dry-run token',
  )

  await saveTableScopeConflictPolicies({
    action,
    policyStore: storage,
    approver: 'admin-user',
    request: {
      conflictType: 'duplicate_expanded_key',
      policies: [{ fingerprint, policy: 'keep_multiple_rows' }],
    },
  })
  const unacknowledgedDryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    plannedAt: '2026-06-07T09:00:30.000Z',
  })
  await assert.rejects(
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
      action,
      parameters: { projectNo: 'P-001' },
      dryRunToken: unacknowledgedDryRun.dryRunToken,
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      policyStore: storage,
      permission: 'write',
    }),
    /acceptDuplicateResolution=true/,
    'resolved duplicate groups require explicit apply acknowledgement',
  )

  const reviewedDryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    plannedAt: '2026-06-07T09:01:00.000Z',
  })
  const result = await applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
    action,
    parameters: { projectNo: 'P-001' },
    dryRunToken: reviewedDryRun.dryRunToken,
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    permission: 'write',
    acceptDuplicateResolution: true,
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.apply.counts.created, 2)
  const createCalls = records.calls.filter((call) => call[0] === 'createRecord')
  assert.equal(createCalls.length, 2)
  assert.equal(new Set(createCalls.map((call) => call[1].data.idempotencyKey)).size, 2)
  assert.equal(createCalls.every((call) => String(call[1].data.idempotencyKey).includes('::duplicate:sortLine:')), true)
  assert.equal(JSON.stringify(result.evidence).includes('P-001'), false, 'apply evidence hides project value')
  assert.equal(JSON.stringify(result.evidence).includes('A-001'), false, 'apply evidence hides component code')

  const repullDryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    plannedAt: '2026-06-07T09:02:00.000Z',
  })
  const repullResolution = repullDryRun.evidence.plan.duplicateExpandedKeyResolution
  assert.equal(repullDryRun.status, 'ready')
  assert.equal(repullDryRun.counts.add, 0, 'resolved duplicate rows re-pull by deterministic keys instead of adding again')
  assert.equal(repullDryRun.counts.manual_confirm, 0, 'resolved-key rows are not misclassified as base-key clean-to-collision')
  assert.equal(repullDryRun.counts.skip + repullDryRun.counts.update, 2, 're-pull reaches skip/update, not duplicate add')
  assert.equal(repullResolution.resolvedGroupCount, 1)
  assert.equal(repullResolution.heldReasonCounts.clean_to_collision_requires_review || 0, 0)
}

async function testSavedSourceCorrectionPolicyKeepsDuplicateHeldAndWritesNothing() {
  const storage = createMemoryStorage()
  const source = createSourceAdapter(duplicateRootPlmData())
  const records = createRecordsApi()
  const action = normalizeStockPreparationActionConfig(baseAction())
  const fingerprint = rootPartFingerprint()

  await saveTableScopeConflictPolicies({
    action,
    policyStore: storage,
    approver: 'admin-user',
    request: {
      conflictType: 'duplicate_expanded_key',
      policies: [{ fingerprint, policy: 'source_correction_required' }],
    },
  })

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    plannedAt: '2026-06-08T09:00:00.000Z',
  })

  assert.equal(dryRun.status, 'manual_confirm_required')
  assert.equal(dryRun.counts.add, 0)
  assert.equal(dryRun.counts.update, 0)
  assert.equal(dryRun.counts.skip, 0)
  assert.equal(dryRun.counts.inactive, 0)
  assert.equal(dryRun.counts.manual_confirm, 1)
  assert.equal(typeof dryRun.dryRunToken, 'string')

  const resolution = dryRun.evidence.plan.duplicateExpandedKeyResolution
  assert.equal(resolution.resolvedGroupCount, 0)
  assert.equal(resolution.heldGroupCount, 1)
  assert.equal(resolution.heldRowCount, 2)
  assert.equal(resolution.heldReasonCounts.source_correction_required, 1)
  assert.equal(resolution.heldReasonCounts.unsupported_policy || 0, 0)
  assert.equal(resolution.heldPolicies[0].policy, 'source_correction_required')
  assert.equal(resolution.heldPolicies[0].reason, 'source_correction_required')
  assert.equal(dryRun.evidence.plan.conflictPolicyReview.writeEffect, 'manual_confirm_held')
  assert.equal(dryRun.evidence.plan.conflictPolicyReview.selectedPolicies[0].writeEffect, 'manual_confirm_held')

  const result = await applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
    action,
    parameters: { projectNo: 'P-001' },
    dryRunToken: dryRun.dryRunToken,
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    permission: 'write',
    acceptManualConfirmHold: true,
  })

  assert.equal(result.status, 'held')
  assert.equal(result.apply.counts.created, 0)
  assert.equal(result.apply.counts.updated, 0)
  assert.equal(result.apply.counts.inactive, 0)
  assert.equal(result.apply.counts.held, 1)
  assert.equal(records.calls.some((call) => call[0] === 'createRecord'), false, 'source correction never creates target rows')
  assert.equal(records.calls.some((call) => call[0] === 'patchRecord'), false, 'source correction never patches target rows')

  const text = JSON.stringify({ dryRun: dryRun.evidence, apply: result.evidence })
  for (const sensitive of ['P-001', 'PART-A', 'A-001', 'Assembly', 'sort_id', 'ORDER-1']) {
    assert.equal(text.includes(sensitive), false, `source-correction evidence hides ${sensitive}`)
  }
}

// POLICY HONESTY — the two STORED boundaries, tested at their real call sites.
//
// merge_quantity / select_representative / skip_selected are unimplemented by decision and are
// refused 422 CONFLICT_POLICY_NOT_IMPLEMENTED when a client SELECTS one. Both places where such a
// value can arrive from STORAGE must keep working, or the guard would turn stored artifacts into
// new failures. The two call sites are exercised separately below.

// (a) The table-scope policy store, end-to-end through dry-run AND apply. The record is written
//     straight into storage because today's write path refuses to create one.
async function testStoredUnimplementedTableScopePolicyStillDryRunsAndApplies() {
  for (const policy of ['merge_quantity', 'select_representative', 'skip_selected']) {
    const storage = createMemoryStorage()
    const source = createSourceAdapter(duplicateRootPlmData())
    const records = createRecordsApi()
    const action = normalizeStockPreparationActionConfig(baseAction())
    const fingerprint = rootPartFingerprint()

    // Seed the policy store as an older release would have — never through today's guarded write.
    const { __internals: policyInternals } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-policies.cjs'))
    storage.map.set(policyInternals.conflictPolicyStoreKey(action), {
      version: 1,
      conflictType: 'duplicate_expanded_key',
      actionId: action.actionId,
      targetScopeFingerprint: policyInternals.targetScopeFingerprint(action),
      policies: [{ fingerprint, policy, approvedAt: '2026-06-08T09:00:00.000Z', approvedBy: 'admin-user' }],
    })

    const dryRun = await dryRunStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      policyStore: storage,
      plannedAt: '2026-06-08T09:00:00.000Z',
    })

    // The stored token loads, reaches the planner, and holds under the catch-all reason — exactly
    // the behaviour it had before the selection guard existed.
    assert.equal(dryRun.status, 'manual_confirm_required', `stored ${policy} still plans`)
    const resolution = dryRun.evidence.plan.duplicateExpandedKeyResolution
    assert.equal(resolution.heldReasonCounts.unsupported_policy, 1, `stored ${policy} still holds as unsupported_policy`)
    assert.equal(resolution.heldPolicies[0].policy, policy, 'the held row still names the stored token')
    assert.equal(dryRun.evidence.plan.conflictPolicyReview.selectedPolicies[0].policy, policy)
    assert.equal(typeof dryRun.dryRunToken, 'string')

    // And apply still completes rather than erroring out on the stored value.
    const result = await applyStockPreparationAction({
      sandboxPolicy: SANDBOX_POLICY,
      action,
      parameters: { projectNo: 'P-001' },
      dryRunToken: dryRun.dryRunToken,
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      policyStore: storage,
      permission: 'write',
      acceptManualConfirmHold: true,
    })
    assert.equal(result.status, 'held', `stored ${policy} apply completes and holds`)
    assert.equal(result.apply.counts.held, 1)
    assert.equal(result.apply.counts.created, 0, `stored ${policy} must never create rows`)
    assert.equal(result.apply.counts.updated, 0, `stored ${policy} must never patch rows`)
  }

  // POSITIVE CONTROL: a working policy still resolves through the very same stored path, so the
  // assertions above are not passing merely because every stored policy holds.
  const storage = createMemoryStorage()
  const source = createSourceAdapter(duplicateRootPlmData())
  const records = createRecordsApi()
  const action = normalizeStockPreparationActionConfig(baseAction())
  await saveTableScopeConflictPolicies({
    action,
    policyStore: storage,
    approver: 'admin-user',
    request: {
      conflictType: 'duplicate_expanded_key',
      policies: [{ fingerprint: rootPartFingerprint(), policy: 'keep_multiple_rows' }],
    },
  })
  const resolvedDryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    policyStore: storage,
    plannedAt: '2026-06-08T09:00:00.000Z',
  })
  assert.equal(
    resolvedDryRun.evidence.plan.duplicateExpandedKeyResolution.resolvedGroupCount,
    1,
    'keep_multiple_rows still resolves through the same stored table-scope path',
  )
}

// (b) The SERVER-MINTED dry-run token record, at applyStockPreparationAction's own call site.
//     A token issued before the selection guard landed can still carry an unimplemented policy;
//     re-validating it as a fresh selection would 422 a stored artifact.
//     What this pins: apply's normalization ACCEPTS the stored value and proceeds to the ordinary
//     revision check. (It cannot reach a successful apply, because buildRevision hashes
//     conflictPolicyReview — rewriting the token's review necessarily changes the revision.)
async function testStoredDryRunTokenPolicyIsNotRevalidatedAsASelection() {
  for (const policy of ['merge_quantity', 'select_representative', 'skip_selected']) {
    const storage = createMemoryStorage()
    const source = createSourceAdapter(duplicateRootPlmData())
    const records = createRecordsApi()
    const action = normalizeStockPreparationActionConfig(baseAction())

    // Mint a real token the normal way, with a policy that is selectable today.
    const dryRun = await dryRunStockPreparationAction({
      action,
      parameters: { projectNo: 'P-001' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      policyStore: storage,
      plannedAt: '2026-06-08T09:00:00.000Z',
      conflictPolicyReview: {
        conflictType: 'duplicate_expanded_key',
        scope: 'run_only',
        policies: [{ fingerprint: rootPartFingerprint(), policy: 'hold' }],
      },
    })
    assert.equal(typeof dryRun.dryRunToken, 'string')

    // Rewrite the STORED record to name an unimplemented policy — i.e. a token minted under the
    // older contract. This has to go around the write path, which now refuses to produce one.
    const tokenKey = [...storage.map.keys()].find((key) => key.startsWith('integration:table-action:dry-run-token:'))
    assert.equal(typeof tokenKey, 'string', 'the dry-run token record must be in the store')
    const record = storage.map.get(tokenKey)
    record.conflictPolicyReview = {
      conflictType: 'duplicate_expanded_key',
      scope: 'run_only',
      policies: [{ fingerprint: rootPartFingerprint(), policy }],
    }
    storage.map.set(tokenKey, record)

    let caught
    try {
      await applyStockPreparationAction({
        sandboxPolicy: SANDBOX_POLICY,
        action,
        parameters: { projectNo: 'P-001' },
        dryRunToken: dryRun.dryRunToken,
        sourceAdapter: source.adapter,
        recordsApi: records.recordsApi,
        tokenStore: storage,
        policyStore: storage,
        permission: 'write',
        acceptManualConfirmHold: true,
      })
    } catch (error) {
      caught = error
    }

    // The load-bearing assertion: apply did NOT reject the stored token for naming an
    // unimplemented policy. It got past normalization to the ordinary revision check.
    assert.notEqual(
      caught && caught.code,
      'CONFLICT_POLICY_NOT_IMPLEMENTED',
      `a stored dry-run token naming ${policy} must not be re-validated as a fresh selection`,
    )
    assert.equal(
      caught && caught.code,
      'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH',
      'the stored review is accepted, so apply proceeds to the normal revision check',
    )
    assert.equal(records.calls.some((call) => call[0] === 'createRecord'), false, 'no rows are written')
  }
}

async function testLargeBomBoundedDryRunBlocksApplyToken() {
  const source = createSourceAdapter(childBomPlmData())
  const records = createRecordsApi()
  const storage = createMemoryStorage()

  const dryRun = await dryRunStockPreparationAction({
    action: baseAction({ maxRows: 1 }),
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  assert.equal(dryRun.status, 'large_bom_bounded')
  assert.equal(dryRun.largeBom, true)
  assert.equal(dryRun.canApply, false)
  assert.equal(dryRun.dryRunToken, null, 'bounded large-BOM dry-run must not issue an apply token')
  assert.deepEqual([...storage.map.keys()], [], 'bounded large-BOM dry-run stores no token')
  assert.deepEqual(dryRun.boundedPreview.errorTypes, ['max_rows_exceeded'])
  assert.equal(dryRun.boundedPreview.complete, false)
  assert.equal(dryRun.boundedPreview.authoritative, false)
  assert.equal(dryRun.evidence.expansion.largeBom, true)
  assert.deepEqual(dryRun.evidence.expansion.boundedPreview.errorTypes, ['max_rows_exceeded'])
  assert.equal(JSON.stringify(dryRun.evidence).includes('P-001'), false, 'bounded evidence hides project value')
  assert.equal(JSON.stringify(dryRun.evidence).includes('PART-B'), false, 'bounded evidence hides component source id')
}

// THE INTERACTIVE LANE IS UNTOUCHED BY THE BACKGROUND CAPS. The `largeBom`
// block only supplies numbers to the background full-expansion worker, so a
// dry-run against an action that carries one must be byte-identical to a
// dry-run against the same action without it — same status, same
// `boundedPreview`, and the same `revision`, which is what an apply token is
// bound to. If this ever drifts, adding a background cap would silently
// invalidate every outstanding dry-run token.
async function testLargeBomCapsDoNotMoveTheInteractiveDryRun() {
  async function dryRunWith(actionOverrides) {
    const source = createSourceAdapter(childBomPlmData())
    const records = createRecordsApi()
    return dryRunStockPreparationAction({
      action: baseAction(actionOverrides),
      parameters: { projectNo: 'P-001' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: createMemoryStorage(),
      plannedAt: '2026-06-04T09:00:00.000Z',
    })
  }

  const bounded = await dryRunWith({ maxRows: 1 })
  const boundedWithCaps = await dryRunWith({
    maxRows: 1,
    largeBom: { maxRows: 200000, maxPages: 1000, maxReadCount: 600000, maxElapsedMs: 3600000 },
  })
  assert.equal(bounded.status, 'large_bom_bounded')
  assert.deepEqual(boundedWithCaps, bounded, 'a background cap block does not move the bounded dry-run')

  // And the same on the path that DOES issue a token: everything but the token
  // itself (a fresh random string each call) must match.
  const ready = await dryRunWith({})
  const readyWithCaps = await dryRunWith({ largeBom: { maxRows: 200000 } })
  assert.equal(ready.status, 'ready')
  assert.equal(typeof ready.dryRunToken, 'string')
  const { dryRunToken: _a, ...readyRest } = ready
  const { dryRunToken: _b, ...readyWithCapsRest } = readyWithCaps
  assert.deepEqual(readyWithCapsRest, readyRest, 'a background cap block does not move the ready dry-run')
  assert.equal(readyWithCaps.revision, ready.revision, 'and it does not move the revision an apply token binds')
}

async function testLargeBomBoundedApplyRejectsMatchingTokenBeforeWrites() {
  const records = createRecordsApi()
  const storage = createMemoryStorage()
  const action = baseAction({ maxRows: 1 })
  const parameters = { projectNo: 'P-001' }
  const plannedAt = '2026-06-04T09:00:00.000Z'

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters,
    sourceAdapter: createSourceAdapter(childBomPlmData()).adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt,
  })

  assert.equal(dryRun.status, 'large_bom_bounded')
  assert.equal(dryRun.canApply, false)
  assert.equal(dryRun.dryRunToken, null)

  const forgedMatchingToken = await tableActionInternals.createDryRunToken(storage, {
    actionId: action.actionId,
    parametersHash: tableActionInternals.hashJson(parameters),
    revision: dryRun.revision,
    conflictPolicyReview: null,
  })

  await assert.rejects(
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
      action,
      parameters,
      dryRunToken: forgedMatchingToken,
      sourceAdapter: createSourceAdapter(childBomPlmData()).adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      permission: 'write',
      plannedAt,
    }),
    (error) => {
      assert.equal(error.code, 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE')
      return true
    },
    'bounded large-BOM recompute remains non-applyable even with a matching token',
  )

  const writeCalls = records.calls.filter((call) => call[0] === 'createRecord' || call[0] === 'patchRecord')
  assert.equal(writeCalls.length, 0, 'bounded large-BOM apply rejection must happen before any target write')
  assert.deepEqual([...storage.map.keys()], [], 'token is consumed once even when the recomputed dry-run is not applyable')
}

async function testMissingChildBomDryRunBlocksApplyTokenAndWrites() {
  const records = createRecordsApi()
  const storage = createMemoryStorage()
  const action = baseAction()
  const parameters = { projectNo: 'P-001' }
  const plannedAt = '2026-06-04T09:00:00.000Z'
  const missingChildData = childBomPlmData({ DN_PDM_BomDetailsInfo: [] })

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters,
    sourceAdapter: createSourceAdapter(missingChildData).adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt,
  })

  assert.equal(dryRun.status, 'failed')
  assert.equal(dryRun.largeBom, false)
  assert.equal(dryRun.canApply, false)
  assert.equal(dryRun.dryRunToken, null, 'incomplete assembly must not issue an apply token')
  assert.equal(dryRun.counts.manual_confirm > 0, true, 'row is still visible as a held planning issue')
  assert.equal(dryRun.evidence.expansion.errorTypes.includes('missing_child_bom'), true)
  assert.deepEqual([...storage.map.keys()], [], 'incomplete assembly dry-run stores no token')
  assert.equal(JSON.stringify(dryRun.evidence).includes('P-001'), false, 'incomplete assembly evidence hides project value')
  assert.equal(JSON.stringify(dryRun.evidence).includes('BOM-A'), false, 'incomplete assembly evidence hides BOM ids')

  const forgedMatchingToken = await tableActionInternals.createDryRunToken(storage, {
    actionId: action.actionId,
    parametersHash: tableActionInternals.hashJson(parameters),
    revision: dryRun.revision,
    conflictPolicyReview: null,
  })

  await assert.rejects(
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
      action,
      parameters,
      dryRunToken: forgedMatchingToken,
      sourceAdapter: createSourceAdapter(missingChildData).adapter,
      recordsApi: records.recordsApi,
      tokenStore: storage,
      permission: 'write',
      plannedAt,
      acceptManualConfirmHold: true,
    }),
    (error) => {
      assert.equal(error.code, 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE')
      return true
    },
    'incomplete assembly remains non-applyable even when manual-confirm hold is accepted',
  )

  const writeCalls = records.calls.filter((call) => call[0] === 'createRecord' || call[0] === 'patchRecord')
  assert.equal(writeCalls.length, 0, 'incomplete assembly apply rejection must happen before any target write')
}

async function testReadPageLimitBoundedDryRunAndDepthHardFailureStayDistinct() {
  const records = createRecordsApi()

  {
    const source = createSourceAdapter(basePlmData({
      DN_PDM_PathExAttrInfo: [
        { FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' },
        { FileCode: 'P-001', Parent_OBJ_ID: 'PATH-2' },
      ],
    }))
    const dryRun = await dryRunStockPreparationAction({
      action: baseAction({ pageLimit: 1, maxPages: 1 }),
      parameters: { projectNo: 'P-001' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: createMemoryStorage(),
      plannedAt: '2026-06-04T09:00:00.000Z',
    })

    assert.equal(dryRun.status, 'large_bom_bounded')
    assert.equal(dryRun.largeBom, true)
    assert.equal(dryRun.canApply, false)
    assert.equal(dryRun.dryRunToken, null)
    assert.deepEqual(dryRun.boundedPreview.errorTypes, ['read_page_limit_exceeded'])
    assert.equal(dryRun.boundedPreview.maxPages, 1)
  }

  {
    const source = createSourceAdapter(childBomPlmData())
    const dryRun = await dryRunStockPreparationAction({
      action: baseAction({ maxDepth: 0 }),
      parameters: { projectNo: 'P-001' },
      sourceAdapter: source.adapter,
      recordsApi: records.recordsApi,
      tokenStore: createMemoryStorage(),
      plannedAt: '2026-06-04T09:00:00.000Z',
    })

    assert.equal(dryRun.status, 'failed')
    assert.equal(dryRun.largeBom, false)
    assert.equal(dryRun.canApply, false)
    assert.equal(dryRun.dryRunToken, null)
    assert.equal(dryRun.evidence.expansion.errorTypes.includes('max_depth_exceeded'), true)
  }
}

async function testApplyNormalizesNumericPlmDisplayFieldsBeforeCreate() {
  const storage = createMemoryStorage()
  const source = createSourceAdapter(basePlmData({
    DN_PDM_PartLibraryInfo: [{
      OBJ_ID: 'PART-A',
      IdentityNo: 1001,
      IdentityName: 2002,
      Material: 3003,
      SysVer: 7,
    }],
  }))
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

  const result = await applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
    action,
    parameters: { projectNo: 'P-001' },
    dryRunToken: dryRun.dryRunToken,
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    permission: 'admin',
  })

  assert.equal(result.status, 'succeeded')
  const createCall = records.calls.find((call) => call[0] === 'createRecord')
  assert.equal(createCall[1].data.componentCode, '1001')
  assert.equal(createCall[1].data.componentName, '2002')
  assert.equal(createCall[1].data.material, '3003')
  assert.equal(createCall[1].data.sourceVersion, '7')
  assert.equal(typeof createCall[1].data.rawQuantity, 'number')
  assert.equal(typeof createCall[1].data.totalQuantity, 'number')
  assert.equal(createCall[1].data.active, true)
  assert.equal(JSON.stringify(result.evidence).includes('1001'), false, 'apply evidence hides component code value')

  const followUp = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T10:00:00.000Z',
  })

  assert.equal(followUp.status, 'ready', 'post-create dry-run should not require manual confirmation for type-only drift')
  assert.equal(followUp.counts.add, 0, 'post-create dry-run must not duplicate-add')
  assert.equal(followUp.counts.manual_confirm, 0, 'type-normalized existing rows must not be held')
  assert.equal(followUp.counts.skip, 1, 'unchanged post-create row skips cleanly')
}

async function testApplySurfacesTypedValuesFreeRowFailureDiagnostics() {
  const storage = createMemoryStorage()
  const source = createSourceAdapter()
  const records = createRecordsApi({
    failCreateWith: new Error('Invalid select option for fld_material_type: P-001 PART-A secret-label'),
  })
  const action = baseAction()

  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-06-04T09:00:00.000Z',
  })

  const result = await applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
    action,
    parameters: { projectNo: 'P-001' },
    dryRunToken: dryRun.dryRunToken,
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    permission: 'admin',
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.apply.counts.failed, 1)
  assert.deepEqual(result.apply.errorCodes, ['select_option_not_found'])
  assert.deepEqual(result.apply.errorSummaries, [{
    code: 'select_option_not_found',
    count: 1,
    decisions: [DECISIONS.ADD],
    operations: ['createRecord'],
  }])
  assert.equal(JSON.stringify(result.evidence).includes('P-001'), false, 'apply evidence hides project value')
  assert.equal(JSON.stringify(result.evidence).includes('PART-A'), false, 'apply evidence hides component value')
  assert.equal(JSON.stringify(result.evidence).includes('secret-label'), false, 'apply evidence hides option labels')
  assert.equal(JSON.stringify(result.evidence).includes('Invalid select option'), false, 'apply evidence hides raw error message')
  assert.equal(JSON.stringify(result.apply).includes('"Error"'), false, 'plain Error is not the response diagnostic')
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
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
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
    () => applyStockPreparationAction({ sandboxPolicy: SANDBOX_POLICY,
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

// W8-4 (L1): the target fence builds a FRESH api object, so anything the host offers that is not
// explicitly forwarded is invisible to every caller behind it. `withMetadataCache` carries no
// sheetId and reads no row, so it is forwarded verbatim — and a host that does not offer it must
// leave the scoped api without it rather than fabricating a stub.
async function testTargetScopedApiForwardsTheHostMetadataCacheCapability() {
  const seen = []
  const hostApi = {
    queryRecords: async () => [],
    createRecord: async () => ({ id: 'rec_1' }),
    patchRecord: async () => ({ id: 'rec_1' }),
    withMetadataCache: async (operation) => {
      seen.push('scope')
      return operation()
    },
  }
  const scoped = await createTargetScopedRecordsApi(hostApi, { sheetId: 'sheet_main' }, { fieldIdTranslation: 'pre_mapped' })
  assert.equal(typeof scoped.withMetadataCache, 'function', 'the memo capability survives the target fence')
  assert.equal(await scoped.withMetadataCache(async () => 'inner'), 'inner', 'the operation result passes through')
  assert.deepEqual(seen, ['scope'], 'the host capability, not a local stub, did the work')

  // Read-only callers get it too: their queryRecords hits the same constant metadata reads.
  const readOnly = await createTargetScopedRecordsApi(hostApi, { sheetId: 'sheet_main' }, { fieldIdTranslation: 'pre_mapped', readOnly: true })
  assert.equal(typeof readOnly.withMetadataCache, 'function', 'read-only scoped api also carries the memo')

  const { withMetadataCache, ...hostWithout } = hostApi
  const withoutCapability = await createTargetScopedRecordsApi(hostWithout, { sheetId: 'sheet_main' }, { fieldIdTranslation: 'pre_mapped' })
  assert.equal('withMetadataCache' in withoutCapability, false, 'never fabricated when the host lacks it')
}

// W9: the same fence, the same rule, for the array-filter DECLARATION. It is data, not a method,
// so an unforwarded declaration silently turns the batch key lookup off forever; an INVENTED one
// sends a list to a host that rejects it. Both spellings of `not declared` (absent, and an
// explicit false) must leave the scoped api without it.
async function testTargetScopedApiForwardsTheHostFilterValueListDeclaration() {
  const hostApi = {
    supportsFilterValueLists: true,
    queryRecords: async () => [],
    createRecord: async () => ({ id: 'rec_1' }),
    patchRecord: async () => ({ id: 'rec_1' }),
  }
  const scoped = await createTargetScopedRecordsApi(hostApi, { sheetId: 'sheet_main' }, { fieldIdTranslation: 'pre_mapped' })
  assert.equal(scoped.supportsFilterValueLists, true, 'the declaration survives the target fence')

  // Also in `logical` mode: `toPhysicalKeys` rewrites filter KEYS and never touches values, so a
  // list value crosses the fence unchanged.
  const logical = await createTargetScopedRecordsApi(
    hostApi,
    { sheetId: 'sheet_main', objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId },
    { resolvedFieldIds: Object.fromEntries(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`])) },
  )
  assert.equal(logical.supportsFilterValueLists, true, 'forwarded in logical translation mode too')
  await logical.queryRecords({ filters: { idempotencyKey: ['k1', 'k2'] } })

  const readOnly = await createTargetScopedRecordsApi(hostApi, { sheetId: 'sheet_main' }, { fieldIdTranslation: 'pre_mapped', readOnly: true })
  assert.equal(readOnly.supportsFilterValueLists, true, 'read-only scoped api carries it as well')

  const { supportsFilterValueLists, ...hostWithout } = hostApi
  const absent = await createTargetScopedRecordsApi(hostWithout, { sheetId: 'sheet_main' }, { fieldIdTranslation: 'pre_mapped' })
  assert.equal('supportsFilterValueLists' in absent, false, 'never fabricated when the host is silent')

  const denying = await createTargetScopedRecordsApi({ ...hostWithout, supportsFilterValueLists: false }, { sheetId: 'sheet_main' }, { fieldIdTranslation: 'pre_mapped' })
  assert.equal('supportsFilterValueLists' in denying, false, 'an explicit false is not forwarded as true')
}

async function main() {
  await testRegistryListsConfiguredMetadataWithoutTargetSecrets()
  await testDryRunRequiresAllowlistedParametersAndStoresToken()
  await testDryRunUsesPhysicalTargetFieldMapForExistingRowFilter()
  await testBridgeSourceKindRequiresExplicitMatchingReadPlanAndCanDryRun()
  await testTargetFieldMapIncompleteFailsBeforeReads()
  await testApplyRequiresTokenRecomputesAndScopesTarget()
  await testSavedKeepMultipleRowsPolicyRequiresFreshReviewAndAppliesResolvedRows()
  await testSavedSourceCorrectionPolicyKeepsDuplicateHeldAndWritesNothing()
  await testStoredUnimplementedTableScopePolicyStillDryRunsAndApplies()
  await testStoredDryRunTokenPolicyIsNotRevalidatedAsASelection()
  await testLargeBomBoundedDryRunBlocksApplyToken()
  await testLargeBomCapsDoNotMoveTheInteractiveDryRun()
  await testLargeBomBoundedApplyRejectsMatchingTokenBeforeWrites()
  await testMissingChildBomDryRunBlocksApplyTokenAndWrites()
  await testReadPageLimitBoundedDryRunAndDepthHardFailureStayDistinct()
  await testApplyNormalizesNumericPlmDisplayFieldsBeforeCreate()
  await testApplySurfacesTypedValuesFreeRowFailureDiagnostics()
  await testApplyDetectsDataShiftAndManualConfirmHold()
  await testApplySandboxGateFailsClosed()
  await testTargetScopedApiForwardsTheHostMetadataCacheCapability()
  await testTargetScopedApiForwardsTheHostFilterValueListDeclaration()
  testRevisionCarriesTheRowErrorOverflowFacts()
  testHardApplyBlockingRowErrorsSurviveTheCap()
  testRowErrorLimitIsAConditionalActionConfigKey()
  testExtensionFieldIdsEnforceNamespaceShapeAndPackMembershipIsOneLayerOut()
  await testRootSelectionIsReachableFromTheActionConfig()
  await testCollapsedSiblingCountReachesDryRunEvidence()
  await testParentPackColumnsReachTheInteractiveChain()

  console.log('stock-preparation-table-actions.test.cjs OK')
}

// ---------------------------------------------------------------------------------------------
// D-C: `rowErrors` is a BOUNDED SAMPLE now, so the revision and the apply gate must both stop
// treating "what is in the array" as "what happened".
// ---------------------------------------------------------------------------------------------
const ROW_ERROR_REVISION_ACTION = Object.freeze({
  actionId: PLM_STOCK_PREPARATION_ACTION_ID,
  source: { externalSystemId: 'ext_plm', workspaceId: null, readPlan: null },
  target: { sheetId: 'sheet_main', objectId: 'stockPreparationMain', fieldIdMap: {} },
})

function expansionWithRowErrors(retained, truncation) {
  const summary = { status: 'failed', errorTypes: ['missing_component_source_id'] }
  if (truncation) Object.assign(summary, truncation)
  return {
    status: 'failed',
    rows: [],
    errors: [],
    rowErrors: Array.from({ length: retained }, () => ({ type: 'missing_component_source_id', field: 'part_id', depth: 1 })),
    summary,
  }
}

function revisionFor(expansion) {
  return tableActionInternals.buildRevision({
    action: ROW_ERROR_REVISION_ACTION,
    parameters: { projectNo: 'P-001' },
    expansion,
    existingRows: [],
    conflictPolicyReview: null,
    plan: null,
  })
}

function testRevisionCarriesTheRowErrorOverflowFacts() {
  // UNDER THE CAP the projection reads NOTHING from the summary — stated by hashing the same
  // expansion with its summary deleted outright. Equal hashes means the revision is blind to
  // everything the summary carries until an overflow actually happens, which is the byte-identity
  // promise every stored revision and every pending hold depends on.
  const underCap = expansionWithRowErrors(3, null)
  const summaryless = clone(underCap)
  delete summaryless.summary
  assert.equal(
    revisionFor(underCap),
    revisionFor(summaryless),
    'the revision reads nothing from the summary until an overflow happens',
  )

  // …and the stronger half: the under-cap hash equals the PRE-D-C projection written out by hand
  // through the same hasher. Any key added unconditionally to `buildRevision`'s expansion stanza —
  // even one whose value is `undefined`, which stableStringify emits — turns this red, which is the
  // only assertion that keeps "no stored revision moves, no pending hold is superseded" honest.
  assert.equal(
    revisionFor(underCap),
    tableActionInternals.hashJson({
      actionId: ROW_ERROR_REVISION_ACTION.actionId,
      parameters: { projectNo: 'P-001' },
      source: {
        externalSystemId: ROW_ERROR_REVISION_ACTION.source.externalSystemId,
        workspaceId: ROW_ERROR_REVISION_ACTION.source.workspaceId,
        readPlan: ROW_ERROR_REVISION_ACTION.source.readPlan,
      },
      target: ROW_ERROR_REVISION_ACTION.target,
      expansion: {
        status: underCap.status,
        rows: underCap.rows,
        errors: underCap.errors,
        rowErrors: underCap.rowErrors,
      },
      existingRows: [],
      conflictPolicyReview: null,
      plan: null,
    }),
    'an expansion that lost nothing hashes exactly as it did before the cap existed',
  )

  // OVER THE CAP the facts are in the hash — and they have to be, because the retained sample is
  // byte-identical between these two and only the totals differ.
  const smaller = expansionWithRowErrors(5000, {
    rowErrorsTotal: 5001,
    rowErrorsRetained: 5000,
    rowErrorsTruncated: true,
    rowErrorTypeCounts: { missing_component_source_id: 5001 },
  })
  const bigger = expansionWithRowErrors(5000, {
    rowErrorsTotal: 90210,
    rowErrorsRetained: 5000,
    rowErrorsTruncated: true,
    rowErrorTypeCounts: { missing_component_source_id: 90210 },
  })
  assert.deepEqual(smaller.rowErrors, bigger.rowErrors, 'the two samples are indistinguishable…')
  assert.notEqual(revisionFor(smaller), revisionFor(bigger), '…so only the overflow facts can separate their revisions')
  assert.notEqual(revisionFor(smaller), revisionFor(expansionWithRowErrors(5000, null)),
    'and a truncated expansion never collides with an untruncated one carrying the same array')

  // The per-type counts are hashed too: same total, different composition, different revision —
  // otherwise "5001 missing parts" and "5001 unparseable quantities" would share a dry-run token.
  const otherTypes = clone(smaller)
  otherTypes.summary.rowErrorTypeCounts = { invalid_quantity: 5001 }
  assert.notEqual(revisionFor(smaller), revisionFor(otherTypes), 'the per-type composition is hashed as well')

  // …AND EACH OF THE THREE KEYS IS PINNED INDIVIDUALLY, by the same hand-written-projection method
  // the under-cap half uses. The pairwise tests above cannot do this: today every rowError carries a
  // `type`, so `rowErrorsTotal === Σ rowErrorTypeCounts` and the three keys are mutually redundant —
  // deleting `rowErrorsTotal` or `rowErrorsTruncated` from the projection left both suites green.
  // The day someone adds a rowError with no type, total and typeCounts decouple, and this is the
  // assertion that will be standing there.
  const truncatedProjection = {
    actionId: ROW_ERROR_REVISION_ACTION.actionId,
    parameters: { projectNo: 'P-001' },
    source: {
      externalSystemId: ROW_ERROR_REVISION_ACTION.source.externalSystemId,
      workspaceId: ROW_ERROR_REVISION_ACTION.source.workspaceId,
      readPlan: ROW_ERROR_REVISION_ACTION.source.readPlan,
    },
    target: ROW_ERROR_REVISION_ACTION.target,
    expansion: {
      status: smaller.status,
      rows: smaller.rows,
      errors: smaller.errors,
      rowErrors: smaller.rowErrors,
      rowErrorsTruncated: true,
      rowErrorsTotal: 5001,
      rowErrorTypeCounts: { missing_component_source_id: 5001 },
    },
    existingRows: [],
    conflictPolicyReview: null,
    plan: null,
  }
  assert.equal(
    revisionFor(smaller),
    tableActionInternals.hashJson(truncatedProjection),
    'a truncated expansion hashes EXACTLY these three overflow keys and no fourth',
  )
  for (const key of ['rowErrorsTruncated', 'rowErrorsTotal', 'rowErrorTypeCounts']) {
    const without = clone(truncatedProjection)
    delete without.expansion[key]
    assert.notEqual(
      revisionFor(smaller),
      tableActionInternals.hashJson(without),
      `${key} is load-bearing in the revision — dropping it must move the hash`,
    )
  }
}

// FAIL-CLOSED. The hard apply-blocking check used to read the array; past the cap the array can
// contain none of the blocking type while the project is full of it.
function testHardApplyBlockingRowErrorsSurviveTheCap() {
  const { hasHardApplyBlockingRowErrors } = tableActionInternals
  assert.equal(hasHardApplyBlockingRowErrors({ rowErrors: [] }), false, 'a clean expansion blocks nothing')
  assert.equal(
    hasHardApplyBlockingRowErrors({ rowErrors: [{ type: 'missing_child_bom' }] }),
    true,
    'the array is still authority when nothing was dropped',
  )
  assert.equal(
    hasHardApplyBlockingRowErrors({
      rowErrors: [{ type: 'missing_component_source_id' }],
      summary: {
        rowErrorsTruncated: true,
        rowErrorsTotal: 5001,
        rowErrorTypeCounts: { missing_component_source_id: 5000, missing_child_bom: 1 },
      },
    }),
    true,
    'a missing_child_bom the cap dropped still blocks apply — the totals are consulted first',
  )
  assert.equal(
    hasHardApplyBlockingRowErrors({
      rowErrors: [{ type: 'missing_component_source_id' }],
      summary: {
        rowErrorsTruncated: true,
        rowErrorsTotal: 5001,
        rowErrorTypeCounts: { missing_component_source_id: 5001 },
      },
    }),
    false,
    '…and a truncated expansion with no blocking type does not become blocked by the truncation itself',
  )
}

// The cap override is deploy config, and CONDITIONAL: an action that never asked for it keeps the
// exact normalized shape it had, because that shape is snapshotted and hashed elsewhere.
function testRowErrorLimitIsAConditionalActionConfigKey() {
  const base = {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'ext_plm', kind: 'bridge:legacy-sql-readonly' },
    target: { sheetId: 'sheet_main', objectId: 'stockPreparationMain', fieldIdMap: {} },
  }
  const plain = normalizeStockPreparationActionConfig(clone(base))
  assert.equal('rowErrorLimit' in plain, false, 'a config that never set it gains no key')

  const configured = normalizeStockPreparationActionConfig({ ...clone(base), rowErrorLimit: 250 })
  assert.equal(configured.rowErrorLimit, 250, 'a configured cap is carried on the normalized action')
  assert.throws(
    () => normalizeStockPreparationActionConfig({ ...clone(base), rowErrorLimit: -1 }),
    (error) => error instanceof StockPreparationTableActionError && error.code === 'TABLE_ACTION_CONFIG_INVALID',
    'a nonsense cap is refused at config time, not silently defaulted',
  )

  // THE CEILING IS ENFORCED AT CONFIG TIME TOO, and as a REFUSAL. The normalized config is what gets
  // snapshotted and echoed back, so storing 20001 while the expander runs 20000 would make the stored
  // config a lie about what ran — and the operator would get no feedback at all about a knob they
  // demonstrably meant to move.
  const atCeiling = normalizeStockPreparationActionConfig({ ...clone(base), rowErrorLimit: ROW_ERROR_LIMIT_CEILING })
  assert.equal(atCeiling.rowErrorLimit, ROW_ERROR_LIMIT_CEILING, 'the ceiling itself is a legal cap')
  assert.throws(
    () => normalizeStockPreparationActionConfig({ ...clone(base), rowErrorLimit: ROW_ERROR_LIMIT_CEILING + 1 }),
    (error) => error instanceof StockPreparationTableActionError
      && error.code === 'TABLE_ACTION_CONFIG_INVALID'
      && /must not exceed/.test(error.message),
    'one past the ceiling is a 422, not a silent clamp',
  )

  // TYPE STRICTNESS. `Number()` reads `true` as 1, so a coercing parser would answer a config typo by
  // cutting the operator's whole defect worklist down to one entry while every total stayed truthful.
  for (const nonsense of [true, [3], '7', 5.5]) {
    assert.throws(
      () => normalizeStockPreparationActionConfig({ ...clone(base), rowErrorLimit: nonsense }),
      (error) => error instanceof StockPreparationTableActionError && error.code === 'TABLE_ACTION_CONFIG_INVALID',
      `rowErrorLimit: ${JSON.stringify(nonsense)} is refused rather than coerced`,
    )
  }
}

// ext_ 客户包列写口守卫盘点结清 (beiliao-takeover-status-ledger.md §4, 2026-09-11 全集盘点 ⑥/⑦).
// The write-口 THIS test owns is ⑥: `extensionFieldIds` on the table-action config -- the durable list
// the confirm/apply writer reads to decide which `ext_` columns a write may touch
// (lib/stock-preparation-table-actions.cjs:233 normalizeActionExtensionFieldIds -> :246
// assertExtensionFieldIdValid, reached from :449 normalizeStockPreparationActionConfig, which the
// registry constructor :693 and assertStockPreparationTargetReady :589 both go through).
//
// SCOPE, stated exactly so this test is not read as more than it is: that predicate
// (lib/stock-preparation-extension-namespace.cjs:117-165) checks NAMESPACE SHAPE ONLY -- prefix,
// suffix shape, forbidden content keys, collision with a frozen template field. It has no pack
// catalog and therefore CANNOT refuse "an id no customer pack declared"; the third case below pins
// that boundary as an ACCEPT so nobody re-reads this suite as "non-pack ids are rejected here".
// Pack MEMBERSHIP lives one layer out and is pinned by the last two cases: the mapper's pack
// catalog (lib/stock-preparation-ext-field-mapping.cjs:386/:394 -> :315-317 TARGET_NOT_DECLARED_IN_PACK,
// whose own battery is __tests__/stock-preparation-ext-field-mapping.test.cjs:232) and this module's
// agreement gate (:564 assertExtFieldMappingAgreesWithAction -> :575), which refuses a mapping aimed
// at an `ext_` column the action config never declared -- even one the pack DID declare.
function testExtensionFieldIdsEnforceNamespaceShapeAndPackMembershipIsOneLayerOut() {
  // (1) guard existence: an id with no `ext_` prefix at all cannot enter extensionFieldIds.
  assert.throws(
    () => normalizeStockPreparationActionConfig(baseAction({ extensionFieldIds: ['procurementDone'] })),
    (error) => error instanceof StockPreparationTableActionError
      && error.code === 'TABLE_ACTION_CONFIG_INVALID'
      && error.details && error.details.namespaceReason === 'FIELD_ID_PREFIX_MISSING',
    'a bare non-`ext_` id cannot enter extensionFieldIds -- code/reason must stay stable',
  )

  // (2) a second, independent refusal shape: `ext_` prefix present, but the suffix collides with a
  // frozen template field -- the shape stock-preparation-customer-pack.cjs:312 also rejects at
  // pack-declaration time. Locking it HERE proves this write-口 does not simply trust `ext_*`.
  assert.throws(
    () => normalizeStockPreparationActionConfig(baseAction({ extensionFieldIds: ['ext_projectNo'] })),
    (error) => error instanceof StockPreparationTableActionError
      && error.code === 'TABLE_ACTION_CONFIG_INVALID'
      && error.details && error.details.namespaceReason === 'FIELD_ID_TEMPLATE_COLLISION',
    'an `ext_` id colliding with a frozen template field is refused -- code/reason must stay stable',
  )

  // (3) positive control: a real customer-pack `ext_` id (FACTORY_A_REHEARSAL_PACK declares
  // `ext_stockPrepDate`) is admitted unchanged -- the guard does not block the feature it exists for.
  const action = normalizeStockPreparationActionConfig(baseAction({ extensionFieldIds: ['ext_stockPrepDate'] }))
  assert.deepEqual(action.extensionFieldIds, ['ext_stockPrepDate'], 'a legitimate customer-pack ext_ id is admitted unchanged')

  // (4) THE BOUNDARY, pinned as an accept: a shape-valid id that NO pack declares also passes here.
  // This is not a hole being blessed -- it is the scope line. If someone later teaches this guard
  // pack membership, this assertion goes red and they must update the ledger inventory with it.
  const undeclaredId = PACK_EXTENSION_FIELD_IDS.includes(UNDECLARED_EXT_FIELD_ID)
    ? null
    : UNDECLARED_EXT_FIELD_ID
  assert.ok(undeclaredId, 'fixture must name an ext_ id the rehearsal pack does not declare')
  const shapeOnly = normalizeStockPreparationActionConfig(baseAction({ extensionFieldIds: [undeclaredId] }))
  assert.deepEqual(
    shapeOnly.extensionFieldIds,
    [undeclaredId],
    'namespace guard is shape-only: pack membership is NOT checked at this write-口',
  )

  // (5) where an id no pack declared is actually refused: the mapper's pack catalog.
  assert.throws(
    () => normalizeExtFieldMapping(
      { mappingId: 'closeout-probe', mappingVersion: 1, mappings: [{ sourceColumn: 'A', target: undeclaredId }] },
      { pack: FACTORY_A_REHEARSAL_PACK },
    ),
    (error) => error.reason === 'TARGET_NOT_DECLARED_IN_PACK',
    'an ext_ id no customer pack declared is refused by the mapper pack catalog -- reason must stay stable',
  )

  // (6) and the second half of that wall: even a pack-DECLARED column cannot be written unless this
  // action config declared it too (:564 -> :575).
  const mappingToUndeclaredByAction = normalizeExtFieldMapping(
    { mappingId: 'closeout-probe', mappingVersion: 1, mappings: [{ sourceColumn: 'A', target: 'ext_spec' }] },
    { pack: FACTORY_A_REHEARSAL_PACK },
  )
  assert.throws(
    () => tableActionInternals.assertExtFieldMappingAgreesWithAction(action, mappingToUndeclaredByAction),
    (error) => error instanceof StockPreparationTableActionError
      && error.code === 'TARGET_SCHEMA_INCOMPLETE'
      && Array.isArray(error.details.undeclaredExtensionFields)
      && error.details.undeclaredExtensionFields.includes('ext_spec'),
    'a mapping may not write an ext_ column the action config never declared -- code must stay stable',
  )
}

async function testApplySandboxGateFailsClosed() {
  // FOS-4b-3 P0 gate (assertStockPrepApplySandboxAllowed): fail-closed by default + canonical defense-in-depth.
  const prodTarget = { sheetId: 'sheet_prod', objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId }
  const sandboxTarget = { sheetId: 'sheet_sandbox', objectId: 'sandbox_stock_prep' }
  const isGate = (e) => e instanceof StockPreparationTableActionError && e.status === 403 && e.code === 'STOCK_PREP_APPLY_SANDBOX_ONLY'

  // (1) no policy → reject (fail-closed default)
  assert.throws(() => assertStockPrepApplySandboxAllowed(sandboxTarget, undefined), isGate,
    'apply with no sandbox policy must fail-closed')
  // (2) policy disabled → reject
  assert.throws(() => assertStockPrepApplySandboxAllowed(sandboxTarget, { enabled: false, allowedTargetObjectIds: ['sandbox_stock_prep'] }), isGate,
    'apply with sandbox disabled must fail-closed')
  // (3) target not in allowlist → reject
  assert.throws(() => assertStockPrepApplySandboxAllowed(sandboxTarget, { enabled: true, allowedTargetObjectIds: ['other'] }), isGate,
    'apply to a non-allowlisted target must fail-closed')
  // (4) prod canonical → reject EVEN IF allowlisted (defense-in-depth)
  assert.throws(
    () => assertStockPrepApplySandboxAllowed(prodTarget, { enabled: true, allowedTargetObjectIds: [STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId] }),
    (e) => isGate(e) && e.details.reason === 'prod_canonical',
    'apply to the prod canonical must fail-closed even if allowlisted')
  // (5) sandbox enabled + allowlisted + not canonical → passes
  assert.doesNotThrow(
    () => assertStockPrepApplySandboxAllowed(sandboxTarget, { enabled: true, allowedTargetObjectIds: ['sandbox_stock_prep'] }),
    'sandbox-enabled allowlisted non-canonical target must pass')
  // (6) values-free: gate error details carry only a coarse reason, never the sheetId/objectId
  try {
    assertStockPrepApplySandboxAllowed(sandboxTarget, undefined)
    assert.fail('expected gate to throw')
  } catch (e) {
    if (!isGate(e)) throw e
    const text = JSON.stringify(e.details || {})
    assert.equal(text.includes('sheet_sandbox'), false, 'gate error must not expose sheetId')
    assert.equal(text.includes('sandbox_stock_prep'), false, 'gate error must not expose objectId')
  }

  // resolveStockPrepApplySandboxPolicy: explicit config wins; env gate; fail-closed default.
  const explicit = { enabled: true, allowedTargetObjectIds: ['x'] }
  assert.deepEqual(resolveStockPrepApplySandboxPolicy({ stockPrepApplySandbox: explicit }, {}), explicit,
    'explicit server config wins')
  assert.equal(resolveStockPrepApplySandboxPolicy({}, {}), undefined,
    'no config + no env → undefined (fail-closed)')
  assert.equal(resolveStockPrepApplySandboxPolicy({}, { STOCK_PREP_SANDBOX_MODE: 'false' }), undefined,
    'mode!==true → undefined (fail-closed)')
  assert.deepEqual(
    resolveStockPrepApplySandboxPolicy({}, { STOCK_PREP_SANDBOX_MODE: 'true', STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS: 'sandbox_a, sandbox_b' }),
    { enabled: true, allowedTargetObjectIds: ['sandbox_a', 'sandbox_b'] },
    'env gate resolves enabled + comma allowlist (trimmed)')
  // end-to-end: env-resolved policy admits an allowlisted target, still rejects the prod canonical.
  const envPolicy = resolveStockPrepApplySandboxPolicy({}, { STOCK_PREP_SANDBOX_MODE: 'true', STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS: 'sandbox_stock_prep' })
  assert.doesNotThrow(() => assertStockPrepApplySandboxAllowed(sandboxTarget, envPolicy), 'env policy admits allowlisted sandbox target')
  assert.throws(() => assertStockPrepApplySandboxAllowed(prodTarget, envPolicy), isGate, 'env policy still rejects prod canonical')
}

// ---------------------------------------------------------------------------------------------
// F1c — 根选择规则是 DEPLOY CONFIG,而且必须**真的接到线上**。
//
// 这条守的是「开关没接线」那一类漏法:`expandPlmProjectBom` 认 `rootSelection`,但交互式 dry-run
// 的入参是一张显式白名单(computeDryRun 里逐键列举),白名单里没有这个键,配置写了也到不了展开器。
// 所以这里不直接调纯函数,而是从 **动作配置** 出发走完整条 dry-run —— 证明的是「部署改得动」,
// 不是「纯函数算得对」(后者由 bom-expansion 那支测试钉住)。
//
// 顺带钉住同一条链上的证据:dry-run 证据里要能看见 `rootsFilteredOut`,否则操作员在 dry-run 里
// 只看到一个变小的行数,分不清「PLM 少了件」和「我们按老系统剔了根」。
// ---------------------------------------------------------------------------------------------
function rootSelectionPlmData() {
  return basePlmData({
    DN_PDM_OrderDetailInfo: [
      { order_id: 'ORDER-1', part_id: 'PART-MAIN', quantity: '1' },
      { order_id: 'ORDER-1', part_id: 'PART-OTHER', quantity: '1' },
    ],
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'PART-MAIN', IdentityNo: 'J100-00', IdentityName: '总图', Material: 'Steel', SysVer: 'V2' },
      { OBJ_ID: 'PART-OTHER', IdentityNo: 'B-001', IdentityName: '别的件', Material: 'Steel', SysVer: 'V1' },
    ],
  })
}

async function dryRunWithRootSelection(rootSelection) {
  const source = createSourceAdapter(rootSelectionPlmData())
  const records = createRecordsApi()
  const storage = createMemoryStorage()
  const action = normalizeStockPreparationActionConfig(baseAction(
    rootSelection === undefined ? {} : { rootSelection },
  ))
  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    plannedAt: '2026-09-11T09:00:00.000Z',
  })
  return { action, dryRun }
}

async function testRootSelectionIsReachableFromTheActionConfig() {
  // 默认(配置里一个字都没写)= 老系统规则,owner 裁决的那一条:有总图就只要总图。
  const byDefault = await dryRunWithRootSelection(undefined)
  assert.equal('rootSelection' in byDefault.action, false, '没配过的动作不长出这个键(快照/哈希不动)')
  assert.equal(byDefault.dryRun.counts.add, 1, '默认按老系统:只有 J…-00 总图当根,另一条订单行被剔除')
  assert.equal(
    byDefault.dryRun.evidence.expansion.rootsFilteredOut,
    1,
    '被剔掉的根数进 dry-run 证据 —— 行数变少有据可查,不是静默丢行',
  )

  // 关掉 = 回到 F1c 之前的行为。没有这条接线,任何部署都回不去。
  const disabled = await dryRunWithRootSelection({ enabled: false })
  assert.equal(disabled.action.rootSelection.enabled, false, '配置被归一化后留在动作上')
  assert.equal(disabled.dryRun.counts.add, 2, '关掉规则 => 订单行全部当根,与改前同量')
  assert.equal(
    'rootsFilteredOut' in disabled.dryRun.evidence.expansion,
    false,
    '一个根都没剔就不长这个键 —— 证据对象与改前逐字节相同',
  )

  // 换一家工厂的编码约定:规则是配置,不是写死的字典。
  const retuned = await dryRunWithRootSelection({ mainDrawingPrefix: 'B', mainDrawingSuffix: '-001' })
  assert.equal(retuned.dryRun.counts.add, 1, '换了前后缀,当根的就换成了另一条订单行')
  assert.equal(
    retuned.dryRun.evidence.expansion.rootsFilteredOut,
    1,
    '换规则之后被剔除的根同样计数',
  )

  // 配置本身 fail-closed,而且是在**配置时**就拒(存进快照的配置不能是对实际行为的谎言)。
  assert.throws(
    () => normalizeStockPreparationActionConfig(baseAction({ rootSelection: { mainDrawingSuffix: '' } })),
    (error) => error instanceof StockPreparationTableActionError
      && error.code === 'TABLE_ACTION_CONFIG_INVALID'
      && error.details.field === 'rootSelection.mainDrawingSuffix',
    '空后缀会让每个图号都成为总图 => 422,而不是悄悄当成「没配」',
  )
  assert.throws(
    () => normalizeStockPreparationActionConfig(baseAction({ rootSelection: 'legacy' })),
    (error) => error instanceof StockPreparationTableActionError && error.code === 'TABLE_ACTION_CONFIG_INVALID',
    '不是对象的 rootSelection 直接拒',
  )
}

// F1c — 同父去重的条数也必须走到 dry-run 证据里,理由同上:`summarizeBomExpansionForEvidence`
// 是一张白名单投影,summary 上的键不写进去就永远到不了操作员眼前,而这个数是「重拉之后行数
// 变少」的唯一解释。两条 active bomHead 指着同一条明细,正是差异A(展开器 banner 自承的重复
// 来源)的形状。
async function testCollapsedSiblingCountReachesDryRunEvidence() {
  const source = createSourceAdapter(childBomPlmData({
    DN_PDM_BomHeadInfo: [
      { part_id: 'PART-A', bom_id: 'BOM-A', SysVer: 'V1', bom_able: true },
      { part_id: 'PART-A', bom_id: 'BOM-A2', SysVer: 'V1', bom_able: true },
    ],
    DN_PDM_BomDetailsInfo: [
      { bom_pid: 'BOM-A', part_id: 'PART-B', Bom_ExAttr1: '3' },
      { bom_pid: 'BOM-A2', part_id: 'PART-B', Bom_ExAttr1: '3' },
    ],
  }))
  const records = createRecordsApi()
  const dryRun = await dryRunStockPreparationAction({
    action: normalizeStockPreparationActionConfig(baseAction()),
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: createMemoryStorage(),
    plannedAt: '2026-09-11T09:00:00.000Z',
  })
  assert.equal(dryRun.status, 'ready')
  assert.equal(dryRun.counts.add, 2, '根 + 一个子件:第二条 bomHead 的同键子件被同父去重吃掉')
  assert.equal(
    dryRun.evidence.expansion.duplicateSiblingsCollapsed,
    1,
    '合并条数进 dry-run 证据 —— 操作员分得清「PLM 少了件」和「我们按老系统合并了」',
  )
  const evidenceJson = JSON.stringify(dryRun.evidence)
  assert.equal(evidenceJson.includes('B-001'), false, '证据里只有计数,没有图号')
  assert.equal(evidenceJson.includes('Bolt'), false, '证据里只有计数,没有名称')

  // 反向:没合并过的那次 dry-run 证据不长这个键(与改前逐字节相同)。
  const clean = await dryRunStockPreparationAction({
    action: normalizeStockPreparationActionConfig(baseAction()),
    parameters: { projectNo: 'P-001' },
    sourceAdapter: createSourceAdapter(childBomPlmData()).adapter,
    recordsApi: createRecordsApi().recordsApi,
    tokenStore: createMemoryStorage(),
    plannedAt: '2026-09-11T09:00:00.000Z',
  })
  assert.equal('duplicateSiblingsCollapsed' in clean.evidence.expansion, false)
}

// ---------------------------------------------------------------------------------------------
// F1c-b — 客户包的 父组件图号 / 父组件名称 走完**交互链**,而且两道闸都在。
//
// 与 large-bom-jobs 那条(后台链)同形:两条真实调用链经过同一个规划器,但各自从不同的 seam 取
// 「动作声明的扩展列」——交互链是 computeDryRun 里的 `extensionFieldIds: action.extensionFieldIds`,
// 后台链是 `job.actionSnapshot.extensionFieldIds`。任何一条断线,对应链上的这两列就永远空着,而
// 纯函数用例照样绿。所以这里从**动作配置**出发,一路走到写进目标表的那条记录上。
// ---------------------------------------------------------------------------------------------
const PARENT_PACK_COLUMN_IDS = ['ext_parentDrawingNo', 'ext_parentName']

function installedParentPackColumns() {
  return PARENT_PACK_COLUMN_IDS.map((fieldId) => ({
    logicalId: fieldId,
    name: fieldId,
    type: 'string',
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
  }))
}

// 父件的 IdentityName 带空格:F1c 把**当前组件**那一侧切成 名称 + 规格,父件这一侧老系统从不切。
// 所以 父组件名称 应当是全串 'Assembly DN1200',这条也顺带钉住包列没有偷偷去拿切过的首段。
function parentPackPlmData() {
  return childBomPlmData({
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly DN1200', Material: 'Steel', SysVer: 'V1' },
      { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1' },
    ],
  })
}

async function pullParentPackRowsWith(action) {
  const source = createSourceAdapter(parentPackPlmData())
  const records = createRecordsApi()
  const storage = createMemoryStorage()
  const installedFieldProperties = installedParentPackColumns()
  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    installedFieldProperties,
    plannedAt: '2026-09-12T09:00:00.000Z',
  })
  assert.equal(dryRun.status, 'ready')
  assert.equal(dryRun.counts.add, 2, '根 + 一个子件')
  const applied = await applyStockPreparationAction({
    sandboxPolicy: SANDBOX_POLICY,
    action,
    parameters: { projectNo: 'P-001' },
    dryRunToken: dryRun.dryRunToken,
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore: storage,
    installedFieldProperties,
    permission: 'write',
  })
  assert.equal(applied.status, 'succeeded')
  assert.equal(applied.apply.counts.created, 2)
  return records.calls.filter((call) => call[0] === 'createRecord').map((call) => call[1].data)
}

async function testParentPackColumnsReachTheInteractiveChain() {
  const declared = await pullParentPackRowsWith(normalizeStockPreparationActionConfig(
    baseAction({ extensionFieldIds: PARENT_PACK_COLUMN_IDS }),
  ))
  const child = declared.find((data) => data.componentSourceId === 'PART-B')
  const root = declared.find((data) => data.componentSourceId === 'PART-A')
  assert.ok(child && root, '这批写进目标表的是一根一子')
  assert.equal(child.ext_parentDrawingNo, 'A-001', '交互链把 父组件图号 写进客户包列')
  assert.equal(child.ext_parentName, 'Assembly DN1200', '父组件名称 是父件**未切分**的全串(老系统 754-755 口径)')
  // 同源:包列与模板列是同一个值,不是两套取值规则各算一遍。
  assert.equal(child.ext_parentDrawingNo, child.parentComponentCode, '包列 = 模板列 parentComponentCode')
  assert.equal(child.ext_parentName, child.parentComponentName, '包列 = 模板列 parentComponentName')
  for (const fieldId of PARENT_PACK_COLUMN_IDS.concat(['parentComponentCode', 'parentComponentName'])) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(root, fieldId),
      false,
      '根行无父 ⇒ ' + fieldId + ' 连键都没有,不写空串',
    )
  }

  // 负控 = 这条断线的证据:动作没声明这两列(表上照样装着包)⇒ 交互链一个 ext_ 键都不写。
  // 声明才是「目标表 fieldIdMap 已绑定」的凭据,派进没绑的列会让整行写入被 apply-writer 硬拒。
  const undeclared = await pullParentPackRowsWith(normalizeStockPreparationActionConfig(baseAction()))
  for (const data of undeclared) {
    assert.deepEqual(
      Object.keys(data).filter((key) => key.startsWith('ext_')),
      [],
      '没声明扩展列的动作写不出任何 ext_ 列',
    )
  }
  assert.equal(
    undeclared.find((data) => data.componentSourceId === 'PART-B').parentComponentCode,
    'A-001',
    '模板列照旧 —— 这次改动是纯加法',
  )
}

main().catch((err) => {
  console.error('stock-preparation-table-actions.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
