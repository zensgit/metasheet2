'use strict'

// #2253 C1b-1: canonical stock-preparation target readiness/provisioning
// helper. Latent backend helper only: it creates/binds table metadata through
// the host provisioning API, never reads PLM, never writes MetaSheet rows, and
// never calls K3/external DB write paths.

const crypto = require('node:crypto')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
  buildSheetStructureFromTemplate,
} = require('./stock-preparation-templates.cjs')

const CANONICAL_FIELD_MAP_MODE = 'canonical'
const SANDBOX_FIELD_MAP_MODE = 'sandbox'
const CANONICAL_KEY_FIELD = 'idempotencyKey'
const REQUIRED_PERMISSION = 'admin'

class StockPreparationTargetProvisioningError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationTargetProvisioningError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationTargetProvisioningError(422, 'TARGET_PROVISIONING_CONFIG_INVALID', `${field} is required`, {
      field,
    })
  }
  return normalized
}

function hashEvidenceValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function assertSandboxObjectId(value, field = 'objectId') {
  const objectId = requiredString(value, field)
  if (objectId === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'TARGET_SANDBOX_OBJECT_ID_INVALID',
      'sandbox stock-preparation target objectId must not be the production canonical target',
      { reason: 'prod_canonical' },
    )
  }
  return objectId
}

function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationTargetProvisioningError(
      403,
      'TARGET_PROVISIONING_PERMISSION_DENIED',
      'stock-preparation target provisioning requires admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

function getProvisioningApi(context) {
  const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
  if (
    !provisioning ||
    typeof provisioning.findObjectSheet !== 'function' ||
    typeof provisioning.resolveFieldIds !== 'function' ||
    typeof provisioning.ensureObject !== 'function'
  ) {
    throw new StockPreparationTargetProvisioningError(
      503,
      'TARGET_PROVISIONING_API_UNAVAILABLE',
      'C1b target provisioning requires multitable.provisioning API',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds', 'ensureObject'] },
    )
  }
  return provisioning
}

function templateFieldIds(template) {
  return template.fields.map((field) => field.id)
}

function templateFieldCounts(template) {
  return {
    total: template.fields.length,
    plmSystem: template.fields.filter((field) => field.ownership === 'plm_system').length,
    humanPreserved: template.fields.filter((field) => field.ownership === 'human_preserved').length,
    required: template.fields.filter((field) => field.required === true).length,
  }
}

function buildFieldProperty(templateField, structureField) {
  const property = cloneJson(structureField.property || {})
  property.stockPreparation = {
    ownership: templateField.ownership,
    preserveOnRefresh: templateField.preserveOnRefresh === true,
    required: templateField.required === true,
    key: templateField.key === true,
  }
  if (templateField.optionSource) {
    property.stockPreparation.optionSource = { ...templateField.optionSource }
  }
  return property
}

function stockPreparationTemplateForObject(input = {}) {
  const objectId = requiredString(input.objectId, 'objectId')
  const label = optionalString(input.label) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.label
  return normalizeStockPreparationTemplate({
    ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    id: input.id || `${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.id}.${hashEvidenceValue(objectId)}`,
    objectId,
    label,
  })
}

function sandboxStockPreparationTemplate(input = {}) {
  const objectId = assertSandboxObjectId(input.objectId)
  return stockPreparationTemplateForObject({
    objectId,
    label: optionalString(input.label) || 'PLM Stock Preparation Sandbox',
  })
}

function buildStockPreparationTargetDescriptor(input = {}) {
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const structure = buildSheetStructureFromTemplate(template)
  const templateById = new Map(template.fields.map((field) => [field.id, field]))
  return {
    id: structure.objectId,
    name: structure.label,
    description: optionalString(input.description) || 'Canonical PLM stock-preparation target generated from the C1 manifest.',
    fields: structure.fields.map((field) => {
      const templateField = templateById.get(field.id)
      return {
        id: field.id,
        name: field.name,
        type: field.type,
        order: field.order,
        property: buildFieldProperty(templateField, field),
      }
    }),
  }
}

function buildCanonicalTargetBinding({ sheetId, objectId, fieldIdMap = {} }) {
  return {
    sheetId,
    objectId,
    keyField: CANONICAL_KEY_FIELD,
    fieldIdMap,
  }
}

function summarizeStockPreparationTargetReadiness(input = {}) {
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const missingFields = Array.isArray(input.missingFields)
    ? input.missingFields.map((field) => String(field)).filter(Boolean)
    : []
  const mode = optionalString(input.mode) || (missingFields.length ? 'canonical_incomplete' : 'canonical_unchecked')
  const status = optionalString(input.status) || 'not_ready'
  const includeObjectId = input.includeObjectId !== false
  return {
    status,
    mode,
    ...(includeObjectId ? { objectId: template.objectId } : { objectIdHash: hashEvidenceValue(template.objectId) }),
    fieldMapMode: optionalString(input.fieldMapMode) || CANONICAL_FIELD_MAP_MODE,
    keyField: CANONICAL_KEY_FIELD,
    fieldCounts: templateFieldCounts(template),
    missingFields,
    optionSources: template.fields
      .filter((field) => field.optionSource)
      .map((field) => ({
        field: field.id,
        type: field.optionSource.type,
        key: field.optionSource.key,
      })),
    target: {
      ...(includeObjectId ? { objectId: template.objectId } : { objectIdHash: hashEvidenceValue(template.objectId) }),
      keyField: CANONICAL_KEY_FIELD,
      fieldIdMapEmpty: input.fieldIdMapEmpty !== false,
    },
  }
}

function missingLogicalFields(template, resolvedFieldIds = {}) {
  return templateFieldIds(template).filter((fieldId) => !optionalString(resolvedFieldIds[fieldId]))
}

async function inspectStockPreparationCanonicalTarget(input = {}) {
  return inspectStockPreparationTarget({
    ...input,
    template: normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE),
    modePrefix: 'canonical',
    fieldMapMode: CANONICAL_FIELD_MAP_MODE,
    includeObjectId: true,
  })
}

