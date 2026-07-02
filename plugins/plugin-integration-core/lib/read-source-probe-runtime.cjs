'use strict'

// External-API read self-service — S2-b: fixed `locate-container` probe RUNTIME (#1709).
//
// This is the line's first live outbound read (S2 design-lock,
// docs/development/integration-core-external-api-read-self-service-s2-smoke-wizard-design-lock-20260701.md).
// Scope fence: this module consumes ONLY the frozen S2-a probe plan (normalizeReadSourceProbeContract) plus a
// route-split named-inputs object, and returns ONLY the S2-a values-free evidence (readSourceProbeEvidence) —
// on success AND on failure. It resolves no system itself (the route loads the registered system through the
// backend getExternalSystemForAdapter context and passes it in), adds no credential path (the probe rides the
// existing adapter request path, so K3 login/token handling is pure reuse), persists nothing, audit-logs
// nothing, exposes no route, and touches no write path. Timeout and row cap are the S2-a platform-fixed
// constants — never request-suppliable.

const { isSafeRelativeReadPath } = require('./read-source-config.cjs')
const {
  READ_SOURCE_PROBE_TIMEOUT_MS,
  ReadSourceProbeContractError,
  normalizeReadSourceProbeContract,
  readSourceProbeEvidence,
} = require('./read-source-probe-contract.cjs')
const { applyReadSmokePresetOverlay } = require('./read-smoke.cjs')
const { READ_SMOKE_LIST_REQUEST_MARKER, READ_SMOKE_BOM_REQUEST_MARKER } = require('./read-smoke-marker.cjs')

// Route-level body keys: the S2-a contract (config, boundedSmoke) plus `inputs` — execution-time named
// inputs (the plan's requiredNamedInputs) ride BESIDE the frozen contract, never inside it, so the S2-a
// top-key allowlist stays untouched.
const READ_SOURCE_PROBE_BODY_INPUT_KEY = 'inputs'
const READ_SOURCE_PROBE_INPUT_KEYS = Object.freeze(['key'])
// A named key input is a bound business VALUE (e.g. a material number): bounded, control-char-free, and —
// like the read-smoke key — never echoed into any error or evidence.
const READ_SOURCE_PROBE_KEY_MAX_LENGTH = 128

class ReadSourceProbeRuntimeError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'ReadSourceProbeRuntimeError'
    this.code = 'READ_SOURCE_PROBE_REJECTED'
    this.reason = reason
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBoundedProbeKeyValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return true
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (raw.length === 0 || raw.length > READ_SOURCE_PROBE_KEY_MAX_LENGTH) return false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function normalizeReadSourceProbeInputs(plan, inputs) {
  const source = inputs === undefined ? {} : inputs
  if (!isPlainObject(source)) {
    throw new ReadSourceProbeContractError('inputs_invalid')
  }
  if (!Object.keys(source).every((key) => READ_SOURCE_PROBE_INPUT_KEYS.includes(key))) {
    throw new ReadSourceProbeContractError('inputs_unexpected_field')
  }
  if (plan.requiredNamedInputs.includes('key')) {
    if (!isBoundedProbeKeyValue(source.key)) {
      throw new ReadSourceProbeContractError('key_required')
    }
    return Object.freeze({ key: String(source.key).trim() })
  }
  // Fail-closed the other way too: a key supplied to a keyless plan is rejected, not silently dropped.
  if (source.key !== undefined) {
    throw new ReadSourceProbeContractError('key_not_allowed')
  }
  return Object.freeze({})
}

// Split the route body into { contract, inputs }, normalize the contract through the S2-a normalizer
// (strict allowlist untouched), then validate the inputs against the plan's requiredNamedInputs.
function prepareReadSourceProbe(body) {
  if (!isPlainObject(body)) {
    throw new ReadSourceProbeContractError('not_object')
  }
  const contract = {}
  let inputs
  for (const [key, value] of Object.entries(body)) {
    if (key === READ_SOURCE_PROBE_BODY_INPUT_KEY) {
      inputs = value
    } else {
      contract[key] = value
    }
  }
  const plan = normalizeReadSourceProbeContract(contract)
  return Object.freeze({ plan, inputs: normalizeReadSourceProbeInputs(plan, inputs) })
}

