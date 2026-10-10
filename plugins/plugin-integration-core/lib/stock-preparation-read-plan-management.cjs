'use strict'

// SA02 tenant-only management. The HTTP factory is the identity boundary: it
// combines the existing admin gate with a verified JWT tenant and host principal.
// This service is private to that wiring, never a cross-plugin capability. Every
// entry rechecks the CURRENT canonical Connection owner through metadata only.
// Validation reads only occur on the explicit validate operation. The ledger
// independently fences source revisions/ownership with mutation + audit, so a
// stale request-time metadata check cannot authorize approval or activation.
const { PLM_STOCK_PREPARATION_ACTION_ID: ACTION_ID } = require('./stock-preparation-source-binding.cjs')
const { DEFAULT_SQL_CONNECTION_TYPES } = require('./connection-resolver.cjs')
const { validateStockPreparationReadPlanConfig, StockPreparationReadPlanConfigError } = require('./stock-preparation-read-plan-config.cjs')
const { StockPreparationReadPlanStoreError } = require('./stock-preparation-read-plan-store.cjs')
const { StockPreparationReadPlanValidationReadError } = require('./stock-preparation-read-plan-validation-read.cjs')
const { B2aReadAuthorizationError, B2A_ERROR_CODES } = require('./b2a-trial-registry.cjs')

const BASE_PATH = '/api/integration/stock-preparation/read-plan-configs'
const READ_PLAN_MANAGEMENT_ROUTES = Object.freeze([
  ['GET', BASE_PATH, 'stockPreparationReadPlanConfigsList'],
  ['POST', BASE_PATH, 'stockPreparationReadPlanConfigsSave'],
  ['POST', `${BASE_PATH}/deactivate`, 'stockPreparationReadPlanConfigsDeactivate'],
  ['POST', `${BASE_PATH}/:id/validate`, 'stockPreparationReadPlanConfigsValidate'],
  ['POST', `${BASE_PATH}/:id/confirm-sample`, 'stockPreparationReadPlanConfigsConfirmSample'],
  ['POST', `${BASE_PATH}/:id/approve`, 'stockPreparationReadPlanConfigsApprove'],
  ['POST', `${BASE_PATH}/:id/retire`, 'stockPreparationReadPlanConfigsRetire'],
  ['POST', `${BASE_PATH}/:id/activate`, 'stockPreparationReadPlanConfigsActivate'],
].map(Object.freeze))
const STORE_ERROR_CODES = new Set([
  'READ_PLAN_SCOPE_INVALID', 'READ_PLAN_ACTOR_INVALID', 'READ_PLAN_GENERATION_INVALID',
  'READ_PLAN_ACTIVATION_INVALID', 'READ_PLAN_CONTENT_INVALID', 'READ_PLAN_AUDIT_INVALID',
  'READ_PLAN_TRANSACTION_UNAVAILABLE', 'READ_PLAN_AUDIT_FAILED', 'READ_PLAN_SOURCE_INELIGIBLE',
  'READ_PLAN_CONTENT_RETIRED', 'READ_PLAN_VERSION_EXHAUSTED', 'READ_PLAN_WRITE_FAILED',
  'READ_PLAN_MINT_CONFLICT', 'READ_PLAN_PAGE_INVALID', 'READ_PLAN_FILTER_INVALID',
  'READ_PLAN_NOT_FOUND', 'READ_PLAN_STATUS_CONFLICT', 'READ_PLAN_NOT_APPROVED',
  'READ_PLAN_GENERATION_CONFLICT', 'READ_PLAN_GENERATION_EXHAUSTED',
  'READ_PLAN_ACTIVATION_NOT_FOUND', 'READ_PLAN_ACTIVATION_DISABLED',
  'READ_PLAN_ACTIVATION_SOURCE_MISMATCH',
  'READ_PLAN_VALIDATION_ACTOR_MISMATCH', 'READ_PLAN_VALIDATION_COUNTS_INVALID',
  'READ_PLAN_VALIDATION_EXPIRED', 'READ_PLAN_VALIDATION_INVALID', 'READ_PLAN_VALIDATION_REQUIRED',
  'READ_PLAN_VALIDATION_SOURCE_CHANGED', 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE',
  'READ_PLAN_VALIDATION_STATUS_CONFLICT', 'READ_PLAN_VALIDATION_SUPERSEDED',
  'READ_PLAN_VALIDATION_UNAVAILABLE', 'READ_PLAN_VALIDATION_WRITE_FAILED',
  'READ_PLAN_VALIDATION_IN_PROGRESS',
])

