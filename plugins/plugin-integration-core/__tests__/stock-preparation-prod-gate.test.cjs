'use strict'

// FOS-4b-3-prod P2: shared apply-gate tests — controlled canonical exception, route parity, fail-closed
// (no fall-through), dormant-by-default resolver, post-plan maxCleanRows, values-free. Gate logic only;
// nothing here enables a production policy in any real config path.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  StockPreparationTableActionError,
  PLM_STOCK_PREPARATION_ACTION_ID,
  assertStockPrepApplyAllowed,
  assertProductionCleanRowsWithinBound,
  resolveStockPrepApplyProductionPolicy,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  PROD_CANONICAL_OBJECT_ID,
  StockPreparationProductionPolicyError,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-production-policy.cjs'))

const NOW = Date.parse('2026-06-25T00:00:00.000Z')
const SANDBOX_POLICY = { enabled: true, allowedTargetObjectIds: ['sandbox_stock_prep'] }
function prodPolicy(overrides = {}) {
  return {
    enabled: true,
    authorizedTargetObjectId: PROD_CANONICAL_OBJECT_ID,
    authorizationId: 'auth-1',
    allowedActionId: PLM_STOCK_PREPARATION_ACTION_ID,
    allowedRoute: 'both',
    maxCleanRows: 100,
    expiresAt: '2026-06-26T00:00:00.000Z',
    requireFreshDryRun: true,
    ...overrides,
  }
}
const canonicalTarget = () => ({ sheetId: 'sheet_prod', objectId: PROD_CANONICAL_OBJECT_ID })
const sandboxTarget = () => ({ sheetId: 'sheet_sb', objectId: 'sandbox_stock_prep' })
const tableErr = (code, reason) => (e) =>
  e instanceof StockPreparationTableActionError && e.status === 403 && e.code === code &&
  (reason === undefined || (e.details && e.details.reason === reason))
const policyErr = (reason) => (e) =>
  e instanceof StockPreparationProductionPolicyError && e.details && e.details.reason === reason

// --- sandbox path (no production policy) ---
assert.deepEqual(
  assertStockPrepApplyAllowed(sandboxTarget(), { sandboxPolicy: SANDBOX_POLICY, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
  { mode: 'sandbox', maxCleanRows: null })
// canonical rejected on the sandbox path, BOTH routes
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { sandboxPolicy: SANDBOX_POLICY, route: 'small' }), tableErr('STOCK_PREP_APPLY_SANDBOX_ONLY', 'prod_canonical'))
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { sandboxPolicy: SANDBOX_POLICY, route: 'large' }), tableErr('STOCK_PREP_APPLY_SANDBOX_ONLY', 'prod_canonical'))

// --- production path (controlled exception): valid → allowed, both routes ---
assert.deepEqual(
  assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy(), now: NOW, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
  { mode: 'production', maxCleanRows: 100 })
assert.deepEqual(
  assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy(), now: NOW, route: 'large', actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
  { mode: 'production', maxCleanRows: 100 })

// --- present production policy NEVER falls through: any failure is a hard reject ---
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy({ enabled: false }), now: NOW, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), policyErr('not_enabled'))
// even with a valid sandbox policy + sandbox target alongside a malformed production policy → still hard reject (no demotion)
assert.throws(() => assertStockPrepApplyAllowed(sandboxTarget(), { sandboxPolicy: SANDBOX_POLICY, productionPolicy: prodPolicy({ enabled: false }), now: NOW, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), policyErr('not_enabled'))
// expired / expiry-too-far / missing-now → reject
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy({ expiresAt: '2020-01-01T00:00:00.000Z' }), now: NOW, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), policyErr('expired'))
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy({ expiresAt: '2999-01-01T00:00:00.000Z' }), now: NOW, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), policyErr('expiry_too_far'))
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy(), now: undefined, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), policyErr('missing_now'))

// --- per-apply authorization mismatches (valid policy, wrong apply) ---
// non-canonical target → target_mismatch; objectId-omitted → target_mismatch (explicit canonical required)
assert.throws(() => assertStockPrepApplyAllowed(sandboxTarget(), { productionPolicy: prodPolicy(), now: NOW, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), tableErr('STOCK_PREP_PRODUCTION_APPLY_DENIED', 'target_mismatch'))
assert.throws(() => assertStockPrepApplyAllowed({ sheetId: 'x' }, { productionPolicy: prodPolicy(), now: NOW, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), tableErr('STOCK_PREP_PRODUCTION_APPLY_DENIED', 'target_mismatch'))
// route mismatch (allowedRoute='small', running large)
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy({ allowedRoute: 'small' }), now: NOW, route: 'large', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), tableErr('STOCK_PREP_PRODUCTION_APPLY_DENIED', 'route_mismatch'))
// action mismatch
assert.throws(() => assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy(), now: NOW, route: 'small', actionId: 'other.action.v1' }), tableErr('STOCK_PREP_PRODUCTION_APPLY_DENIED', 'action_mismatch'))

// --- resolver: dormant by default; config-only; NO env path ---
assert.equal(resolveStockPrepApplyProductionPolicy(undefined), undefined)
assert.equal(resolveStockPrepApplyProductionPolicy({}), undefined)
assert.deepEqual(resolveStockPrepApplyProductionPolicy({ stockPrepApplyProduction: { enabled: true } }), { enabled: true })
process.env.STOCK_PREP_PRODUCTION_MODE = 'true' // a hypothetical env — production must ignore env entirely
assert.equal(resolveStockPrepApplyProductionPolicy({}), undefined, 'production resolver is config-only; env never enables it')
delete process.env.STOCK_PREP_PRODUCTION_MODE

// --- maxCleanRows post-plan bound ---
const prodGate = { mode: 'production', maxCleanRows: 100 }
assert.doesNotThrow(() => assertProductionCleanRowsWithinBound(prodGate, 100)) // boundary inclusive
assert.throws(() => assertProductionCleanRowsWithinBound(prodGate, 101), tableErr('STOCK_PREP_PRODUCTION_APPLY_DENIED', 'max_clean_rows_exceeded'))
assert.doesNotThrow(() => assertProductionCleanRowsWithinBound({ mode: 'sandbox', maxCleanRows: null }, 999999)) // sandbox → no bound

// --- values-free: production-denied error details are reason-only ---
try {
  assertStockPrepApplyAllowed(canonicalTarget(), { productionPolicy: prodPolicy({ allowedRoute: 'small' }), now: NOW, route: 'large', actionId: PLM_STOCK_PREPARATION_ACTION_ID })
  assert.fail('expected route_mismatch')
} catch (e) {
  assert.deepEqual(Object.keys(e.details), ['reason'], 'gate error is reason-only (values-free)')
}

console.log('stock-preparation-prod-gate.test.cjs OK')
