'use strict'

// #2253 C1b-1 target provisioning helper tests.
// Locks the latent backend helper: admin-only, metadata-only, canonical C1
// manifest as source of truth, no PLM read, no records API, no K3.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID,
  STOCK_PREPARATION_DEFAULT_VIEW_LOGICAL_ID,
  STOCK_PREPARATION_FILL_VIEW_HIDDEN_FIELD_IDS,
  assertFillViewContract,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const {
  SANDBOX_FIELD_MAP_MODE,
  StockPreparationTargetProvisioningError,
  buildStockPreparationTargetDescriptor,
  summarizeStockPreparationTargetReadiness,
  inspectStockPreparationCanonicalTarget,
  inspectStockPreparationSandboxTarget,
  ensureStockPreparationCanonicalTarget,
  ensureStockPreparationSandboxTarget,
  repairStockPreparationCanonicalTarget,
  CANONICAL_REPAIR_HAS_PRODUCTION_ENTRYPOINT,
  ensureStockPreparationFillView,
  buildStockPreparationFillViewDescriptor,
  sandboxStockPreparationTemplate,
  assertRepairableFieldOwnership,
  assertSandboxObjectId,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-target-provisioning.cjs'))

const LOGICAL_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const RESOLVED_FIELD_ID_MAP = Object.fromEntries(LOGICAL_FIELD_IDS.map((fieldId) => [fieldId, `fld_${fieldId}`]))

function createContext({
  sheetExists = false,
  missingFields = [],
  failRecordsOnUse = true,
  failEnsure = false,
} = {}) {
  const calls = {
    findObjectSheet: [],
    resolveFieldIds: [],
    ensureObject: [],
    records: [],
  }
  let currentSheet = sheetExists
    ? {
        id: 'sheet_private_stock_target',
        baseId: 'base_stock',
        name: 'PLM Stock Preparation Main',
        description: null,
      }
    : null
  let currentMissing = new Set(missingFields)
  const provisioning = {
    async findObjectSheet(input) {
      calls.findObjectSheet.push(input)
      return currentSheet ? { ...currentSheet } : null
    },
    async resolveFieldIds(input) {
      calls.resolveFieldIds.push(input)
      const out = {}
      for (const fieldId of input.fieldIds || []) {
        if (!currentMissing.has(fieldId)) out[fieldId] = `fld_${fieldId}`
      }
      return out
    },
    // W2: DB-backed existence — only EXISTING (non-missing) fields resolve.
    async resolveExistingObjectFieldIds(input) {
      calls.resolveExistingObjectFieldIds = calls.resolveExistingObjectFieldIds || []
      calls.resolveExistingObjectFieldIds.push(input)
      const out = {}
      for (const fieldId of input.fieldIds || []) {
        if (!currentMissing.has(fieldId)) out[fieldId] = `fld_${fieldId}`
      }
      return out
    },
    // W2: DB-backed content — stable {name,type,property} for existing fields.
    async readObjectFieldsContent(input) {
      calls.readObjectFieldsContent = calls.readObjectFieldsContent || []
      calls.readObjectFieldsContent.push(input)
      const out = {}
      // Fake mirrors the REAL provisioning surface: content snapshot carries `order` too
      // (round-5 review P3 — `order` is part of the mutation-guard's column identity).
      for (const fieldId of input.fieldIds || []) {
        if (!currentMissing.has(fieldId)) out[fieldId] = { name: fieldId, type: 'text', property: {}, order: 0 }
      }
      return out
    },
    async ensureObject(input) {
      calls.ensureObject.push({
        projectId: input.projectId,
        baseId: input.baseId,
        descriptor: input.descriptor,
      })
      if (failEnsure) throw new Error('mock ensureObject failure')
      currentSheet = {
        id: 'sheet_created_stock_target',
        baseId: input.baseId || 'base_default',
        name: input.descriptor.name,
        description: input.descriptor.description || null,
      }
      currentMissing = new Set()
      return {
        baseId: currentSheet.baseId,
        sheet: { ...currentSheet },
        fields: input.descriptor.fields.map((field, index) => ({
          id: `physical_${index}_${field.id}`,
          sheetId: currentSheet.id,
          name: field.name,
          type: field.type,
          property: field.property || {},
          order: index,
        })),
      }
    },
    async ensureMissingObjectFields(input) {
      calls.ensureMissingObjectFields = calls.ensureMissingObjectFields || []
      calls.ensureMissingObjectFields.push(input)
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const field of input.fields || []) {
        if (currentMissing.has(field.id)) {
          currentMissing.delete(field.id)
          addedFieldIds.push(`fld_${field.id}`)
        } else {
          skippedExistingFieldIds.push(`fld_${field.id}`)
        }
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    // W2/P2-3: atomic repair runner. The surface forwards to THIS provisioning object's
    // CURRENT methods, so a per-test override (e.g. readObjectFieldsContent /
    // ensureMissingObjectFields set after createContext) is honored inside the repair body.
    async runObjectFieldsRepairTransaction(fn) {
      const p = this
      calls.runObjectFieldsRepairTransaction = (calls.runObjectFieldsRepairTransaction || 0) + 1
      return fn({
        findObjectSheet: (i) => p.findObjectSheet(i),
        resolveExistingObjectFieldIds: (i) => p.resolveExistingObjectFieldIds(i),
        readObjectFieldsContent: (i) => p.readObjectFieldsContent(i),
        ensureMissingObjectFields: (i) => p.ensureMissingObjectFields(i),
      })
    },
  }
  const records = {
    async queryRecords(input) {
      calls.records.push(['queryRecords', input])
      if (failRecordsOnUse) throw new Error('records API must not be used')
      return []
    },
    async createRecord(input) {
      calls.records.push(['createRecord', input])
      if (failRecordsOnUse) throw new Error('records API must not be used')
      return {}
    },
    async patchRecord(input) {
      calls.records.push(['patchRecord', input])
      if (failRecordsOnUse) throw new Error('records API must not be used')
      return {}
    },
  }
  return {
    context: {
      api: {
        multitable: {
          provisioning,
          records,
        },
      },
    },
    calls,
  }
}

// Sync twin of rejectsWith: returns the thrown error so a caller can assert on its
// closed `code`. `assert.throws` does not hand the error back.
function throwsWith(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

async function rejectsWith(fn, code) {
  let err = null
  try {
    await fn()
  } catch (error) {
    err = error
  }
  assert.ok(err instanceof StockPreparationTargetProvisioningError, `expected provisioning error for ${code}`)
  assert.equal(err.code, code)
  return err
}


// A refusal that does not say what WOULD be accepted sends the operator to the source. Observed on
// the first real deployment: a hand-picked sandbox objectId was rejected with 'must use the
// stock-preparation sandbox namespace' and no way to learn the namespace from the response.
async function testSandboxNamespaceRefusalNamesTheNamespace() {
  let caught = null
  try { assertSandboxObjectId('stock_prep_sandbox_trial') } catch (error) { caught = error }
  assert.ok(caught, 'a non-namespaced sandbox objectId must be refused')
  assert.equal(caught.details.reason, 'not_sandbox_namespace')
  assert.equal(caught.details.requiredNamespace, 'plm_stock_preparation_sandbox')
  assert.match(caught.message, /plm_stock_preparation_sandbox/)
  // and the accepted form actually passes, so the message is not merely plausible
  assert.equal(assertSandboxObjectId('plm_stock_preparation_sandbox_trial'), 'plm_stock_preparation_sandbox_trial')
  assert.equal(assertSandboxObjectId('plm_stock_preparation_sandbox'), 'plm_stock_preparation_sandbox')
  // the caller-supplied value is never echoed back
  assert.equal(caught.message.includes('stock_prep_sandbox_trial'), false)
  console.log('  testSandboxNamespaceRefusalNamesTheNamespace OK')
}
// ext_ 客户包列写口守卫盘点结清 (beiliao-takeover-status-ledger.md §4, 2026-09-11 全集盘点 ⑤).
// The ensure/inspect binding site feeds `input.extensionFieldIds` through the SAME
// `assertExtensionFieldIdValid` predicate the repair paths use, via `normalizeExtensionFieldIds`
// (stock-preparation-target-provisioning.cjs:300 -> :314, called from `inspectStockPreparationTarget`
// at :419 -- BEFORE any sheet/field read). This locks that call reachable from the PUBLIC
// `inspectStockPreparationCanonicalTarget` entry point, independent of whatever HTTP route wires
// (or fails to wire) `extensionFieldIds` on top of it.
//
// SCOPE: that predicate (stock-preparation-extension-namespace.cjs:117-165) checks NAMESPACE SHAPE
// ONLY -- prefix, suffix shape, forbidden content keys, collision with a frozen template field. It
// holds no pack catalog, so "an id no customer pack declared" is NOT refused here; case (3) pins
// that boundary as an accept. Pack membership is enforced one layer out, at
// stock-preparation-ext-field-mapping.cjs:315-317 (TARGET_NOT_DECLARED_IN_PACK, battery at
// __tests__/stock-preparation-ext-field-mapping.test.cjs:232), and physical creation is bounded by
// the frozen descriptor regardless (an id with no descriptor entry can never become a column).
async function testInspectExtensionFieldIdsEnforceNamespaceShapeOnly() {
  // (1) guard existence: an id with no `ext_` prefix at all is refused before any sheet or field read.
  const { context: rejectingContext, calls: rejectingCalls } = createContext({ sheetExists: true })
  let namespaceError = null
  try {
    await inspectStockPreparationCanonicalTarget({
      context: rejectingContext, projectId: 'tenant:proj', permission: 'admin', extensionFieldIds: ['procurementDone'],
    })
  } catch (error) {
    namespaceError = error
  }
  assert.ok(namespaceError, 'a non-`ext_` id in extensionFieldIds must be refused')
  assert.equal(namespaceError.reason, 'FIELD_ID_PREFIX_MISSING', 'guard/reason code must stay stable')
  assert.equal(rejectingCalls.findObjectSheet.length, 0, 'the guard runs before any sheet read')

  // (2) positive control: a real customer-pack `ext_` id (FACTORY_A_REHEARSAL_PACK declares
  // `ext_stockPrepDate`) is admitted, and inspect proceeds to its normal ready verdict once the
  // physical column resolves -- the guard does not block the feature it exists to let through.
  const { context: readyContext } = createContext({ sheetExists: true })
  const inspected = await inspectStockPreparationCanonicalTarget({
    context: readyContext, projectId: 'tenant:proj', permission: 'admin', extensionFieldIds: ['ext_stockPrepDate'],
  })
  assert.equal(inspected.ready, true, 'a legitimate customer-pack ext_ id does not block inspect')

  // (3) THE BOUNDARY, pinned as an accept: a shape-valid id that no pack declares also passes here.
  // Pinning it keeps the ledger inventory honest -- if someone later teaches this call site pack
  // membership, this goes red and the inventory must move with it.
  const { context: shapeOnlyContext } = createContext({ sheetExists: true })
  const shapeOnly = await inspectStockPreparationCanonicalTarget({
    context: shapeOnlyContext, projectId: 'tenant:proj', permission: 'admin', extensionFieldIds: ['ext_notInAnyPackWhatsoever'],
  })
  assert.equal(shapeOnly.ready, true, 'namespace guard is shape-only: pack membership is NOT checked here')
  console.log('  testInspectExtensionFieldIdsEnforceNamespaceShapeOnly OK')
}
// ---------------------------------------------------------------------------
// 备料填写视图 (F1-C) — THE FILL VIEW
// ---------------------------------------------------------------------------
//
// The view 「打开项目备料」 lands on. Four things are pinned here, because each one is a way
// this could ship looking right and doing nothing:
//   (1) the STORED ids are PHYSICAL — a view whose hidden/sort/group/filter rules carry LOGICAL
//       ids hides nothing at all (meta_views rules are compared against meta_fields.id);
//   (2) the hidden set is exactly the 12 plm_system columns and may never contain a human column;
//   (3) `default` is NEVER upserted — the host's "a sheet that already has ANY view is left
//       completely alone" guarantee is what an upsert onto that id would hole; and
//   (4) both the CREATE path and the REPAIR path actually call it (a guard nobody wires is a
//       comment), repair being the one that WOULD reach tables that already exist — once anything
//       calls it, which nothing does yet (see testCanonicalRepairReachabilityIsPinned).
const FILL_VIEW_PHYSICAL = (fieldId) => `fld_${fieldId}`

// A provisioning fake with the VIEW half of the API: deterministic ids, a tiny meta_views store
// and a recorder. `ensureObjectDefaultView` behaves like the host primitive it stands for (writes
// only from zero views, never touches an existing one) so "the default view did not move" is a
// statement about a STORED ROW, not about a mock's call list.
// `ensureViewThrows` is either `true` (a plain host error — a scope refusal, a DB hiccup) or an
// Error INSTANCE, so a test can distinguish host weather from a refusal this plugin raises itself.
function withViewApi(ctx, { ensureViewThrows = false } = {}) {
  const provisioning = ctx.context.api.multitable.provisioning
  const views = new Map()
  const calls = { ensureView: [], ensureObjectDefaultView: [], getFieldId: [] }
  provisioning.getFieldId = (projectId, objectId, fieldId) => {
    calls.getFieldId.push([projectId, objectId, fieldId])
    return FILL_VIEW_PHYSICAL(fieldId)
  }
  provisioning.getObjectViewId = (projectId, objectId, viewId) => `view_${objectId}_${viewId}`
  provisioning.ensureObjectDefaultView = async (input) => {
    calls.ensureObjectDefaultView.push(input)
    if (views.size > 0) return { created: false, viewId: null, existingViewCount: views.size }
    const id = `view_${input.objectId}_default`
    views.set(id, {
      id,
      name: input.name,
      type: input.type || 'grid',
      filterInfo: {},
      sortInfo: {},
      groupInfo: {},
      hiddenFieldIds: [],
      config: {},
    })
    return { created: true, viewId: id, existingViewCount: 0 }
  }
  provisioning.ensureView = async (input) => {
    calls.ensureView.push(input)
    if (ensureViewThrows) {
      throw ensureViewThrows instanceof Error ? ensureViewThrows : new Error('mock ensureView refusal (sheet scope)')
    }
    const id = `view_${input.descriptor.objectId}_${input.descriptor.id}`
    const stored = {
      id,
      sheetId: input.sheetId,
      name: input.descriptor.name,
      type: input.descriptor.type || 'grid',
      filterInfo: input.descriptor.filterInfo || {},
      sortInfo: input.descriptor.sortInfo || {},
      groupInfo: input.descriptor.groupInfo || {},
      hiddenFieldIds: input.descriptor.hiddenFieldIds || [],
      config: input.descriptor.config || {},
    }
    views.set(id, stored)
    return stored
  }
  return { provisioning, views, viewCalls: calls }
}

async function testFillViewDescriptorIsPhysicalAndValuesFree() {
  const provisioning = { getFieldId: (projectId, objectId, fieldId) => FILL_VIEW_PHYSICAL(fieldId) }
  const descriptor = buildStockPreparationFillViewDescriptor({
    provisioning,
    projectId: 'proj_x',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    locale: 'zh-CN',
  })

  // (1) its own id, and NOT the default view's.
  assert.equal(descriptor.id, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID)
  assert.equal(descriptor.id, 'prep-fill')
  assert.notEqual(descriptor.id, STOCK_PREPARATION_DEFAULT_VIEW_LOGICAL_ID)
  assert.equal(descriptor.name, '备料填写视图')
  assert.equal(
    buildStockPreparationFillViewDescriptor({ provisioning, projectId: 'proj_x', objectId: 'o', locale: 'en' }).name,
    'Stock Preparation Fill',
  )

  // (2) LOGICAL -> PHYSICAL on every stored id. The negative half is the one that matters: not a
  //     single bare logical id survives into the stored shape, which is what silently hides nothing.
  assert.deepEqual(descriptor.hiddenFieldIds, STOCK_PREPARATION_FILL_VIEW_HIDDEN_FIELD_IDS.map(FILL_VIEW_PHYSICAL))
  assert.equal(descriptor.hiddenFieldIds.length, 12, 'the customer named 12 system columns')
  const logicalIds = new Set(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id))
  const storedIds = [
    ...descriptor.hiddenFieldIds,
    ...descriptor.sortInfo.rules.map((rule) => rule.fieldId),
    ...descriptor.groupInfo.fieldIds,
    descriptor.groupInfo.fieldId,
    ...descriptor.filterInfo.conditions.map((condition) => condition.fieldId),
  ]
  for (const id of storedIds) {
    assert.equal(logicalIds.has(id), false, `stored view ids must be physical, found logical: ${id}`)
    assert.equal(id.startsWith('fld_'), true)
  }

  // (3) 按父组件分组、组内按图号排序 — ascending, explicit, and BOTH group shapes (the grid reads
  //     the ordered `fieldIds`; other view kinds still read the legacy single `fieldId`).
  assert.deepEqual(descriptor.sortInfo, {
    rules: [
      { fieldId: FILL_VIEW_PHYSICAL('parentComponentCode'), desc: false },
      { fieldId: FILL_VIEW_PHYSICAL('componentCode'), desc: false },
    ],
  })
  assert.deepEqual(descriptor.groupInfo, {
    fieldIds: [FILL_VIEW_PHYSICAL('parentComponentCode')],
    fieldId: FILL_VIEW_PHYSICAL('parentComponentCode'),
  })

  // (4) 有效 only — a refresh MARKS rows inactive rather than deleting them.
  assert.deepEqual(descriptor.filterInfo, {
    conjunction: 'and',
    conditions: [{ fieldId: FILL_VIEW_PHYSICAL('active'), operator: 'is', value: true }],
  })

  // (5) values-free provenance: counts and booleans, no customer row value anywhere.
  assert.deepEqual(descriptor.config.stockPreparation.fillView, {
    logicalId: 'prep-fill',
    hiddenFieldCount: 12,
    sortFieldCount: 2,
    groupFieldCount: 1,
    filtersActiveOnly: true,
  })
  console.log('  testFillViewDescriptorIsPhysicalAndValuesFree OK')
}

async function testFillViewContractCannotHideAHumanColumn() {
  // The shipped contract agrees with the frozen template: every hidden id is a plm_system column,
  // and not one of them is in the human band a person fills.
  const ownershipById = new Map(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((f) => [f.id, f.ownership]))
  for (const fieldId of STOCK_PREPARATION_FILL_VIEW_HIDDEN_FIELD_IDS) {
    assert.equal(ownershipById.get(fieldId), 'plm_system', `${fieldId} must be a plm_system column`)
    assert.equal(HUMAN_PRESERVED_FIELD_IDS.includes(fieldId), false, `${fieldId} must not be human-owned`)
  }
  assert.equal(assertFillViewContract(), true, 'the shipped contract checks out')

  // Each way of getting it wrong is refused, so the check is a wall and not a formality.
  const humanId = HUMAN_PRESERVED_FIELD_IDS[0]
  assert.throws(() => assertFillViewContract({ hiddenFieldIds: [humanId] }), /only hide plm_system columns/)
  assert.throws(() => assertFillViewContract({ hiddenFieldIds: ['noSuchColumn'] }), /hides an unknown field/)
  assert.throws(
    () => assertFillViewContract({ hiddenFieldIds: ['parentComponentCode'] }),
    /cannot sort or group by a column it hides/,
  )
  assert.throws(() => assertFillViewContract({ sortFieldIds: ['noSuchColumn'] }), /orders by an unknown field/)
  // THE ONE THAT PROTECTS THE DEFAULT VIEW at the constants layer.
  assert.throws(() => assertFillViewContract({ fillViewLogicalId: 'default' }), /must not be the default view/)
  console.log('  testFillViewContractCannotHideAHumanColumn OK')
}

async function testCreatePathProvisionsTheFillViewAndLeavesDefaultAlone() {
  const ctx = createContext({ sheetExists: false })
  const { views, viewCalls } = withViewApi(ctx)
  const result = await ensureStockPreparationCanonicalTarget({
    context: ctx.context,
    projectId: 'proj_x',
    permission: 'admin',
    locale: 'zh-CN',
  })
  assert.equal(result.mode, 'canonical_create')
  assert.equal(result.fillView.created, true)
  assert.equal(result.fillView.hiddenFieldCount, 12)

  // It was sent to the SHEET THIS CALL CREATED, under the plugin's own view id.
  assert.equal(viewCalls.ensureView.length, 1)
  assert.equal(viewCalls.ensureView[0].sheetId, 'sheet_created_stock_target')
  assert.equal(viewCalls.ensureView[0].descriptor.id, 'prep-fill')

  // THE DEFAULT VIEW DID NOT MOVE. Not "was not called with" — the STORED ROW is byte-identical to
  // the one `ensureObjectDefaultView` wrote, so an upsert onto `default` fails right here.
  const defaultId = `view_${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId}_default`
  const defaultAfter = views.get(defaultId)
  assert.ok(defaultAfter, 'the default view exists')
  assert.equal(
    JSON.stringify(defaultAfter),
    JSON.stringify({
      id: defaultId,
      name: '全部记录',
      type: 'grid',
      filterInfo: {},
      sortInfo: {},
      groupInfo: {},
      hiddenFieldIds: [],
      config: {},
    }),
    'the default view must be byte-identical to what the default-view primitive wrote',
  )
  for (const call of viewCalls.ensureView) {
    assert.notEqual(call.descriptor.id, 'default', 'ensureView must never be pointed at the default view id')
  }
  console.log('  testCreatePathProvisionsTheFillViewAndLeavesDefaultAlone OK')
}

async function testRepairHealsTheFillViewOnAnExistingTable() {
  // The heal path as WRITTEN: the table already exists (so `ensure` returns without writing) and
  // repair is the verb that would give an EXISTING deployment the view. This test proves the verb's
  // BODY, not its reachability — nothing calls it in production today, which is pinned separately by
  // testCanonicalRepairReachabilityIsPinned. Read together: the heal is ready, the entry is not.
  const ctx = createContext({ sheetExists: true, missingFields: ['depth'] })
  const { views, viewCalls } = withViewApi(ctx)
  // A default view the deployment already hand-tuned — repair must not touch it.
  const defaultId = `view_${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId}_default`
  const handTuned = {
    id: defaultId,
    name: '操作员自己调过的视图',
    type: 'grid',
    filterInfo: {},
    sortInfo: { rules: [{ fieldId: 'fld_componentName', desc: true }] },
    groupInfo: {},
    hiddenFieldIds: ['fld_notes'],
    config: {},
  }
  views.set(defaultId, handTuned)
  const before = JSON.stringify(handTuned)

  const result = await repairStockPreparationCanonicalTarget({
    context: ctx.context,
    projectId: 'proj_x',
    permission: 'admin',
    locale: 'zh-CN',
  })
  assert.equal(result.mode, 'canonical_repaired')
  assert.equal(result.fillView.created, true)
  assert.equal(result.evidence.fillViewCreated, true)
  assert.equal(result.evidence.fillViewSkipped, null)

  const fill = views.get(`view_${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId}_prep-fill`)
  assert.ok(fill, 'repair created the fill view')
  assert.equal(fill.sheetId, 'sheet_private_stock_target', 'the fill view is attached to the sheet repair proved exists')
  assert.equal(fill.hiddenFieldIds.length, 12)
  assert.equal(fill.name, '备料填写视图')
  assert.equal(JSON.stringify(views.get(defaultId)), before, 'the hand-tuned default view is byte-identical after repair')
  for (const call of viewCalls.ensureView) {
    assert.notEqual(call.descriptor.id, 'default', 'repair must never upsert the default view')
  }
  console.log('  testRepairHealsTheFillViewOnAnExistingTable OK')
}

async function testCreateLegReportsTheFillViewOutcomeAndNeverLosesTheTable() {
  // WHY THIS EXISTS (review blocker, 2026-09-11). The create leg is the ONLY reachable leg of this
  // feature, and it used to be the only one that could neither report nor survive a fill-view
  // failure: the outcome lived on `result.fillView`, which the plugin's HTTP projection drops
  // (publicStockPreparationTargetResult returns ready/mode/targetBinding/evidence only), and a
  // throwing `ensureView` took the whole ensure down AFTER the table had been committed. Re-running
  // ensure then takes the already-ready leg — ready:true, no view, forever, with no reachable repair
  // verb. So: the outcome rides the EVIDENCE, and a host failure degrades.

  // (a) The happy path reports itself where an admin can actually see it.
  const ok = createContext({ sheetExists: false })
  withViewApi(ok)
  const created = await ensureStockPreparationCanonicalTarget({
    context: ok.context,
    projectId: 'proj_x',
    permission: 'admin',
    locale: 'zh-CN',
  })
  assert.equal(created.evidence.fillViewCreated, true, 'the fill view outcome is in the evidence, not only on a dropped key')
  assert.equal(created.evidence.fillViewSkipped, null)

  // (b) The host REFUSES the view write on the table this very call created. The table is already
  //     committed, so the create stays successful and the refusal is reported.
  const refusing = createContext({ sheetExists: false })
  const { views, viewCalls } = withViewApi(refusing, { ensureViewThrows: true })
  const degraded = await ensureStockPreparationCanonicalTarget({
    context: refusing.context,
    projectId: 'proj_x',
    permission: 'admin',
    locale: 'zh-CN',
  })
  assert.equal(degraded.ready, true, 'a committed table must not be reported as a failed ensure over a display view')
  assert.equal(degraded.mode, 'canonical_create')
  assert.equal(degraded.fillView.skipped, 'ensure_failed')
  assert.equal(degraded.evidence.fillViewCreated, false)
  assert.equal(degraded.evidence.fillViewSkipped, 'ensure_failed', 'the admin can tell the view is missing')
  assert.ok(degraded.target && degraded.target.sheetId, 'the binding of the committed table still travels out')
  // The default view of that same table was still created, and the failed fill view left no row.
  const defaultId = `view_${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId}_default`
  assert.ok(views.get(defaultId), 'the default view the create leg writes is unaffected')
  assert.equal(views.has(`view_${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId}_prep-fill`), false)
  for (const call of viewCalls.ensureView) {
    assert.notEqual(call.descriptor.id, 'default', 'and the failure path still never points ensureView at the default view')
  }

  // (c) An older host with no view API at all: same shape, different reason code — the create leg
  //     provisions exactly as it did before this feature and says so.
  const oldHost = createContext({ sheetExists: false })
  const legacy = await ensureStockPreparationCanonicalTarget({
    context: oldHost.context,
    projectId: 'proj_x',
    permission: 'admin',
  })
  assert.equal(legacy.ready, true)
  assert.equal(legacy.evidence.fillViewCreated, false)
  assert.equal(legacy.evidence.fillViewSkipped, 'api_unavailable')

  // (d) THE ONE FAILURE THAT IS NOT DEGRADED. A StockPreparationTargetProvisioningError out of the
  //     fill-view helper is this module's OWN refusal — above all FILL_VIEW_MUST_NOT_OVERWRITE_DEFAULT,
  //     the guard that keeps this feature off a deployment's default view. Demoting that to
  //     `skipped: 'ensure_failed'` would turn the loudest guard in the file into a quiet evidence key,
  //     so it travels out of BOTH legs as the error it is.
  const refusalError = new StockPreparationTargetProvisioningError(
    409,
    'FILL_VIEW_MUST_NOT_OVERWRITE_DEFAULT',
    'the stock-preparation fill view may never be upserted onto the default view id',
    { objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId },
  )
  const refusedCreate = createContext({ sheetExists: false })
  withViewApi(refusedCreate, { ensureViewThrows: refusalError })
  await assert.rejects(
    () => ensureStockPreparationCanonicalTarget({ context: refusedCreate.context, projectId: 'proj_x', permission: 'admin' }),
    (error) => error.code === 'FILL_VIEW_MUST_NOT_OVERWRITE_DEFAULT',
    'the create leg must not swallow this module\'s own refusal',
  )
  const refusedRepair = createContext({ sheetExists: true, missingFields: ['depth'] })
  withViewApi(refusedRepair, { ensureViewThrows: refusalError })
  await assert.rejects(
    () => repairStockPreparationCanonicalTarget({ context: refusedRepair.context, projectId: 'proj_x', permission: 'admin' }),
    (error) => error.code === 'FILL_VIEW_MUST_NOT_OVERWRITE_DEFAULT',
    'and neither may the repair leg',
  )
  console.log('  testCreateLegReportsTheFillViewOutcomeAndNeverLosesTheTable OK')
}

async function testFillViewDegradesWithoutFailingTheRepair() {
  // (a) An older host with no view API at all: provisioning is unchanged from today, and the
  //     evidence says which leg ran rather than claiming a view that does not exist.
  const oldHost = createContext({ sheetExists: true, missingFields: ['depth'] })
  const oldResult = await repairStockPreparationCanonicalTarget({
    context: oldHost.context,
    projectId: 'proj_x',
    permission: 'admin',
  })
  assert.equal(oldResult.ready, true)
  assert.equal(oldResult.fillView.created, false)
  assert.equal(oldResult.fillView.skipped, 'api_unavailable')
  assert.equal(oldResult.evidence.fillViewCreated, false)
  assert.equal(oldResult.evidence.fillViewSkipped, 'api_unavailable')

  // (b) A host that REFUSES the write (an unclaimed sheet fails the scope assertion): the schema
  //     repair is already committed, so it stays successful and the refusal is REPORTED, not
  //     swallowed — re-running repair after the registry is fixed creates the view.
  const refusing = createContext({ sheetExists: true, missingFields: ['depth'] })
  withViewApi(refusing, { ensureViewThrows: true })
  const refusedResult = await repairStockPreparationCanonicalTarget({
    context: refusing.context,
    projectId: 'proj_x',
    permission: 'admin',
  })
  assert.equal(refusedResult.ready, true)
  assert.equal(refusedResult.mode, 'canonical_repaired')
  assert.equal(refusedResult.fillView.skipped, 'ensure_failed')
  assert.equal(refusedResult.evidence.fillViewCreated, false)
  assert.equal(refusedResult.evidence.fillViewSkipped, 'ensure_failed')

  // (c) The helper's own degrade legs, addressed directly: no view API, and a caller that cannot
  //     name a sheet. Neither may invent a view, and neither may throw.
  const noApi = await ensureStockPreparationFillView({
    provisioning: {},
    projectId: 'proj_x',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    sheetId: 'sheet_private_stock_target',
  })
  assert.deepEqual(noApi, { created: false, skipped: 'api_unavailable', viewId: null })
  const noSheet = await ensureStockPreparationFillView({
    provisioning: { ensureView: async () => { throw new Error('must not be reached') }, getFieldId: (p, o, f) => f },
    projectId: 'proj_x',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    sheetId: '',
  })
  assert.deepEqual(noSheet, { created: false, skipped: 'sheet_unknown', viewId: null })

  // (d) A TABLE THAT DOES NOT HAVE THE COLUMNS. `ensure` accepts a CALLER's template for a fresh
  //     table, and this view's rules are the FROZEN template's ids — so a template missing any of
  //     them is skipped and REPORTED rather than given a view full of ids that address nothing.
  let reached = false
  const strippedTemplate = {
    ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    fields: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((field) => field.id !== 'parentComponentCode'),
  }
  const mismatch = await ensureStockPreparationFillView({
    provisioning: { ensureView: async () => { reached = true; return {} }, getFieldId: (p2, o, f) => f },
    projectId: 'proj_x',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    sheetId: 'sheet_private_stock_target',
    template: strippedTemplate,
  })
  assert.deepEqual(mismatch, { created: false, skipped: 'template_mismatch', viewId: null })
  assert.equal(reached, false, 'a template without the columns never reaches the view write')
  // The SANDBOX template carries the same field ids under a different objectId, so it passes.
  const sandboxOk = await ensureStockPreparationFillView({
    provisioning: { ensureView: async (input) => ({ id: `view_${input.descriptor.id}` }), getFieldId: (p2, o, f) => `fld_${f}` },
    projectId: 'proj_x',
    objectId: 'plm_stock_preparation_sandbox_trial',
    sheetId: 'sheet_sandbox',
    template: sandboxStockPreparationTemplate({ objectId: 'plm_stock_preparation_sandbox_trial' }),
  })
  assert.equal(sandboxOk.created, true)
  console.log('  testFillViewDegradesWithoutFailingTheRepair OK')
}


// ---------------------------------------------------------------------------
// THE REACHABILITY TRIPWIRE (review blocker, 2026-09-11). The first cut of this change shipped the
// sentence "an existing deployment runs the canonical repair verb once and gets the fill view".
// It was FALSE: the verb has no HTTP route and no production caller anywhere in the plugin, so on
// a customer box the 「打开项目备料」 deep link still lands on the 33-column default view. A claim
// about WIRING cannot be held down by prose in a PR body, so it is pinned to the wiring here.
//
// THE SCAN DOMAIN IS THE CLAIM'S DOMAIN. This started out walking `lib/` only, which is SMALLER than
// what the constant asserts ("no production entry anywhere"): the plugin's real entry file
// (index.cjs, where adapters and stores get registered) sits one level ABOVE lib/, and so do
// scripts/ops/*.cjs and every core-backend module that can require this lib — wiring the verb into
// any of them left the constant at false and this test green. So the walk starts at the REPO ROOT.
//
// Test files are REFERENCES, NOT CALLERS (several suites drive the verb on purpose, and one
// core-backend integration test does too), so they are counted separately and reported rather than
// pinning the constant. KNOWN BLIND SPOTS, stated instead of implied: a caller that builds the name
// dynamically (`api['repair' + 'StockPreparationCanonicalTarget']`), a caller outside this
// repository, and a file type outside the extension list below. Nothing here can see those.
//
// The tree is scanned for anything that CALLS or REFERENCES the repair verb outside its own
// definition/export, and the verdict must equal the exported constant. BOTH directions fail:
//   - constant false + a route or caller appears => you wired it: flip the constant and update the
//     operator-facing wording in the same change;
//   - constant true + nothing calls it           => the claim is unearned.
// Comment lines are not callers (four files discuss the verb in prose), and the token itself is
// proved against the real definition so a rename cannot make the scan vacuously green.
async function testCanonicalRepairReachabilityIsPinned() {
  const fs = require('node:fs')
  const TOKEN = 'repairStockPreparationCanonicalTarget'
  const libDir = path.join(__dirname, '..', 'lib')
  const DEFINING_FILE = 'stock-preparation-target-provisioning.cjs'
  assert.ok(
    fs.readFileSync(path.join(libDir, DEFINING_FILE), 'utf8').includes(`async function ${TOKEN}(`),
    'the scanned token must name the real verb (a rename must not make this test vacuous)',
  )

  // The repo root, PROVED rather than assumed — a walk that silently started somewhere else (a
  // packaged copy of the plugin, a moved suite) would go quietly vacuous, which is the failure mode
  // this whole test exists to prevent.
  const repoRoot = path.join(__dirname, '..', '..', '..')
  assert.ok(fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml')), 'the scan must start at the repo root')
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.vite', 'out', 'artifacts'])
  const SCANNED_EXT = /\.(cjs|js|mjs|ts|tsx|vue|sh|ps1)$/
  const posix = (file) => path.relative(repoRoot, file).split(path.sep).join('/')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
      } else if (SCANNED_EXT.test(entry.name)) files.push(full)
    }
  }
  walk(repoRoot)
  const scanned = new Set(files.map(posix))
  assert.ok(files.length > 1000, 'the scan must actually see the repo tree')
  // The four places a future entry would most plausibly be wired. Each is asserted to be IN SCOPE,
  // so shrinking the walk back to a subtree fails here rather than going quietly green.
  for (const mustSee of [
    'plugins/plugin-integration-core/index.cjs',
    'plugins/plugin-integration-core/lib/http-routes.cjs',
    'packages/core-backend/src/index.ts',
    'scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs',
  ]) {
    assert.ok(scanned.has(mustSee), `${mustSee} must be in scan scope`)
  }

  const isTestFile = (file) => {
    const segments = path.relative(repoRoot, file).split(path.sep)
    return segments.some((segment) => segment === '__tests__' || segment === 'tests' || segment === 'test' || segment === 'e2e')
      || /\.(test|spec)\./.test(path.basename(file))
  }
  const callers = []
  const testReferences = []
  for (const file of files) {
    const isDefining = posix(file) === `plugins/plugin-integration-core/lib/${DEFINING_FILE}`
    let content
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!content.includes(TOKEN)) continue
    content.split('\n').forEach((line, index) => {
      const trimmed = line.trim()
      // Prose about the verb is not a caller.
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('#')) return
      if (!line.includes(TOKEN)) return
      // Its own definition and its own export entry are not callers either.
      if (isDefining && (trimmed.startsWith(`async function ${TOKEN}(`) || trimmed === `${TOKEN},`)) return
      ;(isTestFile(file) ? testReferences : callers).push(`${posix(file)}:${index + 1}`)
    })
  }
  // The verb IS driven by tests — that is how its body is proved — so a scan that found nothing at
  // all would mean the token stopped matching reality and every verdict below would be vacuous.
  assert.ok(testReferences.length > 0, 'the scan must still see the suites that drive the verb')
  assert.equal(
    callers.length > 0,
    CANONICAL_REPAIR_HAS_PRODUCTION_ENTRYPOINT,
    `CANONICAL_REPAIR_HAS_PRODUCTION_ENTRYPOINT says ${CANONICAL_REPAIR_HAS_PRODUCTION_ENTRYPOINT} but the repo says ${callers.length > 0}`
      + ` (references: ${callers.join(', ') || 'none'}). Flip the constant in the SAME change that exposes or removes the entry,`
      + ' and fix the operator-facing sentence about how an EXISTING 备料主表 obtains the 备料填写视图.',
  )

  // THE CONSEQUENCE, EXECUTABLE. What every existing deployment has is an ALREADY-READY table, and
  // that leg of `ensure` returns before any write — so "this cut only gives NEW tables the fill
  // view" is a tested fact rather than a hedge in the PR body. It is also the guard that would
  // catch someone "fixing" this blocker by teaching the ready leg to write views, which is exactly
  // the 「已存在即拒」 semantic this change is not allowed to weaken.
  const readyCtx = createContext({ sheetExists: true, missingFields: [] })
  const { views, viewCalls } = withViewApi(readyCtx)
  const ready = await ensureStockPreparationCanonicalTarget({
    context: readyCtx.context,
    projectId: 'proj_x',
    permission: 'admin',
  })
  assert.equal(ready.ready, true)
  assert.equal(ready.mode, 'canonical_existing', 'an existing table takes the already-ready leg')
  assert.equal(ready.fillView, undefined, 'the already-ready leg reports no fill view because it writes none')
  assert.equal(viewCalls.ensureView.length, 0, 'ensure must not upsert a view onto a table it did not create')
  assert.equal(viewCalls.ensureObjectDefaultView.length, 0, 'nor a default view')
  assert.equal(views.size, 0, 'no view row exists after ensure on an existing table')
  console.log('  testCanonicalRepairReachabilityIsPinned OK')
}

