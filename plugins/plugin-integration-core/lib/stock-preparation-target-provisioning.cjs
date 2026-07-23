'use strict'

// #2253 C1b-1: canonical stock-preparation target readiness/provisioning
// helper. Latent backend helper only: it creates/binds table metadata through
// the host provisioning API, never reads PLM, never writes MetaSheet rows, and
// never calls K3/external DB write paths.

const crypto = require('node:crypto')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
  HUMAN_PRESERVED_FIELD_IDS,
  buildSheetStructureFromTemplate,
} = require('./stock-preparation-templates.cjs')

// W2 canonical repair: namespace positive control for a repaired-in field.
const { assertExtensionFieldIdValid } = require('./stock-preparation-extension-namespace.cjs')

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
  if (!/^plm_stock_preparation_sandbox(?:$|[_-])/.test(objectId)) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'TARGET_SANDBOX_OBJECT_ID_INVALID',
      'sandbox stock-preparation target objectId must use the stock-preparation sandbox namespace',
      { reason: 'not_sandbox_namespace' },
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

// Shared REPAIR_MUTATED_EXISTING_FIELD guard (MVP + canonical): a pre-existing field
// whose name/type/property changed across the additive write is a contract violation —
// coarse details (objectId + count only; never echo field content).
function assertNoExistingFieldMutated(beforeContent, afterContent, objectId) {
  let mutated = 0
  for (const fieldId of Object.keys(beforeContent)) {
    const before = beforeContent[fieldId]
    const after = afterContent[fieldId]
    if (!after || JSON.stringify(before) !== JSON.stringify(after)) mutated += 1
  }
  if (mutated > 0) {
    throw new StockPreparationTargetProvisioningError(
      409,
      'REPAIR_MUTATED_EXISTING_FIELD',
      'repair mutated an existing field; the additive primitive must never touch a pre-existing column',
      { objectId, mutatedFieldCount: mutated },
    )
  }
}

// W2/P2-3 canonical repair runs its whole read/write/verify body inside ONE host
// transaction via runObjectFieldsRepairTransaction (atomic fail-close). The tx-bound
// surface it receives provides findObjectSheet/resolveExistingObjectFieldIds/
// readObjectFieldsContent/ensureMissingObjectFields — so the host must expose the
// transaction runner, not the bare per-call methods.
function getCanonicalRepairApi(context) {
  const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
  if (!provisioning || typeof provisioning.runObjectFieldsRepairTransaction !== 'function') {
    throw new StockPreparationTargetProvisioningError(
      503,
      'CANONICAL_REPAIR_API_UNAVAILABLE',
      'stock-preparation canonical repair requires multitable.provisioning.runObjectFieldsRepairTransaction (atomic repair)',
      { requiredMethods: ['runObjectFieldsRepairTransaction'] },
    )
  }
  return provisioning
}

