// field-option-sync-contract.cjs
// FOS-1: generic field-option-sync (FOS) contract + values-free preset catalog.
//
// A FOS preset describes SCHEMA + POLICY for syncing option values into a MetaSheet single/multi-select
// field's options. It carries NO credentials, NO option/row values, NO sheetId — only field/source names,
// enums, and policy. Stock-preparation is the first preset / compatibility anchor.
//
// LOCK-SAFE: this module is contract-only. It is NOT imported by any route/runtime (FOS-2 wires the
// generic runtime + route; FOS-3 the UI). It changes no existing behavior — the existing
// stock-preparation-option-sync path is untouched (zero-drift). Mirrors the S1a contract + S3-3
// reference-catalog values-free discipline.
//
// Defaults below are the design-lock §7 v1 recommendations (preset-storage = catalog constants;
// syncMode = replace; disable_missing = disable-only never delete [a FOS-2 runtime semantic];
// conflictPolicy = update_from_source; triggerMode = manual). Owner may redirect before FOS-2.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

class FieldOptionSyncContractError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'FieldOptionSyncContractError'
    this.status = 422
    this.code = 'FIELD_OPTION_SYNC_CONTRACT_INVALID'
    this.details = details
  }
}

const SOURCE_KINDS = Object.freeze(['plm', 'erp', 'sql', 'http', 'metasheet-staging', 'static-preset'])
const SYNC_MODES = Object.freeze(['append', 'replace', 'disable_missing'])
const CONFLICT_POLICIES = Object.freeze(['keep_existing', 'update_from_source', 'manual_confirm'])
const TRIGGER_MODES = Object.freeze(['manual', 'scheduled', 'after_source_refresh'])
const TARGET_KIND = 'metasheet:field-options'
const TARGET_FIELD_TYPES = Object.freeze(['single_select', 'multi_select'])

// §7 v1 defaults
const DEFAULT_SYNC_MODE = 'replace'
const DEFAULT_CONFLICT_POLICY = 'update_from_source'
const DEFAULT_TRIGGER_MODE = 'manual'

// A preset is schema/policy only — never data, secret, scope, or executable behavior.
const FORBIDDEN_PRESET_KEYS = Object.freeze([
  'rows', 'records', 'data', 'values', 'optionValues', 'content',
  'credentials', 'credentialsEncrypted', 'password', 'token', 'secret', 'connectionString', 'config',
  'sheetId', 'tenantId', 'workspaceId',
  'sql', 'query', 'js', 'javascript', 'handler', 'functionBody', 'fn', 'url', 'endpoint', 'payload', 'script',
])

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FieldOptionSyncContractError(`${field} is required`, { field })
  }
  if (scrubSecretStringValue(value) !== value) {
    throw new FieldOptionSyncContractError(`${field} must not be secret-shaped`, { field })
  }
  return value
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, field)
}

function enumValue(value, allowed, field, dflt) {
  if (value === undefined || value === null || value === '') {
    if (dflt !== undefined) return dflt
    throw new FieldOptionSyncContractError(`${field} is required`, { field })
  }
  if (!allowed.includes(value)) {
    throw new FieldOptionSyncContractError(`${field} must be one of ${allowed.join(', ')}`, { field, value })
  }
  return value
}

function assertNoForbiddenKeys(obj, at) {
  if (!obj || typeof obj !== 'object') return
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_PRESET_KEYS.includes(key)) {
      throw new FieldOptionSyncContractError(
        `preset "${at}" must not carry "${key}" (schema/policy only — no data, secret, scope, or executable)`,
        { field: `${at}.${key}` },
      )
    }
  }
}

