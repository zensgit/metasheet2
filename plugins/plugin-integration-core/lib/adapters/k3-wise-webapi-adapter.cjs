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
const {
  getK3WiseDocumentObjectDefaults,
  listK3WiseDocumentTemplates,
  mergeK3WiseDocumentObject,
  normalizeTemplate,
} = require('./k3-wise-document-templates.cjs')

class K3WiseWebApiAdapterError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WiseWebApiAdapterError'
    this.details = details
    this.status = details.status
  }
}

const DEFAULT_OBJECTS = getK3WiseDocumentObjectDefaults()

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
  return url
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

function normalizeBusinessBoolean(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) return null
    if (['true', '1', 'yes', 'y', 'success', 'successful', 'ok', '是', '成功'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'fail', 'failed', 'faild', 'failure', 'error', '否', '失败', '错误'].includes(normalized)) return false
  }
  return null
}

function businessTextIndicatesFailure(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  return /\b(faild|failed|failure|error|invalid|denied|not\s+exist|not\s+found|no\s+access)\b/i.test(value) ||
    /失败|错误|不存在|无权限|无权|非法|无效/.test(value)
}

function getStatusCode(data) {
  return toPositiveNumber(firstDefined(getPath(data, 'StatusCode'), getPath(data, 'statusCode')))
}

function getDataCode(data) {
  return firstDefined(getPath(data, 'Data.Code'), getPath(data, 'data.code'))
}

function getSuccessEntityCount(data) {
  const successEntities = firstDefined(
    getPath(data, 'Result.ResponseStatus.SuccessEntitys'),
    getPath(data, 'Result.ResponseStatus.SuccessEntities'),
    getPath(data, 'Data.SuccessEntitys'),
    getPath(data, 'Data.SuccessEntities'),
  )
  return Array.isArray(successEntities) ? successEntities.length : 0
}

function businessRowMessage(row) {
  return firstDefined(
    getPath(row, 'FMessage'),
    getPath(row, 'Message'),
    getPath(row, 'message'),
    getPath(row, 'ErrorMessage'),
    getPath(row, 'errorMessage'),
    getPath(row, 'FErrMessage'),
    getPath(row, 'ErrMessage'),
  )
}

function businessRowStatus(row) {
  return normalizeBusinessBoolean(firstDefined(
    getPath(row, 'FStatus'),
    getPath(row, 'fStatus'),
    getPath(row, 'status'),
    getPath(row, 'Status'),
    getPath(row, 'success'),
    getPath(row, 'Success'),
    getPath(row, 'IsSuccess'),
    getPath(row, 'isSuccess'),
  ))
}

function isMeaningfulIdentifier(value) {
  if (value === undefined || value === null || value === '') return false
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized.length > 0 && !['0', 'null', 'undefined', 'none'].includes(normalized)
  }
  return true
}

function businessRowHasIdentifier(row) {
  return isMeaningfulIdentifier(firstDefined(
    getPath(row, 'FItemID'),
    getPath(row, 'FItemId'),
    getPath(row, 'FId'),
    getPath(row, 'FID'),
    getPath(row, 'Id'),
    getPath(row, 'id'),
    getPath(row, 'Number'),
    getPath(row, 'FNumber'),
  ))
}

function extractBusinessRows(data) {
  const rows = []
  const candidates = [
    getPath(data, 'Data'),
    getPath(data, 'data'),
    getPath(data, 'Result.Data'),
    getPath(data, 'Result.ResponseStatus.SuccessEntitys'),
    getPath(data, 'Result.ResponseStatus.SuccessEntities'),
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      rows.push(...candidate.filter(isPlainObject))
    } else if (isPlainObject(candidate) && (
      businessRowStatus(candidate) !== null ||
      businessRowMessage(candidate) !== undefined ||
      businessRowHasIdentifier(candidate)
    )) {
      rows.push(candidate)
    }
  }
  return rows
}

