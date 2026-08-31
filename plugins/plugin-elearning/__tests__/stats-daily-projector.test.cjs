'use strict'

const assert = require('node:assert/strict')
const { activate, deactivate } = require('../index.cjs')
const {
  STATS_DAILY_PROJECT_JOB_KIND,
  isStatsDailyProjectorEnabled,
  registerStatsDailyProjector,
  statsDailyProjectionInputFromJob,
} = require('../lib/stats-daily-projector.cjs')
const {
  clearJobHandlers,
  getJobsWorkerState,
  registeredKinds,
  runJobsTick,
  stopJobsWorker,
} = require('../lib/jobs.cjs')
const { LOOKALIKES, withFlagsAsync } = require('./helpers.cjs')

const DEPARTMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STATS_DATE = '2026-08-30'
const FLAGS_ON = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
})

function job(overrides) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    org_id: 'org-stats-daily',
    kind: STATS_DAILY_PROJECT_JOB_KIND,
    occurrence_key: `department:${DEPARTMENT_ID}:date:${STATS_DATE}`,
    ref: DEPARTMENT_ID,
    payload: { statsDate: STATS_DATE },
    due_at: new Date('2026-08-31T01:00:00.000Z'),
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

async function runRegistered(claimed, project, mutateFlags) {
  const finalizedParams = []
  let calls = 0
  registerStatsDailyProjector({
    services: {
      elearningStatsDailyProjection: {
        async enqueueDue() {
          return { statsDate: STATS_DATE, enqueuedCount: 0 }
        },
        async project(input) {
          calls += 1
          return project(input)
        },
      },
    },
  })
  if (mutateFlags) mutateFlags()
  const result = await runJobsTick({
    database: databaseFor(claimed, finalizedParams),
    workerId: 'worker-stats-daily',
  })
  return { calls, finalizedParams, result }
}

async function main() {
  stopJobsWorker()
  clearJobHandlers()

  await withFlagsAsync({}, async () => {
    assert.equal(isStatsDailyProjectorEnabled(), false)
    assert.equal(registerStatsDailyProjector({ services: {} }), false)
    assert.deepEqual(registeredKinds(), [])
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    assert.equal(registerStatsDailyProjector({ services: {} }), false)
    assert.deepEqual(registeredKinds(), [])
  })

  for (const lookalike of LOOKALIKES) {
    await withFlagsAsync({ ...FLAGS_ON, ELEARNING_ANALYTICS_ENABLED: lookalike }, async () => {
      assert.equal(registerStatsDailyProjector({ services: {} }), false)
      assert.deepEqual(registeredKinds(), [])
    })
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    assert.throws(
      () => registerStatsDailyProjector({ services: {} }),
      (error) => error && error.code === 'STATS_DAILY_PORT_REQUIRED',
    )
    assert.deepEqual(registeredKinds(), [])
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    const routes = []
    await activate({
      api: {
        database: { query: async () => [] },
        http: { addRoute: (...args) => routes.push(args) },
      },
      services: {
        elearningStatsDailyProjection: {
          async enqueueDue() {
            return { statsDate: STATS_DATE, enqueuedCount: 0 }
          },
          async project() {
            return { outcome: 'noop', projectedVersion: 1, suppressed: true }
          },
        },
        elearningAnalyticsExport: {
          async materialize(input) {
            return { outcome: 'noop', exportId: input.exportId }
          },
          async cleanup(input) {
            return { outcome: 'noop', exportId: input.exportId }
          },
        },
        elearningOnboarding: {
          async enqueueWeeklyReports() {
            return { weekStart: '2026-08-24', enqueuedCount: 0 }
          },
          async materializeWeeklyReport() {
            throw new Error('not called')
          },
        },
      },
    })
    assert.equal(routes.length, 1)
    assert.deepEqual(registeredKinds(), [
      STATS_DAILY_PROJECT_JOB_KIND,
      'analytics_export',
      'analytics_export_cleanup',
      'onboarding_weekly_report',
    ])
    assert.equal(getJobsWorkerState().running, true)
    await deactivate()
    assert.equal(getJobsWorkerState().running, false)
    assert.deepEqual(registeredKinds(), [])
  })

  assert.deepEqual(statsDailyProjectionInputFromJob(job()), {
    orgId: 'org-stats-daily',
    departmentId: DEPARTMENT_ID,
    statsDate: STATS_DATE,
  })
  for (const invalid of [
    null,
    job({ kind: 'other' }),
    job({ org_id: ' org-stats-daily' }),
    job({ ref: DEPARTMENT_ID.toUpperCase() }),
    job({ occurrence_key: `department:${DEPARTMENT_ID}:date:2026-08-29` }),
    job({ payload: null }),
    job({ payload: {} }),
    job({ payload: { statsDate: STATS_DATE, unexpected: true } }),
    job({ payload: { statsDate: '2026-02-30' } }),
    job({ due_at: null }),
    job({ due_at: 'invalid' }),
  ]) {
    assert.throws(
      () => statsDailyProjectionInputFromJob(invalid),
      (error) => error && error.code === 'STATS_DAILY_JOB_INVALID',
    )
  }

  for (const outcome of ['projected', 'noop']) {
    await withFlagsAsync(FLAGS_ON, async () => {
      const accepted = await runRegistered(job(), async (input) => {
        assert.deepEqual(input, {
          orgId: 'org-stats-daily',
          departmentId: DEPARTMENT_ID,
          statsDate: STATS_DATE,
        })
        return { outcome, projectedVersion: 2, suppressed: false }
      })
      assert.equal(accepted.calls, 1)
      assert.equal(accepted.result.claimed, 1)
      assert.equal(accepted.finalizedParams.length, 1)
      clearJobHandlers()
    })
  }

  for (const invalidResult of [
    null,
    { outcome: 'unknown', projectedVersion: 1, suppressed: false },
    { outcome: 'noop', projectedVersion: 0, suppressed: false },
    { outcome: 'noop', projectedVersion: 1, suppressed: 'false' },
    { outcome: 'noop', projectedVersion: 1, suppressed: false, extra: true },
  ]) {
    await withFlagsAsync(FLAGS_ON, async () => {
      const failed = await runRegistered(job(), async () => invalidResult)
      assert.equal(failed.finalizedParams[0][4], 'STATS_DAILY_UNAVAILABLE')
      clearJobHandlers()
    })
  }

  for (const [sourceCode, expectedCode] of [
    ['invalid_input', 'STATS_DAILY_JOB_INVALID'],
    ['not_found', 'STATS_DAILY_JOB_INVALID'],
    ['unavailable', 'STATS_DAILY_UNAVAILABLE'],
  ]) {
    await withFlagsAsync(FLAGS_ON, async () => {
      const failed = await runRegistered(job(), async () => {
        throw Object.assign(new Error(sourceCode), { code: sourceCode })
      })
      assert.equal(failed.finalizedParams[0][4], expectedCode)
      clearJobHandlers()
    })
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    const disabled = await runRegistered(job(), async () => {
      throw new Error('disabled worker must not call the port')
    }, () => {
      delete process.env.ELEARNING_ANALYTICS_ENABLED
    })
    assert.deepEqual(disabled.result, { claimed: 0 })
    assert.equal(disabled.calls, 0)
    assert.equal(disabled.finalizedParams.length, 0)
    clearJobHandlers()
  })

  console.log('✓ stats-daily-projector: analytics-gated durable job projection')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
