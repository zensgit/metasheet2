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
  createReadResult,
  createUpsertResult,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  normalizeUpsertRequest,
} = require('../contracts.cjs')
const {
  getK3WiseDocumentObjectDefaults,
  getK3WiseMaterialProfile,
  listK3WiseDocumentTemplates,
  mergeK3WiseDocumentObject,
  normalizeTemplate,
} = require('./k3-wise-document-templates.cjs')
const crypto = require('node:crypto')
const { READ_SMOKE_LIST_REQUEST_MARKER } = require('../read-smoke-marker.cjs')
const { scrubSecretStringValue } = require('../payload-redaction.cjs')
// DF-T1-0: single source of truth for Save-body composition, shared with the no-write
// preview (http-routes.cjs). Placeholder detection (findUnfilledPlaceholders) is shared; the
// Save path below owns the throw disposition, the preview owns the valid:false disposition.
const { composeSchemaBody, findUnfilledPlaceholders, projectRecordForBody } = require('./k3-save-body-composer.cjs')

class K3WiseWebApiAdapterError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WiseWebApiAdapterError'
    this.details = details
    this.status = details.status
  }
}

const DEFAULT_OBJECTS = getK3WiseDocumentObjectDefaults()
const DEFAULT_MATERIAL_LIST_MAX_LIMIT = 10

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

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function isBlankValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

// normalizeReferenceIdentifier + applyReferenceShape moved to k3-save-body-composer.cjs (DF-T1-0).

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

function unwrapBusinessRow(row) {
  // Some K3 WISE envelopes nest the per-row payload under `row.Data`
  // (e.g. `Data[0].Data.{FNumber,FMessage,Code,FItemID,...}`). Mirror the read-path
  // unwrap (extractMaterialDetailRecord) so business success / message / code / id
  // parsing sees the nested content instead of the bare wrapper. Preserve the outer key
  // (FNumber) as a fallback when the inner record lacks one. Only unwraps when `.Data` is
  // itself a plain object — flat rows (`Data[0].X`) are returned untouched.
  if (isPlainObject(row) && isPlainObject(row.Data)) {
    const inner = row.Data
    if (isBlankValue(inner.FNumber) && !isBlankValue(row.FNumber)) {
      return { ...inner, FNumber: row.FNumber }
    }
    return inner
  }
  return row
}

