import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningOnboardingRouter } from '../../src/routes/elearning-onboarding'
import { ElearningOnboardingPolicyError } from '../../src/services/elearning-onboarding-policy'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-onboarding-route'
const ACTOR = 'actor-onboarding-route'
const POLICY = '11111111-1111-4111-8111-111111111111'
const PLAN = '22222222-2222-4222-8222-222222222222'
const REQUEST = '33333333-3333-4333-8333-333333333333'
const REPORT = '44444444-4444-4444-8444-444444444444'
const DEPARTMENT = '55555555-5555-4555-8555-555555555555'
const WEEK = '2026-08-24'
const ASSIGNMENT_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
} as NodeJS.ProcessEnv
const ANALYTICS_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
} as NodeJS.ProcessEnv
const BOTH_ON = {
  ...ASSIGNMENT_ON,
  ELEARNING_ANALYTICS_ENABLED: 'true',
} as NodeJS.ProcessEnv
const pinned = usePinnedServer()

const createBody = {
  requestId: REQUEST,
  trainingPlanId: PLAN,
  matchRules: [{
    subjectType: 'department',
    subjectRef: DEPARTMENT,
    includeChildren: true,
  }],
  hireWindowDays: 30,
  deadlineDays: 14,
  weeklyReportEnabled: true,
}

function policyDto(duplicate = false) {
  return {
    policyId: POLICY,
    trainingPlanId: PLAN,
    matchRules: createBody.matchRules,
    hireWindowDays: 30,
    deadlineDays: 14,
    weeklyReportEnabled: true,
    status: 'active' as const,
    createdAt: '2026-08-31T00:00:00.000Z',
    retiredAt: null,
    duplicate,
  }
}

function reportDto() {
  return {
    reportId: REPORT,
    policyId: POLICY,
    weekStart: WEEK,
    weekEnd: '2026-08-31',
    suppressed: true,
    minGroupSize: 5 as const,
    enqueuedCount: null,
    assignedUserCount: null,
    failedCount: null,
    deadCount: null,
    duplicate: false,
  }
}

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  viewerId?: string | null
  orgId?: string | null
  allowAdmin?: boolean
  allowStats?: boolean
  createError?: ElearningOnboardingPolicyError
} = {}) {
  const createCalls: unknown[] = []
  const retireCalls: unknown[] = []
  const reportCalls: unknown[] = []
  const router = createElearningOnboardingRouter({
    db: {
      async query() { return { rows: [], rowCount: 0 } },
      async transaction(run) { return run(this) },
    },
    env: over.env ?? BOTH_ON,
    viewerId: () => over.viewerId === undefined ? ACTOR : over.viewerId,
    orgId: () => over.orgId === undefined ? ORG : over.orgId,
    adminGuard: (_req, res, next) => {
      if (over.allowAdmin === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    statsGuard: (_req, res, next) => {
      if (over.allowStats === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    createPolicy: async (_db, input) => {
      createCalls.push(input)
      if (over.createError) throw over.createError
      return policyDto()
    },
    retirePolicy: async (_db, input) => {
      retireCalls.push(input)
      return { ...policyDto(), status: 'retired', retiredAt: '2026-09-01T00:00:00.000Z' }
    },
    getWeeklyReport: async (_db, input) => {
      reportCalls.push(input)
      return reportDto()
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return {
    mounted: router !== null,
    api: request(pinned.url()),
    createCalls,
    retireCalls,
    reportCalls,
  }
}

describe('e-learning onboarding routes', () => {
  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_ASSIGNMENT_ENABLED: 'true' },
    { ELEARNING_ANALYTICS_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_ASSIGNMENT_ENABLED: 'TRUE' },
  ])('does not mount unless master and one owned capability are exact true %#', (env) => {
    expect(makeApp({ env }).mounted).toBe(false)
  })

  it('creates a policy from a closed body with server-derived org and actor', async () => {
    const harness = makeApp({ env: ASSIGNMENT_ON })
    const response = await harness.api
      .post('/api/elearning/admin/onboarding/policies')
      .send(createBody)
    expect(response.status).toBe(201)
    expect(response.body).toEqual(policyDto())
    expect(harness.createCalls).toEqual([{ orgId: ORG, actorId: ACTOR, ...createBody }])
    expect(response.body).not.toHaveProperty('orgId')
    expect(response.body).not.toHaveProperty('createdBy')
  })

  it('rejects extra command keys before the service', async () => {
    const harness = makeApp({ env: ASSIGNMENT_ON })
    const response = await harness.api
      .post('/api/elearning/admin/onboarding/policies')
      .send({ ...createBody, orgId: 'client-org' })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_input' })
    expect(harness.createCalls).toEqual([])
  })

  it('retires under assignment authority and keeps analytics independently disabled', async () => {
    const harness = makeApp({ env: ASSIGNMENT_ON })
    const retired = await harness.api.post(
      `/api/elearning/admin/onboarding/policies/${POLICY}/retire`,
    )
    expect(retired.status).toBe(200)
    expect(harness.retireCalls).toEqual([{ orgId: ORG, actorId: ACTOR, policyId: POLICY }])
    const report = await harness.api.get(
      `/api/elearning/admin/onboarding/policies/${POLICY}/reports/${WEEK}`,
    )
    expect(report.status).toBe(404)
    expect(report.body).toEqual({ error: 'feature_disabled' })
    expect(harness.reportCalls).toEqual([])
  })

  it('reads a suppressed weekly report only through analytics authority', async () => {
    const harness = makeApp({ env: ANALYTICS_ON })
    const create = await harness.api
      .post('/api/elearning/admin/onboarding/policies')
      .send(createBody)
    expect(create.status).toBe(404)
    expect(create.body).toEqual({ error: 'feature_disabled' })
    const response = await harness.api.get(
      `/api/elearning/admin/onboarding/policies/${POLICY}/reports/${WEEK}`,
    )
    expect(response.status).toBe(200)
    expect(response.body).toEqual(reportDto())
    expect(harness.reportCalls).toEqual([{ orgId: ORG, policyId: POLICY, weekStart: WEEK }])
  })

  it('fails before RBAC/service without authenticated org and actor authority', async () => {
    const noActor = makeApp({ viewerId: null })
    expect((await noActor.api.post('/api/elearning/admin/onboarding/policies').send(createBody)).status)
      .toBe(401)
    expect(noActor.createCalls).toEqual([])

    const noOrg = makeApp({ orgId: null })
    const response = await noOrg.api.post('/api/elearning/admin/onboarding/policies').send(createBody)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.createCalls).toEqual([])

    const denied = makeApp({ allowAdmin: false })
    expect((await denied.api.post('/api/elearning/admin/onboarding/policies').send(createBody)).status)
      .toBe(403)
    expect(denied.createCalls).toEqual([])
  })

  it('maps known failures to values-free status codes', async () => {
    const harness = makeApp({ createError: new ElearningOnboardingPolicyError('conflict') })
    const response = await harness.api
      .post('/api/elearning/admin/onboarding/policies')
      .send(createBody)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'conflict' })
    expect(JSON.stringify(response.body)).not.toContain(PLAN)
  })
})
