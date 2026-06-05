'use strict'

// ---------------------------------------------------------------------------
// HTTP routes — plugin-integration-core
//
// Thin REST control plane over the plugin-local registries and runner. The
// route layer handles auth/tenant scoping and error shaping; business behavior
// stays in the underlying services.
// ---------------------------------------------------------------------------

const ROUTES = [
  ['GET', '/api/integration/status', 'status'],
  ['GET', '/api/integration/adapters', 'adaptersList'],
  ['GET', '/api/integration/external-systems', 'externalSystemsList'],
  ['POST', '/api/integration/external-systems', 'externalSystemsUpsert'],
  ['GET', '/api/integration/external-systems/:id', 'externalSystemsGet'],
  ['DELETE', '/api/integration/external-systems/:id', 'externalSystemsDelete'],
  ['POST', '/api/integration/external-systems/:id/test', 'externalSystemsTest'],
  ['GET', '/api/integration/external-systems/:id/objects', 'externalSystemObjects'],
  ['GET', '/api/integration/external-systems/:id/schema', 'externalSystemSchema'],
  ['GET', '/api/integration/pipelines', 'pipelinesList'],
  ['POST', '/api/integration/pipelines', 'pipelinesUpsert'],
  ['GET', '/api/integration/pipelines/:id', 'pipelinesGet'],
  ['POST', '/api/integration/pipelines/:id/run', 'pipelinesRun'],
  ['POST', '/api/integration/pipelines/:id/dry-run', 'pipelinesDryRun'],
  ['GET', '/api/integration/table-actions', 'tableActionsList'],
  ['POST', '/api/integration/table-actions/:actionId/dry-run', 'tableActionDryRun'],
  ['POST', '/api/integration/table-actions/:actionId/apply', 'tableActionApply'],
  ['GET', '/api/integration/stock-preparation/target/readiness', 'stockPreparationTargetReadiness'],
  ['POST', '/api/integration/stock-preparation/target/ensure', 'stockPreparationTargetEnsure'],
  ['POST', '/api/integration/templates/preview', 'templatesPreview'],
  ['POST', '/api/integration/templates/derive', 'templatesDerive'],
  ['GET', '/api/integration/staging/descriptors', 'stagingDescriptors'],
  ['POST', '/api/integration/staging/install', 'stagingInstall'],
  ['GET', '/api/integration/runs', 'runsList'],
  ['GET', '/api/integration/provenance', 'provenanceByRow'],
  ['GET', '/api/integration/dead-letters', 'deadLettersList'],
  ['POST', '/api/integration/dead-letters/:id/replay', 'deadLettersReplay'],
]
const EXTERNAL_SYSTEM_OBJECTS_MAX_ITEMS = 1000
const { sanitizeIntegrationPayload, scrubSecretStringValue } = require('./payload-redaction.cjs')
const { getPath, setPath, transformRecord } = require('./transform-engine.cjs')
// DF-T1-0/DF-T1: compose the no-write preview through the SAME K3 Save-body composer the
// adapter uses, so the preview is byte-identical to the real Save (single source of truth —
// replaces the former divergent applyPreviewReferenceShape/projectRecordForTemplate copies).
// DF-T1 reuses applyReferenceShape (shaping) + findUnfilledPlaceholders (detection); it does
// NOT introduce a new K3 shaper/projector.
const { projectRecordForBody, findUnfilledPlaceholders, applyReferenceShape, isBlankValue } = require('./adapters/k3-save-body-composer.cjs')
// DF-T3b-2a: from_reference_table resolves a per-material reference via the shared resolver (the
// SAME decision both the preview and the record materializer use, so they cannot diverge).
const { resolveReferenceRuleValue } = require('./reference-mapping-resolver.cjs')
// DF-T3b-2b: live mapping-sheet bulk-read → referenceMappingIndexes for the preview seam (read-only).
const { buildReferenceMappingIndexes } = require('./reference-mapping-source.cjs')
const { K3_REFERENCE_MAPPING_TEMPLATES } = require('./reference-mapping-templates.cjs')
// DF-T2c: read-only derive route reuses the DF-T2a helper (no duplication; pure compute, no write).
const { deriveK3MaterialTemplateDraft, summarizeTemplateForEvidence, TemplateDeriveError } = require('./connector-template-derive.cjs')
const { validateRecord } = require('./validator.cjs')
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  StockPreparationTableActionError,
  applyStockPreparationAction,
  assertStockPreparationTargetReady,
  createStockPreparationTableActionRegistry,
  dryRunStockPreparationAction,
} = require('./stock-preparation-table-actions.cjs')
const {
  inspectStockPreparationCanonicalTarget,
  ensureStockPreparationCanonicalTarget,
} = require('./stock-preparation-target-provisioning.cjs')

class HttpRouteError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'HttpRouteError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function sendJson(res, status, body) {
  if (typeof res.status === 'function') {
    return res.status(status).json(body)
  }
  res.statusCode = status
  return res.json(body)
}

function sendOk(res, data, status = 200) {
  return sendJson(res, status, { ok: true, data })
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : inferHttpStatus(error)
  const code = inferErrorCode(error)
  const message = error.message || 'Internal server error'
  const details = error.details ? sanitizeIntegrationPayload(error.details) : undefined
  return sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  })
}

function inferDataSourceBridgeErrorCode(error) {
  const code = error && error.code ? String(error.code) : ''
  if (/^DATA_SOURCE_/.test(code)) return code
  const message = error && error.message ? String(error.message) : ''
  if (message === 'data source read requires an owner principal (none provided)') {
    return 'DATA_SOURCE_PRINCIPAL_REQUIRED'
  }
  if (/^Data source with id '[^']+' not found$/.test(message)) {
    return 'DATA_SOURCE_NOT_FOUND'
  }
  if (/^data source '[^']+' is writable; the read-only bridge refuses a writable binding$/.test(message)) {
    return 'DATA_SOURCE_NOT_READ_ONLY'
  }
  return ''
}

function inferErrorCode(error) {
  const dataSourceCode = inferDataSourceBridgeErrorCode(error)
  if (dataSourceCode) return dataSourceCode
  return error.code || error.name || 'INTERNAL_ERROR'
}

function inferHttpStatus(error) {
  const name = error && error.name ? String(error.name) : ''
  if (inferDataSourceBridgeErrorCode(error)) return 422
  if (error instanceof StockPreparationTableActionError) return error.status
  if (/NotFound/.test(name)) return 404
  if (/Conflict/.test(name)) return 409
  if (/Validation|Transform|Watermark|DeadLetter/.test(name)) return 400
  // A `data-source:sql-readonly` external system bound to a deleted / not-visible data source is a
  // CONFIG error (its config.dataSourceId dangles), NOT a server fault — map to 422, not 500.
  // Deliberately NOT 404: the route's `:id` addresses the external system (which exists), so a 404
  // would falsely read as "no such external system" and collide with ExternalSystemNotFoundError.
  if (/PipelineRunner|DataSourceUnavailable/.test(name)) return 422
  return 500
}

