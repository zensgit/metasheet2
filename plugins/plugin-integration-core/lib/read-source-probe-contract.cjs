'use strict'

// External-API read self-service — S2-a: probe contract + values-free evidence schema ONLY.
//
// Scope fence: pure functions. This module does NOT resolve external systems, decrypt credentials, assemble
// URLs, call any network, persist anything, audit-log anything, expose a route, or touch a write path. It is
// the contract/evidence handoff that S2-b (live probe) and S2-c (save version) may consume later.

const { validateReadSourceConfig } = require('./read-source-config.cjs')
const { readSmokeResponseShapeContainerEvidence } = require('./read-smoke.cjs')

const READ_SOURCE_PROBE_TIMEOUT_MS = 5000
const READ_SOURCE_PROBE_ROW_CAP = 10

const READ_SOURCE_PROBE_CONTRACT_TOP_KEYS = Object.freeze(['config', 'boundedSmoke'])
const READ_SOURCE_PROBE_CONTAINER_ALIASES = Object.freeze(['primary', 'header', 'lines'])
const READ_SOURCE_PROBE_ERROR_CODE = 'READ_SOURCE_PROBE_CONTRACT_INVALID'
const READ_SOURCE_PROBE_DEFAULT_ERROR = 'READ_SOURCE_PROBE_FAILED'
const READ_SOURCE_PROBE_ERROR_CODES = Object.freeze([
  READ_SOURCE_PROBE_ERROR_CODE,
  READ_SOURCE_PROBE_DEFAULT_ERROR,
  'READ_SOURCE_PROBE_AUTH_FAILED',
  'READ_SOURCE_PROBE_CAP_REACHED',
  'READ_SOURCE_PROBE_CONFIG_INVALID',
  'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND',
  'READ_SOURCE_PROBE_NETWORK_FAILED',
  'READ_SOURCE_PROBE_REJECTED',
  'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED',
  'READ_SOURCE_PROBE_SHAPE_MISMATCH',
  'READ_SOURCE_PROBE_TIMEOUT',
])
const READ_SOURCE_PROBE_ERROR_CODE_SET = new Set(READ_SOURCE_PROBE_ERROR_CODES)
const READ_SOURCE_PROBE_ERROR_TYPES = Object.freeze([
  'Error',
  'AbortError',
  'FetchError',
  'K3WiseWebApiAdapterError',
  'ReadSourceProbeContractError',
  'ReadSourceProbeRuntimeError',
  'TimeoutError',
  'TypeError',
])
const READ_SOURCE_PROBE_ERROR_TYPE_SET = new Set(READ_SOURCE_PROBE_ERROR_TYPES)
const READ_SOURCE_PROBE_EVIDENCE_COUNT_KEYS = Object.freeze(['recordCount', 'rowCount', 'sampleCount'])
const READ_SOURCE_PROBE_EVIDENCE_BOOLEAN_KEYS = Object.freeze([
  'containerLocated',
  'boundedSmokeExecuted',
  'timeoutReached',
  'capReached',
])

