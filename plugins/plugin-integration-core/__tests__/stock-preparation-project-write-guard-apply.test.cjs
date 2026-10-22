'use strict'

// Batch-refresh phase 0 step 1 — the small-lane APPLY under the project write guard.
//
//   T1  the single-use dry-run token is claimed ATOMICALLY (one `consume`, no get+delete), and a store
//       without `consume` is refused 501 rather than claimed non-atomically.
//
// Every value here is synthetic (support/stock-preparation-project-write-lock-kit.cjs).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  __internals: tableActionInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const kit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

async function mintToken(storage, record = {}) {
  return tableActionInternals.createDryRunToken(storage, {
    actionId: 'swl-action',
    parametersHash: 'swl-parameters-hash',
    revision: 'swl-revision',
    conflictPolicyReview: null,
    ...record,
  })
}

// ── T1 ────────────────────────────────────────────────────────────────────────────────────────────
test('T1 eight concurrent claims of ONE token: exactly one gets the record, the other seven are TOKEN_INVALID', async () => {
  const storage = kit.createConsumableStorage()
  const token = await mintToken(storage)
  const expected = { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () =>
    tableActionInternals.consumeDryRunToken(storage, token, expected)))
  const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
  const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(won.length, 1, 'exactly one claimant gets the token')
  assert.equal(won[0].value.revision, 'swl-revision')
  assert.equal(lost.length, 7)
  for (const outcome of lost) {
    assert.equal(outcome.reason.status, 409)
    assert.equal(outcome.reason.code, 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID')
  }
  assert.equal(storage.map.size, 0, 'the token is gone')
  // The claim is ONE operation: no get, no delete.
  const claimOps = storage.calls.filter(([op]) => op !== 'set').map(([op]) => op)
  assert.deepEqual(claimOps, Array(8).fill('consume'))
})

test('T1 a store without consume is refused 501 TABLE_ACTION_TOKEN_STORE_UNAVAILABLE and the token is left in place', async () => {
  const storage = kit.createConsumableStorage({ withConsume: false })
  const token = await mintToken(storage)
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, token, { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }),
    (error) => error.status === 501 && error.code === 'TABLE_ACTION_TOKEN_STORE_UNAVAILABLE',
  )
  assert.equal(storage.map.size, 1, 'nothing was claimed')
  assert.deepEqual(storage.calls.map(([op]) => op), ['set'], 'no get / delete fallback was attempted')
})

test('T1 the existing refusals keep their codes, and a refused token stays burned', async () => {
  const storage = kit.createConsumableStorage()
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, '  ', { actionId: 'a', parametersHash: 'h' }),
    (error) => error.status === 400 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_REQUIRED',
  )
  const mismatched = await mintToken(storage)
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, mismatched, { actionId: 'swl-action', parametersHash: 'other' }),
    (error) => error.status === 409 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH',
  )
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, mismatched, { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }),
    (error) => error.status === 409 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID',
    'a mismatched claim burns the token (single-use semantics unchanged)',
  )
  const expired = await mintToken(storage)
  const key = Array.from(storage.map.keys()).find((k) => k.endsWith(expired))
  storage.map.set(key, { ...storage.map.get(key), expiresAt: '2000-01-01T00:00:00.000Z' })
  await assert.rejects(
    () => tableActionInternals.consumeDryRunToken(storage, expired, { actionId: 'swl-action', parametersHash: 'swl-parameters-hash' }),
    (error) => error.status === 409 && error.code === 'TABLE_ACTION_DRY_RUN_TOKEN_INVALID',
  )
  assert.equal(storage.map.size, 0)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-write-guard-apply.test.cjs', tests, { passLine: '✓ stock-preparation-project-write-guard-apply' })
