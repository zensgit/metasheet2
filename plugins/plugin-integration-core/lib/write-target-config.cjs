'use strict'

// External-API write self-service — W1: CONFIG MODEL + save-time VALIDATOR ONLY.
//
// Scope fence: validates a consultant-authored write-target config and returns a normalized value
// or values-free errors. It does NOT persist by itself, call a network, run dry-run/apply, create an
// adapter, wire a route, or write any external system. Delete is out of v1.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')
const { isSafeRelativeReadPath } = require('./read-source-config.cjs')

const WRITE_TARGET_OPERATIONS = Object.freeze(['upsert', 'save_only'])
const WRITE_TARGET_METHODS = Object.freeze(['POST', 'PUT', 'PATCH'])
const WRITE_TARGET_KEY_ENCODINGS = Object.freeze(['structured_json_field', 'filter_expression', 'numeric_id'])

const DELETE_SHAPED_KEYS = Object.freeze(['deletePath', 'destroyPath', 'removePath'])
const RAW_WRITE_SHAPED_KEYS = Object.freeze([
  'submitPath', 'auditPath', 'rawSql', 'sql', 'statement', 'body', 'payload', 'headers', 'request',
  'responsePath', 'productionApply', 'productionEnabled',
])
const INLINE_CREDENTIAL_KEYS = Object.freeze([
  'bearerToken', 'token', 'authToken', 'accessToken', 'password', 'apiKey', 'secret', 'secretKey',
  'credential', 'credentials', 'connectionString', 'authorityCode', 'cookie', 'sessionId',
])
const ALLOWED_CONFIG_KEYS = Object.freeze(new Set([
  'version', 'systemId', 'sandboxSystemId', 'requiredKind', 'object', 'operation', 'writePath',
  'writeMethod', 'operations', 'keyField', 'keyEncoding', 'fieldMap',
]))

function isBoundedIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value.trim())
}

function isValidContainerPath(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value.trim())
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Write fieldMap is data-plane metadata: source is an authorized cleansing-zone column/key path; target
// is the target-system field/container path. Both use structural path syntax, not value-shaped tokens
// like material numbers (`MAT-001`).
function isValidFieldMapEntry(entry) {
  if (!isPlainObject(entry)) return false
  if (!Object.keys(entry).every((key) => key === 'source' || key === 'target')) return false
  return isValidContainerPath(entry.source) && isValidContainerPath(entry.target)
}

function hasSecretShapedValue(value) {
  if (typeof value === 'string') return scrubSecretStringValue(value) !== value
  if (Array.isArray(value)) return value.some(hasSecretShapedValue)
  if (isPlainObject(value)) return Object.values(value).some(hasSecretShapedValue)
  return false
}

