'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  buildConflictPolicyReview,
  deleteTableScopeConflictPolicies,
  loadTableScopeConflictPolicies,
  normalizeRunOnlyConflictPolicyReview,
  saveTableScopeConflictPolicies,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-policies.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  normalizeStockPreparationActionConfig,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createMemoryStorage() {
  const map = new Map()
  return {
    map,
    async get(key) {
      return map.get(key) || null
    },
    async set(key, value) {
      map.set(key, clone(value))
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

function baseAction() {
  return normalizeStockPreparationActionConfig({
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: {
      externalSystemId: 'plm_source_1',
      kind: 'data-source:sql-readonly',
    },
    target: {
      sheetId: 'sheet_stock_secret',
      objectId: 'stockPreparationMain',
      keyField: 'idempotencyKey',
    },
  })
}

function duplicateDiagnostics() {
  return {
    conflictType: 'duplicate_expanded_key',
    groupCount: 2,
    groups: [
      { fingerprint: 'sha16:1111111111111111', rowCount: 2 },
      { fingerprint: 'sha16:2222222222222222', rowCount: 2 },
    ],
  }
}

async function testTableScopeAndRunOnlyPoliciesMergeValuesFree() {
  const action = baseAction()
  const storage = createMemoryStorage()

  const empty = await loadTableScopeConflictPolicies({ action, policyStore: storage })
  assert.equal(empty.scope, 'table_scope')
  assert.equal(empty.policyCount, 0)
  assert.match(empty.targetScopeFingerprint, /^sha16:[0-9a-f]{16}$/)

  const saved = await saveTableScopeConflictPolicies({
    action,
    policyStore: storage,
    approver: 'admin-secret-user',
    request: {
      conflictType: 'duplicate_expanded_key',
      policies: [
        { fingerprint: 'sha16:1111111111111111', policy: 'keep_multiple_rows' },
        // Was merge_quantity; that token is no longer selectable (policy honesty — see
        // stock-preparation-conflict-policy-honesty.test.cjs). The stale-fingerprint behaviour this
        // row exercises is independent of which selectable policy it names.
        { fingerprint: 'sha16:9999999999999999', policy: 'source_correction_required' },
      ],
    },
  })
  assert.equal(saved.policyCount, 2)
  assert.equal(saved.policies[0].approvedByPresent, true)
  assert.equal(saved.policies[0].approvedAtPresent, true)

  const key = Array.from(storage.map.keys())[0]
  storage.map.set(key, {
    ...storage.map.get(key),
    policies: [
      ...storage.map.get(key).policies,
      { fingerprint: 'not-a-fingerprint', policy: 'keep_multiple_rows', approvedBy: 'corrupt-user' },
      { fingerprint: 'sha16:eeeeeeeeeeeeeeee', policy: 'not-a-policy', approvedBy: 'corrupt-user' },
    ],
  })
  const loaded = await loadTableScopeConflictPolicies({ action, policyStore: storage })
  assert.equal(loaded.policyCount, 2, 'corrupt stored rows are ignored rather than crashing load/list/dry-run')

  const runOnly = normalizeRunOnlyConflictPolicyReview({
    conflictType: 'duplicate_expanded_key',
    scope: 'run_only',
    policies: [
      // Was skip_selected; that token is no longer selectable (policy honesty). source_correction_required
      // is a working policy that is likewise NOT the table-scope value, so it still proves run-only wins.
      { fingerprint: 'sha16:2222222222222222', policy: 'source_correction_required' },
      { fingerprint: 'sha16:9999999999999999', policy: 'source_correction_required' },
    ],
  })
  const review = buildConflictPolicyReview({
    diagnostics: duplicateDiagnostics(),
    runOnlyReview: runOnly,
    tableScopeReview: loaded,
  })

  assert.equal(review.conflictType, 'duplicate_expanded_key')
  assert.equal(review.writeEffect, 'manual_confirm_held')
  assert.equal(review.configuredPolicyCount, 2)
  assert.equal(review.ignoredPolicyCount, 1, 'same stale fingerprint in run/table scopes is counted once')
  assert.deepEqual(review.policyCounts, {
    keep_multiple_rows: 1,
    source_correction_required: 1,
  })
  assert.deepEqual(review.scopeCounts, {
    table_scope: 1,
    run_only: 1,
  })
  assert.deepEqual(
    review.selectedPolicies.map((row) => [row.fingerprint, row.policy, row.scope]),
    [
      ['sha16:1111111111111111', 'keep_multiple_rows', 'table_scope'],
      ['sha16:2222222222222222', 'source_correction_required', 'run_only'],
    ],
  )

  const text = JSON.stringify(review) + JSON.stringify(saved)
  assert.ok(!text.includes('sheet_stock_secret'), 'public policy evidence must not expose sheet id')
  assert.ok(!text.includes('admin-secret-user'), 'public policy evidence must not expose approver identity')
  assert.ok(!text.includes('raw-collision-key'), 'public policy evidence must not expose raw collision keys')
}

async function testDefaultHoldDeleteAndValidation() {
  const action = baseAction()
  const storage = createMemoryStorage()
  const review = buildConflictPolicyReview({
    diagnostics: duplicateDiagnostics(),
    runOnlyReview: null,
    tableScopeReview: await loadTableScopeConflictPolicies({ action, policyStore: storage }),
  })
  assert.equal(review.configuredPolicyCount, 0)
  assert.deepEqual(review.policyCounts, { hold: 2 })
  assert.deepEqual(review.scopeCounts, { default: 2 })

  await assert.rejects(
    () => saveTableScopeConflictPolicies({
      action,
      policyStore: storage,
      request: {
        conflictType: 'duplicate_expanded_key',
        policies: [{ fingerprint: 'sha16:1111111111111111', policy: 'write_duplicates' }],
      },
    }),
    /must be one of the duplicate-expanded-key policies/,
  )

  await saveTableScopeConflictPolicies({
    action,
    policyStore: storage,
    request: {
      conflictType: 'duplicate_expanded_key',
      policies: [{ fingerprint: 'sha16:1111111111111111', policy: 'keep_multiple_rows' }],
    },
  })
  assert.equal((await loadTableScopeConflictPolicies({ action, policyStore: storage })).policyCount, 1)
  await assert.rejects(
    () => deleteTableScopeConflictPolicies({
      action,
      policyStore: storage,
      request: {
        conflictType: 'duplicate_expanded_key',
        fingerprints: [],
      },
    }),
    /fingerprints array must not be empty/,
  )
  assert.equal((await loadTableScopeConflictPolicies({ action, policyStore: storage })).policyCount, 1)
  const deleted = await deleteTableScopeConflictPolicies({
    action,
    policyStore: storage,
    request: {
      conflictType: 'duplicate_expanded_key',
      fingerprints: ['sha16:1111111111111111'],
    },
  })
  assert.equal(deleted.policyCount, 0)
}

// Two-point wiring guard. The policy-honesty suite lives in its own file, and this repo's plugin
// test entrypoint is an explicit `&&` chain — a new .cjs that is never appended to `scripts.test`
// runs in NO workflow and every claim resting on it is vacuous. A wiring assertion placed INSIDE
// the new file would be circular (it cannot run if the file is not wired), so it lives here, in a
// suite that is already in the chain.
function testPolicyHonestySuiteIsWiredIntoTheTestChain() {
  const fs = require('node:fs')
  const suite = 'stock-preparation-conflict-policy-honesty.test.cjs'
  assert.equal(
    fs.existsSync(path.join(__dirname, suite)),
    true,
    `${suite} must exist`,
  )
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.equal(
    String(manifest.scripts && manifest.scripts.test).includes(`__tests__/${suite}`),
    true,
    `${suite} must be in scripts.test, or the policy-honesty proof runs in no CI workflow`,
  )
}

async function main() {
  await testTableScopeAndRunOnlyPoliciesMergeValuesFree()
  await testDefaultHoldDeleteAndValidation()
  testPolicyHonestySuiteIsWiredIntoTheTestChain()

  console.log('stock-preparation-conflict-policies.test.cjs OK')
}

main().catch((err) => {
  console.error('stock-preparation-conflict-policies.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
