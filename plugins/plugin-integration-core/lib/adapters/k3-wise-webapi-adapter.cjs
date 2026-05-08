'use strict'

// ---------------------------------------------------------------------------
// K3 WISE WebAPI adapter - plugin-integration-core
//
// PoC-level ERP target adapter for Kingdee K3 WISE. It intentionally keeps the
// adapter contract small: login/test, object discovery, schema, and target
// upsert through configured WebAPI endpoints. Submit/Audit are opt-in because
// many K3 WISE deployments require a customer-specific approval policy.
// ---------------------------------------------------------------------------

const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
  createUpsertResult,
  normalizeExternalSystemForAdapter,
  normalizeUpsertRequest,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')

class K3WiseWebApiAdapterError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WiseWebApiAdapterError'
    this.details = details
    this.status = details.status
  }
}

const DEFAULT_OBJECTS = {
  material: {
    label: 'K3 WISE Material',
    operations: ['upsert'],
    savePath: '/K3API/Material/Save',
    submitPath: '/K3API/Material/Submit',
    auditPath: '/K3API/Material/Audit',
    bodyKey: 'Model',
    keyField: 'FNumber',
    keyParam: 'Number',
    schema: [
      { name: 'FNumber', label: 'Material code', type: 'string', required: true },
      { name: 'FName', label: 'Material name', type: 'string', required: true },
      { name: 'FModel', label: 'Specification', type: 'string' },
      { name: 'FBaseUnitID', label: 'Base unit', type: 'string' },
    ],
  },
  bom: {
    label: 'K3 WISE BOM',
    operations: ['upsert'],
    savePath: '/K3API/BOM/Save',
    submitPath: '/K3API/BOM/Submit',
    auditPath: '/K3API/BOM/Audit',
    bodyKey: 'Model',
    keyField: 'FNumber',
    keyParam: 'Number',
    schema: [
      { name: 'FNumber', label: 'BOM code', type: 'string', required: true },
      { name: 'FParentItemNumber', label: 'Parent material code', type: 'string', required: true },
      { name: 'FChildItems', label: 'BOM children', type: 'array', required: true },
    ],
  },
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function toPlainObject(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new AdapterValidationError(`${field} must be an object`, { field })
  }
  return { ...value }
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterValidationError('K3 WISE WebAPI adapter requires config.baseUrl', {
      field: 'config.baseUrl',
    })
  }
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AdapterValidationError('K3 WISE WebAPI baseUrl must be http or https', {
      field: 'config.baseUrl',
    })
  }
  return url.toString()
}

function assertRelativePath(path, field) {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  const trimmed = path.trim()
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)
  const isProtocolRelative = trimmed.startsWith('//')
  const hasBackslash = trimmed.includes('\\')
  if (hasScheme || isProtocolRelative || hasBackslash) {
    throw new AdapterValidationError(`${field} must be relative to baseUrl`, { field })
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function buildEndpointUrl(baseUrl, path) {
  const endpointPath = assertRelativePath(path, 'path')
  const url = new URL(baseUrl)
  const basePath = url.pathname && url.pathname !== '/'
    ? url.pathname.replace(/\/+$/, '')
    : ''
  if (basePath && endpointPath !== basePath && !endpointPath.startsWith(`${basePath}/`)) {
    url.pathname = `${basePath}${endpointPath}`
  } else {
    url.pathname = endpointPath
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizeHeaders(value, field) {
  const headers = toPlainObject(value, field)
  const normalized = {}
  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined || val === null) continue
    normalized[key] = String(val)
  }
  return normalized
}

function mergeHeaders(...sets) {
  return Object.assign({}, ...sets.filter(Boolean))
}

function getPath(value, path) {
  if (!path) return value
  return String(path).split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined
    return current[key]
  }, value)
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

