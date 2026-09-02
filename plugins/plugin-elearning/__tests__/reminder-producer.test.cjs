'use strict'

const assert = require('node:assert/strict')
const { activate, deactivate } = require('../index.cjs')
const {
  ASSIGNMENT_REMINDER_JOB_KIND,
  isReminderProducerEnabled,
  reminderInputFromJob,
  registerAssignmentReminderProducer,
} = require('../lib/reminder-producer.cjs')
const {
  clearJobHandlers,
  getJobsWorkerState,
  registeredKinds,
  runJobsTick,
  stopJobsWorker,
} = require('../lib/jobs.cjs')
const { LOOKALIKES, withFlagsAsync } = require('./helpers.cjs')

const MEMBER_ID = '11111111-1111-4111-8111-111111111111'
const DELIVERY_ID = '22222222-2222-4222-8222-222222222222'
const FLAGS_ON = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
})

function job(overrides) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    org_id: 'org-reminder',
    kind: ASSIGNMENT_REMINDER_JOB_KIND,
    occurrence_key: 'assignment:a:user:u:window:2026-08-27T00:00:00Z',
    ref: MEMBER_ID,
    payload: { windowStart: '2026-08-27T00:00:00.000Z' },
    due_at: new Date('2026-08-27T01:00:00.000Z'),
    attempts: 1,
    status: 'running',
    ...overrides,
  }
}

function databaseFor(claimed, finalizedParams) {
  return {
    async query(sql, params) {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed]
      if (sql.includes('status = \'succeeded\'')) {
        finalizedParams.push(params)
        return [{ id: claimed.id }]
      }
      if (sql.includes('status = CASE')) {
        finalizedParams.push(params)
        return [{ id: claimed.id, status: 'failed', last_error: params[4], attempts: 1 }]
      }
      return []
    },
  }
}

async function runRegistered(claimed, port, mutateFlags) {
  const finalizedParams = []
  let calls = 0
  const context = {
    services: {
      elearningReminderProducer: {
        async produce(input) {
          calls += 1
          return port(input)
        },
      },
    },
  }
  registerAssignmentReminderProducer(context)
  if (mutateFlags) mutateFlags()
  const result = await runJobsTick({
    database: databaseFor(claimed, finalizedParams),
    workerId: 'worker-reminder',
  })
  return { calls, finalizedParams, result }
}

