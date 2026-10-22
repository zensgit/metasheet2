'use strict'

// Batch-refresh phase 0 step 1 — the PROJECT WRITE LOCK module (lib/stock-preparation-project-write-lock.cjs)
// against a faithful fake of the scoped db helper (support/stock-preparation-project-write-lock-kit.cjs):
//
//   L1  scope key: deterministic golden literal, values-free, (sheet, project) only — tenant is not identity
//   L2  acquire / busy / release; the generation survives; the row is never deleted
//   L3  bump: free row, live lease (refused), abandoned lease (cleared + bumped + interruption recorded)
//   L4  a holder whose lease was taken over gets LEASE_LOST; a token-only change gets PLAN_SUPERSEDED
//   L5  every store failure is 503 STORE_FAILED — never a busy 409, never "proceed"
//   L6  takeover exactly at expiry + grace (1 ms before: still busy)
//   L7  a takeover CAS is pinned to the observed seq: a holder that renewed in between keeps its lease
//   L8  two concurrent bumps both land (+2), each with its own token
//   L9  acquire vs bump: no bump ever commits while the lease is live
//   L10 the heartbeat keeps a long run's lease alive, and never overlaps the pre-write CAS
//   L11 the constants are pinned
//
// Every value is synthetic.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const lockModule = require(path.join(__dirname, '..', 'lib', 'stock-preparation-project-write-lock.cjs'))
const {
  PROJECT_WRITE_BUMP_MAX_ATTEMPTS,
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_GENERATION_REASONS,
  PROJECT_WRITE_LEASE_HEARTBEAT_MS,
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS,
  PROJECT_WRITE_LEASE_TTL_MS,
  PROJECT_WRITE_LOCK_TABLE,
  PROJECT_WRITE_PURPOSES,
  assertWriteBindingMatchesGuard,
  projectWriteScopeKey,
  writeBindingFromGeneration,
} = lockModule
const kit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const SHEET = 'sheet_swl_lock'
const PROJECT = 'SYN-SWL-0002'
const TTL = PROJECT_WRITE_LEASE_TTL_MS
const GRACE = PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS

function setup(options = {}) {
  const clock = kit.createClock()
  const env = kit.createInMemoryProjectWriteLock({ clock, ...options })
  const scope = projectWriteScopeKey(SHEET, PROJECT)
  const row = () => env.db.rows(PROJECT_WRITE_LOCK_TABLE).find((r) => r.scope_key === scope) || null
  return { ...env, clock, scope, row }
}

function rejectsWith(code, status) {
  return (error) => {
    assert.equal(error.code, code, `code (${error.code}: ${error.message})`)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  }
}

// ── L1 ────────────────────────────────────────────────────────────────────────────────────────────
test('L1 scope key: golden literal, values-free, depends on sheet and project only', () => {
  const key = projectWriteScopeKey('sheet_swl_golden', 'SYN-SWL-0001')
  assert.equal(key, 'spw1:45e4ea1873f903f78cd7e3c4bf5167903f913293571c09b3a44f6139e13f10fa')
  assert.equal(key, `spw1:${crypto.createHash('sha256').update(JSON.stringify(['stock-prep/project-write/v1', 'sheet_swl_golden', 'SYN-SWL-0001'])).digest('hex')}`)
  assert.equal(key.includes('SYN-SWL'), false, 'no project number in the key')
  assert.equal(key.includes('sheet_swl'), false, 'no sheet id in the key')
  assert.equal(projectWriteScopeKey(' sheet_swl_golden ', ' SYN-SWL-0001 '), key, 'trimmed')
  assert.notEqual(projectWriteScopeKey('sheet_swl_other', 'SYN-SWL-0001'), key, 'another sheet is another scope')
  assert.notEqual(projectWriteScopeKey('sheet_swl_golden', 'SYN-SWL-0009'), key, 'another project is another scope')
  assert.equal(projectWriteScopeKey.length, 2, 'the identity takes exactly (sheet, project) — no tenant, no action')
  assert.throws(() => projectWriteScopeKey('', 'SYN-SWL-0001'), rejectsWith(PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 500))
  assert.throws(() => projectWriteScopeKey('sheet_swl_golden', '  '), rejectsWith(PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 500))
})

