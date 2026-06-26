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
  }),
})

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

module.exports = {
  READ_SMOKE_PRESETS,
  getReadSmokePreset,
  buildReadSmokeRequest,
  readSmokeSuccessEvidence,
  readSmokeErrorEvidence,
}
