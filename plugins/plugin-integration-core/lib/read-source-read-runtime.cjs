'use strict'

// External-API read self-service — S3-1: config-driven read EXECUTOR (pure module, #1709).
//
// Two-tier model (S0 direction lock): the runtime tier consumes an ALREADY-APPROVED, S1-normalized
// read-source config and supplies ONLY the preset-declared named key input — never a raw endpoint, filter,
// body, or response path. This module is the DATA-PLANE counterpart of the S2-b probe (evidence-only):
// the config's fieldMap carries mapped field VALUES into the authorized caller context, while the EVIDENCE
// plane stays values-free (same vocabulary as the probe). The two planes never mix: mapped values, fieldMap
// names, raw rows, and the supplied key can appear ONLY under `data`, never under `evidence`.
//
// Scope fence: pure functions + injected deps. No route, no persistence, no approved-config lookup (the
// route wiring is the next gated slice and passes an already-loaded config + system in), no write path,
// no new credential path. Outbound mechanics are the PROMOTED S2-b builders — the probe and the configured
// read build the same overlay and the same request, and classify errors identically, by construction.

const { isSafeRelativeReadPath } = require('./read-source-config.cjs')
const {
  READ_SOURCE_PROBE_TIMEOUT_MS,
  ReadSourceProbeContractError,
  normalizeReadSourceProbeContract,
  readSourceProbeEvidence,
} = require('./read-source-probe-contract.cjs')
const {
  ReadSourceProbeRuntimeError,
  buildReadSourceProbeOverlayPreset,
  buildReadSourceProbeRequest,
  classifyProbeErrorCode,
  normalizeReadSourceProbeInputs,
} = require('./read-source-probe-runtime.cjs')
const { applyReadSmokePresetOverlay } = require('./read-smoke.cjs')

const CONFIGURED_READ_BODY_KEYS = Object.freeze(['config', 'inputs'])

// resolver_lookup runtime is a LATER gated slice: its selection semantics (how multiplicityRuleField picks
// among candidate rows) are not designed anywhere on this line yet, so executing it as a plain keyed read
// would silently drop the multiplicity rule. Fail-closed reject instead — flagged, not silently dropped
// (same discipline as the S1 marker-gating deferral in read-source-config.cjs).
const CONFIGURED_READ_SUPPORTED_MODES = Object.freeze(['single_record', 'list_page', 'detail_with_lines'])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Normalize the runtime-read input: S1-normalized config only (enforced by the S2-a contract normalizer's
// strict allowlist + config_not_normalized comparison), S2-b named-inputs discipline, PLUS the data-plane
// fail-closed rule: a configured read without a fieldMap has no data plane and is rejected outright.
function prepareConfiguredRead(body) {
  if (!isPlainObject(body)) {
    throw new ReadSourceProbeContractError('not_object')
  }
  if (!Object.keys(body).every((key) => CONFIGURED_READ_BODY_KEYS.includes(key))) {
    throw new ReadSourceProbeContractError('unexpected_field')
  }
  // A configured read IS a bounded, capped read — build the plan with boundedSmoke true so the plan and
  // its evidence say so consistently (no boundedSmoke:false + boundedSmokeExecuted:true contradiction).
  const plan = normalizeReadSourceProbeContract({ config: body.config, boundedSmoke: true })
  if (!CONFIGURED_READ_SUPPORTED_MODES.includes(plan.mode)) {
    throw new ReadSourceProbeContractError('mode_not_supported')
  }
  const fieldMap = body.config && body.config.fieldMap
  if (!Array.isArray(fieldMap) || fieldMap.length === 0) {
    throw new ReadSourceProbeContractError('field_map_required')
  }
  return Object.freeze({
    plan,
    fieldMap,
    inputs: normalizeReadSourceProbeInputs(plan, body.inputs),
  })
}

// Own-property dotted walk that returns the VALUE (the probe's walk is shape-only and stays there).
// Prototype keys never resolve.
function walkOwnPath(root, path) {
  let current = root
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { resolved: false, value: null }
    }
    current = current[segment]
  }
  return { resolved: true, value: current }
}

function locateContainerValue(raw, paths) {
  for (const path of paths) {
    const { resolved, value } = walkOwnPath(raw, path)
    if (resolved) return { located: true, value }
  }
  return { located: false, value: null }
}

function classifyContainerShape(value) {
  if (Array.isArray(value)) return { type: 'array', arrayLength: value.length }
  if (value === null) return { type: 'null', arrayLength: null }
  const type = typeof value
  if (type === 'object') return { type: 'object', arrayLength: null }
  if (type === 'string' || type === 'number' || type === 'boolean') return { type, arrayLength: null }
  return { type: 'other', arrayLength: null }
}

