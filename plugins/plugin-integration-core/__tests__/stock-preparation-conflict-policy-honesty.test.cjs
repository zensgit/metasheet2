'use strict'

// Duplicate-expanded-key POLICY HONESTY.
//
// The duplicate-key conflict API advertised six policies. Only `keep_multiple_rows` ever reached
// resolution; `hold` and `source_correction_required` held under their own named reasons; and
// `merge_quantity` / `select_representative` / `skip_selected` were INERT — selecting one was
// accepted, changed nothing, and the rows held under the anonymous catch-all `unsupported_policy`.
//
// The ruling implemented here is REJECT EXPLICITLY, do not implement, do not remove the tokens:
//   - the three strategies stay unimplemented (each destroys or alters a business quantity, which in
//     a materials-requirement context is a wrong requirement — a separate owner decision);
//   - the tokens stay in the frozen vocabulary, because selections are PERSISTED and re-validated on
//     read, so deleting a token would turn "does nothing" into "stored rows no longer load";
//   - selecting one now fails 422 CONFLICT_POLICY_NOT_IMPLEMENTED at the selection boundary, where
//     the cause is, instead of surfacing later as a silent hold;
//   - `allowedPolicies` reports only the policies that actually work.
//
// Every rejection assertion below is paired with a POSITIVE CONTROL on the three working policies —
// without it, a guard that rejected everything would pass just as happily.
//
// This file is values-free: only closed policy/reason tokens, counts and PASS/FAIL.

const assert = require('node:assert/strict')
const path = require('node:path')

const plannerPath = path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs')
const policiesPath = path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-policies.cjs')

const {
  DUPLICATE_EXPANDED_KEY_POLICIES,
  DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY,
  DUPLICATE_EXPANDED_KEY_UNSUPPORTED_HELD_REASON,
  IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES,
  UNIMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES,
  duplicateExpandedKeyDiagnosticsForRows,
  planStockPreparationConflicts,
  __internals: plannerInternals,
} = require(plannerPath)

const {
  CONFLICT_POLICY_NOT_IMPLEMENTED,
  POLICY_BOUNDARY_STORED,
  buildConflictPolicyReview,
  loadTableScopeConflictPolicies,
  normalizeRunOnlyConflictPolicyReview,
  saveTableScopeConflictPolicies,
  __internals: policyInternals,
} = require(policiesPath)

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  normalizeStockPreparationActionConfig,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))

// The three tokens the ruling refuses, and the three that must keep working. Written out as
// literals on purpose: if the derivation in the planner ever drifts, the partition test below
// fails RED against these, rather than silently agreeing with whatever the code now derives.
const EXPECTED_UNIMPLEMENTED = ['merge_quantity', 'select_representative', 'skip_selected']
const EXPECTED_IMPLEMENTED = ['hold', 'keep_multiple_rows', 'source_correction_required']

const FINGERPRINT_A = 'sha16:1111111111111111'
const FINGERPRINT_B = 'sha16:2222222222222222'

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
    source: { externalSystemId: 'plm_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId: 'sheet_a', objectId: 'stockPreparationMain', keyField: 'idempotencyKey' },
  })
}

function isNotImplementedError(error) {
  return error
    && error.name === 'StockPreparationConflictPolicyError'
    && error.status === 422
    && error.code === CONFLICT_POLICY_NOT_IMPLEMENTED
}

// ---------------------------------------------------------------------------------------------
// 1. The frozen vocabulary is intact, and the implemented/unimplemented split partitions it.
// ---------------------------------------------------------------------------------------------
function testVocabularyIsIntactAndPartitioned() {
  assert.deepEqual(
    DUPLICATE_EXPANDED_KEY_POLICIES.slice(),
    ['hold', 'keep_multiple_rows', 'merge_quantity', 'select_representative', 'skip_selected', 'source_correction_required'],
    'the frozen persisted vocabulary must NOT shrink — stored selections are validated against it on read',
  )

  assert.deepEqual(IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES.slice(), EXPECTED_IMPLEMENTED)
  assert.deepEqual(UNIMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES.slice(), EXPECTED_UNIMPLEMENTED)

  // Mechanical partition: every vocabulary token is classified exactly once, no token invented.
  const implemented = new Set(IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES)
  const unimplemented = new Set(UNIMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES)
  for (const policy of DUPLICATE_EXPANDED_KEY_POLICIES) {
    assert.equal(
      implemented.has(policy) !== unimplemented.has(policy),
      true,
      `${policy} must be classified exactly once`,
    )
  }
  assert.equal(implemented.size + unimplemented.size, DUPLICATE_EXPANDED_KEY_POLICIES.length)
  for (const policy of [...implemented, ...unimplemented]) {
    assert.equal(DUPLICATE_EXPANDED_KEY_POLICIES.includes(policy), true, `${policy} must come from the vocabulary`)
  }

  // The split is DERIVED from planner behaviour, not hand-copied: a policy is implemented iff it is
  // the resolving policy or it holds under its own named reason (not the catch-all).
  for (const policy of DUPLICATE_EXPANDED_KEY_POLICIES) {
    const named = policy === DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY
      || plannerInternals.heldReasonForDuplicatePolicy(policy) !== DUPLICATE_EXPANDED_KEY_UNSUPPORTED_HELD_REASON
    assert.equal(implemented.has(policy), named, `${policy} classification must follow its planner behaviour`)
  }
}

