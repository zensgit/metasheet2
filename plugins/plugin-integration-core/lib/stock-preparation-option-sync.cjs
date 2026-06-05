'use strict'

// #2253 C6: stock-preparation select/dropdown option sync + safe option action
// bindings. This writes only target field metadata through the scoped
// multitable provisioning API. It never writes business rows, never reads PLM,
// never calls K3, and never accepts SQL/JS/function bodies from the browser.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  inspectStockPreparationCanonicalTarget,
} = require('./stock-preparation-target-provisioning.cjs')
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require('./stock-preparation-table-actions.cjs')

const REQUIRED_PERMISSION = 'admin'
const MAX_OPTIONS_PER_FIELD = 200

const FORBIDDEN_EXECUTABLE_KEYS = Object.freeze([
  'body',
  'command',
  'endpoint',
  'function',
  'handler',
  'js',
  'payload',
  'query',
  'rawSql',
  'script',
  'sql',
  'url',
])

const DEFAULT_CONTRACT_OPTION_SETS = Object.freeze({
  plm_stock_preparation_decision_v1: Object.freeze([
    Object.freeze({ value: 'add', label: 'Add' }),
    Object.freeze({ value: 'update', label: 'Update' }),
    Object.freeze({ value: 'skip', label: 'Skip' }),
    Object.freeze({ value: 'inactive', label: 'Inactive' }),
    Object.freeze({ value: 'manual_confirm', label: 'Manual confirm' }),
  ]),
})

const PREDEFINED_OPTION_ACTIONS = Object.freeze({
  [PLM_STOCK_PREPARATION_ACTION_ID]: Object.freeze({
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    kind: 'table_action',
    requiresDryRun: true,
    requiredPermission: 'write',
    allowedParameterBindings: Object.freeze(['projectNo']),
  }),
})

class StockPreparationOptionSyncError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationOptionSyncError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function requiredString(value, field) {
  const str = optionalString(value)
  if (!str) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field} is required`, { field })
  }
  return str
}

function isRedactedMarker(value) {
  return /\[redacted[^\]]*\]|<redacted[^>]*>/i.test(value)
}

function assertSafeString(value, field) {
  const str = requiredString(value, field)
  if (isRedactedMarker(str) || /<[^>]+>/.test(str)) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field} must not be redacted or placeholder-shaped`, { field })
  }
  if (scrubSecretStringValue(str) !== str) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field} must not be secret-shaped`, { field })
  }
  return str
}

function assertNoExecutableKeys(value, field) {
  if (!isPlainObject(value)) return
  for (const key of FORBIDDEN_EXECUTABLE_KEYS) {
    if (key in value) {
      throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_EXECUTABLE_REJECTED', `${field} must not carry executable key ${key}`, {
        field: `${field}.${key}`,
      })
    }
  }
}

function normalizeColor(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  const color = assertSafeString(value, field)
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field} must be a #RRGGBB color`, { field })
  }
  return color
}

function normalizeParameterBindings(input, field, action) {
  const value = input === undefined || input === null ? { projectNo: 'projectNo' } : input
  if (!isPlainObject(value)) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field} must be an object`, { field })
  }
  assertNoExecutableKeys(value, field)
  const allowed = new Set(action.allowedParameterBindings)
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    const parameter = assertSafeString(key, `${field}.key`)
    if (!allowed.has(parameter)) {
      throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field}.${parameter} is not allowed for ${action.actionId}`, {
        field: `${field}.${parameter}`,
        actionId: action.actionId,
      })
    }
    const source = assertSafeString(raw, `${field}.${parameter}`)
    if (source !== parameter) {
      throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field}.${parameter} must bind to ${parameter}`, {
        field: `${field}.${parameter}`,
        actionId: action.actionId,
      })
    }
    out[parameter] = source
  }
  return out
}

function normalizeActionBinding(input, field, optionValue) {
  if (!isPlainObject(input)) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field} must be an object`, { field })
  }
  assertNoExecutableKeys(input, field)
  const actionId = assertSafeString(input.predefinedActionId || input.actionId, `${field}.actionId`)
  const action = PREDEFINED_OPTION_ACTIONS[actionId]
  if (!action) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_ACTION_NOT_ALLOWED', `${field}.actionId is not a predefined stock-preparation action`, {
      field: `${field}.actionId`,
      actionId,
    })
  }
  return {
    optionValue,
    actionId: action.actionId,
    kind: action.kind,
    requiresDryRun: action.requiresDryRun,
    requiredPermission: action.requiredPermission,
    parameterBindings: normalizeParameterBindings(input.parameterBindings, `${field}.parameterBindings`, action),
  }
}

