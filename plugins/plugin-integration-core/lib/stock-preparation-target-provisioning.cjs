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
  resolveTemplateLabelLocale,
  pickDefaultViewName,
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

/**
 * THE one authority on "is this a stock-preparation SANDBOX target objectId".
 *
 * Exported (not merely `__internals`) because the customer-pack normalizer now
 * validates a pack's declared `targetObjectId` through this exact function. Two
 * modules asking "is this a sandbox target?" must never be able to answer
 * differently, and a copied regex is how they start to.
 *
 * Two refusals, both fail-closed, both reported through the closed `reason`
 * vocabulary on `.details`:
 *   prod_canonical        — the production canonical target is not a sandbox one
 *   not_sandbox_namespace — anything outside `plm_stock_preparation_sandbox*`
 */
// The sandbox namespace, named once so the guard, the refusal message and any caller quoting it in
// a runbook can never drift apart.
const SANDBOX_OBJECT_ID_NAMESPACE = 'plm_stock_preparation_sandbox'
// The namespace RULE, as one pattern rather than as a regex literal typed at each use site. The
// assert below and `isSandboxNamespaceObjectId` are the only two readers, so the two can never
// disagree about what "in the namespace" means.
const SANDBOX_OBJECT_ID_NAMESPACE_PATTERN = /^plm_stock_preparation_sandbox(?:$|[_-])/

/**
 * The same rule as `assertSandboxObjectId`'s namespace clause, as a PURE PREDICATE.
 *
 * Why a predicate and not just the assert: a caller that is FILTERING rather than validating must
 * not have to throw-and-catch per entry, and — more importantly — it must not have to re-type the
 * regex. The deployment preflight filters the sandbox write allowlist through this before any of it
 * reaches a response, because that allowlist comes from raw `process.env` and nothing upstream
 * constrains what a polluted environment can put there.
 *
 * DELIBERATELY NARROWER THAN THE ASSERT in one respect: it answers only the namespace question and
 * says nothing about the production canonical target, which IS an identifier and is safe to display.
 * `assertSandboxObjectId` refuses that id for a different reason (it is not a sandbox target), and
 * conflating the two would make the preflight report a legitimate constant as pollution.
 */
function isSandboxNamespaceObjectId(value) {
  return typeof value === 'string' && SANDBOX_OBJECT_ID_NAMESPACE_PATTERN.test(value)
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
  if (!SANDBOX_OBJECT_ID_NAMESPACE_PATTERN.test(objectId)) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'TARGET_SANDBOX_OBJECT_ID_INVALID',
      // NAME THE NAMESPACE. The refusal used to say only that the objectId was outside the sandbox
      // namespace, without saying what that namespace IS -- so the caller learns they are wrong and
      // still has to read this file to find out what would be right. A namespace prefix is a
      // deployment-authored constant, not customer data, so quoting it leaks nothing and turns a
      // dead end into a copy-paste fix. The offending value is NOT echoed: it is caller-supplied
      // and could carry anything.
      `sandbox stock-preparation target objectId must use the stock-preparation sandbox namespace `
        + `(it must be "${SANDBOX_OBJECT_ID_NAMESPACE}" or start with "${SANDBOX_OBJECT_ID_NAMESPACE}_")`,
      { reason: 'not_sandbox_namespace', requiredNamespace: SANDBOX_OBJECT_ID_NAMESPACE },
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
  // A caller that renames the sheet supplies BOTH names or neither. The spread below
  // would otherwise carry the canonical Chinese name onto a differently-named object --
  // which is exactly how a SANDBOX table would end up displaying 备料主表 to an operator
  // who then cannot tell it from the production canonical one. So the inherited Chinese
  // name survives only while the English name is also the inherited one.
  const labelZh = optionalString(input.labelZh)
    || (label === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.label ? STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.labelZh : null)
  return normalizeStockPreparationTemplate({
    ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    id: input.id || `${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.id}.${hashEvidenceValue(objectId)}`,
    objectId,
    label,
    labelZh: labelZh || undefined,
  })
}

function sandboxStockPreparationTemplate(input = {}) {
  const objectId = assertSandboxObjectId(input.objectId)
  return stockPreparationTemplateForObject({
    objectId,
    label: optionalString(input.label) || 'PLM Stock Preparation Sandbox',
    // The sandbox marker is part of the NAME in BOTH languages. A Chinese-labelled
    // deployment must be no more able to mistake this table for the production
    // canonical one than an English-labelled one is.
    labelZh: optionalString(input.labelZh) || '备料主表(沙箱)',
  })
}

