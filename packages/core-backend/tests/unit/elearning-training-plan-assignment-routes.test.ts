import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import {
  ElearningTrainingPlanAssignmentError,
  type AssignElearningTrainingPlanInput,
  type ElearningTrainingPlanAssignmentErrorCode,
} from '../../src/services/elearning-training-plan-assignment'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-plan-assign-route'
const ACTOR = 'actor-plan-assign-route'
const PLAN_ID = '20000000-0000-4000-8000-000000000001'
const PLAN_VERSION_ID = '20000000-0000-4000-8000-000000000002'
const PLAN_ASSIGNMENT_ID = '20000000-0000-4000-8000-000000000003'

const FLAGS = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const BODY = {
  sourceKey: 'plan-run-1',
  deadline: '2030-01-01T00:00:00.000Z',
  rules: [{
    subjectType: 'user',
    subjectRef: 'learner-1',
    includeChildren: false,
  }],
}

const RESULT = {
  planAssignmentId: PLAN_ASSIGNMENT_ID,
  planVersionId: PLAN_VERSION_ID,
  assignmentCount: 2,
  memberCount: 3,
  duplicate: false,
}

const ERROR_STATUSES: Array<[ElearningTrainingPlanAssignmentErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['plan_unavailable', 409],
  ['course_unavailable', 409],
  ['subject_not_found', 422],
  ['unsupported_subject', 422],
  ['empty_audience', 422],
  ['audience_too_large', 422],
  ['conflict', 409],
  ['unavailable', 503],
]

const pinned = usePinnedServer()

function makeApp(options: {
  env?: NodeJS.ProcessEnv
  viewer?: string | null
  org?: string | null
  allowAdmin?: boolean
  serviceError?: unknown
} = {}) {
  const calls: AssignElearningTrainingPlanInput[] = []
  const order: string[] = []
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(handler: (tx: { query: typeof db.query }) => Promise<T>) =>
      handler({ query: db.query }),
  }
  const router = createElearningPilotRouter({
    db,
    env: options.env ?? FLAGS,
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
    assignElearningTrainingPlan: async (_db, input) => {
      order.push('service')
      calls.push(input)
      if (options.serviceError) throw options.serviceError
      return RESULT
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return { app, calls, order }
}

describe('e-learning training-plan assignment route', () => {
  it('uses the assignment capability and global admin guard in route and runtime', () => {
    const route = readFileSync(
      join(__dirname, '../../src/routes/elearning-pilot.ts'),
      'utf8',
    )
    const runtime = readFileSync(
      join(__dirname, '../../src/services/elearning-pilot-runtime.ts'),
      'utf8',
    )
    const routeAt = route.indexOf(
      "router.post(\n    '/api/elearning/training-plans/:planId/assign'",
    )
    expect(routeAt).toBeGreaterThan(-1)
    expect(route.slice(routeAt, routeAt + 400)).toMatch(
      /gate\(\s*deps\.adminGuard,\s*'assignment'\s*\)/,
    )
    expect(runtime).toMatch(
      /opts\.assignElearningTrainingPlan\s*\?\?\s*assignElearningTrainingPlan/,
    )
    expect(runtime).toMatch(/rbacGuard\('elearning',\s*'admin'\)/)
  })

  it('injects authoritative actor/org and returns the closed result', async () => {
    const fixture = makeApp()
    const response = await request(pinned.url())
      .post(`/api/elearning/training-plans/${PLAN_ID}/assign?orgId=evil`)
      .set('x-tenant-id', 'evil-header')
      .send(BODY)

    expect(response.status).toBe(201)
    expect(response.body).toEqual(RESULT)
    expect(Object.keys(response.body)).toEqual([
      'planAssignmentId',
      'planVersionId',
      'assignmentCount',
      'memberCount',
      'duplicate',
    ])
    expect(fixture.calls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      planId: PLAN_ID,
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
    expect(JSON.stringify(response.body)).not.toMatch(/org|actor|source|rules|hash/i)
  })

  it('rejects unknown, missing, and malformed input without calling the service', async () => {
    const invalid: Array<{ path?: string; body: unknown }> = [
      { body: { ...BODY, orgId: 'evil' } },
      { body: { ...BODY, actorId: 'evil' } },
      { body: { ...BODY, extra: true } },
      { body: { sourceKey: BODY.sourceKey } },
      { body: { ...BODY, sourceKey: '' } },
      { body: { ...BODY, deadline: 1 } },
      { body: [BODY] },
      { path: 'not-a-uuid', body: BODY },
    ]
    for (const entry of invalid) {
      const fixture = makeApp()
      const response = await request(pinned.url())
        .post(`/api/elearning/training-plans/${entry.path ?? PLAN_ID}/assign`)
        .send(entry.body)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
      expect(fixture.calls).toEqual([])
    }
  })

  it('fails before JSON/service when flag, identity, org, or RBAC denies', async () => {
    const cases = [
      {
        fixture: makeApp({
          env: { ...FLAGS, ELEARNING_ASSIGNMENT_ENABLED: 'false' } as NodeJS.ProcessEnv,
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
        .post(`/api/elearning/training-plans/${PLAN_ID}/assign`)
        .send({ ...BODY, sourceKey: 'x'.repeat(20 * 1024) })
      expect(response.status).toBe(expected.status)
      expect(response.body).toEqual(expected.body)
      expect(expected.fixture.order).toEqual(expected.order)
      expect(expected.fixture.calls).toEqual([])
    }
  })

  it('maps domain errors and hides unexpected internals', async () => {
    for (const [code, status] of ERROR_STATUSES) {
      const fixture = makeApp({
        serviceError: new ElearningTrainingPlanAssignmentError(code),
      })
      const response = await request(pinned.url())
        .post(`/api/elearning/training-plans/${PLAN_ID}/assign`)
        .send(BODY)
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code })
      expect(fixture.calls).toHaveLength(1)
    }
    const fixture = makeApp({ serviceError: new Error('secret stack value') })
    const response = await request(pinned.url())
      .post(`/api/elearning/training-plans/${PLAN_ID}/assign`)
      .send(BODY)
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(response.body)).not.toMatch(/secret|stack|value/)
    expect(fixture.calls).toHaveLength(1)
  })
})