class StockPreparationReadPlanManagementError extends Error {
  constructor(status, code) {
    super(code)
    this.name = 'StockPreparationReadPlanManagementError'
    this.status = status
    this.code = code
  }
}
function fail(status, code) { throw new StockPreparationReadPlanManagementError(status, code) }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function exactKeys(value, keys) {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(400, 'READ_PLAN_REQUEST_INVALID')
}
function handle(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail(400, 'READ_PLAN_HANDLE_INVALID')
  return value
}
function identityOf(identity) {
  if (!identity || identity.workspaceId !== null || typeof identity.tenantId !== 'string'
    || !identity.tenantId.trim() || typeof identity.actor !== 'string' || !identity.actor.trim()) {
    fail(403, 'READ_PLAN_IDENTITY_REQUIRED')
  }
  return { tenantId: identity.tenantId.trim(), workspaceId: null, actor: identity.actor.trim() }
}
function generationOf(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) fail(400, 'READ_PLAN_GENERATION_INVALID')
  return value
}
function checkedFamily(row, identity, systemId) {
  if (!row || row.tenantId !== identity.tenantId || row.workspaceId !== null
    || row.actionId !== ACTION_ID || row.systemId !== systemId) fail(404, 'READ_PLAN_NOT_FOUND')
  return row
}

