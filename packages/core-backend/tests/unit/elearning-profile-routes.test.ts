import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningProfileRouter } from '../../src/routes/elearning-profile'
import {
  ElearningLearningProfileError,
  type GetElearningLearningProfileInput,
} from '../../src/services/elearning-learning-profile'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-profile-route'
const USER = 'user-profile-route'
const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
} as NodeJS.ProcessEnv
const pinned = usePinnedServer()

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  viewerId?: string | null
  orgId?: string | null
  allow?: boolean
  error?: ElearningLearningProfileError
} = {}) {
  const calls: GetElearningLearningProfileInput[] = []
  let guardCalls = 0
  const router = createElearningProfileRouter({
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    env: over.env ?? FLAG_ON,
    viewerId: () => over.viewerId === undefined ? USER : over.viewerId,
    orgId: () => over.orgId === undefined ? ORG : over.orgId,
    readGuard: (_req, res, next) => {
      guardCalls += 1
      if (over.allow === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    getElearningLearningProfile: async (_db, input) => {
      calls.push(input)
      if (over.error) throw over.error
      return {
        userId: input.userId,
        summary: { completedCourses: 1, assessmentCourses: 0, contentCourses: 1 },
        courses: [{
          courseId: '11111111-1111-4111-8111-111111111111',
          courseVersionId: '22222222-2222-4222-8222-222222222222',
          title: 'Content archive',
          kind: 'content',
          completedAt: '2026-08-30T00:00:00.000Z',
          internalSecret: 'must-not-leak',
        } as never],
        nextCursor: null,
        internalSecret: 'must-not-leak',
      } as never
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

describe('e-learning profile route', () => {
  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_INCENTIVE_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'TRUE', ELEARNING_INCENTIVE_ENABLED: 'true' },
  ])('does not mount unless master and incentive are exact true %#', (env) => {
    expect(makeApp({ env }).mounted).toBe(false)
  })

  it('uses server-derived learner context and returns a closed DTO', async () => {
    const harness = makeApp()
    const response = await harness.api.get('/api/elearning/profile?limit=25')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      userId: USER,
      summary: { completedCourses: 1, assessmentCourses: 0, contentCourses: 1 },
      courses: [{
        courseId: '11111111-1111-4111-8111-111111111111',
        courseVersionId: '22222222-2222-4222-8222-222222222222',
        title: 'Content archive',
        kind: 'content',
        completedAt: '2026-08-30T00:00:00.000Z',
      }],
      nextCursor: null,
    })
    expect(harness.calls).toEqual([{ orgId: ORG, userId: USER, limit: 25 }])
    expect(harness.guardCalls()).toBe(1)
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak')
  })

  it('fails before service for missing context, denied RBAC and invalid query', async () => {
    const anonymous = makeApp({ viewerId: null })
    expect((await anonymous.api.get('/api/elearning/profile')).status).toBe(401)
    expect(anonymous.guardCalls()).toBe(0)
    const noOrg = makeApp({ orgId: null })
    expect((await noOrg.api.get('/api/elearning/profile')).status).toBe(403)
    expect(noOrg.guardCalls()).toBe(0)
    const denied = makeApp({ allow: false })
    expect((await denied.api.get('/api/elearning/profile')).status).toBe(403)
    expect(denied.calls).toEqual([])
    const injected = makeApp()
    expect((await injected.api.get('/api/elearning/profile?userId=attacker')).status).toBe(400)
    expect(injected.calls).toEqual([])
  })

  it.each([
    ['invalid_input', 400],
    ['forbidden', 403],
    ['unavailable', 503],
  ] as const)('maps %s to a values-free response', async (code, status) => {
    const response = await makeApp({
      error: new ElearningLearningProfileError(code),
    }).api.get('/api/elearning/profile')
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
  })
})
