'use strict'

// DF-T1A connector action metadata — a LATENT contract (not wired to any runtime).
// A connector action is ONE safe, named operation exposed by a connector profile,
// expressed as metadata around an EXISTING adapter method. This contract does NOT
// authorize a generic HTTP client, user JavaScript, direct SQL, or a new connector
// runtime; it only describes and gates. Mirrors provenance-contracts.cjs (#1882).

const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')

const CONNECTOR_ACTION_OPERATIONS = Object.freeze(['read', 'preview', 'upsert', 'export'])
const CONNECTOR_ACTION_OPERATION_SET = new Set(CONNECTOR_ACTION_OPERATIONS)

// Operations that MUTATE the target system. A write action can never be silently
// enabled: it must carry requiresApproval and is always normalized `gated`. This is
// the write SET (not "!== read"), so the no-write `preview`/`export` actions are not
// over-gated. Submit/Audit/BOM are intentionally NOT modeled here — they remain
// gated outside this contract.
const WRITE_OPERATIONS = Object.freeze(['upsert'])
const WRITE_OPERATION_SET = new Set(WRITE_OPERATIONS)

const INPUT_GROUPS = Object.freeze(['path', 'query', 'header', 'body'])

class ConnectorActionContractValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ConnectorActionContractValidationError'
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConnectorActionContractValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ConnectorActionContractValidationError(`${field} must be a string`, { field })
  }
  return value.trim()
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ConnectorActionContractValidationError(`${field} must be a boolean`, { field })
  }
  return value
}

function normalizeOperation(value) {
  const operation = requiredString(value, 'operation')
  if (!CONNECTOR_ACTION_OPERATION_SET.has(operation)) {
    throw new ConnectorActionContractValidationError(
      `operation must be one of ${CONNECTOR_ACTION_OPERATIONS.join(', ')}`,
      { field: 'operation', value: operation },
    )
  }
  return operation
}

// Relative path only — reject scheme (`http:`), protocol-relative (`//host`), and
// backslashes, and require a leading `/`. Blocks a generic HTTP client / SSRF via
// action metadata. Kept standalone so the contract carries no adapter dependency
// (mirrors the adapter's assertRelativePath rule).
function normalizeRelativePath(value) {
  const path = requiredString(value, 'request.path')
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  if (hasScheme || path.startsWith('//') || path.includes('\\')) {
    throw new ConnectorActionContractValidationError(
      'request.path must be relative to the connector base URL (no scheme/host/backslash)',
      { field: 'request.path', value: path },
    )
  }
  // No query (?) or fragment (#) in the path — query/header/body must go through
  // `inputs` (structured + secret-safe), not be smuggled into the endpoint path.
  if (path.includes('?') || path.includes('#')) {
    throw new ConnectorActionContractValidationError(
      'request.path must not contain a query (?) or fragment (#); use request.inputs (query/header/body) instead',
      { field: 'request.path', value: path },
    )
  }
  if (!path.startsWith('/')) {
    throw new ConnectorActionContractValidationError('request.path must start with "/"', {
      field: 'request.path',
      value: path,
    })
  }
  return path
}

// One business input. References data by `source` (e.g. `record.FNumber`); never an
// inline literal. An inline `value` is rejected so secrets/tokens can't be embedded
// in action metadata — secret values come from the connector profile's secretsRef
// at runtime, not from the template.
function normalizeInput(input, group, index) {
  const at = `request.inputs.${group}[${index}]`
  if (!isPlainObject(input)) {
    throw new ConnectorActionContractValidationError(`${at} must be an object`, { field: at })
  }
  if ('value' in input) {
    throw new ConnectorActionContractValidationError(
      `${at} must not carry an inline value (use source/secretsRef; no secrets in metadata)`,
      { field: `${at}.value` },
    )
  }
  const normalized = { name: requiredString(input.name, `${at}.name`) }
  const source = optionalString(input.source, `${at}.source`)
  if (source !== undefined) normalized.source = source
  if (input.required !== undefined) {
    normalized.required = requiredBoolean(input.required, `${at}.required`)
  }
  return normalized
}

function normalizeInputs(value) {
  const inputs = value === undefined ? {} : value
  if (!isPlainObject(inputs)) {
    throw new ConnectorActionContractValidationError('request.inputs must be an object', { field: 'request.inputs' })
  }
  const out = {}
  for (const group of INPUT_GROUPS) {
    const list = inputs[group] === undefined ? [] : inputs[group]
    if (!Array.isArray(list)) {
      throw new ConnectorActionContractValidationError(`request.inputs.${group} must be an array`, {
        field: `request.inputs.${group}`,
      })
    }
    out[group] = list.map((input, index) => normalizeInput(input, group, index))
  }
  return out
}

function normalizeRequest(value) {
  if (!isPlainObject(value)) {
    throw new ConnectorActionContractValidationError('request must be an object', { field: 'request' })
  }
  return {
    method: requiredString(value.method, 'request.method').toUpperCase(),
    path: normalizeRelativePath(value.path),
    inputs: normalizeInputs(value.inputs),
  }
}

function normalizeOutput(value) {
  if (!isPlainObject(value)) {
    throw new ConnectorActionContractValidationError('output must be an object', { field: 'output' })
  }
  const out = {
    recordPath: requiredString(value.recordPath, 'output.recordPath'),
    successPath: requiredString(value.successPath, 'output.successPath'),
    errorPath: requiredString(value.errorPath, 'output.errorPath'),
  }
  if (value.successValue !== undefined) out.successValue = value.successValue
  return out
}

