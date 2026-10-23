'use strict'

// Batch-refresh phase 0 step 1 — the PROJECT WRITE LOCK module (lib/stock-preparation-project-write-lock.cjs)
// against a faithful fake of the scoped db helper (support/stock-preparation-project-write-lock-kit.cjs):
//
//   L1  scope key: deterministic golden literal, values-free, the target sheet only (R-52) — project and
//       tenant are not identity
//   L2  acquire / busy / release; the generation survives; the row is never deleted
//   L3  bump: free row, live lease (refused), abandoned lease (cleared + bumped + interruption recorded)
//   L4  a holder whose lease was taken over gets LEASE_LOST; a token-only change gets PLAN_SUPERSEDED
//   L5  every store failure is 503 STORE_FAILED — never a busy 409, never "proceed"
//   L6  takeover exactly at expiry + grace (1 ms before: still busy)
//   L7  a takeover CAS is pinned to the observed seq: a holder that renewed in between keeps its lease
//   L8  two concurrent bumps both land (+2), each with its own token; exhausted contention is "busy", not
//       "another run is writing"
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
  PROJECT_WRITE_BUMP_BACKOFF_MS,
  PROJECT_WRITE_BUMP_MAX_ATTEMPTS,
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_GENERATION_REASONS,
  PROJECT_WRITE_LEASE_HEARTBEAT_MS,
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS,
  PROJECT_WRITE_LEASE_TTL_MS,
  PROJECT_WRITE_LOCK_TABLE,
  PROJECT_WRITE_PURPOSES,
  assertWriteBindingMatchesGuard,
  sheetWriteScopeKey,
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
  const scope = sheetWriteScopeKey(SHEET)
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
test('L1 scope key: golden literal, values-free, the target sheet only (R-52)', () => {
  const key = sheetWriteScopeKey('sheet_swl_golden')
  assert.equal(key, 'spw2:d26fdc5170bf78a4749246cbaf60ec3619d0a9b636c57cdd712f5f267a3d9746')
  assert.equal(key, `spw2:${crypto.createHash('sha256').update(JSON.stringify(['stock-prep/sheet-write/v2', 'sheet_swl_golden'])).digest('hex')}`)
  assert.equal(key.includes('sheet_swl'), false, 'no sheet id in the key')
  assert.equal(sheetWriteScopeKey(' sheet_swl_golden '), key, 'trimmed')
  assert.notEqual(sheetWriteScopeKey('sheet_swl_other'), key, 'another sheet is another scope')
  assert.equal(sheetWriteScopeKey.length, 1, 'the identity takes exactly the sheet — no project, no tenant, no action')
  assert.throws(() => sheetWriteScopeKey(''), rejectsWith(PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 500))
  assert.throws(() => sheetWriteScopeKey('  '), rejectsWith(PROJECT_WRITE_ERROR_CODES.GUARD_SCOPE_MISMATCH, 500))
})

test('L1 two tenants naming one sheet share one row (tenant is audit-only)', async () => {
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

test('L5 (review round 1) bump: a PRIMARY KEY conflict followed by a re-read that finds no row is STORE_FAILED row_vanished, never busy', async () => {
  const { lock, scope, db } = setup({ bumpBackoffMs: 0 })
  db.faults.insertOne = () => kit.uniqueViolation()
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'small_preview' }), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
    assert.equal(error.status, 503)
    assert.equal(error.details.operation, 'bump')
    assert.equal(error.details.reason, 'row_vanished')
    return true
  })
  assert.equal(db.log.filter(([m]) => m === 'insertOne').length, 1, 'one insert, then the store fault — no retry loop ending in busy')
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

test('L8 (review round 1) bumps that lose every CAS race on a FREE row give up as contention: no writer claimed, with backoff between attempts', async () => {
  const slept = []
  const { lock, scope, db, row } = setup({ sleep: async (ms) => { slept.push(ms) } })
  await lock.bumpGeneration(scope, { reason: 'small_preview' })
  // Before each of this bump's CASes another bump lands first (the token moves), so every CAS misses.
  db.pauses.updateRow = async (args) => {
    if (args.set && args.set.generation !== undefined && args.where && args.where.lease_id === null) {
      const table = db.tables.get(PROJECT_WRITE_LOCK_TABLE)
      const current = table.get(scope)
      table.set(scope, { ...current, generation: current.generation + 1, generation_token: `swl-other-${current.generation + 1}` })
    }
  }
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'small_preview' }), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 'still a retryable 409')
    assert.equal(error.status, 409)
    assert.equal(error.details.reason, 'contention')
    assert.equal('holderPurpose' in error.details, false, 'no holder is named — none exists')
    assert.doesNotMatch(error.message, /another run is writing/)
    return true
  })
  assert.equal(row().lease_id, null, 'calibration: no lease was ever held')
  assert.deepEqual(slept, [1, 2, 3, 4].map((n) => n * PROJECT_WRITE_BUMP_BACKOFF_MS), 'a growing backoff between the five attempts')
})