test('L1 two tenants naming one sheet + project share one row (tenant is audit-only)', async () => {
  const { lock, scope, db } = setup()
  await lock.bumpGeneration(scope, { reason: 'small_preview', tenantId: 'tenant-swl-a' })
  await lock.bumpGeneration(scope, { reason: 'small_preview', tenantId: 'tenant-swl-b' })
  const rows = db.rows(PROJECT_WRITE_LOCK_TABLE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].generation, 2)
  assert.equal(rows[0].tenant_id, 'tenant-swl-b', 'the last bumper, for audit')
  const grant = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-run', tenantId: 'tenant-swl-a' })
  await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-run-2', tenantId: 'tenant-swl-b' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
  assert.equal(grant.generation, 2)
})

// ── L2 ────────────────────────────────────────────────────────────────────────────────────────────
test('L2 acquire -> busy -> release -> acquire; generation and token persist; the row is never deleted', async () => {
  const { lock, scope, db, row } = setup()
  const bumped = await lock.bumpGeneration(scope, { reason: 'small_preview' })
  assert.equal(bumped.generation, 1)
  let inside = null
  await lock.withProjectWriteLease(scope, { purpose: 'small_apply', runId: 'swl-run-1' }, async (guard) => {
    inside = guard
    assert.equal(guard.generation, 1)
    assert.equal(guard.generationToken, bumped.generationToken)
    assert.equal(guard.fencingEpoch, 1)
    assert.equal(guard.priorFencingEpoch, 0)
    assert.equal(guard.takeover, false)
    await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-run-2' }), (error) => {
      assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
      assert.equal(error.status, 409)
      assert.equal(error.details.holderPurpose, 'small_apply')
      assert.equal(typeof error.details.leaseExpiresAt, 'string')
      assert.equal(error.details.retryAfterMs, TTL + GRACE)
      assert.equal(error.details.interrupted, false)
      assert.equal(JSON.stringify(error.details).includes('swl-run-1'), false, 'no holder run id is answered')
      return true
    })
    await assert.rejects(() => lock.assertNoLiveWriter(scope), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
    await guard.beforeWrite()
  })
  assert.equal(row().lease_id, null, 'released')
  assert.equal(row().generation, 1)
  assert.equal(row().generation_token, bumped.generationToken)
  await lock.assertNoLiveWriter(scope)
  await assert.rejects(() => inside.beforeWrite(), rejectsWith(PROJECT_WRITE_ERROR_CODES.LEASE_LOST, 409), 'a released guard cannot write')
  const second = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-run-3' })
  assert.equal(second.fencingEpoch, 2, 'every acquisition advances the epoch')
  assert.equal(second.generationToken, bumped.generationToken)
  assert.equal(db.log.filter(([method]) => method === 'deleteRows').length, 0, 'never deleted')
  assert.equal(db.rows(PROJECT_WRITE_LOCK_TABLE).length, 1)
})

test('L2 acquire on an absent row inserts generation 0 with its own token; a later bump moves it', async () => {
  const { lock, scope, row } = setup()
  const grant = await lock.acquire(scope, { purpose: 'large_apply_chunk', runId: 'swl-job' })
  assert.equal(grant.generation, 0)
  assert.equal(typeof grant.generationToken, 'string')
  assert.equal(row().fencing_epoch, 1)
  const guard = lock.createGuard(grant)
  await guard.release()
  const bumped = await lock.bumpGeneration(scope, { reason: 'large_approval' })
  assert.equal(bumped.generation, 1)
  assert.notEqual(bumped.generationToken, grant.generationToken)
})

// ── L3 ────────────────────────────────────────────────────────────────────────────────────────────
test('L3 bump on a free row: +1 and a fresh token; on a live lease (grace included): WRITE_LOCKED and nothing moves', async () => {
  const { lock, scope, row, clock } = setup()
  const first = await lock.bumpGeneration(scope, { reason: 'small_preview' })
  const second = await lock.bumpGeneration(scope, { reason: 'small_preview' })
  assert.equal(second.generation, first.generation + 1)
  assert.notEqual(second.generationToken, first.generationToken)
  const grant = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-run' })
  const before = row()
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'small_preview' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
  clock.advance(TTL + GRACE - 1)
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'large_approval' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409), 'still live inside the grace')
  assert.deepEqual(row(), before, 'a refused bump changes nothing')
  assert.equal(grant.generationToken, second.generationToken)
})

