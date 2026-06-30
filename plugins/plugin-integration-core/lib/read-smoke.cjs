'use strict'

const { READ_SMOKE_LIST_REQUEST_MARKER } = require('./read-smoke-marker.cjs')

// #1709 follow-up: generic read-smoke preset catalog + values-free evidence helpers.
// Registers ONLY built-in presets — there is no user/request-supplied preset path. The preset
// (kind/object/read shape) comes from THIS frozen catalog, never the request. Read-only: supports the
// original forced single-record Material/GetDetail smoke plus the C3 customer-gated bounded Material/GetList
// probe. No BOM, resolver, Save, Submit, Audit, external write, raw endpoint/path/method/payload, or
// request-supplied pagination/filtering. Evidence is values-free (booleans / counts / coarse enums only) —
// never the key, raw payload, material values, host, token, credentials, or connection string.

const READ_SMOKE_PRESETS = Object.freeze({
  'k3wise.material-detail.v1': Object.freeze({
    presetId: 'k3wise.material-detail.v1',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    // C1 contract metadata (#1709 / C0 #3242): the allowlisted objects + modes for the forward-looking
    // { presetId, intent } shape, plus the defaults used to normalize the shipped { presetId, key } compat
    // subset to the SAME output — so the two shapes cannot silently diverge.
    allowedObjects: Object.freeze(['material']),
    allowedModes: Object.freeze(['single_record_detail']),
    defaultObject: 'material',
    defaultMode: 'single_record_detail',
    readConfigOverlay: Object.freeze({
      objects: Object.freeze({
        material: Object.freeze({
          operations: Object.freeze(['read']),
          readPath: '/K3API/Material/GetDetail',
          readMethod: 'POST',
        }),
      }),
    }),
  }),
  'k3wise.material-list.v1': Object.freeze({
    presetId: 'k3wise.material-list.v1',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    // C3 LIST-only (#1709): explicit preset + explicit intent shape only. The bounded pagination
    // parameters are preset-owned and never request-sourced.
    allowedObjects: Object.freeze(['material']),
    allowedModes: Object.freeze(['list']),
    defaultObject: 'material',
    defaultMode: 'list',
    listLimit: 10,
    readConfigOverlay: Object.freeze({
      objects: Object.freeze({
        material: Object.freeze({
          operations: Object.freeze(['read']),
          readPath: '/K3API/Material/GetList',
          readMethod: 'POST',
          readMode: 'list',
          readListBodyTemplate: Object.freeze({
            Data: Object.freeze({
              Top: 10,
              PageIndex: 1,
            }),
          }),
          readListBodyKey: 'Data',
          readListFields: Object.freeze(['FNumber', 'FName', 'FModel', 'FUnitID']),
          readListOrderBy: 'FNumber',
          readListFilterField: 'FNumber',
          readListFilterMode: 'contains_like',
          readListFilterEscape: 'k3_freeform',
          topField: 'Top',
          pageIndexField: 'PageIndex',
          pageSizeField: 'PageSize',
          maxListLimit: 10,
        }),
      }),
    }),
  }),
})

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const READ_SMOKE_LIST_SHAPE_PROBE_KEYS = Object.freeze([
  'dataData',
  'dataLowerData',
  'dataPascalData',
  'dataRows',
  'resultData',
  'resultRows',
  'rows',
  'topLevelArray',
])

function readSmokeListShapeProbeEvidence(value) {
  if (!isPlainObject(value)) return null
  const evidence = {}
  let hasEvidence = false
  for (const key of READ_SMOKE_LIST_SHAPE_PROBE_KEYS) {
    if (typeof value[key] !== 'boolean') continue
    evidence[key] = value[key]
    hasEvidence = true
  }
  return hasEvidence ? evidence : null
}

const READ_SMOKE_RESPONSE_SHAPE_CONTAINER_KEYS = Object.freeze([
  'dataData',
  'dataLowerData',
  'dataPascalData',
  'dataRows',
  'dataList',
  'dataItems',
  'resultData',
  'resultRows',
  'rows',
  'topLevel',
])
const READ_SMOKE_RESPONSE_SHAPE_TYPES = new Set(['array', 'null', 'object', 'string', 'number', 'boolean', 'missing', 'other'])

function readSmokeSafeCount(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return null
}

function readSmokeSafeOptionalCount(value) {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return undefined
}

function readSmokeSafeShapeType(value) {
  if (typeof value !== 'string') return null
  return READ_SMOKE_RESPONSE_SHAPE_TYPES.has(value) ? value : null
}

