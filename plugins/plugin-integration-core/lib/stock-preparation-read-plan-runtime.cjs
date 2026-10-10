'use strict'

const {
  composeStockPreparationReadPlanAction,
  assertLargeBomActionExecutionContract,
} = require('./stock-preparation-table-actions.cjs')
const { StockPreparationReadPlanStoreError } = require('./stock-preparation-read-plan-store.cjs')

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

async function resolveStockPreparationReadPlanExecution({ resolved, store, snapshotAction, verifyTenant } = {}) {
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
  if (snapshotAction) assertLargeBomActionExecutionContract(effective, snapshotAction)
  return { action: effective, bindingScope, sourceValidation,
    sourceScope: active === null ? (resolved.legacySourceScope || sourceScope) : sourceScope }
}

module.exports = { readActiveStockPreparationReadPlan, resolveStockPreparationReadPlanExecution, StockPreparationReadPlanRuntimeError }