async function main() {
  stopJobsWorker()
  clearJobHandlers()

  await withFlagsAsync({}, async () => {
    assert.equal(isReminderProducerEnabled(), false)
    assert.equal(registerAssignmentReminderProducer({ services: {} }), false)
    assert.deepEqual(registeredKinds(), [])
  })

  for (const partial of [
    { ELEARNING_ENABLED: 'true', ELEARNING_CONTENT_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_ASSIGNMENT_ENABLED: 'true' },
  ]) {
    await withFlagsAsync(partial, async () => {
      assert.equal(registerAssignmentReminderProducer({ services: {} }), false)
      assert.deepEqual(registeredKinds(), [])
    })
  }

  for (const lookalike of LOOKALIKES) {
    await withFlagsAsync({ ...FLAGS_ON, ELEARNING_ASSIGNMENT_ENABLED: lookalike }, async () => {
      assert.equal(registerAssignmentReminderProducer({ services: {} }), false)
    })
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    assert.throws(
      () => registerAssignmentReminderProducer({ services: {} }),
      (error) => error && error.code === 'REMINDER_PORT_REQUIRED',
    )
    assert.deepEqual(registeredKinds(), [])
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const routes = []
    const database = { query: async () => { throw new Error('activation must not query') } }
    const base = {
      api: {
        database,
        http: { addRoute: (...args) => routes.push(args) },
      },
      services: {},
    }
    await assert.rejects(
      () => activate(base),
      (error) => error && error.code === 'REMINDER_PORT_REQUIRED',
    )
    assert.equal(routes.length, 0)
    assert.equal(getJobsWorkerState().running, false)
    assert.deepEqual(registeredKinds(), [])

    await activate({
      ...base,
      services: {
        elearningReminderProducer: {
          async produce() {
            return { outcome: 'ineligible' }
          },
        },
        elearningOnboarding: {
          async processAssignment() {
            throw new Error('not called')
          },
        },
      },
    })
    assert.equal(routes.length, 1)
    assert.deepEqual(registeredKinds(), [ASSIGNMENT_REMINDER_JOB_KIND, 'onboarding_assign'])
    assert.equal(getJobsWorkerState().running, true)
    await deactivate()
    assert.equal(getJobsWorkerState().running, false)
    assert.deepEqual(registeredKinds(), [])
  })

  assert.deepEqual(reminderInputFromJob(job()), {
    orgId: 'org-reminder',
    assignmentMemberId: MEMBER_ID,
    occurrenceKey: 'assignment:a:user:u:window:2026-08-27T00:00:00Z',
    windowStart: '2026-08-27T00:00:00.000Z',
    dueAt: new Date('2026-08-27T01:00:00.000Z'),
  })
  for (const invalid of [
    null,
    job({ kind: 'other' }),
    job({ org_id: ' org-reminder' }),
    job({ ref: 'not-a-uuid' }),
    job({ occurrence_key: '' }),
    job({ payload: null }),
    job({ payload: {} }),
    job({ due_at: 1 }),
  ]) {
    assert.throws(
      () => reminderInputFromJob(invalid),
      (error) => error && error.code === 'REMINDER_JOB_INVALID',
    )
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    const expected = reminderInputFromJob(job())
    const success = await runRegistered(job(), async (input) => {
      assert.deepEqual(input, expected)
      return { outcome: 'enqueued', deliveryId: DELIVERY_ID }
    })
    assert.equal(success.calls, 1)
    assert.equal(success.result.claimed, 1)
    assert.equal(success.finalizedParams.length, 1)
    assert.equal(success.finalizedParams[0][0], job().id)
    clearJobHandlers()
  })

  for (const result of [
    { outcome: 'ineligible' },
    { outcome: 'duplicate', deliveryId: DELIVERY_ID },
  ]) {
    await withFlagsAsync(FLAGS_ON, async () => {
      const accepted = await runRegistered(job(), async () => result)
      assert.equal(accepted.calls, 1)
      assert.equal(accepted.finalizedParams.length, 1)
      clearJobHandlers()
    })
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    const unavailable = await runRegistered(job(), async () => ({ outcome: 'unknown' }))
    assert.equal(unavailable.calls, 1)
    assert.equal(unavailable.finalizedParams[0][4], 'REMINDER_UNAVAILABLE')
    clearJobHandlers()
  })

  for (const [sourceCode, expectedCode] of [
    ['not_found', 'REMINDER_JOB_INVALID'],
    ['conflict', 'REMINDER_JOB_INVALID'],
    ['unavailable', 'REMINDER_UNAVAILABLE'],
  ]) {
    await withFlagsAsync(FLAGS_ON, async () => {
      const failed = await runRegistered(job(), async () => {
        throw Object.assign(new Error(sourceCode), { code: sourceCode })
      })
      assert.equal(failed.calls, 1)
      assert.equal(failed.finalizedParams[0][4], expectedCode)
      clearJobHandlers()
    })
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    const finalizedParams = []
    let calls = 0
    registerAssignmentReminderProducer({
      services: {
        elearningReminderProducer: {
          async produce() {
            calls += 1
            return { outcome: 'ineligible' }
          },
        },
      },
    })
    delete process.env.ELEARNING_ASSIGNMENT_ENABLED
    const disabled = await runJobsTick({
      database: databaseFor(job(), finalizedParams),
      workerId: 'worker-disabled',
    })
    assert.deepEqual(disabled, { claimed: 0 })
    assert.equal(calls, 0)
    assert.deepEqual(finalizedParams, [])
    clearJobHandlers()
  })

  stopJobsWorker()
  clearJobHandlers()
  console.log('✓ reminder-producer: gated persisted-job handler and narrow port mapping')
}

main().catch((error) => {
  stopJobsWorker()
  clearJobHandlers()
  console.error(error)
  process.exitCode = 1
})