function readSmokeResponseShapeContainerEvidence(value) {
  if (!isPlainObject(value)) return null
  const type = readSmokeSafeShapeType(value.type)
  if (!type) return null
  const evidence = { type }
  const arrayLength = readSmokeSafeOptionalCount(value.arrayLength)
  if (arrayLength !== undefined) evidence.arrayLength = arrayLength
  return evidence
}

function readSmokeResponseShapeProbeEvidence(value) {
  if (!isPlainObject(value)) return null
  const evidence = {}
  let hasEvidence = false
  for (const key of ['dataObjectPresent', 'dataRowCountPresent', 'dataPageSizePresent', 'dataPageIndexPresent']) {
    if (typeof value[key] !== 'boolean') continue
    evidence[key] = value[key]
    hasEvidence = true
  }
  const dataDataType = readSmokeSafeShapeType(value.dataDataType)
  if (dataDataType) {
    evidence.dataDataType = dataDataType
    hasEvidence = true
  }
  const dataDataArrayLength = readSmokeSafeOptionalCount(value.dataDataArrayLength)
  if (dataDataArrayLength !== undefined) {
    evidence.dataDataArrayLength = dataDataArrayLength
    hasEvidence = true
  }
  if (isPlainObject(value.fixedContainers)) {
    const fixedContainers = {}
    for (const key of READ_SMOKE_RESPONSE_SHAPE_CONTAINER_KEYS) {
      const container = readSmokeResponseShapeContainerEvidence(value.fixedContainers[key])
      if (container) fixedContainers[key] = container
    }
    if (Object.keys(fixedContainers).length > 0) {
      evidence.fixedContainers = fixedContainers
      hasEvidence = true
    }
  }
  return hasEvidence ? evidence : null
}

// C3 LIST paging echo (#1709): copy ONLY the allowlisted values-free count fields (K3-echoed page size/index +
// our requested paging) from a metadata/details source onto the evidence. Non-negative integers only.
const READ_SMOKE_LIST_PAGING_COUNT_KEYS = Object.freeze(['dataPageSize', 'dataPageIndex', 'requestedLimit', 'requestedPageIndex'])
function applyReadSmokePagingCounts(evidence, source) {
  if (!source || typeof source !== 'object') return
  for (const key of READ_SMOKE_LIST_PAGING_COUNT_KEYS) {
    const count = readSmokeSafeCount(source[key])
    if (count !== null) evidence[key] = count
  }
}

function mergeOperations(existing, required) {
  const values = []
  for (const source of [existing, required]) {
    if (!Array.isArray(source)) continue
    for (const item of source) {
      if (typeof item !== 'string' || item.trim().length === 0) continue
      const operation = item.trim()
      if (!values.includes(operation)) values.push(operation)
    }
  }
  return values
}

// Built-in catalog lookup. Returns undefined for anything not in the catalog (→ route fail-closes). Uses an
// own-property check so prototype keys ('toString', '__proto__', …) can never resolve to a preset.
function getReadSmokePreset(presetId) {
  if (typeof presetId !== 'string' || !presetId) return undefined
  return Object.prototype.hasOwnProperty.call(READ_SMOKE_PRESETS, presetId) ? READ_SMOKE_PRESETS[presetId] : undefined
}

// Built-in request builder. Detail reads require a single explicit key. LIST reads are bounded by the
// preset and never accept request-supplied filters, cursor, watermark, path, method, or limit.
function buildReadSmokeRequest(preset, contractOrKey) {
  const contract = typeof contractOrKey === 'string'
    ? { object: preset.object, mode: preset.defaultMode || 'single_record_detail', key: contractOrKey }
    : contractOrKey
  const object = contract && typeof contract.object === 'string' ? contract.object : preset.object
  const mode = contract && typeof contract.mode === 'string' ? contract.mode : preset.defaultMode
  if (mode === 'single_record_detail') {
    return { object, filters: { FNumber: contract.key } }
  }
  if (mode === 'list') {
    const request = {
      object,
      limit: preset.listLimit,
      options: { k3ReadMode: 'list' },
    }
    Object.defineProperty(request.options, READ_SMOKE_LIST_REQUEST_MARKER, {
      value: true,
      enumerable: true,
    })
    if (contract.key !== undefined) request.options.listKey = contract.key
    return request
  }
  throw new ReadSmokeContractError('mode_not_allowed', 'mode is not allowlisted for this preset')
}