// ---------------------------------------------------------------------------------------------
// 2. allowedPolicies is shrunk at BOTH planner emission sites (top-level + per-group diagnostics).
// ---------------------------------------------------------------------------------------------
function testAllowedPoliciesReportsOnlyWorkingPoliciesAtBothSites() {
  const diagnostics = duplicateExpandedKeyDiagnosticsForRows([
    { idempotencyKey: 'k1', totalQuantity: 1, sourceDetailId: 'd1' },
    { idempotencyKey: 'k1', totalQuantity: 2, sourceDetailId: 'd2' },
  ])

  // Top-level diagnostics — this is the list the workbench dropdown is built from.
  assert.deepEqual(diagnostics.allowedPolicies, EXPECTED_IMPLEMENTED)
  assert.deepEqual(diagnostics.unimplementedPolicies, EXPECTED_UNIMPLEMENTED)

  // Per-group diagnostics — the second emission site.
  assert.equal(diagnostics.groups.length, 1)
  assert.deepEqual(diagnostics.groups[0].allowedPolicies, EXPECTED_IMPLEMENTED)
  assert.deepEqual(diagnostics.groups[0].unimplementedPolicies, EXPECTED_UNIMPLEMENTED)

  for (const site of [diagnostics.allowedPolicies, diagnostics.groups[0].allowedPolicies]) {
    for (const policy of EXPECTED_UNIMPLEMENTED) {
      assert.equal(site.includes(policy), false, `allowedPolicies must not advertise ${policy}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Selecting an unimplemented policy is refused 422 at the table-scope write boundary.
//    POSITIVE CONTROL: the three working policies still save.
// ---------------------------------------------------------------------------------------------
async function testTableScopeSaveRejectsUnimplementedAndAcceptsWorking() {
  for (const policy of EXPECTED_UNIMPLEMENTED) {
    const storage = createMemoryStorage()
    await assert.rejects(
      () => saveTableScopeConflictPolicies({
        action: baseAction(),
        policyStore: storage,
        request: { conflictType: 'duplicate_expanded_key', policies: [{ fingerprint: FINGERPRINT_A, policy }] },
      }),
      (error) => {
        assert.equal(isNotImplementedError(error), true, `${policy} must be refused with a named 422`)
        assert.equal(error.details.policy, policy)
        assert.deepEqual(error.details.allowedPolicies, EXPECTED_IMPLEMENTED)
        assert.deepEqual(error.details.unimplementedPolicies, EXPECTED_UNIMPLEMENTED)
        return true
      },
      `${policy} must not be selectable`,
    )
    assert.equal(storage.map.size, 0, `${policy} must not be persisted before the refusal`)
  }

  // POSITIVE CONTROL — without this, "reject everything" would also pass.
  for (const policy of EXPECTED_IMPLEMENTED) {
    const storage = createMemoryStorage()
    const saved = await saveTableScopeConflictPolicies({
      action: baseAction(),
      policyStore: storage,
      request: { conflictType: 'duplicate_expanded_key', policies: [{ fingerprint: FINGERPRINT_A, policy }] },
    })
    assert.equal(saved.policyCount, 1, `${policy} must still be selectable`)
    assert.equal(saved.policies[0].policy, policy)
  }

  // An out-of-vocabulary token keeps its own distinct code, and its advertised list is shrunk too.
  await assert.rejects(
    () => saveTableScopeConflictPolicies({
      action: baseAction(),
      policyStore: createMemoryStorage(),
      request: { conflictType: 'duplicate_expanded_key', policies: [{ fingerprint: FINGERPRINT_A, policy: 'write_duplicates' }] },
    }),
    (error) => {
      assert.equal(error.status, 422)
      assert.equal(error.code, 'CONFLICT_POLICY_INVALID', 'unknown tokens keep the pre-existing code')
      assert.deepEqual(error.details.allowedPolicies, EXPECTED_IMPLEMENTED)
      return true
    },
  )
}

// ---------------------------------------------------------------------------------------------
// 4. Same refusal at the run-only selection boundary (the dry-run/plan request body).
//    POSITIVE CONTROL: the three working policies still normalize.
// ---------------------------------------------------------------------------------------------
function testRunOnlySelectionRejectsUnimplementedAndAcceptsWorking() {
  for (const policy of EXPECTED_UNIMPLEMENTED) {
    assert.throws(
      () => normalizeRunOnlyConflictPolicyReview({
        conflictType: 'duplicate_expanded_key',
        scope: 'run_only',
        policies: [{ fingerprint: FINGERPRINT_A, policy }],
      }),
      (error) => {
        assert.equal(isNotImplementedError(error), true)
        assert.equal(error.details.policy, policy)
        return true
      },
      `run-only ${policy} must be refused`,
    )
  }

  // POSITIVE CONTROL.
  for (const policy of EXPECTED_IMPLEMENTED) {
    const review = normalizeRunOnlyConflictPolicyReview({
      conflictType: 'duplicate_expanded_key',
      scope: 'run_only',
      policies: [{ fingerprint: FINGERPRINT_A, policy }],
    })
    assert.equal(review.policies.length, 1, `run-only ${policy} must still be accepted`)
    assert.equal(review.policies[0].policy, policy)
  }
}

// ---------------------------------------------------------------------------------------------
// 5. BACKWARD COMPATIBILITY — the whole reason the tokens are not deleted.
//    A PREVIOUSLY STORED selection naming an unimplemented policy must still load. The stored
//    record is written straight into the store, bypassing the guard, because the guard now refuses
//    to create one: proving this against a freshly saved value would be impossible, and softening
//    the guard to make the test run would defeat its purpose.
//    Note the failure mode this catches: normalizeStoredPolicies' catch{} would DROP a rejected row
//    silently, so a regression here shows up as a missing row, never as an error.
// ---------------------------------------------------------------------------------------------
async function testPreviouslyStoredUnimplementedPolicyStillLoads() {
  for (const policy of EXPECTED_UNIMPLEMENTED) {
    const action = baseAction()
    const storage = createMemoryStorage()
    const key = policyInternals.conflictPolicyStoreKey(action)

    // A record as an older release would have written it — never through today's write path.
    storage.map.set(key, {
      version: 1,
      conflictType: 'duplicate_expanded_key',
      actionId: action.actionId,
      targetScopeFingerprint: policyInternals.targetScopeFingerprint(action),
      policies: [
        { fingerprint: FINGERPRINT_A, policy, approvedAt: '2026-06-08T09:00:00.000Z', approvedBy: 'approver' },
        { fingerprint: FINGERPRINT_B, policy: 'keep_multiple_rows', approvedAt: '2026-06-08T09:00:00.000Z', approvedBy: 'approver' },
      ],
    })

    const loaded = await loadTableScopeConflictPolicies({ action, policyStore: storage })
    assert.equal(loaded.policyCount, 2, `a stored ${policy} row must not be dropped on read`)
    const stored = loaded.policies.find((row) => row.fingerprint === FINGERPRINT_A)
    assert.equal(stored.policy, policy, `the stored ${policy} token must survive the read verbatim`)
    assert.equal(stored.approvedAtPresent, true)
    assert.equal(stored.approvedByPresent, true)
  }
}

// ---------------------------------------------------------------------------------------------
// 6. A stored unimplemented selection still FUNCTIONS exactly as before — it reaches the planner and
//    holds under `unsupported_policy`. "Still loads" would be worth little if the row then vanished
//    from the plan. POSITIVE CONTROL in the same pass: keep_multiple_rows still RESOLVES, and
//    hold / source_correction_required still hold under their OWN labels, not the rejected set's.
// ---------------------------------------------------------------------------------------------
async function testStoredUnimplementedPolicyStillReachesThePlannerAndHolds() {
  const action = baseAction()

  // Two duplicate groups; each has a stable discriminator so keep_multiple_rows can really resolve.
  const expandedRows = [
    { idempotencyKey: 'k1', totalQuantity: 1, sourceDetailId: 'd1' },
    { idempotencyKey: 'k1', totalQuantity: 2, sourceDetailId: 'd2' },
    { idempotencyKey: 'k2', totalQuantity: 3, sourceDetailId: 'd3' },
    { idempotencyKey: 'k2', totalQuantity: 4, sourceDetailId: 'd4' },
  ]
  const diagnostics = duplicateExpandedKeyDiagnosticsForRows(expandedRows)
  const [groupA, groupB] = diagnostics.groups

  async function planWith(policyForGroupA) {
    const storage = createMemoryStorage()
    storage.map.set(policyInternals.conflictPolicyStoreKey(action), {
      version: 1,
      conflictType: 'duplicate_expanded_key',
      actionId: action.actionId,
      targetScopeFingerprint: policyInternals.targetScopeFingerprint(action),
      policies: [
        { fingerprint: groupA.fingerprint, policy: policyForGroupA, approvedAt: '2026-06-08T09:00:00.000Z', approvedBy: 'approver' },
        { fingerprint: groupB.fingerprint, policy: 'keep_multiple_rows', approvedAt: '2026-06-08T09:00:00.000Z', approvedBy: 'approver' },
      ],
    })
    const review = buildConflictPolicyReview({
      diagnostics,
      runOnlyReview: null,
      tableScopeReview: await loadTableScopeConflictPolicies({ action, policyStore: storage }),
    })
    const plan = planStockPreparationConflicts({
      expandedRows,
      existingRows: [],
      runId: 'run',
      plannedAt: '2026-06-08T09:00:00.000Z',
      duplicatePolicyReview: review,
    })
    return plan.summary.duplicateExpandedKeyResolution
  }

  for (const policy of EXPECTED_UNIMPLEMENTED) {
    const resolution = await planWith(policy)
    assert.equal(resolution.heldGroupCount, 1, `${policy} must still hold its group`)
    assert.equal(resolution.heldReasonCounts.unsupported_policy, 1, `${policy} still holds as unsupported_policy`)
    assert.equal(resolution.heldPolicies[0].policy, policy, 'the held row still names the stored token')
    assert.equal(resolution.heldPolicies[0].reason, 'unsupported_policy')
    // POSITIVE CONTROL in the same run: the other group's keep_multiple_rows still resolves.
    assert.equal(resolution.resolvedGroupCount, 1, 'keep_multiple_rows must still resolve alongside')
    assert.equal(resolution.resolvedPolicies[0].policy, 'keep_multiple_rows')
  }

  // hold and source_correction_required keep their OWN held labels — they are not collapsed into
  // the rejected set and they are not relabelled unsupported_policy.
  const holdResolution = await planWith('hold')
  assert.equal(holdResolution.heldReasonCounts.default_hold, 1, 'hold keeps its own default_hold label')
  assert.equal(holdResolution.heldReasonCounts.unsupported_policy || 0, 0)
  assert.equal(holdResolution.resolvedGroupCount, 1)

  const correctionResolution = await planWith('source_correction_required')
  assert.equal(correctionResolution.heldReasonCounts.source_correction_required, 1, 'source_correction_required keeps its own label')
  assert.equal(correctionResolution.heldReasonCounts.unsupported_policy || 0, 0)
  assert.equal(correctionResolution.resolvedGroupCount, 1)

  // Both duplicate groups resolve when both are keep_multiple_rows — nothing held at all.
  const bothResolved = await planWith('keep_multiple_rows')
  assert.equal(bothResolved.resolvedGroupCount, 2, 'keep_multiple_rows still reaches resolution')
  assert.equal(bothResolved.heldGroupCount, 0)
}

// ---------------------------------------------------------------------------------------------
// 7. The 'stored' boundary on a server-minted dry-run token record: an in-flight token issued before
//    this guard existed still normalizes, so a stored artifact never becomes a NEW failure.
//    POSITIVE CONTROL: the same payload arriving as a fresh SELECTION is still refused.
// ---------------------------------------------------------------------------------------------
function testStoredBoundaryAcceptsWhatSelectionBoundaryRefuses() {
  for (const policy of EXPECTED_UNIMPLEMENTED) {
    const payload = {
      conflictType: 'duplicate_expanded_key',
      scope: 'run_only',
      policies: [{ fingerprint: FINGERPRINT_A, policy }],
    }

    const stored = normalizeRunOnlyConflictPolicyReview(payload, { boundary: POLICY_BOUNDARY_STORED })
    assert.equal(stored.policies.length, 1, `a stored token record naming ${policy} must still normalize`)
    assert.equal(stored.policies[0].policy, policy)

    // POSITIVE CONTROL — the exclusive-failure proof that the two boundaries really differ.
    assert.throws(
      () => normalizeRunOnlyConflictPolicyReview(payload),
      (error) => isNotImplementedError(error),
      `the same payload as a fresh selection must still be refused for ${policy}`,
    )
  }
}

async function main() {
  testVocabularyIsIntactAndPartitioned()
  testAllowedPoliciesReportsOnlyWorkingPoliciesAtBothSites()
  await testTableScopeSaveRejectsUnimplementedAndAcceptsWorking()
  testRunOnlySelectionRejectsUnimplementedAndAcceptsWorking()
  await testPreviouslyStoredUnimplementedPolicyStillLoads()
  await testStoredUnimplementedPolicyStillReachesThePlannerAndHolds()
  testStoredBoundaryAcceptsWhatSelectionBoundaryRefuses()
  console.log('stock-preparation conflict policy honesty tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