function hasExplicitBusinessFailure(data) {
  const dataCode = getDataCode(data)
  if (typeof dataCode === 'string' && ['N', 'NO', 'FALSE', 'FAILED', 'FAILD', 'ERROR'].includes(dataCode.trim().toUpperCase())) return true
  const responseSuccess = normalizeBusinessBoolean(getPath(data, 'Result.ResponseStatus.IsSuccess'))
  if (responseSuccess === false) return true
  for (const row of extractBusinessRows(data)) {
    if (businessRowStatus(row) === false) return true
    if (businessTextIndicatesFailure(businessRowMessage(row))) return true
  }
  return businessTextIndicatesFailure(firstDefined(getPath(data, 'Message'), getPath(data, 'message')))
}

function hasExplicitBusinessSuccess(data) {
  const dataCode = getDataCode(data)
  if (typeof dataCode === 'string' && ['Y', 'YES', 'TRUE', 'SUCCESS', 'OK'].includes(dataCode.trim().toUpperCase())) return true
  const candidates = [
    getPath(data, 'success'),
    getPath(data, 'ok'),
    getPath(data, 'Success'),
    getPath(data, 'IsSuccess'),
    getPath(data, 'Result.ResponseStatus.IsSuccess'),
  ]
  if (candidates.some((candidate) => normalizeBusinessBoolean(candidate) === true)) return true
  if (getSuccessEntityCount(data) > 0) return true
  return extractBusinessRows(data).some((row) => businessRowStatus(row) === true && businessRowHasIdentifier(row))
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

function toPositiveNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function normalizeObjects(config) {
  const configured = toPlainObject(config.objects, 'config.objects')
  const normalized = {}
  for (const [name, defaults] of Object.entries(DEFAULT_OBJECTS)) {
    try {
      normalized[name] = mergeK3WiseDocumentObject(
        defaults,
        isPlainObject(configured[name]) ? configured[name] : {},
        `config.objects.${name}`,
      )
    } catch (error) {
      throw new AdapterValidationError(error.message, {
        field: `config.objects.${name}`,
      })
    }
  }
  for (const [name, value] of Object.entries(configured)) {
    if (normalized[name]) continue
    if (!isPlainObject(value)) {
      throw new AdapterValidationError(`config.objects.${name} must be an object`, {
        field: `config.objects.${name}`,
      })
    }
    try {
      normalized[name] = normalizeTemplate({ operations: ['upsert'], ...value }, `config.objects.${name}`)
    } catch (error) {
      throw new AdapterValidationError(error.message, {
        field: `config.objects.${name}`,
      })
    }
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
  const bodyKey = objectConfig.bodyKey || 'Data'
  const base = isPlainObject(objectConfig.bodyTemplate) ? { ...objectConfig.bodyTemplate } : {}
  base[bodyKey] = projectRecordForBody(record, objectConfig)
  return base
}

function projectRecordForBody(record, objectConfig) {
  if (objectConfig.passThroughBody === true) return record
  if (!isPlainObject(record)) return record
  const schemaFields = Array.isArray(objectConfig.schema)
    ? objectConfig.schema
      .map((field) => field && field.name)
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
    : []
  if (schemaFields.length === 0) return record
  const projected = {}
  for (const field of schemaFields) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      projected[field] = record[field]
    }
  }
  return projected
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
  if (hasExplicitBusinessFailure(data)) return false
  if (config.successPath) return Boolean(getPath(data, config.successPath))
  const statusCode = getStatusCode(data)
  const dataCode = getDataCode(data)
  if (typeof dataCode === 'string' && ['Y', 'YES', 'TRUE', 'SUCCESS', 'OK'].includes(dataCode.trim().toUpperCase())) return true
  if (statusCode !== null) return statusCode >= 200 && statusCode < 300
  if (hasExplicitBusinessSuccess(data)) return true
  return false
}

function saveBusinessSuccess(data, config) {
  if (hasExplicitBusinessFailure(data)) return false
  if (config.saveSuccessPath) return Boolean(getPath(data, config.saveSuccessPath))
  if (config.successPath) return Boolean(getPath(data, config.successPath))
  return hasExplicitBusinessSuccess(data)
}

function responseMessage(data, config, fallback = 'K3 WISE WebAPI business response failed') {
  return firstDefined(
    config.messagePath ? getPath(data, config.messagePath) : undefined,
    getPath(data, 'Data.0.FMessage'),
    getPath(data, 'Data.0.Message'),
    getPath(data, 'Data.0.ErrorMessage'),
    getPath(data, 'Data.0.FErrMessage'),
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
    getPath(data, 'Data.0.Code'),
    getPath(data, 'Data.0.ErrorCode'),
    getPath(data, 'StatusCode'),
    getPath(data, 'Data.Code'),
    getPath(data, 'Result.ResponseStatus.ErrorCode'),
    fallback,
  )
}