// Non-persisted preset overlay for the credentialed read-smoke route. Entity-machine validation
// showed that target-side K3 systems often have only Save/upsert config persisted; the smoke
// preset owns the single read endpoint and merges it into an in-memory system clone before
// adapter creation. It never mutates or persists the stored external system.
function applyReadSmokePresetOverlay(system, preset) {
  if (!isPlainObject(system) || !isPlainObject(preset) || !isPlainObject(preset.readConfigOverlay)) {
    return system
  }
  const currentConfig = isPlainObject(system.config) ? system.config : {}
  const currentObjects = isPlainObject(currentConfig.objects) ? currentConfig.objects : {}
  const overlayObjects = isPlainObject(preset.readConfigOverlay.objects) ? preset.readConfigOverlay.objects : {}
  const nextObjects = { ...currentObjects }
  for (const [objectName, overlay] of Object.entries(overlayObjects)) {
    if (!isPlainObject(overlay)) continue
    const currentObject = isPlainObject(currentObjects[objectName]) ? currentObjects[objectName] : {}
    nextObjects[objectName] = {
      ...currentObject,
      ...overlay,
      operations: mergeOperations(currentObject.operations, overlay.operations),
    }
  }
  return {
    ...system,
    config: {
      ...currentConfig,
      objects: nextObjects,
    },
  }
}

// Values-free evidence from a successful read. Extracts ONLY booleans/counts from the result — never
// record values, raw payload, or metadata that may carry a key/readPath.
function readSmokeSuccessEvidence(preset, result, contract = {}) {
  const records = result && Array.isArray(result.records) ? result.records : []
  const recordPresent = records.length > 0
  const object = typeof contract.object === 'string' && contract.object ? contract.object : preset.object
  const mode = typeof contract.mode === 'string' && contract.mode ? contract.mode : preset.defaultMode
  let referenceObjectCount = 0
  if (recordPresent) {
    const refs = records[0] && records[0]._k3ReferenceObjects
    referenceObjectCount = refs && typeof refs === 'object' ? Object.keys(refs).length : 0
  }
  const evidence = {
    ok: true,
    presetId: preset.presetId,
    object,
    mode,
    recordPresent,
    recordCount: records.length,
    referenceObjectCount,
  }
  if (result && result.metadata && typeof result.metadata.dataDataPresent === 'boolean') {
    evidence.dataDataPresent = result.metadata.dataDataPresent
  }
  const dataRowCount = readSmokeSafeCount(result && result.metadata && result.metadata.dataRowCount)
  if (dataRowCount !== null) evidence.dataRowCount = dataRowCount
  applyReadSmokePagingCounts(evidence, result && result.metadata)
  const listShapeProbe = readSmokeListShapeProbeEvidence(result && result.metadata && result.metadata.listShapeProbe)
  if (listShapeProbe) evidence.listShapeProbe = listShapeProbe
  const responseShapeProbe = readSmokeResponseShapeProbeEvidence(result && result.metadata && result.metadata.responseShapeProbe)
  if (responseShapeProbe) evidence.responseShapeProbe = responseShapeProbe
  return evidence
}

// Values-free error evidence. Returns ONLY a coarse code + type — never the error message, which may carry
// the key or material values.
function readSmokeErrorEvidence(preset, error, contract = {}) {
  // Use the error's own enum-like code + name only (both values-free). Never fall back to constructor.name
  // (a plain thrown object would surface 'Object', which is noise) and never read the message.
  const code = readSmokeSafeErrorCode(error && error.code) ||
    readSmokeSafeErrorCode(error && error.details && error.details.code)
  const name = error && typeof error.name === 'string' && error.name ? error.name : null
  const object = typeof contract.object === 'string' && contract.object ? contract.object : preset.object
  const mode = typeof contract.mode === 'string' && contract.mode ? contract.mode : preset.defaultMode
  const evidence = {
    ok: false,
    presetId: preset.presetId,
    object,
    mode,
    errorCode: code || 'READ_SMOKE_READ_FAILED',
    errorType: name || 'Error',
  }
  if (error && error.details && typeof error.details.dataDataPresent === 'boolean') {
    evidence.dataDataPresent = error.details.dataDataPresent
  }
  const dataRowCount = readSmokeSafeCount(error && error.details && error.details.dataRowCount)
  if (dataRowCount !== null) evidence.dataRowCount = dataRowCount
  applyReadSmokePagingCounts(evidence, error && error.details)
  const listShapeProbe = readSmokeListShapeProbeEvidence(error && error.details && error.details.listShapeProbe)
  if (listShapeProbe) evidence.listShapeProbe = listShapeProbe
  const responseShapeProbe = readSmokeResponseShapeProbeEvidence(error && error.details && error.details.responseShapeProbe)
  if (responseShapeProbe) evidence.responseShapeProbe = responseShapeProbe
  return evidence
}

