'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  ONBOARDING_ASSIGN_JOB_KIND,
  ONBOARDING_WEEKLY_REPORT_JOB_KIND,
  ONBOARDING_ASSIGNMENT_JOB_INVALID,
  ONBOARDING_WEEKLY_REPORT_JOB_INVALID,
  ONBOARDING_ASSIGNMENT_UNAVAILABLE,
  ONBOARDING_WEEKLY_REPORT_UNAVAILABLE,
  ONBOARDING_ASSIGNMENT_METHOD_REQUIRED,
  ONBOARDING_WEEKLY_REPORT_METHOD_REQUIRED,
  ONBOARDING_WEEKLY_REPORT_PRODUCER_METHOD_REQUIRED,
  ONBOARDING_WEEKLY_REPORT_PRODUCER_INTERVAL_MS,
  isOnboardingAssignmentEnabled,
  isOnboardingWeeklyReportEnabled,
  onboardingAssignmentInputFromJob,
  onboardingWeeklyReportInputFromJob,
  previousClosedUtcWeekStart,
  registerOnboardingWorker,
  runOnboardingWeeklyReportProducerTick,
  startOnboardingWeeklyReportProducerRuntime,
  stopOnboardingWeeklyReportProducerRuntime,
} = require('../lib/onboarding-worker.cjs')
const {
  clearJobHandlers,
  registeredKinds,
  runJobsTick,
  stopJobsWorker,
} = require('../lib/jobs.cjs')
const { LOOKALIKES, withFlagsAsync } = require('./helpers.cjs')

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const POLICY_ID = '22222222-2222-4222-8222-222222222222'
const EFFECT_ID = '33333333-3333-4333-8333-333333333333'
const PLAN_ASSIGNMENT_ID = '44444444-4444-4444-8444-444444444444'
const REPORT_ID = '55555555-5555-4555-8555-555555555555'
const ORG_ID = 'org-onboarding-worker'
const USER_ID = 'user-onboarding-worker'
const HIRE_DATE = '2026-08-20'
const WEEK_START = '2026-08-24'
const FLAGS = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
})

function assignmentOccurrence() {
  const canonical = JSON.stringify({
    domain: 'elearning.onboarding.assignment.v1',
    hireDate: HIRE_DATE,
    orgId: ORG_ID,
    policyId: POLICY_ID,
    userId: USER_ID,
  })
  return `onboarding-assign-v1:${createHash('sha256').update(canonical).digest('hex')}`
}

function assignmentJob(overrides = {}) {
  return {
    id: JOB_ID,
    org_id: ORG_ID,
    kind: ONBOARDING_ASSIGN_JOB_KIND,
    occurrence_key: assignmentOccurrence(),
    ref: POLICY_ID,
    payload: { policyId: POLICY_ID, userId: USER_ID, hireDate: HIRE_DATE },
    status: 'running',
    attempts: 1,
    ...overrides,
  }
}

function weeklyReportJob(overrides = {}) {
  return {
    id: JOB_ID,
    org_id: ORG_ID,
    kind: ONBOARDING_WEEKLY_REPORT_JOB_KIND,
    occurrence_key: `policy:${POLICY_ID}:week:${WEEK_START}`,
    ref: POLICY_ID,
    payload: { policyId: POLICY_ID, weekStart: WEEK_START },
    status: 'running',
    attempts: 1,
    ...overrides,
  }
}

function databaseFor(claimed, finalized) {
  return {
    async query(sql, params) {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed]
      if (sql.includes("status = 'succeeded'")) {
        finalized.push(params)
        return [{ id: claimed.id }]
      }
      if (sql.includes('status = CASE')) {
        finalized.push(params)
        return [{ id: claimed.id, status: 'failed', last_error: params[4], attempts: 1 }]
      }
      return []
    },
  }
}

async function run(kind, claimed, port) {
  clearJobHandlers()
  registerOnboardingWorker({ services: { elearningOnboarding: port } })
  const finalized = []
  const result = await runJobsTick({
    database: databaseFor(claimed, finalized),
    workerId: 'worker-onboarding',
    kinds: [kind],
  })
  clearJobHandlers()
  return { finalized, result }
}

