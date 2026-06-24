'use strict'

// #2253 C1b-1 target provisioning helper tests.
// Locks the latent backend helper: admin-only, metadata-only, canonical C1
// manifest as source of truth, no PLM read, no records API, no K3.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
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

async function main() {
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
  assert.equal(bindCalls.resolveFieldIds.length, 1)
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
  assert.deepEqual(nonSandboxError.details, { reason: 'not_sandbox_namespace' })
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

  console.log('stock-preparation-target-provisioning.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-target-provisioning.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
