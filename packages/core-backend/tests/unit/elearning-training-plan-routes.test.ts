import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import {
  ElearningTrainingPlanError,
  type ElearningTrainingPlan,
  type ElearningTrainingPlanErrorCode,
  type ElearningTrainingPlanPublishResult,
  type GetElearningTrainingPlanInput,
  type PublishElearningTrainingPlanInput,
} from '../../src/services/elearning-training-plan'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-training-plan-route'
const ACTOR = 'actor-training-plan-route'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const COURSE = '22222222-2222-4222-8222-222222222222'
const PLAN = '33333333-3333-4333-8333-333333333333'
const PLAN_VERSION = '44444444-4444-4444-8444-444444444444'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const BODY = {
  requestId: REQUEST_ID,
  title: 'Onboarding plan',
  items: [{ courseVersionId: COURSE, required: true }],
}

const PUBLISH_RESULT: ElearningTrainingPlanPublishResult = {
  planId: PLAN,
  planVersionId: PLAN_VERSION,
  status: 'published',
  itemCount: 1,
  duplicate: false,
}

const PLAN_RESULT: ElearningTrainingPlan = {
  planId: PLAN,
  title: 'Onboarding plan',
  status: 'active',
  activeVersion: {
    planVersionId: PLAN_VERSION,
    version: 1,
    status: 'published',
    items: [{ courseVersionId: COURSE, position: 1, required: true }],
  },
}

const ERROR_STATUSES: Array<[ElearningTrainingPlanErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['course_unavailable', 409],
  ['conflict', 409],
  ['unavailable', 503],
]

const pinned = usePinnedServer()

