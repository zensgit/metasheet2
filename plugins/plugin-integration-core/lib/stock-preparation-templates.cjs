'use strict'

// #2253 C1: stock-preparation table template + BOM-read feasibility gate.
// Schema-only and latent. It provisions no sheet, reads no PLM data, writes no
// MetaSheet rows, and exposes no runtime route. This mirrors the DF-T3a
// reference-mapping template contract: normalize a safe manifest and build an
// empty sheet structure that cannot carry customer rows or executable SQL.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

const STOCK_PREPARATION_FIELD_TYPES = Object.freeze(['string', 'number', 'boolean', 'date', 'select'])
const STOCK_PREPARATION_FIELD_OWNERSHIPS = Object.freeze(['plm_system', 'human_preserved'])
const STOCK_PREPARATION_OWNERSHIP_SET = new Set(STOCK_PREPARATION_FIELD_OWNERSHIPS)
const STOCK_PREPARATION_TYPE_SET = new Set(STOCK_PREPARATION_FIELD_TYPES)

const REQUIRED_SYSTEM_FIELDS = Object.freeze([
  'projectNo',
  'idempotencyKey',
  'componentSourceId',
  'path',
  'totalQuantity',
  'active',
  'lastPlmRefreshRunId',
  'lastPlmRefreshDecision',
  'lastPlmConflictSummary',
])

const HUMAN_PRESERVED_FIELD_IDS = Object.freeze([
  'materialType',
  'blankType',
  'stockPreparationStatus',
  'demandDate',
  'leadTimeDays',
  'notes',
  'procurementReply',
  'warehouseConfirmation',
])

const FEASIBILITY_FORBIDDEN_MECHANISMS = Object.freeze([
  'raw_sql',
  'recursive_cte',
  'stored_procedure',
  'vendor_api_call',
])

// Keys that would smuggle rows, executable payloads, or customer business values
// into a schema-only manifest. Runtime slices must get values from the tenant
// workspace/source at execution time, not from this contract.
const FORBIDDEN_CONTENT_KEYS = Object.freeze([
  'rows',
  'records',
  'data',
  'values',
  'content',
  'sample',
  'payload',
  'payloadTemplate',
  'rawSql',
  'sql',
  'query',
  'storedProcedure',
])

class StockPreparationTemplateError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationTemplateError'
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StockPreparationTemplateError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new StockPreparationTemplateError(`${field} must be a string`, { field })
  }
  return value.trim()
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new StockPreparationTemplateError(`${field} must be a boolean`, { field })
  }
  return value
}

function isSecretShaped(str) {
  return scrubSecretStringValue(str) !== str
}

function assertSafeSchemaString(value, field) {
  const str = requiredString(value, field)
  if (isSecretShaped(str)) {
    throw new StockPreparationTemplateError(`${field} must not be secret-shaped`, { field })
  }
  return str
}

function assertNoContentKeys(input, field) {
  if (!isPlainObject(input)) return
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    if (key in input) {
      throw new StockPreparationTemplateError(`${field} must not carry "${key}" (schema only)`, {
        field: field ? `${field}.${key}` : key,
      })
    }
  }
}

function normalizeOptionSource(input, field) {
  if (input === undefined || input === null) return undefined
  if (!isPlainObject(input)) {
    throw new StockPreparationTemplateError(`${field} must be an object`, { field })
  }
  assertNoContentKeys(input, field)
  const type = assertSafeSchemaString(input.type, `${field}.type`)
  if (!['config_info', 'contract'].includes(type)) {
    throw new StockPreparationTemplateError(`${field}.type must be config_info or contract`, { field: `${field}.type`, value: type })
  }
  const key = assertSafeSchemaString(input.key, `${field}.key`)
  return { type, key }
}

