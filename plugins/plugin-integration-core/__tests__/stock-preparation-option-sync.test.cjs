'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  StockPreparationOptionSyncError,
  optionSetsFromInput,
  syncStockPreparationOptions,
  syncStockPreparationSandboxOptions,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-option-sync.cjs'))

const FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const RESOLVED_FIELD_IDS = Object.fromEntries(FIELD_IDS.map((fieldId) => [fieldId, `fld_${fieldId}`]))

function createContext({ ready = true, failPatch = false } = {}) {
  const calls = {
    findObjectSheet: [],
    resolveFieldIds: [],
    ensureObject: [],
    patchObjectFieldProperty: [],
  }
  const provisioning = {
    async findObjectSheet(input) {
      calls.findObjectSheet.push(input)
      return ready
        ? {
            id: 'sheet_stock_preparation',
            baseId: 'base_stock',
            name: 'PLM Stock Preparation Main',
            description: null,
          }
        : null
    },
    async resolveFieldIds(input) {
      calls.resolveFieldIds.push(input)
      return ready ? RESOLVED_FIELD_IDS : {}
    },
    async ensureObject(input) {
      calls.ensureObject.push(input)
      throw new Error('ensureObject must not be used by C6 option sync')
    },
    async patchObjectFieldProperty(input) {
      calls.patchObjectFieldProperty.push(JSON.parse(JSON.stringify(input)))
      if (failPatch) {
        const error = new Error('field deleted while syncing plate')
        error.code = 'FIELD_GONE'
        throw error
      }
      return {
        id: `fld_${input.fieldId}`,
        sheetId: 'sheet_stock_preparation',
        name: input.fieldId,
        type: 'select',
        property: input.propertyPatch,
        order: calls.patchObjectFieldProperty.length,
      }
    },
  }
  return {
    context: {
      api: {
        multitable: {
          provisioning,
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
  assert.ok(err instanceof StockPreparationOptionSyncError, `expected option sync error ${code}`)
  assert.equal(err.code, code)
  return err
}

async function main() {
  const parsed = optionSetsFromInput({
    material_type: [
      {
        value: 'plate',
        label: 'Plate',
        color: '#336699',
        actionBindings: [{
          actionId: PLM_STOCK_PREPARATION_ACTION_ID,
          parameterBindings: { projectNo: 'projectNo' },
        }],
      },
    ],
  })
  assert.equal(parsed.material_type.options[0].value, 'plate')
  assert.equal(parsed.material_type.options[0].label, 'Plate')
  assert.equal(parsed.material_type.options[0].color, '#336699')
  assert.equal(parsed.material_type.actionBindings[0].actionId, PLM_STOCK_PREPARATION_ACTION_ID)
  assert.equal(parsed.material_type.actionBindings[0].kind, 'table_action')
  assert.deepEqual(parsed.material_type.actionBindings[0].parameterBindings, { projectNo: 'projectNo' })

  await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext().context,
      projectId: 'tenant_1:integration-core',
      permission: 'write',
      optionSets: { material_type: [{ value: 'plate' }] },
    }),
    'OPTION_SYNC_PERMISSION_DENIED',
  )

  const { context, calls } = createContext({ ready: true })
  const result = await syncStockPreparationOptions({
    context,
    projectId: 'tenant_1:integration-core',
    permission: 'admin',
    optionSets: {
      material_type: [
        {
          value: 'plate',
          label: 'Plate',
          actionBindings: [{ predefinedActionId: PLM_STOCK_PREPARATION_ACTION_ID }],
        },
        { value: 'bar', label: 'Bar', enabled: false },
      ],
      blank_type: [{ value: 'casting', label: 'Casting' }],
      stock_preparation_status: [{ value: 'pending', label: 'Pending' }],
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.target.objectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
  assert.equal(calls.findObjectSheet.length, 1)
  assert.equal(calls.resolveFieldIds.length, 1)
  assert.equal(calls.ensureObject.length, 0)
  assert.equal(calls.patchObjectFieldProperty.length, 4, 'contract decision + three config_info fields sync')

  const materialPatch = calls.patchObjectFieldProperty.find((call) => call.fieldId === 'materialType')
  assert.ok(materialPatch, 'materialType field was patched')
  assert.deepEqual(materialPatch.propertyPatch.options, [
    { value: 'plate', label: 'Plate' },
    { value: 'bar', label: 'Bar', disabled: true },
  ])
  assert.equal(materialPatch.propertyPatch.stockPreparation.optionSync.optionCount, 2)
  assert.equal(materialPatch.propertyPatch.stockPreparation.optionSync.actionBindingCount, 1)
  assert.equal(
    materialPatch.propertyPatch.stockPreparation.optionActionBindings[0].actionId,
    PLM_STOCK_PREPARATION_ACTION_ID,
  )

  const decisionPatch = calls.patchObjectFieldProperty.find((call) => call.fieldId === 'lastPlmRefreshDecision')
  assert.ok(decisionPatch, 'contract decision field syncs from built-in option set')
  assert.equal(decisionPatch.propertyPatch.stockPreparation.optionSync.sourceType, 'contract')
  assert.equal(decisionPatch.propertyPatch.options.length, 5)

  const evidenceText = JSON.stringify(result.evidence)
  assert.ok(evidenceText.includes('material_type'), 'evidence includes source key')
  assert.ok(!evidenceText.includes('plate'), 'evidence must not include option values')
  assert.ok(!evidenceText.includes('Casting'), 'evidence must not include option labels')
  assert.ok(!evidenceText.includes('sheet_stock_preparation'), 'evidence must not include sheet id')

  const sandboxObjectId = 'plm_stock_preparation_sandbox_validation'
  const { context: sandboxContext, calls: sandboxCalls } = createContext({ ready: true })
  const sandboxResult = await syncStockPreparationSandboxOptions({
    context: sandboxContext,
    projectId: 'tenant_1:integration-core',
    objectId: sandboxObjectId,
    permission: 'admin',
    optionSets: {
      material_type: [{ value: 'plate', label: 'Plate' }],
      blank_type: [{ value: 'casting', label: 'Casting' }],
      stock_preparation_status: [{ value: 'pending', label: 'Pending' }],
    },
  })
  assert.equal(sandboxResult.ok, true)
  assert.ok(sandboxResult.target.objectIdHash, 'sandbox option sync returns only an object hash')
  assert.equal(Object.prototype.hasOwnProperty.call(sandboxResult.target, 'objectId'), false)
  assert.equal(sandboxCalls.patchObjectFieldProperty.length, 4, 'sandbox sync seeds contract + three config_info fields')
  assert.ok(
    sandboxCalls.patchObjectFieldProperty.every((call) => call.objectId === sandboxObjectId),
    'sandbox option sync patches only the sandbox object id',
  )
  const sandboxEvidence = JSON.stringify(sandboxResult.evidence)
  assert.equal(sandboxEvidence.includes(sandboxObjectId), false, 'sandbox option evidence hides object id')
  assert.equal(sandboxEvidence.includes('sheet_stock_preparation'), false, 'sandbox option evidence hides sheet id')
  assert.equal(sandboxEvidence.includes('plate'), false, 'sandbox option evidence hides option values')
  assert.equal(sandboxEvidence.includes('Casting'), false, 'sandbox option evidence hides option labels')

  const { context: sandboxDefaultContext, calls: sandboxDefaultCalls } = createContext({ ready: true })
  const sandboxDefaultResult = await syncStockPreparationSandboxOptions({
    context: sandboxDefaultContext,
    projectId: 'tenant_1:integration-core',
    objectId: sandboxObjectId,
    permission: 'admin',
  })
  assert.equal(sandboxDefaultResult.ok, true)
  assert.equal(
    sandboxDefaultCalls.patchObjectFieldProperty.length,
    1,
    'sandbox sync without config_info still seeds the contract decision options only',
  )
  assert.equal(sandboxDefaultCalls.patchObjectFieldProperty[0].fieldId, 'lastPlmRefreshDecision')
  assert.equal(sandboxDefaultResult.evidence.skipped.length, 3, 'sandbox sync records config_info fields as skipped when not supplied')
  assert.ok(
    sandboxDefaultResult.evidence.skipped.every((entry) => entry.reason === 'config_info_not_supplied'),
    'sandbox sync skip evidence is reason/count metadata only',
  )

  const notReady = createContext({ ready: false })
  await rejectsWith(
    () => syncStockPreparationOptions({
      context: notReady.context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { material_type: [{ value: 'plate' }] },
    }),
    'OPTION_SYNC_TARGET_NOT_READY',
  )
  assert.equal(notReady.calls.patchObjectFieldProperty.length, 0, 'not-ready target does not patch fields')

  await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext().context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { material_type: [{ value: 'plate' }, { value: 'plate' }] },
    }),
    'OPTION_SYNC_AMBIGUOUS_OPTION',
  )

  await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext().context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { materiel_type_typo: [{ value: 'plate' }] },
    }),
    'OPTION_SYNC_UNKNOWN_SOURCE',
  )

  await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext().context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { material_type: [{ value: 'plate', order: '1' }] },
    }),
    'OPTION_SYNC_CONFIG_INVALID',
  )

  const failedPatch = await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext({ failPatch: true }).context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { material_type: [{ value: 'plate' }] },
    }),
    'OPTION_SYNC_FIELD_PATCH_FAILED',
  )
  assert.equal(failedPatch.status, 422)
  assert.equal(JSON.stringify(failedPatch.details).includes('plate'), false, 'patch failure details are values-free')

  await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext().context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { material_type: [{ value: '[redacted-secret-id]' }] },
    }),
    'OPTION_SYNC_CONFIG_INVALID',
  )

  const executableKeyContext = createContext()
  const executableKeyError = await rejectsWith(
    () => syncStockPreparationSandboxOptions({
      context: executableKeyContext.context,
      projectId: 'tenant_1:integration-core',
      objectId: sandboxObjectId,
      permission: 'admin',
      optionSets: {
        material_type: [{
          value: 'plate',
          rawSQL: 'select * from private_table',
          functionBody: 'return 1',
          payloadTemplate: { value: 'hidden' },
        }],
      },
    }),
    'OPTION_SYNC_EXECUTABLE_REJECTED',
  )
  assert.equal(executableKeyContext.calls.patchObjectFieldProperty.length, 0, 'executable-like option keys fail before patching metadata')
  assert.equal(JSON.stringify(executableKeyError.details).includes('private_table'), false, 'executable-key error details hide raw values')

  await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext().context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { material_type: [{ value: 'plate', actionBindings: [{ actionId: 'stock.custom.run-anything' }] }] },
    }),
    'OPTION_SYNC_ACTION_NOT_ALLOWED',
  )

  await rejectsWith(
    () => syncStockPreparationOptions({
      context: createContext().context,
      projectId: 'tenant_1:integration-core',
      permission: 'admin',
      optionSets: { material_type: [{ value: 'plate', actionBindings: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID, sql: 'select 1' }] }] },
    }),
    'OPTION_SYNC_EXECUTABLE_REJECTED',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