// Defense-in-depth: reject forbidden content keys + secret-shaped strings anywhere in a preset.
function assertFieldOptionSyncPresetValuesFree(value, at) {
  if (typeof value === 'string') {
    if (scrubSecretStringValue(value) !== value) {
      throw new FieldOptionSyncContractError(`preset "${at}" is secret-shaped`, { field: at })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFieldOptionSyncPresetValuesFree(entry, `${at}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    assertNoForbiddenKeys(value, at)
    for (const [key, entry] of Object.entries(value)) {
      assertFieldOptionSyncPresetValuesFree(entry, `${at}.${key}`)
    }
  }
}

function normalizeOptionField(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FieldOptionSyncContractError(`optionFields[${index}] must be an object`, { field: 'optionFields', index })
  }
  return {
    valueField: requiredString(input.valueField, `optionFields[${index}].valueField`),
    labelField: optionalString(input.labelField, `optionFields[${index}].labelField`),
    groupField: optionalString(input.groupField, `optionFields[${index}].groupField`),
    targetField: requiredString(input.targetField, `optionFields[${index}].targetField`),
    targetFieldType: enumValue(input.targetFieldType, TARGET_FIELD_TYPES, `optionFields[${index}].targetFieldType`, 'single_select'),
  }
}

// Normalize + validate a FOS preset (schema + policy). Returns a fresh, deep object; throws on invalid.
function normalizeFieldOptionSyncPreset(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FieldOptionSyncContractError('preset must be an object')
  }
  assertFieldOptionSyncPresetValuesFree(input, input.presetId || 'preset')
  const optionFields = Array.isArray(input.optionFields) ? input.optionFields : null
  if (!optionFields || optionFields.length === 0) {
    throw new FieldOptionSyncContractError('optionFields must be a non-empty array', { field: 'optionFields' })
  }
  return {
    presetId: requiredString(input.presetId, 'presetId'),
    label: requiredString(input.label, 'label'),
    sourceKind: enumValue(input.sourceKind, SOURCE_KINDS, 'sourceKind'),
    sourceSystemRef: optionalString(input.sourceSystemRef, 'sourceSystemRef'),
    sourceObjectOrTable: optionalString(input.sourceObjectOrTable, 'sourceObjectOrTable'),
    targetKind: enumValue(input.targetKind, [TARGET_KIND], 'targetKind', TARGET_KIND),
    targetTable: requiredString(input.targetTable, 'targetTable'),
    optionFields: optionFields.map(normalizeOptionField),
    syncMode: enumValue(input.syncMode, SYNC_MODES, 'syncMode', DEFAULT_SYNC_MODE),
    conflictPolicy: enumValue(input.conflictPolicy, CONFLICT_POLICIES, 'conflictPolicy', DEFAULT_CONFLICT_POLICY),
    triggerMode: enumValue(input.triggerMode, TRIGGER_MODES, 'triggerMode', DEFAULT_TRIGGER_MODE),
  }
}

// ---- Preset catalog: values-free constants. Stock-preparation = first preset / compatibility anchor. ----
// Names are SCHEMA refs (field ids / source keys / table ref), not option values, not a concrete sheetId.
const FIELD_OPTION_SYNC_PRESETS = Object.freeze([
  Object.freeze({
    presetId: 'preset.stock-preparation.v1',
    label: 'Stock-preparation option sync',
    sourceKind: 'static-preset', // operator-supplied config + built-in contract defaults; no external source binding
    sourceObjectOrTable: 'operator-config',
    targetKind: TARGET_KIND,
    targetTable: 'stock_preparation_main', // canonical own-sheet stock-prep table (schema ref)
    optionFields: Object.freeze([
      Object.freeze({ valueField: 'material_type', targetField: 'materialType', targetFieldType: 'single_select' }),
      Object.freeze({ valueField: 'blank_type', targetField: 'blankType', targetFieldType: 'single_select' }),
      Object.freeze({ valueField: 'stock_preparation_status', targetField: 'stockPreparationStatus', targetFieldType: 'single_select' }),
      Object.freeze({ valueField: 'plm_stock_preparation_decision_v1', targetField: 'lastPlmRefreshDecision', targetFieldType: 'single_select' }),
    ]),
    syncMode: 'replace', // §7 + zero-drift with current stock-prep behavior
    conflictPolicy: 'update_from_source', // §7
    triggerMode: 'manual', // §7
  }),
])

// Returns deep, validated copies of the catalog (asserts values-free first; never mutates the frozen consts).
function listFieldOptionSyncPresets() {
  return FIELD_OPTION_SYNC_PRESETS.map((preset) => {
    assertFieldOptionSyncPresetValuesFree(preset, preset.presetId)
    return normalizeFieldOptionSyncPreset(preset)
  })
}

module.exports = {
  FieldOptionSyncContractError,
  SOURCE_KINDS,
  SYNC_MODES,
  CONFLICT_POLICIES,
  TRIGGER_MODES,
  TARGET_KIND,
  TARGET_FIELD_TYPES,
  DEFAULT_SYNC_MODE,
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_TRIGGER_MODE,
  FORBIDDEN_PRESET_KEYS,
  normalizeFieldOptionSyncPreset,
  assertFieldOptionSyncPresetValuesFree,
  FIELD_OPTION_SYNC_PRESETS,
  listFieldOptionSyncPresets,
}
