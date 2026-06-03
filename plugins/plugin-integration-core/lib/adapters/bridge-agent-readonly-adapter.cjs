'use strict'

// ---------------------------------------------------------------------------
// Readonly Bridge Agent source adapter - plugin-integration-core
//
// BA-M2 adapter for the BA-M1 localhost Bridge Agent protocol. It exposes only
// health/object/schema/query reads and never accepts SQL text or writes.
// ---------------------------------------------------------------------------

const {
  AdapterValidationError,
  createReadResult,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')

class BridgeAgentReadonlyAdapterError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BridgeAgentReadonlyAdapterError'
    this.details = details
    this.status = details.status
    this.code = details.code
  }
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:19091/'
const DEFAULT_AUTH_HEADER = 'X-MetaSheet-Bridge-Secret'
const DEFAULT_SAMPLE_LIMIT = 3
const DEFAULT_MAX_LIMIT = 20
const MAX_ADAPTER_LIMIT = 500
const SAFE_OBJECT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const SECRET_TEXT_PATTERN = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|api[_-]?key|secret|signature|sig|sign|password)=([^&#\s]+)/ig
const AUTH_TEXT_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/ig
const JWT_TEXT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const RAW_SQL_KEYS = new Set(['sql', 'rawSql', 'rawSQL', 'queryText', 'statement'])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Network-layer codes that mean the localhost Bridge Agent endpoint is not reachable
// (process down / wrong port / not listening) — distinct from an HTTP error the agent itself returned.
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EPIPE',
])

// Collect error codes across the shapes Node/undici uses for a failed fetch: the error itself, its
// `cause`, and (dual-stack localhost → AggregateError) `cause.errors[]`.
function collectErrorCodes(error) {
  const codes = []
  const push = (code) => { if (typeof code === 'string') codes.push(code) }
  if (error) push(error.code)
  const cause = error && error.cause
  if (cause) {
    push(cause.code)
    if (Array.isArray(cause.errors)) for (const inner of cause.errors) push(inner && inner.code)
  }
  return codes
}

// True when the failure is "the Bridge Agent endpoint is unreachable" rather than an HTTP/application
// error. Primary signal is undici's `TypeError: fetch failed` — the verified shape on a dead localhost
// port (where `cause.code` / `cause.errors` are NOT populated on every Node version, so they are
// secondary enrichment, not the gate).
function isAgentUnreachable(error) {
  if (!error) return false
  if (error.name === 'TypeError' && /fetch failed/i.test(String(error.message || ''))) return true
  return collectErrorCodes(error).some((code) => CONNECTION_ERROR_CODES.has(code))
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toPlainObject(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new AdapterValidationError(`${field} must be an object`, { field })
  }
  return { ...value }
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
}