function normalizeField(field, index) {
  const at = `fields[${index}]`
  if (!isPlainObject(field)) {
    throw new StockPreparationTemplateError(`${at} must be an object`, { field: at })
  }
  assertNoContentKeys(field, at)
  for (const contentKey of ['value', 'default', 'options', 'values']) {
    if (contentKey in field) {
      throw new StockPreparationTemplateError(`${at} must not carry ${contentKey} (schema only, no customer values)`, {
        field: `${at}.${contentKey}`,
      })
    }
  }
  const id = assertSafeSchemaString(field.id, `${at}.id`)
  const label = assertSafeSchemaString(field.label || field.name || id, `${at}.label`)
  const type = assertSafeSchemaString(field.type, `${at}.type`)
  if (!STOCK_PREPARATION_TYPE_SET.has(type)) {
    throw new StockPreparationTemplateError(
      `${at}.type must be one of ${STOCK_PREPARATION_FIELD_TYPES.join(', ')}`,
      { field: `${at}.type`, value: type },
    )
  }
  const ownership = assertSafeSchemaString(field.ownership, `${at}.ownership`)
  if (!STOCK_PREPARATION_OWNERSHIP_SET.has(ownership)) {
    throw new StockPreparationTemplateError(
      `${at}.ownership must be one of ${STOCK_PREPARATION_FIELD_OWNERSHIPS.join(', ')}`,
      { field: `${at}.ownership`, value: ownership },
    )
  }
  const out = { id, label, type, ownership }
  if (field.required !== undefined) out.required = requiredBoolean(field.required, `${at}.required`)
  if (field.key !== undefined) out.key = requiredBoolean(field.key, `${at}.key`)
  const optionSource = normalizeOptionSource(field.optionSource, `${at}.optionSource`)
  if (optionSource) out.optionSource = optionSource

  if (ownership === 'human_preserved') {
    out.preserveOnRefresh = true
  } else if (field.preserveOnRefresh === true) {
    throw new StockPreparationTemplateError(`${at}.preserveOnRefresh must not be true for PLM/system fields`, {
      field: `${at}.preserveOnRefresh`,
    })
  }
  return out
}

function normalizeConflictStrategy(input = {}) {
  const strategy = input === undefined || input === null ? {} : input
  if (!isPlainObject(strategy)) {
    throw new StockPreparationTemplateError('conflictStrategy must be an object', { field: 'conflictStrategy' })
  }
  assertNoContentKeys(strategy, 'conflictStrategy')
  return {
    addMissing: strategy.addMissing !== undefined ? requiredBoolean(strategy.addMissing, 'conflictStrategy.addMissing') : true,
    refreshPlmSystemFields: strategy.refreshPlmSystemFields !== undefined ? requiredBoolean(strategy.refreshPlmSystemFields, 'conflictStrategy.refreshPlmSystemFields') : true,
    preserveHumanFields: strategy.preserveHumanFields !== undefined ? requiredBoolean(strategy.preserveHumanFields, 'conflictStrategy.preserveHumanFields') : true,
    duplicatePolicy: optionalString(strategy.duplicatePolicy, 'conflictStrategy.duplicatePolicy') || 'skip_or_conflict',
    missingFromPlmPolicy: optionalString(strategy.missingFromPlmPolicy, 'conflictStrategy.missingFromPlmPolicy') || 'mark_inactive',
    deleteByDefault: strategy.deleteByDefault !== undefined ? requiredBoolean(strategy.deleteByDefault, 'conflictStrategy.deleteByDefault') : false,
  }
}

function normalizeFeasibilityRelation(input, index) {
  const at = `feasibilityGate.relationDescriptors[${index}]`
  if (!isPlainObject(input)) {
    throw new StockPreparationTemplateError(`${at} must be an object`, { field: at })
  }
  assertNoContentKeys(input, at)
  const relation = {
    id: assertSafeSchemaString(input.id, `${at}.id`),
    kind: assertSafeSchemaString(input.kind, `${at}.kind`),
  }
  if (!['root_by_project', 'children_by_parent'].includes(relation.kind)) {
    throw new StockPreparationTemplateError(`${at}.kind must be root_by_project or children_by_parent`, {
      field: `${at}.kind`,
      value: relation.kind,
    })
  }
  for (const key of ['object', 'matchField', 'parentField', 'childField', 'sourceIdField']) {
    const value = optionalString(input[key], `${at}.${key}`)
    if (value !== undefined) {
      if (isSecretShaped(value)) {
        throw new StockPreparationTemplateError(`${at}.${key} must not be secret-shaped`, { field: `${at}.${key}` })
      }
      relation[key] = value
    }
  }
  if (relation.kind === 'root_by_project') {
    for (const key of ['matchField', 'sourceIdField']) {
      if (!relation[key]) {
        throw new StockPreparationTemplateError(`${at}.${key} is required for root_by_project`, {
          field: `${at}.${key}`,
        })
      }
    }
  }
  if (relation.kind === 'children_by_parent') {
    for (const key of ['parentField', 'childField', 'sourceIdField']) {
      if (!relation[key]) {
        throw new StockPreparationTemplateError(`${at}.${key} is required for children_by_parent`, {
          field: `${at}.${key}`,
        })
      }
    }
  }
  return relation
}

