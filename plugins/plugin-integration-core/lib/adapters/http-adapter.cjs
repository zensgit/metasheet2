'use strict'

// ---------------------------------------------------------------------------
// HTTP adapter - plugin-integration-core
//
// Config-driven HTTP source/target adapter for M1. It uses injected `fetch`
// in tests and Node's global fetch in runtime. Credentials must be provided by
// the caller as decrypted values; this adapter never reads credential storage.
// ---------------------------------------------------------------------------

const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
  createReadResult,
  createUpsertResult,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  normalizeUpsertRequest,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')

class HttpAdapterError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'HttpAdapterError'
    this.details = details
    this.status = details.status
  }
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
    throw new AdapterValidationError('HTTP adapter requires config.baseUrl', { field: 'config.baseUrl' })
  }
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AdapterValidationError('HTTP adapter baseUrl must be http or https', { field: 'config.baseUrl' })
  }
  return url.toString()
}

function assertRelativePath(path, field) {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  const trimmed = path.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    throw new AdapterValidationError(`${field} must be relative to baseUrl`, { field })
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed) || trimmed.includes('\\')) {
    throw new AdapterValidationError(`${field} must be a safe URL path`, { field })
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function getPath(value, path) {
  if (!path) return value
  return String(path).split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined
    return current[key]
  }, value)
}

function getNumberPath(value, path, fallback) {
  const located = getPath(value, path)
  const numeric = Number(located)
  return Number.isFinite(numeric) ? numeric : fallback
}

function appendQuery(url, query) {
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, String(item))
      }
      continue
    }
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      url.searchParams.set(key, String(value))
    }
  }
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(assertRelativePath(path, 'path'), baseUrl)
  appendQuery(url, query)
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

function credentialHeaders(credentials, config) {
  if (!isPlainObject(credentials)) return {}
  const headers = {}
  if (credentials.bearerToken) {
    headers.Authorization = `Bearer ${String(credentials.bearerToken)}`
  }
  if (credentials.apiKey) {
    const header = typeof config.apiKeyHeader === 'string' && config.apiKeyHeader.trim()
      ? config.apiKeyHeader.trim()
      : 'X-API-Key'
    headers[header] = String(credentials.apiKey)
  }
  if (credentials.username && credentials.password) {
    const raw = `${String(credentials.username)}:${String(credentials.password)}`
    headers.Authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
  }
  return headers
}

