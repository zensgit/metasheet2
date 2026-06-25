'use strict'

// FOS-4b-3-prod P1 — production apply policy CONTRACT (normalize/validate + negative controls).
//
// LOCK-SAFE: this module is NOT wired into the apply path. The sandbox-only guard
// (assertStockPrepApplySandboxAllowed) is unchanged and the production canonical target stays rejected by
// default. P2 will wire a validated production policy into BOTH write entry points (small-BOM
// applyStockPreparationAction and large-BOM tableActionLargeBomApplyJobRun) behind explicit owner
// authorization, fail-closed by default. This file only defines + validates the policy shape so that the
// future wiring has a strict contract. It does not open production apply, touch the canonical, or change
// any runtime. See data-factory-fos-4b-3-prod-apply-gate-design-lock-20260625.md.

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require('./stock-preparation-templates.cjs')

// Mirrors PLM_STOCK_PREPARATION_ACTION_ID (defined in stock-preparation-table-actions.cjs); kept local to
// avoid a future table-actions <-> production-policy import cycle when P2 wires this in.
const PLM_STOCK_PREPARATION_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const PROD_CANONICAL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const ALLOWED_ROUTES = Object.freeze(['small', 'large', 'both'])
// Bounded authorization window: a production policy may not be usable more than this far in the future,
// enforced at apply time against the caller-supplied `now`. Keeps "bounded by time" real even when
// expiresAt is a valid-but-distant ISO timestamp. Reviewed bound; tighten as needed.
const MAX_PRODUCTION_POLICY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

class StockPreparationProductionPolicyError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationProductionPolicyError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseStrictIsoTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[9] === undefined ? 0 : Number(match[9])
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10])
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  if (second < 0 || second > 59) return null
  if (offsetHour < 0 || offsetHour > 23 || offsetMinute < 0 || offsetMinute > 59) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

// Values-free reject: coarse reason only; never echoes target / authorization / action / values.
function reject(reason, message) {
  throw new StockPreparationProductionPolicyError(422, 'STOCK_PREP_PRODUCTION_POLICY_INVALID', message, { reason })
}

// Normalize/validate a production apply policy. Fail-closed: any missing/invalid field, a sandbox-shaped
// object, a non-canonical target, or a non-true gating flag throws. Returns a frozen normalized policy on
// success. This is the contract only — it grants nothing; P2 decides per-apply using it.
function normalizeStockPrepApplyProductionPolicy(input) {
  if (!isPlainObject(input)) reject('not_object', 'production policy must be an object')
  // A sandbox policy is NOT a production policy — reject the sandbox allowlist shape outright so it can
  // never be passed in as a production policy.
  if (Object.prototype.hasOwnProperty.call(input, 'allowedTargetObjectIds')) {
    reject('sandbox_shape', 'a sandbox policy must not be used as a production policy')
  }
  if (input.enabled !== true) reject('not_enabled', 'production policy must be explicitly enabled')

  const authorizedTargetObjectId = optionalString(input.authorizedTargetObjectId)
  if (!authorizedTargetObjectId) reject('missing_target', 'authorizedTargetObjectId is required')
  // Production policy may only authorize the prod canonical target — never an arbitrary non-canonical one.
  if (authorizedTargetObjectId !== PROD_CANONICAL_OBJECT_ID) {
    reject('target_not_canonical', 'production policy may only authorize the production canonical target')
  }

  const authorizationId = optionalString(input.authorizationId)
  if (!authorizationId) reject('missing_authorization', 'authorizationId is required')

  const allowedActionId = optionalString(input.allowedActionId)
  if (!allowedActionId) reject('missing_action', 'allowedActionId is required')
  if (allowedActionId !== PLM_STOCK_PREPARATION_ACTION_ID) {
    reject('action_not_allowed', 'allowedActionId is not a recognized stock-preparation action')
  }

  const allowedRoute = optionalString(input.allowedRoute)
  if (!allowedRoute || !ALLOWED_ROUTES.includes(allowedRoute)) {
    reject('invalid_route', 'allowedRoute must be one of small | large | both')
  }

  if (!Number.isInteger(input.maxCleanRows) || input.maxCleanRows <= 0) {
    reject('invalid_max_clean_rows', 'maxCleanRows must be a positive integer')
  }

  const expiresAt = optionalString(input.expiresAt)
  if (!expiresAt) reject('missing_expiry', 'expiresAt is required')
  // Require strict ISO-8601 with explicit time + zone. Date.parse alone accepts loose forms (e.g. "2999"
  // → a ~1000-year window), which defeats the bounded-time intent; demand the full timestamp.
  const expiresAtMs = parseStrictIsoTimestamp(expiresAt)
  if (!Number.isFinite(expiresAtMs)) {
    reject('invalid_expiry', 'expiresAt must be a strict ISO-8601 timestamp with time and zone')
  }

  // No blind apply: the policy must explicitly require a fresh dry-run/apply token at apply time.
  if (input.requireFreshDryRun !== true) reject('fresh_dry_run_required', 'requireFreshDryRun must be true')

  return Object.freeze({
    enabled: true,
    authorizedTargetObjectId,
    authorizationId,
    allowedActionId,
    allowedRoute,
    maxCleanRows: input.maxCleanRows,
    expiresAt,
    expiresAtMs,
    requireFreshDryRun: true,
  })
}

// Expiry check kept separate so the caller supplies `now` (no module-level clock). Fail-closed: a
// normalized policy at/after expiry rejects; a missing/non-normalized policy or missing `now` rejects.
// P2 calls this at apply time with the current timestamp.
function assertProductionPolicyNotExpired(policy, now) {
  if (!isPlainObject(policy) || !Number.isFinite(policy.expiresAtMs)) {
    reject('not_normalized', 'production policy must be normalized before the expiry check')
  }
  if (!Number.isFinite(now)) reject('missing_now', 'a current timestamp is required for the expiry check')
  if (now >= policy.expiresAtMs) reject('expired', 'production policy has expired')
  // Bounded-time: reject a policy whose expiry is further out than the reviewed authorization window.
  if (policy.expiresAtMs > now + MAX_PRODUCTION_POLICY_WINDOW_MS) {
    reject('expiry_too_far', 'production policy expiry exceeds the bounded authorization window')
  }
}

module.exports = {
  PROD_CANONICAL_OBJECT_ID,
  ALLOWED_ROUTES,
  MAX_PRODUCTION_POLICY_WINDOW_MS,
  StockPreparationProductionPolicyError,
  normalizeStockPrepApplyProductionPolicy,
  assertProductionPolicyNotExpired,
}
