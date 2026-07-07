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

function normalizeStockPreparationMvpTableTemplate(input) {
  if (!isPlainObject(input)) {
    throw new StockPreparationTemplateError('mvp table template must be a plain object')
  }
  assertNoContentKeys(input, 'mvpTable')
  const fields = Array.isArray(input.fields) ? input.fields.map(normalizeField) : []
  if (fields.length === 0) {
    throw new StockPreparationTemplateError('mvp table fields must be a non-empty array', { field: 'fields' })
  }
  const byId = new Map(fields.map((field) => [field.id, field]))
  if (byId.size !== fields.length) {
    throw new StockPreparationTemplateError('mvp table field ids must be unique', { field: 'fields' })
  }
  const keyFields = Array.isArray(input.keyFields)
    ? input.keyFields.map((value, index) => assertSafeSchemaString(value, `keyFields[${index}]`))
    : []
  if (!keyFields.length) {
    throw new StockPreparationTemplateError('mvp table keyFields must be a non-empty array', { field: 'keyFields' })
  }
  for (const keyField of keyFields) {
    if (!byId.has(keyField)) {
      throw new StockPreparationTemplateError(`mvp table key field ${keyField} must exist`, {
        field: 'keyFields',
        missing: keyField,
      })
    }
  }
  const requiredFields = Array.isArray(input.requiredFields)
    ? input.requiredFields.map((value, index) => assertSafeSchemaString(value, `requiredFields[${index}]`))
    : keyFields.slice()
  for (const required of requiredFields) {
    const field = byId.get(required)
    if (!field) {
      throw new StockPreparationTemplateError(`mvp table required field ${required} must exist`, {
        field: 'requiredFields',
        missing: required,
      })
    }
    if (field.required !== true) {
      throw new StockPreparationTemplateError(`mvp table required field ${required} must be marked required`, {
        field: required,
      })
    }
  }
  return {
    id: assertSafeSchemaString(input.id, 'id'),
    objectId: assertSafeSchemaString(input.objectId || input.id, 'objectId'),
    label: assertSafeSchemaString(input.label || input.name || input.id, 'label'),
    version: optionalString(input.version, 'version') || 'v1',
    role: optionalString(input.role, 'role') || 'supporting',
    keyFields,
    requiredFields,
    fields,
  }
}

