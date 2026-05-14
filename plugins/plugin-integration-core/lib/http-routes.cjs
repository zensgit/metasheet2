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
  ['POST', '/api/integration/external-systems/:id/test', 'externalSystemsTest'],
  ['GET', '/api/integration/external-systems/:id/objects', 'externalSystemObjects'],
  ['GET', '/api/integration/external-systems/:id/schema', 'externalSystemSchema'],
  ['GET', '/api/integration/pipelines', 'pipelinesList'],
  ['POST', '/api/integration/pipelines', 'pipelinesUpsert'],
  ['GET', '/api/integration/pipelines/:id', 'pipelinesGet'],
  ['POST', '/api/integration/pipelines/:id/run', 'pipelinesRun'],
  ['POST', '/api/integration/pipelines/:id/dry-run', 'pipelinesDryRun'],
  ['POST', '/api/integration/templates/preview', 'templatesPreview'],
  ['GET', '/api/integration/staging/descriptors', 'stagingDescriptors'],
  ['POST', '/api/integration/staging/install', 'stagingInstall'],
  ['GET', '/api/integration/runs', 'runsList'],
  ['GET', '/api/integration/dead-letters', 'deadLettersList'],
  ['POST', '/api/integration/dead-letters/:id/replay', 'deadLettersReplay'],
]
const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')
const { getPath, setPath, transformRecord } = require('./transform-engine.cjs')
const { validateRecord } = require('./validator.cjs')

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
  const code = error.code || error.name || 'INTERNAL_ERROR'
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

function inferHttpStatus(error) {
  const name = error && error.name ? String(error.name) : ''
  if (/NotFound/.test(name)) return 404
  if (/Conflict/.test(name)) return 409
  if (/Validation|Transform|Watermark|DeadLetter/.test(name)) return 400
  if (/PipelineRunner/.test(name)) return 422
  return 500
}

function getUser(req) {
  return req.user || req.authUser || null
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

function redactDeadLetter(deadLetter, fullPayload = false) {
  if (!deadLetter || typeof deadLetter !== 'object') return deadLetter
  if (fullPayload) {
    return {
      ...deadLetter,
      sourcePayload: sanitizeIntegrationPayload(deadLetter.sourcePayload),
      transformedPayload: sanitizeIntegrationPayload(deadLetter.transformedPayload),
      payloadRedacted: true,
    }
  }
  const { sourcePayload: _sourcePayload, transformedPayload: _transformedPayload, ...safe } = deadLetter
  return {
    ...safe,
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
const SECRET_TEXT_PATTERN = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|secret|signature|sig|sign|password)=([^&#\s]+)/ig
const AUTH_TEXT_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/ig
const JWT_TEXT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const SECRET_ID_PATTERN = /\bSEC[A-Za-z0-9_-]{12,}\b/g
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
  'metasheet:staging': {
    label: 'MetaSheet staging multitable',
    roles: ['source'],
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
}

function redactSecretText(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(/:\/\/([^:/?#\s]+):([^@/?#\s]+)@/g, '://[redacted]@')
    .replace(SECRET_TEXT_PATTERN, (match) => {
      const equals = match.indexOf('=')
      return equals === -1 ? '[redacted]' : `${match.slice(0, equals + 1)}[redacted]`
    })
    .replace(AUTH_TEXT_PATTERN, '$1 [redacted]')
    .replace(JWT_TEXT_PATTERN, '[redacted-jwt]')
    .replace(SECRET_ID_PATTERN, '[redacted-secret-id]')
}

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

function projectRecordForTemplate(record, schema) {
  if (!Array.isArray(schema) || schema.length === 0) return record
  const projected = {}
  for (const field of schema) {
    const value = getPath(record, field.name)
    if (value !== undefined) setPath(projected, field.name, value)
  }
  return projected
}

function buildTemplatePreview(input) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'input must be an object')
  }
  if (!isPlainObject(input.sourceRecord)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'sourceRecord must be an object', { field: 'sourceRecord' })
  }
  const fieldMappings = normalizePreviewFieldMappings(input.fieldMappings)
  const template = normalizePreviewTemplate(input.template)
  const transformed = transformRecord(input.sourceRecord, fieldMappings)
  const validation = transformed.ok ? validateRecord(transformed.value, fieldMappings) : { ok: true, valid: true, errors: [] }
  const requiredErrors = transformed.ok ? schemaRequiredErrors(transformed.value, template.schema) : []
  const targetRecord = projectRecordForTemplate(transformed.value, template.schema)
  const payload = {
    [template.bodyKey]: cloneJson(targetRecord),
  }
  const errors = [
    ...transformed.errors,
    ...validation.errors,
    ...requiredErrors,
  ].map((error) => cloneJson(error))
  return sanitizeIntegrationPayload({
    valid: errors.length === 0,
    payload,
    targetRecord: cloneJson(targetRecord),
    errors,
    transformErrors: transformed.errors.map((error) => cloneJson(error)),
    validationErrors: validation.errors.map((error) => cloneJson(error)),
    schemaErrors: requiredErrors.map((error) => cloneJson(error)),
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

function createHandlers(services) {
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

  const externalSystems = requireService('externalSystemRegistry', ['upsertExternalSystem', 'getExternalSystem', 'listExternalSystems'])
  const adapterRegistry = requireService('adapterRegistry', ['createAdapter', 'listAdapterKinds'])
  const pipelineRegistry = requireService('pipelineRegistry', ['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns'])
  const runner = requireService('pipelineRunner', ['runPipeline'])
  const deadLetters = requireService('deadLetterStore', ['listDeadLetters'])
  const stagingInstaller = requireService('stagingInstaller', ['installStaging', 'listStagingDescriptors'])

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

    async externalSystemsTest(req, res) {
      requireAccess(req, 'write')
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedInput(req, { id: requestParams(req).id }))
      const adapter = adapterRegistry.createAdapter(system)
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
      const adapter = adapterRegistry.createAdapter(system)
      const adapterObjects = typeof adapter.listObjects === 'function'
        ? await adapter.listObjects()
        : []
      const documentTemplateObjects = listDocumentTemplates(system)
      return sendOk(res, sanitizeIntegrationPayload([
        ...(Array.isArray(adapterObjects) ? adapterObjects : []),
        ...documentTemplateObjects,
      ]))
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
      const adapter = adapterRegistry.createAdapter(system)
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

    async templatesPreview(req, res) {
      requireAccess(req, 'write')
      return sendOk(res, buildTemplatePreview(requestBody(req)))
    },

    async stagingDescriptors(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, await stagingInstaller.listStagingDescriptors())
    },

    async stagingInstall(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      const projectId = firstString(body.projectId, requestQuery(req).projectId)
      if (!projectId) {
        throw new HttpRouteError(400, 'PROJECT_REQUIRED', 'projectId is required')
      }
      const baseId = firstString(body.baseId, requestQuery(req).baseId)
      return sendOk(res, await stagingInstaller.installStaging(scopedInput(req, {
        tenantId: body.tenantId,
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
  const handlers = createHandlers(services || {})
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
