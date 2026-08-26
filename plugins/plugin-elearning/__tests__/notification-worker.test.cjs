'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  DEFAULT_LEASE_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  ERROR_CODE_RE,
  NOT_ELIGIBLE,
  ELIGIBILITY_UNAVAILABLE,
  OUTCOME_UNKNOWN,
  ATTEMPTS_EXHAUSTED,
  CLAIM_SQL,
  FINALIZE_SENT_SQL,
  FINALIZE_RETRYING_SQL,
  FINALIZE_FAILED_SQL,
  FINALIZE_OUTCOME_UNKNOWN_SQL,
  RELEASE_PENDING_SQL,
  computeNotificationBackoffMs,
  claimDueNotificationDeliveries,
  finalizeNotificationSent,
  finalizeNotificationRetrying,
  finalizeNotificationFailed,
  finalizeNotificationOutcomeUnknown,
  releaseClaimedNotificationDelivery,
  runNotificationDeliveryBatch,
} = require('../lib/notification-worker.cjs')

const WORKER = path.join(__dirname, '../lib/notification-worker.cjs')
const INDEX = path.join(__dirname, '../index.cjs')
const PACKAGE_JSON = path.join(__dirname, '../package.json')
const DELIVERY_A = '11111111-1111-4111-8111-111111111111'
const DELIVERY_B = '22222222-2222-4222-8222-222222222222'

function createThrowingDatabase() {
  return {
    query: async () => {
      throw new Error('notification worker must not touch the database')
    },
  }
}

function createFakeDatabase(handler) {
  const queries = []
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params })
      if (typeof handler === 'function') return handler(sql, params, queries)
      return []
    },
  }
}

function claimedRow(over) {
  return {
    id: DELIVERY_A,
    org_id: 'org-test',
    assignment_member_id: '33333333-3333-4333-8333-333333333333',
    kind: 'assignment_reminder',
    source_key: 'assignment:a:user:u:window:1',
    recipient_role: 'learner',
    recipient_user_id: 'user-a',
    channel: 'platform',
    payload: {},
    status: 'sending',
    attempt_count: 1,
    claim_worker_id: 'worker-a',
    ...over,
  }
}

function fenceSql(sql) {
  assert.match(sql, /id = \$1::uuid/)
  assert.match(sql, /status = 'sending'/)
  assert.match(sql, /claim_worker_id = \$2/)
  assert.match(sql, /attempt_count = \$3::int/)
}