function normalizeSafety(value, operation) {
  if (!isPlainObject(value)) {
    throw new ConnectorActionContractValidationError('safety must be an object', { field: 'safety' })
  }
  const readOnly = requiredBoolean(value.readOnly, 'safety.readOnly')
  const allowBatch = requiredBoolean(value.allowBatch, 'safety.allowBatch')
  if (!Number.isInteger(value.maxRowsPreview) || value.maxRowsPreview < 0) {
    throw new ConnectorActionContractValidationError('safety.maxRowsPreview must be a non-negative integer', {
      field: 'safety.maxRowsPreview',
    })
  }
  const requiresApproval = requiredBoolean(value.requiresApproval, 'safety.requiresApproval')
  const isWrite = WRITE_OPERATION_SET.has(operation)
  // A write action (target mutation) can never be silently enabled.
  if (isWrite && !requiresApproval) {
    throw new ConnectorActionContractValidationError(
      `write operation "${operation}" must set safety.requiresApproval=true (write actions stay gated/disabled)`,
      { field: 'safety.requiresApproval', operation },
    )
  }
  if (isWrite && readOnly) {
    throw new ConnectorActionContractValidationError(
      `write operation "${operation}" cannot be readOnly`,
      { field: 'safety.readOnly', operation },
    )
  }
  // A non-write op (read/preview/export) must declare readOnly:true — it must not
  // pose as mutating; a non-readOnly non-write action is a contract error.
  if (!isWrite && !readOnly) {
    throw new ConnectorActionContractValidationError(
      `non-write operation "${operation}" must set safety.readOnly=true`,
      { field: 'safety.readOnly', operation },
    )
  }
  return { readOnly, allowBatch, maxRowsPreview: value.maxRowsPreview, requiresApproval }
}

function normalizeHelp(value) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    throw new ConnectorActionContractValidationError('help must be a plain object', { field: 'help' })
  }
  // Operator-facing free text — scrub through the shared redactor so no secret-shaped
  // value can ride along inside action metadata.
  return sanitizeIntegrationPayload(value)
}

function normalizeConnectorAction(input) {
  if (!isPlainObject(input)) {
    throw new ConnectorActionContractValidationError('input must be a plain object')
  }
  const operation = normalizeOperation(input.operation)
  const safety = normalizeSafety(input.safety, operation)
  const action = {
    actionId: requiredString(input.actionId, 'actionId'),
    connectorKind: requiredString(input.connectorKind, 'connectorKind'),
    operation,
    request: normalizeRequest(input.request),
    output: normalizeOutput(input.output),
    safety,
    // Derived: a write op OR an explicit approval requirement is gated. The UI must
    // render a gated action disabled until its own approval gate is satisfied;
    // DF-T1A only annotates — it never enables a write.
    gated: WRITE_OPERATION_SET.has(operation) || safety.requiresApproval === true,
  }
  const label = optionalString(input.label, 'label')
  if (label !== undefined) action.label = label
  const help = normalizeHelp(input.help)
  if (help !== undefined) action.help = help
  return action
}

// First built-in sample: the EXISTING K3 WISE WebAPI Material adapter operations as
// action metadata. get-detail (read) is runnable; save (upsert) is gated/disabled —
// Save-only/write stays behind its own approval, NOT unlocked here. Output paths
// match the adapter's real K3 WISE envelope (StatusCode/Message; save success via
// Result.ResponseStatus.IsSuccess).
const K3_WISE_MATERIAL_ACTIONS = Object.freeze([
  normalizeConnectorAction({
    actionId: 'k3wise.material.get-detail',
    connectorKind: 'erp:k3-wise-webapi',
    operation: 'read',
    label: 'Material GetDetail',
    request: {
      method: 'POST',
      path: '/K3API/Material/GetDetail',
      inputs: { body: [{ name: 'Number', source: 'record.FNumber', required: true }] },
    },
    output: { recordPath: 'Data[0].Data', successPath: 'StatusCode', successValue: 200, errorPath: 'Message' },
    safety: { readOnly: true, allowBatch: false, maxRowsPreview: 1, requiresApproval: false },
  }),
  normalizeConnectorAction({
    actionId: 'k3wise.material.save',
    connectorKind: 'erp:k3-wise-webapi',
    operation: 'upsert',
    label: 'Material Save (Save-only — gated)',
    request: {
      method: 'POST',
      path: '/K3API/Material/Save',
      inputs: { body: [{ name: 'Model', source: 'record', required: true }] },
    },
    output: {
      recordPath: 'Result.ResponseStatus.SuccessEntitys',
      successPath: 'Result.ResponseStatus.IsSuccess',
      successValue: true,
      errorPath: 'Message',
    },
    safety: { readOnly: false, allowBatch: false, maxRowsPreview: 1, requiresApproval: true },
  }),
])

module.exports = {
  CONNECTOR_ACTION_OPERATIONS,
  WRITE_OPERATIONS,
  ConnectorActionContractValidationError,
  normalizeConnectorAction,
  K3_WISE_MATERIAL_ACTIONS,
  __internals: {
    isPlainObject,
    normalizeOperation,
    normalizeRelativePath,
    normalizeInputs,
    normalizeSafety,
  },
}