function getUser(req) {
  return req.user || req.authUser || null
}

// C2b: the owner principal for a per-source-owner-scoped read (the data-source:sql-readonly bridge
// facade authorizes reads with it). Direct external-system test/objects/schema calls run AS the
// request user; a missing user yields undefined → the facade fails closed (never a system/admin
// fallback). Adapters that don't need a principal (staging/k3/http) ignore the extra dep.
function requestPrincipal(req) {
  const user = getUser(req)
  return user ? (user.id || user.email) : undefined
}

function listUserPermissions(user) {
  const permissions = []
  if (Array.isArray(user && user.permissions)) permissions.push(...user.permissions)
  if (Array.isArray(user && user.roles)) permissions.push(...user.roles.map((role) => `role:${role}`))
  if (user && typeof user.role === 'string') permissions.push(`role:${user.role}`)
  return permissions.map((permission) => String(permission))
}

function hasPermission(user, action) {
  const permissions = listUserPermissions(user)
  if (permissions.includes('role:admin') || permissions.includes('integration:admin')) return true
  if (action === 'admin') return false
  if (action === 'read') {
    return permissions.includes('integration:read') || permissions.includes('integration:write')
  }
  return permissions.includes('integration:write')
}

function isAdmin(user) {
  const permissions = listUserPermissions(user)
  return permissions.includes('role:admin') || permissions.includes('integration:admin')
}

function requireAccess(req, action) {
  const user = getUser(req)
  if (!user) {
    throw new HttpRouteError(401, 'UNAUTHENTICATED', 'Authentication required')
  }
  if (!hasPermission(user, action)) {
    throw new HttpRouteError(403, 'FORBIDDEN', 'Insufficient integration permissions')
  }
  return user
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function resolveTenantId(req, input = {}) {
  const user = getUser(req)
  const tenantId = firstString(input.tenantId, req.query && req.query.tenantId, req.params && req.params.tenantId, user && user.tenantId)
  if (!tenantId) {
    throw new HttpRouteError(400, 'TENANT_REQUIRED', 'tenantId is required')
  }
  if (user && !isAdmin(user)) {
    const userTenantId = typeof user.tenantId === 'string' ? user.tenantId.trim() : ''
    if (!userTenantId) {
      throw new HttpRouteError(403, 'TENANT_CONTEXT_REQUIRED', 'tenant context is required')
    }
    if (userTenantId !== tenantId) {
      throw new HttpRouteError(403, 'TENANT_MISMATCH', 'tenant scope mismatch')
    }
  }
  return tenantId
}

function resolveWorkspaceId(req, input = {}) {
  return firstString(input.workspaceId, req.query && req.query.workspaceId, req.params && req.params.workspaceId)
}

function scopedInput(req, input = {}) {
  return {
    ...input,
    tenantId: resolveTenantId(req, input),
    workspaceId: resolveWorkspaceId(req, input),
  }
}

function isIntegrationCoreProjectId(projectId) {
  if (typeof projectId !== 'string') return false
  const suffix = projectId.trim().split(':').pop()
  return suffix === 'integration-core' || suffix === 'plugin-integration-core'
}

function resolveIntegrationStagingProjectId(tenantId, requestedProjectId) {
  if (isIntegrationCoreProjectId(requestedProjectId)) return requestedProjectId.trim()
  return `${tenantId}:integration-core`
}

function requestBody(req) {
  return req.body && typeof req.body === 'object' ? req.body : {}
}

function requestQuery(req) {
  return req.query && typeof req.query === 'object' ? req.query : {}
}

function requestParams(req) {
  return req.params && typeof req.params === 'object' ? req.params : {}
}

const MAX_LIST_LIMIT = 500
const MAX_LIST_OFFSET = 10000
const MAX_SAMPLE_LIMIT = 10000

function asPositiveInt(value) {
  if (value === undefined || value === null || value === '') return undefined
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

// 'replay' is internal-only: set by replayDeadLetter, not accepted over the API.
const VALID_USER_RUN_MODES = new Set(['manual', 'incremental', 'full'])

function asListLimit(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_LIST_LIMIT)
}

function asListOffset(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_LIST_OFFSET)
}

function asSampleLimit(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_SAMPLE_LIMIT)
}

function publicRunInput(body = {}) {
  if (body.cursor !== undefined && body.cursor !== null && body.cursor !== '') {
    if (typeof body.cursor !== 'string') {
      throw new HttpRouteError(400, 'INVALID_CURSOR', 'cursor must be a string', {
        received: Array.isArray(body.cursor) ? 'array' : typeof body.cursor,
      })
    }
  }
  if (body.mode !== undefined && body.mode !== null && body.mode !== '') {
    if (!VALID_USER_RUN_MODES.has(body.mode)) {
      throw new HttpRouteError(
        400,
        'INVALID_RUN_MODE',
        `mode must be one of: ${Array.from(VALID_USER_RUN_MODES).join(', ')}`,
        { received: body.mode }
      )
    }
  }
  const input = {
    tenantId: body.tenantId,
    workspaceId: body.workspaceId,
    mode: body.mode,
    cursor: body.cursor,
    sampleLimit: asSampleLimit(body.sampleLimit),
  }
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || input[key] === null || input[key] === '') delete input[key]
  }
  return input
}

const VALID_TABLE_ACTION_BODY_KEYS = new Set(['parameters', 'confirm'])
const VALID_STOCK_PREPARATION_TARGET_REQUEST_KEYS = new Set(['tenantId', 'workspaceId', 'projectId', 'baseId'])

