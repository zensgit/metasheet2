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
  __internals: tableActionInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const {
  DECISIONS,
  __internals: plannerInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const {
  saveTableScopeConflictPolicies,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-policies.cjs'))

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

async function main() {
  await testRegistryListsConfiguredMetadataWithoutTargetSecrets()
  await testDryRunRequiresAllowlistedParametersAndStoresToken()
  await testDryRunUsesPhysicalTargetFieldMapForExistingRowFilter()
  await testBridgeSourceKindRequiresExplicitMatchingReadPlanAndCanDryRun()
  await testTargetFieldMapIncompleteFailsBeforeReads()
  await testApplyRequiresTokenRecomputesAndScopesTarget()
  await testSavedKeepMultipleRowsPolicyRequiresFreshReviewAndAppliesResolvedRows()
  await testSavedSourceCorrectionPolicyKeepsDuplicateHeldAndWritesNothing()
  await testLargeBomBoundedDryRunBlocksApplyToken()
  await testLargeBomBoundedApplyRejectsMatchingTokenBeforeWrites()
  await testMissingChildBomDryRunBlocksApplyTokenAndWrites()
  await testReadPageLimitBoundedDryRunAndDepthHardFailureStayDistinct()
  await testApplyNormalizesNumericPlmDisplayFieldsBeforeCreate()
  await testApplySurfacesTypedValuesFreeRowFailureDiagnostics()
  await testApplyDetectsDataShiftAndManualConfirmHold()
  await testApplySandboxGateFailsClosed()

  console.log('stock-preparation-table-actions.test.cjs OK')
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

main().catch((err) => {
  console.error('stock-preparation-table-actions.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
