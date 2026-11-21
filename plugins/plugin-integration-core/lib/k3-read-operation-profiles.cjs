'use strict'

// The only B4 action profile admitted here is the already-reviewed material-list binding. Its config
// identity is separate from the read-smoke preset id; no new endpoint, credential, or permission is minted.
const { isDeepStrictEqual } = require('node:util')
const {
  K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION,
  K3WISE_MATERIAL_LIST_PRESET_ID,
  K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION,
  K3WISE_MATERIAL_LIST_B4_TEMPLATE,
} = require('./read-source-k3-material-list-b4-contract.cjs')
const { READ_SMOKE_PRESETS, applyReadSmokePresetOverlay } = require('./read-smoke.cjs')

// Derived from the already-pinned projection and the one explicit mapping; no second column allowlist.
const B4_INTAKE_ALIAS_FIELDS = Object.freeze(K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION.filter(
  (field) => !K3WISE_MATERIAL_LIST_B4_TEMPLATE.fieldMap.some((entry) => entry.source === field),
))
const RESPONSE_UNRECOGNIZED = 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED'
const CONTAINER_NOT_FOUND = 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'
const SHAPE_MISMATCH = 'READ_SOURCE_PROBE_SHAPE_MISMATCH'
const CAP_REACHED = 'READ_SOURCE_PROBE_CAP_REACHED'

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownData(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor
    ? { present: true, valid: Object.prototype.hasOwnProperty.call(descriptor, 'value'), value: descriptor.value }
    : { present: false, valid: true, value: undefined }
}

function safeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function aliasInteger(container, names) {
  let found = false
  let number = null
  for (const name of names) {
    const entry = ownData(container, name)
    if (!entry.present) continue
    if (!entry.valid) return { valid: false, present: true, value: null }
    const parsed = safeInteger(entry.value)
    if (parsed === null || (found && parsed !== number)) return { valid: false, present: true, value: null }
    found = true
    number = parsed
  }
  return { valid: true, present: found, value: number }
}

// B4's adapter list reader has generic compatibility fallbacks (Data.data/Data.Data and filtering of
// malformed array members). Those are not part of the reviewed B4 Data.DATA contract. Check the UNSLICED
// raw response before either configured-read row plane or the probe can report success. All refusals are
// already registered coarse codes; no upstream value or message is copied into evidence.
function b4MaterialListResponseViolation(result, request) {
  const raw = result && result.raw
  if (!isPlainRecord(raw)) return RESPONSE_UNRECOGNIZED
  for (const name of ['StatusCode', 'statusCode']) {
    const status = ownData(raw, name)
    if (!status.present) continue
    const parsed = status.valid ? safeInteger(status.value) : null
    if (parsed === null || parsed < 200 || parsed >= 300) return RESPONSE_UNRECOGNIZED
  }
  const data = ownData(raw, 'Data')
  if (!data.present) return CONTAINER_NOT_FOUND
  if (!data.valid || !isPlainRecord(data.value)) return SHAPE_MISMATCH
  const rows = ownData(data.value, 'DATA')
  if (!rows.present) return CONTAINER_NOT_FOUND
  if (!rows.valid || !Array.isArray(rows.value)) return SHAPE_MISMATCH
  // Check the entire array before checking the cap: a malformed element beyond the adapter's slice
  // must not disappear from the quality verdict.
  for (let index = 0; index < rows.value.length; index += 1) {
    const entry = ownData(rows.value, String(index))
    if (!entry.present || !entry.valid || !isPlainRecord(entry.value)) return SHAPE_MISMATCH
  }
  if (!Number.isSafeInteger(request?.limit) || request.limit < 1 || rows.value.length > request.limit) return CAP_REACHED
  // The adapter's normalized record plane and the raw reviewed projection must agree. Compare only the
  // five pinned B4 fields, never promote arbitrary row members into the data plane.
  if (!Array.isArray(result.records) || result.records.length !== rows.value.length) return SHAPE_MISMATCH
  for (let index = 0; index < rows.value.length; index += 1) {
    const record = result.records[index]
    if (!isPlainRecord(record)) return SHAPE_MISMATCH
    for (const field of K3WISE_MATERIAL_LIST_EXPECTED_PROJECTION) {
      const rawField = ownData(rows.value[index], field)
      const recordField = ownData(record, field)
      if (!rawField.valid || !recordField.valid || rawField.present !== recordField.present
        || (rawField.present && !isDeepStrictEqual(rawField.value, recordField.value))) return SHAPE_MISMATCH
    }
  }

  const pageIndex = aliasInteger(data.value, ['PAGEINDEX', 'pageIndex', 'PageIndex'])
  const pageSize = aliasInteger(data.value, ['PAGESIZE', 'pageSize', 'PageSize'])
  const rowCount = aliasInteger(data.value, ['ROWCOUNT', 'rowCount', 'RowCount'])
  if (!pageIndex.valid || !pageSize.valid || !rowCount.valid) return RESPONSE_UNRECOGNIZED
  const requestedPage = typeof request?.options?.listPageIndex === 'number' ? request.options.listPageIndex : 1
  if (pageIndex.present && (pageIndex.value < 1 || pageIndex.value > 10 || pageIndex.value !== requestedPage)) {
    return RESPONSE_UNRECOGNIZED
  }
  if (pageSize.present && (pageSize.value < 1 || pageSize.value > request.limit || rows.value.length > pageSize.value)) {
    return RESPONSE_UNRECOGNIZED
  }
  if (rowCount.present && rowCount.value < rows.value.length) return RESPONSE_UNRECOGNIZED
  return null
}