async function inspectStockPreparationSandboxTarget(input = {}) {
  return inspectStockPreparationTarget({
    ...input,
    template: sandboxStockPreparationTemplate(input),
    modePrefix: 'sandbox',
    fieldMapMode: SANDBOX_FIELD_MAP_MODE,
    includeObjectId: false,
  })
}

async function inspectStockPreparationTarget(input = {}) {
  const context = input.context || {}
  const provisioning = getProvisioningApi(context)
  assertAdminPermission(input.permission)
  const projectId = requiredString(input.projectId, 'projectId')
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const modePrefix = optionalString(input.modePrefix) || 'canonical'
  const fieldMapMode = optionalString(input.fieldMapMode) || CANONICAL_FIELD_MAP_MODE
  const includeObjectId = input.includeObjectId !== false
  const sheet = await provisioning.findObjectSheet({ projectId, objectId: template.objectId })
  if (!sheet) {
    return {
      ready: false,
      mode: `${modePrefix}_missing`,
      target: null,
      evidence: summarizeStockPreparationTargetReadiness({
        template,
        mode: `${modePrefix}_missing`,
        status: 'missing',
        missingFields: templateFieldIds(template),
        fieldMapMode,
        includeObjectId,
      }),
    }
  }
  const resolved = await provisioning.resolveFieldIds({
    projectId,
    objectId: template.objectId,
    fieldIds: templateFieldIds(template),
  })
  const missingFields = missingLogicalFields(template, resolved)
  if (missingFields.length) {
    return {
      ready: false,
      mode: `${modePrefix}_incomplete`,
      target: null,
      evidence: summarizeStockPreparationTargetReadiness({
        template,
        mode: `${modePrefix}_incomplete`,
        status: 'not_ready',
        missingFields,
        fieldMapMode,
        includeObjectId,
      }),
    }
  }
  return {
    ready: true,
    mode: `${modePrefix}_existing`,
    target: buildCanonicalTargetBinding({ sheetId: sheet.id, objectId: template.objectId, fieldIdMap: resolved }),
    evidence: summarizeStockPreparationTargetReadiness({
      template,
      mode: `${modePrefix}_existing`,
      status: 'ready',
      missingFields: [],
      fieldIdMapEmpty: false,
      fieldMapMode,
      includeObjectId,
    }),
  }
}

async function ensureStockPreparationCanonicalTarget(input = {}) {
  return ensureStockPreparationTarget({
    ...input,
    template: normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE),
    modePrefix: 'canonical',
    fieldMapMode: CANONICAL_FIELD_MAP_MODE,
    includeObjectId: true,
    description: 'Canonical PLM stock-preparation target generated from the C1 manifest.',
    incompleteMessage: 'canonical stock-preparation target is missing manifest fields',
    createdIncompleteMessage: 'created stock-preparation target is missing manifest fields',
    incompleteDetails: (template, inspected) => ({
      targetObjectId: template.objectId,
      fieldMapMode: CANONICAL_FIELD_MAP_MODE,
      missingFields: inspected.evidence.missingFields,
      requiredFields: templateFieldIds(template),
    }),
    createdIncompleteDetails: (template, missingFields) => ({
      targetObjectId: template.objectId,
      fieldMapMode: CANONICAL_FIELD_MAP_MODE,
      missingFields,
      requiredFields: templateFieldIds(template),
    }),
  })
}