function normalizeBaseUrl(value) {
  const raw = optionalString(value) || DEFAULT_BASE_URL
  let url
  try {
    url = new URL(raw)
  } catch (error) {
    throw new AdapterValidationError('Bridge Agent baseUrl must be a valid URL', { field: 'config.baseUrl' })
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AdapterValidationError('Bridge Agent baseUrl must be http or https', { field: 'config.baseUrl' })
  }
  const hostname = url.hostname.toLowerCase()
  if (!LOCALHOSTS.has(hostname)) {
    throw new AdapterValidationError('Bridge Agent baseUrl must point at localhost for BA-M2', {
      field: 'config.baseUrl',
      hostname,
    })
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

function assertSafeObjectName(object) {
  const normalized = requiredString(object, 'object')
  if (!SAFE_OBJECT_NAME_PATTERN.test(normalized)) {
    throw new AdapterValidationError('Bridge Agent object must be an allowlisted identifier', {
      field: 'object',
      object: normalized,
    })
  }
  return normalized
}

function normalizePositiveInteger(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new AdapterValidationError(`${field} must be a positive integer`, { field })
  }
  return numeric
}

function normalizeLimits(config) {
  const sampleLimit = normalizePositiveInteger(config.sampleLimit, 'config.sampleLimit', DEFAULT_SAMPLE_LIMIT)
  const maxLimit = normalizePositiveInteger(config.maxLimit, 'config.maxLimit', DEFAULT_MAX_LIMIT)
  if (sampleLimit > maxLimit) {
    throw new AdapterValidationError('config.sampleLimit must be <= config.maxLimit', { field: 'config.sampleLimit' })
  }
  if (maxLimit > MAX_ADAPTER_LIMIT) {
    throw new AdapterValidationError('config.maxLimit must be <= 500 for the readonly Bridge Agent', { field: 'config.maxLimit' })
  }
  return { sampleLimit, maxLimit }
}

function normalizeHeaderName(value) {
  const headerName = optionalString(value) || DEFAULT_AUTH_HEADER
  if (/[\u0000-\u001F\u007F:]/.test(headerName)) {
    throw new AdapterValidationError('Bridge Agent auth header name is unsafe', { field: 'config.authHeaderName' })
  }
  return headerName
}

function credentialsObject(credentials) {
  return isPlainObject(credentials) ? credentials : {}
}

function resolveSharedSecret({ credentials, config }) {
  const creds = credentialsObject(credentials)
  const direct = optionalString(creds.sharedSecret || creds.bridgeSecret || creds.secret)
  if (direct) return direct
  const envVar = optionalString(config.sharedSecretEnvVar)
  if (!envVar) return null
  return optionalString(process.env[envVar])
}

function bridgeAuthHeaders({ credentials, config }) {
  if (config.authMode === 'none') return {}
  const secret = resolveSharedSecret({ credentials, config })
  if (!secret) return {}
  return {
    [normalizeHeaderName(config.authHeaderName || config.headerName)]: secret,
  }
}

function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString()
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

function bridgeErrorCode(data, fallback = 'BRIDGE_AGENT_REQUEST_FAILED') {
  if (isPlainObject(data) && isPlainObject(data.error) && typeof data.error.code === 'string') return data.error.code
  return fallback
}

function bridgeErrorMessage(data, fallback) {
  if (isPlainObject(data) && isPlainObject(data.error) && typeof data.error.message === 'string') {
    return redactSecretText(data.error.message)
  }
  if (typeof data === 'string' && data.trim()) return redactSecretText(data)
  return fallback
}

function hasOwnKeys(value) {
  return isPlainObject(value) && Object.keys(value).length > 0
}

function assertNoUnsupportedReadOptions(request) {
  if (hasOwnKeys(request.filters)) {
    throw new AdapterValidationError('Bridge Agent read does not support filters yet', { field: 'filters' })
  }
  if (hasOwnKeys(request.watermark)) {
    throw new AdapterValidationError('Bridge Agent read does not support watermarks yet', { field: 'watermark' })
  }
  const options = toPlainObject(request.options, 'options')
  for (const key of RAW_SQL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw new AdapterValidationError('Bridge Agent read does not accept raw SQL options', { field: `options.${key}` })
    }
  }
}

function normalizeBridgeLimit(inputLimit, requestLimit, limits) {
  const requested = inputLimit === undefined || inputLimit === null || inputLimit === ''
    ? limits.sampleLimit
    : requestLimit
  return Math.min(requested, limits.maxLimit)
}

function normalizeObjectsResponse(data) {
  const objects = isPlainObject(data) && Array.isArray(data.objects) ? data.objects : []
  return objects
    .filter(isPlainObject)
    .map((object) => {
      const name = optionalString(object.id || object.name)
      if (!name) return null
      return {
        name,
        label: optionalString(object.label) || name,
        operations: ['read'],
        source: 'bridge:legacy-sql-readonly',
        readonly: true,
        fieldCount: Number.isInteger(object.fieldCount) && object.fieldCount >= 0 ? object.fieldCount : undefined,
      }
    })
    .filter(Boolean)
}

function normalizeFields(data) {
  const fields = isPlainObject(data) && Array.isArray(data.fields) ? data.fields : []
  return fields
    .filter(isPlainObject)
    .map((field) => ({
      name: requiredString(field.name, 'field.name'),
      label: optionalString(field.label) || optionalString(field.name) || requiredString(field.name, 'field.name'),
      type: optionalString(field.type) || 'string',
      required: field.required === true,
    }))
}