function projectB4MaterialListRow(row, fieldMap, mapRecord, resolvedCounts) {
  const projected = {}
  for (const field of B4_INTAKE_ALIAS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) projected[field] = row[field]
  }
  const mapped = mapRecord(row, fieldMap, resolvedCounts)
  for (const [target, value] of Object.entries(mapped)) projected[target] = value
  return projected
}

function isB4ReadOperationProfile(value) {
  return value === K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION
}

// Compare all effective config fields; store-assigned version and local systemId are the only variants.
// The caller must first pass the ordinary S1 validator/normalizer. Never return offending values.
function b4ReadOperationProfileViolation(normalizedConfig) {
  if (!isB4ReadOperationProfile(normalizedConfig.actionProfileVersion)) return null
  const omitLocalIdentity = ({ version: _version, systemId: _systemId, ...rest }) => rest
  return isDeepStrictEqual(
    omitLocalIdentity(normalizedConfig),
    omitLocalIdentity(K3WISE_MATERIAL_LIST_B4_TEMPLATE),
  ) ? null : 'config_drift'
}

// Generic read-smoke overlay is intentionally shallow for historical callers. B4 needs a new material
// object made ONLY from the reviewed preset, so no stored Fields/Filter/body/pagination key survives.
function buildB4ReadOperationSystem(system) {
  const currentConfig = system.config && typeof system.config === 'object' ? system.config : {}
  const currentObjects = currentConfig.objects && typeof currentConfig.objects === 'object'
    ? currentConfig.objects : {}
  const presetObject = READ_SMOKE_PRESETS[K3WISE_MATERIAL_LIST_PRESET_ID].readConfigOverlay.objects.material
  const cleanMaterial = {
    ...presetObject,
    operations: [...presetObject.operations],
    readListBodyTemplate: { Data: { ...presetObject.readListBodyTemplate.Data } },
    readListFields: [...presetObject.readListFields],
  }
  return {
    ...system,
    config: {
      ...currentConfig,
      objects: { ...currentObjects, material: cleanMaterial },
    },
  }
}

function applyReadOperationProfileOverlay(system, plan, genericPreset) {
  return isB4ReadOperationProfile(plan.actionProfileVersion)
    ? buildB4ReadOperationSystem(system)
    : applyReadSmokePresetOverlay(system, genericPreset)
}

module.exports = {
  isB4ReadOperationProfile,
  b4ReadOperationProfileViolation,
  buildB4ReadOperationSystem,
  applyReadOperationProfileOverlay,
  b4MaterialListResponseViolation,
  projectB4MaterialListRow,
}