function mergeHeaders(...sets) {
  return Object.assign({}, ...sets.filter(Boolean))
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

function normalizeObjectConfig(objects, object) {
  const raw = objects[object]
  if (typeof raw === 'string') return { path: raw }
  if (!isPlainObject(raw)) {
    throw new AdapterValidationError(`HTTP object is not configured: ${object}`, { object })
  }
  return { ...raw }
}

function ensureOperation(kind, object, objectConfig, operation) {
  if (Array.isArray(objectConfig.operations) && !objectConfig.operations.includes(operation)) {
    throw new UnsupportedAdapterOperationError(`${kind} object ${object} does not support ${operation}`, {
      kind,
      object,
      operation,
    })
  }
}

function normalizeObjects(config) {
  const objects = toPlainObject(config.objects, 'config.objects')
  const normalized = {}
  for (const [name, value] of Object.entries(objects)) {
    if (typeof value === 'string') {
      normalized[name] = { path: value }
    } else if (isPlainObject(value)) {
      normalized[name] = { ...value }
    } else {
      throw new AdapterValidationError(`config.objects.${name} must be a path string or object`, {
        field: `config.objects.${name}`,
      })
    }
  }
  return normalized
}

function createHttpAdapter({ system, fetchImpl = globalThis.fetch, logger } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const config = normalizedSystem.config
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.url)
  const objects = normalizeObjects(config)
  const defaultHeaders = mergeHeaders(
    { Accept: 'application/json' },
    normalizeHeaders(config.headers, 'config.headers'),
    credentialHeaders(normalizedSystem.credentials, config),
  )
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 30000

  if (typeof fetchImpl !== 'function') {
    throw new AdapterValidationError('HTTP adapter requires fetch implementation', { field: 'fetchImpl' })
  }

  async function requestJson(path, { method = 'GET', query, headers, body } = {}) {
    const url = buildUrl(baseUrl, path, query)
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    const requestHeaders = mergeHeaders(
      defaultHeaders,
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
        throw new HttpAdapterError(`HTTP adapter request failed: ${method} ${path}`, {
          status: response.status,
          body: data,
          method,
          path,
        })
      }
      return { response, data, url, headers: requestHeaders }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new HttpAdapterError(`HTTP adapter request timed out: ${method} ${path}`, {
          code: 'TIMEOUT',
          method,
          path,
          timeoutMs,
        })
      }
      if (error instanceof HttpAdapterError) throw error
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-integration-core] HTTP adapter request failed: ${method} ${path}`)
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  function getObjectConfig(object) {
    return normalizeObjectConfig(objects, object)
  }

  async function testConnection(input = {}) {
    const healthPath = input.path || config.healthPath || '/'
    try {
      const { response } = await requestJson(healthPath, {
        method: input.method || 'GET',
        headers: input.headers,
      })
      return {
        ok: true,
        status: response.status,
      }
    } catch (error) {
      return {
        ok: false,
        status: error && error.status,
        code: error && error.details && error.details.code ? error.details.code : 'HTTP_TEST_FAILED',
        message: error && error.message ? error.message : String(error),
      }
    }
  }

  async function listObjects() {
    return Object.entries(objects).map(([name, objectConfig]) => ({
      name,
      label: objectConfig.label || name,
      operations: Array.isArray(objectConfig.operations) ? [...objectConfig.operations] : ['read', 'upsert'],
      schema: Array.isArray(objectConfig.schema) ? objectConfig.schema : undefined,
    }))
  }

  async function getSchema(input = {}) {
    const object = typeof input === 'string' ? input : input.object
    const objectConfig = getObjectConfig(object)
    if (Array.isArray(objectConfig.schema)) {
      return {
        object,
        fields: objectConfig.schema.map((field) => ({ ...field })),
      }
    }
    if (objectConfig.schemaPath) {
      const { data } = await requestJson(objectConfig.schemaPath, {
        method: objectConfig.schemaMethod || 'GET',
        headers: objectConfig.headers,
      })
      const fields = getPath(data, objectConfig.schemaFieldsPath || 'fields')
      return {
        object,
        fields: Array.isArray(fields) ? fields : [],
        raw: data,
      }
    }
    return { object, fields: [] }
  }

  async function read(input = {}) {
    const request = normalizeReadRequest(input)
    const objectConfig = getObjectConfig(request.object)
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'read')
    const path = assertRelativePath(objectConfig.path || objectConfig.readPath, 'object.path')
    const query = {
      ...toPlainObject(objectConfig.query, 'object.query'),
      ...request.filters,
      limit: request.limit,
      cursor: request.cursor,
      ...request.watermark,
      ...request.options.query,
    }
    const { data } = await requestJson(path, {
      method: objectConfig.method || objectConfig.readMethod || 'GET',
      query,
      headers: objectConfig.headers,
    })
    const locatedRecords = objectConfig.recordsPath ? getPath(data, objectConfig.recordsPath) : data
    const records = Array.isArray(locatedRecords) ? locatedRecords : []
    const nextCursor = objectConfig.nextCursorPath ? getPath(data, objectConfig.nextCursorPath) : getPath(data, 'nextCursor')
    return createReadResult({
      records,
      nextCursor,
      done: objectConfig.donePath ? Boolean(getPath(data, objectConfig.donePath)) : nextCursor === undefined || nextCursor === null,
      raw: data,
      metadata: {
        object: request.object,
        count: records.length,
      },
    })
  }

  async function upsert(input = {}) {
    const request = normalizeUpsertRequest(input)
    const objectConfig = getObjectConfig(request.object)
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'upsert')
    const path = assertRelativePath(objectConfig.upsertPath || objectConfig.path, 'object.upsertPath')
    const body = objectConfig.bodyMode === 'array'
      ? request.records
      : {
          records: request.records,
          keyFields: request.keyFields,
          mode: request.mode,
        }
    const { data } = await requestJson(path, {
      method: objectConfig.upsertMethod || 'POST',
      headers: objectConfig.headers,
      body,
    })
    const results = objectConfig.resultsPath ? getPath(data, objectConfig.resultsPath) : getPath(data, 'results')
    const errors = objectConfig.errorsPath ? getPath(data, objectConfig.errorsPath) : getPath(data, 'errors')
    return createUpsertResult({
      written: getNumberPath(data, objectConfig.writtenPath || 'written', Array.isArray(results) ? results.length : request.records.length),
      skipped: getNumberPath(data, objectConfig.skippedPath || 'skipped', 0),
      failed: getNumberPath(data, objectConfig.failedPath || 'failed', Array.isArray(errors) ? errors.length : 0),
      results: Array.isArray(results) ? results : [],
      errors: Array.isArray(errors) ? errors : [],
      raw: data,
      metadata: {
        object: request.object,
      },
    })
  }

  return {
    kind: normalizedSystem.kind,
    systemId: normalizedSystem.id,
    testConnection,
    listObjects,
    getSchema,
    read,
    upsert,
  }
}

function createHttpAdapterFactory(defaults = {}) {
  return (input = {}) => createHttpAdapter({ ...defaults, ...input })
}

module.exports = {
  createHttpAdapter,
  createHttpAdapterFactory,
  HttpAdapterError,
  // Exposed for contract completeness when a specific config disables writes.
  unsupportedAdapterOperation,
  __internals: {
    buildUrl,
    getPath,
    normalizeBaseUrl,
    normalizeObjects,
    credentialHeaders,
  },
}