// Non-persisted read-only overlay in the exact shape applyReadSmokePresetOverlay consumes — the same
// in-memory merge the shipped read-smoke route uses (never mutates or persists the stored system). Mode
// mapping rides the EXISTING adapter read modes; the K3 adapter's own scope guards (object/filter/option
// allowlists, list/bom route markers, limit bounds) stay the enforcement point — nothing is widened here.
function buildReadSourceProbeOverlayPreset(plan) {
  const objectOverlay = {
    operations: ['read'],
    readPath: plan.readPath,
    readMethod: plan.readMethod,
  }
  if (plan.mode === 'list_page') {
    objectOverlay.readMode = 'list'
    objectOverlay.maxListLimit = plan.rowCap
  }
  if (plan.mode === 'detail_with_lines') {
    objectOverlay.readMode = 'bom'
    if (plan.keyField) objectOverlay.readBomParentKeyField = plan.keyField
  }
  return {
    readConfigOverlay: {
      objects: {
        [plan.object]: objectOverlay,
      },
    },
  }
}

function buildReadSourceProbeRequest(plan, inputs) {
  if (plan.mode === 'list_page') {
    const request = { object: plan.object, limit: plan.rowCap, options: { k3ReadMode: 'list' } }
    Object.defineProperty(request.options, READ_SMOKE_LIST_REQUEST_MARKER, { value: true, enumerable: true })
    return request
  }
  if (plan.mode === 'detail_with_lines') {
    const options = { k3ReadMode: 'bom' }
    if (inputs.key !== undefined) options.bomKey = inputs.key
    const request = { object: plan.object, options }
    Object.defineProperty(request.options, READ_SMOKE_BOM_REQUEST_MARKER, { value: true, enumerable: true })
    return request
  }
  // single_record / resolver_lookup: keyed detail read. keyField and the key input are both guaranteed
  // (S1 mode-required field + requiredNamedInputs validation above).
  return { object: plan.object, filters: { [plan.keyField]: inputs.key } }
}

// Locate one declared container in the raw response shape: dotted identifier segments, own-property walk
// only (no prototype resolution), first declared path that resolves wins. Returns {type, arrayLength} in the
// readSmokeResponseShapeContainerEvidence vocabulary; unresolved → {type: 'missing'}.
function classifyContainerValue(value) {
  if (Array.isArray(value)) return { type: 'array', arrayLength: value.length }
  if (value === null) return { type: 'null', arrayLength: null }
  const type = typeof value
  if (type === 'object') return { type: 'object', arrayLength: null }
  if (type === 'string' || type === 'number' || type === 'boolean') return { type, arrayLength: null }
  return { type: 'other', arrayLength: null }
}

function locateContainerShape(raw, paths) {
  for (const path of paths) {
    let current = raw
    let resolved = true
    for (const segment of path.split('.')) {
      if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        resolved = false
        break
      }
      current = current[segment]
    }
    if (resolved) return classifyContainerValue(current)
  }
  return { type: 'missing', arrayLength: null }
}

// Coarse, values-free error classification. Compares names/codes/status only — never copies a message,
// value, host, or key into the outcome. Anything unmatched degrades to the generic failure code.
function classifyProbeErrorCode(error) {
  const name = typeof error?.name === 'string' ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'READ_SOURCE_PROBE_TIMEOUT'
  const status = typeof error?.status === 'number'
    ? error.status
    : (typeof error?.details?.status === 'number' ? error.details.status : null)
  if (status === 401 || status === 403) return 'READ_SOURCE_PROBE_AUTH_FAILED'
  const code = typeof error?.code === 'string'
    ? error.code
    : (typeof error?.details?.code === 'string' ? error.details.code : '')
  if (/LOGIN|TOKEN|AUTH/.test(code)) return 'READ_SOURCE_PROBE_AUTH_FAILED'
  if (/BUSINESS/.test(code)) return 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED'
  if (name === 'AdapterValidationError' || name === 'UnsupportedAdapterOperationError') return 'READ_SOURCE_PROBE_REJECTED'
  if (/NOT_CONFIGURED|UNSUPPORTED|REJECTED/.test(code)) return 'READ_SOURCE_PROBE_REJECTED'
  if (name === 'TypeError' || name === 'FetchError' || /READ_FAILED|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(code)) {
    return 'READ_SOURCE_PROBE_NETWORK_FAILED'
  }
  return 'READ_SOURCE_PROBE_FAILED'
}

