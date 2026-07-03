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
// R0 (#1709 / resolver design-lock): the exact resolver coarse-code allowlist. Registered as EXACT values in
// the probe error-code set below so safeErrorCode accepts them — PREFIX MATCHING IS NOT ALLOWED, an unknown
// resolver-looking code still degrades to the generic safe fallback. R1's evaluator produces these; R0 only
// registers the surface so a producer object is not silently clamped into a generic failure.
const READ_SOURCE_RESOLVER_ERROR_CODES = Object.freeze([
  'READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND',
  'READ_SOURCE_RESOLVER_SHAPE_MISMATCH',
  'READ_SOURCE_RESOLVER_NO_MATCH',
  'READ_SOURCE_RESOLVER_AMBIGUOUS',
  'READ_SOURCE_RESOLVER_CAP_REACHED',
  'READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED',
  'READ_SOURCE_RESOLVER_RULE_INVALID',
  'READ_SOURCE_RESOLVER_FIELD_MISSING',
  'READ_SOURCE_RESOLVER_FAILED',
])
// The resolver evidence `rule` value is a closed vocabulary (mirrors read-source-config RESOLVER_RULES).
const READ_SOURCE_RESOLVER_RULES = Object.freeze(['exactly_one', 'first_when_sorted', 'field_equals'])
const READ_SOURCE_RESOLVER_RULE_SET = new Set(READ_SOURCE_RESOLVER_RULES)

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
  ...READ_SOURCE_RESOLVER_ERROR_CODES,
])
const READ_SOURCE_PROBE_ERROR_CODE_SET = new Set(READ_SOURCE_PROBE_ERROR_CODES)
const READ_SOURCE_PROBE_ERROR_TYPES = Object.freeze([
  'Error',
  'AbortError',
  'FetchError',
  'K3WiseWebApiAdapterError',
  'ReadSourceProbeContractError',
  'ReadSourceProbeRuntimeError',
  'ReadSourceResolverError',
  'TimeoutError',
  'TypeError',
])
const READ_SOURCE_PROBE_ERROR_TYPE_SET = new Set(READ_SOURCE_PROBE_ERROR_TYPES)
// R0: resolver evidence counts (candidateCount/matchedCount) join the values-free count allowlist.
const READ_SOURCE_PROBE_EVIDENCE_COUNT_KEYS = Object.freeze(['recordCount', 'rowCount', 'sampleCount', 'candidateCount', 'matchedCount'])
const READ_SOURCE_PROBE_EVIDENCE_BOOLEAN_KEYS = Object.freeze([
  'containerLocated',
  'boundedSmokeExecuted',
  'timeoutReached',
  'capReached',
  // R0: resolver evidence booleans.
  'ambiguous',
  'resolved',
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

// R0: the resolver evidence `rule` field is a closed vocabulary — exact membership, never a producer-supplied
// free string (values-free: a raw/unknown rule string is dropped, not echoed).
function safeResolverRule(value) {
  return typeof value === 'string' && READ_SOURCE_RESOLVER_RULE_SET.has(value) ? value : null
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

  // R0: the resolver `rule` field, closed-vocabulary only (absent for non-resolver probes).
  const rule = safeResolverRule(source.rule)
  if (rule !== null) evidence.rule = rule

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
  READ_SOURCE_RESOLVER_ERROR_CODES,
  READ_SOURCE_RESOLVER_RULES,
  ReadSourceProbeContractError,
  normalizeReadSourceProbeContract,
  readSourceProbeContractErrorEvidence,
  readSourceProbeEvidence,
  safeResolverRule,
}