async function main() {
  assert.equal(DEFAULT_LEASE_MS, 60_000)
  assert.equal(DEFAULT_BATCH_SIZE, 16)
  assert.equal(DEFAULT_MAX_ATTEMPTS, 8)
  assert.equal(NOT_ELIGIBLE, 'NOT_ELIGIBLE')
  assert.equal(ELIGIBILITY_UNAVAILABLE, 'ELIGIBILITY_UNAVAILABLE')
  assert.equal(OUTCOME_UNKNOWN, 'OUTCOME_UNKNOWN')
  assert.equal(ATTEMPTS_EXHAUSTED, 'ATTEMPTS_EXHAUSTED')
  assert.equal(ERROR_CODE_RE.test(NOT_ELIGIBLE), true)
  assert.equal(ERROR_CODE_RE.test(ELIGIBILITY_UNAVAILABLE), true)
  assert.equal(ERROR_CODE_RE.test('not_eligible'), false)
  assert.equal(computeNotificationBackoffMs(1), 60_000)
  assert.equal(computeNotificationBackoffMs(2), 5 * 60_000)
  assert.equal(computeNotificationBackoffMs(3), 15 * 60_000)
  assert.equal(computeNotificationBackoffMs(4), 60 * 60_000)
  assert.equal(computeNotificationBackoffMs(8), 6 * 60 * 60_000)
  assert.equal(computeNotificationBackoffMs(99), 6 * 60 * 60_000)

  assert.match(CLAIM_SQL, /LIMIT \$1::int\s+FOR UPDATE SKIP LOCKED/)
  assert.match(CLAIM_SQL, /status IN \('pending', 'retrying'\)/)
  assert.match(CLAIM_SQL, /next_attempt_at <= now\(\)/)
  assert.match(CLAIM_SQL, /status = 'sending'/)
  assert.match(CLAIM_SQL, /claim_expires_at <= now\(\)/)
  assert.match(CLAIM_SQL, /attempt_count = delivery\.attempt_count \+ 1/)
  assert.match(CLAIM_SQL, /claim_worker_id = btrim\(\$3::text\)/)
  assert.equal(CLAIM_SQL.includes("'sent'"), false)
  assert.equal(CLAIM_SQL.includes("'failed'"), false)
  assert.equal(CLAIM_SQL.includes("'outcome_unknown'"), false)
  for (const sql of [
    FINALIZE_SENT_SQL,
    FINALIZE_RETRYING_SQL,
    FINALIZE_FAILED_SQL,
    FINALIZE_OUTCOME_UNKNOWN_SQL,
    RELEASE_PENDING_SQL,
  ]) {
    fenceSql(sql)
  }
  assert.match(FINALIZE_SENT_SQL, /status = 'sent'/)
  assert.match(FINALIZE_RETRYING_SQL, /status = 'retrying'/)
  assert.match(FINALIZE_FAILED_SQL, /status = 'failed'/)
  assert.match(FINALIZE_OUTCOME_UNKNOWN_SQL, /status = 'outcome_unknown'/)
  assert.match(RELEASE_PENDING_SQL, /status = 'pending'/)
  assert.equal(RELEASE_PENDING_SQL.includes('attempt_count = attempt_count - 1'), false)
  assert.equal(RELEASE_PENDING_SQL.includes('attempt_count -'), false)

  const src = fs.readFileSync(WORKER, 'utf8')
  assert.equal(src.includes('setInterval'), false)
  assert.equal(src.includes('setTimeout'), false)
  assert.equal(src.includes('http.addRoute'), false)
  assert.equal(src.includes('/api/elearning'), false)
  assert.equal(src.includes('context.services.notification'), false)
  assert.equal(src.includes('attendanceScheduler'), false)
  assert.equal(src.includes('process.env'), false)
  assert.equal(/console\.(log|info|warn|error)/.test(src), false)

  const indexSrc = fs.readFileSync(INDEX, 'utf8')
  assert.equal(indexSrc.includes('notification-worker'), false)
  assert.equal(indexSrc.includes('runNotificationDeliveryBatch'), false)

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  const segments = String(pkg.scripts.test).split('&&').map((segment) => segment.trim())
  assert.equal(
    segments.includes('node __tests__/notification-worker.test.cjs'),
    true,
    'plugin-elearning scripts.test must chain notification-worker.test.cjs',
  )

  {
    const database = createThrowingDatabase()
    const result = await runNotificationDeliveryBatch({
      database,
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async () => {
        throw new Error('must not dispatch when disabled')
      },
    })
    assert.deepEqual(result, {
      claimed: 0,
      sent: 0,
      retrying: 0,
      failed: 0,
      outcomeUnknown: 0,
      released: 0,
      lostLease: 0,
    })
  }

  for (const lookalike of [false, undefined, null, 'true', 'TRUE', 1, '1', 'yes', () => 'true', () => 1]) {
    const result = await runNotificationDeliveryBatch({
      isEnabled: lookalike,
      database: createThrowingDatabase(),
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async () => ({ outcome: 'sent' }),
    })
    assert.equal(result.claimed, 0, `lookalike ${String(lookalike)} must stay disabled`)
  }

  {
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database: createThrowingDatabase(),
      workerId: 'worker-a',
      dispatch: async () => ({ outcome: 'sent' }),
    })
    assert.equal(result.claimed, 0, 'missing checkEligibility must not claim')
  }

  {
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database: createThrowingDatabase(),
      workerId: 'worker-a',
      checkEligibility: async () => true,
    })
    assert.equal(result.claimed, 0, 'missing dispatch must not claim')
  }

  {
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database: createThrowingDatabase(),
      workerId: '  ',
      checkEligibility: async () => true,
      dispatch: async () => ({ outcome: 'sent' }),
    })
    assert.equal(result.claimed, 0, 'blank workerId must not claim')
  }

  {
    let eligibility = 0
    let dispatched = 0
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimedRow()]
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async (row) => {
        eligibility += 1
        assert.equal(database.queries.some((entry) => entry.sql.includes('FOR UPDATE SKIP LOCKED')), true)
        assert.equal(dispatched, 0)
        assert.equal(row.id, DELIVERY_A)
        return false
      },
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'sent' }
      },
    })
    assert.equal(eligibility, 1)
    assert.equal(dispatched, 0)
    assert.equal(result.claimed, 1)
    assert.equal(result.failed, 1)
    assert.equal(
      database.queries.some((entry) => (
        entry.sql.includes("status = 'failed'")
        && Array.isArray(entry.params)
        && entry.params[0] === DELIVERY_A
        && entry.params[1] === 'worker-a'
        && entry.params[2] === 1
        && entry.params[3] === NOT_ELIGIBLE
      )),
      true,
    )
  }

  {
    let dispatched = 0
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimedRow()]
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async () => {
        throw new Error('eligibility exploded')
      },
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'sent' }
      },
    })
    assert.equal(dispatched, 0)
    assert.equal(result.retrying, 1)
    assert.equal(result.failed, 0)
    const retry = database.queries.find((entry) => entry.sql.includes("status = 'retrying'"))
    assert.ok(retry)
    assert.deepEqual(retry.params, [
      DELIVERY_A,
      'worker-a',
      1,
      computeNotificationBackoffMs(1),
      ELIGIBILITY_UNAVAILABLE,
    ])
    assert.equal(
      JSON.stringify(database.queries).includes('eligibility exploded'),
      false,
    )
  }

  {
    let dispatched = 0
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return [claimedRow({ attempt_count: 8 })]
      }
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      maxAttempts: 8,
      checkEligibility: async () => {
        throw new Error('host://secret')
      },
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'sent' }
      },
    })
    assert.equal(dispatched, 0)
    assert.equal(result.failed, 1)
    assert.equal(result.retrying, 0)
    assert.equal(
      database.queries.some((entry) => (
        entry.sql.includes("status = 'failed'")
        && Array.isArray(entry.params)
        && entry.params[3] === ATTEMPTS_EXHAUSTED
      )),
      true,
    )
    assert.equal(
      JSON.stringify(database.queries).includes('host://secret'),
      false,
    )
  }

  {
    const calls = []
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimedRow()]
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async (row) => {
        calls.push(`eligible:${row.id}`)
        assert.equal(calls.includes(`dispatch:${row.id}`), false)
        return true
      },
      dispatch: async (row) => {
        calls.push(`dispatch:${row.id}`)
        return { outcome: 'sent' }
      },
    })
    assert.deepEqual(calls, [`eligible:${DELIVERY_A}`, `dispatch:${DELIVERY_A}`])
    assert.equal(result.sent, 1)
    assert.equal(
      database.queries.some((entry) => entry.sql.includes("status = 'sent'")),
      true,
    )
  }

  {
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return [claimedRow({ attempt_count: 2 })]
      }
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async () => ({ outcome: 'retryable', code: 'RATE_LIMITED' }),
    })
    assert.equal(result.retrying, 1)
    const retry = database.queries.find((entry) => entry.sql.includes("status = 'retrying'"))
    assert.ok(retry)
    assert.deepEqual(retry.params, [
      DELIVERY_A,
      'worker-a',
      2,
      computeNotificationBackoffMs(2),
      'RATE_LIMITED',
    ])
  }

  {
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimedRow()]
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async () => ({ status: 'failed', code: 'CHANNEL_REJECTED' }),
    })
    assert.equal(result.failed, 1)
    assert.equal(
      database.queries.some((entry) => (
        entry.sql.includes("status = 'failed'")
        && Array.isArray(entry.params)
        && entry.params[3] === 'CHANNEL_REJECTED'
      )),
      true,
    )
  }

  {
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimedRow()]
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async () => ({ outcome: 'outcome_unknown', code: OUTCOME_UNKNOWN }),
    })
    assert.equal(result.outcomeUnknown, 1)
    assert.equal(
      database.queries.some((entry) => entry.sql.includes("status = 'outcome_unknown'")),
      true,
    )
  }

  {
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimedRow()]
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async () => {
        throw new Error('smtp://secret@example')
      },
    })
    assert.equal(result.outcomeUnknown, 1)
    assert.equal(result.retrying, 0)
    const unknown = database.queries.find((entry) => entry.sql.includes("status = 'outcome_unknown'"))
    assert.ok(unknown)
    assert.equal(unknown.params[3], OUTCOME_UNKNOWN)
    assert.equal(
      JSON.stringify(database.queries).includes('smtp://secret@example'),
      false,
    )
  }

  {
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimedRow()]
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async () => ({ outcome: 'retryable', code: 'not a code' }),
    })
    assert.equal(result.outcomeUnknown, 1)
    assert.equal(result.retrying, 0)
  }

  {
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return [claimedRow({ attempt_count: 8 })]
      }
      return [{ id: DELIVERY_A }]
    })
    let dispatched = 0
    const result = await runNotificationDeliveryBatch({
      isEnabled: true,
      database,
      workerId: 'worker-a',
      maxAttempts: 8,
      checkEligibility: async () => true,
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'retryable', code: 'RATE_LIMITED' }
      },
    })
    assert.equal(dispatched, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.retrying, 0)
    assert.equal(
      database.queries.some((entry) => (
        entry.sql.includes("status = 'failed'")
        && Array.isArray(entry.params)
        && entry.params[3] === ATTEMPTS_EXHAUSTED
      )),
      true,
    )
  }

  {
    const database = createFakeDatabase(() => [])
    const lost = await finalizeNotificationSent(database, {
      deliveryId: DELIVERY_A,
      workerId: 'worker-a',
      claimAttempt: 1,
    })
    assert.deepEqual(lost, { ok: false, lostLease: true })
    assert.equal(database.queries.length, 1)
    const staleRetry = await finalizeNotificationRetrying(database, {
      deliveryId: DELIVERY_A,
      workerId: 'worker-a',
      claimAttempt: 1,
      code: 'RATE_LIMITED',
    })
    assert.equal(staleRetry.lostLease, true)
    const staleFail = await finalizeNotificationFailed(database, {
      deliveryId: DELIVERY_A,
      workerId: 'worker-a',
      claimAttempt: 1,
      code: NOT_ELIGIBLE,
    })
    assert.equal(staleFail.lostLease, true)
    const staleUnknown = await finalizeNotificationOutcomeUnknown(database, {
      deliveryId: DELIVERY_A,
      workerId: 'worker-a',
      claimAttempt: 1,
    })
    assert.equal(staleUnknown.lostLease, true)
  }

  {
    let queried = 0
    const database = {
      query: async () => {
        queried += 1
        throw new Error('must not query with a coerced claimAttempt')
      },
    }
    for (const value of ['1', 1.5, 0, Number.NaN]) {
      assert.equal(
        (await finalizeNotificationSent(database, {
          deliveryId: DELIVERY_A,
          workerId: 'worker-a',
          claimAttempt: value,
        })).ok,
        false,
      )
      assert.equal(
        (await releaseClaimedNotificationDelivery(database, {
          deliveryId: DELIVERY_A,
          workerId: 'worker-a',
          claimAttempt: value,
        })).ok,
        false,
      )
    }
    assert.equal(queried, 0)
  }

  {
    let enabled = true
    let dispatched = 0
    const database = createFakeDatabase((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return [
          claimedRow(),
          claimedRow({ id: DELIVERY_B, attempt_count: 1 }),
        ]
      }
      return [{ id: DELIVERY_A }]
    })
    const result = await runNotificationDeliveryBatch({
      isEnabled: () => enabled,
      database,
      workerId: 'worker-a',
      checkEligibility: async () => true,
      dispatch: async (row) => {
        dispatched += 1
        enabled = false
        assert.equal(row.id, DELIVERY_A)
        return { outcome: 'sent' }
      },
    })
    assert.equal(result.claimed, 2)
    assert.equal(result.sent, 1)
    assert.equal(result.released, 1)
    assert.equal(dispatched, 1)
    assert.equal(
      database.queries.some((entry) => (
        entry.sql.includes("status = 'pending'")
        && Array.isArray(entry.params)
        && entry.params[0] === DELIVERY_B
        && entry.params[2] === 1
      )),
      true,
    )
    assert.equal(
      database.queries.some((entry) => (
        Array.isArray(entry.params) && entry.params[0] === DELIVERY_B && entry.sql.includes('dispatch')
      )),
      false,
    )
  }

  {
    const claimed = await claimDueNotificationDeliveries(null, { workerId: 'worker-a' })
    assert.deepEqual(claimed, [])
    const missingWorker = await claimDueNotificationDeliveries(createThrowingDatabase(), {})
    assert.deepEqual(missingWorker, [])
  }

  console.log('✓ notification-worker: default-off, claim/finalize fences, eligibility, closed outcomes, drain')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