test('L8 (review round 2) a bump that loses every race re-reads once: a holder that appeared meanwhile is named, not "contention"', async () => {
  const { lock, scope, db, clock } = setup({ bumpBackoffMs: 0 })
  await lock.bumpGeneration(scope, { reason: 'small_preview' })
  let bumpCas = 0
  db.pauses.updateRow = async (args) => {
    if (!(args.set && args.set.generation !== undefined && args.where && args.where.lease_id === null)) return
    bumpCas += 1
    const table = db.tables.get(PROJECT_WRITE_LOCK_TABLE)
    const current = table.get(scope)
    const moved = { ...current, generation: current.generation + 1, generation_token: `swl-other-${bumpCas}` }
    if (bumpCas === PROJECT_WRITE_BUMP_MAX_ATTEMPTS) {
      // While the last attempt is in flight, another process acquires the sheet.
      const at = clock.now()
      Object.assign(moved, {
        lease_id: 'swl-late-holder', lease_seq: 0, lease_purpose: 'small_apply', lease_run_id: 'swl-late',
        lease_acquired_at: at.toISOString(), lease_expires_at: new Date(at.getTime() + PROJECT_WRITE_LEASE_TTL_MS).toISOString(),
      })
    }
    table.set(scope, moved)
  }
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'small_preview' }), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.equal(error.details.holderPurpose, 'small_apply', 'the late holder is named')
    assert.notEqual(error.details.reason, 'contention')
    return true
  })
  assert.equal(bumpCas, PROJECT_WRITE_BUMP_MAX_ATTEMPTS, 'calibration: every attempt lost its race')
})

test('L8 (review round 2) acquire losing BOTH CAS races: no live holder after them -> contention; a holder that took the sheet -> named', async () => {
  for (const variant of ['contention', 'holder']) {
    const { lock, scope, db, clock } = setup()
    await lock.bumpGeneration(scope, { reason: 'small_preview' }) // a free row exists
    let acquireCas = 0
    db.pauses.updateRow = async (args) => {
      // acquire's free-row CAS: it sets a lease and pins lease_id IS NULL
      if (!(args.set && args.set.lease_id && args.where && args.where.lease_id === null)) return
      acquireCas += 1
      const table = db.tables.get(PROJECT_WRITE_LOCK_TABLE)
      const current = table.get(scope)
      const moved = { ...current, fencing_epoch: current.fencing_epoch + 1 } // someone acquired + released
      if (variant === 'holder' && acquireCas === 2) {
        const at = clock.now()
        Object.assign(moved, {
          lease_id: 'swl-racer', lease_seq: 0, lease_purpose: 'large_apply_chunk', lease_run_id: 'swl-racer',
          lease_acquired_at: at.toISOString(), lease_expires_at: new Date(at.getTime() + PROJECT_WRITE_LEASE_TTL_MS).toISOString(),
        })
      }
      table.set(scope, moved)
    }
    await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply' }), (error) => {
      assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
      if (variant === 'contention') {
        assert.equal(error.details.reason, 'contention')
        assert.equal('holderPurpose' in error.details, false)
        assert.doesNotMatch(error.message, /another run is writing/)
      } else {
        assert.equal(error.details.holderPurpose, 'large_apply_chunk')
        assert.notEqual(error.details.reason, 'contention')
      }
      return true
    })
    assert.equal(acquireCas, 2, `calibration (${variant}): both CAS races were lost`)
  }
})

