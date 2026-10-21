'use strict'

const { createHash } = require('node:crypto')
const {
  assertStockPreparationTargetReady,
  __internals: { assertExtFieldMappingAgreesWithAction },
} = require('./stock-preparation-table-actions.cjs')
const { derivePackAwarePlmWritableFields } = require('./stock-preparation-conflict-planner.cjs')
const { __internals: { mapFieldName } } = require('./stock-preparation-apply-writer.cjs')
const { isNormalizedExtFieldMapping } = require('./stock-preparation-ext-field-mapping.cjs')

class StockPreparationAutomationTargetContractError extends Error {
  constructor() {
    super('AUTOMATION_TARGET_CONTRACT_INVALID')
    this.name = 'StockPreparationAutomationTargetContractError'
    this.code = 'AUTOMATION_TARGET_CONTRACT_INVALID'
  }
}

function invalid() { throw new StockPreparationAutomationTargetContractError() }
const unsafeNames = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])
const optionalActionPaths = new Set([
  ['pageLimit'], ['maxPages'], ['maxReadCount'], ['maxElapsedMs'], ['maxDepth'], ['maxRows'], ['source', 'workspaceId'],
].map(path => JSON.stringify(path)))
const omitted = Symbol('omitted-normalizer-optional')

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function exactObject(value, keys) {
  return plainObject(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    })
}
function canonicalId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value === value.trim() && !unsafeNames.has(value)
    // eslint-disable-next-line no-control-regex -- Identifiers reject embedded controls rather than trimming them away.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

// Inspect descriptors before reading values. Never invoke accessors/toJSON or
// silently erase callable, sparse, non-enumerable, non-finite or cyclic material.
function cloneData(value, optionalPaths = new Set(), path = [], seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value === undefined && optionalPaths.has(JSON.stringify(path))) return omitted
  if (typeof value !== 'object' || value === null || seen.has(value)) invalid()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) invalid()
      return Array.from({ length: value.length }, (_entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        const item = cloneData(descriptor.value, optionalPaths, [...path, String(index)], seen)
        if (item === omitted) invalid()
        return item
      })
    }
    if (!plainObject(value)) invalid()
    const entries = []
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
      const item = cloneData(descriptor.value, optionalPaths, [...path, key], seen)
      if (item !== omitted) entries.push([key, item])
    }
    return Object.fromEntries(entries)
  } finally { seen.delete(value) }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function cloneMapping(value) {
  if (value === null) return null
  if (!plainObject(value) || !Object.isFrozen(value)) invalid()
  const symbols = Object.getOwnPropertySymbols(value)
  if (symbols.length !== 1) invalid()
  const brand = Object.getOwnPropertyDescriptor(value, symbols[0])
  if (!brand || brand.value !== true || brand.enumerable || brand.writable || brand.configurable) invalid()
  const keys = Object.getOwnPropertyNames(value)
  const material = Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    return [key, descriptor.value]
  }))
  const copy = cloneData(material)
  if (!isNormalizedExtFieldMapping(value)) invalid()
  // Preserve the factory's existing private brand on a detached copy; no raw
  // mapping is normalized or promoted here. The symbol is not hash material.
  Object.defineProperty(copy, symbols[0], { value: true, enumerable: false })
  return freeze(copy)
}

/**
 * Pure HOST-PRIVATE execution-content contract, currently unwired. The caller
 * must obtain the complete action, installed-property array and mapping under
 * trusted live deployment/metadata proof. An explicit [] means the caller
 * asserts no installed candidates; this function cannot prove that assertion,
 * the array's completeness/authenticity, permissions, tenant or ownership.
 *
 * Projection contains every template field (including human/run fields), every
 * declared action extension, and both shared-classifier pack bands. Missing or
 * unclassified pack metadata rejects; there is no ext_* wildcard or silent
 * legacy fallback. Canonical installed candidates remain template-governed.
 *
 * Explicit maps must bind this whole projection and be globally injective,
 * including unused entries that the legacy inverse mapper can still observe.
 * Identity mode requires the caller's exact empty map, never omission/null or
 * malformed values silently removed by the ordinary action normalizer.
 *
 * executionKey hashes content, NOT authorization, incarnation or an ABA nonce.
 * This module reads/writes nothing, registers nothing and changes no manual path.
 */