// CREATION-TIME display language. `input.locale` defaults to the deployment setting,
// which is `en` unless a deployment opted in -- so with it unset this descriptor is
// byte-identical to what it has always been. It decides only the human `name` of the
// sheet and of each column; ids, types, order and property are untouched by it, and
// nothing here can rename a column that already exists (see ensureStockPreparationTarget:
// an existing object is either already ready or refused, never re-described).
function buildStockPreparationTargetDescriptor(input = {}) {
  const template = normalizeStockPreparationTemplate(input.template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const locale = input.locale === undefined ? resolveTemplateLabelLocale() : input.locale
  const structure = buildSheetStructureFromTemplate(template, { locale })
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
    // Which probe answered "does this field exist" — 'db' (real read of meta_fields),
    // 'computed' (older host without the W2 read), or 'computed_scope_unavailable' (the object is
    // not claimed in the plugin object registry). Only 'db' can actually detect template drift, so
    // a deployment that cares about drift asserts on this rather than trusting a bare `ready`.
    ...(optionalString(input.fieldExistenceMode) ? { fieldExistenceMode: input.fieldExistenceMode } : {}),
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

/**
 * The tenant `ext_` columns a caller wants BOUND in the returned fieldIdMap,
 * on top of the frozen template's own.
 *
 * A pack's extension columns are installed by the pack installer, not by this
 * module, so this list only ever says "resolve these too" — it never creates a
 * column. Every entry is validated against the frozen catalog, so a caller
 * cannot smuggle a canonical id (or a content-key-shaped one) in through this
 * door and have it treated as an extension.
 */
function normalizeExtensionFieldIds(input, template) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'TARGET_SCHEMA_INCOMPLETE',
      'extensionFieldIds must be an array of tenant extension field ids',
      { field: 'extensionFieldIds' },
    )
  }
  const catalog = templateFieldIds(template)
  const seen = new Set()
  const out = []
  for (const fieldId of input) {
    assertExtensionFieldIdValid(fieldId, { templateFieldIds: catalog })
    if (seen.has(fieldId)) continue
    seen.add(fieldId)
    out.push(fieldId)
  }
  return out
}

// `extraFieldIds` carries the tenant extension ids. An `ext_` column that the
// caller asked to bind but that does not resolve makes the target NOT READY —
// the same fail-closed posture the template's own columns already had, and the
// reason a downstream `ext_` write can now be a hard failure instead of a silent
// fallback to the raw logical id.
function missingLogicalFields(template, resolvedFieldIds = {}, extraFieldIds = []) {
  return templateFieldIds(template)
    .concat(Array.isArray(extraFieldIds) ? extraFieldIds : [])
    .filter((fieldId) => !optionalString(resolvedFieldIds[fieldId]))
}

/**
 * The object-scope refusal the DB-backed existence read can raise and the compute-only one cannot.
 * Matched by name/code rather than instanceof: the class lives in the HOST
 * (`packages/core-backend/src/multitable/plugin-scope.ts:73-82`) and is not importable from a
 * plugin. It carries no `status`, so letting it escape turns a readiness read into an opaque 500/503.
 */
function isObjectScopeError(error) {
  if (!error) return false
  return error.name === 'MultitableObjectScopeError' || error.code === 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN'
}

/**
 * The field-existence probe every `*_incomplete` verdict below rests on.
 *
 * WHY THIS EXISTS: `provisioning.resolveFieldIds` is COMPUTE-ONLY — it derives a stable id for each
 * requested field and never omits one (`resolveObjectFieldIds`,
 * `packages/core-backend/src/multitable/provisioning.ts:182-192`; the host says so itself at
 * `packages/core-backend/src/index.ts:817-819`). So `missingLogicalFields` against that map is
 * ALWAYS empty, and every drift verdict in this module was unreachable on a real host: a sheet
 * provisioned by an older template reported `ready` and handed back a fieldIdMap naming physical
 * columns that do not exist, and the drift only surfaced much later as an opaque host
 * `VALIDATION_ERROR: Unknown fieldId` when a write finally addressed one of them. The host's
 * DB-backed `resolveExistingObjectFieldIds` omits fields genuinely absent from `meta_fields`, which
 * is what makes the verdict real.
 *
 * CAPABILITY-DETECTED, NOT REQUIRED: it stays out of `getProvisioningApi`'s required-method gate so
 * an older host — and every provisioning fake in the test-suite — falls back to the compute-only map
 * and keeps today's behaviour byte-for-byte. The answering probe travels in evidence as
 * `fieldExistenceMode` so a deployment can prove which one spoke rather than assume.
 *
 * SCOPE REFUSAL DEGRADES, IT DOES NOT FAIL: the DB read carries an object-scope assertion the
 * compute-only path never had (`plugin-scope.ts:266-274`), and an object this plugin never claimed
 * in `plugin_multitable_object_registry` — a hand-made or dump-restored sheet — would otherwise turn
 * a working readiness read into an opaque failure. Degrading to the compute-only probe is exactly
 * today's behaviour, and the distinct mode keeps the degradation observable instead of silent.
 */
