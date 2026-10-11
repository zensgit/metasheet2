'use strict'

const {
  normalizeStockPreparationActionConfig,
  assertStockPreparationTargetReady,
  composeStockPreparationReadPlanAction,
  __internals: { assertExtFieldMappingAgreesWithAction, largeBomActionExecutionContract },
} = require('./stock-preparation-table-actions.cjs')
const { createCustomerPackCatalog } = require('./stock-preparation-customer-pack-catalog.cjs')
const { createConfiguredExtFieldMapping } = require('./stock-preparation-ext-field-mapping-config.cjs')

class StockPreparationAutomationProfileError extends Error {
  constructor() {
    super('AUTOMATION_PROFILE_INVALID')
    this.name = 'StockPreparationAutomationProfileError'
    this.code = 'AUTOMATION_PROFILE_INVALID'
  }
}
function invalid() { throw new StockPreparationAutomationProfileError() }
const profileKey = 'stockPreparationAutomationProfiles'
const unsafeMapNames = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])
const optionalActionPaths = new Set([
  ['pageLimit'], ['maxPages'], ['maxReadCount'], ['maxElapsedMs'], ['maxDepth'], ['maxRows'], ['source', 'workspaceId'],
].map(path => JSON.stringify(path)))
const omitted = Symbol('normalizer-optional')

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function objectData(value) {
  if (!plain(value)) invalid()
  return Object.fromEntries(Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || (key === 'toJSON' && typeof descriptor.value === 'function')) invalid()
    return [key, descriptor.value]
  }))
}
function exact(value, keys) {
  const captured = objectData(value)
  if (Object.keys(captured).length !== keys.length || keys.some(key => !Object.hasOwn(captured, key))) invalid()
  return captured
}
function canonicalId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value === value.trim()
    // eslint-disable-next-line no-control-regex -- Opaque deployment identifiers are exact, never trimmed into authority.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
function mapId(value) { return canonicalId(value) && !unsafeMapNames.has(value) }

// JSON capture uses descriptors, never serialization hooks. Only undefined
// produced at the existing action normalizer's known optional paths is omitted.
function cloneData(value, optionalPaths = new Set(), path = [], ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value === undefined && optionalPaths.has(JSON.stringify(path))) return omitted
  if (!value || typeof value !== 'object' || ancestors.has(value)) invalid()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) invalid()
      return Array.from({ length: value.length }, (_entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        const entry = cloneData(descriptor.value, optionalPaths, [...path, String(index)], ancestors)
        if (entry === omitted) invalid()
        return entry
      })
    }
    return Object.fromEntries(Object.entries(objectData(value)).flatMap(([key, entry]) => {
      const captured = cloneData(entry, optionalPaths, [...path, key], ancestors)
      return captured === omitted ? [] : [[key, captured]]
    }))
  } finally { ancestors.delete(value) }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function assertRawFieldMap(action) {
  if (!plain(action) || !plain(action.target) || !Object.hasOwn(action.target, 'fieldIdMap')
    || !plain(action.target.fieldIdMap)) invalid()
  const physical = new Set()
  for (const [logical, id] of Object.entries(action.target.fieldIdMap)) {
    if (!mapId(logical) || !mapId(id) || physical.has(id)) invalid()
    physical.add(id)
  }
}

function buildCatalogAndMapping(customerPacks, extFieldMappingConfig) {
  // These are captured raw JSON, never a persisted catalog or a claimed brand.
  if (!plain(customerPacks) || (extFieldMappingConfig !== null && !plain(extFieldMappingConfig))) invalid()
  const packCatalog = createCustomerPackCatalog({ packs: customerPacks })
  const extFieldMapping = createConfiguredExtFieldMapping({
    config: { stockPreparationExtFieldMapping: extFieldMappingConfig }, packCatalog,
  })
  return { packCatalog, extFieldMapping }
}