function extractBusinessRows(data) {
  const rows = new Set()
  const candidates = [
    getPath(data, 'Data'),
    getPath(data, 'data'),
    getPath(data, 'Result.Data'),
    getPath(data, 'Result.ResponseStatus.SuccessEntitys'),
    getPath(data, 'Result.ResponseStatus.SuccessEntities'),
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      candidate.filter(isPlainObject).forEach((row) => rows.add(unwrapBusinessRow(row)))
    } else if (isPlainObject(candidate)) {
      const row = unwrapBusinessRow(candidate)
      if (
        businessRowStatus(row) !== null ||
        businessRowMessage(row) !== undefined ||
        businessRowHasIdentifier(row)
      ) {
        rows.add(row)
      }
    }
  }
  return Array.from(rows)
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
    const configuredObject = isPlainObject(configured[name]) ? configured[name] : {}
    let base = defaults
    let overlay = configuredObject
    let saveOnlyProfile = false
    // R-OPTIN: a config may select a named profile by id (the customer Material Save
    // preset). When selected, the profile REPLACES the generic template as the merge base
    // (the default template is never silently swapped — only on explicit opt-in). Operator
    // config still overlays on top; the `profile` key itself is metadata, not a template field.
    if (name === 'material' && configuredObject.profile !== undefined) {
      // Fail-closed: a `profile` that is present but empty / non-string is a misconfiguration.
      // Do NOT silently fall back to the generic minimal template — the operator believes a
      // customer profile is active.
      if (typeof configuredObject.profile !== 'string' || !configuredObject.profile.trim()) {
        throw new AdapterValidationError('config.objects.material.profile must be a non-empty string when present', {
          field: `config.objects.${name}.profile`,
        })
      }
      const profile = getK3WiseMaterialProfile(configuredObject.profile)
      if (!profile) {
        throw new AdapterValidationError(`Unknown K3 WISE material profile: ${configuredObject.profile}`, {
          field: `config.objects.${name}.profile`,
        })
      }
      base = profile
      overlay = { ...configuredObject }
      delete overlay.profile
      saveOnlyProfile = profile.lifecycle === 'save-only'
    }
    try {
      normalized[name] = mergeK3WiseDocumentObject(base, overlay, `config.objects.${name}`)
    } catch (error) {
      throw new AdapterValidationError(error.message, {
        field: `config.objects.${name}`,
      })
    }
    // HARD LOCK (M1): a save-only profile cannot be downgraded by the operator overlay.
    // Strip any submit/audit endpoints the overlay may have re-injected and pin the
    // lifecycle marker AFTER the merge so it is non-overridable. upsert() reads
    // `lifecycle === 'save-only'` to force autoSubmit/autoAudit off regardless of request/config.
    if (saveOnlyProfile) {
      normalized[name].lifecycle = 'save-only'
      delete normalized[name].submitPath
      delete normalized[name].auditPath
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
  const body = composeSchemaBody(record, objectConfig)
  // Fail-closed: an unreplaced preset placeholder must never reach a K3 Save. Detection is
  // shared with the no-write preview (findUnfilledPlaceholders); the Save path rejects before
  // the HTTP call so a half-configured profile errors cleanly instead of writing corrupt data.
  const unfilled = findUnfilledPlaceholders(body)
  if (unfilled.length > 0) {
    throw new AdapterValidationError(
      `K3 WISE Save body has an unfilled placeholder at ${unfilled[0]}; supply the customer value before saving`,
      { code: 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED', field: unfilled[0] },
    )
  }
  return body
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIAGNOSTIC_MESSAGE_MAX = 500

function hashToken(value) {
  return `sha12:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`
}

// Conservative row-key disposition (M1 R-REDACT): K3 identifiers (FNumber / ref codes) are
// never persisted in full — only a stable hash token for correlation.
function maskRowKey(value) {
  return isBlankValue(value) ? null : hashToken(value)
}

// A sourceId is kept in full ONLY when it is a confirmed MetaSheet internal UUID; any other
// shape (PLM / customer business code) is hashed too — default to masking when in doubt.
function dispositionSourceId(value) {
  if (isBlankValue(value)) return undefined
  const str = String(value).trim()
  return UUID_RE.test(str) ? str : hashToken(str)
}

function truncateDiagnosticMessage(value) {
  const str = String(value)
  return str.length > DIAGNOSTIC_MESSAGE_MAX ? `${str.slice(0, DIAGNOSTIC_MESSAGE_MAX)}…` : str
}

// Build a sanitized, conservative per-row Save diagnostic (G5 / R-REDACT). Persists ONLY:
// rowStatus, masked/hashed row keys, response code, and a redacted + truncated validation
// message. Never the raw FNumber, K3 ref values, token, host, authorityCode, password, or
// connection string — the message is scrubbed via scrubSecretStringValue.
function buildRowSaveDiagnostic({ status, record, key, rawMessage, code }) {
  // rawMessage is resolved by the caller with the same `String(error)` fallback the outer
  // error.message uses, so the diagnostic message can never be null while the surfaced
  // message is populated (and vice-versa).
  const message = typeof rawMessage === 'string' ? rawMessage : (rawMessage == null ? '' : String(rawMessage))
  return {
    rowStatus: status,
    rowKeys: {
      k3Key: maskRowKey(key),
      sourceId: dispositionSourceId(isPlainObject(record) ? record.sourceId : undefined),
    },
    responseCode: code !== undefined && code !== null ? String(code) : null,
    validationMessage: message ? truncateDiagnosticMessage(scrubSecretStringValue(message)) : null,
  }
}

// projectRecordForBody moved to k3-save-body-composer.cjs (DF-T1-0); imported above and
// re-exported via __internals for tests.

function normalizeStringList(value, field) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value)
    ? value
    : String(value).split(',')
  const normalized = []
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new AdapterValidationError(`${field} must contain only string field names`, { field })
    }
    const text = String(item).trim()
    if (text) normalized.push(text)
  }
  return Array.from(new Set(normalized))
}

