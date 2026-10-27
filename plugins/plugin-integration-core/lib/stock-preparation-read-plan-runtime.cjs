'use strict'

const {
  composeStockPreparationReadPlanAction,
  assertLargeBomActionExecutionContract,
} = require('./stock-preparation-table-actions.cjs')
const { StockPreparationReadPlanStoreError } = require('./stock-preparation-read-plan-store.cjs')
const { sameSourceProject, SOURCE_PROJECT_COMPARISON_MODES } = require('./stock-preparation-source-value-semantics.cjs')

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

// `onlineReadPlansEnabled` is the caller's reading of the operator switch (stock-preparation-read-plan-switch.cjs);
// anything but literal true means OFF: no activation pointer is read and the deployment action executes.
async function resolveStockPreparationReadPlanExecution({ resolved, store, snapshotAction, verifyTenant, projectNo, projectTargetStore, projectIdentityRequired = true, onlineReadPlansEnabled = false } = {}) {
  const { action, bindingScope, sourceScope } = resolved
  if (!bindingScope || !bindingScope.tenantId || bindingScope.workspaceId === undefined) {
    throw new StockPreparationReadPlanRuntimeError(409, 'READ_PLAN_BINDING_SCOPE_INVALID')
  }
  const active = onlineReadPlansEnabled === true ? await readActiveStockPreparationReadPlan(store, {
    ...bindingScope, actionId: action.actionId, systemId: action.source.externalSystemId,
    ...(snapshotAction && snapshotAction.readPlanExecutionIdentity
      ? { expectedGeneration: snapshotAction.readPlanExecutionIdentity.generation } : {}),
  }) : null
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

const REGISTRATION_UNAVAILABLE = 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE'
const REGISTRATION_MAX_BINDINGS = 64
const UNDEFINED_TABLE_SQLSTATE = '42P01'

const registrationUnavailable = () => new StockPreparationReadPlanRuntimeError(503, REGISTRATION_UNAVAILABLE)

// Typed code only: neither a store's error text nor any value leaves the registration helper.
async function registrationRead(read) {
  try { return await read() } catch (_error) { throw registrationUnavailable() }
}

// F2: the registration's read-handle argument list. `executor`, when given, is the project registry's TRANSACTION
// handle (stock-preparation-project-target-store.cjs `assertSourceProjectIdentity` hands it while the tenant registry
// lock is held), and `[{ executor }]` is passed to every store read so each one is issued on it. Absent (the route's
// unlocked pre-read): an empty list, so every store read is called exactly as before and uses the store's own db.
const registrationReadVia = (executor) => (executor === undefined || executor === null ? [] : [{ executor }])

function registrationMode(value) {
  if (value !== undefined && !SOURCE_PROJECT_COMPARISON_MODES.includes(value)) throw registrationUnavailable()
  return value
}

// The complete binding list for this tenant/action. No binding store means no binding capability.
// `via` is the registration's read-handle argument list (`registrationReadVia`): empty, or `[{ executor }]`.
async function readRegistrationBindings(bindingStore, tenantId, actionId, via) {
  if (!bindingStore) return []
  if (typeof bindingStore.listForAction !== 'function') throw registrationUnavailable()
  const listed = await registrationRead(() => bindingStore.listForAction({ tenantId, actionId }, ...via))
  if (!isPlainRecord(listed) || listed.complete !== true || !Array.isArray(listed.bindings)
    || listed.bindings.length > REGISTRATION_MAX_BINDINGS) throw registrationUnavailable()
  const seen = new Set()
  const projected = listed.bindings.map((binding) => {
    if (!isPlainRecord(binding) || binding.tenantId !== tenantId || binding.actionId !== actionId
      || (binding.workspaceId !== null && !isCanonicalText(binding.workspaceId))
      || !isCanonicalText(binding.externalSystemId) || seen.has(binding.workspaceId)) throw registrationUnavailable()
    seen.add(binding.workspaceId)
    return { workspaceId: binding.workspaceId, externalSystemId: binding.externalSystemId }
  })
  const key = (entry) => entry.workspaceId === null ? '' : entry.workspaceId
  return projected.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

const registrationWorkspaces = (deploymentWorkspaceId, bindings) => [...new Set([
  null,
  ...(isCanonicalText(deploymentWorkspaceId) ? [deploymentWorkspaceId] : []),
  ...bindings.map((binding) => binding.workspaceId),
])]

// Stable identity projection of one activation pointer (null = no pointer at this scope).
function checkedRegistrationPointer(pointer, tenantId, workspaceId, actionId) {
  if (pointer === null) return null
  if (!isPlainRecord(pointer) || !isCanonicalText(pointer.id) || pointer.tenantId !== tenantId || pointer.workspaceId !== workspaceId
    || pointer.actionId !== actionId || !['active', 'disabled'].includes(pointer.status)
    || !Number.isSafeInteger(pointer.generation) || pointer.generation < 1
    || !isCanonicalText(pointer.versionId) || !isCanonicalText(pointer.systemId) || !/^[0-9a-f]{64}$/.test(pointer.contentKey)
    || (pointer.validationId !== null && pointer.validationId !== undefined && !isCanonicalText(pointer.validationId))) {
    throw registrationUnavailable()
  }
  return {
    id: pointer.id, status: pointer.status, generation: pointer.generation, versionId: pointer.versionId,
    systemId: pointer.systemId, contentKey: pointer.contentKey, validationId: pointer.validationId ?? null,
  }
}

async function readRegistrationPointers({ readPlanStore, tenantId, actionId, workspaces, cachedNull, via }) {
  const pointers = []
  for (const workspaceId of workspaces) {
    const raw = workspaceId === null && cachedNull
      ? cachedNull.value
      : await registrationRead(() => readPlanStore.getActivation({ tenantId, workspaceId, actionId }, ...via))
    pointers.push(checkedRegistrationPointer(raw, tenantId, workspaceId, actionId))
  }
  return pointers
}

// The comparison mode an approved version carries; the version must be exactly what the pointer names.
function registrationVersionMode(version, pointer, tenantId, workspaceId, actionId) {
  if (!isPlainRecord(version) || version.status !== 'approved' || version.id !== pointer.versionId
    || version.actionId !== actionId || version.systemId !== pointer.systemId || version.contentKey !== pointer.contentKey
    || version.tenantId !== tenantId || version.workspaceId !== workspaceId || !isPlainRecord(version.config)) {
    throw registrationUnavailable()
  }
  const readPlan = version.config.readPlan
  if (readPlan !== undefined && !isPlainRecord(readPlan)) throw registrationUnavailable()
  return registrationMode(readPlan === undefined ? undefined : readPlan.sourceProjectComparison)
}

// Registration-time project-number comparison mode: the strictest of the deployment action and EVERY online
// read-plan scope of this tenant/action (null scope, the deployment workspace, all bindings). It reads
// pointers and approved versions only; it never resolves an execution, a source or a credential, and its
// result is not an execution/source authorization. Returns undefined | 'case-sensitive' | 'case-insensitive'.
// Residual: the reads are re-checked for stability but are not atomic with a future activation (a case-insensitive
// activation serializes with registration on the registry lock instead). With the online read-plan switch off
// (`onlineReadPlansEnabled` not literal true) no online scope can execute, so the deployment's answer is the answer.
// F2: under the registry lock the caller passes its transaction handle as `executor` and EVERY read below rides it —
// the first activation, both binding listings, both pointer rounds (the second is the stability re-check) and the
// versions. Blocking takers of the same lock each hold a pooled connection while they wait, so a read that needed
// another one could wait behind them until the pool's connect timeout and refuse a registration nothing was wrong
// with. db.cjs offers no savepoint: an undefined-table error on that handle aborts the transaction (every later
// statement fails 25P02), so the pre-ledger escape below is taken only WITHOUT an executor; with one, a missing
// activation table is the typed 503 by name. The two early returns below read nothing and ignore the executor.
async function resolveStockPreparationProjectRegistrationComparison({ tenantId, actionId, deploymentAction, bindingStore, readPlanStore, onlineReadPlansEnabled = false, executor } = {}) {
  if (!isCanonicalText(tenantId) || !isCanonicalText(actionId) || !isPlainRecord(deploymentAction)
    || !isPlainRecord(deploymentAction.source)) throw registrationUnavailable()
  const deploymentReadPlan = deploymentAction.source.readPlan
  if (deploymentReadPlan !== undefined && !isPlainRecord(deploymentReadPlan)) throw registrationUnavailable()
  const deploymentWorkspaceId = deploymentAction.source.workspaceId
  if (deploymentWorkspaceId !== undefined && deploymentWorkspaceId !== null && !isCanonicalText(deploymentWorkspaceId)) {
    throw registrationUnavailable()
  }
  const deploymentMode = registrationMode(deploymentReadPlan === undefined ? undefined : deploymentReadPlan.sourceProjectComparison)
  // Deployment CI is already the strictest answer; no optional online module is consulted.
  if (deploymentMode === 'case-insensitive') return deploymentMode
  if (onlineReadPlansEnabled !== true) return deploymentMode
  if (!readPlanStore || typeof readPlanStore.getActivation !== 'function') throw registrationUnavailable()
  const via = registrationReadVia(executor)
  const onExecutor = via.length > 0
  let first
  try {
    first = { value: await readPlanStore.getActivation({ tenantId, workspaceId: null, actionId }, ...via) }
  } catch (error) {
    // Only this first direct single-table read may say the activation table does not exist — and only on the
    // store's own db. On a handed transaction (F2) that 42P01 has already aborted it: refused by name, never legacy.
    if (!onExecutor && error && error.code === UNDEFINED_TABLE_SQLSTATE) return deploymentMode
    throw registrationUnavailable()
  }
  const bindings = await readRegistrationBindings(bindingStore, tenantId, actionId, via)
  const workspaces = registrationWorkspaces(deploymentWorkspaceId, bindings)
  const pointers = await readRegistrationPointers({ readPlanStore, tenantId, actionId, workspaces, cachedNull: first, via })
  const modes = [deploymentMode]
  for (let index = 0; index < pointers.length; index += 1) {
    const pointer = pointers[index]
    if (pointer === null || pointer.status !== 'active') continue
    const workspaceId = workspaces[index]
    const version = await registrationRead(() => readPlanStore.getForRuntime({
      tenantId, workspaceId, id: pointer.versionId, actionId, systemId: pointer.systemId,
    }, ...via))
    modes.push(registrationVersionMode(version, pointer, tenantId, workspaceId, actionId))
  }
  const bindingsAfter = await readRegistrationBindings(bindingStore, tenantId, actionId, via)
  const workspacesAfter = registrationWorkspaces(deploymentWorkspaceId, bindingsAfter)
  const pointersAfter = await readRegistrationPointers({ readPlanStore, tenantId, actionId, workspaces: workspacesAfter, via })
  if (JSON.stringify([bindings, workspaces, pointers]) !== JSON.stringify([bindingsAfter, workspacesAfter, pointersAfter])) {
    throw registrationUnavailable()
  }
  if (modes.includes('case-insensitive')) return 'case-insensitive'
  return modes.includes('case-sensitive') ? 'case-sensitive' : undefined
}

module.exports = {
  readActiveStockPreparationReadPlan,
  resolveStockPreparationReadPlanExecution,
  resolveStockPreparationProjectRegistrationComparison,
  StockPreparationReadPlanRuntimeError,
}