async function main() {
  await testCanonicalRepairReachabilityIsPinned()
  await testFillViewDescriptorIsPhysicalAndValuesFree()
  await testFillViewContractCannotHideAHumanColumn()
  await testCreatePathProvisionsTheFillViewAndLeavesDefaultAlone()
  await testCreateLegReportsTheFillViewOutcomeAndNeverLosesTheTable()
  await testRepairHealsTheFillViewOnAnExistingTable()
  await testFillViewDegradesWithoutFailingTheRepair()
  await testSandboxNamespaceRefusalNamesTheNamespace()
  await testInspectExtensionFieldIdsEnforceNamespaceShapeOnly()
  // Descriptor is manifest-derived, schema-only, and carries no rows/customer content.
  const descriptor = buildStockPreparationTargetDescriptor()
  assert.equal(descriptor.id, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
  assert.equal(descriptor.name, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.label)
  assert.deepEqual(
    descriptor.fields.map((field) => field.id),
    LOGICAL_FIELD_IDS,
    'descriptor field list is byte-locked to C1 manifest order',
  )
  assert.ok(!('rows' in descriptor), 'descriptor carries no rows')
  const byId = Object.fromEntries(descriptor.fields.map((field) => [field.id, field]))
  assert.deepEqual(byId.idempotencyKey.property.validation, [{ type: 'required' }])
  assert.deepEqual(byId.idempotencyKey.property.stockPreparation, {
    ownership: 'plm_system',
    preserveOnRefresh: false,
    required: true,
    key: true,
  })
  assert.deepEqual(byId.materialType.property.stockPreparation, {
    ownership: 'human_preserved',
    preserveOnRefresh: true,
    required: false,
    key: false,
    optionSource: { type: 'config_info', key: 'material_type' },
  })
  assert.ok(!JSON.stringify(descriptor).includes('P2026-001'), 'descriptor evidence has no project value')
  assert.ok(!JSON.stringify(descriptor).includes('Widget'), 'descriptor evidence has no business row value')

  const summary = summarizeStockPreparationTargetReadiness()
  assert.equal(summary.status, 'not_ready')
  assert.equal(summary.mode, 'canonical_unchecked')
  assert.equal(summary.fieldMapMode, 'canonical')
  assert.equal(summary.target.fieldIdMapEmpty, true)
  assert.equal(summary.fieldCounts.total, LOGICAL_FIELD_IDS.length)
  assert.ok(summary.optionSources.some((entry) => entry.field === 'materialType' && entry.key === 'material_type'))
  assert.ok(!JSON.stringify(summary).includes('sheet_private_stock_target'), 'readiness evidence hides sheet id')

  // Admin-only and provisioning-api fail closed before any action.
  const missingApi = await rejectsWith(
    () => ensureStockPreparationCanonicalTarget({
      context: { api: { multitable: {} } },
      projectId: 'tenant:proj',
      permission: 'admin',
    }),
    'TARGET_PROVISIONING_API_UNAVAILABLE',
  )
  assert.deepEqual(missingApi.details.requiredMethods, ['findObjectSheet', 'resolveFieldIds', 'ensureObject'])

  const { context: permissionCtx, calls: permissionCalls } = createContext({ sheetExists: true })
  await rejectsWith(
    () => ensureStockPreparationCanonicalTarget({
      context: permissionCtx,
      projectId: 'tenant:proj',
      permission: 'write',
    }),
    'TARGET_PROVISIONING_PERMISSION_DENIED',
  )
  assert.equal(permissionCalls.findObjectSheet.length, 0, 'permission failure happens before provisioning reads')

  // Existing canonical target binds resolved logical -> physical fields. The
  // entity-machine C5 smoke proved that an empty fieldIdMap is not enough when
  // the records API physical field ids differ from the C1 logical ids.
  const { context: bindCtx, calls: bindCalls } = createContext({ sheetExists: true })
  const bound = await ensureStockPreparationCanonicalTarget({
    context: bindCtx,
    projectId: 'tenant:proj',
    permission: 'admin',
  })
  assert.equal(bound.ready, true)
  assert.equal(bound.mode, 'canonical_existing')
  assert.deepEqual(bound.target, {
    sheetId: 'sheet_private_stock_target',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    keyField: 'idempotencyKey',
    fieldIdMap: RESOLVED_FIELD_ID_MAP,
  })
  assert.equal(bound.evidence.mode, 'canonical_existing')
  assert.deepEqual(bound.evidence.missingFields, [])
  assert.equal(bound.evidence.target.fieldIdMapEmpty, false)
  assert.equal(bindCalls.findObjectSheet.length, 1)
  // The bind path probes field EXISTENCE against meta_fields, not the compute-only derivation.
  // `resolveFieldIds` never omits a field, so a drifted sheet used to bind `ready` with a fieldIdMap
  // naming columns that do not exist; `resolveExistingObjectFieldIds` is what makes the verdict real.
  assert.equal(bindCalls.resolveExistingObjectFieldIds.length, 1, 'bind probes DB-backed field existence')
  assert.equal(bindCalls.resolveFieldIds.length, 0, 'bind no longer trusts the compute-only derivation')
  assert.equal(bound.evidence.fieldExistenceMode, 'db', 'evidence names the probe that answered')
  assert.equal(bindCalls.ensureObject.length, 0, 'existing target bind does not create/repair')
  assert.equal(bindCalls.records.length, 0, 'bind path never uses records API')

  // Existing but incomplete canonical object fails closed and does not repair
  // in place; that could silently retrofit a legacy/business table.
  const { context: incompleteCtx, calls: incompleteCalls } = createContext({
    sheetExists: true,
    missingFields: ['path', 'lastPlmRefreshDecision'],
  })
  const incompleteInspect = await inspectStockPreparationCanonicalTarget({
    context: incompleteCtx,
    projectId: 'tenant:proj',
    permission: 'admin',
  })
  assert.equal(incompleteInspect.ready, false)
  assert.equal(incompleteInspect.mode, 'canonical_incomplete')
  assert.deepEqual(incompleteInspect.evidence.missingFields, ['path', 'lastPlmRefreshDecision'])
  const incompleteError = await rejectsWith(
    () => ensureStockPreparationCanonicalTarget({
      context: incompleteCtx,
      projectId: 'tenant:proj',
      permission: 'admin',
    }),
    'TARGET_SCHEMA_INCOMPLETE',
  )
  assert.deepEqual(incompleteError.details.missingFields, ['path', 'lastPlmRefreshDecision'])
  assert.equal(incompleteError.details.targetObjectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
  assert.equal(JSON.stringify(incompleteError.details).includes('sheet_private_stock_target'), false, 'error is values-free')
  assert.equal(incompleteCalls.ensureObject.length, 0, 'incomplete existing target is not repaired in place')

  // REGRESSION (2026-09-04, 222 rehearsal): a host whose ONLY field resolver is the compute-only
  // derivation cannot see drift at all. `resolveFieldIds` returns an id for every requested field,
  // so `missingLogicalFields` came back empty and a sheet provisioned by an older template bound
  // `ready` with a fieldIdMap naming columns that do not exist in meta_fields — the drift only
  // surfaced later as an opaque host `Unknown fieldId` when a write addressed one of them.
  // Two things are pinned here: (1) with the DB-backed probe the SAME drifted sheet is now caught at
  // inspect time and names the missing fields, and (2) a host without that probe still answers
  // (no hard dependency) but must SAY the verdict came from the compute-only derivation, so a
  // deployment can tell "no drift" apart from "cannot see drift".
  const computedOnlyCtx = createContext({ sheetExists: true, missingFields: ['path', 'makeOrBuy'] })
  delete computedOnlyCtx.context.api.multitable.provisioning.resolveExistingObjectFieldIds
  const computedOnlyInspect = await inspectStockPreparationCanonicalTarget({
    context: computedOnlyCtx.context,
    projectId: 'tenant:proj',
    permission: 'admin',
  })
  assert.equal(
    computedOnlyInspect.evidence.fieldExistenceMode,
    'computed',
    'a host without the DB-backed probe still answers, and says which probe answered',
  )

  // A host that refuses the scoped read (the object was never claimed in the plugin object
  // registry — a hand-made or dump-restored sheet) must DEGRADE to today's behaviour, not turn a
  // working readiness read into an opaque failure. The distinct mode keeps that observable.
  const scopeDeniedCtx = createContext({ sheetExists: true })
  scopeDeniedCtx.context.api.multitable.provisioning.resolveExistingObjectFieldIds = async () => {
    const error = new Error('Plugin cannot claim multitable object; owned by unclaimed')
    error.name = 'MultitableObjectScopeError'
    error.code = 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN'
    throw error
  }
  const scopeDeniedInspect = await inspectStockPreparationCanonicalTarget({
    context: scopeDeniedCtx.context,
    projectId: 'tenant:proj',
    permission: 'admin',
  })
  assert.equal(scopeDeniedInspect.ready, true, 'a scope refusal degrades to the compute-only probe')
  assert.equal(scopeDeniedInspect.evidence.fieldExistenceMode, 'computed_scope_unavailable')

  // A non-scope failure from the DB probe is NOT swallowed — degrading on every error would hide
  // real host faults behind a verdict that cannot see drift.
  const probeBrokenCtx = createContext({ sheetExists: true })
  probeBrokenCtx.context.api.multitable.provisioning.resolveExistingObjectFieldIds = async () => {
    throw new Error('connection terminated unexpectedly')
  }
  await assert.rejects(
    () => inspectStockPreparationCanonicalTarget({
      context: probeBrokenCtx.context,
      projectId: 'tenant:proj',
      permission: 'admin',
    }),
    /connection terminated unexpectedly/,
    'only an object-scope refusal degrades; other probe failures propagate',
  )
  assert.equal(incompleteCalls.records.length, 0, 'incomplete path never uses records API')

  // Missing target creates metadata only, then verifies logical fields by
  // resolveFieldIds instead of trusting ensureObject's physical field ids.
  const { context: createCtx, calls: createCalls } = createContext({ sheetExists: false })
  const created = await ensureStockPreparationCanonicalTarget({
    context: createCtx,
    projectId: 'tenant:proj',
    baseId: 'base_stock',
    permission: 'admin',
  })
  assert.equal(created.ready, true)
  assert.equal(created.mode, 'canonical_create')
  assert.deepEqual(created.target, {
    sheetId: 'sheet_created_stock_target',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    keyField: 'idempotencyKey',
    fieldIdMap: RESOLVED_FIELD_ID_MAP,
  })
  assert.equal(created.evidence.target.fieldIdMapEmpty, false)
  assert.equal(createCalls.findObjectSheet.length, 1)
  assert.equal(createCalls.ensureObject.length, 1)
  assert.equal(createCalls.ensureObject[0].descriptor.id, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
  assert.deepEqual(createCalls.ensureObject[0].descriptor.fields.map((field) => field.id), LOGICAL_FIELD_IDS)
  assert.equal(createCalls.resolveFieldIds.length, 1, 'create path verifies logical ids after ensureObject')
  assert.equal(createCalls.records.length, 0, 'create path never uses records API')
  assert.equal(JSON.stringify(created.evidence).includes('sheet_created_stock_target'), false, 'issue evidence hides sheet id')

  // Bad create result still fails closed after the post-create logical-id
  // verification.
  const { context: badCreateCtx, calls: badCreateCalls } = createContext({ sheetExists: false })
  const originalEnsure = badCreateCtx.api.multitable.provisioning.ensureObject
  badCreateCtx.api.multitable.provisioning.ensureObject = async (input) => {
    const result = await originalEnsure(input)
    badCreateCtx.api.multitable.provisioning.resolveFieldIds = async (resolveInput) => {
      badCreateCalls.resolveFieldIds.push(resolveInput)
      const out = {}
      for (const fieldId of resolveInput.fieldIds || []) {
        if (fieldId !== 'path') out[fieldId] = `fld_${fieldId}`
      }
      return out
    }
    return result
  }
  const badCreateError = await rejectsWith(
    () => ensureStockPreparationCanonicalTarget({
      context: badCreateCtx,
      projectId: 'tenant:proj',
      permission: 'admin',
    }),
    'TARGET_SCHEMA_INCOMPLETE',
  )
  assert.deepEqual(badCreateError.details.missingFields, ['path'])
  assert.equal(badCreateCalls.records.length, 0, 'failed create verification never uses records API')

  const sandboxObjectId = 'plm_stock_preparation_sandbox_validation'
  const sandboxDescriptor = buildStockPreparationTargetDescriptor({
    template: { ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, objectId: sandboxObjectId, label: 'Sandbox Stock Preparation' },
    description: 'Sandbox target descriptor',
  })
  assert.equal(sandboxDescriptor.id, sandboxObjectId)
  assert.equal(sandboxDescriptor.name, 'Sandbox Stock Preparation')
  assert.equal(sandboxDescriptor.description, 'Sandbox target descriptor')
  assert.deepEqual(sandboxDescriptor.fields.map((field) => field.id), LOGICAL_FIELD_IDS)

  const { context: sandboxRejectCtx, calls: sandboxRejectCalls } = createContext({ sheetExists: false })
  const canonicalSandboxError = await rejectsWith(
    () => ensureStockPreparationSandboxTarget({
      context: sandboxRejectCtx,
      projectId: 'tenant:proj',
      objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
      permission: 'admin',
    }),
    'TARGET_SANDBOX_OBJECT_ID_INVALID',
  )
  assert.deepEqual(canonicalSandboxError.details, { reason: 'prod_canonical' })
  assert.equal(sandboxRejectCalls.findObjectSheet.length, 0, 'canonical objectId is rejected before provisioning reads')
  assert.equal(sandboxRejectCalls.ensureObject.length, 0, 'canonical objectId is never provisioned as sandbox')

  const { context: nonSandboxRejectCtx, calls: nonSandboxRejectCalls } = createContext({ sheetExists: false })
  const nonSandboxError = await rejectsWith(
    () => ensureStockPreparationSandboxTarget({
      context: nonSandboxRejectCtx,
      projectId: 'tenant:proj',
      objectId: 'customer_real_table',
      permission: 'admin',
    }),
    'TARGET_SANDBOX_OBJECT_ID_INVALID',
  )
  // details is a CONTRACT surface, so this stays a deepEqual: a field added here is an intended
  // change to what callers receive, not an incidental one. requiredNamespace is what makes the
  // refusal actionable -- an operator gets the accepted namespace from the response itself.
  assert.deepEqual(nonSandboxError.details, {
    reason: 'not_sandbox_namespace',
    requiredNamespace: 'plm_stock_preparation_sandbox',
  })
  assert.equal(nonSandboxRejectCalls.findObjectSheet.length, 0, 'non-sandbox objectId is rejected before provisioning reads')
  assert.equal(nonSandboxRejectCalls.ensureObject.length, 0, 'non-sandbox objectId is never provisioned as sandbox')

  const { context: sandboxCreateCtx, calls: sandboxCreateCalls } = createContext({ sheetExists: false })
  const sandboxCreated = await ensureStockPreparationSandboxTarget({
    context: sandboxCreateCtx,
    projectId: 'tenant:proj',
    baseId: 'base_sandbox',
    objectId: sandboxObjectId,
    permission: 'admin',
  })
  assert.equal(sandboxCreated.ready, true)
  assert.equal(sandboxCreated.mode, 'sandbox_create')
  assert.equal(sandboxCreated.target.objectId, sandboxObjectId, 'internal binding keeps the real sandbox object id')
  assert.equal(sandboxCreated.target.sheetId, 'sheet_created_stock_target')
  assert.equal(sandboxCreated.evidence.fieldMapMode, SANDBOX_FIELD_MAP_MODE)
  assert.equal(sandboxCreated.evidence.target.fieldIdMapEmpty, false)
  assert.ok(sandboxCreated.evidence.objectIdHash, 'sandbox evidence carries a deterministic object hash')
  assert.equal(JSON.stringify(sandboxCreated.evidence).includes(sandboxObjectId), false, 'sandbox evidence hides object id')
  assert.equal(JSON.stringify(sandboxCreated.evidence).includes('sheet_created_stock_target'), false, 'sandbox evidence hides sheet id')
  assert.equal(sandboxCreateCalls.findObjectSheet[0].objectId, sandboxObjectId)
  assert.equal(sandboxCreateCalls.ensureObject.length, 1)
  assert.equal(sandboxCreateCalls.ensureObject[0].descriptor.id, sandboxObjectId)
  assert.equal(sandboxCreateCalls.records.length, 0, 'sandbox create path never uses records API')

  const { context: sandboxExistingCtx, calls: sandboxExistingCalls } = createContext({ sheetExists: true })
  const sandboxExisting = await inspectStockPreparationSandboxTarget({
    context: sandboxExistingCtx,
    projectId: 'tenant:proj',
    objectId: sandboxObjectId,
    permission: 'admin',
  })
  assert.equal(sandboxExisting.ready, true)
  assert.equal(sandboxExisting.mode, 'sandbox_existing')
  assert.equal(sandboxExisting.evidence.fieldMapMode, SANDBOX_FIELD_MAP_MODE)
  assert.equal(sandboxExisting.evidence.target.fieldIdMapEmpty, false)
  assert.equal(JSON.stringify(sandboxExisting.evidence).includes(sandboxObjectId), false, 'sandbox existing evidence hides object id')
  assert.equal(sandboxExistingCalls.findObjectSheet[0].objectId, sandboxObjectId)
  assert.equal(sandboxExistingCalls.ensureObject.length, 0, 'sandbox existing path does not create')

  const { context: sandboxIncompleteCtx, calls: sandboxIncompleteCalls } = createContext({
    sheetExists: true,
    missingFields: ['rawQuantity'],
  })
  const sandboxIncompleteError = await rejectsWith(
    () => ensureStockPreparationSandboxTarget({
      context: sandboxIncompleteCtx,
      projectId: 'tenant:proj',
      objectId: sandboxObjectId,
      permission: 'admin',
    }),
    'TARGET_SCHEMA_INCOMPLETE',
  )
  assert.deepEqual(sandboxIncompleteError.details.missingFields, ['rawQuantity'])
  assert.equal(sandboxIncompleteError.details.fieldMapMode, SANDBOX_FIELD_MAP_MODE)
  assert.ok(sandboxIncompleteError.details.targetObjectIdHash)
  assert.equal(JSON.stringify(sandboxIncompleteError.details).includes(sandboxObjectId), false, 'sandbox incomplete error hides object id')
  assert.equal(sandboxIncompleteCalls.ensureObject.length, 0, 'incomplete sandbox target is not repaired in place')
  assert.equal(sandboxIncompleteCalls.records.length, 0, 'incomplete sandbox path never uses records API')

  // ---- W2 canonical repair (main table has the 8 human fields — the reject guard is load-bearing here) ----
  {
    // (a) repair adds a missing plm_system field on the existing canonical target.
    const { context, calls } = createContext({ sheetExists: true, missingFields: ['path'] })
    const repaired = await repairStockPreparationCanonicalTarget({ context, projectId: 'proj_x', permission: 'admin' })
    assert.equal(repaired.mode, 'canonical_repaired')
    assert.equal(repaired.evidence.addedFieldCount, 1)
    assert.equal((calls.ensureMissingObjectFields || []).length, 1, 'canonical repair uses the additive-only primitive')

    // (a2) EXISTING INSTALLS HEAL — the migration answer for 备料主表's three new PLM columns
    //      (parentComponentCode / parentComponentName / componentSpec, 父组件图号 / 父组件名称 /
    //      规格). A sheet provisioned before they existed is simply missing three plm_system
    //      columns, which is precisely what this additive verb is for: no migration, no DDL script,
    //      no touch to any pre-existing column (assertNoExistingFieldMutated proves that below).
    const healCtx = createContext({
      sheetExists: true,
      missingFields: ['parentComponentCode', 'parentComponentName', 'componentSpec'],
    })
    const healed = await repairStockPreparationCanonicalTarget({ context: healCtx.context, projectId: 'proj_x', permission: 'admin' })
    assert.equal(healed.ready, true)
    assert.equal(healed.mode, 'canonical_repaired')
    assert.equal(healed.evidence.addedFieldCount, 3, 'exactly the three new columns are added')
    assert.equal(healCtx.calls.ensureMissingObjectFields.length, 1, 'one additive write')
    assert.deepEqual(
      healCtx.calls.ensureMissingObjectFields[0].fields.map((field) => field.id).sort(),
      ['componentSpec', 'parentComponentCode', 'parentComponentName'],
      'ONLY the missing columns are submitted — no pre-existing column is in the write at all',
    )
    // Idempotent: a second repair on the healed install writes nothing.
    const alreadyCtx = createContext({ sheetExists: true, missingFields: [] })
    const already = await repairStockPreparationCanonicalTarget({ context: alreadyCtx.context, projectId: 'proj_x', permission: 'admin' })
    assert.equal(already.mode, 'canonical_already_ready')
    assert.equal(already.evidence.addedFieldCount, 0)

    // (b) THE HEAL PATH FOR THE HUMAN BAND. A human column that the frozen template and
    //     the design-gated HUMAN_PRESERVED_FIELD_IDS whitelist AGREE about is healed
    //     additively. Without this an existing install could never gain the five columns
    //     added in this change: `ensure` throws TARGET_SCHEMA_INCOMPLETE the moment the
    //     template outgrows the sheet, and repair is the only additive verb there is.
    const humanCtx = createContext({ sheetExists: true, missingFields: ['procurementDone'] })
    const humanRepaired = await repairStockPreparationCanonicalTarget({
      context: humanCtx.context, projectId: 'proj_x', permission: 'admin',
    })
    assert.equal(humanRepaired.mode, 'canonical_repaired', 'a whitelisted human column heals')
    assert.equal(humanRepaired.evidence.addedFieldCount, 1)
    assert.equal(
      (humanCtx.calls.ensureMissingObjectFields || []).length, 1,
      'the human heal still goes through the additive-only primitive',
    )

    // (b2) THE BACK DOOR IS STILL SHUT -- the RED witness for the narrowed rule. The
    //      predicate is exercised directly because the loosening lives THERE; going
    //      through repair could only ever present ids the frozen template already
    //      agrees with, so it cannot reach three of these four cases at all.
    //
    //      human in the template but NOT in the whitelist => refused. This is precisely
    //      the "grow the human whitelist through the repair back door" attempt that the
    //      original unconditional guard existed to stop, and it still fails closed.
    const backDoor = throwsWith(() => assertRepairableFieldOwnership({
      fieldId: 'smuggledHumanColumn',
      ownership: 'human_preserved',
      isWhitelisted: false,
      templateFieldIds: ['projectNo'],
      objectId: 'plm_stock_preparation_main',
    }))
    assert.equal(backDoor.code, 'REPAIR_HUMAN_FIELD_FORBIDDEN')
    assert.match(backDoor.message, /design gate/)

    //      DRIFT, the reverse disagreement: whitelisted but not human in the template.
    //      Guessing which authority is right is how a load-bearing wall gets holed.
    const drift = throwsWith(() => assertRepairableFieldOwnership({
      fieldId: 'notes',
      ownership: 'plm_system',
      isWhitelisted: true,
      templateFieldIds: ['projectNo'],
      objectId: 'plm_stock_preparation_main',
    }))
    assert.equal(drift.code, 'REPAIR_HUMAN_FIELD_FORBIDDEN')

    //      AGREEMENT in both directions is admitted, and the plm_system band is
    //      completely unchanged by the narrowing.
    assert.doesNotThrow(() => assertRepairableFieldOwnership({
      fieldId: 'procurementDone', ownership: 'human_preserved', isWhitelisted: true,
      templateFieldIds: ['projectNo'], objectId: 'plm_stock_preparation_main',
    }), 'template + whitelist agree => healable')
    assert.doesNotThrow(() => assertRepairableFieldOwnership({
      fieldId: 'path', ownership: 'plm_system', isWhitelisted: false,
      templateFieldIds: ['projectNo'], objectId: 'plm_stock_preparation_main',
    }), 'the plm_system band is unaffected')

    //      A non-human, non-plm id must still be a valid tenant `ext_` id -- the
    //      namespace check the narrowing must not have bypassed.
    assert.ok(
      throwsWith(() => assertRepairableFieldOwnership({
        fieldId: 'notAnExtensionId', ownership: 'tenant_extension', isWhitelisted: false,
        templateFieldIds: ['projectNo'], objectId: 'plm_stock_preparation_main',
      })),
      'a bare id is still rejected by the extension-namespace check',
    )

    //      STRUCTURAL: for the frozen template the two authorities agree EXACTLY, so
    //      the refusal branches above are unreachable through the public repair verb.
    //      That is the guarantee; the direct witnesses prove the rule behind it.
    assert.deepEqual(
      STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields
        .filter((f) => f.ownership === 'human_preserved').map((f) => f.id).sort(),
      [...HUMAN_PRESERVED_FIELD_IDS].sort(),
      'frozen template human band === the design-gated whitelist',
    )

    // (b2) POST-WRITE completeness re-verify: if the additive write does NOT actually
    //      leave the schema complete (a field still missing on re-read), repair must
    //      FAIL CLOSED — never report ready:true unproven (review P1).
    const incompleteCtx = createContext({ sheetExists: true, missingFields: ['path'] })
    // Neuter the additive write so 'path' stays missing after "repair".
    incompleteCtx.context.api.multitable.provisioning.ensureMissingObjectFields = async () => ({ addedFieldIds: [], skippedExistingFieldIds: [] })
    let incompleteErr = null
    try {
      await repairStockPreparationCanonicalTarget({ context: incompleteCtx.context, projectId: 'proj_x', permission: 'admin' })
    } catch (error) {
      incompleteErr = error
    }
    assert.ok(incompleteErr instanceof StockPreparationTargetProvisioningError, 'incomplete repair fails closed')
    assert.equal(incompleteErr.code, 'CANONICAL_REPAIR_INCOMPLETE')

    // (b3) REPAIR_MUTATED_EXISTING_FIELD: if the additive write mutates an existing
    //      field's content (name/type/property), the before/after snapshot must catch it.
    const mutateCtx = createContext({ sheetExists: true, missingFields: ['path'] })
    const prov = mutateCtx.context.api.multitable.provisioning
    let readCount = 0
    prov.readObjectFieldsContent = async (input) => {
      // First (before) read: baseline; second (after) read: an existing field mutated.
      readCount += 1
      const out = {}
      for (const fieldId of input.fieldIds || []) {
        out[fieldId] = { name: fieldId, type: readCount >= 2 ? 'number' : 'text', property: {} }
      }
      return out
    }
    let mutatedErr = null
    try {
      await repairStockPreparationCanonicalTarget({ context: mutateCtx.context, projectId: 'proj_x', permission: 'admin' })
    } catch (error) {
      mutatedErr = error
    }
    assert.ok(mutatedErr instanceof StockPreparationTargetProvisioningError, 'mutated existing field fails closed')
    assert.equal(mutatedErr.code, 'REPAIR_MUTATED_EXISTING_FIELD')

    // (b4) round-5 review P2: a field from THIS round's missing set that returns as
    //      skipped-existing = a concurrent writer inserted an UNVERIFIED row → fail closed
    //      (id-exists ≠ shape-correct). Canonical path must discriminate this too.
    const raceCtx = createContext({ sheetExists: true, missingFields: ['path'] })
    raceCtx.context.api.multitable.provisioning.ensureMissingObjectFields = async (input) => ({
      addedFieldIds: [],
      skippedExistingFieldIds: (input.fields || []).map((f) => `fld_${f.id}`),
    })
    let raceErr = null
    try {
      await repairStockPreparationCanonicalTarget({ context: raceCtx.context, projectId: 'proj_x', permission: 'admin' })
    } catch (error) {
      raceErr = error
    }
    assert.ok(raceErr instanceof StockPreparationTargetProvisioningError, 'concurrent skipped field fails closed')
    assert.equal(raceErr.code, 'REPAIR_CONCURRENT_FIELD_APPEARED')

    // (b5) round-5 review P3: `order` is part of the snapshotted column identity — an
    //      order-ONLY change across the additive write must ALSO fail closed (landed pin).
    const orderCtx = createContext({ sheetExists: true, missingFields: ['path'] })
    let orderRead = 0
    orderCtx.context.api.multitable.provisioning.readObjectFieldsContent = async (input) => {
      orderRead += 1
      const out = {}
      for (const fieldId of input.fieldIds || []) out[fieldId] = { name: fieldId, type: 'text', property: {}, order: orderRead >= 2 ? 99 : 1 }
      return out
    }
    let orderErr = null
    try {
      await repairStockPreparationCanonicalTarget({ context: orderCtx.context, projectId: 'proj_x', permission: 'admin' })
    } catch (error) {
      orderErr = error
    }
    assert.ok(orderErr instanceof StockPreparationTargetProvisioningError, 'order-only change fails closed')
    assert.equal(orderErr.code, 'REPAIR_MUTATED_EXISTING_FIELD')

    // (c) absent target fails closed.
    const absentCtx = createContext({ sheetExists: false })
    let absentErr = null
    try {
      await repairStockPreparationCanonicalTarget({ context: absentCtx.context, projectId: 'proj_x', permission: 'admin' })
    } catch (error) {
      absentErr = error
    }
    assert.ok(absentErr instanceof StockPreparationTargetProvisioningError && absentErr.code === 'CANONICAL_REPAIR_TARGET_ABSENT')

    // (d) non-admin rejected before provisioning access.
    const rbacCtx = createContext({ sheetExists: true, missingFields: ['path'] })
    let deniedErr = null
    try {
      await repairStockPreparationCanonicalTarget({ context: rbacCtx.context, projectId: 'proj_x', permission: 'write' })
    } catch (error) {
      deniedErr = error
    }
    assert.ok(deniedErr, 'non-admin canonical repair rejected')
    assert.equal(rbacCtx.calls.findObjectSheet.length, 0, 'admin gate precedes provisioning reads')

    // (e) API contract pin (round-5 review P3): a provisioning WITHOUT the atomic runner
    //     runObjectFieldsRepairTransaction must fail closed with a clean 503, never reach
    //     the repair body and call `undefined(...)`. Guards the getCanonicalRepairApi contract.
    const noRunner = createContext({ sheetExists: true, missingFields: ['path'] })
    delete noRunner.context.api.multitable.provisioning.runObjectFieldsRepairTransaction
    let unavailErr = null
    try {
      await repairStockPreparationCanonicalTarget({ context: noRunner.context, projectId: 'proj_x', permission: 'admin' })
    } catch (error) {
      unavailErr = error
    }
    assert.ok(unavailErr instanceof StockPreparationTargetProvisioningError, 'missing atomic runner fails closed')
    assert.equal(unavailErr.code, 'CANONICAL_REPAIR_API_UNAVAILABLE')
    assert.equal(noRunner.calls.findObjectSheet.length, 0, 'API check precedes any provisioning read')
  }

  console.log('stock-preparation-target-provisioning.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-target-provisioning.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