class ReadSourceProbeContractError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'ReadSourceProbeContractError'
    this.code = READ_SOURCE_PROBE_ERROR_CODE
    this.reason = reason
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function onlyAllowedKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function stableStringify(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function freezeArray(values) {
  return Object.freeze(values.slice())
}

function freezeContainer(alias, paths) {
  return Object.freeze({
    alias,
    paths: freezeArray(paths),
  })
}

function buildProbeContainers(config) {
  if (config.mode === 'detail_with_lines') {
    return Object.freeze([
      freezeContainer('header', config.headerContainerPaths || []),
      freezeContainer('lines', config.lineContainerPaths || []),
    ])
  }
  return Object.freeze([
    freezeContainer('primary', config.containerPaths || []),
  ])
}

function requiredNamedInputsForConfig(config) {
  if (config.keyField) return Object.freeze(['key'])
  return Object.freeze([])
}

function assertS1NormalizedConfig(config) {
  const result = validateReadSourceConfig(config)
  if (!result.valid) {
    throw new ReadSourceProbeContractError('config_invalid')
  }
  // Caller obligation for S2-b/S2-c: pass validateReadSourceConfig(raw).normalized, not raw config. A
  // merely valid raw config can differ in trimmed strings, normalized readPath, frozen read-only operations,
  // and fieldMap shape, so accepting it would make the probe contract a second validator by accident.
  if (stableStringify(config) !== stableStringify(result.normalized)) {
    throw new ReadSourceProbeContractError('config_not_normalized')
  }
  return result.normalized
}

function normalizeReadSourceProbeContract(input) {
  if (!isPlainObject(input)) {
    throw new ReadSourceProbeContractError('not_object')
  }
  if (!onlyAllowedKeys(input, READ_SOURCE_PROBE_CONTRACT_TOP_KEYS)) {
    throw new ReadSourceProbeContractError('unexpected_field')
  }
  if (!isPlainObject(input.config)) {
    throw new ReadSourceProbeContractError('config_required')
  }
  if (input.boundedSmoke !== undefined && typeof input.boundedSmoke !== 'boolean') {
    throw new ReadSourceProbeContractError('bounded_smoke_invalid')
  }

  const config = assertS1NormalizedConfig(input.config)
  const containers = buildProbeContainers(config)
  const plan = {
    systemId: config.systemId,
    requiredKind: config.requiredKind,
    object: config.object,
    mode: config.mode,
    readPath: config.readPath,
    readMethod: config.readMethod,
    operations: Object.freeze(['read']),
    requiredNamedInputs: requiredNamedInputsForConfig(config),
    containers,
    boundedSmoke: input.boundedSmoke === true,
    timeoutMs: READ_SOURCE_PROBE_TIMEOUT_MS,
    rowCap: READ_SOURCE_PROBE_ROW_CAP,
  }
  if (config.keyField) plan.keyField = config.keyField
  if (config.keyEncoding) plan.keyEncoding = config.keyEncoding
  if (config.multiplicityRuleField) plan.multiplicityRuleField = config.multiplicityRuleField
  return Object.freeze(plan)
}

function safeCount(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return null
}

function safeErrorCode(value) {
  if (typeof value !== 'string') return null
  const code = value.trim()
  return READ_SOURCE_PROBE_ERROR_CODE_SET.has(code) ? code : null
}

function safeErrorType(value) {
  if (typeof value !== 'string') return null
  const type = value.trim()
  return READ_SOURCE_PROBE_ERROR_TYPE_SET.has(type) ? type : null
}

function readSourceProbeContractErrorEvidence(error) {
  const reason = typeof error?.reason === 'string' && /^[a-z0-9_:-]{1,80}$/.test(error.reason)
    ? error.reason
    : 'invalid'
  return Object.freeze({
    ok: false,
    errorCode: READ_SOURCE_PROBE_ERROR_CODE,
    reason,
  })
}

function readSourceProbeEvidence(plan, result) {
  const source = isPlainObject(result) ? result : {}
  const allowedAliases = new Set()
  if (Array.isArray(plan?.containers)) {
    for (const container of plan.containers) {
      if (container && READ_SOURCE_PROBE_CONTAINER_ALIASES.includes(container.alias)) {
        allowedAliases.add(container.alias)
      }
    }
  }
  const evidence = {
    ok: source.ok === true,
    object: typeof plan?.object === 'string' ? plan.object : 'unknown',
    mode: typeof plan?.mode === 'string' ? plan.mode : 'unknown',
    boundedSmoke: plan?.boundedSmoke === true,
  }

  const containers = {}
  if (isPlainObject(source.containers)) {
    for (const alias of READ_SOURCE_PROBE_CONTAINER_ALIASES) {
      if (!allowedAliases.has(alias)) continue
      const container = readSmokeResponseShapeContainerEvidence(source.containers[alias])
      if (container) containers[alias] = container
    }
  }
  if (Object.keys(containers).length > 0) evidence.containers = containers

  for (const key of READ_SOURCE_PROBE_EVIDENCE_COUNT_KEYS) {
    const count = safeCount(source[key])
    if (count !== null) evidence[key] = count
  }
  for (const key of READ_SOURCE_PROBE_EVIDENCE_BOOLEAN_KEYS) {
    if (typeof source[key] === 'boolean') evidence[key] = source[key]
  }

  if (!evidence.ok) {
    evidence.errorCode = safeErrorCode(source.errorCode) || READ_SOURCE_PROBE_DEFAULT_ERROR
    evidence.errorType = safeErrorType(source.errorType) || 'Error'
  }

  return Object.freeze(evidence)
}

module.exports = {
  READ_SOURCE_PROBE_TIMEOUT_MS,
  READ_SOURCE_PROBE_ROW_CAP,
  READ_SOURCE_PROBE_CONTRACT_TOP_KEYS,
  READ_SOURCE_PROBE_CONTAINER_ALIASES,
  READ_SOURCE_PROBE_ERROR_CODES,
  READ_SOURCE_PROBE_ERROR_TYPES,
  ReadSourceProbeContractError,
  normalizeReadSourceProbeContract,
  readSourceProbeContractErrorEvidence,
  readSourceProbeEvidence,
}
