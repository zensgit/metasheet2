import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import {
  ElearningAssignmentLifecycleError,
  type ElearningAssignmentLifecycleErrorCode,
  type ElearningAssignmentProgressResult,
  type ElearningAssignmentRevocationResult,
  type ListElearningAssignmentProgressInput,
  type RevokeElearningAssignmentMemberInput,
} from '../../src/services/elearning-assignment-lifecycle'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-lifecycle-route'
const ACTOR = 'actor-lifecycle-route'
const LEARNER = 'learner-lifecycle-route'
const ASSIGNMENT = '11111111-1111-4111-8111-111111111111'
const MEMBER = '22222222-2222-4222-8222-222222222222'
const VERSION = '33333333-3333-4333-8333-333333333333'
const CURSOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const PROGRESS_RESULT: ElearningAssignmentProgressResult = {
  assignmentId: ASSIGNMENT,
  courseVersionId: VERSION,
  deadline: '2026-01-01T00:00:00.000Z',
  members: [{
    memberId: MEMBER,
    userId: LEARNER,
    source: 'manual',
    assignedAt: '2026-01-02T00:00:00.000Z',
    revokedAt: null,
    overdue: true,
    videoStatus: 'not_started',
    examStatus: 'not_started',
    passed: false,
    courseStatus: 'not_started',
  }],
  nextCursor: null,
}

const REVOKE_RESULT: ElearningAssignmentRevocationResult = {
  assignmentId: ASSIGNMENT,
  memberId: MEMBER,
  revoked: true,
  duplicate: false,
}

const ERROR_STATUSES: Array<[ElearningAssignmentLifecycleErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['conflict', 409],
  ['unavailable', 503],
]

const pinned = usePinnedServer()

