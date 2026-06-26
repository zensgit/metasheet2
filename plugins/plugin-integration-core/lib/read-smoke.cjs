'use strict'

// #1709 follow-up: generic read-smoke preset catalog + values-free evidence helpers.
// v1 registers ONLY built-in presets — there is no user/request-supplied preset path. The route reads only
// { presetId, key } from the request; the preset (kind/object/read shape) comes from THIS frozen catalog,
// never the request. Read-only: builds a forced single-record read; no list / pagination / cursor /
// watermark / BOM; no Save / Submit / Audit. Evidence is values-free (booleans / counts / coarse enums only)
// — never the key, raw payload, material values, host, token, credentials, or connection string.

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
})

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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

// Forced single-record read request. Single explicit key only — no list/pagination/cursor/watermark/BOM.
function buildReadSmokeRequest(preset, key) {
  return { object: preset.object, filters: { FNumber: key } }
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

// Values-free evidence from a successful read. Extracts ONLY recordPresent (boolean) + referenceObjectCount
// (count) from the result's records — never the record values, metadata (which carries the key as
// requestedNumber + a readPath), or raw payload.
function readSmokeSuccessEvidence(preset, result) {
  const records = result && Array.isArray(result.records) ? result.records : []
  const recordPresent = records.length > 0
  let referenceObjectCount = 0
  if (recordPresent) {
    const refs = records[0] && records[0]._k3ReferenceObjects
    referenceObjectCount = refs && typeof refs === 'object' ? Object.keys(refs).length : 0
  }
  return {
    ok: true,
    presetId: preset.presetId,
    object: preset.object,
    recordPresent,
    referenceObjectCount,
  }
}

// Values-free error evidence. Returns ONLY a coarse code + type — never the error message, which may carry
// the key or material values.
function readSmokeErrorEvidence(preset, error) {
  // Use the error's own enum-like code + name only (both values-free). Never fall back to constructor.name
  // (a plain thrown object would surface 'Object', which is noise) and never read the message.
  const code = error && typeof error.code === 'string' && error.code ? error.code : null
  const name = error && typeof error.name === 'string' && error.name ? error.name : null
  return {
    ok: false,
    presetId: preset.presetId,
    object: preset.object,
    errorCode: code || 'READ_SMOKE_READ_FAILED',
    errorType: name || 'Error',
  }
}

// C1 contract normalizer (#1709 / C0 #3242). Reconciles the forward-looking
// { presetId, intent:{ object, mode, key } } shape with the shipped read-smoke { presetId, key } subset by
// normalizing BOTH to one output { presetId, object, mode, key }. Pure contract: it does NOT call K3, does
// NOT touch the route, and opens no LIST/BOM/runtime. Fail-closed + values-free: a raw path/method/headers/
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
  // Key is runtime-only and never echoed; require a non-empty string.
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