function resolveMaterialReadNumber(request) {
  const number = firstDefined(
    request.options.templateMaterialNumber,
    request.options.materialNumber,
    request.options.number,
    request.options.FNumber,
    request.filters.templateMaterialNumber,
    request.filters.materialNumber,
    request.filters.number,
    request.filters.FNumber,
  )
  if (typeof number !== 'string' && typeof number !== 'number') {
    throw new AdapterValidationError('K3 WISE Material read requires templateMaterialNumber or filters.FNumber', {
      code: 'K3_WISE_READ_KEY_REQUIRED',
      field: 'templateMaterialNumber',
      object: request.object,
    })
  }
  const normalized = String(number).trim()
  if (!normalized) {
    throw new AdapterValidationError('K3 WISE Material read requires a non-empty templateMaterialNumber', {
      code: 'K3_WISE_READ_KEY_REQUIRED',
      field: 'templateMaterialNumber',
      object: request.object,
    })
  }
  return normalized
}

function assertMaterialDetailReadOnlyScope(request) {
  if (request.object !== 'material') {
    throw new UnsupportedAdapterOperationError('K3 WISE WebAPI read-only smoke supports only material detail reads', {
      kind: 'erp:k3-wise-webapi',
      object: request.object,
      operation: 'read',
    })
  }
  if (request.cursor) {
    throw new AdapterValidationError('K3 WISE Material read-only smoke does not support cursor/list pagination', {
      code: 'K3_WISE_READ_LIST_UNSUPPORTED',
      object: request.object,
      field: 'cursor',
    })
  }
  if (Object.keys(request.watermark || {}).length > 0) {
    throw new AdapterValidationError('K3 WISE Material read-only smoke does not support watermark/list reads', {
      code: 'K3_WISE_READ_LIST_UNSUPPORTED',
      object: request.object,
      field: 'watermark',
    })
  }
  const allowedFilterKeys = new Set(['templateMaterialNumber', 'materialNumber', 'number', 'FNumber', 'referenceFields'])
  const unknownFilters = Object.keys(request.filters).filter((key) => !allowedFilterKeys.has(key))
  if (unknownFilters.length > 0) {
    throw new AdapterValidationError('K3 WISE Material read-only smoke supports only a single material-number filter', {
      code: 'K3_WISE_READ_FILTER_UNSUPPORTED',
      object: request.object,
      fields: unknownFilters,
    })
  }
}

function resolveMaterialReadMode(request, objectConfig) {
  const optionMode = typeof request.options.k3ReadMode === 'string' ? request.options.k3ReadMode.trim() : ''
  const configMode = typeof objectConfig.readMode === 'string' ? objectConfig.readMode.trim() : ''
  if (optionMode && configMode && optionMode !== configMode) {
    throw new AdapterValidationError('K3 WISE Material read mode does not match the object config', {
      code: 'K3_WISE_READ_MODE_MISMATCH',
      object: request.object,
    })
  }
  const mode = optionMode || configMode || 'single_record_detail'
  if (mode === 'single_record_detail') return mode
  if (mode === 'list') {
    if (request.options[READ_SMOKE_LIST_REQUEST_MARKER] !== true) {
      throw new AdapterValidationError('K3 WISE Material LIST is only available through the read-smoke route', {
        code: 'K3_WISE_READ_LIST_ROUTE_UNSUPPORTED',
        object: request.object,
      })
    }
    if (configMode !== 'list') {
      throw new AdapterValidationError('K3 WISE Material list read requires a list-mode object config', {
        code: 'K3_WISE_READ_LIST_NOT_CONFIGURED',
        object: request.object,
      })
    }
    return mode
  }
  throw new AdapterValidationError('K3 WISE Material read mode is not supported', {
    code: 'K3_WISE_READ_MODE_UNSUPPORTED',
    object: request.object,
  })
}