function readSmokeSafeErrorCode(value) {
  if (typeof value !== 'string') return null
  const code = value.trim()
  if (!code || code.length > 80) return null
  return /^[A-Z0-9_:-]+$/.test(code) ? code : null
}

// C1 contract normalizer (#1709 / C0 #3242). Reconciles the forward-looking
// { presetId, intent:{ object, mode, key } } shape with the shipped read-smoke { presetId, key } subset by
// normalizing BOTH detail shapes to one output { presetId, object, mode, key }. C3 LIST uses the explicit
// intent shape and returns { presetId, object, mode } or an optional key that maps only to the preset-owned
// internal preset-owned LIST filter. Fail-closed + values-free: a raw
// path/method/headers/
// body/response/credential/config can never ride in (strict key allowlist); unknown preset/object/mode → a
// coarse reason; the key is never echoed in an error.
const READ_SMOKE_CONTRACT_TOP_KEYS = Object.freeze(['presetId', 'key', 'intent'])
const READ_SMOKE_CONTRACT_INTENT_KEYS = Object.freeze(['object', 'mode', 'key'])

class ReadSmokeContractError extends Error {
  constructor(reason, message) {
    super(message || reason)
    this.name = 'ReadSmokeContractError'
    this.code = 'READ_SMOKE_CONTRACT_INVALID'
    this.reason = reason
  }
}

function onlyAllowedKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function normalizeReadSmokeContract(input) {
  if (!isPlainObject(input)) throw new ReadSmokeContractError('not_object', 'read-smoke contract must be an object')
  // Strict top-level keys: a raw path/method/headers/body/response/credential/adapter config can never ride in.
  if (!onlyAllowedKeys(input, READ_SMOKE_CONTRACT_TOP_KEYS)) {
    throw new ReadSmokeContractError('unexpected_field', 'read-smoke contract allows only presetId, key, intent')
  }
  const preset = getReadSmokePreset(typeof input.presetId === 'string' ? input.presetId : '')
  if (!preset) throw new ReadSmokeContractError('preset_unknown', 'unknown read-smoke preset')

  const hasIntent = input.intent !== undefined
  const hasTopKey = input.key !== undefined
  let object
  let mode
  let rawKey
  if (hasIntent) {
    // Forward shape. A top-level key must not coexist with intent (ambiguous).
    if (hasTopKey) throw new ReadSmokeContractError('ambiguous_shape', 'use either { presetId, key } or { presetId, intent }, not both')
    if (!isPlainObject(input.intent)) throw new ReadSmokeContractError('intent_invalid', 'intent must be an object')
    if (!onlyAllowedKeys(input.intent, READ_SMOKE_CONTRACT_INTENT_KEYS)) {
      throw new ReadSmokeContractError('unexpected_field', 'intent allows only object, mode, key')
    }
    object = typeof input.intent.object === 'string' ? input.intent.object : ''
    mode = typeof input.intent.mode === 'string' ? input.intent.mode : ''
    rawKey = input.intent.key
  } else {
    // Shipped compat subset { presetId, key } → object/mode defaulted from the preset (same normalized output).
    object = preset.defaultObject
    mode = preset.defaultMode
    rawKey = input.key
  }
  // Allowlist object + mode against the preset (fail-closed on unknown).
  if (!Array.isArray(preset.allowedObjects) || !preset.allowedObjects.includes(object)) {
    throw new ReadSmokeContractError('object_not_allowed', 'object is not allowlisted for this preset')
  }
  if (!Array.isArray(preset.allowedModes) || !preset.allowedModes.includes(mode)) {
    throw new ReadSmokeContractError('mode_not_allowed', 'mode is not allowlisted for this preset')
  }
  if (mode === 'list') {
    if (!hasIntent) {
      throw new ReadSmokeContractError('intent_required', 'list mode requires the intent shape')
    }
    if (rawKey === undefined) {
      return { presetId: preset.presetId, object, mode }
    }
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) throw new ReadSmokeContractError('key_required', 'a non-empty key is required when supplied')
    return { presetId: preset.presetId, object, mode, key }
  }

  // Key is runtime-only and never echoed; require a non-empty string for single-record detail reads.
  const key = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!key) throw new ReadSmokeContractError('key_required', 'a non-empty key is required')

  return { presetId: preset.presetId, object, mode, key }
}

module.exports = {
  READ_SMOKE_PRESETS,
  getReadSmokePreset,
  buildReadSmokeRequest,
  applyReadSmokePresetOverlay,
  readSmokeSuccessEvidence,
  readSmokeErrorEvidence,
  ReadSmokeContractError,
  normalizeReadSmokeContract,
}