// Tri-state coercion for autoSubmit / autoAudit decision logic.
// Returns true / false for any boolean-like input, or null when the field is
// truly unset (undefined / null / ""). The decision logic at upsert-time uses
// null to mean "fall back to config default" — distinct from explicit false
// which must always disable the lifecycle step. Strict `=== true / !== false`
// would treat hand-edited string "false" as truthy (because "false" !== false),
// silently firing auto-submit / auto-audit against operator intent.
const TRUE_BOOLEAN_TEXT = new Set(['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'])
const FALSE_BOOLEAN_TEXT = new Set(['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'])

function coerceTriBool(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AdapterValidationError(`${field} must be a finite boolean, 0/1, or boolean-like string`, { field })
    }
    if (value === 1) return true
    if (value === 0) return false
    throw new AdapterValidationError(`${field} must be 0 or 1 when given as a number`, { field, received: value })
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) return null
    if (TRUE_BOOLEAN_TEXT.has(normalized)) return true
    if (FALSE_BOOLEAN_TEXT.has(normalized)) return false
  }
  throw new AdapterValidationError(`${field} must be a boolean, 0/1, or boolean-like string`, { field })
}

function resolveAutoFlag(requestValue, configValue, field) {
  const requestExplicit = coerceTriBool(requestValue, `request.options.${field}`)
  if (requestExplicit !== null) return requestExplicit
  const configExplicit = coerceTriBool(configValue, `config.${field}`)
  return configExplicit === true
}

async function parseResponseBody(response) {
  const text = typeof response.text === 'function' ? await response.text() : ''
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function responseOk(response) {
  if (typeof response.ok === 'boolean') return response.ok
  return response.status >= 200 && response.status < 300
}

function normalizeObjects(config) {
  const configured = toPlainObject(config.objects, 'config.objects')
  const normalized = {}
  for (const [name, defaults] of Object.entries(DEFAULT_OBJECTS)) {
    normalized[name] = { ...defaults, ...(isPlainObject(configured[name]) ? configured[name] : {}) }
  }
  for (const [name, value] of Object.entries(configured)) {
    if (normalized[name]) continue
    if (!isPlainObject(value)) {
      throw new AdapterValidationError(`config.objects.${name} must be an object`, {
        field: `config.objects.${name}`,
      })
    }
    normalized[name] = { operations: ['upsert'], ...value }
  }
  return normalized
}

function ensureOperation(kind, object, objectConfig, operation) {
  const operations = Array.isArray(objectConfig.operations) ? objectConfig.operations : ['upsert']
  if (!operations.includes(operation)) {
    throw new UnsupportedAdapterOperationError(`${kind} object ${object} does not support ${operation}`, {
      kind,
      object,
      operation,
    })
  }
}

function extractRecordKey(record, request, objectConfig) {
  const candidates = [
    objectConfig.keyField,
    ...(Array.isArray(request.keyFields) ? request.keyFields : []),
    'FNumber',
    'number',
    'code',
  ].filter(Boolean)
  for (const field of candidates) {
    if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
      return String(record[field])
    }
  }
  return null
}

function buildSaveBody(record, request, objectConfig) {
  if (typeof objectConfig.buildBody === 'function') {
    return objectConfig.buildBody(record, request)
  }
  const bodyKey = objectConfig.bodyKey || 'Model'
  const base = isPlainObject(objectConfig.bodyTemplate) ? { ...objectConfig.bodyTemplate } : {}
  base[bodyKey] = record
  return base
}

function buildLifecycleBody(record, request, objectConfig, operation) {
  if (typeof objectConfig.buildLifecycleBody === 'function') {
    return objectConfig.buildLifecycleBody(record, request, operation)
  }
  const key = extractRecordKey(record, request, objectConfig)
  const keyParam = objectConfig.keyParam || 'Number'
  return key ? { [keyParam]: key } : { record }
}

function businessSuccess(data, config) {
  if (config.successPath) return Boolean(getPath(data, config.successPath))
  const candidates = [
    getPath(data, 'success'),
    getPath(data, 'ok'),
    getPath(data, 'Success'),
    getPath(data, 'IsSuccess'),
    getPath(data, 'Result.ResponseStatus.IsSuccess'),
  ]
  for (const candidate of candidates) {
    if (candidate === true || candidate === 'true' || candidate === 1 || candidate === '1') return true
    if (candidate === false || candidate === 'false' || candidate === 0 || candidate === '0') return false
  }
  return false
}