function createStockPreparationReadPlanManagement({ store, externalSystemRegistry, connectionRegistration } = {}) {
  function requireDependencies() {
    if (!store || ['saveVersion', 'list', 'get', 'approve', 'retire', 'getActivation', 'activate', 'deactivate']
      .some((key) => typeof store[key] !== 'function')
      || !externalSystemRegistry || typeof externalSystemRegistry.getExternalSystem !== 'function'
      || !connectionRegistration || typeof connectionRegistration.resolveConnectionRegistration !== 'function') {
      fail(501, 'READ_PLAN_MANAGEMENT_UNAVAILABLE')
    }
  }
  async function authorizeSource(identity, systemId, requireActive) {
    requireDependencies()
    handle(systemId)
    let system
    try {
      system = await externalSystemRegistry.getExternalSystem({ tenantId: identity.tenantId, workspaceId: null, id: systemId })
    } catch (_error) { fail(403, 'READ_PLAN_SOURCE_UNAVAILABLE') }
    if (!system || system.id !== systemId || system.tenantId !== identity.tenantId || system.workspaceId !== null
      || system.kind !== 'data-source:sql-readonly' || !['source', 'bidirectional'].includes(system.role)
      || !['active', 'inactive'].includes(system.status) || (requireActive && system.status !== 'active')
      || typeof system.connectionId !== 'string' || !system.connectionId.trim()) {
      fail(403, 'READ_PLAN_SOURCE_UNAVAILABLE')
    }
    const connectionId = system.connectionId
    // A conflicting rollback pointer is not a second authorization route.
    const legacyPointer = record(system.config) ? system.config.dataSourceId : undefined
    if (legacyPointer != null && legacyPointer !== connectionId) fail(403, 'READ_PLAN_SOURCE_UNAVAILABLE')
    let registration
    try {
      registration = await connectionRegistration.resolveConnectionRegistration(connectionId, {
        tenantId: identity.tenantId, workspaceId: null, principal: identity.actor, runAs: 'user',
      })
    } catch (_error) { fail(403, 'READ_PLAN_SOURCE_UNAVAILABLE') }
    // The host's generic facade permits owner-run tenant-null legacy rows. SA02
    // deliberately does not inherit that compatibility, nor workspace sharing.
    if (!registration || registration.id !== connectionId || registration.tenantId !== identity.tenantId
      || registration.scopeKind !== 'private' || typeof registration.type !== 'string'
      || !DEFAULT_SQL_CONNECTION_TYPES.has(registration.type.toLowerCase())) {
      fail(403, 'READ_PLAN_SOURCE_UNAVAILABLE')
    }
    return { system, registration }
  }
  async function loadVersion(identity, systemId, id) {
    const version = await store.get({ ...identity, id: handle(id) })
    if (!version || version.id !== id) fail(404, 'READ_PLAN_NOT_FOUND')
    return checkedFamily(version, identity, systemId)
  }
  async function activationOf(identity) {
    const activation = await store.getActivation({ ...identity, actionId: ACTION_ID })
    if (activation && (activation.tenantId !== identity.tenantId || activation.workspaceId !== null
      || activation.actionId !== ACTION_ID)) fail(409, 'READ_PLAN_ACTIVATION_INVALID')
    return activation
  }
  async function list(identityInput, { systemId } = {}) {
    const identity = identityOf(identityInput)
    await authorizeSource(identity, systemId, false)
    // Family-scoped before loading config: never list a tenant then filter owners.
    const versions = await store.list({ scope: identity, systemId, actionId: ACTION_ID, limit: 100 })
    for (const version of versions) checkedFamily(version, identity, systemId)
    const activation = await activationOf(identity)
    // The one action pointer may belong to a different system. Its owner must
    // also authorize disclosure; returning null would invent a generation of 0.
    if (activation && activation.systemId !== systemId) await authorizeSource(identity, activation.systemId, false)
    if (typeof store.getValidation !== 'function') fail(501, 'READ_PLAN_VALIDATION_UNAVAILABLE')
    const decorated = await Promise.all(versions.map(async (version) => ({ ...version,
      validation: await store.getValidation({ ...identity, id: version.id }),
    })))
    return { versions: decorated, activation }
  }
  async function save(identityInput, { config } = {}) {
    const identity = identityOf(identityInput)
    const normalized = validateStockPreparationReadPlanConfig(config)
    await authorizeSource(identity, normalized.systemId, true)
    return store.saveVersion({ ...identity, config: normalized })
  }
  function validationSource(registration) {
    if (!['postgres', 'postgresql', 'sqlserver'].includes(registration.type.toLowerCase())
      || typeof registration.validationRevision !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(registration.validationRevision)) {
      fail(409, 'READ_PLAN_VALIDATION_SOURCE_UNAVAILABLE')
    }
    return { connectionId: registration.id, connectionRevision: registration.validationRevision }
  }
  async function validate(identityInput, { systemId, id, projectNo } = {}, readSample) {
    const identity = identityOf(identityInput)
    const { registration } = await authorizeSource(identity, systemId, true)
    const source = validationSource(registration)
    const version = await loadVersion(identity, systemId, id)
    if (typeof readSample !== 'function'
      || ['beginValidation', 'finishValidation', 'failValidation'].some((key) => typeof store[key] !== 'function')) {
      fail(501, 'READ_PLAN_VALIDATION_UNAVAILABLE')
    }
    if (typeof projectNo !== 'string' || !projectNo.trim() || projectNo.trim().length > 128
      || /[\u0000-\u001f\u007f]/.test(projectNo)) fail(400, 'READ_PLAN_REQUEST_INVALID')
    // Begin BEFORE resolving/reading the source; a concurrent source edit (even
    // change-and-restore) then invalidates finish, without holding DB locks over IO.
    const attempt = await store.beginValidation({ ...identity, id, source })
    try {
      const result = await readSample({ identity, version, registration, projectNo: projectNo.trim() })
      if (!result || result.status !== 'sample_ready' || result.canApply !== false
        || result.tokenIssued !== false || result.authorizesExecution !== false) fail(409, 'READ_PLAN_VALIDATION_INCOMPLETE')
      const { sampleCount, readCount, objectCount } = result.evidence || {}
      const validation = await store.finishValidation({ ...identity, id,
        validationId: attempt.validationId, source, counts: { sampleCount, readCount, objectCount } })
      // Sample values are transient authorized response data, never ledger/audit.
      return { validation, sample: result.sample, catalog: result.catalog,
        canApply: false, tokenIssued: false, authorizesExecution: false }
    } catch (error) {
      try { await store.failValidation({ ...identity, id, validationId: attempt.validationId }) } catch (_error) {
        // A failed/stale pending attempt cannot satisfy any gate even if marking
        // it failed loses a concurrent CAS or the metadata DB is unavailable.
      }
      throw error
    }
  }
  async function confirmSample(identityInput, { systemId, id, validationId } = {}) {
    const identity = identityOf(identityInput)
    const { registration } = await authorizeSource(identity, systemId, true)
    const source = validationSource(registration)
    await loadVersion(identity, systemId, id)
    if (typeof store.confirmValidation !== 'function') fail(501, 'READ_PLAN_VALIDATION_UNAVAILABLE')
    return store.confirmValidation({ ...identity, id, validationId: handle(validationId), source })
  }
  async function transition(name, identityInput, { systemId, id } = {}) {
    const identity = identityOf(identityInput)
    await authorizeSource(identity, systemId, name === 'approve')
    await loadVersion(identity, systemId, id)
    return store[name]({ ...identity, id })
  }
  async function activate(identityInput, { systemId, id, expectedGeneration } = {}) {
    const identity = identityOf(identityInput)
    const generation = generationOf(expectedGeneration)
    await authorizeSource(identity, systemId, true)
    await loadVersion(identity, systemId, id)
    const current = await activationOf(identity)
    if ((current ? current.generation : 0) !== generation) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
    if (current && current.systemId !== systemId) await authorizeSource(identity, current.systemId, false)
    // The store repeats the generation comparison while holding its pointer lock.
    return store.activate({ ...identity, id, expectedGeneration: generation })
  }
  async function deactivate(identityInput, { systemId, expectedGeneration } = {}) {
    const identity = identityOf(identityInput)
    const generation = generationOf(expectedGeneration)
    await authorizeSource(identity, systemId, false)
    const current = await activationOf(identity)
    if (!current) fail(404, 'READ_PLAN_ACTIVATION_NOT_FOUND')
    if (current.systemId !== systemId) fail(409, 'READ_PLAN_ACTIVATION_SOURCE_MISMATCH')
    if (current.generation !== generation) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
    return store.deactivate({ ...identity, actionId: ACTION_ID, expectedGeneration: generation })
  }
  return Object.freeze({ list, save, approve: (identity, input) => transition('approve', identity, input),
    retire: (identity, input) => transition('retire', identity, input), activate, deactivate, validate, confirmSample })
}