function makeApp(options: {
  env?: NodeJS.ProcessEnv
  viewer?: string | null
  org?: string | null
  allowAdmin?: boolean
  allowRead?: boolean
  listError?: unknown
  revokeError?: unknown
  listResult?: ElearningAssignmentProgressResult
  revokeResult?: ElearningAssignmentRevocationResult
} = {}) {
  const listCalls: ListElearningAssignmentProgressInput[] = []
  const revokeCalls: RevokeElearningAssignmentMemberInput[] = []
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
    readGuard: (_req, res, next) => {
      order.push('read')
      if (options.allowRead === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    listElearningAssignmentProgress: async (_db, input) => {
      order.push('service')
      listCalls.push(input)
      if (options.listError) throw options.listError
      return options.listResult ?? PROGRESS_RESULT
    },
    revokeElearningAssignmentMember: async (_db, input) => {
      order.push('service')
      revokeCalls.push(input)
      if (options.revokeError) throw options.revokeError
      return options.revokeResult ?? REVOKE_RESULT
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return { app, listCalls, revokeCalls, order }
}

describe('GET /api/elearning/assignments/:assignmentId', () => {
  it('registers after static assignment writes and uses admin assignment gates', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/elearning-pilot.ts'), 'utf8')
    const directAt = src.indexOf("router.post(\n    '/api/elearning/assignments/direct'")
    const batchAt = src.indexOf("router.post(\n    '/api/elearning/assignments/batch'")
    const getAt = src.indexOf("router.get(\n    '/api/elearning/assignments/:assignmentId'")
    const revokeAt = src.indexOf(
      "router.put(\n    '/api/elearning/assignments/:assignmentId/members/:memberId/revocation'",
    )
    expect(directAt).toBeGreaterThan(-1)
    expect(batchAt).toBeGreaterThan(directAt)
    expect(getAt).toBeGreaterThan(batchAt)
    expect(revokeAt).toBeGreaterThan(getAt)
    expect(src.slice(getAt, getAt + 400)).toMatch(/gate\(\s*deps\.adminGuard,\s*'assignment',\s*null\s*\)/)
    expect(src.slice(revokeAt, revokeAt + 400)).toMatch(/gate\(\s*deps\.adminGuard,\s*'assignment'\s*\)/)
  })

  it('is assignment-admin gated, org-scoped, and returns the closed progress DTO', async () => {
    const fixture = makeApp()
    const response = await request(pinned.url())
      .get(`/api/elearning/assignments/${ASSIGNMENT}?cursor=${CURSOR}&limit=50&orgId=evil&actorId=evil`)
      .set('x-tenant-id', 'evil-header-org')
    expect(response.status).toBe(200)
    expect(response.body).toEqual(PROGRESS_RESULT)
    expect(Object.keys(response.body)).toEqual([
      'assignmentId',
      'courseVersionId',
      'deadline',
      'members',
      'nextCursor',
    ])
    expect(Object.keys(response.body.members[0])).toEqual([
      'memberId',
      'userId',
      'source',
      'assignedAt',
      'revokedAt',
      'overdue',
      'videoStatus',
      'examStatus',
      'passed',
      'courseStatus',
    ])
    expect(JSON.stringify(response.body)).not.toMatch(
      /score|answer|storage|revocation_reason|revoked_by|assigned_by|request_hash/i,
    )
    expect(fixture.listCalls).toEqual([{
      orgId: ORG,
      assignmentId: ASSIGNMENT,
      cursor: CURSOR,
      limit: 50,
    }])
    expect(fixture.order).toEqual([
      'identity',
      'org',
      'rbac',
      'identity',
      'org',
      'service',
    ])
    expect(fixture.revokeCalls).toHaveLength(0)
  })

  it('fails closed before service when flags, identity, org, or admin RBAC deny', async () => {
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
        .get(`/api/elearning/assignments/${ASSIGNMENT}`)
      expect(response.status).toBe(expected.status)
      expect(response.body).toEqual(expected.body)
      expect(expected.fixture.order).toEqual(expected.order)
      expect(expected.fixture.listCalls).toHaveLength(0)
      expect(JSON.stringify(response.body)).not.toContain(ORG)
    }

    const learner = makeApp({ allowAdmin: false, allowRead: true, viewer: LEARNER })
    const denied = await request(pinned.url())
      .get(`/api/elearning/assignments/${ASSIGNMENT}`)
    expect(denied.status).toBe(403)
    expect(learner.listCalls).toHaveLength(0)
    expect(learner.order).not.toContain('read')
  })

  it('rejects invalid path, cursor, and limit without calling the service', async () => {
    for (const path of [
      '/api/elearning/assignments/not-a-uuid',
      `/api/elearning/assignments/${ASSIGNMENT}?cursor=bad`,
      `/api/elearning/assignments/${ASSIGNMENT}?limit=0`,
      `/api/elearning/assignments/${ASSIGNMENT}?limit=101`,
      `/api/elearning/assignments/${ASSIGNMENT}?limit=1.5`,
      `/api/elearning/assignments/${ASSIGNMENT}?limit=`,
      `/api/elearning/assignments/${ASSIGNMENT}?cursor=`,
    ]) {
      const fixture = makeApp()
      const response = await request(pinned.url()).get(path)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
      expect(fixture.listCalls).toHaveLength(0)
    }
  })

  it('maps every domain error without exposing values or internals', async () => {
    for (const [code, status] of ERROR_STATUSES) {
      const fixture = makeApp({ listError: new ElearningAssignmentLifecycleError(code) })
      const response = await request(pinned.url())
        .get(`/api/elearning/assignments/${ASSIGNMENT}`)
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code })
      expect(fixture.listCalls).toHaveLength(1)
    }
    const boom = makeApp({ listError: new Error('secret host stack') })
    const response = await request(pinned.url())
      .get(`/api/elearning/assignments/${ASSIGNMENT}`)
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(response.body)).not.toMatch(/secret|host|stack/)
  })
})