function assertMaterialListReadOnlyScope(request, objectConfig) {
  if (request.object !== 'material') {
    throw new UnsupportedAdapterOperationError('K3 WISE WebAPI read-only LIST supports only material list reads', {
      kind: 'erp:k3-wise-webapi',
      object: request.object,
      operation: 'read',
    })
  }
  if (request.cursor) {
    throw new AdapterValidationError('K3 WISE Material LIST smoke does not support cursor pagination', {
      code: 'K3_WISE_READ_LIST_CURSOR_UNSUPPORTED',
      object: request.object,
      field: 'cursor',
    })
  }
  if (Object.keys(request.watermark || {}).length > 0) {
    throw new AdapterValidationError('K3 WISE Material LIST smoke does not support watermark reads', {
      code: 'K3_WISE_READ_LIST_WATERMARK_UNSUPPORTED',
      object: request.object,
      field: 'watermark',
    })
  }
  if (Object.keys(request.filters || {}).length > 0) {
    throw new AdapterValidationError('K3 WISE Material LIST smoke does not accept request-supplied filters', {
      code: 'K3_WISE_READ_LIST_FILTER_UNSUPPORTED',
      object: request.object,
      fields: Object.keys(request.filters),
    })
  }
  const allowedOptionKeys = new Set(['k3ReadMode', 'listKey'])
  const unknownOptions = Object.keys(request.options || {}).filter((key) => !allowedOptionKeys.has(key))
  if (unknownOptions.length > 0) {
    throw new AdapterValidationError('K3 WISE Material LIST smoke does not accept request-supplied options', {
      code: 'K3_WISE_READ_LIST_OPTION_UNSUPPORTED',
      object: request.object,
      fields: unknownOptions,
    })
  }
  const maxLimit = toPositiveNumber(objectConfig.maxListLimit) || DEFAULT_MATERIAL_LIST_MAX_LIMIT
  if (request.limit > maxLimit) {
    throw new AdapterValidationError('K3 WISE Material LIST smoke limit exceeds the preset bound', {
      code: 'K3_WISE_READ_LIST_LIMIT_EXCEEDED',
      object: request.object,
      limit: request.limit,
      maxLimit,
    })
  }
}

function defaultMaterialReferenceFields(objectConfig) {
  return Array.isArray(objectConfig.schema)
    ? objectConfig.schema
      .filter((field) => field && field.type === 'reference' && typeof field.name === 'string' && field.name.trim())
      .map((field) => field.name.trim())
    : []
}

function isReferenceObject(value) {
  return isPlainObject(value) && Object.keys(value).some((key) => (
    ['FNumber', 'FID', 'FId', 'FName', 'Name', 'Number', 'Id'].includes(key) &&
    !isBlankValue(value[key])
  ))
}

function materialDetailElement(data) {
  const rows = getPath(data, 'Data')
  if (Array.isArray(rows)) return rows.find(isPlainObject) || null
  return isPlainObject(rows) ? rows : null
}

function extractMaterialDetailRecord(data, materialNumber) {
  const element = materialDetailElement(data)
  if (!element) return null
  const detail = isPlainObject(element.Data) ? element.Data : element
  const record = cloneJson(detail)
  if (isPlainObject(record) && isBlankValue(record.FNumber)) {
    const number = firstDefined(element.FNumber, materialNumber)
    if (!isBlankValue(number)) record.FNumber = String(number)
  }
  return isPlainObject(record) ? record : null
}

function buildReadBody(materialNumber, objectConfig) {
  const template = isPlainObject(objectConfig.readBodyTemplate)
    ? cloneJson(objectConfig.readBodyTemplate)
    : {}
  template.Data = isPlainObject(template.Data)
    ? { ...template.Data, FNumber: materialNumber }
    : { FNumber: materialNumber }
  if (template.GetProperty === undefined) template.GetProperty = false
  return template
}

function buildListReadBody(request, objectConfig) {
  const template = isPlainObject(objectConfig.readListBodyTemplate)
    ? cloneJson(objectConfig.readListBodyTemplate)
    : {}
  const bodyKey = typeof objectConfig.readListBodyKey === 'string' && objectConfig.readListBodyKey.trim()
    ? objectConfig.readListBodyKey.trim()
    : 'Data'
  const pageIndexField = typeof objectConfig.pageIndexField === 'string' && objectConfig.pageIndexField.trim()
    ? objectConfig.pageIndexField.trim()
    : 'PageIndex'
  const pageSizeField = typeof objectConfig.pageSizeField === 'string' && objectConfig.pageSizeField.trim()
    ? objectConfig.pageSizeField.trim()
    : 'PageSize'
  const topField = typeof objectConfig.topField === 'string' && objectConfig.topField.trim()
    ? objectConfig.topField.trim()
    : 'Top'
  const container = isPlainObject(template[bodyKey]) ? template[bodyKey] : {}
  template[bodyKey] = {
    ...container,
    [topField]: request.limit,
    [pageIndexField]: 1,
    [pageSizeField]: request.limit,
  }
  const listFields = Array.isArray(objectConfig.readListFields)
    ? objectConfig.readListFields.filter((field) => typeof field === 'string' && field.trim()).map((field) => field.trim())
    : []
  if (listFields.length > 0 && template[bodyKey].Fields === undefined) {
    template[bodyKey].Fields = listFields.join(',')
  }
  if (typeof objectConfig.readListOrderBy === 'string' && objectConfig.readListOrderBy.trim() && template[bodyKey].OrderBy === undefined) {
    template[bodyKey].OrderBy = objectConfig.readListOrderBy.trim()
  }
  const listKey = typeof request.options.listKey === 'string' ? request.options.listKey.trim() : ''
  if (listKey) {
    const filterField = typeof objectConfig.readListFilterField === 'string' && objectConfig.readListFilterField.trim()
      ? objectConfig.readListFilterField.trim()
      : 'FNumber'
    const escaped = escapeK3LikePrefix(listKey)
    template[bodyKey].Filter = `${filterField} LIKE '${escaped}%'`
  }
  return template
}