test('L3 bump on an ABANDONED lease (beyond expiry + grace): clears it, records the interruption, advances the epoch, bumps', async () => {
  const { lock, scope, row, clock } = setup()
  await lock.bumpGeneration(scope, { reason: 'small_preview' })
  const grant = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-run-abandoned' })
  clock.advance(TTL + GRACE)
  const bumped = await lock.bumpGeneration(scope, { reason: 'small_preview' })
  assert.equal(bumped.generation, 2)
  const after = row()
  assert.equal(after.lease_id, null)
  assert.equal(after.lease_expires_at, null)
  assert.equal(after.fencing_epoch, grant.fencingEpoch + 1)
  assert.equal(after.last_interrupted_purpose, 'small_apply')
  assert.equal(after.last_interrupted_run_id, 'swl-run-abandoned')
  assert.equal(typeof after.last_interrupted_at, 'string')
  const state = await lock.readState(scope)
  assert.equal(state.lastInterruptedPurpose, 'small_apply')
  assert.equal(JSON.stringify(state).includes('swl-run-abandoned'), false, 'readState is values-free')
  const guard = lock.createGuard(grant)
  await assert.rejects(() => guard.beforeWrite(), rejectsWith(PROJECT_WRITE_ERROR_CODES.LEASE_LOST, 409))
})

test('L3 bindings compare the TOKEN, never the integer: a row reset to the same generation does not revive an old binding', async () => {
  const { lock, scope, db } = setup()
  const old = await lock.bumpGeneration(scope, { reason: 'small_preview' })
  const binding = writeBindingFromGeneration(old)
  // Simulate a reset row that happens to carry the same integer generation with a new token.
  const table = db.tables.get(PROJECT_WRITE_LOCK_TABLE)
  table.set(scope, { ...table.get(scope), generation_token: 'swl-reset-token' })
  const grant = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-run' })
  assert.equal(grant.generation, old.generation, 'same integer')
  assert.throws(() => assertWriteBindingMatchesGuard(binding, grant), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(error.details.reason, 'newer_plan')
    return true
  })
  assert.throws(() => assertWriteBindingMatchesGuard({}, grant), (error) => error.details.reason === 'token_unbound')
  assert.throws(() => assertWriteBindingMatchesGuard({}, grant, { unboundReason: 'job_unbound' }), (error) => error.details.reason === 'job_unbound')
  assert.throws(() => assertWriteBindingMatchesGuard({ ...binding, writeScope: 'spw1:other' }, grant), (error) => error.details.reason === 'scope_changed')
})

// ── L4 ────────────────────────────────────────────────────────────────────────────────────────────
test('L4 renew after a takeover -> LEASE_LOST (fence error); a token-only change under our own lease -> PLAN_SUPERSEDED', async () => {
  const a = setup()
  const grantA = await a.lock.acquire(a.scope, { purpose: 'small_apply', runId: 'swl-a' })
  const guardA = a.lock.createGuard(grantA)
  await guardA.beforeWrite()
  a.clock.advance(TTL + GRACE)
  const grantB = await a.lock.acquire(a.scope, { purpose: 'small_apply', runId: 'swl-b' })
  assert.equal(grantB.takeover, true)
  assert.equal(grantB.priorFencingEpoch, grantA.fencingEpoch)
  await assert.rejects(() => guardA.beforeWrite(), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
    assert.equal(error.status, 409)
    assert.equal(error.fence, true)
    return true
  })
  assert.equal(a.row().last_interrupted_run_id, 'swl-a')

  const b = setup()
  const grant = await b.lock.acquire(b.scope, { purpose: 'small_apply', runId: 'swl-c' })
  const guard = b.lock.createGuard(grant)
  const table = b.db.tables.get(PROJECT_WRITE_LOCK_TABLE)
  table.set(b.scope, { ...table.get(b.scope), generation_token: 'swl-moved-token', generation: 7 })
  await assert.rejects(() => guard.beforeWrite(), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(error.details.reason, 'newer_plan')
    assert.equal(error.fence, true)
    return true
  })
  await assert.rejects(() => guard.beforeWrite(), rejectsWith(PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED), 'a lost guard stays lost')
})

