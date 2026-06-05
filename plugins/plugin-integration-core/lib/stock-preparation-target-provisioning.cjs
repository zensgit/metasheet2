'use strict'

// #2253 C1b-1: canonical stock-preparation target readiness/provisioning
// helper. Latent backend helper only: it creates/binds table metadata through
// the host provisioning API, never reads PLM, never writes MetaSheet rows, and
// never calls K3/external DB write paths.

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
  buildSheetStructureFromTemplate,
} = require('./stock-preparation-templates.cjs')

const CANONICAL_FIELD_MAP_MODE = 'canonical'
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

function buildStockPreparationTargetDescriptor(input = {}) {
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const structure = buildSheetStructureFromTemplate(template)
  const templateById = new Map(template.fields.map((field) => [field.id, field]))
  return {
    id: structure.objectId,
    name: structure.label,
    description: 'Canonical PLM stock-preparation target generated from the C1 manifest.',
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
  return {
    status,
    mode,
    objectId: template.objectId,
    fieldMapMode: CANONICAL_FIELD_MAP_MODE,
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
      objectId: template.objectId,
      keyField: CANONICAL_KEY_FIELD,
      fieldIdMapEmpty: input.fieldIdMapEmpty !== false,
    },
  }
}

function missingLogicalFields(template, resolvedFieldIds = {}) {
  return templateFieldIds(template).filter((fieldId) => !optionalString(resolvedFieldIds[fieldId]))
}

async function inspectStockPreparationCanonicalTarget(input = {}) {
  const context = input.context || {}
  const provisioning = getProvisioningApi(context)
  assertAdminPermission(input.permission)
  const projectId = requiredString(input.projectId, 'projectId')
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const sheet = await provisioning.findObjectSheet({ projectId, objectId: template.objectId })
  if (!sheet) {
    return {
      ready: false,
      mode: 'canonical_missing',
      target: null,
      evidence: summarizeStockPreparationTargetReadiness({
        template,
        mode: 'canonical_missing',
        status: 'missing',
        missingFields: templateFieldIds(template),
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
      mode: 'canonical_incomplete',
      target: null,
      evidence: summarizeStockPreparationTargetReadiness({
        template,
        mode: 'canonical_incomplete',
        status: 'not_ready',
        missingFields,
      }),
    }
  }
  return {
    ready: true,
    mode: 'canonical_existing',
    target: buildCanonicalTargetBinding({ sheetId: sheet.id, objectId: template.objectId, fieldIdMap: resolved }),
    evidence: summarizeStockPreparationTargetReadiness({
      template,
      mode: 'canonical_existing',
      status: 'ready',
      missingFields: [],
      fieldIdMapEmpty: false,
    }),
  }
}

async function ensureStockPreparationCanonicalTarget(input = {}) {
  const context = input.context || {}
  const provisioning = getProvisioningApi(context)
  assertAdminPermission(input.permission)
  const projectId = requiredString(input.projectId, 'projectId')
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const inspected = await inspectStockPreparationCanonicalTarget({
    context,
    projectId,
    permission: input.permission,
    template,
  })
  if (inspected.ready) return inspected
  if (inspected.mode === 'canonical_incomplete') {
    throw new StockPreparationTargetProvisioningError(
      422,
      'TARGET_SCHEMA_INCOMPLETE',
      'canonical stock-preparation target is missing manifest fields',
      {
        targetObjectId: template.objectId,
        fieldMapMode: CANONICAL_FIELD_MAP_MODE,
        missingFields: inspected.evidence.missingFields,
        requiredFields: templateFieldIds(template),
      },
    )
  }

  const ensured = await provisioning.ensureObject({
    projectId,
    baseId: input.baseId || null,
    descriptor: buildStockPreparationTargetDescriptor({ template }),
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
      'created stock-preparation target is missing manifest fields',
      {
        targetObjectId: template.objectId,
        fieldMapMode: CANONICAL_FIELD_MAP_MODE,
        missingFields,
        requiredFields: templateFieldIds(template),
      },
    )
  }
  return {
    ready: true,
    mode: 'canonical_create',
    target: buildCanonicalTargetBinding({ sheetId: ensured.sheet.id, objectId: template.objectId, fieldIdMap: resolvedAfterCreate }),
    evidence: summarizeStockPreparationTargetReadiness({
      template,
      mode: 'canonical_create',
      status: 'ready',
      missingFields: [],
      fieldIdMapEmpty: false,
    }),
  }
}

module.exports = {
  CANONICAL_FIELD_MAP_MODE,
  CANONICAL_KEY_FIELD,
  REQUIRED_PERMISSION,
  StockPreparationTargetProvisioningError,
  buildStockPreparationTargetDescriptor,
  summarizeStockPreparationTargetReadiness,
  inspectStockPreparationCanonicalTarget,
  ensureStockPreparationCanonicalTarget,
  __internals: {
    isPlainObject,
    templateFieldIds,
    templateFieldCounts,
    missingLogicalFields,
    buildCanonicalTargetBinding,
    assertAdminPermission,
    getProvisioningApi,
  },
}