function normalizeOption(input, index, sourceKey) {
  const field = `optionSets.${sourceKey}[${index}]`
  if (!isPlainObject(input)) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field} must be an object`, { field })
  }
  assertNoExecutableKeys(input, field)
  const value = assertSafeString(input.value, `${field}.value`)
  const option = { value }
  const label = optionalString(input.label)
  if (label) option.label = assertSafeString(label, `${field}.label`)
  const color = normalizeColor(input.color, `${field}.color`)
  if (color) option.color = color
  if (input.enabled === false) option.disabled = true
  if (input.order !== undefined) {
    const order = input.order
    if (!Number.isInteger(order) || order < 0) {
      throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `${field}.order must be a non-negative integer`, { field: `${field}.order` })
    }
    option.order = order
  }
  const actionInputs = Array.isArray(input.actionBindings)
    ? input.actionBindings
    : Array.isArray(input.actions)
      ? input.actions
      : []
  const actionBindings = actionInputs.map((binding, bindingIndex) => normalizeActionBinding(
    binding,
    `${field}.actionBindings[${bindingIndex}]`,
    value,
  ))
  return { option, actionBindings }
}

function normalizeOptionSet(rawOptions, sourceKey) {
  if (!Array.isArray(rawOptions)) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `optionSets.${sourceKey} must be an array`, {
      field: `optionSets.${sourceKey}`,
    })
  }
  if (rawOptions.length === 0 || rawOptions.length > MAX_OPTIONS_PER_FIELD) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', `optionSets.${sourceKey} must contain 1-${MAX_OPTIONS_PER_FIELD} options`, {
      field: `optionSets.${sourceKey}`,
      maxOptions: MAX_OPTIONS_PER_FIELD,
    })
  }
  const seen = new Set()
  const options = []
  const actionBindings = []
  rawOptions.forEach((raw, index) => {
    const normalized = normalizeOption(raw, index, sourceKey)
    if (seen.has(normalized.option.value)) {
      throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_AMBIGUOUS_OPTION', `optionSets.${sourceKey} has duplicate option value`, {
        field: `optionSets.${sourceKey}`,
        sourceKey,
      })
    }
    seen.add(normalized.option.value)
    options.push(normalized.option)
    actionBindings.push(...normalized.actionBindings)
  })
  options.sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0))
  return { options, actionBindings }
}

function optionSetsFromInput(input = {}) {
  const raw = input.optionSets || input.optionSources || input.configInfo || input
  if (!isPlainObject(raw)) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_CONFIG_INVALID', 'optionSets must be an object', { field: 'optionSets' })
  }
  assertNoExecutableKeys(raw, 'optionSets')
  const out = {}
  for (const [sourceKey, rawOptions] of Object.entries(raw)) {
    const key = assertSafeString(sourceKey, 'optionSets.key')
    out[key] = normalizeOptionSet(rawOptions, key)
  }
  return out
}

function templateOptionFields(template) {
  return template.fields.filter((field) => field.type === 'select' && field.optionSource)
}

function summarizeOptionSyncEvidence({ template, synced, skipped }) {
  return {
    objectId: template.objectId,
    fields: synced.map((entry) => ({
      field: entry.field,
      optionSource: { ...entry.optionSource },
      optionCount: entry.optionCount,
      actionBindingCount: entry.actionBindingCount,
    })),
    skipped: skipped.map((entry) => ({
      field: entry.field,
      optionSource: { ...entry.optionSource },
      reason: entry.reason,
    })),
  }
}

function getOptionSyncProvisioningApi(context) {
  const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
  if (
    !provisioning ||
    typeof provisioning.findObjectSheet !== 'function' ||
    typeof provisioning.resolveFieldIds !== 'function' ||
    typeof provisioning.patchObjectFieldProperty !== 'function'
  ) {
    throw new StockPreparationOptionSyncError(
      503,
      'OPTION_SYNC_API_UNAVAILABLE',
      'C6 option sync requires multitable.provisioning patchObjectFieldProperty API',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds', 'patchObjectFieldProperty'] },
    )
  }
  return provisioning
}

function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationOptionSyncError(
      403,
      'OPTION_SYNC_PERMISSION_DENIED',
      'stock-preparation option sync requires admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

function publicOptionSyncConfig(input = {}) {
  const defaults = {}
  for (const [key, options] of Object.entries(DEFAULT_CONTRACT_OPTION_SETS)) {
    defaults[key] = normalizeOptionSet(options, key)
  }
  return {
    ...defaults,
    ...optionSetsFromInput(input),
  }
}

async function syncStockPreparationOptions(input = {}) {
  const context = input.context || {}
  const provisioning = getOptionSyncProvisioningApi(context)
  assertAdminPermission(input.permission)
  const projectId = assertSafeString(input.projectId, 'projectId')
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const inspected = await inspectStockPreparationCanonicalTarget({
    context,
    projectId,
    permission: REQUIRED_PERMISSION,
    template,
  })
  if (!inspected.ready) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_TARGET_NOT_READY', 'stock-preparation target must be ready before option sync', {
      mode: inspected.mode,
      targetObjectId: template.objectId,
      missingFields: inspected.evidence && inspected.evidence.missingFields,
    })
  }

  const optionSets = publicOptionSyncConfig(input.optionSets || input.config || {})
  const allowedSourceKeys = new Set(templateOptionFields(template).map((field) => field.optionSource.key))
  const unknownSourceKey = Object.keys(optionSets).find((sourceKey) => !allowedSourceKeys.has(sourceKey))
  if (unknownSourceKey) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_UNKNOWN_SOURCE', 'option set source key is not declared by the stock-preparation template', {
      sourceKey: unknownSourceKey,
      targetObjectId: template.objectId,
    })
  }
  const synced = []
  const skipped = []
  for (const field of templateOptionFields(template)) {
    const sourceKey = field.optionSource.key
    const set = optionSets[sourceKey]
    if (!set) {
      skipped.push({
        field: field.id,
        optionSource: { ...field.optionSource },
        reason: field.optionSource.type === 'config_info' ? 'config_info_not_supplied' : 'contract_not_available',
      })
      continue
    }
    try {
      await provisioning.patchObjectFieldProperty({
        projectId,
        objectId: template.objectId,
        fieldId: field.id,
        propertyPatch: {
          options: set.options.map((option) => {
            const out = { value: option.value }
            if (option.label) out.label = option.label
            if (option.color) out.color = option.color
            if (option.disabled) out.disabled = true
            return out
          }),
          stockPreparation: {
            optionSource: { ...field.optionSource },
            optionSync: {
              sourceType: field.optionSource.type,
              sourceKey,
              optionCount: set.options.length,
              actionBindingCount: set.actionBindings.length,
            },
            optionActionBindings: set.actionBindings,
          },
        },
      })
    } catch (error) {
      throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_FIELD_PATCH_FAILED', 'failed to patch stock-preparation option field metadata', {
        field: field.id,
        sourceKey,
        errorCode: (error && (error.code || error.name)) || 'FIELD_PATCH_FAILED',
      })
    }
    synced.push({
      field: field.id,
      optionSource: { ...field.optionSource },
      optionCount: set.options.length,
      actionBindingCount: set.actionBindings.length,
    })
  }

  if (synced.length === 0) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_NO_FIELDS', 'no stock-preparation option fields were synchronized', {
      targetObjectId: template.objectId,
      skipped: skipped.map((entry) => ({ field: entry.field, reason: entry.reason })),
    })
  }

  return {
    ok: true,
    target: {
      objectId: template.objectId,
      fieldCount: synced.length,
    },
    evidence: summarizeOptionSyncEvidence({ template, synced, skipped }),
  }
}

module.exports = {
  MAX_OPTIONS_PER_FIELD,
  PREDEFINED_OPTION_ACTIONS,
  DEFAULT_CONTRACT_OPTION_SETS,
  StockPreparationOptionSyncError,
  optionSetsFromInput,
  syncStockPreparationOptions,
  summarizeOptionSyncEvidence,
  __internals: {
    isPlainObject,
    assertNoExecutableKeys,
    normalizeOptionSet,
    normalizeActionBinding,
    publicOptionSyncConfig,
    templateOptionFields,
  },
}