function responseFailureCode(data, config, fallback) {
  const explicit = firstDefined(
    config.responseCodePath ? getPath(data, config.responseCodePath) : undefined,
    getPath(data, 'code'),
    getPath(data, 'Code'),
    getPath(data, 'errorCode'),
    getPath(data, 'ErrorCode'),
    getPath(data, 'Data.0.Code'),
    getPath(data, 'Data.0.ErrorCode'),
    getPath(data, 'Data.Code'),
    getPath(data, 'Result.ResponseStatus.ErrorCode'),
  )
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit
  const statusCode = getStatusCode(data)
  if (statusCode !== null && (statusCode < 200 || statusCode >= 300)) return statusCode
  return fallback
}

function responseBillNo(data, config) {
  return firstDefined(
    config.billNoPath ? getPath(data, config.billNoPath) : undefined,
    getPath(data, 'billNo'),
    getPath(data, 'BillNo'),
    getPath(data, 'number'),
    getPath(data, 'Number'),
    getPath(data, 'Data.FBillNo'),
    getPath(data, 'Data.0.FBillNo'),
    getPath(data, 'Data.FNumber'),
    getPath(data, 'Data.0.FNumber'),
    getPath(data, 'Result.Number'),
    getPath(data, 'Result.ResponseStatus.SuccessEntitys.0.Number'),
  )
}

function responseExternalId(data, config) {
  const candidates = [
    config.externalIdPath ? getPath(data, config.externalIdPath) : undefined,
    getPath(data, 'externalId'),
    getPath(data, 'id'),
    getPath(data, 'Id'),
    getPath(data, 'FItemID'),
    getPath(data, 'Data.FItemID'),
    getPath(data, 'Data.0.FItemID'),
    getPath(data, 'Data.Id'),
    getPath(data, 'Data.0.Id'),
    getPath(data, 'Result.Id'),
    getPath(data, 'Result.ResponseStatus.SuccessEntitys.0.Id'),
  ]
  return candidates.find(isMeaningfulIdentifier)
}

function createBusinessResponseSummary(data, config, { operation, success }) {
  const rows = extractBusinessRows(data)
  const rowStatuses = rows.map((row) => businessRowStatus(row)).filter((value) => value !== null)
  const failedRows = rowStatuses.filter((value) => value === false).length
  const successfulRows = rowStatuses.filter((value) => value === true).length
  const externalId = responseExternalId(data, config)
  const billNo = responseBillNo(data, config)
  const message = responseMessage(data, config, null)
  return {
    operation,
    success: Boolean(success),
    envelopeStatusCode: firstDefined(getPath(data, 'StatusCode'), getPath(data, 'statusCode'), null),
    envelopeMessagePresent: firstDefined(getPath(data, 'Message'), getPath(data, 'message')) !== undefined,
    dataCode: firstDefined(getPath(data, 'Data.Code'), getPath(data, 'data.code'), null),
    responseCode: responseCode(data, config, null),
    responseMessagePresent: message !== undefined && message !== null && message !== '',
    rowCount: rows.length,
    successfulRowCount: successfulRows,
    failedRowCount: failedRows,
    successEntityCount: getSuccessEntityCount(data),
    externalIdPresent: isMeaningfulIdentifier(externalId),
    billNoPresent: isMeaningfulIdentifier(billNo),
  }
}