function responseMessage(data, config, fallback = 'K3 WISE WebAPI business response failed') {
  return firstDefined(
    config.messagePath ? getPath(data, config.messagePath) : undefined,
    getPath(data, 'message'),
    getPath(data, 'Message'),
    getPath(data, 'error'),
    getPath(data, 'Error'),
    getPath(data, 'Result.ResponseStatus.Errors.0.Message'),
    fallback,
  )
}

function responseCode(data, config, fallback = 'OK') {
  return firstDefined(
    config.responseCodePath ? getPath(data, config.responseCodePath) : undefined,
    getPath(data, 'code'),
    getPath(data, 'Code'),
    getPath(data, 'errorCode'),
    getPath(data, 'ErrorCode'),
    getPath(data, 'Result.ResponseStatus.ErrorCode'),
    fallback,
  )
}

function responseBillNo(data, config) {
  return firstDefined(
    config.billNoPath ? getPath(data, config.billNoPath) : undefined,
    getPath(data, 'billNo'),
    getPath(data, 'BillNo'),
    getPath(data, 'number'),
    getPath(data, 'Number'),
    getPath(data, 'Result.Number'),
    getPath(data, 'Result.ResponseStatus.SuccessEntitys.0.Number'),
  )
}

function responseExternalId(data, config) {
  return firstDefined(
    config.externalIdPath ? getPath(data, config.externalIdPath) : undefined,
    getPath(data, 'externalId'),
    getPath(data, 'id'),
    getPath(data, 'Id'),
    getPath(data, 'FItemID'),
    getPath(data, 'Result.Id'),
    getPath(data, 'Result.ResponseStatus.SuccessEntitys.0.Id'),
  )
}

