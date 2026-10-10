'use strict'

// Pure, server-side composition only. These identities are not authorization,
// protection against malicious in-process callers, or an atomic revocation
// mechanism. The caller must verify the actual binding scope, load the active
// approved version, and retain the existing owner/tenant/B2a/write gates.
// Ordinary apply still recomputes before comparing its token revision; this
// module does not promise token rejection before source reads or stop in-flight
// work when an activation is revoked.
const crypto = require('node:crypto')
const {
  SOURCE_KIND,
  validateStockPreparationReadPlanConfig,
} = require('./stock-preparation-read-plan-config.cjs')

const IDENTITY_KEYS = Object.freeze([
  'tenantId', 'workspaceId', 'actionId', 'systemId', 'versionId', 'contentKey', 'generation',
])
const MAX_GENERATION = 2147483647

class StockPreparationReadPlanExecutionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StockPreparationReadPlanExecutionError'
    this.status = 409
    this.code = code
  }
}

function refuse(code) { throw new StockPreparationReadPlanExecutionError(code) }
function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function exactKeys(value, keys) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    })) refuse('READ_PLAN_EXECUTION_IDENTITY_INVALID')
}
function text(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) refuse('READ_PLAN_EXECUTION_IDENTITY_INVALID')
  return value
}
// Identical canonical JSON and SHA256 recipe to the read-plan ledger. Never
// hash just the plan: actionId and systemId are part of the approved document.
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}
function checkedConfig(config) {
  let normalized
  try { normalized = validateStockPreparationReadPlanConfig(config) } catch (_error) {
    refuse('READ_PLAN_EXECUTION_CONTENT_INVALID')
  }
  if (stable(config) !== stable(normalized)) refuse('READ_PLAN_EXECUTION_CONTENT_INVALID')
  return normalized
}
function contentKey(config) { return crypto.createHash('sha256').update(stable(config)).digest('hex') }

function normalizeReadPlanExecutionIdentity(input, action) {
  exactKeys(input, IDENTITY_KEYS)
  const identity = {
    tenantId: text(input.tenantId),
    workspaceId: input.workspaceId === null ? null : text(input.workspaceId),
    actionId: text(input.actionId),
    systemId: text(input.systemId),
    versionId: text(input.versionId),
    contentKey: input.contentKey,
    generation: input.generation,
  }
  if (typeof identity.contentKey !== 'string' || !/^[0-9a-f]{64}$/.test(identity.contentKey)
    || !Number.isInteger(identity.generation) || identity.generation < 1
    || identity.generation > MAX_GENERATION) refuse('READ_PLAN_EXECUTION_IDENTITY_INVALID')
  if (!action || !action.source || identity.actionId !== action.actionId
    || identity.systemId !== action.source.externalSystemId || action.source.kind !== SOURCE_KIND) {
    refuse('READ_PLAN_EXECUTION_BINDING_MISMATCH')
  }
  const config = checkedConfig({
    schemaVersion: 1, actionId: identity.actionId, systemId: identity.systemId,
    readPlan: action.source.readPlan,
  })
  if (contentKey(config) !== identity.contentKey) refuse('READ_PLAN_EXECUTION_CONTENT_INVALID')
  // workspaceId names the caller-verified binding/activation scope. It is NOT
  // action.source.workspaceId, which may still select an older connection scope.
  return identity
}

function approvedReadPlanExecution({ action, scope, activation, version } = {}) {
  exactKeys(scope, ['tenantId', 'workspaceId'])
  const tenantId = text(scope.tenantId)
  const workspaceId = scope.workspaceId === null ? null : text(scope.workspaceId)
  if (!isRecord(activation) || !isRecord(version) || activation.status !== 'active'
    || version.status !== 'approved') refuse('READ_PLAN_EXECUTION_NOT_ACTIVE')
  if (activation.tenantId !== tenantId || version.tenantId !== tenantId
    || activation.workspaceId !== workspaceId || version.workspaceId !== workspaceId) {
    refuse('READ_PLAN_EXECUTION_SCOPE_MISMATCH')
  }
  const config = checkedConfig(version.config)
  if (version.schemaVersion !== 1 || !Number.isInteger(version.version) || version.version < 1
    || activation.versionId !== version.id || activation.actionId !== version.actionId
    || activation.systemId !== version.systemId || activation.contentKey !== version.contentKey
    || config.actionId !== version.actionId || config.systemId !== version.systemId
    || contentKey(config) !== version.contentKey) refuse('READ_PLAN_EXECUTION_CONTENT_INVALID')
  const effective = { ...action, source: { ...action.source, readPlan: config.readPlan } }
  const identity = normalizeReadPlanExecutionIdentity({
    tenantId, workspaceId, actionId: activation.actionId, systemId: activation.systemId,
    versionId: activation.versionId, contentKey: activation.contentKey, generation: activation.generation,
  }, effective)
  return { readPlan: config.readPlan, identity }
}

function readPlanExecutionBudget(action) {
  if (!action || !Object.prototype.hasOwnProperty.call(action, 'readPlanExecutionIdentity')) return undefined
  normalizeReadPlanExecutionIdentity(action.readPlanExecutionIdentity, action)
  return action.source.readPlan.maxReadCount
}

module.exports = {
  StockPreparationReadPlanExecutionError,
  approvedReadPlanExecution,
  normalizeReadPlanExecutionIdentity,
  readPlanExecutionBudget,
}