function deriveAutomationReadTargetContract(input) {
  try {
    if (!exactObject(input, ['action', 'installedFieldProperties', 'extFieldMapping'])) invalid()
    const rawAction = cloneData(input.action, optionalActionPaths)
    if (!plainObject(rawAction) || !plainObject(rawAction.target)
      || !Object.hasOwn(rawAction.target, 'fieldIdMap') || !plainObject(rawAction.target.fieldIdMap)) invalid()
    const rawMap = rawAction.target.fieldIdMap
    const physicalBindings = new Set()
    for (const [logical, physical] of Object.entries(rawMap)) {
      if (!canonicalId(logical) || !canonicalId(physical) || physicalBindings.has(physical)) invalid()
      physicalBindings.add(physical)
    }
    if (!Array.isArray(input.installedFieldProperties)) invalid()
    const installedFieldProperties = cloneData(input.installedFieldProperties)
    const installedIds = new Set()
    for (const entry of installedFieldProperties) {
      if (!exactObject(entry, ['fieldId', 'property']) || !canonicalId(entry.fieldId)
        || !plainObject(entry.property) || installedIds.has(entry.fieldId)) invalid()
      installedIds.add(entry.fieldId)
    }
    const extFieldMapping = cloneMapping(input.extFieldMapping)
    const action = cloneData(assertStockPreparationTargetReady(rawAction), optionalActionPaths)
    assertExtFieldMappingAgreesWithAction(action, extFieldMapping)
    const classification = derivePackAwarePlmWritableFields({ templateFields: action.template.fields, installedFieldProperties })
    if (classification.unclassifiedPackFieldIds.length > 0
      || classification.reasons.some(entry => ['invalid_field_id', 'duplicate_field_id', 'not_extension_namespace'].includes(entry.reason))) invalid()
    // Declaration alone does not make a mapping writable: the installed shared
    // classifier must still place every mapped cell in the PLM-owned band.
    if (extFieldMapping && (extFieldMapping.targetObjectId !== action.target.objectId
      || extFieldMapping.targetFieldIds.some(field => !classification.packPlmWritableFieldIds.includes(field)))) invalid()
    const logicalFieldIds = [...new Set([
      ...action.template.fields.map(field => field.id), ...(action.extensionFieldIds || []),
      ...classification.packPlmWritableFieldIds, ...classification.packHumanPreservedFieldIds,
    ])].sort()
    if (logicalFieldIds.length < 2 || logicalFieldIds.length > 256 || !logicalFieldIds.every(canonicalId)
      || !logicalFieldIds.includes('projectNo') || !logicalFieldIds.includes('active')) invalid()
    const map = action.target.fieldIdMap
    const explicit = Object.keys(rawMap).length > 0
    if (explicit && logicalFieldIds.some(field => !Object.hasOwn(map, field))) invalid()
    // Also resolve every extra map key through the actual mapper: a hidden alias
    // outside the requested projection must never overwrite the inverse mapping.
    const allLogical = [...new Set([...logicalFieldIds, ...Object.keys(map)])]
    const allPhysical = allLogical.map(field => mapFieldName(field, map))
    if (!allPhysical.every(canonicalId) || new Set(allPhysical).size !== allPhysical.length) invalid()
    const projection = {
      logicalFieldIds,
      fieldIds: logicalFieldIds.map(field => mapFieldName(field, map)).sort(),
      projectFieldId: mapFieldName('projectNo', map),
      activeFieldId: mapFieldName('active', map),
    }
    const material = { action, projection, installedFieldProperties, extFieldMapping }
    const executionKey = createHash('sha256').update(canonical(material)).digest('hex')
    return freeze({ ...material, executionKey })
  } catch {
    // Existing normalizers may include config values/ids in their diagnostics.
    // The private boundary emits one fixed code and never retains their causes.
    return invalid()
  }
}

module.exports = { deriveAutomationReadTargetContract, StockPreparationAutomationTargetContractError }