function createK3WiseWebApiAdapter({ system, fetchImpl = globalThis.fetch, logger } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const config = normalizedSystem.config
  const credentials = isPlainObject(normalizedSystem.credentials) ? normalizedSystem.credentials : {}
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.url)
  const objects = normalizeObjects(config)
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 30000
  const loginPath = assertRelativePath(config.loginPath || '/K3API/Login', 'config.loginPath')
  const tokenPath = assertRelativePath(config.tokenPath || '/K3API/Token/Create', 'config.tokenPath')
  const tokenQueryParam = typeof config.tokenQueryParam === 'string' && config.tokenQueryParam.trim()
    ? config.tokenQueryParam.trim()
    : 'Token'
  const healthPath = config.healthPath ? assertRelativePath(config.healthPath, 'config.healthPath') : null
  let cachedAuthContext = null

  if (typeof fetchImpl !== 'function') {
    throw new AdapterValidationError('K3 WISE WebAPI adapter requires fetch implementation', {
      field: 'fetchImpl',
    })
  }

  function buildUrl(path, query) {
    const url = buildEndpointUrl(baseUrl, path)
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  async function requestJson(path, { method = 'GET', query, headers, body } = {}) {
    const url = buildUrl(path, query)
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

  function isFreshAuthContext(context) {
    return Boolean(context && (!context.expiresAt || context.expiresAt > Date.now() + 60000))
  }

  async function loginWithAuthorityCode(authorityCode) {
    const { data } = await requestJson(tokenPath, {
      method: config.tokenMethod || 'GET',
      query: { authorityCode },
    })
    const token = firstDefined(
      config.tokenPathInResponse ? getPath(data, config.tokenPathInResponse) : undefined,
      getPath(data, 'Data.Token'),
      getPath(data, 'data.token'),
      getPath(data, 'token'),
      getPath(data, 'Token'),
    )
    if (!token || !businessSuccess(data, config)) {
      throw new K3WiseWebApiAdapterError(String(responseMessage(data, config, 'K3 WISE token request failed')), {
        code: 'K3_WISE_TOKEN_FAILED',
        body: data,
      })
    }
    const validitySeconds = toPositiveNumber(firstDefined(
      getPath(data, 'Data.Validity'),
      getPath(data, 'data.validity'),
      getPath(data, 'validity'),
      getPath(data, 'Validity'),
    ))
    return {
      headers: {},
      query: { [tokenQueryParam]: String(token) },
      expiresAt: validitySeconds ? Date.now() + (validitySeconds * 1000) : null,
    }
  }

  async function login() {
    if (isFreshAuthContext(cachedAuthContext)) return cachedAuthContext
    if (credentials.sessionId) {
      const header = config.sessionHeader || 'X-K3-Session'
      cachedAuthContext = { headers: { [header]: String(credentials.sessionId) }, query: {}, expiresAt: null }
      return cachedAuthContext
    }

    const authorityCode = firstDefined(credentials.authorityCode, credentials.authCode, config.authorityCode)
    const authMode = firstDefined(config.authMode, authorityCode ? 'authority-code' : null, 'login')
    if (authMode === 'authority-code' || authMode === 'authorityCode' || authMode === 'token') {
      if (!authorityCode) {
        throw new K3WiseWebApiAdapterError('K3 WISE WebAPI authorityCode is required for token authentication', {
          code: 'K3_WISE_CREDENTIALS_MISSING',
        })
      }
      cachedAuthContext = await loginWithAuthorityCode(String(authorityCode))
      return cachedAuthContext
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
    cachedAuthContext = { headers: authHeaders, query: {}, expiresAt: null }
    return cachedAuthContext
  }

  async function testConnection(input = {}) {
    try {
      const authContext = await login()
      if (input.skipHealth || !healthPath) {
        return {
          ok: true,
          status: 200,
          authenticated: Object.keys(authContext.headers || {}).length > 0 || Object.keys(authContext.query || {}).length > 0,
        }
      }
      const { response } = await requestJson(healthPath, {
        method: input.method || 'GET',
        query: authContext.query,
        headers: authContext.headers,
      })
      return {
        ok: true,
        status: response.status,
        authenticated: Object.keys(authContext.headers || {}).length > 0 || Object.keys(authContext.query || {}).length > 0,
      }
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
      k3Template: objectConfig.k3Template ? { ...objectConfig.k3Template } : undefined,
    }
  }

  async function previewUpsert(input = {}) {
    const request = normalizeUpsertRequest(input)
    const objectConfig = objects[request.object]
    if (!objectConfig) {
      throw new AdapterValidationError(`K3 WISE object is not configured: ${request.object}`, { object: request.object })
    }
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'upsert')
    const savePath = assertRelativePath(objectConfig.savePath || objectConfig.path, 'object.savePath')
    const autoSubmit = resolveAutoFlag(request.options.autoSubmit, config.autoSubmit, 'autoSubmit')
    const autoAudit = resolveAutoFlag(request.options.autoAudit, config.autoAudit, 'autoAudit')
    return {
      object: request.object,
      records: request.records.map((record, index) => ({
        index,
        key: extractRecordKey(record, request, objectConfig),
        operation: 'save',
        method: objectConfig.saveMethod || 'POST',
        path: savePath,
        query: { [tokenQueryParam]: '<redacted>' },
        body: buildSaveBody(record, request, objectConfig),
      })),
      metadata: {
        object: request.object,
        autoSubmit,
        autoAudit,
        k3Template: objectConfig.k3Template ? { ...objectConfig.k3Template } : undefined,
      },
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
    const authContext = await login()
    const results = []
    const errors = []
    const raw = []
    const businessResponses = []

    for (let index = 0; index < request.records.length; index += 1) {
      const record = request.records[index]
      const key = extractRecordKey(record, request, objectConfig)
      try {
        const save = await requestJson(savePath, {
          method: objectConfig.saveMethod || 'POST',
          query: authContext.query,
          headers: authContext.headers,
          body: buildSaveBody(record, request, objectConfig),
        })
        const saveSucceeded = saveBusinessSuccess(save.data, config)
        const saveSummary = createBusinessResponseSummary(save.data, config, {
          operation: 'save',
          success: saveSucceeded,
        })
        raw.push({ index, operation: 'save', body: save.data, summary: saveSummary })
        businessResponses.push({ index, object: request.object, ...saveSummary })
        if (!saveSucceeded) {
          throw new K3WiseWebApiAdapterError(String(responseMessage(save.data, config)), {
            code: responseFailureCode(save.data, config, 'K3_WISE_SAVE_FAILED'),
            body: save.data,
            responseSummary: saveSummary,
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
            query: authContext.query,
            headers: authContext.headers,
            body: buildLifecycleBody(record, request, objectConfig, 'submit'),
          })
          const submitSucceeded = businessSuccess(submit.data, config)
          const submitSummary = createBusinessResponseSummary(submit.data, config, {
            operation: 'submit',
            success: submitSucceeded,
          })
          raw.push({ index, operation: 'submit', body: submit.data, summary: submitSummary })
          businessResponses.push({ index, object: request.object, ...submitSummary })
          if (!submitSucceeded) {
            throw new K3WiseWebApiAdapterError(String(responseMessage(submit.data, config)), {
              code: responseCode(submit.data, config, 'K3_WISE_SUBMIT_FAILED'),
              body: submit.data,
              responseSummary: submitSummary,
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
            query: authContext.query,
            headers: authContext.headers,
            body: buildLifecycleBody(record, request, objectConfig, 'audit'),
          })
          const auditSucceeded = businessSuccess(audit.data, config)
          const auditSummary = createBusinessResponseSummary(audit.data, config, {
            operation: 'audit',
            success: auditSucceeded,
          })
          raw.push({ index, operation: 'audit', body: audit.data, summary: auditSummary })
          businessResponses.push({ index, object: request.object, ...auditSummary })
          if (!auditSucceeded) {
            throw new K3WiseWebApiAdapterError(String(responseMessage(audit.data, config)), {
              code: responseCode(audit.data, config, 'K3_WISE_AUDIT_FAILED'),
              body: audit.data,
              responseSummary: auditSummary,
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
          responseSummary: saveSummary,
          raw: save.data,
        })
      } catch (error) {
        errors.push({
          index,
          key,
          object: request.object,
          code: error && error.details && error.details.code ? error.details.code : 'K3_WISE_UPSERT_FAILED',
          message: error && error.message ? error.message : String(error),
          responseSummary: error && error.details && error.details.responseSummary
            ? error.details.responseSummary
            : undefined,
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
        k3Template: objectConfig.k3Template ? { ...objectConfig.k3Template } : undefined,
        businessResponses,
      },
    })
  }

  return {
    kind: normalizedSystem.kind,
    systemId: normalizedSystem.id,
    testConnection,
    listObjects,
    getSchema,
    previewUpsert,
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
    listK3WiseDocumentTemplates,
    normalizeObjects,
    projectRecordForBody,
    responseBillNo,
    responseCode,
    responseExternalId,
    saveBusinessSuccess,
  },
}