function createK3WiseWebApiAdapter({ system, fetchImpl = globalThis.fetch, logger } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const config = normalizedSystem.config
  const credentials = isPlainObject(normalizedSystem.credentials) ? normalizedSystem.credentials : {}
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.url)
  const objects = normalizeObjects(config)
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 30000
  const loginPath = assertRelativePath(config.loginPath || '/K3API/Login', 'config.loginPath')
  const healthPath = config.healthPath ? assertRelativePath(config.healthPath, 'config.healthPath') : null
  let cachedAuthHeaders = null

  if (typeof fetchImpl !== 'function') {
    throw new AdapterValidationError('K3 WISE WebAPI adapter requires fetch implementation', {
      field: 'fetchImpl',
    })
  }

  async function requestJson(path, { method = 'GET', headers, body } = {}) {
    const url = buildEndpointUrl(baseUrl, path)
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    const requestHeaders = mergeHeaders(
      { Accept: 'application/json' },
      normalizeHeaders(config.headers, 'config.headers'),
      body === undefined ? null : { 'Content-Type': 'application/json' },
      normalizeHeaders(headers, 'headers'),
    )

    try {
      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
      const data = await parseResponseBody(response)
      if (!responseOk(response)) {
        throw new K3WiseWebApiAdapterError(`K3 WISE WebAPI request failed: ${method} ${path}`, {
          status: response.status,
          body: data,
          method,
          path,
        })
      }
      return { response, data, url, headers: requestHeaders }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new K3WiseWebApiAdapterError(`K3 WISE WebAPI request timed out: ${method} ${path}`, {
          code: 'TIMEOUT',
          method,
          path,
          timeoutMs,
        })
      }
      if (error instanceof K3WiseWebApiAdapterError) throw error
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-integration-core] K3 WISE WebAPI request failed: ${method} ${path}`)
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async function login() {
    if (cachedAuthHeaders) return cachedAuthHeaders
    if (credentials.sessionId) {
      const header = config.sessionHeader || 'X-K3-Session'
      cachedAuthHeaders = { [header]: String(credentials.sessionId) }
      return cachedAuthHeaders
    }

    const username = firstDefined(credentials.username, credentials.userName)
    const password = firstDefined(credentials.password)
    const acctId = firstDefined(credentials.acctId, credentials.accountSet, credentials.accountSetId)
    if (!username || !password || !acctId) {
      throw new K3WiseWebApiAdapterError('K3 WISE WebAPI credentials (username, password, acctId) are required', {
        code: 'K3_WISE_CREDENTIALS_MISSING',
      })
    }

    const body = {
      username,
      password,
      acctId,
      lcid: firstDefined(config.lcid, credentials.lcid, 2052),
    }
    const { response, data } = await requestJson(loginPath, {
      method: config.loginMethod || 'POST',
      body,
    })

    if (!businessSuccess(data, config)) {
      throw new K3WiseWebApiAdapterError(String(responseMessage(data, config)), {
        code: 'K3_WISE_LOGIN_FAILED',
        body: data,
      })
    }

    const authHeaders = {}
    const cookie = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('set-cookie')
      : null
    const sessionId = firstDefined(
      config.sessionIdPath ? getPath(data, config.sessionIdPath) : undefined,
      getPath(data, 'sessionId'),
      getPath(data, 'SessionId'),
      getPath(data, 'Result.SessionId'),
    )
    if (cookie) authHeaders.Cookie = cookie
    if (sessionId) authHeaders[config.sessionHeader || 'X-K3-Session'] = String(sessionId)
    if (Object.keys(authHeaders).length === 0) {
      throw new K3WiseWebApiAdapterError('K3 WISE WebAPI login succeeded but did not return a session cookie or session id', {
        code: 'K3_WISE_AUTH_TRANSPORT_MISSING',
        body: data,
      })
    }
    cachedAuthHeaders = authHeaders
    return cachedAuthHeaders
  }

  async function testConnection(input = {}) {
    try {
      const authHeaders = await login()
      if (input.skipHealth || !healthPath) {
        return { ok: true, status: 200, authenticated: Object.keys(authHeaders).length > 0 }
      }
      const { response } = await requestJson(healthPath, {
        method: input.method || 'GET',
        headers: authHeaders,
      })
      return { ok: true, status: response.status, authenticated: Object.keys(authHeaders).length > 0 }
    } catch (error) {
      return {
        ok: false,
        status: error && error.status,
        code: error && error.details && error.details.code ? error.details.code : 'K3_WISE_TEST_FAILED',
        message: error && error.message ? error.message : String(error),
      }
    }
  }

  async function listObjects() {
    return Object.entries(objects).map(([name, objectConfig]) => ({
      name,
      label: objectConfig.label || name,
      operations: Array.isArray(objectConfig.operations) ? [...objectConfig.operations] : ['upsert'],
      schema: Array.isArray(objectConfig.schema) ? objectConfig.schema.map((field) => ({ ...field })) : undefined,
    }))
  }

  async function getSchema(input = {}) {
    const object = typeof input === 'string' ? input : input.object
    const objectConfig = objects[object]
    if (!objectConfig) {
      throw new AdapterValidationError(`K3 WISE object is not configured: ${object}`, { object })
    }
    return {
      object,
      fields: Array.isArray(objectConfig.schema) ? objectConfig.schema.map((field) => ({ ...field })) : [],
    }
  }

  async function upsert(input = {}) {
    const request = normalizeUpsertRequest(input)
    const objectConfig = objects[request.object]
    if (!objectConfig) {
      throw new AdapterValidationError(`K3 WISE object is not configured: ${request.object}`, { object: request.object })
    }
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'upsert')

    const savePath = assertRelativePath(objectConfig.savePath || objectConfig.path, 'object.savePath')
    const submitPath = objectConfig.submitPath ? assertRelativePath(objectConfig.submitPath, 'object.submitPath') : null
    const auditPath = objectConfig.auditPath ? assertRelativePath(objectConfig.auditPath, 'object.auditPath') : null
    const autoSubmit = resolveAutoFlag(request.options.autoSubmit, config.autoSubmit, 'autoSubmit')
    const autoAudit = resolveAutoFlag(request.options.autoAudit, config.autoAudit, 'autoAudit')
    const authHeaders = await login()
    const results = []
    const errors = []
    const raw = []

    for (let index = 0; index < request.records.length; index += 1) {
      const record = request.records[index]
      const key = extractRecordKey(record, request, objectConfig)
      try {
        const save = await requestJson(savePath, {
          method: objectConfig.saveMethod || 'POST',
          headers: authHeaders,
          body: buildSaveBody(record, request, objectConfig),
        })
        raw.push({ index, operation: 'save', body: save.data })
        if (!businessSuccess(save.data, config)) {
          throw new K3WiseWebApiAdapterError(String(responseMessage(save.data, config)), {
            code: responseCode(save.data, config, 'K3_WISE_SAVE_FAILED'),
            body: save.data,
            object: request.object,
            key,
          })
        }

        if (autoSubmit) {
          if (!submitPath) {
            throw new K3WiseWebApiAdapterError('K3 WISE submit requested but submitPath is not configured', {
              code: 'K3_WISE_SUBMIT_PATH_MISSING',
              object: request.object,
              key,
            })
          }
          const submit = await requestJson(submitPath, {
            method: objectConfig.submitMethod || 'POST',
            headers: authHeaders,
            body: buildLifecycleBody(record, request, objectConfig, 'submit'),
          })
          raw.push({ index, operation: 'submit', body: submit.data })
          if (!businessSuccess(submit.data, config)) {
            throw new K3WiseWebApiAdapterError(String(responseMessage(submit.data, config)), {
              code: responseCode(submit.data, config, 'K3_WISE_SUBMIT_FAILED'),
              body: submit.data,
              object: request.object,
              key,
            })
          }
        }

        if (autoAudit) {
          if (!auditPath) {
            throw new K3WiseWebApiAdapterError('K3 WISE audit requested but auditPath is not configured', {
              code: 'K3_WISE_AUDIT_PATH_MISSING',
              object: request.object,
              key,
            })
          }
          const audit = await requestJson(auditPath, {
            method: objectConfig.auditMethod || 'POST',
            headers: authHeaders,
            body: buildLifecycleBody(record, request, objectConfig, 'audit'),
          })
          raw.push({ index, operation: 'audit', body: audit.data })
          if (!businessSuccess(audit.data, config)) {
            throw new K3WiseWebApiAdapterError(String(responseMessage(audit.data, config)), {
              code: responseCode(audit.data, config, 'K3_WISE_AUDIT_FAILED'),
              body: audit.data,
              object: request.object,
              key,
            })
          }
        }

        results.push({
          index,
          key,
          object: request.object,
          status: 'written',
          externalId: responseExternalId(save.data, config),
          billNo: responseBillNo(save.data, config),
          responseCode: responseCode(save.data, config, 'OK'),
          responseMessage: responseMessage(save.data, config, 'K3 WISE save succeeded'),
          raw: save.data,
        })
      } catch (error) {
        errors.push({
          index,
          key,
          object: request.object,
          code: error && error.details && error.details.code ? error.details.code : 'K3_WISE_UPSERT_FAILED',
          message: error && error.message ? error.message : String(error),
        })
      }
    }

    return createUpsertResult({
      written: results.length,
      failed: errors.length,
      results,
      errors,
      raw,
      metadata: {
        object: request.object,
        autoSubmit,
        autoAudit,
      },
    })
  }

  return {
    kind: normalizedSystem.kind,
    systemId: normalizedSystem.id,
    testConnection,
    listObjects,
    getSchema,
    read: unsupportedAdapterOperation(normalizedSystem.kind, 'read'),
    upsert,
  }
}

function createK3WiseWebApiAdapterFactory(defaults = {}) {
  return (input = {}) => createK3WiseWebApiAdapter({ ...defaults, ...input })
}

module.exports = {
  K3WiseWebApiAdapterError,
  createK3WiseWebApiAdapter,
  createK3WiseWebApiAdapterFactory,
  __internals: {
    DEFAULT_OBJECTS,
    businessSuccess,
    extractRecordKey,
    normalizeObjects,
    responseBillNo,
    responseCode,
    responseExternalId,
  },
}