function normalizeTableActionBody(body = {}) {
  if (!isPlainObject(body)) {
    throw new HttpRouteError(400, 'TABLE_ACTION_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(body)) {
    if (!VALID_TABLE_ACTION_BODY_KEYS.has(key)) {
      throw new HttpRouteError(400, 'TABLE_ACTION_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return body
}

function normalizeStockPreparationTargetRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_TARGET_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!VALID_STOCK_PREPARATION_TARGET_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_TARGET_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(input.tenantId),
    workspaceId: firstString(input.workspaceId),
    projectId: firstString(input.projectId),
    baseId: firstString(input.baseId),
  }
}

function stockPreparationTargetInput(req, rawInput = {}) {
  const input = normalizeStockPreparationTargetRequest(rawInput)
  const tenantId = resolveTenantId(req, input)
  const projectId = resolveIntegrationStagingProjectId(tenantId, input.projectId)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    baseId: input.baseId,
  }
}

function publicStockPreparationTargetResult(result) {
  return {
    ready: result.ready === true,
    mode: result.mode,
    targetBinding: result.target ? cloneJson(result.target) : null,
    evidence: result.evidence,
  }
}

function redactDeadLetter(deadLetter, fullPayload = false) {
  if (!deadLetter || typeof deadLetter !== 'object') return deadLetter
  if (fullPayload) {
    return {
      ...deadLetter,
      sourcePayload: sanitizeIntegrationPayload(deadLetter.sourcePayload),
      transformedPayload: sanitizeIntegrationPayload(deadLetter.transformedPayload),
      // Scrub secret-shaped values from the free-text error message at display time too,
      // so pre-fix dead-letters (stored before write-time scrubbing) cannot leak on read.
      errorMessage: scrubSecretStringValue(deadLetter.errorMessage),
      payloadRedacted: true,
    }
  }
  const { sourcePayload: _sourcePayload, transformedPayload: _transformedPayload, ...safe } = deadLetter
  return {
    ...safe,
    errorMessage: scrubSecretStringValue(deadLetter.errorMessage),
    payloadRedacted: true,
  }
}

function redactSystemForTest(system) {
  if (!system || typeof system !== 'object') return system
  return {
    ...system,
    credentials: undefined,
    credentialsEncrypted: undefined,
  }
}

const TEST_CONNECTION_RESULT_KEYS = new Set([
  'ok',
  'status',
  'code',
  'message',
  'authenticated',
  'connected',
])
// Secret-text shapes are no longer maintained here — consolidated into the shared
// scrubber (payload-redaction.cjs `scrubSecretStringValue`). See redactSecretText below.
const DEFAULT_ADAPTER_SUPPORTS = ['testConnection', 'listObjects', 'getSchema', 'read', 'upsert']
const DEFAULT_ADAPTER_ROLES = ['source', 'target', 'bidirectional']
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ADAPTER_METADATA = {
  http: {
    label: 'HTTP API',
    roles: DEFAULT_ADAPTER_ROLES,
    advanced: false,
  },
  'plm:yuantus-wrapper': {
    label: 'Yuantus PLM',
    roles: ['source'],
    advanced: false,
  },
  'erp:k3-wise-webapi': {
    label: 'K3 WISE WebAPI',
    roles: ['target'],
    advanced: false,
  },
  'erp:k3-wise-sqlserver': {
    label: 'K3 WISE SQL Server Channel',
    roles: ['source', 'target'],
    advanced: true,
    guardrails: {
      read: {
        requiresTableAllowlist: true,
        allowlistKeys: ['readTables', 'allowedTables'],
      },
      write: {
        requiresMiddleTableMode: true,
        requiresTableAllowlist: true,
        allowlistKeys: ['writeTables', 'allowedTables'],
        writeModes: ['middle-table'],
      },
      ui: {
        hiddenByDefault: true,
        normalUiDirectCoreTableWrites: false,
      },
    },
  },
  'bridge:legacy-sql-readonly': {
    label: 'Readonly Bridge Agent',
    roles: ['source'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'read'],
    advanced: true,
    guardrails: {
      read: {
        localhostOnly: true,
        requiresObjectAllowlist: true,
        maxPreviewLimit: 20,
        noRawSql: true,
        dryRunFriendly: true,
      },
      write: {
        supported: false,
      },
      ui: {
        hiddenByDefault: true,
        recommendedForLegacySqlBridge: true,
      },
    },
  },
  'metasheet:staging': {
    label: 'MetaSheet staging multitable',
    roles: ['source'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'read'],
    advanced: false,
    guardrails: {
      read: {
        hostOwned: true,
        dryRunFriendly: true,
        noExternalNetwork: true,
      },
      write: {
        supported: false,
      },
      ui: {
        recommendedForPreSourceDryRun: true,
      },
    },
  },
  'metasheet:multitable': {
    label: 'MetaSheet multitable',
    roles: ['target'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'upsert'],
    advanced: false,
    guardrails: {
      read: {
        supported: false,
      },
      write: {
        hostOwned: true,
        pluginScopedSheetsOnly: true,
        supportsAppend: true,
        supportsUpsertByKey: true,
      },
      ui: {
        recommendedForCleansedOutput: true,
      },
    },
  },
  'data-source:sql-readonly': {
    label: 'Read-only SQL data source',
    roles: ['source'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'read'],
    advanced: true,
    guardrails: {
      read: {
        readOnlyBindingOnly: true,
        ownerScoped: true,
        offsetPagingOnly: true,
        maxRowsPerPage: 10000,
        noRawSql: true,
        dryRunFriendly: true,
      },
      write: {
        supported: false,
      },
      ui: {
        referencesDataSources: true,
      },
    },
  },
}

// Route-level secret-text redaction delegates to the shared scrubber
// (payload-redaction.cjs) — single secret-shape source, no second regex set here.
// DSN userinfo now preserves the username and masks only the password
// (scheme://user:[redacted]@host), matching the shared diagnostic-preserving behavior.
const redactSecretText = scrubSecretStringValue

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function describeAdapterKind(kind) {
  const metadata = ADAPTER_METADATA[kind] || {}
  return {
    kind,
    label: metadata.label || kind,
    roles: Array.isArray(metadata.roles) ? [...metadata.roles] : [...DEFAULT_ADAPTER_ROLES],
    supports: Array.isArray(metadata.supports) ? [...metadata.supports] : [...DEFAULT_ADAPTER_SUPPORTS],
    advanced: metadata.advanced === true,
    ...(metadata.guardrails ? { guardrails: cloneJson(metadata.guardrails) } : {}),
  }
}

function assertRelativeTemplatePath(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be relative to the external-system base URL`, { field })
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed) || trimmed.includes('\\')) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be a safe URL path`, { field })
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizeTemplateSchema(schema, field) {
  if (schema === undefined || schema === null) return []
  if (!Array.isArray(schema)) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.schema must be an array`, { field: `${field}.schema` })
  }
  return schema.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.schema[${index}] must be an object`, {
        field: `${field}.schema[${index}]`,
      })
    }
    const name = firstString(item.name)
    if (!name) {
      throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.schema[${index}].name is required`, {
        field: `${field}.schema[${index}].name`,
      })
    }
    return {
      ...sanitizeIntegrationPayload(item),
      name,
      label: firstString(item.label) || name,
      type: firstString(item.type) || 'string',
      required: item.required === true,
    }
  })
}

function normalizeDocumentTemplate(template, index) {
  const field = `config.documentTemplates[${index}]`
  if (!isPlainObject(template)) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be an object`, { field })
  }
  const id = firstString(template.id)
  if (!id) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.id is required`, { field: `${field}.id` })
  }
  const label = firstString(template.label)
  if (!label) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.label is required`, { field: `${field}.label` })
  }
  const object = firstString(template.object)
  if (!object) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.object is required`, { field: `${field}.object` })
  }
  const bodyKey = firstString(template.bodyKey) || 'Data'
  const endpointPath = assertRelativeTemplatePath(
    firstString(template.endpointPath, template.savePath, template.path),
    `${field}.endpointPath`,
  )
  const operations = Array.isArray(template.operations) && template.operations.length > 0
    ? template.operations.map((operation) => firstString(operation)).filter(Boolean)
    : ['upsert']
  return {
    id,
    name: object,
    object,
    label,
    operations: operations.length > 0 ? operations : ['upsert'],
    schema: normalizeTemplateSchema(template.schema, field),
    source: 'documentTemplate',
    template: sanitizeIntegrationPayload({
      id,
      version: firstString(template.version),
      bodyKey,
      endpointPath,
      source: 'custom',
    }),
  }
}

function listDocumentTemplates(system) {
  const templates = system && system.config ? system.config.documentTemplates : undefined
  if (templates === undefined || templates === null) return []
  if (!Array.isArray(templates)) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATES', 'config.documentTemplates must be an array', {
      field: 'config.documentTemplates',
    })
  }
  return templates.map((template, index) => normalizeDocumentTemplate(template, index))
}

function findDocumentTemplate(system, object) {
  return listDocumentTemplates(system).find((template) => template.object === object || template.name === object) || null
}

function normalizePreviewFieldMappings(value) {
  if (!Array.isArray(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'fieldMappings must be an array', { field: 'fieldMappings' })
  }
  return value
}

function normalizePreviewBodyKey(value) {
  const bodyKey = firstString(value) || 'Data'
  if (DANGEROUS_JSON_KEYS.has(bodyKey)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'template.bodyKey is unsafe', { field: 'template.bodyKey' })
  }
  if (/[\u0000-\u001F\u007F]/.test(bodyKey)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'template.bodyKey must be a safe JSON key', { field: 'template.bodyKey' })
  }
  return bodyKey
}

function normalizePreviewTemplate(value) {
  if (value === undefined || value === null) {
    return {
      bodyKey: 'Data',
      schema: [],
      meta: { bodyKey: 'Data' },
    }
  }
  if (!isPlainObject(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'template must be an object', { field: 'template' })
  }
  const endpointPath = assertRelativeTemplatePath(
    firstString(value.endpointPath, value.savePath, value.path),
    'template.endpointPath',
  )
  const bodyKey = normalizePreviewBodyKey(value.bodyKey)
  return {
    bodyKey,
    schema: normalizeTemplateSchema(value.schema, 'template'),
    meta: sanitizeIntegrationPayload({
      id: firstString(value.id),
      version: firstString(value.version),
      documentType: firstString(value.documentType, value.object, value.targetObject),
      bodyKey,
      endpointPath,
    }),
  }
}

function schemaRequiredErrors(record, schema) {
  const errors = []
  for (const field of schema || []) {
    if (field && field.required === true) {
      const value = getPath(record, field.name)
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        errors.push({
          field: field.name,
          code: 'REQUIRED',
          message: `${field.label || field.name} is required`,
          value,
          rule: 'required',
          details: { source: 'template.schema' },
        })
      }
    }
  }
  return errors
}

// projectRecordForTemplate / applyPreviewReferenceShape / normalizePreviewReferenceIdentifier
// moved to the shared K3 Save-body composer (DF-T1-0): the preview now composes
// byte-identically to the adapter Save instead of via a divergent duplicate.

// ---- DF-T1: target payload template preview (shape B — evidence under targetPayloadPreview) ----
const DF_T1_SOURCE_TYPES = new Set(['from_staging', 'from_constant', 'preserve_template', 'from_reference_table'])
const DF_T1_SHAPES = new Set(['scalar', 'object-passthrough', 'by-fnumber', 'by-fid'])
const DF_T1_COMPLETENESS = new Set(['none', 'require-fnumber-fname', 'require-fid-fname'])

function normalizeFieldRules(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'fieldRules must be an array', { field: 'fieldRules' })
  }
  return value.map((rule, index) => {
    if (!isPlainObject(rule)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}] must be an object`, { field: `fieldRules[${index}]` })
    }
    const targetField = firstString(rule.targetField)
    if (!targetField) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].targetField is required`, { field: `fieldRules[${index}].targetField` })
    }
    const sourceType = firstString(rule.sourceType) || 'from_staging'
    if (!DF_T1_SOURCE_TYPES.has(sourceType)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].sourceType is invalid`, { field: `fieldRules[${index}].sourceType` })
    }
    const shape = firstString(rule.shape) || 'scalar'
    if (!DF_T1_SHAPES.has(shape)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].shape is invalid`, { field: `fieldRules[${index}].shape` })
    }
    const completeness = firstString(rule.completeness) || 'none'
    if (!DF_T1_COMPLETENESS.has(completeness)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].completeness is invalid`, { field: `fieldRules[${index}].completeness` })
    }
    return {
      targetField,
      sourceType,
      sourceField: firstString(rule.sourceField) || targetField,
      value: rule.value,
      shape,
      completeness,
      required: rule.required === true,
      // DF-T3b-2a: domain selects the mapping index for a from_reference_table rule (else undefined).
      domain: firstString(rule.domain) || undefined,
    }
  })
}

