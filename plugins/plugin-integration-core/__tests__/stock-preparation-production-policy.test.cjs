'use strict'

// FOS-4b-3-prod P1: production policy contract tests. Normalizer + negative controls + expiry + values-free.
// LOCK-SAFE: this exercises the contract only; nothing here enables apply or touches the canonical.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  PROD_CANONICAL_OBJECT_ID,
  StockPreparationProductionPolicyError,
  normalizeStockPrepApplyProductionPolicy,
  assertProductionPolicyNotExpired,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-production-policy.cjs'))

function validPolicy(overrides = {}) {
  return {
    enabled: true,
    authorizedTargetObjectId: PROD_CANONICAL_OBJECT_ID,
    authorizationId: 'auth-opaque-1',
    allowedActionId: 'plm.stock-preparation.pull-bom.v1',
    allowedRoute: 'both',
    maxCleanRows: 500,
    expiresAt: '2999-01-01T00:00:00.000Z',
    requireFreshDryRun: true,
    ...overrides,
  }
}

function rejectsWith(fn, reason) {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof StockPreparationProductionPolicyError, `expected policy error, got ${e && e.name}`)
    assert.equal(e.status, 422)
    assert.equal(e.code, 'STOCK_PREP_PRODUCTION_POLICY_INVALID')
    assert.equal(e.details.reason, reason, `expected reason=${reason}, got ${e.details && e.details.reason}`)
    // values-free: error details carry only a coarse reason (no target / authorization / values)
    assert.deepEqual(Object.keys(e.details), ['reason'], 'error details must be reason-only (values-free)')
    return e
  }
  assert.fail(`expected rejection with reason=${reason}`)
}

// --- happy path ---
const ok = normalizeStockPrepApplyProductionPolicy(validPolicy())
assert.equal(ok.enabled, true)
assert.equal(ok.authorizedTargetObjectId, PROD_CANONICAL_OBJECT_ID)
assert.equal(ok.allowedRoute, 'both')
assert.equal(ok.maxCleanRows, 500)
assert.equal(ok.requireFreshDryRun, true)
assert.ok(Number.isFinite(ok.expiresAtMs))
assert.ok(Object.isFrozen(ok), 'normalized policy is frozen')
for (const route of ['small', 'large', 'both']) {
  assert.equal(normalizeStockPrepApplyProductionPolicy(validPolicy({ allowedRoute: route })).allowedRoute, route)
}

// --- negative controls (each fail-closed, values-free) ---
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(null), 'not_object')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy('x'), 'not_object')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy({ allowedTargetObjectIds: ['sandbox_x'], enabled: true }), 'sandbox_shape')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ allowedTargetObjectIds: ['sandbox_x'] })), 'sandbox_shape')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ enabled: false })), 'not_enabled')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ authorizedTargetObjectId: '' })), 'missing_target')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ authorizedTargetObjectId: 'some_sandbox_table' })), 'target_not_canonical')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ authorizationId: '' })), 'missing_authorization')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ allowedActionId: '' })), 'missing_action')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ allowedActionId: 'evil.action.v1' })), 'action_not_allowed')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ allowedRoute: 'all' })), 'invalid_route')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ allowedRoute: '' })), 'invalid_route')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ maxCleanRows: 0 })), 'invalid_max_clean_rows')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ maxCleanRows: -5 })), 'invalid_max_clean_rows')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ maxCleanRows: 1.5 })), 'invalid_max_clean_rows')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '' })), 'missing_expiry')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: 'not-a-date' })), 'invalid_expiry')
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ requireFreshDryRun: false })), 'fresh_dry_run_required')

// --- strict ISO-8601 (reject loose forms Date.parse would otherwise accept) ---
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2999' })), 'invalid_expiry') // year-only → ~1000y window
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2026-06-25' })), 'invalid_expiry') // date-only, no time/zone
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2026-06-25T00:00:00' })), 'invalid_expiry') // no zone
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2026-02-31T00:00:00.000Z' })), 'invalid_expiry') // Date.parse rollover
rejectsWith(() => normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2026-06-25T24:00:00.000Z' })), 'invalid_expiry') // Date.parse rollover

// --- expiry check (caller supplies now; no module clock; bounded authorization window = 7 days) ---
const nowMs = Date.parse('2026-06-25T00:00:00.000Z')
const nearFuture = normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2026-06-26T00:00:00.000Z' })) // +1d, in window
assert.doesNotThrow(() => assertProductionPolicyNotExpired(nearFuture, nowMs))
const atWindow = normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2026-07-02T00:00:00.000Z' })) // now + exactly 7d
assert.doesNotThrow(() => assertProductionPolicyNotExpired(atWindow, nowMs)) // boundary is inclusive (> check)
const justOverWindow = normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2026-07-02T00:00:00.001Z' })) // +7d+1ms
rejectsWith(() => assertProductionPolicyNotExpired(justOverWindow, nowMs), 'expiry_too_far')
const tooFar = normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2999-01-01T00:00:00.000Z' })) // valid ISO but distant
rejectsWith(() => assertProductionPolicyNotExpired(tooFar, nowMs), 'expiry_too_far')
const past = normalizeStockPrepApplyProductionPolicy(validPolicy({ expiresAt: '2020-01-01T00:00:00.000Z' }))
rejectsWith(() => assertProductionPolicyNotExpired(past, nowMs), 'expired')
rejectsWith(() => assertProductionPolicyNotExpired({}, nowMs), 'not_normalized')
rejectsWith(() => assertProductionPolicyNotExpired(nearFuture, Number.NaN), 'missing_now')

// --- non-vacuous: a fully valid policy still normalizes (the negatives aren't rejecting everything) ---
assert.ok(normalizeStockPrepApplyProductionPolicy(validPolicy()), 'valid policy normalizes (non-vacuous)')

console.log('stock-preparation-production-policy.test.cjs OK')
