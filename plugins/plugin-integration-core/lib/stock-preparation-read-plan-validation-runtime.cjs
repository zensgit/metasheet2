'use strict'

// Private HTTP composition, not a cross-plugin capability. The management
// service has already checked admin/current owner and begun a durable attempt.
const crypto = require('node:crypto')
const { createStockPreparationTableActionRegistry } = require('./stock-preparation-table-actions.cjs')
const { validateStockPreparationReadPlanSample, StockPreparationReadPlanValidationReadError } = require('./stock-preparation-read-plan-validation-read.cjs')
const {
  B2A_PURPOSE_STOCK_PREPARATION_PLAN_VALIDATION,
  readPlanSourceObjects, resolveB2aSourceObjects, assertB2aReadAuthorization,
  sourceConfigAuthorizationSnapshot, refuseB2aSourceConfigChangedAfterAuthorization,
} = require('./b2a-trial-registry.cjs')

function unavailable() {
  throw new StockPreparationReadPlanValidationReadError(409, 'READ_PLAN_VALIDATION_SOURCE_UNAVAILABLE')
}
function createStockPreparationReadPlanValidationReader({ configuredTableActions, externalSystems,
  adapterRegistry, registry, operationClaim, storage, now = Date.now } = {}) {
  // Template limits/root semantics are deployment-owned. Never call the active
  // plan resolver: the explicitly selected immutable draft is what is tested.
  const templates = createStockPreparationTableActionRegistry({ actions: configuredTableActions })
  return async ({ identity, version, registration, projectNo }) => {
    const scope = { tenantId: identity.tenantId, workspaceId: null, id: version.systemId }
    if (identity.workspaceId !== null || version.workspaceId !== null || version.tenantId !== identity.tenantId
      || !registration || typeof registration.validationRevision !== 'string'
      || !externalSystems || typeof externalSystems.getExternalSystemAdapterConfig !== 'function'
      || typeof externalSystems.getExternalSystemForAdapter !== 'function'
      || !adapterRegistry || typeof adapterRegistry.createAdapter !== 'function') unavailable()
    const template = await templates.getTableAction({ actionId: version.actionId })
    if (template.source.kind !== 'data-source:sql-readonly') unavailable()
    const action = { ...template, source: { ...template.source, workspaceId: null,
      externalSystemId: version.systemId, readPlan: version.config.readPlan } }
    const metadata = await externalSystems.getExternalSystemAdapterConfig(scope)
    // This accessor deliberately returns only id/kind/connectionId/config. Its
    // exact null-workspace query does not widen; the durable attempt and the
    // adapter row below independently check the full scope and active status.
    if (!metadata || metadata.id !== version.systemId || metadata.kind !== action.source.kind
      || metadata.connectionId !== registration.id) unavailable()
    const sourceObjects = await resolveB2aSourceObjects({
      sourceObjects: readPlanSourceObjects(version.config.readPlan), sourceSystemType: action.source.kind,
      loadSourceSystemConfig: async () => metadata,
    })
    const configSnapshot = sourceConfigAuthorizationSnapshot(action.source.kind, metadata.config)
    const started = now()
    const authorization = await assertB2aReadAuthorization({ registry, store: storage, operationClaim,
      tenantScope: identity.tenantId, sourceSystemType: action.source.kind,
      sourceBindingRef: version.systemId, dataScopeRef: projectNo, sourceObjects,
      purpose: B2A_PURPOSE_STOCK_PREPARATION_PLAN_VALIDATION, runId: crypto.randomUUID(), now: started,
    })
    // No operator-to-owner delegation: the authenticated owner's same identity
    // drives BOTH canonical resolution and every physical read.
    const system = await externalSystems.getExternalSystemForAdapter({ ...scope, principal: identity.actor, runAs: 'user' })
    if (!system || system.id !== version.systemId || system.tenantId !== identity.tenantId
      || system.workspaceId !== null || system.status !== 'active' || system.kind !== action.source.kind
      || system.connectionId !== registration.id || system.config?.dataSourceId !== registration.id) unavailable()
    if (configSnapshot !== sourceConfigAuthorizationSnapshot(action.source.kind, system.config)) {
      refuseB2aSourceConfigChangedAfterAuthorization()
    }
    const sourceAdapter = adapterRegistry.createAdapter(system, { principal: identity.actor,
      expectedValidationRevision: registration.validationRevision,
      ...(authorization ? { b2aAuthorization: authorization } : {}),
    })
    return validateStockPreparationReadPlanSample({ config: version.config, action, projectNo, sourceAdapter,
      dialect: registration.type.toLowerCase(), b2aTrialRegistration: authorization,
      b2aClaimStore: storage, b2aSourceObjects: sourceObjects, b2aNow: started,
    })
  }
}

module.exports = { createStockPreparationReadPlanValidationReader }