function checkedProfileAction(raw, mapping) {
  assertRawFieldMap(raw)
  const action = cloneData(assertStockPreparationTargetReady(raw), optionalActionPaths)
  const { sheetId, objectId, fieldIdMap } = action.target
  if (!canonicalId(sheetId) || !canonicalId(objectId) || !canonicalId(action.source.externalSystemId)) invalid()
  const fields = [...new Set([...action.template.fields.map(field => field.id), ...(action.extensionFieldIds || [])])]
  if (!fields.every(mapId) || (Object.keys(fieldIdMap).length && fields.some(field => !Object.hasOwn(fieldIdMap, field)))) invalid()
  assertExtFieldMappingAgreesWithAction(action, mapping)
  if (mapping && mapping.targetObjectId !== objectId) invalid()
  return action
}

/**
 * Pure private persisted-material loader. The caller must separately validate
 * the live host producer, persisted profile scope/revision and all authorization
 * prerequisites. JSON content alone supplies none of those proofs.
 *
 * Rebuild both factories from their complete raw JSON, never recover a brand or
 * executable catalog method from storage. The returned catalog's methods belong
 * to THIS invocation's real factory; its entries and the returned material are
 * detached from the input. This API performs no I/O or registration.
 */
function restoreStockPreparationAutomationProfileMaterial(input) {
  try {
    const envelope = exact(input, ['material'])
    const material = cloneData(exact(envelope.material, ['action', 'customerPacks', 'extFieldMappingConfig']))
    const { packCatalog, extFieldMapping } = buildCatalogAndMapping(material.customerPacks, material.extFieldMappingConfig)
    const action = checkedProfileAction(material.action, extFieldMapping)
    return freeze({ action, packCatalog, extFieldMapping })
  } catch { return invalid() }
}

/**
 * Pure, HOST-PRIVATE deployment-material preparation; currently no registration.
 * The host must supply ONE trusted activation's config, not request material or
 * a tenant inferred from ALS, updated_by, project/base or an existing pointer.
 * This explicit descriptor binds deployment INTENT, not live tenant membership,
 * target ownership, field metadata, install lifecycle, permissions or an epoch.
 * No source/database/env IO, writes, registry mutation or host port occurs here.
 *
 * Raw packs and mapping config remain complete JSON so a private persisted load
 * can rebuild the real catalog and branded mapping through their actual factories.
 * A JSON-deserialized mapping must never be treated as already branded. The
 * normalized action's source is the deployment DEFAULT, not a resolved pointer;
 * preparing it does not authorize fallback when a persisted source is absent.
 * Installed material and the closed target contract still require live checks.
 *
 * The legacy registry currently accepts one action kind/id. This helper follows
 * its real normalizer rather than inventing new actions, roles, deterministic
 * physical ids or a project==base relation. It never changes the manual path.
 */