// W2 template-evolution rung — canonical main-table repair. This is where the
// human-field-reject guard is LOAD-BEARING: the canonical main carries the 8
// HUMAN_PRESERVED_FIELD_IDS, so a repair that could add a human column would be a
// back door around the apply-writer ownership wall's vocab. Same discipline as the
// MVP repair: admin-gated, missing-set-only, plm_system/ext_ only, ensure's
// TARGET_SCHEMA_INCOMPLETE throw left untouched; existing columns untouched by the
// DO-NOTHING primitive (proven at the primitive layer, W2 realdb test).
async function repairStockPreparationCanonicalTarget(input = {}) {
  const context = input.context || {}
  const provisioning = getCanonicalRepairApi(context)
  assertAdminPermission(input.permission)
  const projectId = requiredString(input.projectId, 'projectId')
  // Repair ONLY heals against the FROZEN canonical template — input.template is
  // deliberately ignored so a caller can never inject an arbitrary field into the
  // additive primitive (review P2: repair must not be a field-injection vector;
  // unlike ensure, which legitimately takes a caller template for a fresh table).
  const template = normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const modePrefix = optionalString(input.modePrefix) || 'canonical'
  // ATOMIC repair (round-5 review P2-3): the entire read → additive-write → re-read →
  // verify sequence runs inside ONE host transaction. Any verify throw (mutated /
  // incomplete / concurrent-appeared) propagates out and ROLLS BACK the additive write —
  // this is a true atomic fail-close, not a post-commit detection canary. Pure prep (admin
  // gate above, template + ownership below) needs no tx; every DB touch goes through `tx`.
  const result = await provisioning.runObjectFieldsRepairTransaction(async (tx) => {
    const sheet = await tx.findObjectSheet({ projectId, objectId: template.objectId })
    if (!sheet) {
      throw new StockPreparationTargetProvisioningError(
        409,
        'CANONICAL_REPAIR_TARGET_ABSENT',
        'stock-preparation canonical repair requires an already-provisioned target',
        { objectId: template.objectId },
      )
    }
    const fieldIds = templateFieldIds(template)
    const resolved = await tx.resolveExistingObjectFieldIds({ projectId, objectId: template.objectId, fieldIds })
    const missingIds = missingLogicalFields(template, resolved)
    // BEFORE snapshot of the EXISTING fields' content (name/type/property/order) — the
    // REPAIR_MUTATED_EXISTING_FIELD control (design lock §3.3-4): the additive write must
    // not touch any pre-existing column. Now inside the SAME transaction as the write and
    // the after-snapshot, so a throw rolls the write back (atomic fail-close).
    const existingIds = fieldIds.filter((id) => !missingIds.includes(id))
    const beforeContent = await tx.readObjectFieldsContent({ projectId, objectId: template.objectId, fieldIds: existingIds })
    const humanSet = new Set(HUMAN_PRESERVED_FIELD_IDS)
    const descriptor = buildStockPreparationTargetDescriptor({ template, description: input.description })
    const ownershipById = new Map(template.fields.map((field) => [field.id, field.ownership]))
    const missingDescriptors = []
    for (const id of missingIds) {
      const ownership = ownershipById.get(id)
      if (humanSet.has(id) || ownership === 'human_preserved') {
        throw new StockPreparationTargetProvisioningError(
          422,
          'REPAIR_HUMAN_FIELD_FORBIDDEN',
          'repair may not add a human_preserved column; grow the human whitelist through its own design gate',
          { objectId: template.objectId, fieldId: id },
        )
      }
      if (ownership !== 'plm_system') {
        assertExtensionFieldIdValid(id, { templateFieldIds: fieldIds })
      }
      const found = descriptor.fields.find((field) => field.id === id)
      if (found) missingDescriptors.push(found)
    }
    const writeResult = await tx.ensureMissingObjectFields({
      projectId,
      objectId: template.objectId,
      fields: missingDescriptors,
    })
    // CONCURRENCY fail-close (round-5 review P2): we submitted ONLY this round's missing
    // set, so a skipped-existing id means a competing writer inserted that column between
    // our resolve and our write. We neither added it nor content-verified its row against
    // the frozen descriptor, so `ready` would be UNPROVEN (id-exists ≠ shape-correct). Fail
    // closed — repair is idempotent, a retry after the race settles re-verifies.
    if (writeResult.skippedExistingFieldIds.length) {
      throw new StockPreparationTargetProvisioningError(
        409,
        'REPAIR_CONCURRENT_FIELD_APPEARED',
        'a missing field was inserted by a concurrent writer during repair; retry after it settles',
        { objectId: template.objectId, skippedExistingFieldCount: writeResult.skippedExistingFieldIds.length },
      )
    }
    // POST-WRITE completeness re-verify: `ready:true` must be PROVEN, never asserted.
    const resolvedAfter = await tx.resolveExistingObjectFieldIds({ projectId, objectId: template.objectId, fieldIds })
    const stillMissing = missingLogicalFields(template, resolvedAfter)
    if (stillMissing.length) {
      throw new StockPreparationTargetProvisioningError(
        409,
        'CANONICAL_REPAIR_INCOMPLETE',
        'canonical repair did not reach a complete schema; a field is still missing after the additive write',
        { objectId: template.objectId, missingFieldCount: stillMissing.length },
      )
    }
    // AFTER snapshot: every pre-existing field must be byte-for-byte unchanged.
    assertNoExistingFieldMutated(beforeContent, await tx.readObjectFieldsContent({ projectId, objectId: template.objectId, fieldIds: existingIds }), template.objectId)
    return writeResult
  })
  return {
    ready: true,
    mode: result.addedFieldIds.length > 0 ? `${modePrefix}_repaired` : `${modePrefix}_already_ready`,
    evidence: {
      action: 'stock_preparation_canonical_repair',
      mode: result.addedFieldIds.length > 0 ? `${modePrefix}_repaired` : `${modePrefix}_already_ready`,
      addedFieldCount: result.addedFieldIds.length,
      skippedExistingFieldCount: result.skippedExistingFieldIds.length,
      schemaCompleteAfter: true,
      templateVersion: template.version,
    },
  }
}

module.exports = {
  CANONICAL_FIELD_MAP_MODE,
  repairStockPreparationCanonicalTarget,
  SANDBOX_FIELD_MAP_MODE,
  CANONICAL_KEY_FIELD,
  REQUIRED_PERMISSION,
  StockPreparationTargetProvisioningError,
  buildStockPreparationTargetDescriptor,
  summarizeStockPreparationTargetReadiness,
  hashEvidenceValue,
  sandboxStockPreparationTemplate,
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
    assertNoExistingFieldMutated,
  },
}