describe('PUT /api/elearning/assignments/:assignmentId/members/:memberId/revocation', () => {
  it('accepts a strict reason, injects actor/org, and returns only the closed revoke DTO', async () => {
    const fixture = makeApp()
    const response = await request(pinned.url())
      .put(`/api/elearning/assignments/${ASSIGNMENT}/members/${MEMBER}/revocation?orgId=evil&actorId=evil`)
      .set('x-tenant-id', 'evil-header-org')
      .send({ reason: 'left the team' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual(REVOKE_RESULT)
    expect(Object.keys(response.body)).toEqual([
      'assignmentId',
      'memberId',
      'revoked',
      'duplicate',
    ])
    expect(fixture.revokeCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER,
      reason: 'left the team',
    }])
    expect(fixture.order).toEqual([
      'identity',
      'org',
      'rbac',
      'identity',
      'org',
      'service',
    ])
    expect(JSON.stringify(response.body)).not.toMatch(/reason|score|answer|storage/i)
  })

  it('fails closed before parse/service when flags, identity, org, or admin RBAC deny', async () => {
    const huge = { reason: 'x'.repeat(20 * 1024) }
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
        .put(`/api/elearning/assignments/${ASSIGNMENT}/members/${MEMBER}/revocation`)
        .send(huge)
      expect(response.status).toBe(expected.status)
      expect(response.body).toEqual(expected.body)
      expect(expected.fixture.order).toEqual(expected.order)
      expect(expected.fixture.revokeCalls).toHaveLength(0)
    }

    const learner = makeApp({ allowAdmin: false, allowRead: true, viewer: LEARNER })
    const denied = await request(pinned.url())
      .put(`/api/elearning/assignments/${ASSIGNMENT}/members/${MEMBER}/revocation`)
      .send({ reason: 'left the team' })
    expect(denied.status).toBe(403)
    expect(learner.revokeCalls).toHaveLength(0)
  })

  it('rejects unknown keys, missing reason, and non-string reason without writing', async () => {
    for (const body of [
      {},
      { reason: 1 },
      { reason: 'ok', extra: true },
      { reason: 'ok', orgId: 'evil' },
      { reason: 'ok', actorId: 'evil' },
      null,
      [{ reason: 'ok' }],
    ]) {
      const fixture = makeApp()
      const response = await request(pinned.url())
        .put(`/api/elearning/assignments/${ASSIGNMENT}/members/${MEMBER}/revocation`)
        .send(body)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid_input' })
      expect(fixture.revokeCalls).toHaveLength(0)
    }

    const badIds = makeApp()
    const badAssignment = await request(pinned.url())
      .put(`/api/elearning/assignments/not-a-uuid/members/${MEMBER}/revocation`)
      .send({ reason: 'left the team' })
    expect(badAssignment.status).toBe(400)
    const badMember = await request(pinned.url())
      .put(`/api/elearning/assignments/${ASSIGNMENT}/members/not-a-uuid/revocation`)
      .send({ reason: 'left the team' })
    expect(badMember.status).toBe(400)
    expect(badIds.revokeCalls).toHaveLength(0)
  })

  it('maps every domain error without exposing values or internals', async () => {
    for (const [code, status] of ERROR_STATUSES) {
      const fixture = makeApp({ revokeError: new ElearningAssignmentLifecycleError(code) })
      const response = await request(pinned.url())
        .put(`/api/elearning/assignments/${ASSIGNMENT}/members/${MEMBER}/revocation`)
        .send({ reason: 'left the team' })
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code })
      expect(fixture.revokeCalls).toHaveLength(1)
    }
    const boom = makeApp({ revokeError: new Error('secret host stack') })
    const response = await request(pinned.url())
      .put(`/api/elearning/assignments/${ASSIGNMENT}/members/${MEMBER}/revocation`)
      .send({ reason: 'left the team' })
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(response.body)).not.toMatch(/secret|host|stack/)
  })
})