function escapeK3LikePrefix(value) {
  return String(value)
    .replace(/'/g, "''")
    .replace(/\[/g, '[[]')
    .replace(/%/g, '[%]')
    .replace(/_/g, '[_]')
}

function materialListRowsCandidate(data) {
  const candidates = [
    getPath(data, 'Data.DATA'),
    getPath(data, 'Data.data'),
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isPlainObject).map((row) => cloneJson(row))
  }
  return null
}

function materialListBusinessSuccess(data, config) {
  if (hasExplicitBusinessFailure(data)) return false
  return businessSuccess(data, config)
}

function buildMaterialReadRecord(detail, request, objectConfig) {
  const requestedFields = [
    ...normalizeStringList(request.options.referenceFields, 'options.referenceFields'),
    ...normalizeStringList(request.filters.referenceFields, 'filters.referenceFields'),
  ]
  const referenceFields = requestedFields.length > 0
    ? Array.from(new Set(requestedFields))
    : defaultMaterialReferenceFields(objectConfig)
  const referenceObjects = {}
  for (const fieldName of referenceFields) {
    const value = detail[fieldName]
    if (isReferenceObject(value)) referenceObjects[fieldName] = cloneJson(value)
  }
  return {
    ...detail,
    _k3ReferenceObjects: referenceObjects,
  }
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
    getPath(data, 'Data.0.Data.FMessage'),
    getPath(data, 'Data.0.Data.Message'),
    getPath(data, 'Data.0.Data.ErrorMessage'),
    getPath(data, 'Data.0.Data.FErrMessage'),
    getPath(data, 'Data.Data.FMessage'),
    getPath(data, 'Data.Data.Message'),
    getPath(data, 'message'),
    getPath(data, 'Message'),
    getPath(data, 'error'),
    getPath(data, 'Error'),
    getPath(data, 'Result.ResponseStatus.Errors.0.Message'),
    fallback,
  )
}

function isSuccessLikeResponseMessage(value) {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  const hasChineseSuccess = /成功/.test(normalized) && !/[不未没]\s*成功/.test(normalized)
  return ['success', 'successful', 'succeeded', 'ok'].includes(normalized) ||
    hasChineseSuccess
}