function createBridgeAgentReadonlyAdapter({ system, fetchImpl = globalThis.fetch, logger } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const config = normalizedSystem.config
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.bridgeUrl || config.url)
  const limits = normalizeLimits(config)
  const authHeaders = bridgeAuthHeaders({ credentials: normalizedSystem.credentials, config })
  const timeoutMs = normalizePositiveInteger(config.timeoutMs, 'config.timeoutMs', 30000)

  if (typeof fetchImpl !== 'function') {
    throw new AdapterValidationError('Bridge Agent adapter requires fetch implementation', { field: 'fetchImpl' })
  }

  async function requestJson(path, { method = 'GET', body } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    const headers = {
      Accept: 'application/json',
      ...authHeaders,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }
    try {
      const response = await fetchImpl(buildUrl(baseUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
      const data = await parseResponseBody(response)
      if (!responseOk(response)) {
        throw new BridgeAgentReadonlyAdapterError(bridgeErrorMessage(data, `Bridge Agent request failed: ${method} ${path}`), {
          status: response.status,
          code: bridgeErrorCode(data),
          method,
          path,
        })
      }
      return { response, data }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new BridgeAgentReadonlyAdapterError(`Bridge Agent request timed out: ${method} ${path}`, {
          code: 'BRIDGE_AGENT_TIMEOUT',
          method,
          path,
          timeoutMs,
        })
      }
      if (error instanceof BridgeAgentReadonlyAdapterError) throw error
      if (isAgentUnreachable(error)) {
        // Operator-facing: a generic "fetch failed" here means the localhost agent isn't listening, not a
        // backend bug. Name the recovery action so the source can be retested back to `active`.
        throw new BridgeAgentReadonlyAdapterError(
          `Bridge Agent is not reachable at ${baseUrl} — the readonly Bridge Agent service may not be running. Start its scheduled task / process, then retest the source connection.`,
          { code: 'BRIDGE_AGENT_UNREACHABLE', method, path },
        )
      }
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-integration-core] Bridge Agent request failed: ${method} ${path}`)
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async function testConnection() {
    try {
      const health = await requestJson('/health')
      const objects = await requestJson('/objects')
      const bridgeObjects = normalizeObjectsResponse(objects.data)
      const bridgeOk = Boolean(health.data && health.data.ok !== false && health.data.databaseReachable !== false)
      return {
        ok: bridgeOk,
        status: health.response.status,
        connected: bridgeOk,
        authenticated: true,
        message: bridgeOk
          ? `Bridge Agent reachable (${bridgeObjects.length} object${bridgeObjects.length === 1 ? '' : 's'})`
          : 'Bridge Agent health returned databaseReachable=false',
      }
    } catch (error) {
      return {
        ok: false,
        status: error && error.status,
        connected: false,
        authenticated: error && error.status === 401 ? false : undefined,
        code: error && (error.code || error.name) ? String(error.code || error.name) : 'BRIDGE_AGENT_TEST_FAILED',
        message: redactSecretText(error && error.message ? error.message : String(error)),
      }
    }
  }

  async function listObjects() {
    const { data } = await requestJson('/objects')
    return normalizeObjectsResponse(data)
  }

  async function getSchema(input = {}) {
    const object = assertSafeObjectName(typeof input === 'string' ? input : input.object)
    const { data } = await requestJson(`/schema/${encodeURIComponent(object)}`)
    return {
      object,
      fields: normalizeFields(data),
      raw: {
        source: 'bridge:legacy-sql-readonly',
      },
    }
  }

  async function read(input = {}) {
    const request = normalizeReadRequest(input)
    const object = assertSafeObjectName(request.object)
    assertNoUnsupportedReadOptions(request)
    const limit = normalizeBridgeLimit(input.limit, request.limit, limits)
    const { data } = await requestJson(`/query/${encodeURIComponent(object)}`, {
      method: 'POST',
      body: { limit },
    })
    const records = isPlainObject(data) && Array.isArray(data.records) ? data.records : []
    return createReadResult({
      records,
      nextCursor: data && data.nextCursor,
      done: data && data.done !== undefined ? data.done : true,
      raw: data,
      metadata: {
        object,
        limit,
        count: records.length,
        source: 'bridge:legacy-sql-readonly',
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
    upsert: unsupportedAdapterOperation(normalizedSystem.kind, 'upsert'),
  }
}

function createBridgeAgentReadonlyAdapterFactory(defaults = {}) {
  return (input = {}) => createBridgeAgentReadonlyAdapter({ ...defaults, ...input })
}

module.exports = {
  BridgeAgentReadonlyAdapterError,
  createBridgeAgentReadonlyAdapter,
  createBridgeAgentReadonlyAdapterFactory,
  __internals: {
    assertSafeObjectName,
    bridgeAuthHeaders,
    normalizeBaseUrl,
    normalizeBridgeLimit,
    normalizeObjectsResponse,
    normalizeFields,
    redactSecretText,
  },
}
