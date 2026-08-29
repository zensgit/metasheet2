import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import {
  ElearningBatchAssignmentError,
  type AssignElearningBatchInput,
  type ElearningBatchAssignmentErrorCode,
  type ElearningBatchAssignmentResult,
} from '../../src/services/elearning-batch-assignment'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-batch-route'
const ACTOR = 'actor-batch-route'
const VERSION = '11111111-1111-4111-8111-111111111111'
const ASSIGNMENT = '22222222-2222-4222-8222-222222222222'
const BODY = {
  courseVersionId: VERSION,
  sourceKey: 'batch-route-source',
  rules: [{ subjectType: 'all' }],
}
const RESULT: ElearningBatchAssignmentResult = {
  assignmentId: ASSIGNMENT,
  memberCount: 2,
  duplicate: false,
}

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const ERROR_STATUSES: Array<[ElearningBatchAssignmentErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
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
  error?: unknown
} = {}) {
  const calls: AssignElearningBatchInput[] = []
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
    assignElearningBatch: async (_db, input) => {
      order.push('service')
      calls.push(input)
      if (options.error) throw options.error
      return RESULT
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return { app, calls, order }
}

describe('POST /api/elearning/assignments/batch', () => {
  it('uses JWT actor/org, admin guard, strict keys, and a private result', async () => {
    const fixture = makeApp()
    const response = await request(pinned.url())
      .post('/api/elearning/assignments/batch?orgId=evil&actorId=evil')
      .set('x-tenant-id', 'evil-header-org')
      .send({ ...BODY, deadline: '2026-12-31T00:00:00.000Z' })
    expect(response.status).toBe(201)
    expect(response.body).toEqual(RESULT)
    expect(fixture.calls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      courseVersionId: VERSION,
      sourceKey: BODY.sourceKey,
      deadline: '2026-12-31T00:00:00.000Z',
      rules: BODY.rules,
    }])
    expect(fixture.order).toEqual([
      'identity',
      'org',
      'rbac',
      'identity',
      'org',
      'service',
    ])
    expect(JSON.stringify(response.body)).not.toMatch(/user|rule|org|actor|source/i)

    for (const body of [
      { ...BODY, orgId: 'evil' },
      { ...BODY, actorId: 'evil' },
      { ...BODY, extra: true },
      { courseVersionId: VERSION, sourceKey: BODY.sourceKey },
      { ...BODY, courseVersionId: 'bad' },
      { ...BODY, sourceKey: ' ' },
      { ...BODY, deadline: 1 },
      null,
      [BODY],
    ]) {
      const invalid = makeApp()
      const result = await request(pinned.url())
        .post('/api/elearning/assignments/batch')
        .send(body)
      expect(result.status).toBe(400)
      expect(result.body).toEqual({ error: 'invalid_input' })
      expect(invalid.calls).toHaveLength(0)
    }
  })

  it('fails closed before parsing/service when flags, identity, org, or RBAC deny', async () => {
    const huge = { ...BODY, sourceKey: 'x'.repeat(20 * 1024) }
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
        .post('/api/elearning/assignments/batch')
        .send(huge)
      expect(response.status).toBe(expected.status)
      expect(response.body).toEqual(expected.body)
      expect(expected.fixture.order).toEqual(expected.order)
      expect(expected.fixture.calls).toHaveLength(0)
    }

    const allowed = makeApp()
    const oversized = await request(pinned.url())
      .post('/api/elearning/assignments/batch')
      .send(huge)
    expect(oversized.status).toBe(400)
    expect(oversized.body).toEqual({ error: 'invalid_input' })
    expect(allowed.calls).toHaveLength(0)
  })

  it('maps every domain error without exposing values or internals', async () => {
    for (const [code, status] of ERROR_STATUSES) {
      const fixture = makeApp({ error: new ElearningBatchAssignmentError(code) })
      const response = await request(pinned.url())
        .post('/api/elearning/assignments/batch')
        .send(BODY)
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code })
      expect(fixture.calls).toHaveLength(1)
    }
    const boom = makeApp({ error: new Error('secret host stack') })
    const response = await request(pinned.url())
      .post('/api/elearning/assignments/batch')
      .send(BODY)
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(response.body)).not.toMatch(/secret|host|stack/)
    expect(boom.calls).toHaveLength(1)
  })
})
