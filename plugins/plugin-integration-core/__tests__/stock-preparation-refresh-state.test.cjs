'use strict'

// Batch-refresh step 4, PR-1 — `readProjectRefreshState(consult)`, the pure derivation of design §9.1,
// over FAKE consult answers (the store and the governance reader are PR-2). Every status predicate, the
// first-match order, the three distinct answers (not_governed / unreadable / governed), the counters and
// the export predicate (U01 / A11 unit halves).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  STATUS_TOKENS,
  readProjectRefreshState,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-refresh-state.cjs'))

const tests = []
function test(name, fn) {
  tests.push([name, fn])
}

function freeLock() {
  return { state: { present: true, leaseHeld: false, leaseLive: false }, generation: { generationToken: 'g1', fencingEpoch: 3, leaseId: null } }
}

function liveLock(leaseId = 'lease_live') {
  return { state: { present: true, leaseHeld: true, leaseLive: true }, generation: { generationToken: 'g1', fencingEpoch: 4, leaseId } }
}

function abandonedLock(leaseId = 'lease_dead') {
  return { state: { present: true, leaseHeld: true, leaseLive: false }, generation: { generationToken: 'g1', fencingEpoch: 4, leaseId } }
}

function consult(overrides = {}) {
  return {
    ok: true,
    pilot: null,
    continuations: [],
    holds: [],
    state: null,
    executions: [],
    changePlans: [],
    lock: freeLock(),
    ...overrides,
  }
}

const PILOT = { enabled: true, enabledAt: '2026-10-20T00:00:00.000Z', readinessVersion: 1 }
const CONTINUATION = { id: 'cont_1', status: 'active', revision: 1, executedExecutionId: 'exec_1', confirmedAt: '2026-10-21T00:00:00.000Z' }
const SETTLED_STATE = { settledAt: '2026-10-22T00:00:00.000Z', settledExecutionId: 'exec_1' }
const SUCCEEDED = { id: 'exec_1', status: 'succeeded', leaseId: 'lease_old', startedAt: '2026-10-21T01:00:00.000Z' }

function statusOf(answer) {
  return readProjectRefreshState(answer).status
}

test('not_governed: not pilot and every store answered with zero rows (a lock row alone does not govern)', () => {
  const answer = readProjectRefreshState(consult())
  assert.equal(answer.status, 'not_governed')
  assert.equal(answer.statusLabel, '未启用')
  assert.equal(answer.governed, 'none')
  assert.equal(answer.exportAllowed, true)
  assert.equal(answer.readable, true)
  assert.equal(statusOf(consult({ pilot: { enabled: false } })), 'not_governed')
})

test('A11: a thrown / failed / absent / malformed read is UNREADABLE — never not_governed, never "no rows"', () => {
  const cases = [
    new Error('relation does not exist'),
    { ok: false, failure: { store: 'continuation', operation: 'select' } },
    null,
    undefined,
    'ok',
    consult({ ok: 'true' }),
    consult({ continuations: undefined }),
    consult({ holds: null }),
    consult({ executions: [{ id: 'e', status: 'mystery' }] }),
    consult({ changePlans: [{ id: 'cp' }] }),
    consult({ lock: undefined }),
    consult({ lock: { state: {}, generation: { leaseId: null } } }),
    consult({ pilot: { enabled: 'yes' } }),
    consult({ state: [] }),
  ]
  for (const entry of cases) {
    const answer = readProjectRefreshState(entry)
    assert.equal(answer.status, 'unreadable', JSON.stringify(entry && entry.message ? 'Error' : entry))
    assert.equal(answer.readable, false)
    assert.equal(answer.governed, 'unknown')
    assert.equal(answer.exportAllowed, false)
    assert.equal(answer.statusLabel, '状态读取失败')
  }
  const failed = readProjectRefreshState({ ok: false, failure: { store: 'continuation', operation: 'select', message: 'secret value' } })
  assert.deepEqual(failed.unreadable, { reason: 'store_read_failed', store: 'continuation', operation: 'select' })
  assert.equal(JSON.stringify(failed).includes('secret value'), false, 'values-free')
})

test('A11: a FAILED LOCK READ next to a running execution is unreadable, never "the run died" (failed_pending_recovery)', () => {
  const running = { id: 'exec_2', status: 'running', leaseId: 'lease_x', startedAt: '2026-10-22T00:00:00.000Z' }
  assert.equal(statusOf(consult({ pilot: PILOT, executions: [running], lock: undefined })), 'unreadable')
  assert.equal(statusOf(consult({ pilot: PILOT, executions: [running], lock: { state: { leaseLive: true }, generation: { leaseId: 'lease_x' } } })), 'unreadable')
})

