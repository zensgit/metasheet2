'use strict'

const { withProjectDeleteActivity } = require('./stock-preparation-project-delete-activity.cjs')

// These operations can read a target in one transaction and write its result in another.
// A job-id or internal ledger id does not prove a business project number. Such an operation
// holds the tenant fallback lock so it cannot carry old data across deletion and recreation.
const WRITERS = [
  ['tableActionLargeBomExpansionJobStart', 'action', 'read', 'parameters'],
  ['tableActionLargeBomExpansionJobPlan', 'action', 'read'],
  ['tableActionLargeBomExpansionJobRun', 'action', 'read'],
  ['tableActionLargeBomExpansionJobCancel', 'action', 'write'],
  ['tableActionLargeBomApplyJobStart', 'action', 'write'],
  ['tableActionLargeBomApplyJobRun', 'action', 'write'],
  ['tableActionDryRunJobGet', 'action', 'read', 'query'],
  ['stockPreparationRefreshHolds', 'route', 'stock-prep:pull', 'path'],
  ['stockPreparationRefreshChangePlanCurrent', 'route', 'stock-prep:pull', 'path'],
  // Legacy conflict policy targets ignore ?projectNo and are shared. Hold the tenant fallback there.
  ['tableActionConflictPoliciesSave', 'route', 'admin', 'policyQuery'],
  ['tableActionConflictPoliciesDelete', 'route', 'admin', 'policyQuery'],
  ['tableActionApply', 'action', 'write', 'parameters'],
  ['tableActionConfirmationDecisionsReconcile', 'action', 'admin'],
  ['tableActionMvpPersist', 'auth', 'admin', 'parameters'],
  ['stockPreparationMvpSyncPersist', 'auth', 'admin'],
  ['stockPreparationPlmBomSourceRun', 'auth', 'admin'],
  ['stockPreparationGenerationRun', 'auth', 'admin'],
  ['stockPreparationExceptionResolve', 'auth', 'admin'],
  ['stockPreparationExceptionBulkResolve', 'auth', 'admin'],
  ['stockPreparationMaterialMappingCandidatesSync', 'auth', 'admin'],
  ['stockPreparationCarryConfirm', 'auth', 'admin'],
  ['stockPreparationHandoffAdvance', 'route', 'stock-prep:operate'],
  ['stockPreparationConfirmationDecisionsConfirm', 'route', 'stock-prep:operate'],
  ['stockPreparationProjectTargetCreate', 'route', 'stock-prep:pull', 'path'],
]

function fenceProjectWriters(handlers, policy) {
  for (const [name, scope, tier, selector] of WRITERS) {
    const handler = handlers[name]
    handlers[name] = async function guardedProjectWrite(req, res) {
      if (!policy.required()) return handler(req, res)
      if (name === 'tableActionMvpPersist' && !policy.mvpPersistEnabled()) return handler(req, res)
      if (scope === 'action') await policy.authorizeAction(req, tier)
      else await policy.authorize(req, tier)
      const tenantId = scope === 'auth' ? policy.authTenant(req) : policy.routeTenant(req)
      const selected = selector === 'policyQuery'
        ? (policy.projectSheetsEnabled() ? req.query?.projectNo : null)
        : { path: req.params?.projectNo, parameters: req.body?.parameters?.projectNo, query: req.query?.projectNo }[selector]
      const projectNo = typeof selected === 'string' && selected.trim() ? selected.trim() : null
      return withProjectDeleteActivity(policy.activity, { tenantId, projectNo }, () => handler(req, res))
    }
  }
}

module.exports = { fenceProjectWriters }
