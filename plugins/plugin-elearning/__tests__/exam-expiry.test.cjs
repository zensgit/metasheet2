'use strict'

const assert = require('node:assert/strict')
const { activate, deactivate } = require('../index.cjs')
const {
  EXAM_EXPIRY_JOB_KIND,
  examExpiryInputFromJob,
  isExamExpiryEnabled,
  registerExamExpirySettlement,
} = require('../lib/exam-expiry.cjs')
const {
  clearJobHandlers,
  getJobsWorkerState,
  registeredKinds,
  runJobsTick,
  stopJobsWorker,
} = require('../lib/jobs.cjs')
const { LOOKALIKES, withFlagsAsync } = require('./helpers.cjs')

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
const FLAGS_ON = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
})

function job(overrides) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    org_id: 'org-exam-expiry',
    kind: EXAM_EXPIRY_JOB_KIND,
    occurrence_key: `attempt:${ATTEMPT_ID}`,
    ref: ATTEMPT_ID,
    payload: {},
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
      if (sql.includes("status = 'succeeded'")) {
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

async function runRegistered(claimed, settle, mutateFlags) {
  const finalizedParams = []
  let calls = 0
  registerExamExpirySettlement({
    services: {
      elearningExamExpirySettlement: {
        async settle(input) {
          calls += 1
          return settle(input)
        },
      },
    },
  })
  if (mutateFlags) mutateFlags()
  const result = await runJobsTick({
    database: databaseFor(claimed, finalizedParams),
    workerId: 'worker-exam-expiry',
  })
  return { calls, finalizedParams, result }
}

async function main() {
  stopJobsWorker()
  clearJobHandlers()

  await withFlagsAsync({}, async () => {
    assert.equal(isExamExpiryEnabled(), false)
    assert.equal(registerExamExpirySettlement({ services: {} }), false)
    assert.deepEqual(registeredKinds(), [])
  })

  for (const missing of [
    'ELEARNING_CONTENT_ENABLED',
    'ELEARNING_MEDIA_ENABLED',
    'ELEARNING_ASSESSMENT_ENABLED',
  ]) {
    const partial = { ...FLAGS_ON }
    delete partial[missing]
    await withFlagsAsync(partial, async () => {
      assert.equal(registerExamExpirySettlement({ services: {} }), false)
      assert.deepEqual(registeredKinds(), [])
    })
  }

  for (const lookalike of LOOKALIKES) {
    await withFlagsAsync({ ...FLAGS_ON, ELEARNING_ASSESSMENT_ENABLED: lookalike }, async () => {
      assert.equal(registerExamExpirySettlement({ services: {} }), false)
    })
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    assert.throws(
      () => registerExamExpirySettlement({ services: {} }),
      (error) => error && error.code === 'EXAM_EXPIRY_PORT_REQUIRED',
    )
    assert.deepEqual(registeredKinds(), [])
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const routes = []
    const base = {
      api: {
        database: { query: async () => { throw new Error('activation must not query') } },
        http: { addRoute: (...args) => routes.push(args) },
      },
      services: {
        elearningExamExpirySettlement: {
          async settle() {
            return { outcome: 'duplicate' }
          },
        },
      },
    }
    await activate(base)
    assert.equal(routes.length, 1)
    assert.deepEqual(registeredKinds(), [EXAM_EXPIRY_JOB_KIND])
    assert.equal(getJobsWorkerState().running, true)
    await deactivate()
    assert.equal(getJobsWorkerState().running, false)
    assert.deepEqual(registeredKinds(), [])
  })

  assert.deepEqual(examExpiryInputFromJob(job()), {
    orgId: 'org-exam-expiry',
    attemptId: ATTEMPT_ID,
  })
  for (const invalid of [
    null,
    job({ kind: 'other' }),
    job({ org_id: ' org-exam-expiry' }),
    job({ ref: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }),
    job({ occurrence_key: 'attempt:other' }),
    job({ payload: null }),
    job({ payload: { unexpected: true } }),
    job({ due_at: null }),
    job({ due_at: 1 }),
    job({ due_at: 'invalid' }),
  ]) {
    assert.throws(
      () => examExpiryInputFromJob(invalid),
      (error) => error && error.code === 'EXAM_EXPIRY_JOB_INVALID',
    )
  }

  for (const outcome of ['settled', 'duplicate']) {
    await withFlagsAsync(FLAGS_ON, async () => {
      const accepted = await runRegistered(job(), async (input) => {
        assert.deepEqual(input, {
          orgId: 'org-exam-expiry',
          attemptId: ATTEMPT_ID,
        })
        return { outcome }
      })
      assert.equal(accepted.calls, 1)
      assert.equal(accepted.result.claimed, 1)
      assert.equal(accepted.finalizedParams.length, 1)
      clearJobHandlers()
    })
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    const notDue = await runRegistered(job(), async () => ({ outcome: 'not_due' }))
    assert.equal(notDue.calls, 1)
    assert.equal(notDue.finalizedParams[0][4], 'EXAM_EXPIRY_NOT_DUE')
    clearJobHandlers()
  })

  for (const [sourceCode, expectedCode] of [
    ['not_found', 'EXAM_EXPIRY_JOB_INVALID'],
    ['unavailable', 'EXAM_EXPIRY_UNAVAILABLE'],
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
    registerExamExpirySettlement({
      services: {
        elearningExamExpirySettlement: {
          async settle() {
            calls += 1
            return { outcome: 'duplicate' }
          },
        },
      },
    })
    delete process.env.ELEARNING_ASSESSMENT_ENABLED
    const disabled = await runJobsTick({
      database: databaseFor(job(), finalizedParams),
      workerId: 'worker-exam-expiry-disabled',
    })
    assert.deepEqual(disabled, { claimed: 0 })
    assert.equal(calls, 0)
    assert.deepEqual(finalizedParams, [])
    clearJobHandlers()
  })

  stopJobsWorker()
  clearJobHandlers()
  console.log('✓ exam-expiry: gated timed-attempt settlement handler')
}

main().catch((error) => {
  stopJobsWorker()
  clearJobHandlers()
  console.error(error)
  process.exitCode = 1
})