// Data-plane projection: ONLY fieldMap targets appear on an output record — never the whole raw row,
// never an unmapped field. A source that does not resolve in the row maps to null (fail-soft per field;
// the container-level shape rules above stay fail-closed).
function mapRecord(row, fieldMap) {
  const record = {}
  for (const entry of fieldMap) {
    const { resolved, value } = walkOwnPath(row, entry.source)
    record[entry.target] = resolved ? value : null
  }
  return record
}

function failureOutcome(plan, errorCode, errorType, extra) {
  return {
    evidence: readSourceProbeEvidence(plan, { ok: false, errorCode, errorType, ...extra }),
    data: null,
  }
}

// Execute a configured read against an already-loaded, already-approved registered system. Contract-level
// problems throw (route maps to 4xx); read-level outcomes ALWAYS return { evidence, data } — evidence
// values-free in the probe vocabulary, data null on any failure. `timeoutMs` is dependency injection for
// tests only; the platform constants are never request-reachable.
async function executeConfiguredRead(prepared, { system, createAdapter, timeoutMs = READ_SOURCE_PROBE_TIMEOUT_MS }) {
  const { plan, fieldMap, inputs } = prepared
  // Execution-time defense-in-depth — same re-guard as the S2-b probe: no adapter, no outbound path for
  // a readPath that lost the config-time guarantee.
  if (!isSafeRelativeReadPath(plan.readPath)) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_REJECTED', 'ReadSourceProbeRuntimeError')
  }
  if (!isPlainObject(system) || system.kind !== plan.requiredKind) {
    throw new ReadSourceProbeRuntimeError('kind_mismatch')
  }

  const adapterSystem = applyReadSmokePresetOverlay(system, buildReadSourceProbeOverlayPreset(plan))
  const adapter = createAdapter(adapterSystem)
  const request = buildReadSourceProbeRequest(plan, inputs)

  const TIMEOUT = Symbol('read-source-configured-read-timeout')
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
    return failureOutcome(plan, classifyProbeErrorCode(error), typeof error?.name === 'string' ? error.name : 'Error')
  }
  clearTimeout(timer)
  if (raced === TIMEOUT) {
    // Not aborted (the adapter surface takes no signal); swallow the eventual settlement so a late
    // rejection cannot become an unhandled rejection.
    readPromise.catch(() => {})
    return failureOutcome(plan, 'READ_SOURCE_PROBE_TIMEOUT', 'TimeoutError', { timeoutReached: true })
  }

  const raw = raced && raced.raw
  if (!isPlainObject(raw)) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED', 'ReadSourceProbeRuntimeError')
  }

  const shapes = {}
  const dataContainers = {}
  let containerLocated = true
  let shapeOk = true
  let recordCount = 0
  let capReached = false
  for (const container of plan.containers) {
    const { located, value } = locateContainerValue(raw, container.paths)
    if (!located) {
      shapes[container.alias] = { type: 'missing', arrayLength: null }
      containerLocated = false
      continue
    }
    shapes[container.alias] = classifyContainerShape(value)
    let rows
    if (Array.isArray(value)) {
      rows = value.slice(0, plan.rowCap)
      if (value.length >= plan.rowCap) capReached = true
      // Fail-closed: scalar/array entries inside a row container are a shape mismatch, not a row — mapping
      // them would fabricate all-null records under ok:true.
      if (!rows.every(isPlainObject)) {
        shapeOk = false
        continue
      }
    } else if (isPlainObject(value)) {
      rows = [value]
    } else {
      shapeOk = false
      continue
    }
    const records = rows.map((row) => mapRecord(row, fieldMap))
    recordCount += records.length
    dataContainers[container.alias] = { records }
  }

  if (!containerLocated) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND', 'ReadSourceProbeRuntimeError', {
      containers: shapes,
      containerLocated: false,
    })
  }
  if (!shapeOk) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_SHAPE_MISMATCH', 'ReadSourceProbeRuntimeError', {
      containers: shapes,
      containerLocated: true,
    })
  }

  const evidence = readSourceProbeEvidence(plan, {
    ok: true,
    containers: shapes,
    containerLocated: true,
    // A configured read IS a bounded, capped read — the data plane above is rowCap-bounded per container.
    boundedSmokeExecuted: true,
    timeoutReached: false,
    recordCount,
    capReached,
  })
  return {
    evidence,
    data: { containers: dataContainers, recordCount },
  }
}

module.exports = {
  prepareConfiguredRead,
  executeConfiguredRead,
  __internals: {
    locateContainerValue,
    mapRecord,
    walkOwnPath,
  },
}