// Reuse the shared composer's reference shaping — never a new K3 shaper (DF-T1 req #3).
function applyDfT1Shape(value, shape) {
  if (shape === 'by-fnumber') return applyReferenceShape(value, { reference: { identifier: 'FNumber' } })
  if (shape === 'by-fid') return applyReferenceShape(value, { reference: { identifier: 'FID' } })
  return value // scalar / object-passthrough → as-is
}

function checkReferenceCompleteness(completeness, value) {
  if (completeness === 'require-fnumber-fname') {
    return isPlainObject(value) && !isBlankValue(value.FNumber) && !isBlankValue(value.FName) ? null : 'require-fnumber-fname'
  }
  if (completeness === 'require-fid-fname') {
    return isPlainObject(value) && !isBlankValue(value.FID) && !isBlankValue(value.FName) ? null : 'require-fid-fname'
  }
  return null
}

// DF-T3b-2b: bindings telling the preview which staging system/object holds each domain's mapping
// sheet. Tenant-scoped (the system is loaded scoped to the request) — the client names a binding, the
// server does the bulk-read. [{ domain, systemId, object }].
function normalizeReferenceMappingSources(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'referenceMappingSources must be an array', { field: 'referenceMappingSources' })
  }
  const seenDomains = new Set()
  return value.map((source, index) => {
    if (!isPlainObject(source)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources[${index}] must be an object`, { field: `referenceMappingSources[${index}]` })
    }
    const domain = firstString(source.domain)
    const systemId = firstString(source.systemId)
    const object = firstString(source.object)
    if (!domain || !systemId || !object) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources[${index}] requires domain, systemId, object`, { field: `referenceMappingSources[${index}]` })
    }
    // P2: one sheet per domain (#2036). A duplicate domain is a config error — fail closed rather than
    // silently letting the last binding win (Object.assign would otherwise overwrite).
    if (seenDomains.has(domain)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources has a duplicate domain: ${domain}`, { field: `referenceMappingSources[${index}].domain` })
    }
    seenDomains.add(domain)
    return { domain, systemId, object }
  })
}

function buildTargetPayloadPreview(input, options = {}) {
  if (!isPlainObject(input.sourceRecord)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'sourceRecord must be an object', { field: 'sourceRecord' })
  }
  // DF-T3b-2a: mapping indexes are SERVER-SIDE only (not from the client body) — passed via options.
  // T3b-2a injects them in tests; T3b-2b will source them from a live mapping-sheet bulk-read.
  const referenceMappingIndexes = isPlainObject(options.referenceMappingIndexes) ? options.referenceMappingIndexes : undefined
  // Reuse the legacy preview's bodyKey guard (rejects __proto__/prototype/constructor and
  // control chars) — DF-T1 must NOT bypass it (P2).
  const bodyKey = normalizePreviewBodyKey(
    firstString(input.bodyKey) || (isPlainObject(input.template) ? firstString(input.template.bodyKey) : null),
  )
  const fieldRules = normalizeFieldRules(input.fieldRules)
  // Preserve whole-object payloadTemplate defaults; rules replace only the declared fields.
  const merged = cloneJson(input.payloadTemplate)
  const fieldProvenance = {}
  const missingRequiredFields = []
  const unresolvedReferenceComponents = []
  const referenceResolutions = [] // DF-T3b-2a: values-free resolution evidence per from_reference_table rule
  for (const rule of fieldRules) {
    if (rule.sourceType === 'preserve_template') {
      fieldProvenance[rule.targetField] = 'template'
    } else {
      let raw
      if (rule.sourceType === 'from_staging') {
        raw = getPath(input.sourceRecord, rule.sourceField)
      } else if (rule.sourceType === 'from_reference_table') {
        // DF-T3b-2a: resolve the material's sourceCode via the injected mapping index for rule.domain,
        // through the SHARED decision fn (so preview ≡ the record materializer). Non-resolved
        // (unresolved/ambiguous/incomplete) → UNRESOLVED sentinel → fail-closed via
        // findUnfilledPlaceholders, identical to the Save side. Evidence is values-free.
        const resolution = resolveReferenceRuleValue(referenceMappingIndexes, rule, getPath(input.sourceRecord, rule.sourceField))
        raw = resolution.value
        referenceResolutions.push({ field: rule.targetField, status: resolution.outcome.status, evidence: resolution.outcome.evidence })
      } else {
        raw = rule.value // from_constant
      }
      fieldProvenance[rule.targetField] = rule.sourceType === 'from_staging' ? 'staging'
        : rule.sourceType === 'from_constant' ? 'constant' : 'reference_table'
      const shaped = applyDfT1Shape(raw, rule.shape)
      if (isBlankValue(shaped)) {
        if (rule.required) missingRequiredFields.push(rule.targetField)
        // leave the template default in place; if it is a placeholder, fail-closed catches it.
      } else {
        setPath(merged, rule.targetField, shaped)
      }
    }
    const finalValue = getPath(merged, rule.targetField)
    if (rule.required && isBlankValue(finalValue) && !missingRequiredFields.includes(rule.targetField)) {
      missingRequiredFields.push(rule.targetField)
    }
    const incomplete = checkReferenceCompleteness(rule.completeness, finalValue)
    if (incomplete) unresolvedReferenceComponents.push({ field: rule.targetField, rule: incomplete })
  }

  const payload = { [bodyKey]: cloneJson(merged) }
  // Same placeholder DETECTION + CODE as the Save path (shared composer findUnfilledPlaceholders).
  const placeholderErrors = findUnfilledPlaceholders(payload).map((path) => ({
    field: path,
    code: 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED',
    message: `unfilled template placeholder at ${path}`,
  }))
  // DF-T1.5: when the workbench UI path supplied fieldMappings, the DF-T1 branch ran the same
  // transform + (non-required) validation the legacy pipeline runs and passes the errors through
  // here, so the preview reflects the real pipeline. Runbook callers omit fieldMappings → both
  // stay [] (shape B). required stays owned by the fieldRules (missingRequiredFields).
  const transformErrors = (Array.isArray(input.transformErrors) ? input.transformErrors : []).map((e) => cloneJson(e))
  const validationErrors = (Array.isArray(input.validationErrors) ? input.validationErrors : []).map((e) => cloneJson(e))
  const errors = [
    ...transformErrors,
    ...validationErrors,
    ...placeholderErrors,
    ...missingRequiredFields.map((field) => ({ field, code: 'REQUIRED', message: `${field} is required` })),
    ...unresolvedReferenceComponents.map((u) => ({ field: u.field, code: 'INCOMPLETE_REFERENCE', message: `${u.field} requires ${u.rule}` })),
  ].map((e) => cloneJson(e))

  const response = sanitizeIntegrationPayload({
    valid: errors.length === 0,
    payload,
    targetRecord: cloneJson(merged),
    errors,
    placeholderErrors: placeholderErrors.map((e) => cloneJson(e)),
    // Shape-B: schemaErrors stays []. transformErrors/validationErrors are populated only when
    // fieldMappings were supplied (the UI path); runbook callers (no fieldMappings) keep them []
    // (P2). required is owned by the fieldRules (missingRequiredFields), not validationErrors.
    transformErrors,
    validationErrors,
    schemaErrors: [],
    targetPayloadPreview: {
      eligibleForSaveOnly: errors.length === 0,
      unresolvedPlaceholders: placeholderErrors.map((e) => e.field),
      unresolvedReferenceComponents: cloneJson(unresolvedReferenceComponents),
      missingRequiredFields: cloneJson(missingRequiredFields),
      fieldProvenance: cloneJson(fieldProvenance),
      // DF-T3b-2a: values-free per-reference resolution evidence (field/domain/sourceCode-presence/
      // error-type only — never customer values). Empty unless from_reference_table rules ran.
      referenceResolutions: cloneJson(referenceResolutions),
      compositionSource: 'k3-save-body-composer',
    },
  })
  // Redaction self-check: no secret-shaped value survived the sanitizer (DF-T1 req #4).
  const serialized = JSON.stringify(response)
  response.targetPayloadPreview.redactionSelfCheck = {
    applied: true,
    clean: serialized === scrubSecretStringValue(serialized),
  }
  return response
}

function buildTemplatePreview(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'input must be an object')
  }
  // DF-T1: target payload template mode (payloadTemplate + fieldRules). DF-T1 evidence is
  // namespaced under `targetPayloadPreview`; the legacy fieldMappings/schema preview is unchanged
  // and never carries that field (DF-T1 req #1, #2).
  if (Object.prototype.hasOwnProperty.call(input, 'payloadTemplate') && !isPlainObject(input.payloadTemplate)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'payloadTemplate must be an object', { field: 'payloadTemplate' })
  }
  if (isPlainObject(input.payloadTemplate)) {
    // DF-T1.5 reachability wire: when fieldMappings are provided (the workbench UI path), run the
    // SAME transform the legacy pipeline runs and compose from the TRANSFORMED record (keyed by
    // target field) so the DF-T1 preview predicts the real Save body, not raw staging values.
    // Derived fieldRules use sourceField = targetField. Callers that omit fieldMappings (operator
    // runbook evidence with a target-shaped sourceRecord) keep reading raw — same shape, two callers.
    const rawMappings = Array.isArray(input.fieldMappings) ? input.fieldMappings : []
    if (rawMappings.length > 0) {
      const fieldMappings = normalizePreviewFieldMappings(rawMappings)
      const transformed = transformRecord(input.sourceRecord, fieldMappings)
      // Run the SAME validation the legacy pipeline runs — but strip `required` from the mappings:
      // required is already enforced by the derived fieldRules (missingRequiredFields), so this avoids
      // double-counting while still surfacing non-required validations (min/max/regex/...) that the
      // pipeline would reject. Closes the residual "green DF-T1 preview but pipeline rejects" gap.
      const nonRequiredMappings = fieldMappings.map((mapping) => ({
        ...mapping,
        validation: Array.isArray(mapping.validation) ? mapping.validation.filter((rule) => rule && rule.type !== 'required') : [],
      }))
      const validation = transformed.ok ? validateRecord(transformed.value, nonRequiredMappings) : { errors: [] }
      // transformed.value is always an object (the legacy path projects it even when !ok); the errors
      // carry the bad news and are surfaced via transformErrors / validationErrors below.
      return buildTargetPayloadPreview({
        ...input,
        sourceRecord: transformed.value,
        transformErrors: transformed.errors,
        validationErrors: validation.errors,
      }, options)
    }
    return buildTargetPayloadPreview(input, options)
  }
  if (!isPlainObject(input.sourceRecord)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'sourceRecord must be an object', { field: 'sourceRecord' })
  }
  const fieldMappings = normalizePreviewFieldMappings(input.fieldMappings)
  const template = normalizePreviewTemplate(input.template)
  const transformed = transformRecord(input.sourceRecord, fieldMappings)
  const validation = transformed.ok ? validateRecord(transformed.value, fieldMappings) : { ok: true, valid: true, errors: [] }
  const requiredErrors = transformed.ok ? schemaRequiredErrors(transformed.value, template.schema) : []
  // Compose through the shared composer (same projection + reference shaping + drop-blank the
  // adapter Save uses). template carries .schema + .bodyKey, so it serves as the objectConfig.
  const targetRecord = projectRecordForBody(transformed.value, template)
  const payload = {
    [template.bodyKey]: cloneJson(targetRecord),
  }
  // Same placeholder DETECTION as the Save path; the preview's disposition is valid:false
  // (the Save path throws). A clean preview therefore cannot hide a placeholder the Save rejects.
  // Same error CODE as the Save path's throw, so an operator can correlate a preview-detected
  // placeholder with the Save-side failure that would follow.
  const placeholderErrors = findUnfilledPlaceholders(payload).map((path) => ({
    field: path,
    code: 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED',
    message: `unfilled template placeholder at ${path}`,
  }))
  const errors = [
    ...transformed.errors,
    ...validation.errors,
    ...requiredErrors,
    ...placeholderErrors,
  ].map((error) => cloneJson(error))
  return sanitizeIntegrationPayload({
    valid: errors.length === 0,
    payload,
    targetRecord: cloneJson(targetRecord),
    errors,
    transformErrors: transformed.errors.map((error) => cloneJson(error)),
    validationErrors: validation.errors.map((error) => cloneJson(error)),
    schemaErrors: requiredErrors.map((error) => cloneJson(error)),
    placeholderErrors: placeholderErrors.map((error) => cloneJson(error)),
    template: template.meta,
  })
}

function sanitizeTestConnectionResult(result) {
  const safe = {}
  for (const key of TEST_CONNECTION_RESULT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue
    const value = result[key]
    safe[key] = typeof value === 'string' ? redactSecretText(value) : value
  }
  return safe
}

function normalizeTestConnectionResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return sanitizeTestConnectionResult(result)
  }
  return {
    ok: result !== false,
  }
}

function testConnectionErrorResult(error) {
  return {
    ok: false,
    code: error && (error.code || error.name) ? String(error.code || error.name) : 'TEST_CONNECTION_FAILED',
    message: redactSecretText(error && error.message ? error.message : String(error)),
  }
}

function resolveTestedStatus(system, result) {
  if (!result || result.ok !== true) return 'error'
  // A connection test must not silently enable an intentionally inactive
  // external system. It only clears a previous error status after success.
  if (system && system.status === 'inactive') return 'inactive'
  return 'active'
}

function resolveTestError(result) {
  if (result && result.ok === true) return null
  return firstString(
    result && typeof result.message === 'string' ? redactSecretText(result.message) : result && result.message,
    result && typeof result.code === 'string' ? redactSecretText(result.code) : result && result.code,
    'connection test failed',
  )
}

async function persistExternalSystemTestResult(externalSystems, req, system, result) {
  if (!system || !system.id || !system.name || !system.kind) return null
  return externalSystems.upsertExternalSystem(scopedInput(req, {
    id: system.id,
    name: system.name,
    kind: system.kind,
    role: system.role || 'bidirectional',
    projectId: system.projectId,
    status: resolveTestedStatus(system, result),
    lastTestedAt: new Date().toISOString(),
    lastError: resolveTestError(result),
  }))
}

function createHandlers(services, options = {}) {
  function requireService(name, methods) {
    const service = services[name]
    if (!service) throw new Error(`registerIntegrationRoutes: ${name} is required`)
    for (const method of methods) {
      if (typeof service[method] !== 'function') {
        throw new Error(`registerIntegrationRoutes: ${name}.${method} is required`)
      }
    }
    return service
  }

  const externalSystems = requireService('externalSystemRegistry', ['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems'])
  const adapterRegistry = requireService('adapterRegistry', ['createAdapter', 'listAdapterKinds'])
  const pipelineRegistry = requireService('pipelineRegistry', ['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns'])
  const runner = requireService('pipelineRunner', ['runPipeline'])
  const deadLetters = requireService('deadLetterStore', ['listDeadLetters'])
  const stagingInstaller = requireService('stagingInstaller', ['installStaging', 'listStagingDescriptors'])
  const context = options.context || {}
  const configuredTableActions = context && context.config
    ? (context.config.stockPreparationTableActions || context.config.tableActions)
    : undefined
  const tableActions = createStockPreparationTableActionRegistry({
    actions: configuredTableActions,
  })

  function getMultitableRecordsApi() {
    const records = context && context.api && context.api.multitable && context.api.multitable.records
    if (!records || typeof records.queryRecords !== 'function') {
      throw new HttpRouteError(501, 'TABLE_ACTION_RECORDS_API_UNAVAILABLE', 'multitable records API is not available')
    }
    return records
  }

  async function loadTableActionSourceAdapter(req, action) {
    const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
      ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
      : externalSystems.getExternalSystem.bind(externalSystems)
    const system = await loadSystem(scopedInput(req, { id: action.source.externalSystemId }))
    if (!system || system.kind !== action.source.kind) {
      throw new HttpRouteError(422, 'TABLE_ACTION_SOURCE_INVALID', `table action source must be ${action.source.kind}`, {
        actionId: action.actionId,
        sourceSystemId: action.source.externalSystemId,
        actualKind: system && system.kind,
      })
    }
    return adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
  }

  function applyPermissionForUser(user) {
    return isAdmin(user) ? 'admin' : 'write'
  }

  const handlers = {
    async status(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, {
        adapters: adapterRegistry.listAdapterKinds(),
        routes: ROUTES.map(([method, path]) => ({ method, path })),
      })
    },

    async adaptersList(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, adapterRegistry.listAdapterKinds().map(describeAdapterKind))
    },

    async externalSystemsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await externalSystems.listExternalSystems(scopedInput(req, {
        kind: query.kind,
        status: query.status,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    async externalSystemsUpsert(req, res) {
      requireAccess(req, 'write')
      return sendOk(res, await externalSystems.upsertExternalSystem(scopedInput(req, requestBody(req))), 201)
    },

    async externalSystemsGet(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, await externalSystems.getExternalSystem(scopedInput(req, { id: requestParams(req).id })))
    },

    async externalSystemsDelete(req, res) {
      requireAccess(req, 'write')
      return sendOk(res, await externalSystems.deleteExternalSystem(scopedInput(req, { id: requestParams(req).id })))
    },

    async externalSystemsTest(req, res) {
      requireAccess(req, 'write')
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedInput(req, { id: requestParams(req).id }))
      const adapter = adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
      let result
      try {
        result = normalizeTestConnectionResult(await adapter.testConnection(requestBody(req)))
      } catch (error) {
        result = testConnectionErrorResult(error)
      }
      const updatedSystem = await persistExternalSystemTestResult(externalSystems, req, system, result)
      return sendOk(res, {
        ...result,
        system: redactSystemForTest(updatedSystem),
      })
    },

    async externalSystemObjects(req, res) {
      requireAccess(req, 'read')
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedInput(req, { id: requestParams(req).id }))
      const adapter = adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
      const adapterObjects = typeof adapter.listObjects === 'function'
        ? await adapter.listObjects()
        : []
      const documentTemplateObjects = listDocumentTemplates(system)
      const objects = [
        ...(Array.isArray(adapterObjects) ? adapterObjects : []),
        ...documentTemplateObjects,
      ]
      return sendOk(res, sanitizeIntegrationPayload(objects, {
        maxArrayItems: EXTERNAL_SYSTEM_OBJECTS_MAX_ITEMS,
      }))
    },

    async externalSystemSchema(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      const object = firstString(query.object, query.name)
      if (!object) {
        throw new HttpRouteError(400, 'OBJECT_REQUIRED', 'object is required')
      }
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedInput(req, { id: requestParams(req).id }))
      const template = findDocumentTemplate(system, object)
      if (template) {
        return sendOk(res, sanitizeIntegrationPayload({
          object: template.object,
          fields: template.schema,
          template: template.template,
        }))
      }
      const adapter = adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
      const schema = typeof adapter.getSchema === 'function'
        ? await adapter.getSchema({ object })
        : { object, fields: [] }
      return sendOk(res, sanitizeIntegrationPayload(schema))
    },

    async pipelinesList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await pipelineRegistry.listPipelines(scopedInput(req, {
        status: query.status,
        sourceSystemId: query.sourceSystemId,
        targetSystemId: query.targetSystemId,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    async pipelinesUpsert(req, res) {
      requireAccess(req, 'write')
      const user = getUser(req)
      const body = requestBody(req)
      return sendOk(res, await pipelineRegistry.upsertPipeline(scopedInput(req, {
        ...body,
        createdBy: user && (user.id || user.email),
      })), 201)
    },

    async pipelinesGet(req, res) {
      requireAccess(req, 'read')
      const includeFieldMappings = requestQuery(req).includeFieldMappings !== 'false'
      return sendOk(res, await pipelineRegistry.getPipeline(scopedInput(req, {
        id: requestParams(req).id,
        includeFieldMappings,
      })))
    },

    async pipelinesRun(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      return sendOk(res, await runner.runPipeline(scopedInput(req, {
        ...publicRunInput(body),
        pipelineId: requestParams(req).id,
        triggeredBy: 'api',
      })), 202)
    },

    async pipelinesDryRun(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      return sendOk(res, await runner.runPipeline(scopedInput(req, {
        ...publicRunInput(body),
        pipelineId: requestParams(req).id,
        triggeredBy: 'api',
        dryRun: true,
      })), 200)
    },

    async tableActionsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await tableActions.listTableActions(scopedInput(req, {
        actionId: query.actionId,
      })))
    },

    async tableActionDryRun(req, res) {
      requireAccess(req, 'read')
      const body = normalizeTableActionBody(requestBody(req))
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const sourceAdapter = await loadTableActionSourceAdapter(req, action)
      return sendOk(res, await dryRunStockPreparationAction({
        action,
        parameters: body.parameters,
        sourceAdapter,
        recordsApi: getMultitableRecordsApi(),
        tokenStore: context.storage,
      }))
    },

    async tableActionApply(req, res) {
      const user = requireAccess(req, 'write')
      const body = normalizeTableActionBody(requestBody(req))
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const sourceAdapter = await loadTableActionSourceAdapter(req, action)
      const confirm = isPlainObject(body.confirm) ? body.confirm : {}
      return sendOk(res, await applyStockPreparationAction({
        action,
        parameters: body.parameters,
        dryRunToken: confirm.dryRunToken,
        acceptManualConfirmHold: confirm.acceptManualConfirmHold === true,
        permission: applyPermissionForUser(user),
        sourceAdapter,
        recordsApi: getMultitableRecordsApi(),
        tokenStore: context.storage,
      }))
    },

    async stockPreparationTargetReadiness(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationTargetInput(req, requestQuery(req))
      const result = await inspectStockPreparationCanonicalTarget({
        context,
        projectId: input.projectId,
        permission: 'admin',
      })
      return sendOk(res, publicStockPreparationTargetResult(result))
    },

    async stockPreparationTargetEnsure(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationTargetInput(req, requestBody(req))
      const result = await ensureStockPreparationCanonicalTarget({
        context,
        projectId: input.projectId,
        baseId: input.baseId,
        permission: 'admin',
      })
      return sendOk(res, publicStockPreparationTargetResult(result), result.mode === 'canonical_create' ? 201 : 200)
    },

    async templatesPreview(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      // DF-T3b-2b: when the request names referenceMappingSources, LIVE bulk-read each domain's mapping
      // sheet via the staging source-adapter (read-only) and feed the #2063 referenceMappingIndexes seam,
      // so from_reference_table resolves per-material in the preview. No sources → unchanged behavior.
      const sources = normalizeReferenceMappingSources(body.referenceMappingSources)
      let previewOptions = {}
      if (sources.length > 0) {
        const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
          ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
          : externalSystems.getExternalSystem.bind(externalSystems)
        const referenceMappingIndexes = {}
        const adapterBySystem = new Map()
        for (const source of sources) {
          let adapter = adapterBySystem.get(source.systemId)
          if (!adapter) {
            const system = await loadSystem(scopedInput(req, { id: source.systemId }))
            // P1: fail-closed BEFORE createAdapter — ONLY a metasheet:staging source may back a mapping
            // sheet. Otherwise the preview becomes an arbitrary-adapter read() entry point: a caller
            // pointing at a K3 / other external system would trigger an external read instead of a
            // read-only workspace mapping-sheet read (the slice's whole boundary).
            if (!system || system.kind !== 'metasheet:staging') {
              throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources must reference a metasheet:staging system (systemId ${source.systemId} is ${(system && system.kind) || 'unknown'})`, { field: 'referenceMappingSources' })
            }
            adapter = adapterRegistry.createAdapter(system)
            adapterBySystem.set(source.systemId, adapter)
          }
          const template = K3_REFERENCE_MAPPING_TEMPLATES.find((t) => t.domain === source.domain)
          if (!template) {
            throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `unknown reference mapping domain: ${source.domain}`, { field: 'referenceMappingSources' })
          }
          Object.assign(referenceMappingIndexes, await buildReferenceMappingIndexes(adapter, [{ domain: source.domain, object: source.object, template }]))
        }
        previewOptions = { referenceMappingIndexes }
      }
      return sendOk(res, buildTemplatePreview(body, previewOptions))
    },

    // DF-T2c: read-only derive — run the DF-T2a helper on an operator-supplied (raw, operator-local)
    // payloadTemplate and return the draft { payloadTemplate, fieldRules, gatedFields }. Pure compute:
    // no external call, no write, no K3. Fails closed (400) on a redaction marker / unfilled
    // placeholder / secret-shaped value / outer {Data:…} envelope — the DF-T2a guards.
    async templatesDerive(req, res) {
      requireAccess(req, 'read')
      const body = requestBody(req)
      if (!isPlainObject(body.payloadTemplate)) {
        throw new HttpRouteError(400, 'PAYLOAD_TEMPLATE_REQUIRED', 'payloadTemplate (an object) is required')
      }
      try {
        const draft = deriveK3MaterialTemplateDraft(body.payloadTemplate)
        // P1: do NOT echo the raw payloadTemplate (operator-local customer values) in the response.
        // Return the rules + gated field names + a VALUES-FREE evidence summary only.
        return sendOk(res, {
          fieldRules: draft.fieldRules,
          gatedFields: draft.gatedFields,
          evidence: summarizeTemplateForEvidence(draft),
        })
      } catch (error) {
        if (error instanceof TemplateDeriveError) {
          throw new HttpRouteError(400, 'TEMPLATE_DERIVE_REJECTED', error.message, {
            reason: error.details && error.details.reason,
          })
        }
        throw error
      }
    },

    async stagingDescriptors(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, await stagingInstaller.listStagingDescriptors())
    },

    async stagingInstall(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      const query = requestQuery(req)
      const tenantId = resolveTenantId(req, body)
      const requestedProjectId = firstString(body.projectId, query.projectId)
      const projectId = resolveIntegrationStagingProjectId(tenantId, requestedProjectId)
      const baseId = firstString(body.baseId, requestQuery(req).baseId)
      return sendOk(res, await stagingInstaller.installStaging(scopedInput(req, {
        tenantId,
        workspaceId: body.workspaceId,
        projectId,
        baseId,
      })), 201)
    },

    async runsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await pipelineRegistry.listPipelineRuns(scopedInput(req, {
        pipelineId: query.pipelineId,
        status: query.status,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    // DF-N2-2c: read-only by-rowId provenance timeline (cross-run). Reads the
    // migration-060 view via pipelineRegistry.listProvenanceByRow. No write/replay.
    // listProvenanceByRow is intentionally NOT in requireService (optional-method 501,
    // like deadLettersReplay) so older host wiring isn't broken silently.
    async provenanceByRow(req, res) {
      requireAccess(req, 'read')
      if (typeof pipelineRegistry.listProvenanceByRow !== 'function') {
        throw new HttpRouteError(501, 'PROVENANCE_READ_NOT_IMPLEMENTED', 'Provenance read is not implemented')
      }
      const query = requestQuery(req)
      const rowId = firstString(query.rowId)
      if (!rowId) {
        throw new HttpRouteError(400, 'ROW_ID_REQUIRED', 'rowId is required')
      }
      return sendOk(res, await pipelineRegistry.listProvenanceByRow(scopedInput(req, {
        rowId,
        pipelineId: query.pipelineId,
        from: query.from,
        to: query.to,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    async deadLettersList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      const fullPayload = isAdmin(getUser(req)) && query.includePayload === 'true'
      const rows = await deadLetters.listDeadLetters(scopedInput(req, {
        pipelineId: query.pipelineId,
        runId: query.runId,
        status: query.status,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      }))
      return sendOk(res, rows.map((row) => redactDeadLetter(row, fullPayload)))
    },

    async deadLettersReplay(req, res) {
      requireAccess(req, 'write')
      if (typeof runner.replayDeadLetter !== 'function') {
        throw new HttpRouteError(501, 'REPLAY_NOT_IMPLEMENTED', 'Dead-letter replay is not implemented')
      }
      const body = requestBody(req)
      return sendOk(res, await runner.replayDeadLetter(scopedInput(req, {
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
        mode: body.mode,
        id: requestParams(req).id,
        triggeredBy: 'api',
      })), 202)
    },
  }

  return handlers
}

function registerIntegrationRoutes({ context, services, logger } = {}) {
  if (!context || !context.api || !context.api.http || typeof context.api.http.addRoute !== 'function') {
    throw new Error('registerIntegrationRoutes: context.api.http.addRoute is required')
  }
  const handlers = createHandlers(services || {}, { context })
  const registered = []
  for (const [method, path, handlerName] of ROUTES) {
    const handler = handlers[handlerName]
    context.api.http.addRoute(method, path, async (req, res) => {
      try {
        return await handler(req, res)
      } catch (error) {
        if (logger && typeof logger.warn === 'function' && !(error instanceof HttpRouteError)) {
          logger.warn(`[plugin-integration-core] route failed: ${method} ${path}`)
        }
        return sendError(res, error)
      }
    })
    registered.push(`${method} ${path}`)
  }
  return registered
}

module.exports = {
  ROUTES,
  HttpRouteError,
  MAX_LIST_LIMIT,
  MAX_LIST_OFFSET,
  MAX_SAMPLE_LIMIT,
  createHandlers,
  registerIntegrationRoutes,
  VALID_USER_RUN_MODES,
  __internals: {
    buildTemplatePreview,
    buildTargetPayloadPreview,
    hasPermission,
    requireAccess,
    resolveTenantId,
    scopedInput,
    sendError,
    inferHttpStatus,
    publicRunInput,
    redactDeadLetter,
    asSampleLimit,
    asListOffset,
    asListLimit,
    asPositiveInt,
    redactSecretText,
    sanitizeTestConnectionResult,
  },
}
