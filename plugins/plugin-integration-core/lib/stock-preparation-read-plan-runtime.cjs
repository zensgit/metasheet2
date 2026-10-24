'use strict'

const {
  composeStockPreparationReadPlanAction,
  assertLargeBomActionExecutionContract,
} = require('./stock-preparation-table-actions.cjs')
const { StockPreparationReadPlanStoreError } = require('./stock-preparation-read-plan-store.cjs')
const { sameSourceProject } = require('./stock-preparation-source-value-semantics.cjs')

class StockPreparationReadPlanRuntimeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

// No cache and no catch-to-legacy path. Only the store's explicit null means
// this exact binding scope has never acquired an activation pointer.
async function readActiveStockPreparationReadPlan(store, scope) {
  if (!store || typeof store.getActiveForRuntime !== 'function') {
    throw new StockPreparationReadPlanRuntimeError(501, 'READ_PLAN_RUNTIME_UNAVAILABLE')
  }
  try { return await store.getActiveForRuntime(scope) } catch (error) {
    if (error instanceof StockPreparationReadPlanStoreError) throw error
    throw new StockPreparationReadPlanRuntimeError(503, 'READ_PLAN_RUNTIME_UNAVAILABLE')
  }
}

const PROJECT_IDENTITY_MAX_ROWS = 1000
const PROJECT_IDENTITY_UNAVAILABLE = 'READ_PLAN_PROJECT_IDENTITY_UNAVAILABLE'
const PROJECT_TARGET_REQUIRED = 'READ_PLAN_PROJECT_TARGET_REQUIRED'
const PROJECT_IDENTITY_AMBIGUOUS = 'READ_PLAN_PROJECT_IDENTITY_AMBIGUOUS'

const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isCanonicalText = (value) => typeof value === 'string' && value.length > 0 && value === value.trim()

// Registry I/O never leaks its own error text: the typed code is the whole message.
async function readProjectRegistry(read) {
  try { return await read() } catch (_error) {
    throw new StockPreparationReadPlanRuntimeError(503, PROJECT_IDENTITY_UNAVAILABLE)
  }
}

// sourceProjectComparison === 'case-insensitive' lets a source spelling differ from the registered project,
// so the registered project must be the ONLY member of its case-insensitive group in this tenant's registry
// (archived rows included). Rechecked per execution; this is not an atomic registration constraint.
// The project number is compared, never rewritten.
async function assertCaseInsensitiveProjectIdentity({ action, bindingScope, verifyTenant, projectNo, projectTargetStore }) {
  const { tenantId } = bindingScope
  if (typeof verifyTenant !== 'function' || verifyTenant() !== tenantId) {
    throw new StockPreparationReadPlanRuntimeError(403, 'READ_PLAN_EXECUTION_TENANT_MISMATCH')
  }
  if (!projectTargetStore || ['get', 'list', 'count'].some((name) => typeof projectTargetStore[name] !== 'function')) {
    throw new StockPreparationReadPlanRuntimeError(501, PROJECT_IDENTITY_UNAVAILABLE)
  }
  const marker = action.projectTarget
  if (!isCanonicalText(projectNo) || !isPlainRecord(marker) || marker.projectNo !== projectNo
    || (marker.status !== 'active' && marker.status !== 'archived') || !isPlainRecord(action.target)) {
    throw new StockPreparationReadPlanRuntimeError(409, PROJECT_TARGET_REQUIRED)
  }
  const countBefore = await readProjectRegistry(() => projectTargetStore.count({ tenantId }))
  if (!Number.isSafeInteger(countBefore) || countBefore < 0 || countBefore > PROJECT_IDENTITY_MAX_ROWS) {
    throw new StockPreparationReadPlanRuntimeError(503, PROJECT_IDENTITY_UNAVAILABLE)
  }
  const row = await readProjectRegistry(() => projectTargetStore.get({ tenantId, projectNo }))
  const rows = await readProjectRegistry(() => projectTargetStore.list({ tenantId }))
  const countAfter = await readProjectRegistry(() => projectTargetStore.count({ tenantId }))
  const wellFormed = (candidate) => isPlainRecord(candidate) && candidate.tenantId === tenantId
    && isCanonicalText(candidate.projectNo) && isCanonicalText(candidate.sheetId)
    && isCanonicalText(candidate.objectId) && ['active', 'archived'].includes(candidate.status)
  if (countAfter !== countBefore || !Array.isArray(rows) || rows.length !== countBefore
    || !rows.every(wellFormed) || (row !== null && !wellFormed(row))) {
    throw new StockPreparationReadPlanRuntimeError(503, PROJECT_IDENTITY_UNAVAILABLE)
  }
  if (row === null || row.projectNo !== projectNo || row.sheetId !== action.target.sheetId
    || row.objectId !== action.target.objectId || row.status !== marker.status) {
    throw new StockPreparationReadPlanRuntimeError(409, PROJECT_TARGET_REQUIRED)
  }
  let group
  try { group = rows.filter((candidate) => sameSourceProject(candidate.projectNo, projectNo, 'case-insensitive')) } catch (_error) {
    throw new StockPreparationReadPlanRuntimeError(503, PROJECT_IDENTITY_UNAVAILABLE)
  }
  if (group.length > 1) throw new StockPreparationReadPlanRuntimeError(409, PROJECT_IDENTITY_AMBIGUOUS)
  const [only] = group
  if (!only || only.projectNo !== projectNo || only.sheetId !== row.sheetId
    || only.objectId !== row.objectId || only.status !== row.status) {
    throw new StockPreparationReadPlanRuntimeError(503, PROJECT_IDENTITY_UNAVAILABLE)
  }
}