function responseFailureMessage(data, config, summary, fallback = 'K3 WISE save failed row-level success gate') {
  const message = responseMessage(data, config, null)
  if (message && !isSuccessLikeResponseMessage(message)) return message

  const fields = []
  if (summary && typeof summary === 'object') {
    for (const field of [
      'rowCount',
      'successfulRowCount',
      'failedRowCount',
      'successEntityCount',
      'envelopeStatusCode',
      'envelopeMessagePresent',
    ]) {
      if (summary[field] !== undefined && summary[field] !== null) {
        fields.push(`${field}=${summary[field]}`)
      }
    }
  }
  return fields.length > 0 ? `${fallback} (${fields.join(', ')})` : fallback
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
    getPath(data, 'Data.0.Data.Code'),
    getPath(data, 'Data.0.Data.ErrorCode'),
    getPath(data, 'Data.Data.Code'),
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
    getPath(data, 'Data.0.Data.Code'),
    getPath(data, 'Data.0.Data.ErrorCode'),
    getPath(data, 'Data.Data.Code'),
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
    getPath(data, 'Data.0.Data.FBillNo'),
    getPath(data, 'Data.Data.FBillNo'),
    getPath(data, 'Data.FNumber'),
    getPath(data, 'Data.0.FNumber'),
    getPath(data, 'Data.0.Data.FNumber'),
    getPath(data, 'Data.Data.FNumber'),
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
    getPath(data, 'Data.0.Data.FItemID'),
    getPath(data, 'Data.Data.FItemID'),
    getPath(data, 'Data.Id'),
    getPath(data, 'Data.0.Id'),
    getPath(data, 'Data.0.Data.Id'),
    getPath(data, 'Data.Data.Id'),
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

  async function read(input = {}) {
    const request = normalizeReadRequest(input)
    const objectConfig = objects[request.object]
    if (!objectConfig) {
      throw new AdapterValidationError(`K3 WISE object is not configured: ${request.object}`, { object: request.object })
    }
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'read')
    const readMode = resolveMaterialReadMode(request, objectConfig)
    if (readMode === 'list') {
      assertMaterialListReadOnlyScope(request, objectConfig)
      const readPath = objectConfig.readPath
        ? assertRelativePath(objectConfig.readPath, 'object.readPath')
        : null
      if (!readPath) {
        throw new K3WiseWebApiAdapterError('K3 WISE list endpoint is not configured for material', {
          code: 'K3_WISE_READ_NOT_CONFIGURED',
          object: request.object,
        })
      }

      const authContext = await login()
      let readResponse
      try {
        readResponse = await requestJson(readPath, {
          method: objectConfig.readMethod || 'POST',
          query: authContext.query,
          headers: authContext.headers,
          body: buildListReadBody(request, objectConfig),
        })
      } catch (error) {
        throw new K3WiseWebApiAdapterError(`K3 WISE WebAPI list read failed: ${error && error.message ? error.message : String(error)}`, {
          code: 'K3_WISE_READ_FAILED',
          object: request.object,
          status: error && error.status,
          path: readPath,
        })
      }

      if (!materialListBusinessSuccess(readResponse.data, config)) {
        throw new K3WiseWebApiAdapterError('K3 WISE list read business response failed', {
          code: 'K3_WISE_READ_LIST_BUSINESS_ERROR',
          object: request.object,
          responseCode: responseFailureCode(readResponse.data, config, 'K3_WISE_READ_LIST_BUSINESS_ERROR'),
        })
      }

      const rows = materialListRowsCandidate(readResponse.data)
      if (rows === null) {
        throw new K3WiseWebApiAdapterError('K3 WISE list read rows container missing', {
          code: 'K3_WISE_READ_LIST_ROWS_MISSING',
          object: request.object,
        })
      }

      const records = rows.slice(0, request.limit)
      return createReadResult({
        records,
        raw: readResponse.data,
        metadata: {
          object: request.object,
          mode: 'material-list-smoke',
          requestedLimit: request.limit,
          returnedRecordCount: records.length,
          readPath,
          readOnly: true,
        },
      })
    }

    assertMaterialDetailReadOnlyScope(request)

    const readPath = objectConfig.readPath
      ? assertRelativePath(objectConfig.readPath, 'object.readPath')
      : null
    if (!readPath) {
      throw new K3WiseWebApiAdapterError('K3 WISE read endpoint is not configured for material', {
        code: 'K3_WISE_READ_NOT_CONFIGURED',
        object: request.object,
      })
    }

    const materialNumber = resolveMaterialReadNumber(request)
    const authContext = await login()
    let readResponse
    try {
      readResponse = await requestJson(readPath, {
        method: objectConfig.readMethod || 'POST',
        query: authContext.query,
        headers: authContext.headers,
        body: buildReadBody(materialNumber, objectConfig),
      })
    } catch (error) {
      throw new K3WiseWebApiAdapterError(`K3 WISE WebAPI read failed: ${error && error.message ? error.message : String(error)}`, {
        code: 'K3_WISE_READ_FAILED',
        object: request.object,
        status: error && error.status,
        path: readPath,
      })
    }

    if (!businessSuccess(readResponse.data, config)) {
      throw new K3WiseWebApiAdapterError(String(responseMessage(readResponse.data, config, 'K3 WISE read business response failed')), {
        code: 'K3_WISE_READ_BUSINESS_ERROR',
        object: request.object,
        responseCode: responseFailureCode(readResponse.data, config, 'K3_WISE_READ_BUSINESS_ERROR'),
      })
    }

    const detail = extractMaterialDetailRecord(readResponse.data, materialNumber)
    if (!detail) {
      throw new K3WiseWebApiAdapterError('K3 WISE read response did not include a material detail record', {
        code: 'K3_WISE_READ_BUSINESS_ERROR',
        object: request.object,
      })
    }
    const record = buildMaterialReadRecord(detail, request, objectConfig)
    return createReadResult({
      records: [record],
      raw: readResponse.data,
      metadata: {
        object: request.object,
        mode: 'material-detail-reference-smoke',
        requestedNumber: materialNumber,
        readPath,
        readOnly: true,
        referenceFields: Object.keys(record._k3ReferenceObjects || {}),
        referenceObjectCount: Object.keys(record._k3ReferenceObjects || {}).length,
      },
    })
  }

  async function upsert(input = {}) {
    const request = normalizeUpsertRequest(input)
    const objectConfig = objects[request.object]
    if (!objectConfig) {
      throw new AdapterValidationError(`K3 WISE object is not configured: ${request.object}`, { object: request.object })
    }
    ensureOperation(normalizedSystem.kind, request.object, objectConfig, 'upsert')

    // HARD LOCK (M1): a save-only profile forces autoSubmit/autoAudit OFF and drops any
    // submit/audit endpoint, regardless of what request or config set. This is the lock the
    // M1 design requires (not merely a default false). `autoFlagsRefused` records that a
    // caller asked for submit/audit and was denied, so it is observable in metadata.
    const saveOnly = objectConfig.lifecycle === 'save-only'
    const savePath = assertRelativePath(objectConfig.savePath || objectConfig.path, 'object.savePath')
    const submitPath = saveOnly ? null : (objectConfig.submitPath ? assertRelativePath(objectConfig.submitPath, 'object.submitPath') : null)
    const auditPath = saveOnly ? null : (objectConfig.auditPath ? assertRelativePath(objectConfig.auditPath, 'object.auditPath') : null)
    const requestedAutoSubmit = resolveAutoFlag(request.options.autoSubmit, config.autoSubmit, 'autoSubmit')
    const requestedAutoAudit = resolveAutoFlag(request.options.autoAudit, config.autoAudit, 'autoAudit')
    const autoSubmit = saveOnly ? false : requestedAutoSubmit
    const autoAudit = saveOnly ? false : requestedAutoAudit
    const autoFlagsRefused = saveOnly && (requestedAutoSubmit === true || requestedAutoAudit === true)
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
          throw new K3WiseWebApiAdapterError(String(responseFailureMessage(save.data, config, saveSummary)), {
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
        const rawMessage = error && error.message ? error.message : String(error)
        const code = error && error.details && error.details.code ? error.details.code : 'K3_WISE_UPSERT_FAILED'
        errors.push({
          index,
          key,
          object: request.object,
          code,
          message: scrubSecretStringValue(rawMessage),
          responseSummary: error && error.details && error.details.responseSummary
            ? error.details.responseSummary
            : undefined,
          // Conservative sanitized row diagnostic (G5 / R-REDACT) — masked keys, scrubbed
          // message (same rawMessage source as above); the persisted artifact for the failure.
          diagnostic: buildRowSaveDiagnostic({ status: 'failed', record, key, rawMessage, code }),
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
        saveOnly,
        autoSubmit,
        autoAudit,
        autoFlagsRefused,
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
    read,
    upsert,
  }
}

function createK3WiseWebApiAdapterFactory(defaults = {}) {
  return (input = {}) => createK3WiseWebApiAdapter({ ...defaults, ...input })
}

const K3_WISE_WEBAPI_ADAPTER_METADATA = {
  label: 'K3 WISE WebAPI',
  roles: ['target'],
  advanced: false,
}

module.exports = {
  K3_WISE_WEBAPI_ADAPTER_METADATA,
  K3WiseWebApiAdapterError,
  createK3WiseWebApiAdapter,
  createK3WiseWebApiAdapterFactory,
  __internals: {
    DEFAULT_OBJECTS,
    businessSuccess,
    buildRowSaveDiagnostic,
    extractRecordKey,
    extractMaterialDetailRecord,
    buildMaterialReadRecord,
    listK3WiseDocumentTemplates,
    normalizeObjects,
    projectRecordForBody,
    responseBillNo,
    responseCode,
    responseExternalId,
    responseFailureMessage,
    saveBusinessSuccess,
  },
}