function normalizeBomReadFeasibilityGate(input) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTemplateError('feasibilityGate must be an object', { field: 'feasibilityGate' })
  }
  assertNoContentKeys(input, 'feasibilityGate')
  const mode = assertSafeSchemaString(input.mode, 'feasibilityGate.mode')
  if (mode !== 'flat_parameterized_reads') {
    throw new StockPreparationTemplateError('feasibilityGate.mode must be flat_parameterized_reads', {
      field: 'feasibilityGate.mode',
      value: mode,
    })
  }
  const sourceKind = assertSafeSchemaString(input.sourceKind, 'feasibilityGate.sourceKind')
  if (sourceKind !== 'data-source:sql-readonly') {
    throw new StockPreparationTemplateError('feasibilityGate.sourceKind must be data-source:sql-readonly', {
      field: 'feasibilityGate.sourceKind',
      value: sourceKind,
    })
  }
  const matchField = assertSafeSchemaString(input.matchField, 'feasibilityGate.matchField')
  if (matchField !== 'FileCode') {
    throw new StockPreparationTemplateError('feasibilityGate.matchField must be FileCode for v1', {
      field: 'feasibilityGate.matchField',
      value: matchField,
    })
  }
  const status = optionalString(input.status, 'feasibilityGate.status') || 'requires_customer_schema'
  if (!['requires_customer_schema', 'confirmed_flat_reads'].includes(status)) {
    throw new StockPreparationTemplateError('feasibilityGate.status must be requires_customer_schema or confirmed_flat_reads', {
      field: 'feasibilityGate.status',
      value: status,
    })
  }
  const forbiddenMechanisms = Array.isArray(input.forbiddenMechanisms)
    ? input.forbiddenMechanisms.map((value, index) => assertSafeSchemaString(value, `feasibilityGate.forbiddenMechanisms[${index}]`))
    : [...FEASIBILITY_FORBIDDEN_MECHANISMS]
  for (const mechanism of FEASIBILITY_FORBIDDEN_MECHANISMS) {
    if (!forbiddenMechanisms.includes(mechanism)) {
      throw new StockPreparationTemplateError(`feasibilityGate.forbiddenMechanisms must include ${mechanism}`, {
        field: 'feasibilityGate.forbiddenMechanisms',
        missing: mechanism,
      })
    }
  }
  const relationDescriptors = Array.isArray(input.relationDescriptors)
    ? input.relationDescriptors.map(normalizeFeasibilityRelation)
    : []
  const kinds = new Set(relationDescriptors.map((relation) => relation.kind))
  for (const required of ['root_by_project', 'children_by_parent']) {
    if (!kinds.has(required)) {
      throw new StockPreparationTemplateError(`feasibilityGate.relationDescriptors must include ${required}`, {
        field: 'feasibilityGate.relationDescriptors',
        missing: required,
      })
    }
  }
  return {
    mode,
    sourceKind,
    matchField,
    sourceIdField: optionalString(input.sourceIdField, 'feasibilityGate.sourceIdField') || 'OBJ_ID',
    status,
    forbiddenMechanisms,
    relationDescriptors,
  }
}

