import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningAnalyticsRouter } from '../../src/routes/elearning-analytics'
import {
  ElearningDepartmentStatsError,
  type GetElearningDepartmentStatsInput,
} from '../../src/services/elearning-department-stats'
import { buildElearningDepartmentStatsProjection } from '../../src/services/elearning-department-stats-policy'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-analytics-route'
const ACTOR = 'actor-analytics-route'
const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const START = '2026-08-01T00:00:00.000Z'
const END = '2026-09-01T00:00:00.000Z'
const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
} as NodeJS.ProcessEnv
const pinned = usePinnedServer()

function projection(memberCount = 5) {
  return buildElearningDepartmentStatsProjection({
    orgId: ORG,
    departmentId: DEPARTMENT,
    periodStart: START,
    periodEnd: END,
    sourceVersion: 'source-route-v1',
    minGroupSize: 5,
    counters: {
      assignedCount: 2,
      completedCount: 1,
      creditTotal: 10,
      examParticipantCount: 1,
      learnerCount: 2,
      learningSeconds: 120,
      memberCount,
      overdueCount: 1,
    },
  })
}

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  viewerId?: string | null
  orgId?: string | null
  allow?: boolean
  global?: boolean
  memberCount?: number
  error?: ElearningDepartmentStatsError
} = {}) {
  const calls: GetElearningDepartmentStatsInput[] = []
  let guardCalls = 0
  const router = createElearningAnalyticsRouter({
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    env: over.env ?? FLAG_ON,
    viewerId: () => over.viewerId === undefined ? ACTOR : over.viewerId,
    orgId: () => over.orgId === undefined ? ORG : over.orgId,
    isGlobalAdmin: () => over.global ?? false,
    statsGuard: (_req, res, next) => {
      guardCalls += 1
      if (over.allow === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    getElearningDepartmentStats: async (_db, input) => {
      calls.push(input)
      if (over.error) throw over.error
      return projection(over.memberCount ?? 5)
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return {
    mounted: router !== null,
    api: request(pinned.url()),
    calls,
    guardCalls: () => guardCalls,
  }
}

function path(query = `periodStart=${encodeURIComponent(START)}&periodEnd=${encodeURIComponent(END)}`) {
  return `/api/elearning/admin/analytics/departments/${DEPARTMENT}?${query}`
}

describe('e-learning analytics route', () => {
  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_ANALYTICS_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'TRUE' },
  ])('does not mount unless master and analytics are exact true %#', (env) => {
    expect(makeApp({ env }).mounted).toBe(false)
  })

  it('derives authority server-side and returns a closed visible DTO', async () => {
    const harness = makeApp({ global: false })
    const response = await harness.api.get(path())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      departmentId: DEPARTMENT,
      periodStart: START,
      periodEnd: END,
      sourceVersion: 'source-route-v1',
      suppressed: false,
      metrics: {
        assignedCount: 2,
        completedCount: 1,
        completionRate: 0.5,
        creditAverage: 2,
        creditTotal: 10,
        examParticipantCount: 1,
        learnerCount: 2,
        learningSeconds: 120,
        memberCount: 5,
        overdueCount: 1,
      },
    })
    expect(harness.calls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      departmentId: DEPARTMENT,
      periodStart: START,
      periodEnd: END,
    }])
    expect(response.body).not.toHaveProperty('orgId')
    expect(response.body).not.toHaveProperty('projectionKey')
    expect(response.body).not.toHaveProperty('payloadDigest')
  })

  it('returns a suppressed DTO without numeric aggregate fields', async () => {
    const response = await makeApp({ memberCount: 4 }).api.get(path())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      departmentId: DEPARTMENT,
      periodStart: START,
      periodEnd: END,
      sourceVersion: 'source-route-v1',
      suppressed: true,
    })
    expect(response.body).not.toHaveProperty('metrics')
  })

  it('fails before service for absent identity, org, permission or closed query', async () => {
    const anonymous = makeApp({ viewerId: null })
    expect((await anonymous.api.get(path())).status).toBe(401)
    expect(anonymous.guardCalls()).toBe(0)
    const noOrg = makeApp({ orgId: null })
    expect((await noOrg.api.get(path())).body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.guardCalls()).toBe(0)
    const denied = makeApp({ allow: false })
    expect((await denied.api.get(path())).status).toBe(403)
    expect(denied.calls).toEqual([])
    const injected = makeApp()
    expect((await injected.api.get(path(
      `periodStart=${encodeURIComponent(START)}&periodEnd=${encodeURIComponent(END)}&orgId=attacker`,
    ))).status).toBe(400)
    expect(injected.calls).toEqual([])
  })

  it.each([
    ['invalid_input', 400],
    ['forbidden', 403],
    ['not_found', 404],
    ['unavailable', 503],
  ] as const)('maps %s to a values-free response', async (code, status) => {
    const response = await makeApp({
      error: new ElearningDepartmentStatsError(code),
    }).api.get(path())
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
  })
})
