import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import type { AssignElearningBatchInput } from '../../src/services/elearning-batch-assignment'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-batch-runtime'
const ACTOR = 'actor-batch-runtime'
const VERSION = '11111111-1111-4111-8111-111111111111'
const ASSIGNMENT = '22222222-2222-4222-8222-222222222222'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
} as unknown as NodeJS.ProcessEnv

const pinned = usePinnedServer()

describe('batch assignment production runtime wiring', () => {
  it('mounts JWT before the inner route and forwards the injected batch service', async () => {
    const calls: AssignElearningBatchInput[] = []
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async <T>(handler: (tx: { query: typeof db.query }) => Promise<T>) =>
        handler({ query: db.query }),
    }
    const runtime = createElearningPilotRuntime({
      db,
      env: FLAG_ON,
      authenticate: (req, _res, next) => {
        req.user = { id: ACTOR } as never
        req.authenticatedTenantId = ORG
        next()
      },
      adminGuard: (_req, _res, next) => next(),
      readGuard: (_req, _res, next) => next(),
      assignElearningBatch: async (_db, input) => {
        calls.push(input)
        return { assignmentId: ASSIGNMENT, memberCount: 1, duplicate: false }
      },
    })
    expect(runtime).not.toBeNull()
    const app = express()
    app.use(runtime!.router)
    pinned.setApp(app)

    const response = await request(pinned.url())
      .post('/api/elearning/assignments/batch?orgId=evil&actorId=evil')
      .set('x-tenant-id', 'evil-header')
      .send({
        courseVersionId: VERSION,
        sourceKey: 'batch-runtime-source',
        rules: [{ subjectType: 'all' }],
      })
    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      assignmentId: ASSIGNMENT,
      memberCount: 1,
      duplicate: false,
    })
    expect(calls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      courseVersionId: VERSION,
      sourceKey: 'batch-runtime-source',
      deadline: undefined,
      rules: [{ subjectType: 'all' }],
    }])
  })
})