// ── L5 ────────────────────────────────────────────────────────────────────────────────────────────
test('L5 every store failure is 503 STORE_FAILED (never busy, never proceed)', async () => {
  const sqlError = Object.assign(new Error('relation does not exist'), { code: '42P01' })
  {
    const { lock, scope, db } = setup()
    db.faults.selectOne = sqlError
    await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply' }), (error) => {
      assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
      assert.equal(error.status, 503)
      assert.equal(error.details.operation, 'acquire')
      assert.equal(error.details.sqlState, '42P01')
      assert.equal(JSON.stringify(error.details).includes('relation'), false, 'no driver message')
      return true
    })
  }
  {
    const { lock, scope, db } = setup()
    db.faults.insertOne = Object.assign(new Error('connection reset'), { code: '08006' })
    await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503), 'a non-23505 insert failure is NOT busy')
  }
  {
    const { lock, scope, db } = setup()
    db.faults.insertOne = kit.uniqueViolation()
    await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503), '23505 then a re-read that finds no row')
  }
  {
    const { lock, scope, db } = setup()
    const grant = await lock.acquire(scope, { purpose: 'small_apply' })
    const guard = lock.createGuard(grant)
    db.faults.updateRow = new Error('timeout')
    await assert.rejects(() => guard.beforeWrite(), (error) => {
      assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
      assert.equal(error.status, 503)
      assert.equal(error.fence, true, 'a failed pre-write CAS stops the writer')
      return true
    })
  }
  {
    const { lock, scope, db } = setup()
    db.faults.selectOne = new Error('down')
    await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'small_preview' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503))
    db.faults.selectOne = new Error('down')
    await assert.rejects(() => lock.assertNoLiveWriter(scope), rejectsWith(PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503))
    db.faults.updateRow = new Error('down')
    await lock.bumpGeneration(scope, { reason: 'small_preview' }) // insert path, no update
    await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'small_preview' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503))
  }
})

// ── L6 ────────────────────────────────────────────────────────────────────────────────────────────
test('L6 takeover: 1 ms before expiry + grace is still busy; at expiry + grace it is taken over', async () => {
  const { lock, scope, clock, row } = setup()
  const grant = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-old' })
  clock.advance(TTL + GRACE - 1)
  await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-new' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
  clock.advance(1)
  const taken = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-new' })
  assert.equal(taken.takeover, true)
  assert.equal(taken.fencingEpoch, grant.fencingEpoch + 1)
  assert.equal(row().last_interrupted_run_id, 'swl-old')
  assert.equal(row().lease_seq, 0)
})

// ── L7 ────────────────────────────────────────────────────────────────────────────────────────────
test('L7 a takeover is pinned to the observed seq: a holder that renews between the read and the CAS keeps its lease', async () => {
  const { lock, scope, clock, db } = setup()
  const grant = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-holder' })
  const holder = lock.createGuard(grant)
  clock.advance(TTL + GRACE) // the holder LOOKS abandoned to a reader now
  let renewed = false
  db.pauses.updateRow = async (args) => {
    // Hold the TAKEOVER CAS (it records an interruption) until the holder has renewed.
    if (!renewed && args.set && args.set.last_interrupted_at !== undefined) {
      renewed = true
      await holder.beforeWrite()
    }
  }
  await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-taker' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
  assert.equal(renewed, true, 'calibration: the renew ran inside the takeover window')
  delete db.pauses.updateRow
  await holder.beforeWrite() // still ours
})

// ── L8 ────────────────────────────────────────────────────────────────────────────────────────────
test('L8 two concurrent bumps both land (+2), each with its own token', async () => {
  const { lock, scope, db, row } = setup()
  await lock.bumpGeneration(scope, { reason: 'small_preview' })
  // Both read generation 1 before either updates.
  let reads = 0
  const bothRead = kit.deferred()
  db.pauses.updateRow = async () => {
    if (reads < 2) {
      reads += 1
      if (reads === 2) bothRead.resolve()
      await bothRead.promise
    }
  }
  const [x, y] = await Promise.all([
    lock.bumpGeneration(scope, { reason: 'small_preview' }),
    lock.bumpGeneration(scope, { reason: 'large_approval' }),
  ])
  assert.deepEqual([x.generation, y.generation].sort(), [2, 3])
  assert.notEqual(x.generationToken, y.generationToken)
  assert.equal(row().generation, 3)
})

// ── L9 ────────────────────────────────────────────────────────────────────────────────────────────
test('L9 acquire vs bump: the bump read a free row, the lease was granted before its CAS — the bump is refused, nothing moves', async () => {
  const { lock, scope, db, row } = setup()
  const start = await lock.bumpGeneration(scope, { reason: 'small_preview' })
  let grant = null
  db.pauses.updateRow = async (args) => {
    // The bump's free-row CAS (it sets a generation): let the acquire in first.
    if (!grant && args.set && args.set.generation !== undefined) {
      grant = await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-writer' })
    }
  }
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'small_preview' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
  assert.ok(grant, 'calibration: the acquire ran inside the bump window')
  assert.equal(row().generation, start.generation)
  assert.equal(row().generation_token, start.generationToken)
  assert.equal(grant.generationToken, start.generationToken)
  delete db.pauses.updateRow
  await lock.createGuard(grant).beforeWrite()
})