test('executing: a live lease (expiry + grace) — or a running execution whose lease is the live one', () => {
  assert.equal(statusOf(consult({ pilot: PILOT, lock: liveLock() })), 'executing')
  const running = { id: 'exec_2', status: 'running', leaseId: 'lease_live', startedAt: '2026-10-22T00:00:00.000Z' }
  assert.equal(statusOf(consult({ pilot: PILOT, executions: [running], lock: liveLock('lease_live') })), 'executing')
  // A live lease of ANOTHER run: still executing (first match), whatever the running row says.
  assert.equal(statusOf(consult({ pilot: PILOT, executions: [{ ...running, leaseId: 'lease_other' }], lock: liveLock('lease_live') })), 'executing')
  const answer = readProjectRefreshState(consult({ pilot: PILOT, lock: liveLock() }))
  assert.equal(answer.exportAllowed, false)
})

test('U01: a running execution with NO live lease is failed_pending_recovery (结果未知), never executing; partial / failed / aborted too', () => {
  const running = { id: 'exec_2', status: 'running', leaseId: 'lease_gone', startedAt: '2026-10-22T00:00:00.000Z' }
  assert.equal(statusOf(consult({ pilot: PILOT, executions: [running] })), 'failed_pending_recovery')
  assert.equal(statusOf(consult({ pilot: PILOT, executions: [running], lock: abandonedLock('lease_gone') })), 'failed_pending_recovery')
  for (const status of ['partial', 'failed', 'aborted']) {
    assert.equal(statusOf(consult({ pilot: PILOT, executions: [{ ...running, status }] })), 'failed_pending_recovery', status)
  }
  // An abandoned lease with no execution row at all: a writer died here too.
  assert.equal(statusOf(consult({ pilot: PILOT, lock: abandonedLock() })), 'failed_pending_recovery')
  // verified_closed is not pending.
  assert.equal(statusOf(consult({ pilot: PILOT, executions: [{ ...running, status: 'verified_closed' }] })), 'complete')
})

test('pending_confirmation: an open hold of any kind, or a continuation that needs re-confirmation', () => {
  assert.equal(statusOf(consult({ pilot: PILOT, holds: [{ id: 'h1', status: 'open', kind: 'candidate_shape_unresolved', confirmable: false }] })), 'pending_confirmation')
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [{ ...CONTINUATION, status: 'needs_reconfirmation' }], state: SETTLED_STATE, executions: [SUCCEEDED] })), 'pending_confirmation')
  // Resolved / superseded holds are history.
  assert.equal(statusOf(consult({ pilot: PILOT, holds: [{ id: 'h1', status: 'resolved', kind: 'continuation_candidate', confirmable: true }] })), 'complete')
})

test('change_pending_review: a change plan written and not reviewed', () => {
  assert.equal(statusOf(consult({ pilot: PILOT, changePlans: [{ id: 'cp1', status: 'written' }] })), 'change_pending_review')
  assert.equal(statusOf(consult({ pilot: PILOT, changePlans: [{ id: 'cp1', status: 'reviewed' }] })), 'complete')
})

test('confirmed_pending_execution: a confirmed revision not yet executed and not consumed by a later settlement; or a confirmed change plan', () => {
  const unexecuted = { ...CONTINUATION, executedExecutionId: null }
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [unexecuted] })), 'confirmed_pending_execution')
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [unexecuted], state: { settledAt: '2026-10-20T00:00:00.000Z', settledExecutionId: null } })), 'confirmed_pending_execution', 'a settlement BEFORE the confirm does not consume it')
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [unexecuted], state: { settledAt: '2026-10-22T00:00:00.000Z', settledExecutionId: null } })), 'complete')
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [{ ...unexecuted, confirmedAt: 'garbled' }], state: SETTLED_STATE })), 'confirmed_pending_execution', 'an unreadable timestamp never counts as consumed')
  assert.equal(statusOf(consult({ pilot: PILOT, changePlans: [{ id: 'cp1', status: 'confirmed' }] })), 'confirmed_pending_execution')
})

test('executed_pending_settlement: the newest execution succeeded and no clean computation has settled it yet', () => {
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [CONTINUATION], executions: [SUCCEEDED] })), 'executed_pending_settlement')
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [CONTINUATION], executions: [SUCCEEDED], state: { settledAt: '2026-10-22T00:00:00.000Z', settledExecutionId: 'exec_0' } })), 'executed_pending_settlement')
  const newer = { id: 'exec_9', status: 'succeeded', leaseId: 'lease_9', startedAt: '2026-10-23T00:00:00.000Z' }
  assert.equal(statusOf(consult({ pilot: PILOT, continuations: [CONTINUATION], executions: [SUCCEEDED, newer], state: SETTLED_STATE })), 'executed_pending_settlement', 'the NEWEST execution decides')
})