function makeApp(options: {
  env?: NodeJS.ProcessEnv
  viewer?: string | null
  org?: string | null
  allowAdmin?: boolean
  publishError?: unknown
  getError?: unknown
} = {}) {
  const publishCalls: PublishElearningTrainingPlanInput[] = []
  const getCalls: GetElearningTrainingPlanInput[] = []
  const order: string[] = []
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(handler: (tx: { query: typeof db.query }) => Promise<T>) =>
      handler({ query: db.query }),
  }
  const router = createElearningPilotRouter({
    db,
    env: options.env ?? FLAG_ON,
    viewerId: () => {
      order.push('identity')
      return options.viewer === undefined ? ACTOR : options.viewer
    },
    orgId: () => {
      order.push('org')
      return options.org === undefined ? ORG : options.org
    },
    adminGuard: (_req, res, next) => {
      order.push('rbac')
      if (options.allowAdmin === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    readGuard: (_req, _res, next) => next(),
    publishElearningTrainingPlan: async (_db, input) => {
      order.push('service')
      publishCalls.push(input)
      if (options.publishError) throw options.publishError
      return PUBLISH_RESULT
    },
    getElearningTrainingPlan: async (_db, input) => {
      order.push('service')
      getCalls.push(input)
      if (options.getError) throw options.getError
      return PLAN_RESULT
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return { app, publishCalls, getCalls, order }
}

describe('e-learning training-plan routes', () => {
  it('uses assignment flags and global admin RBAC for publish and read', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/elearning-pilot.ts'), 'utf8')
    const runtime = readFileSync(
      join(__dirname, '../../src/services/elearning-pilot-runtime.ts'),
      'utf8',
    )
    const publishAt = src.indexOf(
      "router.post(\n    '/api/elearning/training-plans/publish'",
    )
    const getAt = src.indexOf(
      "router.get(\n    '/api/elearning/training-plans/:planId'",
    )
    expect(publishAt).toBeGreaterThan(-1)
    expect(getAt).toBeGreaterThan(publishAt)
    expect(src.slice(publishAt, publishAt + 350)).toMatch(
      /gate\(\s*deps\.adminGuard,\s*'assignment'\s*\)/,
    )
    expect(src.slice(getAt, getAt + 350)).toMatch(
      /gate\(\s*deps\.adminGuard,\s*'assignment',\s*null\s*\)/,
    )
    expect(runtime).toMatch(
      /opts\.publishElearningTrainingPlan\s*\?\?\s*publishElearningTrainingPlan/,
    )
    expect(runtime).toMatch(
      /opts\.getElearningTrainingPlan\s*\?\?\s*getElearningTrainingPlan/,
    )
    expect(runtime).toMatch(/rbacGuard\('elearning',\s*'admin'\)/)
  })

  it('publishes with injected actor/org and returns only the closed result', async () => {
    const fixture = makeApp()
    const response = await request(pinned.url())
      .post('/api/elearning/training-plans/publish?orgId=evil&actorId=evil')
      .set('x-tenant-id', 'evil-header-org')
      .send(BODY)
    expect(response.status).toBe(201)
    expect(response.body).toEqual(PUBLISH_RESULT)
    expect(Object.keys(response.body)).toEqual([
      'planId',
      'planVersionId',
      'status',
      'itemCount',
      'duplicate',
    ])
    expect(fixture.publishCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      ...BODY,
    }])
    expect(fixture.order).toEqual([
      'identity',
      'org',
      'rbac',
      'identity',
      'org',
      'service',
    ])
    expect(JSON.stringify(response.body)).not.toMatch(/org|actor|request|hash/i)
  })

  it('reads an org-scoped active plan with the closed version/item DTO', async () => {
    const fixture = makeApp()
    const response = await request(pinned.url())
      .get(`/api/elearning/training-plans/${PLAN}?orgId=evil`)
      .set('x-tenant-id', 'evil-header-org')
    expect(response.status).toBe(200)
    expect(response.body).toEqual(PLAN_RESULT)
    expect(fixture.getCalls).toEqual([{ orgId: ORG, planId: PLAN }])
    expect(Object.keys(response.body)).toEqual([
      'planId',
      'title',
      'status',
      'activeVersion',
    ])
    expect(Object.keys(response.body.activeVersion)).toEqual([
      'planVersionId',
      'version',
      'status',
      'items',
    ])
    expect(Object.keys(response.body.activeVersion.items[0])).toEqual([
      'courseVersionId',
      'position',
      'required',
    ])
  })

  it('rejects unknown/invalid input without reaching a service', async () => {
    const invalidBodies: unknown[] = [
      { ...BODY, orgId: 'evil' },
      { ...BODY, actorId: 'evil' },
      { ...BODY, extra: true },
      [BODY],
    ]
    for (const body of invalidBodies) {
      const fixture = makeApp()
      const response = await request(pinned.url())
        .post('/api/elearning/training-plans/publish')
        .send(body)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
      expect(fixture.publishCalls).toHaveLength(0)
    }
    const invalidPath = makeApp()
    const response = await request(pinned.url())
      .get('/api/elearning/training-plans/not-a-uuid')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_input' })
    expect(invalidPath.getCalls).toHaveLength(0)
  })

  it('fails closed before parsing/service when flags, identity, org, or RBAC deny', async () => {
    const cases = [
      {
        fixture: makeApp({
          env: { ...FLAG_ON, ELEARNING_ASSIGNMENT_ENABLED: 'false' } as NodeJS.ProcessEnv,
        }),
        status: 404,
        body: { error: 'not_found' },
        order: [] as string[],
      },
      {
        fixture: makeApp({ viewer: null }),
        status: 401,
        body: { error: 'unauthenticated' },
        order: ['identity'],
      },
      {
        fixture: makeApp({ org: null }),
        status: 403,
        body: { error: 'ORG_CONTEXT_REQUIRED' },
        order: ['identity', 'org'],
      },
      {
        fixture: makeApp({ allowAdmin: false }),
        status: 403,
        body: { error: 'Insufficient permissions' },
        order: ['identity', 'org', 'rbac'],
      },
    ]
    for (const expected of cases) {
      pinned.setApp(expected.fixture.app)
      const response = await request(pinned.url())
        .post('/api/elearning/training-plans/publish')
        .send({ ...BODY, title: 'x'.repeat(20 * 1024) })
      expect(response.status).toBe(expected.status)
      expect(response.body).toEqual(expected.body)
      expect(expected.fixture.order).toEqual(expected.order)
      expect(expected.fixture.publishCalls).toHaveLength(0)
    }
  })

  it('maps domain errors and hides unexpected internals', async () => {
    for (const [code, status] of ERROR_STATUSES) {
      const publishFixture = makeApp({
        publishError: new ElearningTrainingPlanError(code),
      })
      const publishResponse = await request(pinned.url())
        .post('/api/elearning/training-plans/publish')
        .send(BODY)
      expect(publishResponse.status).toBe(status)
      expect(publishResponse.body).toEqual({ error: code })

      const getFixture = makeApp({ getError: new ElearningTrainingPlanError(code) })
      const getResponse = await request(pinned.url())
        .get(`/api/elearning/training-plans/${PLAN}`)
      expect(getResponse.status).toBe(status)
      expect(getResponse.body).toEqual({ error: code })
      expect(getFixture.getCalls).toHaveLength(1)
    }
    const fixture = makeApp({ publishError: new Error('secret host stack') })
    const response = await request(pinned.url())
      .post('/api/elearning/training-plans/publish')
      .send(BODY)
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(response.body)).not.toMatch(/secret|host|stack/)
    expect(fixture.publishCalls).toHaveLength(1)
  })
})