async function ensureStockPreparationSandboxTarget(input = {}) {
  const template = sandboxStockPreparationTemplate(input)
  return ensureStockPreparationTarget({
    ...input,
    template,
    modePrefix: 'sandbox',
    fieldMapMode: SANDBOX_FIELD_MAP_MODE,
    includeObjectId: false,
    description: 'Sandbox PLM stock-preparation target for validation only.',
    incompleteMessage: 'sandbox stock-preparation target is missing manifest fields',
    createdIncompleteMessage: 'created sandbox stock-preparation target is missing manifest fields',
    incompleteDetails: (normalizedTemplate, inspected) => ({
      targetObjectIdHash: hashEvidenceValue(normalizedTemplate.objectId),
      fieldMapMode: SANDBOX_FIELD_MAP_MODE,
      missingFields: inspected.evidence.missingFields,
      requiredFields: templateFieldIds(normalizedTemplate),
    }),
    createdIncompleteDetails: (normalizedTemplate, missingFields) => ({
      targetObjectIdHash: hashEvidenceValue(normalizedTemplate.objectId),
      fieldMapMode: SANDBOX_FIELD_MAP_MODE,
      missingFields,
      requiredFields: templateFieldIds(normalizedTemplate),
    }),
  })
}

async function ensureStockPreparationTarget(input = {}) {
  const context = input.context || {}
  const provisioning = getProvisioningApi(context)
  assertAdminPermission(input.permission)
  const projectId = requiredString(input.projectId, 'projectId')
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const modePrefix = optionalString(input.modePrefix) || 'canonical'
  const fieldMapMode = optionalString(input.fieldMapMode) || CANONICAL_FIELD_MAP_MODE
  const includeObjectId = input.includeObjectId !== false
  const inspected = await inspectStockPreparationTarget({
    context,
    projectId,
    permission: input.permission,
    template,
    modePrefix,
    fieldMapMode,
    includeObjectId,
  })
  if (inspected.ready) return inspected
  if (inspected.mode === `${modePrefix}_incomplete`) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'TARGET_SCHEMA_INCOMPLETE',
      input.incompleteMessage || 'stock-preparation target is missing manifest fields',
      typeof input.incompleteDetails === 'function'
        ? input.incompleteDetails(template, inspected)
        : {
            fieldMapMode,
            missingFields: inspected.evidence.missingFields,
            requiredFields: templateFieldIds(template),
          },
    )
  }

  const ensured = await provisioning.ensureObject({
    projectId,
    baseId: input.baseId || null,
    descriptor: buildStockPreparationTargetDescriptor({ template, description: input.description }),
  })
  const resolvedAfterCreate = await provisioning.resolveFieldIds({
    projectId,
    objectId: template.objectId,
    fieldIds: templateFieldIds(template),
  })
  const missingFields = missingLogicalFields(template, resolvedAfterCreate)
  if (missingFields.length) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'TARGET_SCHEMA_INCOMPLETE',
      input.createdIncompleteMessage || 'created stock-preparation target is missing manifest fields',
      typeof input.createdIncompleteDetails === 'function'
        ? input.createdIncompleteDetails(template, missingFields)
        : {
            fieldMapMode,
            missingFields,
            requiredFields: templateFieldIds(template),
          },
    )
  }
  return {
    ready: true,
    mode: `${modePrefix}_create`,
    target: buildCanonicalTargetBinding({ sheetId: ensured.sheet.id, objectId: template.objectId, fieldIdMap: resolvedAfterCreate }),
    evidence: summarizeStockPreparationTargetReadiness({
      template,
      mode: `${modePrefix}_create`,
      status: 'ready',
      missingFields: [],
      fieldIdMapEmpty: false,
      fieldMapMode,
      includeObjectId,
    }),
  }
}

module.exports = {
  CANONICAL_FIELD_MAP_MODE,
  SANDBOX_FIELD_MAP_MODE,
  CANONICAL_KEY_FIELD,
  REQUIRED_PERMISSION,
  StockPreparationTargetProvisioningError,
  buildStockPreparationTargetDescriptor,
  summarizeStockPreparationTargetReadiness,
  inspectStockPreparationCanonicalTarget,
  inspectStockPreparationSandboxTarget,
  ensureStockPreparationCanonicalTarget,
  ensureStockPreparationSandboxTarget,
  __internals: {
    isPlainObject,
    templateFieldIds,
    templateFieldCounts,
    missingLogicalFields,
    buildCanonicalTargetBinding,
    hashEvidenceValue,
    sandboxStockPreparationTemplate,
    assertAdminPermission,
    getProvisioningApi,
  },
}