async function resolveFieldExistence({ provisioning, projectId, objectId, fieldIds }) {
  if (typeof provisioning.resolveExistingObjectFieldIds === 'function') {
    try {
      return {
        resolved: await provisioning.resolveExistingObjectFieldIds({ projectId, objectId, fieldIds }),
        fieldExistenceMode: 'db',
      }
    } catch (error) {
      if (!isObjectScopeError(error)) throw error
      return {
        resolved: await provisioning.resolveFieldIds({ projectId, objectId, fieldIds }),
        fieldExistenceMode: 'computed_scope_unavailable',
      }
    }
  }
  return {
    resolved: await provisioning.resolveFieldIds({ projectId, objectId, fieldIds }),
    fieldExistenceMode: 'computed',
  }
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
  const extensionFieldIds = normalizeExtensionFieldIds(input.extensionFieldIds, template)
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
        missingFields: templateFieldIds(template).concat(extensionFieldIds),
        fieldMapMode,
        includeObjectId,
      }),
    }
  }
  const { resolved, fieldExistenceMode } = await resolveFieldExistence({
    provisioning,
    projectId,
    objectId: template.objectId,
    fieldIds: templateFieldIds(template).concat(extensionFieldIds),
  })
  const missingFields = missingLogicalFields(template, resolved, extensionFieldIds)
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
        fieldExistenceMode,
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
      fieldExistenceMode,
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