test('complete: settled, consumed, nothing open, lease free — export allowed; governed = pilot / protected', () => {
  const answer = readProjectRefreshState(consult({ pilot: PILOT, continuations: [CONTINUATION], executions: [SUCCEEDED], state: SETTLED_STATE }))
  assert.equal(answer.status, 'complete')
  assert.equal(answer.statusLabel, '已完成')
  assert.equal(answer.exportAllowed, true)
  assert.equal(answer.governed, 'pilot')
  const exited = readProjectRefreshState(consult({ pilot: { enabled: false }, continuations: [CONTINUATION], executions: [SUCCEEDED], state: SETTLED_STATE }))
  assert.equal(exited.governed, 'protected', 'pilot exit deletes nothing: the rows still govern (C10)')
  assert.equal(exited.status, 'complete')
  assert.equal(statusOf(consult({ pilot: PILOT })), 'complete', 'a pilot project with nothing to do')
})

test('first match wins, in the §9.1 order', () => {
  const everything = consult({
    pilot: PILOT,
    continuations: [{ ...CONTINUATION, status: 'needs_reconfirmation', executedExecutionId: null }],
    holds: [{ id: 'h1', status: 'open', kind: 'content_change', confirmable: false }],
    executions: [{ id: 'exec_2', status: 'failed', leaseId: 'l', startedAt: '2026-10-22T00:00:00.000Z' }],
    changePlans: [{ id: 'cp', status: 'written' }, { id: 'cp2', status: 'confirmed' }],
    lock: liveLock(),
  })
  assert.equal(statusOf(everything), 'executing')
  assert.equal(statusOf({ ...everything, lock: freeLock() }), 'failed_pending_recovery')
  assert.equal(statusOf({ ...everything, lock: freeLock(), executions: [] }), 'pending_confirmation')
  assert.equal(statusOf({ ...everything, lock: freeLock(), executions: [], holds: [], continuations: [] }), 'change_pending_review')
  assert.equal(statusOf({ ...everything, lock: freeLock(), executions: [], holds: [], continuations: [], changePlans: [{ id: 'cp2', status: 'confirmed' }] }), 'confirmed_pending_execution')
})

test('U01: every status other than not_governed / complete refuses the export; counters are reported separately', () => {
  for (const status of STATUS_TOKENS) {
    if (status === 'not_governed' || status === 'complete') continue
    const fixtures = {
      unreadable: { ok: false },
      executing: consult({ pilot: PILOT, lock: liveLock() }),
      failed_pending_recovery: consult({ pilot: PILOT, executions: [{ id: 'e', status: 'partial', leaseId: null, startedAt: '2026-10-22T00:00:00.000Z' }] }),
      pending_confirmation: consult({ pilot: PILOT, holds: [{ id: 'h', status: 'open', kind: 'continuation_candidate', confirmable: true }] }),
      change_pending_review: consult({ pilot: PILOT, changePlans: [{ id: 'cp', status: 'written' }] }),
      confirmed_pending_execution: consult({ pilot: PILOT, continuations: [{ ...CONTINUATION, executedExecutionId: null }] }),
      executed_pending_settlement: consult({ pilot: PILOT, executions: [SUCCEEDED] }),
    }
    const answer = readProjectRefreshState(fixtures[status])
    assert.equal(answer.status, status)
    assert.equal(answer.exportAllowed, false, status)
  }
  const counted = readProjectRefreshState(consult({
    pilot: PILOT,
    continuations: [CONTINUATION, { ...CONTINUATION, id: 'cont_2', status: 'ended' }],
    holds: [
      { id: 'h1', status: 'open', kind: 'continuation_candidate', confirmable: true },
      { id: 'h2', status: 'open', kind: 'candidate_shape_unresolved', confirmable: false },
      { id: 'h3', status: 'superseded', kind: 'content_change', confirmable: false },
    ],
    executions: [{ id: 'e1', status: 'failed', leaseId: null, startedAt: '2026-10-22T00:00:00.000Z' }, SUCCEEDED],
    changePlans: [{ id: 'cp', status: 'written' }],
  }))
  assert.deepEqual(counted.counts, { pendingConfirm: 2, confirmable: 1, openExecutions: 1, pendingReviews: 1, continuations: 1 })
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-state.test.cjs', tests)