function normalizeStockPreparationTemplate(input) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTemplateError('template must be a plain object')
  }
  assertNoContentKeys(input, 'template')
  const fields = Array.isArray(input.fields) ? input.fields.map(normalizeField) : []
  if (fields.length === 0) {
    throw new StockPreparationTemplateError('fields must be a non-empty array', { field: 'fields' })
  }
  const byId = new Map(fields.map((field) => [field.id, field]))
  if (byId.size !== fields.length) {
    throw new StockPreparationTemplateError('field ids must be unique', { field: 'fields' })
  }
  for (const required of REQUIRED_SYSTEM_FIELDS) {
    const field = byId.get(required)
    if (!field || field.ownership !== 'plm_system') {
      throw new StockPreparationTemplateError(`template must include PLM/system field ${required}`, {
        field: 'fields',
        missing: required,
      })
    }
  }
  for (const required of HUMAN_PRESERVED_FIELD_IDS) {
    const field = byId.get(required)
    if (!field || field.ownership !== 'human_preserved' || field.preserveOnRefresh !== true) {
      throw new StockPreparationTemplateError(`template must include human-preserved field ${required}`, {
        field: 'fields',
        missing: required,
      })
    }
  }
  const keyFields = Array.isArray(input.keyFields)
    ? input.keyFields.map((value, index) => assertSafeSchemaString(value, `keyFields[${index}]`))
    : ['idempotencyKey']
  if (!keyFields.includes('idempotencyKey')) {
    throw new StockPreparationTemplateError('keyFields must include idempotencyKey', { field: 'keyFields' })
  }
  return {
    id: assertSafeSchemaString(input.id, 'id'),
    objectId: assertSafeSchemaString(input.objectId || input.id, 'objectId'),
    label: assertSafeSchemaString(input.label || input.name || input.id, 'label'),
    version: optionalString(input.version, 'version') || 'v1',
    keyFields,
    feasibilityGate: normalizeBomReadFeasibilityGate(input.feasibilityGate),
    conflictStrategy: normalizeConflictStrategy(input.conflictStrategy),
    fields,
  }
}

function buildSheetStructureFromTemplate(template) {
  const normalized = normalizeStockPreparationTemplate(template)
  return {
    objectId: normalized.objectId,
    label: normalized.label,
    keyFields: normalized.keyFields.slice(),
    fields: normalized.fields.map((field, order) => {
      const out = {
        id: field.id,
        name: field.label,
        type: field.type,
        order,
      }
      if (field.required) out.property = { validation: [{ type: 'required' }] }
      return out
    }),
    rows: [],
  }
}

function summarizeTemplateForEvidence(template) {
  const normalized = normalizeStockPreparationTemplate(template)
  return {
    id: normalized.id,
    objectId: normalized.objectId,
    version: normalized.version,
    feasibilityGate: {
      mode: normalized.feasibilityGate.mode,
      sourceKind: normalized.feasibilityGate.sourceKind,
      matchField: normalized.feasibilityGate.matchField,
      status: normalized.feasibilityGate.status,
      forbiddenMechanisms: normalized.feasibilityGate.forbiddenMechanisms.slice(),
      relationDescriptorKinds: normalized.feasibilityGate.relationDescriptors.map((relation) => relation.kind),
    },
    fieldOwnership: normalized.fields.map((field) => ({
      id: field.id,
      ownership: field.ownership,
      type: field.type,
      required: field.required === true,
      optionSource: field.optionSource ? { ...field.optionSource } : undefined,
    })),
    humanPreservedFields: normalized.fields
      .filter((field) => field.ownership === 'human_preserved')
      .map((field) => field.id),
    plmSystemFields: normalized.fields
      .filter((field) => field.ownership === 'plm_system')
      .map((field) => field.id),
    conflictStrategy: { ...normalized.conflictStrategy },
  }
}

function field(id, label, type, ownership, extra = {}) {
  return { id, label, type, ownership, ...extra }
}