function validateWriteTargetConfig(config) {
  if (!isPlainObject(config)) {
    return { valid: false, errors: [{ code: 'WRITE_TARGET_CONFIG_NOT_OBJECT', field: '(root)', reason: 'not_object' }] }
  }
  const errors = []
  const push = (code, field, reason) => errors.push({ code, field, reason })

  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) push('WRITE_TARGET_UNEXPECTED_FIELD', '(unexpected)', 'not_allowlisted')
  }
  for (const key of DELETE_SHAPED_KEYS) {
    if (config[key] !== undefined) push('WRITE_TARGET_DELETE_REJECTED', key, 'delete_not_supported')
  }
  for (const key of RAW_WRITE_SHAPED_KEYS) {
    if (config[key] !== undefined) push('WRITE_TARGET_RAW_WRITE_CONFIG_REJECTED', key, 'raw_write_shape')
  }
  for (const key of INLINE_CREDENTIAL_KEYS) {
    if (config[key] !== undefined) push('WRITE_TARGET_CREDENTIAL_INLINE_REJECTED', key, 'inline_credential_key')
  }
  if (hasSecretShapedValue(config)) {
    push('WRITE_TARGET_CREDENTIAL_INLINE_REJECTED', '(value)', 'secret_shaped_value')
  }

  if (!isBoundedIdentifier(config.systemId)) push('WRITE_TARGET_SYSTEM_REF_INVALID', 'systemId', 'invalid_reference')
  if (!isBoundedIdentifier(config.sandboxSystemId)) push('WRITE_TARGET_SANDBOX_REF_INVALID', 'sandboxSystemId', 'invalid_reference')
  if (isBoundedIdentifier(config.systemId) && isBoundedIdentifier(config.sandboxSystemId) && config.systemId.trim() === config.sandboxSystemId.trim()) {
    push('WRITE_TARGET_SANDBOX_REQUIRED', 'sandboxSystemId', 'must_differ_from_production')
  }
  if (!isBoundedIdentifier(config.requiredKind)) push('WRITE_TARGET_KIND_REQUIRED', 'requiredKind', 'invalid_kind')
  if (!isBoundedIdentifier(config.object)) push('WRITE_TARGET_OBJECT_INVALID', 'object', 'invalid_object')

  if (!WRITE_TARGET_OPERATIONS.includes(config.operation)) push('WRITE_TARGET_OPERATION_NOT_ALLOWED', 'operation', 'not_allowlisted')
  if (!Array.isArray(config.operations) || config.operations.length !== 1 || config.operations[0] !== 'write') {
    push('WRITE_TARGET_OPERATION_NOT_ALLOWED', 'operations', 'operations_must_be_write_only')
  }
  if (!WRITE_TARGET_METHODS.includes(config.writeMethod)) push('WRITE_TARGET_METHOD_NOT_ALLOWED', 'writeMethod', 'not_allowlisted')
  if (!isSafeRelativeReadPath(config.writePath)) push('WRITE_TARGET_ENDPOINT_NOT_RELATIVE', 'writePath', 'not_safe_relative_path')

  if (!isBoundedIdentifier(config.keyField)) push('WRITE_TARGET_KEY_FIELD_INVALID', 'keyField', 'invalid_identifier')
  if (config.keyEncoding !== undefined && !WRITE_TARGET_KEY_ENCODINGS.includes(config.keyEncoding)) {
    push('WRITE_TARGET_KEY_ENCODING_INVALID', 'keyEncoding', 'not_allowlisted')
  }

  if (!Array.isArray(config.fieldMap) || config.fieldMap.length === 0 || !config.fieldMap.every(isValidFieldMapEntry)) {
    push('WRITE_TARGET_FIELD_MAP_INVALID', 'fieldMap', 'invalid_field_map')
  }

  if (!Number.isInteger(config.version) || config.version < 1) {
    push('WRITE_TARGET_VERSION_INVALID', 'version', 'must_be_positive_integer')
  }

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, normalized: normalizeWriteTargetConfig(config) }
}

function normalizeWriteTargetConfig(config) {
  const writePath = config.writePath.trim()
  return Object.freeze({
    version: config.version,
    systemId: config.systemId.trim(),
    sandboxSystemId: config.sandboxSystemId.trim(),
    requiredKind: config.requiredKind.trim(),
    object: config.object.trim(),
    operation: config.operation,
    writePath: writePath.startsWith('/') ? writePath : `/${writePath}`,
    writeMethod: config.writeMethod,
    operations: Object.freeze(['write']),
    keyField: config.keyField.trim(),
    ...(config.keyEncoding !== undefined ? { keyEncoding: config.keyEncoding } : {}),
    fieldMap: Object.freeze(config.fieldMap.map((entry) => Object.freeze({
      source: entry.source.trim(),
      target: entry.target.trim(),
    }))),
  })
}

module.exports = {
  WRITE_TARGET_OPERATIONS,
  WRITE_TARGET_METHODS,
  WRITE_TARGET_KEY_ENCODINGS,
  validateWriteTargetConfig,
  normalizeWriteTargetConfig,
  __internals: {
    isBoundedIdentifier,
    isValidContainerPath,
    isValidFieldMapEntry,
    hasSecretShapedValue,
  },
}