test('L8 (review round 1) acquire that loses both CAS races to a LIVE holder still names the writer', async () => {
  const { lock, scope } = setup()
  await lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-holder' })
  await assert.rejects(() => lock.acquire(scope, { purpose: 'small_apply' }), (error) => {
    assert.equal(error.details.holderPurpose, 'small_apply')
    assert.notEqual(error.details.reason, 'contention')
    return true
  })
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
  assert.equal(PROJECT_WRITE_BUMP_BACKOFF_MS, 10)
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


// ── L12–L14: Codex review P1-a / P1-b ─────────────────────────────────────────────────────────────────
test('L11b the superseded-reason and host-fence vocabularies are pinned', () => {
  assert.deepEqual(lockModule.PLAN_SUPERSEDED_REASONS, ['newer_plan', 'token_unbound', 'scope_changed', 'job_unbound', 'expansion_stale', 'expansion_unbound'])
  assert.deepEqual(lockModule.HOST_WRITE_FENCE_CODES, {
    NOT_ALLOWED: 'PLUGIN_WRITE_FENCE_NOT_ALLOWED',
    REJECTED: 'PLUGIN_WRITE_FENCE_REJECTED',
    UNAVAILABLE: 'PLUGIN_WRITE_FENCE_UNAVAILABLE',
  })
  for (const code of Object.values(lockModule.HOST_WRITE_FENCE_CODES)) assert.equal(lockModule.isHostWriteFenceError({ code }), true)
  assert.equal(lockModule.isHostWriteFenceError({ code: 'VALIDATION_ERROR' }), false)
  assert.equal(lockModule.isHostWriteFenceError(null), false)
})

test('L12 observeGeneration / readGeneration are read-only; observe refuses a LIVE writer only', async () => {
  const { lock, scope, db, clock } = setup()
  const absent = await lock.observeGeneration(scope)
  assert.deepEqual({ ...absent }, { scopeKey: scope, present: false, generation: 0, generationToken: null, fencingEpoch: 0 })
  assert.equal(db.rows(PROJECT_WRITE_LOCK_TABLE).length, 0, 'L12: observing writes nothing (a read-tier caller observes)')
  assert.deepEqual({ ...lockModule.writeObservationFromGeneration(absent) }, { writeScope: scope, generationToken: null, fencingEpoch: 0 })
  const bumped = await lock.bumpGeneration(scope, { reason: 'small_preview' })
  const seen = await lock.observeGeneration(scope)
  assert.equal(seen.generationToken, bumped.generationToken)
  assert.equal(seen.fencingEpoch, 0)
  const grant = await lock.acquire(scope, { purpose: 'small_apply' })
  await assert.rejects(() => lock.observeGeneration(scope), rejectsWith(PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED, 409))
  const read = await lock.readGeneration(scope)
  assert.equal(read.generationToken, bumped.generationToken, 'L12: readGeneration does not refuse a live lease')
  assert.equal(read.fencingEpoch, grant.fencingEpoch)
  clock.advance(TTL + GRACE)
  const abandoned = await lock.observeGeneration(scope)
  assert.equal(abandoned.fencingEpoch, grant.fencingEpoch, 'L12: an abandoned lease is observed, not refused')
})

test('L13 bumpGeneration(expect): bumps only while token AND epoch are what the expansion observed', async () => {
  const { lock, scope, row } = setup()
  // absent -> absent: the first bump of the sheet
  const first = await lock.bumpGeneration(scope, { reason: 'large_approval', expect: { generationToken: null, fencingEpoch: 0 } })
  assert.equal(first.generation, 1)
  // absent expected, row present -> stale
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'large_approval', expect: { generationToken: null, fencingEpoch: 0 } }), (error) => {
    assert.equal(error.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
    assert.equal(error.details.reason, 'expansion_stale')
    assert.equal(error.details.partial, false)
    return true
  })
  // token moved -> stale, nothing bumped
  const observed = lockModule.writeObservationFromGeneration(await lock.observeGeneration(scope))
  await lock.bumpGeneration(scope, { reason: 'small_preview' })
  const g = row().generation
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'large_approval', expect: observed }), (error) => error.details.reason === 'expansion_stale')
  assert.equal(row().generation, g)
  // epoch moved (a write run acquired + released; the token did not move) -> stale
  const observed2 = lockModule.writeObservationFromGeneration(await lock.observeGeneration(scope))
  const grant = await lock.acquire(scope, { purpose: 'small_apply' })
  await lock.createGuard(grant).release()
  assert.equal(row().generation_token, observed2.generationToken, 'calibration: token unchanged')
  await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'large_approval', expect: observed2 }), (error) => error.details.reason === 'expansion_stale')
  // unchanged -> bumps and returns the new token
  const observed3 = lockModule.writeObservationFromGeneration(await lock.observeGeneration(scope))
  const ok = await lock.bumpGeneration(scope, { reason: 'large_approval', expect: observed3 })
  assert.equal(ok.generation, row().generation)
  assert.notEqual(ok.generationToken, observed3.generationToken)
  // malformed expectation -> 500 before any IO
  for (const bad of [{}, { generationToken: '', fencingEpoch: 0 }, { generationToken: null, fencingEpoch: 2 }, { generationToken: 't', fencingEpoch: -1 }, { generationToken: 't', fencingEpoch: 1.5 }]) {
    await assert.rejects(() => lock.bumpGeneration(scope, { reason: 'large_approval', expect: bad }), (error) => error.status === 500 && error.details.reason === 'expectation_malformed')
  }
})