const STOCK_PREPARATION_MAIN_TABLE_TEMPLATE = Object.freeze(normalizeStockPreparationTemplate({
  id: 'plm.stock-preparation.main.v1',
  objectId: 'plm_stock_preparation_main',
  label: 'PLM Stock Preparation Main',
  version: 'v1',
  keyFields: ['idempotencyKey'],
  feasibilityGate: {
    mode: 'flat_parameterized_reads',
    sourceKind: 'data-source:sql-readonly',
    matchField: 'FileCode',
    sourceIdField: 'OBJ_ID',
    status: 'requires_customer_schema',
    forbiddenMechanisms: FEASIBILITY_FORBIDDEN_MECHANISMS,
    relationDescriptors: [
      {
        id: 'root-by-project-filecode',
        kind: 'root_by_project',
        matchField: 'FileCode',
        sourceIdField: 'OBJ_ID',
      },
      {
        id: 'children-by-parent-source-id',
        kind: 'children_by_parent',
        parentField: 'parentSourceId',
        childField: 'componentSourceId',
        sourceIdField: 'OBJ_ID',
      },
    ],
  },
  conflictStrategy: {
    addMissing: true,
    refreshPlmSystemFields: true,
    preserveHumanFields: true,
    duplicatePolicy: 'skip_or_conflict',
    missingFromPlmPolicy: 'mark_inactive',
    deleteByDefault: false,
  },
  fields: [
    field('projectNo', 'Project No', 'string', 'plm_system', { required: true }),
    field('idempotencyKey', 'Idempotency Key', 'string', 'plm_system', { required: true, key: true }),
    field('componentSourceId', 'Component Source ID', 'string', 'plm_system', { required: true }),
    field('parentSourceId', 'Parent Source ID', 'string', 'plm_system'),
    field('path', 'BOM Path', 'string', 'plm_system', { required: true }),
    field('depth', 'BOM Depth', 'number', 'plm_system'),
    field('componentCode', 'Component Code', 'string', 'plm_system'),
    field('componentName', 'Component Name', 'string', 'plm_system'),
    field('material', 'Material', 'string', 'plm_system'),
    field('sourceVersion', 'PLM Source Version', 'string', 'plm_system'),
    field('rawQuantity', 'Raw Quantity', 'number', 'plm_system'),
    field('totalQuantity', 'Total Quantity', 'number', 'plm_system', { required: true }),
    field('active', 'Active', 'boolean', 'plm_system', { required: true }),
    field('lastPlmRefreshRunId', 'Last PLM Refresh Run ID', 'string', 'plm_system'),
    field('lastPlmRefreshAt', 'Last PLM Refresh At', 'date', 'plm_system'),
    field('lastPlmRefreshDecision', 'Last PLM Refresh Decision', 'select', 'plm_system', {
      optionSource: { type: 'contract', key: 'plm_stock_preparation_decision_v1' },
    }),
    field('lastPlmConflictSummary', 'Last PLM Conflict Summary', 'string', 'plm_system'),
    field('materialType', 'Material Type', 'select', 'human_preserved', {
      optionSource: { type: 'config_info', key: 'material_type' },
    }),
    field('blankType', 'Blank Type', 'select', 'human_preserved', {
      optionSource: { type: 'config_info', key: 'blank_type' },
    }),
    field('stockPreparationStatus', 'Stock Preparation Status', 'select', 'human_preserved', {
      optionSource: { type: 'config_info', key: 'stock_preparation_status' },
    }),
    field('demandDate', 'Demand Date', 'date', 'human_preserved'),
    field('leadTimeDays', 'Lead Time Days', 'number', 'human_preserved'),
    field('notes', 'Notes', 'string', 'human_preserved'),
    field('procurementReply', 'Procurement Reply', 'string', 'human_preserved'),
    field('warehouseConfirmation', 'Warehouse Confirmation', 'string', 'human_preserved'),
  ],
}))

module.exports = {
  STOCK_PREPARATION_FIELD_TYPES,
  STOCK_PREPARATION_FIELD_OWNERSHIPS,
  REQUIRED_SYSTEM_FIELDS,
  HUMAN_PRESERVED_FIELD_IDS,
  FEASIBILITY_FORBIDDEN_MECHANISMS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  StockPreparationTemplateError,
  normalizeStockPreparationTemplate,
  normalizeBomReadFeasibilityGate,
  buildSheetStructureFromTemplate,
  summarizeTemplateForEvidence,
  __internals: {
    isPlainObject,
    assertNoContentKeys,
    normalizeField,
    normalizeOptionSource,
    normalizeConflictStrategy,
    normalizeFeasibilityRelation,
    isSecretShaped,
    FORBIDDEN_CONTENT_KEYS,
  },
}
