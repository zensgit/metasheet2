// field-option-action-registry.cjs
// FOS-4b-1: the generalized predefined-action registry + action-binding normalizer (CONTRACT layer).
//
// LOCK-SAFE / ZERO EXECUTION: this module defines data shapes + validation ONLY. It is NOT wired to the
// generic field-option-sync route — that route still fail-closes on action bindings
// (FIELD_OPTION_SYNC_ACTIONS_NOT_SUPPORTED). Enabling action EXECUTION on the generic path is FOS-4b-2
// (runtime), which is held pending owner ratification of the security model (see the FOS-4b design-lock).
// Nothing here executes, dry-runs, or invokes any action; it only validates references.
//
// Security model (from the design-lock, committed): the REGISTRY owns action definitions + gating
// (requiresDryRun / requiredPermission / allowedParameterBindings — own-review to change); a PRESET
// declares a permitted SUBSET (permittedActionIds); a REQUEST only REFERENCES an actionId + constrained
// parameter bindings, and can NEVER define new behavior or carry an action body. This preserves the
// FOS-3 invariant (no arbitrary action execution on the generic path).
//
// NOTE (temporary duplication, resolved in FOS-4b-2): the stock-preparation predefined action is mirrored
// here so the generic contract is self-contained without touching the security-sensitive stock-prep path.
// FOS-4b-2 unifies stock-prep onto this registry (single source) under its own zero-drift review.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

class FieldOptionActionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'FieldOptionActionError'
    this.status = 422
    this.code = 'FIELD_OPTION_ACTION_INVALID'
    this.details = details
  }
}

const ACTION_KINDS = Object.freeze(['table_action'])

// Generalized predefined-action registry. Frozen; new actions = edit this table + own-review.
// Seed entry mirrors the stock-preparation predefined action (same gating).
const FOS_PREDEFINED_ACTIONS = Object.freeze({
  'plm.stock-preparation.pull-bom.v1': Object.freeze({
    actionId: 'plm.stock-preparation.pull-bom.v1',
    kind: 'table_action',
    requiresDryRun: true,
    requiredPermission: 'write',
    allowedParameterBindings: Object.freeze(['projectNo']),
  }),
})

function isSafeString(value) {
  return typeof value === 'string' && value.trim() !== '' && scrubSecretStringValue(value) === value
}

// A binding may carry ONLY: optionValue?, actionId/predefinedActionId (a registry ref), parameterBindings.
// Any key that could be an action body / executable is rejected (browser references, never defines).
const FORBIDDEN_BINDING_KEYS = Object.freeze([
  'handler', 'fn', 'functionBody', 'body', 'sql', 'query', 'js', 'javascript', 'script', 'url', 'endpoint',
  'kind', 'requiresDryRun', 'requiredPermission', 'allowedParameterBindings', // gating is registry-owned, not request-settable
])

function normalizeParameterBindings(input, field, action) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new FieldOptionActionError(`${field} must be an object`, { field })
  }
  const allowed = new Set(action.allowedParameterBindings)
  const out = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.has(key)) {
      throw new FieldOptionActionError(`${field}.${key} is not an allowed parameter binding for ${action.actionId}`, {
        field: `${field}.${key}`, actionId: action.actionId,
      })
    }
    if (!isSafeString(raw)) {
      throw new FieldOptionActionError(`${field}.${key} must be a safe binding value`, { field: `${field}.${key}` })
    }
    out[key] = raw
  }
  return out
}

// Validate a request's action binding: actionId MUST be in the registry AND in the preset's permitted
// subset; parameter bindings MUST be a subset of the registry's allowlist. Returns the normalized binding
// with REGISTRY-OWNED gating (requiresDryRun/requiredPermission) copied from the registry, never the request.
function normalizeFieldOptionActionBinding(input, { field = 'actionBinding', permittedActionIds = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FieldOptionActionError(`${field} must be an object`, { field })
  }
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_BINDING_KEYS.includes(key)) {
      throw new FieldOptionActionError(`${field}.${key} is not permitted (a binding references a registered action; it cannot define one)`, { field: `${field}.${key}` })
    }
  }
  const actionId = input.predefinedActionId || input.actionId
  if (!isSafeString(actionId)) {
    throw new FieldOptionActionError(`${field}.actionId is required`, { field: `${field}.actionId` })
  }
  const action = FOS_PREDEFINED_ACTIONS[actionId]
  if (!action) {
    throw new FieldOptionActionError(`${field}.actionId is not a registered predefined action`, { field: `${field}.actionId`, actionId })
  }
  if (!Array.isArray(permittedActionIds) || !permittedActionIds.includes(actionId)) {
    throw new FieldOptionActionError(`${field}.actionId is not permitted by this preset`, { field: `${field}.actionId`, actionId })
  }
  // The REAL guarantee is this fixed output ALLOWLIST: only these five fields are ever returned, so any
  // unexpected input key (incl. case variants the FORBIDDEN_BINDING_KEYS denylist might miss) is dropped,
  // never propagated. FORBIDDEN_BINDING_KEYS is defense-in-depth that fails LOUD (rejects), not the
  // load-bearing control. Do NOT change this to map fields from raw input.
  return {
    actionId: action.actionId,
    kind: action.kind,
    requiresDryRun: action.requiresDryRun, // registry-owned (never from request)
    requiredPermission: action.requiredPermission, // registry-owned (never from request)
    parameterBindings: normalizeParameterBindings(input.parameterBindings, `${field}.parameterBindings`, action),
  }
}

function isRegisteredActionId(actionId) {
  return typeof actionId === 'string' && Object.prototype.hasOwnProperty.call(FOS_PREDEFINED_ACTIONS, actionId)
}

// Values-free + structurally sound registry self-check (no secrets/values; gating present).
function assertActionRegistryValuesFree() {
  for (const [actionId, action] of Object.entries(FOS_PREDEFINED_ACTIONS)) {
    if (!isSafeString(actionId)) throw new FieldOptionActionError('registry actionId is not safe', { actionId })
    if (!ACTION_KINDS.includes(action.kind)) throw new FieldOptionActionError('registry action kind invalid', { actionId })
    if (typeof action.requiresDryRun !== 'boolean') throw new FieldOptionActionError('registry requiresDryRun must be boolean', { actionId })
    if (!isSafeString(action.requiredPermission)) throw new FieldOptionActionError('registry requiredPermission invalid', { actionId })
    if (!Array.isArray(action.allowedParameterBindings)) throw new FieldOptionActionError('registry allowedParameterBindings invalid', { actionId })
  }
  return true
}

function listRegisteredActionIds() {
  return Object.keys(FOS_PREDEFINED_ACTIONS)
}

module.exports = {
  FieldOptionActionError,
  ACTION_KINDS,
  FOS_PREDEFINED_ACTIONS,
  FORBIDDEN_BINDING_KEYS,
  normalizeFieldOptionActionBinding,
  isRegisteredActionId,
  assertActionRegistryValuesFree,
  listRegisteredActionIds,
}