// THE one place a stock-preparation managed table gets its default view. A multitable
// base renders each sheet's default view, so a sheet with ZERO views cannot be opened --
// and one unopenable sheet blocks the entire base. Measured on the first real deployment:
// the pack-installed sandbox had 3 role views (created by the pack) and opened; the
// ledger, the canonical main and a second sandbox each had 0 views, and the base stayed
// unopenable until three grid views were inserted by hand.
//
// NEVER-TOUCH-EXISTING-VIEWS: the host primitive writes only when the sheet has no views
// at all. A sheet that already carries views -- the pack's three role views above -- is
// left completely alone: not appended to, not renamed, not reordered. This helper adds
// nothing to that guarantee and cannot weaken it; it only names the view and reports.
//
// OPTIONAL CAPABILITY: an older host without `ensureObjectDefaultView` is not a failure.
// Provisioning proceeds exactly as it does today and the evidence says so, so a plugin
// newer than its host still installs the tables it always installed.
async function ensureManagedTableDefaultView({ provisioning, projectId, objectId, viewKind, locale } = {}) {
  if (!provisioning || typeof provisioning.ensureObjectDefaultView !== 'function') {
    return { created: false, skipped: 'api_unavailable' }
  }
  const result = await provisioning.ensureObjectDefaultView({
    projectId,
    objectId,
    name: pickDefaultViewName(viewKind, { locale }),
  })
  const existingViewCount = Number(result && result.existingViewCount) || 0
  if (result && result.created === true) return { created: true, skipped: null }
  return { created: false, skipped: existingViewCount > 0 ? 'existing_views' : 'concurrent_create' }
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
    // Forwarded, NOT applied to the create path below: `ensureObject` builds the
    // object from the frozen template descriptor and cannot create a pack's
    // `ext_` columns (the pack installer does that, separately). So an already
    // pack-installed target binds its extension columns here, while a
    // freshly-created one honestly reports a map without them — and the
    // table-action completeness gate is what refuses to write until they exist.
    extensionFieldIds: input.extensionFieldIds,
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
    descriptor: buildStockPreparationTargetDescriptor({ template, description: input.description, locale: input.locale }),
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
  // Created tables are created USABLE: the fresh sheet gets its one grid view, named in
  // the same language its sheet name and columns just got. Only the CREATE path does
  // this -- the already-ready path above returned before any write and still does, so an
  // existing deployment's tables (hand-renamed headers, hand-created views) are provisioned
  // exactly as they are today.
  const defaultView = await ensureManagedTableDefaultView({
    provisioning,
    projectId,
    objectId: template.objectId,
    viewKind: 'records',
    locale: input.locale,
  })
  return {
    ready: true,
    mode: `${modePrefix}_create`,
    defaultView,
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

/**
 * MAY REPAIR ADD THIS COLUMN? -- the ownership half of the additive heal path.
 *
 * Extracted from the repair transaction deliberately: as an inline branch inside a
 * closure the rule could only be exercised through a mocked host, so three of its four
 * cases were untestable and in practice untested. As a pure predicate every case has a
 * direct witness.
 *
 * THE HUMAN-COLUMN RULE, NARROWED -- the one deliberate loosening in this change.
 *
 * WAS: every human_preserved column was refused, unconditionally. That made the frozen
 * template's human band UNHEALABLE. `ensureStockPreparationTarget` throws
 * TARGET_SCHEMA_INCOMPLETE the moment the template carries a column an existing sheet
 * lacks, and repair -- the designated heal path that #5431/#5436 used for their template
 * growth -- was the only additive verb, and it refused. Growing the human band therefore
 * had no migration path at all: every existing install would have started failing
 * `ensure` with no way to heal.
 *
 * NOW: a human column may be healed IF AND ONLY IF the frozen template and the
 * design-gated whitelist AGREE about it. The property the original guard actually
 * protected is preserved in full, because what it protected against was an ARBITRARY
 * human column, and that stays impossible for two independent reasons:
 *   1. `repairStockPreparationCanonicalTarget` IGNORES `input.template` and heals only
 *      against the frozen STOCK_PREPARATION_MAIN_TABLE_TEMPLATE, so the ids that can
 *      reach here are closed to that module and to no caller; and
 *   2. the id must ALSO appear in HUMAN_PRESERVED_FIELD_IDS -- the whitelist whose growth
 *      is the independent design gate (general-prep-execution-plan-20260722.md §3), and
 *      which is simultaneously the apply-writer's refusal vocabulary, the carry policy's
 *      carry set, the conflict-planner's drift check and the suggestion operators' target
 *      set. It cannot be grown quietly, or for one subsystem alone.
 *
 * So the back door stays shut: a human column present in the template but ABSENT from the
 * whitelist is still refused. The reverse disagreement -- whitelisted but not human in the
 * template -- is refused too, because it means the two authorities have drifted and
 * guessing which one is right is exactly how a load-bearing wall gets holed.
 */
function assertRepairableFieldOwnership({ fieldId, ownership, isWhitelisted, templateFieldIds, objectId } = {}) {
  const isHuman = ownership === 'human_preserved'
  if (isHuman !== isWhitelisted) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'REPAIR_HUMAN_FIELD_FORBIDDEN',
      isHuman
        ? 'repair may not add a human_preserved column that is absent from HUMAN_PRESERVED_FIELD_IDS; grow the human whitelist through its own design gate'
        : 'repair refuses a field the human whitelist and the frozen template disagree about',
      { objectId, fieldId },
    )
  }
  // Unchanged for the non-human band: plm_system passes, anything else must be a valid
  // tenant `ext_` id. A whitelisted human column has already been admitted above and must
  // NOT be run through the extension-namespace check, which would reject its bare id.
  if (!isHuman && ownership !== 'plm_system') {
    assertExtensionFieldIdValid(fieldId, { templateFieldIds })
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
// human-field-reject guard is LOAD-BEARING: the canonical main carries the
// HUMAN_PRESERVED_FIELD_IDS, so a repair that could add an ARBITRARY human column
// would be a back door around the apply-writer ownership wall's vocab. Same discipline as the
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
    // Repair only ever ADDS a missing column, and a column it adds is created -- not
    // renamed -- so it is created readable too. Every pre-existing column, including one
    // an operator renamed by hand against the deployment's database, is left exactly as
    // it is; assertNoExistingFieldMutated below rolls the whole transaction back if not.
    const descriptor = buildStockPreparationTargetDescriptor({ template, description: input.description, locale: input.locale })
    const ownershipById = new Map(template.fields.map((field) => [field.id, field.ownership]))
    const missingDescriptors = []
    for (const id of missingIds) {
      assertRepairableFieldOwnership({
        fieldId: id,
        ownership: ownershipById.get(id),
        isWhitelisted: humanSet.has(id),
        templateFieldIds: fieldIds,
        objectId: template.objectId,
      })
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

// ---------------------------------------------------------------------------
// CARRY TARGET OWNERSHIP — the ONE decision, so the runtime wall and the deploy-time preflight
// cannot disagree about the same binding.
//
// The carry route refuses a bound sheet it cannot attribute to the caller's own project. The
// preflight exists to tell a deployer, before the window, what the route will do. When the two
// derived that verdict separately the preflight was blind to registry ownership and blessed, in
// operator-facing text, a binding every carry click then refused. So the verdict is computed HERE,
// from three facts either caller can gather, and both sides only MAP it — to an HTTP refusal on one
// side, to a blocker on the other.
//
// The three facts are deliberately plain values, not a provisioning handle: this function performs
// no IO, so it is the same decision under test as in production.
const CARRY_TARGET_OWNERSHIP_STATES = Object.freeze({
  // The registry says this sheet belongs to the asking project. Proven; carry proceeds.
  OWNED: 'owned_by_this_project',
  // No registry row, but the bound sheetId IS the id derived for (this project, this objectId) —
  // the pre-registry / legacy install the fallback exists for. Allowed, and worth reporting.
  DERIVED: 'unregistered_but_derived',
  // Not the asking project's, and not derived for it either. "Owned elsewhere" and "not registered
  // at all" are ONE answer here on purpose: the ownership port is a boolean precisely so it cannot
  // hand one tenant another tenant's project id, and that is the price.
  NOT_OWNED: 'not_owned_by_this_project',
  // Ownership is false and there is no derivation available to fall back on, so the question is
  // undecidable rather than answered "no".
  UNDECIDABLE: 'owner_undecidable',
  // The binding names no sheet or no object, so there is nothing to attribute.
  UNBOUND: 'target_unbound',
})

// The HTTP code the carry route returns for each refusing state. The preflight quotes these back to
// the deployer verbatim, so "what the preflight warned about" and "what the click returned" are the
// same string.
const CARRY_TARGET_OWNERSHIP_REFUSAL_CODES = Object.freeze({
  [CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED]: 'CONFIRM_CARRY_TARGET_TENANT_MISMATCH',
  [CARRY_TARGET_OWNERSHIP_STATES.UNDECIDABLE]: 'CONFIRM_CARRY_TARGET_OWNER_UNKNOWN',
  [CARRY_TARGET_OWNERSHIP_STATES.UNBOUND]: 'CONFIRM_CARRY_TARGET_TENANT_MISMATCH',
})

/**
 * @param {string}  boundSheetId    the action target's sheetId
 * @param {string}  objectId        the action target's objectId
 * @param {boolean} ownedByProject  provisioning.isSheetOwnedByProject(boundSheetId, project)
 * @param {string}  derivedSheetId  provisioning.getObjectSheetId(project, objectId), or '' when the
 *                                  host exposes no derivation to fall back on
 * @returns {{ state: string, ok: boolean, refusalCode: string|null }}
 */
function decideCarryTargetOwnership({ boundSheetId, objectId, ownedByProject, derivedSheetId } = {}) {
  const sheetId = optionalString(boundSheetId)
  const object = optionalString(objectId)
  const verdict = (state) => Object.freeze({
    state,
    ok: state === CARRY_TARGET_OWNERSHIP_STATES.OWNED || state === CARRY_TARGET_OWNERSHIP_STATES.DERIVED,
    refusalCode: CARRY_TARGET_OWNERSHIP_REFUSAL_CODES[state] || null,
  })
  if (!sheetId || !object) return verdict(CARRY_TARGET_OWNERSHIP_STATES.UNBOUND)
  if (ownedByProject === true) return verdict(CARRY_TARGET_OWNERSHIP_STATES.OWNED)
  const derived = optionalString(derivedSheetId)
  if (!derived) return verdict(CARRY_TARGET_OWNERSHIP_STATES.UNDECIDABLE)
  if (derived === sheetId) return verdict(CARRY_TARGET_OWNERSHIP_STATES.DERIVED)
  return verdict(CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED)
}

module.exports = {
  CARRY_TARGET_OWNERSHIP_STATES,
  CARRY_TARGET_OWNERSHIP_REFUSAL_CODES,
  decideCarryTargetOwnership,
  CANONICAL_FIELD_MAP_MODE,
  repairStockPreparationCanonicalTarget,
  // Exported for its own direct witnesses: the ownership rule that decides whether the
  // additive heal path may create a given column (see the doc comment above it).
  assertRepairableFieldOwnership,
  SANDBOX_FIELD_MAP_MODE,
  CANONICAL_KEY_FIELD,
  REQUIRED_PERMISSION,
  StockPreparationTargetProvisioningError,
  SANDBOX_OBJECT_ID_NAMESPACE,
  assertSandboxObjectId,
  isSandboxNamespaceObjectId,
  buildStockPreparationTargetDescriptor,
  ensureManagedTableDefaultView,
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
    normalizeExtensionFieldIds,
    buildCanonicalTargetBinding,
    hashEvidenceValue,
    sandboxStockPreparationTemplate,
    assertSandboxObjectId,
    assertAdminPermission,
    getProvisioningApi,
    assertNoExistingFieldMutated,
  },
}