async function main() {
  stopJobsWorker()
  stopOnboardingWeeklyReportProducerRuntime()
  clearJobHandlers()

  assert.equal(ONBOARDING_WEEKLY_REPORT_PRODUCER_INTERVAL_MS, 60_000)
  assert.equal(previousClosedUtcWeekStart('2026-08-31T12:00:00.000Z'), '2026-08-24')
  assert.equal(previousClosedUtcWeekStart('2026-09-06T23:59:59.999Z'), '2026-08-24')
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.cjs'), 'utf8')
  assert.match(indexSource, /startOnboardingWeeklyReportProducerRuntime\(context\)/)
  assert.match(indexSource, /stopOnboardingWeeklyReportProducerRuntime\(\)/)

  await withFlagsAsync({}, async () => {
    const throwingContext = new Proxy({}, {
      get() { throw new Error('flags OFF must not inspect context') },
    })
    assert.equal(isOnboardingAssignmentEnabled(), false)
    assert.equal(isOnboardingWeeklyReportEnabled(), false)
    assert.equal(registerOnboardingWorker({ services: {} }), false)
    assert.equal(startOnboardingWeeklyReportProducerRuntime(throwingContext), false)
    assert.deepEqual(registeredKinds(), [])
  })
  for (const lookalike of LOOKALIKES) {
    await withFlagsAsync({
      ...FLAGS,
      ELEARNING_CONTENT_ENABLED: lookalike,
      ELEARNING_ANALYTICS_ENABLED: undefined,
    }, async () => {
      assert.equal(registerOnboardingWorker({ services: {} }), false)
    })
    await withFlagsAsync({
      ...FLAGS,
      ELEARNING_ASSIGNMENT_ENABLED: lookalike,
      ELEARNING_ANALYTICS_ENABLED: undefined,
    }, async () => {
      assert.equal(registerOnboardingWorker({ services: {} }), false)
    })
    await withFlagsAsync({
      ...FLAGS,
      ELEARNING_ASSIGNMENT_ENABLED: undefined,
      ELEARNING_ANALYTICS_ENABLED: lookalike,
    }, async () => {
      assert.equal(registerOnboardingWorker({ services: {} }), false)
    })
  }

  await withFlagsAsync({ ...FLAGS, ELEARNING_ANALYTICS_ENABLED: undefined }, async () => {
    assert.throws(
      () => registerOnboardingWorker({ services: { elearningOnboarding: {} } }),
      (error) => error && error.code === ONBOARDING_ASSIGNMENT_METHOD_REQUIRED,
    )
  })
  clearJobHandlers()

  await withFlagsAsync({
    ELEARNING_ENABLED: 'true',
    ELEARNING_ANALYTICS_ENABLED: 'true',
  }, async () => {
    assert.throws(
      () => startOnboardingWeeklyReportProducerRuntime({ services: {} }),
      (error) => error && error.code === ONBOARDING_WEEKLY_REPORT_PRODUCER_METHOD_REQUIRED,
    )
    let calls = 0
    const port = {
      async enqueueWeeklyReports(input) {
        calls += 1
        assert.deepEqual(input, { weekStart: WEEK_START })
        return { weekStart: WEEK_START, enqueuedCount: 2 }
      },
    }
    assert.equal(startOnboardingWeeklyReportProducerRuntime({
      services: { elearningOnboarding: port },
    }), true)
    assert.equal(calls, 0, 'start must wait for the bounded producer tick')
    assert.deepEqual(await runOnboardingWeeklyReportProducerTick({
      port,
      now: '2026-08-31T12:00:00.000Z',
    }), {
      weekStart: WEEK_START,
      enqueuedCount: 2,
    })
    assert.equal(calls, 1)
    stopOnboardingWeeklyReportProducerRuntime()
  })
  await withFlagsAsync({ ...FLAGS, ELEARNING_ASSIGNMENT_ENABLED: undefined }, async () => {
    assert.throws(
      () => registerOnboardingWorker({ services: { elearningOnboarding: {} } }),
      (error) => error && error.code === ONBOARDING_WEEKLY_REPORT_METHOD_REQUIRED,
    )
  })
  clearJobHandlers()

  await withFlagsAsync(FLAGS, async () => {
    assert.throws(
      () => registerOnboardingWorker({ services: {} }),
      (error) => error && error.code === 'ONBOARDING_PORT_REQUIRED',
    )
    clearJobHandlers()
    registerOnboardingWorker({
      services: {
        elearningOnboarding: {
          async processAssignment() {},
          async materializeWeeklyReport() {},
        },
      },
    })
    assert.deepEqual(registeredKinds(), [
      ONBOARDING_ASSIGN_JOB_KIND,
      ONBOARDING_WEEKLY_REPORT_JOB_KIND,
    ])
    clearJobHandlers()
  })

  assert.deepEqual(onboardingAssignmentInputFromJob(assignmentJob()), {
    orgId: ORG_ID,
    jobId: JOB_ID,
  })
  assert.deepEqual(onboardingWeeklyReportInputFromJob(weeklyReportJob()), {
    orgId: ORG_ID,
    jobId: JOB_ID,
  })
  for (const invalid of [
    null,
    assignmentJob({ id: 'not-a-uuid' }),
    assignmentJob({ org_id: ` ${ORG_ID}` }),
    assignmentJob({ ref: 'not-a-uuid' }),
    assignmentJob({ occurrence_key: 'onboarding-assign-v1:wrong' }),
    assignmentJob({ payload: {} }),
    assignmentJob({ payload: { policyId: POLICY_ID, userId: USER_ID, hireDate: HIRE_DATE, extra: true } }),
    assignmentJob({ payload: { policyId: POLICY_ID, userId: USER_ID, hireDate: '2026-02-30' } }),
  ]) {
    assert.throws(
      () => onboardingAssignmentInputFromJob(invalid),
      (error) => error && error.code === ONBOARDING_ASSIGNMENT_JOB_INVALID,
    )
  }
  for (const invalid of [
    null,
    weeklyReportJob({ id: 'not-a-uuid' }),
    weeklyReportJob({ org_id: ` ${ORG_ID}` }),
    weeklyReportJob({ ref: 'not-a-uuid' }),
    weeklyReportJob({ occurrence_key: `policy:${POLICY_ID}:week:2026-08-23` }),
    weeklyReportJob({ payload: {} }),
    weeklyReportJob({ payload: { policyId: POLICY_ID, weekStart: WEEK_START, extra: true } }),
    weeklyReportJob({ payload: { policyId: POLICY_ID, weekStart: '2026-02-30' } }),
  ]) {
    assert.throws(
      () => onboardingWeeklyReportInputFromJob(invalid),
      (error) => error && error.code === ONBOARDING_WEEKLY_REPORT_JOB_INVALID,
    )
  }

  await withFlagsAsync(FLAGS, async () => {
    const calls = []
    const accepted = await run(ONBOARDING_ASSIGN_JOB_KIND, assignmentJob(), {
      async processAssignment(input) {
        calls.push(['assignment', input])
        return {
          effectId: EFFECT_ID,
          policyId: POLICY_ID,
          userId: USER_ID,
          planAssignmentId: PLAN_ASSIGNMENT_ID,
          duplicate: false,
        }
      },
      async materializeWeeklyReport(input) {
        calls.push(['weekly', input])
        return {
          reportId: REPORT_ID,
          policyId: POLICY_ID,
          weekStart: WEEK_START,
          weekEnd: '2026-08-31',
          suppressed: true,
          minGroupSize: 5,
          enqueuedCount: null,
          assignedUserCount: null,
          failedCount: null,
          deadCount: null,
          duplicate: false,
        }
      },
    })
    assert.equal(accepted.result.claimed, 1)
    assert.equal(accepted.finalized.length, 1)
    assert.deepEqual(calls, [['assignment', { orgId: ORG_ID, jobId: JOB_ID }]])
  })

  await withFlagsAsync(FLAGS, async () => {
    const accepted = await run(ONBOARDING_WEEKLY_REPORT_JOB_KIND, weeklyReportJob(), {
      async processAssignment() {
        return {
          effectId: EFFECT_ID,
          policyId: POLICY_ID,
          userId: USER_ID,
          planAssignmentId: PLAN_ASSIGNMENT_ID,
          duplicate: true,
        }
      },
      async materializeWeeklyReport(input) {
        assert.deepEqual(input, { orgId: ORG_ID, jobId: JOB_ID })
        return {
          reportId: REPORT_ID,
          policyId: POLICY_ID,
          weekStart: WEEK_START,
          weekEnd: '2026-08-31',
          suppressed: false,
          minGroupSize: 5,
          enqueuedCount: 5,
          assignedUserCount: 4,
          failedCount: 1,
          deadCount: 0,
          duplicate: false,
        }
      },
    })
    assert.equal(accepted.result.claimed, 1)
    assert.equal(accepted.finalized.length, 1)
  })

  await withFlagsAsync(FLAGS, async () => {
    const assignmentUnavailable = await run(ONBOARDING_ASSIGN_JOB_KIND, assignmentJob(), {
      async processAssignment() { throw new Error('secret assignment failure') },
      async materializeWeeklyReport() { return null },
    })
    assert.equal(assignmentUnavailable.finalized[0][4], ONBOARDING_ASSIGNMENT_UNAVAILABLE)
    const weeklyUnavailable = await run(ONBOARDING_WEEKLY_REPORT_JOB_KIND, weeklyReportJob(), {
      async processAssignment() { return null },
      async materializeWeeklyReport() { return null },
    })
    assert.equal(weeklyUnavailable.finalized[0][4], ONBOARDING_WEEKLY_REPORT_UNAVAILABLE)
  })

  clearJobHandlers()
  stopOnboardingWeeklyReportProducerRuntime()
  stopJobsWorker()
  console.log('✓ onboarding-worker: assignment and weekly report durable handlers')
}

main().catch((error) => {
  stopOnboardingWeeklyReportProducerRuntime()
  stopJobsWorker()
  clearJobHandlers()
  console.error(error)
  process.exit(1)
})
