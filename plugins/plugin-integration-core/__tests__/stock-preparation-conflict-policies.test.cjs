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
        { fingerprint: 'sha16:9999999999999999', policy: 'merge_quantity' },
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
      { fingerprint: 'sha16:2222222222222222', policy: 'skip_selected' },
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
    skip_selected: 1,
  })
  assert.deepEqual(review.scopeCounts, {
    table_scope: 1,
    run_only: 1,
  })
  assert.deepEqual(
    review.selectedPolicies.map((row) => [row.fingerprint, row.policy, row.scope]),
    [
      ['sha16:1111111111111111', 'keep_multiple_rows', 'table_scope'],
      ['sha16:2222222222222222', 'skip_selected', 'run_only'],
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

async function main() {
  await testTableScopeAndRunOnlyPoliciesMergeValuesFree()
  await testDefaultHoldDeleteAndValidation()

  console.log('stock-preparation-conflict-policies.test.cjs OK')
}

main().catch((err) => {
  console.error('stock-preparation-conflict-policies.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
