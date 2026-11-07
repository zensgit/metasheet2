'use strict'

// 批次标识 BI-1a (register R-65; design §3.5 step 0, S6 C-6) — LK.assertHolderWithin(trx, scopeKey, { leaseId,
// fencingEpoch, reason }): the sheet write lock's holder assert INSIDE the caller's plugin-db transaction. It sets the
// bounded row-lock wait FIRST, takes the lock row FOR UPDATE, compares the lease id and the fencing epoch, and NEVER
// writes. A missing row or a mismatch is 409 LEASE_LOST with `fence: true` / `partial: false`; 55P03 is 409
// WRITE_LOCKED `holder_in_write`; any other failure 503 STORE_FAILED; a handle without the methods or no lease facts
// is 500. Driven over the pull-batch kit's fake (which parses migration 100 for the lock row) and the REAL lock module.
// Real PostgreSQL: BI-R14 in packages/core-backend/tests/integration/stock-preparation-pull-batch-realdb.cases.ts.
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const lockLib = require(path.join(__dirname, '..', 'lib', 'stock-preparation-project-write-lock.cjs'))
const kit = require('./support/stock-preparation-pull-batch-kit.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SCOPE_KEY = 'spw2:syn'

function lockRow({ leaseId = 'lease_live', epoch = 3 } = {}) {
  return {
    scope_key: SCOPE_KEY, tenant_id: 'tenant-syn-bi', generation: 4, generation_token: 'tok_4', fencing_epoch: epoch,
    lease_id: leaseId, lease_seq: 2, lease_purpose: leaseId ? 'small_apply' : null, lease_run_id: leaseId ? 'run_1' : null,
    lease_acquired_at: leaseId ? '2026-10-27T00:59:00.000Z' : null, lease_expires_at: leaseId ? '2026-10-27T01:01:00.000Z' : null,
  }
}

function setup(options = {}) {
  const db = kit.createFakePullBatchDb({ lockTable: true })
  db.seed(kit.T.lock, lockRow(options))
  const lock = lockLib.createStockPreparationProjectWriteLock({ db, rowLockWaitMs: 1234 })
  return { db, lock }
}

const within = (db, lock, scopeKey, facts) => db.transaction((trx) => lock.assertHolderWithin(trx, scopeKey, facts))

test('LK-H1 the holder holds: the bound is set FIRST (the configured wait), then the lock row FOR UPDATE; nothing is written', async () => {
  const { db, lock } = setup()
  const before = JSON.stringify(db.rows(kit.T.lock))
  assert.equal(await within(db, lock, SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 3 }), undefined)
  assert.deepEqual(db.log.filter(([method]) => method.startsWith('trx.')).map(([method, args]) => (method === 'trx.setLocalLockTimeout' ? `${method}:${args.ms}` : `${method}:${args.table}`)), [
    'trx.setLocalLockTimeout:1234',
    `trx.selectOneForUpdate:${kit.T.lock}`,
  ])
  assert.equal(JSON.stringify(db.rows(kit.T.lock)), before, 'it reads and locks, never writes')
})

test('LK-H2 another lease, an older epoch, or no row at all => 409 LEASE_LOST, fence: true, partial: false, the caller\'s reason kept', async () => {
  const { db, lock } = setup()
  for (const [name, scopeKey, facts] of [
    ['another lease', SCOPE_KEY, { leaseId: 'lease_old', fencingEpoch: 3, reason: 'pull_batch_allocate' }],
    ['an older epoch', SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 2, reason: 'pull_batch_allocate' }],
    ['a newer epoch', SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 4, reason: 'pull_batch_allocate' }],
    ['no row', 'spw2:absent', { leaseId: 'lease_live', fencingEpoch: 3 }],
  ]) {
    const error = await within(db, lock, scopeKey, facts).catch((e) => e)
    assert.equal(error.code, lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST, name)
    assert.equal(error.status, 409, name)
    assert.equal(error.fence, true, `${name}: a writer stops its run on it`)
    assert.equal(error.details.partial, false, name)
    assert.equal(error.details.reason, facts.reason || 'holder_assert_lost', name)
  }
  const released = setup({ leaseId: null })
  const free = await within(released.db, released.lock, SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 3 }).catch((e) => e)
  assert.equal(free.code, lockLib.PROJECT_WRITE_ERROR_CODES.LEASE_LOST, 'a released lease is no lease')
  assert.equal(db.log.filter(([method]) => method === 'trx.updateRow' || method === 'trx.insertOne').length, 0, 'never writes, not even on a refusal')
})

test('LK-H3 55P03 (the holder\'s own fenced write holds the row FOR SHARE) => 409 WRITE_LOCKED holder_in_write; another failure => 503; a failing bound => 503', async () => {
  const { db, lock } = setup()
  db.faults.selectOneForUpdate = kit.sqlError('55P03', 'lock not available')
  const busy = await within(db, lock, SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 3 }).catch((e) => e)
  assert.deepEqual([busy.code, busy.status, busy.details.reason, busy.details.retryAfterMs], [lockLib.PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409, 'holder_in_write', 1234])
  db.faults.selectOneForUpdate = kit.sqlError('08006', 'connection failure')
  const down = await within(db, lock, SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 3 }).catch((e) => e)
  assert.deepEqual([down.code, down.status, down.details.operation], [lockLib.PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503, 'holder_within'])
  db.faults.setLocalLockTimeout = kit.sqlError('25P02', 'current transaction is aborted')
  const bound = await within(db, lock, SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 3 }).catch((e) => e)
  assert.deepEqual([bound.code, bound.status], [lockLib.PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503])
})

test('LK-H4 a handle without the methods => 500 UNAVAILABLE; missing / malformed lease facts or scope => 500 GUARD_SCOPE_MISMATCH; nothing is read', async () => {
  const { db, lock } = setup()
  for (const handle of [null, {}, { setLocalLockTimeout: async () => {} }, { selectOneForUpdate: async () => null }]) {
    const error = await lock.assertHolderWithin(handle, SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: 3 }).catch((e) => e)
    assert.deepEqual([error.code, error.status], [lockLib.PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 500])
  }
  const logBefore = db.log.length
  for (const [scopeKey, facts] of [
    ['', { leaseId: 'lease_live', fencingEpoch: 3 }],
    [SCOPE_KEY, { leaseId: '', fencingEpoch: 3 }],
    [SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: -1 }],
    [SCOPE_KEY, { leaseId: 'lease_live', fencingEpoch: '3' }],
    [SCOPE_KEY, { leaseId: 'lease_live' }],
  ]) {
    const error = await within(db, lock, scopeKey, facts).catch((e) => e)
    assert.deepEqual([error.code, error.status], [lockLib.PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 500], JSON.stringify([scopeKey, facts]))
  }
  assert.equal(db.log.slice(logBefore).filter(([method]) => method.startsWith('trx.')).length, 0, 'refused before any statement on the handle')
})

test('LK-H5 the lock factory\'s method surface (critic N7 (3): no test pinned it): assertHolderWithin sits beside bumpGenerationWithin', () => {
  const { lock } = setup()
  assert.deepEqual(Object.keys(lock), [
    'scopeKeyFor', 'readState', 'assertNoLiveWriter', 'bumpGeneration', 'bumpGenerationWithin', 'assertHolderWithin',
    'observeGeneration', 'readGeneration', 'acquire', 'createGuard', 'withProjectWriteLease',
  ])
  assert.ok(Object.isFrozen(lock))
  assert.equal(lockLib.assertHolderWithin, undefined, 'a FACTORY method, not a module-level export')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-write-lock-holder-within.test.cjs', tests)