function createStockPreparationReadPlanManagementHandlers({ management, readSample, helpers } = {}) {
  const { requireAccess, resolveVerifiedClaimTenantId, requestPrincipal, requestBody, requestQuery,
    requestParams, sendOk, HttpRouteError } = helpers || {}
  if ([requireAccess, resolveVerifiedClaimTenantId, requestPrincipal, requestBody, requestQuery,
    requestParams, sendOk, HttpRouteError].some((entry) => typeof entry !== 'function')) {
    throw new Error('read-plan management requires authenticated route helpers')
  }
  function mapError(error) {
    if (error instanceof StockPreparationReadPlanManagementError) return new HttpRouteError(error.status, error.code, error.code)
    if (error instanceof StockPreparationReadPlanConfigError) return new HttpRouteError(400, 'READ_PLAN_CONFIG_INVALID', 'READ_PLAN_CONFIG_INVALID')
    if (error instanceof StockPreparationReadPlanValidationReadError) return new HttpRouteError(error.status, error.code, error.code)
    if (error instanceof B2aReadAuthorizationError && B2A_ERROR_CODES.includes(error.code)) {
      return new HttpRouteError(error.status, error.code, error.code)
    }
    if (error instanceof StockPreparationReadPlanStoreError && STORE_ERROR_CODES.has(error.code)) {
      return new HttpRouteError(error.status, error.code, error.code)
    }
    return new HttpRouteError(500, 'READ_PLAN_MANAGEMENT_FAILED', 'READ_PLAN_MANAGEMENT_FAILED')
  }
  function handler(method, keys, { read = false, version = false } = {}) {
    return async (req, res) => {
      requireAccess(req, 'admin')
      const tenantId = resolveVerifiedClaimTenantId(req)
      const actor = requestPrincipal(req)
      try {
        const body = requestBody(req)
        const query = requestQuery(req)
        const params = requestParams(req)
        if ((req.body != null && !record(req.body)) || (req.query != null && !record(req.query))) fail(400, 'READ_PLAN_REQUEST_INVALID')
        exactKeys(body, read ? [] : ['managementScope', ...keys])
        exactKeys(query, read ? ['managementScope', ...keys] : [])
        exactKeys(params, version ? ['id'] : [])
        if (req.headers && (req.headers['x-workspace-id'] != null || req.headers['x-workspaceid'] != null)) {
          fail(400, 'READ_PLAN_REQUEST_INVALID')
        }
        const input = read ? query : body
        if (input.managementScope !== 'tenant') fail(400, 'READ_PLAN_MANAGEMENT_SCOPE_REQUIRED')
        const identity = identityOf({ tenantId, workspaceId: null, actor })
        if (!management || typeof management[method] !== 'function') fail(501, 'READ_PLAN_MANAGEMENT_UNAVAILABLE')
        const dto = Object.fromEntries(keys.map((key) => [key, input[key]]))
        if (version) dto.id = handle(params.id)
        const result = await management[method](identity, dto, method === 'validate' ? readSample : undefined)
        return sendOk(res, result, method === 'save' ? 201 : 200)
      } catch (error) { throw mapError(error) }
    }
  }
  return Object.freeze({
    stockPreparationReadPlanConfigsList: handler('list', ['systemId'], { read: true }),
    stockPreparationReadPlanConfigsSave: handler('save', ['config']),
    stockPreparationReadPlanConfigsValidate: handler('validate', ['systemId', 'projectNo'], { version: true }),
    stockPreparationReadPlanConfigsConfirmSample: handler('confirmSample', ['systemId', 'validationId'], { version: true }),
    stockPreparationReadPlanConfigsApprove: handler('approve', ['systemId'], { version: true }),
    stockPreparationReadPlanConfigsRetire: handler('retire', ['systemId'], { version: true }),
    stockPreparationReadPlanConfigsActivate: handler('activate', ['systemId', 'expectedGeneration'], { version: true }),
    stockPreparationReadPlanConfigsDeactivate: handler('deactivate', ['systemId', 'expectedGeneration']),
  })
}

module.exports = { READ_PLAN_MANAGEMENT_ROUTES, StockPreparationReadPlanManagementError,
  createStockPreparationReadPlanManagement, createStockPreparationReadPlanManagementHandlers }
