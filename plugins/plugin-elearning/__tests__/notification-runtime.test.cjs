'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  RUNTIME_INTERVAL_MS,
  getNotificationRuntimeState,
  resolveNotificationRuntimePorts,
  runtimeInputFromDelivery,
  runNotificationRuntimeTick,
  startNotificationRuntime,
  stopNotificationRuntime,
} = require('../lib/notification-runtime.cjs')
const { withFlagsAsync } = require('./helpers.cjs')

const DELIVERY_ID = '11111111-1111-4111-8111-111111111111'
const MEMBER_ID = '22222222-2222-4222-8222-222222222222'
const ASSIGNMENT_ID = '33333333-3333-4333-8333-333333333333'
const VERSION_ID = '44444444-4444-4444-8444-444444444444'
const FLAGS_ON = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
})

function claimedRow(overrides) {
  return {
    id: DELIVERY_ID,
    org_id: 'org-runtime',
    assignment_member_id: MEMBER_ID,
    kind: 'assignment_reminder',
    source_key: 'assignment:a:user:u:window:2026-08-27T00:00:00Z',
    recipient_role: 'learner',
    recipient_user_id: 'learner-runtime',
    channel: 'platform',
    payload: {
      assignmentId: ASSIGNMENT_ID,
      assignmentMemberId: MEMBER_ID,
      courseVersionId: VERSION_ID,
      windowStart: '2026-08-27T00:00:00.000Z',
    },
    status: 'sending',
    attempt_count: 1,
    claim_worker_id: 'runtime-worker',
    ...overrides,
  }
}

function createDatabase(rows) {
  const queries = []
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params })
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return rows
      return [{ id: params && params[0] }]
    },
  }
}