// ── L10 ───────────────────────────────────────────────────────────────────────────────────────────
test('L10 the heartbeat keeps a long run alive past TTL + GRACE, and is skipped while a pre-write CAS is in flight', async () => {
  const { lock, scope, clock, timers, db } = setup()
  await lock.withProjectWriteLease(scope, { purpose: 'small_apply', runId: 'swl-long' }, async (guard) => {
    assert.equal(timers.active.size, 1, 'one heartbeat timer while held')
    assert.equal(Array.from(timers.active.values())[0].ms, PROJECT_WRITE_LEASE_HEARTBEAT_MS)
    for (let i = 0; i < 6; i += 1) {
      clock.advance(PROJECT_WRITE_LEASE_HEARTBEAT_MS)
      await timers.fireAll()
    }
    // 180 s have passed (> TTL); without the heartbeat the lease would have expired at 120 s.
    await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-other' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
    // No overlap: hold a pre-write CAS mid-flight, fire the heartbeat — it must not issue its own.
    const gate = kit.deferred()
    let entered = kit.deferred()
    db.pauses.updateRow = async () => { entered.resolve(); await gate.promise }
    const write = guard.beforeWrite()
    await entered.promise
    const updatesBefore = db.log.filter(([m]) => m === 'updateRow').length
    await timers.fireAll()
    assert.equal(db.log.filter(([m]) => m === 'updateRow').length, updatesBefore, 'the heartbeat skipped')
    gate.resolve()
    await write
    delete db.pauses.updateRow
    await guard.beforeWrite()
  })
  assert.equal(timers.active.size, 0, 'the heartbeat stops on release')
})

test('L10 a failed heartbeat marks the guard lost: the next pre-write check aborts without writing', async () => {
  const { lock, scope, timers, db } = setup()
  await lock.withProjectWriteLease(scope, { purpose: 'small_apply', runId: 'swl-hb' }, async (guard) => {
    db.faults.updateRow = new Error('down')
    await timers.fireAll()
    assert.equal(guard.isLost(), true)
    const updates = db.log.filter(([m]) => m === 'updateRow').length
    await assert.rejects(() => guard.beforeWrite(), rejectsWith(PROJECT_WRITE_ERROR_CODES.STORE_FAILED, 503))
    assert.equal(db.log.filter(([m]) => m === 'updateRow').length, updates, 'aborted without another CAS')
  })
})

// ── L11 ───────────────────────────────────────────────────────────────────────────────────────────
test('L11 constants and vocabularies are pinned', () => {
  assert.equal(PROJECT_WRITE_LOCK_TABLE, 'integration_stock_prep_project_write_lock')
  assert.equal(PROJECT_WRITE_LEASE_TTL_MS, 120000)
  assert.equal(PROJECT_WRITE_LEASE_HEARTBEAT_MS, 30000)
  assert.equal(PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS, 120000)
  assert.equal(PROJECT_WRITE_BUMP_MAX_ATTEMPTS, 5)
  assert.deepEqual(PROJECT_WRITE_PURPOSES, ['small_apply', 'large_apply_chunk'])
  assert.deepEqual(PROJECT_WRITE_GENERATION_REASONS, ['small_preview', 'large_approval'])
  assert.deepEqual(PROJECT_WRITE_ERROR_CODES, {
    WRITE_LOCKED: 'STOCK_PREP_PROJECT_WRITE_LOCKED',
    PLAN_SUPERSEDED: 'STOCK_PREP_PROJECT_PLAN_SUPERSEDED',
    LEASE_LOST: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST',
    STORE_FAILED: 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED',
    UNAVAILABLE: 'STOCK_PREP_PROJECT_WRITE_LOCK_UNAVAILABLE',
    GUARD_SCOPE_MISMATCH: 'STOCK_PREP_PROJECT_WRITE_GUARD_SCOPE_MISMATCH',
  })
  assert.ok(PROJECT_WRITE_LEASE_HEARTBEAT_MS * 2 < PROJECT_WRITE_LEASE_TTL_MS, 'at least two heartbeats per TTL')
})

test('L11 an unknown purpose / reason is refused before any IO', async () => {
  const { lock, scope, db } = setup()
  await assert.rejects(() => lock.acquire(scope, { purpose: 'something_else' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 500))
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'something_else' }), rejectsWith(PROJECT_WRITE_ERROR_CODES.UNAVAILABLE, 500))
  assert.equal(db.log.length, 0)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-write-lock.test.cjs', tests, { passLine: '✓ stock-preparation-project-write-lock' })