function probeFailure(plan, errorCode, errorType, extra) {
  return readSourceProbeEvidence(plan, { ok: false, errorCode, errorType, ...extra })
}

// Execute the fixed locate-container probe against an already-loaded, already-kind-checked registered
// system. Contract-level problems throw (the route maps them to 400/409); probe-level outcomes — success,
// container miss, shape mismatch, auth/network/timeout failure — ALWAYS return values-free evidence.
// `timeoutMs` is a dependency-injection point for tests only; the route never passes it, so the platform
// constant is not request-reachable.
async function executeReadSourceProbe(probe, { system, createAdapter, timeoutMs = READ_SOURCE_PROBE_TIMEOUT_MS }) {
  const { plan, inputs } = probe
  // Probe-time defense-in-depth (S2 design-lock lock 2): re-run the strong config-time SSRF guard on the
  // exact path about to go outbound. The plan already passed it at validation time; a plan that arrives
  // here without that property is refused before any adapter exists.
  if (!isSafeRelativeReadPath(plan.readPath)) {
    return probeFailure(plan, 'READ_SOURCE_PROBE_REJECTED', 'ReadSourceProbeRuntimeError')
  }
  if (!isPlainObject(system) || system.kind !== plan.requiredKind) {
    throw new ReadSourceProbeRuntimeError('kind_mismatch')
  }

  const adapterSystem = applyReadSmokePresetOverlay(system, buildReadSourceProbeOverlayPreset(plan))
  const adapter = createAdapter(adapterSystem)
  const request = buildReadSourceProbeRequest(plan, inputs)

  const TIMEOUT = Symbol('read-source-probe-timeout')
  let timer
  const readPromise = Promise.resolve().then(() => adapter.read(request))
  let raced
  try {
    raced = await Promise.race([
      readPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs) }),
    ])
  } catch (error) {
    clearTimeout(timer)
    return probeFailure(plan, classifyProbeErrorCode(error), typeof error?.name === 'string' ? error.name : 'Error')
  }
  clearTimeout(timer)
  if (raced === TIMEOUT) {
    // The underlying request is not aborted (the adapter surface takes no signal); swallow its eventual
    // settlement so a late rejection cannot become an unhandled rejection.
    readPromise.catch(() => {})
    return probeFailure(plan, 'READ_SOURCE_PROBE_TIMEOUT', 'TimeoutError', { timeoutReached: true })
  }

  const raw = raced && raced.raw
  if (!isPlainObject(raw)) {
    return probeFailure(plan, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED', 'ReadSourceProbeRuntimeError')
  }

  const containers = {}
  let containerLocated = true
  for (const container of plan.containers) {
    const shape = locateContainerShape(raw, container.paths)
    containers[container.alias] = shape
    if (shape.type === 'missing') containerLocated = false
  }
  const shapeOk = containerLocated
    && Object.values(containers).every((shape) => shape.type === 'array' || shape.type === 'object')

  const result = {
    ok: containerLocated && shapeOk,
    containers,
    containerLocated,
    boundedSmokeExecuted: plan.boundedSmoke,
    timeoutReached: false,
  }
  if (plan.boundedSmoke) {
    const records = Array.isArray(raced.records) ? raced.records : []
    result.recordCount = Math.min(records.length, plan.rowCap)
    result.capReached = records.length >= plan.rowCap
  }
  if (!containerLocated) {
    result.errorCode = 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'
    result.errorType = 'ReadSourceProbeRuntimeError'
  } else if (!shapeOk) {
    result.errorCode = 'READ_SOURCE_PROBE_SHAPE_MISMATCH'
    result.errorType = 'ReadSourceProbeRuntimeError'
  }
  return readSourceProbeEvidence(plan, result)
}

module.exports = {
  ReadSourceProbeRuntimeError,
  prepareReadSourceProbe,
  executeReadSourceProbe,
  __internals: {
    buildReadSourceProbeOverlayPreset,
    buildReadSourceProbeRequest,
    classifyProbeErrorCode,
    locateContainerShape,
    normalizeReadSourceProbeInputs,
  },
}