test('L13b the epoch is PINNED in the CAS: an acquire + release between the bump\'s read and its CAS makes it stale', async () => {
  const { lock, scope, db, row } = setup()
  await lock.bumpGeneration(scope, { reason: 'small_preview' })
  const observed = lockModule.writeObservationFromGeneration(await lock.observeGeneration(scope))
  const gate = kit.deferred()
  const entered = kit.deferred()
  let paused = false
  db.pauses.updateRow = async (args) => {
    if (!paused && args.set && args.set.generation_reason === 'large_approval') { paused = true; entered.resolve(); await gate.promise }
  }
  const bump = lock.bumpGeneration(scope, { reason: 'large_approval', expect: observed })
  await entered.promise
  const grant = await lock.acquire(scope, { purpose: 'small_apply' })
  await lock.createGuard(grant).release()
  const generation = row().generation
  gate.resolve()
  await assert.rejects(() => bump, (error) => error.details.reason === 'expansion_stale')
  assert.equal(row().generation, generation, 'L13b: the in-flight CAS matched nothing')
})

test('L14 the guard\'s host-fence half: the fence it hands the host, the refusal mapping, the final re-assert', async () => {
  const { lock, scope, clock } = setup()
  const grant = await lock.acquire(scope, { purpose: 'small_apply' })
  const guard = lock.createGuard(grant)
  assert.deepEqual(guard.hostWriteFence(), { lock: PROJECT_WRITE_LOCK_TABLE, scopeKey: scope, leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch, generationToken: grant.generationToken })
  await guard.reassert()
  // NOT_ALLOWED -> 501, guard lost (no further write)
  const notAllowed = await guard.hostFenceRefused({ code: 'PLUGIN_WRITE_FENCE_NOT_ALLOWED' })
  assert.equal(notAllowed.status, 501)
  assert.equal(notAllowed.details.reason, 'host_fence_not_allowed')
  assert.equal(notAllowed.fence, true)
  await assert.rejects(() => guard.beforeWrite({ index: 0, operation: 'createRecord' }), (error) => error === notAllowed)
  await assert.rejects(() => guard.reassert(), (error) => error === notAllowed)
  await guard.release()
  // UNAVAILABLE -> STORE_FAILED (503)
  const g2 = lock.createGuard(await lock.acquire(scope, { purpose: 'small_apply' }))
  const unavailable = await g2.hostFenceRefused({ code: 'PLUGIN_WRITE_FENCE_UNAVAILABLE' })
  assert.equal(unavailable.code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
  assert.equal(unavailable.status, 503)
  await g2.release()
  // REJECTED after a takeover -> LEASE_LOST; REJECTED after a bump under our own lease -> PLAN_SUPERSEDED
  const g3 = lock.createGuard(await lock.acquire(scope, { purpose: 'small_apply' }))
  clock.advance(TTL + GRACE)
  await lock.acquire(scope, { purpose: 'large_apply_chunk' })
  const rejected = await g3.hostFenceRefused({ code: 'PLUGIN_WRITE_FENCE_REJECTED' })
  assert.equal(rejected.code, PROJECT_WRITE_ERROR_CODES.LEASE_LOST)
  assert.equal(rejected.fence, true)
  // the final re-assert sees a loss after the last write
  const { lock: lock2, scope: scope2, clock: clock2, db: db2 } = setup()
  const g4 = lock2.createGuard(await lock2.acquire(scope2, { purpose: 'small_apply' }))
  const current = db2.rows(PROJECT_WRITE_LOCK_TABLE)[0]
  await db2.updateRow(PROJECT_WRITE_LOCK_TABLE, { generation_token: 'tok-syn-moved' }, { scope_key: current.scope_key })
  const superseded = await g4.hostFenceRefused({ code: 'PLUGIN_WRITE_FENCE_REJECTED' })
  assert.equal(superseded.code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
  assert.equal(superseded.details.reason, 'newer_plan')
  const g5 = lock2.createGuard(await (async () => { clock2.advance(TTL + GRACE); return lock2.acquire(scope2, { purpose: 'small_apply' }) })())
  clock2.advance(TTL + GRACE)
  await lock2.bumpGeneration(scope2, { reason: 'small_preview' })
  await assert.rejects(() => g5.reassert(), (error) => error.code === PROJECT_WRITE_ERROR_CODES.LEASE_LOST && error.fence === true)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-write-lock.test.cjs', tests, { passLine: '✓ stock-preparation-project-write-lock' })