function buildSheetStructureFromMvpTableTemplate(template) {
  const normalized = normalizeStockPreparationMvpTableTemplate(template)
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

function summarizeMvpTableTemplatesForEvidence(templates) {
  const tableTemplates = templates || STOCK_PREPARATION_MVP_TABLE_TEMPLATES
  return {
    tableCount: tableTemplates.length,
    tables: tableTemplates.map((template) => {
      const normalized = normalizeStockPreparationMvpTableTemplate(template)
      return {
        id: normalized.id,
        objectId: normalized.objectId,
        version: normalized.version,
        role: normalized.role,
        keyFields: normalized.keyFields.slice(),
        requiredFields: normalized.requiredFields.slice(),
        fieldCounts: {
          total: normalized.fields.length,
          plmSystem: normalized.fields.filter((field) => field.ownership === 'plm_system').length,
          humanPreserved: normalized.fields.filter((field) => field.ownership === 'human_preserved').length,
          required: normalized.fields.filter((field) => field.required === true).length,
        },
        optionSources: normalized.fields
          .filter((field) => field.optionSource)
          .map((field) => ({
            field: field.id,
            type: field.optionSource.type,
            key: field.optionSource.key,
          })),
      }
    }),
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

const STOCK_PREPARATION_MVP_TABLE_TEMPLATES = Object.freeze([
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.project.v1',
    objectId: 'plm_stock_preparation_project',
    label: 'Stock Preparation Project',
    version: 'v1',
    role: 'project',
    keyFields: ['projectId'],
    requiredFields: ['projectId', 'sourceProjectNo'],
    fields: [
      field('projectId', 'Project ID', 'string', 'plm_system', { required: true, key: true }),
      field('sourceProjectNo', 'Source Project No', 'string', 'plm_system', { required: true }),
      field('projectName', 'Project Name', 'string', 'plm_system'),
      field('sourceSystem', 'Source System', 'string', 'plm_system'),
      field('projectStatus', 'Project Status', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_project_status_v1' },
      }),
      field('lastSyncRunId', 'Last Sync Run ID', 'string', 'plm_system'),
      field('lastSyncedAt', 'Last Synced At', 'date', 'plm_system'),
      field('owner', 'Owner', 'string', 'human_preserved'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.bom-snapshot-batch.v1',
    objectId: 'plm_stock_preparation_bom_snapshot_batch',
    label: 'PLM BOM Snapshot Batch',
    version: 'v1',
    role: 'bom_snapshot_batch',
    keyFields: ['snapshotBatchId'],
    requiredFields: ['snapshotBatchId', 'projectId', 'snapshotVersion', 'syncRunId'],
    fields: [
      field('snapshotBatchId', 'Snapshot Batch ID', 'string', 'plm_system', { required: true, key: true }),
      field('projectId', 'Project ID', 'string', 'plm_system', { required: true }),
      field('sourceSystem', 'Source System', 'string', 'plm_system'),
      field('sourceBomId', 'Source BOM ID', 'string', 'plm_system'),
      field('snapshotVersion', 'Snapshot Version', 'number', 'plm_system', { required: true }),
      field('syncRunId', 'Sync Run ID', 'string', 'plm_system', { required: true }),
      field('snapshotStatus', 'Snapshot Status', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_snapshot_status_v1' },
      }),
      field('createdAt', 'Created At', 'date', 'plm_system'),
      field('createdBy', 'Created By', 'string', 'plm_system'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.bom-snapshot-line.v1',
    objectId: 'plm_stock_preparation_bom_snapshot_line',
    label: 'PLM BOM Snapshot Line',
    version: 'v1',
    role: 'bom_snapshot_line',
    keyFields: ['snapshotLineId'],
    requiredFields: ['snapshotLineId', 'snapshotBatchId', 'pathKey'],
    fields: [
      field('snapshotLineId', 'Snapshot Line ID', 'string', 'plm_system', { required: true, key: true }),
      field('snapshotBatchId', 'Snapshot Batch ID', 'string', 'plm_system', { required: true }),
      field('parentDrawingNo', 'Parent Drawing No', 'string', 'plm_system'),
      field('parentVersion', 'Parent Version', 'string', 'plm_system'),
      field('childDrawingNo', 'Child Drawing No', 'string', 'plm_system'),
      field('childVersion', 'Child Version', 'string', 'plm_system'),
      field('bomLevel', 'BOM Level', 'number', 'plm_system'),
      field('pathKey', 'Path Key', 'string', 'plm_system', { required: true }),
      field('designQty', 'Design Quantity', 'number', 'plm_system'),
      field('designUnit', 'Design Unit', 'string', 'plm_system'),
      field('lineStatus', 'Line Status', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_bom_line_status_v1' },
      }),
      field('sourceFingerprint', 'Source Fingerprint', 'string', 'plm_system'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.erp-material-master.v1',
    objectId: 'plm_stock_preparation_erp_material_master',
    label: 'ERP/K3 Material Master Cache',
    version: 'v1',
    role: 'erp_material_master',
    keyFields: ['erpMaterialId'],
    requiredFields: ['erpMaterialId', 'erpMaterialCode', 'erpMaterialInternalId'],
    fields: [
      field('erpMaterialId', 'ERP Material ID', 'string', 'plm_system', { required: true, key: true }),
      field('erpMaterialCode', 'ERP Material Code', 'string', 'plm_system', { required: true }),
      field('erpMaterialInternalId', 'ERP/K3 Material Internal ID', 'string', 'plm_system', { required: true }),
      field('erpMaterialName', 'ERP Material Name', 'string', 'plm_system'),
      field('erpSpec', 'ERP Specification', 'string', 'plm_system'),
      field('baseUnit', 'Base Unit', 'string', 'plm_system'),
      field('inventoryUnit', 'Inventory Unit', 'string', 'plm_system'),
      field('issueUnit', 'Issue Unit', 'string', 'plm_system'),
      field('unitGroup', 'Unit Group', 'string', 'plm_system'),
      field('materialStatus', 'Material Status', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_material_status_v1' },
      }),
      field('lastSyncedAt', 'Last Synced At', 'date', 'plm_system'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.material-mapping.v1',
    objectId: 'plm_stock_preparation_material_mapping',
    label: 'PLM to ERP Material Mapping',
    version: 'v1',
    role: 'material_mapping',
    keyFields: ['mappingId'],
    requiredFields: ['mappingId', 'plmDrawingNo', 'versionPolicy', 'matchStatus'],
    fields: [
      field('mappingId', 'Mapping ID', 'string', 'plm_system', { required: true, key: true }),
      field('plmDrawingNo', 'PLM Drawing No', 'string', 'plm_system', { required: true }),
      field('plmVersion', 'PLM Version', 'string', 'plm_system'),
      field('plmMaterialName', 'PLM Material Name', 'string', 'plm_system'),
      field('plmSpec', 'PLM Specification', 'string', 'plm_system'),
      field('erpMaterialCode', 'ERP Material Code', 'string', 'plm_system'),
      field('erpMaterialInternalId', 'ERP/K3 Material Internal ID', 'string', 'plm_system'),
      field('erpMaterialName', 'ERP Material Name', 'string', 'plm_system'),
      field('erpSpec', 'ERP Specification', 'string', 'plm_system'),
      field('versionPolicy', 'Version Policy', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_version_policy_v1' },
      }),
      field('matchStatus', 'Match Status', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_match_status_v1' },
      }),
      field('matchMethod', 'Match Method', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_match_method_v1' },
      }),
      field('confidence', 'Confidence', 'number', 'plm_system'),
      field('isActive', 'Is Active', 'boolean', 'plm_system'),
      field('confirmedBy', 'Confirmed By', 'string', 'human_preserved'),
      field('confirmedAt', 'Confirmed At', 'date', 'human_preserved'),
      field('notes', 'Notes', 'string', 'human_preserved'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.unit-conversion-rule.v1',
    objectId: 'plm_stock_preparation_unit_conversion_rule',
    label: 'Stock Preparation Unit Conversion Rule',
    version: 'v1',
    role: 'unit_conversion_rule',
    keyFields: ['conversionRuleId'],
    requiredFields: ['conversionRuleId', 'plmUnit', 'erpIssueUnit', 'conversionFactor', 'scopeType'],
    fields: [
      field('conversionRuleId', 'Conversion Rule ID', 'string', 'plm_system', { required: true, key: true }),
      field('plmUnit', 'PLM Unit', 'string', 'plm_system', { required: true }),
      field('erpIssueUnit', 'ERP Issue Unit', 'string', 'plm_system', { required: true }),
      field('conversionFactor', 'Conversion Factor', 'number', 'plm_system', { required: true }),
      field('scopeType', 'Scope Type', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_unit_scope_type_v1' },
      }),
      field('scopeKey', 'Scope Key', 'string', 'plm_system'),
      field('lossRate', 'Loss Rate', 'number', 'plm_system'),
      field('roundingRule', 'Rounding Rule', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_rounding_rule_v1' },
      }),
      field('minimumIssueQty', 'Minimum Issue Quantity', 'number', 'plm_system'),
      field('source', 'Rule Source', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_unit_rule_source_v1' },
      }),
      field('requiresConfirmation', 'Requires Confirmation', 'boolean', 'plm_system'),
      field('isActive', 'Is Active', 'boolean', 'plm_system'),
      field('effectiveFrom', 'Effective From', 'date', 'plm_system'),
      field('effectiveTo', 'Effective To', 'date', 'plm_system'),
      field('confirmedBy', 'Confirmed By', 'string', 'human_preserved'),
      field('confirmedAt', 'Confirmed At', 'date', 'human_preserved'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.line.v1',
    objectId: 'plm_stock_preparation_line',
    label: 'Stock Preparation Line',
    version: 'v1',
    role: 'stock_preparation_line',
    keyFields: ['stockPrepLineId'],
    requiredFields: ['stockPrepLineId', 'projectId', 'snapshotBatchId', 'snapshotLineId', 'prepStatus'],
    fields: [
      field('stockPrepLineId', 'Stock Preparation Line ID', 'string', 'plm_system', { required: true, key: true }),
      field('projectId', 'Project ID', 'string', 'plm_system', { required: true }),
      field('snapshotBatchId', 'Snapshot Batch ID', 'string', 'plm_system', { required: true }),
      field('snapshotLineId', 'Snapshot Line ID', 'string', 'plm_system', { required: true }),
      field('parentDrawingNo', 'Parent Drawing No', 'string', 'plm_system'),
      field('childDrawingNo', 'Child Drawing No', 'string', 'plm_system'),
      field('childVersion', 'Child Version', 'string', 'plm_system'),
      field('erpMaterialCode', 'ERP Material Code', 'string', 'plm_system'),
      field('erpMaterialInternalId', 'ERP/K3 Material Internal ID', 'string', 'plm_system'),
      field('designQty', 'PLM Design Quantity', 'number', 'plm_system'),
      field('designUnit', 'PLM Design Unit', 'string', 'plm_system'),
      field('conversionFactor', 'Conversion Factor', 'number', 'plm_system'),
      field('lossRate', 'Loss Rate', 'number', 'plm_system'),
      field('issueQtyRaw', 'ERP Issue Quantity Raw', 'number', 'plm_system'),
      field('issueQtyFinal', 'ERP Issue Quantity Final', 'number', 'plm_system'),
      field('issueUnit', 'ERP Issue Unit', 'string', 'plm_system'),
      field('mappingStatus', 'Mapping Status', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_match_status_v1' },
      }),
      field('unitStatus', 'Unit Status', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_unit_status_v1' },
      }),
      field('prepStatus', 'Preparation Status', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_prep_status_v1' },
      }),
      field('exceptionCount', 'Exception Count', 'number', 'plm_system'),
      field('createdFromRunId', 'Created From Run ID', 'string', 'plm_system'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.exception-confirmation.v1',
    objectId: 'plm_stock_preparation_exception_confirmation',
    label: 'Stock Preparation Exception Confirmation',
    version: 'v1',
    role: 'exception_confirmation',
    keyFields: ['exceptionId'],
    requiredFields: ['exceptionId', 'projectId', 'exceptionType', 'status'],
    fields: [
      field('exceptionId', 'Exception ID', 'string', 'plm_system', { required: true, key: true }),
      field('projectId', 'Project ID', 'string', 'plm_system', { required: true }),
      field('snapshotBatchId', 'Snapshot Batch ID', 'string', 'plm_system'),
      field('snapshotLineId', 'Snapshot Line ID', 'string', 'plm_system'),
      field('stockPrepLineId', 'Stock Preparation Line ID', 'string', 'plm_system'),
      field('exceptionType', 'Exception Type', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_exception_type_v1' },
      }),
      field('severity', 'Severity', 'select', 'plm_system', {
        optionSource: { type: 'contract', key: 'stock_preparation_exception_severity_v1' },
      }),
      field('status', 'Status', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_exception_status_v1' },
      }),
      field('message', 'Message', 'string', 'plm_system'),
      field('resolutionAction', 'Resolution Action', 'select', 'human_preserved', {
        optionSource: { type: 'contract', key: 'stock_preparation_resolution_action_v1' },
      }),
      field('resolvedBy', 'Resolved By', 'string', 'human_preserved'),
      field('resolvedAt', 'Resolved At', 'date', 'human_preserved'),
    ],
  }),
  normalizeStockPreparationMvpTableTemplate({
    id: 'plm.stock-preparation.run.v1',
    objectId: 'plm_stock_preparation_run',
    label: 'Stock Preparation Sync/Generation Run',
    version: 'v1',
    role: 'run_record',
    keyFields: ['runId'],
    requiredFields: ['runId', 'runType', 'status', 'startedAt'],
    fields: [
      field('runId', 'Run ID', 'string', 'plm_system', { required: true, key: true }),
      field('runType', 'Run Type', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_run_type_v1' },
      }),
      field('status', 'Status', 'select', 'plm_system', {
        required: true,
        optionSource: { type: 'contract', key: 'stock_preparation_run_status_v1' },
      }),
      field('startedAt', 'Started At', 'date', 'plm_system', { required: true }),
      field('finishedAt', 'Finished At', 'date', 'plm_system'),
      field('inputShape', 'Input Shape', 'string', 'plm_system'),
      field('resultShape', 'Result Shape', 'string', 'plm_system'),
      field('createdBy', 'Created By', 'string', 'plm_system'),
    ],
  }),
])

const STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS = Object.freeze(
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((template) => template.objectId),
)

module.exports = {
  STOCK_PREPARATION_FIELD_TYPES,
  STOCK_PREPARATION_FIELD_OWNERSHIPS,
  REQUIRED_SYSTEM_FIELDS,
  HUMAN_PRESERVED_FIELD_IDS,
  FEASIBILITY_FORBIDDEN_MECHANISMS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
  StockPreparationTemplateError,
  normalizeStockPreparationTemplate,
  normalizeStockPreparationMvpTableTemplate,
  normalizeBomReadFeasibilityGate,
  buildSheetStructureFromTemplate,
  buildSheetStructureFromMvpTableTemplate,
  summarizeTemplateForEvidence,
  summarizeMvpTableTemplatesForEvidence,
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