async function resolveStockPreparationReadPlanExecution({ resolved, store, snapshotAction, verifyTenant, projectNo, projectTargetStore, projectIdentityRequired = true } = {}) {
  const { action, bindingScope, sourceScope } = resolved
  if (!bindingScope || !bindingScope.tenantId || bindingScope.workspaceId === undefined) {
    throw new StockPreparationReadPlanRuntimeError(409, 'READ_PLAN_BINDING_SCOPE_INVALID')
  }
  const active = await readActiveStockPreparationReadPlan(store, {
    ...bindingScope, actionId: action.actionId, systemId: action.source.externalSystemId,
    ...(snapshotAction && snapshotAction.readPlanExecutionIdentity
      ? { expectedGeneration: snapshotAction.readPlanExecutionIdentity.generation } : {}),
  })
  let effective = action
  let sourceValidation = null
  if (active !== null) {
    if (!active || typeof verifyTenant !== 'function' || verifyTenant() !== bindingScope.tenantId) {
      throw new StockPreparationReadPlanRuntimeError(403, 'READ_PLAN_EXECUTION_TENANT_MISMATCH')
    }
    if (!sourceScope || sourceScope.tenantId !== bindingScope.tenantId || sourceScope.workspaceId !== bindingScope.workspaceId) {
      throw new StockPreparationReadPlanRuntimeError(409, 'READ_PLAN_EXECUTION_SCOPE_MISMATCH')
    }
    if (!active.sourceValidation || typeof active.sourceValidation.connectionId !== 'string'
      || typeof active.sourceValidation.connectionRevision !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(active.sourceValidation.connectionRevision)
      || typeof active.sourceValidation.bindingRevision !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(active.sourceValidation.bindingRevision)) {
      throw new StockPreparationReadPlanRuntimeError(409, 'READ_PLAN_VALIDATION_SOURCE_UNAVAILABLE')
    }
    sourceValidation = active.sourceValidation
    effective = composeStockPreparationReadPlanAction({ action, scope: bindingScope, ...active })
  } else if (action.readPlanExecutionIdentity || (snapshotAction && snapshotAction.readPlanExecutionIdentity)) {
    throw new StockPreparationReadPlanRuntimeError(409, 'READ_PLAN_ACTIVATION_MISSING')
  }
  const effectiveReadPlan = effective.source && effective.source.readPlan
  if (projectIdentityRequired !== false && effectiveReadPlan && effectiveReadPlan.sourceProjectComparison === 'case-insensitive') {
    await assertCaseInsensitiveProjectIdentity({ action: effective, bindingScope, verifyTenant, projectNo, projectTargetStore })
  }
  if (snapshotAction) assertLargeBomActionExecutionContract(effective, snapshotAction)
  return { action: effective, bindingScope, sourceValidation,
    sourceScope: active === null ? (resolved.legacySourceScope || sourceScope) : sourceScope }
}

module.exports = { readActiveStockPreparationReadPlan, resolveStockPreparationReadPlanExecution, StockPreparationReadPlanRuntimeError }