async function main() {
  stopNotificationRuntime()
  assert.equal(RUNTIME_INTERVAL_MS, 30_000)

  const runtimeSource = fs.readFileSync(
    path.join(__dirname, '../lib/notification-runtime.cjs'),
    'utf8',
  )
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.cjs'), 'utf8')
  assert.equal(runtimeSource.includes('context.services.notification'), false)
  assert.equal(runtimeSource.includes('notificationService'), false)
  assert.match(runtimeSource, /idempotencyKey: `delivery:\$\{deliveryId\}`/)
  assert.match(indexSource, /startNotificationRuntime\(context\)/)
  assert.match(indexSource, /stopNotificationRuntime\(\)/)

  assert.deepEqual(runtimeInputFromDelivery(claimedRow()), {
    eligibility: {
      orgId: 'org-runtime',
      assignmentMemberId: MEMBER_ID,
      recipientUserId: 'learner-runtime',
    },
    dispatch: {
      assignmentMemberId: MEMBER_ID,
      deliveryId: DELIVERY_ID,
      idempotencyKey: `delivery:${DELIVERY_ID}`,
      kind: 'assignment_reminder',
      orgId: 'org-runtime',
      payload: {
        assignmentId: ASSIGNMENT_ID,
        assignmentMemberId: MEMBER_ID,
        courseVersionId: VERSION_ID,
        windowStart: '2026-08-27T00:00:00.000Z',
      },
      recipientUserId: 'learner-runtime',
    },
  })
  for (const invalid of [
    null,
    claimedRow({ id: 'not-a-uuid' }),
    claimedRow({ org_id: ' org-runtime' }),
    claimedRow({ kind: 'other' }),
    claimedRow({ recipient_role: 'manager' }),
    claimedRow({ channel: 'email' }),
    claimedRow({ payload: null }),
    claimedRow({ payload: { ...claimedRow().payload, assignmentMemberId: ASSIGNMENT_ID } }),
    claimedRow({ payload: { ...claimedRow().payload, windowStart: '2026-08-27T00:00:00Z' } }),
  ]) {
    assert.throws(() => runtimeInputFromDelivery(invalid), /NOTIFICATION_ROW_INVALID/)
  }

  assert.equal(resolveNotificationRuntimePorts({ services: {} }), null)
  assert.equal(resolveNotificationRuntimePorts({
    services: { elearningNotificationEligibility: { check() {} } },
  }), null)
  const ports = {
    elearningNotificationEligibility: { async check() { return true } },
    elearningNotificationDispatch: { async dispatch() { return { outcome: 'sent' } } },
  }
  assert.deepEqual(resolveNotificationRuntimePorts({ services: ports }), {
    eligibility: ports.elearningNotificationEligibility,
    dispatch: ports.elearningNotificationDispatch,
  })

  await withFlagsAsync({}, async () => {
    const throwingContext = new Proxy({}, {
      get() { throw new Error('flags OFF must not inspect context') },
    })
    assert.equal(startNotificationRuntime(throwingContext), false)
    assert.equal(getNotificationRuntimeState().running, false)
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const database = createDatabase([])
    const warnings = []
    assert.equal(startNotificationRuntime({
      api: { database },
      logger: { warn: (...args) => warnings.push(args) },
      services: {
        elearningNotificationEligibility: ports.elearningNotificationEligibility,
      },
    }), false)
    assert.equal(database.queries.length, 0)
    assert.equal(getNotificationRuntimeState().running, false)
    assert.deepEqual(warnings, [[
      'elearning notification runtime',
      { code: 'NOTIFICATION_RUNTIME_UNAVAILABLE' },
    ]])
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const database = createDatabase([claimedRow()])
    const eligibilityInputs = []
    const dispatchInputs = []
    const context = {
      api: { database },
      services: {
        elearningNotificationEligibility: {
          async check(input) {
            eligibilityInputs.push(input)
            return true
          },
        },
        elearningNotificationDispatch: {
          async dispatch(input) {
            dispatchInputs.push(input)
            return { outcome: 'sent' }
          },
        },
      },
    }
    assert.equal(startNotificationRuntime(context, { workerId: 'runtime-worker' }), true)
    assert.equal(getNotificationRuntimeState().running, true)
    assert.equal(database.queries.length, 0, 'start must not claim immediately')
    const result = await runNotificationRuntimeTick()
    assert.equal(result.claimed, 1)
    assert.equal(result.sent, 1)
    assert.deepEqual(eligibilityInputs, [{
      orgId: 'org-runtime',
      assignmentMemberId: MEMBER_ID,
      recipientUserId: 'learner-runtime',
    }])
    assert.equal(dispatchInputs.length, 1)
    assert.equal(dispatchInputs[0].idempotencyKey, `delivery:${DELIVERY_ID}`)
    assert.equal(
      database.queries.some((entry) => entry.sql.includes("status = 'sent'")),
      true,
    )
    stopNotificationRuntime()
    assert.equal(getNotificationRuntimeState().running, false)
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const database = createDatabase([claimedRow()])
    const context = { api: { database }, services: ports }
    assert.equal(startNotificationRuntime(context, { workerId: 'runtime-worker' }), true)
    delete process.env.ELEARNING_ASSIGNMENT_ENABLED
    const disabled = await runNotificationRuntimeTick()
    assert.equal(disabled.claimed, 0)
    assert.equal(database.queries.length, 0)
    stopNotificationRuntime()
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const database = createDatabase([claimedRow({
      payload: { ...claimedRow().payload, assignmentMemberId: ASSIGNMENT_ID },
    })])
    let eligibilityCalls = 0
    let dispatchCalls = 0
    const result = await runNotificationRuntimeTick({
      isEnabled: () => true,
      database,
      workerId: 'runtime-worker',
      eligibility: { async check() { eligibilityCalls += 1; return true } },
      dispatch: { async dispatch() { dispatchCalls += 1; return { outcome: 'sent' } } },
    })
    assert.equal(result.retrying, 1)
    assert.equal(eligibilityCalls, 0)
    assert.equal(dispatchCalls, 0)
    assert.equal(
      database.queries.some((entry) => entry.sql.includes("status = 'retrying'")),
      true,
    )
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const database = createDatabase([claimedRow()])
    let eligibilityStarted
    let releaseEligibility
    const started = new Promise((resolve) => { eligibilityStarted = resolve })
    const held = new Promise((resolve) => { releaseEligibility = resolve })
    let dispatchCalls = 0
    const context = {
      api: { database },
      services: {
        elearningNotificationEligibility: {
          async check() {
            eligibilityStarted()
            await held
            return true
          },
        },
        elearningNotificationDispatch: {
          async dispatch() {
            dispatchCalls += 1
            return { outcome: 'sent' }
          },
        },
      },
    }
    startNotificationRuntime(context, { workerId: 'runtime-worker' })
    const tick = runNotificationRuntimeTick()
    await started
    stopNotificationRuntime()
    releaseEligibility()
    const stopped = await tick
    assert.equal(stopped.released, 1)
    assert.equal(dispatchCalls, 0)
    assert.equal(
      database.queries.some((entry) => entry.sql.includes("status = 'pending'")),
      true,
    )
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const stalledDatabase = createDatabase([claimedRow()])
    let eligibilityStarted
    const started = new Promise((resolve) => { eligibilityStarted = resolve })
    startNotificationRuntime({
      api: { database: stalledDatabase },
      services: {
        elearningNotificationEligibility: {
          async check() {
            eligibilityStarted()
            return new Promise(() => {})
          },
        },
        elearningNotificationDispatch: ports.elearningNotificationDispatch,
      },
    }, { workerId: 'stalled-worker' })
    void runNotificationRuntimeTick()
    await started
    stopNotificationRuntime()

    const recoveredDatabase = createDatabase([claimedRow()])
    startNotificationRuntime({
      api: { database: recoveredDatabase },
      services: ports,
    }, { workerId: 'recovered-worker' })
    const recovered = await runNotificationRuntimeTick()
    assert.equal(recovered.sent, 1)
    stopNotificationRuntime()
  })

  stopNotificationRuntime()
  console.log('✓ notification-runtime: guarded eligibility and idempotent dispatch seam')
}

main().catch((error) => {
  stopNotificationRuntime()
  console.error(error)
  process.exitCode = 1
})