function prepareStockPreparationAutomationProfiles(input) {
  try {
    const envelope = exact(input, ['config'])
    const config = objectData(envelope.config)
    if (!Object.hasOwn(config, profileKey)) return Object.freeze([])
    const descriptors = cloneData(config[profileKey])
    if (!Array.isArray(descriptors) || descriptors.length === 0 || descriptors.length > 32) invalid()
    // Same precedence as createHandlers. Capture only this feature's material;
    // unrelated host-private capabilities/config values are not inspected/copied.
    const rawActions = cloneData(config.stockPreparationTableActions || config.tableActions)
    if (!Array.isArray(rawActions) && !plain(rawActions)) invalid()
    const actions = new Map()
    for (const raw of Array.isArray(rawActions) ? rawActions : Object.values(rawActions)) {
      assertRawFieldMap(raw)
      const action = cloneData(normalizeStockPreparationActionConfig(raw), optionalActionPaths)
      if (actions.has(action.actionId)) invalid() // Never inherit the manual registry's last-wins ambiguity.
      actions.set(action.actionId, action)
    }
    const customerPacks = Object.hasOwn(config, 'stockPreparationCustomerPacks')
      ? cloneData(config.stockPreparationCustomerPacks) : {}
    const configuredMapping = Object.hasOwn(config, 'stockPreparationExtFieldMapping')
      ? cloneData(config.stockPreparationExtFieldMapping) : null
    const extFieldMappingConfig = configuredMapping === false ? null : configuredMapping
    const { extFieldMapping } = buildCatalogAndMapping(customerPacks, extFieldMappingConfig)
    const scopes = new Set()
    const sheetTenants = new Map()
    const profiles = descriptors.map(raw => {
      const descriptor = exact(raw, ['tenantId', 'workspaceId', 'projectId', 'actionId'])
      if (!canonicalId(descriptor.tenantId) || descriptor.workspaceId !== null
        || !canonicalId(descriptor.projectId) || !canonicalId(descriptor.actionId)) invalid()
      const key = JSON.stringify([descriptor.tenantId, descriptor.workspaceId, descriptor.actionId])
      if (scopes.has(key)) invalid()
      scopes.add(key)
      const selected = actions.get(descriptor.actionId)
      if (!selected) invalid()
      const action = checkedProfileAction(selected, extFieldMapping)
      const { sheetId, objectId } = action.target
      if (sheetTenants.has(sheetId) && sheetTenants.get(sheetId) !== descriptor.tenantId) invalid()
      sheetTenants.set(sheetId, descriptor.tenantId)
      return {
        ...descriptor, sheetId, objectId,
        material: { action, customerPacks: cloneData(customerPacks), extFieldMappingConfig: cloneData(extFieldMappingConfig) },
      }
    })
    return freeze(profiles)
  } catch {
    // Existing validators can include configuration content in diagnostics.
    // None of those values, cause objects or executable hooks cross this boundary.
    return invalid()
  }
}

/** Pure composition only: the host must lock and verify every supplied identity.
 * Never use the background large-BOM caps to widen an Automation preview. Missing
 * action timeouts are capped by the required finite host ceiling, not infinity.
 */
function composeStockPreparationAutomationExecution(input) {
  try {
    const envelope = exact(input, ['action', 'scope', 'active', 'systemId', 'budgetCeiling'])
    const action = cloneData(envelope.action)
    const scope = cloneData(exact(envelope.scope, ['tenantId', 'workspaceId']))
    const active = cloneData(exact(envelope.active, ['activation', 'version']))
    const ceiling = cloneData(exact(envelope.budgetCeiling, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']))
    const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647
    if (!canonicalId(scope.tenantId) || scope.workspaceId !== null || !canonicalId(envelope.systemId)
      || !plain(action.source) || action.source.kind !== 'data-source:sql-readonly'
      || (Object.hasOwn(action.source, 'workspaceId') && action.source.workspaceId !== null)
      || !Object.values(ceiling).every(positive)) invalid()
    const composed = composeStockPreparationReadPlanAction({
      action: { ...action, source: { ...action.source, externalSystemId: envelope.systemId } }, scope, ...active,
    })
    const contract = largeBomActionExecutionContract(composed)
    if (![contract.maxRows, contract.maxPages, contract.maxReadCount].every(positive)
      || (contract.maxElapsedMs !== null && !positive(contract.maxElapsedMs))) invalid()
    return freeze({ action: cloneData(composed, optionalActionPaths), budget: {
      maxRows: Math.min(ceiling.maxRows, contract.maxRows),
      maxPages: Math.min(ceiling.maxPages, contract.maxPages),
      maxReadCount: Math.min(ceiling.maxReadCount, contract.maxReadCount),
      timeoutMs: Math.min(ceiling.timeoutMs, contract.maxElapsedMs === null ? ceiling.timeoutMs : contract.maxElapsedMs),
    } })
  } catch { return invalid() }
}

module.exports = {
  composeStockPreparationAutomationExecution,
  prepareStockPreparationAutomationProfiles,
  restoreStockPreparationAutomationProfileMaterial,
  StockPreparationAutomationProfileError,
}
